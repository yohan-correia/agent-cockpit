#!/usr/bin/env node
'use strict';
// GATE da regra da casa (D96): toda tela do cockpit abre DENTRO do app — mesma janela, mesmo PWA.
// Aba nova (`window.open`, `target="_blank"`, `.open(` em `window`/`globalThis`, `clients.openWindow`)
// só para link EXTERNO de verdade, numa lista FECHADA (`PERMITIDOS`). Node puro, sem servidor, sem
// porta — varre o texto de `public/**/*.js` e `public/**/*.html` (fora `public/grafo/ua/`, bundle de
// terceiro).
//
//   node testes/gate-dentro-do-app.js

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let passou = 0;
let total = 0;
let vermelho = false;
function ok(cond, msg) {
  total += 1;
  if (cond) { passou += 1; console.log(`  ✅ ${msg}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${msg}`);
  return false;
}

/** Linha de comentário (`//`, `*` de JSDoc, `/*` de abertura, `<!--` de HTML) — pelo `trim()`. */
function ehComentario(linha) {
  const t = linha.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--');
}

// `target`: só a PROPRIEDADE de um elemento (`a.target = …`) e o ATRIBUTO com valor (`target="…"`). Um
// `\btarget\s*=` solto pegaria `const target = …` e `data-target="…"` e acusaria a regra D96 pelo motivo
// errado (painel de execução, Claude #3) — o controle de falso positivo abaixo prova que não pega.
const REGEXES = [/\bwindow\.open\s*\(/, /\bglobalThis\.open\s*\(/, /['"]_blank['"]/, /\.target\s*=(?!=)/, /(?<![\w.-])target\s*=\s*["']/, /\bopenWindow\s*\(/];

/** Lista `.js`/`.html` sob `dir`, recursiva, fora de `public/grafo/ua/` (bundle de terceiro). */
function listarArquivos(dir) {
  const achados = [];
  (function varrerDir(atual) {
    for (const ent of fs.readdirSync(atual, { withFileTypes: true })) {
      const caminho = path.join(atual, ent.name);
      if (ent.isDirectory()) {
        if (path.relative(dir, caminho) === path.join('grafo', 'ua')) continue;
        varrerDir(caminho);
      } else if (/\.(js|html)$/.test(ent.name)) {
        achados.push(caminho);
      }
    }
  })(dir);
  return achados;
}

/**
 * Varre `raiz` (uma árvore `public/`) atrás de `window.open(`/`globalThis.open(`/`'_blank'`/`target=`/
 * `openWindow(`, por linha, ignorando comentário. Uma ocorrência por LINHA (uma linha que casa mais de
 * um regex conta uma vez só). Devolve `[{ arquivo (relativo a `raiz`), linha (nº, 1-based), texto }]`.
 */
function varrer(raiz) {
  const achados = [];
  for (const caminho of listarArquivos(raiz)) {
    const linhas = fs.readFileSync(caminho, 'utf8').split('\n');
    const arquivo = path.relative(raiz, caminho).split(path.sep).join('/');
    linhas.forEach((texto, i) => {
      if (ehComentario(texto)) return;
      if (REGEXES.some((r) => r.test(texto))) achados.push({ arquivo, linha: i + 1, texto: texto.trim() });
    });
  }
  return achados;
}

// Lista FECHADA: cada ocorrência de verdade em `public/` tem de estar aqui, com o motivo escrito.
// Item que sumir do código (código mudou, a lista não acompanhou) também é ❌ — ela não pode apodrecer.
const PERMITIDOS = [
  { arquivo: 'app.js', trecho: "no.target = '_blank';", motivo: 'criarLink: só https?:/mailto: (o regex de cima recusa o resto) — link EXTERNO da conversa' },
  { arquivo: 'sw.js', trecho: 'self.clients.openWindow(destino)', motivo: 'nenhuma janela do app aberta: abrir o PRÓPRIO app (destino é ./ ou ./#c=)' },
  { arquivo: 'diff.js', trecho: "link.href = pr.url; link.target = '_blank'; link.rel = 'noopener noreferrer';", motivo: 'D97: "Abrir no GitHub" — link EXTERNO de verdade (github.com/<repo>/pull/<n>, montado no servidor a partir do par da allowlist)' },
];

function principal() {
  const achados = varrer(PUBLIC_DIR);

  for (const achado of achados) {
    const casa = PERMITIDOS.some((p) => p.arquivo === achado.arquivo && achado.texto.includes(p.trecho));
    ok(casa, `public/${achado.arquivo}:${achado.linha} — ${achado.texto} (regra D96: tela do cockpit abre DENTRO do app; link externo de verdade entra em PERMITIDOS com o motivo)`);
  }
  for (const permitido of PERMITIDOS) {
    const sobrevive = achados.some((a) => a.arquivo === permitido.arquivo && a.texto.includes(permitido.trecho));
    ok(sobrevive, `item da lista que sumiu do código: ${permitido.arquivo} — ${permitido.trecho}`);
  }

  // `public/dentro-do-app.js` é a porta única de saída (M2) — nunca escreve HTML por string.
  const fonteDentroDoApp = fs.readFileSync(path.join(PUBLIC_DIR, 'dentro-do-app.js'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const proibido of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    ok(!fonteDentroDoApp.includes(proibido), `public/dentro-do-app.js sem ${proibido}`);
  }

  // Controle positivo (R8): a varredura ENXERGA código de verdade e IGNORA comentário.
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gate-dentro-do-app-'));
  try {
    fs.writeFileSync(path.join(tmp, 'x.js'), "window.open('diff/', '_blank');\n");
    fs.writeFileSync(path.join(tmp, 'y.html'), '<a target="_blank" href="mapa/x/">\n');
    fs.writeFileSync(path.join(tmp, 'z.js'), '// window.open(\n');
    fs.writeFileSync(path.join(tmp, 'w.js'), 'const target = 1;\nif (ev.target === botao) fechar();\n');
    fs.writeFileSync(path.join(tmp, 'w.html'), '<div data-target="x"></div>\n');
    const achadosTmp = varrer(tmp);
    ok(achadosTmp.length === 2, `controle positivo: 2 ocorrências (1 por arquivo de verdade) — achei ${achadosTmp.length}`);
    ok(achadosTmp.some((a) => a.arquivo === 'x.js'), 'controle positivo: achou a de x.js');
    ok(achadosTmp.some((a) => a.arquivo === 'y.html'), 'controle positivo: achou a de y.html');
    ok(!achadosTmp.some((a) => a.arquivo === 'z.js'), 'controle positivo: NÃO contou o comentário de z.js');
    ok(!achadosTmp.some((a) => a.arquivo === 'w.js' || a.arquivo === 'w.html'),
      'controle de falso positivo: `const target =`, `ev.target === x` e `data-target="…"` NÃO contam');
    ok(!achadosTmp.some((a) => PERMITIDOS.some((p) => p.arquivo === a.arquivo && a.texto.includes(p.trecho))),
      'controle positivo: nenhuma das 2 casa a lista PERMITIDOS (são de um projeto de mentira)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passou}/${total} asserções`);
  console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — a regra da casa: tudo dentro do app (D96)');
  process.exitCode = vermelho ? 1 : 0;
}

principal();
