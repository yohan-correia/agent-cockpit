#!/usr/bin/env node
'use strict';
// Prova INDEPENDENTE do grafo (plano §3.2, Fase 3) — sem usar o resolvedor de `lib/grafo-extrator.js`:
// acha todo `require('./…')`/`from './…'`/`import('./…')` por `git grep` direto na árvore da develop
// e confere, pra cada um, se existe a aresta `imports` correspondente no grafo. Sem nome de projeto
// no código (só em `docs/`/relatório — este arquivo recebe o caminho do repo por argumento).
//
//   node testes/prova-grafo-requires.js <repo> <grafo.json>
//
// Sai rc 1 se sobrar algum par válido não coberto.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [repo, grafoPath] = process.argv.slice(2);
if (!repo || !grafoPath) {
  console.error('uso: node testes/prova-grafo-requires.js <repo> <grafo.json>');
  process.exit(2);
}

const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'develop'], { encoding: 'utf8' }).trim();
const grafo = JSON.parse(fs.readFileSync(grafoPath, 'utf8'));
const arquivosDoGrafo = new Set(grafo.nodes.filter((n) => n.type === 'file').map((n) => n.filePath));
const arestasImports = new Set(grafo.edges.filter((e) => e.type === 'imports').map((e) => `${e.source}|${e.target}`));

const arvoreTodas = new Set(
  execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', sha], { encoding: 'utf8' }).split('\n').filter(Boolean),
);

let saidaGrep = '';
try {
  saidaGrep = execFileSync('git', [
    '-C', repo, 'grep', '-n', '-E',
    "require\\(['\"]\\.|from ['\"]\\.|import\\(['\"]\\.",
    sha, '--', '*.js', '*.mjs', '*.cjs',
  ], { encoding: 'utf8' });
} catch (e) {
  // git grep sai com rc 1 quando não acha nada — não é erro aqui.
  saidaGrep = (e && e.stdout) || '';
}

const RE_LINHA = /^[0-9a-f]+:([^:]+):(\d+):(.*)$/;
const RE_ESPECIFICADOR = /(?:require\(|from |import\()(['"])(\.[^'"]*)\1/;

const foraDoUniverso = [];
const alvoNaoExiste = [];
const emComentario = [];
const naoCobertos = [];
let validos = 0;
let cobertos = 0;

for (const linha of saidaGrep.split('\n')) {
  if (!linha) continue;
  const m = RE_LINHA.exec(linha);
  if (!m) continue;
  const [, arquivo, numero, conteudo] = m;

  const matchEsp = RE_ESPECIFICADOR.exec(conteudo);
  if (!matchEsp) continue;
  const especificador = matchEsp[2];

  if (/^\s*(\/\/|\*)/.test(conteudo)) {
    emComentario.push(`${arquivo}:${numero}: ${conteudo.trim()}`);
    continue;
  }
  if (!arquivosDoGrafo.has(arquivo)) {
    foraDoUniverso.push(`${arquivo}:${numero} — não é nó file do grafo (filtro: >512 KB, extensão, etc.)`);
    continue;
  }

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(arquivo), especificador));
  const candidatos = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, `${base}/index.js`];
  const alvo = candidatos.find((c) => arvoreTodas.has(c));
  if (!alvo) {
    alvoNaoExiste.push(`${arquivo}:${numero}: "${especificador}" — texto de exemplo em string/comentário?`);
    continue;
  }
  if (alvo.endsWith('.json')) continue; // não é código

  validos += 1;
  if (arestasImports.has(`file:${arquivo}|file:${alvo}`)) {
    cobertos += 1;
  } else {
    naoCobertos.push(`${arquivo}:${numero}: "${especificador}" -> ${alvo} (sem aresta imports no grafo)`);
  }
}

console.log(`fora do universo (${foraDoUniverso.length}):`);
for (const l of foraDoUniverso) console.log(`  ${l}`);
console.log(`\nalvo não existe na árvore (${alvoNaoExiste.length}):`);
for (const l of alvoNaoExiste) console.log(`  ${l}`);
console.log(`\nem comentário (${emComentario.length}):`);
for (const l of emComentario) console.log(`  ${l}`);
console.log(`\nnão cobertos (${naoCobertos.length}):`);
for (const l of naoCobertos) console.log(`  ${l}`);
console.log(`\n${validos} pares válidos · ${cobertos} cobertos`);
process.exitCode = naoCobertos.length > 0 ? 1 : 0;
