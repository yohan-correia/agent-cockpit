#!/usr/bin/env node
'use strict';
// Exporta uma lista explícita de arquivos versionados. Não copia .git nem dados locais.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const target = process.argv[2];
if (!target || !path.isAbsolute(target)) throw new Error('Uso: node bin/prepara-publicacao.js /caminho/novo');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git(['status', '--porcelain'])) throw new Error('Faça commit das mudanças antes de exportar.');
const roots = new Set(['README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md',
  'CONTRIBUTING.md', 'CHANGELOG.md', 'package.json', '.env.example', '.gitignore', 'server.js']);
const docs = new Set(['docs/acesso-remoto.md', 'docs/operacao.md', 'docs/arquitetura.md', 'docs/publicacao.md', 'docs/configuracao.md']);
const files = git(['ls-files']).split('\n').filter(file => roots.has(file) || docs.has(file)
  || /^(lib|public|testes|bin|\.github)\//.test(file));
for (const file of roots) if (!files.includes(file)) throw new Error(`Arquivo obrigatório ausente: ${file}`);
const denied = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-(?:ant-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16}|[a-z0-9-]+\.ts\.net|\b100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b)/i;
const localHome = os.homedir();
const contents = files.map(file => {
  const full = path.join(root, file);
  if (!fs.lstatSync(full).isFile()) throw new Error(`Não exportar symlink: ${file}`);
  const data = fs.readFileSync(full);
  if (/\.(?:key|pem|pfx|p12)$/.test(file) || file === '.env') throw new Error(`Arquivo privado: ${file}`);
  const text = data.toString('utf8').replace(/\\([/.])/g, '$1');
  if (denied.test(text) || (localHome !== '/' && text.includes(localHome))) throw new Error(`Revisar conteúdo antes de exportar: ${file}`);
  return { file, data };
});
fs.mkdirSync(target); // Recusa destino existente; nunca sobrescreve uma publicação.
const manifest = [];
for (const { file, data } of contents) {
  const dest = path.join(target, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data, { flag: 'wx', mode: fs.statSync(path.join(root, file)).mode & 0o777 });
  manifest.push(`${createHash('sha256').update(data).digest('hex')}  ${file}`);
}
fs.writeFileSync(path.join(target, 'SHA256SUMS'), manifest.join('\n') + '\n');
console.log(`Cópia pública preparada: ${target}\n${files.length} arquivos; sem .git, roadmap ou documentos internos.\nRevise esta pasta antes de criar o repositório público.`);
