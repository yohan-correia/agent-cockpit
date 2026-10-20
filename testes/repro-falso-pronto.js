#!/usr/bin/env node
'use strict';
// REPRO do card `revisar-nao-chama-de-pronto-job-entregue-ou-parado` ("Pra revisar: falso Pronto").
// Os três casos reais de 15/10, refeitos com meta.json/status.log/result.md SINTÉTICOS no
// formato que o orquestrador grava (os jobs reais já passaram pelo teardown e não reproduzem mais).
// Chama a REGRA (`lib/revisar.js`) sobre o que `lib/jobs.js` lê do disco — mesma cadeia da rota,
// sem subir servidor. Imprime o veredito por caso e sai 1 se algum caso ainda erra.
//
//   1. 17ad: meta.status "merged" à mão (z_set_meta), merged_at null, último evento
//      "done: executor terminou com sucesso", branch velha com conteúdo já na develop por OUTRO
//      caminho (cherry com 1 "+") → não pode estar na lista.
//   2. bfed: relatório começa com "needs-decision:", status.log só tem o "done:" do spawn
//      → tem de entrar com a etiqueta `pede-decisao` (vai pro filtro Atenção, nunca Prontos).
//   3. cac9: meta.status "running", sem pid nem tmux, último evento "done:", branch ancestral
//      da develop → fica FORA (já entregue); o par negativo (mesmo meta, branch pendente) ENTRA.
//
// Uso:  node testes/repro-falso-pronto.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-falso-pronto-'));
process.env.COCKPIT_JOBS_DIR = path.join(RAIZ, 'jobs');
fs.mkdirSync(process.env.COCKPIT_JOBS_DIR);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Repro', GIT_AUTHOR_EMAIL: 'repro@localhost',
  GIT_COMMITTER_NAME: 'Repro', GIT_COMMITTER_EMAIL: 'repro@localhost',
};
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, stdio: 'pipe' }).toString('utf8');
const escreve = (repo, nome, txt) => fs.writeFileSync(path.join(repo, nome), txt);

function novoRepo(nome) {
  const dir = path.join(RAIZ, 'repos', nome);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main', '-q']);
  escreve(dir, 'a.txt', 'base\n');
  escreve(dir, 'indice.md', 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'inicial']);
  git(dir, ['branch', 'develop']);
  return dir;
}

// Caso 1: o trabalho da branch entrou na develop por outro job (sha diferente), menos UM commit
// de índice que a develop reescreveu do jeito dela — `git cherry` mostra "+" e o merge-tree, conflito.
function repoEntregueParOutroCaminho() {
  const dir = novoRepo('caso1');
  git(dir, ['checkout', '-q', '-b', 'job/velha']);
  escreve(dir, 'a.txt', 'trabalho do job\n'); git(dir, ['commit', '-q', '-am', 'trabalho']);
  escreve(dir, 'indice.md', 'índice da branch velha\n'); git(dir, ['commit', '-q', '-am', 'índice']);
  git(dir, ['checkout', '-q', 'develop']);
  escreve(dir, 'a.txt', 'trabalho do job\n'); git(dir, ['commit', '-q', '-am', 'mesmo trabalho, outro job']);
  escreve(dir, 'indice.md', 'índice reescrito na develop\n'); git(dir, ['commit', '-q', '-am', 'índice da develop']);
  return { dir, branch: 'job/velha' };
}

function repoPendente(nome) {
  const dir = novoRepo(nome);
  git(dir, ['checkout', '-q', '-b', 'feat']);
  escreve(dir, 'novo.txt', 'pendente\n'); git(dir, ['add', '.']); git(dir, ['commit', '-q', '-m', 'pendente']);
  git(dir, ['checkout', '-q', 'develop']);
  return { dir, branch: 'feat' };
}

function repoJaMergeado(nome) {
  const r = repoPendente(nome);
  git(r.dir, ['merge', '-q', '--no-ff', 'feat', '-m', 'merge do job']);
  return r;
}

const PID_MORTO = Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1;
const HORA = '2026-10-14T17:55:13+00:00';

