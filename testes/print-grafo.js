#!/usr/bin/env node
'use strict';
// PRINT DO GRAFO DO PROJETO (card `grafo-do-projeto-no-cockpit`, plano §7.1). Mudou pixel, tem
// print: botão na lateral, diálogo com as linhas dos projetos e os dois grafos abertos no
// dashboard, desktop E celular. Antes do obturador o roteiro EXIGE o que mudou na vista (o
// `.react-flow__node` desenhado, o texto "grafo da develop" na linha) e reprova (sem PNG) em vez
// de fotografar uma casca que subiu mas não tem o recurso.
//
// Pegadinha 1 — `localStorage` vaza entre cenas na MESMA página (mesma origem): token e
// `cockpit-idioma` setados numa cena continuam na próxima. É por isso que a cena do celular abre
// uma página NOVA (não reaproveita a do desktop) — um teste que reaproveitasse a aba herdaria o
// diálogo já aberto e mediria o tempo de desenho errado.
// Pegadinha 2 — o grafo abre numa ABA NOVA (`window.open`, `_blank`): o `page.click()` não navega
// a própria página; é preciso `browser.waitForTarget` para pegar a aba nova antes de medir o
// desenho.
//
// Sobe `server.js` FILHO (nunca `require`), ambiente FECHADO (molde de `gate-grafo-rota.js`):
// HOME (tmp), COCKPIT_JOBS_DIR, COCKPIT_MONITOR_DIR/_MS (A10, M-rede), COCKPIT_LIDAS_DIR,
// COCKPIT_LEITURAS_DIR, COCKPIT_PUSH_DIR, COCKPIT_VIGIA_MS=0, COCKPIT_DU_BIN/_DOCKER_BIN,
// COCKPIT_TMUX_SOCKET — SEM COCKPIT_TOKEN (a prova de tela do grafo não testa o token, isso é do
// `gate-grafo-rota.js`). O servidor nunca é derrubado por `pkill`: só pelo PID exato, no `finally`.
// Navegador puppeteer-core/Chrome do HOST: os DOIS caminhos vêm por env, sem padrão.
//
// Uso:
//   SAIDA=<pasta nova, vazia> PROJETOS_DIR=<pasta com os repos> PILOTOS_DIR=<loja com os grafos> \
//   PUPPETEER_CORE=<pasta do puppeteer-core> CHROME_BIN=<executável do chrome> \
//   [CODIGO_DIR=<raiz do server.js, padrão: este repo>] [PORTA=7934|7935] [MANTER=1] \
//     node testes/print-grafo.js
//
// Códigos de saída: 0 = PNGs gravados e resultado.json escrito · 1 = cenário reprovado (sem o
// recurso na vista, ou servidor/aba que não respondeu) · 2 = ambiente (env obrigatória faltando).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA || '';
const PROJETOS_DIR = process.env.PROJETOS_DIR || '';
const PILOTOS_DIR = process.env.PILOTOS_DIR || '';
const CODIGO_DIR = process.env.CODIGO_DIR || path.join(__dirname, '..');
const PORTA = process.env.PORTA ? Number(process.env.PORTA) : 7934;
const MANTER = process.env.MANTER === '1';
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const TETO_DESENHO_MS = 20000;

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

