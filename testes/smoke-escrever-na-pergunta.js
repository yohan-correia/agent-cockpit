#!/usr/bin/env node
'use strict';
// SMOKE DO GESTO "SAIR DO MENU E FALAR" — com TUI de verdade.
//
// Card `escrever-texto-na-pergunta-aberta`, Fase 8 do plano. O que ele prova, e que NENHUM
// gate consegue provar: os fatos são da **TUI**, não do nosso código.
//
//   F1 (spec §2): com menu aberto, o texto colado é DESCARTADO pela TUI — não navega o menu
//       e não fica no composer. É por isso que o gesto manda `Esc` ANTES de colar. Se algum
//       dia uma CLI passar a bufferizar a colagem, este smoke continua verde e o desenho
//       fica desnecessário — mas nunca errado.
//   O dano que o gesto existe para evitar: uma opção do menu escolhida por ninguém.
//
// Três casos, do mais barato ao mais caro:
//   1. Claude + `/model`       — menu da própria TUI, zero token
//   2. Claude + composer LIVRE — o caminho de 99% do uso, e a prova da Fase 4 (bracketed
//                                paste passou a valer para o Claude: muda o byte de TODO envio)
//   3. Claude + AskUserQuestion — o menu que o card cita, e o único com desfecho próprio
//                                ("User declined to answer questions"). Custa dois turnos.
//
//   4. Codex + `/model`       — a TUI do Codex, com o ramo do `estadoDoMenu` que só ela tem
//                                (`classificarTela` sobre `capture-pane`, mecanismo COMPLETAMENTE
//                                diferente da leitura de arquivo do Claude). O painel de execução
//                                derrubou a versão anterior deste smoke, que cortava o Codex
//                                alegando que o gate já o cobria: gate cobre a LÓGICA com dublê;
//                                só a TUI real prova a integração captura → Escape → repintura.
//
// ── Fail-closed, na ordem (o mesmo do smoke-abas-tmux.js, e a ordem é o que faz valer) ──
//   1. COCKPIT_TMUX_SOCKET herdado que não case `^cockpit-smoke-` ABORTA — `cockpit` é o
//      socket do cockpit de verdade, e uma pane sua não é nossa para escrever;
//   2. o nome é FABRICADO aqui, ignorando o ambiente;
//   3. recusa se o socket já existir.
//
// ⚠️ `HOME` NÃO é isolado, e é de propósito: o `claude` precisa do login do dono, e
// `estadoDoMenu` lê `~/.claude/sessions/<pid>.json` — com HOME falso o ramo Claude
// responderia `'nao-sei'` sempre e o smoke provaria o contrário do que quer. O que é
// isolado é `COCKPIT_LIDAS_DIR` (armadilha #78: sem ele o smoke escreve no
// `~/.cockpit/lidas.json` DE PRODUÇÃO) e `COCKPIT_JOBS_DIR`.
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

let falhas = 0;
let feitos = 0;
const ok = (c, t) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── (1) e (2): o socket ─────────────────────────────────────────────────────
const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — este smoke só trabalha em `
    + 'socket próprio (^cockpit-smoke-). Abortando antes de tocar em qualquer coisa.');
  process.exit(1);
}
const SOCKET = `cockpit-smoke-pergunta-${process.pid}`;
const PORTA = 7896;   // 7899 é dos jobs, 7879 é produção, 7893/7894 são gates

function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

// (3) o socket não pode existir
if (t(['list-sessions'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} já existe. Abortando.`);
  process.exit(1);
}

const BIN = '/usr/bin/claude';
if (!fs.existsSync(BIN)) {
  console.error(`⚠️  não há claude em ${BIN} — ambiente indisponível.`);
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-pergunta-'));
const LIDAS = path.join(TMP, 'lidas');            // #78: NUNCA o ~/.cockpit de produção
fs.mkdirSync(LIDAS, { recursive: true });
const CWD_AGENTE = path.join(TMP, 'projeto');
fs.mkdirSync(CWD_AGENTE, { recursive: true });
fs.writeFileSync(path.join(CWD_AGENTE, 'leiame.txt'), 'pasta de smoke\n');

const servidores = [];

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (corpo) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers }, (res) => {
      let dados = '';
      res.on('data', (d) => { dados += d; });
      res.on('end', () => {
        let json = {};
        try { json = dados ? JSON.parse(dados) : {}; } catch { json = { cru: dados }; }
        resolve({ status: res.statusCode, corpo: json });
      });
    });
    req.on('error', reject);
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

