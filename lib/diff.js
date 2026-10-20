'use strict';

/**
 * Leitura de commit e de diff de job pelo `git` puro — card `ver-a-diff-do-codigo` (D95).
 * Sem estado, sem cache; toda chamada de `git` passa por `gitLimitado` (teto de bytes +
 * timeout, nunca rejeita) com o MESMO ambiente sem `GIT_*` de `./grafo-git` (`envSemGit`).
 * Nenhum comando escreve: só `rev-parse`, `log`, `show`, `diff`, `symbolic-ref`,
 * `merge-base --is-ancestor`.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { envSemGit } = require('./grafo-git');

const RE_SHA = /^[0-9a-f]{7,64}$/;
const RE_BRANCH_VALIDA = /^[\w./-]+$/;

const TETOS = { patch: 1_500_000, numstat: 8_000_000, log: 512_000 };
const TIMEOUT_MS = 10000;
const LINHA_MAX = 4000;
const POR_PAGINA = 30;
const COMMITS_DO_JOB = 50;

// Duas listas de flags, nunca uma (painel do plano, Codex #1 — medido: `--numstat -z` com `-U3`
// despeja o patch inteiro depois do numstat). `--diff-merges=first-parent` em TODA leitura de
// diff (numstat, patch, shortstat) — sem ela o numstat/shortstat de merge vem vazio.
const ARGS_COMUNS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M', '--diff-merges=first-parent'];
const ARGS_PATCH = [...ARGS_COMUNS, '--src-prefix=a/', '--dst-prefix=b/', '-U3'];
const GLOBAIS = ['-c', 'core.quotepath=false', '-c', 'color.ui=never', '-c', 'log.showSignature=false'];

const FORMATO_LOG = '%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s';
const FORMATO_CABECALHO = '%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%B';

// ─── git por `spawn`, com teto de bytes e timeout (V6) ─────────────────────────────────────────

/**
 * `comando args` sem shell, `env` exato. Acumula stdout até `teto` bytes; passou → guarda só até
 * o teto, `cortado = true`, mata o processo. Timeout → mata e marca `tempoEsgotado`. **Nunca
 * rejeita**: erro do spawn devolve `erro: true`.
 */
function processoLimitado(comando, args, { teto, timeoutMs = TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    let resolvido = false;
    let relogio = null;
    const terminar = (resultado) => {
      if (resolvido) return;
      resolvido = true;
      if (relogio) clearTimeout(relogio);
      resolve(resultado);
    };

    let filho;
    try {
      filho = spawn(comando, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      terminar({ codigo: null, stdout: Buffer.alloc(0), cortado: false, tempoEsgotado: false, erro: true });
      return;
    }

    const pedacos = [];
    let bytes = 0;
    let cortado = false;
    let tempoEsgotado = false;

    relogio = setTimeout(() => {
      tempoEsgotado = true;
      filho.kill('SIGKILL');
    }, timeoutMs);

    filho.stdout.on('data', (pedaco) => {
      if (cortado) return;
      if (teto != null) {
        const sobra = teto - bytes;
        if (pedaco.length > sobra) {
          if (sobra > 0) pedacos.push(pedaco.subarray(0, sobra));
          bytes = teto;
          cortado = true;
          filho.kill('SIGKILL');
          return;
        }
      }
      pedacos.push(pedaco);
      bytes += pedaco.length;
    });

    filho.on('error', () => {
      terminar({ codigo: null, stdout: Buffer.alloc(0), cortado: false, tempoEsgotado: false, erro: true });
    });
    filho.on('close', (codigo) => {
      terminar({ codigo, stdout: Buffer.concat(pedacos), cortado, tempoEsgotado });
    });
  });
}

/** `git -C <repo> <GLOBAIS> <args>`, ambiente sem `GIT_*` + `LC_ALL=C`, por `processoLimitado`. */
function gitLimitado(repo, args, { teto, timeoutMs = TIMEOUT_MS } = {}) {
  return processoLimitado('git', ['-C', repo, ...GLOBAIS, ...args], { teto, timeoutMs, env: { ...envSemGit(), LC_ALL: 'C' } });
}

// ─── aspas C do git (caminho com espaço/acento/aspas) ──────────────────────────────────────────

const ESCAPES_NOMEADOS = { '\\': 0x5c, '"': 0x22, a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b };

