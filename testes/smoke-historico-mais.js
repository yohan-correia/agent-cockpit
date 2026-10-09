#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — o chip `início` virando botão (card `carregar-mais-historico`, Fase 4
// do plano de 2026-09-16).
//
// Prova ANTES/DEPOIS do CLIQUE, na mesma página e na mesma sessão do navegador: o histórico
// antigo aparece, a marca sobe junto, e — o critério que mais importa — a LINHA QUE ESTAVA
// SENDO LIDA continua no mesmo lugar da tela. Um `overflow-anchor` esquecido aparece aqui
// como salto de um lote inteiro, e não aparece em lugar nenhum do `gate-ui.js` (o DOM falso
// não faz layout; armadilha #52).
//
// Molde: `testes/smoke-celular-primeira-leva.js` — mesmo tmux carimbado em socket próprio,
// mesmo /proc de mentira, mesmo HOME fabricado, mesmo container. O que muda: UMA aba só, a
// fixture é bem maior (400 mensagens, para sobrar lote depois do primeiro clique), e o
// percurso CLICA em vez de só fotografar.
//
// A fixture é SINTÉTICA de propósito: os PNGs deste smoke vão para o card e para a URL do
// tailnet, e a conversa que motivou o card é conversa real do dono. Sintética resolve
// privacidade e reprodutibilidade de uma vez — a prova de que o problema existe já foi dada
// com número na spec (§1, 804 arquivos medidos), não depende deste print.
//
// Uso: SAIDA=<pasta NOVA, sem PNG dentro> [VIEWPORT=LxA] node testes/smoke-historico-mais.js
//   VIEWPORT padrão = 390x844 (celular, a regra de 25/08). Use 1600x1000 para o note.
//
// Códigos de saída: 0 = passou · 1 = falha de produto/assert · 2 = erro de USO ou de
// AMBIENTE (falta SAIDA, pasta já tem PNG, imagem docker ausente, servidor não subiu).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

// ─── Contrato de uso — validado ANTES de tocar em qualquer coisa ─────────────

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs e o medidas.json vão cair>');
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
// Nunca 7899 (#24 — porta dos gates dos jobs do orquestrador) nem 7879 (produção).
const PORTA = Number(process.env.PORT || 7893);
if (PORTA < 7891 || PORTA > 7898) {
  console.error(`🔴 porta ${PORTA} fora da faixa 7891-7898.`);
  process.exit(2);
}
const [VP_L, VP_A] = String(process.env.VIEWPORT || '390x844').split('x').map(Number);
if (!Number.isFinite(VP_L) || !Number.isFinite(VP_A)) {
  console.error('🔴 VIEWPORT precisa ser LxA (ex.: 390x844)');
  process.exit(2);
}
const EH_CELULAR = VP_L <= 760;
const PNGS = ['01-antes-do-clique', '02-depois-do-clique', '03-depois-de-tudo'];

// ─── Fail-closed do socket, mesmo padrão do molde ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(2);
}
const SOCKET = `cockpit-smoke-historico-${process.pid}`;
const SESSAO = 'main';
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

// ─── A aba da fixture ────────────────────────────────────────────────────────

const CWD_PROJETO = '/home/smoke/projetos/conversa-longa';
const SESSID = 'sess-conversa-longa';

function raizProc(scratch) {
  return path.join(scratch, 'proc');
}

/** `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
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
const linhaAssistente = (iso, texto, extraMessage = {}) => `${JSON.stringify({
  type: 'assistant',
  timestamp: iso,
  message: { content: [{ type: 'text', text: texto }], ...extraMessage },
})}\n`;

/**
 * 400 mensagens numeradas, ~300 bytes cada (~120 KB) — bem acima do `BLOCO` de 64 KB, e
 * 5× o `ALVO_MENSAGENS` de 80. Isso garante `cortado: true` na abertura E lote sobrando
 * depois do primeiro clique (senão o percurso provaria o "fim da conversa", não o "carregar
 * mais").
 *
 * O NÚMERO no começo de cada mensagem é o que torna o PNG legível como prova: a de número
 * baixo só pode aparecer depois do clique. Print que não deixa isso óbvio não é prova.
 */
