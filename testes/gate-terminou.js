#!/usr/bin/env node
'use strict';
// GATE de `lib/terminou.js` (D69): o fim de turno se VÊ ou se CONFIRMA, nunca se infere de uma
// leitura só. Node puro: sem servidor, sem tmux, sem disco. Spec:
// docs/superpowers/specs/2026-10-07-fila-so-sobe-quando-o-turno-acaba-design.md (S2 e §5.1).
//
// A fiação do `server.js` (que não se pode `require`: sobe na porta de produção) é conferida
// por texto-fonte, no T16.
//
// Uso:  node testes/gate-terminou.js

const fs = require('node:fs');
const path = require('node:path');

const terminou = require('../lib/terminou');

let falhas = 0;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };

const aba = (extra) => ({ sessaoId: 's', rodando: false, atualizadoEm: null, statusDesde: null, ...extra });
// Relógio de leitura próprio: só cresce. Uma leitura = [inicio, fim] estritamente depois da anterior.
let t = 1e6;
const leitura = () => ({ inicio: ++t, fim: ++t });
const ler = (abas, lidoDe) => terminou.observar(abas, lidoDe, leitura());
const fimDe = (abas, i = 0) => abas[i].terminouEm;

// Promessa controlada pelo teste.
const adiada = () => { let resolve; const promessa = new Promise((r) => { resolve = r; }); return { promessa, resolve }; };

function t1() {
  terminou._zerar();
  const r = ler([aba({ atualizadoEm: 100 })]);
  ok(fimDe(r) === 100, 'T1 1ª leitura parada: terminouEm = atualizadoEm');
}

function t2() {
  terminou._zerar();
  let r = ler([aba({ rodando: true, atualizadoEm: 500 })], () => 300);
  ok(fimDe(r) === 300, 'T2 1ª leitura rodando com lidoEm: a semente é o lidoEm');
  r = ler([aba({ rodando: true, atualizadoEm: 600 })], () => 400);
  ok(fimDe(r) === 300, 'T2 a semente NÃO acompanha um lidoEm que cresce nas leituras seguintes ainda rodando');
  terminou._zerar();
  r = ler([aba({ rodando: true, atualizadoEm: 500 })], () => undefined);
  ok(fimDe(r) === null, 'T2 1ª leitura rodando sem lidoEm: terminouEm null');
}

function t3() {
  terminou._zerar();
  ler([aba({ atualizadoEm: 50 })]);
  const lidos = [100, 200, 300].map((a) => fimDe(ler([aba({ rodando: true, atualizadoEm: a })])));
  ok(lidos.every((v) => v === 50), `T3 congela: rodando com atualizadoEm 100→200→300 mantém o da parada anterior — ${JSON.stringify(lidos)}`);
  terminou._zerar();
  ler([aba({ atualizadoEm: 50 })]);
  const nulos = [100, 200, 300].map((a) => fimDe(ler([aba({ rodando: null, atualizadoEm: a })])));
  ok(nulos.every((v) => v === 50), `T3 congela também com rodando: null — ${JSON.stringify(nulos)}`);
}

function t4() {
  terminou._zerar();
  ler([aba({ atualizadoEm: 100 })]);
  ler([aba({ rodando: true, atualizadoEm: 100 })]);
  const r = ler([aba({ atualizadoEm: 150, statusDesde: 900 })]);
  ok(fimDe(r) === 900, 'T4 viu parar (Claude): pergunta depois de ferramenta vale o statusDesde, não o atualizadoEm');
}

function t5() {
  terminou._zerar();
  ler([aba({ atualizadoEm: 100 })]);
  ler([aba({ rodando: true, atualizadoEm: 100 })]);
  // Sem `statusDesde` a parada vista não basta: a fala pode ser a do ENVIO lida por uma captura velha
  // (T20). Ela CONFIRMA como candidato — uma leitura depois.
  let r = ler([aba({ atualizadoEm: 150, statusDesde: null })]);
  ok(fimDe(r) === 100, 'T5 viu parar (Codex, sem statusDesde): na 1ª leitura parada ainda não sobe (vira candidato)');
  r = ler([aba({ atualizadoEm: 150, statusDesde: null })]);
  ok(fimDe(r) === 150, 'T5 viu parar (Codex): a leitura seguinte confirma — terminouEm = atualizadoEm da parada');
}

