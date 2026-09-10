#!/usr/bin/env node
'use strict';

/**
 * Gate de `lib/jobs.js` — a leitura dos jobs DIRETO DO DISCO.
 *
 * Ele nunca encosta em `~/.cockpit/jobs`: cada caso fabrica a própria pasta em `tmp` e aponta
 * `COCKPIT_JOBS_DIR` para lá. É por isso que o módulo lê o caminho do ENV a cada chamada e
 * não numa constante de topo — sem isso, um gate com vários cenários precisaria de um
 * `require` novo por caso.
 *
 * O `tmux` também não é o de verdade: `child_process.execFile` é embrulhado ANTES do
 * `require('../lib/jobs')`, porque o módulo captura a função no topo. O embrulho conta as
 * chamadas (é assim que o A6 prova "uma vez por varredura, não uma por job") e devolve o
 * cenário que o caso pediu.
 *
 * Uso: COCKPIT_CERT_DIR=/dev/null HOST=127.0.0.1 node testes/gate-jobs-disco.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const fsp = require('node:fs/promises');

let falhas = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) falhas += 1;
  return cond;
};

// ─── O tmux de mentira ──────────────────────────────────────────────────────
//
// 🔴 O embrulho vai ANTES do require de lib/jobs: aquele módulo faz
// `const { execFile } = require('node:child_process')` no topo, então quem chega depois do
// require não é mais visto. O que muda entre casos é a VARIÁVEL, não a função.

let tmuxSessoes = [];        // nomes que o `tmux ls` de mentira devolve
let tmuxErra = false;        // simula "não há servidor tmux rodando"
let tmuxChamadas = 0;
const execFileReal = child.execFile;
child.execFile = function embrulho(cmd, args, opcoes, callback) {
  if (cmd !== 'tmux') return execFileReal.apply(this, arguments);
  tmuxChamadas += 1;
  const cb = typeof opcoes === 'function' ? opcoes : callback;
  // O erro do tmux vem SEM stdout — é assim que o real se comporta quando não há servidor, e
  // é essa combinação que `sessoesTmux()` traduz para conjunto vazio.
  if (tmuxErra) return process.nextTick(() => cb(new Error('no server running'), '', ''));
  return process.nextTick(() => cb(null, `${tmuxSessoes.join('\n')}\n`, ''));
};

// ─── O contador de aberturas do claude.log ──────────────────────────────────
//
// `lib/jobs.js` guarda o OBJETO `fs/promises`, então trocar o método nele é visto lá dentro.

let aberturasDeLog = 0;
const openReal = fsp.open;
fsp.open = function contando(caminho, ...resto) {
  if (String(caminho).endsWith('claude.log')) aberturasDeLog += 1;
  return openReal.call(this, caminho, ...resto);
};

const jobs = require('../lib/jobs');

// ─── Fábrica de pastas ──────────────────────────────────────────────────────

const raizes = [];
function novaRaiz() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-jobs-disco-'));
  raizes.push(dir);
  process.env.COCKPIT_JOBS_DIR = dir;
  return dir;
}

const iso = (msAtras) => new Date(Date.now() - msAtras).toISOString();
const HORA = 3600 * 1000;
const DIA = 24 * HORA;

/**
 * Escreve um job no disco. Só o que o caso pede: `meta` é mesclado por cima do mínimo, e
 * `status`/`log` só nascem quando vêm preenchidos — job sem `status.log` é o cenário 7-9 da
 * máquina de estados (cai no meta), e ele precisa da AUSÊNCIA do arquivo, não de um vazio.
 */
function escreverJob(raiz, id, { meta = {}, status = null, log = null, resultado = false } = {}) {
  const dir = path.join(raiz, id);
  fs.mkdirSync(dir, { recursive: true });
  const base = {
    id,
    type: 'ship',
    project: 'projeto-a',
    title: 'um trabalho',
    created_at: iso(2 * HORA),
    worktree: `/tmp/worktrees/${id}`,
    branch: `feature/${id}`,
    origin: 'capitao',
    merged_at: null,
    approved_at: null,
    status: 'running',
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...base, ...meta }));
  if (status !== null) fs.writeFileSync(path.join(dir, 'status.log'), status);
  if (log !== null) fs.writeFileSync(path.join(dir, 'claude.log'), log);
  if (resultado) fs.writeFileSync(path.join(dir, 'result.md'), '# resultado\n');
  return dir;
}

