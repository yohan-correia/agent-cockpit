#!/usr/bin/env node
'use strict';
// GATE — todo `send-keys` de lib/abas.js mira a PANE, nunca a janela.
//
// O bug que motivou isto (28/08): a janela do Projeto-a tinha DUAS panes — o claude numa,
// um `codex --yolo` na outra. `send-keys -t @5` entrega na pane ATIVA da janela, então as
// mensagens que o usuário mandava pelo cockpit iam todas para o Codex. A tela do Codex
// respondendo "Recebido. Estou funcionando." foi a prova.
//
// `capture-pane` e as teclas do menu já usavam `aba.pane || aba.alvo`; só o `enviar()` e o
// `interromper()` tinham ficado na janela. Este gate impede a inconsistência de voltar.
//
// A asserção é no FONTE de propósito: o alvo do tmux é escolhido numa linha de argumentos,
// não num valor que dê para observar sem um tmux de verdade — e este módulo fala com o
// socket PADRÃO, o do usuário, onde nenhum teste tem o que fazer.

const fs = require('node:fs');
const path = require('node:path');

const ARQUIVO = path.join(__dirname, '..', 'lib', 'abas.js');
const fonte = fs.readFileSync(ARQUIVO, 'utf8');

// Toda chamada de `send-keys`, com o argumento que vem logo depois do `-t`.
const CHAMADAS = /\[\s*'send-keys'\s*,\s*'-t'\s*,\s*([^,\]]+)/g;

let achadas = 0;
const erradas = [];
for (const m of fonte.matchAll(CHAMADAS)) {
  achadas += 1;
  const alvo = m[1].trim();
  // O alvo válido é o que prefere a pane. `aba.alvo` sozinho (ou `depois.alvo`) é o bug.
  // Comandos que já exigem pane identificada usam a pane diretamente, sem fallback.
  if (!/\.pane(?:\s*\|\||$)/.test(alvo)) erradas.push(alvo);
}

const linhas = [];
if (achadas === 0) linhas.push('nenhum send-keys encontrado — o regex do gate ficou para trás do código');
for (const alvo of erradas) linhas.push(`send-keys mira a janela e não a pane: -t ${alvo}`);

if (linhas.length) {
  console.error('✘ gate-envio-na-pane');
  for (const l of linhas) console.error(`   · ${l}`);
  process.exit(1);
}

console.log(`✔ gate-envio-na-pane — ${achadas} send-keys, todos na pane`);
