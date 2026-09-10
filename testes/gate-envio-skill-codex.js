'use strict';
// Executa o envio real com fronteiras dubladas: não toca no tmux do usuário.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const fonte = fs.readFileSync(path.join(__dirname, '../lib/abas.js'), 'utf8');
const inicio = fonte.indexOf('async function digitarNaAba(');
const codigo = fonte.slice(inicio, fonte.indexOf('\n}\n', inicio) + 2);
(async () => {
  for (const [agente, texto, esperado] of [
    ['codex', '$handoff', '$handoff '],
    ['codex', '$handoff ', '$handoff '],
    ['codex', '$handoff Teste', '$handoff Teste'],
    ['codex', 'Use $handoff', 'Use $handoff '],
    ['codex', '/compact', '/compact'],
    ['claude', '$handoff', '$handoff'],
    ['claude', '/handoff', '/handoff'],
  ]) {
    const chamadas = [];
    const contexto = { path, PASTA_ANEXOS: '/tmp', limpar: x => x,
      buscar: async () => ({ agente, pane: '%7', alvo: '@7', titulo: 'teste' }),
      motivoDeRecusa: () => null, registrarPendente: (chave, dados) => dados,
      esquecerPendente: () => {}, espera: async () => {}, tmux: async args => chamadas.push(args), tmuxDoStatus: async args => chamadas.push(args) };
    vm.runInNewContext(codigo, contexto);
    const r = await contexto.digitarNaAba('aba-p7', texto);
    assert.equal(chamadas.length, 2, 'um envio literal e um único Enter');
    const nativo = agente === 'codex' && texto === '/compact';
    assert.equal(chamadas[0].at(-1), agente === 'codex' && !nativo
      ? `\x1b[200~${esperado}\x1b[201~` : esperado);
    assert.equal(chamadas[0][2], '%7');
    assert.equal(chamadas[1].at(-1), 'Enter');
    if (agente === 'codex' && texto === '/compact') {
      assert.equal(r.ficha, undefined, 'comando nativo não cria pendente');
      assert.equal(r.comando, texto);
      continue;
    }
    assert.equal(r.ficha.texto, texto.trim(), 'a bolha e a deduplicação mantêm o texto original');
    assert.equal(r.ficha.mensagem, texto.trim());
  }
  console.log('GATE VERDE — envio de skill Codex: 7 cenários');
})().catch(e => { console.error(e); process.exitCode = 1; });
