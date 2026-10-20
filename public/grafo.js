'use strict';
// Diálogo "Grafos" — botão #btn-grafos na lateral, um botão "Grafo" por projeto (card
// `grafo-do-projeto-no-cockpit`). Molde IIFE de revisar.js/monitor.js: só textContent/createElement
// (#26), nada de innerHTML. O grafo mostrado é sempre o da develop (decisão do dono) — esta tela
// só lista estado e abre o mapa NA MESMA ABA (D96); quem gera é o `bin/grafo.js` do servidor.
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

// Token lido A CADA CHAMADA (mesmo motivo de uso.js/revisar.js): congelar uma vez perderia o
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

/**
 * `item: {nome, develop, grafo: null|{geradoEm, estado, commitsAtras}}` → texto VISÍVEL na linha
 * (#31 — nada só em `title`). `trFn`/`fmt` passam por fora para o gate testar sem `document`.
 */
function textoDoEstado(item, trFn, fmt) {
  if (!item.develop) return trFn('sem develop');
  if (item.gerando) return trFn('gerando…');
  if (!item.grafo) return trFn('sem grafo ainda');
  const base = trFn('grafo da develop de {0}', fmt(item.grafo.geradoEm));
  const estado = item.grafo.estado;
  if (estado === 'em-dia') return `${base} · ${trFn('em dia')}`;
  if (estado === 'atras') {
    const n = item.grafo.commitsAtras;
    return `${base} · ${n === 1 ? trFn('{0} commit atrás da develop', n) : trFn('{0} commits atrás da develop', n)}`;
  }
  if (estado === 'fora') return `${base} · ${trFn('fora da história da develop')}`;
  return `${base} · ${trFn('estado desconhecido')}`;
}

/** O botão da linha: `tipo` 'abrir' (grafo pronto), 'fazer' (develop sem grafo) ou null (sem develop, D88). */
function acaoDaLinha(item) {
  if (!item.develop) return { rotulo: 'Grafo', ativo: false, tipo: null };
  if (item.grafo) return { rotulo: 'Grafo', ativo: true, tipo: 'abrir' };
  return { rotulo: 'Fazer grafo', ativo: !item.gerando, tipo: 'fazer' };
}

/** Linhas que o servidor diz estarem gerando e esta tela ainda não acompanha (reabertura do diálogo, T5). */
function paraJuntar(lista, emCursoSet) {
  return lista.filter((i) => i.gerando && !emCursoSet.has(i.nome)).map((i) => i.nome);
}

/** A lista com o `gerando` do GET desligado pra `nome`: a geração que ESTA tela acompanhava terminou (bem ou mal). */
function semGerando(lista, nome) {
  return lista.map((i) => (i.nome === nome && i.gerando ? { ...i, gerando: false } : i));
}

/** Quem tem grafo primeiro, depois alfabética. */
function ordenar(lista) {
  return [...lista].sort((a, b) => {
    const ga = a.grafo ? 0 : 1;
    const gb = b.grafo ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return a.nome.localeCompare(b.nome);
  });
}

/** `token` vazio vira `-`: sem um valor não vazio o dashboard pararia na tela TokenGate. */
function urlDoGrafo(nome, token) {
  const t = token ? encodeURIComponent(token) : '-';
  return `grafo/${encodeURIComponent(nome)}/?token=${t}`;
}

/** O mapa simples (card `grafo-mapa-simples`, D91) — sem token desde D96: abre NA MESMA ABA e lê o `localStorage`. */
function urlDoMapa(nome) {
  return `mapa/${encodeURIComponent(nome)}/`;
}

// Puras, exportadas pra teste (gate-grafo-tela.js) — mesma convenção de revisar.js:239-244.
// `rotulo` é a chave do catálogo; quem traduz é a `linhaDe` (`tr(acao.rotulo)`). O gate de tela confere
// a chave, e o `gate-idioma` a tradução. Não chame `tr` com variável sem a chave estar no catálogo.
globalThis.cockpitGrafo = { textoDoEstado, ordenar, urlDoGrafo, acaoDaLinha, paraJuntar, semGerando, urlDoMapa };

// O resto é só DOM. Guardado pra este arquivo continuar `require`-ável em Node puro (o gate acima).
if (typeof document !== 'undefined' && document.getElementById('dialogo-grafos')) {

const dlg = $('dialogo-grafos');
const lista = $('grafos-lista');
const btn = $('btn-grafos');
const btnFechar = $('btn-fechar-grafos');

// Fuso do APARELHO (#35) — nunca o do servidor.
function fmt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(idiomaUI.idioma, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return '';
  }
}

// Botão "Fazer grafo" (card `grafo-botao-fazer-grafo`): `emCurso` é o que ESTA ABA sabe que tocou
// (mostra "gerando…" sem esperar o GET seguinte); `mensagens` guarda o aviso/erro do último toque
// por projeto, até a próxima abertura do diálogo.
const emCurso = new Set();
const mensagens = new Map(); // nome -> { texto, tipo: 'erro'|'aviso' }
let ultimaLista = [];

