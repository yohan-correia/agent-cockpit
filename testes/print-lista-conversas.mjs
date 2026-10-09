#!/usr/bin/env node
// Print da LISTA DE CONVERSAS (D63, D69) nos dois aparelhos — celular 390×844 e desktop 1280×800 —
// contra uma FIXTURE de 8 abas, sem tmux, sem CLI, sem token: é prova de TELA, e a ordenação
// da lista é 100 % cliente.
//
// Por que existe: gate verde prova a lógica, não a aparência (regra de 25/08). Este script sobe
// um servidor de fixture que serve um `public/` qualquer (`--public`) e responde `/api/abas`
// com 8 abas declaradas por CAMPO, roda o Chromium do `cockpit-smoke:latest` e exige, ANTES do
// obturador, que a tela seja a que o `--espero` diz. Estado reprovado não vira PNG.
//
//   --espero agrupada   a lista velha (por projeto): `.conversa-grupo[data-cwd]` ≥ 1 e sem
//                       `#lista-conversas`                                   (o ANTES, na develop)
//   --espero chata      a lista nova: 8 linhas em `#lista-conversas`, ordem por `terminouEm`
//                       (f-4,f-5,f-1,f-3,f-2,f-6,f-7,f-8), título `conversas · 8`, sem grupo, sem
//                       bloco de pendentes (a ◆ velha f-2 abaixo das ✓), 2ª linha só nas que têm
//                       aviso                                                          (o DEPOIS)
//
//   --espero parada     (celular) a ● continua no lugar; ao acabar vira ◆ e vai pro topo; ao abrir
//                       e voltar continua no topo, sem a 2ª linha (D69)    (o DEPOIS = a worktree)
//   --espero abriu-fica (celular) abrir uma ◆ e voltar NÃO muda a ordem de ninguém; ela só perde a
//                       2ª linha (D69)                                     (o DEPOIS = a worktree)
//   --espero abriu-desce (celular) o defeito do card: a ◆ está no índice 1 e DESCE depois de aberta
//                       (a lista da develop)                               (o ANTES = `public/` da develop)
//
// Controles negativos (têm de REPROVAR com exit 1 e não gravar PNG): `chata`, `abriu-fica` e
// `parada` contra o `public/` da develop; `abriu-desce` contra a worktree.
//
// No desktop com `--espero chata` sai um 3º tiro (`<prefixo>-desktop-foco.png`): a linha `f-4`
// com o foco dentro, `⧉` e `✎` à vista. O Chromium headless responde `hover: none` até no
// desktop (armadilha #66), então o roteiro emula o mouse (`emularMouse`, copiada de
// `roteiro-renomear.js`) e MEDE por `getBoundingClientRect` que a hora não fica sob os botões.
//
// Uso:
//   node testes/print-lista-conversas.mjs --public ./public --espero chata --saida /tmp/prints \
//        [--porta 7913] [--prefixo depois]
//
// Códigos de saída: 0 = PNGs gravados · 1 = cenário reprovado · 2 = erro de uso ou ambiente.

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const MODOS = new Set(['chata', 'agrupada', 'parada', 'abriu-fica', 'abriu-desce']);

const AJUDA = `print-lista-conversas — print da lista de conversas, celular e desktop

  --public DIR       o public/ a servir (a worktree, ou um 'git archive develop public')
  --espero MODO      chata | agrupada | parada | abriu-fica | abriu-desce — o que a tela TEM de mostrar
  --saida DIR        pasta dos PNGs. Recusa sobrescrever.
  --porta N          porta do servidor de fixture (padrão 7913; nunca 7879, 7899 nem 7912)
  --prefixo NOME     prefixo dos PNGs (padrão 'depois')
  --ajuda            isto
`;

function lerArgumentos(argv) {
  const opcoes = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ajuda' || arg === '-h') return { ajuda: true };
    if (!arg.startsWith('--')) return { erro: `argumento solto: ${arg}` };
    const valor = argv[i + 1];
    if (valor === undefined || valor.startsWith('--')) return { erro: `${arg} exige valor` };
    opcoes[arg.slice(2).replace(/-/g, '_')] = valor;
    i += 1;
  }
  return opcoes;
}

