#!/usr/bin/env node
'use strict';
// RETOMA-CLAUDE — depois de um reboot, cada pane da sessão `main` que tinha Claude Code volta com a
// MESMA conversa. O tmux-resurrect devolve as panes com shell puro (e anota `claude --resume` sem
// id no snapshot); este script guarda o sessionId por fora e o digita de volta.
//
// Três comandos, um arquivo, zero `require` do repo (só `node:*`): a cópia instalada vive sozinha
// num caminho estável, sem `lib/` ao lado.
//   salvar     gancho `@resurrect-hook-post-save-all`    → grava o estado (posição, cwd, id, nome)
//   restaurar  gancho `@resurrect-hook-post-restore-all` → digita `claude --resume <id>` nas panes
//   instalar   à mão, no deploy                          → copia o script e imprime as linhas do tmux.conf
//
// `salvar` e `restaurar` são MUDOS (nada em stdout/stderr) e saem sempre com 0: a saída do gancho
// aparece na tela do dono no restore, e um erro aqui nunca pode quebrar o save/restore do
// resurrect. O que há para dizer vai para o log ao lado dos snapshots.
//
// A regra de ouro: só se digita numa pane do servidor padrão, da sessão `main`, que ESTE restore
// criou, que existe na posição salva, roda shell, está no cwd salvo, com o snapshot casando — e o
// texto é `claude --resume` + um UUID validado de uma sessão que não está aberta em outro processo.
// Em qualquer outro caso não se digita nada.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// ---- configuração (lida em tempo de chamada: o gate troca o ambiente entre os casos) -----------

const PREFIXO_TESTE = /^cockpit-(smoke|offline)-/;
const socket = () => process.env.COCKPIT_TMUX_SOCKET || '';
const sessaoAlvo = () => process.env.COCKPIT_TMUX_SESSAO || 'main';
const arquivoEstado = () => process.env.COCKPIT_RETOMA_ARQUIVO
  || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'tmux', 'resurrect', 'cockpit-retoma-claude.json');
const destinoInstalacao = () => process.env.COCKPIT_RETOMA_DESTINO
  || path.join(os.homedir(), '.local', 'share', 'cockpit-agentes', 'tmux', 'retoma-claude.js');
const raizSessoes = () => path.join(os.homedir(), '.claude', 'sessions');
const raizProjetos = () => path.join(os.homedir(), '.claude', 'projects');

// O id vai para o teclado da pane: só entra string que casa o formato de UUID, no save E no
// restore (o arquivo em disco pode ter sido editado).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- tmux -------------------------------------------------------------------------------------

/**
 * `tmux` por execFile (sem shell), timeout de 5 s, nunca rejeita.
 *
 * LC_ALL=C.UTF-8: o servidor do tmux no boot pode não ter LANG, e um cliente fora de UTF-8 recebe a
 * saída com todo caractere de controle e todo não-ASCII trocado por `_` (medido: caminho com
 * acento viraria outro caminho e a pane seria pulada por `cwd`). Por isso, também, os campos do
 * `-F` são separados por `:` — que o tmux troca por `_` no nome de sessão — e não por TAB.
 */
function tmux(args) {
  return new Promise((resolve) => {
    const s = socket();
    const env = { ...process.env, LC_ALL: 'C.UTF-8' };
    execFile('tmux', s ? ['-L', s, ...args] : args, { timeout: 5000, encoding: 'utf8', env }, (err, stdout) => {
      resolve({ ok: !err, saida: err ? '' : stdout });
    });
  });
}

/**
 * Este processo fala com o servidor PADRÃO do tmux? Um servidor clone (`tmux -S/-L` novo lê o
 * ~/.tmux.conf real e roda o resurrect de novo) gravaria a lista dele — vazia — por cima da do
 * dono, ou abriria as conversas num servidor que ele não vê. Com COCKPIT_TMUX_SOCKET (só o gate)
 * a escolha é explícita e a trava não se aplica.
 */
function servidorEhPadrao() {
  if (socket()) return true;
  const caminho = (process.env.TMUX || '').split(',')[0];
  if (!caminho) return true;
  return caminho === path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, 'default');
}

