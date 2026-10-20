#!/usr/bin/env node
'use strict';
// `gh` falso pra testar `lib/github.js` sem falar com o GitHub de verdade (card
// `ver-a-diff-do-codigo`, D97). O ambiente do `gh` é lista FECHADA (spec) — este arquivo não pode
// depender de env. Quem usa: copia este arquivo para `<tmp>/bin/gh` (fs.copyFileSync + chmod
// 0o755) e escreve `<tmp>/bin/gh-falso.json` ao lado; aponta `COCKPIT_GH_BIN=<tmp>/bin/gh`.
//
// Config (`gh-falso.json`, lida do mesmo diretório deste arquivo):
//   { "modo": "ok"|"falha"|"lento"|"json-ruim"|"vazio",
//     "lista": [...itens no formato do `gh search`...],
//     "prs": { "<owner/repo>#<n>": { "view": {...}, "diff": "<texto do patch>" | null } },
//     "registro": "<arquivo>",
//     "diffModo": "ok"|"falha"|"grande" }

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(path.dirname(process.argv[1]), 'gh-falso.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function registrar() {
  if (!config.registro) return;
  const linha = JSON.stringify({ argv: process.argv.slice(2), envChaves: Object.keys(process.env).sort() });
  fs.appendFileSync(config.registro, `${linha}\n`);
}

function escreverTokenFalso() {
  process.stderr.write('aviso do falso: token gho_FALSO_NAO_PODE_VAZAR\n');
}

function patchGrande() {
  const partes = [];
  let bytes = 0;
  let i = 0;
  while (bytes < 2_000_000) {
    const trecho = [
      `diff --git a/g${i}.txt b/g${i}.txt`,
      `--- a/g${i}.txt`,
      `+++ b/g${i}.txt`,
      '@@ -1,20 +1,20 @@',
      ...Array.from({ length: 20 }, (_, n) => `-linha velha ${n} do g${i}`),
      ...Array.from({ length: 20 }, (_, n) => `+linha nova ${n} do g${i}`),
      '',
    ].join('\n');
    partes.push(trecho);
    bytes += trecho.length;
    i += 1;
  }
  return partes.join('\n');
}

function main() {
  escreverTokenFalso();
  registrar();

  const args = process.argv.slice(2);

  if (config.modo === 'falha') process.exit(1);
  if (config.modo === 'lento') { setTimeout(() => {}, 60000); return; }

  // `write(texto, () => process.exit(0))`: com saída grande (pipe), `exit(0)` logo depois do
  // `write` trunca — o SO só termina de esvaziar o buffer depois (medido: 2 MB cai pra 64 KB).
  const sair = (texto) => process.stdout.write(texto, () => process.exit(0));

  if (args[0] === 'search' && args[1] === 'prs') {
    if (config.modo === 'json-ruim') { sair('{['); return; }
    if (config.modo === 'vazio') { sair('[]'); return; }
    const lista = (config.lista || []).map((item) => ({ ...item, token: 'gho_FALSO_NAO_PODE_VAZAR' }));
    sair(JSON.stringify(lista));
    return;
  }

  if (args[0] === 'pr' && args[1] === 'view') {
    const numero = args[2];
    const iR = args.indexOf('-R');
    const repo = iR >= 0 ? args[iR + 1] : null;
    const chave = `${repo}#${numero}`;
    const entrada = config.prs && config.prs[chave];
    if (!entrada || !entrada.view) process.exit(1);
    sair(JSON.stringify(entrada.view));
    return;
  }

  if (args[0] === 'pr' && args[1] === 'diff') {
    const numero = args[2];
    const iR = args.indexOf('-R');
    const repo = iR >= 0 ? args[iR + 1] : null;
    const chave = `${repo}#${numero}`;
    if (config.diffModo === 'falha') process.exit(1);
    if (config.diffModo === 'grande') { sair(patchGrande()); return; }
    const entrada = config.prs && config.prs[chave];
    const diffTexto = entrada ? entrada.diff : null;
    if (diffTexto == null) process.exit(1);
    sair(diffTexto);
    return;
  }

  process.exit(2);
}

main();
