#!/usr/bin/env node
'use strict';
// REPRO REAL DO MENU DE CONFIANÇA (card `responder-confianca-do-cli-pelo-celular`, spec §2) — CLIs de verdade.
//
// O que reproduz: uma aba parada no menu de confiança de pasta nova (Codex criado pelo cockpit; Claude aberto
// pelo terminal) fica em `preSessao`, mas o cockpit não diz que a PASTA não é confiável: nem na lista de abas,
// nem na tela, nem na recusa do envio ("pedindo uma confirmação"), nem em `/api/projetos`.
//
// Roda os binários REAIS (/usr/bin/claude e /usr/bin/codex) num mundo de mentira: HOME temporário, tmux em socket
// próprio (`-f /dev/null`), `auth.json` do Codex com chave INVENTADA (só passa da tela de login). Não toca em
// nenhum arquivo do dono. Precisa dos dois binários — por isso NÃO entra no `bin/testes.js`.
//
// Uso:
//   node testes/repro-confianca-real.js                    # MODO=depois (padrão): espera o conserto
//   MODO=antes node testes/repro-confianca-real.js         # espera o estado de hoje (sem o campo, frases velhas)
//   RAIZ_CODIGO=<outra árvore> …                           # sobe o server.js de outra árvore (git archive de fef888d
//                                                          # mantém o MODO=antes vivo depois do conserto)
//
// Códigos de saída: 0 = verde · 1 = defeito (assert falhou) · 2 = ambiente indisponível
// (binário ausente, ou as abas não chegaram em `preSessao` em 25 s — imprime a captura das panes).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const MODO = process.env.MODO === 'antes' ? 'antes' : 'depois';
const RAIZ_CODIGO = process.env.RAIZ_CODIGO || path.join(__dirname, '..');
const PORTA = 7961;
const SOCKET = `cockpit-smoke-confianca-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `ancora-confianca-${process.pid}`;

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em TODO comando: sem ele o ~/.tmux.conf do dono carrega e o continuum-restore recria as
// sessões dele dentro do socket "isolado".
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

for (const bin of ['/usr/bin/claude', '/usr/bin/codex']) {
  if (!fs.existsSync(bin)) { console.error(`🟡 ambiente indisponível: ${bin} não existe.`); process.exit(2); }
}
if (!fs.existsSync(path.join(RAIZ_CODIGO, 'server.js'))) { console.error('🟡 RAIZ_CODIGO não tem o servidor.'); process.exit(2); }

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function http1(metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const req = http.request({
      host: '127.0.0.1', port: PORTA, path: caminho, method: metodo, timeout: 8000,
      headers: dados ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) } : {},
    }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { texto += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(texto); } catch { /* não-JSON */ }
        resolve({ status: res.statusCode, json, texto });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (dados) req.write(dados);
    req.end();
  });
}

async function saude() {
  try { return (await http1('GET', '/health')).status === 200; } catch { return false; }
}

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let T = null;
  let saida = 1;

  let limpou = false;
  function limpar() {
    if (limpou) return;
    limpou = true;
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
    // O carimbo prova que EU criei o socket; sem ele não derrubo nada.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    if (temCarimbo) t(['kill-server'], { tolerante: true });
    else console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    // Os CLIs ainda estão gravando no HOME falso quando o tmux cai: dá um respiro e tenta de novo.
    if (T) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.error(`  ❌ não limpei ${T}: ${e.message}`); }
    }
  }

  try {
    T = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-confianca-'));
    const H = path.join(T, 'home');
    fs.mkdirSync(path.join(H, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(H, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-falsa-so-para-repro' }));
    fs.writeFileSync(path.join(H, '.codex', 'config.toml'), '[projects."/outro"]\ntrust_level = "trusted"\n');
    fs.writeFileSync(path.join(H, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, theme: 'dark', projects: { '/outro': { hasTrustDialogAccepted: true } },
    }));
    const pastaCodex = path.join(T, 'projetos', 'proj-codex-novo');
    const pastaClaude = path.join(T, 'projetos', 'proj-claude-terminal');
    fs.mkdirSync(pastaCodex, { recursive: true });
    fs.mkdirSync(pastaClaude, { recursive: true });
    fs.mkdirSync(path.join(T, 'jobs'), { recursive: true });

    // `env -i`: as panes herdam o HOME falso, não o do dono.
    execFileSync('env', ['-i', 'PATH=/usr/bin:/bin', 'TERM=xterm-256color', `HOME=${H}`, 'tmux', '-L', SOCKET, '-f', '/dev/null',
      'new-session', '-d', '-x', '200', '-y', '50', '-s', SESSAO, '-n', CARIMBO, 'sleep', '3000']);

    // Ambiente do servidor por LISTA FECHADA: apaga tudo que é do cockpit/agentes e reescreve só o necessário.
    const ambiente = { ...process.env };
    for (const k of Object.keys(ambiente)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete ambiente[k];
    delete ambiente.PORT;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: H,
      CODEX_HOME: path.join(H, '.codex'),
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROJETOS_DIR: path.join(T, 'projetos'),
      COCKPIT_JOBS_DIR: path.join(T, 'jobs'),
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PUSH_DIR: path.join(T, 'push'),
      COCKPIT_MONITOR_DIR: path.join(T, 'monitor'),
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_LIDAS_DIR: path.join(T, 'lidas'),
      COCKPIT_DU_BIN: path.join(T, 'sem-du'),
      COCKPIT_DOCKER_BIN: path.join(T, 'sem-docker'),
    });
    servidor = spawn(process.execPath, [path.join(RAIZ_CODIGO, 'server.js')], { env: ambiente, cwd: RAIZ_CODIGO, stdio: ['ignore', 'ignore', 'pipe'] });
    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) { console.error(`🔴 o servidor (${PORTA}) não subiu`); limpar(); return process.exit(1); }
    console.log(`  · modo ${MODO}; servidor em 127.0.0.1:${PORTA} (pid ${servidor.pid}), socket ${SOCKET}`);

    // As duas abas: Codex pela API, Claude pelo terminal.
    const criada = await http1('POST', '/api/abas', { projeto: 'proj-codex-novo', agente: 'codex' });
    if (criada.status !== 201) { console.error(`🔴 POST /api/abas devolveu ${criada.status}: ${criada.texto}`); limpar(); return process.exit(1); }
    t(['new-window', '-d', '-t', `${SESSAO}:`, '-n', 'terminal-claude', '-c', pastaClaude, '/usr/bin/claude']);

    // Espera até 25 s as duas abas em preSessao.
    let codex = null;
    let claude = null;
    const acha = (lista) => {
      codex = lista.find((a) => a.agente === 'codex' && /proj-codex-novo/.test(a.titulo || a.nome || '')) || lista.find((a) => a.agente === 'codex') || null;
      claude = lista.find((a) => a.agente === 'claude' && /terminal-claude/.test(a.titulo || a.nome || '')) || lista.find((a) => a.agente === 'claude') || null;
    };
    // Alvo pela JANELA, não por `aba.pane`: a API pública não manda o id da pane (`paraCliente`). O nome da janela
    // do Codex é o do projeto (`criar()` usa `-n <nome>`); o do Claude, o desta chamada `new-window`.
    const alvoCodex = `${SESSAO}:proj-codex-novo`;
    const alvoClaude = `${SESSAO}:terminal-claude`;
    // `preSessao` sozinho NÃO prova o cenário (o menu de update do Codex também cai nele, spec §2.2): o laço só sai
    // com o MENU DE CONFIANÇA de cada CLI na tela.
    const menuDeConfianca = () => ({
      codex: /Do you trust the contents of this directory/.test(t(['capture-pane', '-p', '-t', alvoCodex], { tolerante: true })),
      claude: /Yes, I trust this folder/.test(t(['capture-pane', '-p', '-t', alvoClaude], { tolerante: true })),
    });
    let lista = [];
    let menus = { codex: false, claude: false };
    for (let i = 0; i < 25; i += 1) {
      // Menu de update do Codex vem antes do de confiança: Down + Enter pula (medido, spec §2.2).
      if (/Update available/.test(t(['capture-pane', '-p', '-t', alvoCodex], { tolerante: true }))) {
        t(['send-keys', '-t', alvoCodex, 'Down'], { tolerante: true });
        await espera(300);
        t(['send-keys', '-t', alvoCodex, 'Enter'], { tolerante: true });
        await espera(1000);
      }
      const r = await http1('GET', '/api/abas');
      lista = (r.json && r.json.abas) || [];
      acha(lista);
      menus = menuDeConfianca();
      if (codex && claude && codex.temAgente && claude.temAgente && codex.preSessao === true && claude.preSessao === true
        && menus.codex && menus.claude) break;
      await espera(1000);
    }
    if (!(codex && claude && codex.preSessao === true && claude.preSessao === true && menus.codex && menus.claude)) {
      console.error(`🟡 ambiente indisponível: as abas não chegaram ao menu de confiança em 25 s (menus: ${JSON.stringify(menus)}). Abas e panes:`);
      console.error(JSON.stringify(lista.map((a) => ({ chave: a.chave, agente: a.agente, temAgente: a.temAgente, preSessao: a.preSessao })), null, 2));
      console.error(t(['list-panes', '-a', '-F', '#{pane_id}'], { tolerante: true }).split('\n').filter(Boolean)
        .map((p) => `--- ${p}\n${t(['capture-pane', '-p', '-t', p], { tolerante: true })}`).join('\n'));
      limpar();
      return process.exit(2);
    }
    console.log('  · os dois CLIs estão no MENU DE CONFIANÇA (conferido na tela da pane)');

    // Medidas.
    const medidas = {};
    for (const [rotulo, aba] of [['codex', codex], ['claude', claude]]) {
      const tela = await http1('GET', `/api/abas/${encodeURIComponent(aba.chave)}/tela`);
      const envio = await http1('POST', `/api/abas/${encodeURIComponent(aba.chave)}/turnos`, { texto: 'oi' });
      medidas[rotulo] = {
        lista: aba.pedeConfianca,
        tela: tela.json ? tela.json.pedeConfianca : undefined,
        recusa: envio.json ? envio.json.erro : envio.texto,
      };
    }
    const proj = await http1('GET', '/api/projetos');
    const item = ((proj.json && proj.json.projetos) || []).find((p) => p.nome === 'proj-codex-novo') || null;
    medidas.projeto = item;
    console.log(JSON.stringify(medidas, null, 2));

    // Asserts.
    const falhas = [];
    const confere = (c, texto) => { console.log(`  ${c ? '✅' : '❌'} ${texto}`); if (!c) falhas.push(texto); };
    if (MODO === 'antes') {
      for (const r of ['codex', 'claude']) {
        confere(medidas[r].lista === undefined, `${r}: /api/abas sem pedeConfianca`);
        confere(String(medidas[r].recusa).includes('pedindo uma confirmação'), `${r}: recusa velha ("pedindo uma confirmação")`);
      }
      confere(item && Object.keys(item).join() === 'nome', 'item de projeto só com nome');
    } else {
      for (const r of ['codex', 'claude']) {
        confere(medidas[r].lista === true, `${r}: /api/abas pedeConfianca === true`);
        confere(medidas[r].tela === true, `${r}: /tela pedeConfianca === true`);
      }
      confere(String(medidas.codex.recusa).includes('esta pasta ainda não é confiável para o Codex CLI'), 'codex: recusa diz "não é confiável para o Codex CLI"');
      confere(String(medidas.claude.recusa).includes('esta pasta ainda não é confiável para o Claude Code'), 'claude: recusa diz "não é confiável para o Claude Code"');
      confere(item && item.codexPedeConfianca === true, 'projeto: codexPedeConfianca === true');
    }
    saida = falhas.length ? 1 : 0;
    console.log(saida ? `🔴 defeito reproduzido (${falhas.length} assert(s) no modo ${MODO})` : `🟢 verde no modo ${MODO}`);
    limpar();
    return process.exit(saida);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
