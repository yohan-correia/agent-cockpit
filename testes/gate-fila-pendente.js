#!/usr/bin/env node
'use strict';
// GATE — a mensagem na fila sobrevive à reconexão do EventSource (card
// `mensagem-na-fila-some-da-fita`, spec/plano de 2026-09-05).
//
// Dois defeitos, mesma raiz: a bolha pendente só existia na MEMÓRIA da página.
//
//   A (sumiço)   — o `sessao` da reconexão zera `pendentes` (public/app.js:770/841) e o
//                  servidor nunca soube o que digitou por `send-keys`: a mensagem enfileirada
//                  não existe em lugar nenhum fora da aba que a mandou.
//   B (duplicata)— `MS_PENDENTE` (60s) mede tempo de PAREDE; um turno de Opus mais longo do
//                  que isso expira a pendente antes do `humano` voltar do disco, e a mesma
//                  mensagem vira bolha duas vezes.
//
// Duas partes, no molde de gate-ui.js/gate-troca-arquivo.js — nenhuma gasta token da
// assinatura (armadilha #20): a parte 1 é OFFLINE (cliente num DOM de mentira + lib/abas.js
// com o tmux dublado); a parte 2 fala com um `server.js` de verdade, mas com `lib/abas`
// trocado no `require.cache` e sem nenhum `claude` real por perto.
//
// Uso:  node testes/gate-fila-pendente.js          (parte 1, offline)
//       node testes/gate-fila-pendente.js parte2   (parte 2, sobe o servidor na PORT)
//
// A raiz do repositório é PARAMETRIZÁVEL (`RAIZ=<caminho>`): é o que permite provar que a
// Fase 0 reprova contra o `develop` — rodando este MESMO arquivo com `RAIZ` apontada para uma
// cópia limpa do código velho, ele carrega o `public/app.js`, o `server.js` e o `lib/abas.js`
// de LÁ, com as asserções de HOJE. Sem trocar `RAIZ`, a raiz é a desta worktree.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

const RAIZ = process.env.RAIZ ? path.resolve(process.env.RAIZ) : path.resolve(__dirname, '..');
const PORTA = Number(process.env.PORT || 7896);

// ─── o placar ──────────────────────────────────────────────────────────────
//
// CONTADOR de falhas, não booleano: um booleano travado em `true` pela primeira falha faria
// TODO bloco seguinte que passasse deixar de entrar em `CASOS`, e a distinção "não rodou" ×
// "rodou e falhou" (que a Fase 2 promete) viraria ruído. Comparando o contador antes/depois
// de cada `bloco`, cada um é julgado só pelas próprias asserções.
//
// Checklist FECHADO — 46 blocos (29 na parte 1 + 17 na parte 2; plano §5.2/§Passo 2.1,
// reduzido em 2026-09-05 depois do achado sobre `tmux()`). O nome só entra em `CASOS` DEPOIS
// que todas as asserções do bloco passaram: registrar na entrada provaria só que a função
// rodou, e um bloco que estourasse no meio contaria como executado. Ao fim de cada parte, o
// próprio gate compara contra a lista fechada e sai com código 1 se algum não rodou — contar
// '✅' na saída seria frágil e não é gate.
//
// `rollback-no-primeiro-send-keys` e `rollback-no-enter` SAÍRAM do inventário, e não foram
// substituídos. `tmux()` (`lib/abas.js:114-121`) é LENIENTE por desenho (ARMADILHA #3): erro
// de comando vira `''` no retorno, nunca uma rejeição — então o `try/catch` de `digitarNaAba`
// nunca é alcançado por uma falha de tmux. A substituta cogitada ("execFile estourando de
// forma síncrona, alvo inválido ou argumento que não é string") também não é exercitável
// honestamente: `args` em `tmux()` é sempre um array literal e `options` é sempre o mesmo
// objeto hardcoded — não há entrada real que chegue lá torta. Comprovado por repro isolada
// (`node -e`) em vez de assumido: `execFile` só lança de forma síncrona se `args` não for
// array ou se uma opção como `timeout` tiver tipo errado; um elemento individual do array
// que não seja string (`undefined`, número, objeto) é apenas convertido para texto e NUNCA
// derruba a chamada. O `try/catch`/`esquecerPendente` continua no código — é o que sobra de
// pé se `tmux()` mudar de leniente para estrito um dia —, só sem um bloco de gate fingindo
// prová-lo hoje.
const CASOS_ESPERADOS_PARTE1 = [
  // cliente (17)
  'dup-turno-longo', 'sessao-limpa-pendente', 'ociosa-vence-61s', 'ociosa-viva-59s',
  'ocupado-true-zera', 'ocupado-false-reabre', 'ociosidade-nao-acumula', 'turno-longo-nao-vence',
  'nenhuma-conta-usa-em', 'vencida-perde-marcas', 'dedupe-por-id', 'id-repetido-engole',
  'textos-iguais-ids-diferentes', 'soltou-nao-absorve', 'soltou-deduplica',
  '409-solta-o-selo', '409-reenvio-mesmo-texto',
  // lib/abas.js puro (8)
  'registro-basico', 'consome-uma-so', 'historico-velho-nao-consome', 'quando-invalido-nao-consome',
  'teto-31min-poda', 'esquecer-no-matar', 'endswith-com-rascunho', 'endswith-com-cabecalho-de-anexo',
  // `enviar` REAL, só o tmux dublado (4)
  'registra-antes-do-send-keys', 'nao-registra-se-recusa',
  'ficha-devolvida-e-a-registrada', 'corrida-aceita-congelada',
];
const CASOS_ESPERADOS_PARTE2 = [
  // encanamento SSE (17)
  'abertura-depois-do-sincronizado', 'post-durante-carga-inicial', 'turno-nao-traz-pendente',
  'disco-consome-antes-de-reemitir', 'geracao-velha-nao-consome', 'clear-manda-sincronizado',
  'clear-ordem-dos-indices', 'pendente-atravessa-clear', 'aviso-ao-vivo', 'envio-que-falha-nao-avisa',
  'broadcast-tardio', 'corrida-do-card', 'off-do-barramento', 'id-torto-400', 'sem-id-202',
  'id-do-202-e-o-mandado', 'quando-repassado-na-leitura-real',
];

/** Reprova por DOIS motivos distintos e nomeados — "não rodou" e "rodou e falhou" nunca se
 * confundem no relatório: contar '✅' na saída seria frágil e não é gate. */
function conferirInventario(esperados) {
  const faltaram = esperados.filter((c) => !CASOS.has(c));
  for (const c of faltaram) {
    falhas += 1;
    console.log(`  ❌ o caso "${c}" NÃO RODOU (nem passou, nem falhou — está ausente)`);
  }
  return faltaram;
}

let falhas = 0;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };

const CASOS = new Set();
async function bloco(nome, fn) {
  const antes = falhas;
  try {
    await fn();
  } catch (e) {
    falhas += 1;
    console.log(`  ❌ ${nome} estourou: ${e && e.message}`);
  }
  if (falhas === antes) CASOS.add(nome);
}

// ─── o cliente, num DOM de mentira ───────────────────────────────────────────
//
// Molde: `carregarCliente()` de testes/gate-ui.js:195. Trimmado do que só o painel de
// configuração e o uso.js encostam — aqui só entra o que `public/app.js` toca ao carregar e
// o que os blocos desta fila precisam (fita, entrada, fetch, EventSource).

function textoDe(no) {
  if (no.tag === '#texto') return no.valor;
  return no.filhos.map(textoDe).join('') || no._texto || '';
}

function casaSeletor(el, seletor) {
  const classe = seletor.match(/^\.([\w-]+)$/);
  if (classe) return String(el.className || '').split(/\s+/).includes(classe[1]);
  const atributo = seletor.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (!atributo) return false;
  const chave = atributo[1].replace(/^data-/, '').replace(/-([a-z])/g, (m, c) => c.toUpperCase());
  const valor = (el.dataset || {})[chave];
  return valor !== undefined && (atributo[2] === undefined || String(valor) === atributo[2]);
}

function buscarNaArvore(no, seletor, achados) {
  for (const filho of no.filhos || []) {
    if (filho.tag !== '#texto' && casaSeletor(filho, seletor)) achados.push(filho);
    buscarNaArvore(filho, seletor, achados);
  }
  return achados;
}

function criarElemento(tag, dono = null) {
  const el = {
    tag,
    filhos: [],
    pai: null,
    atributos: {},
    style: {
      cssText: '',
      setProperty(nome, valor) { this[nome] = String(valor); },
      removeProperty(nome) { delete this[nome]; },
      getPropertyValue(nome) { return this[nome] ?? ''; },
    },
    scrollTop: 0,
    scrollHeight: 0,
    scrollLeft: 0,
    clientHeight: 0,
    alturaAoPintar: null,
    dataset: {},
    className: '',
    hidden: false,
    disabled: false,
    open: false,
    // Campos de <textarea>/<input> — mesmo motivo de testes/gate-ui.js:84 (a caixa de
    // escrita passa a nascer de `createElement` dentro de `criarPainel`; sem `value: ''`
    // o gate estoura com TypeError dentro de um handler).
    value: '',
    placeholder: '',
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange(a, b) { el.selectionStart = a; el.selectionEnd = b; },
    files: [],
    _texto: '',
    get textContent() { return textoDe(el); },
    set textContent(valor) {
      el.filhos = [];
      el._texto = String(valor);
      el.scrollTop = 0;
      el.scrollLeft = 0;
      if (el.alturaAoPintar !== null) el.scrollHeight = el.alturaAoPintar;
    },
    append(...nos) {
      for (const no of nos) {
        const filho = typeof no === 'string' ? { tag: '#texto', valor: no } : no;
        filho.pai = el;
        el.filhos.push(filho);
      }
    },
    appendChild(no) { el.append(no); return no; },
    // `class` sincroniza com `.className` — os ícones dos painéis (split view, fase 2)
    // nascem `<svg>` e usam `setAttribute('class', ...)`, nunca `.className =` (getter-only
    // em SVG, sob `'use strict'`). Mesmo ajuste de `testes/gate-ui.js`.
    setAttribute(chave, valor) {
      el.atributos[chave] = String(valor);
      if (chave === 'class') el.className = String(valor);
    },
    getAttribute(chave) { return el.atributos[chave]; },
    removeAttribute(chave) { delete el.atributos[chave]; },
    ouvintes: new Map(),
    addEventListener(tipo, fn) {
      if (!el.ouvintes.has(tipo)) el.ouvintes.set(tipo, []);
      el.ouvintes.get(tipo).push(fn);
    },
    removeEventListener(tipo, fn) {
      el.ouvintes.set(tipo, (el.ouvintes.get(tipo) || []).filter((f) => f !== fn));
    },
    disparar(tipo, evento = {}) {
      for (const fn of el.ouvintes.get(tipo) || []) fn(evento);
      return evento;
    },
    // `document.activeElement` de verdade — mesmo motivo de testes/gate-ui.js:113 (a paleta,
    // o `fecharPainel` condicional e o destino do `paste` dependem de saber quem tem o cursor).
    focus() {
      if (dono) {
        const antigo = dono.activeElement;
        if (antigo && antigo !== el) antigo.disparar?.('blur', {});
        dono.activeElement = el;
      }
      el.disparar('focus', {});
    },
    remove() {
      // Como no navegador: tirar da árvore o nó focado devolve o foco ao documento — mesmo
      // motivo de testes/gate-ui.js:114.
      if (dono) {
        for (let n = dono.activeElement; n; n = n.pai) {
          if (n === el) { dono.activeElement = null; break; }
        }
      }
      if (!el.pai) return;
      el.pai.filhos = el.pai.filhos.filter((f) => f !== el);
      el.pai = null;
    },
    scrollIntoView() {},
    showModal() { el.open = true; },
    close() { el.open = false; },
    querySelector(seletor) { return buscarNaArvore(el, seletor, [])[0] || null; },
    querySelectorAll(seletor) { return buscarNaArvore(el, seletor, []); },
    get lastChild() { return el.filhos[el.filhos.length - 1] || null; },
    get children() { return el.filhos.filter((f) => f.tag !== '#texto'); },
  };
  return el;
}

