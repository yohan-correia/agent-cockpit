#!/usr/bin/env node
'use strict';
// GATE — lib/entregas.js: o livro de entregas por evento × aparelho (dedupe de push).
//
// Prova a identidade pura do evento (E1), a reserva atômica no disco e os desfechos do livro
// (E2, E5, E7, E8, E9, E10, E12, E17, E18, E18b, E18c, E19). A partir da Fase 2, também prova o
// embrulho em `avisos.avisar()`; a partir da Fase 3, a identidade que `lib/vigia-abas.js` gera
// pelo carimbo de status do CLI.
//
// Nenhuma inscrição é real e nenhuma rede sai daqui: `node:https` é substituído por uma função
// que LANÇA antes de qualquer `require` do projeto, e o transporte (`push.enviar`) é sempre um
// dublê. Endpoints e chaves de aparelho são fixtures (`https://push.example/...`).
//
// ORDEM DE REQUIRE IMPORTA: nativos → bloqueio de rede → isolamento do ambiente → só então os
// módulos do projeto (`lib/avisos.js` resolve a pasta de push no próprio `require`).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

require('node:https').request = () => { throw new Error('rede proibida no gate'); };

process.env.COCKPIT_PUSH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'entregas-push-'));
const DIR_PUSH = process.env.COCKPIT_PUSH_DIR;   // fixado ANTES do require de lib/avisos
process.env.COCKPIT_CONTATO = 'mailto:gate@example.com';
delete process.env.COCKPIT_VIGIA_MS;

const entregas = require('../lib/entregas');
const avisos = require('../lib/avisos');
const push = require('../lib/push');
const vigia = require('../lib/vigia-abas');

let falhas = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) falhas += 1;
  return cond;
};

function deferido() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver: (v) => resolver(v) };
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function pastaNova() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'entregas-livro-'));
}

const EV = 'e'.repeat(32);
const resumo = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 32);

/** Captura console.log/console.error num array até `restaurar()`. */
function capturarLogs() {
  const logs = [];
  const logOriginal = console.log;
  const errorOriginal = console.error;
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { logs.push(args.join(' ')); };
  return { logs, restaurar: () => { console.log = logOriginal; console.error = errorOriginal; } };
}

function plantarReserva(raiz, evento, endpoint, conteudo) {
  const pasta = path.join(raiz, evento);
  fs.mkdirSync(pasta, { recursive: true });
  const arq = path.join(pasta, `${resumo(endpoint)}.reserva`);
  fs.writeFileSync(arq, conteudo);
  return arq;
}

// ─── E1 — identidade(), pura ─────────────────────────────────────────────────

function testarE1() {
  console.log('\nE1 — identidade(), pura');
  const base = { chave: 'aba-p1', sessaoId: 'sess-a', tipo: 'fim', marco: 1755800000123 };
  const v1 = entregas.identidade(base);
  const v2 = entregas.identidade({ ...base });
  ok(v1 === v2, 'duas chamadas iguais dão o mesmo valor');
  ok(/^[0-9a-f]{32}$/.test(v1), 'o valor casa /^[0-9a-f]{32}$/');
  ok(entregas.identidade({ ...base, chave: 'aba-p2' }) !== v1, 'trocar `chave` muda o valor');
  ok(entregas.identidade({ ...base, sessaoId: 'sess-b' }) !== v1, 'trocar `sessaoId` muda o valor');
  ok(entregas.identidade({ ...base, tipo: 'intervencao' }) !== v1, 'trocar `tipo` muda o valor');
  ok(entregas.identidade({ ...base, marco: 1755800000124 }) !== v1, 'trocar `marco` muda o valor');
  for (const marco of [null, undefined, 0, -1, NaN, '123']) {
    ok(entregas.identidade({ ...base, marco }) === null, `marco ${JSON.stringify(marco)} ⇒ null`);
  }
  ok(entregas.identidade({ sessaoId: 'sess-a', tipo: 'fim', marco: 1 }) === null, 'sem `chave` ⇒ null');
  ok(entregas.identidade({ chave: 'aba-p1', tipo: 'fim', marco: 1 }) === null, 'sem `sessaoId` ⇒ null');
  ok(entregas.identidade({ chave: 'aba-p1', sessaoId: 'sess-a', marco: 1 }) === null, 'sem `tipo` ⇒ null');
  ok(entregas.identidade() === null, 'identidade() sem argumento ⇒ null');
}

// ─── E2 — umaVez(): básico + conferência determinística ─────────────────────

async function testarE2() {
  console.log('\nE2 — umaVez(): básico + conferência determinística');
  const raiz = pastaNova();
  const livro = entregas.criar(raiz);
  let chamadas = 0;
  const tentar = async () => { chamadas += 1; return 'aceito'; };
  const endpoint = 'https://push.example/a1';
  const dest = resumo(endpoint);
  const pastaEvento = path.join(raiz, EV);

  const r1 = await livro.umaVez(EV, endpoint, tentar);
  ok(r1.tentou === true && r1.desfecho === 'aceito', '1ª chamada tenta e devolve aceito');
  ok(chamadas === 1, '1ª chamada: tentar chamado 1 vez');

  const cap = capturarLogs();
  const r2 = await livro.umaVez(EV, endpoint, tentar);
  cap.restaurar();
  ok(r2.tentou === false && r2.motivo === 'aceito', '2ª chamada não tenta, motivo aceito');
  ok(chamadas === 1, '2ª chamada: tentar continua em 1 chamada');
  ok(cap.logs.some((l) => l.includes('não reenviado')), 'o log capturado contém "não reenviado"');
  ok(fs.existsSync(path.join(pastaEvento, `${dest}.final`)), '.final existe');
  ok(!fs.existsSync(path.join(pastaEvento, `${dest}.reserva`)), 'nenhuma .reserva sobra na pasta do evento');

  // Determinístico: plantar o .final à mão, sem depender de corrida nenhuma.
  const endpoint2 = 'https://push.example/a2';
  const dest2 = resumo(endpoint2);
  fs.mkdirSync(pastaEvento, { recursive: true });
  fs.writeFileSync(path.join(pastaEvento, `${dest2}.final`), JSON.stringify({ desfecho: 'descartado', em: Date.now() }));
  let chamadas2 = 0;
  const r3 = await livro.umaVez(EV, endpoint2, async () => { chamadas2 += 1; return 'aceito'; });
  ok(r3.tentou === false && r3.motivo === 'descartado', '.final plantado ⇒ não tenta, motivo descartado');
  ok(chamadas2 === 0, 'tentar não é chamado quando o .final já existe');
  ok(!fs.existsSync(path.join(pastaEvento, `${dest2}.reserva`)), 'não sobra .reserva para o endpoint plantado');

  fs.rmSync(raiz, { recursive: true, force: true });
}

