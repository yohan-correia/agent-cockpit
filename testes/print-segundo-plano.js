#!/usr/bin/env node
'use strict';
// PRINT DA ABA SÓ COM SUB-AGENTE EM BACKGROUND (card trabalhando-nao-distingue-subagente, spec
// 2026-10-14, §7.6). Mudou pixel, tem print: 390x844 (claro e escuro) e desktop, ANTES
// (RAIZ_CODIGO = git archive da develop: a aba fica "trabalhando" para sempre) e DEPOIS (a
// worktree: "livre · 1 agente em background"). Antes do obturador o roteiro EXIGE o que mudou
// na vista e reprova (sem PNG) em vez de fotografar uma tela que subiu mas não tem o recurso.
//
// Mundo próprio, como o `print-confianca-celular.js`: socket tmux só dele (`-f /dev/null`), HOME
// de mentira, `/proc` falso, pasta de jobs vazia, DUAS abas — `loja` (Claude, `so-background`
// da Fase 1 do gate: busy, `turn_duration` com `pendingBackgroundAgentCount: 1`, com fala do dono
// e resposta do assistente antes, para a fita não abrir vazia) e `agenda` (Claude, `idle`,
// controle visual). NUNCA aponte para a instância de produção.
//
// AS DUAS LIDAS antes de subir o servidor (`lib/lidas.js:marcar`, com `COCKPIT_LIDAS_DIR` já no
// `process.env`): sem isso a `loja` sai "te esperando · 1 agente em background" (não lida),
// não o rótulo "livre" que este print documenta.
//
// Navegador no HOST: os DOIS caminhos vêm por env, sem padrão —
//   PUPPETEER_CORE=<pasta do puppeteer-core>  CHROME_BIN=<executável do chrome>
//
// Uso:
//   ESQUEMA=claro|escuro APARELHO=celular|desktop SAIDA=/tmp/saida PUPPETEER_CORE=… CHROME_BIN=… \
//     node testes/print-segundo-plano.js
//   ANTES=1 RAIZ_CODIGO=<git archive da develop> ESQUEMA=… APARELHO=… SAIDA=… (mesmos dois) \
//     node testes/print-segundo-plano.js
//
// Códigos de saída: 0 = PNGs gravados · 1 = cenário reprovado (sem o recurso na vista) · 2 = ambiente.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7964;
const SAIDA = process.env.SAIDA || '';
const ANTES = process.env.ANTES === '1';
const ESQUEMA = process.env.ESQUEMA === 'escuro' ? 'escuro' : 'claro';
const APARELHO = process.env.APARELHO === 'desktop' ? 'desktop' : 'celular';
const RAIZ_CODIGO = process.env.RAIZ_CODIGO || path.join(__dirname, '..');
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const SOCKET = `cockpit-smoke-segundo-plano-print-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `ancora-segundo-plano-print-${process.pid}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);
const VIEWPORT = APARELHO === 'celular'
  ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
  : { width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em TODO comando: sem ele o ~/.tmux.conf do dono carrega e o continuum-restore
// recria as sessões dele dentro do socket "isolado".
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
if (!fs.existsSync(path.join(RAIZ_CODIGO, 'server.js'))) {
  console.error('🟡 RAIZ_CODIGO não tem o servidor.');
  process.exit(2);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── A fixture: /proc, sessions e .jsonl, todos de mentira ───────────────────

const raizProc = (scratch) => path.join(scratch, 'proc');

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
function plantarAgenteFalso(scratch, pid, starttime) {
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

function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime, status, statusUpdatedAt }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive', sessionId: sessaoId, cwd, status, updatedAt: Date.now(), pid, procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`, statusUpdatedAt,
  }));
}

