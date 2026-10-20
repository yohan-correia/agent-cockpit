#!/usr/bin/env node
'use strict';
// REPRO do card `mensagem-some-no-menu-do-auto-mode` — o envio do cockpit com o diálogo
// "Teach auto mode about your environment?" aberto na TUI do Claude Code.
//
// O defeito (16/10, aba-p230): a colagem é DESCARTADA pelo diálogo, o Enter do cockpit CONFIRMA o
// "Yes" (o CLI grava `/auto-mode-setup` no history e abre o assistente de configuração) e a mensagem
// do dono nunca chega ao agente — enquanto o envio responde "enviado". O diálogo abre SOZINHO no fim
// de um turno e o `~/.claude/sessions/<pid>.json` continua dizendo `status: idle` (medido nas 2.1.280
// e 2.1.295, `testes/medir-menu-auto-mode.sh`): nada no disco avisa o cockpit.
//
// Roda o `enviar()` REAL de `lib/abas.js` contra o `claude` REAL, num mundo de mentira:
//   • HOME temporário (0700) — `.claude.json` sintético com `autoModeEnvSetup.denials = 5` (o gatilho
//     lido no binário, função `xP`), `defaultMode: auto`, e a credencial do dono por SYMLINK (nunca
//     copiada nem lida aqui; quem lê é o CLI). O `.claude.json` do dono não é tocado.
//   • tmux em socket próprio com `-f /dev/null` (sem isso o continuum-restore clona as sessões do dono).
//   • Duas subidas do CLI: a 1ª só aquece o cache de feature flags (sem ele, na 2.1.280, o diálogo
//     não abre — medido).
// Custa 2-3 turnos de sonnet (o modo auto não existe no haiku). NÃO roda no `npm test`.
//
// Uso:
//   node testes/repro-menu-auto-mode.js                  # contra esta árvore
//   RAIZ_CODIGO=<outra árvore> node testes/…             # o `lib/abas.js` de outra árvore (git archive
//                                                        # do commit de antes do conserto = prova "antes")
//
// Códigos de saída: 0 = a mensagem chegou e o diálogo NÃO foi confirmado · 1 = defeito ·
// 2 = ambiente indisponível (sem binário, ou o diálogo não abriu em 120 s).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ_CODIGO = path.resolve(process.env.RAIZ_CODIGO || path.join(__dirname, '..'));
const BIN = process.env.COCKPIT_BIN_CLAUDE || '/usr/bin/claude';
const SOCKET = `cockpit-smoke-automode-${process.pid}`;
const MARCA = `marcador${process.pid}`;

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
if (!fs.existsSync(BIN)) { console.error(`🟡 ambiente indisponível: ${BIN} não existe.`); process.exit(2); }
const CREDENCIAL = path.join(os.homedir(), '.claude', '.credentials.json');
if (!fs.existsSync(CREDENCIAL)) { console.error('🟡 ambiente indisponível: o CLI não está logado.'); process.exit(2); }

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let falhas = 0;
const ok = (c, t) => { if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };

// ─── O mundo de mentira ────────────────────────────────────────────────────────────────────────
const CASA = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-automode-'));
fs.chmodSync(CASA, 0o700);
const PROJETO = path.join(CASA, 'projeto');
fs.mkdirSync(path.join(CASA, '.claude'), { recursive: true });
fs.mkdirSync(PROJETO);
fs.symlinkSync(CREDENCIAL, path.join(CASA, '.claude', '.credentials.json'));
fs.writeFileSync(path.join(CASA, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.280', numStartups: 10, autoUpdates: false,
  autoModeEnvSetup: { denials: 5 }, hasSeenAutoModeEntryWarning: true,
  hasResetAutoModeOptInForDefaultOffer: true, theme: 'dark',
  projects: { [PROJETO]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}));
fs.writeFileSync(path.join(CASA, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }));

// O servidor tmux nasce com ESTE ambiente, e as panes herdam: HOME falso, nada de CLAUDECODE/COCKPIT_*.
const AMBIENTE_TMUX = {
  HOME: CASA, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', USER: os.userInfo().username,
};
function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: AMBIENTE_TMUX });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}
function limpar() {
  t(['kill-server'], { tolerante: true });
  try { fs.rmSync(CASA, { recursive: true, force: true }); } catch { /* o CLI ainda gravando: fica no /tmp */ }
}
process.on('exit', limpar);
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => process.exit(1));

const tela = (alvo) => t(['capture-pane', '-p', '-t', alvo], { tolerante: true });
async function esperarTela(alvo, re, segundos) {
  for (let i = 0; i < segundos * 2; i += 1) {
    if (re.test(tela(alvo))) return true;
    await espera(500);
  }
  return false;
}

