#!/usr/bin/env node
'use strict';
// PROVA NO NAVEGADOR REAL — "tudo dentro do app" (card `ver-a-diff-do-codigo`/D96): diff e mapa
// abrem NA MESMA ABA (porta única `public/dentro-do-app.js`), a lateral tem o título numa linha
// e os ícones embaixo, e a volta — RECARREGADA (sem bfcache) ou pelo bfcache — devolve o painel, o
// Pra revisar ou o diálogo de grafos de onde se saiu. Molde `testes/print-diff.js` (fail-closed,
// `confereLivre`, `esperarAssentar`, `novaPagina`, `tirarPrint` com luminância, `subirServidor`
// FILHO, `derrubar` pelo pid exato, `resultado.json`, recusa sobrescrever PNG) + a fixture da loja
// de grafo de `testes/print-grafo-mapa.js` (cópia dos 2 arquivos — a origem só é LIDA) + o mundo de
// finanças de `testes/fixtures-financas.js` (`plantarMundo`).
//
// #106: nenhum caminho de HOME real mora aqui — tudo por env. `PUPPETEER_CORE`/`CHROME_BIN` vêm do
// memory `print-roda-no-chrome-do-host` (a imagem docker do print sumiu em 16/10).
//
// Uso:
//   SAIDA=<pasta nova> PUPPETEER_CORE=<pasta> CHROME_BIN=<executável> REPO_REAL=<repo> \
//   JOBS_REAIS=<pasta de jobs> JOB_OK=<id de um job com mudanças fora da develop> \
//   LOJA_ORIGEM=<pasta com knowledge-graph.json e meta.json> \
//   [CODIGO_DIR=<raiz de um server.js ANTIGO, pro "antes" da lateral>] \
//   [CENAS=L,N1,N1b,N2,N3,N4,N4b,N5 (padrão: todas)] \
//     node testes/print-tudo-dentro-do-app.js
//
// Saída: 0 = PNGs e resultado.json gravados · 1 = cena reprovada (resultado.json sai mesmo
// assim) · 2 = ambiente (env obrigatória faltando).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');
const fxFin = require('./fixtures-financas');

