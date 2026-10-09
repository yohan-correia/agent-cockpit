#!/usr/bin/env node
'use strict';
// GATE — a fila de reenvio do push (spec 2026-09-11-push-retry-persistente-design.md).
// Transporte simulado + relógio controlado; nenhuma inscrição real, nenhuma rede fora da máquina.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

// Todo temporário do gate nasce DENTRO desta pasta, apagada no fim (o `finally` do bloco
// principal): o gate roda em todo `npm test` de todo job, e ~150 pastas por rodada soltas no
// /tmp viram lixo que só cresce.
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-push-retry-'));

// A guarda A10 (testes/gate-jobs-disco.js) reprova quem menciona server.js sem esta variável —
// e o R19 sobe server.js de verdade.
process.env.COCKPIT_JOBS_DIR = fs.mkdtempSync(path.join(RAIZ, 'retry-jobs-'));
process.env.COCKPIT_PUSH_DIR = fs.mkdtempSync(path.join(RAIZ, 'retry-push-'));
process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
delete process.env.COCKPIT_VIGIA_MS;

const push = require('../lib/push');

let falhas = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas += 1; return cond; };
const info = (msg) => console.log(`  ℹ️ ${msg}`);

// REDE DE SEGURANÇA 1 (spec §9 A4): o dublê padrão REPROVA. Cada caso instala o seu e devolve este
// no fim; um caso que esqueça faz o gate ficar vermelho em vez de sair para a rede.
const ENVIAR_REAL = push.enviar;
const enviarProibido = async () => { ok(false, 'push.enviar chamado sem dublê instalado'); return { status: 201 }; };
push.enviar = enviarProibido;

// Módulo NOVO por caso: pasta de push própria + `require` limpo. É a mesma coisa que um restart
// (memória zerada, disco preservado) quando a pasta é reaproveitada — o R9 usa isso.
function novoAvisos(dir = fs.mkdtempSync(path.join(RAIZ, 'retry-caso-'))) {
  process.env.COCKPIT_PUSH_DIR = dir;
  delete require.cache[require.resolve('../lib/avisos')];
  const avisos = require('../lib/avisos');
  const relogio = relogioFalso();
  avisos.usarRelogio(relogio);   // REDE DE SEGURANÇA 2: nenhum setTimeout real nasce
  return { avisos, relogio, dir };
}

function relogioFalso(inicio = 1_000_000_000) {
  const r = { t: inicio, pedidos: [] };
  r.agora = () => r.t;
  r.aleatorio = () => 1;                           // atrasos exatos: 10 000, 30 000, 90 000, 270 000
  // Um pedido deixa de estar "vivo" quando é cancelado OU quando dispara — como um setTimeout real.
  r.agendar = (fn, ms) => {
    const p = { ms, cancelado: false, disparado: false };
    p.fn = () => { p.disparado = true; return fn(); };
    r.pedidos.push(p);
    return () => { p.cancelado = true; };
  };
  r.vivo = () => r.pedidos.filter((p) => !p.cancelado && !p.disparado).at(-1);
  return r;
}

const CHAVES_VALIDAS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const inscricao = (endpoint) => ({ endpoint, keys: { ...CHAVES_VALIDAS } });
function deferido() { let resolver; const promessa = new Promise((r) => { resolver = r; }); return { promessa, resolver }; }
async function esperarAte(cond, ms = 2000) { const fim = Date.now() + ms; while (!cond() && Date.now() < fim) await new Promise((r) => setTimeout(r, 5)); return cond(); }
const lerDisco = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'pendentes.json'), 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : 'ILEGIVEL'; } };

// Fase 3 (o vigia): uma linha no formato de `abas.listar()`, no padrão de testes/gate-vigia-abas.js:71.
const linhaAba = (chave, over = {}) => ({
  chave, titulo: over.titulo ?? chave, cwd: null,
  temAgente: over.temAgente ?? true,
  rodando: 'rodando' in over ? over.rodando : null,
  esperando: 'esperando' in over ? over.esperando : null,
  arquivo: 'arquivo' in over ? over.arquivo : null,
  reiniciada: over.reiniciada ?? false,
});
// Espera real (não o relógio falso): as mocks (`listar`/`avisar`) não fazem I/O de verdade, e um
// punhado de ms basta para os microtasks pendentes drenarem (mesmo raciocínio de gate-vigia-abas.js:62).
const assentar = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// R1 — classificar(): a tabela inteira do §2.2, sem rede.
async function r1() {
  console.log('\nR1 — classificar(): a tabela inteira, sem rede');
  const { avisos } = novoAvisos();
  for (const status of [201, 204]) {
    ok(avisos.classificar({ status }, null).classe === 'aceito', `HTTP ${status} é aceito`);
  }
  for (const status of [404, 410]) {
    ok(avisos.classificar({ status }, null).classe === 'morta', `HTTP ${status} é morta`);
  }
  for (const status of [408, 429, 500, 502, 503, 504]) {
    ok(avisos.classificar({ status }, null).classe === 'transitoria', `HTTP ${status} é transitoria`);
  }
  for (const status of [400, 401, 403, 413]) {
    ok(avisos.classificar({ status }, null).classe === 'definitiva', `HTTP ${status} é definitiva`);
  }
  ok(avisos.classificar(null, { code: 'ECONNRESET' }).classe === 'transitoria', 'erro {code: ECONNRESET} é transitoria');
  ok(avisos.classificar(null, { code: 'ETIMEDOUT' }).classe === 'transitoria', 'erro {code: ETIMEDOUT} é transitoria');
  ok(avisos.classificar(null, new Error('sem code')).classe === 'definitiva', 'Error sem code é definitiva');

  const agora = 1_700_000_000_000;
  ok(avisos.classificar({ status: 429, retryAfter: '120' }, null, agora).esperaMs === 120000,
    "Retry-After '120' vira esperaMs 120000");
  const dataFutura = new Date(agora + 60000).toUTCString();
  ok(avisos.classificar({ status: 429, retryAfter: dataFutura }, null, agora).esperaMs === 60000,
    'Retry-After em data HTTP 60s à frente do agora passado vira 60000');
  ok(avisos.classificar({ status: 429, retryAfter: 'abc' }, null, agora).esperaMs === null,
    "Retry-After inválido ('abc') vira null");
  ok(avisos.classificar({ status: 429 }, null, agora).esperaMs === null,
    'Retry-After ausente vira null');
}

// R18 (parte pura) — explicarRecusa(): a frase do 502.
async function r18Pura() {
  console.log('\nR18 (parte pura) — explicarRecusa(): a frase do 502');
  const { avisos } = novoAvisos();
  ok(avisos.explicarRecusa({ pendentes: 1 }).includes('aparelho(s) aguardando nova tentativa'), 'só pendente');
  ok(avisos.explicarRecusa({ falhas: 1 }).includes('com falha definitiva'), 'só falha');
  ok(avisos.explicarRecusa({ removidos: 1 }).includes('expirada(s) e removida(s)'), 'só removido');
  const tres = avisos.explicarRecusa({ pendentes: 1, falhas: 1, removidos: 1 });
  ok(tres.includes('aguardando nova tentativa') && tres.includes('falha definitiva') && tres.includes('expirada'),
    'os três juntos, unidos');
  const zero = avisos.explicarRecusa({});
  ok(zero === 'o serviço de push não aceitou o aviso (veja o log do servidor)', 'todos zero cai na frase de reserva');
  ok(!zero.endsWith(': '), 'a frase de reserva não termina em ": " pendurado');
  ok(!tres.endsWith(': '), 'a frase com partes também não termina pendurada');
}

// R32 — o transporte por comportamento (lib/push.js), sem rede: `https.request` trocado por um
// falso, restaurado no `finally`.
function httpsFalso(roteiro) {
  return (_opcoes, aoResponder) => {
    const req = new EventEmitter();
    req.destroy = (erro) => process.nextTick(() => req.emit('error', erro));
    req.end = () => process.nextTick(() => roteiro(req, aoResponder));
    return req;
  };
}