// ---- /proc ------------------------------------------------------------------------------------

/** Os campos do `/proc/<pid>/stat` DEPOIS do nome do executável. Índice 0 = campo 3. */
function camposDoStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // O nome vem entre parênteses e pode ter espaço: o corte é a partir do ÚLTIMO ')'.
    const corte = stat.lastIndexOf(')');
    if (corte < 0) return null;
    return stat.slice(corte + 2).split(' ');
  } catch {
    return null;
  }
}
const ppidDe = (campos) => Number(campos[1]);        // campo 4
const inicioDe = (campos) => campos[19];             // campo 22: instante de partida, em ticks

/** O processo daquele pid ainda é o MESMO que escreveu o arquivo? (pid é reciclado) */
function vivo(pid, procStart) {
  if (!pid || !procStart) return false;
  const campos = camposDoStat(pid);
  return Boolean(campos) && inicioDe(campos) === String(procStart);
}

/** As sessões do CLI com id válido e processo vivo. JSON quebrado é ignorado. */
function sessoesVivas() {
  const raiz = raizSessoes();
  let arquivos;
  try { arquivos = fs.readdirSync(raiz); } catch { return []; }
  const lista = [];
  for (const nome of arquivos) {
    if (!nome.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(raiz, nome), 'utf8')); } catch { continue; }
    if (!j || typeof j !== 'object' || !UUID.test(String(j.sessionId || ''))) continue;
    if (!Number.isInteger(j.pid) || !vivo(j.pid, j.procStart)) continue;
    lista.push({
      pid: j.pid, sessionId: j.sessionId, cwd: typeof j.cwd === 'string' ? j.cwd : '', kind: j.kind, updatedAt: Number(j.updatedAt) || 0,
    });
  }
  return lista;
}

// ---- log --------------------------------------------------------------------------------------

/** Uma linha por evento, ao lado dos snapshots. Uma geração só de rotação. Falha aqui é engolida. */
function log(cmd, texto) {
  try {
    const arq = path.join(path.dirname(arquivoEstado()), 'cockpit-retoma-claude.log');
    try { if (fs.statSync(arq).size > 256 * 1024) fs.renameSync(arq, `${arq}.1`); } catch { /* sem log ainda */ }
    fs.appendFileSync(arq, `${new Date().toISOString()} ${cmd} ${texto}\n`);
  } catch { /* o gancho nunca pode quebrar o save/restore do resurrect */ }
}

// ---- salvar -----------------------------------------------------------------------------------

/** O snapshot que o resurrect acabou de apontar (`last`) e, dele, onde cada pane será recriada. */
function lerSnapshot() {
  const dir = path.dirname(arquivoEstado());
  let alvo;
  try { alvo = fs.readlinkSync(path.join(dir, 'last')); } catch { return { nome: null, mapa: null }; }
  let texto;
  try { texto = fs.readFileSync(path.resolve(dir, alvo), 'utf8'); } catch { return { nome: null, mapa: null }; }
  // Linhas `pane`, campos por TAB: pane, sessão, janela, janela_ativa, :flags, pane_index, título,
  // :dir, pane_ativa, cmd, :cmd_completo. Comparação exata, sem normalizar: o que o resurrect não
  // consegue restaurar (pasta com espaço) também não casa aqui — lado seguro.
  const mapa = new Map();
  for (const linha of texto.split('\n')) {
    if (!linha.startsWith('pane\t')) continue;
    const f = linha.split('\t');
    mapa.set(`${f[1]}\t${f[2]}\t${f[5]}`, (f[7] || '').replace(/^:/, ''));
  }
  return { nome: alvo, mapa };
}

