#!/usr/bin/env node
// Print de CELULAR (390×844) da lista de agentes com a fixture do card
// `lista-de-agentes-ressuscita-job-na-limpeza` (06/10/2026): um job rodando, um que terminou há
// 10 min e foi limpo agora, e um que terminou há 3 DIAS e foi limpo agora.
//
//   antes (develop 8435aab): os dois teardowns aparecem como "encerrado agora mesmo"
//   depois (fix):            o de 10 min diz "encerrado há 10 min"; o de 3 dias não aparece
//
// É a prova de TELA do que o J20 (`gate-jobs-rota.js`) prova por HTTP. O servidor sobe de uma
// árvore qualquer (`--arvore`), o que permite fotografar a develop exportada com `git archive`
// e o fix lado a lado, com a MESMA fixture. Ambiente isolado por lista fechada (#78): HOME
// falso e cada `COCKPIT_*_DIR` apontado para dentro dele — nada toca `~/.cockpit`.
//
// Uso:
//   node testes/print-fim-real-do-job.mjs --porta 7895 --saida /tmp/depois.png
//   node testes/print-fim-real-do-job.mjs --porta 7894 --saida /tmp/antes.png --arvore /tmp/develop
//
// Códigos de saída: os do `print-celular-jobs.mjs` (0 = PNG gravado).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_REPO = path.resolve(AQUI, '..');

const o = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--porta') o.porta = Number(argv[++i]);
  else if (argv[i] === '--saida') o.saida = argv[++i];
  else if (argv[i] === '--arvore') o.arvore = path.resolve(argv[++i]);
  else { console.error(`argumento desconhecido: ${argv[i]}`); process.exit(2); }
}
if (!o.porta || !o.saida) { console.error('uso: --porta N --saida x.png [--arvore DIR]'); process.exit(2); }
if (o.porta < 7891 || o.porta > 7898) { console.error('porta fora da faixa 7891-7898 (nunca 7879/7899)'); process.exit(2); }
const arvore = o.arvore || RAIZ_REPO;

// ─── Fixture ────────────────────────────────────────────────────────────────

const MIN = 60000;
const H = 60 * MIN;
const D = 24 * H;
const iso = (atras) => new Date(Date.now() - atras).toISOString();
const linha = (atras, kind, texto) => `${iso(atras)} ${kind}: ${texto}\n`;

function plantar(raiz) {
  const job = (id, title, meta, status) => {
    const dir = path.join(raiz, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      id, type: 'ship', project: `/home/smoke/projetos/${id}`, title, origin: 'capitao',
      created_at: iso(meta.criadoHa), worktree: '', branch: '', source_repo: '',
      merged_at: meta.merged_at || null, approved_at: null, status: meta.status || 'running',
      pid: meta.pid || null, teardown_at: meta.teardown_at || null,
    }));
    fs.writeFileSync(path.join(dir, 'status.log'), status);
  };
  // pid 1 existe e não é meu: `kill(1, 0)` dá EPERM, que `pidVivo()` lê como "vivo".
  job('20261006-200000-smoke-rodando', 'job rodando (controle)', { criadoHa: 5 * MIN, pid: 1 },
    linha(5 * MIN, 'working', 'executor iniciado em tmux (x)'));
  job('20261006-190000-smoke-trd-10m', 'terminou há 10 min, faxina agora',
    { criadoHa: H, status: 'teardown', teardown_at: iso(0), merged_at: iso(0) },
    linha(H, 'working', 'executor iniciado em tmux (x)')
    + linha(10 * MIN, 'done', 'executor terminou com sucesso')
    + linha(0, 'done', 'teardown concluído'));
  job('20261003-190000-smoke-trd-3d', 'terminou há 3 dias, faxina agora',
    { criadoHa: 3 * D + H, status: 'teardown', teardown_at: iso(0), merged_at: iso(0) },
    linha(3 * D + H, 'working', 'executor iniciado em tmux (x)')
    + linha(3 * D, 'done', 'executor terminou com sucesso')
    + linha(0, 'done', 'teardown concluído'));
}

// ─── Servidor + print ───────────────────────────────────────────────────────

const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'print-fim-real-'));
const jobsDir = path.join(casa, 'jobs');
plantar(jobsDir);
const dirs = ['push', 'lidas', 'leituras', 'uso', 'usocodex', 'statuscodex', 'clearcodex', 'projetos', 'worktrees'];
for (const d of dirs) fs.mkdirSync(path.join(casa, d), { recursive: true });

const env = {
  PATH: process.env.PATH, HOME: casa, HOST: '127.0.0.1', PORT: String(o.porta), COCKPIT_TOKEN: '',
  COCKPIT_CERT_DIR: '/dev/null', COCKPIT_VIGIA_MS: '0', COCKPIT_TMUX_SOCKET: `print-fim-real-${process.pid}`,
  COCKPIT_JOBS_DIR: jobsDir,
  COCKPIT_PUSH_DIR: path.join(casa, 'push'), COCKPIT_LIDAS_DIR: path.join(casa, 'lidas'),
  COCKPIT_LEITURAS_DIR: path.join(casa, 'leituras'), COCKPIT_USO_DIR: path.join(casa, 'uso'),
  COCKPIT_USO_CODEX_DIR: path.join(casa, 'usocodex'), COCKPIT_STATUS_CODEX_DIR: path.join(casa, 'statuscodex'),
  COCKPIT_CLEAR_CODEX_DIR: path.join(casa, 'clearcodex'), COCKPIT_PROJETOS_DIR: path.join(casa, 'projetos'),
  COCKPIT_WORKTREES_DIR: path.join(casa, 'worktrees'),
};

const servidor = spawn(process.execPath, [path.join(arvore, 'server.js')], { cwd: arvore, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logServidor = '';
servidor.stdout.on('data', (d) => { logServidor += d; });
servidor.stderr.on('data', (d) => { logServidor += d; });

await new Promise((r) => setTimeout(r, 1500));
if (servidor.exitCode !== null) {
  console.error(`o servidor de ${arvore} morreu ao subir:\n${logServidor}`);
  process.exit(2);
}

const codigo = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(AQUI, 'print-celular-jobs.mjs'),
    '--porta', String(o.porta), '--saida', o.saida, '--espero', 'jobs'], { stdio: 'inherit' });
  p.on('exit', (c) => resolve(c ?? 1));
});

servidor.kill('SIGTERM');
fs.rmSync(casa, { recursive: true, force: true });
console.log(`${codigo === 0 ? '✅' : '❌'} print de ${arvore} → ${o.saida} (exit ${codigo})`);
process.exit(codigo);
