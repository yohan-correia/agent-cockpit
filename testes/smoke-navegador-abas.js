#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR das abas — Chromium de verdade, viewport de CELULAR.
//
// Por que ele existe, e por que não é o `smoke-navegador-externo`: aquele trava em
// 1600x1000 e não lê `VIEWPORT=`. A regra de 25/08 manda provar no aparelho que motivou a
// mudança, e o cockpit existe para o celular — 390x844. Enquanto o wrapper não aceitar a
// variável, o passo é este script.
//
// E por que ele reprova por ELEMENTO-ALVO AUSENTE: em 24/08 dois jobs entregaram com smoke
// verde e o recurso novo não aparecia em PNG nenhum — os quatro prints pegaram a tela de
// "escolha uma conversa". Aqui, se o `#dialogo-nova-aba` não estiver `open` na hora do
// print, o script reprova ANTES de alguém precisar olhar a figura.
//
// O que ele NÃO decide: se a tela resolve o problema do usuário. Isso é juízo de produto, e
// os três PNGs vão para ele.
//
// Contrato (§5.5 da spec):
//   S3 na porta 7896 · socket `cockpit-smoke-nav-<pid>` · sessão `teste`
//   COCKPIT_BIN_CLAUDE=/bin/true      — a janela nasce e nenhum CLI escreve arquivo nunca
//   COCKPIT_CARENCIA_ABA_MS=600000    — é o que segura o `⋯` na tela o percurso inteiro
//   COCKPIT_CERT_DIR=/dev/null (#19)  · sem COCKPIT_TOKEN
//   NUNCA contra a produção (7879), que fala com a `main` do usuário.
//
// Códigos de saída:  0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7896;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const SAIDA = process.env.SAIDA || '/tmp/smoke-abas';
const LARGURA = 390;
const ALTURA = 844;

// ─── Ambiente indisponível (§5.3.1): sem projeto, sai 2 e nomeia os PNGs que faltaram ────