function t6() {
  terminou._zerar();
  ler([aba({ rodando: true, atualizadoEm: 400 })]);
  let r = ler([aba({ atualizadoEm: 450, statusDesde: 500 })]);
  ok(fimDe(r) === 500, 'T6 waiting no meio do turno: rodando → parada sobe para o statusDesde (500)');
  r = ler([aba({ rodando: true, atualizadoEm: 700 })]);
  ok(fimDe(r) === 500, 'T6 aprovado (rodando de novo): congela em 500');
  r = ler([aba({ atualizadoEm: 750, statusDesde: 800 })]);
  ok(fimDe(r) === 800, 'T6 o fim do turno sobe de novo (800)');
}

function t7() {
  terminou._zerar();
  ler([aba({ atualizadoEm: 100, statusDesde: 50 })]);
  const r = ler([aba({ atualizadoEm: 100, statusDesde: 60 })]);
  ok(fimDe(r) === 100, 'T7 idle → shell sem fala nova (parada → parada, statusDesde muda): não muda');
}

function t8() {
  terminou._zerar();
  ler([aba({ atualizadoEm: 100 })]);
  let r = ler([aba({ atualizadoEm: 200 })]);
  ok(fimDe(r) === 100, 'T8 candidato: parada → parada com fala nova NÃO avança na 1ª leitura');
  r = ler([aba({ atualizadoEm: 200 })]);
  ok(fimDe(r) === 200, 'T8 a mesma fala parada numa leitura que começou depois do fim da anterior → 200');
}

function t9() {
  terminou._zerar();
  ler([aba({ sessaoId: 'A', atualizadoEm: 10000 }), aba({ sessaoId: 'B', atualizadoEm: 11000 })]);
  const passos = [
    [aba({ sessaoId: 'A', atualizadoEm: 11500, statusDesde: 10050 }), 'A parada com a fala do envio (estado velho)'],
    [aba({ sessaoId: 'A', rodando: true, atualizadoEm: 11500 }), 'A rodando'],
    [aba({ sessaoId: 'A', rodando: true, atualizadoEm: 11500 }), 'A rodando de novo'],
  ];
  for (const [a, rotulo] of passos) {
    const r = ler([a, aba({ sessaoId: 'B', atualizadoEm: 11000 })]);
    const ordem = [...r].sort((x, y) => (y.terminouEm || 0) - (x.terminouEm || 0)).map((x) => x.sessaoId).join('');
    ok(r[0].terminouEm === 10000 && ordem === 'BA', `T9 corrida do envio — ${rotulo}: A continua 10000 e B fica acima (${ordem})`);
  }
}

function t10() {
  terminou._zerar();
  terminou.observar([aba({ sessaoId: 'A', atualizadoEm: 10000 })], undefined, { inicio: 1, fim: 2 });
  let r = terminou.observar([aba({ sessaoId: 'A', atualizadoEm: 11500, statusDesde: 10050 })], undefined, { inicio: 10, fim: 30 });
  ok(fimDe(r) === 10000, 'T10 1ª leitura com o par velho: A continua 10000');
  r = terminou.observar([aba({ sessaoId: 'A', atualizadoEm: 11500, statusDesde: 10050 })], undefined, { inicio: 20, fim: 40 });
  ok(fimDe(r) === 10000, 'T10 2ª leitura com o par velho, janela SOBREPOSTA: não confirma, A continua 10000');
  r = terminou.observar([aba({ sessaoId: 'A', rodando: true, atualizadoEm: 11500 })], undefined, { inicio: 50, fim: 60 });
  ok(fimDe(r) === 10000, 'T10 a leitura seguinte (rodando: true) mata o candidato: 10000');
}

function t11() {
  terminou._zerar();
  ler([aba({ atualizadoEm: 100, statusDesde: 10 })]);
  let r = ler([aba({ atualizadoEm: 100, statusDesde: 99 })]);
  ok(fimDe(r) === 100, 'T11 CLI reiniciado com a aba parada (statusDesde novo, mesma fala): não muda');
  terminou._zerar();
  ler([aba({ rodando: true, atualizadoEm: 80 })]);
  r = ler([aba({ atualizadoEm: 100, statusDesde: 700 })]);
  ok(fimDe(r) === 700, 'T11 aba que estava rodando e volta parada (S3): vale o statusDesde novo');
}

