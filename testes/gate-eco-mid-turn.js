'use strict';
// GATE — a mensagem escrita ENQUANTO o agente trabalha consome a bolha "na fila", em vez de
// ficar presa até o teto de 30 min.
//
// O DEFEITO que este gate tranca (achado em 11/09/2026, medido no `.jsonl` da própria sessão
// que o encontrou): o Claude grava uma mensagem mid-turn de um jeito que NÃO é `type: "user"`.
// São três linhas para o mesmo texto:
//
//   1. `queue-operation` / `operation: "enqueue"`                    — entrou na fila do CLI
//   2. `queue-operation` / `operation: "remove"` / `absorbed_mid_turn` — o turno a absorveu
//   3. `attachment` com `attachment.type: "queued_command"`           — o texto, de novo
//
// `eventosDoObjeto` só aceitava `type === 'user'`, então NENHUMA das três voltava como fala do
// humano: `consumirPendente` (lib/abas.js) nunca era chamado com aquele texto e a bolha ficava
// "na fila" para sempre. É o mesmo defeito de família do gate-eco-comando — o leitor do disco
// não reconhecia uma das formas que o CLI usa para gravar a MESMA coisa.
//
// POR QUE A `queue-operation`, E NÃO A `attachment` (as duas carregam o texto): o `attachment`
// não sabe se a mensagem virou turno normal depois. Medido em 728 arquivos do disco:
//
//   remove/absorbed_mid_turn   325 NÃO viram `user`,  2 viram (mesmo texto mandado 2x)
//   remove/<sem reason>        208 NÃO viram `user`  — todas `<task-notification>`
//   enqueue                    818 VIRAM `user`      — essas voltam pelo caminho de sempre
//
// Emitir pelo `attachment` duplicaria a bolha nos 818 casos de `enqueue` que já voltam como
// `user`. Só `absorbed_mid_turn` é a linha que diz "esta não vai voltar de outro jeito".
//
// E POR QUE O FILTRO DE ENVELOPE: dos 327 `absorbed_mid_turn` do disco, 305 são
// `<task-notification>` — máquina avisando máquina. Sem o filtro, 93% do caminho novo viraria
// bolha de ruído na fita. O filtro é estrutural (texto que é UMA tag fechada, do início ao
// fim), não uma lista de nomes: lista de nomes é a #40 esperando o próximo envelope nascer.
//
// Irmão de gate-eco-bash.js e gate-eco-comando.js. Só fixtures, nada de I/O.
const assert = require('node:assert/strict');
const externo = require('../lib/externo');
const abas = require('../lib/abas');

// RELATIVO ao agora, nunca cravado: data fixa envelhece e `podarVencidas` come a fixture antes
// do assert (foi o que derrubou o gate-eco-bash entre 08/09 e 10/09).
const quando = new Date(Date.now() - 1000).toISOString();
const chave = 'fixture-eco-mid-turn';

// Copiada de `.jsonl` real — estas cinco chaves, nesta forma. A linha NÃO tem `message`,
// `uuid` nem `isSidechain`: é por isso que nada do caminho de `user` a alcançava.
const fila = (operation, content, reason) => ({
  type: 'queue-operation',
  operation,
  ...(reason ? { reason } : {}),
  sessionId: 'aa33fb87-5065-4029-937c-10b16735769a',
  content,
  timestamp: quando,
});
const eventos = (obj) => externo.eventosDoObjeto(obj);
const texto = (obj) => { const e = eventos(obj); return e.length ? e[0].texto : null; };

const FALA = 'O bug do clear foi resolvido mas de uma mensagem normal na fila nao';
const NOTIFICACAO = '<task-notification>\n<task-id>b5bxpfxky</task-id>\n<summary>Monitor event</summary>\n</task-notification>';

try {
  // 1. O caminho que importa: a pendente sai da fila quando a absorção volta do disco.
  const ficha = abas.registrarPendente(chave, { id: 'mid-1', texto: FALA, mensagem: FALA }, Date.parse(quando) - 200);
  assert.equal(texto(fila('remove', FALA, 'absorbed_mid_turn')), FALA, 'a mensagem absorvida vira fala do humano');
  assert.equal(abas.consumirPendente(chave, FALA, quando), ficha, 'e consome a pendente');
  assert.equal(abas.pendentesDe(chave).length, 0, 'mensagem entregue não continua na fila');

  // 2. A HORA vai junto: sem ela a bolha da fita nasce sem horário, e `consumirPendente` exige
  //    `quando >= em` — evento sem hora reprova a comparação e a pendente sobreviveria.
  assert.equal(eventos(fila('remove', FALA, 'absorbed_mid_turn'))[0].quando, quando, 'o evento carrega o timestamp da linha');

  // 3. DUPLICATA — o `enqueue` carrega o MESMO texto e volta como `user` depois (818 casos
  //    medidos). Emitir aqui desenharia a mesma fala duas vezes na fita.
  assert.deepEqual(eventos(fila('enqueue', FALA)), [], 'enqueue não emite: o texto volta como user');

  // 4. `remove` sem `reason` é outra coisa (208 casos, todos máquina) e não emite.
  assert.deepEqual(eventos(fila('remove', FALA)), [], 'remove sem reason não emite');

  // 5. `attachment`/`queued_command` carrega o texto de novo — e é a SEGUNDA linha da mesma
  //    mensagem. Emitir junto com a de cima duplicaria a bolha.
  assert.deepEqual(eventos({
    type: 'attachment',
    timestamp: quando,
    isSidechain: false,
    attachment: { type: 'queued_command', prompt: FALA, timestamp: Date.parse(quando), commandMode: 'prompt' },
  }), [], 'attachment não emite: quem emite é a queue-operation');

  // 6. RUÍDO DE MÁQUINA — 305 dos 327 casos do disco. Não vira bolha do dono.
  assert.deepEqual(eventos(fila('remove', NOTIFICACAO, 'absorbed_mid_turn')), [], 'task-notification absorvida não é fala do humano');

  // 7. O filtro é ESTRUTURAL, não uma lista de nomes: um envelope que ainda não existe hoje
  //    também não passa, e é isso que impede a #40 de nascer de novo aqui.
  assert.deepEqual(eventos(fila('remove', '<envelope-que-ainda-nao-existe>x</envelope-que-ainda-nao-existe>', 'absorbed_mid_turn')), [],
    'envelope desconhecido também é máquina');

  // 8. FALSO POSITIVO — fala de verdade que CITA uma tag continua sendo fala. Sem isto,
  //    perguntar sobre `<task-notification>` sumiria da fita.
  const citacao = 'o que é <task-notification> no jsonl?';
  assert.equal(texto(fila('remove', citacao, 'absorbed_mid_turn')), citacao, 'tag citada no meio da frase não é envelope');

  // 9. Conteúdo vazio não vira bolha vazia.
  assert.deepEqual(eventos(fila('remove', '   ', 'absorbed_mid_turn')), [], 'content vazio não emite');

  console.log('GATE VERDE — mensagem escrita com o agente trabalhando consome a fila');
} catch (erro) {
  console.error(`GATE VERMELHO — ${erro.message}`);
  process.exitCode = 1;
}
