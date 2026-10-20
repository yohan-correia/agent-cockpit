#!/usr/bin/env node
'use strict';
// GATE DO SUB-AGENTE EM BACKGROUND — a aba com um Agent rodando em segundo plano NÃO pode
// aparecer "trabalhando" para sempre.
//
// O card: `trabalhando-nao-distingue-subagente` (roadmap-board). O sintoma: o principal termina
// o turno e responde na hora, mas a aba fica "trabalhando" até o sub-agente em background
// acabar — o dono acha que a mensagem dele vai cair na FILA e espera à toa.
//
// Spec: docs/superpowers/specs/2026-10-14-trabalhando-nao-distingue-subagente-design.md (§2-§5).
// Medido em 14/10 (sessão isolada `medebg7558`): o CLI segura `status: busy` enquanto houver
// Agent em background; o sinal é `system/turn_duration.pendingBackgroundAgentCount` — o campo
// SOME quando é zero, nunca aparece `0`. "Principal livre" = a última linha "de turno" da cauda
// do `.jsonl` é esse `turn_duration`; "em background" = a contagem dele; "principal acordou" =
// qualquer linha `user`/`assistant`/`attachment`/outro `system` depois dele.
//
// Sem duble de `lib/abas`: tmux REAL em socket isolado (`-L`, D35), HOME falso e um `/proc` de
// mentira via COCKPIT_PROC_RAIZ — o mesmo arreio de `testes/gate-aba-movida.js`. Nunca o socket
// padrão: nada aqui mata, move ou digita em sessão do usuário.
//
// Casos (uma janela tmux por um, `sleep 600`, com `~/.claude/sessions/<pid>.json` e o `.jsonl`
// no formato REAL medido): so-principal, so-background, os-dois, notificacao-chegou,
// interrompido, shell-com-agente, cauda-cortada, tipo-novo, bridge-session, away-summary,
// busy-sem-contagem, republicado, sem-timestamp — ver a tabela da spec §7.1/do plano. Mais a
// rota (`server.js` numa porta alta) e o SSE (`/api/eventos`, achado do painel) na mesma
// instância, e os unitários/puros de `estadoDoTurno`, `derivarSegundoPlano`, `vigia.decidir()`
// e `terminou.observar()`.
//
// HOJE ESTE GATE REPROVA (rota bug, D-a da spec): `emBackground` não existe e `so-background`
// sai com `rodando: true`. O conserto vem na Fase 2 (`lib/externo.js`, `lib/abas.js`).
//
// Uso:  node testes/gate-segundo-plano.js          (PORT opcional; padrão 7889)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const PORTA = Number(process.env.PORT || 7889);
const SOCKET = `cockpit-smoke-segundo-plano-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

const herdado = process.env.COCKPIT_TMUX_SOCKET || '';
if (herdado && !/^cockpit-(smoke|offline)-/.test(herdado)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${herdado}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

const t = (args, { tolerante = false } = {}) => {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
};
if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-segundo-plano-'));
const home = path.join(scratch, 'home');
const raizProc = path.join(scratch, 'proc');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(raizProc, { recursive: true });

let servidor = null;
function limpar() {
  if (servidor && !servidor.killed) servidor.kill('SIGTERM');
  // Fail-closed (D35): o carimbo prova que EU criei o socket; a enumeração prova que não há
  // mais ninguém nele. Matar exige as duas respostas.
  const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
    .split('\n').some((n) => n.trim() === CARIMBO);
  const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
    .split('\n').map((n) => n.trim()).filter(Boolean);
  const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
  let limpo = true;
  if (temCarimbo && !intrusas.length) {
    t(['kill-server'], { tolerante: true });
  } else if (temCarimbo) {
    for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
    limpo = false;
    console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
  } else {
    limpo = false;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  if (limpo && !t(['ls'], { tolerante: true }).trim()) {
    fs.rmSync(path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`, SOCKET), { force: true });
  }
  return limpo;
}

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}`, padrão "exec direto" (molde: gate-aba-movida.js:101-117). */
function plantarAgenteFalso(pid, starttime) {
  const dir = path.join(raizProc, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = '(claude)';
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);      // pgrp
  campos[5] = String(pid);      // session
  campos[6] = '34816';          // tty
  campos[7] = String(pid);      // tpgid = pgrp → está no foreground
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), '/usr/bin/claude\0');
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

/** O arquivo que o CLI escreve ao nascer, com o `statusUpdatedAt` que a spec D-e/D-b.4 lê. */
function escreverSessao({ pid, tmux, sessaoId, cwd, starttime, status, statusUpdatedAt }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive', sessionId: sessaoId, cwd, status, updatedAt: Date.now(),
    pid, procStart: starttime, tmux, statusUpdatedAt,
  }));
}

function caminhoDoJsonl(cwd, sessaoId) {
  return path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessaoId}.jsonl`);
}

