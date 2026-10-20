'use strict';
// Página "Finanças" (`financas.html`, card `pagina-financas`, D92) — evolução do diálogo D90, que
// sai nesta fase (a entrada mora em `financas-entrada.js`). Molde IIFE de grafo.js: só
// textContent/createElement/createElementNS (#26), nada de innerHTML. Lê o resumo financeiro
// diário e os lançamentos de um gerador externo; sem tempo real (P1) — a página busca tudo ao
// abrir e nunca mais refaz fetch (período e sanfonas só redesenham o que já tem). As puras
// (sobre resumo e sobre lançamentos) ficam em `globalThis.cockpitFinancas`, antes do guard de
// `document`, pro gate testar em Node puro.
(function () {

const idiomaUI = globalThis.cockpitI18n;
const tr = (...args) => idiomaUI.t(...args);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

// Token lido A CADA CHAMADA (mesmo motivo de grafo.js/revisar.js).
const tokenAgora = () => { try { return localStorage.getItem('cockpit-token') || ''; } catch { return ''; } };

async function api(rota, corpo) {
  const cabecalhos = {};
  const token = tokenAgora();
  if (token) cabecalhos.authorization = `Bearer ${token}`;
  const opcoes = corpo
    ? { method: 'POST', headers: { ...cabecalhos, 'content-type': 'application/json' }, body: JSON.stringify(corpo) }
    : { headers: cabecalhos };
  const resposta = await fetch(rota, opcoes);
  if (resposta.status === 401) {
    const erro = new Error(tr('sem token'));
    erro.semToken = true;
    throw erro;
  }
  if (!resposta.ok) {
    let mensagem = null;
    try { const corpoResp = await resposta.json(); mensagem = corpoResp && corpoResp.erro; } catch { /* sem corpo JSON */ }
    throw new Error(mensagem || `HTTP ${resposta.status}`);
  }
  return resposta.json();
}

// ─── Puras, exportadas em globalThis.cockpitFinancas ANTES do guard de `document` (o gate
// faz `require` em Node puro, sem DOM). ──────────────────────────────────────────────────────

/** `[{ id, rotulo, visao }]`: casa primeiro (quando existe), depois as pessoas. */
function visoes(dados, trFn) {
  const lista = [];
  if (dados && dados.casa) lista.push({ id: 'casa', rotulo: trFn('Casa'), visao: dados.casa });
  for (const p of (dados && dados.pessoas) || []) lista.push({ id: p.id, rotulo: p.nome, visao: p });
  return lista;
}

/** O `id` da primeira visão da lista, ou `null` sem nenhuma. */
function visaoInicial(lista) {
  return lista.length ? lista[0].id : null;
}

/** O mês cujo `mes === visao.ultimoCompleto`, ou `null` sem mês completo ainda. */
function mesDoKpi(visao) {
  if (!visao || !visao.ultimoCompleto) return null;
  return (visao.meses || []).find((m) => m.mes === visao.ultimoCompleto) || null;
}

/** `{ mes: { renda: %, gasto: % } }`, relativas ao maior valor não-nulo e positivo da lista. */
function larguras(meses) {
  const positivos = [];
  for (const m of meses) {
    if (typeof m.renda === 'number' && m.renda > 0) positivos.push(m.renda);
    if (typeof m.gasto === 'number' && m.gasto > 0) positivos.push(m.gasto);
  }
  const maior = positivos.length ? Math.max(...positivos) : 0;
  const pct = (v) => (maior > 0 && typeof v === 'number' && v > 0 ? (v / maior) * 100 : 0);
  const saida = {};
  for (const m of meses) saida[m.mes] = { renda: pct(m.renda), gasto: pct(m.gasto) };
  return saida;
}

/** `'DD/MM'` por REGEX em `YYYY-MM-DD` (nunca `new Date` — data pura, #35); inválido → `null`. */
function diaMes(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return `${m[3]}/${m[2]}`;
}

/** `Intl.NumberFormat` em BRL; `null` → `null` (quem desenha escreve "não sei"). */
function dinheiro(v, idioma) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  try {
    return new Intl.NumberFormat(idioma, { style: 'currency', currency: 'BRL' }).format(v);
  } catch {
    return null;
  }
}

/** `"gerado {0}"` / `"não sei quando este resumo foi gerado"`. `fmtHora` é do APARELHO (#35). */
function textoGerado(visao, fmtHora, trFn) {
  const h = visao && visao.geradoEm ? fmtHora(visao.geradoEm) : '';
  if (!h) return trFn('não sei quando este resumo foi gerado');
  return trFn('gerado {0}', h);
}

// ─── D92 (Página de Finanças) — puras sobre LANÇAMENTOS, não sobre o resumo. ────────────────

/** Os `n` meses mais recentes de `meses` (P8) — `n` maior que a lista devolve a lista inteira. */
function mesesDoPeriodo(meses, n) {
  if (!Array.isArray(meses)) return [];
  return n >= meses.length ? meses.slice() : meses.slice(-n);
}

/** `Map(categoria → débitos − créditos)` de um mês, excluindo `fora` e `grupo === 'Renda'`. */
function gastoPorCategoria(lancs, mes) {
  const mapa = new Map();
  for (const l of lancs) {
    if (l.mes !== mes || l.fora || l.grupo === 'Renda') continue;
    const sinal = l.tipo === 'debito' ? 1 : -1;
    mapa.set(l.categoria, (mapa.get(l.categoria) || 0) + sinal * l.valor);
  }
  return mapa;
}

/** Nomes de categoria em ordem decrescente do total no `meses` do período. */
function categoriasDoPeriodo(lancs, meses) {
  const total = new Map();
  for (const mes of meses) {
    for (const [cat, v] of gastoPorCategoria(lancs, mes)) total.set(cat, (total.get(cat) || 0) + v);
  }
  return [...total.entries()].sort((a, b) => b[1] - a[1]).map(([nome]) => nome);
}

/** As linhas de `categoria` em `mes` que entram no gasto — o MESMO filtro de `gastoPorCategoria` (Codex #2). */
function lancamentosDe(lancs, mes, categoria) {
  return lancs.filter((l) => l.mes === mes && l.categoria === categoria && !l.fora && l.grupo !== 'Renda');
}

/** `Map(categoria → débitos − créditos)` só dos lançamentos `fora_do_gasto` de um mês (P11). */
function foraDoGasto(lancs, mes) {
  const mapa = new Map();
  for (const l of lancs) {
    if (l.mes !== mes || !l.fora) continue;
    const sinal = l.tipo === 'debito' ? 1 : -1;
    mapa.set(l.categoria, (mapa.get(l.categoria) || 0) + sinal * l.valor);
  }
  return mapa;
}

/** Descrição normalizada pra agrupar "a mesma loja": espaços colapsados, prefixo Pix tirado, sem caixa. */
function chaveLoja(descricao) {
  const colapsado = String(descricao || '').trim().replace(/\s+/g, ' ');
  const semPrefixo = colapsado.replace(/^Pix enviado para\s+/i, '').replace(/^Pix recebido de\s+/i, '');
  return semPrefixo.toLowerCase();
}

/**
 * Top `n` lojas/pessoas por débito em `mes` (P12) — só DÉBITOS que entram no gasto (sem `fora`,
 * sem `grupo === 'Renda'`), SEM abater estorno (créditos nunca entram aqui — por isso a soma não
 * fecha com `gastoPorCategoria`, e a tela avisa, Claude #11).
 */
function maioresGastos(lancs, mes, n) {
  const mapa = new Map();
  for (const l of lancs) {
    if (l.mes !== mes || l.fora || l.grupo === 'Renda' || l.tipo !== 'debito') continue;
    const chave = chaveLoja(l.descricao);
    const atual = mapa.get(chave);
    if (atual) atual.total += l.valor;
    else mapa.set(chave, { nome: l.descricao, total: l.valor });
  }
  return [...mapa.values()].sort((a, b) => b.total - a.total).slice(0, n);
}

/** `{ pct }` (P13) — `null` sem `atual`/`anterior` numéricos ou `anterior === 0` (nunca `Infinity`). */
function variacao(atual, anterior) {
  if (typeof atual !== 'number' || typeof anterior !== 'number' || anterior === 0) return null;
  return { pct: ((atual - anterior) / anterior) * 100 };
}

/** % de `valor` sobre o gasto do mês — `null` ("—") com gasto do mês `<= 0` (Codex #1). */
function pctDoMes(valor, gastoDoMes) {
  if (typeof valor !== 'number' || typeof gastoDoMes !== 'number' || gastoDoMes <= 0) return null;
  return (valor / gastoDoMes) * 100;
}

/**
 * Meses em que `|Σ gastoPorCategoria − resumo.gasto| > R$ 1`, só entre os meses do RESUMO que
 * têm ≥ 1 lançamento no arquivo — mês sem nenhum lançamento é "sem lançamentos" (célula "—"),
 * nunca divergência (Claude #4). `gasto` do resumo `null` → sem comparação.
 */
function divergencias(meses, lancs) {
  const presentes = new Set(lancs.map((l) => l.mes));
  const saida = [];
  for (const m of meses || []) {
    if (!presentes.has(m.mes) || typeof m.gasto !== 'number') continue;
    let soma = 0;
    for (const v of gastoPorCategoria(lancs, m.mes).values()) soma += v;
    const diferenca = Math.abs(soma - m.gasto);
    if (diferenca > 1) saida.push({ mes: m.mes, diferenca });
  }
  return saida;
}

/** Junta lançamentos de várias pessoas (Casa) — cada linha ganha `pessoa` (o NOME, não o id). */
function juntarLancamentos(porPessoa, nomes) {
  const saida = [];
  for (const [id, lista] of Object.entries(porPessoa || {})) {
    const nome = (nomes && nomes[id]) || id;
    for (const l of lista) saida.push({ ...l, pessoa: nome });
  }
  return saida;
}

globalThis.cockpitFinancas = {
  visoes, visaoInicial, mesDoKpi, larguras, diaMes, dinheiro, textoGerado,
  mesesDoPeriodo, gastoPorCategoria, categoriasDoPeriodo, lancamentosDe, foraDoGasto,
  maioresGastos, chaveLoja, variacao, pctDoMes, divergencias, juntarLancamentos,
};

// O resto é só DOM. Guardado pra este arquivo continuar `require`-ável em Node puro (o gate).
if (typeof document !== 'undefined' && document.getElementById('pagina-financas')) {

const visoesEl = $('fin-visoes');
const carimboEl = $('fin-carimbo');
const avisosEl = $('fin-avisos');
const periodoEl = $('fin-periodo');
const btnExportarEl = $('fin-exportar');
const menuExportarEl = $('fin-exportar-menu');
const statusExportarEl = $('fin-exportar-status');
const destinosFieldset = $('fin-destinos');
const corpoKpis = $('fin-kpis').querySelector('.fin-corpo');
const corpoRendaGasto = $('fin-rendagasto').querySelector('.fin-corpo');
const corpoEmpilhado = $('fin-empilhado').querySelector('.fin-corpo');
const corpoDetalhe = $('fin-detalhe').querySelector('.fin-corpo');
const corpoTabela = $('fin-tabela').querySelector('.fin-corpo');
const corpoMaiores = $('fin-maiores').querySelector('.fin-corpo');
const corpoFora = $('fin-fora').querySelector('.fin-corpo');
const corpoContas = $('fin-contas').querySelector('.fin-corpo');
const corpoReembolsos = $('fin-reembolsos').querySelector('.fin-corpo');
const TODAS_SECOES = [...document.querySelectorAll('.fin-cartao')];
const CORES_CATEGORIA = ['--fin-c1', '--fin-c2', '--fin-c3', '--fin-c4', '--fin-c5', '--fin-c6', '--fin-c7'];

// Estado do módulo — sem tempo real (P1): um fetch por abertura; período e sanfonas só redesenham.
let dados = null; // GET api/financas
const lancsPorPessoa = {}; // { [id]: { estado, lancamentos, descartados } | { estado: 'ilegivel'|'ausente' } }
let erroGeral = null;
let visaoId = null;
let periodo = 3;
let mesSel = null;
let abertoTabela = null; // { mes, cat } | null — uma sanfona por vez na tabela
let abertoDetalhe = null; // categoria (string) | null
let abertoFora = null; // categoria (string) | null
let exportAberto = false;

/** `baixar(rota)`: molde de `api()`, mas lê o corpo como blob e dispara o download (F3). */
async function baixar(rota) {
  const cabecalhos = {};
  const token = tokenAgora();
  if (token) cabecalhos.authorization = `Bearer ${token}`;
  const resposta = await fetch(rota, { headers: cabecalhos });
  if (resposta.status === 401) { const erro = new Error(tr('sem token')); erro.semToken = true; throw erro; }
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  const disposicao = resposta.headers.get('content-disposition') || '';
  const casado = /filename="([^"]+)"/.exec(disposicao);
  const nome = casado ? casado[1] : 'financas.bin';
  const blob = await resposta.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Fuso do APARELHO (#35) — nunca o do servidor.
function fmtHora(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(idiomaUI.idioma, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return '';
  }
}

function dinheiroOuNaoSei(v) {
  const t = dinheiro(v, idiomaUI.idioma);
  return t === null ? tr('não sei') : t;
}

function dinheiroInteiro(v) {
  try { return `R$ ${Math.round(v).toLocaleString(idiomaUI.idioma === 'en' ? 'en-US' : 'pt-BR')}`; } catch { return `R$ ${Math.round(v)}`; }
}

function fmtPct(pct) {
  try { return new Intl.NumberFormat(idiomaUI.idioma, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(pct); }
  catch { return pct.toFixed(1); }
}

/** `coresPorCategoria`: a MESMA paleta/ordem no empilhado, na tabela e no mês em detalhe. */
function coresPorCategoria(categoriasOrdenadas) {
  const mapa = new Map();
  categoriasOrdenadas.forEach((cat, i) => { if (i < CORES_CATEGORIA.length) mapa.set(cat, `var(${CORES_CATEGORIA[i]})`); });
  return mapa;
}

function elNS(tag, attrs = {}) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function pessoasDaCasa() { return (dados && dados.pessoas) || []; }
function nomesPessoas() {
  const m = {};
  for (const p of pessoasDaCasa()) m[p.id] = p.nome;
  return m;
}
function faltandoNaCasa() {
  return pessoasDaCasa().filter((p) => !lancsPorPessoa[p.id] || lancsPorPessoa[p.id].estado !== 'ok').map((p) => p.nome);
}
function visaoAtual() {
  if (!dados) return null;
  if (visaoId === 'casa') return dados.casa;
  return pessoasDaCasa().find((p) => p.id === visaoId) || null;
}
/** Lançamentos da visão atual: `{ ok: true, lancamentos }` ou `{ ok: false, faltando: [nomes] }`. */
function lancsDaVisao() {
  if (visaoId === 'casa') {
    const faltando = faltandoNaCasa();
    if (faltando.length) return { ok: false, faltando };
    const porPessoa = {};
    for (const p of pessoasDaCasa()) porPessoa[p.id] = lancsPorPessoa[p.id].lancamentos;
    return { ok: true, lancamentos: juntarLancamentos(porPessoa, nomesPessoas()) };
  }
  const info = lancsPorPessoa[visaoId];
  if (!info || info.estado !== 'ok') {
    const pessoa = pessoasDaCasa().find((p) => p.id === visaoId);
    return { ok: false, faltando: [pessoa ? pessoa.nome : visaoId] };
  }
  return { ok: true, lancamentos: info.lancamentos };
}
function mensagemFaltando(resLancs) { return tr('faltam os lançamentos de {0}', (resLancs.faltando || []).join(', ')); }
function mesPadrao(periodoMeses, ultimoCompleto) {
  if (ultimoCompleto && periodoMeses.includes(ultimoCompleto)) return ultimoCompleto;
  return periodoMeses.length ? periodoMeses[periodoMeses.length - 1] : null;
}

function elLancamento(l, mostrarPessoa) {
  const div = el('div', 'fin-lanc');
  div.append(el('span', 'fin-data', diaMes(l.data) || ''));
  const desc = el('span', 'fin-desc');
  desc.append(document.createTextNode(l.descricao || ''));
  if (mostrarPessoa && l.pessoa) desc.append(el('span', 'fin-chip', l.pessoa));
  const valor = el('span', l.tipo === 'credito' ? 'fin-valor fin-cred' : 'fin-valor',
    `${l.tipo === 'credito' ? '− ' : ''}${dinheiroOuNaoSei(l.valor)}`);
  div.append(desc, valor);
  return div;
}

function legendaItem(cor, texto) {
  const span = el('span');
  const i = el('i');
  i.style.background = cor;
  span.append(i, document.createTextNode(texto));
  return span;
}

// ─── Topo e avisos ──────────────────────────────────────────────────────────────────────────

function desenharTopo() {
  visoesEl.replaceChildren();
  for (const v of visoes(dados, tr)) {
    const b = el('button', null, v.rotulo);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(v.id === visaoId));
    b.onclick = () => {
      visaoId = v.id; mesSel = null; abertoTabela = null; abertoDetalhe = null; abertoFora = null;
      desenhar();
    };
    visoesEl.append(b);
  }
  const visao = visaoAtual();
  carimboEl.textContent = visao ? `${tr('dados até {0}', diaMes(visao.dadosAte) || tr('não sei'))} · ${textoGerado(visao, fmtHora, tr)}` : '';
}

function mostrarAvisos(linhas) {
  avisosEl.replaceChildren();
  if (!linhas.length) { avisosEl.hidden = true; return; }
  avisosEl.hidden = false;
  for (const l of linhas) avisosEl.append(el('p', null, l));
}

function desenharAvisosCompletos(visao, resLancs) {
  const linhas = [];
  if (visao.desatualizado) {
    if (visao.geradoHaS === null) linhas.push(tr('não sei quando este resumo foi gerado'));
    else linhas.push(tr('resumo gerado há {0} h — o gerador pode ter parado', Math.floor(visao.geradoHaS / 3600)));
  }
  if (dados.ilegiveis && dados.ilegiveis.length) linhas.push(tr('não consegui ler o resumo de: {0}', dados.ilegiveis.join(', ')));
  if (dados.casaIndisponivel) linhas.push(tr('a visão casa precisa de todos os resumos legíveis'));
  for (const a of visao.avisos || []) linhas.push(a); // texto do GERADOR — nunca por tr()
  if (!resLancs.ok) linhas.push(mensagemFaltando(resLancs));
  for (const p of pessoasDaCasa()) {
    const info = lancsPorPessoa[p.id];
    if (!info) continue;
    if (info.estado === 'ausente') linhas.push(tr('{0}: sem arquivo de lançamentos ainda', p.nome));
    else if (info.estado === 'ilegivel') linhas.push(tr('{0}: não consegui ler os lançamentos', p.nome));
    else if (info.estado === 'ok' && info.descartados > 0) linhas.push(tr('{0}: {1} lançamentos ignorados (formato inválido)', p.nome, info.descartados));
  }
  if (resLancs.ok) {
    for (const d of divergencias(visao.meses, resLancs.lancamentos)) {
      const infoMes = visao.meses.find((m) => m.mes === d.mes);
      linhas.push(tr('os lançamentos não batem com o resumo em {0} (diferença {1})', infoMes ? infoMes.rotulo : d.mes, dinheiroOuNaoSei(d.diferenca)));
    }
  }
  mostrarAvisos(linhas);
}

// ─── KPIs (P13) ─────────────────────────────────────────────────────────────────────────────

function kpiCard(rotulo, valorTexto, notaTexto) {
  const n = el('div', 'fin-kpi');
  n.append(el('span', null, rotulo), el('b', null, valorTexto));
  if (notaTexto) n.append(el('small', null, notaTexto));
  return n;
}
function textoVariacaoPct(v) {
  const sinal = v.pct >= 0 ? '+' : '−';
  return `${sinal}${Math.round(Math.abs(v.pct))} %`;
}
/** `.fin-sobe` é SEMPRE a cor de perigo e `.fin-desce` SEMPRE a de ok (CSS); o que muda por
 * `tipo` é qual delas combina com "subiu": gasto subir é ruim (fin-sobe), renda subir é bom
 * (fin-desce) — P13. */
function classeVariacao(v, tipo) {
  if (!v) return null;
  const aumentou = v.pct > 0;
  if (tipo === 'gasto') return aumentou ? 'fin-sobe' : 'fin-desce';
  return aumentou ? 'fin-desce' : 'fin-sobe';
}
function kpiCardVariacao(rotulo, valor, v, tipo, rotuloAnterior) {
  const n = el('div', 'fin-kpi');
  n.append(el('span', null, rotulo), el('b', null, dinheiroOuNaoSei(valor)));
  if (v && rotuloAnterior) n.append(el('small', classeVariacao(v, tipo), tr('{0} vs {1}', textoVariacaoPct(v), rotuloAnterior)));
  return n;
}
function kpiCardSobrou(rotulo, valor) {
  const n = el('div', 'fin-kpi');
  n.append(el('span', null, rotulo));
  n.append(el('b', typeof valor === 'number' ? (valor >= 0 ? 'fin-bom' : 'fin-ruim') : null, dinheiroOuNaoSei(valor)));
  return n;
}

function desenharKpis(corpo, visao) {
  corpo.replaceChildren();
  const nContas = (visao.saldo && visao.saldo.contas && visao.saldo.contas.length) || 0;
  corpo.append(kpiCard(tr('Saldo hoje'), dinheiroOuNaoSei(visao.saldo && visao.saldo.total), tr('{0} conta(s)', nContas)));
  const mes = mesDoKpi(visao);
  if (!mes) {
    corpo.append(kpiCard(tr('sem mês completo ainda'), tr('não sei')));
    corpo.append(kpiCard(tr('sem mês completo ainda'), tr('não sei')));
    corpo.append(kpiCard(tr('sem mês completo ainda'), tr('não sei')));
    return;
  }
  const idx = (visao.meses || []).findIndex((m) => m.mes === mes.mes);
  const anterior = idx > 0 ? visao.meses[idx - 1] : null;
  corpo.append(kpiCardVariacao(tr('Renda de {0}', mes.rotulo), mes.renda, variacao(mes.renda, anterior ? anterior.renda : null), 'renda', anterior ? anterior.rotulo : null));
  corpo.append(kpiCardVariacao(tr('Gasto de {0}', mes.rotulo), mes.gasto, variacao(mes.gasto, anterior ? anterior.gasto : null), 'gasto', anterior ? anterior.rotulo : null));
  const sobrou = (typeof mes.renda === 'number' && typeof mes.gasto === 'number') ? mes.renda - mes.gasto : null;
  corpo.append(kpiCardSobrou(tr('Sobrou em {0}', mes.rotulo), sobrou));
}

// ─── Renda × gasto / Empilhado (SVG) ───────────────────────────────────────────────────────

function eixoValores(svg, maior, y) {
  const passo = maior > 20000 ? 5000 : 2500;
  for (let v = 0; v <= maior; v += passo) {
    svg.append(elNS('line', { x1: 58, x2: 560, y1: y(v), y2: y(v), stroke: 'var(--borda)' }));
    const texto = elNS('text', { x: 52, y: y(v) + 4, 'font-size': 10, 'text-anchor': 'end', fill: 'var(--texto-3)' });
    texto.textContent = dinheiroInteiro(v);
    svg.append(texto);
  }
}

function desenharRendaGasto(corpo, visao, periodoMeses) {
  corpo.replaceChildren();
  const mesesObjs = periodoMeses.map((mes) => visao.meses.find((m) => m.mes === mes)).filter(Boolean);
  const W = 560, H = 230, L = 58, B = 28, T = 12;
  // Valor desconhecido continua "não sei": sem barra e com "?" no pé, nunca R$ 0 (painel de execução, Codex #2).
  const numOuNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const valores = mesesObjs.map((m) => ({ r: numOuNull(m.renda), g: numOuNull(m.gasto), m }));
  const maior = Math.max(1, ...valores.flatMap((v) => [v.r, v.g]).filter((x) => x !== null)) * 1.12;
  const y = (v) => T + (H - T - B) * (1 - v / maior);
  const larg = (W - L - 10) / Math.max(1, valores.length);
  const bw = Math.min(34, larg / 3);
  const svg = elNS('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': tr('Renda e gasto por mês') });
  eixoValores(svg, maior, y);
  valores.forEach((v, i) => {
    const cx = L + larg * (i + 0.5);
    const barraR = elNS('rect', { x: cx - bw - 2, y: y(v.r || 0), width: bw, height: Math.max(H - B - y(v.r || 0), 0), rx: 3, fill: 'var(--ok)' });
    const barraG = elNS('rect', { x: cx + 2, y: y(v.g || 0), width: bw, height: Math.max(H - B - y(v.g || 0), 0), rx: 3, fill: 'var(--perigo)' });
    for (const [valor, x] of [[v.r, cx - bw / 2 - 2], [v.g, cx + bw / 2 + 2]]) {
      if (valor !== null) continue;
      const naoSei = elNS('text', { x, y: H - B - 4, 'font-size': 11, 'text-anchor': 'middle', fill: 'var(--texto-3)' });
      naoSei.textContent = '?';
      svg.append(naoSei);
    }
    if (v.m.parcial === true) {
      barraR.setAttribute('fill-opacity', '0.45'); barraR.setAttribute('stroke', 'var(--ok)'); barraR.setAttribute('stroke-dasharray', '3 2');
      barraG.setAttribute('fill-opacity', '0.45'); barraG.setAttribute('stroke', 'var(--perigo)'); barraG.setAttribute('stroke-dasharray', '3 2');
    }
    const tituloR = document.createElementNS('http://www.w3.org/2000/svg', 'title'); tituloR.textContent = `${v.m.rotulo}: ${tr('renda {0}', dinheiroOuNaoSei(v.r))}`;
    barraR.append(tituloR);
    const tituloG = document.createElementNS('http://www.w3.org/2000/svg', 'title'); tituloG.textContent = `${v.m.rotulo}: ${tr('gasto {0}', dinheiroOuNaoSei(v.g))}`;
    barraG.append(tituloG);
    svg.append(barraR, barraG);
    const rotulo = elNS('text', { x: cx, y: H - 9, 'font-size': 11, 'text-anchor': 'middle', fill: 'var(--texto-2)' });
    rotulo.textContent = v.m.rotulo + (v.m.parcial === true ? '*' : '');
    svg.append(rotulo);
  });
  corpo.append(svg);
  const legenda = el('div', 'fin-legenda');
  legenda.append(legendaItem('var(--ok)', tr('renda')), legendaItem('var(--perigo)', tr('gasto')));
  const itemParcial = el('span');
  const iParcial = el('i');
  iParcial.style.background = 'transparent'; iParcial.style.border = '1px dashed var(--texto-3)';
  itemParcial.append(iParcial, document.createTextNode(tr('mês parcial')));
  legenda.append(itemParcial);
  corpo.append(legenda);
}

function desenharEmpilhado(corpo, resLancs, periodoMeses, visao) {
  corpo.replaceChildren();
  if (!resLancs.ok) { corpo.append(el('p', null, mensagemFaltando(resLancs))); return; }
  const lancs = resLancs.lancamentos;
  const categoriasOrdenadas = categoriasDoPeriodo(lancs, periodoMeses);
  const top7 = categoriasOrdenadas.slice(0, 7);
  const outras = categoriasOrdenadas.slice(7);
  const W = 560, H = 230, L = 58, B = 28, T = 12;
  const totaisPorMes = periodoMeses.map((mes) => {
    let total = 0;
    for (const v of gastoPorCategoria(lancs, mes).values()) if (v > 0) total += v;
    return total;
  });
  const maior = Math.max(1, ...totaisPorMes) * 1.1;
  const y = (v) => T + (H - T - B) * (1 - v / maior);
  const larg = (W - L - 10) / Math.max(1, periodoMeses.length);
  const bw = Math.min(56, larg * 0.55);
  const svg = elNS('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': tr('Gasto por categoria') });
  eixoValores(svg, maior, y);
  periodoMeses.forEach((mes, i) => {
    const cx = L + larg * (i + 0.5);
    const porCat = gastoPorCategoria(lancs, mes);
    let acc = 0;
    top7.forEach((cat, k) => {
      const v = Math.max(porCat.get(cat) || 0, 0);
      const y1 = y(acc + v); const y0 = y(acc); acc += v;
      const rect = elNS('rect', { x: cx - bw / 2, y: y1, width: bw, height: Math.max(y0 - y1 - 1, 0), fill: `var(${CORES_CATEGORIA[k]})` });
      const titulo = document.createElementNS('http://www.w3.org/2000/svg', 'title'); titulo.textContent = `${mes} · ${cat}: ${dinheiroOuNaoSei(v)}`;
      rect.append(titulo);
      svg.append(rect);
    });
    let outrasV = 0;
    for (const cat of outras) outrasV += Math.max(porCat.get(cat) || 0, 0);
    if (outrasV > 0) {
      const y1 = y(acc + outrasV); const y0 = y(acc);
      const rect = elNS('rect', { x: cx - bw / 2, y: y1, width: bw, height: Math.max(y0 - y1 - 1, 0), fill: 'var(--fin-cz)' });
      const titulo = document.createElementNS('http://www.w3.org/2000/svg', 'title'); titulo.textContent = `${mes} · ${tr('Outras')}: ${dinheiroOuNaoSei(outrasV)}`;
      rect.append(titulo);
      svg.append(rect);
    }
    const infoMes = visao.meses.find((m) => m.mes === mes);
    const rotulo = elNS('text', { x: cx, y: H - 9, 'font-size': 11, 'text-anchor': 'middle', fill: 'var(--texto-2)' });
    rotulo.textContent = (infoMes ? infoMes.rotulo : mes) + (infoMes && infoMes.parcial === true ? '*' : '');
    svg.append(rotulo);
  });
  corpo.append(svg);
  const legenda = el('div', 'fin-legenda');
  top7.forEach((cat, k) => legenda.append(legendaItem(`var(${CORES_CATEGORIA[k]})`, cat)));
  if (outras.length) legenda.append(legendaItem('var(--fin-cz)', tr('Outras')));
  corpo.append(legenda);
}

