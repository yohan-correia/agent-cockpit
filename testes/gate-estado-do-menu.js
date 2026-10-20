#!/usr/bin/env node
'use strict';
// GATE de `estadoDoMenu(aba)` — offline, zero tmux real, zero sessão de verdade lida.
//
// Card `escrever-texto-na-pergunta-aberta`. Spec:
// docs/superpowers/specs/2026-09-21-escrever-texto-na-pergunta-aberta-design.md
// Plano: docs/superpowers/plans/2026-09-21-escrever-texto-na-pergunta-aberta-plano.md (Fase 1)
//
// `estadoDoMenu` ainda não é chamada de lugar nenhum (Fase 1 é só a função nascer); este
// gate a exercita direto, sem passar por `digitarNaAba`.
//
// ⚠️ Isolar `HOME` não basta: `RAIZ_SESSOES_CLI` é `const` de módulo (`lib/abas.js`),
// resolvida no `require`. O molde é o `comEspiaoAbas` de `testes/gate-menu-codex.js:155-171`
// — trocar o env, `limparCache()` do `require.cache`, e só então `require` fresco.
//
// 16/10 (D85a): com pane e status parado o ramo Claude lê a tela pela régua `lib/menu-claude.js`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

let tudoOk = true;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) tudoOk = false; return c; };

const original = cp.execFile;
let chamouTmux = false;
let respostaCapturePane = '';
cp.execFile = (bin, args, opts, cb) => {
  const pronto = cb || opts;
  const cmd = args && (args[0] === '-L' ? args[2] : args[0]);
  if (bin === 'tmux' || cmd === 'capture-pane') {
    chamouTmux = true;
    return pronto(null, respostaCapturePane, '');
  }
  return original(bin, args, opts, cb);
};

function limparCache() {
  for (const m of ['../lib/abas', '../lib/menu-codex']) {
    try { delete require.cache[require.resolve(m)]; } catch { /* segue */ }
  }
}

// Duas telas SINTÉTICAS, casadas com a régua v6 de `lib/menu-codex.js` (comentário do
// próprio módulo): 'menu' exige um item de menu na última linha do composer E uma dica de
// tecla na última linha da tela; 'livre' é um composer sem forma de item.
const TELA_MENU = '› 1. gpt-6-astra (default)\nenter select';
const TELA_LIVRE = '› oi tudo bem';
const TELA_SEM_MARCA = 'sem marcador de composer nenhum aqui';