/** Mesmo token/erro de `api()`, mas POST com corpo JSON — usado só por "Fazer grafo". */
async function postar(rota, corpo) {
  const cabecalhos = { 'content-type': 'application/json' };
  const token = tokenAgora();
  if (token) cabecalhos.authorization = `Bearer ${token}`;
  let resposta;
  try {
    resposta = await fetch(rota, { method: 'POST', headers: cabecalhos, body: JSON.stringify(corpo) });
  } catch {
    throw new Error(tr('não consegui falar com o servidor'));
  }
  if (resposta.status === 401) {
    const erro = new Error(tr('sem token'));
    erro.semToken = true;
    throw erro;
  }
  if (!resposta.ok) {
    const dados = await resposta.json().catch(() => null);
    throw new Error(tr((dados && dados.erro) || `HTTP ${resposta.status}`));
  }
  return resposta.json();
}

function linhaDe(item) {
  const vista = emCurso.has(item.nome) ? { ...item, gerando: true } : item;
  const l = el('div', 'grafos-linha');
  l.append(el('span', 'grafos-nome', item.nome));
  l.append(el('span', 'grafos-estado', textoDoEstado(vista, tr, fmt)));
  const acao = acaoDaLinha(vista);
  const abrir = el('button', 'btn grafos-abrir', tr(acao.rotulo));
  abrir.type = 'button';
  abrir.disabled = !acao.ativo;
  abrir.dataset.acao = acao.tipo || 'nenhuma';
  if (acao.tipo === 'abrir') abrir.onclick = () => globalThis.cockpitDentro.abrir(urlDoMapa(item.nome), { grafos: true });
  else if (acao.tipo === 'fazer') abrir.onclick = () => fazerGrafo(item.nome);
  l.append(abrir);
  if (mensagens.has(item.nome)) {
    const m = mensagens.get(item.nome);
    const msg = el('p', `grafos-msg ${m.tipo}`, m.texto);
    if (m.tipo === 'erro') msg.setAttribute('role', 'alert');
    l.append(msg);
  }
  return l;
}

function desenhar() {
  lista.replaceChildren();
  if (!ultimaLista.length) { lista.append(el('p', 'rv-resumo', tr('Nenhum projeto com git encontrado.'))); return; }
  ordenar(ultimaLista).forEach((item) => lista.append(linhaDe(item)));
}

async function fazerGrafo(nome) {
  if (emCurso.has(nome)) return;
  emCurso.add(nome);
  mensagens.delete(nome);
  desenhar();
  try {
    const r = await postar('api/grafos/fazer', { nome });
    if (r && r.aviso) mensagens.set(nome, { texto: tr(r.aviso), tipo: 'aviso' });
  } catch (e) {
    mensagens.set(nome, { texto: e && e.semToken ? tr('sem token') : ((e && e.message) || tr('não consegui falar com o servidor')), tipo: 'erro' });
  } finally {
    emCurso.delete(nome);
    // O `gerando: true` que veio do GET (reabertura) também sai: senão, com o GET seguinte falhando, a linha
    // ficaria em "gerando…" com o botão travado (painel de execução, Codex).
    ultimaLista = semGerando(ultimaLista, nome);
  }
  // O desenhar ANTES do carregar põe a mensagem e o botão de volta na tela mesmo que o GET seguinte falhe.
  desenhar();
  await carregar({ silencioso: true });
}

async function carregar({ silencioso = false } = {}) {
  if (!silencioso) lista.replaceChildren(el('p', 'rv-resumo', tr('Carregando…')));
  try {
    const dados = await api('api/grafos'); // relativo ao <base>: vale sob /cockpit (#16), como o monitor.js
    ultimaLista = Array.isArray(dados.projetos) ? dados.projetos : [];
    desenhar();
    // Reabertura do diálogo com `gerando: true` vindo do GET (T5): entra na geração em curso do
    // servidor sem polling — o nome já em `emCurso` nunca entra de novo.
    paraJuntar(ultimaLista, emCurso).forEach((nome) => fazerGrafo(nome));
  } catch (e) {
    if (silencioso && ultimaLista.length > 0) { desenhar(); return; }
    lista.replaceChildren(el('p', 'rv-resumo', e && e.semToken ? tr('sem token') : ((e && e.message) || tr('não consegui ler a lista'))));
  }
}

if (btn) btn.onclick = () => { mensagens.clear(); dlg.showModal(); carregar(); };
if (btnFechar) btnFechar.onclick = () => dlg.close();
// D96/M9: voltou do mapa (`cockpitDentro.abrir`) numa página RECARREGADA — reabre o diálogo de onde se saiu,
// pelo mesmo caminho do `#btn-grafos`. Com bfcache isto nem roda: o diálogo volta aberto.
if (globalThis.cockpitDentro && globalThis.cockpitDentro.tomarVolta('grafos') === true) { mensagens.clear(); dlg.showModal(); carregar(); }

} // fim do guard `typeof document !== 'undefined'`

})();
