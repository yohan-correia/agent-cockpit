#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — conversa: ferramentas agrupadas e as cinco transições.
//
// Prova de tela do card `conversa-ferramentas-agrupadas-e-transicoes`, com antes/depois em
// 390×844: o `<details class="grupo-ferramentas">` que substitui a sequência de `.ferramenta`
// soltas, e as transições T1 (lista→conversa) e T2 (<dialog>), medidas por CSS computado no
// meio do movimento — transição não aparece em print estático.
//
// Molde: `testes/smoke-celular-primeira-leva.js` (HOME de mentira sobre panes de verdade num
// socket tmux próprio, `docker run --network host`, saída 0/1/2). O roteiro do navegador mora
// em `testes/roteiro-conversa-transicoes.js`, não numa template string: ele precisa de crase
// e de `${}` de verdade.
//
// T3 (.bolha-pendente) e T4 (.fer-estado) NÃO são medidos aqui: as funções que produzem esses
// dois estados são de módulo e não estão expostas em `window`, então não há como disparar o
// evento de fora. Eles vão para a bancada de CSS (`bancada-t3t4`), como a Fase 0 do plano.
//
// MODO=antes|depois é OBRIGATÓRIO. SAIDA=<pasta> é obrigatório e recusa pasta com PNG dentro.
// RAIZ=<pasta> aponta o checkout que sobe o servidor — no MODO=antes é a cópia do `develop`.
//
// Porta: 7896. NUNCA 7899 (#24 — a porta dos jobs do orquestrador) nem 7879 (produção do usuário).
//
// Códigos: 0 = passou · 1 = falha de produto/assert · 2 = erro de USO ou de AMBIENTE
//          3 = bloqueio por falta de dado (a fixture não produziu o que o print precisa).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

// ─── Contrato de uso ─────────────────────────────────────────────────────────

const MODO = process.env.MODO;
if (MODO !== 'antes' && MODO !== 'depois') {
  console.error('🔴 defina MODO=antes ou MODO=depois');
  process.exit(2);
}
const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs e o medidas.json vão cair>');
  process.exit(2);
}
const RAIZ = path.resolve(process.env.RAIZ || path.join(__dirname, '..'));
if (!fs.existsSync(path.join(RAIZ, 'server.js'))) {
  console.error(`🔴 RAIZ=${RAIZ} não tem server.js`);
  process.exit(2);
}

