#!/usr/bin/env node
// Print de CELULAR (390×844) do "Pra revisar" ACOMPANHANDO O JOB QUE TERMINA — card
// `pra-revisar-nao-atualiza-sozinho` (D76). Um comando só: sobe um servidor de teste isolado,
// monta a fixture, abre o Chromium do celular e MUDA O DISCO NO MEIO (vira um job de `running`
// para `done` com a página aberta) — o que nenhum outro print faz.
//
//   --espera nada     o defeito: o ícone fica em 6 e a lista aberta não ganha o job novo
//   --espera aparece  o conserto: o ícone vai a 7, a lista ganha o card e a rolagem fica no lugar
//
// O servidor sobe de uma árvore qualquer (`--arvore`), o que permite fotografar a base exportada
// com `git archive` e o conserto lado a lado, com a MESMA fixture.
//
// Uso:
//   node testes/print-revisar-transicao.mjs --arvore <dir com server.js> --saida <pasta NOVA> \
//        --rotulo ANTES|DEPOIS --espera nada|aparece [--porta 18931]
//
// Códigos de saída: 0 = os 4 PNGs e todas as exigências · 1 = alguma exigência reprovou (ou o teto
// de 180 s) · 2 = ambiente/uso.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const TETO_MS = 180000;

const o = { porta: 18931 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--arvore') o.arvore = path.resolve(argv[++i] || '');
  else if (argv[i] === '--saida') o.saida = path.resolve(argv[++i] || '');
  else if (argv[i] === '--rotulo') o.rotulo = argv[++i];
  else if (argv[i] === '--espera') o.espera = argv[++i];
  else if (argv[i] === '--porta') o.porta = Number(argv[++i]);
  else { console.error(`🔴 argumento desconhecido: ${argv[i]}`); process.exit(2); }
}
const USO = 'uso: --arvore DIR --saida PASTA --rotulo ANTES|DEPOIS --espera nada|aparece [--porta 18931]';
if (!o.arvore || !o.saida || !o.rotulo || !['nada', 'aparece'].includes(o.espera)) { console.error(`🔴 ${USO}`); process.exit(2); }
if (!/^[A-Za-z0-9_-]+$/.test(o.rotulo)) { console.error('🔴 --rotulo só aceita letras, números, _ e -'); process.exit(2); }
if (!Number.isInteger(o.porta) || o.porta < 1024) { console.error('🔴 porta inválida'); process.exit(2); }
if (o.porta === 7879 || o.porta === 7899 || (o.porta >= 7891 && o.porta <= 7898)) {
  console.error('🔴 porta reservada (7879 produção, 7899 jobs, 7891-7898 gates) — use a 18931'); process.exit(2);
}
if (!fs.existsSync(path.join(o.arvore, 'server.js'))) { console.error(`🔴 ${o.arvore} não tem server.js`); process.exit(2); }
if (fs.existsSync(o.saida) && fs.readdirSync(o.saida).some((n) => n.endsWith('.png'))) {
  console.error(`🔴 ${o.saida} já tem PNG — use uma pasta nova`); process.exit(2);
}
try {
  const ocupadas = execFileSync('ss', ['-H', '-lptn'], { stdio: 'pipe' }).toString('utf8');
  if (ocupadas.split('\n').some((l) => l.trim().split(/\s+/)[3]?.endsWith(`:${o.porta}`))) {
    console.error(`🔴 porta ${o.porta} ocupada`); process.exit(2);
  }
} catch { /* sem `ss`: segue — o servidor falha sozinho se a porta estiver ocupada */ }
try {
  execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
} catch {
  console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`); process.exit(2);
}

// ─── Fixture ────────────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'print-transicao-'));
const casa = path.join(tmp, 'casa');
const jobsDir = path.join(tmp, 'jobs');
const scratch = path.join(tmp, 'scratch');
const outDir = path.join(tmp, 'out');
for (const d of [casa, jobsDir, scratch, outDir, path.join(tmp, 'wt'), path.join(tmp, 'repos')]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(outDir, 0o777);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Cenario Transicao', GIT_AUTHOR_EMAIL: 'cenario-transicao@localhost',
  GIT_COMMITTER_NAME: 'Cenario Transicao', GIT_COMMITTER_EMAIL: 'cenario-transicao@localhost',
};
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, stdio: 'pipe' }).toString('utf8');

// main + develop iguais; branch `feat-<x>` com um commit à frente da develop.
function montarRepo(x) {
  const dir = path.join(tmp, 'repos', x);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main', '-q']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['commit', '-q', '-m', 'inicial']);
  git(dir, ['branch', 'develop']);
  git(dir, ['checkout', '-q', '-b', `feat-${x}`, 'develop']);
  fs.writeFileSync(path.join(dir, `${x}.txt`), `feito em ${x}\n`);
  git(dir, ['add', `${x}.txt`]);
  git(dir, ['commit', '-q', '-m', `feito em ${x}`]);
  git(dir, ['checkout', '-q', 'develop']);
  return dir;
}

const RESULT = 'done: fixture da transição.\n\n## Smoke pra o dono\nNada a testar à mão: fixture.\n';
const ID = {
  Z1: '20261009-130001-z1-pronto-0001', Z2: '20261009-130002-z2-pronto-0002', Z3: '20261009-130003-z3-pronto-0003',
  Z4: '20261009-130004-z4-pronto-0004', Z5: '20261009-130005-z5-pronto-0005', Z6: '20261009-130006-z6-pronto-0006',
  X: '20261009-150001-x-termina-0007', Y: '20261009-150002-y-termina-0008', W: '20261009-150003-w-termina-0009',
};
const TITULO = {
  Z1: 'Job Z1 já terminado', Z2: 'Job Z2 já terminado', Z3: 'Job Z3 já terminado',
  Z4: 'Job Z4 já terminado', Z5: 'Job Z5 já terminado', Z6: 'Job Z6 já terminado',
  X: 'Job X termina com a página aberta', Y: 'Job Y termina com a lista aberta', W: 'Job W termina com a lista rolada',
};

function plantar(chave, i) {
  const x = chave.toLowerCase();
  const repo = montarRepo(x);
  const wt = path.join(tmp, 'wt', x);
  fs.mkdirSync(wt, { recursive: true });
  const pasta = path.join(jobsDir, ID[chave]);
  fs.mkdirSync(pasta, { recursive: true });
  const pronto = chave.startsWith('Z');
  const criado = new Date(Date.now() - (pronto ? (i + 1) * 3600e3 : 600e3)).toISOString();
  fs.writeFileSync(path.join(pasta, 'meta.json'), JSON.stringify({
    id: ID[chave], type: 'ataca', project: 'projeto-teste', title: TITULO[chave], origin: 'capitao',
    // Os terminados têm pid morto; os que vão terminar usam o pid deste script (vivo enquanto o print roda).
    status: pronto ? 'done' : 'running', pid: pronto ? 4194305 : process.pid,
    created_at: criado, source_repo: repo, worktree: wt, branch: `feat-${x}`,
  }, null, 2));
  if (pronto) {
    const fim = new Date(Date.now() - (i + 1) * 3600e3 + 60e3).toISOString();
    fs.writeFileSync(path.join(pasta, 'status.log'), `${criado} working: fixture\n${fim} done: ok\n`);
    fs.writeFileSync(path.join(pasta, 'result.md'), RESULT);
  } else {
    fs.writeFileSync(path.join(pasta, 'status.log'), `${criado} working: fixture\n`);
  }
}
// A montagem roda antes do `try`/`finally` do servidor: se um `git` falhar aqui, o tmp sai junto.
try {
  ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6'].forEach((c, i) => plantar(c, i));
  ['X', 'Y', 'W'].forEach((c, i) => plantar(c, i));
} catch (e) {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(`🔴 a fixture não montou: ${e.message}`); process.exit(2);
}

// Vira o job: `done: ok` no status.log + result.md. O processo continua vivo (pid deste script),
// então o que decide é o `done` do log — o mesmo caminho do fim feliz de um job de verdade.
function virar(chave) {
  const pasta = path.join(jobsDir, ID[chave]);
  fs.appendFileSync(path.join(pasta, 'status.log'), `${new Date().toISOString()} done: ok\n`);
  fs.writeFileSync(path.join(pasta, 'result.md'), RESULT);
}

// ─── Servidor ───────────────────────────────────────────────────────────────

const casaDir = (n) => path.join(casa, n);
for (const d of ['push', 'lidas', 'leituras', 'uso', 'usocodex', 'statuscodex', 'clearcodex', 'projetos', 'worktrees', 'monitor']) {
  fs.mkdirSync(casaDir(d), { recursive: true });
}
// Lista fechada: nenhuma COCKPIT_* herdada passa (#78); cada pasta aponta para dentro do HOME falso.
const env = {
  PATH: process.env.PATH, HOME: casa, HOST: '127.0.0.1', PORT: String(o.porta), COCKPIT_TOKEN: '',
  COCKPIT_CERT_DIR: '/dev/null', COCKPIT_VIGIA_MS: '0', COCKPIT_TMUX_SOCKET: `print-transicao-${process.pid}`,
  COCKPIT_JOBS_DIR: jobsDir,
  COCKPIT_PUSH_DIR: casaDir('push'), COCKPIT_LIDAS_DIR: casaDir('lidas'),
  COCKPIT_LEITURAS_DIR: casaDir('leituras'), COCKPIT_USO_DIR: casaDir('uso'),
  COCKPIT_USO_CODEX_DIR: casaDir('usocodex'), COCKPIT_STATUS_CODEX_DIR: casaDir('statuscodex'),
  COCKPIT_CLEAR_CODEX_DIR: casaDir('clearcodex'), COCKPIT_PROJETOS_DIR: casaDir('projetos'),
  COCKPIT_WORKTREES_DIR: casaDir('worktrees'),
  COCKPIT_MONITOR_DIR: casaDir('monitor'), COCKPIT_MONITOR_MS: '0',
  COCKPIT_DU_BIN: path.join(tmp, 'sem-du'), COCKPIT_DOCKER_BIN: path.join(tmp, 'sem-docker'),
};

let servidor = null;
let docker = null;
const nomeContainer = `print-transicao-${process.pid}`;
let logServidor = '';

function limpar() {
  if (docker && docker.exitCode === null) {
    docker.kill('SIGKILL');
    try { execFileSync('docker', ['rm', '-f', nomeContainer], { stdio: 'ignore' }); } catch { /* já foi */ }
  }
  if (servidor && servidor.exitCode === null) servidor.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function json(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  return { status: r.status, corpo: await r.json() };
}

// ─── Roteiro que roda DENTRO do container ───────────────────────────────────

function montarRoteiro() {
  return `'use strict';
const fs = require('node:fs');
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const ESPERA = process.env.ESPERA;
const ID_X = process.env.ID_X;
const ID_Y = process.env.ID_Y;
const ID_W = process.env.ID_W;
const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const problemas = [];
const feitos = [];
const confere = (cond, msg) => { (cond ? feitos : problemas).push(msg); return cond; };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

// Troca de mão com o host: pede \`virar-<x>\` e espera \`virou-<x>\` (no máximo 10 s).
async function virar(x) {
  fs.writeFileSync('/out/virar-' + x, '1');
  const limite = Date.now() + 10000;
  while (Date.now() < limite) {
    if (fs.existsSync('/out/virou-' + x)) return true;
    await dorme(100);
  }
  return false;
}

// Espera a condição (avaliada na página) por até 25 s — o tique real é 15 s; não se chama função interna.
async function esperar(pagina, fn, arg, ms) {
  const limite = Date.now() + (ms || 25000);
  while (Date.now() < limite) {
    if (await pagina.evaluate(fn, arg)) return true;
    await dorme(500);
  }
  return false;
}

const seloTexto = () => { const s = document.getElementById('revisar-conta'); return s ? s.textContent.trim() : ''; };
const temCard = (id) => Boolean(document.querySelector('#dialogo-revisar .rv-card[data-id="' + id + '"]'));
const dentroDaVista = (id) => {
  const c = document.querySelector('#dialogo-revisar .rv-card[data-id="' + id + '"]');
  if (!c) return false;
  const f = c.getBoundingClientRect();
  return f.top >= 0 && f.bottom <= window.innerHeight;
};
const titulos = () => [...document.querySelectorAll('#dialogo-revisar .rv-card')].map((c) => c.textContent.slice(0, 60));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const erros = [];
  try {
    const pagina = await navegador.newPage();
    await pagina.setViewport(VIEWPORT);
    await pagina.evaluateOnNewDocument(() => {
      try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* modo privado */ }
    });
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });

    // 1) o ícone com o selo em 6
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#btn-revisar', { timeout: 15000 });
    await dorme(1500);
    confere((await pagina.evaluate(seloTexto)) === '6', '1: o selo do ícone começa em 6');
    const noViewport = async () => pagina.evaluate(() => {
      const b = document.getElementById('btn-revisar').getBoundingClientRect();
      return b.top >= 0 && b.left >= 0 && b.bottom <= window.innerHeight && b.right <= window.innerWidth && b.width > 0;
    });
    if (!(await noViewport())) await pagina.evaluate(() => document.getElementById('btn-revisar').scrollIntoView({ block: 'center' }));
    confere(await noViewport(), '1: o ícone Pra revisar está dentro do viewport 390x844');
    await pagina.screenshot({ path: '/out/1-icone-antes.png' });

    // 2) o job X termina com a página aberta
    confere(await virar('x'), '2: o host virou o job X');
    if (ESPERA === 'aparece') {
      confere(await esperar(pagina, () => { const s = document.getElementById('revisar-conta'); return s && s.textContent.trim() === '7'; }, null, 25000),
        '2: o selo foi a 7 sem recarregar a página');
    } else {
      await dorme(25000);
      confere((await pagina.evaluate(seloTexto)) === '6', '2: o selo continua em 6 depois de 25 s (o defeito)');
    }
    await pagina.screenshot({ path: '/out/2-icone-depois.png' });

    // 3) abre a lista — a abertura sempre relê, nos dois lados
    await pagina.click('#btn-revisar');
    await pagina.waitForSelector('#dialogo-revisar[open]', { timeout: 5000 });
    await pagina.waitForSelector('#dialogo-revisar .rv-card', { timeout: 15000 });
    confere(await esperar(pagina, temCard, ID_X, 10000), '3: a lista aberta tem o card do Job X');
    await dorme(300);
    await pagina.screenshot({ path: '/out/3-lista-antes.png' });

    // 4) o job Y termina com a lista aberta
    confere(await virar('y'), '4: o host virou o job Y');
    const apareceuY = await esperar(pagina, temCard, ID_Y, 25000);
    if (ESPERA === 'aparece') {
      confere(apareceuY, '4: o card do Job Y apareceu na lista aberta, sem tocar em nada');
      await pagina.evaluate((id) => {
        const c = document.querySelector('#dialogo-revisar .rv-card[data-id="' + id + '"]');
        if (c) c.scrollIntoView({ block: 'nearest' });
      }, ID_Y);
      await dorme(300);
      confere(await pagina.evaluate(dentroDaVista, ID_Y), '4: o card do Job Y está dentro do viewport');
    } else {
      confere(!apareceuY, '4: o card do Job Y NÃO apareceu em 25 s (o defeito)');
      const carregando = await pagina.evaluate(() => document.getElementById('dialogo-revisar').textContent.includes('Carregando'));
      confere(!carregando, '4: a tela não está em "Carregando…"');
    }
    feitos.push('4: cards na lista: ' + JSON.stringify(await pagina.evaluate(titulos)));
    await pagina.screenshot({ path: '/out/4-lista-depois.png' });

    // 5) a rolagem não volta ao topo quando a lista é relida em silêncio
    if (ESPERA === 'aparece') {
      const antes = await pagina.evaluate(() => {
        const c = document.querySelector('#dialogo-revisar .rv-corpo');
        if (!c) return -1;
        c.scrollTop = c.scrollHeight;
        return c.scrollTop;
      });
      feitos.push('5: scrollTop antes = ' + antes);
      confere(antes > 0, '5: a lista rola de verdade (scrollTop > 0)');
      confere(await virar('w'), '5: o host virou o job W');
      confere(await esperar(pagina, temCard, ID_W, 25000), '5: o card do Job W entrou na lista');
      const depois = await pagina.evaluate(() => {
        const c = document.querySelector('#dialogo-revisar .rv-corpo');
        return c ? c.scrollTop : -1;
      });
      feitos.push('5: scrollTop depois = ' + depois);
      confere(depois >= 0 && Math.abs(depois - antes) <= 2, '5: o scrollTop do .rv-corpo novo está a no máximo 2 px do anterior');
    }
    if (erros.length) feitos.push('console (anotado, não reprova): ' + erros.slice(0, 3).join(' | '));
  } finally {
    await navegador.close();
  }
})().then(() => {
  console.log('@@PRINT-TRANSICAO@@' + JSON.stringify({ feitos, problemas }));
}).catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  console.log('@@PRINT-TRANSICAO@@' + JSON.stringify({ feitos, problemas: problemas.concat(['roteiro estourou: ' + e.message]) }));
  process.exitCode = 1;
});
`;
}

// ─── Corrida ────────────────────────────────────────────────────────────────

let codigo = 1;
try {
  servidor = spawn(process.execPath, [path.join(o.arvore, 'server.js')], { cwd: o.arvore, env, stdio: ['ignore', 'pipe', 'pipe'] });
  servidor.stdout.on('data', (d) => { logServidor += d; });
  servidor.stderr.on('data', (d) => { logServidor += d; });

  const BASE = `http://127.0.0.1:${o.porta}`;
  let no = false;
  for (let t = 0; t < 20 && !no; t += 1) {
    if (servidor.exitCode !== null) break;
    try { no = (await json(`${BASE}/api/jobs`)).status === 200; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!no) { console.error(`🔴 o servidor de ${o.arvore} não respondeu em 4 s:\n${logServidor}`); codigo = 2; throw new Error('sem servidor'); }

  const rev = await json(`${BASE}/api/jobs?revisar=1`);
  if (!rev.corpo || !Array.isArray(rev.corpo.jobs) || rev.corpo.jobs.length !== 6) {
    console.error(`🔴 cenário não montado: esperava 6 jobs em ?revisar=1\n${JSON.stringify(rev.corpo).slice(0, 1500)}`);
    codigo = 2; throw new Error('cenário');
  }
  const tudo = await json(`${BASE}/api/jobs?tudo=1`);
  const rodando = ((tudo.corpo && tudo.corpo.jobs) || []).filter((j) => j.estado === 'running').map((j) => j.id);
  for (const c of ['X', 'Y', 'W']) {
    if (!rodando.includes(ID[c])) {
      console.error(`🔴 cenário não montado: o Job ${c} não está running em ?tudo=1 (running: ${rodando.join(', ') || 'nenhum'})`);
      codigo = 2; throw new Error('cenário');
    }
  }
  console.log('  · rota: 6 jobs prontos em ?revisar=1; X, Y e W em running');

  fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro(), { mode: 0o600 });
  const vistos = new Set();
  const vigia = setInterval(() => {
    for (const x of ['x', 'y', 'w']) {
      if (vistos.has(x) || !fs.existsSync(path.join(outDir, `virar-${x}`))) continue;
      vistos.add(x);
      virar(x.toUpperCase());
      fs.writeFileSync(path.join(outDir, `virou-${x}`), '1');
    }
  }, 200);

  let bruto = '';
  let estourou = false;
  const resultado = await new Promise((resolve) => {
    docker = spawn('docker', [
      'run', '--rm', '--name', nomeContainer, '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${BASE}`, '-e', `ESPERA=${o.espera}`,
      '-e', `ID_X=${ID.X}`, '-e', `ID_Y=${ID.Y}`, '-e', `ID_W=${ID.W}`,
      '-v', `${scratch}:/w:ro`, '-v', `${outDir}:/out`, IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    docker.stdout.on('data', (d) => { bruto += d; });
    docker.stderr.on('data', (d) => { bruto += d; });
    const teto = setTimeout(() => { estourou = true; limpar2(); }, TETO_MS);
    const limpar2 = () => {
      docker.kill('SIGKILL');
      try { execFileSync('docker', ['rm', '-f', nomeContainer], { stdio: 'ignore' }); } catch { /* já foi */ }
    };
    docker.on('close', (c) => { clearTimeout(teto); resolve(c); });
  });
  clearInterval(vigia);

  const marca = '@@PRINT-TRANSICAO@@';
  const abre = bruto.indexOf(marca);
  let relatorio = null;
  if (abre >= 0) { try { relatorio = JSON.parse(bruto.slice(abre + marca.length)); } catch { relatorio = null; } }
  process.stdout.write(abre >= 0 ? bruto.slice(0, abre) : bruto);
  if (!relatorio) relatorio = { feitos: [], problemas: [`o roteiro não devolveu JSON (código ${resultado})`] };
  if (estourou) relatorio.problemas.push(`teto de ${TETO_MS / 1000} s estourado`);
  for (const f of relatorio.feitos) console.log(`  ✅ ${f}`);
  for (const p of relatorio.problemas) console.error(`  ❌ ${p}`);

  const nomes = ['1-icone-antes', '2-icone-depois', '3-lista-antes', '4-lista-depois'];
  const faltam = nomes.filter((n) => !fs.existsSync(path.join(outDir, `${n}.png`)));
  if (relatorio.problemas.length || faltam.length) {
    console.error(`🔴 print REPROVADO${faltam.length ? ` (faltam: ${faltam.join(', ')})` : ''}`);
    codigo = 1;
  } else {
    fs.mkdirSync(o.saida, { recursive: true });
    for (const n of nomes) fs.copyFileSync(path.join(outDir, `${n}.png`), path.join(o.saida, `${o.rotulo}-${n}.png`));
    console.log(`✅ ${nomes.length} PNGs gravados em ${o.saida}`);
    codigo = 0;
  }
} catch (e) {
  if (codigo === 1) console.error(`🔴 ${e.message}`);
} finally {
  limpar();
}
process.exit(codigo);
