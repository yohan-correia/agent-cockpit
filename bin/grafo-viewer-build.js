#!/usr/bin/env node
'use strict';
// Builda o dashboard do understand-anything (MIT) numa cópia em /tmp — o cache do plugin nunca é
// escrito, o `node_modules` entra por symlink — e grava o resultado em `public/grafo/ua/`. Spec
// `2026-10-16-grafo-do-projeto-no-cockpit` (Fase 4). Roda no host, com o plugin instalado.
//
//   node bin/grafo-viewer-build.js
//
// Env: UA_DASHBOARD_DIR (pasta `packages` do plugin; padrão: a maior versão em
// ~/.claude/plugins/cache/understand-anything/understand-anything/<v>/packages), UA_LICENSE
// (LICENSE do UA; padrão: ~/.claude/plugins/marketplaces/understand-anything/LICENSE).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ_REPO = path.resolve(__dirname, '..');
const DESTINO = path.join(RAIZ_REPO, 'public', 'grafo', 'ua');

function erro(msg) { console.error(msg); process.exit(2); }

function acharPastaPlugin() {
  if (process.env.UA_DASHBOARD_DIR) return process.env.UA_DASHBOARD_DIR;
  const base = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'understand-anything', 'understand-anything');
  let versoes;
  try { versoes = fs.readdirSync(base); } catch { return null; }
  if (!versoes.length) return null;
  versoes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const maior = versoes[versoes.length - 1];
  return { pacotes: path.join(base, maior, 'packages'), versao: maior };
}

function acharLicencaUA() {
  if (process.env.UA_LICENSE) return process.env.UA_LICENSE;
  return path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'understand-anything', 'LICENSE');
}

function gerarConfigVite(modulosArq) {
  const linhas = [
    'import { defineConfig } from "vite";',
    'import react from "@vitejs/plugin-react";',
    'import tailwindcss from "@tailwindcss/vite";',
    'import path from "path";',
    'import fs from "fs";',
    '',
    'function cockpitLicencas() {',
    '  return {',
    '    name: "cockpit-licencas",',
    '    generateBundle(_opcoes, bundle) {',
    '      // O build do worker (force-layout.worker) é um sub-build à parte do Rollup/Vite: sem',
    '      // registrar o plugin também em `worker.plugins`, o d3-force dele nunca apareceria aqui.',
    '      // Os dois (build principal + worker) rodam no mesmo processo — lê e junta, nunca pisa.',
    '      const ids = new Set();',
    `      try { for (const id of JSON.parse(fs.readFileSync(${JSON.stringify(modulosArq)}, "utf8"))) ids.add(id); } catch {}`,
    '      for (const chunk of Object.values(bundle)) {',
    '        if (chunk.type === "chunk" && chunk.modules) {',
    '          for (const id of Object.keys(chunk.modules)) ids.add(id);',
    '        }',
    '      }',
    `      fs.writeFileSync(${JSON.stringify(modulosArq)}, JSON.stringify([...ids]));`,
    '    },',
    '  };',
    '}',
    '',
    'export default defineConfig({',
    '  base: "./",',
    '  worker: { plugins: () => [cockpitLicencas()] },',
    '  resolve: { alias: {',
    '    "@understand-anything/core/schema": path.resolve(__dirname, "../core/dist/schema.js"),',
    '    "@understand-anything/core/search": path.resolve(__dirname, "../core/dist/search.js"),',
    '    "@understand-anything/core/types": path.resolve(__dirname, "../core/dist/types.js"),',
    '  } },',
    '  build: { rollupOptions: { output: { manualChunks(id) {',
    '    if (!id.includes("node_modules")) return;',
    '    if (/[\\\\/]node_modules[\\\\/](react|react-dom|scheduler)[\\\\/]/.test(id)) return "react-vendor";',
    '    if (id.includes("node_modules/@xyflow/")) return "xyflow";',
    '    if (id.includes("node_modules/elkjs/")) return "elk";',
    '    if (id.includes("node_modules/graphology")) return "graphology";',
    '    if (id.includes("node_modules/@dagrejs/") || id.includes("node_modules/d3-force/")) return "graph-layout";',
    '    if (id.includes("node_modules/react-markdown/") || id.includes("node_modules/hast-util-to-jsx-runtime/")) return "markdown";',
    '  } } } },',
    '  plugins: [react(), tailwindcss(), cockpitLicencas()],',
    '});',
    '',
  ];
  return linhas.join('\n');
}

