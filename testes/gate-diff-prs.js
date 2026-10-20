#!/usr/bin/env node
'use strict';
// GATE dos PRs abertos do GitHub (card `ver-a-diff-do-codigo`, D97). Bloco (a) — puras de
// `lib/github.js` contra o `gh` FALSO (`testes/fixtures/gh-falso.js`). Bloco (b) — rotas,
// `server.js` filho na porta 7981. Bloco (c) — puras do cliente (public/diff.js) num `vm`.
//
//   node testes/gate-diff-prs.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execSync, spawn } = require('node:child_process');

const diff = require('../lib/diff');
const github = require('../lib/github');

const RAIZ_REPO = path.resolve(__dirname, '..');
const SERVER_JS = path.join(RAIZ_REPO, 'server.js');
const PORTA = 7981;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-diff-prs-'));

let passou = 0;
let total = 0;
let vermelho = false;
function ok(cond, msg) {
  total += 1;
  if (cond) { passou += 1; console.log(`  ✅ ${msg}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${msg}`);
  return false;
}
async function bloco(nome, fn) {
  console.log(`\n${nome}`);
  try { await fn(); } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.stack}`);
  }
}

// ─── `gh` falso — testes/fixtures/gh-falso.js copiado pra um bin de mentira ────────────────────

/** Copia o `gh` falso pra `<tmp>/bin/gh` e escreve a config ao lado; devolve o caminho do bin. */
function prepararGhFalso(config) {
  const dir = fs.mkdtempSync(path.join(TMP, 'gh-'));
  const bin = path.join(dir, 'gh');
  fs.copyFileSync(path.join(RAIZ_REPO, 'testes', 'fixtures', 'gh-falso.js'), bin);
  fs.chmodSync(bin, 0o755);
  const registro = path.join(dir, 'registro.jsonl');
  const caminhoConfig = path.join(dir, 'gh-falso.json');
  const escrever = (novoConfig) => fs.writeFileSync(caminhoConfig, JSON.stringify({ registro, ...novoConfig }));
  escrever(config);
  return {
    bin,
    registro,
    reconfigurar: escrever,
    linhasRegistro: () => (fs.existsSync(registro)
      ? fs.readFileSync(registro, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : []),
  };
}

async function comGhFalso(config, tarefa) {
  const falso = prepararGhFalso(config);
  const anterior = process.env.COCKPIT_GH_BIN;
  process.env.COCKPIT_GH_BIN = falso.bin;
  github._zerarCache();
  try {
    await tarefa(falso);
  } finally {
    if (anterior === undefined) delete process.env.COCKPIT_GH_BIN;
    else process.env.COCKPIT_GH_BIN = anterior;
    github._zerarCache();
  }
}

// ─── (a) puras de lib/github.js (parsers) e lib/github.js com o `gh` falso ─────────────────────

const ITEM_BASE = {
  repository: { nameWithOwner: 'exemplo-org/loja' },
  number: 7,
  title: 'Corrige o carrinho',
  author: { login: 'fulano' },
  updatedAt: '2026-10-18T10:00:00Z',
  isDraft: false,
};

async function blocoA() {
  // ─── lerListaDoGh ───
  const r1 = github.lerListaDoGh(JSON.stringify([ITEM_BASE]));
  ok(Array.isArray(r1) && r1.length === 1, `lerListaDoGh item válido → 1 item (achei ${JSON.stringify(r1)})`);
  const mapeado = r1 && r1[0];
  ok(
    mapeado
      && mapeado.repo === 'exemplo-org/loja'
      && mapeado.numero === 7
      && mapeado.titulo === 'Corrige o carrinho'
      && mapeado.autor === 'fulano'
      && mapeado.atualizado === '2026-10-18T10:00:00Z'
      && mapeado.rascunho === false
      && !('token' in mapeado),
    `lerListaDoGh item válido mapeado sem token (achei ${JSON.stringify(mapeado)})`,
  );

  for (const repoRuim of ['a b/c', '-x/y', 'x/..', 'x/.', 'x']) {
    const lista = github.lerListaDoGh(JSON.stringify([{ ...ITEM_BASE, repository: { nameWithOwner: repoRuim } }]));
    ok(Array.isArray(lista) && lista.length === 0, `lerListaDoGh descarta repo '${repoRuim}' (achei ${JSON.stringify(lista)})`);
  }
  for (const numeroRuim of [0, -1, '12', 1.5]) {
    const lista = github.lerListaDoGh(JSON.stringify([{ ...ITEM_BASE, number: numeroRuim }]));
    ok(Array.isArray(lista) && lista.length === 0, `lerListaDoGh descarta número ${JSON.stringify(numeroRuim)} (achei ${JSON.stringify(lista)})`);
  }

  const tituloGrande = 'x'.repeat(400);
  const r2 = github.lerListaDoGh(JSON.stringify([{ ...ITEM_BASE, title: tituloGrande }]));
  ok(r2 && r2[0] && r2[0].titulo.length === 300, `lerListaDoGh corta título em 300 (achei ${r2 && r2[0] && r2[0].titulo.length})`);

  for (const tituloRuim of [null, 42, { t: 'x' }]) {
    const lista = github.lerListaDoGh(JSON.stringify([{ ...ITEM_BASE, title: tituloRuim }]));
    ok(Array.isArray(lista) && lista.length === 0, `lerListaDoGh descarta título não-string ${JSON.stringify(tituloRuim)} (achei ${JSON.stringify(lista)})`);
  }

  ok(github.lerListaDoGh('{[') === null, "lerListaDoGh JSON inválido → null");

  const itemA = { ...ITEM_BASE, number: 1, updatedAt: '2026-10-10T00:00:00Z' };
  const itemB = { ...ITEM_BASE, number: 2, updatedAt: '2026-10-18T00:00:00Z' };
  const itemC = { ...ITEM_BASE, number: 3, updatedAt: null };
  const ordenado = github.lerListaDoGh(JSON.stringify([itemA, itemB, itemC]));
  const ordem = ordenado && ordenado.map((p) => p.numero).join(',');
  ok(ordem === '2,1,3', `lerListaDoGh ordena por atualizado desc, null no fim (achei ${ordem})`);

  // ─── arquivosDoPatch ───
  const arquivoBase = { caminho: 'a.js', antigo: null, estado: 'modificado', binario: false, modo: null, mais: 1, menos: 0, trechos: [{ antes: 1, depois: 1, cabecalho: '', linhas: [], longas: [] }], semFimDeLinha: { antes: false, depois: false } };
  const outroArquivo = { caminho: 'b.js', antigo: null, estado: 'modificado', binario: false, modo: null, mais: 2, menos: 1, trechos: [{ antes: 1, depois: 1, cabecalho: '', linhas: [], longas: [] }], semFimDeLinha: { antes: false, depois: false } };

  const r3 = github.arquivosDoPatch([arquivoBase], {});
  ok(
    JSON.stringify(r3.arquivos) === JSON.stringify([arquivoBase])
      && r3.cortado.corpo === false && r3.cortado.lista === false && r3.cortado.tempo === false,
    `arquivosDoPatch sem corte → mesmos arquivos, cortado tudo false (achei ${JSON.stringify(r3)})`,
  );

  const r4 = github.arquivosDoPatch([arquivoBase, outroArquivo], { cortado: true });
  const ultimo4 = r4.arquivos[r4.arquivos.length - 1];
  ok(
    ultimo4 && ultimo4.semCorpo === 'cortado' && Array.isArray(ultimo4.trechos) && ultimo4.trechos.length === 0
      && r4.cortado.corpo === true && r4.cortado.lista === true,
    `arquivosDoPatch cortado:true → último sem corpo, cortado.corpo && cortado.lista (achei ${JSON.stringify(r4)})`,
  );

  const patchCortadoNoCabecalho = diff.parsearPatch(
    'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.js b/',
  );
  const r5 = github.arquivosDoPatch(patchCortadoNoCabecalho, {});
  ok(
    !r5.arquivos.some((a) => a.caminho === null) && r5.cortado.lista === true,
    `arquivosDoPatch com corte dentro do cabeçalho → nenhum caminho nulo e cortado.lista===true (achei ${JSON.stringify(r5)})`,
  );

  // ─── RE_REPO / RE_NUMERO exportadas / repoValido ───
  ok(github.RE_REPO.test('exemplo-org/loja') === true, 'RE_REPO aceita exemplo-org/loja');
  for (const repoRuim of ['a b/c', '-x/y', 'x']) {
    ok(github.RE_REPO.test(repoRuim) === false, `RE_REPO rejeita '${repoRuim}'`);
  }
  for (const repoRuim of ['a b/c', '-x/y', 'x/..', 'x/.', 'x']) {
    ok(github.repoValido(repoRuim) === false, `repoValido rejeita '${repoRuim}'`);
  }
  ok(github.repoValido('exemplo-org/loja') === true, 'repoValido aceita exemplo-org/loja');
  ok(github.RE_NUMERO.test('7') === true, 'RE_NUMERO aceita 7');
  for (const numeroRuim of ['0', '-1', '12a', '1.5']) {
    ok(github.RE_NUMERO.test(numeroRuim) === false, `RE_NUMERO rejeita '${numeroRuim}'`);
  }

  // ─── listarPrs com o `gh` falso ───
  const listaDeTres = [
    { ...ITEM_BASE, number: 7 },
    { ...ITEM_BASE, number: 8, title: 'Outra' },
    { ...ITEM_BASE, number: 9, title: 'Mais uma' },
  ];
  await comGhFalso({ modo: 'ok', lista: listaDeTres }, async () => {
    const r = await github.listarPrs();
    ok(r.ok === true && Array.isArray(r.prs) && r.prs.length === 3, `listarPrs modo ok → ok:true, 3 PRs (achei ${JSON.stringify(r)})`);
  });

  // cache: duas chamadas com o mesmo `agora` → 1 linha search; +61s → 2
  await comGhFalso({ modo: 'ok', lista: listaDeTres }, async (falso) => {
    const t0 = Date.now();
    await github.listarPrs({ agora: t0 });
    await github.listarPrs({ agora: t0 });
    const linhas1 = falso.linhasRegistro().filter((l) => l.argv[0] === 'search');
    ok(linhas1.length === 1, `cache: duas chamadas com o mesmo agora → 1 linha search (achei ${linhas1.length})`);
    await github.listarPrs({ agora: t0 + 61_000 });
    const linhas2 = falso.linhasRegistro().filter((l) => l.argv[0] === 'search');
    ok(linhas2.length === 2, `cache: agora + 61s → 2ª linha search (achei ${linhas2.length})`);
  });

  // pedidos simultâneos → 1 linha search (promessa em voo)
  await comGhFalso({ modo: 'ok', lista: listaDeTres }, async (falso) => {
    await Promise.all([github.listarPrs(), github.listarPrs(), github.listarPrs()]);
    const linhas = falso.linhasRegistro().filter((l) => l.argv[0] === 'search');
    ok(linhas.length === 1, `pedidos simultâneos → 1 linha search (achei ${linhas.length})`);
  });

  // modo falha: cache de 15s
  await comGhFalso({ modo: 'falha' }, async (falso) => {
    const t0 = Date.now();
    const r1f = await github.listarPrs({ agora: t0 });
    ok(r1f.ok === false, `listarPrs modo falha → ok:false (achei ${JSON.stringify(r1f)})`);
    await github.listarPrs({ agora: t0 + 10_000 });
    const linhasA = falso.linhasRegistro().filter((l) => l.argv[0] === 'search');
    ok(linhasA.length === 1, `falha: +10s dentro dos 15s de cache → sem linha nova (achei ${linhasA.length})`);
    await github.listarPrs({ agora: t0 + 16_000 });
    const linhasB = falso.linhasRegistro().filter((l) => l.argv[0] === 'search');
    ok(linhasB.length === 2, `falha: +16s passou dos 15s → nova linha (achei ${linhasB.length})`);
  });

  // modo json-ruim
  await comGhFalso({ modo: 'json-ruim' }, async () => {
    const r = await github.listarPrs();
    ok(r.ok === false, `listarPrs modo json-ruim → ok:false (achei ${JSON.stringify(r)})`);
  });

  // modo vazio (lista legítima vazia, distinta de falha)
  await comGhFalso({ modo: 'vazio' }, async () => {
    const r = await github.listarPrs();
    ok(r.ok === true && Array.isArray(r.prs) && r.prs.length === 0 && r.limite === false, `listarPrs modo vazio → ok:true, prs:[], limite:false (achei ${JSON.stringify(r)})`);
  });

  // 30 itens → limite true
  const trinta = Array.from({ length: 30 }, (_, i) => ({ ...ITEM_BASE, number: i + 1, title: `PR ${i + 1}` }));
  await comGhFalso({ modo: 'ok', lista: trinta }, async () => {
    const r = await github.listarPrs();
    ok(r.ok === true && r.prs.length === 30 && r.limite === true, `listarPrs com 30 itens → limite:true (achei ${JSON.stringify({ ok: r.ok, n: r.prs && r.prs.length, limite: r.limite })})`);
  });

  // modo lento: timeout curto → ok:false em menos de 2s
  await comGhFalso({ modo: 'lento' }, async () => {
    const t0 = Date.now();
    const r = await github.listarPrs({ timeoutMs: 300 });
    const dt = Date.now() - t0;
    ok(r.ok === false && dt < 2000, `listarPrs modo lento com timeoutMs:300 → ok:false em < 2s (achei ok=${r.ok}, dt=${dt}ms)`);
  });

  // argv exato do search
  await comGhFalso({ modo: 'ok', lista: listaDeTres }, async (falso) => {
    await github.listarPrs();
    const linha = falso.linhasRegistro().find((l) => l.argv[0] === 'search');
    const esperado = ['search', 'prs', '--state', 'open', '--involves', '@me', '--sort', 'updated', '--order', 'desc', '--json', 'repository,number,title,updatedAt,author,isDraft', '--limit', '30'];
    ok(JSON.stringify(linha && linha.argv) === JSON.stringify(esperado), `argv do search exato (achei ${JSON.stringify(linha && linha.argv)})`);
  });

  // envChaves do registro
  await comGhFalso({ modo: 'ok', lista: listaDeTres }, async (falso) => {
    process.env.GH_DEBUG = '1';
    try {
      await github.listarPrs();
    } finally {
      delete process.env.GH_DEBUG;
    }
    const linha = falso.linhasRegistro().find((l) => l.argv[0] === 'search');
    const chaves = linha ? linha.envChaves : [];
    ok(chaves.includes('GH_PROMPT_DISABLED'), `envChaves contém GH_PROMPT_DISABLED (achei ${JSON.stringify(chaves)})`);
    ok(!chaves.includes('COCKPIT_GH_BIN'), `envChaves NÃO contém COCKPIT_GH_BIN (achei ${JSON.stringify(chaves)})`);
    ok(!chaves.includes('GH_DEBUG'), `envChaves NÃO contém GH_DEBUG (achei ${JSON.stringify(chaves)})`);
    ok(!chaves.some((c) => c.startsWith('COCKPIT_')), `envChaves NÃO contém nenhuma COCKPIT_* (achei ${JSON.stringify(chaves)})`);
  });

  // ─── detalheDoPr ───
  const diffReal = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,2 @@',
    '-linha velha',
    '+linha nova',
    ' linha igual',
    '',
  ].join('\n');
  const viewOk = {
    number: 7, title: 'Corrige o carrinho', author: { login: 'fulano' },
    headRefName: 'feature/carrinho', baseRefName: 'develop', updatedAt: '2026-10-18T10:00:00Z',
    additions: 1, deletions: 1, changedFiles: 1, isDraft: false,
  };
  await comGhFalso({ modo: 'ok', prs: { 'exemplo-org/loja#7': { view: viewOk, diff: diffReal } }, diffModo: 'ok' }, async (falso) => {
    const d = await github.detalheDoPr('exemplo-org/loja', 7);
    ok(d.pr && d.pr.url === 'https://github.com/exemplo-org/loja/pull/7', `detalheDoPr url montada (achei ${d.pr && d.pr.url})`);
    ok(d.pr && d.pr.head === 'feature/carrinho' && d.pr.base === 'develop', `detalheDoPr head/base do view (achei ${JSON.stringify(d.pr)})`);
    ok(d.totais && d.totais.arquivos === 1 && d.totais.mais === 1 && d.totais.menos === 1, `detalheDoPr totais do view (achei ${JSON.stringify(d.totais)})`);
    ok(d.semDiff === false && Array.isArray(d.arquivos) && d.arquivos.length === 1, `detalheDoPr ok → arquivos do patch (achei ${JSON.stringify({ semDiff: d.semDiff, n: d.arquivos && d.arquivos.length })})`);
    const linhaDiff = falso.linhasRegistro().find((l) => l.argv[0] === 'pr' && l.argv[1] === 'diff');
    const esperadoDiff = ['pr', 'diff', '7', '-R', 'exemplo-org/loja', '--color', 'never'];
    ok(JSON.stringify(linhaDiff && linhaDiff.argv) === JSON.stringify(esperadoDiff), `argv do diff exato (achei ${JSON.stringify(linhaDiff && linhaDiff.argv)})`);
  });

  await comGhFalso({ modo: 'ok', prs: { 'exemplo-org/loja#7': { view: viewOk, diff: null } }, diffModo: 'falha' }, async () => {
    const d = await github.detalheDoPr('exemplo-org/loja', 7);
    ok(
      d.semDiff === true && Array.isArray(d.arquivos) && d.arquivos.length === 0
        && d.cortado.corpo === false && d.cortado.lista === false && d.cortado.tempo === false,
      `detalheDoPr diffModo falha → semDiff:true, arquivos:[], cortado tudo false (achei ${JSON.stringify(d)})`,
    );
  });

  await comGhFalso({ modo: 'ok', prs: { 'exemplo-org/loja#7': { view: viewOk, diff: null } }, diffModo: 'grande' }, async () => {
    const d = await github.detalheDoPr('exemplo-org/loja', 7);
    ok(d.cortado && d.cortado.corpo === true, `detalheDoPr diffModo grande → cortado.corpo:true (achei ${JSON.stringify(d.cortado)})`);
    ok(!d.arquivos.some((a) => a.caminho === null), 'detalheDoPr diffModo grande → nenhum arquivo com caminho nulo');
  });

  await comGhFalso({ modo: 'ok', prs: {}, diffModo: 'ok' }, async () => {
    const d = await github.detalheDoPr('exemplo-org/loja', 7);
    ok(d.erro === true, `detalheDoPr com view ausente → {erro:true} (achei ${JSON.stringify(d)})`);
  });

  // ─── prDaLista ───
  await comGhFalso({ modo: 'ok', lista: listaDeTres }, async () => {
    const r1p = await github.prDaLista('exemplo-org/loja', 7);
    ok(r1p && r1p.repo === 'exemplo-org/loja' && r1p.numero === 7, `prDaLista par da lista → item (achei ${JSON.stringify(r1p)})`);
    const r2p = await github.prDaLista('exemplo-org/loja', 999);
    ok(r2p === null, `prDaLista mesmo repo com outro número → null (achei ${JSON.stringify(r2p)})`);
    const r3p = await github.prDaLista('EXEMPLO-ORG/loja', 7);
    ok(r3p === null, `prDaLista repo com caixa diferente → null (achei ${JSON.stringify(r3p)})`);
  });
  await comGhFalso({ modo: 'falha' }, async () => {
    const r = await github.prDaLista('exemplo-org/loja', 7);
    ok(r && r.falhou === true, `prDaLista com GitHub fora → {falhou:true} (achei ${JSON.stringify(r)})`);
  });
}

// ─── (b) rotas — server.js FILHO na porta 7981 (molde `gate-diff.js`/`withServer`) ─────────────

function pedir(rota, metodo = 'GET', cabecalhos = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers: cabecalhos, agent: false }, (res) => {
      const pedacos = [];
      res.on('data', (d) => pedacos.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(pedacos).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });

function confereLivre() {
  let saida = '';
  try { saida = execSync('ss -H -lptn', { encoding: 'utf8' }); } catch { return; }
  if (new RegExp(`:${PORTA}\\b`).test(saida)) {
    console.error(`porta ${PORTA} ocupada — o gate não pode rodar\n${saida}`);
    process.exit(1);
  }
}

/** Sobe `server.js` filho com env FECHADO — mesmo molde de `gate-diff.js`, + `COCKPIT_GH_BIN` do falso. */
async function withServer({ ghBin, token }, tarefa) {
  confereLivre();
  const tmp = fs.mkdtempSync(path.join(TMP, 'srv-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const projetosDir = fs.mkdtempSync(path.join(tmp, 'projetos-'));
  const jobsDir = fs.mkdtempSync(path.join(tmp, 'jobs-'));
  const env = {
    PATH: process.env.PATH,
    HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
    COCKPIT_CERT_DIR: '/dev/null',
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_JOBS_DIR: jobsDir,
    COCKPIT_MONITOR_DIR: path.join(tmp, 'monitor'), COCKPIT_MONITOR_MS: '0',
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(tmp, 'push'),
    COCKPIT_LIDAS_DIR: path.join(tmp, 'lidas'),
    COCKPIT_LEITURAS_DIR: path.join(tmp, 'leituras'),
    COCKPIT_TMUX_SOCKET: `gate-diff-prs-${process.pid}`,
    COCKPIT_DU_BIN: path.join(tmp, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(tmp, 'sem-docker'),
    COCKPIT_GH_BIN: ghBin,
  };
  if (token) env.COCKPIT_TOKEN = token;
  const logPath = path.join(tmp, 'servidor.log');
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [SERVER_JS], { cwd: RAIZ_REPO, env, stdio: ['ignore', logFd, logFd] });
  try {
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`servidor saiu antes do /health (rc=${child.exitCode}) — ver ${logPath}`);
      try { const r = await pedir('/health'); if (r.status === 200) break; } catch { /* ainda subindo */ }
      if (Date.now() - t0 > 10000) throw new Error(`timeout esperando /health — ver ${logPath}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await tarefa(child, logPath);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
    fs.closeSync(logFd);
  }
}

