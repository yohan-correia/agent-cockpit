#!/usr/bin/env node
'use strict';
// GATE — lib/vigia-abas.js: o vigia central que avisa fim de turno e pedido de intervenção,
// fora do fluxo SSE (spec 2026-09-10-avisar-fim-e-intervencao-nas-abas-design.md).
//
// P1a prova a máquina de estado pura (`decidir`), sem tmux e sem push. P1b prova a casca —
// relógio, reentrância, revalidação de pendências — com `listar`/`avisar` injetados. P1c prova
// o payload que abre a aba certa. P1d mede o overhead do `decidir` com honestidade. P1f e P1g/h
// provam os dois consertos de `lib/avisos.js` (Fase 1) que este vigia passou a poder disparar
// sozinho: o VAPID (§6.9) e a fila do arquivo de inscrições (§6.10). A partir da Fase 3, P1e
// prova a fiação em `server.js` (assert de texto-fonte).
//
// O gate expõe `bater()` e `relogio` do retorno de `iniciar()` — SÓ para teste. A produção
// nunca chama isso: quem dispara é o próprio `setInterval`. Sem a exposição, provar
// reentrância/ordem/revalidação exigiria esperar minutos de relógio real por rodada de
// `npm test`.
//
// ORDEM DE REQUIRE IMPORTA: nativos → isolamento do ambiente → só então os módulos do projeto.
// `lib/avisos.js` resolve `DIR` (o caminho de `~/.cockpit/push`) no `require`; HOME ou
// COCKPIT_PUSH_DIR trocado DEPOIS não tem efeito nenhum.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// A guarda A10 (testes/gate-jobs-disco.js:427-438) reprova todo arquivo de `testes/` que
// MENCIONE `server.js` sem esta variável, e a allowlist dela não é herdada por arquivo novo.
// Sem esta linha, `node testes/gate-jobs-disco.js` falharia com `faltam: gate-vigia-abas.js` —
// e a spec proíbe editar aquela guarda. A menção a server.js vive no bloco P1e (Fase 3).
process.env.COCKPIT_JOBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vigia-jobs-'));
// COCKPIT_PUSH_DIR VENCE o HOME (lib/avisos.js:17): é o que separa esta fixture das
// inscrições REAIS do dono — e há uma ativa em produção agora.
process.env.COCKPIT_PUSH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vigia-push-'));
const DIR_PUSH = process.env.COCKPIT_PUSH_DIR;   // fixado ANTES do require de lib/avisos

// SÓ DEPOIS os módulos do projeto.
const avisos = require('../lib/avisos');
const push = require('../lib/push');
const vigia = require('../lib/vigia-abas');

let falhas = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) falhas += 1;
  return cond;
};
const info = (msg) => console.log(`  ℹ️ ${msg}`);

// O runner (bin/testes.js) domina COCKPIT_VIGIA_MS globalmente para TODOS os gates que sobem
// server.js. Este gate precisa dominar as DUAS variáveis no próprio processo, setando e
// removendo por caso — sem isso, `iniciar()` devolveria `null` em todo caso que precisa de
// relógio vivo, e vários casos AQUI ASSEGURAM `null` como esperado: o gate ficaria verde
// provando nada, o pior desfecho possível.
delete process.env.COCKPIT_VIGIA_MS;
process.env.COCKPIT_CONTATO = '';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
// As mocks (`listar`/`avisar`/`push.enviar`) não fazem I/O real: um punhado de milissegundos
// basta para os microtasks/macrotasks pendentes drenarem. É o que mantém o gate inteiro na
// casa dos segundos, não dos minutos — com PISO=1000ms de `iniciar()`, esperar o relógio de
// verdade custaria minutos por rodada de `npm test`.
const assentar = () => espera(5);

function deferido() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver: (v) => resolver(v) };
}

/** Uma linha no formato de `abas.listar()`. */
function linha(chave, over = {}) {
  return {
    chave,
    titulo: over.titulo ?? chave,
    cwd: 'cwd' in over ? over.cwd : null,
    temAgente: over.temAgente ?? true,
    rodando: 'rodando' in over ? over.rodando : null,
    esperando: 'esperando' in over ? over.esperando : null,
    arquivo: 'arquivo' in over ? over.arquivo : null,
    reiniciada: over.reiniciada ?? false,
  };
}
const estadoDe = (over) => ({ rodando: null, tela: false, arquivo: null, reiniciada: false, ...over });

// ─── P1a — a máquina de estado (decidir), pura ──────────────────────────────

