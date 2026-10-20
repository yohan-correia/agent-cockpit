#!/usr/bin/env node
'use strict';
// GATE dos hooks e da geração pela develop — spec/plano `2026-10-16-grafo-do-projeto-no-cockpit`
// (Fase 2). Repos de fixture em `fs.mkdtempSync`, `HOME` e `COCKPIT_GRAFOS_DIR` SEMPRE no tmp,
// passados explícitos no env de cada chamada (COCKPIT_GRAFOS_DIR vence o HOME — #62). Git sempre
// com `-c user.name=gate -c user.email=gate@example.com`. Casos 1-7 e 11-16 do plano §2.1; os
// gatilhos do git real (8-10) moram em `gate-grafo-gatilhos.js` (orçamento de tempo).
//
//   node testes/gate-grafo-hook.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn, execFileSync } = require('node:child_process');

const RAIZ_REPO = path.resolve(__dirname, '..');
const BIN_GRAFO = path.join(RAIZ_REPO, 'bin', 'grafo.js');
const hooklib = require(path.join(RAIZ_REPO, 'lib', 'grafo-hook.js'));

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
function esperarMsAsync(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function esperarAsync(cond, tetoMs) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 >= tetoMs) return cond();
    await esperarMsAsync(100);
  }
}

function git(repo, args, envExtra) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=gate', '-c', 'user.email=gate@example.com', ...args], {
    encoding: 'utf8', env: envExtra ? { ...process.env, ...envExtra } : process.env,
  });
}

function novoMundo() {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-home-')),
    loja: fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-loja-')),
  };
}
function envDe(mundo, extra) {
  return { ...process.env, HOME: mundo.home, COCKPIT_GRAFOS_DIR: mundo.loja, ...(extra || {}) };
}
function rodar(args, mundo, extra) {
  return spawnSync(process.execPath, [BIN_GRAFO, ...args], { encoding: 'utf8', env: envDe(mundo, extra) });
}
function novoRepoVazio(branchInicial) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-repo-'));
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
function lerGrafoPublicado(mundo, nomeProjeto) {
  return JSON.parse(fs.readFileSync(path.join(mundo.loja, nomeProjeto, 'knowledge-graph.json'), 'utf8'));
}
function lerMeta(mundo, nomeProjeto) {
  return JSON.parse(fs.readFileSync(path.join(mundo.loja, nomeProjeto, 'meta.json'), 'utf8'));
}
function listaDeArquivos(repo) {
  return fs.readdirSync(repo, { recursive: true }).filter((p) => !p.split(path.sep).includes('.git')).sort();
}
function listaDeGit(repo) {
  return fs.readdirSync(path.join(repo, '.git'), { recursive: true })
    .filter((p) => {
      const partes = p.split(path.sep);
      return partes[0] !== 'logs' && p !== 'index' && p !== 'FETCH_HEAD';
    }).sort();
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

// ─── 1. Da develop, nunca do checkout ──────────────────────────────────────

await bloco('1. Da develop, nunca do checkout — gerar lê o banco de objetos, não o disco', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1 (develop)');
  const shaDevelop = git(repo, ['rev-parse', 'develop']).trim();
  git(repo, ['checkout', '-q', '-b', 'feat']);
  escreverEComitar(repo, { 'a.js': 'export function g() {}\n', 'b.js': 'export function h() {}\n' }, 'c2 (feat)');
  // checkout parado na feat, com a.js ainda sujo no disco
  fs.writeFileSync(path.join(repo, 'a.js'), 'export function g() {} // sujo\n');

  const statusAntes = git(repo, ['status', '--porcelain']);
  const arquivosAntes = listaDeArquivos(repo);
  const gitAntes = listaDeGit(repo);

  const mundo = novoMundo();
  const r = rodar(['gerar', repo], mundo);
  ok(r.status === 0, `gerar sai rc0 (achei ${r.status}: ${r.stderr})`);

  const grafo = lerGrafoPublicado(mundo, path.basename(repo));
  ok(grafo.nodes.some((n) => n.id === 'file:a.js'), 'file:a.js no grafo');
  ok(grafo.nodes.some((n) => n.id === 'function:a.js:f'), 'a declaração f (da develop) está lá');
  ok(!grafo.nodes.some((n) => n.id === 'function:a.js:g'), 'NÃO a declaração g (da feat)');
  ok(!grafo.nodes.some((n) => n.id === 'file:b.js'), 'NÃO file:b.js (só existe na feat)');
  ok(grafo.project.gitCommitHash === shaDevelop, `gitCommitHash = sha da develop (achei ${grafo.project.gitCommitHash})`);

  ok(git(repo, ['status', '--porcelain']) === statusAntes, 'git status --porcelain idêntico antes/depois');
  ok(JSON.stringify(listaDeArquivos(repo)) === JSON.stringify(arquivosAntes), 'lista de arquivos do disco idêntica antes/depois');
  ok(JSON.stringify(listaDeGit(repo)) === JSON.stringify(gitAntes), 'nada novo em .git/ (além do que o git já cria)');
});

// ─── 2. GIT_DIR herdado não confunde ────────────────────────────────────────

await bloco('2. GIT_DIR herdado não confunde — lê o repo pedido, não o do ambiente', () => {
  const repoA = novoRepoVazio('develop');
  escreverEComitar(repoA, { 'a.js': 'export function f() {}\n' }, 'c1');
  const repoZ = novoRepoVazio('develop');
  escreverEComitar(repoZ, { 'z.js': 'export function zz() {}\n' }, 'cz');

  const mundo = novoMundo();
  const r = rodar(['gerar', repoA], mundo, {
    GIT_DIR: path.join(repoZ, '.git'),
    GIT_WORK_TREE: repoZ,
    GIT_INDEX_FILE: path.join(repoZ, '.git', 'index'),
  });
  ok(r.status === 0, `gerar sai rc0 com GIT_DIR herdado de outro repo (achei ${r.status}: ${r.stderr})`);
  const grafo = lerGrafoPublicado(mundo, path.basename(repoA));
  ok(grafo.nodes.some((n) => n.id === 'file:a.js'), 'o grafo é do repoA (tem a.js)');
  ok(!grafo.nodes.some((n) => n.id === 'file:z.js'), 'NÃO é do repoZ (sem z.js)');
});

// ─── 3. Ref da develop ──────────────────────────────────────────────────────

