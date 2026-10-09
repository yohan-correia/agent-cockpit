#!/usr/bin/env node
'use strict';
// GATE DA ABA MOVIDA — a janela trocou de sessão no tmux e a aba NÃO pode perder a conversa.
//
// O incidente (06/10/2026, produção): depois de um reboot o dono moveu 6 janelas vivas da
// sessão `job-…-56e7` para a `main` (`tmux move-window`). Todas as abas com claude
// passaram a sair de `/api/abas` com `preSessao: true` e `sessaoId: null` — "o agente está
// pedindo uma confirmação no terminal" — com a conversa inteira de pé na pane.
//
// A causa: `sessoesDoCli()` casava o `~/.claude/sessions/<pid>.json` pela chave
// "sessão:@janela.%pane". O CLI grava o campo `tmux` AO NASCER e nunca o atualiza; depois do
// `move-window` a pane está em "main:@33.%35" e o arquivo ainda diz "velha:@33.%35". `@janela`
// e `%pane` são ids globais do SERVIDOR tmux — não mudam com o move — então a chave certa é
// "@janela.%pane", sem a sessão.
//
// Sem duble de `lib/abas`: tmux REAL em socket isolado (`-L`, D35), HOME falso e um `/proc`
// de mentira via COCKPIT_PROC_RAIZ — o mesmo arreio de `testes/gate-multiplex.js --medir`.
// Nunca o socket padrão: nada aqui mata, move ou digita em sessão do usuário.
//
// Casos:
//   1. janela nasceu em "velha", foi movida para "main"; o arquivo do CLI ainda diz
//      "velha:@J.%P" → a aba sai com `sessaoId` e `preSessao: false`.
//   2. negativo: arquivo do CLI aponta para OUTRO `@janela.%pane` → continua sem casar
//      (`sessaoId: null`, `preSessao: true`).
//   3. unitário: as chaves de `sessoesDoCli()` não carregam nome de sessão.
//   4. a rota: `server.js` numa porta alta, `GET /api/abas` devolve `preSessao: false` para a
//      aba movida — a prova no artefato que o celular lê.
//
// Uso:  node testes/gate-aba-movida.js          (PORT opcional; padrão 7888)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const PORTA = Number(process.env.PORT || 7888);
const SOCKET = `cockpit-smoke-aba-movida-${process.pid}`;
const SESSAO = 'main';
const VELHA = 'velha';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO, VELHA]);

