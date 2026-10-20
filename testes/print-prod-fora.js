#!/usr/bin/env node
'use strict';
// PROVA DE TELA — a faixa PROD FORA (D87; spec 2026-10-16-faixa-prod-fora-design.md): a faixa
// vermelha no topo (toda tela) e as bolinhas por site na faixa do monitor, lendo o estado de um
// vigia de prod externo. Molde `testes/print-segundo-plano.js`: mundo próprio (socket tmux só
// dele, HOME falso), navegador no HOST via PUPPETEER_CORE/CHROME_BIN. NUNCA aponta para a
// instância de produção; os sites são de mentira (`loja`, `api`).
//
// O HOST reescreve `estado.json` entre as cenas (fixtures `normal`/`fora`/`parado`) — sem
// acoplamento host↔navegador: cada cena chama `atualizar()` em laço até a condição valer (molde
// `testes/print-monitor.js:224-232`); não valeu → reprova SEM gravar PNG.
//
// CONTROLE NEGATIVO: a cena 2 roda de novo contra a árvore da `develop` (RAIZ_ANTES, por `git
// archive`) e TEM de reprovar com a mensagem exata "cena 2: faixa vermelha ausente" — senão o
// script não provou nada.
//
// Uso:
//   SAIDA=/tmp/saida PUPPETEER_CORE=<pasta do puppeteer-core> CHROME_BIN=<executável do chrome> \
//     RAIZ_ANTES=<árvore da develop, por git archive> node testes/print-prod-fora.js
//
// Códigos: 0 = as cenas passaram E o negativo reprovou do jeito certo · 1 = reprovado · 2 = ambiente.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA || '';
const RAIZ_ANTES = process.env.RAIZ_ANTES || '';
const RAIZ_CODIGO = path.join(__dirname, '..');
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '';
const CHROME_BIN = process.env.CHROME_BIN || '';
const PORTA_DEPOIS = Number(process.env.PORTA_DEPOIS || 7976);
const PORTA_ANTES = Number(process.env.PORTA_ANTES || 7977);
const TOKEN = 'print-prod-fora';
const SOCKET = `cockpit-smoke-prod-fora-${process.pid}`;
const CARIMBO = `ancora-prod-fora-${process.pid}`;
const MINHAS_SESSOES = new Set(['ancora', 'main']);
const VIEWPORT_DESKTOP = { width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };
const VIEWPORT_CELULAR = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em TODO comando: sem ele o ~/.tmux.conf do dono carrega e o continuum-restore
// recria as sessões dele dentro do socket "isolado".
function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

if (!SAIDA) { console.error('🟡 SAIDA é obrigatória (pasta dos PNGs).'); process.exit(2); }
if (!PUPPETEER_CORE || !CHROME_BIN) {
  console.error('🟡 ambiente indisponível: PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
  process.exit(2);
}
if (!RAIZ_ANTES) { console.error('🟡 RAIZ_ANTES é obrigatória (árvore da develop, para o controle negativo).'); process.exit(2); }
let puppeteer;
try { puppeteer = require(PUPPETEER_CORE); } catch (e) {
  console.error(`🟡 ambiente indisponível: não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`);
  process.exit(2);
}
if (!fs.existsSync(CHROME_BIN)) { console.error('🟡 ambiente indisponível: CHROME_BIN não existe.'); process.exit(2); }
if (!fs.existsSync(path.join(RAIZ_CODIGO, 'server.js'))) { console.error('🟡 RAIZ_CODIGO não tem o servidor.'); process.exit(2); }
if (!fs.existsSync(path.join(RAIZ_ANTES, 'server.js'))) { console.error('🟡 RAIZ_ANTES não tem o servidor.'); process.exit(2); }

function portaOcupada(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-ltn'], { encoding: 'utf8' });
    return saida.split('\n').some((l) => (l.trim().split(/\s+/)[3] || '').endsWith(`:${porta}`));
  } catch { return false; }
}
for (const porta of [PORTA_DEPOIS, PORTA_ANTES]) {
  if (portaOcupada(porta)) { console.error(`🔴 a porta ${porta} já está em uso — aborta antes de subir qualquer coisa.`); process.exit(2); }
}