function escreverJsonl(caminho, conteudo) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, conteudo);
}

// ─── O formato REAL medido (spec §2.1) ───────────────────────────────────────

// O carimbo de um incidente real (12:55:45.802Z), com `pendingBackgroundAgentCount: 1`.
const T = Date.parse('2026-10-14T12:55:45.802Z');
const iso = (ms) => new Date(ms).toISOString();
const linha = (obj) => `${JSON.stringify(obj)}\n`;

const userFala = (ms, texto) => linha({ type: 'user', timestamp: iso(ms), message: { content: texto } });
const assistenteTexto = (ms, texto) => linha({ type: 'assistant', timestamp: iso(ms), message: { content: [{ type: 'text', text: texto }] } });
const assistenteFerramenta = (ms, nome, input) => linha({
  type: 'assistant', timestamp: iso(ms),
  message: { content: [{ type: 'tool_use', id: `tu-${nome}-${ms}`, name: nome, input }] },
});
const toolResultAsync = (ms) => linha({
  type: 'user', timestamp: iso(ms),
  message: { content: [{ type: 'tool_result', tool_use_id: `tu-Agent-${ms - 5000}`, content: 'Async agent launched successfully.' }] },
});
const handBack = (ms) => linha({
  type: 'user', isMeta: true, timestamp: iso(ms),
  message: { content: 'Another Claude session sent a message:\n<agent-message from="a1">[Subagent hand-back] feito</agent-message>' },
});
const interrompido = (ms) => linha({
  type: 'user', timestamp: iso(ms), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
});
const taskNotification = (ms) => linha({
  type: 'user', timestamp: iso(ms),
  message: { content: '<task-notification>\n<task-id>x1</task-id>\n<summary>fim</summary>\n</task-notification>' },
});
// `turn_duration`: os campos reais medidos (spec §2.1) — `pendingBackgroundAgentCount` SÓ
// quando > 0 (o campo some quando é zero, nunca aparece `0`), `timestamp` ausente só no caso
// `sem-timestamp`.
function turnoFim({ pend, timestamp, sessionId, semTimestamp = false, sufixo = '' } = {}) {
  const obj = {
    type: 'system', subtype: 'turn_duration', durationMs: 2140, messageCount: 4,
    isSidechain: false, uuid: `td-${sessionId}${sufixo}`, sessionId,
  };
  if (!semTimestamp) obj.timestamp = timestamp;
  if (Number.isFinite(pend) && pend > 0) obj.pendingBackgroundAgentCount = pend;
  return linha(obj);
}
const metadado = (tipo, ms, extra = {}) => linha({ type: tipo, timestamp: iso(ms), ...extra });
const awaySummary = (ms) => linha({ type: 'system', subtype: 'away_summary', content: 'recap', timestamp: iso(ms) });

// ─── Os 13 casos (D-b/D-e/§2.4/§7.1 da spec) ─────────────────────────────────