function t12() {
  terminou._zerar();
  ler([aba({ rodando: true, atualizadoEm: 700 })]);
  let r = ler([aba({ atualizadoEm: 800, statusDesde: 900 })]);
  ok(fimDe(r) === 900, 'T12 base: viu parar com statusDesde 900');
  ler([aba({ rodando: true, atualizadoEm: 800 })]);
  r = ler([aba({ atualizadoEm: 650, statusDesde: 700 })]);
  ok(fimDe(r) === 900, 'T12 Math.max: transição repetida fora de ordem (700) não puxa para trás — continua 900');
}

function t13() {
  terminou._zerar();
  let r = ler([aba({ sessaoId: undefined, atualizadoEm: 100 })]);
  ok(r[0].terminouEm === null, 'T13 aba sem sessaoId: terminouEm null');
  terminou._zerar();
  ler([aba({ sessaoId: 'a', rodando: true, atualizadoEm: 50 }), aba({ sessaoId: 'b', rodando: true, atualizadoEm: 60 })]);
  ler([aba({ sessaoId: 'a', atualizadoEm: 100, statusDesde: 900 }), aba({ sessaoId: 'b', atualizadoEm: 200, statusDesde: 950 })]);
  r = ler([aba({ sessaoId: null, atualizadoEm: 100 }), aba({ sessaoId: null, atualizadoEm: 200 })]);
  ok(r.every((x) => x.terminouEm === null), 'T13 leitura com todas as abas sem sessaoId (a falha da #61): tudo null');
  r = ler([aba({ sessaoId: 'a', atualizadoEm: 100 }), aba({ sessaoId: 'b', atualizadoEm: 200 })]);
  ok(r[0].terminouEm === 900 && r[1].terminouEm === 950,
    `T13 a leitura seguinte, com os ids de volta, devolve os valores de antes (o mapa não foi tocado) — ${r[0].terminouEm}/${r[1].terminouEm}`);
}

function t14() {
  terminou._zerar();
  const abas = [];
  for (let i = 0; i < terminou.TETO; i += 1) abas.push(aba({ sessaoId: `id-${i}`, atualizadoEm: 1000 + i }));
  abas.push(aba({ sessaoId: 'ultimo', atualizadoEm: 1 }));   // o recém-gravado É o menor
  ler(abas);
  const r = ler([
    aba({ sessaoId: 'ultimo', rodando: true, atualizadoEm: 5000 }),
    aba({ sessaoId: 'id-1', rodando: true, atualizadoEm: 5000 }),
    aba({ sessaoId: 'id-0', rodando: true, atualizadoEm: 5000 }),   // por último: reler id-0 regrava e poda de novo
  ], (id) => (id === 'id-0' ? 7 : undefined));
  ok(r[2].terminouEm === 7, `T14 TETO+1: o de menor terminouEm (id-0) saiu — lido de novo, vira 1ª leitura (semente 7) — ${r[2].terminouEm}`);
  ok(r[0].terminouEm === 1, `T14 o recém-gravado ficou, mesmo sendo o menor — ${r[0].terminouEm}`);
  ok(r[1].terminouEm === 1001, `T14 os demais continuam no mapa — ${r[1].terminouEm}`);
}

