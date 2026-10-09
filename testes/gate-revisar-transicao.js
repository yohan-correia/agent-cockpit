#!/usr/bin/env node
'use strict';
// GATE do "Pra revisar que não atualiza sozinho" (card `pra-revisar-nao-atualiza-sozinho`).
//
// O defeito: um job que termina com a página aberta não chega ao Pra revisar — o número do
// ícone fica parado e a lista aberta não ganha o job. Só recarregando. O contador só rodava no
// boot e no `close` do dialog; a lista, só no clique (public/revisar.js).
//
// O conserto usa a TRANSIÇÃO que o tique de 15 s já enxerga (`atualizarFaixaJobs`, public/app.js):
// um job que estava `running` na leitura anterior e não está na de agora. Nunca relógio novo:
// a rota `?revisar=1` roda `git` por job (D60) e só pode sair quando algo terminou.
//
// Como prova: carrega `traducoes.js` + `i18n.js` + `app.js` + `revisar.js` NO MESMO contexto
// (a ordem real do index.html), com DOM de mentira e `fetch` roteirizado. Molde do DOM:
// `criarElementoFalso` de testes/gate-uso.js — copiado, sem contrato entre os dois gates.
// Node puro: sem servidor, sem porta.
//
// Nasceu VERMELHO (T1, T2 e o contador do T4) contra a develop 9960afb.
//
// Uso:  node testes/gate-revisar-transicao.js

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAIZ = path.join(__dirname, '..');
let falhas = 0;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };

// ─── DOM de mentira (molde: testes/gate-uso.js `criarElementoFalso`) ─────────────────────