async function principal() {
  // O cockpit é carregado DEPOIS do HOME falso: `lib/abas.js` resolve os caminhos do CLI no require.
  process.env.HOME = CASA;
  process.env.COCKPIT_TMUX_SOCKET = SOCKET;
  process.env.COCKPIT_TMUX_SESSAO = 'main';
  process.env.COCKPIT_ANEXOS_DIR = path.join(CASA, 'anexos');
  const abas = require(path.join(RAIZ_CODIGO, 'lib', 'abas.js'));
  const comando = abas.comandoDaAba('claude', 'sonnet');

  t(['new-session', '-d', '-s', 'main', '-n', 'base', '-c', PROJETO, '-x', '120', '-y', '40', 'sleep 100000']);
  t(['new-window', '-t', 'main', '-n', 'aquece', '-c', PROJETO, comando]);
  if (!await esperarTela('main:aquece', /❯/, 40)) { console.error('🟡 o CLI não subiu.'); process.exit(2); }
  await espera(8000);
  t(['kill-window', '-t', 'main:aquece']);
  await espera(1500);
  t(['new-window', '-t', 'main', '-n', 'repro', '-c', PROJETO, comando]);
  if (!await esperarTela('main:repro', /❯/, 40)) { console.error('🟡 o CLI não subiu.'); process.exit(2); }
  await espera(3000);

  const aba = (await abas.listar()).find((a) => a.titulo === 'repro' && a.temAgente);
  if (!aba) { console.error('🟡 o cockpit não achou a aba "repro" com agente.'); process.exit(2); }
  console.log(`aba ${aba.chave} (pid ${aba.agentePid}), cockpit de ${RAIZ_CODIGO}`);

  // 1º turno pelo cockpit — o fim dele arma o diálogo.
  await abas.enviar(aba.chave, 'responda apenas: oi');
  if (!await esperarTela('main:repro', /Teach auto mode/, 120)) {
    console.error('🟡 o diálogo "Teach auto mode" não abriu em 120 s:');
    console.error(tela('main:repro'));
    process.exit(2);
  }
  await espera(1500);   // fora da janela de 500 ms em que o diálogo ignora tecla (`pve` no binário)
  const arquivoSessao = path.join(CASA, '.claude', 'sessions', `${aba.agentePid}.json`);
  const sessao = JSON.parse(fs.readFileSync(arquivoSessao, 'utf8'));
  console.log(`status com o diálogo aberto: ${sessao.status} (waitingFor: ${sessao.waitingFor ?? null})`);
  const telaAntes = tela('main:repro');

  // O envio do defeito, pelo caminho REAL do cockpit.
  let resposta = null;
  let falha = null;
  try {
    resposta = await abas.enviar(aba.chave, `responda apenas: ${MARCA}`, [], `repro-${process.pid}`);
  } catch (e) {
    falha = e;
  }
  console.log(falha ? `envio recusou: ${falha.message} (colado: ${Boolean(falha.colado)})`
    : `envio respondeu: ${JSON.stringify({ enviado: resposta.enviado, menuFechado: resposta.menuFechado ?? null })}`);

  // A mensagem chegou ao agente? (o `.jsonl` é a memória dele) — e o diálogo foi confirmado?
  const arquivoConversa = () => {
    const dir = path.join(CASA, '.claude', 'projects');
    for (const pasta of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const f = path.join(dir, pasta, `${sessao.sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  };
  const chegou = () => {
    const f = arquivoConversa();
    return Boolean(f) && fs.readFileSync(f, 'utf8').split('\n').some((l) => {
      try {
        const j = JSON.parse(l);
        return j.type === 'user' && typeof j.message?.content === 'string' && j.message.content.includes(MARCA);
      } catch { return false; }
    });
  };
  const historico = () => {
    const f = path.join(CASA, '.claude', 'history.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).display) : [];
  };
  for (let i = 0; i < 60 && !chegou(); i += 1) await espera(1000);
  await espera(2000);
  const telaDepois = tela('main:repro');
  const hist = historico();

  console.log('\n── tela com o diálogo, antes do envio (últimas 14 linhas) ──');
  console.log(telaAntes.split('\n').filter((l) => l.trim()).slice(-14).join('\n'));
  console.log('\n── tela depois do envio (últimas 14 linhas) ──');
  console.log(telaDepois.split('\n').filter((l) => l.trim()).slice(-14).join('\n'));
  console.log(`\nhistory: ${JSON.stringify(hist)}\n`);

  ok(sessao.status !== 'waiting', `premissa: com o diálogo aberto o CLI diz "${sessao.status}", não "waiting"`);
  ok(!falha, 'o envio não foi recusado');
  ok(chegou(), `a mensagem (${MARCA}) chegou ao agente — está no .jsonl`);
  ok(!hist.includes('/auto-mode-setup'), 'o Enter do cockpit NÃO confirmou o diálogo (/auto-mode-setup fora do history)');
  ok(!/Teach auto mode/.test(telaDepois), 'o diálogo não está mais na tela');
  ok(resposta?.menuFechado === true, 'a resposta do envio avisa que um menu foi fechado com Esc (menuFechado)');

  // Nada de assistente aberto para trás: Esc até sair (o mundo é de mentira, mas não custa).
  for (let i = 0; i < 3; i += 1) { t(['send-keys', '-t', 'main:repro', 'Escape'], { tolerante: true }); await espera(300); }

  console.log(falhas ? `\n🔴 ${falhas} verificação(ões) falharam — o defeito está aqui.` : '\n🟢 a mensagem chegou e o diálogo não foi confirmado.');
  process.exit(falhas ? 1 : 0);
}

principal().catch((e) => { console.error('🔴 erro do repro:', e); process.exit(1); });