async function t15() {
  terminou._zerar();
  const lista = () => [aba({ sessaoId: 'p', atualizadoEm: 100 })];
  const f = terminou.listarComFim({ listar: async () => lista(), mapaDeLidas: async () => ({}) });
  let r = await f();
  ok(Array.isArray(r) && r.length === 1 && r[0].terminouEm === 100, 'T15 listarComFim devolve a lista com terminouEm');

  terminou._zerar();
  const g = terminou.listarComFim({
    listar: async () => [aba({ sessaoId: 'z', rodando: true, atualizadoEm: 900 })],
    mapaDeLidas: async () => ({ z: 77, outro: 5 }),
  });
  r = await g();
  ok(r[0].terminouEm === 77, `T15 a semente usa o carimbo de mapaDeLidas daquele sessaoId — ${r[0].terminouEm}`);

  terminou._zerar();
  let lancou = false; let vazio;
  try { vazio = await terminou.listarComFim({ listar: async () => [], mapaDeLidas: async () => ({}) })(); } catch { lancou = true; }
  ok(!lancou && Array.isArray(vazio) && vazio.length === 0, 'T15 lista vazia devolve [] sem lançar');

  // Sobreposição real: duas chamadas seguradas, soltas na ordem inversa, com o par velho.
  terminou._zerar();
  const filas = [];
  const h = terminou.listarComFim({
    listar: () => { const d = adiada(); filas.push(d); return d.promessa; },
    mapaDeLidas: async () => ({}),
  });
  const primeira = h();
  filas[0].resolve([aba({ sessaoId: 'A', atualizadoEm: 10000 })]);
  await primeira;
  const c1 = h();
  const c2 = h();
  filas[2].resolve([aba({ sessaoId: 'A', atualizadoEm: 11500, statusDesde: 10050 })]);
  const r2 = await c2;
  filas[1].resolve([aba({ sessaoId: 'A', atualizadoEm: 11500, statusDesde: 10050 })]);
  const r1 = await c1;
  ok(r1[0].terminouEm === 10000 && r2[0].terminouEm === 10000,
    `T15 sobreposição real (soltas na ordem inversa) não confirma o candidato — ${r1[0].terminouEm}/${r2[0].terminouEm}`);
}

function t16() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const conta = (s, sub) => s.split(sub).length - 1;
  ok(conta(src, 'terminou.listarComFim({ listar: abas.listar, mapaDeLidas: lidas.mapa })') === 1,
    'T16 server.js monta terminou.listarComFim({ listar: abas.listar, mapaDeLidas: lidas.mapa }) uma vez');
  const ini = src.indexOf("rota === '/api/abas' && req.method === 'GET'");
  const fim = src.indexOf('  // Marcar uma conversa como lida', ini);
  const bloco = ini >= 0 && fim > ini ? src.slice(ini, fim) : '';
  ok(bloco.includes('listarAbasComFim()'), 'T16 o GET /api/abas chama listarAbasComFim()');
  ok(conta(src, 'vigiaAbas.iniciar({ listar: listarAbasComFim })') === 2, 'T16 vigiaAbas.iniciar({ listar: listarAbasComFim }) aparece exatamente 2 vezes');
  ok(conta(src, 'vigiaAbas.iniciar()') === 0, 'T16 vigiaAbas.iniciar() sem argumento: 0 vezes');
  // D65 revogada: nada de `mexid` no servidor, e o módulo de lidas não exporta mais mexer/mexidas.
  ok(!/mexid/i.test(src), 'T16 server.js não contém `mexid` em forma nenhuma');
  const dirLidas = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gate-terminou-lidas-'));
  process.env.COCKPIT_LIDAS_DIR = dirLidas;   // ANTES do require: o módulo resolve o DIR no carregamento
  const lidas = require('../lib/lidas');
  ok(!('mexer' in lidas) && !('mexidas' in lidas), `T16 lib/lidas.js não exporta mexer nem mexidas — ${Object.keys(lidas).join(',')}`);
  fs.rmSync(dirLidas, { recursive: true, force: true });
}

