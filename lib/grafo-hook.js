'use strict';
/**
 * Instala/remove/relata os quatro hooks que regeneram o grafo quando a develop anda:
 * `post-commit`, `post-merge`, `post-rewrite` e `reference-transaction` (o único que lê stdin —
 * só ele dispara no `git fetch . x:develop` que o orquestrador de jobs usa para avançar a develop, ver spec "Riscos").
 *
 * O bloco nunca dá `exit` no escopo do hook, não depende do `node` existir e termina sempre com
 * status 0 — no `reference-transaction`, estado `prepared`, status != 0 abortaria a transação
 * (man githooks). Hook de terceiro ganha `.bak-cockpit-grafo-<data>` e o bloco entra logo depois
 * do shebang; shebang não-shell e `reference-transaction` de terceiro ficam intocados.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const gitlib = require('./grafo-git.js');

const HOOKS = ['post-commit', 'post-merge', 'post-rewrite', 'reference-transaction'];
const MARCADOR_INICIO = '# >>> cockpit-grafo (bin/grafo.js instalar-hook) >>>';
const MARCADOR_FIM = '# <<< cockpit-grafo <<<';
const MARCADOR_UA_LEGADO = 'ua-grafo (gerado por ua-instala-hook.sh)';
const RE_SHEBANG_SHELL = /^#!\s*(\/usr\/bin\/env\s+)?(\/usr)?(\/bin\/)?(sh|bash|dash)\b/;

// O fecho de `require` do bin/grafo.js (só `node:` fora dele) — spec `2026-10-17-grafo-botao-fazer-grafo`, T1.
const ARQUIVOS_DO_GERADOR = [
  'bin/grafo.js', 'lib/grafo-git.js', 'lib/grafo-loja.js', 'lib/grafo-hook.js', 'lib/grafo-inventario.js',
  'lib/grafo-extrator.js', 'lib/grafo-python.js', 'lib/grafo-python.py', 'lib/grafo-js.js', 'lib/grafo-html.js',
];

function bloco(nomeDoHook, nodeAbs, grafoAbs, lojaAbs = null) {
  if (nodeAbs.includes("'") || grafoAbs.includes("'") || (lojaAbs && lojaAbs.includes("'"))) {
    throw new Error('caminho do node, do bin/grafo.js ou da loja tem aspa simples — instalação recusada');
  }
  const chamada = `( [ -x '${nodeAbs}' ] && [ -f '${grafoAbs}' ] && ${lojaAbs ? `COCKPIT_GRAFOS_DIR='${lojaAbs}' ` : ''}nohup '${nodeAbs}' '${grafoAbs}' atualizar "$PWD" </dev/null >/dev/null 2>&1 & ) </dev/null >/dev/null 2>&1`;
  if (nomeDoHook === 'reference-transaction') {
    return [
      MARCADOR_INICIO,
      '# So no estado committed, so se a develop (local ou origin/) mudou de ponta. Termina sempre com status 0:',
      '# no estado prepared, status != 0 abortaria a transacao (man githooks).',
      'if [ "$1" = committed ] && awk \'$3 ~ /^refs\\/(heads|remotes\\/origin)\\/develop$/ && $1 != $2 { a = 1 } END { exit !a }\'; then',
      `  ${chamada}`,
      'fi',
      ':',
      MARCADOR_FIM,
      '',
    ].join('\n');
  }
  return [
    MARCADOR_INICIO,
    '# Regenera o grafo da develop em background quando ela anda. Nao le stdin; termina sempre com status 0.',
    chamada,
    ':',
    MARCADOR_FIM,
    '',
  ].join('\n');
}

function trocarBloco(atual, blocoNovo) {
  const ini = atual.indexOf(MARCADOR_INICIO);
  const fimIdx = atual.indexOf(MARCADOR_FIM, ini);
  const finalDaLinha = atual.indexOf('\n', fimIdx);
  const depois = finalDaLinha < 0 ? atual.length : finalDaLinha + 1;
  return atual.slice(0, ini) + blocoNovo + atual.slice(depois);
}

async function hooksDirDoRepo(repo) {
  const comumDir = (await gitlib.git(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo })).trim();
  return path.join(comumDir, 'hooks');
}

function marcaDataHora() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Raiz da cópia estável (T1). Padrão neutro de propósito: este código vai pro export público (#106). */
function dirCopia() {
  return process.env.COCKPIT_GRAFO_COPIA_DIR || path.join(os.homedir(), '.cockpit', 'grafo-gerador');
}

/**
 * Copia o gerador (os 10 arquivos, lidos da pasta de onde ESTE código roda) para
 * `<dirCopia>/versoes/<hash>/` e devolve o caminho absoluto do `bin/grafo.js` de lá. Versão é por conteúdo
 * e nunca é reescrita; toda síncrona (dentro de um processo não intercala). A corrida entre processos é
 * resolvida pelo `rename`: quem chega depois acha a versão pronta e descarta o seu temporário.
 */