function testarDecidirPuro() {
  console.log('\nP1a — decidir(), a metade pura');

  // a1: semeadura — zero avisos
  {
    const { avisos: av, estado } = vigia.decidir(null, [linha('a1', { rodando: true, esperando: false, arquivo: 'A' })]);
    ok(av.length === 0, 'a1: semeadura não avisa');
    ok(estado.get('a1')?.rodando === true, 'a1: semeadura grava o estado');
  }

  // a2: chave nova numa batida NÃO-semeadura — zero avisos
  {
    const { avisos: av, estado } = vigia.decidir(new Map(), [linha('a2', { rodando: true })]);
    ok(av.length === 0, 'a2: chave nova numa segunda batida não avisa');
    ok(estado.has('a2'), 'a2: e grava o estado mesmo assim');
  }

  // a3: esperando false → true avisa intervencao
  {
    const anterior = new Map([['a3', estadoDe({ rodando: true, tela: false, arquivo: 'A' })]]);
    const { avisos: av } = vigia.decidir(anterior, [linha('a3', { rodando: true, esperando: true, arquivo: 'A' })]);
    ok(av.length === 1 && av[0].tipo === 'intervencao', 'a3: esperando false→true avisa intervenção');
  }

  // a4: esperando null → true avisa intervencao (o null não bloqueia o true que vem depois)
  {
    let r = { estado: new Map([['a4', estadoDe({ rodando: true, tela: false, arquivo: 'A' })]]) };
    r = vigia.decidir(r.estado, [linha('a4', { rodando: true, esperando: null, arquivo: 'A' })]);
    ok(r.avisos.length === 0, 'a4: esperando null não avisa (não sei)');
    r = vigia.decidir(r.estado, [linha('a4', { rodando: true, esperando: true, arquivo: 'A' })]);
    ok(r.avisos.length === 1 && r.avisos[0].tipo === 'intervencao', 'a4: esperando null→true avisa intervenção');
  }

  // a5: (waiting, A) → (null, null) → (waiting, A) avisa UMA vez
  {
    let r = { estado: new Map([['a5', estadoDe({ rodando: true, tela: false, arquivo: 'A' })]]) };
    r = vigia.decidir(r.estado, [linha('a5', { rodando: true, esperando: true, arquivo: 'A' })]);
    ok(r.avisos.length === 1, 'a5: (waiting,A) dispara a intervenção');
    r = vigia.decidir(r.estado, [linha('a5', { rodando: true, esperando: null, arquivo: null })]);
    ok(r.avisos.length === 0, 'a5: (null,null) não avisa e preserva a identidade');
    r = vigia.decidir(r.estado, [linha('a5', { rodando: true, esperando: true, arquivo: 'A' })]);
    ok(r.avisos.length === 0, 'a5: volta a (waiting,A) sem reavisar — UMA vez na sequência inteira');
  }

  // a6: waiting → temAgente:false → waiting avisa UMA vez (/proc falho no meio)
  {
    let r = { estado: new Map([['a6', estadoDe({ rodando: true, tela: false, arquivo: 'A' })]]) };
    r = vigia.decidir(r.estado, [linha('a6', { rodando: true, esperando: true, arquivo: 'A', temAgente: true })]);
    ok(r.avisos.length === 1, 'a6: waiting inicial dispara a intervenção');
    r = vigia.decidir(r.estado, [linha('a6', { rodando: true, esperando: false, arquivo: 'A', temAgente: false })]);
    ok(r.avisos.length === 0, 'a6: temAgente:false não avisa (preserva a tela)');
    r = vigia.decidir(r.estado, [linha('a6', { rodando: true, esperando: true, arquivo: 'A', temAgente: true })]);
    ok(r.avisos.length === 0, 'a6: volta a waiting sem reavisar — a MESMA pergunta não reemite');
  }

  // a7: rodando true → false avisa fim
  {
    const anterior = new Map([['a7', estadoDe({ rodando: true, arquivo: 'A' })]]);
    const { avisos: av } = vigia.decidir(anterior, [linha('a7', { rodando: false, esperando: false, arquivo: 'A' })]);
    ok(av.length === 1 && av[0].tipo === 'fim', 'a7: rodando true→false avisa fim');
  }

  // a8: rodando null → false NÃO avisa (=== estrito, não é fim de turno, é casamento tardio)
  {
    const anterior = new Map([['a8', estadoDe({ rodando: null, arquivo: 'A' })]]);
    const { avisos: av } = vigia.decidir(anterior, [linha('a8', { rodando: false, esperando: false, arquivo: 'A' })]);
    ok(av.length === 0, 'a8: rodando null→false NÃO avisa');
  }

  // a9: rodando true → false com reiniciada:true (/clear do Codex) NÃO avisa
  {
    const anterior = new Map([['a9', estadoDe({ rodando: true, arquivo: 'A' })]]);
    const { avisos: av } = vigia.decidir(anterior, [linha('a9', { rodando: false, esperando: false, arquivo: null, reiniciada: true })]);
    ok(av.length === 0, 'a9: /clear do Codex (reiniciada) não avisa fim');
  }

  // a10: rodando true→false com troca de arquivo NÃO avisa
  {
    const anterior = new Map([['a10', estadoDe({ rodando: true, arquivo: 'A' })]]);
    const { avisos: av } = vigia.decidir(anterior, [linha('a10', { rodando: false, esperando: false, arquivo: 'B' })]);
    ok(av.length === 0, 'a10: troca de arquivo bloqueia o fim');
  }

  // a11: arquivo → null com rodando true→false AVISA (não é troca, o `&&` de server.js:575)
  {
    const anterior = new Map([['a11', estadoDe({ rodando: true, arquivo: 'A' })]]);
    const { avisos: av } = vigia.decidir(anterior, [linha('a11', { rodando: false, esperando: false, arquivo: null })]);
    ok(av.length === 1 && av[0].tipo === 'fim', 'a11: arquivo→null não conta como troca — o fim sai');
  }

  // a12: waiting/A → waiting/B → waiting/B avisa B exatamente uma vez (troca de conversa)
  {
    let r = { estado: new Map([['a12', estadoDe({ rodando: true, tela: true, arquivo: 'A' })]]) };
    r = vigia.decidir(r.estado, [linha('a12', { rodando: true, esperando: true, arquivo: 'B' })]);
    ok(r.avisos.length === 1 && r.avisos[0].tipo === 'intervencao', 'a12: troca de conversa com novo menu avisa B — troca NÃO bloqueia o menu');
    r = vigia.decidir(r.estado, [linha('a12', { rodando: true, esperando: true, arquivo: 'B' })]);
    ok(r.avisos.length === 0, 'a12: waiting/B → waiting/B não duplica');
  }

  // a13: waiting → waiting na MESMA conversa não avisa — limitação 13, congelada
  {
    const anterior = new Map([['a13', estadoDe({ rodando: true, tela: true, arquivo: 'A' })]]);
    const { avisos: av } = vigia.decidir(anterior, [linha('a13', { rodando: true, esperando: true, arquivo: 'A' })]);
    ok(av.length === 0, 'a13: waiting→waiting na mesma conversa não avisa (limitação 13)');
  }

  // a14: aba some da lista — zero avisos, chave fora do Map
  {
    const anterior = new Map([['a14', estadoDe({ rodando: true, arquivo: 'A' })]]);
    const { avisos: av, estado } = vigia.decidir(anterior, []);
    ok(av.length === 0, 'a14: aba que some não avisa');
    ok(!estado.has('a14'), 'a14: e a chave sai do Map');
  }

  // a15: rodando true→false E esperando false→true no mesmo tique — UM aviso, o de intervenção
  {
    const anterior = new Map([['a15', estadoDe({ rodando: true, tela: false, arquivo: 'A' })]]);
    const { avisos: av } = vigia.decidir(anterior, [linha('a15', { rodando: false, esperando: true, arquivo: 'A' })]);
    ok(av.length === 1 && av[0].tipo === 'intervencao', 'a15: fim+menu no mesmo tique — só a intervenção sai');
  }

  // a16: intervenção SUPRIMIDA (já esperando) no mesmo tique de um fim — o fim sai
  {
    const anterior = new Map([['a16', estadoDe({ rodando: true, tela: true, arquivo: 'A' })]]);
    const { avisos: av } = vigia.decidir(anterior, [linha('a16', { rodando: false, esperando: true, arquivo: 'A' })]);
    ok(av.length === 1 && av[0].tipo === 'fim', 'a16: intervenção suprimida não consome o fim');
  }

  // a17: decidir não muta o Map recebido
  {
    const anterior = new Map([['a17', estadoDe({ rodando: true, arquivo: 'A' })]]);
    const antesJSON = JSON.stringify([...anterior]);
    vigia.decidir(anterior, [linha('a17', { rodando: false, esperando: false, arquivo: 'A' })]);
    ok(JSON.stringify([...anterior]) === antesJSON, 'a17: decidir() não muta o Map recebido');
  }
}

