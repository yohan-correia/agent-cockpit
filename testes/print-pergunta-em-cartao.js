#!/usr/bin/env node
'use strict';
// PRINT DA PERGUNTA DO AGENTE EM CARTÃO (D74) — ANTES e DEPOIS, sem gastar token.
//
// Chromium de verdade sobre o cockpit de verdade, com o `server.js` subindo como processo FILHO
// (`spawn`, nunca `require`) num mundo de mentira: tmux num socket próprio, `/proc` falso
// (`COCKPIT_PROC_RAIZ`) e `sessions/<pid>.json` falso dizendo `status: waiting`. A pane roda
// `cat <tela medida>; exec sleep 100000` numa janela de 140x50 — a tela é a MEDIDA na TUI real
// (testes/fixtures/pergunta/telas), então o que o cockpit confere é o que o Claude Code desenha.
//
// Dois cenários, as duas abas no mesmo servidor:
//   1. pergunta — tela `m1-01-pergunta-aberta.txt` + o arquivo que o hook gravaria
//      (`ganchos/01-pre.json`, gravado pelo PRÓPRIO bin/gancho-pergunta.js). Audio simples +
//      Aviso LGPD multi. No DEPOIS: clica a opção 2 da Audio e escreve na Outra resposta da LGPD.
//   2. menu — tela `m1-13-menu-auto-mode.txt`, SEM arquivo do hook: o terminal cru, que agora
//      quebra linha (P4 da spec).
//
// ANTES = o `server.js` de uma cópia da develop (env SERVIDOR): terminal cru cortado na borda.
// DEPOIS = o `server.js` desta worktree. Cada rodada escreve na SUA subpasta (SAIDA/antes ou
// SAIDA/depois) e só recusa se a SUBPASTA já tiver PNG — assim as duas convivem em SAIDA.
//
// Uso:
//   SAIDA=<pasta> node testes/print-pergunta-em-cartao.js                                  (DEPOIS)
//   SAIDA=<pasta> SERVIDOR=/tmp/d6aa/develop/server.js node testes/print-pergunta-em-cartao.js   (ANTES)
// Opcional: PORT (padrão 7957). Nunca 7879 (produção), 7897, 7899 (jobs) nem 7912.
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs vão cair>');
  process.exit(2);
}

const RAIZ = path.resolve(__dirname, '..');
const SERVIDOR = process.env.SERVIDOR ? path.resolve(process.env.SERVIDOR) : path.join(RAIZ, 'server.js');
const ANTES = Boolean(process.env.SERVIDOR);
const PREFIXO = ANTES ? 'antes' : 'depois';
const PORTA = Number(process.env.PORT) || 7957;
if ([7879, 7897, 7899, 7912].includes(PORTA)) {
  console.error(`🔴 a porta ${PORTA} é de produção ou dos jobs — recuso.`);
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const GANCHO = path.join(RAIZ, 'bin', 'gancho-pergunta.js');
const FIXTURES = path.join(RAIZ, 'testes', 'fixtures', 'pergunta');
const TELA_PERGUNTA = path.join(FIXTURES, 'telas', 'm1-01-pergunta-aberta.txt');
const TELA_MENU = path.join(FIXTURES, 'telas', 'm1-13-menu-auto-mode.txt');
const PAYLOAD_PERGUNTA = path.join(FIXTURES, 'ganchos', '01-pre.json');
const TEXTO_OUTRA = 'Aviso de gravacao, com letra grande';

// ─── Fail-closed do socket, mesmo padrão dos outros prints ───────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-cartao-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
// As sessões que ESTE script cria. A limpeza fail-closed compara o socket com este conjunto
// antes de derrubar qualquer coisa (D35).
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

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

let falhas = 0;
let feitos = 0;
const ok = (c, texto) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${texto}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── O mundo de mentira — mesmo arreio do print-arrastar-aba.js ──────────────

const raizProc = (scratch) => path.join(scratch, 'proc');

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
function plantarAgenteFalso(scratch, pid, { starttime }) {
  const dir = path.join(raizProc(scratch), String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = '(claude)';
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);
  campos[5] = String(pid);
  campos[6] = '34816';
  campos[7] = String(pid);
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), '/usr/bin/claude\0');
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

/** O `sessions/<pid>.json` do CLI — `status: waiting` + `statusUpdatedAt`, que é o que o V4 do hook lê. */
function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime, statusDesde }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive',
    sessionId: sessaoId,
    cwd,
    status: 'waiting',
    updatedAt: Date.now(),
    statusUpdatedAt: statusDesde,
    pid,
    procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

