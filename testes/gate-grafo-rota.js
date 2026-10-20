#!/usr/bin/env node
'use strict';
// GATE das rotas /api/grafos e /grafo/<projeto>/ — spec/plano `2026-10-16-grafo-do-projeto-no-cockpit`
// (Fase 5). Sobe `server.js` FILHO na porta 7933 (#19/#24), com HOME e COCKPIT_GRAFOS_DIR no tmp
// (#57/#62/#78) e ambiente FECHADO (A10: COCKPIT_JOBS_DIR; M-rede: COCKPIT_MONITOR_). Casos 1-4,7
// (o 5/6/8 moram em `gate-grafo-dados.js`, orçamento de tempo).
//
//   node testes/gate-grafo-rota.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

const RAIZ_REPO = path.resolve(__dirname, '..');
const BIN_GRAFO = path.join(RAIZ_REPO, 'bin', 'grafo.js');
const SERVER_JS = path.join(RAIZ_REPO, 'server.js');
const PORTA = 7933;

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
function esperarMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── git de fixture ─────────────────────────────────────────────────────────

function git(repo, args, envExtra) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=gate', '-c', 'user.email=gate@example.com', ...args], {
    encoding: 'utf8', env: envExtra ? { ...process.env, ...envExtra } : process.env,
  });
}
function escreverEComitar(repo, arquivos, msg) {
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(repo, nome)), { recursive: true });
    fs.writeFileSync(path.join(repo, nome), conteudo);
  }
  git(repo, ['add', ...Object.keys(arquivos)]);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}