// ─── P1c — o payload que abre a aba certa ───────────────────────────────────

async function testarPayload() {
  console.log('\nP1c — o payload entregue a avisos.avisar');
  const chamadas = [];
  const espiao = async (p) => { chamadas.push(p); return { enviados: 1, removidos: 0 }; };
  const linhas = [linha('c1', { rodando: true, esperando: false, arquivo: 'A' })];
  process.env.COCKPIT_CONTATO = 'mailto:gate@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: espiao });
  ok(instancia !== null, 'p1c: iniciar() sobe com contato válido');
  await assentar();
  linhas[0] = linha('c1', { rodando: false, esperando: false, arquivo: 'A' });
  await instancia.bater();
  await assentar();
  ok(chamadas.length === 1, 'p1c: um aviso disparado');
  ok(chamadas[0] && chamadas[0].sessaoId === 'c1' && chamadas[0].tag === 'c1',
    'p1c: o espião recebe { sessaoId: <chave>, tag: <chave> }');
  instancia.parar();
}

// ─── P1d — o overhead do decidir(), impresso ────────────────────────────────

function testarOverhead() {
  console.log('\nP1d — overhead de decidir() com 20 abas (não inclui o listar() real)');
  const linhas = [];
  for (let i = 0; i < 20; i += 1) linhas.push(linha(`ov-${i}`, { rodando: true, esperando: false, arquivo: `arq-${i}` }));
  const anterior = new Map(linhas.map((l) => [l.chave, estadoDe({ rodando: true, arquivo: l.chave })]));
  const inicio = process.hrtime.bigint();
  vigia.decidir(anterior, linhas);
  const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
  info(`decidir() com 20 abas: ${ms.toFixed(3)} ms — o custo real de um tique é dominado pelo listar() (~37 ms, DECISOES.md:1145), não reproduzível com fixture`);
  ok(ms < 50, `p1d: decidir() fica bem abaixo de qualquer orçamento razoável (${ms.toFixed(3)} ms)`);
}

// ─── P1b — a casca: travas, relógio, reentrância, revalidação ───────────────

function testarTravas() {
  console.log('\nP1b — as travas de iniciar()');
  const listarVazio = async () => [];
  const avisarNoop = async () => ({ enviados: 0, removidos: 0 });

  delete process.env.COCKPIT_CONTATO;
  process.env.COCKPIT_VIGIA_MS = '5000';
  ok(vigia.iniciar({ listar: listarVazio, avisar: avisarNoop }) === null, 'sem COCKPIT_CONTATO devolve null');

  process.env.COCKPIT_CONTATO = 'teste';
  ok(vigia.iniciar({ listar: listarVazio, avisar: avisarNoop }) === null, 'contato de formato inválido ("teste") devolve null');

  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';

  // COCKPIT_VIGIA_MS=0 no env: null, CALADO
  process.env.COCKPIT_VIGIA_MS = '0';
  {
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.join(' '));
    const r = vigia.iniciar({ listar: listarVazio, avisar: avisarNoop });
    console.error = orig;
    ok(r === null, 'COCKPIT_VIGIA_MS=0 no env devolve null');
    ok(logs.length === 0, 'e fica CALADO (desligado de propósito)');
  }

  // iniciar({ intervaloMs: 0 }) por parâmetro, com env != '0': null, mas LOGA
  process.env.COCKPIT_VIGIA_MS = '5000';
  {
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.join(' '));
    const r = vigia.iniciar({ intervaloMs: 0, listar: listarVazio, avisar: avisarNoop });
    console.error = orig;
    ok(r === null, 'intervaloMs:0 por parâmetro devolve null');
    ok(logs.length === 1, 'e LOGA — a decisão de silêncio olha o ENV, não o parâmetro');
  }

  // valor inválido no env: null, loga
  process.env.COCKPIT_VIGIA_MS = 'abc';
  {
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.join(' '));
    const r = vigia.iniciar({ listar: listarVazio, avisar: avisarNoop });
    console.error = orig;
    ok(r === null, 'COCKPIT_VIGIA_MS inválido devolve null');
    ok(logs.length === 1, 'e loga o valor recebido');
  }

  // '' cai no padrão de 5000, não em desligado
  process.env.COCKPIT_VIGIA_MS = '';
  {
    const instancia = vigia.iniciar({ listar: listarVazio, avisar: avisarNoop });
    ok(instancia !== null, "COCKPIT_VIGIA_MS='' cai no padrão de 5000, não em desligado");
    instancia?.parar();
  }
  delete process.env.COCKPIT_VIGIA_MS;

  // overflow: 2147483648 é recusado, NÃO vira 1 ms
  ok(vigia.iniciar({ intervaloMs: 2147483648, listar: listarVazio, avisar: avisarNoop }) === null,
    'intervaloMs 2147483648 é recusado (não vira 1 ms por overflow de int32)');

  // abaixo do piso
  ok(vigia.iniciar({ intervaloMs: 500, listar: listarVazio, avisar: avisarNoop }) === null,
    'intervaloMs 500 (abaixo do piso de 1000) é recusado');

  // loga na subida, com o intervalo certo
  {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
    const instancia = vigia.iniciar({ intervaloMs: 1234, listar: listarVazio, avisar: avisarNoop });
    console.log = orig;
    ok(logs.some((l) => l.includes('vigia de abas ativo (1234 ms)')), 'loga na subida com o intervalo configurado');
    instancia.parar();
  }

  // o relógio é unref
  {
    const instancia = vigia.iniciar({ intervaloMs: 1000, listar: listarVazio, avisar: avisarNoop });
    ok(instancia?.relogio?.hasRef?.() === false, 'o relógio é unref (não segura o event loop)');
    instancia.parar();
  }
}