// ─── Mês em detalhe ─────────────────────────────────────────────────────────────────────────

function desenharDetalhe(corpo, resLancs, periodoMeses, visao) {
  corpo.replaceChildren();
  if (!resLancs.ok) { corpo.append(el('p', null, mensagemFaltando(resLancs))); return; }
  const lancs = resLancs.lancamentos;
  const chips = el('div', 'fin-chips');
  for (const mes of periodoMeses) {
    const info = visao.meses.find((m) => m.mes === mes);
    const b = el('button', null, (info ? info.rotulo : mes) + (info && info.parcial === true ? '*' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(mes === mesSel));
    b.onclick = () => { mesSel = mes; abertoDetalhe = null; redesenharDerivados(); };
    chips.append(b);
  }
  corpo.append(chips);

  if (!mesSel) { corpo.append(el('p', null, tr('nenhum mês no resumo'))); return; }
  const gastoDoMes = [...gastoPorCategoria(lancs, mesSel).values()].reduce((s, v) => s + v, 0);
  const infoMes = visao.meses.find((m) => m.mes === mesSel);
  const rotuloMes = (infoMes ? infoMes.rotulo : mesSel) + (infoMes && infoMes.parcial === true ? ` (${tr('parcial')})` : '');
  const resumoP = el('p', 'fin-resumo-mes');
  resumoP.append(document.createTextNode(`${tr('Gasto de {0}:', rotuloMes)} `), el('strong', null, dinheiroOuNaoSei(gastoDoMes)));
  corpo.append(resumoP);

  const porCat = gastoPorCategoria(lancs, mesSel);
  // Categoria com estorno líquido (valor < 0) também aparece — ela entra no total do mês; só não
  // ganha barra nem % (painel de execução, Codex #4). Só o empilhado a omite (spec F2).
  const categoriasOrdenadas = [...porCat.entries()].filter(([, v]) => Math.abs(v) >= 0.005).sort((a, b) => b[1] - a[1]);
  const maiorValor = categoriasOrdenadas.length ? categoriasOrdenadas[0][1] : 0;
  const cores = coresPorCategoria(categoriasDoPeriodo(lancs, periodoMeses));
  for (const [cat, valor] of categoriasOrdenadas) {
    const linha = el('button', 'fin-cat');
    linha.type = 'button';
    linha.setAttribute('aria-expanded', String(abertoDetalhe === cat));
    const nome = el('span', 'fin-cat-nome');
    const bolinha = el('i'); bolinha.style.background = cores.get(cat) || 'var(--fin-cz)';
    nome.append(bolinha, document.createTextNode(cat));
    const trilho = el('span', 'fin-trilho');
    const barra = el('i');
    barra.style.width = `${maiorValor > 0 && valor > 0 ? (valor / maiorValor) * 100 : 0}%`;
    barra.style.background = cores.get(cat) || 'var(--fin-cz)';
    trilho.append(barra);
    const pct = pctDoMes(valor, gastoDoMes);
    const pctEl = el('span', 'fin-pct', pct === null || valor < 0 ? '—' : `${fmtPct(pct)}%`);
    const valorEl = el('span', null, dinheiroOuNaoSei(valor));
    const seta = el('span', 'fin-seta', '›');
    linha.append(nome, trilho, pctEl, valorEl, seta);
    linha.onclick = () => { abertoDetalhe = abertoDetalhe === cat ? null : cat; redesenharDerivados(); };
    corpo.append(linha);

    const listaDiv = el('div', 'fin-lista');
    listaDiv.hidden = abertoDetalhe !== cat;
    if (abertoDetalhe === cat) listaDiv.append(...lancamentosDe(lancs, mesSel, cat).map((l) => elLancamento(l, visaoId === 'casa')));
    corpo.append(listaDiv);
  }
}

// ─── Tabela mês a mês ───────────────────────────────────────────────────────────────────────

function linhaAberta(mes, cat, lancs, colspan, visao) {
  const tr1 = document.createElement('tr');
  tr1.className = 'fin-abre';
  const td = document.createElement('td');
  td.colSpan = colspan;
  const listaDiv = el('div', 'fin-lista');
  const linhas = lancamentosDe(lancs, mes, cat);
  const total = linhas.reduce((s, l) => s + (l.tipo === 'debito' ? 1 : -1) * l.valor, 0);
  const infoMes = visao.meses.find((m) => m.mes === mes);
  const h3 = el('h3');
  h3.append(el('span', null, `${cat} · ${infoMes ? infoMes.rotulo : mes} — ${tr('{0} lançamentos', linhas.length)} · ${dinheiroOuNaoSei(total)}`));
  listaDiv.append(h3, ...linhas.map((l) => elLancamento(l, visaoId === 'casa')));
  td.append(listaDiv);
  tr1.append(td);
  return tr1;
}

function desenharTabela(corpo, resLancs, periodoMeses, visao) {
  corpo.replaceChildren();
  if (!resLancs.ok) { corpo.append(el('p', null, mensagemFaltando(resLancs))); return; }
  const lancs = resLancs.lancamentos;
  const categorias = categoriasDoPeriodo(lancs, periodoMeses);
  const cores = coresPorCategoria(categorias);
  const rolagem = el('div', 'fin-rolagem');
  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const trCab = document.createElement('tr');
  trCab.append(el('th', null, tr('Categoria')));
  for (const mes of periodoMeses) {
    const info = visao.meses.find((m) => m.mes === mes);
    trCab.append(el('th', 'fin-mes', (info ? info.rotulo : mes) + (info && info.parcial === true ? '*' : '')));
  }
  trCab.append(el('th', null, tr('Total')));
  thead.append(trCab);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const cat of categorias) {
    const linha = document.createElement('tr');
    const nomeCel = document.createElement('td');
    const nomeSpan = el('span', 'fin-cat-nome');
    const bolinha = el('i'); bolinha.style.background = cores.get(cat) || 'var(--fin-cz)';
    nomeSpan.append(bolinha, document.createTextNode(cat));
    nomeCel.append(nomeSpan);
    linha.append(nomeCel);
    let total = 0;
    for (const mes of periodoMeses) {
      const td = document.createElement('td');
      const temLancamento = lancs.some((l) => l.mes === mes);
      const valor = gastoPorCategoria(lancs, mes).get(cat);
      if (!temLancamento || valor === undefined) {
        td.append(document.createTextNode('—'));
      } else {
        total += valor;
        const btn = el('button', 'fin-celula', dinheiroOuNaoSei(valor));
        btn.type = 'button';
        btn.dataset.mes = mes; btn.dataset.cat = cat;
        btn.setAttribute('aria-expanded', String(Boolean(abertoTabela) && abertoTabela.mes === mes && abertoTabela.cat === cat));
        td.append(btn);
      }
      linha.append(td);
    }
    linha.append(el('td', null, dinheiroOuNaoSei(total)));
    tbody.append(linha);
    if (abertoTabela && abertoTabela.cat === cat && periodoMeses.includes(abertoTabela.mes)) {
      tbody.append(linhaAberta(abertoTabela.mes, cat, lancs, periodoMeses.length + 2, visao));
    }
  }
  const trTotal = document.createElement('tr');
  trTotal.className = 'fin-total';
  trTotal.append(el('td', null, tr('Total gasto')));
  let totalGeral = 0;
  for (const mes of periodoMeses) {
    const totalMes = [...gastoPorCategoria(lancs, mes).values()].reduce((s, v) => s + v, 0);
    totalGeral += totalMes;
    trTotal.append(el('td', null, dinheiroOuNaoSei(totalMes)));
  }
  trTotal.append(el('td', null, dinheiroOuNaoSei(totalGeral)));
  tbody.append(trTotal);
  table.append(tbody);
  rolagem.append(table);
  corpo.append(rolagem);

  // P4: a lista aberta recebe a LARGURA DO CONTÊINER (não da tabela) — só dá pra medir depois
  // de anexada na página.
  if (abertoTabela) {
    const listaAberta = rolagem.querySelector('.fin-abre .fin-lista');
    if (listaAberta) listaAberta.style.width = `${rolagem.clientWidth}px`;
  }

  rolagem.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.fin-celula');
    if (!btn) return;
    const mesmaCelula = abertoTabela && abertoTabela.mes === btn.dataset.mes && abertoTabela.cat === btn.dataset.cat;
    abertoTabela = mesmaCelula ? null : { mes: btn.dataset.mes, cat: btn.dataset.cat };
    // O redesenho troca a `.fin-rolagem` inteira: sem devolver a rolagem e o foco, a tabela
    // rolada de lado no celular voltava pro primeiro mês a cada toque (medido no print, cena 3).
    const rolagemX = rolagem.scrollLeft;
    const { mes, cat } = btn.dataset;
    desenharTabela(corpo, resLancs, periodoMeses, visao);
    const nova = corpo.querySelector('.fin-rolagem');
    if (nova) nova.scrollLeft = rolagemX;
    const mesmoBotao = [...corpo.querySelectorAll('.fin-celula')].find((b) => b.dataset.mes === mes && b.dataset.cat === cat);
    if (mesmoBotao) mesmoBotao.focus({ preventScroll: true });
  });
}