function plantar({ id, repo, metaExtra = {}, log, result }) {
  const dir = path.join(process.env.COCKPIT_JOBS_DIR, id);
  fs.mkdirSync(dir);
  const wt = path.join(RAIZ, 'wt', id);
  fs.mkdirSync(wt, { recursive: true });
  const meta = {
    id, type: 'ataca', project: 'repro', title: id, origin: 'capitao', created_at: HORA,
    source_repo: repo.dir, worktree: wt, branch: repo.branch, status: 'done', pid: PID_MORTO,
    tmux_session: `job-${id}`, merged_at: null, ...metaExtra,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'status.log'), `${log.join('\n')}\n`);
  if (result !== undefined) fs.writeFileSync(path.join(dir, 'result.md'), result);
}

const SPAWN = `${HORA} working: tmux spawnado: job-x pid=${PID_MORTO}`;
const DONE_SPAWN = `${HORA} done: executor terminou com sucesso`;

plantar({ id: 'caso1-merged-sem-merged-at', repo: repoEntregueParOutroCaminho(), metaExtra: { status: 'merged' }, log: [SPAWN, DONE_SPAWN] });
plantar({
  id: 'caso2-needs-decision-no-relatorio', repo: repoPendente('caso2'), log: [SPAWN, DONE_SPAWN],
  result: 'needs-decision: a conta não tem o modo pedido. Parei na Fase 0.\n\n## Smoke pra o dono\n1. Decida o caminho.\n   - Onde: board\n   - Deve ver: a nota.\n',
});
plantar({ id: 'caso3-running-ja-mergeado', repo: repoJaMergeado('caso3'), metaExtra: { status: 'running' }, log: [SPAWN, DONE_SPAWN] });
plantar({ id: 'caso3-neg-running-pendente', repo: repoPendente('caso3neg'), metaExtra: { status: 'running' }, log: [SPAWN, DONE_SPAWN] });

(async () => {
  const jobs = require('../lib/jobs');
  const revisar = require('../lib/revisar');
  const dados = await jobs.listar();
  const { principal, atencao } = await revisar.filtrarPraRevisar(dados.jobs);
  const onde = (id) => {
    const p = principal.find((x) => x.job.id === id);
    if (p) return { lista: 'principal', item: p };
    const a = atencao.find((x) => x.job.id === id);
    return a ? { lista: 'atencao', item: a } : { lista: 'fora', item: null };
  };
  // O que o SERVIDOR põe de etiqueta hoje vem de `motivo` + `estado` + result.md; a regra nova
  // expõe `pedeDecisao` — se ainda não existir, o caso 2 cai em "Pronto".
  const pede = (id) => {
    const o = onde(id);
    if (!o.item) return false;
    if (typeof revisar.pedeDecisaoNoTexto !== 'function') return false;
    const txt = fs.existsSync(path.join(process.env.COCKPIT_JOBS_DIR, id, 'result.md'))
      ? fs.readFileSync(path.join(process.env.COCKPIT_JOBS_DIR, id, 'result.md'), 'utf8') : '';
    return o.item.estado === 'needs-decision' || revisar.pedeDecisaoNoTexto(txt);
  };

  let erros = 0;
  const caso = (cond, txt) => { console.log(`  ${cond ? '✅' : '❌'} ${txt}`); if (!cond) erros += 1; };

  const c1 = onde('caso1-merged-sem-merged-at');
  caso(c1.lista === 'fora', `caso 1 (meta merged, merged_at null): fora da lista — está em "${c1.lista}"`);
  const c2 = onde('caso2-needs-decision-no-relatorio');
  caso(c2.lista !== 'fora' && pede('caso2-needs-decision-no-relatorio'),
    `caso 2 (needs-decision no relatório): entra marcado como pede-decisao — lista="${c2.lista}" pede=${pede('caso2-needs-decision-no-relatorio')}`);
  const c3 = onde('caso3-running-ja-mergeado');
  caso(c3.lista === 'fora', `caso 3 (meta running, branch já na develop): fora (entregue) — está em "${c3.lista}"`);
  const c3n = onde('caso3-neg-running-pendente');
  caso(c3n.lista === 'principal', `caso 3 negativo (meta running, branch pendente): entra — está em "${c3n.lista}"`);

  fs.rmSync(RAIZ, { recursive: true, force: true });
  console.log(erros ? `\n❌ ${erros} caso(s) ainda reproduzem o falso Pronto` : '\n✅ nenhum caso reproduz');
  process.exit(erros ? 1 : 0);
})();
