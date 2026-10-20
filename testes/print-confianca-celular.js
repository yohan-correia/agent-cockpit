#!/usr/bin/env node
'use strict';
// PRINT DE CELULAR DO AVISO DE CONFIANÇA (card `responder-confianca-do-cli-pelo-celular`, spec 2026-10-13, §6.4).
//
// Mudou pixel, tem print: 390x844 (o celular que motivou o card), claro e escuro, ANTES (código da develop de
// fef888d: bloco da pane sem aviso, cabeçalho do Codex dizendo "ainda não achei…", nota fixa do Claude mesmo com
// Codex) e DEPOIS (o `.aviso-confianca` no bloco, cabeçalho calado, nota do Codex no diálogo). Antes do obturador o
// roteiro EXIGE o que mudou na vista e reprova em vez de fotografar uma tela que subiu mas não tem o recurso.
//
// Mundo próprio, como o `print-saida-comando.js`: socket tmux só dele (`-f /dev/null`), HOME de mentira com
// `CODEX_HOME` dentro, /proc falso, pasta de jobs vazia, três abas — `conversa-velha` (Claude completo),
// `claude-novo` e `codex-novo` (agente vivo, zero sessão, prompt do CLI impresso na pane, pasta que a config NÃO
// confia). NUNCA aponte para a instância de produção.
//
// Navegador no HOST (a imagem docker de smoke não existe mais): os DOIS caminhos vêm por env, sem padrão —
//   PUPPETEER_CORE=<pasta do puppeteer-core>  CHROME_BIN=<executável do chrome>
//
// Uso:
//   ESQUEMA=claro|escuro SAIDA=/tmp/saida PUPPETEER_CORE=… CHROME_BIN=… node testes/print-confianca-celular.js
//   ANTES=1 RAIZ_CODIGO=<git archive de fef888d> ESQUEMA=… SAIDA=… (mesmos dois) node testes/print-confianca-celular.js
//
// Códigos de saída: 0 = PNGs gerados · 1 = falhou no meio · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7962;
const SAIDA = process.env.SAIDA || '';
const ANTES = process.env.ANTES === '1';
const ESQUEMA = process.env.ESQUEMA === 'escuro' ? 'escuro' : 'claro';
const RAIZ_CODIGO = process.env.RAIZ_CODIGO || path.join(__dirname, '..');
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const SOCKET = `cockpit-smoke-confianca-print-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `ancora-confianca-print-${process.pid}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);
const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

// O prompt real do Claude Code, encurtado ao que importa (molde: smoke-navegador-pre-sessao.js).
const PROMPT_CLAUDE = [
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  ' Do you trust this folder?',
  '',
  ' > No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm - Esc to cancel',
].join('\n');
// O do Codex 0.153 (spec §2): as linhas medidas com o binário real.
const promptCodex = (pasta) => [
  `> You are in ${pasta}`,
  '',
  '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.',
  '',
  '› 1. Yes, continue',
  '  2. No, quit',
  '',
  '  Press enter to continue',
].join('\n');

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em TODO comando: sem ele o ~/.tmux.conf do dono carrega e o continuum-restore recria as
// sessões dele dentro do socket "isolado".
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

if (!SAIDA) { console.error('🟡 SAIDA é obrigatória (pasta dos PNGs).'); process.exit(2); }
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

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── A fixture: /proc, sessions e conversa, todos de mentira ─────────────────

const raizProc = (scratch) => path.join(scratch, 'proc');

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
    kind: 'interactive', sessionId: sessaoId, cwd, status, updatedAt: Date.now(), pid, procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto) => `${JSON.stringify({ type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] } })}\n`;

function escreverConversaCurta(caminho, nome) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const base = Date.now() - 600000;
  fs.writeFileSync(caminho, [
    linhaHumano(new Date(base).toISOString(), `oi, sou a conversa ${nome}`),
    linhaAssistente(new Date(base + 30000).toISOString(), `resposta da conversa ${nome}`),
  ].join(''));
}

