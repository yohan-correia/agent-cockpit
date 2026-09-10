'use strict';
// O ROTEIRO DO NAVEGADOR do `smoke-conversa-transicoes.js` — roda DENTRO do container
// (`cockpit-smoke:latest`), nunca no host.
//
// Mora num arquivo próprio, e não numa template string dentro do smoke como faz
// `smoke-celular-primeira-leva.js`: este roteiro precisa de crase e de `${}` de verdade
// (as medidas de `transform` são strings `matrix(...)` montadas na página), e escapar isso
// dentro de outra template string é onde bug nasce.
//
// Entrada, por ambiente: BASE · MODO=antes|depois · CONVERSA (texto que acha a linha da lista).
// Saída: os PNGs em /out e um JSON depois do marcador @@MEDIDAS-TRANSICOES@@ no stdout.

const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const MODO = process.env.MODO;
const CONVERSA = process.env.CONVERSA;
const SAIDA = '/out';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** Extrai `a` (escala em X) e `e` (translação em X) de um `matrix(a,b,c,d,e,f)`. */
function decompor(transform) {
  const m = String(transform).match(/^matrix\(([^)]+)\)$/);
  if (!m) return null;
  const n = m[1].split(',').map((v) => Number(v.trim()));
  return { a: n[0], e: n[4] };
}

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const medidas = {};
  const problemas = [];

  /** Abre uma página nova já no estado inicial (lista, tema escuro). */
  async function novaPagina({ reduzido = false } = {}) {
    const pagina = await navegador.newPage();
    const erros = [];
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
    pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
    await pagina.setViewport(VIEWPORT);
    // Trava 7 do plano: o contexto de `prefers-reduced-motion` nasce com a página. Trocar a
    // media feature com o DOM montado não reavalia o CSS de forma confiável.
    const features = [{ name: 'prefers-color-scheme', value: 'dark' }];
    if (reduzido) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
    await pagina.emulateMediaFeatures(features);
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(700);
    pagina.__erros = erros;
    return pagina;
  }

  /**
   * Clica na conversa por TEXTO (trava 5: a ordem da lista muda a cada 5s) e mede o
   * `transform` do `.chat` a t≈80ms — a medição acontece DENTRO da página (trava 1), porque
   * um `setTimeout` no Node come os 80ms no round-trip e mede o repouso.
   */
  function trocarDeVistaEMedir(pagina, alvo) {
    return pagina.evaluate(async (nome) => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa-linha'));
      const linha = linhas.find((l) => {
        const t = l.querySelector('.conversa-titulo');
        return t && t.textContent.includes(nome);
      });
      const botao = linha && linha.querySelector('.conversa');
      if (!botao) return { ok: false, porque: 'não achei a linha "' + nome + '" na lista' };
      const vistaAntes = document.querySelector('.app').dataset.vista;
      botao.click();
      await new Promise((r) => setTimeout(r, 80));
      const chat = document.querySelector('.chat');
      return {
        ok: true,
        vistaAntes,
        vistaDepois: document.querySelector('.app').dataset.vista,
        transformMeio: getComputedStyle(chat).transform,
        duracao: getComputedStyle(chat).transitionDuration,
      };
    }, alvo);
  }

  /** Volta para a lista pelo ← (o mesmo caminho do dedo). */
  function voltarParaLista(pagina) {
    return pagina.evaluate(async () => {
      const voltar = document.querySelector('.voltar');
      if (voltar) voltar.click();
      await new Promise((r) => setTimeout(r, 400));
      return document.querySelector('.app').dataset.vista;
    });
  }

  try {
    // ── 1) lista → conversa: A1 (só no "depois") ────────────────────────────
    let pagina = await novaPagina();

    if (MODO === 'depois') {
      const t1 = await trocarDeVistaEMedir(pagina, CONVERSA);
      if (!t1.ok) { problemas.push('T1: ' + t1.porque); }
      else {
        medidas.t1VistaAntes = t1.vistaAntes;
        medidas.t1VistaDepois = t1.vistaDepois;
        medidas.t1TransformMeio = t1.transformMeio;
        medidas.t1DuracaoDeclarada = t1.duracao;
        const d = decompor(t1.transformMeio);
        medidas.t1Tx = d ? d.e : null;
        if (!d) problemas.push('A1: o `.chat` a t≈80ms não tem matrix — veio "' + t1.transformMeio + '"');
        else if (!(d.e > 0 && d.e < 390)) problemas.push('A1: translateX do `.chat` a t≈80ms = ' + d.e + ' (esperado > 0 e < 390)');
      }
      // O PNG do meio. Fotografar "logo depois do clique" dá um instante ALEATÓRIO — o
      // screenshot custa ~100ms e a primeira rodada saiu com o `.chat` fora de qualquer
      // posição prevista. `document.getAnimations()` devolve as CSSTransition vivas: pausar
      // e cravar `currentTime = 80` congela o quadro exato que a medida A1 descreve.
      await voltarParaLista(pagina);
      medidas.t1AnimacoesCongeladas = await pagina.evaluate((nome) => {
        const linhas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa-linha'));
        const linha = linhas.find((l) => {
          const t = l.querySelector('.conversa-titulo');
          return t && t.textContent.includes(nome);
        });
        if (linha) linha.querySelector('.conversa').click();
        // Só as CSSTransition: `getAnimations()` traz junto o `pulsar` do `.faixa-pino`, que é
        // `infinite` — `finish()` nele estoura com InvalidStateError.
        const vivas = document.getAnimations().filter((a) => a instanceof CSSTransition);
        for (const a of vivas) { a.pause(); a.currentTime = 80; }
        return vivas.length;
      }, CONVERSA);
      // A transição fica PAUSADA enquanto a fita pinta: sem esta espera o print sai com o
      // `.chat` no lugar certo mas vazio, e um print vazio não prova transição nenhuma.
      //
      // MEDIDO (04/09): mesmo com a CSSTransition pausada em t=80ms, o `captureScreenshot`
      // do headless devolve o `.chat` na posição de REPOUSO — `transform` é propriedade de
      // compositor e o frame do print sai depois de compor. O `opacity` do <dialog> (PNG 03)
      // aparece no meio do caminho normalmente. Ou seja: para T1 este PNG é ilustrativo, e a
      // prova é `t1Tx`/`t1TransformCongelado` no medidas.json — que é justamente o que o card
      // pede ("transição não aparece em print estático: provar por CSS computado").
      await espera(900);
      medidas.t1TransformCongelado = await pagina.evaluate(() => getComputedStyle(document.querySelector('.chat')).transform);
      await pagina.screenshot({ path: SAIDA + '/02-t1-meio.png' });
      await pagina.evaluate(() => {
        for (const a of document.getAnimations()) { if (a instanceof CSSTransition) a.finish(); }
      });
      await espera(500);
    } else {
      const abriu = await pagina.evaluate((nome) => {
        const linhas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa-linha'));
        const linha = linhas.find((l) => {
          const t = l.querySelector('.conversa-titulo');
          return t && t.textContent.includes(nome);
        });
        if (!linha) return false;
        linha.querySelector('.conversa').click();
        return true;
      }, CONVERSA);
      if (!abriu) problemas.push('não achei a linha "' + CONVERSA + '" na lista');
      await espera(700);
    }

    // ── 2) PNG 01 — o grupo (depois) ou as ferramentas soltas (antes) ───────
    await pagina.waitForSelector('.painel .mensagens', { timeout: 10000 });
    await espera(700);
    const fita = await pagina.evaluate((modo) => {
      const grupo = document.querySelector('.grupo-ferramentas');
      const soltas = Array.from(document.querySelectorAll('.painel .mensagens .fita > .ferramenta'));
      const alvo = modo === 'depois' ? grupo : soltas[0];
      if (alvo) alvo.scrollIntoView({ block: 'center' });
      return {
        temGrupo: Boolean(grupo),
        grupoAberto: grupo ? grupo.open : null,
        passosNoGrupo: grupo ? grupo.querySelectorAll('.grupo-passos > .ferramenta').length : 0,
        resumo: grupo ? (grupo.querySelector('.grupo-resumo') || {}).textContent : null,
        soltasNaFita: soltas.length,
        idsPreservados: Array.from(document.querySelectorAll('[data-ferramenta-id]')).map((e) => e.dataset.ferramentaId),
        alvoNaVista: alvo ? (() => {
          const r = alvo.getBoundingClientRect();
          return r.top < 844 && r.bottom > 0 && r.height > 0;
        })() : false,
      };
    }, MODO);
    Object.assign(medidas, {
      temGrupo: fita.temGrupo,
      grupoAberto: fita.grupoAberto,
      passosNoGrupo: fita.passosNoGrupo,
      resumoDoGrupo: fita.resumo,
      soltasNaFita: fita.soltasNaFita,
      idsPreservados: fita.idsPreservados,
    });
    if (!fita.alvoNaVista) {
      problemas.push('PNG 01: o alvo do modo "' + MODO + '" NÃO está na vista — o print não prova nada');
    }
    await espera(300);
    await pagina.screenshot({ path: SAIDA + '/01-' + MODO + '-ferramentas.png' });

    // ── 2b) PNG 06 — o grupo ABERTO (só no "depois") ────────────────────────
    //
    // O grupo nasce `open` e se fecha sozinho quando encerra com todos os passos prontos, então
    // o PNG 01 sempre o pega FECHADO. Metade do CSS novo — `.grupo-passos`, o fio vertical,
    // `.ferramenta.passo`, o `border-radius` que casa resumo e corpo — só aparece aberto, e sem
    // este print ninguém nunca viu essa metade.
    if (MODO === 'depois') {
      const aberto = await pagina.evaluate(() => {
        const grupo = document.querySelector('.grupo-ferramentas');
        if (!grupo) return { ok: false, porque: 'não achei o .grupo-ferramentas' };
        grupo.open = true;
        grupo.scrollIntoView({ block: 'center' });
        const passos = Array.from(grupo.querySelectorAll('.grupo-passos > .ferramenta'));
        return {
          ok: true,
          passosVisiveis: passos.filter((p) => p.getBoundingClientRect().height > 0).length,
          passosComClassePasso: passos.filter((p) => p.classList.contains('passo')).length,
          alturaDoGrupo: Math.round(grupo.getBoundingClientRect().height),
        };
      });
      if (!aberto.ok) problemas.push('PNG 06: ' + aberto.porque);
      else {
        medidas.passosVisiveisAberto = aberto.passosVisiveis;
        medidas.passosComClassePasso = aberto.passosComClassePasso;
        medidas.alturaDoGrupoAberto = aberto.alturaDoGrupo;
        if (aberto.passosVisiveis !== 3) problemas.push('PNG 06: o grupo aberto mostra ' + aberto.passosVisiveis + ' passos (esperado 3)');
      }
      await espera(300);
      await pagina.screenshot({ path: SAIDA + '/06-grupo-aberto.png' });
      await pagina.evaluate(() => {
        const g = document.querySelector('.grupo-ferramentas');
        if (g) g.open = false;
      });
      await espera(200);
    }

    // ── 3) A2 + PNG 03 — o <dialog> no meio da escala (só no "depois") ──────
    if (MODO === 'depois') {
      const t2 = await pagina.evaluate(async () => {
        const dlg = document.getElementById('dialogo-diagnostico');
        if (!dlg) return { ok: false, porque: 'não achei o #dialogo-diagnostico' };
        dlg.showModal();
        await new Promise((r) => setTimeout(r, 80));
        return {
          ok: true,
          transformMeio: getComputedStyle(dlg).transform,
          opacityMeio: getComputedStyle(dlg).opacity,
          duracao: getComputedStyle(dlg).transitionDuration,
        };
      });
      if (!t2.ok) problemas.push('T2: ' + t2.porque);
      else {
        medidas.t2TransformMeio = t2.transformMeio;
        medidas.t2OpacityMeio = t2.opacityMeio;
        medidas.t2DuracaoDeclarada = t2.duracao;
        const d = decompor(t2.transformMeio);
        medidas.t2ScaleX = d ? d.a : null;
        if (!d) problemas.push('A2: o <dialog> a t≈80ms não tem matrix — veio "' + t2.transformMeio + '"');
        else if (!(d.a >= 0.96 && d.a < 1)) problemas.push('A2: scaleX do <dialog> a t≈80ms = ' + d.a + ' (esperado >= 0.96 e < 1)');
      }
      // O PNG: reabre e congela em t=80ms, pelo mesmo caminho do 02.
      // `close()` e `showModal()` no MESMO tick não reiniciam a transição: sem um quadro de
      // permeio o navegador não vê o elemento sair e voltar ao rendering, o `@starting-style`
      // não dispara e o congelamento pega o diálogo já assentado (`transform: none`).
      await pagina.evaluate(() => document.getElementById('dialogo-diagnostico').close());
      await espera(300);
      medidas.t2TransformCongelado = await pagina.evaluate(async () => {
        const dlg = document.getElementById('dialogo-diagnostico');
        dlg.showModal();
        await new Promise((r) => requestAnimationFrame(r));
        for (const a of document.getAnimations()) {
          if (a instanceof CSSTransition) { a.pause(); a.currentTime = 80; }
        }
        return getComputedStyle(dlg).transform;
      });
      await pagina.screenshot({ path: SAIDA + '/03-t2-meio.png' });
      await pagina.evaluate(() => {
        for (const a of document.getAnimations()) { if (a instanceof CSSTransition) a.finish(); }
      });
      await pagina.evaluate(() => document.getElementById('dialogo-diagnostico').close());
      await espera(300);
    }

    // ── 4) A5 e A6 — o selo do gesto sobreviveu (nos DOIS modos) ────────────
    const selo = await pagina.evaluate(() => {
      const s = document.querySelector('.lista-area .puxar-selo');
      const conversas = document.querySelector('.lista-area .conversas');
      return {
        existe: Boolean(s),
        irmaoDaConversas: Boolean(s && conversas && s.parentElement === conversas.parentElement),
      };
    });
    medidas.seloExiste = selo.existe;
    medidas.seloIrmaoDaConversas = selo.irmaoDaConversas;
    if (!selo.existe) problemas.push('A5: não existe `.lista-area .puxar-selo`');
    if (!selo.irmaoDaConversas) problemas.push('A5: o `.puxar-selo` não é irmão da `.conversas`');

    await voltarParaLista(pagina);
    const armado = await pagina.evaluate(async () => {
      const area = document.querySelector('.lista-area .conversas') || document.querySelector('.lista-area');
      if (!area) return { ok: false, porque: 'não achei a área da lista' };
      // Trava 6: `scrollTop = 0` no MESMO evaluate que despacha o `touchstart`, senão o
      // gesto nunca arma e a asserção passa por engano.
      area.scrollTop = 0;
      const toque = (tipo, y) => {
        const t = new Touch({ identifier: 1, target: area, clientX: 195, clientY: y });
        area.dispatchEvent(new TouchEvent(tipo, {
          bubbles: true, cancelable: true, touches: tipo === 'touchend' ? [] : [t],
          targetTouches: tipo === 'touchend' ? [] : [t], changedTouches: [t],
        }));
      };
      toque('touchstart', 120);
      await new Promise((r) => setTimeout(r, 40));
      toque('touchmove', 260);
      await new Promise((r) => setTimeout(r, 60));
      const s = document.querySelector('#puxar-selo-lista');
      const estado = s ? s.dataset.armado : null;
      toque('touchend', 260);
      return { ok: true, armado: estado };
    });
    medidas.seloArmado = armado.ok ? armado.armado : null;
    if (!armado.ok) problemas.push('A6: ' + armado.porque);
    else if (armado.armado !== '1') problemas.push('A6: o `.puxar-selo` NÃO armou depois do touchmove (data-armado=' + armado.armado + ')');
    await espera(400);

    // ── 5) A3, A4 e PNG 04 — a .pergunta cobrindo a viewport (DOIS modos) ───
    //
    // É o par que prova o risco R2: um `transform` no `.chat` viraria bloco de contenção e a
    // `.pergunta` (position: fixed) deixaria de medir a viewport. A regra `:has()` do CSS
    // desliga o transform justamente com a pergunta aberta.
    // O gesto do bloco anterior dispara um recarregamento da lista; clicar em cima do
    // re-render perde o clique e a vista fica em "lista" — foi assim que a primeira rodada
    // mediu a `.pergunta` como 0×0. Aqui o clique é reentrante e ESPERA a vista virar "chat".
    const voltou = await pagina.evaluate(async (nome) => {
      const clicar = () => {
        const linhas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa-linha'));
        const linha = linhas.find((l) => {
          const t = l.querySelector('.conversa-titulo');
          return t && t.textContent.includes(nome);
        });
        if (!linha) return false;
        linha.querySelector('.conversa').click();
        return true;
      };
      for (let i = 0; i < 20; i += 1) {
        if (document.querySelector('.app').dataset.vista === 'chat') return { ok: true, tentativas: i };
        clicar();
        await new Promise((r) => setTimeout(r, 300));
      }
      return { ok: false, porque: 'a vista não virou "chat" em 6s' };
    }, CONVERSA);
    if (!voltou.ok) problemas.push('A3/A4: ' + voltou.porque);
    medidas.tentativasParaReabrir = voltou.tentativas;
    await espera(500);

    const perg = await pagina.evaluate(async () => {
      const p = document.querySelector('.painel .pergunta');
      const tela = document.querySelector('.painel .pergunta-tela');
      if (!p) return { ok: false, porque: 'não achei o .painel .pergunta' };
      tela.textContent = ['? Quer que eu siga?', '', '  ❯ 1. Sim, pode ir', '    2. Não, para aqui'].join('\n');
      p.hidden = false;
      await new Promise((r) => setTimeout(r, 80));
      const r80 = p.getBoundingClientRect();
      const chat80 = getComputedStyle(document.querySelector('.chat')).transform;
      await new Promise((r) => setTimeout(r, 320));
      const r400 = p.getBoundingClientRect();
      const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      return {
        ok: true,
        r80: round(r80),
        r400: round(r400),
        chatTransformComPergunta: chat80,
        // Diagnóstico: um rect 0×0 pode vir de três lugares diferentes (a vista errada, o
        // `.painel .mensagens` ainda escondido, ou o próprio `hidden` do `.painel .pergunta` de volta), e sem
        // isto o vermelho não diz qual.
        vista: document.querySelector('.app').dataset.vista,
        mensagensHidden: document.querySelector('.painel .mensagens').hidden,
        chatDisplay: getComputedStyle(document.querySelector('.chat')).display,
        perguntaHidden: p.hidden,
        perguntaDisplay: getComputedStyle(p).display,
        perguntaPosicao: getComputedStyle(p).position,
      };
    });
    if (!perg.ok) problemas.push('A3/A4: ' + perg.porque);
    else {
      medidas.perguntaRect80 = perg.r80;
      medidas.perguntaRect400 = perg.r400;
      medidas.chatTransformComPergunta = perg.chatTransformComPergunta;
      medidas.perguntaDiagnostico = {
        vista: perg.vista, mensagensHidden: perg.mensagensHidden, chatDisplay: perg.chatDisplay,
        perguntaHidden: perg.perguntaHidden, perguntaDisplay: perg.perguntaDisplay,
        perguntaPosicao: perg.perguntaPosicao,
      };
      const cobre = (r) => Math.abs(r.x) <= 1 && Math.abs(r.y) <= 1
        && Math.abs(r.w - 390) <= 1 && Math.abs(r.h - 844) <= 1;
      if (!cobre(perg.r80)) problemas.push('A3: a `.pergunta` a t≈80ms NÃO cobre a viewport — ' + JSON.stringify(perg.r80));
      if (!cobre(perg.r400)) problemas.push('A4: a `.pergunta` a t≈400ms NÃO cobre a viewport — ' + JSON.stringify(perg.r400));
    }
    await pagina.screenshot({ path: SAIDA + '/04-pergunta.png' });
    await pagina.close().catch(() => {});

    // ── 6) A7 + PNG 05 — reduced motion, em contexto próprio (trava 7) ──────
    if (MODO === 'depois') {
      const reduzida = await novaPagina({ reduzido: true });
      const t7 = await trocarDeVistaEMedir(reduzida, CONVERSA);
      if (!t7.ok) problemas.push('A7: ' + t7.porque);
      else {
        medidas.reducedTransformMeio = t7.transformMeio;
        medidas.reducedDuracao = t7.duracao;
        if (t7.transformMeio !== 'none') {
          problemas.push('A7: com prefers-reduced-motion o `.chat` a t≈80ms tem transform "' + t7.transformMeio + '" (esperado "none")');
        }
      }
      await espera(700);
      await reduzida.evaluate(() => {
        const grupo = document.querySelector('.grupo-ferramentas');
        if (grupo) grupo.scrollIntoView({ block: 'center' });
      });
      await espera(300);
      await reduzida.screenshot({ path: SAIDA + '/05-reduced.png' });
      const errosReduzida = reduzida.__erros || [];
      if (errosReduzida.length) problemas.push('reduced: ' + errosReduzida.length + ' erro(s) de console: ' + errosReduzida.slice(0, 3).join(' | '));
      await reduzida.close().catch(() => {});
    }

    const erros = pagina.__erros || [];
    if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
  } catch (e) {
    problemas.push('o roteiro estourou: ' + (e && e.message));
  } finally {
    await navegador.close().catch(() => {});
  }

  console.log('@@MEDIDAS-TRANSICOES@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})();
