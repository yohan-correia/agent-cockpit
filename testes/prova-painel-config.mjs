'use strict';
// PROVA DE TELA — card `painel-de-configuracao-e-miudezas` (fase 3 do plano de 04/09).
//
// Roda DENTRO do container do puppeteer, com `--network host`:
//
//   docker run --rm --network host --entrypoint node \
//     -v <repo>/testes:/w:ro -v <saida>:/out cockpit-smoke:latest \
//     /w/prova-painel-config.mjs <url-antes> <url-depois> <token>
//
// `<url-antes>` é o `develop` servido de /tmp/cockpit-antes; `<url-depois>` é a worktree. Os
// dois com o MESMO HOME de mentira, para a única diferença entre os pares de PNG ser o
// código — que é o que um "antes e depois" tem que provar.
//
// Headless assume tema CLARO: `emulateMediaFeatures` com `prefers-color-scheme: dark` é
// obrigatório, senão o print sai num tema que o usuário não usa.

import puppeteer from '/app/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const [ANTES, DEPOIS, TOKEN] = process.argv.slice(2);
if (!ANTES || !DEPOIS) {
  console.error('🔴 uso: prova-painel-config.mjs <url-antes> <url-depois> [token]');
  process.exit(2);
}

const CELULAR = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 800 };

let falhas = 0;
const ok = (c, texto) => { if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${texto}`); return c; };

const navegador = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

/** Uma aba nova, no tema escuro, já com o token no localStorage ANTES de qualquer script. */
async function abrirPagina(base, viewport) {
  const pagina = await navegador.newPage();
  await pagina.setViewport(viewport);
  await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  const erros = [];
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 300)));
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push('CONSOLE: ' + m.text().slice(0, 300)); });
  // ANTES do goto: os dois <script> leem o localStorage no parse. Injetar depois chega tarde.
  if (TOKEN) await pagina.evaluateOnNewDocument((t) => {
    try { localStorage.setItem('cockpit-token', t); } catch (e) { /* modo privado */ }
  }, TOKEN);
  await pagina.goto(base + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  pagina._erros = erros;
  return pagina;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Clica por seletor, de dentro da página (o `.click()` do puppeteer erra em elemento coberto). */
const clicar = (pagina, sel) => pagina.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  el.click();
  return true;
}, sel);

const cenarios = [];

// ── 1 e 2: o painel de configuração, antes e depois, no celular ──────────
for (const [nome, base] of [['1-config-antes', ANTES], ['2-config-depois', DEPOIS]]) {
  const pagina = await abrirPagina(base, CELULAR);
  ok(await clicar(pagina, '#btn-config'), `${nome}: a engrenagem existe e foi clicada`);
  await espera(400);
  const estado = await pagina.evaluate(() => {
    const d = document.getElementById('dialogo-config');
    const linhas = [...document.querySelectorAll('#dialogo-config .ajuste')];
    const visivel = (el) => el && el.offsetParent !== null;
    return {
      aberto: Boolean(d && d.open),
      // P2-grupos / P2-linhas46: o que a fase 1 entrega e o `develop` não tem.
      grupos: document.querySelectorAll('#dialogo-config .config-grupo').length,
      linhas46: linhas.filter((l) => Math.round(l.getBoundingClientRect().height) >= 46).length,
      chevrons: document.querySelectorAll('#dialogo-config .ajuste-chevron').length,
      valores: [...document.querySelectorAll('#dialogo-config .ajuste-valor')]
        .filter(visivel).map((v) => v.textContent).filter(Boolean),
      rotulos: [...document.querySelectorAll('#dialogo-config .ajuste-rotulo')]
        .filter(visivel).map((r) => r.textContent),
    };
  });
  ok(estado.aberto, `${nome}: o painel está ABERTO na hora do print`);
  cenarios.push({ nome, pagina, estado });
  console.log(`     ${nome}: grupos=${estado.grupos} linhas46=${estado.linhas46} chevrons=${estado.chevrons}`);
  console.log(`     ${nome}: valores=${JSON.stringify(estado.valores)}`);
}

// P2-grupos / P2-linhas46: os asserts que separam o antes do depois. Apontados para o
// "antes" (os dois argumentos iguais) eles têm de FALHAR — é a prova de vermelho do roteiro.
const [antesCfg, depoisCfg] = cenarios;
ok(depoisCfg.estado.grupos === 2, `P2-grupos: o painel tem DOIS grupos por alcance (veio ${depoisCfg.estado.grupos})`);
ok(depoisCfg.estado.linhas46 >= 6, `P2-linhas46: pelo menos 6 linhas com 46px de altura (veio ${depoisCfg.estado.linhas46})`);
ok(depoisCfg.estado.chevrons === 2, `P2-chevron: exatamente 2 chevrons (veio ${depoisCfg.estado.chevrons})`);
ok(antesCfg.estado.grupos === 0, `(referência) o "antes" NÃO tem grupos — é a tela velha (veio ${antesCfg.estado.grupos})`);

// ── 5: a tela de tokens DENTRO do app ────────────────────────────────────
{
  const nome = '5-uso-no-app';
  const pagina = await abrirPagina(DEPOIS, CELULAR);
  const fetchesAntes = await pagina.evaluate(() => window.__uso || 0);
  await clicar(pagina, '#btn-config');
  await espera(200);
  ok(await clicar(pagina, '#btn-uso'), `${nome}: a linha "Para onde vão meus tokens" foi clicada`);
  await espera(900);
  const estado = await pagina.evaluate(() => {
    const d = document.getElementById('dialogo-uso');
    const r = d && d.getBoundingClientRect();
    return {
      aberto: Boolean(d && d.open),
      // Tela cheia até 760px: o diálogo tem que ocupar a viewport inteira.
      largura: r ? Math.round(r.width) : 0,
      altura: r ? Math.round(r.height) : 0,
      viewport: [window.innerWidth, window.innerHeight],
      resumo: (document.getElementById('uso-resumo') || {}).textContent || '',
      temFechar: Boolean(document.getElementById('btn-fechar-uso')),
      configAtras: Boolean((document.getElementById('dialogo-config') || {}).open),
    };
  });
  ok(estado.aberto, `${nome}: #dialogo-uso ABERTO`);
  ok(estado.largura === estado.viewport[0], `P6-telacheia: o diálogo ocupa a largura toda (${estado.largura} de ${estado.viewport[0]})`);
  ok(estado.temFechar, `${nome}: o botão Fechar está no DOM`);
  console.log(`     ${nome}: resumo="${estado.resumo}" configAtras=${estado.configAtras} ${estado.largura}x${estado.altura}`);
  cenarios.push({ nome, pagina, estado });
}

