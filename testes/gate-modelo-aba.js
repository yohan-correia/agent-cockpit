#!/usr/bin/env node
'use strict';
// GATE — o campo Modelo da aba nova (card `modelo-na-nova-aba`).
//
// Spec: docs/superpowers/specs/2026-10-05-modelo-na-nova-aba-design.md (§4, §6.1)
// Plano: docs/superpowers/plans/2026-10-05-modelo-na-nova-aba-plano.md (Fase 1 e Fase 2)
//
// M1-M7 são OFFLINE — sem tmux, sem porta, molde do grupo 52-54 de `gate-codex.js:1763-1820`.
// M8 fala HTTP com um `server.js` filho, numa porta alta, molde de `gate-aparelhos.js:316-367`.
//
// ⚠️ ISOLAMENTO NO TOPO, antes de qualquer `require` de `../lib/*`: `lib/abas.js:67-73` lê
// `COCKPIT_TMUX_SOCKET`/`COCKPIT_TMUX_SESSAO` em CONSTANTE DE MÓDULO, resolvida no `require`.
// Rodado à mão, fora do `npm test`, o gate herdaria o socket e a sessão `main` do usuário —
// achado do painel. As linhas abaixo vencem qualquer valor herdado, incondicionalmente.
process.env.COCKPIT_TMUX_SOCKET = `cockpit-gate-modelo-off-${process.pid}`;
process.env.COCKPIT_TMUX_SESSAO = `nao-existe-${process.pid}`;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

// `confiarNaPasta` lê `~/.claude.json` via `os.homedir()` — HOME falso para nunca tocar o
// arquivo de trust de verdade.
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-modelo-aba-'));
process.env.HOME = fs.mkdtempSync(path.join(RAIZ, 'home-'));

let tudoOk = true;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) tudoOk = false; return c; };

// M1 prova byte a byte (P3) com o binário no valor PADRÃO do registro — por isso apaga a
// variável antes de qualquer `require` do registro a ler.
delete process.env.COCKPIT_BIN_CLAUDE;

const agentes = require('../lib/agentes');
const abas = require('../lib/abas');

const grupos = [];
const grupo = (rotulo, fn) => grupos.push({ rotulo, fn });

grupo('M1 — Padrão é byte a byte igual ao comando de hoje', () => {
  const esperado = '/usr/bin/claude; exec ${SHELL:-/bin/bash} -l';
  ok(abas.comandoDaAba('claude') === esperado, `comandoDaAba('claude') === comando de hoje (achei "${abas.comandoDaAba('claude')}")`);
  ok(abas.comandoDaAba('claude', null) === esperado, "comandoDaAba('claude', null) === comando de hoje");
  ok(abas.comandoDaAba('claude', undefined) === esperado, "comandoDaAba('claude', undefined) === comando de hoje");
});

grupo('M2 — cada modelo da lista vira --model <id>, igualdade exata', () => {
  for (const m of agentes.modelosDe('claude')) {
    const esperado = `/usr/bin/claude --model ${m.id}; exec \${SHELL:-/bin/bash} -l`;
    const achado = abas.comandoDaAba('claude', m.id);
    ok(achado === esperado, `modelo '${m.id}' ⇒ "${esperado}" (achei "${achado}")`);
  }
});

grupo('M3 — modelo fora da lista lança 400 sem ecoar o valor', () => {
  const casos = ['gpt-5', 'opus; rm -rf ~', 'OPUS', 'opus[1m]', '', ' opus', 'opus '];
  for (const x of casos) {
    let estourou = null;
    try { abas.comandoDaAba('claude', x); } catch (e) { estourou = e; }
    ok(estourou instanceof Error, `comandoDaAba('claude', ${JSON.stringify(x)}) LANÇA`);
    ok(estourou?.codigo === 400, `e o código é 400 (achei ${estourou?.codigo})`);
    if (x.trim() !== '') {
      ok(!String(estourou?.message).includes(x), `e a mensagem não ecoa "${x}" (achei "${estourou?.message}")`);
    }
  }
});

grupo('M4 — Codex é fail-closed no módulo; sem modelo, igual a hoje', () => {
  let estourou = null;
  try { abas.comandoDaAba('codex', 'fable'); } catch (e) { estourou = e; }
  ok(estourou instanceof Error && estourou.codigo === 400,
    `comandoDaAba('codex', 'fable') lança 400 (achei ${estourou?.codigo})`);
  const doCodex = abas.comandoDaAba('codex');
  ok(doCodex === abas.comandoDaAba('codex', null), "comandoDaAba('codex') === comandoDaAba('codex', null)");
  ok(!doCodex.includes('--model'), `e não contém --model (achei "${doCodex}")`);
});

