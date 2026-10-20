#!/usr/bin/env node
'use strict';
// GATE do mapa simples do grafo — card `grafo-mapa-simples`, spec/plano
// `2026-10-17-grafo-mapa-simples-design`/`-plano` (D91). Nasce com os blocos PUROS (a, índice e
// três níveis) e de cache (b, leitor com LRU, prova do inode #114); as Fases 2 e 3 acrescentam a
// rota (`server.js` FILHO na porta 7973, HOME/COCKPIT_GRAFOS_DIR/COCKPIT_PROJETOS_DIR/
// COCKPIT_JOBS_DIR/COCKPIT_MONITOR_* no tmp — molde de `gate-grafo-rota.js`) e as puras do
// cliente (`public/grafo-mapa.js`, sem DOM).
//
//   node testes/gate-grafo-mapa.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { execFileSync, execSync, spawn } = require('node:child_process');

const mapa = require('../lib/grafo-mapa');
const grafoLoja = require('../lib/grafo-loja');

const RAIZ_REPO = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(RAIZ_REPO, 'public');
const SERVER_JS = path.join(RAIZ_REPO, 'server.js');
const PORTA = 7973;

let passou = 0;
let total = 0;
let vermelho = false;
function ok(cond, msg) {
  total += 1;
  if (cond) { passou += 1; console.log(`  ✅ ${msg}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${msg}`);
  return false;
}
async function bloco(nome, fn) {
  console.log(`\n${nome}`);
  try { await fn(); } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.stack}`);
  }
}

// ─── fixture em memória (nomes de mentira, #106) ───────────────────────────

/** Devolve um grafo NOVO a cada chamada — nada de referência compartilhada entre testes. */
function grafoDeFixture() {
  const nodes = [];
  const edges = [];
  const addNode = (n) => nodes.push(n);
  const addEdge = (source, target, type) => edges.push({ source, target, type, direction: 'forward', weight: 1 });

  // layer:web — pagina.ts (2 funções), rodape.ts (1 classe), 70 arquivos k00..k69 (função g)
  addNode({ id: 'file:web/app/pagina.ts', type: 'file', name: 'pagina.ts', filePath: 'web/app/pagina.ts' });
  addNode({ id: 'function:web/app/pagina.ts:montar', type: 'function', name: 'montar', filePath: 'web/app/pagina.ts', lineRange: [1, 5] });
  addNode({ id: 'function:web/app/pagina.ts:desenhar', type: 'function', name: 'desenhar', filePath: 'web/app/pagina.ts', lineRange: [7, 9] });
  addEdge('file:web/app/pagina.ts', 'function:web/app/pagina.ts:montar', 'contains');
  addEdge('file:web/app/pagina.ts', 'function:web/app/pagina.ts:desenhar', 'contains');
  addEdge('file:web/app/pagina.ts', 'function:web/app/pagina.ts:montar', 'exports');

  addNode({ id: 'file:web/app/rodape.ts', type: 'file', name: 'rodape.ts', filePath: 'web/app/rodape.ts' });
  addNode({ id: 'class:web/app/rodape.ts:Rodape', type: 'class', name: 'Rodape', filePath: 'web/app/rodape.ts', lineRange: [1, 20] });
  addEdge('file:web/app/rodape.ts', 'class:web/app/rodape.ts:Rodape', 'contains');

  const kFiles = [];
  for (let i = 0; i < 70; i += 1) {
    const n = String(i).padStart(2, '0');
    const caminho = `web/usuarios/k${n}.ts`;
    kFiles.push(caminho);
    addNode({ id: `file:${caminho}`, type: 'file', name: `k${n}.ts`, filePath: caminho });
    addNode({ id: `function:${caminho}:g`, type: 'function', name: 'g', filePath: caminho });
    addEdge(`file:${caminho}`, `function:${caminho}:g`, 'contains');
  }

  // layer:cli — nome igual ao id (M2: o nome exibido tira o "layer:")
  addNode({ id: 'file:cli/rodar.js', type: 'file', name: 'rodar.js', filePath: 'cli/rodar.js' });
  addNode({ id: 'function:cli/rodar.js:principal', type: 'function', name: 'principal', filePath: 'cli/rodar.js' });
  addEdge('file:cli/rodar.js', 'function:cli/rodar.js:principal', 'contains');

  // layer:camada-grande — banco.ts (1 função), 50 util planos, 1 cadeia funda (fundo/a/b/c)
  addNode({ id: 'file:src/lib/banco.ts', type: 'file', name: 'banco.ts', filePath: 'src/lib/banco.ts' });
  addNode({ id: 'function:src/lib/banco.ts:conectar', type: 'function', name: 'conectar', filePath: 'src/lib/banco.ts' });
  addEdge('file:src/lib/banco.ts', 'function:src/lib/banco.ts:conectar', 'contains');

  const utilFiles = [];
  for (let i = 0; i < 50; i += 1) {
    const n = String(i).padStart(2, '0');
    const caminho = `src/lib/util/u${n}.ts`;
    utilFiles.push(caminho);
    addNode({ id: `file:${caminho}`, type: 'file', name: `u${n}.ts`, filePath: caminho });
    addNode({ id: `function:${caminho}:f`, type: 'function', name: 'f', filePath: caminho });
    addEdge(`file:${caminho}`, `function:${caminho}:f`, 'contains');
  }

  addNode({ id: 'file:src/lib/fundo/a/b/c/profundo.ts', type: 'file', name: 'profundo.ts', filePath: 'src/lib/fundo/a/b/c/profundo.ts' });

  // arquivo solto, fora de qualquer camada — vai pra `layer:(sem camada)`
  addNode({ id: 'file:solto/sem-camada.js', type: 'file', name: 'sem-camada.js', filePath: 'solto/sem-camada.js' });

  // nó sem filePath — nunca vira chave; tem de ser ignorado por inteiro
  addNode({ id: 'function:sem-arquivo', type: 'function', name: 'fantasma' });

  // ligações entre arquivos (a regra: imports/calls com arquivo-origem != arquivo-destino)
  addEdge('file:web/app/pagina.ts', 'file:src/lib/banco.ts', 'imports');
  addEdge('function:web/app/pagina.ts:montar', 'function:src/lib/banco.ts:conectar', 'calls');
  addEdge('function:web/app/pagina.ts:montar', 'function:src/lib/banco.ts:conectar', 'calls'); // ×2: peso 3 no par de arquivos (com o import)
  addEdge('function:cli/rodar.js:principal', 'function:web/app/pagina.ts:desenhar', 'calls');
  addEdge('function:web/app/pagina.ts:montar', 'function:web/app/pagina.ts:desenhar', 'calls'); // mesmo arquivo: não conta
  addEdge('file:web/app/rodape.ts', 'file:web/app/pagina.ts', 'imports'); // mesma camada: conta pro arquivo, não pro par de camadas
  addEdge('function:web/app/pagina.ts:montar', 'function:nao:existe', 'calls'); // destino inexistente: ignorada
  for (const caminho of kFiles) addEdge(`file:${caminho}`, 'file:src/lib/banco.ts', 'imports');

  const layers = [
    {
      id: 'layer:web', name: 'Web Screens', nodeIds: [
        'file:web/app/pagina.ts', 'function:web/app/pagina.ts:montar', 'function:web/app/pagina.ts:desenhar',
        'file:web/app/rodape.ts', 'class:web/app/rodape.ts:Rodape',
        ...kFiles.flatMap((c) => [`file:${c}`, `function:${c}:g`]),
      ],
    },
    { id: 'layer:cli', name: 'layer:cli', nodeIds: ['file:cli/rodar.js', 'function:cli/rodar.js:principal'] },
    {
      id: 'layer:camada-grande', name: 'camada-grande', nodeIds: [
        'file:src/lib/banco.ts', 'function:src/lib/banco.ts:conectar',
        ...utilFiles.flatMap((c) => [`file:${c}`, `function:${c}:f`]),
        'file:src/lib/fundo/a/b/c/profundo.ts',
      ],
    },
  ];

  return {
    project: { name: 'app-mapa', gitCommitHash: 'a'.repeat(40), analyzedAt: '2026-10-17T12:00:00.000Z' },
    nodes, edges, layers,
  };
}

// ─── (a) índice e três níveis (puro) ────────────────────────────────────────

async function blocoA() {
  const ind = mapa.montarIndice(grafoDeFixture());

  const n1 = mapa.nivel1(ind);
  ok(n1.totais.arquivos === 126, `nivel1.totais.arquivos === 126 (achei ${n1.totais.arquivos})`);
  ok(n1.totais.camadas === 4, `nivel1.totais.camadas === 4 (achei ${n1.totais.camadas})`);
  const porId = new Map(n1.camadas.map((c) => [c.id, c]));
  ok(porId.get('layer:cli') && porId.get('layer:cli').nome === 'cli', `nome de layer:cli === 'cli' (achei ${porId.get('layer:cli') && porId.get('layer:cli').nome})`);
  ok(porId.get('layer:camada-grande') && porId.get('layer:camada-grande').pasta === 'src/lib', `pasta de layer:camada-grande === 'src/lib' (achei ${porId.get('layer:camada-grande') && porId.get('layer:camada-grande').pasta})`);
  ok(porId.get('layer:web') && porId.get('layer:web').pasta === 'web', `pasta de layer:web === 'web' (achei ${porId.get('layer:web') && porId.get('layer:web').pasta})`);
  const ordemEsperada = ['layer:web', 'layer:camada-grande', 'layer:(sem camada)', 'layer:cli'];
  ok(JSON.stringify(n1.camadas.map((c) => c.id)) === JSON.stringify(ordemEsperada),
    `ordem das camadas (arquivos desc, id asc no empate) (achei ${JSON.stringify(n1.camadas.map((c) => c.id))})`);
  ok(n1.camadas.find((c) => c.id === 'layer:web').arquivos === 72, `layer:web.arquivos === 72 (achei ${n1.camadas.find((c) => c.id === 'layer:web').arquivos})`);
  ok(n1.camadas.find((c) => c.id === 'layer:camada-grande').arquivos === 52, `layer:camada-grande.arquivos === 52 (achei ${n1.camadas.find((c) => c.id === 'layer:camada-grande').arquivos})`);
  const ligWebGrande = n1.ligacoes.find((l) => l.de === 'layer:web' && l.para === 'layer:camada-grande');
  ok(!!ligWebGrande && ligWebGrande.peso === 73, `ligação layer:web→layer:camada-grande peso 73 (achei ${JSON.stringify(ligWebGrande)})`);
  const ligCliWeb = n1.ligacoes.find((l) => l.de === 'layer:cli' && l.para === 'layer:web');
  ok(!!ligCliWeb && ligCliWeb.peso === 1, `ligação layer:cli→layer:web peso 1 (achei ${JSON.stringify(ligCliWeb)})`);
  ok(!n1.ligacoes.some((l) => l.de === l.para), 'nenhuma ligação com de === para');
  ok(n1.cabecalho.projeto === 'app-mapa' && n1.cabecalho.geradoEm === '2026-10-17T12:00:00.000Z',
    `cabecalho.projeto/geradoEm (achei ${JSON.stringify(n1.cabecalho)})`);

  const n2Raiz = mapa.nivel2(ind, 'layer:camada-grande');
  ok(JSON.stringify(n2Raiz.subpastas) === JSON.stringify([
    { pasta: 'src/lib/util', rotulo: 'util', arquivos: 50 },
    { pasta: 'src/lib/fundo/a/b/c', rotulo: 'fundo/a/b/c', arquivos: 1 },
  ]), `subpastas da raiz de camada-grande (achei ${JSON.stringify(n2Raiz.subpastas)})`);
  ok(n2Raiz.arquivos.length === 1 && n2Raiz.arquivos[0].caminho === 'src/lib/banco.ts' && n2Raiz.arquivos[0].usadoPor === 71 && n2Raiz.arquivos[0].usa === 0,
    `arquivos diretos da raiz: só banco.ts, usadoPor 71, usa 0 (achei ${JSON.stringify(n2Raiz.arquivos)})`);
  ok(JSON.stringify(n2Raiz.trilha) === JSON.stringify([{ rotulo: 'src/lib', pasta: 'src/lib' }]),
    `trilha da raiz (achei ${JSON.stringify(n2Raiz.trilha)})`);
  ok(n2Raiz.ligacoesDaCamada.usadaPor[0] && n2Raiz.ligacoesDaCamada.usadaPor[0].id === 'layer:web'
    && n2Raiz.ligacoesDaCamada.usadaPor[0].nome === 'Web Screens' && n2Raiz.ligacoesDaCamada.usadaPor[0].peso === 73,
    `ligacoesDaCamada.usadaPor[0] (achei ${JSON.stringify(n2Raiz.ligacoesDaCamada.usadaPor)})`);

  const n2Util = mapa.nivel2(ind, 'layer:camada-grande', 'src/lib/util');
  ok(n2Util.arquivos.length === 50 && n2Util.trilha.length === 2, `src/lib/util: 50 arquivos, trilha.length 2 (achei ${n2Util.arquivos.length}, ${n2Util.trilha.length})`);

  ok(mapa.nivel2(ind, 'layer:camada-grande', 'src/lib/fundo') === null, 'pasta comprimida (src/lib/fundo) não é nó da árvore → null');
  ok(mapa.nivel2(ind, 'layer:nao-existe') === null, 'camada inexistente → null');

  const n3Banco = mapa.nivel3(ind, 'src/lib/banco.ts');
  ok(n3Banco.usadoPor.total === 71 && n3Banco.usadoPor.itens.length === 60, `banco.ts: usadoPor.total 71, itens 60 (achei ${n3Banco.usadoPor.total}, ${n3Banco.usadoPor.itens.length})`);
  ok(n3Banco.usadoPor.itens[0].caminho === 'web/app/pagina.ts' && n3Banco.usadoPor.itens[0].peso === 3,
    `1º item de usadoPor é pagina.ts com peso 3 (achei ${JSON.stringify(n3Banco.usadoPor.itens[0])})`);
  ok(n3Banco.usa.total === 0, `banco.ts: usa.total 0 (achei ${n3Banco.usa.total})`);
  ok(JSON.stringify(n3Banco.simbolos) === JSON.stringify([{ nome: 'conectar', tipo: 'function', linhas: null }]),
    `símbolos de banco.ts (achei ${JSON.stringify(n3Banco.simbolos)})`);
  ok(n3Banco.arquivo.pasta === 'src/lib', `arquivo.pasta === 'src/lib' (achei ${n3Banco.arquivo.pasta})`);
  ok(n3Banco.arquivo.camada.id === 'layer:camada-grande', `arquivo.camada.id === layer:camada-grande (achei ${n3Banco.arquivo.camada.id})`);

  const n3BancoCompleto = mapa.nivel3(ind, 'src/lib/banco.ts', { completo: true });
  ok(n3BancoCompleto.usadoPor.itens.length === 71, `com completo:true, usadoPor.itens.length === 71 (achei ${n3BancoCompleto.usadoPor.itens.length})`);

  const n3Pagina = mapa.nivel3(ind, 'web/app/pagina.ts');
  ok(n3Pagina.usa.itens.some((i) => i.caminho === 'src/lib/banco.ts' && i.peso === 3), `usa.itens tem banco.ts peso 3 (achei ${JSON.stringify(n3Pagina.usa.itens)})`);
  ok(n3Pagina.usadoPor.itens.some((i) => i.caminho === 'cli/rodar.js' && i.peso === 1)
    && n3Pagina.usadoPor.itens.some((i) => i.caminho === 'web/app/rodape.ts' && i.peso === 1),
    `usadoPor.itens tem cli/rodar.js(1) e web/app/rodape.ts(1) (achei ${JSON.stringify(n3Pagina.usadoPor.itens)})`);
  ok(JSON.stringify(n3Pagina.simbolos.map((s) => s.nome)) === JSON.stringify(['montar', 'desenhar']),
    `símbolos em ordem de linha: montar, desenhar (achei ${JSON.stringify(n3Pagina.simbolos.map((s) => s.nome))})`);

  const c1 = mapa.nivel1(ind);
  const c2 = mapa.nivel1(ind);
  ok(c1.cabecalho !== c2.cabecalho, 'nivel1(ind).cabecalho !== nivel1(ind).cabecalho (objeto novo a cada chamada)');
  c1.cabecalho.extra = 'x';
  const c3 = mapa.nivel1(ind);
  ok(!('extra' in c3.cabecalho), 'mutar o cabecalho devolvido não contamina a chamada seguinte');

  ok(mapa.nivel3(ind, 'nao/existe.ts') === null, 'nivel3 de caminho inexistente → null');
  ok(mapa.nivel3(ind, '../../segredo') === null, "nivel3('../../segredo') → null (não é chave do mapa)");

  const textoTudo = JSON.stringify([n1, n2Raiz, n3Banco, n3Pagina]);
  ok(!textoTudo.includes('fantasma'), 'nenhuma resposta contém "fantasma" (nó sem filePath, ignorado)');
  ok(!textoTudo.includes('undefined'), 'nenhuma resposta contém a string "undefined"');

  // Trilha do nível 3 até a pasta do arquivo, com os ancestrais (painel de execução, Codex).
  ok(JSON.stringify(mapa.nivel3(ind, 'src/lib/util/u00.ts').trilha) === JSON.stringify([{ rotulo: 'src/lib', pasta: 'src/lib' }, { rotulo: 'util', pasta: 'src/lib/util' }]),
    `nivel3.trilha da raiz até a pasta do arquivo (achei ${JSON.stringify(mapa.nivel3(ind, 'src/lib/util/u00.ts').trilha)})`);
  ok(JSON.stringify(mapa.nivel3(ind, 'src/lib/fundo/a/b/c/profundo.ts').trilha.map((t) => t.rotulo)) === JSON.stringify(['src/lib', 'fundo/a/b/c']),
    'nivel3.trilha usa a pasta COMPRIMIDA (fundo/a/b/c num passo só)');

  // Símbolo sem `name` (commit e5a3824): o índice não estoura no sort, o símbolo entra com nome vazio.
  const semNome = grafoDeFixture();
  semNome.nodes.push({ id: 'function:cli/rodar.js:anonima', type: 'function', filePath: 'cli/rodar.js', lineRange: [50, 60] });
  let indSemNome = null;
  try { indSemNome = mapa.montarIndice(semNome); } catch (e) { ok(false, `montarIndice com símbolo sem name não pode lançar (lançou ${e && e.message})`); }
  if (indSemNome) {
    const sims = mapa.nivel3(indSemNome, 'cli/rodar.js').simbolos;
    ok(sims.some((x) => x.nome === '' && x.linhas[0] === 50), `símbolo sem name entra com nome '' (achei ${JSON.stringify(sims)})`);
  }

  const semLayers = mapa.montarIndice({ ...grafoDeFixture(), layers: [] });
  const n1SemLayers = mapa.nivel1(semLayers);
  ok(n1SemLayers.camadas.length === 1 && n1SemLayers.camadas[0].id === 'layer:(tudo)' && n1SemLayers.camadas[0].arquivos === 126,
    `grafo sem layers → uma camada layer:(tudo) com 126 arquivos (achei ${JSON.stringify(n1SemLayers.camadas)})`);
}

// ─── (b) leitor com cache (indiceDo) ────────────────────────────────────────

async function blocoB() {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-mapa-loja-'));
  grafoLoja.publicar(pasta, grafoDeFixture(), { gitCommitHash: 'a'.repeat(40) });

  const r1 = mapa.indiceDo(pasta);
  const arq = grafoLoja.arquivoDoGrafo(pasta, false);
  ok(r1 !== null && r1.bytes === fs.statSync(arq).size, `indiceDo devolve {indice,bytes} com bytes === statSync (achei ${r1 && r1.bytes})`);

  const contadorAntes = mapa._contadorDeParse();
  mapa.indiceDo(pasta);
  const contadorDepois = mapa._contadorDeParse();
  ok(contadorAntes === contadorDepois, `2ª leitura da MESMA loja não reparsa (contador ${contadorAntes} → ${contadorDepois})`);

  // Prova do inode (R1/#114): mtime e size IGUAIS de propósito; só o inode separa.
  const T = 1700000000;
  fs.utimesSync(arq, T, T);
  mapa.indiceDo(pasta); // cacheia a v1
  const st1 = fs.statSync(arq);

  grafoLoja.publicar(pasta, { ...grafoDeFixture(), project: { name: 'app-mapa', gitCommitHash: 'a'.repeat(40), analyzedAt: '2026-10-17T13:00:00.000Z' } }, { gitCommitHash: 'a'.repeat(40) });
  fs.utimesSync(arq, T, T);
  const st2 = fs.statSync(arq);

  ok(st1.mtimeMs === st2.mtimeMs && st1.size === st2.size, `pré-condição do caso: mtime e size IGUAIS entre as duas publicações (achei ${st1.mtimeMs}/${st1.size} vs ${st2.mtimeMs}/${st2.size})`);
  ok(st1.ino !== st2.ino, `pré-condição do caso: inode DIFERENTE entre as duas publicações (achei ${st1.ino} vs ${st2.ino})`);

  const r2 = mapa.indiceDo(pasta);
  ok(r2.indice.geradoEm === '2026-10-17T13:00:00.000Z', `com mtime/size iguais e inode diferente, indiceDo lê a versão NOVA (achei ${r2.indice.geradoEm})`);

  // LRU de 3: quatro lojas diferentes em sequência reparsam a 1ª na volta.
  const pastas = [pasta];
  for (let i = 0; i < 3; i += 1) {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), `gate-grafo-mapa-loja-${i}-`));
    grafoLoja.publicar(p, grafoDeFixture(), {});
    pastas.push(p);
  }
  for (const p of pastas) mapa.indiceDo(p); // aquece o LRU com as 4 (a 1ª — `pasta` — sai do cache)
  const antesVolta = mapa._contadorDeParse();
  mapa.indiceDo(pasta); // 1ª loja, fora do LRU de 3: reparseia
  ok(mapa._contadorDeParse() === antesVolta + 1, `LRU de 3: a 1ª loja reparseia na volta (contador ${antesVolta} → ${mapa._contadorDeParse()})`);

  // Versão NOVA de uma loja já em cache entra no FIM do LRU (commit e5a3824; painel de execução, Claude:
  // sem assert, reverter a linha deixava o gate verde). Cache agora: [pastas[2], pastas[3], pasta] — a
  // pastas[1] saiu quando a 1ª voltou. Republicar a pastas[2] (a MAIS ANTIGA no cache) e ler → ela tem de
  // virar a mais recente; ler uma 5ª loja expulsa a pastas[3], não ela.
  const p1 = pastas[2];
  grafoLoja.publicar(p1, { ...grafoDeFixture(), nodes: [...grafoDeFixture().nodes, { id: 'file:extra.js', type: 'file', name: 'extra.js', filePath: 'extra.js' }] }, {});
  mapa.indiceDo(p1); // versão nova de p1: reparseia e vai pro fim
  const p5 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-mapa-loja-5-'));
  grafoLoja.publicar(p5, grafoDeFixture(), {});
  mapa.indiceDo(p5); // expulsa o mais antigo
  const antesP1 = mapa._contadorDeParse();
  mapa.indiceDo(p1);
  ok(mapa._contadorDeParse() === antesP1, `LRU: a versão nova de uma loja entra no FIM — p1 continua no cache depois da 5ª loja (contador ${antesP1} → ${mapa._contadorDeParse()})`);

  const semGrafo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-mapa-vazia-'));
  ok(mapa.indiceDo(semGrafo) === null, 'pasta sem grafo → null (não lança)');
}

// ─── (d) puras do cliente (public/grafo-mapa.js, sem DOM) ──────────────────────────────────────

/** Molde `carregarGrafo` de `gate-grafo-tela.js:34-42`, com `localStorage` falso. */
function carregarMapa() {
  const dados = new Map();
  const sandbox = {
    document: { getElementById: () => null },
    localStorage: { getItem: (k) => dados.get(k) ?? null, setItem: (k, v) => dados.set(k, v) },
    URLSearchParams,
    console,
  };
  const contexto = vm.createContext(sandbox);
  for (const arquivo of ['traducoes.js', 'i18n.js', 'grafo-mapa.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  return contexto.cockpitMapa;
}

async function blocoD() {
  const m = carregarMapa();

  // ── foco no hash (F4) ──────────────────────────────────────────────────
  ok(JSON.stringify(m.lerHash('#foco=layer%3Ab')) === JSON.stringify({ foco: 'layer:b' }),
    `lerHash foco (achei ${JSON.stringify(m.lerHash('#foco=layer%3Ab'))})`);
  ok(JSON.stringify(m.lerHash('#camada=a&foco=b')) === JSON.stringify({ camada: 'a', foco: 'b' }),
    `lerHash camada+foco (achei ${JSON.stringify(m.lerHash('#camada=a&foco=b'))})`);
  ok(JSON.stringify(m.lerHash(m.montarHash({ foco: 'a&b' }))) === JSON.stringify({ foco: 'a&b' }), 'ida-e-volta de foco com &');
  ok(m.montarHash({ camada: 'x', foco: 'y' }) === '#camada=x&foco=y',
    `montarHash: foco no FIM da ordem fixa (achei ${m.montarHash({ camada: 'x', foco: 'y' })})`);

  ok(JSON.stringify(m.lerHash('#camada=layer%3Aa&pasta=src%2Flib')) === JSON.stringify({ camada: 'layer:a', pasta: 'src/lib' }),
    `lerHash camada+pasta (achei ${JSON.stringify(m.lerHash('#camada=layer%3Aa&pasta=src%2Flib'))})`);
  ok(JSON.stringify(m.lerHash('#arquivo=a%26b.ts')) === JSON.stringify({ arquivo: 'a&b.ts' }), 'lerHash decodifica %26');
  ok(JSON.stringify(m.lerHash('')) === '{}', "lerHash('') → {}");
  ok(JSON.stringify(m.lerHash('#c=x')) === '{}', "lerHash('#c=x') → {} (hash do app, não do mapa)");
  for (const nome of ['a&b', 'a=b', 'a#b', 'a b', 'café', 'a%b']) {
    const ida = m.montarHash({ arquivo: nome });
    const volta = m.lerHash(ida);
    ok(JSON.stringify(volta) === JSON.stringify({ arquivo: nome }), `ida-e-volta de "${nome}" (achei ${JSON.stringify(volta)})`);
  }

  // ── urlDosDados nunca manda `foco` (F4) ──────────────────────────────────
  ok(m.urlDosDados('app-mapa', { camada: 'x', foco: 'y' }) === '../../api/grafos/app-mapa/mapa?camada=x',
    `urlDosDados ignora foco (achei ${m.urlDosDados('app-mapa', { camada: 'x', foco: 'y' })})`);
  ok(m.urlDosDados('app-mapa', { camada: 'layer:a', pasta: 'b c' }) === '../../api/grafos/app-mapa/mapa?camada=layer%3Aa&pasta=b%20c',
    `urlDosDados camada+pasta (achei ${m.urlDosDados('app-mapa', { camada: 'layer:a', pasta: 'b c' })})`);
  ok(!m.urlDosDados('app-mapa', {}).includes('?'), 'urlDosDados sem estado: sem ?');
  ok(m.urlDosDados('app-mapa', { arquivo: 'x', completo: true }) === '../../api/grafos/app-mapa/mapa?arquivo=x&completo=1',
    `urlDosDados arquivo+completo (achei ${m.urlDosDados('app-mapa', { arquivo: 'x', completo: true })})`);

  ok(m.urlDoCompleto('app-mapa', 'tok en') === '../../grafo/app-mapa/?token=tok%20en', `urlDoCompleto com token (achei ${m.urlDoCompleto('app-mapa', 'tok en')})`);
  ok(m.urlDoCompleto('app-mapa', '') === '../../grafo/app-mapa/?token=-', `urlDoCompleto sem token (achei ${m.urlDoCompleto('app-mapa', '')})`);

  ok(m.rotuloDaCamada({ nome: 'cli' }) === 'cli', 'rotuloDaCamada');
  const arr45 = Array.from({ length: 45 }, (_, i) => i);
  ok(JSON.stringify(m.cortarLista(arr45, 40)) === JSON.stringify({ visiveis: 40, resto: 5 }), `cortarLista (achei ${JSON.stringify(m.cortarLista(arr45, 40))})`);

  // ── destinoDoSubir: fundo explícito vence (F10, painel Codex #1) ─────────
  ok(JSON.stringify(m.destinoDoSubir({ camada: 'layer:a', pasta: 'src/a', arquivo: 'src/b/b.js' }, { camadaDoArquivo: 'layer:b', pastaDoArquivo: 'src/b' }))
    === JSON.stringify({ camada: 'layer:a', pasta: 'src/a' }), 'destinoDoSubir: fundo explícito (camada do estado) vence o do arquivo');
  ok(JSON.stringify(m.destinoDoSubir({ arquivo: 'src/lib/banco.ts' }, { camadaDoArquivo: 'layer:g', pastaDoArquivo: 'src/lib' }))
    === JSON.stringify({ camada: 'layer:g', pasta: 'src/lib' }), 'destinoDoSubir de um arquivo SEM camada no estado → camada/pasta do arquivo');
  ok(JSON.stringify(m.destinoDoSubir({ camada: 'layer:g', pasta: 'src/lib/util' }, { mae: 'src/lib' }))
    === JSON.stringify({ camada: 'layer:g', pasta: 'src/lib' }), 'destinoDoSubir de uma subpasta → pasta-mãe');
  ok(JSON.stringify(m.destinoDoSubir({ camada: 'layer:g', pasta: 'src/lib' }, { mae: null })) === '{}',
    'destinoDoSubir da raiz da camada (mae nulo) → nível 1');

  // ── vizinhosDe (F5) ────────────────────────────────────────────────────
  const ligacoesVizinhos = [{ de: 'a', para: 'b', peso: 5 }, { de: 'c', para: 'b', peso: 9 }, { de: 'b', para: 'd', peso: 2 },
    { de: 'b', para: 'b', peso: 99 }, { de: 'e', para: 'b', peso: 5 }];
  const vizB = m.vizinhosDe(ligacoesVizinhos, 'b');
  ok(JSON.stringify(vizB) === JSON.stringify({ usadaPor: [{ id: 'c', peso: 9 }, { id: 'a', peso: 5 }, { id: 'e', peso: 5 }], usa: [{ id: 'd', peso: 2 }] }),
    `vizinhosDe('b') peso desc, empate por id, sem de===para (achei ${JSON.stringify(vizB)})`);
  ok(JSON.stringify(m.vizinhosDe(ligacoesVizinhos, 'nao-existe')) === JSON.stringify({ usadaPor: [], usa: [] }), 'vizinhosDe de id sem ligação → listas vazias');

  // ── corDaCamada (F7) ───────────────────────────────────────────────────
  const camadas17 = Array.from({ length: 17 }, (_, i) => ({ id: `c${i}` }));
  ok(m.corDaCamada('c0', camadas17) === '#e0a43a', `corDaCamada c0 (achei ${m.corDaCamada('c0', camadas17)})`);
  ok(m.corDaCamada('c1', camadas17) === '#5b8def', `corDaCamada c1 (achei ${m.corDaCamada('c1', camadas17)})`);
  ok(m.corDaCamada('c15', camadas17) === '#e0a43a', `corDaCamada c15 cíclica (achei ${m.corDaCamada('c15', camadas17)})`);
  ok(m.corDaCamada('nao-existe', camadas17) === 'var(--texto-2)', `corDaCamada fora da lista (achei ${m.corDaCamada('nao-existe', camadas17)})`);
  ok(m.PALETA.length === 15, `PALETA.length === 15 (achei ${m.PALETA.length})`);

  // ── pedacosNegrito ─────────────────────────────────────────────────────
  ok(JSON.stringify(m.pedacosNegrito('a **b** c **d**')) === JSON.stringify([
    { texto: 'a ', negrito: false }, { texto: 'b', negrito: true }, { texto: ' c ', negrito: false }, { texto: 'd', negrito: true },
  ]), `pedacosNegrito (achei ${JSON.stringify(m.pedacosNegrito('a **b** c **d**'))})`);
  ok(JSON.stringify(m.pedacosNegrito('sem negrito')) === JSON.stringify([{ texto: 'sem negrito', negrito: false }]), 'pedacosNegrito sem ** → um pedaço só');
  ok(!m.pedacosNegrito('a **b**').some((p) => p.texto === ''), 'pedacosNegrito: pedaço vazio não aparece');

  // ── atrasoEmCascata ────────────────────────────────────────────────────
  ok(m.atrasoEmCascata(0) === 0, `atrasoEmCascata(0) (achei ${m.atrasoEmCascata(0)})`);
  ok(m.atrasoEmCascata(4) === 100, `atrasoEmCascata(4) (achei ${m.atrasoEmCascata(4)})`);
  ok(m.atrasoEmCascata(15) === 375, `atrasoEmCascata(15) (achei ${m.atrasoEmCascata(15)})`);
  ok(m.atrasoEmCascata(200) === 375, `atrasoEmCascata(200) tem teto (achei ${m.atrasoEmCascata(200)})`);

  // ── pastaCurta ─────────────────────────────────────────────────────────
  ok(m.pastaCurta('services/x/lib/finance/money.ts') === 'finance', `pastaCurta (achei ${m.pastaCurta('services/x/lib/finance/money.ts')})`);
  ok(m.pastaCurta('raiz.ts') === '', `pastaCurta sem pasta (achei ${JSON.stringify(m.pastaCurta('raiz.ts'))})`);

  // ── explicarCamada (F2) — tabela ordenada, fixture SEM nome de projeto real (#106) ─────────────
  const casosExplicacao = [
    ['Shared Types & Utilities', 'layer:shared', 'x/y', 'tipos e funções compartilhadas'],
    ['App Router Screens', 'layer:routes', 'x/app', 'as telas do app'],
    ['UI Components', 'layer:ui', 'x/components', 'pedaços de tela (componentes)'],
    ['API Layer', 'layer:api', 'x/app/api', 'rotas da API (o que o servidor responde)'],
    ['Domain Logic', 'layer:domain', 'x/lib', 'regras de negócio'],
    ['Testes_Projeto', 'layer:Testes_Projeto', 'Testes_Projeto', 'testes automáticos'],
    ['Tests', 'layer:tests', 'x/src', 'testes automáticos'],
    ['layer:client-state', 'layer:client-state', 'x/src', 'estado da tela no navegador'],
    ['layer:platform', 'layer:platform', 'x/src', 'base técnica (infraestrutura)'],
    ['layer:tooling', 'layer:tooling', 'x', 'ferramentas e configuração'],
    ['docs', 'layer:docs', 'docs', 'documentação'],
    ['raiz', 'layer:raiz', '', 'arquivos soltos na raiz do projeto'],
    ['Agente de Voz', 'layer:agente-voz', 'agente_voz', 'arquivos da pasta {0}', 'agente_voz'],
    ['painel', 'layer:painel', 'painel', 'arquivos da pasta {0}', 'painel'],
    ['Qualquer', 'layer:qualquer', '', 'arquivos soltos na raiz do projeto'],
    ['Coisas', 'layer:coisas', 'app/components', 'pedaços de tela (componentes)'],
    ['(sem camada)', 'layer:(sem camada)', 'src', 'arquivos fora de qualquer parte'],
    ['(tudo)', 'layer:(tudo)', '', 'o projeto inteiro (o grafo não separou partes)'],
    ['Café Útil', 'layer:cafe', 'x', 'tipos e funções compartilhadas'],
    ['scripts', 'layer:scripts', 'scripts', 'scripts de apoio'],
    ['roadmap-board', 'layer:roadmap-board', 'roadmap-board', 'quadro do roadmap'],
    ['backend', 'layer:backend', 'backend', 'o servidor (backend)'],
    ['Backend Services', 'layer:x', 'x', 'o servidor (backend)'],
    ['web', 'layer:web', 'web', 'o que roda no navegador'],
    ['services', 'layer:services', 'services', 'serviços do projeto'],
    ['services', 'layer:services', 'services/x/src', 'serviços do projeto'],
    ['Data', 'layer:data', 'x', 'dados e banco'],
    ['lib', 'layer:lib', 'lib', 'biblioteca de código do projeto'],
    ['bin', 'layer:bin', 'bin', 'comandos de terminal'],
    ['assets', 'layer:assets', 'assets', 'arquivos estáticos (imagens, fontes)'],
    ['src', 'layer:src', 'src', 'código-fonte principal'],
    ['Test API', 'layer:x', 'x', 'testes automáticos'],
  ];
  for (const [nome, id, pasta, chaveEsperada, paramEsperado] of casosExplicacao) {
    const r = m.explicarCamada(nome, id, pasta);
    ok(r.chave === chaveEsperada, `explicarCamada(${JSON.stringify(nome)}, ${JSON.stringify(id)}, ${JSON.stringify(pasta)}).chave === ${JSON.stringify(chaveEsperada)} (achei ${JSON.stringify(r)})`);
    if (paramEsperado !== undefined) ok(r.param === paramEsperado, `explicarCamada(${JSON.stringify(nome)}).param === ${JSON.stringify(paramEsperado)} (achei ${JSON.stringify(r.param)})`);
  }
  ok(Array.isArray(m.CHAVES_DE_EXPLICACAO), 'CHAVES_DE_EXPLICACAO é array');
  ok(new Set(m.CHAVES_DE_EXPLICACAO).size === m.CHAVES_DE_EXPLICACAO.length, 'CHAVES_DE_EXPLICACAO sem repetição');
  for (const extra of ['arquivos da pasta {0}', 'arquivos soltos na raiz do projeto', 'arquivos fora de qualquer parte', 'o projeto inteiro (o grafo não separou partes)']) {
    ok(m.CHAVES_DE_EXPLICACAO.includes(extra), `CHAVES_DE_EXPLICACAO contém "${extra}"`);
  }
  for (const [, , , chaveEsperada] of casosExplicacao) {
    ok(m.CHAVES_DE_EXPLICACAO.includes(chaveEsperada), `CHAVES_DE_EXPLICACAO contém "${chaveEsperada}" (achada pela tabela)`);
  }

  const cssArq = path.join(PUBLIC_DIR, 'grafo-mapa.css');
  ok(fs.existsSync(cssArq), 'public/grafo-mapa.css existe');
  if (fs.existsSync(cssArq)) {
    const css = fs.readFileSync(cssArq, 'utf8');
    ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'grafo-mapa.css tem o bloco prefers-reduced-motion');
    const iMedia = css.indexOf('@media (prefers-reduced-motion: reduce)');
    let blocoReduzido = '';
    if (iMedia >= 0) {
      const iAbre = css.indexOf('{', iMedia);
      let prof = 0;
      let fim = -1;
      for (let i = iAbre; i < css.length; i += 1) {
        if (css[i] === '{') prof += 1;
        else if (css[i] === '}') { prof -= 1; if (prof === 0) { fim = i; break; } }
      }
      blocoReduzido = fim >= 0 ? css.slice(iMedia, fim + 1) : '';
    }
    ok(blocoReduzido.includes('animation: none'), `bloco prefers-reduced-motion contém "animation: none" (achei ${JSON.stringify(blocoReduzido.slice(0, 200))})`);
    ok(blocoReduzido.includes('transition: none'), `bloco prefers-reduced-motion contém "transition: none" (achei ${JSON.stringify(blocoReduzido.slice(0, 200))})`);
    ok(!css.includes('.mapa-bloco'), 'grafo-mapa.css não contém .mapa-bloco (o treemap saiu, F12)');
  }

  const fonte = fs.readFileSync(path.join(PUBLIC_DIR, 'grafo-mapa.js'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const proibido of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    ok(!fonte.includes(proibido), `fonte sem ${proibido}`);
  }
  ok(!fonte.includes('location.hash ='), 'fonte sem location.hash = (#36/#37)');
  ok(fonte.includes('pushState') && fonte.includes('popstate'), 'fonte contém pushState e popstate');
}

// ─── rota (server.js FILHO na porta 7973) — molde de gate-grafo-rota.js ────────────────────────

function pedir(rota, metodo = 'GET', cabecalhos = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers: cabecalhos, agent: false }, (res) => {
      const pedacos = [];
      res.on('data', (d) => pedacos.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(pedacos).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const bearer = (token) => (token ? { authorization: `Bearer ${token}` } : {});
function esperarMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

function confereLivre() {
  let saida = '';
  try { saida = execSync('ss -H -lptn', { encoding: 'utf8' }); } catch { return; }
  if (new RegExp(`:${PORTA}\\b`).test(saida)) {
    console.error(`porta ${PORTA} ocupada — o gate não pode rodar\n${saida}`);
    process.exit(1);
  }
}

/** Sobe `server.js` filho com env FECHADO — molde exato de `gate-grafo-rota.js` `withServer`. */
async function withServer({ projetosDir, grafosDir, token }, tarefa) {
  confereLivre();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-mapa-srv-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
    COCKPIT_CERT_DIR: '/dev/null',
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_GRAFOS_DIR: grafosDir,
    COCKPIT_JOBS_DIR: path.join(tmp, 'jobs'), // A10 do gate-jobs-disco
    COCKPIT_MONITOR_DIR: path.join(tmp, 'monitor'), COCKPIT_MONITOR_MS: '0', // M-rede
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(tmp, 'push'),
    COCKPIT_LIDAS_DIR: path.join(tmp, 'lidas'),
    COCKPIT_LEITURAS_DIR: path.join(tmp, 'leituras'),
    COCKPIT_TMUX_SOCKET: `gate-grafo-mapa-${process.pid}`,
    COCKPIT_DU_BIN: path.join(tmp, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(tmp, 'sem-docker'),
  };
  if (token) env.COCKPIT_TOKEN = token;
  const child = spawn(process.execPath, [SERVER_JS], { cwd: RAIZ_REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let saidaErro = '';
  child.stderr.on('data', (d) => { saidaErro += d; });
  try {
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`servidor saiu antes do /health (rc=${child.exitCode}) — ${saidaErro}`);
      try {
        const r = await pedir('/health', 'GET');
        if (r.status === 200) break;
      } catch { /* ainda subindo */ }
      if (Date.now() - t0 > 10000) throw new Error(`timeout esperando /health — ${saidaErro}`);
      await esperarMs(100);
    }
    await tarefa();
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
  }
}

// ─── fixture de disco (projetos + loja) ────────────────────────────────────────────────────────

function git(repo, args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=gate', '-c', 'user.email=gate@example.com', ...args], { encoding: 'utf8' });
}
function escreverEComitar(repo, arquivos, msg) {
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(repo, nome)), { recursive: true });
    fs.writeFileSync(path.join(repo, nome), conteudo);
  }
  git(repo, ['add', ...Object.keys(arquivos)]);
  git(repo, ['commit', '-q', '-m', msg]);
}

/** Grafo MENOR (3 arquivos, 1 camada) — a 2ª loja do teste "dois projetos, cache compartilhado". */
function grafoDeFixtureMenor() {
  return {
    project: { name: 'app-mapa-dois', gitCommitHash: 'b'.repeat(40), analyzedAt: '2026-10-17T12:00:00.000Z' },
    nodes: [
      { id: 'file:x.js', type: 'file', name: 'x.js', filePath: 'x.js' },
      { id: 'file:y.js', type: 'file', name: 'y.js', filePath: 'y.js' },
      { id: 'file:z.js', type: 'file', name: 'z.js', filePath: 'z.js' },
    ],
    edges: [],
    layers: [{ id: 'layer:raiz', name: 'raiz', nodeIds: ['file:x.js', 'file:y.js', 'file:z.js'] }],
  };
}

function montarFixtureDeDisco() {
  const projetosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-mapa-projetos-'));
  const grafosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grafo-mapa-grafos-'));

  const appMapa = path.join(projetosDir, 'app-mapa');
  fs.mkdirSync(appMapa);
  git(appMapa, ['init', '-q', '-b', 'develop']);
  escreverEComitar(appMapa, { 'a.js': 'export function f() { return 1; }\n' }, 'c1');

  const pastaSolta = path.join(projetosDir, 'pasta-solta');
  fs.mkdirSync(pastaSolta);
  fs.writeFileSync(path.join(pastaSolta, 'z.txt'), 'x');

  // Isca FORA da loja — a resposta de nível 3 do nó correspondente nunca pode conter este texto
  // (prova de que o servidor nunca abre arquivo de disco a partir de um `filePath` do grafo).
  const pid = process.pid;
  const iscaArq = path.join(grafosDir, '..', `segredo-${pid}.txt`);
  fs.writeFileSync(iscaArq, 'ISCA-NAO-PODE-VAZAR');
  const grafoComIsca = grafoDeFixture();
  grafoComIsca.nodes.push({ id: `file:../segredo-${pid}.txt`, type: 'file', name: 'segredo', filePath: `../segredo-${pid}.txt` });
  grafoLoja.publicar(path.join(grafosDir, 'app-mapa'), grafoComIsca, { gitCommitHash: 'a'.repeat(40) });

  // app-mapa-dois: repo + loja MENOR — prova que o cache (chaveado por arquivo) não mistura projetos.
  const appMapaDois = path.join(projetosDir, 'app-mapa-dois');
  fs.mkdirSync(appMapaDois);
  git(appMapaDois, ['init', '-q', '-b', 'develop']);
  escreverEComitar(appMapaDois, { 'b.js': 'export function g() { return 2; }\n' }, 'c1');
  grafoLoja.publicar(path.join(grafosDir, 'app-mapa-dois'), grafoDeFixtureMenor(), { gitCommitHash: 'b'.repeat(40) });

  return { projetosDir, grafosDir, iscaArq, pid };
}

// ─── (c) rota de dados — GET /api/grafos/<nome>/mapa ───────────────────────────────────────────

async function blocoC(f, TOKEN) {
  const bytesAppMapa = fs.statSync(grafoLoja.arquivoDoGrafo(path.join(f.grafosDir, 'app-mapa'), false)).size;

  const semToken = await pedir('/api/grafos/app-mapa/mapa', 'GET');
  ok(semToken.status === 401, `sem token ⇒ 401 (achei ${semToken.status})`);

  const porQuery = await pedir(`/api/grafos/app-mapa/mapa?token=${TOKEN}`, 'GET');
  ok(porQuery.status === 200, `?token= na query ⇒ 200 (achei ${porQuery.status})`);

  const r = await pedir('/api/grafos/app-mapa/mapa', 'GET', bearer(TOKEN));
  ok(r.status === 200, `/api/grafos/app-mapa/mapa ⇒ 200 (achei ${r.status})`);
  const corpo = JSON.parse(r.corpo);
  ok(corpo.nivel === 1, `nivel === 1 (achei ${corpo.nivel})`);
  ok(corpo.cabecalho.bytes === bytesAppMapa, `cabecalho.bytes === statSync (achei ${corpo.cabecalho.bytes} vs ${bytesAppMapa})`);

  const naoExiste = await pedir('/api/grafos/nao-existe/mapa', 'GET', bearer(TOKEN));
  ok(naoExiste.status === 404 && JSON.parse(naoExiste.corpo).erro === 'sem grafo', `/api/grafos/nao-existe/mapa ⇒ 404 sem grafo (achei ${naoExiste.status} ${naoExiste.corpo})`);
  const pastaSolta = await pedir('/api/grafos/pasta-solta/mapa', 'GET', bearer(TOKEN));
  ok(pastaSolta.status === 404, `/api/grafos/pasta-solta/mapa ⇒ 404 (achei ${pastaSolta.status})`);
  const nomeInvalido = await pedir('/api/grafos/a.b/mapa', 'GET', bearer(TOKEN));
  ok(nomeInvalido.status === 404, `/api/grafos/a.b/mapa ⇒ 404 — fora do NOME_DE_PASTA (achei ${nomeInvalido.status})`);
  const duploPontoCodificado = await pedir('/api/grafos/%2E%2E/mapa', 'GET', bearer(TOKEN));
  ok(duploPontoCodificado.status === 404, `/api/grafos/%2E%2E/mapa ⇒ 404 — achatado pelo new URL antes da rota (achei ${duploPontoCodificado.status})`);
  const barraCodificada = await pedir('/api/grafos/a%2Fb/mapa', 'GET', bearer(TOKEN));
  ok(barraCodificada.status === 404, `/api/grafos/a%2Fb/mapa ⇒ 404 — %2F sobrevive ao parser, cai no decodeURIComponent+NOME_DE_PASTA (achei ${barraCodificada.status})`);
  const travessiaCodificada = await pedir('/api/grafos/..%2F..%2Fetc/mapa', 'GET', bearer(TOKEN));
  ok(travessiaCodificada.status === 404, `/api/grafos/..%2F..%2Fetc/mapa ⇒ 404 (achei ${travessiaCodificada.status})`);
  const nulNoNome = await pedir('/api/grafos/app-mapa%00/mapa', 'GET', bearer(TOKEN));
  ok(nulNoNome.status === 404, `/api/grafos/app-mapa%00/mapa ⇒ 404 (achei ${nulNoNome.status})`);

  const n2 = await pedir('/api/grafos/app-mapa/mapa?camada=layer%3Acamada-grande', 'GET', bearer(TOKEN));
  ok(n2.status === 200 && JSON.parse(n2.corpo).nivel === 2, `?camada=layer:camada-grande ⇒ 200 nível 2 (achei ${n2.status})`);
  const n2Pasta = await pedir('/api/grafos/app-mapa/mapa?camada=layer%3Acamada-grande&pasta=src%2Flib%2Futil', 'GET', bearer(TOKEN));
  const corpoN2Pasta = JSON.parse(n2Pasta.corpo);
  ok(n2Pasta.status === 200 && corpoN2Pasta.arquivos.length === 50, `&pasta=src/lib/util ⇒ 50 arquivos (achei ${n2Pasta.status} ${corpoN2Pasta.arquivos && corpoN2Pasta.arquivos.length})`);

  const camadaFora = await pedir('/api/grafos/app-mapa/mapa?camada=layer%3Anada', 'GET', bearer(TOKEN));
  ok(camadaFora.status === 404 && JSON.parse(camadaFora.corpo).erro === 'fora do grafo', `?camada=layer:nada ⇒ 404 fora do grafo (achei ${camadaFora.status} ${camadaFora.corpo})`);
  const pastaTravessia = await pedir('/api/grafos/app-mapa/mapa?camada=layer%3Acamada-grande&pasta=..%2F..', 'GET', bearer(TOKEN));
  ok(pastaTravessia.status === 404, `?pasta=../.. ⇒ 404 (achei ${pastaTravessia.status})`);
  const pastaAbsoluta = await pedir('/api/grafos/app-mapa/mapa?camada=layer%3Acamada-grande&pasta=%2Fetc', 'GET', bearer(TOKEN));
  ok(pastaAbsoluta.status === 404, `&pasta=/etc ⇒ 404 (achei ${pastaAbsoluta.status})`);
  const camadaComNul = await pedir('/api/grafos/app-mapa/mapa?camada=layer%3Acamada-grande%00', 'GET', bearer(TOKEN));
  ok(camadaComNul.status === 404, `?camada=layer:camada-grande%00 ⇒ 404 (achei ${camadaComNul.status})`);
  const pastaComNul = await pedir('/api/grafos/app-mapa/mapa?camada=layer%3Acamada-grande&pasta=src%2Flib%00', 'GET', bearer(TOKEN));
  ok(pastaComNul.status === 404, `&pasta=src/lib%00 ⇒ 404 (achei ${pastaComNul.status})`);

  const n3 = await pedir('/api/grafos/app-mapa/mapa?arquivo=src%2Flib%2Fbanco.ts', 'GET', bearer(TOKEN));
  const corpoN3 = JSON.parse(n3.corpo);
  ok(n3.status === 200 && corpoN3.nivel === 3 && corpoN3.usadoPor.itens.length === 60, `?arquivo=src/lib/banco.ts ⇒ 200 nível 3, 60 itens (achei ${n3.status} ${corpoN3.usadoPor && corpoN3.usadoPor.itens.length})`);
  const n3Completo = await pedir('/api/grafos/app-mapa/mapa?arquivo=src%2Flib%2Fbanco.ts&completo=1', 'GET', bearer(TOKEN));
  ok(JSON.parse(n3Completo.corpo).usadoPor.itens.length === 71, `&completo=1 ⇒ 71 itens (achei ${JSON.parse(n3Completo.corpo).usadoPor.itens.length})`);

  const arquivoIsca = await pedir(`/api/grafos/app-mapa/mapa?arquivo=..%2Fsegredo-${f.pid}.txt`, 'GET', bearer(TOKEN));
  ok(arquivoIsca.status === 200, `?arquivo=../segredo-<pid>.txt ⇒ 200 (é nó do grafo) (achei ${arquivoIsca.status})`);
  ok(!arquivoIsca.corpo.includes('ISCA-NAO-PODE-VAZAR'), 'o corpo NUNCA contém o conteúdo do arquivo-isca (o servidor não abre arquivo real)');
  const arquivoAbsoluto = await pedir('/api/grafos/app-mapa/mapa?arquivo=%2Fetc%2Fpasswd', 'GET', bearer(TOKEN));
  ok(arquivoAbsoluto.status === 404, `?arquivo=/etc/passwd ⇒ 404 (achei ${arquivoAbsoluto.status})`);
  const arquivoComNul = await pedir('/api/grafos/app-mapa/mapa?arquivo=src%2Flib%2Fbanco.ts%00', 'GET', bearer(TOKEN));
  ok(arquivoComNul.status === 404, `?arquivo=src/lib/banco.ts%00 ⇒ 404 (achei ${arquivoComNul.status})`);

  // Dois projetos, cache compartilhado: cada resposta com o cabecalho DELA.
  const umaVez = JSON.parse((await pedir('/api/grafos/app-mapa/mapa', 'GET', bearer(TOKEN))).corpo);
  const dois = JSON.parse((await pedir('/api/grafos/app-mapa-dois/mapa', 'GET', bearer(TOKEN))).corpo);
  const umaVezDeNovo = JSON.parse((await pedir('/api/grafos/app-mapa/mapa', 'GET', bearer(TOKEN))).corpo);
  ok(umaVez.cabecalho.projeto === 'app-mapa' && dois.cabecalho.projeto === 'app-mapa-dois' && umaVezDeNovo.cabecalho.projeto === 'app-mapa',
    `cabecalho.projeto de cada um (achei ${umaVez.cabecalho.projeto}, ${dois.cabecalho.projeto}, ${umaVezDeNovo.cabecalho.projeto})`);
  ok(dois.cabecalho.bytes !== umaVez.cabecalho.bytes, `cabecalho.bytes diferentes entre os dois projetos (achei ${dois.cabecalho.bytes} vs ${umaVez.cabecalho.bytes})`);
  ok(umaVez.cabecalho.bytes === umaVezDeNovo.cabecalho.bytes, 'cabecalho.bytes de app-mapa igual nas duas leituras (cache compartilhado, não misturado)');

  for (const resp of [r, n2, n3]) {
    ok(Buffer.byteLength(resp.corpo) < 64 * 1024, `resposta < 64 KB (achei ${Buffer.byteLength(resp.corpo)})`);
    ok(!resp.corpo.includes(f.grafosDir) && !resp.corpo.includes(f.projetosDir) && !resp.corpo.includes('/home/') && !resp.corpo.includes('a'.repeat(40)),
      'a resposta não contém grafosDir/projetosDir/"/home/"/sha (#22)');
  }
}

// ─── (e2) tabela fechada do M6 ──────────────────────────────────────────────────────────────────

async function blocoE2(TOKEN) {
  const casos = ['?pasta=x', '?arquivo=a&camada=b', '?arquivo=a&pasta=b', '?completo=1',
    '?arquivo=a&completo=sim', '?outra=1', '?camada=a&camada=b'];
  for (const q of casos) {
    const r = await pedir(`/api/grafos/app-mapa/mapa${q}`, 'GET', bearer(TOKEN));
    ok(r.status === 400 && JSON.parse(r.corpo).erro === 'pedido inválido', `${q} ⇒ 400 pedido inválido (achei ${r.status} ${r.corpo})`);
    const rForaDaLista = await pedir(`/api/grafos/nao-existe-de-verdade/mapa${q}`, 'GET', bearer(TOKEN));
    ok(rForaDaLista.status === 400, `${q} num projeto inexistente também ⇒ 400 (validação antes da loja) (achei ${rForaDaLista.status})`);
  }
}

// ─── (e) casca — GET /mapa/<nome>/ ──────────────────────────────────────────────────────────────

async function blocoE() {
  const existe = await pedir('/mapa/app-mapa/', 'GET');
  ok(existe.status === 200 && existe.headers['content-type'].includes('text/html'), `/mapa/app-mapa/ ⇒ 200 text/html (achei ${existe.status} ${existe.headers['content-type']})`);
  ok(existe.corpo.includes('../../grafo-mapa.js'), 'corpo contém ../../grafo-mapa.js');
  // Pela TAG, não pelo nome solto: comentário que cite o arquivo não pode enganar a ordem.
  const iTraducoes = existe.corpo.indexOf('<script src="../../traducoes.js">');
  const iI18n = existe.corpo.indexOf('<script src="../../i18n.js">');
  const iGrafoMapa = existe.corpo.indexOf('<script src="../../grafo-mapa.js">');
  ok(iTraducoes >= 0 && iTraducoes < iI18n && iI18n < iGrafoMapa, `ordem traducoes.js < i18n.js < grafo-mapa.js (achei ${iTraducoes}, ${iI18n}, ${iGrafoMapa})`);
  // Print de 17/10: com os scripts no <head>, o grafo-mapa.js rodava antes do #mapa-raiz existir e a
  // página ficava em BRANCO (os gates de Node estavam verdes). Os três vêm depois do #mapa-raiz.
  const iRaiz = existe.corpo.indexOf('id="mapa-raiz"');
  ok(iRaiz >= 0 && iTraducoes > iRaiz, `os scripts vêm DEPOIS do #mapa-raiz (achei raiz=${iRaiz}, 1º script=${iTraducoes})`);
  ok(existe.corpo.includes('cockpit-tema'), 'contém o script de tema (cockpit-tema)');

  const naoExiste = await pedir('/mapa/nao-existe/', 'GET');
  ok(naoExiste.status === 200 && naoExiste.corpo.includes('../../grafo-mapa.js'), `/mapa/nao-existe/ ⇒ 200 também (casca sem oráculo) (achei ${naoExiste.status})`);

  const semBarra = await pedir('/mapa/app-mapa', 'GET');
  ok(semBarra.status === 301 && semBarra.headers.location === 'app-mapa/', `/mapa/app-mapa ⇒ 301 location app-mapa/ (achei ${semBarra.status} ${semBarra.headers.location})`);
  const comCockpit = await pedir('/cockpit/mapa/app-mapa', 'GET');
  ok(comCockpit.status === 301 && comCockpit.headers.location === 'app-mapa/', `/cockpit/mapa/app-mapa ⇒ 301 location app-mapa/ (achei ${comCockpit.status} ${comCockpit.headers.location})`);

  const nomeInvalido = await pedir('/mapa/a.b/', 'GET');
  ok(nomeInvalido.status === 404, `/mapa/a.b/ ⇒ 404 (achei ${nomeInvalido.status})`);
  const indexSolto = await pedir('/mapa/index.html', 'GET');
  ok(indexSolto.status === 404, `/mapa/index.html ⇒ 404 (achei ${indexSolto.status})`);
  const indexDoNome = await pedir('/mapa/app-mapa/index.html', 'GET');
  ok(indexDoNome.status === 404, `/mapa/app-mapa/index.html ⇒ 404 — só a URL canônica com / serve a casca (achei ${indexDoNome.status})`);
  const fuga = await pedir('/mapa/a%2F..%2F/', 'GET');
  ok(fuga.status === 404, `/mapa/a%2F..%2F/ ⇒ 404 (achei ${fuga.status})`);
  const fugaCrua = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORTA, path: '/mapa/app-mapa/../../server.js', method: 'GET', agent: false }, (res) => {
      const pedacos = [];
      res.on('data', (d) => pedacos.push(d));
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
  ok(fugaCrua.status === 404 || fugaCrua.status === 403, `/mapa/app-mapa/../../server.js (pedido cru) ⇒ 404 ou 403, nunca 200 (achei ${fugaCrua.status})`);
  const arquivoQualquer = await pedir('/mapa/app-mapa/qualquer.js', 'GET');
  ok(arquivoQualquer.status === 404, `/mapa/app-mapa/qualquer.js ⇒ 404 (achei ${arquivoQualquer.status})`);
}

