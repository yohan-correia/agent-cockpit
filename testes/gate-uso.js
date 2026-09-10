#!/usr/bin/env node
'use strict';
// GATE de lib/uso.js — card `para-onde-vao-meus-tokens`.
//
// Offline, sem servidor, sem gastar token da assinatura (armadilha #20): monta um HOME de
// mentira em mkdtemp com .claude/projects/ e .cockpit/jobs/ fabricados, aponta COCKPIT_USO_DIR
// para outro tmp, e nunca encosta em ~/.claude nem ~/.cockpit de verdade.
//
// Duas partes, no molde de gate-ui.js:
//   node testes/gate-uso.js           (parte 1 — os blocos da fase 1, offline)
//   node testes/gate-uso.js parte2    (parte 2 — a rota, contra o servidor no ar — fase 2)
//
// Inventário fechado — 35 blocos no total (plano §1.1): esta parte 1 cobre 30
// (G1–G10, G13–G19, G20a, G21–G23, G24a, G24b, G25–G27, G29–G32). Ficam de fora, e nascem
// nas fases que os sustentam: G11 (fase 2, precisa do servidor), G12/G12b/G20b (fase 3,
// precisam do HTML e do cliente), G28 (fase 4, precisa de conta-uso-independente.js).
//
// A maioria dos testes COMPARTILHA um único HOME e um único COCKPIT_USO_DIR pelo processo
// inteiro — cada teste cria sua PRÓPRIA pasta com nome único (g1, g2, g3...), então os dados
// nunca colidem mesmo com o cache acumulando entre blocos. Isso é deliberado: testar
// "append + 2ª varredura" (G3, G17...) PRECISA que o cache sobreviva entre duas chamadas.
// Só onde um cenário exige um cache genuinamente VAZIO (ex.: G18b, cache.json corrompido) o
// módulo é recarregado (`recarregarUso`) com um COCKPIT_USO_DIR novo — o mesmo padrão de
// `delete require.cache` que gate-ui.js usa para lib/abas.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execFile } = require('node:child_process');

const RAIZ_REPO = path.resolve(__dirname, '..');
const LIB_USO = path.join(RAIZ_REPO, 'lib', 'uso.js');

let passou = 0;
let total = 0;
let vermelho = false;
const CASOS = new Set();
const CASOS_ESPERADOS = [
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10',
  'G13', 'G14', 'G15', 'G16', 'G17', 'G18', 'G19', 'G20a',
  'G21', 'G22', 'G23', 'G24a', 'G24b', 'G25', 'G26', 'G27',
  'G29', 'G30', 'G31', 'G32',
  // fase 3 (D32 / #16) — nascem depois do HTML e do cliente existirem
  'G12', 'G12b', 'G20b',
  // fase 4 — precisa de testes/conta-uso-independente.js
  'G28',
  // card `tokens-mais-detalhe` — custo, por modelo e por dia
  'G20c', 'G33', 'G34', 'G35', 'G36', 'G37', 'G38', 'G39',
];

function ok(condicao, mensagem) {
  total += 1;
  if (condicao) { passou += 1; console.log(`  ✅ ${mensagem}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${mensagem}`);
  return false;
}
function assert(condicao, mensagem) { return ok(Boolean(condicao), mensagem); }
function titulo(t) {
  // `[a-c]` e não `[ab]`: o G20c do card `tokens-mais-detalhe` não seria registrado, e o
  // gate acusaria "caso que NÃO rodou" para um bloco que rodou e passou.
  const m = /^([A-Z]\d+[a-c]?)\./.exec(t);
  if (m) CASOS.add(m[1]);
  console.log(`\n${t}`);
}
/** Roda UM bloco isolado — se ele estourar, os outros 29 continuam (mesmo espírito do
 * `grupo()` de gate-ui.js: um bloco que quebra não pode esconder o vermelho dos demais). */
async function bloco(nomeParaTitulo, fn) {
  titulo(nomeParaTitulo);
  try {
    await fn();
  } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.message}`);
    if (e && e.stack) console.log(`     ${e.stack.split('\n').slice(1, 3).join('\n     ')}`);
  }
}

// ─── o mundo de mentira ──────────────────────────────────────────────────────

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-home-'));
const PROJETOS = path.join(HOME, '.claude', 'projects');
const JOBS = path.join(HOME, '.cockpit', 'jobs');
fs.mkdirSync(PROJETOS, { recursive: true });
fs.mkdirSync(JOBS, { recursive: true });
process.env.HOME = HOME;                                  // ANTES do require — o módulo resolve no topo
process.env.COCKPIT_USO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-cache-'));
// A pasta dos jobs deixou de sair de uma constante de topo de `lib/uso.js` e passou a vir de
// `limite.dirJobs()`, que lê o ENV a cada chamada. Sem esta linha o gate leria o `~/.cockpit`
// de VERDADE de quem roda — o HOME falso deixaria de isolar justamente o que ele isolava.
process.env.COCKPIT_JOBS_DIR = JOBS;
let uso = require(LIB_USO);

/** Recarrega lib/uso.js do zero (module cache busting), com um COCKPIT_USO_DIR NOVO — é o
 * único jeito de zerar `cacheEmMemoria` (variável de módulo) para um cenário que precisa de
 * cache genuinamente vazio. HOME continua o mesmo: as pastas já criadas no disco não somem. */
function recarregarUso(novoCacheDir) {
  process.env.COCKPIT_USO_DIR = novoCacheDir;
  delete require.cache[LIB_USO];
  uso = require(LIB_USO);
  return uso;
}

const cru = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const PRE_WORKTREE = `${cru(path.join(HOME, '.cockpit', 'worktrees'))}-`;
const PRE_PROJETO = `${cru(path.join(HOME, 'projetos'))}-`;

function pastaAba(nome) {
  const pasta = PRE_PROJETO + nome;
  const abs = path.join(PROJETOS, pasta);
  fs.mkdirSync(abs, { recursive: true });
  return { pasta, abs };
}
function pastaJob(id, meta) {
  const pasta = PRE_WORKTREE + id;
  const abs = path.join(PROJETOS, pasta);
  fs.mkdirSync(abs, { recursive: true });
  if (meta !== undefined) {
    const jobDir = path.join(JOBS, id);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify(meta));
  }
  return { pasta, abs };
}
/** Uma linha `assistant` com `usage` — o molde que a maioria dos blocos usa. `modelo` fica
 * SEMPRE em 'claude-opus-5' salvo indicação contrária, para o G26 (whitelist de chaves) poder
 * fechar uma lista curta de ids de modelo conhecidos. */
function linhaUsage({ ts = '2026-09-04T10:00:00.000Z', modelo = 'claude-opus-5', input = 100, output = 0, cw = 0, cr = 0, extra = {} } = {}) {
  return `${JSON.stringify({
    type: 'assistant', timestamp: ts, isSidechain: false,
    message: {
      model: modelo,
      usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cw, cache_read_input_tokens: cr },
      content: [{ type: 'text', text: 'oi' }],
    },
    ...extra,
  })}\n`;
}
/** Uma linha `assistant` PADDED para caber em EXATAMENTE `alvoBytes` (com o '\n' incluído) —
 * o mesmo truque de `molde()` em gate-externo-blocos.js, usado por G22 para controlar onde a
 * fronteira dos 256 bytes da assinatura cai. */
function linhaComTamanho(alvoBytes, { input = 50 } = {}) {
  for (let pad = 0; pad < 4000; pad += 1) {
    const s = `${JSON.stringify({
      type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z',
      message: { model: 'claude-opus-5', usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: 'p'.repeat(pad) }] },
    })}\n`;
    if (Buffer.byteLength(s) === alvoBytes) return s;
  }
  throw new Error(`linhaComTamanho(${alvoBytes}) não fecha`);
}
/**
 * Como `linhaComTamanho`, mas com `usage` (o `input_tokens` que muda) por ÚLTIMO no objeto —
 * perto do FIM da linha serializada, e não perto do início. Existe porque `linhaComTamanho`
 * põe `usage` ANTES do preenchimento (`content`), e duas chamadas com `input` diferente (ex.
 * 11 e 22, mesma quantidade de dígitos) produzem um preenchimento IDÊNTICO — a diferença fica
 * toda nos primeiros ~30 bytes, fora da janela de 256 bytes que `assinaturaDe` lê no FIM do
 * arquivo. G22b (achado na prova de vermelho de 1.5) precisa que a diferença caia DENTRO da
 * cauda, senão testa sem querer o limite já documentado no cabeçalho de `assinaturaDe`
 * ("duas guardas não são uma soma criptográfica"), não a mutação em questão.
 */
function linhaComTamanhoNaCauda(alvoBytes, { input }) {
  for (let pad = 0; pad < 4000; pad += 1) {
    const s = `${JSON.stringify({
      type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z',
      message: { content: [{ type: 'text', text: 'p'.repeat(pad) }], model: 'claude-opus-5', usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    })}\n`;
    if (Buffer.byteLength(s) === alvoBytes) return s;
  }
  throw new Error(`linhaComTamanhoNaCauda(${alvoBytes}) não fecha`);
}
/** Uma linha `user` GIGANTE (> TETO_LINHA), para os blocos do teto de 1 MB. */
function linhaGigante(ts = '2026-09-04T10:00:00.000Z') {
  return `{"type":"user","timestamp":"${ts}","message":{"content":"${'w'.repeat(uso.TETO_LINHA + 500)}"}}\n`;
}

// ─── DOM de mentira — G12b (public/app.js) e G20b (public/uso.js) ──────────
//
// Molde: `carregarCliente`/`criarElemento` de gate-ui.js:63-366, reimplementado aqui em
// versão ENXUTA (só o que app.js e uso.js encostam no load), para gate-uso.js não depender
// de gate-ui.js — sem contrato entre os dois arquivos de gate.

function criarElementoFalso(tag) {
  const el = {
    tag, filhos: [], pai: null, atributos: {}, dataset: {}, className: '', hidden: false,
    disabled: false, open: false, _texto: '',
    style: { cssText: '', setProperty(n, v) { this[n] = String(v); }, removeProperty(n) { delete this[n]; }, getPropertyValue(n) { return this[n] ?? ''; } },
    get textContent() {
      // O `|| n._texto || ''` no fim é o que faz `el.textContent = 'x'` (que zera `filhos` e só
      // guarda `_texto`, sem criar um nó `#texto` filho) voltar a aparecer na leitura — sem
      // isto, todo `p.textContent = texto` some ao ler de volta (achado rodando G20b, 04/09:
      // o rodapé aparecia sempre "" mesmo com o aviso desenhado de verdade).
      const juntar = (n) => (n.tag === '#texto' ? n.valor : n.filhos.map(juntar).join('') || n._texto || '');
      return juntar(el);
    },
    set textContent(v) { el.filhos = []; el._texto = String(v); },
    append(...nos) { for (const n of nos) { const f = typeof n === 'string' ? { tag: '#texto', valor: n } : n; f.pai = el; el.filhos.push(f); } },
    appendChild(no) { el.append(no); return no; },
    setAttribute(k, v) { el.atributos[k] = String(v); },
    getAttribute(k) { return el.atributos[k]; },
    removeAttribute(k) { delete el.atributos[k]; },
    ouvintes: new Map(),
    addEventListener(tipo, fn) { if (!el.ouvintes.has(tipo)) el.ouvintes.set(tipo, []); el.ouvintes.get(tipo).push(fn); },
    removeEventListener(tipo, fn) { el.ouvintes.set(tipo, (el.ouvintes.get(tipo) || []).filter((f) => f !== fn)); },
    disparar(tipo, evento = {}) { for (const fn of el.ouvintes.get(tipo) || []) fn(evento); return evento; },
    focus() {}, remove() { if (el.pai) { el.pai.filhos = el.pai.filhos.filter((f) => f !== el); el.pai = null; } },
    scrollIntoView() {}, showModal() { el.open = true; }, close() { el.open = false; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    get lastChild() { return el.filhos[el.filhos.length - 1] || null; },
    get children() { return el.filhos.filter((f) => f.tag !== '#texto'); },
  };
  return el;
}

/**
 * Carrega public/app.js num sandbox mínimo, com `window.open` ESPIÃO — o do molde
 * (gate-ui.js:277) é no-op e não serve para provar QUAL URL o clique manda (ponto 5 da
 * 4ª rodada do painel).
 *
 * Fase 2b (04/09): opcionalmente carrega uso.js NO MESMO CONTEXTO logo em seguida — é o que
 * reproduz o navegador de verdade (dois <script> clássicos, um só documento). `ordem:
 * 'uso-primeiro'` existe só como BLINDAGEM contra alguém trocar as tags de lugar no HTML
 * (A8b) — a ordem real é `app.js` primeiro (P3-b).
 */
