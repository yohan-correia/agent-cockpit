#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — a lista de aparelhos com nome editável (card `nome-do-aparelho-no-push`),
// nos dois aparelhos.
//
// Prova, com o Chromium de verdade (não o DOM de mentira do `gate-ui`), o que assert nenhum pega:
// o user agent cru de 80 caracteres TRUNCADO sem vazar da caixa (R4 — foi exatamente assim que o
// nome do painel de jobs saiu quebrado com 1236 asserts verdes), o campo da edição inteiro dentro
// da tela em 390 px, e a frase do botão "testar" cabendo no botão — o `TETO_FRASE` é estimativa,
// e é este print que o julga.
//
// Mundo próprio, como o `smoke-navegador-renomear.js`: socket de tmux carimbado (D35, prova dupla
// — âncora + enumeração), HOME falso, `/proc` falso, pasta de jobs vazia (A10 do
// `gate-jobs-disco`), vigia desligado e uma pasta de push PRÓPRIA, semeada com três inscrições de
// mentira. Nomes genéricos — nenhum aparelho, projeto ou cliente real (este arquivo é publicado).
//
// O roteiro do navegador mora em `testes/roteiro-aparelhos.js` (arquivo próprio: crase e `${}` de
// verdade, sem template string por fora). Sem ele não sai PNG nenhum: quem faz `setViewport` e
// `screenshot` é o roteiro, dentro do container.
//
// Uso:  SAIDA=/tmp/smoke-aparelhos-$(date +%s) node testes/smoke-navegador-aparelhos.js
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível (imagem docker ausente,
// porta ocupada, SAIDA já com PNG).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

// 7879 é produção, 7899 é dos jobs e 7891–7898 estão com os outros smokes deste `testes/`.
// Sobra a 7890. A env é `PORT`, o mesmo nome do molde: ler duas convidaria a colisão calada
// com um job irmão que exportasse a errada.
const PORTA = Number(process.env.PORT) || 7890;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const SAIDA = process.env.SAIDA || '/tmp/smoke-aparelhos';
const SOCKET = `cockpit-smoke-aparelhos-${process.pid}`;
const SESSAO = 'aparelhos';
const CARIMBO = `ancora-aparelhos-${process.pid}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);
const ABAS = [
  { nome: 'meu-site', cwd: '/home/exemplo/projetos/meu-site', sessaoId: 'sess-meu-site' },
  { nome: 'notas', cwd: '/home/exemplo/projetos/notas', sessaoId: 'sess-notas' },
];

// As TRÊS inscrições de mentira (§7.3). A do meio é o caso real de produção: 80 caracteres de
// user agent cru no campo `aparelho`. A última não tem o campo NEM `criadoEm` — é ela que prova,
// no PNG, a legenda "sem nome" e a linha sem data (em vez de um 01/01/1970).
const CHAVES = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const UA_CRU = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/14';
const INSCRICOES = [
  { endpoint: 'https://fcm.example.test/aparelho-um', keys: { ...CHAVES }, aparelho: 'Notebook', criadoEm: '2026-09-01T10:00:00.000Z' },
  { endpoint: 'https://fcm.example.test/aparelho-dois', keys: { ...CHAVES }, aparelho: UA_CRU, criadoEm: '2026-09-02T10:00:00.000Z' },
  { endpoint: 'https://fcm.example.test/aparelho-tres', keys: { ...CHAVES } },
];
const NOME_NOVO = 'Celular da sala';

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
 * `ss` pode faltar ou recusar — devolver "livre" sem ter olhado seria subir em cima de um
 * intruso e o `/health` responder por ele. Incerteza conta como ocupada.
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

// ─── A fixture: /proc, sessions e conversa, todos de mentira ─────────────────

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
const linhaAssistente = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
})}\n`;

/** Uma troca curta, em pt-BR, só para a lista não nascer muda — texto genérico, sem nome real. */
function escreverConversas(home) {
  for (const aba of ABAS) {
    const caminho = caminhoDoJsonl(home, aba.cwd, aba.sessaoId);
    const base = Date.now() - 90 * 60000;
    const em = (min) => new Date(base + min * 60000).toISOString();
    fs.mkdirSync(path.dirname(caminho), { recursive: true });
    fs.writeFileSync(caminho, linhaHumano(em(0), 'como está o build?') + linhaAssistente(em(1), 'Verde. Nada pendente.'));
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
      // Não sobe em cima: o /health responderia pelo intruso. Não mata nada — pode ser um job irmão.
      console.error(`🟡 a porta ${PORTA} já tem dono — ${dono}. Não subo em cima.`);
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-aparelhos-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });
    // Pasta VAZIA e obrigatória (A10 do `gate-jobs-disco.js`): sem ela o cockpit leria a pasta de
    // jobs de verdade, e títulos de projeto privado entrariam nos PNGs.
    fs.mkdirSync(path.join(scratch, 'jobs'), { recursive: true });

    // A pasta de push PRÓPRIA, semeada. Nunca a de produção: um clique no ✎ deste smoke
    // renomearia os aparelhos vivos do dono.
    const dirPush = path.join(scratch, 'push');
    fs.mkdirSync(dirPush, { recursive: true });
    fs.writeFileSync(path.join(dirPush, 'inscricoes.json'), JSON.stringify(INSCRICOES), { mode: 0o600 });

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
    console.log(`  · fixture pronta: ${INSCRICOES.length} inscrições de mentira em ${dirPush}`);

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
      COCKPIT_PUSH_DIR: dirPush,
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

    fs.copyFileSync(path.join(__dirname, 'roteiro-aparelhos.js'), path.join(scratch, 'roteiro.js'));

    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `UA_CRU=${UA_CRU}`, '-e', `NOME_NOVO=${NOME_NOVO}`,
      '-v', `${scratch}:/w:ro`, '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigoDocker = await new Promise((r) => docker.on('close', r));

    const MARCADOR = '@@APARELHOS@@';
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

    // Conferência no DISCO, do host, depois do container: renomear pela tela tem de ter chegado
    // ao inscricoes.json — e sem tocar em endpoint nem keys, que é a fase 3 do card.
    const depois = JSON.parse(fs.readFileSync(path.join(dirPush, 'inscricoes.json'), 'utf8'));
    const renomeada = depois.find((i) => i.endpoint === INSCRICOES[1].endpoint);
    const gravou = Boolean(renomeada) && renomeada.aparelho === NOME_NOVO;
    console.log(`  ${gravou ? '✅' : '❌'} disco: o aparelho do UA cru ficou com "${NOME_NOVO}" (${renomeada && renomeada.aparelho})`);
    if (!gravou) tudoOk = false;
    const intacta = Boolean(renomeada)
      && renomeada.endpoint === INSCRICOES[1].endpoint
      && JSON.stringify(renomeada.keys) === JSON.stringify(INSCRICOES[1].keys);
    console.log(`  ${intacta ? '✅' : '❌'} disco: e endpoint e keys continuam idênticos — renomear não invalida a inscrição`);
    if (!intacta) tudoOk = false;

    const pngs = fs.readdirSync(SAIDA).filter((n) => n.endsWith('.png'));
    const treze = pngs.length === 13;
    console.log(`  ${treze ? '✅' : '❌'} 13 PNGs na pasta de saída (${pngs.length})`);
    if (!treze) tudoOk = false;
    for (const nome of relatorio.gerados) console.log(`  ✅ ${path.join(SAIDA, nome)}`);

    limpar();
    console.log(tudoOk ? '✅ SMOKE VERDE' : '❌ SMOKE VERMELHO');
    return process.exit(tudoOk ? 0 : 1);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