async function r32() {
  console.log('\nR32 — o transporte, por comportamento (lib/push.js:enviar)');
  const vapid = push.gerarVapid();
  const original = https.request;
  try {
    // (a) resposta com status 201 que emite `error` ECONNRESET DEPOIS dos cabeçalhos.
    https.request = httpsFalso((req, aoResponder) => {
      const res = new EventEmitter();
      res.statusCode = 201;
      res.headers = {};
      aoResponder(res);
      process.nextTick(() => res.emit('error', Object.assign(new Error('cortou depois dos cabeçalhos'), { code: 'ECONNRESET' })));
    });
    let erroA = null;
    try {
      await ENVIAR_REAL({ inscricao: inscricao('https://push.invalid/r32a'), texto: '{}', vapid, contato: 'mailto:x@example.com' });
    } catch (erro) { erroA = erro; }
    ok(erroA && erroA.code === 'ECONNRESET', '(a) conexão cortada depois dos cabeçalhos REJEITA com o code, não pendura nem explode');

    // (b) `req` emite `timeout`.
    https.request = httpsFalso((req) => { req.emit('timeout'); });
    let erroB = null;
    try {
      await ENVIAR_REAL({ inscricao: inscricao('https://push.invalid/r32b'), texto: '{}', vapid, contato: 'mailto:x@example.com' });
    } catch (erro) { erroB = erro; }
    ok(erroB && erroB.code === 'ETIMEDOUT', '(b) timeout rejeita com code ETIMEDOUT');

    // (c) 429 com `retry-after: 30`.
    https.request = httpsFalso((req, aoResponder) => {
      const res = new EventEmitter();
      res.statusCode = 429;
      res.headers = { 'retry-after': '30' };
      aoResponder(res);
      process.nextTick(() => res.emit('end'));
    });
    const respostaC = await ENVIAR_REAL({ inscricao: inscricao('https://push.invalid/r32c'), texto: '{}', vapid, contato: 'mailto:x@example.com' });
    ok(respostaC.status === 429 && respostaC.retryAfter === '30', '(c) resolve status e o Retry-After cru');
  } finally { https.request = original; }
}

// R2 — 502 → 201: enfileira, agenda, reenvia e some.
async function r2() {
  console.log('\nR2 — 502 → 201: enfileira, agenda, reenvia e some');
  const { avisos, relogio, dir } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r2'));
  let chamadas = 0;
  let ultimoTexto = null;
  push.enviar = async ({ texto }) => { chamadas += 1; ultimoTexto = texto; return { status: 502 }; };
  try {
    const r = await avisos.avisar({ titulo: 'r2', corpo: 'r2', tag: 'r2' });
    ok(r.enviados === 0 && r.pendentes === 1, 'avisar devolve enviados:0, pendentes:1');
    const disco = lerDisco(dir);
    ok(Array.isArray(disco) && disco.length === 1, 'pendentes.json tem 1 registro');
    const modo = fs.statSync(path.join(dir, 'pendentes.json')).mode & 0o777;
    ok(modo === 0o600, `pendentes.json com modo 0600 (${modo.toString(8)})`);
    const pedido = relogio.vivo();
    ok(pedido && pedido.ms === 10000, `agendou o reenvio para 10000 ms (${pedido && pedido.ms})`);

    const primeiroTexto = ultimoTexto;
    relogio.t = avisos.pendentes()[0].proximaEm;
    push.enviar = async ({ texto }) => { chamadas += 1; ultimoTexto = texto; return { status: 201 }; };
    await avisos.processarPendentes();
    ok(chamadas === 2, `reenviou (2 chamadas no total, achei ${chamadas})`);
    ok(ultimoTexto === primeiroTexto, 'o reenvio manda o MESMO texto');
    ok(avisos.pendentes().length === 0, 'fila vazia depois do sucesso');
    ok(lerDisco(dir).length === 0, 'disco vazio depois do sucesso');
  } finally { push.enviar = enviarProibido; }
}

// R3 — 429 com Retry-After: 120s agenda pelo menos 120000 ms.
async function r3() {
  console.log('\nR3 — 429 com Retry-After: 120s agenda pelo menos 120000 ms');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r3'));
  let chamadas = 0;
  push.enviar = async () => { chamadas += 1; return { status: 429, retryAfter: '120' }; };
  try {
    const r = await avisos.avisar({ titulo: 'r3', corpo: 'r3', tag: 'r3' });
    ok(r.pendentes === 1, 'ficou pendente');
    const pedido = relogio.vivo();
    ok(pedido && pedido.ms >= 120000, `agendou >= 120000 ms (${pedido && pedido.ms})`);

    relogio.t += 1000;
    await avisos.processarPendentes();
    ok(chamadas === 1, 'antes do tempo, processarPendentes não reenvia');

    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(chamadas === 2, 'no tempo certo, reenvia');
    ok(avisos.pendentes().length === 0, 'fila vazia');
  } finally { push.enviar = enviarProibido; }
}

// R4 — timeout entra na fila e é reenviado.
async function r4() {
  console.log('\nR4 — timeout entra na fila e é reenviado');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r4'));
  let chamadas = 0;
  push.enviar = async () => { chamadas += 1; throw Object.assign(new Error('o servidor de push não respondeu'), { code: 'ETIMEDOUT' }); };
  try {
    const r = await avisos.avisar({ titulo: 'r4', corpo: 'r4', tag: 'r4' });
    ok(r.pendentes === 1, 'timeout vira pendente');
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(chamadas === 2, 'reenviou depois do timeout');
    ok(avisos.pendentes().length === 0, 'fila vazia');
  } finally { push.enviar = enviarProibido; }
}

// R5 — 401: falha definitiva, nada de fila, VAPID intocado.
async function r5() {
  console.log('\nR5 — 401: falha definitiva, nada de fila, VAPID intocado');
  const { avisos, dir } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r5'));
  avisos.chavePublica();   // força a criação do vapid.json antes do envio
  const vapidPath = path.join(dir, 'vapid.json');
  const antes = crypto.createHash('sha256').update(fs.readFileSync(vapidPath)).digest('hex');
  push.enviar = async () => ({ status: 401 });
  try {
    const r = await avisos.avisar({ titulo: 'r5', corpo: 'r5', tag: 'r5' });
    ok(r.falhas === 1 && r.pendentes === 0, `falhas:1, pendentes:0 (${JSON.stringify(r)})`);
    ok(avisos.pendentes().length === 0, 'fila vazia');
    ok((await avisos.inscricoes()).length === 1, 'inscrição mantida');
    const depois = crypto.createHash('sha256').update(fs.readFileSync(vapidPath)).digest('hex');
    ok(antes === depois, 'vapid.json byte a byte igual (sha256)');
  } finally { push.enviar = enviarProibido; }
}

// R6 — 410 no reenvio: a inscrição sai de inscricoes.json e o registro sai da fila.
async function r6() {
  console.log('\nR6 — 410 no reenvio remove a inscrição e o registro');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r6'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r6', corpo: 'r6', tag: 'r6' });
    push.enviar = async () => ({ status: 410 });
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(avisos.pendentes().length === 0, 'registro saiu da fila');
    ok((await avisos.inscricoes()).length === 0, 'inscrição saiu de inscricoes.json');
  } finally { push.enviar = enviarProibido; }
}

// R7 — esgotamento: 5 chamadas, backoff exato, fila vazia, log "desisti".
async function r7() {
  console.log('\nR7 — esgotamento: 5 tentativas, backoff exato 10s/30s/90s/270s, log "desisti"');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r7'));
  let chamadas = 0;
  push.enviar = async () => { chamadas += 1; return { status: 502 }; };
  const logs = [];
  const orig = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
  try {
    await avisos.avisar({ titulo: 'r7', corpo: 'r7', tag: 'r7' });
    for (let i = 0; i < 4; i += 1) {
      relogio.t = avisos.pendentes()[0].proximaEm;
      await avisos.processarPendentes();
    }
    ok(chamadas === 5, `exatamente 5 chamadas (${chamadas})`);
    const msPedidos = relogio.pedidos.map((p) => p.ms).join(',');
    ok(msPedidos === '10000,30000,90000,270000', `atrasos pedidos na ordem 10000/30000/90000/270000 (${msPedidos})`);
    ok(avisos.pendentes().length === 0, 'fila vazia no fim');
    ok(logs.some((l) => l.includes('desisti')), 'log "desisti" saiu');
  } finally { console.error = orig; push.enviar = enviarProibido; }
}

