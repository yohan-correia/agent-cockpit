#!/usr/bin/env node
'use strict';
// PRINT DA DIFF DE COMMIT E DE JOB (card `ver-a-diff-do-codigo`, D95) — fotografa a lista de
// commits, um commit aberto (arquivo recolhido/aberto), um merge, o lado a lado do desktop, um
// job com mudanças, um job já mergeado, as DUAS entradas (Pra revisar → "Ver mudanças"; painel do
// job → `.btn-mudancas`) e a lateral com o botão "Commits" (antes/depois). Tema ESCURO em TODA
// cena (#117: o headless anuncia claro). Prova sem PNG: voltar da lista preserva a rolagem e não
// faz pedido novo.
//
// #106: nenhum nome de pasta/projeto real mora NO ARQUIVO — tudo por env. `REPO_REAL` e
// `JOBS_REAIS` só são LIDOS: o projeto de fixture é um `git init` com `objects/info/alternates`
// apontando pros objetos de `REPO_REAL` (nenhum objeto copiado; os SHAs são os mesmos) + `git
// fetch` das refs; os `meta.json` dos jobs são COPIADOS pro tmp com `source_repo` reescrito.
//
// Uso:
//   SAIDA=<pasta nova> PUPPETEER_CORE=<pasta> CHROME_BIN=<executável> REPO_REAL=<repo> \
//   JOBS_REAIS=<pasta de jobs> JOB_OK=<id> JOB_MERGEADO=<id> COMMIT=<sha> MERGE=<sha> \
//   [CODIGO_DIR=<raiz de um server.js ANTIGO, pro "antes" da lateral>] \
//     node testes/print-diff.js
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
const REPO_REAL = process.env.REPO_REAL || '';
const JOBS_REAIS = process.env.JOBS_REAIS || '';
const JOB_OK = process.env.JOB_OK || '';
const JOB_MERGEADO = process.env.JOB_MERGEADO || '';
const COMMIT = process.env.COMMIT || '';
const MERGE = process.env.MERGE || '';
const CODIGO_DIR_ANTES = process.env.CODIGO_DIR || '';
const CODIGO_DIR = path.join(__dirname, '..');
const PORTA = 7988;
const TOKEN = 'print-diff';
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
if (!JOB_MERGEADO || !fs.existsSync(path.join(JOBS_REAIS, JOB_MERGEADO, 'meta.json'))) ambienteFaltando('JOB_MERGEADO tem de ter meta.json em JOBS_REAIS.');
if (!COMMIT) ambienteFaltando('COMMIT é obrigatório.');
if (!MERGE) ambienteFaltando('MERGE é obrigatório.');
const SERVER_JS = path.join(CODIGO_DIR, 'server.js');
if (!fs.existsSync(SERVER_JS)) ambienteFaltando(`CODIGO_DIR não tem o servidor (${SERVER_JS}).`);

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

/** Zero animação em CURSO antes do obturador (molde `print-grafo-mapa.js`, `esperarAssentar`). */
async function esperarAssentar(pagina) {
  await pagina.waitForFunction(() => document.getAnimations().filter((a) => a.playState === 'running').length === 0, { timeout: 5000 }).catch(() => {});
  await espera(150);
}

async function novaPagina(navegador, viewport) {
  const contexto = await navegador.createBrowserContext();
  const pagina = await contexto.newPage();
  await pagina.setViewport(viewport || VIEWPORT_CELULAR);
  await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); localStorage.setItem('cockpit-token', 'print-diff'); } catch { /* vale nesta página */ } });
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

// ─── cenas (servidor "depois", código desta worktree) ───────────────────────────────────────────