async function blocoB() {
  const TOKEN = 'gate-diff-prs';
  const listaDeTres = [
    { ...ITEM_BASE, number: 7 },
    { ...ITEM_BASE, number: 8, title: 'Outra' },
    { ...ITEM_BASE, number: 9, title: 'Mais uma' },
  ];
  const diffReal = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,2 @@',
    '-linha velha',
    '+linha nova',
    ' linha igual',
    '',
  ].join('\n');
  const viewOk = {
    number: 7, title: 'Corrige o carrinho', author: { login: 'fulano' },
    headRefName: 'feature/carrinho', baseRefName: 'develop', updatedAt: '2026-10-18T10:00:00Z',
    additions: 1, deletions: 1, changedFiles: 1, isDraft: false,
  };
  const falso = prepararGhFalso({
    modo: 'ok', lista: listaDeTres,
    prs: { 'exemplo-org/loja#7': { view: viewOk, diff: diffReal } },
    diffModo: 'ok',
  });

  await withServer({ ghBin: falso.bin, token: TOKEN }, async (_child, logPath) => {
    // sem token
    let r = await pedir('/api/diff/prs');
    ok(r.status === 401, `sem token /api/diff/prs → 401 (achei ${r.status})`);
    r = await pedir('/api/diff/pr?repo=exemplo-org%2Floja&numero=7');
    ok(r.status === 401, `sem token /api/diff/pr → 401 (achei ${r.status})`);

    const cab = bearer(TOKEN);

    // /api/diff/prs ok
    r = await pedir('/api/diff/prs', 'GET', cab);
    ok(r.status === 200, `/api/diff/prs ok → 200 (achei ${r.status})`);
    const corpoPrs = JSON.parse(r.corpo);
    ok(corpoPrs.github === 'ok', `/api/diff/prs github:'ok' (achei ${corpoPrs.github})`);
    ok(Array.isArray(corpoPrs.prs) && corpoPrs.prs.length === 3, `/api/diff/prs 3 itens (achei ${corpoPrs.prs && corpoPrs.prs.length})`);
    const chavesEsperadas = ['repo', 'numero', 'titulo', 'autor', 'atualizado', 'rascunho'].sort().join(',');
    const todasComSeisChaves = corpoPrs.prs.every((p) => Object.keys(p).sort().join(',') === chavesEsperadas);
    ok(todasComSeisChaves, `/api/diff/prs cada item só com as 6 chaves (achei ${JSON.stringify(corpoPrs.prs.map((p) => Object.keys(p)))})`);
    ok(!r.corpo.includes('gho_FALSO_NAO_PODE_VAZAR'), '/api/diff/prs nunca vaza o token do gh falso na resposta');

    r = await pedir('/api/diff/prs?x=1', 'GET', cab);
    ok(r.status === 400, `/api/diff/prs?x=1 → 400 (achei ${r.status})`);

    // /api/diff/pr validações
    r = await pedir('/api/diff/pr?repo=exemplo-org%2Floja', 'GET', cab);
    ok(r.status === 400, `/api/diff/pr sem numero → 400 (achei ${r.status})`);
    for (const numeroRuim of ['abc', '0', '7a', '1e3']) {
      r = await pedir(`/api/diff/pr?repo=exemplo-org%2Floja&numero=${numeroRuim}`, 'GET', cab);
      ok(r.status === 400, `/api/diff/pr numero=${numeroRuim} → 400 (achei ${r.status})`);
    }
    r = await pedir(`/api/diff/pr?repo=${encodeURIComponent('../etc')}&numero=7`, 'GET', cab);
    ok(r.status === 400, `/api/diff/pr repo=../etc → 400 (achei ${r.status})`);
    r = await pedir(`/api/diff/pr?repo=${encodeURIComponent('a b/c')}&numero=7`, 'GET', cab);
    ok(r.status === 400, `/api/diff/pr repo=a%20b/c → 400 (achei ${r.status})`);

    r = await pedir('/api/diff/pr?repo=exemplo-org%2Floja&numero=999', 'GET', cab);
    ok(r.status === 404, `/api/diff/pr fora da lista (numero=999) → 404 (achei ${r.status})`);
    const corpo404 = JSON.parse(r.corpo);
    ok(corpo404.erro === 'este PR não está mais aberto no GitHub', `/api/diff/pr 404 com mensagem própria (achei ${corpo404.erro})`);

    r = await pedir('/api/diff/pr?repo=EXEMPLO-ORG%2Floja&numero=7', 'GET', cab);
    ok(r.status === 404, `/api/diff/pr repo com caixa diferente → 404 (achei ${r.status})`);

    r = await pedir('/api/diff/pr?repo=exemplo-org%2Floja&numero=7&numero=7', 'GET', cab);
    ok(r.status === 400, `/api/diff/pr chave repetida (numero=7&numero=7) → 400 (achei ${r.status})`);

    r = await pedir('/api/diff/pr?repo=exemplo-org%2Floja&numero=7', 'GET', cab);
    ok(r.status === 200, `/api/diff/pr par da lista → 200 (achei ${r.status})`);
    const corpoPr = JSON.parse(r.corpo);
    ok(corpoPr.pr && corpoPr.pr.url === 'https://github.com/exemplo-org/loja/pull/7', `/api/diff/pr url montada (achei ${corpoPr.pr && corpoPr.pr.url})`);
    ok(Array.isArray(corpoPr.arquivos) && corpoPr.arquivos.length > 0, `/api/diff/pr arquivos.length > 0 (achei ${corpoPr.arquivos && corpoPr.arquivos.length})`);
    ok(corpoPr.totais && typeof corpoPr.totais === 'object', `/api/diff/pr totais presente (achei ${JSON.stringify(corpoPr.totais)})`);

    // registro: nenhuma linha pr view/pr diff tocou número 999 ou repo fora da lista — a allowlist barrou ANTES do gh
    const linhasPr = falso.linhasRegistro().filter((l) => l.argv[0] === 'pr');
    const todasValidas = linhasPr.every((l) => {
      const numero = l.argv[2];
      const iR = l.argv.indexOf('-R');
      const repo = iR >= 0 ? l.argv[iR + 1] : null;
      return numero === '7' && repo === 'exemplo-org/loja';
    });
    ok(todasValidas, `registro: nenhuma linha pr view/pr diff tocou numero 999 ou repo fora da lista (achei ${JSON.stringify(linhasPr.map((l) => l.argv))})`);

    // log do servidor não vaza o token do gh falso
    const logTexto = fs.readFileSync(logPath, 'utf8');
    ok(!logTexto.includes('gho_FALSO_NAO_PODE_VAZAR'), 'servidor.log não contém o token do gh falso');
  });

  // 2º servidor: gh falso em modo falha
  const falsoFalha = prepararGhFalso({ modo: 'falha' });
  await withServer({ ghBin: falsoFalha.bin, token: TOKEN }, async () => {
    const cab = bearer(TOKEN);
    let r = await pedir('/api/diff/prs', 'GET', cab);
    ok(r.status === 200, `gh falha: /api/diff/prs → 200 (achei ${r.status})`);
    const corpo = JSON.parse(r.corpo);
    ok(corpo.github === 'falhou' && Array.isArray(corpo.prs) && corpo.prs.length === 0, `gh falha: github:'falhou', prs:[] (achei ${JSON.stringify(corpo)})`);

    r = await pedir('/api/diff/pr?repo=exemplo-org%2Floja&numero=7', 'GET', cab);
    ok(r.status === 502, `gh falha: /api/diff/pr → 502 (achei ${r.status})`);
    const corpoPr = JSON.parse(r.corpo);
    ok(corpoPr.erro === 'não consegui ler o GitHub agora', `gh falha: mensagem própria (achei ${corpoPr.erro})`);
  });

  // 3º servidor: COCKPIT_GH_BIN pra arquivo inexistente (o default do bin/testes.js)
  await withServer({ ghBin: path.join(TMP, 'nao-existe', 'gh'), token: TOKEN }, async () => {
    const cab = bearer(TOKEN);
    const r = await pedir('/api/diff/prs', 'GET', cab);
    ok(r.status === 200, `gh inexistente: /api/diff/prs → 200 (achei ${r.status})`);
    const corpo = JSON.parse(r.corpo);
    ok(corpo.github === 'falhou', `gh inexistente: github:'falhou' (achei ${corpo.github})`);
  });
}

