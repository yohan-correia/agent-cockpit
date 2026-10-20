#!/usr/bin/env node
'use strict';
// PRINT DE CELULAR DA 1ª MENSAGEM DO CODEX (card `codex-primeira-mensagem-pelo-celular`, spec 2026-10-14, §5).
//
// Mudou pixel, tem print: 390x844, claro e escuro, ANTES (aba de Codex nova fica muda — Enviar travado ou
// bolha de recusa, com o composer JÁ livre na pane) e DEPOIS (a mensagem sai, o rollout nasce, a fala "OK" volta).
// Antes do obturador o roteiro EXIGE o que mudou na vista e reprova em vez de fotografar uma tela que subiu mas
// não tem o recurso.
//
// Dois moldes, cada um para uma camada: o MUNDO vem do `testes/repro-codex-primeira-mensagem.js` (Codex 0.153.4
// REAL, `env -i` nas panes, provider HTTP local, `/proc` real, porta própria) — nenhum molde com `/proc` falso
// serve aqui: sem o CLI de verdade nenhum rollout nasce e nenhuma resposta chega. A camada de NAVEGADOR vem do
// `testes/print-confianca-celular.js` (`PUPPETEER_CORE`/`CHROME_BIN` por env, viewport 390x844, esquema de cor,
// `RAIZ_CODIGO` para o ANTES, fail-closed antes de tocar em qualquer coisa).
//
// Uso:
//   ESQUEMA=claro|escuro SAIDA=/tmp/saida PUPPETEER_CORE=… CHROME_BIN=… node testes/print-codex-primeira-mensagem.js
//   ANTES=1 RAIZ_CODIGO=<git archive de 706c56b> ESQUEMA=… SAIDA=… (mesmos dois) node testes/print-codex-primeira-mensagem.js
//
// Códigos de saída: 0 = PNGs gerados, sem problema · 1 = defeito (assert falhou) · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7964;
const SAIDA = process.env.SAIDA || '';
const ANTES = process.env.ANTES === '1';
const ESQUEMA = process.env.ESQUEMA === 'escuro' ? 'escuro' : 'claro';
const RAIZ_CODIGO = process.env.RAIZ_CODIGO || path.join(__dirname, '..');
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const CODEX = process.env.COCKPIT_BIN_CODEX || '/usr/bin/codex';
const SOCKET = `cockpit-smoke-codex1a-print-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `ancora-codex1a-print-${process.pid}`;
const MINHAS_SESSOES = new Set([SESSAO]);
const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const PRAZO_DEPOIS_A = 25000;
const PRAZO_DEPOIS_B = 15000;

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em TODO comando: sem ele o ~/.tmux.conf do dono carrega e o continuum-restore recria as
// sessões dele dentro do socket "isolado".
function t(args, tolerante = false) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

if (t(['ls'], true).trim()) { console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`); process.exit(1); }
if (!SAIDA) { console.error('🟡 SAIDA é obrigatória (pasta dos PNGs).'); process.exit(2); }
if (!fs.existsSync(CODEX)) { console.error(`🟡 ambiente indisponível: ${CODEX} não existe.`); process.exit(2); }
if (!fs.existsSync(path.join(RAIZ_CODIGO, 'server.js'))) { console.error('🟡 RAIZ_CODIGO não tem o servidor.'); process.exit(2); }
if (!PUPPETEER || !CHROME) {
  console.error('🟡 ambiente indisponível: PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
  process.exit(2);
}
let puppeteer;
try { puppeteer = require(PUPPETEER); } catch (e) {
  console.error(`🟡 ambiente indisponível: não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`);
  process.exit(2);
}
if (!fs.existsSync(CHROME)) { console.error('🟡 ambiente indisponível: CHROME_BIN não existe.'); process.exit(2); }

// A régua da ÁRVORE TESTADA decide "composer livre" — a mesma que o servidor usa, nunca uma regex daqui.
const { classificarTela } = require(path.join(RAIZ_CODIGO, 'lib', 'menu-codex.js'));

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function req(metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const r = http.request({
      host: '127.0.0.1', port: PORTA, path: caminho, method: metodo, timeout: 15000,
      headers: dados ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) } : {},
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* não-JSON */ } resolve({ status: res.statusCode, json: j, texto: s }); });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (dados) r.write(dados);
    r.end();
  });
}

