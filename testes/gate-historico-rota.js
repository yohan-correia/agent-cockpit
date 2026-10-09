#!/usr/bin/env node
'use strict';
// GATE DA ROTA — `GET /api/historico` (card `carregar-mais-historico`, Fase 2 do plano
// 2026-09-16). Cópia-e-poda de `testes/gate-jobs-rota.js`: mesmo molde de portas (7891-7898,
// com a checagem de faixa que aborta fora dela), servidor de verdade por `require` em
// processo, socket tmux próprio derivado do pid.
//
// A rota tem DOIS ramos — aba (Claude/Codex) e job — e só o ramo de job lê o disco de
// verdade (`COCKPIT_JOBS_DIR`). O ramo de aba depende de `abas.buscar(chave)`, que por sua
// vez varre o tmux (`lib/abas.js:listar`) — sem tmux de verdade aqui (D35, armadilha #20),
// `lib/abas` é trocado por um duble no `require.cache` ANTES de o servidor subir, exatamente
// como `testes/gate-multiplex.js` e `testes/gate-troca-arquivo.js` já fazem: só `buscar` é
// substituído, o resto do módulo continua real.
//
// Uso:  node testes/gate-historico-rota.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };
let falhas = 0;

// ─── Portas — 7891-7898, nunca 7879 (produção) nem 7899 (gate dos jobs do orquestrador, #24).
// 7892, não 7891: o `gate-jobs-rota.js` já usa a 7891 e a suíte pode um dia rodar em paralelo.

function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => {
      const campos = linha.trim().split(/\s+/);
      return (campos[3] || '').endsWith(`:${porta}`);
    });
  } catch {
    return true; // `ss` indisponível — o `listen()` denuncia se a porta estiver ocupada
  }
}

const PORTA_SERVIDOR = Number(process.env.PORT || 7892);

for (const p of [PORTA_SERVIDOR]) {
  if (p < 7891 || p > 7898) {
    console.error(`🔴 porta ${p} fora da faixa 7891-7898 — nunca 7879 (produção) nem 7899 (#24).`);
    process.exit(2);
  }
  if (!portaLivre(p)) {
    console.error(`🔴 a porta ${p} já está ocupada (conferido com \`ss -H -lptn\`). Tente outra.`);
    process.exit(1);
  }
}

// ─── tmux — socket PRÓPRIO, nunca o `main` do usuário (D35) — mesmo cinto e suspensório do
// molde, mesmo o ramo de aba não tocando tmux de verdade neste gate (o duble cobre isso).

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(2);
}
const SOCKET_TMUX = `gate-historico-rota-${process.pid}`;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── fixtures em mkdtemp, HOME falso ────────────────────────────────────────────────────────

const HOME_FALSO = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-historico-rota-home-'));
process.env.HOME = HOME_FALSO;
os.homedir = () => HOME_FALSO;

const CERT_DIR_VAZIO = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-historico-rota-cert-'));
const RAIZ_JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-historico-rota-jobs-'));
const RAIZ_CONVERSAS = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-historico-rota-conversas-'));

// ─── o duble de lib/abas.js — só `buscar` muda, o resto do módulo continua real ────────────

const CAMINHO_ABAS = path.join(__dirname, '..', 'lib', 'abas.js');
const abasVivas = new Map(); // chave -> { arquivo, agente, sessaoId }

const duble = {
  ...require(CAMINHO_ABAS),
  buscar: async (chave) => (abasVivas.has(chave) ? { chave, ...abasVivas.get(chave) } : null),
};
require.cache[require.resolve(CAMINHO_ABAS)] = {
  id: require.resolve(CAMINHO_ABAS),
  filename: require.resolve(CAMINHO_ABAS),
  loaded: true,
  exports: duble,
};

// ─── as peças das fixtures de conversa (molde de `testes/gate-externo-blocos.js`) ──────────

const linha = (o) => `${JSON.stringify(o)}\n`;
const humano = (t) => linha({ type: 'user', timestamp: '2026-09-02T00:00:00.000Z', message: { content: t } });
const agente = (t) => linha({ type: 'assistant', timestamp: '2026-09-02T00:00:01.000Z', message: { content: [{ type: 'text', text: t }] } });

