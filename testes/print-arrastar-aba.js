#!/usr/bin/env node
'use strict';
// PRINT DO ARRASTO DA ABA PARA O SPLIT (D73). Chromium de verdade: 1600x1000 (antes / durante na
// borda / durante no centro / depois) e 390x844 (celular: a linha nem é arrastável e o gesto não
// abre nada). O arrasto é SINTÉTICO (DataTransfer + DragEvent): o arrasto nativo do mouse, o Esc e o
// solto fora da janela não existem no headless e ficam para o smoke manual.
//
// Esqueleto copiado de testes/smoke-navegador-split.js (fixture de /proc falso + sessions/<pid>.json,
// tmux num socket próprio, docker run --network host, limpeza fail-closed D35).
//
// Roteiro: abre A|B, tira o PNG "antes"; arrasta a conversa 3 para a borda direita de B (fantasma) e
// para o centro de B (destaque), um PNG de cada; confere que a lista NÃO se repinta no meio do
// arrasto; solta na borda e confere A|B|X na ordem; no celular confere zero efeito.
//
// Uso: SAIDA=<pasta> [PORT=7941] node testes/print-arrastar-aba.js
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs vão cair>');
  process.exit(2);
}

const PORTA = Number(process.env.PORT) || 7941;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const LARGURA = 1600;
const ALTURA = 1000;
const N_ABAS = 3;

// ─── Fail-closed do socket, mesmo padrão dos outros smokes de split ──────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-arrasto-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
  // As sessões que ESTE script cria. A limpeza fail-closed compara o socket com este
  // conjunto antes de derrubar qualquer coisa (D35).
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

// ─── As N abas da fixture — mesmo arreio do smoke-celular-split.js ──────────

