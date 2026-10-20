'use strict';
// Ver a diff do código (card `ver-a-diff-do-codigo`, D95) — página própria em `/diff/`. Molde
// IIFE de `public/grafo-mapa.js`: só createElement/textContent/setAttribute, nenhum innerHTML.
// As PURAS ficam em `globalThis.cockpitDiff` (gate `testes/gate-diff.js`, bloco c), expostas
// ANTES de qualquer toque em `document`; o resto é a tela, atrás de
// `typeof document !== 'undefined' && document.getElementById('diff-raiz')`.
(function () {

const idiomaUI = globalThis.cockpitI18n;
const tr = (...args) => idiomaUI.t(...args);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const TETO_TRECHO = 30;
const TETO_ARQUIVO = 400;
const LARGURA_LADO_A_LADO = 900;

// ─── puras (gate-diff.js, bloco c) ──────────────────────────────────────────

/** Lê `#projeto=&commit=&job=&repo=&pr=` do hash. Chave fora da lista é ignorada. */
function lerHash(hash) {
  if (!hash || hash[0] !== '#') return {};
  let params;
  try { params = new URLSearchParams(hash.slice(1)); } catch { return {}; }
  const resultado = {};
  for (const chave of ['projeto', 'commit', 'job', 'repo', 'pr']) {
    if (params.has(chave)) resultado[chave] = params.get(chave);
  }
  return resultado;
}

/** Ordem fixa: projeto, commit, job, repo, pr. Estado vazio → `''`. */
function montarHash(estado) {
  const partes = [];
  for (const chave of ['projeto', 'commit', 'job', 'repo', 'pr']) {
    if (estado[chave] !== undefined && estado[chave] !== null) partes.push(`${chave}=${encodeURIComponent(estado[chave])}`);
  }
  return partes.length ? `#${partes.join('&')}` : '';
}

/** `'a/b/c.js'` → `{nome:'c.js', pasta:'a/b/'}`; sem pasta → `{nome: c, pasta: ''}`. */
function separarCaminho(caminho) {
  const i = caminho.lastIndexOf('/');
  if (i < 0) return { nome: caminho, pasta: '' };
  return { nome: caminho.slice(i + 1), pasta: caminho.slice(0, i + 1) };
}

/** Numera as linhas de um trecho a partir de `trecho.antes`/`trecho.depois`. */
function linhasUnificadas(trecho) {
  const longasPorIndice = new Map((trecho.longas || []).map((l) => [l.i, l.n]));
  let antesN = trecho.antes;
  let depoisN = trecho.depois;
  return trecho.linhas.map((linha, idx) => {
    const tipo = linha[0];
    const texto = linha.slice(1);
    const longa = longasPorIndice.has(idx) ? longasPorIndice.get(idx) : null;
    if (tipo === '-') { const r = { tipo, texto, antes: antesN, depois: null, longa }; antesN += 1; return r; }
    if (tipo === '+') { const r = { tipo, texto, antes: null, depois: depoisN, longa }; depoisN += 1; return r; }
    const r = { tipo, texto, antes: antesN, depois: depoisN, longa };
    antesN += 1; depoisN += 1;
    return r;
  });
}

/**
 * Lado a lado (V12): contexto nos dois lados; bloco de `-` seguido de bloco de `+` pareia linha a
 * linha; sobra de um lado → o outro `null` (hachurado na tela).
 */
function parearLados(trecho) {
  const unificadas = linhasUnificadas(trecho);
  const pares = [];
  let i = 0;
  while (i < unificadas.length) {
    const linha = unificadas[i];
    if (linha.tipo !== '-' && linha.tipo !== '+') {
      pares.push({
        esq: { n: linha.antes, texto: linha.texto, tipo: linha.tipo, longa: linha.longa },
        dir: { n: linha.depois, texto: linha.texto, tipo: linha.tipo, longa: linha.longa },
      });
      i += 1;
      continue;
    }
    let j = i;
    while (j < unificadas.length && unificadas[j].tipo === '-') j += 1;
    const removidas = unificadas.slice(i, j);
    let k = j;
    while (k < unificadas.length && unificadas[k].tipo === '+') k += 1;
    const adicionadas = unificadas.slice(j, k);
    const n = Math.max(removidas.length, adicionadas.length);
    for (let x = 0; x < n; x += 1) {
      const r = removidas[x];
      const a = adicionadas[x];
      pares.push({
        esq: r ? { n: r.antes, texto: r.texto, tipo: '-', longa: r.longa } : null,
        dir: a ? { n: a.depois, texto: a.texto, tipo: '+', longa: a.longa } : null,
      });
    }
    i = k;
  }
  return pares;
}

/** Linhas iguais entre o fim de `anterior` (lado depois) e o início de `atual`; `0` = sem dobra. */
function dobraEntre(anterior, atual) {
  if (!anterior) return Math.max(0, atual.depois - 1);
  const proximoDepois = anterior.depois + anterior.linhas.filter((l) => l[0] !== '-').length;
  return Math.max(0, atual.depois - proximoDepois);
}

/** `'binario'` | `'cortado'` (sem corpo) | `'trechos'` (> 400 linhas somando os trechos) | `'cheio'`. */
function modoDoArquivo(arq) {
  if (arq.binario) return 'binario';
  if (arq.semCorpo) return 'cortado';
  const totalLinhas = (arq.trechos || []).reduce((soma, t) => soma + t.linhas.length, 0);
  if (totalLinhas > TETO_ARQUIVO) return 'trechos';
  return 'cheio';
}

/** 1ª letra maiúscula do autor, ou `?`. */
function inicialDoAutor(nome) {
  const c = String(nome || '').trim()[0];
  return c ? c.toUpperCase() : '?';
}

/** `../api/diff/<rota>?…` — relativo (#16). */
function urlDaApi(rota, params) {
  const partes = [];
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) partes.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  const query = partes.length ? `?${partes.join('&')}` : '';
  return `../api/diff/${rota}${query}`;
}

const dataValida = (s) => (typeof s === 'string' && !Number.isNaN(new Date(s).getTime()) ? s : null);
/** "Em aberto" (D97, E2/E14): jobs esperando merge + PRs do GitHub numa lista só, mais recente primeiro. */
function misturarEmAberto(jobs, prs) {
  const itens = [];
  for (const j of Array.isArray(jobs) ? jobs : []) itens.push({ tipo: 'job', id: j.id, titulo: j.titulo || j.id, projeto: j.projeto || '', quando: dataValida(j.fim) });
  for (const p of Array.isArray(prs) ? prs : []) itens.push({ tipo: 'pr', repo: p.repo, numero: p.numero, titulo: p.titulo, autor: p.autor || '', rascunho: Boolean(p.rascunho), quando: dataValida(p.atualizado) });
  const t = (i) => (i.quando ? new Date(i.quando).getTime() : null);
  return itens.sort((a, b) => {
    const ta = t(a); const tb = t(b);
    if (ta !== tb) { if (ta === null) return 1; if (tb === null) return -1; return tb - ta; }
    if (a.tipo !== b.tipo) return a.tipo === 'job' ? -1 : 1;
    return String(a.titulo).localeCompare(String(b.titulo));
  });
}
/** Raiz do visor (D97, E6): "Em aberto" ou lista de commits — a MESMA régua dos ramos de `carregar` (só `#pr=3`
 * sem `repo`, ou `#commit=x` sem `projeto`, é raiz: o `carregar` também cai na raiz; painel do plano, Claude #3). */
function ehRaiz(estado) {
  return !(estado.job !== undefined || (estado.repo !== undefined && estado.pr !== undefined)
    || (estado.projeto !== undefined && estado.commit !== undefined));
}
const ROTULO_DO_PAI = (e) => (e.job !== undefined ? 'Job' : (e.pr !== undefined ? 'PR' : (e.projeto !== undefined ? 'Commits' : 'Em aberto')));
/** Um passo acima (D97, E7). Com pilha (`diffPasso > 0` e `anterior` string) → o de baixo; senão o pai padrão. */
function paiDe(estado, marca) {
  if (ehRaiz(estado)) return null;
  if (marca && marca.diffPasso > 0 && typeof marca.anterior === 'string') {
    const e = lerHash(marca.anterior);
    return { estado: e, rotulo: ROTULO_DO_PAI(e), pelaPilha: true };
  }
  const e = estado.commit !== undefined && estado.projeto !== undefined ? { projeto: estado.projeto } : {};
  return { estado: e, rotulo: ROTULO_DO_PAI(e), pelaPilha: false };
}

globalThis.cockpitDiff = {
  lerHash, montarHash, separarCaminho, linhasUnificadas, parearLados, dobraEntre, modoDoArquivo,
  inicialDoAutor, urlDaApi, misturarEmAberto, ehRaiz, paiDe, TETO_TRECHO, TETO_ARQUIVO, LARGURA_LADO_A_LADO,
};

// ─── a tela (DOM) ────────────────────────────────────────────────────────────

if (typeof document !== 'undefined' && document.getElementById('diff-raiz')) {

const $ = (id) => document.getElementById(id);
const raiz = $('diff-raiz');
const palco = $('diff-palco');
const avisoEl = $('diff-aviso');
const topo = $('diff-topo');

document.title = tr('Commits');

const tokenDaUrl = new URLSearchParams(location.search).get('token');
const tokenAgora = () => {
  if (tokenDaUrl && tokenDaUrl !== '-') return tokenDaUrl;
  try { return localStorage.getItem('cockpit-token') || ''; } catch { return ''; }
};
const cabecalhosToken = () => { const t = tokenAgora(); return t ? { authorization: `Bearer ${t}` } : {}; };

// D96 — de onde se veio. `history.state` por entrada: `diffPasso` = quantas entradas da diff há ABAIXO desta (0 na
// de chegada); `doCockpit` = a de chegada veio de um toque no cockpit NESTA aba. Entrada nova: lê-e-apaga a marca
// de passagem que `public/dentro-do-app.js` grava (a MESMA string, DJ7 do gate-ui) — o referrer não serve
// (`Referrer-Policy: no-referrer`). Recarga de uma entrada já marcada: vale a marca dela.
const CHAVE_VEIO = 'cockpit-veio-do-app';
function marcaDaEntrada() {
  const s = history.state;
  return s && typeof s.diffPasso === 'number' ? s : null;
}
if (!marcaDaEntrada()) {
  let doCockpit = false;
  try { doCockpit = sessionStorage.getItem(CHAVE_VEIO) === '1'; sessionStorage.removeItem(CHAVE_VEIO); } catch { /* modo privado: fica no link */ }
  history.replaceState({ diffPasso: 0, doCockpit }, '');
}

function mostrarAviso(texto) { if (!texto) { avisoEl.textContent = ''; avisoEl.hidden = true; return; } avisoEl.textContent = texto; avisoEl.hidden = false; }
function esconderAviso() { mostrarAviso(''); }
function mostrarErro(texto) { palco.replaceChildren(); listaCache = null; mostrarAviso(texto); }

function formatarData(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try { return new Intl.DateTimeFormat(idiomaUI.idioma, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d); }
  catch { return ''; }
}
function shaCurto(sha) { return String(sha || '').slice(0, 7); }

async function pedir(rota, params) {
  try {
    const r = await fetch(urlDaApi(rota, params), { headers: cabecalhosToken() });
    const corpo = await r.json().catch(() => null);
    return { status: r.status, ok: r.ok, corpo };
  } catch { return { status: 0, ok: false, corpo: null, rede: true }; }
}

/** Mensagem de erro de uma resposta ruim — um dono só (molde `grafo-mapa.js`). */
function mensagemDeErro(r) {
  if (r.rede || r.status === 0) return tr('não consegui falar com o servidor');
  if (r.status === 401) return tr('sem token');
  if (r.corpo && r.corpo.erro) return tr(r.corpo.erro);
  return tr('não consegui falar com o servidor');
}

// ─── estado do módulo ────────────────────────────────────────────────────────

let pedidoAtual = 0;
let estadoAtual = {};
let listaCache = null; // { chave ('aberto' ou 'projeto:<nome>'), elemento, scrollTop, em, aviso } — reuso sem refazer o pedido (V2, D97)
let commitAtual = null; // dados crus do commit (ou job) aberto agora, pro repaint do matchMedia

// ─── topo ────────────────────────────────────────────────────────────────────

/** O que sai do visor inteiro — D96: veio do cockpit NESTA aba → volta pela pilha (não empilha, #36); senão o link. */
function montarLinkCockpit(classe, texto) {
  const link = el('a', classe, texto);
  link.href = tokenDaUrl ? `../?token=${encodeURIComponent(tokenDaUrl)}` : '../';
  link.onclick = (ev) => {
    const m = marcaDaEntrada();
    if (!m || !m.doCockpit) return;
    ev.preventDefault();
    history.go(-(m.diffPasso + 1));
  };
  return link;
}
function montarTopoBase(estado) {
  topo.replaceChildren();
  const pai = paiDe(estado || {}, marcaDaEntrada());
  if (!pai) { topo.append(montarLinkCockpit('diff-voltar', tr('‹ Cockpit'))); return; }
  // D97 (E6/E7): vista interna — "‹ <pai>" sobe UM passo sem sair do /diff/; "Cockpit" (à direita) sai.
  const subir = el('a', 'diff-voltar', `‹ ${tr(pai.rotulo)}`);
  subir.href = montarHash(pai.estado) || '#';
  subir.onclick = (ev) => {
    ev.preventDefault();
    if (pai.pelaPilha) { history.back(); return; }
    const m = marcaDaEntrada() || { diffPasso: 0, doCockpit: false };
    history.replaceState({ diffPasso: m.diffPasso, doCockpit: m.doCockpit, anterior: null }, '', montarHash(pai.estado) || location.pathname + location.search);
    carregar(pai.estado);
  };
  topo.append(subir, montarLinkCockpit('diff-sair', tr('Cockpit')));
}

function montarSeletorProjeto(projetoEscolhido, aoEscolher) {
  const select = el('select', 'diff-seletor-projeto');
  select.id = 'diff-seletor-projeto';
  const vazia = el('option', null, tr('Em aberto'));
  vazia.value = '';
  select.append(vazia);
  pedir2Projetos().then((lista) => {
    const grupo = document.createElement('optgroup');
    grupo.label = tr('Commits do projeto');
    for (const p of lista) {
      const opt = el('option', null, p.nome);
      opt.value = p.nome;
      if (p.nome === projetoEscolhido) opt.selected = true;
      grupo.append(opt);
    }
    select.append(grupo);
  });
  select.onchange = () => { aoEscolher(select.value); };
  return select;
}

let cacheProjetos = null;
async function pedir2Projetos() {
  if (cacheProjetos) return cacheProjetos;
  try {
    const r = await fetch('../api/projetos', { headers: cabecalhosToken() });
    const corpo = await r.json().catch(() => null);
    cacheProjetos = (corpo && corpo.projetos) || [];
  } catch { cacheProjetos = []; }
  return cacheProjetos;
}

// ─── lista de commits ────────────────────────────────────────────────────────

function montarCartaoCommit(c) {
  const btn = el('button', 'diff-commit-item');
  btn.type = 'button';
  const assunto = el('div', 'diff-commit-assunto', c.assunto);
  btn.append(assunto);
  const linha = el('div', 'diff-commit-linha');
  linha.append(el('span', 'diff-commit-sha', shaCurto(c.sha)));
  linha.append(document.createTextNode(' · '));
  linha.append(el('span', 'diff-commit-autor', c.autor));
  linha.append(document.createTextNode(' · '));
  linha.append(el('span', 'diff-commit-data', formatarData(c.data)));
  if (c.merge) linha.append(el('span', 'diff-selo-merge', tr('merge')));
  btn.append(linha);
  const nums = el('div', 'diff-commit-nums');
  nums.append(el('span', 'diff-mais', `+${c.mais}`));
  nums.append(el('span', 'diff-menos', `−${c.menos}`));
  btn.append(nums);
  btn.onclick = () => navegarPara({ projeto: estadoAtual.projeto, commit: c.sha });
  return btn;
}

async function montarLista(projeto) {
  if (listaCache && listaCache.chave === `projeto:${projeto}`) {
    // Voltar pra lista também é navegação: o pedido em voo (um commit que ainda não respondeu) morre
    // aqui, senão a resposta atrasada reabriria o commit por cima da lista (painel de execução, Codex #2).
    pedidoAtual += 1;
    palco.replaceChildren(listaCache.elemento);
    raiz.scrollTop = listaCache.scrollTop || 0;
    avisarListaCortada(listaCache.cortado);
    return;
  }

  const n = ++pedidoAtual;
  const r = await pedir('commits', { projeto });
  if (n !== pedidoAtual) return;
  if (!r.ok) { mostrarErro(mensagemDeErro(r)); return; }

  const container = el('div', 'diff-lista');
  const listaEl = el('div', 'diff-lista-commits');
  for (const c of r.corpo.commits) listaEl.append(montarCartaoCommit(c));
  container.append(listaEl);

  let topoPaginacao = r.corpo.topo;
  let maisDisponivel = r.corpo.mais;
  const shasVistos = new Set(r.corpo.commits.map((c) => c.sha));
  let btnMais = null;
  const montarBtnMais = () => {
    if (btnMais) btnMais.remove();
    if (!maisDisponivel) return;
    btnMais = el('button', 'diff-mais-commits', tr('Mais commits'));
    btnMais.type = 'button';
    btnMais.onclick = async () => {
      btnMais.disabled = true;
      const r2 = await pedir('commits', { projeto, topo: topoPaginacao, pular: shasVistos.size });
      btnMais.disabled = false;
      if (!r2.ok) { mostrarAviso(mensagemDeErro(r2)); return; }
      if (r2.corpo.cortado) listaCache.cortado = true;
      avisarListaCortada(listaCache.cortado);
      for (const c of r2.corpo.commits) {
        if (shasVistos.has(c.sha)) continue;
        shasVistos.add(c.sha);
        listaEl.append(montarCartaoCommit(c));
      }
      maisDisponivel = r2.corpo.mais;
      montarBtnMais();
    };
    container.append(btnMais);
  };
  montarBtnMais();

  palco.replaceChildren(container);
  listaCache = { chave: `projeto:${projeto}`, elemento: container, scrollTop: 0, em: Date.now(), cortado: Boolean(r.corpo.cortado) };
  avisarListaCortada(listaCache.cortado);
}

/** O `cortado` da LISTA é booleano (teto do log ou timeout) — não é o `{corpo, lista, tempo}` da diff. Vale
 * na 1ª carga, na volta pelo cache e depois de "Mais commits" (painel de execução, R1 e R2). */
function avisarListaCortada(cortado) {
  if (cortado) mostrarAviso(tr('a lista de commits pode estar incompleta — toque em "Mais commits" para continuar'));
  else esconderAviso();
}

// ─── "Em aberto" (D97): jobs esperando merge + PRs do GitHub ──────────────────

const PRAZO_ABERTO_MS = 60_000; // o mesmo do cache do servidor (lib/github.js) — D97, E8
async function pedirJobsRevisar() {
  try {
    const r = await fetch('../api/jobs?revisar=1', { headers: cabecalhosToken() });
    const corpo = await r.json().catch(() => null);
    if (!r.ok || !corpo || !Array.isArray(corpo.jobs)) return { ok: false, jobs: [], status: r.status };
    return { ok: !corpo.erro, jobs: corpo.jobs, status: r.status };
  } catch { return { ok: false, jobs: [], status: 0 }; }
}
function avisoDoAberto(jobsOk, githubOk, limite) {
  const partes = [];
  if (!jobsOk) partes.push(tr('não consegui ler os jobs agora'));
  if (!githubOk) partes.push(tr('não consegui ler o GitHub agora'));
  else if (limite) partes.push(tr('mostrando os 30 PRs mais recentes do GitHub'));
  mostrarAviso(partes.join(' · '));
}
function montarItemAberto(item) {
  const btn = el('button', 'diff-aberto-item');
  btn.type = 'button';
  btn.append(el('div', 'diff-commit-assunto', item.titulo));
  const linha = el('div', 'diff-commit-linha');
  linha.append(el('span', 'diff-aberto-onde', item.tipo === 'job' ? item.projeto : item.repo));
  linha.append(document.createTextNode(' · '));
  linha.append(el('span', `diff-etiqueta diff-etiqueta-${item.tipo === 'job' ? 'job' : 'github'}`, item.tipo === 'job' ? tr('job') : tr('GitHub #{0}', item.numero)));
  if (item.rascunho) linha.append(el('span', 'diff-etiqueta', tr('rascunho')));
  if (item.quando) { linha.append(document.createTextNode(' · ')); linha.append(el('span', 'diff-commit-data', formatarData(item.quando))); }
  btn.append(linha);
  btn.onclick = () => navegarPara(item.tipo === 'job' ? { job: item.id } : { repo: item.repo, pr: String(item.numero) });
  return btn;
}
async function montarEmAberto() {
  if (listaCache && listaCache.chave === 'aberto' && !listaCache.falhou && Date.now() - listaCache.em < PRAZO_ABERTO_MS) {
    pedidoAtual += 1; // mesma razão de `montarLista` (resposta atrasada não reabre por cima)
    palco.replaceChildren(listaCache.elemento);
    raiz.scrollTop = listaCache.scrollTop || 0;
    listaCache.aviso();
    return;
  }
  const rolagemGuardada = listaCache && listaCache.chave === 'aberto' ? listaCache.scrollTop : 0;
  const n = ++pedidoAtual;
  // A espera é de REDE (gh ~1 s, até 8 s): nunca palco em branco — o sintoma que abriu o card (painel do plano, Claude #2).
  palco.replaceChildren(el('p', 'diff-nota diff-aberto-carregando', tr('Carregando…')));
  esconderAviso();
  const [rJobs, rPrs] = await Promise.all([pedirJobsRevisar(), pedir('prs')]);
  if (n !== pedidoAtual) return;
  // Token ruim derruba as DUAS rotas: diz "sem token" como o resto do visor, não "GitHub fora" (painel do plano, Claude #7).
  if (rJobs.status === 401 || rPrs.status === 401) { mostrarErro(tr('sem token')); return; }
  const githubOk = Boolean(rPrs.ok && rPrs.corpo && rPrs.corpo.github === 'ok');
  const prs = githubOk ? rPrs.corpo.prs : [];
  const limite = githubOk && Boolean(rPrs.corpo.limite);
  const itens = misturarEmAberto(rJobs.jobs, prs);
  const container = el('div', 'diff-lista diff-em-aberto');
  if (!itens.length) container.append(el('p', 'diff-nota diff-aberto-vazio', tr('Nada esperando merge.')));
  else { const listaEl = el('div', 'diff-lista-commits'); for (const it of itens) listaEl.append(montarItemAberto(it)); container.append(listaEl); }
  palco.replaceChildren(container);
  const aviso = () => avisoDoAberto(rJobs.ok, githubOk, limite);
  aviso();
  listaCache = { chave: 'aberto', elemento: container, scrollTop: rolagemGuardada, em: Date.now(), falhou: !rJobs.ok || !githubOk, aviso };
  raiz.scrollTop = rolagemGuardada;
}

function mostrarAvisoDeCorte(cortado) {
  if (!cortado) { esconderAviso(); return; }
  if (cortado.tempo) { mostrarAviso(tr('o git demorou demais — a diff pode estar incompleta')); return; }
  if (cortado.lista) { mostrarAviso(tr('lista incompleta: diff grande demais para listar todos os arquivos')); return; }
  if (cortado.corpo) { mostrarAviso(tr('conteúdo cortado: diff grande demais')); return; }
  esconderAviso();
}

// ─── commit ──────────────────────────────────────────────────────────────────

function chipsDoArquivo(arq) {
  const chips = [];
  if (arq.estado === 'novo') chips.push(tr('novo'));
  if (arq.estado === 'apagado') chips.push(tr('apagado'));
  if (arq.estado === 'renomeado') chips.push(tr('renomeado de {0}', arq.antigo));
  if (arq.binario) chips.push(tr('binário'));
  if (arq.modo && arq.modo.antes && arq.modo.depois) chips.push(tr('modo {0} → {1}', arq.modo.antes, arq.modo.depois));
  return chips;
}

function montarCorpoTrecho(trecho) {
  const ladoALado = globalThis.matchMedia && matchMedia(`(min-width: ${LARGURA_LADO_A_LADO}px)`).matches;
  const wrap = el('div', 'diff-trecho-corpo');
  if (ladoALado) {
    const tabela = el('table', 'diff-tabela-lado-a-lado');
    for (const par of parearLados(trecho)) {
      const tr2 = document.createElement('tr');
      // A cor vai na CÉLULA do lado que mudou (como o Zed): o lado sem linha correspondente é só hachurado.
      const montarLado = (lado) => {
        const n = el('td', 'diff-num', lado ? String(lado.n) : '');
        const t = el('td', 'diff-texto', lado ? lado.texto : '');
        const cor = lado && lado.tipo === '+' ? ' diff-mais' : (lado && lado.tipo === '-' ? ' diff-menos' : '');
        n.className += cor;
        t.className += cor;
        if (!lado) { n.className += ' diff-vazio'; t.className += ' diff-vazio'; }
        else if (lado.longa) t.append(el('span', 'diff-linha-cortada', ` ${tr('… linha cortada ({0} caracteres)', lado.longa)}`));
        return [n, t];
      };
      const [nEsq, tEsq] = montarLado(par.esq);
      const [nDir, tDir] = montarLado(par.dir);
      tr2.append(nEsq, tEsq, nDir, tDir);
      tabela.append(tr2);
    }
    wrap.append(tabela);
  } else {
    const tabela = el('table', 'diff-tabela-unificada');
    for (const l of linhasUnificadas(trecho)) {
      const tr2 = document.createElement('tr');
      tr2.className = l.tipo === '+' ? 'diff-mais' : (l.tipo === '-' ? 'diff-menos' : '');
      tr2.append(el('td', 'diff-num', l.antes != null ? String(l.antes) : ''));
      tr2.append(el('td', 'diff-num', l.depois != null ? String(l.depois) : ''));
      const t = el('td', 'diff-texto', l.texto);
      if (l.longa) t.append(el('span', 'diff-linha-cortada', ` ${tr('… linha cortada ({0} caracteres)', l.longa)}`));
      tr2.append(t);
      tabela.append(tr2);
    }
    wrap.append(tabela);
  }
  return wrap;
}

function montarTrechoBloco(trecho, dobra) {
  const bloco = el('div', 'diff-trecho-bloco');
  if (dobra > 0) bloco.append(el('div', 'diff-dobra', tr('… {0} linhas iguais', dobra)));
  bloco.append(el('div', 'diff-trecho-cabecalho', trecho.cabecalho ? `@@ ${trecho.cabecalho}` : '@@'));
  const totalLinhas = trecho.linhas.length;
  const teto = Math.min(totalLinhas, TETO_TRECHO);
  const trechoVisivel = { ...trecho, linhas: trecho.linhas.slice(0, teto), longas: (trecho.longas || []).filter((lg) => lg.i < teto) };
  bloco.append(montarCorpoTrecho(trechoVisivel));
  if (totalLinhas > teto) {
    const corpoAtual = bloco.querySelector('.diff-trecho-corpo');
    const btn = el('button', 'diff-mostrar-mais-linhas', tr('mostrar mais {0} linhas', totalLinhas - teto));
    btn.type = 'button';
    btn.onclick = () => {
      btn.remove();
      corpoAtual.replaceWith(montarCorpoTrecho(trecho));
    };
    bloco.append(btn);
  }
  return bloco;
}

function montarNotaSemFimDeLinha(arq) {
  if (!arq.semFimDeLinha || (!arq.semFimDeLinha.antes && !arq.semFimDeLinha.depois)) return null;
  return el('div', 'diff-sem-fim-de-linha', tr('sem quebra de linha no fim'));
}

function montarCorpoArquivo(arq) {
  const modo = modoDoArquivo(arq);
  const corpo = el('div', 'diff-arquivo-corpo');
  if (modo === 'binario') { corpo.append(el('p', 'diff-nota', tr('arquivo binário — conteúdo não mostrado'))); return corpo; }
  if (modo === 'cortado') {
    const msg = arq.semCorpo === 'desalinhado' ? tr('não deu para casar o conteúdo deste arquivo') : tr('conteúdo cortado: diff grande demais');
    corpo.append(el('p', 'diff-nota', msg));
    return corpo;
  }
  if (modo === 'trechos') {
    const listaTrechos = el('div', 'diff-lista-trechos');
    arq.trechos.forEach((t, i) => {
      const btn = el('button', 'diff-trecho-botao', `@@ ${t.cabecalho || ''} · ${tr('{0} linhas', t.linhas.length)}`);
      btn.type = 'button';
      let aberto = null;
      btn.onclick = () => {
        if (aberto) { aberto.remove(); aberto = null; return; }
        aberto = montarTrechoBloco(t, i === 0 ? dobraEntre(null, t) : dobraEntre(arq.trechos[i - 1], t));
        btn.insertAdjacentElement('afterend', aberto);
      };
      listaTrechos.append(btn);
    });
    corpo.append(listaTrechos);
    const nota = montarNotaSemFimDeLinha(arq);
    if (nota) corpo.append(nota);
    return corpo;
  }
  // 'cheio'
  arq.trechos.forEach((t, i) => {
    corpo.append(montarTrechoBloco(t, i === 0 ? dobraEntre(null, t) : dobraEntre(arq.trechos[i - 1], t)));
  });
  const nota = montarNotaSemFimDeLinha(arq);
  if (nota) corpo.append(nota);
  return corpo;
}

function montarArquivo(arq) {
  const { nome, pasta } = separarCaminho(arq.caminho);
  const det = document.createElement('details');
  det.className = 'diff-arquivo';
  det.open = true;
  const sumario = document.createElement('summary');
  sumario.append(el('span', 'diff-arquivo-nome', nome));
  if (pasta) sumario.append(el('span', 'diff-arquivo-pasta', pasta));
  for (const chip of chipsDoArquivo(arq)) sumario.append(el('span', 'diff-chip', chip));
  const nums = el('span', 'diff-arquivo-nums');
  nums.append(el('span', 'diff-mais', `+${arq.mais ?? 0}`));
  nums.append(el('span', 'diff-menos', `−${arq.menos ?? 0}`));
  sumario.append(nums);
  det.append(sumario);
  det.append(montarCorpoArquivo(arq));
  return det;
}

function totalDeArquivos(dados) {
  return (dados.totais && dados.totais.arquivos) ?? dados.arquivos.length;
}
function totalDe(dados, campo) {
  if (dados.totais) return dados.totais[campo];
  return dados.arquivos.reduce((soma, a) => soma + (a[campo] || 0), 0);
}

/** `data-quebrar` vive no `#diff-palco` (cascata pro CSS `[data-quebrar="1"] .diff-texto` — "0" desliga; atributo vazio também casaria `[data-quebrar]`). */
function aplicarQuebrarInicial() {
  let quebrar = false;
  try { quebrar = localStorage.getItem('cockpit-diff-quebrar') === '1'; } catch { quebrar = false; }
  palco.dataset.quebrar = quebrar ? '1' : '0';
}

function montarBarraArquivos(dados) {
  const barra = el('div', 'diff-barra');
  barra.append(el('span', null, tr('{0} arquivos · +{1} −{2}', totalDeArquivos(dados), totalDe(dados, 'mais'), totalDe(dados, 'menos'))));
  const btnQuebrar = el('button', 'diff-btn-quebrar', tr('Quebrar linhas'));
  btnQuebrar.type = 'button';
  btnQuebrar.setAttribute('aria-pressed', String(palco.dataset.quebrar === '1'));
  btnQuebrar.onclick = () => {
    const novo = palco.dataset.quebrar !== '1';
    palco.dataset.quebrar = novo ? '1' : '0';
    btnQuebrar.setAttribute('aria-pressed', String(novo));
    try { localStorage.setItem('cockpit-diff-quebrar', novo ? '1' : '0'); } catch { /* ok */ }
  };
  barra.append(btnQuebrar);
  return barra;
}

function montarListaDeArquivos(dados) {
  const container = el('div', 'diff-arquivos');
  for (const arq of dados.arquivos) container.append(montarArquivo(arq));
  return container;
}

function montarCabecalhoCommit(commit, merge) {
  const cab = el('div', 'diff-cabecalho');
  const avatar = el('div', 'diff-avatar', inicialDoAutor(commit.autor));
  cab.append(avatar);
  const meio = el('div', 'diff-cabecalho-meio');
  const mensagemBloco = el('div', 'diff-mensagem');
  const linhas = String(commit.mensagem || '').split('\n');
  mensagemBloco.append(el('strong', null, linhas[0] || ''));
  const corpoMsg = linhas.slice(1).join('\n').trim();
  if (corpoMsg) {
    const pre = el('div', 'diff-mensagem-corpo', corpoMsg);
    pre.style.whiteSpace = 'pre-wrap';
    mensagemBloco.append(pre);
  }
  meio.append(mensagemBloco);
  meio.append(el('div', 'diff-cabecalho-info', `${commit.autor} · ${formatarData(commit.data)} · ${commit.email}`));
  if (merge) meio.append(el('div', 'diff-nota-merge', tr('merge · mudanças contra o 1º pai')));

  // SHA curto + "Copiar" DENTRO de `.diff-cabecalho-meio` (não irmão de `.diff-avatar` na linha de
  // cima): o SHA inteiro como irmão espremia a mensagem palavra por palavra no celular (390 px).
  const linhaSha = el('div', 'diff-linha-sha');
  const shaSpan = el('span', 'diff-sha-visivel', shaCurto(commit.sha));
  linhaSha.append(shaSpan);
  const btnCopiar = el('button', 'diff-btn-copiar', tr('Copiar SHA'));
  btnCopiar.type = 'button';
  btnCopiar.onclick = async () => {
    let copiou = false;
    try { await navigator.clipboard.writeText(commit.sha); copiou = true; } catch { copiou = false; }
    if (!copiou) {
      try {
        const range = document.createRange();
        range.selectNodeContents(shaSpan);
        const sel = globalThis.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* sem seleção possível também: segue mesmo assim */ }
    }
    const textoOriginal = btnCopiar.textContent;
    btnCopiar.textContent = tr('Copiado');
    setTimeout(() => { btnCopiar.textContent = textoOriginal; }, 1500);
  };
  linhaSha.append(btnCopiar);
  meio.append(linhaSha);
  cab.append(meio);

  return cab;
}

function repintarCommitAberto() {
  if (!commitAtual) return;
  // O commit aberto OU o job aberto: os dois desenham os arquivos por `montarListaDeArquivos`.
  const container = palco.querySelector('.diff-commit-vista, .diff-job-vista, .diff-pr-vista');
  if (!container) return;
  const velhaArquivos = container.querySelector('.diff-arquivos');
  if (velhaArquivos) velhaArquivos.replaceWith(montarListaDeArquivos(commitAtual));
}

async function montarCommit(projeto, sha) {
  const n = ++pedidoAtual;
  const r = await pedir('commit', { projeto, sha });
  if (n !== pedidoAtual) return;
  if (!r.ok) { mostrarErro(mensagemDeErro(r)); return; }

  const dados = r.corpo;
  commitAtual = dados;
  const container = el('div', 'diff-commit-vista');
  container.append(montarCabecalhoCommit(dados.commit, dados.merge));
  container.append(montarBarraArquivos(dados));
  container.append(montarListaDeArquivos(dados));
  palco.replaceChildren(container);
  aplicarQuebrarInicial();
  esconderAviso();
  mostrarAvisoDeCorte(dados.cortado);
}

// ─── job ─────────────────────────────────────────────────────────────────────

function montarCabecalhoJob(id, titulo, projeto, base) {
  const cab = el('div', 'diff-cabecalho-job');
  cab.append(el('h2', null, titulo || id));
  cab.append(el('div', 'diff-job-projeto', projeto));
  if (base) cab.append(el('div', 'diff-job-subtitulo', tr('o que o merge na {0} traria', base)));
  return cab;
}

async function montarJob(id) {
  const n = ++pedidoAtual;
  const r = await pedir('job', { id });
  if (n !== pedidoAtual) return;
  if (!r.ok) { mostrarErro(mensagemDeErro(r)); return; }

  const dados = r.corpo;
  const container = el('div', 'diff-job-vista');
  container.append(montarCabecalhoJob(dados.id, dados.titulo, dados.projeto, dados.base));

  if (dados.estado === 'sem-base') {
    container.append(el('p', 'diff-nota', tr('Este projeto não tem develop nem main.')));
  } else if (dados.estado === 'branch-sumiu' && dados.motivo === 'limpo') {
    const p = el('p', 'diff-nota');
    p.append(document.createTextNode(`${tr('Este job já foi mergeado e limpo — a branch não existe mais. As mudanças estão na lista de commits do projeto.')} `));
    const link = el('a', null, tr('Ver commits do projeto'));
    link.href = '#';
    link.onclick = (ev) => { ev.preventDefault(); navegarPara({ projeto: dados.projeto }); };
    p.append(link);
    container.append(p);
  } else if (dados.estado === 'branch-sumiu') {
    container.append(el('p', 'diff-nota', tr('A branch deste job não existe mais.')));
  } else if (dados.estado === 'sem-mudancas') {
    container.append(el('p', 'diff-nota', tr('Já está na {0}: nada a mergear.', dados.base)));
  } else if (dados.estado === 'ok') {
    const det = document.createElement('details');
    det.className = 'diff-job-commits';
    const sum = document.createElement('summary');
    sum.textContent = tr('{0} commits', dados.nCommits);
    det.append(sum);
    const listaEl = el('div', 'diff-lista-commits');
    for (const c of dados.commits) {
      const cartao = montarCartaoCommit(c);
      cartao.onclick = () => navegarPara({ projeto: dados.projeto, commit: c.sha });
      listaEl.append(cartao);
    }
    det.append(listaEl);
    container.append(det);
    container.append(montarBarraArquivos(dados));
    container.append(montarListaDeArquivos(dados));
    commitAtual = dados;
    mostrarAvisoDeCorte(dados.cortado);
  }

  palco.replaceChildren(container);
  if (dados.estado === 'ok') aplicarQuebrarInicial();
  else esconderAviso();
}

// ─── PR do GitHub (D97) ───────────────────────────────────────────────────────

function montarCabecalhoPr(pr) {
  const cab = el('div', 'diff-cabecalho-job diff-cabecalho-pr');
  cab.append(el('h2', null, pr.titulo || `#${pr.numero}`));
  cab.append(el('div', 'diff-job-projeto', `${pr.repo} #${pr.numero}`));
  const info = [pr.autor, pr.atualizado ? formatarData(pr.atualizado) : ''].filter(Boolean).join(' · ');
  if (info) cab.append(el('div', 'diff-job-subtitulo', info));
  if (pr.head && pr.base) cab.append(el('div', 'diff-pr-branches', `${pr.head} → ${pr.base}`));
  const link = el('a', 'diff-pr-github', tr('Abrir no GitHub ↗'));
  link.href = pr.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  cab.append(link);
  return cab;
}
async function montarPr(repo, numero) {
  const n = ++pedidoAtual;
  const r = await pedir('pr', { repo, numero });
  if (n !== pedidoAtual) return;
  if (!r.ok) { mostrarErro(mensagemDeErro(r)); return; }
  const dados = r.corpo;
  const container = el('div', 'diff-pr-vista');
  container.append(montarCabecalhoPr(dados.pr));
  if (dados.semDiff) {
    container.append(el('p', 'diff-nota', tr('o GitHub não mandou a diff deste PR — abra no GitHub')));
    commitAtual = null;
  } else {
    container.append(montarBarraArquivos(dados));
    container.append(montarListaDeArquivos(dados));
    commitAtual = dados; // sem isto o `repintarCommitAberto` sai no `if (!commitAtual)` (painel da spec, Claude #7)
  }
  palco.replaceChildren(container);
  aplicarQuebrarInicial();
  esconderAviso();
  if (!dados.semDiff) mostrarAvisoDeCorte(dados.cortado);
}

// ─── navegação ───────────────────────────────────────────────────────────────

function navegarPara(estado) {
  if (listaCache && listaCache.elemento.isConnected) listaCache.scrollTop = raiz.scrollTop;
  const m = marcaDaEntrada() || { diffPasso: 0, doCockpit: false };
  history.pushState({ diffPasso: m.diffPasso + 1, doCockpit: m.doCockpit, anterior: location.hash }, '', montarHash(estado));
  carregar(estado);
}

async function carregar(estado) {
  estadoAtual = estado;
  montarTopoBase(estado);
  if (estado.job !== undefined) { await montarJob(estado.job); return; }
  if (estado.repo !== undefined && estado.pr !== undefined) { await montarPr(estado.repo, estado.pr); return; }
  if (estado.projeto !== undefined && estado.commit !== undefined) { await montarCommit(estado.projeto, estado.commit); return; }
  // Raiz (D97, E1/E5): sem projeto no hash é SEMPRE "Em aberto" — o `cockpit-diff-projeto` do localStorage não manda mais.
  const projeto = estado.projeto || '';
  const select = montarSeletorProjeto(projeto, (novo) => {
    const alvo = novo ? { projeto: novo } : {};
    const m = marcaDaEntrada() || { diffPasso: 0, doCockpit: false };
    history.replaceState({ ...m, anterior: m.anterior ?? null }, '', montarHash(alvo) || location.pathname + location.search);
    carregar(alvo);
  });
  topo.append(select);
  if (!projeto) { await montarEmAberto(); return; }
  estadoAtual = { projeto };
  await montarLista(projeto);
}

// Repaint ao cruzar o ponto de quebra lado a lado/unificada (V12) — sem refazer o pedido.
if (globalThis.matchMedia) {
  const mq = matchMedia(`(min-width: ${LARGURA_LADO_A_LADO}px)`);
  const aoMudar = () => repintarCommitAberto();
  if (mq.addEventListener) mq.addEventListener('change', aoMudar);
  else if (mq.addListener) mq.addListener(aoMudar);
}

window.addEventListener('popstate', () => carregar(lerHash(location.hash)));

carregar(lerHash(location.hash));

} // fim do guard `typeof document !== 'undefined'`

})();
