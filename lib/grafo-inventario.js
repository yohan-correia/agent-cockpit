'use strict';
/**
 * O resumo do grafo de cada projeto para a tela (`GET /api/grafos`) e o estado de frescor que o
 * dashboard do understand-anything valida (`staleness.json`). Spec
 * `2026-10-16-grafo-do-projeto-no-cockpit` (Fase 3/5/8). `inventario(raiz)` é a tabela completa
 * da Fase 8 (dry-run, só leitura): git?, nome no padrão?, develop, loja, `.ua/` legado, hook do
 * Cockpit, hook `ua-grafo` legado e arquivos de código — usada por `bin/grafo.js
 * inventario`/`rollout`.
 */

const fs = require('node:fs');
const path = require('node:path');
const gitlib = require('./grafo-git.js');
const loja = require('./grafo-loja.js');
const hooklib = require('./grafo-hook.js');
const { deveIndexar } = require('./grafo-extrator.js');

// A MESMA régua mora em `server.js` (`NOME_DE_PASTA`) e em `public/app.js`: projeto cujo nome não
// casa não entra no diálogo — a rota `/grafo/<nome>/` não o aceitaria (spec, risco #2 rodada 2).
const NOME_DE_PASTA = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

async function mapaComConcorrencia(itens, limite, fn) {
  const resultado = new Array(itens.length);
  let indice = 0;
  async function trabalhador() {
    for (;;) {
      const i = indice;
      indice += 1;
      if (i >= itens.length) return;
      resultado[i] = await fn(itens[i]);
    }
  }
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, () => trabalhador());
  await Promise.all(trabalhadores);
  return resultado;
}

/**
 * Nunca deduzido só da contagem (`A..B` dá 0 também com o grafo à frente): `em-dia` (sha igual),
 * `atras` (sha do grafo ancestral da develop, com `commitsAtras`), `fora` (não ancestral —
 * develop resetada/reescrita, ou grafo de outra história) e `desconhecido` (sha não existe mais).
 */
async function estadoDoGrafo(repo, shaGrafo, shaDevelop) {
  if (shaGrafo === shaDevelop) return { estado: 'em-dia', commitsAtras: 0 };
  const existe = await gitlib.existeCommit(repo, shaGrafo);
  if (!existe) return { estado: 'desconhecido', commitsAtras: null };
  const ancestral = await gitlib.ehAncestral(repo, shaGrafo, shaDevelop);
  if (ancestral === true) {
    const { atras } = await gitlib.atrasFrente(repo, shaGrafo, shaDevelop);
    return { estado: 'atras', commitsAtras: atras };
  }
  return { estado: 'fora', commitsAtras: null };
}

/**
 * `{ nome, develop, grafo }` por pasta de `listarProjetos()` que é repo git — ordenado (quem tem
 * grafo primeiro, depois alfabética). Concorrência 6 (a `/api/grafos` faz ~3 `git` por projeto).
 */
async function resumoParaTela(raiz, listarProjetosFn) {
  const projetosDisco = await listarProjetosFn();
  const candidatos = projetosDisco.filter((p) => NOME_DE_PASTA.test(p.nome));
  const resultados = await mapaComConcorrencia(candidatos, 6, async ({ nome, cwd }) => {
    const repo = await gitlib.repoPrincipal(cwd);
    if (!repo) return null; // não é repo git — fora da lista
    const d = await gitlib.refDaDevelop(repo);
    const pasta = loja.pastaDo(nome);
    // O sha da verdade é o de DENTRO do grafo publicado (spec, "Quem é a verdade"): o `meta.json`
    // vem depois do `rename` e pode estar um instante atrás. Lido pelo resumo enxuto em cache.
    const grafo = loja.resumoDoGrafo(pasta);
    const shaPub = grafo && grafo.sha;
    let infoGrafo = null;
    if (grafo && shaPub) {
      if (d) {
        const { estado, commitsAtras } = await estadoDoGrafo(repo, shaPub, d.sha);
        infoGrafo = { geradoEm: grafo.analyzedAt, estado, commitsAtras };
      } else {
        infoGrafo = { geradoEm: grafo.analyzedAt, estado: 'desconhecido', commitsAtras: null };
      }
    }
    return { nome, develop: Boolean(d), grafo: infoGrafo };
  });
  const validos = resultados.filter(Boolean);
  validos.sort((a, b) => {
    const temGrafoA = a.grafo ? 0 : 1;
    const temGrafoB = b.grafo ? 0 : 1;
    if (temGrafoA !== temGrafoB) return temGrafoA - temGrafoB;
    return a.nome.localeCompare(b.nome);
  });
  return validos;
}