async function cena01Lista(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}#projeto=${encodeURIComponent(NOME_PROJETO)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForFunction(() => document.querySelectorAll('#diff-palco .diff-commit-item').length >= 10, { timeout: TETO_MS }); }
    catch { problemas.push('cena 01: menos de 10 .diff-commit-item na lista'); return; }
    await tirarPrint(pagina, '01-celular-lista.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

async function cena0203CommitAberto(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}#projeto=${encodeURIComponent(NOME_PROJETO)}&commit=${COMMIT}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-cabecalho .diff-sha-visivel', { timeout: TETO_MS }); } catch { problemas.push('cena 02: .diff-cabecalho não apareceu'); return; }
    try { await pagina.waitForSelector('.diff-arquivo[open] .diff-mais', { timeout: TETO_MS }); } catch { problemas.push('cena 02: nenhum .diff-mais visível no 1º arquivo aberto'); return; }
    // Conferência do orquestrador (19/10): defeitos vistos no PNG com o veredito verde — agora exigidos.
    const leitura = await pagina.evaluate(() => {
      const texto = document.querySelector('.diff-arquivo[open] .diff-texto');
      const sumario = document.querySelector('.diff-arquivo > summary');
      const primeiro = sumario && [...sumario.children].find((c) => c.classList.contains('diff-arquivo-nome') || c.classList.contains('diff-arquivo-pasta'));
      return {
        espaco: texto && getComputedStyle(texto).whiteSpace,
        ligaduras: texto && getComputedStyle(texto).fontVariantLigatures,
        primeiroNoSumario: primeiro && primeiro.className,
      };
    });
    if (leitura.espaco !== 'pre') problemas.push(`cena 02: sem "Quebrar linhas" a linha tem de rolar de lado (white-space pre), achei ${leitura.espaco}`);
    if (leitura.ligaduras !== 'none') problemas.push(`cena 02: código sem ligaduras (=== não pode virar um glifo só), achei ${leitura.ligaduras}`);
    if (leitura.primeiroNoSumario !== 'diff-arquivo-nome') problemas.push(`cena 02: o nome do arquivo vem ANTES da pasta (como o Zed), achei ${leitura.primeiroNoSumario}`);
    await tirarPrint(pagina, '02-celular-commit-aberto.png', gerados, problemas);
    await pagina.click('.diff-btn-quebrar');
    const depoisDoToque = await pagina.evaluate(() => ({
      espaco: getComputedStyle(document.querySelector('.diff-arquivo[open] .diff-texto')).whiteSpace,
      pressionado: document.querySelector('.diff-btn-quebrar').getAttribute('aria-pressed'),
    }));
    if (depoisDoToque.espaco !== 'pre-wrap' || depoisDoToque.pressionado !== 'true') problemas.push(`cena 02: "Quebrar linhas" tocado tem de quebrar (pre-wrap, aria-pressed true), achei ${JSON.stringify(depoisDoToque)}`);
    await tirarPrint(pagina, '02b-celular-quebrar-linhas.png', gerados, problemas);
    await pagina.click('.diff-btn-quebrar');

    const nArquivos = await pagina.evaluate(() => document.querySelectorAll('.diff-arquivo').length);
    if (nArquivos < 2) { problemas.push(`cena 03: commit tem só ${nArquivos} arquivo(s) — precisa de ≥ 2 para recolher o 1º e abrir o 2º`); return; }
    await pagina.evaluate(() => {
      const arqs = document.querySelectorAll('.diff-arquivo');
      arqs[0].open = false;
      arqs[1].open = true;
    });
    await tirarPrint(pagina, '03-celular-commit-recolhido.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

async function cena04Merge(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}#projeto=${encodeURIComponent(NOME_PROJETO)}&commit=${MERGE}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-nota-merge', { timeout: TETO_MS }); } catch { problemas.push('cena 04: .diff-nota-merge não apareceu'); return; }
    const texto = await pagina.evaluate(() => document.querySelector('.diff-nota-merge').textContent);
    if (!/1º pai/.test(texto)) problemas.push(`cena 04: a nota de merge não cita "1º pai" (achei "${texto}")`);
    await tirarPrint(pagina, '04-celular-merge.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

/** Painel Codex/R2 residual: `.diff-vazio` precisa existir de verdade na cena — se `sha` não
 * produzir, tenta o outro antes de desistir (anotado no plano: troca o commit e registra). */
async function cena05Desktop(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador, VIEWPORT_DESKTOP);
  try {
    let shaUsado = COMMIT;
    await pagina.goto(`${base}/diff/?token=${TOKEN}#projeto=${encodeURIComponent(NOME_PROJETO)}&commit=${COMMIT}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-tabela-lado-a-lado', { timeout: TETO_MS }); } catch { problemas.push('cena 05: .diff-tabela-lado-a-lado não apareceu (viewport < 900px?)'); return; }
    let temVazio = await pagina.evaluate(() => !!document.querySelector('.diff-vazio'));
    if (!temVazio) {
      shaUsado = MERGE;
      await pagina.goto(`${base}/diff/?token=${TOKEN}#projeto=${encodeURIComponent(NOME_PROJETO)}&commit=${MERGE}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await pagina.waitForSelector('.diff-tabela-lado-a-lado', { timeout: TETO_MS }); } catch { problemas.push('cena 05: .diff-tabela-lado-a-lado não apareceu no MERGE'); return; }
      temVazio = await pagina.evaluate(() => !!document.querySelector('.diff-vazio'));
    }
    if (!temVazio) { problemas.push('cena 05: nenhum .diff-vazio em COMMIT nem em MERGE — trocar o commit do print (anotado no plano)'); return; }
    if (shaUsado !== COMMIT) console.log(`  · cena 05: .diff-vazio só apareceu no MERGE (${MERGE}) — usando esse commit`);
    // Conferência do orquestrador (19/10): o lado SEM linha é só hachurado — nem fundo verde, nem a faixa da margem.
    const ladoVazio = await pagina.evaluate(() => {
      const vazios = [...document.querySelectorAll('.diff-tabela-lado-a-lado td.diff-vazio')];
      const tingidos = vazios.filter((td) => td.classList.contains('diff-mais') || td.classList.contains('diff-menos')
        || td.parentElement.classList.contains('diff-mais') || td.parentElement.classList.contains('diff-menos'));
      const adicao = document.querySelector('.diff-tabela-lado-a-lado td.diff-texto.diff-mais');
      return { vazios: vazios.length, tingidos: tingidos.length, temAdicaoNaCelula: !!adicao };
    });
    if (ladoVazio.tingidos > 0 || !ladoVazio.temAdicaoNaCelula) problemas.push(`cena 05: a cor vai na CÉLULA do lado que mudou, nunca no lado vazio (${JSON.stringify(ladoVazio)})`);
    await tirarPrint(pagina, '05-desktop-lado-a-lado.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

async function cena06JobOk(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}#job=${encodeURIComponent(JOB_OK)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-job-commits summary', { timeout: TETO_MS }); } catch {
      const tela = await pagina.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 300)).catch(() => '');
      problemas.push(`cena 06: a lista de commits do job não apareceu (a tela dizia: ${JSON.stringify(tela)})`);
      return;
    }
    try { await pagina.waitForSelector('.diff-arquivo', { timeout: TETO_MS }); } catch { problemas.push('cena 06: nenhum .diff-arquivo no job'); return; }
    await tirarPrint(pagina, '06-celular-job-ok.png', gerados, problemas);
    // Painel de execução R2 (Claude #1): a vista do JOB também repinta ao cruzar os 900 px (girar o celular).
    // Só a LARGURA muda (isMobile/hasTouch iguais): trocar isMobile no puppeteer RECARREGA a página, e aí a
    // prova mediria uma carga nova, não a repintura. A marca na janela confirma que não houve recarga.
    await pagina.evaluate(() => { window.__semRecarga = true; });
    await pagina.setViewport({ ...VIEWPORT_CELULAR, width: 1600, height: 1000 });
    try { await pagina.waitForSelector('.diff-job-vista .diff-tabela-lado-a-lado', { timeout: 3000 }); }
    catch { problemas.push('cena 06: a vista do job não repintou lado a lado ao passar de 900 px'); }
    if (!(await pagina.evaluate(() => window.__semRecarga === true))) problemas.push('cena 06: a página RECARREGOU ao mudar a largura — a prova da repintura não vale');
  } finally { await contexto.close().catch(() => {}); }
}