await bloco('3. Ref da develop — só origin/develop, local ancestral da remota, divergente, nenhuma', () => {
  // 3a: só origin/develop
  {
    const repo = novoRepoVazio('tronco');
    escreverEComitar(repo, { 'x.js': 'export function x() {}\n' }, 'c0');
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['update-ref', 'refs/remotes/origin/develop', sha]);
    const mundo = novoMundo();
    const r = rodar(['gerar', repo], mundo);
    ok(r.status === 0, `3a rc0 (achei ${r.status}: ${r.stderr})`);
    const meta = lerMeta(mundo, path.basename(repo));
    ok(meta.ref === 'origin/develop', `3a meta.ref = origin/develop (achei ${meta.ref})`);
  }
  // 3b: as duas, local ancestral da remota → vale a remota
  {
    const repo = novoRepoVazio('tronco');
    escreverEComitar(repo, { 'x.js': 'export function x() {}\n' }, 'c0');
    git(repo, ['branch', 'develop']);
    git(repo, ['checkout', '-q', '-b', 'tmp2']);
    const shaRemota = escreverEComitar(repo, { 'y.js': 'export function y() {}\n' }, 'c1');
    git(repo, ['update-ref', 'refs/remotes/origin/develop', shaRemota]);
    const mundo = novoMundo();
    const r = rodar(['gerar', repo], mundo);
    ok(r.status === 0, `3b rc0 (achei ${r.status}: ${r.stderr})`);
    const meta = lerMeta(mundo, path.basename(repo));
    ok(meta.ref === 'origin/develop' && meta.gitCommitHash === shaRemota, `3b vale a remota (ref=${meta.ref}, sha=${meta.gitCommitHash === shaRemota})`);
  }
  // 3c: as duas, divergentes → vale a local
  {
    const repo = novoRepoVazio('tronco');
    escreverEComitar(repo, { 'x.js': 'export function x() {}\n' }, 'c0');
    git(repo, ['branch', 'develop']);
    git(repo, ['checkout', '-q', 'develop']);
    const shaLocal = escreverEComitar(repo, { 'local-only.js': 'export function lo() {}\n' }, 'local');
    git(repo, ['checkout', '-q', 'tronco']);
    git(repo, ['checkout', '-q', '-b', 'outro']);
    const shaRemota = escreverEComitar(repo, { 'remote-only.js': 'export function ro() {}\n' }, 'remoto');
    git(repo, ['update-ref', 'refs/remotes/origin/develop', shaRemota]);
    const mundo = novoMundo();
    const r = rodar(['gerar', repo], mundo);
    ok(r.status === 0, `3c rc0 (achei ${r.status}: ${r.stderr})`);
    const meta = lerMeta(mundo, path.basename(repo));
    ok(meta.ref === 'develop' && meta.gitCommitHash === shaLocal, `3c vale a local (ref=${meta.ref}, sha=${meta.gitCommitHash === shaLocal})`);
  }
  // 3d: nenhuma → rc 3, "sem develop"
  {
    const repo = novoRepoVazio('tronco');
    escreverEComitar(repo, { 'x.js': 'export function x() {}\n' }, 'c0');
    const mundo = novoMundo();
    const r = rodar(['gerar', repo], mundo);
    ok(r.status === 3, `3d rc3 (achei ${r.status})`);
    ok(/develop/i.test(r.stderr), `3d mensagem cita "develop" (achei ${JSON.stringify(r.stderr)})`);
  }
});

// ─── 4. --ref só com --saida ────────────────────────────────────────────────

await bloco('4. --ref só com --saida — sem --saida recusa, loja intocada; com --saida, grafo da feat', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  git(repo, ['checkout', '-q', '-b', 'feat']);
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n', 'b.js': 'export function h() {}\n' }, 'c2');

  const mundo = novoMundo();
  const r1 = rodar(['gerar', repo, '--ref', 'feat'], mundo);
  ok(r1.status === 2, `--ref sem --saida: rc2 (achei ${r1.status})`);
  ok(!fs.existsSync(path.join(mundo.loja, path.basename(repo))), '--ref sem --saida: loja intocada (pasta nem existe)');

  const saidaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-saida-'));
  const r2 = rodar(['gerar', repo, '--saida', saidaTmp, '--ref', 'feat'], mundo);
  ok(r2.status === 0, `--ref com --saida: rc0 (achei ${r2.status}: ${r2.stderr})`);
  const grafoSaida = JSON.parse(fs.readFileSync(path.join(saidaTmp, 'knowledge-graph.json'), 'utf8'));
  ok(grafoSaida.nodes.some((n) => n.id === 'file:b.js'), 'o grafo em --saida é da feat (tem b.js)');
  ok(!fs.existsSync(path.join(mundo.loja, path.basename(repo))), 'loja continua intocada depois do --saida');
});

// ─── 5. Publicação atômica ──────────────────────────────────────────────────

await bloco('5. Publicação atômica — morrer entre o .anterior e o rename final não perde o grafo', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const shaV1 = git(repo, ['rev-parse', 'develop']).trim();
  const mundo = novoMundo();

  const r1 = rodar(['gerar', repo], mundo);
  ok(r1.status === 0, `1ª geração rc0 (achei ${r1.status})`);
  const metaV1 = lerMeta(mundo, path.basename(repo));
  ok(metaV1.gitCommitHash === shaV1, 'v1 publicada com o sha certo');

  escreverEComitar(repo, { 'a.js': 'export function f() {}\n', 'c.js': 'export function cc() {}\n' }, 'c2');
  const shaV2 = git(repo, ['rev-parse', 'develop']).trim();

  const r2 = rodar(['gerar', repo], mundo, { COCKPIT_GRAFO_TESTE_MORRER: 'entre-anterior-e-publicar' });
  ok(r2.status === 99, `2ª geração (gancho de morte) sai rc99 (achei ${r2.status})`);

  const pasta = path.join(mundo.loja, path.basename(repo));
  const atualDepoisDaMorte = JSON.parse(fs.readFileSync(path.join(pasta, 'knowledge-graph.json'), 'utf8'));
  ok(atualDepoisDaMorte.project.gitCommitHash === shaV1, `knowledge-graph.json continua com o sha antigo (v1) — achei ${atualDepoisDaMorte.project.gitCommitHash}`);
  ok(fs.existsSync(path.join(pasta, 'knowledge-graph.anterior.json')), '.anterior existe');

  const r3 = rodar(['gerar', repo], mundo);
  ok(r3.status === 0, `3ª geração (normal) rc0 (achei ${r3.status})`);
  const metaV2 = lerMeta(mundo, path.basename(repo));
  ok(metaV2.gitCommitHash === shaV2, `agora publica v2 (achei ${metaV2.gitCommitHash === shaV2})`);
  const anteriorFinal = JSON.parse(fs.readFileSync(path.join(pasta, 'knowledge-graph.anterior.json'), 'utf8'));
  ok(anteriorFinal.project.gitCommitHash === shaV1, `.anterior passou a ser v1 (achei ${anteriorFinal.project.gitCommitHash})`);
});

// ─── 6. Instalar hook ───────────────────────────────────────────────────────

await bloco('6. Instalar hook — os quatro com marcador e executáveis; idempotente; recusa worktree sem a flag', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');

  // A recusa depende de ONDE o `bin/grafo.js` mora, não de onde a suíte roda: rodando o BIN_GRAFO
  // do checkout principal, nenhuma worktree aparece e o caso reprovava fora de job. Então a prova
  // monta a própria worktree vinculada — um repo de fixture com uma cópia do bin e das libs do
  // grafo — e roda a cópia de lá.
  const origem = novoRepoVazio('develop');
  fs.mkdirSync(path.join(origem, 'bin'));
  fs.mkdirSync(path.join(origem, 'lib'));
  fs.copyFileSync(BIN_GRAFO, path.join(origem, 'bin', 'grafo.js'));
  for (const f of fs.readdirSync(path.join(RAIZ_REPO, 'lib')).filter((n) => n.startsWith('grafo-'))) {
    fs.copyFileSync(path.join(RAIZ_REPO, 'lib', f), path.join(origem, 'lib', f));
  }
  git(origem, ['add', '-A']);
  git(origem, ['commit', '-q', '-m', 'copia do bin']);
  const vinculada = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-wt-')), 'wt');
  git(origem, ['worktree', 'add', '-q', '-b', 'copia', vinculada]);
  const semFlag = spawnSync(process.execPath, [path.join(vinculada, 'bin', 'grafo.js'), 'instalar-hook', repo], { encoding: 'utf8' });
  ok(semFlag.status === 2, `sem --permitir-worktree: rc2 (achei ${semFlag.status})`);
  ok(/worktree/i.test(semFlag.stdout + semFlag.stderr), 'a recusa cita "worktree"');
  ok(!fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit')), 'nenhum hook foi criado na recusa');

  const r1 = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], { encoding: 'utf8' });
  ok(r1.status === 0, `com --permitir-worktree: rc0 (achei ${r1.status}: ${r1.stderr})`);
  const HOOKS = ['post-commit', 'post-merge', 'post-rewrite', 'reference-transaction'];
  const conteudos1 = {};
  for (const h of HOOKS) {
    const p = path.join(repo, '.git', 'hooks', h);
    ok(fs.existsSync(p), `${h} existe`);
    const conteudo = fs.readFileSync(p, 'utf8');
    conteudos1[h] = conteudo;
    ok(conteudo.includes('cockpit-grafo'), `${h} tem o marcador`);
    ok((fs.statSync(p).mode & 0o111) !== 0, `${h} é executável`);
  }

  const r2 = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], { encoding: 'utf8' });
  ok(r2.status === 0, 'rodar de novo: rc0');
  for (const h of HOOKS) {
    const conteudo2 = fs.readFileSync(path.join(repo, '.git', 'hooks', h), 'utf8');
    ok(conteudo2 === conteudos1[h], `${h}: byte a byte igual ao instalar de novo`);
  }
});