// R8 — Retry-After além do prazo: falha direto, nada agendado.
async function r8() {
  console.log('\nR8 — Retry-After além do prazo (15 min): falha direto, nada agendado');
  const { avisos } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r8'));
  push.enviar = async () => ({ status: 429, retryAfter: String(16 * 60) });   // 16 min > PRAZO_MS
  try {
    const r = await avisos.avisar({ titulo: 'r8', corpo: 'r8', tag: 'r8' });
    ok(r.falhas === 1 && r.pendentes === 0, `falhas:1, pendentes:0 (${JSON.stringify(r)})`);
    ok(avisos.pendentes().length === 0, 'nada na fila');
  } finally { push.enviar = enviarProibido; }
}

// R9 — restart: memória zerada, disco preservado, retomar() continua.
async function r9() {
  console.log('\nR9 — restart: memória zerada, disco preservado, retomar() continua');
  const primeiro = novoAvisos();
  const { dir } = primeiro;
  await primeiro.avisos.inscrever(inscricao('https://push.invalid/r9'));
  push.enviar = async () => ({ status: 502 });
  try {
    await primeiro.avisos.avisar({ titulo: 'r9', corpo: 'r9', tag: 'r9' });
    const registro = primeiro.avisos.pendentes()[0];

    const segundo = novoAvisos(dir);   // mesmo disco, módulo NOVO (require limpo)
    const n = segundo.avisos.retomar();
    ok(n === 1, 'retomar() devolve 1 retomado');
    ok(segundo.avisos.pendentes().length === 1, 'a fila tem 1 pendente depois do restart');
    ok(segundo.avisos.pendentes()[0].tentativas === registro.tentativas, 'tentativas preservadas');
    ok(segundo.avisos.pendentes()[0].criadoEm === registro.criadoEm, 'criadoEm preservado');

    push.enviar = async () => ({ status: 201 });
    segundo.relogio.t = segundo.avisos.pendentes()[0].proximaEm;
    await segundo.avisos.processarPendentes();
    ok(segundo.avisos.pendentes().length === 0, 'depois do restart, o reenvio ainda entrega');
  } finally { push.enviar = enviarProibido; }
}

// R10 — sucesso parcial: só o que falhou volta à fila.
async function r10() {
  console.log('\nR10 — sucesso parcial em dois destinatários: só quem falhou volta à fila');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r10-e1'));
  await avisos.inscrever(inscricao('https://push.invalid/r10-e2'));
  push.enviar = async ({ inscricao: i }) => ({ status: i.endpoint.endsWith('e1') ? 201 : 502 });
  try {
    const r = await avisos.avisar({ titulo: 'r10', corpo: 'r10', tag: 'r10' });
    ok(r.enviados === 1 && r.pendentes === 1, `enviados:1, pendentes:1 (${JSON.stringify(r)})`);
    const chamados = [];
    push.enviar = async ({ inscricao: i }) => { chamados.push(i.endpoint); return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(chamados.length === 1 && chamados[0].endsWith('e2'), 'o reenvio chama enviar SÓ para E2');
  } finally { push.enviar = enviarProibido; }
}

// R11 — o mais novo vence: aviso aceito da mesma tag descarta o pendente antigo.
async function r11() {
  console.log('\nR11 — o mais novo vence: aviso aceito da mesma tag descarta o pendente antigo');
  const { avisos } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r11'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r11-velho', corpo: 'x', tag: 'r11' });
    ok(avisos.pendentes().length === 1, 'o primeiro ficou pendente');
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    const r = await avisos.avisar({ titulo: 'r11-novo', corpo: 'x', tag: 'r11' });
    ok(r.enviados === 1, 'o aviso novo foi aceito');
    ok(avisos.pendentes().length === 0, 'o antigo sumiu da fila');
    ok(chamadas === 1, 'só a chamada do aviso novo — o antigo nunca é enviado');
  } finally { push.enviar = enviarProibido; }
}

// R12 — descadastro é respeitado: processarPendentes não ressuscita quem saiu.
async function r12() {
  console.log('\nR12 — descadastro é respeitado: processarPendentes não ressuscita quem saiu');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r12'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r12', corpo: 'r12', tag: 'r12' });
    await avisos.descadastrar('https://push.invalid/r12');
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(chamadas === 0, 'processarPendentes não chamou enviar para quem descadastrou');
    ok(avisos.pendentes().length === 0, 'e o registro saiu da fila');
  } finally { push.enviar = enviarProibido; }
}

// R13 — escrita segura (sem .tmp sobrando) e leitura ilegível (um .ilegivel só).
async function r13() {
  console.log('\nR13 — escrita segura e leitura ilegível: um .ilegivel só, substituído');
  const { avisos, dir } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r13'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r13', corpo: 'r13', tag: 'r13' });
    ok(!fs.existsSync(path.join(dir, 'pendentes.json.tmp')), 'nenhum .tmp sobra depois da gravação');

    fs.writeFileSync(path.join(dir, 'pendentes.json'), 'isto não é json — primeiro lixo');
    const segundo = novoAvisos(dir);
    let lancou = false;
    let r;
    try { r = await segundo.avisos.avisar({ titulo: 'r13b', corpo: 'x', tag: 'r13b' }); }
    catch { lancou = true; }
    ok(!lancou, 'avisar() não lança com pendentes.json ilegível');
    ok(fs.existsSync(path.join(dir, 'pendentes.json.ilegivel')), 'o lixo foi separado como .ilegivel');
    ok(r && r.pendentes === 1, 'e a fila volta a funcionar (novo pendente enfileirado normalmente)');

    fs.writeFileSync(path.join(dir, 'pendentes.json'), 'segundo lixo, diferente do primeiro');
    const terceiro = novoAvisos(dir);
    terceiro.avisos.retomar();
    const conteudoIlegivel = fs.readFileSync(path.join(dir, 'pendentes.json.ilegivel'), 'utf8');
    ok(conteudoIlegivel === 'segundo lixo, diferente do primeiro', 'o SEGUNDO ilegível substituiu o primeiro');
    const ilegiveis = fs.readdirSync(dir).filter((f) => f.includes('ilegivel'));
    ok(ilegiveis.length === 1, `existe só UM .ilegivel (achei ${ilegiveis.length})`);
  } finally { push.enviar = enviarProibido; }
}

// R14 — dois avisar() concorrentes da mesma tag: um registro só, o do mais novo.
async function r14() {
  console.log('\nR14 — dois avisar() concorrentes da mesma tag: um registro só, o do mais novo');
  const { avisos } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r14'));
  const d = deferido();
  push.enviar = async () => { await d.promessa; return { status: 502 }; };
  try {
    const p1 = avisos.avisar({ titulo: 'r14-velho', corpo: 'velho', tag: 'r14' });
    const p2 = avisos.avisar({ titulo: 'r14-novo', corpo: 'novo', tag: 'r14' });
    d.resolver();
    await Promise.all([p1, p2]);
    ok(avisos.pendentes().length === 1, 'um registro só');
    const texto = JSON.parse(avisos.pendentes()[0].texto);
    ok(texto.titulo === 'r14-novo', 'e é o do aviso mais novo');
  } finally { push.enviar = enviarProibido; }
}

// R15 — descarte concorrente com a rede: a resposta atrasada não ressuscita.
async function r15() {
  console.log('\nR15 — descarte concorrente com a rede: resposta atrasada não ressuscita');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r15'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r15', corpo: 'r15', tag: 'r15' });
    ok(avisos.pendentes().length === 1, 'ficou pendente');
    const registroAntigo = avisos.pendentes()[0];

    const d = deferido();
    const entrou = deferido();
    push.enviar = async () => { entrou.resolver(); await d.promessa; return { status: 502 }; };
    relogio.t = registroAntigo.proximaEm;
    const p = avisos.processarPendentes();
    // Só troca o dublê DEPOIS que o reenvio entrou na rede — antes disso o processamento ainda
    // está no write-ahead, e o caso não exercitaria a resposta atrasada (painel de execução).
    const naRede = await Promise.race([entrou.promessa.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
    ok(naRede, 'o reenvio entrou na rede (o dublê atrasado foi chamado)');

    push.enviar = async () => ({ status: 201 });
    await avisos.avisar({ titulo: 'r15-novo', corpo: 'x', tag: 'r15' });
    ok(avisos.pendentes().length === 0, 'o avisar novo foi aceito e não deixou pendente');

    d.resolver();
    await p;
    ok(avisos.pendentes().length === 0, 'a resposta atrasada NÃO ressuscitou o registro descartado');
  } finally { push.enviar = enviarProibido; }
}