if (!SAIDA) { console.error('🟡 ambiente indisponível: SAIDA é obrigatória (pasta nova dos PNGs).'); process.exit(2); }
if (!PROJETOS_DIR) { console.error('🟡 ambiente indisponível: PROJETOS_DIR é obrigatória (COCKPIT_PROJETOS_DIR do servidor).'); process.exit(2); }
if (!PILOTOS_DIR) { console.error('🟡 ambiente indisponível: PILOTOS_DIR é obrigatória (COCKPIT_GRAFOS_DIR do servidor).'); process.exit(2); }
if (![7934, 7935].includes(PORTA)) { console.error(`🟡 PORTA só aceita 7934 ou 7935 (achei ${PORTA}).`); process.exit(2); }
if (!PUPPETEER || !CHROME) {
  console.error('🟡 ambiente indisponível: PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
  process.exit(2);
}
let puppeteer;
try { puppeteer = require(PUPPETEER); } catch (e) {
  console.error(`🟡 ambiente indisponível: não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`);
  process.exit(2);
}
if (!fs.existsSync(CHROME)) { console.error('🟡 ambiente indisponível: CHROME_BIN não existe.'); process.exit(2); }
const SERVER_JS = path.join(CODIGO_DIR, 'server.js');
if (!fs.existsSync(SERVER_JS)) { console.error(`🟡 CODIGO_DIR não tem o servidor (${SERVER_JS}).`); process.exit(2); }

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

// ─── HTTP só para o /health ───────────────────────────────────────────────────

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

// ─── O roteiro do navegador ───────────────────────────────────────────────────

/** Fecha a página com um print PARCIAL (cenário reprovado não deixa prova pela metade). */
function apagarParciais(gerados) {
  for (const g of gerados) fs.rmSync(g, { force: true });
}

async function cenaLateral(pagina, saida, problemas, prefixo) {
  try {
    await pagina.waitForSelector('#btn-grafos', { visible: true, timeout: 10000 });
  } catch {
    problemas.push(`${prefixo}: #btn-grafos não ficou visível — sem o recurso não há o que fotografar`);
    return null;
  }
  const arq = path.join(saida, `${prefixo}.png`);
  await pagina.screenshot({ path: arq });
  return arq;
}

async function cenaDialogo(pagina, saida, problemas, prefixo) {
  await pagina.click('#btn-grafos');
  try {
    await pagina.waitForSelector('#dialogo-grafos[open] .grafos-linha', { timeout: 10000 });
  } catch {
    problemas.push(`${prefixo}: #dialogo-grafos não abriu com nenhuma .grafos-linha`);
    return { arq: null, abriveis: 0 };
  }
  await espera(400); // a lista troca "Carregando…" pelas linhas de verdade
  const medidas = await pagina.evaluate(() => {
    const dlg = document.getElementById('dialogo-grafos');
    return {
      linhas: dlg.querySelectorAll('.grafos-linha').length,
      abriveis: dlg.querySelectorAll('.grafos-abrir:not([disabled])').length,
      texto: dlg.textContent || '',
    };
  });
  if (medidas.linhas < 2) problemas.push(`${prefixo}: só ${medidas.linhas} .grafos-linha (esperava ≥ 2 — PROJETOS_DIR/PILOTOS_DIR sem os dois pilotos?)`);
  if (medidas.abriveis < 2) problemas.push(`${prefixo}: só ${medidas.abriveis} .grafos-abrir sem disabled (esperava ≥ 2)`);
  if (!medidas.texto.includes('grafo da develop')) problemas.push(`${prefixo}: o diálogo não mostra "grafo da develop" em nenhuma linha`);
  const arq = path.join(saida, `${prefixo}.png`);
  await pagina.screenshot({ path: arq });
  return { arq, abriveis: medidas.abriveis };
}

/** Nome do projeto como a TELA mostra (nunca escrito no arquivo). */
async function nomesAbriveis(pagina) {
  return pagina.evaluate(() => Array.from(document.querySelectorAll('#dialogo-grafos .grafos-linha'))
    .filter((l) => l.querySelector('.grafos-abrir:not([disabled])'))
    .map((l) => (l.querySelector('.grafos-nome') || {}).textContent || ''));
}

// ─── Interação com o dashboard vendorizado (understand-anything) ──────────────
// Pegadinha 3 — o primeiro acesso a CADA projeto abre um tour modal (`OnboardingOverlay.tsx`,
// `position:fixed; z-index:9999`) por cima do grafo: sem dispensar, o print mostra o cartão do
// tour, não os nós. Pegadinha 4 — a vista inicial agrupa por CAMADA (`react-flow__node-layer-
// cluster`, sem `[title]`); um nó de ARQUIVO (`CustomNode.tsx`, com `[title]`) só aparece depois
// de "entrar" na camada (clique) — às vezes mais de um nível (camada → container → arquivo). O
// clique tem de ser um clique de MOUSE de verdade (`ElementHandle.click()`, via `data-testid`):
// `elemento.click()` do DOM não alcança o `onClick` que está num FILHO do `.react-flow__node`.

/** "Don't show again" se existir; senão Escape (o handler de Escape do tour sempre existe
 * enquanto ele está montado — não falha se não houver tour para fechar). */
async function dispensarTour(aba) {
  try {
    const clicouBotao = await aba.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /don.t show again/i.test(b.textContent || ''));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicouBotao) await aba.keyboard.press('Escape').catch(() => {});
    await espera(300);
  } catch { /* nada para dispensar */ }
}

