'use strict';
/**
 * Mapa simples do grafo (card `grafo-mapa-simples`, D91) — agrega o grafo do projeto num índice
 * compacto e devolve só o pedaço do nível pedido (M5/M6 da spec). `#22`: nada do pedido vira
 * caminho de disco aqui — `montarIndice`/`nivel1`/`nivel2`/`nivel3` só indexam `Map`s montados a
 * partir do próprio grafo; só `indiceDo` toca o disco, e sempre pela pasta já resolvida por quem
 * chama (`grafoLoja.pastaDo`).
 *
 * Regras da agregação (spec "Regras da agregação"):
 * - Arquivo de um nó = `node.filePath`; camada de um arquivo = a camada que lista o nó `file:`
 *   dele (a 1ª, na ordem de `grafo.layers`).
 * - Ligação = aresta `imports`/`calls` cujo arquivo-origem ≠ arquivo-destino; `contains`/`exports`
 *   nunca contam. Peso = nº de arestas (não o campo `weight` do grafo).
 * - Grafo sem `layers` → uma camada sintética `layer:(tudo)`; arquivo fora de toda camada →
 *   `layer:(sem camada)`. Nó sem `filePath` string não vazia é ignorado.
 */

const fs = require('node:fs');
const path = require('node:path');
const grafoLoja = require('./grafo-loja');

const TETO_NIVEL3 = 60;
const LRU_MAX = 3;

/** Ordem por código de caractere (`<`), igual em qualquer Node — `localeCompare` sem locale depende do ICU do build. */
const cmpTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ─── montarIndice ───────────────────────────────────────────────────────────

/** Maior prefixo comum POR SEGMENTO das pastas (`''` = raiz do repo). */
function prefixoComumPorSegmento(dirs) {
  if (dirs.length === 0) return '';
  let comum = dirs[0] === '' ? [] : dirs[0].split('/');
  for (let i = 1; i < dirs.length && comum.length > 0; i += 1) {
    const atual = dirs[i] === '' ? [] : dirs[i].split('/');
    let j = 0;
    while (j < comum.length && j < atual.length && comum[j] === atual[j]) j += 1;
    comum = comum.slice(0, j);
  }
  return comum.join('/');
}

/** Árvore crua (por segmento) de uma camada, abaixo da raiz comum. */
function construirArvore(raizDir, itens) {
  const nodes = new Map(); // pasta real -> { pasta, rotulo, mae, subpastas:Set, arquivos:[] }
  nodes.set(raizDir, { pasta: raizDir, rotulo: raizDir === '' ? '(raiz)' : raizDir, mae: null, subpastas: new Set(), arquivos: [] });

  const garantir = (pastaCompleta, maePasta, rotuloSeg) => {
    if (!nodes.has(pastaCompleta)) {
      nodes.set(pastaCompleta, { pasta: pastaCompleta, rotulo: rotuloSeg, mae: maePasta, subpastas: new Set(), arquivos: [] });
      nodes.get(maePasta).subpastas.add(pastaCompleta);
    }
    return nodes.get(pastaCompleta);
  };

  for (const { caminho, dir } of itens) {
    const resto = dir === raizDir ? '' : (raizDir === '' ? dir : dir.slice(raizDir.length + 1));
    if (resto === '') {
      nodes.get(raizDir).arquivos.push(caminho);
      continue;
    }
    const segs = resto.split('/');
    let atual = raizDir;
    for (const seg of segs) {
      const completo = atual === '' ? seg : `${atual}/${seg}`;
      garantir(completo, atual, seg);
      atual = completo;
    }
    nodes.get(atual).arquivos.push(caminho);
  }
  return nodes;
}

/** Pasta não-raiz com 1 subpasta e 0 arquivos diretos some; o filho herda `segPai/segFilho`. */
function comprimirArvore(nodes, raizDir) {
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const pastaChave of [...nodes.keys()]) {
      if (pastaChave === raizDir) continue;
      const node = nodes.get(pastaChave);
      if (!node) continue;
      if (node.subpastas.size === 1 && node.arquivos.length === 0) {
        const filhoChave = [...node.subpastas][0];
        const filho = nodes.get(filhoChave);
        filho.rotulo = `${node.rotulo}/${filho.rotulo}`;
        filho.mae = node.mae;
        const maeNode = nodes.get(node.mae);
        maeNode.subpastas.delete(pastaChave);
        maeNode.subpastas.add(filho.pasta);
        nodes.delete(pastaChave);
        mudou = true;
      }
    }
  }
}