const CASOS = [
  {
    nome: 'so-principal', status: 'busy', statusUpdatedAt: T - 90000,
    corpo: userFala(T - 130000, 'faz um cálculo')
      + assistenteFerramenta(T - 125000, 'Bash', { command: 'ls' }),
    esperaRodando: true, esperaBackground: 0,
  },
  {
    nome: 'so-background', status: 'busy', statusUpdatedAt: T - 90000,
    corpo: userFala(T - 130000, 'roda isso em background')
      + assistenteFerramenta(T - 125000, 'Agent', { description: 'calcular', prompt: 'calcula' })
      + toolResultAsync(T - 120000)
      + assistenteTexto(T - 115000, 'Deixei rodando em background, pode seguir falando comigo.')
      + turnoFim({ pend: 1, timestamp: iso(T), sessionId: 'so-background' })
      + metadado('last-prompt', T + 500)
      + metadado('ai-title', T + 600)
      + metadado('queue-operation', T + 700),
    esperaRodando: false, esperaBackground: 1, esperaStatusDesde: T,
  },
  {
    nome: 'os-dois', status: 'busy', statusUpdatedAt: T - 90000,
    corpo: userFala(T - 130000, 'roda isso em background')
      + assistenteFerramenta(T - 125000, 'Agent', { description: 'calcular', prompt: 'calcula' })
      + toolResultAsync(T - 120000)
      + assistenteTexto(T - 115000, 'Deixei rodando em background, pode seguir falando comigo.')
      + turnoFim({ pend: 1, timestamp: iso(T), sessionId: 'os-dois' })
      + handBack(T + 2000)
      + assistenteTexto(T + 2500, 'Oi, voltei.'),
    esperaRodando: true, esperaBackground: 0,
  },
  {
    nome: 'notificacao-chegou', status: 'idle', statusUpdatedAt: T - 90000,
    corpo: turnoFim({ pend: 1, timestamp: iso(T - 10000), sessionId: 'notificacao-chegou' })
      + taskNotification(T - 5000)
      + assistenteTexto(T - 4000, 'Pronto.')
      + turnoFim({ timestamp: iso(T - 3000), sessionId: 'notificacao-chegou', sufixo: '-2' }),
    esperaRodando: false, esperaBackground: 0,
  },
  {
    nome: 'interrompido', status: 'busy', statusUpdatedAt: T - 90000,
    corpo: userFala(T - 130000, 'roda isso em background')
      + assistenteFerramenta(T - 125000, 'Agent', { description: 'calcular', prompt: 'calcula' })
      + toolResultAsync(T - 120000)
      + interrompido(T - 115000),
    esperaRodando: true, esperaBackground: 0,
  },
  {
    nome: 'shell-com-agente', status: 'shell', statusUpdatedAt: T - 90000,
    corpo: turnoFim({ pend: 2, timestamp: iso(T), sessionId: 'shell-com-agente' }),
    esperaRodando: false, esperaBackground: 0,
  },
  {
    nome: 'cauda-cortada', status: 'busy', statusUpdatedAt: T - 90000,
    // A última linha SEM `\n` final — "a linha sendo escrita agora" (armadilha #11).
    corpo: `${turnoFim({ pend: 1, timestamp: iso(T), sessionId: 'cauda-cortada' })}{"type":"assistant","mess`,
    esperaRodando: true, esperaBackground: 0,
  },
  {
    nome: 'tipo-novo', status: 'busy', statusUpdatedAt: T - 90000,
    corpo: turnoFim({ pend: 1, timestamp: iso(T), sessionId: 'tipo-novo' })
      + linha({ type: 'coisa-que-nao-existe', timestamp: iso(T + 500) }),
    esperaRodando: true, esperaBackground: 0,
  },
  {
    nome: 'bridge-session', status: 'busy', statusUpdatedAt: T - 90000,
    corpo: turnoFim({ pend: 1, timestamp: iso(T), sessionId: 'bridge-session' })
      + linha({ type: 'bridge-session', bridgeSessionId: 'x', sessionId: 'bridge-session', timestamp: iso(T + 500) })
      + linha({ type: 'relocated', timestamp: iso(T + 600) })
      + linha({ type: 'worktree-state', timestamp: iso(T + 700) }),
    esperaRodando: false, esperaBackground: 1, esperaStatusDesde: T,
  },
  {
    nome: 'away-summary', status: 'busy', statusUpdatedAt: T - 90000,
    corpo: turnoFim({ pend: 1, timestamp: iso(T), sessionId: 'away-summary' })
      + awaySummary(T + 180000),
    esperaRodando: false, esperaBackground: 1, esperaStatusDesde: T,
  },
  {
    nome: 'busy-sem-contagem', status: 'busy', statusUpdatedAt: T - 90000,
    corpo: turnoFim({ timestamp: iso(T), sessionId: 'busy-sem-contagem' }),
    esperaRodando: true, esperaBackground: 0,
  },
  {
    // D-b.4: o CLI republicou `busy` DEPOIS do `turn_duration` — algo novo começou e a cauda
    // ainda não mostra (achado do Codex, rodada 1).
    nome: 'republicado', status: 'busy', statusUpdatedAt: T + 5000,
    corpo: turnoFim({ pend: 1, timestamp: iso(T), sessionId: 'republicado' }),
    esperaRodando: true, esperaBackground: 0,
  },
  {
    nome: 'sem-timestamp', status: 'busy', statusUpdatedAt: T - 90000,
    corpo: turnoFim({ pend: 1, semTimestamp: true, sessionId: 'sem-timestamp' }),
    esperaRodando: true, esperaBackground: 0,
  },
];

