#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — /status do Codex chegando na conversa (390×844, tema escuro).
//
// Diferente de smoke-catalogo-codex.js: aqui é o `server.js` DE VERDADE que sobe (rota, SSE
// e `lib/status-codex.js` reais), com `lib/abas.js` DUBLADO no require.cache — mesmo padrão
// de testes/gate-status-codex.js §3. `consultarStatus` do duble nunca toca tmux; devolve um
// texto fabricado idêntico ao formato da fixture real da 0.153.4. A prova de BACKEND (parser,
// storage, HTTP/SSE) já está no gate; este smoke prova só o que só o navegador prova: o
// Cockpit mostra a resposta, sobrevive a uma recarga e nunca dispara POST de turno de modelo.
//
// Chromium roda em container Docker (--network host) com puppeteer-core, mesmo padrão de
// testes/smoke-catalogo-codex.js. Playwright não está instalado nesta máquina.
//
// Códigos de saída: 0 = verde · 1 = reprovou · 2 = ambiente indisponível (Docker/imagem ausente).
//
// Variáveis: SAIDA=pasta absoluta para os PNGs · IMAGEM (docker) · PORT (default 7896).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const RAIZ_DO_REPO = path.resolve(__dirname, '..');
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const SAIDA = path.resolve(process.env.SAIDA || path.join(os.tmpdir(), 'cockpit-status-shots'));
const CONTAINER = `cockpit-status-smoke-${process.pid}-${Date.now()}`;
const PORTA = Number(process.env.PORT || 7896);

const CHAVE = 'aba-codex-status-smoke';
const SESSAO_ID = 'sess-status-smoke';
const TITULO = 'cockpit-status-smoke';

const pular = (motivo) => { console.error(`\n⚠ SMOKE PULADO — ${motivo}\n`); process.exit(2); };
const rodaSaindoZero = (bin, args) => {
  try { execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 }); return true; } catch { return false; }
};
if (!rodaSaindoZero('docker', ['image', 'inspect', IMAGEM])) pular(`a imagem ${IMAGEM} não existe (IMAGEM=… para outra)`);

const temporarios = [];
const mk = (prefixo) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefixo)); temporarios.push(d); return d; };

// ─── Codex falso, para o /api/catalogo (a paleta abre ao digitar "/status") ──────────────
const binDir = mk('smoke-status-codex-bin-');
const bin = path.join(binDir, 'codex-falso');
fs.writeFileSync(bin, `#!/usr/bin/env node
require('readline').createInterface({input:process.stdin}).on('line',l=>{
 const m=JSON.parse(l);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='skills/list') console.log(JSON.stringify({id:m.id,result:{data:[{cwd:m.params.cwds[0],skills:[]}]}}));
});`, { mode: 0o700 });
const cwdFixture = mk('smoke-status-codex-cwd-');
const antigoBinCodex = process.env.COCKPIT_BIN_CODEX;
process.env.COCKPIT_BIN_CODEX = bin;

// ─── Storage isolado do /status, raiz própria fora de ~/.cockpit ─────────────────────────
const raizStatus = mk('smoke-status-codex-storage-');
process.env.COCKPIT_STATUS_CODEX_DIR = raizStatus;

// ─── O TEXTO fabricado, no mesmo FORMATO da fixture real da 0.153.4 ──────────────────────
const TEXTO_STATUS = `╭────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.153.4)                                        │
│                                                                    │
│  Model:                mock (reasoning none, summaries auto)       │
│  Model provider:       Fixture local - smoke                       │
│  Directory:            ${cwdFixture.padEnd(45)}│
│  Permissions:          Full Access                                 │
│  Session:              ${SESSAO_ID.padEnd(45)}│
│                                                                    │
│  Token usage:          0 total  (0 input + 0 output)               │
│  Limits:               not available for this account              │
╰────────────────────────────────────────────────────────────────────╯`;

