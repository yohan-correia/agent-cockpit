#!/usr/bin/env node
'use strict';
// GATE DA RETOMADA DO CLAUDE DEPOIS DO REBOOT — o `bin/retoma-claude.js` salva o sessionId de cada
// pane da `main` que roda claude e, no restore do tmux-resurrect, digita `claude --resume <id>`
// na pane que o restore recriou. Digitar numa pane errada é a pior falha possível aqui (rascunho
// perdido, conversa trocada, claude aberto num servidor que o dono não vê), então este gate roda
// o script REAL contra tmux REAL e falha alto se uma tecla cair onde não devia.
//
// Isolamento (inegociável):
//   - NUNCA o `save.sh`/`restore.sh` do resurrect: só o script do cockpit.
//   - tmux só em `-L cockpit-smoke-retoma-<pid>-<x>` e `-f /dev/null` (sem o `-f`, o servidor novo
//     lê o ~/.tmux.conf real e o `@continuum-restore` clona as sessões do dono — armadilha
//     medida em 06/10/2026). Aborta se herdar COCKPIT_TMUX_SOCKET fora do padrão de teste, e se o
//     arquivo do socket que vai criar já existir ("não é meu").
//   - HOME falso (mkdtemp), XDG_DATA_HOME removido (ele VENCE o HOME no caminho padrão do
//     resurrect), COCKPIT_RETOMA_ARQUIVO dentro do temp.
//   - `claude` falso no começo do PATH do servidor isolado: registra TMUX_PANE, PWD e argumentos
//     num arquivo e fica de pé (`exec sleep 600`).
//
// O `restaurar` roda como filho de um PAI DE ESPERA (bash que aguarda um arquivo `go`): o pai
// nasce, o gate cria as panes "do restore" e só então libera. É o mesmo arranjo do restore.sh
// real (o script roda por `eval` dentro do restore, mais velho que as panes que ele cria) e é o
// que permite o caso da pane ANTIGA.
//
// Toda chamada do script tem stdout e stderr capturados e afirmados VAZIOS (a saída do gancho
// aparece na tela do dono no restore) — exceto `instalar`, que existe para imprimir.
//
// Casos: 1 salvar · 1b layout mudou depois do dump · 2 restore num socket novo · 3 pane antiga ·
// 3b pane que vira shell depois · 4 cwd divergente · 5 pane não-shell · 6 pane ausente · 6b mesmo id em duas entradas · 7 id vivo ·
// 8 id malicioso e sessão alheia · 9 snapshot diverge · 9b sem snapshot · 10 arquivo ausente/
// corrompido · 11 servidor não-padrão · 12 salvar sem servidor · 13 instalar.
//
// Uso:  node testes/gate-retoma-claude.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

let acertos = 0;
let falhas = 0;
const ok = (c, t) => {
  const bom = Boolean(c);
  console.log(`  ${bom ? '✅' : '❌'} ${t}`);
  if (bom) acertos++; else falhas++;
  return bom;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function aguardar(fn, ms = 3000) {
  const fim = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= fim) return null;
    await espera(50);
  }
}

