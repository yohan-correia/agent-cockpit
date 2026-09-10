#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — split view, fase 3 (design original,
// §3.5). Chromium de verdade, DESKTOP (1600×1000) — é o único smoke deste card que roda largo:
// a promessa da fase 3 é visual e só existe acima de 760px (Fase 0 do card: recurso de
// computador).
//
// Esqueleto copiado de `testes/smoke-celular-split.js` (fixture de /proc falso +
// sessions/<pid>.json, tmux num socket próprio, docker run --network host com puppeteer-core) —
// mesma infra, MENOS o par de viewports e o MODO antes/depois (aqui não há "antes": a fase 2 já
// provou zero mudança com 1 painel; esta prova é sobre 2 e 6).
//
// Roteiro: abre 2 painéis (Ctrl+clique na lista), tira PNG; abre mais 4 (total 6), tira PNG.
// Asserts: `#paineis .painel` tem 2 e depois 6 (escopado — #44) · com 6, a `.paineis` tem
// `scrollWidth > clientWidth` e o `document.documentElement` NÃO (o cenário que o DOM falso do
// gate-ui não sabe medir) · a sequência INTEGRADA de foco (clicar em A, digitar `/`, clicar em
// B: a paleta de A fecha, o cursor vai para B) · as duas caixas com texto DIFERENTE ao mesmo
// tempo (caixa de envio por painel, 2026-09-09, D42 — o `#envio-para` saiu, a proximidade
// física já diz o destino).
//
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

const PORTA = Number(process.env.PORT) || 7893;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const LARGURA = 1600;
const ALTURA = 1000;
const N_ABAS = 6;

// ─── Fail-closed do socket, mesmo padrão dos outros smokes de split ──────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-splitnav-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
  // As sessões que ESTE script cria. A limpeza fail-closed compara o socket com este
  // conjunto antes de derrubar qualquer coisa (D35).
  const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