// ─── E3, E4, E6, E11, E16 — através de avisos.avisar() ──────────────────────
// A partir daqui os casos passam pela porta de `avisar()`, não por `livro.umaVez()` direto:
// provam o embrulho da Fase 2 (§4.1 da spec) e são a rede do merge com o job irmão (#56) — um
// merge que perca o embrulho reprova aqui, não passa verde.

let marcoContador = 1755800000000;
/** Um `evento` novo por caso — a identidade real (lib/entregas.js), não uma string qualquer. */
function eventoNovo() {
  marcoContador += 1;
  return entregas.identidade({ chave: 'aba-p1', sessaoId: 'sess-a', tipo: 'fim', marco: marcoContador });
}

function limparInscricoes() {
  fs.rmSync(path.join(DIR_PUSH, 'inscricoes.json'), { force: true });
}

async function testarE3() {
  console.log('\nE3 — dois aparelhos, o mesmo evento via avisar()');
  limparInscricoes();
  const a1 = { endpoint: 'https://push.example/e3-a1', keys: { p256dh: 'x', auth: 'y' } };
  const a2 = { endpoint: 'https://push.example/e3-a2', keys: { p256dh: 'x', auth: 'y' } };
  await avisos.inscrever(a1);
  await avisos.inscrever(a2);

  const contagem = new Map();
  const enviarOriginal = push.enviar;
  push.enviar = async ({ inscricao }) => {
    contagem.set(inscricao.endpoint, (contagem.get(inscricao.endpoint) || 0) + 1);
    return { status: 201 };
  };
  try {
    const evento = eventoNovo();
    const r1 = await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    ok(r1.enviados === 2, '1º avisar(): enviados === 2');
    ok(contagem.get(a1.endpoint) === 1 && contagem.get(a2.endpoint) === 1, '1 chamada por endpoint');

    const r2 = await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    ok(r2.enviados === 0, '2º avisar() com o MESMO evento: enviados === 0');
    ok(contagem.get(a1.endpoint) === 1 && contagem.get(a2.endpoint) === 1, 'o total continua 1 por endpoint');
  } finally {
    push.enviar = enviarOriginal;
  }
}

async function testarE4() {
  console.log('\nE4 — dois observadores, mesmo processo, mesmo evento');
  limparInscricoes();
  const b1 = { endpoint: 'https://push.example/e4-b1', keys: { p256dh: 'x', auth: 'y' } };
  const b2 = { endpoint: 'https://push.example/e4-b2', keys: { p256dh: 'x', auth: 'y' } };
  await avisos.inscrever(b1);
  await avisos.inscrever(b2);

  let chamadasTotais = 0;
  const jaSegurou = new Set();
  const deferidos = new Map();
  const enviarOriginal = push.enviar;
  push.enviar = async ({ inscricao }) => {
    chamadasTotais += 1;
    if (!jaSegurou.has(inscricao.endpoint)) {
      jaSegurou.add(inscricao.endpoint);
      const d = deferido();
      deferidos.set(inscricao.endpoint, d);
      await d.promessa;
    }
    return { status: 201 };
  };
  try {
    const evento = eventoNovo();
    const p1 = avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    const p2 = avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    const inicio = Date.now();
    while (deferidos.size < 2) {
      if (Date.now() - inicio > 3000) { ok(false, 'timeout esperando os dois deferidos (b1/b2)'); break; }
      await espera(5);
    }
    for (const d of deferidos.values()) d.resolver();
    const [r1, r2] = await Promise.all([p1, p2]);
    ok(chamadasTotais === 2, `total de chamadas ao dublê = 2, uma por aparelho (foi ${chamadasTotais})`);
    ok(r1.enviados + r2.enviados === 2, 'soma dos enviados das duas chamadas concorrentes = 2');
  } finally {
    push.enviar = enviarOriginal;
  }
}

async function testarE6() {
  console.log('\nE6 — resultado parcial + retry');
  limparInscricoes();
  const d1 = { endpoint: 'https://push.example/e6-d1', keys: { p256dh: 'x', auth: 'y' } };
  const d2 = { endpoint: 'https://push.example/e6-d2', keys: { p256dh: 'x', auth: 'y' } };
  await avisos.inscrever(d1);
  await avisos.inscrever(d2);

  const chamadas = new Map();
  const registrar = (endpoint) => chamadas.set(endpoint, (chamadas.get(endpoint) || 0) + 1);
  const enviarOriginal = push.enviar;
  const evento = eventoNovo();
  try {
    push.enviar = async ({ inscricao }) => {
      registrar(inscricao.endpoint);
      return { status: inscricao.endpoint === d1.endpoint ? 201 : 502 };
    };
    await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    ok(chamadas.get(d1.endpoint) === 1 && chamadas.get(d2.endpoint) === 1, '1ª chamada: 1 tentativa em cada aparelho');

    await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    ok(chamadas.get(d1.endpoint) === 1 && chamadas.get(d2.endpoint) === 2, '2ª chamada: chamou só d2 (d1 já aceito)');

    push.enviar = async ({ inscricao }) => { registrar(inscricao.endpoint); return { status: 201 }; };
    await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    ok(chamadas.get(d2.endpoint) === 3, '3ª chamada chama d2 de novo (d2 era `falhou`)');

    await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    ok(chamadas.get(d1.endpoint) === 1 && chamadas.get(d2.endpoint) === 3, '4ª chamada: nenhuma chamada nova ao dublê');
  } finally {
    push.enviar = enviarOriginal;
  }
}

async function testarE11() {
  console.log('\nE11 — 404/410 é final');
  limparInscricoes();
  const f1 = { endpoint: 'https://push.example/e11-f1', keys: { p256dh: 'x', auth: 'y' } };
  const f2 = { endpoint: 'https://push.example/e11-f2', keys: { p256dh: 'x', auth: 'y' } };
  await avisos.inscrever(f1);
  await avisos.inscrever(f2);

  const evento = eventoNovo();
  const enviarOriginal = push.enviar;
  try {
    push.enviar = async ({ inscricao }) => ({ status: inscricao.endpoint === f1.endpoint ? 410 : 201 });
    const r1 = await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    ok(r1.removidos === 1, '1ª chamada: removidos === 1');
    const lista1 = await avisos.inscricoes();
    ok(!lista1.some((i) => i.endpoint === f1.endpoint), 'f1 saiu de inscricoes()');

    await avisos.inscrever(f1);
    let chamouF1 = false;
    let chamouF2 = false;
    push.enviar = async ({ inscricao }) => {
      if (inscricao.endpoint === f1.endpoint) chamouF1 = true;
      if (inscricao.endpoint === f2.endpoint) chamouF2 = true;
      return { status: 201 };
    };
    await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x', evento });
    ok(!chamouF1, 'f1 reinscrito à mão com o MESMO evento não é chamado — final `descartado`');
    ok(!chamouF2, 'f2 (já `aceito`) também não é chamado');
  } finally {
    push.enviar = enviarOriginal;
  }
}