async function salvar() {
  if (!servidorEhPadrao()) { log('salvar', 'servidor não é o padrão — nada gravado'); return; }
  const lp = await tmux(['list-panes', '-a', '-F', '#{session_name}:#{window_index}:#{pane_index}:#{pane_pid}:#{pane_id}:#{pane_current_path}']);
  // Sem servidor (ou timeout): não escreve — o arquivo anterior fica.
  if (!lp.ok) { log('salvar', 'tmux não respondeu — arquivo anterior mantido'); return; }

  const porPid = new Map();
  for (const linha of lp.saida.split('\n')) {
    const f = linha.split(':');
    if (f.length < 6 || f[0] !== sessaoAlvo()) continue;
    porPid.set(Number(f[3]), { janela: Number(f[1]), pane: Number(f[2]), id: f[4], cwd: f.slice(5).join(':') });
  }

  // Acha a pane pelo PROCESSO, de baixo para cima (cada processo tem um pai só): o campo `tmux` do
  // sessions/<pid>.json envelhece (move-window) e nunca é lido. Só `interactive` — um `claude -p`
  // disparado de dentro de uma aba não é a conversa da aba.
  const escolhido = new Map();
  for (const s of sessoesVivas()) {
    if (s.kind !== 'interactive') continue;
    let atual = s.pid;
    let achou = null;
    for (let saltos = 0; saltos <= 8 && atual; saltos++) {
      if (porPid.has(atual)) { achou = { pane: porPid.get(atual), saltos }; break; }
      const campos = camposDoStat(atual);
      atual = campos ? ppidDe(campos) : 0;
    }
    if (!achou) continue;
    // Duas na mesma pane: vence a de MENOR profundidade (a que o shell abriu); empate → a mais recente.
    const antes = escolhido.get(achou.pane.id);
    if (!antes || achou.saltos < antes.saltos || (achou.saltos === antes.saltos && s.updatedAt > antes.s.updatedAt)) {
      escolhido.set(achou.pane.id, { ...achou, s });
    }
  }

  const snap = lerSnapshot();
  const panes = [];
  const puladas = [];
  const ordenadas = [...escolhido.values()].sort((a, b) => a.pane.janela - b.pane.janela || a.pane.pane - b.pane.pane);
  for (const { pane, s } of ordenadas) {
    const pos = `${sessaoAlvo()}:${pane.janela}.${pane.pane}`;
    if (pane.cwd !== s.cwd) { puladas.push(`pulou ${pos} cwd diverge no save (${pane.cwd} ≠ ${s.cwd})`); continue; }
    const fita = path.join(raizProjetos(), s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`);
    if (!fs.existsSync(fita)) { puladas.push(`pulou ${pos} sem fita (${s.sessionId}) — o --resume falharia`); continue; }
    if (snap.mapa) {
      const dir = snap.mapa.get(`${sessaoAlvo()}\t${pane.janela}\t${pane.pane}`);
      if (dir === undefined || dir !== s.cwd) { puladas.push(`pulou ${pos} posição diverge do snapshot`); continue; }
    }
    const nome = await tmux(['show-options', '-pqv', '-t', pane.id, '@cockpit-nome']);
    // Tira só o ÚLTIMO \n: um nome pode conter \n no meio.
    const texto = nome.ok ? nome.saida.replace(/\n$/, '') : '';
    panes.push({ sessao: sessaoAlvo(), janela: pane.janela, pane: pane.pane, cwd: s.cwd, sessionId: s.sessionId, nome: texto === '' ? null : texto });
  }

  const arq = arquivoEstado();
  const tmp = `${arq}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ versao: 1, salvoEm: new Date().toISOString(), sessao: sessaoAlvo(), snapshot: snap.nome, panes }), { mode: 0o600 });
    fs.renameSync(tmp, arq);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ok */ }
    throw e;
  }
  log('salvar', `salvo ${panes.length} panes`);
  for (const p of puladas) log('salvar', p);
}

// ---- restaurar --------------------------------------------------------------------------------

const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish']);
const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cada entrada do arquivo é conferida ANTES de qualquer tmux: o arquivo em disco pode ter sido editado. */
function entradaValida(e) {
  if (!e || typeof e !== 'object' || e.sessao !== sessaoAlvo()) return false;
  if (typeof e.sessionId !== 'string' || !UUID.test(e.sessionId)) return false;
  if (!Number.isInteger(e.janela) || e.janela < 0 || !Number.isInteger(e.pane) || e.pane < 0) return false;
  if (typeof e.cwd !== 'string' || !path.isAbsolute(e.cwd)) return false;
  return e.nome === null || (typeof e.nome === 'string' && e.nome.length >= 1 && e.nome.length <= 200 && !e.nome.includes('\0'));
}