// R16b — a fila obedece aindaVale(): falso cancela, exceção não cancela.
async function r16b() {
  console.log('\nR16b — a fila obedece aindaVale(): falso cancela, exceção envia assim mesmo');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r16b-1'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r16b-1', corpo: 'x', tag: 'r16b-1', aindaVale: () => false });
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(chamadas === 0, 'aindaVale() falso: processarPendentes NÃO envia');
    ok(avisos.pendentes().length === 0, 'e remove o registro');
  } finally { push.enviar = enviarProibido; }

  // Descadastra a inscrição do subcaso anterior: senão o segundo `avisar()` manda para os DOIS
  // aparelhos (o antigo continuaria inscrito) e a contagem de chamadas dobraria.
  await avisos.descadastrar('https://push.invalid/r16b-1');
  await avisos.inscrever(inscricao('https://push.invalid/r16b-2'));
  push.enviar = async () => ({ status: 502 });
  const logs = [];
  const orig = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
  try {
    await avisos.avisar({ titulo: 'r16b-2', corpo: 'x', tag: 'r16b-2', aindaVale: () => { throw new Error('quebrado'); } });
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(chamadas === 1, 'aindaVale() que lança: envia assim mesmo');
    ok(logs.length >= 1, 'e loga uma vez');
  } finally { console.error = orig; push.enviar = enviarProibido; }
}

// R17 (parte retomar) — sem COCKPIT_CONTATO, retomar() devolve 0 calado.
async function r17SemContato() {
  console.log('\nR17 (parte retomar) — sem COCKPIT_CONTATO, retomar() devolve 0');
  const { avisos } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r17'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r17', corpo: 'r17', tag: 'r17' });
    ok(avisos.pendentes().length === 1, 'ficou pendente com contato válido');
  } finally { push.enviar = enviarProibido; }

  const antes = process.env.COCKPIT_CONTATO;
  process.env.COCKPIT_CONTATO = '';
  try {
    const n = avisos.retomar();
    ok(n === 0, 'sem COCKPIT_CONTATO, retomar() devolve 0');
  } finally { process.env.COCKPIT_CONTATO = antes; }
}

// R18 (caso de origem) — 410 único + limpeza falhando ⇒ tudo zero, frase de reserva.
async function r18CasoOrigem() {
  console.log('\nR18 (caso de origem) — 410 único + limpeza falhando ⇒ tudo zero, frase de reserva');
  const { avisos } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r18'));
  push.enviar = async () => ({ status: 410 });
  const originalWriteFile = fsp.writeFile;
  fsp.writeFile = (arquivo, ...resto) => {
    if (String(arquivo).endsWith('inscricoes.json')) return Promise.reject(Object.assign(new Error('sem espaço'), { code: 'ENOSPC' }));
    return originalWriteFile.call(fsp, arquivo, ...resto);
  };
  try {
    const r = await avisos.avisar({ titulo: 'r18', corpo: 'r18', tag: 'r18' });
    ok(r.inscritos === 1 && r.enviados === 0 && r.pendentes === 0 && r.falhas === 0 && r.removidos === 0,
      `tudo zero exceto inscritos:1 (${JSON.stringify(r)})`);
    ok(avisos.explicarRecusa(r) === 'o serviço de push não aceitou o aviso (veja o log do servidor)',
      'explicarRecusa cai na frase de reserva');
  } finally { fsp.writeFile = originalWriteFile; push.enviar = enviarProibido; }
}

// R20 — erro local (vapid.json ilegível) não vira laço quente.
async function r20() {
  console.log('\nR20 — erro local (vapid.json ilegível) não vira laço quente');
  const { avisos, relogio, dir } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r20'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r20', corpo: 'r20', tag: 'r20' });
    const vapidPath = path.join(dir, 'vapid.json');
    fs.writeFileSync(vapidPath, 'isto não é json');
    const tentativasAntes = avisos.pendentes()[0].tentativas;
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    const t = avisos.pendentes()[0].proximaEm;
    relogio.t = t;
    await avisos.processarPendentes();
    ok(chamadas === 0, 'não chamou enviar com o vapid.json ilegível');
    ok(avisos.pendentes()[0].tentativas === tentativasAntes, 'não gastou tentativa');
    ok(avisos.pendentes()[0].proximaEm === t + 10000, 'adiou para agora + BASE_MS');
    const pedido = relogio.vivo();
    ok(pedido && pedido.ms >= 1000, `o próximo agendamento é >= 1000 ms (${pedido && pedido.ms})`);
    ok(fs.readFileSync(vapidPath, 'utf8') === 'isto não é json', 'o vapid.json ilegível continua igual (não regenerou)');
  } finally { push.enviar = enviarProibido; }
}

// R21 — temporizador atrasado além do prazo: não envia, remove (poda antes de tudo).
async function r21() {
  console.log('\nR21 — temporizador atrasado além do prazo: não envia, remove');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r21'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r21', corpo: 'r21', tag: 'r21' });
    const registro = avisos.pendentes()[0];
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    relogio.t = registro.criadoEm + avisos.POLITICA.PRAZO_MS + 1;
    await avisos.processarPendentes();
    ok(chamadas === 0, 'não envia — o prazo já passou');
    ok(avisos.pendentes().length === 0, 'e remove o registro vencido');
  } finally { push.enviar = enviarProibido; }
}

// R22 — descarte durante a leitura de inscricoes(): enviar não é chamado.
async function r22() {
  console.log('\nR22 — descarte durante a leitura de inscricoes(): enviar não é chamado');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r22'));
  push.enviar = async () => ({ status: 502 });
  const originalReadFile = fsp.readFile;
  try {
    await avisos.avisar({ titulo: 'r22', corpo: 'r22', tag: 'r22' });
    relogio.t = avisos.pendentes()[0].proximaEm;

    const d = deferido();
    fsp.readFile = (arquivo, ...resto) => {
      if (String(arquivo).endsWith('inscricoes.json')) return d.promessa.then(() => originalReadFile.call(fsp, arquivo, ...resto));
      return originalReadFile.call(fsp, arquivo, ...resto);
    };
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    const p = avisos.processarPendentes();

    await avisos.descartarPendentes('r22');
    fsp.readFile = originalReadFile;
    d.resolver();
    await p;
    ok(chamadas === 0, 'enviar não foi chamado — o registro sumiu antes da rede');
    ok(avisos.pendentes().length === 0, 'e a fila está vazia');
  } finally { fsp.readFile = originalReadFile; push.enviar = enviarProibido; }
}

// R23 — write-ahead: a tentativa já está no disco antes da resposta de rede.
async function r23() {
  console.log('\nR23 — write-ahead: a tentativa já está no disco antes da resposta de rede');
  const { avisos, relogio, dir } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r23'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r23', corpo: 'r23', tag: 'r23' });
    const tentativasAntes = avisos.pendentes()[0].tentativas;
    relogio.t = avisos.pendentes()[0].proximaEm;

    const d = deferido();
    // O disco é lido NA ENTRADA do dublê — o instante em que a requisição sairia. Ler depois
    // passaria também com a gravação acontecendo depois do envio (painel de execução).
    let discoNaEntrada;
    push.enviar = async () => { discoNaEntrada = lerDisco(dir); await d.promessa; return { status: 502 }; };
    const p = avisos.processarPendentes();
    await esperarAte(() => discoNaEntrada !== undefined);
    ok(Array.isArray(discoNaEntrada) && discoNaEntrada.some((r) => r.tentativas === tentativasAntes + 1),
      'no instante do envio, o disco já mostra a tentativa incrementada (write-ahead)');
    d.resolver();
    await p;
  } finally { push.enviar = enviarProibido; }
}

