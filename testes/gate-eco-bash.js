'use strict';
// Somente fixtures: nunca executa comandos de shell vindos de mensagens.
const assert = require('node:assert/strict');
const path = require('node:path');
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
(async () => {
  let falhas = 0;
  // Bloco `unidade`: o eco de !comando em cada forma, pendente a pendente.
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
    abas.esquecerPendentes(chave);
    // Card `fila-presa-com-comando-bash-da-fila`: "! cmd" mandado com o turno rodando passa
    // pela fila do CLI, que apara o comando — o eco volta `<bash-input>cmd</bash-input>`, SEM
    // o espaço (9 de 9 no disco, 09/10/2026). A pendente "! cmd" tem que sair da fila assim mesmo.
    const daFila = abas.registrarPendente(chave, {id:'bang-fila', texto:comando, mensagem:comando}, Date.parse(quando)-200);
    const ecoDaFila = externo.eventosDoObjeto(linha("<bash-input>printf 'fixture'</bash-input>"))[0];
    assert.equal(abas.consumirPendente(chave, ecoDaFila.texto, ecoDaFila.quando), daFila, 'eco aparado pela fila consome a pendente "! cmd"');
    assert.equal(abas.casaComEnviado('!ls', '! ls'), 2, 'espaço depois do ! inicial casa no grau 2, não no 1');
    // Colisão: com "! ls" e "!ls" na fila e o disco devolvendo "!ls", o idêntico (grau 1) ganha.
    const comEspaco = abas.registrarPendente(chave, {id:'bang-a', texto:'! ls', mensagem:'! ls'}, Date.parse(quando)-300);
    const colado = abas.registrarPendente(chave, {id:'bang-b', texto:'!ls', mensagem:'!ls'}, Date.parse(quando)-200);
    assert.equal(abas.consumirPendente(chave, '!ls', quando), colado, 'idêntico ganha da pendente com espaço');
    assert.deepEqual(abas.pendentesDe(chave), [comEspaco]);
    // Sem afrouxar o resto: o espaço só some depois do ! INICIAL, e só na igualdade inteira.
    assert.equal(abas.casaComEnviado('a !b', 'a ! b'), 0, '! no meio do texto continua exigindo o espaço');
    assert.equal(abas.casaComEnviado('rascunho! ls', '!ls'), 0, 'grau 3 (rascunho na frente) não ganha a regra nova');
  } catch (e) { console.error(e); falhas += 1; } finally { abas.esquecerPendentes(chave); }
  // Bloco `fixture`: a sequência real da fila (enqueue -> dequeue -> eco aparado), lida pelo
  // MESMO leitor da abertura do SSE e consumida como o loop dela faz.
  const chaveFixture = 'fixture-eco-bash-fila';
  try {
    const { eventos } = await externo.lerConversa(path.join(__dirname, 'fixtures', 'eco-bash', 'fila.jsonl'), 0);
    // Data cravada é segura AQUI: o aviso do topo vale para `pendentesDe`, que poda contra o
    // agora. `registrarPendente` poda contra o `em` passado e `consumirPendente` não poda —
    // por isso este bloco NUNCA chama `abas.pendentesDe`.
    const ficha = abas.registrarPendente(chaveFixture, {id:'bang-fx', texto:'! echo x', mensagem:'! echo x'}, Date.parse('2026-10-09T02:06:48.000Z'));
    const consumidas = [];
    for (const evento of eventos) {
      if (evento.tipo === 'humano') consumidas.push(abas.consumirPendente(chaveFixture, evento.texto, evento.quando));
    }
    const humanos = eventos.filter((e) => e.tipo === 'humano');
    const comBang = humanos.filter((e) => e.texto.startsWith('!'));
    assert.equal(comBang.length, 1, 'um único humano começa com !');
    assert.equal(comBang[0].texto, '!echo x');
    assert.equal(consumidas.filter((c) => c === ficha).length, 1, 'a pendente "! echo x" sai exatamente uma vez');
    // Até 11/10 o bash-stdout também virava humano (2) — era o defeito do card `saida-do-comando-em-cartao`
    // cravado aqui. Agora a saída é `saida_comando` (D79): 1 humano, 1 saída.
    assert.equal(humanos.length, 1, 'só o !echo x vira humano (enqueue/dequeue/system/bash-stdout não)');
    assert.equal(eventos.filter((e) => e.tipo === 'saida_comando').length, 1, 'o bash-stdout vira saida_comando');
  } catch (e) { console.error(e); falhas += 1; } finally { abas.esquecerPendentes(chaveFixture); }
  if (falhas) { console.error(`❌ GATE VERMELHO (${falhas})`); process.exitCode = 1; }
  else console.log('GATE VERDE — eco de !comando do Claude consome fila sem executar shell');
})();