/**
 * Se `s` começa e termina com `"`, desfaz o escape C do git (`\\`, `\"`, `\t`, `\n`, `\a`… e
 * octal `\NNN` → bytes, decodificados como UTF-8 EM BLOCO — um `\NNN` sozinho pode ser só a
 * metade de um caractere multibyte). Senão devolve `s` como veio.
 */
function desfazerAspas(s) {
  if (typeof s !== 'string' || s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const chars = Array.from(s.slice(1, -1));
  const bytes = [];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (c === '\\' && i + 1 < chars.length) {
      const prox = chars[i + 1];
      const c1 = chars[i + 2];
      const c2 = chars[i + 3];
      if (/^[0-7]$/.test(prox) && /^[0-7]$/.test(c1 || '') && /^[0-7]$/.test(c2 || '')) {
        bytes.push(parseInt(prox + c1 + c2, 8) & 0xff);
        i += 3;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(ESCAPES_NOMEADOS, prox)) {
        bytes.push(ESCAPES_NOMEADOS[prox]);
        i += 1;
        continue;
      }
      bytes.push(0x5c);
      continue;
    }
    for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

function removerTabFinal(s) {
  return s.endsWith('\t') ? s.slice(0, -1) : s;
}

// ─── numstat (`-z`) ─────────────────────────────────────────────────────────────────────────────

/**
 * `-\t-` + caminho (normal) ou `-\t-\t\0antigo\0novo\0` (renomeado). `interrompido = true` quando
 * o texto termina no meio de um registro (o registro parcial é DESCARTADO) — o corte por teto do
 * `gitLimitado` conta à parte, em `juntar` (V7).
 */
function lerNumstat(texto) {
  if (texto === '') return { arquivos: [], interrompido: false };
  const fechado = texto.endsWith('\0');
  const tokens = texto.split('\0');
  if (fechado) tokens.pop();

  const arquivos = [];
  let interrompido = false;
  let i = 0;
  while (i < tokens.length) {
    const aberto = !fechado && i === tokens.length - 1;
    if (aberto) { interrompido = true; break; }
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]);
    if (!m) { interrompido = true; break; }
    const mais = m[1] === '-' ? null : Number(m[1]);
    const menos = m[2] === '-' ? null : Number(m[2]);
    const binario = mais === null && menos === null;
    const resto = m[3];
    if (resto !== '') {
      arquivos.push({ caminho: desfazerAspas(resto), antigo: null, mais, menos, binario });
      i += 1;
      continue;
    }
    if (i + 2 >= tokens.length) { interrompido = true; break; }
    const antigoAberto = !fechado && i + 1 === tokens.length - 1;
    const novoAberto = !fechado && i + 2 === tokens.length - 1;
    if (antigoAberto || novoAberto) { interrompido = true; break; }
    arquivos.push({ caminho: desfazerAspas(tokens[i + 2]), antigo: desfazerAspas(tokens[i + 1]), mais, menos, binario });
    i += 3;
  }
  return { arquivos, interrompido };
}

// ─── patch (`diff --git …`) ─────────────────────────────────────────────────────────────────────

function fimDeStringQuotada(s, inicio) {
  for (let i = inicio + 1; i < s.length; i += 1) {
    if (s[i] === '\\') { i += 1; continue; }
    if (s[i] === '"') return i;
  }
  return -1;
}

/**
 * `diff --git a/X b/Y`: sem aspas, nunca quota mesmo com espaço — só dá pra separar a/X de b/Y
 * quando os dois lados são IGUAIS (`X === Y`): o conteúdo depois de "diff --git " tem tamanho par
 * (2×"a/"+X + 1 espaço + 2×"b/"+Y, com X===Y), então o meio exato é a única divisão possível.
 * Renomeado (lados diferentes) devolve `null` — o caminho vem de `rename to`/`+++` depois.
 */