// ─── 7. Hook de terceiro ────────────────────────────────────────────────────

await bloco('7. Hook de terceiro — .bak + bloco depois do shebang; shebang não-shell e ref-transaction intocados; core.hooksPath recusa', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const log = path.join(repo, 'terceiro.log');
  const postCommitOriginal = `#!/bin/sh\necho terceiro >> '${log}'\nexit 0\n`;
  const postMergeOriginal = '#!/usr/bin/env python3\nprint("terceiro py")\n';
  const refTxOriginal = '#!/bin/sh\necho ref-terceiro >> /dev/null\nexit 0\n';
  fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), postCommitOriginal);
  fs.chmodSync(path.join(repo, '.git', 'hooks', 'post-commit'), 0o755);
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-merge'), postMergeOriginal);
  fs.chmodSync(path.join(repo, '.git', 'hooks', 'post-merge'), 0o755);
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'reference-transaction'), refTxOriginal);
  fs.chmodSync(path.join(repo, '.git', 'hooks', 'reference-transaction'), 0o755);
  // post-rewrite não pré-existe — nasce do zero

  const r = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], { encoding: 'utf8' });
  ok(r.status === 0, `instalar rc0 (achei ${r.status}: ${r.stderr})`);

  const hooksDir = path.join(repo, '.git', 'hooks');
  const baks = fs.readdirSync(hooksDir).filter((f) => f.startsWith('post-commit.bak-cockpit-grafo-'));
  ok(baks.length === 1, `exatamente um .bak de post-commit (achei ${baks.length})`);
  if (baks.length) ok(fs.readFileSync(path.join(hooksDir, baks[0]), 'utf8') === postCommitOriginal, 'o .bak é idêntico ao original');

  const postCommitNovo = fs.readFileSync(path.join(hooksDir, 'post-commit'), 'utf8');
  ok(postCommitNovo.startsWith('#!/bin/sh\n# >>> cockpit-grafo'), 'post-commit: bloco logo depois do shebang');
  ok(postCommitNovo.includes("echo terceiro >>"), 'post-commit: conteúdo de terceiro preservado');

  ok(fs.readFileSync(path.join(hooksDir, 'post-merge'), 'utf8') === postMergeOriginal, 'post-merge (python) intocado');
  ok(/post-merge/.test(r.stdout), 'o relatório cita post-merge');

  ok(fs.readFileSync(path.join(hooksDir, 'reference-transaction'), 'utf8') === refTxOriginal, 'reference-transaction de terceiro intocado');
  ok(/reference-transaction/.test(r.stdout), 'o relatório cita reference-transaction');

  const shaAntes = git(repo, ['rev-parse', 'develop']).trim();
  void shaAntes;
  escreverEComitar(repo, { 'd.js': 'export function d() {}\n' }, 'c2');
  const logConteudo = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  ok(logConteudo.includes('terceiro'), 'o commit ainda dispara o hook de terceiro (escreveu no log)');

  // core.hooksPath configurado → recusa, nenhum arquivo criado
  const repo2 = novoRepoVazio('develop');
  escreverEComitar(repo2, { 'a.js': 'export function f() {}\n' }, 'c1');
  const hooksAlternativa = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-hookspath-'));
  git(repo2, ['config', 'core.hooksPath', hooksAlternativa]);
  const r2 = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo2, '--permitir-worktree'], { encoding: 'utf8' });
  ok(r2.status === 2, `core.hooksPath: rc2 (achei ${r2.status})`);
  ok(fs.readdirSync(hooksAlternativa).length === 0, 'core.hooksPath: nenhum arquivo criado lá');
});

// ─── 9. O git nunca quebra por causa do hook ───────────────────────────────

await bloco('9. O git nunca quebra por causa do hook — node gravado apagado: commit/fetch/merge e os 3 estados do reference-transaction saem rc0', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const copiaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-node9-'));
  const copiaNode = path.join(copiaDir, 'node');
  fs.copyFileSync(process.execPath, copiaNode);
  fs.chmodSync(copiaNode, 0o755);
  const rInst = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], {
    encoding: 'utf8', env: { ...process.env, COCKPIT_GRAFO_NODE: copiaNode },
  });
  ok(rInst.status === 0, `instalar com COCKPIT_GRAFO_NODE: rc0 (achei ${rInst.status}: ${rInst.stderr})`);
  fs.rmSync(copiaNode, { force: true });

  let commitOk = true;
  try { git(repo, ['commit', '--allow-empty', '-q', '-m', 'vazio']); } catch { commitOk = false; }
  ok(commitOk, 'git commit não quebrou');

  git(repo, ['checkout', '-q', '-b', 'feat2']);
  escreverEComitar(repo, { 'b.js': 'export function b() {}\n' }, 'cfeat2');
  let fetchOk = true;
  try { git(repo, ['fetch', '.', 'feat2:develop']); } catch { fetchOk = false; }
  ok(fetchOk, 'git fetch . x:develop não quebrou');

  git(repo, ['checkout', '-q', 'develop']);
  git(repo, ['checkout', '-q', '-b', 'outraBranch']);
  escreverEComitar(repo, { 'c.js': 'export function c() {}\n' }, 'c-outra');
  git(repo, ['checkout', '-q', 'develop']);
  let mergeOk = true;
  try { git(repo, ['merge', '--no-ff', '-q', '-m', 'merge', 'outraBranch']); } catch { mergeOk = false; }
  ok(mergeOk, 'git merge não quebrou');

  const refTx = path.join(repo, '.git', 'hooks', 'reference-transaction');
  const shaA = git(repo, ['rev-parse', 'develop']).trim();
  const linhaDev = `${shaA} ${shaA} refs/heads/develop\n`;
  const linhaOutra = `${shaA} ${shaA} refs/heads/qualquer-outra\n`;
  for (const estado of ['prepared', 'committed', 'aborted']) {
    for (const linha of [linhaDev, linhaOutra]) {
      const rr = spawnSync(refTx, [estado], { input: linha, encoding: 'utf8', cwd: repo });
      ok(rr.status === 0, `reference-transaction ${estado} (${linha.includes('qualquer') ? 'outra ref' : 'develop'}): rc0 (achei ${rr.status})`);
    }
  }
});

// ─── 11. Herança fora da develop ───────────────────────────────────────────