/** Onde o CLI guarda a fita — a MESMA convenção de `arquivoDaSessao` (lib/abas.js): cwd com hífens. */
function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
})}\n`;

function escreverConversaCurta(caminho, nome) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const base = Date.now() - 600000;
  fs.writeFileSync(caminho, [
    linhaHumano(new Date(base).toISOString(), `oi, sou a conversa ${nome}`),
    linhaAssistente(new Date(base + 30000).toISOString(), `resposta da conversa ${nome}`),
  ].join(''));
}

function pedir(rota) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: rota, timeout: 2000, agent: false }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(corpo); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}

// ─── O roteiro do navegador — roda DENTRO do container ───────────────────────

const ROTEIRO = `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const ANTES = process.env.ANTES === '1';
const PREFIXO = ANTES ? 'antes' : 'depois';
const TEXTO_OUTRA = ${JSON.stringify(TEXTO_OUTRA)};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const problemas = [];
  const medidas = {};
  const erros = [];
  const requisicoes = [];

  /** Uma página nova no tamanho pedido, em pt-BR (o Chromium da imagem é en-US) e na lista de abas. */
  const nova = async (largura, altura, celular) => {
    const p = await navegador.newPage();
    p.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
    p.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
    p.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });
    await p.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* modo privado */ } });
    await p.setViewport(celular
      ? { width: largura, height: altura, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { width: largura, height: altura });
    await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await p.waitForSelector('#abas', { timeout: 15000 });
    await espera(700);
    return p;
  };

  /** Clica na linha da aba pelo título da janela (pergunta | menu). */
  const abrir = (p, titulo) => p.evaluate((alvo) => {
    const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
    const linha = linhas.find((l) => {
      const t2 = l.querySelector('.conversa-titulo');
      return t2 && t2.textContent.includes(alvo);
    });
    const botao = linha && linha.querySelector('.conversa');
    if (!botao) return false;
    botao.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, titulo);

  const esperarPergunta = (p) => p.waitForFunction(() => {
    const el = document.querySelector('.painel:not([hidden]) .pergunta');
    return Boolean(el) && !el.hidden;
  }, { timeout: 25000 }).then(() => true, () => false);

  const esperarCartao = (p) => p.waitForFunction(() => {
    const el = document.querySelector('.painel:not([hidden]) .pergunta-cartao');
    return Boolean(el) && !el.hidden && el.querySelectorAll('.cartao-questao').length > 0;
  }, { timeout: 20000 }).then(() => true, () => false);

  /** O que está na tela agora — tudo medido no navegador, nada deduzido. */
  const medir = (p) => p.evaluate(() => {
    const raiz = document.querySelector('.painel:not([hidden])');
    const vis = (e) => Boolean(e) && !e.hidden && e.getClientRects().length > 0;
    const q = (s) => raiz.querySelector(s);
    const tela = q('.pergunta-tela');
    const detalhes = q('.pergunta-terminal');
    const enviar = q('.cartao-enviar');
    return {
      perguntaVisivel: vis(q('.pergunta')),
      telaVisivel: vis(tela),
      telaLargura: tela ? tela.scrollWidth : null,
      telaVisor: tela ? tela.clientWidth : null,
      cartaoVisivel: vis(q('.pergunta-cartao')),
      questoes: Array.from(raiz.querySelectorAll('.cartao-questao')).filter(vis).length,
      pressionadas: raiz.querySelectorAll('.cartao-opcao[aria-pressed="true"]').length,
      campos: Array.from(raiz.querySelectorAll('.cartao-outra-campo')).map((c) => c.value),
      rotuloVisivel: vis(q('.pergunta-terminal-rotulo')),
      rotulo: q('.pergunta-terminal-rotulo') ? q('.pergunta-terminal-rotulo').textContent : null,
      detalhesAberto: detalhes ? detalhes.open : null,
      enviarHabilitado: enviar ? !enviar.disabled : null,
      paginaTransborda: document.scrollingElement.scrollWidth > window.innerWidth + 1,
    };
  });

  /** Põe o começo (ou o fim) do cartão/pergunta na vista antes do PNG — sem animação, ou o PNG pega o meio dela. */
  const rolar = (p, onde) => p.evaluate((destino) => {
    const raiz = document.querySelector('.painel:not([hidden])');
    const m = raiz.querySelector('.mensagens');
    m.style.scrollBehavior = 'auto';
    if (destino === 'fim') { m.scrollTop = m.scrollHeight; return; }
    const alvo = raiz.querySelector('.pergunta-cartao:not([hidden])') || raiz.querySelector('.pergunta');
    m.scrollTop += alvo.getBoundingClientRect().top - m.getBoundingClientRect().top - 8;
  }, onde);

  /** Opção 2 da Audio + texto na Outra resposta da LGPD — o que o PNG precisa mostrar. */
  const preencher = async (p) => {
    const questoes = await p.$$('.painel:not([hidden]) .cartao-questao');
    if (questoes.length !== 2) { problemas.push('preencher: esperava 2 .cartao-questao, achei ' + questoes.length); return; }
    const opcoes = await questoes[0].$$('.cartao-opcao');
    await opcoes[1].click();
    const campos = await p.$$('.painel:not([hidden]) .cartao-outra-campo');
    await campos[1].type(TEXTO_OUTRA);
    await espera(300);
  };

  /** A régua do DEPOIS: o que o cartão tem de mostrar para o PNG ser prova. */
  const exigirCartao = (m, rotulo) => {
    if (!m.cartaoVisivel) problemas.push(rotulo + ': o cartão não está visível');
    if (m.questoes !== 2) problemas.push(rotulo + ': esperava 2 .cartao-questao visíveis, achei ' + m.questoes);
    if (m.pressionadas < 1) problemas.push(rotulo + ': nenhuma opção com aria-pressed=true');
    if (m.campos[1] !== TEXTO_OUTRA) problemas.push(rotulo + ': a Outra resposta da LGPD não tem o texto (' + JSON.stringify(m.campos) + ')');
    if (!m.rotuloVisivel || m.rotulo !== 'ver terminal') problemas.push(rotulo + ': o "ver terminal" não está visível (' + m.rotulo + ')');
    if (m.detalhesAberto !== false) problemas.push(rotulo + ': o terminal cru deveria nascer FECHADO');
    if (m.paginaTransborda) problemas.push(rotulo + ': a página transborda para o lado');
  };

  try {
    // ── 1. pergunta, desktop 1600x1000 ──
    const desktop = await nova(1600, 1000, false);
    if (!await abrir(desktop, 'pergunta')) problemas.push('não achei a aba "pergunta" na lista');
    if (!await esperarPergunta(desktop)) problemas.push('a .pergunta não abriu no desktop — a foto não seria prova');
    if (!ANTES) {
      if (!await esperarCartao(desktop)) problemas.push('o cartão não apareceu no desktop (o servidor não mandou "cartao"?)');
      else await preencher(desktop);
    }
    await espera(500);
    await rolar(desktop, 'inicio');
    await espera(400);
    medidas.perguntaDesktop = await medir(desktop);
    await desktop.screenshot({ path: '/out/' + PREFIXO + '-pergunta-1600.png' });
    if (!ANTES) exigirCartao(medidas.perguntaDesktop, 'pergunta 1600');
    await desktop.close();

    // ── 2. pergunta, celular 390x844 (segundo carregamento) ──
    const celular = await nova(390, 844, true);
    if (!await abrir(celular, 'pergunta')) problemas.push('não achei a aba "pergunta" no celular');
    if (!await esperarPergunta(celular)) problemas.push('a .pergunta não abriu no celular');
    if (!ANTES) {
      if (!await esperarCartao(celular)) problemas.push('o cartão não apareceu no celular');
      else await preencher(celular);
    }
    await espera(500);
    await rolar(celular, 'inicio');
    await espera(400);
    medidas.perguntaCelular = await medir(celular);
    await celular.screenshot({ path: '/out/' + PREFIXO + '-pergunta-390.png' });
    if (ANTES) {
      // O corte medido: a tela crua é mais larga que o visor e a barra lateral aparece.
      const m = medidas.perguntaCelular;
      if (!(m.telaLargura > m.telaVisor)) problemas.push('ANTES: a .pergunta-tela deveria estar CORTADA no celular (scrollWidth ' + m.telaLargura + ' <= clientWidth ' + m.telaVisor + ')');
    } else {
      exigirCartao(medidas.perguntaCelular, 'pergunta 390');
      // Segundo PNG: o fim do cartão (Outra resposta preenchida, Enviar, ver terminal).
      await rolar(celular, 'fim');
      await espera(400);
      await celular.screenshot({ path: '/out/' + PREFIXO + '-pergunta-390-fim.png' });
    }
    await celular.close();

    // ── 3. menu que NÃO é AskUserQuestion, celular ──
    const menu = await nova(390, 844, true);
    if (!await abrir(menu, 'menu')) problemas.push('não achei a aba "menu" na lista');
    if (!await esperarPergunta(menu)) problemas.push('a .pergunta do menu não abriu');
    await espera(800);
    await rolar(menu, 'inicio');
    await espera(400);
    medidas.menuCelular = await medir(menu);
    await menu.screenshot({ path: '/out/' + PREFIXO + '-menu-390.png' });
    const mm = medidas.menuCelular;
    if (!ANTES) {
      if (!mm.telaVisivel) problemas.push('menu: a .pergunta-tela deveria estar visível');
      if (!(mm.telaLargura <= mm.telaVisor + 1)) problemas.push('menu: a tela deveria QUEBRAR linha (scrollWidth ' + mm.telaLargura + ' > clientWidth ' + mm.telaVisor + ')');
      if (mm.cartaoVisivel) problemas.push('menu: não pode haver cartão num menu que não é AskUserQuestion');
    }
    // No ANTES só REGISTRA (medidas.menuCelular): é o corte que existe hoje.
    await menu.close();
  } catch (e) {
    problemas.push('o roteiro estourou: ' + String(e && e.message).slice(0, 300));
  }

  if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
  if (requisicoes.length) problemas.push(requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));

  await navegador.close();
  console.log('@@MEDIDAS-CARTAO@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;

// ─── Corrida ──────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let filho = null;
  let scratch = null;

  function limpar() {
    let falhouLimpeza = false;
    if (filho && filho.exitCode === null) {
      try { process.kill(filho.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${filho.pid}) derrubado pelo pid exato`);
    }
    // D35: o carimbo prova que EU criei o socket; a enumeração prova que não há mais ninguém nele.
    // Matar exige as duas respostas.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean);
    const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      falhouLimpeza = true;
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      falhouLimpeza = true;
      falhas += 1;
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    return !falhouLimpeza;
  }

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      limpar();
      return process.exit(2);
    }
    for (const arquivo of [SERVIDOR, GANCHO, TELA_PERGUNTA, TELA_MENU, PAYLOAD_PERGUNTA]) {
      if (!fs.existsSync(arquivo)) {
        console.error(`🟡 ambiente indisponível: falta ${arquivo}`);
        limpar();
        return process.exit(2);
      }
    }

    const subpasta = path.join(SAIDA, PREFIXO);
    fs.mkdirSync(subpasta, { recursive: true });
    if (fs.readdirSync(subpasta).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${subpasta} já tem PNG — apague ou troque de pasta. O print recusa sobrescrever.`);
      limpar();
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-cartao-'));
    const home = path.join(scratch, 'home');
    const dirPerguntas = path.join(scratch, 'perguntas');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // As duas abas: duas janelas da MESMA sessão tmux, ambas 140x50 (a tela medida cabe inteira).
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'pergunta', '-x', '140', '-y', '50', '-c', os.tmpdir(),
      `cat '${TELA_PERGUNTA}'; exec sleep 100000`]);
    t(['new-window', '-d', '-t', `${SESSAO}:`, '-n', 'menu', '-c', os.tmpdir(),
      `cat '${TELA_MENU}'; exec sleep 100000`]);

    const panes = {};
    for (const linha of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    for (const nome of ['pergunta', 'menu']) {
      if (!panes[nome]) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
    }

    // ── a aba "pergunta": conversa + arquivo do hook (gravado pelo PRÓPRIO bin/gancho-pergunta.js) ──
    const payload = JSON.parse(fs.readFileSync(PAYLOAD_PERGUNTA, 'utf8'));
    const cwdPergunta = '/home/smoke/projetos/demo';
    const jsonlPergunta = caminhoDoJsonl(home, cwdPergunta, payload.session_id);
    escreverConversaCurta(jsonlPergunta, 'pergunta');
    // O `.jsonl` TEM de estar em `arquivoDaSessao(cwd, sessaoId)` sob o HOME falso, e o
    // `transcript_path` do payload tem de apontar para ele — senão o V3 (realpath) dá `null`.
    const rodouGancho = spawnSync(process.execPath, [GANCHO], {
      input: JSON.stringify({ ...payload, transcript_path: jsonlPergunta }),
      env: { PATH: process.env.PATH, HOME: home, COCKPIT_PERGUNTAS_DIR: dirPerguntas },
      encoding: 'utf8',
    });
    if (rodouGancho.status !== 0) throw new Error(`o hook saiu com ${rodouGancho.status}`);
    const arquivoDoHook = path.join(dirPerguntas, `${payload.session_id}.json`);
    const gravado = JSON.parse(fs.readFileSync(arquivoDoHook, 'utf8'));
    // O hook não aceita `em` injetado: quem se ajusta é o `statusUpdatedAt` falso (V4: 0 <= desde - em <= 60 s).
    const statusDesde = gravado.em + 30;

    const sessaoMenu = '7b1e6a52-3c1f-4d6e-9a41-5f0c2b8d9e13';
    const cwdMenu = '/home/smoke/projetos/menu';
    escreverConversaCurta(caminhoDoJsonl(home, cwdMenu, sessaoMenu), 'menu');

    const abas = [
      { nome: 'pergunta', sessaoId: payload.session_id, cwd: cwdPergunta, starttime: 2000001, statusDesde },
      { nome: 'menu', sessaoId: sessaoMenu, cwd: cwdMenu, starttime: 2000002, statusDesde: Date.now() },
    ];
    for (const aba of abas) {
      const pane = panes[aba.nome];
      plantarAgenteFalso(scratch, pane.panePid, { starttime: aba.starttime });
      escreverSessao(home, {
        pid: pane.panePid, janela: pane.janelaId, pane: pane.paneId,
        sessaoId: aba.sessaoId, cwd: aba.cwd, starttime: aba.starttime, statusDesde: aba.statusDesde,
      });
    }
    console.log(`  · fixture pronta: abas "pergunta" (com arquivo do hook) e "menu" (sem)`);

    const ambiente = { ...process.env };
    delete ambiente.COCKPIT_TOKEN;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_PERGUNTAS_DIR: dirPerguntas,
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'),
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_LEITURAS_DIR: path.join(scratch, 'leituras'),
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
    });
    filho = spawn(process.execPath, [SERVIDOR], { env: ambiente, stdio: ['ignore', 'ignore', 'pipe'] });
    let erroDoFilho = '';
    filho.stderr.on('data', (d) => { erroDoFilho += d; if (erroDoFilho.length > 65536) erroDoFilho = erroDoFilho.slice(-32768); });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (filho.exitCode !== null) break;
      pronto = (await pedir('/health')).status === 200;
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      ok(false, `o servidor (${PORTA}) não subiu: ${erroDoFilho.trim().split('\n').slice(-3).join(' | ')}`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · ${ANTES ? 'ANTES' : 'DEPOIS'}: servidor ${SERVIDOR} em http://127.0.0.1:${PORTA} (pid ${filho.pid}), socket ${SOCKET}`);

    // Antes do navegador: a API tem de estar dizendo o que o print vai mostrar.
    let chavePergunta = null;
    for (let i = 0; i < 40 && !chavePergunta; i += 1) {
      const lista = (await pedir('/api/abas')).json;
      const todas = Array.isArray(lista) ? lista : ((lista && lista.abas) || []);
      const aba = todas.find((a) => a.titulo === 'pergunta');
      if (aba && aba.esperando) chavePergunta = aba.chave;
      else await espera(250);
    }
    if (!ok(Boolean(chavePergunta), 'a aba "pergunta" está em `waiting` na lista do servidor')) {
      limpar();
      return process.exit(1);
    }
    if (!ANTES) {
      let cartao = null;
      for (let i = 0; i < 20 && !cartao; i += 1) {
        const r = await pedir(`/api/abas/${chavePergunta}/tela`);
        cartao = r.json && r.json.cartao;
        if (!cartao) await espera(250);
      }
      ok(Boolean(cartao) && cartao.perguntas.length === 2 && cartao.toolUseId === payload.tool_use_id,
        'GET …/tela devolve o cartão de 2 perguntas (Audio, Aviso LGPD) com o toolUseId do hook');
      if (!cartao) { limpar(); return process.exit(1); }
    }

    fs.writeFileSync(path.join(scratch, 'roteiro.js'), ROTEIRO);
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `ANTES=${ANTES ? '1' : '0'}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${subpasta}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));

    const MARCADOR = '@@MEDIDAS-CARTAO@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    let relatorio = null;
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    if (!relatorio) console.log(saidaDocker);
    else console.log(`  · medidas: ${JSON.stringify(relatorio.medidas)}`);

    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : (ANTES
        ? 'ANTES: a tela crua da pergunta está cortada no celular (o defeito medido) e o menu foi registrado'
        : 'DEPOIS: cartão de 2 perguntas com opção marcada, Outra resposta preenchida e "ver terminal"; o menu quebra linha'));

    const esperados = ['pergunta-1600', 'pergunta-390', 'menu-390'];
    if (!ANTES) esperados.push('pergunta-390-fim');
    for (const nome of esperados) {
      const arquivo = path.join(subpasta, `${PREFIXO}-${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o print estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ PRINT DO CARTÃO VERMELHO' : '✅ PRINT DO CARTÃO VERDE'}`
      + ` (${PREFIXO}) — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}/${PREFIXO}\n`);
  }
  process.exit(saida);
})();
