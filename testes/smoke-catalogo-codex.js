#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — comandos nativos do Codex na paleta de "/" e "$" (390×844, tema escuro).
//
// Tudo FABRICADO, de propósito: nada aqui é `server.js`, tmux, CLI real ou conta OpenAI/Anthropic.
// O único pedaço "real" é o módulo `lib/catalogo-codex.js` do próprio produto, consultado através
// de um processo Codex FALSO (o mesmo truque de `testes/gate-catalogo-codex.js`) com
// `COCKPIT_BIN_CODEX` e `CODEX_HOME` apontando para uma fixture temporária — é assim que o smoke
// prova o catálogo de verdade em vez de uma lista corrigida à mão que passaria mesmo com o bug.
//
// Este arquivo sobe um HTTP estático + API próprio (não `server.js`) servindo os assets desta
// worktree e fabricando `/api/*`; o navegador é Chromium real, rodando em container Docker
// (`--network host`), no mesmo padrão de `testes/smoke-navegador-erro-codex.js`. Playwright não
// está instalado nesta máquina (checado antes de escrever isto) — por isso o caminho é
// Docker + `puppeteer-core`, que já vive na imagem.
//
// MODO=antes    — prova o BUG: `/cl` não mostra `/clear` (código de produto ainda não mudou).
// MODO (padrão) — prova a CORREÇÃO: `/clear` aparece rotulado "comando", com descrição; a
//                 colisão de nome com a skill `$clear` funciona nos dois prefixos; `/hand`
//                 continua selecionando `$handoff`. Toda seleção preenche a caixa sem POST.
//
// Códigos de saída: 0 = verde · 1 = reprovou (assert de DOM/API, pageerror ou requisição
// inesperada) · 2 = ambiente indisponível (Docker/imagem ausente) — nunca verde por pular.
//
// Variáveis: MODO=antes|<vazio> · SAIDA=pasta absoluta para os PNGs · IMAGEM (docker).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const RAIZ_DO_REPO = path.resolve(__dirname, '..');
const PUBLICO = path.join(RAIZ_DO_REPO, 'public');
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const MODO = process.env.MODO === 'antes' ? 'antes' : 'depois';
const SAIDA = path.resolve(process.env.SAIDA || path.join(os.tmpdir(), 'cockpit-comandos-shots'));
const CONTAINER = `cockpit-catalogo-smoke-${process.pid}-${Date.now()}`;

const CHAVE = 'aba-codex-1';
const TITULO = 'cockpit-codex-smoke';

const pular = (motivo) => { console.error(`\n⚠ SMOKE PULADO — ${motivo}\n`); process.exit(2); };
const rodaSaindoZero = (bin, args) => {
  try { execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 }); return true; } catch { return false; }
};

// ─── Pré-requisitos ──────────────────────────────────────────────────────────
if (!rodaSaindoZero('docker', ['image', 'inspect', IMAGEM])) pular(`a imagem ${IMAGEM} não existe (IMAGEM=… para outra)`);

// ─── Fixture do Codex falso: bin, CODEX_HOME e cwd, tudo temporário ──────────
const temporarios = [];
const mk = (prefixo) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefixo)); temporarios.push(d); return d; };

const binDir = mk('smoke-catalogo-codex-bin-');
const bin = path.join(binDir, 'codex-falso');
const log = path.join(binDir, 'chamadas');
// Duas skills: `handoff` prova que a descoberta antiga continua funcionando; `clear` é
// homônima do comando nativo — é ela que prova a colisão de nome dos critérios 2 e 3 da spec.
fs.writeFileSync(bin, `#!/usr/bin/env node
const fs=require('fs');
require('readline').createInterface({input:process.stdin}).on('line',l=>{
 const m=JSON.parse(l);fs.appendFileSync(${JSON.stringify(log)},m.method+'\\n');
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='skills/list') console.log(JSON.stringify({id:m.id,result:{data:[{cwd:m.params.cwds[0],skills:[
 {name:'handoff',enabled:true,scope:'user',description:'Handoff para outra sessão'},
 {name:'clear',enabled:true,scope:'user',description:'Skill homônima do comando nativo'}
 ]}]}}));
});`, { mode: 0o700 });

