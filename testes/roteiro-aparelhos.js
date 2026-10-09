'use strict';
// O ROTEIRO DO NAVEGADOR do `smoke-navegador-aparelhos.js` — roda DENTRO do container
// (`cockpit-smoke:latest`), nunca no host. Arquivo próprio pelo mesmo motivo do
// `roteiro-renomear.js`: crase e `${}` de verdade, sem template string por fora.
//
// Entrada, por ambiente: BASE · UA_CRU · NOME_NOVO.
// Saída: 13 PNGs em /out e um JSON depois do marcador @@APARELHOS@@ no stdout.
//
// Os cinco primeiros saem NOS DOIS viewports (sufixo `-desktop` para 1600×1000 e `-celular`
// para 390×844 — o celular é o aparelho que motivou o recurso); o `06` sai três vezes só no
// celular, que é onde o texto do botão estoura.

const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const UA_CRU = process.env.UA_CRU;
const NOME_NOVO = process.env.NOME_NOVO;
const APARELHOS_ESPERADOS = 3;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const passos = [];
const gerados = [];
const exigir = (condicao, texto) => { passos.push({ ok: Boolean(condicao), texto }); return Boolean(condicao); };

/**
 * Os três `r` do `06` são CRAVADOS, calculados a partir do TETO_FRASE — não "uns nomes".
 * A frase de 3 aparelhos em pt-BR é "enviado para " + a + ", " + b + " e mais 1": 24 + |a| + |b|.
 *
 * - `antes`  isola o TETO_NOME e nada mais: os dois primeiros são curtos e o terceiro, de 40
 *   caracteres, cai no "e mais 1" e NEM ENTRA na frase, que fica em 35 — bem abaixo do
 *   TETO_FRASE. Apagando o TETO_NOME, este print fica vermelho, que é o que se quer de um
 *   print que julga régua. (Pôr os 3 com user agent de 80 daria frase de 144 e cairia pelo
 *   TETO_FRASE de qualquer jeito — verde mesmo sem o TETO_NOME.)
 * - `depois` monta exatamente 48: é este print que julga o número.
 * - `limite` tem UM caractere a mais e volta para a contagem.
 */
const TIROS_DO_TESTE = [
  { nome: '06-testar-celular-antes', r: { enviados: 3, nomes: ['Note', 'Celular', 'x'.repeat(40)] } },
  { nome: '06-testar-celular-depois', r: { enviados: 3, nomes: ['Note da sala', 'Celular novo', 'Tablet'] } },
  { nome: '06-testar-celular-limite', r: { enviados: 3, nomes: ['Note da sala', 'Celular velho', 'Tablet'] } },
];

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
  // ANTES do goto, e obrigatório: o i18n lê a chave no carregamento, e dentro do container o
  // padrão seria 'en'. Em inglês a fronteira do TETO_FRASE é medida contra "sent to" (5
  // caracteres a menos que "enviado para"), o `-limite` NÃO cai na contagem, e o único aceite
  // visual do teto sairia verde provando outra coisa.
  await pagina.evaluateOnNewDocument(() => {
    try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* vale nesta página */ }
  });
  await pagina.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await espera(700);
  const comEstilo = await pagina.evaluate(() => Array.from(document.styleSheets).some((f) => {
    try { return f.cssRules.length > 0; } catch (e) { return false; }
  }));
  exigir(comEstilo, `${rotulo}: a folha de estilo carregou (sem ela todo o resto mente)`);
  return { pagina, erros, falhas };
}

async function fotografar(pagina, nome) {
  // O `<dialog>` abre e fecha com transição: sem esperar, o print sai meio transparente por
  // cima da lista. Espera só as animações FINITAS — o pino de "trabalhando" pulsa para sempre.
  await pagina.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity)
    .map((a) => a.finished.catch(() => {}))));
  await espera(120);
  await pagina.screenshot({ path: `/out/${nome}.png` });
  gerados.push(`${nome}.png`);
}

