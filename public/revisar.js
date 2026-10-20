'use strict';
// Tela "Pra revisar" (plano docs/superpowers/plans/2026-10-04-tela-pra-revisar-plano.md).
// Ponto de partida: docs/mockups/fase1-pra-revisar/revisar.js do esteira-jobs (aprovado pelo
// o dono no Lavish, 2026-10-03). Só leitura: não tem botão de ação (D48, Fase 3 é quem revoga).
//
// Regra da casa, pra este arquivo inteiro: NADA de innerHTML — nem para o markdown do
// relatório, que é texto que esta tela não escreveu (armadilha #26, uso.js:9-11).
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

// Token lido A CADA CHAMADA (mesmo motivo de uso.js:20-27): congelar uma vez perderia o
// primeiro acesso por link, antes do localStorage ter o token.
const tokenAgora = () => { try { return localStorage.getItem('cockpit-token') || ''; } catch { return ''; } };

async function api(rota) {
  const cabecalhos = {};
  const token = tokenAgora();
  if (token) cabecalhos.authorization = `Bearer ${token}`;
  const resposta = await fetch(rota, { headers: cabecalhos });
  if (resposta.status === 401) {
    const erro = new Error(tr('sem token'));
    erro.semToken = true;
    throw erro;
  }
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

// ── cor do projeto, por hash do nome (plano: "paleta fixa, por hash do nome") ──
const PALETA_PROJETO = ['#e0a233', '#45c4b0', '#c792ea', '#7aa2f7', '#ff8a65', '#9ece6a', '#f7768e', '#7dcfff'];
function corDoProjeto(nome) {
  const s = String(nome || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETA_PROJETO[h % PALETA_PROJETO.length];
}

/** "há 3 h" / "há 2 d" / "há 4 meses" — a partir de um ISO. '' se ilegível (na dúvida, nada). */
function haTexto(iso) {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 60) return tr('há {0} min', min);
  const horas = Math.floor(min / 60);
  if (horas < 24) return tr('há {0} h', horas);
  const dias = Math.floor(horas / 24);
  if (dias < 30) return tr('há {0} d', dias);
  return tr('há {0} meses', Math.floor(dias / 30));
}

// ── markdown → BLOCOS (pura, testável no Node) ───────────────────────────────────────────
//
// Subconjunto deliberado (plano, Fase D): `##` títulos, parágrafo, listas `-`/`1.` (com
// recuo), tabela `|…|`, e o INLINE (`**negrito**`/`` `código` ``) fica cru no texto de cada
// bloco — quem interpreta o inline é `desenharBlocos`, que já é DOM. O resto (HTML cru de
// propósito, tipo `<script>`) nunca é tratado como marcação: vira só mais um parágrafo de
// TEXTO, porque esta função nunca decide nada por regex de tag.
const RE_SEPARADOR_TABELA = /^:?-+:?$/;

function blocosDoMarkdown(texto) {
  const blocos = [];
  const linhas = String(texto || '').split('\n');
  let i = 0;
  while (i < linhas.length) {
    const l = linhas[i];
    if (!l.trim()) { i += 1; continue; }

    if (/^#{1,6}\s/.test(l)) {
      blocos.push({ tipo: 'titulo', texto: l.replace(/^#+\s*/, '') });
      i += 1;
      continue;
    }

    if (l.trim().startsWith('|')) {
      const linhasTabela = [];
      while (i < linhas.length && linhas[i].trim().startsWith('|')) {
        const celulas = linhas[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!celulas.every((c) => RE_SEPARADOR_TABELA.test(c))) linhasTabela.push(celulas);
        i += 1;
      }
      if (linhasTabela.length) {
        const [cabecalho, ...corpo] = linhasTabela;
        blocos.push({ tipo: 'tabela', cabecalho, linhas: corpo });
      }
      continue;
    }

    if (/^\s*(-|\d+\.)\s/.test(l)) {
      const ordenada = /^\s*\d+\./.test(l);
      const itens = [];
      while (i < linhas.length && /^\s*(-|\d+\.)\s/.test(linhas[i])) {
        itens.push({ texto: linhas[i].replace(/^\s*(-|\d+\.)\s/, ''), sub: /^\s{2,}/.test(linhas[i]) });
        i += 1;
      }
      blocos.push({ tipo: 'lista', ordenada, itens });
      continue;
    }

    blocos.push({ tipo: 'paragrafo', texto: l });
    i += 1;
  }
  return blocos;
}

/** O trecho cru (markdown ainda não quebrado em blocos) de uma seção `## <nome>`. '' se não há. */
function secao(md, nome) {
  const bloco = String(md || '').split(/\n(?=## )/).find((b) => b.startsWith(`## ${nome}`));
  return bloco ? bloco.replace(/^## .*\n/, '') : '';
}

/** A seção `## Pendências para o <dono>` (fallback de relatório sem roteiro): `{ titulo, texto }` ou `null`. */
function pendenciasDe(md) {
  const m = String(md || '').match(/^## (Pendências para o \S+)\s*$/m);
  const texto = m ? secao(md, m[1]) : '';
  return texto ? { titulo: m[1], texto } : null;
}

/**
 * A seção fixa `## Smoke pra o <dono>` que o `/ataca` escreve (Fase 0.2). MESMA função de
 * `~/projetos/esteira-jobs/bin/confere-smoke.js` — mudou uma, muda a outra.
 *
 * `null` = sem a seção. `{ nada: '<motivo>' }` = "Nada a testar à mão". Senão, `[{ faz, onde,
 * deveVer }]` — campo ausente vem como `''` (o passo continua aparecendo).
 */
function blocosDoSmoke(texto) {
  const linhas = String(texto || '').split('\n');
  const ini = linhas.findIndex((l) => /^##\s+Smoke pra o \S+\s*$/.test(l.trim()));
  if (ini < 0) return null;
  const passos = [];
  for (let i = ini + 1; i < linhas.length; i += 1) {
    const l = linhas[i];
    if (/^#{1,2}\s/.test(l.trim())) break;
    const nada = l.match(/^\s*Nada a testar à mão:\s*(.+)$/);
    if (nada && !passos.length) return { nada: nada[1].trim() };
    const item = l.match(/^\d+\.\s+(.+)$/);
    if (item) { passos.push({ faz: item[1].trim(), onde: '', deveVer: '' }); continue; }
    const sub = l.match(/^\s+-\s+(Onde|Deve ver):\s*(.+)$/i);
    if (sub && passos.length) {
      const p = passos[passos.length - 1];
      if (/^onde$/i.test(sub[1])) p.onde = sub[2].trim(); else p.deveVer = sub[2].trim();
    }
  }
  return passos;
}

// ── BLOCOS → DOM, sem innerHTML: só createElement/textContent ────────────────────────────

function inline(pai, texto) {
  const partes = String(texto).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const p of partes) {
    if (!p) continue;
    if (p.startsWith('**') && p.endsWith('**')) pai.append(el('strong', null, p.slice(2, -2)));
    else if (p.startsWith('`') && p.endsWith('`')) pai.append(el('code', null, p.slice(1, -1)));
    else pai.append(document.createTextNode(p));
  }
  return pai;
}

function desenharBlocos(blocos) {
  const raiz = el('div', 'rv-md');
  for (const b of blocos) {
    if (b.tipo === 'titulo') { raiz.append(inline(el('h4'), b.texto)); continue; }
    if (b.tipo === 'paragrafo') { raiz.append(inline(el('p'), b.texto)); continue; }
    if (b.tipo === 'lista') {
      const lista = el(b.ordenada ? 'ol' : 'ul');
      for (const item of b.itens) {
        const li = inline(el('li'), item.texto);
        if (item.sub) li.className = 'sub';
        lista.append(li);
      }
      raiz.append(lista);
      continue;
    }
    if (b.tipo === 'tabela') {
      const t = el('table', 'rv-tabela');
      if (b.cabecalho) {
        const linha = el('tr');
        b.cabecalho.forEach((c) => linha.append(inline(el('th'), c)));
        t.append(linha);
      }
      for (const celulas of b.linhas) {
        const linha = el('tr');
        celulas.forEach((c) => linha.append(inline(el('td'), c)));
        t.append(linha);
      }
      raiz.append(t);
    }
  }
  return raiz;
}

function markdown(texto) { return desenharBlocos(blocosDoMarkdown(texto)); }

function tomDoJob(etiquetas) {
  if (etiquetas.includes('parou-no-limite') || etiquetas.includes('branch-sumiu')) return 'perigo';
  if (etiquetas.includes('sem-base') || etiquetas.includes('nao-sei') || etiquetas.includes('pede-revisao')
    || etiquetas.includes('pede-decisao') || etiquetas.includes('relatorio-ilegivel')) return 'aviso';
  return 'ok';
}

function vereditoDoTexto(md, etiquetas) {
  const primeiroBloco = (String(md || '').split('\n\n')[0] || '').trim();
  const m = primeiroBloco.match(/^(?:\*\*)?(done|blocked|failed|needs-decision)\s*:\s*(?:\*\*(?=\s|$))?\s*/i);
  // Sem prefixo conhecido NÃO é sucesso: o relatório de quem bateu no limite começa com
  // "You've hit your session limit" e não pode sair verde ("Terminou bem").
  let tipo = m ? m[1].toLowerCase() : 'nenhum';
  if (tipo === 'needs-decision') tipo = 'decisao';
  if ((etiquetas || []).includes('pede-decisao')) tipo = 'decisao';
  if ((etiquetas || []).includes('parou-no-limite')) tipo = 'limite';
  let resto = m ? primeiroBloco.slice(m[0].length) : primeiroBloco;
  // "Pede decisão" com o `done:` embaixo é o título certo com a frase errada: a pergunta é a linha
  // `needs-decision:` mais abaixo no relatório (o 1º bloco fica de reserva quando ela não existe).
  if (tipo === 'decisao' && !(m && /^needs-decision$/i.test(m[1]))) {
    const linha = String(md || '').match(/^(?:\*\*)?needs-decision\s*:\s*(?:\*\*(?=\s|$))?\s*(.*)$/im);
    if (linha && linha[1].trim()) resto = linha[1].trim();
  }
  const POR_TIPO = {
    done: ['✓', 'ok', 'Terminou bem'],
    blocked: ['⚠', 'aviso', 'Travou'],
    failed: ['✕', 'perigo', 'Falhou'],
    decisao: ['?', 'aviso', 'Pede decisão'],
    limite: ['✕', 'perigo', 'Parou no limite'],
    nenhum: ['?', 'aviso', 'Sem veredito'],
  };
  const [selo, tom, titulo] = POR_TIPO[tipo];
  return { selo, tom, titulo, texto: resto };
}

// Funções puras, exportadas pra teste (gate-revisar-md.js) — nada além delas atravessa a
// fronteira: o resto é desenho, e desenho não se testa fora de um DOM de verdade. A linha
// mora AQUI, antes de qualquer `$(...)`: é o que deixa este arquivo `require`-ável em Node
// puro (sem `document`) pelo gate, que só precisa das funções puras de cima (markdown, smoke,
// tom do card e veredito).
globalThis.cockpitRevisar = { blocosDoMarkdown, blocosDoSmoke, pendenciasDe, tomDoJob, vereditoDoTexto };

// O resto é SÓ DOM — dialog, botão, listeners. Guardado pra este arquivo continuar
// `require`-ável em Node puro (o gate acima) e não quebrar numa página sem o diálogo.
if (typeof document !== 'undefined' && document.getElementById('dialogo-revisar')) {

// ── estado da tela ───────────────────────────────────────────────────────────────────────

const dlg = $('dialogo-revisar');
const rv = $('rv');
let filtro = 'todos';
// Cache da leitura corrente: a lista (bruta) + os `result.md` já buscados (id → {texto, cortado}).
// Não sobrevive ao FECHAR do dialog — reabrir busca de novo.
let listaAtual = [];
let sumidasAtual = []; // `atencao[]` da rota: branch sumida — só aparece no filtro Atenção
let resultadosPorId = new Map();
// O que o dialog mostra agora: 'carregando' (abertura em voo) · 'lista' · 'mensagem' (falha) ·
// 'job'. É o que `aoTerminarJob` consulta: relê em silêncio só a lista (ou a mensagem),
// recomeça a abertura em voo e não toca na tela de um job.
let telaDoDialog = 'carregando';
// Sequências (molde `sequenciaJobs`, app.js): resposta que aterrissa depois de uma mais nova não
// escreve nada. A transição pode pedir a rota a cada 15 s, e ela leva segundos (git por job).
let leituraDaLista = 0;
let leituraDoContador = 0;

/** O checkbox dos passos de smoke: SÓ no aparelho, conveniência, nunca registro. */
function smokeMarcados(id) {
  try { return new Set(JSON.parse(localStorage.getItem(`cockpit-revisar-smoke-${id}`) || '[]')); }
  catch { return new Set(); }
}
function marcarSmoke(id, indice, marcado) {
  const atual = smokeMarcados(id);
  if (marcado) atual.add(indice); else atual.delete(indice);
  try { localStorage.setItem(`cockpit-revisar-smoke-${id}`, JSON.stringify([...atual])); } catch { /* sem storage: vale nesta sessão */ }
}

// ── barra do topo (voltar OU título, sempre com ✕) ──────────────────────────────────────

function barra(voltar) {
  const b = el('div', 'rv-barra');
  if (voltar) {
    const v = el('button', 'voltar-rv');
    v.type = 'button';
    v.append(document.createTextNode('‹ '), el('span', null, tr('Pra revisar')));
    v.onclick = () => desenharLista();
    b.append(v, el('span'));
    b.lastChild.style.flex = '1';
  } else {
    b.append(el('h2', null, tr('Pra revisar')));
  }
  const x = el('button', 'icone-so', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', tr('Fechar'));
  x.style.fontSize = '18px';
  x.onclick = () => dlg.close();
  b.append(x);
  return b;
}

// ── contador do botão (busca no boot, ao fechar o dialog e quando um job sai de running; nunca no tique de 15s) ───────

async function atualizarContador() {
  const selo = $('revisar-conta');
  if (!selo) return;
  const minha = ++leituraDoContador;
  try {
    const dados = await api('/api/jobs?revisar=1');
    if (minha !== leituraDoContador) return;
    const n = Array.isArray(dados.jobs) ? dados.jobs.length : 0;
    selo.textContent = String(n);
    selo.hidden = n === 0;
    if (btnRevisar) btnRevisar.setAttribute('aria-label', n ? tr('Pra revisar: {0} jobs', n) : tr('Pra revisar'));
  } catch { /* silencioso — a tela, se aberta, tenta de novo por conta própria */ }
}

// ── tela 1: a lista ──────────────────────────────────────────────────────────────────────

function etiquetaChip(codigo) {
  const CATALOGO = {
    'sem-base': ['sem develop nem main', 'aviso'],
    'branch-sumiu': ['branch sumiu', 'perigo'],
    'retomada': ['retomada', 'info'],
    'nao-sei': ['não sei', 'aviso'],
    'parou-no-limite': ['parou no limite', 'perigo'],
    'pede-revisao': ['pede revisão', 'info'],
    'pede-decisao': ['pede decisão', 'aviso'],
    'relatorio-ilegivel': ['relatório ilegível', 'aviso'],
  };
  return CATALOGO[codigo] || [codigo, 'info'];
}

// ── prévia do merge (só leitura): o selo do card e a seção do detalhe ──
function chipDoMerge(merge) {
  if (!merge) return null;
  const POR_ESTADO = {
    limpo: () => [tr('merge limpo'), 'ok'],
    conflito: () => [merge.n === 1 ? tr('conflito em 1 arquivo') : tr('conflito em {0} arquivos', merge.n), 'perigo'],
    'so-roadmap': () => [tr('conflito só no roadmap.json'), 'info'],
    'nao-sei': () => [tr('merge: não sei'), 'aviso'],
  };
  const [rotulo, tom] = (POR_ESTADO[merge.estado] || POR_ESTADO['nao-sei'])();
  const s = el('span', 'rv-chip', rotulo);
  s.dataset.tom = tom;
  s.dataset.merge = merge.estado;
  return s;
}

function secaoDoMerge(merge) {
  const h = el('div', 'rv-secao');
  h.append(el('h3', null, tr('Merge na {0}', merge.base || '')));
  const cartao = el('div', 'rv-cartao rv-merge');
  cartao.dataset.merge = merge.estado;
  const arquivos = merge.arquivos || [];
  if (merge.estado === 'limpo') {
    cartao.append(el('p', null, tr('Nenhum arquivo em conflito.')));
  } else if (merge.estado === 'conflito' || merge.estado === 'so-roadmap') {
    cartao.append(el('p', null, merge.estado === 'so-roadmap' ? tr('Só o roadmap.json conflita.') : tr('{0} arquivo(s) em conflito:', merge.n)));
    const ul = el('ul', 'rv-merge-arquivos');
    arquivos.forEach((a) => { const li = el('li'); li.append(el('code', null, a)); ul.append(li); });
    cartao.append(ul);
    if (merge.n > arquivos.length) cartao.append(el('p', 'rv-resumo', tr('e mais {0}', merge.n - arquivos.length)));
  } else {
    cartao.append(el('p', null, tr('Não deu para saber agora (erro ou tempo do git). Isso não quer dizer limpo.')));
  }
  return [h, cartao];
}

async function carregarLista({ silencioso = false } = {}) {
  const minha = ++leituraDaLista;
  // Silenciosa (um job terminou com a lista na vista): a lista fica onde está até a nova chegar —
  // a rota leva segundos, e trocar por "Carregando…" a cada job que termina faria a tela piscar.
  if (!silencioso) {
    telaDoDialog = 'carregando';
    rv.replaceChildren(barra(false), el('p', 'rv-resumo', tr('Carregando…')));
  }
  // As três saídas de falha. Na silenciosa, nenhuma mexe em nada: sem notícia não apaga o que se
  // sabe. Na abertura, a falha é dita na tela, como sempre foi.
  const falhou = (texto, limpar) => {
    if (silencioso || minha !== leituraDaLista) return;
    if (limpar) { listaAtual = []; sumidasAtual = []; }
    desenharMensagem(texto);
  };
  try {
    const dados = await api('/api/jobs?revisar=1');
    if (dados && dados.habilitado === false) return falhou(tr('não deu para ler os jobs'), true);
    // `erro: true` = o servidor não leu a pasta de jobs. Lista vazia ali é falha, não "nada esperando".
    if (!dados || dados.erro || !Array.isArray(dados.jobs)) return falhou(tr('não consegui ler a lista'), true);
    const lista = dados.jobs;
    const sumidas = dados.atencao || [];
    // Os `result.md` de quem entrou, numa tacada — são leituras locais, baratas, e só
    // rodam com a tela ABERTA (nunca no tique de 15s). É o que alimenta o chip de smoke da
    // lista e deixa a tela do job pronta sem esperar de novo.
    // Num Map NOVO, publicado só no fim: zerar o cache antes do `await` deixaria um card tocado
    // durante a releitura sem relatório ("não consegui ler o relatório").
    const resultados = new Map();
    const paraBuscar = new Map();
    [...lista, ...sumidas, ...lista.flatMap((j) => [...(j.retomou || []), ...(j.inclui || [])])]
      .forEach((j) => paraBuscar.set(j.id, j));
    await Promise.all([...paraBuscar.values()].map(async (j) => {
      try { resultados.set(j.id, await api(`/api/jobs/resultado?id=${encodeURIComponent(j.id)}`)); }
      catch { resultados.set(j.id, null); }
    }));
    if (minha !== leituraDaLista) return;
    listaAtual = lista;
    sumidasAtual = sumidas;
    resultadosPorId = resultados;
    // Lista principal vazia com sumidas: o filtro Atenção já abre selecionado — na ABERTURA (uma
    // vez, aqui — não em `desenharLista`, senão os botões Todos/Prontos nunca respondem). A
    // releitura silenciosa não troca o filtro debaixo do dedo.
    if (!silencioso && !listaAtual.length && sumidasAtual.length) filtro = 'atencao';
    // O dono abriu a tela de um job enquanto a leitura corria: o cache já é o novo (o
    // "‹ Pra revisar" mostra a lista nova), mas a tela dele não é trocada.
    if (telaDoDialog === 'job') return;
    // Releitura silenciosa: a lista não volta pro topo a cada job que termina — o `desenharLista`
    // cria um `.rv-corpo` novo, e é ele que rola (estilo.css, `.rv-corpo`). Repõe a MESMA
    // distância do topo; o job novo entra em cima (a rota ordena por `fim`), então o que estava
    // na vista desce a altura de um card. Aceito: é o que o navegador faz sozinho em qualquer lista.
    const corpoVelho = silencioso ? rv.querySelector('.rv-corpo') : null;
    const rolagem = corpoVelho ? corpoVelho.scrollTop : 0;
    desenharLista();
    const corpoNovo = rolagem ? rv.querySelector('.rv-corpo') : null;
    if (corpoNovo) corpoNovo.scrollTop = rolagem;
  } catch (e) {
    falhou(e && e.semToken ? tr('sem token') : tr('não consegui ler a lista'), false);
  }
}

function desenharMensagem(texto) {
  telaDoDialog = 'mensagem';
  rv.replaceChildren(barra(false), el('p', 'rv-resumo', texto));
}

// O relacionado de um card (retomou/inclui) pelo id; null → o clique abre o próprio job.
function relacionado(j, id) {
  return [...(j.retomou || []), ...(j.inclui || [])].find((s) => s.id === id) || null;
}

// As sublinhas "retomou: …"/"inclui: …". Na lista levam `data-id` (o clique do card desvia por elas).
function sublinhas(j, comId) {
  const linhas = [];
  [['retomou: {0}', j.retomou], ['inclui: {0}', j.inclui]].forEach(([modelo, itens]) => {
    (itens || []).forEach((s) => {
      const sub = el('span', 'rv-sub', tr(modelo, s.titulo || '(sem título)'));
      if (comId) sub.dataset.id = s.id;
      linhas.push(sub);
    });
  });
  return linhas;
}

function cardDe(j) {
  const c = el('button', 'rv-card');
  c.type = 'button';
  c.dataset.tom = tomDoJob(j.etiquetas || []);
  c.dataset.id = j.id;

  const l1 = el('div', 'rv-linha1');
  const p = el('span', 'rv-proj');
  p.style.setProperty('--cor-proj', corDoProjeto(j.projeto));
  p.append(el('i'), document.createTextNode(j.projeto || ''));
  l1.append(p, el('span', null, haTexto(j.fim)));
  c.append(l1, el('h3', null, j.titulo || '(sem título)'), ...sublinhas(j, true));

  const l3 = el('div', 'rv-linha3');
  (j.etiquetas || []).forEach((codigo) => {
    const [rotulo, tom] = etiquetaChip(codigo);
    const s = el('span', 'rv-chip', tr(rotulo));
    s.dataset.tom = tom;
    l3.append(s);
  });
  const chipMerge = chipDoMerge(j.merge);
  if (chipMerge) l3.append(chipMerge);
  const resultado = resultadosPorId.get(j.id);
  if (resultado && resultado.texto) {
    const smoke = blocosDoSmoke(resultado.texto);
    if (Array.isArray(smoke) && smoke.length) {
      const s = el('span', 'rv-chip', tr('smoke · {0} passos', smoke.length));
      s.dataset.tom = 'smoke';
      l3.append(s);
    } else if (smoke === null) {
      const s = el('span', 'rv-chip', tr('sem roteiro'));
      l3.append(s);
    }
  }
  if (l3.childNodes.length) c.append(l3);

  // UM só onclick no card (nada de botão dentro de botão): a sublinha é um span, e o clique
  // nela abre o job relacionado; em qualquer outro ponto, o próprio job.
  c.onclick = (ev) => {
    const sub = ev.target.closest && ev.target.closest('.rv-sub');
    const rel = sub ? relacionado(j, sub.dataset.id) : null;
    desenharJob(rel ? { ...rel, projeto: j.projeto, retomou: [], inclui: [] } : j);
  };
  return c;
}

function desenharLista() {
  telaDoDialog = 'lista';
  rv.replaceChildren();
  const corpo = el('div', 'rv-corpo');
  const todos = listaAtual;
  const prontos = todos.filter((j) => tomDoJob(j.etiquetas || []) === 'ok');
  const atencao = todos.filter((j) => tomDoJob(j.etiquetas || []) !== 'ok').concat(sumidasAtual);

  if (!todos.length && !sumidasAtual.length) {
    corpo.append(el('p', 'rv-resumo', tr('Nada esperando revisão')));
    rv.append(barra(false), corpo);
    return;
  }

  corpo.append(el('p', 'rv-resumo', todos.length
    ? tr('{0} jobs terminaram e ainda não entraram na develop (ou main) do repo deles.', todos.length)
    : tr('Nenhum job esperando revisão.')));
  if (sumidasAtual.length) corpo.append(el('p', 'rv-resumo', tr('Em Atenção: {0} com a branch sumida.', sumidasAtual.length)));

  const filtros = el('div', 'rv-filtros');
  [['todos', tr('Todos'), todos.length], ['prontos', tr('Prontos'), prontos.length], ['atencao', tr('Atenção'), atencao.length]]
    .forEach(([chave, rotulo, n]) => {
      const f = el('button', 'rv-filtro');
      f.type = 'button';
      f.setAttribute('aria-pressed', String(filtro === chave));
      f.append(el('span', null, rotulo), el('b', null, String(n)));
      f.onclick = () => { filtro = chave; desenharLista(); };
      filtros.append(f);
    });
  corpo.append(filtros);

  const grade = el('div', 'rv-lista');
  (filtro === 'todos' ? todos : (filtro === 'atencao' ? atencao : prontos)).forEach((j) => grade.append(cardDe(j)));
  corpo.append(grade);

  rv.append(barra(false), corpo);
}

// ── tela 2: o job ────────────────────────────────────────────────────────────────────────

function desenharJob(j) {
  telaDoDialog = 'job';
  const corpo = el('div', 'rv-corpo');

  const hero = el('div', 'rv-hero');
  const l1 = el('div', 'rv-linha1');
  const p = el('span', 'rv-proj');
  p.style.setProperty('--cor-proj', corDoProjeto(j.projeto));
  p.append(el('i'), document.createTextNode(j.projeto || ''));
  if (haTexto(j.fim)) l1.append(p, el('span', null, tr('terminou {0}', haTexto(j.fim))));
  else l1.append(p);
  hero.append(l1, el('h2', null, j.titulo || '(sem título)'), ...sublinhas(j, false));
  corpo.append(hero);
  if (j.merge) corpo.append(...secaoDoMerge(j.merge));

  const resultado = resultadosPorId.get(j.id);
  const md = resultado && resultado.texto ? resultado.texto : '';

  if (!md) {
    corpo.append(el('p', 'rv-resumo', tr(resultado ? 'Este job não deixou relatório.' : 'não consegui ler o relatório')));
  } else {
    const v = vereditoDoTexto(md, j.etiquetas);
    const vereditoEl = el('div', 'rv-veredito');
    vereditoEl.dataset.tom = v.tom;
    const t = el('p');
    t.append(el('strong', null, tr(v.titulo)), inline(el('span'), v.texto));
    vereditoEl.append(el('span', 'selo', v.selo), t);
    corpo.append(vereditoEl);
    // O servidor corta o `result.md` em 64 KB. O roteiro de smoke mora no FIM do relatório:
    // cortado, um "sem roteiro" pode ser só o corte — a tela diz isso em vez de calar.
    if (resultado.cortado) corpo.append(el('p', 'rv-resumo rv-cortado', tr('Relatório cortado em 64 KB: o fim (e o roteiro de smoke) pode ter ficado de fora.')));

    // ── Smoke pra você ──
    const secaoSmoke = el('div', 'rv-secao');
    const prog = el('span', 'rv-progresso');
    secaoSmoke.append(el('h3', null, tr('Smoke pra você')), prog);
    corpo.append(secaoSmoke);

    const smoke = blocosDoSmoke(md);
    if (smoke === null) {
      corpo.append(el('p', 'rv-resumo', tr('sem roteiro')));
      prog.remove();
      const pend = pendenciasDe(md);
      if (pend) corpo.append(markdown(`## ${pend.titulo}\n${pend.texto}`));
    } else if (!Array.isArray(smoke)) {
      prog.remove();
      corpo.append(el('p', 'rv-resumo', tr('Nada a testar à mão: {0}', smoke.nada)));
    } else {
      const barraP = el('div', 'rv-barra-prog');
      const fill = el('span');
      barraP.append(fill);
      corpo.append(barraP);
      const ol = el('ol', 'rv-passos');
      const marcados = smokeMarcados(j.id);
      const conta = () => {
        const n = ol.querySelectorAll('input:checked').length;
        prog.textContent = tr('{0} de {1}', n, smoke.length);
        fill.style.width = `${(100 * n) / smoke.length}%`;
      };
      smoke.forEach((passo, k) => {
        const li = el('li');
        const lab = el('label', 'rv-passo');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = marcados.has(k);
        cb.onchange = () => { marcarSmoke(j.id, k, cb.checked); conta(); };
        const txt = el('div');
        const ve = el('div', 've');
        ve.append(el('b', null, tr('Deve ver: ')), document.createTextNode(passo.deveVer || ''));
        txt.append(el('div', 'onde', passo.onde || ''), el('div', 'faz', passo.faz || ''), ve);
        lab.append(cb, el('span', 'num', String(k + 1)), txt);
        li.append(lab);
        ol.append(li);
      });
      corpo.append(ol);
      conta();
    }

    const oq = secao(md, 'O que entrou');
    if (oq) {
      const h = el('div', 'rv-secao');
      h.append(el('h3', null, tr('O que entrou')));
      corpo.append(h);
      const cartao = el('div', 'rv-cartao');
      cartao.append(markdown(oq));
      corpo.append(cartao);
    }
    const val = secao(md, 'Validações');
    if (val) {
      const h = el('div', 'rv-secao');
      h.append(el('h3', null, tr('Testes que o job rodou')));
      corpo.append(h);
      const cartao = el('div', 'rv-cartao');
      cartao.append(markdown(val.split('\n\n')[0]));
      corpo.append(cartao);
    }

    const det = el('details', 'rv-completo');
    det.append(el('summary', null, tr(resultado.cortado ? 'Relatório do agente (cortado em 64 KB)' : 'Relatório completo do agente')), markdown(md));
    corpo.append(det);
  }

  const rodape = el('div', 'rv-rodape');
  // Ver a diff do código (card `ver-a-diff-do-codigo`, D95; mesma aba desde D96): o que o merge deste job na base
  // traria. `cockpitDiffEntrada`/`cockpitDentro` só são lidos DENTRO do `onclick` (R4) — nada na criação do rodapé.
  const btnDiff = el('button', 'btn', tr('Ver mudanças'));
  btnDiff.type = 'button';
  btnDiff.onclick = () => globalThis.cockpitDentro.abrir(globalThis.cockpitDiffEntrada.urlDaDiff({ job: j.id }), { revisar: j.id });
  const btn = el('button', 'btn btn-principal', tr('Abrir conversa do job'));
  btn.type = 'button';
  btn.onclick = () => { dlg.close(); abrirJob(j.id); };
  rodape.append(btnDiff, btn);

  rv.replaceChildren(barra(true), corpo, rodape);
  corpo.scrollTop = 0;
}

// ── ligações ─────────────────────────────────────────────────────────────────────────────

const btnRevisar = $('btn-revisar');
if (btnRevisar) btnRevisar.onclick = () => { dlg.showModal(); carregarLista(); };
dlg.addEventListener('close', () => { atualizarContador(); });

// Um job saiu de `running` entre duas leituras boas do tique de jobs (`atualizarFaixaJobs`, app.js —
// D76). Nunca por relógio: a rota roda git por job (D60). O número vale em qualquer tela. A lista:
//   · na vista (ou a mensagem de erro) → releitura silenciosa, sem "Carregando…";
//   · abrindo ("Carregando…") → recomeça a abertura: a leitura em voo pode ter saído antes do fim
//     do job, e uma silenciosa por cima a descartaria sem dizer nada se falhasse — a tela ficaria
//     presa em "Carregando…";
//   · na tela de um job → não mexe: não se arranca ninguém do que está lendo.
function aoTerminarJob() {
  atualizarContador();
  if (!dlg.open) return;
  if (telaDoDialog === 'lista' || telaDoDialog === 'mensagem') carregarLista({ silencioso: true });
  else if (telaDoDialog === 'carregando') carregarLista();
}
globalThis.cockpitRevisar.aoTerminarJob = aoTerminarJob;

// D96/M8: voltou da diff (`cockpitDentro.abrir`) numa página RECARREGADA — reabre o Pra revisar no job de onde
// saiu. Achou → tela do job (mesma montagem do clique do card, `cardDe`); não achou (saiu da lista = mergeado) →
// fica na lista. `<dialog>` puro, sem pushState (#39). Com bfcache isto nem roda.
async function voltarDeOutraPagina() {
  const id = globalThis.cockpitDentro ? globalThis.cockpitDentro.tomarVolta('revisar') : undefined;
  if (typeof id !== 'string' || !id) return;
  dlg.showModal();
  await carregarLista();
  if (!dlg.open || telaDoDialog !== 'lista') return;
  for (const j of [...listaAtual, ...sumidasAtual]) {
    if (j.id === id) { desenharJob(j); return; }
    const rel = relacionado(j, id);
    if (rel) { desenharJob({ ...rel, projeto: j.projeto, retomou: [], inclui: [] }); return; }
  }
}

// Busca no BOOT, sem `await`: a lista de abas não espera o git (plano, Fase D).
atualizarContador();
voltarDeOutraPagina();

} // fim do guard `typeof document !== 'undefined'`

})();