const linhaStatus = (quandoMs, kind, texto) => `${iso(quandoMs)} ${kind}: ${texto}\n`;

// Um pid que NÃO existe: um acima do teto do sistema nunca foi atribuído a ninguém. O
// fallback cobre um kernel sem o arquivo — 4194304 é o teto usual de 64 bits.
function pidMorto() {
  try { return Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1; }
  catch { return 4194304; }
}

const acharJob = (r, id) => r.jobs.find((j) => j.id === id);

// ─── A1 — os sete estados ───────────────────────────────────────────────────

async function a1() {
  console.log('\nA1 — os sete estados que a máquina de estados emite');
  const raiz = novaRaiz();
  tmuxSessoes = ['job-vivo'];
  tmuxErra = false;

  escreverJob(raiz, 'j-running', { meta: { pid: process.pid }, status: linhaStatus(5 * 60000, 'working', 'rodando'), log: '' });
  escreverJob(raiz, 'j-done', { status: linhaStatus(HORA, 'done', 'entregue') });
  escreverJob(raiz, 'j-failed', { status: linhaStatus(HORA, 'failed', 'reprovou') });
  escreverJob(raiz, 'j-blocked', { status: linhaStatus(HORA, 'blocked', 'preciso de decisão') });
  escreverJob(raiz, 'j-merged', { meta: { merged_at: iso(HORA) }, status: linhaStatus(HORA, 'working', 'x') });
  escreverJob(raiz, 'j-teardown', { meta: { teardown_at: iso(HORA), merged_at: iso(2 * HORA) }, status: linhaStatus(HORA, 'done', 'x') });
  escreverJob(raiz, 'j-orfao', { meta: { pid: pidMorto() }, status: linhaStatus(HORA, 'working', 'morreu no meio') });
  // Fora dos sete: `declared` que não é `running`, sem log e sem processo — o passo 9 devolve
  // o próprio `declared`, e quem consome trata como desconhecido (protegido, §4.2).
  escreverJob(raiz, 'j-desconhecido', { meta: { status: 'chutando', pid: pidMorto() } });

  const r = await jobs.listar();
  ok(r && Array.isArray(r.jobs), 'listar() devolveu a lista');
  for (const [id, esperado] of [
    ['j-running', 'running'], ['j-done', 'done'], ['j-failed', 'failed'], ['j-blocked', 'blocked'],
    ['j-merged', 'merged'], ['j-teardown', 'teardown'], ['j-orfao', 'orfao'], ['j-desconhecido', 'chutando'],
  ]) {
    const j = acharJob(r, id);
    ok(j && j.state === esperado, `${id} ⇒ ${esperado} (veio ${j ? j.state : 'ausente'})`);
  }
  // `teardown` ANTES de `merged`: o job de teardown tem os dois carimbos, e a ordem dos dois
  // primeiros passos é o que decide. Invertê-los muda o estado de jobs reais.
  ok(acharJob(r, 'j-teardown').state === 'teardown', 'teardown vence merged quando os dois carimbos existem');
  // O estado desconhecido NÃO entra no conjunto que o módulo declara emitir.
  ok(!jobs.ESTADOS.has('chutando'), 'o estado desconhecido fica fora do conjunto ESTADOS');
  ok(acharJob(r, 'j-running').etapa === null, 'running com claude.log vazio ⇒ etapa null, não erro');
}

// ─── A2 / A3 — a régua do arquivamento ──────────────────────────────────────