grupo('M5 — forma dos ids/rótulos no registro', () => {
  const lista = agentes.modelosDe('claude');
  for (const m of lista) {
    ok(/^[a-z0-9-]+$/.test(m.id), `id '${m.id}' casa /^[a-z0-9-]+$/`);
    ok(typeof m.rotulo === 'string' && m.rotulo.length > 0, `rotulo de '${m.id}' é string não vazia (achei ${JSON.stringify(m.rotulo)})`);
  }
  const ids = lista.map((m) => m.id);
  ok(new Set(ids).size === ids.length, 'ids são únicos');
});

grupo('M6 — criar() rejeita modelo inválido ANTES de tocar no tmux', async () => {
  const recusou = await abas.criar({ cwd: '/tmp', nome: 'x', agente: 'claude', modelo: 'gpt-5' })
    .then(() => null, (e) => e);
  ok(recusou?.codigo === 400, `criar() com modelo fora da lista é 400 (achei ${recusou?.codigo})`);
});

grupo('M7 — modelosDe/modeloExiste', () => {
  ok(Array.isArray(agentes.modelosDe('codex')) && agentes.modelosDe('codex').length === 0, "modelosDe('codex') === []");
  ok(Array.isArray(agentes.modelosDe('job')) && agentes.modelosDe('job').length === 0, "modelosDe('job') === []");
  ok(Array.isArray(agentes.modelosDe('nao-existe')) && agentes.modelosDe('nao-existe').length === 0, "modelosDe('nao-existe') === []");
  const ids = agentes.modelosDe('claude').map((m) => m.id);
  ok(JSON.stringify(ids) === JSON.stringify(['opus', 'fable', 'sonnet', 'haiku']),
    `modelosDe('claude').map(id) === ['opus','fable','sonnet','haiku'] (achei ${JSON.stringify(ids)})`);
  ok(agentes.modeloExiste('claude', 'fable') === true, "modeloExiste('claude','fable') === true");
  ok(agentes.modeloExiste('codex', 'fable') === false, "modeloExiste('codex','fable') === false");
});

// ── M8 — a rota, por HTTP de verdade, em servidor filho isolado ────────────────────────────
async function portaLivre() {
  const servidor = net.createServer();
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const porta = servidor.address().port;
  await new Promise((resolve) => servidor.close(resolve));
  return porta;
}

function pedir(porta, rota, metodo, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : Buffer.from(JSON.stringify(corpo));
    const cabecalhos = {};
    if (dados) { cabecalhos['content-type'] = 'application/json'; cabecalhos['content-length'] = dados.length; }
    const req = http.request({ hostname: '127.0.0.1', port: porta, path: rota, method: metodo, headers: cabecalhos }, (res) => {
      let texto = '';
      res.on('data', (d) => { texto += d; });
      res.on('end', () => resolve({ status: res.statusCode, texto }));
    });
    req.on('error', reject);
    req.end(dados);
  });
}

async function withServer(socket, tarefa) {
  const root = path.resolve(__dirname, '..');
  const porta = await portaLivre();
  const home = fs.mkdtempSync(path.join(RAIZ, 'm8-home-'));
  const projetosDir = fs.mkdtempSync(path.join(RAIZ, 'm8-projetos-'));
  fs.mkdirSync(path.join(projetosDir, 'projeto-gate'));
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete base[k];
  Object.assign(base, {
    HOME: home, HOST: '127.0.0.1', PORT: String(porta),
    COCKPIT_CERT_DIR: '/dev/null',
    COCKPIT_TMUX_SOCKET: socket,
    COCKPIT_TMUX_SESSAO: `nao-existe-${process.pid}`,
    COCKPIT_JOBS_DIR: fs.mkdtempSync(path.join(RAIZ, 'm8-jobs-')),
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_BIN_CLAUDE: '/usr/bin/claude',
    COCKPIT_BIN_CODEX: '/usr/bin/codex',
  });
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: base, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout servidor')), 10000);
      child.stdout.on('data', (d) => { if (String(d).includes('cockpit-agentes em')) { clearTimeout(t); resolve(); } });
      child.once('exit', (codigo) => { clearTimeout(t); reject(new Error(`servidor saiu ${codigo}`)); });
    });
    await tarefa(porta);
  } finally {
    // #24: o filho morre pelo pid exato no finally, exista sucesso ou falha no teste.
    if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
  }
}

