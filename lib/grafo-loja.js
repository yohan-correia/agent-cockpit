'use strict';
/**
 * Onde o grafo do projeto mora: `knowledge-graph.json` (atual), `knowledge-graph.anterior.json`
 * (a versão publicada antes desta), `meta.json`, `atualizar.log`, `.trava`, `.pendente`.
 *
 * Publicação por `rename` (nunca a loja fica sem o grafo atual), trava com retomada de dono
 * morto/velho, e os ganchos de teste de `COCKPIT_GRAFO_TESTE_MORRER`/`_LENTO` — só obedecidos
 * quando o destino está dentro de `os.tmpdir()` (o código vai para o export público; numa loja
 * de verdade essas duas envs são ignoradas).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

function dirLoja() {
  // COCKPIT_GRAFOS_DIR vence o HOME — quem testa isola as duas (#62/#78).
  return process.env.COCKPIT_GRAFOS_DIR || path.join(os.homedir(), '.cockpit', 'grafos');
}

function pastaDo(projeto) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(projeto)) throw new Error(`nome de projeto fora do padrão: ${projeto}`);
  return path.join(dirLoja(), projeto);
}

function arquivoDoGrafo(pasta, anterior) {
  return path.join(pasta, anterior ? 'knowledge-graph.anterior.json' : 'knowledge-graph.json');
}

/** O grafo inteiro, sem cache — para a CLI (vida curta). O servidor usa `resumoDoGrafo`. */
function lerGrafo(pasta, { anterior = false } = {}) {
  try { return JSON.parse(fs.readFileSync(arquivoDoGrafo(pasta, anterior), 'utf8')); } catch { return null; }
}

// O servidor do Cockpit vive semanas: guardar o grafo inteiro parseado de cada projeto seria segurar
// dezenas de MB para sempre (achado do painel de execução). Ele só precisa do sha, da data e de quais
// arquivos são nó (para o `file-content`); o `knowledge-graph.json` em si sai direto do disco.
const cacheResumo = new Map(); // arquivo -> { mtimeMs, size, resumo }

/** `{ sha, analyzedAt, arquivos: Set<filePath> }` do grafo publicado (ou do anterior), ou `null`. */
function resumoDoGrafo(pasta, { anterior = false } = {}) {
  const arquivo = arquivoDoGrafo(pasta, anterior);
  let stat;
  try { stat = fs.statSync(arquivo); } catch { cacheResumo.delete(arquivo); return null; }
  const cacheado = cacheResumo.get(arquivo);
  if (cacheado && cacheado.mtimeMs === stat.mtimeMs && cacheado.size === stat.size) return cacheado.resumo;
  let grafo;
  try { grafo = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return null; }
  const resumo = {
    sha: (grafo.project && grafo.project.gitCommitHash) || null,
    analyzedAt: (grafo.project && grafo.project.analyzedAt) || null,
    arquivos: new Set((grafo.nodes || []).filter((n) => n.type === 'file').map((n) => n.filePath)),
  };
  cacheResumo.set(arquivo, { mtimeMs: stat.mtimeMs, size: stat.size, resumo });
  return resumo;
}

function dentroDoTmp(pasta) {
  const resolvido = path.resolve(pasta);
  const tmp = path.resolve(os.tmpdir());
  return resolvido === tmp || resolvido.startsWith(tmp + path.sep);
}