function caminhoDoJsonl(home, cwd, sessaoId) {
  return path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessaoId}.jsonl`);
}

// O formato real medido (spec §2.1, mesmas linhas do caso `so-background` do gate-segundo-plano.js).
const linha = (obj) => `${JSON.stringify(obj)}\n`;
const userFala = (ms, texto) => linha({ type: 'user', timestamp: new Date(ms).toISOString(), message: { content: texto } });
const assistenteTexto = (ms, texto) => linha({
  type: 'assistant', timestamp: new Date(ms).toISOString(), message: { content: [{ type: 'text', text: texto }] },
});
const assistenteFerramenta = (ms, nome, input) => linha({
  type: 'assistant', timestamp: new Date(ms).toISOString(),
  message: { content: [{ type: 'tool_use', id: `tu-${nome}-${ms}`, name: nome, input }] },
});
const toolResultAsync = (ms) => linha({
  type: 'user', timestamp: new Date(ms).toISOString(),
  message: { content: [{ type: 'tool_result', tool_use_id: `tu-Agent-${ms - 5000}`, content: 'Async agent launched successfully.' }] },
});
function turnoFim({ pend, timestamp, sessaoId }) {
  const obj = {
    type: 'system', subtype: 'turn_duration', durationMs: 2140, messageCount: 4,
    isSidechain: false, uuid: `td-${sessaoId}`, sessionId: sessaoId, timestamp: new Date(timestamp).toISOString(),
  };
  if (Number.isFinite(pend) && pend > 0) obj.pendingBackgroundAgentCount = pend;
  return linha(obj);
}

function escreverConversaCurta(caminho, agora) {
  const base = agora - 600000;
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, [
    userFala(base, 'oi, pode ver o status do board?'),
    assistenteTexto(base + 30000, 'claro, deixa eu olhar.'),
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

// ─── O roteiro do navegador ───────────────────────────────────────────────────

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
    const l = Array.from(document.querySelectorAll('#abas .conversa-linha'))
      .find((x) => { const n = x.querySelector('.conversa-titulo'); return n && n.textContent.includes(alvo); });
    const botao = l && l.querySelector('.conversa');
    if (botao) botao.click();
    return Boolean(botao);
  }, titulo);

  // O que a linha da lista diz AGORA, para o título pedido.
  const estadoDaLinha = (titulo) => pagina.evaluate((alvo) => {
    const l = Array.from(document.querySelectorAll('#abas .conversa-linha'))
      .find((x) => { const n = x.querySelector('.conversa-titulo'); return n && n.textContent.includes(alvo); });
    const estado = l && l.querySelector('.conversa-estado');
    return { achou: Boolean(l), dataEstado: l ? l.dataset.estado : null, texto: estado ? estado.textContent : null };
  }, titulo);

  // O que o painel ABERTO (o primeiro, o único nesta fixture) mostra.
  const medirPainel = () => pagina.evaluate(() => {
    const painel = document.querySelector('#paineis .painel');
    const sp = painel && painel.querySelector('.chat-segundo-plano');
    const trabalhandoNaFita = painel && painel.querySelector('.fita .trabalhando');
    return {
      existe: Boolean(painel),
      spVisivel: Boolean(sp && !sp.hidden),
      spTexto: sp ? sp.textContent : '',
      temTrabalhandoNaFita: Boolean(trabalhandoNaFita),
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

    // No celular, a lista e a aba aberta são TELAS DIFERENTES — a `lista.png` tem de ser
    // tirada ANTES de abrir, com a aba `loja` na vista.
    if (APARELHO === 'celular') {
      const antesDeAbrir = await estadoDaLinha('loja');
      console.log(`  · linha (antes de abrir): ${JSON.stringify(antesDeAbrir)}`);
      if (!ANTES) {
        if (antesDeAbrir.texto !== 'livre · 1 agente em background') {
          problema(`a linha da lista não diz "livre · 1 agente em background" (achei ${JSON.stringify(antesDeAbrir.texto)}) — sem o rótulo não há recurso para fotografar`);
        }
      } else if (antesDeAbrir.texto !== 'trabalhando') {
        problema(`ANTES a linha devia dizer "trabalhando" (o defeito) — achei ${JSON.stringify(antesDeAbrir.texto)}`);
      }
      if (problemas.length) return { gerados, problemas };
      const arqLista = path.join(SAIDA, `${pre}-lista.png`);
      await pagina.screenshot({ path: arqLista });
      gerados.push(arqLista);
    }

    if (!await abrirLinha('loja')) { problema('não achei "loja" na lista'); return { gerados, problemas }; }
    await espera(1500);
    const painel = await medirPainel();
    const naLista = await estadoDaLinha('loja');
    console.log(`  · painel: ${JSON.stringify(painel)} · linha: ${JSON.stringify(naLista)}`);

    if (!ANTES) {
      if (naLista.texto !== 'livre · 1 agente em background') {
        problema(`a linha na lista não diz "livre · 1 agente em background" (achei ${JSON.stringify(naLista.texto)})`);
      }
      if (naLista.dataEstado !== 'segundo-plano') {
        problema(`dataset.estado da linha não é "segundo-plano" (achei ${JSON.stringify(naLista.dataEstado)})`);
      }
      if (!painel.spVisivel || painel.spTexto !== 'livre · 1 agente em background') {
        problema(`o painel aberto não tem .chat-segundo-plano visível com "livre · 1 agente em background" (achei visivel=${painel.spVisivel} texto=${JSON.stringify(painel.spTexto)})`);
      }
      if (painel.temTrabalhandoNaFita) problema('a fita ainda tem ".trabalhando" — o principal deveria estar livre');
    } else {
      if (naLista.texto !== 'trabalhando') {
        problema(`ANTES a linha devia dizer "trabalhando" (o defeito) — achei ${JSON.stringify(naLista.texto)}`);
      }
    }
    if (problemas.length) return { gerados, problemas };

    await espera(300);
    const arqAba = path.join(SAIDA, `${pre}-aba.png`);
    await pagina.screenshot({ path: arqAba });
    gerados.push(arqAba);

    // No desktop a aba abre AO LADO da lista — o mesmo print serve aos dois papéis (a lista
    // continua na vista); grava os dois arquivos mesmo assim (§7.6 do plano).
    if (APARELHO === 'desktop') {
      const arqLista = path.join(SAIDA, `${pre}-lista.png`);
      fs.copyFileSync(arqAba, arqLista);
      gerados.push(arqLista);
    }

    // Controle visual: a `agenda` (idle, lida) não ganhou o rótulo.
    await voltar();
    const agenda = await estadoDaLinha('agenda');
    console.log(`  · controle (agenda): ${JSON.stringify(agenda)}`);
    if (agenda.texto === 'livre · 1 agente em background') problema('a aba de controle "agenda" não deveria ganhar o rótulo de segundo plano');

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

// ─── Corrida ──────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let scratch = null;

  function limpar() {
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
    // Duas respostas, não uma (D35): o carimbo prova que EU criei, a enumeração prova que não
    // há mais ninguém no socket. Matar exige as duas.
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

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'segundo-plano-print-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'jobs'), { recursive: true });

    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', SESSAO, '-n', 'loja', '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-window', '-d', '-t', `${SESSAO}:`, '-n', 'agenda', '-c', os.tmpdir(), 'sleep', '600']);

    const panes = {};
    for (const l of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!l.trim()) continue;
      const [nome, janelaId, paneId, panePid] = l.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    for (const nome of ['loja', 'agenda']) {
      if (!panes[nome]) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
    }

    const inicio = (pid) => 1000000 + pid;
    const agora = Date.now();

    // `loja`: Claude, `busy`, o mesmo formato do caso `so-background` do gate-segundo-plano.js
    // (Fase 1) — fala do dono, Agent lançado, "Async agent launched", resposta do assistente,
    // turn_duration com pendingBackgroundAgentCount: 1.
    const cwdLoja = '/home/smoke/projetos/loja';
    plantarAgenteFalso(scratch, panes.loja.panePid, inicio(panes.loja.panePid));
    escreverSessao(home, {
      pid: panes.loja.panePid, janela: panes.loja.janelaId, pane: panes.loja.paneId,
      sessaoId: 'loja', cwd: cwdLoja, starttime: inicio(panes.loja.panePid),
      status: 'busy', statusUpdatedAt: agora - 90000,
    });
    fs.mkdirSync(path.dirname(caminhoDoJsonl(home, cwdLoja, 'loja')), { recursive: true });
    fs.writeFileSync(caminhoDoJsonl(home, cwdLoja, 'loja'), [
      userFala(agora - 130000, 'roda uma auditoria do board em background'),
      assistenteFerramenta(agora - 125000, 'Agent', { description: 'auditar', prompt: 'audita o board' }),
      toolResultAsync(agora - 120000),
      assistenteTexto(agora - 115000, 'Deixei a auditoria rodando em background, pode seguir falando comigo.'),
      turnoFim({ pend: 1, timestamp: agora, sessaoId: 'loja' }),
    ].join(''));

    // `agenda`: Claude, `idle`, controle visual (lida).
    const cwdAgenda = '/home/smoke/projetos/agenda';
    plantarAgenteFalso(scratch, panes.agenda.panePid, inicio(panes.agenda.panePid));
    escreverSessao(home, {
      pid: panes.agenda.panePid, janela: panes.agenda.janelaId, pane: panes.agenda.paneId,
      sessaoId: 'agenda', cwd: cwdAgenda, starttime: inicio(panes.agenda.panePid),
      status: 'idle', statusUpdatedAt: agora - 600000,
    });
    escreverConversaCurta(caminhoDoJsonl(home, cwdAgenda, 'agenda'), agora);

    // AS DUAS LIDAS — antes de subir o servidor, com COCKPIT_LIDAS_DIR já no process.env: sem
    // isso a `loja` sai "te esperando · 1 agente em background", não "livre".
    process.env.COCKPIT_LIDAS_DIR = path.join(scratch, 'lidas');
    const lidas = require(path.join(RAIZ_CODIGO, 'lib', 'lidas.js'));
    await lidas.marcar('loja', agora - 100000);  // >= a hora da última fala (agora - 115000)
    await lidas.marcar('agenda', agora - 500000);      // >= a hora da última fala (agora - 570000)

    // Ambiente do servidor por LISTA FECHADA (#78/#82).
    const ambiente = { ...process.env };
    for (const k of Object.keys(ambiente)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete ambiente[k];
    delete ambiente.PORT;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TOKEN: '',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
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
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid}), socket ${SOCKET}, ${ANTES ? 'ANTES' : 'DEPOIS'}, ${ESQUEMA}, ${APARELHO}`);

    const { gerados, problemas } = await roteiro(`http://127.0.0.1:${PORTA}`);
    for (const g of gerados) console.log(`  ✅ ${g}`);
    for (const p of problemas) console.error(`  ❌ ${p}`);
    // Reprovou depois de um tiro já gravado (a lista do celular sai ANTES de abrir a aba): o PNG
    // parcial sai do disco — cenário reprovado não deixa prova pela metade (achado do painel).
    if (problemas.length) for (const g of gerados) fs.rmSync(g, { force: true });
    limpar();
    return process.exit(problemas.length || gerados.length < 2 ? 1 : 0);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