function carregarAppJsComEspiaoDeOpen({ comUso = false, ordem = 'app-primeiro', tokenGuardado = 'tok', respostaFetchUso } = {}) {
  const vm = require('node:vm');
  const codigoApp = fs.readFileSync(path.join(RAIZ_REPO, 'public', 'app.js'), 'utf8');
  const porId = new Map();
  const chamadasOpen = [];
  // A7 (04/09): o clique em #btn-uso não pode mais empilhar histórico — espião próprio,
  // separado do `pushState` de mentira que só existia para não estourar.
  const chamadasPushState = [];
  // A8 (04/09): quantas vezes /api/uso foi pedido — 0 no carregamento, 1 depois do clique.
  const chamadasFetchUso = [];
  const contexto = {
    document: {
      getElementById: (id) => { if (!porId.has(id)) porId.set(id, criarElementoFalso('div')); return porId.get(id); },
      createElement: criarElementoFalso,
      createDocumentFragment: () => criarElementoFalso('#fragmento'),
      createTextNode: (v) => ({ tag: '#texto', valor: String(v), filhos: [], get data() { return this.valor; }, set data(v) { this.valor = String(v); } }),
      addEventListener: () => {},
      hidden: false,
      documentElement: criarElementoFalso('html'),
    },
    localStorage: { getItem: (k) => (k === 'cockpit-token' ? tokenGuardado : null), setItem: () => {}, removeItem: () => {} },
    location: { href: 'http://z/', origin: 'http://z', pathname: '/', search: '', hash: '', hostname: 'z' },
    history: { pushState: (...args) => { chamadasPushState.push(args); }, replaceState: () => {}, back: () => {} },
    URL, URLSearchParams,
    navigator: { userAgent: 'gate-uso/1.0' },
    window: { addEventListener: () => {}, open: (...args) => { chamadasOpen.push(args); } },
    atob: (t) => Buffer.from(t, 'base64').toString('binary'),
    Uint8Array,
    CSS: { escape: (s) => s },
    // `addEventListener`/`removeEventListener` no-op: o boot do M1 (04/09) registra um
    // 'change' em `matchMedia(...)` — sem os dois aqui, carregar o app.js estourava ESTE
    // sandbox inteiro (o mesmo achado do gate-ui.js).
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    fetch: async (rota) => {
      if (/api\/uso/.test(String(rota))) {
        chamadasFetchUso.push(String(rota));
        const corpo = typeof respostaFetchUso === 'function' ? respostaFetchUso(rota) : (respostaFetchUso || {});
        return { ok: true, status: 200, json: async () => corpo };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    EventSource: function EventSource() { return { close() {} }; },
    XMLHttpRequest: function XMLHttpRequest() { return { open() {}, setRequestHeader() {}, send() {}, abort() {}, upload: {} }; },
    setInterval: () => 1, setTimeout: () => 0, clearInterval: () => {}, clearTimeout: () => {},
    console, alert: () => {}, confirm: () => false,
  };
  vm.createContext(contexto);
  for (const arquivo of ['traducoes.js', 'i18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(RAIZ_REPO, 'public', arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  if (comUso) {
    const codigoUso = fs.readFileSync(path.join(RAIZ_REPO, 'public', 'uso.js'), 'utf8');
    const [primeiro, nomePrimeiro, segundo, nomeSegundo] = ordem === 'uso-primeiro'
      ? [codigoUso, 'uso.js', codigoApp, 'app.js']
      : [codigoApp, 'app.js', codigoUso, 'uso.js'];
    vm.runInContext(primeiro, contexto, { filename: nomePrimeiro });
    vm.runInContext(segundo, contexto, { filename: nomeSegundo });
  } else {
    vm.runInContext(codigoApp, contexto, { filename: 'app.js' });
  }
  return { porId, chamadasOpen, chamadasPushState, chamadasFetchUso, contexto };
}

/** Carrega public/uso.js num sandbox mínimo — o que ele encosta é bem menor que app.js
 * (sem EventSource, sem history, sem setInterval): document, localStorage, fetch. */
function carregarUsoJsFalso({ token = 'tok', respostaFetch } = {}) {
  const vm = require('node:vm');
  const codigo = fs.readFileSync(path.join(RAIZ_REPO, 'public', 'uso.js'), 'utf8');
  const porId = new Map();
  const chamadasFetch = [];
  const contexto = {
    document: {
      getElementById: (id) => { if (!porId.has(id)) porId.set(id, criarElementoFalso('div')); return porId.get(id); },
      createElement: criarElementoFalso,
    },
    localStorage: { getItem: (k) => (k === 'cockpit-token' ? token : null), setItem: () => {}, removeItem: () => {} },
    fetch: async (rota, opcoes) => {
      chamadasFetch.push([rota, opcoes]);
      const corpo = typeof respostaFetch === 'function' ? respostaFetch(rota) : respostaFetch;
      if (corpo && corpo.__status === 401) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => corpo };
    },
    console,
  };
  vm.createContext(contexto);
  for (const arquivo of ['traducoes.js', 'i18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(RAIZ_REPO, 'public', arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  vm.runInContext(codigo, contexto, { filename: 'uso.js' });
  return { porId, chamadasFetch, contexto };
}

// ─── parte 1 — os 30 blocos da fase 1 ───────────────────────────────────────

async function parte1() {
  console.log(`\ngate-uso — parte 1 (offline) — ${process.version} ${process.platform}/${process.arch}`);
  console.log(`HOME de mentira: ${HOME}`);

  await bloco('G1. soma dos 4 campos de um .jsonl de mentira bate com o valor calculado à mão', async () => {
    const { abs } = pastaAba('g1');
    fs.writeFileSync(path.join(abs, 'a.jsonl'),
      linhaUsage({ input: 10, output: 20, cw: 30, cr: 40 }) + linhaUsage({ input: 1, output: 2, cw: 3, cr: 4 }));
    const r = await uso.relatorio({ dias: 1 });
    const p = r.projetos.find((x) => x.projeto === 'g1');
    assert(p && p.total.entrada === 11 && p.total.saida === 22 && p.total.cacheEscrita === 33 && p.total.cacheLeitura === 44,
      `g1: entrada=11 saida=22 cacheEscrita=33 cacheLeitura=44 (veio ${p && JSON.stringify(p.total)})`);
  });

  await bloco('G2. classificar(): os 4 casos de origem (§3.1.4)', async () => {
    const comMeta = uso.classificar(`${PRE_WORKTREE}job1`, { project: 'meu-projeto', type: 'ataca', title: 'card x' });
    assert(comMeta.origem === 'job' && comMeta.projeto === 'meu-projeto' && comMeta.rotulo === 'ataca: card x',
      `com meta.json: ${JSON.stringify(comMeta)}`);
    const semMeta = uso.classificar(`${PRE_WORKTREE}job2`, null);
    assert(semMeta.origem === 'job' && semMeta.projeto === '(job sem registro)' && semMeta.rotulo === 'job2',
      `sem meta.json: ${JSON.stringify(semMeta)}`);
    const aba = uso.classificar(`${PRE_PROJETO}cockpit-agentes`, null);
    assert(aba.origem === 'aba' && aba.projeto === 'cockpit-agentes' && aba.rotulo === 'aba ~/projetos/cockpit-agentes',
      `aba: ${JSON.stringify(aba)}`);
    const outro = uso.classificar('-tmp-gate-xyz', null);
    assert(outro.origem === 'outro' && outro.projeto === '(fora de projeto)', `outro: ${JSON.stringify(outro)}`);
  });

  await bloco('G3. append + 2ª varredura: incremental, sem contar 2 vezes', async () => {
    const { abs } = pastaAba('g3');
    const arq = path.join(abs, 'a.jsonl');
    fs.writeFileSync(arq, linhaUsage({ input: 1 }) + linhaUsage({ input: 2 }) + linhaUsage({ input: 3 }));
    await uso.varrer();
    const tamanhoAntes = fs.statSync(arq).size;
    fs.appendFileSync(arq, linhaUsage({ input: 4 }) + linhaUsage({ input: 5 }));
    const tamanhoDepois = fs.statSync(arq).size;
    const estado2 = await uso.varrer();
    const r = uso.montar(estado2, 1);
    const p = r.projetos.find((x) => x.projeto === 'g3');
    assert(p && p.total.linhas === 5, `5 linhas ao todo (veio ${p && p.total.linhas})`);
    assert(p && p.total.entrada === 15, `soma de entrada = 1+2+3+4+5=15 (veio ${p && p.total.entrada})`);
    assert(estado2.leitura.bytesLidos === tamanhoDepois - tamanhoAntes,
      `2ª leitura só do pedaço novo: bytesLidos=${estado2.leitura.bytesLidos} === ${tamanhoDepois - tamanhoAntes}`);
  });

  await bloco('G4. linha incompleta (sem \\n no fim): não entra até fechar, entra só 1 vez depois', async () => {
    const { abs } = pastaAba('g4');
    const arq = path.join(abs, 'a.jsonl');
    const completa = linhaUsage({ input: 7 });
    fs.writeFileSync(arq, completa.slice(0, -1));
    let r = uso.montar(await uso.varrer(), 1);
    let p = r.projetos.find((x) => x.projeto === 'g4');
    assert(!p, `sem \\n no fim: a linha NÃO entra ainda (${p ? 'apareceu' : 'ausente, como esperado'})`);
    fs.appendFileSync(arq, '\n');
    r = uso.montar(await uso.varrer(), 1);
    p = r.projetos.find((x) => x.projeto === 'g4');
    assert(p && p.total.entrada === 7 && p.total.linhas === 1, `ao fechar: entra 1 vez, entrada=7 (veio ${p && JSON.stringify(p.total)})`);
  });

  await bloco('G5. truncar: o agregado antigo é DESCARTADO, não somado', async () => {
    const { abs } = pastaAba('g5');
    const arq = path.join(abs, 'a.jsonl');
    fs.writeFileSync(arq, linhaUsage({ input: 100 }) + linhaUsage({ input: 200 }));
    await uso.varrer();
    fs.writeFileSync(arq, linhaUsage({ input: 9 }));
    const r = uso.montar(await uso.varrer(), 1);
    const p = r.projetos.find((x) => x.projeto === 'g5');
    assert(p && p.total.entrada === 9 && p.total.linhas === 1, `só o que está lá agora: entrada=9 (veio ${p && JSON.stringify(p.total)})`);
  });

  await bloco('G6. usage zerado (<synthetic>) some da conta; isSidechain CONTA', async () => {
    const { abs } = pastaAba('g6');
    const sintetica = `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n`;
    fs.writeFileSync(path.join(abs, 'a.jsonl'), sintetica + linhaUsage({ input: 5, extra: { isSidechain: true } }));
    const r = await uso.relatorio({ dias: 1 });
    const p = r.projetos.find((x) => x.projeto === 'g6');
    assert(p && p.total.linhas === 1 && p.total.entrada === 5, `só o subagente conta, a sintética some (veio ${p && JSON.stringify(p.total)})`);
  });

  await bloco('G7. JSON quebrado no meio do arquivo não derruba a varredura', async () => {
    const { abs } = pastaAba('g7');
    fs.writeFileSync(path.join(abs, 'a.jsonl'), linhaUsage({ input: 1 }) + 'isto nao e json\n' + linhaUsage({ input: 2 }));
    const r = await uso.relatorio({ dias: 1 });
    const p = r.projetos.find((x) => x.projeto === 'g7');
    assert(p && p.total.linhas === 2 && p.total.entrada === 3, `as 2 linhas boas contam, o lixo é pulado (veio ${p && JSON.stringify(p.total)})`);
  });

  await bloco('G8. caractere multibyte sobre a fronteira do bloco de 64 KB', async () => {
    const { abs } = pastaAba('g8');
    const objBase = { type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z', message: { model: 'claude-opus-5', usage: { input_tokens: 42, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: '' }] } };
    const antesDoTexto = JSON.stringify(objBase).indexOf('"text":"') + 8;
    const enche = Math.max(0, 65536 - antesDoTexto);
    const texto = `${'x'.repeat(enche)}éé🙂${'y'.repeat(50)}`;
    objBase.message.content[0].text = texto;
    const linha = `${JSON.stringify(objBase)}\n`;
    const posDoAcento = Buffer.from(linha, 'utf8').indexOf(Buffer.from('éé🙂', 'utf8'));
    assert(posDoAcento >= 65500 && posDoAcento <= 65600, `o 'é' cai perto da fronteira de 64 KB (medido ${posDoAcento})`);
    fs.writeFileSync(path.join(abs, 'a.jsonl'), linha);
    const r = await uso.relatorio({ dias: 1 });
    const p = r.projetos.find((x) => x.projeto === 'g8');
    assert(p && p.total.entrada === 42 && p.total.linhas === 1, `a linha atravessou a fronteira inteira, foi parseada (veio ${p && JSON.stringify(p.total)})`);
  });

  // O TETO abaixo (117 MB) foi CALIBRADO NESTE fixture, não herdado de outra medição — lição
  // cara, achada na prova de vermelho de 1.5 (04/09): o primeiro teto (250 MB) veio do RSS de
  // 158 MB varrendo os 729 MB REAIS do disco do usuário, colado aqui sem refazer a conta para um
  // fixture de só 40 MB. Resultado: a mutação 8 (trocar o laço de blocos por
  // `readFile(caminho,'utf8').split('\n')`) mediu 175,4 MB de maxRSS — MUITO abaixo de 250 MB
  // — e o gate passou raspando por cima do próprio bug que existe para pegar.
  //
  // A calibração certa fica ENTRE as duas implementações, medidas NO MESMO fixture de 40 MB:
  //   RSS_STREAM   = 58,7 MB  (a implementação de verdade, por blocos — medido em 04/09)
  //   RSS_READFILE = 175,4 MB (a mutação 8 — todo o arquivo materializado de uma vez)
  //   TETO         = round(RSS_STREAM × 2) = 117 MB
  // 117 MB dá 2× de folga sobre o comportamento correto (absorve variação de GC/máquina sob
  // carga) e fica a mais de 25% de distância do comportamento errado (117 < 175,4 × 0,75 =
  // 131,55) — não passa raspando. Se o `stream real` medido um dia mudar o bastante para
  // furar essa folga de 25%, o teto TEM que ser recalibrado com os dois números de novo — não
  // só afrouxado no escuro.
  const TETO_G9_MB = 117;
  await bloco(`G9. memória, em PROCESSO FILHO dedicado: 40 MB varridos, maxRSS < ${TETO_G9_MB} MB`, async () => {
    const dirIsolado = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-g9-home-'));
    const pastaAbs = path.join(dirIsolado, '.claude', 'projects', `${PRE_PROJETO}g9gigante`);
    fs.mkdirSync(pastaAbs, { recursive: true });
    const arq = path.join(pastaAbs, 'a.jsonl');
    const fd = fs.openSync(arq, 'w');
    const linhaBase = linhaUsage({ input: 1 });
    const repeticoes = Math.ceil((40 * 1024 * 1024) / Buffer.byteLength(linhaBase));
    for (let i = 0; i < repeticoes; i += 1) fs.writeSync(fd, linhaBase);
    fs.closeSync(fd);
    const tamanhoMB = (fs.statSync(arq).size / (1024 * 1024)).toFixed(1);
    const cacheIsolado = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-g9-cache-'));
    const script = `
      process.env.HOME = ${JSON.stringify(dirIsolado)};
      process.env.COCKPIT_USO_DIR = ${JSON.stringify(cacheIsolado)};
      process.env.COCKPIT_JOBS_DIR = ${JSON.stringify(path.join(dirIsolado, '.cockpit', 'jobs'))};
      const uso = require(${JSON.stringify(LIB_USO)});
      (async () => { await uso.relatorio({ dias: 1 }); console.log(process.resourceUsage().maxRSS); })();`;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const maxRssMB = Number(out.trim()) / 1024;
    console.log(`  ℹ️  arquivo de ${tamanhoMB} MB, maxRSS medido = ${maxRssMB.toFixed(1)} MB`);
    assert(maxRssMB < TETO_G9_MB, `maxRSS ${maxRssMB.toFixed(1)} MB < ${TETO_G9_MB} MB`);
    fs.rmSync(dirIsolado, { recursive: true, force: true });
    fs.rmSync(cacheIsolado, { recursive: true, force: true });
  });

  await bloco('G10. nenhum texto de mensagem vaza — nem na resposta, nem no cache.json', async () => {
    const { abs } = pastaAba('g10segredo');
    fs.writeFileSync(path.join(abs, 'a.jsonl'), `${JSON.stringify({
      type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z',
      message: { model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: 'SEGREDO-NAO-PODE-VAZAR' }] },
    })}\n`);
    const r = await uso.relatorio({ dias: 1 });
    assert(!JSON.stringify(r).includes('SEGREDO'), 'a string SEGREDO não aparece na resposta');
    const textoCache = fs.readFileSync(path.join(process.env.COCKPIT_USO_DIR, 'cache.json'), 'utf8');
    assert(!textoCache.includes('SEGREDO'), 'a string SEGREDO não aparece no cache.json gravado');
  });

  await bloco('G13. subagente (<sessao>/subagents/agent-x.jsonl) soma no projeto DAQUELA pasta (R1)', async () => {
    const { abs } = pastaAba('g13');
    const sessaoDir = path.join(abs, 'sessao-pai', 'subagents');
    fs.mkdirSync(sessaoDir, { recursive: true });
    fs.writeFileSync(path.join(abs, 'sessao-pai.jsonl'), linhaUsage({ input: 10 }));
    fs.writeFileSync(path.join(sessaoDir, 'agent-x.jsonl'), linhaUsage({ input: 20, extra: { isSidechain: true } }));
    const r = await uso.relatorio({ dias: 1 });
    const p = r.projetos.find((x) => x.projeto === 'g13');
    assert(p && p.total.entrada === 30, `pai (10) + subagente (20) = 30 (veio ${p && p.total.entrada})`);
  });

  await bloco('G14. a varredura não emudece o cockpit — pior atraso do event loop < 250 ms', async () => {
    const { abs } = pastaAba('g14grande');
    const arq = path.join(abs, 'a.jsonl');
    const fd = fs.openSync(arq, 'w');
    const linhaBase = linhaUsage({ input: 1 });
    const repeticoes = Math.ceil((40 * 1024 * 1024) / Buffer.byteLength(linhaBase));
    for (let i = 0; i < repeticoes; i += 1) fs.writeSync(fd, linhaBase);
    fs.closeSync(fd);

    // `monitorEventLoopDelay`, NUNCA um setInterval com clearInterval logo depois do await
    // (plano §1.6, ponto 2 da 4ª rodada do painel): a continuação de um `await` é MICROTASK e
    // roda ANTES de um timer atrasado — se a varredura bloqueasse o event loop, os callbacks
    // do interval ficariam na fila, o `await` resolveria primeiro, e o `clearInterval` mataria
    // justamente os callbacks que registrariam o atraso. `piorAtraso` sairia 0 aprovando a
    // própria implementação bloqueante que este gate existe para reprovar. O histograma do
    // kernel não depende de nenhum timer chegar a rodar: ele mede o atraso real do loop,
    // mesmo que o loop esteja tão travado que nenhum callback tenha chance de disparar.
    const { monitorEventLoopDelay } = require('node:perf_hooks');
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    const r = await uso.relatorio({ dias: 1 });
    h.disable();
    const piorAtraso = h.max / 1e6;   // ns → ms
    console.log(`  ℹ️  pior atraso medido = ${piorAtraso.toFixed(1)} ms, bytesLidos = ${(r.leitura.bytesLidos / 1e6).toFixed(1)} MB`);
    // Sem isto, um bug que fizesse a varredura PULAR o arquivo de 40 MB (pasta não achada,
    // filtro errado) devolveria `piorAtraso` perto de 0 e o gate passaria tendo medido o
    // atraso de NADA — a mesma família de assert oco do G21/G29: prova o tempo sem provar que
    // o trabalho aconteceu.
    assert(r.leitura.bytesLidos > 30 * 1024 * 1024, `a varredura leu de verdade os ~40 MB do fixture (bytesLidos=${r.leitura.bytesLidos})`);
    assert(piorAtraso < 250, `pior atraso ${piorAtraso.toFixed(1)} ms < 250 ms`);
  });

  await bloco('G15. linha > TETO_LINHA é pulada; as linhas em volta continuam contando (R3)', async () => {
    const { abs } = pastaAba('g15');
    fs.writeFileSync(path.join(abs, 'a.jsonl'), linhaUsage({ input: 3 }) + linhaGigante() + linhaUsage({ input: 4 }));
    const r = await uso.relatorio({ dias: 1 });
    const p = r.projetos.find((x) => x.projeto === 'g15');
    assert(p && p.total.entrada === 7 && p.total.linhas === 2, `as 2 linhas normais contam, a gigante não (veio ${p && JSON.stringify(p.total)})`);
    assert(r.leitura.linhasIgnoradas >= 1, `linhasIgnoradas >= 1 (veio ${r.leitura.linhasIgnoradas})`);
  });

  await bloco('G16. relatorio({dias:1}) e relatorio({dias:30}) SIMULTÂNEAS: 1 varredura, 2 relatórios diferentes', async () => {
    recarregarUso(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-g16-cache-')));
    pastaAba('g16hoje');
    fs.writeFileSync(path.join(PROJETOS, `${PRE_PROJETO}g16hoje`, 'a.jsonl'), linhaUsage({ input: 5, ts: '2026-09-04T10:00:00.000Z' }));
    pastaAba('g16velho');
    // 15 dias atrás: fora da janela de 1 dia, mas DENTRO da de 30 — prova a diferença sem
    // depender de uma poda que já teria descartado uma data de anos atrás (>30 dias, R4).
    const quinzeDiasAtras = new Date(Date.now() - 15 * 86400000).toISOString();
    fs.writeFileSync(path.join(PROJETOS, `${PRE_PROJETO}g16velho`, 'a.jsonl'), linhaUsage({ input: 500, ts: quinzeDiasAtras }));

    const fsp = require('node:fs/promises');
    const readdirOriginal = fsp.readdir;
    let chamadasNaRaiz = 0;
    fsp.readdir = (...args) => {
      if (args[0] === PROJETOS) chamadasNaRaiz += 1;
      return readdirOriginal(...args);
    };
    let r1;
    let r30;
    try {
      [r1, r30] = await Promise.all([uso.relatorio({ dias: 1 }), uso.relatorio({ dias: 30 })]);
    } finally { fsp.readdir = readdirOriginal; }
    assert(chamadasNaRaiz === 1, `readdir da raiz rodou 1 vez para as 2 chamadas concorrentes (rodou ${chamadasNaRaiz})`);
    assert(r1.dias === 1 && r30.dias === 30, 'os dois relatórios preservam o `dias` pedido');
    const p1 = r1.projetos.find((x) => x.projeto === 'g16velho');
    const p30 = r30.projetos.find((x) => x.projeto === 'g16velho');
    assert(!p1, 'dias=1 NÃO inclui o projeto de 2020 (fora da janela)');
    assert(p30 && p30.total.entrada === 500, `dias=30 inclui, entrada=500 (veio ${p30 && p30.total.entrada})`);
  });

  await bloco('G17. truncar e CRESCER além do offset antigo: agregado velho descartado (ino/assinatura)', async () => {
    const { abs } = pastaAba('g17');
    const arq = path.join(abs, 'a.jsonl');
    fs.writeFileSync(arq, linhaUsage({ input: 100 }) + linhaUsage({ input: 200 }) + linhaUsage({ input: 300 }));
    await uso.varrer();
    fs.writeFileSync(arq, linhaUsage({ input: 1 }) + linhaUsage({ input: 2 }) + linhaUsage({ input: 3 }) + linhaUsage({ input: 4 }));
    const r = uso.montar(await uso.varrer(), 1);
    const p = r.projetos.find((x) => x.projeto === 'g17');
    assert(p && p.total.entrada === 10 && p.total.linhas === 4, `só o conteúdo NOVO conta: 1+2+3+4=10, 4 linhas (veio ${p && JSON.stringify(p.total)})`);
  });

  await bloco('G18. falha de cache NUNCA derruba relatorio() — nem escrita, nem leitura corrompida', async () => {
    // (a) escrita: COCKPIT_USO_DIR cujo PAI é um arquivo comum ⇒ mkdir dá ENOTDIR — determinístico
    // mesmo como root (ao contrário de pasta somente-leitura, ponto 7 da 3ª rodada do painel).
    const paiArquivo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-g18-'));
    fs.writeFileSync(path.join(paiArquivo, 'arq'), 'nao sou pasta');
    const antigoDir = process.env.COCKPIT_USO_DIR;
    process.env.COCKPIT_USO_DIR = path.join(paiArquivo, 'arq', 'uso');
    const { abs } = pastaAba('g18escrita');
    fs.writeFileSync(path.join(abs, 'a.jsonl'), linhaUsage({ input: 8 }));
    let r;
    let lancou = false;
    try { r = await uso.relatorio({ dias: 1 }); } catch { lancou = true; }
    process.env.COCKPIT_USO_DIR = antigoDir;
    assert(!lancou, 'gravação falhando (ENOTDIR) não derruba relatorio()');
    const p = r && r.projetos.find((x) => x.projeto === 'g18escrita');
    assert(p && p.total.entrada === 8, `e a resposta sai normal, com o dado lido (veio ${p && p.total.entrada})`);

    // (b) leitura: cache.json corrompido faz varrer do zero
    const dirCorrompido = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-g18b-'));
    fs.writeFileSync(path.join(dirCorrompido, 'cache.json'), '{ isto nao fecha');
    recarregarUso(dirCorrompido);
    const { abs: abs2 } = pastaAba('g18leitura');
    fs.writeFileSync(path.join(abs2, 'a.jsonl'), linhaUsage({ input: 12 }));
    const r2 = await uso.relatorio({ dias: 1 });
    const p2 = r2.projetos.find((x) => x.projeto === 'g18leitura');
    assert(p2 && p2.total.entrada === 12, `cache.json corrompido: varre do zero e funciona (veio ${p2 && p2.total.entrada})`);
  });

  await bloco('G19. dias=7: hoje e os 6 anteriores (inclusive); sem-data fora de todo período', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const seiDiasAtras = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const seteDiasAtras = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const { abs } = pastaAba('g19');
    fs.writeFileSync(path.join(abs, 'a.jsonl'),
      linhaUsage({ input: 1, ts: `${hoje}T00:00:00.000Z` })
      + linhaUsage({ input: 2, ts: `${seiDiasAtras}T00:00:00.000Z` })
      + linhaUsage({ input: 4, ts: `${seteDiasAtras}T00:00:00.000Z` })
      + linhaUsage({ input: 8, extra: { timestamp: undefined } }));
    const r = await uso.relatorio({ dias: 7 });
    const p = r.projetos.find((x) => x.projeto === 'g19');
    assert(p && p.total.entrada === 3, `hoje(1)+6diasAtras(2)=3; nem 7diasAtras(4) nem sem-data(8) entram (veio ${p && p.total.entrada})`);
  });

  await bloco('G20a. leitura.linhasIgnoradas sai certo de relatorio() (a metade do servidor)', async () => {
    const { abs } = pastaAba('g20a');
    fs.writeFileSync(path.join(abs, 'a.jsonl'), linhaGigante() + linhaGigante() + linhaUsage({ input: 1 }));
    const r = await uso.relatorio({ dias: 1 });
    assert(r.leitura.linhasIgnoradas >= 2, `2 linhas gigantes contadas em linhasIgnoradas (veio ${r.leitura.linhasIgnoradas})`);
  });

  await bloco('G21. cache QUENTE: linhasIgnoradas persiste, sem reler a linha grande de novo', async () => {
    const { abs } = pastaAba('g21');
    fs.writeFileSync(path.join(abs, 'a.jsonl'), linhaGigante() + linhaUsage({ input: 1 }));
    const r1 = await uso.relatorio({ dias: 1 });
    const antes = r1.leitura.linhasIgnoradas;
    // `depois === antes` sozinho é um assert OCO: com a mutação 5 (ignoradas virando variável
    // local, nunca persistida), as DUAS leituras davam 0, e `0 === 0` passava sem provar nada
    // — achado na prova de vermelho de 1.5 (04/09). Provar que `antes` é > 0 é o que torna a
    // igualdade seguinte um teste de verdade, e não uma coincidência de dois zeros.
    assert(antes > 0, `a 1ª leitura viu linha(s) grande(s) de verdade — antes > 0 (veio ${antes})`);
    assert(r1.leitura.relidos >= 1, `a 1ª leitura realmente leu algo — relidos >= 1 (veio ${r1.leitura.relidos})`);
    const r2 = await uso.relatorio({ dias: 1 });
    assert(r2.leitura.linhasIgnoradas === antes, `linhasIgnoradas igual na 2ª leitura (${antes} === ${r2.leitura.linhasIgnoradas})`);
    assert(r2.leitura.relidos === 0, `2ª leitura não relê nenhum arquivo — cache quente (relidos=${r2.leitura.relidos})`);
  });

  await bloco('G22. reescrita muda o que já foi contado ALÉM do prefixo: a assinatura (CAUDA) pega isso', async () => {
    const primeiraLinha = linhaComTamanho(256, { input: 50 });
    const { abs } = pastaAba('g22');
    const arq = path.join(abs, 'a.jsonl');
    fs.writeFileSync(arq, primeiraLinha + linhaUsage({ input: 60 }));
    await uso.varrer();
    const tamanhoAntigo = fs.statSync(arq).size;
    fs.writeFileSync(arq, primeiraLinha + linhaUsage({ input: 999 }));   // 1ª linha IGUAL, 2ª trocada e maior
    assert(fs.statSync(arq).size > tamanhoAntigo, 'a reescrita cresce além do offset antigo');
    const r = uso.montar(await uso.varrer(), 1);
    const p = r.projetos.find((x) => x.projeto === 'g22');
    // Um cache por PREFIXO fixo (que não mudou) trataria isto como append e somaria
    // 50+60+999=1109 em 3 linhas. A cauda do offset antigo (que inclui o "60") detecta a
    // troca: descarta e relê do zero — 50 (a mesma 1ª linha, relida) + 999 = 1049, 2 linhas.
    assert(p && p.total.entrada === 1049 && p.total.linhas === 2,
      `descartou e releu do zero: entrada=1049, linhas=2 (veio ${p && JSON.stringify(p.total)})`);

    // Sub-caso G22b — achado na prova de vermelho de 1.5 (04/09): o sub-caso acima SEMPRE
    // cresce (`size > offset antigo`), então nunca exercita o caminho `size === offset`. A
    // mutação 13 (pular a leitura da assinatura quando `size === offset`, ANTES de conferir)
    // só é pega por uma reescrita de MESMO TAMANHO — exatamente o cenário que a spec (§3.1.3)
    // cita: "uma reescrita de mesmo tamanho e mesmo inode passaria batida" se a assinatura não
    // fosse lida SEMPRE. Sem este sub-caso, G22 não provava essa metade da própria garantia.
    const { abs: absMesmo } = pastaAba('g22mesmoTamanho');
    const arqMesmo = path.join(absMesmo, 'a.jsonl');
    const linhaA = linhaComTamanhoNaCauda(400, { input: 11 });
    const linhaB = linhaComTamanhoNaCauda(400, { input: 22 });   // MESMO tamanho, cauda DIFERENTE
    assert(Buffer.byteLength(linhaA) === Buffer.byteLength(linhaB), 'linhaA e linhaB têm o MESMO tamanho em bytes');
    const caudaA = Buffer.from(linhaA, 'utf8').subarray(-256);
    const caudaB = Buffer.from(linhaB, 'utf8').subarray(-256);
    assert(!caudaA.equals(caudaB), 'e as caudas de 256 bytes SÃO diferentes — senão o teste provaria só o limite já documentado de assinaturaDe, não a mutação 13');
    fs.writeFileSync(arqMesmo, linhaA);
    await uso.varrer();
    const tamanhoA = fs.statSync(arqMesmo).size;
    fs.writeFileSync(arqMesmo, linhaB);   // MESMO caminho ⇒ MESMO inode; MESMO tamanho ⇒ size === offset antigo
    assert(fs.statSync(arqMesmo).size === tamanhoA, 'a reescrita tem EXATAMENTE o mesmo tamanho da anterior');
    const r2 = uso.montar(await uso.varrer(), 1);
    const p2 = r2.projetos.find((x) => x.projeto === 'g22mesmoTamanho');
    // Se a assinatura não fosse conferida quando size === offset, isto ficaria "nada a fazer"
    // e o total continuaria 11 (o valor VELHO, de linhaA) — não 22.
    assert(p2 && p2.total.entrada === 22 && p2.total.linhas === 1,
      `mesmo tamanho, conteúdo trocado: a assinatura pega e relê — entrada=22 (veio ${p2 && JSON.stringify(p2.total)})`);
  });

  await bloco('G23. arquivo < 256 bytes: append continua INCREMENTAL, não relê do zero', async () => {
    const { abs } = pastaAba('g23');
    const arq = path.join(abs, 'a.jsonl');
    const linhaCurta = `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z', message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n`;
    assert(Buffer.byteLength(linhaCurta) < 256, `a linha de teste é < 256 bytes (${Buffer.byteLength(linhaCurta)})`);
    fs.writeFileSync(arq, linhaCurta);
    await uso.varrer();
    fs.appendFileSync(arq, linhaCurta);
    const estado = await uso.varrer();
    const r = uso.montar(estado, 1);
    const p = r.projetos.find((x) => x.projeto === 'g23');
    assert(p && p.total.entrada === 10 && p.total.linhas === 2, `incremental: 5+5=10, sem reler do zero (veio ${p && JSON.stringify(p.total)})`);
    assert(estado.leitura.bytesLidos === Buffer.byteLength(linhaCurta), `2ª leitura só o pedaço apensado (bytesLidos=${estado.leitura.bytesLidos})`);
  });

  await bloco('G24a. num() pelo ARQUIVO (só valores que existem em JSON)', async () => {
    const { abs } = pastaAba('g24a');
    const cabeca = '{"type":"assistant","timestamp":"2026-09-04T10:00:00.000Z","message":{"model":"claude-opus-5","usage":';
    fs.writeFileSync(path.join(abs, 'a.jsonl'),
      `${cabeca}{"cache_creation_input_tokens":"1234","cache_read_input_tokens":-5}}}\n`
      + `${cabeca}{"input_tokens":1e400,"output_tokens":1e17}}}\n`);
    const r = await uso.relatorio({ dias: 1 });
    const p = r.projetos.find((x) => x.projeto === 'g24a');
    assert(p, 'a linha da string "1234" faz o projeto existir (soma > 0)');
    assert(p && p.total.cacheEscrita === 1234, `a string "1234" CONTA como 1234 (veio ${p && p.total.cacheEscrita})`);
    assert(p && p.total.cacheLeitura === 0, `-5 (negativo) vira 0 (veio ${p && p.total.cacheLeitura})`);
    assert(p && p.total.entrada === 0, `1e400 (Infinity) vira 0 (veio ${p && p.total.entrada})`);
    assert(p && p.total.saida === 0, `1e17 (> MAX_SAFE_INTEGER) vira 0 (veio ${p && p.total.saida})`);
    assert(p && !Number.isNaN(p.total.entrada) && !Number.isNaN(p.total.saida), 'nunca NaN no total');
  });

  await bloco('G24b. agregarLinha() chamada DIRETO, com NaN e undefined (só alcançável pela API)', async () => {
    const alvo = { dias: {} };
    const contribuiu1 = uso.agregarLinha({
      type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z',
      message: { model: 'x', usage: { input_tokens: NaN, output_tokens: undefined, cache_creation_input_tokens: 7, cache_read_input_tokens: NaN } },
    }, alvo);
    assert(contribuiu1 === true, 'contribuiu (soma > 0 por causa do 7)');
    const arr = alvo.dias['2026-09-04'].x;
    assert(arr[0] === 0 && arr[1] === 0 && arr[2] === 7 && arr[3] === 0, `NaN e undefined viram 0, 7 conta (veio ${JSON.stringify(arr)})`);

    const alvo2 = { dias: {} };
    const contribuiu2 = uso.agregarLinha({
      type: 'assistant',
      message: { usage: { input_tokens: NaN, output_tokens: NaN, cache_creation_input_tokens: undefined, cache_read_input_tokens: undefined } },
    }, alvo2);
    assert(contribuiu2 === false, 'soma zero (tudo NaN/undefined) é pulada — não contribui');
    assert(Object.keys(alvo2.dias).length === 0, 'nada foi agregado (contribuiu2 === false)');
  });

  await bloco('G25. overflow do ACUMULADOR (não do campo isolado): leitura.precisaoPerdida', async () => {
    const M = Number.MAX_SAFE_INTEGER;
    const estado = {
      arquivos: {
        '/x/a.jsonl': { offset: 10, ino: 1, assinatura: '', ignoradas: {}, mtimeMs: 0, dias: { '2026-09-04': { modeloX: [M, 0, 0, 0, 1] } } },
        '/x/b.jsonl': { offset: 10, ino: 2, assinatura: '', ignoradas: {}, mtimeMs: 0, dias: { '2026-09-04': { modeloX: [M, 0, 0, 0, 1] } } },
      },
      caminhoParaPasta: { '/x/a.jsonl': 'pasta1', '/x/b.jsonl': 'pasta1' },
      classes: { pasta1: { origem: 'aba', projeto: 'g25', rotulo: 'aba g25', id: 'pasta1' } },
      leitura: { arquivos: 2, comUsage: 2, relidos: 2, bytesLidos: 20, ms: 1, arquivosComErro: 0 },
    };
    const r = uso.montar(estado, 1);
    assert(r.leitura.precisaoPerdida === true, `entrada = M+M estoura MAX_SAFE_INTEGER (precisaoPerdida=${r.leitura.precisaoPerdida})`);
    const semEstouro = uso.montar({ ...estado, arquivos: { '/x/a.jsonl': estado.arquivos['/x/a.jsonl'] } }, 1);
    assert(semEstouro.leitura.precisaoPerdida === false, `um único M não estoura (precisaoPerdida=${semEstouro.leitura.precisaoPerdida})`);
  });

  await bloco('G26. whitelist FECHADA de chaves, em toda profundidade — resposta e cache.json', async () => {
    const PERMITIDAS = new Set([
      'geradoEm', 'desde', 'ate', 'dias', 'total', 'projetos', 'projeto', 'modelos', 'origens', 'tipo', 'rotulo', 'leitura',
      'entrada', 'saida', 'cacheEscrita', 'cacheLeitura', 'linhas',
      'arquivos', 'comUsage', 'relidos', 'bytesLidos', 'ms', 'linhasIgnoradas', 'arquivosComErro', 'precisaoPerdida',
      'offset', 'ino', 'assinatura', 'ignoradas', 'mtimeMs', 'versao', 'caminho',
      // card `tokens-mais-detalhe` — custo, por modelo e por dia. `modelos` CONTINUA na lista:
      // saiu do nível de projeto (virou `porModelo`) mas segue vivo em `origens[]`.
      'precos', 'consultadoEm', 'moeda', 'custo', 'usd', 'conhecido',
      'tokensSemPreco', 'cacheSemDuracao', 'porModelo', 'modelo', 'porDia', 'dia',
    ]);
    // Lista FECHADA dos ids de modelo que este gate injeta em qualquer fixture, do começo ao
    // fim do arquivo — de propósito curta e explícita: uma regex genérica de "parece um
    // identificador" deixaria passar a própria mutação #9 (`alvo.amostra = ...content`), já
    // que "amostra" também "parece um identificador".
    const MODELOS_CONHECIDOS = new Set(['claude-opus-5', 'x', 'modeloX', '<synthetic>']);
    const RE_DIA_OU_SEMDATA = /^(\d{4}-\d{2}-\d{2}|sem-data)$/;
    const chaveOk = (k) => PERMITIDAS.has(k) || RE_DIA_OU_SEMDATA.test(k) || MODELOS_CONHECIDOS.has(k);
    const achadas = new Set();
    function varreChaves(objeto) {
      if (!objeto || typeof objeto !== 'object') return;
      if (Array.isArray(objeto)) { for (const v of objeto) varreChaves(v); return; }
      for (const [k, v] of Object.entries(objeto)) { achadas.add(k); varreChaves(v); }
    }
    const { abs } = pastaAba('g26');
    fs.writeFileSync(path.join(abs, 'a.jsonl'), linhaUsage({ input: 1 }));
    const r = await uso.relatorio({ dias: 1 });
    varreChaves(r);
    const cacheDisco = JSON.parse(fs.readFileSync(path.join(process.env.COCKPIT_USO_DIR, 'cache.json'), 'utf8'));
    varreChaves(cacheDisco);
    const foraDaLista = Array.from(achadas).filter((k) => !chaveOk(k));
    assert(foraDaLista.length === 0, `todas as chaves pertencem à whitelist (fora: ${JSON.stringify(foraDaLista)})`);
  });

  await bloco('G27. meta.json alterado entre 2 varreduras muda o RÓTULO sem limpar o agregado', async () => {
    const id = 'g27job';
    const { abs } = pastaJob(id, { project: 'projeto-g27', type: 'ataca', title: 'titulo velho' });
    fs.writeFileSync(path.join(abs, 'a.jsonl'), linhaUsage({ input: 42 }));
    const r1 = await uso.relatorio({ dias: 1 });
    const p1 = r1.projetos.find((x) => x.projeto === 'projeto-g27');
    assert(p1 && p1.origens[0].rotulo === 'ataca: titulo velho', `rótulo antes: "${p1 && p1.origens[0].rotulo}"`);

    fs.writeFileSync(path.join(JOBS, id, 'meta.json'), JSON.stringify({ project: 'projeto-g27', type: 'ataca', title: 'titulo NOVO' }));
    const r2 = await uso.relatorio({ dias: 1 });
    const p2 = r2.projetos.find((x) => x.projeto === 'projeto-g27');
    assert(p2 && p2.origens[0].rotulo === 'ataca: titulo NOVO', `rótulo depois: "${p2 && p2.origens[0].rotulo}"`);
    assert(p2 && p2.total.entrada === 42, `o agregado NÃO foi limpo pela troca de rótulo (entrada=${p2 && p2.total.entrada})`);
  });

  await bloco('G29. desempate: total igual ⇒ ordem alfabética, estável entre execuções', async () => {
    // Direto em montar(), não pelo disco (achado na prova de vermelho de 1.5, 04/09): a
    // primeira versão criava as pastas 'g29zebra' e depois 'g29abacaxi', mas o `readdir` do
    // sistema de arquivos deste disco já devolve as pastas em ordem alfabética por acaso —
    // então TIRAR o desempate do comparador não mudava a saída nenhuma (a ordem de inserção
    // JÁ era alfabética), e o gate passava raspando por cima da própria mutação que existe
    // para pegar. Construindo o `estado` à mão — o mesmo formato que `varrer()` devolve — dá
    // para inserir 'zebra' ANTES de 'abacaxi' de propósito: sem desempate, o `sort` estável do
    // V8 preserva ordem de inserção e a saída sairia [zebra, abacaxi], não [abacaxi, zebra].
    const estadoBase = () => ({
      arquivos: {
        '/x/zebra.jsonl': { offset: 1, ino: 1, assinatura: '', ignoradas: {}, mtimeMs: 0, dias: { '2026-09-04': { m: [77, 0, 0, 0, 1] } } },
        '/x/abacaxi.jsonl': { offset: 1, ino: 2, assinatura: '', ignoradas: {}, mtimeMs: 0, dias: { '2026-09-04': { m: [77, 0, 0, 0, 1] } } },
      },
      caminhoParaPasta: { '/x/zebra.jsonl': 'pZebra', '/x/abacaxi.jsonl': 'pAbacaxi' },
      classes: {
        pZebra: { origem: 'aba', projeto: 'g29zebra', rotulo: 'aba g29zebra', id: 'pZebra' },
        pAbacaxi: { origem: 'aba', projeto: 'g29abacaxi', rotulo: 'aba g29abacaxi', id: 'pAbacaxi' },
      },
      leitura: { arquivos: 2, comUsage: 2, relidos: 2, bytesLidos: 2, ms: 1, arquivosComErro: 0 },
    });
    const r1 = uso.montar(estadoBase(), 1);
    const r2 = uso.montar(estadoBase(), 1);
    const nomes = (r) => r.projetos.map((p) => p.projeto);
    // Mesma lição do G21: `nomes(r1) === nomes(r2)` sozinho passaria com as DUAS chamadas
    // devolvendo `[]` — dois vazios são "iguais" sem provar estabilidade nenhuma.
    assert(nomes(r1).length === 2, `os 2 projetos de teste aparecem (veio ${JSON.stringify(nomes(r1))})`);
    assert(JSON.stringify(nomes(r1)) === JSON.stringify(['g29abacaxi', 'g29zebra']),
      `alfabético, apesar de 'zebra' ter sido inserido PRIMEIRO no estado (veio ${JSON.stringify(nomes(r1))})`);
    assert(JSON.stringify(nomes(r1)) === JSON.stringify(nomes(r2)), 'estável entre duas chamadas');
  });

  await bloco('G30. .jsonl SEM PERMISSÃO: pulado, arquivosComErro>=1, os outros continuam', async () => {
    if (process.getuid && process.getuid() === 0) {
      console.log('  ℹ️  rodando como root — chmod 000 não bloqueia leitura, bloco pulado');
      return;
    }
    const { abs } = pastaAba('g30');
    fs.writeFileSync(path.join(abs, 'proibido.jsonl'), linhaUsage({ input: 999 }));
    fs.writeFileSync(path.join(abs, 'ok.jsonl'), linhaUsage({ input: 3 }));
    fs.chmodSync(path.join(abs, 'proibido.jsonl'), 0o000);
    try {
      const r = await uso.relatorio({ dias: 1 });
      const p = r.projetos.find((x) => x.projeto === 'g30');
      assert(p && p.total.entrada === 3, `só o arquivo legível conta (entrada=${p && p.total.entrada})`);
      assert(r.leitura.arquivosComErro >= 1, `arquivosComErro >= 1 (veio ${r.leitura.arquivosComErro})`);
    } finally {
      fs.chmodSync(path.join(abs, 'proibido.jsonl'), 0o644);
    }
  });

  await bloco('G31. ignoradas é POR DIA: fora do período não acende; dentro do período, acende', async () => {
    const dezDiasAtras = new Date(Date.now() - 10 * 86400000).toISOString();
    const { abs } = pastaAba('g31');
    fs.writeFileSync(path.join(abs, 'a.jsonl'), linhaGigante(dezDiasAtras) + linhaUsage({ input: 1 }));
    const antes = (await uso.relatorio({ dias: 7 })).leitura.linhasIgnoradas;

    const { abs: abs2 } = pastaAba('g31b');
    fs.writeFileSync(path.join(abs2, 'a.jsonl'), linhaGigante(new Date().toISOString()) + linhaUsage({ input: 1 }));
    const depois = (await uso.relatorio({ dias: 7 })).leitura.linhasIgnoradas;
    assert(depois > antes, `linha gigante de HOJE acende o aviso em dias=7 (antes=${antes}, depois=${depois})`);
  });

  await bloco('G32. isolamento: readdir falhando numa pasta não derruba as outras (duas camadas)', async () => {
    if (process.getuid && process.getuid() === 0) {
      console.log('  ℹ️  rodando como root — chmod 000 não bloqueia readdir, bloco pulado');
      return;
    }
    const { abs: pastaProibida } = pastaAba('g32proibida');
    fs.mkdirSync(path.join(pastaProibida, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(pastaProibida, 'sub', 'a.jsonl'), linhaUsage({ input: 1 }));
    const { abs: pastaOk } = pastaAba('g32ok');
    fs.writeFileSync(path.join(pastaOk, 'a.jsonl'), linhaUsage({ input: 5 }));
    fs.chmodSync(pastaProibida, 0o000);
    try {
      const r = await uso.relatorio({ dias: 1 });
      const pOk = r.projetos.find((x) => x.projeto === 'g32ok');
      assert(pOk && pOk.total.entrada === 5, `a pasta legível segue somando normal (entrada=${pOk && pOk.total.entrada})`);
      const pProibida = r.projetos.find((x) => x.projeto === 'g32proibida');
      assert(!pProibida, 'a pasta sem permissão foi pulada (não derrubou a varredura)');
    } finally {
      fs.chmodSync(pastaProibida, 0o755);
    }
  });

  // ── blocos da fase 3 (D32 / #16) — reescritos na fase 2b (04/09): a tela de tokens veio
  // para dentro do app, `uso.html` foi apagada (P2) ────────────────────────
  await bloco('G12. #btn-uso dentro de #dialogo-config; #dialogo-uso existe com #app-uso dentro; uso.html ausente do disco', async () => {
    const indexHtml = fs.readFileSync(path.join(RAIZ_REPO, 'public', 'index.html'), 'utf8');
    const abre = indexHtml.indexOf('id="dialogo-config"');
    const fecha = indexHtml.indexOf('</dialog>', abre);
    assert(abre >= 0 && fecha > abre, '#dialogo-config existe em index.html');
    const miolo = indexHtml.slice(abre, fecha);
    assert(/id="btn-uso"/.test(miolo), '#btn-uso está DENTRO de #dialogo-config');

    const abreUso = indexHtml.indexOf('id="dialogo-uso"');
    const fechaUso = indexHtml.indexOf('</dialog>', abreUso);
    assert(abreUso >= 0 && fechaUso > abreUso, '#dialogo-uso existe em index.html (P1/P2)');
    const mioloUso = indexHtml.slice(abreUso, fechaUso);
    assert(/id="app-uso"/.test(mioloUso), 'e o #app-uso — o miolo de sempre — está DENTRO dele');

    assert(!fs.existsSync(path.join(RAIZ_REPO, 'public', 'uso.html')),
      'public/uso.html está AUSENTE do disco — apagada de propósito (P2)');
  });

  await bloco('G12b. clicar em #btn-uso chama showModal() em #dialogo-uso + telaUso.abrir() — nunca window.open', async () => {
    const { porId, chamadasOpen, contexto } = carregarAppJsComEspiaoDeOpen({ comUso: true, respostaFetchUso: { itens: [] } });
    const botao = porId.get('btn-uso');
    assert(typeof (botao && botao.onclick) === 'function', '#btn-uso tem um onclick de verdade');
    assert(typeof contexto.telaUso === 'object' && typeof contexto.telaUso.abrir === 'function',
      'globalThis.telaUso.abrir existe (R8 — o sandbox daqui não tem window, só globalThis)');
    botao.onclick();
    assert(porId.get('dialogo-uso').open === true, 'o clique ABRE #dialogo-uso (showModal)');
    assert(chamadasOpen.length === 0, `e window.open NUNCA é chamado (veio ${chamadasOpen.length})`);
  });

  await bloco('A8. o clique em #btn-uso dispara /api/uso exatamente 1 vez, no período atual — 0 antes', async () => {
    // No develop, carregar app.js + uso.js no MESMO contexto ESTOURA (const $/const token
    // colidem, R1) — capturado aqui, e não deixado estourar o bloco inteiro, para o ❌
    // continuar carregando a sigla (regra 1 do plano: grep por nome, não por posição).
    let montagem;
    try { montagem = carregarAppJsComEspiaoDeOpen({ comUso: true, respostaFetchUso: { itens: [] } }); } catch (e) {
      assert(false, `A8: montar o sandbox não estourou (${e && e.message})`);
      return;
    }
    const { porId, chamadasFetchUso } = montagem;
    assert(chamadasFetchUso.length === 0, `A8: nenhum fetch de /api/uso no carregamento do app (veio ${chamadasFetchUso.length})`);
    porId.get('btn-uso').onclick();
    assert(chamadasFetchUso.length === 1, `A8: exatamente 1 fetch depois do clique (veio ${chamadasFetchUso.length})`);
    assert(/dias=1\b/.test(chamadasFetchUso[0] || ''),
      `A8: com dias=1 — o diasAtual do boot, nunca um carregar(1) chumbado à parte (veio ${chamadasFetchUso[0]})`);
  });

  await bloco('A8b. app.js e depois uso.js no MESMO contexto não lança (a ordem real do index.html)', async () => {
    let erro = null;
    try { carregarAppJsComEspiaoDeOpen({ comUso: true, ordem: 'app-primeiro' }); } catch (e) { erro = e; }
    assert(erro === null, `A8b: app.js → uso.js não lança (${erro && erro.message})`);
  });

  await bloco('A8b. a ordem INVERSA (uso.js → app.js) também não lança — blindagem contra trocar as tags de lugar', async () => {
    let erro = null;
    try { carregarAppJsComEspiaoDeOpen({ comUso: true, ordem: 'uso-primeiro' }); } catch (e) { erro = e; }
    assert(erro === null, `A8b: uso.js → app.js não lança (${erro && erro.message})`);
  });

  await bloco('A8c. index.html tem UM <main> e UM <h1>; dentro de #dialogo-uso, uso-lista é <div> e uso-titulo é <h2> (R4)', async () => {
    const indexHtml = fs.readFileSync(path.join(RAIZ_REPO, 'public', 'index.html'), 'utf8');
    const semComentarios = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
    const mains = (semComentarios.match(/<main[\s>]/g) || []).length;
    const h1s = (semComentarios.match(/<h1[\s>]/g) || []).length;
    assert(mains === 1, `A8c: um <main> só, fora de comentário (veio ${mains})`);
    assert(h1s === 1, `A8c: um <h1> só, fora de comentário (veio ${h1s})`);
    // As duas trocas de tag do R4, por extenso — o miolo de uso.html trazia
    // `<main id="uso-lista">` e um `<h1>` sem id; dentro do index.html os dois teriam
    // duplicado o <main>/<h1> que a conversa já usa. Sem estas duas linhas específicas, o
    // par de contagens acima já valia no develop (que nunca teve #dialogo-uso) e não
    // testaria nada desta fase.
    assert(/<div id="uso-lista">/.test(semComentarios),
      'A8c: #uso-lista é uma <div>, não <main> — dois <main> seria documento inválido (R4)');
    assert(/<h2 id="uso-titulo">/.test(semComentarios),
      'A8c: #uso-titulo é um <h2>, não <h1> — o documento já tem o <h1 id="chat-titulo"> (R4)');
  });

  await bloco('A15. #btn-fechar-uso tem onclick e ele fecha #dialogo-uso', async () => {
    let montagem;
    try { montagem = carregarAppJsComEspiaoDeOpen({ comUso: true, respostaFetchUso: { itens: [] } }); } catch (e) {
      assert(false, `A15: montar o sandbox não estourou (${e && e.message})`);
      return;
    }
    const { porId } = montagem;
    porId.get('btn-uso').onclick();
    assert(porId.get('dialogo-uso').open === true, 'A15: abriu (checagem de sanidade antes do fechar)');
    assert(typeof porId.get('btn-fechar-uso').onclick === 'function', 'A15: #btn-fechar-uso tem onclick de verdade');
    porId.get('btn-fechar-uso').onclick();
    assert(porId.get('dialogo-uso').open === false, 'A15: e o clique nele fecha #dialogo-uso');
  });

  await bloco('A19. #dialogo-uso tem aria-labelledby apontando pra um id que existe, e autofocus no Fechar', async () => {
    const indexHtml = fs.readFileSync(path.join(RAIZ_REPO, 'public', 'index.html'), 'utf8');
    const abreUso = indexHtml.indexOf('id="dialogo-uso"');
    const fechaUso = abreUso >= 0 ? indexHtml.indexOf('</dialog>', abreUso) : -1;
    const tagAbertura = abreUso >= 0 ? indexHtml.slice(Math.max(0, abreUso - 20), abreUso + 200) : '';
    const m = /aria-labelledby="([\w-]+)"/.exec(tagAbertura);
    assert(Boolean(m), 'A19: a tag <dialog id="dialogo-uso"> declara aria-labelledby');
    const mioloUso = abreUso >= 0 && fechaUso > abreUso ? indexHtml.slice(abreUso, fechaUso) : '';
    assert(Boolean(m) && new RegExp(`id="${m && m[1]}"`).test(mioloUso),
      `A19: e o id "${m && m[1]}" existe dentro do miolo (o <h2 id="uso-titulo">)`);
    assert(/id="btn-fechar-uso"[^>]*\sautofocus/.test(mioloUso),
      'A19: #btn-fechar-uso tem autofocus (showModal() focaria o "Hoje" sem isso)');
  });

  await bloco('A20. uso.js não tem "const token" de topo; api() lê o localStorage a cada chamada; uso.js entra DEPOIS de app.js', async () => {
    const usoJsFonte = fs.readFileSync(path.join(RAIZ_REPO, 'public', 'uso.js'), 'utf8');
    // Âncora no INÍCIO da linha (sem indentação): pega um `const token` DE TOPO, mas não o
    // `const token = tokenAgora();` local dentro de `api()` (esse é o ponto certo — lido a
    // cada chamada) nem a palavra em comentário.
    assert(!/^const token\b/m.test(usoJsFonte),
      'A20: nenhum "const token" de TOPO no arquivo (P3-b — a captura tardia conserta o 1º acesso por link)');
    assert(/localStorage\.getItem\('cockpit-token'\)/.test(usoJsFonte),
      'A20: o localStorage é lido por uma FUNÇÃO (tokenAgora), não uma vez só no carregamento');
    const indexHtml = fs.readFileSync(path.join(RAIZ_REPO, 'public', 'index.html'), 'utf8');
    const iApp = indexHtml.indexOf('<script src="app.js">');
    const iUso = indexHtml.indexOf('<script src="uso.js">');
    assert(iApp >= 0 && iUso > iApp, `A20: <script src="uso.js"> vem DEPOIS de <script src="app.js"> (app=${iApp}, uso=${iUso})`);
  });

  await bloco('A21. selecionarPeriodo recusado por carga em voo NÃO mexe no aria-pressed', async () => {
    let resolverFetch;
    const fetchPendente = new Promise((r) => { resolverFetch = r; });
    const { contexto, porId } = carregarUsoJsFalso({ token: 'tok' });
    // Troca o fetch por um que fica PENDURADO — é o que simula "carga em voo".
    contexto.fetch = async () => { await fetchPendente; return { ok: true, status: 200, json: async () => ({ itens: [] }) }; };
    // `telaUso` não existe no develop (o boot antigo não expõe nada) — capturado aqui para
    // o ❌ carregar a sigla, em vez do "o bloco estourou" genérico do `bloco()`.
    if (!contexto.telaUso || typeof contexto.telaUso.carregar !== 'function') {
      assert(false, 'A21: globalThis.telaUso.carregar existe (R8)');
      resolverFetch();
      return;
    }
    const p1 = contexto.telaUso.carregar(1); // dispara e fica em voo (carregando = true)
    const antes = porId.get('btn-periodo-7').getAttribute('aria-pressed');
    contexto.telaUso.selecionarPeriodo(7); // tem que ser recusado, ANTES de pintar
    const depois = porId.get('btn-periodo-7').getAttribute('aria-pressed');
    assert(depois === antes,
      `A21: o aria-pressed do "7 dias" NÃO mudou enquanto "Hoje" está em voo (antes=${antes}, depois=${depois})`);
    resolverFetch();
    await p1;
  });

  await bloco('G20b. o cliente (uso.js) desenha os 3 avisos, cada um só quando deve', async () => {
    const casos = [
      { rotulo: 'nenhum aviso', leitura: { linhasIgnoradas: 0, arquivosComErro: 0, precisaoPerdida: false }, espera: { linhas: false, erro: false, precisao: false } },
      { rotulo: 'linhasIgnoradas: 3', leitura: { linhasIgnoradas: 3, arquivosComErro: 0, precisaoPerdida: false }, espera: { linhas: true, erro: false, precisao: false } },
      { rotulo: 'arquivosComErro: 7', leitura: { linhasIgnoradas: 0, arquivosComErro: 7, precisaoPerdida: false }, espera: { linhas: false, erro: true, precisao: false } },
      { rotulo: 'precisaoPerdida: true', leitura: { linhasIgnoradas: 0, arquivosComErro: 0, precisaoPerdida: true }, espera: { linhas: false, erro: false, precisao: true } },
      { rotulo: 'os três acionados', leitura: { linhasIgnoradas: 3, arquivosComErro: 7, precisaoPerdida: true }, espera: { linhas: true, erro: true, precisao: true } },
    ];
    for (const caso of casos) {
      const resposta = {
        geradoEm: '2026-09-04T10:00:00.000Z', desde: '2026-09-04', ate: '2026-09-04', dias: 1,
        total: { entrada: 1, saida: 0, cacheEscrita: 0, cacheLeitura: 0, linhas: 1 },
        projetos: [], leitura: { arquivos: 1, comUsage: 1, relidos: 1, bytesLidos: 1, ms: 1, ...caso.leitura },
      };
      // token='' desliga o auto-carregar() do fim do script — a chamada explícita abaixo é
      // quem controla exatamente qual resposta cada rodada usa, sem corrida com o load.
      // eslint-disable-next-line no-await-in-loop
      const { contexto, porId } = carregarUsoJsFalso({ token: '', respostaFetch: resposta });
      // eslint-disable-next-line no-await-in-loop
      await contexto.telaUso.carregar(1);
      const textoRodape = porId.get('uso-rodape').textContent;
      assert(/grande\(s\) demais/.test(textoRodape) === caso.espera.linhas,
        `${caso.rotulo}: aviso de linhasIgnoradas ${caso.espera.linhas ? 'aparece' : 'NÃO aparece'} (rodapé: "${textoRodape}")`);
      assert(/não puderam ser lidos/.test(textoRodape) === caso.espera.erro,
        `${caso.rotulo}: aviso de arquivosComErro ${caso.espera.erro ? 'aparece' : 'NÃO aparece'} (rodapé: "${textoRodape}")`);
      assert(/limite seguro de precisão/.test(textoRodape) === caso.espera.precisao,
        `${caso.rotulo}: aviso de precisaoPerdida ${caso.espera.precisao ? 'aparece' : 'NÃO aparece'} (rodapé: "${textoRodape}")`);
      if (caso.leitura.linhasIgnoradas > 0) {
        assert(textoRodape.includes(String(caso.leitura.linhasIgnoradas)), `${caso.rotulo}: o número ${caso.leitura.linhasIgnoradas} aparece no texto do aviso`);
      }
      if (caso.leitura.arquivosComErro > 0) {
        assert(textoRodape.includes(String(caso.leitura.arquivosComErro)), `${caso.rotulo}: o número ${caso.leitura.arquivosComErro} aparece no texto do aviso`);
      }
    }
  });

  // ── bloco da fase 4 (conta-uso-independente.js precisa existir) ───────
  await bloco('G28. conta-uso-independente.js × lib/uso.js — 4 combinações (com/sem linha grande × frio/quente)', async () => {
    const cruG28 = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
    function rodarIndependente(env) {
      return new Promise((resolve) => {
        // `--sem-snapshot`: o fixture deste bloco JÁ é imutável (ninguém escreve nele durante
        // o teste), então congelar seria custo puro — e, pior, o caminho do snapshot é um
        // mkdtemp novo a cada execução, e ele aparece na linha `raiz:` da saída. Isso fazia a
        // comparação "frio e quente batem byte a byte" NUNCA fechar. O congelamento existe
        // para o disco VIVO do Gate 4.2, não para fixture.
        execFile(process.execPath, [path.join(RAIZ_REPO, 'testes', 'conta-uso-independente.js'), '--dias=1', '--comparar', '--sem-snapshot'],
          { cwd: RAIZ_REPO, env: { ...process.env, ...env } },
          (erro, stdout, stderr) => resolve({ codigo: erro ? (erro.code || 1) : 0, stdout, stderr }));
      });
    }
    for (const comLinhaGrande of [false, true]) {
      const homeG28 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-g28-home-'));
      const prefixoProjeto = `${cruG28(path.join(homeG28, 'projetos'))}-`;
      const pastaAbs = path.join(homeG28, '.claude', 'projects', `${prefixoProjeto}g28proj`);
      fs.mkdirSync(pastaAbs, { recursive: true });
      let conteudo = linhaUsage({ input: 111, output: 22, cw: 3, cr: 4444 });
      if (comLinhaGrande) {
        // A linha gigante tem `usage` DE VERDADE — soGrandes precisa refletir isto de
        // propósito, senão a checagem de linhasIgnoradas fecharia por acaso (0 === 0) em vez
        // de provar a exclusão (mesma lição do G21/G29 na prova de vermelho de 1.5).
        const pad = 'z'.repeat(uso.TETO_LINHA + 500);
        conteudo += `${JSON.stringify({
          type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z',
          message: { model: 'claude-opus-5', usage: { input_tokens: 9, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: pad }] },
        })}\n`;
      }
      fs.writeFileSync(path.join(pastaAbs, 'a.jsonl'), conteudo);
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-g28-cache-'));
      const env = { HOME: homeG28, COCKPIT_USO_DIR: cacheDir };
      const rotulo = comLinhaGrande ? 'COM linha grande' : 'SEM linha grande';

      // eslint-disable-next-line no-await-in-loop
      const frio = await rodarIndependente(env);
      // eslint-disable-next-line no-await-in-loop
      const quente = await rodarIndependente(env);
      assert(frio.codigo === 0, `${rotulo}, frio: exit 0 (${frio.stdout}${frio.stderr})`);
      assert(quente.codigo === 0, `${rotulo}, quente: exit 0 (${quente.stdout}${quente.stderr})`);
      assert(frio.stdout === quente.stdout, `${rotulo}: frio e quente batem byte a byte — fixture imutável`);
    }
  });

  await bloco('G20c. o cliente desenha o custo, "Por modelo" e "Por dia" — cada um só quando deve', async () => {
    const totalDe = (e, s, cw, cr, n) => ({ entrada: e, saida: s, cacheEscrita: cw, cacheLeitura: cr, linhas: n });
    /** A resposta de /api/uso no formato NOVO, com os pedaços do caso sobrescritos. */
    const resposta = (over = {}) => ({
      geradoEm: '2026-09-04T10:00:00.000Z', desde: '2026-08-29', ate: '2026-09-04', dias: 7,
      total: totalDe(2000, 300, 100, 50, 9),
      precos: { consultadoEm: '2026-09-04', moeda: 'USD' },
      custo: { usd: 12.5, conhecido: true, tokensSemPreco: 0, cacheSemDuracao: 0 },
      porModelo: [
        { modelo: 'claude-opus-5', total: totalDe(1800, 250, 100, 50, 7), custo: { usd: 12.5, conhecido: true } },
        { modelo: 'bananinha', total: totalDe(200, 50, 0, 0, 2), custo: { usd: 0, conhecido: false } },
      ],
      porDia: [
        { dia: '2026-09-03', total: totalDe(500, 100, 0, 0, 3), custo: { usd: 3.5, conhecido: true } },
        { dia: '2026-09-04', total: totalDe(1500, 200, 100, 50, 6), custo: { usd: 9, conhecido: true } },
      ],
      projetos: [{
        projeto: 'proj-a', total: totalDe(2000, 300, 100, 50, 9),
        custo: { usd: 12.5, conhecido: true },
        porModelo: [{ modelo: 'claude-opus-5', total: totalDe(1800, 250, 100, 50, 7), custo: { usd: 12.5, conhecido: true } }],
        origens: [],
      }],
      leitura: { arquivos: 1, comUsage: 1, relidos: 1, bytesLidos: 1, ms: 1, linhasIgnoradas: 0, arquivosComErro: 0, precisaoPerdida: false },
      ...over,
    });
    async function desenhar(dados) {
      const { contexto, porId } = carregarUsoJsFalso({ token: '', respostaFetch: dados });
      await contexto.telaUso.carregar(dados.dias);
      return porId;
    }

    // 1. a linha de ESTIMATIVA aparece SEMPRE — é a trava que impede o número de mentir.
    const p1 = await desenhar(resposta());
    const custoTxt = p1.get('uso-custo').textContent;
    assert(/estimativa/i.test(custoTxt) && /assinatura/i.test(custoTxt),
      `a linha de estimativa está no DOM (veio "${custoTxt.slice(0, 160)}")`);
    assert(/US\$\s*12,50/.test(custoTxt), `o valor sai formatado em pt-BR (veio "${custoTxt.slice(0, 80)}")`);
    assert(/04\/09/.test(custoTxt), 'a data da consulta de preço aparece na nota');

    // 2. "Por dia" some com dias:1 e aparece com dias:7.
    const modeloTxt1 = p1.get('uso-por-modelo').textContent;
    assert(/claude-opus-5/.test(modeloTxt1), `"Por modelo" desenha os modelos (veio "${modeloTxt1.slice(0, 120)}")`);
    // O detalhe cache/entrada/saída de cada modelo (spec §2.1). Nasceu FALTANDO na primeira
    // versão desta tela e ninguém viu — nenhum assert olhava para ele.
    assert(/cache 50(?![\d.,])/.test(modeloTxt1) && /entrada 1,8k/.test(modeloTxt1) && /sa[íi]da 250/.test(modeloTxt1),
      `cada linha traz cache/entrada/saída com os números do modelo (veio "${modeloTxt1.slice(0, 220)}")`);
    assert(p1.get('uso-por-dia').textContent.includes('03/09'), 'com dias:7, "Por dia" traz as datas em pt-BR');
    const p2 = await desenhar(resposta({ dias: 1, porDia: [{ dia: '2026-09-04', total: totalDe(1500, 200, 100, 50, 6), custo: { usd: 9, conhecido: true } }] }));
    assert(p2.get('uso-por-dia').textContent === '', `com dias:1, "Por dia" fica VAZIO (veio "${p2.get('uso-por-dia').textContent}")`);
    assert(p2.get('uso-custo').textContent !== '', 'mas o custo continua lá em dias:1');

    // 3. modelo sem preço: o TEXTO no lugar do valor, nunca US$ 0,00.
    assert(/sem preço conhecido/.test(modeloTxt1), `"sem preço conhecido" no lugar do valor (veio "${modeloTxt1}")`);
    assert(!/US\$\s*0,00/.test(modeloTxt1), `nenhum "US$ 0,00" mentiroso na seção (veio "${modeloTxt1}")`);

    // 4. os avisos acendem só quando > 0.
    assert(!/sem preço conhecido: |ficaram de fora/.test(p1.get('uso-custo').textContent), 'com tokensSemPreco:0, o aviso NÃO acende');
    const p3 = await desenhar(resposta({ custo: { usd: 12.5, conhecido: false, tokensSemPreco: 250, cacheSemDuracao: 4000 } }));
    const t3 = p3.get('uso-custo').textContent;
    assert(/ficaram de fora/.test(t3) && /250/.test(t3), `tokensSemPreco > 0 acende o aviso com o número (veio "${t3}")`);
    assert(/5 min/.test(t3) && /4,0k|4000/.test(t3), `cacheSemDuracao > 0 diz que assumiu 5 min (veio "${t3}")`);
    assert(/~US\$/.test(t3), `custo.conhecido:false marca o valor com "~" — é um piso, não um exato (veio "${t3}")`);

    // 5. a linha de modelos do projeto traz NOME + NÚMERO (era só nome).
    const listaTxt = p1.get('uso-lista').textContent;
    assert(/claude-opus-5\s+[\d.,]/.test(listaTxt), `a linha de modelos do projeto tem nome SEGUIDO de número (veio "${listaTxt}")`);

    // 6. o valor abaixo de um centavo NÃO vira "US$ 0,00" (o zero mentiroso).
    const p4 = await desenhar(resposta({ custo: { usd: 0.0003, conhecido: true, tokensSemPreco: 0, cacheSemDuracao: 0 } }));
    assert(/< US\$ 0,01/.test(p4.get('uso-custo').textContent), `gasto real minúsculo vira "< US$ 0,01" (veio "${p4.get('uso-custo').textContent.slice(0, 60)}")`);

    // 7. o catch limpa as três seções — senão a tela de erro fica com o custo velho por baixo.
    const { contexto, porId } = carregarUsoJsFalso({ token: '', respostaFetch: resposta() });
    await contexto.telaUso.carregar(7);
    assert(porId.get('uso-custo').textContent !== '', 'antes do erro, o custo está desenhado');
    contexto.fetch = async () => { throw new Error('caiu'); };
    await contexto.telaUso.carregar(7);
    assert(porId.get('uso-custo').textContent === '' && porId.get('uso-por-modelo').textContent === '' && porId.get('uso-por-dia').textContent === '',
      'depois do erro, as três seções ficam vazias');
  });

  // ── blocos do card `tokens-mais-detalhe` (G33-G39) ────────────────────
  //
  // Todos rodam sobre `montar()` com o `estado` montado à MÃO — nenhum toca disco. Isso não é
  // só velocidade: criar pasta nova aqui poluiria o G26 (a whitelist fechada de ids de
  // modelo), que varre o HOME compartilhado inteiro.

  /** Um `estado` no formato de `varrer()`, a partir de `{dia: {modelo: arr}}` — um projeto só. */
  function estadoDe(dias, projeto = 'gcusto') {
    return {
      arquivos: { '/x/a.jsonl': { offset: 1, ino: 1, assinatura: '', ignoradas: {}, mtimeMs: 0, dias } },
      caminhoParaPasta: { '/x/a.jsonl': 'pasta1' },
      classes: { pasta1: { origem: 'aba', projeto, rotulo: `aba ${projeto}`, id: 'pasta1' } },
      leitura: { arquivos: 1, comUsage: 1, relidos: 1, bytesLidos: 1, ms: 1, arquivosComErro: 0 },
    };
  }
  /** O array de agregado de 7 posições, na ordem de `agregarLinha`. */
  const agr = (entrada = 0, saida = 0, cw = 0, cr = 0, n = 1, e5 = 0, e1 = 0) => [entrada, saida, cw, cr, n, e5, e1];
  const HOJE_UTC = new Date().toISOString().slice(0, 10);
  const DIA_MENOS = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const perto = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

  await bloco('G33. a soma por MODELO fecha com o total geral — e com 5 posições não vira NaN', async () => {
    const dias = {
      [HOJE_UTC]: {
        'claude-opus-5': agr(1000, 200, 3000, 40000, 5, 1000, 2000),
        'claude-haiku-4-5-20251001': agr(70, 8, 900, 100, 2, 900, 0),
      },
      [DIA_MENOS(1)]: { 'claude-opus-5': agr(11, 22, 33, 44, 1, 33, 0) },
    };
    const r = uso.montar(estadoDe(dias), 7);
    const campos = ['entrada', 'saida', 'cacheEscrita', 'cacheLeitura'];
    for (const c of campos) {
      const soma = r.porModelo.reduce((s, m) => s + m.total[c], 0);
      assert(soma === r.total[c], `Σ porModelo[].total.${c} === total.${c} (${soma} vs ${r.total[c]})`);
    }
    const p = r.projetos[0];
    for (const c of campos) {
      const soma = p.porModelo.reduce((s, m) => s + m.total[c], 0);
      assert(soma === p.total[c], `dentro do projeto: Σ porModelo[].total.${c} === total.${c} (${soma} vs ${p.total[c]})`);
    }
    // A amarração de CUSTO. `Σ porModelo[].custo.usd === custo.usd` SOZINHO não vale nada:
    // os dois lados saem do mesmo acumulador, é identidade algébrica e não pode falhar
    // (provado — um `estado` com as posições 5/6 absurdas passava). A âncora de verdade é o
    // custo calculado À MÃO a partir do fixture, por um caminho que não toca `montar()`:
    //
    //   opus-5 (os DOIS dias somados; a escrita de 5m e 1000 hoje + 33 ontem = 1033):
    //     entrada 1011 × 5,00  +  saída 222 × 25,00  +  1033 × 6,25  +  2000 × 10,00
    //     +  cacheLeitura 40044 × 0,50                                       tudo /1e6
    //   haiku-4-5 (o id vem com sufixo de data), escrita 900 toda em 5m:
    //     70 × 1,00  +  8 × 5,00  +  900 × 1,25  +  100 × 0,10               tudo /1e6
    const esperadoOpus = (1011 * 5 + 222 * 25 + 1033 * 6.25 + 2000 * 10 + 40044 * 0.5) / 1e6;
    const esperadoHaiku = (70 * 1 + 8 * 5 + 900 * 1.25 + 100 * 0.1) / 1e6;
    assert(perto(r.custo.usd, esperadoOpus + esperadoHaiku),
      `custo.usd bate com a conta à mão sobre os DOIS modelos e os DOIS dias (${r.custo.usd} vs ${esperadoOpus + esperadoHaiku})`);
    const somaUsd = r.porModelo.reduce((s, m) => s + (m.custo.conhecido ? m.custo.usd : 0), 0);
    assert(perto(somaUsd, r.custo.usd), `Σ porModelo[].custo.usd === custo.usd (${somaUsd} vs ${r.custo.usd})`);
    const doOpus = r.porModelo.find((m) => m.modelo === 'claude-opus-5');
    assert(doOpus && perto(doOpus.custo.usd, esperadoOpus),
      `o custo do opus-5 sozinho bate com a conta à mão (${doOpus && doOpus.custo.usd} vs ${esperadoOpus})`);

    // (b) o MESMO fechamento sobre arrays de 5 posições — o formato que G25 e G29 passam à
    // mão. Sem esta rodada a defesa do `|| 0` nunca é exercitada e `arr[5]` viraria NaN.
    const r5 = uso.montar(estadoDe({ [HOJE_UTC]: { 'claude-opus-5': [77, 0, 0, 0, 1] } }), 1);
    assert(Number.isFinite(r5.custo.usd) && r5.custo.usd > 0, `5 posições: custo finito e > 0 (veio ${r5.custo.usd})`);
    assert(r5.porModelo.length === 1 && r5.porModelo[0].total.entrada === 77, `5 posições: porModelo fecha (veio ${JSON.stringify(r5.porModelo)})`);
    assert(r5.custo.cacheSemDuracao === 0, `5 posições sem cacheEscrita: cacheSemDuracao 0 (veio ${r5.custo.cacheSemDuracao})`);
  });

  await bloco('G34. a soma por DIA fecha com o total, só traz dias da janela, em ordem CRESCENTE', async () => {
    const dias = {
      [DIA_MENOS(2)]: { 'claude-opus-5': agr(500, 10, 0, 0, 1) },
      [HOJE_UTC]: { 'claude-opus-5': agr(100, 20, 0, 0, 1) },
      [DIA_MENOS(1)]: { 'claude-sonnet-5': agr(300, 30, 0, 0, 1) },
      '2020-01-01': { 'claude-opus-5': agr(999999, 0, 0, 0, 1) },   // fora da janela
      'sem-data': { 'claude-opus-5': agr(888888, 0, 0, 0, 1) },     // nunca entra
    };
    const r = uso.montar(estadoDe(dias), 7);
    for (const c of ['entrada', 'saida', 'cacheEscrita', 'cacheLeitura']) {
      const soma = r.porDia.reduce((s, d) => s + d.total[c], 0);
      assert(soma === r.total[c], `Σ porDia[].total.${c} === total.${c} (${soma} vs ${r.total[c]})`);
    }
    const nomes = r.porDia.map((d) => d.dia);
    assert(nomes.length === 3, `só os 3 dias da janela entram (veio ${JSON.stringify(nomes)})`);
    assert(!nomes.includes('2020-01-01') && !nomes.includes('sem-data'), `dia fora da janela e 'sem-data' ficam de fora (veio ${JSON.stringify(nomes)})`);
    assert(JSON.stringify(nomes) === JSON.stringify([...nomes].sort()), `ordem CRESCENTE por data (veio ${JSON.stringify(nomes)})`);
    const somaUsd = r.porDia.reduce((s, d) => s + (d.custo.conhecido ? d.custo.usd : 0), 0);
    assert(perto(somaUsd, r.custo.usd), `Σ porDia[].custo.usd === custo.usd (${somaUsd} vs ${r.custo.usd})`);

    // ── o caso que a versão de 04/09 errava (achado pelo avaliador de execução) ──
    // `custoDe` e `cacheSemDuracaoDe` são NÃO-LINEARES por causa do clamp do caso
    // inconsistente. Enquanto o custo era calculado sobre agregados diferentes (o Map por
    // modelo no topo, o Map por dia embaixo), o topo dava US$ 16,25 e a soma dos dias
    // US$ 12,50 — dois números que a TELA MOSTRA LADO A LADO — e `cacheSemDuracao` vinha 0
    // mesmo com os dois dias assumindo 5 min. Este bloco é o que impede a volta disso.
    const M = 1e6;
    const misto = uso.montar(estadoDe({
      [DIA_MENOS(1)]: { 'claude-opus-5': agr(0, 0, M, 0, 1, M, M) },   // fonte inconsistente
      [HOJE_UTC]: { 'claude-opus-5': agr(0, 0, M, 0, 1, 0, 0) },       // sem duração declarada
    }), 7);
    const somaDias = misto.porDia.reduce((s, d) => s + d.custo.usd, 0);
    const somaModelos = misto.porModelo.reduce((s, m) => s + m.custo.usd, 0);
    const somaProjetos = misto.projetos.reduce((s, p) => s + p.custo.usd, 0);
    assert(perto(misto.custo.usd, 12.5),
      `inconsistente + sem duração: os 2M de escrita são cobrados a 5m ⇒ US$ 12,50 (veio ${misto.custo.usd})`);
    assert(perto(somaDias, misto.custo.usd) && perto(somaModelos, misto.custo.usd) && perto(somaProjetos, misto.custo.usd),
      `os QUATRO eixos fecham no mesmo número — topo ${misto.custo.usd}, dias ${somaDias}, modelos ${somaModelos}, projetos ${somaProjetos}`);
    assert(misto.custo.cacheSemDuracao === 2 * M,
      `cacheSemDuracao soma os DOIS dias que assumiram 5 min (esperado ${2 * M}, veio ${misto.custo.cacheSemDuracao})`);
  });

  await bloco('G35. o custo de um caso conhecido bate com a conta feita À MÃO', async () => {
    // claude-opus-5: entrada 5,00 · saída 25,00 · escrita 5m 6,25 · escrita 1h 10,00 · leitura 0,50
    // 1M de cada  ⇒  5 + 25 + 6,25 + 10 + 0,50 = 46,75
    const M = 1e6;
    const r = uso.montar(estadoDe({ [HOJE_UTC]: { 'claude-opus-5': agr(M, M, 2 * M, M, 1, M, M) } }), 1);
    assert(perto(r.custo.usd, 46.75), `US$ 46,75 (veio ${r.custo.usd})`);
    assert(r.custo.conhecido === true, `custo.conhecido === true (veio ${r.custo.conhecido})`);
    assert(perto(r.porModelo[0].custo.usd, 46.75), `o mesmo em porModelo[0] (veio ${r.porModelo[0].custo.usd})`);
    assert(perto(r.projetos[0].custo.usd, 46.75), `o mesmo no projeto (veio ${r.projetos[0].custo.usd})`);
    assert(r.custo.cacheSemDuracao === 0, `escrita toda classificada ⇒ cacheSemDuracao 0 (veio ${r.custo.cacheSemDuracao})`);
    assert(r.precos.consultadoEm === uso.PRECOS_CONSULTADOS_EM && /^\d{4}-\d{2}-\d{2}$/.test(r.precos.consultadoEm),
      `a data da consulta viaja na resposta (veio ${JSON.stringify(r.precos)})`);
    assert(r.precos.moeda === 'USD', `a moeda é declarada (veio ${r.precos.moeda})`);
  });

  await bloco('G36. a tabela de preço obedece aos multiplicadores da FONTE, com uma exceção nomeada', async () => {
    const EXCECAO = 'claude-fable-5-1';   // lê cache a 0,025× (US$ 0,25/1M), não 0,1× — skill claude-api
    const linhas = Object.entries(uso.PRECOS);
    assert(linhas.length >= 9, `a tabela tem as 9+ linhas de §1.5 (veio ${linhas.length})`);
    for (const [modelo, p] of linhas) {
      assert(perto(p.escrita5m, p.entrada * 1.25), `${modelo}: escrita 5m === entrada × 1,25 (${p.escrita5m} vs ${p.entrada * 1.25})`);
      assert(perto(p.escrita1h, p.entrada * 2), `${modelo}: escrita 1h === entrada × 2 (${p.escrita1h} vs ${p.entrada * 2})`);
      if (modelo === EXCECAO) {
        assert(p.leitura === 0.25, `${modelo}: a exceção documentada é cobrada NOMINALMENTE — 0,25 (veio ${p.leitura})`);
      } else {
        assert(perto(p.leitura, p.entrada * 0.1), `${modelo}: leitura === entrada × 0,1 (${p.leitura} vs ${p.entrada * 0.1})`);
      }
      // As 9 linhas obedecem saida = entrada x 5. O `|| p.entrada === 3` que havia aqui era
      // um disjunto MORTO: nenhuma linha precisa dele hoje, e no dia em que a sonnet-4-6
      // mudar de preco ele deixaria a checagem inteira passar de graca.
      assert(p.saida === p.entrada * 5, `${modelo}: saída === entrada × 5 (${p.entrada}/${p.saida})`);
    }
    assert(uso.PRECOS['claude-opus-5'].entrada === 5 && uso.PRECOS['claude-opus-5'].saida === 25,
      'claude-opus-5 é 5/25 (consultado na skill claude-api em 2026-09-04)');
    assert(uso.PRECOS['claude-mythos-5-1'] === undefined,
      'claude-mythos-5-1 NÃO está na tabela — a fonte diz que a taxa de leitura dele é indefinida');
  });

  await bloco('G37. modelo desconhecido NÃO vira zero: fica de fora do custo e acende tokensSemPreco', async () => {
    const r = uso.montar(estadoDe({
      [HOJE_UTC]: {
        'claude-opus-5': agr(1e6, 0, 0, 0, 1),
        bananinha: agr(10, 20, 30, 40, 3),
      },
    }), 1);
    const desconhecido = r.porModelo.find((m) => m.modelo === 'bananinha');
    assert(desconhecido && desconhecido.custo.conhecido === false, `bananinha: conhecido === false (veio ${JSON.stringify(desconhecido && desconhecido.custo)})`);
    assert(desconhecido && desconhecido.custo.usd === 0, `bananinha: usd === 0 (veio ${desconhecido && desconhecido.custo.usd})`);
    assert(desconhecido && desconhecido.total.entrada === 10, 'bananinha aparece com os TOKENS à vista');
    assert(perto(r.custo.usd, 5), `custo.usd é só o do opus (US$ 5,00) — o desconhecido não somou (veio ${r.custo.usd})`);
    assert(r.custo.conhecido === false, `o custo GERAL é marcado como piso (conhecido=false) (veio ${r.custo.conhecido})`);
    assert(r.custo.tokensSemPreco === 100, `tokensSemPreco = 10+20+30+40 = 100 (veio ${r.custo.tokensSemPreco})`);
    assert(r.projetos[0].custo.conhecido === false, 'o projeto também é marcado como piso');
    const soOpus = uso.montar(estadoDe({ [HOJE_UTC]: { 'claude-opus-5': agr(1e6, 0, 0, 0, 1) } }), 1);
    assert(soOpus.custo.conhecido === true && soOpus.custo.tokensSemPreco === 0,
      `sem modelo desconhecido: conhecido=true e tokensSemPreco=0 (veio ${soOpus.custo.conhecido}/${soOpus.custo.tokensSemPreco})`);
  });

  await bloco('G38. normalizarModelo(): sufixo de data e sufixo [1m] caem, o resto NÃO é adivinhado', async () => {
    assert(uso.normalizarModelo('claude-haiku-4-5-20251001') === 'claude-haiku-4-5', `sufixo -YYYYMMDD cai (veio ${uso.normalizarModelo('claude-haiku-4-5-20251001')})`);
    assert(uso.normalizarModelo('claude-opus-5[1m]') === 'claude-opus-5', `sufixo [1m] cai — armadilha #27 (veio ${uso.normalizarModelo('claude-opus-5[1m]')})`);
    assert(uso.normalizarModelo('claude-opus-5') === 'claude-opus-5', 'id já curto não muda');
    assert(uso.normalizarModelo('banana') === 'banana', 'id desconhecido passa inteiro — nada de heurística');
    assert(uso.normalizarModelo(undefined) === '' && uso.normalizarModelo(null) === '', 'null/undefined viram string vazia, não estouram');
    assert(uso.custoDe('claude-haiku-4-5-20251001', agr(1e6, 0, 0, 0, 1)).conhecido === true, 'o id COM data encontra preço (2,4M de tokens que virariam "sem preço" à toa)');
    assert(uso.custoDe('claude-opus-5[1m]', agr(1e6, 0, 0, 0, 1)).conhecido === true, 'o id COM [1m] encontra preço');
    assert(uso.custoDe('banana', agr(1e6, 0, 0, 0, 1)).conhecido === false, '"banana" NÃO encontra preço — e não é chutado');
  });

  await bloco('G39. escrita de cache é cobrada pela DURAÇÃO REAL; sem duração, assume 5m e SINALIZA', async () => {
    const M = 1e6;
    const de5m = uso.montar(estadoDe({ [HOJE_UTC]: { 'claude-opus-5': agr(0, 0, M, 0, 1, M, 0) } }), 1);
    const de1h = uso.montar(estadoDe({ [HOJE_UTC]: { 'claude-opus-5': agr(0, 0, M, 0, 1, 0, M) } }), 1);
    assert(perto(de5m.custo.usd, 6.25), `1M de escrita 5m custa US$ 6,25 (veio ${de5m.custo.usd})`);
    assert(perto(de1h.custo.usd, 10), `1M de escrita 1h custa US$ 10,00 (veio ${de1h.custo.usd})`);
    assert(de1h.custo.usd > de5m.custo.usd, 'a de 1h custa MAIS que a de 5m no mesmo volume');
    assert(de5m.custo.cacheSemDuracao === 0 && de1h.custo.cacheSemDuracao === 0, 'com duração declarada, cacheSemDuracao fica em 0');

    // `cache_creation` ausente (CLI antigo, armadilha #10): o resíduo é cobrado como 5m E dito.
    const semDuracao = uso.montar(estadoDe({ [HOJE_UTC]: { 'claude-opus-5': agr(0, 0, M, 0, 1, 0, 0) } }), 1);
    assert(perto(semDuracao.custo.usd, 6.25), `sem duração ⇒ mesmo custo do caso 5m (veio ${semDuracao.custo.usd})`);
    assert(semDuracao.custo.cacheSemDuracao === M, `cacheSemDuracao acende com o resíduo inteiro (veio ${semDuracao.custo.cacheSemDuracao})`);

    // Fonte INCONSISTENTE (e5+e1 > cacheEscrita): confia-se no campo mais antigo, cobra-se
    // tudo a 5m, e sinaliza — nunca um custo maior que o volume mostrado ao lado.
    const inconsistente = uso.montar(estadoDe({ [HOJE_UTC]: { 'claude-opus-5': agr(0, 0, M, 0, 1, M, M) } }), 1);
    assert(perto(inconsistente.custo.usd, 6.25), `inconsistente ⇒ cacheEscrita inteiro a 5m, sem estourar o volume (veio ${inconsistente.custo.usd})`);
    assert(inconsistente.custo.cacheSemDuracao === M, `inconsistente também sinaliza (veio ${inconsistente.custo.cacheSemDuracao})`);

    // E a origem dos números: agregarLinha() lê mesmo `usage.cache_creation` do .jsonl.
    const alvo = { dias: {} };
    uso.agregarLinha({
      type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z',
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
        },
      },
    }, alvo);
    const linha = alvo.dias['2026-09-04']['claude-opus-5'];
    assert(linha[2] === 300 && linha[5] === 100 && linha[6] === 200,
      `agregarLinha grava [cw, e5, e1] = [300, 100, 200] (veio [${linha[2]}, ${linha[5]}, ${linha[6]}])`);
    const alvoSem = { dias: {} };
    uso.agregarLinha({
      type: 'assistant', timestamp: '2026-09-04T10:00:00.000Z',
      message: { model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 300 } },
    }, alvoSem);
    const semCc = alvoSem.dias['2026-09-04']['claude-opus-5'];
    assert(semCc[2] === 300 && semCc[5] === 0 && semCc[6] === 0, `sem cache_creation: [300, 0, 0] em vez de estourar (veio [${semCc[2]}, ${semCc[5]}, ${semCc[6]}])`);
  });

  const faltaram = CASOS_ESPERADOS.filter((c) => !CASOS.has(c));
  console.log(`\n${passou}/${total} asserções · ${CASOS.size}/${CASOS_ESPERADOS.length} casos (parte 1)`);
  if (faltaram.length) {
    vermelho = true;
    console.log(`❌ casos que NÃO rodaram: ${faltaram.join(', ')}`);
  }
}

// ─── parte 2 — G11, a whitelist de `?dias=` contra o servidor no ar (fase 2) ────────────────
//
// Asserção de fonte é PROIBIDA aqui (plano §2.2, ponto 5 do painel 1ª rodada): um grep acharia
// a whitelist e deixaria passar lógica errada em volta dela. Este bloco sobe UM request HTTP de
// verdade por caso, contra o servidor que `gate-fase2.sh` já colocou no ar — ele não sobe
// servidor nenhum sozinho. `PORT` é OBRIGATÓRIA: sem ela, bateria em produção (7879) por
// padrão, e é exatamente o que o código 2 abaixo evita.

function pedirJson(caminho) {
  return new Promise((resolve, reject) => {
    const opcoes = {
      host: process.env.HOST || '127.0.0.1',
      port: Number(process.env.PORT),
      path: caminho,
      method: 'GET',
      headers: process.env.COCKPIT_TOKEN ? { authorization: `Bearer ${process.env.COCKPIT_TOKEN}` } : {},
    };
    const req = http.request(opcoes, (res) => {
      let dados = '';
      res.on('data', (d) => { dados += d; });
      res.on('end', () => {
        let corpo = null;
        try { corpo = JSON.parse(dados); } catch { /* corpo não-JSON — os asserts abaixo pegam */ }
        resolve({ status: res.statusCode, tipo: res.headers['content-type'] || '', corpo });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function parte2() {
  console.log(`\ngate-uso — parte 2 (G11, contra o servidor em ${process.env.HOST || '127.0.0.1'}:${process.env.PORT})`);
  CASOS.add('G11');
  const casos = [
    { qs: '', esperado: 1, rotulo: 'ausente' },
    { qs: '?dias=abc', esperado: 1, rotulo: '"abc"' },
    { qs: '?dias=-1', esperado: 1, rotulo: '-1' },
    { qs: '?dias=0', esperado: 1, rotulo: '0' },
    { qs: '?dias=', esperado: 1, rotulo: 'vazio' },
    { qs: '?dias=99999', esperado: 1, rotulo: '99999' },
    { qs: '?dias=7.5', esperado: 1, rotulo: '7.5' },
    { qs: '?dias=1e3', esperado: 1, rotulo: '1e3' },
    { qs: '?dias=7', esperado: 7, rotulo: '7' },
    { qs: '?dias=30', esperado: 30, rotulo: '30' },
  ];
  for (const caso of casos) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pedirJson(`/api/uso${caso.qs}`);
    assert(r.status === 200, `dias=${caso.rotulo}: status 200 (veio ${r.status})`);
    assert(r.tipo.startsWith('application/json'), `dias=${caso.rotulo}: content-type application/json (veio "${r.tipo}")`);
    const c = r.corpo;
    assert(c && Array.isArray(c.projetos), `dias=${caso.rotulo}: corpo.projetos é array`);
    assert(c && c.total && typeof c.total.entrada === 'number' && typeof c.total.saida === 'number'
      && typeof c.total.cacheEscrita === 'number' && typeof c.total.cacheLeitura === 'number',
      `dias=${caso.rotulo}: corpo.total tem os 4 campos`);
    assert(c && c.leitura && typeof c.leitura.arquivos === 'number', `dias=${caso.rotulo}: corpo.leitura existe`);
    assert(c && c.dias === caso.esperado, `dias=${caso.rotulo}: whitelist ⇒ dias=${caso.esperado} (veio ${c && c.dias})`);
  }
}

(async () => {
  const modo = process.argv[2];
  if (modo === 'parte2') {
    if (!process.env.PORT) {
      console.error('🔴 defina PORT antes de rodar parte2 — sem ela bateria em produção (7879).');
      process.exit(2);
    }
    await parte2();
    console.log(`\n${vermelho ? '❌ GATE VERMELHO' : '✅ GATE VERDE'} — lib/uso.js (parte 2)\n`);
    process.exit(vermelho ? 1 : 0);
  }
  await parte1();
  console.log(`\n${vermelho ? '❌ GATE VERMELHO' : '✅ GATE VERDE'} — lib/uso.js (parte 1)\n`);
  process.exit(vermelho ? 1 : 0);
})().catch((e) => {
  console.error('\n❌ GATE EXPLODIU:', e);
  process.exit(1);
});