// ─── Maiores gastos / Fora do gasto ────────────────────────────────────────────────────────

function desenharMaiores(corpo, resLancs, mes) {
  corpo.replaceChildren();
  if (!resLancs.ok) { corpo.append(el('p', null, mensagemFaltando(resLancs))); return; }
  const top = maioresGastos(resLancs.lancamentos, mes, 6);
  const maior = top.length ? top[0].total : 0;
  for (const item of top) {
    const linha = el('div');
    const cab = el('div');
    cab.style.display = 'flex'; cab.style.justifyContent = 'space-between';
    cab.append(el('span', null, item.nome), el('span', null, dinheiroOuNaoSei(item.total)));
    const barra = el('div', 'fin-barrinha');
    const i = el('i'); i.style.width = `${maior > 0 ? (item.total / maior) * 100 : 0}%`;
    barra.append(i);
    linha.append(cab, barra);
    corpo.append(linha);
  }
}

function desenharFora(corpo, resLancs, mes, visao) {
  corpo.replaceChildren();
  if (!resLancs.ok) {
    corpo.append(el('p', null, mensagemFaltando(resLancs)));
    const infoMes = visao && (visao.meses || []).find((m) => m.mes === mes);
    if (infoMes && typeof infoMes.faturaCartao === 'number') {
      corpo.append(el('p', null, tr('Fatura do cartão em {0}: {1}', infoMes.rotulo, dinheiroOuNaoSei(infoMes.faturaCartao))));
    }
    return;
  }
  const lancs = resLancs.lancamentos;
  for (const [cat, total] of foraDoGasto(lancs, mes)) {
    const linha = el('button', 'fin-linha');
    linha.type = 'button';
    linha.setAttribute('aria-expanded', String(abertoFora === cat));
    linha.append(el('span', null, cat), el('span', null, dinheiroOuNaoSei(total)), el('span', 'fin-seta', '›'));
    linha.onclick = () => { abertoFora = abertoFora === cat ? null : cat; redesenharDerivados(); };
    corpo.append(linha);
    const listaDiv = el('div', 'fin-lista');
    listaDiv.hidden = abertoFora !== cat;
    if (abertoFora === cat) {
      const linhas = lancs.filter((l) => l.mes === mes && l.fora && l.categoria === cat);
      listaDiv.append(...linhas.map((l) => elLancamento(l, visaoId === 'casa')));
    }
    corpo.append(listaDiv);
  }
  corpo.append(el('p', null, tr('não entra no gasto')));
}

