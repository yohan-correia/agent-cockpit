'use strict';
// Mapa do grafo EM FOCO (card `grafo-mapa-foco`, D94, sobre o D91) — página própria em `/mapa/<nome>/`.
// Molde IIFE de `public/grafo.js`: só createElement/textContent/setAttribute (#26), nenhum
// innerHTML; SVG por createElementNS. As PURAS ficam em `globalThis.cockpitMapa` (gate
// `testes/gate-grafo-mapa.js`, bloco d), expostas ANTES de qualquer toque em `document`; o resto
// é a tela, atrás de `typeof document !== 'undefined' && document.getElementById('mapa-raiz')`.
(function () {

const idiomaUI = globalThis.cockpitI18n;
const tr = (...args) => idiomaUI.t(...args);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const LIMITE_LISTA = 40;

// ─── puras (gate-grafo-mapa.js, bloco d) ────────────────────────────────────

/** Lê `#camada=<id>&pasta=<p>` / `#arquivo=<c>` / `#foco=<id>` do hash. Chave fora da lista é ignorada (`#c=` é do app). */
function lerHash(hash) {
  if (!hash || hash[0] !== '#') return {};
  let params;
  try { params = new URLSearchParams(hash.slice(1)); } catch { return {}; }
  const resultado = {};
  for (const chave of ['camada', 'pasta', 'arquivo', 'foco']) {
    if (params.has(chave)) resultado[chave] = params.get(chave);
  }
  return resultado;
}

/** Ordem fixa: camada, pasta, arquivo, foco. Estado vazio → `''`. */
function montarHash(estado) {
  const partes = [];
  for (const chave of ['camada', 'pasta', 'arquivo', 'foco']) {
    if (estado[chave] !== undefined && estado[chave] !== null) partes.push(`${chave}=${encodeURIComponent(estado[chave])}`);
  }
  return partes.length ? `#${partes.join('&')}` : '';
}

/** `GET /api/grafos/<nome>/mapa` com a tabela fechada do M6 (sem `token`: isso é do `fetch`). */
function urlDosDados(nome, estado) {
  const partes = [];
  if (estado.camada !== undefined) partes.push(`camada=${encodeURIComponent(estado.camada)}`);
  if (estado.pasta !== undefined) partes.push(`pasta=${encodeURIComponent(estado.pasta)}`);
  if (estado.arquivo !== undefined) partes.push(`arquivo=${encodeURIComponent(estado.arquivo)}`);
  if (estado.completo) partes.push('completo=1');
  const query = partes.length ? `?${partes.join('&')}` : '';
  return `../../api/grafos/${encodeURIComponent(nome)}/mapa${query}`;
}

/** Mesma regra de `urlDoGrafo` (`public/grafo.js:83-86`): token vazio vira `-`. */
function urlDoCompleto(nome, token) {
  const t = token ? encodeURIComponent(token) : '-';
  return `../../grafo/${encodeURIComponent(nome)}/?token=${t}`;
}

/** O nome da camada já vem sem `layer:` do servidor (M2); aqui é só a leitura. */
function rotuloDaCamada(camada) { return camada.nome; }

/** Quantos itens de `lista` ficam visíveis até `n`, e quantos sobram. */
function cortarLista(lista, n) {
  const visiveis = Math.min(lista.length, n);
  return { visiveis, resto: lista.length - visiveis };
}

/**
 * Destino do `‹` na entrada direta (`passo === 0`, M10): arquivo → pasta/camada dele; pasta →
 * pasta-mãe da MESMA camada; raiz da camada (`mae` nulo) → nível 1 (`{}`).
 */
function destinoDoSubir(estado, contexto) {
  if (estado.arquivo !== undefined) {
    // Fundo explícito vence (F10, painel Codex #1): se o estado já diz a camada, é pra lá que se volta,
    // não pra camada/pasta do PRÓPRIO arquivo (que pode ser outra, se a ficha foi aberta por "Quem usa ele").
    if (estado.camada !== undefined) return { camada: estado.camada, pasta: estado.pasta };
    return { camada: contexto.camadaDoArquivo, pasta: contexto.pastaDoArquivo };
  }
  if (estado.camada !== undefined) {
    if (contexto.mae === null || contexto.mae === undefined) return {};
    return { camada: estado.camada, pasta: contexto.mae };
  }
  return {};
}

// ─── puras novas do mapa em foco (card grafo-mapa-foco, D94) ───────────────

/** Paleta cíclica de 15 cores, uma por camada (maquete `2026-10-18-mapa-grafo/index.html:135`). */
const PALETA = ['#e0a43a', '#5b8def', '#3fbf8f', '#e2677e', '#a479e8', '#41b8c9', '#e7834a', '#9bbf3f',
  '#d06fc4', '#7c8aa5', '#c9b458', '#5fa3a0', '#e05a5a', '#8f9bf0', '#b98a5c'];

/** Até 6 vizinhos visíveis por faixa (F5); o print lê esta constante por `window.cockpitMapa`. */
const VIZINHOS_VISIVEIS = 6;

/**
 * Vizinhos dirigidos de `id` sobre `ligacoes` (F5): `usadaPor` = quem aponta PRA `id`; `usa` = pra
 * onde `id` aponta. Nunca `de === para`. Peso desc, empate por id (ordem estável e determinística).
 */
function vizinhosDe(ligacoes, id) {
  const cmp = (a, b) => (b.peso - a.peso) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const usadaPor = [];
  const usa = [];
  for (const l of ligacoes) {
    if (l.de === l.para) continue;
    if (l.para === id) usadaPor.push({ id: l.de, peso: l.peso });
    else if (l.de === id) usa.push({ id: l.para, peso: l.peso });
  }
  usadaPor.sort(cmp);
  usa.sort(cmp);
  return { usadaPor, usa };
}

/** Cor determinística por POSIÇÃO de `id` na lista `camadas` (nível 1, ordenada pelo servidor); cíclica. */
function corDaCamada(id, camadas) {
  const i = camadas.findIndex((c) => c.id === id);
  if (i < 0) return 'var(--texto-2)';
  return PALETA[i % PALETA.length];
}

/** `'a **b** c **d**'` → pedaços alternando negrito; pedaço vazio não entra (nunca HTML, F16). */
function pedacosNegrito(texto) {
  const partes = String(texto).split('**');
  return partes
    .map((t, i) => ({ texto: t, negrito: i % 2 === 1 }))
    .filter((p) => p.texto !== '');
}

/** Atraso em cascata das linhas do nível 2 (F8d): `min(i, 15) × 25 ms` — pasta de 161 arquivos não espera 4 s. */
function atrasoEmCascata(i) { return Math.min(i, 15) * 25; }

/** Último segmento da pasta de um caminho (pra "usado por"/"usa" da ficha); sem pasta → `''`. */
function pastaCurta(caminho) {
  const i = String(caminho).lastIndexOf('/');
  if (i < 0) return '';
  const dir = caminho.slice(0, i);
  const j = dir.lastIndexOf('/');
  return j < 0 ? dir : dir.slice(j + 1);
}

/** Minúsculas, sem acento, sem o prefixo `layer:`. */
function normalizarExplicacao(t) {
  return String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^layer:/, '');
}
/** Quebra em palavras `[a-z0-9]+` (separa por `-`, `_`, espaço, `&`…). */
function palavrasExplicacao(t) { return normalizarExplicacao(t).match(/[a-z0-9]+/g) || []; }

/** F2 da spec — ordem = prioridade; a 1ª regra com alguma palavra presente vence. */
const REGRAS_DE_EXPLICACAO = [
  [['test', 'tests', 'testes', 'spec', 'specs', 'e2e'], 'testes automáticos'],
  [['doc', 'docs', 'documentacao'], 'documentação'],
  [['script', 'scripts'], 'scripts de apoio'],
  [['raiz', 'root'], 'arquivos soltos na raiz do projeto'],
  [['roadmap'], 'quadro do roadmap'],
  [['api'], 'rotas da API (o que o servidor responde)'],
  [['screen', 'screens', 'page', 'pages', 'telas', 'tela', 'routes', 'router'], 'as telas do app'],
  [['ui', 'component', 'components', 'componentes'], 'pedaços de tela (componentes)'],
  [['domain', 'dominio', 'business', 'negocio'], 'regras de negócio'],
  [['shared', 'types', 'tipos', 'util', 'utils', 'utilities', 'comum', 'common'], 'tipos e funções compartilhadas'],
  [['state', 'store', 'estado'], 'estado da tela no navegador'],
  [['platform', 'infra', 'infraestrutura'], 'base técnica (infraestrutura)'],
  [['tooling', 'tools', 'ferramentas', 'config', 'build'], 'ferramentas e configuração'],
  [['backend', 'server', 'servidor'], 'o servidor (backend)'],
  [['frontend', 'web', 'public', 'client'], 'o que roda no navegador'],
  [['services', 'service', 'servicos'], 'serviços do projeto'],
  [['data', 'dados', 'db', 'database', 'banco', 'prisma', 'migrations'], 'dados e banco'],
  [['lib', 'library'], 'biblioteca de código do projeto'],
  [['bin', 'cli'], 'comandos de terminal'],
  [['assets', 'static', 'imagens'], 'arquivos estáticos (imagens, fontes)'],
  [['src'], 'código-fonte principal'],
];

/** Explicação em português de uma camada, por palavra-chave (F2); devolve `{chave, param}` pra `tr(...)`. */
function explicarCamada(nome, id, pasta) {
  if (id === 'layer:(sem camada)') return { chave: 'arquivos fora de qualquer parte', param: undefined };
  if (id === 'layer:(tudo)') return { chave: 'o projeto inteiro (o grafo não separou partes)', param: undefined };

  const palavrasNomeId = new Set([...palavrasExplicacao(nome), ...palavrasExplicacao(id)]);
  for (const [palavras, frase] of REGRAS_DE_EXPLICACAO) {
    if (palavras.some((p) => palavrasNomeId.has(p))) return { chave: frase, param: undefined };
  }

  const segs = String(pasta).split('/').filter(Boolean);
  const ultimoSegmento = segs.length ? segs[segs.length - 1] : '';
  if (ultimoSegmento) {
    const palavrasPasta = new Set(palavrasExplicacao(ultimoSegmento));
    for (const [palavras, frase] of REGRAS_DE_EXPLICACAO) {
      if (palavras.some((p) => palavrasPasta.has(p))) return { chave: frase, param: undefined };
    }
  }

  if (pasta === '') return { chave: 'arquivos soltos na raiz do projeto', param: undefined };
  return { chave: 'arquivos da pasta {0}', param: pasta };
}

/** Catálogo das chaves que `explicarCamada` pode devolver — o `gate-idioma` confere cada uma (F2). */
const CHAVES_DE_EXPLICACAO = [...new Set([
  ...REGRAS_DE_EXPLICACAO.map(([, frase]) => frase),
  'arquivos da pasta {0}', 'arquivos fora de qualquer parte', 'o projeto inteiro (o grafo não separou partes)',
])];

globalThis.cockpitMapa = {
  lerHash, montarHash, urlDosDados, urlDoCompleto, rotuloDaCamada, cortarLista, destinoDoSubir,
  vizinhosDe, corDaCamada, pedacosNegrito, atrasoEmCascata, pastaCurta, explicarCamada,
  PALETA, CHAVES_DE_EXPLICACAO, VIZINHOS_VISIVEIS,
};

// ─── a tela (DOM) ────────────────────────────────────────────────────────────

if (typeof document !== 'undefined' && document.getElementById('mapa-raiz')) {

const $ = (id) => document.getElementById(id);
const raiz = $('mapa-raiz');
const palco = $('mapa-palco');
const avisoEl = $('mapa-aviso');
const topo = $('mapa-topo');
const trilhaEl = $('mapa-trilha');
const dicaEl = $('mapa-dica');
const veuEl = $('mapa-veu');
const folhaEl = $('mapa-folha');

const segs = location.pathname.split('/').filter(Boolean);
const nome = decodeURIComponent(segs[segs.lastIndexOf('mapa') + 1] || '');
document.title = `${tr('Mapa do grafo')} — ${nome}`;

const tokenAgora = () => {
  const daQuery = new URLSearchParams(location.search).get('token');
  if (daQuery && daQuery !== '-') return daQuery;
  try { return localStorage.getItem('cockpit-token') || ''; } catch { return ''; }
};
const cabecalhosToken = () => { const t = tokenAgora(); return t ? { authorization: `Bearer ${t}` } : {}; };

function formatarData(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(idiomaUI.idioma, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch { return ''; }
}
function formatarMB(bytes) {
  return `${(bytes / 1e6).toLocaleString(idiomaUI.idioma, { maximumFractionDigits: 1 })} MB`;
}
function fmt(n) { return n.toLocaleString(idiomaUI.idioma); }

function mostrarAviso(texto) { avisoEl.textContent = texto; avisoEl.hidden = false; }
function esconderAviso() { avisoEl.textContent = ''; avisoEl.hidden = true; }
function mostrarErro(texto) {
  palco.replaceChildren();
  // Fundo apagado = cache do fundo inválido (painel, Codex #5): sem isso, voltar pra pasta depois
  // de um erro achava o "fundo igual" (mesmoFundo) e não redesenhava.
  fundoDados = null;
  fecharFicha();
  mostrarAviso(texto);
}

// ─── ajudantes de desenho ───────────────────────────────────────────────────

function svgEl(tag, attrs) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/** `'a **b** c'` em `pai`, com `<b>` pros pedaços em negrito (usa `pedacosNegrito`; nunca HTML). */
function textoComNegrito(pai, texto) {
  for (const pedaco of pedacosNegrito(texto)) {
    if (pedaco.negrito) {
      const b = document.createElement('b');
      b.textContent = pedaco.texto;
      pai.append(b);
    } else {
      pai.append(document.createTextNode(pedaco.texto));
    }
  }
}

function explicacao(camada) {
  const r = explicarCamada(camada.nome, camada.id, camada.pasta);
  return r.param !== undefined ? tr(r.chave, r.param) : tr(r.chave);
}

function corDe(id) { return cockpitMapa.corDaCamada(id, nivel1 ? nivel1.camadas : []); }

function reduzido() {
  return !!(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function rolarProTopo() {
  raiz.scrollTo({ top: 0, behavior: reduzido() ? 'auto' : 'smooth' });
}

// ─── estado do módulo ───────────────────────────────────────────────────────

let pedidoAtual = 0;
let nivel1 = null; // cache do nível 1 (camadas/ligações/totais), pedido uma vez só (F7)
let fundoDados = null; // o nível 2 desenhado agora; null quando a tela é o nível 1
let fichaDados = null; // o nível 3 (arquivo) desenhado na ficha; null quando a ficha está fechada
let estadoAtual = {};
let abridorDaFicha = null;
// D96 — veio de um toque no Cockpit NESTA aba? Entrada nova (`history.state` nulo): lê-e-apaga a marca de
// passagem que `public/dentro-do-app.js` grava (a MESMA string, DJ7 do gate-ui); o referrer não serve
// (`Referrer-Policy: no-referrer`). Recarga de uma entrada que o próprio mapa gravou: vale o `doCockpit` dela.
const CHAVE_VEIO = 'cockpit-veio-do-app';
const veioDoCockpit = (() => {
  if (history.state) return history.state.doCockpit === true;
  try {
    const v = sessionStorage.getItem(CHAVE_VEIO) === '1';
    sessionStorage.removeItem(CHAVE_VEIO);
    return v;
  } catch { return false; }
})();
/** O estado de uma entrada do mapa: o `passo` (F10) e de onde se veio (D96). */
function marca(passo) { return { passo, doCockpit: veioDoCockpit }; }

// Entrada direta só com `#arquivo=` (sem `camada=`): o boot ainda não sabe o fundo — calculado AQUI,
// antes do `replaceState` do boot (F10/3.7).
let sintetizarNoBoot = !history.state && cockpitMapa.lerHash(location.hash).arquivo !== undefined;

/** `{camada}` e `{camada, pasta: <raiz>}` são o MESMO fundo (painel, Codex #4). */
function mesmoFundo(estado) {
  return fundoDados !== null && fundoDados.camada.id === estado.camada
    && (estado.pasta === undefined ? fundoDados.pasta === fundoDados.camada.pasta : fundoDados.pasta === estado.pasta);
}

function aoClicarVoltar() {
  const passo = (history.state && history.state.passo) || 0;
  if (passo > 0) { history.back(); return; }
  // D96/M6: nível 1, sem ficha e nada do mapa embaixo — se veio do cockpit, a entrada de baixo é a dele. A ficha
  // fica de fora de propósito: véu e Esc chamam esta mesma função e têm de FECHAR a ficha, nunca sair do mapa.
  if (fundoDados === null && fichaDados === null && veioDoCockpit) { history.back(); return; }
  const contexto = fichaDados
    ? { camadaDoArquivo: fichaDados.arquivo.camada.id, pastaDoArquivo: fichaDados.arquivo.pasta }
    : { mae: fundoDados && fundoDados.trilha.length > 1 ? fundoDados.trilha[fundoDados.trilha.length - 2].pasta : null };
  const destino = cockpitMapa.destinoDoSubir(estadoAtual, contexto);
  history.replaceState(marca(0), '', cockpitMapa.montarHash(destino) || (location.pathname + location.search));
  carregar(destino, { direcao: 'saida' });
}

// ─── topo, dica, trilha ─────────────────────────────────────────────────────

function montarTopo() {
  topo.replaceChildren();
  const passo = (history.state && history.state.passo) || 0;

  const btnVoltar = el('button', 'mapa-voltar', '‹');
  btnVoltar.id = 'mapa-voltar';
  btnVoltar.type = 'button';
  btnVoltar.setAttribute('aria-label', tr('Voltar'));
  btnVoltar.hidden = fundoDados === null && passo === 0 && !veioDoCockpit;
  btnVoltar.onclick = aoClicarVoltar;
  topo.append(btnVoltar);

  const titulo = el('div', 'mapa-titulo');
  titulo.append(el('strong', null, nome));
  titulo.append(el('small', null, tr('{0} arquivos divididos em {1} partes', fmt(nivel1.totais.arquivos), nivel1.totais.camadas)));
  titulo.append(el('small', null, tr('grafo da develop de {0}', formatarData(nivel1.cabecalho.geradoEm))));
  topo.append(titulo);

  const linkCompleto = el('a', null, tr('Visão completa ({0})', formatarMB(nivel1.cabecalho.bytes)));
  linkCompleto.id = 'mapa-completo';
  linkCompleto.href = cockpitMapa.urlDoCompleto(nome, tokenAgora());
  topo.append(linkCompleto);
}

function montarDica(nivel) {
  dicaEl.replaceChildren();
  dicaEl.append(el('span', 'mapa-dica-icone', '💡'));
  const texto = el('span');
  textoComNegrito(texto, nivel === 1
    ? tr('A parte do **meio** é a escolhida. Em cima, quem **depende dela**; embaixo, de quem **ela depende**. Toque em outra pra trocar.')
    : tr('Pastas e arquivos desta parte. Toque num arquivo pra ver quem ele usa e quem usa ele.'));
  dicaEl.append(texto);
}

function montarTrilha() {
  trilhaEl.replaceChildren();
  if (fundoDados === null) return;

  const camada = fundoDados.camada;
  const passoTodas = el('button', 'mapa-trilha-passo', tr('Todas as partes'));
  passoTodas.type = 'button';
  passoTodas.onclick = () => navegar({ foco: camada.id }, 'saida');
  trilhaEl.append(passoTodas, el('span', 'mapa-trilha-sep', '›'));

  const passosPasta = fundoDados.trilha.slice(1);
  if (!passosPasta.length) {
    trilhaEl.append(el('span', 'mapa-trilha-atual', cockpitMapa.rotuloDaCamada(camada)));
    return;
  }
  const btnCamada = el('button', 'mapa-trilha-passo', cockpitMapa.rotuloDaCamada(camada));
  btnCamada.type = 'button';
  btnCamada.onclick = () => navegar({ camada: camada.id }, 'saida');
  trilhaEl.append(btnCamada);

  passosPasta.forEach((passo, i) => {
    trilhaEl.append(el('span', 'mapa-trilha-sep', '›'));
    if (i === passosPasta.length - 1) {
      trilhaEl.append(el('span', 'mapa-trilha-atual', passo.rotulo));
      return;
    }
    const btn = el('button', 'mapa-trilha-passo', passo.rotulo);
    btn.type = 'button';
    btn.onclick = () => navegar({ camada: camada.id, pasta: passo.pasta }, 'saida');
    trilhaEl.append(btn);
  });
}

// ─── nível 1 — foco ─────────────────────────────────────────────────────────

function montarNivel1(vista, idFoco) {
  const foco = el('div');
  foco.id = 'mapa-foco';
  vista.append(foco);

  const todas = el('section');
  todas.id = 'mapa-todas';
  todas.append(el('h2', 'mapa-secao-titulo', tr('Todas as partes ({0}) · número = arquivos', nivel1.camadas.length)));
  const pilulas = el('div', 'mapa-pilulas');
  for (const c of nivel1.camadas) {
    const btn = el('button', 'mapa-pilula');
    btn.type = 'button';
    btn.dataset.id = c.id;
    btn.style.setProperty('--cor', corDe(c.id));
    btn.append(el('span', 'mapa-bolinha'));
    btn.append(document.createTextNode(cockpitMapa.rotuloDaCamada(c)));
    btn.append(el('em', null, fmt(c.arquivos)));
    btn.onclick = () => focar(c.id);
    pilulas.append(btn);
  }
  todas.append(pilulas);
  vista.append(todas);

  // `foco` ainda não está no DOM vivo aqui (a `vista` só é anexada ao `#mapa-palco` depois que esta
  // função volta) — por isso `pintarFoco` recebe o ELEMENTO, nunca faz `$('mapa-foco')` pra montar.
  pintarFoco(foco, idFoco);
}

function pintarFoco(foco, id) {
  let c = nivel1.camadas.find((x) => x.id === id);
  if (!c) c = nivel1.camadas[0];
  const { usa, usadaPor } = cockpitMapa.vizinhosDe(nivel1.ligacoes, c.id);

  foco.replaceChildren();
  foco.classList.remove('mapa-trocando');
  void foco.offsetWidth; // força o reflow: a próxima classe reinicia a animação do "pulo"
  foco.classList.add('mapa-trocando');

  const criarVizinho = (v, i) => {
    const camadaV = nivel1.camadas.find((x) => x.id === v.id);
    const btn = el('button', 'mapa-vizinho mapa-entra');
    btn.type = 'button';
    btn.dataset.id = v.id;
    btn.style.setProperty('--cor', corDe(v.id));
    btn.style.animationDelay = `${Math.min(i, 6) * 40}ms`;
    btn.append(el('span', 'mapa-bolinha'));
    btn.append(el('b', null, camadaV ? cockpitMapa.rotuloDaCamada(camadaV) : v.id));
    btn.append(el('em', null, fmt(v.peso)));
    btn.onclick = () => focar(v.id);
    return btn;
  };

  const montarFaixa = (classe, rotuloTexto, lista, rotuloDepois) => {
    const faixa = el('div', `mapa-faixa ${classe}`);
    const rotuloEl = el('div', 'mapa-faixa-rotulo', rotuloTexto);
    if (!rotuloDepois) faixa.append(rotuloEl);
    lista.slice(0, VIZINHOS_VISIVEIS).forEach((v, i) => faixa.append(criarVizinho(v, i)));
    if (lista.length > VIZINHOS_VISIVEIS) {
      const mais = el('button', 'mapa-mais', tr('+{0} mais', lista.length - VIZINHOS_VISIVEIS));
      mais.type = 'button';
      mais.onclick = () => {
        mais.remove();
        lista.slice(VIZINHOS_VISIVEIS).forEach((v, i) => faixa.insertBefore(criarVizinho(v, i), rotuloDepois ? rotuloEl : null));
      };
      faixa.append(mais);
    }
    if (!lista.length) faixa.append(el('em', 'mapa-ninguem', tr('ninguém')));
    if (rotuloDepois) faixa.append(rotuloEl);
    return faixa;
  };

  foco.append(montarFaixa('mapa-faixa-cima', tr('↓ dependem dela ({0})', usadaPor.length), usadaPor, false));

  if (usadaPor.length) {
    const svgCima = svgEl('svg', { class: 'mapa-fio mapa-fio-cima', viewBox: '0 0 300 46', preserveAspectRatio: 'none' });
    svgCima.append(svgEl('path', { d: 'M150,0 L150,46' }));
    foco.append(svgCima);
  }

  const centro = el('div', 'mapa-centro');
  centro.style.setProperty('--cor', corDe(c.id));
  centro.append(el('div', 'mapa-centro-nome', cockpitMapa.rotuloDaCamada(c)));
  centro.append(el('div', 'mapa-centro-explica', explicacao(c)));
  centro.append(el('div', 'mapa-centro-qtd', tr('{0} arquivos · {1} funções', fmt(c.arquivos), fmt(c.simbolos))));
  const btnEntrar = el('button', 'mapa-entrar', tr('Ver o que tem dentro →'));
  btnEntrar.type = 'button';
  btnEntrar.onclick = () => navegar({ camada: c.id }, 'entrada');
  centro.append(btnEntrar);
  foco.append(centro);

  if (usa.length) {
    const svgBaixo = svgEl('svg', { class: 'mapa-fio mapa-fio-baixo', viewBox: '0 0 300 46', preserveAspectRatio: 'none' });
    svgBaixo.style.setProperty('--cor', corDe(c.id));
    svgBaixo.append(svgEl('path', { d: 'M150,0 L150,46' }));
    foco.append(svgBaixo);
  }

  foco.append(montarFaixa('mapa-faixa-baixo', tr('↑ ela depende destas ({0})', usa.length), usa, true));
  foco.append(el('p', 'mapa-legenda-numero', tr('o número ao lado de cada nome = quantas ligações de código')));

  // `foco.parentElement` é sempre a `vista` (mesmo ANTES dela entrar no DOM vivo, na 1ª pintura
  // dentro de `montarNivel1` — `document.querySelectorAll` não acharia nada nesse momento).
  for (const p of foco.parentElement.querySelectorAll('.mapa-pilula')) {
    if (p.dataset.id === c.id) p.setAttribute('aria-current', 'true');
    else p.removeAttribute('aria-current');
  }
}

/** Troca de foco NUNCA empilha histórico (F3): `replaceState` + repintura local, sem pedido ao servidor (F5). */
function focar(id) {
  pedidoAtual += 1; // invalida qualquer entrada pendente (painel, Codex): a resposta atrasada de
  // "Ver o que tem dentro" não pode desenhar o nível 2 por cima do foco novo.
  esconderAviso();
  estadoAtual = { foco: id };
  history.replaceState({ ...(history.state || {}), passo: (history.state && history.state.passo) || 0 }, '', cockpitMapa.montarHash({ foco: id }));
  pintarFoco($('mapa-foco'), id);
  rolarProTopo();
}

// ─── desenhar / navegar ─────────────────────────────────────────────────────

function desenhar(nivel, dados, idFoco, direcao) {
  esconderAviso();
  montarTopo();
  montarTrilha();
  montarDica(nivel === 1 ? 1 : 2);

  const vistaVelha = palco.querySelector('.mapa-vista');
  if (vistaVelha) vistaVelha.remove();
  const vistaNova = el('div', 'mapa-vista');
  if (direcao && !reduzido()) vistaNova.classList.add(`mapa-${direcao}`);

  if (nivel === 1) montarNivel1(vistaNova, idFoco);
  else montarNivel2(vistaNova, dados);

  palco.appendChild(vistaNova);
  raiz.scrollTop = 0;
}

function navegar(estado, direcao) {
  const passoAtual = (history.state && history.state.passo) || 0;
  history.pushState(marca(passoAtual + 1), '', cockpitMapa.montarHash(estado));
  carregar(estado, { direcao });
}

async function carregar(estado, { direcao } = {}) {
  const n = ++pedidoAtual;
  const timerCarregando = setTimeout(() => { if (n === pedidoAtual) mostrarAviso(tr('Carregando…')); }, 150);

  const buscar = async (p) => {
    const r = await fetch(cockpitMapa.urlDosDados(nome, p.estado), { headers: cabecalhosToken() });
    return { tipo: p.tipo, status: r.status, ok: r.ok, corpo: await r.json().catch(() => null) };
  };

  const pedidos = [];
  if (!nivel1) pedidos.push({ tipo: 'nivel1', estado: {} });
  if (estado.camada !== undefined && !mesmoFundo(estado)) pedidos.push({ tipo: 'fundo', estado: { camada: estado.camada, pasta: estado.pasta } });
  if (estado.arquivo !== undefined) pedidos.push({ tipo: 'arquivo', estado: { arquivo: estado.arquivo } });

  let respostas;
  try {
    respostas = await Promise.all(pedidos.map(buscar));
  } catch {
    clearTimeout(timerCarregando);
    if (n === pedidoAtual) mostrarErro(tr('não consegui falar com o servidor'));
    return;
  }
  clearTimeout(timerCarregando);
  if (n !== pedidoAtual) return; // resposta fora de ordem (M10): descartada

  const por = (tipo) => respostas.find((r) => r.tipo === tipo);
  const rNivel1 = por('nivel1');
  const rFundo = por('fundo');
  const rArquivo = por('arquivo');

  /** Um dono só do erro (painel, Claude #7): devolve `true` se tratou (quem chamou deve sair). */
  async function tratarStatus(r) {
    if (r.status === 401) { mostrarErro(tr('sem token')); return true; }
    if (r.status === 404) {
      if (r.corpo && r.corpo.erro === 'sem grafo') { mostrarErro(tr('Este projeto ainda não tem grafo.')); return true; }
      if (r.corpo && r.corpo.erro === 'fora do grafo') {
        // D96 (painel Codex #2): preserva o `passo` — zerar sem tirar as entradas de baixo faria o "‹" achar que embaixo é o cockpit.
        history.replaceState(marca((history.state && history.state.passo) || 0), '', location.pathname + location.search);
        sintetizarNoBoot = false;
        await carregar({}, { direcao: 'saida' });
        mostrarAviso(tr('O grafo mudou desde o link — voltei pro começo.'));
        return true;
      }
      mostrarErro(tr('não consegui falar com o servidor'));
      return true;
    }
    if (!r.ok || !r.corpo) { mostrarErro(tr('não consegui falar com o servidor')); return true; }
    return false;
  }

  // Status na ordem nível1 → fundo → arquivo, um dono.
  for (const r of [rNivel1, rFundo, rArquivo]) {
    if (!r) continue;
    if (await tratarStatus(r)) return;
  }

  if (rNivel1) nivel1 = rNivel1.corpo;

  if (estado.camada === undefined && estado.arquivo === undefined) {
    if (nivel1.camadas.length === 0) { mostrarErro(tr('Este projeto ainda não tem grafo.')); return; }
    fecharFicha();
    fundoDados = null;
    estadoAtual = estado;
    const idFoco = estado.foco && nivel1.camadas.some((c) => c.id === estado.foco) ? estado.foco : nivel1.camadas[0].id;
    desenhar(1, null, idFoco, direcao);
    return;
  }

  // ── com camada ou arquivo (F9/F10) ──────────────────────────────────────
  const n3 = rArquivo ? rArquivo.corpo : null;
  let estadoFinal = estado;
  let fundoNovo = rFundo ? rFundo.corpo : null;

  if (estado.arquivo !== undefined && estado.camada === undefined) {
    // Link só com `#arquivo=`: o fundo vem da camada/pasta do PRÓPRIO arquivo (F9).
    const derivado = { camada: n3.arquivo.camada.id, pasta: n3.arquivo.pasta };
    estadoFinal = { ...estado, camada: derivado.camada, pasta: derivado.pasta };
    if (!mesmoFundo(derivado)) {
      let rSegundo;
      try { rSegundo = await buscar({ tipo: 'fundo', estado: derivado }); } catch { rSegundo = null; }
      if (n !== pedidoAtual) return;
      if (!rSegundo) { mostrarErro(tr('não consegui falar com o servidor')); return; }
      if (await tratarStatus(rSegundo)) return;
      fundoNovo = rSegundo.corpo;
    }
  }

  // Quem chama `desenhar` atualiza `estadoAtual` e `fundoDados` ANTES (a trilha e o topo leem deles).
  estadoAtual = estadoFinal;

  if (fundoNovo) {
    fundoDados = fundoNovo;
    desenhar(2, fundoNovo, null, estadoFinal.arquivo ? null : direcao); // abrir ficha não desliza o fundo
  } else if (fichaDados && estadoFinal.arquivo === undefined) {
    // Fundo já desenhado com a mesma camada|pasta: fechar a ficha só fecha a ficha (F9) — sem
    // `desenhar`, pra não tirar o "Carregando…" de um pedido ainda em voo e sem reconstruir a lista à toa.
    fecharFicha();
    montarTopo();
    esconderAviso();
  }

  if (estadoFinal.arquivo !== undefined) {
    abrirFicha(n3);
    esconderAviso();
  } else {
    fecharFicha();
  }

  // Degrau sintético (F10): entrada direta com `arquivo` no hash ganha um `passo` pra que o voltar
  // NATIVO feche a ficha em vez de sair do mapa.
  if (sintetizarNoBoot) {
    sintetizarNoBoot = false;
    const fundo = { camada: estadoAtual.camada, pasta: estadoAtual.pasta };
    history.replaceState(marca(0), '', cockpitMapa.montarHash(fundo));
    history.pushState(marca(1), '', cockpitMapa.montarHash({ ...fundo, arquivo: estado.arquivo }));
    montarTopo();
  }
}

// ─── nível 2 — pastas e arquivos em lista ───────────────────────────────────

function montarNivel2(vista, dados) {
  vista.style.setProperty('--cor', corDe(dados.camada.id));

  if (dados.subpastas.length) {
    const secaoPastas = el('section');
    secaoPastas.id = 'mapa-pastas';
    secaoPastas.append(el('h2', 'mapa-secao-titulo', tr('Pastas ({0})', dados.subpastas.length)));
    const maxSub = Math.max(1, ...dados.subpastas.map((sp) => sp.arquivos));
    dados.subpastas.forEach((sp, i) => {
      const linha = el('button', 'mapa-linha mapa-linha-pasta');
      linha.type = 'button';
      linha.dataset.pasta = sp.pasta;
      linha.style.animationDelay = `${atrasoEmCascata(i)}ms`;
      linha.append(el('span', 'mapa-linha-icone', '📁'));
      const meio = el('span', 'mapa-linha-meio');
      meio.append(el('div', 'mapa-linha-nome', sp.rotulo));
      const mini = el('div', 'mapa-mini');
      const barra = el('i');
      barra.style.width = `${(sp.arquivos / maxSub) * 100}%`;
      mini.append(barra);
      meio.append(mini);
      linha.append(meio);
      linha.append(el('span', 'mapa-linha-qtd', tr('{0} arq.', fmt(sp.arquivos))));
      linha.onclick = () => navegar({ camada: dados.camada.id, pasta: sp.pasta }, 'entrada');
      secaoPastas.append(linha);
    });
    vista.append(secaoPastas);
  }

  if (dados.arquivos.length) {
    const secaoArquivos = el('section');
    secaoArquivos.id = 'mapa-arquivos-secao';
    secaoArquivos.append(el('h2', 'mapa-secao-titulo', tr('Arquivos aqui ({0})', dados.arquivos.length)));
    const listaEl = el('div');
    listaEl.id = 'mapa-arquivos';
    const { visiveis, resto } = cockpitMapa.cortarLista(dados.arquivos, LIMITE_LISTA);
    let mostrandoTudo = false;
    const btnTodos = el('button', 'mapa-mostrar-todos', tr('mostrar todos ({0})', dados.arquivos.length));
    btnTodos.type = 'button';
    const desenharItens = () => {
      listaEl.replaceChildren();
      const quantos = mostrandoTudo ? dados.arquivos.length : visiveis;
      dados.arquivos.slice(0, quantos).forEach((a, i) => {
        const linha = el('button', 'mapa-linha mapa-linha-arquivo');
        linha.type = 'button';
        linha.dataset.caminho = a.caminho;
        linha.style.animationDelay = `${atrasoEmCascata(i)}ms`;
        linha.append(el('span', 'mapa-linha-icone', '📄'));
        const meio = el('span', 'mapa-linha-meio');
        meio.append(el('div', 'mapa-linha-nome', a.nome));
        meio.append(el('div', 'mapa-linha-desc', a.simbolos === 1 ? tr('{0} função', a.simbolos) : tr('{0} funções', a.simbolos)));
        linha.append(meio);
        const qtd = el('span', 'mapa-linha-qtd');
        qtd.append(el('span', null, tr('usa {0}', fmt(a.usa))));
        qtd.append(el('span', null, tr('usado por {0}', fmt(a.usadoPor))));
        linha.append(qtd);
        // O estado leva `pasta: dados.pasta` (a pasta mostrada; na raiz da camada é a raiz dela).
        linha.onclick = (ev) => {
          abridorDaFicha = ev.currentTarget;
          navegar({ camada: dados.camada.id, pasta: dados.pasta, arquivo: a.caminho }, null);
        };
        listaEl.append(linha);
      });
    };
    desenharItens();
    secaoArquivos.append(listaEl);
    if (resto > 0) {
      btnTodos.onclick = () => { mostrandoTudo = true; desenharItens(); btnTodos.remove(); };
      secaoArquivos.append(btnTodos);
    }
    vista.append(secaoArquivos);
  }

  if (!dados.subpastas.length && !dados.arquivos.length) vista.append(el('p', 'mapa-ninguem', tr('ninguém')));
}

// ─── ficha (nível 3) ─────────────────────────────────────────────────────────

function abrirFicha(dadosN3, opcoes) {
  const manter = !!(opcoes && opcoes.manter);
  fichaDados = dadosN3;
  folhaEl.replaceChildren();

  folhaEl.append(el('div', 'mapa-folha-pega'));

  const cab = el('div', 'mapa-folha-cab');
  const titulo = el('h2', null, `📄 ${dadosN3.arquivo.nome}`);
  titulo.id = 'mapa-folha-titulo';
  titulo.tabIndex = -1;
  cab.append(titulo);
  const fechar = el('button', 'mapa-folha-fechar', '×');
  fechar.type = 'button';
  fechar.setAttribute('aria-label', tr('Fechar'));
  fechar.onclick = aoClicarVoltar;
  cab.append(fechar);
  folhaEl.append(cab);

  folhaEl.append(el('p', 'mapa-folha-caminho', dadosN3.arquivo.caminho));

  const caixas = el('div', 'mapa-folha-caixas');
  const caixaUsa = el('div', 'mapa-caixa');
  caixaUsa.append(el('div', 'mapa-caixa-num', fmt(dadosN3.usa.total)));
  caixaUsa.append(el('div', 'mapa-caixa-rotulo', tr('arquivos que ele usa')));
  const caixaUsadoPor = el('div', 'mapa-caixa');
  caixaUsadoPor.append(el('div', 'mapa-caixa-num', fmt(dadosN3.usadoPor.total)));
  caixaUsadoPor.append(el('div', 'mapa-caixa-rotulo', tr('arquivos que usam ele')));
  caixas.append(caixaUsa, caixaUsadoPor);
  folhaEl.append(caixas);

  const montarSecaoLista = (chaveSecao, tituloTexto, dadosLista) => {
    if (!dadosLista.itens.length) return;
    const secao = el('section', 'mapa-folha-secao');
    secao.dataset.secao = chaveSecao;
    secao.append(el('h3', null, tituloTexto));
    for (const item of dadosLista.itens) {
      const btn = el('button', 'mapa-folha-item');
      btn.type = 'button';
      btn.dataset.caminho = item.caminho;
      btn.append(el('span', null, item.nome));
      btn.append(el('span', null, pastaCurta(item.caminho)));
      btn.onclick = () => navegar({ camada: estadoAtual.camada, pasta: estadoAtual.pasta, arquivo: item.caminho }, null);
      secao.append(btn);
    }
    if (dadosLista.total > dadosLista.itens.length) {
      secao.append(el('p', 'mapa-mostrando', tr('mostrando {0} de {1}', dadosLista.itens.length, dadosLista.total)));
      const btnTodos = el('button', 'mapa-mostrar-todos', tr('mostrar todos ({0})', dadosLista.total));
      btnTodos.type = 'button';
      // O foco vai pro 1º item NOVO da mesma seção: a ficha é remontada e o botão some (Codex #2).
      btnTodos.onclick = () => carregarFichaCompleta(dadosN3.arquivo.caminho, { secao: chaveSecao, indice: dadosLista.itens.length });
      secao.append(btnTodos);
    }
    folhaEl.append(secao);
  };
  montarSecaoLista('usadoPor', tr('Quem usa ele'), dadosN3.usadoPor);
  montarSecaoLista('usa', tr('O que ele usa'), dadosN3.usa);

  if (dadosN3.simbolos.length) {
    const secaoFuncoes = el('section', 'mapa-folha-secao');
    secaoFuncoes.dataset.secao = 'funcoes';
    secaoFuncoes.append(el('h3', null, tr('Funções ({0})', dadosN3.simbolos.length)));
    for (const s of dadosN3.simbolos) {
      const item = el('div', 'mapa-folha-item');
      item.append(el('span', null, s.tipo === 'function' ? `${s.nome}()` : s.nome));
      item.append(el('span', null, s.linhas ? tr('linha {0}', s.linhas[0]) : ''));
      secaoFuncoes.append(item);
    }
    folhaEl.append(secaoFuncoes);
  }

  if (!manter) folhaEl.scrollTop = 0;
  folhaEl.classList.add('aberta');
  folhaEl.setAttribute('aria-hidden', 'false');
  veuEl.classList.add('aberto');
  for (const idTravado of ['mapa-topo', 'mapa-trilha', 'mapa-dica', 'mapa-raiz']) $(idTravado).inert = true;
  if (!manter) titulo.focus({ preventScroll: true });
  else if (opcoes.focarEm) {
    const itens = folhaEl.querySelectorAll(`[data-secao="${opcoes.focarEm.secao}"] .mapa-folha-item`);
    const alvo = itens[opcoes.focarEm.indice] || itens[itens.length - 1];
    if (alvo) alvo.focus({ preventScroll: true });
  }
}

function fecharFicha() {
  fichaDados = null;
  if (!folhaEl.classList.contains('aberta')) return;
  folhaEl.classList.remove('aberta');
  folhaEl.setAttribute('aria-hidden', 'true');
  veuEl.classList.remove('aberto');
  for (const idTravado of ['mapa-topo', 'mapa-trilha', 'mapa-dica', 'mapa-raiz']) $(idTravado).inert = false;
  if (abridorDaFicha && document.contains(abridorDaFicha)) abridorDaFicha.focus();
  abridorDaFicha = null;
}

/**
 * "mostrar todos" de uma lista da ficha (F11): sem histórico; `manter` preserva rolagem e foco.
 * Contador PRÓPRIO (`pedidoCompleto`), nunca o `pedidoAtual` da navegação: com o mesmo contador, tocar
 * "mostrar todos" com a abertura de outro arquivo em voo descartava a navegação e a tela ficava no
 * arquivo velho com o hash do novo (painel de execução, Codex #1). A resposta só vale se nenhuma
 * navegação aconteceu desde o toque e se a ficha e o hash ainda são do mesmo arquivo.
 */
let pedidoCompleto = 0;
async function carregarFichaCompleta(caminho, focarEm) {
  const n = ++pedidoCompleto;
  const navegacaoNoToque = pedidoAtual;
  const aindaVale = () => n === pedidoCompleto && pedidoAtual === navegacaoNoToque
    && fichaDados !== null && fichaDados.arquivo.caminho === caminho
    && cockpitMapa.lerHash(location.hash).arquivo === caminho;
  let r;
  try {
    r = await fetch(cockpitMapa.urlDosDados(nome, { arquivo: caminho, completo: true }), { headers: cabecalhosToken() });
  } catch { if (aindaVale()) mostrarAviso(tr('não consegui falar com o servidor')); return; }
  if (!aindaVale()) return;
  if (!r.ok) { mostrarAviso(tr('não consegui falar com o servidor')); return; }
  const corpo = await r.json().catch(() => null);
  if (!aindaVale()) return;
  if (!corpo) { mostrarAviso(tr('não consegui falar com o servidor')); return; }
  abrirFicha(corpo, { manter: true, focarEm });
}

// Registrados UMA vez (nunca dentro de `abrirFicha`): véu e Esc fecham pelo MESMO caminho do `‹`.
veuEl.onclick = aoClicarVoltar;
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && folhaEl.classList.contains('aberta')) {
    ev.preventDefault();
    aoClicarVoltar();
  }
});

// ─── boot ────────────────────────────────────────────────────────────────────

window.addEventListener('popstate', () => carregar(cockpitMapa.lerHash(location.hash), { direcao: 'saida' }));

// Recarregar uma entrada que o próprio mapa empilhou mantém o `passo` (F10) — sintetizar aqui criaria
// um degrau repetido (#36). `sintetizarNoBoot` já leu `history.state` ANTES desta linha.
const vemDeLink = !history.state;
if (vemDeLink) history.replaceState(marca(0), '', location.href);
carregar(cockpitMapa.lerHash(location.hash));

} // fim do guard `typeof document !== 'undefined'`

})();