/** Pós-processo do `index.html` do build: tira Google Fonts, insere a ponte.js. Aborta se a versão do plugin mudou o HTML. */
function posProcessarIndexHtml(arq) {
  let html = fs.readFileSync(arq, 'utf8');
  html = html.replace(/\s*<link rel="preconnect"[^>]*>\n?/g, '\n');
  html = html.replace(/\s*<link[^>]*fonts\.googleapis[^>]*>\n?/g, '\n');
  const posModulo = html.indexOf('<script type="module"');
  if (posModulo < 0) erro('index.html do build não tem <script type="module"> — a versão do plugin mudou o HTML');
  html = `${html.slice(0, posModulo)}<script src="./ponte.js"></script>\n    ${html.slice(posModulo)}`;
  const semPreconnect = !html.includes('rel="preconnect"');
  const semFonts = !html.includes('fonts.googleapis');
  const comPonte = html.includes('<script src="./ponte.js"></script>');
  if (!semPreconnect || !semFonts || !comPonte) {
    erro(`index.html do build não mudou como esperado (preconnect removido=${semPreconnect} fonts removido=${semFonts} ponte inserida=${comPonte}) — a versão do plugin mudou o HTML`);
  }
  fs.writeFileSync(arq, html);
}

// ─── Licenças (LICENSES.txt) ────────────────────────────────────────────────

/** `.../node_modules/@escopo/nome/dist/x.js` → `@escopo/nome`; `.../node_modules/nome/x.js` → `nome`. */
function pacoteDeId(id) {
  const partes = id.split('/');
  const idx = partes.lastIndexOf('node_modules');
  if (idx < 0) return null;
  const resto = partes.slice(idx + 1);
  if (!resto[0]) return null;
  if (resto[0].startsWith('@')) return resto.length > 1 ? resto.slice(0, 2).join('/') : null;
  return resto[0];
}

function dirDoPacote(id, nomePacote) {
  const partes = id.split('/');
  const idx = partes.lastIndexOf('node_modules');
  const segmentos = nomePacote.split('/');
  return partes.slice(0, idx + 1 + segmentos.length).join('/');
}

function lerPackageJson(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

function primeiroArquivoLicenca(dir) {
  let entradas;
  try { entradas = fs.readdirSync(dir); } catch { return null; }
  const achado = entradas.find((n) => /^(LICENSE|LICENCE|COPYING)/i.test(n));
  return achado ? path.join(dir, achado) : null;
}

function origemDoPackageJson(pkg) {
  if (!pkg) return '';
  if (pkg.repository) {
    const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url;
    if (r) return r.replace(/^git\+/, '').replace(/\.git$/, '');
  }
  return pkg.homepage || '';
}

/** Monta o `LICENSES.txt`: cabeçalho + licença do UA + uma seção por `nome@versão` (ordenada, sem repetir). */
function montarLicenses(idsModulo, licencaUAArq, versaoUa) {
  const pacotes = new Map();
  for (const id of idsModulo) {
    const nome = pacoteDeId(id);
    if (!nome) continue;
    const dir = dirDoPacote(id, nome);
    const pkg = lerPackageJson(dir);
    if (!pkg || pkg.name !== nome) continue;
    const versao = pkg.version || '0.0.0';
    const chave = `${nome}@${versao}`;
    if (pacotes.has(chave)) continue;
    const licencaArq = primeiroArquivoLicenca(dir);
    const texto = licencaArq ? fs.readFileSync(licencaArq, 'utf8') : null;
    const licenca = typeof pkg.license === 'string' ? pkg.license : (pkg.license && pkg.license.type) || 'desconhecida';
    pacotes.set(chave, { nome, versao, licenca, origem: origemDoPackageJson(pkg), texto });
  }

  const ordenados = [...pacotes.values()].sort((a, b) => `${a.nome}@${a.versao}`.localeCompare(`${b.nome}@${b.versao}`));

  const linhas = [];
  linhas.push(`Dashboard do understand-anything ${versaoUa}, MIT, modificado só na config de build: base`);
  linhas.push('relativa, sem Google Fonts, com ponte.js (public/grafo/ponte.js, do projeto, também MIT).');
  linhas.push('');
  linhas.push(fs.readFileSync(licencaUAArq, 'utf8').trim());
  linhas.push('');
  linhas.push('Pacotes empacotados no bundle:');
  for (const p of ordenados) {
    linhas.push('');
    linhas.push(`### ${p.nome}@${p.versao}`);
    linhas.push(`Licença: ${p.licenca}`);
    if (p.origem) linhas.push(`Origem: ${p.origem}`);
    if (p.licenca === 'EPL-2.0' && p.origem) linhas.push(`Código-fonte: ${p.origem} (versão ${p.versao}) — EPL-2.0 §3.2`);
    linhas.push('');
    linhas.push(p.texto ? p.texto.trim() : 'texto não incluído no pacote');
  }
  linhas.push('');
  return linhas.join('\n');
}

function imprimirTamanhos(dir) {
  let totalBytes = 0;
  const arquivos = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { andar(p); continue; }
      const tamanho = fs.statSync(p).size;
      totalBytes += tamanho;
      arquivos.push({ caminho: path.relative(dir, p), tamanho });
    }
  };
  andar(dir);
  console.log(`public/grafo/ua/: ${(totalBytes / 1024 / 1024).toFixed(2)} MB total, ${arquivos.length} arquivo(s)`);
  arquivos.sort((a, b) => b.tamanho - a.tamanho);
  for (const a of arquivos) console.log(`  ${(a.tamanho / 1024).toFixed(1).padStart(9)} KB  ${a.caminho}`);
}