/** `total` = arquivos na subárvore inteira (próprios + das subpastas), recursivo. */
function calcularTotais(nodes) {
  const memo = new Map();
  const totalDe = (pastaChave) => {
    if (memo.has(pastaChave)) return memo.get(pastaChave);
    const node = nodes.get(pastaChave);
    let t = node.arquivos.length;
    for (const sub of node.subpastas) t += totalDe(sub);
    memo.set(pastaChave, t);
    return t;
  };
  for (const pastaChave of nodes.keys()) nodes.get(pastaChave).total = totalDe(pastaChave);
}

function montarIndice(grafo) {
  const nodesById = new Map();
  for (const n of grafo.nodes || []) nodesById.set(n.id, n);

  // 1. `noArq`: só nós com `filePath` string não vazia.
  const noArq = new Map();
  for (const n of grafo.nodes || []) {
    if (typeof n.filePath === 'string' && n.filePath !== '') noArq.set(n.id, n.filePath);
  }

  // 2. camada de cada arquivo — a 1ª camada (na ordem de `grafo.layers`) que lista o nó `file:` dele.
  const layersRaw = grafo.layers || [];
  const semLayers = layersRaw.length === 0;
  const camadaPorArquivo = new Map(); // filePath -> layerId
  if (!semLayers) {
    for (const layer of layersRaw) {
      for (const nodeId of layer.nodeIds || []) {
        const no = nodesById.get(nodeId);
        if (!no || no.type !== 'file') continue;
        const fp = no.filePath;
        if (typeof fp !== 'string' || fp === '' || camadaPorArquivo.has(fp)) continue;
        camadaPorArquivo.set(fp, layer.id);
      }
    }
  }
  const layerDeclarado = new Map(layersRaw.map((l) => [l.id, l]));

  // 3. `arquivos`: um registro por nó `type === 'file'` com `filePath`.
  const arquivos = new Map();
  for (const n of grafo.nodes || []) {
    if (n.type !== 'file') continue;
    const fp = n.filePath;
    if (typeof fp !== 'string' || fp === '' || arquivos.has(fp)) continue;
    let camadaId;
    if (semLayers) camadaId = 'layer:(tudo)';
    else if (camadaPorArquivo.has(fp)) camadaId = camadaPorArquivo.get(fp);
    else camadaId = 'layer:(sem camada)';
    arquivos.set(fp, { nome: path.posix.basename(fp), camadaId, pasta: null, simbolos: [], usa: new Map(), usadoPor: new Map() });
  }

  // 4. símbolos: todo nó não-arquivo cujo `filePath` é um arquivo conhecido.
  for (const n of grafo.nodes || []) {
    if (n.type === 'file') continue;
    const fp = noArq.get(n.id);
    if (fp === undefined || !arquivos.has(fp)) continue;
    arquivos.get(fp).simbolos.push([String(n.name ?? ''), String(n.type ?? ''), Array.isArray(n.lineRange) ? n.lineRange : null]);
  }
  for (const arq of arquivos.values()) {
    arq.simbolos.sort((a, b) => {
      const la = a[2] ? a[2][0] : Infinity;
      const lb = b[2] ? b[2][0] : Infinity;
      if (la !== lb) return la - lb;
      return cmpTexto(a[0], b[0]);
    });
  }

  // 5. ligações de arquivo e de camada.
  const ligacoes = new Map(); // 'de\0para' -> peso
  for (const e of grafo.edges || []) {
    if (e.type !== 'imports' && e.type !== 'calls') continue;
    const s = noArq.get(e.source);
    const t = noArq.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    const aS = arquivos.get(s);
    const aT = arquivos.get(t);
    if (!aS || !aT) continue;
    aS.usa.set(t, (aS.usa.get(t) || 0) + 1);
    aT.usadoPor.set(s, (aT.usadoPor.get(s) || 0) + 1);
    if (aS.camadaId !== aT.camadaId) {
      const chave = `${aS.camadaId}\u0000${aT.camadaId}`;
      ligacoes.set(chave, (ligacoes.get(chave) || 0) + 1);
    }
  }

  // 6. árvore de pastas por camada.
  const porCamada = new Map(); // camadaId -> [caminho]
  for (const [caminho, arq] of arquivos) {
    if (!porCamada.has(arq.camadaId)) porCamada.set(arq.camadaId, []);
    porCamada.get(arq.camadaId).push(caminho);
  }

  const camadas = new Map();
  for (const [camadaId, caminhos] of porCamada) {
    let nome;
    if (camadaId === 'layer:(tudo)') nome = '(tudo)';
    else if (camadaId === 'layer:(sem camada)') nome = '(sem camada)';
    else {
      const layer = layerDeclarado.get(camadaId);
      nome = String((layer && layer.name) || camadaId).replace(/^layer:/, '');
    }

    const itens = caminhos.map((caminho) => ({ caminho, dir: path.posix.dirname(caminho) === '.' ? '' : path.posix.dirname(caminho) }));
    const raizDir = prefixoComumPorSegmento(itens.map((i) => i.dir));
    const nodes = construirArvore(raizDir, itens);
    comprimirArvore(nodes, raizDir);
    calcularTotais(nodes);

    for (const node of nodes.values()) {
      for (const caminho of node.arquivos) arquivos.get(caminho).pasta = node.pasta;
    }

    let simbolos = 0;
    for (const caminho of caminhos) simbolos += arquivos.get(caminho).simbolos.length;

    camadas.set(camadaId, { id: camadaId, nome, raiz: raizDir, arquivos: caminhos.length, simbolos, pastas: nodes });
  }

  return {
    projeto: (grafo.project && grafo.project.name) || null,
    geradoEm: (grafo.project && grafo.project.analyzedAt) || null,
    arquivos, camadas, ligacoes,
  };
}