async function testarPrimeiraBatidaMuda() {
  console.log('\nP1b — a primeira batida sai na subida e é muda');
  const chamadas = [];
  // Já nasce "esperando": se a semeadura avisasse, isto pegaria.
  const linhas = [linha('sub1', { rodando: true, esperando: true, arquivo: 'A' })];
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({
    intervaloMs: 1000,
    listar: async () => linhas.slice(),
    avisar: async (p) => { chamadas.push(p); return { enviados: 1, removidos: 0 }; },
  });
  await assentar();
  ok(chamadas.length === 0, 'a semeadura não avisa, mesmo com aba já esperando');
  instancia.parar();
}

async function testarBatidaQueEstoura() {
  console.log('\nP1b — batida que estoura não derruba a próxima');
  let vez = 0;
  const listarMock = async () => {
    vez += 1;
    if (vez === 1) throw new Error('tmux caiu');
    return [linha('e7', { rodando: true, esperando: false, arquivo: 'A' })];
  };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: listarMock, avisar: async () => ({ enviados: 0, removidos: 0 }) });
  await assentar();
  ok(vez === 1, 'a primeira batida (semeadura) chamou listar() e estourou');
  await instancia.bater();
  await assentar();
  ok(vez === 2, 'a próxima batida roda normalmente depois do estouro — não foi derrubada');
  instancia.parar();
}

async function testarAvisarQueRejeitaNaoDerruba() {
  console.log('\nP1b — avisar() que rejeita não derruba a batida');
  const linhas = [linha('e8', { rodando: true, esperando: false, arquivo: 'A' })];
  const listarMock = async () => linhas.slice();
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: listarMock, avisar: async () => { throw new Error('push falhou'); } });
  await assentar();
  linhas[0] = linha('e8', { rodando: false, esperando: false, arquivo: 'A' });
  await instancia.bater();
  await assentar();
  ok(true, 'chegou até aqui sem derrubar o processo — a rejeição foi tratada (.then(fn,fn), nunca .finally)');
  instancia.parar();
}

async function testarBatidaSobreposta() {
  console.log('\nP1b — batida sobreposta desiste (não enfileira)');
  const chamadasListar = [];
  const d = deferido();
  const listarMock = async () => { chamadasListar.push(1); return d.promessa; };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: listarMock, avisar: async () => ({ enviados: 0, removidos: 0 }) });
  ok(chamadasListar.length === 1, 'a primeira batida (semeadura) chamou listar() e ficou pendurada');
  const p2 = instancia.bater();   // batida sobreposta
  await assentar();
  ok(chamadasListar.length === 1, 'a batida sobreposta NÃO chamou listar() de novo — desistiu');
  d.resolver([]);
  await p2;
  await assentar();
  instancia.parar();
}

async function testarOcupadoLiberadoAntesDosEnvios() {
  console.log('\nP1b — a flag ocupado é liberada ANTES dos envios');
  const dAvisar = deferido();
  const linhas = [linha('e13', { rodando: true, esperando: false, arquivo: 'A' })];
  const listarChamadas = [];
  const listarMock = async () => { listarChamadas.push(1); return linhas.slice(); };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: listarMock, avisar: async () => dAvisar.promessa });
  await assentar();   // semeadura
  linhas[0] = linha('e13', { rodando: false, esperando: false, arquivo: 'A' });   // dispara fim (avisar pendurado)
  const p1 = instancia.bater();
  await assentar();
  const p2 = instancia.bater();   // uma SEGUNDA batida, com o avisar() da primeira ainda em voo
  await assentar();
  ok(listarChamadas.length === 3, `a segunda batida RODOU mesmo com um avisar() pendurado (chamadas=${listarChamadas.length})`);
  dAvisar.resolver({ enviados: 1, removidos: 0 });
  await Promise.all([p1, p2]);
  await assentar();
  instancia.parar();
}