function raizProc(scratch) {
  return path.join(scratch, 'proc');
}

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
function plantarAgenteFalso(scratch, pid, { comm = 'claude', argv = ['/usr/bin/claude'], starttime }) {
  const dir = path.join(raizProc(scratch), String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = `(${comm})`;
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);
  campos[5] = String(pid);
  campos[6] = '34816';
  campos[7] = String(pid);
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime, status }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive',
    sessionId: sessaoId,
    cwd,
    status,
    updatedAt: Date.now(),
    pid,
    procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
})}\n`;

/** Uma conversa curta — só o bastante para o `sessao` ter um título e um `humano`/`texto`. */
function escreverConversaCurta(caminho, nome) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const base = Date.now() - 600000;
  const linhas = [
    linhaHumano(new Date(base).toISOString(), `oi, sou a conversa ${nome}`),
    linhaAssistente(new Date(base + 30000).toISOString(), `resposta da conversa ${nome}`),
  ];
  fs.writeFileSync(caminho, linhas.join(''));
}

function saude() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── O roteiro do navegador — roda DENTRO do container ───────────────────────

const ROTEIRO = `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const pagina = await navegador.newPage();
  const erros = [];
  const requisicoes = [];
  const ouvir = (p) => {
    p.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
    p.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
    p.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });
  };
  ouvir(pagina);
  // pt-BR explícito (molde de print-monitor.js): o Chromium da imagem é en-US, e o print tem de
  // mostrar o rótulo que o dono vê ("Abre aqui:", "Troca por:").
  await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* modo privado */ } });

  const problemas = [];
  const medidas = {};

  /** Clica na linha "conversaN"; com Ctrl abre AO LADO — igual em qualquer sistema operacional. */
  const clicarLinha = (p, n, ctrl) => p.evaluate((titulo, comCtrl) => {
    const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
    const alvo = linhas.find((l) => {
      const t2 = l.querySelector('.conversa-titulo');
      return t2 && t2.textContent.includes(titulo);
    });
    const botao = alvo && alvo.querySelector('.conversa');
    if (!botao) return false;
    botao.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: comCtrl }));
    return true;
  }, 'conversa' + n, Boolean(ctrl));

  /**
   * O gesto com UM DataTransfer sintético: dragstart na linha → dragover no #chat em
   * fx (fração da largura do painel de índice 1) → (opcional) drop + dragend. Devolve o que a
   * tela mostra depois. O dragstart é o que preenche a chave do arrasto — sem ele os ouvintes
   * ignoram tudo.
   */
  const gesto = (p, args) => p.evaluate(({ titulo, fx, soltar, x }) => {
    const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
    const alvo = linhas.find((l) => {
      const t2 = l.querySelector('.conversa-titulo');
      return t2 && t2.textContent.includes(titulo);
    });
    const botao = alvo && alvo.querySelector('.conversa');
    if (!botao) return { erro: 'sem linha ' + titulo };
    const dt = new DataTransfer();
    window.__dt = dt;
    window.__origem = botao;
    const chat = document.getElementById('chat');
    botao.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    let cx = x;
    let cy = 400;
    const painel = document.querySelectorAll('#paineis .painel')[1];
    if (painel) {
      const r = painel.getBoundingClientRect();
      cx = r.left + fx * r.width;
      cy = r.top + r.height / 2;
    }
    window.__ponto = { cx, cy };
    chat.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    if (soltar) {
      chat.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      botao.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return { cx, cy };
  }, args);

  const encerrar = (p) => p.evaluate(() => {
    window.__origem.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
  });

  const estado = (p) => p.evaluate(() => {
    const paineis = Array.from(document.querySelectorAll('#paineis .painel'));
    const titulosDaLista = {};
    for (const b of document.querySelectorAll('#abas .conversa')) {
      const t2 = b.querySelector('.conversa-titulo');
      titulosDaLista[b.dataset.chave] = t2 ? t2.textContent.trim() : '';
    }
    const fantasma = document.querySelector('#paineis .fantasma-painel');
    const filhos = Array.from(document.getElementById('paineis').children);
    const rotulo = paineis[1] && paineis[1].querySelector('.rotulo-troca');
    return {
      chaves: paineis.map((n) => n.dataset.chave),
      titulos: paineis.map((n) => titulosDaLista[n.dataset.chave] || '?'),
      tituloNoPainel: paineis.map((n) => { const t2 = n.querySelector('.chat-titulo'); return t2 ? t2.textContent.trim() : ''; }),
      fantasma: fantasma ? fantasma.textContent : null,
      fantasmaEhUltimo: fantasma ? filhos[filhos.length - 1] === fantasma : false,
      alvoTroca1: paineis[1] ? paineis[1].dataset.alvoTroca || null : null,
      rotuloTroca1: rotulo ? rotulo.textContent : null,
      vista: document.getElementById('app').dataset.vista,
    };
  });

  try {
    await pagina.setViewport({ width: ${LARGURA}, height: ${ALTURA} });
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(500);

    // 1 — A|B: clique NORMAL na primeira, Ctrl+clique na segunda (abre AO LADO).
    if (!await clicarLinha(pagina, 1, false)) problemas.push('não achei "conversa1" na lista para o clique normal');
    await espera(600);
    if (!await clicarLinha(pagina, 2, true)) problemas.push('não achei "conversa2" na lista para o Ctrl+clique');
    await espera(800);

    const antes = await estado(pagina);
    medidas.antes = antes;
    if (antes.chaves.length !== 2) problemas.push('antes: #paineis .painel deveria ser 2, é ' + antes.chaves.length);
    await pagina.screenshot({ path: '/out/1-antes-split.png' }).catch(() => {});

    // 2 — DURANTE, na borda direita de B: a coluna fantasma é o ÚLTIMO filho e leva o nome.
    const g1 = await gesto(pagina, { titulo: 'conversa3', fx: 0.9, soltar: false });
    if (g1.erro) problemas.push(g1.erro);
    await espera(200);
    const borda = await estado(pagina);
    medidas.duranteBorda = borda;
    if (borda.fantasma === null || !borda.fantasmaEhUltimo) problemas.push('borda: a coluna fantasma deveria ser o último filho de #paineis: ' + JSON.stringify(borda));
    else if (!borda.fantasma.includes('conversa3')) problemas.push('borda: a coluna fantasma deveria citar conversa3: ' + borda.fantasma);
    await pagina.screenshot({ path: '/out/2-durante-borda-direita.png' }).catch(() => {});
    await encerrar(pagina);
    await espera(200);
    const aposBorda = await estado(pagina);
    if (aposBorda.fantasma !== null) problemas.push('depois do dragend a coluna fantasma deveria sumir');
    if (aposBorda.chaves.length !== 2) problemas.push('dragend sem drop não pode abrir painel: ' + aposBorda.chaves.length);

    // 3 — DURANTE, no centro de B: o painel inteiro destacado com o nome de quem entra.
    const g2 = await gesto(pagina, { titulo: 'conversa3', fx: 0.5, soltar: false });
    if (g2.erro) problemas.push(g2.erro);
    await espera(200);
    const centro = await estado(pagina);
    medidas.duranteCentro = centro;
    if (centro.alvoTroca1 !== '1') problemas.push('centro: o painel 1 deveria ter data-alvo-troca=1: ' + JSON.stringify(centro));
    else if (!centro.rotuloTroca1 || !centro.rotuloTroca1.includes('conversa3')) problemas.push('centro: o rótulo deveria citar conversa3: ' + centro.rotuloTroca1);
    await pagina.screenshot({ path: '/out/3-durante-centro.png' }).catch(() => {});
    await encerrar(pagina);
    await espera(200);

    // 4 — a lista NÃO se repinta no meio do arrasto (ciclo de 5 s), e repinta no dragend.
    await pagina.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
      const alvo = linhas.find((l) => l.querySelector('.conversa-titulo').textContent.includes('conversa3'));
      const botao = alvo.querySelector('.conversa');
      window.__dt = new DataTransfer();
      window.__origem = botao;
      botao.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
    });
    await espera(6000);
    const mesmoNo = await pagina.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
      const alvo = linhas.find((l) => l.querySelector('.conversa-titulo').textContent.includes('conversa3'));
      return alvo.querySelector('.conversa') === window.__origem;
    });
    medidas.listaCongelada = mesmoNo;
    if (!mesmoNo) problemas.push('a lista foi repintada no meio do arrasto (o nó da linha arrastada mudou)');
    await encerrar(pagina);
    await espera(300);
    const repintou = await pagina.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
      const alvo = linhas.find((l) => l.querySelector('.conversa-titulo').textContent.includes('conversa3'));
      return alvo.querySelector('.conversa') !== window.__origem;
    });
    medidas.listaRepintouNoFim = repintou;
    if (!repintou) problemas.push('depois do dragend a lista deveria ter sido repintada');

    // 5 — DEPOIS: solta na borda direita de B; A|B|X, na ordem, sem fantasma.
    const g3 = await gesto(pagina, { titulo: 'conversa3', fx: 0.9, soltar: true });
    if (g3.erro) problemas.push(g3.erro);
    await espera(800);
    const depois = await estado(pagina);
    medidas.depois = depois;
    if (depois.chaves.length !== 3) problemas.push('depois: #paineis .painel deveria ser 3, é ' + depois.chaves.length);
    if (depois.tituloNoPainel.join() !== 'conversa1,conversa2,conversa3') problemas.push('depois: ordem esperada conversa1,conversa2,conversa3, veio ' + depois.tituloNoPainel.join());
    if (depois.fantasma !== null) problemas.push('depois: a coluna fantasma deveria ter sumido');
    await pagina.screenshot({ path: '/out/4-depois-split.png' }).catch(() => {});

    // 6 — CELULAR: a linha nem é arrastável e o gesto sintético não faz nada.
    const celular = await navegador.newPage();
    ouvir(celular);
    // pt-BR explícito (molde de print-monitor.js): o Chromium da imagem é en-US, e o print tem de
    // mostrar o rótulo que o dono vê ("Abre aqui:", "Troca por:").
    await celular.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* modo privado */ } });
    await celular.setViewport({ width: 390, height: 844 });
    await celular.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await celular.waitForSelector('#abas', { timeout: 15000 });
    await espera(600);
    const arrastavel = await celular.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
      const alvo = linhas.find((l) => l.querySelector('.conversa-titulo').textContent.includes('conversa1'));
      return alvo.querySelector('.conversa').draggable;
    });
    medidas.celularArrastavel = arrastavel;
    if (arrastavel !== false) problemas.push('celular: a linha não deveria ser arrastável (draggable=' + arrastavel + ')');
    const vistaAntes = (await estado(celular)).vista;
    await celular.screenshot({ path: '/out/5-celular-antes.png' }).catch(() => {});
    const g4 = await gesto(celular, { titulo: 'conversa1', fx: 0.5, soltar: true, x: 200 });
    if (g4.erro) problemas.push(g4.erro);
    await espera(500);
    const celularDepois = await estado(celular);
    medidas.celularDepois = celularDepois;
    if (celularDepois.fantasma !== null) problemas.push('celular: não pode haver coluna fantasma');
    if (celularDepois.chaves.length !== 0) problemas.push('celular: o arrasto não pode abrir painel (' + celularDepois.chaves.length + ')');
    if (celularDepois.vista !== vistaAntes) problemas.push('celular: a vista mudou de ' + vistaAntes + ' para ' + celularDepois.vista);
    await celular.screenshot({ path: '/out/6-celular-depois.png' }).catch(() => {});

    const geral = await pagina.evaluate(() => {
      const folhas = Array.from(document.styleSheets).filter((f) => {
        try { return f.cssRules && f.cssRules.length > 0; } catch { return true; }
      }).length;
      return {
        folhasComRegras: folhas,
        imagensQuebradas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
      };
    });
    if (!geral.folhasComRegras) problemas.push('NENHUMA folha de estilo com regras');
    if (geral.imagensQuebradas) problemas.push(geral.imagensQuebradas + ' imagem(ns) quebrada(s)');
  } catch (e) {
    problemas.push('o roteiro estourou: ' + String(e && e.message).slice(0, 300));
  }

  if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
  if (requisicoes.length) problemas.push(requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));

  await navegador.close();
  console.log('@@MEDIDAS-ARRASTO@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;

// ─── Corrida ──────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let s3 = null;
  let scratch = null;

  function limpar() {
    let falhouLimpeza = false;
    if (s3 && s3.exitCode === null) {
      try { process.kill(s3.pid); } catch { /* já morreu */ }
      console.log(`  · S3 (pid ${s3.pid}) derrubado pelo pid exato`);
    }
    // A D35 pede DUAS respostas, não uma: o carimbo prova que EU criei aquilo, e a
    // enumeração prova que não há mais ninguém no socket. São perguntas diferentes, e matar
    // exige as duas — o achado do painel de execução de 08/09 era que só a primeira estava
    // aqui (e no molde que copiei).
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean);
    const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      // Sobrou quem eu não criei: mata só as minhas e deixa o socket de pé, reclamando.
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

    fs.mkdirSync(SAIDA, { recursive: true });
    const jaTemPng = fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'));
    if (jaTemPng) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O smoke recusa sobrescrever.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-arrasto-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'conversa1', '-c', os.tmpdir(), 'sleep', '600']);
    for (let i = 2; i <= N_ABAS; i += 1) {
      t(['new-window', '-d', '-t', `${SESSAO}:`, '-n', `conversa${i}`, '-c', os.tmpdir(), 'sleep', '600']);
    }

    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }

    for (let i = 1; i <= N_ABAS; i += 1) {
      const nome = `conversa${i}`;
      const pane = panes[nome];
      if (!pane) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
      const cwd = `/home/smoke/projetos/${nome}`;
      const sessaoId = `sess-${nome}`;
      escreverConversaCurta(caminhoDoJsonl(home, cwd, sessaoId), nome);
      plantarAgenteFalso(scratch, pane.panePid, { starttime: 2000000 + i });
      escreverSessao(home, {
        pid: pane.panePid, janela: pane.janelaId, pane: pane.paneId,
        sessaoId, cwd, starttime: 2000000 + i, status: 'idle',
      });
    }
    console.log(`  · fixture pronta: ${N_ABAS} abas (conversa1..conversa${N_ABAS})`);

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
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
    });
    s3 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (s3.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      ok(false, `S3 (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · S3 no ar em http://127.0.0.1:${PORTA} (pid ${s3.pid}), socket ${SOCKET}`);

    fs.writeFileSync(path.join(scratch, 'pane.js'), ROTEIRO);

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker);

    let relatorio = null;
    const MARCADOR = '@@MEDIDAS-ARRASTO@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }

    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : 'o arrasto mostrou o preview (borda e centro), a lista esperou o fim do gesto, o solto deu A|B|X e o celular não mudou');

    for (const nome of ['1-antes-split.png', '2-durante-borda-direita.png', '3-durante-centro.png', '4-depois-split.png', '5-celular-antes.png', '6-celular-depois.png']) {
      const arquivo = path.join(SAIDA, nome);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ PRINT DO ARRASTO DA ABA VERMELHO' : '✅ PRINT DO ARRASTO DA ABA VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
