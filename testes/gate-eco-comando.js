'use strict';
// GATE — o eco de um comando de barra (`/clear`, `/handoff`, `/effort high`) consome a bolha
// "na fila", em vez de deixá-la presa até o teto de 30 min.
//
// O DEFEITO que este gate tranca (achado em 10/09/2026): o CLI não grava `/clear` no `.jsonl`.
// Grava o envelope `<command-name>` + `<command-message>` (+ `<command-args>` nos nativos).
// `textoDoHumano` (lib/externo.js) só sabia desfazer o envelope do `<bash-input>`, então
// devolvia o XML inteiro; `consumirPendente` (lib/abas.js) comparava a ficha `/clear` com esse
// XML, os dois testes (`===` e `endsWith`) falhavam, e a pendente sobrevivia 30 minutos.
//
// Por que NÃO foi consertado com um desvio por nome de comando em `digitarNaAba`, como o do
// Codex: SKILL usa o mesmo envelope que comando nativo. Uma lista fixa de nativos deixaria
// `/ataca` quebrado; ignorar todo `/…` mataria a bolha de toda skill rodada pelo cockpit.
//
// Irmão de gate-eco-bash.js — mesma função, o outro envelope. Só fixtures, nada de I/O.
const assert = require('node:assert/strict');
const externo = require('../lib/externo');
const abas = require('../lib/abas');

// RELATIVO ao agora, nunca cravado: data fixa envelhece e `podarVencidas` come a fixture
// antes do assert (foi o que derrubou o gate-eco-bash entre 08/09 e 10/09).
const quando = new Date(Date.now() - 1000).toISOString();
const chave = 'fixture-eco-comando';
const linha = (texto, extra = {}) => ({ type: 'user', timestamp: quando, message: { content: texto }, ...extra });
const texto = (conteudo, extra) => {
  const eventos = externo.eventosDoObjeto(linha(conteudo, extra));
  return eventos.length ? eventos[0].texto : null;
};

// As DUAS formas que o CLI grava, copiadas de `.jsonl` reais — a ordem das tags MUDA entre
// elas, e o nativo ainda indenta as linhas seguintes. É por isso que o desembrulho não pode
// ser um regex ancorado como o do `<bash-input>`.
const NATIVO = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';
const SKILL = '<command-message>handoff</command-message>\n<command-name>/handoff</command-name>';

try {
  // 1. O caminho que importa: a pendente do `/clear` sai da fila quando o eco volta do disco.
  const ficha = abas.registrarPendente(chave, { id: 'cmd-1', texto: '/clear', mensagem: '/clear' }, Date.parse(quando) - 200);
  assert.equal(texto(NATIVO), '/clear', 'o eco do comando nativo vira o que o humano digitou');
  assert.equal(abas.consumirPendente(chave, '/clear', quando), ficha, 'o eco consome a pendente');
  assert.equal(abas.pendentesDe(chave).length, 0, 'comando recebido não continua na fila');

  // 2. Skill: outra ordem de tags, sem `<command-args>`.
  assert.equal(texto(SKILL), '/handoff', 'skill usa o mesmo envelope e também precisa desembrulhar');

  // 3. Argumento entra no texto — a ficha guarda o que foi digitado, argumento incluído.
  assert.equal(texto('<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>'),
    '/effort high', 'o argumento volta junto do nome');

  // 4. Nome com namespace de plugin (`:`) não é caso especial nenhum.
  assert.equal(texto('<command-message>understand-anything:understand</command-message>\n<command-name>/understand-anything:understand</command-name>'),
    '/understand-anything:understand');

  // 5. FALSO POSITIVO — a trava do `resto`: uma fala de verdade que CITA a tag continua sendo
  // a fala. Sem isto, pedir explicação sobre o envelope viraria a bolha "/clear".
  const citacao = 'Explique o <command-name>/clear</command-name> que aparece no jsonl';
  assert.equal(texto(citacao), citacao, 'não altera tag citada no meio de uma mensagem');

  // 6. Formato incompleto não é inventado (mesma regra do gate-eco-bash).
  assert.equal(texto('<command-name>/clear'), '<command-name>/clear', 'formato incompleto não é inventado');
  assert.equal(texto('<command-name></command-name>\n<command-args></command-args>'),
    '<command-name></command-name>\n<command-args></command-args>', 'envelope sem nome não vira comando vazio');

  // 7. Injeção do sistema continua fora da fita.
  assert.equal(externo.eventosDoObjeto(linha(NATIVO, { isMeta: true })).length, 0);
  assert.equal(externo.eventosDoObjeto(linha(NATIVO, { isSidechain: true })).length, 0);

  // 8. A guarda de tempo do `consumirPendente` não afrouxa por causa do desembrulho: eco
  // ANTIGO não pode roubar um reenvio NOVO do mesmo comando.
  const nova = abas.registrarPendente(chave, { id: 'cmd-2', texto: '/clear', mensagem: '/clear' }, Date.parse(quando) + 1);
  assert.equal(abas.consumirPendente(chave, '/clear', quando), null, 'eco antigo não consome reenvio novo');
  assert.equal(abas.pendentesDe(chave)[0], nova);

  console.log('GATE VERDE — eco de comando de barra (nativo e skill) consome a fila');
} finally { abas.esquecerPendentes(chave); }