await bloco('11. Herança fora da develop — .ua/ com sha fora da develop não herda; com sha da develop, herda', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const shaDevelop = git(repo, ['rev-parse', 'develop']).trim();
  git(repo, ['checkout', '-q', '-b', 'feat']);
  const shaFeat = escreverEComitar(repo, { 'a.js': 'export function f() {}\n', 'x.js': 'x\n' }, 'cfeat');
  git(repo, ['checkout', '-q', 'develop']);

  fs.mkdirSync(path.join(repo, '.ua'), { recursive: true });
  const grafoUa = { nodes: [{ id: 'file:a.js', summary: 'resumo do .ua', tags: [], complexity: 'simple' }], layers: [], tour: [] };
  fs.writeFileSync(path.join(repo, '.ua', 'knowledge-graph.json'), JSON.stringify(grafoUa));
  fs.writeFileSync(path.join(repo, '.ua', 'meta.json'), JSON.stringify({ gitCommitHash: shaFeat }));

  const mundo = novoMundo();
  const r1 = rodar(['gerar', repo], mundo);
  ok(r1.status === 0, `1ª geração (sha da feat, fora da develop) rc0 (achei ${r1.status}: ${r1.stderr})`);
  const g1 = lerGrafoPublicado(mundo, path.basename(repo));
  const noA1 = g1.nodes.find((n) => n.id === 'file:a.js');
  // "Não herdou" = o resumo não é o texto do `.ua/` (o nó ganha o resumo ESTRUTURAL, nunca vazio —
  // summary vazio o dashboard "corrige", ver gate-grafo-extrator.js).
  ok(!!noA1 && noA1.summary !== 'resumo do .ua' && noA1.summary.length > 0,
    `NÃO herda (sha fora da develop) — resumo estrutural, não o do .ua (achei "${noA1 && noA1.summary}")`);

  fs.writeFileSync(path.join(repo, '.ua', 'meta.json'), JSON.stringify({ gitCommitHash: shaDevelop }));
  const r2 = rodar(['gerar', repo], mundo);
  ok(r2.status === 0, `2ª geração (sha da develop) rc0 (achei ${r2.status}: ${r2.stderr})`);
  const g2 = lerGrafoPublicado(mundo, path.basename(repo));
  const noA2 = g2.nodes.find((n) => n.id === 'file:a.js');
  ok(!!noA2 && noA2.summary === 'resumo do .ua', `herda (sha da develop) — summary = "resumo do .ua" (achei "${noA2 && noA2.summary}")`);
});

// ─── 12. remover-hook ───────────────────────────────────────────────────────

await bloco('12. remover-hook — devolve o hook de terceiro idêntico; os criados do zero somem; status diz "não instalado"', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const postCommitOriginal = '#!/bin/sh\necho terceiro-12\nexit 0\n';
  fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), postCommitOriginal);
  fs.chmodSync(path.join(repo, '.git', 'hooks', 'post-commit'), 0o755);
  // post-rewrite não pré-existe — nasce do zero

  const rInst = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], { encoding: 'utf8' });
  ok(rInst.status === 0, `instalar rc0 (achei ${rInst.status}: ${rInst.stderr})`);
  ok(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-rewrite')), 'post-rewrite foi criado');

  const rRem = spawnSync(process.execPath, [BIN_GRAFO, 'remover-hook', repo], { encoding: 'utf8' });
  ok(rRem.status === 0, `remover rc0 (achei ${rRem.status}: ${rRem.stderr})`);
  ok(fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8') === postCommitOriginal, 'post-commit volta idêntico ao original');
  ok(!fs.existsSync(path.join(repo, '.git', 'hooks', 'post-rewrite')), 'post-rewrite (criado do zero) sumiu');

  const rStatus = spawnSync(process.execPath, [BIN_GRAFO, 'status-hook', repo], { encoding: 'utf8' });
  ok(/post-rewrite: não instalado/.test(rStatus.stdout), `status-hook diz "não instalado" para post-rewrite (stdout: ${rStatus.stdout})`);
});

// ─── 12b. remover-hook tira SÓ o bloco ──────────────────────────────────────
// Achado da revisão do orquestrador: restaurar o `.bak` apagaria o que o dono do hook acrescentou
// DEPOIS da instalação (outro instalador que pôs o bloco dele, por exemplo). Spec: "tira só o bloco".

await bloco('12b. remover-hook preserva o que o terceiro mudou depois da instalação e mantém o .bak', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const hooksDir = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'post-commit'), '#!/bin/sh\necho terceiro-12b\n');
  fs.chmodSync(path.join(hooksDir, 'post-commit'), 0o755);

  const rInst = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], { encoding: 'utf8' });
  ok(rInst.status === 0, `instalar rc0 (achei ${rInst.status}: ${rInst.stderr})`);
  fs.appendFileSync(path.join(hooksDir, 'post-commit'), 'echo acrescentado-depois\n');

  const rRem = spawnSync(process.execPath, [BIN_GRAFO, 'remover-hook', repo], { encoding: 'utf8' });
  ok(rRem.status === 0, `remover rc0 (achei ${rRem.status}: ${rRem.stderr})`);
  const depois = fs.readFileSync(path.join(hooksDir, 'post-commit'), 'utf8');
  ok(depois === '#!/bin/sh\necho terceiro-12b\necho acrescentado-depois\n',
    `post-commit sem o bloco e com a linha acrescentada depois (veio ${JSON.stringify(depois)})`);
  ok(fs.readdirSync(hooksDir).some((f) => f.startsWith('post-commit.bak-cockpit-grafo-')), 'o .bak continua lá, como registro');
});

// ─── 13. Hook quebrado ──────────────────────────────────────────────────────

await bloco('13. Hook quebrado — com o node gravado apagado, status-hook marca "quebrado"', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const copiaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-node13-'));
  const copiaNode = path.join(copiaDir, 'node');
  fs.copyFileSync(process.execPath, copiaNode);
  const r = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], {
    encoding: 'utf8', env: { ...process.env, COCKPIT_GRAFO_NODE: copiaNode },
  });
  ok(r.status === 0, `instalar rc0 (achei ${r.status}: ${r.stderr})`);
  fs.rmSync(copiaNode, { force: true });
  const rStatus = spawnSync(process.execPath, [BIN_GRAFO, 'status-hook', repo], { encoding: 'utf8' });
  ok(/post-commit: quebrado/.test(rStatus.stdout), `status-hook marca post-commit quebrado (stdout: ${rStatus.stdout})`);
});

// ─── 14. Alias do TS pela CLI ───────────────────────────────────────────────

await bloco('14. Alias do TS pela CLI — tsconfig.json com paths @/* resolve pelo caminho completo (gerar de verdade)', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, {
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
    'src/x.ts': "import { y } from '@/y';\nexport function x() { y(); }\n",
    'src/y.ts': 'export function y() {}\n',
  }, 'c1');
  const mundo = novoMundo();
  const r = rodar(['gerar', repo], mundo);
  ok(r.status === 0, `rc0 (achei ${r.status}: ${r.stderr})`);
  const grafo = lerGrafoPublicado(mundo, path.basename(repo));
  ok(grafo.edges.some((e) => e.type === 'imports' && e.source === 'file:src/x.ts' && e.target === 'file:src/y.ts'), 'imports src/x.ts → src/y.ts (via @/* do tsconfig)');
});

// ─── 15. gerar concorrendo com atualizar; commit durante um gerar ──────────

