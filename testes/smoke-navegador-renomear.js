#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — renomear a aba (card `renomear-a-aba`), nos dois aparelhos.
//
// Prova, com o Chromium de verdade (não o DOM de mentira do `gate-ui`): o ✎ aparece do jeito
// certo em cada aparelho (escondido até o hover no desktop, sempre à vista no celular), o
// diálogo abre preenchido, a recusa do nome vazio aparece DENTRO dele, e o rename chega até o
// tmux — a janela muda de nome de verdade, as outras três não.
//
// Mundo próprio, como o `print-vitrine.js`: socket de tmux carimbado (D35, prova dupla — âncora
// + enumeração), HOME falso com `.claude/sessions/<pid>.json`, `/proc` falso por
// `COCKPIT_PROC_RAIZ`, pasta de jobs vazia (A10 do `gate-jobs-disco`), vigia e push desligados.
// Quatro abas de nome GENÉRICO — nenhum nome real de projeto ou de cliente (este arquivo é
// publicado).
//
// O roteiro do navegador mora em `testes/roteiro-renomear.js` (arquivo próprio: crase e `${}`
// de verdade, sem template string por fora — o mesmo motivo do `roteiro-conversa-transicoes.js`).
//
// Armadilha #66: o Chromium headless responde `hover: none` até no desktop 1600×1000. O roteiro
// emula o aparelho com mouse reescrevendo, pelo CSSOM, as condições de mídia da folha do app.
//
// Uso:  SAIDA=/tmp/smoke-renomear node testes/smoke-navegador-renomear.js
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível (imagem docker ausente,
// porta ocupada, SAIDA já com PNG).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7892;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const SAIDA = process.env.SAIDA || '/tmp/smoke-renomear';
const SOCKET = `cockpit-smoke-renomear-${process.pid}`;
const SESSAO = 'renomear';
const CARIMBO = `ancora-renomear-${process.pid}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);
const ABAS = [
  { nome: 'meu-site', cwd: '/home/exemplo/projetos/meu-site', sessaoId: 'sess-meu-site' },
  { nome: 'api-pedidos', cwd: '/home/exemplo/projetos/api-pedidos', sessaoId: 'sess-api-pedidos' },
  { nome: 'loja-mobile', cwd: '/home/exemplo/projetos/loja-mobile', sessaoId: 'sess-loja-mobile' },
  { nome: 'notas', cwd: '/home/exemplo/projetos/notas', sessaoId: 'sess-notas' },
];
// O celular renomeia `api-pedidos` para um nome LONGO (quebra de linha no aparelho estreito); o
// desktop faz o hover NESSA linha (nome longo + ✎ + ⧉ juntos) e a renomeia de novo. No fim, a
// janela de `api-pedidos` tem o NOME_FINAL e as outras três continuam intactas.
const NOME_LONGO = 'pedidos v2 — um nome comprido para ver a quebra de linha';
const NOME_FINAL = 'pedidos v3';

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

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

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `ss` pode faltar ou recusar — devolver "livre" sem ter olhado seria o defeito de 05/09 do
 * `smoke-abas-tmux` (subir em cima de um intruso e o `/health` responder por ele). Incerteza
 * conta como ocupada.
 */
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

// ─── A fixture: /proc, sessions e conversa, todos de mentira (molde: print-vitrine.js) ───────

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

function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto, extra = {}) => `${JSON.stringify({
  type: 'assistant',
  timestamp: iso,
  message: { content: [{ type: 'text', text: texto }], ...extra },
})}\n`;

/** Uma troca curta, em pt-BR, só para a lista não nascer muda — texto genérico, sem nome real. */
function conversaCurta(caminho, pergunta, resposta) {
  const base = Date.now() - 90 * 60000;
  const em = (min) => new Date(base + min * 60000).toISOString();
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhaHumano(em(0), pergunta) + linhaAssistente(em(1), resposta));
}

function escreverConversas(home) {
  for (const aba of ABAS) {
    const jsonl = caminhoDoJsonl(home, aba.cwd, aba.sessaoId);
    conversaCurta(jsonl, 'como está o build?', 'Verde. Nada pendente.');
  }
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

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let scratch = null;

  /**
   * Limpeza FAIL-CLOSED (D35, molde do `print-vitrine.js`): o carimbo (a janela âncora) prova
   * que EU criei o socket; só a ENUMERAÇÃO prova que não há mais ninguém nele. `kill-server` só
   * com as duas provas.
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
      // Não sobe em cima: o /health responderia pelo intruso (o defeito de 05/09 do
      // `smoke-abas-tmux`). Não mata nada — pode ser um job irmão.
      console.error(`🟡 a porta ${PORTA} já tem dono — ${dono}. Não subo em cima.`);
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-renomear-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });
    // Pasta VAZIA e obrigatória (A10 do `gate-jobs-disco.js`): sem ela o cockpit leria a pasta de
    // jobs de verdade, e a faixa de jobs (títulos de projeto privado) entraria nos PNGs.
    fs.mkdirSync(path.join(scratch, 'jobs'), { recursive: true });

    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', ABAS[0].nome, '-c', os.tmpdir(), 'sleep', '600']);
    for (const aba of ABAS.slice(1)) {
      t(['new-window', '-d', '-t', SESSAO, '-n', aba.nome, '-c', os.tmpdir(), 'sleep', '600']);
    }

    const panes = {};
    for (const linha of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }

    let starttime = 3000001;
    for (const aba of ABAS) {
      const pane = panes[aba.nome];
      if (!pane) throw new Error(`a pane "${aba.nome}" não apareceu no list-panes`);
      plantarAgenteFalso(scratch, pane.panePid, starttime);
      escreverSessao(home, {
        pid: pane.panePid, janela: pane.janelaId, pane: pane.paneId,
        sessaoId: aba.sessaoId, cwd: aba.cwd, starttime,
      });
      starttime += 1;
    }
    escreverConversas(home);
    console.log(`  · fixture pronta: ${ABAS.map((a) => a.nome).join(', ')}`);

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
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'),
    });
    servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
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

    fs.copyFileSync(path.join(__dirname, 'roteiro-renomear.js'), path.join(scratch, 'roteiro.js'));

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', 'CELULAR_DE=api-pedidos', '-e', `CELULAR_PARA=${NOME_LONGO}`,
      '-e', `DESKTOP_DE=${NOME_LONGO}`, '-e', `DESKTOP_PARA=${NOME_FINAL}`,
      '-v', `${scratch}:/w:ro`, '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigoDocker = await new Promise((r) => docker.on('close', r));

    const MARCADOR = '@@RENOMEAR@@';
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

    // Conferência no tmux, do HOST, depois do container: o rename tem de ter chegado até o tmux
    // de verdade, não só até o DOM.
    const nomeDaJanela = (janelaId) => t(['display-message', '-p', '-t', janelaId, '#{window_name}'])
      .replace(/\n$/, '');
    const confAbaFinal = nomeDaJanela(panes['api-pedidos'].janelaId) === NOME_FINAL;
    console.log(`  ${confAbaFinal ? '✅' : '❌'} tmux: a janela de api-pedidos está com "${NOME_FINAL}" (${nomeDaJanela(panes['api-pedidos'].janelaId)})`);
    if (!confAbaFinal) tudoOk = false;
    for (const aba of ABAS.filter((a) => a.nome !== 'api-pedidos')) {
      const intacta = nomeDaJanela(panes[aba.nome].janelaId) === aba.nome;
      console.log(`  ${intacta ? '✅' : '❌'} tmux: a janela de ${aba.nome} continua intacta (${nomeDaJanela(panes[aba.nome].janelaId)})`);
      if (!intacta) tudoOk = false;
    }

    for (const nome of relatorio.gerados) console.log(`  ✅ ${path.join(SAIDA, nome)}`);

    limpar();
    console.log(tudoOk ? '✅ SMOKE VERDE' : `❌ SMOKE VERMELHO`);
    return process.exit(tudoOk ? 0 : 1);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
