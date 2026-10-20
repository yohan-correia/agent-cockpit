#!/usr/bin/env node
'use strict';
// GATE da diff de commit e de job (card `ver-a-diff-do-codigo`, D95). Nasce com os blocos PUROS
// (a: parser contra git REAL, e: paginação com `topo` fixo e a costura `depoisDeResolver` da
// corrida) e a asserção de corte do numstat alinhado exatamente num `\0`. A Fase 2 acrescenta o
// bloco (b) — rotas, `server.js` FILHO na porta 7987; a Fase 3 acrescenta (c) puras do cliente
// num `vm` e (d) a varredura por `innerHTML`.
//
//   node testes/gate-diff.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

const diff = require('../lib/diff');

const RAIZ_REPO = path.resolve(__dirname, '..');
const SERVER_JS = path.join(RAIZ_REPO, 'server.js');
const PORTA = 7987;

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

// ─── fixture de git (nomes de mentira, #106) ───────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-diff-'));
process.env.HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

function git(repo, args) {
  return execFileSync('git', [
    '-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid',
    ...args,
  ], { encoding: 'utf8' });
}
function sha(repo, ref = 'HEAD') { return git(repo, ['rev-parse', ref]).trim(); }
function escrever(repo, arquivos) {
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const p = path.join(repo, nome);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, conteudo);
  }
}
function commit(repo, arquivos, msg) {
  escrever(repo, arquivos);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
  return sha(repo);
}

/**
 * Repo de fixture (card ver-a-diff-do-codigo): arquivo novo, apagado, renomeado (≥50% igual),
 * binário, `chmod +x` só modo, sem newline no fim, caminho com espaço/acento, merge --no-ff com
 * mudança, merge SEM mudança contra o 1º pai (históricos divergentes via `cherry-pick -x`), linha
 * de 5000 caracteres, e mais 25 commits pequenos na `develop` (depois do merge) pra lista passar
 * de 31 (painel do plano, Claude #3).
 */
function montarFixture() {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  git(dir, ['init', '-q', '-b', 'develop']);

  const c1 = commit(dir, {
    'base.txt': 'linha1\nlinha2\nlinha3\n',
    'exec.txt': 'echo ola\n',
    'apagado.txt': 'vai sumir\n',
    'antigo.txt': 'conteudo original\nlinha2\n',
  }, 'c1 base');

  const c2 = commit(dir, { 'novo.txt': 'sou novo\n' }, 'c2 novo');

  fs.chmodSync(path.join(dir, 'exec.txt'), 0o755);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'c3 chmod']);
  const c3 = sha(dir);

  fs.rmSync(path.join(dir, 'apagado.txt'));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'c4 apagado']);
  const c4 = sha(dir);

  git(dir, ['mv', 'antigo.txt', 'novo-nome.txt']);
  fs.appendFileSync(path.join(dir, 'novo-nome.txt'), 'linha extra\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'c5 renomeado']);
  const c5 = sha(dir);

  const c6 = commit(dir, { 'bin.dat': Buffer.from([0, 1, 2, 255, 0, 10, 0]) }, 'c6 binario');
  const c7 = commit(dir, { 'pasta nova/ação.txt': 'conteudo\n' }, 'c7 espaco acento');
  const c8 = commit(dir, { 'linhagrande.txt': `${'x'.repeat(5000)}\n` }, 'c8 linha grande');

  fs.writeFileSync(path.join(dir, 'semnl.txt'), 'sem newline');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'c9 sem newline']);
  const c9 = sha(dir);

  // merge --no-ff COM mudança
  git(dir, ['checkout', '-q', '-b', 'lado']);
  commit(dir, { 'compartilhado.txt': 'mudanca do lado\n' }, 'lado1');
  git(dir, ['checkout', '-q', 'develop']);
  git(dir, ['merge', '--no-ff', '-q', '-m', 'merge1 com mudanca', 'lado']);
  const merge1 = sha(dir);

  // merge --no-ff SEM mudança contra o 1º pai: históricos divergentes (a develop recebe a MESMA
  // mudança por cherry-pick -x — sha diferente de lado2, mesma árvore).
  git(dir, ['checkout', '-q', '-b', 'lado2']);
  const lado2C = commit(dir, { 'outro.txt': 'mudanca do lado2\n' }, 'lado2-1');
  git(dir, ['checkout', '-q', 'develop']);
  git(dir, ['cherry-pick', '-x', lado2C]);
  git(dir, ['merge', '--no-ff', '-q', '-m', 'merge2 sem mudanca', 'lado2']);
  const merge2 = sha(dir);

  for (let i = 1; i <= 25; i += 1) commit(dir, { [`n${i}.txt`]: `conteudo ${i}\n` }, `n${i}`);
  const topo = sha(dir);

  return { dir, c1, c2, c3, c4, c5, c6, c7, c8, c9, merge1, merge2, topo };
}

// ─── (a) parser contra git real ─────────────────────────────────────────────────────────────────