// ─── Contas / Reembolsos — classes .fin-* próprias (nunca as .financas-* do modal) ────────

function desenharContas(corpo, visao) {
  corpo.replaceChildren();
  const contas = (visao.saldo && visao.saldo.contas) || [];
  if (!contas.length) { corpo.append(el('p', null, tr('não sei'))); return; }
  for (const c of contas) {
    const linha = el('div', 'fin-conta');
    const nome = el('span');
    nome.append(document.createTextNode(c.pessoa ? `${c.nome} (${c.pessoa})` : c.nome));
    if (c.conectada === false) nome.append(el('span', 'fin-chip', tr('não conectada')));
    linha.append(nome, el('span', null, dinheiroOuNaoSei(c.saldo)));
    corpo.append(linha);
  }
}

function desenharReembolsos(corpo, visao) {
  corpo.replaceChildren();
  if (!visao.reembolsos) { corpo.append(el('p', null, tr('não sei'))); return; }
  for (const it of visao.reembolsos.itens || []) {
    const linha = el('div', 'fin-conta');
    const esquerda = el('span');
    esquerda.append(document.createTextNode(`${diaMes(it.data) || tr('não sei')} · ${it.descricao || ''}`));
    if (it.atrasado === true) {
      const marca = el('span', 'fin-chip', tr('atrasado'));
      marca.dataset.tom = 'atrasado';
      esquerda.append(marca);
    }
    linha.append(esquerda, el('span', null, dinheiroOuNaoSei(it.valor)));
    corpo.append(linha);
  }
  const total = el('div', 'fin-reembolso-total');
  total.append(el('span', null, tr('Falta receber')), el('span', null, dinheiroOuNaoSei(visao.reembolsos.pendente)));
  corpo.append(total);
}