const cwdFixture = mk('smoke-catalogo-codex-cwd-');
const codexHome = mk('smoke-catalogo-codex-codexhome-');
const antigoBin = process.env.COCKPIT_BIN_CODEX;
const antigoHome = process.env.CODEX_HOME;
process.env.COCKPIT_BIN_CODEX = bin;
process.env.CODEX_HOME = codexHome;

// Só DEPOIS de fixar o bin falso: é o módulo REAL do produto que gera os itens, nunca uma
// lista corrigida à mão — se o código de produto não mudou, o catálogo prova isso sozinho.
const catalogo = require(path.join(RAIZ_DO_REPO, 'lib', 'catalogo'));

// ─── Servidor próprio: estáticos da worktree + API toda fabricada ────────────
// NUNCA `server.js`: sem tmux, sem sessão, sem CLI/TUI real — só o que a paleta do celular
// consome no boot (lido em `public/app.js` antes de escrever isto).

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

const inesperadas = [];
const naoGet = [];

function enviarJson(res, status, corpo) {
  const dados = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(dados) });
  res.end(dados);
}

function servirEstatico(req, res, rota) {
  const semQuery = rota.split('?')[0];
  const alvo = semQuery === '/' ? '/index.html' : semQuery === '/favicon.ico' ? '/icone.svg' : semQuery;
  const caminho = path.normalize(path.join(PUBLICO, alvo));
  if (!caminho.startsWith(PUBLICO + path.sep)) return enviarJson(res, 400, { erro: 'caminho fora de public/' });
  fs.readFile(caminho, (erro, dados) => {
    if (erro) { inesperadas.push(`GET ${rota} (estático ausente: ${caminho})`); return enviarJson(res, 404, { erro: 'não encontrado' }); }
    const tipo = TIPOS[path.extname(caminho)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': tipo, 'content-length': dados.length });
    res.end(dados);
  });
}

function abrirSSE(req, res, chave) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive',
  });
  // D39 do split view: o multiplex mudou de `GET /api/abas/:chave/eventos` (sem envelope)
  // para `GET /api/eventos?abas=a,b,c` com `{aba, evento}` — o cliente (app.js:1342/:1351)
  // pede a rota nova e desembrulha o envelope. Este mock fala a rota velha, morta pela D39;
  // sem o conserto o navegador recebe 404 e o próprio smoke reprova.
  const evento = { tipo: 'sessao', meta: { titulo: TITULO, cwd: cwdFixture, contexto: null } };
  res.write(`data: ${JSON.stringify({ aba: chave, evento })}\n\n`);
  res.write(`data: ${JSON.stringify({ aba: chave, evento: { tipo: 'sincronizado', rodando: false } })}\n\n`);
  req.on('close', () => { try { res.end(); } catch { /* já fechado */ } });
}

