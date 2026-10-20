#!/usr/bin/env node
'use strict';
// REPRO REAL DA 1ª MENSAGEM DO CODEX (card `codex-primeira-mensagem-pelo-celular`) — Codex CLI de verdade.
//
// O que reproduz: aba de Codex recém-criada pelo cockpit, composer LIVRE na pane, e o POST de texto recusado com
// "o agente desta aba está pedindo uma confirmação no terminal" — uma pergunta que não existe. O Codex 0.153 só
// cria o rollout na 1ª mensagem; sem rollout a aba caía em `preSessao` (definido por ausência, #98) e a 1ª
// mensagem nunca saía pelo celular.
//
//   A  pasta já confiada (config.toml `trusted`)  → composer livre → POST /turnos tem que passar (202)
//   B  pasta nova → menu de confiança → o POST CONTINUA recusado (controle: o menu ainda trava) → Enter pela rota
//      `/teclas` (como o celular faz) → composer livre → POST /turnos tem que passar (202)
//   Nos dois, a prova de que a mensagem chegou: o rollout NASCE e o provider local recebe o pedido.
//
// Mundo de mentira: HOME temporário (CODEX_HOME dentro), tmux em socket próprio (`-f /dev/null`, panes com `env -i`),
// provider HTTP LOCAL respondendo "OK" (zero token, nada sai para a internet), server.js numa porta alta.
// Precisa do binário real — por isso NÃO entra no `bin/testes.js` (o gate offline é o `gate-menu-codex.js`, Parte 3b).
//
// Uso:
//   node testes/repro-codex-primeira-mensagem.js
//   RAIZ_CODIGO=<outra árvore> node testes/repro-codex-primeira-mensagem.js   # sobe o server.js de outra árvore
//
// Códigos de saída: 0 = verde · 1 = defeito (assert falhou) · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');

const RAIZ_CODIGO = process.env.RAIZ_CODIGO || path.join(__dirname, '..');
const CODEX = process.env.COCKPIT_BIN_CODEX || '/usr/bin/codex';
const PORTA = 7963;
const SOCKET = `cockpit-smoke-codex1a-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `ancora-codex1a-${process.pid}`;
const MINHAS_SESSOES = new Set([SESSAO]);

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em TODO comando: sem ele o ~/.tmux.conf do dono carrega e o continuum-restore recria as
// sessões dele dentro do socket "isolado".
function t(args, tolerante = false) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

if (t(['ls'], true).trim()) { console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`); process.exit(1); }
if (!fs.existsSync(CODEX)) { console.error(`🟡 ambiente indisponível: ${CODEX} não existe.`); process.exit(2); }
if (!fs.existsSync(path.join(RAIZ_CODIGO, 'server.js'))) { console.error('🟡 RAIZ_CODIGO não tem o servidor.'); process.exit(2); }

// A régua da ÁRVORE TESTADA decide "composer livre" — a mesma que o servidor usa, nunca uma regex daqui.
const { classificarTela } = require(path.join(RAIZ_CODIGO, 'lib', 'menu-codex.js'));

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let falhas = 0;
const ok = (c, texto) => { console.log(`  ${c ? '✅' : '❌'} ${texto}`); if (!c) falhas += 1; return c; };

function req(metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const r = http.request({
      host: '127.0.0.1', port: PORTA, path: caminho, method: metodo, timeout: 15000,
      headers: dados ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) } : {},
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* não-JSON */ } resolve({ status: res.statusCode, json: j, texto: s }); });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (dados) r.write(dados);
    r.end();
  });
}

// Provider local no formato `responses` (molde: testes/smoke-clear-codex.py) — devolve "OK" e conta os pedidos.
function subirProvider() {
  const pedidos = [];
  const srv = http.createServer((rq, rs) => {
    let corpo = '';
    rq.on('data', (c) => { corpo += c; });
    rq.on('end', () => {
      pedidos.push({ caminho: rq.url, corpo });
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
      const resp = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'mock', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      const eventos = [
        { type: 'response.created', response: { ...resp, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'OK' },
        { type: 'response.output_text.done', item_id: 'msg_fixture', output_index: 0, content_index: 0, text: 'OK' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: resp },
      ];
      const dados = eventos.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
      rs.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(dados) });
      rs.end(dados);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, porta: srv.address().port, pedidos })));
}

const tela = (alvo) => t(['capture-pane', '-p', '-t', alvo], true);