async function testarE16() {
  console.log('\nE16 — a bandeja não muda');
  limparInscricoes();
  const g1 = { endpoint: 'https://push.example/e16-g1', keys: { p256dh: 'x', auth: 'y' } };
  await avisos.inscrever(g1);

  let payload = null;
  const enviarOriginal = push.enviar;
  try {
    push.enviar = async ({ texto }) => { payload = JSON.parse(texto); return { status: 201 }; };
    const evento = eventoNovo();
    await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'aba-p9', tag: 'aba-p9', evento });
    ok(payload && payload.tag === 'aba-p9', 'o payload entregue tem tag === "aba-p9"');
    ok(payload && payload.sessaoId === 'aba-p9', 'o payload entregue tem sessaoId === "aba-p9"');
    ok(payload && !('evento' in payload), 'o payload entregue NÃO tem `evento`');

    let chamadas = 0;
    push.enviar = async () => { chamadas += 1; return { status: 201 }; };
    await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'aba-p9', tag: 'aba-p9' });
    await avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'aba-p9', tag: 'aba-p9' });
    ok(chamadas === 2, 'avisar() sem `evento` (como o botão testar) continua entregando toda vez (2 chamadas)');
  } finally {
    push.enviar = enviarOriginal;
  }
}

// ─── E13, E15 — a identidade que lib/vigia-abas.js gera (Fase 3) ────────────

/** Uma linha no formato de `abas.listar()`, mais `sessaoId` e `statusDesde` (identidade). */
function linhaVigia(chave, over = {}) {
  return {
    chave,
    titulo: over.titulo ?? chave,
    cwd: 'cwd' in over ? over.cwd : null,
    temAgente: over.temAgente ?? true,
    rodando: 'rodando' in over ? over.rodando : null,
    esperando: 'esperando' in over ? over.esperando : null,
    arquivo: 'arquivo' in over ? over.arquivo : null,
    reiniciada: over.reiniciada ?? false,
    sessaoId: over.sessaoId ?? 'sess-a',
    statusDesde: 'statusDesde' in over ? over.statusDesde : undefined,
  };
}

function testarE13a() {
  console.log('\nE13a — mesma leitura, mesmo evento (dois observadores independentes)');
  const S0 = 1755800000100;
  const S1 = 1755800000200;
  const L0 = linhaVigia('aba-p1', { rodando: true, esperando: false, statusDesde: S0 });
  const L1 = linhaVigia('aba-p1', { rodando: false, esperando: false, statusDesde: S1 });

  function rodarObservador() {
    const semeadura = vigia.decidir(null, [L0]);
    const r = vigia.decidir(semeadura.estado, [L1]);
    return r.avisos.find((a) => a.tipo === 'fim');
  }

  const fim1 = rodarObservador();
  const fim2 = rodarObservador();
  ok(Boolean(fim1) && Boolean(fim2), 'os dois observadores independentes emitiram `fim`');
  ok(fim1 && /^[0-9a-f]{32}$/.test(fim1.evento), 'o evento é uma string de 32 hex');
  ok(fim1 && fim2 && fim1.evento === fim2.evento, 'o MESMO evento nos dois observadores');
  ok(fim1 && fim1.marcoParado === false, 'marcoParado === false');
}

function testarE13b() {
  console.log('\nE13b — duas intervenções seguidas');
  const S0 = 1755800001000, S1 = 1755800001100, S2 = 1755800001200, S3 = 1755800001300;
  const L0 = linhaVigia('aba-p2', { rodando: true, esperando: false, statusDesde: S0 });
  let { estado } = vigia.decidir(null, [L0]);

  const L1 = linhaVigia('aba-p2', { rodando: true, esperando: true, statusDesde: S1 });
  const r1 = vigia.decidir(estado, [L1]);
  estado = r1.estado;
  const i1 = r1.avisos.find((a) => a.tipo === 'intervencao');
  ok(Boolean(i1), 'a 1ª intervenção saiu');

  const L2 = linhaVigia('aba-p2', { rodando: true, esperando: false, statusDesde: S2 });
  const r2 = vigia.decidir(estado, [L2]);
  estado = r2.estado;

  const L3 = linhaVigia('aba-p2', { rodando: true, esperando: true, statusDesde: S3 });
  const r3 = vigia.decidir(estado, [L3]);
  const i2 = r3.avisos.find((a) => a.tipo === 'intervencao');
  ok(Boolean(i2), 'a 2ª intervenção saiu');
  ok(i1 && i2 && i1.evento !== i2.evento, 'os dois avisos de intervenção têm eventos diferentes');
}

function testarE13c() {
  console.log('\nE13c — intervenção e depois fim');
  const S0 = 1755800002000, S1 = 1755800002100, S2 = 1755800002200, S3 = 1755800002300;
  const L0 = linhaVigia('aba-p3', { rodando: true, esperando: false, statusDesde: S0 });
  let { estado } = vigia.decidir(null, [L0]);

  const L1 = linhaVigia('aba-p3', { rodando: true, esperando: true, statusDesde: S1 });
  const r1 = vigia.decidir(estado, [L1]);
  estado = r1.estado;
  const intervencao = r1.avisos.find((a) => a.tipo === 'intervencao');

  const L2 = linhaVigia('aba-p3', { rodando: true, esperando: false, statusDesde: S2 });
  const r2 = vigia.decidir(estado, [L2]);
  estado = r2.estado;

  const L3 = linhaVigia('aba-p3', { rodando: false, esperando: false, statusDesde: S3 });
  const r3 = vigia.decidir(estado, [L3]);
  const fim = r3.avisos.find((a) => a.tipo === 'fim');

  ok(Boolean(intervencao) && Boolean(fim), 'saíram intervenção e fim');
  ok(intervencao && fim && intervencao.evento !== fim.evento, 'intervenção e fim têm eventos diferentes');
}

function testarE13d() {
  console.log('\nE13d — abas diferentes, mesma borda');
  const S0 = 1755800003000, S1 = 1755800003100;
  const L0a = linhaVigia('aba-p1', { rodando: true, esperando: false, statusDesde: S0, sessaoId: 'sess-x' });
  const L0b = linhaVigia('aba-p2', { rodando: true, esperando: false, statusDesde: S0, sessaoId: 'sess-y' });
  let { estado } = vigia.decidir(null, [L0a, L0b]);

  const L1a = linhaVigia('aba-p1', { rodando: false, esperando: false, statusDesde: S1, sessaoId: 'sess-x' });
  const L1b = linhaVigia('aba-p2', { rodando: false, esperando: false, statusDesde: S1, sessaoId: 'sess-y' });
  const r = vigia.decidir(estado, [L1a, L1b]);
  const fimA = r.avisos.find((a) => a.chave === 'aba-p1');
  const fimB = r.avisos.find((a) => a.chave === 'aba-p2');
  ok(Boolean(fimA) && Boolean(fimB), 'as duas abas emitiram fim na mesma borda');
  ok(fimA && fimB && fimA.evento !== fimB.evento, 'eventos diferentes entre abas diferentes');
}