async function testarOrdemMesmaAba() {
  console.log('\nP1b — dois avisos da MESMA aba são chamados em ordem');
  const eventos = [];
  const d1 = deferido();
  let chamadaN = 0;
  const linhas = [linha('e14', { rodando: true, esperando: false, arquivo: 'A' })];
  const avisarMock = async () => {
    chamadaN += 1;
    const minha = chamadaN;
    eventos.push(`inicio${minha}`);
    if (minha === 1) await d1.promessa;
    eventos.push(`fim${minha}`);
    return { enviados: 1, removidos: 0 };
  };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisarMock });
  await assentar();

  linhas[0] = linha('e14', { rodando: false, esperando: false, arquivo: 'A' });   // fim1, pendurado
  await instancia.bater();
  await assentar();
  ok(eventos.join(',') === 'inicio1', 'o primeiro aviso partiu e está pendurado');

  linhas[0] = linha('e14', { rodando: true, esperando: false, arquivo: 'A' });
  await instancia.bater();
  await assentar();
  linhas[0] = linha('e14', { rodando: false, esperando: false, arquivo: 'A' });   // fim2, enfileira atrás
  await instancia.bater();
  await assentar();
  ok(eventos.join(',') === 'inicio1', 'o segundo aviso NÃO partiu enquanto o primeiro não assentou');

  d1.resolver();
  await assentar();
  ok(eventos.join(',') === 'inicio1,fim1,inicio2,fim2', 'o segundo só COMEÇA depois do primeiro assentar, e conclui na ordem');
  instancia.parar();
}

async function testarParaleloAbasDiferentes() {
  console.log('\nP1b — abas DIFERENTES saem em paralelo');
  const eventos = [];
  const dA = deferido();
  const linhas = [
    linha('p15a', { rodando: true, esperando: false, arquivo: 'A' }),
    linha('p15b', { rodando: true, esperando: false, arquivo: 'A' }),
  ];
  const avisarMock = async (p) => {
    if (p.sessaoId === 'p15a') { await dA.promessa; eventos.push('fim-a'); return { enviados: 1, removidos: 0 }; }
    eventos.push('fim-b');
    return { enviados: 1, removidos: 0 };
  };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisarMock });
  await assentar();

  linhas[0] = linha('p15a', { rodando: false, esperando: false, arquivo: 'A' });
  linhas[1] = linha('p15b', { rodando: false, esperando: false, arquivo: 'A' });
  await instancia.bater();
  await assentar();
  ok(eventos.includes('fim-b') && !eventos.includes('fim-a'), 'a aba B assentou SEM esperar a A (que está pendurada)');
  dA.resolver();
  await assentar();
  ok(eventos.includes('fim-a'), 'e a A assenta quando é liberada');
  instancia.parar();
}

async function testarErroDedup() {
  console.log('\nP1b — erro idêntico em abas diferentes loga UMA vez');
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    const linhas = [
      linha('e10a', { rodando: true, esperando: false, arquivo: 'A' }),
      linha('e10b', { rodando: true, esperando: false, arquivo: 'A' }),
    ];
    const erro = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
    const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: async () => { throw erro(); } });
    await assentar();
    linhas[0] = linha('e10a', { rodando: false, esperando: false, arquivo: 'A' });
    linhas[1] = linha('e10b', { rodando: false, esperando: false, arquivo: 'A' });
    await instancia.bater();   // dois "fim", dois avisar() que rejeitam com o MESMO código de erro
    await assentar();
    instancia.parar();
  } finally {
    console.error = orig;
  }
  const linhasDeEnvio = logs.filter((l) => l.includes('aviso de'));
  ok(linhasDeEnvio.length === 1, `o mesmo erro (mesmo code) em abas diferentes logou UMA vez, não ${linhasDeEnvio.length}`);
}

async function testarSubstituiNaoEnfileira() {
  console.log('\nP1b — transição nova durante envio lento SUBSTITUI a pendente');
  let chamadaN = 0;
  const d1 = deferido();
  const linhas = [linha('e17', { rodando: true, esperando: false, arquivo: 'A' })];
  const avisarMock = async () => {
    chamadaN += 1;
    if (chamadaN === 1) await d1.promessa;
    return { enviados: 1, removidos: 0 };
  };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisarMock });
  await assentar();

  linhas[0] = linha('e17', { rodando: false, esperando: false, arquivo: 'A' });   // fim1, pendurado
  await instancia.bater();
  await assentar();

  for (let i = 0; i < 2; i += 1) {
    linhas[0] = linha('e17', { rodando: true, esperando: false, arquivo: 'A' });
    await instancia.bater();
    await assentar();
    linhas[0] = linha('e17', { rodando: false, esperando: false, arquivo: 'A' });   // fim2, fim3 — substituem
    await instancia.bater();
    await assentar();
  }

  d1.resolver();
  await assentar();
  ok(chamadaN === 2, `substitui em vez de enfileirar: só ${chamadaN} chamadas de avisar(), não 3`);
  instancia.parar();
}

async function testarAbaQueSomeEVolta() {
  console.log('\nP1b — aba que some e volta com envio pendente mantém a ordem');
  const eventos = [];
  const d1 = deferido();
  let chamadaN = 0;
  const linhas = [linha('e16', { rodando: true, esperando: false, arquivo: 'A' })];
  const avisarMock = async () => {
    chamadaN += 1;
    const minha = chamadaN;
    eventos.push(`inicio${minha}`);
    if (minha === 1) await d1.promessa;
    eventos.push(`fim${minha}`);
    return { enviados: 1, removidos: 0 };
  };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisarMock });
  await assentar();

  linhas[0] = linha('e16', { rodando: false, esperando: false, arquivo: 'A' });   // fim1, pendurado
  await instancia.bater();
  await assentar();
  ok(eventos.join(',') === 'inicio1', 'o fim1 partiu e está pendurado');

  linhas.length = 0;   // a aba SOME da lista (ex.: tmux falho)
  await instancia.bater();
  await assentar();

  linhas.push(linha('e16', { rodando: true, esperando: false, arquivo: 'A' }));   // e VOLTA
  await instancia.bater();
  await assentar();
  linhas[0] = linha('e16', { rodando: false, esperando: false, arquivo: 'A' });   // fim2
  await instancia.bater();
  await assentar();
  ok(eventos.join(',') === 'inicio1', 'o fim2 ainda não partiu — respeita a ordem atrás do fim1');

  d1.resolver();
  await assentar();
  ok(eventos.join(',') === 'inicio1,fim1,inicio2,fim2', 'depois do fim1 assentar, o fim2 parte e conclui, na ordem');
  instancia.parar();
}