// ─── Fixtures do estado do vigia (sempre `loja`/`api`, nunca um site real) ───────────────────

const iso = (msAtras) => new Date(Date.now() - msAtras).toISOString();
const FIXTURES = {
  normal: () => ({
    loja: { status: 'up', falhas: 0, ultimo_check: iso(5000), ultimo_detalhe: '200' },
    api: { status: 'up', falhas: 0, ultimo_check: iso(5000), ultimo_detalhe: '200' },
  }),
  fora: () => ({
    loja: { status: 'down', falhas: 13, desde: iso(720000), ultimo_check: iso(0), ultimo_detalhe: '502' },
    api: { status: 'up', falhas: 0, ultimo_check: iso(5000), ultimo_detalhe: '200' },
  }),
  parado: () => ({
    loja: { status: 'up', falhas: 0, ultimo_check: iso(600000), ultimo_detalhe: '200' },
    api: { status: 'up', falhas: 0, ultimo_check: iso(600000), ultimo_detalhe: '200' },
  }),
};
function escreverFixture(arq, nome) { fs.writeFileSync(arq, JSON.stringify(FIXTURES[nome]())); }

// ─── Servidor filho ───────────────────────────────────────────────────────────────────────────

function saude(porta) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/health', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function construirAmbiente({ porta, home, arqEstado, scratch }) {
  const ambiente = { ...process.env };
  for (const k of Object.keys(ambiente)) if (k.startsWith('COCKPIT_')) delete ambiente[k];
  delete ambiente.PORT;
  Object.assign(ambiente, {
    HOST: '127.0.0.1', PORT: String(porta), HOME: home,
    COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TOKEN: TOKEN,
    COCKPIT_TMUX_SOCKET: SOCKET, COCKPIT_TMUX_SESSAO: 'main',
    COCKPIT_VIGIA_PROD_ARQ: arqEstado,
    COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'), COCKPIT_MONITOR_MS: '0',
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_JOBS_DIR: path.join(scratch, 'jobs-vazio'),
    COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
    COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
    COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
  });
  return ambiente;
}

async function subir(dir, ambiente, porta) {
  const s = spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, env: ambiente, stdio: ['ignore', 'ignore', 'pipe'] });
  s.stderr.on('data', (d) => process.stderr.write(`[server.js:${porta}] ${d}`));
  let pronto = false;
  for (let i = 0; i < 60 && !pronto; i += 1) {
    if (s.exitCode !== null) break;
    pronto = await saude(porta);
    if (!pronto) await espera(200);
  }
  if (!pronto) throw new Error(`o servidor (${porta}) não subiu`);
  return s;
}

// ─── O roteiro do navegador ─────────────────────────────────────────────────────────────────

/** Chama `atualizar()` a cada 1 s até a condição valer (molde `print-monitor.js:224-232`). */
async function ate(pagina, condicao, segundos) {
  for (let i = 0; i < segundos; i += 1) {
    await pagina.evaluate(() => (globalThis.cockpitMonitor && globalThis.cockpitMonitor.atualizar ? globalThis.cockpitMonitor.atualizar() : null));
    if (await pagina.evaluate(condicao)) return true;
    await espera(1000);
  }
  return false;
}

/** Antes de cada foto: o deslize de 200 ms da `.chat` no celular (e outras transições finitas)
 *  têm de ter acabado — senão o PNG sai com a tela cortada a meio caminho (molde `print-monitor.js`). */
const quieta = (pagina) => pagina.waitForFunction(() => document.getAnimations()
  .filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).length === 0, { timeout: 5000 }).catch(() => {});

async function novaPagina(navegador, viewport, { lateralFechada = false } = {}) {
  const pg = await navegador.newPage();
  await pg.setViewport(viewport);
  await pg.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await pg.evaluateOnNewDocument((fechada) => {
    try {
      localStorage.setItem('cockpit-idioma', 'pt-BR');
      // Explícito nos dois sentidos — localStorage é por ORIGEM, não por página: sem isto, o
      // "fechada" da cena 3 vazaria (via navegador compartilhado) para toda cena desktop depois
      // dela (achado medido: 03/08/09 saíram com o MESMO md5 na 1ª corrida).
      localStorage.setItem('cockpit-lateral-fechada', fechada ? '1' : '0');
    } catch (e) { /* modo privado */ }
  }, lateralFechada);
  return pg;
}

