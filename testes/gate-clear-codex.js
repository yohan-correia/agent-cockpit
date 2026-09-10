'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const clear = require('../lib/clear-codex');
const status = require('../lib/status-codex');

(async () => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-clear-'));
  process.env.COCKPIT_CLEAR_CODEX_DIR = raiz;
  try {
    const sessaoId = '01a082aa-15b4-79a2-90b1-54f339ff417b';
    const depois = await fs.readFile(path.join(__dirname, 'fixtures/status-codex/0.153.4-clear.txt'), 'utf8');
    const antes = '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m';
    assert.equal(clear.confirmou(antes, depois, sessaoId), true);
    assert.equal(clear.confirmou(depois, depois, sessaoId), false, 'resposta antiga não comprova clear');
    assert.equal(clear.confirmou(antes, antes, sessaoId), false);
    assert.equal(clear.confirmou(antes, depois, '00000000-0000-0000-0000-000000000000'), false);
    assert.equal(clear.confirmou(antes, depois + '\n› rascunho', sessaoId), false);

    const processo = { pid: 123, inicio: 999, socket: 'fixture', sessao: 'fixture', pane: '%7', cwd: '/fixture' };
    const aba = { arquivo: '/fixture/antiga.jsonl', sessaoId, casamento: 'ok', rodando: false };
    assert.deepEqual(await clear.aplicar(aba, processo), aba);
    await clear.registrar(processo, sessaoId, 'teste');
    assert.equal(await clear.executado(processo, 'teste'), true);
    assert.equal(await clear.executado(processo, 'outro'), false);
    let vazia = await clear.aplicar(aba, processo);
    assert.equal(vazia.arquivo, null); assert.equal(vazia.reiniciada, true); assert.equal(vazia.sessaoId, null);
    delete require.cache[require.resolve('../lib/clear-codex')];
    assert.equal((await require('../lib/clear-codex').aplicar(aba, processo)).arquivo, null, 'reset é do disco');
    for (const outro of [{pid:124}, {inicio:1000}, {socket:'outro'}, {pane:'%8'}]) {
      assert.deepEqual(await clear.aplicar(aba, {...processo, ...outro}), aba, 'reset não vaza de processo/pane/socket');
    }
    const ambiguo = {...aba, casamento:'ambiguo'};
    assert.deepEqual(await clear.aplicar(ambiguo, processo), ambiguo, 'não afrouxa ambiguidade');
    const nova = {...aba, sessaoId:'nova', arquivo:'/fixture/nova.jsonl'};
    assert.equal((await clear.aplicar(nova, processo, 0)).arquivo, null, 'listagem anterior ao clear não invalida reset');
    assert.deepEqual(await clear.aplicar(nova, processo), nova);
    assert.deepEqual(await clear.aplicar(aba, processo), aba, 'resume após conversa nova não herda reset antigo');

    const fonte = await fs.readFile(path.join(__dirname, '../lib/abas.js'), 'utf8');
    const inicio = fonte.indexOf('async function reiniciarCodex(');
    const codigo = fonte.slice(inicio, fonte.indexOf('\n}\n', inicio) + 2);
    async function executar(op = {}) {
      let t = Date.now(), fase = 0;
      const teclas = [], salvos = [];
      let esquecidas = 0;
      const a = { ...aba, chave:'aba-p7', agente:'codex', pane:'%7', processoCodex:processo };
      const ctx = {
        Date: class extends Date { static now() { return t; } },
        espera: async ms => { t += ms; },
        erro: (codigo, mensagem) => Object.assign(new Error(mensagem), {codigo}),
        motivoDeRecusaDeStatus: () => op.ocupado ? {codigo:409,mensagem:'ocupado'} : null,
        buscar: async () => op.mudou && fase ? {...a, pane:'%8'} : a,
        mesmaIdentidadeStatus: (x,y) => x.pane === y.pane,
        statusCodex: status,
        clearCodex: {...clear, executado: async () => false, registrar: async (...args) => salvos.push(args)},
        capturarPaneStatus: async () => fase === 0 ? (op.rascunho || antes)
          : fase === 1 ? (op.digitado || '› /clear ') : (op.stale ? antes : depois),
        tmuxDoStatus: async args => { if (op.falha) throw new Error('tmux falhou'); teclas.push(args); fase++; },
        esquecerPendentes: () => { esquecidas++; },
      };
      vm.runInNewContext(codigo, ctx);
      let erro;
      try { await ctx.reiniciarCodex('aba-p7', a, '/clear', 'envio'); } catch (e) { erro = e; }
      return { erro, teclas, salvos, esquecidas };
    }
    const feliz = await executar();
    assert.equal(feliz.erro, undefined); assert.equal(feliz.teclas.length, 2);
    assert.equal(feliz.salvos.length, 1); assert.equal(feliz.esquecidas, 1);
    for (const op of [{ocupado:true}, {rascunho:'› texto'}, {digitado:'› /clear texto'}, {stale:true}, {mudou:true}, {falha:true}]) {
      const r = await executar(op);
      assert.ok(r.erro, JSON.stringify(op)); assert.equal(r.salvos.length, 0); assert.equal(r.esquecidas, 0);
      if (op.ocupado || op.rascunho) assert.equal(r.teclas.length, 0);
      if (op.digitado || op.mudou) assert.equal(r.teclas.length, 1, 'sem Enter em composer/pane alterado');
    }
    console.log('GATE VERDE — clear: confirmação, recusas, persistência e isolamento');
  } finally { await fs.rm(raiz, {recursive:true, force:true}); }
})().catch(e => { console.error(e); process.exitCode = 1; });
