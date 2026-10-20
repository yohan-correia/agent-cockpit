#!/usr/bin/env node
'use strict';
// PROVA DE TELA — a Página de Finanças (D92, spec 2026-10-17-pagina-financas-design.md): o
// modal D90 sai, a carteira abre `financas.html` NA MESMA ABA (P10). Molde `testes/print-prod-fora.js`:
// mundo próprio (socket tmux só dele, `-f /dev/null`, HOME falso), servidor filho em porta
// alta, Chromium do HOST via `PUPPETEER_CORE`/`CHROME_BIN`, fixture falsa (`fixtures-financas`:
// `ana`/`bia`, sete meses), tailscale falso (o clique em Exportar nunca sai da máquina).
//
// CONTROLE NEGATIVO: a cena 1 roda de novo contra a árvore da `develop` (`RAIZ_ANTES`, por
// `git archive`) e TEM de reprovar com a mensagem exata "cena 1: página Finanças ausente" —
// senão o script não provou nada.
//
// MODO DADO REAL (`FINANCAS_REAL=<pasta>`): sem tailscale e sem destino — só asserts
// ESTRUTURAIS, nenhum valor da fixture, sem controle negativo (a feature já está na árvore que roda).
//
// Uso:
//   SAIDA=/tmp/saida PUPPETEER_CORE=<pasta do puppeteer-core> CHROME_BIN=<executável do chrome> \
//     RAIZ_ANTES=<árvore da develop, por git archive> node testes/print-financas.js
//
// Códigos: 0 = ok · 1 = reprovado · 2 = ambiente.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const fx = require('./fixtures-arquivos');
const fxFin = require('./fixtures-financas');

const SAIDA = process.env.SAIDA || '';
const RAIZ_ANTES = process.env.RAIZ_ANTES || '';
const FINANCAS_REAL = process.env.FINANCAS_REAL || '';
const RAIZ_CODIGO = path.join(__dirname, '..');
const PUPPETEER_CORE = process.env.PUPPETEER_CORE || '';
const CHROME_BIN = process.env.CHROME_BIN || '';
const PORTA_DEPOIS = Number(process.env.PORTA_DEPOIS || 7978);
const PORTA_ANTES = Number(process.env.PORTA_ANTES || 7979);
const TOKEN = 'print-financas';
const SOCKET = `cockpit-smoke-financas-${process.pid}`;
const VIEWPORT_DESKTOP = { width: 1600, height: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };
const VIEWPORT_CELULAR = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

if (!SAIDA) { console.error('🟡 SAIDA é obrigatória (pasta dos PNGs).'); process.exit(2); }
// SAIDA nunca dentro do repo, em QUALQUER modo (painel do plano, Claude #7).
{
  const relativo = path.relative(RAIZ_CODIGO, path.resolve(SAIDA));
  const dentroDoRepo = !relativo.startsWith('..') && !path.isAbsolute(relativo);
  if (dentroDoRepo) {
    console.error(`🔴 SAIDA (${SAIDA}) fica DENTRO do repo — abortando. PNG nunca é commitado.`);
    process.exit(2);
  }
}
if (!PUPPETEER_CORE || !CHROME_BIN) {
  console.error('🟡 ambiente indisponível: PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
  process.exit(2);
}
if (!FINANCAS_REAL && !RAIZ_ANTES) {
  console.error('🟡 RAIZ_ANTES é obrigatória (árvore da develop, para o controle negativo) — exceto no modo FINANCAS_REAL.');
  process.exit(2);
}
let puppeteer;
try { puppeteer = require(PUPPETEER_CORE); } catch (e) {
  console.error(`🟡 ambiente indisponível: não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`);
  process.exit(2);
}
if (!fs.existsSync(CHROME_BIN)) { console.error('🟡 ambiente indisponível: CHROME_BIN não existe.'); process.exit(2); }
if (!fs.existsSync(path.join(RAIZ_CODIGO, 'server.js'))) { console.error('🟡 RAIZ_CODIGO não tem o servidor.'); process.exit(2); }
if (RAIZ_ANTES && !fs.existsSync(path.join(RAIZ_ANTES, 'server.js'))) { console.error('🟡 RAIZ_ANTES não tem o servidor.'); process.exit(2); }

function portaOcupada(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-ltn'], { encoding: 'utf8' });
    return saida.split('\n').some((l) => (l.trim().split(/\s+/)[3] || '').endsWith(`:${porta}`));
  } catch { return false; }
}
const PORTAS_A_CHECAR = FINANCAS_REAL ? [PORTA_DEPOIS] : [PORTA_DEPOIS, PORTA_ANTES];
for (const porta of PORTAS_A_CHECAR) {
  if (portaOcupada(porta)) { console.error(`🔴 a porta ${porta} já está em uso — aborta antes de subir qualquer coisa.`); process.exit(2); }
}

