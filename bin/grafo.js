#!/usr/bin/env node
'use strict';
// CLI do grafo do projeto — spec/plano `2026-10-16-grafo-do-projeto-no-cockpit`.
// Comandos: gerar, atualizar, instalar-hook, remover-hook, status-hook, comparar, inventario, rollout.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gitlib = require('../lib/grafo-git.js');
const loja = require('../lib/grafo-loja.js');
const hooklib = require('../lib/grafo-hook.js');
const inventariolib = require('../lib/grafo-inventario.js');
const { montarGrafo, deveIndexar, SEGMENTOS_EXCLUIDOS } = require('../lib/grafo-extrator.js');
const { analisarPython } = require('../lib/grafo-python.js');

function esperarMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

function ehSegmentoExcluido(caminho) {
  return caminho.split('/').some((s) => SEGMENTOS_EXCLUIDOS.has(s));
}

/** `.ua/knowledge-graph.json` do checkout, até 4 níveis, pulando node_modules/.git/.ua. */
function acharUaNoDisco(raiz, nivel, prefixo, resultado) {
  const uaDir = path.join(raiz, '.ua');
  if (fs.existsSync(path.join(uaDir, 'knowledge-graph.json')) && fs.existsSync(path.join(uaDir, 'meta.json'))) {
    resultado.push({ prefixo, grafoArq: path.join(uaDir, 'knowledge-graph.json'), metaArq: path.join(uaDir, 'meta.json') });
  }
  if (nivel === 0) return;
  let entradas;
  try { entradas = fs.readdirSync(raiz, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git' || e.name === '.ua') continue;
    acharUaNoDisco(path.join(raiz, e.name), nivel - 1, `${prefixo}${e.name}/`, resultado);
  }
}

async function acharHeranca(repoPrincipalPath, shaUsado) {
  const achados = [];
  acharUaNoDisco(repoPrincipalPath, 4, '', achados);
  const comData = [];
  for (const a of achados) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(a.metaArq, 'utf8')); } catch { continue; }
    if (!meta.gitCommitHash) continue;
    const ancestral = await gitlib.ehAncestral(repoPrincipalPath, meta.gitCommitHash, shaUsado);
    if (ancestral !== true) continue;
    let grafo;
    try { grafo = JSON.parse(fs.readFileSync(a.grafoArq, 'utf8')); } catch { continue; }
    comData.push({ prefixo: a.prefixo, grafo, profundidade: a.prefixo.split('/').filter(Boolean).length });
  }
  comData.sort((x, y) => x.profundidade - y.profundidade);
  return comData.map(({ prefixo, grafo }) => ({ prefixo, grafo }));
}

/** Lê a árvore de `sha`, filtra, lê os blobs em lote e separa `arquivos`/`configs`/python. */
async function coletarDados(repoPrincipalPath, sha) {
  const todaArvore = await gitlib.arvore(repoPrincipalPath, sha);
  const indexados = todaArvore.filter((e) => deveIndexar(e.caminho, e.tamanho));
  // Os grandes saem AQUI (antes do `montarGrafo`), então o aviso tem de nascer aqui também — senão
  // o arquivo some calado (achado do painel de execução).
  const grandes = todaArvore.filter((e) => !deveIndexar(e.caminho, e.tamanho) && deveIndexar(e.caminho, 0)).length;
  const configsEntradas = todaArvore.filter((e) => {
    const base = path.posix.basename(e.caminho);
    return (base === 'tsconfig.json' || base === 'jsconfig.json') && !ehSegmentoExcluido(e.caminho);
  });
  const blobs = await gitlib.lerBlobs(repoPrincipalPath, [...indexados, ...configsEntradas].map((e) => e.sha));

  const arquivos = new Map();
  for (const e of indexados) {
    const buf = blobs.get(e.sha);
    if (!buf || buf.includes(0)) continue; // binário (byte nulo) fica de fora
    arquivos.set(e.caminho, buf.toString('utf8'));
  }
  const configs = new Map();
  for (const e of configsEntradas) {
    const buf = blobs.get(e.sha);
    if (buf) configs.set(e.caminho, buf.toString('utf8'));
  }

  const arquivosPy = [...arquivos].filter(([c]) => path.posix.extname(c) === '.py').map(([caminho, texto]) => ({ caminho, texto }));
  const python = arquivosPy.length ? await analisarPython(arquivosPy) : [];
  const heranca = await acharHeranca(repoPrincipalPath, sha);
  return { arquivos, configs, python, heranca, grandes };
}