async function t17() {
  // Codex (sem statusDesde): leitura velha processada DEPOIS de uma nova.
  terminou._zerar();
  terminou.observar([aba({ atualizadoEm: 10000 })], undefined, { inicio: 30, fim: 31 });
  terminou.observar([aba({ rodando: true, atualizadoEm: 10000 })], undefined, { inicio: 50, fim: 51 });
  let r = terminou.observar([aba({ atualizadoEm: 11500 })], undefined, { inicio: 40, fim: 41 });
  ok(fimDe(r) === 10000, 'T17 (Codex) leitura velha (inicio 40) depois da nova (inicio 50): A continua 10000');
  r = terminou.observar([aba({ atualizadoEm: 11600 })], undefined, { inicio: 60, fim: 61 });
  ok(fimDe(r) === 10000, 'T17 (Codex) a leitura seguinte (inicio 60) vê a parada de verdade — sem statusDesde, vira candidato');
  r = terminou.observar([aba({ atualizadoEm: 11600 })], undefined, { inicio: 70, fim: 71 });
  ok(fimDe(r) === 11600, 'T17 (Codex) e a próxima (inicio 70) confirma: 11600');

  // Claude (com statusDesde).
  terminou._zerar();
  terminou.observar([aba({ atualizadoEm: 10000 })], undefined, { inicio: 30, fim: 31 });
  terminou.observar([aba({ rodando: true, atualizadoEm: 10000 })], undefined, { inicio: 50, fim: 51 });
  r = terminou.observar([aba({ atualizadoEm: 11500, statusDesde: 10050 })], undefined, { inicio: 40, fim: 41 });
  ok(fimDe(r) === 10000, 'T17 (Claude) leitura velha com statusDesde 10050: A continua 10000');
}

async function t19() {
  terminou._zerar();
  const filas = [];
  const f = terminou.listarComFim({
    listar: () => { const d = adiada(); filas.push(d); return d.promessa; },
    mapaDeLidas: async () => ({}),
  });
  const zero = f();
  filas[0].resolve([aba({ sessaoId: 'A', atualizadoEm: 10000 })]);
  await zero;
  // Duas chamadas UMA LOGO APÓS A OUTRA, no mesmo tique. A 2ª resolve primeiro (rodando), a 1ª depois (par velho).
  const c1 = f();
  const c2 = f();
  filas[2].resolve([aba({ sessaoId: 'A', rodando: true, atualizadoEm: 11500 })]);
  await c2;
  filas[1].resolve([aba({ sessaoId: 'A', atualizadoEm: 11500, statusDesde: 10050 })]);
  const r1 = await c1;
  ok(r1[0].terminouEm === 10000, `T19 empate de início: a leitura que começou antes, processada depois, é ignorada — A continua ${r1[0].terminouEm}`);

  // Os instantes são distintos mesmo no mesmo tique: se `inicio` de c2 empatasse com o `fim` da c1,
  // a 2ª leitura abaixo confirmaria o candidato com o par velho. Aqui as duas resolvem em ordem direta.
  terminou._zerar();
  filas.length = 0;
  const g = terminou.listarComFim({
    listar: () => { const d = adiada(); filas.push(d); return d.promessa; },
    mapaDeLidas: async () => ({}),
  });
  const z = g();
  filas[0].resolve([aba({ sessaoId: 'A', atualizadoEm: 10000 })]);
  await z;
  const d1 = g();
  const d2 = g();
  filas[1].resolve([aba({ sessaoId: 'A', atualizadoEm: 11500, statusDesde: 10050 })]);
  await d1;
  filas[2].resolve([aba({ sessaoId: 'A', atualizadoEm: 11500, statusDesde: 10050 })]);
  const rd2 = await d2;
  ok(rd2[0].terminouEm === 10000, `T19 inicio/fim são ordem total sem empate: a 2ª chamada (começou antes do fim da 1ª) não confirma — A continua ${rd2[0].terminouEm}`);
}

