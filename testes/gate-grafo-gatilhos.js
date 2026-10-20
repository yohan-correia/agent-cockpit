#!/usr/bin/env node
'use strict';
// GATE dos gatilhos do git REAL — casos 8 e 10 do plano §2.1 (separados de `gate-grafo-hook.js`
// pelo orçamento: disparam commit/merge/fetch de verdade e esperam o hook regenerar em
// background). HOME e COCKPIT_GRAFOS_DIR sempre no tmp, passados no env de cada chamada que
// precisa que o hook veja a loja de teste (COCKPIT_GRAFOS_DIR vence o HOME — #62).
//
//   node testes/gate-grafo-gatilhos.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn, execFileSync } = require('node:child_process');

const RAIZ_REPO = path.resolve(__dirname, '..');
const BIN_GRAFO = path.join(RAIZ_REPO, 'bin', 'grafo.js');

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

function git(repo, args, envExtra) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=gate', '-c', 'user.email=gate@example.com', ...args], {
    encoding: 'utf8', env: envExtra ? { ...process.env, ...envExtra } : process.env,
  });
}
function novoMundo() {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-gatilhos-home-')),
    loja: fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-gatilhos-loja-')),
  };
}
function envDe(mundo, extra) {
  return { ...process.env, HOME: mundo.home, COCKPIT_GRAFOS_DIR: mundo.loja, ...(extra || {}) };
}
function novoRepoVazio(branchInicial) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-gatilhos-repo-'));
  git(repo, ['init', '-q', '-b', branchInicial || 'tronco']);
  return repo;
}
function escreverEComitar(repo, arquivos, msg, envExtra) {
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(repo, nome)), { recursive: true });
    fs.writeFileSync(path.join(repo, nome), conteudo);
  }
  git(repo, ['add', ...Object.keys(arquivos)], envExtra);
  git(repo, ['commit', '-q', '-m', msg], envExtra);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}
function dormirMs(ms) { try { execFileSync('sleep', [(ms / 1000).toString()]); } catch { /* segue */ } }
function esperar(cond, tetoMs) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 >= tetoMs) return cond();
    dormirMs(100);
  }
}
function esperarMsAsync(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function esperarAsync(cond, tetoMs) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 >= tetoMs) return cond();
    await esperarMsAsync(100);
  }
}
function spawnPromise(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
function shaPublicadoDe(mundo, nomeProjeto) {
  try { return JSON.parse(fs.readFileSync(path.join(mundo.loja, nomeProjeto, 'meta.json'), 'utf8')).gitCommitHash; }
  catch { return null; }
}

// ─── Isolamento por PADRÃO (#62/#78) ────────────────────────────────────────
// Todo processo filho — inclusive o hook que o `git` dispara num commit de fixture — herda HOME e
// COCKPIT_GRAFOS_DIR no tmp. Caso que precisa de loja própria passa a sua por cima (`envDe`).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-home-padrao-'));
process.env.COCKPIT_GRAFOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-loja-padrao-'));

// ─── A loja REAL não pode ganhar nada ───────────────────────────────────────
// Achado do painel de execução (16/10): rodado direto do shell (fora do `npm test`, que troca o
// HOME), o hook instalado nos repos de fixture gravava em ~/.cockpit/grafos de verdade — 51 pastas.
// `os.userInfo().homedir` é o HOME do passwd: não muda com a env, então vale dentro do `npm test`.
const LOJA_REAL = path.join(os.userInfo().homedir, '.cockpit', 'grafos');
const listarLojaReal = () => { try { return fs.readdirSync(LOJA_REAL).sort(); } catch { return []; } };
const LOJA_REAL_ANTES = JSON.stringify(listarLojaReal());

async function principal() {

await bloco('8. Gatilhos — commit na develop regenera; commit na feat não; merge regenera; fetch . x:develop regenera (só reference-transaction)', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const mundo = novoMundo();
  const nome = path.basename(repo);
  const rInst = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], { encoding: 'utf8' });
  ok(rInst.status === 0, `instalar-hook rc0 (achei ${rInst.status}: ${rInst.stderr})`);

  const sha1 = escreverEComitar(repo, { 'a.js': 'export function f() {}\n', 'b.js': 'export function b() {}\n' }, 'c2-develop', envDe(mundo));
  const virou1 = esperar(() => shaPublicadoDe(mundo, nome) === sha1, 20000);
  ok(virou1, `commit na develop: a loja virou o sha novo em até 20s (achei ${shaPublicadoDe(mundo, nome)}, esperado ${sha1})`);

  git(repo, ['checkout', '-q', '-b', 'feat']);
  escreverEComitar(repo, { 'feat-only.js': 'export function ff() {}\n' }, 'c-feat', envDe(mundo));
  dormirMs(3000);
  ok(shaPublicadoDe(mundo, nome) === sha1, `commit na feat: a loja NÃO mudou depois de 3s (achei ${shaPublicadoDe(mundo, nome)})`);

  git(repo, ['checkout', '-q', 'develop']);
  git(repo, ['merge', '--no-ff', '-q', '-m', 'merge-feat', 'feat'], envDe(mundo));
  const shaMerge = git(repo, ['rev-parse', 'develop']).trim();
  const virouMerge = esperar(() => shaPublicadoDe(mundo, nome) === shaMerge, 20000);
  ok(virouMerge, `merge --no-ff na develop: regenerou em até 20s (achei ${shaPublicadoDe(mundo, nome)}, esperado ${shaMerge})`);

  git(repo, ['checkout', '-q', '-b', 'feat3']);
  const shaFeat3 = escreverEComitar(repo, { 'feat3-only.js': 'export function f3() {}\n' }, 'c-feat3');
  git(repo, ['fetch', '.', 'feat3:develop'], envDe(mundo));
  const virouFetch = esperar(() => shaPublicadoDe(mundo, nome) === shaFeat3, 20000);
  ok(virouFetch, `git fetch . feat3:develop (reference-transaction): regenerou em até 20s (achei ${shaPublicadoDe(mundo, nome)}, esperado ${shaFeat3})`);
});