/** Clique de mouse de verdade no PRIMEIRO `.react-flow__node` que não é portal (via
 * `data-testid`, único e estável) — para "entrar" numa camada ou abrir um container. */
async function clicarPrimeiroNaoPortal(aba) {
  const testid = await aba.evaluate(() => {
    const alvo = Array.from(document.querySelectorAll('.react-flow__node')).find((n) => !n.className.includes('portal'));
    return alvo ? alvo.getAttribute('data-testid') : null;
  });
  if (!testid) return false;
  const handle = await aba.$(`[data-testid="${testid}"]`);
  if (!handle) return false;
  await handle.click();
  await handle.dispose();
  return true;
}

/** Clique de mouse de verdade no primeiro `.react-flow__node` que TEM `[title]` (nó de arquivo/
 * função — `CustomNode.tsx`). */
async function clicarPrimeiroComTitulo(aba) {
  const testid = await aba.evaluate(() => {
    const comTitulo = Array.from(document.querySelectorAll('.react-flow__node')).find((n) => n.querySelector('[title]'));
    return comTitulo ? comTitulo.getAttribute('data-testid') : null;
  });
  if (!testid) return false;
  const handle = await aba.$(`[data-testid="${testid}"]`);
  if (!handle) return false;
  await handle.click();
  await handle.dispose();
  return true;
}

async function labelDoPrimeiroComTitulo(aba) {
  return aba.evaluate(() => {
    const comTitulo = Array.from(document.querySelectorAll('.react-flow__node')).find((n) => n.querySelector('[title]'));
    const el = comTitulo && comTitulo.querySelector('[title]');
    return el ? el.getAttribute('title') : null;
  });
}

/** Entra nas camadas/containers (até `tentativas` cliques) até achar um nó com `[title]`, sem
 * clicar nele ainda — quem chama decide o que fazer com o label achado. */
async function acharNoComTitulo(aba, tentativas = 4) {
  for (let i = 0; i < tentativas; i += 1) {
    const label = await labelDoPrimeiroComTitulo(aba);
    if (label) return label;
    if (!(await clicarPrimeiroNaoPortal(aba))) return null;
    await espera(900);
  }
  return null;
}