const SAIDA = process.env.SAIDA || '';
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const REPO_REAL = process.env.REPO_REAL || '';
const JOBS_REAIS = process.env.JOBS_REAIS || '';
const JOB_OK = process.env.JOB_OK || '';
const LOJA_ORIGEM = process.env.LOJA_ORIGEM || '';
const CODIGO_DIR_ANTES = process.env.CODIGO_DIR || '';
const CODIGO_DIR = path.join(__dirname, '..');
const CENAS = new Set((process.env.CENAS || 'L,N1,N1b,N2,N3,N4,N4b,N5').split(',').map((s) => s.trim()).filter(Boolean));
const PORTA = 7953;
const TOKEN = 'print-dentro';
const NOME_PROJETO = 'cockpit-agentes';
const VIEWPORT_CELULAR = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const VIEWPORT_DESKTOP = { width: 1600, height: 1000, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const TETO_MS = 20000;

// ─── fail-closed antes de tocar em qualquer coisa ───────────────────────────────────────────────

function ambienteFaltando(msg) { console.error(`🟡 ambiente indisponível: ${msg}`); process.exit(2); }
if (!SAIDA) ambienteFaltando('SAIDA é obrigatória (pasta nova dos PNGs).');
if (!PUPPETEER || !CHROME) ambienteFaltando('PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
let puppeteer;
try { puppeteer = require(PUPPETEER); } catch (e) { ambienteFaltando(`não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`); }
if (!fs.existsSync(CHROME)) ambienteFaltando('CHROME_BIN não existe.');
if (!REPO_REAL || !fs.existsSync(path.join(REPO_REAL, '.git'))) ambienteFaltando('REPO_REAL tem de ser um repo git de verdade.');
if (!JOBS_REAIS || !fs.existsSync(JOBS_REAIS)) ambienteFaltando('JOBS_REAIS tem de existir.');
if (!JOB_OK || !fs.existsSync(path.join(JOBS_REAIS, JOB_OK, 'meta.json'))) ambienteFaltando('JOB_OK tem de ter meta.json em JOBS_REAIS.');
if (!LOJA_ORIGEM || !fs.existsSync(path.join(LOJA_ORIGEM, 'knowledge-graph.json')) || !fs.existsSync(path.join(LOJA_ORIGEM, 'meta.json'))) {
  ambienteFaltando('LOJA_ORIGEM tem de ter knowledge-graph.json e meta.json.');
}
const SERVER_JS = path.join(CODIGO_DIR, 'server.js');
if (!fs.existsSync(SERVER_JS)) ambienteFaltando(`CODIGO_DIR (este repo) não tem o servidor (${SERVER_JS}).`);
if (CODIGO_DIR_ANTES && !fs.existsSync(path.join(CODIGO_DIR_ANTES, 'server.js'))) ambienteFaltando(`CODIGO_DIR (${CODIGO_DIR_ANTES}, árvore "antes") não tem o servidor.`);

function confereLivre() {
  let saida = '';
  try { saida = execSync('ss -H -lptn', { encoding: 'utf8' }); } catch { return; }
  if (new RegExp(`:${PORTA}\\b`).test(saida)) {
    console.error(`🔴 porta ${PORTA} ocupada — não posso rodar\n${saida}`);
    process.exit(1);
  }
}
confereLivre();

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function pedirHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Zero animação em CURSO antes do obturador (molde `print-diff.js`/`print-grafo-mapa.js`). */
async function esperarAssentar(pagina) {
  await pagina.waitForFunction(() => document.getAnimations().filter((a) => a.playState === 'running').length === 0, { timeout: 5000 }).catch(() => {});
  await espera(150);
}

async function novaPagina(navegador, viewport) {
  const contexto = await navegador.createBrowserContext();
  const pagina = await contexto.newPage();
  pagina.__viewportAtual = viewport || VIEWPORT_CELULAR;
  await pagina.setViewport(pagina.__viewportAtual);
  await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await pagina.evaluateOnNewDocument((token) => {
    try {
      localStorage.setItem('cockpit-idioma', 'pt-BR');
      localStorage.setItem('cockpit-token', token);
    } catch { /* vale nesta página */ }
  }, TOKEN);
  return { contexto, pagina };
}

/** M7/M8/M9/M11 só se provam distinguindo recarga (persisted=false) de bfcache (persisted=true). */
async function registrarPageshow(pagina) {
  await pagina.evaluateOnNewDocument(() => window.addEventListener('pageshow', (e) => { window.__persisted = e.persisted; }));
}

/** nº de abas abertas AGORA — prova que nenhum clique abriu uma segunda (M2/M3). */
async function contarAlvos(navegador) {
  return (await navegador.targets()).filter((t) => t.type() === 'page').length;
}

/**
 * Medido (reprodução isolada): o Chrome às vezes PERDE o `Emulation.setDeviceMetricsOverride` —
 * `window.innerWidth` cai pro tamanho real da janela headless (~800 px) mesmo sem nenhuma
 * travessia de documento (aconteceu logo após o 1º `goto`, só com cliques de SPA no meio). O
 * `.painel` segue com 390 px de largura (a CSS está certa), mas o layout pensa que tem 780+ px
 * de sobra e NÃO empurra a lateral pra fora, deixando elementos como o `.btn-mudancas` fora da
 * área clicável — "Node is either not clickable". `setViewport` de novo resolve (medido: 1
 * repetição bastou nas 2 vezes que reproduziu); por segurança, repete até 5x com uma folga curta.
 */
async function reafirmarViewport(pagina) {
  if (!pagina.__viewportAtual) return;
  for (let i = 0; i < 5; i += 1) {
    const largura = await pagina.evaluate(() => window.innerWidth).catch(() => null);
    if (largura === pagina.__viewportAtual.width) return;
    await pagina.setViewport(pagina.__viewportAtual).catch(() => {});
    await espera(150);
  }
}

/** `pagina.goto` + reafirma o viewport (a perda vale também pra carga inicial, não só travessia). */
async function irPara(pagina, url) {
  await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await reafirmarViewport(pagina);
}

/** Todo clique passa por aqui: reafirma o viewport ANTES (a folga do helper acima só corrige
 * DEPOIS de navegar — um clique comum de SPA também pode achar o viewport errado). `alvo` é um
 * seletor (string) ou um ElementHandle já resolvido (ex.: `cartao`, `elDiff`). */
async function clicar(pagina, alvo) {
  await reafirmarViewport(pagina);
  if (typeof alvo === 'string') await pagina.click(alvo);
  else await alvo.click();
}

/**
 * Clique que atravessa documento (molde M2: `cockpitDentro.abrir`/`history.go` cruzando a pilha).
 * `cockpitDentro.abrir` faz `history.replaceState(...)` (a `volta`) ANTES do `location.assign(url)` — o
 * `replaceState` já é uma navegação NO MESMO documento, e medido (repro isolada): `waitForNavigation`
 * pode resolver NELA, não na travessia real, deixando `pagina.url()` momentaneamente na página de
 * origem. O mesmo `espera(800)` de `voltarNavegando` absorve essa folga antes de qualquer leitura de URL.
 */
async function clicarNavegando(pagina, alvo) {
  await reafirmarViewport(pagina);
  const fazerClique = typeof alvo === 'string' ? () => pagina.click(alvo) : () => alvo.click();
  await Promise.all([pagina.waitForNavigation({ waitUntil: 'domcontentloaded' }), fazerClique()]);
  await espera(800);
  await reafirmarViewport(pagina);
}

/** Voltar que pode ou não atravessar documento — o navegador decide (bfcache ou recarga). */
async function voltarNavegando(pagina) {
  await Promise.all([pagina.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), pagina.goBack()]);
  await espera(800);
  await reafirmarViewport(pagina);
}

function luminanciaDoFundo(pagina) {
  return pagina.evaluate(() => {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g) || ['255', '255', '255'];
    const [r, g, b] = m.slice(0, 3).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });
}