const PORTA = Number(process.env.PORTA || 7896);
if (PORTA === 7899 || PORTA === 7879) {
  console.error(`🔴 porta ${PORTA} é proibida (7899 = jobs do orquestrador, 7879 = produção)`);
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';

const PNGS = MODO === 'depois'
  ? ['01-depois-ferramentas', '02-t1-meio', '03-t2-meio', '04-pergunta', '05-reduced', '06-grupo-aberto']
  : ['01-antes-ferramentas', '04-pergunta'];

// ─── Fail-closed do socket tmux ──────────────────────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-transicoes-${process.pid}`;
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

// ─── A fixture: duas abas, uma delas com TRÊS ferramentas consecutivas ───────

const CWD_COCKPIT = '/home/smoke/projetos/cockpit-agentes';
const CWD_OUTRA = '/home/smoke/projetos/projeto-b';
const SESSID_COCKPIT = 'sess-cockpit';
const SESSID_OUTRA = 'sess-projeto-b';
// O texto que o roteiro usa para achar a linha na lista (trava 5: por TEXTO, nunca por índice).
const CONVERSA = 'cockpit-agentes';

function raizProc(scratch) { return path.join(scratch, 'proc'); }

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
    kind: 'interactive', sessionId: sessaoId, cwd, status, updatedAt: Date.now(),
    pid, procStart: starttime, tmux: `${SESSAO}:${janela}.${pane}`,
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

/**
 * As TRÊS `tool_use` vão numa mensagem só, de propósito: `eventosDoObjeto` percorre o array
 * `content` na ordem (lib/externo.js:286-295), então saem três eventos `ferramenta`
 * CONSECUTIVOS — que é a condição do agrupamento. Espalhá-las por mensagens diferentes
 * deixaria o agrupamento à mercê de qualquer bolha que nascesse no meio.
 */
const linhaFerramentas = (iso, ferramentas) => `${JSON.stringify({
  type: 'assistant',
  timestamp: iso,
  message: { content: ferramentas.map((f) => ({ type: 'tool_use', id: f.id, name: f.nome, input: f.entrada })) },
})}\n`;

const linhaResultados = (iso, resultados) => `${JSON.stringify({
  type: 'user',
  timestamp: iso,
  message: { content: resultados.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.saida, is_error: Boolean(r.erro) })) },
})}\n`;

const FERRAMENTAS = [
  { id: 'toolu_smoke_1', nome: 'Read', entrada: { file_path: '/home/smoke/projetos/cockpit-agentes/public/estilo.css' } },
  { id: 'toolu_smoke_2', nome: 'Read', entrada: { file_path: '/home/smoke/projetos/cockpit-agentes/public/app.js' } },
  { id: 'toolu_smoke_3', nome: 'Grep', entrada: { pattern: 'grupo-ferramentas', path: 'public' } },
];

/** A conversa que os PNGs 01 fotografam. Devolve o `T` da última mensagem, em ms. */
function conversaComFerramentas(caminho) {
  const linhas = [];
  let quando = Date.now() - 12 * 60000;
  const iso = () => new Date(quando).toISOString();
  linhas.push(linhaHumano(iso(), 'confere como está o bloco de celular do estilo.css')); quando += 40000;
  linhas.push(linhaAssistente(iso(), 'Vou ler os dois arquivos e procurar o seletor.')); quando += 20000;
  linhas.push(linhaFerramentas(iso(), FERRAMENTAS)); quando += 30000;
  linhas.push(linhaResultados(iso(), [
    { id: 'toolu_smoke_1', saida: '1568 linhas lidas' },
    { id: 'toolu_smoke_2', saida: '3410 linhas lidas' },
    { id: 'toolu_smoke_3', saida: 'public/estilo.css:1198\npublic/app.js:1272' },
  ])); quando += 25000;
  linhas.push(linhaAssistente(iso(), 'Achei: o bloco do grupo está em `estilo.css:1198`, e quem monta é `abrirGrupo()`.'));
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhas.join(''));
  return quando;
}

/** Uma conversa curta, só para a lista ter duas linhas. */
function conversaPequena(caminho, baseMs) {
  const linhas = [];
  let quando = baseMs - 2 * 60000;
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'oi, tudo certo por aí?')); quando += 60000;
  linhas.push(linhaAssistente(new Date(quando).toISOString(), 'tudo certo — sigo por aqui.'));
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhas.join(''));
  return quando;
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

// ─── Execução ────────────────────────────────────────────────────────────────

