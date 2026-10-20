#!/usr/bin/env node
'use strict';
// CENÁRIO de fixture do falso Pronto no "Pra revisar" (card
// `revisar-nao-chama-de-pronto-job-entregue-ou-parado`). Monta, dentro de uma pasta VAZIA,
// cinco repos git e cinco jobs que reproduzem os três casos reais de 15/10: um já entregue
// por outro caminho (meta `merged`, sem o carimbo), um parado pedindo decisão, um "entregue"
// com o meta ainda `running`, um pronto de verdade (controle) e um entregue com decisão
// pendente no fim do relatório. Alimenta o `print-celular-revisar.mjs` (cenas `lista`,
// `atencao-decisao` e `job-decisao`).
//
// Uso:  node testes/cenario-revisar-falso-pronto.js <pasta-vazia>
//       (imprime o caminho de `<pasta>/jobs`; use como a pasta de jobs do servidor de teste)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const raiz = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!raiz) { console.error('uso: node testes/cenario-revisar-falso-pronto.js <pasta-vazia>'); process.exit(2); }
fs.mkdirSync(raiz, { recursive: true });
if (fs.readdirSync(raiz).length) { console.error(`🔴 ${raiz} não está vazia`); process.exit(2); }

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Cenario Falso Pronto', GIT_AUTHOR_EMAIL: 'cenario-falso-pronto@localhost',
  GIT_COMMITTER_NAME: 'Cenario Falso Pronto', GIT_COMMITTER_EMAIL: 'cenario-falso-pronto@localhost',
};
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, stdio: 'pipe' }).toString('utf8');
function escreve(repo, nome, conteudo) {
  const alvo = path.join(repo, nome);
  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  fs.writeFileSync(alvo, conteudo);
}

/**
 * main + develop no mesmo commit; `feat-<x>` nasce da develop. Com `arquivosConflito`, a
 * branch e a develop mexem no mesmo arquivo (conflito); sem, cada uma anda por um arquivo
 * próprio (pendente, sem conflito). Com `mergeada`, a develop já engole `feat-<x>` (--no-ff).
 */
function montarRepo(x, { arquivosConflito = null, mergeada = false } = {}) {
  const dir = path.join(raiz, 'repos', x);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main', '-q']);
  escreve(dir, 'src/app.js', 'base\n');
  escreve(dir, 'README.md', 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'inicial']);
  git(dir, ['branch', 'develop']);
  git(dir, ['checkout', '-q', '-b', `feat-${x}`, 'develop']);
  if (arquivosConflito) {
    for (const a of arquivosConflito) escreve(dir, a, `lado feat-${x}\n`);
  } else {
    escreve(dir, 'novo.txt', `novo de ${x}\n`);
  }
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', `lado feat-${x}`]);
  git(dir, ['checkout', '-q', 'develop']);
  if (arquivosConflito) {
    for (const a of arquivosConflito) escreve(dir, a, 'lado develop\n');
  } else {
    escreve(dir, 'outro.txt', `outro de ${x}\n`);
  }
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'lado develop']);
  if (mergeada) git(dir, ['merge', '--no-ff', `feat-${x}`, '-m', `merge de feat-${x}`]);
  return dir;
}

// Um pid que NÃO existe — nenhum destes jobs está rodando.
const PID_MORTO = (() => {
  try { return Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1; }
  catch { return 4194304; }
})();

const linhaDone = () => `${new Date().toISOString()} done: executor terminou com sucesso\n`;

const JOBS = [
  {
    id: '20261015-100000-alfa-entregue-por-outro-0001', x: 'alfa', projeto: 'projeto-alfa',
    titulo: 'Já entregue por outro job', metaStatus: 'merged',
    resultMd: 'done: entregue.\n\n## Smoke pra o dono\nNada a testar à mão: fixture.\n',
    repo: { arquivosConflito: ['src/app.js', 'README.md'] },
  },
  {
    id: '20261015-100100-beta-parou-pedindo-decisao-0002', x: 'beta', projeto: 'projeto-beta',
    titulo: 'Parou pedindo decisão', metaStatus: 'done',
    resultMd: 'needs-decision: a conta não tem o modo pedido. Parei na Fase 0.\n\n## Smoke pra o dono\n1. Decida o caminho.\n   - Onde: board do projeto\n   - Deve ver: a nota com as opções.\n',
    repo: {},
  },
  {
    id: '20261015-100200-gama-entregue-meta-running-0003', x: 'gama', projeto: 'projeto-gama',
    titulo: 'Entregue, meta ficou running', metaStatus: 'running', resultMd: null,
    repo: { mergeada: true },
  },
  {
    id: '20261015-100300-delta-pronto-de-verdade-0004', x: 'delta', projeto: 'projeto-delta',
    titulo: 'Pronto de verdade', metaStatus: 'done',
    resultMd: 'done: pronto pro smoke.\n\n## Smoke pra o dono\n1. Abra a tela.\n   - Onde: app\n   - Deve ver: o recurso novo.\n',
    repo: {},
  },
  {
    id: '20261015-100400-epsilon-entregue-com-decisao-0005', x: 'epsilon', projeto: 'projeto-epsilon',
    titulo: 'Código entregue, falta decidir', metaStatus: 'done',
    resultMd: 'done: código entregue na worktree.\n\n**needs-decision:** escolha entre A e B antes do merge.\n\n## Smoke pra o dono\n1. Escolha A ou B.\n   - Onde: board\n   - Deve ver: as duas opções.\n',
    repo: {},
  },
];

for (const [i, j] of JOBS.entries()) {
  const repo = montarRepo(j.x, j.repo);
  const wt = path.join(raiz, 'wt', j.x);
  fs.mkdirSync(wt, { recursive: true });
  const pasta = path.join(raiz, 'jobs', j.id);
  fs.mkdirSync(pasta, { recursive: true });
  const criado = new Date(Date.now() - (JOBS.length - i) * 3600e3).toISOString();
  const meta = {
    id: j.id, type: 'ataca', project: j.projeto, title: j.titulo, origin: 'capitao',
    status: j.metaStatus, pid: PID_MORTO, created_at: criado.replace('Z', '+00:00'),
    source_repo: repo, worktree: wt, branch: `feat-${j.x}`,
  };
  fs.writeFileSync(path.join(pasta, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(pasta, 'status.log'), linhaDone());
  if (j.resultMd !== null) fs.writeFileSync(path.join(pasta, 'result.md'), j.resultMd);
}

console.log(path.join(raiz, 'jobs'));