/** O que o CSS de VERDADE decidiu em cada linha da lista — é aqui que o R4 se prova. */
function estadoDasLinhas(pagina) {
  return pagina.evaluate(() => Array.from(document.querySelectorAll('#aparelho-lista .aparelho-item')).map((item) => {
    const linha = item.querySelector('.aparelho-linha');
    const nome = item.querySelector('.aparelho-nome');
    const marcaId = item.querySelector('.aparelho-id');
    const editar = item.querySelector('.aparelho-editar');
    const caixa = document.getElementById('aparelho-lista');
    const rc = caixa.getBoundingClientRect();
    const rn = nome ? nome.getBoundingClientRect() : null;
    const re = editar ? editar.getBoundingClientRect() : null;
    const cs = editar ? getComputedStyle(editar) : null;
    return {
      texto: linha ? linha.textContent : '',
      nome: nome ? nome.textContent : '',
      // `scrollWidth > clientWidth` é o ellipsis DISPARANDO: o texto não cabe e foi cortado.
      truncado: Boolean(nome && nome.scrollWidth > nome.clientWidth + 1),
      // E o que importa de verdade: o texto NÃO passou da caixa. Sem `min-width: 0` no item
      // flex, o ellipsis nunca dispara e é isto aqui que fica falso.
      dentroDaCaixa: Boolean(rn && rn.right <= rc.right + 1 && rn.left >= rc.left - 1),
      temId: Boolean(marcaId && /^[0-9a-f]{8}$/.test(String(marcaId.textContent).trim())),
      lapisVisivel: Boolean(cs && cs.display !== 'none' && cs.visibility !== 'hidden' && re && re.width > 0),
    };
  }));
}

async function abrirConfig(pagina) {
  await pagina.evaluate(() => document.getElementById('btn-config').click());
  await pagina.waitForSelector('#dialogo-config[open]', { timeout: 5000 }).catch(() => {});
}

/**
 * Devolve o user agent cru ao disco entre um viewport e outro. Sem isto o segundo a rodar
 * abriria a lista já batizada, e o `02-lista-*` dele não provaria nada do R4 — que é o único
 * defeito desta entrega que assert nenhum pega.
 */
function restaurarUaCru(pagina) {
  return pagina.evaluate(async (ua, novo) => {
    const r = await fetch('api/push/inscricoes');
    const { aparelhos } = await r.json();
    const alvo = aparelhos.find((a) => a.nome === novo);
    if (!alvo) return false;
    const volta = await fetch('api/push/inscricao/nome', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: alvo.id, nome: ua }),
    });
    return volta.ok;
  }, UA_CRU, NOME_NOVO);
}

async function abrirLista(pagina) {
  await pagina.evaluate(() => document.getElementById('btn-aparelhos').click());
  await pagina.waitForFunction(() => document.getElementById('dialogo-aparelhos').open
    && document.querySelectorAll('#aparelho-lista .aparelho-item').length > 0, { timeout: 8000 }).catch(() => {});
}

