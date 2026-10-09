#!/usr/bin/env node
'use strict';
// PRINT DO NOME POR PAINEL (card `nome-por-painel`, D66) — 390×844, antes e depois, no artefato real.
//
// Prova, com o Chromium de verdade e o `server.js` de verdade: numa janela dividida de duas panes
// de agente, o ✎ da pane de BAIXO muda só ela (`ESPERO=diferentes`, o mundo novo) ou muda as duas
// (`ESPERO=iguais`, o mundo velho — armadilha #67). O mesmo script roda nos dois mundos:
// `RAIZ=<git archive da base>` escolhe de onde vem o `server.js` (e, com ele, `lib/` e `public/`).
// Os cruzados (mundo velho + `diferentes`, mundo novo + `iguais`) TÊM de sair 1: é o controle negativo.
// Imprime `GET /api/abas` antes e depois do ✎ e confere no tmux o `window_name` e a `@cockpit-nome`.
//
// Mundo próprio, como o `smoke-navegador-renomear.js`: socket de tmux carimbado (D35, prova dupla
// — âncora + enumeração; o `new-session` leva `-f /dev/null`), HOME falso com
// `.claude/sessions/<pid>.json`, `/proc` falso por `COCKPIT_PROC_RAIZ` com UMA entrada por pane,
// pasta de jobs vazia (A10 do `gate-jobs-disco`), lidas/push/monitor/vigia isolados ou desligados.
// Nomes GENÉRICOS — nenhum nome real de projeto ou de cliente (este arquivo é publicado).
//
// Uso:  SAIDA=/tmp/print-nome [RAIZ=<dir>] [ESPERO=diferentes|iguais] [PORTA=7917] \
//         node testes/print-nome-por-painel.js
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível (imagem docker ausente,
// porta ocupada, SAIDA já com PNG, ESPERO inválido).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = Number(process.env.PORTA || 7917);
const RAIZ = path.resolve(process.env.RAIZ || path.join(__dirname, '..'));
const ESPERO = process.env.ESPERO || 'diferentes';
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const SAIDA = process.env.SAIDA;
const SOCKET = `cockpit-smoke-print-nome-${process.pid}`;
const SESSAO = 'nome';
const CARIMBO = `ancora-nome-${process.pid}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);
const NOVO = 'só a api';
const JANELA_DIVIDIDA = 'site-e-api';
const JANELA_SOLTA = 'notas';

if (!['diferentes', 'iguais'].includes(ESPERO)) {
  console.error(`🟡 ESPERO inválido ("${ESPERO}") — só diferentes | iguais.`);
  process.exit(2);
}
if (!SAIDA) {
  console.error('🟡 SAIDA é obrigatório (pasta dos PNGs).');
  process.exit(2);
}

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em todo comando: só pesa no que inicia o servidor, e sem ele o ~/.tmux.conf do
// dono roda o continuum-restore no socket de teste.
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

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** `ss` pode faltar: incerteza conta como ocupada (o defeito de 05/09 do `smoke-abas-tmux`). */
function quemEscuta(porta) {
  try {
    const linha = execFileSync('ss', ['-H', '-lptn', `sport = :${porta}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').map((l) => l.trim()).filter(Boolean)[0];
    return linha || null;
  } catch {
    return 'não deu para consultar o ss — porta indeterminada';
  }
}

// ─── A fixture: /proc, sessions e conversa, todos de mentira (molde: smoke-navegador-renomear) ───