// ─── Servidor filho ───────────────────────────────────────────────────────────────────────────

function saude(porta) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/health', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function construirAmbiente({ porta, home, dirFinancas, destinos, bin, sock, scratch }) {
  const ambiente = { ...process.env };
  for (const k of Object.keys(ambiente)) if (k.startsWith('COCKPIT_')) delete ambiente[k];
  delete ambiente.PORT;
  if (bin && /(^|\/)tailscale$/.test(bin)) {
    console.error(`🔴 recuso subir com o tailscale REAL (${bin})`);
    process.exit(1);
  }
  Object.assign(ambiente, {
    HOST: '127.0.0.1', PORT: String(porta), HOME: home,
    COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TOKEN: TOKEN,
    COCKPIT_TMUX_SOCKET: SOCKET,
    COCKPIT_FINANCAS_DIR: dirFinancas,
    COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'), COCKPIT_MONITOR_MS: '0',
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_JOBS_DIR: path.join(scratch, 'jobs-vazio'),
    COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
    COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
    COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
    COCKPIT_VIGIA_PROD_ARQ: path.join(scratch, 'sem-vigia', 'estado.json'),
  });
  if (destinos) ambiente.COCKPIT_FINANCAS_DESTINOS = destinos;
  if (bin) ambiente.COCKPIT_BIN_TAILSCALE = bin;
  if (sock) ambiente.COCKPIT_TAILSCALE_SOCKET = sock;
  if (bin || sock) ambiente.TAILSCALE_FALSO_DORMIR_MS = '0';
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

const quieta = (pagina) => pagina.waitForFunction(() => document.getAnimations()
  .filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).length === 0, { timeout: 5000 }).catch(() => {});

async function novaPagina(navegador, viewport) {
  const pg = await navegador.newPage();
  await pg.setViewport(viewport);
  await pg.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await pg.evaluateOnNewDocument((token) => {
    try {
      localStorage.setItem('cockpit-idioma', 'pt-BR');
      // Explícito nos dois sentidos — localStorage é por ORIGEM; sem isto, estado de uma cena
      // vazaria (via navegador compartilhado) para a cena seguinte.
      localStorage.setItem('cockpit-lateral-fechada', '0');
      // financas.html pode ser a PRIMEIRA página carregada nesta origem (goto direto, sem
      // passar pelo index primeiro) — grava o token de uma vez, pros dois pontos de entrada.
      localStorage.setItem('cockpit-token', token);
    } catch (e) { /* modo privado */ }
  }, TOKEN);
  return pg;
}

async function esperarAte(pagina, condicao, segundos) {
  for (let i = 0; i < segundos * 5; i += 1) {
    // Navegação em curso destrói o contexto NO MEIO do polling (#navegou pra financas.html) —
    // um `evaluate` que falha por isso é "ainda não", nunca um erro fatal pro chamador.
    const resultado = await pagina.evaluate(condicao).catch(() => false);
    if (resultado) return true;
    await espera(200);
  }
  return false;
}

/** Clica `#btn-financas` e espera a navegação pra `financas.html` (P10, mesma aba). */
async function abrirPagina(pg, base) {
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  const temBotao = await esperarAte(pg, () => {
    const b = document.getElementById('btn-financas');
    return Boolean(b) && !b.hidden;
  }, 15);
  if (!temBotao) return { ok: false, problema: 'página Finanças ausente' };
  // O clique pode disparar `location.assign` NO MESMO evaluate — a navegação destrói o
  // contexto de execução antes do round-trip do CDP voltar; o erro aqui é esperado (#sucesso).
  await pg.evaluate(() => { document.getElementById('btn-financas').click(); }).catch(() => {});
  const navegou = await esperarAte(pg, () => location.href.includes('financas.html'), 15);
  if (!navegou) return { ok: false, problema: 'página Finanças ausente' };
  const carregou = await esperarAte(pg, () => document.getElementById('pagina-financas') !== null, 15);
  if (!carregou) return { ok: false, problema: 'página Finanças ausente' };
  return { ok: true };
}