// ─── nivel1/nivel2/nivel3 ───────────────────────────────────────────────────

function nomeDaCamada(ind, camadaId) {
  const c = ind.camadas.get(camadaId);
  return c ? c.nome : camadaId;
}

function nivel1(ind) {
  const camadasArr = [...ind.camadas.values()]
    .map((c) => ({ id: c.id, nome: c.nome, pasta: c.raiz, arquivos: c.arquivos, simbolos: c.simbolos }))
    .sort((a, b) => {
      if (b.arquivos !== a.arquivos) return b.arquivos - a.arquivos;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });

  const ligacoesArr = [...ind.ligacoes.entries()].map(([chave, peso]) => {
    const [de, para] = chave.split('\u0000');
    return { de, para, peso };
  });

  let totalArquivos = 0;
  let totalSimbolos = 0;
  for (const c of ind.camadas.values()) { totalArquivos += c.arquivos; totalSimbolos += c.simbolos; }

  return {
    nivel: 1,
    cabecalho: { projeto: ind.projeto, geradoEm: ind.geradoEm },
    totais: { arquivos: totalArquivos, simbolos: totalSimbolos, camadas: ind.camadas.size },
    camadas: camadasArr,
    ligacoes: ligacoesArr,
  };
}

/** Da raiz da camada até `node` (nó da árvore comprimida), pra a trilha dos níveis 2 e 3. */
function trilhaAte(camada, node) {
  const trilha = [];
  let atual = node;
  while (atual) {
    trilha.unshift({ rotulo: atual.rotulo, pasta: atual.pasta });
    atual = atual.mae !== null ? camada.pastas.get(atual.mae) : null;
  }
  return trilha;
}

