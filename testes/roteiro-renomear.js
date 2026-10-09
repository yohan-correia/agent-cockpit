'use strict';
// O ROTEIRO DO NAVEGADOR do `smoke-navegador-renomear.js` — roda DENTRO do container
// (`cockpit-smoke:latest`), nunca no host. Arquivo próprio pelo mesmo motivo do
// `roteiro-conversa-transicoes.js`: crase e `${}` de verdade, sem template string por fora.
//
// Entrada, por ambiente: BASE · CELULAR_DE · CELULAR_PARA · DESKTOP_DE · DESKTOP_PARA. O celular
// renomeia CELULAR_DE para um nome LONGO (CELULAR_PARA); o desktop faz o hover NESSA linha — nome
// longo, ✎ e ⧉ juntos, o layout mais apertado — e a renomeia de novo (DESKTOP_DE → DESKTOP_PARA).
// Saída: PNGs em /out e um JSON depois do marcador @@RENOMEAR@@ no stdout — `{ passos, gerados }`.

const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const {
  CELULAR_DE: ALVO_CELULAR, CELULAR_PARA: NOVO_CELULAR, DESKTOP_DE: ALVO_DESKTOP, DESKTOP_PARA: NOVO_DESKTOP,
} = process.env;
const ABAS_ESPERADAS = 4;
// Escopado pela seção de abas (#44): o grupo de jobs usa a mesma marcação de linha.
const LINHAS = '#lista-conversas .conversa-linha';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const passos = [];
const gerados = [];
const exigir = (condicao, texto) => { passos.push({ ok: Boolean(condicao), texto }); return Boolean(condicao); };

async function abrir(navegador, viewport, rotulo) {
  const pagina = await navegador.newPage();
  const erros = [];
  const falhas = [];
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push(`PAGEERROR: ${String(e).slice(0, 200)}`));
  pagina.on('response', (r) => {
    if (r.status() >= 400) falhas.push(`${r.request().method()} ${r.status()} ${new URL(r.url()).pathname}`);
  });
  await pagina.setViewport(viewport);
  await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  // ANTES do goto: o i18n lê a chave no carregamento (dentro do container o padrão seria 'en').
  await pagina.evaluateOnNewDocument(() => {
    try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* vale nesta página */ }
  });
  await pagina.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await pagina.waitForSelector(LINHAS, { timeout: 15000 });
  await espera(700);
  const comEstilo = await pagina.evaluate(() => Array.from(document.styleSheets).some((f) => {
    try { return f.cssRules.length > 0; } catch (e) { return false; }
  }));
  exigir(comEstilo, `${rotulo}: a folha de estilo carregou (sem ela todo o resto mente)`);
  return { pagina, erros, falhas };
}

/** O estado do ✎ em cada linha de aba — o que o CSS de VERDADE decidiu. */
function estadoDosLapis(pagina) {
  return pagina.evaluate((seletor) => Array.from(document.querySelectorAll(seletor)).map((linha) => {
    const nome = linha.querySelector('.conversa-nome');
    const lapis = linha.querySelector('.renomear-aba');
    const cs = lapis ? getComputedStyle(lapis) : null;
    const r = lapis ? lapis.getBoundingClientRect() : null;
    const rl = linha.getBoundingClientRect();
    const rn = nome ? nome.getBoundingClientRect() : null;
    const aoLado = linha.querySelector('.abrir-ao-lado');
    const ra = aoLado && getComputedStyle(aoLado).display !== 'none' ? aoLado.getBoundingClientRect() : null;
    // 0,5 px de folga: no toque o ✎ começa EXATAMENTE onde a vaga do nome termina (40 px), e
    // arredondamento de subpixel faria "encostar" virar "cruzar".
    const F = 0.5;
    const cruza = (a, b) => Boolean(a && b && a.width > 0 && b.width > 0
      && !(a.right <= b.left + F || a.left >= b.right - F || a.bottom <= b.top + F || a.top >= b.bottom - F));
    return {
      nome: nome ? nome.textContent : '',
      existe: Boolean(lapis),
      visivel: Boolean(cs && cs.display !== 'none' && cs.visibility !== 'hidden' && r && r.width > 0),
      largura: r ? Math.round(r.width) : 0,
      altura: r ? Math.round(r.height) : 0,
      dentroDaLinha: Boolean(r && r.left >= rl.left - 0.5 && r.right <= rl.right + 0.5
        && r.top >= rl.top - 0.5 && r.bottom <= rl.bottom + 0.5),
      cobreNome: cruza(r, rn),
      cruzaAoLado: cruza(r, ra),
      aoLadoVisivel: Boolean(ra && ra.width > 0 && ra.height > 0),
    };
  }), LINHAS);
}