/**
 * O envelope que o dashboard valida (`isGraphFreshnessResult`, `freshness.ts:95-158`, copiado para
 * o gate com o comentário de origem): `fresh` (mesma árvore, sha pode diferir), `stale` +
 * `relation: 'behind'|'diverged'` (a spec não usa `'ahead'`: cai em `diverged`), `unknown` +
 * `reason: 'graph-commit-unavailable'` quando o sha do grafo não existe mais no repo.
 */
async function freshnessDoGrafo(repo, graphCommitHash, headCommitHash, lastAnalyzedAt) {
  const comData = lastAnalyzedAt ? { lastAnalyzedAt } : {};
  const existe = await gitlib.existeCommit(repo, graphCommitHash);
  if (!existe) {
    return { status: 'unknown', reason: 'graph-commit-unavailable', graphCommitHash, headCommitHash, ...comData };
  }
  const changedFiles = await gitlib.mudados(repo, graphCommitHash, headCommitHash);
  if (changedFiles.length === 0) {
    return {
      status: 'fresh', graphCommitHash, headCommitHash,
      changedFileCount: 0, changedFiles: [], commitsBehind: 0, commitsAhead: 0, ...comData,
    };
  }
  const ancestral = await gitlib.ehAncestral(repo, graphCommitHash, headCommitHash);
  const { frente, atras } = await gitlib.atrasFrente(repo, graphCommitHash, headCommitHash);
  return {
    status: 'stale', relation: ancestral === true ? 'behind' : 'diverged',
    graphCommitHash, headCommitHash,
    changedFileCount: changedFiles.length, changedFiles,
    commitsBehind: atras, commitsAhead: frente, ...comData,
  };
}

// ─── inventario (Fase 8, dry-run) ──────────────────────────────────────────

/** `.ua/knowledge-graph.json`+`meta.json` no disco, até 4 níveis — mesma régua de `bin/grafo.js`
 * `acharUaNoDisco` (herança), mas aqui é só leitura para relatar: não entra no `montarGrafo`. */
function acharPastasUa(raiz, nivel, prefixo, resultado) {
  const uaDir = path.join(raiz, '.ua');
  if (fs.existsSync(path.join(uaDir, 'meta.json'))) {
    resultado.push({ prefixo, metaArq: path.join(uaDir, 'meta.json') });
  }
  if (nivel === 0) return;
  let entradas;
  try { entradas = fs.readdirSync(raiz, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git' || e.name === '.ua') continue;
    acharPastasUa(path.join(raiz, e.name), nivel - 1, `${prefixo}${e.name}/`, resultado);
  }
}

/** Cada `.ua/` legado achado: motor (`meta.engine` ou `llm`), sha e estado contra a develop —
 * reaproveita `estadoDoGrafo` (mesma régua em-dia/atras/fora/desconhecido da loja do Cockpit). */
async function listarUaLegado(repo, develop) {
  const achados = [];
  acharPastasUa(repo, 4, '', achados);
  const resultado = [];
  for (const a of achados) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(a.metaArq, 'utf8')); } catch { continue; }
    const motor = meta.engine || 'llm';
    const sha = meta.gitCommitHash || null;
    let estadoTxt = 'desconhecido';
    if (sha && develop) {
      const { estado, commitsAtras } = await estadoDoGrafo(repo, sha, develop.sha);
      if (estado === 'em-dia') estadoTxt = 'em dia';
      else if (estado === 'atras') estadoTxt = `${commitsAtras} atras`;
      else if (estado === 'fora') estadoTxt = 'fora da develop';
    }
    resultado.push({
      pasta: a.prefixo || '.', motor, geradoEm: meta.lastAnalyzedAt || null,
      sha: sha ? sha.slice(0, 7) : null, estado: estadoTxt,
    });
  }
  return resultado;
}

