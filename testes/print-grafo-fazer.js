#!/usr/bin/env node
'use strict';
// PRINT DO BOTÃO "FAZER GRAFO" (card `grafo-botao-fazer-grafo`, plano `2026-10-17-grafo-botao-
// fazer-grafo`, Fase 4). Mudou pixel, tem print: a linha com develop e sem grafo mostra o botão
// "Fazer grafo"; tocar mostra "gerando…" (botão inativo); reabrir o diálogo NUMA PÁGINA RECARREGADA
// enquanto gera mostra "gerando…" vindo só do servidor (o `emCurso` local morreu com a página); a
// geração termina em "em dia" com o botão "Grafo" ativo; falha e aviso de hook aparecem numa linha
// própria (`.grafos-msg`).
//
// Fixture PRÓPRIA (nomes neutros, mkdtemp): `app-exemplo` (develop, 3 JS encadeados), `app-quebrado`
// (árvore raiz apagada — `gerar` falha), `app-hookspath` (core.hooksPath — hook recusado = aviso),
// `app-sem-develop` (só main — sem botão ativo, D88). Sobe `server.js` FILHO (nunca `require`),
// ambiente FECHADO (molde `gate-grafo-fazer.js`/`print-grafo.js`): HOME, COCKPIT_PROJETOS_DIR,
// COCKPIT_GRAFOS_DIR, COCKPIT_GRAFO_COPIA_DIR sempre no tmp, A10/M-rede isolados.
//
// Uso (modo print — tira os PNGs e sai):
//   SAIDA=<pasta nova, vazia> PUPPETEER_CORE=<pasta do puppeteer-core> CHROME_BIN=<executável do
//   chrome> [CODIGO_DIR=<raiz do server.js, padrão: este repo>] [PORTA=7943] node testes/print-grafo-fazer.js
//
// Uso (modo servidor — só sobe o servidor pro percurso do wrapper de smoke de navegador, sem puppeteer):
//   SO_SERVIDOR=1 [CODIGO_DIR=...] [PORTA=7943] node testes/print-grafo-fazer.js
//   (imprime "URL=http://127.0.0.1:7943" e fica de pé até SIGTERM/SIGINT; SEM COCKPIT_GRAFO_TESTE_LENTO
//   — a geração leva < 1 s, com folga para o `esperar: 8000` do percurso.)
//
// Códigos de saída: 0 = PNGs gravados e resultado.json escrito · 1 = cenário reprovado (sem o botão,
// sem o aviso/erro…) · 2 = ambiente (env obrigatória faltando).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA || '';
const CODIGO_DIR = process.env.CODIGO_DIR || path.join(__dirname, '..');
const PORTA = process.env.PORTA ? Number(process.env.PORTA) : 7943;
const SO_SERVIDOR = process.env.SO_SERVIDOR === '1';
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const TETO_CURTO_MS = 2000;
const TETO_LONGO_MS = 30000;

// ─── Fail-closed antes de tocar em qualquer coisa ───────────────────────────

if (PORTA !== 7943) { console.error(`🟡 PORTA só aceita 7943 (achei ${PORTA}).`); process.exit(2); }
if (!SO_SERVIDOR) {
  if (!SAIDA) { console.error('🟡 ambiente indisponível: SAIDA é obrigatória (pasta nova dos PNGs).'); process.exit(2); }
  if (!PUPPETEER || !CHROME) {
    console.error('🟡 ambiente indisponível: PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
    process.exit(2);
  }
}
let puppeteer = null;
if (!SO_SERVIDOR) {
  try { puppeteer = require(PUPPETEER); } catch (e) {
    console.error(`🟡 ambiente indisponível: não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`);
    process.exit(2);
  }
  if (!fs.existsSync(CHROME)) { console.error('🟡 ambiente indisponível: CHROME_BIN não existe.'); process.exit(2); }
}
const SERVER_JS = path.join(CODIGO_DIR, 'server.js');
if (!fs.existsSync(SERVER_JS)) { console.error(`🟡 CODIGO_DIR não tem o servidor (${SERVER_JS}).`); process.exit(2); }

function confereLivre() {
  let saida = '';
  try { saida = execSync('ss -H -lptn', { encoding: 'utf8' }); } catch { return; }
  if (new RegExp(`:${PORTA}\\b`).test(saida)) {
    console.error(`🔴 porta ${PORTA} ocupada — não posso rodar\n${saida}`);
    process.exit(1);
  }
}
confereLivre();

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarCond(fn, tetoMs, intervaloMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 >= tetoMs) return await fn();
    await espera(intervaloMs);
  }
}

function pedirHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── Fixture própria (nomes neutros) ────────────────────────────────────────

function git(repo, args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=print', '-c', 'user.email=print@example.com', ...args], { encoding: 'utf8' });
}
function novoRepo(projetosDir, nome, branchInicial) {
  const repo = path.join(projetosDir, nome);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', branchInicial || 'develop']);
  return repo;
}
function escreverEComitar(repo, arquivos, msg) {
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(repo, nome)), { recursive: true });
    fs.writeFileSync(path.join(repo, nome), conteudo);
  }
  git(repo, ['add', ...Object.keys(arquivos)]);
  git(repo, ['commit', '-q', '-m', msg]);
}
function quebrarArvoreRaiz(repo) {
  const treeSha = git(repo, ['rev-parse', 'develop^{tree}']).trim();
  const obj = path.join(repo, '.git', 'objects', treeSha.slice(0, 2), treeSha.slice(2));
  fs.rmSync(obj, { force: true });
}

function montarFixture(scratch) {
  const projetosDir = path.join(scratch, 'projetos');
  const grafosDir = path.join(scratch, 'grafos');
  const copiaDir = path.join(scratch, 'copia');
  fs.mkdirSync(projetosDir, { recursive: true });
  fs.mkdirSync(grafosDir, { recursive: true });
  fs.mkdirSync(copiaDir, { recursive: true });

  const appExemplo = novoRepo(projetosDir, 'app-exemplo', 'develop');
  escreverEComitar(appExemplo, {
    'a.js': "import './b.js';\n",
    'b.js': "import './c.js';\nexport function b() {}\n",
    'c.js': 'export function c() {}\n',
  }, 'c1');

  const appQuebrado = novoRepo(projetosDir, 'app-quebrado', 'develop');
  escreverEComitar(appQuebrado, { 'a.js': 'export function f() {}\n' }, 'c1');
  quebrarArvoreRaiz(appQuebrado);

  const appHookspath = novoRepo(projetosDir, 'app-hookspath', 'develop');
  escreverEComitar(appHookspath, { 'a.js': 'export function f() {}\n' }, 'c1');
  git(appHookspath, ['config', 'core.hooksPath', '.meus-hooks']);

  const appSemDevelop = novoRepo(projetosDir, 'app-sem-develop', 'main');
  escreverEComitar(appSemDevelop, { 'a.js': 'export function f() {}\n' }, 'c1');

  return { projetosDir, grafosDir, copiaDir };
}

// ─── Servidor filho (ambiente fechado, molde gate-grafo-fazer.js/print-grafo.js) ────────────

