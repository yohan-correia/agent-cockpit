#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — o carimbo de "lido" atravessa aparelhos (card
// `lido-compartilhado-entre-aparelhos`; D53, 14/09; spec
// docs/superpowers/specs/2026-09-14-lido-compartilhado-entre-aparelhos-design.md, §6.2).
//
// Prova o DEFEITO que o card veio matar: A (celular) e B (desktop) olham a MESMA conversa
// no MESMO servidor. A abre a aba — B, sem recarregar a página, vê o destaque sumir sozinho
// na próxima batida da lista (5s). Antes da D53 isso não acontecia: o "lido" morava no
// `localStorage` de cada aparelho, e ler num não mudava nada no outro.
//
// Molde: `testes/smoke-celular-primeira-leva.js` — é o único smoke desta casa que já monta um
// `HOME` de mentira inteiro (`~/.claude/sessions/<pid>.json` + o `.jsonl` no caminho que
// `lib/abas.js` monta) sobre uma pane de VERDADE, num socket tmux próprio. Copiadas de lá:
// `plantarAgenteFalso`, `escreverSessao`, `caminhoDoJsonl`, `conversaPequena`, e o padrão de
// socket carimbado (sessão "ancora" separada, para provar posse antes do `kill-server`).
// `smoke-navegador-abas.js` NÃO serve de molde aqui: ele roda com `COCKPIT_BIN_CLAUDE=/bin/true`
// de propósito para NENHUM CLI escrever arquivo — sem CLI não há sessaoId nem atualizadoEm, e
// os dois `marcarLido` deste percurso sairiam na primeira linha sem provar nada.
//
// Este é o ÚNICO smoke da casa que exercita o `POST /api/lidas` contra o `server.js` real —
// por isso `COCKPIT_LIDAS_DIR` numa pasta temporária é OBRIGATÓRIO, e SOBRESCREVE (nunca
// herda) o que vier do ambiente: um smoke que provasse "lido compartilhado" marcando as
// conversas REAIS do dono como lidas seria o próprio defeito que este card mata.
//
// Dois PAGES do MESMO navegador (não dois containers): "os dois aparelhos" são duas abas de
// Chromium contra o MESMO `server.js`, uma em viewport de celular, outra em desktop — o que
// importa é que os dois falam com o servidor de verdade, não que rodem em processos
// separados.
//
// Códigos de saída: 0 = passou · 1 = falha de produto/assert · 2 = erro de USO ou de AMBIENTE
// (imagem docker ausente, porta ocupada, servidor não subiu).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA || path.join(os.homedir(), '.cockpit', 'smoke-shots', '2026-09-14-lido-compartilhado');
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const PNGS = ['01-antes-celular', '02-antes-desktop', '03-depois-desktop', '04-depois-celular'];

// ─── Porta — fail-closed, nunca herdada, nunca 7879 (produção) nem 7899 (jobs, #24) ─────────

function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => {
      const campos = linha.trim().split(/\s+/);
      return (campos[3] || '').endsWith(`:${porta}`);
    });
  } catch {
    return true;
  }
}

const PORTA = Number(process.env.PORT || 7894); // faixa alta, nunca 7879 (produção) nem 7899 (#24)
if (PORTA < 7890 || PORTA > 7898) {
  console.error(`🔴 porta ${PORTA} fora da faixa 7890-7898 — nunca 7879 (produção) nem 7899 (#24).`);
  process.exit(2);
}
if (!portaLivre(PORTA)) {
  console.error(`🔴 a porta ${PORTA} já está ocupada. Tente outra (PORT=...).`);
  process.exit(2);
}

// ─── Fail-closed do socket, mesmo padrão de smoke-celular-primeira-leva.js ──────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-lido-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const JANELA = 'projeto-lido';

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

// ─── Fixture: uma pane de verdade, um agente de mentira, uma conversa pequena ───────────────
// Copiado de testes/smoke-celular-primeira-leva.js, sem alteração de desenho.

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

/** `~/.claude/sessions/<pid>.json`, casado com o `starttime` plantado no /proc falso. */
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