// Provider local no formato `responses` (molde: testes/smoke-clear-codex.py) — devolve "OK" e conta os pedidos.
function subirProvider() {
  const pedidos = [];
  const srv = http.createServer((rq, rs) => {
    let corpo = '';
    rq.on('data', (c) => { corpo += c; });
    rq.on('end', () => {
      pedidos.push({ caminho: rq.url, corpo });
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
      const resp = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'mock', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      const eventos = [
        { type: 'response.created', response: { ...resp, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'OK' },
        { type: 'response.output_text.done', item_id: 'msg_fixture', output_index: 0, content_index: 0, text: 'OK' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: resp },
      ];
      const dados = eventos.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
      rs.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(dados) });
      rs.end(dados);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, porta: srv.address().port, pedidos })));
}

const tela = (alvo) => t(['capture-pane', '-p', '-t', alvo], true);

// A porta tem que estar LIVRE antes de eu subir o servidor: com outro cockpit nela, o `/health` dele responderia 200
// e os POSTs deste print criariam abas no ambiente ERRADO — e o print seria contra outra árvore.
function portaLivre(porta) {
  return new Promise((resolve) => {
    const sonda = net.createServer();
    sonda.once('error', () => resolve(false));
    sonda.once('listening', () => sonda.close(() => resolve(true)));
    sonda.listen(porta, '127.0.0.1');
  });
}

function rollouts(H) {
  const base = path.join(H, '.codex', 'sessions');
  const achados = [];
  (function anda(d) {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) anda(p); else if (e.name.endsWith('.jsonl')) achados.push(p); }
  })(base);
  return achados;
}

async function abaDe(proj) {
  const lista = (await req('GET', '/api/abas')).json?.abas || [];
  return lista.find((a) => a.agente === 'codex' && (a.titulo || '').includes(proj)) || null;
}

// Espera a pane chegar num estado da régua. O menu de UPDATE (vem antes do de confiança, se a checagem de
// versão rodar) é ambiente, não o que este print mede: sai pelo "Skip" direto no tmux.
async function esperarTela(alvo, quer, prazoMs = 30000) {
  const fim = Date.now() + prazoMs;
  let s = '';
  while (Date.now() < fim) {
    s = tela(alvo);
    if (/Update available/.test(s)) {
      t(['send-keys', '-t', alvo, 'Down'], true); await espera(300); t(['send-keys', '-t', alvo, 'Enter'], true);
      await espera(1000);
      continue;
    }
    if (quer(s)) return s;
    await espera(500);
  }
  return null;
}

const mostrar = (s) => console.log(String(s || '').split('\n').filter((l) => l.trim()).slice(-6).map((l) => `     | ${l}`).join('\n'));

// ─── O roteiro do navegador — roda NO PRÓPRIO processo ───────────────────────

async function diagnosticoDeFalha(H, proj) {
  const ros = rollouts(H);
  const comOk = ros.filter((p) => {
    const txt = fs.readFileSync(p, 'utf8');
    return txt.includes('task_complete') && txt.includes('OK');
  });
  console.error(`  · diagnóstico (${proj}): ${ros.length} rollout(s) no HOME, ${comOk.length} com task_complete + "OK"`);
  const aba = await abaDe(proj);
  console.error(`  · diagnóstico (${proj}): /api/abas preSessao=${aba?.preSessao} sessaoId=${aba?.sessaoId ? '(tem)' : null} rodando=${aba?.rodando}`);
}

async function medir(pagina) {
  return pagina.evaluate(() => {
    const painel = document.querySelector('#paineis .painel');
    if (!painel) return null;
    const pergunta = painel.querySelector('.pergunta');
    const btnEnviar = painel.querySelector('.btn-enviar');
    const fitaEls = Array.from(painel.querySelectorAll('.fita > *'));
    const bolhaErro = [...fitaEls].reverse().find((el) => el.classList.contains('bolha-erro'));
    const bolhaOi = [...fitaEls].reverse().find((el) => el.classList.contains('bolha-eu') && el.textContent.includes('oi'));
    const falaOk = fitaEls.find((el) => !el.classList.contains('bolha-eu') && el.textContent.includes('OK'));
    return {
      perguntaVisivel: Boolean(pergunta && !pergunta.hidden),
      enviarDisabled: Boolean(btnEnviar && btnEnviar.disabled),
      bolhaErroTexto: bolhaErro ? bolhaErro.textContent : null,
      bolhaOiExiste: Boolean(bolhaOi),
      bolhaOiPendente: bolhaOi ? bolhaOi.classList.contains('bolha-pendente') : null,
      falaOkExiste: Boolean(falaOk),
      ultimasBolhas: fitaEls.slice(-5).map((el) => ({ classe: el.className, texto: el.textContent.slice(0, 80) })),
    };
  });
}

