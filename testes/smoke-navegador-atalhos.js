#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR dos atalhos de teclado — Chromium de verdade, os dois viewports.
//
// Por que ele existe, e por que o `smoke-navegador-externo` não serve aqui: aquele só VISITA
// caminhos, não clica em nada — e o painel de atalhos só existe depois de um clique na
// engrenagem. Ele também trava em 1600x1000 e não lê `VIEWPORT=`, e a §3.5.1 da spec tem
// comportamento que só se vê no celular. Um smoke que fotografa "escolha uma conversa" é
// exatamente a falha de 24/08 que a regra do print existe para impedir.
//
// O molde é `testes/smoke-navegador-abas.js`: mesma imagem docker, mesmo spawn('docker', …),
// mesmo clicar(sel) por pagina.evaluate, mesma saída 0/1/2, e reprova por ELEMENTO-ALVO
// AUSENTE antes do print.
//
// Contrato:
//   S3 na porta 7897 (a 7896 é do smoke das abas) · socket `cockpit-smoke-nav-atalhos-<pid>`
//   COCKPIT_BIN_CLAUDE=/bin/true · COCKPIT_CERT_DIR=/dev/null (#19) · sem COCKPIT_TOKEN
//   NUNCA contra a produção (7879), que fala com a `main` do usuário.
//
// Cinco percursos, cinco PNGs — ver Gate 3.3 do plano
// (design original) para o
// contrato exato de cada um.
//
// Códigos de saída:  0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7897;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const SAIDA = process.env.SAIDA || '/tmp/smoke-atalhos';

const PNGS = [
  '01-config-desktop.png', '02-captura.png', '03-config-celular.png',
  '04-celular-aberto.png', '05-gravado.png',
];

// ─── Fail-closed, na mesma ordem do smoke de abas ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

const SOCKET = `cockpit-smoke-nav-atalhos-${process.pid}`;
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;

function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

let falhas = 0;
let feitos = 0;
const ok = (c, texto) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${texto}`); return c; };

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function saude() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

let s3 = null;
let scratch = null;

function limpar() {
  if (s3 && s3.exitCode === null) {
    try { process.kill(s3.pid); } catch { /* já morreu */ }
    console.log(`  · S3 (pid ${s3.pid}) derrubado pelo pid exato`);
  }
  const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
    .split('\n').some((n) => n.trim() === CARIMBO);
  if (temCarimbo) t(['kill-server'], { tolerante: true });
  else console.error(`  🔴 a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}

// ─── O roteiro do navegador, que roda DENTRO do container ────────────────────