function subirServidor({ projetosDir, grafosDir, copiaDir, scratch, extraEnv }) {
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home, { recursive: true });
  const ambiente = {
    PATH: process.env.PATH,
    HOME: home, HOST: '127.0.0.1', PORT: String(PORTA),
    COCKPIT_CERT_DIR: '/dev/null', // #19: HTTP puro
    COCKPIT_PROJETOS_DIR: projetosDir,
    COCKPIT_GRAFOS_DIR: grafosDir,
    COCKPIT_GRAFO_COPIA_DIR: copiaDir,
    COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'), // A10
    COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'), COCKPIT_MONITOR_MS: '0', // M-rede
    COCKPIT_VIGIA_MS: '0',
    COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
    COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
    COCKPIT_LEITURAS_DIR: path.join(scratch, 'leituras'),
    COCKPIT_TMUX_SOCKET: `print-grafo-fazer-${process.pid}`,
    COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
    COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
    ...(extraEnv || {}),
  };
  return spawn(process.execPath, [SERVER_JS], { cwd: CODIGO_DIR, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
}

// ─── Interação com o diálogo ─────────────────────────────────────────────────
// `desenhar()` (public/grafo.js) faz `lista.replaceChildren()` a CADA mudança de estado — um
// ElementHandle capturado antes de um clique fica apontando para um nó DESCARTADO logo depois.
// Por isso toda leitura/ação é por `evaluate`, que relê a lista no DOM vivo a cada chamada.

/** `{ texto, botao: {texto, disabled, acao}|null, msg: {texto, classe}|null }` da linha com
 * `.grafos-nome === nome`, ou `null` se a linha não existe agora. */
async function infoLinha(pagina, nome) {
  return pagina.evaluate((n) => {
    const linhas = Array.from(document.querySelectorAll('#dialogo-grafos .grafos-linha'));
    const l = linhas.find((x) => { const e = x.querySelector('.grafos-nome'); return e && e.textContent === n; });
    if (!l) return null;
    const estado = l.querySelector('.grafos-estado');
    const botao = l.querySelector('.grafos-abrir');
    const msg = l.querySelector('.grafos-msg');
    return {
      texto: estado ? estado.textContent : '',
      botao: botao ? { texto: botao.textContent, disabled: botao.disabled, acao: botao.dataset.acao || null } : null,
      msg: msg ? { texto: msg.textContent, classe: msg.className } : null,
    };
  }, nome);
}
/** Clique de verdade (DOM) no botão da linha — relido no DOM vivo, nunca um handle velho. */
async function clicarBotaoDaLinha(pagina, nome) {
  return pagina.evaluate((n) => {
    const linhas = Array.from(document.querySelectorAll('#dialogo-grafos .grafos-linha'));
    const l = linhas.find((x) => { const e = x.querySelector('.grafos-nome'); return e && e.textContent === n; });
    const botao = l && l.querySelector('.grafos-abrir');
    if (botao) botao.click();
    return Boolean(botao);
  }, nome);
}
/** `scrollIntoView` na linha (dentro da `.grafos-lista` com scroll próprio) + esperar animações zerarem. */
async function centralizarLinha(pagina, nome) {
  await pagina.evaluate((n) => {
    const linhas = Array.from(document.querySelectorAll('#dialogo-grafos .grafos-linha'));
    const l = linhas.find((x) => { const e = x.querySelector('.grafos-nome'); return e && e.textContent === n; });
    if (l) l.scrollIntoView({ block: 'center' });
  }, nome);
  await pagina.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
}

async function roteiro(base, saida) {
  const problemas = [];
  const passos = [];
  const pngs = [];
  const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  function falhar(motivo) { problemas.push(motivo); console.error(`  ❌ ${motivo}`); }
  async function printar(pagina, nome) {
    const arq = path.join(saida, `${nome}.png`);
    await pagina.screenshot({ path: arq });
    pngs.push(arq);
    console.log(`  ✅ ${arq}`);
    return arq;
  }
  try {
    let pagina = await navegador.newPage();
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* vale nesta página */ } });
    await pagina.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });

    // ─── 1. Abrir o diálogo; exigir a linha app-exemplo → 01-antes.png (SEMPRE) ──────────────
    await pagina.waitForSelector('#btn-grafos', { visible: true, timeout: 10000 });
    await pagina.click('#btn-grafos');
    await pagina.waitForSelector('#dialogo-grafos[open] .grafos-linha', { timeout: 10000 });
    await espera(400); // "Carregando…" vira as linhas de verdade
    let info = await infoLinha(pagina, 'app-exemplo');
    if (!info) { falhar('a linha app-exemplo não apareceu no diálogo'); await printar(pagina, '01-antes'); return { passos, problemas, pngs }; }
    await centralizarLinha(pagina, 'app-exemplo');
    await printar(pagina, '01-antes');
    passos.push({ passo: '01-antes', texto: info.texto });

    // ─── 2. Exigir o botão "Fazer grafo" ativo — É AQUI QUE O CONTROLE NEGATIVO CAI ──────────
    if (!info.botao || info.botao.texto !== 'Fazer grafo' || info.botao.disabled) {
      falhar(`sem o botão Fazer grafo (achei ${JSON.stringify(info.botao)})`);
      return { passos, problemas, pngs };
    }
    await printar(pagina, '02-fazer-grafo');
    passos.push({ passo: '02-fazer-grafo', texto: info.texto, botao: info.botao });

    // ─── 3. Clicar; exigir "gerando…" em até 2 s ─────────────────────────────────────────────
    await clicarBotaoDaLinha(pagina, 'app-exemplo');
    const ficouGerando = await esperarCond(async () => (info = await infoLinha(pagina, 'app-exemplo')) && info.texto === 'gerando…' && info.botao && info.botao.disabled, TETO_CURTO_MS, 100);
    if (!ficouGerando) { falhar(`"gerando…" com o botão desabilitado não apareceu em ${TETO_CURTO_MS}ms (achei ${JSON.stringify(info)})`); return { passos, problemas, pngs }; }
    await centralizarLinha(pagina, 'app-exemplo');
    await printar(pagina, '03-gerando');
    passos.push({ passo: '03-gerando', texto: info.texto, botao: info.botao });

    // ─── 3b. Reabertura NUMA PÁGINA RECARREGADA — o emCurso local morre, só o GET prova ──────
    await pagina.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#btn-grafos', { visible: true, timeout: 10000 });
    await pagina.click('#btn-grafos');
    await pagina.waitForSelector('#dialogo-grafos[open] .grafos-linha', { timeout: 10000 });
    const reabriuGerando = await esperarCond(async () => (info = await infoLinha(pagina, 'app-exemplo')) && info.texto === 'gerando…', TETO_CURTO_MS, 100);
    if (!reabriuGerando) { falhar(`reabertura: "gerando…" não veio do GET em ${TETO_CURTO_MS}ms (achei ${JSON.stringify(info)})`); return { passos, problemas, pngs }; }
    await centralizarLinha(pagina, 'app-exemplo');
    await printar(pagina, '03b-reaberto-gerando');
    passos.push({ passo: '03b-reaberto-gerando', texto: info.texto });

    // ─── 4. Em até 30 s, "em dia" + botão Grafo ativo (NESTA página recarregada) ─────────────
    const chegouEmDia = await esperarCond(async () => (info = await infoLinha(pagina, 'app-exemplo')) && info.texto.includes('em dia'), TETO_LONGO_MS, 300);
    if (!chegouEmDia) { falhar(`"em dia" não chegou em ${TETO_LONGO_MS}ms (achei ${JSON.stringify(info)})`); return { passos, problemas, pngs }; }
    if (!info.botao || info.botao.texto !== 'Grafo' || info.botao.disabled) falhar(`botão Grafo não ficou ativo (achei ${JSON.stringify(info.botao)})`);
    await centralizarLinha(pagina, 'app-exemplo');
    await printar(pagina, '04-em-dia');
    passos.push({ passo: '04-em-dia', texto: info.texto, botao: info.botao });
    if (problemas.length) return { passos, problemas, pngs };

    // ─── 5. app-quebrado: clicar; em até 30 s, .grafos-msg.erro + botão Fazer grafo de volta ──
    const infoQuebradoAntes = await infoLinha(pagina, 'app-quebrado');
    if (!infoQuebradoAntes) { falhar('a linha app-quebrado não apareceu'); return { passos, problemas, pngs }; }
    await centralizarLinha(pagina, 'app-quebrado');
    await clicarBotaoDaLinha(pagina, 'app-quebrado');
    let infoQuebrado;
    const deuErro = await esperarCond(async () => {
      infoQuebrado = await infoLinha(pagina, 'app-quebrado');
      return Boolean(infoQuebrado && infoQuebrado.msg && infoQuebrado.msg.classe.includes('erro') && infoQuebrado.msg.texto.trim().length > 0);
    }, TETO_LONGO_MS, 300);
    if (!deuErro) { falhar(`.grafos-msg.erro não apareceu em ${TETO_LONGO_MS}ms (achei ${JSON.stringify(infoQuebrado)})`); return { passos, problemas, pngs }; }
    if (!infoQuebrado.botao || infoQuebrado.botao.texto !== 'Fazer grafo' || infoQuebrado.botao.disabled) {
      falhar(`botão "Fazer grafo" não voltou ativo depois do erro (achei ${JSON.stringify(infoQuebrado.botao)})`);
    }
    await centralizarLinha(pagina, 'app-quebrado');
    await printar(pagina, '05-erro');
    passos.push({ passo: '05-erro', texto: infoQuebrado.texto, msg: infoQuebrado.msg });
    if (problemas.length) return { passos, problemas, pngs };

    // ─── 6. app-hookspath: clicar; em até 30 s, "em dia" + .grafos-msg.aviso ─────────────────
    const infoHookspathAntes = await infoLinha(pagina, 'app-hookspath');
    if (!infoHookspathAntes) { falhar('a linha app-hookspath não apareceu'); return { passos, problemas, pngs }; }
    await centralizarLinha(pagina, 'app-hookspath');
    await clicarBotaoDaLinha(pagina, 'app-hookspath');
    let infoHookspath;
    const deuAviso = await esperarCond(async () => {
      infoHookspath = await infoLinha(pagina, 'app-hookspath');
      return Boolean(infoHookspath && infoHookspath.texto.includes('em dia') && infoHookspath.msg && infoHookspath.msg.classe.includes('aviso'));
    }, TETO_LONGO_MS, 300);
    if (!deuAviso) { falhar(`"em dia" + .grafos-msg.aviso não apareceram em ${TETO_LONGO_MS}ms (achei ${JSON.stringify(infoHookspath)})`); return { passos, problemas, pngs }; }
    await centralizarLinha(pagina, 'app-hookspath');
    await printar(pagina, '06-aviso');
    passos.push({ passo: '06-aviso', texto: infoHookspath.texto, msg: infoHookspath.msg });
  } catch (e) {
    falhar(`o roteiro estourou — ${String(e && e.message).slice(0, 300)}`);
  } finally {
    await navegador.close().catch(() => {});
  }
  return { passos, problemas, pngs };
}

