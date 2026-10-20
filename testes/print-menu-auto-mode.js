#!/usr/bin/env node
'use strict';
// Prova de tela do card `mensagem-some-no-menu-do-auto-mode` (D85), 390×844: o diálogo "Teach
// auto mode about your environment?" que o Claude abre SOZINHO no fim de um turno, visto do
// CELULAR. Junta dois moldes que já existem — nunca reescritos aqui:
//   • o MUNDO de `testes/repro-menu-auto-mode.js` (HOME 0700 com `.claude.json` de mentira,
//     `denials: 5`, credencial do dono por symlink, tmux em socket próprio com `-f /dev/null`,
//     duas subidas do CLI na janela `repro`);
//   • o SERVIDOR + NAVEGADOR de `testes/print-job-id-fora-do-alfabeto.js` (`server.js` como
//     processo filho, Chromium do HOST por `PUPPETEER_CORE`/`CHROME_BIN`, 390×844 @3x).
//
// `RAIZ_CODIGO` escolhe de onde sobe o `server.js` — é o que faz o ANTES (git archive do commit
// `7661791`) virar o DEPOIS (esta árvore, padrão).
//
// Uso:
//   CASO=antes|depois|recusado SAIDA=<pasta NOVA, sem PNG dentro> \
//     PUPPETEER_CORE=<caminho> CHROME_BIN=<caminho> [RAIZ_CODIGO=<árvore>] \
//     node testes/print-menu-auto-mode.js
//
// Saída: 0 = as exigências do caso fecharam · 1 = falha de produto/assert ·
// 2 = erro de USO ou de AMBIENTE (falta variável, pasta com PNG, porta ocupada, sem CLI/navegador,
// diálogo que não abriu) · 3 (só `recusado`) = a corrida dos 500 ms não caiu em 3 tentativas —
// não é falha de produto, é a janela de tempo que não coincidiu.
//
// Custa 2-4 turnos de sonnet (modo auto não existe no haiku) e um Chromium real. NÃO roda no
// `npm test`. Nunca portas 7879 (produção) / 7899 (jobs) / 7961 (outro repro) — esta usa 7966.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

const CASO = process.env.CASO || '';
const SAIDA = process.env.SAIDA || '';
const RAIZ_CODIGO = path.resolve(process.env.RAIZ_CODIGO || path.join(__dirname, '..'));
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const PORTA = 7966; // nunca 7879 (produção) / 7899 (jobs) / 7961 (outro repro)
const BIN = process.env.COCKPIT_BIN_CLAUDE || '/usr/bin/claude';
const MARCA = `marcador${process.pid}`;
const FALA_INICIAL = 'responda apenas: oi';