const o = lerArgumentos(process.argv.slice(2));
if (o.ajuda) { process.stdout.write(AJUDA); process.exit(0); }
if (o.erro) { console.error(`🔴 ${o.erro}\n\n${AJUDA}`); process.exit(2); }
if (!o.public) { console.error('🔴 falta --public'); process.exit(2); }
if (!MODOS.has(o.espero)) { console.error(`🔴 --espero tem de ser ${[...MODOS].join(' ou ')}`); process.exit(2); }
if (!o.saida) { console.error('🔴 falta --saida'); process.exit(2); }

const publico = path.resolve(o.public);
if (!fs.existsSync(path.join(publico, 'index.html'))) {
  console.error(`🔴 ${publico} não tem index.html — --public aponta para a pasta public/`);
  process.exit(2);
}
const porta = Number(o.porta || 7913);
if (!Number.isInteger(porta) || porta < 1024 || porta === 7879 || porta === 7899 || porta === 7912) {
  console.error('🔴 --porta inválida (nunca 7879, produção, 7899, o gate dos jobs, nem 7912)');
  process.exit(2);
}
const prefixo = o.prefixo || 'depois';
const saida = path.resolve(o.saida);
const nomes = [`${prefixo}-celular.png`, `${prefixo}-desktop.png`];
if (o.espero === 'chata') nomes.push(`${prefixo}-desktop-foco.png`);
if (o.espero === 'abriu-fica' || o.espero === 'abriu-desce') {
  nomes.length = 0;
  nomes.push(`${prefixo}-1-antes-de-abrir.png`, `${prefixo}-2-depois-de-voltar.png`);
}
if (o.espero === 'parada') {
  nomes.length = 0;
  nomes.push(`${prefixo}-1-inicio.png`, `${prefixo}-2-tique.png`, `${prefixo}-3-acabou.png`, `${prefixo}-4-abriu.png`);
}
// Recusa sobrescrever: um PNG velho com o nome de sempre é pior que PNG nenhum.
for (const n of nomes) {
  if (fs.existsSync(path.join(saida, n))) { console.error(`🔴 ${path.join(saida, n)} já existe — apague ou troque o prefixo`); process.exit(2); }
}

// ─── 1) A fixture: 8 abas declaradas por CAMPO, não por sinal ───────────────

const H = 3600 * 1000;
const agora = Date.now();
function abasDaFixture() {
  const lida = (t) => ({ atualizadoEm: t, lidoEm: t, terminouEm: t });
  const base = { rodando: false, esperando: false, nascendo: false, falhou: false };
  return [
    { ...base, chave: 'f-1', titulo: 'pedido-de-confianca', cwd: '/home/u/ws/alfa', temAgente: true, temClaude: true, agente: 'claude', sessaoId: 's-1', esperando: true, atualizadoEm: agora - 2 * H, lidoEm: agora - 2 * H, terminouEm: agora - 2 * H },
    { ...base, chave: 'f-2', titulo: 'resposta-que-voce-nao-leu', cwd: '/home/u/ws/beta', temAgente: true, temClaude: true, agente: 'claude', sessaoId: 's-2', atualizadoEm: agora - 24 * H, lidoEm: null, terminouEm: agora - 24 * H },
    { ...base, chave: 'f-3', titulo: 'rodando-agora', cwd: '/home/u/ws/gama', temAgente: true, temClaude: false, agente: 'codex', sessaoId: 's-3', rodando: true, atualizadoEm: agora, lidoEm: agora, terminouEm: agora - 3 * H },
    { ...base, chave: 'f-4', titulo: 'um-nome-bem-comprido-para-apertar-a-hora-contra-o-lapis', cwd: '/home/u/ws/alfa', temAgente: true, temClaude: true, agente: 'claude', sessaoId: 's-4', ...lida(agora - 10 * 60 * 1000) },
    { ...base, chave: 'f-5', titulo: 'lida-ha-uma-hora', cwd: '/home/u/ws/delta', temAgente: true, temClaude: false, agente: 'codex', sessaoId: 's-5', ...lida(agora - H) },
    { ...base, chave: 'f-6', titulo: 'lida-ha-tres-dias', cwd: '/home/u/ws/epsilon', temAgente: true, temClaude: true, agente: 'claude', sessaoId: 's-6', ...lida(agora - 72 * H) },
    { ...base, chave: 'f-7', titulo: 'terminal-sem-agente', cwd: '/home/u/ws/zeta', temAgente: false, temClaude: false, agente: null, sessaoId: null, atualizadoEm: null, terminouEm: null },
    { ...base, chave: 'f-8', titulo: 'agente-que-nao-subiu', cwd: '/home/u/ws/eta', temAgente: false, temClaude: false, agente: null, sessaoId: null, falhou: true, atualizadoEm: null, terminouEm: null },
  ];
}