function gerarGrafo(repo, grafosDir) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [BIN_GRAFO, 'gerar', repo], {
    encoding: 'utf8', env: { ...process.env, COCKPIT_GRAFOS_DIR: grafosDir },
  });
  if (r.status !== 0) throw new Error(`gerar falhou (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

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
const bearer = (token) => (token ? { authorization: `Bearer ${token}` } : {});

// Copiado de `freshness.ts:95-158` (`isGraphFreshnessResult`), pacote `dashboard` do
// understand-anything — confere que cada resposta de `staleness.json` é o formato que o
// dashboard de verdade valida (a faixa "could not be refreshed" reprova em silêncio, sem
// console.error — é por isso que o gate precisa da MESMA regra, não de um palpite equivalente).
const RAZOES_DESCONHECIDO = new Set(['missing-graph-commit', 'git-head-unavailable', 'graph-commit-unavailable', 'git-command-timeout', 'freshness-request-failed']);
const RELACOES = new Set(['behind', 'ahead', 'diverged']);
const ehRegistro = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const ehStringNaoVazia = (v) => typeof v === 'string' && v.length > 0;
const campoStringOpcional = (o, c) => !(c in o) || typeof o[c] === 'string';
const hashOpcional = (o, c) => !(c in o) || ehStringNaoVazia(o[c]);
const inteiroNaoNegativo = (v) => Number.isInteger(v) && v >= 0;
const listaDeArquivosMudados = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
function isGraphFreshnessResult(v) {
  if (!ehRegistro(v) || typeof v.status !== 'string') return false;
  if (!campoStringOpcional(v, 'lastAnalyzedAt')) return false;
  if (v.status === 'unknown') {
    return typeof v.reason === 'string' && RAZOES_DESCONHECIDO.has(v.reason) && hashOpcional(v, 'graphCommitHash') && hashOpcional(v, 'headCommitHash');
  }
  if (!ehStringNaoVazia(v.graphCommitHash) || !ehStringNaoVazia(v.headCommitHash)
    || !inteiroNaoNegativo(v.changedFileCount) || !listaDeArquivosMudados(v.changedFiles)
    || v.changedFileCount !== v.changedFiles.length
    || !inteiroNaoNegativo(v.commitsBehind) || !inteiroNaoNegativo(v.commitsAhead)) return false;
  if (v.status === 'fresh') return v.changedFileCount === 0 && v.commitsBehind === 0 && v.commitsAhead === 0;
  if (v.status === 'dirty') return v.changedFileCount > 0 && v.commitsBehind === 0 && v.commitsAhead === 0;
  if (v.status === 'stale') return v.changedFileCount > 0 && typeof v.relation === 'string' && RELACOES.has(v.relation);
  return false;
}

function confereLivre() {
  let saida = '';
  try { saida = execSync(`ss -H -lptn`, { encoding: 'utf8' }); } catch { return; }
  if (new RegExp(`:${PORTA}\\b`).test(saida)) {
    console.error(`porta ${PORTA} ocupada — o gate não pode rodar\n${saida}`);
    process.exit(1);
  }
}

/** Sobe `server.js` filho com env FECHADO (#78/#82) e espera `/health`. Derruba pelo pid no finally. */
async function withServer({ projetosDir, grafosDir, token }, tarefa) {
  confereLivre();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-rota-srv-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
    COCKPIT_CERT_DIR: '/dev/null', // #19: HTTP puro
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_GRAFOS_DIR: grafosDir, // #57/#62/#78: vence o HOME
    COCKPIT_JOBS_DIR: path.join(tmp, 'jobs'), // A10 do gate-jobs-disco
    COCKPIT_MONITOR_DIR: path.join(tmp, 'monitor'), COCKPIT_MONITOR_MS: '0', // M-rede (#82)
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(tmp, 'push'),
    COCKPIT_LIDAS_DIR: path.join(tmp, 'lidas'),
    COCKPIT_LEITURAS_DIR: path.join(tmp, 'leituras'),
    COCKPIT_TMUX_SOCKET: `gate-grafo-rota-${process.pid}`,
    COCKPIT_DU_BIN: path.join(tmp, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(tmp, 'sem-docker'),
  };
  if (token) env.COCKPIT_TOKEN = token;
  const child = spawn(process.execPath, [SERVER_JS], { cwd: RAIZ_REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let saidaErro = '';
  child.stderr.on('data', (d) => { saidaErro += d; });
  try {
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`servidor saiu antes do /health (rc=${child.exitCode}) — ${saidaErro}`);
      try {
        const r = await pedir('/health', 'GET');
        if (r.status === 200) break;
      } catch { /* ainda subindo */ }
      if (Date.now() - t0 > 10000) throw new Error(`timeout esperando /health — ${saidaErro}`);
      await esperarMs(100);
    }
    await tarefa();
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
  }
}

// ─── fixture ────────────────────────────────────────────────────────────────

function montarFixture() {
  const projetosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-rota-projetos-'));
  const grafosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-rota-grafos-'));

  // app-um: develop com a.js + bin.dat (binário, byte nulo, extensão fora do indexador — nunca
  // vira nó pelo extrator; injetado à mão no grafo publicado para o caso 415, abaixo).
  const appUm = path.join(projetosDir, 'app-um');
  fs.mkdirSync(appUm);
  git(appUm, ['init', '-q', '-b', 'develop']);
  const shaC1 = escreverEComitar(appUm, {
    'a.js': 'export function f() { return 1; }\n',
    'bin.dat': Buffer.from([0x42, 0x00, 0x43]),
  }, 'c1');
  gerarGrafo(appUm, grafosDir);
  // Injeta o nó `file:bin.dat` à mão (o extrator nunca o produziria — a prova é a #415, não a
  // extração): o blob já está committado no MESMO sha, então `git show` o encontra sem alterar
  // o sha da develop (o caso 1 — "em-dia" — continua valendo).
  const grafoArq = path.join(grafosDir, 'app-um', 'knowledge-graph.json');
  const grafoUm = JSON.parse(fs.readFileSync(grafoArq, 'utf8'));
  grafoUm.nodes.push({ id: 'file:bin.dat', type: 'file', name: 'bin.dat', filePath: 'bin.dat', summary: '', tags: [], complexity: 'simple' });
  fs.writeFileSync(grafoArq, JSON.stringify(grafoUm));

  // checkout preso numa feature, com a.js diferente e SUJO no disco — o file-content tem de
  // ler a develop (git show), nunca o checkout.
  git(appUm, ['checkout', '-q', '-b', 'feat']);
  escreverEComitar(appUm, { 'a.js': 'export function g() { return 2; }\n', 'b.js': 'export function h() {}\n' }, 'c2 (feat)');
  fs.writeFileSync(path.join(appUm, 'a.js'), 'export function g() { return 2; } // sujo\n');

  // app-dois: develop, sem grafo gerado.
  const appDois = path.join(projetosDir, 'app-dois');
  fs.mkdirSync(appDois);
  git(appDois, ['init', '-q', '-b', 'develop']);
  escreverEComitar(appDois, { 'x.js': 'export function x() {}\n' }, 'c1');

  // sem-develop: só main.
  const semDevelop = path.join(projetosDir, 'sem-develop');
  fs.mkdirSync(semDevelop);
  git(semDevelop, ['init', '-q', '-b', 'main']);
  escreverEComitar(semDevelop, { 'y.js': 'export function y() {}\n' }, 'c1');

  // pasta-solta: sem git — nunca aparece no diálogo.
  const pastaSolta = path.join(projetosDir, 'pasta-solta');
  fs.mkdirSync(pastaSolta);
  fs.writeFileSync(path.join(pastaSolta, 'z.txt'), 'x');

  return { projetosDir, grafosDir, appUm, appDois, semDevelop, pastaSolta, shaC1 };
}

// ─── casos ──────────────────────────────────────────────────────────────────

async function principal() {
  const f = montarFixture();
  const TOKEN = 'segredo-gate';

  await withServer({ projetosDir: f.projetosDir, grafosDir: f.grafosDir, token: TOKEN }, async () => {
    await bloco('1. GET /api/grafos: token, ordem, estados, sem caminho/sha', async () => {
      const semToken = await pedir('/api/grafos', 'GET');
      ok(semToken.status === 401, `sem token ⇒ 401 (achei ${semToken.status})`);

      const r = await pedir('/api/grafos', 'GET', bearer(TOKEN));
      ok(r.status === 200, `com token ⇒ 200 (achei ${r.status})`);
      const corpo = JSON.parse(r.corpo);
      const nomes = corpo.projetos.map((p) => p.nome);
      ok(JSON.stringify(nomes) === JSON.stringify(['app-um', 'app-dois', 'sem-develop']),
        `projetos só com app-um, app-dois, sem-develop, app-um primeiro (achei ${JSON.stringify(nomes)})`);
      const pUm = corpo.projetos.find((p) => p.nome === 'app-um');
      ok(pUm && pUm.grafo && pUm.grafo.estado === 'em-dia', `app-um.grafo.estado === em-dia (achei ${pUm && pUm.grafo && pUm.grafo.estado})`);
      const pDois = corpo.projetos.find((p) => p.nome === 'app-dois');
      ok(pDois && pDois.grafo === null, `app-dois.grafo === null (achei ${JSON.stringify(pDois && pDois.grafo)})`);
      const pSemDevelop = corpo.projetos.find((p) => p.nome === 'sem-develop');
      ok(pSemDevelop && pSemDevelop.develop === false, `sem-develop.develop === false (achei ${pSemDevelop && pSemDevelop.develop})`);
      ok(!r.corpo.includes('/') && !r.corpo.includes(f.projetosDir) && !r.corpo.includes(f.shaC1),
        'o JSON não contém "/" de caminho, COCKPIT_PROJETOS_DIR nem o sha (#22)');
    });

    await bloco('2. /grafo/<projeto>: redirect com barra, casca sem oráculo, nome fora do padrão', async () => {
      const semBarra = await pedir('/grafo/app-um', 'GET');
      ok(semBarra.status === 301 && semBarra.headers.location === 'app-um/', `/grafo/app-um ⇒ 301 location app-um/ (achei ${semBarra.status} ${semBarra.headers.location})`);

      const comCockpit = await pedir('/cockpit/grafo/app-um', 'GET');
      ok(comCockpit.status === 301 && comCockpit.headers.location === 'app-um/', `/cockpit/grafo/app-um ⇒ 301 location app-um/ (achei ${comCockpit.status} ${comCockpit.headers.location})`);

      const existe = await pedir('/grafo/app-um/', 'GET');
      ok(existe.status === 200 && existe.corpo.includes('./ponte.js'), `/grafo/app-um/ ⇒ 200 HTML com ./ponte.js (achei ${existe.status})`);

      const naoExiste = await pedir('/grafo/nao-existe/', 'GET');
      ok(naoExiste.status === 200 && naoExiste.corpo.includes('./ponte.js'), `/grafo/nao-existe/ ⇒ 200 também (casca sem oráculo de nome — achei ${naoExiste.status})`);

      const nomeInvalido = await pedir('/grafo/a.b/', 'GET');
      ok(nomeInvalido.status === 404, `/grafo/a.b/ ⇒ 404 — nome fora de NOME_DE_PASTA (achei ${nomeInvalido.status})`);

      const semNome = await pedir('/grafo', 'GET');
      ok(semNome.status === 404, `/grafo (sem barra) ⇒ 404 — sem página-índice (achei ${semNome.status})`);
    });

    await bloco('3. assets: MIME, cache, trava de caminho, favicon', async () => {
      const ponte = await pedir('/grafo/app-um/ponte.js', 'GET');
      ok(ponte.status === 200 && ponte.headers['content-type'].includes('text/javascript'), `ponte.js ⇒ 200 text/javascript (achei ${ponte.status} ${ponte.headers['content-type']})`);
      ok(ponte.headers['cache-control'] === 'no-cache', `ponte.js com cache-control no-cache (achei ${ponte.headers['cache-control']})`);

      const assetsDir = path.join(RAIZ_REPO, 'public', 'grafo', 'ua', 'assets');
      const assetReal = fs.readdirSync(assetsDir).find((n) => n.endsWith('.js'));
      const rAsset = await pedir(`/grafo/app-um/assets/${assetReal}`, 'GET');
      ok(rAsset.status === 200 && rAsset.headers['content-type'].includes('text/javascript'), `assets/${assetReal} ⇒ 200 text/javascript (achei ${rAsset.status})`);
      ok(rAsset.headers['cache-control'] === 'public, max-age=31536000, immutable', `asset com cache-control immutable (achei ${rAsset.headers['cache-control']})`);

      const indexHtml = await pedir('/grafo/app-um/', 'GET');
      ok(indexHtml.headers['cache-control'] === 'no-cache', `index.html continua no-cache (achei ${indexHtml.headers['cache-control']})`);

      const fuga1 = await pedir('/grafo/app-um/assets/../../app.js', 'GET');
      ok(fuga1.status === 403 || fuga1.status === 404, `assets/../../app.js nunca 200 (achei ${fuga1.status})`);
      const fuga2 = await pedir('/grafo/app-um/assets/%2e%2e/%2e%2e/app.js', 'GET');
      ok(fuga2.status === 403 || fuga2.status === 404, `assets/%2e%2e/%2e%2e/app.js nunca 200 (achei ${fuga2.status})`);

      const favicon = await pedir('/grafo/app-um/favicon.ico', 'GET');
      ok(favicon.status === 200 && favicon.headers['content-type'] === 'image/x-icon', `favicon.ico ⇒ image/x-icon (achei ${favicon.status} ${favicon.headers['content-type']})`);
    });

    await bloco('4. dados: token, knowledge-graph/meta/domain/diff/config, 404 sem grafo/projeto', async () => {
      const semToken = await pedir('/grafo/app-um/knowledge-graph.json', 'GET');
      ok(semToken.status === 401, `knowledge-graph.json sem token ⇒ 401 (achei ${semToken.status})`);

      const kg = await pedir('/grafo/app-um/knowledge-graph.json', 'GET', bearer(TOKEN));
      ok(kg.status === 200, `knowledge-graph.json com token ⇒ 200 (achei ${kg.status})`);
      ok(JSON.parse(kg.corpo).project.gitCommitHash === f.shaC1, `project.gitCommitHash === sha da develop (achei ${JSON.parse(kg.corpo).project.gitCommitHash})`);

      const meta = await pedir('/grafo/app-um/meta.json', 'GET', bearer(TOKEN));
      ok(meta.status === 200, `meta.json ⇒ 200 (achei ${meta.status})`);

      const dom = await pedir('/grafo/app-um/domain-graph.json', 'GET', bearer(TOKEN));
      ok(dom.status === 200 && dom.corpo === 'null', `domain-graph.json ⇒ 200 null (achei ${dom.status} ${dom.corpo})`);
      const diff = await pedir('/grafo/app-um/diff-overlay.json', 'GET', bearer(TOKEN));
      ok(diff.status === 200 && diff.corpo === '{}', `diff-overlay.json ⇒ 200 {} (achei ${diff.status} ${diff.corpo})`);
      const cfg = await pedir('/grafo/app-um/config.json', 'GET', bearer(TOKEN));
      ok(cfg.status === 200 && cfg.corpo === '{}', `config.json ⇒ 200 {} (achei ${cfg.status} ${cfg.corpo})`);

      const kgDois = await pedir('/grafo/app-dois/knowledge-graph.json', 'GET', bearer(TOKEN));
      ok(kgDois.status === 404, `knowledge-graph.json de app-dois (sem grafo) ⇒ 404 (achei ${kgDois.status})`);
      const kgNao = await pedir('/grafo/nao-existe/knowledge-graph.json', 'GET', bearer(TOKEN));
      ok(kgNao.status === 404, `knowledge-graph.json de nao-existe ⇒ 404 (achei ${kgNao.status})`);
    });

    await bloco('5. file-content.json: conteúdo da DEVELOP (nunca do checkout), caminho, byte nulo, sha', async () => {
      const semToken = await pedir('/grafo/app-um/file-content.json?path=a.js', 'GET');
      ok(semToken.status === 401, `sem token ⇒ 401 (achei ${semToken.status})`);

      const r = await pedir('/grafo/app-um/file-content.json?path=a.js', 'GET', bearer(TOKEN));
      ok(r.status === 200, `path=a.js ⇒ 200 (achei ${r.status})`);
      const corpo = JSON.parse(r.corpo);
      ok(corpo.content === 'export function f() { return 1; }\n', `conteúdo é o da DEVELOP, não o do checkout sujo na feat (achei ${JSON.stringify(corpo.content)})`);
      ok(corpo.language === 'javascript', `language === javascript (achei ${corpo.language})`);

      const rDotDot = await pedir('/grafo/app-um/file-content.json?path=../x', 'GET', bearer(TOKEN));
      ok(rDotDot.status === 400, `path=../x ⇒ 400 (achei ${rDotDot.status})`);
      const rAbs = await pedir('/grafo/app-um/file-content.json?path=/etc/passwd', 'GET', bearer(TOKEN));
      ok(rAbs.status === 400, `path=/etc/passwd ⇒ 400 (achei ${rAbs.status})`);
      const rForaDoGrafo = await pedir('/grafo/app-um/file-content.json?path=nao-existe.js', 'GET', bearer(TOKEN));
      ok(rForaDoGrafo.status === 404, `caminho que não é nó ⇒ 404 (achei ${rForaDoGrafo.status})`);

      const rBin = await pedir('/grafo/app-um/file-content.json?path=bin.dat', 'GET', bearer(TOKEN));
      ok(rBin.status === 415, `bin.dat (nó injetado com byte nulo) ⇒ 415 (achei ${rBin.status})`);

      // Regenera com um commit novo na develop — o `.anterior` da loja segura o sha antigo.
      const shaAntigo = f.shaC1;
      git(f.appUm, ['checkout', '-q', '-f', 'develop']);
      escreverEComitar(f.appUm, { 'a.js': 'export function f() { return 99; }\n' }, 'c3 (develop)');
      gerarGrafo(f.appUm, f.grafosDir);

      const rNovo = await pedir('/grafo/app-um/file-content.json?path=a.js', 'GET', bearer(TOKEN));
      ok(JSON.parse(rNovo.corpo).content.includes('99'), `sem sha ⇒ conteúdo NOVO (achei ${rNovo.corpo})`);

      const rAntigo = await pedir(`/grafo/app-um/file-content.json?path=a.js&sha=${shaAntigo}`, 'GET', bearer(TOKEN));
      ok(rAntigo.status === 200 && JSON.parse(rAntigo.corpo).content.includes('return 1'), `sha=<anterior> ⇒ 200 com conteúdo ANTIGO (achei ${rAntigo.status} ${rAntigo.corpo})`);

      const rQualquer = await pedir(`/grafo/app-um/file-content.json?path=a.js&sha=${'f'.repeat(40)}`, 'GET', bearer(TOKEN));
      ok(rQualquer.status === 409, `sha=<qualquer> ⇒ 409 (achei ${rQualquer.status})`);
    });

    await bloco('6/8. staleness.json (valida isGraphFreshnessResult) e /api/grafos refletindo atras/fora', async () => {
      const appStale = path.join(f.projetosDir, 'app-staleness');
      fs.mkdirSync(appStale);
      git(appStale, ['init', '-q', '-b', 'develop']);
      escreverEComitar(appStale, { 'base.txt': 'base\n' }, 'c0');
      const c0 = git(appStale, ['rev-parse', 'HEAD']).trim();
      const c1 = escreverEComitar(appStale, { 'a.js': 'export function a() {}\n' }, 'c1 (grafo)');
      gerarGrafo(appStale, f.grafosDir);

      const rFresh = await pedir('/grafo/app-staleness/staleness.json', 'GET', bearer(TOKEN));
      ok(rFresh.status === 200, `grafo em dia ⇒ 200 (achei ${rFresh.status})`);
      const freshBody = JSON.parse(rFresh.corpo).graphs.knowledge;
      ok(isGraphFreshnessResult(freshBody), `passa isGraphFreshnessResult (achei ${JSON.stringify(freshBody)})`);
      ok(freshBody.status === 'fresh', `status fresh (achei ${freshBody.status})`);

      escreverEComitar(appStale, { 'a.js': 'export function a() { return 1; }\n' }, 'c2 (atras, sem regenerar)');
      const rAtras = await pedir('/grafo/app-staleness/staleness.json', 'GET', bearer(TOKEN));
      const atrasBody = JSON.parse(rAtras.corpo).graphs.knowledge;
      ok(isGraphFreshnessResult(atrasBody), `passa isGraphFreshnessResult (achei ${JSON.stringify(atrasBody)})`);
      ok(atrasBody.status === 'stale' && atrasBody.relation === 'behind' && atrasBody.commitsBehind === 1, `stale + behind + commitsBehind=1 (achei ${JSON.stringify(atrasBody)})`);
      ok(atrasBody.changedFileCount === atrasBody.changedFiles.length && atrasBody.changedFileCount > 0, `changedFileCount === changedFiles.length > 0 (achei ${atrasBody.changedFileCount})`);

      const apiAtras = await pedir('/api/grafos', 'GET', bearer(TOKEN));
      const entradaAtras = JSON.parse(apiAtras.corpo).projetos.find((p) => p.nome === 'app-staleness');
      ok(entradaAtras && entradaAtras.grafo && entradaAtras.grafo.estado === 'atras' && entradaAtras.grafo.commitsAtras === 1,
        `caso 8 — /api/grafos: app-staleness atras, commitsAtras=1 (achei ${JSON.stringify(entradaAtras && entradaAtras.grafo)})`);

      // Reset da develop para o PAI do sha do grafo (c0) + commit novo noutro arquivo ⇒ diverge de c1.
      git(appStale, ['update-ref', 'refs/heads/develop', c0]);
      git(appStale, ['checkout', '-q', '-f', 'develop']);
      escreverEComitar(appStale, { 'b.js': 'export function b() {}\n' }, 'c3 (diverge de c1)');
      const rFora = await pedir('/grafo/app-staleness/staleness.json', 'GET', bearer(TOKEN));
      const foraBody = JSON.parse(rFora.corpo).graphs.knowledge;
      ok(isGraphFreshnessResult(foraBody), `passa isGraphFreshnessResult (achei ${JSON.stringify(foraBody)})`);
      ok(foraBody.status === 'stale' && foraBody.relation === 'diverged', `stale + diverged (achei ${JSON.stringify(foraBody)})`);

      const apiFora = await pedir('/api/grafos', 'GET', bearer(TOKEN));
      const entradaFora = JSON.parse(apiFora.corpo).projetos.find((p) => p.nome === 'app-staleness');
      ok(entradaFora && entradaFora.grafo && entradaFora.grafo.estado === 'fora', `caso 8 — /api/grafos: app-staleness fora (achei ${JSON.stringify(entradaFora && entradaFora.grafo)})`);

      // Reset da develop para o PRÓPRIO sha do grafo (c1) + commit vazio ⇒ mesma árvore ⇒ fresh.
      git(appStale, ['update-ref', 'refs/heads/develop', c1]);
      git(appStale, ['checkout', '-q', '-f', 'develop']);
      git(appStale, ['commit', '-q', '--allow-empty', '-m', 'c1b (vazio)']);
      const rFreshVazio = await pedir('/grafo/app-staleness/staleness.json', 'GET', bearer(TOKEN));
      const freshVazioBody = JSON.parse(rFreshVazio.corpo).graphs.knowledge;
      ok(isGraphFreshnessResult(freshVazioBody), `passa isGraphFreshnessResult (achei ${JSON.stringify(freshVazioBody)})`);
      ok(freshVazioBody.status === 'fresh' && freshVazioBody.commitsBehind === 0 && freshVazioBody.commitsAhead === 0,
        `commit vazio depois do sha do grafo ⇒ fresh, mesma árvore (achei ${JSON.stringify(freshVazioBody)})`);

      // sha do grafo que não existe mais (edita a loja na mão) ⇒ unknown.
      const grafoStaleArq = path.join(f.grafosDir, 'app-staleness', 'knowledge-graph.json');
      const grafoStale = JSON.parse(fs.readFileSync(grafoStaleArq, 'utf8'));
      grafoStale.project.gitCommitHash = 'f'.repeat(40);
      fs.writeFileSync(grafoStaleArq, JSON.stringify(grafoStale));
      const rDesconhecido = await pedir('/grafo/app-staleness/staleness.json', 'GET', bearer(TOKEN));
      const descBody = JSON.parse(rDesconhecido.corpo).graphs.knowledge;
      ok(isGraphFreshnessResult(descBody), `passa isGraphFreshnessResult (achei ${JSON.stringify(descBody)})`);
      ok(descBody.status === 'unknown' && descBody.reason === 'graph-commit-unavailable', `unknown + graph-commit-unavailable (achei ${JSON.stringify(descBody)})`);
    });
  });

  // ─── 7. servidor SEM COCKPIT_TOKEN ────────────────────────────────────────
  await withServer({ projetosDir: f.projetosDir, grafosDir: f.grafosDir, token: null }, async () => {
    await bloco('7. servidor sem COCKPIT_TOKEN: ?token=- é aceito', async () => {
      const r = await pedir('/grafo/app-um/knowledge-graph.json?token=-', 'GET');
      ok(r.status === 200, `knowledge-graph.json?token=- ⇒ 200 sem COCKPIT_TOKEN (achei ${r.status})`);
    });
  });

  console.log(`\n${passou}/${total} asserções`);
  console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — rotas /api/grafos e /grafo/<projeto>/');
  process.exitCode = vermelho ? 1 : 0;
}

principal();