/** `~/.claude/projects/<cwd-com-hifens>/<sessaoId>.jsonl` — o caminho que `lib/abas.js` monta. */
function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
})}\n`;

/** Uma conversa pequena (4 linhas), última mensagem no `T` dado. Devolve `T` em ms. */
function conversaPequena(caminho, baseMs) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const linhas = [];
  let quando = baseMs - 3 * 60000;
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'oi, tudo bem por aí?')); quando += 60000;
  linhas.push(linhaAssistente(new Date(quando).toISOString(), 'tudo certo — o que você precisa?')); quando += 60000;
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'só confirmando que a aba está viva')); quando += 60000;
  linhas.push(linhaAssistente(new Date(quando).toISOString(), 'confirmado, sigo por aqui.'));
  fs.writeFileSync(caminho, linhas.join(''));
  return quando;
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

// ─── O roteiro — DOIS pages do MESMO navegador, contra o MESMO servidor ─────────────────────

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');
const BASE = process.env.BASE;
const JANELA = process.env.JANELA;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** O texto do pino ('◆'/'✓'/etc.) da linha cujo título contém \`nome\`, ou null se não achar. */
const pinoDaLinha = (pagina, nome) => pagina.evaluate((n) => {
  const linhas = Array.from(document.querySelectorAll('#lista-conversas .conversa-linha'));
  const alvo = linhas.find((l) => {
    const titulo = l.querySelector('.conversa-titulo');
    return titulo && titulo.textContent.includes(n);
  });
  const pino = alvo && alvo.querySelector('.conversa-pino');
  return pino ? pino.textContent.trim() : null;
}, nome);

/** Clica na linha e devolve se achou o botão — mesmo helper das outras telas de navegador. */
const abrirALinha = (pagina, nome) => pagina.evaluate((n) => {
  const linhas = Array.from(document.querySelectorAll('#lista-conversas .conversa-linha'));
  const alvo = linhas.find((l) => {
    const titulo = l.querySelector('.conversa-titulo');
    return titulo && titulo.textContent.includes(n);
  });
  const botao = alvo && alvo.querySelector('.conversa');
  if (botao) botao.click();
  return Boolean(botao);
}, nome);

const problemas = [];

/**
 * Cada "aparelho" ganha um CONTEXTO próprio do navegador, não só uma aba nova.
 *
 * Isto é o que torna este smoke uma PROVA, e não uma coincidência. Dois newPage do mesmo
 * contexto compartilham o localStorage da origem — então o percurso inteiro passaria IGUAL
 * com o código velho, em que a marca vivia no localStorage: B "veria" a leitura de A por
 * estarem no mesmo armazenamento, e não porque o servidor contou. Teste que passa nos dois
 * mundos não protege contra a regressão que ele diz cobrir. Com contextos separados, a única
 * coisa que liga A e B é o GET /api/abas — que é exatamente a tese do card.
 *
 * Achado do painel de execução (Codex), 14/09. createBrowserContext é o nome a partir do
 * puppeteer 22; a imagem cockpit-smoke:latest traz a 23.11.1 (medido).
 *
 * Sem crase neste comentário de propósito: ele vive DENTRO do template literal de
 * montarRoteiro(), e uma crase solta aqui fecha a string e quebra o arquivo inteiro.
 */
async function abrirPagina(navegador, viewport) {
  const contexto = await navegador.createBrowserContext();
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push('CONSOLE: ' + m.text().slice(0, 200)); });
  pagina.on('response', (r) => { if (r.status() >= 400) erros.push(r.status() + ' ' + r.url()); });
  await pagina.setViewport(viewport);
  await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await pagina.waitForSelector('#abas', { timeout: 15000 });
  await espera(600);
  pagina.__erros = erros;
  return pagina;
}

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // A = celular (390×844, o aparelho que motivou a mudança — regra do dono de 25/08).
  // B = desktop (1400×900, sidebar sempre visível: aqui o defeito antigo era invisível
  // porque cada aparelho tinha sua PRÓPRIA marca).
  const paginaA = await abrirPagina(navegador, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const paginaB = await abrirPagina(navegador, { width: 1400, height: 900 });

  // ── 1) ANTES: os dois mostram ◆ na MESMA conversa ──────────────────────────
  const pinoAntesA = await pinoDaLinha(paginaA, JANELA);
  const pinoAntesB = await pinoDaLinha(paginaB, JANELA);
  if (!pinoAntesA || !pinoAntesA.includes('◆')) problemas.push('ANTES (A/celular): pino não é ◆ (' + pinoAntesA + ')');
  if (!pinoAntesB || !pinoAntesB.includes('◆')) problemas.push('ANTES (B/desktop): pino não é ◆ (' + pinoAntesB + ')');
  await paginaA.screenshot({ path: '/out/01-antes-celular.png' });
  await paginaB.screenshot({ path: '/out/02-antes-desktop.png' });

  // ── 2) A abre a aba — dispara marcarLido() → POST /api/lidas ───────────────
  const achouBotao = await abrirALinha(paginaA, JANELA);
  if (!achouBotao) problemas.push('A: não achei o botão da linha para clicar');
  await espera(700); // o POST é fire-and-forget (.catch); dar tempo de chegar ao servidor

  // ── 3) B, SEM RECARREGAR, espera o tique de 5s (MS_LISTA) ───────────────────
  await espera(6500);
  const pinoDepoisB = await pinoDaLinha(paginaB, JANELA);
  if (!pinoDepoisB || !pinoDepoisB.includes('✓') || pinoDepoisB.includes('◆')) {
    problemas.push('DEPOIS (B/desktop, sem reload): pino não virou ✓ (' + pinoDepoisB + ')');
  }
  await paginaB.screenshot({ path: '/out/03-depois-desktop.png' });

  // ── 4) A volta para a lista (o clique abriu a conversa) e mostra ✓ também ───
  await paginaA.evaluate(() => { const b = document.querySelector('.btn-voltar'); if (b) b.click(); });
  await espera(400);
  const pinoDepoisA = await pinoDaLinha(paginaA, JANELA);
  if (!pinoDepoisA || !pinoDepoisA.includes('✓') || pinoDepoisA.includes('◆')) {
    problemas.push('DEPOIS (A/celular): pino não é ✓ (' + pinoDepoisA + ')');
  }
  await paginaA.screenshot({ path: '/out/04-depois-celular.png' });

  const errosConsole = [...(paginaA.__erros || []), ...(paginaB.__erros || [])];
  if (errosConsole.length) problemas.push(errosConsole.length + ' erro(s)/requisição(ões) ruim(ns): ' + errosConsole.slice(0, 5).join(' | '));

  await navegador.close();
  console.log('@@MEDIDAS-LIDO-DOIS-APARELHOS@@' + JSON.stringify({ problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;
}

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let s3 = null;
  let scratch = null;
  let pastaJobs = null;
  let dirLidas = null;

  // R2, a prova que mais importa nesta entrega: o arquivo de PRODUÇÃO do dono não pode
  // nascer nem mudar de mtime por causa deste smoke. Capturado ANTES de tocar em qualquer
  // coisa — comparar só no fim seria tarde demais para provar que nada mudou NO MEIO.
  const ARQ_PRODUCAO = path.join(os.homedir(), '.cockpit', 'lidas.json');
  const mtimeAntes = fs.existsSync(ARQ_PRODUCAO) ? fs.statSync(ARQ_PRODUCAO).mtimeMs : null;

  function limpar() {
    let falhouLimpeza = false;
    if (s3 && s3.exitCode === null) {
      try { process.kill(s3.pid); } catch { /* já morreu */ }
      console.log(`  · S3 (pid ${s3.pid}) derrubado pelo pid exato`);
    }
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    if (temCarimbo) {
      t(['kill-server'], { tolerante: true });
    } else {
      falhouLimpeza = true;
      falhas += 1;
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (pastaJobs) fs.rmSync(pastaJobs, { recursive: true, force: true });
    if (dirLidas) fs.rmSync(dirLidas, { recursive: true, force: true });
    return !falhouLimpeza;
  }

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      console.error(`   PNGs NÃO gerados: ${PNGS.join(', ')}`);
      limpar();
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-lido-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });
    // A pasta de "lido" é a ÚNICA coisa nova deste ambiente em relação ao molde (§4.3 do
    // plano) — sem ela o servidor escreveria em ~/.cockpit/lidas.json de produção (R2/#62).
    dirLidas = fs.mkdtempSync(path.join(scratch, 'lidas-'));
    pastaJobs = path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`); // nunca criada — A10 exige a variável, não a pasta

    // ── 1) uma pane de verdade, numa sessão própria; a âncora prova posse do socket ─────────
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    const cwdProjeto = path.join(scratch, 'projeto-lido');
    fs.mkdirSync(cwdProjeto, { recursive: true });
    t(['new-session', '-d', '-s', SESSAO, '-n', JANELA, '-c', cwdProjeto, 'sleep', '600']);

    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    if (!panes[JANELA]) throw new Error(`a pane "${JANELA}" não apareceu no list-panes`);

    const SESSAO_ID = 'sess-lido-dois-aparelhos';
    plantarAgenteFalso(scratch, panes[JANELA].panePid, { starttime: 1000001 });
    escreverSessao(home, {
      pid: panes[JANELA].panePid, janela: panes[JANELA].janelaId, pane: panes[JANELA].paneId,
      sessaoId: SESSAO_ID, cwd: cwdProjeto, starttime: 1000001, status: 'idle',
    });
    conversaPequena(caminhoDoJsonl(home, cwdProjeto, SESSAO_ID), Date.now() - 5 * 60000);

    console.log(`  · fixture pronta: ${JANELA}=${panes[JANELA].panePid}, sessaoId=${SESSAO_ID}`);

    // ── 2) sobe o S3 apontando para o mundo de mentira ──────────────────────────────────────
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
      COCKPIT_JOBS_DIR: pastaJobs,
      COCKPIT_LIDAS_DIR: dirLidas,
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

    // ── 3) o roteiro, dentro do container ───────────────────────────────────────────────────
    const roteiro = montarRoteiro();
    fs.writeFileSync(path.join(scratch, 'pane.js'), roteiro);

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `JANELA=${JANELA}`,
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
    const MARCADOR = '@@MEDIDAS-LIDO-DOIS-APARELHOS@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }

    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : 'o percurso inteiro passou: ◆ nos dois ANTES, ✓ nos dois DEPOIS — B nunca recarregou');

    for (const nome of PNGS) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    // R2: o arquivo de produção não pode ter nascido (se não existia) nem mudado de mtime
    // (se já existia) — a fixture escreveu só no dirLidas TEMPORÁRIO.
    const mtimeDepois = fs.existsSync(ARQ_PRODUCAO) ? fs.statSync(ARQ_PRODUCAO).mtimeMs : null;
    ok(mtimeAntes === null ? mtimeDepois === null : mtimeDepois === mtimeAntes,
      `~/.cockpit/lidas.json de produção intacto (antes ${mtimeAntes}, depois ${mtimeDepois})`);

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ SMOKE VERMELHO' : '✅ SMOKE VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
