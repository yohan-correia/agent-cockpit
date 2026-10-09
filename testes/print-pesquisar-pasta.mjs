#!/usr/bin/env node
// Print do campo PROJETO do diálogo de aba nova (card `pesquisar-a-pasta-na-aba-nova`) nos dois
// aparelhos — celular 390×844 e desktop 1600×1000 — contra uma FIXTURE de 48 pastas fictícias,
// sem tmux, sem CLI, sem token. O Criar NUNCA é clicado: nenhuma aba nasce daqui.
//
// Por que existe: gate verde prova a lógica, não a aparência (regra de 25/08). O servidor de
// fixture serve um `public/` qualquer (`--public`), o Chromium do `cockpit-smoke:latest` abre o
// diálogo e exige, ANTES do obturador, que a tela seja a que o `--espero` diz. Estado reprovado
// não vira PNG.
//
//   --espero select     o seletor velho: `#sel-projeto-novo` é <select> com as 48 <option>
//                       (o ANTES, `public/` da develop)
//   --espero filtrando  o campo novo: <input> com o foco e a lista CHEIA aberta, o Criar à vista
//                       (print 0 — o estado em que toda abertura cai); `cock` digitado pelo teclado,
//                       a lista mostra EXATAMENTE os nomes da fixture que contêm "cock" (print 1);
//                       tocar a 2ª opção escreve o nome e fecha a lista (print 2)
//                       (o DEPOIS, a worktree)
//   --espero sem-pasta  card `criar-pasta-na-aba-nova`: `Meu Projeto` digitado, a lista diz "Nenhuma
//                       pasta com esse nome." e NÃO oferece criar (o ANTES, `public/` da develop)
//   --espero criando    `Meu Projeto` digitado → "Nenhuma pasta…" + item `+ Criar pasta Meu-Projeto` (print
//                       1); `cock` → os 3 nomes que casam + `+ Criar pasta cock` por último (print 2);
//                       tocar no item → um POST /api/projetos {nome:'cock'}, campo `cock`, lista
//                       fechada (print 3) (o DEPOIS, a worktree)
//
// Controles negativos (têm de REPROVAR com exit 1 e não gravar PNG): `filtrando` contra o
// `public/` da develop; `select` contra a worktree; `criando` contra a develop; `sem-pasta` contra a
// worktree.
//
// O teclado virtual do celular não existe no Chromium headless: a vista com o teclado aberto é
// smoke manual, não prova deste script.
//
// Uso:
//   node testes/print-pesquisar-pasta.mjs --public ./public --espero filtrando --saida /tmp/prints \
//        [--porta 7921] [--prefixo depois]
//
// Códigos de saída: 0 = PNGs gravados · 1 = cenário reprovado · 2 = erro de uso ou ambiente.

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const MODOS = new Set(['select', 'filtrando', 'sem-pasta', 'criando']);

