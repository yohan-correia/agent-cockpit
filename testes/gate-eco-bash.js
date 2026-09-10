'use strict';
// Somente fixtures: nunca executa comandos de shell vindos de mensagens.
const assert = require('node:assert/strict');
const externo = require('../lib/externo');
const abas = require('../lib/abas');
// RELATIVO ao agora, nunca cravado: o teto da pendente é de 30 min (lib/abas.js,
// `MS_PENDENTE_TETO`), então uma data fixa faz este gate passar no dia em que foi escrito
// e ficar VERMELHO no dia seguinte — `podarVencidas` some com a fixture antes do assert.
// Foi o que aconteceu com a data de 08/09/2026, achado em 10/09.
const quando = new Date(Date.now() - 1000).toISOString();
const chave = 'fixture-eco-bash';
const comando = "! printf 'fixture'";
const linha = (texto, extra = {}) => ({ type:'user', timestamp:quando, message:{content:texto}, ...extra });
try {
  const ficha = abas.registrarPendente(chave, {id:'bang-1', texto:comando, mensagem:comando}, Date.parse(quando)-200);
  const eventos = externo.eventosDoObjeto(linha("<bash-input> printf 'fixture'</bash-input>"));
  assert.equal(eventos[0].texto, comando, 'o eco do Claude precisa preservar a sintaxe enviada pelo usuário');
  assert.equal(abas.consumirPendente(chave, eventos[0].texto, eventos[0].quando), ficha);
  assert.equal(abas.pendentesDe(chave).length, 0, 'comando recebido não continua na fila');
  assert.equal(externo.eventosDoObjeto(linha('<bash-input>pwd</bash-input>'))[0].texto, '!pwd');
  const explicacao = 'Explique <bash-input>pwd</bash-input>';
  assert.equal(externo.eventosDoObjeto(linha(explicacao))[0].texto, explicacao, 'não altera tags citadas numa mensagem');
  assert.equal(externo.eventosDoObjeto(linha('<bash-input>pwd</bash-input>', {isMeta:true})).length, 0);
  assert.equal(externo.eventosDoObjeto(linha('<bash-input>pwd</bash-input>', {isSidechain:true})).length, 0);
  assert.equal(externo.eventosDoObjeto(linha('<bash-input>pwd'))[0].texto, '<bash-input>pwd', 'formato incompleto não é inventado');
  const antiga = abas.registrarPendente(chave, {id:'bang-2', texto:comando, mensagem:comando}, Date.parse(quando)+1);
  assert.equal(abas.consumirPendente(chave, eventos[0].texto, eventos[0].quando), null, 'eco antigo não consome reenvio novo');
  assert.equal(abas.pendentesDe(chave)[0], antiga);
  console.log('GATE VERDE — eco de !comando do Claude consome fila sem executar shell');
} finally { abas.esquecerPendentes(chave); }