function memoria() {
  const dados = new Map();
  return {
    getItem: (k) => (dados.has(k) ? dados.get(k) : null),
    setItem: (k, v) => dados.set(k, String(v)),
    removeItem: (k) => dados.delete(k),
    _dados: dados,
  };
}

// Split view, fase 2 (mesmo ajuste de testes/gate-ui.js, §5.5 da spec): estes ids viraram
// elemento de painel, achados por classe DENTRO do painel — nunca mais `getElementById` solto.
const IDS_DO_PAINEL = new Set([
  'chat-topo', 'chat-titulo', 'chat-caminho', 'chat-agente', 'aviso-agente', 'btn-voltar',
  'medidor', 'medidor-trilho', 'medidor-cheio', 'medidor-modelo', 'medidor-effort',
  'medidor-pct', 'faixa-jobs', 'faixa-pino', 'faixa-conta', 'faixa-titulos', 'faixa-etapa',
  'btn-parar', 'parar-rotulo', 'btn-recarregar-conversa', 'btn-matar-aba',
  'mensagens', 'puxar-selo', 'fita', 'pergunta', 'pergunta-tela', 'pergunta-teclas',
  'tecla-left', 'tecla-up', 'tecla-down', 'tecla-right', 'tecla-enter', 'tecla-esc',
  // Caixa de envio por painel (2026-09-09, fase 2 do plano): a caixa deixa de ser única e
  // vira DOM do painel do botão, por classe — na ordem em que aparecem na árvore (§3.1 da
  // spec). `envio-para` NÃO entra — deixa de existir (D42).
  'envio', 'paleta', 'anexos', 'btn-anexar', 'inp-arquivo', 'entrada', 'btn-enviar', 'dica',
]);

function painelDe(cliente, i = 0) {
  const caixa = cliente.porId.get('paineis') || cliente.document.getElementById('paineis');
  return caixa.querySelectorAll('.painel')[i] || null;
}

function porIdDe(cliente, id, i = 0) {
  if (IDS_DO_PAINEL.has(id)) {
    const p = painelDe(cliente, i);
    if (p) return p.querySelector(`.${id}`);
  }
  return cliente.porId.get(id) || cliente.document.getElementById(id);
}