// ─── lib/abas dublado: só o que o fluxo de /status encosta ───────────────────────────────
const chamadasConsultar = [];
let reiniciada = false;
const chamadasComando = [];
const arquivoHistorico = path.join(cwdFixture, 'historico.jsonl');
fs.writeFileSync(arquivoHistorico, JSON.stringify({type:'event_msg', timestamp:new Date().toISOString(), payload:{type:'item_completed', item:{type:'AgentMessage', content:[{type:'Text', text:'Resposta da conversa anterior.'}]}}}) + '\n');
const abasReais = require('../lib/abas');
const arquivoBash = path.join(cwdFixture, 'bash.jsonl');
fs.writeFileSync(arquivoBash, JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),message:{content:[{type:'text',text:'Conversa de teste do comando local.'}]}})+'\n');
let bashRodando = true;
const abaBash = () => ({chave:'aba-claude-bash', titulo:'Claude — comando local', cwd:cwdFixture, agente:'claude', temAgente:true, temClaude:true, rodando:bashRodando, esperando:false, sessaoId:'bash-fixture', arquivo:arquivoBash});
const dubleAbas = {
  ...require(path.join(RAIZ_DO_REPO, 'lib', 'abas.js')),
  listar: async () => [{
    chave: CHAVE, titulo: TITULO, cwd: cwdFixture, agente: 'codex',
    temAgente: true, temClaude: false, rodando: false, esperando: false,
    sessaoId: reiniciada ? null : SESSAO_ID, reiniciada, casamento: reiniciada ? 'nenhum' : 'ok', atualizadoEm: Date.now(),
  }, abaBash()],
  buscar: async (chave) => (chave === CHAVE ? {
    chave: CHAVE, titulo: TITULO, cwd: cwdFixture, agente: 'codex',
    temAgente: true, rodando: false, esperando: false, sessaoId: reiniciada ? null : SESSAO_ID, arquivo: reiniciada ? null : arquivoHistorico, pane: '%1', reiniciada, casamento: reiniciada ? 'nenhum' : 'ok',
  } : chave === 'aba-claude-bash' ? abaBash() : null),
  enviar: async (chave, texto, anexos, id) => {
    if (chave === 'aba-claude-bash') {
      const ficha = abasReais.registrarPendente(chave, {id, texto, mensagem:texto});
      setTimeout(() => {
        fs.appendFileSync(arquivoBash, JSON.stringify({type:'user',timestamp:new Date().toISOString(),message:{content:'<bash-input>'+texto.slice(1)+'</bash-input>'}})+'\n');
        bashRodando = false;
      }, 1400);
      return {enviado:true, ficha};
    }
    chamadasComando.push(texto);
    await new Promise(r => setTimeout(r, 400));
    if (texto === '/clear') reiniciada = true;
    return { enviado:true, comando:texto, id };
  },
  idValido: (id) => /^[\w-]{1,64}$/.test(String(id)),
  pendentesDe: abasReais.pendentesDe,
  paraCliente: (a) => a,
  abasDoProjeto: () => [],
  consultarStatus: async (chave, id) => {
    chamadasConsultar.push({ chave, id, em: Date.now() });
    await new Promise((r) => setTimeout(r, 400));   // latência real de digitar + Enter + poll
    return (await require('../lib/status-codex').registrarSnapshot(SESSAO_ID, { id, texto: TEXTO_STATUS, quando: new Date().toISOString() })).snapshot;
  },
};
require.cache[require.resolve(path.join(RAIZ_DO_REPO, 'lib', 'abas.js'))] = {
  id: require.resolve(path.join(RAIZ_DO_REPO, 'lib', 'abas.js')),
  filename: require.resolve(path.join(RAIZ_DO_REPO, 'lib', 'abas.js')),
  loaded: true,
  exports: dubleAbas,
};