if (!['antes', 'depois', 'recusado'].includes(CASO)) {
  console.error('🟡 CASO é obrigatório: antes | depois | recusado'); process.exit(2);
}
if (!SAIDA) { console.error('🟡 SAIDA é obrigatória (pasta NOVA do PNG).'); process.exit(2); }
if (!PUPPETEER || !CHROME) {
  console.error('🟡 ambiente indisponível: PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
  process.exit(2);
}
let puppeteer;
try { puppeteer = require(PUPPETEER); } catch (e) {
  console.error(`🟡 ambiente indisponível: não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`);
  process.exit(2);
}
if (!fs.existsSync(CHROME)) { console.error('🟡 ambiente indisponível: CHROME_BIN não existe.'); process.exit(2); }
if (!fs.existsSync(BIN)) { console.error(`🟡 ambiente indisponível: ${BIN} não existe.`); process.exit(2); }
const CREDENCIAL = path.join(os.homedir(), '.claude', '.credentials.json');
if (!fs.existsSync(CREDENCIAL)) { console.error('🟡 ambiente indisponível: o CLI não está logado.'); process.exit(2); }

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function portaOcupada(porta) {
  const saida = execSync('ss -ltn 2>/dev/null || true', { encoding: 'utf8' });
  return saida.split('\n').some((l) => l.includes(`:${porta} `) || l.includes(`:${porta}\t`));
}

function saude(porta) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  let scratch = null;
  let servidor = null;
  let navegador = null;
  const SOCKET = `cockpit-smoke-automode-print-${process.pid}`;
  let CASA = null;
  let AMBIENTE_TMUX = null;

  function t(args, { tolerante = false } = {}) {
    try {
      return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: AMBIENTE_TMUX });
    } catch (e) {
      if (tolerante) return '';
      throw e;
    }
  }
  const telaDaJanela = (janela) => t(['capture-pane', '-p', '-t', `main:${janela}`], { tolerante: true });
  const telaDoRepro = () => telaDaJanela('repro');
  async function esperarNaTela(re, segundos, { intervaloMs = 500, janela = 'repro' } = {}) {
    const tentativas = Math.ceil((segundos * 1000) / intervaloMs);
    for (let i = 0; i < tentativas; i += 1) {
      if (re.test(telaDaJanela(janela))) return true;
      await espera(intervaloMs);
    }
    return false;
  }

  const limpar = () => {
    if (servidor && servidor.exitCode === null) { try { process.kill(servidor.pid); } catch { /* já morreu */ } }
    if (AMBIENTE_TMUX) { try { t(['kill-server'], { tolerante: true }); } catch { /* já sumiu */ } }
    if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* fica no /tmp */ } }
  };

  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Este script recusa sobrescrever.`);
      return process.exit(2);
    }
    if (portaOcupada(PORTA)) {
      console.error(`🔴 a porta ${PORTA} já está em uso — aborta antes de subir qualquer coisa.`);
      return process.exit(2);
    }

    // ── 1) o mundo de mentira (molde de testes/repro-menu-auto-mode.js) ──────────────────
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-automode-'));
    CASA = path.join(scratch, 'home');
    fs.mkdirSync(path.join(CASA, '.claude'), { recursive: true });
    fs.chmodSync(CASA, 0o700);
    const PROJETO = path.join(CASA, 'projeto');
    fs.mkdirSync(PROJETO);
    fs.symlinkSync(CREDENCIAL, path.join(CASA, '.claude', '.credentials.json'));
    const CLAUDE_JSON = path.join(CASA, '.claude.json');
    const armarDialogo = () => fs.writeFileSync(CLAUDE_JSON, JSON.stringify({
      hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.280', numStartups: 10, autoUpdates: false,
      autoModeEnvSetup: { denials: 5 }, hasSeenAutoModeEntryWarning: true,
      hasResetAutoModeOptInForDefaultOffer: true, theme: 'dark',
      projects: { [PROJETO]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }));
    armarDialogo();
    fs.writeFileSync(path.join(CASA, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }));

    AMBIENTE_TMUX = { HOME: CASA, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', USER: os.userInfo().username };

    // `comandoDaAba` não depende do defeito — vem da MESMA árvore que o servidor vai subir,
    // igual ao molde do repro.
    const abasMundo = require(path.join(RAIZ_CODIGO, 'lib', 'abas.js'));
    const comando = abasMundo.comandoDaAba('claude', 'sonnet');

    t(['new-session', '-d', '-s', 'main', '-n', 'base', '-c', PROJETO, '-x', '120', '-y', '40', 'sleep 100000']);
    t(['new-window', '-t', 'main', '-n', 'aquece', '-c', PROJETO, comando]);
    if (!await esperarNaTela(/❯/, 40, { janela: 'aquece' })) { console.error('🟡 ambiente indisponível: o CLI não subiu (aquecimento).'); limpar(); return process.exit(2); }
    await espera(8000);
    t(['kill-window', '-t', 'main:aquece']);
    await espera(1500);
    t(['new-window', '-t', 'main', '-n', 'repro', '-c', PROJETO, comando]);
    if (!await esperarNaTela(/❯/, 40, { janela: 'repro' })) { console.error('🟡 ambiente indisponível: o CLI não subiu (repro).'); limpar(); return process.exit(2); }
    await espera(3000);
    console.log(`  · mundo de mentira pronto (HOME ${CASA}, socket ${SOCKET})`);

    // ── 2) o servidor como processo filho (molde de testes/print-job-id-fora-do-alfabeto.js) ─
    const scratchServ = path.join(scratch, 'servidor');
    const JOBS_DIR = path.join(scratchServ, 'jobs');
    const MONITOR_DIR = path.join(scratchServ, 'monitor');
    const LIDAS_DIR = path.join(scratchServ, 'lidas');
    const PUSH_DIR = path.join(scratchServ, 'push');
    const ANEXOS_DIR = path.join(scratchServ, 'anexos');
    for (const d of [JOBS_DIR, MONITOR_DIR, LIDAS_DIR, PUSH_DIR, ANEXOS_DIR]) fs.mkdirSync(d, { recursive: true });

    const ambienteServ = { ...process.env };
    delete ambienteServ.COCKPIT_TOKEN;
    Object.assign(ambienteServ, {
      HOST: '127.0.0.1', PORT: String(PORTA),
      HOME: CASA,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_JOBS_DIR: JOBS_DIR,
      COCKPIT_MONITOR_DIR: MONITOR_DIR,
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_LIDAS_DIR: LIDAS_DIR,
      COCKPIT_PUSH_DIR: PUSH_DIR,
      COCKPIT_ANEXOS_DIR: ANEXOS_DIR,
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: 'main',
    });

    servidor = spawn(process.execPath, [path.join(RAIZ_CODIGO, 'server.js')], {
      cwd: RAIZ_CODIGO, env: ambienteServ, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await saude(PORTA);
      if (!pronto) await espera(200);
    }
    if (!pronto) { console.error(`🔴 o server.js (${RAIZ_CODIGO}) não subiu na porta ${PORTA}`); limpar(); return process.exit(1); }
    console.log(`  · server.js (${RAIZ_CODIGO}) no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid})`);

    // ── 3) o navegador do host ───────────────────────────────────────────────────────────
    try {
      navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    } catch (e) {
      console.error(`🟡 ambiente indisponível: o navegador não subiu (${e.message})`);
      limpar();
      return process.exit(2);
    }
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch { /* sem storage */ } });

    await pagina.goto(`http://127.0.0.1:${PORTA}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await pagina.waitForSelector('#lista-conversas', { timeout: 15000 });
    await espera(600);

    const clicou = await pagina.evaluate(() => {
      const linhas = [...document.querySelectorAll('#lista-conversas .conversa-linha')];
      const linha = linhas.find((l) => {
        const tit = l.querySelector('.conversa-titulo');
        return tit && tit.textContent.includes('repro');
      });
      const botao = linha && linha.querySelector('.conversa');
      if (!botao) return false;
      botao.click();
      return true;
    });
    if (!clicou) throw new Error('não achei a linha "repro" na lista de conversas');

    await pagina.waitForSelector('.painel[data-tipo="aba"] .entrada', { timeout: 15000 });
    await espera(1500);
    console.log('  · painel da aba "repro" aberto no celular');

    const SEL_PAINEL = '.painel[data-tipo="aba"]';
    async function digitar(texto) {
      await pagina.evaluate((sel, txt) => {
        const campo = document.querySelector(`${sel} .entrada`);
        campo.value = txt;
        campo.dispatchEvent(new Event('input', { bubbles: true }));
      }, SEL_PAINEL, texto);
    }
    async function tocarEnviar() {
      await pagina.click(`${SEL_PAINEL} .btn-enviar`);
    }
    async function medidas() {
      return pagina.evaluate((sel, marca) => {
        const painel = document.querySelector(sel);
        if (!painel) return null;
        const avisoMenu = [...painel.querySelectorAll('.bolha-aviso')].some((b) => b.textContent.includes('menu aberto'));
        const erroMenu = [...painel.querySelectorAll('.bolha-erro')].some((b) => b.textContent.includes('menu aberto'));
        const resposta = [...painel.querySelectorAll('.fala-corpo')].some((b) => b.textContent.includes(marca));
        const ultimaEu = [...painel.querySelectorAll('.bolha-eu')].at(-1);
        const pendente = Boolean(ultimaEu && ultimaEu.classList.contains('bolha-pendente'));
        const campo = painel.querySelector('.entrada');
        return { avisoMenu, erroMenu, resposta, pendente, caixa: campo ? campo.value : null };
      }, SEL_PAINEL, MARCA);
    }

    // ── 4) o 1º turno: arma o diálogo ────────────────────────────────────────────────────
    await digitar(FALA_INICIAL);
    await tocarEnviar();

    if (CASO !== 'recusado') {
      if (!await esperarNaTela(/Teach auto mode/, 120)) {
        console.error('🟡 ambiente indisponível: o diálogo "Teach auto mode" não abriu em 120 s.');
        console.error(telaDoRepro());
        await navegador.close().catch(() => {});
        limpar();
        return process.exit(2);
      }
      console.log('  · diálogo "Teach auto mode" na tela');
      await espera(1500); // fora da janela de 500 ms em que o diálogo ignora tecla (`pve` no binário)

      await digitar(`responda apenas: ${MARCA}`);
      await tocarEnviar();
      await espera(25000);

      const arquivo = path.join(SAIDA, `${CASO}.png`);
      await pagina.screenshot({ path: arquivo });
      const m = await medidas();
      console.log(`  · ${CASO}: avisoMenu=${m.avisoMenu} resposta=${m.resposta} pendente=${m.pendente} -> ${arquivo}`);

      await navegador.close().catch(() => {});
      navegador = null;
      limpar();

      if (CASO === 'depois') {
        if (!m.avisoMenu || !m.resposta) {
          console.log('\n❌ PROVA DE TELA REPROVADA — depois exige o aviso de menu fechado E a resposta do agente');
          return process.exit(1);
        }
        console.log('\n✅ PROVA DE TELA OK — depois: aviso de menu fechado + resposta na fita');
        return process.exit(0);
      }
      // antes: só registra — é a foto do defeito, não há exigência de valor.
      console.log('\n✅ PROVA DE TELA REGISTRADA — antes: foto do defeito (bolha pendente, sem aviso)');
      return process.exit(0);
    }

    // ── CASO === 'recusado': a corrida dos 500 ms de surdez do diálogo ───────────────────
    const TENTATIVAS = 3;
    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa += 1) {
      console.log(`  · recusado: tentativa ${tentativa}/${TENTATIVAS}`);
      await digitar(`responda apenas: ${MARCA}`);
      // Sondagem fina: tocar Enviar no instante em que o diálogo aparece, para o Esc do
      // gesto cair nos 500 ms em que o diálogo ignora tecla (`pve` no binário).
      let achou = false;
      for (let i = 0; i < 4000 && !achou; i += 1) { // até 120 s em passos de 30 ms
        if (/Teach auto mode/.test(telaDoRepro())) { achou = true; break; }
        await espera(30);
      }
      if (!achou) {
        console.error('🟡 ambiente indisponível: o diálogo não abriu para a sondagem fina.');
        await navegador.close().catch(() => {});
        limpar();
        return process.exit(2);
      }
      await tocarEnviar();
      await espera(4000);
      const m = await medidas();
      console.log(`    tentativa ${tentativa}: erroMenu=${m.erroMenu} caixa=${JSON.stringify(m.caixa)}`);

      if (m.erroMenu && m.caixa && m.caixa.includes(MARCA)) {
        const arquivo = path.join(SAIDA, `${CASO}.png`);
        await pagina.screenshot({ path: arquivo });
        console.log(`  · recusado: caiu na janela na tentativa ${tentativa} -> ${arquivo}`);
        await navegador.close().catch(() => {});
        navegador = null;
        limpar();
        console.log('\n✅ PROVA DE TELA OK — recusado: bolha de erro + texto de volta na caixa');
        return process.exit(0);
      }

      if (tentativa < TENTATIVAS) {
        // Não caiu na janela: o envio passou (Esc funcionou de verdade). Rearma o diálogo —
        // zera `dismissedAt` e repõe `denials: 5` — e manda outro turno para abri-lo de novo.
        armarDialogo();
        await digitar(FALA_INICIAL);
        await tocarEnviar();
        if (!await esperarNaTela(/Teach auto mode/, 120)) {
          console.error('🟡 ambiente indisponível: o diálogo não reabriu para a próxima tentativa.');
          await navegador.close().catch(() => {});
          limpar();
          return process.exit(2);
        }
      }
    }

    console.error('🟡 a corrida dos 500 ms não caiu em 3 tentativas (não é falha de produto).');
    await navegador.close().catch(() => {});
    navegador = null;
    limpar();
    return process.exit(3);
  } catch (e) {
    console.error('🔴 estourou:', e.message);
    if (navegador) await navegador.close().catch(() => {});
    limpar();
    return process.exit(1);
  }
})();
