#!/usr/bin/env node
'use strict';
// Só testes offline ou com providers locais. Nunca execute gates pagos por descoberta.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-offline-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(key)) delete env[key];
Object.assign(env, { HOME: temp, CODEX_HOME: path.join(temp, '.codex'), HOST: '127.0.0.1',
  COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TMUX_SOCKET: `cockpit-offline-${process.pid}`,
  COCKPIT_BIN_CODEX: '/usr/bin/codex', COCKPIT_BIN_CLAUDE: '/usr/bin/claude' });
delete env.PORT;
delete env.PORTA_PAINEL;
const tests = ['gate-idioma.js', 'gate-instalacao.js', 'gate-clear-codex.js', 'gate-envio-skill-codex.js',
  'gate-fila-pendente.js', 'gate-jobs-disco.js', 'gate-jobs-rota.js', 'gate-ui.js', 'gate-codex.js',
  // Os dois ecos (bash mode e comando de barra) entraram aqui em 10/09/2026: o gate-eco-bash
  // vivia FORA desta lista e passou dois dias vermelho sem ninguém ver — a fixture dele tinha
  // data cravada e venceu o teto de 30 min da pendente. Gate que não roda no `npm test` não é
  // gate, é documentação.
  'gate-eco-bash.js', 'gate-eco-comando.js'];
try {
  for (const test of tests) {
    console.log(`\n${test}`);
    const testEnv = { ...env };
    // Esse gate cria e valida seu próprio socket, recusando qualquer valor herdado.
    if (test === 'gate-jobs-rota.js') delete testEnv.COCKPIT_TMUX_SOCKET;
    const r = spawnSync(process.execPath, [path.join(root, 'testes', test)], { cwd: root, env: testEnv, stdio: 'inherit', timeout: 120000 });
    if (r.error || r.status !== 0) { console.error(r.error || `Falhou: ${test}`); process.exitCode = 1; break; }
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