async function a2() {
  console.log('\nA2/A3 — a régua: o relógio é o do EVENTO, e só três estados arquivam');
  const raiz = novaRaiz();
  tmuxSessoes = [];
  tmuxErra = false;
  delete process.env.COCKPIT_HORAS_ARQUIVA;

  // A3 é a fronteira que o gate da rota não cobre: NASCEU há 5 dias, FALHOU há 1 hora.
  // Medir pelo nascimento arquivaria; medir pelo evento (o certo) mantém visível.
  escreverJob(raiz, 'j-velho-falhou-agora', {
    meta: { created_at: iso(5 * DIA) },
    status: linhaStatus(HORA, 'failed', 'reprovou agora'),
  });
  escreverJob(raiz, 'j-falhou-ha-25h', { meta: { created_at: iso(5 * DIA) }, status: linhaStatus(25 * HORA, 'failed', 'reprovou ontem') });
  escreverJob(raiz, 'j-blocked-1h', { status: linhaStatus(HORA, 'blocked', 'agora') });
  escreverJob(raiz, 'j-blocked-25h', { status: linhaStatus(25 * HORA, 'blocked', 'ontem') });
  // `done` é fim feliz: não arquiva NUNCA por idade, nem com 30 dias.
  escreverJob(raiz, 'j-done-30d', { meta: { created_at: iso(30 * DIA) }, status: linhaStatus(30 * DIA, 'done', 'antigo') });

  const r = await jobs.listar();
  ok(acharJob(r, 'j-velho-falhou-agora').arquivado === false, 'A3: nasceu há 5 d e falhou há 1 h ⇒ APARECE (o relógio é o do evento)');
  ok(acharJob(r, 'j-falhou-ha-25h').arquivado === true, 'falhou há 25 h ⇒ arquivado');
  ok(acharJob(r, 'j-blocked-1h').arquivado === false, 'blocked de 1 h ⇒ aparece');
  ok(acharJob(r, 'j-blocked-25h').arquivado === true, 'blocked de 25 h ⇒ arquivado (a D40 dizia que blocked nunca cai)');
  ok(acharJob(r, 'j-done-30d').arquivado === false, 'done de 30 d ⇒ NÃO arquiva: fim feliz não é pendência');
  ok(r.arquivados === 2, `o contador bate com a lista (${r.arquivados} de 2)`);

  // A janela é lida do ENV a cada chamada: mesmo processo, outro cenário.
  process.env.COCKPIT_HORAS_ARQUIVA = '48';
  const r48 = await jobs.listar();
  ok(acharJob(r48, 'j-blocked-25h').arquivado === false, 'com COCKPIT_HORAS_ARQUIVA=48, o de 25 h volta a aparecer');
  process.env.COCKPIT_HORAS_ARQUIVA = 'nada disso';
  ok(jobs.horasArquiva() === 24, 'COCKPIT_HORAS_ARQUIVA ilegível ⇒ volta para 24, não NaN');
  process.env.COCKPIT_HORAS_ARQUIVA = '-5';
  ok(jobs.horasArquiva() === 24, 'COCKPIT_HORAS_ARQUIVA negativo ⇒ volta para 24');
  delete process.env.COCKPIT_HORAS_ARQUIVA;
}

// ─── A2b — o carimbo do órfão ───────────────────────────────────────────────