// ─── (f) loja real intocada ──────────────────────────────────────────────────────────────────

function listaDaLojaReal() {
  try { return fs.readdirSync(path.join(os.userInfo().homedir, '.cockpit', 'grafos')).sort(); } catch { return []; }
}

async function principal() {
  const lojaRealAntes = listaDaLojaReal();

  await bloco('(a) lib/grafo-mapa.js — índice e três níveis (puro)', blocoA);
  await bloco('(b) lib/grafo-mapa.js — leitor com cache (indiceDo)', blocoB);
  await bloco('(d) puras do cliente (public/grafo-mapa.js, sem DOM)', blocoD);

  const TOKEN = 'segredo-gate';
  const f = montarFixtureDeDisco();
  await withServer({ projetosDir: f.projetosDir, grafosDir: f.grafosDir, token: TOKEN }, async () => {
    await bloco('(c) rota de dados — GET /api/grafos/<nome>/mapa', () => blocoC(f, TOKEN));
    await bloco('(e2) tabela fechada dos parâmetros (M6)', () => blocoE2(TOKEN));
    await bloco('(e) casca — GET /mapa/<nome>/', blocoE);
  });

  await bloco('(f) a loja real (~/.cockpit/grafos) nunca é tocada', () => {
    ok(JSON.stringify(listaDaLojaReal()) === JSON.stringify(lojaRealAntes), 'a lista da loja real é a mesma do início do gate');
    ok(!listaDaLojaReal().includes('app-mapa'), 'nenhuma pasta "app-mapa" na loja real');
  });

  console.log(`\n${passou}/${total} asserções`);
  console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — mapa simples do grafo');
  process.exitCode = vermelho ? 1 : 0;
}

principal();
