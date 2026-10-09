#!/usr/bin/env node
'use strict';
// GATE da prévia do merge no "Pra revisar" (card `pra-revisar-aviso-de-conflito-no-merge`).
// Node puro: sem servidor, sem porta. Repos de fixture no tmp. Prova `previaDoMerge` e
// `classificarMergeTree` de `lib/revisar.js`: o estado do merge, que NADA é escrito no repo
// (o retrato de `.git` antes e depois é igual), que não sobra pasta temporária, que merge driver
// customizado nunca roda, e o timeout real de 4 s com o TTL do "não sei".
//
// Nasceu VERMELHO (Fase A do plano): `previaDoMerge` ainda não existia.
//
// Uso:  node testes/gate-merge-previa.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const revisar = require('../lib/revisar.js');

let falhas = 0;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Gate Merge', GIT_AUTHOR_EMAIL: 'gate-merge@localhost',
  GIT_COMMITTER_NAME: 'Gate Merge', GIT_COMMITTER_EMAIL: 'gate-merge@localhost',
};
function git(repo, args, env = GIT_ENV) {
  return execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' }).toString('utf8');
}
function escreve(repo, nome, conteudo) {
  const alvo = path.join(repo, nome);
  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  fs.writeFileSync(alvo, conteudo);
}

const criados = [];
const mkTmp = (prefixo) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefixo)); criados.push(d); return d; };

const CODIGO = 'código.txt'; // COM acento: prova o `-z`
const ROADMAP = 'roadmap-board/data/roadmap.json';

/** Repo com `main` + `develop` no mesmo commit inicial. `extra(dir)` roda antes do commit inicial. */
function novoRepo(extra) {
  const dir = mkTmp('gate-merge-repo-');
  git(dir, ['init', '-b', 'main', '-q']);
  escreve(dir, CODIGO, 'base\n');
  escreve(dir, ROADMAP, '{"v":0}\n');
  if (extra) extra(dir);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'inicial']);
  git(dir, ['branch', 'develop']);
  return dir;
}

