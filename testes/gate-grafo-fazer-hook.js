#!/usr/bin/env node
'use strict';
// GATE da rota POST /api/grafos/fazer — hook, concorrência e janela do commit. Spec/plano
// `2026-10-17-grafo-botao-fazer-grafo` (Fase 2). Porta **7944**. Separado de `gate-grafo-fazer.js`
// (porta 7942) pelo teto DURO de 120 s: aqui a geração é deliberadamente lenta
// (`COCKPIT_GRAFO_TESTE_LENTO`) para fotografar `gerando` e a janela entre hook e `gerar`.
//
//   node testes/gate-grafo-fazer-hook.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

const RAIZ_REPO = path.resolve(__dirname, '..');
const PORTA = 7944;

let passou = 0;
let total = 0;
let vermelho = false;

function ok(cond, msg) {
  total += 1;
  if (cond) { passou += 1; console.log(`  ✅ ${msg}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${msg}`);
  return false;
}
async function bloco(nome, fn) {
  console.log(`\n${nome}`);
  try { await fn(); } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.stack}`);
  }
}
function esperarMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function esperarAsync(cond, tetoMs, intervaloMs = 50) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - t0 >= tetoMs) return await cond();
    await esperarMs(intervaloMs);
  }
}

// ─── Isolamento NO TOPO (#111) ──────────────────────────────────────────────
const LOJA_REAL = path.join(os.userInfo().homedir, '.cockpit', 'grafos');
const COPIA_REAL = path.join(os.userInfo().homedir, '.cockpit', 'grafo-gerador');
const listarReal = (p) => { try { return fs.readdirSync(p).sort(); } catch { return null; } };
const LOJA_REAL_ANTES = listarReal(LOJA_REAL);
// A guarda olha DENTRO de `versoes/`: depois do primeiro toque em produção a raiz só lista `versoes`, e uma
// versão vazada passaria calada (painel de execução, rodada 2).
const COPIA_REAL_ANTES = listarReal(path.join(COPIA_REAL, 'versoes'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-fazer-hook-'));
process.env.HOME = path.join(TMP, 'home');
process.env.COCKPIT_GRAFOS_DIR = path.join(TMP, 'grafos');
process.env.COCKPIT_GRAFO_COPIA_DIR = path.join(TMP, 'copia');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.COCKPIT_GRAFOS_DIR, { recursive: true });
fs.mkdirSync(process.env.COCKPIT_GRAFO_COPIA_DIR, { recursive: true });

// ─── git de fixture ─────────────────────────────────────────────────────────

function git(repo, args, envExtra) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=gate', '-c', 'user.email=gate@example.com', ...args], {
    encoding: 'utf8', env: { ...process.env, ...(envExtra || {}) },
  });
}
function novoRepo(projetosDir, nome, branchInicial) {
  const repo = path.join(projetosDir, nome);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', branchInicial || 'develop']);
  return repo;
}
function escreverEComitar(repo, arquivos, msg, envExtra) {
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(repo, nome)), { recursive: true });
    fs.writeFileSync(path.join(repo, nome), conteudo);
  }
  git(repo, ['add', ...Object.keys(arquivos)], envExtra);
  git(repo, ['commit', '-q', '-m', msg], envExtra);
  return git(repo, ['rev-parse', 'HEAD'], envExtra).trim();
}

// ─── release simulada (sem .git) ────────────────────────────────────────────

function montarRelease(destino) {
  const lista = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: RAIZ_REPO, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  for (const rel of lista) {
    if (!/^(server\.js|package\.json|lib\/|bin\/|public\/)/.test(rel)) continue;
    const origem = path.join(RAIZ_REPO, rel);
    const alvo = path.join(destino, rel);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    try { fs.copyFileSync(origem, alvo); } catch { /* arquivo sumiu entre o ls-files e a cópia */ }
  }
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

function pedir(rota, metodo = 'GET', cabecalhos = {}, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const cab = { ...cabecalhos };
    if (dados !== null) { cab['content-type'] = 'application/json'; cab['content-length'] = Buffer.byteLength(dados); }
    const req = http.request({ hostname: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers: cab, agent: false }, (res) => {
      const pedacos = [];
      res.on('data', (d) => pedacos.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(pedacos).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(dados === null ? undefined : dados);
  });
}

function confereLivre() {
  let saida = '';
  try { saida = execSync('ss -H -lptn', { encoding: 'utf8' }); } catch { return; }
  if (new RegExp(`:${PORTA}\\b`).test(saida)) {
    console.error(`porta ${PORTA} ocupada — o gate não pode rodar\n${saida}`);
    process.exit(1);
  }
}

let contadorServidor = 0;
async function withServer({ codigoDir, projetosDir, grafosDir, copiaDir, token, extraEnv }, tarefa) {
  confereLivre();
  contadorServidor += 1;
  const n = contadorServidor;
  const tmp = fs.mkdtempSync(path.join(TMP, `srv-${n}-`));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
    COCKPIT_CERT_DIR: '/dev/null',
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_GRAFOS_DIR: grafosDir,
    COCKPIT_GRAFO_COPIA_DIR: copiaDir,
    COCKPIT_JOBS_DIR: path.join(tmp, 'jobs'),
    COCKPIT_MONITOR_DIR: path.join(tmp, 'monitor'), COCKPIT_MONITOR_MS: '0',
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(tmp, 'push'),
    COCKPIT_LIDAS_DIR: path.join(tmp, 'lidas'),
    COCKPIT_LEITURAS_DIR: path.join(tmp, 'leituras'),
    COCKPIT_TMUX_SOCKET: `gate-grafo-fazer-hook-${process.pid}-${n}`,
    COCKPIT_DU_BIN: path.join(tmp, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(tmp, 'sem-docker'),
    ...(extraEnv || {}),
  };
  if (token) env.COCKPIT_TOKEN = token;
  const logPath = path.join(TMP, `servidor-${n}.log`);
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [path.join(codigoDir, 'server.js')], { cwd: codigoDir, env, stdio: ['ignore', logFd, logFd] });
  try {
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`servidor saiu antes do /health (rc=${child.exitCode}) — ver ${logPath}`);
      try { const r = await pedir('/health', 'GET'); if (r.status === 200) break; } catch { /* ainda subindo */ }
      if (Date.now() - t0 > 10000) throw new Error(`timeout esperando /health — ver ${logPath}`);
      await esperarMs(100);
    }
    await tarefa(child);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
    fs.closeSync(logFd);
  }
}

function linhasFazer(grafosDir, nome) {
  try {
    const log = fs.readFileSync(path.join(grafosDir, nome, 'atualizar.log'), 'utf8');
    return (log.match(/fazer: início/g) || []).length;
  } catch { return 0; }
}
function metaSha(grafosDir, nome) {
  try { return JSON.parse(fs.readFileSync(path.join(grafosDir, nome, 'meta.json'), 'utf8')).gitCommitHash; }
  catch { return null; }
}

async function principal() {

const projetosDir = path.join(TMP, 'projetos');
fs.mkdirSync(projetosDir, { recursive: true });
const grafosDir = process.env.COCKPIT_GRAFOS_DIR;
const copiaDir = process.env.COCKPIT_GRAFO_COPIA_DIR;
const TOKEN = 'tok-gate';
const cab = { authorization: `Bearer ${TOKEN}` };

const appExemplo = novoRepo(projetosDir, 'app-exemplo', 'develop');
escreverEComitar(appExemplo, { 'a.js': 'export function f() {}\n' }, 'c1');
const appLento = novoRepo(projetosDir, 'app-lento', 'develop');
escreverEComitar(appLento, { 'a.js': 'export function f() {}\n' }, 'c1');
const appDois = novoRepo(projetosDir, 'app-dois', 'develop');
escreverEComitar(appDois, { 'a.js': 'export function f() {}\n' }, 'c1');

let codigoDir = path.join(TMP, 'release');
montarRelease(codigoDir);

// ─── 1. Release que some ────────────────────────────────────────────────────

await bloco('1. Release que some — os hooks gravam a VERSÃO da cópia, não a release; o hook vive sem ela', async () => {
  await withServer({ codigoDir, projetosDir, grafosDir, copiaDir, token: TOKEN }, async () => {
    const r = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-exemplo' });
    ok(r.status === 200, `POST app-exemplo → 200 (achei ${r.status}: ${r.corpo})`);
    for (const h of ['post-commit', 'post-merge', 'post-rewrite', 'reference-transaction']) {
      const conteudo = fs.readFileSync(path.join(appExemplo, '.git', 'hooks', h), 'utf8');
      ok(conteudo.includes(path.join(copiaDir, 'versoes')), `${h}: contém ${path.join(copiaDir, 'versoes')}`);
      ok(conteudo.includes(`COCKPIT_GRAFOS_DIR='${grafosDir}'`), `${h}: contém COCKPIT_GRAFOS_DIR='${grafosDir}'`);
      ok(!conteudo.includes(codigoDir), `${h}: NÃO contém o caminho da release (${codigoDir})`);
    }
  });
  // servidor já derrubado (finally do withServer) — agora some com a release.
  fs.rmSync(codigoDir, { recursive: true, force: true });
  const shaNovo = escreverEComitar(appExemplo, { 'a.js': 'export function f() {} // v2\n' }, 'c2');
  const assentou = await esperarAsync(() => metaSha(grafosDir, 'app-exemplo') === shaNovo, 15000, 100);
  ok(assentou, `o hook vive sem a release: meta.json chega ao sha novo em até 15 s (shaNovo=${shaNovo}, achei ${metaSha(grafosDir, 'app-exemplo')})`);
  // recriar pro resto do gate.
  montarRelease(codigoDir);
});

// ─── 2. Dois POSTs simultâneos + gerando ────────────────────────────────────

await bloco('2. Dois POSTs simultâneos — um processo só, gerando aparece no meio', async () => {
  await withServer({ codigoDir, projetosDir, grafosDir, copiaDir, token: TOKEN, extraEnv: { COCKPIT_GRAFO_TESTE_LENTO: '3000' } }, async () => {
    const p1 = pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-lento' });
    const p2 = pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-lento' });
    const achouGerando = await esperarAsync(async () => {
      const rGet = await pedir('/api/grafos', 'GET', cab);
      const item = JSON.parse(rGet.corpo).projetos.find((p) => p.nome === 'app-lento');
      return Boolean(item && item.gerando);
    }, 2000, 50);
    ok(achouGerando, 'GET no meio mostra app-lento com gerando === true');
    const [r1, r2] = await Promise.all([p1, p2]);
    ok(r1.status === 200 && r2.status === 200, `os dois POSTs → 200 (achei ${r1.status}, ${r2.status})`);
    ok(linhasFazer(grafosDir, 'app-lento') === 1, `linhasFazer === 1 — um processo gerar só (achei ${linhasFazer(grafosDir, 'app-lento')})`);
    const rGetDepois = await pedir('/api/grafos', 'GET', cab);
    const itemDepois = JSON.parse(rGetDepois.corpo).projetos.find((p) => p.nome === 'app-lento');
    ok(!(itemDepois && itemDepois.gerando), `GET depois sem gerando (achei ${JSON.stringify(itemDepois)})`);
  });
});

// ─── 3. Commit na janela ────────────────────────────────────────────────────

await bloco('3. Commit na janela — hook já instalado com o gerar em andamento e o POST ainda pendente', async () => {
  await withServer({ codigoDir, projetosDir, grafosDir, copiaDir, token: TOKEN, extraEnv: { COCKPIT_GRAFO_TESTE_LENTO: '3000' } }, async () => {
    let respondeu = false;
    const p = pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-dois' }).then((r) => { respondeu = true; return r; });
    const comecou = await esperarAsync(() => linhasFazer(grafosDir, 'app-dois') === 1, 5000, 50);
    ok(comecou, `o gerar começou — linhasFazer === 1 (achei ${linhasFazer(grafosDir, 'app-dois')})`);
    ok(respondeu === false, 'nesse instante o POST ainda não respondeu (geração em andamento)');
    let hookConteudo = '';
    try { hookConteudo = fs.readFileSync(path.join(appDois, '.git', 'hooks', 'post-commit'), 'utf8'); } catch { /* vazio — o ok abaixo reprova */ }
    ok(hookConteudo.includes('cockpit-grafo'), 'o hook JÁ está instalado antes do gerar terminar (T4: hook antes do gerar)');

    const shaNovo = escreverEComitar(appDois, { 'a.js': 'export function f() {} // v2\n' }, 'c2-durante-gerar');
    const r = await p;
    ok(r.status === 200, `o POST original termina 200 (achei ${r.status}: ${r.corpo})`);

    const assentou = await esperarAsync(() => metaSha(grafosDir, 'app-dois') === shaNovo, 20000, 100);
    ok(assentou, `a loja chega ao sha do commit novo SEM outro POST (shaNovo=${shaNovo}, achei ${metaSha(grafosDir, 'app-dois')})`);
  });
});

// ─── 4. Fim — loja/cópia reais, porta ───────────────────────────────────────

await bloco('4. Fim', () => {
  ok(JSON.stringify(listarReal(LOJA_REAL)) === JSON.stringify(LOJA_REAL_ANTES), `a loja REAL (${LOJA_REAL}) não ganhou nem perdeu nada`);
  // Igual ao COMEÇO, não "ausente": depois do primeiro toque em produção a cópia real existe de verdade
  // (painel de execução, Codex) — exigir ausência derrubaria o npm test pra sempre.
  ok(JSON.stringify(listarReal(path.join(COPIA_REAL, 'versoes'))) === JSON.stringify(COPIA_REAL_ANTES), `a cópia REAL (${COPIA_REAL}) não ganhou nem perdeu versão`);
  let saida = '';
  try { saida = execSync('ss -H -lptn', { encoding: 'utf8' }); } catch { /* ignore */ }
  ok(!new RegExp(`:${PORTA}\\b`).test(saida), `porta ${PORTA} livre no fim`);
});

console.log(`\n${passou}/${total} asserções`);
console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — hook, concorrência e janela do commit');
process.exitCode = vermelho ? 1 : 0;

}

principal();