const servidor = http.createServer(async (req, res) => {
  const rota = req.url;
  if (req.method !== 'GET') {
    naoGet.push(`${req.method} ${rota}`);
    return enviarJson(res, 405, { erro: 'este smoke bloqueia toda escrita — seleção nunca deveria chegar aqui' });
  }

  const semQuery = rota.split('?')[0];

  if (semQuery === '/api/abas') {
    return enviarJson(res, 200, { abas: [{
      chave: CHAVE, titulo: TITULO, cwd: cwdFixture, agente: 'codex',
      temAgente: true, temClaude: true, rodando: false, sessaoId: 'sess-codex-smoke', atualizadoEm: Date.now(),
    }] });
  }
  if (semQuery === '/api/eventos') {
    const chaves = String(new URL(rota, 'http://x').searchParams.get('abas') || '').split(',');
    return abrirSSE(req, res, chaves[0]);
  }
  if (semQuery === '/api/catalogo') {
    try {
      return enviarJson(res, 200, { itens: await catalogo.listar(cwdFixture, null, 'codex') });
    } catch {
      return enviarJson(res, 503, { erro: 'Não consegui carregar o catálogo. Tente novamente.' });
    }
  }
  if (semQuery === '/api/jobs') return enviarJson(res, 200, { jobs: [], painel: true });
  if (semQuery === '/api/limite') return enviarJson(res, 200, { itens: [], janelas: null, codex: null });
  if (semQuery === '/api/effort') return enviarJson(res, 200, { nivel: null });
  if (semQuery === '/api/agentes') {
    return enviarJson(res, 200, { agentes: [{ id: 'claude', rotulo: 'Claude Code' }, { id: 'codex', rotulo: 'Codex CLI' }], padrao: 'claude' });
  }
  if (semQuery === '/api/arquivos/pastas') return enviarJson(res, 200, { pastas: [{ nome: '_triagem' }], teto: 2147483648 });
  if (semQuery.startsWith('/api/')) {
    inesperadas.push(`GET ${rota}`);
    return enviarJson(res, 404, { erro: `rota não fabricada por este smoke: ${semQuery}` });
  }
  return servirEstatico(req, res, rota);
});