/** Clica no botão "Grafo" da N-ésima linha abrível, pega a aba nova e mede o desenho. */
async function abrirEMedir(browser, pagina, indice, saida, problemas, resultados) {
  const antes = new Set(browser.targets().map((t) => t._targetId || t));
  await pagina.evaluate((i) => {
    document.querySelectorAll('#dialogo-grafos .grafos-abrir:not([disabled])')[i].click();
  }, indice);
  let alvo;
  try {
    alvo = await browser.waitForTarget((t) => !antes.has(t._targetId || t) && t.url().includes('/grafo/'), { timeout: 10000 });
  } catch {
    problemas.push(`grafo #${indice}: a aba nova não abriu (window.open bloqueado?)`);
    return;
  }
  const aba = await alvo.page();
  // A aba nova nasce no viewport padrão do Chrome (800×600), não no da cena: sem isto o "desktop"
  // do 03-grafo-*.png sai espremido.
  await aba.setViewport({ width: 1600, height: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  const erros = [];
  const respostasRuins = [];
  aba.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  aba.on('pageerror', (e) => erros.push(`PAGEERROR: ${String(e).slice(0, 200)}`));
  aba.on('response', (r) => { if (r.status() >= 400) respostasRuins.push(`${r.status()} ${r.url()}`); });

  const t0 = Date.now();
  let desenhou = false;
  try {
    await aba.waitForSelector('.react-flow__node', { timeout: TETO_DESENHO_MS });
    desenhou = true;
  } catch { /* vira problema abaixo */ }
  const tempoDesenhoMs = Date.now() - t0;
  await dispensarTour(aba); // pegadinha 3 — senão o 03-grafo-*.png fotografa o cartão do tour
  await espera(1200); // animações de layout zerarem antes do print

  const contagem = await aba.evaluate(() => ({
    nos: document.querySelectorAll('.react-flow__node').length,
    temTextoRefresh: document.body.textContent.includes('could not be refreshed'),
    // O validador do dashboard "corrige" nó fora do schema e avisa numa faixa (ex.: summary vazio).
    // Grafo nosso tem de abrir SEM correção nenhuma — visto no print de 16/10 (2.507 correções).
    temAutoCorrecao: /auto-correction/i.test(document.body.textContent),
  }));

  if (!desenhou || contagem.nos < 1) problemas.push(`grafo #${indice}: nenhum .react-flow__node desenhado em ${TETO_DESENHO_MS}ms`);
  if (contagem.temAutoCorrecao) problemas.push(`grafo #${indice}: o dashboard "auto-corrigiu" o grafo (faixa auto-corrections) — algum campo fora do schema`);
  if (contagem.temTextoRefresh) problemas.push(`grafo #${indice}: "could not be refreshed" na tela — staleness.json reprovou em silêncio`);
  if (erros.length) problemas.push(`grafo #${indice}: ${erros.length} erro(s) de console/pageerror: ${erros.slice(0, 3).join(' | ')}`);
  if (respostasRuins.length) problemas.push(`grafo #${indice}: ${respostasRuins.length} resposta(s) >= 400: ${respostasRuins.slice(0, 3).join(' | ')}`);

  const arqGrafo = path.join(saida, `03-grafo-${indice + 1}.png`);
  if (desenhou && contagem.nos >= 1) await aba.screenshot({ path: arqGrafo });

  // Abre o primeiro nó com `[title]` (CustomNode.tsx — o `title` tem o `node.name` por completo,
  // mesmo truncado na vista; pegadinha 4 — pode exigir "entrar" na camada/container antes) e
  // exige que o painel (`NodeInfo.tsx`, `<h2 class="text-lg font-heading …">{node.name}</h2>`)
  // passe a mostrar o MESMO nome — não só "algum painel existe" (o `ProjectOverview` já tem um
  // `h2.font-heading` com o nome do PROJETO antes do clique; comparar o texto, não só a presença
  // do elemento, evita o falso positivo).
  let painelOk = false;
  try {
    const labelAntes = await acharNoComTitulo(aba);
    if (labelAntes) {
      const clicou = await clicarPrimeiroComTitulo(aba);
      if (clicou) {
        await espera(600);
        const nomeNoPainel = await aba.evaluate(() => {
          const h2 = Array.from(document.querySelectorAll('h2'))
            .find((h) => h.className.includes('font-heading') && !h.className.includes('text-2xl'));
          return h2 ? h2.textContent : null;
        });
        painelOk = Boolean(nomeNoPainel) && nomeNoPainel.trim() === labelAntes.trim();
        if (!painelOk) problemas.push(`grafo #${indice}: painel não mostrou o nome do nó clicado (nó="${labelAntes}" painel=${JSON.stringify(nomeNoPainel)})`);
      } else {
        problemas.push(`grafo #${indice}: achei um nó com [title] mas não consegui clicar nele`);
      }
    } else {
      problemas.push(`grafo #${indice}: nenhum .react-flow__node com [title] (nem depois de entrar nas camadas/containers)`);
    }
  } catch (e) { problemas.push(`grafo #${indice}: clique no nó estourou — ${String(e && e.message).slice(0, 200)}`); }
  const arqNo = path.join(saida, `04-grafo-${indice + 1}-no.png`);
  if (painelOk) await aba.screenshot({ path: arqNo });

  resultados.push({ indice, tempoDesenhoMs, nos: contagem.nos });
  await aba.close().catch(() => {});
}

async function roteiro(base, saida) {
  const problemas = [];
  const gerados = [];
  const resultadosDesenho = [];
  const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    // ─── Desktop ──────────────────────────────────────────────────────────
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 1600, height: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
    // O Chrome headless do puppeteer-core manda `navigator.language: en-US` — sem isto o
    // `i18n.js` cairia em inglês e "grafo da develop" nunca apareceria na tela (pt-BR).
    await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* vale nesta página */ } });
    await pagina.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });

    const arq1 = await cenaLateral(pagina, saida, problemas, '01-lateral-botao');
    if (arq1) gerados.push(arq1);
    if (problemas.length) { apagarParciais(gerados); return { gerados: [], problemas, resultadosDesenho }; }

    const { arq: arq2, abriveis } = await cenaDialogo(pagina, saida, problemas, '02-dialogo');
    if (arq2) gerados.push(arq2);
    if (problemas.length) { apagarParciais(gerados); return { gerados: [], problemas, resultadosDesenho }; }

    const nomes = await nomesAbriveis(pagina);
    console.log(`  · pilotos abríveis na tela: ${JSON.stringify(nomes)}`);

    for (let i = 0; i < abriveis; i += 1) {
      await abrirEMedir(navegador, pagina, i, saida, problemas, resultadosDesenho);
    }
    for (const r of resultadosDesenho) {
      const arqG = path.join(saida, `03-grafo-${r.indice + 1}.png`);
      const arqN = path.join(saida, `04-grafo-${r.indice + 1}-no.png`);
      if (fs.existsSync(arqG)) gerados.push(arqG);
      if (fs.existsSync(arqN)) gerados.push(arqN);
    }
    if (problemas.length) { apagarParciais(gerados); return { gerados: [], problemas, resultadosDesenho }; }

    // ─── Celular (página NOVA — pegadinha 1: localStorage não viaja) ──────
    const paginaCel = await navegador.newPage();
    await paginaCel.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await paginaCel.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* vale nesta página */ } });
    await paginaCel.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });

    const arq5 = await cenaLateral(paginaCel, saida, problemas, '05-celular-lateral');
    if (arq5) gerados.push(arq5);
    if (problemas.length) { apagarParciais(gerados); return { gerados: [], problemas, resultadosDesenho }; }

    const { arq: arq6, abriveis: abriveisCel } = await cenaDialogo(paginaCel, saida, problemas, '06-celular-dialogo');
    if (arq6) gerados.push(arq6);
    if (problemas.length) { apagarParciais(gerados); return { gerados: [], problemas, resultadosDesenho }; }

    if (abriveisCel >= 1) {
      const antes = new Set(navegador.targets().map((t) => t._targetId || t));
      await paginaCel.evaluate(() => { document.querySelectorAll('#dialogo-grafos .grafos-abrir:not([disabled])')[0].click(); });
      try {
        const alvoCel = await navegador.waitForTarget((t) => !antes.has(t._targetId || t) && t.url().includes('/grafo/'), { timeout: 10000 });
        const abaCel = await alvoCel.page();
        await abaCel.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        try { await abaCel.waitForSelector('.react-flow__node', { timeout: TETO_DESENHO_MS }); } catch { /* vira problema abaixo */ }
        await dispensarTour(abaCel); // pegadinha 3 — senão o print mostra o cartão do tour, não o grafo
        await espera(1200);
        const temNo = await abaCel.evaluate(() => document.querySelectorAll('.react-flow__node').length >= 1);
        if (!temNo) problemas.push('celular: o grafo do primeiro piloto não desenhou nenhum nó');
        const arq7 = path.join(saida, '07-celular-grafo.png');
        if (temNo) { await abaCel.screenshot({ path: arq7 }); gerados.push(arq7); }
        await abaCel.close().catch(() => {});
      } catch {
        problemas.push('celular: a aba nova do grafo não abriu');
      }
    }
    if (problemas.length) { apagarParciais(gerados); return { gerados: [], problemas, resultadosDesenho }; }
  } catch (e) {
    problemas.push(`o roteiro estourou — ${String(e && e.message).slice(0, 300)}`);
    apagarParciais(gerados);
    return { gerados: [], problemas, resultadosDesenho };
  } finally {
    await navegador.close().catch(() => {});
  }
  return { gerados, problemas, resultadosDesenho };
}