/** Carrega public/app.js (da RAIZ) num sandbox e devolve as funções de topo dele. */
function carregarClienteFila({ urlInicial = 'http://z/', guardado = memoria(), aoBuscar = null, semPainel = false } = {}) {
  const codigo = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');
  const porId = new Map();
  const ouvintes = new Map();
  const relogios = new Map();
  const fluxos = [];
  const janela = new Map();
  const midia = { '(pointer: coarse)': false, '(display-mode: standalone)': false, '(max-width: 760px)': false };
  let proximoRelogio = 0;
  const contexto = {
    document: {
      // Quem tem o cursor agora — mesmo motivo de testes/gate-ui.js:359.
      activeElement: null,
      getElementById: (id) => {
        if (!porId.has(id)) porId.set(id, criarElemento('div', contexto.document));
        return porId.get(id);
      },
      createElement: (tag) => criarElemento(tag, contexto.document),
      createElementNS: (ns, tag) => criarElemento(tag, contexto.document),
      createDocumentFragment: () => criarElemento('#fragmento'),
      createTextNode: (valor) => ({ tag: '#texto', valor: String(valor), filhos: [], get data() { return this.valor; }, set data(v) { this.valor = String(v); } }),
      addEventListener: (tipo, fn) => {
        if (!ouvintes.has(tipo)) ouvintes.set(tipo, []);
        ouvintes.get(tipo).push(fn);
      },
      hidden: false,
      documentElement: criarElemento('html'),
    },
    localStorage: guardado,
    location: {
      href: urlInicial,
      origin: new URL(urlInicial).origin,
      pathname: new URL(urlInicial).pathname,
      search: new URL(urlInicial).search,
      hash: new URL(urlInicial).hash,
      hostname: new URL(urlInicial).hostname,
    },
    history: {
      pilha: [{ estado: null, url: urlInicial }],
      saiuDoApp: false,
      pushState: (estado, titulo, url) => {
        contexto.history.pilha.push({ estado, url: url == null ? contexto.location.href : String(url) });
        if (url != null) irPara(url);
      },
      replaceState: (estado, titulo, url) => {
        const topo = contexto.history.pilha[contexto.history.pilha.length - 1];
        topo.estado = estado;
        if (url != null) { topo.url = String(url); irPara(url); }
      },
      back: () => {
        if (contexto.history.pilha.length <= 1) { contexto.history.saiuDoApp = true; return; }
        contexto.history.pilha.pop();
        const topo = contexto.history.pilha[contexto.history.pilha.length - 1];
        irPara(topo.url);
        for (const fn of janela.get('popstate') || []) fn({ state: topo.estado });
      },
    },
    URL,
    URLSearchParams,
    navigator: { userAgent: 'gate-fila-pendente/1.0 (sem navegador de verdade)' },
    window: {
      addEventListener: (tipo, fn) => {
        if (!janela.has(tipo)) janela.set(tipo, []);
        janela.get(tipo).push(fn);
      },
      open: () => {},
    },
    atob: (t) => Buffer.from(t, 'base64').toString('binary'),
    Uint8Array,
    CSS: { escape: (s) => s },
    matchMedia: (consulta) => ({
      matches: Boolean(midia[String(consulta)]),
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    fetch: async (rota, opcoes = {}) => {
      const corpo = aoBuscar ? await aoBuscar(String(rota), opcoes) : { abas: [] };
      const status = corpo && typeof corpo === 'object' && corpo.__status ? Number(corpo.__status) : 200;
      return { ok: status < 400, status, json: async () => corpo };
    },
    EventSource: function EventSource(rota) {
      const es = { rota: String(rota), fechado: false, close() { es.fechado = true; } };
      fluxos.push(es);
      return es;
    },
    setInterval: (fn, ms) => {
      proximoRelogio += 1;
      relogios.set(proximoRelogio, { fn, ms });
      return proximoRelogio;
    },
    setTimeout: () => 0,
    clearInterval: (id) => { relogios.delete(id); },
    clearTimeout: () => {},
    console,
    alert: () => {},
    confirm: () => false,
  };
  function irPara(url) {
    const u = new URL(String(url), contexto.location.href);
    Object.assign(contexto.location, {
      href: u.href, origin: u.origin, pathname: u.pathname, search: u.search,
      hash: u.hash, hostname: u.hostname,
    });
  }
  vm.createContext(contexto);
  for (const arquivo of ['traducoes.js', 'i18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(RAIZ, 'public', arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  vm.runInContext(codigo, contexto, { filename: 'app.js' });
  contexto.porId = porId;
  contexto.fluxos = fluxos;
  // Split view, fase 2 (mesmo ajuste de testes/gate-ui.js, §2.5 da spec): sem isto,
  // `aplicar(evento)` cairia em `paineis.get(null)` e os blocos que chamam `.aplicar`/
  // `.marcarPendente`/etc. direto (sem passar por `abrirAba`) reprovariam em bloco.
  if (!semPainel) {
    const painelInicial = contexto.criarPainel('aba-7', {});
    contexto.focar(painelInicial);
  }
  return contexto;
}

/** As bolhas `bolha-eu` de dentro de um elemento de fita. */
const bolhasDe = (f) => f.filhos.filter((x) => String(x.className).includes('bolha-eu'));

/**
 * `lib/abas.js` FRESCO (molde: `delete require.cache` de gate-uso.js) — cada bloco de L1-L8
 * precisa do seu próprio `pendentesPorAba`, senão a entrada de um bloco vaza para o
 * seguinte e a contagem de `pendentesDe` mentiria.
 */
function carregarAbasFresco() {
  const caminho = path.join(RAIZ, 'lib', 'abas.js');
  delete require.cache[require.resolve(caminho)];
  return require(caminho);
}

// ─── parte 1 — offline (cliente) ─────────────────────────────────────────────

async function parteUm() {
  await bloco('dup-turno-longo', async () => {
    // Defeito B do card: `MS_PENDENTE` mede tempo de PAREDE. Um turno de Opus de 5 minutos
    // já é maior que os 60s — a pendente vence ANTES do `humano` voltar do disco, e a mesma
    // mensagem vira bolha duas vezes. Contra o `develop`, isto reproduz 2 bolhas; consertado
    // (a validade passa a medir OCIOSIDADE, D-d), a mesma sequência dá 1.
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const texto = 'roda os testes';
    const emUmVeioVeoAtras = Date.now() - 5 * 60 * 1000;
    env.marcarPendente(env.bolha('bolha-eu', texto, emUmVeioVeoAtras), texto, emUmVeioVeoAtras, true);
    env.marcarOcupado(env.painelAtual(), true);
    env.aplicar({ tipo: 'humano', texto });
    ok(bolhasDe(fitaEnv).length === 1,
      `turno de 5min ainda rodando: 1 bolha só, não duplica (achei ${bolhasDe(fitaEnv).length})`);
  });

  await bloco('sessao-limpa-pendente', async () => {
    // Documental (D-e): `limparFita()` continua zerando `pendentes`. Verdadeiro ANTES e
    // DEPOIS do conserto — trava contra alguém "consertar" o defeito A preservando estado
    // no cliente, que reintroduziria o invariante quebrado do README (§1.5 da spec).
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const texto = 'sera que fica';
    env.marcarPendente(env.bolha('bolha-eu', texto), texto);
    ok(bolhasDe(fitaEnv).length === 1, 'a bolha pendente nasceu na fita');
    env.limparFita();
    ok(fitaEnv.filhos.length === 0, 'limparFita() esvazia a fita');
    // Se `pendentes` não tivesse sido esvaziado junto, este `humano` absorveria a ficha
    // velha (desenhada num nó que já não existe) e NENHUMA bolha nova apareceria aqui —
    // que é exatamente o defeito A: a mensagem "sumida" sem voltar a lugar nenhum.
    env.aplicar({ tipo: 'humano', texto });
    ok(bolhasDe(fitaEnv).length === 1,
      'e o `humano` seguinte desenha bolha NOVA — pendentes não sobrevive ao sessao/clear');
  });

  // ─── a validade por OCIOSIDADE (D-d) ───────────────────────────────────────

  await bloco('ociosa-vence-61s', async () => {
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const texto = 'ping';
    const el = env.marcarPendente(env.bolha('bolha-eu', texto), texto);
    el.fichaPendente.ocioso = Date.now() - 61000;
    env.aplicar({ tipo: 'humano', texto });
    ok(!String(el.className).includes('bolha-pendente'), 'ociosa há 61s: venceu, não absorve');
    ok(bolhasDe(fitaEnv).length === 2, 'e o `humano` desenha bolha NOVA — a antiga fica, desmarcada');
  });

  await bloco('ociosa-viva-59s', async () => {
    // A borda: sem este bloco ao lado do de cima, uma regra "sempre vence" passaria no de
    // cima sozinho.
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const texto = 'ping';
    const el = env.marcarPendente(env.bolha('bolha-eu', texto), texto);
    el.fichaPendente.ocioso = Date.now() - 59000;
    env.aplicar({ tipo: 'humano', texto });
    ok(bolhasDe(fitaEnv).length === 1, 'ociosa há 59s: ainda viva, absorve (1 bolha só)');
  });

  await bloco('ocupado-true-zera', async () => {
    const env = carregarClienteFila();
    const elA = env.marcarPendente(env.bolha('bolha-eu', 'a'), 'a');
    const elB = env.marcarPendente(env.bolha('bolha-eu', 'b'), 'b');
    elA.fichaPendente.ocioso = Date.now() - 5000;
    elB.fichaPendente.ocioso = Date.now() - 5000;
    env.marcarOcupado(env.painelAtual(), true);
    ok(elA.fichaPendente.ocioso === null && elB.fichaPendente.ocioso === null,
      'marcarOcupado(true) zera o `ocioso` de TODAS as pendentes vivas');
  });

  await bloco('ocupado-false-reabre', async () => {
    const env = carregarClienteFila();
    // `elA` representa uma ficha nascida DURANTE um turno (ocioso null); `elB` já estava
    // contando ociosidade de um turno anterior — `marcarOcupado(false)` não pode perturbá-la.
    const elA = env.marcarPendente(env.bolha('bolha-eu', 'a'), 'a');
    elA.fichaPendente.ocioso = null;
    const elB = env.marcarPendente(env.bolha('bolha-eu', 'b'), 'b');
    const jaContando = Date.now() - 3000;
    elB.fichaPendente.ocioso = jaContando;
    env.marcarOcupado(env.painelAtual(), false);
    ok(elA.fichaPendente.ocioso !== null, 'a que estava `null` (turno) ganha `ocioso` agora');
    ok(elB.fichaPendente.ocioso === jaContando, 'e a que já contava não é perturbada');
  });

  await bloco('ociosidade-nao-acumula', async () => {
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const texto = 'ping';
    const el = env.marcarPendente(env.bolha('bolha-eu', texto), texto);
    el.fichaPendente.ocioso = Date.now() - 59000;   // quase vencendo
    env.marcarOcupado(env.painelAtual(), true);    // zera (D-d: turno começando é trabalho, não espera)
    env.marcarOcupado(env.painelAtual(), false);   // reabre a janela — o relógio da ociosidade REINICIA
    el.fichaPendente.ocioso = Date.now() - 1000;   // só 1s de ociosidade "nova"
    env.aplicar({ tipo: 'humano', texto });
    ok(bolhasDe(fitaEnv).length === 1,
      '59s + turno + 1s NÃO acumula: absorve — a ociosidade é contínua, não somada');
  });

  await bloco('turno-longo-nao-vence', async () => {
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const texto = 'ping';
    const emAntigo = Date.now() - 45 * 60 * 1000;
    env.marcarPendente(env.bolha('bolha-eu', texto, emAntigo), texto, emAntigo, true);
    env.marcarOcupado(env.painelAtual(), true);   // ocioso = null e fica null o turno inteiro
    env.aplicar({ tipo: 'humano', texto });
    ok(bolhasDe(fitaEnv).length === 1,
      'turno de 45min, ocupada o tempo todo: absorve — é o defeito B pela escala que o painel apontou');
  });

  await bloco('nenhuma-conta-usa-em', async () => {
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const emVelho = Date.now() - 2 * 60 * 60 * 1000;
    const emNovo = Date.now();
    const ocioso = Date.now() - 5000;
    const elVelho = env.marcarPendente(env.bolha('bolha-eu', 'a', emVelho), 'a', emVelho);
    const elNovo = env.marcarPendente(env.bolha('bolha-eu', 'b', emNovo), 'b', emNovo);
    elVelho.fichaPendente.ocioso = ocioso;
    elNovo.fichaPendente.ocioso = ocioso;
    env.aplicar({ tipo: 'humano', texto: 'a' });
    env.aplicar({ tipo: 'humano', texto: 'b' });
    ok(!String(elVelho.className).includes('bolha-pendente') && !String(elNovo.className).includes('bolha-pendente'),
      'as duas absorvem igual — `em` de 2h atrás não muda nada, só `ocioso` decide');
    ok(bolhasDe(fitaEnv).length === 2, 'e nenhuma bolha a mais nasceu (as duas foram absorvidas)');
  });

  await bloco('vencida-perde-marcas', async () => {
    const env = carregarClienteFila();
    const texto = 'sumiu';
    const el = env.marcarPendente(env.bolha('bolha-eu', texto), texto, Date.now(), true);
    el.fichaPendente.ocioso = Date.now() - 61000;
    env.aplicar({ tipo: 'humano', texto });
    ok(!String(el.className).includes('bolha-pendente'), 'vencida por OCIOSIDADE: perde `bolha-pendente`');
    ok(el.dataset.fila === undefined, 'e perde `data-fila` — o contrato é visual, não o retorno da função');
  });

  // ─── a dedupe por `id` (D-m/D-n) ────────────────────────────────────────────

  await bloco('dedupe-por-id', async () => {
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    env.marcarPendente(env.bolha('bolha-eu', 'oi'), 'oi', Date.now(), false, 'a1');
    env.aplicar({ tipo: 'pendente', id: 'a1', texto: 'oi', mensagem: 'oi', em: Date.now() });
    ok(bolhasDe(fitaEnv).length === 1, 'ficha `id: a1` já viva: o aviso com o MESMO id não desenha 2ª bolha');
  });

  await bloco('id-repetido-engole', async () => {
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    env.marcarPendente(env.bolha('bolha-eu', 'oi'), 'oi', Date.now(), false, 'a1');
    env.aplicar({ tipo: 'pendente', id: 'a1', texto: 'outro', mensagem: 'outro', em: Date.now() });
    ok(bolhasDe(fitaEnv).length === 1,
      '`id` repetido com texto DIFERENTE ainda engole — limite declarado da D-n (unicidade é contrato do cliente)');
  });

  await bloco('textos-iguais-ids-diferentes', async () => {
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    env.marcarPendente(env.bolha('bolha-eu', 'continua'), 'continua', Date.now(), false, 'a1');
    env.aplicar({ tipo: 'pendente', id: 'b2', texto: 'continua', mensagem: 'continua', em: Date.now() });
    ok(bolhasDe(fitaEnv).length === 2,
      'dois "continua" legítimos com ids DIFERENTES: DUAS bolhas — dedupe por texto os fundiria');
  });

  // ─── `soltou` (D-l) ─────────────────────────────────────────────────────────

  await bloco('soltou-nao-absorve', async () => {
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const texto = 'oi';
    const el = env.marcarPendente(env.bolha('bolha-eu', texto), texto);
    el.fichaPendente.soltou = true;
    env.aplicar({ tipo: 'humano', texto });
    ok(bolhasDe(fitaEnv).length === 2, 'ficha `soltou`: não absorve — o `humano` desenha bolha NOVA');
  });

  await bloco('soltou-deduplica', async () => {
    const env = carregarClienteFila();
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const texto = 'oi';
    const el = env.marcarPendente(env.bolha('bolha-eu', texto), texto, Date.now(), false, 'a1');
    el.fichaPendente.soltou = true;
    env.aplicar({ tipo: 'pendente', id: 'a1', texto, mensagem: texto, em: Date.now() });
    ok(bolhasDe(fitaEnv).length === 1, '`soltou` AINDA deduplica pelo `id` — a dedupe continua enxergando a ficha');
  });

  // ─── o POST recusado (D-l), pelo `enviar()` de verdade ─────────────────────

  const abaEnvioTeste = { chave: 'aba-7', titulo: 'cockpit', cwd: '/home/y/projetos/cockpit-agentes', temClaude: true, rodando: false, sessaoId: 'sess-fila', atualizadoEm: 1 };

  await bloco('409-solta-o-selo', async () => {
    const env = carregarClienteFila({
      aoBuscar: (rota) => {
        if (String(rota).startsWith('api/abas/aba-7/turnos')) return { __status: 409, erro: 'a aba não está rodando claude' };
        if (String(rota).startsWith('api/abas')) return { abas: [abaEnvioTeste] };
        return { painel: true, jobs: [] };
      },
    });
    await env.carregarAbas();
    await env.abrirAba('aba-7');
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    porIdDe(env, 'entrada').value = 'nao vai';
    await env.enviar(env.painelAtual());
    const bolhasEu = bolhasDe(fitaEnv);
    ok(bolhasEu.length === 1, 'a bolha do texto CONTINUA na fita — o texto não se perde');
    ok(bolhasEu[0] && !String(bolhasEu[0].className).includes('bolha-pendente'), 'e perde `bolha-pendente`');
    ok(bolhasEu[0] && bolhasEu[0].dataset.fila === undefined, 'e perde `data-fila`');
    ok(fitaEnv.filhos.some((f) => String(f.className).includes('bolha-erro')), 'e nasce a `bolha-erro` ao lado');
    ok(bolhasEu[0] && bolhasEu[0].fichaPendente && bolhasEu[0].fichaPendente.soltou === true,
      'a ficha continua em `pendentes`, com `soltou = true`');
  });

  await bloco('409-reenvio-mesmo-texto', async () => {
    let tentativa = 0;
    const env = carregarClienteFila({
      aoBuscar: (rota) => {
        if (String(rota).startsWith('api/abas/aba-7/turnos')) {
          tentativa += 1;
          return tentativa === 1 ? { __status: 409, erro: 'a aba não está rodando claude' } : { enviado: true, id: 'novo' };
        }
        if (String(rota).startsWith('api/abas')) return { abas: [abaEnvioTeste] };
        return { painel: true, jobs: [] };
      },
    });
    await env.carregarAbas();
    await env.abrirAba('aba-7');
    const fitaEnv = porIdDe(env, 'fita');
    fitaEnv.filhos = [];
    const texto = 'roda de novo';
    porIdDe(env, 'entrada').value = texto;
    await env.enviar(env.painelAtual());   // falha (409) — solta a 1ª
    porIdDe(env, 'entrada').value = texto;
    await env.enviar(env.painelAtual());   // sucesso — cria a 2ª
    env.aplicar({ tipo: 'humano', texto });   // o disco confirma o envio que deu certo
    const bolhas = bolhasDe(fitaEnv);
    ok(bolhas.length === 2, 'o `humano` do disco absorve a 2ª ficha — na tela ficam DUAS bolhas, não três');
    ok(bolhas[0] && !String(bolhas[0].className).includes('bolha-pendente'),
      'a 1ª (soltada) continua desmarcada — o disco não a confundiu com a que deu certo');
  });

  // ─── `lib/abas.js` puro — o registro, sem tmux nenhum ─────────────────────────

  await bloco('registro-basico', async () => {
    const abas = carregarAbasFresco();
    const CHAVE = 'aba-x';
    const ficha = abas.registrarPendente(CHAVE, { id: 'i1', texto: 'oi', mensagem: 'oi' });
    ok(Boolean(ficha) && ficha.id === 'i1', 'registrarPendente devolve a ficha com o `id` pedido');
    ok(abas.pendentesDe(CHAVE).length === 1, 'pendentesDe lista a entrada');
    const consumida = abas.consumirPendente(CHAVE, 'oi', new Date(ficha.em + 10).toISOString());
    ok(consumida === ficha, 'consumirPendente devolve a MESMA ficha — identidade, não cópia');
    ok(abas.pendentesDe(CHAVE).length === 0, 'e ela sai do registro');
    const ficha2 = abas.registrarPendente(CHAVE, { id: 'i2', texto: 'oi2', mensagem: 'oi2' });
    abas.esquecerPendente(CHAVE, ficha2);
    ok(abas.pendentesDe(CHAVE).length === 0, 'esquecerPendente remove por identidade (rollback do envio)');
  });

  await bloco('consome-uma-so', async () => {
    const abas = carregarAbasFresco();
    const CHAVE = 'aba-x';
    const em = Date.now() - 1000;
    abas.registrarPendente(CHAVE, { id: 'a', texto: 'continua', mensagem: 'continua' }, em);
    abas.registrarPendente(CHAVE, { id: 'b', texto: 'continua', mensagem: 'continua' }, em);
    const consumida = abas.consumirPendente(CHAVE, 'continua', new Date(em + 500).toISOString());
    ok(consumida !== null, 'o primeiro `humano` consome UMA');
    ok(abas.pendentesDe(CHAVE).length === 1,
      'e sobra a outra — duas mensagens de propósito iguais são duas bolhas (R3)');
  });

  await bloco('historico-velho-nao-consome', async () => {
    const abas = carregarAbasFresco();
    const CHAVE = 'aba-x';
    const em = Date.now();
    abas.registrarPendente(CHAVE, { id: 'a', texto: 'oi', mensagem: 'oi' }, em);
    const consumida = abas.consumirPendente(CHAVE, 'oi', new Date(em - 1).toISOString());
    ok(consumida === null, '`quando` 1ms ANTERIOR ao `em`: não consome (D-b, sem folga)');
    ok(abas.pendentesDe(CHAVE).length === 1, 'a ficha continua lá');
  });

  await bloco('quando-invalido-nao-consome', async () => {
    const abas = carregarAbasFresco();
    const CHAVE = 'aba-x';
    abas.registrarPendente(CHAVE, { id: 'a', texto: 'oi', mensagem: 'oi' });
    ok(abas.consumirPendente(CHAVE, 'oi', undefined) === null, '`quando` ausente: não consome');
    ok(abas.consumirPendente(CHAVE, 'oi', 'não-é-data') === null,
      '`quando` impossível de parsear (`NaN`): não consome — a direção segura da D-b');
    ok(abas.pendentesDe(CHAVE).length === 1, 'e a ficha sobrevive aos dois');
  });

  await bloco('teto-31min-poda', async () => {
    const abas = carregarAbasFresco();
    const CHAVE = 'aba-x';
    const em31minAtras = Date.now() - 31 * 60 * 1000;
    abas.registrarPendente(CHAVE, { id: 'a', texto: 'velha', mensagem: 'velha' }, em31minAtras);
    ok(abas.pendentesDe(CHAVE).length === 0, 'entrada de 31min não sai em `pendentesDe` (D-c)');
    // Sumiu do MAP, não só da leitura: registrar uma nova na mesma chave e ela vir sozinha
    // prova que a poda de fato removeu a velha, não só filtrou a resposta.
    abas.registrarPendente(CHAVE, { id: 'b', texto: 'nova', mensagem: 'nova' });
    ok(abas.pendentesDe(CHAVE).length === 1, 'e ela some do `Map` — a poda roda na entrada e na leitura');
  });

  await bloco('esquecer-no-matar', async () => {
    const abas = carregarAbasFresco();
    const CHAVE = 'aba-x';
    abas.registrarPendente(CHAVE, { id: 'a', texto: 'oi', mensagem: 'oi' });
    abas.esquecerPendentes(CHAVE);
    ok(abas.pendentesDe(CHAVE).length === 0, '`esquecerPendentes` esvazia o registro daquela aba (R5, aba morta)');
  });

  await bloco('endswith-com-rascunho', async () => {
    const abas = carregarAbasFresco();
    const CHAVE = 'aba-x';
    const em = Date.now() - 100;
    abas.registrarPendente(CHAVE, { id: 'a', texto: 'e agora?', mensagem: 'e agora?' }, em);
    const consumida = abas.consumirPendente(
      CHAVE, 'rascunho que estava na caixa e agora?', new Date(em + 50).toISOString(),
    );
    ok(consumida !== null,
      'registrado "e agora?"; volta do disco com o rascunho grudado NA FRENTE — ainda consome (#21/#23, `endsWith`)');
  });

  await bloco('endswith-com-cabecalho-de-anexo', async () => {
    const abas = carregarAbasFresco();
    const CHAVE = 'aba-x';
    const em = Date.now() - 100;
    abas.registrarPendente(CHAVE, { id: 'a', texto: 'olha isso', mensagem: 'olha isso' }, em);
    const doDisco = '[anexo] /x/y.png\n\nOs arquivos acima foram enviados pelo usuário junto desta '
      + 'mensagem. Abra o que precisar.\n\nolha isso';
    const consumida = abas.consumirPendente(CHAVE, doDisco, new Date(em + 50).toISOString());
    ok(consumida !== null, 'cabeçalho de anexo prefixado (#22): ainda consome, `endsWith` de novo');
  });

  // ─── o `enviar` REAL, só o tmux dublado (molde: `comEspiao` de gate-ui.js) ─────
  //
  // Os blocos acima chamam as funções do registro isoladas; estes provam que o `enviar` DE
  // VERDADE registra na hora certa — com o tmux espionado, não dublado por inteiro.

  const SESSAO_FAKE = 'gate-fila-abas';
  const PANE_PID = 5252;
  const PID_DO_CLI = 5253;
  const PARTIDA = 111222;
  const linhaDeJanela = (id, nome = 'cockpit', pane = '%7', indice = 0, pid = PANE_PID) => (
    `${id}\t${SESSAO_FAKE}\t${indice}\t${nome}\t/home/y/projetos/cockpit-agentes\t${pane}\t${pid}\n`
  );
  const LISTA_UMA = linhaDeJanela('@7');

  /** Uma `/proc` de mentira em que a pane das fixtures tem um `claude` em primeiro plano. */
  function procComClaude() {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fila-proc-'));
    const escrever = (pid, { comm, argv, pgrp, tpgid, filhos = [], starttime = 1000 }) => {
      const dir = path.join(raiz, String(pid));
      fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
      const campos = new Array(52).fill('0');
      campos[0] = String(pid); campos[1] = `(${comm})`; campos[2] = 'S'; campos[3] = '1';
      campos[4] = String(pgrp); campos[5] = String(pgrp); campos[6] = '34816'; campos[7] = String(tpgid);
      campos[21] = String(starttime);
      fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
      fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
      fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), filhos.join(' '));
    };
    escrever(PANE_PID, { comm: 'bash', argv: ['-bash'], pgrp: PANE_PID, tpgid: PID_DO_CLI, filhos: [PID_DO_CLI] });
    escrever(PID_DO_CLI, { comm: 'claude', argv: ['claude'], pgrp: PID_DO_CLI, tpgid: PID_DO_CLI, starttime: PARTIDA });
    return raiz;
  }

  /** A mesma árvore, sem agente nenhum em primeiro plano — só o shell da pane. */
  function procSemAgente() {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fila-proc-vazio-'));
    const dir = path.join(raiz, String(PANE_PID));
    fs.mkdirSync(path.join(dir, 'task', String(PANE_PID)), { recursive: true });
    const campos = new Array(52).fill('0');
    campos[0] = String(PANE_PID); campos[1] = '(bash)'; campos[2] = 'S'; campos[3] = '1';
    campos[4] = String(PANE_PID); campos[5] = String(PANE_PID); campos[6] = '34816'; campos[7] = String(PANE_PID);
    campos[21] = '111';
    fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
    fs.writeFileSync(path.join(dir, 'cmdline'), '-bash\0');
    fs.writeFileSync(path.join(dir, 'task', String(PANE_PID), 'children'), '');
    return raiz;
  }

  /** Um HOME de mentira, para o teste mandar no que o CLI "escreveu" em disco. */
  function casaFalsa() {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fila-home-'));
    fs.mkdirSync(path.join(raiz, '.claude', 'sessions'), { recursive: true });
    return raiz;
  }

  /** Planta um `~/.claude/sessions/<pid>.json` que o módulo aceita como VIVO. */
  function plantarSessaoCli(raiz, { janela = '@7', pane = '%7', status = 'idle' } = {}) {
    fs.writeFileSync(path.join(raiz, '.claude', 'sessions', `${PID_DO_CLI}.json`), JSON.stringify({
      kind: 'interactive', sessionId: 'sess-fila', cwd: '/home/y/projetos/cockpit-agentes',
      status, updatedAt: Date.now(), pid: PID_DO_CLI, procStart: PARTIDA,
      tmux: `${SESSAO_FAKE}:${janela}.${pane}`,
    }));
    return raiz;
  }

  const procDoGate = procComClaude();
  const procVazio = procSemAgente();
  const ambienteAbas = (extra = {}) => ({
    COCKPIT_TMUX_SOCKET: 'gate-fila-fake',
    COCKPIT_TMUX_SESSAO: SESSAO_FAKE,
    COCKPIT_BIN_CLAUDE: '/bin/sleep',
    COCKPIT_PROC_RAIZ: procDoGate,
    ...extra,
  });
  const semAgente = (extra = {}) => ambienteAbas({ COCKPIT_PROC_RAIZ: procVazio, ...extra });

  /**
   * Espiona `execFile` (molde: `comEspiao` de gate-ui.js:431) e requer `lib/abas.js` FRESCO
   * da `RAIZ`. `aoChamar(indice, args, mod)` — quando dado — roda ANTES de o mock responder
   * cada chamada: é o que deixa um bloco medir `mod.pendentesDe(chave).length` ENTRE duas
   * chamadas de tmux, sem depender de tempo (ponto 6 do painel, 13ª rodada).
   */
  async function comEspiaoAbas(env, roteiro, corpo, { aoChamar } = {}) {
    const cp = require('node:child_process');
    const original = cp.execFile;
    const antesEnv = { ...process.env };
    const chamadas = [];
    let mod;
    let i = 0;
    cp.execFile = (bin, args, opts, cb) => {
      const indice = i;
      const r = roteiro[i] || { saida: '' };
      i += 1;
      chamadas.push([bin, args]);
      if (aoChamar) aoChamar(indice, args, mod);
      const pronto = cb || opts;
      if (!r.erro) return pronto(null, r.saida ?? '', '');
      const e = new Error(r.erro.stderr || 'tmux falhou');
      e.killed = Boolean(r.erro.killed);
      return pronto(e, '', r.erro.stderr || '');
    };
    Object.assign(process.env, env);
    const caminho = path.join(RAIZ, 'lib', 'abas.js');
    delete require.cache[require.resolve(caminho)];
    try {
      mod = require(caminho);
      return await corpo(mod, chamadas);
    } finally {
      cp.execFile = original;
      for (const k of Object.keys(process.env)) if (!(k in antesEnv)) delete process.env[k];
      Object.assign(process.env, antesEnv);
      delete require.cache[require.resolve(caminho)];
    }
  }

  await bloco('registra-antes-do-send-keys', async () => {
    const casa = plantarSessaoCli(casaFalsa());
    const medidas = [];
    const resultado = await comEspiaoAbas(
      ambienteAbas({ HOME: casa }),
      [{ saida: LISTA_UMA }, { saida: '' }, { saida: '' }],
      async (mod) => {
        await mod.enviar('aba-p7', 'oi');
        return true;
      },
      {
        aoChamar: (indice, args, mod) => {
          if (args.includes('send-keys')) medidas.push(mod.pendentesDe('aba-p7').length);
        },
      },
    );
    ok(resultado === true, 'enviar() completou');
    ok(medidas.length === 2, 'os dois `send-keys` foram vistos pelo espião');
    ok(medidas[0] === 1, 'o registro JÁ existe no momento do 1º `send-keys` — o do texto');
    ok(medidas[1] === 1, 'e continua existindo no do `Enter` — ainda não foi consumido pelo disco');
    fs.rmSync(casa, { recursive: true, force: true });
  });

  await bloco('nao-registra-se-recusa', async () => {
    const casa = casaFalsa();   // sem `plantarSessaoCli`: nenhum agente na pane
    const resultado = await comEspiaoAbas(
      semAgente({ HOME: casa }),
      [{ saida: LISTA_UMA }],
      async (mod) => {
        const erro = await mod.enviar('aba-p7', 'oi').catch((e) => e);
        return { erro, pendentes: mod.pendentesDe('aba-p7').length };
      },
    );
    ok(resultado.erro instanceof Error, 'enviar() estoura — a aba não tem agente rodando');
    ok(resultado.pendentes === 0, 'e NADA foi registrado — a recusa vem antes do registro');
    fs.rmSync(casa, { recursive: true, force: true });
  });

  await bloco('ficha-devolvida-e-a-registrada', async () => {
    const casa = plantarSessaoCli(casaFalsa());
    const resultado = await comEspiaoAbas(
      ambienteAbas({ HOME: casa }),
      [{ saida: LISTA_UMA }, { saida: '' }, { saida: '' }],
      async (mod) => {
        const r = await mod.enviar('aba-p7', 'oi');
        return { ficha: r.ficha, lista: mod.pendentesDe('aba-p7') };
      },
    );
    ok(resultado.lista.length === 1 && resultado.ficha === resultado.lista[0],
      '(await enviar(...)).ficha é `===` ao único item de `pendentesDe(chave)` — o contrato de que `pendenteViva` depende');
    fs.rmSync(casa, { recursive: true, force: true });
  });

  await bloco('corrida-aceita-congelada', async () => {
    const casa = plantarSessaoCli(casaFalsa());
    const resultado = await comEspiaoAbas(
      ambienteAbas({ HOME: casa }),
      [{ saida: LISTA_UMA }, { saida: '' }, { saida: '' }],
      async (mod) => {
        const r = await mod.enviar('aba-p7', 'texto idêntico');
        return { enviado: r.enviado, pendentes: mod.pendentesDe('aba-p7').length };
      },
      {
        // Bem antes do `Enter` (índice 2, a 3ª chamada de tmux): o "impostor" do terminal
        // grava a MESMA mensagem no disco. É a corrida ACEITA da D-b, documentada, não
        // consertada — o gate a congela para que uma mudança futura não amplie o dano calada.
        aoChamar: (indice, args, mod) => {
          if (indice === 2 && args.includes('send-keys')) {
            mod.consumirPendente('aba-p7', 'texto idêntico', new Date().toISOString());
          }
        },
      },
    );
    ok(resultado.enviado === true, 'o envio segue normalmente — o `Enter` ainda sai');
    ok(resultado.pendentes === 0,
      'mas o registro fica VAZIO: a ficha foi consumida pelo impostor — a bolha não sobrevive a uma reconexão (R4)');
    fs.rmSync(casa, { recursive: true, force: true });
  });

  const faltaram = conferirInventario(CASOS_ESPERADOS_PARTE1);
  console.log(`\n${CASOS.size}/${CASOS_ESPERADOS_PARTE1.length} casos da parte 1`
    + (faltaram.length ? ` — faltaram: ${faltaram.join(', ')}` : ''));
  return falhas === 0;
}

// ─── parte 2 — o encanamento SSE, contra um server.js de verdade ─────────────

/** Uma linha de fala do humano, no formato que `lib/externo.js` reconhece. */
function linhaHumano(texto, quando = '2026-09-05T12:00:00.000Z') {
  return `${JSON.stringify({ type: 'user', timestamp: quando, message: { content: texto } })}\n`;
}

/** Uma linha de fala do AGENTE (`tipo: 'texto'`) — o marco de "histórico" nos blocos de ordem. */
function linhaTexto(texto, quando = '2026-09-05T12:00:00.000Z') {
  return `${JSON.stringify({
    type: 'assistant', timestamp: quando, message: { content: [{ type: 'text', text: texto }] },
  })}\n`;
}

// O cano manda `{ aba, evento }` — o envelope do multiplex. Aqui só há uma aba, então
// desembrulhar é tirar a casca; nenhuma asserção abaixo muda, é isso que prova que a
// extração para `acompanharAba` não mexeu no comportamento por aba.
const desembrulhar = (obj) => obj.evento;

function abrirFluxo(chave, recebido) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORTA, path: `/api/eventos?abas=${chave}`, headers: { accept: 'text/event-stream' } },
      (res) => {
        let sobra = '';
        res.setEncoding('utf8');
        res.on('data', (pedaco) => {
          sobra += pedaco;
          const partes = sobra.split('\n\n');
          sobra = partes.pop();
          for (const parte of partes) {
            const dado = parte.split('\n').find((l) => l.startsWith('data: '));
            if (dado) recebido.push(desembrulhar(JSON.parse(dado.slice(6))));
          }
        });
        resolve(req);
      },
    );
    req.on('error', reject);
  });
}

