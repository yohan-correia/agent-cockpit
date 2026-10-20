#!/usr/bin/env node
'use strict';
// PRINT DO MAPA DO GRAFO EM FOCO (card `grafo-mapa-foco`, D94, sobre o D91) — mede o ANTES/DEPOIS em
// 390×844 (bytes baixados e tempo até a tela aparecer) e fotografa o foco (parte no meio, faixas,
// fios), a troca de foco, o nível 2 (pastas/arquivos em lista) e a ficha (nível 3, sobe de baixo),
// EXIGINDO o conteúdo de cada tela antes do obturador. Prova também: histórico (voltar = subir um
// degrau por vez, troca de foco nunca empilha), véu/Fechar/Esc fecham a ficha, entrada direta por
// link (`#camada&pasta&arquivo` e só `#arquivo=`), `prefers-reduced-motion` (zero animação, inclusive
// as em laço) e tema claro.
//
// #106: NENHUM nome de projeto real está escrito aqui — o projeto chega por env. A loja de origem só é
// LIDA (os dois arquivos são copiados pra um tmp; o mtime da origem é conferido antes e depois). O
// repositório do projeto nunca é aberto: o `PROJETOS_DIR` é um tmp com um `git init` vazio do mesmo nome.
//
// Sobe `server.js` FILHO (nunca `require`), ambiente FECHADO (molde de `print-grafo.js`/`gate-grafo-rota.js`):
// HOME (tmp), COCKPIT_JOBS_DIR, COCKPIT_MONITOR_DIR/_MS (A10, M-rede), COCKPIT_LIDAS_DIR, COCKPIT_LEITURAS_DIR,
// COCKPIT_PUSH_DIR, COCKPIT_VIGIA_MS=0, COCKPIT_DU_BIN/_DOCKER_BIN, COCKPIT_TMUX_SOCKET, COCKPIT_TOKEN de
// mentira (a URL abre com `?token=`, como o diálogo abre). O servidor só cai pelo PID exato, no fim.
//
// Uso:
//   SAIDA=<pasta nova> PROJETO=<nome> LOJA_ORIGEM=<pasta com knowledge-graph.json e meta.json> \
//   ARQUIVO_N3=<caminho de um arquivo do grafo, ENTRE OS 40 PRIMEIROS da pasta> \
//   PASTA_N2='<id da camada>|<pasta>' \
//   PUPPETEER_CORE=<pasta do puppeteer-core> CHROME_BIN=<executável do chrome> \
//   [ARQUIVO_MUITOS=<arquivo com mais de 60 "usado por">] \
//   [CODIGO_DIR=<raiz do server.js, padrão: este repo>] [PORTA=7974] [CENAS=antes,depois,niveis,extras] \
//     node testes/print-grafo-mapa.js
//
// Saída: 0 = PNGs e resultado.json gravados · 1 = cena reprovada (resultado.json sai mesmo assim) ·
// 2 = ambiente (env obrigatória faltando).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA || '';
const PROJETO = process.env.PROJETO || '';
const LOJA_ORIGEM = process.env.LOJA_ORIGEM || '';
const ARQUIVO_N3 = process.env.ARQUIVO_N3 || '';
const PASTA_N2 = process.env.PASTA_N2 || '';
const ARQUIVO_MUITOS = process.env.ARQUIVO_MUITOS || '';
const CODIGO_DIR = process.env.CODIGO_DIR || path.join(__dirname, '..');
const PORTA = process.env.PORTA ? Number(process.env.PORTA) : 7974;
const CENAS = new Set((process.env.CENAS || 'antes,depois,niveis,extras').split(',').map((s) => s.trim()).filter(Boolean));
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const TOKEN = 'print-mapa';
const TETO_ANTES_MS = 60000;
const TETO_DEPOIS_MS = 20000;
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

function ambienteFaltando(msg) { console.error(`🟡 ambiente indisponível: ${msg}`); process.exit(2); }
if (!SAIDA) ambienteFaltando('SAIDA é obrigatória (pasta nova dos PNGs).');
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(PROJETO)) ambienteFaltando('PROJETO é obrigatório e tem de seguir o formato de nome de pasta.');
if (!LOJA_ORIGEM || !fs.existsSync(path.join(LOJA_ORIGEM, 'knowledge-graph.json')) || !fs.existsSync(path.join(LOJA_ORIGEM, 'meta.json'))) {
  ambienteFaltando('LOJA_ORIGEM tem de ter knowledge-graph.json e meta.json.');
}
if (!ARQUIVO_N3) ambienteFaltando('ARQUIVO_N3 é obrigatório.');
const [CAMADA_N2, PASTA_N2_PASTA] = PASTA_N2.split('|');
if (!CAMADA_N2 || PASTA_N2_PASTA === undefined) ambienteFaltando("PASTA_N2 tem de ser '<camada>|<pasta>'.");
if (PORTA !== 7974) ambienteFaltando(`PORTA só aceita 7974 (achei ${PORTA}).`);
if (!PUPPETEER || !CHROME) ambienteFaltando('PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
let puppeteer;
try { puppeteer = require(PUPPETEER); } catch (e) { ambienteFaltando(`não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`); }
if (!fs.existsSync(CHROME)) ambienteFaltando('CHROME_BIN não existe.');
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
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── Medidas de rede por página (CDP) ────────────────────────────────────────

/** Soma `encodedDataLength` de tudo que a página baixou (headers + corpo, como a rede vê). */
async function medidorDeBytes(pagina) {
  const cdp = await pagina.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const estado = { bytes: 0, pedidos: 0 };
  cdp.on('Network.loadingFinished', (e) => { estado.bytes += e.encodedDataLength || 0; estado.pedidos += 1; });
  return estado;
}

/**
 * Espera a tela assentar (R1): só animação FINITA em curso é esperada (a animação EM LAÇO dos fios,
 * F8b, é infinita de propósito e nunca "acaba" — `esperarAssentar` contaria pra sempre e a foto saía
 * lenta/no meio do "pulo"). Depois, o `scrollTop` do(s) rolador(es) visível(is) parado em duas leituras
 * com 100 ms de intervalo (a rolagem suave do F8a não entra em `getAnimations()`).
 */
async function esperarAssentar(pagina) {
  await pagina.waitForFunction(() => document.getAnimations()
    .filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations !== Infinity).length === 0,
  { timeout: 5000 }).catch(() => {});
  const lerScroll = () => pagina.evaluate(() => {
    const raiz = document.getElementById('mapa-raiz');
    const folha = document.getElementById('mapa-folha');
    const folhaAberta = !!(folha && folha.classList.contains('aberta'));
    return { raiz: raiz ? raiz.scrollTop : 0, folha: folhaAberta ? folha.scrollTop : null };
  }).catch(() => ({ raiz: 0, folha: null }));
  const t0 = Date.now();
  let anterior = await lerScroll();
  for (;;) {
    await espera(100);
    const atual = await lerScroll();
    if (atual.raiz === anterior.raiz && atual.folha === anterior.folha) break;
    anterior = atual;
    if (Date.now() - t0 > 5000) break;
  }
  await espera(120);
}

async function novaPagina(navegador) {
  const contexto = await navegador.createBrowserContext();
  const pagina = await contexto.newPage();
  await pagina.setViewport(VIEWPORT);
  // O Chrome headless manda `navigator.language: en-US`; o mapa é conferido em pt-BR.
  await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* vale nesta página */ } });
  return { contexto, pagina };
}

/**
 * Vigia console/pageerror/respostas ≥ 400 de uma página (extraído do molde usado em toda cena nova).
 * `favicon.ico` 404 não conta (a casca não declara ícone). `ignorarErros(true)` suspende console/pageerror
 * durante uma janela em que um pedido é abortado DE PROPÓSITO (cena 10): o Chrome loga
 * "Failed to load resource: net::ERR_FAILED" daquele pedido como erro de console, e isso não é bug.
 */
