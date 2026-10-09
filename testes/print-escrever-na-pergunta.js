#!/usr/bin/env node
'use strict';
// PRINT DO CARD `escrever-texto-na-pergunta-aberta` — celular 390×844, COM O MENU NA VISTA.
//
// Regra da casa (25/08): mudou tela, tem print, e o print tem que conter o que mudou. Tela
// vazia, tela de erro e tela sem o recurso NÃO são prova. Aqui o alvo é a `.pergunta` com o
// menu da TUI dentro dela e a caixa de escrita logo abaixo — nos dois estados:
//
//   ANTES=1  → o código da `develop`: Enviar CINZA, caixa travada, e a bolha de recusa
//   ANTES=0  → esta branch: Enviar ATIVO, o aviso "Escrever aqui manda Esc antes do texto",
//              e o texto do usuário dentro da caixa
//
// O par sai do MESMO menu (o `AskUserQuestion` do Claude) de propósito: "antes" de um menu e
// "depois" de outro contariam histórias diferentes sobre o mesmo botão.
//
// Como rodar os dois lados:
//   SAIDA=~/.cockpit/smoke-shots/2026-09-21-escrever-na-pergunta/depois node testes/print-escrever-na-pergunta.js
//   (e o mesmo arquivo, com ANTES=1, de dentro de uma cópia da develop)
//
// Porta 7893 (7894 é do smoke irmão; 7899 é dos jobs; 7879 é PRODUÇÃO — nunca).
// Idioma forçado em pt-BR no localStorage antes do app subir: sem isso o `public/i18n.js`
// cai no `navigator.language` do Chromium (en-US) e o print sai em inglês.
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta dos PNGs> (use ~/.cockpit/smoke-shots/..., nunca /tmp)');
  process.exit(2);
}
const ANTES = process.env.ANTES === '1';
const PORTA = 7893;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';

let falhas = 0;
let feitos = 0;
const ok = (c, t) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}". Abortando.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-print-${process.pid}`;