await bloco('15. gerar concorrendo com atualizar — os dois rc0, sha da develop, sem .tmp/.trava; commit durante um gerar deixa .pendente e o sha final é o do commit novo', async () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const shaDevelop = git(repo, ['rev-parse', 'develop']).trim();
  const mundo = novoMundo();

  const [r1, r2] = await Promise.all([
    spawnPromise([BIN_GRAFO, 'gerar', repo], envDe(mundo, { COCKPIT_GRAFO_TESTE_LENTO: '1000' })),
    spawnPromise([BIN_GRAFO, 'atualizar', repo], envDe(mundo, { COCKPIT_GRAFO_TESTE_LENTO: '1000' })),
  ]);
  ok(r1.status === 0, `gerar concorrente rc0 (achei ${r1.status}: ${r1.stderr})`);
  ok(r2.status === 0, `atualizar concorrente rc0 (achei ${r2.status}: ${r2.stderr})`);
  const pasta = path.join(mundo.loja, path.basename(repo));
  const meta = lerMeta(mundo, path.basename(repo));
  ok(meta.gitCommitHash === shaDevelop, `sha publicado é o da develop (achei ${meta.gitCommitHash})`);
  // Os `.tmp` agora têm o pid no nome (dois escritores nunca misturam um arquivo): confere qualquer um.
  ok(!fs.readdirSync(pasta).some((n) => n.endsWith('.tmp')), 'sem .tmp sobrando');
  ok(!fs.existsSync(path.join(pasta, '.trava')), 'sem .trava sobrando');

  // commit na develop durante um gerar (hook instalado, TESTE_LENTO=1500)
  const rInst = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], { encoding: 'utf8' });
  ok(rInst.status === 0, `instalar-hook (para a 2ª parte do caso 15) rc0 (achei ${rInst.status}: ${rInst.stderr})`);
  const mundo2 = novoMundo();
  const pGerar = spawnPromise([BIN_GRAFO, 'gerar', repo], envDe(mundo2, { COCKPIT_GRAFO_TESTE_LENTO: '1500' }));
  await esperarMsAsync(400); // dá tempo do gerar pegar a trava e começar a ler a develop
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n', 'novo.js': 'export function nn() {}\n' }, 'c2-durante-gerar', envDe(mundo2));
  const shaNovo = git(repo, ['rev-parse', 'develop']).trim();
  const rGerar = await pGerar;
  ok(rGerar.status === 0, `gerar (com commit no meio) termina rc0 (achei ${rGerar.status}: ${rGerar.stderr})`);
  const pasta2 = path.join(mundo2.loja, path.basename(repo));
  const assentou = await esperarAsync(() => {
    try { return JSON.parse(fs.readFileSync(path.join(pasta2, 'meta.json'), 'utf8')).gitCommitHash === shaNovo; }
    catch { return false; }
  }, 5000);
  ok(assentou, `sha final publicado é o do commit novo (shaNovo=${shaNovo})`);
});

// ─── 16. Ganchos de teste fora do tmp ───────────────────────────────────────

await bloco('16. Ganchos de teste fora do tmp — COCKPIT_GRAFO_TESTE_MORRER fora de os.tmpdir() é ignorado, publica normal', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const saidaForaDoTmp = path.join(RAIZ_REPO, '.gate-grafo-saida-fora-do-tmp-16');
  fs.mkdirSync(saidaForaDoTmp, { recursive: true });
  try {
    const r = spawnSync(process.execPath, [BIN_GRAFO, 'gerar', repo, '--saida', saidaForaDoTmp], {
      encoding: 'utf8', env: { ...process.env, COCKPIT_GRAFO_TESTE_MORRER: 'entre-anterior-e-publicar' },
    });
    ok(r.status === 0, `gancho fora do tmp é ignorado: rc0 normal (achei ${r.status}: ${r.stderr})`);
    ok(fs.existsSync(path.join(saidaForaDoTmp, 'knowledge-graph.json')), 'publicou normal (knowledge-graph.json existe)');
  } finally {
    fs.rmSync(saidaForaDoTmp, { recursive: true, force: true });
  }
});

// ─── 17. Só o dono solta a trava ────────────────────────────────────────────
// Achado da revisão do orquestrador: o `finally` do `gerar` chamava `soltarTrava` mesmo quando o
// ciclo tinha devolvido a trava e OUTRO processo já a tinha pegado — apagava a trava alheia.

await bloco('17. soltarTrava só apaga a trava do próprio processo', () => {
  const loja = require(path.join(RAIZ_REPO, 'lib', 'grafo-loja.js'));
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-trava17-'));
  const dono = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(pasta, '.trava'), JSON.stringify({ pid: dono.pid, desde: new Date().toISOString() }));
    loja.soltarTrava(pasta);
    ok(fs.existsSync(path.join(pasta, '.trava')), 'a trava de outro processo vivo continua lá depois do soltarTrava');
    ok(loja.tomarTrava(pasta) === false, 'e continua valendo: tomarTrava devolve false');
    fs.rmSync(path.join(pasta, '.trava'), { force: true });
    ok(loja.tomarTrava(pasta) === true, 'livre, o processo toma a trava');
    loja.soltarTrava(pasta);
    ok(!fs.existsSync(path.join(pasta, '.trava')), 'e solta a PRÓPRIA trava');
    // A corrida medida no gate-grafo-gatilhos (dois "início" no mesmo ms): o 2º lia a `.trava`
    // ainda VAZIA do 1º e a tomava por morta. Trava ilegível e recente é de alguém.
    fs.writeFileSync(path.join(pasta, '.trava'), '');
    ok(loja.tomarTrava(pasta) === false, 'trava vazia e recente (o dono acabou de abrir) conta como ocupada');
    fs.utimesSync(path.join(pasta, '.trava'), new Date(Date.now() - 31 * 60 * 1000), new Date(Date.now() - 31 * 60 * 1000));
    ok(loja.tomarTrava(pasta) === true, 'trava vazia com mais de 30 min é lixo e é retomada');
    loja.soltarTrava(pasta);
  } finally {
    dono.kill('SIGTERM');
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

// ─── 18. inventario e rollout (Fase 8, dry-run) ────────────────────────────

await bloco('18. inventario lista grafo/sem-grafo/sem-develop/.ua legado fora da develop/hook instalado; rollout sem --rodar não escreve', async () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-raiz18-'));
  const mundo = novoMundo();

  // com-grafo: develop com grafo já publicado na loja e hook instalado.
  const comGrafo = path.join(raiz, 'com-grafo');
  fs.mkdirSync(comGrafo);
  git(comGrafo, ['init', '-q', '-b', 'develop']);
  escreverEComitar(comGrafo, { 'a.js': 'export function a() {}\n' }, 'c1');
  const rGerar = rodar(['gerar', comGrafo], mundo);
  ok(rGerar.status === 0, `gerar (fixture do caso 18) rc0 (achei ${rGerar.status}: ${rGerar.stderr})`);
  const rInstalar = spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', comGrafo, '--permitir-worktree'], { encoding: 'utf8' });
  ok(rInstalar.status === 0, `instalar-hook (fixture do caso 18) rc0 (achei ${rInstalar.status}: ${rInstalar.stderr})`);

  // sem-grafo: develop, nunca gerado.
  const semGrafo = path.join(raiz, 'sem-grafo');
  fs.mkdirSync(semGrafo);
  git(semGrafo, ['init', '-q', '-b', 'develop']);
  escreverEComitar(semGrafo, { 'b.js': 'export function b() {}\n' }, 'c1');

  // sem-develop: só main.
  const semDevelop = path.join(raiz, 'sem-develop');
  fs.mkdirSync(semDevelop);
  git(semDevelop, ['init', '-q', '-b', 'main']);
  escreverEComitar(semDevelop, { 'c.js': 'export function c() {}\n' }, 'c1');

  // com-ua-legado: develop + `.ua/` com sha de um commit que NUNCA entrou na develop (branch
  // irmã apagada depois) — nem ancestral nem descendente útil: "fora da develop".
  const comUaLegado = path.join(raiz, 'com-ua-legado');
  fs.mkdirSync(comUaLegado);
  git(comUaLegado, ['init', '-q', '-b', 'develop']);
  escreverEComitar(comUaLegado, { 'd.js': 'export function d() {}\n' }, 'c1');
  git(comUaLegado, ['checkout', '-q', '-b', 'tmp-ua']);
  const shaForaDaDevelop = escreverEComitar(comUaLegado, { 'e.js': 'export function e() {}\n' }, 'c2 (fora da develop)');
  git(comUaLegado, ['checkout', '-q', 'develop']);
  git(comUaLegado, ['branch', '-D', 'tmp-ua']);
  fs.mkdirSync(path.join(comUaLegado, '.ua'), { recursive: true });
  fs.writeFileSync(path.join(comUaLegado, '.ua', 'knowledge-graph.json'), JSON.stringify({ nodes: [], edges: [] }));
  fs.writeFileSync(path.join(comUaLegado, '.ua', 'meta.json'), JSON.stringify({ engine: 'llm', gitCommitHash: shaForaDaDevelop, lastAnalyzedAt: '2026-01-01T00:00:00.000Z' }));

  const rInv = rodar(['inventario', raiz, '--json'], mundo);
  ok(rInv.status === 0, `inventario --json rc0 (achei ${rInv.status}: ${rInv.stderr})`);
  let itens = null;
  try { itens = JSON.parse(rInv.stdout); } catch { /* fica null, o ok abaixo reprova */ }
  ok(Array.isArray(itens), `inventario --json devolve array (achei ${rInv.stdout.slice(0, 200)})`);
  if (Array.isArray(itens)) {
    const porNome = (n) => itens.find((i) => i.pasta === n);
    const cg = porNome('com-grafo');
    ok(Boolean(cg && cg.loja && cg.loja.estado === 'em-dia'), `com-grafo: loja em-dia (achei ${JSON.stringify(cg && cg.loja)})`);
    ok(cg && cg.hookCockpit === 'instalado', `com-grafo: hook instalado (achei ${cg && cg.hookCockpit})`);
    const sg = porNome('sem-grafo');
    ok(Boolean(sg && sg.loja === null), `sem-grafo: loja null (achei ${JSON.stringify(sg && sg.loja)})`);
    ok(sg && sg.hookCockpit === 'não', `sem-grafo: hook não instalado (achei ${sg && sg.hookCockpit})`);
    const sd = porNome('sem-develop');
    ok(Boolean(sd && sd.develop === null), `sem-develop: develop null (achei ${JSON.stringify(sd && sd.develop)})`);
    const legado = porNome('com-ua-legado');
    ok(Boolean(legado && Array.isArray(legado.uaLegado) && legado.uaLegado.length === 1 && legado.uaLegado[0].estado === 'fora da develop'),
      `com-ua-legado: .ua legado listado como "fora da develop" (achei ${JSON.stringify(legado && legado.uaLegado)})`);
  }

  const rRollout = rodar(['rollout', raiz], mundo);
  ok(rRollout.status === 0, `rollout (sem --rodar) rc0 (achei ${rRollout.status}: ${rRollout.stderr})`);
  ok(rRollout.stdout.includes('sem-grafo'), `rollout lista sem-grafo (achei ${rRollout.stdout.slice(0, 300)})`);
  ok(rRollout.stdout.includes('sem-develop'), `rollout lista sem-develop na lista à parte (achei ${rRollout.stdout.slice(0, 300)})`);
  ok(!rRollout.stdout.includes('com-grafo'), `rollout NÃO lista com-grafo (já tem grafo) (achei ${rRollout.stdout.slice(0, 300)})`);
  ok(!fs.existsSync(path.join(mundo.loja, 'sem-grafo')), 'rollout sem --rodar NÃO cria nada na loja de sem-grafo');
});