/** `quebrado` (algum `node`/`grafo.js` gravado sumiu), `não` (nenhum bloco do Cockpit), `instalado`
 * (os quatro com o bloco) ou `parcial` (alguns — por exemplo, um hook de terceiro ficou intocado).
 * Hook de terceiro NÃO conta como instalado: ele não chama o gerador (achado do painel de execução). */
function resumoHook(relatorioStatus) {
  const estados = hooklib.HOOKS.map((h) => relatorioStatus[h].estado);
  if (estados.some((e) => e === 'quebrado')) return 'quebrado';
  const comBloco = estados.filter((e) => e === 'instalado').length;
  if (comBloco === 0) return 'não';
  return comBloco === estados.length ? 'instalado' : 'parcial';
}

async function contarArquivosCodigo(repo, sha) {
  const arv = await gitlib.arvore(repo, sha);
  return arv.filter((e) => deveIndexar(e.caminho, e.tamanho)).length;
}

/**
 * Uma entrada por pasta de `raiz` (spec Fase 4/plano §8.1): `{ pasta, git, nomeValido, develop,
 * loja, uaLegado, hookCockpit, hookUaLegado, arquivosCodigo }`. Só leitura — nenhum `git` de
 * escrita, nenhum arquivo novo. Ordenado por nome da pasta.
 */
async function inventario(raiz) {
  const entradas = fs.readdirSync(raiz, { withFileTypes: true }).filter((e) => e.isDirectory());
  const resultado = [];
  for (const e of entradas) {
    const pastaAbs = path.join(raiz, e.name);
    const repo = await gitlib.repoPrincipal(pastaAbs);
    const item = { pasta: e.name, git: Boolean(repo), nomeValido: NOME_DE_PASTA.test(e.name) };
    if (!repo) {
      item.develop = null; item.loja = null; item.uaLegado = [];
      item.hookCockpit = 'não'; item.hookUaLegado = false; item.arquivosCodigo = null;
      resultado.push(item);
      continue;
    }
    const d = await gitlib.refDaDevelop(repo);
    item.develop = d ? { ref: d.ref, sha: d.sha.slice(0, 7) } : null;

    // Nome fora do padrão não tem loja (a rota nem o aceitaria) — e `pastaDo` lançaria, derrubando o
    // inventário inteiro por uma pasta (achado do painel de execução).
    const grafo = item.nomeValido ? loja.resumoDoGrafo(loja.pastaDo(e.name)) : null;
    const shaPub = grafo && grafo.sha;
    if (grafo && shaPub) {
      if (d) {
        const { estado, commitsAtras } = await estadoDoGrafo(repo, shaPub, d.sha);
        item.loja = { geradoEm: grafo.analyzedAt, estado, commitsAtras };
      } else {
        item.loja = { geradoEm: grafo.analyzedAt, estado: 'desconhecido', commitsAtras: null };
      }
    } else {
      item.loja = null;
    }

    item.uaLegado = await listarUaLegado(repo, d);
    const statusHook = await hooklib.status(repo);
    item.hookCockpit = resumoHook(statusHook);
    item.hookUaLegado = Boolean(statusHook['post-commit'] && statusHook['post-commit'].legadoUaGrafo);
    item.arquivosCodigo = d ? await contarArquivosCodigo(repo, d.sha) : null;
    resultado.push(item);
  }
  resultado.sort((a, b) => a.pasta.localeCompare(b.pasta));
  return resultado;
}

module.exports = { NOME_DE_PASTA, estadoDoGrafo, resumoParaTela, freshnessDoGrafo, inventario };