function criarElementoFalso(tag) {
  const el = {
    tag, filhos: [], pai: null, atributos: {}, dataset: {}, className: '', hidden: false,
    disabled: false, open: false, _texto: '',
    style: { cssText: '', setProperty(n, v) { this[n] = String(v); }, removeProperty(n) { delete this[n]; }, getPropertyValue(n) { return this[n] ?? ''; } },
    get textContent() {
      const juntar = (n) => (n.tag === '#texto' ? n.valor : n.filhos.map(juntar).join('') || n._texto || '');
      return juntar(el);
    },
    set textContent(v) { el.filhos = []; el._texto = String(v); },
    append(...nos) { for (const n of nos) { const f = typeof n === 'string' ? { tag: '#texto', valor: n, filhos: [] } : n; f.pai = el; el.filhos.push(f); } },
    appendChild(no) { el.append(no); return no; },
    // `revisar.js` troca a tela inteira por aqui (lista ↔ job).
    replaceChildren(...nos) { el.filhos = []; el._texto = ''; el.append(...nos); },
    setAttribute(k, v) { el.atributos[k] = String(v); },
    getAttribute(k) { return el.atributos[k]; },
    removeAttribute(k) { delete el.atributos[k]; },
    ouvintes: new Map(),
    addEventListener(tipo, fn) { if (!el.ouvintes.has(tipo)) el.ouvintes.set(tipo, []); el.ouvintes.get(tipo).push(fn); },
    removeEventListener(tipo, fn) { el.ouvintes.set(tipo, (el.ouvintes.get(tipo) || []).filter((f) => f !== fn)); },
    focus() {}, remove() { if (el.pai) { el.pai.filhos = el.pai.filhos.filter((f) => f !== el); el.pai = null; } },
    scrollIntoView() {}, showModal() { el.open = true; }, close() { el.open = false; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    get lastChild() { return el.filhos[el.filhos.length - 1] || null; },
    get children() { return el.filhos.filter((f) => f.tag !== '#texto'); },
    get childNodes() { return el.filhos; }, // `cardDe` pergunta `l3.childNodes.length`
  };
  return el;
}

/** Acha, na árvore de mentira, o primeiro nó cuja classe contém `classe`. */
function acharPorClasse(raiz, classe) {
  if (String(raiz.className || '').split(/\s+/).includes(classe)) return raiz;
  for (const f of raiz.filhos || []) {
    const achou = acharPorClasse(f, classe);
    if (achou) return achou;
  }
  return null;
}

/** Todos os nós cuja classe contém `classe`, em ordem de árvore. */
function acharTodosPorClasse(raiz, classe, achados = []) {
  if (String(raiz.className || '').split(/\s+/).includes(classe)) achados.push(raiz);
  for (const f of raiz.filhos || []) acharTodosPorClasse(f, classe, achados);
  return achados;
}

/** O `close` do <dialog> de verdade dispara os ouvintes; o `close()` do molde só baixa o `open`. */
function fecharDialog(c) {
  c.dlg.close();
  for (const fn of c.dlg.ouvintes.get('close') || []) fn({});
}

/** Qual filtro (Todos/Prontos/Atenção) está apertado na lista da vista — '' se não há lista. */
function filtroApertado(c) {
  const b = acharTodosPorClasse(c.rv, 'rv-filtro').find((f) => f.atributos['aria-pressed'] === 'true');
  return b ? b.textContent.replace(/\d+$/, '') : '';
}

/**
 * Um navegador de mentira com o cockpit carregado. `cenario` é mutável: o teste muda o que
 * o servidor "responde" e chama `atualizarFaixaJobs()` — o mesmo que o tique de 15 s chama.
 *   cenario.tudo      → `jobs` de `api/jobs?tudo=1`, ou 'erro' (rede caiu) / 'sem-painel'
 *   cenario.revisar   → `jobs` de `/api/jobs?revisar=1` (e `cenario.atencao` → `atencao`)
 *   cenario.falhaRevisar      → 'throw' (HTTP 500) | 'habilitado-false' | 'erro' — as três saídas de falha
 *   cenario.segurarRevisar    → cada pedido à rota fica PRESO em `cenario.revisarPresos` até o teste soltar
 *   cenario.segurarResultado  → idem para `/api/jobs/resultado`, em `cenario.resultadosPresos`
 */
function abrirCockpit(cenario) {
  cenario.revisarPresos = cenario.revisarPresos || [];
  cenario.resultadosPresos = cenario.resultadosPresos || [];
  const porId = new Map();
  const chamadasRevisar = [];
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
    localStorage: { getItem: (k) => (k === 'cockpit-token' ? 'tok' : (k === 'cockpit-idioma' ? 'pt-BR' : null)), setItem: () => {}, removeItem: () => {} },
    location: { href: 'http://z/', origin: 'http://z', pathname: '/', search: '', hash: '', hostname: 'z' },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {} },
    URL, URLSearchParams,
    navigator: { userAgent: 'gate-revisar-transicao/1.0', language: 'pt-BR' },
    window: { addEventListener: () => {}, open: () => {} },
    atob: (t) => Buffer.from(t, 'base64').toString('binary'),
    Uint8Array,
    CSS: { escape: (s) => s },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    fetch: async (rota) => {
      const r = String(rota);
      const resposta = (corpo) => ({ ok: true, status: 200, json: async () => corpo });
      if (/api\/jobs\?tudo=1/.test(r)) {
        if (cenario.tudo === 'erro') throw new TypeError('Failed to fetch');
        if (cenario.tudo === 'sem-painel') return resposta({ jobs: [], painel: false });
        return resposta({ jobs: cenario.tudo, painel: true });
      }
      if (/api\/jobs\?revisar=1/.test(r)) {
        chamadasRevisar.push(r);
        // O corpo é o do INSTANTE do pedido (T8 solta respostas fora de ordem).
        const falha = cenario.falhaRevisar;
        if (falha === 'throw') return { ok: false, status: 500, json: async () => ({}) };
        const corpo = falha === 'habilitado-false' ? { habilitado: false, jobs: [] }
          : (falha === 'erro' ? { erro: true, jobs: [] }
            : { habilitado: true, jobs: cenario.revisar, atencao: cenario.atencao || [] });
        if (!cenario.segurarRevisar) return resposta(corpo);
        return new Promise((soltar) => { cenario.revisarPresos.push(() => soltar(resposta(corpo))); });
      }
      if (/api\/jobs\/resultado/.test(r)) {
        const corpo = { texto: '', cortado: false };
        if (!cenario.segurarResultado) return resposta(corpo);
        return new Promise((soltar) => { cenario.resultadosPresos.push(() => soltar(resposta(corpo))); });
      }
      return resposta({});
    },
    EventSource: function EventSource() { return { close() {} }; },
    XMLHttpRequest: function XMLHttpRequest() { return { open() {}, setRequestHeader() {}, send() {}, abort() {}, upload: {} }; },
    setInterval: () => 1, setTimeout: () => 0, clearInterval: () => {}, clearTimeout: () => {},
    console, alert: () => {}, confirm: () => false,
  };
  vm.createContext(contexto);
  for (const arquivo of ['traducoes.js', 'i18n.js', 'app.js', 'revisar.js']) {
    vm.runInContext(fs.readFileSync(path.join(RAIZ, 'public', arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  return {
    contexto, chamadasRevisar,
    selo: porId.get('revisar-conta') || contexto.document.getElementById('revisar-conta'),
    dlg: contexto.document.getElementById('dialogo-revisar'),
    rv: contexto.document.getElementById('rv'),
    btnRevisar: contexto.document.getElementById('btn-revisar'),
  };
}

/** Deixa todas as promessas pendentes (fetch → json → desenho) assentarem. */
async function assentar() {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
}

const rodando = (id, titulo) => ({ id, titulo, projeto: 'proj-teste', estado: 'running', abas: [] });
const terminado = (id, titulo) => ({ id, titulo, projeto: 'proj-teste', estado: 'done', abas: [] });
const praRevisar = (id, titulo) => ({ id, titulo, projeto: 'proj-teste', estado: 'done', fim: '2026-10-09T12:00:00Z', temResultado: true, etiquetas: [] });

// ─── T0 — boot: a primeira leitura não é transição ───────────────────────────────────────

async function t0() {
  console.log('\nT0 — boot: a primeira leitura do tique é a linha de base, não transição');
  const cenario = { tudo: [rodando('j-a', 'Job A')], revisar: [] };
  const c = abrirCockpit(cenario);
  await assentar();
  ok(c.chamadasRevisar.length === 1, `só o contador do boot pede ?revisar=1 (pedidos: ${c.chamadasRevisar.length})`);
  // O mesmo `running` de novo: nada saiu, nada a pedir.
  await c.contexto.atualizarFaixaJobs();
  await assentar();
  ok(c.chamadasRevisar.length === 1, `job que continua rodando não dispara a rota (pedidos: ${c.chamadasRevisar.length})`);
}

// ─── T1 — o número do ícone sobe quando um job termina ────────────────────────────────────

async function t1() {
  console.log('\nT1 — job sai de running com a página aberta → o número do ícone sobe sem recarregar');
  const cenario = { tudo: [rodando('j-a', 'Job A')], revisar: [] };
  const c = abrirCockpit(cenario);
  await assentar();
  ok(c.selo.textContent === '0', `antes: o ícone mostra 0 (mostra "${c.selo.textContent}")`);

  cenario.tudo = [terminado('j-a', 'Job A')];
  cenario.revisar = [praRevisar('j-a', 'Job A')];
  await c.contexto.atualizarFaixaJobs();
  await assentar();
  ok(c.chamadasRevisar.length === 2, `a transição pede ?revisar=1 uma vez (pedidos: ${c.chamadasRevisar.length})`);
  ok(c.selo.textContent === '1', `depois: o ícone mostra 1 (mostra "${c.selo.textContent}")`);
  ok(c.selo.hidden === false, 'e o selo aparece');

  // O job sumiu da leitura (janela do fim feliz venceu): não é transição de novo.
  cenario.tudo = [];
  await c.contexto.atualizarFaixaJobs();
  await assentar();
  ok(c.chamadasRevisar.length === 2, `job que já saiu não dispara de novo (pedidos: ${c.chamadasRevisar.length})`);
}

// ─── T2 — a lista aberta ganha o job ──────────────────────────────────────────────────────

async function t2() {
  console.log('\nT2 — dialog aberto NA LISTA: o job que acabou de terminar aparece sem recarregar');
  const cenario = { tudo: [rodando('j-b', 'Job B novo')], revisar: [praRevisar('j-a', 'Job A velho')] };
  const c = abrirCockpit(cenario);
  await assentar();
  c.btnRevisar.onclick();
  await assentar();
  ok(c.dlg.open === true, 'o dialog abriu');
  ok(c.rv.textContent.includes('Job A velho') && !c.rv.textContent.includes('Job B novo'), 'antes: a lista tem só o Job A');

  cenario.tudo = [terminado('j-b', 'Job B novo')];
  cenario.revisar = [praRevisar('j-b', 'Job B novo'), praRevisar('j-a', 'Job A velho')];
  await c.contexto.atualizarFaixaJobs();
  await assentar();
  ok(c.rv.textContent.includes('Job B novo'), `depois: a lista aberta mostra o Job B (tela: "${c.rv.textContent.slice(0, 120)}…")`);
  ok(c.rv.textContent.includes('Job A velho'), 'e continua mostrando o Job A');
  ok(c.selo.textContent === '2', `e o ícone mostra 2 (mostra "${c.selo.textContent}")`);
}

// ─── T3 — erro de leitura no meio NÃO é transição ─────────────────────────────────────────

async function t3() {
  console.log('\nT3 — leitura que falha entre duas boas não dispara a rota cara');
  for (const falha of ['erro', 'sem-painel']) {
    const cenario = { tudo: [rodando('j-c', 'Job C')], revisar: [] };
    const c = abrirCockpit(cenario);
    await assentar();
    const antes = c.chamadasRevisar.length;

    cenario.tudo = falha; // `semNoticiaDosJobs()` zera `jobsRodando` — não pode virar "todos saíram"
    await c.contexto.atualizarFaixaJobs();
    await assentar();
    ok(c.chamadasRevisar.length === antes, `[${falha}] a leitura que falhou não pede ?revisar=1 (pedidos: ${c.chamadasRevisar.length - antes})`);

    cenario.tudo = [rodando('j-c', 'Job C')];
    await c.contexto.atualizarFaixaJobs();
    await assentar();
    ok(c.chamadasRevisar.length === antes, `[${falha}] a leitura boa seguinte, com o mesmo job rodando, também não (pedidos: ${c.chamadasRevisar.length - antes})`);
  }
}

// ─── T4 — a tela de um job aberta não é arrancada ─────────────────────────────────────────

async function t4() {
  console.log('\nT4 — dialog aberto na TELA DE UM JOB: não troca pela lista; o contador atualiza');
  const cenario = { tudo: [rodando('j-e', 'Job E')], revisar: [praRevisar('j-d', 'Job D lendo')] };
  const c = abrirCockpit(cenario);
  await assentar();
  c.btnRevisar.onclick();
  await assentar();
  const card = acharPorClasse(c.rv, 'rv-card');
  ok(Boolean(card), 'a lista tem o card do Job D');
  card.onclick({ target: { closest: () => null } });
  ok(Boolean(acharPorClasse(c.rv, 'rv-hero')), 'a tela do Job D abriu');

  cenario.tudo = [terminado('j-e', 'Job E')];
  cenario.revisar = [praRevisar('j-e', 'Job E'), praRevisar('j-d', 'Job D lendo')];
  await c.contexto.atualizarFaixaJobs();
  await assentar();
  ok(Boolean(acharPorClasse(c.rv, 'rv-hero')) && !c.rv.textContent.includes('Job E'),
    'a tela do Job D continua na vista (a lista não foi desenhada por cima)');
  ok(c.selo.textContent === '2', `o ícone atualiza mesmo assim: 2 (mostra "${c.selo.textContent}")`);
}

// ─── T3b — o job que terminou DURANTE a queda conta ───────────────────────────────────────

async function t3b() {
  console.log('\nT3b — boa {A} → erro → boa {} (A sumiu): dispara uma vez — o celular que volta do bolso');
  const cenario = { tudo: [rodando('j-a', 'Job A')], revisar: [] };
  const c = abrirCockpit(cenario);
  await assentar();
  const antes = c.chamadasRevisar.length;
  cenario.tudo = 'erro';
  await c.contexto.atualizarFaixaJobs();
  await assentar();
  // Sumiu de vez (a janela do fim feliz venceu enquanto a página não lia): não aparece nem como `done`.
  cenario.tudo = [];
  cenario.revisar = [praRevisar('j-a', 'Job A')];
  await c.contexto.atualizarFaixaJobs();
  await assentar();
  ok(c.chamadasRevisar.length === antes + 1, `a leitura boa sem o Job A pede ?revisar=1 uma vez (pedidos: ${c.chamadasRevisar.length - antes})`);
  ok(c.selo.textContent === '1', `e o ícone mostra 1 (mostra "${c.selo.textContent}")`);
}

// ─── T5 — corrida: o dono toca um card enquanto a releitura corre ───────────────────────

async function t5() {
  console.log('\nT5 — releitura silenciosa em voo: tocar um card abre o relatório certo e a lista não cai por cima');
  const cenario = { tudo: [rodando('j-f', 'Job F novo')], revisar: [praRevisar('j-d', 'Job D lendo')] };
  const c = abrirCockpit(cenario);
  await assentar();
  c.btnRevisar.onclick();
  await assentar();

  // A rota responde; os `result.md` ficam presos — é a janela em que o cache estaria vazio.
  cenario.segurarResultado = true;
  cenario.tudo = [terminado('j-f', 'Job F novo')];
  cenario.revisar = [praRevisar('j-f', 'Job F novo'), praRevisar('j-d', 'Job D lendo')];
  const antes = c.chamadasRevisar.length;
  await c.contexto.atualizarFaixaJobs();
  await assentar();
  ok(c.chamadasRevisar.length > antes, `a transição relê a lista aberta (pedidos: ${c.chamadasRevisar.length - antes})`);
  ok(!c.rv.textContent.includes('Carregando'), 'releitura silenciosa: a lista NÃO vira "Carregando…"');
  const card = acharTodosPorClasse(c.rv, 'rv-card').find((n) => n.dataset.id === 'j-d');
  ok(Boolean(card), 'o card do Job D continua na vista, clicável');
  if (!card) return;
  card.onclick({ target: { closest: () => null } });
  ok(Boolean(acharPorClasse(c.rv, 'rv-hero')), 'a tela do Job D abriu');
  ok(!c.rv.textContent.includes('não consegui ler o relatório'),
    'e mostra o relatório que já se sabia, não "não consegui ler o relatório" (cache não zerado antes do await)');

  cenario.segurarResultado = false;
  cenario.resultadosPresos.splice(0).forEach((soltar) => soltar());
  await assentar();
  ok(Boolean(acharPorClasse(c.rv, 'rv-hero')) && !acharPorClasse(c.rv, 'rv-filtros'),
    'a releitura aterrissou e a tela do Job D continua na vista (lista não desenhada por cima)');
  const voltar = acharPorClasse(c.rv, 'voltar-rv');
  ok(Boolean(voltar), 'a tela do job tem o "‹ Pra revisar"');
  if (!voltar) return;
  voltar.onclick();
  ok(c.rv.textContent.includes('Job F novo'), 'e o "‹ Pra revisar" já mostra a lista nova, com o Job F');
}

// ─── T6 — fechar na tela do job e reabrir mostra a lista ─────────────────────────────────

async function t6() {
  console.log('\nT6 — tela de um job → fechar → reabrir pelo botão: a lista aparece (não fica em "Carregando…")');
  const cenario = { tudo: [rodando('j-g', 'Job G')], revisar: [praRevisar('j-d', 'Job D lendo')] };
  const c = abrirCockpit(cenario);
  await assentar();
  c.btnRevisar.onclick();
  await assentar();
  const card = acharPorClasse(c.rv, 'rv-card');
  ok(Boolean(card), 'a lista tem o card do Job D');
  if (!card) return;
  card.onclick({ target: { closest: () => null } });
  fecharDialog(c);
  await assentar();
  c.btnRevisar.onclick();
  await assentar();
  ok(Boolean(acharPorClasse(c.rv, 'rv-filtros')) && !c.rv.textContent.includes('Carregando'),
    `reaberto, o dialog mostra a lista (tela: "${c.rv.textContent.slice(0, 80)}…")`);
}

// ─── T7 — a releitura silenciosa que falha não apaga o que se sabe ────────────────────────

async function t7() {
  console.log('\nT7 — releitura silenciosa que falha: a lista e o filtro escolhido ficam');
  for (const falha of ['throw', 'habilitado-false', 'erro']) {
    const cenario = { tudo: [rodando('j-h', 'Job H')], revisar: [praRevisar('j-a', 'Job A velho')] };
    const c = abrirCockpit(cenario);
    await assentar();
    c.btnRevisar.onclick();
    await assentar();
    const prontos = acharTodosPorClasse(c.rv, 'rv-filtro')[1];
    if (prontos) prontos.onclick();
    const antes = c.chamadasRevisar.length;
    cenario.falhaRevisar = falha;
    cenario.tudo = [terminado('j-h', 'Job H')];
    await c.contexto.atualizarFaixaJobs();
    await assentar();
    ok(c.chamadasRevisar.length > antes, `[${falha}] a transição tentou reler (pedidos: ${c.chamadasRevisar.length - antes})`);
    ok(c.rv.textContent.includes('Job A velho') && !/não consegui|não deu para ler/.test(c.rv.textContent),
      `[${falha}] a lista que estava na vista continua, sem mensagem de erro por cima`);
    ok(filtroApertado(c) === 'Prontos', `[${falha}] o filtro Prontos continua apertado (está "${filtroApertado(c)}")`);
  }

  console.log('\nT7b — releitura silenciosa com a lista principal vazia e sumidas: o filtro NÃO pula para Atenção');
  const cenario = { tudo: [rodando('j-i', 'Job I')], revisar: [praRevisar('j-a', 'Job A velho')] };
  const c = abrirCockpit(cenario);
  await assentar();
  c.btnRevisar.onclick();
  await assentar();
  cenario.tudo = [terminado('j-i', 'Job I')];
  cenario.revisar = [];
  cenario.atencao = [{ ...praRevisar('j-s', 'Job S sumido'), etiquetas: ['branch-sumiu'] }];
  await c.contexto.atualizarFaixaJobs();
  await assentar();
  ok(c.rv.textContent.includes('Em Atenção: 1'), 'a releitura aterrissou (a lista diz "Em Atenção: 1")');
  ok(filtroApertado(c) === 'Todos', `o filtro continua em Todos (está "${filtroApertado(c)}")`);
}

// ─── T8 — contador: resposta velha não volta o número ─────────────────────────────────────

async function t8() {
  console.log('\nT8 — duas leituras do contador em voo: a velha aterrissa por último e NÃO volta o número');
  const cenario = { tudo: [], revisar: [], segurarRevisar: true };
  const c = abrirCockpit(cenario); // boot: pedido 1 preso, com 0 jobs
  await assentar();
  cenario.revisar = [praRevisar('j-a', 'Job A')];
  fecharDialog(c); // `close` → pedido 2 preso, com 1 job
  await assentar();
  ok(cenario.revisarPresos.length === 2, `dois pedidos do contador em voo (presos: ${cenario.revisarPresos.length})`);
  const [velho, novo] = cenario.revisarPresos.splice(0);
  if (!velho || !novo) return;
  novo();
  await assentar();
  ok(c.selo.textContent === '1', `a leitura nova aterrissa: 1 (mostra "${c.selo.textContent}")`);
  velho();
  await assentar();
  ok(c.selo.textContent === '1', `a velha aterrissa depois e o ícone continua 1 (mostra "${c.selo.textContent}")`);
}

// ─── T9 — o job termina com a abertura AINDA carregando ───────────────────────────────────

async function t9() {
  console.log('\nT9 — transição com a abertura em voo ("Carregando…"): a tela nunca fica presa');
  for (const desfecho of ['falha', 'sucesso']) {
    const cenario = { tudo: [rodando('j-k', 'Job K novo')], revisar: [praRevisar('j-a', 'Job A velho')] };
    const c = abrirCockpit(cenario);
    await assentar();
    cenario.segurarRevisar = true;
    c.btnRevisar.onclick(); // a abertura fica presa, com a lista de ANTES do Job K terminar
    await assentar();
    ok(c.rv.textContent.includes('Carregando'), `[${desfecho}] a abertura está em "Carregando…"`);

    // O Job K termina enquanto isso; as leituras novas respondem na hora.
    cenario.segurarRevisar = false;
    cenario.tudo = [terminado('j-k', 'Job K novo')];
    cenario.revisar = [praRevisar('j-k', 'Job K novo'), praRevisar('j-a', 'Job A velho')];
    if (desfecho === 'falha') cenario.falhaRevisar = 'throw';
    await c.contexto.atualizarFaixaJobs();
    await assentar();
    cenario.revisarPresos.splice(0).forEach((soltar) => soltar()); // a abertura velha aterrissa por último
    await assentar();

    ok(!c.rv.textContent.includes('Carregando'), `[${desfecho}] a tela não ficou presa em "Carregando…" (tela: "${c.rv.textContent.slice(0, 60)}…")`);
    if (desfecho === 'falha') {
      ok(c.rv.textContent.includes('não consegui ler a lista'), '[falha] a falha é dita na tela, como em toda abertura');
    } else {
      ok(c.rv.textContent.includes('Job K novo'), '[sucesso] a lista mostra o Job K (a abertura velha, sem ele, não desenhou por cima)');
    }
  }
}

(async () => {
  console.log('gate-revisar-transicao — o Pra revisar acompanha o job que termina');
  for (const t of [t0, t1, t2, t3, t3b, t4, t5, t6, t7, t8, t9]) {
    try { await t(); } catch (e) { ok(false, `${t.name} estourou: ${e && e.stack}`); }
  }
  console.log(falhas ? `\n❌ ${falhas} falha(s)` : '\n✅ tudo verde');
  process.exit(falhas ? 1 : 0);
})();