/** `n` mensagens numeradas, o bastante para passar de 64 KB e cortar pelo ALVO (80). */
function conversaGrande(n, padding) {
  let c = '';
  for (let i = 0; i < n; i += 1) {
    const texto = `M${String(i).padStart(5, '0')}${'x'.repeat(padding)}`;
    c += (i % 2 === 0) ? humano(texto) : agente(texto);
  }
  return c;
}

let seqArquivo = 0;
function novaConversa(conteudo) {
  const caminho = path.join(RAIZ_CONVERSAS, `conversa-${seqArquivo += 1}.jsonl`);
  fs.writeFileSync(caminho, conteudo);
  return caminho;
}

function registrarAba(chave, { arquivo = null, agente: ag = 'claude', sessaoId = null } = {}) {
  abasVivas.set(chave, { arquivo, agente: ag, sessaoId });
}

function plantarJob(id, conteudo) {
  const dir = path.join(RAIZ_JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude.log'), conteudo);
}

function pedir(caminho) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORTA_SERVIDOR, path: caminho }, (res) => {
      let corpo = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, corpo: JSON.parse(corpo) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── os casos ───────────────────────────────────────────────────────────────────────────────

async function testeChaveInvalida() {
  const r = await pedir('/api/historico?chave=tem%20espaco&ate=10');
  ok(r.status === 400, `chave inválida (com espaço) ⇒ 400 (veio ${r.status})`);
}

async function testesAteInvalido() {
  registrarAba('aba-ate', { arquivo: novaConversa(humano('oi')) });
  const casos = [
    ['ausente', '/api/historico?chave=aba-ate'],
    ['zero', '/api/historico?chave=aba-ate&ate=0'],
    ['negativo', '/api/historico?chave=aba-ate&ate=-5'],
    ['não-inteiro', '/api/historico?chave=aba-ate&ate=12.5'],
    ['string que não converte', '/api/historico?chave=aba-ate&ate=abc'],
  ];
  for (const [rotulo, caminho] of casos) {
    const r = await pedir(caminho);
    ok(r.status === 400, `ate ${rotulo} ⇒ 400 (veio ${r.status})`);
  }
}

async function testeIdDeJobInvalido() {
  // Passa na régua da CHAVE (/^[\w-]+$/, aceita maiúscula) mas falha na régua de `idValido`
  // do módulo do job (/^[0-9a-z-]+$/, só minúscula) — a segunda trava, exercitada de verdade.
  const r = await pedir('/api/historico?chave=job-IDInvalido&ate=10');
  ok(r.status === 400, `id de job inválido (maiúsculas) ⇒ 400 (veio ${r.status})`);
}

async function testeChaveQueNaoExiste() {
  const r = await pedir('/api/historico?chave=aba-fantasma&ate=10');
  ok(r.status === 404, `chave que não existe ⇒ 404 (veio ${r.status})`);
}

async function testeArquivoQueSumiu() {
  registrarAba('aba-sumida', { arquivo: path.join(RAIZ_CONVERSAS, 'nunca-existiu.jsonl') });
  const r = await pedir('/api/historico?chave=aba-sumida&ate=10');
  ok(r.status === 404, `arquivo que sumiu (stat falha) ⇒ 404, não 200 mentiroso (veio ${r.status})`);
}

async function testeAteMaiorQueArquivo() {
  const caminho = novaConversa(humano('oi') + agente('ola'));
  const tamanho = fs.statSync(caminho).size;
  registrarAba('aba-pequena', { arquivo: caminho });
  const r = await pedir(`/api/historico?chave=aba-pequena&ate=${tamanho + 1000}`);
  ok(r.status === 409, `ate > info.size ⇒ 409 (veio ${r.status})`);
  ok(r.corpo && r.corpo.erro === 'a conversa mudou', `e o erro diz "a conversa mudou" (veio ${JSON.stringify(r.corpo)})`);
}

async function testeArquivoEncolheu() {
  // O `/clear` troca o arquivo por um menor, na MESMA chave (armadilha #33): a âncora que a
  // tela guardava (`ate`, de quando o arquivo era grande) aponta para além do fim do arquivo
  // novo. É o mesmo código de `ate > info.size`, exercitado pelo cenário que o motiva.
  const caminho = novaConversa(conversaGrande(50, 100));
  const tamanhoGrande = fs.statSync(caminho).size;
  registrarAba('aba-encolheu', { arquivo: caminho });
  fs.writeFileSync(caminho, humano('conversa nova, bem menor'));
  const tamanhoNovo = fs.statSync(caminho).size;
  ok(tamanhoNovo < tamanhoGrande, `pré-condição — o arquivo encolheu (${tamanhoNovo} < ${tamanhoGrande})`);
  const r = await pedir(`/api/historico?chave=aba-encolheu&ate=${tamanhoGrande}`);
  ok(r.status === 409, `arquivo encolheu: a âncora velha ⇒ 409, não a cauda duplicada (veio ${r.status})`);
}

async function testeSessaoQueNaoBate() {
  registrarAba('aba-sessao', { arquivo: novaConversa(humano('oi')), sessaoId: 'sess-nova' });
  const r = await pedir('/api/historico?chave=aba-sessao&ate=5&sessao=sess-velha');
  ok(r.status === 409, `sessao que não bate ⇒ 409 (veio ${r.status})`);
}

async function testeDuzentosComEventosEInicio() {
  const caminho = novaConversa(conversaGrande(400, 220));
  const tamanho = fs.statSync(caminho).size;
  registrarAba('aba-grande', { arquivo: caminho });
  const r = await pedir(`/api/historico?chave=aba-grande&ate=${tamanho}`);
  ok(r.status === 200, `200 com eventos (veio ${r.status})`);
  ok(Array.isArray(r.corpo.eventos) && r.corpo.eventos.length > 0, `e eventos não vazios (${r.corpo.eventos && r.corpo.eventos.length})`);
  ok(typeof r.corpo.inicio === 'number' && r.corpo.inicio < tamanho,
    `e inicio (${r.corpo.inicio}) < ate (${tamanho}) — o pedido progrediu`);
  ok(r.corpo.cortado === true, `e cortado === true, coerente com inicio > 0 (veio ${r.corpo.cortado})`);
  ok(!('tamanho' in r.corpo), 'e a resposta NÃO carrega `tamanho` (só eventos/inicio/cortado)');
}

async function testeDuzentosNumJob() {
  plantarJob('job-fixture-1', humano('oi do job') + agente('resposta do job'));
  const tamanho = fs.statSync(path.join(RAIZ_JOBS, 'job-fixture-1', 'claude.log')).size;
  const r = await pedir(`/api/historico?chave=job-job-fixture-1&ate=${tamanho}`);
  ok(r.status === 200, `200 num job (veio ${r.status})`);
  ok(Array.isArray(r.corpo.eventos) && r.corpo.eventos.length > 0, `e eventos não vazios (${r.corpo.eventos && r.corpo.eventos.length})`);
  ok(r.corpo.cortado === false, `fixture pequena não corta (veio ${r.corpo.cortado})`);
}

// ─── Execução ──────────────────────────────────────────────────────────────────────────────

async function principal() {
  process.env.PORT = String(PORTA_SERVIDOR);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = CERT_DIR_VAZIO;
  process.env.COCKPIT_TOKEN = '';
  process.env.COCKPIT_JOBS_DIR = RAIZ_JOBS;
  process.env.COCKPIT_TMUX_SOCKET = SOCKET_TMUX;
  process.env.COCKPIT_VIGIA_MS = '0';
  require(path.join(__dirname, '..', 'server.js'));
  await espera(400); // o `listen()` do http assentar

  console.log('\n── GET /api/historico — 400 ──\n');
  await testeChaveInvalida();
  await testesAteInvalido();
  await testeIdDeJobInvalido();

  console.log('\n── GET /api/historico — 404 ──\n');
  await testeChaveQueNaoExiste();
  await testeArquivoQueSumiu();

  console.log('\n── GET /api/historico — 409 ──\n');
  await testeAteMaiorQueArquivo();
  await testeArquivoEncolheu();
  await testeSessaoQueNaoBate();

  console.log('\n── GET /api/historico — 200 ──\n');
  await testeDuzentosComEventosEInicio();
  await testeDuzentosNumJob();

  // NENHUM `kill-server` de tmux aqui (D35): o ramo de aba nunca fala com tmux de verdade
  // neste gate — o duble de `lib/abas.js` cobre `buscar` inteiro.
  fs.rmSync(CERT_DIR_VAZIO, { recursive: true, force: true });
  fs.rmSync(RAIZ_JOBS, { recursive: true, force: true });
  fs.rmSync(RAIZ_CONVERSAS, { recursive: true, force: true });
  fs.rmSync(HOME_FALSO, { recursive: true, force: true });

  console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — GET /api/historico\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.error('🔴 o gate estourou —', e);
  process.exit(1);
});