// ─── Exportar ▾ (F3) ────────────────────────────────────────────────────────────────────────

function montarDestinos() {
  // Redesenhar (trocar visão/período) recria os rádios: guarda a escolha e devolve, senão nenhum
  // rádio ficava marcado e o Exportar morria calado (painel de execução, Claude #2 e Codex #3).
  const marcado = destinosFieldset.querySelector('input[name="fin-destino"]:checked');
  const escolhido = marcado ? marcado.value : 'baixar';
  for (const label of [...destinosFieldset.querySelectorAll('label')].slice(1)) label.remove();
  for (const destino of (dados && dados.destinos) || []) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'fin-destino'; input.value = destino;
    label.append(input, document.createTextNode(` ${tr('Enviar para {0} (Taildrop)', destino)}`));
    destinosFieldset.append(label);
  }
  const volta = [...destinosFieldset.querySelectorAll('input[name="fin-destino"]')].find((r) => r.value === escolhido)
    || destinosFieldset.querySelector('input[name="fin-destino"][value="baixar"]');
  if (volta) volta.checked = true;
}

function alternarExportar(abrir) {
  exportAberto = abrir;
  menuExportarEl.hidden = !abrir;
  btnExportarEl.setAttribute('aria-expanded', String(abrir));
  if (abrir) statusExportarEl.textContent = '';
}