function vigiar(pagina) {
  const estado = { erros: [], respostasRuins: [], pedacos: [], favicon404: false };
  let suspenso = false;
  estado.ignorarErros = (valor) => { suspenso = valor; };
  pagina.on('console', (m) => {
    if (m.type() !== 'error' || suspenso) return;
    estado.erros.push({ texto: m.text().slice(0, 200), url: (m.location() || {}).url || '' });
  });
  pagina.on('pageerror', (e) => { if (!suspenso) estado.erros.push({ texto: `PAGEERROR: ${String(e).slice(0, 200)}`, url: '' }); });
  pagina.on('response', async (r) => {
    const url = r.url();
    if (r.status() >= 400 && url.endsWith('/favicon.ico')) estado.favicon404 = true;
    if (r.status() >= 400 && !url.endsWith('/favicon.ico') && !suspenso) estado.respostasRuins.push(`${r.status()} ${url.replace(/token=[^&]*/, 'token=…')}`);
    if (url.includes('/api/grafos/') && url.includes('/mapa')) {
      try { estado.pedacos.push({ url: url.replace(/^https?:\/\/[^/]+/, ''), status: r.status(), bytes: (await r.buffer()).length }); } catch { /* corpo indisponível (abortado de propósito, p.ex.) */ }
    }
  });
  estado.problemas = () => {
    const errosDoMapa = estado.erros.filter((e) => !(estado.favicon404 && e.url.endsWith('/favicon.ico')));
    const probs = [];
    if (errosDoMapa.length) probs.push(`${errosDoMapa.length} erro(s) de console/pageerror: ${errosDoMapa.slice(0, 3).map((e) => `${e.texto} [${e.url}]`).join(' | ')}`);
    if (estado.respostasRuins.length) probs.push(`${estado.respostasRuins.length} resposta(s) >= 400: ${estado.respostasRuins.slice(0, 3).join(' | ')}`);
    return probs;
  };
  return estado;
}

/**
 * Intercepta o PRÓXIMO pedido cuja URL combina com `combina`, aplica `acao(req)` nele, e dá
 * `continue()` em TODOS os outros (sem isso a página pendura — #44/molde das cenas 10/11). Devolve
 * uma função que desliga a interceptação.
 */
async function interceptarUmPedido(pagina, combina, acao) {
  let usado = false;
  const handler = (req) => {
    const url = req.url();
    if (!usado && combina(url)) { usado = true; acao(req); return; }
    req.continue().catch(() => {});
  };
  await pagina.setRequestInterception(true);
  pagina.on('request', handler);
  return async () => {
    pagina.off('request', handler);
    await pagina.setRequestInterception(false).catch(() => {});
  };
}

// ─── Cenas ───────────────────────────────────────────────────────────────────