// A janela do SSE: sessão SEMPRE `busy` (o `statusUpdatedAt` fica bem antes de qualquer
// `turn_duration` que o teste venha a acrescentar, para a condição D-b.4 nunca travar a prova).
const SSE_STATUS_DESDE = T - 600000;
const corpoSseInicial = userFala(T - 300000, 'roda isso em background')
  + assistenteFerramenta(T - 295000, 'Bash', { command: 'sleep 1' }); // meio do turno: sem tool_result, sem turn_duration

function principal() {
  // ─── o cenário no tmux ─────────────────────────────────────────────────────
  t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
  t(['new-session', '-d', '-s', SESSAO, '-n', CASOS[0].nome, '-c', os.tmpdir(), 'sleep', '600']);
  for (const caso of CASOS.slice(1)) {
    t(['new-window', '-t', SESSAO, '-n', caso.nome, '-c', os.tmpdir(), 'sleep', '600']);
  }
  t(['new-window', '-t', SESSAO, '-n', 'sse', '-c', os.tmpdir(), 'sleep', '600']);

  const panes = {};
  for (const l of t(['list-panes', '-a', '-F', '#{session_name}\t#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
    if (!l.trim()) continue;
    const [sessao, nome, janelaId, paneId, panePid] = l.split('\t');
    panes[nome] = { sessao, janelaId, paneId, panePid: Number(panePid) };
  }

  const inicio = (pid) => 1000000 + pid;
  const todosOsNomes = [...CASOS.map((c) => c.nome), 'sse'];
  for (const nome of todosOsNomes) {
    if (!panes[nome]) throw new Error(`a janela "${nome}" não apareceu no list-panes`);
    plantarAgenteFalso(panes[nome].panePid, inicio(panes[nome].panePid));
  }

  // ─── os arquivos do CLI, por caso ──────────────────────────────────────────
  for (const caso of CASOS) {
    const pane = panes[caso.nome];
    const cwd = `/home/gate/segundo-plano/${caso.nome}`;
    escreverSessao({
      pid: pane.panePid, tmux: `${SESSAO}:${pane.janelaId}.${pane.paneId}`, sessaoId: caso.nome,
      cwd, starttime: inicio(pane.panePid), status: caso.status, statusUpdatedAt: caso.statusUpdatedAt,
    });
    escreverJsonl(caminhoDoJsonl(cwd, caso.nome), caso.corpo);
  }
  const cwdSse = '/home/gate/segundo-plano/sse';
  const paneSse = panes.sse;
  escreverSessao({
    pid: paneSse.panePid, tmux: `${SESSAO}:${paneSse.janelaId}.${paneSse.paneId}`, sessaoId: 'sse',
    cwd: cwdSse, starttime: inicio(paneSse.panePid), status: 'busy', statusUpdatedAt: SSE_STATUS_DESDE,
  });
  const arquivoSse = caminhoDoJsonl(cwdSse, 'sse');
  escreverJsonl(arquivoSse, corpoSseInicial);

  // ─── env e o módulo (depois do /proc/HOME/sessions todos escritos) ────────
  const ambienteBase = {
    COCKPIT_TMUX_SOCKET: SOCKET,
    COCKPIT_TMUX_SESSAO: SESSAO,
    COCKPIT_PROC_RAIZ: raizProc,
    COCKPIT_BIN_CLAUDE: '/bin/true',
    COCKPIT_VIGIA_MS: '0',
    HOME: home,
  };
  Object.assign(process.env, ambienteBase);
  // Requerido SÓ DEPOIS do HOME falso: `lib/externo.js` resolve `os.homedir()` na carga do módulo.
  const abas = require(path.join(__dirname, '..', 'lib', 'abas.js'));
  const externo = require(path.join(__dirname, '..', 'lib', 'externo.js'));
  const vigia = require(path.join(__dirname, '..', 'lib', 'vigia-abas.js'));
  const terminou = require(path.join(__dirname, '..', 'lib', 'terminou.js'));

  return { panes, ambienteBase, abas, externo, vigia, terminou, arquivoSse, cwdSse };
}

// ─── Passo 2: `abas.listar()` — os 13 casos ──────────────────────────────────

async function conferirListar(abas) {
  console.log('\nlistar() — os 13 casos da tabela (D-a..D-e, §2.4, §7.1)');
  let tudoOk = true;
  const lista = await abas.listar();
  const porTitulo = Object.fromEntries(lista.map((a) => [a.titulo, a]));

  for (const caso of CASOS) {
    const aba = porTitulo[caso.nome];
    if (!aba) { tudoOk = ok(false, `aba "${caso.nome}" existe na lista`) && tudoOk; continue; }
    const rodandoOk = ok(aba.rodando === caso.esperaRodando,
      `${caso.nome}: rodando === ${caso.esperaRodando} (achado ${aba.rodando})`);
    const backgroundOk = ok(aba.emBackground === caso.esperaBackground,
      `${caso.nome}: emBackground === ${caso.esperaBackground} (achado ${aba.emBackground})`);
    if (!rodandoOk || !backgroundOk) console.log(`  ❌ ${caso.nome}: rodando=${aba.rodando} emBackground=${aba.emBackground}`);
    tudoOk = rodandoOk && tudoOk;
    tudoOk = backgroundOk && tudoOk;
    if (caso.esperaStatusDesde !== undefined) {
      tudoOk = ok(aba.statusDesde === caso.esperaStatusDesde,
        `${caso.nome}: statusDesde === ${caso.esperaStatusDesde} (D-e, achado ${aba.statusDesde})`) && tudoOk;
    }
  }

  // Toda aba tem `emBackground` finito — nunca `undefined`/`NaN` (estrito: reprova ausência).
  const semFinito = lista.filter((a) => !Number.isFinite(a.emBackground)).map((a) => a.titulo);
  tudoOk = ok(semFinito.length === 0,
    `Number.isFinite(emBackground) em toda aba${semFinito.length ? ` — falhou em: ${semFinito.join(', ')}` : ''}`) && tudoOk;

  return { tudoOk, lista };
}

// ─── Passo 3: unitários — `estadoDoTurno` e `derivarSegundoPlano` ────────────

async function conferirUnitariosAsync(externo, abas, arquivosPorCaso) {
  console.log('\nunitários — estadoDoTurno(arquivo) e derivarSegundoPlano(aba, turno)');
  let tudoOk = true;

  if (typeof externo.estadoDoTurno !== 'function') {
    tudoOk = ok(false, 'estadoDoTurno existe em lib/externo.js (exportada)') && tudoOk;
  } else {
    const r = async (nome) => externo.estadoDoTurno(arquivosPorCaso[nome]);
    tudoOk = ok(
      (await r('so-background'))?.livre === true
      && (await r('so-background'))?.emBackground === 1
      && (await r('so-background'))?.fimEm === T,
      `estadoDoTurno(so-background) === {livre:true, emBackground:1, fimEm:${T}} (achado ${JSON.stringify(await r('so-background'))})`,
    ) && tudoOk;
    tudoOk = ok(
      (await r('so-principal'))?.livre === false,
      `estadoDoTurno(so-principal) === {livre:false} (achado ${JSON.stringify(await r('so-principal'))})`,
    ) && tudoOk;
    tudoOk = ok((await r('cauda-cortada')) === null, 'estadoDoTurno(cauda-cortada) === null (sem \\n final)') && tudoOk;
    tudoOk = ok((await r('tipo-novo')) === null, 'estadoDoTurno(tipo-novo) === null (tipo desconhecido)') && tudoOk;
    tudoOk = ok((await externo.estadoDoTurno('/nao/existe.jsonl')) === null, 'estadoDoTurno(arquivo inexistente) === null') && tudoOk;
  }

  if (typeof abas.derivarSegundoPlano !== 'function') {
    tudoOk = ok(false, 'derivarSegundoPlano existe em lib/abas.js (exportada)') && tudoOk;
  } else {
    const d = abas.derivarSegundoPlano;
    // A tabela da spec §5 (fail-safe), linha a linha — entrada {status, statusDesde} + turno.
    const casosPuro = [
      ['arquivo não abre / cauda cortada / JSON inválido', { status: 'busy', statusDesde: T - 90000 }, null, null],
      ['tipo desconhecido depois do turn_duration', { status: 'busy', statusDesde: T - 90000 }, { livre: false }, null],
      ['turn_duration sem contagem com busy', { status: 'busy', statusDesde: T - 90000 }, { livre: true, emBackground: 0, fimEm: T }, null],
      ['statusDesde > fimEm (republicado)', { status: 'busy', statusDesde: T + 5000 }, { livre: true, emBackground: 1, fimEm: T }, null],
      ['timestamp ilegível', { status: 'busy', statusDesde: T - 90000 }, { livre: true, emBackground: 1, fimEm: null }, null],
      ['turn_duration com contagem, shell', { status: 'shell', statusDesde: T - 90000 }, { livre: true, emBackground: 2, fimEm: T }, null],
      ['turn_duration com contagem, busy, statusDesde <= fimEm', { status: 'busy', statusDesde: T - 90000 }, { livre: true, emBackground: 1, fimEm: T },
        { rodando: false, emBackground: 1, statusDesde: T }],
    ];
    for (const [texto, aba, turno, esperado] of casosPuro) {
      const achado = d(aba, turno);
      const bate = esperado === null ? achado === null
        : (achado && achado.rodando === esperado.rodando && achado.emBackground === esperado.emBackground && achado.statusDesde === esperado.statusDesde);
      tudoOk = ok(bate, `derivarSegundoPlano: ${texto} → ${esperado === null ? 'null' : JSON.stringify(esperado)} (achado ${JSON.stringify(achado)})`) && tudoOk;
    }
  }

  return tudoOk;
}

// ─── Passo 4: a rota ──────────────────────────────────────────────────────────

function pegarJson(caminho) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: caminho }, (res) => {
      let corpo = '';
      res.setEncoding('utf8');
      res.on('data', (p) => { corpo += p; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(corpo) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}

async function subirServidor(ambienteBase) {
  servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, ...ambienteBase,
      PORT: String(PORTA), HOST: '127.0.0.1', COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TOKEN: '',
      COCKPIT_JOBS_DIR: path.join(scratch, 'sem-jobs'),
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'),
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
      COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let erroServidor = '';
  servidor.stderr.on('data', (p) => { erroServidor += p; });
  let resposta = null;
  for (let i = 0; i < 40 && !resposta; i += 1) {
    await espera(250);
    resposta = await pegarJson('/api/abas').catch(() => null);
  }
  if (!resposta) console.error(erroServidor.slice(-800));
  return { resposta, erroServidor };
}

async function conferirRota(ambienteBase) {
  console.log('\na rota — GET /api/abas numa instância de gate');
  let tudoOk = true;
  const { resposta } = await subirServidor(ambienteBase);
  tudoOk = ok(resposta && resposta.status === 200, `GET /api/abas respondeu na porta ${PORTA}`) && tudoOk;
  const lista = resposta?.json?.abas || [];
  const porTitulo = Object.fromEntries(lista.map((a) => [a.titulo, a]));
  const sb = porTitulo['so-background'];
  const sp = porTitulo['so-principal'];
  tudoOk = ok(sb && sb.rodando === false && sb.emBackground === 1,
    `rota: so-background → rodando=${sb?.rodando} emBackground=${sb?.emBackground}`) && tudoOk;
  tudoOk = ok(sp && sp.rodando === true && sp.emBackground === 0,
    `rota: so-principal → rodando=${sp?.rodando} emBackground=${sp?.emBackground}`) && tudoOk;
  tudoOk = ok(sb && sb.statusDesde === undefined, 'rota: statusDesde continua interno (não sai em paraCliente)') && tudoOk;
  if (sb) console.log(`  ↳ /api/abas (so-background): ${JSON.stringify({ titulo: sb.titulo, rodando: sb.rodando, emBackground: sb.emBackground })}`);
  return tudoOk;
}

// ─── Passo 5: SSE — a transição em três tempos (achado X2/X4 do painel) ──────

function conectarSSE(caminho) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: caminho }, (res) => {
      const eventos = [];
      let bufer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bufer += chunk;
        let idx = bufer.indexOf('\n\n');
        while (idx >= 0) {
          const bloco = bufer.slice(0, idx);
          bufer = bufer.slice(idx + 2);
          const linhaDados = bloco.split('\n').find((l) => l.startsWith('data: '));
          if (linhaDados) { try { eventos.push(JSON.parse(linhaDados.slice(6))); } catch { /* ignora */ } }
          idx = bufer.indexOf('\n\n');
        }
      });
      resolve({ req, res, eventos });
    });
    req.on('error', reject);
  });
}

