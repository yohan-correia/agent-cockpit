#!/usr/bin/env node
'use strict';
// PROVA DE TELA — o teto do medidor de contexto por MODELO (card `medidor-teto-errado-com-haiku`,
// fix de 06/10/2026). ANTES (develop) e DEPOIS (esta worktree), 390×844, nos DOIS medidores:
// o da ABA (lib/contexto.js) e o do painel do JOB (lib/adaptador-job.js).
//
// A fixture é a máquina do dono HOJE: `~/.claude/settings.json` SEM a chave `model` (ela saiu
// em 23/09), e uma conversa `claude-opus-5-5` com 130.000 tokens ocupados — abaixo de 200k, onde
// a rede de segurança da #27 NÃO alcança. É exatamente o caso que o dono viu: "a maioria dos
// jobs mostra 200k; no tmux o CLI mostra 1M".
//
//   ANTES  → 130.000 / 200.000 = 65 %   (teto errado: opus-5-5 já nasce com 1M)
//   DEPOIS → 130.000 / 1.000.000 = 13 % (tabela JANELA_CONHECIDA)
//
// Molde do painel do job: `testes/print-contexto-job.js` (dois `server.js` na mesma fixture,
// `git archive develop` para o ANTES). Molde da aba: `testes/gate-aba-movida.js` — tmux REAL em
// socket isolado (`-L`, D35), `/proc` de mentira via COCKPIT_PROC_RAIZ e o
// `~/.claude/sessions/<pid>.json` que o CLI escreveria ao nascer. A pane roda `sleep`; o `/proc`
// falso diz que esse pid é o `claude`, e é assim que a aba ganha agente sem CLI nenhum no ar.
//
// 🔴 HOME falso SEM `model`, de propósito. Com `[1m]` no settings o ANTES já mostraria 13 % e o
// print não provaria nada — ver o comentário do `print-contexto-job.js`, que precisa do oposto.
//
// Uso: SAIDA=<pasta NOVA, sem PNG dentro> node testes/print-teto-por-modelo.js
//
// Saída: 0 = os dois lados passaram · 1 = falha de produto/assert · 2 = erro de USO ou de
// AMBIENTE (falta SAIDA, pasta já tem PNG, porta ocupada, imagem docker ausente, socket alheio).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs vão cair>');
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const RAIZ = path.join(__dirname, '..');

// Nunca 7899 (jobs, #24), 7879 (produção) nem 7897. 7891/7892 são do print-contexto-job.
const PORTA_ANTES = Number(process.env.PORTA_ANTES || 7861);
const PORTA_DEPOIS = Number(process.env.PORTA_DEPOIS || 7862);

const USADOS = 130000;
const MODELO = 'claude-opus-5-5';
const SESSAO_TMUX = 'teste';
const CWD_DA_ABA = '/home/print/projetos/loja-exemplo';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fail-closed do tmux, na mesma ordem do gate-aba-movida ─────────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(2);
}
const SOCKET = `cockpit-smoke-teto-${process.pid}`;
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO_TMUX]);

// `-f /dev/null`: este script roda com o HOME REAL (só os servidores ganham o falso), e o
// `~/.tmux.conf` do dono tem `@continuum-restore on` — sem isto, o primeiro `new-session`
// sobe um servidor novo que RESTAURA as 17 sessões salvas do tmux padrão dentro do socket
// isolado, e a limpeza fail-closed se recusa a derrubá-lo (medido em 06/10: 17 clones).
// O gate-aba-movida escapa porque o `npm test` falsifica o HOME do processo inteiro.
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
  process.exit(2);
}

function portaOcupada(porta) {
  const saida = execSync('ss -ltn 2>/dev/null || true', { encoding: 'utf8' });
  return saida.split('\n').some((l) => l.includes(`:${porta} `) || l.includes(`:${porta}\t`));
}

function saude(porta) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Uma linha `assistant` do principal, no formato que o CLI grava (`.jsonl` e `claude.log`). */
function linhaAssistant(i, lidos) {
  return JSON.stringify({
    type: 'assistant', session_id: 'sessao-print-teto', uuid: `u-${i}`, parent_tool_use_id: null,
    timestamp: new Date(Date.now() - (10 - i) * 60000).toISOString(),
    message: {
      role: 'assistant', model: MODELO,
      content: [{ type: 'text', text: `Passo ${i} do trabalho.` }],
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: lidos, output_tokens: 10 },
    },
  });
}

