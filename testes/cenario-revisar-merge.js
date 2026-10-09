#!/usr/bin/env node
'use strict';
// CENÁRIO de fixture da prévia do merge no "Pra revisar" (card `pra-revisar-aviso-de-conflito-no-merge`).
// Monta, dentro de uma pasta VAZIA, três repos git e três jobs `done` que apontam para eles — o
// suficiente para o servidor de teste devolver, em `?revisar=1`, um job com merge limpo, um com
// conflito em dois arquivos e um com conflito só no roadmap do board. Alimenta o
// `print-celular-revisar.mjs` (cenas `lista-merge` e `job-merge`).
//
// Uso:  node testes/cenario-revisar-merge.js <pasta-vazia>
//       (imprime o caminho de `<pasta>/jobs`; use como a pasta de jobs do servidor de teste)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const raiz = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!raiz) { console.error('uso: node testes/cenario-revisar-merge.js <pasta-vazia>'); process.exit(2); }
fs.mkdirSync(raiz, { recursive: true });
if (fs.readdirSync(raiz).length) { console.error(`🔴 ${raiz} não está vazia`); process.exit(2); }

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Cenario Merge', GIT_AUTHOR_EMAIL: 'cenario-merge@localhost',
  GIT_COMMITTER_NAME: 'Cenario Merge', GIT_COMMITTER_EMAIL: 'cenario-merge@localhost',
};
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, stdio: 'pipe' }).toString('utf8');
function escreve(repo, nome, conteudo) {
  const alvo = path.join(repo, nome);
  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  fs.writeFileSync(alvo, conteudo);
}

/** main + develop no mesmo commit; branch `feat-<x>` e a develop mexem em `arquivos` com conteúdo diferente. */
function montarRepo(x, arquivos) {
  const dir = path.join(raiz, 'repos', x);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main', '-q']);
  escreve(dir, 'src/app.js', 'base\n');
  escreve(dir, 'README.md', 'base\n');
  escreve(dir, 'roadmap-board/data/roadmap.json', '{"v":0}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'inicial']);
  git(dir, ['branch', 'develop']);
  git(dir, ['checkout', '-q', '-b', `feat-${x}`, 'develop']);
  if (arquivos.length === 0) escreve(dir, 'novo.txt', 'novo\n');
  for (const a of arquivos) escreve(dir, a, `lado feat-${x}\n`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', `lado feat-${x}`]);
  git(dir, ['checkout', '-q', 'develop']);
  for (const a of arquivos) escreve(dir, a, 'lado develop\n');
  if (arquivos.length === 0) escreve(dir, 'outro.txt', 'outro\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'lado develop']);
  return dir;
}

// Um pid que NÃO existe — "meta diz done, mas não há processo".
const PID_MORTO = (() => {
  try { return Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1; }
  catch { return 4194304; }
})();

const JOBS = [
  { id: '20261009-100000-alfa-selo-limpo-0001', x: 'alfa', titulo: 'Prévia: merge limpo', arquivos: [] },
  { id: '20261009-100100-beta-selo-conflito-0002', x: 'beta', titulo: 'Prévia: conflito em código', arquivos: ['src/app.js', 'README.md'] },
  { id: '20261009-100200-gama-selo-roadmap-0003', x: 'gama', titulo: 'Prévia: conflito só no roadmap', arquivos: ['roadmap-board/data/roadmap.json'] },
];

for (const [i, j] of JOBS.entries()) {
  const repo = montarRepo(j.x, j.arquivos);
  const wt = path.join(raiz, 'wt', j.x);
  fs.mkdirSync(wt, { recursive: true });
  const pasta = path.join(raiz, 'jobs', j.id);
  fs.mkdirSync(pasta, { recursive: true });
  const criado = new Date(Date.now() - (JOBS.length - i) * 3600e3).toISOString();
  const meta = {
    id: j.id, type: 'ataca', project: `projeto-${j.x}`, title: j.titulo, origin: 'capitao',
    status: 'done', pid: PID_MORTO, created_at: criado.replace('Z', '+00:00'),
    source_repo: repo, worktree: wt, branch: `feat-${j.x}`,
  };
  fs.writeFileSync(path.join(pasta, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(pasta, 'status.log'), `${new Date().toISOString()} done: ok\n`);
  fs.writeFileSync(path.join(pasta, 'result.md'), 'done: fixture da prévia do merge.\n\n## Smoke pra o dono\nNada a testar à mão: fixture.\n');
}

console.log(path.join(raiz, 'jobs'));