(async () => {
  let scratch = null;
  let servidor = null;
  let saida = 0;

  function limpar() {
    let falhouLimpeza = false;
    if (servidor && servidor.exitCode === null) {
      // Pelo PID do processo que EU criei — nunca `pkill -f "node server.js"`, que
      // alcançaria a produção do usuário na 7879 (armadilha #24).
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
    }
    const ancora = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true });
    if (ancora.includes(CARIMBO)) {
      t(['kill-server'], { tolerante: true });
    } else if (ancora.trim()) {
      falhouLimpeza = true;
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

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-transicoes-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // 1) as panes, num socket próprio. A âncora mora numa SESSÃO à parte, senão viraria
    //    uma aba a mais na lista (lib/abas.js filtra por sessão).
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'cockpit-agentes', '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-window', '-t', SESSAO, '-n', 'projeto-b', '-c', os.tmpdir(), 'sleep', '600']);

    const panes = {};
    for (const linha of t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    for (const nome of ['cockpit-agentes', 'projeto-b']) {
      if (!panes[nome]) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
    }

    // 2) o mundo de mentira, com os pids REAIS das panes
    const T_COCKPIT = conversaComFerramentas(caminhoDoJsonl(home, CWD_COCKPIT, SESSID_COCKPIT));
    const T_OUTRA = conversaPequena(caminhoDoJsonl(home, CWD_OUTRA, SESSID_OUTRA), Date.now() - 30 * 60000);

    plantarAgenteFalso(scratch, panes['cockpit-agentes'].panePid, { starttime: 2000001 });
    escreverSessao(home, {
      pid: panes['cockpit-agentes'].panePid, janela: panes['cockpit-agentes'].janelaId,
      pane: panes['cockpit-agentes'].paneId, sessaoId: SESSID_COCKPIT, cwd: CWD_COCKPIT,
      starttime: 2000001, status: 'idle',
    });
    plantarAgenteFalso(scratch, panes.projeto-b.panePid, { starttime: 2000002 });
    escreverSessao(home, {
      pid: panes.projeto-b.panePid, janela: panes.projeto-b.janelaId, pane: panes.projeto-b.paneId,
      sessaoId: SESSID_OUTRA, cwd: CWD_OUTRA, starttime: 2000002, status: 'idle',
    });
    console.log(`  · fixture pronta: cockpit=${panes['cockpit-agentes'].panePid} projeto-b=${panes.projeto-b.panePid}`
      + ` · T_COCKPIT=${T_COCKPIT} T_OUTRA=${T_OUTRA}`);

    // 3) o servidor, a partir da RAIZ pedida (no MODO=antes é a cópia do develop). O `cwd` é
    //    obrigatório: o servidor resolve `public/` a partir dele.
    const ambiente = { ...process.env };
    delete ambiente.COCKPIT_TOKEN;   // o servidor só exige token quando a var existe
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',   // sem isto sobe TLS e o gate colhe 301 (#19)
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
    });
    servidor = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
      cwd: RAIZ, env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let erroDoServidor = '';
    servidor.stderr.on('data', (d) => { erroDoServidor += d; });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      ok(false, `o servidor (${PORTA}) não subiu — ${erroDoServidor.slice(0, 300)}`);
      limpar();
      return process.exit(2);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid}, raiz ${RAIZ})`);

    // 4) o roteiro, dentro do container
    fs.copyFileSync(path.join(__dirname, 'roteiro-conversa-transicoes.js'), path.join(scratch, 'roteiro.js'));
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=http://127.0.0.1:${PORTA}`,
      '-e', `MODO=${MODO}`,
      '-e', `CONVERSA=${CONVERSA}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/roteiro.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    const codigo = await new Promise((r) => docker.on('close', r));

    const MARCADOR = '@@MEDIDAS-TRANSICOES@@';
    const abre = saidaDocker.indexOf(MARCADOR);
    console.log(abre >= 0 ? saidaDocker.slice(0, abre) : saidaDocker);
    let relatorio = null;
    if (abre >= 0) {
      try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
    }
    if (!relatorio) {
      ok(false, `o roteiro não devolveu JSON (código ${codigo})`);
      limpar();
      return process.exit(1);
    }

    const { medidas, problemas } = relatorio;

    // 5) bloqueio por falta de DADO (exit 3), distinto de falha do recurso (exit 1)
    const semDadoDepois = MODO === 'depois' && medidas.temGrupo === false;
    const semDadoAntes = MODO === 'antes' && Number(medidas.soltasNaFita || 0) < 2;
    if (semDadoDepois || semDadoAntes) {
      console.error('🟠 SMOKE BLOQUEADO POR FALTA DE DADO: a fixture não produziu'
        + (semDadoDepois ? ' o `.grupo-ferramentas`' : ' uma sequência de >= 2 `.ferramenta` soltas')
        + ` (temGrupo=${medidas.temGrupo}, soltasNaFita=${medidas.soltasNaFita})`);
      limpar();
      return process.exit(3);
    }

    ok(problemas.length === 0, problemas.length
      ? `o percurso reprovou: ${problemas.join(' · ')}`
      : 'o percurso passou inteiro');

    for (const nome of PNGS) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }

    // 6) as exigências do MODO — os números, não só o "não estourou"
    if (MODO === 'depois') {
      ok(medidas.temGrupo === true, `o <details class="grupo-ferramentas"> existe (${medidas.temGrupo})`);
      ok(medidas.passosNoGrupo === 3, `as TRÊS ferramentas viraram passos do grupo (${medidas.passosNoGrupo})`);
      ok(medidas.soltasNaFita === 0, `nenhuma .ferramenta ficou solta na fita (${medidas.soltasNaFita})`);
      ok(medidas.passosVisiveisAberto === 3, `o grupo ABERTO mostra os três passos (${medidas.passosVisiveisAberto})`);
      ok(medidas.passosComClassePasso === 3, `os três passos têm a classe .passo (${medidas.passosComClassePasso})`);
      // A trava do card: o grupo NÃO muda o id, senão `resultado_ferramenta` perde o cartão.
      for (const f of FERRAMENTAS) {
        ok((medidas.idsPreservados || []).includes(f.id), `o data-ferramenta-id "${f.id}" sobreviveu ao agrupamento`);
      }
      ok(typeof medidas.t1Tx === 'number' && medidas.t1Tx > 0 && medidas.t1Tx < 390,
        `A1: translateX do .chat a t≈80ms = ${medidas.t1Tx} (0 < x < 390)`);
      ok(medidas.t1VistaAntes === 'lista' && medidas.t1VistaDepois === 'chat',
        `A1: a vista foi de "lista" para "chat" (${medidas.t1VistaAntes} → ${medidas.t1VistaDepois})`);
      // `getComputedStyle().transitionDuration` normaliza para SEGUNDOS ("0.2s"), nunca "200ms".
      ok(/(^|[ ,])0\.2s/.test(String(medidas.t1DuracaoDeclarada)), `A1: o .chat declara 200ms (${medidas.t1DuracaoDeclarada})`);
      ok(typeof medidas.t2ScaleX === 'number' && medidas.t2ScaleX >= 0.96 && medidas.t2ScaleX < 1,
        `A2: scaleX do <dialog> a t≈80ms = ${medidas.t2ScaleX} (0.96 <= x < 1)`);
      ok(/(^|[ ,])0\.16s/.test(String(medidas.t2DuracaoDeclarada)), `A2: o <dialog> declara 160ms (${medidas.t2DuracaoDeclarada})`);
      ok(medidas.reducedTransformMeio === 'none',
        `A7: com prefers-reduced-motion o .chat a t≈80ms é "none" (${medidas.reducedTransformMeio})`);
      ok(medidas.chatTransformComPergunta === 'none',
        `R2: com a .pergunta aberta o .chat NÃO tem transform (${medidas.chatTransformComPergunta})`);
    } else {
      ok(medidas.temGrupo === false, `o código anterior NÃO tem .grupo-ferramentas (${medidas.temGrupo})`);
      ok(medidas.soltasNaFita >= 2, `o código anterior tem >= 2 .ferramenta soltas na fita (${medidas.soltasNaFita})`);
    }

    // A3/A4 e A5/A6 valem nos DOIS modos — é o par de não-regressão.
    const cobre = (r) => r && Math.abs(r.x) <= 1 && Math.abs(r.y) <= 1
      && Math.abs(r.w - 390) <= 1 && Math.abs(r.h - 844) <= 1;
    ok(cobre(medidas.perguntaRect80), `A3: a .pergunta a t≈80ms cobre 390×844 (${JSON.stringify(medidas.perguntaRect80)})`);
    ok(cobre(medidas.perguntaRect400), `A4: a .pergunta a t≈400ms cobre 390×844 (${JSON.stringify(medidas.perguntaRect400)})`);
    ok(medidas.seloExiste === true && medidas.seloIrmaoDaConversas === true,
      `A5: o .puxar-selo existe na lista e é irmão da .conversas (${medidas.seloExiste}/${medidas.seloIrmaoDaConversas})`);
    ok(medidas.seloArmado === '1', `A6: o gesto ARMA o selo depois do touchmove (data-armado=${medidas.seloArmado})`);

    if (!falhas) {
      fs.writeFileSync(path.join(SAIDA, 'medidas.json'), JSON.stringify(medidas, null, 2));
    } else {
      fs.writeFileSync(path.join(SAIDA, 'medidas-com-falha.json'), JSON.stringify({ medidas, problemas }, null, 2));
    }
    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 o smoke estourou:', e && e.message);
    saida = 1;
  } finally {
    if (!limpar()) saida = saida || 1;
    console.log(`\n${falhas || saida ? '❌ SMOKE DE TRANSIÇÕES VERMELHO' : '✅ SMOKE DE TRANSIÇÕES VERDE'}`
      + ` — ${feitos - falhas}/${feitos} · MODO=${MODO} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