async function esperarEvento(eventos, desde, teste, limiteMs = 8000) {
  const comeco = Date.now();
  while (Date.now() - comeco < limiteMs) {
    for (let i = desde; i < eventos.length; i += 1) {
      if (teste(eventos[i])) return { achado: true, indice: i };
    }
    await espera(100);
  }
  return { achado: false, indice: eventos.length };
}

async function conferirSSE(abas, arquivoSse) {
  console.log('\nSSE — GET /api/eventos nos três tempos da transição (D-g, relógio de 2s)');
  let tudoOk = true;

  const lista = await abas.listar();
  const aba = lista.find((a) => a.titulo === 'sse');
  if (!aba) return ok(false, 'aba "sse" existe na lista (SSE)');
  const { res, eventos } = await conectarSSE(`/api/eventos?abas=${aba.chave}`);

  try {
    // O envelope do cano é `{ aba: chave, evento: {tipo, ...} }` (server.js) — o teste olha
    // sempre `e.evento`, nunca `e` direto.
    // Tempo 0: cauda no meio do turno (sem turn_duration ainda) → sincronizado{turnoEmAndamento:true}.
    const t0 = await esperarEvento(eventos, 0, (e) => e.evento?.tipo === 'sincronizado' && e.evento.turnoEmAndamento === true);
    tudoOk = ok(t0.achado, 'SSE tempo 0: sincronizado{turnoEmAndamento:true} (cauda em assistant tool_use)') && tudoOk;
    const depoisDoT0 = eventos.length;

    // Tempo 1: acrescenta turn_duration com contagem → turno_fim (D-g: server.js:687 só emite
    // quando `agora !== rodando` — sem o conserto, nada sai aqui).
    fs.appendFileSync(arquivoSse, turnoFim({ pend: 1, timestamp: iso(T - 290000), sessionId: 'sse' }));
    const t1 = await esperarEvento(eventos, depoisDoT0, (e) => e.evento?.tipo === 'turno_fim');
    tudoOk = ok(t1.achado, 'SSE tempo 1: turno_fim (depois do turn_duration com contagem)') && tudoOk;
    const depoisDoT1 = Math.max(eventos.length, t1.indice + 1);

    // Tempo 2: acrescenta a volta (hand-back) → sincronizado{turnoEmAndamento:true} NOVO,
    // recebido DEPOIS deste append (o do tempo 0 não vale).
    fs.appendFileSync(arquivoSse, handBack(T - 288000));
    const t2 = await esperarEvento(eventos, depoisDoT1, (e) => e.evento?.tipo === 'sincronizado' && e.evento.turnoEmAndamento === true);
    tudoOk = ok(t2.achado, 'SSE tempo 2: sincronizado{turnoEmAndamento:true} NOVO (depois do hand-back)') && tudoOk;
  } finally {
    res.destroy();
  }

  return tudoOk;
}

