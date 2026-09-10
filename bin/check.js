#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failed = false;
for (const dir of ['lib', 'public', 'bin', 'testes']) {
  for (const file of fs.readdirSync(path.join(root, dir))) {
    if (!/\.(js|mjs)$/.test(file)) continue;
    const r = spawnSync(process.execPath, ['--check', path.join(root, dir, file)], { stdio: 'inherit' });
    if (r.status !== 0) failed = true;
  }
}
if (spawnSync(process.execPath, ['--check', path.join(root, 'server.js')], { stdio: 'inherit' }).status !== 0) failed = true;
process.exitCode = failed ? 1 : 0;
