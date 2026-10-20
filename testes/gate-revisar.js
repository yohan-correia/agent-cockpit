#!/usr/bin/env node
'use strict';
// GATE da tela "Pra revisar" (plano docs/superpowers/plans/2026-10-04-tela-pra-revisar-plano.md,
// Fase A). Prova o SERVIDOR de verdade, molde de `gate-jobs-rota.js`: sobe `server.js` DE
// VERDADE (mesmo processo) e fala HTTP com ele, com uma pasta de jobs E repositórios git
// fabricados em `os.tmpdir()`.
//
// Nasce VERMELHO de propósito (Fase A): `?revisar=1` e `/api/jobs/resultado` ainda não existem
// em `server.js`, nem `lib/revisar.js`. A Fase B implementa os dois e este MESMO arquivo passa
// a fechar verde — nenhum assert daqui é reescrito para isso, só a produção muda.
//
// Uso:  node testes/gate-revisar.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };
let falhas = 0;

// ─── Portas — 7891-7898, nunca 7879 (produção) nem 7899 (gate dos jobs do orquestrador, #24) ───

function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => {
      const campos = linha.trim().split(/\s+/);
      return (campos[3] || '').endsWith(`:${porta}`);
    });
  } catch {
    return true; // `ss` indisponível — o `listen()` denuncia se a porta estiver ocupada
  }
}

const PORTA_SERVIDOR = Number(process.env.PORT || 7892);

for (const p of [PORTA_SERVIDOR]) {
  if (p < 7891 || p > 7898) {
    console.error(`🔴 porta ${p} fora da faixa 7891-7898 — nunca 7879 (produção) nem 7899 (#24).`);
    process.exit(2);
  }
  if (!portaLivre(p)) {
    console.error(`🔴 a porta ${p} já está ocupada (conferido com \`ss -H -lptn\`). Tente outra.`);
    process.exit(1);
  }
}

// ─── tmux — socket PRÓPRIO, nunca o `main` do usuário (D35) ────────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(2);
}
const SOCKET_TMUX = `gate-revisar-${process.pid}`;
try {
  execFileSync('tmux', ['-L', SOCKET_TMUX, 'ls'], { stdio: 'ignore' });
  console.error(`🔴 o socket ${SOCKET_TMUX} já existe — não é meu. Abortando.`);
  process.exit(1);
} catch { /* esperado: socket fabricado com o próprio pid, não deveria existir */ }

const CERT_DIR_VAZIO = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-cert-'));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Identidade do git — o HOME do `npm test` é vazio (bin/testes.js:9-12) ──────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Gate Revisar', GIT_AUTHOR_EMAIL: 'gate-revisar@localhost',
  GIT_COMMITTER_NAME: 'Gate Revisar', GIT_COMMITTER_EMAIL: 'gate-revisar@localhost',
};
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, stdio: 'pipe' }).toString('utf8');
}
function escreve(repo, nome, conteudo) {
  fs.writeFileSync(path.join(repo, nome), conteudo);
}
let contadorCommit = 0;
function commit(repo, msg, nome = 'arquivo.txt') {
  contadorCommit += 1;
  escreve(repo, nome, `${msg}-${contadorCommit}-${Math.random()}`);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', msg]);
}

/** Um repo com `main` + `develop`, um commit inicial em cada. */
function novoRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-repo-'));
  git(dir, ['init', '-b', 'main', '-q']);
  commit(dir, 'inicial');
  git(dir, ['branch', 'develop']);
  return dir;
}

/** Uma pasta qualquer que EXISTE no disco — o suficiente para o passo 2 (worktree). */
function dirExistente() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-wt-'));
}

// ─── Os repositórios dos doze casos (a-m) ───────────────────────────────────────────────────

// (a) pendente: feature com commit de verdade, nunca tocada em develop.
function repoPendente() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-a']);
  commit(dir, 'feat a');
  return { dir, branch: 'feat-a' };
}

// (b) a branch já foi mergeada em develop com --no-ff (é ancestral — passo 7).
function repoNoFF() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-b']);
  commit(dir, 'feat b');
  git(dir, ['checkout', 'develop']);
  git(dir, ['merge', '--no-ff', 'feat-b', '-m', 'merge no-ff de feat-b']);
  return { dir, branch: 'feat-b' };
}

// (c) squash: o conteúdo da branch já entrou em develop por um commit equivalente (mesmo
// patch, outro sha) — develop segue adiante com algo mais, então o diff não fica vazio, e é
// o `git cherry` (passo 10) quem tem de reconhecer a equivalência.
function repoSquash() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-c']);
  commit(dir, 'feat c', 'squash.txt');
  git(dir, ['checkout', 'develop']);
  // Mesmo conteúdo de squash.txt, commitado direto em develop — não é merge, é "squash manual".
  git(dir, ['checkout', 'feat-c', '--', 'squash.txt']);
  git(dir, ['commit', '-m', 'squash de feat-c']);
  commit(dir, 'segue andando'); // develop anda mais — sem isto o diff ficaria vazio (caso l)
  return { dir, branch: 'feat-c' };
}

// (d) só em origin/develop: o local `develop` nunca viu a branch, mas um clone empurrou o
// merge para o `origin` — e é ESSE ref que precisa decidir (passo 8).
function repoSoOrigin() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-d']);
  commit(dir, 'feat d');
  git(dir, ['checkout', 'develop']);

  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-bare-')), 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { env: GIT_ENV });
  git(dir, ['remote', 'add', 'origin', bare]);
  git(dir, ['push', 'origin', 'develop', 'feat-d']);

  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-clone-'));
  execFileSync('git', ['clone', '-q', bare, clone], { env: GIT_ENV });
  git(clone, ['checkout', 'develop']);
  git(clone, ['merge', 'origin/feat-d', '-m', 'merge de feat-d só no origin']);
  git(clone, ['push', 'origin', 'develop']);

  // Atualiza SÓ o ref remoto (`refs/remotes/origin/develop`); o `develop` local de `dir`
  // continua intocado — é esse descompasso que o caso testa.
  git(dir, ['fetch', 'origin']);
  return { dir, branch: 'feat-d' };
}

// (e') repo sem develop E sem main (v2: a base cai pra `main`; aqui nem ela existe).
function repoSemBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-repo-'));
  git(dir, ['init', '-b', 'trunk', '-q']);
  commit(dir, 'inicial');
  git(dir, ['checkout', '-b', 'feat-e']);
  commit(dir, 'feat e');
  return { dir, branch: 'feat-e' };
}

// (o)/(o2) repo sem develop, com `main`: a base é `main` (v2, regra 1). `feat-o` já foi
// mergeada em main com --no-ff (sai); `feat-o2` tem commit fora dela (entra, sem etiqueta).
function repoSemDevelopComMain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-repo-'));
  git(dir, ['init', '-b', 'main', '-q']);
  commit(dir, 'inicial');
  git(dir, ['checkout', '-b', 'feat-o']);
  commit(dir, 'feat o');
  git(dir, ['checkout', 'main']);
  git(dir, ['merge', '--no-ff', 'feat-o', '-m', 'merge no-ff de feat-o']);
  git(dir, ['checkout', '-b', 'feat-o2']);
  commit(dir, 'feat o2');
  git(dir, ['checkout', 'main']);
  return { dir };
}

