#!/usr/bin/env node
'use strict';
// Card responder-a-pergunta-pelo-teclado, §4.1/§4.3 da spec e Fase 5 do plano.
//
// Este gate NÃO classifica tela ("é menu?", "é livre?") — a D-D recusou construir essa
// régua para o Claude (§4.2/§4.3 da spec): dois caracteres diferentes, três recuos
// diferentes e, no fim, o mesmo caractere marcando o composer E a opção selecionada nas
// DUAS CLIs — a mesma ambiguidade que já derrubou cinco réguas no fa67. O que este gate
// afirma é o CATÁLOGO que sustenta essa decisão (§4.1): sem ele rodando, a medição vira
// folclore no dia em que o Claude Code mudar o formato do prompt.
//
// Como as fixtures foram capturadas (e como refazer, se um dia precisar): socket tmux
// PRÓPRIO (nunca o socket default do sistema), num cwd TEMPORÁRIO só para a captura — o
// próprio texto das fixtures carrega o rastro (`/tmp/medicao-menu-claude-7ycW`) — com o
// Claude Code 2.1.258 rodando dentro. `tmux capture-pane -p` para o `.txt` puro (o que a
// régua veria) e `tmux capture-pane -p -e` para o `.ansi.txt` irmão (o que sobra depois da
// limpeza de escape — prova que ela roda ANTES de qualquer leitura). Zero token: as quatro
// telas (prompt de confiança parado, prompt de confiança com Down, composer livre, `/model`
// aberto) não pedem rede nenhuma.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'fixtures', 'menu-claude');
const linhas = (nome) => fs.readFileSync(path.join(DIR, nome), 'utf8').split('\n');

const MARCA_CLAUDE = '❯'; // U+276F
const MARCA_CODEX = '›';  // U+203A

// ── O prompt de confiança: a MESMA marca, e ela ANDA (é só deste par que sai a prova de
//    movimento — nenhuma outra fixture prova isso) ──────────────────────────────────────
{
  const parado = linhas('2.1.258-00-inicial.txt');
  const linhaSelecionada = parado.findIndex((l) => l.includes(`${MARCA_CLAUDE} No, exit`));
  const linhaNaoSelecionada = parado.findIndex((l) => l.includes('Yes, I trust this folder'));
  assert.ok(linhaSelecionada >= 0, 'catálogo: "No, exit" marcada com ❯ em 2.1.258-00-inicial.txt');
  assert.ok(linhaNaoSelecionada >= 0, 'catálogo: "Yes, I trust this folder" existe em 2.1.258-00-inicial.txt');
  assert.ok(!parado[linhaNaoSelecionada].includes(MARCA_CLAUDE),
    'a linha NÃO selecionada tem só espaços, sem ❯');
  assert.equal(parado[linhaSelecionada].indexOf(MARCA_CLAUDE), 1,
    'recuo do ❯ no prompt de confiança: 1 coluna (␣❯␣No, exit)');

  const depoisDoDown = linhas('2.1.258-01-confianca-down.txt');
  assert.ok(!depoisDoDown[linhaSelecionada].includes(MARCA_CLAUDE),
    'depois do Down, a linha que TINHA o ❯ perde a marca');
  assert.ok(depoisDoDown[linhaNaoSelecionada].includes(`${MARCA_CLAUDE} Yes, I trust this folder`),
    'e a OUTRA linha ganha o ❯ — é a prova de que a seta anda, não é decoração fixa');
}

// ── O menu /model: o ❯ recuado em 2 colunas, as não-selecionadas em 4 (prova de RECUO,
//    não de movimento — não confundir com o par acima) ─────────────────────────────────
{
  const tela = linhas('2.1.258-03-menu-model.txt');
  const selecionada = tela.find((l) => /^\s*❯\s*\d+\./.test(l));
  const naoSelecionadas = tela.filter((l) => /^\s*\d+\./.test(l) && !l.includes(MARCA_CLAUDE));
  assert.ok(selecionada, 'catálogo: há uma linha de item marcada com ❯ em 2.1.258-03-menu-model.txt');
  assert.ok(naoSelecionadas.length >= 3, `catálogo: pelo menos 3 itens não marcados (achei ${naoSelecionadas.length})`);
  const recuoSelecionada = selecionada.match(/^(\s*)❯/)[1].length;
  assert.equal(recuoSelecionada, 2, `recuo do ❯ no menu /model: 2 colunas (achei ${recuoSelecionada})`);
  for (const linha of naoSelecionadas) {
    const recuo = linha.match(/^(\s*)\d+\./)[1].length;
    assert.equal(recuo, 4, `recuo de item NÃO marcado no menu /model: 4 colunas (linha "${linha}", achei ${recuo})`);
  }
}

// ── O composer usa o MESMO caractere, na coluna 0 — é este fato que sustenta a decisão
//    de não interpretar (§4.2 da spec: marcador de seleção === marcador do rascunho) ────
{
  const tela = linhas('2.1.258-02-livre.txt');
  const linhaComposer = tela.find((l) => l.startsWith(MARCA_CLAUDE));
  assert.ok(linhaComposer !== undefined, 'catálogo: o composer livre começa com ❯ em 2.1.258-02-livre.txt');
  assert.equal(linhaComposer.indexOf(MARCA_CLAUDE), 0, 'o ❯ do composer está na COLUNA 0, igual ao item selecionado de um menu');
}

// ── Claude ≠ Codex: caracteres DIFERENTES — comparado por code point, não por olho ──────
{
  const claude = linhas('2.1.258-02-livre.txt').find((l) => l.startsWith(MARCA_CLAUDE));
  const codex = fs.readFileSync(path.join(__dirname, 'fixtures', 'menu-codex', '0.153.4-livre-sem-conversa.txt'), 'utf8')
    .split('\n').find((l) => l.startsWith(MARCA_CODEX));
  assert.ok(claude && codex, 'as duas fixtures de comparação existem (uma de cada pasta)');
  assert.equal(claude.codePointAt(0), 0x276f, 'Claude marca com U+276F (❯)');
  assert.equal(codex.codePointAt(0), 0x203a, 'Codex marca com U+203A (›)');
  assert.notEqual(claude.codePointAt(0), codex.codePointAt(0), 'e os dois code points NÃO coincidem');
}

console.log('✅ menu-claude: o catálogo do §4.1 (❯ no Claude, recuo 1/2/4, seta que anda, composer ambíguo, ≠ do Codex) continua verdadeiro');