const herdado = process.env.COCKPIT_TMUX_SOCKET || '';
if (herdado && !/^cockpit-(smoke|offline)-/.test(herdado)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${herdado}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

const t = (args, { tolerante = false } = {}) => {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
};
if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-aba-movida-'));
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
  // O tmux não apaga o arquivo do socket no `kill-server`; só o meu, só se o servidor morreu.
  if (limpo && !t(['ls'], { tolerante: true }).trim()) {
    fs.rmSync(path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`, SOCKET), { force: true });
  }
  return limpo;
}

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}`, padrão "exec direto": o pane_pid É o claude. */
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

/** O arquivo que o CLI escreve ao nascer. `tmux` vem como o CLI gravou — e ele NUNCA o atualiza. */
function escreverSessao({ pid, tmux, sessaoId, cwd, starttime }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive', sessionId: sessaoId, cwd, status: 'idle', updatedAt: Date.now(),
    pid, procStart: starttime, tmux,
  }));
  const arquivo = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessaoId}.jsonl`);
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, `${JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'oi' }] },
  })}\n`);
}

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

async function rodar() {
  let tudoOk = true;

  // ─── o cenário no tmux ─────────────────────────────────────────────────────
  t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
  t(['new-session', '-d', '-s', SESSAO, '-n', 'fica', '-c', os.tmpdir(), 'sleep', '600']);
  t(['new-session', '-d', '-s', VELHA, '-n', 'movida', '-c', os.tmpdir(), 'sleep', '600']);
  t(['new-window', '-t', SESSAO, '-n', 'orfa', '-c', os.tmpdir(), 'sleep', '600']);

  const lerPanes = () => {
    const panes = {};
    for (const linha of t(['list-panes', '-a', '-F', '#{session_name}\t#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!linha.trim()) continue;
      const [sessao, nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { sessao, janelaId, paneId, panePid: Number(panePid) };
    }
    return panes;
  };

  const antes = lerPanes();
  if (!antes.movida || antes.movida.sessao !== VELHA) throw new Error('a janela "movida" não nasceu em "velha"');
  // O CLI "nasceu" aqui, na sessão velha — grava o campo `tmux` como o tmux diz AGORA.
  const tmuxAoNascer = `${VELHA}:${antes.movida.janelaId}.${antes.movida.paneId}`;

  // O gesto do incidente: a janela muda de sessão. `@janela` e `%pane` ficam os mesmos.
  t(['move-window', '-s', `${VELHA}:movida`, '-t', `${SESSAO}:7`]);
  const depois = lerPanes();
  tudoOk &= ok(depois.movida && depois.movida.sessao === SESSAO, `move-window levou "movida" para "${SESSAO}"`);
  tudoOk &= ok(depois.movida.janelaId === antes.movida.janelaId && depois.movida.paneId === antes.movida.paneId,
    `@janela.%pane não mudaram no move (${depois.movida.janelaId}.${depois.movida.paneId})`);

  // ─── os arquivos do CLI e o /proc de mentira ──────────────────────────────
  const inicio = (pid) => 1000000 + pid;
  for (const nome of ['movida', 'orfa', 'fica']) plantarAgenteFalso(depois[nome].panePid, inicio(depois[nome].panePid));
  // Caso 1: a aba movida, arquivo com a sessão VELHA.
  escreverSessao({ pid: depois.movida.panePid, tmux: tmuxAoNascer, sessaoId: 'sess-movida',
    cwd: '/home/gate/projetos/movida', starttime: inicio(depois.movida.panePid) });
  // Caso 2 (negativo): arquivo com @janela.%pane de OUTRA pane — nunca pode casar.
  escreverSessao({ pid: depois.orfa.panePid, tmux: `${SESSAO}:@999.%999`, sessaoId: 'sess-orfa',
    cwd: '/home/gate/projetos/orfa', starttime: inicio(depois.orfa.panePid) });
  // Controle: aba que não se moveu, chave como sempre foi.
  escreverSessao({ pid: depois.fica.panePid, tmux: `${SESSAO}:${depois.fica.janelaId}.${depois.fica.paneId}`,
    sessaoId: 'sess-fica', cwd: '/home/gate/projetos/fica', starttime: inicio(depois.fica.panePid) });

  const ambiente = {
    COCKPIT_TMUX_SOCKET: SOCKET,
    COCKPIT_TMUX_SESSAO: SESSAO,
    COCKPIT_PROC_RAIZ: raizProc,
    COCKPIT_BIN_CLAUDE: '/bin/true',
    COCKPIT_VIGIA_MS: '0',
    HOME: home,
  };
  Object.assign(process.env, ambiente);
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'abas.js'))];
  const abas = require(path.join(__dirname, '..', 'lib', 'abas.js'));

  // ─── caso 3: unitário — a chave não carrega sessão ────────────────────────
  const vivas = await abas.sessoesDoCli();
  const chaves = [...vivas.keys()];
  tudoOk &= ok(chaves.length === 3, `sessoesDoCli() indexou as 3 sessões (${chaves.join(', ')})`);
  tudoOk &= ok(chaves.every((c) => /^@\d+\.%\d+$/.test(c)), 'toda chave é "@janela.%pane", sem nome de sessão');
  tudoOk &= ok(vivas.get(`${depois.movida.janelaId}.${depois.movida.paneId}`)?.sessaoId === 'sess-movida',
    'a pane movida é achada pela chave sem sessão');

  // ─── casos 1 e 2: listar() ─────────────────────────────────────────────────
  const lista = await abas.listar();
  const porTitulo = Object.fromEntries(lista.map((a) => [a.titulo, a]));
  const movida = porTitulo.movida;
  const orfa = porTitulo.orfa;
  const fica = porTitulo.fica;
  tudoOk &= ok(movida && movida.agente === 'claude', 'aba "movida" tem claude detectado');
  tudoOk &= ok(movida && movida.sessaoId === 'sess-movida', `aba "movida" casou a conversa (sessaoId=${movida?.sessaoId})`);
  tudoOk &= ok(movida && movida.preSessao === false, `aba "movida" NÃO está em preSessao (preSessao=${movida?.preSessao})`);
  tudoOk &= ok(movida && movida.arquivo && movida.arquivo.endsWith('sess-movida.jsonl'), 'aba "movida" aponta para o .jsonl certo');
  tudoOk &= ok(orfa && orfa.agente === 'claude' && orfa.sessaoId === null && orfa.preSessao === true,
    `negativo: @janela.%pane diferente continua sem casar (sessaoId=${orfa?.sessaoId}, preSessao=${orfa?.preSessao})`);
  tudoOk &= ok(fica && fica.sessaoId === 'sess-fica' && fica.preSessao === false, 'controle: aba que não se moveu segue casando');

  // ─── caso 4: a rota, numa instância de gate ───────────────────────────────
  servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, ...ambiente,
      PORT: String(PORTA), HOST: '127.0.0.1', COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TOKEN: '',
      COCKPIT_JOBS_DIR: path.join(scratch, 'sem-jobs'),
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
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
  tudoOk &= ok(resposta && resposta.status === 200, `GET /api/abas respondeu na porta ${PORTA}`);
  const daRota = resposta?.json?.abas?.find((a) => a.titulo === 'movida');
  tudoOk &= ok(daRota && daRota.sessaoId === 'sess-movida' && daRota.preSessao === false,
    `na rota: movida → sessaoId=${daRota?.sessaoId} preSessao=${daRota?.preSessao}`);
  if (daRota) console.log(`  ↳ /api/abas (movida): ${JSON.stringify({ titulo: daRota.titulo, sessao: daRota.sessao, sessaoId: daRota.sessaoId, preSessao: daRota.preSessao })}`);

  return Boolean(tudoOk);
}

rodar().then((tudoOk) => {
  const limpo = limpar();
  tudoOk = tudoOk && limpo;
  console.log(`\n${tudoOk ? '✅ GATE VERDE' : '❌ GATE VERMELHO'} — aba movida de sessão\n`);
  process.exit(tudoOk ? 0 : 1);
}).catch((e) => {
  limpar();
  console.error('\n❌ o gate quebrou:', e.message, '\n');
  process.exit(1);
});