async function tirarPrint(pagina, nome, gerados, problemas, { exigirEscuro = true } = {}) {
  await esperarAssentar(pagina);
  if (exigirEscuro) {
    const lum = await luminanciaDoFundo(pagina);
    if (lum > 0.2) { problemas.push(`${nome}: fundo claro demais (luminância ${lum.toFixed(2)})`); return false; }
  }
  const arq = path.join(SAIDA, nome);
  await pagina.screenshot({ path: arq });
  gerados.push(arq);
  return true;
}

// ─── cena L — lateral em duas linhas (M1) ────────────────────────────────────────────────────────

async function cenaLateral(navegador, base, viewport, rotuloViewport, sufixoServidor, resultado, gerados) {
  const { contexto, pagina } = await novaPagina(navegador, viewport);
  const prefixo = `L-${sufixoServidor}-${rotuloViewport}`;
  try {
    await irPara(pagina, `${base}/?token=${TOKEN}`);
    try { await pagina.waitForSelector('#btn-financas:not([hidden])', { timeout: TETO_MS }); }
    catch { resultado.problemas.push(`${prefixo}: #btn-financas não ficou visível (finanças não ligou)`); return; }
    const medidas = await pagina.evaluate(() => {
      const topoEl = document.querySelector('.lateral-topo');
      const lateralEl = document.querySelector('.lateral');
      const marca = document.querySelector('.marca');
      const small = marca ? marca.querySelector('small') : null;
      const lateralRect = lateralEl.getBoundingClientRect();
      const grupo = document.querySelector('.lateral-acoes-grupo');
      const icones = [...grupo.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      const dentroDaLateral = icones.every((b) => {
        const r = b.getBoundingClientRect();
        return r.left >= lateralRect.left - 0.5 && r.right <= lateralRect.right + 0.5;
      });
      const marcaRect = marca.getBoundingClientRect();
      const primeiroIconeRect = icones.length ? icones[0].getBoundingClientRect() : null;
      return {
        topo: topoEl.getBoundingClientRect().height,
        marcaCortada: marca.scrollWidth > marca.clientWidth,
        subCortado: small ? small.scrollWidth > small.clientWidth : false,
        icones: icones.length,
        dentroDaLateral,
        marcaAcima: primeiroIconeRect ? marcaRect.bottom <= primeiroIconeRect.top + 0.5 : false,
      };
    });
    resultado.lateral[`${sufixoServidor}-${rotuloViewport}`] = medidas;
    if (sufixoServidor === 'depois') {
      if (medidas.marcaCortada) resultado.problemas.push(`${prefixo}: a marca "Cockpit" está cortada`);
      if (medidas.subCortado) resultado.problemas.push(`${prefixo}: o subtítulo está cortado`);
      if (medidas.icones !== 6) resultado.problemas.push(`${prefixo}: ${medidas.icones} ícones visíveis no grupo Navegação (esperado 6)`);
      if (!medidas.dentroDaLateral) resultado.problemas.push(`${prefixo}: algum ícone sai da faixa da lateral`);
      if (!medidas.marcaAcima) resultado.problemas.push(`${prefixo}: a marca não está inteiramente ACIMA da linha de ícones`);
    }
    await tirarPrint(pagina, `${prefixo}.png`, gerados, resultado.problemas);
  } finally { await contexto.close().catch(() => {}); }
}

// ─── cena N1 — Commits → diff na mesma janela → voltar (celular, navegador padrão) ───────────────

async function cenaN1(navegador, base, resultado, gerados) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  try {
    await irPara(pagina, `${base}/?token=${TOKEN}`);
    try { await pagina.waitForSelector('#btn-commits', { timeout: TETO_MS }); } catch { resultado.problemas.push('N1: #btn-commits não apareceu'); return; }
    const n0 = await pagina.evaluate(() => history.length);
    const a0 = await contarAlvos(navegador);
    await clicarNavegando(pagina, '#btn-commits');

    const url1 = new URL(pagina.url());
    if (!url1.pathname.endsWith('/diff/')) resultado.problemas.push(`N1: pathname não termina em /diff/ (achei ${url1.pathname})`);
    if (url1.searchParams.has('token')) resultado.problemas.push('N1: a URL da diff tem ?token (não devia)');
    const a1 = await contarAlvos(navegador);
    if (a1 !== a0) resultado.problemas.push(`N1: contarAlvos mudou (${a0} → ${a1}) — abriu aba nova`);
    const n1 = await pagina.evaluate(() => history.length);
    if (n1 !== n0 + 1) resultado.problemas.push(`N1: history.length não é n0+1 ao chegar na diff (${n0} → ${n1})`);

    // D97: "Commits" abre "Em aberto" agora — escolher o projeto no seletor antes de esperar a lista de commits.
    try { await pagina.waitForSelector(`#diff-seletor-projeto option[value="${NOME_PROJETO}"]`, { timeout: TETO_MS }); } catch { resultado.problemas.push('N1: opção do projeto não apareceu no seletor'); return; }
    await pagina.select('#diff-seletor-projeto', NOME_PROJETO);
    try { await pagina.waitForSelector('.diff-commit-item', { timeout: TETO_MS }); } catch { resultado.problemas.push('N1: .diff-commit-item não apareceu'); return; }
    await tirarPrint(pagina, 'N1-celular-diff-na-mesma-janela.png', gerados, resultado.problemas);

    await clicar(pagina, '.diff-commit-item');
    try { await pagina.waitForSelector('.diff-cabecalho .diff-sha-visivel', { timeout: TETO_MS }); } catch { resultado.problemas.push('N1: .diff-cabecalho não apareceu no commit'); return; }
    const n2 = await pagina.evaluate(() => history.length);
    if (n2 !== n0 + 2) resultado.problemas.push(`N1: history.length não é n0+2 ao abrir o commit (achei ${n2})`);

    await clicarNavegando(pagina, '.diff-sair');
    const urlFinal = new URL(pagina.url());
    if (!urlFinal.pathname.endsWith('/')) resultado.problemas.push(`N1: "Cockpit" (.diff-sair) não voltou pra / (achei ${urlFinal.pathname})`);
    try { await pagina.waitForSelector('#btn-commits', { timeout: TETO_MS }); } catch { resultado.problemas.push('N1: #btn-commits não voltou à tela'); }
    const n3 = await pagina.evaluate(() => history.length);
    if (n3 !== n0 + 2) resultado.problemas.push(`N1: history.length mudou na volta (esperado ${n0 + 2}, achei ${n3}) — empilhou uma cópia`);
  } finally { await contexto.close().catch(() => {}); }
}