// R24 — teto de tentativas respeitado na retomada (retomar não dá 6ª chance).
async function r24() {
  console.log('\nR24 — teto de tentativas respeitado na retomada (sem 6ª chance)');
  const dir = fs.mkdtempSync(path.join(RAIZ, 'retry-caso-'));
  const agora = 1_000_000_000;
  const registro = {
    id: crypto.randomUUID(), tag: 'r24', endpoint: 'https://push.invalid/r24', texto: '{}',
    tentativas: 5, criadoEm: agora, proximaEm: agora - 1000, ultimoMotivo: 'HTTP 502',
  };
  fs.writeFileSync(path.join(dir, 'pendentes.json'), JSON.stringify([registro]), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'inscricoes.json'),
    JSON.stringify([{ endpoint: 'https://push.invalid/r24', keys: { ...CHAVES_VALIDAS } }]), { mode: 0o600 });
  const { avisos, relogio } = novoAvisos(dir);
  relogio.t = agora;
  let chamadas = 0;
  push.enviar = async () => { chamadas += 1; return { status: 201 }; };
  try {
    const n = avisos.retomar();
    ok(n === 1, 'retomar() encontrou o registro');
    await avisos.processarPendentes();
    ok(chamadas === 0, 'enviar não foi chamado — o teto já tinha sido atingido');
    ok(avisos.pendentes().length === 0, 'e o registro saiu, sem 6ª chance');
  } finally { push.enviar = enviarProibido; }
}

// R25 — descadastro durante o write-ahead: enviar não é chamado para quem saiu.
async function r25() {
  console.log('\nR25 — descadastro durante o write-ahead: enviar não é chamado para quem saiu');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r25'));
  push.enviar = async () => ({ status: 502 });
  const originalWriteFile = fsp.writeFile;
  try {
    await avisos.avisar({ titulo: 'r25', corpo: 'r25', tag: 'r25' });
    relogio.t = avisos.pendentes()[0].proximaEm;

    const d = deferido();
    fsp.writeFile = (arquivo, ...resto) => {
      if (String(arquivo).endsWith('pendentes.json.tmp')) return d.promessa.then(() => originalWriteFile.call(fsp, arquivo, ...resto));
      return originalWriteFile.call(fsp, arquivo, ...resto);
    };
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    const p = avisos.processarPendentes();   // preso na gravação do write-ahead

    await avisos.descadastrar('https://push.invalid/r25');
    fsp.writeFile = originalWriteFile;
    d.resolver();
    await p;
    ok(chamadas === 0, 'enviar não foi chamado — a inscrição saiu antes da leitura da lista');
  } finally { fsp.writeFile = originalWriteFile; push.enviar = enviarProibido; }
}

// R26 — gravação da fila falhando: segue em memória, log só uma vez por código.
async function r26() {
  console.log('\nR26 — gravação da fila falhando: segue em memória, log só uma vez por código');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r26'));
  push.enviar = async () => ({ status: 502 });
  const originalWriteFile = fsp.writeFile;
  fsp.writeFile = (arquivo, ...resto) => {
    if (String(arquivo).endsWith('pendentes.json.tmp')) return Promise.reject(Object.assign(new Error('sem espaço'), { code: 'ENOSPC' }));
    return originalWriteFile.call(fsp, arquivo, ...resto);
  };
  const logs = [];
  const orig = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
  try {
    const r1 = await avisos.avisar({ titulo: 'r26a', corpo: 'x', tag: 'r26a' });
    const r2 = await avisos.avisar({ titulo: 'r26b', corpo: 'x', tag: 'r26b' });
    ok(r1.pendentes === 1 && r2.pendentes === 1, 'avisar() resolve normalmente com pendentes:1, mesmo sem gravar (duas vezes)');
    const linhasENOSPC = logs.filter((l) => l.includes('ENOSPC')).length;
    ok(linhasENOSPC === 1, `só uma linha de log para o mesmo código de erro (achei ${linhasENOSPC})`);

    fsp.writeFile = originalWriteFile;
    push.enviar = async () => ({ status: 201 });
    relogio.t = Math.max(...avisos.pendentes().map((r) => r.proximaEm));
    await avisos.processarPendentes();
    ok(avisos.pendentes().length === 0, 'processarPendentes entrega pela memória mesmo sem ter gravado antes');
  } finally { console.error = orig; fsp.writeFile = originalWriteFile; push.enviar = enviarProibido; }
}

// R27 — leitura de inscricoes.json falhando no reenvio: devolve a tentativa, adia.
async function r27() {
  console.log('\nR27 — leitura de inscricoes.json falhando no reenvio: devolve a tentativa, adia');
  if (process.getuid && process.getuid() === 0) { info('rodando como root — chmod não bloqueia leitura; caso pulado'); return; }
  const { avisos, relogio, dir } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r27'));
  push.enviar = async () => ({ status: 502 });
  const inscricoesPath = path.join(dir, 'inscricoes.json');
  try {
    await avisos.avisar({ titulo: 'r27', corpo: 'r27', tag: 'r27' });
    const tentativasAntes = avisos.pendentes()[0].tentativas;
    const t = avisos.pendentes()[0].proximaEm;
    relogio.t = t;
    fs.chmodSync(inscricoesPath, 0o000);
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    await avisos.processarPendentes();
    ok(chamadas === 0, 'enviar não foi chamado — a leitura das inscrições falhou');
    ok(avisos.pendentes()[0].tentativas === tentativasAntes, 'a tentativa contada foi devolvida');
    ok(avisos.pendentes()[0].proximaEm === t + 10000, 'adiou para agora + BASE_MS');
  } finally { fs.chmodSync(inscricoesPath, 0o600); push.enviar = enviarProibido; }
}

// R28 — prazo vence durante os await do write-ahead: sai sem enviar.
async function r28() {
  console.log('\nR28 — prazo vence durante os await do write-ahead: sai sem enviar');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r28'));
  push.enviar = async () => ({ status: 502 });
  const originalWriteFile = fsp.writeFile;
  try {
    await avisos.avisar({ titulo: 'r28', corpo: 'r28', tag: 'r28' });
    const registro = avisos.pendentes()[0];
    relogio.t = registro.proximaEm;

    const d = deferido();
    fsp.writeFile = (arquivo, ...resto) => {
      if (String(arquivo).endsWith('pendentes.json.tmp')) {
        return d.promessa.then(() => {
          relogio.t = registro.criadoEm + avisos.POLITICA.PRAZO_MS + 1;   // vence o prazo AGORA
          return originalWriteFile.call(fsp, arquivo, ...resto);
        });
      }
      return originalWriteFile.call(fsp, arquivo, ...resto);
    };
    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    const p = avisos.processarPendentes();
    d.resolver();
    await p;
    ok(chamadas === 0, 'saiu sem enviar — o prazo venceu durante o write-ahead');
    ok(avisos.pendentes().length === 0, 'e o registro saiu da fila');
  } finally { fsp.writeFile = originalWriteFile; push.enviar = enviarProibido; }
}

// R29 — erro sem código de rede é DEFINITIVO (não repete).
async function r29() {
  console.log('\nR29 — erro sem código de rede é DEFINITIVO (não repete)');
  const { avisos, dir } = novoAvisos();
  // Inscrição gravada direto no disco: p256dh inválido, não passa pela validação de `inscrever()`.
  fs.writeFileSync(path.join(dir, 'inscricoes.json'),
    JSON.stringify([{ endpoint: 'https://push.invalid/r29', keys: { p256dh: 'AAAA', auth: 'AAAA' } }]), { mode: 0o600 });
  push.enviar = ENVIAR_REAL;
  try {
    const r = await avisos.avisar({ titulo: 'r29', corpo: 'r29', tag: 'r29' });
    ok(r.falhas === 1 && r.pendentes === 0, 'p256dh inválido lança síncrono ⇒ falha definitiva, nada na fila');
  } finally { push.enviar = enviarProibido; }

  await avisos.descadastrar('https://push.invalid/r29');
  await avisos.inscrever(inscricao('https://push.invalid/r29b'));
  push.enviar = async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); };
  try {
    const r = await avisos.avisar({ titulo: 'r29b', corpo: 'x', tag: 'r29b' });
    ok(r.pendentes === 1, 'erro {code: ECONNRESET} entra na fila (transitoria)');
  } finally { push.enviar = enviarProibido; }

  await avisos.descartarPendentes('r29b');
  push.enviar = async () => { throw new Error('sem code'); };
  try {
    const r = await avisos.avisar({ titulo: 'r29c', corpo: 'x', tag: 'r29c' });
    ok(r.falhas === 1 && r.pendentes === 0, 'Error sem code é definitiva — nada na fila');
  } finally { push.enviar = enviarProibido; }
}