/** Uma volta: lê a develop (ou a `refFixa`), monta, publica em `destino`. Chamado com a trava JÁ tomada. */
async function umaVolta(repoPrincipalPath, destino, refFixa) {
  let shaUsado; let refUsada;
  if (refFixa) { shaUsado = refFixa.sha; refUsada = refFixa.ref; }
  else {
    const d = await gitlib.refDaDevelop(repoPrincipalPath);
    if (!d) return { semDevelop: true };
    shaUsado = d.sha; refUsada = d.ref;
  }
  const dados = await coletarDados(repoPrincipalPath, shaUsado);
  const anterior = loja.lerGrafo(destino);
  const t0 = Date.now();
  const { grafo, avisos, herdados } = montarGrafo({
    arquivos: dados.arquivos, configs: dados.configs, sha: shaUsado, ref: refUsada,
    nome: path.basename(repoPrincipalPath), analisadoEm: new Date().toISOString(),
    python: dados.python, heranca: dados.heranca, anterior,
  });
  const durationMs = Date.now() - t0;
  if (dados.grandes > 0) avisos.push(`${dados.grandes} arquivo(s) acima de 512 KB ficaram de fora`);
  const meta = {
    lastAnalyzedAt: grafo.project.analyzedAt, gitCommitHash: grafo.project.gitCommitHash, ref: refUsada,
    engine: 'cockpit-deterministico', version: grafo.version,
    analyzedFiles: grafo.nodes.filter((n) => n.type === 'file').length,
    durationMs, herdados, avisos,
  };
  loja.publicar(destino, grafo, meta);
  return { grafo, meta, shaUsado };
}

/** Dono da trava roda o mesmo ciclo: gera → publica → solta → pendente/mudou? pega de novo. Teto 20. */
async function cicloDeGeracao(repoPrincipalPath, destino, refFixa) {
  for (let volta = 1; volta <= 20; volta += 1) {
    const resultado = await umaVolta(repoPrincipalPath, destino, refFixa);
    loja.soltarTrava(destino);
    if (resultado.semDevelop) return resultado;
    if (refFixa) return resultado; // --saida + --ref: ref fixa, uma volta só
    // A marca `.pendente` só diz "alguém chegou enquanto eu gerava"; quem decide se há trabalho é a
    // develop. Sem ela ter andado, gerar de novo seria repetir o mesmo sha.
    loja.consumirPendente(destino);
    const atual = await gitlib.refDaDevelop(repoPrincipalPath);
    const mudou = atual && atual.sha !== resultado.shaUsado;
    if (!mudou) return resultado;
    const tomou = await loja.tomarTrava(destino);
    if (!tomou) { loja.marcarPendente(destino); return resultado; }
  }
  loja.registrar(destino, 'cicloDeGeracao abortado: 20 voltas sem assentar');
  return {};
}

async function esperarTrava(destino, tetoMs) {
  const t0 = Date.now();
  for (;;) {
    if (await loja.tomarTrava(destino)) return true;
    if (Date.now() - t0 > tetoMs) return false;
    await esperarMs(250);
  }
}

function imprimirLinha(nome, resultado) {
  if (!resultado || resultado.semDevelop) return;
  const { grafo, meta } = resultado;
  if (!grafo) return;
  const nos = grafo.nodes.length;
  const arestas = grafo.edges.length;
  const herdados = meta.herdados;
  const s = (meta.durationMs / 1000).toFixed(1);
  console.log(`${nome} ${meta.gitCommitHash.slice(0, 7)} ${nos} nós · ${arestas} arestas · ${herdados} herdados · ${s} s`);
}