// ─── cena N1b — voltar do Android (dois "voltar" seguidos) ───────────────────────────────────────

async function cenaN1b(navegador, base, resultado) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  try {
    await irPara(pagina, `${base}/?token=${TOKEN}`);
    try { await pagina.waitForSelector('#btn-commits', { timeout: TETO_MS }); } catch { resultado.problemas.push('N1b: #btn-commits não apareceu'); return; }
    await clicarNavegando(pagina, '#btn-commits');
    // D97: "Commits" abre "Em aberto" agora — escolher o projeto no seletor antes de esperar a lista de commits.
    try { await pagina.waitForSelector(`#diff-seletor-projeto option[value="${NOME_PROJETO}"]`, { timeout: TETO_MS }); } catch { resultado.problemas.push('N1b: opção do projeto não apareceu no seletor'); return; }
    await pagina.select('#diff-seletor-projeto', NOME_PROJETO);
    try { await pagina.waitForSelector('.diff-commit-item', { timeout: TETO_MS }); } catch { resultado.problemas.push('N1b: .diff-commit-item não apareceu'); return; }
    await clicar(pagina, '.diff-commit-item');
    try { await pagina.waitForSelector('.diff-cabecalho .diff-sha-visivel', { timeout: TETO_MS }); } catch { resultado.problemas.push('N1b: .diff-cabecalho não apareceu'); return; }

    await voltarNavegando(pagina); // 1º "‹" do Android: popstate dentro do /diff/ — volta pra lista
    try { await pagina.waitForSelector('.diff-commit-item', { timeout: TETO_MS }); } catch { resultado.problemas.push('N1b: o 1º goBack não voltou à lista'); return; }
    if (!new URL(pagina.url()).pathname.endsWith('/diff/')) resultado.problemas.push(`N1b: depois do 1º goBack a URL não é /diff/ (achei ${pagina.url()})`);

    await voltarNavegando(pagina); // 2º "‹": atravessa pro documento do cockpit
    const pathFinal = new URL(pagina.url()).pathname;
    if (!pathFinal.endsWith('/')) resultado.problemas.push(`N1b: depois do 2º goBack a URL não termina em / (achei ${pathFinal})`);
    try { await pagina.waitForSelector('#btn-commits', { timeout: TETO_MS }); } catch { resultado.problemas.push('N1b: #btn-commits não voltou depois dos dois goBack'); }
  } finally { await contexto.close().catch(() => {}); }
}

// ─── cena N2 — Pra revisar → Ver mudanças → voltar (M8), nos DOIS navegadores ────────────────────