// ─── (c) puras do cliente (public/diff.js, sem DOM) — molde `carregarDiffCliente` de gate-diff.js ─

const vm = require('node:vm');
const PUBLIC_DIR = path.join(RAIZ_REPO, 'public');

let ultimoContextoCliente = null;
function carregarDiffCliente() {
  const dados = new Map();
  const sandbox = {
    document: { getElementById: () => null },
    localStorage: { getItem: (k) => dados.get(k) ?? null, setItem: (k, v) => dados.set(k, v) },
    URLSearchParams,
    console,
  };
  const contexto = vm.createContext(sandbox);
  for (const arquivo of ['traducoes.js', 'i18n.js', 'diff.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  ultimoContextoCliente = contexto;
  return contexto.cockpitDiff;
}

// Chaves novas do catálogo (Fase 4e, D97) — conferidas contra o catálogo e contra `tr('…')` em diff.js.
const CHAVES_NOVAS_CATALOGO = [
  'Em aberto', 'Commits do projeto', 'Job', 'PR', 'job', 'GitHub #{0}', 'rascunho',
  'Nada esperando merge.', 'não consegui ler os jobs agora', 'não consegui ler o GitHub agora',
  'mostrando os 30 PRs mais recentes do GitHub', 'Abrir no GitHub ↗',
  'o GitHub não mandou a diff deste PR — abra no GitHub', 'este PR não está mais aberto no GitHub',
  'Cockpit',
];

async function blocoC() {
  const m = carregarDiffCliente();

  // ─── lerHash / montarHash com repo e pr ───
  ok(JSON.stringify(m.lerHash('#repo=exemplo-org%2Floja&pr=7')) === JSON.stringify({ repo: 'exemplo-org/loja', pr: '7' }),
    `lerHash repo+pr (achei ${JSON.stringify(m.lerHash('#repo=exemplo-org%2Floja&pr=7'))})`);
  const idaRepoPr = m.montarHash({ repo: 'a/b', pr: '3' });
  ok(idaRepoPr === '#repo=a%2Fb&pr=3', `montarHash repo+pr ida-e-volta (achei ${idaRepoPr})`);
  ok(JSON.stringify(m.lerHash(idaRepoPr)) === JSON.stringify({ repo: 'a/b', pr: '3' }), `lerHash(montarHash(repo+pr)) ida-e-volta (achei ${JSON.stringify(m.lerHash(idaRepoPr))})`);
  ok(m.montarHash({ projeto: 'a', commit: 'b', job: 'c', repo: 'd/e', pr: 'f' }) === '#projeto=a&commit=b&job=c&repo=d%2Fe&pr=f',
    `montarHash ordem fixa com as 5 chaves (achei ${m.montarHash({ projeto: 'a', commit: 'b', job: 'c', repo: 'd/e', pr: 'f' })})`);
  ok(JSON.stringify(m.lerHash('#c=x')) === '{}', "lerHash('#c=x') → {} (chave estranha)");

  // ─── misturarEmAberto ───
  const jobs = [
    { id: 'j1', titulo: 'Job 1', projeto: 'demo', fim: '2026-10-18T10:00:00Z' },
    { id: 'j2', titulo: 'Job 2', projeto: 'demo', fim: null },
  ];
  const prs = [
    { repo: 'exemplo-org/loja', numero: 7, titulo: 'PR 7', atualizado: '2026-10-19T10:00:00Z' },
    { repo: 'outra-org/app', numero: 12, titulo: 'PR 12', atualizado: 'lixo' },
  ];
  const mistura = m.misturarEmAberto(jobs, prs);
  ok(mistura.length === 4 && mistura[0].tipo === 'pr' && mistura[0].numero === 7, `misturarEmAberto ordena desc, PR 7 primeiro (achei ${JSON.stringify(mistura.map((i) => [i.tipo, i.id || i.numero]))})`);
  ok(mistura[1].tipo === 'job' && mistura[1].id === 'j1', `misturarEmAberto 2º é o job com data (achei ${JSON.stringify(mistura[1])})`);
  const semData = mistura.slice(2);
  ok(semData.length === 2 && semData[0].tipo === 'job' && semData[1].tipo === 'pr', `misturarEmAberto sem data: job antes de pr (achei ${JSON.stringify(semData.map((i) => i.tipo))})`);
  ok(JSON.stringify(m.misturarEmAberto(null, null)) === '[]', 'misturarEmAberto(null, null) → []');
  ok(JSON.stringify(m.misturarEmAberto('lixo', 'lixo')) === '[]', "misturarEmAberto('lixo', 'lixo') → []");

  // Empate de `quando`: job antes de pr, depois título.
  const jobsEmpate = [{ id: 'jz', titulo: 'Z job', projeto: 'demo', fim: '2026-10-19T10:00:00Z' }];
  const prsEmpate = [{ repo: 'a/b', numero: 1, titulo: 'A pr', atualizado: '2026-10-19T10:00:00Z' }];
  const misturaEmpate = m.misturarEmAberto(jobsEmpate, prsEmpate);
  ok(misturaEmpate[0].tipo === 'job' && misturaEmpate[1].tipo === 'pr', `misturarEmAberto empate de quando: job antes de pr (achei ${JSON.stringify(misturaEmpate.map((i) => i.tipo))})`);

  // ─── paiDe ───
  const p1 = m.paiDe({ projeto: 'p', commit: 'c' }, { diffPasso: 1, anterior: '#projeto=p' });
  ok(JSON.stringify(p1) === JSON.stringify({ estado: { projeto: 'p' }, rotulo: 'Commits', pelaPilha: true }), `paiDe commit com pilha de projeto (achei ${JSON.stringify(p1)})`);

  const p2 = m.paiDe({ projeto: 'p', commit: 'c' }, { diffPasso: 2, anterior: '#job=j' });
  ok(JSON.stringify(p2) === JSON.stringify({ estado: { job: 'j' }, rotulo: 'Job', pelaPilha: true }), `paiDe commit com pilha de job (achei ${JSON.stringify(p2)})`);

  const p3 = m.paiDe({ projeto: 'p', commit: 'c' }, { diffPasso: 0, anterior: null });
  ok(JSON.stringify(p3) === JSON.stringify({ estado: { projeto: 'p' }, rotulo: 'Commits', pelaPilha: false }), `paiDe commit sem pilha → pai padrão (achei ${JSON.stringify(p3)})`);

  const p4 = m.paiDe({ job: 'j' }, { diffPasso: 1, anterior: '' });
  ok(JSON.stringify(p4) === JSON.stringify({ estado: {}, rotulo: 'Em aberto', pelaPilha: true }), `paiDe job com pilha, anterior vazio → Em aberto (achei ${JSON.stringify(p4)})`);

  const p5 = m.paiDe({ job: 'j' }, { diffPasso: 0 });
  ok(JSON.stringify(p5) === JSON.stringify({ estado: {}, rotulo: 'Em aberto', pelaPilha: false }), `paiDe job sem pilha → Em aberto (achei ${JSON.stringify(p5)})`);

  const p6 = m.paiDe({ repo: 'a/b', pr: '3' }, null);
  ok(JSON.stringify(p6) === JSON.stringify({ estado: {}, rotulo: 'Em aberto', pelaPilha: false }), `paiDe PR sem marca → Em aberto (achei ${JSON.stringify(p6)})`);

  ok(m.paiDe({}, null) === null, 'paiDe raiz {} → null');
  ok(m.paiDe({ projeto: 'p' }, null) === null, 'paiDe raiz {projeto} → null');

  const p7 = m.paiDe({ job: 'j' }, { diffPasso: 0, anterior: '#projeto=x' });
  ok(JSON.stringify(p7) === JSON.stringify({ estado: {}, rotulo: 'Em aberto', pelaPilha: false }), `paiDe anterior string mas diffPasso 0 → pelaPilha:false, pai padrão (achei ${JSON.stringify(p7)})`);

  // ─── ehRaiz ───
  ok(m.ehRaiz({}) === true, 'ehRaiz({}) → true');
  ok(m.ehRaiz({ projeto: 'p' }) === true, "ehRaiz({projeto}) → true");
  ok(m.ehRaiz({ pr: '3' }) === true, "ehRaiz({pr}) → true");
  ok(m.ehRaiz({ commit: 'c' }) === true, "ehRaiz({commit}) → true");
  ok(m.ehRaiz({ repo: 'a/b' }) === true, "ehRaiz({repo}) → true");
  ok(m.ehRaiz({ projeto: 'p', commit: 'c' }) === false, "ehRaiz({projeto,commit}) → false");
  ok(m.ehRaiz({ job: 'j' }) === false, "ehRaiz({job}) → false");
  ok(m.ehRaiz({ repo: 'a/b', pr: '3' }) === false, "ehRaiz({repo,pr}) → false");

  // ─── catálogo (gate-idioma só confere o catálogo contra si mesmo) ───
  const fonteDiff = fs.readFileSync(path.join(PUBLIC_DIR, 'diff.js'), 'utf8');
  const fonteServer = fs.readFileSync(path.join(RAIZ_REPO, 'server.js'), 'utf8');
  const catalogo = ultimoContextoCliente.cockpitTraducoes;
  // Algumas chaves chegam a `tr()` por uma VARIÁVEL, nunca por `tr('chave')` literal: 'Job'/'PR' são o
  // RÓTULO do pai (a string crua vem de ROTULO_DO_PAI, consumida por `tr(pai.rotulo)`); a mensagem do
  // PR fora da lista vem do SERVIDOR (server.js) e o cliente consome por `tr(r.corpo.erro)`.
  for (const chave of CHAVES_NOVAS_CATALOGO) {
    ok(typeof catalogo[chave] === 'string' && catalogo[chave].length > 0, `catálogo tem a chave '${chave}' (achei ${JSON.stringify(catalogo[chave])})`);
    const achouLiteral = fonteDiff.includes(`tr('${chave}'`) || fonteDiff.includes(`tr("${chave}"`);
    const achouRotuloDoPai = (chave === 'Job' || chave === 'PR') && fonteDiff.includes(`'${chave}'`) && fonteDiff.includes('tr(pai.rotulo)');
    const achouErroDoServidor = chave === 'este PR não está mais aberto no GitHub'
      && fonteServer.includes(`'${chave}'`) && fonteDiff.includes('tr(r.corpo.erro)');
    ok(achouLiteral || achouRotuloDoPai || achouErroDoServidor, `public/diff.js usa tr('${chave}'…) ou o sink dinâmico (achei literal=${achouLiteral}, rótuloDoPai=${achouRotuloDoPai}, erroDoServidor=${achouErroDoServidor})`);
  }
}

async function principal() {
  await bloco('(a) puras de lib/github.js (parsers) e lib/github.js com o `gh` falso', blocoA);
  await bloco('(b) rotas — GET /api/diff/prs e /api/diff/pr, allowlist, server.js filho na 7981', blocoB);
  await bloco('(c) puras do cliente (public/diff.js, sem DOM): misturarEmAberto, ehRaiz, paiDe, catálogo', blocoC);

  console.log(`\n${passou}/${total} asserções`);
  console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — PRs abertos do GitHub (D97)');
  process.exitCode = vermelho ? 1 : 0;
}

principal();