async function blocoA(f) {
  ok(diff.desfazerAspas('"a\\303\\247\\303\\243o"') === 'ação', `desfazerAspas decodifica octal multibyte (achei ${JSON.stringify(diff.desfazerAspas('"a\\303\\247\\303\\243o"'))})`);
  ok(diff.desfazerAspas('sem aspas') === 'sem aspas', 'desfazerAspas devolve string sem aspas intocada');

  async function patchDe(shaDoCommit) {
    const r = await diff.gitLimitado(f.dir, ['show', '--format=', ...diff.ARGS_PATCH, shaDoCommit], { teto: diff.TETOS.patch });
    return diff.parsearPatch(r.stdout.toString('utf8'));
  }
  async function numstatDe(shaDoCommit) {
    const r = await diff.gitLimitado(f.dir, ['show', '--format=', '--numstat', '-z', ...diff.ARGS_COMUNS, shaDoCommit], { teto: diff.TETOS.numstat });
    return diff.lerNumstat(r.stdout.toString('utf8'));
  }

  // arquivo novo
  const pC2 = await patchDe(f.c2);
  ok(pC2.length === 1 && pC2[0].caminho === 'novo.txt' && pC2[0].estado === 'novo', `novo.txt: estado novo (achei ${JSON.stringify(pC2[0])})`);
  ok(pC2[0].modo && pC2[0].modo.depois === '100644', 'novo.txt: modo.depois 100644');
  ok(pC2[0].mais === 1 && pC2[0].menos === 0, 'novo.txt: +1 -0');
  const nC2 = await numstatDe(f.c2);
  ok(nC2.arquivos.length === 1 && nC2.arquivos[0].caminho === 'novo.txt' && nC2.arquivos[0].mais === 1, `numstat novo.txt (achei ${JSON.stringify(nC2)})`);

  // chmod só modo
  const pC3 = await patchDe(f.c3);
  ok(pC3.length === 1 && pC3[0].caminho === 'exec.txt' && pC3[0].estado === 'modificado', `exec.txt: estado modificado, sem novo/apagado (achei ${JSON.stringify(pC3[0])})`);
  ok(pC3[0].modo && pC3[0].modo.antes === '100644' && pC3[0].modo.depois === '100755', `exec.txt: modo 100644 → 100755 (achei ${JSON.stringify(pC3[0].modo)})`);
  ok(pC3[0].trechos.length === 0, 'exec.txt: sem trechos (só modo)');

  // apagado
  const pC4 = await patchDe(f.c4);
  ok(pC4.length === 1 && pC4[0].caminho === 'apagado.txt' && pC4[0].estado === 'apagado', `apagado.txt: estado apagado (achei ${JSON.stringify(pC4[0])})`);
  ok(pC4[0].menos === 1 && pC4[0].mais === 0, 'apagado.txt: -1 +0');

  // renomeado (≥50% igual)
  const pC5 = await patchDe(f.c5);
  ok(pC5.length === 1 && pC5[0].caminho === 'novo-nome.txt' && pC5[0].antigo === 'antigo.txt' && pC5[0].estado === 'renomeado',
    `renomeado: antigo.txt → novo-nome.txt (achei ${JSON.stringify(pC5[0])})`);
  const nC5 = await numstatDe(f.c5);
  ok(nC5.arquivos[0].antigo === 'antigo.txt' && nC5.arquivos[0].caminho === 'novo-nome.txt', `numstat renomeado (achei ${JSON.stringify(nC5.arquivos[0])})`);

  // binário
  const pC6 = await patchDe(f.c6);
  ok(pC6.length === 1 && pC6[0].caminho === 'bin.dat' && pC6[0].binario === true && pC6[0].estado === 'novo', `bin.dat: binário + novo (achei ${JSON.stringify(pC6[0])})`);
  ok(pC6[0].trechos.length === 0, 'bin.dat: sem trechos');
  const nC6 = await numstatDe(f.c6);
  ok(nC6.arquivos[0].binario === true && nC6.arquivos[0].mais === null && nC6.arquivos[0].menos === null, `numstat binário: mais/menos null (achei ${JSON.stringify(nC6.arquivos[0])})`);

  // caminho com espaço e acento
  const pC7 = await patchDe(f.c7);
  ok(pC7.length === 1 && pC7[0].caminho === 'pasta nova/ação.txt', `caminho com espaço/acento (achei ${JSON.stringify(pC7[0].caminho)})`);

  // linha de 5000 caracteres → corte em LINHA_MAX + longas
  const pC8 = await patchDe(f.c8);
  const trechoC8 = pC8[0].trechos[0];
  ok(trechoC8.linhas[0].length === diff.LINHA_MAX, `linha de 5000: guardada até LINHA_MAX caracteres (achei ${trechoC8.linhas[0].length})`);
  ok(trechoC8.longas.length === 1 && trechoC8.longas[0].i === 0 && trechoC8.longas[0].n === 5000, `longas aponta índice e tamanho original (achei ${JSON.stringify(trechoC8.longas)})`);

  // sem newline no fim
  const pC9 = await patchDe(f.c9);
  ok(pC9[0].semFimDeLinha.depois === true && pC9[0].semFimDeLinha.antes === false, `semnl.txt: semFimDeLinha.depois (achei ${JSON.stringify(pC9[0].semFimDeLinha)})`);

  // merge --no-ff com mudança — contra o 1º pai, não vazio
  const pM1 = await patchDe(f.merge1);
  ok(pM1.length === 1 && pM1[0].caminho === 'compartilhado.txt', `merge1 contra o 1º pai: compartilhado.txt (achei ${JSON.stringify(pM1.map((a) => a.caminho))})`);
  const commitM1 = await diff.commitInteiro(f.dir, f.merge1);
  ok(commitM1.merge === true && commitM1.arquivos.length === 1 && commitM1.totais && commitM1.totais.arquivos === 1,
    `commitInteiro do merge1: merge=true, arquivos contra o 1º pai, não vazio (achei ${JSON.stringify(commitM1.totais)})`);

  // merge --no-ff SEM mudança — numstat vazio
  const nM2 = await numstatDe(f.merge2);
  ok(nM2.arquivos.length === 0 && nM2.interrompido === false, `merge2 (históricos divergentes, mesma árvore): numstat vazio (achei ${JSON.stringify(nM2)})`);

  // lerLog: merge sem shortstat no MEIO de dois commits normais — vizinhos certos, merge 0/0/0.
  // `--first-parent` só nesta leitura (lerLog é puro — testa a função, não a `commitsDe` real):
  // sem ela, as DUAS cadeias de pais do merge2 têm timestamp quase idêntico (mesmo segundo do
  // teste) e a ordem entre elas fica ambígua — com ela, a trilha é determinística (n1 depois,
  // o "twin" do cherry-pick antes, ambos commits normais).
  const rLog = await diff.gitLimitado(
    f.dir,
    ['log', '--first-parent', '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s', '--shortstat', ...diff.ARGS_COMUNS, '-n', '28', f.topo],
    { teto: diff.TETOS.log },
  );
  const registros = diff.lerLog(rLog.stdout.toString('utf8'));
  const idxMerge2 = registros.findIndex((c) => c.sha === f.merge2);
  ok(idxMerge2 > 0 && idxMerge2 < registros.length - 1, `merge2 está no MEIO da lista (achei índice ${idxMerge2} de ${registros.length})`);
  ok(registros[idxMerge2].merge === true && registros[idxMerge2].arquivos === 0 && registros[idxMerge2].mais === 0 && registros[idxMerge2].menos === 0,
    `merge2 sem shortstat → 0/0/0 (achei ${JSON.stringify(registros[idxMerge2])})`);
  ok(registros[idxMerge2 - 1].assunto === 'n1' && registros[idxMerge2 - 1].mais === 1, `vizinho depois (n1) com os números certos, não deslocado (achei ${JSON.stringify(registros[idxMerge2 - 1])})`);
  ok(registros[idxMerge2 + 1].assunto === 'lado2-1' && registros[idxMerge2 + 1].merge === false && registros[idxMerge2 + 1].mais === 1,
    `vizinho antes (o "twin" do cherry-pick, 1º pai) com os números certos, não deslocado (achei ${JSON.stringify(registros[idxMerge2 + 1])})`);

  // lerCabecalho: mensagem com várias linhas e commit raiz (sem pais)
  const multilinha = commit(f.dir, { 'multilinha.txt': 'x\n' }, 'assunto da mensagem\n\ncorpo linha 1\ncorpo linha 2\n');
  const rCab = await diff.gitLimitado(f.dir, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%B', multilinha], { teto: diff.TETOS.log });
  const cab = diff.lerCabecalho(rCab.stdout.toString('utf8'));
  ok(cab.sha === multilinha && cab.mensagem.includes('corpo linha 1') && cab.mensagem.includes('corpo linha 2'),
    `lerCabecalho: mensagem de várias linhas intacta (achei ${JSON.stringify(cab.mensagem)})`);
  const rCabRaiz = await diff.gitLimitado(f.dir, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%B', f.c1], { teto: diff.TETOS.log });
  const cabRaiz = diff.lerCabecalho(rCabRaiz.stdout.toString('utf8'));
  ok(Array.isArray(cabRaiz.pais) && cabRaiz.pais.length === 0, `lerCabecalho do commit raiz: pais=[] (achei ${JSON.stringify(cabRaiz.pais)})`);

  // gitLimitado: teto e timeout
  const rTeto = await diff.gitLimitado(f.dir, ['log', '-p', 'develop'], { teto: 500 });
  ok(rTeto.cortado === true && rTeto.stdout.length === 500, `gitLimitado teto=500: cortado, exatamente 500 bytes (achei ${rTeto.stdout.length})`);
  const rTimeout = await diff.gitLimitado(f.dir, ['log', '-p', 'develop'], { teto: 10 ** 9, timeoutMs: 1 });
  ok(rTimeout.tempoEsgotado === true, 'gitLimitado timeoutMs=1: tempoEsgotado');
  const rGitInexistente = await new Promise((resolve) => {
    const antigo = process.env.PATH;
    process.env.PATH = '/caminho/que/nao/existe';
    diff.gitLimitado(f.dir, ['status'], { teto: 1000 }).then((r) => { process.env.PATH = antigo; resolve(r); });
  });
  ok(rGitInexistente.erro === true, `gitLimitado com git ausente do PATH: erro=true, nunca rejeita (achei ${JSON.stringify(rGitInexistente)})`);

  // numstat cortado EXATAMENTE depois de um \0 (teto = tamanho do 1º registro) — numa diff com VÁRIOS
  // arquivos, pra o corte perder registro de verdade. Com um arquivo só, "teto = tamanho exato" não perde
  // nada e NÃO é corte (painel de execução, Claude #4: o `>=` marcava corte aí).
  const argsNumVarios = ['diff', '--numstat', '-z', ...diff.ARGS_COMUNS, f.c1, f.topo];
  const rNumJob = await diff.gitLimitado(f.dir, argsNumVarios, { teto: diff.TETOS.numstat });
  const textoNumC2 = rNumJob.stdout.toString('utf8');
  ok(diff.lerNumstat(textoNumC2).arquivos.length >= 2, 'fixture: a diff c1..topo tem 2+ arquivos no numstat');
  const rNumTudoExato = await diff.gitLimitado(f.dir, argsNumVarios, { teto: rNumJob.stdout.length });
  ok(rNumTudoExato.cortado === false && rNumTudoExato.stdout.length === rNumJob.stdout.length,
    `gitLimitado: saída EXATAMENTE do tamanho do teto não é corte (achei cortado=${rNumTudoExato.cortado})`);
  const fimDoRegistro = textoNumC2.indexOf('\0') + 1;
  const rNumExato = await diff.gitLimitado(f.dir, argsNumVarios, { teto: fimDoRegistro });
  const numExato = diff.lerNumstat(rNumExato.stdout.toString('utf8'));
  ok(rNumExato.cortado === true && numExato.interrompido === false && numExato.arquivos.length === 1,
    `numstat cortado exatamente após \\0: gitLimitado.cortado=true, lerNumstat NÃO acha registro parcial (achei cortado=${rNumExato.cortado}, interrompido=${numExato.interrompido})`);
  const juntadoExato = diff.juntar(numExato, [], { listaCortada: rNumExato.cortado || numExato.interrompido });
  ok(juntadoExato.cortado.lista === true && juntadoExato.totais === null,
    `juntar: corte do gitLimitado (mesmo sem registro parcial) → cortado.lista=true, totais=null (achei ${JSON.stringify(juntadoExato.cortado)})`);

  // juntar: patch cortado no MEIO do 2º arquivo — o último arquivo presente perde o corpo
  const shaMulti = commit(f.dir, {
    'multi-a.txt': 'conteudo a\n',
    'multi-b.txt': `conteudo ${'b'.repeat(60)}\n`,
  }, 'multi arquivos');
  const rPatchFull = await diff.gitLimitado(f.dir, ['show', '--format=', ...diff.ARGS_PATCH, shaMulti], { teto: diff.TETOS.patch });
  const textoPatchFull = rPatchFull.stdout.toString('utf8');
  const idx2o = textoPatchFull.indexOf('diff --git a/multi-b.txt');
  const rPatchCortado = await diff.gitLimitado(f.dir, ['show', '--format=', ...diff.ARGS_PATCH, shaMulti], { teto: idx2o + 30 });
  const patchCortado = diff.parsearPatch(rPatchCortado.stdout.toString('utf8'));
  const numMulti = await numstatDe(shaMulti);
  const juntadoCortado = diff.juntar(numMulti, patchCortado, { corpoCortado: rPatchCortado.cortado });
  ok(juntadoCortado.arquivos[0].caminho === 'multi-a.txt' && !juntadoCortado.arquivos[0].semCorpo, 'juntar (corte no meio): 1º arquivo mantém o corpo');
  ok(juntadoCortado.arquivos[1].caminho === 'multi-b.txt' && juntadoCortado.arquivos[1].semCorpo === 'cortado' && juntadoCortado.arquivos[1].estado === null,
    `juntar (corte no meio): último arquivo presente perde o corpo, semCorpo='cortado', sem chip de estado (achei ${JSON.stringify(juntadoCortado.arquivos[1])})`);
  ok(juntadoCortado.cortado.corpo === true, 'juntar (corte no meio): cortado.corpo=true');

  // timeout conta como corte (V7, painel R2 Claude #2)
  const juntadoTempo = diff.juntar({ arquivos: [], interrompido: false }, [], { tempo: true });
  ok(juntadoTempo.cortado.tempo === true, 'juntar propaga cortado.tempo quando o chamador passa tempo=true');
}

// ─── (e) paginação com topo fixo + corrida do job (depoisDeResolver) ──────────────────────────

async function blocoE(f) {
  const p1 = await diff.commitsDe(f.dir, {});
  ok(p1.base && p1.base.nome === 'develop', `commitsDe sem topo: resolve a base (achei ${JSON.stringify(p1.base)})`);
  ok(p1.commits.length === diff.POR_PAGINA && p1.mais === true, `1ª página: ${diff.POR_PAGINA} commits + mais (achei ${p1.commits.length}, mais=${p1.mais})`);

  // commit NOVO na base depois da 1ª página
  commit(f.dir, { 'depois-pagina1.txt': 'x\n' }, 'depois-pagina1');

  const p2 = await diff.commitsDe(f.dir, { topo: p1.topo, pular: diff.POR_PAGINA });
  ok(p2.base && p2.base.nome === 'develop', `2ª página: base ainda resolvida (não lê de undefined) (achei ${JSON.stringify(p2.base)})`);
  ok(!p2.commits.some((c) => c.assunto === 'depois-pagina1'), '2ª página: o commit novo na base NÃO aparece (topo fixo)');
  ok(p2.commits.length > 0, `2ª página: tem os commits que faltavam (achei ${p2.commits.length})`);

  // job com mudanças
  git(f.dir, ['checkout', '-q', '-b', 'job-ok', f.topo]);
  commit(f.dir, { 'job-arquivo.txt': 'mudanca do job\n' }, 'job commit 1');
  git(f.dir, ['checkout', '-q', 'develop']);

  const resJobOk = await diff.mudancasDoJob({ meta: { branch: 'job-ok' }, repo: f.dir });
  ok(resJobOk.estado === 'ok' && resJobOk.nCommits === 1 && resJobOk.arquivos.length === 1 && resJobOk.arquivos[0].caminho === 'job-arquivo.txt',
    `job-ok: estado ok, 1 commit, 1 arquivo (achei ${JSON.stringify({ estado: resJobOk.estado, nCommits: resJobOk.nCommits, arquivos: resJobOk.arquivos.map((a) => a.caminho) })})`);

  // corrida: commit NOVO na branch do job entre a resolução dos SHAs e a 1ª leitura
  let chamouCostura = false;
  const resCorrida = await diff.mudancasDoJob({ meta: { branch: 'job-ok' }, repo: f.dir }, {
    depoisDeResolver: async () => {
      chamouCostura = true;
      git(f.dir, ['checkout', '-q', 'job-ok']);
      commit(f.dir, { 'tarde.txt': 'chegou tarde\n' }, 'tarde');
      git(f.dir, ['checkout', '-q', 'develop']);
    },
  });
  ok(chamouCostura, 'depoisDeResolver foi chamado (a costura roda na função REAL)');
  ok(!resCorrida.arquivos.some((a) => a.caminho === 'tarde.txt') && resCorrida.nCommits === 1,
    `commit no meio da leitura NÃO aparece (SHAs fixos) (achei ${JSON.stringify(resCorrida.arquivos.map((a) => a.caminho))}, nCommits=${resCorrida.nCommits})`);
  const resSemCorrida = await diff.mudancasDoJob({ meta: { branch: 'job-ok' }, repo: f.dir });
  ok(resSemCorrida.arquivos.some((a) => a.caminho === 'tarde.txt') && resSemCorrida.nCommits === 2,
    `uma 2ª chamada sem a costura lista os dois (achei ${JSON.stringify(resSemCorrida.arquivos.map((a) => a.caminho))}, nCommits=${resSemCorrida.nCommits})`);

  // branch sumida — motivo limpo e sumiu
  const resLimpo = await diff.mudancasDoJob({ meta: { branch: 'nao-existe-mais', merged_at: '2026-01-01' }, repo: f.dir });
  ok(resLimpo.estado === 'branch-sumiu' && resLimpo.motivo === 'limpo', `branch sumida com merged_at → motivo limpo (achei ${JSON.stringify(resLimpo)})`);
  const resSumiu = await diff.mudancasDoJob({ meta: { branch: 'nao-existe-mais' }, repo: f.dir });
  ok(resSumiu.estado === 'branch-sumiu' && resSumiu.motivo === 'sumiu', `branch sumida sem meta de mergeado → motivo sumiu (achei ${JSON.stringify(resSumiu)})`);

  // branch contida (já na develop) → sem-mudancas
  git(f.dir, ['checkout', '-q', '-b', 'job-contido', 'develop']);
  git(f.dir, ['checkout', '-q', 'develop']);
  const resContido = await diff.mudancasDoJob({ meta: { branch: 'job-contido' }, repo: f.dir });
  ok(resContido.estado === 'sem-mudancas' && resContido.base === 'develop', `branch já contida na develop → sem-mudancas (achei ${JSON.stringify(resContido)})`);

  // sem base
  const semBaseDir = fs.mkdtempSync(path.join(TMP, 'sem-base-'));
  git(semBaseDir, ['init', '-q', '-b', 'feature-qualquer']);
  commit(semBaseDir, { 'a.txt': 'x\n' }, 'c1');
  const resSemBase = await diff.mudancasDoJob({ meta: { branch: 'feature-qualquer' }, repo: semBaseDir });
  ok(resSemBase.estado === 'sem-base', `repo sem develop/main → sem-base (achei ${JSON.stringify(resSemBase)})`);
  const semBaseCommits = await diff.commitsDe(semBaseDir, {});
  ok(semBaseCommits.semBase === true, `commitsDe de repo sem develop/main → semBase (achei ${JSON.stringify(semBaseCommits)})`);
}

// ─── (b) rotas — server.js FILHO na porta 7987 (molde `gate-grafo-mapa.js`/`gate-grafo-fazer-hook.js`) ──

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
const bearer = (token) => ({ authorization: `Bearer ${token}` });

function confereLivre() {
  let saida = '';
  try { saida = execSync('ss -H -lptn', { encoding: 'utf8' }); } catch { return; }
  if (new RegExp(`:${PORTA}\\b`).test(saida)) {
    console.error(`porta ${PORTA} ocupada — o gate não pode rodar\n${saida}`);
    process.exit(1);
  }
}

/** Sobe `server.js` filho com env FECHADO — mesmo molde de `gate-grafo-mapa.js`. */
async function withServer({ projetosDir, jobsDir, token }, tarefa) {
  confereLivre();
  const tmp = fs.mkdtempSync(path.join(TMP, 'srv-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
    COCKPIT_CERT_DIR: '/dev/null',
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_JOBS_DIR: jobsDir,
    COCKPIT_MONITOR_DIR: path.join(tmp, 'monitor'), COCKPIT_MONITOR_MS: '0',
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(tmp, 'push'),
    COCKPIT_LIDAS_DIR: path.join(tmp, 'lidas'),
    COCKPIT_LEITURAS_DIR: path.join(tmp, 'leituras'),
    COCKPIT_TMUX_SOCKET: `gate-diff-${process.pid}`,
    COCKPIT_DU_BIN: path.join(tmp, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(tmp, 'sem-docker'),
  };
  if (token) env.COCKPIT_TOKEN = token;
  const logPath = path.join(tmp, 'servidor.log');
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [SERVER_JS], { cwd: RAIZ_REPO, env, stdio: ['ignore', logFd, logFd] });
  try {
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`servidor saiu antes do /health (rc=${child.exitCode}) — ver ${logPath}`);
      try { const r = await pedir('/health'); if (r.status === 200) break; } catch { /* ainda subindo */ }
      if (Date.now() - t0 > 10000) throw new Error(`timeout esperando /health — ver ${logPath}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await tarefa(child);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
    fs.closeSync(logFd);
  }
}

/**
 * Fixture de rotas: projeto `demo` (develop com 35 commits, pra paginação de 30+mais), pasta
 * `sem-git` (sem `.git`), repo `quebrado` (2 commits, blob do 2º apagado solto — `show` do patch
 * falha com rc 128), e 4 jobs: `job-ok` (branch à frente), `job-contido` (já na develop),
 * `job-sumiu` (merged_at + branch inexistente), `job-fora` (`source_repo` fora da pasta de
 * projetos, inclusive com o MESMO nome "demo" — a igualdade de `realpath` é quem decide).
 */
function montarFixtureRotas() {
  const projetosDir = fs.mkdtempSync(path.join(TMP, 'projetos-'));
  const jobsDir = fs.mkdtempSync(path.join(TMP, 'jobs-'));

  const demoDir = path.join(projetosDir, 'demo');
  fs.mkdirSync(demoDir, { recursive: true });
  git(demoDir, ['init', '-q', '-b', 'develop']);
  for (let i = 1; i <= 35; i += 1) commit(demoDir, { [`a${i}.txt`]: `conteudo ${i}\n` }, `a${i}`);
  const shaUmCommit = git(demoDir, ['rev-parse', 'HEAD~10']).trim();

  fs.mkdirSync(path.join(projetosDir, 'sem-git'), { recursive: true });

  const quebradoDir = path.join(projetosDir, 'quebrado');
  fs.mkdirSync(quebradoDir, { recursive: true });
  git(quebradoDir, ['init', '-q', '-b', 'develop']);
  commit(quebradoDir, { 'a.txt': 'linha1\n' }, 'c1');
  const shaQuebrado2 = commit(quebradoDir, { 'a.txt': 'linha1\nlinha2\n' }, 'c2');
  const blobSha = git(quebradoDir, ['rev-parse', `${shaQuebrado2}:a.txt`]).trim();
  const objPath = path.join(quebradoDir, '.git', 'objects', blobSha.slice(0, 2), blobSha.slice(2));
  fs.rmSync(objPath);

  // job-ok: branch de job à frente da develop.
  git(demoDir, ['branch', 'job/ok', 'develop']);
  git(demoDir, ['checkout', '-q', 'job/ok']);
  commit(demoDir, { 'job-ok.txt': 'mudanca do job\n' }, 'job ok commit');
  git(demoDir, ['checkout', '-q', 'develop']);

  // job-contido: branch idêntica à develop (sem mudanças).
  git(demoDir, ['branch', 'job/contido', 'develop']);

  // repo FORA da pasta de projetos, com o MESMO nome "demo" (job-fora).
  const foraDir = fs.mkdtempSync(path.join(TMP, 'fora-'));
  const demoForaDir = path.join(foraDir, 'demo');
  fs.mkdirSync(demoForaDir, { recursive: true });
  git(demoForaDir, ['init', '-q', '-b', 'develop']);
  commit(demoForaDir, { 'x.txt': 'x\n' }, 'c1 fora');

  function job(id, meta) {
    const dir = path.join(jobsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  }
  job('job-ok', { title: 'Job OK', source_repo: demoDir, branch: 'job/ok' });
  job('job-contido', { title: 'Job contido', source_repo: demoDir, branch: 'job/contido' });
  job('job-sumiu', { title: 'Job sumido', source_repo: demoDir, branch: 'nao-existe-mais', merged_at: '2026-01-01T00:00:00Z' });
  job('job-fora', { title: 'Job fora', source_repo: demoForaDir, branch: 'develop' });
  // meta.json ilegível (painel de execução R2, Claude #3): 404 "não achei este job", não o texto do repo.
  fs.mkdirSync(path.join(jobsDir, 'job-meta-ruim'), { recursive: true });
  fs.writeFileSync(path.join(jobsDir, 'job-meta-ruim', 'meta.json'), '{ isto não é json');

  return { projetosDir, jobsDir, demoDir, quebradoDir, shaQuebrado2, shaUmCommit };
}

async function blocoB(fx) {
  const TOKEN = 'gate-diff';
  await withServer({ projetosDir: fx.projetosDir, jobsDir: fx.jobsDir, token: TOKEN }, async () => {
    const cab = bearer(TOKEN);

    // tabela fechada + parâmetro obrigatório ausente → 400
    let r = await pedir('/api/diff/commit?projeto=demo', 'GET', cab);
    ok(r.status === 400, `/api/diff/commit sem sha → 400 (achei ${r.status})`);
    r = await pedir('/api/diff/commits', 'GET', cab);
    ok(r.status === 400, `/api/diff/commits sem projeto → 400 (achei ${r.status})`);
    r = await pedir('/api/diff/job', 'GET', cab);
    ok(r.status === 400, `/api/diff/job sem id → 400 (achei ${r.status})`);
    r = await pedir('/api/diff/commit?projeto=demo&sha=xyz', 'GET', cab);
    ok(r.status === 400, `/api/diff/commit sha=xyz (fora da regex) → 400 (achei ${r.status})`);
    r = await pedir('/api/diff/commits?projeto=demo&topo=0123456789012345678901234567890123456789', 'GET', cab);
    ok(r.status === 400, `/api/diff/commits topo sem pular → 400 (achei ${r.status})`);
    r = await pedir('/api/diff/commit?projeto=demo&sha=caffee0&caminho=x', 'GET', cab);
    ok(r.status === 400, `chave fora da tabela (&caminho=x) → 400 (achei ${r.status})`);
    r = await pedir('/api/diff/commit?projeto=demo&projeto=demo&sha=caffee0', 'GET', cab);
    ok(r.status === 400, `chave repetida → 400 (achei ${r.status})`);

    // sha de 40 hex inexistente → 404
    r = await pedir(`/api/diff/commit?projeto=demo&sha=${'a'.repeat(40)}`, 'GET', cab);
    ok(r.status === 404, `sha de 40 hex inexistente → 404 (achei ${r.status})`);

    // projeto fora da lista / `../` / sem-git → 404
    r = await pedir(`/api/diff/commit?projeto=..%2Fetc&sha=${'a'.repeat(40)}`, 'GET', cab);
    ok(r.status === 404, `projeto=..%2Fetc → 404 (achei ${r.status})`);
    r = await pedir(`/api/diff/commit?projeto=nao-existe&sha=${'a'.repeat(40)}`, 'GET', cab);
    ok(r.status === 404, `projeto=nao-existe → 404 (achei ${r.status})`);
    r = await pedir(`/api/diff/commit?projeto=sem-git&sha=${'a'.repeat(40)}`, 'GET', cab);
    ok(r.status === 404, `projeto=sem-git → 404 (achei ${r.status})`);

    // sem token → 401
    r = await pedir('/api/diff/commits?projeto=demo', 'GET', {});
    ok(r.status === 401, `sem token → 401 (achei ${r.status})`);

    // 1ª página: 30 commits + mais
    r = await pedir('/api/diff/commits?projeto=demo', 'GET', cab);
    const corpo1 = JSON.parse(r.corpo);
    ok(r.status === 200 && corpo1.commits.length === 30 && corpo1.mais === true, `1ª página: 200, 30 commits, mais=true (achei status=${r.status}, ${JSON.stringify({ n: corpo1.commits.length, mais: corpo1.mais })})`);

    // 2ª página: mesmo topo, base ainda 'develop', commits que faltavam
    r = await pedir(`/api/diff/commits?projeto=demo&topo=${corpo1.topo}&pular=30`, 'GET', cab);
    const corpo2 = JSON.parse(r.corpo);
    ok(r.status === 200 && corpo2.base === 'develop' && corpo2.commits.length > 0, `2ª página: 200, base=develop, commits restantes (achei ${JSON.stringify({ status: r.status, base: corpo2.base, n: corpo2.commits.length })})`);
    ok(!corpo2.commits.some((c) => corpo1.commits.some((c1) => c1.sha === c.sha)), '2ª página: sem repetir sha da 1ª');

    // git quebrado → 502
    r = await pedir(`/api/diff/commit?projeto=quebrado&sha=${fx.shaQuebrado2}`, 'GET', cab);
    ok(r.status === 502, `repo com objeto quebrado → 502 (achei ${r.status}: ${r.corpo})`);

    // jobs
    r = await pedir('/api/diff/job?id=nao-existe', 'GET', cab);
    ok(r.status === 404, `job id=nao-existe → 404 (achei ${r.status})`);
    r = await pedir('/api/diff/job?id=../x', 'GET', cab);
    ok(r.status === 404, `job id=../x → 404 (achei ${r.status})`);
    r = await pedir('/api/diff/job?id=job-fora', 'GET', cab);
    ok(r.status === 404, `job-fora (source_repo fora da pasta de projetos) → 404 (achei ${r.status}: ${r.corpo})`);
    r = await pedir('/api/diff/job?id=job-meta-ruim', 'GET', cab);
    ok(r.status === 404 && String(r.corpo).includes('não achei este job'), `job com meta.json ilegível → 404 "não achei este job" (achei ${r.status}: ${r.corpo})`);

    r = await pedir('/api/diff/job?id=job-ok', 'GET', cab);
    const corpoJobOk = JSON.parse(r.corpo);
    ok(r.status === 200 && corpoJobOk.estado === 'ok', `job-ok → 200, estado ok (achei ${r.status}: ${r.corpo})`);
    ok(!r.corpo.includes('"worktree"') && !r.corpo.includes('"branch"') && !r.corpo.includes('"source_repo"'),
      `job-ok: resposta sem worktree/branch/source_repo (achei ${r.corpo})`);

    r = await pedir('/api/diff/job?id=job-contido', 'GET', cab);
    const corpoJobContido = JSON.parse(r.corpo);
    ok(r.status === 200 && corpoJobContido.estado === 'sem-mudancas', `job-contido → 200, sem-mudancas (achei ${r.status}: ${r.corpo})`);

    r = await pedir('/api/diff/job?id=job-sumiu', 'GET', cab);
    const corpoJobSumiu = JSON.parse(r.corpo);
    ok(r.status === 200 && corpoJobSumiu.estado === 'branch-sumiu' && corpoJobSumiu.motivo === 'limpo',
      `job-sumiu → 200, branch-sumiu, motivo limpo (achei ${r.status}: ${r.corpo})`);

    // casca /diff/
    r = await pedir('/diff', 'GET', cab);
    ok(r.status === 301 && r.headers.location === 'diff/', `/diff → 301 location diff/ (achei ${r.status} ${r.headers.location})`);
    r = await pedir('/diff/', 'GET', cab);
    ok(r.status === 200 && r.headers['content-type'] && r.headers['content-type'].includes('html'), `/diff/ → 200 html (achei ${r.status} ${r.headers['content-type']})`);
    r = await pedir('/cockpit/diff/', 'GET', cab);
    ok(r.status === 200, `/cockpit/diff/ → 200 (#16) (achei ${r.status})`);
    r = await pedir('/diff/x', 'GET', cab);
    ok(r.status === 404, `/diff/x → 404 (achei ${r.status})`);
  });
}

// ─── (c) puras do cliente (public/diff.js, sem DOM) — molde `carregarMapa` ─────────────────────

const vm = require('node:vm');
const PUBLIC_DIR = path.join(RAIZ_REPO, 'public');

function carregarDiffCliente() {
  const dados = new Map();
  const sandbox = {
    document: { getElementById: () => null },
    localStorage: { getItem: (k) => dados.get(k) ?? null, setItem: (k, v) => dados.set(k, v) },
    URLSearchParams,
    console,
  };
  const contexto = vm.createContext(sandbox);
  for (const arquivo of ['traducoes.js', 'i18n.js', 'diff.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, arquivo), 'utf8'), contexto, { filename: arquivo });
  }
  return contexto.cockpitDiff;
}

async function blocoC() {
  const m = carregarDiffCliente();

  ok(JSON.stringify(m.lerHash('#projeto=demo&commit=abc123')) === JSON.stringify({ projeto: 'demo', commit: 'abc123' }),
    `lerHash projeto+commit (achei ${JSON.stringify(m.lerHash('#projeto=demo&commit=abc123'))})`);
  ok(JSON.stringify(m.lerHash('#job=xyz')) === JSON.stringify({ job: 'xyz' }), 'lerHash job');
  ok(JSON.stringify(m.lerHash('#c=x')) === '{}', "lerHash('#c=x') → {} (chave estranha, do app)");
  ok(JSON.stringify(m.lerHash('')) === '{}', "lerHash('') → {}");
  for (const estado of [{ projeto: 'a&b' }, { projeto: 'demo', commit: 'sha com espaço' }, { job: 'id com ç' }]) {
    const ida = m.montarHash(estado);
    const volta = m.lerHash(ida);
    ok(JSON.stringify(volta) === JSON.stringify(estado), `ida-e-volta de ${JSON.stringify(estado)} (achei ${JSON.stringify(volta)})`);
  }
  ok(m.montarHash({ projeto: 'x', commit: 'y' }) === '#projeto=x&commit=y', `montarHash ordem fixa (achei ${m.montarHash({ projeto: 'x', commit: 'y' })})`);

  ok(JSON.stringify(m.separarCaminho('a/b/c.js')) === JSON.stringify({ nome: 'c.js', pasta: 'a/b/' }), 'separarCaminho com pasta');
  ok(JSON.stringify(m.separarCaminho('raiz.txt')) === JSON.stringify({ nome: 'raiz.txt', pasta: '' }), 'separarCaminho sem pasta');

  const trecho = { antes: 10, depois: 20, cabecalho: '', linhas: [' ctx', '-velha', '+nova'], longas: [] };
  const un = m.linhasUnificadas(trecho);
  ok(un[0].antes === 10 && un[0].depois === 20, `linhasUnificadas: contexto numerado nos dois lados (achei ${JSON.stringify(un[0])})`);
  ok(un[1].antes === 11 && un[1].depois === null, `linhasUnificadas: '-' só no antes (achei ${JSON.stringify(un[1])})`);
  ok(un[2].antes === null && un[2].depois === 21, `linhasUnificadas: '+' só no depois (achei ${JSON.stringify(un[2])})`);

  // Painel de execução (Codex #1): linha REMOVIDA que começa com "-- " vira "--- " e linha ADICIONADA
  // que começa com "++ " vira "+++ " — dentro do trecho são corpo, nunca cabeçalho de arquivo.
  {
    const patchSql = ['diff --git a/q.sql b/q.sql', 'index 1111111..2222222 100644', '--- a/q.sql', '+++ b/q.sql',
      '@@ -1,2 +1,2 @@', '--- comentario velho', '+++ comentario novo', ' select 1;', ''].join('\n');
    const [arqSql] = diff.parsearPatch(patchSql);
    ok(arqSql && arqSql.caminho === 'q.sql', `parsearPatch: "+++ " no CORPO não troca o caminho (achei ${arqSql && arqSql.caminho})`);
    ok(arqSql && arqSql.mais === 1 && arqSql.menos === 1, `parsearPatch: "--- "/"+++ " no corpo contam como linha (achei +${arqSql && arqSql.mais} -${arqSql && arqSql.menos})`);
    ok(arqSql && JSON.stringify(arqSql.trechos[0].linhas) === JSON.stringify(['--- comentario velho', '+++ comentario novo', ' select 1;']),
      `parsearPatch: as três linhas do trecho preservadas (achei ${arqSql && JSON.stringify(arqSql.trechos[0] && arqSql.trechos[0].linhas)})`);
  }

  // Conferência do orquestrador (19/10): a tela mostrava o tamanho JÁ CORTADO (4000), não o original.
  const unLonga = m.linhasUnificadas({ antes: 1, depois: 1, cabecalho: '', linhas: ['+abc'], longas: [{ i: 0, n: 5000 }] });
  ok(unLonga[0].longa === 5000, `linhasUnificadas: \`longa\` carrega o tamanho ORIGINAL da linha (achei ${JSON.stringify(unLonga[0].longa)})`);
  const cssDiff = fs.readFileSync(path.join(__dirname, '..', 'public', 'diff.css'), 'utf8');
  ok(!/\[data-quebrar\](?!=)/.test(cssDiff) && cssDiff.includes('[data-quebrar="1"]'), 'diff.css: "Quebrar linhas" casa só com data-quebrar="1" (o atributo vazio também casava [data-quebrar])');

  const trechoPar = { antes: 1, depois: 1, cabecalho: '', linhas: ['-a', '-b', '-c', '+x'], longas: [] };
  const pares = m.parearLados(trechoPar);
  ok(pares.length === 3, `parearLados: 3 '-' + 1 '+' → 3 linhas (achei ${pares.length})`);
  ok(pares.filter((p) => p.dir === null).length === 2, `parearLados: 2 com dir:null (achei ${pares.filter((p) => p.dir === null).length})`);
  ok(pares[0].dir !== null && pares[0].dir.texto === 'x', `parearLados: a 1ª remoção pareia com a adição (achei ${JSON.stringify(pares[0])})`);

  ok(m.dobraEntre(null, { depois: 5, linhas: [] }) === 4, `dobraEntre antes do 1º trecho (achei ${m.dobraEntre(null, { depois: 5, linhas: [] })})`);
  const anteriorTrecho = { antes: 1, depois: 1, linhas: [' a', ' b'] };
  ok(m.dobraEntre(anteriorTrecho, { depois: 10, linhas: [] }) === 7, `dobraEntre entre dois trechos (achei ${m.dobraEntre(anteriorTrecho, { depois: 10, linhas: [] })})`);

  const trechos401 = [{ linhas: new Array(401).fill(' x') }];
  const trechos400 = [{ linhas: new Array(400).fill(' x') }];
  ok(m.modoDoArquivo({ trechos: trechos401 }) === 'trechos', `modoDoArquivo 401 linhas → trechos (achei ${m.modoDoArquivo({ trechos: trechos401 })})`);
  ok(m.modoDoArquivo({ trechos: trechos400 }) === 'cheio', `modoDoArquivo 400 linhas → cheio (achei ${m.modoDoArquivo({ trechos: trechos400 })})`);
  ok(m.modoDoArquivo({ binario: true, trechos: [] }) === 'binario', 'modoDoArquivo binário');
  ok(m.modoDoArquivo({ semCorpo: 'cortado', trechos: [] }) === 'cortado', 'modoDoArquivo sem corpo');
}

// ─── (d) varredura por innerHTML etc. ───────────────────────────────────────────────────────────

async function blocoD() {
  for (const arquivo of ['diff.js', 'diff-entrada.js']) {
    const fonte = fs.readFileSync(path.join(PUBLIC_DIR, arquivo), 'utf8')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const proibido of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      ok(!fonte.includes(proibido), `public/${arquivo} sem ${proibido}`);
    }
  }
}

async function principal() {
  const f = montarFixture();
  await bloco('(a) lib/diff.js — parser contra git REAL (novo, apagado, renomeado, binário, modo, merge, corte, timeout)', () => blocoA(f));
  await bloco('(e) paginação com topo fixo + corrida do job (depoisDeResolver)', () => blocoE(f));

  const fx = montarFixtureRotas();
  await bloco('(b) rotas — GET /api/diff/commits, /api/diff/commit, /api/diff/job e a casca /diff/', () => blocoB(fx));

  await bloco('(c) puras do cliente (public/diff.js, sem DOM)', blocoC);
  await bloco('(d) varredura do fonte por innerHTML/outerHTML/insertAdjacentHTML/document.write', blocoD);

  console.log(`\n${passou}/${total} asserções`);
  console.log(vermelho ? '\n❌ GATE VERMELHO' : '\n✅ GATE VERDE — diff de commit e de job');
  process.exitCode = vermelho ? 1 : 0;
}

principal();