async function comandoGerar(args) {
  const caminho = args[0];
  let saida = null; let ref = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--saida') saida = args[i += 1];
    else if (args[i] === '--ref') ref = args[i += 1];
  }
  if (ref && !saida) { console.error('--ref só vale junto com --saida'); process.exitCode = 2; return; }

  const repoPrincipalPath = await gitlib.repoPrincipal(caminho);
  if (!repoPrincipalPath) { console.error(`não é um repositório git: ${caminho}`); process.exitCode = 2; return; }
  const destino = saida ? path.resolve(saida) : loja.pastaDo(path.basename(repoPrincipalPath));

  let refFixa = null;
  if (ref) {
    let sha;
    try { sha = (await gitlib.git(['-C', repoPrincipalPath, 'rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: repoPrincipalPath })).trim(); }
    catch { console.error(`ref inexistente: ${ref}`); process.exitCode = 3; return; }
    refFixa = { ref, sha };
  } else {
    const d = await gitlib.refDaDevelop(repoPrincipalPath);
    if (!d) { console.error('sem develop'); process.exitCode = 3; return; }
  }

  const tomou = await esperarTrava(destino, 120000);
  if (!tomou) { console.error('outro processo gerando'); process.exitCode = 4; return; }
  try {
    const resultado = await cicloDeGeracao(repoPrincipalPath, destino, refFixa);
    if (resultado.semDevelop) { console.error('sem develop'); process.exitCode = 3; return; }
    imprimirLinha(path.basename(repoPrincipalPath), resultado);
  } finally {
    loja.soltarTrava(destino);
  }
}

async function comandoAtualizar(caminhoArg) {
  const repoPrincipalPath = await gitlib.repoPrincipal(caminhoArg);
  if (!repoPrincipalPath) { process.exitCode = 0; return; } // nunca quebra quem chamou (hook)
  const d = await gitlib.refDaDevelop(repoPrincipalPath);
  if (!d) { process.exitCode = 0; return; }
  const destino = loja.pastaDo(path.basename(repoPrincipalPath));
  const shaPub = loja.shaPublicado(destino);
  const grafoExiste = fs.existsSync(path.join(destino, 'knowledge-graph.json'));
  if (shaPub === d.sha && grafoExiste) { process.exitCode = 0; return; }

  if (!(await loja.tomarTrava(destino))) {
    loja.marcarPendente(destino);
    loja.registrar(destino, `atualizar: trava ocupada, marcado pendente (sha=${d.sha})`);
    process.exitCode = 0;
    return;
  }
  // Reconfere DEPOIS de pegar a trava: entre a conferência lá de cima e agora, outro `atualizar`
  // pode ter gerado e publicado este mesmo sha e soltado a trava (visto no gate sob carga: duas
  // gerações do mesmo sha). Quem chega atrasado não gera de novo.
  const dAgora = await gitlib.refDaDevelop(repoPrincipalPath);
  if (dAgora && loja.shaPublicado(destino) === dAgora.sha && fs.existsSync(path.join(destino, 'knowledge-graph.json'))) {
    loja.soltarTrava(destino);
    process.exitCode = 0;
    return;
  }
  loja.registrar(destino, `atualizar: início sha=${d.sha}`);
  const t0 = Date.now();
  try {
    const resultado = await cicloDeGeracao(repoPrincipalPath, destino, null);
    loja.registrar(destino, `atualizar: fim sha=${resultado.meta && resultado.meta.gitCommitHash} em ${Date.now() - t0}ms`);
    process.exitCode = 0;
  } catch (erro) {
    loja.registrar(destino, `atualizar: erro ${erro && erro.message}`);
    process.exitCode = 1;
  } finally {
    loja.soltarTrava(destino);
  }
}

async function comandoInstalarHook(args) {
  const repo = args[0];
  const permitirWorktree = args.includes('--permitir-worktree');
  let r;
  try { r = await hooklib.instalar(repo, { permitirWorktree }); }
  catch (e) { console.error(`erro ao instalar: ${e && e.message}`); process.exitCode = 2; return; }
  if (r.recusado) { console.log(`recusado: ${r.recusado}`); process.exitCode = 2; return; }
  for (const h of r.instalados) console.log(`instalado: ${h}`);
  for (const p of r.pulados) console.log(`pulado: ${p.hook} — ${p.motivo}`);
}

async function comandoRemoverHook(args) {
  const repo = args[0];
  let r;
  try { r = await hooklib.remover(repo); }
  catch (e) { console.error(`erro ao remover: ${e && e.message}`); process.exitCode = 2; return; }
  for (const h of r.removidos) console.log(`removido: ${h}`);
  if (r.removidos.length === 0) console.log('nada instalado');
}

async function comandoStatusHook(args) {
  const repo = args[0];
  let r;
  try { r = await hooklib.status(repo); }
  catch (e) { console.error(`erro ao conferir: ${e && e.message}`); process.exitCode = 2; return; }
  for (const h of hooklib.HOOKS) {
    const info = r[h];
    let linha = `${h}: ${info.estado}`;
    if (info.legadoUaGrafo) linha += ' (bloco ua-grafo legado presente)';
    console.log(linha);
  }
}

// ─── comparar (Fase 3) ──────────────────────────────────────────────────────

function mapaPorId(grafo) { return new Map(grafo.nodes.map((n) => [n.id, n])); }

function rodarComparar(gabaritoPath, novoPath, comoJson) {
  const gabarito = JSON.parse(fs.readFileSync(gabaritoPath, 'utf8'));
  const novo = JSON.parse(fs.readFileSync(novoPath, 'utf8'));
  const porIdGab = mapaPorId(gabarito);
  const porIdNovo = mapaPorId(novo);

  const arquivosGab = new Set(gabarito.nodes.filter((n) => n.type === 'file').map((n) => n.filePath));
  const arquivosNovo = new Set(novo.nodes.filter((n) => n.type === 'file').map((n) => n.filePath));
  const universo = new Set([...arquivosGab].filter((p) => arquivosNovo.has(p)));

  const arquivoDe = (mapa, id) => { const n = mapa.get(id); return n ? n.filePath : undefined; };
  const dentroDoUniverso = (mapa, id) => universo.has(arquivoDe(mapa, id));
  const chaveSemTipo = (e) => `${e.source}|${e.target}`;

  const TIPOS_DEP = new Set(['imports', 'depends_on']);
  // Dependência é arquivo→arquivo (spec), e o mesmo par pode vir como `imports` E `depends_on` no
  // gabarito: conta uma vez só, senão o denominador infla.
  const ehArquivo = (mapa, id) => { const n = mapa.get(id); return Boolean(n && n.type === 'file'); };
  const unicas = (lista) => [...new Map(lista.map((e) => [chaveSemTipo(e), e])).values()];
  const depDe = (grafo, mapa) => unicas(grafo.edges.filter((e) => TIPOS_DEP.has(e.type)
    && ehArquivo(mapa, e.source) && ehArquivo(mapa, e.target)
    && dentroDoUniverso(mapa, e.source) && dentroDoUniverso(mapa, e.target)));
  const depGab = depDe(gabarito, porIdGab);
  const depNovo = depDe(novo, porIdNovo);
  const depNovoChaves = new Set(depNovo.map(chaveSemTipo));
  const depGabChaves = new Set(depGab.map(chaveSemTipo));
  const depAchadas = depGab.filter((e) => depNovoChaves.has(chaveSemTipo(e)));
  const depFaltando = depGab.filter((e) => !depNovoChaves.has(chaveSemTipo(e)));
  const depExtras = depNovo.filter((e) => !depGabChaves.has(chaveSemTipo(e)));
  const coberturaDependencia = depGab.length ? depAchadas.length / depGab.length : 1;

  const callsGab = gabarito.edges.filter((e) => e.type === 'calls' && dentroDoUniverso(porIdGab, e.source) && dentroDoUniverso(porIdGab, e.target));
  const callsDetalhe = callsGab.map((e) => {
    const srcExiste = porIdNovo.has(e.source);
    const tgtExiste = porIdNovo.has(e.target);
    if (!srcExiste || !tgtExiste) return { edge: e, categoria: 'nó ausente no novo' };
    const achou = novo.edges.some((n) => n.source === e.source && n.target === e.target && n.type === 'calls');
    return { edge: e, categoria: achou ? 'achada' : 'nó presente sem a aresta' };
  });
  const callsAchadas = callsDetalhe.filter((d) => d.categoria === 'achada').length;
  const callsNoAusente = callsDetalhe.filter((d) => d.categoria === 'nó ausente no novo').length;
  const callsSemAresta = callsDetalhe.filter((d) => d.categoria === 'nó presente sem a aresta').length;
  const coberturaCalls = callsGab.length ? callsAchadas / callsGab.length : 1;

  const faltando = [
    ...depFaltando.map((e) => ({ categoria: 'dependência', source: e.source, target: e.target })),
    ...callsDetalhe.filter((d) => d.categoria !== 'achada').map((d) => ({ categoria: `calls: ${d.categoria}`, source: d.edge.source, target: d.edge.target })),
  ];

  const resultado = {
    universo: universo.size,
    dependencia: { gabarito: depGab.length, achadas: depAchadas.length, cobertura: coberturaDependencia, extras: depExtras.map((e) => ({ source: e.source, target: e.target, type: e.type })) },
    calls: { gabarito: callsGab.length, achadas: callsAchadas, noAusente: callsNoAusente, semAresta: callsSemAresta, cobertura: coberturaCalls },
    faltando,
  };

  if (comoJson) { console.log(JSON.stringify(resultado, null, 2)); return resultado; }

  console.log(`universo (arquivos nos dois grafos): ${universo.size}`);
  console.log(`cobertura de dependência: ${(coberturaDependencia * 100).toFixed(1)}% (${depAchadas.length}/${depGab.length})`);
  console.log(`extras do novo (dependência que o gabarito não tem): ${depExtras.length}`);
  for (const e of depExtras) console.log(`  + ${e.source} -> ${e.target} (${e.type})`);
  console.log(`cobertura de calls: ${(coberturaCalls * 100).toFixed(1)}% (${callsAchadas}/${callsGab.length}) — nó ausente no novo: ${callsNoAusente} · nó presente sem a aresta: ${callsSemAresta}`);
  console.log(`arestas do gabarito que faltaram (${faltando.length}):`);
  for (const f of faltando) console.log(`  [${f.categoria}] ${f.source} -> ${f.target}`);

  return resultado;
}

// ─── inventario e rollout (Fase 8, dry-run) ────────────────────────────────

function formatarTabelaInventario(itens) {
  const linhas = [];
  for (const item of itens) {
    if (!item.git) { linhas.push(`${item.pasta}: sem git`); continue; }
    const avisoNome = item.nomeValido ? '' : ' [nome fora do padrão]';
    const developTxt = item.develop ? `${item.develop.ref} ${item.develop.sha}` : 'nenhuma';
    const lojaTxt = !item.loja ? 'sem grafo'
      : item.loja.estado === 'em-dia' ? `em dia (${item.loja.geradoEm})`
      : item.loja.estado === 'atras' ? `${item.loja.commitsAtras} atras (${item.loja.geradoEm})`
      : `${item.loja.estado} (${item.loja.geradoEm})`;
    const codigoTxt = item.arquivosCodigo == null ? '' : ` · ${item.arquivosCodigo} arquivo(s) de código`;
    const hookTxt = item.hookCockpit + (item.hookUaLegado ? ' · ua-grafo legado presente' : '');
    linhas.push(`${item.pasta}${avisoNome} · develop: ${developTxt} · loja: ${lojaTxt} · hook: ${hookTxt}${codigoTxt}`);
    for (const ua of item.uaLegado) {
      linhas.push(`  .ua/${ua.pasta === '.' ? '' : ua.pasta} — motor ${ua.motor} · sha ${ua.sha || '?'} · ${ua.estado}${ua.geradoEm ? ` · ${ua.geradoEm}` : ''}`);
    }
  }
  return linhas.join('\n');
}

function raizPadrao() { return path.join(os.homedir(), 'projetos'); }

async function comandoInventario(args) {
  const posicionais = args.filter((a) => !a.startsWith('--'));
  const raiz = posicionais[0] || raizPadrao();
  const itens = await inventariolib.inventario(raiz);
  if (args.includes('--json')) { console.log(JSON.stringify(itens, null, 2)); return; }
  console.log(formatarTabelaInventario(itens));
}

async function comandoRollout(args) {
  const posicionais = args.filter((a) => !a.startsWith('--'));
  const raiz = posicionais[0] || raizPadrao();
  const rodarFlag = args.includes('--rodar');
  const hookFlag = args.includes('--hook');
  const itens = await inventariolib.inventario(raiz);
  // Nome fora do padrão não tem loja nem rota (achado do painel): vai para a lista à parte, nunca para o laço.
  const comDevelopSemGrafo = itens.filter((i) => i.git && i.develop && !i.loja && i.nomeValido);
  const nomeRuim = itens.filter((i) => i.git && !i.nomeValido);
  comDevelopSemGrafo.sort((a, b) => (a.arquivosCodigo || 0) - (b.arquivosCodigo || 0));
  const semDevelop = itens.filter((i) => i.git && !i.develop);

  console.log('Com develop e sem grafo na loja (do menor para o maior em arquivos de código):');
  for (const item of comDevelopSemGrafo) {
    const caminho = path.join(raiz, item.pasta);
    console.log(`  ${item.pasta} (${item.arquivosCodigo} arquivo(s) de código)`);
    console.log(`    node bin/grafo.js gerar ${caminho}`);
    console.log(`    node bin/grafo.js instalar-hook ${caminho}`);
  }
  if (semDevelop.length) {
    console.log('\nSem develop (decidir caso a caso):');
    for (const item of semDevelop) console.log(`  ${item.pasta}`);
  }
  if (nomeRuim.length) {
    console.log('\nNome fora do padrão (renomear a pasta para entrar no grafo):');
    for (const item of nomeRuim) console.log(`  ${item.pasta}`);
  }
  if (!rodarFlag) { console.log('\n(--rodar não foi passado: nada foi gerado nem instalado)'); return; }

  // Um projeto que falha não derruba os seguintes: cada um é relatado e o laço segue.
  for (const item of comDevelopSemGrafo) {
    const caminho = path.join(raiz, item.pasta);
    try {
      await comandoGerar([caminho]);
      if (hookFlag) await comandoInstalarHook([caminho]);
    } catch (erro) {
      console.error(`${item.pasta}: falhou — ${erro && erro.message}`);
    }
  }
}

async function main() {
  const [comando, ...resto] = process.argv.slice(2);
  switch (comando) {
    case 'gerar': return comandoGerar(resto);
    case 'atualizar': return comandoAtualizar(resto[0]);
    case 'instalar-hook': return comandoInstalarHook(resto);
    case 'remover-hook': return comandoRemoverHook(resto);
    case 'status-hook': return comandoStatusHook(resto);
    case 'comparar':
      rodarComparar(resto[0], resto[1], resto.includes('--json'));
      return undefined;
    case 'inventario': return comandoInventario(resto);
    case 'rollout': return comandoRollout(resto);
    default:
      console.error(`comando desconhecido: ${comando || '(nenhum)'}`);
      process.exitCode = 2;
      return undefined;
  }
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
