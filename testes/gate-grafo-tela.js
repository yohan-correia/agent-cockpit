#!/usr/bin/env node
'use strict';
// GATE das funções PURAS do diálogo "Grafos" (public/grafo.js) e do `sw.js` — spec/plano
// `2026-10-16-grafo-do-projeto-no-cockpit` (Fase 6). Node puro, `vm`, sem server: carrega
// traducoes.js/i18n.js/grafo.js num contexto sem DOM de verdade (`document.getElementById`
// devolve `null`) — grafo.js expõe `globalThis.cockpitGrafo` ANTES de tocar em `document`,
// como `revisar.js`/`monitor.js` — e confere as puras.
//
//   node testes/gate-grafo-tela.js

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let passou = 0;
let total = 0;
let vermelho = false;
function ok(cond, msg) {
  total += 1;
  if (cond) { passou += 1; console.log(`  ✅ ${msg}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${msg}`);
  return false;
}
async function bloco(nome, fn) {
  console.log(`\n${nome}`);
  try { await fn(); } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.stack}`);
  }
}

function carregarGrafo() {
  const sandbox = { document: { getElementById: () => null }, console };
  const contexto = vm.createContext(sandbox);
  for (const arquivo of ['traducoes.js', 'i18n.js', 'grafo.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  return { cockpitGrafo: contexto.cockpitGrafo, cockpitI18n: contexto.cockpitI18n };
}

// ─── sw.js: a janela reaproveitada no notificationclick é a do APP, nunca a do grafo ───────

function carregarSw() {
  const sandbox = {
    self: {
      location: { href: 'https://cockpit.example/' },
      clients: { matchAll: null, openWindow: null },
      addEventListener: (nome, fn) => { sandbox.self[`__${nome}`] = fn; },
    },
    URL,
    console,
  };
  const contexto = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8'), contexto, { filename: 'sw.js' });
  return contexto.self;
}

function aba(url) {
  return { url, focada: false, navegouPara: null, focus: async function () { this.focada = true; }, navigate: async function (u) { this.navegouPara = u; } };
}

async function principal() {
  const { cockpitGrafo, cockpitI18n } = carregarGrafo();
  const { textoDoEstado, ordenar, urlDoGrafo, urlDoMapa, acaoDaLinha, paraJuntar, semGerando } = cockpitGrafo;
  const tr = (...args) => cockpitI18n.t(...args);
  const fmtFixo = () => '16/10 18:30';

  await bloco('textoDoEstado — em-dia/atras(singular e plural)/fora/desconhecido/sem grafo/sem develop', () => {
    const base = { nome: 'app-um', develop: true };
    ok(textoDoEstado({ ...base, grafo: { geradoEm: 'x', estado: 'em-dia', commitsAtras: 0 } }, tr, fmtFixo)
      === 'grafo da develop de 16/10 18:30 · em dia', 'em-dia');
    ok(textoDoEstado({ ...base, grafo: { geradoEm: 'x', estado: 'atras', commitsAtras: 1 } }, tr, fmtFixo)
      === 'grafo da develop de 16/10 18:30 · 1 commit atrás da develop', 'atras, singular (1 commit)');
    ok(textoDoEstado({ ...base, grafo: { geradoEm: 'x', estado: 'atras', commitsAtras: 3 } }, tr, fmtFixo)
      === 'grafo da develop de 16/10 18:30 · 3 commits atrás da develop', 'atras, plural (3 commits)');
    ok(textoDoEstado({ ...base, grafo: { geradoEm: 'x', estado: 'fora', commitsAtras: null } }, tr, fmtFixo)
      === 'grafo da develop de 16/10 18:30 · fora da história da develop', 'fora');
    ok(textoDoEstado({ ...base, grafo: { geradoEm: 'x', estado: 'desconhecido', commitsAtras: null } }, tr, fmtFixo)
      === 'grafo da develop de 16/10 18:30 · estado desconhecido', 'desconhecido');
    ok(textoDoEstado({ ...base, grafo: null }, tr, fmtFixo) === 'sem grafo ainda', 'sem grafo ainda');
    ok(textoDoEstado({ nome: 'x', develop: false, grafo: null }, tr, fmtFixo) === 'sem develop', 'sem develop');
  });

  await bloco('acaoDaLinha/textoDoEstado(gerando) — botão "Fazer grafo"/"Grafo", card grafo-botao-fazer-grafo', () => {
    ok(JSON.stringify(acaoDaLinha({ nome: 'a', develop: false, grafo: null })) === JSON.stringify({ rotulo: 'Grafo', ativo: false, tipo: null }),
      'sem develop: Grafo, inativo, tipo null (D88)');
    ok(JSON.stringify(acaoDaLinha({ nome: 'a', develop: true, grafo: { estado: 'em-dia', commitsAtras: 0 } })) === JSON.stringify({ rotulo: 'Grafo', ativo: true, tipo: 'abrir' }),
      'com grafo: Grafo, ativo, abrir');
    ok(JSON.stringify(acaoDaLinha({ nome: 'a', develop: true, grafo: null, gerando: true })) === JSON.stringify({ rotulo: 'Fazer grafo', ativo: false, tipo: 'fazer' }),
      'gerando: Fazer grafo, INATIVO, fazer');
    ok(JSON.stringify(acaoDaLinha({ nome: 'a', develop: true, grafo: null })) === JSON.stringify({ rotulo: 'Fazer grafo', ativo: true, tipo: 'fazer' }),
      'develop sem grafo, parado: Fazer grafo, ativo, fazer');

    ok(textoDoEstado({ nome: 'a', develop: true, grafo: null, gerando: true }, tr, fmtFixo) === 'gerando…', 'textoDoEstado: gerando…');
    ok(textoDoEstado({ nome: 'a', develop: false, gerando: true }, tr, fmtFixo) === 'sem develop', 'textoDoEstado: sem develop vence gerando');
  });

  await bloco('semGerando — a geração acompanhada terminou: a linha volta a ter botão', () => {
    const lista = [{ nome: 'a', develop: true, grafo: null, gerando: true }, { nome: 'b', develop: true, grafo: null, gerando: true }];
    const depois = semGerando(lista, 'a');
    ok(depois[0].gerando === false && depois[1].gerando === true, `só a linha "a" perde o gerando (achei ${JSON.stringify(depois)})`);
    ok(lista[0].gerando === true, 'não muta a lista original');
    const acao = acaoDaLinha(depois[0]);
    ok(acao.tipo === 'fazer' && acao.ativo === true, `o botão Fazer grafo volta ativo (achei ${JSON.stringify(acao)})`);
  });

  await bloco('paraJuntar — nomes que o servidor diz gerando e a tela ainda não acompanha', () => {
    const lista = [{ nome: 'a', gerando: true }, { nome: 'b' }, { nome: 'c', gerando: true }];
    ok(JSON.stringify(paraJuntar(lista, new Set(['c']))) === JSON.stringify(['a']), `exclui quem já está em emCurso (achei ${JSON.stringify(paraJuntar(lista, new Set(['c'])))})`);
    ok(JSON.stringify(paraJuntar([{ nome: 'x' }], new Set())) === JSON.stringify([]), 'lista sem gerando: vazio');
  });

  await bloco('ordenar — quem tem grafo primeiro, depois alfabética', () => {
    const lista = [
      { nome: 'zeta', grafo: { estado: 'em-dia' } },
      { nome: 'alfa', grafo: null },
      { nome: 'beta', grafo: { estado: 'atras' } },
      { nome: 'gama', grafo: null },
    ];
    const nomes = ordenar(lista).map((i) => i.nome);
    ok(JSON.stringify(nomes) === JSON.stringify(['beta', 'zeta', 'alfa', 'gama']),
      `com grafo primeiro (por nome), depois sem grafo (por nome) — achei ${JSON.stringify(nomes)}`);
  });

  await bloco('urlDoGrafo — token com espaço vira %20, sem token vira "-"', () => {
    ok(urlDoGrafo('app-um', 'tok en') === 'grafo/app-um/?token=tok%20en', `com token (achei ${urlDoGrafo('app-um', 'tok en')})`);
    ok(urlDoGrafo('app-um', '') === 'grafo/app-um/?token=-', `sem token (achei ${urlDoGrafo('app-um', '')})`);
  });

  await bloco('urlDoMapa — D96: sem token (abre na mesma aba e lê o localStorage)', () => {
    ok(urlDoMapa('app um') === 'mapa/app%20um/', `nome com espaço vira %20 (achei ${urlDoMapa('app um')})`);
    ok(urlDoMapa('app-um') === 'mapa/app-um/', `sem ?token (achei ${urlDoMapa('app-um')})`);
  });

  await bloco('fonte sem innerHTML/outerHTML/insertAdjacentHTML/document.write (#26)', () => {
    const fonte = fs.readFileSync(path.join(PUBLIC_DIR, 'grafo.js'), 'utf8')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const proibido of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      ok(!fonte.includes(proibido), `sem ${proibido}`);
    }
  });

  // D96 (regra da casa): grafo, mapa e diff moram na janela DO APP — o SW não poupa nenhuma.
  for (const [rotulo, url] of [['GRAFO', 'https://cockpit.example/grafo/app-um/?token=-'], ['MAPA', 'https://cockpit.example/mapa/app-um/'], ['DIFF', 'https://cockpit.example/diff/#job=x']]) {
    await bloco(`sw.js — notificationclick: só a janela do app na página ${rotulo}, COM sessaoId — foca e navega ela`, async () => {
      const janelaX = aba(url);
      const s = carregarSw();
      s.clients.matchAll = async () => [janelaX];
      let abriu = null;
      s.clients.openWindow = async (u) => { abriu = u; };
      let esperou;
      s.__notificationclick({ notification: { close: () => {}, data: { sessaoId: 'x' } }, waitUntil: (p) => { esperou = p; } });
      await esperou;
      ok(janelaX.focada === true, 'focou a janela');
      ok(janelaX.navegouPara && janelaX.navegouPara.includes('#c=x'), 'navegou ela para a conversa');
      ok(abriu === null, 'NÃO abriu janela nova');
    });
    await bloco(`sw.js — notificationclick: só a janela do app na página ${rotulo}, SEM sessaoId — só foca`, async () => {
      const janelaX = aba(url);
      const s = carregarSw();
      s.clients.matchAll = async () => [janelaX];
      let abriu = null;
      s.clients.openWindow = async (u) => { abriu = u; };
      let esperou;
      s.__notificationclick({ notification: { close: () => {}, data: {} }, waitUntil: (p) => { esperou = p; } });
      await esperou;
      ok(janelaX.focada === true, 'focou a janela');
      ok(!janelaX.navegouPara, 'não navegou');
      ok(abriu === null, 'NÃO abriu janela nova');
    });
  }
  await bloco('sw.js — notificationclick: DIFF e app abertas — foca a 1ª da lista (a diff), nunca abre janela nova', async () => {
    const janelaDiff = aba('https://cockpit.example/diff/#job=x');
    const janelaApp = aba('https://cockpit.example/');
    const s = carregarSw();
    s.clients.matchAll = async () => [janelaDiff, janelaApp];
    s.clients.openWindow = async () => { throw new Error('não devia abrir janela nova'); };
    let esperou;
    s.__notificationclick({ notification: { close: () => {}, data: { sessaoId: 'x' } }, waitUntil: (p) => { esperou = p; } });
    await esperou;
    ok(janelaDiff.focada === true, 'focou a 1ª (a da diff)');
    ok(!janelaApp.focada, 'não focou a 2ª');
  });

  console.log(`\n${passou}/${total} asserções`);
  console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — diálogo de grafos (puras) e sw.js');
  process.exitCode = vermelho ? 1 : 0;
}

principal();