async function rodar(navegador, viewport, sufixo, rotulo, { restaurar = false } = {}) {
  const { pagina, erros, falhas } = await abrir(navegador, viewport, rotulo);
  try {
    await abrirConfig(pagina);
    const noPainel = await pagina.evaluate(() => {
      const b = document.getElementById('btn-aparelhos');
      if (!b) return null;
      const grupo = b.closest('.config-grupo');
      const titulo = grupo ? grupo.querySelector('.config-grupo-titulo') : null;
      const r = b.getBoundingClientRect();
      return { grupo: titulo ? titulo.textContent : '', rotulo: b.textContent.trim(), visivel: r.width > 0 && r.height > 0 };
    });
    exigir(noPainel && noPainel.visivel && /Aparelhos com aviso/.test(noPainel.rotulo) && noPainel.grupo === 'O servidor',
      `${rotulo}: o botão "Aparelhos com aviso" está VISÍVEL no grupo "O servidor" (${JSON.stringify(noPainel)})`);
    await fotografar(pagina, `01-config${sufixo}`);

    await abrirLista(pagina);
    let linhas = await estadoDasLinhas(pagina);
    exigir(linhas.length === APARELHOS_ESPERADOS, `${rotulo}: a lista tem ${APARELHOS_ESPERADOS} linhas (${linhas.length})`);
    exigir(linhas.every((l) => l.dentroDaCaixa),
      `${rotulo}: NENHUM nome vaza da caixa — nem o user agent cru de 80 (${JSON.stringify(linhas.map((l) => [l.nome.slice(0, 18), l.dentroDaCaixa]))})`);
    exigir(linhas.every((l) => l.temId), `${rotulo}: toda linha mostra os 8 hex do id`);
    exigir(linhas.every((l) => l.lapisVisivel), `${rotulo}: o ✎ está à vista em todas, sem tocar em nada`);
    exigir(linhas.some((l) => /sem nome/.test(l.texto)), `${rotulo}: a inscrição sem o campo aparece como "sem nome"`);
    exigir(!linhas.some((l) => /19(70|69)/.test(l.texto)), `${rotulo}: e a linha sem criadoEm NÃO ganha 01/01/1970`);
    exigir(!linhas.some((l) => /fcm\.example/.test(l.texto)), `${rotulo}: o endpoint não aparece em lugar nenhum da tela`);
    await fotografar(pagina, `02-lista${sufixo}`);

    // A linha do user agent cru: é a que o dono quer batizar.
    const abriu = await pagina.evaluate((ua) => {
      const itens = Array.from(document.querySelectorAll('#aparelho-lista .aparelho-item'));
      // `textContent` traz o valor COMPLETO: o corte do ellipsis é visual, não muda o DOM.
      const alvo = itens.find((i) => {
        const n = i.querySelector('.aparelho-nome');
        return n && n.textContent === ua;
      }) || itens[1];
      const b = alvo.querySelector('.aparelho-editar');
      if (!b) return false;
      b.click();
      return true;
    }, UA_CRU);
    exigir(abriu, `${rotulo}: o ✎ da linha do user agent cru responde`);
    await pagina.waitForSelector('#aparelho-lista input', { timeout: 5000 }).catch(() => {});
    const emEdicao = await pagina.evaluate(() => {
      const campo = document.querySelector('#aparelho-lista input');
      if (!campo) return null;
      const rc = document.getElementById('aparelho-lista').getBoundingClientRect();
      const r = campo.getBoundingClientRect();
      return {
        tamanho: campo.value.length,
        // O critério NÃO é "os 80 caracteres visíveis" — em 390px eles não cabem em campo
        // nenhum, e prometer isso seria um aceite impossível. O print prova que o CAMPO está
        // inteiro na tela; o valor completo se prova pelo assert de `tamanho`.
        dentro: r.left >= rc.left - 1 && r.right <= rc.right + 1 && r.width > 0,
        travado: document.getElementById('btn-atualizar-aparelhos').disabled,
        nota: document.getElementById('nota-aparelhos').textContent,
        // O campo mostra o COMEÇO do nome, não o fim: com 80 caracteres de user agent, ver
        // "…Gecko) Chrome/14" não diz ao dono o que ele está prestes a renomear.
        noComeco: campo.scrollLeft === 0,
      };
    });
    exigir(emEdicao && emEdicao.tamanho === 80,
      `${rotulo}: o campo nasce com o valor COMPLETO, os 80 caracteres (${emEdicao && emEdicao.tamanho})`);
    exigir(emEdicao && emEdicao.dentro, `${rotulo}: e o campo está inteiro dentro da caixa, sem vazar`);
    exigir(emEdicao && emEdicao.noComeco, `${rotulo}: e mostra o COMEÇO do nome, não o fim dos 80 caracteres`);
    exigir(emEdicao && emEdicao.travado && /salve o nome/.test(emEdicao.nota),
      `${rotulo}: com edição aberta o "Atualizar a lista" fica travado, e a legenda diz por quê`);
    await fotografar(pagina, `03-editando${sufixo}`);

    await pagina.evaluate((novo) => {
      const campo = document.querySelector('#aparelho-lista input');
      campo.value = novo;
      const botoes = Array.from(campo.closest('.aparelho-linha').querySelectorAll('button'));
      const salvar = botoes.find((b) => b.textContent === 'Salvar');
      salvar.click();
    }, NOME_NOVO);
    await pagina.waitForFunction((novo) => !document.querySelector('#aparelho-lista input')
      && document.getElementById('aparelho-lista').textContent.includes(novo), { timeout: 8000 }, NOME_NOVO).catch(() => {});
    linhas = await estadoDasLinhas(pagina);
    exigir(linhas.some((l) => l.nome === NOME_NOVO),
      `${rotulo}: a linha mostra "${NOME_NOVO}" sem recarregar a página (${JSON.stringify(linhas.map((l) => l.nome.slice(0, 18)))})`);
    exigir(!linhas.some((l) => l.nome.startsWith('Mozilla')), `${rotulo}: e o user agent cru sumiu da lista`);
    await fotografar(pagina, `04-salvo${sufixo}`);

    // "Atualizar a lista" destravado depois de salvar, e a legenda "sem nome" que sobrevive
    // ao recarregamento — este é o print que a prova.
    const destravou = await pagina.evaluate(() => {
      const b = document.getElementById('btn-atualizar-aparelhos');
      if (b.disabled) return false;
      b.click();
      return true;
    });
    exigir(destravou, `${rotulo}: o "Atualizar a lista" destrava quando a edição fecha`);
    await espera(600);
    linhas = await estadoDasLinhas(pagina);
    exigir(linhas.length === APARELHOS_ESPERADOS && linhas.some((l) => /sem nome/.test(l.texto)),
      `${rotulo}: depois de atualizar, a legenda "sem nome" continua na linha que não tem o campo`);
    exigir(linhas.some((l) => l.nome === NOME_NOVO), `${rotulo}: e o nome salvo veio do disco, não da tela`);
    await fotografar(pagina, `05-sem-nome${sufixo}`);

    exigir(falhas.length === 0, `${rotulo}: nenhuma resposta >= 400 (${falhas.join(' | ') || 'nenhuma'})`);
    exigir(erros.length === 0, `${rotulo}: sem erro de console (${erros.join(' | ') || 'nenhum'})`);
    if (restaurar) {
      exigir(await restaurarUaCru(pagina), `${rotulo}: devolvi o user agent cru ao disco para o próximo viewport`);
    }
  } finally {
    await pagina.close().catch(() => {});
  }
}