const RETOMA = path.join(__dirname, '..', 'bin', 'retoma-claude.js');
const UID = process.getuid();
const DIR_SOCKETS = path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${UID}`);
const PREFIXO = `cockpit-smoke-retoma-${process.pid}`;
const NOME_HOSTIL = 'a;b #{session_name} x;';
const BASH = ['bash', '--norc', '--noprofile'];

const herdado = process.env.COCKPIT_TMUX_SOCKET || '';
if (herdado && !/^cockpit-(smoke|offline)-/.test(herdado)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${herdado}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

const TEMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-retoma-')));
const HOME = path.join(TEMP, 'home');
const BIN = path.join(TEMP, 'bin');
const RESURRECT = path.join(TEMP, 'resurrect');
const P = {};
for (const n of ['a', 'b', 'c', 'd', 'e']) P[n] = path.join(TEMP, `proj-${n}`);
for (const d of [HOME, BIN, RESURRECT, ...Object.values(P)]) fs.mkdirSync(d, { recursive: true });
const ARQUIVO = path.join(RESURRECT, 'cockpit-retoma-claude.json');
const LOG = path.join(RESURRECT, 'cockpit-retoma-claude.log');
fs.writeFileSync(path.join(BIN, 'claude'),
  '#!/bin/sh\nprintf \'%s\\t%s\\t%s\\n\' "$TMUX_PANE" "$PWD" "$*" >> "$CLAUDE_FALSO_LOG"\nexec sleep 600\n', { mode: 0o755 });
fs.chmodSync(path.join(BIN, 'claude'), 0o755);

const sockets = [];
const soltos = [];       // processos que o gate lançou fora do tmux (pai de espera, sleep do caso 7)
const pidsDeClaude = []; // pids dos claudes falsos (para esperar o "reboot" levá-los)
let seq = 0;

function abortar(msg) {
  console.error(msg);
  fs.rmSync(TEMP, { recursive: true, force: true });
  process.exit(1);
}

function envBase() {
  const e = { ...process.env };
  delete e.TMUX; delete e.TMUX_PANE; delete e.XDG_DATA_HOME;
  for (const k of Object.keys(e)) if (/^COCKPIT_/.test(k)) delete e[k];
  return e;
}
const envScript = (extra = {}) => ({
  ...envBase(), HOME, COCKPIT_RETOMA_ARQUIVO: ARQUIVO, COCKPIT_TMUX_SESSAO: 'main', ...extra,
});

function camposDoStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const corte = stat.lastIndexOf(')');
    if (corte < 0) return null;
    return stat.slice(corte + 2).split(' ');
  } catch { return null; }
}
const procStart = (pid) => { const c = camposDoStat(pid); return c ? Number(c[19]) : null; };
const morto = (pid) => { const c = camposDoStat(pid); return !c || c[0] === 'Z'; };
function filhoDe(pid) {
  const out = [];
  try {
    const dir = `/proc/${pid}/task`;
    for (const tid of fs.readdirSync(dir)) {
      const txt = fs.readFileSync(`${dir}/${tid}/children`, 'utf8').trim();
      if (txt) out.push(...txt.split(/\s+/).map(Number));
    }
  } catch { /* processo sumiu */ }
  return out;
}

// ---- tmux isolado -----------------------------------------------------------------------------

function tmuxDe(nome, env) {
  return (args, { tolerante = false } = {}) => {
    try {
      return execFileSync('tmux', ['-L', nome, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (e) {
      if (tolerante) return '';
      throw e;
    }
  };
}

function iniciarServidor(letra) {
  const nome = `${PREFIXO}-${letra}${++seq}`;
  if (fs.existsSync(path.join(DIR_SOCKETS, nome))) abortar(`🔴 o socket ${nome} JÁ EXISTE — não é meu. Abortando.`);
  sockets.push(nome);
  const logClaude = path.join(TEMP, `claude-${seq}.log`);
  const env = { ...envBase(), PATH: `${BIN}:${process.env.PATH}`, HOME, CLAUDE_FALSO_LOG: logClaude };
  execFileSync('tmux', ['-L', nome, '-f', '/dev/null', 'new-session', '-d', '-s', 'ancora', '-x', '200', '-y', '50', 'sleep', '600'],
    { env, stdio: 'ignore' });
  const t = tmuxDe(nome, env);
  t(['set', '-g', 'base-index', '1']);
  t(['setw', '-g', 'pane-base-index', '1']);
  return { nome, t, logClaude };
}

function matar(nome) {
  if (!sockets.includes(nome)) return;
  try { execFileSync('tmux', ['-L', nome, 'kill-server'], { stdio: 'ignore', env: envBase() }); } catch { /* já morto */ }
  // O tmux não apaga o arquivo do socket no `kill-server`; só o meu.
  try { fs.rmSync(path.join(DIR_SOCKETS, nome), { force: true }); } catch { /* ok */ }
}

const sessao = (s, nome, cwd, cmd = BASH) => s.t(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', nome, '-x', '200', '-y', '50', '-c', cwd, ...cmd]).trim();
const janela = (s, alvo, cwd, cmd = BASH) => s.t(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', alvo, '-c', cwd, ...cmd]).trim();
const divide = (s, alvo, cwd, cmd = BASH) => s.t(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', alvo, '-c', cwd, ...cmd]).trim();
const panePid = (s, id) => Number(s.t(['display-message', '-p', '-t', id, '#{pane_pid}']).trim());
function digita(s, id, txt) {
  s.t(['send-keys', '-t', id, '-l', txt]);
  s.t(['send-keys', '-t', id, 'Enter']);
}
async function iniciarClaude(s, id, comando = 'claude') {
  const pp = panePid(s, id);
  digita(s, id, comando);
  const pid = await aguardar(() => filhoDe(pp)[0], 3000);
  if (pid) pidsDeClaude.push(pid);
  return { panePid: pp, pid };
}
function mapaPos(s) {
  const mapa = {};
  for (const l of s.t(['list-panes', '-a', '-F', '#{pane_id} #{session_name}:#{window_index}.#{pane_index}']).split('\n').filter(Boolean)) {
    const [id, pos] = l.split(' ');
    mapa[id] = pos;
  }
  return mapa;
}
function textoTodo(s) {
  return Object.keys(mapaPos(s)).map((id) => s.t(['capture-pane', '-p', '-t', id], { tolerante: true })).join('\n');
}
function lerClaude(s) {
  let txt = '';
  try { txt = fs.readFileSync(s.logClaude, 'utf8'); } catch { /* nada registrado */ }
  return txt.split('\n').filter(Boolean).map((l) => { const [pane, pwd, args] = l.split('\t'); return { pane, pwd, args }; });
}

// ---- a pasta de estado do claude e do resurrect (falsas) ---------------------------------------

function plantarSessao({ pid, sessionId, cwd, kind = 'interactive', updatedAt = Date.now() }) {
  const raiz = path.join(HOME, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  // `tmux` velho de propósito: o campo envelhece (move-window) e o script nunca pode lê-lo.
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    pid, sessionId, cwd, procStart: procStart(pid), kind, tmux: 'job-velho:@9.%9', updatedAt,
  }));
}
function plantarFita(cwd, id) {
  const arq = path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, '{}\n');
}
function escreverSnapshot(s, nome = 'snap-1.txt', ajuste = {}) {
  // Separador `:` e não TAB: o tmux troca TAB por `_` quando o cliente não tem locale UTF-8.
  const linhas = s.t(['list-panes', '-a', '-F', '#{session_name}:#{window_index}:#{pane_index}:#{pane_current_path}'])
    .split('\n').filter(Boolean).map((l) => {
      const [se, j, p, ...resto] = l.split(':');
      const dir = ajuste[`${se}:${j}.${p}`] || resto.join(':');
      return ['pane', se, j, '1', ':*', p, 'titulo', `:${dir}`, '1', 'claude', ':claude'].join('\t');
    });
  fs.writeFileSync(path.join(RESURRECT, nome), `${linhas.join('\n')}\n`);
}
function apontarLast(alvo) {
  const l = path.join(RESURRECT, 'last');
  fs.rmSync(l, { force: true });
  if (alvo) fs.symlinkSync(alvo, l);
}
const entrada = (janelaN, pane, cwd, sessionId, nome = null, sessaoNome = 'main') => ({ sessao: sessaoNome, janela: janelaN, pane, cwd, sessionId, nome });
const estadoDe = (panes, snapshot = 'snap-1.txt') => ({ versao: 1, salvoEm: new Date().toISOString(), sessao: 'main', snapshot, panes });
let marcaLog = 0;
function logNovo() {
  let txt = '';
  try { txt = fs.readFileSync(LOG, 'utf8'); } catch { /* sem log ainda */ }
  const novo = txt.slice(marcaLog);
  marcaLog = txt.length;
  return novo;
}

// ---- rodar o script -----------------------------------------------------------------------------

function rodar(cmd, env, rotulo) {
  const r = spawnSync(process.execPath, [RETOMA, cmd], { env, encoding: 'utf8', timeout: 30000 });
  ok(r.status === 0, `${rotulo}: exit 0 (veio ${r.status})`);
  if (cmd !== 'instalar') {
    ok(r.stdout === '', `${rotulo}: stdout vazio`);
    ok(r.stderr === '', `${rotulo}: stderr vazio${r.stderr ? ` — "${r.stderr.trim().split('\n')[0]}"` : ''}`);
  }
  return r;
}

let paiSeq = 0;
function restaurarComPai(env) {
  const base = path.join(TEMP, `pai-${++paiSeq}`);
  fs.mkdirSync(base);
  const GO = path.join(base, 'go');
  const RC = path.join(base, 'rc');
  const OUT = path.join(base, 'out');
  const ERR = path.join(base, 'err');
  // O `echo` depois do node impede o bash de dar `exec` nele: o ppid do script TEM de ser este bash.
  const filho = spawn('bash', ['-c',
    'while [ ! -e "$GO" ]; do sleep 0.05; done; "$NODE" "$RETOMA" restaurar >"$OUT" 2>"$ERR"; echo $? >"$RC.tmp"; mv "$RC.tmp" "$RC"'],
  { env: { ...env, GO, RC, OUT, ERR, NODE: process.execPath, RETOMA }, stdio: 'ignore' });
  soltos.push(filho);
  const ler = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  return {
    pid: filho.pid,
    go: () => fs.writeFileSync(GO, ''),
    esperar: async () => {
      const achou = await aguardar(() => fs.existsSync(RC), 30000);
      return achou ? Number(ler(RC)) : null;
    },
    saida: () => ler(OUT),
    erro: () => ler(ERR),
    matar: () => { try { filho.kill('SIGTERM'); } catch { /* já foi */ } },
  };
}

/** Um servidor novo + pai de espera + as panes "do restore" + go. `antes` cria panes ANTES do pai. */
async function cenario({ letra, antes, depois, estado, last = 'snap-1.txt', env, semSocket = false, esperaMs = 700 }) {
  logNovo();
  const s = iniciarServidor(letra);
  if (estado === 'ausente') fs.rmSync(ARQUIVO, { force: true });
  else if (estado === 'corrompido') fs.writeFileSync(ARQUIVO, '{isto nao e json');
  else if (estado) fs.writeFileSync(ARQUIVO, JSON.stringify(estado));
  apontarLast(last);
  const extra = { ...(semSocket ? {} : { COCKPIT_TMUX_SOCKET: s.nome }), ...(env ? env(s) : {}) };
  let ids = {};
  let antigas = [];
  if (antes) {
    const a = await antes(s);
    ids = { ...a.ids };
    antigas = a.pids;
    await espera(50);
  }
  let pai = restaurarComPai(envScript(extra));
  let precondicao = true;
  if (antes) {
    precondicao = false;
    // Ticks de 10 ms: no mesmo tick o `>=` da regra deixaria a pane passar e o caso ficaria
    // vermelho sem bug. Se empatar, mata o pai e nasce outro.
    for (let i = 0; i < 5 && !precondicao; i++) {
      const ini = procStart(pai.pid);
      if (antigas.every((p) => procStart(p) < ini)) { precondicao = true; break; }
      pai.matar();
      await espera(50);
      pai = restaurarComPai(envScript(extra));
    }
  }
  if (depois) ids = { ...ids, ...(await depois(s)) };
  pai.go();
  const rc = await pai.esperar();
  await espera(esperaMs);
  return {
    s, ids, rc, precondicao, saida: pai.saida(), erro: pai.erro(), log: logNovo(),
    claude: lerClaude(s), pos: mapaPos(s), texto: textoTodo(s), fechar: () => matar(s.nome),
  };
}

function semTecla(r, rotulo) {
  ok(r.rc === 0, `${rotulo}: restaurar saiu 0 (veio ${r.rc})`);
  ok(r.saida === '' && r.erro === '', `${rotulo}: restaurar mudo (stdout/stderr vazios)`);
  ok(r.claude.length === 0, `${rotulo}: nenhum claude foi aberto (${r.claude.map((l) => l.args).join(' | ') || '—'})`);
  ok(!r.texto.includes('--resume'), `${rotulo}: nenhuma pane recebeu "--resume"`);
}

async function caso(nome, fn) {
  console.log(`\n${nome}`);
  try { await fn(); } catch (e) { ok(false, `${nome}: exceção no gate — ${e.message}`); }
}

function limpar() {
  for (const nome of sockets) matar(nome);
  for (const proc of soltos) { try { proc.kill('SIGTERM'); } catch { /* já foi */ } }
  for (const pid of pidsDeClaude) { if (!morto(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* já foi */ } } }
  fs.rmSync(TEMP, { recursive: true, force: true });
}

const uuid = () => crypto.randomUUID();
const ID = { a: uuid(), b: uuid(), c: uuid(), print: uuid(), inter: uuid(), cinco: uuid(), z: uuid() };

async function main() {
  if (!fs.existsSync(RETOMA)) console.log('🔴 bin/retoma-claude.js ainda não existe — os casos abaixo vão falhar.');

  // ---- 1. salvar ------------------------------------------------------------------------------
  let s1 = null;
  await caso('1. salvar — só as panes da main com claude interativo, vivo, com fita e no cwd do snapshot', async () => {
    logNovo();
    s1 = iniciarServidor('a');
    const p11 = sessao(s1, 'main', P.a);
    const p12 = divide(s1, 'main:1', P.b);
    const p21 = janela(s1, 'main:2', P.c);
    const p31 = janela(s1, 'main:3', P.a);
    const p41 = janela(s1, 'main:4', P.d);
    const p51 = janela(s1, 'main:5', P.d);
    const p61 = janela(s1, 'main:6', P.a);
    const pz = sessao(s1, 'job-x', P.a);

    const c11 = await iniciarClaude(s1, p11);
    plantarSessao({ pid: c11.pid, sessionId: ID.a, cwd: P.a }); plantarFita(P.a, ID.a);
    s1.t(['set-option', '-p', '-t', p11, '--', '@cockpit-nome', NOME_HOSTIL.replace(/;$/, '\\;')]);
    const c12 = await iniciarClaude(s1, p12);
    plantarSessao({ pid: c12.pid, sessionId: ID.b, cwd: P.b }); plantarFita(P.b, ID.b);
    // 2.1: só bash (p21).
    const c31 = await iniciarClaude(s1, p31);                       // claude SEM fita
    plantarSessao({ pid: c31.pid, sessionId: ID.c, cwd: P.a });
    // 4.1: o `print` é o filho do shell (profundidade 1); o `interactive` é filho dele (2).
    // Sem o filtro de `kind`, o `print` venceria pela profundidade.
    const pp41 = panePid(s1, p41);
    digita(s1, p41, "sh -c 'sleep 600 & exec sleep 601'");
    const sh41 = await aguardar(() => filhoDe(pp41)[0], 3000);
    const fundo41 = await aguardar(() => filhoDe(sh41)[0], 3000);
    pidsDeClaude.push(sh41, fundo41);
    plantarSessao({ pid: sh41, sessionId: ID.print, cwd: P.d, kind: 'print' }); plantarFita(P.d, ID.print);
    plantarSessao({ pid: fundo41, sessionId: ID.inter, cwd: P.d, kind: 'interactive' }); plantarFita(P.d, ID.inter);
    // 5.1: nasceu em proj-d e o claude mudou para proj-e → pane_current_path ≠ cwd do JSON.
    const c51 = await iniciarClaude(s1, p51, `cd ${P.e} && claude`);
    plantarSessao({ pid: c51.pid, sessionId: ID.cinco, cwd: P.d }); plantarFita(P.d, ID.cinco);
    await aguardar(() => s1.t(['display-message', '-p', '-t', p51, '#{pane_current_path}']).trim() === P.e, 2000);
    // 6.1: sessionId que não é UUID.
    const c61 = await iniciarClaude(s1, p61);
    plantarSessao({ pid: c61.pid, sessionId: 'nao-e-um-uuid', cwd: P.a }); plantarFita(P.a, 'nao-e-um-uuid');
    // sessão alheia (job): nunca entra.
    const cz = await iniciarClaude(s1, pz);
    plantarSessao({ pid: cz.pid, sessionId: ID.z, cwd: P.a }); plantarFita(P.a, ID.z);
    void p21;

    escreverSnapshot(s1);
    apontarLast('snap-1.txt');
    rodar('salvar', envScript({ COCKPIT_TMUX_SOCKET: s1.nome }), 'salvar');
    const log = logNovo();
    const est = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    const chave = (p) => `${p.sessao}:${p.janela}.${p.pane}`;
    ok(JSON.stringify(est.panes.map(chave).sort()) === JSON.stringify(['main:1.1', 'main:1.2', 'main:4.1']),
      `panes salvas = 1.1, 1.2 e 4.1 (veio ${est.panes.map(chave).sort().join(', ')})`);
    const por = (k) => est.panes.find((p) => chave(p) === k) || {};
    ok(por('main:1.1').sessionId === ID.a && por('main:1.1').cwd === P.a, '1.1 com o id e o cwd certos');
    ok(por('main:1.1').nome === NOME_HOSTIL, `1.1 guarda o @cockpit-nome hostil idêntico (veio ${JSON.stringify(por('main:1.1').nome)})`);
    ok(por('main:1.2').sessionId === ID.b && por('main:1.2').nome === null, '1.2 com o id certo e sem nome (null)');
    ok(por('main:4.1').sessionId === ID.inter, '4.1 vale o claude `interactive` (o `print`, mais raso, não vence)');
    ok(est.versao === 1 && est.sessao === 'main' && est.snapshot === 'snap-1.txt', 'versao 1, sessao main, snapshot snap-1.txt');
    ok(!est.panes.some((p) => p.sessao !== 'main'), 'nada da sessão job-x');
    ok((fs.statSync(ARQUIVO).mode & 0o777) === 0o600, 'arquivo com modo 0600');
    ok(!fs.readdirSync(RESURRECT).some((f) => f.includes('.tmp')), 'nenhum .tmp sobrando');
    ok(log.includes('main:3.1') && log.includes('sem fita'), 'log cita a 3.1 sem fita');
    ok(log.includes('main:5.1') && log.includes('cwd diverge'), 'log cita a 5.1 com cwd diverge');
  });

  await caso('1b. layout mudou depois do dump do resurrect — a pane que não bate com o snapshot não é salva', async () => {
    logNovo();
    escreverSnapshot(s1, 'snap-1.txt', { 'main:1.2': P.c });
    rodar('salvar', envScript({ COCKPIT_TMUX_SOCKET: s1.nome }), 'salvar (snapshot dizendo que a 1.2 está em proj-c)');
    const log = logNovo();
    const est = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    const ks = est.panes.map((p) => `${p.sessao}:${p.janela}.${p.pane}`).sort();
    ok(JSON.stringify(ks) === JSON.stringify(['main:1.1', 'main:4.1']), `grava 1.1 e 4.1, não a 1.2 (veio ${ks.join(', ')})`);
    ok(log.includes('posição diverge do snapshot'), 'log: posição diverge do snapshot');
    escreverSnapshot(s1);                     // volta coerente: o caso 2 parte deste estado
    rodar('salvar', envScript({ COCKPIT_TMUX_SOCKET: s1.nome }), 'salvar (snapshot coerente de novo)');
    logNovo();
  });

  // ---- 2. restore num socket novo (o "reboot") --------------------------------------------------
  await caso('2. restore num servidor novo — cada pane volta com a sua conversa', async () => {
    matar(s1.nome);                           // o "reboot": o primeiro servidor morre
    const levou = await aguardar(() => pidsDeClaude.every(morto), 3000);
    ok(levou, 'os claudes falsos do servidor antigo morreram com ele');
    const r = await cenario({
      letra: 'b',
      depois: async (s) => ({
        p11: sessao(s, 'main', P.a), p12: divide(s, 'main:1', P.b), p21: janela(s, 'main:2', P.c), p41: janela(s, 'main:4', P.d),
      }),
    });
    ok(r.rc === 0 && r.saida === '' && r.erro === '', 'restaurar saiu 0 e mudo');
    await espera(800);                        // o claude falso escreve depois do Enter
    const linhas = lerClaude(r.s);
    const da = (id) => linhas.filter((l) => l.pane === id);
    ok(da(r.ids.p11).length === 1 && da(r.ids.p11)[0].args === `--resume ${ID.a}` && da(r.ids.p11)[0].pwd === P.a, '1.1 → --resume idA no proj-a');
    ok(da(r.ids.p12).length === 1 && da(r.ids.p12)[0].args === `--resume ${ID.b}` && da(r.ids.p12)[0].pwd === P.b, '1.2 → --resume idB no proj-b');
    ok(da(r.ids.p41).length === 1 && da(r.ids.p41)[0].args === `--resume ${ID.inter}` && da(r.ids.p41)[0].pwd === P.d, '4.1 → --resume do `interactive` no proj-d');
    ok(da(r.ids.p21).length === 0 && linhas.length === 3, 'nenhum registro da janela 2 (só 3 claudes no total)');
    const nome11 = r.s.t(['show-options', '-pqv', '-t', r.ids.p11, '@cockpit-nome']).replace(/\n$/, '');
    ok(nome11 === NOME_HOSTIL, `@cockpit-nome da 1.1 reaplicado idêntico (veio ${JSON.stringify(nome11)})`);
    ok(r.s.t(['show-options', '-pqv', '-t', r.ids.p12, '@cockpit-nome']).trim() === '', '1.2 sem nome');
    ok(r.log.includes('retomou main:1.1'), 'log: retomou main:1.1');
    r.fechar();
  });

  // ---- 3. pane antiga ---------------------------------------------------------------------------
  await caso('3. pane ANTIGA (criada antes do restore) — nunca recebe tecla', async () => {
    const r = await cenario({
      letra: 'c',
      estado: estadoDe([entrada(1, 1, P.a, ID.a)]),
      antes: async (s) => { const p = sessao(s, 'main', P.a); return { ids: { p11: p }, pids: [panePid(s, p)] }; },
    });
    ok(r.precondicao, 'precondição: o shell da pane nasceu ANTES do pai de espera');
    semTecla(r, 'pane antiga');
    ok(r.log.includes('pane anterior ao restore'), 'log: pane anterior ao restore');
    r.fechar();
  });

  await caso('3b. o laço de espera — pane criada depois do pai que só vira shell 1 s depois recebe a retomada', async () => {
    const r = await cenario({
      letra: 'd',
      estado: estadoDe([entrada(1, 1, P.a, ID.a)]),
      depois: async (s) => ({ p11: sessao(s, 'main', P.a, ['sh', '-c', 'sleep 1; exec bash --norc --noprofile']) }),
    });
    await aguardar(() => lerClaude(r.s).length > 0, 3000);
    const linhas = lerClaude(r.s);
    ok(r.rc === 0 && r.saida === '' && r.erro === '', 'restaurar saiu 0 e mudo');
    ok(linhas.length === 1 && linhas[0].pane === r.ids.p11 && linhas[0].args === `--resume ${ID.a}`, 'esperou a pane virar shell e retomou nela');
    r.fechar();
  });

  // ---- 4-8 --------------------------------------------------------------------------------------
  await caso('4. cwd divergente — nada digitado', async () => {
    const r = await cenario({
      letra: 'e',
      estado: estadoDe([entrada(1, 1, P.a, ID.a)]),
      depois: async (s) => ({ p11: sessao(s, 'main', P.b) }),
    });
    semTecla(r, 'cwd divergente');
    ok(r.log.includes('cwd diverge'), 'log: cwd diverge');
    r.fechar();
  });

  await caso('5. pane que não roda shell — pulada, o resto segue', async () => {
    const r = await cenario({
      letra: 'f',
      estado: estadoDe([entrada(1, 1, P.a, ID.a), entrada(2, 1, P.b, ID.b)]),
      depois: async (s) => ({ p11: sessao(s, 'main', P.a, ['sleep', '600']), p21: janela(s, 'main:2', P.b) }),
      esperaMs: 900,
    });
    ok(r.rc === 0 && r.saida === '' && r.erro === '', 'restaurar saiu 0 e mudo');
    ok(r.claude.length === 1 && r.claude[0].pane === r.ids.p21 && r.claude[0].args === `--resume ${ID.b}`, 'só a 2.1 (shell) foi retomada');
    ok(!r.texto.includes(ID.a), 'a pane que roda sleep não recebeu o id');
    ok(r.log.includes('main:1.1') && r.log.includes('pane não roda shell'), 'log: 1.1 pulada por não rodar shell');
    r.fechar();
  });

  await caso('6. pane ausente (janela 9) — pulada, o resto segue', async () => {
    const r = await cenario({
      letra: 'g',
      estado: estadoDe([entrada(1, 1, P.a, ID.a), entrada(9, 1, P.b, ID.b)]),
      depois: async (s) => ({ p11: sessao(s, 'main', P.a) }),
      esperaMs: 900,
    });
    ok(r.rc === 0 && r.saida === '' && r.erro === '', 'restaurar saiu 0 e mudo');
    ok(r.claude.length === 1 && r.claude[0].pane === r.ids.p11 && r.claude[0].args === `--resume ${ID.a}`, 'a 1.1 foi retomada');
    ok(r.log.includes('main:9.1') && r.log.includes('pane ausente'), 'log: 9.1 pane ausente');
    r.fechar();
  });

  // Achado do painel de execução (Codex, 07/10): `vivas` é lida UMA vez antes do laço, então duas
  // entradas com o mesmo id abriam a mesma conversa em duas panes (a #1).
  await caso('6b. mesmo id em duas entradas — só a primeira pane é retomada', async () => {
    const r = await cenario({
      letra: 'p',
      estado: estadoDe([entrada(1, 1, P.a, ID.a), entrada(1, 2, P.a, ID.a)]),
      depois: async (s) => { const p11 = sessao(s, 'main', P.a); return { p11, p12: divide(s, p11, P.a) }; },
      esperaMs: 900,
    });
    ok(r.rc === 0 && r.saida === '' && r.erro === '', 'restaurar saiu 0 e mudo');
    ok(r.claude.length === 1 && r.claude[0].pane === r.ids.p11 && r.claude[0].args === `--resume ${ID.a}`,
      `um --resume só, na 1.1 (${r.claude.map((l) => `${r.pos[l.pane]} ${l.args}`).join(' | ') || '—'})`);
    ok(r.log.includes('main:1.2') && r.log.includes('id já retomado'), 'log: 1.2 id já retomado');
    r.fechar();
  });

  await caso('7. id vivo em outro processo — pulado', async () => {
    const viva = spawn('sleep', ['600'], { stdio: 'ignore' });
    soltos.push(viva);
    plantarSessao({ pid: viva.pid, sessionId: ID.a, cwd: P.a });
    const r = await cenario({
      letra: 'h',
      estado: estadoDe([entrada(1, 1, P.a, ID.a)]),
      depois: async (s) => ({ p11: sessao(s, 'main', P.a) }),
    });
    semTecla(r, 'id vivo');
    ok(r.log.includes('id vivo em outro processo'), 'log: id vivo em outro processo');
    r.fechar();
    viva.kill('SIGTERM');
    fs.rmSync(path.join(HOME, '.claude', 'sessions', `${viva.pid}.json`), { force: true });
  });

  await caso('8. id malicioso e sessão alheia — pulados, nenhum comando roda', async () => {
    const PWNED = path.join(TEMP, 'PWNED');
    const r = await cenario({
      letra: 'i',
      estado: estadoDe([
        entrada(1, 1, P.a, `x; touch ${PWNED}`),
        entrada(1, 1, P.a, ID.b, null, 'job-x'),
      ]),
      depois: async (s) => ({ p11: sessao(s, 'main', P.a), pz: sessao(s, 'job-x', P.a) }),
    });
    semTecla(r, 'id malicioso / sessão alheia');
    ok(!fs.existsSync(PWNED), 'o arquivo PWNED não existe');
    ok(r.log.includes('entrada inválida'), 'log: entrada inválida');
    r.fechar();
  });

  // ---- 9. snapshot ------------------------------------------------------------------------------
  await caso('9. snapshot diverge (`last` aponta para outro) — nada digitado', async () => {
    fs.writeFileSync(path.join(RESURRECT, 'snap-2.txt'), '');
    const r = await cenario({
      letra: 'j',
      estado: estadoDe([entrada(1, 1, P.a, ID.a)]),
      last: 'snap-2.txt',
      depois: async (s) => ({ p11: sessao(s, 'main', P.a) }),
    });
    semTecla(r, 'snapshot diverge');
    ok(r.log.includes('snapshot diverge'), 'log: snapshot diverge');
    r.fechar();
  });

  await caso('9b. sem snapshot (`snapshot: null` e `last` ausente) — nada digitado', async () => {
    const r = await cenario({
      letra: 'k',
      estado: estadoDe([entrada(1, 1, P.a, ID.a)], null),
      last: null,
      depois: async (s) => ({ p11: sessao(s, 'main', P.a) }),
    });
    semTecla(r, 'sem snapshot');
    ok(r.log.includes('sem snapshot'), 'log: sem snapshot');
    r.fechar();
  });

  // ---- 10. arquivo ausente / corrompido -----------------------------------------------------------
  for (const [letra, modo] of [['l', 'ausente'], ['m', 'corrompido']]) {
    await caso(`10. arquivo ${modo} — exit 0, mudo, nenhuma tecla`, async () => {
      const r = await cenario({
        letra,
        estado: modo,
        depois: async (s) => ({ p11: sessao(s, 'main', P.a) }),
      });
      semTecla(r, `arquivo ${modo}`);
      r.fechar();
    });
  }

  // ---- 11. servidor não-padrão --------------------------------------------------------------------
  await caso('11. servidor não-padrão ($TMUX num socket que não é o default, sem COCKPIT_TMUX_SOCKET)', async () => {
    const s = iniciarServidor('n');
    sessao(s, 'main', P.a);
    const anterior = Buffer.from(JSON.stringify(estadoDe([entrada(1, 1, P.a, ID.a)])));
    fs.writeFileSync(ARQUIVO, anterior);
    logNovo();
    rodar('salvar', envScript({ TMUX: `${path.join(DIR_SOCKETS, s.nome)},0,0` }), 'salvar em servidor não-padrão');
    ok(Buffer.compare(fs.readFileSync(ARQUIVO), anterior) === 0, 'salvar: o arquivo anterior ficou byte a byte igual');
    ok(logNovo().includes('servidor não é o padrão'), 'salvar: log servidor não é o padrão');
    matar(s.nome);
    const r = await cenario({
      letra: 'o',
      estado: estadoDe([entrada(1, 1, P.a, ID.a)]),
      semSocket: true,
      env: (sv) => ({ TMUX: `${path.join(DIR_SOCKETS, sv.nome)},0,0` }),
      depois: async (sv) => ({ p11: sessao(sv, 'main', P.a) }),
    });
    semTecla(r, 'restaurar em servidor não-padrão');
    ok(r.log.includes('servidor não é o padrão'), 'restaurar: log servidor não é o padrão');
    r.fechar();
  });

  // ---- 12. salvar sem servidor --------------------------------------------------------------------
  await caso('12. salvar sem servidor tmux — não sobrescreve o arquivo anterior', async () => {
    const anterior = Buffer.from(JSON.stringify(estadoDe([entrada(1, 1, P.a, ID.a)])));
    fs.writeFileSync(ARQUIVO, anterior);
    const inexistente = `cockpit-smoke-retoma-inexistente-${process.pid}`;
    if (fs.existsSync(path.join(DIR_SOCKETS, inexistente))) abortar(`🔴 o socket ${inexistente} existe — não é meu.`);
    rodar('salvar', envScript({ COCKPIT_TMUX_SOCKET: inexistente }), 'salvar sem servidor');
    ok(Buffer.compare(fs.readFileSync(ARQUIVO), anterior) === 0, 'o arquivo anterior ficou intacto');
  });

  // ---- 13. instalar -------------------------------------------------------------------------------
  await caso('13. instalar — cópia estável e as duas linhas do tmux.conf', async () => {
    const destino = path.join(TEMP, 'inst', 'retoma-claude.js');
    const r = rodar('instalar', envScript({ COCKPIT_RETOMA_DESTINO: destino }), 'instalar');
    ok(fs.existsSync(destino) && Buffer.compare(fs.readFileSync(destino), fs.readFileSync(RETOMA)) === 0, 'cópia byte a byte igual ao bin/retoma-claude.js');
    ok(r.stdout.includes(`set -g @resurrect-hook-post-save-all '${process.execPath} ${destino} salvar'`), 'imprime a linha do post-save-all com node e destino absolutos');
    ok(r.stdout.includes(`set -g @resurrect-hook-post-restore-all '${process.execPath} ${destino} restaurar'`), 'imprime a linha do post-restore-all com node e destino absolutos');
    ok(!fs.existsSync(path.join(HOME, '.tmux.conf')), '~/.tmux.conf do HOME falso não foi criado');
  });
}

main().catch((e) => { ok(false, `exceção fora dos casos — ${e.stack || e.message}`); }).finally(() => {
  limpar();
  let sobrando = 0;
  try { sobrando = fs.readdirSync(DIR_SOCKETS).filter((f) => f.startsWith(PREFIXO)).length; } catch { /* sem pasta */ }
  console.log(`\n${acertos} ✅  ${falhas} ❌  (sockets deste gate sobrando: ${sobrando})`);
  if (falhas || sobrando) process.exitCode = 1;
});