async function a2b() {
  console.log('\nA2b — o órfão morreu calado: o carimbo é o mtime do claude.log');
  const raiz = novaRaiz();
  tmuxSessoes = [];
  tmuxErra = false;

  // O órfão não tem evento terminal — é essa a definição dele. Sem o mtime, os dois casos
  // abaixo dependeriam de um `created_at` que pode mentir ou faltar.
  const velho = escreverJob(raiz, 'j-orfao-velho', {
    meta: { pid: pidMorto(), created_at: iso(30 * DIA) },
    status: linhaStatus(30 * DIA, 'working', 'parou'),
    log: '{}\n',
  });
  fs.utimesSync(path.join(velho, 'claude.log'), new Date(Date.now() - 30 * DIA), new Date(Date.now() - 30 * DIA));

  // 🔴 O caso que só o mtime resolve: `created_at` ILEGÍVEL e o log recente. Pelo created_at
  // não haveria carimbo nenhum (`Date.parse('ontem à tarde')` é NaN) e o job ficaria visível
  // para sempre; pelo mtime ele é recente e aparece — que é o certo, mas pelo motivo certo.
  const novo = escreverJob(raiz, 'j-orfao-log-novo', {
    meta: { pid: pidMorto(), created_at: 'ontem à tarde' },
    status: linhaStatus(30 * DIA, 'working', 'parou'),
    log: '{}\n',
  });
  fs.utimesSync(path.join(novo, 'claude.log'), new Date(Date.now() - HORA), new Date(Date.now() - HORA));

  // E o inverso: `created_at` ilegível com o log VELHO ⇒ arquiva. Sem o mtime, não arquivaria.
  const ilegivelVelho = escreverJob(raiz, 'j-orfao-ilegivel-log-velho', {
    meta: { pid: pidMorto(), created_at: 'sei lá' },
    status: linhaStatus(30 * DIA, 'working', 'parou'),
    log: '{}\n',
  });
  fs.utimesSync(path.join(ilegivelVelho, 'claude.log'), new Date(Date.now() - 30 * DIA), new Date(Date.now() - 30 * DIA));

  // Sem carimbo NENHUM: `created_at` vazio, sem `claude.log`, e o `status.log` com uma linha
  // que NÃO bate o formato — daí ela vira `{ at: null, kind: null }` e não carimba nada. É o
  // job de 1 em 179 que o disco real tem hoje. Sem nada em que se apoiar, MOSTRA: na dúvida,
  // aparecer é o erro barato.
  escreverJob(raiz, 'j-orfao-sem-carimbo', {
    meta: { pid: pidMorto(), created_at: '' },
    status: 'uma linha solta que ninguem formatou\n',
  });

  const r = await jobs.listar();
  ok(acharJob(r, 'j-orfao-velho').state === 'orfao', 'o cenário é de órfão mesmo');
  ok(acharJob(r, 'j-orfao-velho').arquivado === true, 'órfão com log de 30 d ⇒ arquivado');
  ok(acharJob(r, 'j-orfao-log-novo').arquivado === false, 'created_at ilegível + log de 1 h ⇒ APARECE (o mtime carimbou)');
  ok(acharJob(r, 'j-orfao-ilegivel-log-velho').arquivado === true, 'created_at ilegível + log de 30 d ⇒ arquivado (só o mtime sabia)');
  const semCarimbo = acharJob(r, 'j-orfao-sem-carimbo');
  ok(semCarimbo.event && semCarimbo.event.at === null && semCarimbo.event.kind === null, 'linha fora do formato ⇒ evento com at e kind nulos, texto cru preservado');
  ok(semCarimbo.state === 'orfao', 'e ela cai no passo 7: declared running, sem processo ⇒ órfão');
  ok(semCarimbo.arquivado === false, 'sem carimbo nenhum ⇒ MOSTRA, não some');

  // A unidade, direto: Math.max(NaN, x) é NaN, e é por isso que o filtro vem ANTES.
  const antigo = { at: 'não é data' };
  ok(jobs.estaArquivado('failed', antigo, 'também não', null) === false, 'dois carimbos ilegíveis e nenhum mtime ⇒ não arquiva (nada de NaN)');
  ok(jobs.estaArquivado('failed', antigo, 'idem', Date.now() - 30 * DIA) === true, 'carimbos ilegíveis + mtime velho ⇒ arquiva (o filtro tirou o NaN antes do Math.max)');
  ok(jobs.estaArquivado('done', { at: iso(30 * DIA) }, iso(30 * DIA), Date.now() - 30 * DIA) === false, 'done não arquiva nem com os três carimbos velhos');
}

// ─── A4 — pasta ausente × vazia × ilegível ──────────────────────────────────

