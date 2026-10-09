#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR do campo Modelo da aba nova — Chromium de verdade, molde LITERAL de
// `smoke-navegador-abas.js` (fail-closed do socket, carimbo de posse, `limpar()`, roteiro
// dentro do container `cockpit-smoke:latest`, `--network host`, `/out` montado em SAIDA).
//
// Card `modelo-na-nova-aba`. Spec: docs/superpowers/specs/2026-10-05-modelo-na-nova-aba-design.md
// (§6.2). Plano: docs/superpowers/plans/2026-10-05-modelo-na-nova-aba-plano.md (Fase 5).
//
// Diferenças do molde:
//   · porta SORTEADA, não a 7896 fixa do smoke de abas — os dois podem rodar ao mesmo tempo.
//   · COCKPIT_BIN_CLAUDE=/bin/true — nenhum CLI de verdade; nenhuma aba é criada neste smoke.
//   · isolamento #78 por LISTA FECHADA de todas as pastas que algum módulo do servidor possa
//     tocar — nenhuma escreve no disco do dono.
//   · `evaluateOnNewDocument` fixa `localStorage['cockpit-idioma']='pt-BR'`: o Chromium da
//     imagem fala inglês (molde: smoke-idioma.js:39), e os EXIGIR abaixo leem texto em pt-BR.
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const SAIDA = process.env.SAIDA || path.join(os.homedir(), '.cockpit', 'smoke-shots', '2026-10-05-modelo-na-nova-aba');

// ─── Fail-closed, na mesma ordem do smoke de tmux/abas ────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

const SOCKET = `cockpit-smoke-modelo-${process.pid}`;
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