async function exportarIr() {
  const formatoEl = document.querySelector('input[name="fin-formato"]:checked');
  const destinoEl = document.querySelector('input[name="fin-destino"]:checked');
  const formato = formatoEl ? formatoEl.value : 'pdf';
  const destino = destinoEl ? destinoEl.value : 'baixar';
  const alvoIds = visaoId === 'casa' ? pessoasDaCasa().map((p) => p.id) : [visaoId];
  const linhasStatus = [];
  statusExportarEl.textContent = tr('exportando…');
  for (const id of alvoIds) {
    const pessoa = pessoasDaCasa().find((p) => p.id === id);
    const nome = (pessoa && pessoa.nome) || id;
    const rotuloFormato = formato === 'pdf' ? tr('PDF') : tr('Excel');
    if (!pessoa || !pessoa.arquivos || !pessoa.arquivos[formato]) {
      linhasStatus.push(tr('{0}: não tem {1} na pasta', nome, rotuloFormato));
      statusExportarEl.textContent = linhasStatus.join(' · ');
      continue;
    }
    try {
      if (destino === 'baixar') {
        await baixar(`api/financas/arquivo?pessoa=${encodeURIComponent(id)}&formato=${formato}`);
        linhasStatus.push(tr('✓ {0}: {1} baixado', nome, rotuloFormato));
      } else {
        await api('api/financas/enviar', { pessoa: id, formato, destino });
        linhasStatus.push(tr('✓ {0}: {1} enviado para {2}', nome, rotuloFormato, destino));
      }
    } catch (e) {
      linhasStatus.push(`${nome}: ${e && e.semToken ? tr('sem token') : ((e && e.message) || tr('não consegui exportar'))}`);
    }
    statusExportarEl.textContent = linhasStatus.join(' · ');
  }
}