function http1(caminho) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: caminho, timeout: 2000 }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { texto += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(texto); } catch { /* não-JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}
const saude = async () => (await http1('/health')).status === 200;

// ─── O roteiro do navegador — roda NO PRÓPRIO processo ───────────────────────

const NOTA_CLAUDE = 'marca a pasta como confiável';
const NOTA_CODEX = 'O Codex vai perguntar';

async function roteiro(base) {
  const problemas = [];
  const gerados = [];
  const pre = ANTES ? 'antes' : 'depois';
  const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  const erros = [];
  const respostasRuins = [];
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push(`PAGEERROR: ${String(e).slice(0, 200)}`));
  pagina.on('response', (r) => { if (r.status() >= 400 && r.status() !== 409) respostasRuins.push(`${r.status()} ${r.url()}`); });
  const problema = (texto) => { problemas.push(`${pre}: ${texto}`); };

  const abrirLinha = (titulo) => pagina.evaluate((alvo) => {
    const linha = Array.from(document.querySelectorAll('#abas .conversa-linha'))
      .find((l) => { const x = l.querySelector('.conversa-titulo'); return x && x.textContent.includes(alvo); });
    const botao = linha && linha.querySelector('.conversa');
    if (botao) botao.click();
    return Boolean(botao);
  }, titulo);

  // O que o bloco da pane TEM, lido do DOM, depois de rolar o `.pergunta` para a vista.
  const medirBloco = () => pagina.evaluate(() => {
    const painel = document.querySelector('#paineis .painel');
    const pergunta = painel && painel.querySelector('.pergunta');
    const aviso = painel && painel.querySelector('.aviso-confianca');
    const cab = painel && painel.querySelector('.aviso-agente');
    if (pergunta && !pergunta.hidden) pergunta.scrollIntoView({ block: 'end' });
    const r = aviso ? aviso.getBoundingClientRect() : null;
    return {
      perguntaAberta: Boolean(pergunta && !pergunta.hidden),
      existe: Boolean(aviso),
      visivel: Boolean(aviso && !aviso.hidden && r.height > 0),
      texto: aviso ? aviso.textContent : '',
      topo: r ? r.top : null,
      base: r ? r.bottom : null,
      cabecalho: cab ? cab.textContent : '',
    };
  });

  const voltar = async () => {
    await pagina.evaluate(() => { const b = document.getElementById('btn-voltar'); if (b) b.click(); });
    await espera(600);
  };

  try {
    await pagina.setViewport(VIEWPORT);
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: ESQUEMA === 'escuro' ? 'dark' : 'light' }]);
    await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* vale nesta página */ } });
    await pagina.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(800);

    // 0. A aba de sempre — a que NÃO pode mudar: sem aviso de confiança.
    if (!await abrirLinha('conversa-velha')) problema('não achei "conversa-velha" na lista');
    await espera(1200);
    const velha = await medirBloco();
    if (velha.visivel) problema('conversa-velha mostra .aviso-confianca');
    await voltar();

    // 1. Codex em pasta que a config NÃO confia.
    if (!await abrirLinha('codex-novo')) { problema('não achei "codex-novo" na lista'); return { gerados, problemas }; }
    await espera(1500);
    const codex = await medirBloco();
    await espera(300);
    const arq1 = path.join(SAIDA, '01-codex-pre-sessao.png');
    await pagina.screenshot({ path: arq1 });
    gerados.push(arq1);
    console.log(`  · 01 codex: ${JSON.stringify(codex)}`);
    if (!codex.perguntaAberta) problema('01: o bloco da pane (.pergunta) não abriu no Codex');
    if (ANTES) {
      if (codex.existe) problema('01: ANTES não devia ter .aviso-confianca (o elemento nem existe)');
      if (!codex.cabecalho.includes('ainda não achei a conversa desta aba de Codex')) problema(`01: ANTES o cabeçalho devia dizer "ainda não achei a conversa desta aba de Codex" (${JSON.stringify(codex.cabecalho)})`);
    } else {
      if (!codex.visivel) problema('01: .aviso-confianca não está visível');
      if (!codex.texto.includes('não é confiável')) problema(`01: o aviso não diz "não é confiável" (${JSON.stringify(codex.texto)})`);
      if (!(codex.topo >= 0 && codex.base <= VIEWPORT.height)) problema(`01: o aviso fora da viewport (${codex.topo}..${codex.base})`);
      if (codex.cabecalho.includes('ainda não achei')) problema(`01: o cabeçalho ainda diz "ainda não achei" (${JSON.stringify(codex.cabecalho)})`);
    }
    await voltar();

    // 2. Claude aberto pelo terminal, mesma pasta.
    if (!await abrirLinha('claude-novo')) { problema('não achei "claude-novo" na lista'); return { gerados, problemas }; }
    await espera(1500);
    const claude = await medirBloco();
    await espera(300);
    const arq2 = path.join(SAIDA, '02-claude-pre-sessao.png');
    await pagina.screenshot({ path: arq2 });
    gerados.push(arq2);
    console.log(`  · 02 claude: ${JSON.stringify(claude)}`);
    if (!claude.perguntaAberta) problema('02: o bloco da pane (.pergunta) não abriu no Claude');
    if (ANTES) {
      if (claude.existe) problema('02: ANTES não devia ter .aviso-confianca');
    } else {
      if (!claude.visivel) problema('02: .aviso-confianca não está visível');
      if (!claude.texto.includes('não é confiável')) problema(`02: o aviso não diz "não é confiável" (${JSON.stringify(claude.texto)})`);
      if (!(claude.topo >= 0 && claude.base <= VIEWPORT.height)) problema(`02: o aviso fora da viewport (${claude.topo}..${claude.base})`);
    }
    await voltar();

    // 3. O diálogo de nova aba: Codex + pasta que pede confiança.
    await pagina.evaluate(() => document.getElementById('btn-nova-aba').click());
    await pagina.waitForSelector('#dialogo-nova-aba[open]', { timeout: 5000 });
    await espera(1200);                                    // /api/projetos e /api/agentes
    await pagina.select('#sel-agente-novo', 'codex');
    const escolherPasta = async (nome) => {
      await pagina.evaluate(() => { const c = document.getElementById('sel-projeto-novo'); c.value = ''; c.dispatchEvent(new Event('input', { bubbles: true })); });
      await pagina.click('#sel-projeto-novo');
      await pagina.type('#sel-projeto-novo', nome);
      await pagina.keyboard.press('Enter');
      await espera(400);
      return pagina.evaluate(() => {
        const nota = document.getElementById('nota-trust-nova-aba');
        const r = nota.getBoundingClientRect();
        return { campo: document.getElementById('sel-projeto-novo').value, escondida: nota.hidden || r.height === 0, texto: nota.textContent, topo: r.top, base: r.bottom };
      });
    };
    const pedindo = await escolherPasta('pasta-nova');
    await pagina.evaluate(() => document.getElementById('nota-trust-nova-aba').scrollIntoView({ block: 'center' }));
    await espera(300);
    const arq3 = path.join(SAIDA, '03-dialogo-codex-pasta-nova.png');
    await pagina.screenshot({ path: arq3 });
    gerados.push(arq3);
    console.log(`  · 03 diálogo (codex + pasta-nova): ${JSON.stringify(pedindo)}`);
    if (pedindo.campo !== 'pasta-nova') problema(`03: o campo devia ter "pasta-nova" (${pedindo.campo})`);
    if (pedindo.escondida) problema('03: a nota não está visível');
    if (ANTES) {
      if (!pedindo.texto.includes(NOTA_CLAUDE)) problema(`03: ANTES a nota devia ser a fixa ("${NOTA_CLAUDE}") mesmo com Codex (${JSON.stringify(pedindo.texto)})`);
    } else {
      if (!pedindo.texto.includes(NOTA_CODEX)) problema(`03: a nota devia dizer "${NOTA_CODEX}" (${JSON.stringify(pedindo.texto)})`);
      if (!(pedindo.topo >= 0 && pedindo.base <= VIEWPORT.height)) problema(`03: a nota fora da viewport (${pedindo.topo}..${pedindo.base})`);
      const confiada = await escolherPasta('pasta-confiada');
      console.log(`  · 03 codex + pasta-confiada: ${JSON.stringify(confiada)}`);
      if (confiada.campo !== 'pasta-confiada') problema(`03: o campo devia ter "pasta-confiada" (${confiada.campo})`);
      if (!confiada.escondida) problema('03: com pasta-confiada a nota devia estar escondida');
      await pagina.select('#sel-agente-novo', 'claude');
      await espera(300);
      const comClaude = await pagina.evaluate(() => {
        const nota = document.getElementById('nota-trust-nova-aba');
        return { escondida: nota.hidden || nota.getBoundingClientRect().height === 0, texto: nota.textContent };
      });
      console.log(`  · 03 claude: ${JSON.stringify(comClaude)}`);
      if (comClaude.escondida || !comClaude.texto.includes(NOTA_CLAUDE)) problema(`03: com Claude a frase de hoje devia aparecer (${JSON.stringify(comClaude)})`);
    }

    const geral = await pagina.evaluate(() => ({
      folhasComRegras: Array.from(document.styleSheets).filter((f) => {
        try { return f.cssRules && f.cssRules.length > 0; } catch { return true; }
      }).length,
      imagensQuebradas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
    }));
    if (!geral.folhasComRegras) problema('NENHUMA folha de estilo com regras');
    if (geral.imagensQuebradas) problema(`${geral.imagensQuebradas} imagem(ns) quebrada(s)`);
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

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let scratch = null;

  function limpar() {
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
    // Duas respostas, não uma (D35): o carimbo prova que EU criei, a enumeração prova que não há mais ninguém
    // no socket. Matar exige as duas.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const intrusas = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean)
      .filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }
    if (!fs.existsSync(path.join(RAIZ_CODIGO, 'server.js'))) {
      console.error('🟡 RAIZ_CODIGO não tem o servidor.');
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'confianca-print-'));
    const home = path.join(scratch, 'home');
    const projetos = path.join(scratch, 'projetos');
    const pastaNova = path.join(projetos, 'pasta-nova');
    const pastaConfiada = path.join(projetos, 'pasta-confiada');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'codex-vazio'), { recursive: true });
    fs.mkdirSync(pastaNova, { recursive: true });
    fs.mkdirSync(pastaConfiada, { recursive: true });
    // Claude confia só em /outro; Codex confia só em pasta-confiada. `pasta-nova` não é confiável para nenhum.
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, theme: 'dark', projects: { '/outro': { hasTrustDialogAccepted: true } },
    }));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `[projects."${pastaConfiada}"]\ntrust_level = "trusted"\n`);

    // `-x 200 -y 50`: a pane real do usuário tem 168-211 colunas; fixture estreita quebraria o prompt.
    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', SESSAO, '-n', 'conversa-velha', '-c', os.tmpdir(), 'sleep', '600']);
    // `printf %b`: o `\n` viaja DENTRO do argumento. O cwd da aba em preSessao vem do pane_current_path: `-c`.
    const imprimir = (prompt) => `printf '%b\\n' ${JSON.stringify(prompt)}; sleep 600`;
    t(['new-window', '-d', '-t', `${SESSAO}:`, '-n', 'claude-novo', '-c', pastaNova, 'sh', '-c', imprimir(PROMPT_CLAUDE)]);
    t(['new-window', '-d', '-t', `${SESSAO}:`, '-n', 'codex-novo', '-c', pastaNova, 'sh', '-c', imprimir(promptCodex(pastaNova))]);

    const panes = {};
    for (const linha of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    for (const nome of ['conversa-velha', 'claude-novo', 'codex-novo']) {
      if (!panes[nome]) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
    }

    // A aba COMPLETA: /proc + sessions/<pid>.json + .jsonl.
    const velha = panes['conversa-velha'];
    const cwdVelha = '/home/smoke/projetos/conversa-velha';
    escreverConversaCurta(caminhoDoJsonl(home, cwdVelha, 'sess-velha'), 'conversa-velha');
    plantarAgenteFalso(scratch, velha.panePid, { starttime: 3000001 });
    escreverSessao(home, { pid: velha.panePid, janela: velha.janelaId, pane: velha.paneId, sessaoId: 'sess-velha', cwd: cwdVelha, starttime: 3000001, status: 'idle' });
    // As duas em PRÉ-SESSÃO: só o /proc. Nem sessions/<pid>.json nem .jsonl/rollout (o que o CLI publica enquanto o
    // menu de confiança está na tela).
    plantarAgenteFalso(scratch, panes['claude-novo'].panePid, { starttime: 3000002 });
    plantarAgenteFalso(scratch, panes['codex-novo'].panePid, { comm: 'codex', argv: ['/usr/bin/codex'], starttime: 3000003 });
    console.log(`  · fixture pronta (${ANTES ? 'ANTES' : 'DEPOIS'}, ${ESQUEMA}): conversa-velha + claude-novo + codex-novo`);

    // Ambiente do servidor por LISTA FECHADA (#78/#82).
    const ambiente = { ...process.env };
    for (const k of Object.keys(ambiente)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete ambiente[k];
    delete ambiente.PORT;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_CODEX_RAIZ: path.join(scratch, 'codex-vazio'),
      COCKPIT_PROJETOS_DIR: projetos,
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'),
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'),
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
      COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
    });
    servidor = spawn(process.execPath, [path.join(RAIZ_CODIGO, 'server.js')], { env: ambiente, cwd: RAIZ_CODIGO, stdio: ['ignore', 'ignore', 'pipe'] });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      console.error(`🔴 o servidor (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid}), socket ${SOCKET}`);

    // As duas abas novas têm que estar em preSessao ANTES do navegador.
    let preSessao = false;
    for (let i = 0; i < 20 && !preSessao; i += 1) {
      const lista = ((await http1('/api/abas')).json || {}).abas || [];
      const novas = lista.filter((a) => /^(claude|codex)-novo$/.test(a.titulo || ''));
      preSessao = novas.length === 2 && novas.every((a) => a.preSessao === true);
      if (!preSessao) await espera(500);
    }
    if (!preSessao) {
      console.error('🔴 as abas claude-novo e codex-novo não chegaram em preSessao');
      limpar();
      return process.exit(1);
    }

    const { gerados, problemas } = await roteiro(`http://127.0.0.1:${PORTA}`);
    for (const g of gerados) console.log(`  ✅ ${g}`);
    for (const p of problemas) console.error(`  ❌ ${p}`);
    limpar();
    return process.exit(problemas.length || gerados.length !== 3 ? 1 : 0);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