function main() {
  const plugin = acharPastaPlugin();
  if (!plugin) erro('pasta do plugin understand-anything não encontrada (defina UA_DASHBOARD_DIR, ou instale o plugin no cache de ~/.claude/plugins/cache)');
  const { pacotes, versao } = plugin;
  if (!fs.existsSync(pacotes)) erro(`pasta de pacotes do plugin não existe: ${pacotes}`);
  const licencaUAArq = acharLicencaUA();
  if (!fs.existsSync(licencaUAArq)) erro(`licença do understand-anything não encontrada: ${licencaUAArq} (defina UA_LICENSE)`);

  const dashboardSrc = path.join(pacotes, 'dashboard');
  const coreSrc = path.join(pacotes, 'core');
  if (!fs.existsSync(dashboardSrc)) erro(`pasta do dashboard não existe: ${dashboardSrc}`);
  if (!fs.existsSync(coreSrc)) erro(`pasta do core não existe: ${coreSrc}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grafo-viewer-'));
  try {
    const tmpDashboard = path.join(tmp, 'packages', 'dashboard');
    const tmpCore = path.join(tmp, 'packages', 'core');
    fs.mkdirSync(tmpDashboard, { recursive: true });
    fs.mkdirSync(tmpCore, { recursive: true });

    for (const nome of ['src', 'index.html', 'tsconfig.json', 'tsconfig.app.json', 'package.json']) {
      fs.cpSync(path.join(dashboardSrc, nome), path.join(tmpDashboard, nome), { recursive: true });
    }
    fs.mkdirSync(path.join(tmpDashboard, 'public'), { recursive: true });
    for (const nome of fs.readdirSync(path.join(dashboardSrc, 'public'))) {
      if (!nome.startsWith('favicon.')) continue;
      fs.cpSync(path.join(dashboardSrc, 'public', nome), path.join(tmpDashboard, 'public', nome));
    }
    fs.symlinkSync(path.join(dashboardSrc, 'node_modules'), path.join(tmpDashboard, 'node_modules'));

    fs.cpSync(path.join(coreSrc, 'dist'), path.join(tmpCore, 'dist'), { recursive: true });
    fs.cpSync(path.join(coreSrc, 'package.json'), path.join(tmpCore, 'package.json'));
    fs.symlinkSync(path.join(coreSrc, 'node_modules'), path.join(tmpCore, 'node_modules'));

    const modulosArq = path.join(tmp, 'modulos.json');
    const cfgArq = path.join(tmpDashboard, 'vite.config.cockpit.ts');
    fs.writeFileSync(cfgArq, gerarConfigVite(modulosArq));

    const distDir = path.join(tmp, 'dist');
    const vite = path.join(tmpDashboard, 'node_modules', '.bin', 'vite');
    const r = spawnSync(vite, ['build', '--config', cfgArq, '--outDir', distDir, '--emptyOutDir'], { cwd: tmpDashboard, stdio: 'inherit' });
    if (r.status !== 0) erro(`vite build falhou (rc ${r.status})`);

    posProcessarIndexHtml(path.join(distDir, 'index.html'));

    const idsModulo = JSON.parse(fs.readFileSync(modulosArq, 'utf8'));
    const licencas = montarLicenses(idsModulo, licencaUAArq, versao);
    fs.writeFileSync(path.join(distDir, 'LICENSES.txt'), licencas);
    fs.writeFileSync(path.join(distDir, 'VERSAO.txt'), `understand-anything ${versao}\n`);

    fs.rmSync(DESTINO, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
    fs.cpSync(distDir, DESTINO, { recursive: true });

    imprimirTamanhos(DESTINO);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
