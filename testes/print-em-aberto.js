#!/usr/bin/env node
'use strict';
// PRINT DO "EM ABERTO" + PR DO GITHUB + VOLTAR UM PASSO (card `ver-a-diff-do-codigo`, D97) —
// fotografa: a tela ANTES (código da develop, palco vazio), "Em aberto" com jobs E PRs
// (celular/desktop), "Carregando…" durante a espera de rede, vazio ("Nada esperando merge."),
// GitHub fora do ar (aviso + só os jobs), a vista de um PR (celular/desktop) e o "‹ Em aberto"
// sem empilhar, e o voltar um passo dentro da lista de commits e do job. Tema ESCURO em TODA
// cena (#117). Fixture 100% sintética (git init + 2 jobs fabricados) — #106: nenhum nome real.
//
// Uso (fixture, `gh` falso):
//   SAIDA=<pasta nova> PUPPETEER_CORE=<pasta> CHROME_BIN=<executável> \
//   [CODIGO_DIR=<raiz de um server.js ANTIGO, pro "antes">] \
//     node testes/print-em-aberto.js
//
// Uso (gh REAL — sem COCKPIT_GH_BIN; GH_CONFIG_DIR obrigatório):
//   SAIDA=<pasta nova> PUPPETEER_CORE=<pasta> CHROME_BIN=<executável> \
//   GH_REAL=1 GH_CONFIG_DIR=<pasta da config do gh> \
//     node testes/print-em-aberto.js
//
// Saída: 0 = PNGs e resultado.json gravados · 1 = cena reprovada (resultado.json sai mesmo
// assim) · 2 = ambiente (env obrigatória faltando).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA || '';
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const CODIGO_DIR_ANTES = process.env.CODIGO_DIR || '';
const CODIGO_DIR = path.join(__dirname, '..');
const GH_REAL = process.env.GH_REAL === '1';
const GH_CONFIG_DIR = process.env.GH_CONFIG_DIR || '';
const PORTA = 7982;
const TOKEN = 'print-em-aberto';
const NOME_PROJETO = 'demo';
const VIEWPORT_CELULAR = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const VIEWPORT_DESKTOP = { width: 1600, height: 1000, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const TETO_MS = 20000;

const TITULO_JOB_RECENTE = 'Lista de compras no celular';
const TITULO_JOB_OUTRO = 'Tema escuro no relatório';

// ─── fail-closed antes de tocar em qualquer coisa ───────────────────────────────────────────────

function ambienteFaltando(msg) { console.error(`🟡 ambiente indisponível: ${msg}`); process.exit(2); }
if (!SAIDA) ambienteFaltando('SAIDA é obrigatória (pasta nova dos PNGs).');
if (!PUPPETEER || !CHROME) ambienteFaltando('PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
let puppeteer;
try { puppeteer = require(PUPPETEER); } catch (e) { ambienteFaltando(`não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`); }
if (!fs.existsSync(CHROME)) ambienteFaltando('CHROME_BIN não existe.');
if (GH_REAL && !GH_CONFIG_DIR) ambienteFaltando('GH_REAL=1 exige GH_CONFIG_DIR (a config do gh que vai pro servidor).');
const SERVER_JS = path.join(CODIGO_DIR, 'server.js');
if (!fs.existsSync(SERVER_JS)) ambienteFaltando(`CODIGO_DIR não tem o servidor (${SERVER_JS}).`);
if (CODIGO_DIR_ANTES && !fs.existsSync(path.join(CODIGO_DIR_ANTES, 'server.js'))) ambienteFaltando(`CODIGO_DIR (antes) não tem o servidor (${CODIGO_DIR_ANTES}).`);

function confereLivre() {
  let saida = '';
  try { saida = execSync('ss -H -lptn', { encoding: 'utf8' }); } catch { return; }
  if (new RegExp(`:${PORTA}\\b`).test(saida)) {
    console.error(`🔴 porta ${PORTA} ocupada — não posso rodar\n${saida}`);
    process.exit(1);
  }
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function pedirHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Zero animação em CURSO antes do obturador (molde `print-diff.js`). */
async function esperarAssentar(pagina) {
  await pagina.waitForFunction(() => document.getAnimations().filter((a) => a.playState === 'running').length === 0, { timeout: 5000 }).catch(() => {});
  await espera(150);
}

async function novaPagina(navegador, viewport) {
  const contexto = await navegador.createBrowserContext();
  const pagina = await contexto.newPage();
  await pagina.setViewport(viewport || VIEWPORT_CELULAR);
  await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await pagina.evaluateOnNewDocument((token) => {
    try { localStorage.setItem('cockpit-idioma', 'pt-BR'); localStorage.setItem('cockpit-token', token); } catch { /* vale nesta página */ }
  }, TOKEN);
  return { contexto, pagina };
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

// ─── cenas ───────────────────────────────────────────────────────────────────────────────────────

/** 00 — código ANTES (develop, sem D97): `/diff/` sem hash e sem `cockpit-diff-projeto` → `#diff-palco` vazio. */
async function cena00Antes(navegador, base, gerados, problemas, resultado) {
  for (const [viewport, sufixo] of [[VIEWPORT_CELULAR, 'celular'], [VIEWPORT_DESKTOP, 'desktop']]) {
    const { contexto, pagina } = await novaPagina(navegador, viewport);
    try {
      await pagina.goto(`${base}/diff/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await pagina.waitForSelector('#diff-palco', { timeout: TETO_MS }); } catch { problemas.push(`cena 00-${sufixo}: #diff-palco não apareceu`); continue; }
      await espera(300);
      const vazio = await pagina.evaluate(() => document.getElementById('diff-palco').children.length === 0);
      resultado[`palcoVazio_${sufixo}`] = vazio;
      if (!vazio) problemas.push(`cena 00-${sufixo}: #diff-palco não estava vazio (ANTES do D97 era sempre vazio sem projeto escolhido)`);
      await tirarPrint(pagina, `00-antes-${sufixo}.png`, gerados, problemas);
    } finally { await contexto.close().catch(() => {}); }
  }
}

/** 01 — "Em aberto": jobs + PRs misturados, mais recente primeiro; seletor em "Em aberto"; sem `.diff-sair` na raiz. */
async function cena01Aberto(navegador, base, gerados, problemas, ordemEsperada, ghReal) {
  for (const [viewport, sufixo] of [[VIEWPORT_CELULAR, 'celular'], [VIEWPORT_DESKTOP, 'desktop']]) {
    const { contexto, pagina } = await novaPagina(navegador, viewport);
    try {
      await pagina.goto(`${base}/diff/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await pagina.waitForSelector('.diff-aberto-item', { timeout: TETO_MS }); } catch { problemas.push(`cena 01-${sufixo}: .diff-aberto-item não apareceu`); continue; }
      const dados = await pagina.evaluate(() => ({
        temJob: !!document.querySelector('.diff-etiqueta-job'),
        temGithub: !!document.querySelector('.diff-etiqueta-github'),
        titulos: [...document.querySelectorAll('.diff-aberto-item .diff-commit-assunto')].map((e) => e.textContent),
        seletorValor: document.getElementById('diff-seletor-projeto').value,
        seletorTexto: document.getElementById('diff-seletor-projeto').selectedOptions[0].textContent,
        temSair: !!document.querySelector('.diff-sair'),
      }));
      if (!dados.temJob) problemas.push(`cena 01-${sufixo}: nenhum .diff-etiqueta-job na lista`);
      if (!dados.temGithub) problemas.push(`cena 01-${sufixo}: nenhum .diff-etiqueta-github na lista`);
      if (!ghReal && JSON.stringify(dados.titulos) !== JSON.stringify(ordemEsperada)) {
        problemas.push(`cena 01-${sufixo}: ordem dos títulos não bate (esperado ${JSON.stringify(ordemEsperada)}, achei ${JSON.stringify(dados.titulos)})`);
      }
      if (dados.seletorValor !== '') problemas.push(`cena 01-${sufixo}: seletor não está em value="" (achei "${dados.seletorValor}")`);
      if (dados.seletorTexto !== 'Em aberto') problemas.push(`cena 01-${sufixo}: seletor não mostra "Em aberto" (achei "${dados.seletorTexto}")`);
      if (dados.temSair) problemas.push(`cena 01-${sufixo}: a raiz tem .diff-sair (não devia — só "‹ Cockpit")`);
      await tirarPrint(pagina, `01-aberto-${sufixo}.png`, gerados, problemas);
    } finally { await contexto.close().catch(() => {}); }
  }
}

/** 01b — a espera de rede mostra "Carregando…" ANTES dos itens (`api/diff/prs` segurado 1,5 s). */
async function cena01bCarregando(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  try {
    await pagina.setRequestInterception(true);
    pagina.on('request', (req) => {
      if (req.url().includes('/api/diff/prs')) setTimeout(() => req.continue().catch(() => {}), 1500);
      else req.continue().catch(() => {});
    });
    await pagina.goto(`${base}/diff/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-aberto-carregando', { timeout: 1000 }); } catch { problemas.push('cena 01b: .diff-aberto-carregando não apareceu'); return; }
    const temItemJa = await pagina.evaluate(() => !!document.querySelector('.diff-aberto-item'));
    if (temItemJa) problemas.push('cena 01b: já tinha item na tela quando "Carregando…" devia estar sozinho');
    await tirarPrint(pagina, '01b-carregando.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

/** 02 — vazio de verdade (gh `vazio` + sem jobs): "Nada esperando merge." */
async function cenaVazio(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-aberto-vazio', { timeout: TETO_MS }); } catch { problemas.push('cena 02: .diff-aberto-vazio não apareceu'); return; }
    const texto = await pagina.evaluate(() => document.querySelector('.diff-aberto-vazio').textContent);
    if (!/Nada esperando merge\./.test(texto)) problemas.push(`cena 02: texto não é "Nada esperando merge." (achei "${texto}")`);
    await tirarPrint(pagina, '02-aberto-vazio.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

/** 03 — GitHub fora do ar: aviso + a lista segue só com os jobs. */
async function cenaGithubFora(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-aberto-item', { timeout: TETO_MS }); } catch { problemas.push('cena 03: .diff-aberto-item não apareceu (os jobs deviam continuar)'); return; }
    const aviso = await pagina.evaluate(() => { const a = document.getElementById('diff-aviso'); return a && !a.hidden ? a.textContent : ''; });
    if (!/não consegui ler o GitHub agora/.test(aviso)) problemas.push(`cena 03: aviso não diz "não consegui ler o GitHub agora" (achei "${aviso}")`);
    const temGithub = await pagina.evaluate(() => !!document.querySelector('.diff-etiqueta-github'));
    if (temGithub) problemas.push('cena 03: apareceu item do GitHub mesmo com o GitHub fora do ar');
    await tirarPrint(pagina, '03-github-fora.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

/** 04/05 — vista de PR (celular + desktop) e "‹ Em aberto" sem empilhar. */
async function cena04Pr(navegador, base, gerados, problemas, ghReal) {
  for (const [viewport, sufixo] of [[VIEWPORT_CELULAR, 'celular'], [VIEWPORT_DESKTOP, 'desktop']]) {
    const { contexto, pagina } = await novaPagina(navegador, viewport);
    try {
      await pagina.goto(`${base}/diff/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await pagina.waitForSelector('.diff-aberto-item', { timeout: TETO_MS }); } catch { problemas.push(`cena 04-${sufixo}: .diff-aberto-item não apareceu`); continue; }
      const nHistAntes = await pagina.evaluate(() => history.length);
      if (ghReal) {
        await pagina.evaluate(() => {
          const item = [...document.querySelectorAll('.diff-aberto-item')].find((e) => e.querySelector('.diff-etiqueta-github'));
          if (item) item.click();
        });
      } else {
        await pagina.evaluate(() => {
          const item = [...document.querySelectorAll('.diff-aberto-item')].find((e) => e.textContent.includes('#7'));
          if (item) item.click();
        });
      }
      try { await pagina.waitForSelector('.diff-cabecalho-pr', { timeout: TETO_MS }); } catch { problemas.push(`cena 04-${sufixo}: .diff-cabecalho-pr não apareceu`); continue; }
      if (!ghReal) {
        const branches = await pagina.evaluate(() => { const e = document.querySelector('.diff-pr-branches'); return e ? e.textContent : ''; });
        if (!/feature\/carrinho/.test(branches) || !/develop/.test(branches)) problemas.push(`cena 04-${sufixo}: .diff-pr-branches não mostra feature/carrinho → develop (achei "${branches}")`);
      }
      const nArquivos = await pagina.evaluate(() => document.querySelectorAll('.diff-arquivo').length);
      if (nArquivos < 1) problemas.push(`cena 04-${sufixo}: nenhum .diff-arquivo na vista do PR`);
      const tabelaSeletor = sufixo === 'desktop' ? '.diff-tabela-lado-a-lado' : '.diff-tabela-unificada';
      try { await pagina.waitForSelector(tabelaSeletor, { timeout: TETO_MS }); } catch { problemas.push(`cena 04-${sufixo}: ${tabelaSeletor} não apareceu`); }
      const topo = await pagina.evaluate(() => ({
        voltar: document.querySelector('.diff-voltar') ? document.querySelector('.diff-voltar').textContent : null,
        sair: document.querySelector('.diff-sair') ? document.querySelector('.diff-sair').textContent : null,
      }));
      if (topo.voltar !== '‹ Em aberto') problemas.push(`cena 04-${sufixo}: topo não diz "‹ Em aberto" (achei "${topo.voltar}")`);
      if (topo.sair !== 'Cockpit') problemas.push(`cena 04-${sufixo}: .diff-sair não diz "Cockpit" (achei "${topo.sair}")`);
      await tirarPrint(pagina, `04-pr-${sufixo}.png`, gerados, problemas);

      if (sufixo === 'celular') {
        await pagina.click('.diff-voltar');
        try { await pagina.waitForSelector('.diff-aberto-item', { timeout: TETO_MS }); } catch { problemas.push('cena 05: "Em aberto" não voltou depois do "‹"'); continue; }
        const urlFinal = new URL(pagina.url());
        if (!urlFinal.pathname.endsWith('/diff/')) problemas.push(`cena 05: a URL saiu de /diff/ (achei ${urlFinal.pathname})`);
        if (urlFinal.hash !== '') problemas.push(`cena 05: o hash não ficou vazio (achei ${urlFinal.hash})`);
        const nHistDepois = await pagina.evaluate(() => history.length);
        if (nHistDepois !== nHistAntes + 1) problemas.push(`cena 05: history.length esperado ${nHistAntes + 1} (o PR empilhou 1, o "‹" voltou sem empilhar), achei ${nHistDepois}`);
        await tirarPrint(pagina, '05-pr-voltou-celular.png', gerados, problemas);
      }
    } finally { await contexto.close().catch(() => {}); }
  }
}

/** 06/07/08 — rolar a lista de commits, abrir um commit, "‹ Commits" devolve no mesmo scrollTop. */
async function cenaVoltarCommits(navegador, base, gerados, problemas) {
  for (const [viewport, sufixo] of [[VIEWPORT_CELULAR, 'celular'], [VIEWPORT_DESKTOP, 'desktop']]) {
    const { contexto, pagina } = await novaPagina(navegador, viewport);
    try {
      await pagina.goto(`${base}/diff/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await pagina.waitForSelector(`#diff-seletor-projeto option[value="${NOME_PROJETO}"]`, { timeout: TETO_MS }); } catch { problemas.push(`cena 06-${sufixo}: opção do projeto não apareceu no seletor`); continue; }
      await pagina.select('#diff-seletor-projeto', NOME_PROJETO);
      try { await pagina.waitForSelector('.diff-commit-item', { timeout: TETO_MS }); } catch { problemas.push(`cena 06-${sufixo}: .diff-commit-item não apareceu`); continue; }

      await pagina.evaluate(() => { document.getElementById('diff-raiz').scrollTop = 1000; });
      await espera(50);
      const scrollAntes = await pagina.evaluate(() => document.getElementById('diff-raiz').scrollTop);
      if (scrollAntes < 600) problemas.push(`cena 06-${sufixo}: scrollTop não chegou a 600 (achei ${scrollAntes})`);
      await tirarPrint(pagina, `06-lista-rolada-${sufixo}.png`, gerados, problemas);

      // Toque REAL no item que está no meio da TELA (painel de execução, Codex #2): `mouse.click` nas coordenadas, sem
      // `elementHandle.click()` — esse rola o elemento pra vista e mudaria o `scrollTop` que a cena mede.
      const alvo = await pagina.evaluate(() => {
        const x = Math.floor(innerWidth / 2);
        const y = Math.floor(innerHeight / 2);
        const no = document.elementFromPoint(x, y);
        return no && no.closest('.diff-commit-item') ? { x, y } : null;
      });
      if (!alvo) { problemas.push(`cena 07-${sufixo}: nenhum .diff-commit-item no meio da tela`); continue; }
      await pagina.mouse.click(alvo.x, alvo.y);
      try { await pagina.waitForSelector('.diff-cabecalho .diff-sha-visivel', { timeout: TETO_MS }); } catch { problemas.push(`cena 07-${sufixo}: o commit não abriu`); continue; }
      const topo = await pagina.evaluate(() => ({
        voltar: document.querySelector('.diff-voltar') ? document.querySelector('.diff-voltar').textContent : null,
        sair: document.querySelector('.diff-sair') ? document.querySelector('.diff-sair').textContent : null,
      }));
      if (topo.voltar !== '‹ Commits') problemas.push(`cena 07-${sufixo}: topo não diz "‹ Commits" (achei "${topo.voltar}")`);
      if (topo.sair !== 'Cockpit') problemas.push(`cena 07-${sufixo}: .diff-sair não diz "Cockpit" (achei "${topo.sair}")`);
      await tirarPrint(pagina, `07-commit-${sufixo}.png`, gerados, problemas);

      await pagina.click('.diff-voltar');
      try { await pagina.waitForSelector('.diff-commit-item', { timeout: TETO_MS }); } catch { problemas.push(`cena 08-${sufixo}: a lista não voltou`); continue; }
      await espera(200);
      const scrollDepois = await pagina.evaluate(() => document.getElementById('diff-raiz').scrollTop);
      if (Math.abs(scrollDepois - scrollAntes) > 2) problemas.push(`cena 08-${sufixo}: scrollTop mudou na volta (antes ${scrollAntes}, depois ${scrollDepois})`);
      const urlFinal = new URL(pagina.url());
      if (!urlFinal.pathname.endsWith('/diff/') || urlFinal.hash !== `#projeto=${NOME_PROJETO}`) {
        problemas.push(`cena 08-${sufixo}: URL não é /diff/#projeto=${NOME_PROJETO} (achei ${urlFinal.pathname}${urlFinal.hash})`);
      }
      await tirarPrint(pagina, `08-lista-voltou-${sufixo}.png`, gerados, problemas);
    } finally { await contexto.close().catch(() => {}); }
  }
}

/** 09 — job → "‹ Em aberto" sem empilhar. */
async function cenaJobVoltar(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-aberto-item', { timeout: TETO_MS }); } catch { problemas.push('cena 09: .diff-aberto-item não apareceu'); return; }
    await pagina.evaluate((titulo) => {
      const item = [...document.querySelectorAll('.diff-aberto-item')].find((e) => e.textContent.includes(titulo));
      if (item) item.click();
    }, TITULO_JOB_RECENTE);
    try { await pagina.waitForSelector('.diff-job-vista', { timeout: TETO_MS }); } catch { problemas.push('cena 09: .diff-job-vista não apareceu'); return; }
    const voltarTexto = await pagina.evaluate(() => (document.querySelector('.diff-voltar') ? document.querySelector('.diff-voltar').textContent : null));
    if (voltarTexto !== '‹ Em aberto') problemas.push(`cena 09: topo não diz "‹ Em aberto" (achei "${voltarTexto}")`);
    await tirarPrint(pagina, '09-job-celular.png', gerados, problemas);

    await pagina.click('.diff-voltar');
    try { await pagina.waitForSelector('.diff-aberto-item', { timeout: TETO_MS }); } catch { problemas.push('cena 09: "Em aberto" não voltou depois do "‹ Em aberto"'); return; }
    const urlFinal = new URL(pagina.url());
    if (!urlFinal.pathname.endsWith('/diff/') || urlFinal.hash !== '') problemas.push(`cena 09: a URL não é /diff/ limpo (achei ${urlFinal.pathname}${urlFinal.hash})`);
  } finally { await contexto.close().catch(() => {}); }
}

/** 10 — link direto (sem pilha): `#projeto=&commit=` numa página nova sobe por `replaceState`. */
async function cenaLinkDireto(navegador, base, gerados, problemas, sha) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_CELULAR);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}#projeto=${NOME_PROJETO}&commit=${sha}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-cabecalho .diff-sha-visivel', { timeout: TETO_MS }); } catch { problemas.push('cena 10: o commit (link direto) não abriu'); return; }
    const voltarTexto = await pagina.evaluate(() => (document.querySelector('.diff-voltar') ? document.querySelector('.diff-voltar').textContent : null));
    if (voltarTexto !== '‹ Commits') problemas.push(`cena 10: topo não diz "‹ Commits" (achei "${voltarTexto}")`);
    const nHistAntes = await pagina.evaluate(() => history.length);
    await pagina.click('.diff-voltar');
    try { await pagina.waitForSelector('.diff-commit-item', { timeout: TETO_MS }); } catch { problemas.push('cena 10: a lista não apareceu depois do "‹ Commits"'); return; }
    const nHistDepois = await pagina.evaluate(() => history.length);
    if (nHistDepois !== nHistAntes) problemas.push(`cena 10: history.length mudou (esperado ${nHistAntes}, achei ${nHistDepois}) — link direto tem de subir por replaceState, sem empilhar`);
    const urlDez = new URL(pagina.url());
    if (!urlDez.pathname.endsWith('/diff/') || urlDez.hash !== `#projeto=${NOME_PROJETO}`) problemas.push(`cena 10: o "‹ Commits" saiu do lugar (achei ${urlDez.pathname}${urlDez.hash}, esperado /diff/#projeto=${NOME_PROJETO})`);
    await tirarPrint(pagina, '10-link-direto-subiu.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

// ─── servidor FILHO, em SEQUÊNCIA na mesma porta (molde `print-diff.js`) ────────────────────────

async function comServidor(codigoDir, { projetosDir, jobsDir, ghBin, extraEnv }, scratch, sufixo, tarefa) {
  confereLivre();
  const home = path.join(scratch, `home-${sufixo}`);
  fs.mkdirSync(home, { recursive: true });
  const ambiente = {
    PATH: process.env.PATH,
    HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
    COCKPIT_CERT_DIR: '/dev/null',
    COCKPIT_TOKEN: TOKEN,
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_JOBS_DIR: jobsDir,
    COCKPIT_MONITOR_DIR: path.join(scratch, `monitor-${sufixo}`), COCKPIT_MONITOR_MS: '0',
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(scratch, `push-${sufixo}`),
    COCKPIT_LIDAS_DIR: path.join(scratch, `lidas-${sufixo}`),
    COCKPIT_LEITURAS_DIR: path.join(scratch, `leituras-${sufixo}`),
    COCKPIT_TMUX_SOCKET: `print-aberto-${process.pid}-${sufixo}`,
    COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
  };
  if (ghBin) ambiente.COCKPIT_GH_BIN = ghBin;
  if (extraEnv) Object.assign(ambiente, extraEnv);
  const servidor = spawn(process.execPath, [path.join(codigoDir, 'server.js')], { cwd: codigoDir, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
  let saidaErro = '';
  servidor.stderr.on('data', (d) => { saidaErro += d; });
  let pronto = false;
  for (let i = 0; i < 100 && !pronto; i += 1) {
    if (servidor.exitCode !== null) break;
    pronto = await pedirHealth();
    if (!pronto) await espera(100);
  }
  if (!pronto) {
    // Não deixa o filho preso na porta quando o /health não respondeu a tempo (painel de execução, Codex #1).
    if (servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      await new Promise((r) => servidor.once('exit', r));
    }
    throw new Error(`o servidor (${codigoDir}, sufixo ${sufixo}) não subiu na porta ${PORTA} — ${saidaErro}`);
  }
  try {
    await tarefa();
  } finally {
    if (servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      await new Promise((r) => servidor.once('exit', r));
    }
  }
}

// ─── fixture ─────────────────────────────────────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture Demo', GIT_AUTHOR_EMAIL: 'fixture-demo@localhost',
  GIT_COMMITTER_NAME: 'Fixture Demo', GIT_COMMITTER_EMAIL: 'fixture-demo@localhost',
};
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV, stdio: 'pipe' }).toString('utf8');

function montarRepoDemo(scratch) {
  const projetosDir = path.join(scratch, 'projetos');
  const demoDir = path.join(projetosDir, NOME_PROJETO);
  fs.mkdirSync(demoDir, { recursive: true });
  git(demoDir, ['init', '-q', '-b', 'develop']);
  for (let i = 1; i <= 45; i += 1) {
    fs.writeFileSync(path.join(demoDir, `arquivo-${i}.txt`), `conteúdo ${i}\n`);
    git(demoDir, ['add', '.']);
    git(demoDir, ['commit', '-q', '-m', `commit ${i}`]);
  }
  const shaDeUmCommit = git(demoDir, ['rev-parse', 'HEAD~5']).trim();

  git(demoDir, ['branch', 'feature/demo-a', 'develop']);
  git(demoDir, ['checkout', '-q', 'feature/demo-a']);
  fs.mkdirSync(path.join(demoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(demoDir, 'src', 'a.js'), Array.from({ length: 20 }, (_, i) => `const linha${i} = ${i};`).join('\n') + '\n');
  git(demoDir, ['add', '.']);
  git(demoDir, ['commit', '-q', '-m', 'feature/demo-a: 1º commit']);
  fs.writeFileSync(path.join(demoDir, 'src', 'a.js'), Array.from({ length: 40 }, (_, i) => `const linha${i} = ${i} + 1;`).join('\n') + '\n');
  git(demoDir, ['add', '.']);
  git(demoDir, ['commit', '-q', '-m', 'feature/demo-a: 2º commit']);

  git(demoDir, ['branch', 'feature/demo-b', 'develop']);
  git(demoDir, ['checkout', '-q', 'feature/demo-b']);
  fs.writeFileSync(path.join(demoDir, 'b.txt'), 'novo arquivo do demo-b\n');
  git(demoDir, ['add', '.']);
  git(demoDir, ['commit', '-q', '-m', 'feature/demo-b: 1º commit']);

  git(demoDir, ['checkout', '-q', 'develop']);

  const diffFeatureA = git(demoDir, ['diff', '--no-color', 'develop...feature/demo-a']);
  const numstat = git(demoDir, ['diff', '--numstat', 'develop...feature/demo-a']).trim().split('\n').filter(Boolean);
  let mais = 0; let menos = 0;
  for (const linha of numstat) { const [a, d] = linha.split('\t'); mais += Number(a) || 0; menos += Number(d) || 0; }

  return { projetosDir, demoDir, shaDeUmCommit, diffFeatureA, totaisFeatureA: { mais, menos, arquivos: numstat.length } };
}

function pidMorto() {
  try { return Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1; }
  catch { return 4194304; }
}

function montarJobs(scratch, demoDir) {
  const jobsDir = path.join(scratch, 'jobs');
  const jobsDirVazio = path.join(scratch, 'jobs-vazio');
  fs.mkdirSync(jobsDirVazio, { recursive: true });
  const pid = pidMorto();
  function job(id, titulo, branch, fimOffsetMs) {
    const wt = path.join(scratch, 'wt', id);
    fs.mkdirSync(wt, { recursive: true });
    const pasta = path.join(jobsDir, id);
    fs.mkdirSync(pasta, { recursive: true });
    const fim = new Date(Date.now() - fimOffsetMs).toISOString();
    const meta = {
      id, type: 'ataca', project: 'demo', title: titulo, origin: 'capitao', status: 'done',
      pid, created_at: fim, source_repo: demoDir, worktree: wt, branch,
    };
    fs.writeFileSync(path.join(pasta, 'meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(pasta, 'status.log'), `${fim} done: ok\n`);
    fs.writeFileSync(path.join(pasta, 'result.md'), 'done: fixture do Em aberto.\n\n## Smoke pra o dono\nNada a testar à mão: fixture.\n');
    return id;
  }
  const idRecente = job('20261019-170000-demo-lista-compras-0001', TITULO_JOB_RECENTE, 'feature/demo-a', 30 * 60e3);
  const idOutro = job('20261019-150000-demo-tema-escuro-0002', TITULO_JOB_OUTRO, 'feature/demo-b', 2 * 3600e3);
  return { jobsDir, jobsDirVazio, idRecente, idOutro };
}

function prepararGhFalso(scratch, config) {
  const dir = path.join(scratch, 'gh');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'gh');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'gh-falso.js'), bin);
  fs.chmodSync(bin, 0o755);
  const caminhoConfig = path.join(dir, 'gh-falso.json');
  const registro = path.join(dir, 'registro.jsonl');
  const escrever = (novoConfig) => fs.writeFileSync(caminhoConfig, JSON.stringify({ registro, ...novoConfig }));
  escrever(config);
  return { bin, escrever };
}

function listaPrsFixture() {
  const agora = Date.now();
  return [
    { repository: { nameWithOwner: 'exemplo-org/loja' }, number: 7, title: 'Algo sobre o carrinho', author: { login: 'fulano' }, updatedAt: new Date(agora - 60 * 60e3).toISOString(), isDraft: false },
    { repository: { nameWithOwner: 'outra-org/app' }, number: 12, title: 'Ajusta o relatório do app', author: { login: 'ciclana' }, updatedAt: new Date(agora - 25 * 3600e3).toISOString(), isDraft: false },
    { repository: { nameWithOwner: 'exemplo-org/loja' }, number: 5, title: 'Rascunho do tema novo', author: { login: 'fulano' }, updatedAt: new Date(agora - 73 * 3600e3).toISOString(), isDraft: true },
  ];
}

// ─── corrida ─────────────────────────────────────────────────────────────────────────────────────

(async () => {
  const resultado = { pngs: [], problemas: [] };
  const gerados = [];
  let rc = 1;
  let scratch = null;

  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-aberto-'));
    const { projetosDir, demoDir, shaDeUmCommit, diffFeatureA, totaisFeatureA } = montarRepoDemo(scratch);
    const { jobsDir, jobsDirVazio } = montarJobs(scratch, demoDir);

    const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const base = `http://127.0.0.1:${PORTA}`;

      // ── 00: servidor ANTIGO (opcional) ──────────────────────────────────────
      if (CODIGO_DIR_ANTES) {
        await comServidor(CODIGO_DIR_ANTES, { projetosDir, jobsDir, ghBin: path.join(scratch, 'sem-gh') }, scratch, 'antes', async () => {
          await cena00Antes(navegador, base, gerados, resultado.problemas, resultado);
        });
      } else {
        console.log('  · CODIGO_DIR não informado — pulando as cenas 00-antes-*.png');
      }

      if (GH_REAL) {
        // ── gh REAL: sem COCKPIT_GH_BIN, com GH_CONFIG_DIR ──────────────────
        await comServidor(CODIGO_DIR, { projetosDir, jobsDir, ghBin: null, extraEnv: { GH_CONFIG_DIR } }, scratch, 'gh-real', async () => {
          const ordemFixture = [TITULO_JOB_RECENTE, 'Algo sobre o carrinho', TITULO_JOB_OUTRO, 'Ajusta o relatório do app', 'Rascunho do tema novo'];
          await cena01Aberto(navegador, base, gerados, resultado.problemas, ordemFixture, true);
          await cena04Pr(navegador, base, gerados, resultado.problemas, true);
          await cenaVoltarCommits(navegador, base, gerados, resultado.problemas);
          await cenaJobVoltar(navegador, base, gerados, resultado.problemas);
          await cenaLinkDireto(navegador, base, gerados, resultado.problemas, shaDeUmCommit);
        });
      } else {
        // ── fixture com o `gh` falso ─────────────────────────────────────────
        const viewOk = {
          number: 7, title: 'Algo sobre o carrinho', author: { login: 'fulano' },
          headRefName: 'feature/carrinho', baseRefName: 'develop', updatedAt: new Date(Date.now() - 60 * 60e3).toISOString(),
          additions: totaisFeatureA.mais, deletions: totaisFeatureA.menos, changedFiles: totaisFeatureA.arquivos, isDraft: false,
        };
        const falso = prepararGhFalso(scratch, {
          modo: 'ok', lista: listaPrsFixture(),
          prs: { 'exemplo-org/loja#7': { view: viewOk, diff: diffFeatureA } },
          diffModo: 'ok',
        });

        await comServidor(CODIGO_DIR, { projetosDir, jobsDir, ghBin: falso.bin }, scratch, 'fixture', async () => {
          await cena01bCarregando(navegador, base, gerados, resultado.problemas);
          const ordemFixture = [TITULO_JOB_RECENTE, 'Algo sobre o carrinho', TITULO_JOB_OUTRO, 'Ajusta o relatório do app', 'Rascunho do tema novo'];
          await cena01Aberto(navegador, base, gerados, resultado.problemas, ordemFixture, false);
          await cena04Pr(navegador, base, gerados, resultado.problemas, false);
          await cenaVoltarCommits(navegador, base, gerados, resultado.problemas);
          await cenaJobVoltar(navegador, base, gerados, resultado.problemas);
          await cenaLinkDireto(navegador, base, gerados, resultado.problemas, shaDeUmCommit);
        });

        falso.escrever({ modo: 'vazio' });
        await comServidor(CODIGO_DIR, { projetosDir, jobsDir: jobsDirVazio, ghBin: falso.bin }, scratch, 'vazio', async () => {
          await cenaVazio(navegador, base, gerados, resultado.problemas);
        });

        falso.escrever({ modo: 'falha' });
        await comServidor(CODIGO_DIR, { projetosDir, jobsDir, ghBin: falso.bin }, scratch, 'falha', async () => {
          await cenaGithubFora(navegador, base, gerados, resultado.problemas);
        });
      }
    } finally {
      await navegador.close().catch(() => {});
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