const raizProc = (scratch) => path.join(scratch, 'proc');

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
function plantarAgenteFalso(scratch, pid, starttime) {
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

function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive',
    sessionId: sessaoId,
    cwd,
    status: 'idle',
    updatedAt: Date.now(),
    pid,
    procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

const caminhoDoJsonl = (home, cwd, sessaoId) => path.join(home, '.claude', 'projects',
  cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessaoId}.jsonl`);

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
})}\n`;

/** Uma troca curta, em pt-BR, só para a lista não nascer muda — texto genérico, sem nome real. */
function conversaCurta(caminho, pergunta, resposta) {
  const base = Date.now() - 90 * 60000;
  const em = (min) => new Date(base + min * 60000).toISOString();
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhaHumano(em(0), pergunta) + linhaAssistente(em(1), resposta));
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

function getAbas() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORTA, path: '/api/abas', timeout: 5000 }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(corpo)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const listaDeAbas = (j) => (Array.isArray(j) ? j : (j && j.abas) || []);
function imprimirAbas(rotulo, json) {
  console.log(`  ${rotulo}`);
  for (const a of listaDeAbas(json)) console.log(`    ${a.chave} · ${a.titulo}`);
}

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let scratch = null;

  /**
   * Limpeza FAIL-CLOSED (D35): o carimbo (a janela âncora) prova que EU criei o socket; só a
   * ENUMERAÇÃO prova que não há mais ninguém nele. `kill-server` só com as duas provas.
   */
  function limpar() {
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const intrusas = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean)
      .filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      return process.exit(2);
    }

    const dono = quemEscuta(PORTA);
    if (dono) {
      console.error(`🟡 a porta ${PORTA} já tem dono — ${dono}. Não subo em cima.`);
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'print-nome-por-painel-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });
    // Pasta VAZIA e obrigatória (A10 do `gate-jobs-disco.js`): sem ela o cockpit leria a pasta de
    // jobs de verdade, e a faixa de jobs entraria nos PNGs.
    fs.mkdirSync(path.join(scratch, 'jobs'), { recursive: true });

    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', JANELA_DIVIDIDA, '-c', os.tmpdir(), 'sleep', '600']);
    t(['split-window', '-d', '-t', `${SESSAO}:${JANELA_DIVIDIDA}`, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-window', '-d', '-t', SESSAO, '-n', JANELA_SOLTA, '-c', os.tmpdir(), 'sleep', '600']);

    // Por `pane_id`, não por `window_name`: as duas panes da janela dividida têm o mesmo nome. O `-s`
    // lista TODAS as janelas da sessão; sem ele só sai a janela atual.
    const panes = t(['list-panes', '-s', '-t', `${SESSAO}:`, '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}'])
      .split('\n').filter((l) => l.trim()).map((l) => {
        const [nome, janelaId, paneId, panePid] = l.split('\t');
        return { nome, janelaId, paneId, panePid: Number(panePid) };
      });
    const dividida = panes.filter((p) => p.nome === JANELA_DIVIDIDA);
    const soltas = panes.filter((p) => p.nome === JANELA_SOLTA);
    if (panes.length !== 3 || dividida.length !== 2 || soltas.length !== 1) {
      console.error(`🔴 a fixture esperava 3 panes (2 em ${JANELA_DIVIDIDA}, 1 em ${JANELA_SOLTA}) e veio ${JSON.stringify(panes)}`);
      limpar();
      return process.exit(1);
    }
    const [cima, baixo] = dividida;

    let starttime = 3000001;
    panes.forEach((pane, i) => {
      const cwd = `/home/exemplo/projetos/${pane.nome}-${i}`;
      const sessaoId = `sess-nome-${i}`;
      plantarAgenteFalso(scratch, pane.panePid, starttime);
      escreverSessao(home, { pid: pane.panePid, janela: pane.janelaId, pane: pane.paneId, sessaoId, cwd, starttime });
      conversaCurta(caminhoDoJsonl(home, cwd, sessaoId), 'como está o build?', 'Verde. Nada pendente.');
      starttime += 1;
    });
    console.log(`  · fixture pronta: ${JANELA_DIVIDIDA} (2 panes) + ${JANELA_SOLTA} · ESPERO=${ESPERO} · RAIZ=${RAIZ}`);

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
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'),
    });
    servidor = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
      cwd: RAIZ, env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      console.error(`🔴 o servidor (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid}), socket ${SOCKET}`);

    const antes = await getAbas();
    imprimirAbas('GET /api/abas — ANTES DO ✎', antes);
    const chaveDe = (pane) => (listaDeAbas(antes).find((a) => a.chave === `aba-p${pane.paneId.slice(1)}`) || {}).chave;
    const chaveBaixo = chaveDe(baixo);
    const chaveCima = chaveDe(cima);
    if (!chaveBaixo || !chaveCima) {
      console.error('🔴 as duas panes da janela dividida não viraram abas aba-p<n> na lista');
      limpar();
      return process.exit(1);
    }

    fs.copyFileSync(path.join(__dirname, 'roteiro-nome-por-painel.js'), path.join(scratch, 'roteiro.js'));

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `CHAVE=${chaveBaixo}`, '-e', `CHAVE_IRMA=${chaveCima}`,
      '-e', `NOVO=${NOVO}`, '-e', `ESPERO=${ESPERO}`,
      '-v', `${scratch}:/w:ro`, '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigoDocker = await new Promise((r) => docker.on('close', r));

    const MARCADOR = '@@NOME-POR-PAINEL@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    let relatorio = null;
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      if (saidaDocker.slice(0, abre).trim()) console.log(saidaDocker.slice(0, abre).trim());
    } else {
      console.log(saidaDocker);
    }
    if (!relatorio) {
      console.error(`  ❌ o roteiro não devolveu JSON (código ${codigoDocker})`);
      limpar();
      return process.exit(1);
    }

    let tudoOk = true;
    for (const p of relatorio.passos) {
      console.log(`  ${p.ok ? '✅' : '❌'} ${p.texto}`);
      if (!p.ok) tudoOk = false;
    }

    const depois = await getAbas();
    imprimirAbas('GET /api/abas — DEPOIS DO ✎', depois);

    // Conferência no tmux, do HOST: o ✎ tem de ter chegado até o tmux de verdade, não só até o DOM.
    const nomeDaJanela = (janelaId) => t(['display-message', '-p', '-t', janelaId, '#{window_name}']).replace(/\n$/, '');
    const opcaoDaPane = (paneId) => t(['display-message', '-p', '-t', paneId, '#{@cockpit-nome}']).replace(/\n$/, '');
    const janelaVista = nomeDaJanela(baixo.janelaId);
    const opcaoBaixo = opcaoDaPane(baixo.paneId);
    const opcaoCima = opcaoDaPane(cima.paneId);
    console.log(`  tmux: window_name="${janelaVista}" · @cockpit-nome baixo="${opcaoBaixo}" cima="${opcaoCima}"`);
    const tituloDepois = (chave) => (listaDeAbas(depois).find((a) => a.chave === chave) || {}).titulo;
    const confere = (cond, texto) => {
      console.log(`  ${cond ? '✅' : '❌'} ${texto}`);
      if (!cond) tudoOk = false;
    };
    if (ESPERO === 'diferentes') {
      confere(tituloDepois(chaveBaixo) === NOVO, `API: título de baixo = "${NOVO}" (${tituloDepois(chaveBaixo)})`);
      confere(tituloDepois(chaveCima) === JANELA_DIVIDIDA, `API: título de cima = "${JANELA_DIVIDIDA}" (${tituloDepois(chaveCima)})`);
      confere(janelaVista === JANELA_DIVIDIDA, `tmux: a janela continua "${JANELA_DIVIDIDA}" (${janelaVista})`);
      confere(opcaoBaixo === NOVO, `tmux: @cockpit-nome de baixo = "${NOVO}" (${opcaoBaixo})`);
      confere(opcaoCima === '', `tmux: @cockpit-nome de cima vazio ("${opcaoCima}")`);
    } else {
      confere(tituloDepois(chaveBaixo) === NOVO && tituloDepois(chaveCima) === NOVO,
        `API: os dois títulos = "${NOVO}" (${tituloDepois(chaveBaixo)} | ${tituloDepois(chaveCima)})`);
      confere(janelaVista === NOVO, `tmux: a janela virou "${NOVO}" (${janelaVista})`);
    }

    for (const nome of relatorio.gerados) console.log(`  ✅ ${path.join(SAIDA, nome)}`);

    limpar();
    console.log(tudoOk ? '✅ PRINT VERDE' : '❌ PRINT VERMELHO');
    return process.exit(tudoOk ? 0 : 1);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
