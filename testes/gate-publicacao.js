#!/usr/bin/env node
'use strict';
// GATE da trava de conteúdo do `bin/prepara-publicacao.js` (a regex `denied`).
//
// A trava roda em TODO arquivo exportado, e um deles é a fixture
// `testes/fixtures/rollout-codex/2026/09/22/rollout-corrompido.jsonl`: uma linha de 1,1 milhão de
// caracteres sem ponto, de propósito. Com `[a-z0-9-]+\.ts\.net` a busca é quadrática nessa
// sequência (medido em 08/10/2026: 10k → 238 ms, 20k → 939 ms, 40k → 3756 ms; a fixture levaria
// ~47 min) e a publicação parece travada. O rótulo de domínio tem no máximo 63 caracteres, então
// `{1,63}` deixa a busca linear sem deixar de pegar nenhum `*.ts.net`.
//
// A regex é lida como TEXTO do script: o script não exporta nada e roda tudo no topo.
//
// Uso:  node testes/gate-publicacao.js

const fs = require('node:fs');
const path = require('node:path');

let falhas = 0;
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };

const fonte = fs.readFileSync(path.join(__dirname, '..', 'bin', 'prepara-publicacao.js'), 'utf8');
const literal = fonte.match(/^const denied = (\/.*\/i);$/m);
if (!ok(Boolean(literal), 'achei `const denied = /…/i;` no bin/prepara-publicacao.js')) {
  console.log('\n❌ GATE VERMELHO — publicação\n');
  process.exit(1);
}
const denied = new Function(`return ${literal[1]};`)();
const ms = (texto) => {
  const t0 = process.hrtime.bigint();
  denied.test(texto);
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

console.log('\n── a trava é linear na sequência sem ponto ──\n');
const t40k = ms('a'.repeat(40000));
const linear = ok(t40k < 500, `40 mil caracteres seguidos em menos de 500 ms (levou ${t40k.toFixed(1)} ms)`);
// Só com a pequena verde: a de hoje levaria ~47 min aqui, e o gate tem de reprovar rápido.
if (linear) {
  const bruto = fs.readFileSync(path.join(__dirname, 'fixtures', 'rollout-codex', '2026', '09', '22', 'rollout-corrompido.jsonl'));
  const texto = bruto.toString('utf8').replace(/\\([/.])/g, '$1'); // o mesmo preparo do script
  const tFix = ms(texto);
  ok(tFix < 3000, `a fixture real de ${texto.length} caracteres em menos de 3 s (levou ${tFix.toFixed(1)} ms)`);
} else {
  ok(false, 'a fixture real nem roda: a sequência de 40 mil já reprovou');
}

console.log('\n── continua pegando o que tem de pegar ──\n');
// Montados em tempo de execução: escritos por extenso, eles fariam a própria trava recusar
// exportar este arquivo (ele vai junto, em testes/).
const j = (...partes) => partes.join('');
const tsnet = j('.ts', '.net');
for (const s of [
  j('maquina.exemplo123', tsnet),
  j('https://MAQUINA.TAILABC12', tsnet.toUpperCase(), ':7879/app.js'),
  j('x', tsnet),
  j('a'.repeat(100), tsnet), // rótulo maior que 63: a busca acha os últimos 63
  ['100', '64', '0', '1'].join('.'),
  j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'),
  j('gh', 'p_', 'A'.repeat(36)),
  j('sk-', 'ant-', 'b'.repeat(40)),
]) ok(denied.test(s), `bloqueia ${JSON.stringify(s.length > 50 ? `${s.slice(0, 20)}…${s.slice(-12)}` : s)}`);

const proprio = fs.readFileSync(__filename, 'utf8').replace(/\\([/.])/g, '$1');
ok(!denied.test(proprio), 'este próprio arquivo passa na trava (vai na cópia pública)');

console.log('\n── não bloqueia o que é inofensivo ──\n');
for (const s of ['a'.repeat(5000), 'https://exemplo.com/ts/net', '100.200.1.1', 'tailscale serve --https=443'])
  ok(!denied.test(s), `deixa passar ${JSON.stringify(s.length > 50 ? `${s.slice(0, 20)}…` : s)}`);

// ─── A lista de termos proibidos (D78) — o script DE VERDADE, num repo-fixture ─────────────────
//
// A lista mora FORA do repo (ela tem nome de cliente). Cada caso monta um repo git num mkdtemp
// com os arquivos obrigatórios da raiz e uma cópia do `bin/prepara-publicacao.js`, e roda o
// script com `HOME` e `COCKPIT_PUBLICACAO_PROIBIDOS` SEMPRE dentro do mkdtemp — nunca a lista
// real nem o HOME real (#57/#78). Os termos são fictícios: este arquivo vai na cópia pública e
// tem de passar na lista de verdade. O repo-fixture tem um arquivo obrigatório chamado como o do
// servidor, vazio; nada aqui sobe processo de servidor (exceção nas redes A10 e M-rede).
console.log('\n── a lista de termos proibidos (o script de verdade, num repo-fixture) ──\n');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const SCRIPT = path.join(__dirname, '..', 'bin', 'prepara-publicacao.js');
const OBRIGATORIOS = ['README.md', 'README.en.md', 'ROADMAP.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md',
  'CONTRIBUTING.md', 'CHANGELOG.md', 'package.json', '.env.example', '.gitignore', 'server.js'];
const GRANDE = path.join(__dirname, 'fixtures', 'rollout-codex', '2026', '09', '22', 'rollout-corrompido.jsonl');

// `arquivos` é objeto ou função do HOME falso (o P12/P14 precisam do caminho dele no conteúdo).
// `lista`: texto da lista (undefined = sem env, e o HOME falso não tem `~/.cockpit/`).
function cenario({ arquivos = {}, symlinks = {}, copias = {}, lista, sem = [] }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-publicacao-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const destino = path.join(base, 'destino');
  fs.mkdirSync(home, { recursive: true });
  const escrever = (rel, conteudo) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), conteudo);
  };
  for (const f of OBRIGATORIOS) if (!sem.includes(f)) escrever(f, f === 'LICENSE' ? 'MIT License\n\nCopyright (c) 2026 Fulano\n' : f === 'package.json' ? '{}\n' : f === '.gitignore' ? 'node_modules/\n' : `${f}\n`);
  escrever('bin/prepara-publicacao.js', fs.readFileSync(SCRIPT));
  for (const [rel, conteudo] of Object.entries(typeof arquivos === 'function' ? arquivos(home) : arquivos)) escrever(rel, conteudo);
  for (const [rel, origem] of Object.entries(copias)) escrever(rel, fs.readFileSync(origem));
  for (const [rel, alvo] of Object.entries(symlinks)) fs.symlinkSync(alvo, path.join(repo, rel));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@example.com', ...a], { cwd: repo, stdio: 'ignore' });
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture');
  const env = { ...process.env, HOME: home };
  delete env.COCKPIT_PUBLICACAO_PROIBIDOS;
  if (lista !== undefined) {
    env.COCKPIT_PUBLICACAO_PROIBIDOS = path.join(base, 'lista.txt');
    fs.writeFileSync(env.COCKPIT_PUBLICACAO_PROIBIDOS, lista);
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(repo, 'bin', 'prepara-publicacao.js'), destino], { env, encoding: 'utf8' });
  const res = { rc: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0, existe: fs.existsSync(destino), destino, home };
  // A lista do que saiu é lida ANTES de apagar o mkdtemp; depois do `rmSync` tudo daria "não exportou".
  const saiu = new Set(res.existe ? fs.readdirSync(destino, { recursive: true }).map((f) => f.split(path.sep).join('/')) : []);
  res.exportou = (rel) => saiu.has(rel);
  fs.rmSync(base, { recursive: true, force: true });
  return res;
}
const recusou = (r) => r.rc !== 0 && !r.existe;
const cita = (r, ...trechos) => trechos.every((t) => r.out.includes(t));