// R30 — carga preguiçosa: o primeiro avisar() não apaga a fila antiga do disco.
async function r30() {
  console.log('\nR30 — carga preguiçosa: o primeiro avisar() não apaga a fila antiga do disco');
  const dir = fs.mkdtempSync(path.join(RAIZ, 'retry-caso-'));
  const t = 2_000_000_000;
  const registroVelho = {
    id: crypto.randomUUID(), tag: 'r30-velha', endpoint: 'https://push.invalid/r30-velha', texto: '{}',
    tentativas: 1, criadoEm: t, proximaEm: t + 5000, ultimoMotivo: 'HTTP 502',
  };
  fs.writeFileSync(path.join(dir, 'pendentes.json'), JSON.stringify([registroVelho]), { mode: 0o600 });
  const { avisos, relogio } = novoAvisos(dir);
  relogio.t = t;
  await avisos.inscrever(inscricao('https://push.invalid/r30-nova'));
  push.enviar = async () => ({ status: 201 });
  try {
    // SEM chamar retomar(): o primeiro avisar() é a carga preguiçosa.
    const r = await avisos.avisar({ titulo: 'r30', corpo: 'r30', tag: 'r30-nova' });
    ok(r.enviados === 1, 'o aviso novo foi aceito');
    const disco = lerDisco(dir);
    ok(Array.isArray(disco) && disco.some((reg) => reg.tag === 'r30-velha'),
      'o registro antigo CONTINUA no disco — não foi sobrescrito por []');
    ok(relogio.vivo() !== undefined, 'há um pedido de agendar() vivo para o registro antigo');
  } finally { push.enviar = enviarProibido; }
}

// R31 — 410 num registro já descartado ainda limpa a inscrição morta.
async function r31() {
  console.log('\nR31 — 410 num registro já descartado ainda limpa a inscrição morta');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r31'));
  push.enviar = async () => ({ status: 502 });
  try {
    await avisos.avisar({ titulo: 'r31', corpo: 'r31', tag: 'r31' });
    relogio.t = avisos.pendentes()[0].proximaEm;

    const d = deferido();
    let chamado = 0;
    push.enviar = async () => { chamado += 1; await d.promessa; return { status: 410 }; };
    const p = avisos.processarPendentes();

    // Só descarta DEPOIS que a requisição já está em voo (push.enviar chamado, preso no
    // deferido) — antes disso o write-ahead ainda não chegou ao passo de disparar a rede, e o
    // descarte a tempo faria o registro nem sequer entrar em `envios` (não é o que este caso prova).
    await esperarAte(() => chamado === 1);
    await avisos.descartarPendentes('r31');   // some da fila ANTES da resposta 410 voltar
    ok(avisos.pendentes().length === 0, 'o registro já saiu da fila');

    d.resolver();
    await p;
    ok((await avisos.inscricoes()).length === 0, '410 ainda limpou a inscrição morta, mesmo sem o registro');
  } finally { push.enviar = enviarProibido; }
}

// R33 — limpeza de morto falhando não perde o reenvio do vizinho.
async function r33() {
  console.log('\nR33 — limpeza de morto falhando não perde o reenvio do vizinho');
  const { avisos } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r33-e1'));
  await avisos.inscrever(inscricao('https://push.invalid/r33-e2'));
  push.enviar = async ({ inscricao: i }) => ({ status: i.endpoint.endsWith('e1') ? 410 : 502 });
  const originalWriteFile = fsp.writeFile;
  fsp.writeFile = (arquivo, ...resto) => {
    if (String(arquivo).endsWith('inscricoes.json')) return Promise.reject(Object.assign(new Error('sem espaço'), { code: 'ENOSPC' }));
    return originalWriteFile.call(fsp, arquivo, ...resto);
  };
  try {
    const r = await avisos.avisar({ titulo: 'r33', corpo: 'r33', tag: 'r33' });
    ok(r.pendentes === 1 && r.removidos === 0, `pendentes:1, removidos:0 (${JSON.stringify(r)})`);
    ok(avisos.pendentes().some((reg) => reg.endpoint.endsWith('e2')), 'o registro de E2 está na fila');
  } finally { fsp.writeFile = originalWriteFile; push.enviar = enviarProibido; }
}

// R34 — o relógio de verdade da fila: a callback do armar() dispara o reenvio.
async function r34() {
  console.log('\nR34 — o relógio de verdade da fila: a callback do armar() dispara o reenvio');
  const { avisos, relogio, dir } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r34'));
  let chamadasDoDuble = 0;
  push.enviar = async () => { chamadasDoDuble += 1; return { status: 502 }; };
  try {
    await avisos.avisar({ titulo: 'r34', corpo: 'r34', tag: 'r34' });
    const p = relogio.vivo();
    ok(p && p.ms === 10000, 'a callback do armar() foi pedida para 10000 ms');

    relogio.t = avisos.pendentes()[0].proximaEm;
    await p.fn();   // a PRÓPRIA callback do armar(), NÃO processarPendentes() na mão
    ok(chamadasDoDuble === 2, `o dublê foi chamado de novo pela callback (${chamadasDoDuble})`);
    ok(lerDisco(dir)[0].tentativas === 2, 'e o disco já mostra tentativas:2');
    const novoPedido = relogio.vivo();
    ok(novoPedido && novoPedido.ms === 30000 && novoPedido !== p, 'reagendou no finally, ms:30000, um pedido NOVO');

    push.enviar = async () => { chamadasDoDuble += 1; return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await relogio.vivo().fn();
    ok(avisos.pendentes().length === 0, 'fila vazia depois do sucesso');
    ok(lerDisco(dir).length === 0, 'disco vazio depois do sucesso');
    ok(relogio.vivo() === undefined, 'nenhum pedido vivo — nada mais para reenviar');
  } finally { push.enviar = enviarProibido; }
}

// R35 — os logs da fila nunca vazam conteúdo do disco (só código/host).
async function r35() {
  console.log('\nR35 — os logs da fila nunca vazam conteúdo do disco (só código/host)');
  const capturarLogs = () => {
    const logs = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...a) => { logs.push(a.join(' ')); };
    console.log = (...a) => { logs.push(a.join(' ')); };
    return { logs, restaurar: () => { console.error = origErr; console.log = origLog; } };
  };

  // (a) pendentes.json com lixo marcado — novoAvisos(dir) + retomar() o carregam.
  {
    const dir = fs.mkdtempSync(path.join(RAIZ, 'retry-caso-'));
    fs.writeFileSync(path.join(dir, 'pendentes.json'), '{"texto":"SEGREDO-R35-PENDENTES-truncado');
    const { avisos } = novoAvisos(dir);
    const captura = capturarLogs();
    avisos.retomar();
    captura.restaurar();
    ok(!captura.logs.some((l) => l.includes('SEGREDO-R35')), '(a) nenhuma linha vaza o lixo do pendentes.json');
  }

  // (b) vapid.json com lixo marcado — processarPendentes bate no erro local.
  {
    const { avisos, relogio, dir } = novoAvisos();
    await avisos.inscrever(inscricao('https://push.invalid/r35b'));
    push.enviar = async () => ({ status: 502 });
    try {
      await avisos.avisar({ titulo: 'r35b', corpo: 'x', tag: 'r35b' });
      fs.writeFileSync(path.join(dir, 'vapid.json'), 'SEGREDO-R35-VAPID-lixo');
      relogio.t = avisos.pendentes()[0].proximaEm;
      const captura = capturarLogs();
      await avisos.processarPendentes();
      captura.restaurar();
      ok(!captura.logs.some((l) => l.includes('SEGREDO-R35')), '(b) nenhuma linha vaza o conteúdo do vapid.json');
    } finally { push.enviar = enviarProibido; }
  }

  // (c) um envio falha com um endpoint marcado — o log usa só o hostname.
  {
    const { avisos } = novoAvisos();
    await avisos.inscrever(inscricao('https://push.invalid/SEGREDO-R35-ENDPOINT'));
    push.enviar = async () => ({ status: 502 });
    try {
      const captura = capturarLogs();
      await avisos.avisar({ titulo: 'r35c', corpo: 'x', tag: 'r35c' });
      captura.restaurar();
      ok(!captura.logs.some((l) => l.includes('SEGREDO-R35')), '(c) o log usa só o hostname, nunca o endpoint inteiro');
    } finally { push.enviar = enviarProibido; }
  }

  // (d) pendentes.json com lixo marcado E a pasta sem permissão de escrita — o rename também falha.
  if (process.getuid && process.getuid() === 0) {
    info('rodando como root — chmod não bloqueia o rename; caso (d) pulado');
  } else {
    const dir = fs.mkdtempSync(path.join(RAIZ, 'retry-caso-'));
    fs.writeFileSync(path.join(dir, 'pendentes.json'), '{"texto":"SEGREDO-R35-D-truncado');
    fs.chmodSync(dir, 0o500);
    try {
      const { avisos } = novoAvisos(dir);
      const captura = capturarLogs();
      const n = avisos.retomar();
      captura.restaurar();
      ok(n === 0, '(d) retomar() devolve 0 quando nem o rename do ilegível funciona');
      ok(captura.logs.length >= 2, `(d) as duas linhas de log saem (achei ${captura.logs.length})`);
      ok(!captura.logs.some((l) => l.includes('SEGREDO-R35')), '(d) nenhuma das duas linhas vaza o lixo');
    } finally { fs.chmodSync(dir, 0o700); }
  }
}