/**
 * Os três tiros do rótulo do botão "testar" — a única mudança visível FORA do diálogo.
 *
 * O `evaluate` PINTA o nó, do mesmo jeito que o código de produção: `rotuloDoTeste(r)` é pura e
 * devolve string, e um `evaluate` que só a chamasse entregaria a frase ao Node e fotografaria o
 * rótulo real da tela ("Notificações ligadas · testar") — exit 0, PNG, zero prova.
 *
 * E a receita para a tela chegar ao estado, porque o container não a dá de graça:
 * `pintarBotaoAvisos` faz `botao.hidden = estado === 'indisponivel'`, e o Chromium do smoke fala
 * HTTP, então não há `PushManager` e o botão nasce escondido. Forçar `hidden = false` é legítimo
 * e está declarado: este PNG prova que O TEXTO CABE NO BOTÃO, não que o botão aparece — a
 * visibilidade condicional é do `gate-ui`, com assert.
 */
async function tirosDoTeste(navegador) {
  const { pagina } = await abrir(navegador,
    { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, 'celular/testar');
  try {
    await abrirConfig(pagina);
    for (const tiro of TIROS_DO_TESTE) {
      const medido = await pagina.evaluate((r) => {
        const painel = document.getElementById('dialogo-config');
        if (!painel.open) painel.showModal();
        const botao = document.getElementById('btn-avisos');
        botao.hidden = false;
        const alvo = document.getElementById('avisos-rotulo');
        idiomaUI.bind(alvo, 'textContent', () => rotuloDoTeste(r));
        const rb = botao.getBoundingClientRect();
        const ra = alvo.getBoundingClientRect();
        return {
          texto: alvo.textContent,
          visivel: rb.width > 0 && rb.height > 0 && !botao.hidden,
          // O rótulo cabendo NO BOTÃO: sem isto, um texto cortado pelo ellipsis passaria
          // despercebido — e o corte do CSS é silencioso, que é o modo de falha do TETO_FRASE.
          cabe: ra.right <= rb.right + 1 && alvo.scrollWidth <= alvo.clientWidth + 1,
          // A régua em pixels, para o relatório poder dizer QUAL número serve: o teto é uma
          // estimativa em caracteres, e só esta medida diz em quantos ela deveria estar.
          vaga: Math.round(alvo.clientWidth),
          precisa: Math.round(alvo.scrollWidth),
          coube: Math.round(r.enviados && alvo.textContent.length * (alvo.clientWidth / alvo.scrollWidth)),
        };
      }, tiro.r);
      exigir(medido.visivel, `${tiro.nome}: o botão de avisos está visível na tela antes do print`);
      const esperado = tiro.nome.endsWith('depois')
        ? 'enviado para Note da sala, Celular novo e mais 1'
        : 'enviado para 3 aparelho(s)';
      exigir(medido.texto === esperado, `${tiro.nome}: o rótulo diz "${esperado}" (achei "${medido.texto}")`);
      exigir(medido.cabe,
        `${tiro.nome}: e o texto CABE no botão em 390px, sem corte silencioso — vaga ${medido.vaga}px, precisa ${medido.precisa}px, cabem ~${medido.coube} caracteres`);
      await fotografar(pagina, tiro.nome);
    }
  } finally {
    await pagina.close().catch(() => {});
  }
}

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    // O desktop restaura o user agent cru; o celular é o último e deixa o nome novo no
    // disco, que é o que o host confere depois do container.
    await rodar(navegador, { width: 1600, height: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 2 }, '-desktop', 'desktop', { restaurar: true });
    await rodar(navegador, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, '-celular', 'celular');
    await tirosDoTeste(navegador);
  } catch (e) {
    exigir(false, `o roteiro estourou — ${String(e && e.message).slice(0, 300)}`);
  } finally {
    await navegador.close().catch(() => {});
  }
  console.log(`@@APARELHOS@@${JSON.stringify({ passos, gerados })}`);
  process.exit(passos.length > 0 && passos.every((p) => p.ok) ? 0 : 1);
})();