process.env.PORT = String(PORTA);
process.env.HOST = '127.0.0.1';
process.env.COCKPIT_CERT_DIR = '/dev/null';
process.env.COCKPIT_TOKEN = '';
process.env.COCKPIT_JOBS_DIR = path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`); // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
process.env.COCKPIT_VIGIA_MS = '0'; // sem HOME falso aqui — cinto e suspensório

// ─── O roteiro do navegador, dentro do container ─────────────────────────────
const ROTEIRO = String.raw`
import puppeteer from '/app/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
const BASE = process.env.BASE;
const CHAVE = process.env.CHAVE;
const SESSAO_ID = process.env.SESSAO_ID;
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
const postsVistos = [];
pagina.on('request', (r) => { if (r.method() !== 'GET') postsVistos.push(r.method() + ' ' + r.url()); });

const temBloco = () => pagina.evaluate(() => {
  const b = document.querySelector('.status-codex');
  if (!b) return null;
  return {
    titulo: b.querySelector('.status-codex-titulo')?.textContent || '',
    itens: Array.from(b.querySelectorAll('.status-codex-item')).length,
    texto: b.querySelector('.status-codex-texto')?.textContent || '',
  };
});

try {
  await pagina.goto(BASE + '/#c=' + CHAVE, { waitUntil: 'networkidle2', timeout: 30000 });
  await pagina.waitForSelector('.painel .entrada', { timeout: 15000 });
  await espera(600);   // SSE inicial (sessao/sincronizado) chega

  if (!await pagina.$eval('.painel .fita', e => e.textContent.includes('Resposta da conversa anterior.'))) problemas.push('fixture de histórico não apareceu antes do clear');
  const antes = await temBloco();
  if (antes !== null) problemas.push('ANTES da consulta já existia bloco .status-codex — não devia');
  else feitos.push('antes: histórico presente, sem bloco de status');
  await pagina.screenshot({ path: '/saida/antes.png' });
  feitos.push('antes.png salvo');

  await pagina.type('.painel .entrada', '/status', { delay: 20 });
  await pagina.keyboard.press('Escape');   // fecha a paleta, se abriu — não interfere no clique
  await espera(200);
  await pagina.click('.painel .btn-enviar');

  await pagina.waitForFunction(() => document.querySelector('.status-codex-item'), { timeout: 8000 });
  await espera(300);

  const depois = await temBloco();
  if (!depois) problemas.push('DEPOIS da consulta: bloco .status-codex não apareceu');
  else {
    if (depois.itens !== 1) problemas.push('DEPOIS: esperava 1 item, achei ' + depois.itens);
    if (!depois.titulo.includes('Resultados de /status')) problemas.push('DEPOIS: título errado: "' + depois.titulo + '"');
    if (!depois.texto.includes(SESSAO_ID)) problemas.push('DEPOIS: texto não traz a Session esperada: ' + JSON.stringify(depois.texto).slice(0, 200));
    if (!depois.texto.includes('Token usage')) problemas.push('DEPOIS: texto não parece o bloco literal do CLI');
    if (!problemas.length) feitos.push('depois: bloco "Resultados de /status" com 1 item, texto literal da Session esperada');
  }
  const medidas = await pagina.evaluate(() => ({pagina:document.documentElement.scrollWidth,
    largura:window.innerWidth,bloco:document.querySelector('.status-codex').getBoundingClientRect().width,
    hora:document.querySelector('.status-codex-item summary span').textContent,
    id:document.querySelector('.status-codex-item').dataset.id}));
  if(medidas.pagina > medidas.largura + 1 || medidas.bloco > medidas.largura) problemas.push('overflow horizontal da página');
  if(!/\d{2}:\d{2}/.test(medidas.hora)) problemas.push('horário ausente');
  const idSalvo = medidas.id;
  await pagina.screenshot({ path: '/saida/depois.png' });
  feitos.push('depois.png salvo');

  const postsDeStatus = postsVistos.filter((p) => p.includes('/status') && p.startsWith('POST'));
  const postsDeTurno = postsVistos.filter((p) => p.includes('/turnos'));
  if (postsDeStatus.length !== 1) problemas.push('esperava exatamente 1 POST de /status, vi ' + postsDeStatus.length + ': ' + JSON.stringify(postsDeStatus));
  if (postsDeTurno.length) problemas.push('POST de /turnos não devia acontecer nunca aqui: ' + JSON.stringify(postsDeTurno));
  else feitos.push('zero POST /turnos — /status nunca vira conversa com o modelo');

  // Recarga: nova navegação para a MESMA aba. O servidor persiste o snapshot (lib/status-codex
  // real) e o SSE faz replay — o item tem que reaparecer, sem duplicar.
  await pagina.goto(BASE + '/#c=' + CHAVE, { waitUntil: 'networkidle2', timeout: 30000 });
  await pagina.waitForSelector('.painel .entrada', { timeout: 15000 });
  await espera(700);
  const aposRecarga = await temBloco();
  if (!aposRecarga) problemas.push('depois de recarregar: bloco de status sumiu — a persistência não sobreviveu');
  else if (aposRecarga.itens !== 1) problemas.push('depois de recarregar: esperava 1 item (replay sem duplicar), achei ' + aposRecarga.itens);
  else feitos.push('depois de recarregar: o mesmo resultado volta pelo replay do SSE, sem duplicar');
  if(await pagina.$eval('.status-codex-item',e=>e.dataset.id)!==idSalvo) problemas.push('recarga mudou ID do snapshot');
  await pagina.screenshot({ path: '/saida/recarga.png' });
  feitos.push('recarga.png salvo');

  // Um segundo aparelho fica no SSE antigo: também precisa receber o reset.
  const outra = await navegador.newPage();
  await outra.goto(BASE + '/#c=' + CHAVE, {waitUntil:'networkidle2'});
  await outra.waitForSelector('.status-codex-item', {timeout:10000});
  await pagina.bringToFront();
  await pagina.type('.painel .entrada', '/clear');
  await pagina.click('.painel .btn-enviar');
  await espera(100);
  if (await pagina.$('.pendente, .trabalhando')) problemas.push('/clear criou fila ou trabalho do modelo');
  // Classe, nunca id: o aviso do agente foi para dentro do painel na fase 2 do split (08/09) e
  // este seletor ficou para tras — TERCEIRA quebra herdada neste arquivo, junto com a fita e o
  // mock de SSE na rota que a D39 matou. Com polling de 100ms num timeout de 10s, o
  // null.textContent estourava 97 vezes e o smoke reprovava pelo ERRO DE CONSOLE, nao pelo
  // assert: barulho que esconde o sinal. O ?. e a rede — sem o aviso na tela a condicao fica
  // falsa e o waitForFunction espera, em vez de explodir.
  await pagina.waitForFunction(() => !document.querySelector('.status-codex-item') && document.querySelector('.painel .aviso-agente')?.textContent.includes('Conversa limpa'), {polling:100, timeout:10000});
  await outra.waitForFunction(() => !document.querySelector('.status-codex-item'), {polling:100, timeout:7000});
  if (await outra.$eval('.painel .fita', e => e.textContent.includes('Resposta da conversa anterior.'))) problemas.push('outro aparelho reteve histórico velho');
  if (await pagina.$('.pendente, .trabalhando')) problemas.push('depois de /clear sobrou fila ou trabalho');
  await pagina.screenshot({path:'/saida/clear.png'});
  await pagina.goto(BASE + '/#c=' + CHAVE, {waitUntil:'networkidle2'});
  await espera(600);
  if (await pagina.$('.status-codex-item, .pendente, .trabalhando')) problemas.push('recarga após clear herdou status/fila/trabalho');
  if (await pagina.$eval('.painel .fita', e => e.textContent.includes('Resposta da conversa anterior.'))) problemas.push('recarga trouxe histórico antigo');
  await pagina.screenshot({path:'/saida/clear-recarga.png'});
  for (const comando of ['/diff', '/compact']) {
    await pagina.type('.painel .entrada', comando);
    await pagina.click('.painel .btn-enviar');
    await espera(650);
    if (await pagina.$('.pendente, .trabalhando')) problemas.push(comando + ' virou mensagem pendente');
  }
  feitos.push('/clear limpa histórico/status nos dois aparelhos e na recarga; comandos nativos sem fila falsa');
  await outra.close();

  await pagina.goto(BASE + '/#c=aba-claude-bash', {waitUntil:'networkidle2'});
  await pagina.type('.painel .entrada', "! printf 'fixture'");
  await pagina.click('.painel .btn-enviar');
  await pagina.waitForSelector('.bolha-pendente[data-fila]');
  await pagina.screenshot({path:'/saida/bash-antes.png'});
  await pagina.waitForFunction(() => !document.querySelector('.bolha-pendente, .trabalhando'), {polling:100,timeout:8000});
  const comandosBash = () => pagina.$$eval('.bolha-eu', es => es.filter(e => e.textContent.includes("! printf 'fixture'")).length);
  if (await comandosBash() !== 1) problemas.push('eco bash duplicou ou perdeu mensagem');
  await pagina.screenshot({path:'/saida/bash-depois.png'});
  await pagina.goto(BASE + '/#c=aba-claude-bash', {waitUntil:'networkidle2'});
  await espera(500);
  if (await pagina.$('.bolha-pendente') || await comandosBash() !== 1) problemas.push('bash voltou à fila ou duplicou na recarga');
  await pagina.screenshot({path:'/saida/bash-recarga.png'});
  feitos.push('eco bash reconhecido: comando sai da fila, aparece uma vez e permanece correto na recarga');

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
    require(path.join(RAIZ_DO_REPO, 'server.js'));
    await new Promise((r) => setTimeout(r, 500));
    console.log(`  · server.js real no ar em http://127.0.0.1:${PORTA} (lib/abas dublado)`);

    const roteiro = mk('smoke-status-codex-roteiro-');
    const mjs = path.join(roteiro, 's.mjs');
    fs.writeFileSync(mjs, ROTEIRO);

    const args = [
      'run', '--rm', '--name', CONTAINER, '--entrypoint', 'node', '--network', 'host',
      '-e', `BASE=http://127.0.0.1:${PORTA}`, '-e', `CHAVE=${CHAVE}`, '-e', `SESSAO_ID=${SESSAO_ID}`,
      '-v', `${mjs}:/s.mjs:ro`, '-v', `${SAIDA}:/saida`, IMAGEM, '/s.mjs',
    ];
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
    if (JSON.stringify(chamadasComando) !== JSON.stringify(['/clear','/diff','/compact'])) problemas.push('comandos esperados não chegaram ao backend');
    if (chamadasConsultar.length < 1) problemas.push('consultarStatus (duble) nunca foi chamado — a rota não disparou o fluxo');

    for (const f of (relatorio ? relatorio.feitos : [])) console.log(`  ✅ ${f}`);
    for (const p of problemas) console.error(`  ❌ ${p}`);

    codigoFinal = problemas.length ? 1 : 0;
    if (codigoFinal === 0) {
      console.log(`\n✅ SMOKE VERDE — PNGs em ${SAIDA}`);
      console.log('FALTA AINDA, e não é automático: abrir os PNGs e OLHAR (regra de 25/08).');
    } else {
      console.error(`\n🔴 SMOKE VERMELHO — ${problemas.length} problema(s)`);
    }
  } catch (e) {
    console.error('\n❌ o smoke quebrou:', e.message, '\n');
    codigoFinal = 1;
  } finally {
    try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore', timeout: 10000 }); } catch { /* --rm já removeu */ }
    if (antigoBinCodex === undefined) delete process.env.COCKPIT_BIN_CODEX; else process.env.COCKPIT_BIN_CODEX = antigoBinCodex;
    for (const d of temporarios) fs.rmSync(d, { recursive: true, force: true });
  }
  process.exit(codigoFinal);
})();