async function cenaN2(navegador, rotulo, base, resultado, gerados) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  const sufixo = rotulo === 'com-bfcache' ? 'com' : 'sem';
  try {
    await registrarPageshow(pagina);
    await irPara(pagina, `${base}/?token=${TOKEN}`);
    try { await pagina.waitForSelector('#btn-revisar', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N2-${rotulo}: #btn-revisar não apareceu`); return; }
    await clicar(pagina, '#btn-revisar');
    let cartao;
    try { cartao = await pagina.waitForSelector(`.rv-card[data-id="${JOB_OK}"]`, { timeout: TETO_MS }); }
    catch { resultado.problemas.push(`N2-${rotulo}: o job ${JOB_OK} não apareceu em "Pra revisar"`); return; }
    await clicar(pagina, cartao);
    try { await pagina.waitForSelector('.rv-rodape', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N2-${rotulo}: .rv-rodape não apareceu`); return; }
    const btnDiff = await pagina.evaluateHandle(() => [...document.querySelectorAll('.rv-rodape button')].find((b) => b.textContent.includes('Ver mudanças')));
    const elDiff = btnDiff.asElement();
    if (!elDiff) { resultado.problemas.push(`N2-${rotulo}: nenhum botão "Ver mudanças" no rodapé`); return; }

    const a0 = await contarAlvos(navegador);
    await clicarNavegando(pagina, elDiff);
    if (!pagina.url().includes(`#job=${JOB_OK}`)) resultado.problemas.push(`N2-${rotulo}: a URL não tem #job=${JOB_OK} (achei ${pagina.url()})`);
    const a1 = await contarAlvos(navegador);
    if (a1 !== a0) resultado.problemas.push(`N2-${rotulo}: contarAlvos mudou (abriu aba nova)`);
    try { await pagina.waitForSelector('.diff-arquivo', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N2-${rotulo}: .diff-arquivo não apareceu na diff do job`); return; }

    await voltarNavegando(pagina);
    try { await pagina.waitForSelector('#dialogo-revisar[open]', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N2-${rotulo}: #dialogo-revisar não reabriu na volta`); return; }
    try { await pagina.waitForSelector('.rv-rodape', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N2-${rotulo}: a tela do job (.rv-rodape) não voltou`); return; }
    const persisted = await pagina.evaluate(() => window.__persisted);
    if (rotulo === 'sem-bfcache' && persisted !== false) resultado.problemas.push(`N2-${rotulo}: window.__persisted deveria ser false (achei ${persisted}) — a cena não provou M8`);
    if (rotulo === 'com-bfcache' && persisted !== true) resultado.problemas.push(`N2-${rotulo}: window.__persisted deveria ser true (achei ${persisted}) — a cena não provou o bfcache`);
    await tirarPrint(pagina, `N2-celular-volta-revisar-${sufixo}-bfcache.png`, gerados, resultado.problemas);
  } finally { await contexto.close().catch(() => {}); }
}

// ─── cena N3 — painel do job → Ver mudanças → voltar (M7/M11), nos DOIS navegadores ──────────────

async function cenaN3(navegador, rotulo, base, resultado, gerados) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  const sufixo = rotulo === 'com-bfcache' ? 'com' : 'sem';
  try {
    await registrarPageshow(pagina);
    let pedidosEventos = 0;
    pagina.on('request', (req) => { if (req.url().includes('api/eventos')) pedidosEventos += 1; });
    await irPara(pagina, `${base}/?token=${TOKEN}`);
    try { await pagina.waitForSelector('#btn-revisar', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N3-${rotulo}: #btn-revisar não apareceu`); return; }
    await clicar(pagina, '#btn-revisar');
    let cartao;
    try { cartao = await pagina.waitForSelector(`.rv-card[data-id="${JOB_OK}"]`, { timeout: TETO_MS }); }
    catch { resultado.problemas.push(`N3-${rotulo}: o job ${JOB_OK} não apareceu em "Pra revisar"`); return; }
    await clicar(pagina, cartao);
    try { await pagina.waitForSelector('.rv-rodape .btn-principal', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N3-${rotulo}: "Abrir conversa do job" não apareceu`); return; }
    await clicar(pagina, '.rv-rodape .btn-principal');
    try { await pagina.waitForSelector('.painel[data-tipo="job"]', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N3-${rotulo}: o painel do job não abriu`); return; }
    try { await pagina.waitForSelector('.painel[data-tipo="job"] .btn-mudancas', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N3-${rotulo}: .btn-mudancas não apareceu no painel`); return; }

    await clicarNavegando(pagina, '.painel[data-tipo="job"] .btn-mudancas');
    // A diff pode cair em qualquer estado do job (ok/sem-mudancas/branch-sumiu) — o que esta cena
    // prova é a VOLTA (M7/M11), não o conteúdo da diff (já coberto por N2 e pelo print-diff.js).
    await espera(500);

    const pedidosAntesDoVoltar = pedidosEventos;
    await voltarNavegando(pagina);
    try { await pagina.waitForSelector('.painel[data-tipo="job"]', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N3-${rotulo}: o painel do job não reabriu na volta`); return; }
    try { await pagina.waitForSelector('#app[data-vista="chat"]', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N3-${rotulo}: #app não ficou com data-vista="chat"`); }
    const persisted = await pagina.evaluate(() => window.__persisted);
    if (rotulo === 'sem-bfcache' && persisted !== false) resultado.problemas.push(`N3-${rotulo}: window.__persisted deveria ser false (achei ${persisted})`);
    if (rotulo === 'com-bfcache' && persisted !== true) resultado.problemas.push(`N3-${rotulo}: window.__persisted deveria ser true (achei ${persisted})`);
    if (rotulo === 'com-bfcache' && pedidosEventos <= pedidosAntesDoVoltar) {
      resultado.problemas.push(`N3-${rotulo}: nenhum pedido NOVO a api/eventos depois do voltar pelo bfcache (religarFluxo, M11)`);
    }
    await tirarPrint(pagina, `N3-celular-volta-painel-${sufixo}-bfcache.png`, gerados, resultado.problemas);

    await pagina.evaluate(() => history.back());
    try { await pagina.waitForSelector('#app[data-vista="lista"]', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N3-${rotulo}: o 2º voltar não devolveu a vista "lista"`); }
    try { await pagina.waitForSelector('#btn-commits', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N3-${rotulo}: o 2º voltar saiu do cockpit`); }
  } finally { await contexto.close().catch(() => {}); }
}

// ─── cena N4 — Grafos → Grafo → mapa dentro do app → "‹" (M9), nos DOIS navegadores ──────────────

async function cenaN4(navegador, rotulo, base, resultado, gerados) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  const sufixo = rotulo === 'com-bfcache' ? 'com' : 'sem';
  try {
    await registrarPageshow(pagina);
    await irPara(pagina, `${base}/?token=${TOKEN}`);
    try { await pagina.waitForSelector('#btn-grafos', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N4-${rotulo}: #btn-grafos não apareceu`); return; }
    await clicar(pagina, '#btn-grafos');
    try { await pagina.waitForSelector('.grafos-abrir[data-acao="abrir"]', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N4-${rotulo}: .grafos-abrir[data-acao="abrir"] não apareceu`); return; }

    const a0 = await contarAlvos(navegador);
    await clicarNavegando(pagina, '.grafos-abrir[data-acao="abrir"]');
    const url1 = new URL(pagina.url());
    if (!url1.pathname.endsWith(`/mapa/${NOME_PROJETO}/`)) resultado.problemas.push(`N4-${rotulo}: pathname não termina em /mapa/${NOME_PROJETO}/ (achei ${url1.pathname})`);
    if (url1.searchParams.has('token')) resultado.problemas.push(`N4-${rotulo}: a URL do mapa tem ?token (não devia)`);
    const a1 = await contarAlvos(navegador);
    if (a1 !== a0) resultado.problemas.push(`N4-${rotulo}: contarAlvos mudou (abriu aba nova)`);

    try { await pagina.waitForSelector('#mapa-foco .mapa-centro', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N4-${rotulo}: o nível 1 do mapa não apareceu`); return; }
    const voltaVisivel = await pagina.evaluate(() => { const b = document.getElementById('mapa-voltar'); return !!b && !b.hidden; });
    if (!voltaVisivel) resultado.problemas.push(`N4-${rotulo}: #mapa-voltar não está visível (deveria, veio do cockpit)`);
    await tirarPrint(pagina, `N4-celular-mapa-dentro-do-app-${sufixo}-bfcache.png`, gerados, resultado.problemas);

    await clicarNavegando(pagina, '#mapa-voltar');
    try { await pagina.waitForSelector('#dialogo-grafos[open]', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N4-${rotulo}: #dialogo-grafos não reabriu na volta`); return; }
    try { await pagina.waitForSelector('#btn-commits', { timeout: TETO_MS }); } catch { resultado.problemas.push(`N4-${rotulo}: #btn-commits não apareceu na volta`); }
    // Painel de execução (Codex #1): sem isto a rodada "com-bfcache" podia passar por recarga normal (M9) e
    // a "sem-bfcache" por restauração inteira — cada uma tem de provar o caminho que diz provar (molde N2/N3).
    const persisted = await pagina.evaluate(() => window.__persisted);
    if (rotulo === 'sem-bfcache' && persisted !== false) resultado.problemas.push(`N4-${rotulo}: window.__persisted deveria ser false (achei ${persisted}) — a cena não provou o M9`);
    if (rotulo === 'com-bfcache' && persisted !== true) resultado.problemas.push(`N4-${rotulo}: window.__persisted deveria ser true (achei ${persisted}) — a cena não provou o bfcache`);
    await tirarPrint(pagina, `N4-celular-volta-grafos-${sufixo}-bfcache.png`, gerados, resultado.problemas);
  } finally { await contexto.close().catch(() => {}); }
}

// ─── cena N4b — voltar do Android a partir do mapa (navegador padrão) ────────────────────────────

async function cenaN4b(navegador, base, resultado) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  try {
    await irPara(pagina, `${base}/?token=${TOKEN}`);
    try { await pagina.waitForSelector('#btn-grafos', { timeout: TETO_MS }); } catch { resultado.problemas.push('N4b: #btn-grafos não apareceu'); return; }
    await clicar(pagina, '#btn-grafos');
    try { await pagina.waitForSelector('.grafos-abrir[data-acao="abrir"]', { timeout: TETO_MS }); } catch { resultado.problemas.push('N4b: .grafos-abrir[data-acao="abrir"] não apareceu'); return; }
    await clicarNavegando(pagina, '.grafos-abrir[data-acao="abrir"]');
    try { await pagina.waitForSelector('#mapa-foco .mapa-centro', { timeout: TETO_MS }); } catch { resultado.problemas.push('N4b: o mapa não abriu'); return; }

    await voltarNavegando(pagina);
    try { await pagina.waitForSelector('#dialogo-grafos[open]', { timeout: TETO_MS }); } catch { resultado.problemas.push('N4b: #dialogo-grafos não reabriu no goBack do Android'); }
  } finally { await contexto.close().catch(() => {}); }
}

// ─── cena N5 — link direto no mapa (controle do M6: sem veio-do-cockpit, "‹" some) ───────────────

async function cenaN5(navegador, base, resultado) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  try {
    await irPara(pagina, `${base}/mapa/${encodeURIComponent(NOME_PROJETO)}/?token=${TOKEN}`);
    try { await pagina.waitForSelector('#mapa-foco .mapa-centro', { timeout: TETO_MS }); } catch { resultado.problemas.push('N5: o nível 1 do mapa não apareceu'); return; }
    const escondido = await pagina.evaluate(() => { const b = document.getElementById('mapa-voltar'); return !!b && b.hidden; });
    if (!escondido) resultado.problemas.push('N5: #mapa-voltar deveria estar ESCONDIDO em link direto (sem marca de veio-do-cockpit) — comportamento de antes, M6');
  } finally { await contexto.close().catch(() => {}); }
}

// ─── servidor FILHO (molde `print-diff.js`/`print-grafo-mapa.js`) ───────────────────────────────

async function subirServidor(codigoDir, { projetosDir, jobsDir, grafosDir, financasDir }, scratch, sufixo) {
  const home = path.join(scratch, `home-${sufixo}`);
  fs.mkdirSync(home, { recursive: true });
  const ambiente = {
    PATH: process.env.PATH,
    HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
    COCKPIT_CERT_DIR: '/dev/null',
    COCKPIT_TOKEN: TOKEN,
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_JOBS_DIR: jobsDir,
    COCKPIT_GRAFOS_DIR: grafosDir,
    COCKPIT_FINANCAS_DIR: financasDir,
    COCKPIT_MONITOR_DIR: path.join(scratch, `monitor-${sufixo}`), COCKPIT_MONITOR_MS: '0',
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(scratch, `push-${sufixo}`),
    COCKPIT_LIDAS_DIR: path.join(scratch, `lidas-${sufixo}`),
    COCKPIT_LEITURAS_DIR: path.join(scratch, `leituras-${sufixo}`),
    COCKPIT_TMUX_SOCKET: `print-dentro-${process.pid}-${sufixo}`,
    COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
    COCKPIT_GH_BIN: path.join(scratch, 'sem-gh'),
  };
  const servidor = spawn(process.execPath, [path.join(codigoDir, 'server.js')], { cwd: codigoDir, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
  let saidaErro = '';
  servidor.stderr.on('data', (d) => { saidaErro += d; });
  let pronto = false;
  for (let i = 0; i < 100 && !pronto; i += 1) {
    if (servidor.exitCode !== null) break;
    pronto = await pedirHealth();
    if (!pronto) await espera(100);
  }
  if (!pronto) throw new Error(`o servidor (${codigoDir}) não subiu na porta ${PORTA} — ${saidaErro}`);
  return servidor;
}

function derrubar(servidor) {
  if (servidor && servidor.exitCode === null) {
    try { process.kill(servidor.pid); } catch { /* já morreu */ }
  }
}

// ─── corrida ─────────────────────────────────────────────────────────────────────────────────────

(async () => {
  const resultado = { pngs: [], problemas: [], lateral: {}, cenas: [...CENAS] };
  const gerados = [];
  let rc = 1;
  let scratch = null;

  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-dentro-'));
    const projetosDir = path.join(scratch, 'projetos');
    const repoFixture = path.join(projetosDir, NOME_PROJETO);
    fs.mkdirSync(repoFixture, { recursive: true });
    execFileSync('git', ['-C', repoFixture, 'init', '-q']);
    fs.mkdirSync(path.join(repoFixture, '.git', 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repoFixture, '.git', 'objects', 'info', 'alternates'), `${path.join(REPO_REAL, '.git', 'objects')}\n`);
    execFileSync('git', ['-C', repoFixture, 'fetch', '-q', '--no-tags', REPO_REAL, 'refs/heads/*:refs/heads/*']);

    const jobsDir = path.join(scratch, 'jobs');
    const destinoJob = path.join(jobsDir, JOB_OK);
    fs.mkdirSync(destinoJob, { recursive: true });
    const meta = JSON.parse(fs.readFileSync(path.join(JOBS_REAIS, JOB_OK, 'meta.json'), 'utf8'));
    meta.source_repo = repoFixture;
    fs.writeFileSync(path.join(destinoJob, 'meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(destinoJob, 'status.log'), `${new Date().toISOString()} done: print\n`);

    const grafosDir = path.join(scratch, 'grafos');
    fs.mkdirSync(path.join(grafosDir, NOME_PROJETO), { recursive: true });
    for (const nome of ['knowledge-graph.json', 'meta.json']) fs.copyFileSync(path.join(LOJA_ORIGEM, nome), path.join(grafosDir, NOME_PROJETO, nome));

    const financasDir = path.join(scratch, 'financas');
    fxFin.plantarMundo(financasDir);

    const dirsFixture = { projetosDir, jobsDir, grafosDir, financasDir };

    const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const precisaSemBfcache = CENAS.has('N2') || CENAS.has('N3') || CENAS.has('N4');
    const navegadorSemBfcache = precisaSemBfcache
      ? await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=BackForwardCache'] })
      : null;
    try {
      const servidorDepois = await subirServidor(CODIGO_DIR, dirsFixture, scratch, 'depois');
      try {
        const base = `http://127.0.0.1:${PORTA}`;

        if (CENAS.has('L')) {
          await cenaLateral(navegador, base, VIEWPORT_CELULAR, 'celular', 'depois', resultado, gerados);
          await cenaLateral(navegador, base, VIEWPORT_DESKTOP, 'desktop', 'depois', resultado, gerados);
        }
        if (CENAS.has('N1')) await cenaN1(navegador, base, resultado, gerados);
        if (CENAS.has('N1b')) await cenaN1b(navegador, base, resultado);
        if (CENAS.has('N2')) {
          await cenaN2(navegador, 'com-bfcache', base, resultado, gerados);
          await cenaN2(navegadorSemBfcache, 'sem-bfcache', base, resultado, gerados);
        }
        if (CENAS.has('N3')) {
          await cenaN3(navegador, 'com-bfcache', base, resultado, gerados);
          await cenaN3(navegadorSemBfcache, 'sem-bfcache', base, resultado, gerados);
        }
        if (CENAS.has('N4')) {
          await cenaN4(navegador, 'com-bfcache', base, resultado, gerados);
          await cenaN4(navegadorSemBfcache, 'sem-bfcache', base, resultado, gerados);
        }
        if (CENAS.has('N4b')) await cenaN4b(navegador, base, resultado);
        if (CENAS.has('N5')) await cenaN5(navegador, base, resultado);
      } finally {
        derrubar(servidorDepois);
      }

      if (CENAS.has('L') && CODIGO_DIR_ANTES) {
        const servidorAntes = await subirServidor(CODIGO_DIR_ANTES, dirsFixture, scratch, 'antes');
        try {
          const base = `http://127.0.0.1:${PORTA}`;
          await cenaLateral(navegador, base, VIEWPORT_CELULAR, 'celular', 'antes', resultado, gerados);
          await cenaLateral(navegador, base, VIEWPORT_DESKTOP, 'desktop', 'antes', resultado, gerados);
        } finally {
          derrubar(servidorAntes);
        }
      } else if (CENAS.has('L')) {
        console.log('  · CODIGO_DIR não informado — pulando a lateral "antes"');
      }
    } finally {
      await navegador.close().catch(() => {});
      if (navegadorSemBfcache) await navegadorSemBfcache.close().catch(() => {});
    }

    rc = resultado.problemas.length ? 1 : 0;
  } catch (e) {
    resultado.problemas.push(`estourou — ${String(e && e.message).slice(0, 500)}`);
    rc = 1;
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    resultado.pngs = gerados;
    resultado.nPngs = gerados.length;
    resultado.veredito = rc === 0 ? 'ok' : 'reprovado';
    try {
      fs.mkdirSync(SAIDA, { recursive: true });
      fs.writeFileSync(path.join(SAIDA, 'resultado.json'), JSON.stringify(resultado, null, 2));
      console.log(`  · resultado.json gravado em ${path.join(SAIDA, 'resultado.json')}`);
    } catch { /* sem pasta de saída, só o console */ }
    for (const g of gerados) console.log(`  ✅ ${g}`);
    for (const p of resultado.problemas) console.error(`  ❌ ${p}`);
    process.exit(rc);
  }
})();
