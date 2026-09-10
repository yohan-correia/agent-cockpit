#!/usr/bin/env node
'use strict';
// Instala somente a unit. Não inicia, reinicia ou sobrescreve um serviço existente.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(root, '.env'))) throw new Error('Crie .env a partir de .env.example primeiro.');
const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
const quote = value => '"' + value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
if (/[\r\n]/.test(root + process.execPath)) throw new Error('Caminho inválido.');
fs.mkdirSync(dir, { recursive: true });
const unit = `[Unit]\nDescription=Cockpit de Agentes\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(root)}\nExecStart=${quote(process.execPath)} --env-file=.env ${quote(path.join(root, 'server.js'))}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
const file = path.join(dir, 'cockpit-agentes.service');
fs.writeFileSync(file, unit, { flag: 'wx', mode: 0o600 });
console.log(`Unit criada: ${file}\nPara iniciar:\nsystemctl --user daemon-reload\nsystemctl --user enable --now cockpit-agentes.service`);
