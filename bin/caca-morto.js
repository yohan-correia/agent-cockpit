#!/usr/bin/env node
'use strict';
// Caça código morto — só LÊ, nunca escreve. Uso: node bin/caca-morto.js [--json] [raiz]
//
// Quatro buscas sobre os arquivos versionados (git ls-files):
//   1. função de topo declarada e nunca citada de novo — nem no arquivo, nem na produção;
//   2. export de lib/ que ninguém usa, nem por dentro do próprio arquivo;
//   3. export de lib/ que só teste usa e que o arquivo não usa por dentro (nome com `_` na
//      frente é gancho de teste de propósito e fica fora);
//   4. arquivo de lib/, public/, bin/ ou scripts/ que nenhum arquivo de produção cita.
//
// É heurística por TEXTO, e erra pro lado do "vivo": acesso por propriedade (`leitor.x`, o
// despacho dinâmico de lib/agentes.js) conta como uso em qualquer arquivo de produção. Nome
// montado em string escapa. Todo achado é CANDIDATO — conferir à mão antes de remover; o item 4
// pega também entrada que roda à mão ou por systemd.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const comoJson = args.includes('--json');
const RAIZ = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..'));

const arquivos = execFileSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf8' }).split('\n').filter(Boolean);
const VENDOR = /^public\/grafo\/ua\//;
const ehCodigo = (f) => /\.(js|mjs|cjs|html|py|sh|json|webmanifest)$/.test(f) && !VENDOR.test(f);
const ehTeste = (f) => f.startsWith('testes/');
const ehDoc = (f) => /\.md$/.test(f) || f.startsWith('docs/');
const ehProd = (f) => ehCodigo(f) && !ehTeste(f) && !ehDoc(f);

const texto = new Map();
for (const f of arquivos) {
  if (!ehCodigo(f) && !ehDoc(f)) continue;
  try { texto.set(f, fs.readFileSync(path.join(RAIZ, f), 'utf8')); } catch { /* apagado na árvore, symlink quebrado */ }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const contaPalavra = (t, nome) => (t.match(new RegExp(`(?<![\\w$])${esc(nome)}(?![\\w$])`, 'g')) || []).length;
// Nome citado só em comentário não é uso. O bloco vira só as quebras de linha: o número da linha
// do achado continua batendo com o arquivo.
const semComentario = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const codigo = new Map([...texto].filter(([f]) => !ehDoc(f)).map(([f, t]) => [f, semComentario(t)]));

const achados = { funcoesMortas: [], exportsNinguem: [], exportsSoTeste: [], arquivosSemReferencia: [] };
let exportsSoInternos = 0;
let exportsDeTeste = 0;

// ─── 1. função de topo citada uma vez só ────────────────────────────────────────────────────────
const DECL = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm;
for (const f of arquivos.filter((x) => /\.(js|mjs)$/.test(x) && ehProd(x))) {
  const t = codigo.get(f); if (!t) continue;
  for (const m of t.matchAll(DECL)) {
    const nome = m[1] || m[2];
    if (contaPalavra(t, nome) > 1) continue;
    // Script de public/ é global no navegador: outro script ou o HTML pode chamar.
    const fora = [...codigo].filter(([g, tg]) => g !== f && contaPalavra(tg, nome) > 0).map(([g]) => g);
    if (fora.some(ehProd)) continue;
    achados.funcoesMortas.push({ onde: `${f}:${t.slice(0, m.index).split('\n').length}`, nome });
  }
}

// ─── 2 e 3. exports de lib/ ─────────────────────────────────────────────────────────────────────
function chavesDoExport(t) {
  const m = t.match(/^module\.exports\s*=\s*\{([\s\S]*?)^\};?/m);
  if (!m) return [];
  let prof = 0; let atual = ''; const partes = [];
  for (const c of m[1]) {
    if ('({['.includes(c)) prof += 1;
    if (')}]'.includes(c)) prof -= 1;
    if (c === ',' && prof === 0) { partes.push(atual); atual = ''; } else atual += c;
  }
  partes.push(atual);
  return partes.map((p) => p.trim()).map((p) => (p.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)/) || [])[1]).filter(Boolean);
}
for (const f of arquivos.filter((x) => /^lib\/.*\.js$/.test(x))) {
  const t = codigo.get(f); if (!t) continue;
  const mod = path.basename(f, '.js');
  const quemImporta = [...codigo].filter(([g, tg]) => g !== f && new RegExp(`require\\(['"\`][^'"\`]*\\b${esc(mod)}(\\.js)?['"\`]\\)`).test(tg));
  for (const nome of chavesDoExport(t)) {
    if (quemImporta.some(([g, tg]) => ehProd(g) && contaPalavra(tg, nome) > 0)) continue;
    if ([...codigo].some(([g, tg]) => g !== f && ehProd(g) && new RegExp(`\\.${esc(nome)}(?![\\w$])`).test(tg))) continue;
    const testes = quemImporta.filter(([g, tg]) => ehTeste(g) && contaPalavra(tg, nome) > 0).length;
    // Declaração + chave do export = 2 citações; mais que isso = o próprio arquivo usa.
    if (contaPalavra(t, nome) > 2) { if (testes) exportsDeTeste += 1; else exportsSoInternos += 1; continue; }
    if (!testes) achados.exportsNinguem.push({ onde: f, nome });
    else if (!nome.startsWith('_')) achados.exportsSoTeste.push({ onde: f, nome, testes });
  }
}

// ─── 4. arquivo que nenhum arquivo de produção cita ─────────────────────────────────────────────
for (const f of arquivos) {
  if (!/^(lib|public|bin|scripts)\//.test(f) || VENDOR.test(f) || !/\.(js|mjs|css|html|py|sh)$/.test(f)) continue;
  const base = path.basename(f);
  const semExt = base.replace(/\.[^.]+$/, '');
  const citaEsse = (t) => t.includes(base) || new RegExp(`['"\`][^'"\`]*\\b${esc(semExt)}['"\`]`).test(t);
  if ([...texto].some(([g, t]) => g !== f && ehProd(g) && citaEsse(t))) continue;
  achados.arquivosSemReferencia.push({ onde: f });
}

if (comoJson) {
  console.log(JSON.stringify({ ...achados, exportsSoInternos, exportsDeTeste }, null, 1));
  process.exit(0);
}
const secao = (titulo, lista, linha) => {
  console.log(`\n${titulo} (${lista.length})`);
  for (const item of lista) console.log(`  ${linha(item)}`);
};
secao('Função de topo que ninguém chama', achados.funcoesMortas, (i) => `${i.onde}  ${i.nome}`);
secao('Export que ninguém usa, nem por dentro', achados.exportsNinguem, (i) => `${i.onde}  ${i.nome}`);
secao('Export que só teste usa (conferir)', achados.exportsSoTeste, (i) => `${i.onde}  ${i.nome}  (${i.testes} teste${i.testes > 1 ? 's' : ''})`);
secao('Arquivo que a produção não cita (conferir: pode ser entrada manual ou systemd)', achados.arquivosSemReferencia, (i) => i.onde);
console.log(`\nFora da lista: ${exportsSoInternos} export(s) que só o próprio arquivo usa e ${exportsDeTeste} usado(s) por dentro e por teste — vivos.`);