/** Branch `branch` (a partir da develop) e a develop mexem nos MESMOS arquivos, com conteúdo diferente. */
function divergir(dir, branch, arquivos) {
  git(dir, ['checkout', '-q', '-b', branch, 'develop']);
  for (const a of arquivos) escreve(dir, a, `lado ${branch}\n`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', `lado ${branch}`]);
  git(dir, ['checkout', '-q', 'develop']);
  for (const a of arquivos) escreve(dir, a, 'lado develop\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'lado develop']);
}

const sha = (repo, ref) => git(repo, ['rev-parse', `refs/heads/${ref}`]).trim();
const previa = (repo, branch, base = 'develop') =>
  revisar.previaDoMerge({ repo, base, shaBase: sha(repo, base), branch, shaBranch: sha(repo, branch) });

/** Caminho relativo → tamanho de TUDO em `.git` (lstat), mais HEAD e o status. Mtime fica de fora (spec R1). */
function retrato(repo) {
  const mapa = new Map();
  const raiz = path.join(repo, '.git');
  (function andar(d) {
    for (const nome of fs.readdirSync(d)) {
      const p = path.join(d, nome);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { mapa.set(`${path.relative(raiz, p)}/`, 0); andar(p); }
      else mapa.set(path.relative(raiz, p), st.size);
    }
  })(raiz);
  mapa.set('::HEAD', git(repo, ['rev-parse', 'HEAD']).trim());
  mapa.set('::status', git(repo, ['status', '--porcelain']));
  return JSON.stringify([...mapa.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

const pastasTmp = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cockpit-merge-tree-')));

async function main() {
  const tmpAntes = pastasTmp();

  // m1: limpo
  const r1 = novoRepo();
  git(r1, ['checkout', '-q', '-b', 'f', 'develop']);
  escreve(r1, 'novo.txt', 'novo\n');
  git(r1, ['add', '.']); git(r1, ['commit', '-q', '-m', 'novo']);
  git(r1, ['checkout', '-q', 'develop']);
  const a1 = retrato(r1);
  const v1 = await previa(r1, 'f');
  ok(JSON.stringify(v1) === JSON.stringify({ estado: 'limpo', n: 0, arquivos: [] }), `(m1) só arquivo novo: limpo — ${JSON.stringify(v1)}`);
  ok(retrato(r1) === a1, '(m9) m1: o retrato do .git é igual antes e depois da prévia');

  // m2: conflito em dois arquivos, ordem de caminho do git
  const r2 = novoRepo();
  divergir(r2, 'f', [CODIGO, ROADMAP]);
  const a2 = retrato(r2);
  const v2 = await previa(r2, 'f');
  ok(v2 && v2.estado === 'conflito' && v2.n === 2 && JSON.stringify(v2.arquivos) === JSON.stringify([CODIGO, ROADMAP]),
    `(m2) conflito nos dois arquivos (nome com acento inteiro, -z) — ${JSON.stringify(v2)}`);
  const d2 = retrato(r2);
  ok(d2 === a2, '(m9) m2: o retrato do .git é igual antes e depois da prévia');
  // m9-neg: sem isolamento o merge-tree ESCREVE — prova que o retrato enxerga escrita
  try { git(r2, ['merge-tree', '--write-tree', 'develop', 'f']); } catch { /* rc=1 é conflito, esperado */ }
  ok(retrato(r2) !== d2, '(m9-neg) merge-tree SEM isolamento muda o retrato — o retrato enxerga escrita');

  // m3: só o roadmap do board
  const r3 = novoRepo();
  divergir(r3, 'f', [ROADMAP]);
  const a3 = retrato(r3);
  const v3 = await previa(r3, 'f');
  ok(v3 && v3.estado === 'so-roadmap' && JSON.stringify(v3.arquivos) === JSON.stringify([ROADMAP]), `(m3) só o roadmap do board: so-roadmap — ${JSON.stringify(v3)}`);
  ok(retrato(r3) === a3, '(m9) m3: o retrato do .git é igual antes e depois da prévia');

  // m4: outro caminho de roadmap.json NÃO é o do board
  const r4 = novoRepo();
  divergir(r4, 'f', ['docs/roadmap.json']);
  const a4 = retrato(r4);
  const v4 = await previa(r4, 'f');
  ok(v4 && v4.estado === 'conflito', `(m4) docs/roadmap.json é conflito comum — ${JSON.stringify(v4)}`);
  ok(retrato(r4) === a4, '(m9) m4: o retrato do .git é igual antes e depois da prévia');

  // m5: a main está contida na develop (1 commit à frente)
  const r5 = novoRepo();
  git(r5, ['checkout', '-q', 'develop']); // sem isto o commit cai na main e o caso vira fast-forward
  escreve(r5, 'a-frente.txt', 'x\n');
  git(r5, ['add', '.']); git(r5, ['commit', '-q', '-m', 'develop a frente']);
  let mainContida = false;
  try { git(r5, ['merge-base', '--is-ancestor', 'main', 'develop']); mainContida = true; } catch { /* rc 1: não é ancestral */ }
  ok(mainContida && sha(r5, 'main') !== sha(r5, 'develop'), '(m5) pré-condição: a main é ancestral da develop, e a develop está à frente');
  const a5 = retrato(r5);
  const v5 = await previa(r5, 'main');
  ok(v5 && v5.estado === 'limpo', `(m5) branch contida na base: limpo — ${JSON.stringify(v5)}`);
  ok(retrato(r5) === a5, '(m9) m5: o retrato do .git é igual antes e depois da prévia');

  // m6: ref que não existe
  const v6 = await revisar.previaDoMerge({ repo: r1, base: 'develop', shaBase: sha(r1, 'develop'), branch: 'nao-existe', shaBranch: '0'.repeat(40) });
  ok(v6 && v6.estado === 'nao-sei', `(m6) branch inexistente: nao-sei — ${JSON.stringify(v6)}`);

  // m7: não é repo
  const vazio = mkTmp('gate-merge-vazio-');
  const v7 = await revisar.previaDoMerge({ repo: vazio, base: 'develop', shaBase: 'a'.repeat(40), branch: 'f', shaBranch: 'b'.repeat(40) });
  ok(v7 && v7.estado === 'nao-sei', `(m7) pasta que não é repo: nao-sei — ${JSON.stringify(v7)}`);

  // m10: nenhuma pasta temporária a mais
  const tmpDepois = pastasTmp();
  ok([...tmpDepois].every((n) => tmpAntes.has(n)), `(m10) nenhuma pasta cockpit-merge-tree-* sobrou — ${JSON.stringify([...tmpDepois].filter((n) => !tmpAntes.has(n)))}`);

  // m8: a função pura
  const OID = 'a'.repeat(40);
  const c = revisar.classificarMergeTree;
  ok([c(1, ''), c(null, ''), c(0, `${OID}\0a\0`), c(1, `${OID}\0`), c(1, 'xyz\0a\0')].every((x) => x.estado === 'nao-sei'),
    '(m8) rc=1 sem saída, rc nulo, limpo com arquivo, conflito sem arquivo e OID inválido: tudo nao-sei');
  ok(c(0, `${OID}\0`).estado === 'limpo', '(m8) rc=0 com só o OID: limpo');
  const dup = c(1, `${OID}\0a\0a\0`);
  ok(dup.estado === 'conflito' && JSON.stringify(dup.arquivos) === '["a"]', `(m8) arquivo repetido sem duplicata — ${JSON.stringify(dup)}`);

  // m12: teto de 50 arquivos
  const r12 = novoRepo();
  const muitos = Array.from({ length: 55 }, (_, i) => `a${String(i).padStart(2, '0')}.txt`);
  divergir(r12, 'f', muitos);
  const v12 = await previa(r12, 'f');
  ok(v12 && v12.n === 55 && v12.arquivos.length === 50, `(m12) 55 em conflito: n:55 e só 50 nomes — n=${v12 && v12.n} nomes=${v12 && v12.arquivos.length}`);

  // m13: merge driver customizado NUNCA roda
  const marcaDir = mkTmp('gate-merge-marca-');
  const marca = path.join(marcaDir, 'driver-rodou');
  const r13 = novoRepo((d) => escreve(d, '.gitattributes', '* merge=x\n'));
  git(r13, ['config', 'merge.x.driver', `touch ${marca}; exit 1`]);
  divergir(r13, 'f', ['codigo.txt']);
  const v13 = await previa(r13, 'f');
  ok(v13 && v13.estado === 'nao-sei' && fs.existsSync(marca) === false, `(m13) repo com merge driver: nao-sei e o driver NÃO rodou — ${JSON.stringify(v13)}`);
  const objetos = git(r13, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim();
  const tmpCtl = mkTmp('gate-merge-ctl-');
  try {
    git(r13, ['merge-tree', '--write-tree', 'develop', 'f'], { ...GIT_ENV, GIT_OBJECT_DIRECTORY: tmpCtl, GIT_ALTERNATE_OBJECT_DIRECTORIES: objetos });
  } catch { /* rc=1 esperado */ }
  ok(fs.existsSync(marca) === true, '(m13-neg) controle: o mesmo merge-tree direto EXECUTA o driver — a guarda é necessária');

  // m14: históricos sem ancestral comum
  const r14 = novoRepo();
  git(r14, ['checkout', '-q', '--orphan', 'solta']);
  git(r14, ['rm', '-rf', '-q', '.']);
  escreve(r14, 'solta.txt', 'solta\n');
  git(r14, ['add', '.']); git(r14, ['commit', '-q', '-m', 'solta']);
  git(r14, ['checkout', '-q', 'develop']);
  const v14 = await previa(r14, 'solta');
  ok(v14 && v14.estado === 'nao-sei', `(m14) branch órfã (sem ancestral comum): nao-sei — ${JSON.stringify(v14)}`);

  // m15 + m11: timeout real de 4 s e TTL do "não sei" — num repo com conflito de verdade
  const r15 = novoRepo();
  divergir(r15, 'f', [CODIGO]);
  let gitReal = '';
  try { gitReal = execFileSync('which', ['git']).toString().trim(); }
  catch { try { gitReal = execFileSync('sh', ['-c', 'command -v git']).toString().trim(); } catch { /* sem git */ } }
  if (!ok(Boolean(gitReal), '(m15) achei o git real para montar o git falso')) return;
  const bin = mkTmp('gate-merge-bin-');
  const trava = path.join(bin, 'dorme');
  fs.writeFileSync(path.join(bin, 'git'),
    `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "merge-tree" ] && [ -e "${trava}" ]; then exec sleep 10; fi\ndone\nexec "${gitReal}" "$@"\n`,
    { mode: 0o755 });
  fs.writeFileSync(trava, '');
  const PATH_ORIGINAL = process.env.PATH;
  const DATE_REAL = Date.now;
  process.env.PATH = `${bin}:${PATH_ORIGINAL}`;
  try {
    const antesTmp = pastasTmp();
    const t0 = Date.now();
    const x1 = await previa(r15, 'f');
    const dt = Date.now() - t0;
    ok(x1 && x1.estado === 'nao-sei', `(m15) git que trava: nao-sei — ${JSON.stringify(x1)}`);
    ok(dt >= 3500 && dt < 9000, `(m15) morreu no timeout de 4 s, não no sleep de 10 — ${dt} ms`);
    ok([...pastasTmp()].every((n) => antesTmp.has(n)), '(m15) o timeout não deixou pasta cockpit-merge-tree-* para trás');

    fs.rmSync(trava, { force: true });
    const t1 = Date.now();
    const x2 = await previa(r15, 'f');
    ok(x2 && x2.estado === 'nao-sei' && Date.now() - t1 < 1000, `(m11) dentro do TTL o nao-sei vem do cache (git já normal) — ${Date.now() - t1} ms`);

    Date.now = () => DATE_REAL() + 61000;
    const x3 = await previa(r15, 'f');
    ok(x3 && x3.estado === 'conflito', `(m11) passado o TTL de 60 s recalcula: conflito — ${JSON.stringify(x3)}`);
  } finally {
    Date.now = DATE_REAL;
    process.env.PATH = PATH_ORIGINAL;
  }
}

main().catch((e) => { console.log(`  ❌ exceção no gate: ${e && e.stack || e}`); falhas += 1; }).finally(() => {
  for (const d of criados) fs.rmSync(d, { recursive: true, force: true });
  console.log(falhas ? `\n❌ GATE VERMELHO (${falhas} falha(s)) — Prévia do merge` : '\n✅ GATE VERDE — Prévia do merge');
  process.exit(falhas ? 1 : 0);
});
