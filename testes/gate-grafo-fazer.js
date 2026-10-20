#!/usr/bin/env node
'use strict';
// GATE da rota POST /api/grafos/fazer — validação, falhas, prazo, aviso e catálogo de mensagens.
// Spec/plano `2026-10-17-grafo-botao-fazer-grafo` (Fase 2). Porta **7942**. Separado de
// `gate-grafo-fazer-hook.js` (porta 7944) pelo teto DURO de 120 s (`bin/testes.js`): os casos que
// esperam hook em background ou geração lenta moram lá. Release simulada (`git ls-files -co` pra
// uma pasta SEM `.git`) prova que a rota não depende de rodar numa worktree.
//
//   node testes/gate-grafo-fazer.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { execFileSync, execSync, spawn, spawnSync } = require('node:child_process');

const RAIZ_REPO = path.resolve(__dirname, '..');
const PORTA = 7942;
const grafoFazerLib = require(path.join(RAIZ_REPO, 'lib', 'grafo-fazer.js'));

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

// ─── Isolamento NO TOPO (#111) ──────────────────────────────────────────────
const LOJA_REAL = path.join(os.userInfo().homedir, '.cockpit', 'grafos');
const COPIA_REAL = path.join(os.userInfo().homedir, '.cockpit', 'grafo-gerador');
const listarReal = (p) => { try { return fs.readdirSync(p).sort(); } catch { return null; } };
const LOJA_REAL_ANTES = listarReal(LOJA_REAL);
// A guarda olha DENTRO de `versoes/`: depois do primeiro toque em produção a raiz só lista `versoes`, e uma
// versão vazada passaria calada (painel de execução, rodada 2).
const COPIA_REAL_ANTES = listarReal(path.join(COPIA_REAL, 'versoes'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-fazer-'));
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
function quebrarArvoreRaiz(repo) {
  const treeSha = git(repo, ['rev-parse', 'develop^{tree}']).trim();
  const obj = path.join(repo, '.git', 'objects', treeSha.slice(0, 2), treeSha.slice(2));
  fs.rmSync(obj, { force: true });
}

// ─── release simulada (sem .git) — prova que a rota não depende de worktree ─

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
/** Sobe `server.js` de `codigoDir` (a release simulada), env FECHADO, log em arquivo. Derruba pelo pid. */
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
    COCKPIT_CERT_DIR: '/dev/null', // #19: HTTP puro
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_GRAFOS_DIR: grafosDir, // #57/#62/#78: vence o HOME
    COCKPIT_GRAFO_COPIA_DIR: copiaDir,
    COCKPIT_JOBS_DIR: path.join(tmp, 'jobs'), // A10 do gate-jobs-disco
    COCKPIT_MONITOR_DIR: path.join(tmp, 'monitor'), COCKPIT_MONITOR_MS: '0', // M-rede (#82)
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(tmp, 'push'),
    COCKPIT_LIDAS_DIR: path.join(tmp, 'lidas'),
    COCKPIT_LEITURAS_DIR: path.join(tmp, 'leituras'),
    COCKPIT_TMUX_SOCKET: `gate-grafo-fazer-${process.pid}-${n}`,
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

async function principal() {

const projetosDir = path.join(TMP, 'projetos');
fs.mkdirSync(projetosDir, { recursive: true });
const grafosDir = process.env.COCKPIT_GRAFOS_DIR;
const copiaDir = process.env.COCKPIT_GRAFO_COPIA_DIR;
const TOKEN = 'tok-gate';
const cab = { authorization: `Bearer ${TOKEN}` };

const appExemplo = novoRepo(projetosDir, 'app-exemplo', 'develop');
escreverEComitar(appExemplo, { 'a.js': "import './b.js';\n", 'b.js': 'export function b() {}\n' }, 'c1');

const appQuebrado = novoRepo(projetosDir, 'app-quebrado', 'develop');
escreverEComitar(appQuebrado, { 'a.js': 'export function f() {}\n' }, 'c1');
quebrarArvoreRaiz(appQuebrado);

const appHookspath = novoRepo(projetosDir, 'app-hookspath', 'develop');
escreverEComitar(appHookspath, { 'a.js': 'export function f() {}\n' }, 'c1');
git(appHookspath, ['config', 'core.hooksPath', '.meus-hooks']);
// app-parcial: reference-transaction de TERCEIRO já existe — o instalador o deixa intocado (pulados) → aviso parcial.
const appParcial = novoRepo(projetosDir, 'app-parcial', 'develop');
escreverEComitar(appParcial, { 'a.js': 'export function f() {}\n' }, 'c1');
fs.writeFileSync(path.join(appParcial, '.git', 'hooks', 'reference-transaction'), '#!/bin/sh\n# hook de terceiro\nexit 0\n', { mode: 0o755 });

const appSemDevelop = novoRepo(projetosDir, 'app-sem-develop', 'main');
escreverEComitar(appSemDevelop, { 'a.js': 'export function f() {}\n' }, 'c1');

const appDois = novoRepo(projetosDir, 'app-dois', 'develop');
escreverEComitar(appDois, { 'a.js': 'export function f() {}\n' }, 'c1');
const appWt = path.join(projetosDir, 'app-wt');
git(appDois, ['worktree', 'add', '-q', '-b', 'feat-wt', appWt]);

fs.mkdirSync(path.join(projetosDir, 'nao-git'));

const appPrazo = novoRepo(projetosDir, 'app-prazo', 'develop');
escreverEComitar(appPrazo, { 'a.js': 'export function f() {}\n' }, 'c1');

const codigoDir = path.join(TMP, 'release');
montarRelease(codigoDir);
ok(!fs.existsSync(path.join(codigoDir, '.git')), 'release simulada sem .git');

// ─── 1. Acesso e validação ──────────────────────────────────────────────────

await bloco('1. Acesso e validação', async () => {
  await withServer({ codigoDir, projetosDir, grafosDir, copiaDir, token: TOKEN }, async () => {
    const semToken = await pedir('/api/grafos/fazer', 'POST', {}, { nome: 'app-exemplo' });
    ok(semToken.status === 401, `sem token → 401 (achei ${semToken.status})`);

    const origemErrada = await pedir('/api/grafos/fazer', 'POST', { ...cab, origin: 'http://outro.exemplo' }, { nome: 'app-exemplo' });
    ok(origemErrada.status === 403, `Origin de fora com token → 403 (achei ${origemErrada.status})`);

    for (const nomeRuim of [{ nome: '../x' }, { nome: 'a/b' }, { nome: '' }, {}]) {
      const r = await pedir('/api/grafos/fazer', 'POST', cab, nomeRuim);
      ok(r.status === 400, `corpo ${JSON.stringify(nomeRuim)} → 400 (achei ${r.status})`);
    }
    const rNaoJson = await pedir('/api/grafos/fazer', 'POST', cab, 'nao é json');
    ok(rNaoJson.status === 400, `corpo não-JSON → 400 (achei ${rNaoJson.status})`);

    const rNaoExiste = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'nao-existe' });
    ok(rNaoExiste.status === 404, `nome fora da lista → 404 (achei ${rNaoExiste.status})`);

    const rNaoGit = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'nao-git' });
    ok(rNaoGit.status === 404, `nao-git → 404 (achei ${rNaoGit.status})`);

    const rSemDevelop = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-sem-develop' });
    ok(rSemDevelop.status === 409, `app-sem-develop → 409 (achei ${rSemDevelop.status})`);
    ok(JSON.parse(rSemDevelop.corpo).erro === 'sem develop', `app-sem-develop: erro === "sem develop" (achei ${rSemDevelop.corpo})`);

    const rWt = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-wt' });
    ok(rWt.status === 409, `app-wt (worktree de outro repo) → 409 (achei ${rWt.status})`);

    for (const r of [semToken, origemErrada, rNaoExiste, rNaoGit, rSemDevelop, rWt]) {
      ok(!r.corpo.includes('/tmp/') && !r.corpo.includes('/home/') && !r.corpo.includes(TMP), `resposta sem caminho (achei ${r.corpo.slice(0, 160)})`);
    }
  });
});