async function linhaDe(pagina, nome) {
  const h = await pagina.evaluateHandle((seletor, n) => Array.from(document.querySelectorAll(seletor))
    .find((l) => (l.querySelector('.conversa-nome') || {}).textContent === n) || null, LINHAS, nome);
  return h.asElement();
}

async function lapisDe(pagina, nome) {
  const h = await pagina.evaluateHandle((seletor, n) => {
    const linha = Array.from(document.querySelectorAll(seletor))
      .find((l) => (l.querySelector('.conversa-nome') || {}).textContent === n);
    return linha ? linha.querySelector('.renomear-aba') : null;
  }, LINHAS, nome);
  return h.asElement();
}

const nomesDaLista = (pagina) => pagina.evaluate((seletor) => Array.from(document.querySelectorAll(seletor))
  .map((l) => (l.querySelector('.conversa-nome') || {}).textContent || ''), LINHAS);

const esperarRenomeada = (pagina, novo) => pagina.waitForFunction((n, seletor) => !document.querySelector('#dialogo-renomear-aba').open
  && Array.from(document.querySelectorAll(seletor)).some((l) => (l.querySelector('.conversa-nome') || {}).textContent === n),
{ timeout: 8000 }, novo, LINHAS).catch(() => {});

async function fotografar(pagina, nome, { recorte = false } = {}) {
  // O `<dialog>` abre e fecha com transição (160 ms, `estilo.css`): sem esperar, o print sai com o
  // diálogo meio transparente por cima da lista — e o `open` já diz `false` no meio do fechamento.
  // Espera só as animações FINITAS: o pino de "trabalhando" pulsa para sempre e travaria aqui.
  await pagina.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity)
    .map((a) => a.finished.catch(() => {}))));
  await espera(120);
  await pagina.screenshot({ path: `/out/${nome}.png` });
  gerados.push(`${nome}.png`);
  if (!recorte) return;
  // No desktop a lista é uma coluna de 320 px numa tela de 1600: o recorte é o que deixa o lápis
  // de 24 px LEGÍVEL no print.
  const lateral = await pagina.$('.lateral');
  const caixa = lateral && await lateral.boundingBox();
  if (caixa) {
    await pagina.screenshot({ path: `/out/${nome}-lista.png`, clip: caixa });
    gerados.push(`${nome}-lista.png`);
  }
}

/**
 * Emula o aparelho COM MOUSE. O Chromium headless responde `hover: none` até no desktop (armadilha
 * #66; CDP e --blink-settings não mudam isso, medido em 11/09), então nenhuma regra sob
 * `@media (hover: hover)` dispararia aqui. Reescreve as condições de mídia da folha do app:
 * `(hover: hover)` vira `(min-width: 0px)` (sempre verdade) e toda regra de `(hover: none)` vira
 * `not all` (nunca). Devolve quantas trocou — zero é defeito do roteiro, não do app.
 */
function emularMouse(pagina) {
  return pagina.evaluate(() => {
    let trocadas = 0;
    const visitar = (regras) => {
      for (const regra of Array.from(regras)) {
        if (regra.media && typeof regra.media.mediaText === 'string') {
          const texto = regra.media.mediaText;
          if (/\(\s*hover\s*:\s*hover\s*\)/.test(texto)) {
            regra.media.mediaText = texto.replace(/\(\s*hover\s*:\s*hover\s*\)/g, '(min-width: 0px)');
            trocadas += 1;
          } else if (/\(\s*hover\s*:\s*none\s*\)/.test(texto)) {
            regra.media.mediaText = 'not all';
            trocadas += 1;
          }
        }
        if (regra.cssRules) visitar(regra.cssRules);
      }
    };
    for (const folha of Array.from(document.styleSheets)) {
      try { visitar(folha.cssRules); } catch (e) { /* folha de outra origem: não é do app */ }
    }
    return trocadas;
  });
}