// ─── 23-24. Achados da rodada 2 do painel de execução ───────────────────────

await bloco('23. sub-trava de retomada abandonada com pid reciclado não trava a loja para sempre', () => {
  const loja = require(path.join(RAIZ_REPO, 'lib', 'grafo-loja.js'));
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-trava23-'));
  const PID_MORTO = (() => { try { return Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1; } catch { return 4194304; } })();
  const vivo = spawn('sleep', ['30'], { stdio: 'ignore' }); // um pid VIVO que não é o retomador (pid reciclado)
  try {
    const velho = new Date(Date.now() - 60 * 60 * 1000);
    fs.writeFileSync(path.join(pasta, '.trava'), JSON.stringify({ pid: PID_MORTO, desde: velho.toISOString() }));
    fs.writeFileSync(path.join(pasta, '.trava.retomada'), JSON.stringify({ pid: vivo.pid, desde: velho.toISOString() }));
    fs.utimesSync(path.join(pasta, '.trava.retomada'), velho, velho);
    ok(loja.tomarTrava(pasta) === true, 'com a sub-trava velha (1 h) de um pid vivo, a trava morta é retomada');
    loja.soltarTrava(pasta);
    ok(!fs.existsSync(path.join(pasta, '.trava.retomada')), 'e a sub-trava velha não fica para trás');
  } finally {
    vivo.kill('SIGTERM');
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

await bloco('24. rollout --rodar pula pasta de nome fora do padrão e segue para a próxima', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-roll24-'));
  for (const nome of ['a.ruim', 'b-boa']) {
    const repo = path.join(raiz, nome);
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'develop']);
    escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  }
  const mundo = novoMundo();
  const r = rodar(['rollout', raiz, '--rodar'], mundo);
  ok(r.status === 0, `rollout --rodar rc0 (achei ${r.status}: ${r.stderr.slice(0, 200)})`);
  ok(fs.existsSync(path.join(mundo.loja, 'b-boa', 'knowledge-graph.json')), 'a pasta válida depois da ruim ganhou grafo');
  ok(!fs.existsSync(path.join(mundo.loja, 'a.ruim')), 'a de nome fora do padrão não foi tocada');
});

// ─── 25-27. Cópia estável do gerador e hook com a loja do instalador ───────
// Spec `2026-10-17-grafo-botao-fazer-grafo`, T1/T2. Antes do bloco 19 (o mais lento).

await bloco('25. bloco com loja embutida — COCKPIT_GRAFOS_DIR prefixa o nohup; sem loja, byte-idêntico ao de hoje; aspa simples recusa', () => {
  const semLoja = hooklib.bloco('post-commit', '/usr/bin/node', '/x/bin/grafo.js');
  const semLojaExplicita = hooklib.bloco('post-commit', '/usr/bin/node', '/x/bin/grafo.js', null);
  ok(semLoja === semLojaExplicita, 'sem loja (padrão) é byte-idêntico a lojaAbs=null');

  for (const nomeDoHook of ['post-commit', 'reference-transaction']) {
    const comLoja = hooklib.bloco(nomeDoHook, '/usr/bin/node', '/x/bin/grafo.js', '/tmp/loja-x');
    ok(comLoja.includes("COCKPIT_GRAFOS_DIR='/tmp/loja-x' nohup '/usr/bin/node'"), `${nomeDoHook}: a chamada ganha o prefixo da loja`);
    const m = /\[ -x '([^']*)' \] && \[ -f '([^']*)' \]/.exec(comLoja);
    ok(Boolean(m) && m[1] === '/usr/bin/node' && m[2] === '/x/bin/grafo.js', `${nomeDoHook}: a regex do status() ainda casa com node e grafo (achei ${m && JSON.stringify([m[1], m[2]])})`);
  }

  let lancou = false;
  try { hooklib.bloco('post-commit', '/usr/bin/node', '/x/bin/grafo.js', "/tmp/loja'x"); }
  catch { lancou = true; }
  ok(lancou, 'loja com aspa simples: bloco() lança');
});