async function restaurar() {
  if (!servidorEhPadrao()) { log('restaurar', 'servidor não é o padrão — nada digitado'); return; }
  let estado;
  try { estado = JSON.parse(fs.readFileSync(arquivoEstado(), 'utf8')); } catch { log('restaurar', 'arquivo de estado ausente ou ilegível — nada digitado'); return; }
  if (!estado || estado.versao !== 1 || estado.sessao !== sessaoAlvo() || !Array.isArray(estado.panes)) {
    log('restaurar', 'estado de outra versão ou sessão — nada digitado');
    return;
  }

  // O estado tem de ser do MESMO snapshot que o resurrect está restaurando: se o gancho de save
  // falhou depois de um snapshot novo, o layout seria o novo e as conversas, as velhas. Nulo dos
  // dois lados NÃO casa.
  let last = null;
  try { last = fs.readlinkSync(path.join(path.dirname(arquivoEstado()), 'last')); } catch { /* sem `last` */ }
  if (typeof estado.snapshot !== 'string' || !estado.snapshot || last === null) { log('restaurar', 'sem snapshot — nada digitado'); return; }
  if (estado.snapshot !== last) { log('restaurar', `snapshot diverge (${estado.snapshot} ≠ ${last}) — nada digitado`); return; }

  const alvos = [];
  estado.panes.forEach((e, i) => {
    if (entradaValida(e)) alvos.push(e); else log('restaurar', `pulou entrada inválida (#${i})`);
  });

  // Só pane que ESTE restore criou: o gancho roda por `eval` dentro do processo do restore.sh, então
  // o ppid É o restore, e o shell da pane tem de ter nascido depois dele (campo 22, ticks com ticks).
  // Pane antiga (restore manual com servidor de pé) nunca recebe tecla. Pai ilegível → nenhuma
  // pane é elegível (lado seguro).
  const camposPai = camposDoStat(process.ppid);
  const inicioPai = camposPai ? Number(inicioDe(camposPai)) : null;
  if (inicioPai === null) log('restaurar', 'pai ilegível — nenhuma pane é elegível');
  const elegivel = (p) => {
    if (inicioPai === null) return false;
    const campos = camposDoStat(p.pid);
    return Boolean(campos) && Number(inicioDe(campos)) >= inicioPai;
  };

  const listar = async () => {
    const lp = await tmux(['list-panes', '-a', '-F', '#{session_name}:#{window_index}:#{pane_index}:#{pane_id}:#{pane_pid}:#{pane_current_command}:#{pane_current_path}']);
    if (!lp.ok) return null;
    const lista = [];
    for (const linha of lp.saida.split('\n')) {
      const f = linha.split(':');
      if (f.length < 7) continue;
      lista.push({ sessao: f[0], janela: Number(f[1]), pane: Number(f[2]), id: f[3], pid: Number(f[4]), cmd: f[5].replace(/^-/, ''), cwd: f.slice(6).join(':') });
    }
    return lista;
  };
  const acha = (lista, a) => lista.find((p) => p.sessao === sessaoAlvo() && p.janela === a.janela && p.pane === a.pane);

  // O resurrect devolve o conteúdo da pane com `cat` antes do shell (até ~450 KB medidos): espera até
  // 50 × 200 ms enquanto alguma pane-alvo que existe e é elegível ainda não roda shell. Pane ausente
  // não segura o laço.
  let panes = null;
  for (let volta = 0; volta < 50; volta++) {
    panes = await listar();
    if (!panes) { log('restaurar', 'tmux não respondeu — nada digitado'); return; }
    const esperando = alvos.some((a) => { const p = acha(panes, a); return p && elegivel(p) && !SHELLS.has(p.cmd); });
    if (!esperando) break;
    await espera(200);
  }

  const vivas = sessoesVivas();
  // `vivas` é uma foto de antes do laço: o claude que este laço acabou de digitar ainda não está
  // nela. Sem esta lista, duas entradas com o mesmo id abririam a conversa em duas panes (#1).
  const retomados = new Set();
  for (const a of alvos) {
    const pos = `${a.sessao}:${a.janela}.${a.pane}`;
    const p = acha(panes, a);
    if (!p) { log('restaurar', `pulou ${pos} pane ausente`); continue; }
    if (!elegivel(p)) { log('restaurar', `pulou ${pos} pane anterior ao restore`); continue; }
    if (!SHELLS.has(p.cmd)) { log('restaurar', `pulou ${pos} pane não roda shell (${p.cmd})`); continue; }
    if (p.cwd !== a.cwd) { log('restaurar', `pulou ${pos} cwd diverge (${p.cwd} ≠ ${a.cwd})`); continue; }
    if (vivas.some((v) => v.sessionId.toLowerCase() === a.sessionId.toLowerCase())) { log('restaurar', `pulou ${pos} id vivo em outro processo`); continue; }
    if (retomados.has(a.sessionId.toLowerCase())) { log('restaurar', `pulou ${pos} id já retomado em outra pane`); continue; }
    retomados.add(a.sessionId.toLowerCase());
    // Alvo pelo `pane_id` medido (nunca string montada nem a janela: cai na pane ativa); `-l` = literal.
    const texto = await tmux(['send-keys', '-t', p.id, '-l', `claude --resume ${a.sessionId}`]);
    const enter = texto.ok && await tmux(['send-keys', '-t', p.id, 'Enter']);
    if (!enter || !enter.ok) { log('restaurar', `pulou ${pos} send-keys falhou`); continue; }
    // `--` antes do nome da opção e o `;` final escapado: o tmux interpreta o argumento.
    if (a.nome !== null) await tmux(['set-option', '-p', '-t', p.id, '--', '@cockpit-nome', a.nome.replace(/;$/, '\\;')]);
    log('restaurar', `retomou ${pos} ${a.sessionId}`);
  }
}