// ─── 2. Sucesso simples e no-op ─────────────────────────────────────────────

await bloco('2. Sucesso simples e no-op', async () => {
  await withServer({ codigoDir, projetosDir, grafosDir, copiaDir, token: TOKEN }, async () => {
    const r1 = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-exemplo' });
    ok(r1.status === 200, `POST app-exemplo → 200 (achei ${r1.status}: ${r1.corpo})`);
    const corpo1 = JSON.parse(r1.corpo);
    ok(corpo1.ok === true && !('aviso' in corpo1), `sem aviso (achei ${r1.corpo})`);

    const rGet = await pedir('/api/grafos', 'GET', cab);
    const item = JSON.parse(rGet.corpo).projetos.find((p) => p.nome === 'app-exemplo');
    ok(Boolean(item && item.grafo && item.grafo.estado === 'em-dia'), `GET: app-exemplo em-dia (achei ${JSON.stringify(item)})`);
    ok(!item.gerando, 'GET: sem gerando');

    const r2 = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-exemplo' });
    ok(r2.status === 200, `POST de novo → 200 (achei ${r2.status})`);
    ok(linhasFazer(grafosDir, 'app-exemplo') === 1, `linhasFazer continua 1 — no-op (achei ${linhasFazer(grafosDir, 'app-exemplo')})`);
  });
});