// Modo parada: o roteiro manda sinais e o servidor muda a ● (f-3) como o disco mudaria.
// O instante do sinal é CONGELADO na chegada: recalcular `Date.now()` a cada GET faria o
// `atualizadoEm` da f-3 crescer a cada tique e ela voltar a ◆ depois do clique (painel do plano).
const sinal = { escreveuEm: 0, acabouEm: 0 };
const lidasFixture = Object.create(null);    // POST /api/lidas   → sessaoId → carimbo

function abasDaFixtureParada() {
  const base = { rodando: false, esperando: false, nascendo: false, falhou: false };
  const com = (aba, atualizadoEm, lidoEm, terminouEm) => ({
    ...base, ...aba,
    atualizadoEm,
    lidoEm: aba.sessaoId ? (lidasFixture[aba.sessaoId] ?? lidoEm) : lidoEm,
    terminouEm,
  });
  return [
    com({ chave: 'f-1', titulo: 'pedido-de-confianca', cwd: '/home/u/ws/alfa', temAgente: true, temClaude: true, agente: 'claude', sessaoId: 's-1', esperando: true }, agora - 2 * H, agora - 2 * H, agora - 2 * H),
    com({ chave: 'f-2', titulo: 'resposta-que-voce-nao-leu', cwd: '/home/u/ws/beta', temAgente: true, temClaude: true, agente: 'claude', sessaoId: 's-2' }, agora - 24 * H, null, agora - 24 * H),
    com({ chave: 'f-3', titulo: 'rodando-agora', cwd: '/home/u/ws/gama', temAgente: true, temClaude: false, agente: 'codex', sessaoId: 's-3', rodando: !sinal.acabouEm },
      sinal.acabouEm || sinal.escreveuEm || agora - 3 * H, agora - 3 * H, sinal.acabouEm || agora - 3 * H),
    com({ chave: 'f-4', titulo: 'um-nome-bem-comprido-para-apertar-a-hora-contra-o-lapis', cwd: '/home/u/ws/alfa', temAgente: true, temClaude: true, agente: 'claude', sessaoId: 's-4' }, agora - 10 * 60 * 1000, agora - 10 * 60 * 1000, agora - 10 * 60 * 1000),
    com({ chave: 'f-5', titulo: 'lida-ha-uma-hora', cwd: '/home/u/ws/delta', temAgente: true, temClaude: false, agente: 'codex', sessaoId: 's-5' }, agora - H, agora - H, agora - H),
    com({ chave: 'f-6', titulo: 'lida-ha-tres-dias', cwd: '/home/u/ws/epsilon', temAgente: true, temClaude: true, agente: 'claude', sessaoId: 's-6' }, agora - 72 * H, agora - 72 * H, agora - 72 * H),
    { ...base, chave: 'f-7', titulo: 'terminal-sem-agente', cwd: '/home/u/ws/zeta', temAgente: false, temClaude: false, agente: null, sessaoId: null, atualizadoEm: null, terminouEm: null },
    { ...base, chave: 'f-8', titulo: 'agente-que-nao-subiu', cwd: '/home/u/ws/eta', temAgente: false, temClaude: false, agente: null, sessaoId: null, falhou: true, atualizadoEm: null, terminouEm: null },
  ];
}