// ─── Cena 0 — ANTES: o modal D90 (controle de referência, só RAIZ_ANTES) ───────────────────

async function cena0(navegador, base, viewport, nomePng) {
  const pg = await novaPagina(navegador, viewport);
  await pg.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
  const temBotao = await esperarAte(pg, () => {
    const b = document.getElementById('btn-financas');
    return Boolean(b) && !b.hidden;
  }, 15);
  if (!temBotao) { await pg.close(); return { ok: false, problema: `${nomePng}: botão Finanças ausente` }; }
  await pg.evaluate(() => { document.getElementById('btn-financas').click(); });
  const abriuOk = await esperarAte(pg, () => {
    const d = document.getElementById('dialogo-financas');
    return Boolean(d) && d.open && document.querySelectorAll('#dialogo-financas .financas-kpi').length > 0;
  }, 15);
  if (!abriuOk) { await pg.close(); return { ok: false, problema: `${nomePng}: diálogo com KPIs não abriu` }; }
  const png = path.join(SAIDA, nomePng);
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

// ─── Cena 1 — desktop, Casa: página inteira, sanfona da tabela ─────────────────────────────

async function cena1(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_DESKTOP);
  const aberto = await abrirPagina(pg, base);
  if (!aberto.ok) { await pg.close(); return { ok: false, problema: `cena 1: ${aberto.problema}` }; }

  const tabelaOk = await esperarAte(pg, () => document.querySelectorAll('#fin-tabela .fin-celula').length > 0, 15);
  if (!tabelaOk) { await pg.close(); return { ok: false, problema: 'cena 1: #fin-tabela .fin-celula não apareceu' }; }

  const casaAtiva = await pg.evaluate(() => {
    const b = document.querySelector('#fin-visoes button[aria-pressed="true"]');
    return Boolean(b) && b.textContent.includes('Casa');
  });
  if (!casaAtiva) { await pg.close(); return { ok: false, problema: 'cena 1: Casa não está ativa por padrão' }; }

  const clicou = await pg.evaluate(() => {
    const btn = document.querySelector('#fin-tabela .fin-celula[data-cat="Mercado"][data-mes="2026-02"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicou) { await pg.close(); return { ok: false, problema: 'cena 1: célula "Mercado" de 2026-02 (último mês completo) não encontrada' }; }

  const abriuSanfona = await esperarAte(pg, () => {
    const linhas = document.querySelectorAll('#fin-tabela tr.fin-abre .fin-lanc');
    const h3 = document.querySelector('#fin-tabela tr.fin-abre h3');
    return linhas.length >= 1 && Boolean(h3) && h3.textContent.includes('lançamentos');
  }, 10);
  if (!abriuSanfona) { await pg.close(); return { ok: false, problema: 'cena 1: a sanfona da tabela não abriu com lançamentos' }; }

  const dados = await pg.evaluate(() => ({
    kpis: document.querySelectorAll('#fin-kpis .fin-kpi').length,
    svgRenda: Boolean(document.querySelector('#fin-rendagasto svg')),
    svgEmpilhado: Boolean(document.querySelector('#fin-empilhado svg')),
    colunas: getComputedStyle(document.querySelector('.fin-conteudo')).gridTemplateColumns.trim().split(/\s+/).length,
  }));
  const problemas = [];
  if (dados.kpis < 1) problemas.push('#fin-kpis sem cartões');
  if (!dados.svgRenda) problemas.push('#fin-rendagasto sem SVG');
  if (!dados.svgEmpilhado) problemas.push('#fin-empilhado sem SVG');
  if (dados.colunas < 2) problemas.push(`grade com menos de 2 colunas (veio ${dados.colunas})`);
  if (problemas.length) { await pg.close(); return { ok: false, problema: `cena 1: ${problemas.join('; ')}` }; }

  const png = path.join(SAIDA, '01-desktop-casa-sanfona.png');
  await quieta(pg);
  await pg.screenshot({ path: png, fullPage: true });
  await pg.close();
  return { ok: true, png };
}

// ─── Cena 2 — desktop: menu Exportar ────────────────────────────────────────────────────────

async function cena2(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_DESKTOP);
  const aberto = await abrirPagina(pg, base);
  if (!aberto.ok) { await pg.close(); return { ok: false, problema: `cena 2: ${aberto.problema}` }; }

  await esperarAte(pg, () => document.querySelectorAll('#fin-tabela .fin-celula').length > 0, 15);
  await pg.evaluate(() => { document.getElementById('fin-exportar').click(); });
  const abriu = await esperarAte(pg, () => {
    const menu = document.getElementById('fin-exportar-menu');
    return Boolean(menu) && !menu.hidden;
  }, 10);
  if (!abriu) { await pg.close(); return { ok: false, problema: 'cena 2: #fin-exportar-menu não abriu' }; }

  const dados = await pg.evaluate(() => ({
    pdf: Boolean(document.querySelector('input[name="fin-formato"][value="pdf"]')),
    xlsx: Boolean(document.querySelector('input[name="fin-formato"][value="xlsx"]')),
    baixar: Boolean(document.querySelector('input[name="fin-destino"][value="baixar"]')),
    destinos: [...document.querySelectorAll('#fin-destinos label')].map((l) => l.textContent),
  }));
  const problemas = [];
  if (!dados.pdf) problemas.push('rádio PDF ausente');
  if (!dados.xlsx) problemas.push('rádio Excel ausente');
  if (!dados.baixar) problemas.push('rádio "Baixar neste aparelho" ausente');
  if (!dados.destinos.some((t) => t.includes('galaxy-falso'))) problemas.push(`destino "galaxy-falso" ausente (veio ${JSON.stringify(dados.destinos)})`);
  if (problemas.length) { await pg.close(); return { ok: false, problema: `cena 2: ${problemas.join('; ')}` }; }

  const png = path.join(SAIDA, '02-desktop-exportar.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

// ─── Cena 3 — celular, Ana: tabela rolada de lado, sanfona dentro da caixa ────────────────

async function cena3(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_CELULAR);
  const aberto = await abrirPagina(pg, base);
  if (!aberto.ok) { await pg.close(); return { ok: false, problema: `cena 3: ${aberto.problema}` }; }

  await esperarAte(pg, () => document.querySelectorAll('#fin-visoes button').length >= 2, 15);
  const tocouAna = await pg.evaluate(() => {
    const b = [...document.querySelectorAll('#fin-visoes button')].find((x) => x.textContent === 'Ana');
    if (b) b.click();
    return Boolean(b);
  });
  if (!tocouAna) { await pg.close(); return { ok: false, problema: 'cena 3: não achei o botão de visão "Ana"' }; }

  await esperarAte(pg, () => document.querySelectorAll('#fin-tabela .fin-celula').length > 0, 15);
  const rolagemAntes = await pg.evaluate(() => {
    const rolagem = document.querySelector('#fin-tabela .fin-rolagem');
    if (rolagem) rolagem.scrollLeft = rolagem.scrollWidth;
    return rolagem ? rolagem.scrollLeft : 0;
  });
  if (!(rolagemAntes > 0)) { await pg.close(); return { ok: false, problema: `cena 3: a tabela não rolou de lado no celular (scrollLeft ${rolagemAntes})` }; }
  const clicou = await pg.evaluate(() => {
    const btn = document.querySelector('#fin-tabela .fin-celula[data-cat="Mercado"][data-mes="2026-02"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicou) { await pg.close(); return { ok: false, problema: 'cena 3: célula "Mercado" de 2026-02 não encontrada' }; }

  const abriuSanfona = await esperarAte(pg, () => document.querySelectorAll('#fin-tabela tr.fin-abre .fin-lanc').length >= 1, 10);
  if (!abriuSanfona) { await pg.close(); return { ok: false, problema: 'cena 3: a sanfona da tabela não abriu' }; }

  const dados = await pg.evaluate(() => {
    const lista = document.querySelector('#fin-tabela tr.fin-abre .fin-lista');
    const rolagem = document.querySelector('#fin-tabela .fin-rolagem');
    const l = lista.getBoundingClientRect();
    const r = rolagem.getBoundingClientRect();
    return {
      dentro: l.left >= r.left - 1 && l.right <= r.right + 1,
      topoEstatico: getComputedStyle(document.querySelector('.fin-topo')).position === 'static',
      rolagemDepois: rolagem.scrollLeft,
    };
  });
  const problemas = [];
  // Tocar não pode devolver a tabela pro primeiro mês (o redesenho trocava a `.fin-rolagem`).
  if (Math.abs(dados.rolagemDepois - rolagemAntes) > 2) problemas.push(`a tabela voltou de ${rolagemAntes}px pra ${dados.rolagemDepois}px de rolagem ao tocar`);
  if (!dados.dentro) problemas.push('a lista aberta saiu da caixa do .fin-rolagem');
  if (!dados.topoEstatico) problemas.push('.fin-topo não está position:static no celular (P2)');
  if (problemas.length) { await pg.close(); return { ok: false, problema: `cena 3: ${problemas.join('; ')}` }; }

  await pg.evaluate(() => { document.querySelector('#fin-tabela tr.fin-abre').scrollIntoView({ block: 'center' }); });
  const png = path.join(SAIDA, '03-celular-tabela-sanfona.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

// ─── Cena 4 — celular: menu Exportar inteiro dentro da largura da tela ─────────────────────

async function cena4(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_CELULAR);
  const aberto = await abrirPagina(pg, base);
  if (!aberto.ok) { await pg.close(); return { ok: false, problema: `cena 4: ${aberto.problema}` }; }

  await esperarAte(pg, () => document.querySelectorAll('#fin-tabela .fin-celula').length > 0, 15);
  await pg.evaluate(() => { document.getElementById('fin-exportar').click(); });
  const abriu = await esperarAte(pg, () => {
    const menu = document.getElementById('fin-exportar-menu');
    return Boolean(menu) && !menu.hidden;
  }, 10);
  if (!abriu) { await pg.close(); return { ok: false, problema: 'cena 4: #fin-exportar-menu não abriu' }; }

  const dentroDaTela = await pg.evaluate(() => {
    const r = document.getElementById('fin-exportar-menu').getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth;
  });
  if (!dentroDaTela) { await pg.close(); return { ok: false, problema: 'cena 4: #fin-exportar-menu saiu da largura da tela' }; }

  const png = path.join(SAIDA, '04-celular-exportar.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

// ─── Cena 5 — celular: Mês em detalhe, abre uma categoria ──────────────────────────────────

async function cena5(navegador, base) {
  const pg = await novaPagina(navegador, VIEWPORT_CELULAR);
  const aberto = await abrirPagina(pg, base);
  if (!aberto.ok) { await pg.close(); return { ok: false, problema: `cena 5: ${aberto.problema}` }; }

  const detalheOk = await esperarAte(pg, () => document.querySelectorAll('#fin-detalhe .fin-cat').length > 0, 15);
  if (!detalheOk) { await pg.close(); return { ok: false, problema: 'cena 5: #fin-detalhe .fin-cat não apareceu' }; }

  await pg.evaluate(() => {
    const cat = document.querySelector('#fin-detalhe .fin-cat');
    cat.scrollIntoView({ block: 'center' });
    cat.click();
  });
  const abriuLista = await esperarAte(pg, () => document.querySelectorAll('#fin-detalhe .fin-lista:not([hidden]) .fin-lanc').length > 0, 10);
  if (!abriuLista) { await pg.close(); return { ok: false, problema: 'cena 5: a lista da categoria não abriu' }; }

  const temPct = await pg.evaluate(() => /%/.test(document.getElementById('fin-detalhe').textContent));
  if (!temPct) { await pg.close(); return { ok: false, problema: 'cena 5: nenhum "%" no texto de #fin-detalhe' }; }

  const png = path.join(SAIDA, '05-celular-detalhe.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

// ─── Cena 6 — celular: Exportar Excel por Taildrop pra galaxy-falso (visão Ana) ────────────

async function cena6(navegador, base, chamadasLog) {
  const pg = await novaPagina(navegador, VIEWPORT_CELULAR);
  const aberto = await abrirPagina(pg, base);
  if (!aberto.ok) { await pg.close(); return { ok: false, problema: `cena 6: ${aberto.problema}` }; }

  await esperarAte(pg, () => document.querySelectorAll('#fin-visoes button').length >= 2, 15);
  const abrirMenu = async () => {
    await pg.evaluate(() => { if (document.getElementById('fin-exportar-menu').hidden) document.getElementById('fin-exportar').click(); });
    return esperarAte(pg, () => {
      const menu = document.getElementById('fin-exportar-menu');
      return Boolean(menu) && !menu.hidden;
    }, 10);
  };
  if (!(await abrirMenu())) { await pg.close(); return { ok: false, problema: 'cena 6: #fin-exportar-menu não abriu' }; }

  // Escolhe Excel + Taildrop ANTES de trocar a visão: trocar redesenha os rádios, e a escolha
  // tem de sobreviver (painel de execução — antes, nenhum rádio ficava marcado e o Exportar morria).
  const marcou = await pg.evaluate(() => {
    const xlsx = document.querySelector('input[name="fin-formato"][value="xlsx"]');
    const destino = [...document.querySelectorAll('input[name="fin-destino"]')].find((r) => r.value !== 'baixar');
    if (!xlsx || !destino) return false;
    xlsx.checked = true;
    destino.checked = true;
    return true;
  });
  if (!marcou) { await pg.close(); return { ok: false, problema: 'cena 6: não achei os rádios Excel/galaxy-falso' }; }

  const tocouAna = await pg.evaluate(() => {
    const b = [...document.querySelectorAll('#fin-visoes button')].find((x) => x.textContent === 'Ana');
    if (b) b.click();
    return Boolean(b);
  });
  if (!tocouAna) { await pg.close(); return { ok: false, problema: 'cena 6: não achei o botão de visão "Ana"' }; }
  if (!(await abrirMenu())) { await pg.close(); return { ok: false, problema: 'cena 6: #fin-exportar-menu não reabriu depois de trocar a visão' }; }
  const sobreviveu = await pg.evaluate(() => {
    const r = document.querySelector('input[name="fin-destino"]:checked');
    return r ? r.value : null;
  });
  if (sobreviveu !== 'galaxy-falso') { await pg.close(); return { ok: false, problema: `cena 6: depois de trocar a visão o destino marcado virou ${JSON.stringify(sobreviveu)}` }; }

  await pg.evaluate(() => { document.getElementById('fin-exportar-ir').click(); });
  const enviou = await esperarAte(pg, () => document.getElementById('fin-exportar-status').textContent.includes('enviado para galaxy-falso'), 5);
  if (!enviou) {
    const atual = await pg.evaluate(() => document.getElementById('fin-exportar-status').textContent);
    await pg.close();
    return { ok: false, problema: `cena 6: #fin-exportar-status não chegou a "enviado para galaxy-falso" em 5 s (veio "${atual}")` };
  }

  const png = path.join(SAIDA, '06-celular-exportado.png');
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();

  const log = fs.existsSync(chamadasLog) ? fs.readFileSync(chamadasLog, 'utf8') : '';
  if (!/ana\.xlsx/.test(log)) return { ok: false, problema: `cena 6: chamadas.log sem "ana.xlsx" (veio ${log})` };
  return { ok: true, png };
}

// ─── Cena 7 — desktop, Casa com BURACO (Codex #2): bia.lancamentos.json ilegível ──────────

async function cena7(navegador, base, dirFinancas) {
  const bancoBia = path.join(dirFinancas, 'bia.lancamentos.json');
  const original = fs.readFileSync(bancoBia, 'utf8');
  fs.writeFileSync(bancoBia, 'isto nao e json');
  try {
    const pg = await novaPagina(navegador, VIEWPORT_DESKTOP);
    const aberto = await abrirPagina(pg, base);
    if (!aberto.ok) { await pg.close(); return { ok: false, problema: `cena 7: ${aberto.problema}` }; }

    const prontoOk = await esperarAte(pg, () => {
      const avisos = document.getElementById('fin-avisos');
      return Boolean(avisos) && avisos.textContent.includes('faltam os lançamentos de Bia');
    }, 15);
    if (!prontoOk) { await pg.close(); return { ok: false, problema: 'cena 7: aviso "faltam os lançamentos de Bia" não apareceu' }; }

    const dados = await pg.evaluate(() => {
      const secoes = ['fin-empilhado', 'fin-detalhe', 'fin-tabela', 'fin-maiores', 'fin-fora'];
      return {
        faltando: secoes.every((id) => document.getElementById(id).textContent.includes('faltam os lançamentos de Bia')),
        semCelula: document.querySelectorAll('#fin-tabela .fin-celula').length === 0,
        semCat: document.querySelectorAll('#fin-detalhe .fin-cat').length === 0,
        semSvg: document.querySelectorAll('#fin-empilhado svg').length === 0,
        kpis: document.querySelectorAll('#fin-kpis .fin-kpi').length,
        svgRenda: Boolean(document.querySelector('#fin-rendagasto svg')),
        fatura: document.getElementById('fin-fora').textContent.includes('Fatura do cartão em'),
      };
    });
    const problemas = [];
    if (!dados.faltando) problemas.push('nem todas as 5 seções derivadas mostram "faltam os lançamentos de Bia"');
    if (!dados.semCelula) problemas.push('#fin-tabela ainda tem .fin-celula');
    if (!dados.semCat) problemas.push('#fin-detalhe ainda tem .fin-cat');
    if (!dados.semSvg) problemas.push('#fin-empilhado ainda tem SVG');
    if (dados.kpis < 1) problemas.push('#fin-kpis sem cartões (deveria seguir desenhado, vem do resumo)');
    if (!dados.svgRenda) problemas.push('#fin-rendagasto sem SVG (deveria seguir desenhado, vem do resumo)');
    if (!dados.fatura) problemas.push('#fin-fora sem a linha "Fatura do cartão em" (D90 não pode sumir)');
    if (problemas.length) { await pg.close(); return { ok: false, problema: `cena 7: ${problemas.join('; ')}` }; }

    const png = path.join(SAIDA, '07-desktop-casa-com-buraco.png');
    await quieta(pg);
    await pg.screenshot({ path: png, fullPage: true });
    await pg.close();
    return { ok: true, png };
  } finally {
    fs.writeFileSync(bancoBia, original);
  }
}

// ─── Modo dado real: asserts ESTRUTURAIS, nenhum valor da fixture ───────────────────────────

async function cenaReal(navegador, base, viewport, nomePng) {
  const pg = await novaPagina(navegador, viewport);
  const erros = [];
  pg.on('pageerror', (e) => erros.push(String(e)));
  pg.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  const aberto = await abrirPagina(pg, base);
  if (!aberto.ok) { await pg.close(); return { ok: false, problema: `${nomePng}: ${aberto.problema}` }; }

  const prontoOk = await esperarAte(pg, () => {
    const visoes = document.querySelectorAll('#fin-visoes button').length;
    const kpis = document.querySelectorAll('#fin-kpis .fin-kpi').length;
    const carimbo = document.getElementById('fin-carimbo').textContent;
    return visoes >= 1 && kpis >= 1 && carimbo.startsWith('dados até');
  }, 15);
  if (!prontoOk) { await pg.close(); return { ok: false, problema: `${nomePng}: estrutura esperada não apareceu (≥1 visão, ≥1 KPI, "dados até")` }; }
  if (erros.length) { await pg.close(); return { ok: false, problema: `${nomePng}: console/pageerror (${erros.join(' | ')})` }; }

  const png = path.join(SAIDA, nomePng);
  await quieta(pg);
  await pg.screenshot({ path: png });
  await pg.close();
  return { ok: true, png };
}

// ─── Corrida ──────────────────────────────────────────────────────────────────────────────────

(async () => {
  let scratch = null;
  const servidores = [];

  function limpar() {
    for (const s of servidores) {
      if (s && s.exitCode === null) { try { process.kill(s.pid); } catch { /* já morreu */ } }
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-financas-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    const dirFinancas = path.join(scratch, 'financas');

    const problemas = [];
    const pngs = [];

    if (FINANCAS_REAL) {
      // ─── Modo dado real: SEM tailscale, SEM destino ───
      const ambiente = construirAmbiente({ porta: PORTA_DEPOIS, home, dirFinancas: FINANCAS_REAL, destinos: null, bin: null, sock: null, scratch });
      const depois = await subir(RAIZ_CODIGO, ambiente, PORTA_DEPOIS);
      servidores.push(depois);
      console.log(`  · servidor "depois" (dado real) no ar em http://127.0.0.1:${PORTA_DEPOIS} (pid ${depois.pid})`);
      const base = `http://127.0.0.1:${PORTA_DEPOIS}/?token=${TOKEN}`;

      const navegador = await puppeteer.launch({ executablePath: CHROME_BIN, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      try {
        const r1 = await cenaReal(navegador, base, VIEWPORT_DESKTOP, 'real-desktop.png');
        if (r1.ok) pngs.push(r1.png); else problemas.push(r1.problema);
        const r2 = await cenaReal(navegador, base, VIEWPORT_CELULAR, 'real-celular.png');
        if (r2.ok) pngs.push(r2.png); else problemas.push(r2.problema);
      } finally {
        await navegador.close().catch(() => {});
      }
    } else {
      // ─── Mundo de mentira: tailscale falso + fixture ana/bia (7 meses) ───
      fxFin.plantarMundo(dirFinancas);
      fx.montarInbox(scratch); // o binarioFalso exige o inbox
      const bin = fx.binarioFalso(scratch);
      const sock = path.join(scratch, 'ts.sock');
      const estadoSock = {};
      const s = fx.socketFalso(sock, estadoSock);
      await s.pronto;
      const chamadasLog = path.join(scratch, 'chamadas.log');

      try {
        const ambiente = construirAmbiente({ porta: PORTA_DEPOIS, home, dirFinancas, destinos: 'galaxy-falso', bin, sock, scratch });
        const depois = await subir(RAIZ_CODIGO, ambiente, PORTA_DEPOIS);
        servidores.push(depois);
        console.log(`  · servidor "depois" no ar em http://127.0.0.1:${PORTA_DEPOIS} (pid ${depois.pid}), socket ${SOCKET}`);
        const base = `http://127.0.0.1:${PORTA_DEPOIS}/?token=${TOKEN}`;

        const navegador = await puppeteer.launch({ executablePath: CHROME_BIN, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        try {
          const r1 = await cena1(navegador, base);
          if (r1.ok) pngs.push(r1.png); else problemas.push(r1.problema);
          const r2 = await cena2(navegador, base);
          if (r2.ok) pngs.push(r2.png); else problemas.push(r2.problema);
          const r3 = await cena3(navegador, base);
          if (r3.ok) pngs.push(r3.png); else problemas.push(r3.problema);
          const r4 = await cena4(navegador, base);
          if (r4.ok) pngs.push(r4.png); else problemas.push(r4.problema);
          const r5 = await cena5(navegador, base);
          if (r5.ok) pngs.push(r5.png); else problemas.push(r5.problema);
          const r6 = await cena6(navegador, base, chamadasLog);
          if (r6.ok) pngs.push(r6.png); else problemas.push(r6.problema);
          const r7 = await cena7(navegador, base, dirFinancas);
          if (r7.ok) pngs.push(r7.png); else problemas.push(r7.problema);
        } finally {
          await navegador.close().catch(() => {});
        }

        // ─── Cena 0 (antes) + CONTROLE NEGATIVO: a cena 1 contra a develop TEM de reprovar ───
        const ambienteAntes = construirAmbiente({ porta: PORTA_ANTES, home, dirFinancas, destinos: 'galaxy-falso', bin, sock, scratch });
        const antes = await subir(RAIZ_ANTES, ambienteAntes, PORTA_ANTES);
        servidores.push(antes);
        console.log(`  · servidor "antes" (develop) no ar em http://127.0.0.1:${PORTA_ANTES} (pid ${antes.pid})`);
        const baseAntes = `http://127.0.0.1:${PORTA_ANTES}/?token=${TOKEN}`;
        const navegadorAntes = await puppeteer.launch({ executablePath: CHROME_BIN, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        let negativoOk = false;
        let negativoDetalhe = '';
        try {
          const r0d = await cena0(navegadorAntes, baseAntes, VIEWPORT_DESKTOP, '00-antes-modal-desktop.png');
          if (r0d.ok) pngs.push(r0d.png); else problemas.push(r0d.problema);
          const r0c = await cena0(navegadorAntes, baseAntes, VIEWPORT_CELULAR, '00-antes-modal-celular.png');
          if (r0c.ok) pngs.push(r0c.png); else problemas.push(r0c.problema);

          const r = await cena1(navegadorAntes, baseAntes);
          negativoOk = !r.ok && r.problema === 'cena 1: página Finanças ausente';
          negativoDetalhe = JSON.stringify(r);
        } finally {
          await navegadorAntes.close().catch(() => {});
        }
        console.log('\n── controle negativo (develop) ──');
        console.log(`  ${negativoOk ? '✅' : '❌'} ${negativoOk ? 'reprovou com a mensagem exata "cena 1: página Finanças ausente"' : `NÃO reprovou do jeito certo (${negativoDetalhe})`}`);
        if (!negativoOk) problemas.push('controle negativo: a cena 1 não reprovou com a mensagem exata contra a develop');
      } finally {
        s.fechar();
      }
    }

    console.log('\n── Resultado ──');
    for (const p of pngs) console.log(`  ✅ ${p}`);
    for (const p of problemas) console.log(`  ❌ ${p}`);
    limpar();
    if (problemas.length) {
      console.log('\n❌ PROVA DE TELA REPROVADA');
      return process.exit(1);
    }
    console.log(FINANCAS_REAL
      ? '\n✅ PROVA DE TELA OK (dado real) — as cenas estruturais passaram'
      : '\n✅ PROVA DE TELA OK — as cenas passaram e o controle negativo reprovou contra a develop');
    return process.exit(0);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