// ─── 3. Falha e nova tentativa ──────────────────────────────────────────────

await bloco('3. Falha e nova tentativa', async () => {
  await withServer({ codigoDir, projetosDir, grafosDir, copiaDir, token: TOKEN }, async () => {
    const r1 = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-quebrado' });
    ok(r1.status === 500, `POST app-quebrado → 500 (achei ${r1.status}: ${r1.corpo})`);
    ok(JSON.parse(r1.corpo).erro === grafoFazerLib.MENSAGENS.falhou, `erro === MENSAGENS.falhou (achei ${r1.corpo})`);
    ok(!r1.corpo.includes('/'), `corpo sem barra (achei ${r1.corpo})`);

    const log = fs.readFileSync(path.join(grafosDir, 'app-quebrado', 'atualizar.log'), 'utf8');
    ok(/fazer: fim rc=1/.test(log), `atualizar.log tem fazer: fim rc=1 (achei ${log})`);

    const r2 = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-quebrado' });
    ok(r2.status === 500, `POST de novo → 500 (achei ${r2.status})`);
    ok(linhasFazer(grafosDir, 'app-quebrado') === 2, `linhasFazer === 2 (o Map soltou) (achei ${linhasFazer(grafosDir, 'app-quebrado')})`);
  });
});

// ─── 4. Aviso de hook ───────────────────────────────────────────────────────

await bloco('4. Aviso de hook', async () => {
  await withServer({ codigoDir, projetosDir, grafosDir, copiaDir, token: TOKEN }, async () => {
    const r = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-hookspath' });
    ok(r.status === 200, `POST app-hookspath → 200 (achei ${r.status}: ${r.corpo})`);
    const corpo = JSON.parse(r.corpo);
    ok(corpo.aviso === grafoFazerLib.MENSAGENS.hookHooksPath, `aviso === hookHooksPath (achei ${corpo.aviso})`);
    ok(fs.existsSync(path.join(grafosDir, 'app-hookspath', 'knowledge-graph.json')), 'o grafo está na loja');
    const rp = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-parcial' });
    ok(rp.status === 200, `POST app-parcial → 200 (achei ${rp.status}: ${rp.corpo})`);
    ok(JSON.parse(rp.corpo).aviso === grafoFazerLib.MENSAGENS.hookParcial, `aviso === hookParcial (achei ${rp.corpo})`);
    ok(fs.readFileSync(path.join(appParcial, '.git', 'hooks', 'reference-transaction'), 'utf8') === '#!/bin/sh\n# hook de terceiro\nexit 0\n', 'o reference-transaction de terceiro ficou intocado');
  });
});

// ─── 5. Prazo ───────────────────────────────────────────────────────────────