function conversaFalsa() {
  return [
    JSON.stringify({ type: 'user', uuid: 'u-0', timestamp: new Date(Date.now() - 11 * 60000).toISOString(),
      message: { role: 'user', content: 'Ajusta o relatório de PDF.' } }),
    linhaAssistant(1, 90000),
    linhaAssistant(2, USADOS),
  ].join('\n') + '\n';
}

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}`, "exec direto": o pane_pid É o claude. */
function plantarAgenteFalso(raizProc, pid, starttime) {
  const dir = path.join(raizProc, String(pid));
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

/** O `~/.claude/sessions/<pid>.json` que o CLI escreve ao nascer, e o `.jsonl` da conversa. */
function escreverSessao(home, { pid, tmux, sessaoId, cwd, starttime }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive', sessionId: sessaoId, cwd, status: 'idle', updatedAt: Date.now(),
    pid, procStart: starttime, tmux,
  }));
  const arquivo = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessaoId}.jsonl`);
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, conversaFalsa());
  return arquivo;
}

/** Um job `running` no disco, com o `claude.log` = a mesma conversa. */
function montarJobNoDisco(pastaJobs) {
  const agora = Date.now();
  const dir = path.join(pastaJobs, 'job-opus-5-5');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: 'job-opus-5-5', type: 'ship', project: 'cockpit-agentes',
    title: 'teto do medidor por modelo', created_at: new Date(agora - 12 * 60000).toISOString(),
    worktree: '', branch: '', origin: 'capitao', merged_at: null, approved_at: null,
    status: 'running', pid: process.pid, tmux_session: null,
  }));
  fs.writeFileSync(path.join(dir, 'status.log'), `${new Date(agora - 60000).toISOString()} working: rodando\n`);
  fs.writeFileSync(path.join(dir, 'claude.log'), conversaFalsa());
}

// ─── O roteiro que roda DENTRO do container ─────────────────────────────────────────────────

function roteiro() {
  return `
const puppeteer = require('/app/node_modules/puppeteer-core');
const BASE = process.env.BASE;
const MODO = process.env.MODO;
const PCT = process.env.PCT_ESPERADA;

const problemas = [];
const feitos = [];
const ok = (cond, msg) => { (cond ? feitos : problemas).push(msg); return cond; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function lerMedidor(pagina, tipo) {
  return pagina.evaluate((tipo) => {
    const painel = document.querySelector('.painel[data-tipo="' + tipo + '"]');
    const el = painel && painel.querySelector('.medidor');
    if (!el) return { existe: false };
    return {
      existe: true,
      visivel: !el.hidden,
      pct: (painel.querySelector('.medidor-pct') || {}).textContent || '',
      modelo: (painel.querySelector('.medidor-modelo') || {}).textContent || '',
    };
  }, tipo);
}

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const medidas = {};
  try {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    const erros = [];
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });

    // ── 1) a ABA ──
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    // '#abas .conversa', sem a âncora de projeto: o ANTES vem da develop (lista agrupada por projeto) e o
    // DEPOIS da worktree da D63 (lista chata, '#lista-conversas'). Na vista de conversas só há botão de aba
    // dentro de #abas, e qualquer um serve para medir o teto. (Sem crase aqui: este roteiro é um template.)
    await pagina.waitForSelector('#abas .conversa', { timeout: 20000 });
    await espera(600);
    const clicouAba = await pagina.evaluate(() => {
      const botao = document.querySelector('#abas .conversa');
      if (!botao) return false;
      botao.click();
      return true;
    });
    if (!ok(clicouAba, MODO + ': a aba é clicável')) throw new Error('não achei a aba na lista');
    await pagina.waitForSelector('.painel[data-tipo="aba"]', { timeout: 15000 });
    await espera(2500);
    medidas.aba = await lerMedidor(pagina, 'aba');
    ok(medidas.aba.existe && medidas.aba.visivel, MODO + ': o medidor da ABA está visível');
    ok(medidas.aba.pct.trim() === PCT, MODO + ': a ABA mostra ' + PCT + ' (veio ' + JSON.stringify(medidas.aba.pct) + ')');
    ok(/opus-5-5/.test(medidas.aba.modelo), MODO + ': o chip do modelo da ABA diz opus-5-5 (veio ' + JSON.stringify(medidas.aba.modelo) + ')');
    await pagina.screenshot({ path: '/out/' + MODO + '-aba-medidor.png' });

    // ── 2) o JOB ──
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    try {
      await pagina.waitForSelector('#barra-agentes:not([hidden])', { timeout: 8000 });
      await pagina.click('#barra-agentes');
    } catch { /* já está na vista certa */ }
    await pagina.waitForSelector('#grupo-jobs', { timeout: 15000 });
    await espera(600);
    const clicouJob = await pagina.evaluate(() => {
      const linha = document.querySelector('#grupo-jobs .conversa-linha[data-estado="trabalhando"]');
      const botao = linha && linha.querySelector('.conversa');
      if (!botao) return false;
      botao.click();
      return true;
    });
    if (!ok(clicouJob, MODO + ': o job running é clicável')) throw new Error('não achei o job running na lista');
    await pagina.waitForSelector('.painel[data-tipo="job"]', { timeout: 15000 });
    await espera(2500);
    medidas.job = await lerMedidor(pagina, 'job');
    ok(medidas.job.existe && medidas.job.visivel, MODO + ': o medidor do JOB está visível');
    ok(medidas.job.pct.trim() === PCT, MODO + ': o JOB mostra ' + PCT + ' (veio ' + JSON.stringify(medidas.job.pct) + ')');
    await pagina.screenshot({ path: '/out/' + MODO + '-job-medidor.png' });

    ok(erros.length === 0, MODO + ': sem erro de console (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
    console.log('@@MEDIDAS-TETO@@' + JSON.stringify({ feitos, problemas, medidas }));
  } finally {
    await navegador.close();
  }
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  console.log('@@MEDIDAS-TETO@@' + JSON.stringify({ feitos, problemas: problemas.concat(['roteiro estourou: ' + e.message]) }));
  process.exitCode = 1;
});
`;
}