(async () => {
  console.log('\n── Gate de estadoDoMenu(aba) — offline ──');

  // ── Codex — as quatro entradas do plano, mapeadas para os três valores ──────────
  console.log('\n  · Codex');
  limparCache();
  const abasCodex = require('../lib/abas');
  for (const [rotulo, tela, esperado] of [
    ["classificarTela === 'menu'", TELA_MENU, 'menu'],
    ["classificarTela === 'livre'", TELA_LIVRE, 'livre'],
    ["classificarTela === 'desconhecido'", TELA_SEM_MARCA, 'nao-sei'],
    ['captura vazia (prazo estourado)', '', 'nao-sei'],
  ]) {
    respostaCapturePane = tela;
    const aba = { agente: 'codex', pane: '%7', alvo: '@7' };
    const r = await abasCodex.estadoDoMenu(aba);
    ok(r === esperado, `${rotulo} ⇒ '${esperado}' (saiu '${r}')`);
  }

  // ── Claude — HOME isolado, sessions/<pid>.json de mentira ───────────────────────
  console.log('\n  · Claude');
  const homeFalso = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-estado-do-menu-'));
  const dirSessoes = path.join(homeFalso, '.claude', 'sessions');
  fs.mkdirSync(dirSessoes, { recursive: true });
  const antesHome = process.env.HOME;
  process.env.HOME = homeFalso;
  limparCache();
  const abasClaude = require('../lib/abas');

  const escrever = (pid, conteudo) => fs.writeFileSync(path.join(dirSessoes, `${pid}.json`), conteudo);

  try {
    chamouTmux = false;

    escrever(101, JSON.stringify({ status: 'waiting' }));
    ok(await abasClaude.estadoDoMenu({ agente: 'claude', agentePid: 101 }) === 'menu',
      "status: 'waiting' ⇒ 'menu'");

    escrever(102, JSON.stringify({ status: 'idle' }));
    ok(await abasClaude.estadoDoMenu({ agente: 'claude', agentePid: 102 }) === 'livre',
      "status: 'idle' ⇒ 'livre'");

    escrever(103, JSON.stringify({ status: 'busy' }));
    ok(await abasClaude.estadoDoMenu({ agente: 'claude', agentePid: 103 }) === 'livre',
      "status: 'busy' ⇒ 'livre'");

    ok(await abasClaude.estadoDoMenu({ agente: 'claude', agentePid: 999999 }) === 'nao-sei',
      "arquivo ausente (ENOENT) ⇒ 'nao-sei'");

    escrever(104, '{');
    ok(await abasClaude.estadoDoMenu({ agente: 'claude', agentePid: 104 }) === 'nao-sei',
      "JSON inválido ⇒ 'nao-sei'");

    escrever(105, JSON.stringify({ pid: 105 })); // sem campo `status`
    ok(await abasClaude.estadoDoMenu({ agente: 'claude', agentePid: 105 }) === 'nao-sei',
      "objeto sem `status` ⇒ 'nao-sei'");

    // A prova de "sem tocar no disco": o arquivo `null.json` EXISTE e diz `waiting`. Se a
    // função lesse o disco mesmo sem `agentePid`, o resultado seria 'menu', não 'nao-sei'.
    escrever('null', JSON.stringify({ status: 'waiting' }));
    ok(await abasClaude.estadoDoMenu({ agente: 'claude', agentePid: null }) === 'nao-sei',
      "agentePid: null ⇒ 'nao-sei', sem tocar no disco (arquivo null.json existe e diz 'waiting')");

    ok(chamouTmux === false,
      'sem pane conhecida, o ramo Claude não chama tmux/capture-pane (D85a só lê a tela com pane)');

    // ── Claude com pane (D85a): status parado + tela, pelas fixtures reais ────────────
    const telaDialogo = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'menu-auto-mode', '2.1.280-dialogo-120x40.txt'), 'utf8');
    const telaLivre = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'menu-auto-mode', '2.1.280-livre-depois-do-esc.txt'), 'utf8');

    escrever(201, JSON.stringify({ status: 'idle' }));
    const abaComPane = { agente: 'claude', agentePid: 201, pane: '%9', alvo: '@9' };

    chamouTmux = false;
    respostaCapturePane = telaDialogo;
    ok(await abasClaude.estadoDoMenu(abaComPane) === 'menu',
      "idle + pane + tela de diálogo ⇒ 'menu'");
    ok(chamouTmux === true, 'idle + pane chama tmux/capture-pane (D85a)');

    respostaCapturePane = telaLivre;
    ok(await abasClaude.estadoDoMenu(abaComPane) === 'livre',
      "idle + pane + tela livre ⇒ 'livre'");

    respostaCapturePane = '';
    ok(await abasClaude.estadoDoMenu(abaComPane) === 'nao-sei',
      "idle + pane + captura vazia ⇒ 'nao-sei'");

    escrever(202, JSON.stringify({ status: 'busy' }));
    chamouTmux = false;
    respostaCapturePane = telaDialogo;
    ok(await abasClaude.estadoDoMenu({ agente: 'claude', agentePid: 202, pane: '%9', alvo: '@9' }) === 'livre',
      "busy + pane + tela de diálogo ⇒ 'livre' (o status já responde)");
    ok(chamouTmux === false, 'busy não chama tmux mesmo com pane conhecida (#80)');

    escrever(203, JSON.stringify({ status: 'waiting' }));
    chamouTmux = false;
    respostaCapturePane = telaDialogo;
    ok(await abasClaude.estadoDoMenu({ agente: 'claude', agentePid: 203, pane: '%9', alvo: '@9' }) === 'menu',
      "waiting + pane + tela de diálogo ⇒ 'menu' (o status já responde)");
    ok(chamouTmux === false, 'waiting não chama tmux mesmo com pane conhecida');
  } finally {
    process.env.HOME = antesHome;
    limparCache();
    fs.rmSync(homeFalso, { recursive: true, force: true });
    cp.execFile = original;
  }

  console.log(`\n${tudoOk ? '✅ GATE VERDE — estado-do-menu' : '❌ GATE VERMELHO — estado-do-menu'}\n`);
  process.exit(tudoOk ? 0 : 1);
})();