// R16 — o vigia entrega aindaVale() e ela acompanha o Estado recém-calculado.
async function r16() {
  console.log('\nR16 — o vigia entrega aindaVale() e ela acompanha o estado (fixture, sem avisos real)');
  const vigia = require('../lib/vigia-abas');
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';

  // "fim": true logo depois do aviso; false quando a aba volta a rodar.
  {
    const chamadas = [];
    const espiao = async (p) => { chamadas.push(p); return { enviados: 1, removidos: 0 }; };
    let linhas = [linhaAba('r16-fim', { rodando: true, esperando: false, arquivo: 'A' })];
    const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: espiao });
    await assentar();
    linhas = [linhaAba('r16-fim', { rodando: false, esperando: false, arquivo: 'A' })];
    await instancia.bater();
    await assentar();
    ok(chamadas.length === 1, 'fim: um aviso disparado');
    ok(chamadas[0].aindaVale() === true, 'fim: aindaVale() true logo depois do aviso');
    linhas = [linhaAba('r16-fim', { rodando: true, esperando: false, arquivo: 'A' })];
    await instancia.bater();
    await assentar();
    ok(chamadas[0].aindaVale() === false, 'fim: a aba voltou a rodar ⇒ false');
    instancia.parar();
  }

  // "intervencao": true logo depois; false quando a pergunta é respondida.
  {
    const chamadas = [];
    const espiao = async (p) => { chamadas.push(p); return { enviados: 1, removidos: 0 }; };
    let linhas = [linhaAba('r16-int', { rodando: true, esperando: false, arquivo: 'B' })];
    const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: espiao });
    await assentar();
    linhas = [linhaAba('r16-int', { rodando: true, esperando: true, arquivo: 'B' })];
    await instancia.bater();
    await assentar();
    ok(chamadas.length === 1, 'intervencao: um aviso disparado');
    ok(chamadas[0].aindaVale() === true, 'intervencao: aindaVale() true logo depois do aviso');
    linhas = [linhaAba('r16-int', { rodando: true, esperando: false, arquivo: 'B' })];
    await instancia.bater();
    await assentar();
    ok(chamadas[0].aindaVale() === false, 'intervencao: a pergunta respondida ⇒ false');
    instancia.parar();
  }

  // troca de arquivo (conversa nova): false.
  {
    const chamadas = [];
    const espiao = async (p) => { chamadas.push(p); return { enviados: 1, removidos: 0 }; };
    let linhas = [linhaAba('r16-arq', { rodando: true, esperando: false, arquivo: 'C' })];
    const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: espiao });
    await assentar();
    linhas = [linhaAba('r16-arq', { rodando: true, esperando: true, arquivo: 'C' })];
    await instancia.bater();
    await assentar();
    ok(chamadas.length === 1, 'troca de arquivo: um aviso disparado');
    linhas = [linhaAba('r16-arq', { rodando: true, esperando: true, arquivo: 'D' })];
    await instancia.bater();
    await assentar();
    ok(chamadas[0].aindaVale() === false, 'troca de arquivo ⇒ false');
    instancia.parar();
  }

  // aba sumiu da lista: false.
  {
    const chamadas = [];
    const espiao = async (p) => { chamadas.push(p); return { enviados: 1, removidos: 0 }; };
    let linhas = [linhaAba('r16-sumiu', { rodando: true, esperando: false, arquivo: 'E' })];
    const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: espiao });
    await assentar();
    linhas = [linhaAba('r16-sumiu', { rodando: true, esperando: true, arquivo: 'E' })];
    await instancia.bater();
    await assentar();
    ok(chamadas.length === 1, 'aba sumida: um aviso disparado');
    linhas = [];
    await instancia.bater();
    await assentar();
    ok(chamadas[0].aindaVale() === false, 'aba sumiu da lista ⇒ false');
    instancia.parar();
  }
}

// R16c — o cenário do painel, ponta a ponta: pergunta respondida ⇒ o reenvio NÃO sai.
async function r16c() {
  console.log('\nR16c — cenário ponta a ponta: pergunta respondida antes do reenvio ⇒ não sai');
  const vigia = require('../lib/vigia-abas');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r16c'));
  push.enviar = async () => ({ status: 502 });
  let linhas = [linhaAba('r16c', { rodando: true, esperando: false, arquivo: 'A' })];
  const instancia = vigia.iniciar({
    intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisos.avisar, retomar: avisos.retomar,
  });
  try {
    await instancia.bater();   // semeadura
    linhas = [linhaAba('r16c', { rodando: true, esperando: true, arquivo: 'A' })];   // menu aparece
    await instancia.bater();
    await esperarAte(() => avisos.pendentes().length === 1);
    ok(avisos.pendentes().length === 1, 'a intervenção ficou pendente na fila');

    linhas = [linhaAba('r16c', { rodando: true, esperando: false, arquivo: 'A' })];   // pergunta respondida
    await instancia.bater();   // a revalidação de aguardandoReenvio trava a ficha AGORA

    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(chamadas === 0, 'o reenvio NÃO saiu — a pergunta já tinha sido respondida');
  } finally { instancia.parar(); push.enviar = enviarProibido; }
}

// R16d — a trava não destrava: aba some e volta igual, não ressuscita o reenvio.
async function r16d() {
  console.log('\nR16d — a trava não destrava: aba some e volta igual (true→false→true) não ressuscita');
  const vigia = require('../lib/vigia-abas');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r16d'));
  push.enviar = async () => ({ status: 502 });
  let linhas = [linhaAba('r16d', { rodando: true, esperando: false, arquivo: 'A' })];
  const instancia = vigia.iniciar({
    intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisos.avisar, retomar: avisos.retomar,
  });
  try {
    await instancia.bater();   // semeadura
    linhas = [linhaAba('r16d', { rodando: false, esperando: false, arquivo: 'A' })];   // fim
    await instancia.bater();
    await esperarAte(() => avisos.pendentes().length === 1);
    ok(avisos.pendentes().length === 1, 'o fim ficou pendente na fila');

    linhas = [];   // a aba some da lista — trava para sempre
    await instancia.bater();

    linhas = [linhaAba('r16d', { rodando: false, esperando: false, arquivo: 'A' })];   // e volta, igual a antes
    await instancia.bater();

    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(chamadas === 0, 'o reenvio NÃO saiu — a trava não destrava');
  } finally { instancia.parar(); push.enviar = enviarProibido; }
}