// ─── Passo 6: vigia e terminou (puros) ───────────────────────────────────────

function conferirVigiaETerminou(vigia, terminou, listaReal) {
  console.log('\nvigia.decidir() e terminou.observar() — a identidade do fim de turno (D-e, R1/R2)');
  let tudoOk = true;
  terminou._zerar();

  const base = { chave: 'v', sessaoId: 's', titulo: 'v', cwd: '/x', temAgente: true, agente: 'claude', esperando: false, arquivo: '/a' };
  const A = { ...base, rodando: true, statusDesde: T - 90000, atualizadoEm: T - 1000 };
  const real = listaReal.find((a) => a.titulo === 'so-background');
  const B = { ...base, rodando: real ? real.rodando : true, statusDesde: real ? real.statusDesde : null, atualizadoEm: T - 500 };

  const { avisos: avisosA, estado } = vigia.decidir(null, [A]);
  tudoOk = ok(avisosA.length === 0, 'decidir(null, [A]) semeia sem avisar (restart não é rajada)') && tudoOk;
  const { avisos: avisosB } = vigia.decidir(estado, [B]);
  const fins = avisosB.filter((a) => a.tipo === 'fim');
  tudoOk = ok(fins.length === 1 && fins[0].evento !== null,
    `decidir(estado, [B]) → exatamente 1 aviso "fim" com evento != null (achado ${fins.length})`) && tudoOk;
  // `evento` é um HASH (lib/entregas.js:identidade) — o jeito de provar "marco = T" é recalcular
  // o mesmo hash com o marco esperado e comparar, não ler uma propriedade `.marco`.
  const entregas = require(path.join(__dirname, '..', 'lib', 'entregas.js'));
  const eventoEsperado = entregas.identidade({ chave: 'v', sessaoId: 's', tipo: 'fim', marco: T });
  tudoOk = ok(fins[0]?.evento === eventoEsperado, `o marco do aviso "fim" é o fimEm derivado (${T}, identidade bate: ${fins[0]?.evento === eventoEsperado})`) && tudoOk;

  const l1 = terminou.observar([A], () => undefined, { inicio: 1, fim: 2 });
  const l2 = terminou.observar([B], () => undefined, { inicio: 3, fim: 4 });
  tudoOk = ok(l2[0].terminouEm === T, `terminou.observar(): B.terminouEm === ${T} (achado ${l2[0].terminouEm})`) && tudoOk;
  void l1;

  return tudoOk;
}