await bloco('26. publicarCopia — fecho exato, publicação atômica por conteúdo, corrida entre processos, roda sozinha', async () => {
  const esperado = [
    'bin/grafo.js', 'lib/grafo-git.js', 'lib/grafo-loja.js', 'lib/grafo-hook.js', 'lib/grafo-inventario.js',
    'lib/grafo-extrator.js', 'lib/grafo-python.js', 'lib/grafo-python.py', 'lib/grafo-js.js', 'lib/grafo-html.js',
  ];
  ok(Array.isArray(hooklib.ARQUIVOS_DO_GERADOR) && JSON.stringify(hooklib.ARQUIVOS_DO_GERADOR) === JSON.stringify(esperado),
    `ARQUIVOS_DO_GERADOR tem exatamente os 10 caminhos da spec T1 (achei ${JSON.stringify(hooklib.ARQUIVOS_DO_GERADOR)})`);

  const copiaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-copia-'));
  process.env.COCKPIT_GRAFO_COPIA_DIR = copiaDir;
  try {
    ok(hooklib.dirCopia() === copiaDir, 'dirCopia() devolve a env');

    const g1 = hooklib.publicarCopia();
    ok(g1.endsWith(path.join('bin', 'grafo.js')), `g1 termina em bin/grafo.js (achei ${g1})`);
    const versoesDir = path.join(copiaDir, 'versoes');
    const nomesVersoes1 = fs.readdirSync(versoesDir);
    ok(nomesVersoes1.length === 1 && /^[0-9a-f]{16}$/.test(nomesVersoes1[0]), `versoes/ tem uma pasta com 16 hex (achei ${JSON.stringify(nomesVersoes1)})`);
    ok(g1 === path.join(versoesDir, nomesVersoes1[0], 'bin', 'grafo.js'), 'g1 está dentro de versoes/<hash>/');

    for (const rel of hooklib.ARQUIVOS_DO_GERADOR) {
      const origemBuf = fs.readFileSync(path.join(RAIZ_REPO, rel));
      const copiaBuf = fs.readFileSync(path.join(versoesDir, nomesVersoes1[0], rel));
      ok(Buffer.compare(origemBuf, copiaBuf) === 0, `${rel}: byte-idêntico na cópia`);
    }

    const g2 = hooklib.publicarCopia();
    ok(g2 === g1, 'publicarCopia() de novo devolve o mesmo caminho');
    const nomesVersoes2 = fs.readdirSync(versoesDir);
    ok(nomesVersoes2.length === 1, `versoes/ continua com UMA entrada (achei ${JSON.stringify(nomesVersoes2)})`);
    ok(!nomesVersoes2.some((n) => n.includes('.tmp')), 'nada .tmp sobrando');

    // Corrida entre processos: 4 spawns simultâneos com a MESMA COCKPIT_GRAFO_COPIA_DIR nova.
    const copiaDirCorrida = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-copia-corrida-'));
    const LIB_HOOK = path.join(RAIZ_REPO, 'lib', 'grafo-hook.js');
    const chamada = `process.stdout.write(require(${JSON.stringify(LIB_HOOK)}).publicarCopia())`;
    const quatro = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', chamada], {
        env: { ...process.env, COCKPIT_GRAFO_COPIA_DIR: copiaDirCorrida },
      });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (rc) => resolve({ rc, stdout, stderr }));
    })));
    ok(quatro.every((r) => r.rc === 0), `4 processos simultâneos: todos rc0 (achei ${quatro.map((r) => r.rc).join(',')} — ${quatro.map((r) => r.stderr).join(' | ')})`);
    const caminhos = quatro.map((r) => r.stdout);
    ok(caminhos.every((c) => c === caminhos[0]), `os 4 imprimem o mesmo caminho (achei ${JSON.stringify(caminhos)})`);
    const versoesDirCorrida = path.join(copiaDirCorrida, 'versoes');
    const nomesCorrida = fs.readdirSync(versoesDirCorrida);
    ok(nomesCorrida.length === 1, `versoes/ da corrida com uma entrada (achei ${JSON.stringify(nomesCorrida)})`);
    ok(!fs.readdirSync(copiaDirCorrida).some((n) => n !== 'versoes'), 'nenhum resíduo temporário na raiz da cópia');
    ok(!nomesCorrida.some((n) => n.includes('.tmp') || n.startsWith('.')), 'nenhum resíduo temporário em versoes/');
    for (const rel of hooklib.ARQUIVOS_DO_GERADOR) {
      const origemBuf = fs.readFileSync(path.join(RAIZ_REPO, rel));
      const copiaBuf = fs.readFileSync(path.join(versoesDirCorrida, nomesCorrida[0], rel));
      ok(Buffer.compare(origemBuf, copiaBuf) === 0, `corrida: ${rel} byte-idêntico`);
    }
    const crypto = require('node:crypto');
    const hash = crypto.createHash('sha256');
    for (const rel of hooklib.ARQUIVOS_DO_GERADOR) {
      hash.update(rel); hash.update('\0'); hash.update(fs.readFileSync(path.join(RAIZ_REPO, rel))); hash.update('\0');
    }
    ok(nomesCorrida[0] === hash.digest('hex').slice(0, 16), `o hash reconferido do zero bate com o nome da pasta (achei ${nomesCorrida[0]})`);

    // Roda sozinha: repo de fixture (develop, a.js importando b.js, c.py).
    const repoIsolado = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-isolado-'));
    git(repoIsolado, ['init', '-q', '-b', 'develop']);
    fs.writeFileSync(path.join(repoIsolado, 'a.js'), "import './b.js';\n");
    fs.writeFileSync(path.join(repoIsolado, 'b.js'), 'export function b() {}\n');
    fs.writeFileSync(path.join(repoIsolado, 'c.py'), 'def c():\n    pass\n');
    git(repoIsolado, ['add', 'a.js', 'b.js', 'c.py']);
    git(repoIsolado, ['commit', '-q', '-m', 'c1']);
    const lojaIsolada = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-isolado-loja-'));
    const rGerar = spawnSync(process.execPath, [g1, 'gerar', repoIsolado], {
      encoding: 'utf8', env: { ...process.env, COCKPIT_GRAFOS_DIR: lojaIsolada },
    });
    ok(rGerar.status === 0, `a cópia roda sozinha: gerar rc0 (achei ${rGerar.status}: ${rGerar.stderr})`);
    const grafoIsolado = JSON.parse(fs.readFileSync(path.join(lojaIsolada, path.basename(repoIsolado), 'knowledge-graph.json'), 'utf8'));
    for (const arq of ['file:a.js', 'file:b.js', 'file:c.py']) {
      ok(grafoIsolado.nodes.some((n) => n.id === arq), `a cópia roda sozinha: ${arq} no grafo`);
    }
    const rStatus = spawnSync(process.execPath, [g1, 'status-hook', repoIsolado], { encoding: 'utf8' });
    ok(rStatus.status === 0, `a cópia roda sozinha: status-hook rc0 (achei ${rStatus.status}: ${rStatus.stderr})`);
  } finally {
    delete process.env.COCKPIT_GRAFO_COPIA_DIR;
  }
});