function publicarCopia() {
  const origem = path.resolve(__dirname, '..');
  const conteudos = ARQUIVOS_DO_GERADOR.map((rel) => {
    const caminho = path.join(origem, rel);
    let buf;
    try { buf = fs.readFileSync(caminho); }
    catch (e) { throw new Error(`arquivo do gerador faltando: ${rel} (${e && e.message})`); }
    return { rel, buf, modo: fs.statSync(caminho).mode & 0o777 };
  });

  const hash = crypto.createHash('sha256');
  for (const { rel, buf } of conteudos) { hash.update(rel); hash.update('\0'); hash.update(buf); hash.update('\0'); }
  const hashHex = hash.digest('hex').slice(0, 16);

  const versoesDir = path.join(dirCopia(), 'versoes');
  const destino = path.join(versoesDir, hashHex);
  const grafoAbs = path.join(destino, 'bin', 'grafo.js');
  if (fs.existsSync(destino)) return grafoAbs;

  fs.mkdirSync(versoesDir, { recursive: true });
  const tmp = path.join(versoesDir, `.${hashHex}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
  for (const { rel, buf, modo } of conteudos) {
    const alvo = path.join(tmp, rel);
    fs.writeFileSync(alvo, buf);
    fs.chmodSync(alvo, modo);
  }
  try {
    fs.renameSync(tmp, destino);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e;
  }
  return grafoAbs;
}

async function instalar(repo, { permitirWorktree = false, grafoAbs: grafoFora = null, lojaAbs = null } = {}) {
  const grafoAbs = grafoFora || path.resolve(__dirname, '..', 'bin', 'grafo.js');
  // Quem passa `grafoAbs` já copiou o gerador pra fora — a origem não importa.
  if (!grafoFora) {
    const worktree = await gitlib.ehWorktreeVinculada(path.dirname(grafoAbs));
    if (worktree && !permitirWorktree) {
      return { instalados: [], pulados: [], recusado: 'bin/grafo.js está numa worktree vinculada — o hook morreria com a worktree (use --permitir-worktree só em teste)' };
    }
  }
  const hooksPath = await gitlib.configHooksPath(repo);
  if (hooksPath) return { instalados: [], pulados: [], recusado: `core.hooksPath configurado (${hooksPath}) — a pasta costuma ser versionada` };

  const hooksDir = await hooksDirDoRepo(repo);
  fs.mkdirSync(hooksDir, { recursive: true });
  const nodeAbs = process.env.COCKPIT_GRAFO_NODE || process.execPath;

  const instalados = [];
  const pulados = [];
  for (const h of HOOKS) {
    const arq = path.join(hooksDir, h);
    const blocoTxt = bloco(h, nodeAbs, grafoAbs, lojaAbs);
    let atual = null;
    try { atual = fs.readFileSync(arq, 'utf8'); } catch { /* não existe */ }

    if (atual === null) {
      fs.writeFileSync(arq, `#!/bin/sh\n${blocoTxt}`);
      fs.chmodSync(arq, 0o755);
      instalados.push(h);
      continue;
    }
    if (atual.includes(MARCADOR_INICIO)) {
      fs.writeFileSync(arq, trocarBloco(atual, blocoTxt));
      fs.chmodSync(arq, 0o755);
      instalados.push(h);
      continue;
    }

    const primeiraLinha = atual.slice(0, atual.indexOf('\n') < 0 ? atual.length : atual.indexOf('\n'));
    if (!RE_SHEBANG_SHELL.test(primeiraLinha)) {
      pulados.push({ hook: h, motivo: `shebang não é shell POSIX (${primeiraLinha || 'sem shebang'}) — hook de terceiro intocado` });
      continue;
    }
    if (h === 'reference-transaction') {
      pulados.push({ hook: h, motivo: 'reference-transaction de terceiro já existe — os dois precisam do stdin, intocado' });
      continue;
    }

    const bak = `${arq}.bak-cockpit-grafo-${marcaDataHora()}`;
    fs.writeFileSync(bak, atual);
    const nl = atual.indexOf('\n');
    const resto = nl < 0 ? '' : atual.slice(nl + 1);
    fs.writeFileSync(arq, `${primeiraLinha}\n${blocoTxt}${resto}`);
    fs.chmodSync(arq, 0o755);
    instalados.push(h);
  }
  return { instalados, pulados };
}

async function remover(repo) {
  const hooksDir = await hooksDirDoRepo(repo);
  const removidos = [];
  if (!fs.existsSync(hooksDir)) return { removidos };
  for (const h of HOOKS) {
    const arq = path.join(hooksDir, h);
    let atual = null;
    try { atual = fs.readFileSync(arq, 'utf8'); } catch { continue; }
    if (!atual.includes(MARCADOR_INICIO)) continue;
    // Tira SÓ o bloco: restaurar o `.bak` apagaria o que o dono do hook mudou depois da instalação
    // (outro instalador que acrescentou o bloco dele, por exemplo). O `.bak` fica, como registro.
    const semBloco = trocarBloco(atual, '');
    if (/^#![^\n]*\n?$/.test(semBloco.trim() + '\n') || !semBloco.trim()) fs.rmSync(arq, { force: true });
    else fs.writeFileSync(arq, semBloco);
    removidos.push(h);
  }
  return { removidos };
}

async function status(repo) {
  const hooksDir = await hooksDirDoRepo(repo);
  const relatorio = {};
  for (const h of HOOKS) {
    const arq = path.join(hooksDir, h);
    let atual = null;
    try { atual = fs.readFileSync(arq, 'utf8'); } catch { /* não existe */ }
    if (atual === null) { relatorio[h] = { estado: 'não instalado' }; continue; }
    if (atual.includes(MARCADOR_INICIO)) {
      const m = /\[ -x '([^']*)' \] && \[ -f '([^']*)' \]/.exec(atual);
      const nodeAbs = m ? m[1] : null;
      const grafoAbs = m ? m[2] : null;
      const quebrado = !nodeAbs || !fs.existsSync(nodeAbs) || !grafoAbs || !fs.existsSync(grafoAbs);
      relatorio[h] = { estado: quebrado ? 'quebrado' : 'instalado', node: nodeAbs, grafo: grafoAbs };
      continue;
    }
    relatorio[h] = { estado: 'de terceiro, intocado', legadoUaGrafo: h === 'post-commit' && atual.includes(MARCADOR_UA_LEGADO) };
  }
  return relatorio;
}

module.exports = { HOOKS, bloco, instalar, remover, status, ARQUIVOS_DO_GERADOR, dirCopia, publicarCopia };