// ─── Corrida ────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let scratch = null;
  let encerrando = false;

  function derrubarServidor() {
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
  }
  function limpar() {
    derrubarServidor();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-grafo-fazer-'));
    const fixture = montarFixture(scratch);

    if (SO_SERVIDOR) {
      // SEM COCKPIT_GRAFO_TESTE_LENTO: a geração leva < 1 s — o `esperar: 8000` do percurso tem folga.
      servidor = subirServidor({ ...fixture, scratch });
      let saidaErro = '';
      servidor.stderr.on('data', (d) => { saidaErro += d; });
      let pronto = false;
      for (let i = 0; i < 100 && !pronto; i += 1) {
        if (servidor.exitCode !== null) break;
        pronto = await pedirHealth();
        if (!pronto) await espera(100);
      }
      if (!pronto) { console.error(`🔴 o servidor (${PORTA}) não subiu — ${saidaErro}`); limpar(); return process.exit(1); }
      console.log(`URL=http://127.0.0.1:${PORTA}`);
      process.on('SIGTERM', () => { if (!encerrando) { encerrando = true; limpar(); process.exit(0); } });
      process.on('SIGINT', () => { if (!encerrando) { encerrando = true; limpar(); process.exit(0); } });
      await new Promise(() => {}); // só volta por SIGTERM/SIGINT
      return;
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      limpar();
      return process.exit(2);
    }

    // Dá tempo de fotografar "gerando…" e de fechar/reabrir o diálogo — só vale porque a loja está no tmp.
    servidor = subirServidor({ ...fixture, scratch, extraEnv: { COCKPIT_GRAFO_TESTE_LENTO: '6000' } });
    let saidaErro = '';
    servidor.stderr.on('data', (d) => { saidaErro += d; });
    let pronto = false;
    for (let i = 0; i < 100 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await pedirHealth();
      if (!pronto) await espera(100);
    }
    if (!pronto) { console.error(`🔴 o servidor (${PORTA}) não subiu — ${saidaErro}`); limpar(); return process.exit(1); }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid})`);

    const { passos, problemas, pngs } = await roteiro(`http://127.0.0.1:${PORTA}`, SAIDA);

    const resultado = { veredito: problemas.length ? 'reprovado' : 'ok', problemas, passos, pngs };
    fs.writeFileSync(path.join(SAIDA, 'resultado.json'), JSON.stringify(resultado, null, 2));
    console.log(`  · resultado.json gravado em ${path.join(SAIDA, 'resultado.json')}`);

    limpar();
    return process.exit(problemas.length ? 1 : 0);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
