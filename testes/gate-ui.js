#!/usr/bin/env node
'use strict';
// GATE DA RODADA DE UI — as quatro melhorias de 20/08.
//
// Duas partes, nenhuma delas gasta token da assinatura:
//
//   A) markdown do cliente, rodado de verdade. `public/app.js` é carregado num DOM de
//      mentira e a árvore que ele produz é inspecionada. O caso que mais importa é o de
//      segurança: markdown vindo do agente NUNCA pode virar HTML executável.
//
//   B) catálogo e exclusão, contra o servidor no ar. A exclusão é a única operação
//      destrutiva do sistema — o teste prova que ela apaga o que devia e só isso.
//
// Uso:  node testes/gate-ui.js          (parte A, offline)
//       node testes/gate-ui.js parte2   (parte B, exige o serviço na PORT)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const BASE = { host: '127.0.0.1', port: Number(process.env.PORT || 7879) };

// O cano manda `{ aba, evento }` (o envelope do multiplex) — os testes que injetam evento
// direto no `onmessage` de um `EventSource` de mentira têm que embrulhar do mesmo jeito,
// senão o decoder novo descarta (`aba === undefined`) e o gate fica vermelho sem bug (R42).
const mandarEvento = (es, evento, aba = 'aba-7') =>
  es.onmessage({ data: JSON.stringify({ aba, evento }) });

// ─── DOM de mentira ──────────────────────────────────────────────────────────
// Pequeno de propósito: só o que `markdown()` e a montagem da tela encostam.

function textoDe(no) {
  if (no.tag === '#texto') return no.valor;
  return no.filhos.map(textoDe).join('') || no._texto || '';
}

/**
 * Casa UMA peça de seletor: `#id`, `.classe` ou `[data-x]`/`[data-x="y"]`.
 */
function casaParte(el, parte) {
  const id = parte.match(/^#([\w-]+)$/);
  if (id) return (el.atributos || {}).id === id[1];
  const classe = parte.match(/^\.([\w-]+)$/);
  if (classe) return String(el.className || '').split(/\s+/).includes(classe[1]);
  const atributo = parte.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (!atributo) return false;
  const chave = atributo[1].replace(/^data-/, '').replace(/-([a-z])/g, (m, c) => c.toUpperCase());
  const valor = (el.dataset || {})[chave];
  return valor !== undefined && (atributo[2] === undefined || String(valor) === atributo[2]);
}

/**
 * Seletor de mentira, do tamanho do que o cliente usa: `#id`, `.classe`, `[data-x]`/`[data-x="y"]`
 * e composto (`.classe[attr]`, `#id.classe`, …) — todas as peças precisam casar.
 *
 * Existe porque `querySelector` devolvendo null sempre escondia bug de verdade — era assim
 * que o "trabalhando" continuava na fita depois do turno acabar sem ninguém perceber.
 *
 * Descendência (`a b`) NÃO entra: `buscarNaArvore` repassa a string inteira, sem decompor por
 * espaço — suportar combinador seria reescrever o motor, não estendê-lo (spec §8).
 */
function casaSeletor(el, seletor) {
  const partes = seletor.match(/#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g);
  if (!partes || partes.join('') !== seletor) return false;
  return partes.every((parte) => casaParte(el, parte));
}

function buscarNaArvore(no, seletor, achados) {
  for (const filho of no.filhos || []) {
    if (filho.tag !== '#texto' && casaSeletor(filho, seletor)) achados.push(filho);
    buscarNaArvore(filho, seletor, achados);
  }
  return achados;
}

// Ordem em que os <dialog> modais foram abertos. É o que deixa o teste saber QUAL deles o
// voltar do aparelho fecha quando há mais de um empilhado (o de cima, como no navegador).
let ordemModal = 0;

function criarElemento(tag, rolagens = null, dono = null) {
  const el = {
    tag,
    filhos: [],
    // Quem me pendurou. Sem isto o `remove()` era um no-op e o teste não conseguia provar
    // que o cliente TIRA nó da tela — que é metade do conserto da bolha duplicada.
    pai: null,
    atributos: {},
    // `el.id = 'x'` é como o código de produção marca a âncora (`#grupo-jobs`). Sem este
    // get/set o `id` viraria uma propriedade solta do objeto, e o `#id` do `casaSeletor`
    // nunca casaria com nada.
    get id() { return el.atributos.id || ''; },
    set id(valor) { el.atributos.id = String(valor); },
    // `setProperty`/`removeProperty` entraram com o selo do puxar-para-atualizar (03/09):
    // ele escreve a fração do curso numa CUSTOM PROPERTY (`--puxar`), e custom property não
    // existe como campo do `style` — só pela API. Guardadas no próprio objeto para o teste
    // poder ler o que o cliente escreveu.
    style: {
      cssText: '',
      setProperty(nome, valor) { this[nome] = String(valor); },
      removeProperty(nome) { delete this[nome]; },
      getPropertyValue(nome) { return this[nome] ?? ''; },
    },
    // Métrica de rolagem. O DOM de mentira não faz layout, então estes dois são valores que
    // o TESTE escreve para dizer "a lista está no topo" ou "a lista está rolada" — é a única
    // régua do puxar-para-atualizar. Ninguém os lia antes; `rolarFim` já escrevia `scrollTop`
    // num objeto que sequer o declarava.
    scrollTop: 0,
    scrollHeight: 0,
    // `scrollLeft` e `clientHeight` entraram com a tela da pane: ela é o único bloco que
    // rola para os DOIS lados, e a régua de "estava colado no fim" precisa da altura
    // visível. Como os dois de cima, quem escreve valor de verdade aqui é o TESTE.
    scrollLeft: 0,
    clientHeight: 0,
    // O layout que este DOM não faz. Escrito pelo teste: "pintar texto neste elemento vai
    // deixá-lo com tanto de altura rolável". Sem isto não dá para provar que a tela da
    // pane cai no FIM depois de pintada — no navegador o `scrollHeight` só cresce DEPOIS
    // do texto entrar, e aqui ele nunca mudava.
    alturaAoPintar: null,
    // O mesmo buraco do `alturaAoPintar`, do outro lado: a FITA cresce por `append`, não
    // por `textContent`, e quem rola não é ela — é o `#mensagens` que a contém. Este DOM
    // não tem hierarquia (cada `getElementById` cria um elemento solto), então a ligação
    // é declarada pelo teste: `fita.crescerJunto = caixa` + `caixa.crescePorFilho = 200`.
    // Sem isto o `scrollHeight` fica congelado durante o desenho, e a régua "estava colado
    // no fim" era medida num mundo que o navegador nunca produz.
    crescerJunto: null,
    crescePorFilho: 0,
    dataset: {},
    className: '',
    hidden: false,
    // Botão nasce habilitado, como no navegador. Sem isto o `disabled` só existia depois
    // de alguém escrevê-lo, e "não travado" era `undefined` em vez de `false`.
    disabled: false,
    // `<dialog>` fechado, como no navegador. Sem estado de verdade aqui, `showModal()` era
    // um no-op e não dava para provar que o painel de configuração ABRE — nem que o voltar
    // do aparelho fecha SÓ ele.
    open: false,
    abertoEm: 0,
    // Campos de <textarea>/<input>. Até a fase 2 desta mudança nenhum campo NASCIA de
    // `createElement` — `#entrada` chegava por `porId.get()` e o TESTE escrevia `.value`
    // antes de usar, então o buraco era invisível. Com a caixa de escrita montada dentro
    // do `criarPainel`, `enviar()` faz `entrada.value.trim()` na primeira linha
    // (`app.js:3186`): sem `value: ''` aqui o gate estoura com TypeError DENTRO de um
    // handler, que é o jeito de o erro morrer calado. Irmã da #53.
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
      // Como no navegador de VERDADE: reconstruir os filhos joga a vista de volta ao
      // começo. É exatamente este comportamento que puxava a tela da pane para o topo a
      // cada 5s enquanto o usuário lia as opções — sem ele aqui, o bug ficava invisível.
      el.scrollTop = 0;
      el.scrollLeft = 0;
      if (el.alturaAoPintar !== null) el.scrollHeight = el.alturaAoPintar;
    },
    append(...nos) {
      for (const no of nos) {
        const filho = typeof no === 'string' ? { tag: '#texto', valor: no } : no;
        // append move um nó existente; não cria uma cópia dele.
        if (filho.pai) filho.pai.filhos = filho.pai.filhos.filter(f => f !== filho);
        filho.pai = el;
        el.filhos.push(filho);
      }
      // No navegador o conteúdo entra ANTES de qualquer código de rolagem rodar: quando a
      // decisão "rolo ao fim?" é tomada, o `scrollHeight` do bloco que rola JÁ cresceu.
      const cresce = el.crescerJunto;
      if (cresce && cresce.crescePorFilho) cresce.scrollHeight += cresce.crescePorFilho * nos.length;
    },
    appendChild(no) { el.append(no); return no; },
    // `class` sincroniza com `.className` — como no navegador de verdade. Os ícones dos
    // painéis (split view, fase 2) nascem `<svg>` e usam `setAttribute('class', ...)`
    // porque `.className` em SVG é getter-only em modo estrito (`svg.className = x`
    // estouraria em produção); sem esta sincronia, `casaSeletor` (que lê `.className`)
    // nunca acharia um ícone por `.icone-botao`.
    setAttribute(chave, valor) {
      el.atributos[chave] = String(valor);
      if (chave === 'class') el.className = String(valor);
    },
    getAttribute(chave) { return el.atributos[chave]; },
    // Sem isto o `aplicarTema('')` — o tema "do sistema" — morria com TypeError e não dava
    // para exercitar a troca de tema nenhuma.
    removeAttribute(chave) { delete el.atributos[chave]; },
    // Ouvintes de VERDADE no elemento: sem isto o `keydown` da caixa de texto era um
    // no-op e não dava para provar qual tecla envia e qual quebra linha.
    ouvintes: new Map(),
    addEventListener(tipo, fn) {
      if (!el.ouvintes.has(tipo)) el.ouvintes.set(tipo, []);
      el.ouvintes.get(tipo).push(fn);
    },
    removeEventListener(tipo, fn) {
      el.ouvintes.set(tipo, (el.ouvintes.get(tipo) || []).filter((f) => f !== fn));
    },
    /** Dispara o evento no elemento e devolve o objeto do evento, já com o que foi mexido. */
    disparar(tipo, evento = {}) {
      for (const fn of el.ouvintes.get(tipo) || []) fn(evento);
      return evento;
    },
    // `document.activeElement` de verdade. Até aqui `focus()` era no-op e ninguém notava: com
    // uma caixa só, "onde está o cursor" nunca foi pergunta. Com N caixas ele decide TRÊS
    // coisas (§3.6 e §3.9 da spec): se a paleta abre, se `fecharPainel` move o cursor, e para
    // onde o `paste` vai. Sem isto as três guardas leem `undefined` e ficam sempre falsas —
    // verde mentiroso.
    focus() {
      // Não basta gravar quem tem o cursor: no navegador, focar dispara `focus` no novo e
      // `blur` no antigo, e é essa SEQUÊNCIA que os gates novos precisam (o `blur` fecha a
      // paleta, o `focus` move `atual`). Sem ela, S19/S20/S21 provariam cada handler isolado e
      // nenhum provaria a troca de caixa de ponta a ponta — que é o gesto real.
      if (dono) {
        const antigo = dono.activeElement;
        if (antigo && antigo !== el) antigo.disparar?.('blur', {});
        dono.activeElement = el;
      }
      el.disparar('focus', {});
    },
    remove() {
      // Como no navegador: tirar da árvore o nó focado (ou um ancestral dele) devolve o foco
      // ao documento. Sem isto, `document.activeElement` continua apontando para um nó órfão e
      // a condição do `fecharPainel` (§3.9 da spec) fica sempre VERDADEIRA no gate e sempre
      // FALSA em produção — o pior par possível.
      if (dono) {
        for (let n = dono.activeElement; n; n = n.pai) {
          if (n === el) { dono.activeElement = null; break; }
        }
      }
      if (!el.pai) return;
      el.pai.filhos = el.pai.filhos.filter((f) => f !== el);
      el.pai = null;
    },
    // Empilha o NÓ em `contexto.rolagens`, no mesmo padrão do `chamadasWindowOpen` — sem
    // isto o G10 mediria só o efeito (window.open morto), nunca a janela de tempo em que a
    // rolagem não podia acontecer.
    scrollIntoView() { if (rolagens) rolagens.push(el); },
    showModal() { el.open = true; ordemModal += 1; el.abertoEm = ordemModal; },
    close() { el.open = false; },
    querySelector(seletor) { return buscarNaArvore(el, seletor, [])[0] || null; },
    querySelectorAll(seletor) { return buscarNaArvore(el, seletor, []); },
    // Split view, fase 3: `evento.target.closest('.painel')` decide QUEM recebe o drop e o
    // `pointerdown` delegado. Sobe pela cadeia de `pai`, testando o próprio nó primeiro —
    // como o `Element.closest` de verdade.
    closest(seletor) {
      let no = el;
      while (no) {
        if (casaSeletor(no, seletor)) return no;
        no = no.pai;
      }
      return null;
    },
    get lastChild() { return el.filhos[el.filhos.length - 1] || null; },
    get children() { return el.filhos.filter((f) => f.tag !== '#texto'); },
  };
  return el;
}

/** localStorage de mentira, com memória de verdade. */
function memoria() {
  const dados = new Map();
  return {
    getItem: (k) => (dados.has(k) ? dados.get(k) : null),
    setItem: (k, v) => dados.set(k, String(v)),
    // `removeItem` entrou com "Voltar ao padrão": APAGAR a chave e gravar `'{}'` se leem
    // igual, mas só um dos dois deixa o localStorage limpo — e um teste que aceita os dois
    // deixa passar o desvio. Apontado pelo painel de execução.
    removeItem: (k) => dados.delete(k),
    _dados: dados,
  };
}

// Lista FECHADA (§5.5 da spec do split view): os ids que viraram elemento de painel na fase
// 2 (docs/superpowers/plans/2026-09-08-split-view-plano.md). Fora dela, `porIdDe` se comporta
// como sempre se comportou — `porId`/`getElementById` direto.
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

/** O painel de índice `i` (0 = o primeiro aberto). `null` se não houver painel nenhum. */
function painelDe(cliente, i = 0) {
  const caixa = cliente.porId.get('paineis') || cliente.document.getElementById('paineis');
  return caixa.querySelectorAll('.painel')[i] || null;
}

// Split view, fase 3: `paineis` é `const` de MÓDULO em app.js, e o `vm` não expõe `const`/
// `let` de topo como propriedade do contexto (só `function` vira) — não há como o gate ler
// `cliente.paineis` direto. `contarPaineis` é o substituto por DOM, sempre escopado por
// `#paineis .painel` (#44) — nunca `querySelectorAll` global, que mentiria contando qualquer
// outra coisa que a página venha a ter com essa classe.
function contarPaineis(cliente) {
  const caixa = cliente.porId.get('paineis') || cliente.document.getElementById('paineis');
  return caixa.querySelectorAll('.painel').length;
}

/**
 * O elemento por id, criando-o se o cliente ainda não o tiver procurado.
 *
 * Ids de painel (`IDS_DO_PAINEL`) passam a ser achados DENTRO do painel `i` (0 = o
 * primeiro), por classe — o CSS já casa por classe (§1.4 da spec), e o elemento carrega a
 * classe com o nome do id antigo. `'paineis'` não está no Set: sem recursão. Sem painel
 * nenhum, cai no caminho de sempre (o `porId`/`getElementById` de um elemento solto).
 */
function porIdDe(cliente, id, i = 0) {
  if (IDS_DO_PAINEL.has(id)) {
    const p = painelDe(cliente, i);
    if (p) return p.querySelector(`.${id}`);
  }
  return cliente.porId.get(id) || cliente.document.getElementById(id);
}

/** Todos os descendentes com a tag pedida. */
function achar(no, tag) {
  const achados = [];
  for (const filho of no.filhos || []) {
    if (filho.tag === tag) achados.push(filho);
    achados.push(...achar(filho, tag));
  }
  return achados;
}

/** Carrega public/app.js num sandbox e devolve as funções de topo dele. */
function carregarCliente({
  urlInicial = 'http://z/', guardado = memoria(), aoBuscar = null, comUso = false,
  ordemUso = 'app-primeiro', semPainel = false,
} = {}) {
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // Os ids são estáveis: o mesmo getElementById tem que devolver o mesmo elemento, senão
  // não dá para inspecionar o que o cliente desenhou na fita.
  const porId = new Map();
  const ouvintes = new Map();   // tipo do evento → funções registradas em `document`
  const relogios = new Map();   // id → { fn, ms } dos setInterval vivos
  const fluxos = [];            // os EventSource que o cliente abriu, na ordem
  const xhrs = [];              // os XMLHttpRequest que o cliente abriu (só o painel de arquivos)
  const janela = new Map();     // tipo do evento → funções registradas em `window`
  const chamadasWindowOpen = []; // A7 (04/09): espião de window.open — #btn-uso não usa mais
  const rolagens = []; // espião de scrollIntoView — o nó, na ordem em que foi rolado
  // Consulta de mídia → resposta. Mutável de propósito: o teste do Enter troca o ponteiro
  // ENTRE duas teclas, que é como se prova que o cliente pergunta na hora e não no boot.
  const midia = {
    '(pointer: coarse)': false,
    '(display-mode: standalone)': false,
    // M1/P5 (04/09): o placeholder pergunta LARGURA, não ponteiro. `false` = largo por
    // padrão, como as duas de cima.
    '(max-width: 760px)': false,
  };
  let proximoRelogio = 0;
  const temporizadores = new Map(); // id → { fn, ms } dos setTimeout vivos
  let proximoTimer = 0;
  const contexto = {
    document: {
      // Quem tem o cursor agora — `null` no boot, como `document.activeElement` de verdade
      // antes de qualquer foco (§1.1 da fase 1 do plano).
      activeElement: null,
      getElementById: (id) => {
        if (!porId.has(id)) porId.set(id, criarElemento('div', rolagens, contexto.document));
        return porId.get(id);
      },
      createElement: (tag) => criarElemento(tag, rolagens, contexto.document),
      // Os ícones do cabeçalho de cada painel nascem `<svg>`/`<path>` (split view, fase 2):
      // o DOM de mentira não distingue namespace — o `tag` já basta para o teste inspecionar.
      // Leva o espião de rolagem igual ao `createElement`: um painel montado por aqui tem
      // que medir scroll como qualquer outro, senão o S2 passaria com a fita travada.
      createElementNS: (ns, tag) => criarElemento(tag, rolagens, contexto.document),
      // A rajada inicial da fita desenha num fragmento fora da página. Aqui ele é só mais
      // um nó: o que o teste quer saber é QUANDO o conteúdo chega na fita, não como.
      createDocumentFragment: () => criarElemento('#fragmento', rolagens),
      createTextNode: (valor) => ({ tag: '#texto', valor: String(valor), filhos: [],
        get data() { return this.valor; }, set data(v) { this.valor = String(v); } }),
      // Os ouvintes ficam guardados: é assim que o teste consegue simular o celular
      // voltando para a frente (`visibilitychange`) sem navegador nenhum.
      addEventListener: (tipo, fn) => {
        if (!ouvintes.has(tipo)) ouvintes.set(tipo, []);
        ouvintes.get(tipo).push(fn);
      },
      hidden: false,
      // Onde `aplicarTema` escreve o `data-tema`. É o único jeito de provar que a escolha do
      // tema chega ao documento NA HORA, com o painel ainda aberto.
      documentElement: criarElemento('html', rolagens),
    },
    localStorage: guardado,
    location: {
      href: urlInicial,
      origin: new URL(urlInicial).origin,
      pathname: new URL(urlInicial).pathname,
      search: new URL(urlInicial).search,
      // O hash vem da URL de partida: é por ele que a notificação entra direto na conversa
      // (`#c=<chave>`), e zerar aqui apagava justo o caminho do deep link.
      hash: new URL(urlInicial).hash,
      hostname: new URL(urlInicial).hostname,
    },
    // Histórico com PILHA de verdade. Sem ela não dá para provar a diferença entre o voltar
    // do Android caindo na lista e o voltar saindo do app: os dois são "nada acontece" para
    // um history de mentira. `saiuDoApp` marca o voltar que passou do fundo da pilha.
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
    // O painel de arquivos monta a query do upload com URLSearchParams (spec §3.4).
    URLSearchParams,
    // `userAgent` porque o diagnóstico de avisos o recorta para a lista. Sem ele o painel
    // de falha estoura antes de mostrar QUAL passo quebrou, que é o que se quer provar.
    navigator: { userAgent: 'gate-ui/1.0 (sem navegador de verdade)' },
    // O bloco de notificação encosta em window e atob no carregamento.
    // `window` guarda os ouvintes: é por eles que o teste simula o botão de voltar do
    // aparelho (`popstate`) sem navegador nenhum.
    window: {
      addEventListener: (tipo, fn) => {
        if (!janela.has(tipo)) janela.set(tipo, []);
        janela.get(tipo).push(fn);
      },
      // A7 (04/09): espião, não mais no-op cego — #btn-uso deixou de usar window.open
      // (virou <dialog>), e o gate precisa provar que ele NÃO é mais chamado.
      open: (...args) => { chamadasWindowOpen.push(args); },
    },
    atob: (t) => Buffer.from(t, 'base64').toString('binary'),
    Uint8Array,
    CSS: { escape: (s) => s },
    // O diagnóstico de avisos pergunta se a página roda como app instalado. Sem isto ele
    // estoura com ReferenceError e o painel de falha nunca chega a ser montado.
    // `addEventListener`/`removeEventListener` são no-ops de propósito: nenhum teste depende
    // do 'change' disparar sozinho — o padrão já estabelecido (`cliente.midia[...] = x`)
    // é mudar o mapa e chamar a função de pintura de novo. Sem os dois aqui, o app.js real
    // (que registra `addEventListener('change', ...)` no boot do M1/04-09) estoura no
    // carregamento e derruba o arquivo INTEIRO — não só o assert de placeholder.
    matchMedia: (consulta) => ({
      matches: Boolean(midia[String(consulta)]),
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    // `aoBuscar` deixa o teste responder por rota — é o que permite exercitar a lista de
    // abas e a faixa de jobs sem servidor nenhum no ar.
    // `opcoes` chega ao `aoBuscar` para o teste poder ler o CORPO do POST — é assim que
    // se prova qual tecla o cliente mandou, e não só que ele bateu na rota.
    // O status vem do CORPO, quando o teste pede: um corpo com `__status` faz o stub
    // responder com aquele número e derivar `ok = status < 400`. Sem a chave, tudo se
    // comporta exatamente como antes (200/ok). Foi acrescentado em 24/08 porque NENHUM
    // teste do projeto exercitava caminho de erro de HTTP, e sem isso o 409 do `#sel-effort`
    // — "essa aba não está rodando claude" — era impossível de provar.
    fetch: async (rota, opcoes = {}) => {
      const corpo = aoBuscar ? await aoBuscar(String(rota), opcoes) : { sessoes: [] };
      const status = corpo && typeof corpo === 'object' && corpo.__status ? Number(corpo.__status) : 200;
      return { ok: status < 400, status, json: async () => corpo };
    },
    // EventSource de mentira que GUARDA o que aconteceu com ele. Sem isto não dava para
    // provar que o botão de recarregar FECHA o fluxo velho antes de abrir o novo — que é a
    // diferença entre recarregar e deixar dois SSE pendurados no mesmo servidor.
    EventSource: function EventSource(rota) {
      const es = { rota: String(rota), fechado: false, close() { es.fechado = true; } };
      fluxos.push(es);
      return es;
    },
    // XMLHttpRequest de mentira (spec 2026-09-03, §3.6.3): registra `open`, `setRequestHeader`,
    // `send` e `abort`, tem `upload = {}` e deixa o TESTE disparar `upload.onprogress` e
    // `onload`. Só o painel de arquivos o usa — o `fetch` de mentira continua sendo o caminho
    // de todo o resto. Cada instância vai para `contexto.xhrs`.
    XMLHttpRequest: function XMLHttpRequest() {
      const xhr = {
        metodo: null,
        url: null,
        cabecalhos: {},
        corpo: null,
        enviado: false,
        abortado: false,
        status: 0,
        responseText: '',
        upload: {},
        onload: null,
        onerror: null,
        open(metodo, url) { xhr.metodo = metodo; xhr.url = String(url); },
        setRequestHeader(chave, valor) { xhr.cabecalhos[String(chave).toLowerCase()] = String(valor); },
        send(corpo) { xhr.corpo = corpo; xhr.enviado = true; },
        abort() { xhr.abortado = true; },
      };
      xhrs.push(xhr);
      return xhr;
    },
    // Relógios de mentira com id de verdade (nunca 0, que seria falsy e enganaria a
    // guarda do cliente). O teste roda o tique na mão e confere quantos estão de pé.
    setInterval: (fn, ms) => {
      proximoRelogio += 1;
      relogios.set(proximoRelogio, { fn, ms });
      return proximoRelogio;
    },
    // `setTimeout`/`clearTimeout` de mentira, no mesmo padrão do `setInterval` acima. Até
    // aqui o stub nunca chamava o callback e ninguém notava; a partir da fase 2 desta
    // mudança o `blur` da caixa fecha a paleta com `setTimeout(..., 120)`, e o S19(a)
    // precisa EXECUTAR esse handler para provar o §3.6 da spec — chamar `fecharPaleta`
    // direto no teste provaria a função, não o handler, que é o que pode ficar para trás.
    setTimeout: (fn, ms) => { proximoTimer += 1; temporizadores.set(proximoTimer, { fn, ms }); return proximoTimer; },
    clearInterval: (id) => { relogios.delete(id); },
    clearTimeout: (id) => { temporizadores.delete(id); },
    console,
    alert: () => {},
    confirm: () => false,
  };
  /** Move a location de mentira para `url`, resolvida contra onde ela está agora. */
  function irPara(url) {
    const u = new URL(String(url), contexto.location.href);
    Object.assign(contexto.location, {
      href: u.href, origin: u.origin, pathname: u.pathname, search: u.search,
      hash: u.hash, hostname: u.hostname,
    });
  }
  vm.createContext(contexto);
  for (const arquivo of ['traducoes.js', 'i18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  // A8/A8b/A8c/A22 (04/09) precisam de app.js E uso.js no MESMO contexto — dois <script>
  // clássicos, um documento só, exatamente como o navegador roda. `ordemUso: 'uso-primeiro'`
  // existe só como blindagem contra alguém trocar as tags de lugar (A8b); a ordem real é
  // app.js primeiro (P3-b).
  if (comUso) {
    const codigoUso = fs.readFileSync(path.join(__dirname, '..', 'public', 'uso.js'), 'utf8');
    if (ordemUso === 'uso-primeiro') {
      vm.runInContext(codigoUso, contexto, { filename: 'uso.js' });
      vm.runInContext(codigo, contexto, { filename: 'app.js' });
    } else {
      vm.runInContext(codigo, contexto, { filename: 'app.js' });
      vm.runInContext(codigoUso, contexto, { filename: 'uso.js' });
    }
  } else {
    vm.runInContext(codigo, contexto, { filename: 'app.js' });
  }
  contexto.janela = janela;
  contexto.midia = midia;
  contexto.porId = porId;
  contexto.ouvintes = ouvintes;
  contexto.relogios = relogios;
  contexto.temporizadores = temporizadores;
  contexto.fluxos = fluxos;
  contexto.xhrs = xhrs;
  contexto.chamadasWindowOpen = chamadasWindowOpen;
  contexto.rolagens = rolagens;
  // `#paleta` nascia `hidden` no `index.html` (atributo no MARKUP) — mas o DOM de mentira não
  // fazia parse de HTML (§1.5 da spec do split view): `getElementById` criava o elemento na
  // hora, sempre com `hidden: false`. Até a fase 2 daquele plano isso nunca aparecia porque
  // `abrirAba()` SEMPRE fechava e recriava o painel — e o `fecharPainel` de ontem chamava
  // `fecharPaleta()` como efeito colateral, mascarando o buraco em TODO teste que abrisse
  // alguma aba. A fase 3 introduziu o caminho "chave já aberta → só foca" (§4.2), que não
  // passa mais por ali, e o buraco virou visível: com `#paleta` "aberta" por padrão, a guarda
  // 4 do atalho global e o `paletaAberta` do `keydown` da caixa bloqueavam Alt+J/Alt+K e o
  // Enter, sem relação nenhuma com paleta de verdade.
  // Caixa de envio por painel (2026-09-09): o buraco em si deixou de existir. A `.paleta`
  // não nasce mais de `getElementById` — ela nasce por `createElement` DENTRO de
  // `criarPainel`, que já a cria com `hidden = true` (§2.1 do plano). Não há mais painel de
  // partida sem paleta fechada, então a chamada abaixo virou no-op redundante e SAIU — mas o
  // comentário fica, reescrito, porque apagá-lo apagaria a memória do conserto de ontem.
  // Split view, fase 2 (§2.5 da spec): com o painel virando objeto, `aplicar(evento)` —
  // `aplicarNoPainel(paineis.get(atual), evento)` — cairia em `paineis.get(null)` sem isto, e
  // as 176 chamadas `cliente.aplicar({...})` do gate (que hoje desenham sem abrir aba
  // nenhuma) reprovariam em bloco. O conserto é no FIXTURE, não no cliente: nasce sempre com
  // um painel de partida, a menos que o teste peça `{ semPainel: true }` (os testes de vista
  // vazia / lista, que verificam justamente a AUSÊNCIA de painel).
  if (!semPainel) {
    const painelInicial = contexto.criarPainel('aba-7', {});
    contexto.focar(painelInicial);
  }
  return contexto;
}

// ─── O espião do `execFile` ──────────────────────────────────────────────────
//
// Criar e matar aba são comandos de tmux, e os dois só se provam olhando o argv que sai —
// a ORDEM dos comandos (`send-keys` antes de `kill-window`), o socket (`-L`), e o que o
// módulo faz quando o tmux falha de cada jeito. Nada disso é observável no retorno.
//
// O espião troca `child_process.execFile` ANTES de um `require` fresco de `lib/abas.js`:
// o módulo destrutura `execFile` no topo, então quem for capturado é o espião. Sem seam
// nova no código de produção.
//
// E ele RESTAURA tudo num `finally`: `child_process` é singleton do processo, e uma
// asserção que não devolvesse o original contaminaria todas as seguintes com verde ou
// vermelho falso.
/**
 * Roda um GRUPO de asserções isolando o estouro dele.
 *
 * Sem isto, a primeira função que ainda não existe derruba o gate inteiro e esconde o
 * vermelho dos outros grupos — e é justamente a saída por grupo que prova que cada
 * asserção nova nasceu vermelha.
 */
async function grupo(rotulo, fn) {
  try {
    await fn();
    return true;
  } catch (e) {
    return ok(false, `${rotulo}: o grupo estourou — ${e.message}`);
  }
}

async function comEspiao(env, roteiro, corpo) {
  const cp = require('node:child_process');
  const original = cp.execFile;
  const antes = { ...process.env };
  const chamadas = [];
  // `roteiro` é um array de respostas, uma por chamada, na ordem em que o teste as espera.
  // Cada item: {saida} para sucesso, ou {erro: {killed?, stderr?}} para falha. Sem item
  // sobrando, devolve sucesso vazio. Assinatura fechada aqui de propósito: mock por
  // inventar em cada gate é como dois testes passam a discordar sobre o mesmo módulo.
  let i = 0;
  cp.execFile = (bin, args, opts, cb) => {
    chamadas.push([bin, args]);
    const r = roteiro[i++] || { saida: '' };
    const pronto = cb || opts;
    if (!r.erro) return pronto(null, r.saida ?? '', '');
    const e = new Error(r.erro.stderr || 'tmux falhou');
    e.killed = Boolean(r.erro.killed);
    return pronto(e, '', r.erro.stderr || '');
  };
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../lib/abas')];
  try {
    return await corpo(require('../lib/abas'), chamadas);
  } finally {
    cp.execFile = original;
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
    delete require.cache[require.resolve('../lib/abas')];   // a próxima asserção pega o módulo limpo
  }
}

// ─── Parte A ─────────────────────────────────────────────────────────────────

async function parteA() {
  console.log('\n── Parte A: markdown do cliente (offline) ──\n');
  let tudoOk = true;
  // `tudoOk &= await grupo(...)` NÃO serve: `a &= expr` lê `a` ANTES de avaliar `expr`, e a
  // reatribuição no fim apagava os ❌ que o próprio grupo tinha acabado de registrar. O
  // gate saía VERDE com quinze vermelhos na tela.
  const rodarGrupo = async (rotulo, fn) => { if (!await grupo(rotulo, fn)) tudoOk = false; };
  const cliente = carregarCliente();
  const render = (texto) => {
    const raiz = criarElemento('div');
    cliente.markdown(texto, raiz);
    return raiz;
  };

  // Segurança primeiro: é o motivo de existir um renderizador próprio.
  const bruto = render('Olha isto: <img src=x onerror="alert(1)"> e <script>alert(2)</script>');
  tudoOk &= ok(achar(bruto, 'img').length === 0 && achar(bruto, 'script').length === 0,
    'HTML cru do agente não vira elemento — só texto');
  tudoOk &= ok(bruto.textContent.includes('<img src=x onerror="alert(1)">'),
    'o HTML cru continua legível como texto');

  const perigoso = render('clique [aqui](javascript:alert(1)) agora');
  tudoOk &= ok(achar(perigoso, 'a').length === 0, 'link `javascript:` não vira <a>');
  const seguro = render('veja [a doc](https://exemplo.com/x)');
  const links = achar(seguro, 'a');
  tudoOk &= ok(links.length === 1 && links[0].href === 'https://exemplo.com/x',
    'link https vira <a> com href e rel=noopener');
  tudoOk &= ok(links[0] && links[0].rel === 'noopener noreferrer', 'link externo leva rel de segurança');

  // ── URL solta vira link, e todo link ganha o copiar (24/08) ───────────────
  //
  // Até aqui SÓ `[rótulo](url)` virava <a>. O agente escreve URL solta o tempo todo, e no
  // celular ela ficava texto puro: não abria, não copiava. Agora ela vira link — e com isso
  // o toque longo do Android já oferece "copiar endereço" de graça. O chip ⧉ do lado existe
  // porque ninguém descobre toque longo sozinho.
  const solto = render('sobe em https://exemplo.com:7879/jobs e confere');
  const linkSolto = achar(solto, 'a');
  tudoOk &= ok(linkSolto.length === 1 && linkSolto[0].href === 'https://exemplo.com:7879/jobs',
    `URL escrita solta no texto vira <a> (href=${linkSolto[0] && linkSolto[0].href})`);
  tudoOk &= ok(linkSolto[0] && linkSolto[0].rel === 'noopener noreferrer' && linkSolto[0].target === '_blank',
    'e leva as mesmas travas do link markdown — rel de segurança e aba nova');

  // O detalhe que mais morde: a pontuação da FRASE não é da URL. Sem isto o link carrega o
  // ponto final dentro e não abre, e ninguém entende por quê.
  for (const [frase, esperado] of [
    ['abre https://exemplo.com/a.', 'https://exemplo.com/a'],
    ['abre https://exemplo.com/a, depois volta', 'https://exemplo.com/a'],
    ['abre https://exemplo.com/a; agora', 'https://exemplo.com/a'],
    ['abre https://exemplo.com/a! agora', 'https://exemplo.com/a'],
    ['(veja https://exemplo.com/a) e pronto', 'https://exemplo.com/a'],
    ['manda pro mailto:pessoa@exemplo.com.', 'mailto:pessoa@exemplo.com'],
  ]) {
    const achados = achar(render(frase), 'a');
    tudoOk &= ok(achados.length === 1 && achados[0].href === esperado,
      `"${frase}" → href ${achados[0] && achados[0].href}`);
  }
  // E o que É da URL fica: ponto no meio do caminho, query e âncora.
  const cheia = achar(render('vai em https://ex.com/a.b/c?x=1&y=2#topo agora'), 'a');
  tudoOk &= ok(cheia.length === 1 && cheia[0].href === 'https://ex.com/a.b/c?x=1&y=2#topo',
    `ponto no meio, query e âncora continuam sendo da URL (${cheia[0] && cheia[0].href})`);

  // URL dentro de crase é CÓDIGO, não link — a alternativa da crase consome o trecho antes.
  const naCrase = render('roda `curl https://exemplo.com/a` no terminal');
  tudoOk &= ok(achar(naCrase, 'a').length === 0 && achar(naCrase, 'code').length === 1,
    'URL dentro de `código` continua sendo código, não vira link');
  // E `[rótulo](url)` continua ganhando: o `[` aparece antes do `http` na string.
  const comRotulo = achar(render('veja [a doc](https://exemplo.com/x) hoje'), 'a');
  tudoOk &= ok(comRotulo.length === 1 && comRotulo[0].textContent === 'a doc',
    'link markdown continua vencendo a URL solta — o rótulo sobrevive');

  // O botão. Ele não pode reusar `.copiar`: essa classe é `position:absolute` e some sob
  // `@media (hover: hover)` por uma regra de FILHO DIRETO que nunca alcançaria um neto.
  const chips = achar(solto, 'button').filter((b) => String(b.className).includes('copiar-link'));
  tudoOk &= ok(chips.length === 1, 'cada link ganha um botão de copiar do lado');
  tudoOk &= ok(chips[0] && chips[0].className === 'copiar-link',
    `o chip NÃO usa a classe .copiar, que é absoluta e escondida por hover (${chips[0] && chips[0].className})`);
  tudoOk &= ok(chips[0] && String(chips[0].getAttribute('aria-label')).includes('exemplo.com'),
    'e ele diz o que copia por aria-label, não por title (no celular não há mouse parado)');
  // Dois links na mesma linha são dois chips, cada um com o SEU endereço.
  const dois = render('um https://a.exemplo.com/1 e outro https://b.exemplo.com/2 aqui');
  const doisChips = achar(dois, 'button').filter((b) => String(b.className).includes('copiar-link'));
  tudoOk &= ok(achar(dois, 'a').length === 2 && doisChips.length === 2,
    'dois links na mesma linha viram dois chips');

  // O que o chip copia sai do link NA HORA do clique, e é o endereço — não o rótulo.
  let copiadoDoChip = null;
  cliente.navigator.clipboard = { writeText: async (t) => { copiadoDoChip = t; } };
  const comChip = render('veja [a doc](https://exemplo.com/x) hoje');
  // Sem o `?.`, um gate que rodasse contra um cliente SEM o chip estouraria com TypeError em
  // vez de ficar vermelho — jeito muito pior de dizer a mesma coisa.
  await achar(comChip, 'button').filter((b) => String(b.className).includes('copiar-link'))[0]?.onclick();
  await new Promise((r) => setTimeout(r, 0));
  tudoOk &= ok(copiadoDoChip === 'https://exemplo.com/x',
    `o chip copia o ENDEREÇO do link, não o rótulo (copiou "${copiadoDoChip}")`);

  // Esquema que não serve continua não virando link nenhum — nem chip.
  const arquivoCodex = render('Diagnóstico: [server.js](/home/voce/projetos/cockpit-agentes/server.js:859) busca o cwd.');
  tudoOk &= ok(achar(arquivoCodex, 'code')[0]?.textContent === 'server.js:859'
    && !arquivoCodex.textContent.includes('/home/') && achar(arquivoCodex, 'a').length === 0,
    'referência local do Codex mostra arquivo e linha, sem Markdown cru nem rota HTTP inválida');
  await achar(arquivoCodex, 'button')[0]?.onclick();
  tudoOk &= ok(copiadoDoChip === '/home/voce/projetos/cockpit-agentes/server.js:859',
    'referência local copia o caminho completo com a linha');
  const comEspacos = render('[Meu arquivo.md](</home/y/Meu Projeto/Meu arquivo.md:12>)');
  tudoOk &= ok(achar(comEspacos, 'code')[0]?.textContent === 'Meu arquivo.md:12',
    'referência entre ângulos aceita espaços no caminho');
  await achar(comEspacos, 'button')[0]?.onclick();
  tudoOk &= ok(copiadoDoChip === '/home/y/Meu Projeto/Meu arquivo.md:12',
    'copiar preserva os espaços sem os delimitadores Markdown');
  tudoOk &= ok(achar(render('[app.js:12](/tmp/app.js:12)'), 'code')[0]?.textContent === 'app.js:12',
    'linha já presente no rótulo não aparece duplicada');
  tudoOk &= ok(achar(render('[ruim](<javascript:alert(1)>)'), 'a').length === 0,
    'destino entre ângulos mantém o bloqueio de esquemas perigosos');

  // Esquema que não serve continua não virando link nenhum — nem chip.
  const semEsquema = render('clique [aqui](javascript:alert(1)) agora');
  tudoOk &= ok(achar(semEsquema, 'button').length === 0,
    'esquema recusado não vira link e por isso também não ganha chip');

  // Cerca de crase DUPLA — é assim que markdown mostra um trecho que CONTÉM crase, e é o
  // que qualquer agente escreve numa tabela explicando markdown. O renderizador não sabia
  // ler: casava o par errado (crase, espaço, crase) e deixava o miolo solto na frase. Com o
  // autolink, esse miolo solto virava LINK — foi o que se viu no celular em 24/08.
  const craseDupla = render('escreve `` `curl https://ex.com/a` `` e roda');
  tudoOk &= ok(achar(craseDupla, 'a').length === 0,
    'crase dupla é código inteiro — o miolo não escapa e não vira link');
  tudoOk &= ok(achar(craseDupla, 'code').length === 1
    && achar(craseDupla, 'code')[0].textContent === '`curl https://ex.com/a`',
    `e o conteúdo sai com as crases internas (${achar(craseDupla, 'code')[0] && achar(craseDupla, 'code')[0].textContent})`);
  // A regra do CommonMark: um espaço de cada lado é afastamento da cerca, não conteúdo. Sem
  // ela não dá para mostrar UMA crase sozinha — as duas colariam na cerca.
  const craseSozinha = render('use `` ` `` para crase');
  tudoOk &= ok(achar(craseSozinha, 'code').length === 1
    && achar(craseSozinha, 'code')[0].textContent === '`',
    'e um espaço de cada lado é afastamento da cerca, não conteúdo');
  // Crase simples continua como sempre foi.
  const craseSimples = render('roda `curl https://ex.com/a` no terminal');
  tudoOk &= ok(achar(craseSimples, 'code').length === 1 && achar(craseSimples, 'a').length === 0,
    'crase simples continua sendo código, sem regressão');

  // ── Código que é SÓ uma URL vira clicável (24/08, print do celular) ───────
  //
  // O agente escreveu `http://192.168.0.10:3006` entre crases e o endereço saiu cinza e
  // morto no celular. Crase ganha do autolink na INLINE, então o ramo de código precisava
  // aprender a olhar o próprio conteúdo. A cara de código FICA — quem escreveu quis dizer
  // "isto é literal"; o que muda é poder tocar.
  const soUrl = render('sobe o container no `http://192.168.0.10:3006` e testa');
  const linkDoCodigo = achar(soUrl, 'a');
  tudoOk &= ok(linkDoCodigo.length === 1 && linkDoCodigo[0].href === 'http://192.168.0.10:3006',
    `código que é só uma URL vira <a> (href=${linkDoCodigo[0] && linkDoCodigo[0].href})`);
  tudoOk &= ok(achar(soUrl, 'code').length === 1
    && achar(soUrl, 'code')[0].textContent === 'http://192.168.0.10:3006',
    'e o <code> continua lá por dentro — não perde a cara de código');
  tudoOk &= ok(linkDoCodigo[0] && linkDoCodigo[0].target === '_blank'
    && linkDoCodigo[0].rel === 'noopener noreferrer',
    'com as mesmas travas de qualquer link daqui');
  const chipDoCodigo = achar(soUrl, 'button').filter((b) => String(b.className).includes('copiar-link'));
  tudoOk &= ok(chipDoCodigo.length === 1, 'e ganha o chip de copiar como todo link');
  // http, https e mailto — os três esquemas que criarLink aceita.
  for (const [frase, esperado] of [
    ['veja `https://ex.com/a` hoje', 'https://ex.com/a'],
    ['manda `mailto:pessoa@exemplo.com` agora', 'mailto:pessoa@exemplo.com'],
  ]) {
    const achados = achar(render(frase), 'a');
    tudoOk &= ok(achados.length === 1 && achados[0].href === esperado,
      `"${frase}" → href ${achados[0] && achados[0].href}`);
  }
  // O limite: só o conteúdo INTEIRO. URL no meio de um comando continua código puro, e é
  // o caso que mais aparece — `curl <url>`, `git clone <url>`.
  const urlNoMeio = render('roda `curl -s https://ex.com/a` no terminal');
  tudoOk &= ok(achar(urlNoMeio, 'a').length === 0 && achar(urlNoMeio, 'code').length === 1,
    'URL no MEIO de um comando entre crases continua código, sem link');
  // Esquema recusado dentro de código não vira link nenhum, nem chip.
  const esquemaRuim = render('nunca `javascript:alert(1)` aqui');
  tudoOk &= ok(achar(esquemaRuim, 'a').length === 0
    && achar(esquemaRuim, 'button').filter((b) => String(b.className).includes('copiar-link')).length === 0,
    'esquema recusado dentro de código não vira link nem ganha chip');
  // Crase DUPLA cujo conteúdo é só uma URL segue a mesma regra.
  const duplaSoUrl = render('escreve `` https://ex.com/a `` assim');
  tudoOk &= ok(achar(duplaSoUrl, 'a').length === 1
    && achar(duplaSoUrl, 'a')[0].href === 'https://ex.com/a',
    'crase dupla com só uma URL dentro também vira link (o afastamento da cerca sai antes)');

  const enfase = render('isto é **forte**, isto é `código` e isto é *torto*');
  tudoOk &= ok(achar(enfase, 'strong').length === 1, 'negrito vira <strong>');
  tudoOk &= ok(achar(enfase, 'code').length === 1, 'crase vira <code>');
  tudoOk &= ok(achar(enfase, 'em').length === 1, 'asterisco simples vira <em>');

  const codigo = render('antes\n\n```js\nconst a = 1;\nif (a < 2) { ok(); }\n```\n\ndepois');
  const blocos = achar(codigo, 'code').filter((c) => c.textContent.includes('const a = 1;'));
  tudoOk &= ok(blocos.length === 1, 'bloco cercado vira <pre><code>');
  tudoOk &= ok(blocos[0].textContent === 'const a = 1;\nif (a < 2) { ok(); }',
    'o código sai idêntico ao que entrou, com `<` e tudo');
  tudoOk &= ok(achar(codigo, 'p').length === 2, 'o texto ao redor do bloco vira parágrafo');

  const lista = render('- um\n- dois\n- três');
  tudoOk &= ok(achar(lista, 'ul').length === 1 && achar(lista, 'li').length === 3, 'lista vira <ul> com 3 <li>');
  const numerada = render('1. um\n2. dois');
  tudoOk &= ok(achar(numerada, 'ol').length === 1 && achar(numerada, 'li').length === 2, 'lista numerada vira <ol>');

  const tabela = render('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
  tudoOk &= ok(achar(tabela, 'table').length === 1, 'tabela GFM vira <table>');
  tudoOk &= ok(achar(tabela, 'th').length === 2 && achar(tabela, 'td').length === 4,
    'a tabela tem 2 cabeçalhos e 4 células');

  const titulo = render('# Título\n\ntexto');
  tudoOk &= ok(achar(titulo, 'h3').length === 1 && achar(titulo, 'h1').length === 0,
    'título do agente vira h3 — o h1 da página é o nome da conversa');

  const citacao = render('> pensa nisso\n> com calma');
  tudoOk &= ok(achar(citacao, 'blockquote').length === 1, 'citação vira <blockquote>');

  // Bloco de código sem fechamento acontece o tempo todo: o turno ainda está escrevendo.
  const cortado = render('olha\n\n```py\nx = 1');
  tudoOk &= ok(achar(cortado, 'code').length === 1, 'bloco de código não fechado não trava a renderização');

  // /clear e /compact viram régua, não bolha: a fita é lida do disco e continua mostrando
  // tudo que veio antes do corte.
  const fita = porIdDe(cliente, 'fita');
  fita.filhos = [];
  cliente.aplicar({ tipo: 'humano', texto: '/clear' });
  const marcas = fita.filhos.filter((f) => f.className === 'corte');
  tudoOk &= ok(marcas.length === 1 && !fita.filhos.some((f) => f.className === 'bolha-eu'),
    '/clear vira marca de corte, não bolha de mensagem');
  tudoOk &= ok(marcas[0].textContent.includes('não lembra'),
    'a marca diz o que aconteceu com a memória do agente');

  fita.filhos = [];
  cliente.aplicar({ tipo: 'humano', texto: '/compact agora' });
  tudoOk &= ok(fita.filhos.some((f) => f.className === 'corte'), '/compact também vira marca');

  fita.filhos = [];
  cliente.aplicar({ tipo: 'humano', texto: 'me explica o /clear' });
  tudoOk &= ok(fita.filhos.some((f) => f.className === 'bolha-eu'),
    'mensagem que só CITA /clear continua sendo mensagem');

  // A fita mostrava o raciocínio inteiro; o dono quer comando e resposta final. Fala
  // seguida de ferramenta é o agente dizendo o que vai fazer — recolhe, não apaga.
  fita.filhos = [];
  cliente.aplicar({ tipo: 'texto', texto: 'vou olhar o arquivo primeiro' });
  cliente.aplicar({ tipo: 'ferramenta', id: 't-1', nome: 'Read', entrada: { file_path: '/x/y.js' } });
  cliente.aplicar({ tipo: 'texto', texto: 'achei: o bug é a linha 12' });
  const falas = fita.filhos.filter((f) => f.tag === 'details' && /(^|\s)fala(\s|$)/.test(f.className));
  tudoOk &= ok(falas.length === 2, `as duas falas do turno estão na fita (${falas.length})`);
  tudoOk &= ok(falas[0].className.includes('fala-nota') && falas[0].open === false,
    'a fala que veio antes da ferramenta fica recolhida como nota de trabalho');
  tudoOk &= ok(falas[0].textContent.includes('vou olhar o arquivo primeiro'),
    'e o raciocínio continua lá dentro — recolher não é apagar');
  const resumo = falas[0].filhos.find((f) => f.className === 'fala-resumo');
  tudoOk &= ok(Boolean(resumo) && resumo.textContent.includes('raciocínio'),
    'com uma linha clicável dizendo o que é');
  tudoOk &= ok(Boolean(resumo) && resumo.filhos.some((f) => f.className === 'copiar'),
    'o botão de copiar vai para o resumo, para funcionar com a nota fechada');
  tudoOk &= ok(falas[1].className === 'fala' && falas[1].open === true,
    'a última fala do turno, que não é seguida de ferramenta, continua aberta');
  tudoOk &= ok(fita.filhos.some((f) => f.tag === 'details' && f.className === 'ferramenta'),
    'e o cartão da ferramenta continua visível, com o comando');

  // Só ferramenta recolhe. Fala seguida da PERGUNTA seguinte é resposta, e fica aberta.
  fita.filhos = [];
  cliente.aplicar({ tipo: 'humano', texto: 'começa outro turno' });
  cliente.aplicar({ tipo: 'texto', texto: 'resposta única do turno' });
  cliente.aplicar({ tipo: 'humano', texto: 'e agora?' });
  cliente.aplicar({ tipo: 'texto', texto: 'agora isto' });
  tudoOk &= ok(fita.filhos.filter((f) => f.className === 'fala').length === 2
    && !fita.filhos.some((f) => String(f.className).includes('fala-nota')),
    'turno sem ferramenta nenhuma não recolhe nada');

  // Rajada inicial: abrir uma aba despeja o histórico inteiro. Desenhar direto na página
  // fazia a conversa desfilar no celular antes de dar para digitar.
  const rajada = carregarCliente();
  const fitaRajada = porIdDe(rajada, 'fita');
  fitaRajada.filhos = [];
  rajada.segurarFita();
  rajada.aplicar({ tipo: 'historico_cortado' });
  for (let i = 0; i < 50; i += 1) rajada.aplicar({ tipo: 'humano', texto: `linha ${i}` });
  tudoOk &= ok(fitaRajada.filhos.length === 0,
    'durante a rajada inicial nada toca a página — o desenho vai para um fragmento');
  rajada.aplicar({ tipo: 'sincronizado', turnoEmAndamento: false });
  tudoOk &= ok(fitaRajada.filhos.length > 0, 'e o `sincronizado` despeja tudo de uma vez');
  rajada.aplicar({ tipo: 'humano', texto: 'depois da rajada' });
  tudoOk &= ok(fitaRajada.filhos.some((f) => f.textContent === 'depois da rajada'),
    'passada a rajada, o evento novo volta a entrar direto na fita');

  // ── Bolha pendente: a mensagem do usuário aparecia DUAS vezes ────────────────
  // O cockpit desenha a bolha na hora do envio; ~1s depois o CLI grava o mesmo prompt no
  // .jsonl e o SSE devolve o MESMO texto como evento `humano`. A segunda bolha era isso.
  const env = carregarCliente();
  const fitaEnv = porIdDe(env, 'fita');
  const bolhasDe = (f) => f.filhos.filter((x) => String(x.className).includes('bolha-eu'));

  fitaEnv.filhos = [];
  const minha = env.marcarPendente(env.bolha('bolha-eu', 'roda os testes'), 'roda os testes');
  env.aplicar({ tipo: 'humano', texto: 'roda os testes' });
  tudoOk &= ok(bolhasDe(fitaEnv).length === 1,
    `o mesmo texto voltando do disco absorve a bolha em vez de duplicar (${bolhasDe(fitaEnv).length})`);
  tudoOk &= ok(!String(minha.className).includes('bolha-pendente'),
    'e ela deixa de ser pendente: virou a bolha definitiva');

  // Armadilha #21: `send-keys` CONCATENA com o que já estava digitado na aba, então o que
  // volta do disco pode não ser igual ao que saiu. Casar por posição erraria aqui.
  fitaEnv.filhos = [];
  const grudada = env.marcarPendente(env.bolha('bolha-eu', 'e agora?'), 'e agora?');
  env.aplicar({ tipo: 'humano', texto: 'rascunho que estava na caixa e agora?' });
  tudoOk &= ok(bolhasDe(fitaEnv).length === 1, 'texto concatenado com o rascunho ainda casa');
  tudoOk &= ok(grudada.textContent === 'rascunho que estava na caixa e agora?',
    'e a bolha passa a mostrar o que o agente REALMENTE leu, com o rascunho grudado');

  fitaEnv.filhos = [];
  env.marcarPendente(env.bolha('bolha-eu', 'meu texto'), 'meu texto');
  env.aplicar({ tipo: 'humano', texto: 'outra coisa qualquer' });
  tudoOk &= ok(bolhasDe(fitaEnv).length === 2,
    'mensagem de outro texto continua virando bolha nova — absorver não é engolir');

  // Pendente que nunca casa (a aba engoliu o texto) não pode ficar presa para sempre.
  fitaEnv.filhos = [];
  const velha = env.marcarPendente(env.bolha('bolha-eu', 'sumiu'), 'sumiu', Date.now() - 61000);
  env.aplicar({ tipo: 'humano', texto: 'sumiu' });
  tudoOk &= ok(!String(velha.className).includes('bolha-pendente'),
    'pendente de mais de 60s expira e volta a ser bolha normal');
  tudoOk &= ok(bolhasDe(fitaEnv).length === 2, 'e não absorve mais nada — o texto novo é outro turno');

  // /clear é o caso torto: a bolha otimista existe, mas o evento vira régua, não bolha.
  fitaEnv.filhos = [];
  env.marcarPendente(env.bolha('bolha-eu', '/clear'), '/clear');
  env.aplicar({ tipo: 'humano', texto: '/clear' });
  tudoOk &= ok(bolhasDe(fitaEnv).length === 0 && fitaEnv.filhos.some((f) => f.className === 'corte'),
    'enviar /clear do celular deixa só a régua de corte, sem bolha órfã');

  // ── Hora das mensagens dentro da conversa ────────────────────────────────────
  //
  // O dado sempre existiu (`timestamp` em cada linha do .jsonl) e era descartado. O que
  // este bloco guarda: a conversão é para o fuso do APARELHO (quem usa viaja), a hora não
  // se repete dentro do mesmo minuto, e evento sem `timestamp` continua virando bolha.
  console.log('\n  · hora das mensagens');
  const TS_UTC = '2026-08-22T22:50:21.752Z';
  const dd = (n) => String(n).padStart(2, '0');
  const localDe = (iso) => {
    const d = new Date(iso);
    return `${dd(d.getHours())}:${dd(d.getMinutes())}`;
  };
  const hh = carregarCliente();
  const fitaHH = porIdDe(hh, 'fita');
  const horasDe = (f) => f.filhos.filter((x) => String(x.className).includes('hora-fita'));

  hh.limparFita();
  hh.aplicar({ tipo: 'humano', texto: 'que horas são?', quando: TS_UTC });
  let horas = horasDe(fitaHH);
  tudoOk &= ok(horas.length === 1 && horas[0].textContent === localDe(TS_UTC),
    `a bolha ganha a hora do timestamp, no fuso do aparelho (${horas[0] && horas[0].textContent} de ${TS_UTC})`);
  // A prova de que NÃO é o UTC cru. O servidor roda em UTC, então aqui a diferença só
  // aparece forçando o fuso — que é exatamente o caso que motivou o recurso: o aparelho do
  // aparelho viajando não está no fuso do servidor. `2026-08-22T22:50Z` é 19:50 em São Paulo.
  const fusoReal = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  const viajando = carregarCliente();
  viajando.aplicar({ tipo: 'humano', texto: 'que horas são aí?', quando: TS_UTC });
  const horaViagem = porIdDe(viajando, 'fita').filhos
    .filter((x) => String(x.className).includes('hora-fita'))[0];
  tudoOk &= ok(horaViagem && horaViagem.textContent === '19:50',
    `22:50 UTC vira 19:50 no fuso do aparelho, não a hora crua do arquivo (${horaViagem && horaViagem.textContent})`);
  if (fusoReal === undefined) delete process.env.TZ; else process.env.TZ = fusoReal;
  tudoOk &= ok(horas[0] && horas[0].dataset.lado === 'eu',
    'do lado da bolha a que pertence');

  hh.aplicar({ tipo: 'texto', texto: 'quase 51', quando: '2026-08-22T22:50:59.000Z' });
  tudoOk &= ok(horasDe(fitaHH).length === 1,
    'outra mensagem no MESMO minuto não repete a hora — 60 bolhas com 60 horas é poluição');

  hh.aplicar({ tipo: 'humano', texto: 'e agora?', quando: '2026-08-22T22:51:02.000Z' });
  horas = horasDe(fitaHH);
  tudoOk &= ok(horas.length === 2 && horas[1].textContent === localDe('2026-08-22T22:51:02.000Z'),
    'e o minuto seguinte mostra a hora de novo');

  // Fala do agente também é conversa e também carrega hora — do lado dela.
  hh.limparFita();
  hh.aplicar({ tipo: 'texto', texto: 'respondendo', quando: TS_UTC });
  tudoOk &= ok(horasDe(fitaHH).length === 1 && horasDe(fitaHH)[0].dataset.lado === 'agente',
    'a fala do agente ganha hora do lado dela');

  // Arquivo velho / linha torta: sem `timestamp` a bolha sai como sempre saiu.
  hh.limparFita();
  hh.aplicar({ tipo: 'humano', texto: 'linha antiga, sem hora nenhuma' });
  tudoOk &= ok(horasDe(fitaHH).length === 0,
    'evento sem timestamp não inventa hora');
  tudoOk &= ok(fitaHH.filhos.some((x) => String(x.className).includes('bolha-eu')),
    'e continua virando bolha normalmente — sem hora não é sem mensagem');
  hh.limparFita();
  hh.aplicar({ tipo: 'humano', texto: 'hora torta', quando: 'nao-e-data' });
  tudoOk &= ok(horasDe(fitaHH).length === 0 && fitaHH.filhos.length === 1,
    'timestamp ilegível também degrada para "sem hora", não para bolha quebrada');

  // A bolha pendente nasce com a hora do ENVIO (o disco ainda não tem nada) e o evento
  // que volta corrige, no mesmo ponto em que ele já absorve a bolha.
  hh.limparFita();
  const saiuEm = Date.parse('2026-08-22T22:40:00.000Z');
  const naFila = hh.bolha('bolha-eu', 'roda o lint', saiuEm);
  hh.marcarPendente(naFila, 'roda o lint', Date.now(), true);
  tudoOk &= ok(horasDe(fitaHH).length === 1 && horasDe(fitaHH)[0].textContent === localDe(saiuEm),
    'mensagem na fila mostra a hora do ENVIO, que é a que ele precisa ver');
  hh.aplicar({ tipo: 'humano', texto: 'roda o lint', quando: '2026-08-22T22:47:33.000Z' });
  tudoOk &= ok(fitaHH.filhos.filter((x) => String(x.className).includes('bolha-eu')).length === 1,
    'e ela continua sendo UMA bolha depois de absorvida');
  tudoOk &= ok(horasDe(fitaHH).length === 1
    && horasDe(fitaHH)[0].textContent === localDe('2026-08-22T22:47:33.000Z'),
    'com a hora corrigida para a que o CLI gravou, sem hora órfã sobrando');

  // /clear vira régua e não bolha: a hora que nasceu com a pendente sai junto.
  hh.limparFita();
  hh.marcarPendente(hh.bolha('bolha-eu', '/clear', saiuEm), '/clear', Date.now());
  hh.aplicar({ tipo: 'humano', texto: '/clear', quando: TS_UTC });
  tudoOk &= ok(horasDe(fitaHH).length === 0,
    'enviar /clear não deixa hora órfã na fita');

  // ── Hora na lista (fora da conversa) ─────────────────────────────────────────
  // Sai do `atualizadoEm` que a lista já recebe. Formato: hoje só a hora, outro dia o dia.
  const agoraHH = localDe(Date.now());
  tudoOk &= ok(hh.quandoCurto(Date.now()) === agoraHH,
    `conversa de hoje mostra só a hora (${hh.quandoCurto(Date.now())})`);
  tudoOk &= ok(/^\d{2}\/\d{2}$/.test(hh.quandoCurto(Date.now() - 3 * 86400000)),
    `de outro dia mostra dd/mm, que cabe na mesma largura (${hh.quandoCurto(Date.now() - 3 * 86400000)})`);
  tudoOk &= ok(hh.quandoCurto(null) === '' && hh.quandoCurto(0) === '',
    'sem `atualizadoEm` não sai nada — nem placeholder feio');

  // ── turno_fim: a chamada de `marcarLido` existia, a função NÃO ───────────────
  // Ela morreu no corte das 513 linhas de 21/08. O ReferenceError estourava ANTES de
  // fechar os cartões e de `marcarOcupado(false)`: turno que acabava sozinho deixava o
  // "trabalhando" na tela e o Enviar travado até reabrir a aba.
  const fim = carregarCliente();
  fim.aplicar({ tipo: 'ferramenta', id: 't-9', nome: 'Bash', entrada: { command: 'npm test' } });
  fim.marcarOcupado(fim.painelAtual(), true);
  // Mudou em 22/08: turno rodando NÃO trava mais o Enviar (mensagem na fila). O que este
  // bloco continua guardando é o turno_fim não estourar — ver a seção da fila mais abaixo.
  tudoOk &= ok(porIdDe(fim, 'btn-enviar').disabled === false,
    'turno rodando não trava o Enviar');
  let quebrou = null;
  try { fim.aplicar({ tipo: 'turno_fim', aba: 'aba-1' }); } catch (erro) { quebrou = erro; }
  tudoOk &= ok(quebrou === null, `turno_fim não estoura (${quebrou ? quebrou.message : 'sem erro'})`);
  tudoOk &= ok(porIdDe(fim, 'btn-enviar').disabled === false, 'e o Enviar segue de pé depois dele');
  tudoOk &= ok(!porIdDe(fim, 'fita').filhos.some((f) => f.className === 'trabalhando'),
    'o "trabalhando" some da fita junto');
  tudoOk &= ok(porIdDe(fim, 'fita').querySelectorAll('[data-estado="rodando"]').length === 0
    && porIdDe(fim, 'fita').querySelectorAll('[data-estado="parada"]').length === 1,
    'e a ferramenta que ficou sem resultado é marcada como parada, não fica girando para sempre');

  // ── Mensagem na fila, igual ao terminal (22/08) ──────────────────────────────
  //
  // O servidor NUNCA travou por turno rodando (decisão do dono, D13) — quem travava era o
  // cliente, em duas linhas. Destravá-las é o recurso; o resto deste bloco é o que impede
  // o recurso de virar bug.
  console.log('\n  · mensagem na fila');
  const fila = carregarCliente();
  fila.marcarOcupado(fila.painelAtual(), true);
  tudoOk &= ok(porIdDe(fila, 'btn-enviar').disabled === false,
    'com turno rodando dá para escrever: o texto entra na fila do CLI');
  tudoOk &= ok(porIdDe(fila, 'fita').filhos.some((f) => f.className === 'trabalhando'),
    'e o "trabalhando" continua na tela — turno rodando não virou "nada acontecendo"');

  // A trava que FICA: menu aberto na TUI. Não é concorrência, é a armadilha #6/#25 — cada
  // letra vira tecla de menu e escolhe uma opção, provavelmente a errada.
  fila.marcarPergunta(fila.painelAtual(), true);
  tudoOk &= ok(porIdDe(fila, 'btn-enviar').disabled === true,
    'com pergunta aberta o Enviar CONTINUA travado (texto viraria tecla de menu)');
  fila.marcarPergunta(fila.painelAtual(), false);
  tudoOk &= ok(porIdDe(fila, 'btn-enviar').disabled === false,
    'e destrava quando a pergunta fecha, mesmo com o turno ainda rodando');

  // A bolha precisa DIZER que está na fila; senão o usuário escreve e não sabe se saiu. Este
  // trecho passa pelo `enviar()` de verdade, e não por `marcarPendente` na mão: o que se
  // quer provar é que QUEM ENVIA sabe distinguir "vai ser lida agora" de "entrou na fila".
  const envios = [];
  const envio = carregarCliente({
    guardado: memoria(),
    aoBuscar: (rota) => {
      envios.push(String(rota));
      if (String(rota).startsWith('api/abas/aba-7/turnos')) return { enviado: true };
      if (String(rota).startsWith('api/abas')) {
        return { abas: [{
          chave: 'aba-7', titulo: 'cockpit', cwd: '/home/y/projetos/cockpit-agentes',
          temClaude: true, rodando: false, sessaoId: 'sess-fila', atualizadoEm: 1,
        }] };
      }
      return { painel: true, jobs: [] };
    },
  });
  await envio.carregarAbas();
  await envio.abrirAba('aba-7');
  const fitaEnvio = porIdDe(envio, 'fita');
  const ultimaBolha = () => fitaEnvio.filhos.filter((x) => String(x.className).includes('bolha-eu')).pop();

  envio.marcarOcupado(envio.painelAtual(), true);
  porIdDe(envio, 'entrada').value = 'roda o lint também';
  await envio.enviar(envio.painelAtual());
  const enfileirada = ultimaBolha();
  tudoOk &= ok(envios.some((r) => r.startsWith('api/abas/aba-7/turnos')),
    'com turno rodando o texto SAI mesmo — vai para a fila do CLI, não morre no cliente');
  tudoOk &= ok(enfileirada && enfileirada.dataset.fila === '1',
    'e a bolha dele nasce marcada como na fila');

  envio.marcarOcupado(envio.painelAtual(), false);
  porIdDe(envio, 'entrada').value = 'e isto aqui';
  await envio.enviar(envio.painelAtual());
  tudoOk &= ok(ultimaBolha().dataset.fila === undefined,
    'com a aba livre a bolha não ganha a marca — não é fila, é o turno dela');

  const antesDeAbsorver = fitaEnvio.filhos.filter((x) => String(x.className).includes('bolha-eu')).length;
  envio.aplicar({ tipo: 'humano', texto: 'roda o lint também' });
  const depoisDeAbsorver = fitaEnvio.filhos.filter((x) => String(x.className).includes('bolha-eu')).length;
  tudoOk &= ok(depoisDeAbsorver === antesDeAbsorver,
    `a enfileirada é ABSORVIDA quando o evento volta do disco, não duplicada (${antesDeAbsorver} → ${depoisDeAbsorver})`);
  tudoOk &= ok(enfileirada.dataset.fila === undefined
    && !String(enfileirada.className).includes('bolha-pendente'),
    'e ela perde a marca de fila junto com a de pendente: saiu da fila, virou turno');

  // ── A guarda que o recurso EXIGE: send-keys de dois envios não se intercalam ──
  //
  // Um envio é `send-keys -l` (o texto), 150ms, `send-keys Enter`. Dois POSTs concorrentes
  // na mesma aba intercalam esses passos e as duas mensagens viram uma só — armadilha #21,
  // `send-keys` concatena com o que já está na caixa. Sem esta fila, destravar o Enviar
  // CRIA o bug em vez de entregar o recurso.
  const moduloAbas = require('../lib/abas');
  const trilha = [];
  const envioDeMentira = (marca) => async () => {
    trilha.push(`${marca}-texto`);
    await new Promise((r) => setTimeout(r, 25));   // a pausa entre o texto e o Enter
    trilha.push(`${marca}-enter`);
  };
  await Promise.all([
    moduloAbas.enfileirarPorAba('aba-7', envioDeMentira('A')),
    moduloAbas.enfileirarPorAba('aba-7', envioDeMentira('B')),
  ]);
  tudoOk &= ok(trilha.join(' ') === 'A-texto A-enter B-texto B-enter',
    `dois envios na MESMA aba saem inteiros, um depois do outro (${trilha.join(' ')})`);

  // Abas diferentes não têm caixa em comum: serializá-las juntas deixaria o celular
  // esperando o Projeto-a para escrever no Projeto-b.
  const paralela = [];
  const envioParalelo = (marca) => async () => {
    paralela.push(`${marca}-texto`);
    await new Promise((r) => setTimeout(r, 25));
    paralela.push(`${marca}-enter`);
  };
  await Promise.all([
    moduloAbas.enfileirarPorAba('aba-7', envioParalelo('X')),
    moduloAbas.enfileirarPorAba('aba-9', envioParalelo('Y')),
  ]);
  tudoOk &= ok(paralela.join(' ') === 'X-texto Y-texto X-enter Y-enter',
    `abas DIFERENTES continuam em paralelo (${paralela.join(' ')})`);

  // Envio que falha não pode entupir a fila daquela aba para sempre.
  const caiu = await moduloAbas.enfileirarPorAba('aba-7', async () => { throw new Error('aba sem claude'); })
    .then(() => 'passou', (e) => e.message);
  const depois = await moduloAbas.enfileirarPorAba('aba-7', async () => 'a seguinte rodou');
  tudoOk &= ok(caiu === 'aba sem claude' && depois === 'a seguinte rodou',
    'erro de um envio chega a quem mandou e não envenena o próximo da fila');

  // E a fila tem que estar no caminho de verdade, não só exportada.
  const fonteAbas = fs.readFileSync(path.join(__dirname, '..', 'lib', 'abas.js'), 'utf8');
  tudoOk &= ok(/function enviar\([^)]*\)\s*\{\s*return enfileirarPorAba\(/.test(fonteAbas),
    'e `enviar()` passa por ela — a serialização não é opcional');

  // ── Lida × te esperando ──────────────────────────────────────────────────────
  // A marca é por `sessaoId`, não pela chave da aba: `aba-7` muda ao fechar e reabrir a
  // aba, a conversa não.
  const guardaLidas = memoria();
  let mtime = 1000;
  const umaAba = (extra = {}) => ({
    chave: 'aba-7', titulo: 'cockpit', cwd: '/home/y/projetos/cockpit-agentes',
    temClaude: true, rodando: false, sessaoId: 'sess-abc', atualizadoEm: mtime, ...extra,
  });
  const leitura = carregarCliente({
    guardado: guardaLidas,
    aoBuscar: (rota) => (rota.startsWith('api/abas')
      ? { abas: [umaAba()] }
      : { painel: true, jobs: [] }),
  });
  await leitura.carregarAbas();
  const listaLida = porIdDe(leitura, 'abas');
  tudoOk &= ok(textoDe(listaLida).includes('◆'),
    'conversa nunca aberta no cockpit aparece como te esperando');
  // A hora da última mexida sai do MESMO `atualizadoEm` que decide o ◆ — sem leitura de
  // disco nova, sem rota nova, sem relógio novo.
  const horaNaLinha = listaLida.querySelectorAll('.conversa-hora');
  tudoOk &= ok(horaNaLinha.length === 1 && /^(\d{2}:\d{2}|\d{2}\/\d{2})$/.test(horaNaLinha[0].textContent),
    `a linha da lista mostra quando a conversa mexeu (${horaNaLinha[0] && horaNaLinha[0].textContent})`);
  // Prioridade: o estado vem antes da hora no rodapé — é o que ele olha primeiro.
  const rodapeLinha = listaLida.querySelector('.conversa-rodape');
  const ordemRodape = rodapeLinha.children.map((f) => String(f.className));
  tudoOk &= ok(ordemRodape.indexOf('conversa-estado') < ordemRodape.indexOf('conversa-hora'),
    'e ela vem DEPOIS do estado, que tem prioridade na linha');
  leitura.marcarLido('aba-7', 5000);
  tudoOk &= ok(JSON.parse(guardaLidas.getItem('cockpit-lidas'))['sess-abc'] === 5000,
    'marcarLido grava o instante por sessaoId, não pela chave da aba');
  tudoOk &= ok(textoDe(listaLida).includes('✓') && !textoDe(listaLida).includes('◆'),
    'e a aba passa a aparecer como lida');
  mtime = 9000;
  await leitura.carregarAbas();
  tudoOk &= ok(textoDe(listaLida).includes('◆'), 'mexeu depois da leitura: volta a te esperar');
  tudoOk &= ok(listaLida.querySelectorAll('.conversa-linha').some((f) => f.dataset && f.dataset.esperando === '1'),
    'e a linha ganha a marca que o CSS engrossa');
  leitura.marcarLido('aba-nao-existe', 1);
  tudoOk &= ok(true, 'marcar lido numa aba que sumiu não explode');

  // ── A hora é da última MENSAGEM, não do mtime do arquivo (23/08) ─────────────
  //
  // `atualizadoEm` era `fsp.stat().mtimeMs`, e o mtime ANDA SOZINHO: o CLI reescreve o
  // `.jsonl` sem ninguém ter falado nada (linhas `type: "system"`, entre outras). Medido no
  // disco em 23/08, nas 8 conversas mais recentes: as diferenças iam de 0 a 117 HORAS entre
  // o mtime e a última fala de verdade. Isso estragava as duas coisas que saem deste número
  // — a hora na linha da lista mostrava um horário em que ninguém falou, e a aba voltava
  // para "te esperando" sozinha.
  console.log('\n  · a hora vem da última mensagem, não do mtime');
  const { horaDaUltimaMensagem } = require('../lib/abas');
  const pastaHora = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-hora-'));
  const HORAS = 3600e3;
  // Relativos ao agora: assim o teste não envelhece nem depende do relógio do dia em que roda.
  const FALA_ANTIGA = new Date(Date.now() - 14 * HORAS).toISOString();
  const AGORINHA = new Date().toISOString();
  const escreverJsonl = (nome, ...linhas) => {
    const alvo = path.join(pastaHora, nome);
    fs.writeFileSync(alvo, linhas.map((l) => `${JSON.stringify(l)}\n`).join(''));
    return alvo;
  };

  // O caso exato do defeito: a ÚLTIMA linha é um `system` recente, a última mensagem de
  // verdade é de 14 horas atrás, e o mtime é agora (o arquivo acabou de ser escrito).
  const mentiroso = escreverJsonl('mentiroso.jsonl',
    { type: 'user', timestamp: new Date(Date.now() - 15 * HORAS).toISOString(), message: { role: 'user', content: 'roda o lint' } },
    { type: 'assistant', timestamp: FALA_ANTIGA, message: { content: [{ type: 'text', text: 'rodei, passou' }] } },
    { type: 'system', timestamp: AGORINHA, subtype: 'compact_boundary', content: 'o CLI reescrevendo sozinho' });
  const daMensagem = await horaDaUltimaMensagem(mentiroso);
  tudoOk &= ok(daMensagem === Date.parse(FALA_ANTIGA),
    `a hora sai da última fala, não do \`system\` que veio depois (${new Date(daMensagem).toISOString()})`);
  tudoOk &= ok(fs.statSync(mentiroso).mtimeMs - daMensagem > 13 * HORAS,
    `e o mtime deste mesmo arquivo está ${((fs.statSync(mentiroso).mtimeMs - daMensagem) / HORAS).toFixed(1)}h à frente — era ele que a lista mostrava`);

  // Ferramenta é máquina falando com máquina: não é "a conversa mexeu". `eventosDoObjeto`
  // já não carimba hora nelas, e é dessa regra que esta contagem depende.
  const soFerramenta = escreverJsonl('ferramenta.jsonl',
    { type: 'assistant', timestamp: FALA_ANTIGA, message: { content: [{ type: 'text', text: 'vou olhar' }] } },
    { type: 'assistant', timestamp: AGORINHA, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', timestamp: AGORINHA, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  tudoOk &= ok(await horaDaUltimaMensagem(soFerramenta) === Date.parse(FALA_ANTIGA),
    'ferramenta e resultado de ferramenta não contam como mensagem');

  // Sem nada reconhecível na cauda, o mtime volta a ser a resposta. Devolver `null` aqui
  // apagaria da lista a marca de hora que já funcionava.
  const soSystem = escreverJsonl('so-system.jsonl',
    { type: 'system', timestamp: AGORINHA, content: 'nasceu agora' });
  const caiuNoMtime = await horaDaUltimaMensagem(soSystem);
  tudoOk &= ok(caiuNoMtime === Math.round(fs.statSync(soSystem).mtimeMs),
    'cauda sem mensagem nenhuma cai no mtime, como era antes — degrada, não some');
  tudoOk &= ok(await horaDaUltimaMensagem(null) === null,
    'aba sem arquivo de conversa continua sem hora');
  tudoOk &= ok(await horaDaUltimaMensagem(path.join(pastaHora, 'nao-existe.jsonl')) === null,
    'e arquivo que sumiu do disco também');
  tudoOk &= ok(typeof (await horaDaUltimaMensagem(mentiroso)) === 'number',
    'o campo continua saindo como número em ms — o cliente já o consome em dois lugares');

  // Não vale ler 44 MB para achar um número: `listar()` roda para TODAS as abas a cada 5s.
  const fonteAbasHora = fs.readFileSync(path.join(__dirname, '..', 'lib', 'abas.js'), 'utf8');
  tudoOk &= ok(/lerConversa/.test(fonteAbasHora) && !/readFile\(\s*aba\.arquivo/.test(fonteAbasHora),
    'a leitura é a da CAUDA (lerConversa), não um `readFile` do arquivo inteiro');
  fs.rmSync(pastaHora, { recursive: true, force: true });

  // ── "Lida" é carimbo do SERVIDOR, não do aparelho (23/08) ────────────────────
  //
  // `marcarLido` gravava `Date.now()` — a hora do CELULAR — e a comparação lá na lista é
  // contra `atualizadoEm`, que é do SERVIDOR. Celular atrasado gravava um número menor e a
  // aba voltava a te esperar na batida seguinte; adiantado, nunca mais te esperava. Quem usa
  // pode estar viajando, então "os dois relógios batem" não é suposição que se possa fazer.
  console.log('\n  · lido: relógio do servidor contra relógio do servidor');
  const guardaCarimbo = memoria();
  const carimbo = carregarCliente({
    guardado: guardaCarimbo,
    aoBuscar: (rota) => (rota.startsWith('api/abas')
      ? { abas: [umaAba({ atualizadoEm: 9000 })] }
      : { painel: true, jobs: [] }),
  });
  await carimbo.carregarAbas();
  carimbo.marcarLido('aba-7');
  tudoOk &= ok(JSON.parse(guardaCarimbo.getItem('cockpit-lidas'))['sess-abc'] === 9000,
    'marcarLido grava o `atualizadoEm` que o servidor mandou, não a hora do aparelho');
  await carimbo.carregarAbas();
  const listaCarimbo = porIdDe(carimbo, 'abas');
  tudoOk &= ok(textoDe(listaCarimbo).includes('✓') && !textoDe(listaCarimbo).includes('◆'),
    'e na batida seguinte ela continua lida — o "te esperando" não reacende sozinho');

  // Aba sem `atualizadoEm`: não há o que comparar. Gravar 0 carimbaria "lida" numa conversa
  // que ninguém abriu, e o ◆ sumiria de uma aba que talvez estivesse esperando de verdade.
  const guardaSemHora = memoria();
  const semHora = carregarCliente({
    guardado: guardaSemHora,
    aoBuscar: (rota) => (rota.startsWith('api/abas')
      ? { abas: [umaAba({ atualizadoEm: null })] }
      : { painel: true, jobs: [] }),
  });
  await semHora.carregarAbas();
  semHora.marcarLido('aba-7');
  tudoOk &= ok(guardaSemHora.getItem('cockpit-lidas') === null,
    'sem `atualizadoEm` não há carimbo: a marca fica como estava, em vez de virar 0');

  // `turno_fim` marcava com `Date.now()`. O valor certo é o `atualizadoEm` MAIS RECENTE que
  // a lista conhece — e ele só existe depois de a lista voltar, porque a resposta que
  // acabou de chegar é justamente o que mudou o número no servidor.
  const guardaFim = memoria();
  let atualizadoAgora = 1000;
  const fimCarimbo = carregarCliente({
    guardado: guardaFim,
    aoBuscar: (rota) => (rota.startsWith('api/abas')
      ? { abas: [umaAba({ atualizadoEm: atualizadoAgora })] }
      : { painel: true, jobs: [] }),
  });
  await fimCarimbo.carregarAbas();
  await fimCarimbo.abrirAba('aba-7');
  tudoOk &= ok(JSON.parse(guardaFim.getItem('cockpit-lidas'))['sess-abc'] === 1000,
    'abrir a aba carimba com o `atualizadoEm` que ela tinha na hora da abertura');
  atualizadoAgora = 7000;                       // o turno respondeu: o servidor já sabe da fala nova
  fimCarimbo.aplicar({ tipo: 'turno_fim', aba: 'aba-7' });
  await new Promise((r) => setImmediate(r));    // deixa o `carregarAbas().then(...)` andar
  await new Promise((r) => setImmediate(r));
  tudoOk &= ok(JSON.parse(guardaFim.getItem('cockpit-lidas'))['sess-abc'] === 7000,
    'e `turno_fim` recarrega a lista ANTES de carimbar, senão a aba que você está lendo reacende');

  // ── Botão de recarregar (23/08) ──────────────────────────────────────────────
  //
  // "Às vezes buga" e não havia como forçar atualização sem fechar o app. O que ele NÃO
  // pode ser é `location.reload()`: isso derruba o que estava digitado na caixa.
  console.log('\n  · botão de recarregar');
  const fonteReload = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const reloads = [...fonteReload.matchAll(/location\.reload\s*\(/g)];
  tudoOk &= ok(reloads.length === 1,
    `location.reload() aparece uma vez só no cliente (${reloads.length})`);
  tudoOk &= ok(/CHAVE_TOKEN[^]{0,200}location\.reload/.test(fonteReload),
    'e é a do token recém-guardado — recarregar conversa não passa por ela, senão comeria o que estava digitado');

  const rotasRec = [];
  let btnLista = null;
  let girandoDurante = null;
  const rec = carregarCliente({
    guardado: memoria(),
    aoBuscar: (rota) => {
      const r = String(rota);
      rotasRec.push(r);
      if (/\/anexos\?/.test(r)) return { arquivo: '/home/y/.cockpit/anexos/notas.txt', nome: 'notas.txt' };
      if (r.startsWith('api/abas')) {
        // Fotografa o botão NO MEIO da recarga: é o único instante em que o retorno visual
        // existe, e sem esta leitura ele passaria despercebido por um teste de "depois".
        if (btnLista) girandoDurante = btnLista.dataset.recarregando;
        return { abas: [umaAba()] };
      }
      return { painel: true, jobs: [] };
    },
  });
  await rec.carregarAbas();
  btnLista = porIdDe(rec, 'btn-recarregar');
  tudoOk &= ok(typeof btnLista.onclick === 'function', 'o botão da lista tem dono no JS');
  const abasAntes = rotasRec.filter((r) => r.startsWith('api/abas')).length;
  await btnLista.onclick({ currentTarget: btnLista });
  tudoOk &= ok(rotasRec.filter((r) => r.startsWith('api/abas')).length > abasAntes,
    'na lista, o botão refaz a busca das abas');
  tudoOk &= ok(girandoDurante === '1', 'e o retorno visual acende no próprio botão enquanto roda');
  tudoOk &= ok(btnLista.dataset.recarregando === '', 'e apaga quando termina');

  await rec.abrirAba('aba-7');
  // Um anexo já escolhido e um texto já digitado: é o estado que `location.reload()` comeria.
  await rec.subirArquivo(rec.painelAtual(), { name: 'notas.txt', type: 'text/plain' });
  porIdDe(rec, 'entrada').value = 'estava escrevendo isto';
  const fluxosAntes = rec.fluxos.length;
  const btnConversa = porIdDe(rec, 'btn-recarregar-conversa');
  tudoOk &= ok(typeof btnConversa.onclick === 'function', 'o botão da conversa tem dono no JS');
  await btnConversa.onclick({ currentTarget: btnConversa });
  tudoOk &= ok(rec.fluxos[fluxosAntes - 1].fechado === true,
    'na conversa, o botão FECHA o EventSource velho — nada de dois SSE pendurados');
  tudoOk &= ok(rec.fluxos.length === fluxosAntes + 1, 'e abre um novo no lugar');
  tudoOk &= ok(/api\/eventos\?abas=aba-7/.test(rec.fluxos[fluxosAntes].rota),
    'no mesmo caminho de `abrirAba`, sem uma segunda porta de abrir conversa');
  tudoOk &= ok(porIdDe(rec, 'entrada').value === 'estava escrevendo isto',
    'o que estava digitado na caixa sobrevive à recarga');
  tudoOk &= ok(textoDe(porIdDe(rec, 'anexos')).includes('notas.txt'),
    'e o anexo já escolhido também — recarregar não é trocar de aba');

  // Aba sem claude não entra na conta de "te esperando": não há conversa viva ali.
  const semClaude = carregarCliente({
    guardado: memoria(),
    aoBuscar: (rota) => (rota.startsWith('api/abas')
      ? { abas: [umaAba({ temClaude: false, sessaoId: null, atualizadoEm: null })] }
      : { painel: true, jobs: [] }),
  });
  await semClaude.carregarAbas();
  const listaSem = porIdDe(semClaude, 'abas');
  tudoOk &= ok(textoDe(listaSem).includes('○') && !textoDe(listaSem).includes('◆'),
    'aba sem claude continua com o ○ de sempre');
  tudoOk &= ok(listaSem.querySelectorAll('.conversa-hora').length === 0,
    'e sem arquivo de conversa (`atualizadoEm` null) a linha não ganha hora nenhuma');

  // ── UI-1 a UI-5: a aba de CODEX na lista ────────────────────────────────────
  //
  // Este é o risco de maior impacto da entrega. `temClaude` virou LEGADO — ele diz "é
  // claude", não "tem alguém rodando" —, e uma aba de Codex tem `temClaude: false`. Sem o
  // `temAgente ?? temClaude` nos nove pontos, ela nasce visualmente QUEBRADA: linha apagada,
  // pino de "fechado", "te esperando" que nunca acende e uma bolha de erro dizendo que a aba
  // não tem claude.
  await rodarGrupo('UI-1 a UI-5: a aba de Codex na lista', async () => {
    const abaCodex = (extra = {}) => umaAba({
      chave: 'aba-p71', titulo: 'Projeto-a', agente: 'codex', temAgente: true, temClaude: false,
      sessaoId: '01a04696-1b09-7da2-9b91-27c79501b636', casamento: 'ok', ...extra,
    });
    const comCodex = carregarCliente({
      guardado: memoria(),
      aoBuscar: (rota) => (String(rota).startsWith('api/abas')
        ? { abas: [abaCodex()] } : { painel: true, jobs: [] }),
    });
    await comCodex.carregarAbas();
    const listaCodex = porIdDe(comCodex, 'abas');

    // UI-1 — o coração do R11.
    tudoOk &= ok(!listaCodex.querySelectorAll('.conversa-linha').some((f) => f.dataset && f.dataset.semClaude === '1'),
      'UI-1: a aba de Codex NÃO ganha data-sem-claude — a linha não é pintada de morta');
    tudoOk &= ok(!textoDe(listaCodex).includes('○'),
      'UI-1: e o pino NÃO é ○ (que quer dizer "fechado") — o `??` está nos nove pontos');
    tudoOk &= ok(!/agente fechado|não subiu/.test(textoDe(listaCodex)),
      `UI-1: e o estado dela NÃO é "agente fechado" — ela está viva (${textoDe(listaCodex).replace(/\s+/g, ' ').slice(0, 90)})`);

    // UI-4 — o chip. Sob a chave por pane, a janela do Projeto-a virou DUAS linhas com o
    // MESMO título; sem o chip elas ficam indistinguíveis, e a entrega chega ambígua.
    const duasNaMesmaJanela = carregarCliente({
      guardado: memoria(),
      aoBuscar: (rota) => (String(rota).startsWith('api/abas')
        ? {
          abas: [
            umaAba({ chave: 'aba-p5', titulo: 'Projeto-a', agente: 'claude', temAgente: true, temClaude: true }),
            abaCodex(),
          ],
        }
        : { painel: true, jobs: [] }),
    });
    await duasNaMesmaJanela.carregarAbas();
    const chips = porIdDe(duasNaMesmaJanela, 'abas').querySelectorAll('.conversa-agente');
    tudoOk &= ok(chips.length === 2, `UI-4: as duas linhas ganham chip (${chips.length})`);
    tudoOk &= ok(chips.length === 2 && chips[0].textContent === 'claude' && chips[1].textContent === 'codex',
      `UI-4: e os chips são DIFERENTES — é o que separa duas linhas de mesmo título (${chips.map((c) => c.textContent).join(', ')})`);
    // Conteúdo de verdade no DOM, não `title`: tooltip não aparece em toque (#31).
    tudoOk &= ok(textoDe(porIdDe(duasNaMesmaJanela, 'abas')).includes('codex'),
      'UI-4: o chip é TEXTO na tela, não tooltip — a #31 diz que title não existe no dedo');

    const preferenciasProjetos = memoria();
    const agrupadas = carregarCliente({
      guardado: preferenciasProjetos,
      aoBuscar: rota => String(rota).startsWith('api/abas') ? { abas: [
        umaAba({ chave: 'a1', cwd: '/home/y/a/projeto', agente: 'claude' }),
        umaAba({ chave: 'b1', cwd: '/home/y/b/projeto', agente: 'codex' }),
        umaAba({ chave: 'a2', cwd: '/home/y/a/projeto', agente: 'codex' }),
      ] } : { painel: true, jobs: [] },
    });
    await agrupadas.carregarAbas();
    const grupos = porIdDe(agrupadas, 'abas').querySelectorAll('.conversa-grupo[data-cwd]');
    tudoOk &= ok(grupos.length === 2 && grupos[0].querySelectorAll('.conversa').length === 2
      && grupos[1].querySelectorAll('.conversa').length === 1,
      'A/B/A junta as conversas de A e distingue projetos com o mesmo basename');
    grupos[0].querySelector('.projeto-alternar').onclick();
    tudoOk &= ok(grupos[0].querySelector('.projeto-conteudo').hidden,
      'recolher projeto esconde suas conversas sem removê-las');
    await agrupadas.carregarAbas();
    let projetos = porIdDe(agrupadas, 'abas').querySelectorAll('.conversa-grupo[data-cwd]');
    tudoOk &= ok(projetos[0].querySelector('.projeto-conteudo').hidden,
      'a atualização periódica não reabre o projeto recolhido');
    projetos[1].querySelectorAll('.projeto-mover')[0].onclick();
    projetos = porIdDe(agrupadas, 'abas').querySelectorAll('.conversa-grupo[data-cwd]');
    tudoOk &= ok(projetos[0].dataset.cwd === '/home/y/b/projeto'
      && projetos[1].querySelector('.projeto-conteudo').hidden,
      'subir troca a ordem e mantém o recolhimento vinculado ao projeto correto');
    tudoOk &= ok(projetos[0].querySelectorAll('.projeto-mover')[0].disabled
      && projetos[1].querySelectorAll('.projeto-mover')[1].disabled,
      'primeiro não sobe e último não desce');
    const reaberto = carregarCliente({ guardado: preferenciasProjetos,
      aoBuscar: rota => String(rota).startsWith('api/abas') ? { abas: [
        umaAba({ chave: 'a1', cwd: '/home/y/a/projeto' }),
        umaAba({ chave: 'b1', cwd: '/home/y/b/projeto' }),
        umaAba({ chave: 'c1', cwd: '/home/y/c/novo' }),
      ] } : { painel: true, jobs: [] } });
    await reaberto.carregarAbas();
    projetos = porIdDe(reaberto, 'abas').querySelectorAll('.conversa-grupo[data-cwd]');
    tudoOk &= ok(projetos.map(g => g.dataset.cwd).join('|') === '/home/y/b/projeto|/home/y/a/projeto|/home/y/c/novo'
      && projetos[1].querySelector('.projeto-conteudo').hidden,
      'reabrir o app restaura ordem e recolhimento; projeto novo entra no fim');
    projetos[1].querySelector('.projeto-alternar').onclick();
    tudoOk &= ok(!projetos[1].querySelector('.projeto-conteudo').hidden,
      'o projeto pode ser expandido novamente');
    await agrupadas.abrirAba('a2');
    tudoOk &= ok(porIdDe(agrupadas, 'chat-agente').textContent === 'codex'
      && !porIdDe(agrupadas, 'chat-agente').hidden, 'a conversa aberta mantém a identidade do agente no cabeçalho');
    await agrupadas.abrirAba('a1');
    tudoOk &= ok(porIdDe(agrupadas, 'chat-agente').textContent === 'claude',
      'trocar de conversa troca também o chip do cabeçalho');

    const memoriaAvisos = memoria();
    memoriaAvisos.setItem('cockpit-projetos', JSON.stringify({ fechados: ['/tmp/avisos'] }));
    let perguntaPendente = true;
    let agenteTrabalhando = true;
    const avisosProjeto = carregarCliente({ guardado: memoriaAvisos,
      aoBuscar: rota => String(rota).startsWith('api/abas') ? { abas: [
        umaAba({ chave: 'aviso-1', cwd: '/tmp/avisos', sessaoId: 'nova', atualizadoEm: 5000, rodando: false }),
        umaAba({ chave: 'aviso-2', cwd: '/tmp/avisos', sessaoId: 'pergunta', atualizadoEm: 5000, rodando: false, esperando: perguntaPendente }),
        umaAba({ chave: 'aviso-3', cwd: '/tmp/avisos', sessaoId: 'ocupada', atualizadoEm: 5000, rodando: agenteTrabalhando }),
      ] } : { painel: true, jobs: [] } });
    await avisosProjeto.carregarAbas();
    const avisoDoProjeto = () => porIdDe(avisosProjeto, 'abas').querySelector('.projeto-aviso');
    const trabalhoDoProjeto = () => porIdDe(avisosProjeto, 'abas').querySelector('.projeto-trabalhando');
    tudoOk &= ok(!trabalhoDoProjeto().hidden && trabalhoDoProjeto().textContent === '1 trabalhando',
      'projeto recolhido mostra agentes trabalhando junto das pendências');
    tudoOk &= ok(!avisoDoProjeto().hidden && avisoDoProjeto().textContent === '2 te esperando',
      'projeto recolhido conta conversas pendentes, sem duplicar pergunta nem contar agente trabalhando');
    porIdDe(avisosProjeto, 'abas').querySelector('.projeto-alternar').onclick();
    tudoOk &= ok(avisoDoProjeto().hidden, 'expandir devolve os indicadores às conversas individuais');
    tudoOk &= ok(trabalhoDoProjeto().hidden, 'expandir também devolve o estado trabalhando às conversas');
    porIdDe(avisosProjeto, 'abas').querySelector('.projeto-alternar').onclick();
    avisosProjeto.marcarLido('aviso-1', 5000);
    avisosProjeto.marcarLido('aviso-2', 5000);
    tudoOk &= ok(!avisoDoProjeto().hidden && avisoDoProjeto().textContent === '1 te esperando',
      'ler as respostas limpa seus avisos, mas uma pergunta ainda aberta permanece pendente');
    perguntaPendente = false;
    await avisosProjeto.carregarAbas();
    tudoOk &= ok(avisoDoProjeto().hidden, 'resolvida a última pendência, o projeto recolhido perde o aviso');
    tudoOk &= ok(!trabalhoDoProjeto().hidden, 'resolver pendências não apaga o agente ainda trabalhando');
    agenteTrabalhando = false;
    await avisosProjeto.carregarAbas();
    tudoOk &= ok(trabalhoDoProjeto().hidden && !avisoDoProjeto().hidden,
      'ao terminar, trabalhando desaparece e a resposta ainda não lida vira pendência');

    // UI-5 — a janela sem agente nenhum não ganha chip. "null" escrito na tela seria pior
    // que chip nenhum.
    const semAgente = carregarCliente({
      guardado: memoria(),
      aoBuscar: (rota) => (String(rota).startsWith('api/abas')
        ? { abas: [umaAba({ chave: 'aba-9', agente: null, temAgente: false, temClaude: false, sessaoId: null, atualizadoEm: null })] }
        : { painel: true, jobs: [] }),
    });
    await semAgente.carregarAbas();
    const listaSemAgente = porIdDe(semAgente, 'abas');
    tudoOk &= ok(listaSemAgente.querySelectorAll('.conversa-agente').length === 0,
      'UI-5: aba com agente:null não ganha chip — nada de "null" escrito na tela');
    tudoOk &= ok(textoDe(listaSemAgente).includes('○'),
      'UI-5: e ela continua com o ○ de sempre — a regra (a) não mudou para ela');

    // [GUARDA] o fixture ANTIGO, só com `temClaude`, continua valendo. É por isso que o
    // cliente lê `temAgente ?? temClaude` e não `temAgente` direto: trocar reprovaria mais
    // de dez fixtures que não têm nada a ver com esta mudança.
    const soLegado = carregarCliente({
      guardado: memoria(),
      aoBuscar: (rota) => (String(rota).startsWith('api/abas')
        ? { abas: [umaAba({ temClaude: true })] } : { painel: true, jobs: [] }),
    });
    await soLegado.carregarAbas();
    tudoOk &= ok(!textoDe(porIdDe(soLegado, 'abas')).includes('○'),
      '[GUARDA] fixture só com `temClaude: true` continua sendo aba viva — o `??` cuida disso');
  });

  // ── UI-2 e UI-3: o aviso do menu e as DUAS frases do casamento ───────────────
  await rodarGrupo('UI-2 e UI-3: o aviso do R1 e as frases do casamento', async () => {
    const abrirCom = async (aba) => {
      const c = carregarCliente({
        guardado: memoria(),
        aoBuscar: (rota) => (String(rota).startsWith('api/abas')
          ? { abas: [aba] } : { painel: true, jobs: [] }),
      });
      await c.carregarAbas();
      await c.abrirAba(aba.chave);
      // O CABEÇALHO, não a fita: o `sessao` do fluxo chama `limparFita()`, e um aviso posto
      // na fita seria apagado por ele um instante depois. O smoke de navegador pegou isso.
      return textoDe(porIdDe(c, 'aviso-agente'));
    };
    const base = (extra = {}) => umaAba({
      chave: 'aba-p71', titulo: 'Projeto-a', agente: 'codex', temAgente: true, temClaude: false, ...extra,
    });

    // UI-3 — o aviso PERMANENTE do R1 saiu em 10/09 e este teste agora guarda a saída dele.
    // Ele nasceu como mitigação de o Codex não publicar `status: waiting`, mas era
    // incondicional: quatro linhas no topo de TODA aba de Codex, sempre. O risco segue real
    // (#6/#25) e quem o resolve é `menu-da-tui-do-codex-na-tela` — enxergar o menu de verdade.
    // Invertido em vez de apagado de propósito: sem este assert o aviso volta no primeiro
    // merge distraído, que foi exatamente como ele sobreviveu à remoção anterior (o `--ours`
    // do merge a7a231c descartou o app.js da branch que já o tinha tirado).
    const naDeCodex = await abrirCom(base({ casamento: 'ok' }));
    tudoOk &= ok(!/não enxerga menu aberto/.test(naDeCodex),
      `UI-3: a aba de Codex NÃO carrega mais o aviso permanente de menu (${naDeCodex.slice(0, 100)})`);
    const naDeClaude = await abrirCom(umaAba({ agente: 'claude', temAgente: true, temClaude: true }));
    tudoOk &= ok(!/não enxerga menu aberto/.test(naDeClaude),
      'UI-3: e a de CLAUDE também não — ela nunca teve');

    // UI-2 — as duas frases são DIFERENTES, e é o ponto. "ainda não achei" some sozinha nos
    // ~5 s que o rollout leva para nascer; "não deu para saber qual" NÃO some. Uma frase só
    // para os dois estados é a #40.
    const ambigua = await abrirCom(base({ casamento: 'ambiguo' }));
    tudoOk &= ok(/duas abas de Codex no mesmo projeto/.test(ambigua),
      `UI-2: casamento "ambiguo" diz que há duas abas no mesmo projeto (${ambigua.slice(0, 140)})`);
    const nenhuma = await abrirCom(base({ casamento: 'nenhum' }));
    tudoOk &= ok(/ainda não achei a conversa/.test(nenhuma),
      `UI-2: casamento "nenhum" diz que ainda não achou (${nenhuma.slice(0, 140)})`);
    tudoOk &= ok(!/duas abas de Codex/.test(nenhuma) && !/ainda não achei/.test(ambigua),
      'UI-2: e as duas frases NÃO se confundem — cada estado tem a sua');
    tudoOk &= ok(!/duas abas de Codex|ainda não achei/.test(naDeCodex),
      'UI-2: com o casamento "ok" nenhuma das duas aparece — a fita é que fala');
  });

  // ── "Esperando você escolher": o estado que o .jsonl não conhece ─────────────
  // A aba do Projeto-a ficou muda em 22/08 porque o Claude dela estava com um menu de
  // múltipla escolha aberto na TUI. Isso não entra no arquivo da conversa — vem do campo
  // `status: "waiting"` do CLI. Sem ele, a aba fica idêntica a uma aba livre.
  const chamadas = [];
  const teclasPedidas = [];
  const comPergunta = carregarCliente({
    guardado: memoria(),
    aoBuscar: (rota, opcoes = {}) => {
      chamadas.push(String(rota));
      if (/\/tela(\?|$)/.test(String(rota))) return { chave: 'aba-7', tela: '  1. Sim\n> 2. Nao', linhas: 2 };
      // A rota de teclas devolve a tela JÁ repintada — é o contrato que faz o usuário ver a
      // seta mexer. O Escape (e o Enter que fecha o menu) tira a aba de `waiting`.
      if (/\/teclas$/.test(String(rota))) {
        const pedida = JSON.parse(String(opcoes.body || '{}')).tecla;
        teclasPedidas.push(pedida);
        if (pedida === 'Escape') return { apertado: true, chave: 'aba-7', tecla: pedida, esperando: false, tela: '' };
        return { apertado: true, chave: 'aba-7', tecla: pedida, esperando: true, tela: '> 1. Sim\n  2. Nao', linhas: 2 };
      }
      if (String(rota).startsWith('api/abas')) return { abas: [umaAba({ esperando: true })] };
      return { painel: true, jobs: [] };
    },
  });
  await comPergunta.carregarAbas();
  const listaPergunta = porIdDe(comPergunta, 'abas');
  tudoOk &= ok(textoDe(listaPergunta).includes('?') && !textoDe(listaPergunta).includes('◆'),
    'aba com pergunta aberta ganha pino próprio, diferente de "te esperando"');
  tudoOk &= ok(textoDe(listaPergunta).includes('esperando você escolher'),
    'e rótulo próprio, diferente de "trabalhando" e de "no terminal"');
  tudoOk &= ok(listaPergunta.querySelectorAll('.conversa-linha').some((f) => f.dataset && f.dataset.perguntando === '1'),
    'a linha ganha a marca que o CSS pinta');

  await comPergunta.abrirAba('aba-7');
  comPergunta.aplicar({ tipo: 'esperando', valor: true });
  await comPergunta.atualizarTelaDaPane(comPergunta.painelAtual());
  tudoOk &= ok(porIdDe(comPergunta, 'pergunta').hidden === false,
    'com a aba aberta, a tela da pergunta aparece');
  // O parágrafo de aviso SAIU em 25/08, a pedido do dono depois do smoke no celular: as
  // quatro teclas embaixo já dizem o que fazer, e na tela inteira ele custava as linhas de
  // terminal que o job anterior tinha acabado de comprar. Guardado por asserção porque
  // "texto explicativo" é o tipo de coisa que volta sozinha na próxima mão.
  //
  // A prova é no FONTE, não no DOM falso: o `getElementById` daqui cria o elemento que lhe
  // pedirem (linha ~197), então perguntar ao DOM se um id sumiu devolve sempre "existe".
  const htmlPergunta = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fontePergunta = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  tudoOk &= ok(!/pergunta-aviso/.test(htmlPergunta) && !/pergunta-aviso/.test(fontePergunta),
    'e sem parágrafo de aviso: quem explica são as quatro teclas');
  tudoOk &= ok(porIdDe(comPergunta, 'pergunta-tela').textContent.includes('2. Nao'),
    'a tela da pane aparece em bloco monoespaçado');
  tudoOk &= ok(chamadas.some((r) => /^api\/abas\/aba-7\/tela/.test(r)),
    'e ela vem da rota nova, pedida só nesse estado');

  // ── A vista tem que cair NO FIM da captura ───────────────────────────────────
  // `moldarTela` (lib/abas.js) guarda as ÚLTIMAS 80 linhas justamente porque a pergunta e
  // as opções estão embaixo — e o `pre` mostrava o TOPO delas. Em 42vh cabem ~23 linhas:
  // o usuário via as 23 mais VELHAS e a pergunta ficava ~57 linhas fora da vista. É
  // literalmente o print mandado em 24/08.
  const telaPane = porIdDe(comPergunta, 'pergunta-tela');
  // Estado do navegador antes da primeira pintura: `pre` vazio, sem nada rolável. É pintar
  // as 80 linhas que faz o `scrollHeight` virar 900 — daí o `alturaAoPintar`.
  telaPane.textContent = '';
  telaPane.alturaAoPintar = 900;
  telaPane.scrollHeight = 0;
  telaPane.clientHeight = 0;
  telaPane.scrollTop = 0;
  await comPergunta.atualizarTelaDaPane(comPergunta.painelAtual());
  tudoOk &= ok(telaPane.scrollTop === 900,
    `pintada a tela, a vista cai no FIM da captura, que é onde a pergunta está (${telaPane.scrollTop})`);

  // O ciclo de 5s da lista repinta esta tela. Reatribuir `textContent` reconstrói os filhos
  // e ZERA a rolagem — então, com a tela parada, ele arrastava a vista de volta a cada 5s
  // enquanto ele lia. Tela igual não se repinta.
  telaPane.scrollTop = 240;
  telaPane.scrollLeft = 180;
  await comPergunta.atualizarTelaDaPane(comPergunta.painelAtual());
  tudoOk &= ok(telaPane.scrollTop === 240 && telaPane.scrollLeft === 180,
    `o tique de 5s com a tela IGUAL não repinta nem puxa a vista de volta (${telaPane.scrollTop}/${telaPane.scrollLeft})`);

  // Rolou para ler? A posição é dele. Só quem estava colado no fim continua colado — e a
  // rolagem LATERAL sobrevive sempre: no celular a pane tem 168–211 colunas, então é ela
  // que carrega metade da leitura.
  telaPane.clientHeight = 300;
  telaPane.scrollTop = 100;
  telaPane.scrollLeft = 420;
  tudoOk &= ok(porIdDe(comPergunta, 'btn-enviar').disabled === true,
    'o Enviar trava: texto com menu aberto vira tecla do menu');
  // P7: quem escreve o rótulo agora é o `#parar-rotulo` (o botão ganhou um SVG — escrever
  // direto no `#btn-parar` apagaria o ícone junto).
  tudoOk &= ok(porIdDe(comPergunta, 'btn-parar').hidden === false
    && porIdDe(comPergunta, 'parar-rotulo').textContent === 'Cancelar pergunta',
    'e o Parar continua de pé, rotulado como cancelar a pergunta');

  // ── Responder o menu pelas TECLAS, do celular ────────────────────────────────
  // Seta e Enter funcionam em qualquer menu sem o cockpit parsear a tela (a alternativa —
  // ler as opções da pane e desenhar um botão por opção — é a família da armadilha #10).
  await porIdDe(comPergunta, 'tecla-down').onclick();
  tudoOk &= ok(teclasPedidas.length === 1 && teclasPedidas[0] === 'Down',
    `o botão da seta manda a tecla pela rota nova (${teclasPedidas.join(', ') || 'nenhuma'})`);
  tudoOk &= ok(chamadas.some((r) => /^api\/abas\/aba-7\/teclas$/.test(r)),
    'e ela vai para a aba aberta, não para a tela');
  tudoOk &= ok(porIdDe(comPergunta, 'pergunta-tela').textContent.includes('> 1. Sim'),
    'a tela volta REPINTADA na mesma resposta — sem isso a seta parece não fazer nada');
  tudoOk &= ok(telaPane.scrollTop === 100 && telaPane.scrollLeft === 420,
    `e quem tinha rolado para ler continua exatamente onde parou (${telaPane.scrollTop}/${telaPane.scrollLeft})`);
  await porIdDe(comPergunta, 'tecla-up').onclick();
  // As laterais, que entraram em 28/08: sem elas o menu horizontal ficava sem resposta.
  await porIdDe(comPergunta, 'tecla-left').onclick();
  await porIdDe(comPergunta, 'tecla-right').onclick();
  await porIdDe(comPergunta, 'tecla-enter').onclick();
  tudoOk &= ok(teclasPedidas.join(',') === 'Down,Up,Left,Right,Enter',
    `cada botão manda a SUA tecla, as laterais inclusive (${teclasPedidas.join(',')})`);

  await porIdDe(comPergunta, 'tecla-esc').onclick();
  tudoOk &= ok(porIdDe(comPergunta, 'pergunta').hidden === true,
    'o Esc fecha o bloco na hora: a resposta já diz que a aba saiu de `waiting`');
  tudoOk &= ok(porIdDe(comPergunta, 'btn-enviar').disabled === false,
    'e a caixa de texto volta sem esperar o evento do fluxo');
  // Reabre para o resto do bloco: o caminho pelo fluxo continua sendo exercitado abaixo.
  // A espera deixa assentarem as buscas que `marcarPergunta` dispara sem await (a tela da
  // pane e a lista); sem ela, elas caem na conta de `chamadas` do teste seguinte.
  comPergunta.aplicar({ tipo: 'esperando', valor: true });
  await new Promise((pronto) => { setImmediate(pronto); });

  // O envio nem sai do navegador: o servidor recusa igual (409), isto é só o recado rápido.
  porIdDe(comPergunta, 'entrada').value = 'pode seguir';
  const antesDoEnvio = chamadas.length;
  await comPergunta.enviar(comPergunta.painelAtual());
  tudoOk &= ok(chamadas.length === antesDoEnvio, 'com pergunta aberta, o texto não vira send-keys');
  tudoOk &= ok(/pergunta aberta/.test(textoDe(porIdDe(comPergunta, 'fita'))),
    'e a tela explica como destravar (Esc)');

  comPergunta.aplicar({ tipo: 'esperando', valor: false });
  tudoOk &= ok(porIdDe(comPergunta, 'pergunta').hidden === true
    && porIdDe(comPergunta, 'pergunta-tela').textContent === '',
    'respondida a pergunta, o bloco some e a tela da pane não fica pendurada');
  tudoOk &= ok(porIdDe(comPergunta, 'btn-enviar').disabled === false
    && porIdDe(comPergunta, 'parar-rotulo').textContent === 'Parar',
    'e a caixa volta a aceitar texto');

  // ── O mesmo bloco, com o motivo `pre-sessao` (09/09) ─────────────────────────
  //
  // O prompt de confiança de pasta nova usa o MESMO evento e o MESMO desenho — o que muda é
  // o texto, e ele muda porque a consequência do Esc é outra: sem conversa aberta, o Escape
  // não cancela uma pergunta, ele FECHA o agente que o usuário acabou de criar. Rótulo que
  // promete "Cancelar pergunta" ali mente sobre um botão destrutivo.
  comPergunta.aplicar({ tipo: 'esperando', valor: true, motivo: 'pre-sessao' });
  await new Promise((pronto) => { setImmediate(pronto); });
  tudoOk &= ok(porIdDe(comPergunta, 'pergunta').hidden === false
    && porIdDe(comPergunta, 'btn-enviar').disabled === true,
    'no pre-sessao o bloco da pane abre e o Enviar trava igual');
  tudoOk &= ok(porIdDe(comPergunta, 'parar-rotulo').textContent === 'Fechar o agente',
    'e o botão diz o que ele REALMENTE faz ali — nunca "Cancelar pergunta"');

  porIdDe(comPergunta, 'entrada').value = 'oi';
  const antesDoPre = chamadas.length;
  await comPergunta.enviar(comPergunta.painelAtual());
  const recadoPre = textoDe(porIdDe(comPergunta, 'fita'));
  tudoOk &= ok(chamadas.length === antesDoPre, 'o texto também não vira send-keys no pre-sessao');
  tudoOk &= ok(/confirmação no terminal/.test(recadoPre) && /FECHA o agente/.test(recadoPre),
    'e o recado manda responder pelas setas, avisando que o Esc fecha o agente');

  // A transição que o `valor` sozinho não pega: o CLI publica a sessão JÁ com um menu aberto,
  // então a aba sai do pre-sessao e entra no `waiting` sem passar por false no meio. Sem
  // comparar o motivo, o rótulo ficaria preso em "Fechar o agente" numa pergunta de permissão.
  comPergunta.aplicar({ tipo: 'esperando', valor: true, motivo: 'menu' });
  await new Promise((pronto) => { setImmediate(pronto); });
  tudoOk &= ok(porIdDe(comPergunta, 'parar-rotulo').textContent === 'Cancelar pergunta',
    'pre-sessao → waiting sem passar por false troca o rótulo mesmo assim');
  comPergunta.aplicar({ tipo: 'esperando', valor: false });

  // ── Faixa de jobs: só o projeto da conversa aberta ───────────────────────────
  const doJob = (id, projeto, chaves) => ({
    id, titulo: `ship ${projeto}`, projeto, estado: 'running', abas: chaves,
    etapa: 'editando app.js', desde: new Date(Date.now() - 120000).toISOString(),
  });
  const faixa = carregarCliente({
    guardado: memoria(),
    aoBuscar: (rota) => (rota.startsWith('api/abas')
      ? { abas: [
          { chave: 'aba-1', titulo: 'cockpit', cwd: '/home/y/projetos/cockpit-agentes',
            temClaude: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 },
          { chave: 'aba-2', titulo: 'projeto-a', cwd: '/home/y/projetos/projeto-a',
            temClaude: true, rodando: false, sessaoId: 's2', atualizadoEm: 1 },
        ] }
      : { painel: true, jobs: [doJob('j1', 'cockpit-agentes', ['aba-1']), doJob('j2', 'projeto-d', [])] }),
  });
  await faixa.carregarAbas();
  await faixa.atualizarFaixaJobs();
  tudoOk &= ok(porIdDe(faixa, 'faixa-jobs').hidden === true,
    'sem conversa aberta (a tela da lista no celular) a faixa fica escondida');
  tudoOk &= ok(textoDe(porIdDe(faixa, 'abas')).includes('•'),
    'mas a aba do projeto com job rodando ganha a bolinha na lista');

  await faixa.abrirAba('aba-1');
  await faixa.atualizarFaixaJobs();
  tudoOk &= ok(porIdDe(faixa, 'faixa-jobs').hidden === false
    && porIdDe(faixa, 'faixa-titulos').textContent === 'ship cockpit-agentes',
    'com a aba aberta, a faixa mostra o job DAQUELE projeto');
  tudoOk &= ok(!porIdDe(faixa, 'faixa-titulos').textContent.includes('projeto-d'),
    'e o job que não casa com aba nenhuma não aparece — ele vive no painel /jobs');

  await faixa.abrirAba('aba-2');
  await faixa.atualizarFaixaJobs();
  tudoOk &= ok(porIdDe(faixa, 'faixa-jobs').hidden === true,
    'numa aba de outro projeto a faixa some: job de vizinho não é notícia daqui');

  // ── O relógio da lista: 5s para a lista, 15s para a faixa, um relógio só ─────
  //
  // O pedido de 22/08: ver o estado mais rápido no celular. O risco de errar aqui é
  // conhecido — dois setInterval discordando entre si — então o teste conta relógios,
  // não só requisições.
  const respira = () => new Promise((resolve) => setTimeout(resolve, 0));
  const contagem = { abas: 0, jobs: 0 };
  const ciclo = carregarCliente({
    guardado: memoria(),
    aoBuscar: (rota) => {
      if (rota.startsWith('api/jobs')) { contagem.jobs += 1; return { painel: true, jobs: [] }; }
      contagem.abas += 1;
      return { abas: [] };
    },
  });
  await respira();

  tudoOk &= ok(ciclo.relogios.size === 1,
    `o carregamento deixa UM relógio de pé (${ciclo.relogios.size})`);
  const [doCiclo] = [...ciclo.relogios.values()];
  tudoOk &= ok(doCiclo.ms === 5000, `e ele bate a cada 5s (${doCiclo.ms} ms)`);

  contagem.abas = 0;
  contagem.jobs = 0;
  for (let i = 0; i < 6; i += 1) { doCiclo.fn(); await respira(); }
  tudoOk &= ok(contagem.abas === 6, `a lista sai em todo tique (${contagem.abas} em 6)`);
  tudoOk &= ok(contagem.jobs === 2,
    `a faixa de jobs sai em 1 de cada 3 tiques — os mesmos 15s (${contagem.jobs} em 6)`);
  tudoOk &= ok(ciclo.relogios.size === 1, 'e os tiques não fazem nascer relógio novo');

  const aoMudarVisibilidade = ciclo.ouvintes.get('visibilitychange') || [];
  tudoOk &= ok(aoMudarVisibilidade.length === 1, 'a tela escuta visibilitychange (uma vez)');
  const virarTela = () => aoMudarVisibilidade.forEach((fn) => fn());

  ciclo.document.hidden = true;
  virarTela();
  tudoOk &= ok(ciclo.relogios.size === 0,
    'celular no bolso: o relógio pausa e para de bater no servidor');

  contagem.abas = 0;
  contagem.jobs = 0;
  ciclo.document.hidden = false;
  virarTela();
  await respira();
  tudoOk &= ok(contagem.abas === 1 && contagem.jobs === 1,
    'ao voltar para a frente, lista e faixa saem NA HORA, sem esperar o próximo tique');
  tudoOk &= ok(ciclo.relogios.size === 1, 'e o relógio volta — um só');

  virarTela();
  virarTela();
  await respira();
  tudoOk &= ok(ciclo.relogios.size === 1,
    `aparelho que avisa visibilidade duas vezes seguidas não empilha relógio (${ciclo.relogios.size})`);
  tudoOk &= ok(contagem.abas === 1 && contagem.jobs === 1,
    'nem dispara uma segunda rajada de requisições');

  const [depoisDaVolta] = [...ciclo.relogios.values()];
  contagem.jobs = 0;
  depoisDaVolta.fn();
  await respira();
  tudoOk &= ok(contagem.jobs === 0,
    'a contagem recomeça do zero: o tique seguinte à volta não repete a faixa de jobs');

  // ── Casamento job → aba, do lado do servidor ─────────────────────────────────
  const abasLib = require('../lib/abas');
  const janelas = [
    { chave: 'aba-1', cwd: '/home/y/projetos/cockpit-agentes' },
    { chave: 'aba-9', cwd: '/home/y/projetos/Cockpit Agentes' },
    { chave: 'aba-3', cwd: '/home/y/projetos/projeto-a' },
    { chave: 'aba-5', cwd: null },
  ];
  tudoOk &= ok(abasLib.abasDoProjeto('cockpit-agentes', janelas).join() === 'aba-1,aba-9',
    'o job casa com as abas cujo cwd tem o nome do projeto');
  tudoOk &= ok(abasLib.abasDoProjeto('Cóckpit Agêntes', janelas).join() === 'aba-1,aba-9',
    'acento e maiúscula não atrapalham o casamento');
  tudoOk &= ok(abasLib.abasDoProjeto('projeto-d', janelas).length === 0,
    'job sem aba nenhuma devolve lista vazia, e some da faixa');
  tudoOk &= ok(abasLib.abasDoProjeto('', janelas).length === 0
    && abasLib.abasDoProjeto(null, janelas).length === 0,
    'job sem projeto não casa com tudo por acidente');
  tudoOk &= ok(abasLib.abasDoProjeto('x', []).length === 0, 'sem aba aberta, ninguém casa');

  // `atualizadoEm` é o mtime do .jsonl. Sai o NÚMERO; o caminho continua interno.
  const cru = { chave: 'aba-1', alvo: '@1', titulo: 'x', sessaoId: 's',
    arquivo: '/home/y/.claude/projects/-home-y-projetos-x/s.jsonl', atualizadoEm: 1755800000000 };
  const paraTela = abasLib.paraCliente({ ...cru, esperando: true, pane: '%7' });
  tudoOk &= ok(paraTela.atualizadoEm === 1755800000000, '`atualizadoEm` sai em paraCliente');
  tudoOk &= ok(paraTela.esperando === true, '`esperando` sai em paraCliente — é o estado novo da lista');
  tudoOk &= ok(!('arquivo' in paraTela) && !('alvo' in paraTela) && !('pane' in paraTela),
    'e o caminho do .jsonl e os ids do tmux continuam sem sair para o navegador');

  // ── A exceção à D4: capture-pane só com a aba em `waiting` ───────────────────
  // A rota não pode virar espelho geral do terminal na web. A trava mora no módulo, não só
  // na rota: aqui ela é exercitada sem tmux nenhum no ar.
  let recusouTela = null;
  try { await abasLib.tela({ chave: 'aba-7', esperando: false, temClaude: true, pane: '%7' }); } catch (e) { recusouTela = e; }
  tudoOk &= ok(recusouTela !== null && /pergunta aberta/.test(recusouTela.message),
    'ler a tela de uma aba que não está esperando é recusado');
  recusouTela = null;
  try { await abasLib.tela(null); } catch (e) { recusouTela = e; }
  tudoOk &= ok(recusouTela !== null, 'e aba que não existe também');
  // Com `esperando`, ela roda o capture-pane de verdade. A pane forjada não existe, então
  // o tmux sai com erro — e o módulo trata isso como "nenhuma tela", não como falha.
  const paneMorta = await abasLib.tela({ chave: 'aba-7', esperando: true, pane: '%99999' });
  tudoOk &= ok(paneMorta.tela === '' && paneMorta.chave === 'aba-7',
    'pane que sumiu no meio devolve tela vazia em vez de estourar');

  // A saída da pane é lavada e tem teto: ESC e NUL viram sequência de controle na tela, e
  // um `cat` de arquivo grande na pane viraria uma resposta de megabytes no celular.
  const sujaDaPane = `linha \u001b[31mvermelha\u001b[0m\r\u0000\n${Array.from({ length: 200 }, (x, i) => `linha ${i}`).join('\n')}\n\n\n`;
  const moldada = abasLib.moldarTela(sujaDaPane);
  tudoOk &= ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r]/.test(moldada.tela),
    'a tela da pane sai sem ESC, NUL nem CR');
  tudoOk &= ok(moldada.linhas <= 80 && moldada.tela.split('\n').length <= 80,
    `e limitada em linhas (${moldada.linhas})`);
  tudoOk &= ok(moldada.tela.endsWith('linha 199') && !/linha 0$/m.test(moldada.tela),
    'o corte é pelo FIM: a pergunta e as opções ficam embaixo');
  tudoOk &= ok(abasLib.moldarTela(`${'x'.repeat(20000)}`).tela.length <= 8000,
    'e nenhuma tela passa do teto de caracteres');
  tudoOk &= ok(abasLib.moldarTela('   \n\n').tela === '', 'pane em branco não vira bloco de espaços');

  // ── Envio recusado com a pergunta aberta ─────────────────────────────────────
  // Não é a trava de concorrência recusada na D13: é a mesma família da #6 —
  // não deixar o texto virar TECLA no menu, como não deixa virar comando no shell.
  const abaOk = { chave: 'aba-p7', titulo: 'cockpit', agente: 'claude', temAgente: true, temClaude: true, esperando: false };
  tudoOk &= ok(abasLib.motivoDeRecusa(abaOk) === null, 'aba com claude e sem pergunta recebe texto');
  tudoOk &= ok(/pergunta aberta/.test(abasLib.motivoDeRecusa({ ...abaOk, esperando: true }) || ''),
    'aba esperando escolha recusa o envio, e o motivo diz como destravar (Esc)');
  tudoOk &= ok(/não tem agente/.test(abasLib.motivoDeRecusa({ ...abaOk, temAgente: false, temClaude: false }) || ''),
    'e a recusa de sempre (CLI fechado) continua valendo — e ela fala de AGENTE, não de claude');
  // A recusa passou a olhar `temAgente`, e é isso que faz uma aba de CODEX receber texto: ela
  // tem agente e não tem claude. Sem esta linha, o servidor recusaria a entrega inteira.
  tudoOk &= ok(abasLib.motivoDeRecusa({ ...abaOk, agente: 'codex', temClaude: false }) === null,
    'e a aba de CODEX (temAgente sem temClaude) recebe texto — quem manda é `temAgente`');

  // ── PRÉ-SESSÃO: agente vivo, nenhuma sessão publicada (09/09) ────────────────
  //
  // O degrau ANTES da #25. No prompt de confiança de pasta nova ("Do you trust this
  // folder?") o Claude não escreve `~/.claude/sessions/<pid>.json` e o Codex não abre
  // rollout — medido nos dois em socket tmux isolado. A aba fica com `temAgente: true`,
  // `esperando` falsy e nenhum arquivo: sem este estado ela era indistinguível de uma aba
  // parada à toa, e a tela ficava preta com o agente travado numa pergunta de sim/não.
  //
  // Depende de: `podeVerTela`, `motivoDaTela` e `preSessao` (lib/abas.js). Se algum deles
  // for renomeado, é aqui que se procura.
  const abaPre = { ...abaOk, esperando: false, preSessao: true };
  tudoOk &= ok(abasLib.podeVerTela(abaPre) === true && abasLib.podeVerTela(abaOk) === false,
    'preSessao abre a tela da pane; aba com conversa continua recusando (D4/D6 de pé)');
  tudoOk &= ok(abasLib.podeVerTela({ ...abaOk, esperando: true }) === true,
    'e o `waiting` de sempre continua abrindo');
  tudoOk &= ok(abasLib.motivoDaTela(abaPre) === 'pre-sessao'
    && abasLib.motivoDaTela({ ...abaOk, esperando: true, preSessao: true }) === 'menu',
    'o motivo separa os dois — e `waiting` GANHA de preSessao quando os dois valem');
  // A recusa do envio é o item que faltava e o buraco era real: até 09/09 uma aba recém-criada
  // em projeto novo aceitava o POST calada, e cada letra virava tecla do menu de confiança —
  // alguma delas escolhe "No, exit", que MATA o agente.
  const recusaPre = abasLib.motivoDeRecusa(abaPre) || '';
  tudoOk &= ok(/confirmação no terminal/.test(recusaPre) && !/Esc/.test(recusaPre),
    'preSessao recusa o texto — e o recado NÃO manda apertar Esc, que ali fecha o agente');
  // A tela e as teclas atendem no estado novo. A pane forjada não existe: o que se prova aqui
  // é que a GUARDA deixou passar, não que o tmux respondeu.
  const telaPre = await abasLib.tela({ chave: 'aba-7', esperando: false, preSessao: true, pane: '%99999' });
  tudoOk &= ok(telaPre.motivo === 'pre-sessao' && telaPre.chave === 'aba-7',
    'abasLib.tela() atende no preSessao e carimba o motivo para o cliente escolher o texto');
  tudoOk &= ok(abasLib.motivoDeRecusaDeTecla(abaPre, 'Down') === null
    && /pergunta aberta/.test(abasLib.motivoDeRecusaDeTecla(abaOk, 'Down') || ''),
    'as setas respondem o prompt de confiança, e continuam recusadas fora dos dois estados');
  tudoOk &= ok(/tecla não permitida/.test(abasLib.motivoDeRecusaDeTecla(abaPre, 'x') || ''),
    'e a lista de teclas continua FECHADA no preSessao — nada de teclado remoto (D4/D6)');

  // ── A lista FECHADA de teclas ────────────────────────────────────────────────
  // Aceitar tecla livre do cliente transformaria a rota num teclado remoto, que é o que a
  // D4 e a D6 recusaram. As quatro setas mais Enter e Escape respondem qualquer menu; nada
  // além delas passa. `Left` e `Right` entraram em 28/08: menu de duas opções lado a lado e
  // passo de assistente andam na horizontal, e o cockpit lia sem conseguir responder.
  tudoOk &= ok(['Up', 'Down', 'Left', 'Right', 'Enter', 'Escape'].every((t) => abasLib.teclaValida(t)),
    'as quatro setas, o Enter e o Escape são aceitos');
  tudoOk &= ok([...abasLib.TECLAS.keys()].length === 6, 'e são só seis — a lista continua FECHADA');
  tudoOk &= ok([...abasLib.TECLAS.keys()].every((t) => /^(Up|Down|Left|Right|Enter|Escape)$/.test(t)),
    'e todas são de NAVEGAÇÃO: nenhum caractere entrou junto, que é o que viraria teclado remoto');
  for (const proibida of ['a', 'C-c', 'Escape Enter', 'rm -rf', '', null, 'Down;Enter']) {
    tudoOk &= ok(!abasLib.teclaValida(proibida), `tecla livre é recusada (${JSON.stringify(proibida)})`);
  }
  tudoOk &= ok(/não permitida/.test(abasLib.motivoDeRecusaDeTecla({ ...abaOk, esperando: true }, 'q') || ''),
    'a recusa da tecla vem antes de tudo — é pedido malformado, não estado do mundo');
  tudoOk &= ok(/pergunta aberta/.test(abasLib.motivoDeRecusaDeTecla({ ...abaOk, esperando: false }, 'Down') || ''),
    'e tecla com a aba FORA de `waiting` é recusada (o 409 da rota)');
  tudoOk &= ok(abasLib.motivoDeRecusaDeTecla({ ...abaOk, esperando: true }, 'Down') === null,
    'com a pergunta aberta e tecla da lista, passa');
  tudoOk &= ok(/não encontrada/.test(abasLib.motivoDeRecusaDeTecla(null, 'Down') || ''),
    'aba que não existe também recusa');

  // A tecla passa pela MESMA fila por aba do texto: dois toques rápidos no ↓ são dois
  // POSTs, e sem a fila eles se intercalam como os send-keys de duas mensagens (#28).
  tudoOk &= ok(/function tecla\([^)]*\)\s*\{\s*return enfileirarPorAba\(/.test(fonteAbas),
    'a tecla passa pela serialização por aba, igual ao envio de texto');

  // E a rota traduz as duas recusas em códigos diferentes: 400 para tecla fora da lista,
  // 409 para a aba fora de `waiting`. Confundir os dois esconde qual dos erros aconteceu.
  const fonteServidor = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const blocoTeclas = fonteServidor.slice(fonteServidor.indexOf('mAbaTecla'));
  tudoOk &= ok(/teclaValida\(tecla\)\)\s*\{[\s\S]{0,120}?400/.test(blocoTeclas),
    'a rota devolve 400 para tecla fora da lista fechada');
  tudoOk &= ok(/409/.test(blocoTeclas.slice(0, 1200)), 'e 409 para o resto (aba fora de `waiting`)');

  // Os seis botões existem na tela e são os seis certos. Split view, fase 2 (R3 da spec): o
  // markup migrou do HTML para o `criarPainel` do app.js — sem `id` (R17), só `data-tecla` —
  // então a prova vira assert de DOM em vez de assert de fonte.
  const clienteTeclas = carregarCliente();
  const teclasNaTela = porIdDe(clienteTeclas, 'pergunta').querySelectorAll('.tecla');
  tudoOk &= ok(teclasNaTela.length === 6, `as seis teclas existem no DOM do painel (${teclasNaTela.length})`);
  tudoOk &= ok(['Left', 'Up', 'Down', 'Right', 'Enter', 'Escape']
    .every((t) => teclasNaTela.some((el) => el.dataset.tecla === t)),
    'e são as seis certas, cada uma com o próprio data-tecla');
  const cssTeclas = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');
  tudoOk &= ok(/\.pergunta-teclas \.tecla \{[^}]*min-height:\s*40px/.test(cssTeclas),
    'e o alvo do dedo tem 40px: errar a seta num menu de permissão escolhe a opção errada');

  // Régua do histórico cortado: sem ela a conversa começa no meio de um assunto e não há
  // como saber se foi só isso que aconteceu.
  fita.filhos = [];
  cliente.aplicar({ tipo: 'historico_cortado' });
  const inicio = fita.filhos.filter((f) => f.className === 'corte corte-inicio');
  tudoOk &= ok(inicio.length === 1, 'o aviso de histórico cortado vira uma régua na fita');
  tudoOk &= ok(inicio.length === 1 && /não foi carregado/.test(inicio[0].textContent),
    'e ela diz que o começo não foi carregado');

  // Consumo do plano: parse do texto do /usage, sem gastar turno nenhum.
  const limite = require('../lib/limite');
  const amostra = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 25% used · resets Aug 20, 5:20pm (UTC)',
    'Current week (all models): 47% used · resets Aug 21, 3am (UTC)',
    'Current week (Fable): 4% used · resets Aug 21, 3am (UTC)',
    '',
    'What\'s contributing to your limits usage?',
  ].join('\n');
  const agora = Date.parse('2026-08-20T14:00:00Z');
  const lidos = limite.analisar(amostra, agora);
  tudoOk &= ok(lidos.length === 3, `as três janelas do plano foram lidas (${lidos.length})`);
  tudoOk &= ok(lidos[0].rotulo === 'Sessão (5h)' && lidos[0].usado === 25,
    'a janela de 5h vem com a porcentagem consumida');
  tudoOk &= ok(lidos[1].rotulo === 'Semana (tudo)' && lidos[1].usado === 47, 'a semana também');
  tudoOk &= ok(lidos[0].resetaEm === Date.parse('2026-08-20T17:20:00Z'),
    'o horário do reset vira epoch, para dar o tempo que falta');
  tudoOk &= ok(limite.analisar('o formato do CLI mudou', agora).length === 0,
    'formato desconhecido devolve vazio em vez de inventar número');
  tudoOk &= ok(limite.paraEpoch('Jan 2, 3am (UTC)', Date.parse('2026-12-31T23:00:00Z'))
    === Date.parse('2027-01-02T03:00:00Z'), 'a virada de ano no reset não volta no tempo');

  // "faltam 2h 13min" é o que o dono pediu ver no lugar de um "liberado" seco.
  tudoOk &= ok(cliente.tempoAte(Date.now() + 2 * 3600e3 + 13 * 60e3) === 'faltam 2h 13min',
    'o tempo restante sai legível');
  tudoOk &= ok(cliente.tempoAte(Date.now() + 45 * 60e3) === 'faltam 45min', 'menos de uma hora vira só minutos');
  tudoOk &= ok(cliente.tempoAte(Date.now() - 1000) === 'já resetou', 'janela vencida não mostra número negativo');

  // Estado da conversa: a heurística de "o agente perguntou" olha o fim do último texto.
  const sessoes = require('../lib/sessoes');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-estado-'));
  const fala = (texto) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: texto }] } });
  const escrever = (n, linhas) => fs.writeFileSync(path.join(tmp, `turno-${n}.jsonl`), `${linhas.join('\n')}\n`);

  escrever(1, [fala('Fiz o que pediu.'), fala('Quer que eu rode os testes agora?')]);
  tudoOk &= ok(sessoes.perguntouNoFim(tmp, 1) === true, 'terminar com pergunta marca "respondeu você"');

  escrever(2, [fala('Pronto. Os testes passaram.')]);
  tudoOk &= ok(sessoes.perguntouNoFim(tmp, 2) === false, 'terminar com afirmação não marca');

  escrever(3, [fala('Quer que eu siga?'), fala('Segui e terminou tudo.')]);
  tudoOk &= ok(sessoes.perguntouNoFim(tmp, 3) === false, 'pergunta no meio, resposta no fim: não marca');

  escrever(4, [fala('Isso resolve? **Sim.**\n\nQuer o resto agora?')]);
  tudoOk &= ok(sessoes.perguntouNoFim(tmp, 4) === true, 'a última linha é que manda, não a primeira');

  escrever(5, [fala('Terminei. Detalhes no PR. (era isso?)')]);
  tudoOk &= ok(sessoes.perguntouNoFim(tmp, 5) === true, 'pergunta entre parênteses ainda é pergunta');
  tudoOk &= ok(sessoes.perguntouNoFim(tmp, 99) === false, 'turno inexistente não explode');
  fs.rmSync(tmp, { recursive: true, force: true });

  // A ordem da lista e o controle de "não lida" saíram em 21/08 junto com as conversas do
  // cockpit: a lista agora é a das abas do terminal, e a ordem dela é a do próprio tmux.

  // Conversa que passou por fora do cockpit (terminal na mesma sessão).
  const externo = require('../lib/externo');
  const dirFora = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fora-'));
  const linha = (o) => `${JSON.stringify(o)}\n`;
  const humano = (t, meta) => linha({ type: 'user', message: { content: t }, ...meta });
  const agente = (t) => linha({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  fs.writeFileSync(path.join(dirFora, 'sessao.jsonl'), [
    humano('turno do cockpit'),
    agente('respondi ao cockpit'),
    humano('digitado no terminal'),
    agente('respondi ao terminal'),
    humano('mais um do cockpit'),
    agente('pronto'),
    // Ruído que NÃO pode virar mensagem na tela:
    humano('injeção do sistema', { isMeta: true }),
    linha({ type: 'user', message: { content: [{ type: 'tool_result', content: 'saída' }] } }),
    linha({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagente' }] } }),
  ].join(''));

  // Aponta o localizador para o arquivo de mentira reaproveitando a busca por cwd.
  const achado = await externo.arquivoDaSessao('nao-existe-em-lugar-nenhum', '/tmp/nada');
  tudoOk &= ok(achado === null, 'sessão que o CLI não conhece devolve nulo em vez de explodir');

  // trocasDeFora lendo o arquivo montado acima, via caminho derivado do cwd.
  const raizFalsa = path.join(dirFora, 'projects');
  const pastaFalsa = path.join(raizFalsa, '-tmp-projeto');
  fs.mkdirSync(pastaFalsa, { recursive: true });
  fs.copyFileSync(path.join(dirFora, 'sessao.jsonl'), path.join(pastaFalsa, 'sess-1.jsonl'));

  // O módulo lê de ~/.claude/projects; para o teste, um HOME temporário.
  const homeReal = process.env.HOME;
  const homeFalso = path.join(dirFora, 'home');
  fs.mkdirSync(path.join(homeFalso, '.claude'), { recursive: true });
  fs.cpSync(raizFalsa, path.join(homeFalso, '.claude', 'projects'), { recursive: true });
  process.env.HOME = homeFalso;
  delete require.cache[require.resolve('../lib/externo')];
  const externoFalso = require('../lib/externo');

  const trechos = await externoFalso.trocasDeFora('sess-1', '/tmp/projeto',
    ['turno do cockpit', 'mais um do cockpit']);
  tudoOk &= ok(trechos.length === 1, `achou o trecho que veio do terminal (${trechos.length})`);
  tudoOk &= ok(trechos[0].depoisDoTurno === 1,
    'e sabe que ele entra depois do primeiro turno do cockpit, não no fim da conversa');
  const textosDeFora = trechos[0].eventos.map((e) => e.texto);
  tudoOk &= ok(textosDeFora.includes('digitado no terminal') && textosDeFora.includes('respondi ao terminal'),
    'trazendo a pergunta e a resposta');
  tudoOk &= ok(trechos[0].eventos.every((e) => e.deFora === true),
    'tudo marcado como vindo de fora, para a tela poder diferenciar');
  tudoOk &= ok(!textosDeFora.some((t) => /injeção do sistema|saída|subagente/.test(t)),
    'sem injeção do sistema, sem tool_result e sem subagente — só conversa de verdade');

  const semNada = await externoFalso.trocasDeFora('sess-1', '/tmp/projeto',
    ['turno do cockpit', 'digitado no terminal', 'mais um do cockpit']);
  tudoOk &= ok(semNada.length === 0,
    'se tudo passou pelo cockpit, não há nada "de fora" para mostrar');

  // A conversa INTEIRA de um arquivo do CLI, que é o que a tela de uma aba do terminal
  // desenha. O vocabulário precisa ser o mesmo do adaptador, senão o `aplicar()` do
  // cliente recebe eventos que ele não conhece e a fita fica muda.
  const t0 = Date.now(); // cronômetro do bloco INTEIRO de lerConversa — fecha no fim da seção nova
  const conversa = await externoFalso.lerConversa(path.join(pastaFalsa, 'sess-1.jsonl'));
  const tipos = conversa.eventos.map((e) => e.tipo);
  tudoOk &= ok(tipos.filter((t) => t === 'humano').length === 3,
    `as três falas do humano viraram evento (${tipos.filter((t) => t === 'humano').length})`);
  tudoOk &= ok(tipos.includes('texto') && tipos.includes('resultado_ferramenta'),
    'resposta do agente e resultado de ferramenta também');
  tudoOk &= ok(!conversa.eventos.some((e) => e.texto === 'subagente'),
    'subagente continua fora: é barulho de máquina, não a conversa');
  tudoOk &= ok(!conversa.eventos.some((e) => e.texto === 'injeção do sistema'),
    'e injeção do sistema também não vira bolha');

  // O `timestamp` de cada linha é o que faz a hora aparecer na fita. Ele sempre esteve no
  // arquivo e era descartado aqui — os eventos chegavam à tela sem hora nenhuma.
  const comQuando = externoFalso.eventosDoObjeto({
    type: 'user', timestamp: '2026-08-22T22:50:21.752Z', message: { content: 'oi' },
  });
  tudoOk &= ok(comQuando[0] && comQuando[0].quando === '2026-08-22T22:50:21.752Z',
    'a fala do humano leva o timestamp da linha para a tela');
  const faladoAgente = externoFalso.eventosDoObjeto({
    type: 'assistant', timestamp: '2026-08-22T22:51:00.000Z',
    message: { content: [{ type: 'text', text: 'respondi' }, { type: 'tool_use', id: 't-1', name: 'Read', input: {} }] },
  });
  tudoOk &= ok(faladoAgente[0].quando === '2026-08-22T22:51:00.000Z',
    'a fala do agente também');
  tudoOk &= ok(faladoAgente[1].quando === undefined,
    'ferramenta não leva hora própria: é máquina falando com máquina, não bolha');
  const semQuando = externoFalso.eventosDoObjeto({ type: 'user', message: { content: 'linha velha' } });
  tudoOk &= ok(semQuando.length === 1 && semQuando[0].tipo === 'humano' && semQuando[0].quando === undefined,
    'e linha sem timestamp continua virando evento normalmente, só sem hora');

  // Leitura incremental: é o que faz a resposta aparecer no celular enquanto o agente
  // ainda escreve, sem reler um arquivo de megabytes a cada batida.
  const soONovo = await externoFalso.lerConversa(path.join(pastaFalsa, 'sess-1.jsonl'), conversa.tamanho);
  tudoOk &= ok(soONovo.eventos.length === 0, 'reler do fim não repete o que já foi mandado');
  fs.appendFileSync(path.join(pastaFalsa, 'sess-1.jsonl'), agente('chegou depois'));
  const cresceu = await externoFalso.lerConversa(path.join(pastaFalsa, 'sess-1.jsonl'), conversa.tamanho);
  tudoOk &= ok(cresceu.eventos.some((e) => e.texto === 'chegou depois'),
    'o que o agente escreveu depois vem sozinho, sem a conversa toda junto');

  // Leitura INICIAL de arquivo grande: para trás, por MENSAGEM (não mais por byte, desde
  // 24/08). O maior .jsonl do disco tem 44 MB, e despejar tudo fazia a conversa inteira
  // passar na tela do celular antes de dar para digitar. Cada linha carrega `timestamp`
  // crescente, como um .jsonl de verdade — sem isso nenhuma linha contaria como mensagem
  // e o corte nunca pararia no alvo.
  const grande = path.join(pastaFalsa, 'grande.jsonl');
  const recheio = 137;
  let quandoGrandeMs = Date.parse('2026-08-01T00:00:00.000Z');
  const linhaGrande = (i) => linha({
    type: 'assistant', timestamp: new Date(quandoGrandeMs += 1000).toISOString(),
    message: { content: [{ type: 'text', text: `bloco-${String(i).padStart(5, '0')} ${'x'.repeat(recheio)}` }] },
  });
  const passo = Buffer.byteLength(linhaGrande(0), 'utf8');
  const quantasLinhas = Math.ceil((400 * 1024) / passo);
  let conteudoGrande = '';
  for (let i = 0; i < quantasLinhas; i += 1) conteudoGrande += linhaGrande(i);
  fs.writeFileSync(grande, conteudoGrande);
  const bytesGrande = fs.readFileSync(grande);
  const TETO = 256 * 1024;
  const contarMensagens = (r) => r.eventos.filter((e) => Number.isFinite(Date.parse(e.quando || ''))).length;

  const cauda = await externoFalso.lerConversa(grande);
  tudoOk &= ok(cauda.cortado === true, 'arquivo grande vem cortado — e o retorno avisa que veio');
  tudoOk &= ok(contarMensagens(cauda) >= externoFalso.ALVO_MENSAGENS,
    `a leitura para trás junta pelo menos ALVO_MENSAGENS mensagens (${contarMensagens(cauda)} >= ${externoFalso.ALVO_MENSAGENS})`);
  tudoOk &= ok(cauda.bytesLidos <= externoFalso.TETO_DURO,
    `bytesLidos nunca passa do teto duro (${cauda.bytesLidos} <= ${externoFalso.TETO_DURO})`);
  tudoOk &= ok(cauda.eventos.every((e) => /^bloco-\d{5} x+$/.test(e.texto)),
    'nenhuma linha partida virou evento quebrado');
  tudoOk &= ok(cauda.eventos[cauda.eventos.length - 1].texto
    .startsWith(`bloco-${String(quantasLinhas - 1).padStart(5, '0')}`),
    'e a última linha do arquivo é a última da tela');
  tudoOk &= ok(cauda.tamanho === bytesGrande.length,
    'o marcador aponta para o fim do arquivo, para o incremental continuar dali');

  // A leitura INCREMENTAL não muda em nada: cortá-la seria perder resposta chegando.
  fs.appendFileSync(grande, agente('chegou depois do corte'));
  const apos = await externoFalso.lerConversa(grande, cauda.tamanho);
  tudoOk &= ok(apos.cortado === false && apos.eventos.length === 1
    && apos.eventos[0].texto === 'chegou depois do corte',
    'leitura incremental traz só o que cresceu, sem cortar nada');

  const antesDoMonte = fs.statSync(grande).size;
  let monte = '';
  let quantasNovas = 0;
  while (Buffer.byteLength(monte, 'utf8') <= TETO) {
    monte += linhaGrande(quantasNovas);
    quantasNovas += 1;
  }
  fs.appendFileSync(grande, monte);
  const tudoQueCresceu = await externoFalso.lerConversa(grande, antesDoMonte);
  tudoOk &= ok(Buffer.byteLength(monte, 'utf8') > TETO, 'o pedaço novo passa dos 256 KB');
  tudoOk &= ok(tudoQueCresceu.cortado === false && tudoQueCresceu.eventos.length === quantasNovas,
    `e mesmo assim vem inteiro (${tudoQueCresceu.eventos.length}) — o teto é só da leitura inicial`);

  // Arquivo pequeno segue idêntico ao que sempre foi: nada de corte, nada de aviso.
  const pequeno = await externoFalso.lerConversa(path.join(pastaFalsa, 'sess-1.jsonl'));
  tudoOk &= ok(pequeno.cortado === false, 'arquivo pequeno não é cortado nem se anuncia como tal');

  // Linha pela metade: acontece o tempo todo, porque a leitura pega o arquivo no meio de
  // uma escrita. Ela não pode virar evento quebrado nem travar o resto.
  const meio = path.join(pastaFalsa, 'meio.jsonl');
  fs.writeFileSync(meio, agente('inteira') + '{"type":"assistant","message":{"content":[{"type":"te');
  const cortada = await externoFalso.lerConversa(meio);
  tudoOk &= ok(cortada.eventos.length === 1, 'linha incompleta não vira evento');
  tudoOk &= ok(cortada.tamanho < fs.statSync(meio).size,
    'e o marcador para ANTES dela, para ela chegar inteira na próxima leitura');

  console.log('\n  · histórico: o corte é por MENSAGEM, não por byte');

  // "Mensagem" é o que a fita desenharia como bolha: evento com `quando` que o Date.parse
  // entende. É a MESMA régua de horaDaUltimaMensagem (D28/armadilha #34) — um segundo
  // conceito de "mensagem" aqui seria um segundo lugar para discordar do primeiro.
  const msgsDe = (r) => r.eventos.filter((e) => Number.isFinite(Date.parse(e.quando || ''))).length;

  // A regra VELHA, copiada de `git show HEAD:lib/externo.js` — não reescrita de memória —
  // para a comparação não poder "acertar por acaso". Assinatura igual ao original: async,
  // recebe o CAMINHO, devolve `{ eventos, tamanho, cortado }` (sem `bytesLidos`, que não
  // existia). Chama `eventosDoObjeto` DO MÓDULO, porque o que se compara é o corte, não o parse.
  async function lerPelaRegraVelha(arquivo, desde = 0) {
    let info;
    try {
      info = await fs.promises.stat(arquivo);
    } catch {
      return { eventos: [], tamanho: 0, cortado: false };
    }
    const inicioVelha = desde > info.size ? 0 : desde;
    if (inicioVelha === info.size) return { eventos: [], tamanho: info.size, cortado: false };
    const TETO_REGRA_VELHA = 256 * 1024;
    const cortadoVelha = inicioVelha === 0 && info.size > TETO_REGRA_VELHA;
    const deVelha = cortadoVelha ? info.size - TETO_REGRA_VELHA : inicioVelha;
    let brutoVelha = '';
    const alcaVelha = await fs.promises.open(arquivo, 'r');
    try {
      const bufferVelha = Buffer.alloc(info.size - deVelha);
      const { bytesRead } = await alcaVelha.read(bufferVelha, 0, bufferVelha.length, deVelha);
      brutoVelha = bufferVelha.subarray(0, bytesRead).toString('utf8');
    } finally {
      await alcaVelha.close();
    }
    const linhasVelha = brutoVelha.split('\n');
    const sobraVelha = brutoVelha.endsWith('\n') ? '' : linhasVelha.pop() ?? '';
    if (cortadoVelha) linhasVelha.shift();
    const eventosVelha = [];
    for (const linhaVelha of linhasVelha) {
      if (!linhaVelha.trim()) continue;
      try {
        eventosVelha.push(...externoFalso.eventosDoObjeto(JSON.parse(linhaVelha)));
      } catch { /* linha pela metade ou formato que não conhecemos: segue */ }
    }
    return { eventos: eventosVelha, tamanho: info.size - Buffer.byteLength(sobraVelha, 'utf8'), cortado: cortadoVelha };
  }

  // A fixture fechada de §5.2 da spec: 42 linhas, 40 mensagens (20 antigas + 20 novas), com
  // um par ferramenta/resultado no meio carregando uma "imagem" de 400 KB em base64 — a
  // forma REAL medida em aba-10 (`type: "user"` com `image/jpeg` dentro de `tool_result`).
  function construirFixture520(k) {
    let quandoMs520 = Date.parse('2026-08-20T10:00:00.000Z');
    const proximoQuando520 = () => new Date(quandoMs520 += 1000).toISOString();
    const linhas520 = [];
    for (let i = 1; i <= 20; i += 1) {
      linhas520.push(linha({
        type: 'assistant', timestamp: proximoQuando520(),
        message: { content: [{ type: 'text', text: `msg-antiga-${String(i).padStart(2, '0')}` }] },
      }));
    }
    linhas520.push(linha({
      type: 'assistant', timestamp: proximoQuando520(),
      message: { content: [{ type: 'tool_use', id: 't-1', name: 'Read', input: { file_path: '/tmp/x' } }] },
    }));
    const imagem520 = 'A'.repeat(400 * 1024);
    linhas520.push(linha({
      type: 'user', timestamp: proximoQuando520(),
      message: {
        content: [{
          type: 'tool_result', tool_use_id: 't-1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imagem520 } }],
        }],
      },
    }));
    for (let i = 1; i <= 20; i += 1) {
      const texto520 = `msg-nova-${String(i).padStart(2, '0')}` + (i === 1 ? '.'.repeat(k) : '');
      linhas520.push(linha({
        type: 'assistant', timestamp: proximoQuando520(),
        message: { content: [{ type: 'text', text: texto520 }] },
      }));
    }
    return linhas520.join('');
  }

  // Posicionar o par de ferramenta EM CIMA de uma fronteira de bloco de 64 KB: acrescentar
  // linhas ANTES do par não muda a distância dele até o FIM do arquivo, então o enchimento
  // entra DEPOIS do par (sufixo de `K` pontos em msg-nova-01). Cada +1 em K empurra as duas
  // distâncias em 1 byte, então a busca é determinística: mesmo K em qualquer máquina.
  const offsetsDeLinhas520 = (conteudo) => {
    const partes = conteudo.split('\n');
    let deslocamento = 0;
    const lista = [];
    for (const parte of partes) {
      lista.push(deslocamento);
      deslocamento += Buffer.byteLength(parte, 'utf8') + 1;
    }
    return lista;
  };
  const fixtureBase520 = construirFixture520(0);
  const offsetsBase520 = offsetsDeLinhas520(fixtureBase520);
  const totalBase520 = Buffer.byteLength(fixtureBase520, 'utf8');
  const distToolUseBase520 = totalBase520 - offsetsBase520[20];   // linha 21 (índice 20): tool_use
  const distToolResultBase520 = totalBase520 - offsetsBase520[21]; // linha 22 (índice 21): tool_result
  let K520 = -1;
  for (let k = 0; k <= 65535; k += 1) {
    const du520 = distToolUseBase520 + k;
    const dr520 = distToolResultBase520 + k;
    if (Math.floor(du520 / 65536) !== Math.floor(dr520 / 65536)) { K520 = k; break; }
  }
  tudoOk &= ok(K520 >= 0 && K520 <= 65535,
    `achou o K que separa o par ferramenta/resultado numa fronteira de bloco de 64 KB (K=${K520})`);

  const arquivoFixture520 = path.join(pastaFalsa, 'fixture-520.jsonl');
  fs.writeFileSync(arquivoFixture520, construirFixture520(K520));
  const tamanhoFixture520 = fs.statSync(arquivoFixture520).size;

  // Confere a fronteira no ARQUIVO DE VERDADE gravado em disco, não só na fórmula — para a
  // fixture não "curar sozinha" se o formato mudar no futuro.
  const conteudoFixture520 = fs.readFileSync(arquivoFixture520, 'utf8');
  const offsetsFixture520 = offsetsDeLinhas520(conteudoFixture520);
  const distToolUseFixture520 = tamanhoFixture520 - offsetsFixture520[20];
  const distToolResultFixture520 = tamanhoFixture520 - offsetsFixture520[21];
  tudoOk &= ok(Math.floor(distToolUseFixture520 / 65536) !== Math.floor(distToolResultFixture520 / 65536),
    'o par ferramenta/resultado cai em BLOCOS de 64 KB diferentes — é a fronteira que a emenda precisa tratar');

  // A ordem importa: o K foi fixado ANTES, o N da regra velha é medido AGORA — senão o
  // literal registrado seria de uma fixture que não existe mais.
  const resultadoRegraVelha520 = await lerPelaRegraVelha(arquivoFixture520);
  const MSGS_REGRA_VELHA = 20; // medido nesta fixture determinística — ver relatório da Fase 0
  tudoOk &= ok(msgsDe(resultadoRegraVelha520) === MSGS_REGRA_VELHA,
    `a regra velha (cópia verbatim de git show HEAD:lib/externo.js) lê exatamente ${MSGS_REGRA_VELHA} mensagens nesta fixture — cópia errada reprova aqui (medido: ${msgsDe(resultadoRegraVelha520)})`);

  const resultadoNova520 = await externoFalso.lerConversa(arquivoFixture520);
  tudoOk &= ok(msgsDe(resultadoNova520) > MSGS_REGRA_VELHA,
    `a regra NOVA lê mais mensagens que a velha na mesma fixture (velha=${MSGS_REGRA_VELHA}, atual=${msgsDe(resultadoNova520)}) — é a prova de que o bug foi consertado`);

  // A tabela de asserções normativas de §5.2 da spec, contra `lerConversa` (a regra ATUAL
  // do módulo — hoje a velha, depois da Fase 1 a nova).
  tudoOk &= ok(msgsDe(resultadoNova520) === 40,
    `a contagem de mensagens é exatamente a esperada para este arquivo: 40 (medido: ${msgsDe(resultadoNova520)})`);
  const textosNova520 = resultadoNova520.eventos.filter((e) => e.tipo === 'texto').map((e) => e.texto);
  const textosEsperados520 = [
    ...Array.from({ length: 20 }, (_, i) => `msg-antiga-${String(i + 1).padStart(2, '0')}`),
    `msg-nova-01${'.'.repeat(K520)}`,
    ...Array.from({ length: 19 }, (_, i) => `msg-nova-${String(i + 2).padStart(2, '0')}`),
  ];
  tudoOk &= ok(JSON.stringify(textosNova520) === JSON.stringify(textosEsperados520),
    'os textos saem na ordem do arquivo, do mais antigo para o mais novo — a montagem é por blocos ao contrário');
  tudoOk &= ok(new Set(textosNova520).size === textosNova520.length,
    'nenhum texto se repete — bloco contado duas vezes seria o erro natural aqui');
  const resultadosImagem520 = resultadoNova520.eventos.filter((e) => e.tipo === 'resultado_ferramenta' && e.id === 't-1');
  tudoOk &= ok(resultadosImagem520.length === 1,
    'a mensagem da imagem (resultado_ferramenta t-1) está lá, uma vez só — é a linha que hoje come a janela');
  tudoOk &= ok(textosNova520.slice(0, 20).every((tt) => tt.startsWith('msg-antiga-')),
    'as mensagens de ANTES da imagem estão lá — é o bug: hoje a imagem apaga tudo atrás dela');
  const idxFerramenta520 = resultadoNova520.eventos.findIndex((e) => e.tipo === 'ferramenta' && e.id === 't-1');
  const idxResultado520 = resultadoNova520.eventos.findIndex((e) => e.tipo === 'resultado_ferramenta' && e.id === 't-1');
  tudoOk &= ok(idxFerramenta520 >= 0 && idxResultado520 > idxFerramenta520,
    `o \`ferramenta\` de id t-1 aparece com índice MENOR que o \`resultado_ferramenta\` de id t-1 (ferramenta=${idxFerramenta520}, resultado=${idxResultado520})`);
  tudoOk &= ok(resultadoNova520.cortado === false, 'cortado === false: o arquivo cabe inteiro, a régua não mente');
  tudoOk &= ok(resultadoNova520.tamanho === tamanhoFixture520,
    'tamanho === size do arquivo, para o incremental continuar dali');

  // Fixture SEPARADA para o órfão: as 42 linhas fechadas não têm resultado órfão nenhum.
  // Um resultado_ferramenta sem o tool_use correspondente não pode quebrar a montagem — é o
  // que a fita já ignora em silêncio (public/app.js:1233-1234).
  const arquivoOrfao520 = path.join(pastaFalsa, 'orfao-520.jsonl');
  fs.writeFileSync(arquivoOrfao520, [
    linha({ type: 'user', timestamp: '2026-08-24T09:00:00.000Z', message: { content: 'fala solta do humano' } }),
    linha({
      type: 'user', timestamp: '2026-08-24T09:00:01.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 't-99', content: 'saída de um par que não tem ferramenta' }] },
    }),
  ].join(''));
  const resultadoOrfao520 = await externoFalso.lerConversa(arquivoOrfao520);
  tudoOk &= ok(resultadoOrfao520.eventos.length === 2,
    `resultado_ferramenta ÓRFÃO não quebra a montagem — os dois eventos vêm sem explodir (${resultadoOrfao520.eventos.length})`);
  tudoOk &= ok(resultadoOrfao520.eventos.some((e) => e.tipo === 'humano' && e.texto === 'fala solta do humano'),
    'e a fala do humano continua intacta');
  tudoOk &= ok(resultadoOrfao520.eventos.some((e) => e.tipo === 'resultado_ferramenta' && e.id === 't-99'),
    'o resultado órfão aparece presente, mesmo sem cartão para fechar na tela');

  // Os retornos curtos, que nenhum outro teste cobre.
  const resultadoInexistente520 = await externoFalso.lerConversa('/tmp/nao-existe-nunca.jsonl');
  tudoOk &= ok(resultadoInexistente520.eventos.length === 0 && resultadoInexistente520.tamanho === 0
    && resultadoInexistente520.cortado === false && resultadoInexistente520.bytesLidos === 0,
    `arquivo que não existe devolve o retorno curto com bytesLidos 0 (bytesLidos=${resultadoInexistente520.bytesLidos})`);

  const resultadoSemNovo520 = await externoFalso.lerConversa(arquivoFixture520, tamanhoFixture520);
  tudoOk &= ok(resultadoSemNovo520.eventos.length === 0 && resultadoSemNovo520.bytesLidos === 0
    && resultadoSemNovo520.tamanho === tamanhoFixture520,
    `ler exatamente do fim (nada novo) devolve vazio com bytesLidos 0 (bytesLidos=${resultadoSemNovo520.bytesLidos})`);

  const arquivoEncolheu520 = path.join(pastaFalsa, 'encolheu-520.jsonl');
  fs.writeFileSync(arquivoEncolheu520, construirFixture520(K520));
  const tamanhoAntesDeEncolher520 = fs.statSync(arquivoEncolheu520).size;
  fs.writeFileSync(arquivoEncolheu520,
    linha({ type: 'assistant', timestamp: '2026-08-24T09:00:02.000Z', message: { content: [{ type: 'text', text: 'arquivo recomeçou pequeno' }] } }));
  const resultadoEncolhido520 = await externoFalso.lerConversa(arquivoEncolheu520, tamanhoAntesDeEncolher520);
  tudoOk &= ok(Array.isArray(resultadoEncolhido520.eventos) && resultadoEncolhido520.cortado === false
    && resultadoEncolhido520.eventos.some((e) => e.texto === 'arquivo recomeçou pequeno'),
    'arquivo que ENCOLHEU (desde maior que o tamanho atual) relê do zero pela regra atual, sem devolver lixo');

  // `timestamp` que o Date.parse NÃO entende: o furo que devolveria o mtime mentiroso pela
  // porta dos fundos, se a leitura parasse na linha torta.
  const arquivoTimestampTorto520 = path.join(pastaFalsa, 'timestamp-torto-520.jsonl');
  const horaValidaTorto520 = '2026-08-24T08:00:00.000Z';
  const linhasTorto520 = [
    linha({ type: 'assistant', timestamp: horaValidaTorto520, message: { content: [{ type: 'text', text: 'fala-antiga-valida' }] } }),
  ];
  for (let i = 0; i < 5; i += 1) {
    linhasTorto520.push(linha({ type: 'assistant', timestamp: 'agora-mesmo', message: { content: [{ type: 'text', text: `fala-torta-${i}` }] } }));
  }
  fs.writeFileSync(arquivoTimestampTorto520, linhasTorto520.join(''));
  const resultadoTimestampTorto520 = await externoFalso.lerConversa(arquivoTimestampTorto520, 0, { alvoMensagens: 1 });
  tudoOk &= ok(resultadoTimestampTorto520.eventos.some((e) => e.texto === 'fala-antiga-valida'),
    'timestamp torto (Date.parse não entende) não para a leitura: ela continua para trás e traz a mensagem de timestamp válido');
  const horaUltimaTorto520 = await horaDaUltimaMensagem(arquivoTimestampTorto520);
  tudoOk &= ok(horaUltimaTorto520 === Date.parse(horaValidaTorto520),
    'e horaDaUltimaMensagem acha a mesma mensagem de timestamp válido, não o mtime');

  // alvoMensagens sanea: cinco casos na mesma fixture de §5.2, todos afirmando que a
  // leitura TERMINA e devolve algo coerente — nunca um laço que não para.
  console.log('  · alvoMensagens sanea: cinco casos, todos terminando com algo coerente');
  const casosSaneamento520 = [
    { rotulo: 'alvoMensagens: 0 sanea como o padrão ALVO_MENSAGENS', valor: 0, esperaCortado: false, exataMsgs: 40 },
    { rotulo: 'alvoMensagens: -5 sanea como o mínimo 1', valor: -5, esperaCortado: true, minMsgs: 1 },
    { rotulo: 'alvoMensagens: NaN sanea como o padrão ALVO_MENSAGENS', valor: NaN, esperaCortado: false, exataMsgs: 40 },
    { rotulo: "alvoMensagens: 'abc' sanea como o padrão ALVO_MENSAGENS", valor: 'abc', esperaCortado: false, exataMsgs: 40 },
    { rotulo: "alvoMensagens: '5' (string numérica) sanea como 5 — combinado explícito da spec §2.4", valor: '5', esperaCortado: true, minMsgs: 5 },
  ];
  for (const caso of casosSaneamento520) {
    const resultadoCaso520 = await externoFalso.lerConversa(arquivoFixture520, 0, { alvoMensagens: caso.valor });
    const contagemCaso520 = msgsDe(resultadoCaso520);
    const bateContagem520 = caso.exataMsgs !== undefined ? contagemCaso520 === caso.exataMsgs : contagemCaso520 >= caso.minMsgs;
    tudoOk &= ok(resultadoCaso520.cortado === caso.esperaCortado && bateContagem520,
      `${caso.rotulo} — leitura termina, devolve algo coerente (cortado=${resultadoCaso520.cortado}, msgs=${contagemCaso520})`);
  }


  // ── O contexto medido do texto que o relógio JÁ leu (24/08) ────────────────
  //
  // O topo do chat só era redesenhado no `sessao` e no `turno_fim`. Trocar de modelo com
  // `/model` no meio da conversa deixava o nome antigo na tela até o turno acabar — e o
  // effort herdaria o mesmo defeito no dia 1. O conserto NÃO é um relógio novo (D21/D-f): é
  // o relógio de arquivo que já existe passando a medir o pedaço que ele acabou de ler.
  //
  // O campo é OPT-IN por causa do R1: `horaDaUltimaMensagem` (lib/abas.js) chama esta mesma
  // função para TODAS as abas a cada 5 s, e medir ali cobraria `janelaLongaConfigurada()` —
  // I/O de config — de quem só queria um timestamp.
  console.log('\n  · o contexto medido dentro do lerConversa (opt-in)');

  const usoJsonl = (i, cr) => ({ input_tokens: i, cache_creation_input_tokens: 0, cache_read_input_tokens: cr, output_tokens: 1 });
  const arqCadencia = path.join(pastaFalsa, 'cadencia.jsonl');
  fs.writeFileSync(arqCadencia, linha({
    type: 'assistant', timestamp: '2026-08-24T10:00:00.000Z', effort: 'low',
    message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'primeiro' }], usage: usoJsonl(1, 999) },
  }));
  const inicialCadencia = await externoFalso.lerConversa(arqCadencia);

  // GUARDA — sem a opção, o retorno é EXATAMENTE o de hoje. É o R1: quem só queria a hora
  // não pode passar a pagar medição nenhuma, e nem sequer recebe o campo.
  tudoOk &= ok(Object.keys(inicialCadencia).sort().join(',') === 'bytesLidos,cortado,eventos,tamanho',
    `lerConversa mede só com a opção opt-in — sem ela o retorno tem as quatro chaves de hoje (${Object.keys(inicialCadencia).sort().join(',')})`);

  // GUARDA — e a fonte prova que o chamador de 5 em 5 segundos continua sem pedir.
  const fonteAbasContexto = fs.readFileSync(path.join(__dirname, '..', 'lib', 'abas.js'), 'utf8');
  const blocoHora = fonteAbasContexto.slice(fonteAbasContexto.indexOf('async function horaDaUltimaMensagem'));
  const chamadaHora = (blocoHora.match(/lerConversa\([^)]*\)/) || [''])[0];
  tudoOk &= ok(chamadaHora && !/contexto/.test(chamadaHora),
    `horaDaUltimaMensagem continua sem a opção de contexto (${chamadaHora})`);

  // MUDANÇA — o pedaço incremental com uma linha `assistant` NOVA, de modelo diferente, é
  // medido do texto que já foi lido. Nenhuma leitura extra de disco.
  fs.appendFileSync(arqCadencia, linha({
    type: 'assistant', timestamp: '2026-08-24T10:01:00.000Z', effort: 'max',
    message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'trocou de modelo' }], usage: usoJsonl(2, 50000) },
  }));
  const comCtx = await externoFalso.lerConversa(arqCadencia, inicialCadencia.tamanho, { contexto: { longa: false } });
  tudoOk &= ok(comCtx.contexto && comCtx.contexto.modelo === 'claude-opus-5'
    && comCtx.contexto.esforco === 'max' && comCtx.contexto.usados === 50002,
  `com a opção, o pedaço novo devolve o contexto medido dele (${comCtx.contexto && comCtx.contexto.modelo})`);
  // GUARDA — o campo é ADITIVO: os eventos do pedaço continuam saindo exatamente como antes.
  tudoOk &= ok(comCtx.eventos.length === 1 && comCtx.eventos[0].texto === 'trocou de modelo',
    'e os eventos do pedaço continuam saindo iguais — o campo é aditivo');

  // MUDANÇA — pedaço sem `usage` nenhum devolve `contexto: null`, e é isso que impede o
  // servidor de emitir evento e apagar o medidor no meio do turno (R2).
  fs.appendFileSync(arqCadencia, linha({
    type: 'user', timestamp: '2026-08-24T10:02:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'saiu' }] },
  }));
  const semUso = await externoFalso.lerConversa(arqCadencia, comCtx.tamanho, { contexto: { longa: false } });
  tudoOk &= ok(Object.hasOwn(semUso, 'contexto') && semUso.contexto === null,
    'pedaço sem usage devolve contexto null — e o servidor não emite nada');

  tudoOk &= ok(Date.now() - t0 < 30000, 'todo o bloco de lerConversa termina em menos de 30 s — gate contra laço infinito');

  console.log('\n  · histórico: as bordas do algoritmo — imagem como fala, UTF-8 partido, '
    + 'linha gigante, cauda inteira é imagem, I/O');
  // alvoMensagens sanea (Fase 0) continua valendo com as bordas novas desta fase.

  // Caso 0 — imagem como FALA DO HUMANO conta exatamente 1: um bloco `image` dentro do
  // `content` de uma fala do usuário (não dentro de `tool_result`). Some 1 no alvo, e o
  // base64 não vai no payload — só o texto sai.
  const arquivoBorda0 = path.join(pastaFalsa, 'borda0-imagem-fala.jsonl');
  fs.writeFileSync(arquivoBorda0, linha({
    type: 'user', timestamp: '2026-08-24T10:00:00.000Z',
    message: {
      content: [
        { type: 'text', text: 'olha essa print' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(400 * 1024) } },
      ],
    },
  }));
  const resultadoBorda0 = await externoFalso.lerConversa(arquivoBorda0);
  tudoOk &= ok(resultadoBorda0.eventos.length === 1 && resultadoBorda0.eventos[0].tipo === 'humano',
    `imagem como fala do humano vira exatamente 1 evento humano (${resultadoBorda0.eventos.length})`);
  tudoOk &= ok(msgsDe(resultadoBorda0) === 1, 'e soma exatamente 1 no alvo — nem 0, nem a janela inteira');
  tudoOk &= ok(resultadoBorda0.eventos[0].texto === 'olha essa print', 'o texto sai...');
  tudoOk &= ok(JSON.stringify(resultadoBorda0.eventos).length < 10000, '...e a imagem em base64 NÃO vai no payload');

  // Caso 1 — UTF-8 PARTIDO numa fronteira de bloco: um caractere multibyte ('ç', 2 bytes)
  // posicionado de propósito para que o corte de 64 KB caia NO MEIO dele. A emenda em
  // Buffer (§2.2) tem que devolver o caractere idêntico, sem U+FFFD.
  let quandoUtf8 = Date.parse('2026-08-20T10:00:00.000Z');
  const proximoUtf8 = () => new Date(quandoUtf8 += 1000).toISOString();
  const CHAR_UTF8 = 'ç';
  function construirBorda1Utf8(k) {
    const linhasAntesUtf8 = [];
    for (let i = 1; i <= 5; i += 1) {
      linhasAntesUtf8.push(linha({ type: 'assistant', timestamp: proximoUtf8(), message: { content: [{ type: 'text', text: `linha-antes-${i}` }] } }));
    }
    const linhaEspecialUtf8 = linha({
      type: 'assistant', timestamp: proximoUtf8(),
      message: { content: [{ type: 'text', text: `antes-do-acento-${CHAR_UTF8}-depois-do-acento` }] },
    });
    const linhasDepoisUtf8 = [];
    for (let i = 1; i <= 5; i += 1) {
      const textoDepois = `linha-depois-${i}` + (i === 1 ? '.'.repeat(k) : '');
      linhasDepoisUtf8.push(linha({ type: 'assistant', timestamp: proximoUtf8(), message: { content: [{ type: 'text', text: textoDepois }] } }));
    }
    return linhasAntesUtf8.join('') + linhaEspecialUtf8 + linhasDepoisUtf8.join('');
  }
  const baseBorda1Utf8 = construirBorda1Utf8(0);
  const idxCharUtf8 = baseBorda1Utf8.indexOf(CHAR_UTF8);
  const posByteCharUtf8 = Buffer.byteLength(baseBorda1Utf8.slice(0, idxCharUtf8), 'utf8');
  const totalBaseBorda1Utf8 = Buffer.byteLength(baseBorda1Utf8, 'utf8');
  const restanteUtf8 = (totalBaseBorda1Utf8 - posByteCharUtf8) % 65536;
  const kBorda1Utf8 = restanteUtf8 === 0 ? 0 : 65536 - restanteUtf8;
  const arquivoBorda1Utf8 = path.join(pastaFalsa, 'borda1-utf8.jsonl');
  fs.writeFileSync(arquivoBorda1Utf8, construirBorda1Utf8(kBorda1Utf8));
  const tamanhoBorda1Utf8 = fs.statSync(arquivoBorda1Utf8).size;
  tudoOk &= ok((tamanhoBorda1Utf8 - posByteCharUtf8) % 65536 === 0,
    'o caractere multibyte cai EXATAMENTE na fronteira de um bloco de 64 KB, no arquivo de verdade');
  const resultadoBorda1Utf8 = await externoFalso.lerConversa(arquivoBorda1Utf8);
  const eventoBorda1Utf8 = resultadoBorda1Utf8.eventos.find((e) => e.texto && e.texto.includes('depois-do-acento'));
  tudoOk &= ok(Boolean(eventoBorda1Utf8) && eventoBorda1Utf8.texto === `antes-do-acento-${CHAR_UTF8}-depois-do-acento`,
    'UTF-8 partido numa fronteira de bloco chega IDÊNTICO — sem U+FFFD (emenda em Buffer, não em string)');

  // Caso 2 — última linha INCOMPLETA atravessando blocos (escrita em curso, > 64 KB): não
  // vira evento, e `tamanho` aponta para ANTES dela (armadilha #11).
  let quandoBorda2 = Date.parse('2026-08-20T09:00:00.000Z');
  const proximoBorda2 = () => new Date(quandoBorda2 += 1000).toISOString();
  const linhasCompletasBorda2 = [];
  for (let i = 1; i <= 5; i += 1) {
    linhasCompletasBorda2.push(linha({ type: 'assistant', timestamp: proximoBorda2(), message: { content: [{ type: 'text', text: `completa-${i}` }] } }));
  }
  const conteudoCompletoBorda2 = linhasCompletasBorda2.join('');
  const linhaIncompletaBorda2 = JSON.stringify({
    type: 'assistant', timestamp: proximoBorda2(), message: { content: [{ type: 'text', text: 'y'.repeat(150 * 1024) }] },
  }); // SEM '\n' no final: é a linha em escrita, atravessando vários blocos de 64 KB.
  const arquivoBorda2 = path.join(pastaFalsa, 'borda2-incompleta.jsonl');
  fs.writeFileSync(arquivoBorda2, conteudoCompletoBorda2 + linhaIncompletaBorda2);
  const tamanhoAntesIncompletaBorda2 = Buffer.byteLength(conteudoCompletoBorda2, 'utf8');
  const resultadoBorda2 = await externoFalso.lerConversa(arquivoBorda2);
  tudoOk &= ok(resultadoBorda2.eventos.length === 5,
    `a última linha incompleta (>64 KB, sem '\\n') não vira evento (${resultadoBorda2.eventos.length} de 5 completas)`);
  tudoOk &= ok(resultadoBorda2.tamanho === tamanhoAntesIncompletaBorda2,
    'e o tamanho aponta para ANTES dela, para ela chegar inteira na próxima leitura');

  // Caso 3 — LINHA GIGANTE maior que TETO_DURO: eventos.length===0, cortado===true,
  // bytesLidos<=TETO_DURO. É também o gate de I/O da linha gigante de §5.4(a).
  const arquivoBorda3 = path.join(pastaFalsa, 'borda3-linha-gigante.jsonl');
  fs.writeFileSync(arquivoBorda3, linha({
    type: 'assistant', timestamp: '2026-08-24T10:00:00.000Z',
    message: { content: [{ type: 'text', text: 'z'.repeat(4200 * 1024) }] },
  }));
  const resultadoBorda3 = await externoFalso.lerConversa(arquivoBorda3);
  tudoOk &= ok(resultadoBorda3.eventos.length === 0 && resultadoBorda3.cortado === true
    && resultadoBorda3.bytesLidos <= externoFalso.TETO_DURO,
    `I/O da linha gigante (>TETO_DURO): eventos=0, cortado=true, bytesLidos<=TETO_DURO (bytesLidos=${resultadoBorda3.bytesLidos})`);

  // Caso 4 — teto atingido SEM NENHUMA quebra de linha (nem um '\n' no arquivo inteiro):
  // `sobra` nunca é determinada, cai no combinado de §6: tamanho === info.size.
  const arquivoBorda4 = path.join(pastaFalsa, 'borda4-sem-quebra.jsonl');
  fs.writeFileSync(arquivoBorda4, 'w'.repeat(4200 * 1024));
  const tamanhoBorda4 = fs.statSync(arquivoBorda4).size;
  const resultadoBorda4 = await externoFalso.lerConversa(arquivoBorda4);
  tudoOk &= ok(resultadoBorda4.eventos.length === 0 && resultadoBorda4.cortado === true
    && resultadoBorda4.tamanho === tamanhoBorda4,
    `teto atingido sem nenhuma quebra de linha: zero eventos, cortado=true, tamanho===info.size (${resultadoBorda4.tamanho})`);

  // Fixture CAUDA INTEIRA É IMAGEM: muita conversa antiga (com quando), uma fala válida, e
  // no FIM uma linha `tool_result` de 400 KB (sem quando) — a forma real medida em aba-10.
  // horaDaUltimaMensagem tem que continuar para trás e achar a fala, não cair no mtime.
  let quandoCaudaImg = Date.parse('2026-08-15T08:00:00.000Z');
  const proximoCaudaImg = () => new Date(quandoCaudaImg += 1000).toISOString();
  const linhasPaddingCaudaImg = [];
  for (let i = 1; i <= 5000; i += 1) {
    linhasPaddingCaudaImg.push(linha({ type: 'assistant', timestamp: proximoCaudaImg(), message: { content: [{ type: 'text', text: `padding-${i}` }] } }));
  }
  const horaFalaCaudaImg = proximoCaudaImg();
  const linhaFalaCaudaImg = linha({ type: 'assistant', timestamp: horaFalaCaudaImg, message: { content: [{ type: 'text', text: 'fala-antiga-da-cauda-imagem' }] } });
  const linhaImagemCaudaImg = linha({
    type: 'user', timestamp: proximoCaudaImg(),
    message: { content: [{ type: 'tool_result', tool_use_id: 't-cauda-imagem', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'B'.repeat(400 * 1024) } }] }] },
  });
  const arquivoCaudaImg = path.join(pastaFalsa, 'cauda-inteira-e-imagem.jsonl');
  fs.writeFileSync(arquivoCaudaImg, linhasPaddingCaudaImg.join('') + linhaFalaCaudaImg + linhaImagemCaudaImg);
  const tamanhoCaudaImg = fs.statSync(arquivoCaudaImg).size;

  const horaCaudaImg = await horaDaUltimaMensagem(arquivoCaudaImg);
  tudoOk &= ok(horaCaudaImg === Date.parse(horaFalaCaudaImg),
    'cauda inteira é imagem: horaDaUltimaMensagem acha a fala de trás, não o mtime');

  // I/O da hora — caso RUIM (§5.4a): a mesma fixture de cauda-inteira-é-imagem, lida como
  // horaDaUltimaMensagem lê (alvoMensagens: 1). Atravessa a imagem, mas não lê o arquivo todo.
  const resultadoCaudaImgIO = await externoFalso.lerConversa(arquivoCaudaImg, 0, { alvoMensagens: 1 });
  tudoOk &= ok(resultadoCaudaImgIO.bytesLidos <= 8 * externoFalso.BLOCO && resultadoCaudaImgIO.bytesLidos < tamanhoCaudaImg,
    `I/O da hora, caso ruim (cauda-imagem): bytesLidos<=8*BLOCO e <info.size (bytesLidos=${resultadoCaudaImgIO.bytesLidos}, size=${tamanhoCaudaImg})`);

  // Gate de I/O de §5.4(a) — fixture de receita fechada: linhas `carga-NNNNN` + 180 'x',
  // geradas até passar de 6 MB, com UMA linha de imagem de 400 KB na metade.
  let quandoSeis = Date.parse('2026-08-01T00:00:00.000Z');
  const proximoSeis = () => new Date(quandoSeis += 1000).toISOString();
  const linhaCargaSeis = (i) => linha({
    type: 'assistant', timestamp: proximoSeis(),
    message: { content: [{ type: 'text', text: `carga-${String(i).padStart(5, '0')} ${'x'.repeat(180)}` }] },
  });
  const passoCargaSeis = Buffer.byteLength(linhaCargaSeis(0), 'utf8');
  const totalLinhasSeis = Math.ceil((6 * 1024 * 1024) / passoCargaSeis);
  const meioSeis = Math.floor(totalLinhasSeis / 2);
  let conteudoSeis = '';
  for (let i = 0; i < totalLinhasSeis; i += 1) {
    if (i === meioSeis) {
      conteudoSeis += linha({
        type: 'user', timestamp: proximoSeis(),
        message: { content: [{ type: 'tool_result', tool_use_id: 't-meio-seis', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'C'.repeat(400 * 1024) } }] }] },
      });
    }
    conteudoSeis += linhaCargaSeis(i);
  }
  const arquivoSeis = path.join(pastaFalsa, 'seis-mb.jsonl');
  fs.writeFileSync(arquivoSeis, conteudoSeis);

  const resultadoInicialSeis = await externoFalso.lerConversa(arquivoSeis, 0);
  tudoOk &= ok(resultadoInicialSeis.bytesLidos <= externoFalso.TETO_DURO,
    `I/O da leitura inicial (fixture de 6 MB): bytesLidos<=TETO_DURO (bytesLidos=${resultadoInicialSeis.bytesLidos})`);
  tudoOk &= ok(JSON.stringify(resultadoInicialSeis.eventos).length < 2 * 1024 * 1024,
    `payload produzido (JSON.stringify dos eventos) fica abaixo de 2 MB (${JSON.stringify(resultadoInicialSeis.eventos).length} bytes)`);

  const tamanhoAntesAppendSeis = fs.statSync(arquivoSeis).size;
  fs.appendFileSync(arquivoSeis, linhaCargaSeis(totalLinhasSeis));
  const resultadoIncrementalSeis = await externoFalso.lerConversa(arquivoSeis, tamanhoAntesAppendSeis);
  tudoOk &= ok(resultadoIncrementalSeis.bytesLidos < 4 * 1024,
    `I/O do incremental (1 linha nova): bytesLidos < 4 KB (bytesLidos=${resultadoIncrementalSeis.bytesLidos})`);

  const resultadoCasoComumSeis = await externoFalso.lerConversa(arquivoSeis, 0, { alvoMensagens: 1 });
  tudoOk &= ok(resultadoCasoComumSeis.bytesLidos <= externoFalso.BLOCO,
    `I/O da hora, caso comum (mensagem no último bloco): bytesLidos<=BLOCO (bytesLidos=${resultadoCasoComumSeis.bytesLidos})`);

  process.env.HOME = homeReal;
  delete require.cache[require.resolve('../lib/externo')];
  fs.rmSync(dirFora, { recursive: true, force: true });

  // Catálogo do "/": HOME de fixture, porque o módulo lê de ~/.claude e a máquina de quem
  // roda não pode ser parte do teste. Com o HOME de verdade o gate passava aqui por sorte
  // (as skills do dono estavam instaladas) e num CI limpo, onde não há nenhuma, quebrava.
  // A fixture reproduz as três origens que o catálogo sabe distinguir — comando global,
  // skill global e skill de plugin — para as asserções de origem e de ordem continuarem
  // provando o mesmo de antes.
  const dirCat = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-catalogo-'));
  const homeCat = path.join(dirCat, 'home');
  const claudeCat = path.join(homeCat, '.claude');
  fs.mkdirSync(path.join(claudeCat, 'commands'), { recursive: true });
  // `status` também é embutido: é ele que faz a asserção de duplicata valer alguma coisa.
  fs.writeFileSync(path.join(claudeCat, 'commands', 'status.md'),
    '---\ndescription: Comando de arquivo que sombreia o embutido de mesmo nome.\n---\n');
  fs.writeFileSync(path.join(claudeCat, 'commands', 'anota.md'),
    '---\ndescription: Comando global de fixture, com descrição no frontmatter.\n---\n');
  fs.mkdirSync(path.join(claudeCat, 'skills', 'audita'), { recursive: true });
  fs.writeFileSync(path.join(claudeCat, 'skills', 'audita', 'SKILL.md'),
    '---\ndescription: Skill global de fixture, com descrição no frontmatter.\n---\n');
  const skillPlugin = path.join(claudeCat, 'plugins', 'cache',
    'mercado-fixture', 'plugin-fixture', '1.0.0', 'skills', 'revisa');
  fs.mkdirSync(skillPlugin, { recursive: true });
  fs.writeFileSync(path.join(skillPlugin, 'SKILL.md'),
    '---\ndescription: Skill de plugin de fixture, com descrição no frontmatter.\n---\n');
  process.env.HOME = homeCat;

  // Sem `declarados` (o caso das ABAS do terminal, onde o cockpit nunca rodou o init do
  // stream-json) os embutidos precisam entrar assim mesmo — senão o /clear, que é o comando
  // mais usado do celular, simplesmente não aparece no autocomplete.
  delete require.cache[require.resolve('../lib/catalogo')];
  const catalogoLib = require('../lib/catalogo');
  const semDeclarados = await catalogoLib.listar();
  const nomesCat = semDeclarados.map((i) => i.nome);
  tudoOk &= ok(nomesCat.includes('clear') && nomesCat.includes('compact'),
    'sem `declarados`, o catálogo é o disco MAIS os embutidos');
  tudoOk &= ok(semDeclarados.some((i) => i.origem === 'embutido'),
    'e eles vêm marcados como `embutido`, para a tela poder diferenciar');
  tudoOk &= ok(semDeclarados.find((i) => i.nome === 'clear').descricao.length > 10,
    'com descrição, não só o nome');
  tudoOk &= ok(semDeclarados.some((i) => i.origem === 'global'),
    'e as skills de arquivo continuam todas lá');
  tudoOk &= ok(new Set(nomesCat).size === nomesCat.length,
    'nenhum nome duplicado: embutido não repete o que já veio do disco');
  const PESOS = { projeto: 0, global: 1, plugin: 2, embutido: 3 };
  const ordem = semDeclarados.map((i) => PESOS[i.origem]);
  tudoOk &= ok(ordem.every((p, i) => i === 0 || ordem[i - 1] <= p),
    'e a ordenação por peso é a mesma de sempre');

  // Com `declarados` nada muda: quem manda continua sendo o CLI.
  const comDeclarados = await catalogoLib.listar(undefined, ['clear', 'nao-existe-no-disco']);
  tudoOk &= ok(comDeclarados.length === 2,
    `com \`declarados\`, só o que o CLI declarou sai (${comDeclarados.length})`);
  tudoOk &= ok(comDeclarados.every((i) => i.origem === 'embutido'),
    'e nome que o disco não conhece vira embutido, como antes');

  process.env.HOME = homeReal;
  delete require.cache[require.resolve('../lib/catalogo')];
  fs.rmSync(dirCat, { recursive: true, force: true });

  // Abas do terminal: o texto que vai para dentro da TUI por `send-keys`.
  const abas = require('../lib/abas');
  const ESC = String.fromCharCode(27);
  const sujo = `oi${ESC}[31mvermelho${String.fromCharCode(0)}\nsegunda linha\rcom CR`;
  const limpo = abas.limpar(sujo);
  tudoOk &= ok(!limpo.includes(ESC) && !limpo.includes(String.fromCharCode(0)),
    'ESC e NUL não passam: dentro da TUI viram sequência de controle, não texto');
  tudoOk &= ok(!limpo.includes('\r'), 'CR também não: é ele que submete a mensagem antes da hora');
  tudoOk &= ok(limpo.includes('\n'),
    'mas o \\n fica — é o que deixa mandar mensagem de várias linhas de uma vez');
  tudoOk &= ok(limpo.includes('vermelho') && limpo.includes('segunda linha'),
    'e o texto de verdade chega inteiro');

  // Pid reciclado: o arquivo de sessão do CLI sobrevive ao processo que o escreveu, e o
  // servidor fica meses de pé. Sem conferir o instante de partida, o cockpit acharia que um
  // programa qualquer que herdou o pid é o claude daquela aba.
  tudoOk &= ok(await abas.mesmoProcesso(process.pid, 'nao-e-o-numero-certo') === false,
    'pid vivo com procStart diferente não conta como o mesmo processo');
  const meuStat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const meuInicio = meuStat.slice(meuStat.lastIndexOf(')') + 2).split(' ')[19];
  tudoOk &= ok(await abas.mesmoProcesso(process.pid, meuInicio) === true,
    'e com o procStart certo, conta');
  tudoOk &= ok(await abas.mesmoProcesso(0, '1') === false, 'pid que não existe não explode');

  // Anexo do celular: o nome vem do navegador, então é ele que precisa apanhar antes de
  // virar caminho no disco.
  const homeAnexo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-anexo-'));
  const homeDeVerdade = process.env.HOME;
  process.env.HOME = homeAnexo;
  delete require.cache[require.resolve('../lib/abas')];
  const abasFalso = require('../lib/abas');

  const anexoLavado = await abasFalso.guardarAnexo({
    nome: '../../../../etc/passwd', extensao: '.png', dados: Buffer.from('x'),
  });
  tudoOk &= ok(path.dirname(anexoLavado.arquivo) === path.join(homeAnexo, '.cockpit', 'anexos'),
    'nome com ../ não escapa da pasta de anexos');
  tudoOk &= ok(!anexoLavado.nome.includes('/'), `e vira um nome inofensivo (${anexoLavado.nome})`);
  tudoOk &= ok(fs.existsSync(anexoLavado.arquivo), 'o arquivo chega ao disco');

  const comEspaco = await abasFalso.guardarAnexo({
    nome: 'print do celular.png', extensao: '.png', dados: Buffer.from('x'),
  });
  tudoOk &= ok(comEspaco.nome.endsWith('.png') && !comEspaco.nome.includes(' '),
    `nome com espaço vira nome de arquivo (${comEspaco.nome})`);
  tudoOk &= ok(!/\.png\.png$/.test(comEspaco.nome), 'e a extensão não é duplicada');

  // Anexo é de passagem: sem validade, a pasta cresce para sempre.
  const velho = path.join(homeAnexo, '.cockpit', 'anexos', 'antigo.png');
  fs.writeFileSync(velho, 'x');
  const oitoDias = Date.now() - 8 * 24 * 3600e3;
  fs.utimesSync(velho, oitoDias / 1000, oitoDias / 1000);
  await abasFalso.guardarAnexo({ nome: 'novo.png', extensao: '.png', dados: Buffer.from('x') });
  tudoOk &= ok(!fs.existsSync(velho), 'anexo de mais de 7 dias é apagado no próximo upload');
  tudoOk &= ok(fs.existsSync(anexoLavado.arquivo), 'e o recente continua lá');

  process.env.HOME = homeDeVerdade;
  delete require.cache[require.resolve('../lib/abas')];
  fs.rmSync(homeAnexo, { recursive: true, force: true });

  // Notificação: a criptografia é conferida contra o vetor oficial do RFC 8291 §5.
  // Sem isso, "implementei web push" seria fé — o erro só apareceria como um 400 mudo
  // vindo do Google, meses depois.
  const push = require('../lib/push');
  const corpoRfc = push.cifrar({
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    texto: 'When I grow up, I want to be a watermelon',
    efemera: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  }).toString('base64url');
  tudoOk &= ok(corpoRfc === 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    'a cifragem bate byte a byte com o vetor de teste do RFC 8291');

  const vapid = push.gerarVapid();
  const chaveCrua = Buffer.from(vapid.publica, 'base64url');
  tudoOk &= ok(chaveCrua.length === 65 && chaveCrua[0] === 4,
    'a chave VAPID sai em 65 bytes não comprimidos, que é o que o navegador aceita');
  const jwt = push.jwtVapid({ audiencia: 'https://fcm.googleapis.com', contato: 'mailto:x@y', privada: vapid.privada });
  const [cab, dados, assinatura] = jwt.split('.');
  tudoOk &= ok(JSON.parse(Buffer.from(cab, 'base64url')).alg === 'ES256', 'o JWT do VAPID é ES256');
  tudoOk &= ok(JSON.parse(Buffer.from(dados, 'base64url')).aud === 'https://fcm.googleapis.com',
    'com a audiência do servidor de push');
  tudoOk &= ok(Buffer.from(assinatura, 'base64url').length === 64,
    'e assinatura de 64 bytes: r||s cru, não DER — com DER o push server responde 401 mudo');
  const pub = require('node:crypto').createPublicKey(push.chavePrivadaDe(vapid.privada));
  tudoOk &= ok(require('node:crypto').verify('sha256', Buffer.from(`${cab}.${dados}`),
    { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(assinatura, 'base64url')),
    'a assinatura confere com a chave pública anunciada');

  // Lógica de inscrições, num diretório descartável.
  const dirPush = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-push-'));
  process.env.COCKPIT_PUSH_DIR = dirPush;
  // `COCKPIT_CONTATO` virou OBRIGATÓRIO na preparação do open source (09/09): o default era
  // `mailto:cockpit@interno.local`, um domínio interno que iria junto para o repo público e
  // acabaria no cabeçalho VAPID de quem clonasse. Sem a var, `avisos.avisar` agora estoura —
  // este contato de mentira é o mesmo que o `gate-instalacao` já usa.
  const contatoAntes = process.env.COCKPIT_CONTATO;
  process.env.COCKPIT_CONTATO = 'mailto:teste@example.com';
  delete require.cache[require.resolve('../lib/avisos')];
  const avisos = require('../lib/avisos');

  tudoOk &= ok((await avisos.avisar({ titulo: 'x', corpo: 'y' })).enviados === 0,
    'sem ninguém inscrito, avisar não faz nada');
  let recusou = false;
  try { await avisos.inscrever({ endpoint: 'https://x/y' }); } catch { recusou = true; }
  tudoOk &= ok(recusou, 'inscrição sem as chaves do aparelho é recusada');

  const falsa = (endpoint) => ({ endpoint, keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } });
  await avisos.inscrever(falsa('https://fcm.googleapis.com/aparelho-1'));
  await avisos.inscrever(falsa('https://fcm.googleapis.com/aparelho-1'));
  tudoOk &= ok((await avisos.inscricoes()).length === 1,
    'reinscrever o mesmo aparelho atualiza em vez de duplicar');

  // Troca o envio de verdade por um dublê: o formato já foi provado acima.
  const mandados = [];
  const enviarDeVerdade = push.enviar;
  push.enviar = async ({ texto }) => { mandados.push(JSON.parse(texto)); return { status: 201 }; };
  await avisos.inscrever(falsa('https://updates.push.services.mozilla.com/aparelho-2'));
  const r = await avisos.avisar({ titulo: 'projeto x', corpo: 'terminei', sessaoId: 'abc' });
  tudoOk &= ok(r.enviados === 2, `avisa todos os aparelhos inscritos (${r.enviados})`);
  tudoOk &= ok(mandados[0].sessaoId === 'abc' && mandados[0].tag === 'abc',
    'o aviso leva o id da conversa, para o clique abrir ela e não empilhar avisos');

  // 410 = inscrição morta. Tem que sumir da lista, senão ela só cresce.
  push.enviar = async ({ inscricao }) => ({ status: inscricao.endpoint.includes('aparelho-1') ? 410 : 201 });
  const limpeza = await avisos.avisar({ titulo: 'x', corpo: 'y' });
  tudoOk &= ok(limpeza.removidos === 1, 'aparelho que respondeu 410 é removido');
  tudoOk &= ok((await avisos.inscricoes()).length === 1, 'e some da lista de verdade');
  push.enviar = enviarDeVerdade;

  // "O cockpit conhece a inscrição deste aparelho?" — a pergunta que faltava no
  // diagnóstico. Permissão concedida e sw ativo não distinguem quem se inscreveu de quem
  // assinou no navegador e nunca conseguiu registrar aqui.
  const vivas = await avisos.inscricoes();
  tudoOk &= ok((await avisos.conhece(vivas[0].endpoint)).conhecida === true,
    'o cockpit sabe dizer que conhece uma inscrição');
  const desconhecida = await avisos.conhece('https://fcm.googleapis.com/aparelho-que-nunca-registrou');
  tudoOk &= ok(desconhecida.conhecida === false && desconhecida.inscritos === vivas.length,
    'e que NÃO conhece outra, dizendo quantos estão na lista');

  fs.rmSync(dirPush, { recursive: true, force: true });
  delete process.env.COCKPIT_PUSH_DIR;
  // Devolve o ambiente como estava: quem rodar o gate com um COCKPIT_CONTATO de verdade
  // exportado não pode terminar com o de mentira no lugar.
  if (contatoAntes === undefined) delete process.env.COCKPIT_CONTATO;
  else process.env.COCKPIT_CONTATO = contatoAntes;

  // ── Cada passo do push tem NOME na mensagem de falha ─────────────────────────
  // O erro que o usuário vê no celular é "TypeError: Failed to fetch" — o erro do `fetch()`.
  // O fluxo tem DUAS chamadas de rede (a chave e a inscrição) com um `subscribe()` no
  // meio, e com um `catch` único a tela não dizia qual delas quebrou. Sem isso, consertar
  // é chutar; já se chutou demais neste recurso.
  const avisosCliente = carregarCliente();
  let comPasso = null;
  try {
    await avisosCliente.passoDeAviso('pegar a chave VAPID no cockpit', async () => {
      throw new TypeError('Failed to fetch');
    });
  } catch (erro) { comPasso = erro; }
  tudoOk &= ok(comPasso !== null && comPasso.passo === 'pegar a chave VAPID no cockpit',
    'o erro carrega o NOME do passo que falhou');
  tudoOk &= ok(comPasso && comPasso.tipo === 'TypeError' && comPasso.mensagem === 'Failed to fetch',
    'e o tipo e a mensagem do erro original, separados');
  await avisosCliente.mostrarFalhaDeAviso(comPasso);
  const painelFalha = textoDe(porIdDe(avisosCliente, 'lista-diagnostico'));
  tudoOk &= ok(/pegar a chave VAPID no cockpit/.test(painelFalha),
    'e o painel que fica na tela diz em qual passo foi');
  tudoOk &= ok(/TypeError/.test(painelFalha) && /Failed to fetch/.test(painelFalha),
    'junto do tipo e da mensagem, sem perder nada do erro de origem');

  // Erro sem passo (permissão negada, por exemplo) continua legível: não virou refém do
  // formato novo.
  await avisosCliente.mostrarFalhaDeAviso(new Error('o navegador respondeu "denied"'));
  tudoOk &= ok(/denied/.test(textoDe(porIdDe(avisosCliente, 'lista-diagnostico'))),
    'e erro sem passo continua aparecendo como antes');

  // Os quatro passos existem, e cada um tem nome próprio na fonte.
  const fonteAvisos = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const nomesDePasso = [...fonteAvisos.matchAll(/passoDeAviso\(tr\('([^']+)'/g)].map((m) => m[1]);
  tudoOk &= ok(nomesDePasso.length === 4, `o fluxo de ligar avisos tem quatro passos nomeados (${nomesDePasso.length})`);
  tudoOk &= ok(new Set(nomesDePasso).size === 4,
    `e nenhum nome se repete — senão dois passos dariam a mesma mensagem (${nomesDePasso.join(' · ')})`);
  tudoOk &= ok(nomesDePasso.filter((n) => /cockpit/.test(n)).length === 2,
    'as DUAS chamadas de rede são distinguíveis: é entre elas que "Failed to fetch" escolhe');

  // O diagnóstico ganhou a inscrição do aparelho — e só o HOST dela. O endpoint inteiro é
  // credencial: nunca vai para tela, log ou área de transferência.
  tudoOk &= ok(/\.host\b/.test(fonteAvisos.slice(fonteAvisos.indexOf('inscrição neste aparelho') - 400,
    fonteAvisos.indexOf('inscrição neste aparelho') + 200)),
  'o diagnóstico mostra só o host do endpoint, nunca o token inteiro');
  tudoOk &= ok(/o cockpit conhece esta inscrição/.test(fonteAvisos),
    'e diz se o cockpit conhece essa inscrição');

  const swTexto = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  tudoOk &= ok(/addEventListener\('push'/.test(swTexto), 'o service worker escuta push');
  tudoOk &= ok(/addEventListener\('notificationclick'/.test(swTexto), 'e trata o clique na notificação');
  tudoOk &= ok(/showNotification/.test(swTexto), 'e mostra a notificação de verdade');

  // Histórico da caixa, como o do terminal.
  const term = carregarCliente();
  const campo = { value: '', selectionStart: 0, selectionEnd: 0, style: {}, scrollHeight: 40,
    setSelectionRange(a, b) { campo.selectionStart = a; campo.selectionEnd = b; } };
  ['limpar o repo', 'rodar os testes', 'subir o serviço'].forEach((t) => term.lembrar(term.painelAtual(), t));

  tudoOk &= ok(term.navegarHistorico(term.painelAtual(), -1, campo) && campo.value === 'subir o serviço',
    'seta para cima traz a última mensagem');
  term.navegarHistorico(term.painelAtual(), -1, campo);
  tudoOk &= ok(campo.value === 'rodar os testes', 'de novo traz a anterior');
  term.navegarHistorico(term.painelAtual(), -1, campo);
  term.navegarHistorico(term.painelAtual(), -1, campo);
  tudoOk &= ok(campo.value === 'limpar o repo', 'no mais antigo, para de andar em vez de esvaziar');
  term.navegarHistorico(term.painelAtual(), 1, campo);
  tudoOk &= ok(campo.value === 'rodar os testes', 'seta para baixo volta para frente');

  // O rascunho não pode ser perdido: é o erro clássico desse recurso.
  const term2 = carregarCliente();
  const campo2 = { value: 'estava escrevendo isto', selectionStart: 0, selectionEnd: 0, style: {}, scrollHeight: 40,
    setSelectionRange() {} };
  term2.lembrar(term2.painelAtual(), 'mensagem antiga');
  term2.navegarHistorico(term2.painelAtual(), -1, campo2);
  tudoOk &= ok(campo2.value === 'mensagem antiga', 'entra no histórico');
  term2.navegarHistorico(term2.painelAtual(), 1, campo2);
  tudoOk &= ok(campo2.value === 'estava escrevendo isto', 'e devolve o rascunho ao voltar para o presente');

  const vazio = carregarCliente();
  const campo3 = { value: 'x', selectionStart: 0, selectionEnd: 0, style: {}, setSelectionRange() {} };
  tudoOk &= ok(vazio.navegarHistorico(vazio.painelAtual(), -1, campo3) === false,
    'sem histórico, a tecla segue sendo tecla e o cursor se move normal');
  const dup = carregarCliente();
  const campo4 = { value: '', selectionStart: 0, selectionEnd: 0, style: {}, scrollHeight: 40,
    setSelectionRange() {} };
  ['primeira', 'repetida', 'repetida'].forEach((t) => dup.lembrar(dup.painelAtual(), t));
  dup.navegarHistorico(dup.painelAtual(), -1, campo4);
  dup.navegarHistorico(dup.painelAtual(), -1, campo4);
  tudoOk &= ok(campo4.value === 'primeira',
    'repetir a mesma mensagem seguida não duplica: dois passos chegam na anterior');

  // O cabeçalho de anexo é para o agente, não para a tela.
  const comAnexo = term.separarAnexos(
    '[anexo] /home/y/.cockpit/sessoes/x/anexos/2026-print.png\n\n'
    + 'Os arquivos acima foram enviados pelo usuário junto desta mensagem. Abra o que precisar.\n\n'
    + 'o que tem nessa tela?',
  );
  tudoOk &= ok(comAnexo.texto === 'o que tem nessa tela?',
    'a bolha mostra só o que o usuário escreveu, sem os caminhos');
  tudoOk &= ok(comAnexo.anexos.length === 1 && comAnexo.anexos[0] === '2026-print.png',
    'e o nome do anexo sai separado, para virar o clipe na bolha');
  tudoOk &= ok(term.separarAnexos('mensagem normal').texto === 'mensagem normal',
    'mensagem sem anexo passa intacta');

  // Token: chega pela URL, fica guardado e SOME da barra de endereço.
  const guardado = memoria();
  const comUrl = carregarCliente({ urlInicial: 'http://z/?token=abc123', guardado });
  tudoOk &= ok(guardado.getItem('cockpit-token') === 'abc123', 'o token da URL é guardado no aparelho');
  tudoOk &= ok(!comUrl.location.href.includes('abc123'),
    'e sai da barra de endereço — token em histórico de navegador é token vazado');
  tudoOk &= ok(comUrl.comToken('api/x') === 'api/x?token=abc123', 'o SSE leva o token na query');
  tudoOk &= ok(comUrl.comToken('api/x?a=1') === 'api/x?a=1&token=abc123', 'sem quebrar query que já existe');

  const semToken = carregarCliente({ urlInicial: 'http://z/', guardado: memoria() });
  tudoOk &= ok(semToken.comToken('api/x') === 'api/x', 'sem token, a rota vai limpa');

  // O link que o usuário manda para o celular: montado do endereço real, nada chumbado.
  tudoOk &= ok(comUrl.linkDeAcesso() === 'http://z/?token=abc123',
    'o link de acesso carrega o token para o outro aparelho');
  tudoOk &= ok(semToken.linkDeAcesso() === 'http://z/', 'sem token, o link vai sem query');
  const sobPath = carregarCliente({ urlInicial: 'https://exemplo.com:7879/cockpit/?token=xyz', guardado: memoria() });
  tudoOk &= ok(sobPath.linkDeAcesso() === 'https://exemplo.com:7879/cockpit/?token=xyz',
    'e continua certo se o cockpit mudar de porta ou viver sob um path');

  // App instalável: o navegador tem uma lista de exigências e ela não é negociável.
  const manifesto = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  const icones = manifesto.icons || [];
  tudoOk &= ok(icones.some((i) => i.type === 'image/png' && i.sizes === '192x192'),
    'manifest tem PNG de 192 (o Chrome recusa instalar sem ele)');
  tudoOk &= ok(icones.some((i) => i.type === 'image/png' && i.sizes === '512x512' && i.purpose === 'any'),
    'e PNG de 512');
  tudoOk &= ok(icones.some((i) => i.purpose === 'maskable'),
    'e um maskable, senão o Android recorta o ícone em cima do desenho');
  tudoOk &= ok(manifesto.display === 'standalone', 'abre como app, sem barra de navegador');
  for (const arquivo of ['icone-192.png', 'icone-512.png', 'icone-maskable-512.png', 'apple-touch-icon.png']) {
    tudoOk &= ok(fs.existsSync(path.join(__dirname, '..', 'public', arquivo)), `${arquivo} existe no disco`);
  }
  const htmlApp = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  tudoOk &= ok(/rel="apple-touch-icon"/.test(htmlApp),
    'iOS ignora o manifest: o ícone dele vem do apple-touch-icon no HTML');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  tudoOk &= ok(/addEventListener\('fetch'/.test(sw),
    'o service worker tem handler de fetch, que é o que o Chrome exige para instalar');

  // Todo id que o JS busca tem que existir no HTML — OU, se o nome estiver em
  // `IDS_DO_PAINEL` (a lista fechada dos que viraram elemento de painel), tem que existir
  // NA ÁRVORE do painel, por classe (ARMADILHA #53: quando o DOM falso ganha hierarquia de
  // verdade, o assert volta para a árvore — fica mais forte, não menos). `$('uso-trilho')`
  // devolvendo null matava abrirUso() na linha seguinte, e o clique no medidor não fazia
  // nada — sem erro visível, porque a exceção morria dentro do handler.
  const fonteBruta = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html2 = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const idsNoHtml = new Set([...html2.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const idsNoJs = [...new Set([...fonteBruta.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
  const orfaos = idsNoJs.filter((id) => !IDS_DO_PAINEL.has(id) && !idsNoHtml.has(id));
  tudoOk &= ok(orfaos.length === 0,
    `todo id procurado pelo JS existe no HTML${orfaos.length ? ` — faltam: ${orfaos.join(', ')}` : ` (${idsNoJs.length} conferidos)`}`);

  // Caixa de envio por painel (2026-09-09): os nomes de `IDS_DO_PAINEL` têm de existir DENTRO
  // do painel — escopado por `painelDe`, NUNCA `document.querySelectorAll` global (#44), que
  // mentiria casando qualquer outra coisa da página que tivesse a mesma classe.
  const painelParaIds = painelDe(cliente, 0);
  const faltamNoPainel = [...IDS_DO_PAINEL].filter((nome) => !painelParaIds.querySelector(`.${nome}`));
  tudoOk &= ok(faltamNoPainel.length === 0,
    `todo nome de IDS_DO_PAINEL existe DENTRO do painel, por classe${faltamNoPainel.length ? ` — faltam: ${faltamNoPainel.join(', ')}` : ` (${IDS_DO_PAINEL.size} conferidos)`}`);

  // ── Puxar para atualizar, só na LISTA (24/08) ─────────────────────────────
  //
  // A alternativa de dedo ao ↻. Não há indicador na tela (o selo saiu a pedido do dono
  // depois do smoke), então o que dá para provar é o COMPORTAMENTO — e é justamente onde dá
  // para errar sem ninguém perceber: roubar a rolagem da lista, abrir uma conversa sozinha
  // no fim do arrasto, e a carência do toque nunca vencer (aí o app fica surdo para sempre).
  console.log('\n  · puxar para atualizar');

  let buscasAbas = 0;
  const puxa = carregarCliente({
    aoBuscar: (rota) => {
      if (!rota.startsWith('api/abas')) return { painel: true, jobs: [] };
      buscasAbas += 1;
      return { abas: [{ chave: 'aba-7', titulo: 'cockpit', cwd: '/home/y/p/cockpit', temClaude: true, rodando: false, atualizadoEm: Date.now() }] };
    },
  });
  await puxa.carregarAbas();
  const listaPuxa = porIdDe(puxa, 'abas');
  const dedo = (y) => ({ touches: [{ clientY: y }], preventDefault() { this.barrou = true; }, barrou: false });
  // Lido da FONTE do cliente: `const` de topo não vira propriedade do global no vm, e mexer
  // nos números do app.js não pode deixar este teste mentindo verde.
  const numeroNaFonte = (nome) => {
    const achado = new RegExp(`const ${nome} = (\\d+)`)
      .exec(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'));
    return achado ? Number(achado[1]) : 0;
  };
  const LIMIAR = numeroNaFonte('PUXAR_LIMIAR');
  const CARENCIA = numeroNaFonte('PUXAR_CARENCIA');
  tudoOk &= ok(LIMIAR > 0 && CARENCIA > 0,
    `o gesto tem limiar e carência declarados no cliente (${LIMIAR}px, ${CARENCIA}ms)`);

  // (a) No topo da lista, arrastar para baixo é NOSSO — e tem que barrar a rolagem. Sem
  //     `preventDefault` a lista anda junto E o clique fantasma volta a passar.
  listaPuxa.scrollTop = 0;
  listaPuxa.disparar('touchstart', dedo(100));
  const meioDoCaminho = listaPuxa.disparar('touchmove', dedo(160));
  tudoOk &= ok(meioDoCaminho.barrou === true,
    'arrastar do topo para baixo barra a rolagem — o gesto é nosso a partir da folga');
  // Quem mostra que o gesto está acontecendo é a PRÓPRIA lista: ela desce colada no dedo.
  // Sem isso o gesto é invisível — a tela congela até a lista se refazer, que foi a queixa
  // registrada no segundo smoke (24/08).
  tudoOk &= ok(/^translateY\(\d+(\.\d+)?px\)$/.test(String(listaPuxa.style.transform)),
    `a lista desce junto com o dedo (transform=${listaPuxa.style.transform})`);
  tudoOk &= ok(listaPuxa.dataset.voltando === '',
    'e SEM transição enquanto o dedo manda — senão a lista atrasa em relação a ele');
  // O selo do gesto vale na lista desde 04/09 (pedido do dono). As três fases são as MESMAS
  // da fita — o que muda é só o nó. Sem estas asserções, tirar o selo daqui passaria verde.
  const seloLi = porIdDe(puxa, 'puxar-selo-lista');
  tudoOk &= ok(Boolean(seloLi), 'a lista tem o selo do gesto (#puxar-selo-lista)');
  const fracaoLi = Number(seloLi.style.getPropertyValue('--puxar'));
  tudoOk &= ok(fracaoLi > 0 && fracaoLi <= 1,
    `o selo da lista recebe a fração do curso enquanto o dedo anda (--puxar=${fracaoLi})`);
  tudoOk &= ok(seloLi.dataset.armado === '',
    'e NÃO fica armado antes do limiar — armar cedo faria o gesto mentir');

  // (b) Soltar ANTES do limiar não atualiza nada. É o gesto desistido — o mais comum.
  const antesDeSoltar = buscasAbas;
  listaPuxa.disparar('touchend', {});
  await new Promise((r) => setTimeout(r, 0));
  tudoOk &= ok(buscasAbas === antesDeSoltar, 'soltar antes do limiar não atualiza');
  // A volta É a animação: o atributo acende a `transition` do CSS, cuja curva passa do zero
  // e faz a lista subir um pouco ACIMA do lugar antes de assentar.
  tudoOk &= ok(listaPuxa.dataset.voltando === '1' && listaPuxa.style.transform === '',
    'soltar devolve a lista ao lugar com o repique ligado');
  const cssPuxar = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');
  tudoOk &= ok(/\.conversas\[data-voltando="1"\]\s*\{[^}]*transition:\s*transform[^}]*cubic-bezier\(\s*0?\.\d+,\s*1\.[1-9]/.test(cssPuxar),
    'e o CSS desenha essa volta com curva que PASSA do zero — é o repique, não uma volta reta');

  // O teto da descida, em gesto PRÓPRIO: um dedo que anda 720px passa do limiar, e misturar
  // isso com o teste de cima faria o "soltar antes do limiar" virar uma atualização.
  const TETO_DA_PUXADA = numeroNaFonte('PUXAR_TETO');
  listaPuxa.disparar('touchstart', dedo(100));
  listaPuxa.disparar('touchmove', dedo(100 + TETO_DA_PUXADA * 10));
  tudoOk &= ok(listaPuxa.style.transform === `translateY(${TETO_DA_PUXADA}px)`,
    `a lista para no teto por mais que o dedo ande (${listaPuxa.style.transform})`);
  listaPuxa.disparar('touchend', {});
  await new Promise((r) => setTimeout(r, 0));

  // (c) Passou do limiar, soltou: roda a MESMA tarefa do botão ↻.
  const antesDoValendo = buscasAbas;
  listaPuxa.disparar('touchstart', dedo(100));
  listaPuxa.disparar('touchmove', dedo(100 + LIMIAR));
  listaPuxa.disparar('touchend', {});
  await new Promise((r) => setTimeout(r, 0));
  tudoOk &= ok(buscasAbas === antesDoValendo + 1,
    'soltar passado o limiar refaz a lista — a mesma tarefa do botão ↻');
  tudoOk &= ok(porIdDe(puxa, 'btn-recarregar').dataset.recarregando === '',
    'e o ↻ do topo gira junto e volta ao normal no fim — é ele o retorno visual do gesto');
  tudoOk &= ok(seloLi.dataset.girando === '' && !seloLi.style.getPropertyValue('--puxar'),
    'e o selo da lista para de girar e APAGA no fim — selo aceso para sempre mentiria (#10)');

  // (d) O clique FANTASMA. Terminado o arrasto, o navegador ainda dispara um `click` no que
  //     estava debaixo do dedo: sem carência, puxar para atualizar abria uma conversa.
  //     A régua é o fluxo SSE — abrir uma conversa abre um EventSource, e é isso que não
  //     pode acontecer sozinho. (`hidden` não serve: o DOM de mentira não lê o HTML, então
  //     todo elemento nasce visível ali.)
  const cartao = listaPuxa.querySelector('.conversa');
  const fluxosAntesDoFantasma = puxa.fluxos.length;
  cartao.onclick();
  await new Promise((r) => setTimeout(r, 0));
  tudoOk &= ok(puxa.fluxos.length === fluxosAntesDoFantasma,
    'o clique fantasma logo depois do arrasto NÃO abre a conversa');
  await new Promise((r) => setTimeout(r, CARENCIA + 100));
  cartao.onclick();
  await new Promise((r) => setTimeout(r, 0));
  tudoOk &= ok(puxa.fluxos.length === fluxosAntesDoFantasma + 1,
    'e passada a carência o toque deliberado abre normalmente — a trava vence sozinha');

  // (e) Fora do topo o gesto NEM ARMA: rolar a lista para baixo tem que continuar rolando.
  const rolada = carregarCliente({ aoBuscar: (rota) => (rota.startsWith('api/abas') ? { abas: [] } : { painel: true, jobs: [] }) });
  const listaRolada = porIdDe(rolada, 'abas');
  listaRolada.scrollTop = 120;
  listaRolada.disparar('touchstart', dedo(100));
  const noMeio = listaRolada.disparar('touchmove', dedo(100 + LIMIAR));
  tudoOk &= ok(noMeio.barrou === false,
    'com a lista rolada, arrastar continua sendo rolagem — o gesto nem arma');

  // (f) Dedo SUBINDO no topo é rolagem normal, não puxada ao contrário.
  listaRolada.scrollTop = 0;
  listaRolada.disparar('touchstart', dedo(200));
  const subindo = listaRolada.disparar('touchmove', dedo(140));
  tudoOk &= ok(subindo.barrou === false,
    'dedo subindo não vira puxada — quem sobe está rolando a lista');

  // (g) A conversa GANHOU o gesto em 02/09 (card da primeira leva do design): no celular o
  //     ↻ saiu do topo da conversa e o gesto é o caminho de recarga ali. Até 02/09 esta
  //     asserção guardava o contrário (decisão do dono em 24/08) — reversão consciente,
  //     registrada na spec. O comportamento do gesto na fita é provado em PL-6 e PL-7.
  tudoOk &= ok(porIdDe(rolada, 'mensagens').ouvintes.has('touchstart') === true,
    'a conversa ganha o gesto (02/09) — o ↻ saiu do topo no celular e o dedo é o caminho');

  // O bug que comia metade da tela: `hidden` sem esta regra é decoração.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');
  tudoOk &= ok(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
    '[hidden] vence as classes que declaram display');

  // Sem `overscroll-behavior-y: contain`, chegar ao fim de um destes dois e continuar
  // puxando entrega o gesto ao pull-to-refresh NATIVO do Chrome — que faz reload e APAGA o
  // que estava digitado na caixa. Vale para a conversa também, que não tem gesto nosso:
  // o hábito nasce na lista e o dedo repete na fita.
  // Sem tirar o comentário antes, o seletor capturado vem colado no bloco `/* ... */` que o
  // precede e nenhuma comparação bate — falso vermelho que parece bug de CSS.
  const cssSemComentario = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const corpoDaRegra = (seletor) => {
    const achada = [...cssSemComentario.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .find(([, alvo]) => alvo.split(',').some((parte) => parte.trim() === seletor));
    return achada ? achada[2] : '';
  };
  for (const seletor of ['.conversas', '.mensagens']) {
    tudoOk &= ok(/overscroll-behavior-y:\s*contain/.test(corpoDaRegra(seletor)),
      `${seletor} não entrega a rolagem ao pull-to-refresh nativo, que recarregaria a página`);
  }

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const escondiveis = [...html.matchAll(/id="([\w-]+)"[^>]*\shidden/g)].map((m) => m[1]);
  tudoOk &= ok(escondiveis.length >= 4, `a tela tem ${escondiveis.length} blocos que somem por atributo`);

  // Quem rola dentro de um flex precisa de min-height:0, senão cresce e empurra o
  // vizinho para fora da tela. Só apareceu na conversa mais longa — o tipo de bug que
  // passa despercebido até o histórico crescer.
  const regras = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const rolantes = regras.filter(([, , corpo]) => /flex:\s*1/.test(corpo) && /overflow(-y)?:\s*auto/.test(corpo));
  const semTrava = rolantes.filter(([, , corpo]) => !/min-height:\s*0/.test(corpo));
  tudoOk &= ok(rolantes.length >= 2 && semTrava.length === 0,
    `todo painel que rola trava a altura com min-height:0 (${rolantes.length} conferidos)`);

  // ── "Te esperando" tem cor PRÓPRIA, em todos os temas (22/08) ──────────────
  //
  // O bug não era "cores parecidas": `trabalhando` e `te esperando` usavam a MESMA
  // variável (--accent), e no celular os dois estados eram um só. A correção é uma
  // variável nova, --espera, e é este bloco que faz ela durar: tema novo sem --espera
  // herdaria a do :root e pintaria coral de tema escuro num tema claro.
  console.log('\n  · cor do "te esperando"');
  const cor = require('./cor');
  const paletas = cor.paletas(css);
  tudoOk &= ok(paletas.length === 12,
    `os doze blocos de paleta são lidos do CSS (${paletas.length}: :root, o claro do sistema e dez temas)`);

  const semEspera = paletas.filter((t) => !t.variaveis['--espera']);
  tudoOk &= ok(semEspera.length === 0,
    `--espera existe nos onze${semEspera.length ? ` — faltam: ${semEspera.map((t) => t.rotulo).join(', ')}` : ''}`);

  // Distância PERCEPTIVA, não "string diferente": #e0a233 × #e0a234 passaria em igualdade
  // e continuaria indistinguível de relance, que é o problema que se está consertando.
  const iguais = [];
  const apagadas = [];
  for (const t of paletas) {
    const espera = t.variaveis['--espera'];
    const accent = t.variaveis['--accent'];
    const raiz = paletas[0].variaveis;
    const fundoLinha = t.variaveis['--fundo-2'] || raiz['--fundo-2'];
    const fundoHover = t.variaveis['--fundo-3'] || raiz['--fundo-3'];
    if (!espera || !accent) continue;
    const dist = cor.distinguiveis(espera, accent);
    if (!dist.ok) iguais.push(`${t.rotulo} (Δmatiz ${dist.matiz.toFixed(0)}°, ${dist.contraste.toFixed(2)}:1)`);
    // 4.5:1 é o piso da WCAG para texto pequeno, e o pino e o estado são de 11px. Os dois
    // fundos entram: a linha em repouso (--fundo-2) e a mesma linha sob o dedo (--fundo-3).
    for (const [onde, fundo] of [['linha', fundoLinha], ['hover', fundoHover]]) {
      const razao = cor.contraste(espera, fundo);
      if (!(razao >= 4.5)) apagadas.push(`${t.rotulo}/${onde} ${razao === null ? '?' : razao.toFixed(2)}:1`);
    }
  }
  tudoOk &= ok(iguais.length === 0,
    `em cada tema, --espera é perceptivelmente diferente do --accent dali${iguais.length ? ` — colam: ${iguais.join('; ')}` : ''}`);
  tudoOk &= ok(apagadas.length === 0,
    `--espera passa 4.5:1 sobre o fundo da linha nos onze${apagadas.length ? ` — reprovam: ${apagadas.join('; ')}` : ''}`);

  // A regra tem que USAR a variável — senão as dez declarações acima são enfeite.
  const regrasDe = (marca) => cor.blocos(css).filter((b) => b.seletor.includes(marca));
  const daEspera = regrasDe('[data-esperando="1"]');
  tudoOk &= ok(daEspera.length >= 2 && daEspera.every((b) => !/var\(--accent\)/.test(b.corpo)),
    `o bloco "te esperando" não usa mais o --accent (${daEspera.length} regras)`);
  // `>= 1` desde 02/09 (era `>= 2`): a BORDA do "te esperando" saiu de propósito na primeira
  // leva do design do celular — a borda lateral ficou reservada ao "perguntando". O que esta
  // asserção guarda continua valendo: o "te esperando" nunca volta ao --accent, e o pino e o
  // estado dele seguem em --espera. Nunca `>= 0`.
  tudoOk &= ok(daEspera.filter((b) => /var\(--espera\)/.test(b.corpo)).length >= 1,
    'e o pino e o estado dele saem do --espera (a borda saiu em 02/09, de propósito)');

  // Mudança cirúrgica: os OUTROS papéis do accent continuam onde estavam. Sem isto, uma
  // rodada distraída "uniformiza" a lista de novo e o achatamento volta por outro lado.
  const aindaNoAccent = ['[data-estado="trabalhando"]', '[data-nova]', '[aria-current="true"]']
    .filter((marca) => regrasDe(marca).some((b) => /var\(--accent(-suave)?\)/.test(b.corpo)));
  tudoOk &= ok(aindaNoAccent.length === 3,
    `trabalhando, não-lida e conversa aberta continuam no accent (${aindaNoAccent.length}/3)`);

  // Comentários fora: o cabeçalho do arquivo cita innerHTML justamente para proibi-lo.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  tudoOk &= ok(!/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/.test(fonte),
    'o cliente não usa innerHTML em lugar nenhum');

  // ── Tabela larga ROLA em vez de espremer (22/08) ───────────────────────────
  //
  // O `.tabela-rolagem { overflow-x: auto }` existia desde sempre e NUNCA disparou: as
  // células herdavam o `overflow-wrap: anywhere` do `.fala`, então a tabela sempre cabia
  // quebrando palavra no meio e nunca ficava larga. Regra certa que nunca vale porque
  // OUTRA regra impede a condição dela é o tipo de bug que nenhum teste de string pega —
  // por isso as asserções abaixo olham o PAR (quem rola + quem deixa ficar largo), e não
  // uma linha isolada.
  console.log('\n  · tabela larga rola dentro da bolha');
  const blocosCss = cor.blocos(css);
  const bloco = (alvo) => blocosCss.find((b) => b.seletor === alvo);
  const corpoDe = (alvo) => (bloco(alvo) || { corpo: '' }).corpo;

  const daTabela = corpoDe('.fala table');
  tudoOk &= ok(/width:\s*max-content/.test(daTabela) && /min-width:\s*100%/.test(daTabela),
    'a tabela pede a largura do conteúdo (width: max-content) e ainda enche a bolha (min-width: 100%)');

  const daCelula = corpoDe('.fala th, .fala td');
  tudoOk &= ok(/overflow-wrap:\s*normal/.test(daCelula) && /word-break:\s*normal/.test(daCelula),
    'dentro de th/td a quebra volta ao normal — palavra não parte no meio');
  const teto = /max-width:\s*(\d+)ch/.exec(daCelula);
  tudoOk &= ok(!!teto && Number(teto[1]) >= 20 && Number(teto[1]) <= 80,
    `a célula tem teto de largura (${teto ? `${teto[1]}ch` : 'nenhum'}) — uma coluna só não come a tabela`);

  // Nenhuma outra regra pode devolver o `anywhere` para a célula por outro caminho.
  const anywhereEmCelula = blocosCss.filter((b) => /\b(td|th)\b/.test(b.seletor)
    && /(overflow-wrap|word-break):\s*(anywhere|break-all|break-word)/.test(b.corpo));
  tudoOk &= ok(anywhereEmCelula.length === 0,
    `nenhuma regra de célula reintroduz a quebra no meio da palavra${anywhereEmCelula.length ? ` — ${anywhereEmCelula.map((b) => b.seletor).join(', ')}` : ''}`);

  // A contrapartida: a bolha CONTINUA com `anywhere`. É ele que impede um caminho longo ou
  // uma URL de furar a bolha em parágrafo — se sumir daqui, o conserto da tabela terá
  // quebrado o que já funcionava.
  tudoOk &= ok(/overflow-wrap:\s*anywhere/.test(corpoDe('.fala')),
    'o .fala continua com overflow-wrap: anywhere — URL longa em parágrafo segue quebrando');

  const daRolagem = corpoDe('.tabela-rolagem');
  tudoOk &= ok(/overflow-x:\s*auto/.test(daRolagem),
    'o quadro da tabela continua com overflow-x: auto — e agora tem o que rolar');
  tudoOk &= ok(/overscroll-behavior-x:\s*contain/.test(daRolagem),
    'rolar a tabela com o dedo não arrasta a conversa atrás dela');

  // O estouro tem que morrer DENTRO do quadro. A cadeia até a fita é: body (overflow
  // hidden) → .app (grid 100dvh) → .chat (item de grid com min-width: 0, senão a coluna
  // cresceria com o conteúdo) → .mensagens (overflow-y: auto, que por especificação faz o
  // outro eixo computar `auto` em vez de `visible`) → .fita → .fala. Se qualquer um desses
  // deixar de segurar, a página inteira volta a rolar de lado e a caixa de escrever sai da
  // tela — que é exatamente o print que abriu este conserto.
  tudoOk &= ok(/overflow:\s*hidden/.test(corpoDe('body')),
    'o body não rola — nem de lado');
  tudoOk &= ok(/min-width:\s*0/.test(corpoDe('.chat')),
    'a coluna do chat não estica com o conteúdo (min-width: 0)');
  tudoOk &= ok(/overflow(-y)?:\s*auto/.test(corpoDe('.mensagens')),
    'a área de mensagens clipa o que vazar, em vez de empurrar a página');

  // ── A tela da pergunta OCUPA a conversa, e rolar para cima volta ao histórico (28/08) ──
  //
  // Pedido do dono depois do primeiro smoke no note. O desenho de 25/08 (pergunta
  // flutuando numa faixa própria do grid, com rolador só dela) dava DOIS roladores que não
  // se falavam: rolar dentro da pergunta nunca chegava no histórico, e rolar o histórico
  // nunca revelava o começo da pergunta.
  //
  // O que amarra o comportamento são três coisas, e nenhuma sozinha basta:
  //   (a) a pergunta está DENTRO da `.mensagens` do painel — split view, fase 2: o markup
  //       migrou do HTML para `criarPainel` (app.js), então isto virou assert de ÁRVORE
  //       (o DOM de mentira agora TEM hierarquia — R2 da spec de 08/09), não mais de fonte;
  //   (b) ela NÃO é mais item do grid do chat (sem `grid-row`), senão voltava a flutuar;
  //   (c) `min-height: 100%` — é o "ocupa a tela de conversa" quando o menu é curto.
  //
  // A faixa do TOPO (`.chat-topo`) também migrou para dentro de cada `.painel` — com N
  // painéis cada um precisa do próprio cabeçalho. Caixa de envio por painel (2026-09-09,
  // D42): a faixa do `.envio` migrou junto — `.chat` (o grid externo) volta a ter UMA faixa
  // útil (os painéis); `.painel` é quem carrega as TRÊS faixas (topo, conversa, envio) — a
  // finalidade (uma faixa que rola travada) é a mesma, só muda de dono (R10 da spec).
  tudoOk &= ok(/display:\s*grid/.test(corpoDe('.chat'))
    && /grid-template-rows:\s*minmax\(0,\s*1fr\)\s*;/.test(corpoDe('.chat')),
    'o chat é um grid de UMA faixa útil: os painéis');
  tudoOk &= ok(/display:\s*grid/.test(corpoDe('.painel'))
    && /grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/.test(corpoDe('.painel')),
    'e cada painel carrega o grid de TRÊS faixas: topo, conversa e envio');
  // A COLUNA também é declarada, e com o `minmax(0, ...)` que autoriza ficar menor que o
  // conteúdo. Sem ela a coluna implícita é `auto` e se dimensiona pelo item mais largo: com
  // um job rodando, o caminho da faixa de etapa abria 424px num celular de 390px e a página
  // inteira andava para o lado (28/08). `1fr` puro não bastaria — o tamanho mínimo
  // automático de uma track flexível continua sendo o min-content dos itens.
  tudoOk &= ok(/grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(corpoDe('.chat')),
    'e a COLUNA dele não estica com o conteúdo: minmax(0, 1fr), nunca `auto` nem `1fr` puro');
  const clienteDoGrid = carregarCliente();
  const mensagensDoPainelGrid = porIdDe(clienteDoGrid, 'mensagens');
  tudoOk &= ok(Boolean(mensagensDoPainelGrid) && mensagensDoPainelGrid.querySelector('.pergunta') !== null,
    'a tela da pergunta mora DENTRO da .mensagens do painel: um rolador só para histórico e pergunta');
  tudoOk &= ok(!/grid-row/.test(corpoDe('.pergunta')),
    'e não é mais item do grid do chat — com `grid-row` ela voltaria a flutuar numa faixa');
  tudoOk &= ok(/min-height:\s*100%/.test(corpoDe('.pergunta')),
    'ela OCUPA a área da conversa mesmo com menu curto (min-height: 100%)');
  tudoOk &= ok(/background:[^;]*var\(--fundo\)/.test(corpoDe('.pergunta')),
    'com fundo OPACO: --perigo-suave sozinho deixaria as bolhas do histórico aparecendo por trás');
  tudoOk &= ok(!/max-height/.test(corpoDe('.pergunta-tela')),
    'e a tela da pane perde o teto de altura: rolador dentro de rolador é o que saiu daqui');
  tudoOk &= ok(/overflow:\s*auto/.test(corpoDe('.pergunta-tela')),
    'mas o overflow FICA — é ele que segura o framebuffer de 168 colunas na horizontal');
  const tamanhoDaPane = (corpoDe('.pergunta-tela').match(/font-size:\s*([\d.]+)px/) || [])[1];
  tudoOk &= ok(Number(tamanhoDaPane) >= 13,
    `e a letra do menu do terminal tem pelo menos 13px no desktop (${tamanhoDaPane}px)`);
  const fonteDaPane = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  tudoOk &= ok(/if \(primeira\) rolarFim\(painel\)/.test(fonteDaPane),
    'abrir a pergunta rola a conversa até ela — só na PRIMEIRA pintura, senão o tique de 5s roubaria a leitura do histórico');

  // ── Medidor de contexto (22/08) ────────────────────────────────────────────
  //
  // O número sai do `.jsonl` da conversa, sem gastar turno. O que estas asserções cobrem é
  // exatamente onde dá para errar: somar a coisa errada, contar o subagente junto, cair
  // para zero numa mensagem de erro do CLI, e — o pior — inventar um teto.
  console.log('\n  · medidor de contexto');
  const contexto = require('../lib/contexto');

  const linhaJsonl = (extra) => JSON.stringify({ type: 'assistant', ...extra });
  const usoDe = (i, cc, cr, o = 0) => ({
    input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o,
  });

  const fingido = [
    linhaJsonl({ message: { model: 'claude-opus-5', usage: usoDe(10, 20, 30, 999) } }),
    linhaJsonl({ message: { model: 'claude-opus-5', usage: usoDe(2, 1000, 108000, 500) } }),
  ].join('\n');
  const medido = contexto.medir(fingido);
  tudoOk &= ok(medido && medido.usados === 109002,
    `a janela ocupada é o ÚLTIMO usage somando entrada + cache (deu ${medido && medido.usados})`);
  tudoOk &= ok(medido && medido.teto === 200000 && medido.pct === 54.5,
    `teto de 200k e porcentagem certa (${medido && medido.pct}%)`);

  // `output_tokens` é o que SAIU do modelo, não o que está ocupando a janela. Somá-lo
  // inflaria o medidor um pouco a cada turno — erro que só aparece na conversa longa.
  tudoOk &= ok(contexto.somaDoUso(usoDe(1, 2, 3, 4000)) === 6,
    'output_tokens não entra na conta da janela');

  // Subagente tem janela PRÓPRIA. Contá-lo mostraria na tela o contexto de outra conversa.
  const comSidechain = [
    linhaJsonl({ message: { model: 'claude-opus-5', usage: usoDe(1, 1, 50000) } }),
    linhaJsonl({ isSidechain: true, message: { model: 'claude-opus-5', usage: usoDe(1, 1, 900) } }),
  ].join('\n');
  tudoOk &= ok(contexto.medir(comSidechain).usados === 50002,
    'o usage do subagente (isSidechain) não conta na janela da conversa');

  // Rate limit e erro de API chegam como `assistant` com model `<synthetic>` e usage tudo
  // zerado. Se a ÚLTIMA linha for uma dessas, o medidor cairia para 0% — justo na hora em
  // que mais se quer olhar para ele.
  const comSintetico = [
    linhaJsonl({ message: { model: 'claude-opus-5', usage: usoDe(1, 1, 70000) } }),
    linhaJsonl({ message: { model: '<synthetic>', usage: usoDe(0, 0, 0) } }),
  ].join('\n');
  const apesar = contexto.medir(comSintetico);
  tudoOk &= ok(apesar && apesar.usados === 70002 && apesar.modelo === 'claude-opus-5',
    'mensagem sintética do CLI (usage zerado) não zera o medidor');

  // A regra que não pode ceder: teto chutado é número errado com cara de número certo.
  const desconhecido = contexto.medir(
    linhaJsonl({ message: { model: 'gpt-qualquer-coisa', usage: usoDe(5, 5, 90) } }),
  );
  tudoOk &= ok(desconhecido && desconhecido.usados === 100
    && desconhecido.teto === null && desconhecido.pct === null,
  'modelo desconhecido mostra tokens e NENHUMA porcentagem — não inventa teto');
  tudoOk &= ok(contexto.tetoDoModelo('<synthetic>', 10) === null,
    '`<synthetic>` não é modelo e não ganha teto');

  // Sufixo `[1m]` é como o CLI nomeia a janela longa (`"model": "opus[1m]"` no settings).
  tudoOk &= ok(contexto.tetoDoModelo('claude-opus-5[1m]', 300000) === 1000000,
    'modelo com sufixo [1m] usa a janela de 1M');
  // Conferido no disco em 22/08: a API devolve `claude-opus-5` SEM sufixo mesmo em sessão
  // de 1M. Quem sabe é a config do CLI — e sem ela uma sessão longa com 109k mostraria 55%
  // em vez de 11%, escondendo cinco sextos da folga que ainda resta.
  tudoOk &= ok(contexto.tetoDoModelo('claude-opus-5', 109002, { longa: true }) === 1000000,
    'com o CLI configurado em [1m], a janela é de 1M mesmo com o id vindo sem sufixo');
  tudoOk &= ok(contexto.tetoDoModelo('claude-opus-5', 109002) === 200000,
    'e sem essa configuração o padrão continua sendo 200k');
  // Rede de segurança: uma conversa que já carrega 693k PROVA janela maior que 200k —
  // dedução, não chute. Sem ela o medidor mostraria "347%", que é pior que não mostrar nada.
  tudoOk &= ok(contexto.tetoDoModelo('claude-opus-5', 693000) === 1000000,
    'conversa já acima do teto calculado prova a janela longa em vez de estourar 100%');
  tudoOk &= ok(contexto.tetoDoModelo('claude-opus-5', 1200000) === null,
    'acima de 1M não há teto conhecido: volta a ser tokens sem porcentagem');
  // A config só decide o teto de modelo que a gente reconhece.
  tudoOk &= ok(contexto.tetoDoModelo('gpt-qualquer-coisa', 100, { longa: true }) === null,
    'a config do CLI não dá teto a modelo desconhecido');
  tudoOk &= ok(contexto.medir(
    linhaJsonl({ message: { model: 'claude-opus-5', usage: usoDe(2, 0, 109000) } }),
    { longa: true },
  ).pct === 10.9, 'a medição inteira respeita a janela configurada');

  tudoOk &= ok(contexto.medir('') === null && contexto.medir('{lixo}\n\n') === null,
    'arquivo sem usage nenhum devolve null (e a tela não mostra medidor)');
  // A cauda começa no meio de uma linha: a primeira é sempre um pedaço de JSON.
  const cortadoAoMeio = `ns":123}}\n${linhaJsonl({ message: { model: 'claude-opus-5', usage: usoDe(0, 0, 4000) } })}`;
  tudoOk &= ok(contexto.medir(cortadoAoMeio, { cortado: true }).usados === 4000,
    'leitura pela cauda descarta a primeira linha, que vem partida');

  // ── O effort da conversa (24/08) ───────────────────────────────────────────
  //
  // O nível de esforço vem da MESMA linha que já entrega o `usage`, e do NÍVEL RAIZ dela —
  // irmão de `message`, não dentro dele (conferido no disco em 24/08). É `.jsonl`, então é
  // POR CONVERSA: este número é histórico daquela conversa, e NÃO é o effort global do CLI
  // (esse mora na config e sai pelo `effortConfigurado`). Confundir os dois é o R9 da spec.
  console.log('\n  · effort: o nível vem da MESMA linha do usage');

  // MUDANÇA
  const comEffort = [
    linhaJsonl({ effort: 'low', message: { model: 'claude-opus-5', usage: usoDe(1, 1, 1000) } }),
    linhaJsonl({ effort: 'high', message: { model: 'claude-opus-5', usage: usoDe(2, 0, 50000) } }),
  ].join('\n');
  const medidoEffort = contexto.medir(comEffort);
  tudoOk &= ok(medidoEffort && medidoEffort.esforco === 'high',
    `o esforco sai da MESMA linha do usage, e vence a última (${medidoEffort && medidoEffort.esforco})`);

  // MUDANÇA — sem `effort` na linha, o campo é null e NADA MAIS muda: conversa antiga,
  // gravada por uma versão do CLI que não escrevia effort, simplesmente não mostra o chip.
  const semEffort = contexto.medir(
    linhaJsonl({ message: { model: 'claude-opus-5', usage: usoDe(2, 0, 109000) } }),
  );
  tudoOk &= ok(semEffort && semEffort.esforco === null
    && semEffort.usados === 109002 && semEffort.teto === 200000
    && semEffort.pct === 54.5 && semEffort.modelo === 'claude-opus-5',
  'linha sem effort devolve esforco null e o resto do medidor intacto');

  // MUDANÇA — o campo é do NÍVEL RAIZ. Achá-lo dentro de `message` seria achar no lugar
  // errado: o `message` é o que a API devolveu, o `effort` é o que o CLI carimbou.
  const effortNoLugarErrado = contexto.medir(
    linhaJsonl({ message: { model: 'claude-opus-5', effort: 'max', usage: usoDe(1, 1, 900) } }),
  );
  tudoOk &= ok(effortNoLugarErrado && effortNoLugarErrado.esforco === null,
    'o effort do nível RAIZ é o único que conta — `message.effort` não vale');

  // MUDANÇA — subagente tem janela e esforço próprios; já era pulado, e o campo novo não
  // pode ter aberto exceção nenhuma para ele.
  const sidechainComEffort = [
    linhaJsonl({ effort: 'medium', message: { model: 'claude-opus-5', usage: usoDe(1, 1, 30000) } }),
    linhaJsonl({ isSidechain: true, effort: 'max', message: { model: 'claude-opus-5', usage: usoDe(1, 1, 900) } }),
  ].join('\n');
  const semSidechain = contexto.medir(sidechainComEffort);
  tudoOk &= ok(semSidechain && semSidechain.esforco === 'medium' && semSidechain.usados === 30002,
    'o effort do subagente (isSidechain) não contamina o da conversa');

  // ── chaveDoContexto: a régua do "mudou" do relógio de 700 ms ────────────────
  //
  // O servidor guarda uma STRING, não o objeto. `pct` fica de fora de propósito: é derivado
  // de `usados` e `teto`, e incluí-lo criaria uma segunda chance de a chave mudar sem o
  // valor ter mudado.
  const ctxBase = { usados: 100, teto: 200000, pct: 0.1, modelo: 'claude-opus-5', esforco: 'high' };
  // A função ainda pode não existir (é assim que estas asserções nascem vermelhas). Chamar
  // direto derrubaria a SUÍTE INTEIRA num TypeError, e aí a prova do vermelho viraria uma
  // pilha de asserções que nunca chegaram a rodar. O guarda deixa cada uma reprovar sozinha.
  const temChave = typeof contexto.chaveDoContexto === 'function';
  const chaveDe = (c) => (temChave ? contexto.chaveDoContexto(c) : undefined);
  // MUDANÇA
  tudoOk &= ok(temChave && chaveDe(ctxBase) === chaveDe({ ...ctxBase }),
    'chaveDoContexto: dois contextos iguais dão a MESMA chave');
  // MUDANÇA
  tudoOk &= ok(temChave && chaveDe(ctxBase) !== chaveDe({ ...ctxBase, esforco: 'low' }),
    'chaveDoContexto: mudou só o esforco, a chave muda — é o que faz o topo se corrigir');
  // MUDANÇA
  tudoOk &= ok(temChave && chaveDe(ctxBase) !== chaveDe({ ...ctxBase, modelo: 'claude-sonnet-5' }),
    'chaveDoContexto: mudou só o modelo, a chave muda');
  // MUDANÇA — `pct` fora da chave: ele é derivado, e um valor diferente nele com os quatro
  // campos iguais não é mudança nenhuma.
  tudoOk &= ok(temChave && chaveDe(ctxBase) === chaveDe({ ...ctxBase, pct: 99 }),
    'chaveDoContexto: o pct NÃO entra na chave — ele é derivado de usados e teto');
  // MUDANÇA — `null` tem chave própria e nunca colide com contexto de verdade.
  tudoOk &= ok(temChave && chaveDe(null) === null && chaveDe(null) !== chaveDe(ctxBase),
    'chaveDoContexto: contexto null tem chave própria, que não colide com nenhum contexto');
  // MUDANÇA — campo ausente e campo nulo significam a MESMA coisa aqui ("não sei"), e
  // distinguir os dois faria o servidor emitir evento quando nada mudou.
  const semCampo = { usados: 100, teto: 200000, pct: 0.1, modelo: 'claude-opus-5' };
  tudoOk &= ok(temChave && chaveDe({ ...semCampo, esforco: null }) === chaveDe(semCampo),
    'chaveDoContexto: esforco null e esforco undefined dão a MESMA chave');

  // ── A cauda lida do DISCO (24/08) ──────────────────────────────────────────
  //
  // `medir` acima trabalha em cima de um pedaço de texto. Quem escolhe o pedaço é
  // `doArquivo`, e era ELE que tinha o defeito: a cauda era um tiro fixo de 256 KB, e um
  // print mandado pelo cockpit entra no `.jsonl` em base64 numa LINHA SÓ (medido em 24/08:
  // 398 KB, 453 KB, 710 KB). Entre a imagem ser escrita e o agente responder, a janela caía
  // INTEIRA dentro dessa linha: nenhum JSON fechava, nenhum `usage` aparecia, e o medidor
  // sumia da tela justo depois de mandar o print. Estas quatro asserções são a
  // régua da varredura para trás que substituiu o tiro fixo.
  const dirCtx = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-contexto-'));
  const gravar = (nome, texto) => {
    const alvo = path.join(dirCtx, nome);
    fs.writeFileSync(alvo, texto);
    return alvo;
  };
  const linhaUso = (n) => linhaJsonl({ message: { model: 'claude-opus-5', usage: usoDe(0, 0, n) } });

  // 1. O defeito em si. Sem a varredura isto devolve null e o medidor some da tela.
  const cauda100Imagem = gravar('imagem.jsonl', [
    linhaUso(109000),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { data: 'A'.repeat(700 * 1024) } }] } }),
  ].join('\n') + '\n');
  const achadoAtras = await contexto.doArquivo(cauda100Imagem);
  tudoOk &= ok(achadoAtras && achadoAtras.usados === 109000,
    `cauda tomada por uma imagem de 700 KB não some com o medidor (deu ${achadoAtras && achadoAtras.usados})`);

  // 2. Armadilha #11 no meio do caminho: a linha do `usage` fica PARTIDA entre dois blocos
  //    de 64 KB. O enchimento é calculado para a divisa cair no miolo dela, cinco blocos
  //    atrás do fim — ou seja, fora dos 256 KB que a janela antiga enxergava. Se o `carry`
  //    não emendasse, a linha morreria no JSON.parse e o número sumiria do mesmo jeito.
  const linhaPartida = linhaUso(77000);
  const tamU = Buffer.byteLength(linhaPartida, 'utf8') + 1;
  const enchimento = 5 * 64 * 1024 + Math.floor(tamU / 2) - tamU;
  const usoNaDivisa = gravar('divisa.jsonl', `${JSON.stringify({ type: 'user', message: { content: 'oi' } })}\n${linhaPartida}\n${'B'.repeat(enchimento - 1)}\n`);
  const emendado = await contexto.doArquivo(usoNaDivisa);
  tudoOk &= ok(emendado && emendado.usados === 77000,
    `linha de usage partida entre dois blocos é emendada, não perdida (deu ${emendado && emendado.usados})`);

  // 3. O que vale é o ÚLTIMO `usage`, mesmo com a imagem separando ele dos anteriores: o
  //    primeiro bloco que tem número guarda, por construção, o número mais novo do arquivo.
  const doisUsos = gravar('dois.jsonl', [
    linhaUso(11000),
    linhaUso(22000),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { data: 'C'.repeat(400 * 1024) } }] } }),
  ].join('\n') + '\n');
  const maisNovo = await contexto.doArquivo(doisUsos);
  tudoOk &= ok(maisNovo && maisNovo.usados === 22000,
    `varrendo para trás, o usage que vale é o mais NOVO (deu ${maisNovo && maisNovo.usados})`);

  // 4. A rede. Arquivo patológico não vira leitura de 44 MB a cada fim de turno: passou de
  //    `TETO_DURO` sem achar número, devolve null e a tela fica sem medidor — como sempre
  //    ficou quando o número não dá para saber.
  const alemDoTeto = gravar('teto.jsonl', `${linhaUso(5000)}\n${'D'.repeat(contexto.TETO_DURO + 2 * contexto.BLOCO)}\n`);
  tudoOk &= ok(await contexto.doArquivo(alemDoTeto) === null,
    'usage escondido além do teto duro de 4 MB devolve null em vez de varrer o arquivo inteiro');

  fs.rmSync(dirCtx, { recursive: true, force: true });

  // E agora a tela. O medidor só existe quando há número; sem ele, nada quebra.
  const comMedidor = carregarCliente();
  comMedidor.aplicar({
    tipo: 'sessao',
    meta: { titulo: 'projeto-a', cwd: '/home/voce/projetos/projeto-a', contexto: medido },
  });
  const caixaMedidor = porIdDe(comMedidor, 'medidor');
  tudoOk &= ok(caixaMedidor.hidden === false
    && porIdDe(comMedidor, 'medidor-pct').textContent === '55%',
  `o evento sessao desenha o medidor no topo (${porIdDe(comMedidor, 'medidor-pct').textContent})`);
  tudoOk &= ok(caixaMedidor.dataset.nivel === 'ok'
    && porIdDe(comMedidor, 'medidor-cheio').style.width === '54.5%',
  'a barra e a cor saem da mesma porcentagem');
  tudoOk &= ok(/109\.002/.test(caixaMedidor.atributos.title || ''),
    `o número exato fica no title (${caixaMedidor.atributos.title})`);

  comMedidor.aplicar({ tipo: 'turno_fim', contexto: { usados: 190000, teto: 200000, pct: 95, modelo: 'claude-opus-5' } });
  tudoOk &= ok(porIdDe(comMedidor, 'medidor-pct').textContent === '95%'
    && caixaMedidor.dataset.nivel === 'cheio',
  'o turno_fim atualiza o medidor, sem relógio novo');

  comMedidor.aplicar({ tipo: 'turno_fim', contexto: { usados: 5000, teto: null, pct: null, modelo: 'coisa-nova' } });
  tudoOk &= ok(porIdDe(comMedidor, 'medidor-pct').textContent === '5k'
    && porIdDe(comMedidor, 'medidor-trilho').hidden === true,
  'sem teto conhecido: tokens na etiqueta e trilho escondido');

  const semMedidor = carregarCliente();
  semMedidor.aplicar({ tipo: 'sessao', meta: { titulo: 'x', cwd: '/tmp/x', contexto: null } });
  semMedidor.aplicar({ tipo: 'texto', texto: 'a conversa segue igual' });
  tudoOk &= ok(porIdDe(semMedidor, 'medidor').hidden === true
    && /a conversa segue igual/.test(porIdDe(semMedidor, 'fita').textContent),
  'contexto null esconde o medidor e não quebra a tela');

  // O CELULAR é o caso principal deste job. Se o medidor cair no `display: none` do bloco
  // de 760px, o job inteiro não entregou nada.
  const blocoCelular = css.slice(css.indexOf('@media (max-width: 760px)'));
  const escondeMedidor = /\.medidor\s*(,[^{]*)?\{[^}]*display:\s*none/.test(blocoCelular);
  tudoOk &= ok(!escondeMedidor, 'o medidor NÃO está escondido no bloco de celular');
  tudoOk &= ok(/\.medidor-modelo\s*\{[^}]*display:\s*none/.test(blocoCelular),
    'só o nome do modelo sai no celular, para o topo caber numa linha');
  tudoOk &= ok(/\.medidor\s*\{[^}]*padding/.test(blocoCelular),
    'e o medidor tem versão compacta lá');

  // ── O chip de effort no topo (24/08) ───────────────────────────────────────
  //
  // Chip PRÓPRIO, e não um pedaço colado no `#medidor-modelo`, por um motivo só: o modelo
  // some no celular (`display: none` logo acima) e o effort herdaria isso — o job entregaria
  // zero justo no aparelho que motivou o medidor.
  console.log('\n  · o chip de effort no medidor');

  const chipCliente = carregarCliente();
  chipCliente.aplicar({
    tipo: 'sessao',
    meta: { titulo: 'x', cwd: '/tmp/x', contexto: { usados: 109002, teto: 200000, pct: 54.5, modelo: 'claude-opus-5', esforco: 'high' } },
  });
  const chip = porIdDe(chipCliente, 'medidor-effort');
  // MUDANÇA
  tudoOk &= ok(chip.textContent === 'high' && chip.hidden === false,
    `o chip de effort aparece com o nível da conversa (${chip.textContent})`);

  // MUDANÇA — sem effort o chip some, e NADA MAIS do medidor muda: é a mesma regra dos três
  // estados (D-e/D22), rótulo inventado é pior que rótulo nenhum.
  chipCliente.aplicar({ tipo: 'turno_fim', contexto: { usados: 190000, teto: 200000, pct: 95, modelo: 'claude-opus-5' } });
  tudoOk &= ok(chip.hidden === true
    && porIdDe(chipCliente, 'medidor-pct').textContent === '95%'
    && porIdDe(chipCliente, 'medidor-trilho').hidden === false
    && porIdDe(chipCliente, 'medidor').dataset.nivel === 'cheio',
  'sem effort o chip some e o resto do medidor desenha igual');

  // MUDANÇA — o estado que dá `return` cedo (sem teto conhecido) também resolve o chip. Sem
  // isto ele ficaria com o valor da conversa ANTERIOR, que é a pior mentira possível aqui.
  chipCliente.aplicar({ tipo: 'turno_fim', contexto: { usados: 109002, teto: 200000, pct: 54.5, modelo: 'claude-opus-5', esforco: 'max' } });
  chipCliente.aplicar({ tipo: 'turno_fim', contexto: { usados: 5000, teto: null, pct: null, modelo: 'coisa-nova' } });
  tudoOk &= ok(chip.hidden === true && porIdDe(chipCliente, 'medidor-pct').textContent === '5k',
    'no estado sem teto conhecido o chip também é resolvido, não fica com o valor anterior');

  // MUDANÇA — o painel por extenso mostra o effort quando há.
  chipCliente.aplicar({ tipo: 'turno_fim', contexto: { usados: 109002, teto: 200000, pct: 54.5, modelo: 'claude-opus-5', esforco: 'xhigh' } });
  porIdDe(chipCliente, 'medidor').onclick();
  const gradeChip = textoDe(porIdDe(chipCliente, 'contexto-grade'));
  tudoOk &= ok(/xhigh/.test(gradeChip), `o painel do medidor mostra o effort por extenso (${gradeChip.slice(-40)})`);

  // GUARDA — e não inventa linha quando não há (D22). Vale hoje e tem que continuar valendo.
  const chipSemNivel = carregarCliente();
  chipSemNivel.aplicar({
    tipo: 'sessao',
    meta: { titulo: 'x', cwd: '/tmp/x', contexto: { usados: 5000, teto: 200000, pct: 2.5, modelo: 'claude-opus-5' } },
  });
  porIdDe(chipSemNivel, 'medidor').onclick();
  tudoOk &= ok(!/effort|esforço/i.test(textoDe(porIdDe(chipSemNivel, 'contexto-grade'))),
    'sem effort o painel não inventa a linha — nada de "desconhecido"');

  // MUDANÇA — o CSS. As duas metades na MESMA asserção de propósito: "não cai no display:none"
  // sozinho nasceria VERDE só porque a classe ainda não existe, e guarda que nasce verde não
  // guarda nada. É o R8/#30 — regra certa que nunca dispara.
  tudoOk &= ok(/\.medidor-effort\s*\{/.test(css)
    && !/\.medidor-effort\s*(,[^{]*)?\{[^}]*display:\s*none/.test(blocoCelular),
  'o chip de effort tem estilo próprio e NÃO cai no display: none do bloco de celular');

  // MUDANÇA — split view, fase 2: o markup do medidor migrou do HTML para `criarPainel`
  // (app.js), e o DOM de mentira agora TEM hierarquia (createElement de verdade) — a
  // estrutura se prova em ÁRVORE, não mais lendo o arquivo pelo texto.
  const clienteMedidorHtml = carregarCliente();
  const botaoMedidor = porIdDe(clienteMedidorHtml, 'medidor');
  const modeloDoMedidor = botaoMedidor.querySelector('.medidor-modelo');
  const effortDoMedidor = botaoMedidor.querySelector('.medidor-effort');
  tudoOk &= ok(Boolean(modeloDoMedidor) && Boolean(effortDoMedidor)
    && botaoMedidor.filhos.indexOf(modeloDoMedidor) < botaoMedidor.filhos.indexOf(effortDoMedidor),
  'o chip mora DENTRO do botão do medidor, depois do nome do modelo');
  tudoOk &= ok(effortDoMedidor.hidden === true,
    'e nasce escondido: quem o acende é o desenharMedidor, com valor na mão');

  // ── O topo se corrige ENTRE turnos, sem relógio novo (24/08) ───────────────
  //
  // Era esta a raiz do "o nome do modelo mente": ninguém redesenhava o topo entre um
  // `turno_fim` e o seguinte. Agora o relógio de arquivo manda um evento `contexto` quando o
  // valor muda — e a promessa, medida com precisão, é: o topo se corrige na PRIMEIRA linha
  // `assistant` com `usage` que chegar depois da troca. Na prática, a primeira fala do agente
  // no turno seguinte. Não antes disso: sem `usage` não há o que medir.
  const entreTurnos = carregarCliente();
  entreTurnos.aplicar({
    tipo: 'sessao',
    meta: { titulo: 'x', cwd: '/tmp/x', contexto: { usados: 40000, teto: 200000, pct: 20, modelo: 'claude-sonnet-5', esforco: 'low' } },
  });
  // MUDANÇA
  entreTurnos.aplicar({
    tipo: 'contexto',
    contexto: { usados: 50002, teto: 200000, pct: 25, modelo: 'claude-opus-5', esforco: 'max' },
  });
  tudoOk &= ok(porIdDe(entreTurnos, 'medidor-modelo').textContent === 'opus-5'
    && porIdDe(entreTurnos, 'medidor-effort').textContent === 'max'
    && porIdDe(entreTurnos, 'medidor-pct').textContent === '25%',
  `o evento contexto redesenha o topo sem turno_fim nenhum (${porIdDe(entreTurnos, 'medidor-modelo').textContent}/${porIdDe(entreTurnos, 'medidor-effort').textContent})`);

  // MUDANÇA — `null` por este caminho NÃO apaga o medidor. Quem zera o topo é só o `sessao`,
  // que é troca de conversa de verdade; apagar aqui daria pisca-pisca no meio do turno (R2).
  entreTurnos.aplicar({ tipo: 'contexto', contexto: null });
  tudoOk &= ok(porIdDe(entreTurnos, 'medidor').hidden === false
    && porIdDe(entreTurnos, 'medidor-pct').textContent === '25%',
  'evento contexto com null é ignorado — o topo continua com o último número conhecido');

  // ── A ordem no servidor: estado e evento no MESMO bloco síncrono ───────────
  //
  // O `server.js` não é exigível pelo gate (ele sobe servidor no `require`), então a régua
  // aqui é a FONTE. O que se prova é a armadilha #33 pela porta nova: uma leitura que voltou
  // de um arquivo velho tem que morrer no guarda de geração ANTES de encostar no estado.
  const fonteCadencia = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const blocoRelogio = fonteCadencia.slice(
    fonteCadencia.indexOf('const relogioArquivo'),
    fonteCadencia.indexOf('const relogioEstado'),
  );
  const iGuarda = blocoRelogio.indexOf('minha !== geracao');
  const iEmissao = blocoRelogio.indexOf("tipo: 'contexto'");
  // MUDANÇA
  tudoOk &= ok(iGuarda >= 0 && iEmissao > iGuarda,
    'o evento contexto nasce DEPOIS do guarda de geração (#33)');
  // MUDANÇA — e sem ponto de suspensão no meio: um `await` entre o guarda e a emissão
  // deixaria duas batidas intercalarem "eu li a chave" com "o outro escreveu a chave".
  // Os comentários saem antes da busca: a regra é sobre CÓDIGO, e um comentário explicando
  // por que não há `await` ali reprovaria a asserção que ele explica.
  const semComentarios = (texto) => texto.replace(/^\s*\/\/.*$/gm, '');
  tudoOk &= ok(iGuarda >= 0 && iEmissao > iGuarda
    && !/await/.test(semComentarios(blocoRelogio.slice(iGuarda, iEmissao))),
  'e não há await entre o guarda e a emissão — leitura, decisão e escrita no mesmo bloco');

  // MUDANÇA — o RESET da régua nos dois pontos que emitem `sessao`. Sem ele, depois de um
  // /clear a conversa nova herda a chave da velha e o primeiro contexto de verdade é engolido.
  // O recorte é a função da ABA, e não o arquivo inteiro: existe um terceiro `sessao` no
  // fluxo de SESSÃO do cockpit (server.js:216), que não tem relógio de arquivo nem régua.
  const blocoFluxoAba = fonteCadencia.slice(
    fonteCadencia.indexOf('function acompanharAba'),
    fonteCadencia.indexOf('// Avisa os fluxos abertos'),
  );
  const emissoesSessao = blocoFluxoAba.split("tipo: 'sessao'").length - 1;
  const escritasDaRegua = (blocoFluxoAba.match(/ultimoContexto = /g) || []).length;
  tudoOk &= ok(emissoesSessao === 2 && escritasDaRegua >= 3,
    `os dois sessao semeiam a régua do "mudou" (${emissoesSessao} sessao, ${escritasDaRegua} escritas)`);
  // ── A tela da pane no celular ────────────────────────────────────────────────
  // O bloco de 760px não tocava em NADA de `.pergunta`: o celular recebia o CSS de desktop
  // inteiro — 11.5px de fonte e 24px de margem de cada lado — para ler um framebuffer de
  // 168 a 211 colunas numa viewport de ~390px. Sem comentário no meio, senão o `[^}]*`
  // casa o bloco `/* ... */` que precede a regra e o vermelho é falso.
  const celularLimpo = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocoCelularLimpo = celularLimpo.slice(celularLimpo.indexOf('@media (max-width: 760px)'));
  const regraPergunta = (blocoCelularLimpo.match(/\.pergunta\s*\{[^}]*\}/) || [''])[0];
  tudoOk &= ok(/position:\s*fixed/.test(regraPergunta) && /inset:\s*0/.test(regraPergunta),
    'no celular a tela da pane toma a tela INTEIRA — o terminal parou, não há o que fazer atrás');
  tudoOk &= ok(/background:[^;]*var\(--fundo\)/.test(regraPergunta),
    'e com fundo OPACO: --perigo-suave é rgba nos dez temas e deixaria a fita aparecendo por baixo');
  tudoOk &= ok(/\.pergunta-tela\s*\{[^}]*max-height:\s*none/.test(blocoCelularLimpo),
    'a tela solta o teto de 42vh do desktop: na tela cheia quem manda é o que sobra');
  tudoOk &= ok(/\.pergunta-tela\s*\{[^}]*font-size/.test(blocoCelularLimpo),
    'e a monoespaçada cresce: 11.5px é o tamanho de quem lê sentado, não do celular');
  tudoOk &= ok(/\.pergunta-tela\s*\{[^}]*overscroll-behavior-x:\s*contain/.test(blocoCelularLimpo),
    'rolar a tela até a borda não entrega a vez ao gesto do navegador (igual `.tabela-rolagem`)');
  tudoOk &= ok(/\.pergunta-tela\s*\{[^}]*mask-image/.test(blocoCelularLimpo),
    'e a borda esmaece: sem barra de rolagem no celular, é a única dica de que a linha continua');

  // ── O medidor é CLICÁVEL, e o painel é onde os números moram ────────────────
  // `title` é tooltip de MOUSE: no celular ele não existe, e era ali que estavam os tokens
  // exatos, o teto e o nome cheio do modelo — inalcançáveis justo no aparelho que motivou
  // o medidor. O `title` fica (desktop), mas deixou de ser o único caminho.
  tudoOk &= ok(botaoMedidor.tag === 'button',
    'o medidor voltou a ser <button> — no celular, clique é o único caminho');
  tudoOk &= ok(typeof botaoMedidor.onclick === 'function', 'e o clique tem dono no JS');
  tudoOk &= ok(/#medidor\b|\.medidor\s*\{[^}]*border-radius/.test(css),
    'com raio próprio: virar botão de volta não pode deixá-lo quadrado nem destoando do topo');

  comMedidor.aplicar({ tipo: 'turno_fim', contexto: { usados: 109002, teto: 200000, pct: 54.5, modelo: 'claude-opus-5[1m]' } });
  caixaMedidor.onclick();
  const grade = porIdDe(comMedidor, 'contexto-grade');
  const textoPainel = textoDe(grade) + textoDe(porIdDe(comMedidor, 'contexto-legenda'))
    + textoDe(porIdDe(comMedidor, 'contexto-percentual'));
  tudoOk &= ok(/109\.002/.test(textoPainel), `o painel mostra os tokens usados por extenso (${textoPainel.slice(0, 40)})`);
  tudoOk &= ok(/200\.000/.test(textoPainel), 'e o teto');
  tudoOk &= ok(/55%/.test(textoPainel), 'e a porcentagem');
  tudoOk &= ok(/claude-opus-5\[1m\]/.test(textoPainel),
    'e o modelo COMPLETO, com o [1m] que o nome curto do topo esconde');
  tudoOk &= ok(!/tokens usados|janela do modelo|ocupado/.test(textoDe(grade)),
    'os números ficam no destaque, sem repetir a mesma informação na grade');

  // Sem teto conhecido o painel não pode inventar porcentagem: é a regra da D22, e o
  // painel é justamente onde a tentação de "arredondar alguma coisa" apareceria.
  const semTeto = comMedidor.linhasDoContexto({ usados: 5000, teto: null, pct: null, modelo: 'coisa-nova' });
  const textoSemTeto = semTeto.map(([k, v]) => `${k}: ${v}`).join(' | ');
  tudoOk &= ok(!/%/.test(textoSemTeto), `sem teto conhecido, o painel não inventa porcentagem (${textoSemTeto})`);
  tudoOk &= ok(/desconhecida/.test(textoSemTeto), 'e diz com todas as letras que a janela é desconhecida');
  tudoOk &= ok(/5\.000/.test(textoSemTeto), 'mostrando ainda assim os tokens, que são sabidos');

  // Sem contexto não há painel para abrir — o medidor continua escondido, como antes.
  tudoOk &= ok(porIdDe(semMedidor, 'medidor').hidden === true,
    'sem contexto o medidor continua escondido e não há o que abrir');

  // ── Consumo do plano alcançável no celular ─────────────────────────────────
  //
  // `nivelDe` era chamada em desenharPlano e NÃO EXISTIA — morreu no corte das 513 linhas
  // de 21/08 junto com o marcarLido, e a chamada ficou. O ReferenceError estourava no
  // PRIMEIRO item e o diálogo abria com a lista vazia, em todo aparelho.
  console.log('\n  · consumo do plano');
  const plano = carregarCliente({
    aoBuscar: (rota) => (/api\/limite/.test(rota)
      ? {
        itens: [
          { rotulo: 'sessão de 5h', usado: 88, resetaEm: null },
          { rotulo: 'semana', usado: 40, resetaEm: null },
        ],
        consultadoEm: 0,
      }
      : { abas: [] }),
  });
  tudoOk &= ok(typeof plano.nivelDe === 'function', 'nivelDe existe (a chamada de carregarLimite tem dono)');
  tudoOk &= ok(plano.nivelDe(90) === 'cheio' && plano.nivelDe(70) === 'atencao' && plano.nivelDe(10) === 'ok',
    'e usa os mesmos limiares do resto da tela: 85 cheio, 65 atenção');
  await plano.carregarLimite(false);
  const trilhos = porIdDe(plano, 'uso-plano-lista').querySelectorAll('.plano-trilho');
  tudoOk &= ok(trilhos.length === 2, `o consumo do plano desenha os itens em vez de estourar (${trilhos.length} de 2)`);
  tudoOk &= ok(trilhos[0] && trilhos[0].dataset.nivel === 'cheio', 'e pinta o nível de cada janela');

  // O "Consumo do plano" mora no painel de configuração desde 24/08 — a cobertura dele está
  // no bloco da engrenagem, mais abaixo.

  // ── As janelas de graça (card medidor-de-sessao-de-graca, 2026-09-08) ──────
  //
  // `#uso-plano-janelas` é IRMÃO de `#uso-plano-lista`, NUNCA filho (R1/#44) — é por isso
  // que o `trilhos.length === 2` de cima continua medindo só `#uso-plano-lista`, sem ganhar
  // nenhum item do bloco novo.
  console.log('\n  · as janelas de graça (rate_limit_event, sem custar turno)');
  const comJanelas = carregarCliente({
    aoBuscar: (rota) => (/api\/limite/.test(rota)
      ? {
        itens: [],
        janelas: {
          itens: [
            { rotulo: 'Sessão (5h)', usado: 33, reseta: null, resetaEm: null },
            { rotulo: 'Semana (tudo)', usado: 20, reseta: null, resetaEm: null },
            { rotulo: 'Semana (com extra)', usado: 5, reseta: null, resetaEm: null },
          ],
          medidoEmAprox: Date.now() - 20 * 60_000,
          fonte: 'jobs',
          plano: null,
        },
        codex: null,
      }
      : { abas: [] }),
  });
  await comJanelas.carregarLimite(false);
  const itensJanelas = porIdDe(comJanelas, 'uso-plano-janelas').querySelectorAll('.plano-item');
  tudoOk &= ok(itensJanelas.length === 3, `3 itens de graça em #uso-plano-janelas (${itensJanelas.length})`);
  tudoOk &= ok(porIdDe(comJanelas, 'plano-valor').textContent.includes('33%'),
    `#plano-valor pega a Sessão (5h) das janelas de graça (${porIdDe(comJanelas, 'plano-valor').textContent})`);
  const notaJanelas = textoDe(porIdDe(comJanelas, 'uso-plano-janelas'));
  tudoOk &= ok(/~há/.test(notaJanelas) && /não custa turno/.test(notaJanelas),
    `e a nota diz "~há" e "não custa turno" (${notaJanelas})`);

  const semJanelas = carregarCliente({
    aoBuscar: (rota) => (/api\/limite/.test(rota) ? { itens: [], janelas: null, codex: null } : { abas: [] }),
  });
  await semJanelas.carregarLimite(false);
  tudoOk &= ok(porIdDe(semJanelas, 'uso-plano-janelas').children.length === 0,
    'janelas: null ⇒ #uso-plano-janelas fica VAZIO — ausência, não 0% (D-b)');
  porIdDe(semJanelas, 'dialogo-plano').showModal();
  tudoOk &= ok(porIdDe(semJanelas, 'dialogo-plano').open === true,
    'e o diálogo "Consumo do plano" abre sem quebrar mesmo sem janelas nenhuma');

  const janelasSemSessao = carregarCliente({
    aoBuscar: (rota) => (/api\/limite/.test(rota)
      ? {
        itens: [],
        janelas: {
          itens: [{ rotulo: 'Semana (tudo)', usado: 40, reseta: null, resetaEm: null }],
          medidoEmAprox: Date.now(), fonte: 'jobs', plano: null,
        },
        codex: null,
      }
      : { abas: [] }),
  });
  await janelasSemSessao.carregarLimite(false);
  tudoOk &= ok(porIdDe(janelasSemSessao, 'plano-valor').textContent === '',
    `sem "Sessão (5h)" em nenhuma fonte, #plano-valor fica VAZIO (P8) (veio "${porIdDe(janelasSemSessao, 'plano-valor').textContent}")`);

  // 🔴 As duas precedências de `resumoDoPlano` (achado do painel): quem tiver a medição MAIS
  // RECENTE ganha a linha do painel, e só o lado "janelas" carrega o sufixo de idade — o
  // `/usage` acabou de ser pago, não precisa dizer "há quanto tempo".
  //
  // O sufixo é `· ~2min`, NÃO `· ~há 2min`: em 390px o `.ajuste-valor` é `flex: none`, então
  // cada caractere a mais come o `.ajuste-rotulo`, e com a versão longa o ellipsis apagava
  // "Consumo do plano" INTEIRO — sobrava um ícone e um número sem dono (#40/#43). Pego pelo
  // PNG do smoke de celular, nunca por este gate: aqui não há layout. A frase por extenso
  // ("medido ~há 2min, no último job") vive na NOTA do diálogo, que tem a linha toda.
  console.log('\n  · resumoDoPlano: as duas precedências');
  const agoraDoTeste = Date.now();
  const janelasMaisNova = carregarCliente({
    aoBuscar: (rota) => (/api\/limite/.test(rota)
      ? {
        itens: [{ rotulo: 'Sessão (5h)', usado: 60, reseta: null, resetaEm: null }],
        consultadoEm: agoraDoTeste - 3600_000, // /usage pago há 1h
        janelas: {
          itens: [{ rotulo: 'Sessão (5h)', usado: 71, reseta: null, resetaEm: null }],
          medidoEmAprox: agoraDoTeste - 60_000, // job rodou há 1 min — mais novo que o /usage
          fonte: 'jobs', plano: null,
        },
        codex: null,
      }
      : { abas: [] }),
  });
  await janelasMaisNova.carregarLimite(false);
  const textoJanelasMaisNova = porIdDe(janelasMaisNova, 'plano-valor').textContent;
  tudoOk &= ok(textoJanelasMaisNova.startsWith('71%') && /·\s*~\d/.test(textoJanelasMaisNova),
    `janelas mais nova ganha, COM sufixo de idade curto (${textoJanelasMaisNova})`);
  tudoOk &= ok(!/~há/.test(textoJanelasMaisNova),
    `e a forma LONGA não entra na linha do painel — é ela que comia o rótulo (${textoJanelasMaisNova})`);

  // 🔴 Resposta FORA DE ORDEM (a guarda `seqLimite`). Achado do painel: com a chamada dentro
  // de `abrirConfig()`, abrir a Configuração e tocar em "Consumo do plano" logo em seguida
  // dispara DUAS `carregarLimite`, e sem guarda quem desenha é quem RESPONDER primeiro — a
  // lenta da primeira sobrescreveria a segunda. Aqui a primeira resolve DEPOIS da segunda.
  console.log('\n  · carregarLimite: resposta fora de ordem não sobrescreve a mais nova');
  let nDaChamada = 0;
  const foraDeOrdem = carregarCliente({
    aoBuscar: async (rota) => {
      if (!/api\/limite/.test(rota)) return { abas: [] };
      nDaChamada += 1;
      const eu = nDaChamada;
      // A 1ª demora 40 ms; a 2ª volta na hora. Sem `seqLimite`, o "11%" da primeira chega por
      // último e é ele que fica na tela.
      if (eu === 1) await new Promise((r) => setTimeout(r, 40));
      return {
        itens: [],
        janelas: {
          itens: [{ rotulo: 'Sessão (5h)', usado: eu === 1 ? 11 : 99, reseta: null, resetaEm: null }],
          medidoEmAprox: Date.now(), fonte: 'jobs', plano: null,
        },
        codex: null,
      };
    },
  });
  const primeira = foraDeOrdem.carregarLimite(false);   // lenta
  const segunda = foraDeOrdem.carregarLimite(false);    // rápida, e é a que vale
  await Promise.all([primeira, segunda]);
  const textoForaDeOrdem = porIdDe(foraDeOrdem, 'plano-valor').textContent;
  tudoOk &= ok(textoForaDeOrdem.startsWith('99%'),
    `a consulta mais NOVA fica na tela, mesmo respondendo antes da velha (${textoForaDeOrdem})`);
  tudoOk &= ok(porIdDe(foraDeOrdem, 'uso-plano-janelas').querySelectorAll('.plano-item').length === 1,
    'e o container não fica com as barras das DUAS empilhadas');

  const usageMaisNovo = carregarCliente({
    aoBuscar: (rota) => (/api\/limite/.test(rota)
      ? {
        itens: [{ rotulo: 'Sessão (5h)', usado: 60, reseta: null, resetaEm: null }],
        consultadoEm: agoraDoTeste, // acabou de ser pago
        janelas: {
          itens: [{ rotulo: 'Sessão (5h)', usado: 71, reseta: null, resetaEm: null }],
          medidoEmAprox: agoraDoTeste - 3600_000, // job de 1h atrás — mais velho que o /usage
          fonte: 'jobs', plano: null,
        },
        codex: null,
      }
      : { abas: [] }),
  });
  await usageMaisNovo.carregarLimite(false);
  const textoUsageMaisNovo = porIdDe(usageMaisNovo, 'plano-valor').textContent;
  tudoOk &= ok(textoUsageMaisNovo.startsWith('60%') && !/~há/.test(textoUsageMaisNovo),
    `/usage mais novo ganha, SEM sufixo de idade (${textoUsageMaisNovo})`);

  // 🔴 A nota de custo (4.4b) é PERMANENTE — sempre o ÚLTIMO filho de #uso-plano-lista, nos
  // TRÊS estados. Não é o `filhos.length > 0` de baixo (achado do painel: qualquer barra,
  // erro ou cabeçalho do Codex satisfaria aquele assert sem provar nada sobre a nota).
  console.log('\n  · a nota de custo é PERMANENTE, nos três estados (4.4b)');
  for (const [rotulo, resposta] of [
    ['itens vazio', { itens: [], janelas: null, codex: null }],
    ['itens cheio', { itens: [{ rotulo: 'Sessão (5h)', usado: 10, reseta: null, resetaEm: null }], consultadoEm: Date.now(), janelas: null, codex: null }],
    ['erro presente', { itens: [], erro: 'timeout', janelas: null, codex: null }],
  ]) {
    const cliCusto = carregarCliente({ aoBuscar: (rota) => (/api\/limite/.test(rota) ? resposta : { abas: [] }) });
    await cliCusto.carregarLimite(false);
    const filhosLista = porIdDe(cliCusto, 'uso-plano-lista').children;
    const ultimoFilho = filhosLista[filhosLista.length - 1];
    tudoOk &= ok(Boolean(ultimoFilho) && ultimoFilho.dataset.consumo === 'custo',
      `${rotulo}: [data-consumo="custo"] é o ÚLTIMO filho de #uso-plano-lista`);
    tudoOk &= ok(Boolean(ultimoFilho) && /turno/.test(ultimoFilho.textContent),
      `${rotulo}: e o texto fala em turno (${ultimoFilho && ultimoFilho.textContent})`);
  }


  // ── Celular: o voltar do aparelho e o Enter ─────────────────────────────────
  //
  // Dois incômodos de quem usa o cockpit instalado no Android. O voltar do aparelho fechava
  // o app de dentro da conversa; e o Enter mandava a mensagem quando o dedo só queria pular
  // uma linha. Os dois se provam sem navegador: um com a PILHA do history de mentira, o
  // outro trocando a resposta do `matchMedia` entre uma tecla e outra.
  console.log('\n  · celular: voltar do aparelho e Enter');

  const abaDoCelular = () => ({
    chave: 'aba-7', titulo: 'cockpit', cwd: '/home/y/projetos/cockpit-agentes',
    temClaude: true, rodando: false, sessaoId: 'sess-cel', atualizadoEm: 1,
  });
  const respostasDoCelular = (rotas) => (rota) => {
    rotas.push(String(rota));
    if (/api\/catalogo/.test(rota)) {
      return { itens: [{ nome: 'clear', tipo: 'comando', descricao: 'limpa a memória' }] };
    }
    if (String(rota).startsWith('api/abas/aba-7/turnos')) return { enviado: true };
    if (String(rota).startsWith('api/abas')) return { abas: [abaDoCelular()] };
    return { painel: true, jobs: [] };
  };
  // O `enviar()` do cliente não é esperado pelo `keydown`: sem este respiro o POST ainda
  // não teria saído e o teste diria "não enviou" para os DOIS ponteiros.
  const respirar = () => new Promise((r) => setImmediate(r));

  // ── (a) Enter: com o dedo quebra linha, com mouse envia ──
  const rotasTecla = [];
  const tecla = carregarCliente({ aoBuscar: respostasDoCelular(rotasTecla) });
  await tecla.carregarAbas();
  await tecla.abrirAba('aba-7');
  const caixa = porIdDe(tecla, 'entrada');
  const enviosDe = () => rotasTecla.filter((r) => r.startsWith('api/abas/aba-7/turnos')).length;
  tudoOk &= ok(caixa.ouvintes.has('keydown'), 'a caixa de texto tem um keydown com dono');

  tecla.midia['(pointer: coarse)'] = true;
  caixa.value = 'primeira linha';
  let barrado = false;
  caixa.disparar('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => { barrado = true; } });
  await respirar();
  tudoOk &= ok(barrado === false,
    'com o dedo, Enter não é barrado — a quebra de linha chega ao textarea');
  tudoOk &= ok(enviosDe() === 0, 'e nada é enviado: no celular quem envia é o botão Enviar');

  // O MESMO cliente ganha um teclado. Se a decisão estivesse congelada no carregamento,
  // isto continuaria quebrando linha e só um recarregar consertaria.
  tecla.midia['(pointer: coarse)'] = false;
  barrado = false;
  caixa.value = 'mando agora';
  caixa.disparar('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => { barrado = true; } });
  await respirar();
  tudoOk &= ok(barrado === true, 'com ponteiro fino, Enter é barrado — não vira quebra de linha');
  tudoOk &= ok(enviosDe() === 1, 'e a mensagem sai, como sempre foi no teclado físico');

  // Shift+Enter continua quebrando linha no teclado físico.
  barrado = false;
  caixa.value = 'segunda linha';
  caixa.disparar('keydown', { key: 'Enter', shiftKey: true, preventDefault: () => { barrado = true; } });
  await respirar();
  tudoOk &= ok(barrado === false && enviosDe() === 1, 'e Shift+Enter continua quebrando linha, sem enviar');

  // ── (b) Com a paleta aberta, Enter escolhe o item nos DOIS ponteiros ──
  for (const dedo of [true, false]) {
    const rotasPal = [];
    const pal = carregarCliente({ aoBuscar: respostasDoCelular(rotasPal) });
    await pal.carregarAbas();
    await pal.abrirAba('aba-7');
    pal.midia['(pointer: coarse)'] = dedo;
    const campo = porIdDe(pal, 'entrada');
    campo.value = '/cl';
    // Com a guarda nova (§3.6 da spec) o catálogo só abre se o CURSOR estiver nesta caixa —
    // é o que o navegador exige de verdade, e o DOM falso deixaria passar sem o `focus()`.
    campo.focus();
    await pal.talvezAbrirPaleta(pal.painelAtual());
    tudoOk &= ok(porIdDe(pal, 'paleta').hidden === false,
      `paleta aberta com ponteiro ${dedo ? 'grosso' : 'fino'}`);
    campo.disparar('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => {} });
    await respirar();
    tudoOk &= ok(campo.value === '/clear ',
      `e Enter escolhe o item da paleta, não quebra linha nem envia (ponteiro ${dedo ? 'grosso' : 'fino'})`);
    tudoOk &= ok(rotasPal.filter((r) => r.startsWith('api/abas/aba-7/turnos')).length === 0,
      `nada foi enviado ao escolher na paleta (ponteiro ${dedo ? 'grosso' : 'fino'})`);
    campo.value = '$cl';
    campo.focus();
    await pal.talvezAbrirPaleta(pal.painelAtual());
    tudoOk &= ok(textoDe(porIdDe(pal, 'paleta')).includes('/clear'),
      `Claude sem invocacao preserva busca por $ (ponteiro ${dedo ? 'grosso' : 'fino'})`);
  }

  // Catálogo Codex com uma colisão de propósito: comando /clear (embutido) e skill $clear
  // (homônima) coexistem — é o caso que prova o critério 2 da spec.
  const rotasCodex = [];
  const catalogoCodex = [
    { nome: 'handoff', tipo: 'skill', origem: 'global', invocacao: '$handoff' },
    { nome: 'clear', tipo: 'comando', origem: 'embutido', invocacao: '/clear',
      descricao: 'Limpa a tela do terminal e inicia uma conversa nova.' },
    { nome: 'clear', tipo: 'skill', origem: 'global', invocacao: '$clear',
      descricao: 'Skill homônima do comando' },
  ];
  const palCodex = carregarCliente({ aoBuscar: (rota) => {
    rotasCodex.push(String(rota));
    if (String(rota).startsWith('api/catalogo')) return { itens: catalogoCodex };
    if (String(rota).startsWith('api/abas')) return { abas: [umaAba({ agente: 'codex' })] };
    return { painel: true, jobs: [] };
  } });
  await palCodex.carregarAbas();
  await palCodex.abrirAba('aba-7');
  for (const prefixo of ['/', '$']) {
    const campo = porIdDe(palCodex, 'entrada');
    campo.value = prefixo + 'hand';
    campo.focus();
    await palCodex.talvezAbrirPaleta(palCodex.painelAtual());
    tudoOk &= ok(textoDe(porIdDe(palCodex, 'paleta')).includes('$handoff'),
      `paleta Codex mostra a invocação da skill ao buscar com ${prefixo}`);
    palCodex.escolher(palCodex.painelAtual(), 0);
    tudoOk &= ok(campo.value === '$handoff ', 'selecionar skill Codex insere $nome, sem enviar automaticamente');
  }

  // `/cl` busca comando e skill; `$cl` busca só a skill — pela invocação explícita, não pelo
  // tipo (critério 3). É o caso que prova a colisão de nome sem confundir os dois mundos.
  {
    const campo = porIdDe(palCodex, 'entrada');
    campo.value = '/cl';
    campo.focus();
    await palCodex.talvezAbrirPaleta(palCodex.painelAtual());
    const comBarra = textoDe(porIdDe(palCodex, 'paleta'));
    tudoOk &= ok(comBarra.includes('/clear') && comBarra.includes('$clear'),
      '/cl mostra o comando /clear e a skill $clear');

    campo.value = '$cl';
    campo.focus();
    await palCodex.talvezAbrirPaleta(palCodex.painelAtual());
    const comCifrao = textoDe(porIdDe(palCodex, 'paleta'));
    tudoOk &= ok(comCifrao.includes('$clear') && !comCifrao.includes('/clear'),
      '$cl mostra só a skill $clear, sem o comando homônimo');
  }

  // Seleção do comando por toque/mousedown e por Enter, nos dois ponteiros — preenche
  // `/clear ` sem cortar e sem POST (critério 4: escolher nunca envia).
  for (const dedo of [true, false]) {
    for (const via of ['mousedown', 'Enter']) {
      const antesDoEnvio = rotasCodex.filter((r) => r.startsWith('api/abas/aba-7/turnos')).length;
      palCodex.midia['(pointer: coarse)'] = dedo;
      const campo = porIdDe(palCodex, 'entrada');
      campo.value = '/cl';
      campo.focus();
      await palCodex.talvezAbrirPaleta(palCodex.painelAtual());
      if (via === 'mousedown') porIdDe(palCodex, 'paleta').children[0].onmousedown({ preventDefault() {} });
      else campo.disparar('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => {} });
      await respirar();
      tudoOk &= ok(campo.value === '/clear ',
        `${via} escolhe /clear sem cortar (ponteiro ${dedo ? 'grosso' : 'fino'})`);
      tudoOk &= ok(rotasCodex.filter((r) => r.startsWith('api/abas/aba-7/turnos')).length === antesDoEnvio,
        `nada foi enviado ao escolher /clear via ${via} (ponteiro ${dedo ? 'grosso' : 'fino'})`);
    }
  }

  // Falha do catálogo é legível — critério 5: a mensagem fala em "catálogo", não só "skills".
  // E digitar de novo tenta a rede outra vez (retry), não fica preso no erro anterior.
  {
    const rotasFalha = [];
    const cliFalha = carregarCliente({ aoBuscar: (rota) => {
      rotasFalha.push(String(rota));
      if (String(rota).startsWith('api/catalogo')) return { __status: 503, erro: 'Não consegui carregar o catálogo. Tente novamente.' };
      if (String(rota).startsWith('api/abas')) return { abas: [umaAba({ agente: 'codex' })] };
      return { painel: true, jobs: [] };
    } });
    await cliFalha.carregarAbas();
    await cliFalha.abrirAba('aba-7');
    const campo = porIdDe(cliFalha, 'entrada');
    campo.value = '/cl';
    campo.focus();
    await cliFalha.talvezAbrirPaleta(cliFalha.painelAtual());
    const texto = textoDe(porIdDe(cliFalha, 'paleta'));
    tudoOk &= ok(texto.includes('Não consegui carregar o catálogo. Tente digitar novamente.'),
      `catálogo indisponível mostra a mensagem nova (visto: ${JSON.stringify(texto)})`);

    rotasFalha.length = 0;
    campo.value = '/cl2';
    campo.focus();
    await cliFalha.talvezAbrirPaleta(cliFalha.painelAtual());
    tudoOk &= ok(rotasFalha.some((r) => r.startsWith('api/catalogo')),
      'digitar de novo tenta o catálogo outra vez (retry)');
  }

  // ── (c) Abrir conversa empilha; o popstate volta para a lista ──
  const rotasHist = [];
  const hist = carregarCliente({ aoBuscar: respostasDoCelular(rotasHist) });
  await hist.carregarAbas();
  const appHist = porIdDe(hist, 'app');
  const pilhaAntes = hist.history.pilha.length;
  await hist.abrirAba('aba-7');
  tudoOk &= ok(appHist.dataset.vista === 'chat', 'abrir a aba põe a tela na conversa');
  tudoOk &= ok(hist.history.pilha.length === pilhaAntes + 1,
    `e empilha UMA entrada no histórico (${hist.history.pilha.length - pilhaAntes})`);
  // Trocar de aba não é entrar de novo: se empilhasse, o voltar pediria um toque por aba.
  await hist.abrirAba('aba-7');
  tudoOk &= ok(hist.history.pilha.length === pilhaAntes + 1,
    'trocar de aba dentro da conversa não empilha de novo');
  // Chegar na lista e olhar o retrato do último tique — até 5s de idade — era a bolinha
  // mentindo por esse tempo sobre quem está trabalhando. A volta traz o estado NA HORA, e
  // pelo mesmo relógio de sempre: reiniciado, nunca um segundo de pé em paralelo.
  const listaAntes = rotasHist.filter((r) => r === 'api/abas').length;
  hist.history.back();
  await new Promise((resolver) => setTimeout(resolver, 0));
  tudoOk &= ok(appHist.dataset.vista === 'lista', 'o voltar do aparelho devolve a LISTA');
  tudoOk &= ok(hist.history.saiuDoApp === false, 'e não sai do app nesse primeiro toque');
  const listaDepois = rotasHist.filter((r) => r === 'api/abas').length;
  tudoOk &= ok(listaDepois > listaAntes,
    `e o estado das abas é buscado NA HORA, sem esperar o tique (${listaDepois - listaAntes})`);
  tudoOk &= ok(hist.relogios.size === 1,
    `e a volta não faz nascer relógio novo (${hist.relogios.size})`);
  hist.history.back();
  await new Promise((resolver) => setTimeout(resolver, 0));
  tudoOk &= ok(hist.history.saiuDoApp === true, 'só o segundo toque, já na lista, sai do app');
  tudoOk &= ok(rotasHist.filter((r) => r === 'api/abas').length === listaDepois,
    'e o voltar que SAI do app não gasta uma busca à toa: só a volta que chega na lista busca');

  // O botão da tela percorre o MESMO caminho: desempilha e deixa o popstate trocar a vista.
  await hist.abrirAba('aba-7');
  const pilhaComChat = hist.history.pilha.length;
  const btnVoltar = porIdDe(hist, 'btn-voltar');
  tudoOk &= ok(typeof btnVoltar.onclick === 'function', 'o botão voltar da tela tem dono no JS');
  btnVoltar.onclick();
  tudoOk &= ok(appHist.dataset.vista === 'lista' && hist.history.pilha.length === pilhaComChat - 1,
    'o botão da tela também DESEMPILHA — sem isso o histórico juntaria entradas fantasma');

  // ── (d) Deep link da notificação: o primeiro voltar cai na lista, não fora do app ──
  const rotasDeep = [];
  const deep = carregarCliente({
    urlInicial: 'http://z/#c=aba-7',
    aoBuscar: respostasDoCelular(rotasDeep),
  });
  for (let i = 0; i < 6; i += 1) await respirar();  // o app abre sozinho no carregamento
  const appDeep = porIdDe(deep, 'app');
  tudoOk &= ok(appDeep.dataset.vista === 'chat', 'a notificação entra direto na conversa');
  tudoOk &= ok(deep.location.hash === '', 'e o `#c=` some da barra de endereço');
  tudoOk &= ok(deep.history.pilha.length === 2,
    `a limpeza do endereço não vira entrada a mais: só a base e a conversa (${deep.history.pilha.length})`);
  deep.history.back();
  tudoOk &= ok(appDeep.dataset.vista === 'lista' && deep.history.saiuDoApp === false,
    'quem entrou pela notificação e apertou voltar cai na LISTA, não fora do app');

  // ── (e) Notificação tocada com o app JÁ ABERTO ──
  // Aqui o `sw.js` não abre janela nova: ele foca a que existe e chama
  // `janela.navigate('#c=…')`. Trocar o hash empilha uma entrada por conta do NAVEGADOR, e
  // o `replaceState` que limpa a URL apenas reescreve essa entrada — não a remove. Empilhar
  // outra por cima daria ao voltar um degrau morto: o primeiro toque devolveria a lista e o
  // segundo, em vez de sair do app, cairia nesse fantasma.
  const rotasVivo = [];
  const vivo = carregarCliente({ aoBuscar: respostasDoCelular(rotasVivo) });
  await vivo.carregarAbas();
  const appVivo = porIdDe(vivo, 'app');
  const pilhaNaLista = vivo.history.pilha.length;
  // O que o navegador faz sozinho quando o service worker navega para o hash:
  vivo.history.pilha.push({ estado: null, url: 'http://z/#c=aba-7' });
  vivo.location.hash = '#c=aba-7';
  for (const fn of vivo.janela.get('hashchange') || []) fn({});
  for (let i = 0; i < 6; i += 1) await respirar();
  tudoOk &= ok(appVivo.dataset.vista === 'chat', 'a notificação com o app aberto entra na conversa');
  tudoOk &= ok(vivo.history.pilha.length === pilhaNaLista + 1,
    `e a entrada do hash BASTA: o app não empilha outra por cima (${vivo.history.pilha.length - pilhaNaLista})`);
  vivo.history.back();
  tudoOk &= ok(appVivo.dataset.vista === 'lista' && vivo.history.saiuDoApp === false,
    'o primeiro voltar devolve a lista');
  vivo.history.back();
  tudoOk &= ok(vivo.history.saiuDoApp === true,
    'e o segundo sai do app — sem degrau fantasma no meio');

  // O token também chega por replaceState. Se ele empilhasse, o voltar gastaria um toque.
  const comTokenNaUrl = carregarCliente({ urlInicial: 'http://z/?token=abc123', guardado: memoria() });
  tudoOk &= ok(comTokenNaUrl.history.pilha.length === 1,
    'limpar o token da URL não empilha entrada nenhuma');

  // ── Atalhos de teclado — o motor ─────────────────────────────────────────────
  //
  // Spec: docs/superpowers/specs/2026-08-29-atalhos-de-teclado-configuraveis-design.md.
  // Este grupo cobre 1-7, 8a, 9, 10, 11, 16, 17, 18, 18b, 18c-mapa, 18d e 19 da tabela §4.1 —
  // as que nascem com o código desta fase. 8b e 18c-tela (a TELA) vivem no grupo da Fase 2.
  console.log('\n  · atalhos de teclado — o motor');
  await rodarGrupo('atalhos de teclado — o motor', async () => {
    const TRES_ABAS = () => ([
      { chave: 'aba-1', titulo: 'um', cwd: '/tmp/um', temClaude: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 },
      { chave: 'aba-2', titulo: 'dois', cwd: '/tmp/dois', temClaude: true, rodando: false, sessaoId: 's2', atualizadoEm: 2 },
      { chave: 'aba-3', titulo: 'tres', cwd: '/tmp/tres', temClaude: true, rodando: false, sessaoId: 's3', atualizadoEm: 3 },
    ]);
    // `api/abas/*/turnos` respondendo `{ enviado: true }` é só para a asserção 19 (Enter
    // continua enviando) não deixar uma promessa rejeitada solta no ar.
    const respostas = (rotas) => (rota) => {
      rotas.push(String(rota));
      if (/\/turnos/.test(String(rota))) return { enviado: true };
      if (String(rota).startsWith('api/abas')) return { abas: TRES_ABAS() };
      return { painel: true, jobs: [] };
    };
    const novoCliente = async () => {
      const rotas = [];
      const cli = carregarCliente({ aoBuscar: respostas(rotas) });
      await cli.carregarAbas();
      await cli.abrirAba('aba-1');
      return cli;
    };
    // O elemento do evento simulado, com tudo que `combinacaoDe` consulta —
    // `getModifierState` PRECISA existir (a §3.3 o chama para o AltGraph), senão um objeto
    // sem ele estoura com TypeError em vez de reprovar com mensagem.
    const dispararTecla = (cli, propriedades) => {
      const base = {
        key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        repeat: false, target: porIdDe(cli, 'entrada'),
        preventDefault() {}, getModifierState() { return false; },
      };
      const evento = { ...base, ...propriedades };
      for (const fn of cli.ouvintes.get('keydown') || []) fn(evento);
      return evento;
    };
    // Qual aba está aberta AGORA — lido do último EventSource criado por `abrirAba`
    // (`fluxo = new EventSource('api/eventos?abas=<chave>')`), já que `atual` (let de
    // módulo) não sobrevive ao vm como propriedade do contexto.
    const abaAbertaEm = (cli) => {
      const ultimo = cli.fluxos[cli.fluxos.length - 1];
      if (!ultimo) return null;
      const m = String(ultimo.rota).match(/^api\/eventos\?abas=([\w-]+)/);
      return m ? m[1] : null;
    };

    // A navegação segue os grupos visíveis, inclusive após mover/recolher ao vivo.
    const preferencias = memoria();
    preferencias.setItem('cockpit-projetos', JSON.stringify({ ordem: ['/tmp/tres', '/tmp/um', '/tmp/dois'], fechados: [] }));
    const organizado = carregarCliente({ guardado: preferencias,
      aoBuscar: rota => String(rota).startsWith('api/abas') ? { abas: [
        ...TRES_ABAS(), { ...TRES_ABAS()[0], chave: 'aba-4', titulo: 'quatro' },
      ] } : { painel: true, jobs: [] } });
    await organizado.carregarAbas();
    await organizado.abrirAba('aba-3');
    const j = () => dispararTecla(organizado, { key: 'j', code: 'KeyJ', altKey: true });
    const k = () => dispararTecla(organizado, { key: 'k', code: 'KeyK', altKey: true });
    j();
    tudoOk &= ok(abaAbertaEm(organizado) === 'aba-1', 'Alt+J segue a ordem personalizada dos projetos');
    j();
    tudoOk &= ok(abaAbertaEm(organizado) === 'aba-4', 'continua dentro do grupo mesmo com abas intercaladas na API');
    k();
    tudoOk &= ok(abaAbertaEm(organizado) === 'aba-1', 'Alt+K percorre a mesma ordem no sentido contrário');
    const gruposOrganizados = () => porIdDe(organizado, 'abas').querySelectorAll('.conversa-grupo[data-cwd]');
    gruposOrganizados()[1].querySelector('.projeto-alternar').onclick();
    j();
    tudoOk &= ok(abaAbertaEm(organizado) === 'aba-2', 'saindo de um projeto recolhido, pula suas conversas ocultas');
    k();
    tudoOk &= ok(abaAbertaEm(organizado) === 'aba-3', 'Alt+K também ignora o grupo recolhido');
    gruposOrganizados()[2].querySelectorAll('.projeto-mover')[0].onclick();
    j();
    tudoOk &= ok(abaAbertaEm(organizado) === 'aba-2', 'mover um projeto atualiza os atalhos imediatamente');
    gruposOrganizados()[1].querySelectorAll('.projeto-mover')[0].onclick();
    j();
    tudoOk &= ok(abaAbertaEm(organizado) === 'aba-3',
      'após subir o projeto atual para o primeiro lugar, Alt+J segue seu novo vizinho');
    gruposOrganizados().filter(g => !g.querySelector('.projeto-conteudo').hidden)
      .forEach(g => g.querySelector('.projeto-alternar').onclick());
    const antesDeRecolherTudo = organizado.fluxos.length;
    j(); k();
    tudoOk &= ok(organizado.fluxos.length === antesDeRecolherTudo,
      'com todos os projetos recolhidos, os atalhos não abrem conversas escondidas');

    // 1 — o ouvinte existe
    const c1 = await novoCliente();
    tudoOk &= ok(c1.ouvintes.has('keydown'), 'document tem um ouvinte de keydown — o atalho global');

    // 2 — par: tecla nua com foco na caixa não troca · Alt+J troca
    const c2 = await novoCliente();
    dispararTecla(c2, { key: 'j', code: 'KeyJ' });
    tudoOk &= ok(abaAbertaEm(c2) === 'aba-1', 'tecla nua "j" com foco na caixa NÃO troca de aba (é texto)');
    dispararTecla(c2, { key: 'j', code: 'KeyJ', altKey: true });
    tudoOk &= ok(abaAbertaEm(c2) === 'aba-2', 'e Alt+J troca — a mesma tecla, com modificador');

    // 3 — par: Shift+J não troca · Alt+J troca
    const c3 = await novoCliente();
    dispararTecla(c3, { key: 'J', code: 'KeyJ', shiftKey: true });
    tudoOk &= ok(abaAbertaEm(c3) === 'aba-1', 'Shift+J sozinho NÃO troca (Shift não é Ctrl/Alt/Meta)');
    dispararTecla(c3, { key: 'j', code: 'KeyJ', altKey: true });
    tudoOk &= ok(abaAbertaEm(c3) === 'aba-2', 'e Alt+J troca');

    // 4 — par: Ctrl+Alt+J (AltGr) não troca · Alt+J troca
    const c4 = await novoCliente();
    dispararTecla(c4, { key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true });
    tudoOk &= ok(abaAbertaEm(c4) === 'aba-1', 'Ctrl+Alt+J (AltGr num ABNT2) NÃO troca de aba');
    dispararTecla(c4, { key: 'j', code: 'KeyJ', altKey: true });
    tudoOk &= ok(abaAbertaEm(c4) === 'aba-2', 'e Alt+J, sem o Ctrl fantasma do AltGr, troca');

    // 5 — Alt+K volta uma aba, e na primeira não dá a volta
    const c5 = await novoCliente();
    await c5.abrirAba('aba-2');
    dispararTecla(c5, { key: 'k', code: 'KeyK', altKey: true });
    tudoOk &= ok(abaAbertaEm(c5) === 'aba-1', 'Alt+K volta uma aba');
    dispararTecla(c5, { key: 'k', code: 'KeyK', altKey: true });
    tudoOk &= ok(abaAbertaEm(c5) === 'aba-1', 'e na primeira aba Alt+K NÃO dá a volta — grampeia, não circula');

    // 6 — Alt+C põe o foco na caixa (truque: trocar o focus() do PRÓPRIO elemento, o do
    // DOM de mentira é no-op e não existe document.activeElement)
    const c6 = await novoCliente();
    let focou = false;
    porIdDe(c6, 'entrada').focus = () => { focou = true; };
    dispararTecla(c6, { key: 'c', code: 'KeyC', altKey: true });
    tudoOk &= ok(focou, 'Alt+C põe o foco na caixa de escrita');

    // 7 — Alt+L alterna app.dataset.lateral e grava em cockpit-lateral-fechada
    const c7 = await novoCliente();
    const appC7 = porIdDe(c7, 'app');
    tudoOk &= ok(appC7.dataset.lateral === 'aberta', 'lateral começa aberta (estado de antes do atalho)');
    dispararTecla(c7, { key: 'l', code: 'KeyL', altKey: true });
    tudoOk &= ok(appC7.dataset.lateral === 'fechada', 'Alt+L recolhe a lateral');
    tudoOk &= ok(c7.localStorage.getItem('cockpit-lateral-fechada') === '1',
      'e grava a escolha em cockpit-lateral-fechada, como o botão já fazia');

    // 8a — Alt+/ ABRE o #dialogo-config (montar a lista é 8b, na Fase 2)
    const c8 = await novoCliente();
    dispararTecla(c8, { key: '/', code: 'Slash', altKey: true });
    tudoOk &= ok(porIdDe(c8, 'dialogo-config').open === true, 'Alt+/ abre o painel de configuração');

    // 9 — par: Alt+J com #dialogo-config aberto não troca · fechado, troca
    const c9 = await novoCliente();
    porIdDe(c9, 'dialogo-config').open = true;
    dispararTecla(c9, { key: 'j', code: 'KeyJ', altKey: true });
    tudoOk &= ok(abaAbertaEm(c9) === 'aba-1', 'com #dialogo-config aberto, Alt+J NÃO troca de aba');
    porIdDe(c9, 'dialogo-config').open = false;
    dispararTecla(c9, { key: 'j', code: 'KeyJ', altKey: true });
    tudoOk &= ok(abaAbertaEm(c9) === 'aba-2', 'e fechado, troca');

    // 10 — par: Alt+J com a paleta do CURSOR visível não troca · escondida, troca
    const c10 = await novoCliente();
    // Guarda 4 é pelo CURSOR agora (§3.6 da spec), não por `.paleta.hidden` isolado — sem
    // focar a caixa aqui, `document.activeElement` fica nulo e a guarda NUNCA bloqueia,
    // paleta "visível" ou não.
    porIdDe(c10, 'entrada').focus();
    porIdDe(c10, 'paleta').hidden = false;
    dispararTecla(c10, { key: 'j', code: 'KeyJ', altKey: true });
    tudoOk &= ok(abaAbertaEm(c10) === 'aba-1', 'com a paleta visível, Alt+J NÃO troca de aba — ela já é dona');
    porIdDe(c10, 'paleta').hidden = true;
    dispararTecla(c10, { key: 'j', code: 'KeyJ', altKey: true });
    tudoOk &= ok(abaAbertaEm(c10) === 'aba-2', 'e escondida, troca');

    // 11 — par: e.repeat não troca (autorepeat, §5.5) · sem repeat, troca
    const c11 = await novoCliente();
    dispararTecla(c11, { key: 'j', code: 'KeyJ', altKey: true, repeat: true });
    tudoOk &= ok(abaAbertaEm(c11) === 'aba-1', 'com e.repeat, Alt+J NÃO troca — autorepeat não é atalho');
    dispararTecla(c11, { key: 'j', code: 'KeyJ', altKey: true, repeat: false });
    tudoOk &= ok(abaAbertaEm(c11) === 'aba-2', 'e sem repeat, troca');

    // 16 — todo <dialog id=…> do index.html bloqueia o atalho global (está em DIALOGOS).
    // Proxy comportamental, não comparação de array: DIALOGOS é `const` de módulo e não
    // sobrevive ao vm como propriedade — é a guarda 3 quem prova, dialog por dialog, que a
    // lista bate com o HTML. `<dialog>` novo sem entrada em DIALOGOS reprova aqui (#40).
    const htmlDialogos = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    // O `>` NÃO entra no casamento: `<dialog id="dialogo-uso" aria-labelledby="uso-titulo">`
    // tem atributo DEPOIS do id, e o regex antigo (que exigia `">` colado) o pulava inteiro
    // — o décimo diálogo escapava do laço abaixo sem ninguém notar. Foi assim que ele ficou
    // fora de DIALOGOS e os atalhos vazavam com a tela de tokens aberta.
    const idsDialogNoHtml = [...htmlDialogos.matchAll(/<dialog id="([^"]+)"/g)].map((m) => m[1]);
    // Contagem EXATA, e não "ao menos": é o que faz um <dialog> a mais ou a menos reprovar
    // em vez de passar calado. Afrouxar para `>=` foi o que escondeu o décimo.
    tudoOk &= ok(idsDialogNoHtml.length === 10,
      `são DEZ <dialog> agora — o décimo é o #dialogo-uso da fase 2b (${idsDialogNoHtml.length})`);
    for (const idDialogo of idsDialogNoHtml) {
      // Par, não negativa solta: sem a positiva ("fechado funciona"), a checagem passaria
      // trivialmente contra código nenhum — é a inércia que a §4.1 condena.
      const c16 = await novoCliente();
      dispararTecla(c16, { key: 'j', code: 'KeyJ', altKey: true });
      const trocouComFechado = abaAbertaEm(c16) === 'aba-2';
      await c16.abrirAba('aba-1');
      porIdDe(c16, idDialogo).open = true;
      dispararTecla(c16, { key: 'j', code: 'KeyJ', altKey: true });
      tudoOk &= ok(trocouComFechado && abaAbertaEm(c16) === 'aba-1',
        `<dialog id="${idDialogo}"> fechado o atalho funciona, aberto bloqueia (está em DIALOGOS)`);
    }

    // 17 — todo <input>/<textarea>/<select> mora DENTRO de algum <dialog>. Caixa de envio
    // por painel (2026-09-09, D42): o <textarea> e o <input type="file"> da caixa de
    // escrita SAÍRAM do HTML — nascem por `createElement` dentro de `criarPainel`, sem
    // `id` nenhum (§3.2 da spec). Fora de <dialog> o `index.html` passa a ter ZERO campos.
    const faixasDialog = [];
    const reDialog = /<dialog[^>]*>[\s\S]*?<\/dialog>/g;
    let mDialog;
    while ((mDialog = reDialog.exec(htmlDialogos))) faixasDialog.push([mDialog.index, mDialog.index + mDialog[0].length]);
    const dentroDeAlgumDialog = (pos) => faixasDialog.some(([ini, fim]) => pos >= ini && pos < fim);
    const reCampo = /<(input|textarea|select)\b[^>]*>/g;
    const camposForaDeDialog = [];
    let mCampo;
    while ((mCampo = reCampo.exec(htmlDialogos))) {
      if (dentroDeAlgumDialog(mCampo.index)) continue;
      const idm = mCampo[0].match(/\bid="([^"]+)"/);
      camposForaDeDialog.push(idm ? idm[1] : '(sem id)');
    }
    tudoOk &= ok(camposForaDeDialog.length === 0,
      `fora de <dialog> não há campo nenhum — sobrando: ${camposForaDeDialog.join(', ') || 'nenhum'}`);

    // 18 — leitura defensiva pelo validador único (§3.5.3): descarta ENTRADA POR ENTRADA,
    // nunca o objeto inteiro, e as chaves boas do mesmo objeto sobrevivem.
    {
      const guardadoRuim = memoria();
      guardadoRuim.setItem('cockpit-atalhos', '{ isto não é json');
      const cRuim = carregarCliente({ guardado: guardadoRuim });
      let estourouLeitura = false;
      let mapaComJsonRuim;
      try { mapaComJsonRuim = cRuim.mapaAtual(); } catch { estourouLeitura = true; }
      tudoOk &= ok(!estourouLeitura, 'JSON inválido em cockpit-atalhos não derruba a leitura');
      tudoOk &= ok(mapaComJsonRuim && mapaComJsonRuim.get('Alt+J') === 'aba-seguinte',
        'e os cinco padrões de fábrica continuam valendo');

      const guardadoMisto = memoria();
      guardadoMisto.setItem('cockpit-atalhos', JSON.stringify({
        'aba-anterior': 'J',              // tecla nua — descartada
        'aba-seguinte': 'Ctrl+Alt+J',     // AltGr — descartada
        'focar-caixa': 'Meta+K',          // só Meta — descartada
        'id-que-nao-existe-mais': 'Alt+Z', // id desconhecido — nunca é lido
        'config': 42,                     // valor não-string — descartada
        'lista': 'Alt+M',                 // válida — sobrevive
      }));
      const cMisto = carregarCliente({ guardado: guardadoMisto });
      const mapaMisto = cMisto.mapaAtual();
      tudoOk &= ok(mapaMisto.get('Alt+K') === 'aba-anterior', 'tecla nua ("J") descartada — cai no padrão Alt+K');
      tudoOk &= ok(mapaMisto.get('Alt+J') === 'aba-seguinte', 'AltGr ("Ctrl+Alt+J") descartada — cai no padrão Alt+J');
      tudoOk &= ok(mapaMisto.get('Alt+C') === 'focar-caixa', 'só Meta ("Meta+K") descartada — cai no padrão Alt+C');
      tudoOk &= ok(mapaMisto.get('Alt+/') === 'config', 'valor não-string (42) descartado — cai no padrão Alt+/');
      tudoOk &= ok(mapaMisto.get('Alt+M') === 'lista', 'e a chave BOA do mesmo objeto sobrevive: lista usa Alt+M');
      tudoOk &= ok(![...mapaMisto.values()].includes('id-que-nao-existe-mais'),
        'id desconhecido no disco nunca é lido — não aparece no mapa');

      tudoOk &= ok(cMisto.motivoDeRecusa('alt+j', new Map()) !== null,
        '"alt+j" (minúsculo, não canônica) é recusada pelo validador único');
      tudoOk &= ok(cMisto.motivoDeRecusa('Alt+Enter', new Map()) !== null,
        '"Alt+Enter" (a caixa já é dona do Enter) é recusada pelo validador único');
      tudoOk &= ok(cMisto.motivoDeRecusa('Alt+TeclaInexistente', new Map()) !== null,
        '"Alt+TeclaInexistente" (nenhum KeyboardEvent produz isto) é recusada pelo validador único');
    }

    // 18b — duplicata no disco: a primeira em ordem de ACOES fica com a tecla, a segunda
    // cai no PRÓPRIO padrão (não em "sem atalho" — o padrão dela está livre)
    {
      const guardado18b = memoria();
      guardado18b.setItem('cockpit-atalhos', JSON.stringify({ 'aba-seguinte': 'Alt+N', 'focar-caixa': 'Alt+N' }));
      const c18b = carregarCliente({ guardado: guardado18b });
      const mapa18b = c18b.mapaAtual();
      tudoOk &= ok(mapa18b.get('Alt+N') === 'aba-seguinte',
        'duplicata no disco: a primeira ação em ordem de ACOES fica com a tecla disputada');
      tudoOk &= ok(mapa18b.get('Alt+C') === 'focar-caixa',
        'a segunda cai no seu PRÓPRIO padrão de fábrica (Alt+C), que estava livre');
      tudoOk &= ok([...mapa18b.values()].filter((id) => id === 'aba-seguinte' || id === 'focar-caixa').length === 2,
        'nenhuma tecla dispara duas ações — cada uma tem exatamente uma entrada no mapa');
    }

    // 18c-mapa — override que rouba o padrão de outra: quem perdeu fica SEM atalho (não
    // realoca, não recicla); a tecla disputada dispara SÓ quem ganhou. (18c-tela — a linha
    // mostrando "—" — é Fase 2.)
    {
      const guardado18c = memoria();
      guardado18c.setItem('cockpit-atalhos', JSON.stringify({ 'aba-seguinte': 'Alt+C' }));
      const rotas18c = [];
      const c18c = carregarCliente({ guardado: guardado18c, aoBuscar: respostas(rotas18c) });
      await c18c.carregarAbas();
      await c18c.abrirAba('aba-1');
      const mapa18c = c18c.mapaAtual();
      tudoOk &= ok(mapa18c.get('Alt+C') === 'aba-seguinte', 'override rouba o padrão de outra ação e fica com a tecla');
      tudoOk &= ok(![...mapa18c.values()].includes('focar-caixa'),
        'focar-caixa não está no mapa nenhum — ficou SEM atalho, não roubou tecla de volta');
      dispararTecla(c18c, { key: 'c', code: 'KeyC', altKey: true });
      tudoOk &= ok(abaAbertaEm(c18c) === 'aba-2', 'Alt+C agora dispara SÓ aba-seguinte');
    }

    // 18d — pularAba nos três casos do §3.2
    {
      const c18d1 = carregarCliente();
      let estourou18d = false;
      try { c18d1.pularAba(1); } catch { estourou18d = true; }
      tudoOk &= ok(!estourou18d, 'pularAba com abasDoTerminal vazio não estoura');
      tudoOk &= ok(c18d1.fluxos.length === 0, 'e não abre fluxo nenhum — não há para onde ir');

      const rotas18d = [];
      const c18d2 = carregarCliente({ aoBuscar: respostas(rotas18d) });
      await c18d2.carregarAbas();
      c18d2.pularAba(1);
      tudoOk &= ok(abaAbertaEm(c18d2) === 'aba-1',
        'nenhuma aba aberta (atual fora da lista): pularAba abre a PRIMEIRA');

      await c18d2.abrirAba('aba-3');
      c18d2.pularAba(1);
      tudoOk &= ok(abaAbertaEm(c18d2) === 'aba-3', 'na última aba, pularAba(+1) grampeia — não circula');
    }

    // 19 — [não-regressão] Enter continua enviando, Shift+Enter continua quebrando linha.
    // Já verde hoje (app.js:2802-2838 não muda); o valor desta trava é ficar VERMELHA se
    // alguém encostar no keydown da caixa e recriar as colisões 5.2/5.3.
    const c19 = await novoCliente();
    const caixa19 = porIdDe(c19, 'entrada');
    caixa19.value = 'oi';
    let barrado19 = false;
    caixa19.disparar('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => { barrado19 = true; } });
    tudoOk &= ok(barrado19 === true, '[não-regressão] Enter na caixa continua enviando (preventDefault + envia)');
    caixa19.value = 'oi';
    let barrado19b = false;
    caixa19.disparar('keydown', { key: 'Enter', shiftKey: true, preventDefault: () => { barrado19b = true; } });
    tudoOk &= ok(barrado19b === false, '[não-regressão] Shift+Enter continua quebrando linha, sem enviar');
  });

  // ── Atalhos de teclado — a tela ───────────────────────────────────────────────
  //
  // 8b, 12, 12b-12g, 13, 14, 15 e 18c-tela da §4.1 — as que a Fase 2 do plano traz o código
  // de. As de HTML (16, 17) e de mapa (18, 18b, 18c-mapa, 18d) já estão verdes desde a Fase 1.
  console.log('\n  · atalhos de teclado — a tela');
  await rodarGrupo('atalhos de teclado — a tela', async () => {
    const TRES_ABAS_TELA = () => ([
      { chave: 'aba-1', titulo: 'um', cwd: '/tmp/um', temClaude: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 },
      { chave: 'aba-2', titulo: 'dois', cwd: '/tmp/dois', temClaude: true, rodando: false, sessaoId: 's2', atualizadoEm: 2 },
      { chave: 'aba-3', titulo: 'tres', cwd: '/tmp/tres', temClaude: true, rodando: false, sessaoId: 's3', atualizadoEm: 3 },
    ]);
    const respostasTela = (rotas) => (rota) => {
      rotas.push(String(rota));
      if (/\/turnos/.test(String(rota))) return { enviado: true };
      if (String(rota).startsWith('api/abas')) return { abas: TRES_ABAS_TELA() };
      return { painel: true, jobs: [] };
    };
    const novoClienteTela = async () => {
      const cli = carregarCliente({ aoBuscar: respostasTela([]) });
      await cli.carregarAbas();
      await cli.abrirAba('aba-1');
      return cli;
    };
    const dispararTeclaTela = (cli, propriedades) => {
      const base = {
        key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        repeat: false, target: porIdDe(cli, 'entrada'),
        preventDefault() {}, getModifierState() { return false; },
      };
      const evento = { ...base, ...propriedades };
      for (const fn of cli.ouvintes.get('keydown') || []) fn(evento);
      return evento;
    };
    const teclaNaLinha = (propriedades) => ({
      ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false,
      preventDefault() {}, getModifierState() { return false; }, ...propriedades,
    });
    const abaAbertaEmTela = (cli) => {
      const ultimo = cli.fluxos[cli.fluxos.length - 1];
      if (!ultimo) return null;
      const m = String(ultimo.rota).match(/^api\/eventos\?abas=([\w-]+)/);
      return m ? m[1] : null;
    };
    const linhaDe = (cli, id) => porIdDe(cli, 'atalhos-lista').querySelector(`[data-acao="${id}"]`);
    const guardadoDe = (cli) => JSON.parse(cli.localStorage.getItem('cockpit-atalhos') || '{}');

    // 8b — Alt+/ abre E monta a lista (8a, "só abre", já está verde desde a Fase 1)
    const c8b = await novoClienteTela();
    dispararTeclaTela(c8b, { key: '/', code: 'Slash', altKey: true });
    tudoOk &= ok(porIdDe(c8b, 'atalhos-lista').children.length === 5,
      'Alt+/ também MONTA a lista de atalhos — 5 linhas, uma por ação');

    // 12 — o fluxo inteiro da captura, do clique ao atalho novo funcionando
    const c12 = await novoClienteTela();
    c12.abrirConfig();
    tudoOk &= ok(linhaDe(c12, 'aba-seguinte').textContent === 'Alt+J',
      'a linha de aba-seguinte começa mostrando o padrão de fábrica (Alt+J)');
    linhaDe(c12, 'aba-seguinte').onclick();
    tudoOk &= ok(linhaDe(c12, 'aba-seguinte').textContent === 'aperte a combinação…',
      'clicar na linha entra em modo captura');
    linhaDe(c12, 'aba-seguinte').disparar('keydown', teclaNaLinha({ key: 'n', code: 'KeyN', altKey: true }));
    tudoOk &= ok(guardadoDe(c12)['aba-seguinte'] === 'Alt+N', 'grava {"aba-seguinte":"Alt+N"} no localStorage');
    tudoOk &= ok(linhaDe(c12, 'aba-seguinte').textContent === 'Alt+N', 'e o botão passa a mostrar Alt+N');
    // A guarda 3 (painel aberto) bloqueia QUALQUER atalho global — fechar é o que faz o
    // usuário de verdade antes de usar o atalho novo. `.close()` (não `.disparar`) também
    // marca `.open = false`, como o navegador faz de verdade.
    porIdDe(c12, 'dialogo-config').close();
    dispararTeclaTela(c12, { key: 'n', code: 'KeyN', altKey: true });
    tudoOk &= ok(abaAbertaEmTela(c12) === 'aba-2', 'Alt+N agora troca de aba');
    dispararTeclaTela(c12, { key: 'j', code: 'KeyJ', altKey: true });
    tudoOk &= ok(abaAbertaEmTela(c12) === 'aba-2', 'e Alt+J não — a tecla velha ficou livre, sem dono');

    // 12b — o fechamento NATIVO (close) não mata os atalhos: capturando zera na hora.
    // `.open = false` + `.disparar('close', {})`: o mock não liga os dois sozinho (só o
    // `.close()` da API muda `.open`) — aqui simulamos os DOIS efeitos do CloseWatcher
    // nativo (#39): a propriedade muda E o evento dispara.
    const c12b = await novoClienteTela();
    c12b.abrirConfig();
    linhaDe(c12b, 'aba-seguinte').onclick();
    porIdDe(c12b, 'dialogo-config').open = false;
    porIdDe(c12b, 'dialogo-config').disparar('close', {});
    dispararTeclaTela(c12b, { key: 'j', code: 'KeyJ', altKey: true });
    tudoOk &= ok(abaAbertaEmTela(c12b) === 'aba-2',
      '[close nativo, sem reabrir o painel] Alt+J volta a funcionar na hora');

    // 12c — capturar de novo o PRÓPRIO padrão remove o override, em vez de gravá-lo igual
    const c12c = await novoClienteTela();
    c12c.abrirConfig();
    linhaDe(c12c, 'aba-seguinte').onclick();
    linhaDe(c12c, 'aba-seguinte').disparar('keydown', teclaNaLinha({ key: 'n', code: 'KeyN', altKey: true }));
    tudoOk &= ok(guardadoDe(c12c)['aba-seguinte'] === 'Alt+N', 'override gravado, para testar a remoção');
    linhaDe(c12c, 'aba-seguinte').onclick();
    linhaDe(c12c, 'aba-seguinte').disparar('keydown', teclaNaLinha({ key: 'j', code: 'KeyJ', altKey: true }));
    tudoOk &= ok(!('aba-seguinte' in guardadoDe(c12c)),
      'capturar de novo o padrão de fábrica (Alt+J) REMOVE o override, não grava igual');

    // 12d — Escape cancela a captura E o painel continua aberto; o Escape seguinte fecha
    // (este teste prova só a metade que é NOSSA: preventDefault + painel aberto + capturando
    // zerado. O segundo Escape fechando é o CloseWatcher nativo, fora do alcance do DOM de
    // mentira.)
    const c12d = await novoClienteTela();
    c12d.abrirConfig();
    linhaDe(c12d, 'lista').onclick();
    let barradoEscape = false;
    linhaDe(c12d, 'lista').disparar('keydown',
      teclaNaLinha({ key: 'Escape', preventDefault: () => { barradoEscape = true; } }));
    tudoOk &= ok(barradoEscape === true, 'Escape na captura é barrado — não deixa o CloseWatcher comer também');
    tudoOk &= ok(porIdDe(c12d, 'dialogo-config').open === true, 'e o painel continua ABERTO');
    // Prova de que `capturando` voltou a `null` SEM depender do atalho global (a guarda 3
    // bloquearia de qualquer jeito enquanto o painel segue aberto, de propósito): a MESMA
    // linha, que só reage a keydown enquanto capturando === o seu próprio id, para de
    // reagir — se ainda estivesse presa em captura, este keydown gravaria Alt+Q.
    const antesDeCancelar12d = c12d.localStorage.getItem('cockpit-atalhos');
    linhaDe(c12d, 'lista').disparar('keydown', teclaNaLinha({ key: 'q', code: 'KeyQ', altKey: true }));
    tudoOk &= ok(c12d.localStorage.getItem('cockpit-atalhos') === antesDeCancelar12d,
      'e a captura foi cancelada de verdade — a mesma linha não reage mais a keydown');

    // 12e — Backspace numa linha cujo padrão está OCUPADO: fica em "—" com a nota, sem
    // roubar a tecla de volta da outra ação
    const guardado12e = memoria();
    guardado12e.setItem('cockpit-atalhos', JSON.stringify({ 'aba-seguinte': 'Alt+C' }));
    const c12e = carregarCliente({ guardado: guardado12e, aoBuscar: respostasTela([]) });
    await c12e.carregarAbas();
    await c12e.abrirAba('aba-1');
    c12e.abrirConfig();
    tudoOk &= ok(linhaDe(c12e, 'focar-caixa').textContent === '—',
      'focar-caixa nasce SEM atalho — Alt+C foi para aba-seguinte');
    linhaDe(c12e, 'focar-caixa').onclick();
    linhaDe(c12e, 'focar-caixa').disparar('keydown', teclaNaLinha({ key: 'Backspace' }));
    tudoOk &= ok(linhaDe(c12e, 'focar-caixa').textContent === '—',
      'Backspace nela: continua em — (o padrão dela, Alt+C, segue ocupado)');
    tudoOk &= ok(/Alt\+C/.test(porIdDe(c12e, 'nota-atalhos').textContent),
      'e a nota diz de quem é a tecla (Alt+C está em Escrever)');
    porIdDe(c12e, 'dialogo-config').close();   // fecha para o atalho global voltar a valer
    dispararTeclaTela(c12e, { key: 'c', code: 'KeyC', altKey: true });
    tudoOk &= ok(abaAbertaEmTela(c12e) === 'aba-2', 'Alt+C continua disparando SÓ aba-seguinte — não voltou');

    // 12f — a11y: aria-live na nota, aria-pressed no botão em captura, aria-label por linha
    const htmlTela = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    tudoOk &= ok(/id="nota-atalhos"[^>]*aria-live="polite"|aria-live="polite"[^>]*id="nota-atalhos"/.test(htmlTela),
      '#nota-atalhos tem aria-live="polite" (mesmo padrão de #faixa-jobs)');
    const c12f = await novoClienteTela();
    c12f.abrirConfig();
    tudoOk &= ok(linhaDe(c12f, 'lista').getAttribute('aria-label') === 'Mostrar/esconder a lista, atalho Alt+L',
      'cada linha tem aria-label com o rótulo da ação e o atalho');
    linhaDe(c12f, 'lista').onclick();
    tudoOk &= ok(linhaDe(c12f, 'lista').getAttribute('aria-pressed') === 'true',
      'o botão em captura ganha aria-pressed="true"');

    // 13 — a captura recusa, cada situação com sua mensagem, e NUNCA grava nada
    const c13 = await novoClienteTela();
    c13.abrirConfig();
    const antesDeTudo13 = c13.localStorage.getItem('cockpit-atalhos');
    linhaDe(c13, 'lista').onclick();
    const tentativas13 = [
      [{ key: 'l', code: 'KeyL' }, 'sem modificador'],
      [{ key: 'Enter', code: 'Enter', altKey: true }, 'Alt+Enter — a caixa já é dona'],
      [{ key: 'F5', code: 'F5', altKey: true }, 'Alt+F5 — o navegador usa'],
      [{ key: '+', code: 'Equal', altKey: true }, 'Alt++ — o + é o separador'],
      [{ key: 't', code: 'KeyT', ctrlKey: true }, 'Ctrl+T — o navegador usa'],
      [{ key: 'k', code: 'KeyK', metaKey: true }, 'Meta+K — só a tecla do sistema'],
      [{ key: 'j', code: 'KeyJ', altKey: true }, 'Alt+J — já é aba-seguinte'],
    ];
    for (const [tecla, rotuloCaso] of tentativas13) {
      linhaDe(c13, 'lista').disparar('keydown', teclaNaLinha(tecla));
      const nota13 = porIdDe(c13, 'nota-atalhos').textContent;
      tudoOk &= ok(Boolean(nota13), `recusa (${rotuloCaso}): a nota explica o motivo ("${nota13}")`);
    }
    tudoOk &= ok(c13.localStorage.getItem('cockpit-atalhos') === antesDeTudo13,
      'e nenhuma das sete recusas gravou nada no localStorage');

    // 14 — Backspace devolve AQUELA linha ao padrão e não mexe nas outras
    const c14 = await novoClienteTela();
    c14.abrirConfig();
    linhaDe(c14, 'aba-anterior').onclick();
    linhaDe(c14, 'aba-anterior').disparar('keydown', teclaNaLinha({ key: 'p', code: 'KeyP', altKey: true }));
    linhaDe(c14, 'lista').onclick();
    linhaDe(c14, 'lista').disparar('keydown', teclaNaLinha({ key: 'x', code: 'KeyX', altKey: true }));
    tudoOk &= ok(guardadoDe(c14)['aba-anterior'] === 'Alt+P' && guardadoDe(c14).lista === 'Alt+X',
      'dois remapeamentos gravados, para provar que o Backspace mexe numa linha só');
    linhaDe(c14, 'aba-anterior').onclick();
    linhaDe(c14, 'aba-anterior').disparar('keydown', teclaNaLinha({ key: 'Backspace' }));
    tudoOk &= ok(!('aba-anterior' in guardadoDe(c14)), 'Backspace devolve AQUELA linha (aba-anterior) ao padrão');
    tudoOk &= ok(guardadoDe(c14).lista === 'Alt+X', 'e NÃO mexe na outra linha — lista continua Alt+X');
    tudoOk &= ok(linhaDe(c14, 'aba-anterior').textContent === 'Alt+K',
      'e a linha volta a mostrar o padrão de fábrica (Alt+K)');

    // 15 — "Voltar ao padrão" apaga a chave inteira e as cinco linhas voltam ao padrão
    const c15 = await novoClienteTela();
    c15.abrirConfig();
    linhaDe(c15, 'lista').onclick();
    linhaDe(c15, 'lista').disparar('keydown', teclaNaLinha({ key: 'x', code: 'KeyX', altKey: true }));
    tudoOk &= ok(guardadoDe(c15).lista === 'Alt+X', 'remapeamento gravado antes do teste do botão');
    porIdDe(c15, 'btn-atalhos-padrao').onclick();
    // A CHAVE, não o objeto. `Object.keys(...).length === 0` aceitava tanto apagar quanto
    // gravar `'{}'`, e foi assim que o desvio passou pelo gate a primeira vez — o painel de
    // execução o pegou lendo o código, não o teste. Agora o teste é que pega.
    tudoOk &= ok(c15.localStorage.getItem('cockpit-atalhos') === null,
      '"Voltar ao padrão" APAGA a chave do localStorage, não grava "{}" por cima');
    tudoOk &= ok(Object.keys(guardadoDe(c15)).length === 0,
      'e o objeto de overrides fica vazio');
    const padroesEsperados15 = { 'aba-anterior': 'Alt+K', 'aba-seguinte': 'Alt+J', 'focar-caixa': 'Alt+C', lista: 'Alt+L', config: 'Alt+/' };
    tudoOk &= ok(Object.entries(padroesEsperados15).every(([id, padrao]) => linhaDe(c15, id).textContent === padrao),
      'e as cinco linhas voltam a mostrar o padrão de fábrica de cada uma');

    // 18c-tela — a linha de quem perdeu a tecla mostra "—" (18c-mapa, o algoritmo, é Fase 1)
    const guardado18cTela = memoria();
    guardado18cTela.setItem('cockpit-atalhos', JSON.stringify({ 'aba-seguinte': 'Alt+C' }));
    const c18cTela = carregarCliente({ guardado: guardado18cTela, aoBuscar: respostasTela([]) });
    await c18cTela.carregarAbas();
    await c18cTela.abrirAba('aba-1');
    c18cTela.abrirConfig();
    tudoOk &= ok(linhaDe(c18cTela, 'aba-seguinte').textContent === 'Alt+C',
      '18c-tela: aba-seguinte mostra a tecla que roubou (Alt+C)');
    tudoOk &= ok(linhaDe(c18cTela, 'focar-caixa').textContent === '—',
      '18c-tela: e focar-caixa, que perdeu, mostra "—"');

    // 12g — no celular (ponteiro grosso) a seção nasce RECOLHIDA, e o botão a abre; no
    // desktop (ponteiro fino) nasce ABERTA e o botão de abrir fica escondido. Sem este par,
    // uma implementação que só recolhe e nunca abre passaria nos outros gates.
    const c12gCelular = await novoClienteTela();
    c12gCelular.midia['(pointer: coarse)'] = true;
    c12gCelular.abrirConfig();
    tudoOk &= ok(porIdDe(c12gCelular, 'atalhos-corpo').hidden === true,
      '12g: ponteiro grosso — #atalhos-corpo nasce recolhido (hidden)');
    tudoOk &= ok(porIdDe(c12gCelular, 'btn-atalhos-abrir').hidden === false,
      '12g: e #btn-atalhos-abrir fica visível');
    porIdDe(c12gCelular, 'btn-atalhos-abrir').onclick();
    tudoOk &= ok(porIdDe(c12gCelular, 'atalhos-corpo').hidden === false,
      '12g: clicar no botão revela o corpo');
    const c12gDesktop = await novoClienteTela();
    c12gDesktop.abrirConfig();
    tudoOk &= ok(porIdDe(c12gDesktop, 'atalhos-corpo').hidden === false,
      '12g: ponteiro fino — a seção já nasce ABERTA');
    tudoOk &= ok(porIdDe(c12gDesktop, 'btn-atalhos-abrir').hidden === true,
      '12g: e o botão de abrir fica escondido');
  });

  // ── Configuração num painel, e a dica que diz a verdade ─────────────────────
  //
  // No celular a lateral É a tela da lista, e o rodapé dela carregava quatro controles fixos:
  // a altura que eles comiam saía da LISTA DE ABAS, que é a razão de o cockpit existir. Eles
  // viraram um painel atrás de uma engrenagem. O que este bloco protege não é o desenho — é
  // que nada se desligou na mudança, e que o voltar do Android continua fazendo UMA coisa por
  // toque.
  // ── O effort GLOBAL: config do CLI, não o .jsonl (24/08) ───────────────────
  //
  // Duas fontes, e cada controle é alimentado por UMA delas. O chip do medidor mostra o
  // effort DAQUELA CONVERSA (vem do `.jsonl`, é histórico, e está certo assim). O select do
  // painel de Configuração mostra o effort GLOBAL DE AGORA, que mora em `effortLevel` na
  // config do próprio CLI. Ligar o select no `.jsonl` faria trocar de aba mudar o que o
  // painel diz ser o padrão global — mentira sobre alcance, que é o R9 da spec.
  console.log('\n  · o effort global, lido da config do CLI');

  // MUDANÇA — o oráculo é escrito AQUI, no teste, de propósito: teste que chama a função que
  // está testando não prova nada. Ele lê os caminhos REAIS, na ordem real.
  const oraculoEffort = async () => {
    for (const arquivo of [
      path.join(os.homedir(), '.claude', 'settings.local.json'),
      path.join(os.homedir(), '.claude', 'settings.json'),
    ]) {
      try {
        const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
        if (typeof dados.effortLevel === 'string') return dados.effortLevel;
      } catch { /* não existe, ou não é JSON: tenta o próximo */ }
    }
    return null;
  };
  const esperadoEffort = await oraculoEffort();
  const daFuncao = typeof contexto.effortConfigurado === 'function'
    ? await contexto.effortConfigurado()
    : undefined;
  tudoOk &= ok(daFuncao === esperadoEffort,
    `effortConfigurado bate com o oráculo escrito no teste (${JSON.stringify(daFuncao)} vs ${JSON.stringify(esperadoEffort)})`);

  // MUDANÇA — a lista de caminhos tem UM dono. Uma segunda cópia dela é a próxima coisa a
  // ficar velha calada (#40), e é o motivo de esta asserção ser de FONTE e não de valor.
  const fonteContexto = fs.readFileSync(path.join(__dirname, '..', 'lib', 'contexto.js'), 'utf8');
  const ocorrenciasDoCaminho = (fonteContexto.match(/path\.join\(os\.homedir\(\), '\.claude'/g) || []).length;
  const blocoEffortConfig = fonteContexto.slice(fonteContexto.indexOf('function effortConfigurado'));
  tudoOk &= ok(ocorrenciasDoCaminho === 2
    && /CONFIGS_DO_CLI/.test(blocoEffortConfig.slice(0, 600)),
  `effortConfigurado não duplica CONFIGS_DO_CLI — a lista de caminhos tem um dono só (${ocorrenciasDoCaminho} ocorrências)`);

  // MUDANÇA — a PRECEDÊNCIA, provada em isolamento. `CONFIGS_DO_CLI` é resolvida no `require`
  // do módulo (via `os.homedir()`), então trocar `HOME` neste processo não muda nada: o único
  // jeito honesto é um processo-filho com `HOME` próprio. Sem isto, a asserção de cima ficaria
  // verde só porque a máquina de hoje tem uma config simples.
  const cenariosEffort = [
    { nome: 'local vence o global', local: '{"effortLevel":"low"}', global: '{"effortLevel":"high"}', espera: 'low' },
    { nome: 'só o global', local: null, global: '{"effortLevel":"high"}', espera: 'high' },
    { nome: 'local inválido cai para o global', local: '{ isto não é JSON', global: '{"effortLevel":"max"}', espera: 'max' },
    { nome: 'nenhum dos dois', local: null, global: null, espera: null },
  ];
  const caminhoDoModulo = path.join(__dirname, '..', 'lib', 'contexto.js');
  let precedenciaOk = true;
  const vistos = [];
  for (const caso of cenariosEffort) {
    const casaFalsa = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-effort-home-'));
    fs.mkdirSync(path.join(casaFalsa, '.claude'));
    if (caso.local !== null) fs.writeFileSync(path.join(casaFalsa, '.claude', 'settings.local.json'), caso.local);
    if (caso.global !== null) fs.writeFileSync(path.join(casaFalsa, '.claude', 'settings.json'), caso.global);
    // O filho pode morrer (é assim que esta asserção nasce vermelha, antes de a função
    // existir). Sem o try, o `execFileSync` derruba a SUÍTE INTEIRA e a prova do vermelho
    // vira uma pilha de asserções que nunca chegaram a rodar.
    let saida;
    try {
      saida = execFileSync(process.execPath, ['-e',
        `require(${JSON.stringify(caminhoDoModulo)}).effortConfigurado()`
        + `.then((v) => console.log(JSON.stringify(v)))`
        + `.catch((e) => console.log(JSON.stringify({ rejeitou: String(e && e.message) })));`,
      ], { env: { ...process.env, HOME: casaFalsa }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (erro) {
      saida = JSON.stringify({ filhoMorreu: String(erro.status) });
    }
    let valor;
    try { valor = JSON.parse(saida); } catch { valor = { saidaCrua: saida }; }
    vistos.push(`${caso.nome}=${JSON.stringify(valor)}`);
    if (valor !== caso.espera) precedenciaOk = false;
  }
  tudoOk &= ok(precedenciaOk,
    `a precedência do settings.local.json sobre o settings.json vale nos quatro cenários (${vistos.join(' | ')})`);
  // O último cenário é também a prova de que a função NÃO REJEITA quando não há config
  // nenhuma: ela resolve com `null`, e é por isso que a rota degrada em vez de cair (#10).

  // MUDANÇA — a rota, pela FONTE (o servidor não é exigível: ele sobe servidor no require).
  // LIMITE DECLARADO: isto NÃO executa o `catch` — não há como fazer `effortConfigurado()`
  // rejeitar de fora, com o servidor no ar, sem inventar injeção de dependência que o card
  // não pede. O que fica provado é que o `catch`, se disparar, responde 200 com nivel null.
  const fonteRotaEffort = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const iRotaEffort = fonteRotaEffort.indexOf("rota === '/api/effort'");
  const blocoRotaEffort = iRotaEffort >= 0 ? fonteRotaEffort.slice(iRotaEffort, iRotaEffort + 800) : '';
  tudoOk &= ok(iRotaEffort >= 0 && /catch/.test(blocoRotaEffort)
    && /nivel: null/.test(blocoRotaEffort)
    && (blocoRotaEffort.match(/\b200\b/g) || []).length >= 2
    && !/\b500\b/.test(blocoRotaEffort.slice(0, blocoRotaEffort.indexOf('/api/push') + 1 || 800)),
  'a rota /api/effort responde 200 mesmo na falha — o painel de Configuração não cai por causa da config do CLI');

  console.log('\n  · configuração num painel só');

  const painel = html.match(/<dialog id="dialogo-config">([\s\S]*?)<\/dialog>/);
  tudoOk &= ok(Boolean(painel), 'existe o <dialog id="dialogo-config">');
  const dentroDoPainel = painel ? painel[1] : '';
  for (const id of ['btn-avisos', 'btn-copiar-acesso', 'btn-plano', 'sel-tema']) {
    tudoOk &= ok(dentroDoPainel.includes(`id="${id}"`), `${id} mora DENTRO do painel`);
  }
  // Seletor e classe, não a palavra: o CSS ainda CITA o rodapé num comentário, contando de
  // onde os quatro controles vieram.
  tudoOk &= ok(!/class="lateral-rodape"/.test(html) && !/\.lateral-rodape\s*\{/.test(css),
    'e o rodapé da lateral saiu de cena — do HTML e do CSS');
  tudoOk &= ok(/class="dialogo-corpo"/.test(dentroDoPainel) && /class="dialogo-acoes"/.test(dentroDoPainel),
    'o painel usa o padrão de <dialog> que o app já tinha, não um segundo jeito de abrir painel');
  // `hidden` no HTML e quem tira é o app.js, depois de perguntar ao navegador se dá para
  // avisar. Dentro do painel isso não pode ter mudado: aparelho sem push mostrando "Ativar
  // notificações" é botão que só sabe falhar.
  tudoOk &= ok(/id="btn-avisos"[^>]*\shidden/.test(dentroDoPainel),
    'btn-avisos continua nascendo escondido');
  // A lista da lateral vai até embaixo agora; a faixa segura do celular era reserva do rodapé.
  tudoOk &= ok(/\.conversas\s*\{[^}]*env\(safe-area-inset-bottom\)/.test(blocoCelular),
    'a lista de abas reserva a faixa segura do celular no fim da rolagem');
  // Alvo de dedo: a engrenagem é a única porta do painel, e `.icone-so` sozinho dá 25px.
  tudoOk &= ok(/\.engrenagem\s*\{[^}]*min-height:\s*40px/.test(css),
    'a engrenagem tem os 40px de toque que a Apple e o Google pedem');

  // Com token guardado: é ele que tem que aparecer no link copiado.
  const guardadoConf = memoria();
  guardadoConf.setItem('cockpit-token', 'abc123');
  const conf = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: guardadoConf });
  const dlgConf = porIdDe(conf, 'dialogo-config');
  tudoOk &= ok(dlgConf.open === false, 'o painel nasce fechado');
  tudoOk &= ok(typeof porIdDe(conf, 'btn-config').onclick === 'function', 'a engrenagem tem dono no JS');
  porIdDe(conf, 'btn-config').onclick();
  tudoOk &= ok(dlgConf.open === true, 'e o clique nela ABRE o painel');
  porIdDe(conf, 'btn-fechar-config').onclick();
  tudoOk &= ok(dlgConf.open === false, 'o Fechar do painel fecha');

  // (a) Os quatro continuam LIGADOS. O `btn-avisos` é conferido por identidade porque o
  // caminho dele encosta na API de notificação, que não existe fora do navegador.
  porIdDe(conf, 'btn-config').onclick();
  porIdDe(conf, 'btn-plano').onclick();
  tudoOk &= ok(porIdDe(conf, 'dialogo-plano').open === true,
    'o Consumo do plano continua abrindo o painel dele, agora de dentro da configuração');
  await respirar();
  tudoOk &= ok(porIdDe(conf, 'uso-plano-lista').filhos.length > 0,
    'e continua buscando os números — o clique faz o que fazia antes');
  tudoOk &= ok(porIdDe(conf, 'btn-avisos').onclick === conf.ligarAvisos,
    'o Ativar notificações continua ligado em ligarAvisos');
  tudoOk &= ok(typeof porIdDe(conf, 'btn-copiar-acesso').onclick === 'function',
    'o Copiar link de acesso continua com dono');
  const copiado = [];
  conf.navigator.clipboard = { writeText: async (t) => { copiado.push(t); } };
  porIdDe(conf, 'btn-copiar-acesso').onclick({ currentTarget: porIdDe(conf, 'btn-copiar-acesso') });
  await respirar();
  tudoOk &= ok(copiado.length === 1 && copiado[0].includes('token='),
    'e o clique nele copia o link com o token, como antes');

  // (c) Tema aplica NA HORA, com o painel ainda aberto. Tema que só valesse ao fechar seria
  // pior do que estava.
  const seletorTema = porIdDe(conf, 'sel-tema');
  tudoOk &= ok(seletorTema.filhos.length === 11,
    `o painel monta os onze temas no <select> (${seletorTema.filhos.length})`);
  seletorTema.value = 'nord';
  seletorTema.onchange();
  tudoOk &= ok(dlgConf.open === true, 'o painel continua aberto na hora da escolha');
  tudoOk &= ok(conf.document.documentElement.getAttribute('data-tema') === 'nord',
    'e o tema JÁ está no documento — não espera o painel fechar');
  tudoOk &= ok(porIdDe(conf, 'meta-tema').getAttribute('content') === '#2e3440',
    'inclusive a barra do sistema do Android, que só aceita cor literal');

  // ── A lista de ajustes em dois grupos, por ALCANCE (spec/plano de 04/09) ───
  //
  // HTML pelo TEXTO do arquivo (o DOM de mentira não faz parse de HTML — R2/#40): SVG,
  // classe e estrutura só se provam lendo `public/index.html` de verdade.
  console.log('\n  · a lista de ajustes em dois grupos');

  const SETE_IDS = ['btn-avisos', 'sel-tema', 'btn-atalhos-abrir', 'sel-effort', 'btn-plano', 'btn-uso', 'btn-copiar-acesso'];
  tudoOk &= ok(SETE_IDS.every((id) => dentroDoPainel.includes(`id="${id}"`)),
    'A1: os sete ids (os seis da D32 + btn-atalhos-abrir) moram dentro de #dialogo-config');
  const BOTOES_AJUSTE = ['btn-avisos', 'btn-atalhos-abrir', 'btn-plano', 'btn-uso', 'btn-copiar-acesso'];
  const botoesComAjuste = BOTOES_AJUSTE.every((id) =>
    new RegExp(`class="[^"]*\\bajuste\\b[^"]*"[^>]*id="${id}"`).test(dentroDoPainel));
  const temaComAjuste = /<label class="lateral-tema ajuste">[\s\S]{0,400}?id="sel-tema"/.test(dentroDoPainel);
  const effortComAjusteA1 = /<label class="lateral-effort ajuste">[\s\S]{0,700}?id="sel-effort"/.test(dentroDoPainel);
  tudoOk &= ok(botoesComAjuste && temaComAjuste && effortComAjusteA1,
    'A1: cada um dos sete está dentro de uma .ajuste, inclusive btn-uso');

  const grupos = [...dentroDoPainel.matchAll(/<div class="config-grupo">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  tudoOk &= ok(grupos.length === 2, `A2: há dois .config-grupo (${grupos.length})`);
  const [esteAparelho = '', oServidor = ''] = grupos;
  tudoOk &= ok(/<h3 class="config-grupo-titulo">Este aparelho<\/h3>/.test(esteAparelho)
    && /<h3 class="config-grupo-titulo">O servidor<\/h3>/.test(oServidor),
  'A2: os títulos são "Este aparelho" e "O servidor"');
  const IDS_ESTE_APARELHO = ['btn-avisos', 'sel-tema', 'btn-atalhos-abrir'];
  const IDS_O_SERVIDOR = ['sel-effort', 'btn-plano', 'btn-uso', 'btn-copiar-acesso'];
  tudoOk &= ok(
    IDS_ESTE_APARELHO.every((id) => esteAparelho.includes(`id="${id}"`))
    && IDS_O_SERVIDOR.every((id) => !esteAparelho.includes(`id="${id}"`))
    && IDS_O_SERVIDOR.every((id) => oServidor.includes(`id="${id}"`))
    && IDS_ESTE_APARELHO.every((id) => !oServidor.includes(`id="${id}"`)),
  'A2: cada id está no grupo certo — nenhum dos quatro do servidor em "Este aparelho", e vice-versa');

  tudoOk &= ok(/\.ajuste\s*\{[^}]*min-height:\s*46px/.test(css), 'A3: .ajuste tem min-height: 46px no CSS');
  // A3b — a regra dos 46px existir NÃO basta: `.config-lista .lateral-acao` tem
  // especificidade 0-2-0 contra os 0-1-0 de `.ajuste`, então uma regra antiga de 40px
  // sobrevivendo no arquivo ganharia e a nova nunca disparia — com as duas "certas"
  // isoladamente e o gate de string aprovando as duas (armadilha #30). Foi assim que a
  // primeira rodada da prova de tela mediu `linhas46 = 0` com os 46px escritos no CSS.
  //
  // Aqui a busca é pelo CONFLITO, não pela regra: qualquer bloco que mire dentro da
  // `.config-lista` e declare `min-height` diferente de 46px é o bug de volta.
  const blocosDaLista = [...css.matchAll(/(\.config-lista[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , corpo]) => /min-height/.test(corpo))
    .filter(([, , corpo]) => !/min-height:\s*46px/.test(corpo))
    .map(([, seletor]) => seletor.trim());
  tudoOk &= ok(blocosDaLista.length === 0,
    `A3b: nenhuma regra mais específica rouba o min-height das linhas (${blocosDaLista.join(' | ') || 'nenhuma'})`);

  // A vestimenta (.ajuste) é a parte NOVA — .lateral-tema/.lateral-effort sozinhos já
  // existiam no develop, então checar só a estrutura de sempre nasceria verde sem testar
  // nada desta fase (regra 7 do plano).
  const recorteTemaA4 = (dentroDoPainel.match(/<label class="lateral-tema ajuste">[\s\S]*?<\/label>/) || [''])[0];
  const recorteEffortA4 = (dentroDoPainel.match(/<label class="lateral-effort ajuste">[\s\S]*?<\/label>/) || [''])[0];
  tudoOk &= ok(/<select id="sel-tema"/.test(recorteTemaA4) && /<select id="sel-effort"/.test(recorteEffortA4)
    && /vale para as abas novas/.test(recorteEffortA4),
  'A4: sel-tema e sel-effort continuam <select> dentro das MESMAS <label class="…ajuste">, e o rótulo do effort ainda diz "vale para as abas novas"');

  const totalChevron = (dentroDoPainel.match(/<svg class="ajuste-chevron"/g) || []).length;
  const recortePlano = (dentroDoPainel.match(/<button class="lateral-acao ajuste" id="btn-plano"[\s\S]*?<\/button>/) || [''])[0];
  const recorteUso = (dentroDoPainel.match(/<button class="lateral-acao ajuste" id="btn-uso"[\s\S]*?<\/button>/) || [''])[0];
  tudoOk &= ok(totalChevron === 2 && /ajuste-chevron/.test(recortePlano) && /ajuste-chevron/.test(recorteUso),
    `A5: o chevron aparece exatamente 2 vezes, só em btn-plano e btn-uso (${totalChevron})`);

  // "Não consulta api/limite ao abrir" já valia no develop (era assim que P3 evitava gastar
  // turno mesmo antes desta fase) — sozinho, o assert nasceria verde sem testar nada da
  // fase 1 (regra 7). O que É novo é a linha "Consumo do plano" ter um `#plano-valor` para
  // mostrar a última leitura — por isso os dois entram juntos.
  tudoOk &= ok(dentroDoPainel.includes('id="plano-valor"'),
    'A6: a linha do plano tem #plano-valor para a última leitura conhecida (P3)');
  const rotasA6 = [];
  const clienteA6 = carregarCliente({ aoBuscar: respostasDoCelular(rotasA6), guardado: memoria() });
  porIdDe(clienteA6, 'btn-config').onclick();
  await respirar();
  // R4: a proibição de ontem ("Configuração não chama api/limite") existia só para não
  // gastar turno (P3), e o dado de graça (D-a) não gasta nada — a proibição absoluta
  // impediria justo o que este card pede (#plano-valor com número). O que continua proibido
  // é o ÚNICO caminho que custa: `?forcar=1`.
  tudoOk &= ok(!rotasA6.some((r) => /api\/limite\?forcar=1/.test(r)),
    `A6: abrir a configuração NUNCA chama api/limite?forcar=1 (${rotasA6.join(', ') || 'nenhuma rota'})`);

  // 🔴 Os DOIS gatilhos da Configuração enchem #plano-valor — a engrenagem E o atalho Alt+/
  // (achado do painel: testar só um deixaria o outro quebrado).
  const respostaComSessao = (rota) => (/api\/limite/.test(rota)
    ? {
      itens: [],
      janelas: {
        itens: [{ rotulo: 'Sessão (5h)', usado: 44, reseta: null, resetaEm: null }],
        medidoEmAprox: Date.now(), fonte: 'jobs', plano: null,
      },
      codex: null,
    }
    : { painel: true, jobs: [] });
  const clienteGatilho1 = carregarCliente({ aoBuscar: respostaComSessao, guardado: memoria() });
  porIdDe(clienteGatilho1, 'btn-config').onclick();
  await respirar();
  tudoOk &= ok(porIdDe(clienteGatilho1, 'plano-valor').textContent.includes('44%'),
    `A6b: o clique na engrenagem enche #plano-valor (${porIdDe(clienteGatilho1, 'plano-valor').textContent})`);

  const clienteGatilho2 = carregarCliente({ aoBuscar: respostaComSessao, guardado: memoria() });
  // Caixa de envio por painel (2026-09-09): a `.paleta` nasce `hidden = true` dentro de
  // `criarPainel` (não mais por atributo no `index.html`), então este `= true` é redundante
  // com a produção — mas fica explícito aqui para o teste não depender do padrão de nascença
  // do fixture, só da guarda 4 (§3.6 da spec: pelo CURSOR, `document.activeElement`).
  porIdDe(clienteGatilho2, 'paleta').hidden = true;
  const eventoAltBarra = {
    key: '/', code: 'Slash', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
    repeat: false, target: porIdDe(clienteGatilho2, 'entrada'),
    preventDefault() {}, getModifierState() { return false; },
  };
  for (const fn of clienteGatilho2.ouvintes.get('keydown') || []) fn(eventoAltBarra);
  await respirar();
  tudoOk &= ok(porIdDe(clienteGatilho2, 'dialogo-config').open === true, 'A6b: Alt+/ também abre o painel');
  tudoOk &= ok(porIdDe(clienteGatilho2, 'plano-valor').textContent.includes('44%'),
    `A6b: e TAMBÉM enche #plano-valor (${porIdDe(clienteGatilho2, 'plano-valor').textContent})`);

  const totalAjusteIcone = (dentroDoPainel.match(/<svg class="ajuste-icone"/g) || []).length;
  tudoOk &= ok(totalAjusteIcone === 8, `A9: 8 svg.ajuste-icone dentro do painel (${totalAjusteIcone})`);
  tudoOk &= ok(totalChevron === 2, `A9: 2 svg.ajuste-chevron dentro do painel (${totalChevron})`);

  const fonteAjustes = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  tudoOk &= ok(!/\$\('btn-avisos'\)\.textContent/.test(fonteAjustes),
    "A16: app.js não escreve mais em $('btn-avisos').textContent");
  const trechoCopiarAcesso = (fonteAjustes.match(/async function copiarAcesso\([\s\S]*?\n}\n/) || [''])[0];
  tudoOk &= ok(trechoCopiarAcesso.length > 0 && !/botao\.textContent/.test(trechoCopiarAcesso),
    'A16: copiarAcesso não escreve mais em botao.textContent (R2 — a fonte prova, não o comportamento)');

  // A17: o mapa completo mora na FONTE — o caso 'indisponivel' é o único que não depende de
  // ServiceWorker/PushManager/Notification (que o DOM de mentira não modela) e por isso é o
  // único exercitado AO VIVO, abaixo.
  const trechoAvisosValor = (fonteAjustes.match(/idiomaUI\.bind\(\$\('avisos-valor'\)[\s\S]*?\}\[estado\] \|\| ''\)\);/) || [''])[0];
  tudoOk &= ok(
    /ligado:\s*'ligadas'/.test(trechoAvisosValor)
    && /desligado:\s*'desligadas'/.test(trechoAvisosValor)
    && /negado:\s*'bloqueadas'/.test(trechoAvisosValor),
  "A17: os data-estado-aviso viram ligadas/desligadas/bloqueadas na linha (a mesma tabela da P9)");
  const clienteA17 = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: memoria() });
  await clienteA17.pintarBotaoAvisos();
  tudoOk &= ok(porIdDe(clienteA17, 'btn-avisos').hidden === true,
    'A17: indisponivel esconde a linha, como hoje');

  tudoOk &= ok(dentroDoPainel.includes('id="btn-atalhos-abrir"'), 'A18: a linha de Atalhos usa #btn-atalhos-abrir');
  const recorteAtalhos = (dentroDoPainel.match(/<button class="lateral-acao atalhos-abrir ajuste" id="btn-atalhos-abrir"[\s\S]*?<\/button>/) || [''])[0];
  tudoOk &= ok(recorteAtalhos.length > 0 && !/ajuste-chevron/.test(recorteAtalhos),
    'A18: a linha de Atalhos não tem chevron — ela expande no lugar, não abre outra tela');
  const clienteA18 = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: memoria() });
  tudoOk &= ok(typeof porIdDe(clienteA18, 'btn-atalhos-abrir').onclick === 'function',
    'A18: btn-atalhos-abrir tem dono no JS');
  porIdDe(clienteA18, 'btn-atalhos-abrir').onclick();
  tudoOk &= ok(porIdDe(clienteA18, 'atalhos-corpo').hidden === false,
    'A18: o clique continua revelando #atalhos-corpo, como hoje');

  // ── (c2) O nível de esforço: TROCA no painel, e a fonte é a config do CLI ───
  //
  // Este bloco existe para provar UMA coisa acima de todas: o chip do medidor e este select
  // vêm de FONTES DIFERENTES. O chip é o effort daquela CONVERSA (`.jsonl`, histórico); o
  // select é o effort GLOBAL de agora (`GET /api/effort` ← config do CLI). Trocar de conversa
  // muda o chip e NÃO pode mexer no select — se mexesse, o painel exibiria o effort histórico
  // de uma aba como se fosse o padrão global, e a próxima troca "corrigiria" um valor que já
  // valia (R9).
  console.log('\n  · trocar o effort pelo painel de Configuração');

  // HTML pelo TEXTO do arquivo: o DOM de mentira não faz parse de HTML (ver `carregarCliente`),
  // então `<option>` e estrutura se provam lendo o `public/index.html`.
  for (const id of ['sel-effort', 'effort-nota']) {
    tudoOk &= ok(dentroDoPainel.includes(`id="${id}"`), `${id} mora DENTRO do painel de configuração`);
  }
  // Tolerante à classe `.ajuste` que a fase 1 de 04/09 acrescentou (`.lateral-effort` fica,
  // só ganhou vizinha) — sem isto o recorte quebrava sozinho, sem ninguém tocar em opção
  // nenhuma.
  const recorteEffort = (dentroDoPainel.match(/<label class="lateral-effort[^"]*"[\s\S]*?<\/label>/) || [''])[0];
  tudoOk &= ok(['low', 'medium', 'high', 'xhigh', 'max']
    .every((n) => new RegExp(`<option value="${n}"`).test(recorteEffort)),
  'o sel-effort tem as cinco opções estáticas no HTML (low/medium/high/xhigh/max)');
  // O alcance é frase escrita à mão sobre comportamento do CLI que ninguém pergunta em
  // runtime (#40). O gate não consegue provar que ela é verdade — consegue impedir que ela
  // suma ou mude calada, que é o que dá para garantir.
  tudoOk &= ok(/vale para as abas novas/.test(recorteEffort),
    'e o rótulo diz vale para as abas novas — o alcance no lugar onde o dedo está');

  const rotasEffort = [];
  let corpoDoEffort = { nivel: 'high' };
  let respostaDoPost = { enviado: true };
  const respostasEffort = (rota, opcoes) => {
    rotasEffort.push({ rota: String(rota), opcoes });
    if (/api\/effort/.test(rota)) return corpoDoEffort;
    if (String(rota).startsWith('api/abas/aba-7/turnos')) return respostaDoPost;
    if (/api\/catalogo/.test(rota)) return { itens: [] };
    if (String(rota).startsWith('api/abas')) return { abas: [abaDoCelular()] };
    return { painel: true, jobs: [] };
  };
  const eff = carregarCliente({ aoBuscar: respostasEffort, guardado: memoria() });
  await eff.carregarAbas();
  await eff.abrirAba('aba-7');
  const selEffort = porIdDe(eff, 'sel-effort');
  const notaEffort = porIdDe(eff, 'effort-nota');
  const rotasEffortSo = () => rotasEffort.filter((r) => /api\/effort/.test(r.rota));

  tudoOk &= ok(typeof selEffort.onchange === 'function', 'o sel-effort tem dono no JS');
  // Chamar o `onchange` direto derrubaria a suíte enquanto ele ainda não existe — e a prova
  // do vermelho viraria uma pilha de asserções que nunca rodaram.
  const trocar = async (el) => (typeof el.onchange === 'function' ? el.onchange() : undefined);

  // (1) Abrir o painel consulta o nível GLOBAL e marca o que voltou.
  porIdDe(eff, 'btn-config').onclick();
  await respirar(); await respirar();
  tudoOk &= ok(rotasEffortSo().length === 1 && selEffort.value === 'high',
    `abrir o painel consulta api/effort e marca o nível global (${selEffort.value})`);

  // (2) A TROCA: URL e payload EXATOS. Uma rota, um POST, um texto — sem anexo, sem sobra.
  const antesDoPost = rotasEffort.length;
  selEffort.value = 'xhigh';
  await trocar(selEffort);
  const posts = rotasEffort.slice(antesDoPost).filter((r) => /turnos/.test(r.rota));
  tudoOk &= ok(posts.length === 1 && posts[0].rota === 'api/abas/aba-7/turnos'
    && posts[0].opcoes && posts[0].opcoes.method === 'POST'
    && JSON.parse(posts[0].opcoes.body).texto === '/effort xhigh'
    && JSON.parse(posts[0].opcoes.body).anexos === undefined,
  `o POST do sel-effort tem payload exato (${posts.length ? posts[0].rota : 'nenhum POST'})`);

  // (3) Não há atualização otimista: "enviado" nunca vira "aplicado" sozinho.
  tudoOk &= ok(/enviado/.test(notaEffort.textContent) && !/n[íi]vel global/.test(notaEffort.textContent),
    `o sel-effort não é otimista: a nota diz enviado, não confirma nível (${notaEffort.textContent})`);

  // (4) O ECO dispara a conferência — e a conferência é quem manda. A reconsulta devolve o
  // nível VELHO (foi o que a #21 fez, por exemplo), e o valor escolhido NÃO sobrevive a ela.
  const antesDoEco = rotasEffortSo().length;
  eff.aplicar({ tipo: 'humano', texto: '/effort xhigh' });
  await respirar(); await respirar();
  tudoOk &= ok(rotasEffortSo().length === antesDoEco + 1,
    'o eco dispara a reconsulta do nível global');
  tudoOk &= ok(selEffort.value === 'high',
    `e quando a reconsulta devolve o nível velho, o valor volta para ele (${selEffort.value})`);
  // E a nota CALA quando o select já está mostrando o nível global: repetir o mesmo valor
  // logo abaixo dele é ruído (25/08). Antes desta regra a nota dizia "nível global:
  // high" com o select em high — o mesmo dado duas vezes, um do lado do outro.
  tudoOk &= ok(notaEffort.textContent === '',
    `e a nota não repete o que o select já diz (nota="${notaEffort.textContent}")`);

  // (5) O 409: a aba recusou. O motivo aparece DENTRO do painel — a fita fica ATRÁS do
  // <dialog> modal, então uma bolha ali nasceria invisível e o usuário só veria o select
  // voltar sozinho, sem explicação.
  const fitaEffort = porIdDe(eff, 'fita');
  const bolhasAntes = fitaEffort.filhos.filter((x) => String(x.className).includes('bolha-erro')).length;
  respostaDoPost = { __status: 409, erro: 'essa aba não está rodando claude' };
  selEffort.value = 'max';
  await trocar(selEffort);
  const bolhasDepois = fitaEffort.filhos.filter((x) => String(x.className).includes('bolha-erro')).length;
  tudoOk &= ok(selEffort.value === 'high'
    && /não está rodando claude/.test(notaEffort.textContent)
    && porIdDe(eff, 'dialogo-config').open === true
    && bolhasDepois === bolhasAntes,
  `o 409 devolve o valor e mostra o motivo no painel, sem bolha na fita (${notaEffort.textContent})`);

  // (6) RESPOSTA VELHA não passa na frente: duas reconsultas no ar, a primeira volta depois
  // da segunda. Quem manda é a mais NOVA, não a última a responder (D-j).
  const resolvedores = [];
  corpoDoEffort = null;   // daqui para baixo, api/effort responde por promessa controlada
  const respostasComFila = (rota, opcoes) => {
    if (/api\/effort/.test(rota)) {
      rotasEffort.push({ rota: String(rota), opcoes });
      return new Promise((resolve) => resolvedores.push(resolve));
    }
    return respostasEffort(rota, opcoes);
  };
  const corrida = carregarCliente({ aoBuscar: respostasComFila, guardado: memoria() });
  await corrida.carregarAbas();
  await corrida.abrirAba('aba-7');
  porIdDe(corrida, 'btn-config').onclick();      // 1ª consulta
  await respirar();
  porIdDe(corrida, 'btn-config').onclick();      // 2ª consulta
  await respirar();
  resolvedores[1] && resolvedores[1]({ nivel: 'max' });    // a mais NOVA volta primeiro
  await respirar(); await respirar();
  resolvedores[0] && resolvedores[0]({ nivel: 'low' });    // a velha volta atrasada
  await respirar(); await respirar();
  tudoOk &= ok(resolvedores.length === 2 && porIdDe(corrida, 'sel-effort').value === 'max',
    `a reconsulta velha não passa na frente da nova (${porIdDe(corrida, 'sel-effort').value})`);

  // (7) SEM ABA ABERTA: o select nasce travado e diz por quê — e a guarda no JS não deixa
  // enviar mesmo se alguém chamar o onchange na mão.
  const rotasSemAba = [];
  const semAba = carregarCliente({
    aoBuscar: (rota, opcoes) => { rotasSemAba.push(String(rota)); return /api\/effort/.test(rota) ? { nivel: 'high' } : { abas: [], painel: true, jobs: [] }; },
    guardado: memoria(),
    semPainel: true,
  });
  await semAba.carregarAbas();
  porIdDe(semAba, 'btn-config').onclick();
  await respirar(); await respirar();
  const selSemAba = porIdDe(semAba, 'sel-effort');
  selSemAba.value = 'max';
  await trocar(selSemAba);
  tudoOk &= ok(selSemAba.disabled === true
    && !rotasSemAba.some((r) => /turnos/.test(r))
    && selSemAba.value === 'high'
    && /abra uma conversa/.test(porIdDe(semAba, 'effort-nota').textContent),
  `o sel-effort não envia sem aba aberta, e a nota diz o motivo (${porIdDe(semAba, 'effort-nota').textContent})`);

  // (8) A PROVA DO R9: chip e select vêm de FONTES DIFERENTES. É a asserção mais importante
  // desta rodada — trocar de conversa muda o CHIP e não encosta no SELECT.
  const antesDaTroca = rotasEffortSo().length;
  eff.aplicar({
    tipo: 'sessao',
    meta: { titulo: 'outra', cwd: '/tmp/o', contexto: { usados: 100, teto: 200000, pct: 0.1, modelo: 'claude-opus-5', esforco: 'low' } },
  });
  const chipDoEff = porIdDe(eff, 'medidor-effort');
  const chipVirouLow = chipDoEff.textContent === 'low' && selEffort.value === 'high';
  eff.aplicar({
    tipo: 'sessao',
    meta: { titulo: 'terceira', cwd: '/tmp/t', contexto: { usados: 200, teto: 200000, pct: 0.1, modelo: 'claude-opus-5', esforco: 'max' } },
  });
  await respirar();
  tudoOk &= ok(chipVirouLow && chipDoEff.textContent === 'max' && selEffort.value === 'high'
    && rotasEffortSo().length === antesDaTroca,
  `chip e select vêm de FONTES DIFERENTES: o chip virou ${chipDoEff.textContent} e o select continua ${selEffort.value}, sem consulta nova`);

  // (d) O voltar do Android com o painel aberto.
  //
  // Modelo do navegador, não do nosso código: `<dialog>` modal aberto transforma o gesto de
  // voltar num pedido de FECHAR (o CloseWatcher) e o consome — sem desempilhar nada. Sem
  // diálogo aberto, voltar é `history.back()`. É por isso que abrir o painel não pode
  // empilhar: a entrada extra sobreviveria ao fechamento e viraria um toque que não faz nada.
  const voltarDoAparelho = (cliente) => {
    const modais = [...cliente.porId.values()].filter((el) => el.open);
    if (modais.length) {
      modais.sort((a, b) => b.abertoEm - a.abertoEm)[0].close();
      return;
    }
    cliente.history.back();
  };

  const cfgHist = carregarCliente({ aoBuscar: respostasDoCelular([]) });
  await cfgHist.carregarAbas();
  await cfgHist.abrirAba('aba-7');
  const appCfg = porIdDe(cfgHist, 'app');
  const pilhaNaConversa = cfgHist.history.pilha.length;
  porIdDe(cfgHist, 'btn-config').onclick();
  tudoOk &= ok(cfgHist.history.pilha.length === pilhaNaConversa,
    'abrir o painel NÃO empilha entrada no histórico');
  voltarDoAparelho(cfgHist);
  tudoOk &= ok(porIdDe(cfgHist, 'dialogo-config').open === false,
    'o voltar do aparelho fecha o painel');
  tudoOk &= ok(appCfg.dataset.vista === 'chat',
    'e a conversa continua aberta — um toque faz UMA coisa');
  tudoOk &= ok(cfgHist.history.pilha.length === pilhaNaConversa,
    'sem gastar entrada da pilha');
  voltarDoAparelho(cfgHist);
  tudoOk &= ok(appCfg.dataset.vista === 'lista',
    'o toque seguinte é que devolve a lista — sem degrau fantasma no meio');
  voltarDoAparelho(cfgHist);
  tudoOk &= ok(cfgHist.history.saiuDoApp === true, 'e o próximo sai do app');

  // (d2) Arquivos num painel só — o NONO <dialog> (spec 2026-09-03, §3.6.3). Catorze
  // asserções: o botão tem dono, abre sem empilhar, o voltar fecha, o rótulo do teto vem do
  // servidor (R15/#40) e, com o XMLHttpRequest de mentira, o envio trava o botão, anda a
  // barra, termina em "chegou" e NÃO é abortado por fechar o painel (R49).
  console.log('\n  · arquivos num painel só');
  const rotasArq = [];
  const respostasDeArquivos = (rota, opcoes) => {
    rotasArq.push(String(rota));
    if (/api\/arquivos\/pastas/.test(rota)) return { pastas: [{ nome: '_triagem' }, { nome: 'projeto-a' }], teto: 2147483648 };
    if (/api\/taildrop\/fila/.test(rota)) return { fila: [] };
    if (/api\/taildrop\/destinos/.test(rota)) return { destinos: [] };
    if (/api\/arquivos\/lista/.test(rota)) return { raiz: 'inbox', caminho: '', itens: [] };
    return respostasDoCelular([])(rota, opcoes);
  };
  const guardadoArq = memoria();
  guardadoArq.setItem('cockpit-token', 'tok-arquivos');
  const arq = carregarCliente({ aoBuscar: respostasDeArquivos, guardado: guardadoArq });
  await arq.carregarAbas();
  await arq.abrirAba('aba-7');
  const appArq = porIdDe(arq, 'app');
  const pilhaArq = arq.history.pilha.length;
  const dialogoArq = porIdDe(arq, 'dialogo-arquivos');
  tudoOk &= ok(typeof porIdDe(arq, 'btn-arquivos').onclick === 'function', 'o botão de arquivos tem dono no JS');
  const rotuloAntes = porIdDe(arq, 'rotulo-arquivo-servidor').textContent;
  if (typeof porIdDe(arq, 'btn-arquivos').onclick === 'function') porIdDe(arq, 'btn-arquivos').onclick();
  await respirar(); await respirar(); await respirar();
  tudoOk &= ok(dialogoArq.open === true && arq.history.pilha.length === pilhaArq,
    'abre pelo <dialog> e não empilha histórico (#39)');
  const estavaAbertoAntesDoVoltar = dialogoArq.open === true;
  voltarDoAparelho(arq);
  tudoOk &= ok(estavaAbertoAntesDoVoltar && dialogoArq.open === false, 'o voltar do aparelho fecha o painel de arquivos');
  tudoOk &= ok(appArq.dataset.vista === 'chat' && arq.history.pilha.length === pilhaArq,
    'e a conversa continua aberta atrás do painel de arquivos — sem gastar entrada da pilha');
  if (typeof porIdDe(arq, 'btn-arquivos').onclick === 'function') porIdDe(arq, 'btn-arquivos').onclick();
  await respirar();
  const estavaAbertoAntesDoFechar = dialogoArq.open === true;
  if (typeof porIdDe(arq, 'btn-fechar-arquivos').onclick === 'function') porIdDe(arq, 'btn-fechar-arquivos').onclick();
  tudoOk &= ok(estavaAbertoAntesDoFechar && dialogoArq.open === false, 'o botão Fechar fecha o painel de arquivos');
  const rotuloDepois = porIdDe(arq, 'rotulo-arquivo-servidor').textContent;
  tudoOk &= ok(!/GB/.test(rotuloAntes) && /GB/.test(rotuloDepois) && rotasArq.some((r) => /api\/arquivos\/pastas/.test(r)),
    `o teto do upload vem do servidor, não do HTML (#40): "${rotuloDepois}"`);

  // O envio, com o XMLHttpRequest de mentira.
  if (typeof porIdDe(arq, 'btn-arquivos').onclick === 'function') porIdDe(arq, 'btn-arquivos').onclick();
  await respirar();
  porIdDe(arq, 'inp-arquivo-servidor').files = [{ name: 'v.mp4', size: 3000000 }];
  const btnMandar = porIdDe(arq, 'btn-mandar-servidor');
  if (typeof btnMandar.onclick === 'function') btnMandar.onclick();
  await respirar();
  const xhr = arq.xhrs[arq.xhrs.length - 1] || { url: '', cabecalhos: {}, upload: {} };
  tudoOk &= ok(xhr.metodo === 'POST' && /pasta=_triagem/.test(xhr.url) && /nome=v\.mp4/.test(xhr.url) && xhr.enviado === true,
    `o XHR abre POST com pasta e nome na URL (${xhr.url})`);
  tudoOk &= ok(xhr.cabecalhos.authorization === 'Bearer tok-arquivos', 'o header authorization sai quando há token');
  const travouDuranteOEnvio = btnMandar.dataset.recarregando === '1';
  tudoOk &= ok(travouDuranteOEnvio, 'o Mandar trava durante o envio');
  if (typeof xhr.upload.onprogress === 'function') xhr.upload.onprogress({ lengthComputable: true, loaded: 1500000, total: 3000000 });
  const progArq = porIdDe(arq, 'prog-arquivo-servidor');
  tudoOk &= ok(progArq.value === 50, `a barra recebe o progresso (${progArq.value})`);
  const notaArq = porIdDe(arq, 'nota-arquivo-servidor');
  tudoOk &= ok(/subindo/.test(notaArq.textContent), `a nota diz subindo ("${notaArq.textContent}")`);
  // R49: fechar o painel no meio do envio NÃO aborta, e reaberto o progresso continua lá.
  if (typeof porIdDe(arq, 'btn-fechar-arquivos').onclick === 'function') porIdDe(arq, 'btn-fechar-arquivos').onclick();
  const abortouAoFechar = xhr.abortado;
  if (typeof porIdDe(arq, 'btn-arquivos').onclick === 'function') porIdDe(arq, 'btn-arquivos').onclick();
  await respirar(); await respirar();
  tudoOk &= ok(abortouAoFechar === false && xhr.abortado === false && progArq.value === 50 && btnMandar.dataset.recarregando === '1',
    'fechar o painel não aborta o envio — reaberto, a barra continua e o Mandar segue travado (R49)');
  xhr.status = 201;
  xhr.responseText = JSON.stringify({ nome: 'v.mp4', bytes: 3000000, pasta: '_triagem' });
  if (typeof xhr.onload === 'function') xhr.onload();
  await respirar(); await respirar();
  tudoOk &= ok(/chegou/.test(notaArq.textContent) && /v\.mp4/.test(notaArq.textContent), `a nota termina com chegou ("${notaArq.textContent}")`);
  tudoOk &= ok(travouDuranteOEnvio && btnMandar.dataset.recarregando !== '1', 'o Mandar destrava no fim');

  // (e) A dica embaixo da caixa diz a verdade do aparelho.
  console.log('\n  · a dica diz a verdade de cada aparelho');
  const dic = carregarCliente({ aoBuscar: respostasDoCelular([]) });
  await dic.carregarAbas();
  const alvoDica = porIdDe(dic, 'dica');
  dic.midia['(pointer: coarse)'] = false;
  await dic.abrirAba('aba-7');
  tudoOk &= ok(/Enter envia/.test(alvoDica.textContent),
    'com ponteiro fino a dica diz que Enter ENVIA');
  tudoOk &= ok(/Shift \+ Enter/.test(alvoDica.textContent), 'e ensina o Shift+Enter da quebra');
  tudoOk &= ok(/Ctrl\+V/.test(alvoDica.textContent) && /repete/.test(alvoDica.textContent),
    'e mantém o ↑ do histórico e o Ctrl+V do print, que existem no teclado físico');

  // O MESMO cliente perde o teclado. Congelada no boot, a frase só se corrigiria recarregando.
  dic.midia['(pointer: coarse)'] = true;
  porIdDe(dic, 'entrada').disparar('keydown', { key: 'a', shiftKey: false, preventDefault: () => {} });
  tudoOk &= ok(/Enter quebra linha/.test(alvoDica.textContent) && !/Enter envia/.test(alvoDica.textContent),
    'com ponteiro grosso ela diz que Enter QUEBRA LINHA');
  tudoOk &= ok(/bot[ãa]o Enviar/i.test(alvoDica.textContent),
    'e aponta o botão Enviar como quem manda a mensagem');
  tudoOk &= ok(!/Ctrl\+V/.test(alvoDica.textContent),
    'e cai o Ctrl+V: no celular não existe Ctrl, colar é segurar e escolher');
  // Teclado de celular pode ter setas — é opção de quem o configura. Cortar o ↑ escondia
  // um atalho que funciona.
  tudoOk &= ok(/repete/.test(alvoDica.textContent),
    'mas a seta ↑ FICA: teclado de celular pode ter setas');
  tudoOk &= ok(/lista comandos/.test(alvoDica.textContent),
    'o `/` fica: dá para digitar com o dedo e escolher tocando');
  tudoOk &= ok(achar(alvoDica, 'kbd').length === 2,
    'a dica do dedo é montada com <kbd> de verdade, não HTML cru (/ e ↑)');
  // Um lugar só. A frase do teclado físico chumbada no HTML foi o que mentiu por um dia:
  // regra derivada do aparelho com legenda escrita à mão se separam calados (armadilha #40).
  tudoOk &= ok(!/Shift \+ Enter/.test(html),
    'e a frase não fica chumbada no HTML — quem a escreve é o cliente, num lugar só');

  // Abrir uma conversa neste aparelho já nasce com a frase certa, sem depender de tecla.
  const dedoDeNascenca = carregarCliente({ aoBuscar: respostasDoCelular([]) });
  dedoDeNascenca.midia['(pointer: coarse)'] = true;
  await dedoDeNascenca.carregarAbas();
  await dedoDeNascenca.abrirAba('aba-7');
  tudoOk &= ok(/Enter quebra linha/.test(porIdDe(dedoDeNascenca, 'dica').textContent),
    'e a conversa já ABRE com a frase certa no aparelho de dedo');

  // Se Enter deixa de enviar no celular, o botão Enviar vira o único caminho: ele não pode
  // sumir em largura nenhuma.
  // Este assert é um TRIPWIRE, não uma prova (caixa de envio por painel, 2026-09-09): nunca
  // houve regra `.btn-enviar`/`.btn-principal` escondendo o botão no `estilo.css`, então ele
  // sempre passou por AUSÊNCIA de correspondência, e continuará passando enquanto ninguém
  // escrever a regra que ele proíbe. A prova de que o botão está visível e legível é o PNG
  // de 6 painéis (risco R4 da spec), onde ele aparece na largura mínima de 320px. O seletor
  // mira classe (`#btn-enviar` saiu do HTML — D42) para o tripwire disparar no dia em que
  // alguém realmente escrever `display: none` mirando o botão.
  tudoOk &= ok(!/\.(btn-enviar|btn-principal)[^{]*\{[^}]*display:\s*none/.test(css),
    'o botão Enviar não é escondido por regra nenhuma do CSS (tripwire — ver PNG de 6 painéis)');
  tudoOk &= ok(!/\.envio[^-{,][^{]*\{[^}]*display:\s*none/.test(blocoCelular),
    'e a barra de envio continua na tela no celular — o botão fica ao alcance do dedo');

  {
  // ── Abrir e fechar abas: os pré-requisitos do módulo ────────────────────────
  //
  // Antes de `criar()` e `matar()` existirem, três coisas precisam estar de pé: o socket
  // por env var (sem ele não existe smoke seguro — o único socket alcançável seria o da
  // `main` do usuário), um executor que ESTOURA em vez de engolir o erro, e uma conta só
  // para a chave da janela.
  console.log('\n  · abas: socket por env var, chave da janela e a leitura do erro do tmux');

  // Sete campos de `list-panes -a`, não os cinco de `list-windows -a`: a lista passou a
  // ser montada por PANE em 31/08, e uma fixture de cinco campos deixaria `pane_id` e
  // `pane_pid` como `undefined` — a chave sairia `aba-pundefined` sem ninguém reparar.
  const LINHA_JANELA = '@7\tmain\t0\tcockpit\t/home/y/projetos/cockpit-agentes\t%7\t4242\n';

  // (a) O socket. `-L` na FRENTE de todo argv, e só quando a env var existe.
  const comSock = await comEspiao(
    { COCKPIT_TMUX_SOCKET: 'cockpit-gate-fake', COCKPIT_TMUX_SESSAO: 'main' },
    [{ saida: '' }, { saida: 'oi' }],
    async (mod, chamadas) => {
      await mod.listar();
      await mod.tela({ chave: 'aba-7', esperando: true, pane: '%1' });
      return chamadas;
    },
  );
  tudoOk &= ok(comSock.length >= 2, `o espião viu os comandos de tmux (${comSock.length})`);
  tudoOk &= ok(comSock.every(([bin, args]) => bin === 'tmux' && args[0] === '-L' && args[1] === 'cockpit-gate-fake'),
    'com COCKPIT_TMUX_SOCKET, TODO argv de tmux começa com -L <socket>');

  const semSock = await comEspiao(
    { COCKPIT_TMUX_SOCKET: '', COCKPIT_TMUX_SESSAO: 'main' },
    [{ saida: '' }, { saida: 'oi' }],
    async (mod, chamadas) => {
      await mod.listar();
      await mod.tela({ chave: 'aba-7', esperando: true, pane: '%1' });
      return chamadas;
    },
  );
  tudoOk &= ok(semSock.length >= 2 && semSock.every(([, args]) => args[0] !== '-L'),
    'sem a env var, NENHUM argv leva -L — vazio é o socket PADRÃO, onde as abas de verdade vivem');

  // (b) A chave. `new-window -P -F` devolve "%1\n": sem o trim a chave vira "aba-p1\n", que
  // não casa o `[\w-]+` da rota (#17) e quebra a URL do DELETE.
  //
  // São DOIS formatos, e a diferença entre eles é DESTRUTIVA: é a chave, e nada mais, que
  // decide `kill-pane` ou `kill-window` no `matarAgora()`. Decidir por detecção em tempo de
  // execução matava o vizinho — o codex da `%71` mora na janela do claude da `%5`.
  const { chaveDaAba, semSessao } = await comEspiao({}, [], async (mod) => ({
    chaveDaAba: mod.chaveDaAba, semSessao: mod.semSessao,
  }));
  tudoOk &= ok(typeof chaveDaAba === 'function' && chaveDaAba({ paneId: '%7\n' }) === 'aba-p7',
    'chaveDaAba({paneId:"%7\\n"}) === "aba-p7" — o \\n do -P não entra na chave');
  tudoOk &= ok(typeof chaveDaAba === 'function' && chaveDaAba({ paneId: '%7' }) === 'aba-p7',
    'e sem \\n dá a mesma coisa: uma conta, um lugar');
  tudoOk &= ok(typeof chaveDaAba === 'function' && chaveDaAba({ janelaId: '@7\n' }) === 'aba-7',
    'sem pane, a chave é a da JANELA — `aba-7`, o formato que vira kill-window');
  tudoOk &= ok(chaveDaAba({ paneId: '%71', janelaId: '@5' }) === 'aba-p71',
    'com os dois, a PANE ganha: uma aba que é pane nunca pode virar kill-window na janela');

  // (c) A ÚNICA leitura de mensagem de erro do projeto — e ela é do TMUX, não nossa. O que
  // não casar cai no genérico (500), nunca no estado do mundo. Timeout é barrado antes.
  const falha = (stderr, killed = false) => Object.assign(new Error(stderr), {
    stderrTmux: stderr, expirou: killed,
  });
  const casos = [
    ['timeout (killed)', falha('no server running on /tmp/x', true), false],
    ['permission denied', falha('permission denied'), false],
    ["can't find session", falha("can't find session: teste"), true],
    ['no server running', falha('no server running on /tmp/tmux-1000/cockpit'), true],
    ['error connecting to', falha('error connecting to /tmp/tmux-1000/x (No such file or directory)'), true],
  ];
  for (const [nome, e, esperado] of casos) {
    tudoOk &= ok(typeof semSessao === 'function' && semSessao(e) === esperado,
      `semSessao(${nome}) === ${esperado}`);
  }

  // A chave das abas passou a ser por PANE. A janela de uma pane só continua saindo como
  // UMA aba — nada some da lista do usuário —, e leva o formato de pane porque a aba É a pane.
  const guardaChave = await comEspiao(
    { COCKPIT_TMUX_SOCKET: '', COCKPIT_TMUX_SESSAO: 'main' },
    [{ saida: LINHA_JANELA }],
    async (mod) => mod.listar(),
  );
  tudoOk &= ok(guardaChave.length === 1 && guardaChave[0].chave === 'aba-p7',
    'listar() devolve chave por PANE (aba-p7), e a janela sem CLI continua virando UMA aba');
  tudoOk &= ok(guardaChave[0]?.pane === '%7',
    'e `aba.pane` é a pane DAQUELA aba — é para lá que o send-keys mira (#6)');
  }

  {
  // ── Abas: criar, matar e a máquina de estados do nascimento ─────────────────
  //
  // Tudo aqui roda no espião: são comandos de tmux e ORDEM de comandos, que não aparecem
  // no retorno de função nenhuma. E roda com um HOME de mentira, para o teste mandar em
  // `temClaude` sem depender do que houver em ~/.claude/sessions da máquina.
  console.log('\n  · abas: criar, matar e a máquina de estados do nascimento');

  const SESSAO_FAKE = 'gate-abas';
  // O `pane_pid` das fixtures e o pid do CLI que roda dentro dela. Números fixos, e de
  // mentira: quem responde por eles é a árvore de /proc abaixo, não o kernel.
  const PANE_PID = 4242;
  const PID_DO_CLI = 4243;
  const PARTIDA = 987654;

  // Uma linha de `list-panes -a`: sete campos, e a PANE é o que decide a chave da aba.
  // Cada janela destas fixtures tem UMA pane, que é o caso da aba recém-criada — e é por
  // isso que a chave dela sai `aba-p<pane>` mesmo sem CLI vivo: a aba É a pane, e o tmux
  // destrói a janela junto ao matar a última pane dela.
  const linhaDeJanela = (id, nome = 'cockpit', pane = '%7', indice = 0, pid = PANE_PID) =>
    `${id}\t${SESSAO_FAKE}\t${indice}\t${nome}\t/home/y/projetos/cockpit-agentes\t${pane}\t${pid}\n`;
  const LISTA_UMA = linhaDeJanela('@7');
  const LISTA_DUAS = linhaDeJanela('@7') + linhaDeJanela('@8', 'outra', '%8', 1);
  // O que `list-panes -s -F '#{pane_id}\t#{window_id}'` devolve para o `matarAgora()`.
  // Duas colunas, não uma: a decisão 404/409 precisa das panes E das janelas.
  const ESTRUTURA_UMA = '%7\t@7\n';
  const ESTRUTURA_DUAS = '%7\t@7\n%8\t@8\n';

  /**
   * Uma `/proc` DE MENTIRA em que a pane das fixtures tem um `claude` em primeiro plano.
   *
   * Ela virou obrigatória quando `listar()` passou a decidir por `detectarAgente()` em vez
   * de só olhar o arquivo de sessão do CLI: sem ela, o `pane_pid` 4242 não existe no /proc
   * real, nenhuma pane tem agente, e toda fixture cairia no ramo da janela sem agente — os
   * casos ficariam verdes descrevendo uma aba que o módulo não produz mais.
   *
   * O `starttime` é o mesmo que o `plantarSessaoCli()` grava em `procStart`: é o par que o
   * `mesmoProcesso()` compara, e plantar um sem o outro deixaria o arquivo de sessão ser
   * descartado como lápide.
   */
  function procComClaude() {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-abas-proc-'));
    const escrever = (pid, { comm, argv, pgrp, tpgid, filhos = [], starttime = 1000 }) => {
      const dir = path.join(raiz, String(pid));
      fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
      const campos = new Array(52).fill('0');
      campos[0] = String(pid);
      campos[1] = `(${comm})`;
      campos[2] = 'S';
      campos[3] = '1';
      campos[4] = String(pgrp);
      campos[5] = String(pgrp);
      campos[6] = '34816';
      campos[7] = String(tpgid);
      campos[21] = String(starttime);
      fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
      fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
      fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), filhos.join(' '));
    };
    // O shell da pane espera (`pgrp !== tpgid`), e o `claude` é filho dele em primeiro
    // plano. É a forma de toda aba real.
    escrever(PANE_PID, { comm: 'bash', argv: ['-bash'], pgrp: PANE_PID, tpgid: PID_DO_CLI, filhos: [PID_DO_CLI] });
    escrever(PID_DO_CLI, { comm: 'claude', argv: ['claude'], pgrp: PID_DO_CLI, tpgid: PID_DO_CLI, starttime: PARTIDA });
    return raiz;
  }

  /** Um HOME de mentira, para o teste mandar no que o CLI "escreveu" em disco. */
  function casaFalsa() {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-abas-'));
    fs.mkdirSync(path.join(raiz, '.claude', 'sessions'), { recursive: true });
    return raiz;
  }

  /**
   * Planta um `~/.claude/sessions/<pid>.json` que o módulo aceita como VIVO.
   *
   * O `mesmoProcesso` confere o instante de partida do pid contra o campo 22 do
   * /proc/<pid>/stat — então o arquivo aponta para ESTE processo, com o procStart de
   * verdade. Inventar o número faria o módulo descartar o arquivo como lápide.
   */
  function plantarSessaoCli(raiz, { janela = '@7', pane = '%7', status = 'idle' } = {}) {
    fs.writeFileSync(path.join(raiz, '.claude', 'sessions', `${PID_DO_CLI}.json`), JSON.stringify({
      kind: 'interactive',
      sessionId: 'sess-gate',
      cwd: '/home/y/projetos/cockpit-agentes',
      status,
      updatedAt: Date.now(),
      pid: PID_DO_CLI,
      procStart: PARTIDA,
      tmux: `${SESSAO_FAKE}:${janela}.${pane}`,
    }));
    return raiz;
  }

  /**
   * A mesma árvore, sem agente nenhum em primeiro plano — só o shell da pane.
   *
   * É o estado REAL da aba recém-criada nos ~1,6 s antes de o CLI subir, e é por isso que os
   * casos da máquina de `nascendo` precisam dela: com um `claude` detectável na árvore, a
   * linha 2 apagaria a entrada na hora e as linhas 3-6 nunca aconteceriam.
   */
  function procSemAgente() {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-abas-proc-vazio-'));
    const dir = path.join(raiz, String(PANE_PID));
    fs.mkdirSync(path.join(dir, 'task', String(PANE_PID)), { recursive: true });
    const campos = new Array(52).fill('0');
    campos[0] = String(PANE_PID);
    campos[1] = '(bash)';
    campos[2] = 'S';
    campos[3] = '1';
    campos[4] = String(PANE_PID);
    campos[5] = String(PANE_PID);
    campos[6] = '34816';
    campos[7] = String(PANE_PID);   // o próprio shell em foreground: não casa agente nenhum
    campos[21] = '111';
    fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
    fs.writeFileSync(path.join(dir, 'cmdline'), '-bash\0');
    fs.writeFileSync(path.join(dir, 'task', String(PANE_PID), 'children'), '');
    return raiz;
  }

  const procDoGate = procComClaude();
  const procVazio = procSemAgente();
  const semAgente = (extra = {}) => ambienteAbas({ COCKPIT_PROC_RAIZ: procVazio, ...extra });
  const ambienteAbas = (extra = {}) => ({
    COCKPIT_TMUX_SOCKET: 'gate-fake',
    COCKPIT_TMUX_SESSAO: SESSAO_FAKE,
    COCKPIT_BIN_CLAUDE: '/bin/sleep',
    COCKPIT_PROC_RAIZ: procDoGate,
    ...extra,
  });

  await rodarGrupo('maquina de estados (§3.3)', async () => {
    // (1) A máquina de estados da §3.3, linhas 3 → 4 → 5 → 6, com carência de 200 ms.
    // Sem mexer em `Date.now`: a carência é que encolhe, e as esperas são reais.
    const casaCarencia = casaFalsa();
    const trilha = await comEspiao(
      semAgente({ HOME: casaCarencia, COCKPIT_CARENCIA_ABA_MS: '200' }),
      [{ saida: '' }, { saida: '%7\n' },
        { saida: LISTA_UMA }, { saida: LISTA_UMA }, { saida: LISTA_UMA },
        { saida: LISTA_UMA }, { saida: LISTA_UMA }],
      async (mod) => {
        const passos = [];
        await mod.criar({ cwd: '/tmp', nome: 'cockpit' });
        const olhar = async (rotulo) => {
          const [aba] = await mod.listar();
          passos.push({ rotulo, nascendo: aba?.nascendo, falhou: aba?.falhou });
        };
        await olhar('dentro da 1a carência');
        await new Promise((r) => setTimeout(r, 250));
        await olhar('estourou a 1a');
        await olhar('dentro da 2a');
        await new Promise((r) => setTimeout(r, 250));
        await olhar('estourou a 2a');
        await olhar('depois de sair do Map');
        return passos;
      },
    );
    const passo = (r) => trilha.find((p) => p.rotulo === r) || {};
    tudoOk &= ok(passo('dentro da 1a carência').nascendo === true && passo('dentro da 1a carência').falhou === false,
      'linha 3: dentro da carência a aba nova diz `nascendo`');
    tudoOk &= ok(passo('estourou a 1a').nascendo === false && passo('estourou a 1a').falhou === true,
      'linha 4: estourou a carência e o relógio REINICIA em `falhou` — não some calado');
    tudoOk &= ok(passo('dentro da 2a').nascendo === false && passo('dentro da 2a').falhou === true,
      'linha 5: a segunda carência segura o "não subiu" na tela');
    tudoOk &= ok(passo('estourou a 2a').nascendo === false && passo('estourou a 2a').falhou === false,
      'linha 6: passada a segunda, a entrada sai e a aba vira aba comum sem claude');
    tudoOk &= ok(passo('depois de sair do Map').nascendo === false && passo('depois de sair do Map').falhou === false,
      'e continua fora: a varredura não ressuscita entrada nenhuma');
    tudoOk &= ok(trilha.every((p) => !(p.nascendo && p.falhou)),
      'exclusão mútua: `nascendo` e `falhou` nunca são verdadeiros juntos');
    tudoOk &= ok(trilha.every((p) => typeof p.nascendo === 'boolean' && typeof p.falhou === 'boolean'),
      'e os dois campos são SEMPRE booleanos, nunca undefined');
    fs.rmSync(casaCarencia, { recursive: true, force: true });

    // (1b) Linha 1: a chave sumiu da lista (aba fechada na mão no terminal) → a entrada morre.
    // Era o vazamento que a varredura por lista de abas não pegava: percorrer o Map é o ponto.
    const casaSumiu = casaFalsa();
    const sumiu = await comEspiao(
      semAgente({ HOME: casaSumiu, COCKPIT_CARENCIA_ABA_MS: '600000' }),
      [{ saida: '' }, { saida: '%7\n' }, { saida: '' }, { saida: LISTA_UMA }],
      async (mod) => {
        await mod.criar({ cwd: '/tmp', nome: 'cockpit' });
        await mod.listar();                    // a janela sumiu: a entrada tem que sair junto
        const [aba] = await mod.listar();      // ela volta, mas o Map já não a conhece
        return aba;
      },
    );
    tudoOk &= ok(sumiu && sumiu.nascendo === false && sumiu.falhou === false,
      'linha 1: chave fora da lista apaga a entrada — o Map não cresce por aba já fechada');
    fs.rmSync(casaSumiu, { recursive: true, force: true });

    // (1c) Linha 2: `temClaude` GANHA de tudo. Mentir aqui abriria a #6 pela porta dos fundos.
    const casaSubiu = plantarSessaoCli(casaFalsa());
    const subiu = await comEspiao(
      ambienteAbas({ HOME: casaSubiu, COCKPIT_CARENCIA_ABA_MS: '600000' }),
      [{ saida: '' }, { saida: '%7\n' }, { saida: LISTA_UMA }],
      async (mod) => {
        await mod.criar({ cwd: '/tmp', nome: 'cockpit' });
        const [aba] = await mod.listar();
        return aba;
      },
    );
    tudoOk &= ok(subiu && subiu.temClaude === true && subiu.nascendo === false && subiu.falhou === false,
      'linha 2: com o claude no ar, `temClaude` apaga `nascendo` e `falhou` na hora');
    fs.rmSync(casaSubiu, { recursive: true, force: true });
  });

  await rodarGrupo('ordem enviar → matar (§5.1.8)', async () => {
    // (2) §5.1 item 8 — a ordem das DUAS filas. `enviar()` e, sem `await`, `matar()`.
    // Os dois `send-keys` do envio terminam ANTES do `kill-window`, sempre: sem isto o
    // segundo send-keys vai para uma janela morta, o tmux leniente devolve '' e o cliente vê
    // `{enviado: true}` para uma mensagem que não existe em lugar nenhum (R13).
    const casaOrdem = plantarSessaoCli(casaFalsa());
    const ordem = await comEspiao(
      ambienteAbas({ HOME: casaOrdem }),
      [{ saida: LISTA_DUAS }, { saida: '' }, { saida: '' },
        { saida: '' }, { saida: ESTRUTURA_DUAS }, { saida: LISTA_DUAS }, { saida: '' }],
      async (mod, chamadas) => {
        const envio = mod.enviar('aba-p7', 'oi');
        const morte = mod.matar('aba-p7');
        await Promise.allSettled([envio, morte]);
        return chamadas.map(([, args]) => args.join(' '));
      },
    );
    const iTexto = ordem.findIndex((c) => /send-keys/.test(c) && /oi/.test(c));
    const iEnter = ordem.findIndex((c) => /send-keys/.test(c) && /Enter/.test(c));
    // `kill-pane`, e é o ponto: a chave `aba-p7` representa uma PANE. `kill-window` aqui
    // levaria a janela inteira junto — o vizinho `%71` incluso (a #42 ao contrário).
    const iMorte = ordem.findIndex((c) => /kill-pane/.test(c));
    tudoOk &= ok(iTexto >= 0 && iEnter > iTexto && iMorte > iEnter,
      `item 8: send-keys texto → send-keys Enter → kill-pane, nessa ordem (${iTexto}, ${iEnter}, ${iMorte})`);
    tudoOk &= ok(iMorte >= 0 && !ordem.slice(iTexto, iEnter).some((c) => /kill-(pane|window)/.test(c)),
      'e a morte NUNCA se intercala entre os dois send-keys');
    tudoOk &= ok(!ordem.some((c) => /kill-window/.test(c)),
      'e chave de PANE nunca vira kill-window — seria matar o vizinho da mesma janela');
    fs.rmSync(casaOrdem, { recursive: true, force: true });
  });

  await rodarGrupo('ordem matar → enviar (§5.1.8b)', async () => {
    // (3) §5.1 item 8b — a ordem INVERSA. `matar()` e, sem `await`, `enviar()`.
    const casaInversa = plantarSessaoCli(casaFalsa());
    const inversa = await comEspiao(
      ambienteAbas({ HOME: casaInversa }),
      [{ saida: '' }, { saida: ESTRUTURA_DUAS }, { saida: LISTA_DUAS }, { saida: '' }, { saida: '' }],
      async (mod, chamadas) => {
        const morte = mod.matar('aba-p7');
        const envio = mod.enviar('aba-p7', 'oi');
        const [r1, r2] = await Promise.allSettled([morte, envio]);
        return { comandos: chamadas.map(([, args]) => args.join(' ')), morte: r1, envio: r2 };
      },
    );
    const jMorte = inversa.comandos.findIndex((c) => /kill-pane/.test(c));
    tudoOk &= ok(jMorte >= 0 && !inversa.comandos.slice(jMorte + 1).some((c) => /send-keys/.test(c)),
      'item 8b: depois do kill-pane não sai send-keys nenhum');
    tudoOk &= ok(inversa.envio.status === 'rejected' && /aba não encontrada/.test(inversa.envio.reason?.message || ''),
      'e o envio pedido depois RECUSA com "aba não encontrada" — nunca `{enviado: true}`');
    fs.rmSync(casaInversa, { recursive: true, force: true });
  });

  await rodarGrupo('binario que e DIRETORIO', async () => {
    // (4) O binário do claude: DIRETÓRIO executável passa no X_OK e não é arquivo. Sem o
    // isFile() o POST responderia 201 e a aba nasceria direto em `falhou`, quando o contrato
    // manda 409 ANTES de criar janela nenhuma.
    const binDir = await comEspiao(
      ambienteAbas({ COCKPIT_BIN_CLAUDE: '/usr/bin' }),
      [{ saida: '' }, { saida: '@7\n' }],
      async (mod, chamadas) => {
        const r = await mod.criar({ cwd: '/tmp', nome: 'x' }).catch((e) => e);
        return { e: r, comandos: chamadas.map(([, args]) => args.join(' ')) };
      },
    );
    tudoOk &= ok(binDir.e instanceof Error && binDir.e.codigo === 409,
      `binário que é DIRETÓRIO recusa com codigo 409 (${binDir.e?.codigo})`);
    tudoOk &= ok(!binDir.comandos.some((c) => /new-window/.test(c)),
      'e nenhuma janela é criada — o espião não vê new-window nenhum');
  });

  await rodarGrupo('binario com metacaractere', async () => {
    // (5) Metacaractere no binário: a regex é fechada, e o que ela recusa nem chega ao disco.
    for (const ruim of ['/bin/sh -c evil', '/bin/claude;rm -rf /', 'claude', '/bin/$(x)claude']) {
      const r = await comEspiao(
        ambienteAbas({ COCKPIT_BIN_CLAUDE: ruim }),
        [{ saida: '' }, { saida: '@7\n' }],
        async (mod, chamadas) => {
          const e = await mod.criar({ cwd: '/tmp', nome: 'x' }).catch((x) => x);
          return { e, criou: chamadas.some(([, a]) => a.join(' ').includes('new-window')) };
        },
      );
      tudoOk &= ok(r.e instanceof Error && r.e.codigo === 409 && !r.criou,
        `binário recusado pela regex, sem criar janela: ${JSON.stringify(ruim)}`);
    }
  });

  await rodarGrupo('classificacao integrada de erro do tmux', async () => {
    // (6) A classificação INTEGRADA. Testar só o `semSessao` deixaria a LIGAÇÃO errada passar
    // verde — é `matar()` e `criar()` que precisam traduzir cada falha do tmux no código
    // certo. Timeout e permissão são falha operacional: rethrow SEM `codigo`, e a rota dá 500.
    const falhasDoTmux = [
      ['timeout', { killed: true, stderr: 'no server running on /tmp/x' }, undefined, undefined],
      ['permission denied', { stderr: 'permission denied' }, undefined, undefined],
      ["can't find session", { stderr: "can't find session: gate-abas" }, 404, 409],
      ['no server running', { stderr: 'no server running on /tmp/tmux-1000/x' }, 404, 409],
      ['error connecting to', { stderr: 'error connecting to /tmp/x (No such file or directory)' }, 404, 409],
    ];
    for (const [nome, falhaTmux, esperadoMatar, esperadoCriar] of falhasDoTmux) {
      const eMatar = await comEspiao(ambienteAbas(), [{ erro: falhaTmux }],
        async (mod) => mod.matar('aba-7').catch((x) => x));
      tudoOk &= ok(eMatar instanceof Error && eMatar.codigo === esperadoMatar,
        `matar() com "${nome}" → codigo ${esperadoMatar} (${eMatar?.codigo})`);
      const eCriar = await comEspiao(ambienteAbas(), [{ erro: falhaTmux }],
        async (mod) => mod.criar({ cwd: '/tmp', nome: 'x' }).catch((x) => x));
      tudoOk &= ok(eCriar instanceof Error && eCriar.codigo === esperadoCriar,
        `criar() com "${nome}" → codigo ${esperadoCriar} (${eCriar?.codigo})`);
    }
  });

  await rodarGrupo('recusas de matarAgora (400/404/409)', async () => {
    // (7) As duas recusas de `matarAgora` que não passam pelo tmux, e a ORDEM entre elas.
    const casaOrdemErro = casaFalsa();
    const chaveRuim = await comEspiao(ambienteAbas({ HOME: casaOrdemErro }), [],
      async (mod) => Promise.all(['aba-x', 'aba-', '', 'aba-7x', 'aba-p', 'aba-px']
        .map((c) => mod.matar(c).catch((e) => e))));
    tudoOk &= ok(chaveRuim.every((e) => e instanceof Error && e.codigo === 400),
      'chave de aba malformada recusa com 400, antes de qualquer comando de tmux');
    // "não existe" vem ANTES de "é a última": numa sessão de uma janela só, uma chave que não
    // existe tem que dar 404, não 409.
    const naoExiste = await comEspiao(ambienteAbas({ HOME: casaOrdemErro }),
      [{ saida: '' }, { saida: ESTRUTURA_UMA }],
      async (mod) => mod.matar('aba-999999').catch((e) => e));
    tudoOk &= ok(naoExiste.codigo === 404, `janela que não existe é 404 mesmo com uma janela só (${naoExiste.codigo})`);
    const paneFantasma = await comEspiao(ambienteAbas({ HOME: casaOrdemErro }),
      [{ saida: '' }, { saida: ESTRUTURA_DUAS }],
      async (mod) => mod.matar('aba-p999999').catch((e) => e));
    tudoOk &= ok(paneFantasma.codigo === 404, `pane que não existe é 404, não 409 (${paneFantasma.codigo})`);
    const ultima = await comEspiao(ambienteAbas({ HOME: casaOrdemErro }),
      [{ saida: '' }, { saida: ESTRUTURA_UMA }, { saida: LISTA_UMA }],
      async (mod, chamadas) => ({
        e: await mod.matar('aba-7').catch((x) => x),
        matou: chamadas.some(([, a]) => /kill-(pane|window)/.test(a.join(' '))),
      }));
    tudoOk &= ok(ultima.e.codigo === 409 && !ultima.matou,
      'e a ÚLTIMA janela da sessão recusa com 409 sem matar nada — a sessão do usuário sobrevive');
    // A mesma guarda pelo lado da pane: `kill-pane` na única pane da única janela também
    // leva a sessão inteira junto (medido em 31/08).
    const ultimaPane = await comEspiao(ambienteAbas({ HOME: casaOrdemErro }),
      [{ saida: '' }, { saida: ESTRUTURA_UMA }, { saida: LISTA_UMA }],
      async (mod, chamadas) => ({
        e: await mod.matar('aba-p7').catch((x) => x),
        matou: chamadas.some(([, a]) => /kill-(pane|window)/.test(a.join(' '))),
      }));
    tudoOk &= ok(ultimaPane.e.codigo === 409 && !ultimaPane.matou,
      'e a ÚNICA pane da ÚNICA janela também é 409 — kill-pane ali mata a sessão junto');
    // O formato da chave manda no COMANDO, e é isto que impede o vizinho de morrer: uma
    // chave de janela nunca pode virar `kill-pane -t %<n>` num `%` que ela não nomeou, e
    // uma chave de pane nunca pode virar `kill-window` na janela em que ela mora.
    const porFormato = await comEspiao(ambienteAbas({ HOME: casaOrdemErro }),
      [{ saida: '' }, { saida: ESTRUTURA_DUAS }, { saida: LISTA_DUAS }, { saida: '' }],
      async (mod, chamadas) => {
        await mod.matar('aba-7').catch(() => {});
        return chamadas.map(([, a]) => a.join(' '));
      });
    tudoOk &= ok(porFormato.some((c) => /kill-window -t @7/.test(c)),
      'chave de JANELA (`aba-7`) vira kill-window -t @7 — o ramo (a) da regra das abas');
    tudoOk &= ok(!porFormato.some((c) => /kill-pane/.test(c)),
      'e NUNCA um kill-pane em %7: chave de janela não nomeia pane nenhuma');
    const porFormatoPane = await comEspiao(ambienteAbas({ HOME: casaOrdemErro }),
      [{ saida: '' }, { saida: ESTRUTURA_DUAS }, { saida: LISTA_DUAS }, { saida: '' }],
      async (mod, chamadas) => {
        await mod.matar('aba-p8').catch(() => {});
        return chamadas.map(([, a]) => a.join(' '));
      });
    tudoOk &= ok(porFormatoPane.some((c) => /kill-pane -t %8/.test(c)),
      'chave de PANE (`aba-p8`) vira kill-pane -t %8 — SEMPRE, nunca kill-window');
    tudoOk &= ok(!porFormatoPane.some((c) => /kill-window/.test(c)),
      'e nenhum kill-window: matar a pane não pode levar a janela do vizinho junto (#42)');
    // E nada de /proc no caminho destrutivo: a decisão sai da chave, não de uma leitura que
    // muda entre o `listar()` que pintou a linha e o DELETE que chega segundos depois. A
    // asserção mira o `list-panes -s` do `matarAgora()`, e só ele — o `listar()` que busca o
    // título é leitura, e ele PRECISA do `pane_pid`.
    const estrutural = porFormatoPane.filter((c) => /list-panes -s/.test(c));
    tudoOk &= ok(estrutural.length === 1,
      `o matarAgora() faz UMA leitura de estrutura, não uma por pergunta (${estrutural.length})`);
    tudoOk &= ok(estrutural.every((c) => !/pane_pid/.test(c)),
      'e ela não pede `#{pane_pid}`: nenhuma varredura de /proc no caminho que destrói');
    fs.rmSync(casaOrdemErro, { recursive: true, force: true });
  });

  await rodarGrupo('GUARDA: as recusas de hoje', async () => {
    // [GUARDA] o que já existia continua igual: as recusas de hoje não afrouxaram.
    const casaGuarda = plantarSessaoCli(casaFalsa(), { status: 'idle' });
    const guardaEnvio = await comEspiao(
      ambienteAbas({ HOME: casaGuarda }),
      [{ saida: LISTA_UMA }, { saida: '' }, { saida: '' }],
      async (mod) => mod.enviar('aba-p7', 'oi').catch((e) => e),
    );
    tudoOk &= ok(guardaEnvio && guardaEnvio.enviado === true,
      '[GUARDA] enviar() numa aba com claude continua entregando');
    const guardaSemClaude = await comEspiao(
      semAgente({ HOME: casaFalsa() }),
      [{ saida: LISTA_UMA }],
      async (mod) => mod.interromper('aba-p7').catch((e) => e),
    );
    tudoOk &= ok(guardaSemClaude instanceof Error && /não tem agente/.test(guardaSemClaude.message),
      '[GUARDA] interromper() sem CLI continua recusando — e a recusa fala de AGENTE, não de claude');
    fs.rmSync(casaGuarda, { recursive: true, force: true });
  });
  }

  // ── Os QUATRO lugares que mentiam nos ~1,6 s de vida da aba nova ────────────
  //
  // Medido: 1562 ms até o CLI escrever `~/.claude/sessions/<pid>.json`. Nesse intervalo
  // `temClaude` é `false` e a aba que o usuário acabou de pedir dizia, em quatro lugares, que
  // está quebrada. É a #40 na veia: texto fixo descrevendo estado que passou a ser
  // transitório. Nenhum quebra; todos mentem, e justo no primeiro uso do recurso.
  //
  // Os quatro CONTINUAM recusando o envio nos dois estados: `temClaude` é `false` nos dois
  // e a trava da #6 não afrouxa em momento nenhum — só o texto muda.
  {
  console.log('\n  · abas: o "abrindo o agente" e o "não subiu" nos quatro lugares');

  const abaNova = (extra = {}) => ({
    chave: 'aba-7', titulo: 'cockpit', cwd: '/home/y/projetos/cockpit-agentes',
    // `temAgente` NÃO entra aqui de propósito: este fixture é o LEGADO, e é ele que
    // exercita o `aba.temAgente ?? aba.temClaude` do cliente. Um fixture que já trouxesse o
    // campo novo deixaria de provar justamente o `??` que existe para ele.
    agente: null, temClaude: false,
    rodando: null, esperando: null, sessaoId: null, atualizadoEm: null,
    nascendo: false, falhou: false, ...extra,
  });
  const telaCom = async (aba) => {
    const c = carregarCliente({
      aoBuscar: (rota) => (String(rota).startsWith('api/abas')
        ? { abas: [aba] } : { painel: true, jobs: [] }),
    });
    await c.carregarAbas();
    return c;
  };
  const fonteServidor = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const abasLibEstado = require('../lib/abas');

  // (1) `motivoDeRecusa` — o item 1 da tabela da §3.4. Recusa nos dois, com texto próprio.
  await rodarGrupo('nascendo/falhou no motivoDeRecusa', async () => {
    const nascendo = abasLibEstado.motivoDeRecusa(abaNova({ nascendo: true }));
    tudoOk &= ok(Boolean(nascendo) && /subindo/.test(nascendo),
      `nascendo: RECUSA e diz que o claude está subindo (${JSON.stringify(nascendo)})`);
    const falhou = abasLibEstado.motivoDeRecusa(abaNova({ falhou: true }));
    tudoOk &= ok(Boolean(falhou) && /não subiu/.test(falhou),
      `falhou: RECUSA e diz que o claude não subiu (${JSON.stringify(falhou)})`);
    tudoOk &= ok(abasLibEstado.motivoDeRecusa(abaNova({ nascendo: true, agente: 'claude', temAgente: true, temClaude: true })) === null,
      'e com o agente no ar o envio passa: `temAgente` é quem manda agora');
  });

  // (2) O evento `erro` do fluxo — item 2 da tabela. `server.js` sobe servidor no `require`,
  // então quem responde "o texto depende do estado?" é o FONTE, como o gate já faz com o
  // HTML e o CSS. Sem isto o texto ficaria fixo e o gate não veria.
  await rodarGrupo('nascendo/falhou no evento de erro do fluxo', async () => {
    const trecho = fonteServidor.slice(
      Math.max(0, fonteServidor.indexOf('não achei o histórico') - 1200),
      fonteServidor.indexOf('não achei o histórico') + 600,
    );
    tudoOk &= ok(/aba\.nascendo/.test(trecho) && /aba\.falhou/.test(trecho),
      'a mensagem do evento consulta `aba.nascendo` e `aba.falhou`, em vez de ser texto fixo');
    tudoOk &= ok(/o histórico aparece assim que ele abrir/.test(trecho),
      'e diz, no nascendo, que o histórico aparece quando o claude abrir');
    tudoOk &= ok(/não há histórico para mostrar/.test(trecho),
      'e, no falhou, que não há histórico para mostrar');
    tudoOk &= ok(/tipo: 'erro'/.test(trecho),
      "e continua `tipo: 'erro'` — é o único tipo que o cliente sabe desenhar");
  });

  // (3) O aviso ao abrir a conversa — item 3 da tabela. MUDOU DE ALVO em 02/09 (PL-3, spec
  // §3.1.2b): os três estados deixaram de virar bolha (o `sessao` do fluxo chama
  // `limparFita()`, e a bolha do `abrirAba` era apagada um instante depois) e passaram a
  // morar em `#aviso-agente`, que sobrevive ao `limparFita`. A `#fita` fica VAZIA nos três —
  // é ela que impede a bolha de voltar por distração.
  await rodarGrupo('nascendo/falhou no aviso de abertura', async () => {
    const cn = await telaCom(abaNova({ nascendo: true }));
    await cn.abrirAba('aba-7');
    const avisoN = porIdDe(cn, 'aviso-agente');
    tudoOk &= ok(avisoN.hidden === false && /Abrindo o agente/.test(avisoN.textContent)
      && !/sem agente rodando/.test(avisoN.textContent) && !avisoN.querySelector('[data-tom="erro"]'),
      `nascendo: o #aviso-agente diz "Abrindo o agente…", neutro (${avisoN.textContent.slice(0, 70)})`);
    tudoOk &= ok(porIdDe(cn, 'fita').textContent === '', 'nascendo: e a #fita fica VAZIA — nenhuma bolha');

    const cf = await telaCom(abaNova({ falhou: true }));
    await cf.abrirAba('aba-7');
    const avisoF = porIdDe(cf, 'aviso-agente');
    tudoOk &= ok(avisoF.hidden === false && /terminal comum/.test(avisoF.textContent)
      && Boolean(avisoF.querySelector('[data-tom="erro"]')),
      `falhou: o #aviso-agente diz "terminal comum", COM data-tom="erro" (${avisoF.textContent.slice(0, 70)})`);
    tudoOk &= ok(porIdDe(cf, 'fita').textContent === '', 'falhou: e a #fita fica VAZIA — nenhuma bolha');
  });

  // (4) O pino e o rodapé da lista — item 4 da tabela. O `⋯` é o SEXTO sinal, e entra entre
  // o `●` e o `○`. Sem cor própria (§3.6): estado de 1,6 s não paga uma variável a mais nos
  // DEZ blocos de tema (#29).
  await rodarGrupo('nascendo/falhou no pino da lista', async () => {
    const cn = await telaCom(abaNova({ nascendo: true }));
    const listaN = porIdDe(cn, 'abas').textContent;
    tudoOk &= ok(listaN.includes('⋯') && /abrindo o agente/.test(listaN) && !listaN.includes('○'),
      `nascendo: pino ⋯ e "abrindo o agente…" (${listaN.replace(/\s+/g, ' ').slice(0, 80)})`);
    const cf = await telaCom(abaNova({ falhou: true }));
    const listaF = porIdDe(cf, 'abas').textContent;
    tudoOk &= ok(listaF.includes('○') && /não subiu/.test(listaF) && !listaF.includes('⋯'),
      `falhou: pino ○ e "o claude não subiu" — nunca ⋯ (${listaF.replace(/\s+/g, ' ').slice(0, 80)})`);
  });

  // (3c) Exclusão mútua e prioridade do agente, vistas pela TELA — não só pelo `listar()`.
  // Mentir aqui faria o `motivoDeRecusa` liberar `send-keys` para um shell: a #6 pela porta
  // dos fundos. E o fixture traz só `temClaude`, de propósito: é o caminho do `??`.
  await rodarGrupo('exclusão mútua e prioridade do agente na tela', async () => {
    const cx = await telaCom(abaNova({ temClaude: true, nascendo: true, falhou: true }));
    const t = porIdDe(cx, 'abas').textContent;
    tudoOk &= ok(!t.includes('⋯') && !/não subiu/.test(t) && !/abrindo o agente/.test(t),
      `com claude no ar a lista ignora nascendo e falhou (${t.replace(/\s+/g, ' ').slice(0, 80)})`);
    const cy = await telaCom(abaNova({ nascendo: true, falhou: true }));
    const ty = porIdDe(cy, 'abas').textContent;
    tudoOk &= ok(ty.includes('⋯') !== ty.includes('não subiu'),
      'e, mesmo recebendo os dois, a tela mostra UM estado só — nunca os dois juntos');
  });

  // [GUARDA] o estado "sem CLI nenhum" não pode sumir: ele deixa de ser o único, não deixa
  // de existir. O que mudou foi a palavra — o cockpit tem dois agentes, e a frase falava de
  // um só.
  await rodarGrupo('GUARDA: a aba sem agente de sempre', async () => {
    const cg = await telaCom(abaNova());
    const t = porIdDe(cg, 'abas').textContent;
    tudoOk &= ok(t.includes('○') && /agente fechado/.test(t),
      '[GUARDA] aba sem agente, sem nascendo e sem falhou, continua ○ + "agente fechado"');
    await cg.abrirAba('aba-7');
    tudoOk &= ok(/sem agente rodando/.test(porIdDe(cg, 'aviso-agente').textContent),
      '[GUARDA] e o aviso de sempre continua aparecendo — agora no #aviso-agente, não na bolha');
    tudoOk &= ok(porIdDe(cg, 'fita').textContent === '', '[GUARDA] e a #fita continua vazia');
  });
  }

  // ── Abrir e fechar aba PELA TELA ────────────────────────────────────────────
  //
  // O `+` no topo da lateral e o fechar no cabeçalho da conversa. O fechar mora ali de
  // propósito: obriga a VER a aba antes de matá-la, e tira o botão destrutivo de uma lista
  // que se rola com o dedo. Toque longo foi descartado — a #31 já ensinou que gesto sem
  // affordance no celular não existe, e aqui o gesto invisível seria o destrutivo.
  {
  console.log('\n  · abrir e fechar aba pela tela');

  const abaDaTela = (extra = {}) => ({
    chave: 'aba-7', titulo: 'cockpit', cwd: '/home/y/projetos/cockpit-agentes',
    temClaude: true, rodando: false, esperando: false, sessaoId: 'sess-tela', atualizadoEm: 1,
    nascendo: false, falhou: false, ...extra,
  });

  /**
   * Cliente com espião de rede: guarda cada chamada (rota + opções) e deixa o teste
   * escolher a resposta por rota. É como se prova que sai UM `POST`, com `{projeto}` e sem
   * `cwd` — e não só que o botão fez alguma coisa.
   */
  const clienteDaTela = ({ projetos = [{ nome: 'projeto-a' }, { nome: 'projeto-b' }], aba = abaDaTela(),
    respostaPost = { chave: 'aba-9', titulo: 'projeto-a' }, respostaDelete = { morta: true } } = {}) => {
    const chamadas = [];
    const c = carregarCliente({
      aoBuscar: (rota, opcoes) => {
        chamadas.push({ rota: String(rota), opcoes: opcoes || {} });
        if (String(rota).startsWith('api/projetos')) return { projetos };
        if (String(rota) === 'api/abas' && (opcoes || {}).method === 'POST') return respostaPost;
        if (/^api\/abas\/[\w-]+$/.test(String(rota)) && (opcoes || {}).method === 'DELETE') return respostaDelete;
        if (String(rota).startsWith('api/abas')) return { abas: [aba] };
        return { painel: true, jobs: [] };
      },
    });
    c.chamadas = chamadas;
    c.posts = () => chamadas.filter((x) => x.rota === 'api/abas' && x.opcoes.method === 'POST');
    c.deletes = () => chamadas.filter((x) => /^api\/abas\/[\w-]+$/.test(x.rota) && x.opcoes.method === 'DELETE');
    c.listas = () => chamadas.filter((x) => x.rota === 'api/abas' && x.opcoes.method === undefined);
    return c;
  };
  const respirarTela = () => new Promise((r) => setImmediate(r));

  /**
   * `alvo` está DENTRO do bloco que começa em `abertura`?
   *
   * Conta `<div>` contra `</div>` do fim da abertura até a ABERTURA da tag alvo. Um regex
   * de "um id depois do outro" passaria verde nos dois desenhos — com o botão dentro e com
   * o botão logo depois do bloco —, e um `[\s\S]*?` até o primeiro `</div>` reprova
   * qualquer bloco que tenha filho, que é o caso aqui.
   */
  const dentroDoBloco = (abertura, alvo) => {
    const i = html.indexOf(abertura);
    const j = html.indexOf(alvo);
    if (i < 0 || j < 0 || j < i) return false;
    const trecho = html.slice(i + abertura.length, j);
    const abre = (trecho.match(/<div\b/g) || []).length;
    const fecha = (trecho.match(/<\/div>/g) || []).length;
    return abre - fecha >= 0;
  };

  /** A chave da conversa que o cliente REALMENTE abriu — pelo EventSource que ele criou. */
  const abaAberta = (c) => {
    const ultimo = c.fluxos[c.fluxos.length - 1];
    const m = ultimo && /api\/eventos\?abas=([\w-]+)/.exec(ultimo.rota);
    return m ? m[1] : null;
  };
  /**
   * A conversa está aberta na tela? Observável, e não uma variável interna do módulo.
   *
   * Split view, fase 2: não há mais `#chat-topo` único que se esconde/mostra — cada
   * conversa aberta é um `.painel` que existe ou não existe no DOM. "Existe painel" É "está
   * na tela" (com um painel só, hoje, os dois sempre coincidem).
   */
  const conversaNaTela = (c) => painelDe(c) !== null;

  // (a) O HTML: os dois botões e os dois diálogos, no padrão que o app já usa.
  await rodarGrupo('os botões e os dois <dialog> novos existem no HTML', async () => {
    tudoOk &= ok(dentroDoBloco('<div class="lateral-topo">', 'id="btn-nova-aba"'),
      'o + mora DENTRO do .lateral-topo, ao lado do recarregar e da engrenagem');
    // Split view, fase 2: `.btn-matar-aba` migrou do HTML para `criarPainel` (app.js) — a
    // prova vira DOM (o botão existe dentro do `.chat-topo` do painel, e NUNCA dentro da
    // lista lateral que se rola com o dedo), não mais fatiamento de texto do HTML.
    const clienteEstruturaMatar = carregarCliente();
    tudoOk &= ok(porIdDe(clienteEstruturaMatar, 'chat-topo').querySelector('.btn-matar-aba') !== null,
      'e o fechar mora DENTRO do cabeçalho da conversa — não na lista que se rola com o dedo');
    tudoOk &= ok(porIdDe(clienteEstruturaMatar, 'abas').querySelector('.btn-matar-aba') === null,
      'e ele fica FORA da lista lateral: ver a aba antes de matá-la é o ponto do lugar dele');
    // A nota de erro tem que estar DENTRO do diálogo: o painel é modal, e recado fora dele
    // nasce atrás, invisível (D32). Isto se prova no FONTE — o DOM de mentira do gate cria
    // elemento para QUALQUER id, então lá os dois ficariam soltos e iguais.
    for (const [dlg, nota] of [['dialogo-nova-aba', 'nota-nova-aba'], ['dialogo-matar-aba', 'nota-matar-aba']]) {
      tudoOk &= ok(dentroDoBloco(`<dialog id="${dlg}">`, `id="${nota}"`),
        `${nota} mora dentro do ${dlg}`);
      tudoOk &= ok(new RegExp(`<small class="config-nota" id="${nota}">`).test(html),
        `e usa o mesmo <small class="config-nota"> do #effort-nota`);
    }
    for (const id of ['dialogo-nova-aba', 'dialogo-matar-aba']) {
      const d = html.match(new RegExp(`<dialog id="${id}">([\\s\\S]*?)</dialog>`));
      tudoOk &= ok(Boolean(d), `existe o <dialog id="${id}">`);
      tudoOk &= ok(Boolean(d) && /class="dialogo-corpo"/.test(d[1]) && /class="dialogo-acoes"/.test(d[1]),
        `${id} usa o padrão .dialogo-corpo + .dialogo-acoes, sem mecanismo novo (D32)`);
    }
    // Dez desde a tela de tokens ter vindo para dentro do app (spec 2026-09-04, fase 2b):
    // os nove de sempre mais o `#dialogo-uso`. Contagem exata, para um <dialog> a mais ou a
    // menos não passar calado.
    tudoOk &= ok((html.match(/<dialog id=/g) || []).length === 10,
      `são DEZ <dialog> agora — os nove de sempre mais #dialogo-uso (${(html.match(/<dialog id=/g) || []).length})`);
    // Os dois são alvo de DEDO, e `.icone-so` sozinho dá 25px — o mesmo motivo que a
    // engrenagem e o recarregar já tinham.
    for (const classe of ['novo', 'fechar-aba']) {
      tudoOk &= ok(new RegExp(`\\.${classe}\\s*\\{[^}]*min-height:\\s*40px`).test(css)
        && new RegExp(`\\.${classe}\\s*\\{[^}]*min-width:\\s*40px`).test(css),
        `.${classe} tem os 40px de toque que a D32 já fixou para a engrenagem`);
      // `.novo` (o "+") continua no index.html; `.fechar-aba` (o ✕) migrou para `criarPainel`
      // na fase 2 do split view — prova por DOM em vez de string do HTML pra esse caso.
      const achaClasse = classe === 'fechar-aba'
        ? porIdDe(clienteEstruturaMatar, 'chat-topo').querySelector(`.${classe}`) !== null
        : new RegExp(`class="[^"]*\\b${classe}\\b[^"]*"`).test(html);
      tudoOk &= ok(achaClasse,
        `e o botão .${classe} está no HTML/DOM com a classe que essa regra alcança (#30)`);
    }
  });

  // (b) §5.1 item 6: sem projeto, o Criar nasce travado e o diálogo EXPLICA.
  await rodarGrupo('lista de projetos vazia trava o Criar e explica', async () => {
    const c = clienteDaTela({ projetos: [] });
    await c.carregarAbas();
    porIdDe(c, 'btn-nova-aba').onclick();
    await respirarTela();
    tudoOk &= ok(porIdDe(c, 'dialogo-nova-aba').open === true, 'o + abre o diálogo');
    tudoOk &= ok(porIdDe(c, 'btn-criar-aba').disabled === true, 'o Criar nasce disabled');
    tudoOk &= ok(/nenhum projeto/i.test(porIdDe(c, 'nota-nova-aba').textContent),
      `e a nota do diálogo diz que não há projeto em ~/projetos (${porIdDe(c, 'nota-nova-aba').textContent})`);
  });

  // (c) §5.1 item 7b: o criar completo. UM POST, com `{projeto}` e SEM `cwd`.
  await rodarGrupo('o criar completo: um POST com {projeto} e sem cwd', async () => {
    const c = clienteDaTela();
    await c.carregarAbas();
    porIdDe(c, 'btn-nova-aba').onclick();
    await respirarTela();
    const sel = porIdDe(c, 'sel-projeto-novo');
    tudoOk &= ok(sel.filhos.length === 2, `o diálogo lista os projetos (${sel.filhos.length})`);
    sel.value = 'projeto-a';
    const listasAntes = c.listas().length;
    porIdDe(c, 'btn-criar-aba').onclick();
    await respirarTela();
    await respirarTela();
    const posts = c.posts();
    tudoOk &= ok(posts.length === 1, `sai UM POST /api/abas (${posts.length})`);
    const corpo = posts.length ? JSON.parse(posts[0].opcoes.body) : {};
    tudoOk &= ok(corpo.projeto === 'projeto-a' && !('cwd' in corpo),
      `e o corpo leva o NOME, nunca caminho: ${JSON.stringify(corpo)}`);
    tudoOk &= ok(porIdDe(c, 'dialogo-nova-aba').open === false, 'o diálogo fecha na resposta');
    tudoOk &= ok(c.listas().length > listasAntes,
      'e a lista recarrega NA HORA, sem esperar o tique de 5s (D21: relógio nenhum novo)');
    tudoOk &= ok(abaAberta(c) === 'aba-9' && conversaNaTela(c),
      `a aba nova já abre — o fluxo dela é o que está no ar (${abaAberta(c)})`);
  });

  // (d) §5.1 item 7: o erro do POST vai DENTRO do diálogo, que continua aberto. O painel é
  // modal — bolha atrás dele nasce invisível (D32).
  await rodarGrupo('erro do POST aparece dentro do diálogo, que não fecha', async () => {
    const c = clienteDaTela({ respostaPost: { __status: 409, erro: 'não há sessão "main" no terminal' } });
    await c.carregarAbas();
    porIdDe(c, 'btn-nova-aba').onclick();
    await respirarTela();
    porIdDe(c, 'sel-projeto-novo').value = 'projeto-a';
    porIdDe(c, 'btn-criar-aba').onclick();
    await respirarTela();
    await respirarTela();
    const dlg = porIdDe(c, 'dialogo-nova-aba');
    tudoOk &= ok(dlg.open === true, 'o diálogo CONTINUA aberto');
    const nota = porIdDe(c, 'nota-nova-aba');
    tudoOk &= ok(/não há sessão/.test(nota.textContent),
      `o recado do servidor aparece na nota de dentro (${nota.textContent})`);
    tudoOk &= ok(porIdDe(c, 'fita').textContent === '',
      'e NÃO vira bolha na fita, que nasceria atrás do painel modal');
  });

  // (e) §5.1 item 7c: dedo duplo no celular (R16). Dois toques com o POST no ar → UM POST.
  await rodarGrupo('dedo duplo no Criar manda UM POST só', async () => {
    const c = clienteDaTela();
    await c.carregarAbas();
    porIdDe(c, 'btn-nova-aba').onclick();
    await respirarTela();
    porIdDe(c, 'sel-projeto-novo').value = 'projeto-a';
    const botao = porIdDe(c, 'btn-criar-aba');
    botao.onclick();
    botao.onclick();
    tudoOk &= ok(botao.dataset.recarregando === '1',
      'com o pedido no ar o botão fica travado — o mesmo data-recarregando do recarregar()');
    await respirarTela();
    await respirarTela();
    tudoOk &= ok(c.posts().length === 1, `dois toques, UM POST (${c.posts().length})`);
    tudoOk &= ok(botao.dataset.recarregando !== '1', 'e ele destrava no fim');

    // E destrava TAMBÉM quando o pedido falha: senão o Criar morre no primeiro erro.
    const cf = clienteDaTela({ respostaPost: { __status: 409, erro: 'deu ruim' } });
    await cf.carregarAbas();
    porIdDe(cf, 'btn-nova-aba').onclick();
    await respirarTela();
    porIdDe(cf, 'sel-projeto-novo').value = 'projeto-a';
    porIdDe(cf, 'btn-criar-aba').onclick();
    await respirarTela();
    await respirarTela();
    tudoOk &= ok(porIdDe(cf, 'btn-criar-aba').dataset.recarregando !== '1',
      'o botão volta a aceitar clique mesmo quando o POST falha');
  });

  // (f) §5.1 item 5: o diálogo de matar escreve O ESTADO, tirado da aba que a lista já tem.
  await rodarGrupo('o diálogo de matar escreve o estado da aba', async () => {
    const linhas = [
      [{ rodando: true }, /TRABALHANDO/],
      [{ esperando: true }, /pergunta aberta/],
      [{}, /encerra o agente/],
      [{ temClaude: false, nascendo: true }, /ainda est[áa] subindo/],
      [{ temClaude: false, falhou: true }, /terminal comum/],
      [{ temClaude: false }, /não tem agente rodando/],
    ];
    for (const [extra, esperado] of linhas) {
      const c = clienteDaTela({ aba: abaDaTela(extra) });
      await c.carregarAbas();
      await c.abrirAba('aba-7');
      porIdDe(c, 'btn-matar-aba').onclick();
      await respirarTela();
      const texto = porIdDe(c, 'matar-aba-estado').textContent;
      tudoOk &= ok(porIdDe(c, 'dialogo-matar-aba').open === true && esperado.test(texto),
        `${JSON.stringify(extra)} → "${esperado}" (${texto.replace(/\s+/g, ' ').slice(0, 90)})`);
    }
  });

  // (g) §5.1 item 7d + R4: o matar completo, e UM `history.back()` só. Dois `back()` sairiam
  // do app — o defeito que a D31 consertou.
  await rodarGrupo('o matar completo, e o removida que chega depois é no-op', async () => {
    const c = clienteDaTela();
    await c.carregarAbas();
    await c.abrirAba('aba-7');
    let voltas = 0;
    const backOriginal = c.history.back;
    c.history.back = (...a) => { voltas += 1; return backOriginal(...a); };
    porIdDe(c, 'btn-matar-aba').onclick();
    await respirarTela();
    const listasAntes = c.listas().length;
    porIdDe(c, 'btn-confirma-matar-aba').onclick();
    await respirarTela();
    await respirarTela();
    tudoOk &= ok(c.deletes().length === 1, `sai UM DELETE /api/abas/aba-7 (${c.deletes().length})`);
    tudoOk &= ok(conversaNaTela(c) === false && porIdDe(c, 'vazio').hidden === false,
      'fecharPainel() rodou: a conversa some e o "escolha uma conversa" volta');
    tudoOk &= ok(painelDe(c) === null, 'e o cabeçalho da conversa some — o painel inteiro saiu do DOM');
    tudoOk &= ok(c.listas().length > listasAntes, 'a lista recarrega na hora');
    tudoOk &= ok(voltas === 1, `UM history.back(), não dois (${voltas})`);
    tudoOk &= ok(porIdDe(c, 'dialogo-matar-aba').open === false, 'e o diálogo de confirmação fecha');

    // O `removida` que o servidor manda em seguida cai no `evento.id === atual` e vira no-op.
    c.aplicar({ tipo: 'removida', id: 'aba-7' });
    await respirarTela();
    tudoOk &= ok(voltas === 1, `o removida que chega depois NÃO desempilha de novo (${voltas})`);
    tudoOk &= ok(c.history.saiuDoApp === false, 'e o app não sai por baixo do fundo da pilha');
  });

  // (h) §5.1 item 7e: o matar que FALHA. Fechar a vista de uma aba que não morreu seria
  // pior que o erro.
  await rodarGrupo('DELETE 409 deixa a conversa aberta e não desempilha nada', async () => {
    const c = clienteDaTela({ respostaDelete: { __status: 409, erro: 'é a última aba do terminal' } });
    await c.carregarAbas();
    await c.abrirAba('aba-7');
    let voltas = 0;
    const backOriginal = c.history.back;
    c.history.back = (...a) => { voltas += 1; return backOriginal(...a); };
    porIdDe(c, 'btn-matar-aba').onclick();
    await respirarTela();
    porIdDe(c, 'btn-confirma-matar-aba').onclick();
    await respirarTela();
    await respirarTela();
    tudoOk &= ok(conversaNaTela(c) === true && porIdDe(c, 'vazio').hidden === true,
      'a conversa CONTINUA aberta — fechar a vista de uma aba que não morreu seria pior que o erro');
    tudoOk &= ok(voltas === 0, `nenhum history.back() aconteceu (${voltas})`);
    const nota = porIdDe(c, 'nota-matar-aba');
    tudoOk &= ok(/última aba/.test(nota.textContent),
      `o recado do servidor aparece (${nota.textContent})`);
    tudoOk &= ok(porIdDe(c, 'dialogo-matar-aba').open === true,
      'e o diálogo fica aberto para ele ler o motivo');
  });

  // [GUARDA] o que já existia: os seis <dialog> de antes continuam abrindo.
  await rodarGrupo('GUARDA: os seis diálogos de antes continuam abrindo', async () => {
    const c = clienteDaTela();
    await c.carregarAbas();
    porIdDe(c, 'btn-config').onclick();
    tudoOk &= ok(porIdDe(c, 'dialogo-config').open === true, '[GUARDA] o painel de configuração abre');
    porIdDe(c, 'btn-plano').onclick();
    tudoOk &= ok(porIdDe(c, 'dialogo-plano').open === true, '[GUARDA] o consumo do plano abre');
    // Tripwire, não prova — ver o comentário do primeiro assert idêntico, mais acima.
    tudoOk &= ok(!/\.(btn-enviar|btn-principal)[^{]*\{[^}]*display:\s*none/.test(css),
      '[GUARDA] o botão Enviar continua visível em toda largura (tripwire)');
  });
  }

  // ── celular: a primeira leva do design (02/09) ──────────────────────────────
  //
  // Bloco novo, no fim da Parte A. As de CSS leem `public/estilo.css` como texto SEM
  // comentários — a lição de `gate-ui.js:2801-2802`: comentário citando a regra faz o teste
  // passar sem a regra existir. As de comportamento rodam o cliente no DOM de mentira, que é
  // o que separa "o CSS diz" de "o app faz".
  console.log('\n  · celular: a primeira leva do design');

  // PL-1 — `.corte-nota` pode encolher (Achado A).
  await rodarGrupo('PL-1: .corte-nota pode encolher', async () => {
    const bloco = (cor.blocos(cssSemComentario) || []).find((b) => b.seletor === '.corte-nota');
    tudoOk &= ok(Boolean(bloco), 'PL-1: a regra .corte-nota existe');
    tudoOk &= ok(Boolean(bloco) && /min-width:\s*0/.test(bloco.corpo) && !/flex:\s*none/.test(bloco.corpo),
      `PL-1: tem min-width:0 e NÃO tem flex:none (${bloco && bloco.corpo})`);
  });

  // PL-2 — o aviso de estado é neutro, o de falha é vermelho, e NENHUMA classe nova nasce
  // (Achado B). `.bolha-info` é proibida por esta entrega (spec §3.1.2): pintaria de cinza
  // algo que o `sessao` já apaga.
  await rodarGrupo('PL-2: o tom do aviso, e a .bolha-info que não pode nascer', async () => {
    const avisoAgente = (cor.blocos(cssSemComentario) || []).find((b) => b.seletor === '.aviso-agente');
    tudoOk &= ok(Boolean(avisoAgente) && /color:\s*var\(--texto-2\)/.test(avisoAgente.corpo),
      'PL-2: .aviso-agente continua em var(--texto-2)');
    const regrasDeErro = (cor.blocos(cssSemComentario) || [])
      .filter((b) => b.seletor === '.aviso-agente [data-tom="erro"]');
    tudoOk &= ok(regrasDeErro.length === 1 && /color:\s*var\(--perigo\)/.test(regrasDeErro[0].corpo),
      `PL-2: EXATAMENTE uma regra .aviso-agente [data-tom="erro"], em var(--perigo) (${regrasDeErro.length})`);
    tudoOk &= ok(!/\.bolha-info\b/.test(cssSemComentario), 'PL-2: nenhuma regra .bolha-info no CSS');
    tudoOk &= ok(!/\.bolha-info\b/.test(fonteBruta), 'PL-2: nenhuma referência a .bolha-info no cliente');
    const fonteServidorPl2 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const trechoServidor = fonteServidorPl2.slice(
      Math.max(0, fonteServidorPl2.indexOf('não achei o histórico') - 1200),
      fonteServidorPl2.indexOf('não achei o histórico') + 600,
    );
    tudoOk &= ok(/nivel:\s*'aviso'/.test(trechoServidor),
      'PL-2: o ramo sem-arquivo do server.js manda nivel: "aviso"');
  });

  // PL-3 — as DUAS metades do `nivel: 'aviso'` na ponta do cliente: com o campo, nenhuma
  // bolha; sem ele, a `.bolha-erro` de sempre. Sem a segunda metade, a linha nova do
  // `case 'erro'` vira um `break` que engoliria erro de verdade.
  await rodarGrupo('PL-3: nivel:"aviso" não cria bolha; erro sem nivel continua criando', async () => {
    const c = carregarCliente({
      aoBuscar: (rota) => (String(rota).startsWith('api/abas') ? { abas: [] } : { painel: true, jobs: [] }),
    });
    c.aplicar({ tipo: 'erro', nivel: 'aviso', mensagem: 'isto é estado, não falha' });
    tudoOk &= ok(porIdDe(c, 'fita').textContent === '',
      'PL-3: aplicar({tipo:"erro", nivel:"aviso"}) NÃO cria bolha na fita');
    c.aplicar({ tipo: 'erro', mensagem: 'isto é falha de verdade' });
    tudoOk &= ok(/isto é falha de verdade/.test(porIdDe(c, 'fita').textContent),
      'PL-3: aplicar({tipo:"erro"}) SEM nivel continua criando a .bolha-erro de sempre');
  });

  // PL-4 — o topo do celular tem duas linhas, e o `↻` saiu dela (Achado C). Lido pelos
  // blocos do `cor.blocos`, que guardam `dentroDe` — é o que separa a regra do celular da
  // regra base sem regex de fatia.
  await rodarGrupo('PL-4: o cabeçalho em duas linhas no celular, e o ↻ fora', async () => {
    const todos = cor.blocos(cssSemComentario) || [];
    const noCelular = todos.filter((b) => b.dentroDe === '@media (max-width: 760px)');
    const foraDoCelular = todos.filter((b) => b.dentroDe !== '@media (max-width: 760px)');
    const quebra = noCelular.find((b) => b.seletor === '.chat-topo::after');
    tudoOk &= ok(Boolean(quebra) && /flex-basis:\s*100%/.test(quebra.corpo),
      'PL-4: .chat-topo::after com flex-basis:100% no bloco de celular — a quebra sem HTML novo');
    const medidorCel = noCelular.find((b) => b.seletor === '.medidor');
    tudoOk &= ok(Boolean(medidorCel) && /\border:\s*\d/.test(medidorCel.corpo),
      'PL-4: .medidor tem order: no bloco de celular');
    const faixaCel = noCelular.find((b) => b.seletor === '.faixa-jobs');
    tudoOk &= ok(Boolean(faixaCel) && /\border:\s*\d/.test(faixaCel.corpo) && !/flex-basis:\s*100%/.test(faixaCel.corpo),
      'PL-4: .faixa-jobs no celular tem order: e NÃO tem flex-basis:100% — divide a linha 2');
    const recarregarCel = noCelular.filter((b) => b.seletor === '.btn-recarregar-conversa');
    tudoOk &= ok(recarregarCel.length === 1 && /display:\s*none/.test(recarregarCel[0].corpo),
      'PL-4: .btn-recarregar-conversa { display: none } em regra PRÓPRIA no bloco de celular');
    // Regra própria = o seletor é SÓ ele; nada agrupado por vírgula com o .medidor (R4).
    tudoOk &= ok(!noCelular.some((b) => b.seletor.includes(',') && b.seletor.includes('.medidor')),
      'PL-4: nenhuma regra do bloco de celular agrupa o .medidor por vírgula');
    tudoOk &= ok(!foraDoCelular.some((b) => b.seletor.split(',').some((p) => p.trim() === '.btn-recarregar-conversa')
      && /display:\s*none/.test(b.corpo)),
    'PL-4: fora do bloco de celular o ↻ da conversa NÃO tem display:none — no desktop ele é o único caminho');
  });

  // PL-5 — a borda ficou reservada ao estado que TRAVA (Achado D): o "te esperando" perde a
  // borda, o "perguntando" fica, e o `[data-nova]` (código morto sinalizado) continua no CSS.
  await rodarGrupo('PL-5: a borda lateral é só do perguntando', async () => {
    const todos = cor.blocos(cssSemComentario) || [];
    const porSeletor = (sel) => todos.filter((b) => b.seletor.split(',').some((p) => p.trim() === sel));
    tudoOk &= ok(!porSeletor('.conversa-linha[data-esperando="1"] .conversa').some((b) => /border-left/.test(b.corpo)),
      'PL-5: [data-esperando="1"] .conversa NÃO tem border-left');
    tudoOk &= ok(porSeletor('.conversa-linha[data-perguntando="1"] .conversa').some((b) => /border-left:[^;]*var\(--perigo\)/.test(b.corpo)),
      'PL-5: [data-perguntando="1"] .conversa TEM border-left em --perigo');
    tudoOk &= ok(porSeletor('.conversa-linha[data-nova] .conversa').some((b) => /border-left:[^;]*var\(--accent\)/.test(b.corpo)),
      'PL-5: [data-nova] continua no CSS (código morto sinalizado) — a guarda de 22/08 segue de pé');
  });

  // PL-9 — os PESOS mudaram, que é o miolo da Fase 3. Sem isto, PL-5 fica verde com a
  // hierarquia inteira por fazer.
  await rodarGrupo('PL-9: a hierarquia de pesos da lista', async () => {
    const todos = cor.blocos(cssSemComentario) || [];
    const porSeletor = (sel) => todos.filter((b) => b.seletor.split(',').some((p) => p.trim() === sel));
    const base = porSeletor('.conversa-titulo').find((b) => !b.dentroDe);
    tudoOk &= ok(Boolean(base) && /font-weight:\s*400/.test(base.corpo) && /color:\s*var\(--texto-2\)/.test(base.corpo),
      `PL-9: .conversa-titulo base em 400 + --texto-2 (${base && base.corpo.trim()})`);
    for (const marca of ['[data-esperando="1"]', '[data-perguntando="1"]']) {
      tudoOk &= ok(porSeletor(`.conversa-linha${marca} .conversa-titulo`).some((b) => /font-weight:\s*700/.test(b.corpo)),
        `PL-9: ${marca} .conversa-titulo continua em 700`);
    }
    tudoOk &= ok(!porSeletor('.conversa-linha[data-sem-claude="1"] .conversa-titulo').some((b) => /font-weight/.test(b.corpo)),
      'PL-9: nenhuma regra de font-weight para [data-sem-claude="1"] .conversa-titulo (S4)');
  });

  // PL-6 — o gesto novo funciona na FITA. Espelha o bloco `· puxar para atualizar` sobre
  // `#mensagens`: barra a rolagem, desce a `#fita` (nunca o `#mensagens` — R2), não reabre
  // antes do limiar, reabre UMA vez depois dele. Constantes lidas da FONTE.
  await rodarGrupo('PL-6: puxar para atualizar na conversa', async () => {
    const numeroPl = (nome) => {
      const achado = new RegExp(`const ${nome} = (\\d+)`).exec(fonteBruta);
      return achado ? Number(achado[1]) : 0;
    };
    const LIMIAR_PL = numeroPl('PUXAR_LIMIAR');
    const TETO_PL = numeroPl('PUXAR_TETO');
    tudoOk &= ok(LIMIAR_PL > 0 && TETO_PL > 0, `PL-6: limiar e teto lidos da fonte (${LIMIAR_PL}px, ${TETO_PL}px)`);
    const c = carregarCliente({
      aoBuscar: (rota) => (String(rota).startsWith('api/abas')
        ? { abas: [{ chave: 'aba-7', titulo: 'cockpit', cwd: '/home/y/p/cockpit', temClaude: true, rodando: false, atualizadoEm: Date.now() }] }
        : { painel: true, jobs: [] }),
    });
    await c.carregarAbas();
    await c.abrirAba('aba-7');
    const mensagensPl = porIdDe(c, 'mensagens');
    const fitaPl = porIdDe(c, 'fita');
    // O DOM de mentira não lê o HTML: o `hidden` da `.pergunta` (que no HTML nasce escrito)
    // tem que ser posto pelo teste, senão a guarda de PL-7 bloquearia o gesto aqui.
    porIdDe(c, 'pergunta').hidden = true;
    const dedoPl = (y) => ({ touches: [{ clientY: y }], preventDefault() { this.barrou = true; }, barrou: false });

    // (a) arma no topo e barra a rolagem
    mensagensPl.scrollTop = 0;
    mensagensPl.disparar('touchstart', dedoPl(100));
    const meio = mensagensPl.disparar('touchmove', dedoPl(160));
    tudoOk &= ok(meio.barrou === true, 'PL-6: arrastar do topo para baixo barra a rolagem — o gesto é nosso');
    // (b) quem desce é a FITA, e o #mensagens fica intocado (R2)
    tudoOk &= ok(/^translateY\(\d+(\.\d+)?px\)$/.test(String(fitaPl.style.transform)),
      `PL-6: a #fita desce junto com o dedo (transform=${fitaPl.style.transform})`);
    tudoOk &= ok(!mensagensPl.style.transform, 'PL-6: e o #mensagens NÃO recebe transform — a tela da pane é filha dele');
    // (b2) o SELO acompanha o dedo (03/09). Sem isto o gesto é invisível: no celular o ↻
    // saiu do topo e nada mais dizia que puxar recarrega, nem que a recarga começou.
    const seloPl = porIdDe(c, 'puxar-selo');
    const fracaoPl = () => Number(seloPl.style.getPropertyValue('--puxar'));
    tudoOk &= ok(fracaoPl() > 0 && fracaoPl() <= 1,
      `PL-6: o selo recebe a fração do curso enquanto o dedo anda (--puxar=${seloPl.style.getPropertyValue('--puxar')})`);
    tudoOk &= ok(seloPl.dataset.armado !== '1',
      'PL-6: e ABAIXO do limiar ele não finge que soltar já vale');
    // (b3) passando do limiar o selo arma — é a promessa de que soltar AGORA recarrega
    const antesDeArmarPl = fracaoPl();
    mensagensPl.disparar('touchmove', dedoPl(100 + LIMIAR_PL + 10));
    tudoOk &= ok(seloPl.dataset.armado === '1',
      `PL-6: passado o limiar o selo ARMA (armado=${seloPl.dataset.armado || '-'})`);
    tudoOk &= ok(fracaoPl() >= antesDeArmarPl,
      `PL-6: e a fração não anda para trás com o dedo indo adiante (${antesDeArmarPl} -> ${fracaoPl()})`);
    // (b4) recuando abaixo do limiar o selo DESARMA. Sem isto ele prometeria uma recarga que
    // soltar ali não faria — e deixa o dedo onde o caso (c) abaixo espera encontrá-lo.
    mensagensPl.disparar('touchmove', dedoPl(160));
    tudoOk &= ok(seloPl.dataset.armado !== '1',
      `PL-6: recuando abaixo do limiar o selo DESARMA (armado=${seloPl.dataset.armado || '-'})`);
    // (c) soltar ANTES do limiar não reabre nada
    const fluxosAntesPl = c.fluxos.length;
    mensagensPl.disparar('touchend', {});
    await new Promise((r) => setTimeout(r, 0));
    tudoOk &= ok(c.fluxos.length === fluxosAntesPl, 'PL-6: soltar antes do limiar não reabre o fluxo');
    tudoOk &= ok(fitaPl.dataset.voltando === '1' && fitaPl.style.transform === '',
      'PL-6: soltar devolve a fita ao lugar com a volta ligada');
    // o teto
    mensagensPl.disparar('touchstart', dedoPl(100));
    mensagensPl.disparar('touchmove', dedoPl(100 + TETO_PL * 10));
    tudoOk &= ok(fitaPl.style.transform === `translateY(${TETO_PL}px)`,
      `PL-6: a fita para no teto por mais que o dedo ande (${fitaPl.style.transform})`);
    mensagensPl.disparar('touchend', {});
    await new Promise((r) => setTimeout(r, 0));
    // (d) passou do limiar: reabre UMA vez — medição com await em laço, teto de 50 voltas
    const antesDoValendoPl = c.fluxos.length;
    mensagensPl.disparar('touchstart', dedoPl(100));
    mensagensPl.disparar('touchmove', dedoPl(100 + LIMIAR_PL));
    mensagensPl.disparar('touchend', {});
    let voltas = 0;
    while (c.fluxos.length === antesDoValendoPl && voltas < 50) { voltas += 1; await Promise.resolve(); }
    tudoOk &= ok(c.fluxos.length === antesDoValendoPl + 1,
      `PL-6: soltar passado o limiar reabre a conversa UMA vez (${c.fluxos.length - antesDoValendoPl} fluxo(s) novo(s), ${voltas} volta(s))`);
    tudoOk &= ok(c.fluxos[antesDoValendoPl - 1].fechado === true, 'PL-6: e o EventSource velho foi fechado');
    // (d2) e o selo GIRA enquanto recarrega, apagando quando termina. O `finally` é o que
    // impede o pior caso: recarga que falha deixaria o anel rodando para sempre, dizendo uma
    // coisa que não está mais acontecendo (#10).
    let voltasSelo = 0;
    while (seloPl.dataset.girando === '1' && voltasSelo < 50) { voltasSelo += 1; await Promise.resolve(); }
    tudoOk &= ok(seloPl.dataset.girando !== '1',
      `PL-6: terminada a recarga o selo PARA de girar (girando=${seloPl.dataset.girando || '-'}, ${voltasSelo} volta(s))`);
    tudoOk &= ok(!seloPl.style.getPropertyValue('--puxar') && seloPl.dataset.armado !== '1',
      'PL-6: e apaga por inteiro — selo aceso sobrando pareceria travado');
    // (e) a volta é RETA no CSS — sem o repique da lista
    const fitaVoltando = (cor.blocos(cssSemComentario) || []).find((b) => b.seletor === '.fita[data-voltando="1"]');
    tudoOk &= ok(Boolean(fitaVoltando) && /transition:\s*transform/.test(fitaVoltando.corpo) && !/cubic-bezier/.test(fitaVoltando.corpo),
      'PL-6: a volta da fita é reta no CSS — sem cubic-bezier de repique');
    // (f) fora do topo nem arma
    mensagensPl.scrollTop = 120;
    mensagensPl.disparar('touchstart', dedoPl(100));
    const roladoPl = mensagensPl.disparar('touchmove', dedoPl(100 + LIMIAR_PL));
    tudoOk &= ok(roladoPl.barrou === false, 'PL-6: com a fita rolada, arrastar continua sendo rolagem');
    mensagensPl.disparar('touchend', {});
  });

  // PL-7 — a tela da pane BLOQUEIA o gesto (R3): touchstart em .pergunta borbulha até
  // #mensagens, e ler o framebuffer não pode recarregar a conversa.
  await rodarGrupo('PL-7: a tela da pane bloqueia o gesto', async () => {
    const c = carregarCliente({
      aoBuscar: (rota) => (String(rota).startsWith('api/abas')
        ? { abas: [{ chave: 'aba-7', titulo: 'cockpit', cwd: '/home/y/p/cockpit', temClaude: true, rodando: false, atualizadoEm: Date.now() }] }
        : { painel: true, jobs: [] }),
    });
    await c.carregarAbas();
    await c.abrirAba('aba-7');
    c.aplicar({ tipo: 'esperando', valor: true });
    const mensagensPl = porIdDe(c, 'mensagens');
    const fitaPl = porIdDe(c, 'fita');
    tudoOk &= ok(porIdDe(c, 'pergunta').hidden === false, 'PL-7: a tela da pane está visível');
    const dedoPl = (y) => ({ touches: [{ clientY: y }], preventDefault() { this.barrou = true; }, barrou: false });
    mensagensPl.scrollTop = 0;
    const fluxosAntesPl = c.fluxos.length;
    mensagensPl.disparar('touchstart', dedoPl(100));
    const meio = mensagensPl.disparar('touchmove', dedoPl(100 + 400));
    tudoOk &= ok(meio.barrou === false && !fitaPl.style.transform,
      'PL-7: com a pane aberta, arrastar NÃO escreve transform na fita nem barra a rolagem');
    mensagensPl.disparar('touchend', {});
    let voltas = 0;
    while (voltas < 10) { voltas += 1; await Promise.resolve(); }
    await new Promise((r) => setTimeout(r, 0));
    tudoOk &= ok(c.fluxos.length === fluxosAntesPl, 'PL-7: e soltar NÃO reabre o fluxo');
  });

  // PL-8 — o botão continua NO DOM, com dono, mesmo `display: none` no celular. O bloco
  // `· botão de recarregar` prova o comportamento e não muda; este prova a existência.
  // Split view, fase 2: o markup migrou do HTML para `criarPainel` — a existência se prova
  // no DOM do painel, não mais lendo `id="..."` do arquivo.
  await rodarGrupo('PL-8: o ↻ da conversa continua no DOM com dono', async () => {
    const c = carregarCliente();
    const botao = porIdDe(c, 'btn-recarregar-conversa');
    tudoOk &= ok(typeof botao.onclick === 'function', 'PL-8: .btn-recarregar-conversa existe com onclick');
    tudoOk &= ok(botao.tag === 'button', 'PL-8: e está no DOM do painel — display:none não tira nó');
  });

  // PL-10 — o aviso tem contraste nos DOZE temas, nos dois tons (`--texto-2` e `--perigo`
  // contra `--fundo-2`, onde o `.chat-topo` mora). Substitui fotografar os dez temas.
  //
  // O que a spec SUPÔS e a medição desmentiu (03/09): `--perigo` sobre `--fundo-2` NÃO passa
  // 4.5:1 em cinco temas — é o vermelho da própria paleta (o Nord dá 2.46:1, e o Nord é
  // assim). Não é regressão desta entrega: a `.bolha-erro` que desenhava o mesmo "falhou"
  // até 02/09 já era texto em `--perigo` sobre `--fundo`, com contraste igual ou pior, e
  // `interrompida` na lista idem. Trocar o vermelho dos temas é decisão do dono (são
  // paletas conhecidas), então a dívida fica CONGELADA aqui, nominal: qualquer tema fora
  // desta lista que reprove, ou qualquer tema desta lista que piore, fica vermelho. O
  // `--texto-2` (o tom de todo dia) continua exigido nos onze, sem exceção.
  await rodarGrupo('PL-10: contraste do aviso nos doze temas', async () => {
    const paletasPl10 = cor.paletas(css);
    const raizPl10 = paletasPl10[0].variaveis;
    const reprovados = [];
    const perigoFraco = [];
    const DIVIDA_PERIGO = {
      ':root (claro do sistema)': 3.34, '[data-tema="catppuccin-latte"]': 4.46,
      '[data-tema="nord"]': 2.46, '[data-tema="gruvbox-dark"]': 4.29, '[data-tema="rose-pine-dawn"]': 4.04,
    };
    for (const t of paletasPl10) {
      const fundo2 = t.variaveis['--fundo-2'] || raizPl10['--fundo-2'];
      const texto2 = t.variaveis['--texto-2'] || raizPl10['--texto-2'];
      const perigo = t.variaveis['--perigo'] || raizPl10['--perigo'];
      const rTexto = cor.contraste(texto2, fundo2);
      const rPerigo = cor.contraste(perigo, fundo2);
      if (!(rTexto >= 4.5)) reprovados.push(`${t.rotulo}/texto-2 ${rTexto === null ? '?' : rTexto.toFixed(2)}:1`);
      if (!(rPerigo >= 4.5)) {
        const conhecido = DIVIDA_PERIGO[t.rotulo];
        // Só passa se é dívida conhecida E não piorou (tolerância de arredondamento).
        if (conhecido === undefined || rPerigo === null || rPerigo < conhecido - 0.01) {
          perigoFraco.push(`${t.rotulo}/perigo ${rPerigo === null ? '?' : rPerigo.toFixed(2)}:1`);
        }
      }
    }
    tudoOk &= ok(paletasPl10.length === 12, `PL-10: os doze blocos de paleta são lidos (${paletasPl10.length})`);
    tudoOk &= ok(reprovados.length === 0,
      `PL-10: --texto-2 passa 4.5:1 sobre --fundo-2 nos onze${reprovados.length ? ` — reprovam: ${reprovados.join('; ')}` : ''}`);
    tudoOk &= ok(perigoFraco.length === 0,
      `PL-10: --perigo sobre --fundo-2 — nenhum tema reprova além dos ${Object.keys(DIVIDA_PERIGO).length} da dívida conhecida, e nenhum deles piorou${perigoFraco.length ? ` — ${perigoFraco.join('; ')}` : ''}`);
  });

  await rodarGrupo('· conversa: ferramentas agrupadas', async () => {
    // FG-1: sete `ferramenta` seguidas produzem UM `.grupo-ferramentas`, com SETE `.passo`
    // dentro, e ZERO `.ferramenta` solta irmã da fita.
    const g1 = carregarCliente();
    for (let i = 1; i <= 7; i += 1) {
      g1.aplicar({ tipo: 'ferramenta', id: `fg1-${i}`, nome: 'Read', entrada: { file_path: `/a/${i}.js` } });
    }
    const fita1 = porIdDe(g1, 'fita');
    const grupos1 = fita1.filhos.filter((f) => f.className === 'grupo-ferramentas');
    const passos1 = grupos1[0] ? grupos1[0].querySelectorAll('.passo') : [];
    tudoOk &= ok(grupos1.length === 1, `FG-1: sete ferramentas seguidas viram um único grupo (${grupos1.length})`);
    tudoOk &= ok(passos1.length === 7, `FG-1: o grupo tem sete .passo (${passos1.length})`);
    tudoOk &= ok(fita1.filhos.filter((f) => f.className === 'ferramenta').length === 0,
      'FG-1: nenhuma .ferramenta solta sobra na fita');

    // FG-2: resultado_ferramenta de um id de DENTRO do grupo acha o passo pelo
    // data-ferramenta-id, marca feita e escreve ✓ — o contrato do card.
    const g2 = carregarCliente();
    g2.aplicar({ tipo: 'ferramenta', id: 'fg2-1', nome: 'Read', entrada: {} });
    g2.aplicar({ tipo: 'ferramenta', id: 'fg2-2', nome: 'Read', entrada: {} });
    g2.aplicar({ tipo: 'resultado_ferramenta', id: 'fg2-1', saida: 'ok' });
    const passo2 = porIdDe(g2, 'fita').querySelector('[data-ferramenta-id="fg2-1"]');
    tudoOk &= ok(Boolean(passo2) && passo2.dataset.estado === 'feita',
      'FG-2: resultado acha o passo pelo data-ferramenta-id e marca feita');
    tudoOk &= ok(Boolean(passo2) && passo2.querySelector('.fer-estado').textContent === '✓',
      'FG-2: e escreve ✓ no .fer-estado');
    tudoOk &= ok(Boolean(passo2) && String(passo2.className).split(/\s+/).includes('passo'),
      'FG-2: e o passo está DENTRO do grupo (classe passo) — prova o agrupamento, não só o resultado');

    // FG-3: uma ferramenta sozinha (fala antes e depois) continua .ferramenta, sem passo e
    // sem grupo — verdadeiro hoje por não haver grupo (pode passar contra o código antigo).
    const g3 = carregarCliente();
    g3.aplicar({ tipo: 'texto', texto: 'antes' });
    g3.aplicar({ tipo: 'ferramenta', id: 'fg3-1', nome: 'Read', entrada: {} });
    g3.aplicar({ tipo: 'texto', texto: 'depois' });
    const solta3 = porIdDe(g3, 'fita').querySelector('[data-ferramenta-id="fg3-1"]');
    tudoOk &= ok(Boolean(solta3) && solta3.className === 'ferramenta',
      'FG-3: ferramenta sozinha continua .ferramenta, sem grupo');

    // FG-4: ferramenta, ferramenta, texto, ferramenta → um grupo de dois passos + uma
    // .ferramenta solta — a fala no meio fecha o grupo, o que vem depois recomeça do zero.
    const g4 = carregarCliente();
    g4.aplicar({ tipo: 'ferramenta', id: 'fg4-1', nome: 'Read', entrada: {} });
    g4.aplicar({ tipo: 'ferramenta', id: 'fg4-2', nome: 'Read', entrada: {} });
    g4.aplicar({ tipo: 'texto', texto: 'fala no meio' });
    g4.aplicar({ tipo: 'ferramenta', id: 'fg4-3', nome: 'Bash', entrada: {} });
    const fita4 = porIdDe(g4, 'fita');
    const grupos4 = fita4.filhos.filter((f) => f.className === 'grupo-ferramentas');
    const soltas4 = fita4.filhos.filter((f) => f.className === 'ferramenta');
    tudoOk &= ok(grupos4.length === 1 && grupos4[0].querySelectorAll('.passo').length === 2,
      'FG-4: grupo de dois passos antes da fala');
    tudoOk &= ok(soltas4.length === 1 && soltas4[0].dataset.ferramentaId === 'fg4-3',
      'FG-4: e a ferramenta depois da fala recomeça solta');

    // FG-5: o grupo fecha (open === false) quando a fala chega e todos terminaram; e
    // continua aberto se algum passo ainda está rodando.
    const g5a = carregarCliente();
    g5a.aplicar({ tipo: 'ferramenta', id: 'fg5a-1', nome: 'Read', entrada: {} });
    g5a.aplicar({ tipo: 'ferramenta', id: 'fg5a-2', nome: 'Read', entrada: {} });
    g5a.aplicar({ tipo: 'resultado_ferramenta', id: 'fg5a-1', saida: 'ok' });
    g5a.aplicar({ tipo: 'resultado_ferramenta', id: 'fg5a-2', saida: 'ok' });
    g5a.aplicar({ tipo: 'texto', texto: 'terminei' });
    const grupo5a = porIdDe(g5a, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(Boolean(grupo5a) && grupo5a.open === false,
      'FG-5: grupo fecha quando a fala chega e todos terminaram');
    const g5b = carregarCliente();
    g5b.aplicar({ tipo: 'ferramenta', id: 'fg5b-1', nome: 'Read', entrada: {} });
    g5b.aplicar({ tipo: 'ferramenta', id: 'fg5b-2', nome: 'Read', entrada: {} });
    g5b.aplicar({ tipo: 'resultado_ferramenta', id: 'fg5b-1', saida: 'ok' });
    g5b.aplicar({ tipo: 'texto', texto: 'ainda rodando o segundo' });
    const grupo5b = porIdDe(g5b, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(Boolean(grupo5b) && grupo5b.open === true,
      'FG-5: e continua aberto com um passo ainda rodando');

    // FG-5b: o grupo fecha também quando o resultado do último é o ÚLTIMO EVENTO do turno.
    const g5c = carregarCliente();
    for (let i = 1; i <= 3; i += 1) g5c.aplicar({ tipo: 'ferramenta', id: `fg5c-${i}`, nome: 'Read', entrada: {} });
    for (let i = 1; i <= 3; i += 1) g5c.aplicar({ tipo: 'resultado_ferramenta', id: `fg5c-${i}`, saida: 'ok' });
    g5c.aplicar({ tipo: 'turno_fim' });
    const grupo5c = porIdDe(g5c, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(Boolean(grupo5c) && grupo5c.open === false,
      'FG-5b: turno_fim depois do último resultado fecha o grupo (senão ficaria aberto para sempre)');

    // FG-5c: o histórico do disco ACABA em ferramenta — rajada com ferramenta×3 + resultados,
    // depois `sincronizado` → grupo fechado, e o despejo entrou na página.
    const g5d = carregarCliente();
    g5d.segurarFita();
    for (let i = 1; i <= 3; i += 1) g5d.aplicar({ tipo: 'ferramenta', id: `fg5d-${i}`, nome: 'Read', entrada: {} });
    for (let i = 1; i <= 3; i += 1) g5d.aplicar({ tipo: 'resultado_ferramenta', id: `fg5d-${i}`, saida: 'ok' });
    g5d.aplicar({ tipo: 'sincronizado', turnoEmAndamento: false });
    const fita5d = porIdDe(g5d, 'fita');
    // O despejo real (`$('fita').append(fragmento)`) só desembrulha os filhos do fragmento
    // no NAVEGADOR de verdade; o DOM falso não replica isso, e o grupo fica aninhado dentro
    // do nó do fragmento. `querySelector` busca a árvore inteira — é ele quem prova.
    const grupo5d = fita5d.querySelector('.grupo-ferramentas');
    tudoOk &= ok(Boolean(grupo5d) && grupo5d.open === false && fita5d.filhos.length > 0,
      'FG-5c: histórico terminando em ferramenta fecha o grupo, e o despejo entrou na página');

    // FG-6: data-tocado só nasce de CLIQUE no summary (nunca do toggle programático), e
    // grupo tocado não fecha sozinho; o fechamento programático não marca tocado.
    const g6 = carregarCliente();
    g6.aplicar({ tipo: 'ferramenta', id: 'fg6-1', nome: 'Read', entrada: {} });
    g6.aplicar({ tipo: 'ferramenta', id: 'fg6-2', nome: 'Read', entrada: {} });
    const grupo6 = porIdDe(g6, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    const resumo6 = grupo6 && grupo6.querySelector('.grupo-resumo');
    if (resumo6) resumo6.disparar('click', {});
    tudoOk &= ok(Boolean(grupo6) && grupo6.dataset.tocado === '1', 'FG-6: clique no summary marca data-tocado');
    g6.aplicar({ tipo: 'resultado_ferramenta', id: 'fg6-1', saida: 'ok' });
    g6.aplicar({ tipo: 'resultado_ferramenta', id: 'fg6-2', saida: 'ok' });
    g6.aplicar({ tipo: 'texto', texto: 'fim' });
    tudoOk &= ok(Boolean(grupo6) && grupo6.open === true,
      'FG-6: grupo tocado não fecha sozinho mesmo com tudo terminado');
    const g6b = carregarCliente();
    g6b.aplicar({ tipo: 'ferramenta', id: 'fg6b-1', nome: 'Read', entrada: {} });
    g6b.aplicar({ tipo: 'ferramenta', id: 'fg6b-2', nome: 'Read', entrada: {} });
    g6b.aplicar({ tipo: 'resultado_ferramenta', id: 'fg6b-1', saida: 'ok' });
    g6b.aplicar({ tipo: 'resultado_ferramenta', id: 'fg6b-2', saida: 'ok' });
    g6b.aplicar({ tipo: 'texto', texto: 'fim' });
    const grupo6b = porIdDe(g6b, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(Boolean(grupo6b) && grupo6b.open === false && grupo6b.dataset.tocado !== '1',
      'FG-6: fechamento programático (open=false do próprio encerramento) NÃO marca data-tocado');

    // FG-7: cabeçalho — "7 passos", "Read ×5 · Bash ×2" na ordem de 1ª aparição, e
    // data-grupo-estado virando erro quando um passo dá erro.
    const g7 = carregarCliente();
    const nomes7 = ['Read', 'Read', 'Bash', 'Read', 'Bash', 'Read', 'Read'];
    for (let i = 0; i < 7; i += 1) g7.aplicar({ tipo: 'ferramenta', id: `fg7-${i}`, nome: nomes7[i], entrada: {} });
    const grupo7 = porIdDe(g7, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    const conta7 = grupo7 && grupo7.querySelector('.grupo-conta') && grupo7.querySelector('.grupo-conta').textContent;
    const tipos7 = grupo7 && grupo7.querySelector('.grupo-tipos') && grupo7.querySelector('.grupo-tipos').textContent;
    tudoOk &= ok(conta7 === '7 passos', `FG-7: cabeçalho mostra "7 passos" (${conta7})`);
    tudoOk &= ok(tipos7 === 'Read ×5 · Bash ×2', `FG-7: tipos na ordem de 1ª aparição (${tipos7})`);
    g7.aplicar({ tipo: 'resultado_ferramenta', id: 'fg7-2', erro: true, saida: 'falhou' });
    tudoOk &= ok(Boolean(grupo7) && grupo7.dataset.grupoEstado === 'erro',
      'FG-7: data-grupo-estado vira erro com um passo em erro');

    // FG-8: sem `t` não existe .grupo-tempo (trivialmente verdadeiro sem grupo — pode passar
    // contra o código antigo); com `t` nos dois lados existe e traz a diferença formatada;
    // com `t` só de um lado, não existe.
    const g8a = carregarCliente();
    g8a.aplicar({ tipo: 'ferramenta', id: 'fg8a-1', nome: 'Read', entrada: {} });
    g8a.aplicar({ tipo: 'ferramenta', id: 'fg8a-2', nome: 'Read', entrada: {} });
    const grupo8a = porIdDe(g8a, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(!(grupo8a && grupo8a.querySelector('.grupo-tempo')), 'FG-8: sem t, .grupo-tempo não existe');
    const g8b = carregarCliente();
    g8b.aplicar({ tipo: 'ferramenta', id: 'fg8b-1', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:00.000Z' });
    g8b.aplicar({ tipo: 'ferramenta', id: 'fg8b-2', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:01.000Z' });
    g8b.aplicar({ tipo: 'resultado_ferramenta', id: 'fg8b-2', saida: 'ok', t: '2026-09-04T10:00:05.000Z' });
    const grupo8b = porIdDe(g8b, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    const tempo8b = grupo8b && grupo8b.querySelector('.grupo-tempo');
    tudoOk &= ok(Boolean(tempo8b) && tempo8b.textContent === '5s',
      `FG-8: com t nos dois lados, .grupo-tempo existe e traz a diferença (${tempo8b && tempo8b.textContent})`);
    const g8c = carregarCliente();
    g8c.aplicar({ tipo: 'ferramenta', id: 'fg8c-1', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:00.000Z' });
    g8c.aplicar({ tipo: 'ferramenta', id: 'fg8c-2', nome: 'Read', entrada: {} });
    g8c.aplicar({ tipo: 'resultado_ferramenta', id: 'fg8c-2', saida: 'ok' });
    const grupo8c = porIdDe(g8c, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(!(grupo8c && grupo8c.querySelector('.grupo-tempo')), 'FG-8: t só de um lado — .grupo-tempo não existe');

    // FG-9: lib/externo.js carimba `t` em ferramenta e resultado_ferramenta, e `quando`
    // continua undefined nos dois (o contrato de gate-ui.js:1832, agora dos dois lados).
    const externoGrupo = require('../lib/externo');
    const comT = externoGrupo.eventosDoObjeto({
      type: 'assistant', timestamp: '2026-09-04T09:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'fg9-1', name: 'Read', input: {} }] },
    });
    tudoOk &= ok(Boolean(comT[0]) && comT[0].t === '2026-09-04T09:00:00.000Z' && comT[0].quando === undefined,
      'FG-9: eventosDoObjeto carimba t em ferramenta, e quando continua undefined');
    const resultadoComT = externoGrupo.eventosDoObjeto({
      type: 'user', timestamp: '2026-09-04T09:00:05.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'fg9-1', content: 'saida' }] },
    });
    tudoOk &= ok(Boolean(resultadoComT[0]) && resultadoComT[0].t === '2026-09-04T09:00:05.000Z'
      && resultadoComT[0].quando === undefined,
      'FG-9: e em resultado_ferramenta também, sem quando');

    // FG-9b: timestamp válido põe `t` idêntico à string de entrada NOS DOIS TIPOS (não só no
    // exemplo de FG-9), e a mesma guarda do `quando` faz ausente/null/0/'' sair sem a chave `t`.
    const comTBoaFg9b = externoGrupo.eventosDoObjeto({
      type: 'assistant', timestamp: '2026-09-04T09:10:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'fg9b-boa', name: 'Read', input: {} }] },
    });
    tudoOk &= ok(Boolean(comTBoaFg9b[0]) && comTBoaFg9b[0].t === '2026-09-04T09:10:00.000Z',
      'FG-9b: timestamp válido põe t idêntico à string de entrada (ferramenta)');
    const resultadoTBoaFg9b = externoGrupo.eventosDoObjeto({
      type: 'user', timestamp: '2026-09-04T09:10:05.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'fg9b-boa', content: 'saida' }] },
    });
    tudoOk &= ok(Boolean(resultadoTBoaFg9b[0]) && resultadoTBoaFg9b[0].t === '2026-09-04T09:10:05.000Z',
      'FG-9b: timestamp válido põe t idêntico à string de entrada (resultado)');
    for (const timestampRuim of [undefined, null, 0, '']) {
      const semT = externoGrupo.eventosDoObjeto({
        type: 'assistant', timestamp: timestampRuim,
        message: { content: [{ type: 'tool_use', id: 'fg9b', name: 'Read', input: {} }] },
      });
      tudoOk &= ok(Boolean(semT[0]) && semT[0].t === undefined && semT[0].quando === undefined,
        `FG-9b: timestamp ${JSON.stringify(timestampRuim)} não gera t (ferramenta)`);
      const semTResultado = externoGrupo.eventosDoObjeto({
        type: 'user', timestamp: timestampRuim,
        message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] },
      });
      tudoOk &= ok(Boolean(semTResultado[0]) && semTResultado[0].t === undefined && semTResultado[0].quando === undefined,
        `FG-9b: timestamp ${JSON.stringify(timestampRuim)} não gera t (resultado)`);
    }

    // FG-9c: o TERCEIRO produtor — dentro de trocasDeFora, que não passa por eventosDoObjeto.
    const dirFg9c = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fg9c-'));
    const linhaFg9c = (o) => `${JSON.stringify(o)}\n`;
    const humanoFg9c = (t) => linhaFg9c({ type: 'user', message: { content: t } });
    fs.writeFileSync(path.join(dirFg9c, 'sessao.jsonl'), [
      humanoFg9c('prompt do cockpit'),
      linhaFg9c({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
      humanoFg9c('digitado no terminal'),
      linhaFg9c({
        type: 'assistant',
        timestamp: '2026-09-04T12:00:00.000Z',
        message: { content: [{ type: 'tool_use', id: 'fg9c-1', name: 'Read', input: { file_path: '/x.js' } }] },
      }),
    ].join(''));
    const raizFg9c = path.join(dirFg9c, 'projects');
    const pastaFg9c = path.join(raizFg9c, 'projeto-fg9c');
    fs.mkdirSync(pastaFg9c, { recursive: true });
    fs.copyFileSync(path.join(dirFg9c, 'sessao.jsonl'), path.join(pastaFg9c, 'sess-fg9c.jsonl'));
    const homeRealFg9c = process.env.HOME;
    const homeFalsoFg9c = path.join(dirFg9c, 'home');
    fs.mkdirSync(path.join(homeFalsoFg9c, '.claude'), { recursive: true });
    fs.cpSync(raizFg9c, path.join(homeFalsoFg9c, '.claude', 'projects'), { recursive: true });
    process.env.HOME = homeFalsoFg9c;
    delete require.cache[require.resolve('../lib/externo')];
    const externoFg9c = require('../lib/externo');
    const trechosFg9c = await externoFg9c.trocasDeFora('sess-fg9c', '/tmp/nao-importa-fg9c', ['prompt do cockpit']);
    process.env.HOME = homeRealFg9c;
    delete require.cache[require.resolve('../lib/externo')];
    const ferramentaDeForaFg9c = trechosFg9c[0] && trechosFg9c[0].eventos.find((e) => e.tipo === 'ferramenta');
    tudoOk &= ok(Boolean(ferramentaDeForaFg9c) && ferramentaDeForaFg9c.t === '2026-09-04T12:00:00.000Z',
      'FG-9c: o terceiro produtor (trocasDeFora) também carimba t, idêntico ao timestamp da linha');
    tudoOk &= ok(Boolean(ferramentaDeForaFg9c) && ferramentaDeForaFg9c.deFora === true,
      'FG-9c: e preserva deFora: true');

    // FG-10 (R1): o grupo usa data-grupo-estado e NUNCA data-estado — prova de comportamento.
    const g10 = carregarCliente();
    for (let i = 1; i <= 7; i += 1) g10.aplicar({ tipo: 'ferramenta', id: `fg10-${i}`, nome: 'Read', entrada: {} });
    for (let i = 1; i <= 7; i += 1) g10.aplicar({ tipo: 'resultado_ferramenta', id: `fg10-${i}`, saida: 'ok' });
    g10.aplicar({ tipo: 'turno_fim' });
    const fita10 = porIdDe(g10, 'fita');
    const grupo10 = fita10.filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(fita10.querySelectorAll('[data-estado="parada"]').length === 0,
      'FG-10: nenhum [data-estado="parada"] — o laço do turno_fim não colheu o grupo pelo data-estado');
    tudoOk &= ok(Boolean(grupo10) && grupo10.dataset.grupoEstado === 'feita', 'FG-10: e o grupo continua "feita"');
    const g10b = carregarCliente();
    g10b.aplicar({ tipo: 'ferramenta', id: 'fg10b-1', nome: 'Read', entrada: {} });
    g10b.aplicar({ tipo: 'ferramenta', id: 'fg10b-2', nome: 'Read', entrada: {} });
    g10b.aplicar({ tipo: 'resultado_ferramenta', id: 'fg10b-1', saida: 'ok' });
    g10b.aplicar({ tipo: 'turno_fim' });
    tudoOk &= ok(porIdDe(g10b, 'fita').querySelectorAll('[data-estado="parada"]').length === 1,
      'FG-10: contraprova — exatamente um passo sem resultado vira parada');

    // FG-11 (R3): fora_inicio, ferramenta, ferramenta, fora_fim, ferramenta → grupo de-fora
    // com dois passos + uma .ferramenta solta SEM de-fora.
    const g11 = carregarCliente();
    g11.aplicar({ tipo: 'fora_inicio' });
    g11.aplicar({ tipo: 'ferramenta', id: 'fg11-1', nome: 'Read', entrada: {} });
    g11.aplicar({ tipo: 'ferramenta', id: 'fg11-2', nome: 'Read', entrada: {} });
    g11.aplicar({ tipo: 'fora_fim' });
    g11.aplicar({ tipo: 'ferramenta', id: 'fg11-3', nome: 'Read', entrada: {} });
    const fita11 = porIdDe(g11, 'fita');
    const grupo11 = fita11.filhos.find((f) => f.className === 'grupo-ferramentas');
    const passos11 = grupo11 ? grupo11.querySelectorAll('.passo') : [];
    tudoOk &= ok(Boolean(grupo11) && passos11.length === 2
      && passos11.every((p) => String(p.className).includes('de-fora')),
      'FG-11: fora_inicio…fora_fim isola as duas ferramentas de fora num grupo');
    const solta11 = fita11.filhos.find((f) => f.className === 'ferramenta');
    tudoOk &= ok(Boolean(solta11) && !String(solta11.className).includes('de-fora'),
      'FG-11: e a que veio depois do fora_fim nasce solta, sem de-fora');

    // FG-12 (invariante do D2b, pelo caminho REAL): (a) pelo evento — sincronizado separa;
    // (b) pelo envio — a bolha do enviar() separa, e o furo que o aplicar() sozinho não cobria.
    const g12a = carregarCliente();
    g12a.aplicar({ tipo: 'ferramenta', id: 'fg12a-1', nome: 'Read', entrada: {} });
    g12a.aplicar({ tipo: 'sincronizado', turnoEmAndamento: false });
    g12a.aplicar({ tipo: 'ferramenta', id: 'fg12a-2', nome: 'Read', entrada: {} });
    const fita12a = porIdDe(g12a, 'fita');
    tudoOk &= ok(fita12a.filhos.filter((f) => f.className === 'ferramenta').length === 2
      && !fita12a.filhos.some((f) => f.className === 'grupo-ferramentas'),
      'FG-12a: sincronizado (evento) separa — nenhuma promoção, duas soltas');
    const g12b = carregarCliente();
    g12b.aplicar({ tipo: 'ferramenta', id: 'fg12b-1', nome: 'Read', entrada: {} });
    g12b.aplicar({ tipo: 'ferramenta', id: 'fg12b-2', nome: 'Read', entrada: {} });
    g12b.bolha('bolha-eu', 'mensagem enviada com o grupo ainda rodando');
    g12b.aplicar({ tipo: 'ferramenta', id: 'fg12b-3', nome: 'Read', entrada: {} });
    const fita12b = porIdDe(g12b, 'fita');
    const idxGrupo12b = fita12b.filhos.findIndex((f) => f.className === 'grupo-ferramentas');
    const idxBolha12b = fita12b.filhos.findIndex((f) => String(f.className).includes('bolha-eu'));
    const idxSolta12b = fita12b.filhos.findIndex((f) => f.className === 'ferramenta');
    tudoOk &= ok(idxGrupo12b >= 0 && idxBolha12b > idxGrupo12b, 'FG-12b: a bolha do envio fica DEPOIS do grupo');
    tudoOk &= ok(idxSolta12b > idxBolha12b,
      'FG-12b: e a terceira ferramenta nasce solta, depois da bolha — nunca dentro do grupo de cima');

    // FG-13 (presença, não contagem): a fonte chama encerrarGrupoFerramentas DENTRO de bolha().
    const iniBolha = fonteBruta.indexOf('function bolha(classe, texto, quando)');
    const fimBolha = fonteBruta.indexOf('\n}', iniBolha);
    const corpoBolha = iniBolha >= 0 ? fonteBruta.slice(iniBolha, fimBolha) : '';
    tudoOk &= ok(iniBolha >= 0 && /encerrarGrupoFerramentas\(\)/.test(corpoBolha),
      'FG-13: a fonte chama encerrarGrupoFerramentas() dentro de bolha()');

    // FG-14: resultado_ferramenta é NEUTRO — a sequência real do .jsonl (ferramenta t-1,
    // resultado t-1, ferramenta t-2, resultado t-2) produz UM grupo de dois passos.
    const g14 = carregarCliente();
    g14.aplicar({ tipo: 'ferramenta', id: 'fg14-1', nome: 'Read', entrada: {} });
    g14.aplicar({ tipo: 'resultado_ferramenta', id: 'fg14-1', saida: 'ok' });
    g14.aplicar({ tipo: 'ferramenta', id: 'fg14-2', nome: 'Read', entrada: {} });
    g14.aplicar({ tipo: 'resultado_ferramenta', id: 'fg14-2', saida: 'ok' });
    const fita14 = porIdDe(g14, 'fita');
    const grupo14 = fita14.filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(Boolean(grupo14) && grupo14.querySelectorAll('.passo').length === 2
      && !fita14.filhos.some((f) => f.className === 'ferramenta'),
      'FG-14: resultado_ferramenta neutro — a sequência real do .jsonl produz UM grupo de dois passos');

    // FG-15: ferramenta×3, resultado só do primeiro, turno_fim → grupo fecha como "parada"
    // (nunca rodando, nunca feita), e os dois sem resultado viram parada com — no .fer-estado.
    const g15 = carregarCliente();
    g15.aplicar({ tipo: 'ferramenta', id: 'fg15-1', nome: 'Read', entrada: {} });
    g15.aplicar({ tipo: 'ferramenta', id: 'fg15-2', nome: 'Read', entrada: {} });
    g15.aplicar({ tipo: 'ferramenta', id: 'fg15-3', nome: 'Read', entrada: {} });
    g15.aplicar({ tipo: 'resultado_ferramenta', id: 'fg15-1', saida: 'ok' });
    g15.aplicar({ tipo: 'turno_fim' });
    const grupo15 = porIdDe(g15, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(Boolean(grupo15) && grupo15.open === false && grupo15.dataset.grupoEstado === 'parada',
      `FG-15: turno morre no meio → grupo fecha como "parada" (${grupo15 && grupo15.dataset.grupoEstado})`);
    const passosSemResultado15 = (grupo15?.querySelectorAll('.passo') || []).filter((p) => p.dataset.ferramentaId !== 'fg15-1');
    tudoOk &= ok(passosSemResultado15.length === 2
      && passosSemResultado15.every((p) => p.dataset.estado === 'parada' && p.querySelector('.fer-estado').textContent === '—'),
      'FG-15: os dois passos sem resultado viram parada com — no .fer-estado');

    // FG-15b: a precedência dos quatro estados do grupo, um cenário por valor.
    const g15bErro = carregarCliente();
    g15bErro.aplicar({ tipo: 'ferramenta', id: 'e1', nome: 'Read', entrada: {} });
    g15bErro.aplicar({ tipo: 'ferramenta', id: 'e2', nome: 'Read', entrada: {} });
    g15bErro.aplicar({ tipo: 'resultado_ferramenta', id: 'e1', erro: true, saida: 'falhou' });
    const grupo15bErro = porIdDe(g15bErro, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(grupo15bErro?.dataset.grupoEstado === 'erro', 'FG-15b: erro ganha de rodando');
    const g15bParada = carregarCliente();
    g15bParada.aplicar({ tipo: 'ferramenta', id: 'pp1', nome: 'Read', entrada: {} });
    g15bParada.aplicar({ tipo: 'ferramenta', id: 'pp2', nome: 'Read', entrada: {} });
    g15bParada.aplicar({ tipo: 'resultado_ferramenta', id: 'pp1', saida: 'ok' });
    g15bParada.aplicar({ tipo: 'turno_fim' });
    const grupo15bParada = porIdDe(g15bParada, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(grupo15bParada?.dataset.grupoEstado === 'parada', 'FG-15b: parada ganha de feita');
    const g15bFeita = carregarCliente();
    g15bFeita.aplicar({ tipo: 'ferramenta', id: 'f1', nome: 'Read', entrada: {} });
    g15bFeita.aplicar({ tipo: 'ferramenta', id: 'f2', nome: 'Read', entrada: {} });
    g15bFeita.aplicar({ tipo: 'resultado_ferramenta', id: 'f1', saida: 'ok' });
    g15bFeita.aplicar({ tipo: 'resultado_ferramenta', id: 'f2', saida: 'ok' });
    const grupo15bFeita = porIdDe(g15bFeita, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(grupo15bFeita?.dataset.grupoEstado === 'feita', 'FG-15b: todos ✓ → feita');
    // "rodando ganha de parada" nunca ocorre pelo fluxo real (o mesmo turno_fim que cria
    // "parada" fecha o grupo na mesma passada), então é provado direto na função pura.
    const g15bRp = carregarCliente();
    const grupoElRp = g15bRp.document.createElement('details');
    const resumoElRp = g15bRp.document.createElement('summary');
    const contaRp = g15bRp.document.createElement('span');
    const tiposRp = g15bRp.document.createElement('span');
    const estadoRp = g15bRp.document.createElement('span');
    resumoElRp.append(contaRp, tiposRp, estadoRp);
    grupoElRp.append(resumoElRp);
    const passosElRp = g15bRp.document.createElement('div');
    grupoElRp.append(passosElRp);
    // `novoGrupo`/`atualizarResumoGrupo` não existem no código velho — sem grupo nenhum,
    // não há função para chamar, e isso É o vermelho desta asserção.
    let precedenciaRp = null;
    if (typeof g15bRp.novoGrupo === 'function' && typeof g15bRp.atualizarResumoGrupo === 'function') {
      const gRp = g15bRp.novoGrupo(grupoElRp, passosElRp, { conta: contaRp, tipos: tiposRp, tempo: null, estado: estadoRp });
      const passoRodandoRp = g15bRp.document.createElement('details');
      passoRodandoRp.dataset.estado = 'rodando';
      const passoParadaRp = g15bRp.document.createElement('details');
      passoParadaRp.dataset.estado = 'parada';
      gRp.passos.push(passoRodandoRp, passoParadaRp);
      g15bRp.atualizarResumoGrupo(gRp);
      precedenciaRp = grupoElRp.dataset.grupoEstado;
    }
    tudoOk &= ok(precedenciaRp === 'rodando', 'FG-15b: rodando ganha de parada');

    // FG-16: resultado que chega DEPOIS do encerramento ainda atualiza o cabeçalho daquele
    // grupo — prova que a referência mora no passo, não numa variável já zerada.
    const g16 = carregarCliente();
    g16.aplicar({ tipo: 'ferramenta', id: 'fg16-1', nome: 'Read', entrada: {} });
    g16.aplicar({ tipo: 'ferramenta', id: 'fg16-2', nome: 'Read', entrada: {} });
    g16.aplicar({ tipo: 'texto', texto: 'encerra o grupo' });
    const grupo16 = porIdDe(g16, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(Boolean(grupo16) && grupo16.dataset.grupoEstado === 'rodando',
      'FG-16 (pré): grupo encerrado mas ainda com passos rodando');
    g16.aplicar({ tipo: 'resultado_ferramenta', id: 'fg16-2', erro: true, saida: 'falhou' });
    tudoOk &= ok(grupo16?.dataset.grupoEstado === 'erro',
      'FG-16: resultado tardio (depois do encerramento) ainda atualiza o grupo certo');

    // FG-17: resultado que chega ANTES da promoção sobrevive no dataset.tFim do cartão.
    const g17 = carregarCliente();
    g17.aplicar({ tipo: 'ferramenta', id: 'fg17-1', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:00.000Z' });
    g17.aplicar({ tipo: 'resultado_ferramenta', id: 'fg17-1', saida: 'ok', t: '2026-09-04T10:00:02.000Z' });
    g17.aplicar({ tipo: 'ferramenta', id: 'fg17-2', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:03.000Z' });
    g17.aplicar({ tipo: 'texto', texto: 'fecha' });
    const grupo17 = porIdDe(g17, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(Boolean(grupo17) && Boolean(grupo17.querySelector('.grupo-tempo')),
      'FG-17: resultado antes da promoção sobrevive — o grupo tem .grupo-tempo');

    // FG-18: resultados fora de ordem (o último a chegar tem o MENOR t) rendem o MESMO
    // .grupo-tempo que a mesma sequência em ordem — prova que ultimoT é o maior VÁLIDO.
    const g18a = carregarCliente();
    g18a.aplicar({ tipo: 'ferramenta', id: 'a1', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:00.000Z' });
    g18a.aplicar({ tipo: 'ferramenta', id: 'a2', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:01.000Z' });
    g18a.aplicar({ tipo: 'ferramenta', id: 'a3', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:02.000Z' });
    g18a.aplicar({ tipo: 'resultado_ferramenta', id: 'a1', saida: 'ok', t: '2026-09-04T10:00:03.000Z' });
    g18a.aplicar({ tipo: 'resultado_ferramenta', id: 'a2', saida: 'ok', t: '2026-09-04T10:00:04.000Z' });
    g18a.aplicar({ tipo: 'resultado_ferramenta', id: 'a3', saida: 'ok', t: '2026-09-04T10:00:10.000Z' });
    const tempo18a = porIdDe(g18a, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas')
      ?.querySelector('.grupo-tempo')?.textContent;
    const g18b = carregarCliente();
    g18b.aplicar({ tipo: 'ferramenta', id: 'b1', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:00.000Z' });
    g18b.aplicar({ tipo: 'ferramenta', id: 'b2', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:01.000Z' });
    g18b.aplicar({ tipo: 'ferramenta', id: 'b3', nome: 'Read', entrada: {}, t: '2026-09-04T10:00:02.000Z' });
    g18b.aplicar({ tipo: 'resultado_ferramenta', id: 'b3', saida: 'ok', t: '2026-09-04T10:00:10.000Z' });
    g18b.aplicar({ tipo: 'resultado_ferramenta', id: 'b2', saida: 'ok', t: '2026-09-04T10:00:04.000Z' });
    g18b.aplicar({ tipo: 'resultado_ferramenta', id: 'b1', saida: 'ok', t: '2026-09-04T10:00:03.000Z' });
    const tempo18b = porIdDe(g18b, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas')
      ?.querySelector('.grupo-tempo')?.textContent;
    tudoOk &= ok(tempo18a === tempo18b && tempo18a === '10s',
      `FG-18: mesmo tempo em ordem e fora de ordem (${tempo18a} vs ${tempo18b})`);

    // FG-19: a PRIMEIRA ferramenta promovida está registrada no estado do grupo desde já.
    const g19 = carregarCliente();
    g19.aplicar({ tipo: 'ferramenta', id: 'fg19-1', nome: 'Read', entrada: {} });
    g19.aplicar({ tipo: 'ferramenta', id: 'fg19-2', nome: 'Bash', entrada: {} });
    const grupo19 = porIdDe(g19, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(grupo19?.querySelector('.grupo-conta')?.textContent === '2 passos',
      `FG-19: cabeçalho diz "2 passos" já na segunda ferramenta (${grupo19?.querySelector('.grupo-conta')?.textContent})`);
    tudoOk &= ok(grupo19?.querySelector('.grupo-tipos')?.textContent === 'Read · Bash',
      `FG-19: os dois nomes aparecem em .grupo-tipos (${grupo19?.querySelector('.grupo-tipos')?.textContent})`);
    g19.aplicar({ tipo: 'resultado_ferramenta', id: 'fg19-1', erro: true, saida: 'falhou' });
    tudoOk &= ok(grupo19?.dataset.grupoEstado === 'erro',
      'FG-19: e o PRIMEIRO passo tem .grupo apontando pro grupo — erro nele já muda data-grupo-estado');

    // FG-20: fechamento tardio — separador com passos ainda rodando NÃO fecha na hora; o
    // resultado que COMPLETA o grupo é o que também o fecha. Contraprova: tocado não fecha.
    const g20 = carregarCliente();
    g20.aplicar({ tipo: 'ferramenta', id: 'fg20-1', nome: 'Read', entrada: {} });
    g20.aplicar({ tipo: 'ferramenta', id: 'fg20-2', nome: 'Read', entrada: {} });
    g20.aplicar({ tipo: 'texto', texto: 'fala no meio, os dois ainda rodando' });
    const grupo20 = porIdDe(g20, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    tudoOk &= ok(grupo20?.open === true, 'FG-20: separador com passos ainda rodando NÃO fecha na hora');
    g20.aplicar({ tipo: 'resultado_ferramenta', id: 'fg20-1', saida: 'ok' });
    tudoOk &= ok(grupo20?.open === true, 'FG-20: primeiro resultado ainda não fecha (o segundo ainda roda)');
    g20.aplicar({ tipo: 'resultado_ferramenta', id: 'fg20-2', saida: 'ok' });
    tudoOk &= ok(grupo20?.open === false, 'FG-20: o resultado que completa o grupo TAMBÉM o fecha');
    const g20b = carregarCliente();
    g20b.aplicar({ tipo: 'ferramenta', id: 'fg20b-1', nome: 'Read', entrada: {} });
    g20b.aplicar({ tipo: 'ferramenta', id: 'fg20b-2', nome: 'Read', entrada: {} });
    g20b.aplicar({ tipo: 'texto', texto: 'fala no meio' });
    const grupo20b = porIdDe(g20b, 'fita').filhos.find((f) => f.className === 'grupo-ferramentas');
    grupo20b?.querySelector('.grupo-resumo')?.disparar('click', {});
    g20b.aplicar({ tipo: 'resultado_ferramenta', id: 'fg20b-1', saida: 'ok' });
    g20b.aplicar({ tipo: 'resultado_ferramenta', id: 'fg20b-2', saida: 'ok' });
    tudoOk &= ok(grupo20b?.open === true, 'FG-20: contraprova — com data-tocado="1" o grupo NÃO fecha sozinho');
  });

  await rodarGrupo('· conversa: transições', async () => {
    const blocosFt = cor.blocos(cssSemComentario);
    // Selector de `cor.blocos` não separa listas por vírgula — compara pelo conjunto exato.
    const temSeletor = (b, sel) => b.seletor.split(',').map((s) => s.trim()).includes(sel);
    const msDe = (corpo) => [...String(corpo).matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
    const maxMs = (corpo) => Math.max(0, ...msDe(corpo));

    // FT-1: .chat no bloco de celular tem transition com transform de 200ms; existe
    // @starting-style para a entrada.
    const chatCelular = blocosFt.find((b) => b.seletor === '.chat' && b.dentroDe === '@media (max-width: 760px)');
    tudoOk &= ok(Boolean(chatCelular) && /transition\s*:[^;]*transform[^;]*200ms/.test(chatCelular.corpo),
      'FT-1: .chat no celular tem transition com transform de 200ms');
    const startingChat = blocosFt.find((b) => temSeletor(b, '.app[data-vista="chat"] .chat') && /@starting-style/.test(b.dentroDe));
    tudoOk &= ok(Boolean(startingChat), 'FT-1: existe @starting-style para .app[data-vista="chat"] .chat');

    // FT-2: dialog[open] tem transform: none (não scale(1)) e transição de 160ms; existe
    // regra para ::backdrop.
    const dialogOpen = blocosFt.find((b) => b.seletor === 'dialog[open]');
    tudoOk &= ok(Boolean(dialogOpen) && /transform\s*:\s*none/.test(dialogOpen.corpo),
      'FT-2: dialog[open] tem transform: none (não scale(1))');
    const dialogTransicao = blocosFt.find((b) => b.seletor === 'dialog' && /transition/.test(b.corpo));
    tudoOk &= ok(Boolean(dialogTransicao) && /160ms/.test(dialogTransicao.corpo),
      'FT-2: dialog tem transição de 160ms');
    const backdropTransicao = blocosFt.find((b) => b.seletor === 'dialog::backdrop' && /transition/.test(b.corpo));
    tudoOk &= ok(Boolean(backdropTransicao), 'FT-2: existe regra de transição para ::backdrop');

    // FT-3: .bolha-eu tem transition de opacity de 300ms.
    const bolhaEuBloco = blocosFt.find((b) => b.seletor === '.bolha-eu');
    tudoOk &= ok(Boolean(bolhaEuBloco) && /transition\s*:[^;]*opacity[^;]*300ms/.test(bolhaEuBloco.corpo),
      'FT-3: .bolha-eu tem transition de opacity de 300ms');

    // FT-4: .fer-estado tem transition: color de 240ms.
    const ferEstadoBloco = blocosFt.find((b) => b.seletor === '.fer-estado');
    tudoOk &= ok(Boolean(ferEstadoBloco) && /transition\s*:[^;]*color[^;]*240ms/.test(ferEstadoBloco.corpo),
      'FT-4: .fer-estado tem transition: color de 240ms');

    // FT-5a (sempre exigida): .faixa-jobs tem transition com opacity e transform de 180ms,
    // e existe @starting-style para a entrada.
    const faixaBloco = blocosFt.find((b) => b.seletor === '.faixa-jobs' && /transition/.test(b.corpo));
    tudoOk &= ok(Boolean(faixaBloco) && /opacity[^;]*180ms/.test(faixaBloco.corpo) && /transform[^;]*180ms/.test(faixaBloco.corpo),
      'FT-5a: .faixa-jobs tem transition com opacity e transform de 180ms');
    const startingFaixa = blocosFt.find((b) => temSeletor(b, '.faixa-jobs:not([hidden])') && /@starting-style/.test(b.dentroDe));
    tudoOk &= ok(Boolean(startingFaixa), 'FT-5a: existe @starting-style para a entrada da .faixa-jobs');

    // FT-5b (só com T5_SAIDA === 'animada'): três estados, não dois — ver a Fase 0 do plano
    // e o relatório do job. A bancada mediu allow-discrete VENCENDO o [hidden]!important
    // (displayT60 === 'flex'), mas com um salto de layout de 48px (>8px) no colapso final —
    // nem caminho A nem caminho B da spec: é o terceiro cenário que o plano manda declarar
    // como NÃO VERIFICADO em vez de escolher sozinho.
    const T5_SAIDA = 'nao-verificada:bancada da Fase 0 mediu allow-discrete vencendo o !important (displayT60=flex), mas com salto de layout de 48px (>8px) no colapso final — nem caminho A nem B; ver relatório do job f49b';
    if (T5_SAIDA === 'animada') {
      const faixaHidden = blocosFt.find((b) => b.seletor === '.faixa-jobs[hidden]');
      tudoOk &= ok(Boolean(faixaHidden) && /opacity\s*:\s*0/.test(faixaHidden.corpo)
        && /transform\s*:\s*translateY\(-6px\)/.test(faixaHidden.corpo),
        'FT-5b: existe .faixa-jobs[hidden] com opacity: 0 e transform: translateY(-6px)');
      tudoOk &= ok(Boolean(faixaBloco) && /display[^;]*allow-discrete/.test(faixaBloco.corpo),
        'FT-5b: a transition inclui display … allow-discrete');
    } else if (T5_SAIDA === 'caminho-b') {
      console.log('  ⚠️ FT-5b: saída de T5 NÃO animada — a bancada da Fase 0 mediu caminho B');
    } else {
      console.log(`  ⚠️ FT-5b: saída de T5 NÃO VERIFICADA — ${T5_SAIDA.replace('nao-verificada:', '')}`);
    }

    // FT-6: as três transições de MOVIMENTO (.chat, dialog, .faixa-jobs) declaram <=220ms;
    // .bolha-eu declara 300ms e .fer-estado 240ms; nenhuma regra do arquivo passa de 300ms.
    tudoOk &= ok(Boolean(chatCelular) && maxMs(chatCelular.corpo) <= 220,
      `FT-6: .chat declara <=220ms (${chatCelular && maxMs(chatCelular.corpo)})`);
    tudoOk &= ok(Boolean(dialogTransicao) && maxMs(dialogTransicao.corpo) <= 220,
      `FT-6: dialog declara <=220ms (${dialogTransicao && maxMs(dialogTransicao.corpo)})`);
    tudoOk &= ok(Boolean(faixaBloco) && maxMs(faixaBloco.corpo) <= 220,
      `FT-6: .faixa-jobs declara <=220ms (${faixaBloco && maxMs(faixaBloco.corpo)})`);
    tudoOk &= ok(Boolean(bolhaEuBloco) && msDe(bolhaEuBloco.corpo).includes(300), 'FT-6: .bolha-eu declara 300ms');
    tudoOk &= ok(Boolean(ferEstadoBloco) && msDe(ferEstadoBloco.corpo).includes(240), 'FT-6: .fer-estado declara 240ms');
    // O teto de 300ms vale para as TRANSIÇÕES da folha, não para o arquivo inteiro: o spinner
    // do gesto (`animation: puxar-girar 720ms linear infinite`, estilo.css:429) é laço infinito,
    // não transição, e as duas regras `[data-voltando="1"]` (320ms) são a volta do gesto, que já
    // estava no código antes deste job. Varrer `animation` junto reprovaria o pré-existente.
    const msDeTransicoes = (corpo) => String(corpo).split(';')
      .filter((d) => /^\s*transition\s*:/.test(d))
      .flatMap((d) => msDe(d));
    const todasMs = blocosFt
      .filter((b) => !/data-voltando/.test(b.seletor))
      .flatMap((b) => msDeTransicoes(b.corpo));
    tudoOk &= ok(todasMs.every((v) => v <= 300), `FT-6: nenhuma transição nova passa de 300ms (máx ${Math.max(0, ...todasMs)})`);

    // FT-7: existe bloco prefers-reduced-motion desligando transition de dialog,
    // dialog::backdrop, .faixa-jobs, .bolha-eu, .fer-estado e .chat.
    const desligaEm = (sel) => blocosFt.some((b) => temSeletor(b, sel) && /prefers-reduced-motion/.test(b.dentroDe)
      && /transition\s*:\s*none/.test(b.corpo));
    for (const sel of ['dialog', 'dialog::backdrop', '.faixa-jobs', '.bolha-eu', '.fer-estado', '.chat']) {
      tudoOk &= ok(desligaEm(sel), `FT-7: prefers-reduced-motion desliga transition de ${sel}`);
    }

    // FT-8 — a proibição, em três camadas.
    // 1. Conjunto NOMINAL de @keyframes — exatamente os quatro que já existiam.
    const nomesKeyframes = [...cssSemComentario.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    const conjuntoKeyframes = new Set(nomesKeyframes);
    const esperadoKeyframes = new Set(['girando', 'puxar-girar', 'entrar', 'pulsar']);
    const keyframesIguais = conjuntoKeyframes.size === esperadoKeyframes.size
      && [...esperadoKeyframes].every((n) => conjuntoKeyframes.has(n));
    tudoOk &= ok(keyframesIguais,
      `FT-8.1: o conjunto de @keyframes é exatamente {girando, puxar-girar, entrar, pulsar} (achado: {${[...conjuntoKeyframes].join(', ')}})`);
    // 2. Direto nos alvos onde skeleton/"digitando"/confete teriam de morar. `.grupo-ferramentas`
    //    já usa `entrar` (a MESMA entrada que `.ferramenta`/`.bolha-eu` sempre tiveram, spec
    //    §3.4) — não é a proibição; o que se proíbe é um efeito NOVO nesses alvos.
    const alvosProibidos = blocosFt.filter((b) => /\.grupo-|\.passo|\.fer-estado|\.bolha-pendente|\.fita\b/.test(b.seletor));
    const comAnimacaoIndevida = alvosProibidos.filter((b) => {
      const m = b.corpo.match(/animation\s*:\s*([^;]+)/);
      if (!m) return false;
      // `!important` faz parte do valor no match e não da declaração: `animation: none !important`
      // (estilo.css:905, o bloco de prefers-reduced-motion) é `none` e não um efeito novo.
      const valor = m[1].replace(/\s*!important\s*$/, '').trim();
      return valor !== 'none' && !/^entrar\b/.test(valor);
    });
    tudoOk &= ok(comAnimacaoIndevida.length === 0,
      `FT-8.2: nenhum alvo proibido declara animation nova (achado: ${comAnimacaoIndevida.map((b) => b.seletor).join('; ') || 'nenhum'})`);
    // 3. Strings: nada de "digitando…" como texto/classe nova, nem "skeleton"/"confete" no CSS.
    tudoOk &= ok(!/['"`]\s*digitando/i.test(fonteBruta), 'FT-8.3: o cliente não ganha "digitando…" como texto novo');
    tudoOk &= ok(!/skeleton/i.test(cssSemComentario) && !/confete/i.test(cssSemComentario),
      'FT-8.3: o CSS não ganha "skeleton" nem "confete"');

    // FT-9 (R2): a regra .chat do celular tem LITERALMENTE transform: none no repouso, e
    // nenhuma regra nova aplica transform a #mensagens.
    tudoOk &= ok(Boolean(chatCelular) && /transform\s*:\s*none/.test(chatCelular.corpo),
      'FT-9: .chat no celular tem transform: none no repouso');
    const mensagensComTransform = blocosFt.filter((b) => temSeletor(b, '#mensagens') && /transform\s*:/.test(b.corpo));
    tudoOk &= ok(mensagensComTransform.length === 0, 'FT-9: nenhuma regra nova aplica transform a #mensagens');

    // FT-10 (R5): .grupo-ferramentas está nas DUAS listas — [data-pintando] e reduced-motion
    // — e .ferramenta.passo tem animation: none.
    const pintandoComGrupo = blocosFt.find((b) => temSeletor(b, '.mensagens[data-pintando] .grupo-ferramentas'));
    tudoOk &= ok(Boolean(pintandoComGrupo), 'FT-10: .grupo-ferramentas está na lista do .mensagens[data-pintando]');
    const reducedComGrupo = blocosFt.find((b) => temSeletor(b, '.grupo-ferramentas') && /prefers-reduced-motion/.test(b.dentroDe)
      && /animation\s*:\s*none/.test(b.corpo));
    tudoOk &= ok(Boolean(reducedComGrupo), 'FT-10: .grupo-ferramentas está na lista do prefers-reduced-motion');
    const passoSemAnimacao = blocosFt.find((b) => b.seletor === '.ferramenta.passo' && /animation\s*:\s*none/.test(b.corpo));
    tudoOk &= ok(Boolean(passoSemAnimacao), 'FT-10: .ferramenta.passo tem animation: none');

    // FT-11: .grupo-resumo declara por extenso as DEZ propriedades da casca de
    // .ferramenta summary, com os mesmos valores, e NÃO está agrupada por vírgula com ele
    // (o match exato de seletor abaixo já garante isso: se estivesse agrupada, não haveria
    // bloco com seletor === '.grupo-resumo').
    const propsDe = (corpo) => {
      const mapa = {};
      for (const m of String(corpo).matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)) mapa[m[1].trim()] = m[2].trim();
      return mapa;
    };
    const PROPRIEDADES_CASCA = ['cursor', 'list-style', 'color', 'padding', 'border', 'border-radius', 'background', 'display', 'align-items', 'gap'];
    const grupoResumoBloco = blocosFt.find((b) => b.seletor === '.grupo-resumo');
    const ferramentaSummaryBloco = blocosFt.find((b) => b.seletor === '.ferramenta summary');
    const pResumo = grupoResumoBloco ? propsDe(grupoResumoBloco.corpo) : {};
    const pFerramenta = ferramentaSummaryBloco ? propsDe(ferramentaSummaryBloco.corpo) : {};
    const divergentes = PROPRIEDADES_CASCA.filter((p) => pResumo[p] !== pFerramenta[p]);
    tudoOk &= ok(Boolean(grupoResumoBloco) && Boolean(ferramentaSummaryBloco) && divergentes.length === 0,
      `FT-11: .grupo-resumo espelha as dez propriedades de .ferramenta summary, sem seletor compartilhado (divergem: ${divergentes.join(', ') || 'nenhuma'})`);

    // FT-12 (achado 2 da sétima rodada): existe .chat:has(.pergunta:not([hidden])) com
    // transform: none E transition: none, dentro do bloco de celular.
    const hasBloco = blocosFt.find((b) => b.seletor === '.chat:has(.pergunta:not([hidden]))' && b.dentroDe === '@media (max-width: 760px)');
    tudoOk &= ok(Boolean(hasBloco) && /transform\s*:\s*none/.test(hasBloco.corpo) && /transition\s*:\s*none/.test(hasBloco.corpo),
      'FT-12: .chat:has(.pergunta:not([hidden])) desliga transform e transition, dentro do bloco de celular');
  });

  // ── Fase 2 (04/09): as cinco miudezas ───────────────────────────────────────
  console.log('\n  · M2: os 9 SVGs de botão');
  // Split view, fase 2: três destes ícones (←, ↻, ✕) migraram do HTML para `criarPainel`
  // (app.js) — a contagem soma o que sobrou no HTML com o que o painel monta em JS.
  const totalIconeBotaoHtml = (html.match(/<svg class="icone-botao"/g) || []).length;
  const clienteIcones = carregarCliente();
  const totalIconeBotaoPainel = painelDe(clienteIcones).querySelectorAll('.icone-botao').length;
  tudoOk &= ok(totalIconeBotaoHtml + totalIconeBotaoPainel === 9,
    `A9: 9 svg.icone-botao ao todo — HTML + painel (${totalIconeBotaoHtml} + ${totalIconeBotaoPainel})`);
  const GLIFOS_ANTIGOS = ['&#8635;', '&#9881;', '&#43;', '&#8645;', '&#9776;', '&#8592;', '&#10005;', '&#128206;'];
  const glifosQueSobraram = GLIFOS_ANTIGOS.filter((g) => html.includes(g));
  tudoOk &= ok(glifosQueSobraram.length === 0,
    `A9: nenhum dos 8 glifos antigos sobrou (${glifosQueSobraram.join(', ') || 'nenhum'})`);

  console.log('\n  · M1: o placeholder por LARGURA, não por ponteiro');
  // `pintarPlaceholder` não existe no develop — isolado em `rodarGrupo` (como as FT-* de
  // cima) para o gate não estourar inteiro e esconder o vermelho de A11 em diante.
  await rodarGrupo('A10', async () => {
    const clienteA10 = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: memoria() });
    // A régua mudou em 09/09 e a mudança é o conserto de um defeito que o PNG pegou e o gate
    // não: até aqui a pergunta era `matchMedia('(max-width: 760px)')`, a largura da JANELA.
    // Com N painéis lado a lado numa janela de 1600px, isso responde "largo" para um painel de
    // 320px — e o texto longo saía quebrado em duas linhas dentro de um textarea de 44px, com
    // a segunda CORTADA AO MEIO (visto em split-6-paineis.png).
    // A régua final é a largura da CAIXA (`entrada.clientWidth`), não a do painel: um painel
    // de 360px no desktop tem 24px de padding de cada lado e um celular de 360px tem 14px —
    // mesma largura de painel, larguras de caixa diferentes. Os números abaixo são MEDIDOS
    // (`medidas-*.json` dos smokes), não escolhidos. O DOM falso não faz layout, então quem
    // escreve `clientWidth` aqui é o teste — como já faz com `scrollTop`/`scrollHeight`.
    tudoOk &= ok(porIdDe(clienteA10, 'entrada').placeholder === 'Escreva para o agente',
      `A10: SEM largura medida (nasceu fora da tela, ou o DOM falso) cai no texto CURTO — o único que cabe em qualquer largura. Escolher o longo aqui foi o que cortou o placeholder do celular em 09/09 (${porIdDe(clienteA10, 'entrada').placeholder})`);
    porIdDe(clienteA10, 'entrada').clientWidth = 232;   // o CELULAR de 390px — MEDIDO, medidas-390.json
    clienteA10.pintarPlaceholderNo(clienteA10.painelAtual());
    tudoOk &= ok(porIdDe(clienteA10, 'entrada').placeholder === 'Escreva para o agente',
      `A10: caixa do CELULAR (232px, medido) mostra o texto curto — o de hoje, zero mudança lá (${porIdDe(clienteA10, 'entrada').placeholder})`);
    porIdDe(clienteA10, 'entrada').clientWidth = 165;   // a caixa de um split de 6 — nem o curto cabe
    clienteA10.pintarPlaceholderNo(clienteA10.painelAtual());
    tudoOk &= ok(porIdDe(clienteA10, 'entrada').placeholder === 'Mensagem',
      `A10: caixa MUITO estreita (165px) cai no terceiro nível — nem o curto cabia, e cortado ao meio é pior que curto (${porIdDe(clienteA10, 'entrada').placeholder})`);
    porIdDe(clienteA10, 'entrada').clientWidth = 870;   // um painel só no desktop — MEDIDO, medidas-1600.json
    clienteA10.pintarPlaceholderNo(clienteA10.painelAtual());
    tudoOk &= ok(porIdDe(clienteA10, 'entrada').placeholder === 'Escreva para o agente, ou / para comandos e skills',
      `A10: caixa LARGA (870px, medido) volta ao texto completo (${porIdDe(clienteA10, 'entrada').placeholder})`);
    // R5/#40: "um dono só do texto" precisa de DOIS asserts — nem um sozinho prova a
    // EXCLUSIVIDADE. Na árvore: ninguém chumbou o texto no MARKUP (getAttribute lê os
    // atributos, não a propriedade que o painter escreveu).
    tudoOk &= ok(porIdDe(clienteA10, 'entrada').getAttribute('placeholder') === undefined,
      'A10: o textarea nasce SEM o atributo placeholder no markup — quem escreve é o JS');
  });
  // No fonte: prova a EXCLUSIVIDADE que o DOM falso não vê — uma segunda escrita em
  // `.placeholder`, sobrescrita depois pelo painter, passaria despercebida na árvore.
  // Depende de `pintarPlaceholderNo` ser o ÚNICO símbolo que escreve `.placeholder`.
  // Conta DONO, não linha: `pintarPlaceholderNo` tem três níveis desde 09/09 (largo / curto /
  // "Mensagem"), então são três escritas — mas todas dentro DELE. Contar `=== 1` era contar
  // linha, e reprovaria um quarto nível legítimo enquanto deixaria passar uma escrita solta
  // noutra função. Depende do símbolo `pintarPlaceholderNo` (ARMADILHA #53: quem renomear tem
  // de achar isto). `assert` de fatia com o indexOf conferido — `-1` fatiaria pedaço aleatório.
  const iniPP = fonteBruta.indexOf('function pintarPlaceholderNo');
  // Fecha no PRIMEIRO `\n}` de coluna zero, que é o fim da própria função — não na próxima
  // `\nfunction `. A diferença não é estética: entre `pintarPlaceholderNo` e a função seguinte
  // mora o `const observadorDeLargura = new ResizeObserver(...)`, e o callback dele escreve
  // placeholder. Com o delimitador antigo essa escrita entrava na fatia e o assert dizia que
  // ela "mora em pintarPlaceholderNo" — mensagem que não sustentava o que media. Apontado pelo
  // painel de execução.
  const fimPP = fonteBruta.indexOf('\n}', iniPP + 1);
  const corpoPP = iniPP >= 0 && fimPP > iniPP ? fonteBruta.slice(iniPP, fimPP + 2) : '';
  const escritasTotal = (fonteBruta.match(/(?:\.placeholder\s*=|idiomaUI\.bind\([^,]+, 'placeholder',)/g) || []).length;
  const escritasNoDono = (corpoPP.match(/(?:\.placeholder\s*=|idiomaUI\.bind\([^,]+, 'placeholder',)/g) || []).length;
  tudoOk &= ok(corpoPP !== '' && escritasTotal > 0 && escritasTotal === escritasNoDono,
    `A10: TODA escrita de .placeholder mora em pintarPlaceholderNo — um dono só (R5/#40) (${escritasNoDono}/${escritasTotal})`);
  tudoOk &= ok(!/placeholder=/.test(html),
    'A10: o atributo placeholder saiu do index.html — o JS é o dono único (R5/#40)');

  console.log('\n  · M3: o resumo de relance na tela vazia');
  const abasA11 = [
    ...['s1', 's2'].map((id) => ({ chave: `aba-${id}`, titulo: id, cwd: '/tmp', temAgente: true, rodando: true, sessaoId: id, atualizadoEm: 2000 })),
    ...['s3', 's4', 's5'].map((id) => ({ chave: `aba-${id}`, titulo: id, cwd: '/tmp', temAgente: true, rodando: false, sessaoId: id, atualizadoEm: 2000 })),
    ...['s6', 's7', 's8', 's9'].map((id) => ({ chave: `aba-${id}`, titulo: id, cwd: '/tmp', temAgente: true, rodando: false, sessaoId: id, atualizadoEm: 500 })),
  ];
  const guardadoA11 = memoria();
  guardadoA11.setItem('cockpit-lidas', JSON.stringify(Object.fromEntries(abasA11.map((a) => [a.sessaoId, 1000]))));
  const desdeJobA11 = new Date(Date.now() - 5 * 60000).toISOString();
  const jobA11 = { id: 'job-1', titulo: 'ship x', projeto: 'x', estado: 'running', abas: [], desde: desdeJobA11 };
  const aoBuscarA11 = (rota) => {
    if (/api\/abas/.test(rota)) return { abas: abasA11 };
    if (/api\/jobs/.test(rota)) return { painel: true, jobs: [jobA11] };
    return { painel: true, jobs: [] };
  };
  const clienteA11 = carregarCliente({ aoBuscar: aoBuscarA11, guardado: guardadoA11 });
  await clienteA11.carregarAbas();
  await clienteA11.atualizarFaixaJobs();
  tudoOk &= ok(porIdDe(clienteA11, 'vazio-resumo').textContent === '2 trabalhando · 3 te esperando · 1 job rodando há 5 min',
    `A11: o resumo bate ao caractere (${porIdDe(clienteA11, 'vazio-resumo').textContent})`);

  console.log('\n  · M3: o terceiro segmento, sozinho');
  let modoJobsA11b = 'com-job';
  const aoBuscarA11b = (rota) => {
    if (/api\/abas/.test(rota)) return { abas: abasA11 };
    if (/api\/jobs/.test(rota)) {
      if (modoJobsA11b === 'sem-job') return { painel: true, jobs: [] };
      if (modoJobsA11b === 'painel-false') return { painel: false };
      return { painel: true, jobs: [jobA11] };
    }
    return { painel: true, jobs: [] };
  };
  const guardadoA11b = memoria();
  guardadoA11b.setItem('cockpit-lidas', JSON.stringify(Object.fromEntries(abasA11.map((a) => [a.sessaoId, 1000]))));
  const clienteA11b = carregarCliente({ aoBuscar: aoBuscarA11b, guardado: guardadoA11b });
  await clienteA11b.carregarAbas();
  modoJobsA11b = 'sem-job';
  await clienteA11b.atualizarFaixaJobs();
  tudoOk &= ok(porIdDe(clienteA11b, 'vazio-resumo').textContent === '2 trabalhando · 3 te esperando',
    `A11b: sem job rodando, a frase tem dois pedaços (${porIdDe(clienteA11b, 'vazio-resumo').textContent})`);
  modoJobsA11b = 'com-job';
  await clienteA11b.atualizarFaixaJobs();
  tudoOk &= ok(porIdDe(clienteA11b, 'vazio-resumo').textContent === '2 trabalhando · 3 te esperando · 1 job rodando há 5 min',
    `A11b: com job, a frase tem três pedaços (${porIdDe(clienteA11b, 'vazio-resumo').textContent})`);
  modoJobsA11b = 'painel-false';
  await clienteA11b.atualizarFaixaJobs();
  tudoOk &= ok(porIdDe(clienteA11b, 'vazio-resumo').textContent === '2 trabalhando · 3 te esperando',
    `A11b: painel:false volta a dois pedaços, sem apagar os outros dois números (${porIdDe(clienteA11b, 'vazio-resumo').textContent})`);

  console.log('\n  · M3: sem aba nenhuma, o resumo fica vazio');
  const clienteA11c = carregarCliente({ aoBuscar: () => ({ abas: [] }), guardado: memoria() });
  await clienteA11c.carregarAbas();
  tudoOk &= ok(porIdDe(clienteA11c, 'vazio-resumo').textContent === '',
    'A11c: sem aba nenhuma, #vazio-resumo fica vazio');
  const blocoVazioHtml = (html.match(/<div class="vazio" id="vazio">([\s\S]*?)<\/div>/) || ['', ''])[1];
  tudoOk &= ok(/<p class="vazio-resumo" id="vazio-resumo">/.test(blocoVazioHtml)
    && /<h2>Escolha uma conversa<\/h2>/.test(blocoVazioHtml)
    && /class="vazio-nota"/.test(blocoVazioHtml),
  'A11c: e os dois parágrafos de ajuda continuam na tela, junto com #vazio-resumo');

  console.log('\n  · M4: #btn-parar ganha #parar-rotulo');
  // Split view, fase 2: `.parar-rotulo` migrou do HTML para `criarPainel` — prova por DOM.
  const clienteParar = carregarCliente();
  tudoOk &= ok(porIdDe(clienteParar, 'btn-parar').querySelector('.parar-rotulo') !== null,
    'A12: .btn-parar tem um .parar-rotulo dentro');
  tudoOk &= ok(!/\$\('btn-parar'\)\.textContent/.test(fonteAjustes),
    "A12: o texto de app.js não contém mais $('btn-parar').textContent (R2 — a fonte prova, não o comportamento)");
  const clienteA12 = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: memoria() });
  await clienteA12.carregarAbas();
  await clienteA12.abrirAba('aba-7');
  clienteA12.marcarPergunta(clienteA12.painelAtual(), true);
  tudoOk &= ok(porIdDe(clienteA12, 'parar-rotulo').textContent === 'Cancelar pergunta',
    `A12: marcarPergunta escreve no #parar-rotulo (${porIdDe(clienteA12, 'parar-rotulo').textContent})`);
  clienteA12.marcarPergunta(clienteA12.painelAtual(), false);
  tudoOk &= ok(porIdDe(clienteA12, 'parar-rotulo').textContent === 'Parar',
    'A12: e volta a dizer Parar');

  console.log('\n  · M5: bolha longa recolhe (>12 linhas)');
  const texto12Linhas = Array.from({ length: 12 }, (_, i) => `linha ${i + 1}`).join('\n');
  const texto13Linhas = Array.from({ length: 13 }, (_, i) => `linha ${i + 1}`).join('\n');
  // `pintarTextoDaBolha` não existe no develop — isolado em `rodarGrupo` pelo mesmo motivo
  // do A10: sem isto o estouro escondia o vermelho do resto (A14 incluído).
  await rodarGrupo('A13', async () => {
    const clienteA13 = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: memoria() });
    const el12 = clienteA13.document.createElement('div');
    clienteA13.pintarTextoDaBolha(el12, texto12Linhas);
    tudoOk &= ok(el12.textContent === texto12Linhas && el12.children.length === 0,
      'A13: bolha de 12 linhas continua div com textContent cru, byte a byte');
    const el13 = clienteA13.document.createElement('div');
    clienteA13.pintarTextoDaBolha(el13, texto13Linhas);
    const detalhe13 = el13.children[0];
    tudoOk &= ok(Boolean(detalhe13) && detalhe13.tag === 'details' && /ver tudo/.test(el13.textContent),
      'A13: bolha de 13 linhas vira <details> com "ver tudo"');
    // O caminho da absorção (R3): a bolha pendente nasce curta e volta do disco com 13 linhas.
    const envA13 = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: memoria() });
    const fitaA13 = porIdDe(envA13, 'fita');
    fitaA13.filhos = [];
    // O casamento é por TEXTO (`absorverPendente`, armadilha #21): o rascunho pendente
    // precisa ser igual ou SUFIXO do texto que volta do disco. Uma última linha basta.
    const minhaA13 = envA13.marcarPendente(envA13.bolha('bolha-eu', 'linha 13'), 'linha 13');
    envA13.aplicar({ tipo: 'humano', texto: texto13Linhas });
    const detalheAbsorvido = minhaA13.children[0];
    tudoOk &= ok(Boolean(detalheAbsorvido) && detalheAbsorvido.tag === 'details' && /ver tudo/.test(minhaA13.textContent),
      'A13: o caminho da absorção (absorverPendente) também recolhe, não só o desenho direto');
  });

  console.log('\n  · M4: a borda âmbar do Parar (R6)');
  const blocoBtnParar = cor.blocos(css).find((b) => b.seletor === '.btn-parar' && /border-color:\s*var\(--accent\)/.test(b.corpo));
  tudoOk &= ok(Boolean(blocoBtnParar), 'A14: .btn-parar tem border-color: var(--accent) no CSS');
  const reprovamRepouso = [];
  for (const t of paletas) {
    const accent = t.variaveis['--accent'];
    const fundo3 = t.variaveis['--fundo-3'] || paletas[0].variaveis['--fundo-3'];
    if (!accent) continue;
    const razao = cor.contraste(accent, fundo3);
    if (!(razao >= 3)) reprovamRepouso.push(`${t.rotulo} ${razao === null ? '?' : razao.toFixed(2)}:1`);
  }
  tudoOk &= ok(reprovamRepouso.length === 0,
    `A14: --accent sobre --fundo-3 (repouso — o estado que vale no celular) passa 3:1 nas dez paletas${reprovamRepouso.length ? ` — reprovam: ${reprovamRepouso.join('; ')}` : ''}`);
  // O :hover só existe com mouse, e nele o botão continua com o rótulo textual "Parar" — a
  // borda é reforço, nunca o único sinal. Limite CONHECIDO, impresso e não travado (R6).
  const hoverInfo = paletas.map((t) => {
    const accent = t.variaveis['--accent'];
    const borda = t.variaveis['--borda'] || paletas[0].variaveis['--borda'];
    const razao = accent ? cor.contraste(accent, borda) : null;
    return `${t.rotulo} ${razao === null ? '?' : razao.toFixed(2)}:1`;
  });
  console.log(`  ℹ A14: hover (--accent × --borda), limite conhecido, não travado: ${hoverInfo.join('; ')}`);

  // ── Fase 2b (04/09): a tela de tokens dentro do app ─────────────────────────
  // A7 e A22 moram AQUI, não no gate-uso.js (ponto 3 do painel da fase 2b) — são os dois
  // que protegem a #39/D32, e o gate-ui.js já tem o `voltarDoAparelho` e o `carregarCliente`
  // que os dois precisam.
  console.log('\n  · fase 2b: #btn-uso não usa mais window.open nem empilha histórico (#39)');
  await rodarGrupo('A7', async () => {
    const clienteA7 = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: memoria(), comUso: true });
    const pilhaAntesA7 = clienteA7.history.pilha.length;
    tudoOk &= ok(typeof porIdDe(clienteA7, 'btn-uso').onclick === 'function', 'A7: #btn-uso tem onclick de verdade');
    porIdDe(clienteA7, 'btn-uso').onclick();
    tudoOk &= ok(porIdDe(clienteA7, 'dialogo-uso').open === true, 'A7: o clique ABRE #dialogo-uso (showModal)');
    tudoOk &= ok(clienteA7.chamadasWindowOpen.length === 0,
      `A7: e window.open NÃO é mais chamado (${clienteA7.chamadasWindowOpen.length})`);
    tudoOk &= ok(clienteA7.history.pilha.length === pilhaAntesA7,
      'A7: nem empilha pushState (#39/D32) — o voltar do Android tem que fechar, não sair');
  });

  console.log('\n  · fase 2b: o voltar do Android por cima de #dialogo-uso (A22)');
  await rodarGrupo('A22', async () => {
    const voltarDoAparelhoA22 = (cliente) => {
      const modais = [...cliente.porId.values()].filter((el) => el.open);
      if (modais.length) { modais.sort((a, b) => b.abertoEm - a.abertoEm)[0].close(); return; }
      cliente.history.back();
    };
    const clienteA22 = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: memoria(), comUso: true });
    await clienteA22.carregarAbas();
    await clienteA22.abrirAba('aba-7');
    const pilhaNaConversaA22 = clienteA22.history.pilha.length;
    porIdDe(clienteA22, 'btn-config').onclick();
    porIdDe(clienteA22, 'btn-uso').onclick();
    tudoOk &= ok(clienteA22.history.pilha.length === pilhaNaConversaA22,
      'A22: abrir #dialogo-config e, por cima, #dialogo-uso não empilha nada no histórico');
    voltarDoAparelhoA22(clienteA22);
    tudoOk &= ok(porIdDe(clienteA22, 'dialogo-uso').open === false
      && porIdDe(clienteA22, 'dialogo-config').open === true
      && porIdDe(clienteA22, 'app').dataset.vista === 'chat',
    'A22: o 1º voltar fecha só #dialogo-uso — o de CIMA — e o config e a conversa continuam');
    voltarDoAparelhoA22(clienteA22);
    tudoOk &= ok(porIdDe(clienteA22, 'dialogo-config').open === false
      && porIdDe(clienteA22, 'app').dataset.vista === 'chat',
    'A22: o 2º voltar fecha o config — a conversa AINDA continua aberta, um toque faz UMA coisa');
    voltarDoAparelhoA22(clienteA22);
    tudoOk &= ok(porIdDe(clienteA22, 'app').dataset.vista === 'lista',
      'A22: só o 3º voltar devolve a lista — sem degrau fantasma no meio');
  });

  // ── R1: a fita não arrasta a vista enquanto o agente trabalha ───────────────
  //
  // O bug: `if (!destinoFita) rolarFim()` rodava no fim do handler de CADA evento do
  // fluxo, sem perguntar onde o usuário estava. Rolar para cima para ler o histórico com o
  // turno rodando era impossível — o evento seguinte devolvia a vista ao fim.
  //
  // A régua é a MESMA da tela da pane (`pintarTelaDaPane`, desde 28/08): quem estava
  // colado no fim continua colado; quem rolou fica onde parou.
  await rodarGrupo('R1: rolar para ler durante o turno', async () => {
    const abrirComFita = async () => {
      const cli = carregarCliente({ aoBuscar: respostasDoCelular([]), guardado: memoria() });
      await cli.carregarAbas();
      await cli.abrirAba('aba-7');
      const es = cli.fluxos[cli.fluxos.length - 1];
      // A rajada inicial: `sessao` segura a fita num fragmento, `sincronizado` a despeja.
      // Sem ela, `destinoFita` continua preenchido e o ramo testado nem é alcançado.
      mandarEvento(es, { tipo: 'sessao', id: 'aba-7', meta: { titulo: 'sete', cwd: '/tmp/sete', contexto: null } });
      mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: true });
      return { cli, es, caixa: porIdDe(cli, 'mensagens') };
    };
    const eventoDoAgente = (es, texto) => mandarEvento(es, { tipo: 'texto', texto });

    // (1) Rolou para cima: a posição é dele. Este é o caso relatado em 07/09.
    const lendo = await abrirComFita();
    lendo.caixa.scrollHeight = 4000;
    lendo.caixa.clientHeight = 600;
    lendo.caixa.scrollTop = 1200;          // parado no meio do histórico
    eventoDoAgente(lendo.es, 'o agente falou mais uma coisa');
    tudoOk &= ok(lendo.caixa.scrollTop === 1200,
      `R1: com a vista no meio, o evento do agente NÃO arrasta para o fim (${lendo.caixa.scrollTop})`);

    // (2) Colado no fim: continua colado. Quem está acompanhando ao vivo não pode ficar
    // para trás — desligar a rolagem para todo mundo trocaria um bug por outro.
    const acompanhando = await abrirComFita();
    acompanhando.caixa.scrollHeight = 4000;
    acompanhando.caixa.clientHeight = 600;
    acompanhando.caixa.scrollTop = 3400;   // 4000 - 600 = exatamente no fim
    eventoDoAgente(acompanhando.es, 'mais uma fala');
    tudoOk &= ok(acompanhando.caixa.scrollTop === 4000,
      `R1: quem estava colado no fim continua colado (${acompanhando.caixa.scrollTop})`);

    // (2b) O MESMO caso (2), agora com o mundo do navegador: o bloco novo já está na fita
    // quando a decisão de rolar é tomada, e o `scrollHeight` cresceu junto. Medir "estava
    // colado no fim" DEPOIS disso classifica quem acompanhava como quem está lendo, e a
    // fita para de seguir sozinha. É o que foi relatado em 08/09: chega raciocínio ou
    // comando na conversa e a vista trava no lugar. O caso (2) não pegava porque o
    // `scrollHeight` do DOM falso ficava congelado em 4000.
    const crescendo = await abrirComFita();
    crescendo.caixa.scrollHeight = 4000;
    crescendo.caixa.clientHeight = 600;
    crescendo.caixa.scrollTop = 3400;      // colado no fim ANTES de o bloco chegar
    porIdDe(crescendo.cli, 'fita').crescerJunto = crescendo.caixa;
    crescendo.caixa.crescePorFilho = 200;  // um raciocínio tem altura, e ela é > FOLGA_FIM
    eventoDoAgente(crescendo.es, 'um raciocínio comprido');
    tudoOk &= ok(crescendo.caixa.scrollTop === crescendo.caixa.scrollHeight,
      'R1: com o bloco novo JÁ na fita, quem estava colado continua acompanhando '
      + `(${crescendo.caixa.scrollTop} de ${crescendo.caixa.scrollHeight})`);

    // (2c) O outro lado da MESMA régua, e a guarda contra trocar um bug por outro: com o
    // `scrollHeight` crescendo igual, quem tinha rolado para ler continua onde parou.
    const lendoEnquantoCresce = await abrirComFita();
    lendoEnquantoCresce.caixa.scrollHeight = 4000;
    lendoEnquantoCresce.caixa.clientHeight = 600;
    lendoEnquantoCresce.caixa.scrollTop = 1200;
    porIdDe(lendoEnquantoCresce.cli, 'fita').crescerJunto = lendoEnquantoCresce.caixa;
    lendoEnquantoCresce.caixa.crescePorFilho = 200;
    eventoDoAgente(lendoEnquantoCresce.es, 'outro raciocínio comprido');
    tudoOk &= ok(lendoEnquantoCresce.caixa.scrollTop === 1200,
      'R1: e quem estava lendo continua onde parou, mesmo com a fita crescendo '
      + `(${lendoEnquantoCresce.caixa.scrollTop})`);

    // (3) A folga de FOLGA_FIM px ainda conta como fim: o dedo no celular quase nunca para
    // no pixel exato, e sem folga o "ao vivo" se desarmaria sozinho.
    const quaseNoFim = await abrirComFita();
    quaseNoFim.caixa.scrollHeight = 4000;
    quaseNoFim.caixa.clientHeight = 600;
    quaseNoFim.caixa.scrollTop = 3380;     // 20px do fim, dentro da folga de 24
    eventoDoAgente(quaseNoFim.es, 'e mais outra');
    tudoOk &= ok(quaseNoFim.caixa.scrollTop === 4000,
      `R1: 20px do fim ainda é "no fim" — a folga vale (${quaseNoFim.caixa.scrollTop})`);

    // (4) Um pouco acima da folga já é leitura deliberada, e a vista fica.
    const acimaDaFolga = await abrirComFita();
    acimaDaFolga.caixa.scrollHeight = 4000;
    acimaDaFolga.caixa.clientHeight = 600;
    acimaDaFolga.caixa.scrollTop = 3360;   // 40px do fim, fora da folga
    eventoDoAgente(acimaDaFolga.es, 'e mais uma');
    tudoOk &= ok(acimaDaFolga.caixa.scrollTop === 3360,
      `R1: 40px do fim já é leitura, e a vista não se mexe (${acimaDaFolga.caixa.scrollTop})`);

    // (5) O gesto DELE continua indo ao fim sem perguntar. Enviar mensagem é o caso mais
    // óbvio: ninguém escreve para ficar olhando o histórico velho.
    const enviando = await abrirComFita();
    enviando.caixa.scrollHeight = 4000;
    enviando.caixa.clientHeight = 600;
    enviando.caixa.scrollTop = 1200;
    porIdDe(enviando.cli, 'entrada').value = 'oi';
    await enviando.cli.enviar(enviando.cli.painelAtual());
    tudoOk &= ok(enviando.caixa.scrollTop === 4000,
      `R1: mas ENVIAR é gesto dele e vai ao fim mesmo com a vista no meio (${enviando.caixa.scrollTop})`);
  });

  // ── /status do Codex: rota dedicada, bloco próprio, dedupe, escape (08/09) ────────────
  //
  // Ver docs/superpowers/specs/2026-09-08-resposta-status-codex-design.md. Sem servidor
  // nenhum no ar: o `fetch` de mentira responde pela rota dedicada como o server.js faria,
  // e o que se prova aqui é o CLIENTE — que ele bate na rota certa, nunca em /turnos, que
  // desenha o bloco com o texto literal, dedupe por id e não vaza entre abas.
  await rodarGrupo('/status do Codex', async () => {
    const umaAbaCodex = (extra = {}) => ({
      chave: 'aba-7', titulo: 'projeto', cwd: '/home/y/projetos/projeto', agente: 'codex',
      temAgente: true, rodando: false, sessaoId: 'sess-status-1', ...extra,
    });

    // (1) /status exato numa aba Codex: rota dedicada, nunca /turnos; corpo só leva o id.
    const rotas = [];
    const corposDeStatus = [];
    const cli = carregarCliente({
      aoBuscar: (rota, opcoes = {}) => {
        rotas.push(String(rota));
        if (String(rota).startsWith('api/abas/aba-7/status')) {
          corposDeStatus.push(opcoes.corpo || {});
          // O servidor ECOA o id que o cliente mandou (é ele quem grava o snapshot sob
          // esse id) — o mock tem que fazer o mesmo, senão a espera nunca casaria com a
          // resposta e o teste provaria um bug que só existe no duble.
          return {
            id: opcoes.corpo?.id || 'snap-1', sessaoId: 'sess-status-1',
            quando: '2026-09-08T12:00:00.000Z', texto: 'Session:              sess-status-1',
          };
        }
        if (String(rota).startsWith('api/abas')) return { abas: [umaAbaCodex()] };
        return { painel: true, jobs: [] };
      },
    });
    await cli.carregarAbas();
    await cli.abrirAba('aba-7');
    cli.aplicar({tipo:'sessao',meta:{sessaoId:'sess-status-1',titulo:'projeto',cwd:'/fixture'}});

    porIdDe(cli, 'entrada').value = '/status';
    await cli.enviar(cli.painelAtual());
    tudoOk &= ok(rotas.some((r) => r.startsWith('api/abas/aba-7/status')),
      '/status exato numa aba Codex bate na rota dedicada');
    tudoOk &= ok(!rotas.some((r) => r.startsWith('api/abas/aba-7/turnos')),
      'e NUNCA em /turnos — não é conversa com o modelo, e não acende "trabalhando"');
    tudoOk &= ok(
      corposDeStatus.length === 1 && Object.keys(corposDeStatus[0]).length === 1
      && typeof corposDeStatus[0].id === 'string',
      'o corpo do POST só leva o id de dedupe',
    );

    const bloco1 = porIdDe(cli, 'fita').querySelector('.status-codex');
    tudoOk &= ok(Boolean(bloco1), 'o bloco "Resultados de /status" nasce na fita');
    const textoBloco1 = textoDe(bloco1);
    tudoOk &= ok(textoBloco1.includes('Resultados de /status'), 'com o título certo');
    tudoOk &= ok(textoBloco1.includes('Status do Codex'), 'e o item traz o rótulo por snapshot');
    tudoOk &= ok(textoBloco1.includes('sess-status-1'), 'com o texto literal do CLI dentro');
    tudoOk &= ok(!textoBloco1.includes('Consultando'), 'a espera some depois da resposta chegar');
    tudoOk &= ok(Boolean(bloco1.querySelector('.status-codex-item').open),
      'o item nasce aberto (details obrigatório e aberto de saída)');

    // (2) Dedupe: o MESMO id chegando pelo SSE (replay/outro aparelho) não duplica. O id é
    // o que o CLIENTE gerou (`idReal`, capturado no corpo do POST) — o servidor de mentira
    // ecoa esse mesmo id na resposta, igual ao servidor de verdade faria.
    const idReal = corposDeStatus[0].id;
    cli.aplicar({
      tipo: 'status_codex', id: idReal, sessaoId: 'sess-status-1',
      quando: '2026-09-08T12:00:00.000Z', texto: 'Session:              sess-status-1',
    });
    tudoOk &= ok(porIdDe(cli, 'fita').querySelectorAll('.status-codex-item').length === 1,
      'o mesmo id via SSE não cria um segundo item (dedupe HTTP × SSE)');

    // Um id NOVO (segunda consulta, ou outro aparelho) SOMA ao bloco — não substitui.
    cli.aplicar({
      tipo: 'status_codex', id: 'snap-2', sessaoId: 'sess-status-1',
      quando: '2026-09-08T12:05:00.000Z', texto: 'Session:              sess-status-1 (2)',
    });
    tudoOk &= ok(porIdDe(cli, 'fita').querySelectorAll('.status-codex-item').length === 2,
      'uma segunda consulta soma um item novo, sem apagar o anterior');

    // (3) Texto de terminal com marcação de HTML é literal — nunca vira elemento. O DOM de
    // mentira não faz parse de HTML: a prova é `_texto`, o que `textContent =` gravou de
    // verdade (mesma trava dos testes de markdown lá em cima).
    cli.aplicar({
      tipo: 'status_codex', id: 'snap-3', sessaoId: 'sess-status-1',
      quando: '2026-09-08T12:06:00.000Z', texto: '<img src=x onerror=alert(1)>',
    });
    const itens = porIdDe(cli, 'fita').querySelectorAll('.status-codex-item');
    const pre3 = itens[itens.length - 1].querySelector('.status-codex-texto');
    tudoOk &= ok(pre3._texto === '<img src=x onerror=alert(1)>',
      'texto perigoso do terminal vai por textContent — literal, nunca innerHTML/markdown');

    const antesAnexo = corposDeStatus.length;
    cli.painelAtual().anexos = [{ estado: 'pronto', caminho: '/fixture/a.png', nome: 'a.png' }];
    porIdDe(cli, 'entrada').value = '/status';
    await cli.enviar(cli.painelAtual());
    tudoOk &= ok(corposDeStatus.length === antesAnexo && !rotas.some(r => r.includes('/turnos')),
      '/status com anexo recusa sem qualquer POST de envio');
    cli.painelAtual().anexos = [];
    cli.aplicar({tipo:'status_codex',id:'intruso',sessaoId:'outra',texto:'NAO MOSTRAR',quando:'2026-09-08T12:00:00Z'});
    tudoOk &= ok(!textoDe(porIdDe(cli,'fita')).includes('NAO MOSTRAR'), 'SSE de outra sessão é ignorado');
    for(let i=0;i<25;i++) cli.aplicar({tipo:'status_codex',id:'teto-'+i,sessaoId:'sess-status-1',texto:'snapshot '+i,quando:new Date(1788870000000+i*1000).toISOString()});
    tudoOk &= ok(porIdDe(cli,'fita').querySelectorAll('.status-codex-item').length===20, 'interface mantém teto de 20 snapshots');
    const fluxoVelho = cli.fluxos.at(-1);
    // Split view, fase 3: `abrirAba('aba-7')` numa chave JÁ ABERTA e focada virou `focar()`
    // puro, sem religar (§4.2 do plano — evita reconexão redundante). Quem religa o cano de
    // um painel que já está na tela é `recarregarPainel`, o equivalente ao ↻ do cabeçalho —
    // é ele que produz o fluxo NOVO que este teste precisa para provar a guarda do antigo.
    await cli.recarregarPainel(cli.painelAtual());
    const fluxoNovo = cli.fluxos.at(-1);
    mandarEvento(fluxoNovo, {tipo:'sessao',meta:{sessaoId:'sess-nova',titulo:'nova',cwd:'/fixture'}});
    mandarEvento(fluxoNovo, {tipo:'sincronizado',turnoEmAndamento:false});
    mandarEvento(fluxoVelho, {tipo:'sessao',meta:{sessaoId:'sess-status-1',titulo:'VELHA',cwd:'/fixture'}});
    tudoOk &= ok(porIdDe(cli,'chat-titulo').textContent==='nova', 'callback de EventSource fechado não troca sessão de volta');
    mandarEvento(fluxoNovo, {tipo:'status_codex',id:'antigo',sessaoId:'sess-status-1',texto:'NAO MOSTRAR',quando:'2026-09-08T12:00:00Z'});
    tudoOk &= ok(!textoDe(porIdDe(cli,'fita')).includes('NAO MOSTRAR'), '/clear recusa replay da sessão antiga');

    // (5) Regressão: aba de CLAUDE com /status continua indo para /turnos, como sempre.
    const rotasClaude = [];
    const cliClaude = carregarCliente({
      aoBuscar: (rota) => {
        rotasClaude.push(String(rota));
        if (String(rota).startsWith('api/abas')) {
          return { abas: [{ chave: 'aba-9', titulo: 'claude', cwd: '/x', agente: 'claude', temAgente: true, rodando: false, sessaoId: 's9' }] };
        }
        return { painel: true, jobs: [] };
      },
    });
    await cliClaude.carregarAbas();
    await cliClaude.abrirAba('aba-9');
    porIdDe(cliClaude, 'entrada').value = '/status';
    await cliClaude.enviar(cliClaude.painelAtual());
    tudoOk &= ok(rotasClaude.some((r) => r.startsWith('api/abas/aba-9/turnos')),
      'numa aba de Claude, /status continua sendo conversa normal (regressão)');
    tudoOk &= ok(!rotasClaude.some((r) => r.includes('/aba-9/status')),
      'e nunca vai para a rota dedicada do Codex');

    // (6) Regressão: numa aba de Codex, mensagem que NÃO é "/status" exato segue por /turnos.
    const rotasNormais = [];
    const cliNormal = carregarCliente({
      aoBuscar: (rota) => {
        rotasNormais.push(String(rota));
        if (String(rota).startsWith('api/abas')) return { abas: [umaAbaCodex({ chave: 'aba-10' })] };
        return { painel: true, jobs: [] };
      },
    });
    await cliNormal.carregarAbas();
    await cliNormal.abrirAba('aba-10');
    for (const texto of ['/status agora', '  /status  extra', 'oi, tudo bem?']) {
      porIdDe(cliNormal, 'entrada').value = texto;
      await cliNormal.enviar(cliNormal.painelAtual());
    }
    tudoOk &= ok(rotasNormais.filter((r) => r.startsWith('api/abas/aba-10/turnos')).length === 3,
      '/status com argumento e mensagem comum continuam indo por /turnos, mesmo em aba Codex');
    tudoOk &= ok(!rotasNormais.some((r) => r.includes('/aba-10/status')),
      'e nenhum deles toca a rota dedicada');

    // (7) Resultado tardio não vaza para a conversa em que o usuário já está: navegar para
    // outra aba ANTES do POST resolver não pode pintar o bloco errado.
    let resolverPendente;
    const espera = new Promise((resolve) => { resolverPendente = resolve; });
    const cliNav = carregarCliente({
      aoBuscar: async (rota) => {
        if (String(rota).startsWith('api/abas/aba-7/status')) {
          await espera;
          return { id: 'snap-nav', sessaoId: 'sess-nav', quando: '2026-09-08T13:00:00.000Z', texto: 'Session:              sess-nav' };
        }
        if (String(rota).startsWith('api/abas')) {
          return {
            abas: [
              umaAbaCodex({ chave: 'aba-7', sessaoId: 'sess-nav' }),
              umaAbaCodex({ chave: 'aba-8', titulo: 'outra', sessaoId: 'sess-outra' }),
            ],
          };
        }
        return { painel: true, jobs: [] };
      },
    });
    await cliNav.carregarAbas();
    await cliNav.abrirAba('aba-7');
    porIdDe(cliNav, 'entrada').value = '/status';
    const promessaEnvio = cliNav.enviar(cliNav.painelAtual());
    await cliNav.abrirAba('aba-8');   // navega ANTES da resposta do /status chegar
    resolverPendente();
    await promessaEnvio;
    const blocoNaAba8 = porIdDe(cliNav, 'fita').querySelector('.status-codex');
    tudoOk &= ok(!blocoNaAba8 || !textoDe(blocoNaAba8).includes('sess-nav'),
      'resultado tardio da aba antiga não pinta na conversa para onde o usuário já navegou');
    for (const falha of [false, true]) {
      let soltar;
      const trava = new Promise(r => { soltar=r; });
      const troca = carregarCliente({aoBuscar:async(rota,op={})=>{
        if(String(rota).includes('/status')) {await trava;return falha
          ? {__status:500,erro:'ERRO ANTIGO'}
          : {id:op.corpo.id,sessaoId:'antes-clear',texto:'RESPOSTA ANTIGA',quando:'2026-09-08T12:00:00Z'};}
        if(String(rota).startsWith('api/abas')) return {abas:[umaAbaCodex({sessaoId:'antes-clear'})]};
        return {painel:true,jobs:[]};
      }});
      await troca.carregarAbas();await troca.abrirAba('aba-7');
      const es=troca.fluxos.at(-1);
      const sessao=id=>mandarEvento(es,{tipo:'sessao',meta:{sessaoId:id,titulo:'teste',cwd:'/fixture'}});
      sessao('antes-clear');mandarEvento(es,{tipo:'sincronizado',turnoEmAndamento:false});
      porIdDe(troca,'entrada').value='/status';const pedido=troca.enviar(troca.painelAtual());
      tudoOk &= ok(troca.painelAtual().ocupado===false, 'consultar status não marca turno como ocupado');
      sessao('depois-clear');mandarEvento(es,{tipo:'sincronizado',turnoEmAndamento:false});
      soltar();await pedido;
      const texto=textoDe(porIdDe(troca,'fita'));
      tudoOk &= ok(!texto.includes('ANTIG') && !texto.includes('Consultando'),
        `${falha?'erro':'resposta'} HTTP tardio não vaza após /clear na mesma pane`);
    }

  });


  // ─── Grupo de jobs na lista — desenho C (spec 2026-09-08) ─────────────────
  //
  // Fase 3 do plano: os asserts nascem ANTES de `grupoDeJobs()` existir, então a maioria
  // é VERMELHA de propósito (§8 da spec). Três exceções, e por motivos DIFERENTES:
  //
  //   G6, G7        — FRONTEIRA: exigem que o grupo NÃO exista. Hoje ele nunca existe em
  //                   situação nenhuma, então o vermelho é impossível por ausência de
  //                   sujeito, não por comportamento. Valem daqui para a frente.
  //   G12, G18, G23 — PRESERVAÇÃO: provam que o `jobsRodando`/`jobsPorAba`/o ciclo de 15s
  //                   (D21) já filtram `estado === 'running'` HOJE, antes de qualquer
  //                   mudança. Nascem verdes e é isso mesmo — a armadilha que eles guardam
  //                   é a Fase 4 reaproveitar essas variáveis para a lista INTEIRA (R4), o
  //                   que faria o resumo da tela vazia mentir (A11, `gate-ui.js:7194`).
  //
  // Todos os outros (G1-G5, G8-G11, G12b, G13-G17, G19-G22, G24) precisam do código da
  // Fase 4 e nascem vermelhos.
  const agoraJobsG = Date.now();
  const horasAtrasJobs = (h) => new Date(agoraJobsG - h * 3600 * 1000).toISOString();
  /** Um job do `?tudo=1`, com os campos que o servidor manda (server.js:737-753). */
  const jobDoTesteG = (over = {}) => ({
    id: 'job-g', tipo: 'ataca', projeto: 'projeto-g', estado: 'running',
    etapa: null, desde: horasAtrasJobs(2), fim: null, desfecho: null, abas: [],
    ...over,
  });

  console.log('\n  · G1: o grupo JOBS aparece na lista com job rodando');
  await rodarGrupo('G1', async () => {
    const c1 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ estado: 'running', tipo: 'ataca' })] }
        : { abas: [] }),
    });
    await c1.carregarAbas();
    await c1.atualizarFaixaJobs();
    const grupo1 = porIdDe(c1, 'abas').querySelector('#grupo-jobs');
    tudoOk &= ok(Boolean(grupo1), 'G1: o grupo JOBS aparece na lista com job rodando');
    const pino1 = grupo1?.querySelector('.conversa-pino')?.textContent?.trim();
    tudoOk &= ok(pino1 === '●', `G1: pino de running é ● (${pino1})`);
    const nome1 = grupo1?.querySelector('.conversa-nome')?.textContent;
    tudoOk &= ok(nome1 === 'ataca', `G1: job SEM título cai no tipo, para a linha nunca ficar sem nome (${nome1})`);
  });

  // G1b — o nome da linha é o TÍTULO (09/09). Nasceu de uma queixa direta: com `j.tipo` ali,
  // a lista virava nove linhas escritas "ataca" e não dava para achar job nenhum. O caso do
  // G1 (sem título) continua valendo em cima — os dois juntos é que amarram o fallback.
  console.log('\n  · G1b: a linha do job mostra o título, não o tipo');
  await rodarGrupo('G1b', async () => {
    // Aba viva de propósito: o `title` só é escrito no ramo CLICÁVEL — no outro ele carrega a
    // explicação de por que a linha não clica, que é outra coisa e não se testa aqui.
    const abas1b = [{ chave: 'aba-1b', titulo: 'x', cwd: '/tmp/g1b', temAgente: true, rodando: true, sessaoId: 's1b', atualizadoEm: 1 }];
    const c1b = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ estado: 'running', tipo: 'ataca', titulo: 'Caixa de envio por painel', abas: ['aba-1b'] })] }
        : { abas: abas1b }),
    });
    await c1b.carregarAbas();
    await c1b.atualizarFaixaJobs();
    const grupo1b = porIdDe(c1b, 'abas').querySelector('#grupo-jobs');
    const nome1b = grupo1b?.querySelector('.conversa-nome')?.textContent;
    tudoOk &= ok(nome1b === 'Caixa de envio por painel',
      `G1b: com título, a linha mostra o título (${nome1b})`);
    // O tipo não some do produto: ele desce para o tooltip, junto do título.
    // `.title` e não `getAttribute('title')`: o código escreve a PROPRIEDADE, e o DOM de
    // mentira do gate não espelha uma na outra.
    const dica1b = grupo1b?.querySelector('.conversa')?.title;
    tudoOk &= ok(dica1b === 'ataca · Caixa de envio por painel',
      `G1b: e o tipo continua alcançável no title (${dica1b})`);
  });

  console.log('\n  · G2: recolher esconde as linhas e mantém o cabeçalho');
  await rodarGrupo('G2', async () => {
    const c2 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ estado: 'running' })] }
        : { abas: [] }),
    });
    await c2.carregarAbas();
    await c2.atualizarFaixaJobs();
    const grupo2 = porIdDe(c2, 'abas').querySelector('#grupo-jobs');
    const alternar2 = grupo2?.querySelector('.projeto-alternar');
    tudoOk &= ok(Boolean(alternar2), 'G2: pré-condição — o grupo tem o botão de recolher');
    alternar2?.onclick?.();
    const conteudo2 = grupo2?.querySelector('.projeto-conteudo');
    tudoOk &= ok(conteudo2?.hidden === true, 'G2: recolher esconde as linhas (conteúdo hidden)');
    tudoOk &= ok(Boolean(grupo2?.querySelector('.projeto-topo')), 'G2: e o cabeçalho continua de pé');
    tudoOk &= ok(alternar2?.getAttribute('aria-expanded') === 'false',
      `G2: aria-expanded vira "false" (${alternar2?.getAttribute('aria-expanded')})`);
  });

  console.log('\n  · G3: recolhido, o cabeçalho denuncia o que trava (blocked + orfao)');
  await rodarGrupo('G3', async () => {
    const recolhido = async (jobs) => {
      const c = carregarCliente({
        aoBuscar: (rota) => (/api\/jobs/.test(String(rota)) ? { painel: true, jobs } : { abas: [] }),
      });
      await c.carregarAbas();
      await c.atualizarFaixaJobs();
      const grupo = porIdDe(c, 'abas').querySelector('#grupo-jobs');
      grupo?.querySelector('.projeto-alternar')?.onclick?.();
      return {
        aviso: grupo?.querySelector('.projeto-aviso')?.textContent,
        trabalho: grupo?.querySelector('.projeto-trabalhando')?.textContent,
      };
    };
    const a = await recolhido([
      jobDoTesteG({ id: 'b1', estado: 'blocked', desfecho: 'motivo' }),
      jobDoTesteG({ id: 'o1', estado: 'orfao' }),
      jobDoTesteG({ id: 'd1', estado: 'done', fim: horasAtrasJobs(1) }),
    ]);
    tudoOk &= ok(a.aviso === '2 travados', `G3: blocked + orfao somam "2 travados" (${a.aviso})`);

    const b = await recolhido([
      jobDoTesteG({ id: 'o1', estado: 'orfao' }),
      jobDoTesteG({ id: 'o2', estado: 'orfao' }),
    ]);
    tudoOk &= ok(b.aviso === '2 travados', `G3: SÓ órfãos (zero blocked) também conta (${b.aviso})`);

    const c3 = await recolhido([
      jobDoTesteG({ id: 'r1', estado: 'running' }),
      jobDoTesteG({ id: 'r2', estado: 'running' }),
      jobDoTesteG({ id: 'r3', estado: 'running' }),
    ]);
    tudoOk &= ok(!c3.aviso, `G3: sem travado, nenhum "N travados" (${c3.aviso})`);
    tudoOk &= ok(c3.trabalho === '3 rodando', `G3: sem travado e 3 rodando, mostra "3 rodando" (${c3.trabalho})`);

    const d = await recolhido([jobDoTesteG({ id: 'd1', estado: 'done', fim: horasAtrasJobs(1) })]);
    tudoOk &= ok(!d.aviso && !d.trabalho, `G3: sem travado e sem rodando, nenhum aviso (${d.aviso}/${d.trabalho})`);
  });

  console.log('\n  · G3b: o órfão mostra a IDADE do job, não "travado há X"');
  await rodarGrupo('G3b', async () => {
    const c3b = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ id: 'o1', estado: 'orfao', desde: horasAtrasJobs(5), fim: horasAtrasJobs(1) })] }
        : { abas: [] }),
    });
    await c3b.carregarAbas();
    await c3b.atualizarFaixaJobs();
    const estado3b = porIdDe(c3b, 'abas').querySelector('#grupo-jobs')?.querySelector('.conversa-estado')?.textContent;
    tudoOk &= ok(Boolean(estado3b?.includes('há 5h')), `G3b: usa a IDADE do job — "desde" (${estado3b})`);
    tudoOk &= ok(!estado3b?.includes('há 1h'), `G3b: e NUNCA o "fim" — não inventa o instante da morte (${estado3b})`);
  });

  console.log('\n  · G4: o grupo de jobs não empurra conversa — é o ÚLTIMO filho de #abas');
  await rodarGrupo('G4', async () => {
    const abasG4 = [{ chave: 'a1', titulo: 'um', cwd: '/tmp/g4', temAgente: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 }];
    const c4 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ estado: 'running' })] }
        : { abas: abasG4 }),
    });
    await c4.carregarAbas();
    await c4.atualizarFaixaJobs();
    const filhos4 = porIdDe(c4, 'abas').children;
    const ultimo4 = filhos4[filhos4.length - 1];
    tudoOk &= ok(ultimo4?.id === 'grupo-jobs',
      `G4: o grupo de jobs é o último filho de #abas, depois dos projetos (${ultimo4?.id || ultimo4?.className})`);
    // A ordem "append antes de restaurar o scrollTop" (§4.8 item 3) é código-revisada: o DOM
    // de mentira não modela geometria de rolagem (scrollHeight não cresce por posição), então
    // não há observável aqui além da posição estrutural acima.
  });

  console.log('\n  · G5: painel fora do ar — o grupo existe e AVISA, inclusive recolhido');
  await rodarGrupo('G5', async () => {
    const c5 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota)) ? { painel: false } : { abas: [] }),
    });
    await c5.carregarAbas();
    await c5.atualizarFaixaJobs();
    const grupo5 = porIdDe(c5, 'abas').querySelector('#grupo-jobs');
    tudoOk &= ok(Boolean(grupo5), 'G5: o grupo existe mesmo com painel fora do ar');
    // A string mudou junto com a fonte dos jobs: era "não deu para falar com o painel" quando
    // um serviço externo respondia por esta lista. Assert literal é de propósito — é o que
    // impede a mensagem de virar outra coisa sem ninguém decidir (D43).
    tudoOk &= ok(Boolean(grupo5 && textoDe(grupo5).includes('não deu para ler os jobs')),
      'G5: e diz "não deu para ler os jobs"');
    grupo5?.querySelector('.projeto-alternar')?.onclick?.();
    const aviso5 = grupo5?.querySelector('.projeto-aviso')?.textContent;
    tudoOk &= ok(aviso5 === 'sem contato com o painel',
      `G5: recolhido, o cabeçalho repete a notícia (${aviso5})`);
  });

  console.log('\n  · G6 (fronteira): painel true + zero job na janela → o grupo NÃO existe');
  await rodarGrupo('G6', async () => {
    const c6 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota)) ? { painel: true, jobs: [] } : { abas: [] }),
    });
    await c6.carregarAbas();
    await c6.atualizarFaixaJobs();
    tudoOk &= ok(porIdDe(c6, 'abas').querySelector('#grupo-jobs') === null,
      'G6 (fronteira): sem job na janela, o grupo não existe');
  });

  console.log('\n  · G7 (fronteira): antes da primeira leitura, o grupo NÃO existe e não pisca erro');
  await rodarGrupo('G7', async () => {
    // O CARREGAMENTO do cliente já dispara `atualizarFaixaJobs()` sozinho (app.js, a última
    // linha do arquivo) — sem PRENDER a resposta de `api/jobs`, essa chamada automática
    // resolveria ANTES do teste conseguir olhar, e "antes da primeira leitura" deixaria de
    // existir como janela observável. A rota `api/abas` responde normal — é o que prova que
    // a LISTA (outro caminho) já pinta enquanto o painel de jobs ainda não respondeu nada.
    let liberar7;
    const espera7 = new Promise((r) => { liberar7 = r; });
    const c7 = carregarCliente({
      aoBuscar: async (rota) => {
        if (/api\/jobs/.test(String(rota))) { await espera7; return { painel: false }; }
        return { abas: [] };
      },
    });
    await c7.carregarAbas();
    tudoOk &= ok(porIdDe(c7, 'abas').querySelector('#grupo-jobs') === null,
      'G7 (fronteira): antes da primeira leitura, o grupo não existe');
    tudoOk &= ok(!textoDe(porIdDe(c7, 'abas')).includes('não deu para ler os jobs'),
      'G7: e a tela não pisca erro — null é ignorância, não notícia ruim');
    liberar7();
    await new Promise((r) => setTimeout(r, 0));
  });

  console.log('\n  · G8: job sem aba viva não é clicável — inclusive um done DENTRO da janela');
  await rodarGrupo('G8', async () => {
    const c8 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ id: 'j-done20h', estado: 'done', fim: horasAtrasJobs(20), abas: [] })] }
        : { abas: [] }),
    });
    await c8.carregarAbas();
    await c8.atualizarFaixaJobs();
    const alvo8 = porIdDe(c8, 'abas').querySelector('#grupo-jobs')?.querySelector('.conversa-linha')?.querySelector('.conversa');
    tudoOk &= ok(Boolean(alvo8), 'G8: pré-condição — a linha existe');
    tudoOk &= ok(alvo8?.tag !== 'button', `G8: job sem aba viva NÃO é <button> (tag=${alvo8?.tag})`);
    tudoOk &= ok(typeof alvo8?.onclick !== 'function', 'G8: e não tem onclick nenhum — clicar não abre nada');
  });

  console.log('\n  · G9: job com aba viva chama abrirAba(chave)');
  await rodarGrupo('G9', async () => {
    const abasG9 = [{ chave: 'aba-viva', titulo: 'x', cwd: '/tmp/g9', temAgente: true, rodando: false, sessaoId: 's9', atualizadoEm: 1 }];
    const c9 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ id: 'j-live', estado: 'running', abas: ['aba-viva'] })] }
        : { abas: abasG9 }),
    });
    await c9.carregarAbas();
    await c9.atualizarFaixaJobs();
    let chamada9 = null;
    c9.abrirAba = (chave) => { chamada9 = chave; };
    const botao9 = porIdDe(c9, 'abas').querySelector('#grupo-jobs')?.querySelector('.conversa-linha')?.querySelector('.conversa');
    tudoOk &= ok(botao9?.tag === 'button', 'G9: pré-condição — job com aba viva É clicável');
    botao9?.onclick?.();
    tudoOk &= ok(chamada9 === 'aba-viva', `G9: o clique chama abrirAba(chave) (${chamada9})`);
  });

  console.log('\n  · G10: o clique da faixa abre o grupo — sem window.open, sem rolar tela escondida');
  await rodarGrupo('G10', async () => {
    const abasG10 = [{ chave: 'aba-g10', titulo: 'g10', cwd: '/tmp/g10', temAgente: true, rodando: true, sessaoId: 's-g10', atualizadoEm: 1 }];
    const c10 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ id: 'j-g10', estado: 'running', abas: ['aba-g10'] })] }
        : { abas: abasG10 }),
    });
    await c10.carregarAbas();
    await c10.atualizarFaixaJobs();
    await c10.abrirAba('aba-g10');   // entra na vista 'chat' (celular)
    const app10 = porIdDe(c10, 'app');
    tudoOk &= ok(app10.dataset.vista === 'chat', 'G10: pré-condição — a vista está em chat (celular)');
    // history LOCAL que RETÉM o popstate — o `back()` real do stub dispara na hora, e o
    // verde disso passaria mesmo com a implementação ERRADA (spec §8, o "verde que não
    // prova nada"). Aqui ele fica retido até o teste mandar.
    let retido10 = false;
    c10.history.back = () => { retido10 = true; };
    // A faixa deixou de ser um `#faixa-jobs` único do markup: desde a fase 2 do split view
    // ela nasce em `criarPainel`, uma por painel. Buscar pelo id criaria um nó SOLTO no DOM
    // de mentira, cujo `onclick` é `undefined` — e o `?.()` engoliria o clique, deixando o
    // teste verde sem ter clicado em nada. Procurar dentro de `#paineis` clica na de verdade.
    // Zera o contador ANTES do clique. O que o G10/G24 mede é a rolagem que O CLIQUE causa;
    // desde a fase 3 do split view, `focar()` também chama `scrollIntoView` para trazer o
    // painel focado à vista, e essas rolagens de MONTAGEM entrariam na conta. Zerar aqui
    // mantém a asserção medindo o que ela sempre mediu, em vez de afrouxá-la para um número
    // maior — que passaria mesmo se o clique rolasse quando não devia.
    c10.rolagens.length = 0;
    porIdDe(c10, 'paineis').querySelector('.faixa-jobs').onclick();
    tudoOk &= ok(c10.chamadasWindowOpen.length === 0, 'G10: clicar na faixa NÃO chama window.open');
    tudoOk &= ok(c10.rolagens.length === 0,
      `G10: com a vista ainda em chat, NENHUMA rolagem aconteceu (${c10.rolagens.length})`);
    tudoOk &= ok(retido10 === true, 'G10: pedirLista() chamou history.back() (retido, não disparado)');
    // LIBERA o popstate retido — `popstate` é evento de WINDOW: `janela`, não `ouvintes`
    // (que é do document). O próprio `history.back` do stub usa `janela.get('popstate')`.
    (c10.janela.get('popstate') || []).forEach((fn) => fn({ state: null }));
    await new Promise((r) => setTimeout(r, 0));   // o handler repinta de forma assíncrona
    tudoOk &= ok(app10.dataset.vista === 'lista', 'G10: o popstate devolveu a vista para lista');
    tudoOk &= ok(c10.rolagens.length === 1, `G10: agora sim, UMA rolagem (${c10.rolagens.length})`);
    tudoOk &= ok(c10.rolagens[0]?.pai === porIdDe(c10, 'abas'), 'G10: rola o nó que é filho de #abas');
  });

  console.log('\n  · G11: resposta atrasada não sobrescreve estado mais novo');
  await rodarGrupo('G11', async () => {
    // A PRIMEIRA chamada a `api/jobs` não é minha: `carregarCliente()` já dispara
    // `atualizarFaixaJobs()` sozinho (a última linha de app.js). Contar a partir da
    // SEGUNDA chamada é o que deixa este teste correto mesmo com essa chamada automática
    // correndo por baixo — ela recebe uma resposta neutra e é descartada pela guarda de
    // sequência de qualquer jeito, exatamente como QUALQUER leitura mais velha seria.
    let liberar11;
    const espera11 = new Promise((r) => { liberar11 = r; });
    let chamadasJobs11 = 0;
    const c11 = carregarCliente({
      aoBuscar: async (rota) => {
        if (/api\/jobs/.test(String(rota))) {
          chamadasJobs11 += 1;
          if (chamadasJobs11 === 1) return { painel: true, jobs: [] };   // a automática do boot
          if (chamadasJobs11 === 2) {
            await espera11;
            return { painel: true, jobs: [jobDoTesteG({ id: 'velho', tipo: 'velho', estado: 'running' })] };
          }
          return { painel: true, jobs: [jobDoTesteG({ id: 'novo', tipo: 'novo', estado: 'running' })] };
        }
        return { abas: [] };
      },
    });
    await c11.carregarAbas();
    const p11 = c11.atualizarFaixaJobs();   // a lenta — parte primeiro, resolve por último
    await c11.atualizarFaixaJobs();          // a rápida — chega primeiro
    const nomeRapida = porIdDe(c11, 'abas').querySelector('#grupo-jobs')?.querySelector('.conversa-nome')?.textContent;
    tudoOk &= ok(nomeRapida === 'novo', `G11: a leitura rápida (2ª) pinta (${nomeRapida})`);
    liberar11();
    await p11;
    const nomeFinal = porIdDe(c11, 'abas').querySelector('#grupo-jobs')?.querySelector('.conversa-nome')?.textContent;
    tudoOk &= ok(nomeFinal === 'novo', `G11: a leitura lenta (1ª), chegando DEPOIS, NÃO repinta (${nomeFinal})`);
  });

  console.log('\n  · G12b: a URL pedida é EXATAMENTE api/jobs?tudo=1');
  await rodarGrupo('G12b', async () => {
    let ultimaRota12b = null;
    const c12b = carregarCliente({
      aoBuscar: (rota) => {
        if (/api\/jobs/.test(String(rota))) { ultimaRota12b = String(rota); return { painel: true, jobs: [] }; }
        return { abas: [] };
      },
    });
    await c12b.carregarAbas();
    await c12b.atualizarFaixaJobs();
    tudoOk &= ok(ultimaRota12b === 'api/jobs?tudo=1',
      `G12b: a URL pedida é EXATAMENTE "api/jobs?tudo=1", por igualdade (${ultimaRota12b})`);
  });

  console.log('\n  · G12 (preservação): nenhum relógio novo — 6 tiques → 6 abas + 2 jobs (D21)');
  await rodarGrupo('G12', async () => {
    const contagem12 = { abas: 0, jobs: 0 };
    const c12 = carregarCliente({
      guardado: memoria(),
      aoBuscar: (rota) => {
        if (String(rota).startsWith('api/jobs')) { contagem12.jobs += 1; return { painel: true, jobs: [] }; }
        contagem12.abas += 1;
        return { abas: [] };
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const [relogio12] = [...c12.relogios.values()];
    tudoOk &= ok(Boolean(relogio12), 'G12: pré-condição — um relógio de pé');
    contagem12.abas = 0;
    contagem12.jobs = 0;
    for (let i = 0; i < 6; i += 1) { relogio12.fn(); await new Promise((r) => setTimeout(r, 0)); }
    tudoOk &= ok(contagem12.abas === 6, `G12 (preservação): a lista sai em TODO tique (${contagem12.abas})`);
    tudoOk &= ok(contagem12.jobs === 2,
      `G12 (preservação): a faixa de jobs sai em 1 de cada 3 tiques, sem abrir aba no meio (${contagem12.jobs})`);
  });

  console.log('\n  · G13: o mapa de cor — data-estado por estado do job');
  await rodarGrupo('G13', async () => {
    const jobsG13 = [
      jobDoTesteG({ id: 'jb', estado: 'blocked', desfecho: 'motivo x' }),
      jobDoTesteG({ id: 'jf', estado: 'failed', desfecho: 'executor saiu com código 1' }),
      jobDoTesteG({ id: 'jd', estado: 'done', fim: horasAtrasJobs(1), desfecho: 'executor terminou com sucesso' }),
      jobDoTesteG({ id: 'jr', estado: 'running' }),
    ];
    const c13 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota)) ? { painel: true, jobs: jobsG13 } : { abas: [] }),
    });
    await c13.carregarAbas();
    await c13.atualizarFaixaJobs();
    const linhas13 = [...(porIdDe(c13, 'abas').querySelector('#grupo-jobs')?.querySelectorAll('.conversa-linha') || [])];
    tudoOk &= ok(linhas13.length === 4, `G13: pré-condição — 4 linhas na tela (${linhas13.length})`);
    tudoOk &= ok(linhas13[0]?.dataset.estado === 'bloqueado', `G13: blocked → bloqueado (${linhas13[0]?.dataset.estado})`);
    tudoOk &= ok(linhas13[1]?.dataset.estado === 'interrompida', `G13: failed → interrompida (${linhas13[1]?.dataset.estado})`);
    tudoOk &= ok(linhas13[2]?.dataset.estado === 'pronta', `G13: done → pronta (${linhas13[2]?.dataset.estado})`);
    tudoOk &= ok(linhas13[3]?.dataset.estado === 'trabalhando', `G13: running → trabalhando (${linhas13[3]?.dataset.estado})`);

    console.log('\n  · G14: o desfecho de um blocked está no DOM — o de um done não ganha linha');
    tudoOk &= ok(Boolean(linhas13[0] && textoDe(linhas13[0]).includes('motivo x')), 'G14: motivo do blocked está no DOM');
    tudoOk &= ok(linhas13[0]?.querySelectorAll('.conversa-estado').length === 2,
      `G14: blocked ganha uma SEGUNDA linha (rodapé + motivo) (${linhas13[0]?.querySelectorAll('.conversa-estado').length})`);
    tudoOk &= ok(linhas13[2]?.querySelectorAll('.conversa-estado').length === 1,
      `G14: done NÃO ganha linha de motivo, mesmo tendo desfecho (${linhas13[2]?.querySelectorAll('.conversa-estado').length})`);

    // 🔴 "está no DOM" não é "está no lugar certo": um motivo appendado como IRMÃO do
    // `.conversa` dentro de `.conversa-linha` (que é `display: flex`) também passaria nos dois
    // asserts de cima — e foi exatamente o que aconteceu (achado do smoke de tela, 08/09): o
    // item flex a mais espremeu o `.conversa` até o nome quebrar letra por letra. O motivo TEM
    // que ser descendente do `.conversa` (o mesmo nó clicável), nunca filho direto da linha.
    const filhosDiretoDaLinha = linhas13[0]
      ? linhas13[0].children.filter((n) => n.className === 'conversa-estado')
      : [];
    tudoOk &= ok(filhosDiretoDaLinha.length === 0,
      `G14: o motivo NÃO é filho direto de .conversa-linha — seria item flex solto ao lado do .conversa (${filhosDiretoDaLinha.length})`);
    // `querySelectorAll` deste fake DOM não decompõe combinador de descendência (`a b`, Fase
    // 0 do plano) — por isso a busca é ESCOPADA no `.conversa` primeiro, não `.conversa
    // .conversa-estado` numa string só.
    const conversaBloqueada = linhas13[0]?.querySelector('.conversa');
    const estadosDentroDoConversa = conversaBloqueada ? conversaBloqueada.querySelectorAll('.conversa-estado') : [];
    const motivoNoLugarCerto = estadosDentroDoConversa.length === 2 && textoDe(estadosDentroDoConversa[1]).includes('motivo x');
    tudoOk &= ok(motivoNoLugarCerto,
      `G14: os DOIS .conversa-estado (rodapé + motivo) moram dentro do .conversa — mesmo nó clicável (${estadosDentroDoConversa.length})`);
  });

  console.log('\n  · G15: haQuantoTempo(null) devolve "" — a guarda medida');
  await rodarGrupo('G15', async () => {
    const c15 = carregarCliente();
    const resultado15 = c15.haQuantoTempo(null);
    tudoOk &= ok(resultado15 === '', `G15: haQuantoTempo(null) devolve '' (${JSON.stringify(resultado15)})`);
  });

  console.log('\n  · G15b: blocked com fim:null cai no "desde" — nunca "há 496915h"');
  await rodarGrupo('G15b', async () => {
    const c15b = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ id: 'jbn', estado: 'blocked', fim: null, desde: horasAtrasJobs(4), desfecho: 'motivo' })] }
        : { abas: [] }),
    });
    await c15b.carregarAbas();
    await c15b.atualizarFaixaJobs();
    const estado15b = porIdDe(c15b, 'abas').querySelector('#grupo-jobs')?.querySelector('.conversa-estado')?.textContent;
    tudoOk &= ok(Boolean(estado15b?.includes('há 4h')), `G15b: fim nulo cai no "desde" (${estado15b})`);
    tudoOk &= ok(!estado15b?.includes('496915'), `G15b: nunca "há 496915h" (${estado15b})`);
  });

  console.log('\n  · G16: pularAba ignora um grupo sem data-cwd (R1)');
  await rodarGrupo('G16', async () => {
    const abasG16 = [
      { chave: 'aba-1', titulo: 'um', cwd: '/tmp/g16-um', temAgente: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 },
      { chave: 'aba-2', titulo: 'dois', cwd: '/tmp/g16-dois', temAgente: true, rodando: false, sessaoId: 's2', atualizadoEm: 2 },
    ];
    const c16 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota)) ? { painel: true, jobs: [] } : { abas: abasG16 }),
    });
    await c16.carregarAbas();
    // Fica na ÚLTIMA aba real: é daqui que `pularAba(1)` tentaria avançar para o grupo
    // estranho. `abrirAba` chama `desenharAbas()`, que faz `alvo.textContent = ''` — por
    // isso o nó fantasma só pode ser injetado DEPOIS deste `abrirAba`, nunca antes (um
    // `desenharAbas()` no meio o apagaria e o teste passaria verde sem provar nada).
    await c16.abrirAba('aba-2');
    // Injeta uma seção que SIMULA o grupo de jobs de hoje (§4.4): mesma classe
    // `.conversa-grupo`, mesma `.projeto-conteudo` por dentro, SEM `data-cwd` — o cenário
    // exato do R1. Não depende de `grupoDeJobs()` existir: testa só o seletor de `pularAba`.
    const secaoFalsa = c16.document.createElement('section');
    secaoFalsa.className = 'conversa-grupo';
    const conteudoFalso = c16.document.createElement('div');
    conteudoFalso.className = 'projeto-conteudo';
    const botaoFalso = c16.document.createElement('button');
    botaoFalso.className = 'conversa';   // sem dataset.chave — como a linha de job
    conteudoFalso.append(botaoFalso);
    secaoFalsa.append(conteudoFalso);
    porIdDe(c16, 'abas').append(secaoFalsa);

    const fluxosAntes16 = c16.fluxos.length;
    let estourou16 = false;
    try { c16.pularAba(1); } catch { estourou16 = true; }
    tudoOk &= ok(!estourou16, 'G16: pularAba não estoura com um grupo sem data-cwd na árvore');
    tudoOk &= ok(c16.fluxos.length === fluxosAntes16,
      `G16: pularAba(+1) na ÚLTIMA aba real GRAMPEIA — não visita o botão sem chave do grupo estranho (${c16.fluxos.length - fluxosAntes16} fluxo(s) novo(s))`);
  });

  console.log('\n  · G17: #grupo-jobs não tem data-cwd — [data-cwd] continua contando só projetos');
  await rodarGrupo('G17', async () => {
    const abasG17 = [
      { chave: 'a1', titulo: 'um', cwd: '/tmp/g17-um', temAgente: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 },
      { chave: 'a2', titulo: 'dois', cwd: '/tmp/g17-dois', temAgente: true, rodando: false, sessaoId: 's2', atualizadoEm: 2 },
    ];
    const c17 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ estado: 'running' })] }
        : { abas: abasG17 }),
    });
    await c17.carregarAbas();
    await c17.atualizarFaixaJobs();
    const grupo17 = porIdDe(c17, 'abas').querySelector('#grupo-jobs');
    tudoOk &= ok(Boolean(grupo17), 'G17: pré-condição — o grupo de jobs existe');
    tudoOk &= ok(!('cwd' in (grupo17?.dataset || { cwd: 1 })), 'G17: #grupo-jobs NÃO carrega data-cwd');
    const comCwd17 = porIdDe(c17, 'abas').querySelectorAll('.conversa-grupo[data-cwd]');
    tudoOk &= ok(comCwd17.length === 2, `G17: [data-cwd] continua contando só os 2 projetos (${comCwd17.length})`);
  });

  console.log('\n  · G18 (preservação): jobsRodando só conta running — resumo não mente');
  await rodarGrupo('G18', async () => {
    const abasG18 = [{ chave: 'a-run', titulo: 'r', cwd: '/tmp/g18', temAgente: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 }];
    const jobsG18 = [
      jobDoTesteG({ id: 'jr', estado: 'running', abas: ['a-run'] }),
      jobDoTesteG({ id: 'jd1', estado: 'done', fim: horasAtrasJobs(1), abas: [] }),
      jobDoTesteG({ id: 'jd2', estado: 'done', fim: horasAtrasJobs(2), abas: [] }),
      jobDoTesteG({ id: 'jd3', estado: 'done', fim: horasAtrasJobs(3), abas: [] }),
    ];
    const c18 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota)) ? { painel: true, jobs: jobsG18 } : { abas: abasG18 }),
    });
    await c18.carregarAbas();
    await c18.atualizarFaixaJobs();
    const resumo18 = porIdDe(c18, 'vazio-resumo').textContent;
    tudoOk &= ok(resumo18.includes('1 job rodando'),
      `G18 (preservação): resumo diz "1 job rodando", não 4 (${resumo18})`);
    tudoOk &= ok(!resumo18.includes('4 job'), `G18 (preservação): nunca soma os encerrados (${resumo18})`);
  });

  console.log('\n  · G24: clique com a lateral fechada chama aplicarLateral(false) ANTES de rolar');
  await rodarGrupo('G24', async () => {
    const abasG24 = [{ chave: 'aba-g24', titulo: 'g24', cwd: '/tmp/g24', temAgente: true, rodando: true, sessaoId: 's-g24', atualizadoEm: 1 }];
    const c24 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ id: 'j-g24', estado: 'running', abas: ['aba-g24'] })] }
        : { abas: abasG24 }),
    });
    await c24.carregarAbas();
    await c24.atualizarFaixaJobs();
    const app24 = porIdDe(c24, 'app');
    app24.dataset.lateral = 'fechada';
    app24.dataset.vista = 'lista';   // desktop — não é o caso do celular (G10)
    const chamadas24 = [];
    c24.aplicarLateral = (fechada) => {
      chamadas24.push({ fechada, rolagensAntes: c24.rolagens.length });
      app24.dataset.lateral = fechada ? 'fechada' : 'aberta';
    };
    // A faixa deixou de ser um `#faixa-jobs` único do markup: desde a fase 2 do split view
    // ela nasce em `criarPainel`, uma por painel. Buscar pelo id criaria um nó SOLTO no DOM
    // de mentira, cujo `onclick` é `undefined` — e o `?.()` engoliria o clique, deixando o
    // teste verde sem ter clicado em nada. Procurar dentro de `#paineis` clica na de verdade.
    // Zera o contador ANTES do clique. O que o G10/G24 mede é a rolagem que O CLIQUE causa;
    // desde a fase 3 do split view, `focar()` também chama `scrollIntoView` para trazer o
    // painel focado à vista, e essas rolagens de MONTAGEM entrariam na conta. Zerar aqui
    // mantém a asserção medindo o que ela sempre mediu, em vez de afrouxá-la para um número
    // maior — que passaria mesmo se o clique rolasse quando não devia.
    c24.rolagens.length = 0;
    porIdDe(c24, 'paineis').querySelector('.faixa-jobs').onclick();
    tudoOk &= ok(chamadas24.length === 1 && chamadas24[0]?.fechada === false,
      `G24: aplicarLateral(false) foi chamado (${JSON.stringify(chamadas24)})`);
    tudoOk &= ok(chamadas24[0]?.rolagensAntes === 0,
      'G24: e foi chamado ANTES de qualquer rolagem — lateral fechada rolaria uma coluna de largura zero');
  });

  console.log('\n  · G19: recolher o grupo de jobs grava "jobs:" — nunca um projeto real');
  await rodarGrupo('G19', async () => {
    const guardado19 = memoria();
    const abasG19 = [{ chave: 'a1', titulo: 'um', cwd: '/tmp/g19', temAgente: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 }];
    const c19 = carregarCliente({
      guardado: guardado19,
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ estado: 'running' })] }
        : { abas: abasG19 }),
    });
    await c19.carregarAbas();
    await c19.atualizarFaixaJobs();
    const grupo19 = porIdDe(c19, 'abas').querySelector('#grupo-jobs');
    grupo19?.querySelector('.projeto-alternar')?.onclick?.();
    const salvo19 = JSON.parse(guardado19.getItem('cockpit-projetos') || '{}');
    tudoOk &= ok((salvo19.fechados || []).includes('jobs:'),
      `G19: recolher grava "jobs:" em cockpit-projetos.fechados (${JSON.stringify(salvo19.fechados)})`);
    tudoOk &= ok(!(salvo19.fechados || []).includes('/tmp/g19'),
      'G19: e NÃO recolhe o projeto real — chave própria (R7)');
  });

  console.log('\n  · G20: sem aba nenhuma no terminal, com job na lista — os DOIS avisos convivem');
  await rodarGrupo('G20', async () => {
    const c20 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ estado: 'running' })] }
        : { abas: [] }),
    });
    await c20.carregarAbas();
    await c20.atualizarFaixaJobs();
    const abasEl20 = porIdDe(c20, 'abas');
    tudoOk &= ok(textoDe(abasEl20).includes('Nenhuma aba aberta'), 'G20: mostra o aviso de nenhuma aba');
    tudoOk &= ok(Boolean(abasEl20.querySelector('#grupo-jobs')), 'G20: e o grupo de jobs aparece mesmo assim');
    tudoOk &= ok(porIdDe(c20, 'vazio-resumo').textContent === '',
      `G20: pintarResumoVazio() não estoura nem escreve resumo sem aba nenhuma (${porIdDe(c20, 'vazio-resumo').textContent})`);
  });

  console.log('\n  · G21: aba fechada entre a leitura de jobs e a de abas — a defasagem 15s×5s');
  await rodarGrupo('G21', async () => {
    const abasG21 = [{ chave: 'viva', titulo: 'v', cwd: '/tmp/g21', temAgente: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 }];
    const jobsG21 = [
      jobDoTesteG({ id: 'j-morta', estado: 'running', abas: ['morta'] }),
      jobDoTesteG({ id: 'j-mista', estado: 'running', abas: ['morta', 'viva'] }),
    ];
    const c21 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota)) ? { painel: true, jobs: jobsG21 } : { abas: abasG21 }),
    });
    await c21.carregarAbas();
    await c21.atualizarFaixaJobs();
    const linhas21 = [...(porIdDe(c21, 'abas').querySelector('#grupo-jobs')?.querySelectorAll('.conversa-linha') || [])];
    tudoOk &= ok(linhas21.length === 2, `G21: pré-condição — 2 linhas de job (${linhas21.length})`);
    const alvo1 = linhas21[0]?.querySelector('.conversa');
    const alvo2 = linhas21[1]?.querySelector('.conversa');
    tudoOk &= ok(alvo1?.tag !== 'button', 'G21: job cuja ÚNICA aba fechou não é clicável');
    let chamada21 = null;
    c21.abrirAba = (chave) => { chamada21 = chave; };
    alvo2?.onclick?.();
    tudoOk &= ok(chamada21 === 'viva', `G21: job com abas MISTAS abre a VIVA, não a morta (${chamada21})`);
  });

  console.log('\n  · G22: o clique fantasma logo depois do puxar-para-atualizar não abre job');
  await rodarGrupo('G22', async () => {
    const numeroNaFonteG22 = (nome) => {
      const achado = new RegExp(`const ${nome} = (\\d+)`)
        .exec(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'));
      return achado ? Number(achado[1]) : 0;
    };
    const LIMIAR22 = numeroNaFonteG22('PUXAR_LIMIAR');
    const abasG22 = [{ chave: 'aba22', titulo: 'x', cwd: '/tmp/g22', temAgente: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 }];
    const c22 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota))
        ? { painel: true, jobs: [jobDoTesteG({ id: 'j22', estado: 'running', abas: ['aba22'] })] }
        : { abas: abasG22 }),
    });
    await c22.carregarAbas();
    await c22.atualizarFaixaJobs();
    const lista22 = porIdDe(c22, 'abas');
    const dedo22 = (y) => ({ touches: [{ clientY: y }], preventDefault() {} });
    lista22.scrollTop = 0;
    lista22.disparar('touchstart', dedo22(100));
    lista22.disparar('touchmove', dedo22(100 + LIMIAR22));
    lista22.disparar('touchend', {});
    await new Promise((r) => setTimeout(r, 0));
    const botaoJob22 = porIdDe(c22, 'abas').querySelector('#grupo-jobs')?.querySelector('.conversa-linha')?.querySelector('.conversa');
    tudoOk &= ok(botaoJob22?.tag === 'button', 'G22: pré-condição — a linha do job é clicável');
    let chamou22 = false;
    c22.abrirAba = () => { chamou22 = true; };
    botaoJob22?.onclick?.();
    tudoOk &= ok(chamou22 === false, 'G22: durante a carência do puxar, o clique na linha de job NÃO abre nada');
  });

  console.log('\n  · G23 (preservação): jobsPorAba só marca a bolinha para job running');
  await rodarGrupo('G23', async () => {
    const abasG23 = [
      { chave: 'a-run', titulo: 'r', cwd: '/tmp/g23-run', temAgente: true, rodando: false, sessaoId: 's1', atualizadoEm: 1 },
      { chave: 'a-done', titulo: 'd', cwd: '/tmp/g23-done', temAgente: true, rodando: false, sessaoId: 's2', atualizadoEm: 1 },
    ];
    const jobsG23 = [
      jobDoTesteG({ id: 'jr', estado: 'running', abas: ['a-run'] }),
      jobDoTesteG({ id: 'jd', estado: 'done', fim: horasAtrasJobs(1), abas: ['a-done'] }),
    ];
    const c23 = carregarCliente({
      aoBuscar: (rota) => (/api\/jobs/.test(String(rota)) ? { painel: true, jobs: jobsG23 } : { abas: abasG23 }),
    });
    await c23.carregarAbas();
    await c23.atualizarFaixaJobs();
    const todasConversas23 = [...porIdDe(c23, 'abas').querySelectorAll('.conversa')];
    const linhaRun23 = todasConversas23.find((b) => b.dataset.chave === 'a-run');
    const linhaDone23 = todasConversas23.find((b) => b.dataset.chave === 'a-done');
    tudoOk &= ok(Boolean(linhaRun23?.querySelector('.conversa-job')),
      'G23 (preservação): a aba com job RODANDO ganha a bolinha');
    tudoOk &= ok(!linhaDone23?.querySelector('.conversa-job'),
      'G23 (preservação): a aba cujo job já terminou NÃO ganha bolinha');
  });

  // ── Split view, fase 3 (docs/superpowers/plans/2026-09-08-split-view-plano.md, §3.4/§5.5
  //    da spec): S1…S17, na ordem do plano. S18 em diante são da caixa de envio por painel
  //    (docs/superpowers/plans/2026-09-09-caixa-de-envio-por-painel-plano.md) — o plano
  //    daquela mudança propunha S17 em diante, mas o split view já tinha um S17 aqui
  //    (desenharAbas/aria-current); renumerado para não colidir. ──────────────────────────
  console.log('\n  · Split view (S1…S17) + caixa de envio por painel (S18…S24) — N painéis lado a lado');

  const duasAbas = () => [
    { chave: 'aba-1', titulo: 'um', cwd: '/home/y/projetos/um', temClaude: true, rodando: false, sessaoId: 's1', atualizadoEm: 1000 },
    { chave: 'aba-2', titulo: 'dois', cwd: '/home/y/projetos/dois', temClaude: true, rodando: false, sessaoId: 's2', atualizadoEm: 1000 },
  ];
  const tresAbas = () => [
    ...duasAbas(),
    { chave: 'aba-3', titulo: 'três', cwd: '/home/y/projetos/tres', temClaude: true, rodando: false, sessaoId: 's3', atualizadoEm: 1000 },
  ];
  const comAbas = (abas) => (rota) => (String(rota).startsWith('api/abas') ? { abas } : { painel: true, jobs: [] });
  const linhaDe = (cliente, chave) => porIdDe(cliente, 'abas').querySelectorAll('.conversa-linha')
    .find((l) => l.querySelector('.conversa').dataset.chave === chave);

  await rodarGrupo('S1: dois painéis recebem eventos independentes, sem misturar', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });
    tudoOk &= ok(contarPaineis(cli) === 2, `S1: dois painéis na tela (${contarPaineis(cli)})`);
    const es = cli.fluxos.at(-1);
    mandarEvento(es, { tipo: 'sessao', meta: { titulo: 'Um', cwd: '/p1', contexto: null } }, 'aba-1');
    mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: false }, 'aba-1');
    mandarEvento(es, { tipo: 'sessao', meta: { titulo: 'Dois', cwd: '/p2', contexto: null } }, 'aba-2');
    mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: false }, 'aba-2');
    mandarEvento(es, { tipo: 'texto', texto: 'fala de A' }, 'aba-1');
    mandarEvento(es, { tipo: 'texto', texto: 'fala de B' }, 'aba-2');
    const fitaA = porIdDe(cli, 'fita', 0);
    const fitaB = porIdDe(cli, 'fita', 1);
    tudoOk &= ok(textoDe(fitaA).includes('fala de A') && !textoDe(fitaA).includes('fala de B'),
      'S1: a fita do painel A só tem o que é de A');
    tudoOk &= ok(textoDe(fitaB).includes('fala de B') && !textoDe(fitaB).includes('fala de A'),
      'S1: a fita do painel B só tem o que é de B');
  });

  await rodarGrupo('S2: a régua de rolagem é POR PAINEL — crescerJunto/crescePorFilho em cada um (R4)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });
    const es = cli.fluxos.at(-1);
    mandarEvento(es, { tipo: 'sessao', meta: { titulo: 'Um', cwd: '/p1', contexto: null } }, 'aba-1');
    mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: false }, 'aba-1');
    mandarEvento(es, { tipo: 'sessao', meta: { titulo: 'Dois', cwd: '/p2', contexto: null } }, 'aba-2');
    mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: false }, 'aba-2');

    const mensagensA = porIdDe(cli, 'mensagens', 0);
    const fitaA = porIdDe(cli, 'fita', 0);
    const mensagensB = porIdDe(cli, 'mensagens', 1);
    const fitaB = porIdDe(cli, 'fita', 1);
    // R4 da spec: sem amarrar a dupla EM CADA painel, o `scrollHeight` fica congelado e o
    // teste passa com a fita travada de verdade — o defeito de `b9799bf`, por outra porta.
    fitaA.crescerJunto = mensagensA; mensagensA.crescePorFilho = 200;
    fitaB.crescerJunto = mensagensB; mensagensB.crescePorFilho = 200;
    mensagensA.scrollHeight = 400; mensagensA.clientHeight = 400; mensagensA.scrollTop = 400; // A no fim
    mensagensB.scrollHeight = 4000; mensagensB.clientHeight = 400; mensagensB.scrollTop = 100; // B no meio

    mandarEvento(es, { tipo: 'texto', texto: 'mais uma fala em B' }, 'aba-2');
    tudoOk &= ok(mensagensB.scrollTop === 100,
      `S2: evento em B não arrasta B, que estava lendo o meio (${mensagensB.scrollTop})`);
    tudoOk &= ok(mensagensA.scrollTop === 400,
      `S2: e a régua de A nem se mexe — o evento não era dela (${mensagensA.scrollTop})`);

    mandarEvento(es, { tipo: 'texto', texto: 'mais uma fala em A' }, 'aba-1');
    tudoOk &= ok(mensagensA.scrollTop === mensagensA.scrollHeight && mensagensA.scrollTop > 400,
      `S2: A estava no fim e segue o PRÓPRIO evento (${mensagensA.scrollTop}/${mensagensA.scrollHeight})`);
  });

  await rodarGrupo('S3: abrir o 2º painel não empilha; fechar o ÚLTIMO desempilha', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    const pilhaAntes = cli.history.pilha.length;
    await cli.abrirAba('aba-1');
    tudoOk &= ok(cli.history.pilha.length === pilhaAntes + 1, 'S3: abrir o 1º painel empilha UMA entrada');
    await cli.abrirAba('aba-2', { aoLado: true });
    tudoOk &= ok(cli.history.pilha.length === pilhaAntes + 1,
      `S3: abrir o 2º painel do LADO não empilha de novo (${cli.history.pilha.length - pilhaAntes})`);
    tudoOk &= ok(contarPaineis(cli) === 2, 'S3: os dois estão na tela');

    cli.fecharPainel('aba-2');
    tudoOk &= ok(contarPaineis(cli) === 1 && cli.history.pilha.length === pilhaAntes + 1,
      'S3: fechar um painel que NÃO é o último não desempilha nada');
    cli.fecharPainel('aba-1');
    tudoOk &= ok(contarPaineis(cli) === 0 && cli.history.pilha.length === pilhaAntes,
      'S3: fechar o ÚLTIMO painel desempilha (pedirLista → history.back())');
  });

  // REESCRITO (caixa de envio por painel, 2026-09-09): a premissa de ontem era "a caixa e os
  // anexos SEGUEM o foco" — é exatamente o que a D42 revoga. Remendar deixaria em pé, em
  // verde, a prova de um contrato morto. Hoje o pointerdown troca o foco e NADA se move: os
  // dois textos coexistem (impossível quando a caixa era única) e o anexo de B fica em B.
  await rodarGrupo('S4: o pointerdown troca o foco e NADA se move', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });   // o foco fica em B

    const painelA = painelDe(cli, 0);
    const painelB = painelDe(cli, 1);
    const entradaA = painelA.querySelector('.entrada');
    const entradaB = painelB.querySelector('.entrada');
    entradaA.value = 'texto de A';
    entradaA.disparar('input', {});
    entradaB.value = 'texto de B';
    entradaB.disparar('input', {});
    // Anexo também é por painel (§4.3 da spec): soltar em B tem que continuar na caixa de B
    // mesmo com A focado.
    cli.painelAtual().anexos.push({ nome: 'captura.png', estado: 'pronto' });
    cli.desenharAnexos(cli.painelAtual());

    porIdDe(cli, 'paineis').disparar('pointerdown', { target: painelA });
    tudoOk &= ok(cli.painelAtual().chave === 'aba-1', 'S4: o pointerdown em A move o foco para A');
    tudoOk &= ok(entradaA.value === 'texto de A' && entradaB.value === 'texto de B',
      `S4: os dois textos coexistem — focar não move nada (A=${JSON.stringify(entradaA.value)}, B=${JSON.stringify(entradaB.value)})`);
    tudoOk &= ok(!textoDe(painelA.querySelector('.anexos')).includes('captura.png')
      && textoDe(painelB.querySelector('.anexos')).includes('captura.png'),
      'S4: o anexo de B continua na caixa de B — A focado não rouba nada');
  });

  await rodarGrupo('S5: turno_fim carimba lido em TODOS os painéis abertos (Fase 0 item 4 / R38)', async () => {
    const guardado = memoria();
    let atualizadoAba1 = 1000;
    const atualizadoAba2 = 2000;
    const cli = carregarCliente({
      guardado,
      aoBuscar: (rota) => (String(rota).startsWith('api/abas')
        ? { abas: [
            { chave: 'aba-1', titulo: 'um', cwd: '/p1', temClaude: true, rodando: false, sessaoId: 's1', atualizadoEm: atualizadoAba1 },
            { chave: 'aba-2', titulo: 'dois', cwd: '/p2', temClaude: true, rodando: false, sessaoId: 's2', atualizadoEm: atualizadoAba2 },
          ] }
        : { painel: true, jobs: [] }),
    });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });
    const es = cli.fluxos.at(-1);
    atualizadoAba1 = 9000;   // o turno de A respondeu: o servidor já sabe da fala nova
    mandarEvento(es, { tipo: 'turno_fim' }, 'aba-1');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const lidas = JSON.parse(guardado.getItem('cockpit-lidas'));
    tudoOk &= ok(lidas.s1 === 9000, 'S5: a conversa que terminou o turno é marcada lida');
    tudoOk &= ok(lidas.s2 === 2000,
      `S5: e a OUTRA aba aberta TAMBÉM — "aberto" é "lido", não só quem terminou o turno (${JSON.stringify(lidas)})`);
  });

  await rodarGrupo('S6: o ✕/Parar/as teclas de B agem só sobre B, nunca sobre o foco (R14)', async () => {
    const rotas = [];
    const cli = carregarCliente({
      aoBuscar: (rota) => {
        rotas.push(String(rota));
        if (String(rota).startsWith('api/abas/')) return {};
        if (String(rota).startsWith('api/abas')) return { abas: duasAbas() };
        return { painel: true, jobs: [] };
      },
    });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });   // o foco fica em B

    rotas.length = 0;
    await painelDe(cli, 0).querySelector('.btn-parar').onclick();
    tudoOk &= ok(rotas.some((r) => r.includes('aba-1/turnos/atual')) && !rotas.some((r) => r.includes('aba-2/turnos')),
      `S6: o Parar do painel A mira em A, mesmo com B focado (${rotas.join(', ')})`);

    const esAtual = cli.fluxos.at(-1);
    mandarEvento(esAtual, { tipo: 'esperando', valor: true }, 'aba-1');
    rotas.length = 0;
    await painelDe(cli, 0).querySelector('.tecla-left').onclick();
    tudoOk &= ok(rotas.some((r) => r.includes('aba-1/teclas')) && !rotas.some((r) => r.includes('aba-2/teclas')),
      `S6: a tecla apertada em A manda para A, mesmo com B focado (${rotas.join(', ')})`);

    painelDe(cli, 1).querySelector('.btn-matar-aba').onclick();   // B pede a PRÓPRIA morte
    rotas.length = 0;
    await cli.porId.get('btn-confirma-matar-aba').onclick({ currentTarget: { dataset: {} } });
    tudoOk &= ok(rotas.includes('api/abas/aba-2') && !rotas.includes('api/abas/aba-1'),
      `S6: o ✕ pede o DELETE da aba que ele mesmo É, nunca a do foco (${rotas.join(', ')})`);
    tudoOk &= ok(contarPaineis(cli) === 1 && cli.painelAtual().chave === 'aba-1',
      'S6: fechado o foco (B), o vizinho assume — a tela não fica sem dono');
  });

  // REESCRITO (caixa de envio por painel, 2026-09-09): "o Enviar segue o FOCO" é o contrato
  // que a D42 revoga — remendar deixaria em pé a prova de algo morto. Vira "cada Enviar
  // trava pelo `perguntando` do SEU painel": trocar o foco não muda nenhum dos dois.
  await rodarGrupo('S7: cada Enviar trava pelo `perguntando` do SEU painel', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });   // foco em B
    const es = cli.fluxos.at(-1);
    const btnA = () => painelDe(cli, 0).querySelector('.btn-enviar');
    const btnB = () => painelDe(cli, 1).querySelector('.btn-enviar');
    mandarEvento(es, { tipo: 'esperando', valor: true }, 'aba-1');   // A pergunta, B não
    tudoOk &= ok(btnA().disabled === true && btnB().disabled === false,
      'S7: A trava pelo PRÓPRIO perguntando; B (não perguntando) continua livre');
    porIdDe(cli, 'paineis').disparar('pointerdown', { target: painelDe(cli, 1) });   // foca B
    tudoOk &= ok(cli.painelAtual().chave === 'aba-2' && btnA().disabled === true && btnB().disabled === false,
      'S7: focar B não muda nenhum dos dois — o botão é do painel, não do foco (D42)');
    mandarEvento(es, { tipo: 'esperando', valor: false }, 'aba-1');   // A destrava sozinho
    tudoOk &= ok(btnA().disabled === false && btnB().disabled === false,
      'S7: A destrava sem depender do foco');
  });

  await rodarGrupo('S8: `removida` de um painel NÃO-focado fecha só ele; chegada dupla é no-op (R15)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });   // foco em B
    const es = cli.fluxos.at(-1);
    mandarEvento(es, { tipo: 'removida', id: 'aba-1' }, 'aba-1');   // A não é o foco
    tudoOk &= ok(contarPaineis(cli) === 1 && cli.painelAtual().chave === 'aba-2',
      'S8: `removida` de A fecha só A — o foco em B continua intacto');
    cli.fecharPainel('aba-1');   // a chegada DUPLA: DELETE do ✕ + o evento, ou vice-versa
    tudoOk &= ok(contarPaineis(cli) === 1 && cli.painelAtual().chave === 'aba-2',
      'S8: fechar de novo a mesma chave (já fora do Map) é no-op — B não é afetado');
  });

  await rodarGrupo('S9: Alt+J/Alt+K com 3 painéis move o FOCO, não fecha nada (R6)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(tresAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });
    await cli.abrirAba('aba-3', { aoLado: true });   // foco em aba-3
    tudoOk &= ok(contarPaineis(cli) === 3, 'S9: os três painéis estão na tela');
    cli.pularAba(-1);
    tudoOk &= ok(contarPaineis(cli) === 3 && cli.painelAtual().chave === 'aba-2',
      `S9: Alt+K move o foco para o vizinho, sem fechar nada (${cli.painelAtual().chave})`);
    cli.pularAba(-1);
    tudoOk &= ok(contarPaineis(cli) === 3 && cli.painelAtual().chave === 'aba-1', 'S9: e de novo');
    cli.pularAba(-1);
    tudoOk &= ok(cli.painelAtual().chave === 'aba-1', 'S9: no primeiro, Alt+K grampeia — não circula');
    cli.pularAba(1);
    cli.pularAba(1);
    tudoOk &= ok(cli.painelAtual().chave === 'aba-3' && contarPaineis(cli) === 3,
      'S9: Alt+J avança até o último, sem fechar painel nenhum no caminho');
  });

  await rodarGrupo('S10: o drop de arquivo resolve o painel pelo ALVO, não pelo foco (R7)', async () => {
    const cli = carregarCliente({
      aoBuscar: (rota) => {
        const r = String(rota);
        if (r.startsWith('api/abas/') && r.includes('/anexos')) {
          const nome = decodeURIComponent(r.split('nome=')[1] || 'arquivo');
          return { arquivo: `inbox/${nome}`, nome };
        }
        if (r.startsWith('api/abas')) return { abas: duasAbas() };
        return { painel: true, jobs: [] };
      },
    });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });   // foco em B
    const raizA = painelDe(cli, 0);
    const arquivo = { name: 'nota.txt', type: 'text/plain' };
    cli.porId.get('chat').disparar('drop', {
      target: raizA, preventDefault() {}, dataTransfer: { files: [arquivo] },
    });
    await new Promise((r) => setImmediate(r));
    tudoOk &= ok(cli.painelAtual().chave === 'aba-1', 'S10: soltar em A foca A — mesmo B tendo o foco antes');
    tudoOk &= ok(cli.painelAtual().anexos.some((a) => a.nome === 'nota.txt'),
      'S10: e o arquivo entra no painel de BAIXO DO CURSOR, não no que estava focado');

    const antes = cli.painelAtual().anexos.length;
    cli.porId.get('chat').disparar('drop', {
      target: cli.document.getElementById('vazio'), preventDefault() {}, dataTransfer: { files: [arquivo] },
    });
    tudoOk &= ok(cli.painelAtual().anexos.length === antes,
      'S10: sem painel nenhum debaixo do cursor, o solto é ignorado — não cai no foco');
  });

  await rodarGrupo('S11: `sessao` de reconexão preserva a rolagem de quem NÃO estava no fim, com turno rodando (R19/R31/R33)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });
    const es = cli.fluxos.at(-1);
    mandarEvento(es, { tipo: 'sessao', meta: { titulo: 'Um', cwd: '/p1', contexto: null } }, 'aba-1');
    mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: false }, 'aba-1');
    mandarEvento(es, { tipo: 'sessao', meta: { titulo: 'Dois', cwd: '/p2', contexto: null } }, 'aba-2');
    mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: true }, 'aba-2');   // turno RODANDO em B

    const mensagensB = porIdDe(cli, 'mensagens', 1);
    const fitaB = porIdDe(cli, 'fita', 1);
    fitaB.crescerJunto = mensagensB; mensagensB.crescePorFilho = 200;
    mensagensB.scrollHeight = 4000; mensagensB.clientHeight = 600; mensagensB.scrollTop = 1200;   // lendo o meio

    // A reconexão automática (`fluxo.onerror`) reemite `sessao` para TODAS as abas do cano —
    // é o MESMO caminho que este segundo envelope simula (R31: um lugar cobre religar,
    // reconexão e `/clear`).
    mandarEvento(es, { tipo: 'sessao', meta: { titulo: 'Dois', cwd: '/p2', contexto: null } }, 'aba-2');
    mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: true }, 'aba-2');
    tudoOk &= ok(mensagensB.scrollTop === 1200,
      `S11: a reconexão NÃO arrasta quem estava lendo o meio da conversa (${mensagensB.scrollTop})`);

    // R33 passo 4: a bolha "trabalhando" chegando com o turno ainda rodando não é gesto do
    // usuário — não arrasta quem está lendo.
    mandarEvento(es, { tipo: 'texto', texto: 'mais uma fala' }, 'aba-2');
    tudoOk &= ok(mensagensB.scrollTop === 1200,
      `S11: nem um evento novo com o turno rodando arrasta quem está lendo (${mensagensB.scrollTop})`);
  });

  await rodarGrupo('S12: a janela ficando estreita colapsa para o painel FOCADO (R18/R41)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });   // foco em B
    tudoOk &= ok(contarPaineis(cli) === 2, 'S12: os dois painéis abertos antes de estreitar');
    cli.colapsarParaFocoNoEstreito();
    tudoOk &= ok(contarPaineis(cli) === 1 && cli.painelAtual().chave === 'aba-2',
      `S12: colapsou para o painel FOCADO, o outro saiu da tela (${cli.painelAtual().chave}, ${contarPaineis(cli)})`);
    cli.colapsarParaFocoNoEstreito();   // voltar a ficar largo não reabre nada sozinho (D30/D33)
    tudoOk &= ok(contarPaineis(cli) === 1, 'S12: e não reabre nada sozinho — o usuário reabre o que quiser');
  });

  await rodarGrupo('S13: trocar A+B por C não volta para a lista; o rascunho de A volta ao reabrir (R27/R28)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(tresAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });
    porIdDe(cli, 'paineis').disparar('pointerdown', { target: painelDe(cli, 0) });   // foca A
    porIdDe(cli, 'entrada').value = 'rascunho de A que não foi enviado';
    // `porIdDe`, nunca `cli.porId.get()` direto: este furaria o resolvedor por painel e
    // disparia `input` num nó solto que ninguém escuta (§5.5 item 13 da spec).
    painelDe(cli, 0).querySelector('.entrada').disparar('input', {});

    const appEl = porIdDe(cli, 'app');
    const pilhaAntes = cli.history.pilha.length;
    await cli.abrirAba('aba-3');   // clique simples na lista — troca o CONJUNTO inteiro
    tudoOk &= ok(appEl.dataset.vista === 'chat' && cli.history.pilha.length === pilhaAntes,
      'S13: trocar o conjunto não volta para a lista nem empilha de novo (R27)');
    tudoOk &= ok(contarPaineis(cli) === 1 && cli.painelAtual().chave === 'aba-3',
      'S13: só C ficou na tela, e é ele o foco');

    await cli.abrirAba('aba-1');   // reabre A NESTA sessão
    tudoOk &= ok(porIdDe(cli, 'entrada').value === 'rascunho de A que não foi enviado',
      `S13: o rascunho de A volta ao reabrir a mesma aba nesta sessão (R28) (${porIdDe(cli, 'entrada').value})`);
  });

  await rodarGrupo('S14: histórico e rascunho não vazam entre painéis ao trocar o foco (R29)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });   // foco em B
    const campo = { value: '', selectionStart: 0, selectionEnd: 0, style: {}, scrollHeight: 40, setSelectionRange() {} };

    porIdDe(cli, 'paineis').disparar('pointerdown', { target: painelDe(cli, 0) });   // foca A
    const painelA = cli.painelAtual();
    cli.lembrar(painelA, 'primeira mensagem de A');
    campo.value = 'estou digitando em A';
    cli.navegarHistorico(painelA, -1, campo);
    tudoOk &= ok(campo.value === 'primeira mensagem de A' && painelA.rascunho === 'estou digitando em A'
      && painelA.posHistorico === 0,
      `S14: ↑ em A mostra o histórico DELE e guarda o rascunho de A (${campo.value})`);

    porIdDe(cli, 'paineis').disparar('pointerdown', { target: painelDe(cli, 1) });   // foca B
    const painelB = cli.painelAtual();
    tudoOk &= ok(painelB.posHistorico === null && painelB.historicoEntrada.length === 0,
      'S14: B não herda o índice de histórico de A — cada painel tem o SEU');

    porIdDe(cli, 'paineis').disparar('pointerdown', { target: painelDe(cli, 0) });   // volta para A
    tudoOk &= ok(cli.painelAtual() === painelA && painelA.posHistorico === 0,
      'S14: voltar para A retoma exatamente onde ele tinha parado no histórico — `posHistorico` não vazou');

    // Escape: a MESMA ordem do handler de verdade — escreve o rascunho, DEPOIS sai do histórico.
    cli.escreverNaCaixa(painelA, painelA.rascunho, campo);
    cli.sairDoHistorico(painelA);
    tudoOk &= ok(campo.value === 'estou digitando em A' && painelA.posHistorico === null,
      `S14: Escape devolve o rascunho de A (${campo.value})`);
  });

  await rodarGrupo('S15: o medidor de A abre o <dialog> com os números de A, mesmo com B por último (R30)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });
    const es = cli.fluxos.at(-1);
    mandarEvento(es, { tipo: 'sessao', meta: { titulo: 'Um', cwd: '/p1',
      contexto: { usados: 10000, teto: 200000, pct: 5, modelo: 'claude-opus-5' } } }, 'aba-1');
    mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: false }, 'aba-1');
    // B chega POR ÚLTIMO, com números BEM diferentes — a tentação de um `contextoAtual`
    // global (R30): se existisse, o clique no medidor de A abriria os números de B.
    mandarEvento(es, { tipo: 'sessao', meta: { titulo: 'Dois', cwd: '/p2',
      contexto: { usados: 190000, teto: 200000, pct: 95, modelo: 'claude-opus-5' } } }, 'aba-2');
    mandarEvento(es, { tipo: 'sincronizado', turnoEmAndamento: false }, 'aba-2');

    painelDe(cli, 0).querySelector('.medidor').onclick();
    const legenda = cli.porId.get('contexto-legenda').textContent;
    tudoOk &= ok(legenda.includes('10.000'), `S15: o medidor de A abre os números de A (${legenda})`);
    tudoOk &= ok(!legenda.includes('190.000'), 'S15: e NÃO os de B, mesmo tendo chegado por último');
  });

  await rodarGrupo('S16: Ctrl+clique na lista abre AO LADO e foca o painel novo (R25)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    const es1 = cli.fluxos.at(-1);
    mandarEvento(es1, { tipo: 'sessao', meta: { titulo: 'Conversa Um', cwd: '/p1', contexto: null } }, 'aba-1');
    mandarEvento(es1, { tipo: 'sincronizado', turnoEmAndamento: false }, 'aba-1');

    const linha = linhaDe(cli, 'aba-2').querySelector('.conversa');
    linha.onclick({ ctrlKey: true });
    await new Promise((r) => setImmediate(r));
    tudoOk &= ok(contarPaineis(cli) === 2 && cli.painelAtual().chave === 'aba-2',
      'S16: Ctrl+clique ACRESCENTA o painel novo e ROUBA o foco (R25)');
    const es2 = cli.fluxos.at(-1);
    mandarEvento(es2, { tipo: 'sessao', meta: { titulo: 'Conversa Dois', cwd: '/p2', contexto: null } }, 'aba-2');
    mandarEvento(es2, { tipo: 'sincronizado', turnoEmAndamento: false }, 'aba-2');
  });

  await rodarGrupo('S17: desenharAbas() repintando não perde o foco nem o data-aberta das outras', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    await cli.abrirAba('aba-2', { aoLado: true });   // foco em B
    await cli.carregarAbas();   // o mesmo tique de 5s que a lista já faz — repinta do zero

    const linhaA = linhaDe(cli, 'aba-1');
    const linhaB = linhaDe(cli, 'aba-2');
    tudoOk &= ok(linhaB.querySelector('.conversa').getAttribute('aria-current') === 'true'
      && linhaA.querySelector('.conversa').getAttribute('aria-current') === 'false',
      'S17: aria-current continua marcando o painel FOCADO depois de repintar');
    tudoOk &= ok(linhaA.dataset.aberta === '1' && linhaB.dataset.aberta === undefined,
      `S17: a aberta-mas-não-focada ganha data-aberta="1"; a focada não precisa dele (${linhaA.dataset.aberta})`);
  });

  // ── Caixa de envio por painel (2026-09-09), fase 3 do plano: S18…S24. Renumerados a
  //    partir do S17 do split view, que já ocupava o nome que o plano desta mudança propunha
  //    para o primeiro caso novo (ver o comentário no topo deste bloco). ───────────────────

  // Upload de anexo, no mesmo padrão do S10: `text/plain` evita o `URL.createObjectURL` que
  // este DOM de mentira não tem.
  const aoBuscarComAnexo = (abas) => (rota) => {
    const r = String(rota);
    if (r.startsWith('api/abas/') && r.includes('/anexos')) {
      const nome = decodeURIComponent(r.split('nome=')[1] || 'arquivo');
      return { arquivo: `inbox/${nome}`, nome };
    }
    if (r.startsWith('api/abas')) return { abas };
    return { painel: true, jobs: [] };
  };

  await rodarGrupo('S18: duas caixas, dois destinos — nenhum cruzado (o caso obrigatório do card)', async () => {
    const rotasS18 = [];
    const cli = carregarCliente({ aoBuscar: (rota, opcoes) => {
      rotasS18.push({ rota: String(rota), opcoes });
      if (/\/turnos$/.test(String(rota))) return { enviado: true };
      if (String(rota).startsWith('api/abas')) return { abas: duasAbas() };
      return { painel: true, jobs: [] };
    } });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    const painelA = cli.painelAtual();
    await cli.abrirAba('aba-2', { aoLado: true });
    const painelB = cli.painelAtual();

    painelA.entrada.value = 'texto de A';
    painelB.entrada.value = 'texto de B';
    // SEM focar() entre um e outro — é o caso que a #51 (elemento que se multiplica) existe
    // para provar, no controle mais usado da tela.
    await painelA.btnEnviar.onclick();
    await painelB.btnEnviar.onclick();

    const postsA = rotasS18.filter((r) => r.rota === 'api/abas/aba-1/turnos');
    const postsB = rotasS18.filter((r) => r.rota === 'api/abas/aba-2/turnos');
    tudoOk &= ok(postsA.length === 1 && JSON.parse(postsA[0].opcoes.body).texto === 'texto de A',
      'S18: o POST de A leva o texto de A, na rota de A');
    tudoOk &= ok(postsB.length === 1 && JSON.parse(postsB[0].opcoes.body).texto === 'texto de B',
      'S18: o POST de B leva o texto de B, na rota de B');
    tudoOk &= ok(!postsA.some((r) => JSON.parse(r.opcoes.body).texto === 'texto de B')
      && !postsB.some((r) => JSON.parse(r.opcoes.body).texto === 'texto de A'),
      'S18: nenhum texto saiu pela rota do outro painel');

    // O caminho do ENTER, o mais fácil de deixar para trás: o `keydown` migrado é o handler
    // onde um `paineis.get(atual)` esquecido mais provavelmente sobrevive — os testes de
    // Enter de hoje rodam com um painel só, onde `atual` e o painel do closure coincidem, e
    // o esquecimento passaria em todos eles.
    rotasS18.length = 0;
    painelA.entrada.value = 'enter de A';
    painelA.entrada.disparar('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => {} });
    await respirar();
    const postsEnterA = rotasS18.filter((r) => r.rota === 'api/abas/aba-1/turnos');
    tudoOk &= ok(postsEnterA.length === 1 && JSON.parse(postsEnterA[0].opcoes.body).texto === 'enter de A',
      'S18: Enter na caixa de A envia para aba-1, mesmo com B selecionado (atual)');
  });

  await rodarGrupo('S19: o rascunho já está na caixa ao reabrir a mesma aba, sem focar() no meio (§3.4)', async () => {
    const cli = carregarCliente({ aoBuscar: comAbas(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    const painelA = cli.painelAtual();
    painelA.entrada.value = 'texto de A';
    painelA.entrada.disparar('input', {});
    const info = duasAbas()[0];
    cli.tirarPainel('aba-1');
    const painelNovo = cli.criarPainel('aba-1', info);
    tudoOk &= ok(painelNovo.entrada.value === 'texto de A',
      `S19: o rascunho de A já está na caixa nova, sem focar() nenhum (${JSON.stringify(painelNovo.entrada.value)})`);
  });

  await rodarGrupo('S20: a paleta é do painel e segue o CURSOR (§3.5/§3.6 da spec)', async () => {
    // (a), (b), (c) — catálogo resolve na hora.
    const cli = carregarCliente({ aoBuscar: (rota) => {
      if (String(rota).startsWith('api/catalogo')) return { itens: [{ nome: 'clear', tipo: 'comando', origem: 'embutido', invocacao: '/clear' }] };
      if (String(rota).startsWith('api/abas')) return { abas: duasAbas() };
      return { painel: true, jobs: [] };
    } });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    const painelA = cli.painelAtual();
    await cli.abrirAba('aba-2', { aoLado: true });
    const painelB = cli.painelAtual();

    // (a) abrir a paleta em A, disparar blur na caixa de A E RODAR O TIMER — nunca chamar
    // fecharPaleta direto: o que pode ficar para trás é o HANDLER, não a função.
    painelA.entrada.focus();
    painelA.entrada.value = '/cl';
    await cli.talvezAbrirPaleta(painelA);
    tudoOk &= ok(painelA.paleta.hidden === false, 'S20(a): a paleta de A abriu ao digitar /cl');
    painelA.entrada.disparar('blur', {});
    const timerBlurA = [...cli.temporizadores.values()].at(-1);
    timerBlurA.fn();
    tudoOk &= ok(painelA.paleta.hidden === true && painelB.paleta.hidden === true,
      'S20(a): o timer do blur fecha a paleta de A, e a de B nunca abriu');

    // (b) arrays de escolha DISTINTOS — não é estado de módulo (§3.5, ARMADILHA #51).
    tudoOk &= ok(painelA.escolhidosPaleta !== painelB.escolhidosPaleta,
      'S20(b): A e B têm o PRÓPRIO array de escolha da paleta');

    // (c) com B selecionado e o CURSOR em A, digitar / em A abre a paleta de A.
    painelA.entrada.focus();
    cli.focar(painelB);   // B fica selecionado; `focar()` não toca foco — cursor CONTINUA em A
    tudoOk &= ok(cli.painelAtual().chave === 'aba-2' && cli.document.activeElement === painelA.entrada,
      'S20(c) pré-condição: B selecionado, cursor em A');
    painelA.entrada.value = '/cl';
    await cli.talvezAbrirPaleta(painelA);
    tudoOk &= ok(painelA.paleta.hidden === false,
      'S20(c): digitar / em A abre a paleta de A mesmo com B selecionado — o autocomplete não morre calado');

    // (d) catálogo de A respondendo DEPOIS de o cursor ter ido para B → nenhuma paleta abre.
    let resolverCatalogoLento;
    const cliLento = carregarCliente({ aoBuscar: (rota) => {
      if (String(rota).startsWith('api/catalogo')) return new Promise((r) => { resolverCatalogoLento = r; });
      if (String(rota).startsWith('api/abas')) return { abas: duasAbas() };
      return { painel: true, jobs: [] };
    } });
    await cliLento.carregarAbas();
    await cliLento.abrirAba('aba-1');
    const painelLentoA = cliLento.painelAtual();
    await cliLento.abrirAba('aba-2', { aoLado: true });
    const painelLentoB = cliLento.painelAtual();
    painelLentoA.entrada.focus();
    painelLentoA.entrada.value = '/cl';
    const promessaLenta = cliLento.talvezAbrirPaleta(painelLentoA);
    painelLentoB.entrada.focus();   // o cursor vai para B ANTES da resposta chegar
    resolverCatalogoLento({ itens: [{ nome: 'clear', tipo: 'comando', origem: 'embutido', invocacao: '/clear' }] });
    await promessaLenta;
    tudoOk &= ok(painelLentoA.paleta.hidden === true && painelLentoB.paleta.hidden === true,
      'S20(d): catálogo tardio de A não abre paleta nenhuma — o cursor já foi para B');
  });

  await rodarGrupo('S21: o `focus` da caixa move `atual` — o caminho do Tab (§3.7 da spec)', async () => {
    const cli = carregarCliente({ aoBuscar: aoBuscarComAnexo(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    const painelA = cli.painelAtual();
    await cli.abrirAba('aba-2', { aoLado: true });
    const painelB = cli.painelAtual();
    cli.focar(painelA);   // volta a seleção para A, sem focus algum — de onde o teste parte
    tudoOk &= ok(cli.painelAtual().chave === 'aba-1', 'S21 pré-condição: A está selecionado');

    painelB.entrada.focus();   // o caminho do Tab: sem pointerdown nenhum
    tudoOk &= ok(cli.painelAtual().chave === 'aba-2', 'S21: o `focus` sozinho (sem pointerdown) move `atual` para B');

    const arquivoFake = { name: 'x.txt', type: 'text/plain' };
    for (const fn of cli.ouvintes.get('paste') || []) {
      fn({ clipboardData: { files: [arquivoFake] }, target: painelB.entrada, preventDefault: () => {} });
    }
    await respirar();
    tudoOk &= ok(painelB.anexos.some((a) => a.nome === 'x.txt'),
      'S21: e o paste em seguida vai para os anexos de B');
  });

  await rodarGrupo('S22: quem move `atual` por CÓDIGO leva o cursor junto (§3.9, consequência 2)', async () => {
    // (1) Alt+J com 2 painéis — incondicional: quem usa o atalho está de mãos no teclado.
    const cli = carregarCliente({ aoBuscar: aoBuscarComAnexo(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    const painelA = cli.painelAtual();
    await cli.abrirAba('aba-2', { aoLado: true });
    const painelB = cli.painelAtual();
    cli.focar(painelA);
    painelA.entrada.focus();
    for (const fn of cli.ouvintes.get('keydown') || []) {
      fn({ key: 'j', code: 'KeyJ', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
        repeat: false, target: null, preventDefault: () => {}, getModifierState: () => false });
    }
    tudoOk &= ok(cli.painelAtual().chave === 'aba-2' && cli.document.activeElement === painelB.entrada,
      'S22(1): Alt+J move `atual` E o cursor para B, juntos');

    // (2) drop de arquivo em B — o `preventDefault()` do handler impede o navegador de focar.
    cli.focar(painelA); painelA.entrada.focus();   // reset: cursor e atual de volta em A
    const raizB = painelDe(cli, 1);
    cli.porId.get('chat').disparar('drop', {
      target: raizB, preventDefault() {}, dataTransfer: { files: [{ name: 'y.txt', type: 'text/plain' }] },
    });
    await respirar();
    tudoOk &= ok(cli.painelAtual().chave === 'aba-2' && cli.document.activeElement === painelB.entrada,
      'S22(2): o drop em B move `atual` E o cursor para B, juntos');

    // (3) fecharPainel do painel em que o cursor ESTAVA (que também era o selecionado).
    cli.focar(painelB); painelB.entrada.focus();   // cursor e atual em B
    cli.fecharPainel('aba-2');
    const painelQueSobrou = cli.painelAtual();
    tudoOk &= ok(painelQueSobrou.chave === 'aba-1' && cli.document.activeElement === painelQueSobrou.entrada,
      'S22(3): fechar o painel do cursor (que também era o selecionado) leva o cursor ao vizinho');

    // Caso negativo (a): TRÊS painéis, cursor em A, SELECIONADO B, `removida` de B pelo
    // terminal → o cursor CONTINUA em A, não pula para C — mesmo a SELEÇÃO indo para C.
    const cli3a = carregarCliente({ aoBuscar: comAbas(tresAbas()) });
    await cli3a.carregarAbas();
    await cli3a.abrirAba('aba-1');
    const painelA3a = cli3a.painelAtual();
    await cli3a.abrirAba('aba-2', { aoLado: true });
    const painelB3a = cli3a.painelAtual();
    await cli3a.abrirAba('aba-3', { aoLado: true });
    cli3a.focar(painelA3a); painelA3a.entrada.focus();   // cursor em A
    cli3a.focar(painelB3a);                              // B selecionado, cursor continua em A
    const es3a = cli3a.fluxos.at(-1);
    mandarEvento(es3a, { tipo: 'removida' }, 'aba-2');
    tudoOk &= ok(cli3a.painelAtual().chave === 'aba-3',
      'S22(a): removida de B — a SELEÇÃO pula para o vizinho (C), como sempre');
    tudoOk &= ok(cli3a.document.activeElement === painelA3a.entrada,
      'S22(a): mas o CURSOR continua em A — não pula para C junto com a seleção');

    // Caso negativo (b): cursor em A, selecionado B, `removida` de A (o painel do CURSOR,
    // que NÃO é o selecionado) → document.activeElement fica NULO — cursor inerte é melhor
    // que cursor roubado em silêncio para a caixa de outro agente.
    const cli3b = carregarCliente({ aoBuscar: comAbas(tresAbas()) });
    await cli3b.carregarAbas();
    await cli3b.abrirAba('aba-1');
    const painelA3b = cli3b.painelAtual();
    await cli3b.abrirAba('aba-2', { aoLado: true });
    const painelB3b = cli3b.painelAtual();
    await cli3b.abrirAba('aba-3', { aoLado: true });
    cli3b.focar(painelA3b); painelA3b.entrada.focus();
    cli3b.focar(painelB3b);
    const es3b = cli3b.fluxos.at(-1);
    mandarEvento(es3b, { tipo: 'removida' }, 'aba-1');
    tudoOk &= ok(cli3b.document.activeElement === null,
      'S22(b): removida do painel do CURSOR (não o selecionado) deixa o cursor NULO — nenhum painel o roubou');
  });

  await rodarGrupo('S23: o `paste` segue o CURSOR, não o painel SELECIONADO (§3.9, consequência 1)', async () => {
    const cli = carregarCliente({ aoBuscar: aoBuscarComAnexo(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    const painelA = cli.painelAtual();
    await cli.abrirAba('aba-2', { aoLado: true });
    const painelB = cli.painelAtual();

    painelA.entrada.focus();          // cursor em A
    const fitaB = painelDe(cli, 1);   // pointerdown na fita de B — seleciona, não move o cursor
    cli.porId.get('paineis').disparar('pointerdown', { target: fitaB });
    tudoOk &= ok(cli.painelAtual().chave === 'aba-2' && cli.document.activeElement === painelA.entrada,
      'S23 pré-condição: B selecionado pelo pointerdown na fita, cursor CONTINUA em A');

    const arquivoFake = { name: 'z.txt', type: 'text/plain' };
    for (const fn of cli.ouvintes.get('paste') || []) {
      fn({ clipboardData: { files: [arquivoFake] }, target: painelA.entrada, preventDefault: () => {} });
    }
    await respirar();
    tudoOk &= ok(painelA.anexos.some((a) => a.nome === 'z.txt') && !painelB.anexos.some((a) => a.nome === 'z.txt'),
      'S23: o anexo entra em A (o painel do CURSOR), não em B (o selecionado)');
  });

  await rodarGrupo('S24: o seletor de arquivos (`.inp-arquivo`) é do painel do BOTÃO', async () => {
    const cli = carregarCliente({ aoBuscar: aoBuscarComAnexo(duasAbas()) });
    await cli.carregarAbas();
    await cli.abrirAba('aba-1');
    const painelA = cli.painelAtual();
    await cli.abrirAba('aba-2', { aoLado: true });   // B selecionado
    const painelB = cli.painelAtual();

    const arquivoFake = { name: 'w.txt', type: 'text/plain' };
    painelA.inpArquivo.files = [arquivoFake];
    // O `value` tem que nascer SUJO, senão o assert (b) não prova nada: o mock cria o input
    // com `value: ''`, então "reseta para vazio" já era verdade antes do handler rodar.
    // Apontado pelo painel de execução, que conferiu removendo o reset do app.js e viu os dois
    // asserts continuarem verdes. É a #44 pelo avesso: assert que casa por coincidência.
    painelA.inpArquivo.value = 'C:\\fakepath\\w.txt';
    painelA.inpArquivo.disparar('change', { target: painelA.inpArquivo });
    await respirar();
    tudoOk &= ok(painelA.anexos.some((a) => a.nome === 'w.txt') && !painelB.anexos.some((a) => a.nome === 'w.txt'),
      'S24(a): o change no seletor de A entra em A, mesmo com B selecionado');
    tudoOk &= ok(painelA.inpArquivo.value === '',
      'S24(b): o value do input reseta — sem isto, escolher o MESMO arquivo de novo não dispara evento');
  });

  return Boolean(tudoOk);
}

// ─── Parte B ─────────────────────────────────────────────────────────────────

const TOKEN = process.env.COCKPIT_TOKEN || '';

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (corpo) headers['content-type'] = 'application/json';
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const req = http.request({ ...BASE, path: rota, method: metodo, headers }, (res) => {
      let dados = '';
      res.on('data', (d) => { dados += d; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: dados ? JSON.parse(dados) : {} }));
    });
    req.on('error', reject);
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

/** Como `pedir`, mas devolve o corpo cru: download não é JSON. */
function bruto(metodo, rota) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const req = http.request({ ...BASE, path: rota, method: metodo, headers }, (res) => {
      const pedacos = [];
      res.on('data', (d) => pedacos.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(pedacos) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function parteB() {
  console.log('\n── Parte B: catálogo e exclusão (exige o serviço no ar) ──\n');
  let tudoOk = true;

  const catalogo = await pedir('GET', '/api/catalogo');
  tudoOk &= ok(catalogo.status === 200, `GET /api/catalogo responde 200 (${catalogo.status})`);
  const itens = catalogo.corpo.itens || [];
  tudoOk &= ok(itens.length > 20, `catálogo traz as skills e comandos do usuário (${itens.length} itens)`);
  const audita = itens.find((i) => i.nome === 'audita');
  tudoOk &= ok(Boolean(audita), 'o comando /audita está no catálogo');
  tudoOk &= ok(Boolean(audita && audita.descricao), 'o item traz descrição para o preview');
  tudoOk &= ok(!itens.some((i) => /\.bak/.test(i.nome)), 'backups .bak ficam de fora');
  tudoOk &= ok(itens.every((i) => Object.keys(i).join() === 'nome,tipo,origem,descricao'),
    'só nome/tipo/origem/descrição saem do servidor — nunca o corpo dos arquivos');

  // Abas do terminal: o que o navegador manda para elas.
  const listaAbas = await pedir('GET', '/api/abas');
  tudoOk &= ok(listaAbas.status === 200, `GET /api/abas responde 200 (${listaAbas.status})`);
  const asAbas = listaAbas.corpo.abas || [];
  tudoOk &= ok(!JSON.stringify(asAbas).includes('.jsonl'),
    'a lista não expõe o caminho do arquivo do CLI — o cliente não precisa dele');
  // Os DOIS formatos convivem: `aba-p<n>` é uma pane com CLI (ou uma janela de uma pane
  // só), `aba-<n>` é a janela inteira quando não há CLI em pane nenhuma e há mais de uma.
  tudoOk &= ok(asAbas.every((a) => /^aba-p?\d+$/.test(a.chave)),
    'toda aba tem chave no formato que as rotas casam');
  // `atualizadoEm` é o que deixa a lista distinguir lida de "te esperando". Sai o NÚMERO.
  tudoOk &= ok(asAbas.every((a) => 'atualizadoEm' in a
    && (a.atualizadoEm === null || typeof a.atualizadoEm === 'number')),
    'toda aba traz `atualizadoEm` — número ou null, nunca caminho');
  tudoOk &= ok(asAbas.every((a) => !a.temClaude || a.atualizadoEm === null || a.atualizadoEm > 1e12),
    'e o número é mtime em milissegundos, não segundos');
  // `esperando` é o estado que o .jsonl não conhece: menu aberto na TUI.
  tudoOk &= ok(asAbas.every((a) => 'esperando' in a
    && (a.esperando === null || typeof a.esperando === 'boolean')),
    'toda aba diz se está esperando você escolher');
  tudoOk &= ok(!JSON.stringify(asAbas).includes('"pane"'),
    'e o id da pane do tmux continua interno');

  // ── Abrir e fechar abas: SÓ AS RECUSAS, de propósito ────────────────────────
  //
  // Este servidor lê o socket PADRÃO — o da `main` do usuário. Um caminho feliz aqui criaria
  // ou mataria janela NELA. Então traça-se a mesma linha que o gate das teclas já traça:
  // prova-se a RECUSA, que é onde mora o risco.
  //
  // NENHUM `DELETE` roda aqui. Mesmo uma chave "que não existe" faz o servidor entrar no
  // caminho destrutivo até a guarda, e testar a guarda contra a sessão de trabalho de verdade
  // é apostar nela justamente onde ela não pode falhar. O DELETE inteiro — 404, 409 e 500 —
  // é exercitado no `testes/smoke-abas-tmux.js`, que tem socket próprio (casos 9d, 9e, 9f).
  // O que sobra aqui é o POST, e as três asserções param antes de qualquer janela nascer.
  const semProjeto = await pedir('POST', '/api/abas', { projeto: 'projeto-que-nao-existe-jamais' });
  tudoOk &= ok(semProjeto.status === 400,
    `POST /api/abas com projeto fora do whitelist → 400 (${semProjeto.status})`);
  const semCorpo = await pedir('POST', '/api/abas', {});
  tudoOk &= ok(semCorpo.status === 400, `POST /api/abas sem projeto → 400 (${semCorpo.status})`);
  // A #22 virando asserção: o caminho do cliente é IGNORADO, não obedecido. Sem `projeto`
  // válido é 400 — não porque o `cwd` incomoda, mas porque o `projeto` faltou.
  const soCwd = await pedir('POST', '/api/abas', { cwd: '/tmp' });
  tudoOk &= ok(soCwd.status === 400,
    `POST /api/abas com cwd no lugar de projeto → 400 (${soCwd.status})`);

  // A rota morta desde a D17 volta a falar com o navegador — e volta no hábito da casa:
  // caminho de disco não sai daqui. Procurar '/home/' na string deixaria passar um
  // `cwd: '/tmp/x'`, e ainda por cima é a #26 (varrer texto livre em vez do campo).
  const listaProjetos = await pedir('GET', '/api/projetos');
  tudoOk &= ok(listaProjetos.status === 200, `GET /api/projetos responde 200 (${listaProjetos.status})`);
  const osProjetos = listaProjetos.corpo.projetos || [];
  tudoOk &= ok(osProjetos.length > 0, `e traz os projetos de ~/projetos (${osProjetos.length})`);
  tudoOk &= ok(osProjetos.every((p) => Object.keys(p).join() === 'nome'),
    'e cada item tem SÓ `nome` — nenhum caminho de disco vai para o navegador');

  // A tela da pane: a única leitura de TUI do projeto, e só com a aba em `waiting`. Sem o
  // 409 esta rota viraria espelho geral do terminal na web — que é o que a D4 recusou.
  const telaFantasma = await pedir('GET', '/api/abas/aba-999999/tela');
  tudoOk &= ok(telaFantasma.status === 404, `tela de aba inexistente é 404 (${telaFantasma.status})`);
  const paradas = asAbas.filter((a) => a.esperando);
  const andando = asAbas.filter((a) => !a.esperando);
  if (andando.length) {
    const fora = await pedir('GET', `/api/abas/${andando[0].chave}/tela`);
    tudoOk &= ok(fora.status === 409, `fora de "esperando", a tela é recusada com 409 (${fora.status})`);
    tudoOk &= ok(/pergunta aberta/.test(fora.corpo.erro || ''), 'e o motivo diz o porquê');
  } else {
    console.log('  (todas as abas estão esperando escolha: o 409 da tela não foi exercitado)');
  }
  if (paradas.length) {
    const dentro = await pedir('GET', `/api/abas/${paradas[0].chave}/tela`);
    tudoOk &= ok(dentro.status === 200, `com a aba esperando, a tela vem (${dentro.status})`);
    tudoOk &= ok(typeof dentro.corpo.tela === 'string' && dentro.corpo.tela.length <= 8000,
      'e ela respeita o teto de tamanho');
    tudoOk &= ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r]/.test(dentro.corpo.tela || ''),
      'e sai sanitizada, sem ESC nem NUL');
    // Com menu aberto, texto vira TECLA do menu. Recusar não é a trava da D13.
    const noMenu = await pedir('POST', `/api/abas/${paradas[0].chave}/turnos`, { texto: 'oi' });
    tudoOk &= ok(noMenu.status === 409, `envio com pergunta aberta é recusado (${noMenu.status})`);
    tudoOk &= ok(/pergunta aberta/.test(noMenu.corpo.erro || ''), 'e o recado ensina o Esc');
  } else {
    console.log('  (nenhuma aba com pergunta aberta agora: o 200 da tela e o 409 do envio não foram exercitados)');
  }

  // ── Teclas do menu: as duas recusas, e só elas ───────────────────────────────
  // Aqui NÃO se aperta tecla de verdade em aba nenhuma: as abas deste socket são as do
  // usuário, e um `Down` num menu de permissão real move a escolha dele. O gate prova as
  // recusas — que é onde mora o risco — e o caminho feliz é exercitado offline, na parte A.
  const teclaLivre = await pedir('POST', '/api/abas/aba-999999/teclas', { tecla: 'C-c' });
  tudoOk &= ok(teclaLivre.status === 400,
    `tecla fora da lista fechada é recusada com 400 (${teclaLivre.status})`);
  tudoOk &= ok(/não permitida/.test(teclaLivre.corpo.erro || ''), 'e o motivo diz que ela não é permitida');
  const teclaSemTecla = await pedir('POST', '/api/abas/aba-999999/teclas', {});
  tudoOk &= ok(teclaSemTecla.status === 400, `pedido sem tecla nenhuma também é 400 (${teclaSemTecla.status})`);
  const teclaFantasma = await pedir('POST', '/api/abas/aba-999999/teclas', { tecla: 'Down' });
  tudoOk &= ok(teclaFantasma.status === 404,
    `tecla válida em aba inexistente é 404 (${teclaFantasma.status})`);
  if (andando.length) {
    const teclaFora = await pedir('POST', `/api/abas/${andando[0].chave}/teclas`, { tecla: 'Down' });
    tudoOk &= ok(teclaFora.status === 409,
      `tecla com a aba FORA de "esperando" é recusada com 409 (${teclaFora.status})`);
    tudoOk &= ok(/pergunta aberta/.test(teclaFora.corpo.erro || ''), 'e o motivo diz o porquê');
  } else {
    console.log('  (todas as abas estão esperando escolha: o 409 da tecla não foi exercitado)');
  }

  // A consulta que o diagnóstico do push usa. Só sim/não sobre um endpoint que o aparelho
  // já tem — a lista dos outros aparelhos não sai daqui.
  const consultaVazia = await pedir('POST', '/api/push/inscricao/consulta', {});
  tudoOk &= ok(consultaVazia.status === 400, `consulta sem endpoint é 400 (${consultaVazia.status})`);
  const consulta = await pedir('POST', '/api/push/inscricao/consulta',
    { endpoint: 'https://fcm.googleapis.com/aparelho-que-nunca-existiu' });
  tudoOk &= ok(consulta.status === 200 && consulta.corpo.conhecida === false,
    `endpoint desconhecido responde "não conheço" (${consulta.status})`);
  tudoOk &= ok(typeof consulta.corpo.inscritos === 'number' && !JSON.stringify(consulta.corpo).includes('endpoint'),
    'e devolve só a contagem — nunca a lista de endpoints, que é credencial dos aparelhos');

  // Faixa de jobs: o casamento job → aba é calculado no SERVIDOR, porque precisa do cwd
  // de cada aba — que é justamente o que nunca sai daqui.
  // ── O effort GLOBAL, pela rota de verdade (24/08) ──────────────────────────
  //
  // Asserção de fonte não prova que a rota está no ar. Aqui ela é exercitada contra o
  // servidor, que é o único lugar onde "a rota existe" vira verdade.
  const rotaEffort = await pedir('GET', '/api/effort');
  tudoOk &= ok(rotaEffort.status === 200,
    `GET /api/effort responde 200 (${rotaEffort.status})`);
  tudoOk &= ok(Object.hasOwn(rotaEffort.corpo || {}, 'nivel')
    && (typeof rotaEffort.corpo.nivel === 'string' || rotaEffort.corpo.nivel === null),
  `o corpo tem a chave nivel, string ou null — nunca undefined, nunca objeto (${JSON.stringify(rotaEffort.corpo)})`);
  // Prova que a rota está ligada NO MÓDULO, e não numa segunda leitura improvisada.
  // O guarda existe porque é assim que esta asserção nasce vermelha, antes de a função
  // existir: chamar direto derrubaria a parte 2 inteira num TypeError.
  const moduloContexto = require('../lib/contexto');
  const doModulo = typeof moduloContexto.effortConfigurado === 'function'
    ? await moduloContexto.effortConfigurado()
    : undefined;
  tudoOk &= ok(Object.hasOwn(rotaEffort.corpo || {}, 'nivel') && rotaEffort.corpo.nivel === doModulo,
    `e o valor bate com o effortConfigurado do módulo (${JSON.stringify(doModulo)})`);
  // Caminho de config não sai para o navegador.
  tudoOk &= ok(!/\/home\//.test(JSON.stringify(rotaEffort.corpo)),
    'e nenhum caminho de arquivo vai no corpo da resposta');

  const faixaJobs = await pedir('GET', '/api/jobs');
  tudoOk &= ok(faixaJobs.status === 200, `GET /api/jobs responde 200 (${faixaJobs.status})`);
  const osJobs = faixaJobs.corpo.jobs || [];
  tudoOk &= ok(osJobs.every((j) => Array.isArray(j.abas)),
    `todo job da faixa diz com quais abas ele casa (${osJobs.length} rodando)`);
  tudoOk &= ok(osJobs.every((j) => (j.abas || []).every((c) => /^aba-p?\d+$/.test(c))),
    'e só com a CHAVE da aba — nada de worktree, branch ou caminho de disco');
  // `etapa` fica de fora da varredura: ela é a ÚLTIMA AÇÃO do agente, texto livre, e uma
  // ação com caminho dentro ("editando /home/...") deixava o gate vermelho sem nada ter
  // quebrado — inclusive por causa do próprio job que roda o gate. O que precisa ficar
  // longe do navegador é a árvore que o painel guarda (worktree, branch, source_repo), não
  // a frase que o usuário já lê na faixa.
  const cruJobs = JSON.stringify(osJobs.map(({ etapa, ...resto }) => resto));
  tudoOk &= ok(!/worktree|branch|source_repo|\/home\//.test(cruJobs),
    'a faixa continua sem carregar a árvore do disco');
  tudoOk &= ok(osJobs.every((j) => j.etapa === null || typeof j.etapa === 'string'),
    'e a etapa é texto ou nada — nunca um objeto do painel inteiro');
  const casados = osJobs.filter((j) => (j.abas || []).length);
  tudoOk &= ok(casados.every((j) => (j.abas || []).every((c) => asAbas.some((a) => a.chave === c))),
    'toda chave que sai da faixa é de uma aba que existe de verdade na lista');

  if (asAbas.length) {
    const chave = asAbas[0].chave;
    // A trava que importa: o caminho do anexo vem do CLIENTE. Sem ela, um pedido forjado
    // aponta o agente para ~/.secrets/ e pede que ele "leia o anexo".
    const forjado = await pedir('POST', `/api/abas/${chave}/turnos`,
      { texto: 'leia o anexo', anexos: [`${os.homedir()}/.secrets/cockpit.env`] });
    tudoOk &= ok(forjado.status === 409, `anexo fora da pasta de anexos é recusado (${forjado.status})`);
    tudoOk &= ok(/fora da pasta/.test(forjado.corpo.erro || ''), 'e o motivo diz o porquê');

    const inexistente = await pedir('POST', '/api/abas/aba-999999/turnos', { texto: 'oi' });
    tudoOk &= ok(inexistente.status === 409, `aba que não existe é recusada (${inexistente.status})`);
    const vazio = await pedir('POST', `/api/abas/${chave}/turnos`, { texto: '   ' });
    tudoOk &= ok(vazio.status === 409, 'texto vazio não vira send-keys');
  } else {
    console.log('  (sem aba de terminal aberta: as travas de anexo não foram exercitadas)');
  }

  // A lista agora carrega estado. Sem ele, o menu lateral não sabe o que mostrar.
  const comEstado = (await pedir('GET', '/api/sessoes')).corpo.sessoes || [];
  if (comEstado.length) {
    const validos = ['trabalhando', 'respondeu', 'pronta', 'interrompida', 'nova'];
    tudoOk &= ok(comEstado.every((x) => validos.includes(x.estado)),
      `toda conversa tem um estado conhecido (${[...new Set(comEstado.map((x) => x.estado))].join(', ')})`);
    tudoOk &= ok(comEstado.every((x) => x.estado !== 'pronta' || x.terminouEm > 0),
      'conversa pronta traz quando terminou, que é o que decide o não lido');
    tudoOk &= ok(comEstado.every((x) => x.estado !== 'trabalhando' || x.viva),
      'nada aparece "trabalhando" sem sessão tmux de pé — turno morto vira interrompida');
  }

  // Rotas de notificação.
  const chavePush = (await pedir('GET', '/api/push/chave')).corpo;
  tudoOk &= ok(Buffer.from(chavePush.chave || '', 'base64url').length === 65,
    'a chave pública do push é servida no formato que o navegador espera');
  const incompleta = await pedir('POST', '/api/push/inscricao', { endpoint: 'https://x/y' });
  tudoOk &= ok(incompleta.status >= 400, `inscrição sem chaves é recusada (${incompleta.status})`);

  // Medidor de contexto, contra uma conversa que já rodou turno de verdade.
  const todas = (await pedir('GET', '/api/sessoes')).corpo.sessoes || [];
  const comTurno = todas.find((x) => (x.turnos || 0) > 0);
  if (!comTurno) {
    console.log('  ⚠️  nenhuma conversa com turno no disco: pulei as checagens de uso');
  } else {
    const uso = (await pedir('GET', `/api/sessoes/${comTurno.id}/uso`)).corpo;
    tudoOk &= ok(uso.janela > 0, `a janela do modelo veio do CLI (${uso.janela})`);
    tudoOk &= ok(uso.contexto > 0 && uso.contexto <= uso.janela,
      `o contexto usado cabe na janela (${uso.contexto})`);
    tudoOk &= ok(Math.abs(uso.porcentagem - (uso.contexto / uso.janela) * 100) < 0.01,
      `a porcentagem bate com a conta (${uso.porcentagem.toFixed(1)}%)`);
    tudoOk &= ok(typeof uso.modelo === 'string' && uso.modelo.startsWith('claude-'),
      `o modelo é o principal da conversa, não o auxiliar (${uso.modelo})`);
    tudoOk &= ok(uso.custoUSD > 0 && uso.turnos > 0, 'custo e turnos vieram junto');
    tudoOk &= ok(!('comandos' in uso), 'o painel não carrega os 150 nomes do autocomplete à toa');
    if (uso.limite) {
      tudoOk &= ok(typeof uso.limite.status === 'string', `o teto do plano veio junto (${uso.limite.status})`);
      tudoOk &= ok(Number.isFinite(uso.limite.resetaEm) && uso.limite.resetaEm > 0,
        'com a hora em que a janela do plano reseta');
    } else {
      console.log('  ⚠️  esta conversa não tem rate_limit_event gravado: pulei o teto do plano');
    }

    // Consumo do plano vindo da API de verdade. Depois da D-a a rota SEM `forcar` não chama
    // mais o `/usage` (vira o caminho de graça, coberto pelo caso 22 do
    // gate-limite-janelas.js) — por isso a 1ª chamada aqui força a consulta (`?forcar=1`,
    // o MESMO custo de sempre: 1 turno de haiku) para o assert do cache abaixo continuar
    // valendo. A 2ª vem SEM forcar, provando que ela aproveitou o que já foi pago.
    const plano = (await pedir('GET', '/api/limite?forcar=1')).corpo;
    if (plano.itens && plano.itens.length) {
      tudoOk &= ok(plano.itens.every((i) => i.usado >= 0 && i.usado <= 100),
        `o consumo do plano veio da Anthropic (${plano.itens.map((i) => `${i.rotulo} ${i.usado}%`).join(', ')})`);
      tudoOk &= ok(plano.itens.some((i) => i.resetaEm > Date.now()), 'com o reset no futuro');
      const segundo = (await pedir('GET', '/api/limite')).corpo;
      tudoOk &= ok(segundo.consultadoEm === plano.consultadoEm,
        'a segunda consulta vem do cache, sem gastar outro turno');
      // R7: `janelas` (de graça) vai nas DUAS respostas, e sem caminho de disco vazando.
      tudoOk &= ok('janelas' in plano && 'janelas' in segundo,
        'e a chave `janelas` (de graça) vai nas duas respostas');
      tudoOk &= ok(!JSON.stringify(plano.janelas).includes('/home/'),
        'sem caminho de disco vazando em `janelas` (R7)');
    } else {
      console.log(`  ⚠️  /api/limite não trouxe consumo (${plano.erro || 'sem erro'}) — o painel degrada`);
    }

    // ── casos 55 e 56: a rota dos agentes e o whitelist do POST ─────────────
    //
    // Os cinco deltas do campo `Agente` não tinham um único caso automatizado, e só o PNG do
    // diálogo os cobria — e ele não vê a rota nem o 400. Estes dois falam HTTP e por isso
    // moram aqui, não no gate offline.
    const listaAgentes = await pedir('GET', '/api/agentes');
    tudoOk &= ok(listaAgentes.status === 200, `caso 55: GET /api/agentes responde 200 (${listaAgentes.status})`);
    const osAgentes = listaAgentes.corpo.agentes || [];
    tudoOk &= ok(osAgentes.length >= 2 && osAgentes.every((a) => a.id && a.rotulo),
      `caso 55: ela devolve [{id, rotulo}] (${JSON.stringify(osAgentes)})`);
    // O mesmo hábito da /api/projetos, que manda o nome e nunca o `cwd`: o navegador não
    // precisa saber onde o binário mora, e o dia em que precisar é o dia em que alguém pode
    // escolher outro (#22).
    tudoOk &= ok(!JSON.stringify(listaAgentes.corpo).includes('/usr/bin')
      && !JSON.stringify(listaAgentes.corpo).includes('/home/'),
      'caso 55: e NENHUM caminho de binário sai na resposta — o navegador nunca vê o disco');

    // 56 — as DUAS metades da regra. Agente fora da lista é 400; ausente é o padrão.
    const projetoValido = ((await pedir('GET', '/api/projetos')).corpo.projetos || [])[0]?.nome;
    if (!projetoValido) {
      console.log('  ⚠️  não há projeto em ~/projetos — pulei o caso 56 (ele precisa de um POST válido)');
    } else {
      const forjado = await pedir('POST', '/api/abas', { projeto: projetoValido, agente: 'cursor' });
      tudoOk &= ok(forjado.status === 400,
        `caso 56: POST com agente fora do registro é 400 (${forjado.status}) ${JSON.stringify(forjado.corpo)}`);
      tudoOk &= ok(!/cursor/.test(JSON.stringify(forjado.corpo).replace(/agente/g, '')),
        'e a recusa não ecoa o id forjado de volta na tela');
    }

    // ── caso 73: a chave `codex` vai nos DOIS ramos de /api/limite ──────────
    //
    // O consumo da assinatura OpenAI é calculado FORA do cache do `consultar()`, e é
    // justamente quando a Anthropic FALHA (`itens: []`) que ele seria mais útil: ele não
    // custa turno e não depende de rede. Perder o `codex` no ramo de erro é o defeito que
    // este caso existe para pegar, e ele não cabe no gate offline porque fala HTTP.
    tudoOk &= ok('codex' in plano,
      'caso 73: /api/limite SEMPRE traz a chave `codex` — mesmo quando a Anthropic falha');
    if (plano.codex === null) {
      console.log('  ⚠️  não há aba de Codex viva nesta máquina — o consumo do Codex vem null (ausência, não 0%)');
    } else {
      tudoOk &= ok(Array.isArray(plano.codex?.limites) && plano.codex.limites.length > 0,
        `o consumo do Codex vem com pelo menos uma janela (${JSON.stringify(plano.codex?.limites?.map((l) => l.rotulo))})`);
      tudoOk &= ok(plano.codex.limites.every((l) => l.usado >= 0 && l.usado <= 100),
        'e as porcentagens dele cabem em 0..100 — nunca os 2026% do total_token_usage');
      tudoOk &= ok(plano.codex.limites.every((l) => l.resetaEm === null || l.resetaEm > 1e12),
        'e o `resetaEm` é milissegundos, não os segundos crus do rollout (senão a tela diz 1970)');
      tudoOk &= ok(typeof plano.codex.titulo === 'string' && typeof plano.codex.varias === 'boolean',
        'com o título da aba que falou e o aviso de que há mais de uma');
      tudoOk &= ok(!JSON.stringify(plano.codex).includes('/home/'),
        'e NENHUM caminho de disco vai junto — o cliente não precisa saber onde o rollout mora');
    }

    // A razão de existir o cruzamento: /clear e /context não são arquivo em lugar nenhum.
    const daSessao = (await pedir('GET', `/api/catalogo?sessao=${comTurno.id}`)).corpo.itens || [];
    const embutidos = daSessao.filter((i) => i.origem === 'embutido').map((i) => i.nome);
    tudoOk &= ok(embutidos.includes('clear') && embutidos.includes('context'),
      'catálogo da sessão traz /clear e /context, que o disco não tem');
    tudoOk &= ok(daSessao.find((i) => i.nome === 'clear').descricao.length > 10,
      'o embutido vem com descrição, não só o nome');
    tudoOk &= ok(daSessao.some((i) => i.origem === 'global'),
      'as skills de arquivo continuam no catálogo');

    // Mudou em 22/08: sem sessão o catálogo passou a ser o disco MAIS os embutidos. Antes
    // ele era só o disco, e nas ABAS — onde não existe init do CLI — o /clear sumia.
    const soDisco = (await pedir('GET', '/api/catalogo')).corpo.itens || [];
    tudoOk &= ok(soDisco.some((i) => i.nome === 'clear' && i.origem === 'embutido'),
      'sem sessão, o catálogo traz o disco mais os embutidos');
  }

  // Catálogo por ABA: é o que o cliente pede desde que a tela virou a das abas.
  const abaTorta = await pedir('GET', '/api/catalogo?aba=aba-999999');
  tudoOk &= ok(abaTorta.status === 200, `aba desconhecida responde 200, não 500 (${abaTorta.status})`);
  tudoOk &= ok((abaTorta.corpo.itens || []).some((i) => i.nome === 'clear'),
    'e ainda assim traz os embutidos — sem cwd, o autocomplete degrada, não morre');
  if (asAbas.length) {
    const daAba = (await pedir('GET', `/api/catalogo?aba=${asAbas[0].chave}`)).corpo.itens || [];
    tudoOk &= ok(daAba.some((i) => i.nome === 'clear' && i.origem === 'embutido'),
      'o catálogo de uma aba de verdade traz /clear');
    tudoOk &= ok(daAba.some((i) => i.origem === 'global'), 'junto das skills do disco');
  }

  // Exclusão de verdade, num diretório descartável.
  const cwd = path.join(os.tmpdir(), 'cockpit-gate-ui');
  fs.mkdirSync(cwd, { recursive: true });
  const criada = await pedir('POST', '/api/sessoes', { cwd, titulo: 'gate ui' });
  tudoOk &= ok(criada.status === 201, `sessão de teste criada (${criada.status})`);
  const id = criada.corpo.id;
  const dirSessao = path.join(os.homedir(), '.cockpit', 'sessoes', id);
  tudoOk &= ok(fs.existsSync(dirSessao), 'a pasta de estado existe antes de excluir');

  // DELETE sem ?apagar=1 continua sendo só encerrar — é o que o gate da fase 3 usa.
  const encerrada = await pedir('DELETE', `/api/sessoes/${id}`);
  tudoOk &= ok(encerrada.corpo.encerrada === true, 'DELETE sem ?apagar encerra e não apaga');
  tudoOk &= ok(fs.existsSync(dirSessao), 'o histórico sobrevive ao encerrar');

  const excluida = await pedir('DELETE', `/api/sessoes/${id}?apagar=1`);
  tudoOk &= ok(excluida.corpo.excluida === true, 'DELETE com ?apagar=1 exclui');
  tudoOk &= ok(!fs.existsSync(dirSessao), 'a pasta de estado sumiu do disco');

  const lista = await pedir('GET', '/api/sessoes');
  tudoOk &= ok(!(lista.corpo.sessoes || []).some((s) => s.id === id), 'a conversa sumiu da lista');

  // A trava do rm: id que não é UUID nem chega perto do disco.
  const torto = await pedir('DELETE', '/api/sessoes/nao-e-uuid?apagar=1');
  tudoOk &= ok(torto.status === 500 && /formato|desconhecida/.test(torto.corpo.erro || ''),
    'id fora do formato UUID é recusado antes de qualquer remoção');

  const sumido = await pedir('DELETE', `/api/sessoes/${id}?apagar=1`);
  tudoOk &= ok(/desconhecida/.test(sumido.corpo.erro || ''), 'excluir duas vezes não explode, só recusa');

  // Arquivos gerados: a lista é a autorização do download.
  const comArquivo = comEstado.find((x) => x.turnos > 0);
  if (comArquivo) {
    const lista = (await pedir('GET', `/api/sessoes/${comArquivo.id}/arquivos`)).corpo.arquivos || [];
    tudoOk &= ok(lista.every((a) => !('caminho' in a)),
      'a lista não expõe caminho absoluto — o cliente só precisa do relativo');
    tudoOk &= ok(lista.every((a) => !a.relativo.startsWith('..') && !path.isAbsolute(a.relativo)),
      'nada aponta para fora da pasta do projeto');

    if (lista.length) {
      const baixado = await bruto('GET', `/api/sessoes/${comArquivo.id}/arquivos/baixar?caminho=${encodeURIComponent(lista[0].relativo)}`);
      tudoOk &= ok(baixado.status === 200 && baixado.corpo.length === lista[0].bytes,
        `download entrega o arquivo inteiro (${lista[0].relativo}, ${baixado.corpo.length}b)`);
      tudoOk &= ok(/^attachment;/.test(baixado.headers['content-disposition'] || ''),
        'sempre como anexo — arquivo escrito pelo agente nunca renderiza no domínio do cockpit');
    }

    // Os caminhos que um atacante tentaria.
    for (const tentativa of ['../../../../etc/passwd', '/etc/passwd', '../.secrets/cockpit.env']) {
      const negado = await pedir('GET', `/api/sessoes/${comArquivo.id}/arquivos/baixar?caminho=${encodeURIComponent(tentativa)}`);
      tudoOk &= ok(/não está na lista/.test(negado.corpo.erro || ''), `recusa "${tentativa}"`);
    }
  }

  // Anexos: upload cru, tipo controlado e caminho travado.
  const anexavel = await pedir('POST', '/api/sessoes', { cwd, titulo: 'gate ui anexo' });
  const idAnexo = anexavel.corpo.id;
  // PNG 1x1 de verdade, para o content-type não ser mentira.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const subir = (tipo, nome, dados) => new Promise((resolve, reject) => {
    const headers = { 'content-type': tipo };
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const req = http.request({ ...BASE, method: 'POST', headers,
      path: `/api/sessoes/${idAnexo}/anexos?nome=${encodeURIComponent(nome)}` }, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: d ? JSON.parse(d) : {} }));
    });
    req.on('error', reject);
    req.end(dados);
  });

  const recusado = await subir('application/x-msdownload', 'virus.exe', Buffer.from('MZ'));
  tudoOk &= ok(recusado.status === 415, `tipo fora da lista é recusado (${recusado.status})`);

  const enviado = await subir('image/png', '../../../etc/passwd', png);
  tudoOk &= ok(enviado.status === 201, `PNG sobe (${enviado.status})`);
  tudoOk &= ok(!enviado.corpo.nome.includes('/') && enviado.corpo.nome.endsWith('.png'),
    `nome com ../ vira nome inofensivo (${enviado.corpo.nome})`);
  const dentro = path.join(os.homedir(), '.cockpit', 'sessoes', idAnexo, 'anexos');
  tudoOk &= ok(path.dirname(enviado.corpo.arquivo) === dentro,
    'o arquivo fica na pasta da conversa, longe do repo do projeto');
  tudoOk &= ok(fs.readFileSync(enviado.corpo.arquivo).equals(png), 'os bytes chegaram inteiros');

  // A trava que importa: caminho de anexo vem do cliente e não pode apontar para fora.
  const forjado = await pedir('POST', `/api/sessoes/${idAnexo}/turnos`, {
    texto: 'leia o anexo', anexos: [path.join(os.homedir(), '.secrets', 'cockpit.env')],
  });
  tudoOk &= ok(/fora da pasta/.test(forjado.corpo.erro || ''),
    'anexo apontando para fora da conversa é recusado antes de virar prompt');
  tudoOk &= ok((await pedir('GET', `/api/sessoes/${idAnexo}/uso`)).corpo.turnos === 0,
    'e o turno forjado não chegou a rodar');

  await pedir('DELETE', `/api/sessoes/${idAnexo}?apagar=1`);

  // Ressurreição: sessão tmux morta não pode transformar a conversa em tijolo.
  const sessoes = require('../lib/sessoes');
  const revivida = await pedir('POST', '/api/sessoes', { cwd, titulo: 'gate ui revive' });
  const idRevive = revivida.corpo.id;
  const nomeTmux = revivida.corpo.tmux_session;
  const viva = () => {
    try {
      execFileSync('tmux', ['-L', 'cockpit', 'has-session', '-t', nomeTmux], { stdio: 'ignore' });
      return true;
    } catch { return false; }
  };
  tudoOk &= ok(viva(), 'a sessão tmux nasce viva');

  // Só a sessão do teste. `kill-server` derrubaria as conversas do usuário junto.
  execFileSync('tmux', ['-L', 'cockpit', 'kill-session', '-t', nomeTmux], { stdio: 'ignore' });
  tudoOk &= ok(!viva(), 'e morre quando o tmux a derruba');

  const meta = await sessoes.lerMeta(idRevive);
  const ressuscitou = await sessoes.garantirViva(meta);
  tudoOk &= ok(ressuscitou === true, 'garantirViva avisa que precisou recriar');
  tudoOk &= ok(viva(), 'a conversa volta a ter onde rodar, sem perder o histórico');
  tudoOk &= ok(await sessoes.garantirViva(meta) === false, 'com a sessão de pé, não recria à toa');

  await pedir('DELETE', `/api/sessoes/${idRevive}?apagar=1`);

  fs.rmSync(cwd, { recursive: true, force: true });
  return Boolean(tudoOk);
}

(async () => {
  const parte2 = process.argv[2] === 'parte2';
  const passou = parte2 ? await parteB() : await parteA();
  console.log(`\n${passou ? '✅ GATE VERDE' : '❌ GATE VERMELHO'} — ${parte2 ? 'parte 2' : 'parte 1'}\n`);
  process.exit(passou ? 0 : 1);
})().catch((erro) => {
  console.error('\n❌ o gate quebrou:', erro.message, '\n');
  process.exit(1);
});
