'use strict';
// Card `fila-presa-com-barra-invertida-no-fim`: mensagem que termina em "\" ("/handoff \") ficava
// pendente para sempre. A TUI do Claude lê "\" + Enter como "continua na linha de baixo", APAGA a
// "\", e o Enter da conferência (`TENTATIVAS_DE_ENTER`, lib/abas.js) submete — o `.jsonl` grava
// "/handoff". Medido em 13/10/2026 com o CLI 2.1.280 real (`testes/repro-barra-final-tui.sh`):
// só UMA "\" some ("\\" volta "\"), e a do meio fica. Armadilha #100.
//
// Somente fixtures: nada aqui fala com tmux nem com o CLI.
const assert = require('node:assert/strict');
const path = require('node:path');
const externo = require('../lib/externo');
const abas = require('../lib/abas');

// RELATIVO ao agora (mesmo motivo do gate-eco-bash): o teto da pendente é de 30 min, e
// `pendentesDe` poda contra o relógio — data cravada deixaria o gate vermelho no dia seguinte.
const quando = new Date(Date.now() - 1000).toISOString();
const linha = (texto) => ({ type: 'user', timestamp: quando, message: { content: texto } });

(async () => {
  let falhas = 0;
  const caso = (nome, fn) => {
    try { fn(); console.log(`  ✅ ${nome}`); } catch (e) { falhas += 1; console.error(`  ❌ ${nome}\n     ${e.message.split('\n')[0]}`); }
  };

  console.log('  · casa: a "\\" final que a TUI comeu (vermelho antes do conserto)');
  for (const [doDisco, enviado, grau, nome] of [
    ['/handoff', '/handoff \\', 2, 'comando de barra com espaço antes da "\\" (o caso do print)'],
    ['texto qualquer', 'texto qualquer \\', 2, 'texto com espaço antes da "\\"'],
    ['colado', 'colado\\', 2, '"\\" colada no texto'],
    ['eco duplo \\', 'eco duplo \\\\', 2, '"\\\\" no fim: a TUI come UMA só'],
    ['a\nb', 'a\nb \\', 2, 'multilinha, "\\" no fim da última linha'],
    ['rascunho/handoff', '/handoff \\', 3, 'rascunho na frente (#21): a "\\" continua sendo a última da caixa'],
  ]) caso(`${nome}: casaComEnviado(${JSON.stringify(doDisco)}, ${JSON.stringify(enviado)}) === ${grau}`, () => {
    assert.equal(abas.casaComEnviado(doDisco, enviado), grau);
  });

  console.log('  · não regride: o eco que PRESERVOU a "\\" casa como antes (verde antes e depois)');
  for (const [doDisco, enviado, grau] of [
    ['rascunho colado\\', 'colado\\', 3],
    ['alfa\nbeta\\', 'alfa\n\nbeta\\', 2],
    ['/handoff \\', '/handoff \\', 1],
    ['a\\b fim', 'a\\b fim', 1],
  ]) caso(`casaComEnviado(${JSON.stringify(doDisco)}, ${JSON.stringify(enviado)}) === ${grau}`, () => {
    assert.equal(abas.casaComEnviado(doDisco, enviado), grau);
  });

  console.log('  · negativos: só a "\\" FINAL, e só UMA (verde antes e depois)');
  for (const [doDisco, enviado, nome] of [
    ['ab', 'a\\b', '"\\" no meio continua contando'],
    ['eco duplo', 'eco duplo \\\\', 'de "\\\\" só sai uma'],
    ['x', '\\', 'só a barra não vira vazio-que-casa-tudo'],
    ['/handoff', '/handoff \\ x', '"\\" que não é a última não sai'],
  ]) caso(`${nome}: casaComEnviado(${JSON.stringify(doDisco)}, ${JSON.stringify(enviado)}) === 0`, () => {
    assert.equal(abas.casaComEnviado(doDisco, enviado), 0);
  });

  console.log('  · consumirPendente com o eco lido pelo leitor do cockpit');
  const chave = 'fixture-barra-final';
  caso('a ficha "/handoff \\" sai da fila com o eco <command-name>/handoff</command-name>', () => {
    try {
      const ficha = abas.registrarPendente(chave, { id: 'bf-1', texto: '/handoff \\', mensagem: '/handoff \\' }, Date.parse(quando) - 200);
      const [evento] = externo.eventosDoObjeto(linha('<command-message>handoff</command-message>\n<command-name>/handoff</command-name>'));
      assert.equal(evento.texto, '/handoff', 'o eco do comando de barra sem <command-args> vira "/handoff"');
      assert.equal(abas.consumirPendente(chave, evento.texto, evento.quando), ficha);
      assert.equal(abas.pendentesDe(chave).length, 0, 'não sobra nada para reemitir como "na fila"');
    } finally { abas.esquecerPendentes(chave); }
  });
  caso('colisão: com "x \\" e "x" na fila, o "x" do disco leva o idêntico; o próximo leva o outro', () => {
    try {
      const comBarra = abas.registrarPendente(chave, { id: 'bf-a', texto: 'x \\', mensagem: 'x \\' }, Date.parse(quando) - 300);
      const semBarra = abas.registrarPendente(chave, { id: 'bf-b', texto: 'x', mensagem: 'x' }, Date.parse(quando) - 200);
      assert.equal(abas.consumirPendente(chave, 'x', quando), semBarra, 'grau 1 (idêntico) ganha do grau 2');
      assert.equal(abas.consumirPendente(chave, 'x', quando), comBarra);
    } finally { abas.esquecerPendentes(chave); }
  });

  // A sequência REAL (CLI 2.1.280, 13/10/2026): as duas linhas `user` que o repro gravou, lidas
  // pelo MESMO leitor da abertura do SSE e consumidas como o laço dele faz. Data cravada é segura
  // aqui pelo mesmo motivo do gate-eco-bash: este bloco nunca chama `pendentesDe`.
  console.log('  · fixture: o que o CLI real gravou');
  const chaveFx = 'fixture-barra-final-tui';
  try {
    const { eventos } = await externo.lerConversa(path.join(__dirname, 'fixtures', 'barra-final', 'tui.jsonl'), 0);
    const humanos = eventos.filter((e) => e.tipo === 'humano');
    caso('o disco gravou "texto qualquer" e "/handoff" — sem a "\\"', () => {
      assert.deepEqual(humanos.map((e) => e.texto), ['texto qualquer', '/handoff']);
    });
    const em = Date.parse('2026-10-13T21:52:20.000Z');
    const texto = abas.registrarPendente(chaveFx, { id: 'bf-t', texto: 'texto qualquer \\', mensagem: 'texto qualquer \\' }, em);
    const handoff = abas.registrarPendente(chaveFx, { id: 'bf-h', texto: '/handoff \\', mensagem: '/handoff \\' }, em + 1);
    const consumidas = humanos.map((e) => abas.consumirPendente(chaveFx, e.texto, e.quando));
    caso('as duas fichas saem, cada uma pelo seu eco', () => {
      assert.equal(consumidas[0], texto);
      assert.equal(consumidas[1], handoff);
    });
  } catch (e) { falhas += 1; console.error(e); } finally { abas.esquecerPendentes(chaveFx); }

  if (falhas) { console.error(`❌ GATE VERMELHO (${falhas})`); process.exitCode = 1; }
  else console.log('GATE VERDE — mensagem terminada em "\\" sai da fila quando o eco volta sem ela');
})();