async function rolarParaOFim(pagina) {
  await pagina.evaluate(() => {
    const painel = document.querySelector('#paineis .painel');
    const fita = painel && painel.querySelector('.fita');
    if (fita && fita.lastElementChild) fita.lastElementChild.scrollIntoView({ block: 'end' });
  });
}

async function roteiro(base, { H, provider }) {
  const problemas = [];
  const gerados = [];
  const pre = ANTES ? 'antes' : 'depois';
  const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  const erros = [];
  const respostasRuins = [];
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push(`PAGEERROR: ${String(e).slice(0, 200)}`));
  // O 409 é o esperado no ANTES (e no B, mesmo no DEPOIS, até o "Yes" sair) — não é defeito.
  pagina.on('response', (r) => { if (r.status() >= 400 && r.status() !== 409) respostasRuins.push(`${r.status()} ${r.url()}`); });
  const problema = (texto) => { problemas.push(`${pre}: ${texto}`); };

  const abrirLinha = (titulo) => pagina.evaluate((alvo) => {
    const linha = Array.from(document.querySelectorAll('#abas .conversa-linha'))
      .find((l) => { const x = l.querySelector('.conversa-titulo'); return x && x.textContent.includes(alvo); });
    const botao = linha && linha.querySelector('.conversa');
    if (botao) botao.click();
    return Boolean(botao);
  }, titulo);

  const voltar = async () => {
    await pagina.evaluate(() => { const b = document.getElementById('btn-voltar'); if (b) b.click(); });
    await espera(600);
  };

  const digitarEEnviar = async (texto) => {
    await pagina.waitForSelector('#paineis .painel .entrada', { timeout: 8000 });
    await pagina.type('#paineis .painel .entrada', texto);
    await pagina.click('#paineis .painel .btn-enviar').catch(() => { /* disabled: o clique não faz nada, é o esperado */ });
  };

  try {
    await pagina.setViewport(VIEWPORT);
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: ESQUEMA === 'escuro' ? 'dark' : 'light' }]);
    await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* vale nesta página */ } });
    await pagina.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(800);

    // ── A — pasta já confiada: composer livre desde o começo ───────────────────────────
    if (!await abrirLinha('proj-a-confiado')) { problema('A: não achei "proj-a-confiado" na lista'); return { gerados, problemas }; }
    await espera(1500);
    await digitarEEnviar('oi');

    if (ANTES) {
      let m = await medir(pagina);
      for (let i = 0; i < 6 && !(m.enviarDisabled || /confirmação/.test(m.bolhaErroTexto || '')); i += 1) { await espera(500); m = await medir(pagina); }
      await rolarParaOFim(pagina);
      await espera(300);
      const arq1 = path.join(SAIDA, '01-codex-recusa.png');
      await pagina.screenshot({ path: arq1 });
      gerados.push(arq1);
      console.log(`  · 01 (A, antes): ${JSON.stringify(m)}`);
      if (!(m.enviarDisabled || /confirmação/.test(m.bolhaErroTexto || ''))) problema('01: nem o Enviar ficou disabled, nem apareceu bolha-erro com "confirmação"');
      if (!m.perguntaVisivel) problema('01: o bloco .pergunta não está visível');
    } else {
      const fim = Date.now() + PRAZO_DEPOIS_A;
      let m = await medir(pagina);
      while (Date.now() < fim && !(m.bolhaOiExiste && m.bolhaOiPendente === false && m.falaOkExiste)) {
        await espera(1000);
        m = await medir(pagina);
      }
      await rolarParaOFim(pagina);
      await espera(300);
      const arq1 = path.join(SAIDA, '01-codex-primeira-mensagem.png');
      await pagina.screenshot({ path: arq1 });
      gerados.push(arq1);
      console.log(`  · 01 (A, depois): ${JSON.stringify(m)}`);
      if (!(m.bolhaOiExiste && m.bolhaOiPendente === false && m.falaOkExiste)) {
        problema(`01: a bolha "oi" sem pendente + a fala "OK" não chegaram em ${PRAZO_DEPOIS_A / 1000}s`);
        await diagnosticoDeFalha(H, 'proj-a-confiado');
        console.error(`  · diagnóstico (A): últimas bolhas da fita: ${JSON.stringify(m.ultimasBolhas)}`);
      }
    }
    await voltar();

    // ── B — pasta nova: o "Yes" sai pelo controle do bloco (gesto do celular) ──────────
    if (!await abrirLinha('proj-b-novo')) { problema('B: não achei "proj-b-novo" na lista'); return { gerados, problemas }; }
    await espera(1500);
    const m0 = await medir(pagina);
    if (!m0.perguntaVisivel) problema('B: o bloco .pergunta (menu de confiança) não abriu');
    await pagina.waitForSelector('#paineis .painel .tecla-enter', { timeout: 8000 }).catch(() => {});
    await pagina.click('#paineis .painel .tecla-enter').catch((e) => problema(`B: não consegui tocar .tecla-enter (${e.message})`));

    if (ANTES) {
      await espera(8000);
      const m = await medir(pagina);
      console.log(`  · (B, antes, depois do "Yes") ${JSON.stringify(m)}`);
      // O defeito só está provado se o "Yes" FOI aceito: a pane tem que estar com o composer livre. Sem isto, um clique
      // que não chegou deixaria o menu de confiança na tela e a trava ORIGINAL passaria por prova do defeito pós-"Yes".
      const paneB = tela(`${SESSAO}:proj-b-novo`);
      const classeB = classificarTela(paneB);
      console.log(`  · (B, antes) régua da pane depois do "Yes": ${classeB}`);
      if (classeB !== 'livre' || /Do you trust the contents of this directory/.test(paneB)) {
        problema(`02: depois do "Yes" a pane não está com o composer livre (régua: ${classeB}) — o "Yes" não foi aceito, o print não prova o defeito`);
      }
      if (!(m.perguntaVisivel || m.enviarDisabled)) problema('02: depois do "Yes" o bloco .pergunta fechou e o Enviar destravou — devia continuar travado');
      await digitarEEnviar('oi');
      await espera(1000);
      const m2 = await medir(pagina);
      await rolarParaOFim(pagina);
      await espera(300);
      const arq2 = path.join(SAIDA, '02-codex-depois-do-yes-recusa.png');
      await pagina.screenshot({ path: arq2 });
      gerados.push(arq2);
      console.log(`  · 02 (B, antes): ${JSON.stringify(m2)}`);
      if (!(m2.enviarDisabled || /confirmação|não é confiável/.test(m2.bolhaErroTexto || ''))) {
        problema('02: nem o Enviar ficou disabled, nem apareceu bolha-erro de recusa depois do "Yes"');
      }
    } else {
      const fimFecha = Date.now() + PRAZO_DEPOIS_B;
      let mf = await medir(pagina);
      while (Date.now() < fimFecha && (mf.perguntaVisivel || mf.enviarDisabled)) {
        await espera(500);
        mf = await medir(pagina);
      }
      if (mf.perguntaVisivel || mf.enviarDisabled) {
        problema(`02: o bloco .pergunta não fechou (ou o Enviar não destravou) em ${PRAZO_DEPOIS_B / 1000}s depois do "Yes"`);
      }
      await digitarEEnviar('oi');
      const fim = Date.now() + PRAZO_DEPOIS_A;
      let m = await medir(pagina);
      while (Date.now() < fim && !(m.bolhaOiExiste && m.bolhaOiPendente === false && m.falaOkExiste)) {
        await espera(1000);
        m = await medir(pagina);
      }
      await rolarParaOFim(pagina);
      await espera(300);
      const arq2 = path.join(SAIDA, '02-codex-depois-do-yes.png');
      await pagina.screenshot({ path: arq2 });
      gerados.push(arq2);
      console.log(`  · 02 (B, depois): ${JSON.stringify(m)}`);
      if (!(m.bolhaOiExiste && m.bolhaOiPendente === false && m.falaOkExiste)) {
        problema(`02: a bolha "oi" sem pendente + a fala "OK" não chegaram em ${PRAZO_DEPOIS_A / 1000}s`);
        await diagnosticoDeFalha(H, 'proj-b-novo');
        console.error(`  · diagnóstico (B): últimas bolhas da fita: ${JSON.stringify(m.ultimasBolhas)}`);
      }
    }
  } catch (e) {
    problema(`o roteiro estourou — ${String(e && e.message).slice(0, 300)}`);
  } finally {
    if (erros.length) problema(`${erros.length} erro(s) de console: ${erros.slice(0, 3).join(' | ')}`);
    if (respostasRuins.length) problema(`${respostasRuins.length} resposta(s) >= 400: ${respostasRuins.slice(0, 3).join(' | ')}`);
    await pagina.close().catch(() => {});
    await navegador.close().catch(() => {});
  }
  return { gerados, problemas };
}

