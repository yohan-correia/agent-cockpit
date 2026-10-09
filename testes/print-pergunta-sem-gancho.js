#!/usr/bin/env node
'use strict';
// PRINT DO AVISO "HOOK DA PERGUNTA NÃO INSTALADO" (card pergunta-sem-gancho-avisa) — ANTES e DEPOIS, 390x844.
//
// Chromium de verdade sobre o cockpit de verdade, com o `server.js` subindo como processo FILHO
// (`spawn`, nunca `require`) num mundo de mentira: tmux num socket próprio, `/proc` falso
// (`COCKPIT_PROC_RAIZ`) e `sessions/<pid>.json` falso dizendo `status: waiting`. Uma aba só, "pergunta",
// com a tela medida `m1-01-pergunta-aberta.txt` e SEM arquivo do hook: é o mundo em que o hook nunca rodou.
// O HOME falso tem um settings SEM o hook (cenário `sem`); no DEPOIS o host troca o settings para COM o
// hook e confere que o servidor passa a dizer `semGancho: false` (cenário `com`, prova do cache por mtime).
//
// ANTES = o `server.js` de uma cópia da develop (env SERVIDOR): o aviso nem existe. Só registra.
// DEPOIS = o `server.js` desta worktree. Cada rodada escreve na SUA subpasta (SAIDA/antes ou
// SAIDA/depois) e só recusa se a SUBPASTA já tiver PNG.
//
// Uso:
//   SAIDA=<pasta> node testes/print-pergunta-sem-gancho.js                                  (DEPOIS)
//   SAIDA=<pasta> SERVIDOR=/tmp/xyz/server.js node testes/print-pergunta-sem-gancho.js      (ANTES)
// Opcional: PORT (padrão 18977). Nunca 7879 (produção), 7897, 7899 (jobs) nem 7912.
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs vão cair>');
  process.exit(2);
}

const RAIZ = path.resolve(__dirname, '..');
const SERVIDOR = process.env.SERVIDOR ? path.resolve(process.env.SERVIDOR) : path.join(RAIZ, 'server.js');
const ANTES = Boolean(process.env.SERVIDOR);
const PREFIXO = ANTES ? 'antes' : 'depois';
const PORTA = Number(process.env.PORT) || 18977;
if ([7879, 7897, 7899, 7912].includes(PORTA)) {
  console.error(`🔴 a porta ${PORTA} é de produção ou dos jobs — recuso.`);
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const FIXTURES = path.join(RAIZ, 'testes', 'fixtures', 'pergunta');
const TELA_PERGUNTA = path.join(FIXTURES, 'telas', 'm1-01-pergunta-aberta.txt');
const TEXTO_AVISO = 'Cartão da pergunta desligado: o hook não está instalado (DECISOES.md, D74).';
const CWD_FALSO = '/srv/demo/projeto';
const SETTINGS_SEM = { hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: '/bin/true' }] }] } };

// ─── Fail-closed do socket, mesmo padrão dos outros prints ───────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-semgancho-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
// As sessões que ESTE script cria. A limpeza fail-closed compara o socket com este conjunto
// antes de derrubar qualquer coisa (D35).
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

// ─── O mundo de mentira — mesmo arreio do print-arrastar-aba.js ──────────────

const raizProc = (scratch) => path.join(scratch, 'proc');

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
function plantarAgenteFalso(scratch, pid, { starttime }) {
  const dir = path.join(raizProc(scratch), String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = '(claude)';
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);
  campos[5] = String(pid);
  campos[6] = '34816';
  campos[7] = String(pid);
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), '/usr/bin/claude\0');
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

/** O `sessions/<pid>.json` do CLI — `status: waiting` + `statusUpdatedAt`, que é o que o V4 do hook lê. */
function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime, statusDesde }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive',
    sessionId: sessaoId,
    cwd,
    status: 'waiting',
    updatedAt: Date.now(),
    statusUpdatedAt: statusDesde,
    pid,
    procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