{
  const r = cenario({ lista: 'fulano-ficticio\n', arquivos: { 'lib/a.js': '// fala do fulano-ficticio\n' } });
  ok(recusou(r) && cita(r, 'lib/a.js', 'fulano-ficticio'), `P1: termo da lista em lib/ → recusa citando arquivo e termo, sem destino (rc ${r.rc})`);
}
{
  const chave = j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----');
  const r = cenario({ lista: 'fulano-ficticio\ncliente-exemplo\n', arquivos: {
    'lib/a.js': '// fulano-ficticio\n', 'testes/b.js': '// cliente-exemplo\n', 'public/c.js': `// ${chave}\n` } });
  ok(recusou(r) && cita(r, 'lib/a.js', 'testes/b.js', 'public/c.js'), `P2: três arquivos recusados numa execução só (rc ${r.rc})`);
  ok(!r.out.includes('PRIVATE KEY'), 'P2: o trecho que casou com o padrão sensível NÃO aparece na saída');
}
{
  const r = cenario({ lista: 'fulano-ficticio\n', arquivos: { 'docs/superpowers/x.md': 'fulano-ficticio\n' } });
  ok(r.rc === 0 && r.existe && !r.exportou('docs/superpowers/x.md'), `P3: termo só fora da whitelist → exporta (rc ${r.rc})`);
}
{
  const r = cenario({});
  ok(recusou(r) && cita(r, path.join(r.home, '.cockpit', 'publicacao-proibidos.txt'), 'COCKPIT_PUBLICACAO_PROIBIDOS'),
    `P4: sem lista → recusa dizendo onde criar, sem destino (rc ${r.rc})`);
}
{
  const r = cenario({ lista: '# só comentário\n\n   \n' });
  ok(recusou(r) && cita(r, 'COCKPIT_PUBLICACAO_PROIBIDOS'), `P5: lista sem termo → recusa como ausente (rc ${r.rc})`);
}
{
  const r = cenario({ lista: 'Cliente-Ficticio\n', arquivos: { 'lib/a.js': '// CLIENTE-FICTÍCIO\n' } });
  ok(recusou(r) && cita(r, 'lib/a.js'), `P6: sem caixa e sem acento (rc ${r.rc})`);
}
{
  const r = cenario({ lista: 'fulano\n' });
  ok(r.rc === 0 && r.exportou('LICENSE'), `P7a: o titular na linha Copyright do LICENSE não recusa (rc ${r.rc}) ${r.rc ? r.out.slice(0, 200) : ''}`);
  const r2 = cenario({ lista: 'fulano\n', arquivos: { 'README.md': 'feito por Fulano\n' } });
  ok(recusou(r2) && cita(r2, 'README.md'), `P7b: o mesmo nome no README recusa (rc ${r2.rc})`);
}
{
  const r = cenario({ lista: 'fulano-ficticio\n', arquivos: { 'testes/fulano-ficticio.js': '// nada\n' } });
  ok(recusou(r) && cita(r, 'testes/fulano-ficticio.js'), `P8: termo só no NOME do arquivo recusa (rc ${r.rc})`);
}
{
  const r = cenario({ lista: 'fulano-ficticio\n', arquivos: { 'testes/prova-revisar-oraculo.sh': '# fulano-ficticio\n' } });
  ok(r.rc === 0 && r.existe && !r.exportou('testes/prova-revisar-oraculo.sh'),
    `P9: o script do oráculo fica fora do export (rc ${r.rc}, exportou ${r.exportou('testes/prova-revisar-oraculo.sh')})`);
}
{
  const r = cenario({ lista: 'fulano-ficticio\n', arquivos: { 'lib/a.js': '// fulano-ficticio\n' }, symlinks: { 'lib/link.js': '../README.md' } });
  ok(recusou(r) && cita(r, 'lib/link.js', 'lib/a.js'), `P10: symlink recusa junto com o termo de outro arquivo (rc ${r.rc})`);
}
{
  const r = cenario({ lista: 'fulano-ficticio\n', arquivos: { 'lib/x.pem': 'nada\n' } });
  ok(recusou(r) && cita(r, 'lib/x.pem'), `P11: extensão privada recusa (rc ${r.rc})`);
}
{
  const r = cenario({ lista: 'fulano-ficticio\n', arquivos: (home) => ({ 'public/d.js': `// ${home}/algo\n` }) });
  ok(recusou(r) && cita(r, 'public/d.js'), `P12: caminho do HOME no conteúdo recusa (rc ${r.rc})`);
}
{
  const r = cenario({ lista: 'fulano-ficticio\n', sem: ['ROADMAP.md'] });
  ok(recusou(r) && cita(r, 'ROADMAP.md'), `P13: obrigatório ausente recusa citando o arquivo (rc ${r.rc})`);
}
{
  const r = cenario({ lista: 'fulano-ficticio\n', arquivos: (home) => ({ LICENSE: `MIT License\n\nCopyright (c) 2026 ${home}\n` }) });
  ok(recusou(r) && cita(r, 'LICENSE'), `P14: a exceção do Copyright é só da lista — o HOME ali recusa (rc ${r.rc})`);
}
{
  const termos = ['termo-um', 'termo-dois', 'termo-tres', 'termo-quatro', 'termo-cinco', 'termo-seis', 'termo-sete', 'termo-oito'];
  const r = cenario({ lista: `${termos.join('\n')}\n`, copias: { 'testes/grande.jsonl': GRANDE } });
  ok(r.rc === 0 && r.ms < 10000, `P15: 1,1 MB com 8 termos exporta em menos de 10 s (rc ${r.rc}, ${r.ms} ms)`);
}

console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — publicação\n`);
process.exit(falhas === 0 ? 0 : 1);
