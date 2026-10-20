'use strict';

/**
 * PRs abertos do GitHub pelo `gh` (card `ver-a-diff-do-codigo`, D97). Só leitura: `search prs`,
 * `pr view`, `pr diff`. Spawn sem shell por `processoLimitado` (lib/diff.js), ambiente em lista
 * fechada, stderr descartado.
 */

const { processoLimitado, parsearPatch, TETOS } = require('./diff');

const RE_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const RE_NUMERO = /^[1-9]\d{0,6}$/;
const LIMITE = 30;
const CACHE_OK_MS = 60_000;
const CACHE_FALHA_MS = 15_000;
const TIMEOUT_LISTA_MS = 8000;
const TIMEOUT_VIEW_MS = 8000;
const TIMEOUT_DIFF_MS = 15000;
const TETO_LISTA = 256_000;
const TETO_VIEW = 64_000;

const binGh = () => process.env.COCKPIT_GH_BIN || 'gh';
const PASSA = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST'];
function envDoGh() {
  const e = {};
  for (const k of PASSA) if (process.env[k]) e[k] = process.env[k];
  return { ...e, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0', GH_PAGER: 'cat', LC_ALL: 'C' };
}
function repoValido(r) {
  return typeof r === 'string' && RE_REPO.test(r) && !['.', '..'].includes(r.split('/')[1]);
}
function rodarGh(args, teto, timeoutMs) {
  return processoLimitado(binGh(), args, { teto, timeoutMs, env: envDoGh() });
}

const ARGS_SEARCH = ['search', 'prs', '--state', 'open', '--involves', '@me', '--sort', 'updated', '--order', 'desc', '--json', 'repository,number,title,updatedAt,author,isDraft', '--limit', String(LIMITE)];

/** Mapeia a resposta do `gh search prs` pro formato da casa; item inválido é descartado. */
function lerListaDoGh(texto) {
  let lista;
  try { lista = JSON.parse(texto); } catch { return null; }
  if (!Array.isArray(lista)) return null;
  const itens = [];
  for (const item of lista) {
    const repo = item && item.repository && item.repository.nameWithOwner;
    const numero = item && item.number;
    if (!repoValido(repo)) continue;
    if (!Number.isInteger(numero) || !RE_NUMERO.test(String(numero))) continue;
    if (typeof item.title !== 'string') continue;
    const titulo = item.title.length > 300 ? item.title.slice(0, 300) : item.title;
    const autorLogin = item.author && item.author.login;
    const autor = typeof autorLogin === 'string' && autorLogin.length <= 100 ? autorLogin : '';
    const dt = typeof item.updatedAt === 'string' ? new Date(item.updatedAt) : null;
    const atualizado = dt && !Number.isNaN(dt.getTime()) ? item.updatedAt : null;
    const rascunho = item.isDraft === true;
    itens.push({ repo, numero, titulo, autor, atualizado, rascunho });
  }
  itens.sort((a, b) => {
    if (a.atualizado === b.atualizado) return 0;
    if (a.atualizado === null) return 1;
    if (b.atualizado === null) return -1;
    return new Date(b.atualizado).getTime() - new Date(a.atualizado).getTime();
  });
  return itens;
}

/**
 * Sem numstat: a lista de arquivos é o próprio patch. Descarta primeiro todo arquivo com
 * `caminho` nulo (corte no meio do cabeçalho `diff --git`); descartou algum → `cortado.lista =
 * true`. Depois, corte/timeout com arquivos presentes → o ÚLTIMO perde o corpo.
 */
function arquivosDoPatch(arquivos, { cortado = false, tempo = false } = {}) {
  const presentes = Array.isArray(arquivos) ? arquivos : [];
  let descartouAlgum = false;
  const filtrados = [];
  for (const a of presentes) {
    if (a.caminho === null) { descartouAlgum = true; continue; }
    filtrados.push({
      caminho: a.caminho, antigo: a.antigo, estado: a.estado, binario: a.binario, modo: a.modo,
      mais: a.mais, menos: a.menos, trechos: a.trechos, semFimDeLinha: a.semFimDeLinha,
    });
  }
  let lista = descartouAlgum;
  if ((cortado || tempo) && filtrados.length > 0) {
    const ultimo = filtrados[filtrados.length - 1];
    ultimo.trechos = [];
    ultimo.semCorpo = 'cortado';
    lista = true;
  }
  return { arquivos: filtrados, cortado: { corpo: Boolean(cortado), lista, tempo: Boolean(tempo) } };
}

let cache = null;
let emVoo = null;

/** Lista de PRs abertos (E11/E12). Sucesso vale 60 s; falha vale 15 s; pedidos simultâneos dividem o mesmo processo. */
async function listarPrs({ agora = Date.now(), timeoutMs = TIMEOUT_LISTA_MS } = {}) {
  if (cache && agora - cache.em < (cache.resultado.ok ? CACHE_OK_MS : CACHE_FALHA_MS)) return cache.resultado;
  if (emVoo) return emVoo;
  emVoo = (async () => {
    const r = await rodarGh(ARGS_SEARCH, TETO_LISTA, timeoutMs);
    let resultado = { ok: false };
    if (r.codigo === 0 && !r.cortado && !r.tempoEsgotado && !r.erro) {
      const prs = lerListaDoGh(r.stdout.toString('utf8'));
      if (prs) resultado = { ok: true, prs, limite: prs.length >= LIMITE };
    }
    cache = { em: agora, resultado };
    return resultado;
  })().finally(() => { emVoo = null; });
  return emVoo;
}

/** Só o gate chama — zera cache e promessa em voo entre casos. */
function _zerarCache() { cache = null; emVoo = null; }

/** Só devolve o PR se o par estiver na lista que o PRÓPRIO servidor obteve (allowlist). */
async function prDaLista(repo, numero, opcoes) {
  const l = await listarPrs(opcoes);
  if (!l.ok) return { falhou: true };
  return l.prs.find((p) => p.repo === repo && p.numero === numero) || null;
}

/** Cabeçalho (`pr view`) + arquivos (`pr diff`) de um PR, em paralelo. */
async function detalheDoPr(repo, numero, { timeoutView = TIMEOUT_VIEW_MS, timeoutDiff = TIMEOUT_DIFF_MS } = {}) {
  const [rView, rDiff] = await Promise.all([
    rodarGh(['pr', 'view', String(numero), '-R', repo, '--json', 'number,title,author,headRefName,baseRefName,updatedAt,additions,deletions,changedFiles,isDraft'], TETO_VIEW, timeoutView),
    rodarGh(['pr', 'diff', String(numero), '-R', repo, '--color', 'never'], TETOS.patch, timeoutDiff),
  ]);

  let view = null;
  if (rView.codigo === 0 && !rView.cortado && !rView.tempoEsgotado && !rView.erro) {
    try { view = JSON.parse(rView.stdout.toString('utf8')); } catch { view = null; }
  }
  if (!view) return { erro: true };

  const titulo = typeof view.title === 'string' ? (view.title.length > 300 ? view.title.slice(0, 300) : view.title) : '';
  const autorLogin = view.author && view.author.login;
  const autor = typeof autorLogin === 'string' ? autorLogin : '';
  const atualizado = typeof view.updatedAt === 'string' ? view.updatedAt : null;
  const pr = {
    repo, numero, titulo, autor, head: view.headRefName || null, base: view.baseRefName || null,
    atualizado, rascunho: view.isDraft === true, url: `https://github.com/${repo}/pull/${numero}`,
  };
  const camposTotais = [view.changedFiles, view.additions, view.deletions];
  const totaisValidos = camposTotais.every((n) => Number.isInteger(n));
  const totais = totaisValidos ? { arquivos: view.changedFiles, mais: view.additions, menos: view.deletions } : null;

  if ((rDiff.codigo !== 0 && !rDiff.cortado && !rDiff.tempoEsgotado) || rDiff.erro) {
    return { pr, arquivos: [], totais, cortado: { corpo: false, lista: false, tempo: false }, semDiff: true };
  }
  const parsed = parsearPatch(rDiff.stdout.toString('utf8'));
  const j = arquivosDoPatch(parsed, { cortado: rDiff.cortado || rDiff.tempoEsgotado, tempo: rDiff.tempoEsgotado });
  return { pr, arquivos: j.arquivos, totais, cortado: j.cortado, semDiff: false };
}

module.exports = {
  RE_REPO, RE_NUMERO, LIMITE, repoValido, lerListaDoGh, arquivosDoPatch, listarPrs, prDaLista, detalheDoPr, _zerarCache,
};
