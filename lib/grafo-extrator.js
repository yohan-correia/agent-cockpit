'use strict';
/**
 * Junta os extratores (`grafo-js.js`, e depois `grafo-python.js`/`grafo-html.js`) num grafo só,
 * no formato do understand-anything. Função pura: `arquivos`/`configs` já vieram prontos (de um
 * `git ls-tree`+`cat-file`, ou de um disco de fixture no gate) — o git e o disco ficam fora dela.
 *
 * Ver spec "Fase 1" e plano §1.5. Construída em três unidades (1a JS/TS, 1b Python, 1c HTML +
 * herança + camadas); esta versão cobre JS/TS (1a).
 */

const path = require('node:path');
const { extrairJs } = require('./grafo-js.js');
const { extrairHtml } = require('./grafo-html.js');

const EXTENSOES = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.html', '.htm', '.css'];
const EXTENSOES_JS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const SEGMENTOS_EXCLUIDOS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__', '.ua']);
const TAMANHO_MAXIMO = 512 * 1024;

function deveIndexar(caminho, tamanho) {
  const ext = path.posix.extname(caminho);
  if (!EXTENSOES.includes(ext)) return false;
  if (caminho.endsWith('.min.js') || caminho.endsWith('.min.css')) return false;
  const segmentos = caminho.split('/');
  if (segmentos.some((s) => SEGMENTOS_EXCLUIDOS.has(s))) return false;
  if (tamanho > TAMANHO_MAXIMO) return false;
  return true;
}

function complexidadePorLinhas(n, limiteSimple, limiteModerate) {
  if (n < limiteSimple) return 'simple';
  if (n < limiteModerate) return 'moderate';
  return 'complex';
}

function contarLinhas(texto) {
  if (texto === '') return 1;
  return texto.split('\n').length;
}

// ─── resolução JS/TS ────────────────────────────────────────────────────────

