#!/usr/bin/env node
'use strict';
// PROVA DE CORPUS do card `fila-presa-com-barra-invertida-no-fim` — a tolerância à "\" final só
// ACRESCENTA casamento, e só quando o enviado termina em "\".
//
// Lê os textos humanos REAIS de ~/.claude/projects pelo mesmo leitor do cockpit
// (`externo.eventosDoObjeto`) e compara a regra de ANTES (cópia congelada abaixo) com
// `casaComEnviado` de `lib/abas.js`. Read-only; não roda no `npm test` (depende do HOME real).
//
// Reprova (exit 1) se:
//   A. algum par com enviado SEM "\" final mudou de grau;
//   B. algum par que casava deixou de casar ou piorou de grau (a regra tem que ser superconjunto);
//   C. a variante que a TUI produz (disco + " \" e disco + "\") não casa no grau 2.
// Imprime também quantos falsos positivos NOVOS a tolerância cria (disco ≠ enviado sem a "\")
// ao lado de quantos o grau 3 já criava antes — é o custo, para quem lê decidir.
//
// Uso: node testes/prova-barra-final-corpus.js [tamanho-da-amostra=900]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const externo = require('../lib/externo');
const { casaComEnviado } = require('../lib/abas');

function formaDeCasar(texto) {
  return String(texto || '').split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n').trim();
}
// A regra até 13/10/2026 (develop 4fea973), congelada.
function antes(doDisco, enviado) {
  const cru = String(doDisco || '').trim();
  const alvo = String(enviado || '').trim();
  if (!cru || !alvo) return 0;
  if (cru === alvo) return 1;
  const a = formaDeCasar(cru);
  const b = formaDeCasar(alvo);
  if (!a || !b) return 0;
  if (a === b || a.replace(/^! +/, '!') === b.replace(/^! +/, '!')) return 2;
  return a.endsWith(b) ? 3 : 0;
}

const raiz = path.join(os.homedir(), '.claude', 'projects');
const textos = [];
for (const pasta of fs.readdirSync(raiz)) {
  let arqs = [];
  try { arqs = fs.readdirSync(path.join(raiz, pasta)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
  for (const f of arqs) {
    let cru;
    try { cru = fs.readFileSync(path.join(raiz, pasta, f), 'utf8'); } catch { continue; }
    for (const l of cru.split('\n')) {
      if (!l.includes('"type":"user"')) continue;
      let j;
      try { j = JSON.parse(l); } catch { continue; }
      for (const e of externo.eventosDoObjeto(j)) if (e.tipo === 'humano' && e.texto) textos.push(e.texto.trim());
    }
  }
}
const unicos = [...new Set(textos)];
const comBarra = unicos.filter((t) => t.endsWith('\\'));
console.log(`textos humanos: ${textos.length} (${unicos.length} únicos) · terminam em "\\" no disco: ${comBarra.length}`);

const amostra = unicos.slice(0, Number(process.argv[2]) || 900);
const enviados = [...amostra, ...amostra.map((t) => `${t} \\`), ...amostra.map((t) => `${t}\\`)];
let pares = 0;
let mudouSemBarra = 0;
let piorou = 0;
let tuiFalhou = 0;
let novosFalsos = 0;
let falsosDeAntes = 0;
const exemplos = [];
for (const d of amostra) {
  for (const e of enviados) {
    pares += 1;
    const v = antes(d, e);
    const n = casaComEnviado(d, e);
    if (!e.endsWith('\\') && v !== n) { mudouSemBarra += 1; if (exemplos.length < 3) exemplos.push(['A', d, e, v, n]); }
    if (v > 0 && (n === 0 || n > v)) { piorou += 1; if (exemplos.length < 3) exemplos.push(['B', d, e, v, n]); }
    const semBarra = e.replace(/\\$/, '').trim();
    if (e.endsWith('\\') && semBarra === d && n !== 2) { tuiFalhou += 1; if (exemplos.length < 3) exemplos.push(['C', d, e, v, n]); }
    if (e.endsWith('\\') && semBarra !== d && v === 0 && n > 0) novosFalsos += 1;
    if (!e.endsWith('\\') && e !== d && v > 0) falsosDeAntes += 1;
  }
}
console.log(`pares: ${pares}`);
console.log(`  A. mudou com enviado sem "\\" final: ${mudouSemBarra}`);
console.log(`  B. casava e deixou de casar / piorou: ${piorou}`);
console.log(`  C. variante da TUI fora do grau 2: ${tuiFalhou}`);
console.log(`  custo: casamentos NOVOS entre textos diferentes: ${novosFalsos} (o grau 3 já casava ${falsosDeAntes} pares diferentes sem "\\")`);
if (exemplos.length) console.log('  exemplos:', JSON.stringify(exemplos).slice(0, 600));
const verde = mudouSemBarra === 0 && piorou === 0 && tuiFalhou === 0;
console.log(verde ? 'PROVA VERDE' : 'PROVA VERMELHA');
process.exit(verde ? 0 : 1);