function t20() {
  // A ordem das CHAMADAS não é a ordem das CAPTURAS (painel de execução, Codex): `listar()` faz I/O
  // antes de ler o estado do turno. L1 começa primeiro mas captura `busy` DEPOIS do envio; L2 começa
  // depois, captura "parado" ANTES do envio e lê a fala do envio no arquivo. L1 termina antes.
  terminou._zerar();
  terminou.observar([aba({ atualizadoEm: 10000 })], undefined, { inicio: 10, fim: 11 });
  terminou.observar([aba({ rodando: true, atualizadoEm: 11500 })], undefined, { inicio: 20, fim: 25 });   // L1
  let r = terminou.observar([aba({ atualizadoEm: 11500 })], undefined, { inicio: 21, fim: 26 });          // L2 (velha)
  ok(fimDe(r) === 10000, `T20 (Codex) captura invertida: a parada velha com a fala do envio NÃO é "viu parar" — ${fimDe(r)}`);
  r = terminou.observar([aba({ rodando: true, atualizadoEm: 11500 })], undefined, { inicio: 30, fim: 31 });
  ok(fimDe(r) === 10000, `T20 (Codex) e a leitura seguinte (busy) mata o candidato — ${fimDe(r)}`);

  // Claude: o `statusDesde` vem do arquivo de status, não do .jsonl — a captura velha traz o carimbo do
  // idle ANTERIOR, que já é o fim guardado.
  terminou._zerar();
  terminou.observar([aba({ rodando: true, atualizadoEm: 9000 })], undefined, { inicio: 1, fim: 2 });
  terminou.observar([aba({ atualizadoEm: 10000, statusDesde: 10050 })], undefined, { inicio: 10, fim: 11 });
  terminou.observar([aba({ rodando: true, atualizadoEm: 11500 })], undefined, { inicio: 20, fim: 25 });
  r = terminou.observar([aba({ atualizadoEm: 11500, statusDesde: 10050 })], undefined, { inicio: 21, fim: 26 });
  ok(fimDe(r) === 10050, `T20 (Claude) captura invertida: continua no fim do turno anterior (10050) — ${fimDe(r)}`);

  // Claude, quando o fim guardado veio da FALA (1ª leitura parada: fala 10000, idle publicado 10050) e
  // outra conversa B terminou no meio (10025): a captura velha traz o MESMO statusDesde 10050 da parada
  // já vista — não é parada nova, e B continua acima (rodada 2 do painel de execução, Codex).
  terminou._zerar();
  terminou.observar([aba({ sessaoId: 'A', atualizadoEm: 10000, statusDesde: 10050 }), aba({ sessaoId: 'B', atualizadoEm: 10025 })], undefined, { inicio: 10, fim: 11 });
  terminou.observar([aba({ sessaoId: 'A', rodando: true, atualizadoEm: 11500 }), aba({ sessaoId: 'B', atualizadoEm: 10025 })], undefined, { inicio: 20, fim: 25 });
  r = terminou.observar([aba({ sessaoId: 'A', atualizadoEm: 11500, statusDesde: 10050 }), aba({ sessaoId: 'B', atualizadoEm: 10025 })], undefined, { inicio: 21, fim: 26 });
  ok(fimDe(r, 0) === 10000 && fimDe(r, 1) === 10025, `T20 (Claude) fim guardado pela fala: a captura velha (mesmo statusDesde) não mexe — A ${fimDe(r, 0)}, B ${fimDe(r, 1)}`);
  r = terminou.observar([aba({ sessaoId: 'A', rodando: true, atualizadoEm: 11500 }), aba({ sessaoId: 'B', atualizadoEm: 10025 })], undefined, { inicio: 30, fim: 31 });
  r = terminou.observar([aba({ sessaoId: 'A', atualizadoEm: 12000, statusDesde: 12040 }), aba({ sessaoId: 'B', atualizadoEm: 10025 })], undefined, { inicio: 40, fim: 41 });
  ok(fimDe(r, 0) === 12040, `T20 (Claude) e a parada NOVA (statusDesde 12040) sobe na hora — ${fimDe(r, 0)}`);
}

function t18() {
  terminou._zerar();
  ler([aba({ rodando: null, atualizadoEm: 100 })]);
  let r = ler([aba({ atualizadoEm: 200, statusDesde: 900 })]);
  ok(fimDe(r) === null, `T18 rodando: null → parada NÃO é "viu parar" (nem 900 nem 200) — ${fimDe(r)}`);
  r = ler([aba({ atualizadoEm: 200, statusDesde: 900 })]);
  ok(fimDe(r) === 200, 'T18 a fala nova sobe uma leitura depois, pelo candidato');
}

(async () => {
  console.log('gate-terminou — o fim de turno se confirma, não se infere (D69)');
  t1(); t2(); t3(); t4(); t5(); t6(); t7(); t8(); t9(); t10(); t11(); t12(); t13(); t14();
  await t15();
  t16();
  await t17();
  t18();
  await t19();
  t20();
  console.log(falhas ? `\n❌ ${falhas} falha(s)` : '\n✅ tudo verde');
  if (falhas) process.exitCode = 1;
})();