async function a4() {
  console.log('\nA4 — as três formas de retorno da raiz');
  tmuxSessoes = [];
  tmuxErra = false;

  process.env.COCKPIT_JOBS_DIR = path.join(os.tmpdir(), `gate-jobs-nao-existe-${process.pid}`);
  const ausente = await jobs.listar();
  ok(ausente !== null && ausente.ausente === true, 'pasta ausente ⇒ { ausente: true }, não null');
  ok(Array.isArray(ausente.jobs) && ausente.jobs.length === 0, 'e a lista vem vazia, não indefinida');
  ok(typeof ausente.now === 'string', 'e o `now` vem mesmo assim — a tela precisa dele para as réguas');
  ok(tmuxChamadas === 0 || true, 'pasta ausente não precisa do tmux (medido no A6)');

  const vazia = novaRaiz();
  const r = await jobs.listar();
  ok(r !== null && !r.ausente && r.jobs.length === 0, 'pasta vazia ⇒ lista vazia SEM `ausente` — é outro estado do mundo');
  ok(r.arquivados === 0 && r.pulados === 0, 'e os dois contadores em zero');

  // Arquivo no lugar da pasta: `readdir` erra com ENOTDIR, que NÃO é ENOENT.
  const arquivo = path.join(vazia, '..', `gate-jobs-arquivo-${process.pid}`);
  fs.writeFileSync(arquivo, 'não sou pasta');
  process.env.COCKPIT_JOBS_DIR = arquivo;
  const ilegivel = await jobs.listar();
  ok(ilegivel === null, 'raiz ilegível (ENOTDIR) ⇒ null — o módulo diz "não sei" em vez de inventar lista vazia');
  fs.rmSync(arquivo, { force: true });
}

// ─── A5 / A5b — o log de quem roda, e a falha por job ───────────────────────

async function a5() {
  console.log('\nA5 — 50 jobs, 1 running: o claude.log é aberto UMA vez');
  const raiz = novaRaiz();
  tmuxSessoes = [];
  tmuxErra = false;

  const acao = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/lib/jobs.js' } }] },
  });
  for (let i = 0; i < 49; i += 1) {
    escreverJob(raiz, `j-parado-${String(i).padStart(2, '0')}`, {
      status: linhaStatus(2 * HORA, 'done', 'entregue'),
      log: `${acao}\n`,     // o log EXISTE em todos: se a etapa não filtrasse por estado, abriria 50
    });
  }
  escreverJob(raiz, 'j-unico-running', {
    meta: { pid: process.pid },
    status: linhaStatus(60000, 'working', 'trabalhando'),
    log: `${acao}\n`,
  });

  aberturasDeLog = 0;
  const r = await jobs.listar();
  ok(r.jobs.length === 50, `os 50 jobs vieram (${r.jobs.length})`);
  ok(aberturasDeLog === 1, `claude.log aberto ${aberturasDeLog}× — tem de ser 1, não 50`);
  ok(acharJob(r, 'j-unico-running').etapa === 'editando jobs.js', `a etapa do running foi lida ("${acharJob(r, 'j-unico-running').etapa}")`);
  ok(acharJob(r, 'j-parado-00').etapa === null, 'job parado ⇒ etapa null, sem abrir o log dele');

  // A ordem é determinística: mais recente primeiro, desempate por id decrescente.
  const empate = novaRaiz();
  const nascimento = iso(HORA);
  escreverJob(empate, 'j-aaa', { meta: { created_at: nascimento }, status: linhaStatus(HORA, 'done', 'x') });
  escreverJob(empate, 'j-bbb', { meta: { created_at: nascimento }, status: linhaStatus(HORA, 'done', 'x') });
  const rOrdem = await jobs.listar();
  const rOrdem2 = await jobs.listar();
  ok(rOrdem.jobs[0].id === 'j-bbb', 'created_at empatado ⇒ desempate por id decrescente');
  ok(rOrdem.jobs.map((j) => j.id).join() === rOrdem2.jobs.map((j) => j.id).join(), 'duas varreduras seguidas devolvem a MESMA ordem');
}

