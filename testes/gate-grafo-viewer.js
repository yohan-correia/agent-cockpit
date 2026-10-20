#!/usr/bin/env node
'use strict';
// GATE do dashboard vendorizado (public/grafo/ua/) e da ponte (public/grafo/ponte.js) — spec
// `2026-10-16-grafo-do-projeto-no-cockpit` (Fase 4). Node puro: não builda nada — só confere o
// que o `bin/grafo-viewer-build.js` já gravou em disco — e roda a ponte num `vm` com fetch falso.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAIZ_REPO = path.resolve(__dirname, '..');
const DIR_UA = path.join(RAIZ_REPO, 'public', 'grafo', 'ua');
const DIR_ASSETS = path.join(DIR_UA, 'assets');
const PONTE = path.join(RAIZ_REPO, 'public', 'grafo', 'ponte.js');

let passou = 0;
let total = 0;
let vermelho = false;

function ok(condicao, mensagem) {
  total += 1;
  if (condicao) { passou += 1; console.log(`  ✅ ${mensagem}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${mensagem}`);
  return false;
}

async function bloco(nome, fn) {
  console.log(`\n${nome}`);
  try { await fn(); } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.stack}`);
  }
}

function esperarMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

function listarArquivos(dir) {
  const resultado = [];
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return resultado; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) resultado.push(...listarArquivos(p));
    else resultado.push(p);
  }
  return resultado;
}

/** Roda `public/grafo/ponte.js` num `vm` novo, com `window.fetch` trocado por `fetchFalso`. */
function carregarPonte(fetchFalso, tetoMs) {
  const chamadas = [];
  const window = { fetch: async (url, opcoes) => { chamadas.push(url); return fetchFalso(url, opcoes); } };
  const sandbox = { window, setTimeout, clearTimeout };
  if (tetoMs !== undefined) sandbox.__PONTE_TETO_MS = tetoMs;
  const contexto = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PONTE, 'utf8'), contexto, { filename: 'ponte.js' });
  return { window, chamadas };
}

function respostaOk(corpo) {
  return { ok: true, clone() { return this; }, json: async () => corpo };
}

// ─── 1/1b. index.html e CSS ─────────────────────────────────────────────────

async function blocoIndexEOutros() {
  await bloco('1. index.html vendorizado: ponte.js antes do módulo, sem Google Fonts, sem caminho absoluto, sem grafo de demonstração', () => {
    const arq = path.join(DIR_UA, 'index.html');
    ok(fs.existsSync(arq), `${arq} existe`);
    if (!fs.existsSync(arq)) return;
    const html = fs.readFileSync(arq, 'utf8');
    const semComentarios = html.replace(/<!--[\s\S]*?-->/g, '');
    const posPonte = html.indexOf('<script src="./ponte.js"></script>');
    const posModulo = html.indexOf('<script type="module"');
    ok(posPonte >= 0, 'tem <script src="./ponte.js"></script>');
    ok(posPonte >= 0 && posModulo >= 0 && posPonte < posModulo, 'ponte.js vem ANTES do primeiro <script type="module"');
    ok(!semComentarios.includes('googleapis'), 'sem googleapis fora de comentário');
    ok(!semComentarios.includes('gstatic'), 'sem gstatic fora de comentário');
    ok(!semComentarios.includes('http://') && !semComentarios.includes('https://'), 'sem http(s):// fora de comentário');
    ok(!/href="\//.test(html), 'nenhum href="/ (tudo relativo — o favicon do original era absoluto)');
    ok(!/src="\//.test(html), 'nenhum src="/ (tudo relativo)');
    ok(!fs.existsSync(path.join(DIR_UA, 'knowledge-graph.json')), 'sem knowledge-graph.json de demonstração em public/grafo/ua/');
  });

  await bloco('1b. CSS é o do Tailwind: ./assets/index-*.css existe, > 20 KB, contém --tw-', () => {
    const arq = path.join(DIR_UA, 'index.html');
    if (!fs.existsSync(arq)) { ok(false, 'index.html ausente — não dá para achar o CSS'); return; }
    const html = fs.readFileSync(arq, 'utf8');
    const m = html.match(/href="\.\/assets\/(index-[^"]+\.css)"/);
    ok(!!m, `index.html referencia ./assets/index-*.css (achei: ${m && m[1]})`);
    if (!m) return;
    const cssArq = path.join(DIR_UA, 'assets', m[1]);
    ok(fs.existsSync(cssArq), `${cssArq} existe`);
    if (!fs.existsSync(cssArq)) return;
    const tamanho = fs.statSync(cssArq).size;
    ok(tamanho > 20 * 1024, `CSS > 20 KB (achei ${tamanho} bytes)`);
    const css = fs.readFileSync(cssArq, 'utf8');
    ok(css.includes('--tw-'), 'CSS contém --tw- (marca do Tailwind 4)');
  });

  await bloco('2. LICENSES.txt: MIT, copyright do UA, seção elkjs com EPL-2.0 e URL, seção por pacote, sem cabeçalho repetido', () => {
    const arq = path.join(DIR_UA, 'LICENSES.txt');
    ok(fs.existsSync(arq), `${arq} existe`);
    if (!fs.existsSync(arq)) return;
    const texto = fs.readFileSync(arq, 'utf8');
    ok(texto.includes('MIT'), 'contém "MIT"');
    ok(texto.includes('Copyright (c) 2026 Yuxiang Lin'), 'contém a linha de copyright do understand-anything');
    const temElk = /elkjs[\s\S]{0,4000}EPL-2\.0/.test(texto) && /elkjs[\s\S]{0,4000}https?:\/\//.test(texto);
    ok(temElk, 'tem seção elkjs com EPL-2.0 e uma URL de código-fonte');
    for (const pacote of ['react', '@xyflow/react', 'elkjs', 'd3-force', 'graphology', 'zustand']) {
      ok(texto.includes(pacote), `menciona o pacote ${pacote}`);
    }
    const cabecalhos = [...texto.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    ok(cabecalhos.length > 0, `achei ${cabecalhos.length} cabeçalho(s) de seção (### nome@versão)`);
    const repetidos = cabecalhos.filter((c, i) => cabecalhos.indexOf(c) !== i);
    ok(repetidos.length === 0, `nenhum cabeçalho de seção repetido (achei: ${repetidos.join(', ') || 'nenhum'})`);
  });

  await bloco('3. THIRD_PARTY_NOTICES.md cita public/grafo/ua/ e LICENSES.txt', () => {
    const texto = fs.readFileSync(path.join(RAIZ_REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    ok(texto.includes('public/grafo/ua/'), 'cita public/grafo/ua/');
    ok(texto.includes('LICENSES.txt'), 'cita LICENSES.txt');
  });

  await bloco('4. Nenhum arquivo de public/grafo/ contém /home/ nem os.homedir()', () => {
    const dir = path.join(RAIZ_REPO, 'public', 'grafo');
    const arquivos = listarArquivos(dir);
    ok(arquivos.length > 0, `achei ${arquivos.length} arquivo(s) em public/grafo/`);
    const comHome = [];
    for (const a of arquivos) {
      let texto;
      try { texto = fs.readFileSync(a, 'utf8'); } catch { continue; }
      if (texto.includes('/home/') || texto.includes('os.homedir()')) comHome.push(a);
    }
    ok(comHome.length === 0, `nenhum arquivo contém /home/ nem os.homedir() (achei em: ${comHome.join(', ') || 'nenhum'})`);
  });

  await bloco('5. A lista DADOS da ponte cobre todo caminho de dado que o bundle pede', () => {
    const ponteTexto = fs.readFileSync(PONTE, 'utf8');
    const mDados = ponteTexto.match(/DADOS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    ok(!!mDados, 'achei a lista DADOS no fonte da ponte');
    const listaPonte = mDados ? [...mDados[1].matchAll(/['"]\/([a-z][a-z-]*\.json)['"]/g)].map((m) => m[1]) : [];
    ok(listaPonte.length > 0, `lista DADOS tem ${listaPonte.length} entrada(s) (achei: ${listaPonte.join(', ')})`);

    const arquivosJs = listarArquivos(DIR_ASSETS).filter((a) => a.endsWith('.js'));
    ok(arquivosJs.length > 0, `achei ${arquivosJs.length} .js em public/grafo/ua/assets/`);

    const achados = new Set();
    for (const arq of arquivosJs) {
      const texto = fs.readFileSync(arq, 'utf8');
      for (const m of texto.matchAll(/["'`]([a-z][a-z-]*\.json)["'`?]/g)) achados.add(m[1]);
      for (const m of texto.matchAll(/["'`]\/([a-z][a-z-]*\.json)\b/g)) achados.add(m[1]);
    }

    const CONTROLE = ['knowledge-graph.json', 'meta.json', 'staleness.json', 'file-content.json'];
    for (const nome of CONTROLE) ok(achados.has(nome), `a varredura achou "${nome}" no bundle (controle do próprio gate)`);

    const foraDaLista = [...achados].filter((nome) => !listaPonte.includes(nome));
    ok(foraDaLista.length === 0, `todo nome achado no bundle está na lista DADOS da ponte (fora: ${foraDaLista.join(', ') || 'nenhum'})`);

    const workers = listarArquivos(DIR_ASSETS).filter((a) => /force-layout\.worker-.*\.js$/.test(path.basename(a)));
    ok(workers.length > 0, `achei ${workers.length} force-layout.worker-*.js`);
    for (const w of workers) {
      const texto = fs.readFileSync(w, 'utf8');
      ok(!texto.includes('fetch('), `${path.basename(w)} não faz fetch(`);
    }
  });
}

// ─── 6. a ponte num vm ──────────────────────────────────────────────────────

async function blocoPonte() {
  ok(fs.existsSync(PONTE), `${PONTE} existe`);
  if (!fs.existsSync(PONTE)) return;

  await bloco('6a. /knowledge-graph.json e /file-content.json ficam relativos, mantendo a query, com &sha= depois do grafo resolver', async () => {
    const { window, chamadas } = carregarPonte(() => respostaOk({ project: { gitCommitHash: 'abc' } }), 5000);
    await window.fetch('/knowledge-graph.json?token=t');
    ok(chamadas[0] === './knowledge-graph.json?token=t', `knowledge-graph relativo, query intacta (achei ${chamadas[0]})`);
    await esperarMs(10);
    await window.fetch('/file-content.json?token=t&path=a.js');
    ok(chamadas[1] === './file-content.json?token=t&path=a.js&sha=abc', `file-content ganha &sha= depois do kg (achei ${chamadas[1]})`);
  });

  await bloco('6b. file-content disparado ANTES do kg resolver só chega ao fake DEPOIS (ordem provada)', async () => {
    let resolverKG;
    const kgPromessa = new Promise((r) => { resolverKG = r; });
    const { window, chamadas } = carregarPonte(async (url) => {
      if (url === './knowledge-graph.json?token=t') { await kgPromessa; return respostaOk({ project: { gitCommitHash: 'abc' } }); }
      return respostaOk({});
    }, 5000);

    const pKG = window.fetch('/knowledge-graph.json?token=t');
    const pFC = window.fetch('/file-content.json?token=t&path=a.js'); // disparado antes do kg resolver

    await esperarMs(20);
    ok(chamadas.length === 1, `só o knowledge-graph chegou ao fake por enquanto (achei ${chamadas.length})`);

    resolverKG();
    await pKG;
    await pFC;
    ok(chamadas.length === 2, 'depois do kg resolver, o file-content chega ao fake');
    ok(chamadas[1] === './file-content.json?token=t&path=a.js&sha=abc', `file-content leva &sha=abc (achei ${chamadas[1]})`);
  });

  await bloco('6c. urls fora da lista DADOS passam intactas (assets, externas, já relativas)', async () => {
    const { window, chamadas } = carregarPonte(() => respostaOk({}), 5000);
    const urls = ['/assets/x.js', 'https://x/y.json', '//x/meta.json', './meta.json'];
    for (const u of urls) await window.fetch(u);
    ok(JSON.stringify(chamadas) === JSON.stringify(urls), `todas passaram intactas (achei ${JSON.stringify(chamadas)})`);
  });

  await bloco('6d. knowledge-graph que falha → file-content sai sem sha (não fica pendurado)', async () => {
    const { window, chamadas } = carregarPonte((url) => {
      if (url.includes('knowledge-graph')) return Promise.reject(new Error('rede caiu'));
      return respostaOk({});
    }, 5000);
    await window.fetch('/knowledge-graph.json?token=t').catch(() => {});
    await window.fetch('/file-content.json?token=t&path=a.js');
    ok(chamadas[1] === './file-content.json?token=t&path=a.js', `file-content sem &sha= depois da falha (achei ${chamadas[1]})`);
  });

  await bloco('6e. knowledge-graph nunca pedido → file-content sai sem sha depois do teto (50 ms no gate)', async () => {
    const { window, chamadas } = carregarPonte(() => respostaOk({}), 50);
    const t0 = Date.now();
    await window.fetch('/file-content.json?token=t&path=a.js');
    const dt = Date.now() - t0;
    ok(dt >= 40, `esperou perto do teto antes de sair (${dt} ms)`);
    ok(chamadas[0] === './file-content.json?token=t&path=a.js', `sem &sha= (achei ${chamadas[0]})`);
  });

  await bloco('6f. knowledge-graph chega DEPOIS do teto → 1º file-content sem sha, 2º com sha', async () => {
    let resolverKG;
    const kgPromessa = new Promise((r) => { resolverKG = r; });
    const { window, chamadas } = carregarPonte(async (url) => {
      if (url.includes('knowledge-graph')) { await kgPromessa; return respostaOk({ project: { gitCommitHash: 'abc' } }); }
      return respostaOk({});
    }, 50);

    window.fetch('/knowledge-graph.json?token=t'); // nunca resolve antes do teto de 50 ms
    await window.fetch('/file-content.json?token=t&path=a.js'); // sai pelo teto, sem sha
    ok(chamadas[1] === './file-content.json?token=t&path=a.js', `1º file-content sem sha (achei ${chamadas[1]})`);

    resolverKG();
    await esperarMs(30); // dá tempo do sha assentar

    await window.fetch('/file-content.json?token=t&path=b.js');
    const ultima = chamadas[chamadas.length - 1];
    ok(ultima === './file-content.json?token=t&path=b.js&sha=abc', `2º file-content com sha (achei ${ultima})`);
  });
}

// ─── despacho ────────────────────────────────────────────────────────────────

async function principal() {
  await blocoIndexEOutros();
  await blocoPonte();

  console.log(`\n${passou}/${total} asserções`);
  console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — dashboard vendorizado e ponte');
  process.exitCode = vermelho ? 1 : 0;
}

principal();