function primeiroProjeto() {
  try {
    return fs.readdirSync(path.join(os.homedir(), 'projetos'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name).sort((a, b) => a.localeCompare(b))[0] || null;
  } catch { return null; }
}

const PROJETO = primeiroProjeto();
if (!PROJETO) {
  console.error('🟡 ambiente indisponível: não há projeto em ~/projetos.');
  console.error('   PNGs NÃO gerados: 01-nova-aba.png, 02-lista-nascendo.png, 03-matar-aba.png');
  process.exit(2);
}

// ─── Fail-closed, na mesma ordem do smoke de tmux ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

const SOCKET = `cockpit-smoke-nav-${process.pid}`;
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
  // Só derruba o socket cujo carimbo de posse ele mesmo plantou.
  const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
    .split('\n').some((n) => n.trim() === CARIMBO);
  if (temCarimbo) t(['kill-server'], { tolerante: true });
  else console.error(`  🔴 a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}

// ─── O roteiro do navegador, que roda DENTRO do container ────────────────────
//
// `require('/app/node_modules/puppeteer-core')` e `executablePath: '/usr/bin/chromium'`:
// é o mesmo motor do wrapper, então zero dependência nova no package.json.

const ROTEIRO = `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const PROJETO = process.env.PROJETO;
const W = Number(process.env.W), H = Number(process.env.H);

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: W, height: H });

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
   * Tira o print E confere que o ALVO está mesmo na tela: presente no DOM, aberto quando
   * for <dialog>, inteiro dentro da viewport, com alvo de toque de 40px, e sem rolagem
   * horizontal na página. É o "elemento-alvo ausente" que impede o defeito de 24/08.
   */
  async function print(arquivo, alvo, toque, precisaAberto) {
    const medida = await pagina.evaluate((sel, selToque, exigeAberto) => {
      const folhas = Array.from(document.styleSheets).filter((f) => {
        try { return f.cssRules && f.cssRules.length > 0; } catch { return true; }
      }).length;
      // As métricas da PÁGINA saem sempre, mesmo sem o alvo: medi-las só quando o elemento
      // existe fazia "o botão não existe" virar TAMBÉM "a tela está sem CSS" — diagnóstico
      // errado, que mandaria alguém procurar no lugar errado.
      const geral = {
        semRolagemLateral: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        folhasComRegras: folhas,
        imagensQuebradas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
        texto: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
      };
      const el = document.querySelector(sel);
      if (!el) return Object.assign({ existe: false }, geral);
      const r = el.getBoundingClientRect();
      const tq = selToque ? document.querySelector(selToque) : null;
      const rt = tq ? tq.getBoundingClientRect() : null;
      return Object.assign({}, geral, {
        existe: true,
        aberto: exigeAberto ? Boolean(el.open) : true,
        visivel: r.width > 0 && r.height > 0,
        dentro: r.left >= -0.5 && r.top >= -0.5
          && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
        caixa: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        toque: rt ? Math.round(Math.min(rt.width, rt.height)) : null,
      });
    }, alvo, toque || null, Boolean(precisaAberto));
    await pagina.screenshot({ path: '/out/' + arquivo }).catch(() => {});
    passos.push({ arquivo, alvo, toque, medida });
    return medida;
  }

  const problemas = [];
  try {
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 45000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });

    // 01 — o + do topo da lateral abre o diálogo de aba nova.
    if (!await clicar('#btn-nova-aba')) problemas.push('não há #btn-nova-aba na tela');
    await espera(600);
    const m1 = await print('01-nova-aba.png', '#dialogo-nova-aba', '#btn-nova-aba', true);
    if (!m1.existe) problemas.push('01: #dialogo-nova-aba não existe no DOM');
    else if (!m1.aberto) problemas.push('01: #dialogo-nova-aba não está aberto na hora do print');
    const temProjeto = await pagina.evaluate(() => {
      const s = document.querySelector('#sel-projeto-novo');
      return Boolean(s && s.options && s.options.length > 0);
    });
    if (!temProjeto) problemas.push('01: a lista de projetos está vazia no diálogo');
    const temCriar = await pagina.evaluate(() => Boolean(document.querySelector('#btn-criar-aba')));
    if (!temCriar) problemas.push('01: não há botão Criar no diálogo');

    // 02 — criar a aba e voltar para a LISTA: é lá que o pino ⋯ mora.
    await pagina.evaluate((nome) => {
      const s = document.querySelector('#sel-projeto-novo');
      if (s) { s.value = nome; s.dispatchEvent(new Event('change')); }
    }, PROJETO);
    if (!await clicar('#btn-criar-aba')) problemas.push('02: não deu para clicar no Criar');
    await espera(2500);
    await clicar('.painel .btn-voltar');
    await espera(1200);
    const m2 = await print('02-lista-nascendo.png', '#abas', '.conversa-grupo[data-cwd] .conversa', false);
    if (!m2.existe) problemas.push('02: a lista de abas não existe no DOM');
    if (!/⋯/.test(m2.texto || '')) problemas.push('02: o pino ⋯ não aparece na lista');
    // O texto virou "abrindo o agente" quando o cockpit deixou de ser só-Claude (f163225,
    // 02/09) — o assert tinha ficado para trás, dizendo "claude" de um produto que já mudou.
    if (!/abrindo o agente/.test(m2.texto || '')) problemas.push('02: a lista não diz "abrindo o agente…"');

    // 03 — abrir a aba e tocar no fechar do cabeçalho da conversa.
    await pagina.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa'));
      const alvo = linhas.find((b) => /⋯/.test(b.textContent)) || linhas[0];
      if (alvo) alvo.click();
    });
    await espera(1200);
    if (!await clicar('.painel .btn-matar-aba')) problemas.push('03: não há .painel .btn-matar-aba no cabeçalho da conversa');
    await espera(600);
    const m3 = await print('03-matar-aba.png', '#dialogo-matar-aba', '.painel .btn-matar-aba', true);
    if (!m3.existe) problemas.push('03: #dialogo-matar-aba não existe no DOM');
    else if (!m3.aberto) problemas.push('03: #dialogo-matar-aba não está aberto na hora do print');
    // "claude" OU "agente": as frases da tela passam a falar de AGENTE quando o cockpit
    // ganha um segundo CLI, e este smoke ficaria vermelho por uma troca de texto que ele
    // não existe para vigiar. O que ele afirma é que o diálogo ESCREVE o estado da aba.
    if (!/subindo|TRABALHANDO|pergunta aberta|encerra o (claude|agente)|terminal comum|não tem (claude|agente)/.test(m3.texto || '')) {
      problemas.push('03: o diálogo não escreve o estado da aba');
    }
  } catch (e) {
    problemas.push('o percurso estourou: ' + String(e && e.message).slice(0, 200));
  }

  // As reprovas automáticas do contrato, aplicadas a cada passo.
  for (const p of passos) {
    const m = p.medida || {};
    if (!m.folhasComRegras) problemas.push(p.arquivo + ': NENHUMA folha de estilo com regras');
    if (m.imagensQuebradas) problemas.push(p.arquivo + ': ' + m.imagensQuebradas + ' imagem(ns) quebrada(s)');
    if (m.existe && !m.visivel) problemas.push(p.arquivo + ': o alvo tem tamanho zero');
    if (m.existe && !m.dentro) problemas.push(p.arquivo + ': o alvo não cabe inteiro na viewport ' + JSON.stringify(m.caixa));
    if (!m.semRolagemLateral) problemas.push(p.arquivo + ': a página rola para os lados em ' + W + 'px');
    if (p.toque && m.toque !== null && m.toque < 40) problemas.push(p.arquivo + ': alvo de toque menor que 40px (' + m.toque + ')');
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
      console.error('   PNGs NÃO gerados: 01-nova-aba.png, 02-lista-nascendo.png, 03-matar-aba.png');
      limpar();
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-nav-abas-'));
    fs.writeFileSync(path.join(scratch, 'pane.js'), ROTEIRO);

    // A sessão de teste: a âncora carimbada mais uma janela, para o DELETE nunca ser o da
    // última janela durante o percurso.
    t(['new-session', '-d', '-s', 'teste', '-n', CARIMBO, '-c', '/tmp', 'sleep 600']);
    t(['new-window', '-d', '-t', 'teste:', '-n', 'companhia', '-c', '/tmp', 'sleep 600']);

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
      '-e', `PROJETO=${PROJETO}`,
      '-e', `W=${LARGURA}`, '-e', `H=${ALTURA}`,
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
      : 'o percurso de celular passou: CSS, console, requisições, elementos-alvo e geometria');
    for (const nome of ['01-nova-aba.png', '02-lista-nascendo.png', '03-matar-aba.png']) {
      const arquivo = path.join(SAIDA, nome);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }
    saida = falhas ? 1 : 0;
  } finally {
    limpar();
    console.log(`\n${falhas ? '❌ SMOKE DE NAVEGADOR VERMELHO' : '✅ SMOKE DE NAVEGADOR VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
    if (!falhas) {
      console.log('FALTA AINDA, e não é automático: abrir os três PNGs e OLHAR (regra de 25/08).');
    }
  }
  process.exit(saida);
})().catch((e) => {
  console.error('\n❌ o smoke de navegador quebrou:', e.message, '\n');
  limpar();
  process.exit(1);
});