const AJUDA = `print-pesquisar-pasta — print do campo Projeto da aba nova, celular e desktop

  --public DIR       o public/ a servir (a worktree, ou um 'git archive develop public')
  --espero MODO      select | filtrando | sem-pasta | criando — o que a tela TEM de mostrar
  --saida DIR        pasta dos PNGs. Recusa sobrescrever.
  --porta N          porta do servidor de fixture (padrão 7921; nunca 7879, 7897 nem 7899)
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
const porta = Number(o.porta || 7921);
if (!Number.isInteger(porta) || porta < 1024 || [7879, 7897, 7899].includes(porta)) {
  console.error('🔴 --porta inválida (nunca 7879, produção, 7897 nem 7899, o gate dos jobs)');
  process.exit(2);
}
const prefixo = o.prefixo || 'depois';
const saida = path.resolve(o.saida);
// Um mapa por modo: o PNG que falta é o que reprova (`faltando`, lá embaixo).
const APARELHOS = ['celular', 'desktop'];
const nomes = {
  select: APARELHOS.map((a) => `${prefixo}-${a}.png`),
  filtrando: APARELHOS.flatMap((a) => ['0-aberto', '1-filtrando', '2-escolhido'].map((t) => `${prefixo}-${a}-${t}.png`)),
  'sem-pasta': APARELHOS.map((a) => `${prefixo}-${a}-sem-pasta.png`),
  criando: APARELHOS.flatMap((a) => ['1-oferece', '2-parcial', '3-escolhida'].map((t) => `${prefixo}-${a}-${t}.png`)),
}[o.espero];
// Recusa sobrescrever: um PNG velho com o nome de sempre é pior que PNG nenhum.
for (const n of nomes) {
  if (fs.existsSync(path.join(saida, n))) { console.error(`🔴 ${path.join(saida, n)} já existe — apague ou troque o prefixo`); process.exit(2); }
}

// ─── 1) A fixture: 48 pastas fictícias, o tamanho de ~/projetos em 08/10 ─────

// Três casam com "cock" (uma no meio do nome), uma tem acento. Ordem do servidor: localeCompare,
// como `listarProjetos()` faz (server.js).
const PROJETOS = [
  'agenda-familia', 'alfa-loja', 'api-pagamentos', 'arquivo-morto', 'bot-telegram', 'calculadora-juros',
  'cardapio-digital', 'clinica-site', 'cockpit-agentes', 'cockpit-jogo', 'coração-de-teste', 'cursos-online',
  'dashboard-vendas', 'diario-de-bordo', 'estoque-simples', 'faq-suporte', 'financas-pessoais', 'galeria-fotos',
  'guia-viagem', 'hackathon-2026', 'jogo-da-velha', 'kanban-local', 'landing-evento', 'lista-compras',
  'meu-blog', 'mini-crm', 'notas-rapidas', 'oficina-react', 'painel-servidor', 'pesquisa-satisfacao',
  'portfolio', 'quiz-bichos', 'receitas', 'relatorio-mensal', 'rpg-mesa', 'scraper-precos',
  'site-hotcocktail', 'sistema-escola', 'tarefas-casa', 'temporizador', 'testes-ia', 'tradutor-legendas',
  'uploader', 'vitrine-loja', 'web-radio', 'xadrez-online', 'zap-atendimento', 'zen-servidor',
].sort((a, b) => a.localeCompare(b));
const CASAM_COCK = PROJETOS.filter((n) => n.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().includes('cock'));

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

function json(res, corpo, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

// A lista que o GET devolve: começa nos 48 e ganha o que o `POST /api/projetos` criar. Cada `cenario()`
// chama `/__fixture/zerar?cenario=<aparelho>` antes de abrir a página — sem isso o desktop acharia `cock`
// já criado pelo celular e não ofereceria o item.
let lista = [...PROJETOS];
let cenarioAtual = '(nenhum)';
const postsRecebidos = [];   // { cenario, rota, nome } — a contagem é POR cenário (lá embaixo)
const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const rota = url.pathname;
  if (rota === '/__fixture/zerar' && req.method === 'POST') {
    lista = [...PROJETOS];
    cenarioAtual = url.searchParams.get('cenario') || '(sem nome)';
    req.resume();
    return json(res, { ok: true });
  }
  if (rota.startsWith('/api/')) {
    if (req.method === 'POST') {
      let bruto = '';
      req.on('data', (d) => { bruto += d; });
      req.on('end', () => {
        let nome = null;
        try { nome = JSON.parse(bruto || '{}').nome ?? null; } catch { /* corpo torto: registra sem nome */ }
        postsRecebidos.push({ cenario: cenarioAtual, rota, nome });
        // Só o criar pasta responde de verdade; qualquer outro POST é registrado e reprova lá embaixo.
        if (rota === '/api/projetos' && typeof nome === 'string') {
          if (!lista.includes(nome)) lista = [...lista, nome].sort((a, b) => a.localeCompare(b));
          return json(res, { nome }, 201);
        }
        return json(res, {});
      });
      return undefined;
    }
    if (rota === '/api/projetos') return json(res, { projetos: lista.map((nome) => ({ nome })) });
    if (rota === '/api/agentes') {
      return json(res, {
        agentes: [
          { id: 'claude', rotulo: 'Claude Code', modelos: [{ id: 'opus', rotulo: 'Opus' }, { id: 'sonnet', rotulo: 'Sonnet' }] },
          { id: 'codex', rotulo: 'Codex CLI', modelos: [] },
        ],
        padrao: 'claude',
      });
    }
    if (rota === '/api/abas') return json(res, { abas: [] });
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
const TOTAL = ${PROJETOS.length};
const CASAM = ${JSON.stringify(CASAM_COCK)};

const problemas = [];
const feitos = [];
const erros = [];
// Guarda ANTES do obturador: estado reprovado não vira PNG.
const exigir = (cond, msg) => {
  (cond ? feitos : problemas).push(msg);
  if (!cond) throw new Error('guarda reprovou antes do obturador: ' + msg);
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
// A fixture volta aos 48 nomes e passa a contar os POSTs deste aparelho.
const zerarFixture = (rotulo) => new Promise((resolve, reject) => {
  const req = require('http').request(BASE + '/__fixture/zerar?cenario=' + rotulo, { method: 'POST' }, (res) => { res.resume(); res.on('end', resolve); });
  req.on('error', reject);
  req.end();
});

async function abrir(navegador, viewport, rotulo) {
  await zerarFixture(rotulo);
  const pagina = await navegador.newPage();
  await pagina.setViewport(viewport);
  await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  // ANTES do goto: o Chromium do container nasce em inglês (i18n.js escolhe pelo navigator.language).
  await pagina.evaluateOnNewDocument(() => {
    try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* modo privado */ }
  });
  pagina.on('pageerror', (e) => erros.push(rotulo + ' pageerror: ' + e.message));
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(rotulo + ' console.error: ' + m.text()); });
  await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await pagina.waitForSelector('#abas', { timeout: 15000 });
  await espera(800);
  // O + da lateral, como o dedo faria. O fade do <dialog> é 160 ms; a lista vem por fetch.
  await pagina.click('#btn-nova-aba');
  await espera(1200);
  return pagina;
}

/** A foto do diálogo: o que a guarda lê antes do obturador. */
function medir(pagina) {
  return pagina.evaluate(() => {
    const dentro = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= -0.5 && r.left >= -0.5
        && r.bottom <= window.innerHeight + 0.5 && r.right <= window.innerWidth + 0.5;
    };
    const dialogo = document.getElementById('dialogo-nova-aba');
    const campo = document.getElementById('sel-projeto-novo');
    const lista = document.getElementById('lista-projeto-novo');
    // Os NOMES, sem o item de criar pasta (card criar-pasta-na-aba-nova): ele também é role=option.
    const opcoes = lista ? Array.from(lista.querySelectorAll('[role="option"]:not([data-criar])')).map((b) => b.textContent.trim()) : [];
    const itemCriar = lista ? lista.querySelector('[data-criar]') : null;
    return {
      aberto: Boolean(dialogo && dialogo.open),
      tag: campo ? campo.tagName : null,
      nOptions: campo && campo.tagName === 'SELECT' ? campo.options.length : null,
      valor: campo ? campo.value : null,
      foco: document.activeElement ? document.activeElement.id : null,
      expandido: campo ? campo.getAttribute('aria-expanded') : null,
      listaVisivel: Boolean(lista && !lista.hidden && dentro(lista)),
      listaEscondida: Boolean(lista && lista.hidden),
      opcoes,
      criarVisivel: dentro(document.getElementById('btn-criar-aba')),
      vazia: Boolean(lista && lista.querySelector('.paleta-vazia') && /Nenhuma pasta com esse nome/.test(lista.textContent)),
      itemCriar: itemCriar ? itemCriar.textContent.trim() : null,
      itemCriarVisivel: dentro(itemCriar),
      itemCriarUltimo: Boolean(itemCriar && lista.lastElementChild === itemCriar),
    };
  });
}

async function cenario(navegador, viewport, rotulo, toque) {
  const pagina = await abrir(navegador, viewport, rotulo);
  let m = await medir(pagina);
  exigir(m.aberto, rotulo + ': #dialogo-nova-aba aberto');
  if (ESPERO === 'select') {
    exigir(m.tag === 'SELECT', rotulo + ': #sel-projeto-novo é <select> (' + m.tag + ')');
    exigir(m.nOptions === TOTAL, rotulo + ': ' + TOTAL + ' <option> (' + m.nOptions + ')');
    await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + rotulo + '.png' });
    feitos.push('PNG ' + rotulo + ' gravado');
    await pagina.close();
    return;
  }
  exigir(m.tag === 'INPUT', rotulo + ': #sel-projeto-novo é <input> (' + m.tag + ')');
  exigir(m.foco === 'sel-projeto-novo', rotulo + ': o campo nasce com o foco (activeElement=' + m.foco + ')');
  if (ESPERO === 'sem-pasta' || ESPERO === 'criando') return cenarioCriar(pagina, rotulo, toque);
  // Print 0: o foco do autofocus abre a lista CHEIA — o caso de altura máxima no celular.
  exigir(m.valor === '', rotulo + ': o campo nasce vazio (' + JSON.stringify(m.valor) + ')');
  exigir(m.expandido === 'true', rotulo + ': a lista nasce aberta, aria-expanded="true" (' + m.expandido + ')');
  exigir(m.listaVisivel, rotulo + ': #lista-projeto-novo visível e dentro da viewport com a lista cheia');
  exigir(m.opcoes.length === TOTAL, rotulo + ': a lista cheia tem as ' + TOTAL + ' pastas (' + m.opcoes.length + ')');
  exigir(m.criarVisivel, rotulo + ': o Criar dentro da viewport com a lista cheia aberta');
  await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + rotulo + '-0-aberto.png' });
  feitos.push('PNG ' + rotulo + '-0-aberto gravado');
  await pagina.keyboard.type('cock', { delay: 40 });
  await espera(400);
  m = await medir(pagina);
  exigir(m.valor === 'cock', rotulo + ': o campo tem "cock" (' + m.valor + ')');
  exigir(m.expandido === 'true', rotulo + ': aria-expanded="true" (' + m.expandido + ')');
  exigir(m.listaVisivel, rotulo + ': #lista-projeto-novo visível e dentro da viewport');
  exigir(JSON.stringify([...m.opcoes].sort()) === JSON.stringify([...CASAM].sort()),
    rotulo + ': a lista tem EXATAMENTE ' + CASAM.join(', ') + ' (' + m.opcoes.join(', ') + ')');
  exigir(m.criarVisivel, rotulo + ': o Criar continua dentro da viewport com a lista aberta');
  await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + rotulo + '-1-filtrando.png' });
  feitos.push('PNG ' + rotulo + '-1-filtrando gravado');

  const alvo = '#lista-projeto-novo [role="option"]:nth-child(2)';
  const nomeAlvo = await pagina.$eval(alvo, (b) => b.textContent.trim());
  if (toque) await pagina.tap(alvo); else await pagina.click(alvo);
  await espera(400);
  m = await medir(pagina);
  exigir(m.valor === nomeAlvo, rotulo + ': o toque na 2ª opção escreve "' + nomeAlvo + '" (' + m.valor + ')');
  exigir(m.listaEscondida, rotulo + ': a lista fecha depois de escolher');
  exigir(m.expandido === 'false', rotulo + ': aria-expanded="false" depois de escolher (' + m.expandido + ')');
  exigir(m.aberto, rotulo + ': o diálogo continua aberto');
  exigir(m.criarVisivel, rotulo + ': o Criar dentro da viewport depois de escolher');
  await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + rotulo + '-2-escolhido.png' });
  feitos.push('PNG ' + rotulo + '-2-escolhido gravado');
  await pagina.close();
}

/** Card criar-pasta-na-aba-nova: o ANTES (sem-pasta) e o DEPOIS (criando). */
async function cenarioCriar(pagina, rotulo, toque) {
  await pagina.keyboard.type('Meu Projeto', { delay: 40 });
  await espera(400);
  let m = await medir(pagina);
  exigir(m.valor === 'Meu Projeto', rotulo + ': o campo tem "Meu Projeto" (' + m.valor + ')');
  exigir(m.listaVisivel, rotulo + ': #lista-projeto-novo visível e dentro da viewport');
  exigir(m.opcoes.length === 0, rotulo + ': nenhum nome casa com "Meu Projeto" (' + m.opcoes.join(', ') + ')');
  exigir(m.vazia, rotulo + ': a lista diz "Nenhuma pasta com esse nome."');
  if (ESPERO === 'sem-pasta') {
    exigir(m.itemCriar === null, rotulo + ': NÃO há item de criar pasta (' + m.itemCriar + ')');
    await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + rotulo + '-sem-pasta.png' });
    feitos.push('PNG ' + rotulo + '-sem-pasta gravado');
    await pagina.close();
    return;
  }
  exigir(m.itemCriar === '+ Criar pasta Meu-Projeto', rotulo + ': o item mostra o nome convertido (' + m.itemCriar + ')');
  exigir(m.itemCriarVisivel, rotulo + ': o item de criar pasta está dentro da viewport');
  exigir(m.criarVisivel, rotulo + ': o Criar dentro da viewport');
  await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + rotulo + '-1-oferece.png' });
  feitos.push('PNG ' + rotulo + '-1-oferece gravado');

  for (let i = 0; i < 'Meu Projeto'.length; i += 1) await pagina.keyboard.press('Backspace');
  await pagina.keyboard.type('cock', { delay: 40 });
  await espera(400);
  m = await medir(pagina);
  exigir(m.valor === 'cock', rotulo + ': o campo tem "cock" (' + m.valor + ')');
  exigir(JSON.stringify([...m.opcoes].sort()) === JSON.stringify([...CASAM].sort()),
    rotulo + ': a lista tem EXATAMENTE ' + CASAM.join(', ') + ' (' + m.opcoes.join(', ') + ')');
  exigir(m.itemCriar === '+ Criar pasta cock', rotulo + ': com resultado parcial o item continua (' + m.itemCriar + ')');
  exigir(m.itemCriarUltimo, rotulo + ': o item é o ÚLTIMO da lista');
  exigir(m.itemCriarVisivel, rotulo + ': o item dentro da viewport');
  exigir(m.criarVisivel, rotulo + ': o Criar dentro da viewport');
  await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + rotulo + '-2-parcial.png' });
  feitos.push('PNG ' + rotulo + '-2-parcial gravado');

  if (toque) await pagina.tap('[data-criar]'); else await pagina.click('[data-criar]');
  await espera(800);
  m = await medir(pagina);
  exigir(m.valor === 'cock', rotulo + ': a pasta nova fica escolhida no campo (' + m.valor + ')');
  exigir(m.listaEscondida, rotulo + ': a lista fecha depois de criar');
  exigir(m.expandido === 'false', rotulo + ': aria-expanded="false" (' + m.expandido + ')');
  exigir(m.aberto, rotulo + ': o diálogo continua aberto');
  exigir(m.criarVisivel, rotulo + ': o Criar dentro da viewport');
  await pagina.screenshot({ path: '/out/' + PREFIXO + '-' + rotulo + '-3-escolhida.png' });
  feitos.push('PNG ' + rotulo + '-3-escolhida gravado');
  await pagina.close();
}

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    await cenario(navegador, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'celular', true);
    await cenario(navegador, { width: 1600, height: 1000 }, 'desktop', false);
    if (erros.length) problemas.push('erro na página: ' + Array.from(new Set(erros)).slice(0, 8).join(' | '));
  } finally {
    await navegador.close();
  }
})().then(() => {
  console.log('@@PRINT-PASTA@@' + JSON.stringify({ feitos, problemas }));
}).catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  if (erros.length) feitos.push('console (anotado): ' + Array.from(new Set(erros)).slice(0, 8).join(' | '));
  console.log('@@PRINT-PASTA@@' + JSON.stringify({ feitos, problemas: problemas.length ? problemas : ['roteiro estourou: ' + e.message] }));
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
      const MARCADOR = '@@PRINT-PASTA@@';
      const abre = bruto.indexOf(MARCADOR);
      let relatorio = null;
      let resto = bruto;
      if (abre >= 0) {
        // stdout e stderr chegam misturados: o JSON é a LINHA do marcador.
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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-pasta-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-pasta-out-'));
  fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro(), { mode: 0o644 });
  // O container roda como outro usuário: /w precisa ser legível e /out gravável por ele.
  fs.chmodSync(scratch, 0o755);
  fs.chmodSync(outDir, 0o777);

  const relatorio = await rodarContainer(scratch, outDir);
  // A contagem é POR aparelho: `criando` exige exatamente um POST /api/projetos {nome:'cock'} em cada um;
  // os outros modos, zero POST. O Criar nunca é clicado — nenhum outro POST é aceitável em modo nenhum.
  const outros = postsRecebidos.filter((p) => p.rota !== '/api/projetos');
  if (outros.length) relatorio.problemas.push(`chegou POST na fixture (${outros.map((p) => p.rota).join(', ')}) — o roteiro não pode criar aba`);
  for (const aparelho of APARELHOS) {
    const pastas = postsRecebidos.filter((p) => p.rota === '/api/projetos' && p.cenario === aparelho);
    const esperado = o.espero === 'criando' ? 1 : 0;
    if (pastas.length !== esperado) relatorio.problemas.push(`${aparelho}: ${pastas.length} POST /api/projetos (esperado ${esperado})`);
    else if (esperado && pastas[0].nome !== 'cock') relatorio.problemas.push(`${aparelho}: o POST levou ${JSON.stringify(pastas[0].nome)} (esperado "cock")`);
    else if (esperado) relatorio.feitos.push(`${aparelho}: exatamente um POST /api/projetos {nome:"cock"}`);
  }
  const semCenario = postsRecebidos.filter((p) => p.rota === '/api/projetos' && !APARELHOS.includes(p.cenario));
  if (semCenario.length) relatorio.problemas.push(`POST /api/projetos fora de um cenário (${semCenario.length})`);
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