function postTurno(chave, corpo) {
  return new Promise((resolve, reject) => {
    const dados = Buffer.from(JSON.stringify(corpo));
    const req = http.request(
      {
        host: '127.0.0.1', port: PORTA, path: `/api/abas/${chave}/turnos`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': dados.length },
      },
      (res) => {
        let corpoResposta = '';
        res.on('data', (p) => { corpoResposta += p; });
        res.on('end', () => {
          let json = {};
          try { json = JSON.parse(corpoResposta); } catch { /* corpo vazio ou torto */ }
          resolve({ status: res.statusCode, corpo: json });
        });
      },
    );
    req.on('error', reject);
    req.end(dados);
  });
}

/** Espera até `predicado()` ser verdadeiro, ou estoura no timeout. Nunca `sleep` cego. */
function esperarAte(predicado, { timeout = 4000, intervalo = 20, mensagem = 'timeout' } = {}) {
  return new Promise((resolve, reject) => {
    const comecou = Date.now();
    const tenta = () => {
      if (predicado()) return resolve();
      if (Date.now() - comecou > timeout) return reject(new Error(mensagem));
      setTimeout(tenta, intervalo);
    };
    tenta();
  });
}

async function parteDois() {
  // ─── o dublê de `lib/externo.js` (o leitor do Claude), instalado ANTES do de `lib/abas.js`
  //
  // A ORDEM importa: `lib/abas.js` faz `require('./agentes')` no topo, que por sua vez faz
  // `require('./externo')` — se essa cadeia rodar ANTES de instalarmos o dublê, o registro
  // de agentes fica com uma referência direta ao módulo REAL, e trocar o `require.cache`
  // depois não alcança mais ninguém (o objeto já foi capturado). Por isso o dublê de
  // `externo.js` entra PRIMEIRO, e só então `lib/abas.js` é requerido pela primeira vez.
  //
  // Ele não muda O QUE é lido — a fixture continua sendo lida DE VERDADE do disco — só
  // acrescenta uma TRAVA opcional em `lerConversa`, para o Passo 1.4 poder suspender a
  // carga inicial na hora exata em que precisa disparar o POST no meio dela.
  const CAMINHO_EXTERNO = path.join(RAIZ, 'lib', 'externo.js');
  const externoReal = require(CAMINHO_EXTERNO);
  let travaLerConversa = null;
  const externoDublado = {
    ...externoReal,
    lerConversa: async (...args) => {
      if (travaLerConversa) await travaLerConversa;
      return externoReal.lerConversa(...args);
    },
  };
  require.cache[require.resolve(CAMINHO_EXTERNO)] = {
    id: CAMINHO_EXTERNO, filename: CAMINHO_EXTERNO, loaded: true, exports: externoDublado,
  };

  // ─── o dublê PARCIAL de lib/abas.js (molde: gate-troca-arquivo.js) ─────────────
  //
  // `listar`/`buscar`/`paraCliente`/`abasDoProjeto`/`enviar` são dublê — falam com o tmux do
  // usuário, e é o teste quem decide o estado de cada aba (um Map, para os blocos poderem
  // conviver cada um com a sua). As funções do REGISTRO são as REAIS, tiradas do módulo de
  // verdade ANTES de instalar o dublê no cache: dublá-las estaria testando o dublê, não o
  // código. O `?.` em `real.registrarPendente?.(...)` é o que faz este MESMO gate ficar
  // vermelho contra o `develop` sem precisar de um dublê diferente: lá a função não existe,
  // a chamada vira no-op, o POST devolve 202 e nada é registrado.
  const CAMINHO_ABAS = path.join(RAIZ, 'lib', 'abas.js');
  const real = require(CAMINHO_ABAS);
  const ABAS = new Map();   // chave -> { chave, titulo, cwd, arquivo, rodando, esperando }
  const novaAba = (chave, { arquivo = null, titulo = 'Aba de teste', cwd = '/tmp', rodando = false, esperando = false } = {}) => {
    ABAS.set(chave, { chave, titulo, cwd, arquivo, rodando, esperando });
    return ABAS.get(chave);
  };
  // Dois toggles de teste, os dois `null` por padrão (comportamento normal, sem custo para os
  // outros blocos): `forcarFalhaEnvio` simula o `enviar()` real estourando (S10, sem tocar
  // tmux algum); `aoRegistrarFicha` roda ENTRE o registro e o retorno de `enviar()` — é o que
  // deixa o S11 encaixar um `consumirPendente` bem na janela que o `pendenteViva` do
  // `server.js` existe para fechar.
  let forcarFalhaEnvio = null;
  let aoRegistrarFicha = null;
  // `listar`/`buscar` devolvem CÓPIAS, nunca a entrada guardada: o `server.js` compara
  // `atualizada.arquivo !== aba.arquivo` a cada tique do `relogioEstado` contra o objeto que
  // capturou na abertura do fluxo — devolvendo a MESMA referência todo mutar `ABAS` mutaria
  // os dois de uma vez, e a comparação nunca veria diferença nenhuma (é assim que o módulo
  // de verdade se comporta: `listar()` remonta a lista do tmux a cada chamada).
  const duble = {
    ...real,
    listar: async () => [...ABAS.values()].map((a) => ({ ...a })),
    buscar: async (chave) => {
      const info = ABAS.get(chave);
      return info ? { ...info } : null;
    },
    paraCliente: (a) => a,
    abasDoProjeto: () => [],
    enviar: async (chave, texto, anexosDoEnvio = [], id = null) => {
      if (forcarFalhaEnvio) throw new Error(forcarFalhaEnvio);
      const info = ABAS.get(chave);
      const ficha = real.registrarPendente?.(chave, { id, texto, mensagem: texto });
      if (aoRegistrarFicha) aoRegistrarFicha(ficha);
      return { enviado: true, chave, titulo: info && info.titulo, ficha };
    },
  };
  require.cache[require.resolve(CAMINHO_ABAS)] = {
    id: CAMINHO_ABAS, filename: CAMINHO_ABAS, loaded: true, exports: duble,
  };

  // ─── contagem de listeners do barramento, por INSTÂNCIA e por evento (S13) ─────
  //
  // Instrumenta `EventEmitter.prototype.on/off` ANTES de o `server.js` criar o `barramento`
  // — mas o filtro por instância funciona mesmo instalado aqui, porque quem CHAMA `.on()` é
  // sempre em tempo de requisição (abertura de fluxo), bem depois deste ponto. A instância
  // "alvo" é identificada como a que recebeu o PRIMEIRO `.on('pendente', ...)` — o módulo não
  // exporta o `barramento`, então é assim que o gate a acha sem adivinhar.
  const EE = require('node:events').EventEmitter;
  const onOriginal = EE.prototype.on;
  const offOriginal = EE.prototype.off;
  let barramentoAlvo = null;
  let listenersPendente = 0;
  EE.prototype.on = function on(evento, fn) {
    if (evento === 'pendente') {
      if (!barramentoAlvo) barramentoAlvo = this;
      if (this === barramentoAlvo) listenersPendente += 1;
    }
    return onOriginal.call(this, evento, fn);
  };
  EE.prototype.off = function off(evento, fn) {
    if (evento === 'pendente' && this === barramentoAlvo) listenersPendente -= 1;
    return offOriginal.call(this, evento, fn);
  };

  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-fila-'));

  process.env.PORT = String(PORTA);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = process.env.COCKPIT_CERT_DIR || '/dev/null';
  process.env.COCKPIT_TOKEN = '';
  process.env.COCKPIT_JOBS_DIR = path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`); // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
  require(path.join(RAIZ, 'server.js'));
  await new Promise((r) => setTimeout(r, 300)); // deixa o listen() do http assentar

  let contadorAba = 0;
  /** Uma chave de aba nova a cada chamada — os blocos de SSE não podem compartilhar estado. */
  const novaChave = (prefixo = 'aba-fila') => `${prefixo}-${(contadorAba += 1)}`;

  await bloco('abertura-depois-do-sincronizado', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    // A fixture é montada SEM nenhum `humano` com o texto do teste, de propósito: o defeito
    // A é "a mensagem enfileirada não existe em lugar nenhum fora da página", não "o `case`
    // novo ainda não existe" — por isso o arquivo tem só uma fala qualquer, de outro assunto.
    fs.writeFileSync(ARQUIVO, linhaHumano('mensagem antiga, sem relação com o teste'));
    novaAba(CHAVE, { arquivo: ARQUIVO });

    const TEXTO = 'roda os testes';
    const resp = await postTurno(CHAVE, { texto: TEXTO, id: 'g0' });
    ok(resp.status === 202 || resp.status === 200, `POST aceito (status ${resp.status})`);

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'pendente'), {
      mensagem: 'a pendente nunca chegou nesta reconexão',
    });
    req.destroy();

    const iSincronizado = recebido.findIndex((e) => e.tipo === 'sincronizado');
    const iPendente = recebido.findIndex((e) => e.tipo === 'pendente');
    ok(iSincronizado >= 0 && iPendente > iSincronizado,
      `i(sincronizado) < i(pendente) no array coletado (${iSincronizado} < ${iPendente})`);
    ok(!recebido.some((e) => e.tipo === 'humano' && e.texto === TEXTO),
      'e ela não veio como se já tivesse sido lida do disco (não é `humano`)');
  });

  // Passo 1.4 — a prova do bloco SÍNCRONO. Sem ele, uma implementação com o
  // `barramento.on` no topo do handler (em vez de logo depois do `sincronizado`) passaria em
  // todo o resto do gate e ainda entregaria a pendente DENTRO do fragmento do histórico —
  // por isso a spec exige este bloco verde para a Fase 1 fechar, não só a Fase 2.
  await bloco('post-durante-carga-inicial', async () => {
    const CHAVE = 'aba-fila-carga';
    const ARQUIVO = path.join(pasta, 'carga.jsonl');
    fs.writeFileSync(ARQUIVO, linhaTexto('fala qualquer do histórico, para marcar a chegada dele'));
    novaAba(CHAVE, { arquivo: ARQUIVO });

    // Suspende a leitura da carga inicial ANTES de abrir o fluxo: com o `lerConversa` preso,
    // o handler já mandou `sessao` mas não pode ter mandado `sincronizado` nem histórico.
    // `try/finally`: uma asserção que estoure antes da liberação não pode deixar a trava
    // presa para o resto do processo.
    let liberar;
    travaLerConversa = new Promise((r) => { liberar = r; });
    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    try {
      // Uma folga curta para o handler entrar de fato no `await leitor.lerConversa(...)` —
      // sem isto o POST abaixo poderia (em tese) chegar antes de o servidor sequer ter
      // atendido o GET, o que não provaria ordem nenhuma. Nenhuma ASSERÇÃO depende deste
      // tempo — só a ORDEM em que os dois pedidos são disparados; a asserção de verdade é
      // por índice, mais abaixo.
      await new Promise((r) => setTimeout(r, 150));
      ok(recebido.some((e) => e.tipo === 'sessao') && !recebido.some((e) => e.tipo === 'sincronizado'),
        'com a carga presa: o `sessao` já chegou, o `sincronizado` ainda não');

      const TEXTO2 = 'mensagem durante a carga';
      const resp = await postTurno(CHAVE, { texto: TEXTO2, id: 'carga-1' });
      ok(resp.status === 202, `POST aceito durante a carga inicial (status ${resp.status})`);
    } finally {
      // SÓ AGORA libera a leitura presa — o registro já existia antes de o histórico
      // continuar a ser despejado.
      liberar();
      travaLerConversa = null;
    }

    await esperarAte(() => recebido.some((e) => e.tipo === 'pendente'), {
      mensagem: 'a pendente nunca chegou depois de liberar a carga inicial',
    });
    await new Promise((r) => setTimeout(r, 150));
    req.destroy();

    const iSessao = recebido.findIndex((e) => e.tipo === 'sessao');
    const iHistorico = recebido.findIndex((e) => e.tipo === 'texto');
    const iSincronizado = recebido.findIndex((e) => e.tipo === 'sincronizado');
    const iPendente = recebido.findIndex((e) => e.tipo === 'pendente');
    const pendentes = recebido.filter((e) => e.tipo === 'pendente');
    ok(iSessao === 0, `\`sessao\` é o primeiro evento do fluxo (índice ${iSessao})`);
    ok(iHistorico >= 0 && iHistorico > iSessao,
      `o histórico chega depois do \`sessao\` (${iHistorico} > ${iSessao})`);
    ok(iSincronizado >= 0 && iSincronizado > iHistorico,
      `o \`sincronizado\` chega depois do histórico, nunca no meio dele (${iSincronizado} > ${iHistorico})`);
    ok(iPendente >= 0 && iPendente > iSincronizado,
      `a pendente chega DEPOIS do \`sincronizado\` — nunca dentro do fragmento da carga (${iPendente} > ${iSincronizado})`);
    ok(pendentes.length === 1, `e é UMA só, não duas (achei ${pendentes.length})`);
  });

  await bloco('turno-nao-traz-pendente', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    fs.writeFileSync(ARQUIVO, linhaHumano('nada a ver'));
    novaAba(CHAVE, { arquivo: ARQUIVO, rodando: false });
    real.registrarPendente(CHAVE, { id: 'z', texto: 'nunca lida', mensagem: 'nunca lida' });

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'pendente'), {
      mensagem: 'a abertura nunca reemitiu a pendente pré-registrada',
    });
    const antesDaTransicao = recebido.length;

    // o turno "começa": o `relogioEstado` (2s) detecta a transição e manda o `sincronizado`
    // de TURNO, não o de abertura — R1: este NUNCA pode trazer pendente atrás.
    ABAS.get(CHAVE).rodando = true;
    await esperarAte(
      () => recebido.slice(antesDaTransicao).some((e) => e.tipo === 'sincronizado' && e.turnoEmAndamento === true),
      { timeout: 5000, mensagem: 'o turno nunca começou (`sincronizado` de transição)' },
    );
    const iTransicao = recebido.findIndex((e, idx) => (
      idx >= antesDaTransicao && e.tipo === 'sincronizado' && e.turnoEmAndamento === true
    ));

    // e "termina": outro tique do MESMO relógio — o próximo evento CONHECIDO depois do qual
    // dá para conferir o que veio ENTRE os dois. Nunca "esperei e não veio" (regra do plano).
    ABAS.get(CHAVE).rodando = false;
    await esperarAte(
      () => recebido.slice(iTransicao + 1).some((e) => e.tipo === 'turno_fim'),
      { timeout: 5000, mensagem: 'o `turno_fim` nunca chegou' },
    );
    const iFim = recebido.findIndex((e, idx) => idx > iTransicao && e.tipo === 'turno_fim');
    req.destroy();

    const entreOsDois = recebido.slice(iTransicao + 1, iFim);
    ok(!entreOsDois.some((e) => e.tipo === 'pendente'),
      'nenhum `pendente` entre o `sincronizado` de TURNO e o `turno_fim` seguinte (R1)');
  });

  await bloco('disco-consome-antes-de-reemitir', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    const TEXTO = 'já apareceu';
    const em = Date.now() - 5000;
    novaAba(CHAVE, { arquivo: ARQUIVO });
    fs.writeFileSync(ARQUIVO, '');
    real.registrarPendente(CHAVE, { id: 'w', texto: TEXTO, mensagem: TEXTO }, em);
    // o texto JÁ está no disco, com `timestamp` DEPOIS do registro
    fs.writeFileSync(ARQUIVO, linhaHumano(TEXTO, new Date(em + 1000).toISOString()));

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), {
      mensagem: '`sincronizado` nunca chegou',
    });
    await new Promise((r) => setTimeout(r, 200));
    req.destroy();

    ok(recebido.some((e) => e.tipo === 'humano' && e.texto === TEXTO),
      'o `humano` do disco chega, na leitura inicial');
    ok(!recebido.some((e) => e.tipo === 'pendente' && e.texto === TEXTO),
      'e a reconexão NÃO reemite — o consumo (leitura inicial) roda antes da reemissão (R2)');
  });

  await bloco('geracao-velha-nao-consome', async () => {
    const CHAVE = novaChave();
    const ARQUIVO_A = path.join(pasta, `${CHAVE}-a.jsonl`);
    const ARQUIVO_B = path.join(pasta, `${CHAVE}-b.jsonl`);
    fs.writeFileSync(ARQUIVO_A, '');
    fs.writeFileSync(ARQUIVO_B, '');
    novaAba(CHAVE, { arquivo: ARQUIVO_A });

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), { mensagem: 'abertura nunca sincronizou' });

    const TEXTO = 'grudou no ar';
    const em = Date.now();
    real.registrarPendente(CHAVE, { id: 'g', texto: TEXTO, mensagem: TEXTO }, em);

    // Trava a PRÓXIMA leitura — o relógio de 700ms vai ficar preso nela — e só então grava a
    // fala no arquivo VELHO: o relógio vai lê-la, mas só vai poder terminar DEPOIS da troca.
    // `try/finally`: se alguma asserção do meio estourar, a trava tem que ser SEMPRE solta —
    // senão fica presa para o resto do processo e todo bloco seguinte quebra em cascata.
    let liberar;
    travaLerConversa = new Promise((r) => { liberar = r; });
    try {
      await new Promise((r) => setTimeout(r, 750));   // deixa o relógio de 700ms entrar e travar
      fs.appendFileSync(ARQUIVO_A, linhaHumano(TEXTO, new Date(em + 100).toISOString()));

      // a troca de arquivo (equivalente a um `/clear`) muda a GERAÇÃO enquanto a leitura
      // presa ainda não terminou.
      ABAS.get(CHAVE).arquivo = ARQUIVO_B;
      await esperarAte(
        () => recebido.filter((e) => e.tipo === 'sessao').length >= 2,
        { timeout: 5000, mensagem: 'a troca de arquivo nunca reemitiu o `sessao`' },
      );
    } finally {
      // SÓ AGORA libera a leitura velha — ela vai achar o `humano`, mas a geração já mudou,
      // e o guarda (`minha !== geracao`) descarta a leitura INTEIRA antes de consumir
      // qualquer coisa.
      liberar();
      travaLerConversa = null;
    }
    await new Promise((r) => setTimeout(r, 400));
    req.destroy();

    ok(real.pendentesDe(CHAVE).some((p) => p.texto === TEXTO),
      'a pendente SOBREVIVE — a leitura descartada (geração velha) não a consumiu (R6/#33)');
  });

  /** O cenário do `/clear` com uma pendente atravessando — molde compartilhado por S6/S7/S8. */
  async function cenarioClear() {
    const CHAVE = novaChave('aba-fila-clear');
    const ARQUIVO_A = path.join(pasta, `${CHAVE}-a.jsonl`);
    const ARQUIVO_B = path.join(pasta, `${CHAVE}-b.jsonl`);
    fs.writeFileSync(ARQUIVO_A, '');
    // A mensagem NUNCA aparece em arquivo nenhum, nem no velho nem no novo (D-k).
    fs.writeFileSync(ARQUIVO_B, linhaTexto('resposta na conversa nova'));
    novaAba(CHAVE, { arquivo: ARQUIVO_A });

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), { mensagem: 'abertura nunca sincronizou' });

    const TEXTO = 'nunca chega ao disco';
    const postResp = await postTurno(CHAVE, { texto: TEXTO, id: 'clear-1' });

    ABAS.get(CHAVE).arquivo = ARQUIVO_B;
    await esperarAte(
      () => recebido.filter((e) => e.tipo === 'sessao').length >= 2,
      { timeout: 5000, mensagem: 'o `/clear` nunca reemitiu o `sessao`' },
    );
    await esperarAte(
      () => recebido.some((e) => e.tipo === 'pendente' && e.texto === TEXTO),
      { mensagem: 'a pendente nunca atravessou o `/clear`' },
    );
    await new Promise((r) => setTimeout(r, 150));
    req.destroy();
    return { recebido, TEXTO, postStatus: postResp.status };
  }

  await bloco('clear-manda-sincronizado', async () => {
    const { recebido } = await cenarioClear();
    const sessoes = recebido.map((e, i) => ({ e, i })).filter(({ e }) => e.tipo === 'sessao');
    const iSessao2 = sessoes[1] && sessoes[1].i;
    ok(iSessao2 !== undefined, 'o `/clear` reemitiu um 2º `sessao`');
    const iSincronizadoDepois = recebido.findIndex((e, idx) => idx > iSessao2 && e.tipo === 'sincronizado');
    ok(iSincronizadoDepois > iSessao2,
      'e logo depois manda o `sincronizado` — D-j, sem ele a fita fica muda até o próximo turno');
  });

  await bloco('clear-ordem-dos-indices', async () => {
    const { recebido, TEXTO } = await cenarioClear();
    const sessoes = recebido.map((e, i) => ({ e, i })).filter(({ e }) => e.tipo === 'sessao');
    const iSessao2 = sessoes[sessoes.length - 1].i;
    const iSincronizado = recebido.findIndex((e, idx) => idx > iSessao2 && e.tipo === 'sincronizado');
    const iPendente = recebido.findIndex((e, idx) => (
      idx > iSincronizado && e.tipo === 'pendente' && e.texto === TEXTO
    ));
    ok(iSessao2 < iSincronizado && iSincronizado < iPendente,
      `i(sessao) < i(sincronizado) < i(pendente), por índice (${iSessao2} < ${iSincronizado} < ${iPendente})`);
  });

  await bloco('pendente-atravessa-clear', async () => {
    const { recebido, TEXTO } = await cenarioClear();
    const sessoes = recebido.map((e, i) => ({ e, i })).filter(({ e }) => e.tipo === 'sessao');
    const depoisDoClear = recebido.slice(sessoes[sessoes.length - 1].i);
    ok(depoisDoClear.some((e) => e.tipo === 'pendente' && e.texto === TEXTO),
      'a mensagem que não está em arquivo nenhum reaparece na conversa NOVA (D-k)');
  });

  await bloco('aviso-ao-vivo', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    fs.writeFileSync(ARQUIVO, '');
    novaAba(CHAVE, { arquivo: ARQUIVO });

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), { mensagem: 'abertura nunca sincronizou' });
    const antes = recebido.length;

    const TEXTO = 'chegando ao vivo';
    const resp = await postTurno(CHAVE, { texto: TEXTO, id: 'vivo-1' });
    ok(resp.status === 202, 'POST aceito');

    await esperarAte(() => recebido.slice(antes).some((e) => e.tipo === 'pendente' && e.texto === TEXTO), {
      mensagem: 'o aviso ao vivo nunca chegou',
    });
    req.destroy();

    const novos = recebido.slice(antes);
    ok(!novos.some((e) => e.tipo === 'sessao'), 'chega SEM nenhum `sessao` no meio — o fluxo já estava aberto');
    const evPendente = novos.find((e) => e.tipo === 'pendente');
    ok(Boolean(evPendente) && evPendente.id === 'vivo-1', 'e carrega o `id` que o corpo do POST mandou');
  });

  await bloco('envio-que-falha-nao-avisa', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    fs.writeFileSync(ARQUIVO, '');
    novaAba(CHAVE, { arquivo: ARQUIVO });

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), { mensagem: 'abertura nunca sincronizou' });

    forcarFalhaEnvio = 'a aba não está rodando claude';
    const resp = await postTurno(CHAVE, { texto: 'não vai', id: 'falha-1' });
    forcarFalhaEnvio = null;

    await new Promise((r) => setTimeout(r, 300));
    req.destroy();

    ok(resp.status === 409, `o POST recusa (status ${resp.status})`);
    ok(!recebido.some((e) => e.tipo === 'pendente'), 'nenhum `pendente` chega a fluxo nenhum');
    ok(real.pendentesDe(CHAVE).length === 0, 'e o registro fica vazio');
  });

  await bloco('broadcast-tardio', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    fs.writeFileSync(ARQUIVO, '');
    novaAba(CHAVE, { arquivo: ARQUIVO });

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), { mensagem: 'abertura nunca sincronizou' });

    const TEXTO = 'consumida antes do emit';
    aoRegistrarFicha = (ficha) => {
      // Simula o disco tendo lido a mensagem NO INSTANTE entre o registro e o `emit` — a
      // janela que o `pendenteViva` do `server.js` existe para fechar (D-m).
      real.consumirPendente(CHAVE, ficha.texto, new Date().toISOString());
    };
    const resp = await postTurno(CHAVE, { texto: TEXTO, id: 'tardio-1' });
    aoRegistrarFicha = null;

    await new Promise((r) => setTimeout(r, 300));
    req.destroy();

    ok(resp.status === 202, 'o POST ainda responde 202 — o envio, em si, aconteceu');
    ok(!recebido.some((e) => e.tipo === 'pendente'), 'mas NENHUM `pendente` sai — `pendenteViva` é falso');
  });

  await bloco('corrida-do-card', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    fs.writeFileSync(ARQUIVO, '');
    novaAba(CHAVE, { arquivo: ARQUIVO });

    const recebidoA = [];
    const reqA = await abrirFluxo(CHAVE, recebidoA);
    await esperarAte(() => recebidoA.some((e) => e.tipo === 'sincronizado'), { mensagem: 'A nunca sincronizou' });

    const TEXTO = 'corrida do card';
    const postPromise = postTurno(CHAVE, { texto: TEXTO, id: 'corrida-1' });
    // Derruba e reabre ANTES de o POST voltar — a mensagem tem que aparecer por UM dos dois
    // caminhos (aviso ao vivo em A, ou reemissão na abertura de B), nunca nenhum e nunca dois.
    reqA.destroy();
    const recebidoB = [];
    const reqB = await abrirFluxo(CHAVE, recebidoB);
    await postPromise;

    await esperarAte(
      () => recebidoA.some((e) => e.tipo === 'pendente' && e.texto === TEXTO)
        || recebidoB.some((e) => e.tipo === 'pendente' && e.texto === TEXTO),
      { mensagem: 'a mensagem não apareceu em NENHUM dos dois fluxos' },
    );
    await new Promise((r) => setTimeout(r, 300));
    reqB.destroy();

    const emA = recebidoA.filter((e) => e.tipo === 'pendente' && e.texto === TEXTO).length;
    const emB = recebidoB.filter((e) => e.tipo === 'pendente' && e.texto === TEXTO).length;
    ok(emA + emB === 1,
      `a mensagem aparece por UM dos dois caminhos, nunca nenhum e nunca dois (A=${emA} B=${emB})`);
  });

  await bloco('off-do-barramento', async () => {
    // Assenta o que os blocos ANTERIORES já destruíram: `req.destroy()` do lado do cliente
    // não fecha o socket do lado do servidor na mesma volta do event loop — sem esta folga,
    // a "partida" lida aqui pode contar um `off` que ainda está a caminho, e a contagem de
    // baixo nunca bateria por um motivo que não é vazamento nenhum.
    await new Promise((r) => setTimeout(r, 300));
    const antes = listenersPendente;
    const N = 3;
    const reqs = [];
    for (let n = 0; n < N; n += 1) {
      const CHAVE = novaChave();
      const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
      fs.writeFileSync(ARQUIVO, '');
      novaAba(CHAVE, { arquivo: ARQUIVO });
      const recebido = [];
      const req = await abrirFluxo(CHAVE, recebido);
      await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), {
        mensagem: `fluxo ${n} nunca sincronizou`,
      });
      reqs.push(req);
    }
    ok(listenersPendente === antes + N,
      `abrir ${N} fluxos registra ${N} listeners novos (contagem: ${listenersPendente}, partida: ${antes})`);
    for (const req of reqs) req.destroy();
    await esperarAte(() => listenersPendente === antes, {
      timeout: 3000, mensagem: 'a contagem não voltou ao valor de partida — vazamento de listener',
    });
    ok(listenersPendente === antes, 'e fechar os fluxos devolve a contagem ao que era — sem vazamento');
  });

  await bloco('id-torto-400', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    fs.writeFileSync(ARQUIVO, '');
    novaAba(CHAVE, { arquivo: ARQUIVO });

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), { mensagem: 'abertura nunca sincronizou' });

    const formas = [
      ['de 200 caracteres', 'x'.repeat(200)],
      ['com barra', 'algo/coisa'],
      ['vazio', ''],
    ];
    for (const [rotulo, idTorto] of formas) {
      const antes = recebido.length;
      const resp = await postTurno(CHAVE, { texto: `tentativa ${rotulo}`, id: idTorto });
      ok(resp.status === 400, `id ${rotulo}: 400 (achei ${resp.status})`);
      await new Promise((r) => setTimeout(r, 150));
      ok(!recebido.slice(antes).some((e) => e.tipo === 'pendente'), `id ${rotulo}: nenhum \`pendente\` em fluxo nenhum`);
    }
    ok(real.pendentesDe(CHAVE).length === 0, 'e `pendentesDe(chave)` continua vazio depois das três tentativas');
    req.destroy();
  });

  await bloco('sem-id-202', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    fs.writeFileSync(ARQUIVO, '');
    novaAba(CHAVE, { arquivo: ARQUIVO });
    const resp = await postTurno(CHAVE, { texto: 'sem id, como o app velho manda' });   // SEM `id`
    ok(resp.status === 202, `202 mesmo sem \`id\` — cliente velho em cache num PWA (achei ${resp.status})`);
    ok(real.pendentesDe(CHAVE).length === 1, 'e o registro foi criado, com um `id` gerado pelo servidor');
  });

  await bloco('id-do-202-e-o-mandado', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    fs.writeFileSync(ARQUIVO, '');
    novaAba(CHAVE, { arquivo: ARQUIVO });

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), { mensagem: 'abertura nunca sincronizou' });

    const resp = await postTurno(CHAVE, { texto: 'com id próprio', id: 'k9' });
    ok(resp.status === 202 && resp.corpo.id === 'k9', `o 202 traz \`id: k9\` (achei ${resp.corpo.id})`);
    await esperarAte(() => recebido.some((e) => e.tipo === 'pendente'), { mensagem: 'o evento nunca chegou' });
    req.destroy();
    const ev = recebido.find((e) => e.tipo === 'pendente');
    ok(Boolean(ev) && ev.id === 'k9', 'e o evento do barramento também traz `k9` — nunca substituição silenciosa');
  });

  await bloco('quando-repassado-na-leitura-real', async () => {
    const CHAVE = novaChave();
    const ARQUIVO = path.join(pasta, `${CHAVE}.jsonl`);
    const TEXTO = 'texto idêntico';
    const em = Date.now();
    fs.writeFileSync(ARQUIVO, linhaHumano(TEXTO, new Date(em - 60000).toISOString()));   // ANTERIOR ao envio
    novaAba(CHAVE, { arquivo: ARQUIVO });
    real.registrarPendente(CHAVE, { id: 'q', texto: TEXTO, mensagem: TEXTO }, em);

    const recebido = [];
    const req = await abrirFluxo(CHAVE, recebido);
    await esperarAte(() => recebido.some((e) => e.tipo === 'sincronizado'), { mensagem: 'abertura nunca sincronizou' });
    await new Promise((r) => setTimeout(r, 200));
    req.destroy();

    ok(recebido.some((e) => e.tipo === 'pendente' && e.texto === TEXTO),
      '`quando` ANTERIOR ao envio: a ficha SOBREVIVE e é reemitida — o encanamento repassa o '
      + '`quando` de verdade (o L3 prova a função; este prova o fio)');
  });

  fs.rmSync(pasta, { recursive: true, force: true });
  EE.prototype.on = onOriginal;
  EE.prototype.off = offOriginal;

  const faltaram = conferirInventario(CASOS_ESPERADOS_PARTE2);
  console.log(`\n${CASOS.size}/${CASOS_ESPERADOS_PARTE2.length} casos da parte 2`
    + (faltaram.length ? ` — faltaram: ${faltaram.join(', ')}` : ''));
  return falhas === 0;
}

// ─── ponto de entrada ────────────────────────────────────────────────────────

(async () => {
  const parte2 = process.argv[2] === 'parte2';
  const passou = parte2 ? await parteDois() : await parteUm();
  console.log(`\n${passou ? '✅ GATE VERDE' : '❌ GATE VERMELHO'} — ${parte2 ? 'parte 2' : 'parte 1'} (${CASOS.size} casos: ${[...CASOS].join(', ')})\n`);
  process.exit(passou ? 0 : 1);
})().catch((erro) => {
  console.error('\n❌ o gate quebrou:', erro && erro.message, '\n');
  console.error(erro && erro.stack);
  process.exit(1);
});
