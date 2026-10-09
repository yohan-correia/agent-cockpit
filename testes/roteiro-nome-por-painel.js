'use strict';
// O ROTEIRO DO NAVEGADOR do `print-nome-por-painel.js` — roda DENTRO do container
// (`cockpit-smoke:latest`), nunca no host. Arquivo próprio pelo mesmo motivo do
// `roteiro-renomear.js`: crase e `${}` de verdade, sem template string por fora.
//
// Entrada, por ambiente: BASE · CHAVE (a aba de BAIXO da janela dividida) · CHAVE_IRMA (a de cima)
// · NOVO (o nome digitado) · ESPERO (`diferentes` | `iguais`).
// Só o celular (390×844): é o aparelho do dono. Saída: PNGs em /out e um JSON depois do marcador
// @@NOME-POR-PAINEL@@ no stdout — `{ passos, gerados }`.

const puppeteer = require('/app/node_modules/puppeteer-core');

const { BASE, CHAVE, CHAVE_IRMA, NOVO, ESPERO } = process.env;
const ABAS_ESPERADAS = 3;
const NOME_DA_JANELA = 'site-e-api';
// Escopado pela seção de abas (#44): o grupo de jobs usa a mesma marcação de linha.
const LINHAS = '#lista-conversas .conversa-linha';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const passos = [];
const gerados = [];
const exigir = (condicao, texto) => { passos.push({ ok: Boolean(condicao), texto }); return Boolean(condicao); };

/** O título que a LINHA da chave mostra agora (null se a linha não existe). */
const tituloDe = (pagina, chave) => pagina.evaluate((c) => {
  const conversa = document.querySelector(`.conversa[data-chave="${c}"]`);
  const linha = conversa && conversa.closest('.conversa-linha');
  const nome = linha && linha.querySelector('.conversa-nome');
  return nome ? nome.textContent : null;
}, chave);

async function fotografar(pagina, nome) {
  // O `<dialog>` abre e fecha com transição: espera só as animações FINITAS (o pino de
  // "trabalhando" pulsa para sempre e travaria aqui).
  await pagina.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity)
    .map((a) => a.finished.catch(() => {}))));
  await espera(120);
  await pagina.screenshot({ path: `/out/${nome}.png` });
  gerados.push(`${nome}.png`);
}

async function celular(navegador) {
  const pagina = await navegador.newPage();
  const erros = [];
  const falhas = [];
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push(`PAGEERROR: ${String(e).slice(0, 200)}`));
  pagina.on('response', (r) => {
    if (r.status() >= 400) falhas.push(`${r.request().method()} ${r.status()} ${new URL(r.url()).pathname}`);
  });
  try {
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
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
    exigir(comEstilo, 'celular: a folha de estilo carregou (sem ela todo o resto mente)');
    const linhas = await pagina.$$eval(LINHAS, (ls) => ls.length);
    exigir(linhas === ABAS_ESPERADAS, `celular: a lista tem ${ABAS_ESPERADAS} linhas de aba (${linhas})`);

    const irmaAntes = await tituloDe(pagina, CHAVE_IRMA);
    const alvoAntes = await tituloDe(pagina, CHAVE);
    exigir(irmaAntes === NOME_DA_JANELA && alvoAntes === NOME_DA_JANELA,
      `celular: de partida as duas linhas da janela dividida mostram "${NOME_DA_JANELA}" (${irmaAntes} | ${alvoAntes})`);
    await fotografar(pagina, '1-inicio');

    const lapis = await pagina.evaluateHandle((c) => {
      const conversa = document.querySelector(`.conversa[data-chave="${c}"]`);
      const linha = conversa && conversa.closest('.conversa-linha');
      return linha ? linha.querySelector('.renomear-aba') : null;
    }, CHAVE);
    const botao = lapis.asElement();
    if (!exigir(Boolean(botao), 'celular: achei o ✎ da linha de baixo')) return;
    await botao.tap();
    await pagina.waitForSelector('#dialogo-renomear-aba[open]', { timeout: 5000 }).catch(() => {});
    const aberto = await pagina.evaluate(() => ({
      open: document.querySelector('#dialogo-renomear-aba').open,
      valor: document.querySelector('#nome-aba').value,
    }));
    exigir(aberto.open, 'celular: tocar o ✎ abre o diálogo');
    exigir(aberto.valor === NOME_DA_JANELA, `celular: o campo nasce com o título atual (${aberto.valor})`);

    await pagina.$eval('#nome-aba', (el) => { el.value = ''; });
    await pagina.type('#nome-aba', NOVO);
    await pagina.tap('#btn-confirma-renomear-aba');
    await pagina.waitForFunction((c, novo) => {
      const conversa = document.querySelector(`.conversa[data-chave="${c}"]`);
      const linha = conversa && conversa.closest('.conversa-linha');
      const nome = linha && linha.querySelector('.conversa-nome');
      return !document.querySelector('#dialogo-renomear-aba').open && nome && nome.textContent === novo;
    }, { timeout: 8000 }, CHAVE, NOVO).catch(() => {});
    // Assert PRÓPRIO: a espera acima engole o timeout.
    exigir(await pagina.evaluate(() => !document.querySelector('#dialogo-renomear-aba').open),
      'celular: salvar fecha o diálogo');

    const irmaDepois = await tituloDe(pagina, CHAVE_IRMA);
    const alvoDepois = await tituloDe(pagina, CHAVE);
    await fotografar(pagina, '2-depois');
    if (ESPERO === 'diferentes') {
      exigir(alvoDepois === NOVO && irmaDepois === NOME_DA_JANELA,
        `celular: o ✎ mudou SÓ a de baixo — baixo "${alvoDepois}", cima "${irmaDepois}"`);
    } else {
      exigir(alvoDepois === NOVO && irmaDepois === NOVO,
        `celular: o ✎ mudou as DUAS — baixo "${alvoDepois}", cima "${irmaDepois}"`);
    }
    exigir(falhas.length === 0, `celular: nenhuma resposta >= 400 (${falhas.join(' | ') || 'nenhuma'})`);
    exigir(erros.length === 0, `celular: sem erro de console (${erros.join(' | ') || 'nenhum'})`);
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
  } catch (e) {
    exigir(false, `o roteiro estourou — ${String(e && e.message).slice(0, 300)}`);
  } finally {
    await navegador.close().catch(() => {});
  }
  console.log(`@@NOME-POR-PAINEL@@${JSON.stringify({ passos, gerados })}`);
  process.exit(passos.length > 0 && passos.every((p) => p.ok) ? 0 : 1);
})();