async function portaLivre() {
  const servidor = net.createServer();
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const porta = servidor.address().port;
  await new Promise((resolve) => servidor.close(resolve));
  return porta;
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

let s3 = null;
let scratch = null;

function limpar() {
  if (s3 && s3.exitCode === null) {
    try { process.kill(s3.pid); } catch { /* já morreu */ }
    console.log(`  · servidor de teste (pid ${s3.pid}) derrubado pelo pid exato`);
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

  const problemas = [];
  const passos = [];

  for (const [W, H, rotulo] of [[1600, 1000, '01'], [390, 844, '02']]) {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: W, height: H });
    // O Chromium da imagem fala inglês — fixa pt-BR antes de qualquer script correr, para os
    // EXIGIR abaixo lerem os textos certos (molde: smoke-idioma.js:39).
    await pagina.evaluateOnNewDocument(() => {
      localStorage.setItem('cockpit-idioma', 'pt-BR');
    });

    const erros = [];
    const requisicoes = [];
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
    pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
    pagina.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });

    const clicar = (sel) => pagina.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.click();
      return true;
    }, sel);

    async function print(arquivo) {
      // Sem catch calado: print que falha tem que reprovar o smoke, senão um PNG antigo
      // na mesma pasta passaria no gate de tamanho (painel de execução, 06/10). Sem crase
      // aqui dentro: este trecho vive numa template string.
      await pagina.screenshot({ path: '/out/' + arquivo });
    }

    try {
      await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 45000 });
      await pagina.waitForSelector('#abas', { timeout: 15000 });

      if (!await clicar('#btn-nova-aba')) problemas.push(rotulo + ': não há #btn-nova-aba na tela');
      await pagina.waitForFunction(
        () => document.querySelectorAll('#sel-modelo-novo option').length >= 5,
        { timeout: 15000 },
      ).catch(() => problemas.push(rotulo + ': #sel-modelo-novo nunca chegou a 5 opções'));
      // O <dialog> entra com fade (@starting-style, public/estilo.css:1860). Sem esperar a
      // opacidade chegar a 1, o PNG "como o dono vê" sai com o diálogo meio transparente —
      // aconteceu na primeira rodada deste smoke, e só o olho pegou.
      await pagina.waitForFunction(
        () => getComputedStyle(document.querySelector('#dialogo-nova-aba')).opacity === '1',
        { timeout: 5000 },
      ).catch(() => problemas.push(rotulo + ': #dialogo-nova-aba não terminou o fade (opacidade != 1)'));

      const medida = await pagina.evaluate(() => {
        const folhas = Array.from(document.styleSheets).filter((f) => {
          try { return f.cssRules && f.cssRules.length > 0; } catch { return true; }
        }).length;
        const dialogo = document.querySelector('#dialogo-nova-aba');
        const campo = document.querySelector('#campo-modelo-novo');
        const sel = document.querySelector('#sel-modelo-novo');
        const r = campo ? campo.getBoundingClientRect() : null;
        return {
          folhasComRegras: folhas,
          dialogoAberto: Boolean(dialogo && dialogo.open),
          campoExiste: Boolean(campo),
          campoHidden: campo ? campo.hidden : null,
          caixa: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
          dentro: r
            ? (r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5)
            : null,
          valores: sel ? Array.from(sel.options).map((o) => o.value) : null,
          textos: sel ? Array.from(sel.options).map((o) => o.textContent) : null,
          agenteValor: document.querySelector('#sel-agente-novo') ? document.querySelector('#sel-agente-novo').value : null,
        };
      });
      passos.push({ arquivo: rotulo + 'a-dialogo.png', medida });

      if (!medida.dialogoAberto) problemas.push(rotulo + ': #dialogo-nova-aba não está aberto na hora do print');
      if (!medida.campoExiste) problemas.push(rotulo + ': #campo-modelo-novo não existe no DOM');
      if (medida.campoHidden !== false) problemas.push(rotulo + ': #campo-modelo-novo está hidden com o Claude selecionado');
      if (!medida.caixa || medida.caixa.w <= 0 || medida.caixa.h <= 0) problemas.push(rotulo + ': #campo-modelo-novo tem tamanho zero');
      if (medida.dentro !== true) problemas.push(rotulo + ': #campo-modelo-novo não cabe inteiro na viewport');
      if (JSON.stringify(medida.valores) !== JSON.stringify(['', 'opus', 'fable', 'sonnet', 'haiku'])) {
        problemas.push(rotulo + ': valores das opções != [\\'\\',opus,fable,sonnet,haiku] (achei ' + JSON.stringify(medida.valores) + ')');
      }
      if (JSON.stringify(medida.textos) !== JSON.stringify(['Padrão', 'Opus', 'Fable', 'Sonnet', 'Haiku'])) {
        problemas.push(rotulo + ': textos das opções != [Padrão,Opus,Fable,Sonnet,Haiku] (achei ' + JSON.stringify(medida.textos) + ')');
      }
      if (medida.agenteValor !== 'claude') problemas.push(rotulo + ': #sel-agente-novo.value != claude (achei ' + medida.agenteValor + ')');

      await print(rotulo + 'a-dialogo.png');

      // O popup do <select> nativo não sai em screenshot headless (desenhado pelo sistema).
      // Só NO NAVEGADOR DO SMOKE, nunca no app: size=5 desenha as 5 opções no PNG.
      await pagina.evaluate(() => { document.querySelector('#sel-modelo-novo').size = 5; });
      await print(rotulo + 'b-dialogo-opcoes.png');

      if (rotulo === '02') {
        // Celular: trocar para Codex esconde o campo.
        await pagina.evaluate(() => {
          const s = document.querySelector('#sel-agente-novo');
          s.value = 'codex';
          s.dispatchEvent(new Event('change'));
        });
        const campoCodex = await pagina.evaluate(() => {
          const c = document.querySelector('#campo-modelo-novo');
          return c ? c.hidden : null;
        });
        if (campoCodex !== true) problemas.push('03: #campo-modelo-novo não escondeu com Codex (achei ' + campoCodex + ')');
        await print('03-dialogo-codex.png');
      }
    } catch (e) {
      problemas.push(rotulo + ': o percurso estourou: ' + String(e && e.message).slice(0, 200));
    }

    for (const p of passos) {
      const m = p.medida || {};
      if (!m.folhasComRegras) problemas.push(p.arquivo + ': NENHUMA folha de estilo com regras');
    }
    if (erros.length) problemas.push(rotulo + ': ' + erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
    if (requisicoes.length) problemas.push(rotulo + ': ' + requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));

    await pagina.close();
  }

  console.log(JSON.stringify({ passos, problemas }, null, 2));
  await navegador.close();
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => { console.error('ROTEIRO QUEBROU:', e); process.exit(1); });
`;

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      console.error('   PNGs NÃO gerados: 01a/01b-dialogo*.png, 02a/02b-dialogo*.png, 03-dialogo-codex.png');
      limpar();
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    const inicioDaRodada = Date.now();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-modelo-aba-'));
    fs.writeFileSync(path.join(scratch, 'pane.js'), ROTEIRO);

    const PORTA = await portaLivre();

    // A sessão de teste: a âncora carimbada mais uma janela, para nenhum DELETE/vigia tocar a
    // última janela durante o percurso.
    t(['new-session', '-d', '-s', 'teste', '-n', CARIMBO, '-c', '/tmp', 'sleep 600']);
    t(['new-window', '-d', '-t', 'teste:', '-n', 'companhia', '-c', '/tmp', 'sleep 600']);

    const home = fs.mkdtempSync(path.join(scratch, 'home-'));
    const projetosDir = fs.mkdtempSync(path.join(scratch, 'projetos-'));
    fs.mkdirSync(path.join(projetosDir, 'projeto-smoke'));

    const ambiente = { ...process.env };
    delete ambiente.COCKPIT_TOKEN;
    Object.assign(ambiente, {
      HOME: home,
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: 'teste',
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PROJETOS_DIR: projetosDir,
      // Isolamento #78 por LISTA FECHADA: toda pasta que algum módulo do servidor possa
      // tocar nasce em `scratch`, descartável — nenhuma escreve no disco do dono.
      COCKPIT_JOBS_DIR: fs.mkdtempSync(path.join(scratch, 'jobs-')),
      COCKPIT_LIDAS_DIR: fs.mkdtempSync(path.join(scratch, 'lidas-')),
      COCKPIT_PUSH_DIR: fs.mkdtempSync(path.join(scratch, 'push-')),
      COCKPIT_USO_DIR: fs.mkdtempSync(path.join(scratch, 'uso-')),
      COCKPIT_USO_CODEX_DIR: fs.mkdtempSync(path.join(scratch, 'uso-codex-')),
      COCKPIT_LEITURAS_DIR: fs.mkdtempSync(path.join(scratch, 'leituras-')),
      COCKPIT_STATUS_CODEX_DIR: fs.mkdtempSync(path.join(scratch, 'status-codex-')),
      COCKPIT_CLEAR_CODEX_DIR: fs.mkdtempSync(path.join(scratch, 'clear-codex-')),
      COCKPIT_INBOX: fs.mkdtempSync(path.join(scratch, 'inbox-')),
    });
    s3 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (s3.exitCode !== null) break;
      pronto = await saude(PORTA);
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      ok(false, `servidor de teste (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · servidor de teste no ar em http://127.0.0.1:${PORTA} (pid ${s3.pid}), socket ${SOCKET}`);

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
      : 'o percurso (desktop + celular) passou: CSS, console, requisições e o campo Modelo');
    for (const nome of ['01a-dialogo.png', '01b-dialogo-opcoes.png', '02a-dialogo.png', '02b-dialogo-opcoes.png', '03-dialogo-codex.png']) {
      const arquivo = path.join(SAIDA, nome);
      // mtime ≥ início desta rodada: a pasta SAIDA é reaproveitada entre rodadas, e um PNG
      // de ontem com > 10 KB não é prova de hoje.
      const st = fs.existsSync(arquivo) ? fs.statSync(arquivo) : null;
      ok(Boolean(st) && st.size > 10 * 1024 && st.mtimeMs >= inicioDaRodada, `${arquivo} gerado nesta rodada (> 10 KB)`);
    }
    saida = falhas ? 1 : 0;
  } finally {
    limpar();
    console.log(`\n${falhas ? '❌ SMOKE DO CAMPO MODELO VERMELHO' : '✅ SMOKE DO CAMPO MODELO VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
    if (!falhas) {
      console.log('FALTA AINDA, e não é automático: abrir os PNGs e OLHAR (regra de 25/08).');
    }
  }
  process.exit(saida);
})().catch((e) => {
  console.error('\n❌ o smoke do campo Modelo quebrou:', e.message, '\n');
  limpar();
  process.exit(1);
});