async function testarMenuRespondidoNaoSai() {
  console.log('\nP1b — menu respondido durante envio lento NÃO sai');
  const chamadas = [];
  const d1 = deferido();
  const linhas = [linha('e19', { rodando: true, esperando: false, arquivo: 'A' })];
  const avisarMock = async (p) => {
    chamadas.push(p.titulo);
    if (chamadas.length === 1) await d1.promessa;
    return { enviados: 1, removidos: 0 };
  };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisarMock });
  await assentar();

  linhas[0] = linha('e19', { rodando: false, esperando: false, arquivo: 'A' });   // fim, pendurado
  await instancia.bater();
  await assentar();
  ok(chamadas.length === 1, 'o fim partiu e está pendurado');

  linhas[0] = linha('e19', { rodando: false, esperando: true, arquivo: 'A' });   // abre um menu — enfileira atrás
  await instancia.bater();
  await assentar();
  ok(chamadas.length === 1, 'o menu ainda não rodou — está atrás do fim na fila');

  linhas[0] = linha('e19', { rodando: false, esperando: false, arquivo: 'A' });   // o menu é RESPONDIDO antes do fim assentar
  await instancia.bater();   // revalida: valido(agora) = e.tela = false ⇒ cancela o pendente
  await assentar();

  d1.resolver();   // o fim finalmente assenta
  await assentar();
  ok(chamadas.length === 1, 'o menu já respondido NÃO saiu depois do fim assentar');
  instancia.parar();
}

async function testarAvisoNaoApontaParaOutraConversa() {
  console.log('\nP1b — aviso pendente de A não sai apontando para B');
  const chamadas = [];
  const d1 = deferido();
  const linhas = [linha('e20', { rodando: true, esperando: false, arquivo: 'A' })];
  const avisarMock = async (p) => {
    chamadas.push(p);
    if (chamadas.length === 1) await d1.promessa;
    return { enviados: 1, removidos: 0 };
  };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisarMock });
  await assentar();

  linhas[0] = linha('e20', { rodando: false, esperando: false, arquivo: 'A' });   // fim1 de A, pendurado
  await instancia.bater();
  await assentar();

  linhas[0] = linha('e20', { rodando: true, esperando: false, arquivo: 'A' });
  await instancia.bater();
  await assentar();
  linhas[0] = linha('e20', { rodando: false, esperando: false, arquivo: 'A' });   // fim2, ainda de A — enfileira
  await instancia.bater();
  await assentar();
  ok(chamadas.length === 1, 'o fim2 (de A) ainda não rodou — está atrás do fim1');

  linhas[0] = linha('e20', { rodando: true, esperando: false, arquivo: 'B' });   // a pane troca de conversa: A → B
  await instancia.bater();   // a revalidação roda aqui: ficha2.arquivo('A') != agora.arquivo('B')
  await assentar();

  d1.resolver();   // libera o fim1 (já em voo antes da troca)
  await assentar();
  ok(chamadas.length === 1, 'o fim2 (de A) NÃO saiu apontando para B — a revalidação cancelou pelo arquivo de origem');
  instancia.parar();
}

async function testarClearCancelaFimNaoPartido() {
  console.log('\nP1b — /clear cancela o fim que ainda NÃO partiu; o que já está na rede chega mesmo');
  const chamadas = [];
  const d1 = deferido();
  const linhas = [linha('e21', { rodando: true, esperando: false, arquivo: 'A' })];
  const avisarMock = async (p) => {
    chamadas.push(p);
    if (chamadas.length === 1) await d1.promessa;
    return { enviados: 1, removidos: 0 };
  };
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({ intervaloMs: 1000, listar: async () => linhas.slice(), avisar: avisarMock });
  await assentar();

  linhas[0] = linha('e21', { rodando: false, esperando: false, arquivo: 'A' });   // fim1, pendurado (já na rede)
  await instancia.bater();
  await assentar();

  linhas[0] = linha('e21', { rodando: true, esperando: false, arquivo: 'A' });
  await instancia.bater();
  await assentar();
  linhas[0] = linha('e21', { rodando: false, esperando: false, arquivo: 'A' });   // fim2, enfileira
  await instancia.bater();
  await assentar();

  linhas[0] = linha('e21', { rodando: false, esperando: false, arquivo: null, reiniciada: true });   // /clear do Codex
  await instancia.bater();   // revalida: agora.reiniciada === true ⇒ cancela o fim2
  await assentar();

  d1.resolver();   // o fim1, já em voo ANTES do /clear, chega mesmo
  await assentar();
  ok(chamadas.length === 1, '/clear cancelou o fim2 (não partido); o fim1 (já na rede) chegou mesmo');
  instancia.parar();
}

async function testarMenuPendenteLeituraDesconhecidaMesmoMenu() {
  console.log('\nP1b — menu pendente → leitura desconhecida → mesmo menu: não cancela, não duplica');
  const chamadas = [];
  const linhas = [linha('e22', { rodando: true, esperando: false, arquivo: 'A' })];
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const instancia = vigia.iniciar({
    intervaloMs: 1000,
    listar: async () => linhas.slice(),
    avisar: async (p) => { chamadas.push(p); return { enviados: 1, removidos: 0 }; },
  });
  await assentar();

  linhas[0] = linha('e22', { rodando: true, esperando: true, arquivo: 'A' });
  await instancia.bater();
  await assentar();
  ok(chamadas.length === 1, 'o menu avisou');

  linhas[0] = linha('e22', { rodando: true, esperando: null, arquivo: 'A', temAgente: false });
  await instancia.bater();
  await assentar();
  ok(chamadas.length === 1, 'a leitura desconhecida não cancela nem duplica');

  linhas[0] = linha('e22', { rodando: true, esperando: true, arquivo: 'A' });
  await instancia.bater();
  await assentar();
  ok(chamadas.length === 1, 'e o mesmo menu de volta não duplica');
  instancia.parar();
}