function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}
if (t(['list-sessions'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} já existe. Abortando.`);
  process.exit(1);
}

const BIN = '/usr/bin/claude';
if (!fs.existsSync(BIN)) { console.error(`⚠️  não há claude em ${BIN}.`); process.exit(2); }
try { execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' }); } catch {
  console.error(`⚠️  a imagem docker ${IMAGEM} não existe.`); process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'print-pergunta-'));
const LIDAS = path.join(TMP, 'lidas');            // #78 — nunca o ~/.cockpit de produção
fs.mkdirSync(LIDAS, { recursive: true });
const CWD_AGENTE = path.join(TMP, 'projeto');
fs.mkdirSync(CWD_AGENTE, { recursive: true });
fs.writeFileSync(path.join(CWD_AGENTE, 'leiame.txt'), 'pasta de print\n');
fs.mkdirSync(SAIDA, { recursive: true });

const servidores = [];
const tela = () => t(['capture-pane', '-p', '-t', 'print'], { tolerante: true });

function statusDoCli(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')).status || null;
  } catch { return null; }
}
async function ate(fn, prazoMs, passo = 300) {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) { if (await fn()) return true; await espera(passo); }
  return false;
}
function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (corpo) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers }, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => { let j = {}; try { j = d ? JSON.parse(d) : {}; } catch { j = { cru: d }; } resolve({ status: res.statusCode, corpo: j }); });
    });
    req.on('error', reject);
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');
const BASE = process.env.BASE;
const ANTES = process.env.ANTES === '1';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const problemas = [];
  const medidas = {};
  const pagina = await navegador.newPage();
  try {
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pagina.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pagina.evaluate(() => localStorage.setItem('cockpit-idioma', 'pt-BR'));
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(800);

    // Abrir a aba do agente: a única da lista.
    const linha = await pagina.$('#lista-conversas .conversa');
    if (!linha) { problemas.push('a aba não apareceu na lista'); }
    else { await linha.click(); }
    await espera(1500);

    // O MENU NA VISTA é o requisito do print. Sem ele, a foto não é prova.
    const temMenu = await pagina.waitForSelector('.painel:not([hidden]) .pergunta', { timeout: 20000 })
      .then(() => true, () => false);
    if (!temMenu) problemas.push('a .pergunta (menu da TUI) não apareceu — a foto não seria prova');

    // Escrever na caixa. No ANTES ela está travada; escrever mesmo assim é o ponto da foto.
    const caixa = await pagina.$('.painel:not([hidden]) .entrada');
    if (caixa) { await caixa.click(); await caixa.type('na verdade prefiro verde'); }
    await espera(600);

    medidas.enviarDesabilitado = await pagina.evaluate(() => {
      const b = document.querySelector('.painel:not([hidden]) .btn-enviar');
      return b ? b.disabled : null;
    });
    medidas.avisoNaTela = await pagina.evaluate(() => {
      const p = document.querySelector('.painel:not([hidden]) .pergunta');
      return p ? /manda Esc|Esc antes do texto/i.test(p.textContent || '') : false;
    });
    medidas.textoNaCaixa = await pagina.evaluate(() => {
      const c = document.querySelector('.painel:not([hidden]) .entrada');
      return c ? c.value : '';
    });
    medidas.menuNaVista = await pagina.evaluate(() => {
      const p = document.querySelector('.painel:not([hidden]) .pergunta');
      if (!p) return false;
      const r = p.getBoundingClientRect();
      return r.height > 40 && r.top < window.innerHeight;
    });

    // ROLAR ATÉ A CAIXA antes de fotografar. Sem isto o corte de 844 px pega o menu inteiro
    // e deixa o Enviar e a caixa FORA da vista — e o recurso desta entrega é justamente o
    // Enviar destravado. Print sem o que mudou não é prova (regra de 25/08). Rolado até o
    // fim, o PNG mostra as duas coisas juntas: o fim do menu (botões + aviso) e a caixa.
    await pagina.evaluate(() => {
      const c = document.querySelector('.painel:not([hidden]) .envio-caixa');
      if (c) c.scrollIntoView({ block: 'end' });
      const rolador = document.querySelector('.painel:not([hidden]) .conversa-corpo')
        || document.querySelector('.painel:not([hidden]) .fita')
        || document.scrollingElement;
      if (rolador) rolador.scrollTop = rolador.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
    await espera(500);
    // QUEM esta por cima do ponto da caixa? O retangulo diz onde ela ESTA, nao se alguem a
    // cobre — e no celular a .pergunta e fixed/inset:0/z-index:30 (estilo.css:2043). Medida
    // que so olha o retangulo nao ve a camada por cima: foi assim que o print saiu "verde"
    // sem a caixa aparecer. (Sem crase neste comentario: ele vive DENTRO do template
    // literal do roteiro, e uma crase aqui fecha a string e quebra o arquivo inteiro.)
    medidas.quemCobreACaixa = await pagina.evaluate(() => {
      const c = document.querySelector('.painel:not([hidden]) .envio-caixa');
      if (!c) return 'sem caixa';
      const r = c.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
      const alvo = document.elementFromPoint(x, y);
      if (!alvo) return 'nada (fora da viewport)';
      return c.contains(alvo) || alvo === c ? 'a própria caixa' : (alvo.className || alvo.tagName);
    });

    medidas.caixaNaVista = await pagina.evaluate(() => {
      const c = document.querySelector('.painel:not([hidden]) .envio-caixa');
      if (!c) return false;
      const r = c.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight + 4;
    });

    await pagina.screenshot({ path: '/out/' + (ANTES ? '01-antes-caixa-travada' : '02-depois-caixa-livre') + '.png' });

    // O que cada lado TEM que mostrar. O print que não contém o que mudou não é prova.
    if (!medidas.menuNaVista) problemas.push('o menu não está na vista no PNG');
    if (!medidas.caixaNaVista) problemas.push('a caixa/Enviar não está na vista no PNG — sem ela a foto não mostra o que mudou');
    if (ANTES) {
      if (medidas.enviarDesabilitado !== true) problemas.push('ANTES: o Enviar deveria estar travado');
    } else {
      if (medidas.enviarDesabilitado !== false) problemas.push('DEPOIS: o Enviar deveria estar ativo');
      if (!medidas.avisoNaTela) problemas.push('DEPOIS: o aviso "manda Esc antes do texto" não está na tela');
      if (!medidas.textoNaCaixa) problemas.push('DEPOIS: a caixa deveria ter o texto do usuário');
      // O Enviar destravado só vale se o DEDO alcançar a caixa. Medir e não reprovar era o
      // furo: o print saia verde com a caixa debaixo da camada da pergunta. Alcancavel =
      // o ponto central da caixa devolve a PROPRIA caixa em elementFromPoint.
      if (medidas.quemCobreACaixa !== 'a própria caixa') {
        problemas.push('DEPOIS: a caixa esta COBERTA por "' + medidas.quemCobreACaixa
          + '" — o Enviar destravou mas o dedo nao alcanca');
      }
    }
  } catch (e) {
    problemas.push('o roteiro estourou — ' + String(e && e.message).slice(0, 300));
  }
  await navegador.close();
  console.log('@@MEDIDAS-PERGUNTA@@' + JSON.stringify({ problemas, medidas }));
})();
`;
}

async function principal() {
  t(['new-session', '-d', '-s', 'print', '-c', CWD_AGENTE, '-x', '120', '-y', '40', BIN]);
  const panePid = t(['list-panes', '-t', 'print', '-F', '#{pane_pid}']).trim();
  if (!await ate(() => /trust this folder|Quick safety check/i.test(tela()), 30000)) {
    console.error('⚠️  o claude não chegou ao prompt de confiança.'); return 2;
  }
  t(['send-keys', '-t', 'print', 'Down']);
  await espera(400);
  t(['send-keys', '-t', 'print', 'Enter']);

  let agentePid = null;
  const candidatos = () => {
    const lista = [panePid];
    try {
      lista.push(...execFileSync('pgrep', ['-P', panePid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').map((s) => s.trim()).filter(Boolean));
    } catch { /* sem filhos */ }
    return lista;
  };
  if (!await ate(() => { for (const c of candidatos()) if (statusDoCli(c)) { agentePid = c; return true; } return false; }, 40000)) {
    console.error('⚠️  o CLI não publicou sessions/<pid>.json.'); return 2;
  }
  ok(true, `o agente subiu (pid ${agentePid})`);

  const filho = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: 'print',
      COCKPIT_LIDAS_DIR: LIDAS,
      COCKPIT_JOBS_DIR: path.join(TMP, 'sem-jobs'),
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_MONITOR_MS: '0', // o amostrador do monitor escreve desde o boot (#82)
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  servidores.push(filho);
  let erroDoFilho = '';
  filho.stderr.on('data', (b) => { erroDoFilho += b; });
  if (!await ate(() => pedir('GET', '/health').then((r) => r.status === 200, () => false), 15000)) {
    console.error(`⚠️  servidor não subiu: ${erroDoFilho.trim().split('\n').slice(-3).join(' | ')}`); return 2;
  }

  // O MENU: o `AskUserQuestion` do Claude, o mesmo nos dois lados do par.
  const r = await listarAba();
  if (!r) { console.error('⚠️  o cockpit não enxergou a aba.'); return 2; }
  await pedir('POST', `/api/abas/${r.chave}/turnos`, {
    texto: 'Use a ferramenta AskUserQuestion agora para me perguntar qual a minha cor favorita, '
      + 'com as opcoes vermelho e azul. Nao faca mais nada.',
  });
  if (!await ate(() => statusDoCli(agentePid) === 'waiting' && /cor favorita/i.test(tela()), 90000)) {
    console.error('⚠️  a pergunta não abriu — sem menu não há print que sirva de prova.'); return 2;
  }
  ok(true, 'o AskUserQuestion está aberto na TUI — o menu que vai aparecer no print');

  fs.writeFileSync(path.join(TMP, 'roteiro.js'), montarRoteiro());
  const docker = spawn('docker', [
    'run', '--rm', '--network', 'host', '--entrypoint', 'node',
    '-e', `BASE=http://127.0.0.1:${PORTA}`,
    '-e', `ANTES=${ANTES ? '1' : '0'}`,
    '-v', `${TMP}:/w:ro`,
    '-v', `${SAIDA}:/out`,
    IMAGEM, '/w/roteiro.js',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let saidaDocker = '';
  docker.stdout.on('data', (d) => { saidaDocker += d; });
  docker.stderr.on('data', (d) => { saidaDocker += d; });
  await new Promise((res) => docker.on('close', res));

  const MARCADOR = '@@MEDIDAS-PERGUNTA@@';
  const abre = saidaDocker.indexOf(MARCADOR);
  let rel = null;
  if (abre >= 0) { try { rel = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { rel = null; } }
  if (!rel) { console.log(saidaDocker); ok(false, 'o roteiro não devolveu JSON'); return 1; }

  console.log(`  · medidas: ${JSON.stringify(rel.medidas)}`);
  ok(rel.problemas.length === 0, rel.problemas.length ? `o percurso reprovou: ${rel.problemas.join(' · ')}` : 'o percurso passou');
  const png = path.join(SAIDA, `${ANTES ? '01-antes-caixa-travada' : '02-depois-caixa-livre'}.png`);
  ok(fs.existsSync(png) && fs.statSync(png).size > 1000, `${png} gerado`);
  return falhas === 0 ? 0 : 1;

  async function listarAba() {
    const resp = (await pedir('GET', '/api/abas')).corpo;
    const abas = Array.isArray(resp) ? resp : (resp.abas || []);
    return abas[0] || null;
  }
}

let saida = 1;
principal()
  .then((c) => { saida = c; })
  .catch((e) => { console.error('🔴 erro:', e.message); saida = 1; })
  .finally(() => {
    for (const s of servidores) { try { s.kill('SIGTERM'); } catch { /* já morreu */ } }
    try { t(['kill-server'], { tolerante: true }); } catch { /* já caiu */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* deixa no /tmp */ }
    const veredito = feitos === 0 ? '⚠️  INCONCLUSIVO (nenhuma asserção rodou)'
      : (falhas === 0 && saida === 0 ? '✅ PRINT VERDE' : '❌ PRINT VERMELHO');
    console.log(`\n${veredito} — ${feitos - falhas}/${feitos} asserções`);
    process.exit(saida);
  });