const ROTEIRO = `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const pagina = await navegador.newPage();

  const erros = [], requisicoes = [];
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
  pagina.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });

  const passos = [];
  const clicar = (sel) => pagina.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);

  /**
   * Tira o print E confere que o ALVO está mesmo na tela — o "elemento-alvo ausente" que
   * impede o defeito de 24/08 (reprova ANTES de alguém precisar olhar a figura).
   */
  async function print(arquivo, alvo, precisaAberto) {
    const medida = await pagina.evaluate((sel, exigeAberto) => {
      const folhas = Array.from(document.styleSheets).filter((f) => {
        try { return f.cssRules && f.cssRules.length > 0; } catch { return true; }
      }).length;
      const geral = {
        semRolagemLateral: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        folhasComRegras: folhas,
        imagensQuebradas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
      };
      const el = document.querySelector(sel);
      if (!el) return Object.assign({ existe: false }, geral);
      const r = el.getBoundingClientRect();
      return Object.assign({}, geral, {
        existe: true,
        aberto: exigeAberto ? Boolean(el.open) : true,
        visivel: r.width > 0 && r.height > 0,
      });
    }, alvo, Boolean(precisaAberto));
    await pagina.screenshot({ path: '/out/' + arquivo }).catch(() => {});
    passos.push({ arquivo, alvo, medida });
    return medida;
  }

  const problemas = [];
  try {
    await pagina.setViewport({ width: 1280, height: 800, hasTouch: false });
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 45000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });

    const resetar = async () => {
      await pagina.evaluate(() => { try { localStorage.removeItem('cockpit-atalhos'); } catch {} });
      await pagina.reload({ waitUntil: 'networkidle0', timeout: 45000 });
      await pagina.waitForSelector('#abas', { timeout: 15000 });
    };

    // ── 01 — o painel no desktop: 5 linhas, a primeira mostrando o padrão de fábrica ──
    if (!await clicar('#btn-config')) problemas.push('01: não há #btn-config na tela');
    await espera(400);
    const m1 = await print('01-config-desktop.png', '#dialogo-config', true);
    if (!m1.existe) problemas.push('01: #dialogo-config não existe no DOM');
    else if (!m1.aberto) problemas.push('01: #dialogo-config não está aberto na hora do print');
    const lista1 = await pagina.evaluate(() => {
      const l = document.querySelector('#atalhos-lista');
      if (!l) return { existe: false };
      const filhos = Array.from(l.children);
      const primeiraTecla = filhos[0] ? filhos[0].querySelector('.atalho-tecla') : null;
      return { existe: true, n: filhos.length, primeiraTecla: primeiraTecla ? primeiraTecla.textContent : null };
    });
    if (!lista1.existe) problemas.push('01: #atalhos-lista não existe');
    else {
      if (lista1.n !== 5) problemas.push('01: #atalhos-lista tem ' + lista1.n + ' linhas, esperado 5');
      if (lista1.primeiraTecla !== 'Alt+K') {
        problemas.push('01: a primeira linha mostra "' + lista1.primeiraTecla + '", esperado Alt+K');
      }
    }
    await resetar();

    // ── 02 — clicar a tecla da 1ª linha entra em modo captura ──
    await clicar('#btn-config');
    await espera(400);
    await clicar('#atalhos-lista > .atalho-linha:first-child .atalho-tecla');
    await espera(200);
    const m2 = await print('02-captura.png', '#dialogo-config', true);
    if (!m2.existe || !m2.aberto) problemas.push('02: #dialogo-config não está aberto na hora do print');
    const estado2 = await pagina.evaluate(() => {
      const b = document.querySelector('#atalhos-lista > .atalho-linha:first-child .atalho-tecla');
      return b ? { pressed: b.getAttribute('aria-pressed'), texto: b.textContent } : null;
    });
    if (!estado2) problemas.push('02: não achei o botão da primeira linha');
    else {
      if (estado2.pressed !== 'true') problemas.push('02: aria-pressed não é "true" (' + estado2.pressed + ')');
      if (estado2.texto !== 'aperte a combinação…') {
        problemas.push('02: o texto não é "aperte a combinação…" (' + estado2.texto + ')');
      }
    }
    await resetar();

    // ── 03 — no celular, a seção nasce RECOLHIDA (não some) ──
    await pagina.setViewport({ width: 390, height: 844, hasTouch: true });
    await clicar('#btn-config');
    await espera(400);
    const m3 = await print('03-config-celular.png', '#dialogo-config', true);
    if (!m3.existe || !m3.aberto) problemas.push('03: #dialogo-config não está aberto na hora do print');
    const estado3 = await pagina.evaluate(() => {
      const abrir = document.querySelector('#btn-atalhos-abrir');
      const corpo = document.querySelector('#atalhos-corpo');
      return { abrirHidden: abrir ? abrir.hidden : null, corpoHidden: corpo ? corpo.hidden : null };
    });
    if (estado3.abrirHidden !== false) problemas.push('03: #btn-atalhos-abrir não está visível (hidden=' + estado3.abrirHidden + ')');
    if (estado3.corpoHidden !== true) problemas.push('03: #atalhos-corpo não está recolhido (hidden=' + estado3.corpoHidden + ')');
    await resetar();

    // ── 04 — tocar no botão de abrir revela o corpo, que CABE e ROLA ──
    await pagina.setViewport({ width: 390, height: 844, hasTouch: true });
    await clicar('#btn-config');
    await espera(400);
    await clicar('#btn-atalhos-abrir');
    await espera(300);
    const m4 = await print('04-celular-aberto.png', '#atalhos-corpo', false);
    if (!m4.existe) problemas.push('04: #atalhos-corpo não existe no DOM');
    const estado4 = await pagina.evaluate(() => {
      const corpo = document.querySelector('#atalhos-corpo');
      const lista = document.querySelector('#atalhos-lista');
      const dialogoCorpo = document.querySelector('#dialogo-config .dialogo-corpo');
      const linhas = lista ? lista.children.length : 0;
      const ultima = lista && lista.children[lista.children.length - 1];
      const r = ultima ? ultima.getBoundingClientRect() : null;
      return {
        corpoHidden: corpo ? corpo.hidden : null,
        linhas,
        rola: dialogoCorpo ? dialogoCorpo.scrollHeight > dialogoCorpo.clientHeight : null,
        ultimaDentro: r ? r.bottom <= window.innerHeight + 0.5 : null,
      };
    });
    if (estado4.corpoHidden !== false) problemas.push('04: #atalhos-corpo continua hidden');
    if (estado4.linhas !== 5) problemas.push('04: #atalhos-corpo não tem as 5 linhas (' + estado4.linhas + ')');
    if (!(estado4.rola || estado4.ultimaDentro)) {
      problemas.push('04: nem o painel rola (scrollHeight>clientHeight) nem a última linha cabe na viewport');
    }
    await resetar();

    // ── 05 — gravar Alt+N DE VERDADE (teclado real), fechar, reabrir e conferir ──
    await pagina.setViewport({ width: 1280, height: 800, hasTouch: false });
    await clicar('#btn-config');
    await espera(400);
    await pagina.click('[data-acao="aba-seguinte"]');   // clique REAL — precisa focar o botão
    await espera(200);
    await pagina.keyboard.down('Alt');
    await pagina.keyboard.press('KeyN');
    await pagina.keyboard.up('Alt');
    await espera(300);
    await pagina.evaluate(() => { const d = document.querySelector('#dialogo-config'); if (d) d.close(); });
    await espera(200);
    await clicar('#btn-config');
    await espera(400);
    const m5 = await print('05-gravado.png', '#dialogo-config', true);
    if (!m5.existe || !m5.aberto) problemas.push('05: #dialogo-config não está aberto na hora do print');
    const estado5 = await pagina.evaluate(() => {
      const b = document.querySelector('[data-acao="aba-seguinte"]');
      let guardado = null;
      try { guardado = localStorage.getItem('cockpit-atalhos'); } catch {}
      return { texto: b ? b.textContent : null, guardado };
    });
    if (estado5.texto !== 'Alt+N') {
      problemas.push('05: depois de reabrir, a linha mostra "' + estado5.texto + '", esperado Alt+N');
    }
    let guardadoObj = null;
    try { guardadoObj = JSON.parse(estado5.guardado || '{}'); } catch { /* fica null */ }
    if (!guardadoObj || guardadoObj['aba-seguinte'] !== 'Alt+N') {
      problemas.push('05: localStorage não tem {"aba-seguinte":"Alt+N"} (' + estado5.guardado + ')');
    }
    // Só AGORA, no fim do percurso — ele é o único que precisa do localStorage vivo.
    await pagina.evaluate(() => { try { localStorage.removeItem('cockpit-atalhos'); } catch {} });
  } catch (e) {
    problemas.push('o percurso estourou: ' + String(e && e.message).slice(0, 300));
  }

  for (const p of passos) {
    const m = p.medida || {};
    if (!m.folhasComRegras) problemas.push(p.arquivo + ': NENHUMA folha de estilo com regras');
    if (m.imagensQuebradas) problemas.push(p.arquivo + ': ' + m.imagensQuebradas + ' imagem(ns) quebrada(s)');
    if (m.existe && !m.visivel) problemas.push(p.arquivo + ': o alvo tem tamanho zero');
    if (!m.semRolagemLateral) problemas.push(p.arquivo + ': a página rola para os lados');
  }
  if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
  if (requisicoes.length) problemas.push(requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));

  console.log(JSON.stringify({ passos, erros, requisicoes, problemas }, null, 2));
  await navegador.close();
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => { console.error('ROTEIRO QUEBROU:', e); process.exit(1); });

function espera(ms) { return new Promise((r) => setTimeout(r, ms)); }
`;

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      console.error(`   PNGs NÃO gerados: ${PNGS.join(', ')}`);
      limpar();
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-nav-atalhos-'));
    fs.writeFileSync(path.join(scratch, 'pane.js'), ROTEIRO);

    t(['new-session', '-d', '-s', 'teste', '-n', CARIMBO, '-c', '/tmp', 'sleep 600']);

    const ambiente = { ...process.env };
    delete ambiente.COCKPIT_TOKEN;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: 'teste',
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_CARENCIA_ABA_MS: '600000',
      COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
      COCKPIT_VIGIA_MS: '0', // sem HOME falso aqui — a trava do COCKPIT_CONTATO já cobre, isto é cinto e suspensório
    });
    s3 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (s3.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      ok(false, `S3 (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · S3 no ar em http://127.0.0.1:${PORTA} (pid ${s3.pid}), socket ${SOCKET}`);

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-v', `${scratch}:/w:ro`, '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker);

    let relatorio = null;
    const abre = saidaDocker.indexOf('{');
    if (abre >= 0) { try { relatorio = JSON.parse(saidaDocker.slice(abre)); } catch { relatorio = null; } }

    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : 'os cinco percursos passaram: CSS, console, requisições e os cinco elementos-alvo');
    for (const nome of PNGS) {
      const arquivo = path.join(SAIDA, nome);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }
    saida = falhas ? 1 : 0;
  } finally {
    limpar();
    console.log(`\n${falhas ? '❌ SMOKE DE NAVEGADOR VERMELHO' : '✅ SMOKE DE NAVEGADOR VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
    if (!falhas) {
      console.log('FALTA AINDA, e não é automático: abrir os cinco PNGs e OLHAR (regra de 25/08).');
    }
  }
  process.exit(saida);
})().catch((e) => {
  console.error('\n❌ o smoke de navegador quebrou:', e.message, '\n');
  limpar();
  process.exit(1);
});