function testarE13e() {
  console.log('\nE13e — Codex (sem statusDesde)');
  const L0 = linhaVigia('aba-p4', { rodando: true, esperando: false, sessaoId: 'sess-codex' });
  let { estado } = vigia.decidir(null, [L0]);
  const L1 = linhaVigia('aba-p4', { rodando: false, esperando: false, sessaoId: 'sess-codex' });
  const r = vigia.decidir(estado, [L1]);
  const fim = r.avisos.find((a) => a.tipo === 'fim');
  ok(Boolean(fim) && fim.evento === null, 'sem `statusDesde`: evento === null');
  ok(Boolean(fim) && fim.marcoParado === false, 'marcoParado === false (não há carimbo para comparar)');
}

function testarE13f() {
  console.log('\nE13f — marco parado');
  const S0 = 1755800005000;
  const L0 = linhaVigia('aba-p5', { rodando: true, esperando: false, statusDesde: S0 });
  let { estado } = vigia.decidir(null, [L0]);
  const L1 = linhaVigia('aba-p5', { rodando: false, esperando: false, statusDesde: S0 });
  const r = vigia.decidir(estado, [L1]);
  const fim = r.avisos.find((a) => a.tipo === 'fim');
  ok(Boolean(fim) && fim.evento === null, 'carimbo igual ao guardado: evento === null');
  ok(Boolean(fim) && fim.marcoParado === true, 'marcoParado === true');
}

function testarE13g() {
  console.log('\nE13g — leitura sem carimbo no meio preserva o último conhecido');
  const S1 = 1755800006100;
  const L0 = linhaVigia('aba-p6', { rodando: true, esperando: false, statusDesde: S1 });
  let { estado } = vigia.decidir(null, [L0]);

  const L1 = linhaVigia('aba-p6', { rodando: true, esperando: false, statusDesde: null });
  const r1 = vigia.decidir(estado, [L1]);
  estado = r1.estado;
  ok(estado.get('aba-p6').statusDesde === S1, 'a leitura sem carimbo preservou o S1 conhecido');

  const L2 = linhaVigia('aba-p6', { rodando: false, esperando: false, statusDesde: S1 });
  const r2 = vigia.decidir(estado, [L2]);
  const fim = r2.avisos.find((a) => a.tipo === 'fim');
  ok(Boolean(fim) && fim.evento === null, 'o marco velho S1 não foi aprovado de novo: evento === null');
  ok(Boolean(fim) && fim.marcoParado === true, 'marcoParado === true');
}

function testarE13h() {
  console.log('\nE13h — `trocou` com o mesmo carimbo');
  // A aba JÁ está esperando quando a conversa troca: sem o `trocou`, tela true → true não é
  // borda nenhuma. É o `trocou` que zera o `telaAntes` (lib/vigia-abas.js) e faz sair a
  // intervenção — e é ele que libera o MESMO carimbo, porque o `sessaoId` novo já muda a identidade.
  const S1 = 1755800007100;
  const L0 = linhaVigia('aba-p7', {
    rodando: false, esperando: true, statusDesde: S1, arquivo: '/tmp/x.jsonl', sessaoId: 'sess-velha',
  });
  let { estado } = vigia.decidir(null, [L0]);

  const L1 = linhaVigia('aba-p7', {
    rodando: false, esperando: true, statusDesde: S1, arquivo: '/tmp/y.jsonl', sessaoId: 'sess-nova',
  });
  const r = vigia.decidir(estado, [L1]);
  const intervencao = r.avisos.find((a) => a.tipo === 'intervencao');
  ok(Boolean(intervencao), 'esperando → esperando com a conversa trocada: a intervenção sai');
  ok(Boolean(intervencao) && /^[0-9a-f]{32}$/.test(intervencao.evento), '`trocou` libera o mesmo carimbo: evento não nulo');
  ok(Boolean(intervencao) && intervencao.marcoParado === false, 'marcoParado === false');
  const velho = entregas.identidade({ chave: 'aba-p7', sessaoId: 'sess-velha', tipo: 'intervencao', marco: S1 });
  ok(Boolean(intervencao) && intervencao.evento !== velho, 'e o evento difere do da conversa velha com o mesmo carimbo');
}

async function testarE13i() {
  console.log('\nE13i — o canário do marco parado (via iniciar())');
  const S1 = 1755800008100;
  let vez = 0;
  const linhasPorVez = [
    [linhaVigia('aba-p8', { rodando: true, esperando: false, statusDesde: S1 })],   // semeadura
    [linhaVigia('aba-p8', { rodando: false, esperando: false, statusDesde: S1 })],  // 1ª borda, marco parado
    [linhaVigia('aba-p8', { rodando: true, esperando: false, statusDesde: S1 })],   // volta a rodar
    [linhaVigia('aba-p8', { rodando: false, esperando: false, statusDesde: S1 })],  // 2ª borda, marco parado
  ];
  const listarMock = async () => {
    const l = linhasPorVez[Math.min(vez, linhasPorVez.length - 1)];
    vez += 1;
    return l;
  };
  const recebidos = [];
  const espiao = async (p) => { recebidos.push(p); return { enviados: 0, removidos: 0 }; };

  const cap = capturarLogs();
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: listarMock, avisar: espiao });
  try {
    await espera(30);   // deixa a semeadura (dentro do iniciar()) terminar antes de mudar a leitura
    await instancia.bater();
    await espera(30);
    await instancia.bater();
    await espera(30);
    await instancia.bater();
    await espera(30);
  } finally {
    instancia.parar();
    cap.restaurar();
  }

  const linhasNaoAndou = cap.logs.filter((l) => l.includes('não andou'));
  ok(linhasNaoAndou.length === 1, `console.error tem exatamente uma linha com "não andou" (teve ${linhasNaoAndou.length})`);
  const fins = recebidos.filter((p) => p.tag === 'aba-p8');
  ok(fins.length === 2, `o espião recebeu dois avisos fim (recebeu ${fins.length})`);
  ok(fins.every((p) => p.evento === null), 'os dois avisos fim têm evento: null');
}

