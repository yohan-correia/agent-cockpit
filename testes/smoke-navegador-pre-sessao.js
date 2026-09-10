#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — pré-sessão: agente vivo, nenhuma sessão publicada (09/09).
//
// O defeito que ele congela: uma aba criada num projeto que o CLI nunca abriu para no prompt
// de confiança ("Do you trust this folder?"). Nesse instante o Claude ainda NÃO escreveu
// `~/.claude/sessions/<pid>.json` e o Codex ainda NÃO abriu rollout — medido nos dois em
// socket tmux isolado. A aba fica com `temAgente: true`, `esperando` falsy e arquivo nenhum:
// nenhum aviso no cabeçalho, fita vazia, e o cockpit parece quebrado enquanto há uma pergunta
// de sim/não esperando resposta que o usuário não tem como dar do celular.
//
// Esqueleto copiado de `testes/smoke-navegador-split.js` — mesma infra (fixture de /proc
// falso, tmux num socket próprio, docker run --network host com puppeteer-core).
//
// A fixture tem DUAS abas de propósito, e a comparação é o teste:
//   · `conversa-velha` — com `sessions/<pid>.json` e `.jsonl`. NADA nela pode mudar.
//   · `projeto-novo`   — /proc plantado (agente vivo) e nenhum dos dois arquivos, com o
//                        prompt de confiança impresso na pane de verdade.
//
// Asserts: o painel do projeto novo mostra o bloco da pane COM o texto do prompt · o Enviar
// trava · o Parar diz "Fechar o agente" (nunca "Cancelar pergunta": ali o Esc mata o agente) ·
// a aba antiga continua com fita e Enviar livre.
//
// MODO=antes roda o mesmo roteiro esperando o comportamento VELHO (tela vazia) — é como se
// tira o PNG do "antes" sem inventar fixture diferente. Ele só muda o veredito, nunca a
// fixture nem o print.
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

const MODO = process.env.MODO === 'antes' ? 'antes' : 'depois';
const PORTA = Number(process.env.PORT) || 7894;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const LARGURA = 1600;
const ALTURA = 1000;

// O texto que a pane do projeto novo carrega. É o prompt real do Claude Code, encurtado ao
// que importa para o teste: a pergunta e as duas opções com o cursor na primeira.
const PROMPT = [
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  ' Do you trust this folder?',
  '',
  ' > No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm - Esc to cancel',
].join('\n');

// ─── Fail-closed do socket, mesmo padrão dos outros smokes ───────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-presessao-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

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

// ─── Fixture ─────────────────────────────────────────────────────────────────

const raizProc = (scratch) => path.join(scratch, 'proc');

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
function plantarAgenteFalso(scratch, pid, { comm = 'claude', argv = ['/usr/bin/claude'], starttime }) {
  const dir = path.join(raizProc(scratch), String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = `(${comm})`;
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);
  campos[5] = String(pid);
  campos[6] = '34816';
  campos[7] = String(pid);
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime, status }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive',
    sessionId: sessaoId,
    cwd,
    status,
    updatedAt: Date.now(),
    pid,
    procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

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

// ─── O roteiro do navegador — roda DENTRO do container ───────────────────────
//
// Os dois PNGs saem ANTES de qualquer veredito, de propósito: no MODO=antes o percurso
// reprova por desenho, e é justamente o print dele que serve de "antes".