// O git recusa `worktree add` de branch já em checkout: todo helper de repo termina com HEAD
// em `develop`/`main`, e cada grupo que precisa de worktree real usa uma instância própria.
function worktreeReal(repo, branch) {
  const alvo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-wtreal-')), 'wt');
  git(repo, ['worktree', 'add', alvo, branch]);
  return alvo;
}

function symlinkPara(alvo) {
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-link-')), 'link');
  fs.symlinkSync(alvo, link);
  return link;
}

// (r)/(r2) `feat-r2` e `feat-r3` (ramos independentes) contêm `feat-r1`.
function repoEmpilhado() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-r1']);
  commit(dir, 'feat r1', 'r1.txt');
  git(dir, ['checkout', '-b', 'feat-r2']);
  commit(dir, 'feat r2', 'r2.txt');
  git(dir, ['checkout', 'feat-r1']);
  git(dir, ['checkout', '-b', 'feat-r3']);
  commit(dir, 'feat r3', 'r3.txt');
  git(dir, ['checkout', 'develop']);
  return { dir };
}

// (r3) gêmeas: duas branches no MESMO sha.
function repoGemeas() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-t1']);
  commit(dir, 'feat t');
  git(dir, ['branch', 'feat-t2']);
  git(dir, ['checkout', 'develop']);
  return { dir };
}

// (r4) cadeia: feat-u1 ⊂ feat-u2 ⊂ feat-u3.
function repoCadeia() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-u1']);
  commit(dir, 'feat u1', 'u1.txt');
  git(dir, ['checkout', '-b', 'feat-u2']);
  commit(dir, 'feat u2', 'u2.txt');
  git(dir, ['checkout', '-b', 'feat-u3']);
  commit(dir, 'feat u3', 'u3.txt');
  git(dir, ['checkout', 'develop']);
  return { dir };
}

// (p)/(p2)/(p3) `feat-p` com commit; `feat-p3` nasce da develop com commit próprio (não
// contém `feat-p`). HEAD volta pra develop. Uma instância por caso (worktree real em feat-p).
function repoRetomada() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-p']);
  commit(dir, 'feat p', 'p.txt');
  git(dir, ['checkout', 'develop']);
  git(dir, ['checkout', '-b', 'feat-p3']);
  commit(dir, 'feat p3', 'p3.txt');
  git(dir, ['checkout', 'develop']);
  return { dir };
}

// (q)/(q2) `develop` + `outra-branch` com commit, HEAD em develop (outra-branch fica livre
// pra worktree real). Uma instância por caso.
function repoBranchLivre() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'outra-branch']);
  commit(dir, 'outra', 'outra.txt');
  git(dir, ['checkout', 'develop']);
  return { dir };
}

// (v) um caminho que NÃO é repo git: o `for-each-ref` falha → erro de git, nunca "branch sumiu".
function repoQuebrado() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-quebrado-'));
}

// (l) diff vazio: commit VAZIO na branch (sem develop ter visto nada, e sem conteúdo nenhum
// para o `cherry` nem avaliar).
function repoDiffVazio() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-l']);
  git(dir, ['commit', '--allow-empty', '-m', 'commit vazio']);
  return { dir, branch: 'feat-l' };
}

