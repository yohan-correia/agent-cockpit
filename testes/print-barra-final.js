#!/usr/bin/env node
'use strict';
// PRINT DO CARD `fila-presa-com-barra-invertida-no-fim` — celular 390x844, CLI real, claro e escuro.
//
// O alvo é a bolha "/handoff \" (a "\" que a TUI do Claude come): manda pela caixa com a aba
// parada, espera o turno acabar, RECARREGA (é a reemissão do servidor que pinta o selo "na fila")
// e manda `/clear` (o print do dono de 13/10: a bolha presa acima da régua do contexto zerado).
//
//   ANTES=1 → a árvore do commit do gate vermelho (git archive, sem o conserto): a bolha tem que
//             ficar `bolha-pendente[data-fila]` depois da recarga e depois do `/clear`.
//   ANTES=0 → esta branch: depois da recarga a bolha `/handoff` está na fita e não há pendente;
//             depois do `/clear`, nenhuma pendente com `/handoff`.
//
// Navegador no HOST (puppeteer-core + Chrome), caminhos por ambiente, nunca em arquivo:
//   SAIDA=<pasta NOVA> PUPPETEER_CORE=<pasta> CHROME_BIN=<exe> [ANTES=1] node testes/print-barra-final.js
//
// tmux isolado: socket próprio e `-f /dev/null` (com HOME real o continuum-restore clona as
// sessões do usuário no socket novo). Porta 7923 (7879 é PRODUÇÃO, 7899 é dos jobs — nunca).
// Custa turnos de verdade (haiku). Não roda no `npm test`.
//
// Saída: 0 = verde · 1 = defeito/assert · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA || '';
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const ANTES = process.env.ANTES === '1';
const PORTA = 7923;
const ENVIO = '/handoff \\';

if (!SAIDA) { console.error('🟡 SAIDA é obrigatória (pasta NOVA dos PNGs).'); process.exit(2); }
if (!PUPPETEER || !CHROME) { console.error('🟡 PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).'); process.exit(2); }
let puppeteer;
try { puppeteer = require(PUPPETEER); } catch (e) {
  console.error(`🟡 não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`); process.exit(2);
}
if (!fs.existsSync(CHROME)) { console.error('🟡 CHROME_BIN não existe.'); process.exit(2); }
const BIN = '/usr/bin/claude';
if (!fs.existsSync(BIN)) { console.error(`🟡 não há claude em ${BIN}.`); process.exit(2); }
if (execFileSync('ss', ['-ltn'], { encoding: 'utf8' }).includes(`:${PORTA} `)) {
  console.error(`🟡 a porta ${PORTA} está ocupada.`); process.exit(2);
}

let falhas = 0;
let feitos = 0;
const ok = (c, t) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const SOCKET = `cockpit-print-barra-${process.pid}`;
function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { if (tolerante) return ''; throw e; }
}

const RAIZ_CODIGO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'print-barra-'));
const CWD_AGENTE = path.join(TMP, 'projeto');
fs.mkdirSync(CWD_AGENTE, { recursive: true });
fs.mkdirSync(SAIDA, { recursive: true });
if (fs.readdirSync(SAIDA).some((f) => f.endsWith('.png'))) { console.error('🟡 SAIDA já tem PNG — use pasta nova.'); process.exit(2); }

const ENV_SERVIDOR = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: String(PORTA),
  COCKPIT_CERT_DIR: '/dev/null',
  COCKPIT_TMUX_SOCKET: SOCKET,
  COCKPIT_TMUX_SESSAO: 'print',
  COCKPIT_LIDAS_DIR: path.join(TMP, 'lidas'),
  COCKPIT_JOBS_DIR: path.join(TMP, 'sem-jobs'),
  COCKPIT_VIGIA_MS: '0',
  COCKPIT_PUSH_DIR: path.join(TMP, 'push'),
  COCKPIT_ANEXOS_DIR: path.join(TMP, 'anexos'),
  COCKPIT_MONITOR_MS: '0',
  COCKPIT_MONITOR_DIR: path.join(TMP, 'monitor'),
  COCKPIT_DU_BIN: path.join(TMP, 'sem-du'),
  COCKPIT_DOCKER_BIN: path.join(TMP, 'sem-docker'),
};

const tela = () => t(['capture-pane', '-p', '-t', 'print'], { tolerante: true });
async function ate(fn, prazoMs, passo = 300) {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) { if (await fn()) return true; await espera(passo); }
  return false;
}
function pedir(rota) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: 'GET' }, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { j = null; } resolve({ status: res.statusCode, corpo: j }); });
    });
    req.on('error', () => resolve({ status: 0, corpo: null }));
    req.end();
  });
}
async function aba() {
  const r = await pedir('/api/abas');
  const lista = Array.isArray(r.corpo) ? r.corpo : ((r.corpo && r.corpo.abas) || []);
  return lista[0] || null;
}
// Ocioso em DUAS leituras seguidas: o status pisca entre os passos de um turno.
async function esperarTurnoAcabar(prazoMs) {
  let seguidas = 0;
  return ate(async () => {
    const a = await aba();
    if (a && a.status === 'idle') seguidas += 1; else seguidas = 0;
    return seguidas >= 2;
  }, prazoMs, 1000);
}

