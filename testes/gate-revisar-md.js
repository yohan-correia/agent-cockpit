#!/usr/bin/env node
'use strict';
// GATE das funções PURAS do markdown/smoke da tela "Pra revisar" (plano
// docs/superpowers/plans/2026-10-04-tela-pra-revisar-plano.md, Fase D).
//
// `require('../public/revisar.js')` roda em Node PURO, sem DOM: o arquivo exporta
// `globalThis.cockpitRevisar = { blocosDoMarkdown, blocosDoSmoke }` ANTES de tocar em
// `document` — é esse require, sem fabricar um DOM de mentira, que prova que as duas
// funções são mesmo puras (nenhum `createElement` escondido dentro delas).
//
// Uso:  node testes/gate-revisar-md.js

const fs = require('node:fs');
const path = require('node:path');

require(path.join(__dirname, '..', 'public', 'revisar.js'));
const { blocosDoMarkdown, blocosDoSmoke, pendenciasDe } = globalThis.cockpitRevisar;

let falhas = 0;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };

// ─── blocosDoMarkdown — o relatório real do job …-93b1 (fixture) ──────────────────────────

function testeMarkdownRelatorioReal() {
  const md = fs.readFileSync(path.join(__dirname, 'fixtures', 'relatorio-93b1.md'), 'utf8');
  const blocos = blocosDoMarkdown(md);

  const titulos = blocos.filter((b) => b.tipo === 'titulo').map((b) => b.texto);
  ok(titulos.includes('O que o card não sabia') && titulos.includes('O que entrou')
    && titulos.includes('Validações executadas') && titulos.includes('Avaliação externa')
    && titulos.includes('Pendências e registros'),
    `os títulos (##) do relatório real saem como blocos 'titulo' — ${JSON.stringify(titulos)}`);

  const listaComSub = blocos.find((b) => b.tipo === 'lista' && b.itens.some((i) => i.sub));
  ok(Boolean(listaComSub), 'pelo menos uma lista com recuo (sub-item) sai com `sub: true`');
  ok(listaComSub.itens.some((i) => !i.sub), 'e a mesma lista tem item SEM recuo também (sub: false)');

  const tabela = blocos.find((b) => b.tipo === 'tabela');
  ok(Boolean(tabela), 'a tabela "| Gate | Resultado |" sai como bloco \'tabela\'');
  ok(Boolean(tabela) && tabela.cabecalho.join('|') === 'Gate|Resultado', `cabeçalho correto — ${JSON.stringify(tabela && tabela.cabecalho)}`);
  ok(Boolean(tabela) && tabela.linhas.length === 11, `11 linhas de corpo, sem a linha separadora (|---|---|) — veio ${tabela && tabela.linhas.length}`);
  ok(Boolean(tabela) && tabela.linhas[0][0] === 'tsc / vitest', `a 1ª linha de corpo é a certa — ${JSON.stringify(tabela && tabela.linhas[0])}`);

  const paragrafos = blocos.filter((b) => b.tipo === 'paragrafo');
  ok(paragrafos.some((p) => p.texto.startsWith('done:')), 'o parágrafo inicial ("done: …") sai como bloco \'paragrafo\', cru (o inline fica para o desenho)');
}

// ─── blocosDoMarkdown — XSS: tag/atributo vira TEXTO, nunca marcação ──────────────────────

function testeMarkdownNaoInterpretaHtml() {
  const perigoso = [
    'parágrafo com <script>alert(1)</script> no meio',
    '- item de lista com <img src=x onerror="alert(1)">',
    '## título com <script>alert(2)</script>',
  ].join('\n\n');
  const blocos = blocosDoMarkdown(perigoso);
  const textoBruto = blocos.map((b) => (b.tipo === 'lista' ? b.itens.map((i) => i.texto).join('\n') : b.texto)).join('\n');
  ok(textoBruto.includes('<script>alert(1)</script>'), '<script> do parágrafo sobrevive LITERAL no texto do bloco (vira texto, não é removido)');
  ok(textoBruto.includes('<img src=x onerror="alert(1)">'), '<img onerror> do item de lista idem — literal, nunca interpretado');
  ok(textoBruto.includes('<script>alert(2)</script>'), '<script> dentro de um "## título" também vira texto cru do bloco \'titulo\'');
  // A prova de verdade (nenhuma marcação é "executada") está em desenharBlocos, que só usa
  // createElement/textContent — não há `.innerHTML` (uso, não comentário) em lugar nenhum
  // deste arquivo.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'revisar.js'), 'utf8');
  ok(!/\.innerHTML/.test(fonte), 'public/revisar.js não tem UM USO de .innerHTML (só comentários citam a regra)');
}

// ─── blocosDoSmoke ─────────────────────────────────────────────────────────────────────────