const ROTEIRO = `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const pagina = await navegador.newPage();
  const erros = [];
  const requisicoes = [];
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
  pagina.on('response', (r) => { if (r.status() >= 400 && r.status() !== 409) requisicoes.push(r.status() + ' ' + r.url()); });

  const problemas = [];
  const medidas = {};

  const abrirLinha = (titulo) => pagina.evaluate((alvoTexto) => {
    const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
    const alvo = linhas.find((l) => {
      const t2 = l.querySelector('.conversa-titulo');
      return t2 && t2.textContent.includes(alvoTexto);
    });
    const botao = alvo && alvo.querySelector('.conversa');
    if (botao) botao.click();
    return Boolean(botao);
  }, titulo);

  try {
    await pagina.setViewport({ width: ${LARGURA}, height: ${ALTURA} });
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(600);

    // 1. A aba de sempre — a que NÃO pode mudar.
    if (!await abrirLinha('conversa-velha')) problemas.push('não achei "conversa-velha" na lista');
    await espera(900);
    medidas.velha = await pagina.evaluate(() => {
      const painel = document.querySelector('#paineis .painel');
      const pergunta = painel && painel.querySelector('.pergunta');
      return {
        temFita: Boolean(painel && painel.querySelector('.fita') && painel.querySelector('.fita').textContent.trim()),
        blocoAberto: Boolean(pergunta && !pergunta.hidden),
        enviarTravado: document.querySelector('.painel .btn-enviar').disabled,
      };
    });
    await pagina.screenshot({ path: '/out/pre-sessao-aba-com-conversa.png' }).catch(() => {});

    // 2. A aba parada no prompt de confiança.
    if (!await abrirLinha('projeto-novo')) problemas.push('não achei "projeto-novo" na lista');
    await espera(1500);
    medidas.nova = await pagina.evaluate(() => {
      const painel = document.querySelector('#paineis .painel');
      const pergunta = painel && painel.querySelector('.pergunta');
      const tela = painel && painel.querySelector('.pergunta-tela');
      const rotulo = painel && painel.querySelector('.parar-rotulo');
      const pino = document.querySelector('#abas .conversa-linha[data-perguntando="1"] .conversa-pino');
      return {
        blocoAberto: Boolean(pergunta && !pergunta.hidden),
        textoDaPane: tela ? tela.textContent.slice(0, 400) : null,
        rotuloDoParar: rotulo ? rotulo.textContent : null,
        enviarTravado: document.querySelector('.painel .btn-enviar').disabled,
        pinoNaLista: pino ? pino.textContent.trim() : null,
        fitaVazia: Boolean(painel && painel.querySelector('.fita') && !painel.querySelector('.fita').textContent.trim()),
      };
    });
    await pagina.screenshot({ path: '/out/pre-sessao-projeto-novo.png' }).catch(() => {});

    // 3. O veredito. No MODO=antes o esperado é o defeito: bloco fechado e fita muda.
    const esperado = process.env.MODO === 'antes' ? false : true;
    if (medidas.nova.blocoAberto !== esperado) {
      problemas.push('o bloco da pane deveria estar ' + (esperado ? 'ABERTO' : 'FECHADO')
        + ' no projeto novo, e está ' + (medidas.nova.blocoAberto ? 'aberto' : 'fechado'));
    }
    if (esperado) {
      // A OPÇÃO, não a pergunta: é a linha que o usuário precisa enxergar para saber em que
      // seta apertar, e ela é curta o bastante para nenhuma largura de pane a partir.
      if (!medidas.nova.textoDaPane || !medidas.nova.textoDaPane.includes('Yes, I trust this folder')) {
        problemas.push('a tela da pane não traz as opções do prompt de confiança: ' + JSON.stringify(medidas.nova.textoDaPane));
      }
      if (medidas.nova.rotuloDoParar !== 'Fechar o agente') {
        problemas.push('o Parar deveria dizer "Fechar o agente" (ali o Esc MATA o agente), diz: '
          + JSON.stringify(medidas.nova.rotuloDoParar));
      }
      if (medidas.nova.enviarTravado !== true) {
        problemas.push('o Enviar tem que travar: cada letra vira tecla do menu de confiança');
      }
      if (medidas.nova.pinoNaLista !== '?') {
        problemas.push('a lista deveria marcar a aba com "?" — ela está parada por causa do usuário: '
          + JSON.stringify(medidas.nova.pinoNaLista));
      }
    }
    // A aba com conversa não muda em nenhum dos modos — é o lado "não estraguei nada".
    if (!medidas.velha.temFita) problemas.push('a aba com conversa perdeu a fita');
    if (medidas.velha.blocoAberto) problemas.push('a aba com conversa abriu bloco de pane — a D4/D6 caiu');
    if (medidas.velha.enviarTravado) problemas.push('a aba com conversa travou o Enviar sem motivo');

    const geral = await pagina.evaluate(() => ({
      folhasComRegras: Array.from(document.styleSheets).filter((f) => {
        try { return f.cssRules && f.cssRules.length > 0; } catch { return true; }
      }).length,
      imagensQuebradas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
    }));
    if (!geral.folhasComRegras) problemas.push('NENHUMA folha de estilo com regras');
    if (geral.imagensQuebradas) problemas.push(geral.imagensQuebradas + ' imagem(ns) quebrada(s)');
  } catch (e) {
    problemas.push('o roteiro estourou: ' + String(e && e.message).slice(0, 300));
  }

  if (erros.length) problemas.push(erros.length + ' erro(s) de console: ' + erros.slice(0, 3).join(' | '));
  if (requisicoes.length) problemas.push(requisicoes.length + ' requisição(ões) >=400: ' + requisicoes.slice(0, 3).join(' | '));

  await navegador.close();
  console.log('@@MEDIDAS-PRE-SESSAO@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let s3 = null;
  let scratch = null;

  function limpar() {
    let falhouLimpeza = false;
    if (s3 && s3.exitCode === null) {
      try { process.kill(s3.pid); } catch { /* já morreu */ }
      console.log(`  · S3 (pid ${s3.pid}) derrubado pelo pid exato`);
    }
    // D35: o carimbo prova que EU criei aquilo, a enumeração prova que não sobrou ninguém.
    // São perguntas diferentes e matar exige as duas.
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

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      limpar();
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O smoke recusa sobrescrever.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-pre-sessao-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // `-x 200`: a pane nasce com 80 colunas e o `capture-pane` devolve o texto JÁ QUEBRADO na
    // largura dela — "Do you trust this folder?" saía partido no meio. Não é detalhe de
    // teste: é o que a tela do celular vai mostrar, e a pane real do usuário tem 168-211
    // colunas (o comentário de `pintarTelaDaPane`). Fixture estreita mediria outro mundo.
    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-x', '200', '-y', '50', '-s', SESSAO, '-n', 'conversa-velha', '-c', os.tmpdir(), 'sleep', '600']);
    // A pane do projeto novo carrega o prompt de confiança impresso de verdade — é dela que o
    // `capture-pane` do módulo vai ler. `printf %b` (não `%s`) porque o `\n` viaja DENTRO do
    // argumento: com `%s` ele chega literal e a tela vira uma linha só com "\n" escrito.
    t(['new-window', '-d', '-t', `${SESSAO}:`, '-n', 'projeto-novo', '-c', os.tmpdir(),
      'sh', '-c', `printf '%b\\n' ${JSON.stringify(PROMPT)}; sleep 600`]);

    const panes = {};
    for (const linha of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }

    // A aba COMPLETA: /proc + sessions/<pid>.json + .jsonl. É o estado de sempre.
    const velha = panes['conversa-velha'];
    if (!velha) throw new Error('a pane "conversa-velha" não apareceu no list-panes');
    const cwdVelha = '/home/smoke/projetos/conversa-velha';
    escreverConversaCurta(caminhoDoJsonl(home, cwdVelha, 'sess-velha'), 'conversa-velha');
    plantarAgenteFalso(scratch, velha.panePid, { starttime: 3000001 });
    escreverSessao(home, {
      pid: velha.panePid, janela: velha.janelaId, pane: velha.paneId,
      sessaoId: 'sess-velha', cwd: cwdVelha, starttime: 3000001, status: 'idle',
    });

    // A aba em PRÉ-SESSÃO: só o /proc. Nem `sessions/<pid>.json`, nem `.jsonl` — que é
    // exatamente o que o CLI publica (nada) enquanto o prompt de confiança está na tela.
    const nova = panes['projeto-novo'];
    if (!nova) throw new Error('a pane "projeto-novo" não apareceu no list-panes');
    plantarAgenteFalso(scratch, nova.panePid, { starttime: 3000002 });
    console.log('  · fixture pronta: conversa-velha (completa) + projeto-novo (agente vivo, zero sessão)');

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
      COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
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
    console.log(`  · S3 no ar em http://127.0.0.1:${PORTA} (pid ${s3.pid}), socket ${SOCKET}, modo ${MODO}`);

    fs.writeFileSync(path.join(scratch, 'pane.js'), ROTEIRO);

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `MODO=${MODO}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));
    console.log(saidaDocker);

    let relatorio = null;
    const MARCADOR = '@@MEDIDAS-PRE-SESSAO@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }

    const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : (MODO === 'antes'
        ? 'o comportamento VELHO foi reproduzido: fita muda no projeto novo'
        : 'o projeto novo mostra a tela da pane com o prompt, trava o Enviar e diz "Fechar o agente"'));

    for (const nome of ['pre-sessao-aba-com-conversa.png', 'pre-sessao-projeto-novo.png']) {
      const arquivo = path.join(SAIDA, nome);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ SMOKE DO PRÉ-SESSÃO VERMELHO' : '✅ SMOKE DO PRÉ-SESSÃO VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · modo ${MODO} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