// A porta tem que estar LIVRE antes de eu subir o servidor: com outro cockpit nela, o `/health` dele responderia 200
// e os POSTs deste repro criariam abas no ambiente ERRADO — e a prova seria contra outra árvore.
function portaLivre(porta) {
  return new Promise((resolve) => {
    const sonda = net.createServer();
    sonda.once('error', () => resolve(false));
    sonda.once('listening', () => sonda.close(() => resolve(true)));
    sonda.listen(porta, '127.0.0.1');
  });
}

function rollouts(H) {
  const base = path.join(H, '.codex', 'sessions');
  const achados = [];
  (function anda(d) {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) anda(p); else if (e.name.endsWith('.jsonl')) achados.push(p); }
  })(base);
  return achados;
}

async function abaDe(proj) {
  const lista = (await req('GET', '/api/abas')).json?.abas || [];
  return lista.find((a) => a.agente === 'codex' && (a.titulo || '').includes(proj)) || null;
}

// Espera a pane chegar num estado da régua. O menu de UPDATE (vem antes do de confiança, se a checagem de
// versão rodar) é ambiente, não o que este repro mede: sai pelo "Skip" direto no tmux.
async function esperarTela(alvo, quer, prazoMs = 30000) {
  const fim = Date.now() + prazoMs;
  let s = '';
  while (Date.now() < fim) {
    s = tela(alvo);
    if (/Update available/.test(s)) {
      t(['send-keys', '-t', alvo, 'Down'], true); await espera(300); t(['send-keys', '-t', alvo, 'Enter'], true);
      await espera(1000);
      continue;
    }
    if (quer(s)) return s;
    await espera(500);
  }
  return null;
}

const mostrar = (s) => console.log(String(s || '').split('\n').filter((l) => l.trim()).slice(-6).map((l) => `     | ${l}`).join('\n'));

async function primeiraMensagem(cen, proj, H, provider) {
  const aba = await abaDe(proj);
  const antesProvider = provider.pedidos.length;
  console.log(`  /api/abas antes do envio: preSessao=${aba?.preSessao} pedeConfianca=${aba?.pedeConfianca} esperando=${aba?.esperando} sessaoId=${aba?.sessaoId}`);
  ok(aba && aba.preSessao === false, `${cen}: composer livre e sem rollout ⇒ preSessao false (saiu ${aba?.preSessao})`);
  const e = await req('POST', `/api/abas/${encodeURIComponent(aba.chave)}/turnos`, { texto: 'oi', id: `repro-${cen.toLowerCase()}-${process.pid}` });
  console.log(`  POST /turnos {texto:"oi"} → ${e.status} ${e.texto.slice(0, 200)}`);
  ok(e.status === 202, `${cen}: a 1ª mensagem sai pelo cockpit (202, saiu ${e.status})`);
  if (e.status !== 202) return;
  // A prova de que CHEGOU no Codex, não só que o cockpit disse 202: o rollout nasce e o provider é chamado.
  const fim = Date.now() + 20000;
  let ro = [];
  while (Date.now() < fim) {
    ro = rollouts(H).filter((p) => fs.readFileSync(p, 'utf8').includes('task_complete') && fs.readFileSync(p, 'utf8').includes(path.join('projetos', proj)));
    if (ro.length && provider.pedidos.length > antesProvider) break;
    await espera(500);
  }
  ok(ro.length === 1, `${cen}: o rollout nasceu com o turno completo (${ro.length} rollout(s) desta pasta)`);
  ok(provider.pedidos.length > antesProvider, `${cen}: o provider local recebeu o pedido (${provider.pedidos.length - antesProvider} novo(s))`);
  ok(provider.pedidos.slice(antesProvider).some((p) => p.corpo.includes('oi')), `${cen}: o pedido leva o texto "oi"`);
  await espera(6000);   // um tique do casamento (listar) para o rollout ser adotado
  const depois = await abaDe(proj);
  console.log(`  /api/abas depois: preSessao=${depois?.preSessao} sessaoId=${depois?.sessaoId ? '(casou)' : null} rodando=${depois?.rodando}`);
  ok(depois && depois.sessaoId && depois.preSessao === false, `${cen}: depois da 1ª mensagem a aba casa com o rollout`);
}