function conversaLonga(caminho) {
  const linhas = [];
  const base = Date.now() - 8 * 3600000;
  const enchimento = 'texto de enchimento para a conversa passar dos 64 KB de um bloco de leitura '.repeat(3);
  for (let i = 0; i < 400; i += 1) {
    const iso = new Date(base + i * 60000).toISOString();
    const texto = `mensagem número ${i} — ${enchimento}`.slice(0, 300);
    if (i % 2 === 0) linhas.push(linhaHumano(iso, texto));
    else linhas.push(linhaAssistente(iso, texto));
  }
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhas.join(''));
  return base + 399 * 60000;
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

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const VP = { width: ${VP_L}, height: ${VP_A}, isMobile: ${EH_CELULAR}, hasTouch: ${EH_CELULAR}, deviceScaleFactor: 2 };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // \`--lang=pt-BR\` não é enfeite: o container nasce em inglês, o cliente escolhe o idioma por
  // \`navigator.language\` (public/i18n.js), e o PNG sairia em inglês — que NÃO é a tela que o
  // dono vê. Print tem que ser fiel ao aparelho que motivou a mudança.
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=pt-BR', '--accept-lang=pt-BR'],
  });
  const medidas = {};
  const problemas = [];
  const erros = [];
  const requisicoes = [];

  const pagina = await navegador.newPage();
  await pagina.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0, 200)); });
  pagina.on('pageerror', (e) => erros.push('PAGEERROR: ' + String(e).slice(0, 200)));
  pagina.on('response', (r) => { if (r.status() >= 400) requisicoes.push(r.status() + ' ' + r.url()); });

  /** O estado da fita que interessa: quantas bolhas, qual a primeira, e o que a marca diz. */
  const lerFita = () => pagina.evaluate(() => {
    const fita = document.querySelector('.painel .fita');
    const mensagens = document.querySelector('.painel .mensagens');
    const bolhas = Array.from(fita ? fita.querySelectorAll('.bolha-eu, .fala') : []);
    const numeros = bolhas
      .map((b) => (String(b.textContent).match(/mensagem número (\\d+)/) || [])[1])
      .filter((n) => n !== undefined)
      .map(Number);
    const marca = fita ? fita.querySelector('.corte-inicio') : null;
    const botao = marca ? marca.querySelector('.corte-mais') : null;
    const nota = marca ? marca.querySelector('.corte-nota') : null;
    const filhos = fita ? Array.from(fita.children) : [];
    return {
      bolhas: bolhas.length,
      menorNumero: numeros.length ? Math.min(...numeros) : null,
      maiorNumero: numeros.length ? Math.max(...numeros) : null,
      temMarca: Boolean(marca),
      // A marca tem que ser o PRIMEIRO filho da fita: o lote novo entra ABAIXO dela.
      marcaEhPrimeira: Boolean(marca) && filhos.indexOf(marca) === 0,
      temBotao: Boolean(botao),
      rotuloBotao: botao ? String(botao.textContent).trim() : null,
      botaoDesabilitado: botao ? Boolean(botao.disabled) : null,
      nota: nota ? String(nota.textContent).trim() : null,
      scrollTop: mensagens ? mensagens.scrollTop : null,
      scrollHeight: mensagens ? mensagens.scrollHeight : null,
    };
  });

  /** Onde, na TELA, está a bolha de um número — a régua da âncora de rolagem. */
  const topoNaTela = (numero) => pagina.evaluate((n) => {
    const alvo = Array.from(document.querySelectorAll('.painel .fita .bolha-eu, .painel .fita .fala'))
      .find((b) => String(b.textContent).includes('mensagem número ' + n + ' '));
    return alvo ? Math.round(alvo.getBoundingClientRect().top) : null;
  }, numero);

  const foto = async (nome) => {
    await pagina.screenshot({ path: '/out/' + nome + '.png', fullPage: false });
  };

  try {
    await pagina.setViewport(VP);
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(600);

    // ── abre a conversa ────────────────────────────────────────────────────
    const clicou = await pagina.evaluate(() => {
      const linha = document.querySelector('#abas .conversa-linha .conversa')
        || document.querySelector('#abas .conversa')
        || document.querySelector('#abas button');
      if (linha) linha.click();
      return Boolean(linha);
    });
    if (!clicou) {
      // Diagnóstico: sem isto o smoke só diz "não achei" e o próximo a rodar refaz a
      // investigação do zero. O HTML da lista responde na hora se é seletor errado ou se a
      // aba nem chegou da API.
      const dump = await pagina.evaluate(() => {
        const abas = document.querySelector('#abas');
        return { html: abas ? abas.innerHTML.slice(0, 1200) : '(sem #abas)' };
      });
      problemas.push('não achei a conversa na lista · #abas = ' + dump.html);
      throw new Error('sem conversa');
    }
    await pagina.waitForSelector('.painel .chat-topo:not([hidden])', { timeout: 10000 }).catch(() => {});
    await espera(2000);

    // Sobe até o topo. A conversa abre grudada no fim e o \`sincronizado\` pode chegar
    // DEPOIS — quando chega, \`despejarFita()\` rola de volta. Reforça até vencer.
    for (let i = 0; i < 10; i += 1) {
      await pagina.evaluate(() => { document.querySelector('.painel .mensagens').scrollTop = 0; });
      await espera(200);
    }

    medidas.antes = await lerFita();
    if (!medidas.antes.temMarca) { problemas.push('a fixture não disparou o corte — sem .corte-inicio na fita'); }
    if (!medidas.antes.temBotao) { problemas.push('a marca não tem o botão .corte-mais — o chip continua texto morto'); }
    await foto('01-antes-do-clique');

    // ── a âncora: onde está a mensagem mais antiga da tela ANTES do clique ──
    // Ela é o que o usuário está lendo. Depois do lote entrar POR CIMA, ela tem que
    // continuar no MESMO lugar da tela — é o critério que só o navegador prova.
    const alvoAncora = medidas.antes.menorNumero;
    medidas.ancoraAntes = await topoNaTela(alvoAncora);
    medidas.ancoraNumero = alvoAncora;

    // ── clica ───────────────────────────────────────────────────────────────
    const clicouBotao = await pagina.evaluate(() => {
      const b = document.querySelector('.painel .fita .corte-inicio .corte-mais');
      if (b) b.click();
      return Boolean(b);
    });
    if (!clicouBotao) { problemas.push('o botão .corte-mais sumiu antes do clique'); }
    await espera(2500);

    medidas.depois = await lerFita();
    medidas.ancoraDepois = await topoNaTela(alvoAncora);
    await foto('02-depois-do-clique');

    // ── clica até o fim (5 lotes cobrem as 400 mensagens com folga) ─────────
    let cliques = 1;
    for (let i = 0; i < 8; i += 1) {
      const aindaTem = await pagina.evaluate(() => {
        const b = document.querySelector('.painel .fita .corte-inicio .corte-mais');
        if (b && !b.disabled && !b.hidden) { b.click(); return true; }
        return false;
      });
      if (!aindaTem) break;
      cliques += 1;
      await espera(2000);
    }
    medidas.cliques = cliques;
    medidas.fim = await lerFita();
    // Um \`scrollTop = 0\` só NÃO basta: com ~800 bolhas na fita, o layout ainda está
    // assentando e o \`sincronizado\` tardio do SSE rola de volta. Sem reforçar, este PNG sai
    // no meio da conversa e não prova o que deveria — o COMEÇO dela. (Medido: a primeira
    // versão deste smoke fotografou a mensagem #90.)
    for (let i = 0; i < 10; i += 1) {
      await pagina.evaluate(() => { document.querySelector('.painel .mensagens').scrollTop = 0; });
      await espera(250);
    }
    medidas.scrollTopFinal = await pagina.evaluate(() => document.querySelector('.painel .mensagens').scrollTop);
    if (medidas.scrollTopFinal > 4) {
      problemas.push('não consegui levar a fita ao topo para o PNG do fim (scrollTop=' + medidas.scrollTopFinal + ')');
    }
    await foto('03-depois-de-tudo');

    const geral = await pagina.evaluate(() => {
      const folhas = Array.from(document.styleSheets).filter((f) => {
        try { return f.cssRules && f.cssRules.length > 0; } catch { return true; }
      }).length;
      return {
        folhasComRegras: folhas,
        imagensQuebradas: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
      };
    });
    if (!geral.folhasComRegras) problemas.push('NENHUMA folha de estilo com regras');
    if (geral.imagensQuebradas) problemas.push(geral.imagensQuebradas + ' imagem(ns) quebrada(s)');
    if (erros.length) problemas.push('console: ' + erros.join(' | '));
    if (requisicoes.length) problemas.push('requisições >= 400: ' + requisicoes.join(' | '));
  } catch (e) {
    problemas.push('o roteiro estourou: ' + String(e && e.message).slice(0, 200));
  } finally {
    await navegador.close().catch(() => {});
  }

  console.log('@@MEDIDAS-HISTORICO@@' + JSON.stringify({ medidas, problemas }));
  process.exit(0);
})();
`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  let s3 = null;
  let scratch = null;
  let saida = 0;

  function limpar() {
    let falhouLimpeza = false;
    if (s3 && s3.exitCode === null) {
      try { process.kill(s3.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${s3.pid}) derrubado pelo pid exato`);
    }
    // Fail-closed: se a janela-âncora sumiu, isto é FALHA — não aviso. Sem isso um smoke que
    // perdeu a posse do socket sairia 0 deixando servidor tmux vivo (a #24 por outro caminho).
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    if (temCarimbo) {
      t(['kill-server'], { tolerante: true });
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
      limpar();
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-historico-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // ── 1) a pane, num socket próprio ───────────────────────────────────────
    // O carimbo mora numa SESSÃO PRÓPRIA: `lib/abas.js` filtra por `COCKPIT_TMUX_SESSAO`, e
    // uma âncora dentro dela apareceria como uma segunda aba na lista.
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'conversa-longa', '-c', os.tmpdir(), 'sleep', '600']);

    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    if (!panes['conversa-longa']) throw new Error('a pane "conversa-longa" não apareceu no list-panes');

    // ── 2) /proc falso + sessions/<pid>.json, com os números REAIS ──────────
    const caminho = caminhoDoJsonl(home, CWD_PROJETO, SESSID);
    conversaLonga(caminho);
    const bytes = fs.statSync(caminho).size;
    console.log(`  · fixture: ${(bytes / 1024).toFixed(0)} KB, 400 mensagens numeradas`);

    plantarAgenteFalso(scratch, panes['conversa-longa'].panePid, { starttime: 1000001 });
    escreverSessao(home, {
      pid: panes['conversa-longa'].panePid,
      janela: panes['conversa-longa'].janelaId,
      pane: panes['conversa-longa'].paneId,
      sessaoId: SESSID, cwd: CWD_PROJETO, starttime: 1000001, status: 'idle',
    });

    // ── 3) sobe o servidor apontando para o mundo de mentira ────────────────
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
      COCKPIT_VIGIA_MS: '0',
      // `COCKPIT_LIDAS_DIR` VENCE o `HOME` falso (lib/lidas.js, armadilha #62): sem esta
      // linha, uma var esquecida no shell mandaria a escrita para o ~/.cockpit de PRODUÇÃO.
      COCKPIT_LIDAS_DIR: path.join(home, '.cockpit'),
      COCKPIT_PUSH_DIR: path.join(home, '.cockpit', 'push'),
      // Pasta de jobs VAZIA e própria. Sem ela o smoke leria a pasta de jobs do orquestrador de verdade — os
      // jobs do dono apareceriam na lista deste percurso e no PNG. O `gate-jobs-disco.js`
      // exige esta linha de todo teste que sobe o `server.js`, e foi ele quem pegou a falta.
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs-vazio'),
    });
    fs.mkdirSync(path.join(scratch, 'jobs-vazio'), { recursive: true });
    s3 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let erroServidor = '';
    s3.stderr.on('data', (d) => { erroServidor += d; });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (s3.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      ok(false, `o servidor (${PORTA}) não subiu: ${erroServidor.slice(0, 400)}`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${s3.pid}), socket ${SOCKET}`);

    // ── 4) o roteiro, dentro do container ───────────────────────────────────
    fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro());
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));

    const MARCADOR = '@@MEDIDAS-HISTORICO@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    let relatorio = null;
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    if (!relatorio) {
      console.log(saidaDocker);
      ok(false, `o roteiro não devolveu JSON (código ${codigo})`);
      limpar();
      return process.exit(1);
    }

    const { medidas, problemas } = relatorio;
    console.log(`\n  medidas: ${JSON.stringify(medidas, null, 2)}\n`);

    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : 'percurso limpo: CSS com regras, console sem erro, nenhuma requisição >= 400');

    for (const nome of PNGS) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    if (problemas.length === 0) {
      const { antes, depois, fim } = medidas;

      // 1. O chip é um CONTROLE, não texto morto.
      ok(antes.temMarca && antes.temBotao, 'antes do clique: a marca `início` tem o botão');
      // Os dois idiomas: o PNG sai em pt-BR (o navegador é forçado), mas o assert não pode
      // depender disso — se alguém rodar num container com outro locale, o que importa é que
      // a nota EXPLICATIVA continua na tela, não em que língua.
      ok(antes.nota && /(não foi carregado|was not loaded)/.test(antes.nota),
        `antes: a nota que EXPLICA continua lá ("${antes.nota}")`);

      // 2. O clique traz histórico que NÃO estava na tela.
      ok(depois.bolhas > antes.bolhas,
        `o lote entrou: ${antes.bolhas} → ${depois.bolhas} bolhas`);
      ok(depois.menorNumero !== null && antes.menorNumero !== null && depois.menorNumero < antes.menorNumero,
        `mensagens MAIS ANTIGAS apareceram: a primeira da tela foi de #${antes.menorNumero} para #${depois.menorNumero}`);
      ok(depois.maiorNumero === antes.maiorNumero,
        `e o fim da conversa não se mexeu (#${antes.maiorNumero})`);

      // 3. A marca SE MOVE para o topo do lote novo — não duplica, não fica no fim.
      ok(depois.marcaEhPrimeira,
        'a marca voltou para o PRIMEIRO lugar da fita — o lote novo entrou abaixo dela');

      // 4. A ÂNCORA DE ROLAGEM — o critério que só o navegador prova.
      const desvio = Math.abs((medidas.ancoraDepois ?? 1e9) - (medidas.ancoraAntes ?? 0));
      ok(medidas.ancoraAntes !== null && medidas.ancoraDepois !== null && desvio <= 4,
        `a linha que estava sendo lida (#${medidas.ancoraNumero}) NÃO saltou: `
        + `${medidas.ancoraAntes}px → ${medidas.ancoraDepois}px (desvio ${desvio}px, teto 4px)`);

      // 5. Clicar até o fim chega ao começo da conversa, em número finito de cliques.
      ok(medidas.cliques >= 2, `deu para clicar mais de uma vez (${medidas.cliques} cliques)`);
      ok(fim.menorNumero === 0, `chegou ao começo da conversa: a mensagem #0 está na tela`);
      ok(fim.temMarca && !fim.temBotao,
        'no fim o botão sai de cena — não há mais o que carregar');
      ok(fim.nota && /(começo da conversa|beginning of the conversation)/.test(fim.nota),
        `e a nota passa a dizer o que é ("${fim.nota}")`);

      fs.writeFileSync(path.join(SAIDA, 'medidas.json'), JSON.stringify(medidas, null, 2));
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ SMOKE DO HISTÓRICO VERMELHO' : '✅ SMOKE DO HISTÓRICO VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · viewport ${VP_L}x${VP_A} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