await bloco('10. Rajada e pendência — dois atualizar ao mesmo tempo fazem UMA geração por sha; commit no meio da lenta assenta no sha final', async () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const sha1 = git(repo, ['rev-parse', 'develop']).trim();
  const nome = path.basename(repo);
  const mundo = novoMundo();

  const [ra, rb] = await Promise.all([
    spawnPromise([BIN_GRAFO, 'atualizar', repo], envDe(mundo)),
    spawnPromise([BIN_GRAFO, 'atualizar', repo], envDe(mundo)),
  ]);
  ok(ra.status === 0 && rb.status === 0, `os dois atualizar saem rc0 (achei ${ra.status}, ${rb.status})`);
  const log = fs.readFileSync(path.join(mundo.loja, nome, 'atualizar.log'), 'utf8');
  const inicios = log.split('\n').filter((l) => l.includes(`início sha=${sha1}`)).length;
  ok(inicios === 1, `log mostra UMA geração para o sha (achei ${inicios} "início", log:\n${log})`);

  const mundo2 = novoMundo();
  const pLento = spawnPromise([BIN_GRAFO, 'atualizar', repo], envDe(mundo2, { COCKPIT_GRAFO_TESTE_LENTO: '1500' }));
  await esperarMsAsync(400);
  const sha2 = escreverEComitar(repo, { 'a.js': 'export function f() {}\n', 'z.js': 'export function z() {}\n' }, 'c2', envDe(mundo2));
  const [rLento, rCurto] = await Promise.all([pLento, spawnPromise([BIN_GRAFO, 'atualizar', repo], envDe(mundo2))]);
  ok(rLento.status === 0 && rCurto.status === 0, `os dois atualizar (lento + commit no meio) saem rc0 (achei ${rLento.status}, ${rCurto.status})`);
  const assentou = await esperarAsync(() => shaPublicadoDe(mundo2, nome) === sha2, 10000);
  ok(assentou, `sha publicado no fim é o ÚLTIMO (sha2=${sha2}, achei ${shaPublicadoDe(mundo2, nome)})`);
});

ok(JSON.stringify(listarLojaReal()) === LOJA_REAL_ANTES,
  `a loja REAL (${LOJA_REAL}) não ganhou nem perdeu nada durante o gate`);
console.log(`\n${passou}/${total} asserções`);
console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — gatilhos do git real (8, 10)');
process.exitCode = vermelho ? 1 : 0;

}

principal();