const tela = () => t(['capture-pane', '-p', '-t', 'smoke'], { tolerante: true });

/** O `status` que o CLI publica — a mesma fonte que `estadoDoMenu` usa no ramo Claude. */
function statusDoCli(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')).status || null;
  } catch { return null; }
}

/**
 * A mensagem chegou mesmo ao agente? A prova forte não é a tela nem o `busy` — é o texto
 * gravado no `.jsonl` da conversa, que é o que o CLI relê. `status: "busy"` sozinho aceita
 * "o turno anterior retomou depois do Esc", que é justamente o cenário que o painel de
 * execução apontou como buraco.
 */
function estaNoJsonl(sessaoId, trecho) {
  const raiz = path.join(os.homedir(), '.claude', 'projects');
  let pastas = [];
  try { pastas = fs.readdirSync(raiz); } catch { return false; }
  for (const pasta of pastas) {
    const arq = path.join(raiz, pasta, `${sessaoId}.jsonl`);
    try {
      if (fs.readFileSync(arq, 'utf8').includes(trecho)) return true;
    } catch { /* não é esta pasta */ }
  }
  return false;
}

/** O `sessionId` que o CLI publica — o nome do `.jsonl` daquela conversa. */
function sessaoDoCli(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')).sessionId || null;
  } catch { return null; }
}

/** Espera uma condição virar verdadeira. Devolve false no estouro — quem chama decide. */
async function ate(fn, prazoMs, passo = 300) {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) {
    if (await fn()) return true;
    await espera(passo);
  }
  return false;
}