/** Publica `grafo`/`meta` em `pasta`: `.tmp` → `.anterior` (hard link, nunca tira o atual do lugar) → `rename`. */
function publicar(pasta, grafo, meta) {
  fs.mkdirSync(pasta, { recursive: true });
  const ganchosValem = dentroDoTmp(pasta);

  const lentoMs = ganchosValem && process.env.COCKPIT_GRAFO_TESTE_LENTO ? Number(process.env.COCKPIT_GRAFO_TESTE_LENTO) : 0;
  if (lentoMs > 0) execSync(`sleep ${lentoMs / 1000}`);

  const atual = path.join(pasta, 'knowledge-graph.json');
  // `.tmp` POR PROCESSO: se um dia dois escritores coexistirem (ver o resíduo em `tomarRetomada`),
  // cada um escreve o seu e o `rename` publica um arquivo inteiro — nunca dois escritos misturados.
  const tmpAtual = path.join(pasta, `knowledge-graph.json.${process.pid}.tmp`);
  const anteriorArq = path.join(pasta, 'knowledge-graph.anterior.json');
  const tmpAnterior = path.join(pasta, `knowledge-graph.anterior.json.${process.pid}.tmp`);

  // passo 1
  fs.writeFileSync(tmpAtual, JSON.stringify(grafo));

  // passo 2: o `.anterior` nasce do ATUAL, sem tirá-lo do lugar (hard link; cópia se EXDEV/EPERM)
  if (fs.existsSync(atual)) {
    try { fs.rmSync(tmpAnterior, { force: true }); } catch { /* não tinha */ }
    try {
      fs.linkSync(atual, tmpAnterior);
    } catch (erro) {
      if (erro.code === 'EXDEV' || erro.code === 'EPERM') fs.copyFileSync(atual, tmpAnterior);
      else throw erro;
    }
    fs.renameSync(tmpAnterior, anteriorArq);
  }

  if (ganchosValem && process.env.COCKPIT_GRAFO_TESTE_MORRER === 'entre-anterior-e-publicar') process.exit(99);

  // passo 3: só agora o novo grafo fica visível
  fs.renameSync(tmpAtual, atual);

  const metaArq = path.join(pasta, 'meta.json');
  const tmpMeta = path.join(pasta, `meta.json.${process.pid}.tmp`);
  fs.writeFileSync(tmpMeta, JSON.stringify(meta, null, 1));
  fs.renameSync(tmpMeta, metaArq);
}

function shaPublicado(pasta) {
  try { return JSON.parse(fs.readFileSync(path.join(pasta, 'meta.json'), 'utf8')).gitCommitHash; }
  catch { return null; }
}