// ---- instalar ---------------------------------------------------------------------------------

/**
 * Copia ESTE arquivo para um caminho estável e imprime as linhas do tmux.conf. O checkout vive em
 * branch de feature e `releases/<sha>/` muda a cada deploy: o tmux.conf não pode apontar para
 * nenhum dos dois. Reinstalar = atualizar. NÃO edita o tmux.conf (quem cola é o dono).
 */
function instalar() {
  const destino = destinoInstalacao();
  const node = process.execPath;
  // A linha vai entre aspas simples e é `eval`ada pelo resurrect.
  const SEGURO = /^[A-Za-z0-9._/-]+$/;
  if (!SEGURO.test(node) || !SEGURO.test(destino)) {
    process.stderr.write(`recusado: caminho com caractere fora de [A-Za-z0-9._/-] (${SEGURO.test(node) ? destino : node})\n`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const tmp = `${destino}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, fs.readFileSync(__filename), { mode: 0o644 });
  fs.renameSync(tmp, destino);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(destino)).digest('hex');
  process.stdout.write([
    `instalado em ${destino}`,
    `sha256 ${sha}`,
    '',
    "Cole estas duas linhas no ~/.tmux.conf, ANTES da linha run '~/.tmux/plugins/tpm/tpm':",
    '',
    `set -g @resurrect-hook-post-save-all '${node} ${destino} salvar'`,
    `set -g @resurrect-hook-post-restore-all '${node} ${destino} restaurar'`,
    '',
    'Depois rode: tmux source-file ~/.tmux.conf',
    '',
  ].join('\n'));
}

// ---- main -------------------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'salvar' || cmd === 'restaurar') {
    process.exitCode = 0;
    try {
      if (socket() && !PREFIXO_TESTE.test(socket())) { log(cmd, 'socket fora do padrão de teste — nada feito'); return; }
      await (cmd === 'salvar' ? salvar() : restaurar());
    } catch (e) {
      log(cmd, `erro: ${e && e.message}`);
    }
    return;
  }
  if (cmd === 'instalar') { instalar(); return; }
  process.stderr.write('uso: retoma-claude.js salvar | restaurar | instalar\n');
  process.exitCode = 2;
}

main();