async function testarE15() {
  console.log('\nE15 — dois vigias de ponta a ponta');
  limparInscricoes();
  const h1 = { endpoint: 'https://push.example/e15-h1', keys: { p256dh: 'x', auth: 'y' } };
  const h2 = { endpoint: 'https://push.example/e15-h2', keys: { p256dh: 'x', auth: 'y' } };
  await avisos.inscrever(h1);
  await avisos.inscrever(h2);

  let chamadasDuble = 0;
  const enviarOriginal = push.enviar;
  push.enviar = async () => { chamadasDuble += 1; return { status: 201 }; };

  const S0 = 1755800009000;
  const S1 = 1755800009100;
  let linhaAtual = [linhaVigia('aba-p9', { rodando: true, esperando: false, statusDesde: S0, sessaoId: 'sess-p9' })];
  const listarCompartilhado = async () => linhaAtual.slice();

  const cap = capturarLogs();
  const a = vigia.iniciar({ intervaloMs: 1000, listar: listarCompartilhado });
  const b = vigia.iniciar({ intervaloMs: 1000, listar: listarCompartilhado });
  try {
    await espera(30);   // deixa a semeadura automática de cada instância terminar

    await a.bater();
    await b.bater();

    linhaAtual = [linhaVigia('aba-p9', { rodando: false, esperando: false, statusDesde: S1, sessaoId: 'sess-p9' })];
    await a.bater();
    await b.bater();

    const inicio = Date.now();
    while (chamadasDuble < 2) {
      if (Date.now() - inicio > 3000) { ok(false, 'timeout esperando o dublê chegar a 2 chamadas'); break; }
      await espera(10);
    }
    await espera(200);
  } finally {
    a.parar();
    b.parar();
    cap.restaurar();
    push.enviar = enviarOriginal;
  }

  ok(chamadasDuble === 2, `total de chamadas ao dublê = 2, uma por aparelho, nunca 4 (foi ${chamadasDuble})`);
  // Um "não reenviado" por aparelho: o segundo vigia pula h1 e h2 (já aceitos ou em voo).
  const pulos = cap.logs.filter((l) => l.includes('não reenviado'));
  ok(pulos.length === 2, `o log tem exatamente duas linhas "não reenviado", uma por aparelho (teve ${pulos.length})`);
}

// ─── E5 — dois processos, mesmo evento, 5 aparelhos ─────────────────────────

async function testarE5() {
  console.log('\nE5 — dois processos, mesmo evento, 5 aparelhos');
  const raiz = pastaNova();
  const log = path.join(raiz, 'log.txt');
  const gatilho = path.join(raiz, 'gatilho');
  const lib = path.join(__dirname, '..', 'lib', 'entregas.js');
  const env = { ...process.env, PASTA: raiz, LOG: log, GATILHO: gatilho, LIB: lib, EV };

  const script = `
    'use strict';
    const fs = require('node:fs');
    const entregas = require(process.env.LIB);
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      fs.writeFileSync(process.env.LOG + '.pronto.' + process.pid, '');
      while (!fs.existsSync(process.env.GATILHO)) { await espera(5); }
      const livro = entregas.criar(process.env.PASTA);
      await Promise.all([1, 2, 3, 4, 5].map((i) => livro.umaVez(process.env.EV, 'https://push.example/c' + i, async () => {
        fs.appendFileSync(process.env.LOG, 'c' + i + '\\n');
        await espera(50);
        return 'aceito';
      })));
      process.exit(0);
    })();
  `;

  const filhos = [
    spawn(process.execPath, ['-e', script], { env }),
    spawn(process.execPath, ['-e', script], { env }),
  ];

  const prontos = filhos.map((f) => `${log}.pronto.${f.pid}`);
  const inicioEspera = Date.now();
  while (!prontos.every((p) => fs.existsSync(p))) {
    if (Date.now() - inicioEspera > 10000) { ok(false, 'timeout esperando os dois filhos ficarem prontos'); break; }
    await espera(5);
  }
  fs.writeFileSync(gatilho, '');

  const saidas = await Promise.all(filhos.map((f) => new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), 20000);
    f.on('exit', (codigo) => { clearTimeout(timeout); resolve(codigo); });
  })));
  ok(saidas.every((c) => c === 0), `os dois filhos saíram com código 0 (${saidas.join(',')})`);

  const linhas = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  ok(linhas.length === 5, `LOG tem exatamente 5 linhas (tem ${linhas.length})`);
  const esperadas = [1, 2, 3, 4, 5].map((i) => `c${i}`);
  ok(esperadas.every((c) => linhas.filter((l) => l === c).length === 1), 'cada aparelho (c1..c5) aparece exatamente uma vez');

  fs.rmSync(raiz, { recursive: true, force: true });
}

// ─── E7 — restart: livro novo enxerga o aceito gravado pelo anterior ────────

async function testarE7() {
  console.log('\nE7 — restart');
  const raiz = pastaNova();
  const endpoint = 'https://push.example/a1';
  const A = entregas.criar(raiz);
  await A.umaVez(EV, endpoint, async () => 'aceito');

  const B = entregas.criar(raiz);
  let chamado = false;
  const r = await B.umaVez(EV, endpoint, async () => { chamado = true; return 'aceito'; });
  ok(r.tentou === false && r.motivo === 'aceito', 'B (livro novo, mesma pasta) não tenta, motivo aceito');
  ok(!chamado, 'o tentar de B não foi chamado');
  fs.rmSync(raiz, { recursive: true, force: true });
}

// ─── E8 — incerto: não é final, tenta de novo ───────────────────────────────