// R16e — ficha cancelada durante a primeira tentativa: mesmo assim enfileira, mas o reenvio não sai.
async function r16e() {
  console.log('\nR16e — ficha cancelada durante a primeira tentativa: o reenvio não sai mesmo assim');
  const vigia = require('../lib/vigia-abas');
  const { avisos, relogio } = novoAvisos();
  await avisos.inscrever(inscricao('https://push.invalid/r16e'));
  const d = deferido();
  push.enviar = async () => { await d.promessa; return { status: 502 }; };
  let linhas = [linhaAba('r16e', { rodando: true, esperando: false, arquivo: 'A' })];
  const instancia = vigia.iniciar({
    intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisos.avisar, retomar: avisos.retomar,
  });
  try {
    await instancia.bater();   // semeadura
    linhas = [linhaAba('r16e', { rodando: true, esperando: true, arquivo: 'A' })];   // intervencao — fica presa na rede
    await instancia.bater();

    linhas = [linhaAba('r16e', { rodando: true, esperando: false, arquivo: 'A' })];   // pergunta respondida EM VOO
    await instancia.bater();   // o laço de emVoo cancela a ficha já em voo

    d.resolver();   // agora a resposta 502 volta
    await esperarAte(() => avisos.pendentes().length === 1);
    ok(avisos.pendentes().length === 1, 'mesmo cancelada, a 1ª falha ainda enfileira');

    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    relogio.t = avisos.pendentes()[0].proximaEm;
    await avisos.processarPendentes();
    ok(chamadas === 0, 'o reenvio NÃO saiu — a ficha já estava cancelada quando a resposta voltou');
  } finally { instancia.parar(); push.enviar = enviarProibido; }
}

// R17 (parte vigia) — iniciar() chama retomar() só depois das travas, calado no erro.
async function r17Vigia() {
  console.log('\nR17 (parte vigia) — iniciar() chama retomar() só depois das travas');
  const vigia = require('../lib/vigia-abas');
  const listarVazio = async () => [];
  const avisarNoop = async () => ({ enviados: 0, removidos: 0 });
  const antes = process.env.COCKPIT_CONTATO;

  process.env.COCKPIT_CONTATO = '';
  let chamado = 0;
  const espiao = () => { chamado += 1; return 0; };
  const semContato = vigia.iniciar({ intervaloMs: 1000, listar: listarVazio, avisar: avisarNoop, retomar: espiao });
  ok(semContato === null, 'sem contato válido, iniciar() devolve null');
  ok(chamado === 0, 'e retomar() NÃO foi chamado — a trava de contato vem primeiro');

  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  chamado = 0;
  const instancia1 = vigia.iniciar({ intervaloMs: 1000, listar: listarVazio, avisar: avisarNoop, retomar: espiao });
  ok(instancia1 !== null, 'com contato válido, iniciar() sobe');
  ok(chamado === 1, 'e retomar() foi chamado exatamente uma vez');
  instancia1.parar();

  const logs = [];
  const orig = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
  const instancia2 = vigia.iniciar({
    intervaloMs: 1000, listar: listarVazio, avisar: avisarNoop,
    retomar: () => { throw new Error('SEGREDO-R35-VIGIA'); },
  });
  console.error = orig;
  ok(instancia2 !== null, 'retomar() que lança NÃO derruba o vigia — iniciar() ainda devolve a instância');
  ok(logs.some((l) => l.includes('não deu para retomar')), 'e loga "não deu para retomar"');
  ok(!logs.some((l) => l.includes('SEGREDO-R35')), 'sem vazar a mensagem do erro');
  instancia2.parar();

  process.env.COCKPIT_CONTATO = antes;
}

// R19 — a rota por HTTP de verdade, servidor filho isolado (A5: nada de assert de texto-fonte).
async function r19() {
  console.log('\nR19 — a rota por HTTP de verdade, com servidor filho isolado');
  const root = path.resolve(__dirname, '..');

  async function portaLivre() {
    const servidor = net.createServer();
    await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
    const porta = servidor.address().port;
    await new Promise((resolve) => servidor.close(resolve));
    return porta;
  }

  function post(porta, rota, corpo) {
    return new Promise((resolve, reject) => {
      const dados = Buffer.from(JSON.stringify(corpo));
      const req = http.request({
        hostname: '127.0.0.1', port: porta, path: rota, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': dados.length },
      }, (res) => {
        let texto = '';
        res.on('data', (d) => { texto += d; });
        res.on('end', () => resolve({ status: res.statusCode, texto }));
      });
      req.on('error', reject);
      req.end(dados);
    });
  }

  async function withServer(extra, tarefa) {
    const porta = await portaLivre();
    const home = fs.mkdtempSync(path.join(RAIZ, 'retry-servidor-'));
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete base[k];
    Object.assign(base, {
      HOME: home, HOST: '127.0.0.1', PORT: String(porta),
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: `cockpit-retry-${process.pid}`,
      COCKPIT_JOBS_DIR: fs.mkdtempSync(path.join(RAIZ, 'retry-jobs-servidor-')),
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_CONTATO: 'mailto:x@example.com',
      ...extra,
    });
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env: base, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout servidor')), 10000);
        child.stdout.on('data', (d) => { if (String(d).includes('cockpit-agentes em')) { clearTimeout(t); resolve(); } });
        child.once('exit', (codigo) => { clearTimeout(t); reject(new Error(`servidor saiu ${codigo}`)); });
      });
      await tarefa(porta);
    } finally {
      // #24: o filho morre no finally, exista sucesso ou falha no teste.
      if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    }
  }

  const dirComInscricao = fs.mkdtempSync(path.join(RAIZ, 'retry-push-servidor-'));
  fs.writeFileSync(path.join(dirComInscricao, 'inscricoes.json'),
    JSON.stringify([inscricao('https://127.0.0.1:1/x')]), { mode: 0o600 });
  await withServer({ COCKPIT_PUSH_DIR: dirComInscricao }, async (porta) => {
    const r = await post(porta, '/api/push/teste', {});
    ok(r.status === 502, `POST /api/push/teste devolve 502 (achei ${r.status})`);
    const corpo = JSON.parse(r.texto);
    ok(corpo.pendentes === 1, `e pendentes:1 (${JSON.stringify(corpo)})`);
    ok(typeof corpo.erro === 'string' && corpo.erro.includes('aguardando nova tentativa'),
      'e o erro cita "aguardando nova tentativa"');
  });

  const dirVazio = fs.mkdtempSync(path.join(RAIZ, 'retry-push-vazio-'));
  await withServer({ COCKPIT_PUSH_DIR: dirVazio }, async (porta) => {
    const r = await post(porta, '/api/push/teste', {});
    ok(r.status === 200, `sem inscrito, devolve 200 (achei ${r.status})`);
    const corpo = JSON.parse(r.texto);
    ok(corpo.inscritos === 0, 'e inscritos:0');
  });
}

(async () => {
  await r1();
  await r2();
  await r3();
  await r4();
  await r5();
  await r6();
  await r7();
  await r8();
  await r9();
  await r10();
  await r11();
  await r12();
  await r13();
  await r14();
  await r15();
  await r16();
  await r16b();
  await r16c();
  await r16d();
  await r16e();
  await r17SemContato();
  await r17Vigia();
  await r18Pura();
  await r18CasoOrigem();
  await r19();
  await r20();
  await r21();
  await r22();
  await r23();
  await r24();
  await r25();
  await r26();
  await r27();
  await r28();
  await r29();
  await r30();
  await r31();
  await r32();
  await r33();
  await r34();
  await r35();

  console.log(`\ngate-push-retry: ${falhas} falha(s)`);
  process.exitCode = falhas ? 1 : 0;
})().finally(() => {
  // Os casos que tiram permissão (R27, R35d) devolvem no próprio `finally`; se um deles caiu
  // no meio, o rmSync falha — e isso é informação, não motivo para o gate mentir o placar.
  try { fs.rmSync(RAIZ, { recursive: true, force: true }); }
  catch (erro) { console.log(`  ℹ️ não deu para apagar ${RAIZ} (${erro.code || erro.name})`); }
});