async function principal() {
  // ── A TUI ──────────────────────────────────────────────────────────────────
  t(['new-session', '-d', '-s', 'smoke', '-c', CWD_AGENTE, '-x', '120', '-y', '40', BIN]);
  const panePid = t(['list-panes', '-t', 'smoke', '-F', '#{pane_pid}']).trim();

  // O prompt de confiança de pasta nova: "No, exit" vem selecionado, então Down + Enter.
  if (!await ate(() => /trust this folder|Quick safety check/i.test(tela()), 30000)) {
    console.error('⚠️  o claude não chegou ao prompt de confiança em 30 s.');
    return 2;
  }
  t(['send-keys', '-t', 'smoke', 'Down']);
  await espera(400);
  t(['send-keys', '-t', 'smoke', 'Enter']);

  // Daqui em diante o CLI publica `sessions/<pid>.json`. O pid do agente é filho do da pane.
  //
  // O `claude` pode ser o PRÓPRIO processo da pane (é o caso aqui: ele é o comando da sessão)
  // ou um filho do shell (é o caso das abas do dono). Os dois casos são tentados, nessa
  // ordem — e `pgrep -P` **sai com 1 quando não há filho nenhum**, então ele vai dentro de
  // try/catch: sem isso o smoke morre com "Command failed" antes do primeiro assert.
  let agentePid = null;
  const candidatos = () => {
    const lista = [panePid];
    try {
      lista.push(...execFileSync('pgrep', ['-P', panePid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').map((s) => s.trim()).filter(Boolean));
    } catch { /* sem filhos: o próprio panePid é o candidato */ }
    return lista;
  };
  const subiu = await ate(() => {
    for (const c of candidatos()) if (statusDoCli(c)) { agentePid = c; return true; }
    return false;
  }, 40000);
  if (!subiu) {
    console.error('⚠️  o CLI não publicou sessions/<pid>.json em 40 s.');
    return 2;
  }
  ok(statusDoCli(agentePid) === 'idle', `o agente subiu e está ocioso (pid ${agentePid})`);

  // ── O servidor ─────────────────────────────────────────────────────────────
  const filho = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      COCKPIT_CERT_DIR: '/dev/null',            // sem isto o smoke colhe 301 sem explicação (#19)
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: 'smoke',
      COCKPIT_LIDAS_DIR: LIDAS,                 // #78 — nunca o ~/.cockpit de produção
      COCKPIT_JOBS_DIR: path.join(TMP, 'sem-jobs'),
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_MONITOR_MS: '0', // o amostrador do monitor escreve desde o boot (#82)
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  servidores.push(filho);
  let erroDoFilho = '';
  filho.stderr.on('data', (b) => { erroDoFilho += b; });
  const noAr = await ate(() => pedir('GET', '/health').then((r) => r.status === 200, () => false), 15000);
  if (!noAr) {
    console.error(`⚠️  servidor não respondeu /health: ${erroDoFilho.trim().split('\n').slice(-3).join(' | ')}`);
    return 2;
  }

  const listar = async () => (await pedir('GET', '/api/abas')).corpo;
  const minhaAba = async () => {
    const r = await listar();
    const abas = Array.isArray(r) ? r : (r.abas || []);
    return abas.find((a) => a.agentePid === Number(agentePid) || String(a.agentePid) === String(agentePid)) || abas[0];
  };

  const aba = await minhaAba();
  if (!aba) { console.error('⚠️  o cockpit não enxergou a aba do smoke.'); return 2; }
  ok(Boolean(aba.chave), `o cockpit enxerga a aba (chave ${aba.chave})`);

  // ── CASO 1 — Claude + /model (menu da própria TUI, zero token) ─────────────
  console.log('\n── Caso 1: menu /model ──');
  t(['send-keys', '-t', 'smoke', '-l', '--', '/model']);
  await espera(600);
  t(['send-keys', '-t', 'smoke', 'Enter']);
  if (!await ate(() => statusDoCli(agentePid) === 'waiting', 10000)) {
    console.error('⚠️  o /model não abriu (status nunca virou waiting).');
    return 2;
  }
  const modeloAntes = (tela().match(/^\s*❯?\s*\d\.\s*(.+?)\s{2,}/m) || [])[1] || '';
  ok(/Select model/i.test(tela()), 'o menu /model está aberto na TUI');

  const TEXTO_1 = 'escrevendo com o menu aberto';
  const r1 = await pedir('POST', `/api/abas/${aba.chave}/turnos`, { texto: TEXTO_1 });
  ok(r1.status === 202 || r1.status === 200, `o envio foi aceito (HTTP ${r1.status})`);
  await ate(() => statusDoCli(agentePid) !== 'waiting', 8000);
  const depois1 = tela();
  ok(!/Select model/i.test(depois1), 'o menu FECHOU — o Esc do gesto saiu e funcionou');
  const modeloDepois = (depois1.match(/Set model to|Kept model as/) || [])[0] || '';
  ok(!/Set model to/.test(depois1), 'NENHUMA opção do menu foi escolhida (o dano que o gesto evita)');
  // A prova de que a mensagem chegou ao AGENTE, não só ao composer: o texto sai do composer
  // (o Enter do gesto o submeteu) e aparece como fala na conversa.
  // A prova de que a mensagem foi ENVIADA (e não só colada) é o CLI ter começado a
  // trabalhar: `status: "busy"`. Não se prova isso pela tela — o `❯` do Claude prefixa o
  // composer E a fala já enviada no histórico, que é a mesma ambiguidade que derrubou cinco
  // réguas na D57. A fonte é a que o projeto já confia: o arquivo que o CLI publica.
  const sessao = sessaoDoCli(agentePid);
  const chegou1 = await ate(() => estaNoJsonl(sessao, TEXTO_1), 40000);
  ok(chegou1, 'a mensagem foi ENTREGUE ao agente — está no .jsonl da conversa, não só na tela');
  ok(tela().includes(TEXTO_1), 'e o texto do usuário está na tela');
  if (modeloAntes) ok(!modeloDepois.startsWith('Set model'), `o modelo não mudou (era "${modeloAntes.trim()}")`);

  // ── CASO 2 — composer LIVRE: o caminho de 99% do uso (prova da Fase 4) ─────
  console.log('\n── Caso 2: composer livre, sem pergunta (bracketed paste no Claude) ──');
  await ate(() => statusDoCli(agentePid) === 'idle', 60000);
  const TEXTO_2 = 'primeira linha com acento ção\nsegunda linha do mesmo envio';
  const r2 = await pedir('POST', `/api/abas/${aba.chave}/turnos`, { texto: TEXTO_2 });
  ok(r2.status === 202 || r2.status === 200, `envio normal aceito (HTTP ${r2.status})`);
  const chegou2 = await ate(() => estaNoJsonl(sessao, 'segunda linha do mesmo envio')
    && estaNoJsonl(sessao, 'acento ção'), 40000);
  ok(chegou2, 'as DUAS linhas foram ENTREGUES íntegras, com acento (conferido no .jsonl) — '
    + 'o delimitador não partiu nem comeu nada');
  ok(!/200~|201~/.test(tela()), 'os delimitadores do bracketed paste não vazaram como texto');

  // ── CASO 3 — AskUserQuestion: o menu que o card cita ───────────────────────
  console.log('\n── Caso 3: AskUserQuestion (o menu do card) ──');
  await ate(() => statusDoCli(agentePid) === 'idle', 120000);
  const r3 = await pedir('POST', `/api/abas/${aba.chave}/turnos`, {
    texto: 'Use a ferramenta AskUserQuestion agora para me perguntar qual a minha cor favorita, '
      + 'com as opcoes vermelho e azul. Nao faca mais nada.',
  });
  ok(r3.status === 202 || r3.status === 200, `pedido da pergunta aceito (HTTP ${r3.status})`);
  const abriu = await ate(() => statusDoCli(agentePid) === 'waiting' && /cor favorita/i.test(tela()), 90000);
  if (!abriu) {
    // Não passa por omissão: a pergunta é o estado que este caso existe para testar.
    ok(false, 'a pergunta do AskUserQuestion NÃO abriu — caso inconclusivo, e inconclusivo não é aprovado');
  } else {
    ok(true, 'o AskUserQuestion abriu, com as opções na tela');
    const TEXTO_3 = 'na verdade prefiro verde';
    const r4 = await pedir('POST', `/api/abas/${aba.chave}/turnos`, { texto: TEXTO_3 });
    ok(r4.status === 202 || r4.status === 200, `o envio com a pergunta aberta foi aceito (HTTP ${r4.status})`);
    const respondeu = await ate(() => /declined to answer|User declined/i.test(tela()), 20000);
    ok(respondeu, 'a pergunta foi CANCELADA pelo Esc do gesto (User declined), não respondida por uma opção');
    ok(!/Vermelho.*selecionad|selected/i.test(tela()), 'nem Vermelho nem Azul foram escolhidos por ninguém');
    const chegou3 = await ate(() => estaNoJsonl(sessaoDoCli(agentePid), TEXTO_3), 60000);
    ok(chegou3, 'e o texto do usuário foi ENTREGUE ao agente logo depois (está no .jsonl)');
    ok(tela().includes(TEXTO_3), 'com o texto dele na tela');
  }

  // ── CASO 4 — Codex + /model: o outro ramo de `estadoDoMenu` ───────────────
  console.log('\n── Caso 4: Codex + /model (o ramo que lê a TELA, não o arquivo) ──');
  if (!fs.existsSync('/usr/bin/codex')) {
    console.log('  ⚠️  não há codex em /usr/bin/codex — caso pulado (e dito, não escondido)');
  } else {
    const CWD_CODEX = path.join(TMP, 'projeto-codex');
    fs.mkdirSync(CWD_CODEX, { recursive: true });
    t(['new-window', '-t', 'smoke', '-c', CWD_CODEX, '-n', 'codex', '/usr/bin/codex']);
    const telaCodex = () => t(['capture-pane', '-p', '-t', 'smoke:codex'], { tolerante: true });
    // Os dois prompts de abertura do Codex: update disponível (nem sempre) e confiança.
    await ate(() => /Update available|trust the contents/i.test(telaCodex()), 30000);
    if (/Update available/i.test(telaCodex())) {
      t(['send-keys', '-t', 'smoke:codex', 'Down']); await espera(400);
      t(['send-keys', '-t', 'smoke:codex', 'Enter']); await espera(2000);
    }
    if (await ate(() => /trust the contents/i.test(telaCodex()), 20000)) {
      t(['send-keys', '-t', 'smoke:codex', 'Enter']);
    }
    const subiuCodex = await ate(() => /Ask Codex to do anything/i.test(telaCodex()), 40000);
    if (!subiuCodex) {
      ok(false, 'o Codex não chegou ao composer — caso inconclusivo, e inconclusivo não é aprovado');
    } else {
      // SAIR DO `preSessao` PRIMEIRO. Codex recém-subido não tem rollout, então
      // `preSessao: true` — e ali o gesto NÃO vale por desenho (o Esc fecharia o agente,
      // spec §3). Medido na primeira rodada deste caso: o envio voltava 409 "o agente desta
      // aba está pedindo uma confirmação no terminal", e a recusa estava CERTA; o teste é
      // que exercitava o estado errado. Uma conversa trivial publica o rollout e o
      // `preSessao` cai.
      t(['send-keys', '-t', 'smoke:codex', '-l', '--', 'responda apenas: ok']);
      await espera(600);
      t(['send-keys', '-t', 'smoke:codex', 'Enter']);
      const saiuDaPreSessao = await ate(async () => {
        const r = (await pedir('GET', '/api/abas')).corpo;
        const lista = Array.isArray(r) ? r : (r.abas || []);
        const c = lista.find((x) => x.agente === 'codex');
        return Boolean(c && c.preSessao === false);
      }, 90000);
      ok(saiuDaPreSessao, 'o Codex publicou o rollout e saiu do preSessao (o gesto só vale depois disso)');

      t(['send-keys', '-t', 'smoke:codex', '-l', '--', '/model']);
      await espera(800);
      t(['send-keys', '-t', 'smoke:codex', 'Enter']);
      const menuCodexAberto = await ate(() => /Select Model/i.test(telaCodex()), 15000);
      ok(menuCodexAberto, 'o menu /model do Codex está aberto na TUI');
      const diag = (await pedir('GET', '/api/abas')).corpo;
      const listaD = Array.isArray(diag) ? diag : (diag.abas || []);
      const cd = listaD.find((x) => x.agente === 'codex');
      if (cd) console.log(`  · aba do Codex: esperando=${cd.esperando} preSessao=${cd.preSessao} temAgente=${cd.temAgente} sessaoId=${cd.sessaoId}`);
      const abaCodex = await ate(async () => {
        const r = (await pedir('GET', '/api/abas')).corpo;
        const lista = Array.isArray(r) ? r : (r.abas || []);
        const c = lista.find((x) => x.agente === 'codex');
        return Boolean(c && c.esperando);
      }, 20000);
      ok(abaCodex, 'o cockpit classificou a tela do Codex como pergunta aberta (régua de menu-codex)');
      const r5 = (await pedir('GET', '/api/abas')).corpo;
      const listaC = Array.isArray(r5) ? r5 : (r5.abas || []);
      const cx = listaC.find((x) => x.agente === 'codex');
      if (cx) {
        const TEXTO_4 = 'escrevendo no codex com o menu aberto';
        const r6 = await pedir('POST', `/api/abas/${cx.chave}/turnos`, { texto: TEXTO_4 });
        ok(r6.status === 202 || r6.status === 200,
          `o envio no Codex foi aceito (HTTP ${r6.status}${r6.status >= 400 ? ' — ' + (r6.corpo.erro || '?') : ''})`);
        const fechouCodex = await ate(() => !/Select Model/i.test(telaCodex()), 15000);
        ok(fechouCodex, 'o menu do Codex FECHOU — o Esc do gesto saiu e funcionou no outro ramo');
        ok(!/Selected model|switched to/i.test(telaCodex()), 'nenhum modelo do Codex foi trocado por ninguém');
        const noComposer = await ate(() => telaCodex().includes(TEXTO_4), 20000);
        ok(noComposer, 'e o texto do usuário chegou à TUI do Codex');
      }
    }
  }

  return falhas === 0 ? 0 : 1;
}

let saida = 1;
principal()
  .then((c) => { saida = c; })
  .catch((e) => { console.error('🔴 erro no smoke:', e.message); saida = 1; })
  .finally(() => {
    for (const s of servidores) { try { s.kill('SIGTERM'); } catch { /* já morreu */ } }
    // O socket é NOSSO (fabricado no topo, recusado se já existia): derrubá-lo é seguro.
    try { t(['kill-server'], { tolerante: true }); } catch { /* já caiu */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* deixa para o /tmp */ }
    // Zero asserção NÃO é verde — é inconclusivo, e inconclusivo não é aprovado. Sem esta
    // linha o smoke que morre antes do primeiro `ok()` imprime "SMOKE VERDE — 0/0" e mente.
    const veredito = feitos === 0 ? '⚠️  SMOKE INCONCLUSIVO (nenhuma asserção rodou)'
      : (falhas === 0 && saida === 0 ? '✅ SMOKE VERDE' : '❌ SMOKE VERMELHO');
    console.log(`\n${veredito} — ${feitos - falhas}/${feitos} asserções`);
    process.exit(saida);
  });