// ─── P1f — o VAPID (Fase 1.1) ────────────────────────────────────────────────

function testarVapid() {
  console.log('\nP1f — o vapid.json ilegível não é sobrescrito (Fase 1.1)');
  const arqVapid = path.join(DIR_PUSH, 'vapid.json');
  fs.rmSync(arqVapid, { force: true });

  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';

  const chave1 = avisos.chavePublica();
  ok(typeof chave1 === 'string' && chave1.length > 0, 'diretório vazio: gera e grava a chave pública');
  ok(fs.existsSync(arqVapid), 'vapid.json foi criado');

  fs.writeFileSync(arqVapid, 'isto não é json', { mode: 0o600 });
  const shaAntes = crypto.createHash('sha256').update(fs.readFileSync(arqVapid)).digest('hex');
  let lancou = false;
  try { avisos.chavePublica(); } catch (e) { lancou = true; ok(e.codigo === 500, 'o erro é tipado 500'); }
  ok(lancou, 'vapid.json inválido LANÇA em vez de regenerar');
  const shaDepois = crypto.createHash('sha256').update(fs.readFileSync(arqVapid)).digest('hex');
  ok(shaAntes === shaDepois, 'o arquivo continua byte a byte o mesmo — nenhuma inscrição foi invalidada');

  fs.rmSync(arqVapid, { force: true });
}

// ─── P1g — a fila do arquivo de inscrições (Fase 1.3) ───────────────────────

async function testarFilaDuranteRede() {
  console.log('\nP1g(a) — descadastro durante a REDE → disco vazio');
  fs.rmSync(path.join(DIR_PUSH, 'inscricoes.json'), { force: true });
  process.env.COCKPIT_CONTATO = 'mailto:x@example.com';
  const E1 = { endpoint: 'https://fcm.example/g-a1', keys: { p256dh: 'a', auth: 'b' } };
  const E2 = { endpoint: 'https://fcm.example/g-a2', keys: { p256dh: 'a', auth: 'b' } };
  await avisos.inscrever(E1);
  await avisos.inscrever(E2);

  const enviarOriginal = push.enviar;
  const dE2 = deferido();
  push.enviar = async ({ inscricao }) => {
    if (inscricao.endpoint === E1.endpoint) return { status: 410 };
    await dE2.promessa;
    return { status: 200 };
  };

  const pAvisar = avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x' });
  await assentar();   // deixa E1 resolver (410) e a rede de E2 ficar pendurada
  await avisos.descadastrar(E2.endpoint);   // concorrente, DURANTE a rede
  dE2.resolver();
  await pAvisar;
  push.enviar = enviarOriginal;

  const disco = JSON.parse(fs.readFileSync(path.join(DIR_PUSH, 'inscricoes.json'), 'utf8'));
  ok(disco.length === 0, `descadastro durante a rede — disco vazio (tem ${disco.length})`);
}

async function testarFilaNaJanelaDoMkdir() {
  console.log('\nP1g(b) — descadastro na janela do mkdir de gravar() → disco vazio');
  fs.rmSync(path.join(DIR_PUSH, 'inscricoes.json'), { force: true });
  const E1 = { endpoint: 'https://fcm.example/g-b1', keys: { p256dh: 'a', auth: 'b' } };
  const E2 = { endpoint: 'https://fcm.example/g-b2', keys: { p256dh: 'a', auth: 'b' } };
  await avisos.inscrever(E1);
  await avisos.inscrever(E2);

  const enviarOriginal = push.enviar;
  push.enviar = async ({ inscricao }) => ({ status: inscricao.endpoint === E1.endpoint ? 410 : 200 });

  const fsp = require('node:fs/promises');
  const mkdirOriginal = fsp.mkdir;
  const sinal = deferido();
  let armado = false;
  fsp.mkdir = async (...args) => {
    if (armado) { armado = false; sinal.resolver(); }
    return mkdirOriginal.apply(fsp, args);
  };

  armado = true;
  const pAvisar = avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x' });
  await sinal.promessa;   // exatamente na janela do mkdir de gravar() da limpeza dos mortos
  const pDescadastro = avisos.descadastrar(E2.endpoint);   // concorrente, chega e ENFILEIRA
  await Promise.all([pAvisar, pDescadastro]);
  fsp.mkdir = mkdirOriginal;
  push.enviar = enviarOriginal;

  const disco = JSON.parse(fs.readFileSync(path.join(DIR_PUSH, 'inscricoes.json'), 'utf8'));
  ok(disco.length === 0, `descadastro na janela do mkdir — disco vazio (tem ${disco.length})`);
}

async function testarInscricaoConcorrenteSobrevive() {
  console.log('\nP1g(c) — inscrever() concorrente com a limpeza → a inscrição nova SOBREVIVE');
  fs.rmSync(path.join(DIR_PUSH, 'inscricoes.json'), { force: true });
  const E1 = { endpoint: 'https://fcm.example/g-c1', keys: { p256dh: 'a', auth: 'b' } };
  const E3 = { endpoint: 'https://fcm.example/g-c3', keys: { p256dh: 'a', auth: 'b' } };
  await avisos.inscrever(E1);

  const enviarOriginal = push.enviar;
  const dRede = deferido();
  push.enviar = async () => { await dRede.promessa; return { status: 410 }; };   // E1 morre, devagar

  const pAvisar = avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x' });
  await assentar();
  const pInscricao = avisos.inscrever(E3);   // concorrente, ENQUANTO a rede de E1 está no ar
  await assentar();
  dRede.resolver();
  await Promise.all([pAvisar, pInscricao]);
  push.enviar = enviarOriginal;

  const disco = JSON.parse(fs.readFileSync(path.join(DIR_PUSH, 'inscricoes.json'), 'utf8'));
  ok(disco.some((i) => i.endpoint === E3.endpoint), 'a inscrição concorrente (E3) sobrevive à limpeza');
  ok(!disco.some((i) => i.endpoint === E1.endpoint), 'e o morto (E1) some');
}

