#!/usr/bin/env node
'use strict';
// GATE — criar pasta na aba nova (card `criar-pasta-na-aba-nova`), lado do SERVIDOR, por HTTP.
//
// Spec: docs/superpowers/specs/2026-10-08-criar-pasta-na-aba-nova-design.md (§4, §6.1)
// Plano: docs/superpowers/plans/2026-10-08-criar-pasta-na-aba-nova-plano.md (Fase 1)
//
// Sobe `server.js` FILHO numa porta livre (molde do `withServer` de `gate-modelo-aba.js`), com o
// ambiente por LISTA FECHADA (#78/#82): HOME falso e cada COCKPIT_*_DIR dentro de um mkdtemp, monitor e
// vigia sem relógio. A raiz de projetos mora SEMPRE dentro desse mkdtemp — nunca na pasta de projetos
// de verdade (guarda R6, em `withServer`).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-criar-pasta-'));
let tudoOk = true;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) tudoOk = false; return c; };

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// `agent: false`: um socket por pedido, sem keep-alive — o P15 precisa de dois pedidos EM VOO de verdade.
function pedir(porta, rota, metodo, corpo, cabecalhos = {}) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const cab = { ...cabecalhos };
    if (dados !== null) { cab['content-type'] = 'application/json'; cab['content-length'] = Buffer.byteLength(dados); }
    const req = http.request({ hostname: '127.0.0.1', port: porta, path: rota, method: metodo, headers: cab, agent: false }, (res) => {
      let texto = '';
      res.on('data', (d) => { texto += d; });
      res.on('end', () => resolve({ status: res.statusCode, texto }));
    });
    req.on('error', reject);
    req.end(dados === null ? undefined : dados);
  });
}
const criar = (porta, nome, cab) => pedir(porta, '/api/projetos', 'POST', { nome }, cab);

/** Uma pasta de caso: `<caso>/projetos` é a raiz. Devolve os dois caminhos. */
function novoCaso({ criarRaiz = true } = {}) {
  const caso = fs.mkdtempSync(path.join(RAIZ, 'caso-'));
  const projetos = path.join(caso, 'projetos');
  if (criarRaiz) fs.mkdirSync(projetos);
  return { caso, projetos };
}

async function withServer({ projetosDir, token = '' }, tarefa) {
  // Guarda R6: PREFIXO, não existência — o caso C aponta para uma raiz que não existe de propósito.
  if (!path.resolve(projetosDir).startsWith(RAIZ + path.sep)) {
    console.error(`🔴 COCKPIT_PROJETOS_DIR fora do temporário do gate (${projetosDir}) — recuso rodar`);
    process.exit(2);
  }
  const root = path.resolve(__dirname, '..');
  const porta = await portaLivre();
  const tmp = fs.mkdtempSync(path.join(RAIZ, 'srv-'));
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete base[k];
  Object.assign(base, {
    HOME: path.join(tmp, 'home'), HOST: '127.0.0.1', PORT: String(porta),
    COCKPIT_CERT_DIR: '/dev/null',                       // #19: HTTP puro
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_JOBS_DIR: path.join(tmp, 'jobs'),            // A10 do gate-jobs-disco
    COCKPIT_MONITOR_DIR: path.join(tmp, 'monitor'), COCKPIT_MONITOR_MS: '0',   // M-rede (#82)
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(tmp, 'push'),
    COCKPIT_LIDAS_DIR: path.join(tmp, 'lidas'),
    COCKPIT_LEITURAS_DIR: path.join(tmp, 'leituras'),
    COCKPIT_DU_BIN: path.join(tmp, 'sem-du'), COCKPIT_DOCKER_BIN: path.join(tmp, 'sem-docker'),
    COCKPIT_TMUX_SOCKET: `cockpit-gate-pasta-${process.pid}`,
    COCKPIT_TMUX_SESSAO: `nao-existe-${process.pid}`,
    COCKPIT_BIN_CLAUDE: '/usr/bin/claude', COCKPIT_BIN_CODEX: '/usr/bin/codex',
  });
  if (token) base.COCKPIT_TOKEN = token;
  fs.mkdirSync(base.HOME);
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: base, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout servidor')), 10000);
      child.stdout.on('data', (d) => { if (String(d).includes('cockpit-agentes em')) { clearTimeout(t); resolve(); } });
      child.once('exit', (codigo) => { clearTimeout(t); reject(new Error(`servidor saiu ${codigo}`)); });
    });
    await tarefa(porta);
  } finally {
    // #24: o filho morre pelo pid exato, com sucesso ou falha.
    if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
  }
}

const listar = (dir) => fs.readdirSync(dir).sort();