function sessionIdDoCli(pid) {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')).sessionId || null; } catch { return null; }
}
function acharJsonl(sessionId) {
  const raiz = path.join(os.homedir(), '.claude', 'projects');
  for (const pasta of fs.readdirSync(raiz)) {
    const alvo = path.join(raiz, pasta, `${sessionId}.jsonl`);
    if (fs.existsSync(alvo)) return alvo;
  }
  return null;
}

const servidores = [];
let navegador = null;

async function principal() {
  // Trava anti-produção (molde print-colagem-embrulhada): a pasta de anexos que ESTE código
  // resolve tem que cair no TMP — sem isso, um SHA sem a válvula escreveria em ~/.cockpit.
  const pastaAnexos = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./lib/abas').PASTA_ANEXOS)"],
    { cwd: RAIZ_CODIGO, env: ENV_SERVIDOR, encoding: 'utf8' });
  if (!pastaAnexos.startsWith(TMP + path.sep)) { console.error(`🔴 PASTA_ANEXOS fora do TMP (${pastaAnexos}).`); return 2; }

  t(['new-session', '-d', '-s', 'print', '-c', CWD_AGENTE, '-x', '120', '-y', '40', BIN, '--model', 'haiku']);
  const panePid = t(['list-panes', '-t', 'print', '-F', '#{pane_pid}']).trim();
  if (await ate(() => /trust this folder|Quick safety check/i.test(tela()), 30000)) {
    t(['send-keys', '-t', 'print', 'Down']);
    await espera(400);
    t(['send-keys', '-t', 'print', 'Enter']);
  }
  let agentePid = null;
  const candidatos = () => {
    const lista = [panePid];
    try { lista.push(...execFileSync('pgrep', ['-P', panePid], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean)); } catch { /* sem filhos */ }
    return lista;
  };
  if (!await ate(() => { for (const c of candidatos()) if (sessionIdDoCli(c)) { agentePid = c; return true; } return false; }, 40000)) {
    console.error('🟡 o CLI não publicou sessions/<pid>.json.'); return 2;
  }
  ok(true, `o agente subiu (pid ${agentePid}, ${ANTES ? 'ANTES' : 'DEPOIS'})`);

  const filho = spawn(process.execPath, [path.join(RAIZ_CODIGO, 'server.js')], { cwd: RAIZ_CODIGO, env: ENV_SERVIDOR, stdio: ['ignore', 'ignore', 'pipe'] });
  servidores.push(filho);
  let erroDoFilho = '';
  filho.stderr.on('data', (b) => { erroDoFilho += b; });
  if (!await ate(async () => (await pedir('/health')).status === 200, 15000)) {
    console.error(`🟡 servidor não subiu: ${erroDoFilho.trim().split('\n').slice(-3).join(' | ')}`); return 2;
  }
  if (!await ate(async () => Boolean(await aba()), 15000)) { console.error('🟡 o cockpit não enxergou a aba.'); return 2; }
  if (!await esperarTurnoAcabar(30000)) { console.error('🟡 a aba não ficou ociosa antes do envio.'); return 2; }

  navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await pagina.evaluateOnNewDocument(() => {
    try { localStorage.setItem('cockpit-idioma', 'pt-BR'); localStorage.removeItem('cockpit-tema'); } catch (e) { /* vale nesta página */ }
  });
  const base = `http://127.0.0.1:${PORTA}`;
  const tema = (esquema) => pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: esquema === 'escuro' ? 'dark' : 'light' }]);
  const abrirAba = async () => {
    await pagina.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas .conversa-linha .conversa', { timeout: 15000 });
    await pagina.evaluate(() => document.querySelector('#abas .conversa-linha .conversa').click());
    await pagina.waitForSelector('.painel:not([hidden]) .entrada', { timeout: 15000 });
    await espera(2500);
  };
  const escreverEEnviar = async (texto) => {
    await pagina.evaluate((x) => {
      const c = document.querySelector('.painel:not([hidden]) .entrada');
      c.value = x;
      c.dispatchEvent(new Event('input', { bubbles: true }));
    }, texto);
    await espera(300);
    await pagina.evaluate(() => document.querySelector('.painel:not([hidden]) .btn-enviar').click());
  };
  // As bolhas do envio: ancoradas no TEXTO "/handoff", nunca em "existe uma pendente".
  const medir = () => pagina.evaluate(() => {
    const doHandoff = Array.from(document.querySelectorAll('.painel:not([hidden]) .bolha-eu'))
      .filter((b) => (b.textContent || '').includes('/handoff'));
    const presa = doHandoff.filter((b) => b.classList.contains('bolha-pendente'));
    const alvo = presa[presa.length - 1] || doHandoff[doHandoff.length - 1] || null;
    if (alvo) alvo.scrollIntoView({ block: 'center' });
    else {
      const rolador = document.querySelector('.painel:not([hidden]) .mensagens');
      if (rolador) rolador.scrollTop = rolador.scrollHeight;
    }
    return {
      bolhas: doHandoff.map((b) => b.textContent.trim().slice(0, 40)),
      pendentes: presa.length,
      naFila: presa.filter((b) => b.dataset.fila === '1').length,
      cortes: document.querySelectorAll('.painel:not([hidden]) .corte').length,
    };
  });
  const fotografar = async (nome) => {
    for (const esquema of ['claro', 'escuro']) {
      await tema(esquema);
      await espera(400);
      const png = path.join(SAIDA, `${nome}-${esquema}.png`);
      await pagina.screenshot({ path: png });
      ok(fs.existsSync(png) && fs.statSync(png).size > 1000, `${png} gerado`);
    }
    await tema('claro');
  };

  await tema('claro');
  await abrirAba();
  await escreverEEnviar(ENVIO);
  await espera(1500);
  await fotografar('01-enviado');
  // O turno do /handoff: começa (talvez rápido demais para ver) e acaba. Teto que REPROVA — turno
  // que não acabou deixaria o ANTES "verde" pelo motivo errado.
  await ate(async () => { const a = await aba(); return a && a.status !== 'idle'; }, 30000, 500);
  ok(await esperarTurnoAcabar(300000), 'o turno do /handoff acabou em até 300 s');
  await espera(4000);
  await fotografar('02-depois-do-turno');
  const depoisDoTurno = await medir();

  // A recarga: o servidor reemite as fichas não consumidas como `pendente` com naFila = true.
  await abrirAba();
  const recarregado = await medir();
  await fotografar('03-recarregado');

  // O /clear do print do dono: troca de sessão → `sessao` + reemissão (server.js:664).
  const sessaoAntes = sessionIdDoCli(agentePid);
  await escreverEEnviar('/clear');
  const trocou = await ate(() => { const s = sessionIdDoCli(agentePid); return Boolean(s && s !== sessaoAntes); }, 30000, 500);
  ok(trocou, 'o /clear trocou a sessão do CLI');
  await espera(4000);
  const limpo = await medir();
  await fotografar('04-depois-do-clear');

  console.log(`  · medidas: ${JSON.stringify({ depoisDoTurno, recarregado, limpo })}`);
  if (ANTES) {
    ok(recarregado.naFila >= 1, 'ANTES: depois da recarga a bolha "/handoff \\" está presa com o selo NA FILA (o defeito)');
    ok(limpo.naFila >= 1, 'ANTES: depois do /clear a bolha continua presa com o selo NA FILA (o print do dono)');
  } else {
    ok(depoisDoTurno.pendentes === 0 && depoisDoTurno.bolhas.length >= 1, 'DEPOIS: logo depois do turno a bolha /handoff está na fita e não está pendente');
    ok(recarregado.pendentes === 0 && recarregado.bolhas.length >= 1, 'DEPOIS: depois da recarga a bolha /handoff está na fita e não está pendente');
    ok(limpo.pendentes === 0, 'DEPOIS: depois do /clear nenhuma bolha /handoff pendente');
  }

  // O cenário aconteceu de verdade: o .jsonl gravou "/handoff" SEM a "\" (sem <command-args>).
  const arquivo = sessaoAntes ? acharJsonl(sessaoAntes) : null;
  const linhas = arquivo ? fs.readFileSync(arquivo, 'utf8').split('\n').filter(Boolean) : [];
  const eco = linhas.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((j) => j && j.type === 'user' && typeof (j.message && j.message.content) === 'string'
      && j.message.content.includes('<command-name>/handoff</command-name>'));
  ok(Boolean(eco) && !eco.message.content.includes('<command-args>'), `jsonl: o CLI gravou /handoff sem a "\\" (${arquivo || 'arquivo não achado'})`);
  return falhas === 0 ? 0 : 1;
}

let saida = 1;
principal()
  .then((c) => { saida = c; })
  .catch((e) => { console.error('🔴 erro:', e.message); saida = 1; })
  .finally(async () => {
    if (navegador) { try { await navegador.close(); } catch { /* já fechou */ } }
    for (const s of servidores) { try { s.kill('SIGTERM'); } catch { /* já morreu */ } }
    t(['kill-server'], { tolerante: true });   // o socket é SÓ deste print (#2 vale para o do cockpit)
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* deixa no /tmp */ }
    const veredito = feitos === 0 ? '⚠️  INCONCLUSIVO (nenhuma asserção rodou)'
      : (falhas === 0 && saida === 0 ? '✅ PRINT VERDE' : '❌ PRINT VERMELHO');
    console.log(`\n${veredito} — ${feitos - falhas}/${feitos} asserções`);
    process.exit(saida);
  });