btnExportarEl.onclick = () => alternarExportar(!exportAberto);
$('fin-exportar-ir').onclick = () => { exportarIr(); };
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && exportAberto) alternarExportar(false); });
document.addEventListener('click', (ev) => {
  if (!exportAberto) return;
  if (btnExportarEl.contains(ev.target) || menuExportarEl.contains(ev.target)) return;
  alternarExportar(false);
});

// ─── Orquestração ───────────────────────────────────────────────────────────────────────────

function redesenharDerivados() {
  const visao = visaoAtual();
  if (!visao) return;
  const periodoMeses = mesesDoPeriodo((visao.meses || []).map((m) => m.mes), periodo);
  const resLancs = lancsDaVisao();
  desenharEmpilhado(corpoEmpilhado, resLancs, periodoMeses, visao);
  desenharDetalhe(corpoDetalhe, resLancs, periodoMeses, visao);
  desenharTabela(corpoTabela, resLancs, periodoMeses, visao);
  desenharMaiores(corpoMaiores, resLancs, mesSel);
  desenharFora(corpoFora, resLancs, mesSel, visao);
}

function desenhar() {
  if (erroGeral) {
    visoesEl.replaceChildren();
    carimboEl.textContent = '';
    mostrarAvisos([erroGeral]);
    for (const secao of TODAS_SECOES) secao.hidden = true;
    return;
  }
  for (const secao of TODAS_SECOES) secao.hidden = false;
  desenharTopo();
  const visao = visaoAtual();
  if (!visao) { for (const s of TODAS_SECOES) s.hidden = true; mostrarAvisos([tr('não consegui ler a pasta dos resumos')]); return; }

  const periodoMeses = mesesDoPeriodo((visao.meses || []).map((m) => m.mes), periodo);
  if (!mesSel || !periodoMeses.includes(mesSel)) mesSel = mesPadrao(periodoMeses, visao.ultimoCompleto);
  const resLancs = lancsDaVisao();

  desenharAvisosCompletos(visao, resLancs);
  desenharKpis(corpoKpis, visao);
  desenharRendaGasto(corpoRendaGasto, visao, periodoMeses);
  desenharContas(corpoContas, visao);
  desenharReembolsos(corpoReembolsos, visao);
  desenharEmpilhado(corpoEmpilhado, resLancs, periodoMeses, visao);
  desenharDetalhe(corpoDetalhe, resLancs, periodoMeses, visao);
  desenharTabela(corpoTabela, resLancs, periodoMeses, visao);
  desenharMaiores(corpoMaiores, resLancs, mesSel);
  desenharFora(corpoFora, resLancs, mesSel, visao);
  montarDestinos();
}