async function m8() {
  console.log('\n  · M8 — a rota, por HTTP, servidor filho isolado');
  const socket = `cockpit-gate-modelo-${process.pid}`;

  await withServer(socket, async (porta) => {
    const r = await pedir(porta, '/api/agentes', 'GET');
    ok(r.status === 200, `GET /api/agentes ⇒ 200 (achei ${r.status})`);
    const corpo = JSON.parse(r.texto);
    const claude = corpo.agentes.find((a) => a.id === 'claude');
    const codex = corpo.agentes.find((a) => a.id === 'codex');
    ok(JSON.stringify(claude?.modelos?.map((m) => m.id)) === JSON.stringify(['opus', 'fable', 'sonnet', 'haiku']),
      `claude.modelos são os 4 ids (achei ${JSON.stringify(claude?.modelos)})`);
    ok(Array.isArray(codex?.modelos) && codex.modelos.length === 0, 'codex.modelos === []');
    ok(!r.texto.includes('/usr/bin') && !r.texto.includes('/home/'),
      'o texto da resposta não tem caminho de binário nem de HOME (#22)');

    const invalido1 = await pedir(porta, '/api/abas', 'POST', { projeto: 'projeto-gate', agente: 'claude', modelo: 'gpt-5' });
    ok(invalido1.status === 400, `claude+gpt-5 ⇒ 400 (achei ${invalido1.status})`);
    ok(JSON.parse(invalido1.texto).erro === 'escolha um modelo da lista', 'mensagem exata do 400');
    ok(!invalido1.texto.includes('gpt-5'), 'e o texto não ecoa "gpt-5"');

    const invalido2 = await pedir(porta, '/api/abas', 'POST', { projeto: 'projeto-gate', agente: 'claude', modelo: 'opus; rm -rf ~' });
    ok(invalido2.status === 400, `claude+'opus; rm -rf ~' ⇒ 400 (achei ${invalido2.status})`);
    ok(!invalido2.texto.includes('rm -rf'), 'e o texto não ecoa "rm -rf"');

    const codexIgnora = await pedir(porta, '/api/abas', 'POST', { projeto: 'projeto-gate', agente: 'codex', modelo: 'gpt-5' });
    ok(codexIgnora.status !== 400 && codexIgnora.status !== 201,
      `codex+modelo ⇒ nem 400 nem 201 (achei ${codexIgnora.status}: ${codexIgnora.texto})`);
    ok(!/modelo/i.test(JSON.parse(codexIgnora.texto).erro || ''), 'e o erro não fala de "modelo" — passou da validação');

    const claudeValido = await pedir(porta, '/api/abas', 'POST', { projeto: 'projeto-gate', agente: 'claude', modelo: 'fable' });
    ok(claudeValido.status !== 400 && claudeValido.status !== 201,
      `claude+fable ⇒ nem 400 nem 201 (achei ${claudeValido.status}: ${claudeValido.texto})`);
    ok(!/modelo/i.test(JSON.parse(claudeValido.texto).erro || ''), 'e o erro não fala de "modelo" — passou da validação');

    const semModelo = await pedir(porta, '/api/abas', 'POST', { projeto: 'projeto-gate', agente: 'claude' });
    ok(semModelo.status !== 400 && semModelo.status !== 201,
      `claude sem modelo ⇒ nem 400 nem 201 (achei ${semModelo.status}: ${semModelo.texto})`);

    for (const [nome, r2] of [['claude+gpt-5', invalido1], ["claude+'opus; rm -rf ~'", invalido2],
      ['codex+modelo', codexIgnora], ['claude+fable', claudeValido], ['claude sem modelo', semModelo]]) {
      ok(r2.status !== 201, `${nome}: NUNCA 201 — o isolamento quebrou se abriu aba`);
    }
  });

  // Fora do `withServer` (servidor já morto): o socket isolado nunca teve servidor tmux
  // iniciado — nenhum POST válido chegou a `new-window`.
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('tmux', ['-L', socket, 'ls'], { stdio: 'ignore' });
    ok(false, `tmux -L ${socket} ls NÃO deveria responder — um servidor tmux nasceu`);
  } catch {
    ok(true, `tmux -L ${socket} ls falhou, como esperado — nenhum servidor tmux nasceu`);
  }
}

(async () => {
  try {
    console.log('\n── Gate do campo Modelo da aba nova — offline + HTTP isolado ──');
    for (const { rotulo, fn } of grupos) {
      console.log(`\n  · ${rotulo}`);
      try {
        await fn();
      } catch (e) {
        ok(false, `o grupo estourou — ${e.message}`);
      }
    }
    await m8();
    console.log(`\n${tudoOk ? '✅ GATE VERDE — modelo-aba' : '❌ GATE VERMELHO — modelo-aba'}\n`);
  } finally {
    // `process.exit()` dentro do `try` pulava este `finally` e cada `npm test` deixava um
    // `/tmp/gate-modelo-aba-*` para trás (painel de execução, 06/10). Limpa ANTES de sair.
    fs.rmSync(RAIZ, { recursive: true, force: true });
  }
  process.exit(tudoOk ? 0 : 1);
})();