function nivel2(ind, camadaId, pastaParam) {
  const camada = ind.camadas.get(camadaId);
  if (!camada) return null;
  const pasta = (pastaParam === undefined || pastaParam === null) ? camada.raiz : pastaParam;
  const node = camada.pastas.get(pasta);
  if (!node) return null;

  const trilha = trilhaAte(camada, node);

  const subpastas = [...node.subpastas]
    .map((p) => camada.pastas.get(p))
    .map((n) => ({ pasta: n.pasta, rotulo: n.rotulo, arquivos: n.total }))
    .sort((a, b) => (b.arquivos - a.arquivos) || cmpTexto(a.pasta, b.pasta));

  const arquivosResp = node.arquivos
    .map((caminho) => {
      const arq = ind.arquivos.get(caminho);
      return { caminho, nome: arq.nome, simbolos: arq.simbolos.length, usa: arq.usa.size, usadoPor: arq.usadoPor.size };
    })
    .sort((a, b) => ((b.usa + b.usadoPor) - (a.usa + a.usadoPor)) || cmpTexto(a.caminho, b.caminho));

  const topoDaLista = (de) => {
    const lista = [];
    for (const [chave, peso] of ind.ligacoes) {
      const [c1, c2] = chave.split('\u0000');
      if (de && c1 === camadaId) lista.push({ id: c2, nome: nomeDaCamada(ind, c2), peso });
      if (!de && c2 === camadaId) lista.push({ id: c1, nome: nomeDaCamada(ind, c1), peso });
    }
    lista.sort((a, b) => (b.peso - a.peso) || cmpTexto(a.id, b.id));
    return lista.slice(0, 5);
  };

  return {
    nivel: 2,
    cabecalho: { projeto: ind.projeto, geradoEm: ind.geradoEm },
    camada: { id: camada.id, nome: camada.nome, pasta: camada.raiz },
    ligacoesDaCamada: { usa: topoDaLista(true), usadaPor: topoDaLista(false) },
    pasta,
    trilha,
    subpastas,
    arquivos: arquivosResp,
  };
}

function nivel3(ind, caminho, opcoes) {
  const arq = ind.arquivos.get(caminho);
  if (!arq) return null;
  const completo = !!(opcoes && opcoes.completo);
  const camada = ind.camadas.get(arq.camadaId);

  const montarLista = (mapaDePesos) => {
    const todos = [...mapaDePesos.entries()]
      .map(([c, peso]) => ({ caminho: c, nome: ind.arquivos.get(c).nome, peso }))
      .sort((a, b) => (b.peso - a.peso) || cmpTexto(a.caminho, b.caminho));
    const itens = completo ? todos : todos.slice(0, TETO_NIVEL3);
    return { total: todos.length, itens };
  };

  return {
    nivel: 3,
    cabecalho: { projeto: ind.projeto, geradoEm: ind.geradoEm },
    arquivo: { caminho, nome: arq.nome, camada: { id: camada.id, nome: camada.nome }, pasta: arq.pasta },
    // Painel de execução (Codex): a trilha do nível 3 só tinha a última pasta — os ancestrais sumiam.
    trilha: trilhaAte(camada, camada.pastas.get(arq.pasta)),
    simbolos: arq.simbolos.map(([nome, tipo, linhas]) => ({ nome, tipo, linhas })),
    usa: montarLista(arq.usa),
    usadoPor: montarLista(arq.usadoPor),
  };
}

// ─── indiceDo — leitor com cache LRU, chaveado por (mtimeMs, size, ino) (M5/R1/#114) ───────────

const cache = new Map(); // arquivo -> { chave, indice, bytes }
let contadorDeParse = 0;

function indiceDo(pasta) {
  const arquivo = grafoLoja.arquivoDoGrafo(pasta, false);
  let st;
  try { st = fs.statSync(arquivo); } catch { return null; }
  const chave = `${st.mtimeMs}:${st.size}:${st.ino}`;

  const cacheado = cache.get(arquivo);
  if (cacheado && cacheado.chave === chave) {
    cache.delete(arquivo);
    cache.set(arquivo, cacheado); // move pro fim (mais recente)
    return { indice: cacheado.indice, bytes: st.size };
  }

  let grafo;
  try { grafo = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return null; }
  contadorDeParse += 1;
  const indice = montarIndice(grafo);
  cache.delete(arquivo); // versão velha sai antes: a nova entra no FIM (a mais recente do LRU)
  cache.set(arquivo, { chave, indice, bytes: st.size });
  if (cache.size > LRU_MAX) cache.delete(cache.keys().next().value);
  return { indice, bytes: st.size };
}

module.exports = {
  montarIndice, nivel1, nivel2, nivel3, indiceDo,
  _contadorDeParse: () => contadorDeParse,
};