periodoEl.onchange = () => { periodo = Number(periodoEl.value) || 3; desenhar(); };

async function carregar() {
  erroGeral = null;
  try {
    dados = await api('api/financas');
  } catch (e) {
    dados = null;
    erroGeral = e && e.semToken ? tr('sem token — abra o Cockpit neste navegador e entre com o token') : ((e && e.message) || tr('não consegui ler a pasta dos resumos'));
    desenhar();
    return;
  }
  if (!dados.ligado) { erroGeral = tr('Finanças está desligado neste servidor'); desenhar(); return; }
  if (dados.erro === 'pasta') { erroGeral = tr('não consegui ler a pasta dos resumos'); desenhar(); return; }
  if (!dados.pessoas || !dados.pessoas.length) {
    erroGeral = (dados.ilegiveis && dados.ilegiveis.length)
      ? tr('não consegui ler o resumo de: {0}', dados.ilegiveis.join(', '))
      : tr('não consegui ler a pasta dos resumos');
    desenhar();
    return;
  }
  await Promise.all(dados.pessoas.map(async (p) => {
    try { lancsPorPessoa[p.id] = await api(`api/financas/lancamentos?pessoa=${encodeURIComponent(p.id)}`); }
    catch { lancsPorPessoa[p.id] = { estado: 'ilegivel', motivo: 'rede' }; }
  }));
  const listaVisoes = visoes(dados, tr);
  if (!visaoId || !listaVisoes.some((v) => v.id === visaoId)) visaoId = visaoInicial(listaVisoes);
  desenhar();
}

carregar();

} // fim do guard `typeof document !== 'undefined'`

})();