async function testarE8() {
  console.log('\nE8 — incerto');
  {
    const raiz = pastaNova();
    const livro = entregas.criar(raiz);
    const endpoint = 'https://push.example/a1';
    let chamadas = 0;
    const tentar = async () => { chamadas += 1; return 'incerto'; };
    await livro.umaVez(EV, endpoint, tentar);
    await livro.umaVez(EV, endpoint, tentar);
    ok(chamadas === 2, 'incerto: a 2ª chamada tenta de novo (total 2 chamadas)');
    ok(!fs.existsSync(path.join(raiz, EV, `${resumo(endpoint)}.final`)), 'nenhum .final é gravado');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  {
    const raiz = pastaNova();
    const livro = entregas.criar(raiz);
    const endpoint = 'https://push.example/a2';
    let chamadas = 0;
    const tentarLanca = async () => { chamadas += 1; throw new Error('x'); };
    let rejeitouComOMesmoErro = false;
    try { await livro.umaVez(EV, endpoint, tentarLanca); }
    catch (erro) { rejeitouComOMesmoErro = erro.message === 'x'; }
    ok(rejeitouComOMesmoErro, 'tentar que lança: umaVez rejeita com o mesmo erro');
    ok(!fs.existsSync(path.join(raiz, EV, `${resumo(endpoint)}.reserva`)), 'não sobra .reserva depois do erro');
    await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    ok(chamadas === 2, 'a chamada seguinte tenta de novo (total 2 chamadas)');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  {
    const raiz = pastaNova();
    const livro = entregas.criar(raiz);
    const endpoint = 'https://push.example/a3';
    const r = await livro.umaVez(EV, endpoint, async () => 'bobagem');
    ok(r.tentou === true && r.desfecho === 'incerto', 'desfecho fora dos quatro valores vira incerto');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}

// ─── E9 — reserva órfã ───────────────────────────────────────────────────────

async function testarE9() {
  console.log('\nE9 — reserva órfã');
  // (a) pid vivo de OUTRO processo ⇒ em-voo, a reserva plantada continua
  {
    const raiz = pastaNova();
    const endpoint = 'https://push.example/a1';
    const arq = plantarReserva(raiz, EV, endpoint, JSON.stringify({ pid: process.ppid, token: 'x', desde: Date.now() }));
    const livro = entregas.criar(raiz, { vivo: () => true });
    let chamadas = 0;
    const r = await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    ok(r.tentou === false && r.motivo === 'em-voo', '(a) pid vivo de outro processo ⇒ em-voo');
    ok(chamadas === 0, '(a) 0 chamadas ao tentar');
    ok(fs.existsSync(arq), '(a) a reserva plantada continua lá');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  // (b) mesma reserva, `vivo` diz que o pid morreu ⇒ tenta
  {
    const raiz = pastaNova();
    const endpoint = 'https://push.example/a1';
    plantarReserva(raiz, EV, endpoint, JSON.stringify({ pid: process.ppid, token: 'x', desde: Date.now() }));
    const livro = entregas.criar(raiz, { vivo: () => false });
    let chamadas = 0;
    await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    ok(chamadas === 1, '(b) pid morto ⇒ tenta (1 chamada)');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  // (c) pid vivo, mas o relógio passou do teto ⇒ tenta
  {
    const raiz = pastaNova();
    const endpoint = 'https://push.example/a1';
    const desde = Date.now();
    plantarReserva(raiz, EV, endpoint, JSON.stringify({ pid: process.ppid, token: 'x', desde }));
    const livro = entregas.criar(raiz, { vivo: () => true, agora: () => desde + entregas.TETO_RESERVA_MS + 1000 });
    let chamadas = 0;
    await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    ok(chamadas === 1, '(c) além do teto de 5 min ⇒ tenta');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  // (d) pid DESTE processo, token que não está em voo ⇒ tenta
  {
    const raiz = pastaNova();
    const endpoint = 'https://push.example/a1';
    plantarReserva(raiz, EV, endpoint, JSON.stringify({ pid: process.pid, token: 'nao-esta-em-voo', desde: Date.now() }));
    const livro = entregas.criar(raiz);
    let chamadas = 0;
    await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    ok(chamadas === 1, '(d) pid deste processo com token fora de voo ⇒ tenta');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  // (e) reserva ilegível, mtime recente ⇒ em-voo
  {
    const raiz = pastaNova();
    const endpoint = 'https://push.example/a1';
    plantarReserva(raiz, EV, endpoint, '{quebrado');
    const livro = entregas.criar(raiz);
    let chamadas = 0;
    const r = await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    ok(r.tentou === false && r.motivo === 'em-voo', '(e) reserva ilegível recente ⇒ em-voo');
    ok(chamadas === 0, '(e) 0 chamadas ao tentar');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  // (f) mesma reserva ilegível, mtime além do prazo curto ⇒ tenta
  {
    const raiz = pastaNova();
    const endpoint = 'https://push.example/a1';
    const arq = plantarReserva(raiz, EV, endpoint, '{quebrado');
    const antigo = new Date(Date.now() - entregas.PRAZO_ILEGIVEL_MS - 1000);
    fs.utimesSync(arq, antigo, antigo);
    const livro = entregas.criar(raiz);
    let chamadas = 0;
    await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    ok(chamadas === 1, '(f) reserva ilegível velha (mtime) ⇒ tenta');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  // (g) arquivo vazio, mtime recente, mas o relógio do livro está adiantado além do prazo curto
  {
    const raiz = pastaNova();
    const endpoint = 'https://push.example/a1';
    plantarReserva(raiz, EV, endpoint, '');
    const agoraFixo = Date.now();
    const livro = entregas.criar(raiz, { agora: () => agoraFixo + entregas.PRAZO_ILEGIVEL_MS + 1000 });
    let chamadas = 0;
    await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    ok(chamadas === 1, '(g) reserva vazia + relógio do livro adiantado além do prazo curto ⇒ tenta');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}

// ─── E10 — fail-open ─────────────────────────────────────────────────────────

async function testarE10() {
  console.log('\nE10 — fail-open');
  // (a) evento null/'' tenta sempre, sem tocar disco nenhum
  {
    const base = pastaNova();
    const raiz = path.join(base, 'nao-existe');
    const livro = entregas.criar(raiz);
    let chamadas = 0;
    const r1 = await livro.umaVez(null, 'https://push.example/a1', async () => { chamadas += 1; return 'aceito'; });
    const r2 = await livro.umaVez('', 'https://push.example/a1', async () => { chamadas += 1; return 'aceito'; });
    ok(r1.tentou === true && r2.tentou === true, '(a) evento null e evento "" sempre tentam');
    ok(chamadas === 2, '(a) as duas tentaram');
    ok(!fs.existsSync(raiz), '(a) a raiz nem existe — nenhuma pasta foi criada');
    fs.rmSync(base, { recursive: true, force: true });
  }
  // (b) raiz impossível de criar (mkdir dá ENOTDIR) ⇒ tenta mesmo assim, log uma vez só
  {
    const base = pastaNova();
    const arquivoComum = path.join(base, 'arquivo');
    fs.writeFileSync(arquivoComum, 'x');
    const raiz = path.join(arquivoComum, 'sub');
    const livro = entregas.criar(raiz);
    const cap = capturarLogs();
    let chamadas = 0;
    const endpoint = 'https://push.example/b1';
    await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    await livro.umaVez(EV, endpoint, async () => { chamadas += 1; return 'aceito'; });
    cap.restaurar();
    ok(chamadas === 2, '(b) as duas chamadas tentam (fail-open)');
    const linhasReserva = cap.logs.filter((l) => l.includes('livro de entregas: reserva'));
    ok(linhasReserva.length === 1, `(b) o log "livro de entregas: reserva" aparece uma vez só (teve ${linhasReserva.length})`);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ─── E12 — retenção ──────────────────────────────────────────────────────────

async function testarE12() {
  console.log('\nE12 — retenção');
  const raiz = pastaNova();
  const agoraFixo = Date.now();
  const livro = entregas.criar(raiz, { agora: () => agoraFixo });
  await livro.umaVez(EV, 'https://push.example/a1', async () => 'aceito');
  const pastaEvento = path.join(raiz, EV);
  ok(fs.existsSync(pastaEvento), 'a pasta do evento existe');

  const n1 = await entregas.criar(raiz, { agora: () => agoraFixo + 60 * 60 * 1000 }).limpar();
  ok(n1 === 0, 'limpar() 1h depois: devolve 0');
  ok(fs.existsSync(pastaEvento), 'a pasta continua');

  const n2 = await entregas.criar(raiz, { agora: () => agoraFixo + entregas.RETENCAO_MS + 60 * 60 * 1000 }).limpar();
  ok(n2 === 1, 'limpar() além da retenção: devolve 1');
  ok(!fs.existsSync(pastaEvento), 'a pasta sumiu');

  const baseInexistente = pastaNova();
  ok(await entregas.criar(path.join(baseInexistente, 'nunca-existiu')).limpar() === 0, 'limpar() numa raiz inexistente ⇒ 0');

  fs.rmSync(raiz, { recursive: true, force: true });
  fs.rmSync(baseInexistente, { recursive: true, force: true });
}

// ─── E17 — dono antigo volta depois do teto ─────────────────────────────────

async function testarE17() {
  console.log('\nE17 — dono antigo volta depois do teto');
  const endpoint = 'https://push.example/a1';
  const dest = resumo(endpoint);
  {
    const raiz = pastaNova();
    let t = Date.now();
    const A = entregas.criar(raiz, { agora: () => t });
    const comecou = deferido();
    const soltaA = deferido();
    let chamadasA = 0;
    const tentarA = async () => { chamadasA += 1; comecou.resolver(); return soltaA.promessa; };
    const pA = A.umaVez(EV, endpoint, tentarA);
    await comecou.promessa;
    ok(chamadasA === 1, 'tentarA foi chamado 1 vez antes de A ficar preso');

    t += entregas.TETO_RESERVA_MS + 1000;
    const B = entregas.criar(raiz, { agora: () => t, vivo: () => true });
    const rB = await B.umaVez(EV, endpoint, async () => 'aceito');
    ok(rB.tentou === true && rB.desfecho === 'aceito', 'B assume a reserva vencida e aceita');
    const arqFinal = path.join(raiz, EV, `${dest}.final`);
    ok(JSON.parse(fs.readFileSync(arqFinal, 'utf8')).desfecho === 'aceito', '.final gravado por B = aceito');

    soltaA.resolver('incerto');
    await pA;
    ok(JSON.parse(fs.readFileSync(arqFinal, 'utf8')).desfecho === 'aceito', '.final continua aceito depois de A voltar com incerto');

    const r3 = await A.umaVez(EV, endpoint, async () => 'aceito');
    ok(r3.tentou === false && r3.motivo === 'aceito', 'a 3ª chamada (qualquer livro) não tenta, motivo aceito');
    fs.rmSync(raiz, { recursive: true, force: true });
  }
  // Variante: B ainda em voo quando A volta — A não apaga a reserva de B.
  {
    const raiz = pastaNova();
    let t = Date.now();
    const A = entregas.criar(raiz, { agora: () => t });
    const comecouA = deferido();
    const soltaA = deferido();
    const tentarA = async () => { comecouA.resolver(); return soltaA.promessa; };
    const pA = A.umaVez(EV, endpoint, tentarA);
    await comecouA.promessa;

    t += entregas.TETO_RESERVA_MS + 1000;
    const B = entregas.criar(raiz, { agora: () => t, vivo: () => true });
    const comecouB = deferido();
    const soltaB = deferido();
    const pB = B.umaVez(EV, endpoint, async () => { comecouB.resolver(); return soltaB.promessa; });
    await comecouB.promessa;

    const arqReserva = path.join(raiz, EV, `${dest}.reserva`);
    const reservaAntes = fs.readFileSync(arqReserva, 'utf8');

    soltaA.resolver('incerto');
    await pA;

    const reservaDepois = fs.readFileSync(arqReserva, 'utf8');
    ok(reservaAntes === reservaDepois, 'a reserva no disco continua a de B — A não a apagou');

    soltaB.resolver('aceito');
    await pB;
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}

// ─── E18 — falha ao CRIAR o final ────────────────────────────────────────────

async function testarE18() {
  console.log('\nE18 — falha ao CRIAR o final');
  const raiz = pastaNova();
  const endpoint = 'https://push.example/a1';
  const dest = resumo(endpoint);
  const fsp = require('node:fs/promises');
  const discoQuebrado = {
    ...fsp,
    writeFile: async (arq, dados, op) => {
      if (arq.endsWith('.final')) throw Object.assign(new Error('sem espaço'), { code: 'ENOSPC' });
      return fsp.writeFile(arq, dados, op);
    },
  };
  const livro = entregas.criar(raiz, { disco: discoQuebrado });
  const cap = capturarLogs();
  const r = await livro.umaVez(EV, endpoint, async () => 'aceito');
  cap.restaurar();
  ok(r.tentou === true && r.desfecho === 'aceito', 'umaVez resolve com aceito — não rejeita');
  const pastaEvento = path.join(raiz, EV);
  ok(!fs.existsSync(path.join(pastaEvento, `${dest}.reserva`)), 'não sobra .reserva');
  ok(!fs.existsSync(path.join(pastaEvento, `${dest}.final`)), 'nenhum .final foi criado');
  ok(cap.logs.filter((l) => l.includes('gravar o desfecho')).length === 1, 'logou "gravar o desfecho" uma vez');

  let chamou = false;
  const r2 = await entregas.criar(raiz).umaVez(EV, endpoint, async () => { chamou = true; return 'aceito'; });
  ok(chamou && r2.tentou === true, 'a chamada seguinte (disco normal) tenta — não fica em em-voo');
  fs.rmSync(raiz, { recursive: true, force: true });
}

// ─── E18b — falha DEPOIS de criar o final ───────────────────────────────────

async function testarE18b() {
  console.log('\nE18b — falha DEPOIS de criar o final');
  const raiz = pastaNova();
  const endpoint = 'https://push.example/a1';
  const dest = resumo(endpoint);
  const fsp = require('node:fs/promises');
  const discoQuebrado = {
    ...fsp,
    writeFile: async (arq, dados, op) => {
      if (arq.endsWith('.final')) {
        await fsp.writeFile(arq, '', op);
        throw Object.assign(new Error('erro de E/S'), { code: 'EIO' });
      }
      return fsp.writeFile(arq, dados, op);
    },
  };
  const livro = entregas.criar(raiz, { disco: discoQuebrado });
  await livro.umaVez(EV, endpoint, async () => 'aceito');
  const pastaEvento = path.join(raiz, EV);
  ok(!fs.existsSync(path.join(pastaEvento, `${dest}.reserva`)), 'não sobra .reserva');
  const arqFinal = path.join(pastaEvento, `${dest}.final`);
  ok(fs.existsSync(arqFinal) && fs.readFileSync(arqFinal, 'utf8') === '', '.final existe vazio');

  const r2 = await livro.umaVez(EV, endpoint, async () => 'aceito');
  ok(r2.tentou === false && r2.motivo === 'aceito', 'a chamada seguinte não tenta — motivo aceito');
  fs.rmSync(raiz, { recursive: true, force: true });
}

// ─── E18c — reserva criada e não escrita ────────────────────────────────────

async function testarE18c() {
  console.log('\nE18c — reserva criada e não escrita');
  const raiz = pastaNova();
  const endpoint = 'https://push.example/a1';
  const fsp = require('node:fs/promises');
  let jaFalhou = false;
  const discoQuebrado = {
    ...fsp,
    writeFile: async (arq, dados, op) => {
      if (arq.endsWith('.reserva') && !jaFalhou) {
        jaFalhou = true;
        await fsp.writeFile(arq, '', op);
        throw Object.assign(new Error('sem espaço'), { code: 'ENOSPC' });
      }
      return fsp.writeFile(arq, dados, op);
    },
  };
  const cap = capturarLogs();
  let chamou1 = false;
  const r1 = await entregas.criar(raiz, { disco: discoQuebrado }).umaVez(EV, endpoint, async () => { chamou1 = true; return 'aceito'; });
  cap.restaurar();
  ok(chamou1 && r1.tentou === true, '1ª chamada tenta (fail-open) apesar da reserva não escrita');
  ok(cap.logs.filter((l) => l.includes('reserva')).length === 1, 'logou "reserva" uma vez');

  const r2 = await entregas.criar(raiz).umaVez(EV, endpoint, async () => 'aceito');
  ok(r2.tentou === false && r2.motivo === 'em-voo', '2ª chamada logo em seguida ⇒ em-voo (a reserva vazia é recente)');

  const agoraFixo = Date.now();
  let chamou3 = false;
  const r3 = await entregas.criar(raiz, { agora: () => agoraFixo + entregas.PRAZO_ILEGIVEL_MS + 1000 })
    .umaVez(EV, endpoint, async () => { chamou3 = true; return 'aceito'; });
  ok(chamou3 && r3.tentou === true, '3ª chamada com relógio adiantado além do prazo curto ⇒ tenta (não presa até o teto de 5 min)');
  fs.rmSync(raiz, { recursive: true, force: true });
}

// ─── E19 — mesmo processo, na janela da reserva ─────────────────────────────

async function testarE19() {
  console.log('\nE19 — mesmo processo, na janela da reserva');
  const raiz = pastaNova();
  const endpoint = 'https://push.example/a1';
  const dest = resumo(endpoint);
  const fsp = require('node:fs/promises');
  const dFinal = deferido();
  let primeiraLeituraFinal = true;
  const discoLento = {
    ...fsp,
    readFile: async (arq, enc) => {
      if (arq.endsWith('.final') && primeiraLeituraFinal) {
        primeiraLeituraFinal = false;
        await dFinal.promessa;
      }
      return fsp.readFile(arq, enc);
    },
  };
  const livro = entregas.criar(raiz, { disco: discoLento });
  let chamadas = 0;
  const tentar = async () => { chamadas += 1; return 'aceito'; };

  const p1 = livro.umaVez(EV, endpoint, tentar);
  const arqReserva = path.join(raiz, EV, `${dest}.reserva`);
  const inicio = Date.now();
  while (!fs.existsSync(arqReserva)) {
    if (Date.now() - inicio > 3000) { ok(false, 'timeout esperando a .reserva existir'); break; }
    await espera(5);
  }
  const reservaAntes = fs.readFileSync(arqReserva, 'utf8');

  const r2 = await livro.umaVez(EV, endpoint, tentar);
  ok(r2.tentou === false && r2.motivo === 'em-voo', '2ª chamada concorrente, mesmo processo ⇒ em-voo');
  const reservaDepois = fs.readFileSync(arqReserva, 'utf8');
  ok(reservaAntes === reservaDepois, 'a .reserva no disco ainda é a da 1ª chamada (mesmo token)');

  dFinal.resolver();
  const r1 = await p1;
  ok(r1.tentou === true, 'a 1ª chamada termina com tentou:true');
  ok(chamadas === 1, 'total de chamadas a tentar = 1');
  fs.rmSync(raiz, { recursive: true, force: true });
}

// ─── Execução ────────────────────────────────────────────────────────────────

// ─── E20 — o `rotulo` na linha do log (card `nome-do-aparelho-no-push`, 2026-09-15) ─────────
//
// Esta é a ÚNICA saída de log do módulo, e até aqui os asserts olhavam só
// `includes('não reenviado')`: o nome do aparelho não seria conferido por ninguém.

async function testarE20() {
  console.log('\nE20 — o 4º argumento { rotulo } na linha do "não reenviado"');
  const raiz = pastaNova();
  const endpoint = 'https://push.example/e20';
  const dest = resumo(endpoint);
  const livro = entregas.criar(raiz);
  const tentar = async () => 'aceito';

  await livro.umaVez(EV, endpoint, tentar, { rotulo: 'Notebook' });
  let cap = capturarLogs();
  await livro.umaVez(EV, endpoint, tentar, { rotulo: 'Notebook' });   // esta é a que dedupa
  cap.restaurar();
  const comRotulo = cap.logs.find((l) => l.includes('não reenviado')) || '';
  ok(comRotulo.includes(`aparelho ${dest.slice(0, 8)} (Notebook)`),
    `com rótulo, o nome vem DEPOIS do id do aparelho (achei "${comRotulo}")`);

  // E sem o 4º argumento a linha sai EXATAMENTE como sempre saiu — caractere por caractere.
  // É o que mantém verdes os asserts que já existiam neste arquivo.
  const raiz2 = pastaNova();
  const livro2 = entregas.criar(raiz2);
  await livro2.umaVez(EV, endpoint, tentar);
  cap = capturarLogs();
  await livro2.umaVez(EV, endpoint, tentar);
  cap.restaurar();
  const semRotulo = cap.logs.find((l) => l.includes('não reenviado')) || '';
  ok(semRotulo === `livro de entregas: aviso ${EV.slice(0, 8)} → aparelho ${dest.slice(0, 8)}: aceito, não reenviado`,
    `sem rótulo, a linha é byte a byte a de hoje (achei "${semRotulo}")`);
}

async function main() {
  testarE1();
  await testarE2();
  await testarE3();
  await testarE4();
  await testarE5();
  await testarE6();
  await testarE7();
  await testarE8();
  await testarE9();
  await testarE10();
  await testarE11();
  await testarE12();
  testarE13a();
  testarE13b();
  testarE13c();
  testarE13d();
  testarE13e();
  testarE13f();
  testarE13g();
  testarE13h();
  await testarE13i();
  await testarE15();
  await testarE16();
  await testarE17();
  await testarE18();
  await testarE18b();
  await testarE18c();
  await testarE19();
  await testarE20();

  if (falhas === 0) {
    console.log('\n✅ GATE VERDE — lib/entregas.js\n');
    process.exitCode = 0;
  } else {
    console.log(`\n❌ GATE VERMELHO (${falhas} falha(s)) — lib/entregas.js\n`);
    process.exitCode = 1;
  }
}

// A pasta de push de mentira sai junto com o gate — sem isso cada `npm test` deixaria uma em /tmp.
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .then(() => fs.rmSync(DIR_PUSH, { recursive: true, force: true }));