// ─── Corrida ──────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let scratch = null;
  let encerrando = false;

  function derrubarServidor() {
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
  }
  function limpar() {
    derrubarServidor();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-grafo-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });

    // Ambiente FECHADO (molde `gate-grafo-rota.js`): só o que o servidor precisa, tudo no tmp.
    // SEM COCKPIT_TOKEN — a prova de tela do grafo não exercita o token.
    const ambiente = {
      PATH: process.env.PATH,
      HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_PROJETOS_DIR: PROJETOS_DIR,
      COCKPIT_GRAFOS_DIR: PILOTOS_DIR,
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'), // A10 (gate-jobs-disco.js)
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'), COCKPIT_MONITOR_MS: '0', // M-rede
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_LEITURAS_DIR: path.join(scratch, 'leituras'),
      COCKPIT_TMUX_SOCKET: `print-grafo-${process.pid}`,
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
    if (!pronto) {
      console.error(`🔴 o servidor (${PORTA}) não subiu — ${saidaErro}`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid})`);

    const { gerados, problemas, resultadosDesenho } = await roteiro(`http://127.0.0.1:${PORTA}`, SAIDA);
    for (const g of gerados) console.log(`  ✅ ${g}`);
    for (const p of problemas) console.error(`  ❌ ${p}`);

    // meta.json de cada piloto (tempo de geração), para o resultado.json.
    const geracao = {};
    try {
      for (const nome of fs.readdirSync(PILOTOS_DIR)) {
        const metaArq = path.join(PILOTOS_DIR, nome, 'meta.json');
        if (fs.existsSync(metaArq)) {
          const meta = JSON.parse(fs.readFileSync(metaArq, 'utf8'));
          geracao[nome] = { durationMs: meta.durationMs, analyzedFiles: meta.analyzedFiles };
        }
      }
    } catch { /* resultado.json fica sem a seção de geração */ }

    const precisaDecisao = resultadosDesenho.some((r) => r.tempoDesenhoMs > TETO_DESENHO_MS);
    const resultado = {
      veredito: problemas.length ? 'reprovado' : 'ok',
      problemas,
      geracao,
      desenho: resultadosDesenho,
      needsDecision: precisaDecisao ? `tempo de desenho acima de ${TETO_DESENHO_MS}ms em pelo menos um grafo` : null,
    };
    fs.writeFileSync(path.join(SAIDA, 'resultado.json'), JSON.stringify(resultado, null, 2));
    console.log(`  · resultado.json gravado em ${path.join(SAIDA, 'resultado.json')}`);

    if (MANTER && !problemas.length) {
      console.log(`  · MANTER=1 — o servidor fica no ar (pid ${servidor.pid}) até SIGTERM`);
      process.on('SIGTERM', () => { if (!encerrando) { encerrando = true; limpar(); process.exit(0); } });
      process.on('SIGINT', () => { if (!encerrando) { encerrando = true; limpar(); process.exit(0); } });
      await new Promise(() => {}); // só volta por SIGTERM/SIGINT
    }

    limpar();
    return process.exit(problemas.length ? 1 : 0);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