// ─── P1h — a leitura engolida (Fase 1.2/1.3) ────────────────────────────────

async function testarLeituraNaoEngolidaDuranteGravacao() {
  console.log('\nP1h(a) — avisar() disparado durante uma gravação NÃO vê []');
  fs.rmSync(path.join(DIR_PUSH, 'inscricoes.json'), { force: true });
  const E1 = { endpoint: 'https://fcm.example/h1', keys: { p256dh: 'a', auth: 'b' } };

  const fsp = require('node:fs/promises');
  const writeFileOriginal = fsp.writeFile;
  const dEscrita = deferido();
  let interceptarProxima = false;
  fsp.writeFile = async (...args) => {
    if (interceptarProxima) { interceptarProxima = false; await dEscrita.promessa; }
    return writeFileOriginal.apply(fsp, args);
  };

  interceptarProxima = true;
  const pInscrever = avisos.inscrever(E1);   // fica pendurado NA GRAVAÇÃO
  await assentar();

  const enviarOriginal = push.enviar;
  const enviadosPara = [];
  push.enviar = async ({ inscricao }) => { enviadosPara.push(inscricao.endpoint); return { status: 200 }; };

  const pAvisar = avisos.avisar({ titulo: 't', corpo: 'c', sessaoId: 'x', tag: 'x' });   // disparado DURANTE a gravação
  await assentar();
  dEscrita.resolver();
  const [, resultado] = await Promise.all([pInscrever, pAvisar]);
  fsp.writeFile = writeFileOriginal;
  push.enviar = enviarOriginal;

  ok(resultado.enviados === 1 && enviadosPara.includes(E1.endpoint),
    `avisar() disparado durante a gravação NÃO viu [] — enviou para quem entrou (${enviadosPara.join(',') || 'ninguém'})`);
}

async function testarLeituraPermissaoNegadaLanca() {
  console.log('\nP1h(b) — inscricoes.json com permissão negada LANÇA (não vira [])');
  const arq = path.join(DIR_PUSH, 'inscricoes.json');
  fs.writeFileSync(arq, '[]', { mode: 0o600 });
  fs.chmodSync(arq, 0o000);
  let lancou = false;
  try { await avisos.inscricoes(); } catch { lancou = true; }
  fs.chmodSync(arq, 0o600);
  if (process.getuid && process.getuid() === 0) {
    info('rodando como root — permissão de arquivo não se aplica; caso declarado, não verde falso');
  } else {
    ok(lancou, 'inscricoes.json com permissão negada lança, não vira []');
  }
  fs.rmSync(arq, { force: true });
}

// ─── P1e — a fiação nos DOIS ramos de server.js ─────────────────────────────

function testarFiacaoNoServidor() {
  console.log('\nP1e — a fiação nos DOIS ramos de server.js');
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const ocorrencias = fonte.split('vigiaAbas.iniciar()').length - 1;
  ok(ocorrencias >= 2, `vigiaAbas.iniciar() aparece ao menos DUAS vezes em server.js (achei ${ocorrencias}) — uma só passaria com o ramo TLS sem vigia, e produção roda TLS`);
  const iCert = fonte.indexOf('if (!certificado)');
  const iElse = fonte.indexOf('} else {', iCert);
  const iPrimeira = fonte.indexOf('vigiaAbas.iniciar()');
  const iSegunda = fonte.indexOf('vigiaAbas.iniciar()', iPrimeira + 1);
  ok(iCert !== -1 && iElse !== -1 && iPrimeira > iCert && iPrimeira < iElse,
    'a primeira ocorrência está dentro do ramo `if (!certificado)`');
  ok(iSegunda !== -1 && iSegunda > iElse, 'a segunda ocorrência está dentro do ramo `else` (TLS + multiplexador)');
}

// ─── Execução ────────────────────────────────────────────────────────────────

async function principal() {
  testarDecidirPuro();
  await testarPayload();
  testarOverhead();

  testarTravas();
  await testarPrimeiraBatidaMuda();
  await testarBatidaQueEstoura();
  await testarAvisarQueRejeitaNaoDerruba();
  await testarBatidaSobreposta();
  await testarOcupadoLiberadoAntesDosEnvios();
  await testarOrdemMesmaAba();
  await testarParaleloAbasDiferentes();
  await testarErroDedup();
  await testarSubstituiNaoEnfileira();
  await testarAbaQueSomeEVolta();
  await testarMenuRespondidoNaoSai();
  await testarAvisoNaoApontaParaOutraConversa();
  await testarClearCancelaFimNaoPartido();
  await testarMenuPendenteLeituraDesconhecidaMesmoMenu();

  testarVapid();
  await testarFilaDuranteRede();
  await testarFilaNaJanelaDoMkdir();
  await testarInscricaoConcorrenteSobrevive();
  await testarLeituraNaoEngolidaDuranteGravacao();
  await testarLeituraPermissaoNegadaLanca();

  testarFiacaoNoServidor();

  fs.rmSync(process.env.COCKPIT_JOBS_DIR, { recursive: true, force: true });
  fs.rmSync(DIR_PUSH, { recursive: true, force: true });

  console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — lib/vigia-abas.js\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.error('🔴 o gate estourou —', e);
  process.exit(1);
});