async function celular(navegador) {
  const { pagina, erros, falhas } = await abrir(navegador,
    { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, 'celular');
  try {
    exigir(await pagina.evaluate(() => matchMedia('(hover: none)').matches),
      'celular: o aparelho responde (hover: none) — o toque de verdade, SEM emulação');
    const estado = await estadoDosLapis(pagina);
    exigir(estado.length === ABAS_ESPERADAS, `celular: a lista tem ${ABAS_ESPERADAS} abas (${estado.length})`);
    exigir(estado.length > 0 && estado.every((e) => e.existe && e.visivel),
      `celular: o ✎ está VISÍVEL em todas as linhas, sem tocar em nada (${JSON.stringify(estado.map((e) => [e.nome, e.visivel]))})`);
    exigir(estado.length > 0 && estado.every((e) => e.largura >= 40 && e.altura >= 40),
      `celular: alvo de toque de 40 px (${estado.map((e) => `${e.largura}x${e.altura}`).join(', ')})`);
    exigir(estado.length > 0 && estado.every((e) => e.dentroDaLinha && !e.cobreNome),
      `celular: o ✎ fica dentro da linha e não cobre o nome (${JSON.stringify(estado)})`);
    await fotografar(pagina, 'celular-1-lista');

    const lapis = await lapisDe(pagina, ALVO_CELULAR);
    if (!exigir(Boolean(lapis), `celular: achei o ✎ de ${ALVO_CELULAR}`)) return;
    await lapis.tap();
    await pagina.waitForSelector('#dialogo-renomear-aba[open]', { timeout: 5000 }).catch(() => {});
    const aberto = await pagina.evaluate(() => ({
      open: document.querySelector('#dialogo-renomear-aba').open,
      valor: document.querySelector('#nome-aba').value,
      paineis: document.querySelectorAll('#paineis .painel').length,
    }));
    exigir(aberto.open, 'celular: tocar o ✎ abre o diálogo');
    exigir(aberto.valor === ALVO_CELULAR, `celular: o campo nasce com o nome atual (${aberto.valor})`);
    exigir(aberto.paineis === 0, `celular: e NENHUMA conversa abriu por baixo (${aberto.paineis} painel)`);
    await fotografar(pagina, 'celular-2-dialogo');

    await pagina.$eval('#nome-aba', (el) => { el.value = ''; });
    await pagina.tap('#btn-confirma-renomear-aba');
    await pagina.waitForFunction(() => /vazio/.test(document.querySelector('#nota-renomear-aba').textContent),
      { timeout: 5000 }).catch(() => {});
    const recusa = await pagina.evaluate(() => ({
      open: document.querySelector('#dialogo-renomear-aba').open,
      nota: document.querySelector('#nota-renomear-aba').textContent,
    }));
    exigir(recusa.open && /não pode ficar vazio/.test(recusa.nota),
      `celular: nome vazio é recusado DENTRO do diálogo, que continua aberto ("${recusa.nota}")`);
    await fotografar(pagina, 'celular-3-recusa');

    await pagina.type('#nome-aba', NOVO_CELULAR);
    await pagina.tap('#btn-confirma-renomear-aba');
    await esperarRenomeada(pagina, NOVO_CELULAR);
    // Assert PRÓPRIO: a espera acima engole o timeout, e "a lista mudou" não prova "o diálogo fechou".
    exigir(await pagina.evaluate(() => !document.querySelector('#dialogo-renomear-aba').open),
      'celular: salvar fecha o diálogo');
    const nomes = await nomesDaLista(pagina);
    exigir(nomes.includes(NOVO_CELULAR) && !nomes.includes(ALVO_CELULAR),
      `celular: a lista mostra "${NOVO_CELULAR}" no lugar de "${ALVO_CELULAR}" (${nomes.join(', ')})`);
    const depois = await estadoDosLapis(pagina);
    exigir(depois.length > 0 && depois.every((e) => e.visivel && e.dentroDaLinha && !e.cobreNome),
      `celular: com o nome LONGO quebrando linha, o ✎ continua à vista e não cobre nome nenhum (${JSON.stringify(depois.map((e) => [e.nome.slice(0, 24), e.cobreNome]))})`);
    await fotografar(pagina, 'celular-4-renomeada');

    exigir(falhas.length === 1 && /^PATCH 400 \/api\/abas\//.test(falhas[0]),
      `celular: a única resposta >= 400 é a recusa esperada (${falhas.join(' | ') || 'nenhuma'})`);
    // O Chromium loga o 400 esperado como erro de console ("status of 400"); só esse é tolerado.
    const errosDeVerdade = erros.filter((e) => !/status of 400/.test(e));
    exigir(errosDeVerdade.length === 0, `celular: sem erro de console (${errosDeVerdade.join(' | ') || 'nenhum'})`);
  } finally {
    await pagina.close().catch(() => {});
  }
}

async function desktop(navegador) {
  const { pagina, erros, falhas } = await abrir(navegador,
    { width: 1600, height: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 2 }, 'desktop');
  try {
    const trocadas = await emularMouse(pagina);
    exigir(trocadas >= 2, `desktop: emulei o mouse trocando ${trocadas} condição(ões) de hover da folha do app`);
    await pagina.mouse.move(1590, 990);
    await espera(250);
    const semHover = await estadoDosLapis(pagina);
    exigir(semHover.length === ABAS_ESPERADAS, `desktop: a lista tem ${ABAS_ESPERADAS} abas (${semHover.length})`);
    exigir(semHover.length > 0 && semHover.every((e) => e.existe && !e.visivel),
      `desktop: sem o mouse em cima, NENHUM ✎ aparece (${JSON.stringify(semHover.map((e) => [e.nome, e.visivel]))})`);
    await fotografar(pagina, 'desktop-1-sem-hover', { recorte: true });

    const linha = await linhaDe(pagina, ALVO_DESKTOP);
    if (!exigir(Boolean(linha), `desktop: achei a linha de ${ALVO_DESKTOP}`)) return;
    await linha.hover();
    await espera(300);
    const comHover = await estadoDosLapis(pagina);
    const alvo = comHover.find((e) => e.nome === ALVO_DESKTOP);
    const outras = comHover.filter((e) => e.nome !== ALVO_DESKTOP);
    exigir(Boolean(alvo) && alvo.visivel, `desktop: com o mouse na linha de ${ALVO_DESKTOP}, o ✎ DELA aparece`);
    exigir(outras.length > 0 && outras.every((e) => !e.visivel), 'desktop: e o das outras linhas continua escondido');
    // O ⧉ tem de estar À VISTA para "não bate no ⧉" provar alguma coisa — sem ele o assert passa no
    // vazio. Ele aparece no hover com (hover: hover) e largura > 760, que é este cenário emulado.
    exigir(Boolean(alvo) && alvo.aoLadoVisivel, `desktop: o ⧉ também aparece no hover — os dois controles juntos (${JSON.stringify(alvo)})`);
    exigir(Boolean(alvo) && alvo.dentroDaLinha && !alvo.cobreNome && !alvo.cruzaAoLado,
      `desktop: o ✎ fica dentro da linha, não cobre o nome e não bate no ⧉ (${JSON.stringify(alvo)})`);
    await fotografar(pagina, 'desktop-2-hover', { recorte: true });

    const lapis = await lapisDe(pagina, ALVO_DESKTOP);
    if (!exigir(Boolean(lapis), `desktop: achei o ✎ de ${ALVO_DESKTOP}`)) return;
    await lapis.click();
    await pagina.waitForSelector('#dialogo-renomear-aba[open]', { timeout: 5000 }).catch(() => {});
    const valor = await pagina.$eval('#nome-aba', (el) => el.value);
    exigir(valor === ALVO_DESKTOP, `desktop: o campo nasce com o nome atual (${valor})`);
    await pagina.$eval('#nome-aba', (el) => { el.value = ''; });
    await pagina.type('#nome-aba', NOVO_DESKTOP);
    await pagina.keyboard.press('Enter');
    await esperarRenomeada(pagina, NOVO_DESKTOP);
    exigir(await pagina.evaluate(() => !document.querySelector('#dialogo-renomear-aba').open),
      'desktop: Enter salva e fecha o diálogo');
    const nomes = await nomesDaLista(pagina);
    exigir(nomes.includes(NOVO_DESKTOP) && !nomes.includes(ALVO_DESKTOP),
      `desktop: Enter salva e a lista mostra "${NOVO_DESKTOP}" (${nomes.join(', ')})`);
    await pagina.mouse.move(1590, 990);
    await espera(250);
    await fotografar(pagina, 'desktop-3-renomeada', { recorte: true });

    exigir(falhas.length === 0, `desktop: nenhuma resposta >= 400 (${falhas.join(' | ') || 'nenhuma'})`);
    exigir(erros.length === 0, `desktop: sem erro de console (${erros.join(' | ') || 'nenhum'})`);
  } finally {
    await pagina.close().catch(() => {});
  }
}

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    await celular(navegador);
    await desktop(navegador);
  } catch (e) {
    exigir(false, `o roteiro estourou — ${String(e && e.message).slice(0, 300)}`);
  } finally {
    await navegador.close().catch(() => {});
  }
  console.log(`@@RENOMEAR@@${JSON.stringify({ passos, gerados })}`);
  process.exit(passos.length > 0 && passos.every((p) => p.ok) ? 0 : 1);
})();