function rodarModo({ modo, base, scratch, pct }) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`, '-e', `MODO=${modo}`, '-e', `PCT_ESPERADA=${pct}`,
      '-v', `${scratch}:/w:ro`, '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    docker.on('close', (codigo) => {
      console.log(saidaDocker);
      const MARCADOR = '@@MEDIDAS-TETO@@';
      const abre = saidaDocker.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) {
        try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      }
      resolve(relatorio || { feitos: [], problemas: [`o roteiro (${modo}) não devolveu JSON (código ${codigo})`] });
    });
  });
}

// ─── Corrida ────────────────────────────────────────────────────────────────────────────────

(async () => {
  let antesDir = null;
  let scratch = null;
  let servidorAntes = null;
  let servidorDepois = null;
  let tmuxNoAr = false;

  const limpar = () => {
    for (const s of [servidorAntes, servidorDepois]) {
      if (s && s.exitCode === null) { try { process.kill(s.pid); } catch { /* já morreu */ } }
    }
    if (tmuxNoAr) {
      // Fail-closed (D35): o carimbo prova que EU criei o socket; a enumeração prova que não
      // há mais ninguém nele. Matar exige as duas respostas.
      const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
        .split('\n').some((n) => n.trim() === CARIMBO);
      const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
        .split('\n').map((n) => n.trim()).filter(Boolean);
      const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
      if (temCarimbo && !intrusas.length) {
        t(['kill-server'], { tolerante: true });
        if (!t(['ls'], { tolerante: true }).trim()) {
          fs.rmSync(path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`, SOCKET), { force: true });
        }
      } else if (temCarimbo) {
        for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
        console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
      }
    }
    for (const d of [antesDir, scratch]) {
      if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* some depois */ } }
    }
  };

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      return process.exit(2);
    }
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Este script recusa sobrescrever.`);
      return process.exit(2);
    }
    for (const porta of [PORTA_ANTES, PORTA_DEPOIS]) {
      if (portaOcupada(porta)) {
        console.error(`🔴 a porta ${porta} já está em uso — aborta antes de subir qualquer coisa.`);
        return process.exit(2);
      }
    }

    // 1) a árvore do `develop` — o ANTES
    antesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-antes-teto-'));
    const shaDevelop = execSync('git rev-parse develop', { cwd: RAIZ, encoding: 'utf8' }).trim();
    execSync(`git archive develop | tar -x -C ${antesDir}`, { cwd: RAIZ });
    console.log(`  · árvore do "antes" = develop@${shaDevelop}`);

    // 2) o HOME falso — SEM `model` no settings, que é a máquina do dono hoje
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-teto-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high' }));
    fs.writeFileSync(path.join(scratch, 'roteiro.js'), roteiro());
    const raizProc = path.join(scratch, 'proc');
    fs.mkdirSync(raizProc, { recursive: true });

    // 3) o job no disco
    const pastaJobs = path.join(scratch, 'jobs');
    montarJobNoDisco(pastaJobs);

    // 4) a aba no tmux isolado + o /proc de mentira + os arquivos do CLI
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO_TMUX, '-n', 'loja-exemplo', '-c', os.tmpdir(), 'sleep', '600']);
    tmuxNoAr = true;
    const [janelaId, paneId, panePid] = t(['list-panes', '-t', SESSAO_TMUX, '-F', '#{window_id}\t#{pane_id}\t#{pane_pid}'])
      .trim().split('\n')[0].split('\t');
    const starttime = 1000000 + Number(panePid);
    plantarAgenteFalso(raizProc, Number(panePid), starttime);
    const jsonl = escreverSessao(home, {
      pid: Number(panePid), tmux: `${SESSAO_TMUX}:${janelaId}.${paneId}`,
      sessaoId: 'sess-print-teto', cwd: CWD_DA_ABA, starttime,
    });
    console.log(`  · aba falsa: pane ${janelaId}.${paneId} (pid ${panePid}) → ${jsonl}`);

    // 5) os dois servidores, na MESMA fixture. Isolamento #78 por LISTA FECHADA: toda pasta
    //    que algum módulo do servidor possa tocar nasce em `scratch`, descartável.
    const ambienteBase = { ...process.env };
    delete ambienteBase.COCKPIT_TOKEN;
    Object.assign(ambienteBase, {
      HOST: '127.0.0.1',
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO_TMUX,
      COCKPIT_PROC_RAIZ: raizProc,
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_JOBS_DIR: pastaJobs,
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_USO_DIR: path.join(scratch, 'uso'),
      COCKPIT_USO_CODEX_DIR: path.join(scratch, 'uso-codex'),
      COCKPIT_LEITURAS_DIR: path.join(scratch, 'leituras'),
      COCKPIT_STATUS_CODEX_DIR: path.join(scratch, 'status-codex'),
      COCKPIT_CLEAR_CODEX_DIR: path.join(scratch, 'clear-codex'),
      COCKPIT_INBOX: path.join(scratch, 'inbox'),
    });

    servidorAntes = spawn(process.execPath, [path.join(antesDir, 'server.js')], {
      cwd: antesDir, env: { ...ambienteBase, PORT: String(PORTA_ANTES) }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    servidorDepois = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
      cwd: RAIZ, env: { ...ambienteBase, PORT: String(PORTA_DEPOIS) }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    for (const [nome, s, porta] of [['antes', servidorAntes, PORTA_ANTES], ['depois', servidorDepois, PORTA_DEPOIS]]) {
      let pronto = false;
      for (let i = 0; i < 60 && !pronto; i += 1) {
        if (s.exitCode !== null) break;
        pronto = await saude(porta);
        if (!pronto) await espera(200);
      }
      if (!pronto) {
        console.error(`🔴 o servidor ${nome} (${porta}) não subiu`);
        limpar();
        return process.exit(1);
      }
      console.log(`  · servidor ${nome} no ar em http://127.0.0.1:${porta} (pid ${s.pid})`);
    }

    // 6) os dois lados
    const relAntes = await rodarModo({ modo: 'antes', base: `http://127.0.0.1:${PORTA_ANTES}`, scratch, pct: '65%' });
    const relDepois = await rodarModo({ modo: 'depois', base: `http://127.0.0.1:${PORTA_DEPOIS}`, scratch, pct: '13%' });

    const feitos = [...relAntes.feitos, ...relDepois.feitos];
    const problemas = [...relAntes.problemas, ...relDepois.problemas];
    console.log('\n── Resultado ──');
    for (const f of feitos) console.log('  ✅ ' + f);
    for (const p of problemas) console.log('  ❌ ' + p);
    console.log(`\nPNGs em ${SAIDA}`);
    if (problemas.length) {
      console.log('\n❌ PROVA DE TELA REPROVADA');
      limpar();
      return process.exit(1);
    }
    console.log('\n✅ PROVA DE TELA OK — 65% no ANTES (teto 200k) e 13% no DEPOIS (teto 1M), na aba E no job');
    limpar();
    return process.exit(0);
  } catch (e) {
    console.error('🔴 estourou:', e.message);
    limpar();
    return process.exit(1);
  }
})();