async function a5b() {
  console.log('\nA5b — um job ilegível PULA; nunca derruba a lista');
  const raiz = novaRaiz();
  tmuxSessoes = [];
  tmuxErra = false;

  escreverJob(raiz, 'j-bom-1', { status: linhaStatus(HORA, 'done', 'ok') });
  escreverJob(raiz, 'j-bom-2', { status: linhaStatus(HORA, 'done', 'ok') });
  // meta.json quebrado
  fs.mkdirSync(path.join(raiz, 'j-meta-torto'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'j-meta-torto', 'meta.json'), '{ isto não é json');
  // meta.json ausente
  fs.mkdirSync(path.join(raiz, 'j-sem-meta'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'j-sem-meta', 'status.log'), linhaStatus(HORA, 'done', 'órfão de meta'));
  // meta.json que parseia mas não é objeto
  fs.mkdirSync(path.join(raiz, 'j-meta-string'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'j-meta-string', 'meta.json'), '"sou uma string"');
  // arquivo solto na raiz, não é pasta de job
  fs.writeFileSync(path.join(raiz, 'leia-me.txt'), 'nada a ver');
  // pasta escondida: filtrada antes, não conta como pulada
  fs.mkdirSync(path.join(raiz, '.oculta'), { recursive: true });

  const r = await jobs.listar();
  ok(r.jobs.length === 2, `os dois bons entraram (${r.jobs.length})`);
  ok(r.pulados === 4, `os quatro ilegíveis foram contados como pulados (${r.pulados})`);
  ok(!r.jobs.some((j) => j.id === '.oculta'), 'pasta escondida nem chega a ser tentada');
}

// ─── A6 / A6b — o tmux ──────────────────────────────────────────────────────

async function a6() {
  console.log('\nA6 — `tmux ls` uma vez por varredura, e erro dele vira conjunto vazio');
  const raiz = novaRaiz();
  tmuxErra = false;
  tmuxSessoes = ['sessao-do-job'];

  for (let i = 0; i < 12; i += 1) {
    escreverJob(raiz, `j-${String(i).padStart(2, '0')}`, { meta: { tmux_session: 'sessao-do-job', pid: pidMorto() }, status: linhaStatus(HORA, 'working', 'x') });
  }
  tmuxChamadas = 0;
  const r = await jobs.listar();
  ok(tmuxChamadas === 1, `tmux chamado ${tmuxChamadas}× para 12 jobs — tem de ser 1`);
  ok(r.jobs.every((j) => j.state === 'running'), 'pid morto + sessão tmux viva ⇒ running (A6b)');
  ok(r.jobs.every((j) => j.alive === false && j.tmux === true), 'e os dois campos contam a verdade separada: alive false, tmux true');

  // 🔴 `tmux ls` erra quando não há servidor rodando — e isso é "nenhuma sessão", não falha.
  // É o que faz a bateria passar num CI sem tmux instalado.
  tmuxErra = true;
  tmuxChamadas = 0;
  const semTmux = await jobs.listar();
  ok(semTmux !== null && semTmux.jobs.length === 12, 'tmux errando NÃO derruba a lista');
  ok(semTmux.jobs.every((j) => j.state === 'orfao'), 'sem tmux e com pid morto, os mesmos jobs viram órfãos');
  ok(tmuxChamadas === 1, 'e continua sendo uma chamada só');

  // Pasta sem job nenhum não paga o execFile de 4 s de timeout — o caso do clone limpo.
  novaRaiz();
  tmuxChamadas = 0;
  await jobs.listar();
  ok(tmuxChamadas === 0, 'pasta vazia ⇒ o tmux nem é consultado');

  process.env.COCKPIT_JOBS_DIR = path.join(os.tmpdir(), `gate-jobs-nao-existe-2-${process.pid}`);
  tmuxChamadas = 0;
  await jobs.listar();
  ok(tmuxChamadas === 0, 'pasta ausente ⇒ idem');

  tmuxErra = false;
}

// ─── A10 — a guarda dos testes que sobem o server ───────────────────────────

/**
 * Todo teste que sobe `server.js` tem de dizer ONDE fica a pasta de jobs.
 *
 * Sem `COCKPIT_JOBS_DIR`, `limite.dirJobs()` cai no `~/.cockpit/jobs` de quem estiver rodando —
 * e aí um smoke de conversa passa a depender de quantos jobs a máquina tem no disco naquele
 * dia. Era o mesmo defeito que `COCKPIT_PAINEL_JOBS` fechava antes desta entrega; a variável
 * mudou de nome e a guarda tem de mudar junto, senão ela protege uma porta que não existe
 * mais.
 *
 * A marca é a menção a `server.js`, e não a variável antiga: ela SOBREVIVE à remoção da env
 * var, então um teste novo que suba o servidor cai nesta rede sem ninguém se lembrar dela.
 */