function parseJsonTolerante(texto) {
  let out = '';
  let dentroStr = false;
  let aspas = '';
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (dentroStr) {
      out += c;
      if (c === '\\') { out += texto[i + 1] || ''; i += 1; continue; }
      if (c === aspas) dentroStr = false;
      continue;
    }
    if (c === '"' || c === "'") { dentroStr = true; aspas = c; out += c; continue; }
    if (c === '/' && texto[i + 1] === '/') { while (i < texto.length && texto[i] !== '\n') i += 1; out += '\n'; continue; }
    if (c === '/' && texto[i + 1] === '*') {
      i += 2;
      while (i < texto.length && !(texto[i] === '*' && texto[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

function acharTsconfigMaisProximo(deArquivo, configs) {
  let dir = path.posix.dirname(deArquivo);
  for (;;) {
    for (const nome of ['tsconfig.json', 'jsconfig.json']) {
      const cand = dir === '.' ? nome : `${dir}/${nome}`;
      if (configs.has(cand)) return cand;
    }
    if (dir === '.') return null;
    const pai = path.posix.dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
}

function resolverPorPaths(especificador, tsconfigCaminho, configs) {
  let cfg;
  try { cfg = parseJsonTolerante(configs.get(tsconfigCaminho)); } catch { return null; }
  const co = cfg && cfg.compilerOptions;
  if (!co || !co.paths) return null;
  const dirTsconfig = path.posix.dirname(tsconfigCaminho);
  const baseUrl = co.baseUrl || '.';
  const dirBase = dirTsconfig === '.' ? baseUrl : path.posix.join(dirTsconfig, baseUrl);
  for (const chave of Object.keys(co.paths)) {
    const i = chave.indexOf('*');
    if (i < 0) continue;
    const prefixo = chave.slice(0, i);
    const sufixo = chave.slice(i + 1);
    if (!especificador.startsWith(prefixo) || !especificador.endsWith(sufixo)) continue;
    const resto = especificador.slice(prefixo.length, especificador.length - sufixo.length || undefined);
    for (const valor of co.paths[chave]) {
      const alvo = valor.replace('*', resto);
      return path.posix.normalize(path.posix.join(dirBase, alvo));
    }
  }
  return null;
}

function resolverRelativoArquivo(destino, arquivosSet) {
  const extsJsTs = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
  const extConhecida = extsJsTs.find((e) => destino.endsWith(e)) || (destino.endsWith('.css') ? '.css' : null);
  if (extConhecida) {
    if (arquivosSet.has(destino)) return destino;
    if (['.js', '.mjs', '.cjs'].includes(extConhecida)) {
      const semExt = destino.slice(0, -extConhecida.length);
      for (const alt of ['.ts', '.tsx', '.mts', '.cts']) {
        if (arquivosSet.has(semExt + alt)) return semExt + alt;
      }
    }
    return null;
  }
  if (arquivosSet.has(destino)) return destino;
  for (const e of extsJsTs) if (arquivosSet.has(destino + e)) return destino + e;
  for (const e of extsJsTs) if (arquivosSet.has(`${destino}/index${e}`)) return `${destino}/index${e}`;
  return null;
}

function resolverJs(deArquivo, especificador, configs, arquivosSet) {
  if (especificador.startsWith('./') || especificador.startsWith('../')) {
    const destino = path.posix.normalize(path.posix.join(path.posix.dirname(deArquivo), especificador));
    return resolverRelativoArquivo(destino, arquivosSet);
  }
  const tsconfigCaminho = acharTsconfigMaisProximo(deArquivo, configs);
  if (!tsconfigCaminho) return null;
  const destino = resolverPorPaths(especificador, tsconfigCaminho, configs);
  if (!destino) return null;
  return resolverRelativoArquivo(destino, arquivosSet);
}

// ─── resolução Python ───────────────────────────────────────────────────────

function dirnameNVezes(caminho, n) {
  let p = caminho;
  for (let i = 0; i < n; i += 1) p = path.posix.dirname(p);
  return p;
}

/** Procura `dotted` (módulo absoluto `a.b`) em cada raiz, tentando os candidatos de `candidatos(moduloPath)`. */
function resolverModuloAbsolutoPy(dotted, raizes, arquivosSet, candidatos) {
  if (!dotted) return null;
  const relPath = dotted.split('.').join('/');
  for (const raiz of raizes) {
    const moduloPath = path.posix.normalize(path.posix.join(raiz, relPath));
    for (const cand of candidatos(moduloPath)) {
      if (arquivosSet.has(cand)) return cand;
    }
  }
  return null;
}

/**
 * Resolve o arquivo de uma entrada de import (plano §1.5 "Resolução Python"). `nomeObj` é o
 * `{nome, como}` específico (para `import`, `nome` é o módulo pontilhado inteiro; para `from`,
 * `nome` é o `y` de `from X import y`).
 */
function resolverPyAlvo(caminho, entrada, nomeObj, syspath, arquivosSet) {
  const raizes = [path.posix.dirname(caminho), ...syspath, '.'];
  if (entrada.tipo === 'import') {
    return resolverModuloAbsolutoPy(nomeObj.nome, raizes, arquivosSet, (mp) => [`${mp}.py`, path.posix.join(mp, '__init__.py')]);
  }
  const y = nomeObj.nome;
  if (entrada.nivel > 0) {
    const baseDir = dirnameNVezes(path.posix.dirname(caminho), entrada.nivel - 1);
    const moduloPath = entrada.modulo
      ? path.posix.normalize(path.posix.join(baseDir, entrada.modulo.split('.').join('/')))
      : baseDir;
    const candidatos = [
      path.posix.join(moduloPath, `${y}.py`),
      path.posix.join(moduloPath, y, '__init__.py'),
      `${moduloPath}.py`,
      path.posix.join(moduloPath, '__init__.py'),
    ];
    return candidatos.find((c) => arquivosSet.has(c)) || null;
  }
  return resolverModuloAbsolutoPy(entrada.modulo, raizes, arquivosSet, (mp) => [
    path.posix.join(mp, `${y}.py`),
    path.posix.join(mp, y, '__init__.py'),
    `${mp}.py`,
    path.posix.join(mp, '__init__.py'),
  ]);
}

// ─── resolução HTML ─────────────────────────────────────────────────────────

function resolverHtml(deArquivo, ref, arquivosSet) {
  const dir = path.posix.dirname(deArquivo);
  if (ref.startsWith('/')) {
    const semBarra = ref.slice(1);
    const candRelativo = path.posix.normalize(path.posix.join(dir, semBarra));
    if (arquivosSet.has(candRelativo)) return candRelativo;
    const candRaiz = path.posix.normalize(semBarra);
    if (arquivosSet.has(candRaiz)) return candRaiz;
    return null;
  }
  const cand = path.posix.normalize(path.posix.join(dir, ref));
  return arquivosSet.has(cand) ? cand : null;
}

// ─── herança da camada semântica e camadas ─────────────────────────────────

/** `type:caminho[:nome]` com `prefixo` removido do caminho — `null` se o id não começa com ele. */
function idSemPrefixo(id, prefixo) {
  if (prefixo === '') return id;
  const i = id.indexOf(':');
  if (i < 0) return null;
  const resto = id.slice(i + 1);
  if (!resto.startsWith(prefixo)) return null;
  return `${id.slice(0, i)}:${resto.slice(prefixo.length)}`;
}

/** Inverso de `idSemPrefixo`: acrescenta `prefixo` ao caminho embutido no id. */
function idComPrefixo(id, prefixo) {
  if (prefixo === '') return id;
  const i = id.indexOf(':');
  if (i < 0) return id;
  return `${id.slice(0, i)}:${prefixo}${id.slice(i + 1)}`;
}

function segmentoDeCamada(filePath) {
  const i = filePath.indexOf('/');
  return i < 0 ? 'raiz' : filePath.slice(0, i);
}

// ─── montarGrafo ────────────────────────────────────────────────────────────

function idDeclaracao(caminho, decl) {
  return `${decl.tipo === 'class' ? 'class' : 'function'}:${caminho}:${decl.nome}`;
}

function montarGrafo({ arquivos, configs = new Map(), sha, ref, nome, analisadoEm, python, heranca = [], anterior = null }) {
  void ref;
  const avisos = [];
  const pythonIndisponivel = python && python.indisponivel ? python : null;
  if (pythonIndisponivel) avisos.push(`python3 indisponível (${pythonIndisponivel.motivo}) — arquivos .py ficaram sem análise`);
  const pythonPorArquivo = new Map(); // caminho -> registro de lib/grafo-python.py (sem erro)
  if (Array.isArray(python)) {
    for (const registro of python) {
      if (registro.erro) { avisos.push(`arquivo python com erro de sintaxe: ${registro.caminho} (${registro.erro})`); continue; }
      pythonPorArquivo.set(registro.caminho, registro);
    }
  }
  const nodes = new Map();
  const edgesChave = new Set();
  const edges = [];

  const addNode = (id, dados) => { if (!nodes.has(id)) nodes.set(id, { id, ...dados }); };
  const addEdge = (source, target, type, weight) => {
    if (source === target) return;
    if (!nodes.has(source) || !nodes.has(target)) return;
    const chave = `${source}|${target}|${type}`;
    if (edgesChave.has(chave)) return;
    edgesChave.add(chave);
    edges.push({ source, target, type, direction: 'forward', weight });
  };

  // ── arquivos que viram nó ────────────────────────────────────────────────
  const arquivosIndexados = new Map(); // caminho -> texto (só os que passam deveIndexar)
  let maiorQue512kb = 0;
  for (const [caminho, texto] of arquivos) {
    const tamanho = Buffer.byteLength(texto, 'utf8');
    const ext = path.posix.extname(caminho);
    if (!EXTENSOES.includes(ext)) continue;
    if (caminho.endsWith('.min.js') || caminho.endsWith('.min.css')) continue;
    const segmentos = caminho.split('/');
    if (segmentos.some((s) => SEGMENTOS_EXCLUIDOS.has(s))) continue;
    if (tamanho > TAMANHO_MAXIMO) { maiorQue512kb += 1; continue; }
    arquivosIndexados.set(caminho, texto);
  }
  if (maiorQue512kb > 0) avisos.push(`${maiorQue512kb} arquivo(s) acima de 512 KB ficaram de fora`);

  const arquivosSet = new Set(arquivosIndexados.keys());
  const extraidoJsPorArquivo = new Map(); // caminho -> retorno de extrairJs

  for (const [caminho, texto] of arquivosIndexados) {
    const linhasArquivo = contarLinhas(texto);
    addNode(`file:${caminho}`, {
      type: 'file',
      name: path.posix.basename(caminho),
      filePath: caminho,
      summary: '',
      tags: [],
      complexity: complexidadePorLinhas(linhasArquivo, 150, 500),
    });

    const ext = path.posix.extname(caminho);
    if (EXTENSOES_JS.has(ext)) {
      const extraido = extrairJs(caminho, texto);
      extraidoJsPorArquivo.set(caminho, extraido);
      for (const decl of extraido.declaracoes) {
        const id = idDeclaracao(caminho, decl);
        addNode(id, {
          type: decl.tipo,
          name: decl.nome,
          filePath: caminho,
          summary: '',
          tags: [],
          complexity: complexidadePorLinhas(decl.fim - decl.ini + 1, 30, 120),
          lineRange: [decl.ini, decl.fim],
        });
      }
    } else if (ext === '.py' && pythonPorArquivo.has(caminho)) {
      for (const decl of pythonPorArquivo.get(caminho).decls) {
        const id = idDeclaracao(caminho, decl);
        addNode(id, {
          type: decl.tipo,
          name: decl.nome,
          filePath: caminho,
          summary: '',
          tags: [],
          complexity: complexidadePorLinhas(decl.fim - decl.ini + 1, 30, 120),
          lineRange: [decl.ini, decl.fim],
        });
      }
    }
  }

  // ── arestas: contains, exports, imports, calls (JS/TS) ──────────────────
  for (const [caminho, extraido] of extraidoJsPorArquivo) {
    const fileId = `file:${caminho}`;
    const declPorNome = new Map(extraido.declaracoes.map((d) => [d.nome, d]));

    for (const decl of extraido.declaracoes) addEdge(fileId, idDeclaracao(caminho, decl), 'contains', 1.0);

    for (const { local, nome: nomeExportado } of extraido.exportados) {
      const decl = declPorNome.get(local);
      if (decl) addEdge(fileId, idDeclaracao(caminho, decl), 'exports', 0.8);
      void nomeExportado;
    }

    for (const imp of extraido.imports) {
      const alvo = resolverJs(caminho, imp.especificador, configs, arquivosSet);
      if (alvo) addEdge(fileId, `file:${alvo}`, 'imports', 0.7);
    }
  }

  for (const [caminho, registro] of pythonPorArquivo) {
    const fileId = `file:${caminho}`;
    const declPorNome = new Map(registro.decls.map((d) => [d.nome, d]));

    for (const decl of registro.decls) addEdge(fileId, idDeclaracao(caminho, decl), 'contains', 1.0);

    const nomesExportados = Array.isArray(registro.todos)
      ? registro.todos
      : registro.decls.filter((d) => !d.nome.includes('.') && !d.nome.startsWith('_')).map((d) => d.nome);
    for (const nomeExp of nomesExportados) {
      const decl = declPorNome.get(nomeExp);
      if (decl) addEdge(fileId, idDeclaracao(caminho, decl), 'exports', 0.8);
    }

    for (const entrada of registro.imports) {
      for (const nomeObj of entrada.nomes) {
        const alvo = resolverPyAlvo(caminho, entrada, nomeObj, registro.syspath, arquivosSet);
        if (alvo) addEdge(fileId, `file:${alvo}`, 'imports', 0.7);
      }
    }
  }

  for (const [caminho, texto] of arquivosIndexados) {
    const ext = path.posix.extname(caminho);
    if (ext !== '.html' && ext !== '.htm') continue;
    const fileId = `file:${caminho}`;
    for (const ref of extrairHtml(texto)) {
      const alvo = resolverHtml(caminho, ref, arquivosSet);
      if (alvo) addEdge(fileId, `file:${alvo}`, 'depends_on', 0.6);
    }
  }

  // segundo passo: calls, que podem apontar para outro arquivo já processado
  for (const [caminho, extraido] of extraidoJsPorArquivo) {
    const fileId = `file:${caminho}`;
    const declPorNome = new Map(extraido.declaracoes.map((d) => [d.nome, d]));
    const exportadoPorNome = new Map(extraido.imports ? [] : []); // placeholder, não usado aqui

    for (const chamada of extraido.chamadas) {
      const sourceId = chamada.dono ? idDeclaracao(caminho, declPorNome.get(chamada.dono) || { tipo: 'function', nome: chamada.dono }) : fileId;
      const alvoId = resolverAlvoChamada(caminho, chamada, extraido, declPorNome, extraidoJsPorArquivo, configs, arquivosSet);
      if (alvoId) addEdge(sourceId, alvoId, 'calls', 0.8);
    }
    void exportadoPorNome;
  }

  for (const [caminho, registro] of pythonPorArquivo) {
    const fileId = `file:${caminho}`;
    const declPorNome = new Map(registro.decls.map((d) => [d.nome, d]));

    for (const chamada of registro.chamadas) {
      const sourceId = chamada.dono ? idDeclaracao(caminho, declPorNome.get(chamada.dono) || { tipo: 'function', nome: chamada.dono }) : fileId;
      const alvoId = resolverAlvoChamadaPy(caminho, chamada, registro, declPorNome, pythonPorArquivo, arquivosSet);
      if (alvoId) addEdge(sourceId, alvoId, 'calls', 0.8);
    }
  }

  // ── linguagens detectadas ────────────────────────────────────────────────
  const languages = new Set();
  for (const caminho of arquivosIndexados.keys()) {
    const ext = path.posix.extname(caminho);
    if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) languages.add('typescript');
    else if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) languages.add('javascript');
    else if (ext === '.py') languages.add('python');
    else if (ext === '.html' || ext === '.htm') languages.add('html');
    else if (ext === '.css') languages.add('css');
  }

  // ── herança da camada semântica (summary/tags/languageNotes/camada) e tour ─
  const fontes = [...heranca, ...(anterior ? [{ prefixo: '', grafo: anterior }] : [])];
  const camadaPorNode = new Map(); // node.id -> { id, name, description }
  let herdados = 0;

  for (const no of nodes.values()) {
    let camadaHerdada = null;
    for (const fonte of fontes) {
      const idProcurado = idSemPrefixo(no.id, fonte.prefixo);
      if (idProcurado === null) continue;
      const noFonte = (fonte.grafo.nodes || []).find((n) => n.id === idProcurado);
      if (!noFonte) continue;
      if (noFonte.summary) { no.summary = noFonte.summary; herdados += 1; }
      if (noFonte.tags && noFonte.tags.length) no.tags = noFonte.tags;
      if (noFonte.languageNotes) no.languageNotes = noFonte.languageNotes;
      const camada = (fonte.grafo.layers || []).find((l) => (l.nodeIds || []).includes(idProcurado));
      if (camada) camadaHerdada = { id: camada.id, name: camada.name, description: camada.description };
      // a primeira fonte que TEM o nó decide (prioridade por fonte) — mesmo sem camada lá,
      // não se continua procurando camada numa fonte de prioridade menor.
      break;
    }
    if (camadaHerdada) camadaPorNode.set(no.id, camadaHerdada);
    else {
      const seg = segmentoDeCamada(no.filePath || '');
      camadaPorNode.set(no.id, { id: `layer:${seg}`, name: seg, description: `Arquivos em ${seg}/` });
    }
  }

  // ── resumo estrutural para quem não herdou prosa ──────────────────────────
  // O dashboard trata `summary` vazio como ausente e "corrige" o nó (autoFixGraph,
  // core/src/schema.ts:235-300: a faixa "loaded with N auto-corrections"). Em vez de vazio, uma frase
  // que sai SÓ da estrutura — determinística, função do sha como o resto do grafo.
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const contagemPorArquivo = new Map(); // filePath -> { funcoes, classes, importa }
  const metodosPorClasse = new Map(); // id da classe -> n
  for (const no of nodes.values()) {
    if (no.type === 'file') continue;
    const c = contagemPorArquivo.get(no.filePath) || { funcoes: 0, classes: 0, importa: 0 };
    if (no.type === 'class') c.classes += 1;
    else if (no.name.includes('.')) {
      const idClasse = `class:${no.filePath}:${no.name.split('.')[0]}`;
      metodosPorClasse.set(idClasse, (metodosPorClasse.get(idClasse) || 0) + 1);
    } else c.funcoes += 1;
    contagemPorArquivo.set(no.filePath, c);
  }
  for (const e of edges) {
    if (e.type !== 'imports' && e.type !== 'depends_on') continue;
    const origem = nodes.get(e.source);
    if (!origem || origem.type !== 'file') continue;
    const c = contagemPorArquivo.get(origem.filePath) || { funcoes: 0, classes: 0, importa: 0 };
    c.importa += 1;
    contagemPorArquivo.set(origem.filePath, c);
  }
  for (const no of nodes.values()) {
    if (no.summary) continue;
    if (no.type === 'file') {
      const c = contagemPorArquivo.get(no.filePath) || { funcoes: 0, classes: 0, importa: 0 };
      const partes = [];
      if (c.funcoes) partes.push(plural(c.funcoes, 'função', 'funções'));
      if (c.classes) partes.push(plural(c.classes, 'classe', 'classes'));
      const dentro = partes.length ? partes.join(' e ') : 'nenhuma declaração de topo';
      const usa = c.importa ? `; depende de ${plural(c.importa, 'arquivo', 'arquivos')} do projeto` : '';
      no.summary = `Arquivo ${no.name}: ${dentro}${usa}.`;
    } else if (no.type === 'class') {
      const m = metodosPorClasse.get(no.id) || 0;
      no.summary = `Classe ${no.name} em ${no.filePath} (linhas ${no.lineRange[0]}–${no.lineRange[1]}), ${plural(m, 'método', 'métodos')}.`;
    } else if (no.name.includes('.')) {
      no.summary = `Método ${no.name} em ${no.filePath} (linhas ${no.lineRange[0]}–${no.lineRange[1]}).`;
    } else {
      no.summary = `Função ${no.name} em ${no.filePath} (linhas ${no.lineRange[0]}–${no.lineRange[1]}).`;
    }
  }

  const bucketsDeCamada = new Map();
  for (const [noId, camada] of camadaPorNode) {
    if (!bucketsDeCamada.has(camada.id)) bucketsDeCamada.set(camada.id, { id: camada.id, name: camada.name, description: camada.description, nodeIds: [] });
    bucketsDeCamada.get(camada.id).nodeIds.push(noId);
  }
  const layers = [...bucketsDeCamada.values()];

  let tour = [];
  for (const fonte of fontes) {
    if (!Array.isArray(fonte.grafo.tour) || fonte.grafo.tour.length === 0) continue;
    tour = fonte.grafo.tour
      .map((passo) => ({ ...passo, nodeIds: (passo.nodeIds || []).map((id) => idComPrefixo(id, fonte.prefixo)).filter((id) => nodes.has(id)) }))
      .filter((passo) => passo.nodeIds.length > 0);
    break;
  }

  const fontePrincipal = heranca[0];
  const frameworks = fontePrincipal && Array.isArray(fontePrincipal.grafo.project?.frameworks) ? fontePrincipal.grafo.project.frameworks : [];
  const description = fontePrincipal && fontePrincipal.grafo.project?.description ? fontePrincipal.grafo.project.description : '';

  const grafo = {
    version: '1.0.0',
    project: {
      name: nome,
      languages: [...languages],
      frameworks,
      description,
      analyzedAt: analisadoEm,
      gitCommitHash: sha,
    },
    nodes: [...nodes.values()],
    edges,
    layers,
    tour,
  };

  // `herdados` sai daqui: depois do resumo estrutural, "tem summary" deixou de querer dizer "herdou".
  return { grafo, avisos, herdados };
}

function declaracaoAlvoPorNomeExportado(extraidoAlvo, nomeProcurado) {
  for (const { local, nome } of extraidoAlvo.exportados) {
    if (nome === nomeProcurado) {
      const decl = extraidoAlvo.declaracoes.find((d) => d.nome === local);
      if (decl) return decl;
    }
  }
  return extraidoAlvo.declaracoes.find((d) => d.nome === nomeProcurado) || null;
}

function resolverAlvoChamada(caminho, chamada, extraido, declPorNome, extraidoJsPorArquivo, configs, arquivosSet) {
  if (!chamada.objeto) {
    const localDecl = declPorNome.get(chamada.nome);
    if (localDecl) return idDeclaracao(caminho, localDecl);

    for (const imp of extraido.imports) {
      const binding = imp.nomes.find((nm) => nm.local === chamada.nome);
      if (!binding) continue;
      const alvoArquivo = resolverJs(caminho, imp.especificador, configs, arquivosSet);
      if (!alvoArquivo) continue;
      const extraidoAlvo = extraidoJsPorArquivo.get(alvoArquivo);
      if (!extraidoAlvo) continue;
      if (imp.tipo === 'padrao') {
        if (!extraidoAlvo.padrao) continue;
        const decl = extraidoAlvo.declaracoes.find((d) => d.nome === extraidoAlvo.padrao);
        if (decl) return idDeclaracao(alvoArquivo, decl);
        continue;
      }
      if (imp.tipo === 'nomeados') {
        const decl = declaracaoAlvoPorNomeExportado(extraidoAlvo, binding.importado);
        if (decl) return idDeclaracao(alvoArquivo, decl);
      }
    }
    return null;
  }

  if (chamada.objeto === 'this' || chamada.objeto === 'self') {
    if (!chamada.dono || !chamada.dono.includes('.')) return null;
    const classe = chamada.dono.split('.')[0];
    const decl = declPorNome.get(`${classe}.${chamada.nome}`);
    if (decl) return idDeclaracao(caminho, decl);
    return null;
  }

  for (const imp of extraido.imports) {
    if (imp.tipo !== 'namespace') continue;
    const binding = imp.nomes.find((nm) => nm.local === chamada.objeto);
    if (!binding) continue;
    const alvoArquivo = resolverJs(caminho, imp.especificador, configs, arquivosSet);
    if (!alvoArquivo) continue;
    const extraidoAlvo = extraidoJsPorArquivo.get(alvoArquivo);
    if (!extraidoAlvo) continue;
    const decl = declaracaoAlvoPorNomeExportado(extraidoAlvo, chamada.nome);
    if (decl) return idDeclaracao(alvoArquivo, decl);
  }
  return null;
}

function resolverAlvoChamadaPy(caminho, chamada, registro, declPorNome, pythonPorArquivo, arquivosSet) {
  if (!chamada.objeto) {
    const localDecl = declPorNome.get(chamada.nome);
    if (localDecl) return idDeclaracao(caminho, localDecl);

    for (const entrada of registro.imports) {
      if (entrada.tipo !== 'from') continue;
      const nomeObj = entrada.nomes.find((nm) => nm.como === chamada.nome);
      if (!nomeObj) continue;
      const alvoArquivo = resolverPyAlvo(caminho, entrada, nomeObj, registro.syspath, arquivosSet);
      if (!alvoArquivo) continue;
      const registroAlvo = pythonPorArquivo.get(alvoArquivo);
      if (!registroAlvo) continue;
      const decl = registroAlvo.decls.find((d) => d.nome === nomeObj.nome);
      if (decl) return idDeclaracao(alvoArquivo, decl);
    }
    return null;
  }

  if (chamada.objeto === 'self' || chamada.objeto === 'cls') {
    if (!chamada.classe) return null;
    const decl = declPorNome.get(`${chamada.classe}.${chamada.nome}`);
    if (decl) return idDeclaracao(caminho, decl);
    return null;
  }

  for (const entrada of registro.imports) {
    const nomeObj = entrada.nomes.find((nm) => nm.como === chamada.objeto);
    if (!nomeObj) continue;
    const alvoArquivo = resolverPyAlvo(caminho, entrada, nomeObj, registro.syspath, arquivosSet);
    if (!alvoArquivo) continue;
    const registroAlvo = pythonPorArquivo.get(alvoArquivo);
    if (!registroAlvo) continue;
    const decl = registroAlvo.decls.find((d) => d.nome === chamada.nome);
    if (decl) return idDeclaracao(alvoArquivo, decl);
  }
  return null;
}

module.exports = { EXTENSOES, SEGMENTOS_EXCLUIDOS, deveIndexar, montarGrafo, resolverJs, resolverPyAlvo };