// ─── Corrida ──────────────────────────────────────────────────────────────────

async function rodar() {
  const { ambienteBase, abas, externo, vigia, terminou, arquivoSse } = principal();

  const arquivosPorCaso = {};
  for (const caso of CASOS) arquivosPorCaso[caso.nome] = caminhoDoJsonl(`/home/gate/segundo-plano/${caso.nome}`, caso.nome);

  let tudoOk = true;
  const { tudoOk: okListar, lista } = await conferirListar(abas);
  tudoOk = okListar && tudoOk;
  tudoOk = (await conferirUnitariosAsync(externo, abas, arquivosPorCaso)) && tudoOk;
  tudoOk = (await conferirRota(ambienteBase)) && tudoOk;
  tudoOk = (await conferirSSE(abas, arquivoSse)) && tudoOk;
  tudoOk = conferirVigiaETerminou(vigia, terminou, lista) && tudoOk;

  return Boolean(tudoOk);
}

rodar().then((tudoOk) => {
  const limpo = limpar();
  tudoOk = tudoOk && limpo;
  console.log(`\n${tudoOk ? '✅ GATE VERDE' : '❌ GATE VERMELHO'} — aba só com sub-agente em background sai "trabalhando"\n`);
  process.exit(tudoOk ? 0 : 1);
}).catch((e) => {
  limpar();
  console.error('\n❌ o gate quebrou:', e.message, '\n');
  process.exit(1);
});