(async () => {
  let servidor = null;
  let provider = null;
  let T = null;
  let saida = 1;
  let errServidor = '';
  const limpar = () => {
    if (servidor && servidor.exitCode === null) try { process.kill(servidor.pid); } catch { /* já saiu */ }
    if (provider) try { provider.srv.close(); } catch { /* já fechou */ }
    // Duas respostas, não uma (D35): o carimbo prova que EU criei, a enumeração prova que não há mais ninguém no
    // socket. Matar o servidor tmux exige as duas.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], true).split('\n').some((n) => n.trim() === CARIMBO);
    const intrusas = t(['list-sessions', '-F', '#{session_name}'], true).split('\n').map((n) => n.trim()).filter(Boolean)
      .filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) t(['kill-server'], true);
    else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], true);
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else if (t(['ls'], true).trim()) console.error(`  ❌ a âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    if (T) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.error('não limpei', T, e.message); }
    }
  };
  try {
    provider = await subirProvider();
    T = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-codex1a-'));
    const H = path.join(T, 'home');
    const PROJ = path.join(T, 'projetos');
    fs.mkdirSync(path.join(H, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(H, '.codex', 'config.toml'), [
      'model = "mock"',
      'model_provider = "mock"',
      'check_for_update_on_startup = false',
      `[projects."${path.join(PROJ, 'proj-a-confiado')}"]`,
      'trust_level = "trusted"',
      '[model_providers.mock]',
      'name = "Fixture local"',
      `base_url = "http://127.0.0.1:${provider.porta}/v1"`,
      'env_key = "COCKPIT_TEST_API_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(H, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: {} }));
    for (const p of ['proj-a-confiado', 'proj-b-novo']) fs.mkdirSync(path.join(PROJ, p), { recursive: true });
    fs.mkdirSync(path.join(T, 'jobs'), { recursive: true });
    // `env -i`: as panes nascem com o HOME falso e a chave de MENTIRA do provider local — nada do ambiente real.
    execFileSync('env', ['-i', 'PATH=/usr/bin:/bin', 'TERM=xterm-256color', `HOME=${H}`, 'COCKPIT_TEST_API_KEY=fixture-only',
      'tmux', '-L', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-x', '200', '-y', '50', '-s', SESSAO, '-n', CARIMBO, 'sleep', '3000']);
    const amb = { ...process.env };
    for (const k of Object.keys(amb)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete amb[k];
    Object.assign(amb, {
      HOST: '127.0.0.1', PORT: String(PORTA), HOME: H, CODEX_HOME: path.join(H, '.codex'), COCKPIT_BIN_CODEX: CODEX,
      COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TMUX_SOCKET: SOCKET, COCKPIT_TMUX_SESSAO: SESSAO, COCKPIT_PROJETOS_DIR: PROJ,
      COCKPIT_JOBS_DIR: path.join(T, 'jobs'), COCKPIT_VIGIA_MS: '0', COCKPIT_PUSH_DIR: path.join(T, 'push'),
      COCKPIT_MONITOR_DIR: path.join(T, 'monitor'), COCKPIT_MONITOR_MS: '0', COCKPIT_LIDAS_DIR: path.join(T, 'lidas'),
      COCKPIT_DU_BIN: path.join(T, 'sem-du'), COCKPIT_DOCKER_BIN: path.join(T, 'sem-docker'),
    });
    if (!await portaLivre(PORTA)) { console.error(`🟡 ambiente indisponível: a porta ${PORTA} já está ocupada (outro repro? rerode depois — não mato nada).`); saida = 2; throw null; }
    servidor = spawn(process.execPath, [path.join(RAIZ_CODIGO, 'server.js')], { env: amb, cwd: RAIZ_CODIGO, stdio: ['ignore', 'pipe', 'pipe'] });
    servidor.stderr.on('data', (c) => { errServidor += c; });
    // A prova de que a porta é MINHA: o próprio processo imprime a linha do `listen` (server.js, callback do
    // `listen`). Sem ela, um `/health` 200 pode ser de outro servidor que ganhou a porta depois da sonda.
    let escutando = false;
    let outServidor = '';
    servidor.stdout.on('data', (c) => {
      outServidor += c;
      if (outServidor.includes(`http://127.0.0.1:${PORTA}`)) escutando = true;
    });
    let pronto = false;
    for (let i = 0; i < 60 && !pronto && servidor.exitCode === null; i += 1) {
      if (escutando) { try { pronto = (await req('GET', '/health')).status === 200; } catch { /* subindo */ } }
      if (!pronto) await espera(200);
    }
    // O /health respondeu, mas foi o MEU processo? Ele tem que ter anunciado o `listen` e continuar vivo — se morreu
    // (EADDRINUSE numa corrida com a sonda acima), quem respondeu é outro.
    if (pronto && (!escutando || servidor.exitCode !== null)) pronto = false;
    if (!pronto) { console.error(`🟡 ambiente indisponível: servidor não subiu na ${PORTA}.\n${errServidor.slice(-600)}`); saida = 2; throw null; }
    console.log(`servidor ${PORTA} (árvore ${RAIZ_CODIGO}); ${execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim()}; provider local na ${provider.porta}`);

    // ── A: pasta já confiada ──────────────────────────────────────────────────────────────────────────────
    console.log('\n=== A — pasta já confiada (config.toml trusted)');
    const cA = await req('POST', '/api/abas', { projeto: 'proj-a-confiado', agente: 'codex' });
    ok(cA.status === 201, `A: POST /api/abas → ${cA.status}`);
    const alvoA = `${SESSAO}:proj-a-confiado`;
    const sA = await esperarTela(alvoA, (s) => classificarTela(s) === 'livre');
    if (!sA) { console.error('🟡 ambiente indisponível: o composer do Codex não apareceu em 30 s (A). Tela:'); mostrar(tela(alvoA)); saida = 2; throw null; }
    mostrar(sA);
    await espera(6000);   // um tique do `listar()` com a tela já livre
    ok(rollouts(H).length === 0, `A: premissa do card — composer livre e NENHUM rollout ainda (${rollouts(H).length})`);
    await primeiraMensagem('A', 'proj-a-confiado', H, provider);

    // ── B: pasta nova, "Yes" pelo celular ────────────────────────────────────────────────────────────────
    console.log('\n=== B — pasta nova: menu de confiança, Enter pela rota /teclas');
    const cB = await req('POST', '/api/abas', { projeto: 'proj-b-novo', agente: 'codex' });
    ok(cB.status === 201, `B: POST /api/abas → ${cB.status}`);
    const alvoB = `${SESSAO}:proj-b-novo`;
    const sMenu = await esperarTela(alvoB, (s) => /Do you trust the contents of this directory/.test(s) && classificarTela(s) === 'menu');
    if (!sMenu) { console.error('🟡 ambiente indisponível: o menu de confiança não apareceu em 30 s (B). Tela:'); mostrar(tela(alvoB)); saida = 2; throw null; }
    mostrar(sMenu);
    await espera(6000);
    const abaMenu = await abaDe('proj-b-novo');
    console.log(`  /api/abas com o menu: preSessao=${abaMenu?.preSessao} pedeConfianca=${abaMenu?.pedeConfianca} esperando=${abaMenu?.esperando}`);
    ok(abaMenu && abaMenu.preSessao === true, 'B: com o menu de confiança na tela, preSessao CONTINUA true (não regride o 84c9/D81)');
    ok(abaMenu && abaMenu.pedeConfianca === true, 'B: e o pedeConfianca da config continua true');
    const recusa = await req('POST', `/api/abas/${encodeURIComponent(abaMenu.chave)}/turnos`, { texto: 'nao deve sair', id: `repro-bmenu-${process.pid}` });
    console.log(`  POST /turnos com o menu aberto → ${recusa.status} ${recusa.texto.slice(0, 200)}`);
    ok(recusa.status === 409 && /não é confiável/.test(recusa.json?.erro || ''), 'B: com o menu aberto o texto CONTINUA recusado com a frase de confiança');
    const k = await req('POST', `/api/abas/${encodeURIComponent(abaMenu.chave)}/teclas`, { tecla: 'Enter' });
    console.log(`  POST /teclas Enter → ${k.status}`);
    ok(k.status === 200, `B: o "Yes" sai pela rota de teclas (${k.status})`);
    const sB = await esperarTela(alvoB, (s) => classificarTela(s) === 'livre' && !/Do you trust/.test(s));
    if (!sB) { console.error('🟡 ambiente indisponível: o composer não apareceu depois do Enter (B). Tela:'); mostrar(tela(alvoB)); saida = 2; throw null; }
    mostrar(sB);
    await espera(6000);
    await primeiraMensagem('B', 'proj-b-novo', H, provider);

    console.log(`\n${falhas ? `🔴 ${falhas} assert(s) falharam` : '🟢 tudo verde'}`);
    saida = falhas ? 1 : 0;
  } catch (e) {
    if (e) { console.error('estourou:', (e && e.stack) || e); saida = 1; }
  }
  limpar();
  process.exit(saida);
})();