// ─── O roteiro do navegador, dentro do container ─────────────────────────────
const ROTEIRO = String.raw`
import puppeteer from '/app/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
const BASE = process.env.BASE;
const MODO = process.env.MODO;
const CHAVE = process.env.CHAVE;
const problemas = [];
const feitos = [];
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const navegador = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const pagina = await navegador.newPage();
await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

const erros = [];
pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 300)));
pagina.on('console', (m) => { if (m.type() === 'error') erros.push('CONSOLE: ' + m.text().slice(0, 300)); });
const requisicoesRuins = [];
pagina.on('response', (r) => { if (r.status() >= 400) requisicoesRuins.push(r.status() + ' ' + r.url()); });
const naoGet = [];
pagina.on('request', (r) => { if (r.method() !== 'GET') naoGet.push(r.method() + ' ' + r.url()); });

const limparCampo = async () => {
  await pagina.click('.painel .entrada', { clickCount: 3 });
  await pagina.keyboard.press('Backspace');
};

const nomeDoItem = async () => pagina.evaluate(() => Array.from(document.querySelectorAll('.painel .paleta .paleta-item')).map((b) => ({
  nome: b.querySelector('.paleta-nome b')?.textContent || '',
  tipo: b.querySelector('.paleta-tag')?.textContent || '',
  descricao: b.querySelector('.paleta-desc')?.textContent || '',
})));

try {
  await pagina.goto(BASE + '/#c=' + CHAVE, { waitUntil: 'networkidle2', timeout: 30000 });
  await pagina.waitForSelector('.painel .entrada', { timeout: 15000 });
  await espera(500);

  await pagina.type('.painel .entrada', '/cl', { delay: 15 });
  await pagina.waitForFunction(() => !document.querySelector('.painel .paleta').hidden, { timeout: 5000 });
  await espera(300);

  const largura = await pagina.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await pagina.evaluate(() => document.documentElement.clientWidth);
  if (largura > clientWidth) problemas.push('overflow horizontal: scrollWidth ' + largura + ' > clientWidth ' + clientWidth);

  if (MODO === 'antes') {
    const itens = await nomeDoItem();
    const temComando = itens.some((i) => i.nome === '/clear');
    if (!itens.some((i) => i.nome === '$clear')) problemas.push('MODO antes: catálogo não carregou a skill de controle $clear');
    if (temComando) problemas.push('MODO antes: /clear já aparece na paleta — o bug não está mais reproduzido: ' + JSON.stringify(itens));
    else feitos.push('MODO antes: /cl não mostra /clear — bug reproduzido (itens: ' + JSON.stringify(itens) + ')');
    await pagina.screenshot({ path: '/saida/antes.png' });
    feitos.push('antes.png salvo');
  } else {
    const itensBarra = await nomeDoItem();
    const clear = itensBarra.find((i) => i.nome === '/clear');
    if (!clear) problemas.push('MODO padrão: /clear não apareceu na paleta ao buscar /cl (itens: ' + JSON.stringify(itensBarra) + ')');
    else {
      if (clear.tipo !== 'comando') problemas.push('MODO padrão: /clear não está rotulado "comando" (tag="' + clear.tipo + '")');
      if (!clear.descricao) problemas.push('MODO padrão: /clear sem descrição na paleta');
      feitos.push('MODO padrão: /clear visível, tipo="' + clear.tipo + '", descrição="' + clear.descricao + '"');
    }
    const temSkillClear = itensBarra.some((i) => i.nome === '$clear');
    if (!temSkillClear) problemas.push('MODO padrão: /cl não mostrou a skill $clear (colisão de nome perdida): ' + JSON.stringify(itensBarra));
    await pagina.screenshot({ path: '/saida/depois.png' });
    feitos.push('depois.png salvo');

    // Seleção por toque: tap no botão /clear preenche a caixa, sem POST.
    const indiceClear = await pagina.evaluate(() => Array.from(document.querySelectorAll('.painel .paleta .paleta-item'))
      .findIndex((b) => b.querySelector('.paleta-nome b')?.textContent === '/clear'));
    if (indiceClear < 0) problemas.push('seleção: não achei o botão /clear para tocar');
    else {
      await pagina.tap('.painel .paleta .paleta-item:nth-child(' + (indiceClear + 1) + ')');
      await espera(300);
      const valor = await pagina.evaluate(() => document.querySelector('.painel .entrada').value);
      if (valor !== '/clear ') problemas.push('seleção por toque: caixa ficou "' + valor + '", esperava "/clear "');
      else feitos.push('toque em /clear preencheu a caixa com "/clear ", sem enviar');
    }

    // $cl busca só skills — mostra $clear, nunca o comando homônimo /clear.
    await limparCampo();
    await pagina.type('.painel .entrada', '$cl', { delay: 15 });
    await espera(400);
    const itensCifrao = await nomeDoItem();
    if (!itensCifrao.some((i) => i.nome === '$clear')) problemas.push('$cl: não mostrou $clear (itens: ' + JSON.stringify(itensCifrao) + ')');
    if (itensCifrao.some((i) => i.nome === '/clear')) problemas.push('$cl: mostrou o comando /clear indevidamente (itens: ' + JSON.stringify(itensCifrao) + ')');
    else feitos.push('$cl mostra só a skill $clear, sem o comando homônimo');

    // /hand continua selecionando a skill $handoff — a descoberta antiga não regrediu.
    await limparCampo();
    await pagina.type('.painel .entrada', '/hand', { delay: 15 });
    await espera(400);
    await pagina.tap('.painel .paleta .paleta-item:nth-child(1)');
    await espera(300);
    const valorHand = await pagina.evaluate(() => document.querySelector('.painel .entrada').value);
    if (valorHand !== '$handoff ') problemas.push('/hand: seleção deu "' + valorHand + '", esperava "$handoff "');
    else feitos.push('/hand seleciona $handoff — coexistência de prefixos preservada');
  }

  if (naoGet.length) problemas.push(naoGet.length + ' requisição(ões) não-GET (a seleção não devia enviar nada): ' + naoGet.slice(0, 5).join(' | '));
} catch (e) {
  problemas.push('o roteiro estourou: ' + String(e && e.message).slice(0, 300));
}

if (erros.length) problemas.push(erros.length + ' erro(s) de página/console: ' + erros.slice(0, 5).join(' | '));
if (requisicoesRuins.length) problemas.push(requisicoesRuins.length + ' requisição(ões) >=400: ' + requisicoesRuins.slice(0, 5).join(' | '));

await navegador.close();
console.log(JSON.stringify({ problemas, feitos }, null, 2));
process.exit(problemas.length ? 1 : 0);
`;