await bloco('27. instalar com grafoAbs de fora de qualquer repo — release sem .git recusa pela CLI (R1, sem mudar); hooklib.instalar com grafoAbs externo não recusa por worktree', async () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');

  const release = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-release27-'));
  for (const rel of hooklib.ARQUIVOS_DO_GERADOR) {
    const destino = path.join(release, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(path.join(RAIZ_REPO, rel), destino);
  }
  const rCli = spawnSync(process.execPath, [path.join(release, 'bin', 'grafo.js'), 'instalar-hook', repo], { encoding: 'utf8' });
  ok(rCli.status === 2, `release sem .git: instalar-hook pela CLI continua rc2 (achei ${rCli.status})`);
  ok(/not a git repository/i.test(rCli.stderr), `release sem .git: stderr cita "not a git repository" (achei ${JSON.stringify(rCli.stderr)})`);

  const lojaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-loja27-'));
  const g1 = path.join(release, 'bin', 'grafo.js');
  const r = await hooklib.instalar(repo, { grafoAbs: g1, lojaAbs: lojaTmp });
  ok(!r.recusado, `grafoAbs de fora: não recusa por worktree (achei ${r.recusado})`);
  ok(JSON.stringify(r.instalados.slice().sort()) === JSON.stringify(hooklib.HOOKS.slice().sort()), `grafoAbs de fora: os 4 hooks instalados (achei ${JSON.stringify(r.instalados)})`);
  for (const h of hooklib.HOOKS) {
    const conteudo = fs.readFileSync(path.join(repo, '.git', 'hooks', h), 'utf8');
    ok(conteudo.includes(g1), `${h}: contém o caminho de g1`);
    ok(conteudo.includes(`COCKPIT_GRAFOS_DIR='${lojaTmp}'`), `${h}: contém COCKPIT_GRAFOS_DIR da loja tmp`);
  }
  const statusDepois = await hooklib.status(repo);
  for (const h of hooklib.HOOKS) {
    ok(statusDepois[h].estado === 'instalado', `status(): ${h} instalado (achei ${statusDepois[h].estado})`);
  }
});

// ─── 19. Retomada de trava morta: um dono só ────────────────────────────────
// Achado do painel de execução (Codex): `rmSync` da trava morta + escrever a nova deixava dois
// processos que julgaram a MESMA trava morta saírem os dois com `true`. 8 processos largam juntos
// sobre uma trava de pid morto, 10 rodadas: exatamente um dono por rodada.

await bloco('19. Retomada de trava morta — 8 processos, 10 rodadas, nunca dois donos ao mesmo tempo', async () => {
  const LOJA_JS = path.join(RAIZ_REPO, 'lib', 'grafo-loja.js');
  const PID_MORTO = (() => { try { return Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1; } catch { return 4194304; } })();
  const filho = `
    const fs = require('node:fs'); const path = require('node:path');
    const loja = require(${JSON.stringify(LOJA_JS)});
    const [pasta, largada] = process.argv.slice(1);
    while (!fs.existsSync(largada)) { /* espera a largada */ }
    if (loja.tomarTrava(pasta)) {
      fs.writeFileSync(path.join(pasta, 'dono-' + process.pid), '');
      // Dono ATIVO: se outro ativo aparecer enquanto seguro, é colisão (dois donos ao mesmo tempo).
      const meu = path.join(pasta, 'ativo-' + process.pid);
      fs.writeFileSync(meu, '');
      const ate = Date.now() + 300;
      while (Date.now() < ate) {
        if (fs.readdirSync(pasta).some((n) => n.startsWith('ativo-') && n !== 'ativo-' + process.pid)) {
          fs.writeFileSync(path.join(pasta, 'colisao-' + process.pid), '');
          break;
        }
      }
      fs.rmSync(meu, { force: true });
      loja.soltarTrava(pasta);
    }`;
  const rodadasRuins = [];
  for (let rodada = 1; rodada <= 10; rodada += 1) {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-trava19-'));
    const velho = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(pasta, '.trava'), JSON.stringify({ pid: PID_MORTO, desde: velho }));
    const largada = path.join(pasta, 'largada');
    const procs = Array.from({ length: 8 }, () => new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', filho, pasta, largada], { stdio: 'ignore' });
      p.on('close', (rc) => resolve(rc));
    }));
    await esperarMsAsync(300);
    fs.writeFileSync(largada, '');
    const rcs = await Promise.all(procs);
    // Controle do próprio teste (achado do painel): 8 filhos que morressem todos passariam "sem
    // colisão". Cada rodada exige rc 0 de todos e pelo menos UM dono.
    if (rcs.some((rc) => rc !== 0)) rodadasRuins.push(`rodada ${rodada}: filho com rc ${rcs.filter((rc) => rc !== 0).join(',')}`);
    if (!fs.readdirSync(pasta).some((n) => n.startsWith('dono-'))) rodadasRuins.push(`rodada ${rodada}: ninguém virou dono`);
    const colisoes = fs.readdirSync(pasta).filter((n) => n.startsWith('colisao-')).length;
    if (colisoes) rodadasRuins.push(`rodada ${rodada}: ${colisoes} processo(s) viram outro dono ao mesmo tempo`);
    fs.rmSync(pasta, { recursive: true, force: true });
  }
  ok(rodadasRuins.length === 0, `nunca dois donos ao mesmo tempo nas 10 rodadas (${rodadasRuins.join(', ') || 'todas certas'})`);
});

// ─── 20-22. Achados do Codex no painel de execução ──────────────────────────

await bloco('20. inventário com pasta de nome fora do padrão não derruba a listagem', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-inv20-'));
  const repo = path.join(raiz, 'app.exemplo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'develop']);
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const mundo = novoMundo();
  const r = rodar(['inventario', raiz, '--json'], mundo);
  ok(r.status === 0, `inventario rc0 (achei ${r.status}: ${r.stderr.slice(0, 200)})`);
  let lista = [];
  try { lista = JSON.parse(r.stdout); } catch { /* vira o assert abaixo */ }
  const item = lista.find((i) => i.pasta === 'app.exemplo');
  ok(Boolean(item) && item.nomeValido === false && item.loja === null, `a pasta aparece como nome fora do padrão, sem loja (achei ${JSON.stringify(item)})`);
});

await bloco('21. hook de terceiro não conta como "instalado" no inventário', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-hook-inv21-'));
  const repo = path.join(raiz, 'app-terceiro');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'develop']);
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n' }, 'c1');
  const hooksDir = path.join(repo, '.git', 'hooks');
  for (const h of ['post-commit', 'post-merge', 'post-rewrite', 'reference-transaction']) {
    fs.writeFileSync(path.join(hooksDir, h), '#!/bin/sh\necho terceiro\n');
    fs.chmodSync(path.join(hooksDir, h), 0o755);
  }
  const mundo = novoMundo();
  const hookDe = () => {
    const r = rodar(['inventario', raiz, '--json'], mundo);
    try { return JSON.parse(r.stdout).find((i) => i.pasta === 'app-terceiro').hookCockpit; } catch { return `rc=${r.status} ${r.stderr.slice(0, 120)}`; }
  };
  ok(hookDe() === 'não', `só hooks de terceiro → "não" (achei ${hookDe()})`);
  spawnSync(process.execPath, [BIN_GRAFO, 'instalar-hook', repo, '--permitir-worktree'], { encoding: 'utf8', env: envDe(mundo) });
  ok(hookDe() === 'parcial', `três com o bloco e o reference-transaction de terceiro intocado → "parcial" (achei ${hookDe()})`);
});

await bloco('22. arquivo acima de 512 KB que a CLI tira fica no aviso do meta.json', () => {
  const repo = novoRepoVazio('develop');
  escreverEComitar(repo, { 'a.js': 'export function f() {}\n', 'grande.js': `// ${'x'.repeat(524289)}\n` }, 'c1');
  const mundo = novoMundo();
  const r = rodar(['gerar', repo], mundo);
  ok(r.status === 0, `gerar rc0 (achei ${r.status}: ${r.stderr})`);
  const meta = lerMeta(mundo, path.basename(repo));
  ok((meta.avisos || []).some((a) => /1 arquivo\(s\) acima de 512 KB/.test(a)), `meta.avisos cita o arquivo grande (achei ${JSON.stringify(meta.avisos)})`);
});

ok(JSON.stringify(listarLojaReal()) === LOJA_REAL_ANTES,
  `a loja REAL (${LOJA_REAL}) não ganhou nem perdeu nada durante o gate`);
console.log(`\n${passou}/${total} asserções`);
console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — hooks e geração pela develop (1-7, 9, 11-24)');
process.exitCode = vermelho ? 1 : 0;

}

principal();