// Modos abriu-*: a fixture `chata` com a f-2 (◆) no array DEPOIS da f-6 (a ordem do tmux), e o
// `lidoEm` dela vindo do POST /api/lidas — abrir a ◆ a lê. Pela ordem do fim do turno ela fica no
// índice 4; no cliente da develop (pendentes em cima) ela começa no índice 1 e, aberta, cai para o 5.
function abasDaFixtureAbriu() {
  const lista = abasDaFixture();
  const f2 = lista.find((a) => a.chave === 'f-2');
  lista.splice(lista.indexOf(f2), 1);
  lista.splice(lista.findIndex((a) => a.chave === 'f-6') + 1, 0, { ...f2, lidoEm: lidasFixture[f2.sessaoId] ?? f2.lidoEm });
  return lista;
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

function json(res, corpo) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function lerCorpoJson(req) {
  return new Promise((resolve) => {
    let bruto = '';
    req.on('data', (d) => { bruto += d; });
    req.on('end', () => { try { resolve(JSON.parse(bruto || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const rota = url.pathname;
  if (req.method === 'POST' && rota === '/__fixture/escreveu') { req.resume(); sinal.escreveuEm = Date.now(); return json(res, {}); }
  if (req.method === 'POST' && rota === '/__fixture/acabou') { req.resume(); sinal.acabouEm = Date.now(); return json(res, {}); }
  if (rota.startsWith('/api/')) {
    if (req.method === 'POST') {
      lerCorpoJson(req).then((corpo) => {
        if (rota === '/api/lidas' && corpo.sessaoId) {
          lidasFixture[corpo.sessaoId] = Math.max(lidasFixture[corpo.sessaoId] || 0, Number(corpo.carimbo) || 0);
          return json(res, { sessaoId: corpo.sessaoId, lidoEm: lidasFixture[corpo.sessaoId] });
        }
        return json(res, {});
      });
      return undefined;
    }
    if (rota === '/api/abas') {
      if (o.espero === 'parada') return json(res, { abas: abasDaFixtureParada() });
      if (o.espero.startsWith('abriu-')) return json(res, { abas: abasDaFixtureAbriu() });
      return json(res, { abas: abasDaFixture() });
    }
    if (rota.startsWith('/api/jobs')) return json(res, { painel: true, jobs: [] });
    if (rota === '/api/leituras') return json(res, { trilhas: [] });
    if (rota.startsWith('/api/eventos')) {
      // SSE aberto: JSON aqui faria o EventSource reconectar em laço.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n');
      const batida = setInterval(() => res.write(': ok\n\n'), 15000);
      req.on('close', () => clearInterval(batida));
      return undefined;
    }
    return json(res, {});
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  let relativo;
  try { relativo = decodeURIComponent(rota); } catch { res.writeHead(400); return res.end(); }
  if (relativo.split('/').includes('..')) { res.writeHead(403); return res.end('recusado'); }
  if (relativo.endsWith('/')) relativo += 'index.html';
  const arquivo = path.join(publico, relativo);
  if (!arquivo.startsWith(publico + path.sep)) { res.writeHead(403); return res.end('recusado'); }
  fs.readFile(arquivo, (erro, dados) => {
    if (erro) { res.writeHead(404); return res.end('não achei'); }
    res.writeHead(200, { 'content-type': TIPOS[path.extname(arquivo)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(dados);
  });
  return undefined;
});

function subirServidor() {
  return new Promise((resolve) => {
    servidor.once('error', (e) => {
      console.error(`🔴 não deu para escutar em 127.0.0.1:${porta} (${e.code || e.message}) — a porta está ocupada?`);
      process.exit(2);
    });
    servidor.listen(porta, '127.0.0.1', resolve);
  });
}

// ─── 2) O roteiro que roda DENTRO do container ──────────────────────────────

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const ESPERO = process.env.ESPERO;
const PREFIXO = process.env.PREFIXO;
const ORDEM = ['f-4', 'f-5', 'f-1', 'f-3', 'f-2', 'f-6', 'f-7', 'f-8'];

const problemas = [];
const feitos = [];
const erros = [];
// Guarda ANTES do obturador: estado reprovado não vira PNG.
const exigir = (cond, msg) => {
  (cond ? feitos : problemas).push(msg);
  if (!cond) throw new Error('guarda reprovou antes do obturador: ' + msg);
};

/** Emula o aparelho COM MOUSE (armadilha #66) — copiada de testes/roteiro-renomear.js. */
function emularMouse(pagina) {
  return pagina.evaluate(() => {
    let trocadas = 0;
    const visitar = (regras) => {
      for (const regra of Array.from(regras)) {
        if (regra.media && typeof regra.media.mediaText === 'string') {
          const texto = regra.media.mediaText;
          if (/\\(\\s*hover\\s*:\\s*hover\\s*\\)/.test(texto)) {
            regra.media.mediaText = texto.replace(/\\(\\s*hover\\s*:\\s*hover\\s*\\)/g, '(min-width: 0px)');
            trocadas += 1;
          } else if (/\\(\\s*hover\\s*:\\s*none\\s*\\)/.test(texto)) {
            regra.media.mediaText = 'not all';
            trocadas += 1;
          }
        }
        if (regra.cssRules) visitar(regra.cssRules);
      }
    };
    for (const folha of Array.from(document.styleSheets)) {
      try { visitar(folha.cssRules); } catch (e) { /* folha de outra origem: não é do app */ }
    }
    return trocadas;
  });
}

async function abrir(navegador, viewport, rotulo) {
  const pagina = await navegador.newPage();
  await pagina.setViewport(viewport);
  await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  // ANTES do goto: o Chromium do container nasce em inglês e o título viraria
  // "conversations · 8" numa implementação CORRETA (i18n.js escolhe pelo navigator.language).
  await pagina.evaluateOnNewDocument(() => {
    try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* modo privado */ }
  });
  pagina.on('pageerror', (e) => erros.push(rotulo + ' pageerror: ' + e.message));
  pagina.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') erros.push(rotulo + ' console.' + m.type() + ': ' + m.text()); });
  await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await pagina.waitForSelector('#abas', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500));
  return pagina;
}

const ordem = (pagina) => pagina.evaluate(() => Array.from(document.querySelectorAll('#lista-conversas .conversa')).map((b) => b.dataset.chave));
const temRodape = (pagina, chave) => pagina.evaluate((c) => {
  const b = Array.from(document.querySelectorAll('#lista-conversas .conversa')).find((l) => l.dataset.chave === c);
  return b ? Boolean(b.querySelector('.conversa-rodape')) : null;
}, chave);
const sinalizar = (nome) => fetch(BASE + '/__fixture/' + nome, { method: 'POST' });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
/** Toca a conversa, espera o POST de lido, volta para a lista (como testes/smoke-celular-job-passos.js) e espera 2 tiques. */
async function abrirEVoltar(pagina, chave) {
  await pagina.click('#lista-conversas .conversa[data-chave="' + chave + '"]');
  await espera(1500);
  await pagina.evaluate(() => document.querySelector('.voltar').click());
  await espera(6000);
}

async function conferirTela(pagina, rotulo) {
  const estado = await pagina.evaluate(() => {
    const lista = document.querySelector('#lista-conversas');
    const linhas = lista ? Array.from(lista.querySelectorAll('.conversa')) : [];
    const rodapeDe = (chave) => {
      const b = linhas.find((l) => l.dataset.chave === chave);
      return b ? Boolean(b.querySelector('.conversa-rodape')) : null;
    };
    return {
      temLista: Boolean(lista),
      chaves: linhas.map((b) => b.dataset.chave),
      gruposAbas: document.querySelectorAll('#abas .conversa-grupo').length,
      gruposCwd: document.querySelectorAll('#abas .conversa-grupo[data-cwd]').length,
      titulo: (document.getElementById('titulo-lista') || {}).textContent || '',
      rodape: { 'f-1': rodapeDe('f-1'), 'f-2': rodapeDe('f-2'), 'f-3': rodapeDe('f-3'), 'f-4': rodapeDe('f-4'),
        'f-5': rodapeDe('f-5'), 'f-6': rodapeDe('f-6'), 'f-7': rodapeDe('f-7'), 'f-8': rodapeDe('f-8') },
    };
  });
  if (ESPERO === 'agrupada') {
    exigir(estado.gruposCwd >= 1, rotulo + ': .conversa-grupo[data-cwd] existe (' + estado.gruposCwd + ')');
    exigir(!estado.temLista, rotulo + ': #lista-conversas ausente');
    return;
  }
  exigir(estado.temLista, rotulo + ': #lista-conversas existe');
  exigir(estado.chaves.length === 8, rotulo + ': 8 conversas na lista (' + estado.chaves.length + ')');
  exigir(estado.chaves.slice(0, 2).join(',') === 'f-4,f-5', rotulo + ': as 2 primeiras são f-4,f-5 (' + estado.chaves.slice(0, 2).join(',') + ')');
  exigir(estado.chaves.join(',') === ORDEM.join(','), rotulo + ': ordem completa por terminouEm (' + estado.chaves.join(',') + ')');
  exigir(estado.chaves.indexOf('f-2') > estado.chaves.indexOf('f-5'), rotulo + ': a ◆ velha f-2 fica abaixo da ✓ que terminou depois, sem bloco de pendentes (' + estado.chaves.join(',') + ')');
  exigir(estado.gruposAbas === 0, rotulo + ': nenhum .conversa-grupo em #abas (' + estado.gruposAbas + ')');
  exigir(estado.titulo === 'conversas · 8', rotulo + ': título "conversas · 8" (' + estado.titulo + ')');
  for (const k of ['f-4', 'f-5', 'f-6', 'f-7']) exigir(estado.rodape[k] === false, rotulo + ': ' + k + ' SEM 2ª linha');
  for (const k of ['f-1', 'f-2', 'f-3', 'f-8']) exigir(estado.rodape[k] === true, rotulo + ': ' + k + ' COM 2ª linha');
}

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    if (ESPERO === 'parada') {
      // ── celular: a ● (f-3) mora no 4º lugar; o agente escreve; o turno acaba; abrir e voltar ──
      const cel = await abrir(navegador,
        { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'celular');
      let o = await ordem(cel);
      exigir(o[3] === 'f-3', 'inicio: f-3 em 4º (' + o.join(',') + ')');
      await cel.screenshot({ path: '/out/' + PREFIXO + '-1-inicio.png' });
      feitos.push('PNG 1-inicio gravado');
      await sinalizar('escreveu');
      await espera(11000);
      o = await ordem(cel);
      exigir(o[3] === 'f-3', 'tique: f-3 continua em 4º (' + o.join(',') + ')');
      await cel.screenshot({ path: '/out/' + PREFIXO + '-2-tique.png' });
      feitos.push('PNG 2-tique gravado');
      await sinalizar('acabou');
      await espera(6000);
      o = await ordem(cel);
      exigir(o[0] === 'f-3', 'acabou: f-3 vira ◆ e vai pro topo (' + o.join(',') + ')');
      exigir((await temRodape(cel, 'f-3')) === true, 'acabou: f-3 com .conversa-rodape');
      await cel.screenshot({ path: '/out/' + PREFIXO + '-3-acabou.png' });
      feitos.push('PNG 3-acabou gravado');
      await abrirEVoltar(cel, 'f-3');
      o = await ordem(cel);
      exigir(o[0] === 'f-3', 'abriu e voltou: f-3 continua no topo (' + o.join(',') + ')');
      exigir((await temRodape(cel, 'f-3')) === false, 'abriu e voltou: f-3 SEM .conversa-rodape');
      await cel.screenshot({ path: '/out/' + PREFIXO + '-4-abriu.png' });
      feitos.push('PNG 4-abriu gravado');
      await cel.close();
      if (erros.length) feitos.push('console (anotado, não reprova): ' + erros.length + ' aviso(s)/erro(s): ' + Array.from(new Set(erros)).slice(0, 8).join(' | '));
      return;
    }
    if (ESPERO === 'abriu-fica' || ESPERO === 'abriu-desce') {
      // ── celular: abrir a ◆ f-2 e voltar ──
      const cel = await abrir(navegador,
        { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'celular');
      const antes = await ordem(cel);
      if (ESPERO === 'abriu-fica') {
        exigir(antes.join(',') === ORDEM.join(','), 'antes de abrir: ordem por terminouEm (' + antes.join(',') + ')');
      } else {
        exigir(antes.indexOf('f-2') === 1, 'antes de abrir: f-2 (◆) no índice 1 (' + antes.join(',') + ')');
      }
      exigir((await temRodape(cel, 'f-2')) === true, 'antes de abrir: f-2 COM .conversa-rodape');
      await cel.screenshot({ path: '/out/' + PREFIXO + '-1-antes-de-abrir.png' });
      feitos.push('PNG 1-antes-de-abrir gravado');
      await abrirEVoltar(cel, 'f-2');
      const depois = await ordem(cel);
      if (ESPERO === 'abriu-fica') {
        exigir(depois.join(',') === antes.join(','), 'depois de voltar: ordem IDÊNTICA à de antes (' + depois.join(',') + ')');
      } else {
        exigir(depois.indexOf('f-2') > 1, 'depois de voltar: f-2 DESCEU do índice 1 (' + depois.join(',') + ')');
      }
      exigir((await temRodape(cel, 'f-2')) === false, 'depois de voltar: f-2 SEM .conversa-rodape');
      await cel.screenshot({ path: '/out/' + PREFIXO + '-2-depois-de-voltar.png' });
      feitos.push('PNG 2-depois-de-voltar gravado');
      await cel.close();
      if (erros.length) feitos.push('console (anotado, não reprova): ' + erros.length + ' aviso(s)/erro(s): ' + Array.from(new Set(erros)).slice(0, 8).join(' | '));
      return;
    }
    // ── celular ──
    const cel = await abrir(navegador,
      { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'celular');
    await conferirTela(cel, 'celular');
    await cel.screenshot({ path: '/out/' + PREFIXO + '-celular.png' });
    feitos.push('PNG celular gravado');
    await cel.close();

    // ── desktop ──
    const desk = await abrir(navegador, { width: 1280, height: 800 }, 'desktop');
    await conferirTela(desk, 'desktop');
    await desk.screenshot({ path: '/out/' + PREFIXO + '-desktop.png' });
    feitos.push('PNG desktop gravado');

    // ── 3º tiro do desktop: a hora não pode ficar sob o ⧉ nem sob o ✎ ──
    if (ESPERO === 'chata') {
      const trocadas = await emularMouse(desk);
      exigir(trocadas > 0, 'emularMouse trocou ' + trocadas + ' condição(ões) de mídia (zero = defeito do roteiro)');
      await desk.focus('#lista-conversas .conversa[data-chave="f-4"]');
      await new Promise((r) => setTimeout(r, 200));
      const m = await desk.evaluate(() => {
        const botao = document.querySelector('#lista-conversas .conversa[data-chave="f-4"]');
        const linha = botao && botao.closest('.conversa-linha');
        const caixa = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; };
        const lado = linha && linha.querySelector('.abrir-ao-lado');
        return {
          display: lado ? getComputedStyle(lado).display : null,
          hora: caixa(linha && linha.querySelector('.conversa-hora')),
          lado: caixa(lado),
          lapis: caixa(linha && linha.querySelector('.renomear-aba')),
        };
      });
      exigir(m.display === 'flex', 'foco: .abrir-ao-lado com display flex (' + m.display + ')');
      exigir(Boolean(m.hora && m.lado && m.lapis), 'foco: hora, ⧉ e ✎ existem na linha f-4');
      exigir(m.hora.right <= m.lado.left, 'foco: hora.right (' + m.hora.right + ') <= abrirAoLado.left (' + m.lado.left + ')');
      exigir(m.hora.right <= m.lapis.left, 'foco: hora.right (' + m.hora.right + ') <= renomear.left (' + m.lapis.left + ')');
      await desk.screenshot({ path: '/out/' + PREFIXO + '-desktop-foco.png' });
      feitos.push('PNG desktop-foco gravado');
    }
    if (erros.length) feitos.push('console (anotado, não reprova): ' + erros.length + ' aviso(s)/erro(s): ' + Array.from(new Set(erros)).slice(0, 8).join(' | '));
  } finally {
    await navegador.close();
  }
})().then(() => {
  console.log('@@PRINT-LISTA@@' + JSON.stringify({ feitos, problemas }));
}).catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  if (erros.length) feitos.push('console (anotado): ' + Array.from(new Set(erros)).slice(0, 8).join(' | '));
  console.log('@@PRINT-LISTA@@' + JSON.stringify({ feitos, problemas: problemas.length ? problemas : ['roteiro estourou: ' + e.message] }));
  process.exitCode = 1;
});
`;
}

// ─── 3) Corrida ─────────────────────────────────────────────────────────────

function rodarContainer(scratch, outDir) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${porta}`,
      '-e', `ESPERO=${o.espero}`,
      '-e', `PREFIXO=${prefixo}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${outDir}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let bruto = '';
    docker.stdout.on('data', (d) => { bruto += d; });
    docker.stderr.on('data', (d) => { bruto += d; });
    docker.on('close', (codigo) => {
      const MARCADOR = '@@PRINT-LISTA@@';
      const abre = bruto.indexOf(MARCADOR);
      let relatorio = null;
      let resto = bruto;
      if (abre >= 0) {
        // stdout e stderr chegam misturados e em ordem não garantida: o JSON é a LINHA do marcador,
        // e o que vier depois dela (uma mensagem de erro do roteiro) não pode quebrar o parse.
        const fim = bruto.indexOf('\n', abre);
        const linha = bruto.slice(abre + MARCADOR.length, fim < 0 ? undefined : fim);
        try { relatorio = JSON.parse(linha); } catch { relatorio = null; }
        resto = bruto.slice(0, abre) + (fim < 0 ? '' : bruto.slice(fim + 1));
      }
      process.stdout.write(resto);
      resolve(relatorio || { feitos: [], problemas: [`o roteiro não devolveu JSON (código ${codigo})`] });
    });
  });
}

try {
  execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
} catch {
  console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
  process.exit(2);
}

await subirServidor();

let scratch = null;
let outDir = null;
let codigoFinal = 0;
try {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lista-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lista-out-'));
  fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro(), { mode: 0o600 });
  // O container roda como outro usuário: /out precisa ser gravável por ele.
  fs.chmodSync(outDir, 0o777);

  const relatorio = await rodarContainer(scratch, outDir);
  for (const f of relatorio.feitos) console.log(`  ✅ ${f}`);
  for (const p of relatorio.problemas) console.error(`  ❌ ${p}`);

  const faltando = nomes.filter((n) => !fs.existsSync(path.join(outDir, n)));
  if (relatorio.problemas.length || faltando.length) {
    console.error('🔴 print REPROVADO — nenhum PNG gravado no destino');
    codigoFinal = 1;
  } else {
    fs.mkdirSync(saida, { recursive: true });
    for (const n of nomes) {
      fs.copyFileSync(path.join(outDir, n), path.join(saida, n));
      console.log(`✅ print gravado: ${path.join(saida, n)}`);
    }
  }
} finally {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  servidor.closeAllConnections?.();
  servidor.close();
}
process.exit(codigoFinal);
