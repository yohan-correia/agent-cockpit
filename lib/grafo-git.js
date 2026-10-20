'use strict';
/**
 * Toda chamada de `git` do grafo do projeto — sempre com o ambiente **sem** `GIT_*` herdado (um
 * hook roda com `GIT_DIR`/`GIT_INDEX_FILE` apontando para quem disparou o commit; herdar isso
 * faria `git -C <outro>` ler o repo errado — ver spec "Riscos", medido na auditoria de 16/10).
 * Só lê o banco de objetos (`ls-tree`/`cat-file`); nunca toca no checkout, no índice ou no `.ua/`.
 */

const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

function envSemGit() {
  const env = {};
  for (const chave of Object.keys(process.env)) {
    if (chave.startsWith('GIT_')) continue;
    env[chave] = process.env[chave];
  }
  return env;
}

/** `git(args)` → Promise do stdout (string, ou Buffer com `binario: true`); `input` vai pro stdin. */
function git(args, { cwd, input, binario } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      env: envSemGit(),
      maxBuffer: 512 * 1024 * 1024,
      encoding: binario ? 'buffer' : 'utf8',
    }, (erro, stdout, stderr) => {
      if (erro) {
        erro.stderrTexto = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr;
        reject(erro);
        return;
      }
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

async function repoPrincipal(caminho) {
  let saida;
  try {
    saida = await git(['-C', caminho, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: caminho });
  } catch {
    return null;
  }
  const comumDir = saida.trim();
  if (!comumDir.endsWith('/.git')) return null;
  return comumDir.slice(0, -'/.git'.length);
}

async function verificarRef(repo, ref) {
  try {
    const saida = await git(['-C', repo, 'rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: repo });
    return saida.trim();
  } catch {
    return null;
  }
}

function ehAncestral(repo, a, b) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b], { cwd: repo, env: envSemGit() }, (erro) => {
      if (!erro) { resolve(true); return; }
      if (erro.code === 1) { resolve(false); return; }
      resolve(null);
    });
  });
}

/** Regra da spec "Qual ref é 'a develop'": local e/ou `origin/develop`, prioridade pela mais nova. */
async function refDaDevelop(repo) {
  const local = await verificarRef(repo, 'refs/heads/develop');
  const remota = await verificarRef(repo, 'refs/remotes/origin/develop');
  if (local && !remota) return { sha: local, ref: 'develop' };
  if (remota && !local) return { sha: remota, ref: 'origin/develop' };
  if (local && remota) {
    const localAtrasDaRemota = await ehAncestral(repo, local, remota);
    if (localAtrasDaRemota === true && local !== remota) return { sha: remota, ref: 'origin/develop' };
    return { sha: local, ref: 'develop' };
  }
  return null;
}

async function arvore(repo, sha) {
  const saida = await git(['-C', repo, 'ls-tree', '-r', '-z', '-l', '--full-tree', sha], { cwd: repo });
  const resultado = [];
  for (const entrada of saida.split('\0')) {
    if (!entrada) continue;
    const tab = entrada.indexOf('\t');
    if (tab < 0) continue;
    const meta = entrada.slice(0, tab).trim();
    const caminho = entrada.slice(tab + 1);
    const partes = meta.split(/\s+/);
    const [modo, tipo, objSha, tamanho] = partes;
    if (tipo !== 'blob') continue;
    if (modo !== '100644' && modo !== '100755') continue;
    resultado.push({ caminho, sha: objSha, tamanho: Number(tamanho) });
  }
  return resultado;
}

/** `spawn('git cat-file --batch')` — um processo só para o lote inteiro. Devolve `Map<sha, Buffer>`. */
function lerBlobs(repo, shas) {
  return new Promise((resolve, reject) => {
    const unicos = [...new Set(shas)];
    if (unicos.length === 0) { resolve(new Map()); return; }
    const proc = spawn('git', ['-C', repo, 'cat-file', '--batch'], { cwd: repo, env: envSemGit() });
    const resultado = new Map();
    let buffer = Buffer.alloc(0);
    let modo = 'cabecalho';
    let pendente = null;
    let terminou = false;

    function processar() {
      for (;;) {
        if (modo === 'cabecalho') {
          const nl = buffer.indexOf(0x0a);
          if (nl < 0) return;
          const linha = buffer.slice(0, nl).toString('utf8');
          buffer = buffer.slice(nl + 1);
          const partes = linha.split(' ');
          if (partes[1] === 'missing') continue;
          pendente = { sha: partes[0], tamanho: Number(partes[2]) };
          modo = 'corpo';
          continue;
        }
        if (buffer.length < pendente.tamanho + 1) return;
        resultado.set(pendente.sha, buffer.slice(0, pendente.tamanho));
        buffer = buffer.slice(pendente.tamanho + 1);
        pendente = null;
        modo = 'cabecalho';
      }
    }

    proc.stdout.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); processar(); });
    proc.stderr.resume();
    proc.on('error', (erro) => { if (!terminou) { terminou = true; reject(erro); } });
    proc.on('close', () => { if (!terminou) { terminou = true; resolve(resultado); } });
    for (const sha of unicos) proc.stdin.write(`${sha}\n`);
    proc.stdin.end();
  });
}

async function atrasFrente(repo, a, b) {
  const saida = await git(['-C', repo, 'rev-list', '--left-right', '--count', `${a}...${b}`], { cwd: repo });
  const [esquerda, direita] = saida.trim().split(/\s+/).map(Number);
  return { frente: esquerda, atras: direita };
}

async function mudados(repo, a, b) {
  const saida = await git(['-C', repo, 'diff', '--name-only', a, b], { cwd: repo });
  return saida.split('\n').filter(Boolean);
}

async function existeCommit(repo, sha) {
  try { await git(['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { cwd: repo }); return true; }
  catch { return false; }
}

async function conteudo(repo, sha, caminho) {
  try { return await git(['-C', repo, 'cat-file', 'blob', `${sha}:${caminho}`], { cwd: repo, binario: true }); }
  catch { return null; }
}

async function configHooksPath(repo) {
  try { return (await git(['-C', repo, 'config', '--get', 'core.hooksPath'], { cwd: repo })).trim() || null; }
  catch { return null; }
}

async function ehWorktreeVinculada(pasta) {
  const saida = await git(['-C', pasta, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: pasta });
  const [gitDir, commonDir] = saida.trim().split('\n');
  return path.resolve(gitDir) !== path.resolve(commonDir);
}

module.exports = {
  envSemGit, git, repoPrincipal, refDaDevelop, arvore, lerBlobs, ehAncestral,
  atrasFrente, mudados, existeCommit, conteudo, configHooksPath, ehWorktreeVinculada,
};