async function cenaAntes(navegador, base, resultado, gerados) {
  const { contexto, pagina } = await novaPagina(navegador);
  try {
    const rede = await medidorDeBytes(pagina);
    const t0 = Date.now();
    await pagina.goto(`${base}/grafo/${encodeURIComponent(PROJETO)}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let apareceu = false;
    try { await pagina.waitForSelector('.react-flow__node', { timeout: TETO_ANTES_MS }); apareceu = true; } catch { /* é a medida do ANTES */ }
    const ms = Date.now() - t0;
    await pagina.waitForNetworkIdle({ idleTime: 2000, timeout: 30000 }).catch(() => {});
    resultado.antes = { bytes: rede.bytes, pedidos: rede.pedidos, ms, apareceu };
    const arq = path.join(SAIDA, '01-antes-visao-completa.png');
    await pagina.screenshot({ path: arq });
    gerados.push(arq);
    console.log(`  · ANTES: ${(rede.bytes / 1e6).toFixed(2)} MB em ${rede.pedidos} pedidos, ${ms} ms até .react-flow__node (apareceu=${apareceu})`);
  } finally {
    await contexto.close().catch(() => {});
  }
}

/** Visíveis na viewport (topo e base dentro de [0, altura]). */
function contarVisiveis(pagina, seletor) {
  return pagina.evaluate((sel) => Array.from(document.querySelectorAll(sel)).filter((n) => {
    const r = n.getBoundingClientRect();
    return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
  }).length, seletor);
}

async function pushHash(pagina, estado) {
  await pagina.evaluate((e) => {
    const partes = [];
    for (const k of ['camada', 'pasta', 'arquivo']) if (e[k] !== undefined) partes.push(`${k}=${encodeURIComponent(e[k])}`);
    const passo = (history.state && history.state.passo) || 0;
    history.pushState({ passo: passo + 1 }, '', `#${partes.join('&')}`);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, estado);
}

async function voltar(pagina) {
  await pagina.evaluate(() => history.back());
  await espera(400);
}

async function cenaDepoisENiveis(navegador, base, resultado, gerados, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  const vig = vigiar(pagina);
  try {
    const rede = await medidorDeBytes(pagina);
    const t0 = Date.now();
    await pagina.goto(`${base}/mapa/${encodeURIComponent(PROJETO)}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('#mapa-foco .mapa-centro', { timeout: TETO_DEPOIS_MS }); } catch {
      // O que a tela mostrava no lugar (aviso de erro, "Carregando…", casca vazia) vai pro resultado.json.
      const tela = await pagina.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 300)).catch(() => '');
      problemas.push(`mapa: .mapa-centro não apareceu (a tela dizia: ${JSON.stringify(tela)})`);
      return;
    }
    const ms = Date.now() - t0;
    await pagina.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
    resultado.depois = { bytes: rede.bytes, pedidos: rede.pedidos, ms };
    console.log(`  · DEPOIS: ${(rede.bytes / 1e6).toFixed(3)} MB em ${rede.pedidos} pedidos, ${ms} ms até .mapa-foco .mapa-centro`);
    if (!CENAS.has('niveis')) return;

    const VIZ_VIS = await pagina.evaluate(() => (window.cockpitMapa || {}).VIZINHOS_VISIVEIS || 6);

    // ── nível 1 pela API (molde `:237-241`) ────────────────────────────────
    const n1Api = await pagina.evaluate(async (projeto, token) => {
      const r = await fetch(`../../api/grafos/${encodeURIComponent(projeto)}/mapa`, { headers: { authorization: `Bearer ${token}` } });
      return r.json().catch(() => null);
    }, PROJETO, TOKEN);
    if (!n1Api || !n1Api.camadas || !n1Api.camadas.length) { problemas.push('nível 1: a API não devolveu camadas'); return; }
    const vizPrincipal = await pagina.evaluate((lig, id) => window.cockpitMapa.vizinhosDe(lig, id), n1Api.ligacoes, n1Api.camadas[0].id);

    // 1. Foco inicial — nome do centro === camadas[0].nome.
    await esperarAssentar(pagina);
    const foco1 = await pagina.evaluate(() => {
      const centro = document.querySelector('#mapa-foco .mapa-centro');
      const r = centro ? centro.getBoundingClientRect() : null;
      const atual = document.querySelector('[aria-current="true"]');
      return {
        nomeCentro: ((document.querySelector('#mapa-foco .mapa-centro-nome')) || {}).textContent || '',
        dica: (document.getElementById('mapa-dica') || {}).textContent || '',
        explica: ((document.querySelector('#mapa-foco .mapa-centro-explica')) || {}).textContent || '',
        vizCima: document.querySelectorAll('#mapa-foco .mapa-faixa-cima .mapa-vizinho').length,
        vizBaixo: document.querySelectorAll('#mapa-foco .mapa-faixa-baixo .mapa-vizinho').length,
        temMais: !!document.querySelector('#mapa-foco .mapa-mais'),
        fios: document.querySelectorAll('#mapa-foco .mapa-fio').length,
        pilulas: document.querySelectorAll('#mapa-todas .mapa-pilula').length,
        currentCount: document.querySelectorAll('[aria-current="true"]').length,
        currentId: atual ? atual.dataset.id : null,
        completo: (document.getElementById('mapa-completo') || {}).textContent || '',
        centroBottom: r ? r.bottom : null,
      };
    });
    if (foco1.nomeCentro !== n1Api.camadas[0].nome) problemas.push(`foco inicial: centro "${foco1.nomeCentro}" (esperava "${n1Api.camadas[0].nome}", a maior)`);
    if (!foco1.dica.trim()) problemas.push('foco inicial: #mapa-dica vazia');
    if (!foco1.explica.trim()) problemas.push('foco inicial: .mapa-centro-explica vazia');
    const esperadoCima = Math.min(VIZ_VIS, vizPrincipal.usadaPor.length);
    const esperadoBaixo = Math.min(VIZ_VIS, vizPrincipal.usa.length);
    if (foco1.vizCima !== esperadoCima) problemas.push(`foco inicial: faixa de cima com ${foco1.vizCima} vizinhos (esperava min(${VIZ_VIS}, ${vizPrincipal.usadaPor.length}) = ${esperadoCima})`);
    if (foco1.vizBaixo !== esperadoBaixo) problemas.push(`foco inicial: faixa de baixo com ${foco1.vizBaixo} vizinhos (esperava ${esperadoBaixo})`);
    const deveriaTerMais = vizPrincipal.usadaPor.length > VIZ_VIS || vizPrincipal.usa.length > VIZ_VIS;
    if (foco1.temMais !== deveriaTerMais) problemas.push(`foco inicial: .mapa-mais ${foco1.temMais ? 'existe' : 'não existe'} (esperava ${deveriaTerMais})`);
    const fiosEsperados = (vizPrincipal.usadaPor.length ? 1 : 0) + (vizPrincipal.usa.length ? 1 : 0);
    if (foco1.fios !== fiosEsperados) problemas.push(`foco inicial: ${foco1.fios} .mapa-fio (esperava ${fiosEsperados})`);
    if (foco1.pilulas !== n1Api.camadas.length) problemas.push(`foco inicial: ${foco1.pilulas} .mapa-pilula (esperava ${n1Api.camadas.length})`);
    if (foco1.currentCount !== 1 || foco1.currentId !== n1Api.camadas[0].id) problemas.push(`foco inicial: aria-current (${foco1.currentCount}, id=${foco1.currentId}) — esperava 1 em ${n1Api.camadas[0].id}`);
    if (!foco1.completo.includes('MB')) problemas.push(`foco inicial: #mapa-completo sem "MB" (achei ${JSON.stringify(foco1.completo)})`);
    if (!(foco1.centroBottom !== null && foco1.centroBottom <= VIEWPORT.height)) problemas.push(`foco inicial: .mapa-centro fora da 1ª tela (bottom=${foco1.centroBottom}, altura=${VIEWPORT.height})`);
    if (problemas.length) return;
    const arq1 = path.join(SAIDA, '02-foco-inicial.png');
    await pagina.screenshot({ path: arq1 });
    gerados.push(arq1);

    // 1b. "+N mais" expande a faixa INTEIRA no lugar (F5) — só depois do PNG e do assert do centro.
    if (foco1.temMais) {
      // Pode haver um ".mapa-mais" em CADA faixa (cima e baixo) — os dois tocados, não só o 1º.
      await pagina.evaluate(() => { document.querySelectorAll('#mapa-foco .mapa-mais').forEach((b) => b.click()); });
      await espera(250);
      const expandido = await pagina.evaluate(() => ({
        vizCima: document.querySelectorAll('#mapa-foco .mapa-faixa-cima .mapa-vizinho').length,
        vizBaixo: document.querySelectorAll('#mapa-foco .mapa-faixa-baixo .mapa-vizinho').length,
      }));
      if (expandido.vizCima !== vizPrincipal.usadaPor.length || expandido.vizBaixo !== vizPrincipal.usa.length) {
        problemas.push(`"+N mais": depois do toque, cima=${expandido.vizCima}/${vizPrincipal.usadaPor.length} baixo=${expandido.vizBaixo}/${vizPrincipal.usa.length}`);
      } else {
        const arq1b = path.join(SAIDA, '02b-faixa-expandida.png');
        await pagina.screenshot({ path: arq1b });
        gerados.push(arq1b);
      }
      await pagina.reload({ waitUntil: 'domcontentloaded' });
      try { await pagina.waitForSelector('#mapa-foco .mapa-centro', { timeout: TETO_DEPOIS_MS }); } catch {
        problemas.push('depois do reload (pós "+N mais"), .mapa-centro não voltou'); return;
      }
      await esperarAssentar(pagina);
    }
    if (problemas.length) return;

    // 2. Foco trocado — troca NÃO empilha histórico (F3).
    const alvoVizinho = await pagina.evaluate(() => {
      const cima = document.querySelector('#mapa-foco .mapa-faixa-cima .mapa-vizinho');
      const baixo = document.querySelector('#mapa-foco .mapa-faixa-baixo .mapa-vizinho');
      const alvo = cima || baixo;
      return alvo ? { id: alvo.dataset.id, nome: ((alvo.querySelector('b')) || {}).textContent || '' } : null;
    });
    if (!alvoVizinho) {
      problemas.push('foco trocado: nenhum vizinho pra tocar (as duas faixas vazias)');
    } else {
      const hl = await pagina.evaluate(() => history.length);
      await pagina.evaluate(() => {
        const cima = document.querySelector('#mapa-foco .mapa-faixa-cima .mapa-vizinho');
        const baixo = document.querySelector('#mapa-foco .mapa-faixa-baixo .mapa-vizinho');
        (cima || baixo).click();
      });
      try {
        await pagina.waitForFunction((nome) => {
          const el = document.querySelector('#mapa-foco .mapa-centro-nome');
          return !!el && el.textContent === nome;
        }, { timeout: 5000 }, alvoVizinho.nome);
      } catch { problemas.push(`foco trocado: o centro não virou "${alvoVizinho.nome}"`); }
      if (!problemas.length) {
        const hl2 = await pagina.evaluate(() => history.length);
        const hashOk = await pagina.evaluate(() => location.hash.includes('foco='));
        const currentOk = await pagina.evaluate((id) => {
          const p = document.querySelector(`#mapa-todas .mapa-pilula[data-id="${CSS.escape(id)}"]`);
          return !!p && p.getAttribute('aria-current') === 'true';
        }, alvoVizinho.id);
        if (hl2 !== hl) problemas.push(`foco trocado: history.length mudou (${hl} → ${hl2}) — deveria ser replaceState, não push`);
        if (!hashOk) problemas.push('foco trocado: location.hash sem foco=');
        if (!currentOk) problemas.push(`foco trocado: aria-current não está na pílula de ${alvoVizinho.id}`);
        if (!problemas.length) {
          await esperarAssentar(pagina);
          const arq2 = path.join(SAIDA, '03-foco-trocado.png');
          await pagina.screenshot({ path: arq2 });
          gerados.push(arq2);
        }
      }
    }
    if (problemas.length) return;

    // 3. Nível 2 (parte) — toque na pílula da camada, depois "Ver o que tem dentro →".
    const camadaN2Obj = n1Api.camadas.find((c) => c.id === CAMADA_N2);
    if (!camadaN2Obj) { problemas.push(`nível 2: a camada ${CAMADA_N2} não existe no nível 1`); return; }
    const dicaAntes = await pagina.evaluate(() => (document.getElementById('mapa-dica') || {}).textContent || '');
    await pagina.evaluate((id) => {
      const p = document.querySelector(`#mapa-todas .mapa-pilula[data-id="${CSS.escape(id)}"]`);
      if (p) { p.scrollIntoView({ block: 'center' }); p.click(); }
    }, CAMADA_N2);
    try {
      await pagina.waitForFunction((nome) => {
        const el = document.querySelector('#mapa-foco .mapa-centro-nome');
        return !!el && el.textContent === nome;
      }, { timeout: 5000 }, camadaN2Obj.nome);
    } catch { problemas.push(`nível 2: o centro não virou "${camadaN2Obj.nome}" depois de tocar a pílula`); }
    if (!problemas.length) {
      await pagina.evaluate(() => { const b = document.querySelector('#mapa-foco .mapa-entrar'); if (b) b.click(); });
      try { await pagina.waitForSelector('#mapa-trilha .mapa-trilha-atual', { timeout: 10000 }); } catch {
        problemas.push('nível 2: a trilha não apareceu depois de "Ver o que tem dentro →"');
      }
    }
    if (problemas.length) return;
    await esperarAssentar(pagina);
    const n2tela = await pagina.evaluate(() => ({
      passo1: ((document.querySelector('#mapa-trilha .mapa-trilha-passo')) || {}).textContent || '',
      atual: ((document.querySelector('#mapa-trilha .mapa-trilha-atual')) || {}).textContent || '',
      pastas: document.querySelectorAll('#mapa-pastas .mapa-linha-pasta').length,
      larguraPrimeiraMini: (() => { const i = document.querySelector('#mapa-pastas .mapa-linha-pasta .mapa-mini i'); return i ? i.style.width : ''; })(),
      dica: (document.getElementById('mapa-dica') || {}).textContent || '',
    }));
    if (n2tela.passo1 !== 'Todas as partes') problemas.push(`nível 2: 1º passo da trilha "${n2tela.passo1}" (esperava "Todas as partes")`);
    if (n2tela.atual !== camadaN2Obj.nome) problemas.push(`nível 2: trilha atual "${n2tela.atual}" (esperava "${camadaN2Obj.nome}")`);
    if (n2tela.pastas < 1) problemas.push(`nível 2: ${n2tela.pastas} .mapa-linha-pasta (esperava ≥ 1)`);
    if (!n2tela.larguraPrimeiraMini || /^0(%|px)?$/.test(n2tela.larguraPrimeiraMini)) problemas.push(`nível 2: 1ª .mapa-mini i sem largura (achei "${n2tela.larguraPrimeiraMini}")`);
    if (n2tela.dica === dicaAntes) problemas.push('nível 2: #mapa-dica não mudou de texto');
    if (problemas.length) return;
    const arq3 = path.join(SAIDA, '04-nivel-2-parte.png');
    await pagina.screenshot({ path: arq3 });
    gerados.push(arq3);

    // 4. Pasta — se a raiz da camada ≠ a pasta pedida, entra nela (toque na linha ou pushHash).
    const n2RaizResp = await pagina.evaluate(async (projeto, camada, token) => {
      const r = await fetch(`../../api/grafos/${encodeURIComponent(projeto)}/mapa?camada=${encodeURIComponent(camada)}`, { headers: { authorization: `Bearer ${token}` } });
      return r.json().catch(() => null);
    }, PROJETO, CAMADA_N2, TOKEN);
    const raizDaCamada = n2RaizResp && n2RaizResp.camada ? n2RaizResp.camada.pasta : null;
    let pastaFoiEmpilhada = false;
    if (raizDaCamada !== PASTA_N2_PASTA) {
      const temLinha = await pagina.$(`#mapa-pastas .mapa-linha-pasta[data-pasta="${PASTA_N2_PASTA.replace(/"/g, '\\"')}"]`);
      if (temLinha) await temLinha.evaluate((b) => b.click());
      else await pushHash(pagina, { camada: CAMADA_N2, pasta: PASTA_N2_PASTA });
      pastaFoiEmpilhada = true;
      try {
        await pagina.waitForFunction((p) => location.hash.includes(encodeURIComponent(p)) && document.querySelectorAll('#mapa-arquivos .mapa-linha-arquivo').length >= 5,
          { timeout: 10000 }, PASTA_N2_PASTA);
      } catch { problemas.push(`nível 2: a pasta ${PASTA_N2_PASTA} não abriu com ≥ 5 .mapa-linha-arquivo`); }
    }
    if (problemas.length) return;
    await esperarAssentar(pagina);
    const arquivosNaPasta = await pagina.evaluate(() => document.querySelectorAll('#mapa-arquivos .mapa-linha-arquivo').length);
    if (arquivosNaPasta < 5) { problemas.push(`nível 2 (pasta): só ${arquivosNaPasta} .mapa-linha-arquivo (esperava ≥ 5)`); return; }
    const arq4 = path.join(SAIDA, '05-nivel-2-pasta.png');
    await pagina.screenshot({ path: arq4 });
    gerados.push(arq4);

    await pagina.evaluate(() => { const sec = document.getElementById('mapa-arquivos-secao'); if (sec) sec.scrollIntoView({ block: 'start' }); });
    await espera(200);
    const visiveis4b = await contarVisiveis(pagina, '#mapa-arquivos .mapa-linha-arquivo');
    if (visiveis4b < 5) { problemas.push(`nível 2 (pasta): só ${visiveis4b} .mapa-linha-arquivo visíveis com a seção no topo (esperava ≥ 5)`); return; }
    const arq4b = path.join(SAIDA, '05b-nivel-2-arquivos.png');
    await pagina.screenshot({ path: arq4b });
    gerados.push(arq4b);

    await pagina.mouse.move(195, 600);
    let ultimoArquivoNaVista = false;
    for (let i = 0; i < 12 && !ultimoArquivoNaVista; i += 1) {
      await pagina.mouse.wheel({ deltaY: 4000 });
      await espera(250);
      ultimoArquivoNaVista = await pagina.evaluate(() => {
        const itens = document.querySelectorAll('#mapa-arquivos .mapa-linha-arquivo');
        const u = itens[itens.length - 1];
        if (!u) return false;
        const r = u.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
    }
    if (!ultimoArquivoNaVista) { problemas.push('nível 2 (pasta): a rolagem não trouxe o último .mapa-linha-arquivo pra vista'); return; }
    const arq4c = path.join(SAIDA, '05c-nivel-2-fim-da-lista.png');
    await pagina.screenshot({ path: arq4c });
    gerados.push(arq4c);

    // 5. Ficha — toque no arquivo pedido (tem de estar entre os 40 primeiros da pasta: sem pushHash
    // de fallback, o toque é quem cria `abridorDaFicha`, necessário pro foco devolvido na volta 1).
    const itemArquivo = await pagina.$(`#mapa-arquivos .mapa-linha-arquivo[data-caminho="${ARQUIVO_N3.replace(/"/g, '\\"')}"]`);
    if (!itemArquivo) { problemas.push('ARQUIVO_N3 fora dos 40 primeiros da pasta — escolha outro'); return; }
    await itemArquivo.evaluate((b) => b.scrollIntoView({ block: 'center' }));
    await itemArquivo.click();
    try { await pagina.waitForSelector('#mapa-folha.aberta', { timeout: 10000 }); } catch {
      problemas.push(`ficha: #mapa-folha.aberta não apareceu depois de tocar ${ARQUIVO_N3}`); return;
    }
    await esperarAssentar(pagina);
    const ficha = await pagina.evaluate(() => {
      const folha = document.getElementById('mapa-folha');
      const ativo = document.activeElement;
      return {
        titulo: (document.getElementById('mapa-folha-titulo') || {}).textContent || '',
        caixas: document.querySelectorAll('#mapa-folha .mapa-caixa').length,
        usadoPorItens: document.querySelectorAll('#mapa-folha [data-secao="usadoPor"] .mapa-folha-item').length,
        raizInert: document.getElementById('mapa-raiz').hasAttribute('inert'),
        topoInert: document.getElementById('mapa-topo').hasAttribute('inert'),
        veuOpacidade: parseFloat(getComputedStyle(document.getElementById('mapa-veu')).opacity || '0'),
        focoNaFicha: !!(folha && ativo && folha.contains(ativo)),
        arquivosNoDom: !!document.getElementById('mapa-arquivos'),
      };
    });
    const nomeArquivo = ARQUIVO_N3.split('/').pop();
    if (!ficha.titulo.includes(nomeArquivo)) problemas.push(`ficha: título "${ficha.titulo}" não contém "${nomeArquivo}"`);
    if (ficha.caixas !== 2) problemas.push(`ficha: ${ficha.caixas} .mapa-caixa (esperava 2)`);
    if (ficha.usadoPorItens < 1) problemas.push('ficha: [data-secao="usadoPor"] sem item');
    if (!ficha.raizInert || !ficha.topoInert) problemas.push(`ficha: #mapa-raiz/#mapa-topo não ficaram inert (achei ${JSON.stringify(ficha)})`);
    if (!(ficha.veuOpacidade > 0)) problemas.push(`ficha: opacidade do véu ${ficha.veuOpacidade} (esperava > 0)`);
    if (!ficha.focoNaFicha) problemas.push('ficha: document.activeElement não está dentro de #mapa-folha');
    if (!ficha.arquivosNoDom) problemas.push('ficha: #mapa-arquivos saiu do DOM (deveria continuar — é o fundo)');
    if (problemas.length) return;
    const arq5 = path.join(SAIDA, '06-ficha.png');
    await pagina.screenshot({ path: arq5 });
    gerados.push(arq5);

    await pagina.mouse.move(195, 700);
    let ultimoItemFichaNaVista = false;
    for (let i = 0; i < 20 && !ultimoItemFichaNaVista; i += 1) {
      await pagina.mouse.wheel({ deltaY: 4000 });
      await espera(250);
      ultimoItemFichaNaVista = await pagina.evaluate(() => {
        const itens = document.querySelectorAll('#mapa-folha .mapa-folha-item');
        const u = itens[itens.length - 1];
        if (!u) return false;
        const r = u.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
    }
    if (!ultimoItemFichaNaVista) { problemas.push('ficha: a rolagem não trouxe o último .mapa-folha-item pra vista'); return; }
    const arq5b = path.join(SAIDA, '06b-ficha-fim.png');
    await pagina.screenshot({ path: arq5b });
    gerados.push(arq5b);

    // 6. Voltas (história, M10): ficha → pasta → raiz da camada (se empilhada) → nível 1 (MESMO foco).
    resultado.historico = { entradas: pastaFoiEmpilhada ? 3 : 2, passos: [] };
    await voltar(pagina);
    try { await pagina.waitForFunction(() => !document.getElementById('mapa-folha').classList.contains('aberta'), { timeout: 5000 }); } catch { /* confere abaixo mesmo assim */ }
    const v1 = await pagina.evaluate((caminho) => ({
      hash: location.hash,
      semArquivo: !location.hash.includes('arquivo='),
      comPasta: location.hash.includes('pasta='),
      raizInert: document.getElementById('mapa-raiz').hasAttribute('inert'),
      focoDevolvido: !!(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.caminho === caminho),
    }), ARQUIVO_N3);
    resultado.historico.passos.push(v1);
    if (!v1.semArquivo || !v1.comPasta || v1.raizInert || !v1.focoDevolvido) problemas.push(`voltar #1: esperava o nível 2 na pasta com o foco devolvido (${JSON.stringify(v1)})`);

    if (pastaFoiEmpilhada) {
      await voltar(pagina);
      try { await pagina.waitForFunction(() => document.querySelectorAll('#mapa-trilha .mapa-trilha-passo').length === 1, { timeout: 5000 }); } catch { /* confere abaixo */ }
      const v2 = await pagina.evaluate((nome) => ({
        hash: location.hash,
        passos: document.querySelectorAll('#mapa-trilha .mapa-trilha-passo').length,
        atual: ((document.querySelector('#mapa-trilha .mapa-trilha-atual')) || {}).textContent || '',
      }), camadaN2Obj.nome);
      resultado.historico.passos.push(v2);
      if (v2.passos !== 1 || v2.atual !== camadaN2Obj.nome) problemas.push(`voltar #2: esperava a raiz da camada (${JSON.stringify(v2)})`);
    }

    await voltar(pagina);
    try { await pagina.waitForFunction(() => !!document.querySelector('#mapa-foco .mapa-centro') && !document.getElementById('mapa-pastas'), { timeout: 5000 }); } catch { /* confere abaixo */ }
    const vf = await pagina.evaluate((nome) => ({
      hash: location.hash,
      centro: ((document.querySelector('#mapa-foco .mapa-centro-nome')) || {}).textContent || '',
      temFoco: location.hash.includes('foco='),
      voltarEscondido: (() => { const b = document.getElementById('mapa-voltar'); return !b || b.hidden; })(),
    }), camadaN2Obj.nome);
    resultado.historico.passos.push(vf);
    if (vf.centro !== camadaN2Obj.nome || !vf.temFoco || !vf.voltarEscondido) problemas.push(`voltar final: esperava o nível 1 com o MESMO foco de antes de entrar (${JSON.stringify(vf)})`);

    // 7. Véu, botão Fechar e Esc — todos fecham a ficha (F10).
    async function abrirEFechar(mecanismo, fechar) {
      await pushHash(pagina, { camada: CAMADA_N2, pasta: PASTA_N2_PASTA, arquivo: ARQUIVO_N3 });
      try { await pagina.waitForSelector('#mapa-folha.aberta', { timeout: 5000 }); } catch {
        problemas.push(`fechar (${mecanismo}): a ficha não abriu`); return;
      }
      await fechar();
      try { await pagina.waitForFunction(() => !document.getElementById('mapa-folha').classList.contains('aberta'), { timeout: 5000 }); } catch {
        problemas.push(`fechar (${mecanismo}): a ficha não fechou`); return;
      }
      const semArquivo = await pagina.evaluate(() => !location.hash.includes('arquivo='));
      if (!semArquivo) problemas.push(`fechar (${mecanismo}): hash ainda tem arquivo= depois de fechar`);
    }
    await abrirEFechar('véu', async () => { await pagina.mouse.click(195, 60); });
    await abrirEFechar('botão Fechar', async () => { await pagina.evaluate(() => { const b = document.querySelector('#mapa-folha .mapa-folha-fechar'); if (b) b.click(); }); });
    await abrirEFechar('Esc', async () => { await pagina.keyboard.press('Escape'); });

    // 7b. Um Esc volta UM degrau só (não dois — o listener não pode estar duplicado), e o degrau é a
    // PASTA: a cena parte da pasta empilhada, não do nível 1 (painel de execução, Codex #3 — partindo do
    // nível 1, voltar ao foco também passava em "sem arquivo=").
    await pushHash(pagina, { camada: CAMADA_N2, pasta: PASTA_N2_PASTA });
    try {
      await pagina.waitForFunction(() => document.querySelectorAll('#mapa-arquivos .mapa-linha-arquivo').length >= 5, { timeout: 10000 });
      const hashDaPasta = await pagina.evaluate(() => location.hash);
      await pushHash(pagina, { camada: CAMADA_N2, pasta: PASTA_N2_PASTA, arquivo: ARQUIVO_N3 });
      await pagina.waitForSelector('#mapa-folha.aberta', { timeout: 5000 });
      const antes = await pagina.evaluate(() => ({ passo: (history.state || {}).passo, hash: location.hash }));
      await pagina.keyboard.press('Escape');
      await pagina.waitForFunction(() => !document.getElementById('mapa-folha').classList.contains('aberta'), { timeout: 5000 });
      const depois = await pagina.evaluate(() => ({
        passo: (history.state || {}).passo, hash: location.hash,
        lista: document.querySelectorAll('#mapa-arquivos .mapa-linha-arquivo').length,
      }));
      if (depois.passo !== antes.passo - 1) problemas.push(`Esc voltou ${antes.passo - depois.passo} degrau(s) (esperava 1) — antes=${JSON.stringify(antes)} depois=${JSON.stringify(depois)}`);
      if (depois.hash !== hashDaPasta || depois.lista < 5) problemas.push(`Esc: esperava a pasta (${hashDaPasta}) com a lista na tela (achei ${JSON.stringify(depois)})`);
    } catch { problemas.push('Esc único: não consegui medir o degrau (pasta/ficha não abriu ou não fechou)'); }

    // 8. Mostrar todos na ficha, autenticado (Codex #5 do painel) — só se ARQUIVO_MUITOS vier.
    if (ARQUIVO_MUITOS) {
      try {
        await pushHash(pagina, { arquivo: ARQUIVO_MUITOS });
        await pagina.waitForSelector('#mapa-folha.aberta', { timeout: 10000 });
        const btn = await pagina.$('#mapa-folha [data-secao="usadoPor"] .mapa-mostrar-todos');
        if (!btn) {
          problemas.push(`ARQUIVO_MUITOS (${ARQUIVO_MUITOS}): sem botão "mostrar todos" em usadoPor`);
        } else {
          const totalApi = await pagina.evaluate(async (projeto, caminho, token) => {
            const r = await fetch(`../../api/grafos/${encodeURIComponent(projeto)}/mapa?arquivo=${encodeURIComponent(caminho)}&completo=1`, { headers: { authorization: `Bearer ${token}` } });
            const j = await r.json().catch(() => null);
            return j ? j.usadoPor.total : null;
          }, PROJETO, ARQUIVO_MUITOS, TOKEN);
          // Pelo TECLADO (focus + Enter): quem expande pelo teclado não pode perder o foco pro <body>
          // quando a ficha é remontada (painel de execução, Codex #2).
          await btn.evaluate((b) => b.focus());
          await pagina.keyboard.press('Enter');
          await espera(300);
          const depoisDeExpandir = await pagina.evaluate(() => ({
            contagem: document.querySelectorAll('#mapa-folha [data-secao="usadoPor"] .mapa-folha-item').length,
            focoNaFicha: !!(document.activeElement && document.getElementById('mapa-folha').contains(document.activeElement)),
            focoEm: document.activeElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : '',
          }));
          if (depoisDeExpandir.contagem !== totalApi) problemas.push(`ARQUIVO_MUITOS: ${depoisDeExpandir.contagem} itens depois de "mostrar todos" (esperava ${totalApi} — a API com completo=1)`);
          if (!depoisDeExpandir.focoNaFicha) problemas.push(`ARQUIVO_MUITOS: o foco do teclado saiu da ficha depois de "mostrar todos" (foco em ${depoisDeExpandir.focoEm})`);
        }

        // 8b. Corrida: abrir OUTRO arquivo pela ficha e, antes da resposta, tocar "mostrar todos" da ficha
        // velha. O fim tem de ser a ficha do arquivo NOVO, com o hash dele (painel de execução, Codex #1:
        // o "mostrar todos" invalidava a navegação pendente e a tela ficava no arquivo velho com o hash
        // do novo).
        await pushHash(pagina, { arquivo: ARQUIVO_MUITOS });
        await pagina.waitForFunction((n) => (document.getElementById('mapa-folha-titulo') || {}).textContent.includes(n)
          && !!document.querySelector('#mapa-folha [data-secao="usadoPor"] .mapa-mostrar-todos'), { timeout: 10000 }, path.posix.basename(ARQUIVO_MUITOS));
        const alvoB = await pagina.evaluate(() => {
          const b = document.querySelector('#mapa-folha [data-secao="usadoPor"] .mapa-folha-item');
          return b ? b.dataset.caminho : null;
        });
        if (!alvoB) {
          problemas.push('corrida da ficha: sem item em "Quem usa ele" pra abrir');
        } else {
          let segurado = false;
          const segurar = (req) => {
            const u = req.url();
            if (!segurado && u.includes('/mapa?arquivo=') && !u.includes('completo=1')) {
              segurado = true;
              setTimeout(() => req.continue().catch(() => {}), 1500);
              return;
            }
            req.continue().catch(() => {});
          };
          await pagina.setRequestInterception(true);
          pagina.on('request', segurar);
          try {
            await pagina.evaluate((c) => { const b = document.querySelector(`#mapa-folha .mapa-folha-item[data-caminho="${CSS.escape(c)}"]`); if (b) b.click(); }, alvoB);
            await espera(100);
            await pagina.evaluate(() => { const b = document.querySelector('#mapa-folha [data-secao="usadoPor"] .mapa-mostrar-todos'); if (b) b.click(); });
            await espera(2500);
          } finally {
            pagina.off('request', segurar);
            await pagina.setRequestInterception(false);
          }
          const fim = await pagina.evaluate(() => ({
            hash: location.hash,
            titulo: (document.getElementById('mapa-folha-titulo') || {}).textContent || '',
          }));
          const hashTemB = fim.hash.includes(`arquivo=${encodeURIComponent(alvoB)}`);
          if (!hashTemB || !fim.titulo.includes(path.posix.basename(alvoB))) {
            problemas.push(`corrida da ficha: esperava a ficha de ${alvoB} com o hash dela (achei ${JSON.stringify(fim)})`);
          }
          resultado.corridaDaFicha = { alvo: alvoB, ...fim };
        }
        resultado.mostrarTodos = 'medida';
      } catch { problemas.push(`ARQUIVO_MUITOS (${ARQUIVO_MUITOS}): a ficha não abriu`); }
    } else {
      resultado.mostrarTodos = 'pulada';
    }

    // 9. Erro no meio não apaga o fundo pra sempre (Codex #7 do painel).
    await pushHash(pagina, { camada: CAMADA_N2, pasta: PASTA_N2_PASTA });
    try { await pagina.waitForFunction(() => document.querySelectorAll('#mapa-arquivos .mapa-linha-arquivo').length >= 5 && !document.getElementById('mapa-folha').classList.contains('aberta'), { timeout: 10000 }); } catch {
      problemas.push('erro no meio: não consegui voltar pra pasta (com a ficha fechada) antes do teste');
    }
    {
      vig.ignorarErros(true);
      const pararIntercepcao = await interceptarUmPedido(pagina, (url) => url.includes('arquivo='), (req) => { req.abort().catch(() => {}); });
      await pushHash(pagina, { camada: CAMADA_N2, pasta: PASTA_N2_PASTA, arquivo: ARQUIVO_N3 });
      await espera(600);
      const avisoErro = await pagina.evaluate(() => (document.getElementById('mapa-aviso') || {}).textContent || '');
      await pararIntercepcao();
      vig.ignorarErros(false);
      if (!avisoErro.trim()) problemas.push('erro no meio: nenhum aviso de erro apareceu depois do pedido abortado');
      await voltar(pagina);
      try { await pagina.waitForFunction(() => document.querySelectorAll('#mapa-arquivos .mapa-linha-arquivo').length >= 5, { timeout: 10000 }); } catch {
        problemas.push('erro no meio: depois do history.back(), a lista de arquivos não voltou (o fundo ficou vazio pra sempre)');
      }
    }

    // 10. Trocar o foco cancela a entrada pendente (Codex #1 da rodada 2).
    await pushHash(pagina, {});
    try { await pagina.waitForSelector('#mapa-foco .mapa-centro', { timeout: 10000 }); } catch {
      problemas.push('corrida do foco: não consegui voltar ao nível 1 antes do teste');
    }
    {
      const focoAtualId = n1Api.camadas[0].id;
      const outraCamada = n1Api.camadas.find((c) => c.id !== focoAtualId);
      if (!outraCamada) {
        problemas.push('corrida do foco: só existe uma camada — não dá pra tocar "outra"');
      } else {
        const pararIntercepcao2 = await interceptarUmPedido(pagina, (url) => url.includes('camada='), (req) => { setTimeout(() => { req.continue().catch(() => {}); }, 1500); });
        await pagina.evaluate(() => { const b = document.querySelector('#mapa-foco .mapa-entrar'); if (b) b.click(); });
        await espera(200);
        await pagina.evaluate((id) => { const p = document.querySelector(`#mapa-todas .mapa-pilula[data-id="${CSS.escape(id)}"]`); if (p) p.click(); }, outraCamada.id);
        await espera(2500);
        const corrida = await pagina.evaluate(() => ({
          nomeCentro: ((document.querySelector('#mapa-foco .mapa-centro-nome')) || {}).textContent || '',
          temPastas: !!document.getElementById('mapa-pastas'),
          temArquivos: !!document.getElementById('mapa-arquivos'),
        }));
        await pararIntercepcao2();
        if (corrida.nomeCentro !== outraCamada.nome || corrida.temPastas || corrida.temArquivos) {
          problemas.push(`corrida do foco: a resposta atrasada de "entrar" vazou pro nível 2 (${JSON.stringify(corrida)}, esperava centro="${outraCamada.nome}" sem nível 2)`);
        }
      }
    }
  } finally {
    resultado.pedacos = vig.pedacos;
    problemas.push(...vig.problemas());
    await contexto.close().catch(() => {});
  }
}

// ─── Cenas extras (página própria cada uma) ──────────────────────────────────

async function cenaLinkDireto(navegador, base, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  const vig = vigiar(pagina);
  try {
    const url = `${base}/mapa/${encodeURIComponent(PROJETO)}/?token=${TOKEN}#camada=${encodeURIComponent(CAMADA_N2)}&pasta=${encodeURIComponent(PASTA_N2_PASTA)}&arquivo=${encodeURIComponent(ARQUIVO_N3)}`;
    await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('#mapa-folha.aberta', { timeout: TETO_DEPOIS_MS }); } catch {
      problemas.push('link direto (#camada&pasta&arquivo): a ficha não abriu'); return;
    }
    await esperarAssentar(pagina);
    await pagina.evaluate(() => history.back());
    await espera(600);
    const depois = await pagina.evaluate(() => ({
      fichaAberta: document.getElementById('mapa-folha').classList.contains('aberta'),
      pathname: location.pathname,
      temArquivos: !!document.getElementById('mapa-arquivos'),
      hash: location.hash,
    }));
    if (depois.fichaAberta) problemas.push('link direto: o voltar nativo não fechou a ficha (saiu do mapa)');
    if (!depois.pathname.includes('/mapa/')) problemas.push(`link direto: pathname "${depois.pathname}" perdeu /mapa/`);
    if (!depois.temArquivos) problemas.push('link direto: #mapa-arquivos sumiu depois de fechar (o fundo foi perdido)');
    if (!depois.hash.includes('camada=') || !depois.hash.includes('pasta=')) problemas.push(`link direto: hash sem camada=/pasta= (achei ${depois.hash})`);
  } catch (e) {
    problemas.push(`link direto — estourou: ${String(e && e.message).slice(0, 300)}`);
  } finally {
    problemas.push(...vig.problemas());
    await contexto.close().catch(() => {});
  }
}

async function cenaLinkSoArquivo(navegador, base, problemas, gerados) {
  const { contexto, pagina } = await novaPagina(navegador);
  const vig = vigiar(pagina);
  try {
    await pagina.goto(`${base}/mapa/${encodeURIComponent(PROJETO)}/?token=${TOKEN}#arquivo=${encodeURIComponent(ARQUIVO_N3)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('#mapa-folha.aberta', { timeout: TETO_DEPOIS_MS }); } catch {
      problemas.push('link só arquivo (#arquivo=): a ficha não abriu'); return;
    }
    await esperarAssentar(pagina);
    const n3Api = await pagina.evaluate(async (projeto, caminho, token) => {
      const r = await fetch(`../../api/grafos/${encodeURIComponent(projeto)}/mapa?arquivo=${encodeURIComponent(caminho)}`, { headers: { authorization: `Bearer ${token}` } });
      return r.json().catch(() => null);
    }, PROJETO, ARQUIVO_N3, TOKEN);
    if (!n3Api || !n3Api.arquivo) { problemas.push('link só arquivo: a API não devolveu o arquivo'); return; }
    await pagina.evaluate(() => history.back());
    await espera(600);
    const depois = await pagina.evaluate((caminho) => ({
      fichaAberta: document.getElementById('mapa-folha').classList.contains('aberta'),
      hash: location.hash,
      temArquivo: !!document.querySelector(`#mapa-arquivos .mapa-linha-arquivo[data-caminho="${CSS.escape(caminho)}"]`),
    }), ARQUIVO_N3);
    if (depois.fichaAberta) problemas.push('link só arquivo: o voltar nativo não fechou a ficha');
    const camadaEsperada = n3Api.arquivo.camada.id;
    const pastaEsperada = n3Api.arquivo.pasta;
    if (!depois.hash.includes(`camada=${encodeURIComponent(camadaEsperada)}`)) problemas.push(`link só arquivo: hash sem camada=${camadaEsperada} (achei ${depois.hash})`);
    if (!depois.hash.includes(`pasta=${encodeURIComponent(pastaEsperada)}`)) problemas.push(`link só arquivo: hash sem pasta=${pastaEsperada} (achei ${depois.hash})`);
    if (!depois.temArquivo) problemas.push('link só arquivo: #mapa-arquivos não contém o arquivo depois de fechar');
    if (problemas.length) return;
    const arq = path.join(SAIDA, '07-link-so-arquivo-fechado.png');
    await pagina.screenshot({ path: arq });
    gerados.push(arq);
  } catch (e) {
    problemas.push(`link só arquivo — estourou: ${String(e && e.message).slice(0, 300)}`);
  } finally {
    problemas.push(...vig.problemas());
    await contexto.close().catch(() => {});
  }
}

async function cenaMovimentoReduzido(navegador, base, problemas) {
  const { contexto, pagina } = await novaPagina(navegador);
  const vig = vigiar(pagina);
  try {
    await pagina.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await pagina.goto(`${base}/mapa/${encodeURIComponent(PROJETO)}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('#mapa-foco .mapa-centro', { timeout: TETO_DEPOIS_MS }); } catch {
      problemas.push('reduced-motion: .mapa-centro não apareceu'); return;
    }
    await pagina.evaluate(() => {
      const pilulas = document.querySelectorAll('#mapa-todas .mapa-pilula');
      const ultima = pilulas[pilulas.length - 1];
      if (ultima) ultima.scrollIntoView({ block: 'center' });
    });
    await pagina.evaluate(() => {
      const pilulas = document.querySelectorAll('#mapa-todas .mapa-pilula');
      const ultima = pilulas[pilulas.length - 1];
      if (ultima) ultima.click();
    });
    await espera(50);
    const depois = await pagina.evaluate(() => ({
      scrollTop: (document.getElementById('mapa-raiz') || {}).scrollTop,
      animando: document.getAnimations().filter((a) => a.playState === 'running').length,
    }));
    if (depois.scrollTop !== 0) problemas.push(`reduced-motion: scrollTop ${depois.scrollTop} em ≤ 50 ms (esperava 0 — salto instantâneo)`);
    if (depois.animando !== 0) problemas.push(`reduced-motion: ${depois.animando} animação(ões) ainda rodando (inclusive as em laço — F8b)`);
  } catch (e) {
    problemas.push(`reduced-motion — estourou: ${String(e && e.message).slice(0, 300)}`);
  } finally {
    problemas.push(...vig.problemas());
    await contexto.close().catch(() => {});
  }
}

async function cenaTemaClaro(navegador, base, problemas, gerados) {
  const { contexto, pagina } = await novaPagina(navegador);
  const vig = vigiar(pagina);
  try {
    await pagina.evaluateOnNewDocument(() => {
      try { localStorage.setItem('cockpit-tema', 'catppuccin-latte'); } catch { /* vale nesta página */ }
    });
    await pagina.goto(`${base}/mapa/${encodeURIComponent(PROJETO)}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('#mapa-foco .mapa-centro', { timeout: TETO_DEPOIS_MS }); } catch {
      problemas.push('tema claro: .mapa-centro não apareceu'); return;
    }
    await esperarAssentar(pagina);
    const tema = await pagina.evaluate(() => document.documentElement.dataset.tema);
    if (tema !== 'catppuccin-latte') problemas.push(`tema claro: data-tema="${tema}" (esperava catppuccin-latte)`);
    const arq = path.join(SAIDA, '08-foco-tema-claro.png');
    await pagina.screenshot({ path: arq });
    gerados.push(arq);
  } catch (e) {
    problemas.push(`tema claro — estourou: ${String(e && e.message).slice(0, 300)}`);
  } finally {
    problemas.push(...vig.problemas());
    await contexto.close().catch(() => {});
  }
}

/**
 * Tema ESCURO (decisão de produto 4: "visual escuro como a maquete"). O Chrome headless anuncia
 * `prefers-color-scheme: light`, então TODAS as outras cenas saem no tema claro do cockpit — sem esta
 * cena, nenhum PNG mostrava o visual que o dono pediu (conferência do orquestrador, 18/10). Sem
 * `data-tema`, o cockpit segue o aparelho: aqui o aparelho diz "escuro". Exige o fundo escuro de
 * verdade (luminância do `body`) antes de cada foto: foco, nível 2 e ficha.
 */
async function cenaTemaEscuro(navegador, base, problemas, gerados) {
  const { contexto, pagina } = await novaPagina(navegador);
  const vig = vigiar(pagina);
  const luminanciaDoFundo = () => pagina.evaluate(() => {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g) || ['255', '255', '255'];
    const [r, g, b] = m.slice(0, 3).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });
  const fotografar = async (nomeArq) => {
    await esperarAssentar(pagina);
    const lum = await luminanciaDoFundo();
    if (lum > 0.2) { problemas.push(`tema escuro: fundo claro demais em ${nomeArq} (luminância ${lum.toFixed(2)})`); return false; }
    const arq = path.join(SAIDA, nomeArq);
    await pagina.screenshot({ path: arq });
    gerados.push(arq);
    return true;
  };
  try {
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await pagina.goto(`${base}/mapa/${encodeURIComponent(PROJETO)}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await pagina.waitForSelector('#mapa-foco .mapa-centro', { timeout: TETO_DEPOIS_MS }); } catch {
      problemas.push('tema escuro: .mapa-centro não apareceu'); return;
    }
    if (!await fotografar('09-foco-tema-escuro.png')) return;

    await pagina.evaluate((camada, pasta) => {
      const passo = (history.state && history.state.passo) || 0;
      history.pushState({ passo: passo + 1 }, '', `#camada=${encodeURIComponent(camada)}&pasta=${encodeURIComponent(pasta)}`);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, CAMADA_N2, PASTA_N2_PASTA);
    try { await pagina.waitForSelector('#mapa-arquivos .mapa-linha-arquivo', { timeout: 10000 }); } catch {
      problemas.push('tema escuro: o nível 2 não abriu'); return;
    }
    if (!await fotografar('10-nivel-2-tema-escuro.png')) return;

    const linha = await pagina.$(`#mapa-arquivos .mapa-linha-arquivo[data-caminho="${ARQUIVO_N3.replace(/"/g, '\\"')}"]`);
    if (!linha) { problemas.push('tema escuro: a linha do ARQUIVO_N3 não está na lista'); return; }
    await linha.evaluate((b) => b.scrollIntoView({ block: 'center' }));
    await linha.click();
    try { await pagina.waitForSelector('#mapa-folha.aberta', { timeout: 10000 }); } catch {
      problemas.push('tema escuro: a ficha não abriu'); return;
    }
    await fotografar('11-ficha-tema-escuro.png');
  } catch (e) {
    problemas.push(`tema escuro — estourou: ${String(e && e.message).slice(0, 300)}`);
  } finally {
    problemas.push(...vig.problemas());
    await contexto.close().catch(() => {});
  }
}

// ─── Corrida ──────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let scratch = null;
  const resultado = { projeto: PROJETO, cenas: [...CENAS], problemas: [], pngs: [] };
  const gerados = [];
  let rc = 1;

  function derrubarServidor() {
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
  }

  const arqOrigem = path.join(LOJA_ORIGEM, 'knowledge-graph.json');
  const mtimeOrigem = fs.statSync(arqOrigem).mtimeMs;
  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-grafo-mapa-'));
    const home = path.join(scratch, 'home');
    const projetosDir = path.join(scratch, 'projetos');
    const grafosDir = path.join(scratch, 'grafos');
    fs.mkdirSync(home, { recursive: true });
    const repo = path.join(projetosDir, PROJETO);
    fs.mkdirSync(repo, { recursive: true });
    const git = (args) => execFileSync('git', ['-C', repo, '-c', 'user.name=print', '-c', 'user.email=print@example.com', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    git(['init', '-q', '-b', 'develop']);
    git(['commit', '-q', '--allow-empty', '-m', 'c1']);
    fs.mkdirSync(path.join(grafosDir, PROJETO), { recursive: true });
    for (const nome of ['knowledge-graph.json', 'meta.json']) fs.copyFileSync(path.join(LOJA_ORIGEM, nome), path.join(grafosDir, PROJETO, nome));

    const ambiente = {
      PATH: process.env.PATH,
      HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TOKEN: TOKEN,
      COCKPIT_PROJETOS_DIR: projetosDir,
      COCKPIT_GRAFOS_DIR: grafosDir,
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'), // A10 (gate-jobs-disco.js)
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'), COCKPIT_MONITOR_MS: '0', // M-rede
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_LEITURAS_DIR: path.join(scratch, 'leituras'),
      COCKPIT_TMUX_SOCKET: `print-grafo-mapa-${process.pid}`,
      COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
      COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
    };
    servidor = spawn(process.execPath, [SERVER_JS], { cwd: CODIGO_DIR, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaErro = '';
    servidor.stderr.on('data', (d) => { saidaErro += d; });
    let pronto = false;
    for (let i = 0; i < 100 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await pedirHealth();
      if (!pronto) await espera(100);
    }
    if (!pronto) throw new Error(`o servidor (${PORTA}) não subiu — ${saidaErro}`);
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid}, código de ${CODIGO_DIR})`);

    const base = `http://127.0.0.1:${PORTA}`;
    const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      if (CENAS.has('antes')) await cenaAntes(navegador, base, resultado, gerados);
      if (CENAS.has('depois') || CENAS.has('niveis')) await cenaDepoisENiveis(navegador, base, resultado, gerados, resultado.problemas);
      if (CENAS.has('extras')) {
        await cenaLinkDireto(navegador, base, resultado.problemas);
        await cenaLinkSoArquivo(navegador, base, resultado.problemas, gerados);
        await cenaMovimentoReduzido(navegador, base, resultado.problemas);
        await cenaTemaClaro(navegador, base, resultado.problemas, gerados);
        await cenaTemaEscuro(navegador, base, resultado.problemas, gerados);
      }
    } finally {
      await navegador.close().catch(() => {});
    }
    rc = resultado.problemas.length ? 1 : 0;
  } catch (e) {
    resultado.problemas.push(`estourou — ${String(e && e.message).slice(0, 300)}`);
    rc = 1;
  } finally {
    derrubarServidor();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (fs.statSync(arqOrigem).mtimeMs !== mtimeOrigem) {
      resultado.problemas.push('a loja de ORIGEM mudou de mtime durante o print (alguém regenerou? o print nunca escreve lá)');
      rc = 1;
    }
    resultado.pngs = gerados;
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