function testeSmokeBemFormado() {
  const texto = [
    'done: tudo certo',
    '',
    '## Smoke pra o dono',
    '1. Escolha um crédito cujo valor bate com a sugestão e toque em Revisar.',
    '   - Onde: Loja Exemplo (dev) → Financeiro → Conciliação → aba Entradas',
    '   - Deve ver: abre o modal de revisão com banco, paciente, venda e o ajuste.',
    '2. Toque em Confirmar duas vezes, rápido.',
    '   - Onde: no mesmo modal',
    '   - Deve ver: grava uma vez só.',
    '',
    '## Outra seção qualquer',
    'isto não é mais smoke',
  ].join('\n');
  const passos = blocosDoSmoke(texto);
  ok(Array.isArray(passos) && passos.length === 2, `roteiro bem formado → 2 passos — veio ${JSON.stringify(passos)}`);
  ok(passos[0].faz.startsWith('Escolha um crédito') && passos[0].onde.startsWith('Loja Exemplo') && passos[0].deveVer.startsWith('abre o modal'),
    `passo 1 com os 3 campos — ${JSON.stringify(passos[0])}`);
  ok(passos[1].faz.startsWith('Toque em Confirmar') && passos[1].onde === 'no mesmo modal' && passos[1].deveVer === 'grava uma vez só.',
    `passo 2 com os 3 campos — ${JSON.stringify(passos[1])}`);
}

function testeSmokeSemSecao() {
  const texto = 'done: tudo certo\n\n## O que entrou\n- x\n';
  ok(blocosDoSmoke(texto) === null, 'sem a seção "## Smoke pra o dono" → null');
}

function testeSmokeNadaATestar() {
  const texto = [
    'done: só documentação',
    '',
    '## Smoke pra o dono',
    'Nada a testar à mão: só mexi em docs/, não há tela nem comportamento pra clicar.',
  ].join('\n');
  const r = blocosDoSmoke(texto);
  ok(!Array.isArray(r) && r && r.nada === 'só mexi em docs/, não há tela nem comportamento pra clicar.',
    `"Nada a testar à mão: …" → { nada } — veio ${JSON.stringify(r)}`);
}

function testeSmokePassoSemDeveVer() {
  const texto = [
    '## Smoke pra o dono',
    '1. Faça a coisa.',
    '   - Onde: a tela X',
  ].join('\n');
  const passos = blocosDoSmoke(texto);
  ok(Array.isArray(passos) && passos.length === 1, `1 passo, mesmo incompleto — veio ${JSON.stringify(passos)}`);
  ok(passos[0].faz === 'Faça a coisa.' && passos[0].onde === 'a tela X' && passos[0].deveVer === '',
    `passo sem "Deve ver:" → o campo vem vazio e o passo CONTINUA aparecendo — ${JSON.stringify(passos[0])}`);
}

function testeSmokeQualquerDono() {
  const um = blocosDoSmoke('## Smoke pra o Fulano\n1. Faça a coisa.\n   - Onde: a tela X\n   - Deve ver: o efeito.');
  ok(Array.isArray(um) && um.length === 1, `"## Smoke pra o Fulano" (qualquer nome) → 1 passo — veio ${JSON.stringify(um)}`);
  ok(blocosDoSmoke('## Smoke pra o dono e outros\n1. Faça a coisa.') === null, '"## Smoke pra o dono e outros" (duas palavras) → null');
}

function testePendencias() {
  const r = typeof pendenciasDe === 'function' ? pendenciasDe('x\n## Pendências para o orquestrador\n- a\n## Outra\n- b\n') : null;
  ok(r && r.titulo === 'Pendências para o orquestrador' && r.texto.includes('- a') && !r.texto.includes('Outra'),
    `pendenciasDe acha o título real e só a sua seção — veio ${JSON.stringify(r)}`);
  ok(typeof pendenciasDe === 'function' && pendenciasDe('## Pendências para o dono e outros\n- a') === null, 'título com duas palavras → null');
  ok(typeof pendenciasDe === 'function' && pendenciasDe('done\n## O que entrou\n- x\n') === null, 'sem a seção → null');
  ok(typeof pendenciasDe === 'function' && pendenciasDe('## Pendências para o dono\n\n## Outra\n- b\n') === null, 'seção vazia → null');
}

// ─── Execução ──────────────────────────────────────────────────────────────────────────────

console.log('\n── blocosDoMarkdown — relatório real (…-93b1) ──\n');
testeMarkdownRelatorioReal();

console.log('\n── blocosDoMarkdown — XSS vira texto, nunca marcação ──\n');
testeMarkdownNaoInterpretaHtml();

console.log('\n── blocosDoSmoke ──\n');
testeSmokeBemFormado();
testeSmokeSemSecao();
testeSmokeNadaATestar();
testeSmokePassoSemDeveVer();
testeSmokeQualquerDono();

console.log('\n── pendenciasDe ──\n');
testePendencias();

console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — revisar-md\n`);
process.exit(falhas === 0 ? 0 : 1);