// ─── Corrida ───────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let provider = null;
  let T = null;
  let saida = 1;
  let errServidor = '';
  const limpar = () => {
    if (servidor && servidor.exitCode === null) try { process.kill(servidor.pid); } catch { /* já saiu */ }
    if (provider) try { provider.srv.close(); } catch { /* já fechou */ }
    // Duas respostas, não uma (D35): o carimbo prova que EU criei, a enumeração prova que não há mais ninguém no
    // socket. Matar o servidor tmux exige as duas.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], true).split('\n').some((n) => n.trim() === CARIMBO);
    const intrusas = t(['list-sessions', '-F', '#{session_name}'], true).split('\n').map((n) => n.trim()).filter(Boolean)
      .filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) t(['kill-server'], true);
    else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], true);
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else if (t(['ls'], true).trim()) console.error(`  ❌ a âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    if (T) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.error('não limpei', T, e.message); }
    }
  };
  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }

    provider = await subirProvider();
    T = fs.mkdtempSync(path.join(os.tmpdir(), 'print-codex1a-'));
    const H = path.join(T, 'home');
    const PROJ = path.join(T, 'projetos');
    fs.mkdirSync(path.join(H, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(H, '.codex', 'config.toml'), [
      'model = "mock"',
      'model_provider = "mock"',
      'check_for_update_on_startup = false',
      `[projects."${path.join(PROJ, 'proj-a-confiado')}"]`,
      'trust_level = "trusted"',
      '[model_providers.mock]',
      'name = "Fixture local"',
      `base_url = "http://127.0.0.1:${provider.porta}/v1"`,
      'env_key = "COCKPIT_TEST_API_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(H, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: {} }));
    for (const p of ['proj-a-confiado', 'proj-b-novo']) fs.mkdirSync(path.join(PROJ, p), { recursive: true });
    fs.mkdirSync(path.join(T, 'jobs'), { recursive: true });
    // `env -i`: as panes nascem com o HOME falso e a chave de MENTIRA do provider local — nada do ambiente real.
    execFileSync('env', ['-i', 'PATH=/usr/bin:/bin', 'TERM=xterm-256color', `HOME=${H}`, 'COCKPIT_TEST_API_KEY=fixture-only',
      'tmux', '-L', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-x', '200', '-y', '50', '-s', SESSAO, '-n', CARIMBO, 'sleep', '3000']);
    const amb = { ...process.env };
    for (const k of Object.keys(amb)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete amb[k];
    Object.assign(amb, {
      HOST: '127.0.0.1', PORT: String(PORTA), HOME: H, CODEX_HOME: path.join(H, '.codex'), COCKPIT_BIN_CODEX: CODEX,
      COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TMUX_SOCKET: SOCKET, COCKPIT_TMUX_SESSAO: SESSAO, COCKPIT_PROJETOS_DIR: PROJ,
      COCKPIT_JOBS_DIR: path.join(T, 'jobs'), COCKPIT_VIGIA_MS: '0', COCKPIT_PUSH_DIR: path.join(T, 'push'),
      COCKPIT_MONITOR_DIR: path.join(T, 'monitor'), COCKPIT_MONITOR_MS: '0', COCKPIT_LIDAS_DIR: path.join(T, 'lidas'),
      COCKPIT_DU_BIN: path.join(T, 'sem-du'), COCKPIT_DOCKER_BIN: path.join(T, 'sem-docker'),
    });
    if (!await portaLivre(PORTA)) { console.error(`🟡 ambiente indisponível: a porta ${PORTA} já está ocupada (outro print? rerode depois — não mato nada).`); saida = 2; throw null; }
    servidor = spawn(process.execPath, [path.join(RAIZ_CODIGO, 'server.js')], { env: amb, cwd: RAIZ_CODIGO, stdio: ['ignore', 'pipe', 'pipe'] });
    servidor.stderr.on('data', (c) => { errServidor += c; });
    // A prova de que a porta é MINHA: o próprio processo imprime a linha do `listen` (server.js, callback do
    // `listen`). Sem ela, um `/health` 200 pode ser de outro servidor que ganhou a porta depois da sonda.
    let escutando = false;
    let outServidor = '';
    servidor.stdout.on('data', (c) => {
      outServidor += c;
      if (outServidor.includes(`http://127.0.0.1:${PORTA}`)) escutando = true;
    });
    let pronto = false;
    for (let i = 0; i < 60 && !pronto && servidor.exitCode === null; i += 1) {
      if (escutando) { try { pronto = (await req('GET', '/health')).status === 200; } catch { /* subindo */ } }
      if (!pronto) await espera(200);
    }
    if (pronto && (!escutando || servidor.exitCode !== null)) pronto = false;
    if (!pronto) { console.error(`🟡 ambiente indisponível: servidor não subiu na ${PORTA}.\n${errServidor.slice(-600)}`); saida = 2; throw null; }
    console.log(`servidor ${PORTA} (árvore ${RAIZ_CODIGO}, ${ANTES ? 'ANTES' : 'DEPOIS'}, ${ESQUEMA}); provider local na ${provider.porta}`);

    // ── A: pasta já confiada ──────────────────────────────────────────────────────────────
    const cA = await req('POST', '/api/abas', { projeto: 'proj-a-confiado', agente: 'codex' });
    if (cA.status !== 201) { console.error(`🟡 ambiente indisponível: POST /api/abas (A) → ${cA.status}`); saida = 2; throw null; }
    const alvoA = `${SESSAO}:proj-a-confiado`;
    const sA = await esperarTela(alvoA, (s) => classificarTela(s) === 'livre');
    if (!sA) { console.error('🟡 ambiente indisponível: o composer do Codex não apareceu em 30 s (A). Tela:'); mostrar(tela(alvoA)); saida = 2; throw null; }
    mostrar(sA);
    await espera(6000);   // um tique do fluxo com a tela já livre

    // ── B: pasta nova, menu de confiança ──────────────────────────────────────────────────
    const cB = await req('POST', '/api/abas', { projeto: 'proj-b-novo', agente: 'codex' });
    if (cB.status !== 201) { console.error(`🟡 ambiente indisponível: POST /api/abas (B) → ${cB.status}`); saida = 2; throw null; }
    const alvoB = `${SESSAO}:proj-b-novo`;
    const sMenu = await esperarTela(alvoB, (s) => /Do you trust the contents of this directory/.test(s) && classificarTela(s) === 'menu');
    if (!sMenu) { console.error('🟡 ambiente indisponível: o menu de confiança não apareceu em 30 s (B). Tela:'); mostrar(tela(alvoB)); saida = 2; throw null; }
    mostrar(sMenu);
    await espera(2000);   // a aba entra na lista do cockpit e o SSE abre o bloco .pergunta

    const { gerados, problemas } = await roteiro(`http://127.0.0.1:${PORTA}`, { H, provider });
    for (const g of gerados) console.log(`  ✅ ${g}`);
    for (const p of problemas) console.error(`  ❌ ${p}`);
    saida = problemas.length || gerados.length !== 2 ? 1 : 0;
  } catch (e) {
    if (e) { console.error('estourou:', (e && e.stack) || e); saida = 1; }
  }
  limpar();
  process.exit(saida);
})();