async function cena1(navegador, base, vp, sufixo) {
  const pg = await novaPagina(navegador, vp);
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await pg.waitForSelector('#abas', { timeout: 15000 }).catch(() => {});
  const condOk = await ate(pg, () => {
    const pf = document.getElementById('prod-fora');
    const bolinhas = document.querySelectorAll('#monitor-sites .monitor-site[data-situacao="no-ar"]');
    return Boolean(pf) && pf.hidden && bolinhas.length === 2;
  }, 15);
  if (!condOk) { await pg.close(); return { ok: false, problema: `cena 1 (${sufixo}): #prod-fora não ficou hidden com 2 bolinhas "no-ar"` }; }
  const geo = await pg.evaluate(() => {
    const r = document.getElementById('app').getBoundingClientRect();
    return { h: Math.round(r.height), innerHeight: window.innerHeight };
  });
  if (Math.abs(geo.h - geo.innerHeight) > 1) { await pg.close(); return { ok: false, problema: `cena 1 (${sufixo}): .app altura ${geo.h} != innerHeight ${geo.innerHeight}` }; }
  const png = path.join(SAIDA, `01-normal-${sufixo}.png`);
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

async function cena2(navegador, base, { negativo = false } = {}) {
  const pg = await novaPagina(navegador, VIEWPORT_DESKTOP);
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await pg.waitForSelector('#abas', { timeout: 15000 }).catch(() => {});
  const condOk = await ate(pg, () => {
    const pf = document.getElementById('prod-fora');
    return Boolean(pf) && !pf.hidden && pf.dataset.tom === 'fora' && pf.textContent.indexOf('PROD FORA — loja há 12 min (502)') === 0;
  }, negativo ? 8 : 15);
  if (!condOk) { await pg.close(); return { ok: false, problema: 'cena 2: faixa vermelha ausente' }; }
  const geo = await pg.evaluate(() => {
    const app = document.getElementById('app').getBoundingClientRect();
    const pf = document.getElementById('prod-fora').getBoundingClientRect();
    const bolinha = document.querySelector('#monitor-sites .monitor-site[data-situacao="fora"]');
    return {
      prodForaBottom: Math.round(pf.bottom), appTop: Math.round(app.top), appBottom: Math.round(app.bottom),
      innerHeight: window.innerHeight, scrollHeight: document.scrollingElement.scrollHeight,
      temBolinhaFora: Boolean(bolinha),
    };
  });
  const detalhes = [];
  if (!(geo.prodForaBottom <= geo.appTop)) detalhes.push(`prodFora.bottom(${geo.prodForaBottom}) > app.top(${geo.appTop})`);
  if (!(Math.abs(geo.appBottom - geo.innerHeight) <= 1)) detalhes.push(`app.bottom(${geo.appBottom}) != innerHeight(${geo.innerHeight})`);
  if (!(geo.scrollHeight <= geo.innerHeight)) detalhes.push(`scrollHeight(${geo.scrollHeight}) > innerHeight(${geo.innerHeight})`);
  if (!geo.temBolinhaFora) detalhes.push('nenhuma bolinha data-situacao="fora"');
  if (detalhes.length) { await pg.close(); return { ok: false, problema: `cena 2: ${detalhes.join('; ')}` }; }
  let png = null;
  if (!negativo) {
    png = path.join(SAIDA, '02-fora-desktop-lista.png');
    await quieta(pg);
    await pg.screenshot({ path: png });
  }
  await pg.close();
  return { ok: true, png };
}

async function cena3(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_DESKTOP, { lateralFechada: true });
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  const condOk = await ate(pg, () => {
    const app = document.getElementById('app');
    const pf = document.getElementById('prod-fora');
    return app.dataset.lateral === 'fechada' && Boolean(pf) && !pf.hidden;
  }, 15);
  if (!condOk) { await pg.close(); return { ok: false, problema: 'cena 3: lateral fechada ou faixa ausente' }; }
  const png = path.join(SAIDA, '03-fora-desktop-lateral-fechada.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

async function cena4(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_CELULAR);
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  const condOk = await ate(pg, () => { const pf = document.getElementById('prod-fora'); return Boolean(pf) && !pf.hidden; }, 15);
  if (!condOk) { await pg.close(); return { ok: false, problema: 'cena 4: faixa ausente no celular' }; }
  const geo = await pg.evaluate(() => {
    const pf = document.getElementById('prod-fora').getBoundingClientRect();
    const lista = document.getElementById('abas').getBoundingClientRect();
    return { pfBottom: Math.round(pf.bottom), listaTop: Math.round(lista.top) };
  });
  if (geo.pfBottom > geo.listaTop + 1) { await pg.close(); return { ok: false, problema: `cena 4: a faixa (bottom ${geo.pfBottom}) não está acima da lista (top ${geo.listaTop})` }; }
  const png = path.join(SAIDA, '04-fora-celular-lista.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

async function cena5(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_CELULAR);
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await pg.waitForSelector('#abas .conversa-linha', { timeout: 15000 }).catch(() => {});
  const condAntes = await ate(pg, () => { const pf = document.getElementById('prod-fora'); return Boolean(pf) && !pf.hidden; }, 15);
  if (!condAntes) { await pg.close(); return { ok: false, problema: 'cena 5: faixa ausente antes de abrir a conversa' }; }
  const clicou = await pg.evaluate(() => { const l = document.querySelector('#abas .conversa-linha .conversa'); if (l) l.click(); return Boolean(l); });
  if (!clicou) { await pg.close(); return { ok: false, problema: 'cena 5: não achei uma linha de conversa para abrir' }; }
  const condChat = await ate(pg, () => document.getElementById('app').dataset.vista === 'chat'
    && !document.getElementById('prod-fora').hidden && Boolean(document.querySelector('.chat-topo')), 15);
  if (!condChat) { await pg.close(); return { ok: false, problema: 'cena 5: vista "chat" ou faixa ausente depois do toque' }; }
  const geo = await pg.evaluate(() => {
    const pf = document.getElementById('prod-fora').getBoundingClientRect();
    const topo = document.querySelector('.chat-topo').getBoundingClientRect();
    return { pfBottom: Math.round(pf.bottom), topoTop: Math.round(topo.top) };
  });
  if (geo.topoTop < geo.pfBottom - 1) { await pg.close(); return { ok: false, problema: `cena 5: .chat-topo (top ${geo.topoTop}) sobrepõe a faixa (bottom ${geo.pfBottom})` }; }
  const png = path.join(SAIDA, '05-fora-celular-conversa.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

async function cena6(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_DESKTOP);
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  const condOk = await ate(pg, () => {
    const pf = document.getElementById('prod-fora');
    return Boolean(pf) && !pf.hidden && pf.dataset.tom === 'parado'
      && pf.textContent === 'Vigia de prod parado há 10 min — sem notícia de prod';
  }, 15);
  if (!condOk) { await pg.close(); return { ok: false, problema: 'cena 6: faixa de aviso ausente ou texto diferente do esperado' }; }
  const bolinhas = await pg.evaluate(() => document.querySelectorAll('#monitor-sites .monitor-site[data-situacao="parado"]').length);
  if (bolinhas < 2) { await pg.close(); return { ok: false, problema: `cena 6: esperava 2 bolinhas "parado" (veio ${bolinhas})` }; }
  const png = path.join(SAIDA, '06-parado-desktop.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

async function cena7(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_CELULAR);
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  await pg.waitForSelector('#abas .conversa-linha', { timeout: 15000 }).catch(() => {});
  const condAntes = await ate(pg, () => { const pf = document.getElementById('prod-fora'); return Boolean(pf) && !pf.hidden && pf.dataset.tom === 'parado'; }, 15);
  if (!condAntes) { await pg.close(); return { ok: false, problema: 'cena 7: faixa de aviso ausente antes de abrir a conversa' }; }
  const clicou = await pg.evaluate(() => { const l = document.querySelector('#abas .conversa-linha .conversa'); if (l) l.click(); return Boolean(l); });
  if (!clicou) { await pg.close(); return { ok: false, problema: 'cena 7: não achei uma linha de conversa para abrir' }; }
  const condChat = await ate(pg, () => document.getElementById('app').dataset.vista === 'chat' && !document.getElementById('prod-fora').hidden, 15);
  if (!condChat) { await pg.close(); return { ok: false, problema: 'cena 7: a faixa de aviso não está à vista com a conversa aberta' }; }
  const png = path.join(SAIDA, '07-parado-celular-conversa.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

async function cena8(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_DESKTOP);
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  const condOk = await ate(pg, () => { const pf = document.getElementById('prod-fora'); return Boolean(pf) && !pf.hidden && pf.dataset.tom === 'fora'; }, 15);
  if (!condOk) { await pg.close(); return { ok: false, problema: 'cena 8: faixa vermelha ausente antes de derrubar /api/sites' }; }
  const textoAntes = await pg.evaluate(() => document.getElementById('prod-fora').textContent);
  await pg.setRequestInterception(true);
  pg.on('request', (req) => (/\/api\/sites(\?.*)?$/.test(req.url()) ? req.abort() : req.continue()));
  await pg.evaluate(() => globalThis.cockpitMonitor.atualizar());
  await espera(300);
  await pg.evaluate(() => globalThis.cockpitMonitor.atualizar());
  await espera(300);
  const depois = await pg.evaluate(() => ({
    texto: document.getElementById('prod-fora').textContent,
    hidden: document.getElementById('prod-fora').hidden,
    estado: document.getElementById('monitor-sites').getAttribute('data-estado'),
  }));
  const detalhes = [];
  if (depois.hidden) detalhes.push('a faixa ficou hidden depois da rede cair');
  if (depois.texto !== textoAntes) detalhes.push(`o texto mudou (antes "${textoAntes}", depois "${depois.texto}")`);
  if (depois.estado !== 'sem-dado') detalhes.push(`#monitor-sites sem data-estado="sem-dado" (veio ${depois.estado})`);
  if (detalhes.length) { await pg.close(); return { ok: false, problema: `cena 8: ${detalhes.join('; ')}` }; }
  const png = path.join(SAIDA, '08-fora-sem-rede-sites.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

async function cena9(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_DESKTOP);
  await pg.setRequestInterception(true);
  pg.on('request', (req) => (/\/api\/monitor(\?.*)?$/.test(req.url()) ? req.abort() : req.continue()));
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  const condOk = await ate(pg, () => {
    const mf = document.getElementById('monitor-faixa');
    const pf = document.getElementById('prod-fora');
    return Boolean(mf) && mf.hidden === true && Boolean(pf) && !pf.hidden && pf.dataset.tom === 'fora';
  }, 15);
  if (!condOk) { await pg.close(); return { ok: false, problema: 'cena 9: #monitor-faixa não ficou hidden ou #prod-fora ausente sem /api/monitor' }; }
  const png = path.join(SAIDA, '09-fora-sem-monitor.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

// ─── Corrida ──────────────────────────────────────────────────────────────────────────────────

(async () => {
  let scratch = null;
  let tmuxNoAr = false;
  const servidores = [];

  function limpar() {
    for (const s of servidores) {
      if (s && s.exitCode === null) { try { process.kill(s.pid); } catch { /* já morreu */ } }
    }
    if (tmuxNoAr) {
      // Duas respostas, não uma (D35): o carimbo prova que EU criei o socket; a enumeração
      // prova que não há mais ninguém nele. Derrubar o servidor tmux exige as duas.
      const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
        .split('\n').some((n) => n.trim() === CARIMBO);
      const intrusas = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
        .split('\n').map((n) => n.trim()).filter((n) => n && !MINHAS_SESSOES.has(n));
      if (temCarimbo && !intrusas.length) {
        t(['kill-server'], { tolerante: true });
      } else if (temCarimbo) {
        for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
        console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
      } else {
        console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
      }
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-prod-fora-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(scratch, 'jobs-vazio'), { recursive: true });
    const arqEstado = path.join(scratch, 'estado.json');
    escreverFixture(arqEstado, 'normal');

    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    tmuxNoAr = true;
    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', 'main', '-n', 'loja', '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-window', '-d', '-t', 'main:', '-n', 'api', '-c', os.tmpdir(), 'sleep', '600']);

    const ambienteDepois = construirAmbiente({ porta: PORTA_DEPOIS, home, arqEstado, scratch });
    const depois = await subir(RAIZ_CODIGO, ambienteDepois, PORTA_DEPOIS);
    servidores.push(depois);
    console.log(`  · servidor "depois" no ar em http://127.0.0.1:${PORTA_DEPOIS} (pid ${depois.pid}), socket ${SOCKET}`);
    const base = `http://127.0.0.1:${PORTA_DEPOIS}/?token=${TOKEN}`;

    const problemas = [];
    const pngs = [];

    const navegador = await puppeteer.launch({ executablePath: CHROME_BIN, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      for (const [sufixo, vp] of [['desktop', VIEWPORT_DESKTOP], ['celular', VIEWPORT_CELULAR]]) {
        const r = await cena1(navegador, base, vp, sufixo);
        if (r.ok) pngs.push(r.png); else problemas.push(r.problema);
      }

      escreverFixture(arqEstado, 'fora');
      for (const fn of [
        () => cena2(navegador, base), () => cena3(navegador, base), () => cena4(navegador, base),
        () => cena5(navegador, base), () => cena8(navegador, base), () => cena9(navegador, base),
      ]) {
        const r = await fn();
        if (r.ok) { if (r.png) pngs.push(r.png); } else problemas.push(r.problema);
      }

      escreverFixture(arqEstado, 'parado');
      for (const fn of [() => cena6(navegador, base), () => cena7(navegador, base)]) {
        const r = await fn();
        if (r.ok) pngs.push(r.png); else problemas.push(r.problema);
      }
    } finally {
      await navegador.close().catch(() => {});
    }

    // ─── CONTROLE NEGATIVO: a cena 2 contra a develop TEM de reprovar ───
    escreverFixture(arqEstado, 'fora');
    const ambienteAntes = construirAmbiente({ porta: PORTA_ANTES, home, arqEstado, scratch });
    const antes = await subir(RAIZ_ANTES, ambienteAntes, PORTA_ANTES);
    servidores.push(antes);
    console.log(`  · servidor "antes" (develop) no ar em http://127.0.0.1:${PORTA_ANTES} (pid ${antes.pid})`);
    const baseAntes = `http://127.0.0.1:${PORTA_ANTES}/?token=${TOKEN}`;
    const navegadorAntes = await puppeteer.launch({ executablePath: CHROME_BIN, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    let negativoOk = false;
    let negativoDetalhe = '';
    try {
      const r = await cena2(navegadorAntes, baseAntes, { negativo: true });
      negativoOk = !r.ok && r.problema === 'cena 2: faixa vermelha ausente';
      negativoDetalhe = JSON.stringify(r);
    } finally {
      await navegadorAntes.close().catch(() => {});
    }
    console.log(`\n── controle negativo (develop) ──`);
    console.log(`  ${negativoOk ? '✅' : '❌'} ${negativoOk ? 'reprovou com a mensagem exata "cena 2: faixa vermelha ausente"' : `NÃO reprovou do jeito certo (${negativoDetalhe})`}`);
    if (!negativoOk) problemas.push('controle negativo: a cena 2 não reprovou com a mensagem exata contra a develop');

    console.log('\n── Resultado ──');
    for (const p of pngs) console.log(`  ✅ ${p}`);
    for (const p of problemas) console.log(`  ❌ ${p}`);
    console.log('@@MEDIDAS@@' + JSON.stringify({ problemas, pngs }));
    limpar();
    if (problemas.length) {
      console.log('\n❌ PROVA DE TELA REPROVADA');
      return process.exit(1);
    }
    console.log('\n✅ PROVA DE TELA OK — as cenas passaram e o controle negativo reprovou contra a develop');
    return process.exit(0);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