// ── 3 e 4: a tela vazia, antes e depois, no desktop ──────────────────────
for (const [nome, base] of [['3-vazia-antes', ANTES], ['4-vazia-depois', DEPOIS]]) {
  const pagina = await abrirPagina(base, DESKTOP);
  await espera(600);
  const estado = await pagina.evaluate(() => {
    const r = document.getElementById('vazio-resumo');
    return {
      temElemento: Boolean(r),
      texto: r ? r.textContent : '',
      // O `.vazio` continua na tela — a mudança é acréscimo, não substituição.
      vazioVisivel: Boolean(document.getElementById('vazio')),
      nota: (document.getElementById('vazio-nota') || {}).textContent || '',
    };
  });
  console.log(`     ${nome}: temElemento=${estado.temElemento} resumo="${estado.texto}"`);
  cenarios.push({ nome, pagina, estado });
}

// ── os PNGs ──────────────────────────────────────────────────────────────
for (const c of cenarios) {
  await c.pagina.screenshot({ path: `/out/${c.nome}.png` });
  const erros = c.pagina._erros.filter((e) => !/favicon|manifest/i.test(e));
  ok(erros.length === 0, `${c.nome}: sem erro de console/pageerror${erros.length ? ' — ' + erros.join(' | ') : ''}`);
  await c.pagina.close();
}

await navegador.close();
console.log(`\n${falhas ? `❌ ${falhas} falha(s)` : '✅ tudo verde'}`);
process.exit(falhas ? 1 : 0);