// ─── Corrida ─────────────────────────────────────────────────────────────────
(async () => {
  let codigoFinal = 1;
  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    await new Promise((resolve, reject) => {
      servidor.once('error', reject);
      servidor.listen(0, '127.0.0.1', resolve);
    });
    const porta = servidor.address().port;
    console.log(`  · servidor fabricado no ar em http://127.0.0.1:${porta} (MODO=${MODO})`);

    const roteiro = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-catalogo-codex-roteiro-'));
    temporarios.push(roteiro);
    const mjs = path.join(roteiro, 's.mjs');
    fs.writeFileSync(mjs, ROTEIRO);

    const args = [
      'run', '--rm', '--name', CONTAINER, '--entrypoint', 'node', '--network', 'host',
      '-e', `BASE=http://127.0.0.1:${porta}`, '-e', `MODO=${MODO}`, '-e', `CHAVE=${CHAVE}`,
      '-v', `${mjs}:/s.mjs:ro`, '-v', `${SAIDA}:/saida`, IMAGEM, '/s.mjs',
    ];
    // `spawn`, nunca `execFileSync`: o Docker corre em paralelo com o servidor fabricado, e
    // um `execFileSync` travaria o event loop deste MESMO processo — o servidor não
    // conseguiria responder a nenhuma requisição enquanto o navegador estivesse tentando
    // abrir a página, e a navegação estourava em "timeout" contra um servidor que nunca
    // atendeu (medido: o socket morre sem servir nada). `spawn` deixa os dois rodando juntos.
    const docker = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigoDocker = await new Promise((resolve) => {
      const prazo = setTimeout(() => { docker.kill('SIGKILL'); resolve(124); }, 120000);
      docker.on('error', () => { clearTimeout(prazo); resolve(1); });
      docker.on('close', (codigo) => { clearTimeout(prazo); resolve(codigo ?? 1); });
    });
    process.stdout.write(saidaDocker);

    let relatorio = null;
    const abre = saidaDocker.indexOf('{');
    if (abre >= 0) { try { relatorio = JSON.parse(saidaDocker.slice(abre)); } catch { relatorio = null; } }

    const problemas = [...(relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigoDocker})`])];
    if (codigoDocker !== 0) problemas.push(`processo do navegador terminou com código ${codigoDocker}`);
    if (inesperadas.length) problemas.push(`${inesperadas.length} requisição(ões) GET inesperada(s) no servidor: ${inesperadas.join(' | ')}`);
    if (naoGet.length) problemas.push(`${naoGet.length} requisição(ões) não-GET chegaram ao servidor (deviam ter sido zero): ${naoGet.join(' | ')}`);

    for (const f of (relatorio ? relatorio.feitos : [])) console.log(`  ✅ ${f}`);
    for (const p of problemas) console.error(`  ❌ ${p}`);

    codigoFinal = problemas.length ? 1 : 0;
    if (codigoFinal === 0) {
      console.log(`\n✅ SMOKE VERDE (MODO=${MODO}) — PNGs em ${SAIDA}`);
      console.log('FALTA AINDA, e não é automático: abrir os PNGs e OLHAR (regra de 25/08).');
    } else {
      console.error(`\n🔴 SMOKE VERMELHO (MODO=${MODO}) — ${problemas.length} problema(s)`);
    }
  } catch (e) {
    console.error('\n❌ o smoke quebrou:', e.message, '\n');
    codigoFinal = 1;
  } finally {
    // Matar o cliente docker não encerra o container. Remover somente o nome exclusivo deste smoke.
    try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore', timeout: 10000 }); } catch { /* --rm já removeu */ }
    servidor.closeAllConnections();
    await new Promise((resolve) => servidor.close(resolve));
    if (antigoBin === undefined) delete process.env.COCKPIT_BIN_CODEX; else process.env.COCKPIT_BIN_CODEX = antigoBin;
    if (antigoHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = antigoHome;
    for (const d of temporarios) fs.rmSync(d, { recursive: true, force: true });
  }
  process.exit(codigoFinal);
})();