async function servidorA() {
  console.log('\n  · A — raiz temporária, sem token (P1–P11, P15)');
  const { caso, projetos } = novoCaso();
  fs.mkdirSync(path.join(projetos, 'Coração'));
  fs.mkdirSync(path.join(projetos, 'app'));
  fs.writeFileSync(path.join(projetos, 'arquivo-solto'), 'x');
  await withServer({ projetosDir: projetos }, async (porta) => {
    const p1 = await criar(porta, 'Meu-Projeto');
    ok(p1.status === 201, `P1: Meu-Projeto ⇒ 201 (achei ${p1.status}: ${p1.texto})`);
    ok(p1.texto === '{"nome":"Meu-Projeto"}', `P1: o corpo é só o nome (${p1.texto})`);
    const nova = path.join(projetos, 'Meu-Projeto');
    ok(fs.existsSync(nova) && fs.statSync(nova).isDirectory(), 'P1: a pasta existe e é diretório');
    ok(fs.existsSync(nova) && fs.readdirSync(nova).length === 0, 'P1: e nasce VAZIA — sem .git, sem CLAUDE.md');
    ok(!p1.texto.includes(RAIZ) && !p1.texto.includes('/'), 'P2: a resposta não leva caminho (#22)');

    const p3 = await pedir(porta, '/api/projetos', 'GET');
    ok(p3.status === 200 && JSON.parse(p3.texto).projetos.some((p) => p.nome === 'Meu-Projeto'), 'P3: o GET já lista Meu-Projeto');

    for (const [rotulo, nome] of [['P4 de novo', 'Meu-Projeto'], ['P5 outra caixa', 'meu-projeto'], ['P6 sem acento', 'Coracao']]) {
      const r = await criar(porta, nome);
      ok(r.status === 409, `${rotulo}: ${nome} ⇒ 409 (achei ${r.status}: ${r.texto})`);
    }

    const ruins = ['', 'a/b', '..', '.oculta', 'a.b', 'a b', '-x', '_x', 'ção', 'x'.repeat(65), '../fora', 'a\\b'];
    for (const nome of ruins) {
      const r = await criar(porta, nome);
      ok(r.status === 400, `P7: ${JSON.stringify(nome)} ⇒ 400 (achei ${r.status})`);
    }
    for (const [rotulo, corpo] of [['sem nome', {}], ['nome número', { nome: 123 }], ['corpo null', 'null'], ['JSON inválido', '{nao json']]) {
      const r = await pedir(porta, '/api/projetos', 'POST', corpo);
      ok(r.status === 400, `P8: ${rotulo} ⇒ 400, nunca 500 (achei ${r.status})`);
    }

    const p9 = await criar(porta, 'x'.repeat(64));
    ok(p9.status === 201, `P9: 64 caracteres ⇒ 201 (achei ${p9.status})`);
    const p10 = await criar(porta, 'arquivo-solto');
    ok(p10.status === 409, `P10: nome de ARQUIVO que já existe ⇒ 409 (achei ${p10.status})`);

    const esperado = ['Coração', 'Meu-Projeto', 'app', 'arquivo-solto', 'x'.repeat(64)].sort();
    ok(JSON.stringify(listar(projetos)) === JSON.stringify(esperado), `P11: a raiz tem só o esperado (${listar(projetos).join(', ')})`);
    ok(JSON.stringify(listar(caso)) === '["projetos"]', `P11: nada escapou para o pai da raiz (${listar(caso).join(', ')})`);

    // P15 — S16: dois pedidos simultâneos com caixa diferente. Vinte pares, cada um com nome próprio.
    let pares = 0;
    let duplos = 0;
    for (let i = 1; i <= 20; i += 1) {
      const [r1, r2] = await Promise.all([criar(porta, `Dup-${i}`), criar(porta, `dup-${i}`)]);
      const codigos = [r1.status, r2.status].sort().join('+');
      const nascidas = [`Dup-${i}`, `dup-${i}`].filter((n) => fs.existsSync(path.join(projetos, n))).length;
      if (codigos === '201+409' && nascidas === 1) pares += 1;
      if (codigos === '201+201') duplos += 1;
    }
    ok(pares === 20, `P15: 20 pares simultâneos ⇒ um 201 e um 409, uma pasta só (certos: ${pares}; 201+201: ${duplos})`);
  });
}

async function servidorB() {
  console.log('\n  · B — com COCKPIT_TOKEN (P12–P13)');
  const { projetos } = novoCaso();
  await withServer({ projetosDir: projetos, token: 't' }, async (porta) => {
    const p12 = await criar(porta, 'sem-token');
    ok(p12.status === 401, `P12: sem Authorization ⇒ 401 (achei ${p12.status})`);
    const p13 = await criar(porta, 'origem-estranha', { authorization: 'Bearer t', origin: 'http://evil.example' });
    ok(p13.status === 403, `P13: Origin de fora ⇒ 403 (achei ${p13.status})`);
    ok(listar(projetos).length === 0, `P12/P13: nada foi criado (${listar(projetos).join(', ')})`);
    const bom = await criar(porta, 'com-token', { authorization: 'Bearer t' });
    ok(bom.status === 201, `B: com o token certo ⇒ 201 (achei ${bom.status})`);
  });
}

async function servidorC() {
  console.log('\n  · C — a raiz não existe (P14)');
  const { projetos } = novoCaso({ criarRaiz: false });
  await withServer({ projetosDir: projetos }, async (porta) => {
    const r = await criar(porta, 'qualquer');
    ok(r.status === 500, `P14: raiz inexistente ⇒ 500 (achei ${r.status}: ${r.texto})`);
    ok(!r.texto.includes(RAIZ) && !r.texto.includes('/'), `P14: a mensagem não leva caminho (${r.texto})`);
    ok(!fs.existsSync(projetos), 'P14: e a raiz continua não existindo — sem mkdir recursivo');
  });
}

(async () => {
  try {
    console.log('\n── Gate de criar pasta na aba nova — servidor filho, HTTP ──');
    for (const fn of [servidorA, servidorB, servidorC]) {
      try { await fn(); } catch (e) { ok(false, `${fn.name} estourou — ${e.message}`); }
    }
    console.log(`\n${tudoOk ? '✅ GATE VERDE — criar-pasta' : '❌ GATE VERMELHO — criar-pasta'}\n`);
  } finally {
    fs.rmSync(RAIZ, { recursive: true, force: true });
  }
  process.exit(tudoOk ? 0 : 1);
})();
