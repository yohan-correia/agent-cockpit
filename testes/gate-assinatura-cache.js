#!/usr/bin/env node
'use strict';
// GATE da assinatura do cache de uso — card `assinatura-do-cache-guarda-conteudo-em-hex`.
//
// O defeito: `assinaturaDe` (lib/uso.js) devolve os até-256 bytes que TERMINAM no offset, em
// hex — reversível — e eles iam gravados no ~/.cockpit/uso/cache.json. O G10 do gate-uso.js
// procura o segredo LITERAL (em hex ele não aparece) e o G26 só olha NOMES de chave (e
// `assinatura` é permitida). Os dois aprovavam um cache que contém conteúdo de conversa.
//
// Por isso o segredo aqui vai NOS ÚLTIMOS 256 BYTES do arquivo: no meio ele não entra na
// assinatura e o caso não provaria nada.
//
// Offline, sem gastar token: HOME falso em mkdtemp. O caso S4 sobe `server.js` de verdade em
// processo FILHO (nunca por `require`, que subiria na 7879), em porta 7890-7898, nunca 7899.
//
// Uso:  node testes/gate-assinatura-cache.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

let falhas = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas += 1; return cond; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-assinatura-cache-'));
const HOME = path.join(RAIZ, 'home');
const PROJETOS = path.join(HOME, '.claude', 'projects');
// A10 (testes/gate-jobs-disco.js) exige COCKPIT_JOBS_DIR de todo teste que mencione server.js.
const DIR_JOBS = path.join(RAIZ, 'jobs');
const CERT_DIR_VAZIO = path.join(RAIZ, 'cert-vazio');
for (const d of [PROJETOS, DIR_JOBS, CERT_DIR_VAZIO]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.COCKPIT_JOBS_DIR = DIR_JOBS;
process.env.COCKPIT_USO_DIR = path.join(RAIZ, 'uso-1');

const LIB_USO = path.join(__dirname, '..', 'lib', 'uso.js');
let uso = require(LIB_USO);
function recarregarUso(dirCache) {
  process.env.COCKPIT_USO_DIR = dirCache;
  delete require.cache[LIB_USO];
  uso = require(LIB_USO);
}

const SEGREDO = 'SEGREDO-NA-CAUDA-NAO-PODE-VAZAR';
const HEX_SEGREDO = Buffer.from(SEGREDO, 'utf8').toString('hex');
const PRE_PROJETO = `${path.join(HOME, 'projetos').replace(/[^a-zA-Z0-9]/g, '-')}-`;

/** Um .jsonl cuja ÚLTIMA linha traz o segredo — ele cai dentro dos 256 bytes finais. */
function jsonlComSegredoNaCauda(nome) {
  const pasta = path.join(PROJETOS, PRE_PROJETO + nome);
  fs.mkdirSync(pasta, { recursive: true });
  const arq = path.join(pasta, 'a.jsonl');
  const linha = (texto) => `${JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { model: 'claude-opus-5', usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: texto }] },
  })}\n`;
  const conteudo = linha('x'.repeat(2000)) + linha(SEGREDO);
  fs.writeFileSync(arq, conteudo);
  const cauda = Buffer.from(conteudo).subarray(-256).toString('utf8');
  return { arq, conteudo, caudaTemSegredo: cauda.includes(SEGREDO) };
}

/** O cache no formato VELHO (v2): assinatura = hex cru dos 256 bytes finais do arquivo. */
function gravarCacheV2(dirCache, arq) {
  const bytes = fs.readFileSync(arq);
  const st = fs.statSync(arq);
  fs.mkdirSync(dirCache, { recursive: true });
  fs.writeFileSync(path.join(dirCache, 'cache.json'), JSON.stringify({
    versao: 2,
    arquivos: [{ caminho: arq, offset: bytes.length, ino: st.ino, assinatura: bytes.subarray(-256).toString('hex'), ignoradas: {}, mtimeMs: st.mtimeMs, dias: {} }],
  }));
}

/** Tudo o que o cache.json revela: o texto cru e cada assinatura DECODIFICADA como hex. */
function vazaNoCache(caminhoCache) {
  const texto = fs.readFileSync(caminhoCache, 'utf8');
  if (texto.includes(SEGREDO) || texto.includes(HEX_SEGREDO)) return true;
  const dados = JSON.parse(texto);
  return (dados.arquivos || []).some((a) => /^[0-9a-f]*$/.test(a.assinatura || '')
    && Buffer.from(a.assinatura, 'hex').toString('utf8').includes(SEGREDO));
}

const RE_SHA256 = /^[0-9a-f]{64}$/;

function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => (linha.trim().split(/\s+/)[3] || '').endsWith(`:${porta}`));
  } catch {
    return true;
  }
}