// (w) conflito de merge: a branch e a develop mexem no mesmo arquivo (prévia do merge, só leitura).
function repoConflito() {
  const dir = novoRepo();
  git(dir, ['checkout', '-b', 'feat-w']);
  escreve(dir, 'arquivo.txt', 'lado w\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'w']);
  git(dir, ['checkout', 'develop']);
  escreve(dir, 'arquivo.txt', 'lado develop\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'develop do w']);
  return { dir, branch: 'feat-w' };
}

// ─── A pasta de jobs de mentira (meta.json + status.log, do jeito que `lib/jobs.js` lê) ────

const RAIZ_JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisar-jobs-'));

// `created_at` no formato dos metas reais (`+00:00`, não `Z`): a regra compara como string.
const agoraComoNoDisco = () => new Date().toISOString().replace('Z', '+00:00');
const ONTEM = new Date(Date.now() - 86400e3).toISOString().replace('Z', '+00:00');
const HOJE = agoraComoNoDisco();

// Um pid que NÃO existe — "meta diz running, mas não há processo nem tmux" (caso g2).
const PID_MORTO = (() => {
  try { return Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1; }
  catch { return 4194304; }
})();

function limparJobs() {
  fs.rmSync(RAIZ_JOBS, { recursive: true, force: true });
  fs.mkdirSync(RAIZ_JOBS, { recursive: true });
}

/**
 * Planta um job no disco. `linhaLog` já vem PRONTA (string da última linha do `status.log`,
 * ou `null` para não escrever o arquivo) — este gate testa a REGRA, não o parser de
 * `ultimoEvento()` (que já tem o gate dele em `gate-jobs-disco.js`).
 */
function plantarJob({ id, sourceRepo, worktree, branch, metaStatus, linhaLog, resultMd, createdAt, metaExtra = {} }) {
  const dir = path.join(RAIZ_JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id, type: 'ataca', project: `/home/x/${id}`, title: `título de ${id}`,
    created_at: createdAt ?? agoraComoNoDisco(), origin: 'capitao',
    source_repo: sourceRepo ?? '', worktree: worktree ?? '', branch: branch ?? '',
    status: metaStatus ?? 'done', pid: PID_MORTO, ...metaExtra,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  if (linhaLog !== null && linhaLog !== undefined) fs.writeFileSync(path.join(dir, 'status.log'), `${linhaLog}\n`);
  if (resultMd !== undefined) fs.writeFileSync(path.join(dir, 'result.md'), resultMd);
}

function linhaDone(texto = 'tudo certo') { return `${new Date().toISOString()} done: ${texto}`; }
function linhaNeedsReview(texto = 'revisão pendente') {
  // O kind tem HÍFEN — o regex de `lib/jobs.js:93` não casa (`\w+` não inclui `-`), e a
  // linha CRUA inteira volta como `event.text` (Suposições do plano).
  return `${new Date().toISOString()} needs-review: ${texto}`;
}
function linhaFailed(texto = 'quebrou') { return `${new Date().toISOString()} failed: ${texto}`; }

// ─── HTTP ────────────────────────────────────────────────────────────────────────────────

function pedir(caminho) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORTA_SERVIDOR, path: caminho }, (res) => {
      let corpo = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, corpo: JSON.parse(corpo), bruto: corpo }); }
        catch (e) { reject(new Error(`resposta não é JSON (${res.statusCode}): ${corpo.slice(0, 200)} — ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// Todas as respostas vistas durante a corrida — para o assert global de "não vazou tmpdir".
const RESPOSTAS_VISTAS = [];
async function pedirEGuardar(caminho) {
  const r = await pedir(caminho);
  RESPOSTAS_VISTAS.push(r.bruto);
  return r;
}

// ─── Os doze casos da regra (a-m) ────────────────────────────────────────────────────────

async function testeRegra() {
  limparJobs();

  const a = repoPendente();
  const b = repoNoFF();
  const c = repoSquash();
  const d = repoSoOrigin();
  const e = repoSemBase();
  const l = repoDiffVazio();
  const wtApagado = path.join(os.tmpdir(), 'gate-revisar-nunca-existiu');

  plantarJob({ id: 'caso-a-pendente', sourceRepo: a.dir, worktree: dirExistente(), branch: a.branch, linhaLog: linhaDone() });
  plantarJob({ id: 'caso-b-noff', sourceRepo: b.dir, worktree: dirExistente(), branch: b.branch, linhaLog: linhaDone() });
  plantarJob({ id: 'caso-c-squash', sourceRepo: c.dir, worktree: dirExistente(), branch: c.branch, linhaLog: linhaDone() });
  plantarJob({ id: 'caso-d-origin', sourceRepo: d.dir, worktree: dirExistente(), branch: d.branch, linhaLog: linhaDone() });
  plantarJob({ id: 'caso-e-sembase', sourceRepo: e.dir, worktree: dirExistente(), branch: e.branch, linhaLog: linhaDone() });
  plantarJob({ id: 'caso-f-failed', sourceRepo: a.dir, worktree: dirExistente(), branch: a.branch, metaStatus: 'failed', linhaLog: linhaFailed() });
  plantarJob({
    id: 'caso-g1-needsreview-meta-igual', sourceRepo: a.dir, worktree: dirExistente(), branch: a.branch,
    metaStatus: 'needs-review', linhaLog: linhaNeedsReview(),
  });
  plantarJob({
    id: 'caso-g2-needsreview-meta-running', sourceRepo: a.dir, worktree: dirExistente(), branch: a.branch,
    metaStatus: 'running', linhaLog: linhaNeedsReview(),
  });
  plantarJob({ id: 'caso-h-worktree-apagada', sourceRepo: a.dir, worktree: wtApagado, branch: a.branch, linhaLog: linhaDone() });
  plantarJob({ id: 'caso-i-branch-flag', sourceRepo: a.dir, worktree: dirExistente(), branch: '-x', linhaLog: linhaDone() });
  plantarJob({ id: 'caso-j-branch-sem-ref', sourceRepo: a.dir, worktree: dirExistente(), branch: 'nunca-existiu', linhaLog: linhaDone() });
  plantarJob({ id: 'caso-k-source-repo-vazio', sourceRepo: '', worktree: dirExistente(), branch: a.branch, linhaLog: linhaDone() });
  plantarJob({ id: 'caso-l-diff-vazio', sourceRepo: l.dir, worktree: dirExistente(), branch: l.branch, linhaLog: linhaDone() });
  const w = repoConflito();
  plantarJob({ id: 'caso-w-conflito', sourceRepo: w.dir, worktree: dirExistente(), branch: w.branch, linhaLog: linhaDone() });
  // (m) scout: worktree E branch vazias — job sem código, não há o que mergear (passo 2b,
  // desvio decidido na execução do Gate C, plano 2026-10-04).
  plantarJob({ id: 'caso-m-scout-sem-codigo', sourceRepo: a.dir, worktree: '', branch: '', linhaLog: linhaDone() });
  // Etiqueta `parou-no-limite` (contrato): o `result.md` casa /hit your (session )?limit/i nos
  // primeiros 4 KB. Par positivo/negativo, no mesmo repo pendente do (a).
  plantarJob({
    id: 'caso-n-parou-no-limite', sourceRepo: a.dir, worktree: dirExistente(), branch: a.branch,
    linhaLog: linhaDone(), resultMd: "You've hit your session limit · resets 3pm\n",
  });
  plantarJob({
    id: 'caso-n2-relatorio-normal', sourceRepo: a.dir, worktree: dirExistente(), branch: a.branch,
    linhaLog: linhaDone(), resultMd: 'done: tudo certo\n',
  });

  // ── v2: casos o–v (docs/superpowers/specs/2026-10-06-pra-revisar-v2-design.md) ──
  const o = repoSemDevelopComMain();
  plantarJob({ id: 'caso-o-main-contem', sourceRepo: o.dir, worktree: dirExistente(), branch: 'feat-o', linhaLog: linhaDone() });
  plantarJob({ id: 'caso-o2-fora-da-main', sourceRepo: o.dir, worktree: dirExistente(), branch: 'feat-o2', linhaLog: linhaDone() });

  // (p) retomada: worktree compartilhada (symlink). Os ids em ordem contrária à data provam
  // que a regra lê `created_at`, não o id.
  const pA = repoRetomada();
  const dA = worktreeReal(pA.dir, 'feat-p');
  plantarJob({
    id: 'caso-p9-original', sourceRepo: pA.dir, worktree: dA, branch: 'feat-p',
    metaStatus: 'needs-review', linhaLog: linhaNeedsReview(), createdAt: ONTEM,
  });
  plantarJob({
    id: 'caso-p1-retomada', sourceRepo: pA.dir, worktree: symlinkPara(dA), branch: 'job-p2-nunca-existiu',
    linhaLog: linhaDone(), createdAt: HOJE,
  });

  // (p2) a retomada falhou: o original continua na lista, a retomada sai pelo passo 1.
  const pB = repoRetomada();
  const dB = worktreeReal(pB.dir, 'feat-p');
  plantarJob({
    id: 'caso-p2-9-original', sourceRepo: pB.dir, worktree: dB, branch: 'feat-p',
    metaStatus: 'needs-review', linhaLog: linhaNeedsReview(), createdAt: ONTEM,
  });
  plantarJob({
    id: 'caso-p2-1-retomada-failed', sourceRepo: pB.dir, worktree: symlinkPara(dB), branch: 'job-p2-nunca-existiu',
    metaStatus: 'failed', linhaLog: linhaFailed(), createdAt: HOJE,
  });

  // (p3) a "retomada" tem branch própria que NÃO contém o original: os dois ficam.
  const pC = repoRetomada();
  const dC = worktreeReal(pC.dir, 'feat-p');
  plantarJob({ id: 'caso-p3-9-original', sourceRepo: pC.dir, worktree: dC, branch: 'feat-p', linhaLog: linhaDone(), createdAt: ONTEM });
  plantarJob({ id: 'caso-p3-1-outra-branch', sourceRepo: pC.dir, worktree: symlinkPara(dC), branch: 'feat-p3', linhaLog: linhaDone(), createdAt: HOJE });
  // (p4) retomada DA retomada: três jobs na mesma worktree real. A intermediária também tem
  // `meta.branch` que nunca existiu — ela é membro do grupo (original da última), então resolve a
  // branch pela worktree e sai como RETOMADO; nunca cai em "branch sumiu" (painel de execução, Codex).
  const pD = repoRetomada();
  const dD = worktreeReal(pD.dir, 'feat-p');
  const ANTEONTEM = new Date(Date.now() - 2 * 86400e3).toISOString().replace('Z', '+00:00');
  plantarJob({ id: 'caso-p4-9-original', sourceRepo: pD.dir, worktree: dD, branch: 'feat-p', linhaLog: linhaDone(), createdAt: ANTEONTEM });
  plantarJob({ id: 'caso-p4-5-intermediaria', sourceRepo: pD.dir, worktree: symlinkPara(dD), branch: 'job-p4-nunca-1', linhaLog: linhaDone(), createdAt: ONTEM });
  plantarJob({ id: 'caso-p4-1-final', sourceRepo: pD.dir, worktree: symlinkPara(dD), branch: 'job-p4-nunca-2', linhaLog: linhaDone(), createdAt: HOJE });

  // (k2) dois jobs do mesmo repo com worktree vazia: nunca formam grupo.
  plantarJob({ id: 'caso-k2-a', sourceRepo: a.dir, worktree: '', branch: a.branch, linhaLog: linhaDone() });
  plantarJob({ id: 'caso-k2-b', sourceRepo: a.dir, worktree: '', branch: a.branch, linhaLog: linhaDone() });

  // (q)/(q2) branch do meta sumiu, worktree real em outra branch, sem irmão.
  const qA = repoBranchLivre();
  plantarJob({ id: 'caso-q-branch-sumiu', sourceRepo: qA.dir, worktree: worktreeReal(qA.dir, 'outra-branch'), branch: 'nunca-existiu', linhaLog: linhaDone() });
  const qB = repoBranchLivre();
  plantarJob({
    id: 'caso-q2-branch-sumiu-needsreview', sourceRepo: qB.dir, worktree: worktreeReal(qB.dir, 'outra-branch'), branch: 'nunca-existiu',
    metaStatus: 'needs-review', linhaLog: linhaNeedsReview(),
  });

  // (v) erro ao ler os refs não é "branch sumiu".
  plantarJob({ id: 'caso-v-repo-quebrado', sourceRepo: repoQuebrado(), worktree: dirExistente(), branch: 'feat-x', linhaLog: linhaDone() });

  // (r)/(r2) contida: r1 ⊂ r2 e r1 ⊂ r3 (ramos independentes).
  const r = repoEmpilhado();
  plantarJob({ id: 'caso-r1-base', sourceRepo: r.dir, worktree: dirExistente(), branch: 'feat-r1', linhaLog: linhaDone() });
  plantarJob({ id: 'caso-r2-cima', sourceRepo: r.dir, worktree: dirExistente(), branch: 'feat-r2', linhaLog: linhaDone() });
  plantarJob({ id: 'caso-r3-cima', sourceRepo: r.dir, worktree: dirExistente(), branch: 'feat-r3', linhaLog: linhaDone() });

  // (r3) gêmeas no mesmo sha: só a mais velha é contida.
  const t = repoGemeas();
  plantarJob({ id: 'caso-t9-gemea-velha', sourceRepo: t.dir, worktree: dirExistente(), branch: 'feat-t1', linhaLog: linhaDone(), createdAt: ONTEM });
  plantarJob({ id: 'caso-t1-gemea-nova', sourceRepo: t.dir, worktree: dirExistente(), branch: 'feat-t2', linhaLog: linhaDone(), createdAt: HOJE });

  // (r4) cadeia u1 ⊂ u2 ⊂ u3.
  const u = repoCadeia();
  plantarJob({ id: 'caso-u1', sourceRepo: u.dir, worktree: dirExistente(), branch: 'feat-u1', linhaLog: linhaDone() });
  plantarJob({ id: 'caso-u2', sourceRepo: u.dir, worktree: dirExistente(), branch: 'feat-u2', linhaLog: linhaDone() });
  plantarJob({ id: 'caso-u3', sourceRepo: u.dir, worktree: dirExistente(), branch: 'feat-u3', linhaLog: linhaDone() });


  const resp = await pedirEGuardar('/api/jobs?revisar=1');
  ok(resp.status === 200, `GET /api/jobs?revisar=1 responde 200 (veio ${resp.status})`);
  const jobsPorId = new Map((resp.corpo.jobs || []).map((j) => [j.id, j]));
  ok(Array.isArray(resp.corpo.atencao), `a resposta tem atencao[] (array) — ${JSON.stringify(resp.corpo.atencao)}`);
  const atencaoPorId = new Map((Array.isArray(resp.corpo.atencao) ? resp.corpo.atencao : []).map((j) => [j.id, j]));
  ok((resp.corpo.jobs || []).every((j) => Array.isArray(j.retomou) && Array.isArray(j.inclui)),
    'todo item de jobs[] tem retomou[] e inclui[] (arrays)');

  ok(resp.corpo.habilitado === true, `habilitado:true com a pasta de jobs presente — ${JSON.stringify(resp.corpo.habilitado)}`);

  ok(jobsPorId.has('caso-a-pendente') && (jobsPorId.get('caso-a-pendente').etiquetas || []).length === 0,
    `(a) controle negativo: pendente simples continua (o 4236 do disco real) — sem etiqueta de regra — ${JSON.stringify(jobsPorId.get('caso-a-pendente'))}`);
  ok(jobsPorId.get('caso-a-pendente')?.merge?.estado === 'limpo' && jobsPorId.get('caso-a-pendente').merge.base === 'develop',
    `(merge) caso (a) sai "merge limpo" na develop — ${JSON.stringify(jobsPorId.get('caso-a-pendente')?.merge)}`);
  const mw = jobsPorId.get('caso-w-conflito')?.merge;
  ok(mw && mw.estado === 'conflito' && mw.n === 1 && JSON.stringify(mw.arquivos) === '["arquivo.txt"]',
    `(merge) caso (w) conflito com o nome do arquivo — ${JSON.stringify(mw)}`);
  ok((jobsPorId.get('caso-w-conflito')?.etiquetas || []).length === 0, '(merge) conflito NÃO vira etiqueta — o filtro e o Gate C não mudam');
  ok(!jobsPorId.has('caso-b-noff'), '(b) --no-ff em develop: SAI (é ancestral — passo 7)');
  ok(!jobsPorId.has('caso-c-squash'), '(c) squash em develop: SAI (git cherry sem "+" — passo 10)');
  ok(!jobsPorId.has('caso-d-origin'), '(d) só em origin/develop: SAI (passo 8)');
  ok(jobsPorId.has('caso-e-sembase') && (jobsPorId.get('caso-e-sembase').etiquetas || []).includes('sem-base'),
    `(e') repo sem develop nem main: entra com "sem-base" — ${JSON.stringify(jobsPorId.get('caso-e-sembase'))}`);
  ok(!jobsPorId.has('caso-f-failed'), '(f) estado failed: SAI (passo 1, nem chega no git)');
  ok(jobsPorId.has('caso-g1-needsreview-meta-igual') && Boolean(jobsPorId.get('caso-g1-needsreview-meta-igual').fim),
    `(g1) needs-review com meta igual: entra, \`fim\` preenchido — ${JSON.stringify(jobsPorId.get('caso-g1-needsreview-meta-igual'))}`);
  ok(jobsPorId.has('caso-g2-needsreview-meta-running'),
    `(g2) needs-review no log com meta \`running\` sem pid/tmux: ENTRA mesmo assim (a regra ignora o estado de \`jobs.js\`) — ${JSON.stringify(jobsPorId.get('caso-g2-needsreview-meta-running'))}`);
  ok(!jobsPorId.has('caso-h-worktree-apagada'), '(h) worktree apagada: SAI (passo 2, nem chega no git)');
  ok(jobsPorId.has('caso-i-branch-flag') && (jobsPorId.get('caso-i-branch-flag').etiquetas || []).includes('nao-sei'),
    `(i) branch "-x": entra com "nao-sei", sem executar git com ela (passo 4) — ${JSON.stringify(jobsPorId.get('caso-i-branch-flag'))}`);
  ok(!jobsPorId.has('caso-j-branch-sem-ref') && (atencaoPorId.get('caso-j-branch-sem-ref')?.etiquetas || []).includes('branch-sumiu'),
    `(j') branch do meta sem ref: vai pra atencao[] com "branch-sumiu" — ${JSON.stringify(atencaoPorId.get('caso-j-branch-sem-ref'))}`);
  ok(jobsPorId.has('caso-k-source-repo-vazio') && (jobsPorId.get('caso-k-source-repo-vazio').etiquetas || []).includes('nao-sei'),
    `(k) source_repo vazio: entra com "nao-sei" — ${JSON.stringify(jobsPorId.get('caso-k-source-repo-vazio'))}`);
  ok(!jobsPorId.has('caso-l-diff-vazio'), '(l) diff vazio com commit vazio na branch: SAI (passo 9)');
  ok((jobsPorId.get('caso-n-parou-no-limite')?.etiquetas || []).includes('parou-no-limite'),
    `(n) result.md com "hit your session limit": entra com "parou-no-limite" — ${JSON.stringify(jobsPorId.get('caso-n-parou-no-limite'))}`);
  ok(jobsPorId.has('caso-n2-relatorio-normal') && !(jobsPorId.get('caso-n2-relatorio-normal').etiquetas || []).includes('parou-no-limite'),
    `(n2) result.md normal: SEM "parou-no-limite" — ${JSON.stringify(jobsPorId.get('caso-n2-relatorio-normal'))}`);
  ok(!jobsPorId.has('caso-m-scout-sem-codigo'), '(m) scout: worktree E branch vazias — SAI (passo 2b, sem código pra mergear)');

  // ── v2: casos o–v ──
  const etq = (id) => (jobsPorId.get(id)?.etiquetas || []);
  const idsDe = (lista) => (lista || []).map((x) => x.id).sort();
  ok(!jobsPorId.has('caso-o-main-contem') && !atencaoPorId.has('caso-o-main-contem'),
    '(o) repo sem develop, branch mergeada em main: SAI (a base é main)');
  ok(jobsPorId.has('caso-o2-fora-da-main') && etq('caso-o2-fora-da-main').length === 0,
    `(o2) repo sem develop, branch com commit fora de main: entra SEM etiqueta — ${JSON.stringify(jobsPorId.get('caso-o2-fora-da-main'))}`);

  const p1 = jobsPorId.get('caso-p1-retomada');
  ok(!jobsPorId.has('caso-p9-original') && !atencaoPorId.has('caso-p9-original'), '(p) o original retomado SAI da lista');
  ok(Boolean(p1) && etq('caso-p1-retomada').includes('retomada') && !etq('caso-p1-retomada').includes('nao-sei') && !etq('caso-p1-retomada').includes('branch-sumiu')
    && !atencaoPorId.has('caso-p1-retomada'),
    `(p) a retomada entra com "retomada", sem nao-sei/branch-sumiu — ${JSON.stringify(p1)}`);
  ok(Boolean(p1) && p1.retomou?.[0]?.id === 'caso-p9-original' && p1.retomou[0].estado === 'needs-review' && p1.retomou[0].etiquetas.includes('pede-revisao'),
    `(p) retomou[0] = original, needs-review, com pede-revisao — ${JSON.stringify(p1?.retomou)}`);

  ok(jobsPorId.has('caso-p2-9-original') && !etq('caso-p2-9-original').includes('retomada') && !jobsPorId.has('caso-p2-1-retomada-failed'),
    '(p2) retomada failed: o original ENTRA sem "retomada"; a retomada sai pelo passo 1');
  const p4 = jobsPorId.get('caso-p4-1-final');
  ok(Boolean(p4) && etq('caso-p4-1-final').includes('retomada') && !etq('caso-p4-1-final').includes('nao-sei'),
    `(p4) retomada da retomada: só a última fica, com "retomada" — ${JSON.stringify(p4)}`);
  ok(Boolean(p4) && (p4.retomou || []).map((s) => s.id).sort().join(',') === 'caso-p4-5-intermediaria,caso-p4-9-original',
    `(p4) a última retomou a intermediária E o original — ${JSON.stringify(p4 && p4.retomou)}`);
  ok(!jobsPorId.has('caso-p4-5-intermediaria') && !atencaoPorId.has('caso-p4-5-intermediaria') && !jobsPorId.has('caso-p4-9-original') && !atencaoPorId.has('caso-p4-9-original'),
    '(p4) intermediária e original fora de jobs[] E de atencao[] — nada de "branch sumiu" pra membro de grupo');
  ok(jobsPorId.has('caso-p3-9-original') && jobsPorId.has('caso-p3-1-outra-branch')
    && !etq('caso-p3-9-original').includes('retomada') && !etq('caso-p3-1-outra-branch').includes('retomada')
    && (jobsPorId.get('caso-p3-1-outra-branch').retomou || []).length === 0,
    '(p3) branch nova que não contém o original: os dois ENTRAM, nenhum "retomada", retomou=[]');

  ok(['caso-k2-a', 'caso-k2-b'].every((id) => etq(id).includes('nao-sei')), '(k2) dois jobs com worktree vazia: os dois "nao-sei" (nunca formam grupo)');

  ok(!jobsPorId.has('caso-q-branch-sumiu') && (atencaoPorId.get('caso-q-branch-sumiu')?.etiquetas || []).includes('branch-sumiu'),
    `(q) branch sumiu, worktree em outra branch: fora de jobs[], em atencao[] com "branch-sumiu" — ${JSON.stringify(atencaoPorId.get('caso-q-branch-sumiu'))}`);
  ok(atencaoPorId.get('caso-q-branch-sumiu')?.merge === null, '(merge) item de atencao[] tem merge:null');
  const q2 = atencaoPorId.get('caso-q2-branch-sumiu-needsreview')?.etiquetas || [];
  ok(q2.includes('branch-sumiu') && q2.includes('pede-revisao'), `(q2) atencao[] com needs-review: "branch-sumiu" + "pede-revisao" — ${JSON.stringify(q2)}`);

  ok(etq('caso-v-repo-quebrado').includes('nao-sei') && !atencaoPorId.has('caso-v-repo-quebrado'),
    '(v) falha ao ler os refs do repo: "nao-sei" em jobs[], NUNCA "branch-sumiu" em atencao[]');

  ok(!jobsPorId.has('caso-r1-base') && !atencaoPorId.has('caso-r1-base'), '(r) a contida (r1) SAI da lista');
  ok(['caso-r2-cima', 'caso-r3-cima'].every((id) => idsDe(jobsPorId.get(id)?.inclui).join() === 'caso-r1-base'),
    '(r/r2) r2 e r3 (ramos independentes) têm inclui=[r1]');
  ok(!jobsPorId.has('caso-t9-gemea-velha') && idsDe(jobsPorId.get('caso-t1-gemea-nova')?.inclui).join() === 'caso-t9-gemea-velha',
    '(r3) gêmeas no mesmo sha: só a mais velha sai; a nova tem inclui=[velha]');
  const u3 = jobsPorId.get('caso-u3');
  ok(!jobsPorId.has('caso-u1') && !jobsPorId.has('caso-u2') && Boolean(u3) && idsDe(u3.inclui).join() === 'caso-u1,caso-u2' && u3.inclui.length === 2,
    `(r4) cadeia u1 ⊂ u2 ⊂ u3: só u3 entra, inclui={u1,u2} — ${JSON.stringify(idsDe(u3?.inclui))}`);
}

/** Pelo menos um job JÁ mergeado (merge --no-ff, ou em origin/develop) nunca aparece — gate 2 da spec. */
async function testeJaMergeadoNaoAparece() {
  const resp = await pedir('/api/jobs?revisar=1');
  const ids = (resp.corpo.jobs || []).map((j) => j.id);
  ok(!ids.includes('caso-b-noff') && !ids.includes('caso-d-origin') && !ids.includes('caso-o-main-contem'),
    `pelo menos um job já mergeado (à mão, --no-ff ou via origin/develop) NÃO aparece — ids presentes: ${JSON.stringify(ids)}`);
}

/**
 * Falso Pronto (card `revisar-nao-chama-de-pronto-job-entregue-ou-parado`): job com o ciclo de
 * vida fechado no META nunca entra (nem jobs[] nem atencao[]); `needs-decision` no relatório ou
 * no fim do `status.log` vira `pede-decisao`. ÚLTIMA leitura de `?revisar=1` com a RAIZ_JOBS
 * principal: os casos a-w já foram conferidos por `testeRegra()` antes do `limparJobs()` abaixo,
 * e os testes de `/api/jobs/resultado` que vêm depois plantam a fixture deles.
 */
async function testeFalsoPronto() {
  limparJobs();

  const iso = () => new Date().toISOString();
  const linhaDoneIso = () => `${iso()} done: executor terminou com sucesso`;

  const conf = repoConflito();
  const pend = repoPendente();
  const noff = repoNoFF();
  const rD = repoRetomada();
  const wD = worktreeReal(rD.dir, 'feat-p');
  const rE = repoRetomada();
  const wE = worktreeReal(rE.dir, 'feat-p');
  const emp = repoEmpilhado();

  plantarJob({ id: 'fp1-merged-sem-merged-at', sourceRepo: conf.dir, worktree: dirExistente(), branch: conf.branch, metaStatus: 'merged', linhaLog: linhaDoneIso() });
  plantarJob({
    id: 'fp1b-merged-at-com-status-done', sourceRepo: conf.dir, worktree: dirExistente(), branch: conf.branch,
    metaStatus: 'done', metaExtra: { merged_at: '2026-10-14T17:56:14+00:00' }, linhaLog: linhaDoneIso(),
  });
  plantarJob({ id: 'fp1c-teardown-sem-teardown-at', sourceRepo: conf.dir, worktree: dirExistente(), branch: conf.branch, metaStatus: 'teardown', linhaLog: linhaDoneIso() });
  plantarJob({
    id: 'fp1f-so-teardown-at', sourceRepo: conf.dir, worktree: dirExistente(), branch: conf.branch,
    metaStatus: 'done', metaExtra: { teardown_at: '2026-10-15T15:09:30+00:00' }, linhaLog: linhaDoneIso(),
  });

  plantarJob({ id: 'fp1g-r2-fechado', sourceRepo: emp.dir, worktree: dirExistente(), branch: 'feat-r2', metaStatus: 'merged', linhaLog: linhaDoneIso() });
  plantarJob({ id: 'fp1g-r1-vivo-contido', sourceRepo: emp.dir, worktree: dirExistente(), branch: 'feat-r1', linhaLog: linhaDoneIso() });

  plantarJob({
    id: 'fp1d-9-original-fechado', sourceRepo: rD.dir, worktree: wD, branch: 'feat-p',
    metaStatus: 'merged', metaExtra: { merged_at: '2026-10-14T10:00:00+00:00' }, linhaLog: linhaDoneIso(), createdAt: ONTEM,
  });
  plantarJob({
    id: 'fp1d-1-retomada-viva', sourceRepo: rD.dir, worktree: symlinkPara(wD), branch: 'job-fp1d-nunca-existiu',
    linhaLog: linhaDoneIso(), createdAt: HOJE,
  });

  plantarJob({
    id: 'fp1e-9-original-vivo', sourceRepo: rE.dir, worktree: wE, branch: 'feat-p',
    linhaLog: linhaDoneIso(), createdAt: ONTEM,
  });
  plantarJob({
    id: 'fp1e-1-retomada-fechada', sourceRepo: rE.dir, worktree: symlinkPara(wE), branch: 'job-fp1e-nunca-existiu',
    metaStatus: 'merged', linhaLog: linhaDoneIso(), createdAt: HOJE,
  });

  plantarJob({
    id: 'fp2-needs-decision-no-relatorio', sourceRepo: pend.dir, worktree: dirExistente(), branch: pend.branch,
    linhaLog: linhaDoneIso(),
    resultMd: 'needs-decision: parei na Fase 0.\n\n## Smoke pra o dono\n1. Decida o caminho.\n   - Onde: board\n   - Deve ver: a nota.\n',
  });
  plantarJob({
    id: 'fp2b-decisao-em-negrito-depois-de-70kb', sourceRepo: pend.dir, worktree: dirExistente(), branch: pend.branch,
    linhaLog: linhaDoneIso(),
    resultMd: 'done: código entregue.\n\n' + 'x'.repeat(70 * 1024) + '\n\n**needs-decision:** escolha A ou B.\n',
  });
  plantarJob({
    id: 'fp2c-needs-decision-no-status-log', sourceRepo: pend.dir, worktree: dirExistente(), branch: pend.branch,
    linhaLog: `${iso()} needs-decision: falta escolher`,
  });
  plantarJob({
    id: 'fp2d-relatorio-gigante', sourceRepo: pend.dir, worktree: dirExistente(), branch: pend.branch,
    linhaLog: linhaDoneIso(),
    resultMd: 'done: ok\n' + ('y'.repeat(1023) + '\n').repeat(1100),
  });
  plantarJob({
    id: 'fp2e-relatorio-ilegivel', sourceRepo: pend.dir, worktree: dirExistente(), branch: pend.branch,
    linhaLog: linhaDoneIso(),
  });
  // O `open` de diretório SUCEDE no Linux; quem estoura é o `read` (EISDIR) — exercita o
  // `catch` interno de `decisaoDoRelatorio` (Fase 4).
  fs.mkdirSync(path.join(RAIZ_JOBS, 'fp2e-relatorio-ilegivel', 'result.md'));
  plantarJob({
    id: 'fp2f-relatorio-sem-permissao', sourceRepo: pend.dir, worktree: dirExistente(), branch: pend.branch,
    linhaLog: linhaDoneIso(), resultMd: 'needs-decision: x\n',
  });
  const ehRoot = Boolean(process.getuid && process.getuid() === 0);
  if (!ehRoot) {
    // `open` falha com EACCES — exercita o ramo `code !== 'ENOENT'` do `catch` do `open`.
    fs.chmodSync(path.join(RAIZ_JOBS, 'fp2f-relatorio-sem-permissao', 'result.md'), 0o000);
  } else {
    console.log('  · (fp2f) root lê sem permissão — caso pulado');
  }
  plantarJob({
    id: 'fp2-neg-verbo-no-meio-da-frase', sourceRepo: pend.dir, worktree: dirExistente(), branch: pend.branch,
    linhaLog: linhaDoneIso(),
    resultMd: 'done: tudo certo. Use os verbos done:, needs-decision: no texto final.\n',
  });

  plantarJob({ id: 'fp3-running-ja-mergeado', sourceRepo: noff.dir, worktree: dirExistente(), branch: noff.branch, metaStatus: 'running', linhaLog: linhaDoneIso() });
  plantarJob({ id: 'fp3-neg-running-pendente', sourceRepo: pend.dir, worktree: dirExistente(), branch: pend.branch, metaStatus: 'running', linhaLog: linhaDoneIso() });

  const resp = await pedirEGuardar('/api/jobs?revisar=1');
  const jobsPorId = new Map((resp.corpo.jobs || []).map((j) => [j.id, j]));
  const atencaoPorId = new Map((resp.corpo.atencao || []).map((j) => [j.id, j]));
  const etq = (id) => (jobsPorId.get(id)?.etiquetas || []);

  ok(!jobsPorId.has('fp1-merged-sem-merged-at') && !atencaoPorId.has('fp1-merged-sem-merged-at'),
    `(fp1) merged sem merged_at: fora de jobs[] e atencao[] — ${JSON.stringify(jobsPorId.get('fp1-merged-sem-merged-at') || atencaoPorId.get('fp1-merged-sem-merged-at') || null)}`);
  ok(!jobsPorId.has('fp1b-merged-at-com-status-done') && !atencaoPorId.has('fp1b-merged-at-com-status-done'),
    `(fp1b) merged_at com status done: fora dos dois — ${JSON.stringify(jobsPorId.get('fp1b-merged-at-com-status-done') || atencaoPorId.get('fp1b-merged-at-com-status-done') || null)}`);
  ok(!jobsPorId.has('fp1c-teardown-sem-teardown-at') && !atencaoPorId.has('fp1c-teardown-sem-teardown-at'),
    `(fp1c) status teardown sem teardown_at: fora dos dois — ${JSON.stringify(jobsPorId.get('fp1c-teardown-sem-teardown-at') || atencaoPorId.get('fp1c-teardown-sem-teardown-at') || null)}`);
  ok(!jobsPorId.has('fp1f-so-teardown-at') && !atencaoPorId.has('fp1f-so-teardown-at'),
    `(fp1f) fechado só pelo carimbo teardown_at (worktree viva): fora dos dois — ${JSON.stringify(jobsPorId.get('fp1f-so-teardown-at') || atencaoPorId.get('fp1f-so-teardown-at') || null)}`);

  ok(jobsPorId.has('fp1g-r1-vivo-contido') && !atencaoPorId.has('fp1g-r1-vivo-contido')
    && !jobsPorId.has('fp1g-r2-fechado') && !atencaoPorId.has('fp1g-r2-fechado')
    && (jobsPorId.get('fp1g-r1-vivo-contido')?.inclui || []).length === 0,
    `(fp1g) r2 fechado some; r1 vivo fica sozinho em jobs[], sem ser recolhido em inclui[] de ninguém — ${JSON.stringify(jobsPorId.get('fp1g-r1-vivo-contido'))}`);

  ok(jobsPorId.has('fp1d-1-retomada-viva') && !atencaoPorId.has('fp1d-1-retomada-viva')
    && !jobsPorId.has('fp1d-9-original-fechado') && !atencaoPorId.has('fp1d-9-original-fechado'),
    `(fp1d) retomada viva EM jobs[]; original fechado fora dos dois (controle) — ${JSON.stringify(jobsPorId.get('fp1d-1-retomada-viva'))}`);
  ok(!etq('fp1d-1-retomada-viva').includes('branch-sumiu'),
    '(fp1d) a retomada viva de um original fechado NÃO cai em "branch-sumiu" (controle)');
  ok(!etq('fp1d-1-retomada-viva').includes('retomada') && (jobsPorId.get('fp1d-1-retomada-viva')?.retomou || []).length === 0,
    `(fp1d) a retomada não carrega "retomada" nem retomou=[original] — o original fechado não aparece nem como "retomou:" — ${JSON.stringify(jobsPorId.get('fp1d-1-retomada-viva'))}`);

  ok(jobsPorId.has('fp1e-9-original-vivo') && !jobsPorId.has('fp1e-1-retomada-fechada') && !atencaoPorId.has('fp1e-1-retomada-fechada'),
    `(fp1e) original vivo continua em jobs[] (job normal); retomada fechada fora dos dois — ${JSON.stringify(jobsPorId.get('fp1e-9-original-vivo'))}`);

  ok(jobsPorId.has('fp2-needs-decision-no-relatorio') && etq('fp2-needs-decision-no-relatorio').includes('pede-decisao'),
    `(fp2) needs-decision no início do relatório: em jobs[] com pede-decisao — ${JSON.stringify(jobsPorId.get('fp2-needs-decision-no-relatorio'))}`);
  ok(jobsPorId.has('fp2b-decisao-em-negrito-depois-de-70kb') && etq('fp2b-decisao-em-negrito-depois-de-70kb').includes('pede-decisao'),
    `(fp2b) **needs-decision:** em negrito depois de 70 KB de "done:": em jobs[] com pede-decisao — ${JSON.stringify(jobsPorId.get('fp2b-decisao-em-negrito-depois-de-70kb'))}`);
  ok(jobsPorId.has('fp2c-needs-decision-no-status-log') && jobsPorId.get('fp2c-needs-decision-no-status-log').estado === 'needs-decision'
    && etq('fp2c-needs-decision-no-status-log').includes('pede-decisao'),
    `(fp2c) needs-decision no fim do status.log: em jobs[], estado needs-decision, com pede-decisao — ${JSON.stringify(jobsPorId.get('fp2c-needs-decision-no-status-log'))}`);
  ok(jobsPorId.has('fp2d-relatorio-gigante') && etq('fp2d-relatorio-gigante').includes('relatorio-ilegivel') && !etq('fp2d-relatorio-gigante').includes('pede-decisao'),
    `(fp2d) relatório > 1 MiB sem a linha needs-decision: relatorio-ilegivel, SEM pede-decisao — ${JSON.stringify(jobsPorId.get('fp2d-relatorio-gigante'))}`);
  ok(jobsPorId.has('fp2e-relatorio-ilegivel') && etq('fp2e-relatorio-ilegivel').includes('relatorio-ilegivel'),
    `(fp2e) result.md é um diretório (EISDIR no read): relatorio-ilegivel — ${JSON.stringify(jobsPorId.get('fp2e-relatorio-ilegivel'))}`);
  if (!ehRoot) {
    ok(jobsPorId.has('fp2f-relatorio-sem-permissao') && etq('fp2f-relatorio-sem-permissao').includes('relatorio-ilegivel'),
      `(fp2f) result.md sem permissão de leitura (EACCES no open): relatorio-ilegivel — ${JSON.stringify(jobsPorId.get('fp2f-relatorio-sem-permissao'))}`);
  }

  ok(jobsPorId.has('fp2-neg-verbo-no-meio-da-frase') && etq('fp2-neg-verbo-no-meio-da-frase').length === 0,
    `(fp2-neg) "needs-decision:" no MEIO da frase não conta: em jobs[] com etiquetas vazio (controle) — ${JSON.stringify(jobsPorId.get('fp2-neg-verbo-no-meio-da-frase'))}`);

  ok(!jobsPorId.has('fp3-running-ja-mergeado') && !atencaoPorId.has('fp3-running-ja-mergeado'),
    '(fp3) meta running, branch já ancestral da develop: fora dos dois (controle)');
  ok(jobsPorId.has('fp3-neg-running-pendente'),
    `(fp3-neg) meta running, branch pendente: em jobs[] (controle) — ${JSON.stringify(jobsPorId.get('fp3-neg-running-pendente'))}`);
}

/** A pasta de jobs ausente: `{ jobs: [], habilitado: false }`. */
async function testeAusente() {
  const pastaAusente = path.join(os.tmpdir(), 'gate-revisar-pasta-que-nao-existe');
  fs.rmSync(pastaAusente, { recursive: true, force: true });
  process.env.COCKPIT_JOBS_DIR = pastaAusente;
  const resp = await pedirEGuardar('/api/jobs?revisar=1');
  ok(resp.status === 200 && resp.corpo.habilitado === false && Array.isArray(resp.corpo.jobs) && resp.corpo.jobs.length === 0
    && Array.isArray(resp.corpo.atencao) && resp.corpo.atencao.length === 0,
    `pasta ausente: 200 com habilitado:false, jobs:[] e atencao:[] — ${JSON.stringify(resp.corpo)}`);
  process.env.COCKPIT_JOBS_DIR = RAIZ_JOBS;
}

// ─── A rota do result.md ────────────────────────────────────────────────────────────────

async function testeResultadoIdInvalido() {
  const resp = await pedirEGuardar('/api/jobs/resultado?id=' + encodeURIComponent('../x'));
  ok(resp.status === 404, `id "../x" (fora da forma) → 404 — veio ${resp.status}`);
}

async function testeResultadoIdInexistente() {
  const resp = await pedirEGuardar('/api/jobs/resultado?id=nao-existe-de-verdade');
  ok(resp.status === 404, `id bem formado mas sem pasta → 404 — veio ${resp.status}`);
}

/**
 * `result.md` de 100 KB com um acento (2 bytes UTF-8) EXATAMENTE na fronteira do corte de
 * 64 KB: byte 65535 é o byte-líder (0xC3) de "á", e o corte em 65536 bytes separa o líder do
 * continuador. Prova que o corte RECUA até uma fronteira válida, em vez de decodificar com
 * `�` no meio.
 */
async function testeResultadoCortado() {
  const antes = 'x'.repeat(65535);
  const resto = 'y'.repeat(1000);
  const texto = `${antes}á${resto}`;
  plantarJob({
    id: 'caso-resultado-cortado', sourceRepo: '', worktree: '', branch: '',
    linhaLog: linhaDone(), resultMd: texto,
  });
  const resp = await pedirEGuardar('/api/jobs/resultado?id=caso-resultado-cortado');
  const textoRecebido = (resp.status === 200 && resp.corpo && typeof resp.corpo.texto === 'string') ? resp.corpo.texto : undefined;
  ok(resp.status === 200, `200 para id existente — veio ${resp.status}`);
  ok(resp.status === 200 && resp.corpo.cortado === true, `cortado:true para um result.md de 100 KB — ${JSON.stringify(resp.corpo && resp.corpo.cortado)}`);
  ok(textoRecebido !== undefined && !textoRecebido.includes('�'), 'nenhum caractere de substituição (U+FFFD) no texto cortado');
  ok(textoRecebido === antes, `o corte recuou para ANTES do "á" — sobrou exatamente o prefixo ASCII (len=${textoRecebido !== undefined ? textoRecebido.length : 'undefined'})`);
}

async function testeResultadoSemArquivo() {
  plantarJob({ id: 'caso-resultado-sem-arquivo', sourceRepo: '', worktree: '', branch: '', linhaLog: linhaDone() });
  const resp = await pedirEGuardar('/api/jobs/resultado?id=caso-resultado-sem-arquivo');
  ok(resp.status === 200 && resp.corpo.texto === '' && resp.corpo.cortado === false,
    `sem result.md: 200 com texto:'' e cortado:false — ${JSON.stringify(resp.corpo)}`);
}

async function testeResultadoForaDoAlfabeto() {
  // Card `job-com-underscore-ou-ponto-no-id`: o relatório de um job cujo id tem `_` ou `.` dava
  // 404 — a tela "Pra revisar" nunca mostrava o result.md desses jobs.
  for (const id of ['20261013-145932-projeto-a-ataca-dataset-com-campo_novo-a33f',
    '20261004-154220-projeto-b-ataca-painel-em-exemplo.app.br-c561']) {
    plantarJob({ id, sourceRepo: '', worktree: '', branch: '', linhaLog: linhaDone(), resultMd: `relatório de ${id}` });
    const resp = await pedirEGuardar('/api/jobs/resultado?id=' + encodeURIComponent(id));
    ok(resp.status === 200 && resp.corpo.texto === `relatório de ${id}`,
      `result.md de job com ${id.includes('_') ? '_' : '.'} no id ⇒ 200 com o texto — veio ${resp.status} ${JSON.stringify(resp.corpo)}`);
  }
}

// ─── Assert global ──────────────────────────────────────────────────────────────────────

function testeNaoVazouTmpdir() {
  const tmp = os.tmpdir();
  const vazou = RESPOSTAS_VISTAS.some((r) => r.includes(tmp));
  ok(!vazou, `nenhuma resposta contém ${tmp} (caminho de disco vazando pro navegador)`);

  const CHAVES_PROIBIDAS = ['worktree', 'branch', 'source_repo'];
  let achouChaveProibida = null;
  for (const bruto of RESPOSTAS_VISTAS) {
    let corpo;
    try { corpo = JSON.parse(bruto); } catch { continue; }
    const itens = [];
    for (const j of [...(corpo.jobs || []), ...(corpo.atencao || [])]) {
      itens.push(j, ...(j.retomou || []), ...(j.inclui || []));
    }
    for (const j of itens) {
      for (const chave of CHAVES_PROIBIDAS) {
        if (chave in j) { achouChaveProibida = chave; break; }
      }
    }
  }
  ok(achouChaveProibida === null, `nenhum objeto de jobs[]/atencao[]/retomou[]/inclui[] tem as chaves worktree/branch/source_repo (achou: ${achouChaveProibida})`);
}

// ─── Execução ────────────────────────────────────────────────────────────────────────────

async function principal() {
  process.env.PORT = String(PORTA_SERVIDOR);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = CERT_DIR_VAZIO;
  process.env.COCKPIT_TOKEN = '';
  process.env.COCKPIT_JOBS_DIR = RAIZ_JOBS;
  process.env.COCKPIT_TMUX_SOCKET = SOCKET_TMUX;
  process.env.COCKPIT_TMUX_SESSAO = 'gate-revisar';
  process.env.COCKPIT_VIGIA_MS = '0';
  process.env.COCKPIT_MONITOR_MS = '0'; // o amostrador do monitor escreve desde o boot (#82)
  require(path.join(__dirname, '..', 'server.js'));
  await espera(400);

  console.log('\n── GET /api/jobs?revisar=1 — a regra, caso a caso (a-l) ──\n');
  await testeRegra();
  await testeJaMergeadoNaoAparece();

  console.log('\n── GET /api/jobs?revisar=1 — falso Pronto (card revisar-nao-chama-de-pronto…) ──\n');
  await testeFalsoPronto();

  console.log('\n── GET /api/jobs?revisar=1 — pasta ausente ──\n');
  await testeAusente();

  console.log('\n── GET /api/jobs/resultado ──\n');
  await testeResultadoIdInvalido();
  await testeResultadoIdInexistente();
  await testeResultadoCortado();
  await testeResultadoSemArquivo();
  await testeResultadoForaDoAlfabeto();

  console.log('\n── assert global: nada de disco vaza pro navegador ──\n');
  testeNaoVazouTmpdir();

  fs.rmSync(CERT_DIR_VAZIO, { recursive: true, force: true });
  fs.rmSync(RAIZ_JOBS, { recursive: true, force: true });

  console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — Pra revisar\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.error('🔴 o gate estourou —', e);
  process.exit(1);
});