/** Onde o CLI guarda a fita — a MESMA convenção de `arquivoDaSessao` (lib/abas.js): cwd com hífens. */
function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
})}\n`;

function escreverConversaCurta(caminho, nome) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  const base = Date.now() - 600000;
  fs.writeFileSync(caminho, [
    linhaHumano(new Date(base).toISOString(), `oi, sou a conversa ${nome}`),
    linhaAssistente(new Date(base + 30000).toISOString(), `resposta da conversa ${nome}`),
  ].join(''));
}

function pedir(rota) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: rota, timeout: 2000, agent: false }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(corpo); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}


// ─── O roteiro do navegador — roda DENTRO do container ───────────────────────

const ROTEIRO = `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const ANTES = process.env.ANTES === '1';
const CENARIO = process.env.CENARIO;
const PREFIXO = ANTES ? 'antes' : 'depois';
const TEXTO_AVISO = ${JSON.stringify(TEXTO_AVISO)};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const problemas = [];
  const erros = [];
  const requisicoes = [];
  let medidas = null;

  try {
    const p = await navegador.newPage();
    p.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
    p.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
    p.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });
    await p.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* modo privado */ } });
    await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await p.waitForSelector('#abas', { timeout: 15000 });
    await espera(700);

    const abriu = await p.evaluate((alvo) => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
      const linha = linhas.find((l) => {
        const t2 = l.querySelector('.conversa-titulo');
        return t2 && t2.textContent.includes(alvo);
      });
      const botao = linha && linha.querySelector('.conversa');
      if (!botao) return false;
      botao.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    }, 'pergunta');
    if (!abriu) problemas.push('não achei a aba "pergunta" na lista');

    const perguntou = await p.waitForFunction(() => {
      const el = document.querySelector('.painel:not([hidden]) .pergunta');
      return Boolean(el) && !el.hidden;
    }, { timeout: 25000 }).then(() => true, () => false);
    if (!perguntou) problemas.push('a .pergunta não abriu — a foto não seria prova');

    if (!ANTES && CENARIO === 'sem') {
      const apareceu = await p.waitForFunction(() => {
        const a = document.querySelector('.painel:not([hidden]) .aviso-gancho');
        return Boolean(a) && !a.hidden;
      }, { timeout: 20000 }).then(() => true, () => false);
      if (!apareceu) problemas.push('o .aviso-gancho não apareceu (o servidor não mandou semGancho?)');
    }
    await espera(800);

    // SEM rolar nada: é a vista que o dono recebe. Tudo medido no navegador.
    medidas = await p.evaluate(() => {
      const raiz = document.querySelector('.painel:not([hidden])');
      const vis = (e) => Boolean(e) && !e.hidden && e.getClientRects().length > 0;
      const q = (s) => raiz.querySelector(s);
      const aviso = q('.aviso-gancho');
      const r = aviso ? aviso.getBoundingClientRect() : null;
      const teclas = q('.pergunta-teclas');
      return {
        perguntaVisivel: vis(q('.pergunta')),
        telaVisivel: vis(q('.pergunta-tela')),
        teclasVisiveis: vis(teclas),
        avisoExiste: Boolean(aviso),
        avisoVisivel: vis(aviso),
        avisoTexto: aviso ? aviso.textContent : null,
        avisoTop: r ? Math.round(r.top) : null,
        avisoBottom: r ? Math.round(r.bottom) : null,
        alturaJanela: window.innerHeight,
        avisoNaVista: Boolean(r) && vis(aviso) && r.top >= 0 && r.bottom <= window.innerHeight,
        paginaTransborda: document.scrollingElement.scrollWidth > window.innerWidth + 1,
      };
    });
    const nome = ANTES ? 'antes-sem-gancho-390.png' : (CENARIO === 'sem' ? 'depois-sem-gancho-390.png' : 'depois-com-gancho-390.png');
    await p.screenshot({ path: '/out/' + nome });

    if (!medidas.perguntaVisivel) problemas.push('a .pergunta não está visível');
    if (!medidas.telaVisivel) problemas.push('a .pergunta-tela (terminal cru) deveria estar visível');
    if (ANTES) {
      // No ANTES o aviso nem existe: só registra.
      if (medidas.avisoVisivel) problemas.push('ANTES: não deveria haver .aviso-gancho visível');
    } else if (CENARIO === 'sem') {
      if (!medidas.avisoVisivel) problemas.push('o .aviso-gancho não está visível');
      if (!medidas.avisoNaVista) problemas.push('o .aviso-gancho está fora do viewport (top ' + medidas.avisoTop + ', bottom ' + medidas.avisoBottom + ', janela ' + medidas.alturaJanela + ')');
      if (medidas.avisoTexto !== TEXTO_AVISO) problemas.push('texto do aviso diferente do pt-BR esperado: ' + JSON.stringify(medidas.avisoTexto));
      if (!medidas.teclasVisiveis) problemas.push('as teclas deveriam estar visíveis');
      if (medidas.paginaTransborda) problemas.push('a página transborda para o lado');
    } else if (medidas.avisoVisivel) {
      problemas.push('COM o hook instalado o .aviso-gancho deveria estar escondido');
    }
  } catch (e) {
    problemas.push('o roteiro estourou: ' + String(e && e.message).slice(0, 300));
  }

  if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
  if (requisicoes.length) problemas.push(requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));

  await navegador.close();
  console.log('@@MEDIDAS-SEMGANCHO@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;

// ─── Corrida ──────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let filho = null;
  let scratch = null;

  function limpar() {
    let falhouLimpeza = false;
    if (filho && filho.exitCode === null) {
      try { process.kill(filho.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${filho.pid}) derrubado pelo pid exato`);
    }
    // D35: o carimbo prova que EU criei o socket; a enumeração prova que não há mais ninguém nele.
    // Matar exige as duas respostas.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean);
    const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      falhouLimpeza = true;
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      falhouLimpeza = true;
      falhas += 1;
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    return !falhouLimpeza;
  }

  /** Uma rodada do roteiro no container; devolve os problemas (lista) e imprime as medidas. */
  async function rodarRoteiro(cenario, subpasta) {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `ANTES=${ANTES ? '1' : '0'}`,
      '-e', `CENARIO=${cenario}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${subpasta}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));

    const MARCADOR = '@@MEDIDAS-SEMGANCHO@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    let relatorio = null;
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    if (!relatorio) console.log(saidaDocker);
    else console.log(`  · medidas (${cenario}): ${JSON.stringify(relatorio.medidas)}`);
    return relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
  }

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      limpar();
      return process.exit(2);
    }
    for (const arquivo of [SERVIDOR, TELA_PERGUNTA]) {
      if (!fs.existsSync(arquivo)) {
        console.error(`🟡 ambiente indisponível: falta ${arquivo}`);
        limpar();
        return process.exit(2);
      }
    }

    const subpasta = path.join(SAIDA, PREFIXO);
    fs.mkdirSync(subpasta, { recursive: true });
    if (fs.readdirSync(subpasta).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${subpasta} já tem PNG — apague ou troque de pasta. O print recusa sobrescrever.`);
      limpar();
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-semgancho-'));
    const home = path.join(scratch, 'home');
    const dirPerguntas = path.join(scratch, 'perguntas');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(dirPerguntas, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // O settings do HOME falso: SEM o hook da pergunta. O host o troca no meio do DEPOIS.
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify(SETTINGS_SEM));

    // Uma aba só, 140x50 (a tela medida cabe inteira). Sem arquivo do hook.
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'pergunta', '-x', '140', '-y', '50', '-c', os.tmpdir(),
      `cat '${TELA_PERGUNTA}'; exec sleep 100000`]);

    const panes = {};
    for (const linha of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    if (!panes.pergunta) throw new Error('a pane "pergunta" não apareceu no list-panes');

    const sessaoId = '5c2d7e90-1a3b-4f68-8d42-6e0b9c1a7f35';
    escreverConversaCurta(caminhoDoJsonl(home, CWD_FALSO, sessaoId), 'pergunta');
    const pane = panes.pergunta;
    plantarAgenteFalso(scratch, pane.panePid, { starttime: 2000001 });
    escreverSessao(home, {
      pid: pane.panePid, janela: pane.janelaId, pane: pane.paneId,
      sessaoId, cwd: CWD_FALSO, starttime: 2000001, statusDesde: Date.now(),
    });
    console.log('  · fixture pronta: aba "pergunta" sem arquivo do hook, settings sem o hook');

    const ambiente = { ...process.env };
    delete ambiente.COCKPIT_TOKEN;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_PERGUNTAS_DIR: dirPerguntas,
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'),
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_LEITURAS_DIR: path.join(scratch, 'leituras'),
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
    });
    filho = spawn(process.execPath, [SERVIDOR], { env: ambiente, stdio: ['ignore', 'ignore', 'pipe'] });
    let erroDoFilho = '';
    filho.stderr.on('data', (d) => { erroDoFilho += d; if (erroDoFilho.length > 65536) erroDoFilho = erroDoFilho.slice(-32768); });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (filho.exitCode !== null) break;
      pronto = (await pedir('/health')).status === 200;
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      ok(false, `o servidor (${PORTA}) não subiu: ${erroDoFilho.trim().split('\n').slice(-3).join(' | ')}`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · ${ANTES ? 'ANTES' : 'DEPOIS'}: servidor ${SERVIDOR} em http://127.0.0.1:${PORTA} (pid ${filho.pid}), socket ${SOCKET}`);

    let chave = null;
    for (let i = 0; i < 40 && !chave; i += 1) {
      const lista = (await pedir('/api/abas')).json;
      const todas = Array.isArray(lista) ? lista : ((lista && lista.abas) || []);
      const aba = todas.find((a) => a.titulo === 'pergunta');
      if (aba && aba.esperando) chave = aba.chave;
      else await espera(250);
    }
    if (!ok(Boolean(chave), 'a aba "pergunta" está em `waiting` na lista do servidor')) {
      limpar();
      return process.exit(1);
    }

    fs.writeFileSync(path.join(scratch, 'roteiro.js'), ROTEIRO);

    if (ANTES) {
      const problemas = await rodarRoteiro('sem', subpasta);
      ok(problemas.length === 0, problemas.length
        ? `o percurso reprovou: ${problemas.join(' · ')}`
        : 'ANTES: a .pergunta abre só com o terminal cru e nenhum aviso (o defeito: pergunta calada)');
      const arquivo = path.join(subpasta, 'antes-sem-gancho-390.png');
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    } else {
      // 1. Antes do navegador: a API tem de dizer o que o print vai mostrar.
      let r = null;
      for (let i = 0; i < 20; i += 1) {
        r = await pedir(`/api/abas/${chave}/tela`);
        if (r.json && r.json.semGancho === true) break;
        await espera(250);
      }
      if (!ok(Boolean(r.json) && r.json.semGancho === true && r.json.cartao === null,
        'GET …/tela devolve semGancho true e cartao null (settings sem o hook)')) {
        limpar();
        return process.exit(1);
      }

      // 2. Cenário SEM o hook: o aviso na vista, sem rolar.
      const semProblemas = await rodarRoteiro('sem', subpasta);
      ok(semProblemas.length === 0, semProblemas.length
        ? `SEM o hook reprovou: ${semProblemas.join(' · ')}`
        : 'DEPOIS (sem o hook): aviso visível dentro do viewport, texto pt-BR, terminal cru e teclas à vista');

      // 3. O host instala o hook (settings novo + script) e o servidor tem de notar (cache por mtime).
      const share = path.join(scratch, 'share');
      fs.mkdirSync(share, { recursive: true });
      const script = path.join(share, 'gancho-pergunta.js');
      fs.writeFileSync(script, '// presença basta: o servidor só confere que o arquivo existe\n');
      fs.writeFileSync(settings, JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `/usr/bin/node ${script} 2>/dev/null || true`, timeout: 5 }] }] },
      }));
      let r2 = null;
      for (let i = 0; i < 20; i += 1) {
        r2 = await pedir(`/api/abas/${chave}/tela`);
        if (r2.json && r2.json.semGancho === false) break;
        await espera(250);
      }
      if (!ok(Boolean(r2.json) && r2.json.semGancho === false,
        'GET …/tela passa a semGancho false depois de instalar o hook (cache por mtime)')) {
        limpar();
        return process.exit(1);
      }

      // 4. Cenário COM o hook: aviso escondido, terminal cru de sempre.
      const comProblemas = await rodarRoteiro('com', subpasta);
      ok(comProblemas.length === 0, comProblemas.length
        ? `COM o hook reprovou: ${comProblemas.join(' · ')}`
        : 'DEPOIS (com o hook): aviso escondido e o terminal cru de sempre');

      for (const nome of ['depois-sem-gancho-390.png', 'depois-com-gancho-390.png']) {
        const arquivo = path.join(subpasta, nome);
        ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
      }
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o print estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ PRINT DO AVISO DE HOOK VERMELHO' : '✅ PRINT DO AVISO DE HOOK VERDE'}`
      + ` (${PREFIXO}) — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}/${PREFIXO}\n`);
  }
  process.exit(saida);
})();