async function principal() {
  console.log('\nS1. segredo nos ÚLTIMOS 256 bytes do .jsonl não vai para o cache.json — nem em hex');
  const s1 = jsonlComSegredoNaCauda('s1');
  ok(s1.caudaTemSegredo, 'pré-condição: o segredo está dentro dos 256 bytes finais do arquivo');
  const r1 = await uso.relatorio({ dias: 1 });
  const p1 = r1.projetos.find((p) => p.projeto === 's1');
  ok(p1 && p1.total.entrada === 14, `o arquivo continua sendo contado: entrada=14 (veio ${p1 && p1.total.entrada})`);
  const cache1 = path.join(process.env.COCKPIT_USO_DIR, 'cache.json');
  ok(!vazaNoCache(cache1), 'o cache.json não contém o segredo — nem literal, nem hex, nem hex decodificado');

  console.log('\nS2. toda assinatura gravada tem a FORMA de sha256 (64 hex) — não 512 hex de conteúdo');
  const d1 = JSON.parse(fs.readFileSync(cache1, 'utf8'));
  const formas = d1.arquivos.map((a) => a.assinatura);
  ok(formas.length > 0 && formas.every((s) => RE_SHA256.test(s)), `assinaturas: ${JSON.stringify(formas.map((s) => `${s.length} chars`))}`);
  ok(d1.versao === uso.VERSAO_CACHE && uso.VERSAO_CACHE >= 3, `VERSAO_CACHE subiu (gravado ${d1.versao}, constante ${uso.VERSAO_CACHE}) — um cache v2 não é mais lido`);

  console.log('\nS3. cache v2 VELHO em disco: a 1ª varredura SOBRESCREVE o arquivo inteiro');
  const dirS3 = path.join(RAIZ, 'uso-3');
  gravarCacheV2(dirS3, s1.arq);
  ok(vazaNoCache(path.join(dirS3, 'cache.json')), 'controle: o cache v2 fabricado VAZA (o detector enxerga o formato velho)');
  recarregarUso(dirS3);
  const r3 = await uso.relatorio({ dias: 1 });
  const p3 = r3.projetos.find((p) => p.projeto === 's1');
  ok(p3 && p3.total.entrada === 14, `revarreu do zero, sem somar em cima do velho: entrada=14 (veio ${p3 && p3.total.entrada})`);
  ok(!vazaNoCache(path.join(dirS3, 'cache.json')), 'depois da varredura o cache.json não vaza mais');
  ok(JSON.stringify(fs.readdirSync(dirS3)) === '["cache.json"]', `a pasta só tem o cache novo (veio ${JSON.stringify(fs.readdirSync(dirS3))})`);

  console.log('\nS4. o BOOT do servidor apaga o cache de outra versão — sem esperar ninguém abrir /api/uso');
  const dirS4 = path.join(RAIZ, 'uso-4');
  gravarCacheV2(dirS4, s1.arq);
  const PORTA = Number(process.env.PORT) || [7896, 7895, 7893, 7890].find(portaLivre);
  if (!ok(PORTA >= 7890 && PORTA <= 7898, `porta ${PORTA} na faixa 7890-7898 (nunca 7879 nem 7899)`)) return;
  const filho = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORTA), HOST: '127.0.0.1', COCKPIT_CERT_DIR: CERT_DIR_VAZIO,
      COCKPIT_JOBS_DIR: DIR_JOBS, COCKPIT_USO_DIR: dirS4,
      COCKPIT_TMUX_SOCKET: `gate-assinatura-cache-${process.pid}`, COCKPIT_VIGIA_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const subiu = await new Promise((resolve) => {
      filho.once('exit', () => resolve(false));
      filho.stdout.on('data', (d) => { if (String(d).includes('cockpit-agentes em')) resolve(true); });
      setTimeout(() => resolve(false), 5000);
    });
    ok(subiu, 'server.js subiu');
    await espera(300);
    const existe = fs.existsSync(path.join(dirS4, 'cache.json'));
    ok(!existe || !vazaNoCache(path.join(dirS4, 'cache.json')), `o cache v2 com hex sumiu no boot (existe=${existe})`);
  } finally {
    // pelo PID — nunca pkill (#19) — e ESPERA o exit: o `rmSync` do fim tiraria o HOME de
    // baixo de um filho ainda vivo, que seguraria a porta (#24).
    if (filho.exitCode === null) { filho.kill('SIGTERM'); await once(filho, 'exit'); }
  }

  console.log('\nS5. o descarte do boot NÃO apaga um cache da versão ATUAL (senão todo boot revarre 729 MB)');
  const dirS5 = path.join(RAIZ, 'uso-5');
  recarregarUso(dirS5);
  await uso.relatorio({ dias: 1 });
  const antes = fs.readFileSync(path.join(dirS5, 'cache.json'), 'utf8');
  ok(typeof uso.descartarCacheDeOutraVersao === 'function', 'lib/uso.js exporta descartarCacheDeOutraVersao');
  if (typeof uso.descartarCacheDeOutraVersao === 'function') await uso.descartarCacheDeOutraVersao();
  const depois = fs.existsSync(path.join(dirS5, 'cache.json')) ? fs.readFileSync(path.join(dirS5, 'cache.json'), 'utf8') : null;
  ok(depois === antes, 'o cache atual continua lá, byte a byte');

  console.log('\nS6. o descarte NÃO apaga um cache de versão MAIS NOVA (deploy futuro × worktree velha, R2)');
  const dirS6 = path.join(RAIZ, 'uso-6');
  fs.mkdirSync(dirS6, { recursive: true });
  const futuro = JSON.stringify({ versao: 999, arquivos: [] });
  fs.writeFileSync(path.join(dirS6, 'cache.json'), futuro);
  recarregarUso(dirS6);
  ok(typeof uso.descartarCacheDeOutraVersao === 'function', 'lib/uso.js exporta descartarCacheDeOutraVersao');
  if (typeof uso.descartarCacheDeOutraVersao === 'function') await uso.descartarCacheDeOutraVersao();
  const lido = fs.existsSync(path.join(dirS6, 'cache.json')) ? fs.readFileSync(path.join(dirS6, 'cache.json'), 'utf8') : null;
  ok(lido === futuro, 'o cache v999 continua lá, byte a byte');

  console.log('\nS7. com a assinatura hasheada, a varredura continua INCREMENTAL (append lê só o delta)');
  const dirS7 = path.join(RAIZ, 'uso-7');
  recarregarUso(dirS7);
  const s7 = jsonlComSegredoNaCauda('s7');
  const a = await uso.relatorio({ dias: 1 });
  ok(a.leitura.relidos >= 1, `1ª varredura leu o arquivo (relidos=${a.leitura.relidos})`);
  const quieta = await uso.relatorio({ dias: 1 });
  ok(quieta.leitura.relidos === 0 && quieta.leitura.bytesLidos === 0,
    `sem mudança: nada relido (relidos=${quieta.leitura.relidos}, bytesLidos=${quieta.leitura.bytesLidos})`);
  const extra = `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } })}\n`;
  fs.appendFileSync(s7.arq, extra);
  const depoisAppend = await uso.relatorio({ dias: 1 });
  const p7 = depoisAppend.projetos.find((p) => p.projeto === 's7');
  ok(depoisAppend.leitura.bytesLidos === Buffer.byteLength(extra),
    `append: leu SÓ o delta — bytesLidos=${depoisAppend.leitura.bytesLidos}, delta=${Buffer.byteLength(extra)} (arquivo inteiro=${fs.statSync(s7.arq).size})`);
  ok(p7 && p7.total.entrada === 19, `soma certa depois do append: 7+7+5=19 (veio ${p7 && p7.total.entrada})`);
}

principal()
  .catch((e) => { falhas += 1; console.log(`  ❌ o gate estourou — ${e && e.stack}`); })
  .finally(() => {
    fs.rmSync(RAIZ, { recursive: true, force: true });
    console.log(falhas === 0 ? '\n✅ GATE VERDE — assinatura do cache' : `\n❌ GATE VERMELHO — ${falhas} falha(s)`);
    process.exit(falhas === 0 ? 0 : 1);
  });