const N_ABAS = Number(process.env.N_ABAS);

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
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
  pagina.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });

  const problemas = [];
  const medidas = {};

  /** Clica na linha "conversaN" com Ctrl (abre AO LADO) — igual em qualquer sistema operacional. */
  const ctrlClicarLinha = (n) => pagina.evaluate((titulo) => {
    const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
    const alvo = linhas.find((l) => {
      const t2 = l.querySelector('.conversa-titulo');
      return t2 && t2.textContent.includes(titulo);
    });
    const botao = alvo && alvo.querySelector('.conversa');
    if (!botao) return false;
    botao.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    return true;
  }, 'conversa' + n);

  try {
    await pagina.setViewport({ width: ${LARGURA}, height: ${ALTURA} });
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(500);

    // A primeira conversa abre com clique NORMAL (sem Ctrl) — é o caminho de sempre.
    const abriuPrimeira = await pagina.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
      const alvo = linhas.find((l) => {
        const t2 = l.querySelector('.conversa-titulo');
        return t2 && t2.textContent.includes('conversa1');
      });
      const botao = alvo && alvo.querySelector('.conversa');
      if (botao) botao.click();
      return Boolean(botao);
    });
    if (!abriuPrimeira) problemas.push('não achei "conversa1" na lista para o clique normal');
    await espera(600);

    // Ctrl+clique na segunda: abre AO LADO — agora são 2 painéis.
    if (!await ctrlClicarLinha(2)) problemas.push('não achei "conversa2" na lista para o Ctrl+clique');
    await espera(800);

    const doisPaineis = await pagina.evaluate(() => document.querySelectorAll('#paineis .painel').length);
    medidas.doisPaineis = doisPaineis;
    if (doisPaineis !== 2) problemas.push('depois de abrir 2, #paineis .painel deveria ser 2, é ' + doisPaineis);

    // 0 — a sequência INTEGRADA de foco, que o DOM falso do gate não reproduz inteira: clicar
    // na caixa de A, digitar "/" (a paleta de A abre), clicar na caixa de B e conferir a
    // paleta de A FECHADA, o cursor (document.activeElement) em B e data-foco="1" em B.
    // O fechamento é ASSÍNCRONO — o blur agenda um setTimeout de 120ms — por isso o
    // waitForFunction ANTES do assert conjunto; um evaluate imediato reprovaria código certo.
    await pagina.click('#paineis .painel:nth-child(1) .entrada');
    await pagina.type('#paineis .painel:nth-child(1) .entrada', '/', { delay: 15 });
    await pagina.waitForFunction(
      () => !document.querySelectorAll('#paineis .painel')[0].querySelector('.paleta').hidden,
      { timeout: 3000 },
    );
    await pagina.click('#paineis .painel:nth-child(2) .entrada');
    await pagina.waitForFunction(
      () => document.querySelectorAll('.painel .paleta:not([hidden])').length === 0,
      { timeout: 3000 },
    );
    medidas.sequenciaFoco = await pagina.evaluate(() => {
      const painelB = document.querySelectorAll('#paineis .painel')[1];
      return {
        cursorEmB: document.activeElement === painelB.querySelector('.entrada'),
        dataFocoB: painelB.dataset.foco,
      };
    });
    if (!medidas.sequenciaFoco.cursorEmB || medidas.sequenciaFoco.dataFocoB !== '1') {
      problemas.push('sequência de foco: clicar na caixa de B não fechou a paleta de A / não moveu o cursor / não marcou data-foco em B: ' + JSON.stringify(medidas.sequenciaFoco));
    }

    // 1 — texto DIFERENTE em cada caixa, ao MESMO TEMPO: os dois nós coexistem, cada um com
    // o PRÓPRIO valor, não vazio — impossível quando a caixa era uma só (D42).
    await pagina.click('#paineis .painel:nth-child(1) .entrada', { clickCount: 3 });
    await pagina.keyboard.press('Backspace');
    await pagina.type('#paineis .painel:nth-child(1) .entrada', 'mensagem para a conversa1', { delay: 5 });
    await pagina.type('#paineis .painel:nth-child(2) .entrada', 'mensagem para a conversa2', { delay: 5 });
    medidas.duasCaixas = await pagina.evaluate(() => Array.from(document.querySelectorAll('#paineis .painel .entrada')).map((e) => e.value));
    if (medidas.duasCaixas.length !== 2 || !medidas.duasCaixas[0] || !medidas.duasCaixas[1] || medidas.duasCaixas[0] === medidas.duasCaixas[1]) {
      problemas.push('as duas caixas deveriam ter valores DISTINTOS e não-vazios ao mesmo tempo: ' + JSON.stringify(medidas.duasCaixas));
    }

    // 2 — PNG "depois": as DUAS caixas visíveis, cada uma com o próprio texto — é o que vai
    // no relatório da entrega.
    await pagina.screenshot({ path: '/out/split-2-caixas-depois.png' }).catch(() => {});

    // Mais 4 (Ctrl+clique em 3..6) — total 6, sem limite (Fase 0 do card, item 2).
    for (let i = 3; i <= N_ABAS; i += 1) {
      if (!await ctrlClicarLinha(i)) problemas.push('não achei "conversa' + i + '" na lista para o Ctrl+clique');
      await espera(400);
    }
    await espera(600);

    const seisPaineis = await pagina.evaluate(() => document.querySelectorAll('#paineis .painel').length);
    medidas.seisPaineis = seisPaineis;
    if (seisPaineis !== N_ABAS) problemas.push('depois de abrir ' + N_ABAS + ', #paineis .painel deveria ser ' + N_ABAS + ', é ' + seisPaineis);

    const rolagem = await pagina.evaluate(() => {
      const paineis = document.querySelector('.paineis');
      const doc = document.documentElement;
      return {
        paineisScrollWidth: paineis ? paineis.scrollWidth : null,
        paineisClientWidth: paineis ? paineis.clientWidth : null,
        docScrollWidth: doc.scrollWidth,
        docClientWidth: doc.clientWidth,
      };
    });
    medidas.rolagem = rolagem;
    if (!(rolagem.paineisScrollWidth > rolagem.paineisClientWidth)) {
      problemas.push('com 6 painéis, .paineis deveria rolar de lado (scrollWidth > clientWidth): ' + JSON.stringify(rolagem));
    }
    if (rolagem.docScrollWidth > rolagem.docClientWidth + 1) {
      problemas.push('mas o DOCUMENTO não pode rolar de lado — é a régua que o DOM falso do gate não mede: ' + JSON.stringify(rolagem));
    }

    await pagina.screenshot({ path: '/out/split-6-paineis.png' }).catch(() => {});

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
  console.log('@@MEDIDAS-SPLIT-NAV@@' + JSON.stringify({ medidas, problemas }));
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

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-split-nav-'));
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
      '-e', `N_ABAS=${N_ABAS}`,
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
    const MARCADOR = '@@MEDIDAS-SPLIT-NAV@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }

    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : `2 e depois ${N_ABAS} painéis abriram, a rolagem lateral é do container (não do documento), e cada caixa é do PRÓPRIO painel (D42)`);

    for (const nome of ['split-2-caixas-depois.png', `split-${N_ABAS}-paineis.png`]) {
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
    console.log(`\n${falhas || saida ? '❌ SMOKE DO SPLIT (DESKTOP) VERMELHO' : '✅ SMOKE DO SPLIT (DESKTOP) VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
