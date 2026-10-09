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
// A lista de termos proibidos mora FORA do repo (D78): ela tem nome de cliente, e versioná-la seria publicar o
// que ela protege. Sem caixa e sem acento; substring de propósito (fronteira de palavra perderia `NomeJunto`).
// Sem lista, ou lista só com comentário, a exportação RECUSA: export sem lista é o caso que publicou nome privado.
const normalizar = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const caminhoLista = process.env.COCKPIT_PUBLICACAO_PROIBIDOS || path.join(os.homedir(), '.cockpit', 'publicacao-proibidos.txt');
let termos = [];
try {
  termos = fs.readFileSync(caminhoLista, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
} catch { /* ausente ou ilegível: cai na recusa abaixo, com a mesma mensagem */ }
if (!termos.length) {
  console.error(`Lista de termos proibidos ausente ou vazia: crie ${caminhoLista} (um termo por linha) ou aponte COCKPIT_PUBLICACAO_PROIBIDOS.`);
  process.exit(1);
}
const proibidos = termos.map((termo) => ({ termo, n: normalizar(termo) }));
const roots = new Set(['README.md', 'README.en.md', 'ROADMAP.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md',
  'CONTRIBUTING.md', 'CHANGELOG.md', 'package.json', '.env.example', '.gitignore', 'server.js']);
const docs = new Set(['docs/acesso-remoto.md', 'docs/operacao.md', 'docs/arquitetura.md', 'docs/publicacao.md', 'docs/configuracao.md']);
// `docs/img/` entra por PADRÃO, e não pela lista nominal acima: são as imagens do README, e
// elas se REGERAM (`testes/print-vitrine.js`) toda vez que a tela muda. Lista nominal de PNG
// envelheceria a cada leva de print, e a falha seria silenciosa — README publicado com imagem
// quebrada. O padrão é estreito de propósito: só `.png` de nome simples, nada de subpasta.
// Fica fora da cópia pública: fala com o oráculo da tela Pra revisar pela env de pasta de jobs DO OUTRO projeto
// (contrato dele, não dá para renomear daqui). É prova da casa, não do produto.
const foraDoExport = new Set(['testes/prova-revisar-oraculo.sh']);
const files = git(['ls-files']).split('\n').filter(file => !foraDoExport.has(file) && (roots.has(file) || docs.has(file)
  || /^docs\/img\/[a-z0-9-]+\.png$/.test(file)
  || /^(lib|public|testes|bin|\.github)\//.test(file)));
const problemas = [];
for (const file of roots) if (!files.includes(file)) problemas.push(`${file}: arquivo obrigatório ausente`);
const denied = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-(?:ant-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16}|[a-z0-9-]{1,63}\.ts\.net|\b100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b)/i;
const localHome = os.homedir();
const contents = [];
for (const file of files) {
  const full = path.join(root, file);
  if (!fs.lstatSync(full).isFile()) { problemas.push(`${file}: symlink (não exportar)`); continue; }
  if (/\.(?:key|pem|pfx|p12)$/.test(file) || file === '.env') { problemas.push(`${file}: arquivo privado`); continue; }
  const data = fs.readFileSync(full);
  const text = data.toString('utf8').replace(/\\([/.])/g, '$1');
  const motivos = [];
  // O trecho que casou NÃO vai para a saída: pode ser o próprio segredo.
  if (denied.test(text)) motivos.push('padrão sensível (chave, *.ts.net ou CGNAT)');
  if (localHome !== '/' && text.includes(localHome)) motivos.push('caminho do HOME local');
  // No LICENSE, a linha Copyright é do titular: só ela escapa da lista (a `denied` e o HOME valem no arquivo todo).
  const paraLista = file === 'LICENSE' ? text.split('\n').filter((l) => !/^Copyright\b/.test(l)).join('\n') : text;
  const alvo = normalizar(`${file}\n${paraLista}`); // o NOME do arquivo também conta
  for (const { termo, n } of proibidos) if (alvo.includes(n)) motivos.push(`termo "${termo}"`);
  if (motivos.length) problemas.push(`${file}: ${motivos.join(', ')}`);
  else contents.push({ file, data });
}
if (problemas.length) {
  console.error(`Exportação recusada — ${problemas.length} problema(s):\n${problemas.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
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