async function cena07JobMergeado(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}#job=${encodeURIComponent(JOB_MERGEADO)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.diff-nota', { timeout: TETO_MS }); } catch {
      const tela = await pagina.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 300)).catch(() => '');
      problemas.push(`cena 07: .diff-nota não apareceu (a tela dizia: ${JSON.stringify(tela)})`);
      return;
    }
    const texto = await pagina.evaluate(() => document.querySelector('.diff-nota').textContent);
    if (!/está na|mergeado e limpo/i.test(texto)) problemas.push(`cena 07: a nota não diz "já está na" nem "mergeado e limpo" (achei "${texto}")`);
    await tirarPrint(pagina, '07-celular-job-mergeado.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

/** Entrada (a) — Pra revisar → job → "Ver mudanças" no rodapé → a diff do job NA MESMA PÁGINA (D96). */
async function cena08Revisar(navegador, base, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.goto(`${base}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('#btn-revisar', { timeout: TETO_MS }); } catch { problemas.push('cena 08: #btn-revisar não apareceu'); return; }
    await pagina.click('#btn-revisar');
    let cartao;
    try { cartao = await pagina.waitForSelector(`.rv-card[data-id="${JOB_OK}"]`, { timeout: TETO_MS }); }
    catch { problemas.push(`cena 08: o job ${JOB_OK} não apareceu em "Pra revisar" (precisa estar done/needs-review/needs-decision com algo fora da develop)`); return; }
    await cartao.click();
    try { await pagina.waitForSelector('.rv-rodape', { timeout: TETO_MS }); } catch { problemas.push('cena 08: .rv-rodape não apareceu'); return; }

    const btnDiff = await pagina.evaluateHandle(() => [...document.querySelectorAll('.rv-rodape button')].find((b) => b.textContent.includes('Ver mudanças')));
    const elDiff = btnDiff.asElement();
    if (!elDiff) { problemas.push('cena 08: nenhum botão "Ver mudanças" no rodapé'); return; }
    await elDiff.evaluate((b) => b.scrollIntoView({ block: 'center' }));
    await tirarPrint(pagina, '08-celular-revisar-botao.png', gerados, problemas);

    // `cockpitDentro.abrir` (D96) faz `history.replaceState` (a `volta`) ANTES do `location.assign` —
    // o `replaceState` já é uma navegação NO MESMO documento, e `waitForNavigation` pode resolver
    // nela, não na travessia real (medido: `pagina.url()` ainda na página de origem). `espera(800)`
    // absorve essa folga antes de qualquer leitura de URL (mesmo molde do `voltar` logo abaixo).
    await Promise.all([pagina.waitForNavigation({ waitUntil: 'domcontentloaded' }), elDiff.click()]);
    await espera(800);
    if (!pagina.url().includes(`#job=${JOB_OK}`)) problemas.push(`cena 08: a URL não tem #job=${JOB_OK} (achei ${pagina.url()})`);
    try { await pagina.waitForSelector('.diff-arquivo', { timeout: TETO_MS }); } catch { problemas.push('cena 08: a diff do job não mostrou .diff-arquivo'); }
    await Promise.all([pagina.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), pagina.goBack()]);
    try { await pagina.waitForSelector('.rv-rodape', { timeout: TETO_MS }); } catch { problemas.push('cena 08: voltar não devolveu a tela do job (.rv-rodape)'); return; }

    // Entrada (b) — painel do job (`abrirJob`) → `.btn-mudancas` visível.
    await pagina.click('.rv-rodape .btn-principal');
    try { await pagina.waitForSelector('.painel[data-tipo="job"]', { timeout: TETO_MS }); } catch { problemas.push('cena 08b: o painel do job não abriu'); return; }
    const visivel = await pagina.evaluate(() => {
      const btn = document.querySelector('.painel[data-tipo="job"] .btn-mudancas');
      return !!btn && !btn.hidden;
    });
    if (!visivel) problemas.push('cena 08b: .btn-mudancas não está visível (ou não existe) no painel do job');
    const posicao = await pagina.evaluate(() => {
      const p = document.querySelector('.painel[data-tipo="job"]');
      const b = p.querySelector('.btn-mudancas').getBoundingClientRect();
      const t = p.querySelector('.chat-identidade').getBoundingClientRect();
      return { botao: b.left, titulo: t.left };
    });
    if (!(posicao.botao > posicao.titulo)) problemas.push(`cena 08b: "Ver mudanças" fica DEPOIS do título, não o empurra (${JSON.stringify(posicao)})`);
    await tirarPrint(pagina, '08b-celular-painel-job.png', gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

/** Lateral com o botão "Commits" na vista, sem a lateral estourar. */
async function cenaLateral(navegador, base, nomeArq, gerados, problemas, resultado) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.goto(`${base}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('.lateral-acoes-grupo', { timeout: TETO_MS }); } catch { problemas.push(`${nomeArq}: .lateral-acoes-grupo não apareceu`); return; }
    const medidas = await pagina.evaluate(() => {
      const grupo = document.querySelector('.lateral-acoes-grupo');
      return grupo ? { scrollWidth: grupo.scrollWidth, clientWidth: grupo.clientWidth } : null;
    });
    if (!medidas) { problemas.push(`${nomeArq}: não medi .lateral-acoes-grupo`); return; }
    if (medidas.scrollWidth > medidas.clientWidth) problemas.push(`${nomeArq}: a lateral estourou (scrollWidth ${medidas.scrollWidth} > clientWidth ${medidas.clientWidth})`);
    if (resultado) resultado.larguraTopoLateral = medidas;
    await tirarPrint(pagina, nomeArq, gerados, problemas);
  } finally { await contexto.close().catch(() => {}); }
}

/** Prova sem PNG (V2): abrir um commit lá embaixo e voltar — a lista volta com o scrollTop de
 * antes (± 2 px) e SEM pedido novo. */
async function provaRolagem(navegador, base, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}#projeto=${encodeURIComponent(NOME_PROJETO)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForFunction(() => document.querySelectorAll('#diff-palco .diff-commit-item').length >= 10, { timeout: TETO_MS }); }
    catch { problemas.push('prova de rolagem: a lista não carregou'); return; }
    await pagina.evaluate(() => { document.getElementById('diff-raiz').scrollTop = 200; });
    await espera(150);
    const scrollAntes = await pagina.evaluate(() => document.getElementById('diff-raiz').scrollTop);

    let pedidosDeCommits = 0;
    // A LISTA (`/api/diff/commits?`) não pode ser pedida de novo ao voltar — painel de execução (Claude #3):
    // o filtro antigo (`/api/diff/commit?`) nunca casava este pedido e o assert passava vazio.
    pagina.on('request', (req) => { if (req.url().includes('/api/diff/commits?')) pedidosDeCommits += 1; });

    await pagina.evaluate(() => document.querySelectorAll('#diff-palco .diff-commit-item')[5].click());
    try { await pagina.waitForSelector('.diff-cabecalho', { timeout: TETO_MS }); } catch { problemas.push('prova de rolagem: o commit não abriu'); return; }
    const pedidosNoAbrir = pedidosDeCommits;

    await pagina.evaluate(() => history.back());
    try { await pagina.waitForFunction(() => document.querySelectorAll('#diff-palco .diff-commit-item').length >= 10, { timeout: TETO_MS }); }
    catch { problemas.push('prova de rolagem: a lista não voltou'); return; }
    await espera(200);
    const scrollDepois = await pagina.evaluate(() => document.getElementById('diff-raiz').scrollTop);
    if (Math.abs(scrollDepois - scrollAntes) > 2) problemas.push(`prova de rolagem: scrollTop mudou (antes ${scrollAntes}, depois ${scrollDepois})`);
    if (pedidosDeCommits !== pedidosNoAbrir) problemas.push(`prova de rolagem: pedido novo ao voltar (de commit: ${pedidosNoAbrir} → ${pedidosDeCommits})`);
  } finally { await contexto.close().catch(() => {}); }
}

/** Prova sem PNG (painel de execução, Codex #2): resposta ATRASADA de um commit não pode reabrir o
 * commit depois que o usuário já voltou pra lista (a lista volta do cache e o pedido em voo morre). */
async function provaCorrida(navegador, base, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.goto(`${base}/diff/?token=${TOKEN}#projeto=${encodeURIComponent(NOME_PROJETO)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForFunction(() => document.querySelectorAll('#diff-palco .diff-commit-item').length >= 3, { timeout: TETO_MS }); }
    catch { problemas.push('prova da corrida: a lista não carregou'); return; }
    await pagina.setRequestInterception(true);
    pagina.on('request', (req) => {
      if (req.url().includes('/api/diff/commit?')) setTimeout(() => req.continue().catch(() => {}), 1500);
      else req.continue().catch(() => {});
    });
    await pagina.evaluate(() => document.querySelectorAll('#diff-palco .diff-commit-item')[1].click());
    await espera(100);
    await pagina.evaluate(() => history.back());
    await espera(2500);
    const tela = await pagina.evaluate(() => ({
      hash: location.hash,
      lista: document.querySelectorAll('#diff-palco .diff-commit-item').length,
      commit: !!document.querySelector('#diff-palco .diff-cabecalho'),
    }));
    if (/commit=/.test(tela.hash) || tela.commit || tela.lista < 3) problemas.push(`prova da corrida: a resposta atrasada reabriu o commit depois do voltar (${JSON.stringify(tela)})`);
  } finally { await contexto.close().catch(() => {}); }
}

/** Prova sem PNG (painel de execução, os dois): lista de commits CORTADA (teto do log ou timeout)
 * diz isso na tela — `cortado` da lista é booleano, e o aviso do corte da diff não o entendia. */
async function provaListaCortada(navegador, base, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    await pagina.setRequestInterception(true);
    pagina.on('request', (req) => {
      if (req.url().includes('/api/diff/commits?')) {
        req.respond({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({
          projeto: 'demo', base: 'develop', topo: 'a'.repeat(40), mais: true, cortado: true,
          commits: [{ sha: 'a'.repeat(40), autor: 'Demo', data: '2026-10-19T00:00:00+00:00', assunto: 'um commit', merge: false, arquivos: 1, mais: 1, menos: 0 }],
        }) }).catch(() => {});
      } else if (req.url().includes('/api/diff/commit?')) {
        // pendurado de propósito: a volta tem de ser pelo cache da lista, não por um erro do commit
      } else req.continue().catch(() => {});
    });
    await pagina.goto(`${base}/diff/?token=${TOKEN}#projeto=${encodeURIComponent(NOME_PROJETO)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('#diff-palco .diff-commit-item', { timeout: TETO_MS }); } catch { problemas.push('prova da lista cortada: a lista não apareceu'); return; }
    const aviso = await pagina.evaluate(() => { const a = document.getElementById('diff-aviso'); return a && !a.hidden ? a.textContent : ''; });
    if (!/incompleta/i.test(aviso)) problemas.push(`prova da lista cortada: nenhum aviso de lista incompleta (achei ${JSON.stringify(aviso)})`);
    // Painel de execução R2 (os dois): voltar pra lista pelo CACHE não pode apagar o aviso.
    await pagina.evaluate(() => document.querySelector('#diff-palco .diff-commit-item').click());
    await espera(300);
    await pagina.evaluate(() => history.back());
    await espera(500);
    const avisoNaVolta = await pagina.evaluate(() => { const a = document.getElementById('diff-aviso'); return a && !a.hidden ? a.textContent : ''; });
    if (!/incompleta/i.test(avisoNaVolta)) problemas.push(`prova da lista cortada: o aviso sumiu na volta pela lista em cache (achei ${JSON.stringify(avisoNaVolta)})`);
  } finally { await contexto.close().catch(() => {}); }
}

// ─── servidor FILHO (molde `gate-grafo-fazer-hook.js`/`print-grafo-mapa.js`) ────────────────────

async function subirServidor(codigoDir, projetosDir, jobsDir, scratch, sufixo) {
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
    COCKPIT_TMUX_SOCKET: `print-diff-${process.pid}-${sufixo}`,
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

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-diff-'));
    const projetosDir = path.join(scratch, 'projetos');
    const repoFixture = path.join(projetosDir, NOME_PROJETO);
    fs.mkdirSync(repoFixture, { recursive: true });
    execFileSync('git', ['-C', repoFixture, 'init', '-q']);
    fs.mkdirSync(path.join(repoFixture, '.git', 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repoFixture, '.git', 'objects', 'info', 'alternates'), `${path.join(REPO_REAL, '.git', 'objects')}\n`);
    execFileSync('git', ['-C', repoFixture, 'fetch', '-q', '--no-tags', REPO_REAL, 'refs/heads/*:refs/heads/*']);

    const jobsDir = path.join(scratch, 'jobs');
    for (const id of [JOB_OK, JOB_MERGEADO]) {
      const destino = path.join(jobsDir, id);
      fs.mkdirSync(destino, { recursive: true });
      const meta = JSON.parse(fs.readFileSync(path.join(JOBS_REAIS, id, 'meta.json'), 'utf8'));
      meta.source_repo = repoFixture;
      fs.writeFileSync(path.join(destino, 'meta.json'), JSON.stringify(meta));
      fs.writeFileSync(path.join(destino, 'status.log'), `${new Date().toISOString()} done: print\n`);
    }

    const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      // ── servidor "depois" (código desta worktree) ──────────────────────────
      const servidorDepois = await subirServidor(CODIGO_DIR, projetosDir, jobsDir, scratch, 'depois');
      try {
        const base = `http://127.0.0.1:${PORTA}`;
        await cena01Lista(navegador, base, gerados, resultado.problemas);
        await cena0203CommitAberto(navegador, base, gerados, resultado.problemas);
        await cena04Merge(navegador, base, gerados, resultado.problemas);
        await cena05Desktop(navegador, base, gerados, resultado.problemas);
        await cena06JobOk(navegador, base, gerados, resultado.problemas);
        await cena07JobMergeado(navegador, base, gerados, resultado.problemas);
        await cena08Revisar(navegador, base, gerados, resultado.problemas);
        await cenaLateral(navegador, base, '09-celular-lateral-depois.png', gerados, resultado.problemas, resultado);
        await provaRolagem(navegador, base, resultado.problemas);
        await provaCorrida(navegador, base, resultado.problemas);
        await provaListaCortada(navegador, base, resultado.problemas);
      } finally {
        derrubar(servidorDepois);
      }

      // ── servidor "antes" (CODIGO_DIR opcional — só a lateral sem o botão Commits) ──
      if (CODIGO_DIR_ANTES) {
        const servidorAntes = await subirServidor(CODIGO_DIR_ANTES, projetosDir, jobsDir, scratch, 'antes');
        try {
          const base = `http://127.0.0.1:${PORTA}`;
          await cenaLateral(navegador, base, '10-celular-lateral-antes.png', gerados, resultado.problemas, null);
        } finally {
          derrubar(servidorAntes);
        }
      } else {
        console.log('  · CODIGO_DIR não informado — pulando 10-celular-lateral-antes.png');
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