function resolverDiffGitLine(resto) {
  if (resto[0] === '"') {
    const fimA = fimDeStringQuotada(resto, 0);
    if (fimA === -1) return null;
    const aQuot = resto.slice(0, fimA + 1);
    let j = fimA + 1;
    if (resto[j] !== ' ') return null;
    j += 1;
    let bQuot = resto.slice(j);
    if (bQuot[0] === '"') {
      const fimB = fimDeStringQuotada(bQuot, 0);
      if (fimB !== -1) bQuot = bQuot.slice(0, fimB + 1);
    }
    const aPath = desfazerAspas(aQuot).replace(/^a\//, '');
    const bPath = desfazerAspas(bQuot).replace(/^b\//, '');
    return aPath === bPath ? { caminho: bPath } : null;
  }
  if (resto.length % 2 === 1) {
    const meio = (resto.length - 1) / 2;
    if (resto[meio] === ' ') {
      const esq = resto.slice(0, meio);
      const dir = resto.slice(meio + 1);
      if (esq.startsWith('a/') && dir.startsWith('b/') && esq.slice(2) === dir.slice(2)) {
        return { caminho: esq.slice(2) };
      }
    }
  }
  return null;
}

const RE_DIFF_GIT = /^diff --git (.*)$/;
const RE_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const PFX_NEW_FILE = 'new file mode ';
const PFX_DEL_FILE = 'deleted file mode ';
const PFX_OLD_MODE = 'old mode ';
const PFX_NEW_MODE = 'new mode ';
const PFX_RENAME_FROM = 'rename from ';
const PFX_RENAME_TO = 'rename to ';
const PFX_COPY_FROM = 'copy from ';
const PFX_COPY_TO = 'copy to ';

/**
 * Parser do patch (V8): `arquivos[]` com `{caminho, antigo, estado, binario, modo, mais, menos,
 * trechos:[{antes, depois, cabecalho, linhas, longas}], semFimDeLinha}`. Linha de trecho maior
 * que `LINHA_MAX` é cortada e o índice entra em `longas` (R3).
 */
/** Uma linha do corpo do trecho: corte em `LINHA_MAX` (com o tamanho original em `longas`) e a conta de +/−. */
function guardarLinhaDoCorpo(atual, trechoAtual, linha) {
  let guardada = linha;
  if (linha.length > LINHA_MAX) {
    trechoAtual.longas.push({ i: trechoAtual.linhas.length, n: linha.length - 1 });
    guardada = linha.slice(0, LINHA_MAX);
  }
  trechoAtual.linhas.push(guardada);
  if (linha[0] === '+') atual.mais += 1;
  else if (linha[0] === '-') atual.menos += 1;
}

function parsearPatch(texto) {
  const linhasTexto = texto === '' ? [] : texto.split('\n');
  const arquivos = [];
  let atual = null;
  let trechoAtual = null;
  // Linhas que o trecho aberto ainda deve, pelos números do `@@`. Enquanto deve, "--- x"/"+++ x" são
  // CORPO (linha removida que começa com "-- ", adicionada que começa com "++ ") — nunca cabeçalho.
  let devidasAntes = 0;
  let devidasDepois = 0;

  const novoArquivo = () => {
    const a = {
      caminho: null, antigo: null, estado: 'modificado', binario: false, modo: null,
      mais: 0, menos: 0, trechos: [], semFimDeLinha: { antes: false, depois: false },
    };
    arquivos.push(a);
    return a;
  };

  for (const linha of linhasTexto) {
    const noCorpo = trechoAtual && (devidasAntes > 0 || devidasDepois > 0)
      && (linha[0] === ' ' || linha[0] === '+' || linha[0] === '-');
    const mDiffGit = noCorpo ? null : RE_DIFF_GIT.exec(linha);
    if (mDiffGit) {
      atual = novoArquivo();
      trechoAtual = null;
      const resolvido = resolverDiffGitLine(mDiffGit[1]);
      if (resolvido) atual.caminho = resolvido.caminho;
      continue;
    }
    if (!atual) continue;

    if (noCorpo) {
      guardarLinhaDoCorpo(atual, trechoAtual, linha);
      if (linha[0] === '+') devidasDepois -= 1;
      else if (linha[0] === '-') devidasAntes -= 1;
      else { devidasAntes -= 1; devidasDepois -= 1; }
      continue;
    }

    if (linha.startsWith(PFX_OLD_MODE)) { atual.modo = atual.modo || {}; atual.modo.antes = linha.slice(PFX_OLD_MODE.length).trim(); continue; }
    if (linha.startsWith(PFX_NEW_MODE)) { atual.modo = atual.modo || {}; atual.modo.depois = linha.slice(PFX_NEW_MODE.length).trim(); continue; }
    if (linha.startsWith(PFX_NEW_FILE)) { atual.estado = 'novo'; atual.modo = atual.modo || {}; atual.modo.depois = linha.slice(PFX_NEW_FILE.length).trim(); continue; }
    if (linha.startsWith(PFX_DEL_FILE)) { atual.estado = 'apagado'; atual.modo = atual.modo || {}; atual.modo.antes = linha.slice(PFX_DEL_FILE.length).trim(); continue; }
    if (linha.startsWith('similarity index ')) continue;
    if (linha.startsWith(PFX_RENAME_FROM)) { atual.estado = 'renomeado'; atual.antigo = desfazerAspas(linha.slice(PFX_RENAME_FROM.length)); continue; }
    if (linha.startsWith(PFX_RENAME_TO)) { atual.caminho = desfazerAspas(linha.slice(PFX_RENAME_TO.length)); continue; }
    if (linha.startsWith(PFX_COPY_FROM)) { atual.estado = 'copiado'; atual.antigo = desfazerAspas(linha.slice(PFX_COPY_FROM.length)); continue; }
    if (linha.startsWith(PFX_COPY_TO)) { atual.caminho = desfazerAspas(linha.slice(PFX_COPY_TO.length)); continue; }
    if (linha.startsWith('Binary files ') && linha.endsWith(' differ')) { atual.binario = true; continue; }

    if (linha.startsWith('--- ')) {
      const p = desfazerAspas(removerTabFinal(linha.slice(4)));
      if (p !== '/dev/null') atual.caminho = atual.caminho || p.replace(/^a\//, '');
      continue;
    }
    if (linha.startsWith('+++ ')) {
      const p = desfazerAspas(removerTabFinal(linha.slice(4)));
      if (p !== '/dev/null') atual.caminho = p.replace(/^b\//, '');
      continue;
    }

    const mHunk = RE_HUNK.exec(linha);
    if (mHunk) {
      trechoAtual = { antes: Number(mHunk[1]), depois: Number(mHunk[3]), cabecalho: mHunk[5].trim(), linhas: [], longas: [] };
      devidasAntes = mHunk[2] === undefined ? 1 : Number(mHunk[2]);
      devidasDepois = mHunk[4] === undefined ? 1 : Number(mHunk[4]);
      atual.trechos.push(trechoAtual);
      continue;
    }

    if (linha.startsWith('\\ No newline at end of file')) {
      if (!trechoAtual || trechoAtual.linhas.length === 0) continue;
      const ultima = trechoAtual.linhas[trechoAtual.linhas.length - 1];
      if (ultima[0] === '-') atual.semFimDeLinha.antes = true;
      else if (ultima[0] === '+') atual.semFimDeLinha.depois = true;
      else { atual.semFimDeLinha.antes = true; atual.semFimDeLinha.depois = true; }
      continue;
    }

    if (trechoAtual && (linha[0] === ' ' || linha[0] === '+' || linha[0] === '-')) {
      guardarLinhaDoCorpo(atual, trechoAtual, linha);
      continue;
    }
    // linha fora de qualquer caso conhecido (ex.: "index 0000..1111 100644") — ignorada.
  }

  return arquivos;
}

// ─── casar numstat + patch (V7) ─────────────────────────────────────────────────────────────────

/**
 * Casa a lista (`numstat`) com os corpos (`patch`) por ÍNDICE, conferindo o caminho. Desalinhou
 * → `semCorpo: 'desalinhado'` (nunca a mensagem de corte). `corpoCortado` → o ÚLTIMO arquivo
 * presente em `patch` perde o corpo (estava sendo escrito quando o git morreu) e todos os
 * seguintes ficam `semCorpo: 'cortado'`. Lista cortada (`listaCortada` ou `numstat.interrompido`)
 * → `totais: null`.
 */
function juntar(numstat, patch, { corpoCortado = false, listaCortada = false, tempo = false } = {}) {
  const listaIncompleta = Boolean(listaCortada || numstat.interrompido);
  const arquivos = [];
  let somaMais = 0;
  let somaMenos = 0;

  for (let i = 0; i < numstat.arquivos.length; i += 1) {
    const n = numstat.arquivos[i];
    const ultimoDoPatchCortado = corpoCortado && i === patch.length - 1;
    const temCorpo = !ultimoDoPatchCortado && i < patch.length && patch[i].caminho === n.caminho;

    if (temCorpo) {
      const p = patch[i];
      arquivos.push({
        caminho: p.caminho, antigo: p.antigo, estado: p.estado, binario: p.binario, modo: p.modo,
        mais: p.mais, menos: p.menos, trechos: p.trechos, semFimDeLinha: p.semFimDeLinha,
      });
    } else {
      const semCorpo = i >= patch.length
        ? (corpoCortado ? 'cortado' : 'desalinhado')
        : (ultimoDoPatchCortado ? 'cortado' : 'desalinhado');
      arquivos.push({
        caminho: n.caminho, antigo: n.antigo, estado: n.antigo != null ? 'renomeado' : null,
        binario: n.binario, modo: null, mais: n.mais, menos: n.menos, trechos: [], semFimDeLinha: null,
        semCorpo,
      });
    }

    if (!listaIncompleta) {
      somaMais += n.mais || 0;
      somaMenos += n.menos || 0;
    }
  }

  const totais = listaIncompleta ? null : { arquivos: numstat.arquivos.length, mais: somaMais, menos: somaMenos };
  return { arquivos, totais, cortado: { corpo: Boolean(corpoCortado), lista: listaIncompleta, tempo: Boolean(tempo) } };
}

// ─── log (lista de commits) e cabeçalho de um commit ───────────────────────────────────────────

const RE_SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/**
 * Registros `\x1e<H>\x1f<an>\x1f<ae>\x1f<aI>\x1f<P>\x1f<s>` + `--shortstat`. O shortstat só
 * pertence ao registro se estiver no MESMO bloco (antes do próximo `\x1e`); registro sem
 * shortstat (merge sem mudança contra o 1º pai) vira `0/0/0` sem deslocar os vizinhos.
 * `cortado` (teto do log OU timeout) → o ÚLTIMO registro é descartado (pode estar pela metade).
 */
function lerLog(texto, { cortado } = {}) {
  const registros = texto.split('\x1e').filter((r) => r.length > 0);
  if (cortado && registros.length > 0) registros.pop();

  const resultado = [];
  for (const registro of registros) {
    const fimLinha = registro.indexOf('\n');
    const linhaCampos = fimLinha === -1 ? registro : registro.slice(0, fimLinha);
    const campos = linhaCampos.split('\x1f');
    if (campos.length < 6 || !campos[0]) continue;
    const [sha, autor, email, data, paisStr, assunto] = campos;
    const pais = paisStr ? paisStr.split(' ') : [];
    const resto = fimLinha === -1 ? '' : registro.slice(fimLinha + 1);
    const mShort = RE_SHORTSTAT.exec(resto);
    const arquivosN = mShort ? Number(mShort[1]) : 0;
    const mais = mShort && mShort[2] ? Number(mShort[2]) : 0;
    const menos = mShort && mShort[3] ? Number(mShort[3]) : 0;
    resultado.push({ sha, autor, email, data, pais, assunto, merge: pais.length > 1, arquivos: arquivosN, mais, menos });
  }
  return resultado;
}

/**
 * `show -s --format=%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%B`: corta nos 5 primeiros `\x1f` (o `%B`
 * pode conter qualquer coisa depois, inclusive `\x1f`).
 */
function lerCabecalho(texto) {
  const partes = [];
  let resto = texto;
  for (let i = 0; i < 5; i += 1) {
    const idx = resto.indexOf('\x1f');
    if (idx === -1) { partes.push(resto); resto = ''; break; }
    partes.push(resto.slice(0, idx));
    resto = resto.slice(idx + 1);
  }
  while (partes.length < 5) partes.push('');
  const [sha, autor, email, data, paisStr] = partes;
  const pais = paisStr ? paisStr.split(' ') : [];
  return { sha, autor, email, data, pais, mensagem: resto.trimEnd() };
}

// ─── resolução de ref/commit, base e ancestralidade ────────────────────────────────────────────

/** SHA completo ou `null` (não existe / ambíguo). */
async function resolverCommit(repo, sha) {
  const r = await gitLimitado(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{commit}`], { teto: 1000 });
  if (r.codigo !== 0) return null;
  const texto = r.stdout.toString('utf8').trim();
  return texto || null;
}

/** SHA de `refs/heads/<nome>` ou `null`. */
async function resolverRef(repo, nome) {
  const r = await gitLimitado(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${nome}^{commit}`], { teto: 1000 });
  if (r.codigo !== 0) return null;
  const texto = r.stdout.toString('utf8').trim();
  return texto || null;
}

/** `develop`, senão `main`, senão `null` (V10 — mesma régua da lista e do job). */
async function base(repo) {
  const d = await resolverRef(repo, 'develop');
  if (d) return { nome: 'develop', sha: d };
  const m = await resolverRef(repo, 'main');
  if (m) return { nome: 'main', sha: m };
  return null;
}

/** `true`/`false`/`null` (erro inesperado) — `merge-base --is-ancestor a b`. */
async function ehAncestral(repo, a, b) {
  const r = await gitLimitado(repo, ['merge-base', '--is-ancestor', a, b], { teto: 1000 });
  if (r.codigo === 0) return true;
  if (r.codigo === 1) return false;
  return null;
}

async function symbolicRefCurto(worktree) {
  const r = await gitLimitado(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'], { teto: 1000 });
  if (r.codigo !== 0) return null;
  const nome = r.stdout.toString('utf8').trim();
  return nome || null;
}

function erroDeGit(r) {
  return r.codigo !== 0 && !r.cortado && !r.tempoEsgotado;
}

// ─── lista de commits (paginada) ────────────────────────────────────────────────────────────────

/**
 * Resolve `base(repo)` SEMPRE (painel R2, Claude #1: sem isso a 2ª página lia `base.nome` de
 * `undefined`). Sem `topo`: `topo = base.sha`, `pular = 0`. Com `topo`: já resolvido pelo
 * chamador. `-n POR_PAGINA+1 --skip=<pular> <topo>` (teto log).
 */
async function commitsDe(repo, { topo, pular } = {}) {
  const b = await base(repo);
  if (!b) return { semBase: true };

  const topoReal = topo || b.sha;
  const pularReal = pular || 0;

  const r = await gitLimitado(
    repo,
    ['log', `--format=${FORMATO_LOG}`, '--shortstat', ...ARGS_COMUNS, '-n', String(POR_PAGINA + 1), `--skip=${pularReal}`, topoReal],
    { teto: TETOS.log },
  );
  if (erroDeGit(r)) throw new Error('git');

  const cortado = Boolean(r.cortado || r.tempoEsgotado);
  const commits = lerLog(r.stdout.toString('utf8'), { cortado });
  const mais = commits.length > POR_PAGINA || cortado;

  return { base: b, topo: topoReal, commits: commits.slice(0, POR_PAGINA), mais, cortado };
}

// ─── commit inteiro (cabeçalho + numstat + patch) ──────────────────────────────────────────────

async function commitInteiro(repo, shaCompleto) {
  const rCab = await gitLimitado(repo, ['show', '-s', `--format=${FORMATO_CABECALHO}`, shaCompleto], { teto: TETOS.log });
  if (erroDeGit(rCab)) throw new Error('git');
  const cabecalho = lerCabecalho(rCab.stdout.toString('utf8'));

  const rNum = await gitLimitado(repo, ['show', '--format=', '--numstat', '-z', ...ARGS_COMUNS, shaCompleto], { teto: TETOS.numstat });
  if (erroDeGit(rNum)) throw new Error('git');
  const numstat = lerNumstat(rNum.stdout.toString('utf8'));

  const rPatch = await gitLimitado(repo, ['show', '--format=', ...ARGS_PATCH, shaCompleto], { teto: TETOS.patch });
  if (erroDeGit(rPatch)) throw new Error('git');
  const patch = parsearPatch(rPatch.stdout.toString('utf8'));

  const juntado = juntar(numstat, patch, {
    corpoCortado: Boolean(rPatch.cortado || rPatch.tempoEsgotado),
    listaCortada: Boolean(rNum.cortado || rNum.tempoEsgotado),
    tempo: Boolean(rPatch.tempoEsgotado || rNum.tempoEsgotado),
  });

  return { commit: cabecalho, merge: cabecalho.pais.length > 1, arquivos: juntado.arquivos, totais: juntado.totais, cortado: juntado.cortado };
}

// ─── diff de job (o que o merge na base traria) — V11 ──────────────────────────────────────────

/**
 * Resolve base e branch EM SHAs uma vez só; todas as leituras seguintes usam esses dois SHAs —
 * um commit no meio da leitura não mistura duas versões (painel R1, Codex #2). `depoisDeResolver`
 * (só o gate chama): `await` logo DEPOIS de resolver os dois SHAs e ANTES da 1ª leitura.
 */
async function mudancasDoJob({ meta, repo }, { depoisDeResolver } = {}) {
  const b = await base(repo);
  if (!b) return { estado: 'sem-base' };

  const branchNome = typeof meta.branch === 'string' && RE_BRANCH_VALIDA.test(meta.branch)
    && !meta.branch.startsWith('-') && !meta.branch.includes('..') ? meta.branch : null;

  let shaBranch = branchNome ? await resolverRef(repo, branchNome) : null;
  if (!shaBranch && meta.worktree && fs.existsSync(meta.worktree)) {
    const nomeWorktree = await symbolicRefCurto(meta.worktree);
    if (nomeWorktree) shaBranch = await resolverRef(repo, nomeWorktree);
  }
  if (!shaBranch) {
    const motivo = (meta.merged_at || meta.teardown_at || ['merged', 'teardown'].includes(meta.status)) ? 'limpo' : 'sumiu';
    return { estado: 'branch-sumiu', motivo };
  }

  const shaBase = b.sha;
  if (depoisDeResolver) await depoisDeResolver();

  const ancestral = await ehAncestral(repo, shaBranch, shaBase);
  if (ancestral === null) throw new Error('git');
  if (ancestral === true) return { estado: 'sem-mudancas', base: b.nome };

  const rLog = await gitLimitado(
    repo,
    ['log', `--format=${FORMATO_LOG}`, '--shortstat', ...ARGS_COMUNS, '-n', String(COMMITS_DO_JOB), `${shaBase}..${shaBranch}`],
    { teto: TETOS.log },
  );
  if (erroDeGit(rLog)) throw new Error('git');
  const commits = lerLog(rLog.stdout.toString('utf8'), { cortado: Boolean(rLog.cortado || rLog.tempoEsgotado) }).slice(0, COMMITS_DO_JOB);

  const rCount = await gitLimitado(repo, ['rev-list', '--count', `${shaBase}..${shaBranch}`], { teto: 1000 });
  const nCommits = !erroDeGit(rCount) ? (Number(rCount.stdout.toString('utf8').trim()) || 0) : commits.length;

  const rNum = await gitLimitado(repo, ['diff', '--numstat', '-z', ...ARGS_COMUNS, `${shaBase}...${shaBranch}`], { teto: TETOS.numstat });
  if (erroDeGit(rNum)) throw new Error('git');
  const numstat = lerNumstat(rNum.stdout.toString('utf8'));

  const rPatch = await gitLimitado(repo, ['diff', ...ARGS_PATCH, `${shaBase}...${shaBranch}`], { teto: TETOS.patch });
  if (erroDeGit(rPatch)) throw new Error('git');
  const patch = parsearPatch(rPatch.stdout.toString('utf8'));

  if (numstat.arquivos.length === 0 && !numstat.interrompido && !rNum.cortado && !rNum.tempoEsgotado) {
    return { estado: 'sem-mudancas', base: b.nome };
  }

  const juntado = juntar(numstat, patch, {
    corpoCortado: Boolean(rPatch.cortado || rPatch.tempoEsgotado),
    listaCortada: Boolean(rNum.cortado || rNum.tempoEsgotado),
    tempo: Boolean(rPatch.tempoEsgotado || rNum.tempoEsgotado),
  });

  return {
    estado: 'ok', base: b.nome, commits, nCommits,
    arquivos: juntado.arquivos, totais: juntado.totais, cortado: juntado.cortado,
  };
}

module.exports = {
  RE_SHA, RE_BRANCH_VALIDA, TETOS, TIMEOUT_MS, LINHA_MAX, POR_PAGINA, COMMITS_DO_JOB,
  ARGS_COMUNS, ARGS_PATCH, GLOBAIS,
  gitLimitado, processoLimitado, desfazerAspas, lerNumstat, parsearPatch, juntar, lerLog, lerCabecalho,
  resolverCommit, resolverRef, base, ehAncestral, commitsDe, commitInteiro, mudancasDoJob,
};