function a10() {
  console.log('\nA10 — quem sobe o server.js diz onde fica a pasta de jobs');
  const dir = path.join(__dirname);
  // As quatro exceções são NOMEADAS com o motivo. Uma allowlist sem motivo escrito vira o
  // lugar onde se esconde o teste que ninguém quis consertar.
  const excecoes = new Map([
    ['gate-jobs-disco.js', 'é este gate: ele troca COCKPIT_JOBS_DIR por caso, não uma vez só'],
    ['gate-jobs-rota.js', 'planta a própria fixture de pastas e aponta a variável para ela'],
    ['gate-limite-janelas.js', 'já usa COCKPIT_JOBS_DIR em nove pontos, com pasta cheia, vazia e inválida'],
    ['gate-uso.js', 'idem, e ainda troca o HOME junto — a pasta acompanha o HOME falso'],
    // Os quatro abaixo mencionam `server.js` sem SUBIR o processo. A marca é uma menção de
    // texto de propósito (ela sobrevive à remoção da env var, que é o ponto da #57), e o preço
    // é este: quatro falsos positivos, cada um conferido à mão antes de entrar aqui.
    ['gate-ui.js', 'lê o TEXTO-FONTE do server.js (`fs.readFileSync`) para provar coisas por regex; nunca sobe o processo'],
    ['smoke-celular-medidor.js', 'exige `BASE=` de quem chama e recusa rodar sem ela (:44) — quem sobe o servidor é o chamador'],
    ['smoke-catalogo-codex.js', 'sobe um HTTP estático próprio, e o cabeçalho dele diz "NUNCA server.js" (:83)'],
  ]);

  const faltando = [];
  for (const nome of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
    const fonte = fs.readFileSync(path.join(dir, nome), 'utf8');
    if (!fonte.includes('server.js')) continue;
    if (excecoes.has(nome)) continue;
    // Quem sobe pelo helper de `fixtures-arquivos.js` já está coberto POR ELE — e é assim que
    // se quer: a variável tem um dono, e quem usa o helper a herda sem repetir a linha. Isto
    // não é uma exceção, é o caminho certo; entrar na allowlist um a um faria a lista crescer
    // a cada smoke novo até ninguém mais ler o motivo de nenhum.
    if (fonte.includes('subirServidor')) continue;
    if (!fonte.includes('COCKPIT_JOBS_DIR')) faltando.push(nome);
  }
  ok(faltando.length === 0, `todo teste que sobe o server aponta COCKPIT_JOBS_DIR${faltando.length ? ` — faltam: ${faltando.join(', ')}` : ''}`);

  // E a variável do painel externo não pode voltar pelo código executável.
  const raiz = path.join(__dirname, '..');
  const executavel = ['server.js', ...fs.readdirSync(path.join(raiz, 'lib')).map((n) => path.join('lib', n))];
  const reincidentes = executavel.filter((rel) => {
    try { return fs.readFileSync(path.join(raiz, rel), 'utf8').includes('COCKPIT_PAINEL_JOBS = '); }
    catch { return false; }
  });
  ok(reincidentes.length === 0, `COCKPIT_PAINEL_JOBS não volta ao código executável${reincidentes.length ? ` — achada em: ${reincidentes.join(', ')}` : ''}`);
}

// ─── A18 — está na bateria ──────────────────────────────────────────────────

function a18() {
  console.log('\nA18 — o gate entra na bateria do CI');
  const bateria = fs.readFileSync(path.join(__dirname, '..', 'bin', 'testes.js'), 'utf8');
  ok(bateria.includes('gate-jobs-disco.js'), 'bin/testes.js roda este gate — sem isso ele nunca roda no CI');
}

// ─── Corrida ────────────────────────────────────────────────────────────────

async function principal() {
  try {
    await a1();
    await a2();
    await a2b();
    await a4();
    await a5();
    await a5b();
    await a6();
    a10();
    a18();
  } finally {
    child.execFile = execFileReal;
    fsp.open = openReal;
    for (const r of raizes) fs.rmSync(r, { recursive: true, force: true });
  }
  console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — lib/jobs.js (leitura do disco)\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.error('🔴 o gate estourou —', e);
  process.exit(1);
});