await bloco('5. Prazo', async () => {
  await withServer({
    codigoDir, projetosDir, grafosDir, copiaDir, token: TOKEN,
    extraEnv: { COCKPIT_GRAFO_TESTE_LENTO: '6000', COCKPIT_GRAFO_FAZER_PRAZO_MS: '1500' },
  }, async () => {
    const t0 = Date.now();
    const r1 = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-prazo' });
    const dt = Date.now() - t0;
    ok(r1.status === 500, `POST app-prazo → 500 (achei ${r1.status}: ${r1.corpo})`);
    ok(JSON.parse(r1.corpo).erro === grafoFazerLib.MENSAGENS.prazo, `erro === MENSAGENS.prazo (achei ${r1.corpo})`);
    ok(dt < 5000, `em menos de 5 s (achei ${dt}ms)`);

    const rGet = await pedir('/api/grafos', 'GET', cab);
    const item = JSON.parse(rGet.corpo).projetos.find((p) => p.nome === 'app-prazo');
    ok(!(item && item.gerando), `GET logo depois sem gerando (achei ${JSON.stringify(item)})`);

    const r2 = await pedir('/api/grafos/fazer', 'POST', cab, { nome: 'app-prazo' });
    ok(r2.status === 500, `segundo POST → 500 de novo (achei ${r2.status})`);
    ok(linhasFazer(grafosDir, 'app-prazo') === 2, `linhasFazer === 2 — geração nova (achei ${linhasFazer(grafosDir, 'app-prazo')})`);
  });
});

// ─── 6. Lance inesperado não vaza caminho ───────────────────────────────────

await bloco('6. Lance inesperado não vaza caminho', () => {
  const appLance = novoRepo(projetosDir, 'app-lance', 'develop');
  escreverEComitar(appLance, { 'a.js': 'export function f() {}\n' }, 'c1');

  const arquivoComum = path.join(TMP, 'loja-arquivo-comum');
  fs.writeFileSync(arquivoComum, '');
  const copiaNova = fs.mkdtempSync(path.join(TMP, 'copia-lance-'));

  const script = `require(${JSON.stringify(path.join(RAIZ_REPO, 'lib', 'grafo-fazer.js'))}).fazer({nome:'app-lance', cwd:${JSON.stringify(appLance)}}).then((r)=>process.stdout.write(JSON.stringify(r)))`;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, COCKPIT_GRAFOS_DIR: arquivoComum, COCKPIT_GRAFO_COPIA_DIR: copiaNova },
  });
  ok(r.status === 0, `node -e sai rc0 (achei ${r.status}: ${r.stderr})`);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* o ok abaixo reprova */ }
  ok(Boolean(json) && json.status === 500 && json.corpo && json.corpo.erro === grafoFazerLib.MENSAGENS.falhou,
    `JSON {status:500, corpo:{erro: falhou}} (achei ${r.stdout})`);
  ok(!r.stdout.includes('/'), `stdout inteiro sem barra (achei ${r.stdout})`);
});

// ─── 7. Mensagens no catálogo ───────────────────────────────────────────────

await bloco('7. Mensagens no catálogo', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(RAIZ_REPO, 'public', 'traducoes.js'), 'utf8'), ctx);
  const catalogo = ctx.cockpitTraducoes;
  for (const valor of [...Object.values(grafoFazerLib.MENSAGENS), 'não consegui falar com o servidor']) {
    ok(Object.hasOwn(catalogo, valor), `catálogo tem a chave "${valor}"`);
  }
});

// ─── 8. Fim — loja/cópia reais, porta ───────────────────────────────────────

await bloco('8. Fim', () => {
  ok(JSON.stringify(listarReal(LOJA_REAL)) === JSON.stringify(LOJA_REAL_ANTES), `a loja REAL (${LOJA_REAL}) não ganhou nem perdeu nada`);
  // Igual ao COMEÇO, não "ausente": depois do primeiro toque em produção a cópia real existe de verdade
  // (painel de execução, Codex) — exigir ausência derrubaria o npm test pra sempre.
  ok(JSON.stringify(listarReal(path.join(COPIA_REAL, 'versoes'))) === JSON.stringify(COPIA_REAL_ANTES), `a cópia REAL (${COPIA_REAL}) não ganhou nem perdeu versão`);
  let saida = '';
  try { saida = execSync('ss -H -lptn', { encoding: 'utf8' }); } catch { /* ignore */ }
  ok(!new RegExp(`:${PORTA}\\b`).test(saida), `porta ${PORTA} livre no fim`);
});

console.log(`\n${passou}/${total} asserções`);
console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — rota POST /api/grafos/fazer');
process.exitCode = vermelho ? 1 : 0;

}

principal();