function processoVivo(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A trava nasce COMPLETA: escreve num arquivo próprio e publica por `link` (atômico, falha com
// EEXIST se já existe). Com `open('wx')` + escrever, houve um instante com a `.trava` vazia — e
// um segundo processo, lendo vazio, achava que o dono tinha morrido e tomava junto (medido no
// gate-grafo-gatilhos sob carga: dois "início" no mesmo milissegundo).
function escreverTrava(arq) {
  const tmp = `${arq}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, desde: new Date().toISOString() }));
  try { fs.linkSync(tmp, arq); }
  finally { try { fs.rmSync(tmp, { force: true }); } catch { /* some sozinho */ } }
}

/** `true` se tomou; `false` se outro dono vivo (idade < 30 min) já está com ela. */
function tomarTrava(pasta) {
  fs.mkdirSync(pasta, { recursive: true });
  const arq = path.join(pasta, '.trava');
  try {
    escreverTrava(arq);
    return true;
  } catch (erro) {
    if (erro.code !== 'EEXIST') throw erro;
  }
  let julgada;
  let texto = null;
  try { julgada = fs.statSync(arq); texto = fs.readFileSync(arq, 'utf8'); } catch { return tentarDeNovo(arq); } // sumiu: o dono soltou
  let info = null;
  try { info = JSON.parse(texto); } catch { /* ilegível */ }
  // Ilegível (não deveria acontecer com o `link`, mas trava de versão antiga pode existir): vale
  // pela idade do arquivo — nova é de alguém, velha é lixo.
  const idadeMs = info ? Date.now() - new Date(info.desde).getTime() : Date.now() - julgada.mtimeMs;
  const dono = idadeMs < 30 * 60 * 1000 && (info ? processoVivo(info.pid) : true);
  if (dono) return false;

  // Retomada da trava MORTA sem corrida (achado do painel de execução: com `rmSync` + escrever, dois
  // processos que julgaram a mesma trava morta saíam os dois donos; com `rename` + conferir o inode,
  // um terceiro entrava no buraco). Só quem segura a sub-trava `.trava.retomada` (criada pelo mesmo
  // `link` atômico) pode apagar a trava morta — e só se ela ainda é a MESMA que foi julgada. "A mesma"
  // é pelo CONTEÚDO (pid + carimbo em ms) e pelo mtime, não pelo inode: o ext4 reaproveita o número
  // do inode apagado na hora, e a trava nova de um vizinho nascia com o inode da morta (medido no
  // gate 19: dois donos mesmo com a conferência por inode).
  // Toda trava viva nasce por `link` exclusivo; nenhuma é apagada por quem não é dono ou retomador.
  const retomada = `${arq}.retomada`;
  if (!tomarRetomada(retomada)) return false;
  try {
    let agora;
    let textoAgora;
    try { agora = fs.statSync(arq); textoAgora = fs.readFileSync(arq, 'utf8'); } catch { return tentarDeNovo(arq); }
    if (textoAgora !== texto || agora.mtimeMs !== julgada.mtimeMs) return false; // outro já retomou
    try { fs.rmSync(arq, { force: true }); } catch { /* sumiu */ }
    return tentarDeNovo(arq);
  } finally {
    soltarSeMinha(retomada);
  }
}

/**
 * A sub-trava da retomada: exclusiva pelo `link`. Ela é segurada por milissegundos, então com mais de
 * 10 s foi ABANDONADA (processo morto no meio da retomada) — mesmo que o pid gravado esteja vivo: depois
 * de um boot o número é reciclado por outro processo, e confiar só no pid travaria a loja daquele projeto
 * para sempre (achado da rodada 2 do painel de execução).
 * Resíduo declarado: dois processos retomando ao mesmo tempo uma sub-trava ABANDONADA podem sair os dois
 * donos — exige um processo morto exatamente durante uma retomada E dois vizinhos na mesma janela. Por
 * isso a publicação usa `.tmp` por processo: dois donos nunca misturam um arquivo, só repetem trabalho.
 */
function tomarRetomada(arq) {
  if (tentarDeNovo(arq)) return true;
  let st;
  try { st = fs.statSync(arq); } catch { return tentarDeNovo(arq); }
  let info = null;
  try { info = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { /* ilegível */ }
  const morta = Date.now() - st.mtimeMs > 10000 || (info ? !processoVivo(info.pid) : false);
  if (!morta) return false;
  try { fs.rmSync(arq, { force: true }); } catch { /* sumiu */ }
  return tentarDeNovo(arq);
}

function soltarSeMinha(arq) {
  try {
    const info = JSON.parse(fs.readFileSync(arq, 'utf8'));
    if (info && info.pid === process.pid) fs.rmSync(arq, { force: true });
  } catch { /* já sumiu */ }
}

/** Uma tentativa limpa de criar a trava (atômica pelo `link`). */
function tentarDeNovo(arq) {
  try { escreverTrava(arq); return true; } catch { return false; }
}

/** Só apaga a trava se ela é DESTE processo: um `finally` atrasado não pode soltar a trava que outro já pegou. */
function soltarTrava(pasta) {
  const arq = path.join(pasta, '.trava');
  let info = null;
  try { info = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return; /* já sumiu ou ilegível: não é minha */ }
  if (!info || info.pid !== process.pid) return;
  try { fs.rmSync(arq, { force: true }); } catch { /* já sumiu */ }
}

function marcarPendente(pasta) {
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, '.pendente'), '');
}

/** Apaga a marca e diz se ela existia. */
function consumirPendente(pasta) {
  const arq = path.join(pasta, '.pendente');
  const existia = fs.existsSync(arq);
  if (existia) { try { fs.rmSync(arq, { force: true }); } catch { /* corrida */ } }
  return existia;
}

const TETO_LOG = 256 * 1024;
const CORTE_LOG = 128 * 1024;

function registrar(pasta, linha) {
  fs.mkdirSync(pasta, { recursive: true });
  const arq = path.join(pasta, 'atualizar.log');
  fs.appendFileSync(arq, `${new Date().toISOString()} ${linha}\n`);
  try {
    const stat = fs.statSync(arq);
    if (stat.size > TETO_LOG) fs.writeFileSync(arq, fs.readFileSync(arq, 'utf8').slice(-CORTE_LOG));
  } catch { /* log some, sem problema */ }
}

module.exports = {
  dirLoja, pastaDo, lerGrafo, resumoDoGrafo, arquivoDoGrafo, publicar, shaPublicado,
  tomarTrava, soltarTrava, marcarPendente, consumirPendente, registrar,
};
