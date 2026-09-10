#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR DA BOLHA DE ERRO DO CODEX — Chromium de verdade, 390×844, tema escuro,
// num ambiente FABRICADO: socket tmux próprio, `/proc` de mentira e uma raiz de rollouts só
// com as fixtures daqui. Nada toca o tmux `main` do usuário nem o `~/.codex/` dele.
//
// Por que fabricado: o rollout que registrou o erro de 02/09 não casa com pane viva nenhuma —
// o Codex daquela aba morreu. E um smoke que dependesse da conta OpenAI estourar não seria
// smoke. As costuras são as MESMAS do `testes/gate-codex.js`: `COCKPIT_PROC_RAIZ`,
// `COCKPIT_CODEX_RAIZ`, `COCKPIT_TMUX_SOCKET`, `COCKPIT_TMUX_SESSAO`.
//
// Duas abas, uma por resultado que a spec nomeia (§ vocabulário):
//   `projeto-a` — turno SEM AgentMessage antes do erro  ⇒ "bolha própria"
//   `projeto-d`    — turno COM AgentMessage antes do erro  ⇒ "parágrafo na fala"
//
// Sem dependência npm. Pré-requisitos de máquina (tmux, docker, a imagem com o Chromium) são
// conferidos antes de qualquer coisa: faltando ⇒ exit 2 (PULADO, nunca verde).
//
// Códigos de saída: 0 = verde · 1 = reprovou (assert de DOM/API ou socket estranho) · 2 = pulado.
//
// Variáveis: PORT (7897) · IMAGEM (cockpit-smoke:latest) · SAIDA (./.smoke-erro-codex-shots)
//            ROLLOUT=<caminho> — substitui o rollout da aba `projeto-a` por uma cópia de um
//            arquivo REAL (o `session_meta.cwd` é reescrito para a pasta da aba; mtime preservado).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');

const RAIZ_DO_REPO = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 7897);
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const SAIDA = path.resolve(process.env.SAIDA || path.join(process.cwd(), '.smoke-erro-codex-shots'));
const ROLLOUT = process.env.ROLLOUT || '';
const SESSAO = 'erro-codex';
const PREFIXO_SOCKET = /^cockpit-erro-codex-\d+$/;

const { PREFIXO_DO_ERRO } = require('../lib/adaptador-codex');
const PREFIXO_VISIVEL = PREFIXO_DO_ERRO.trim();   // o que o `<p>` mostra: sem as quebras da frente

const USAGE_LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), "
  + 'visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:58 AM.';
const HORA_DO_ERRO = '2026-09-03T00:25:27.385Z';
const HORA_DO_ERRO_2 = '2026-09-03T00:25:28.000Z';
const NASCIMENTO = '2026-09-03T00:25:07.000Z';
const PROC_START = new Date('2026-09-03T00:20:00.000Z');

const pular = (motivo) => { console.error(`\n⚠ SMOKE PULADO — ${motivo}\n`); process.exit(2); };
const rodaSaindoZero = (bin, args) => {
  try { execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 }); return true; } catch { return false; }
};

// ─── Pré-requisitos ──────────────────────────────────────────────────────────
if (!rodaSaindoZero('tmux', ['-V'])) pular('não há tmux nesta máquina');
if (!rodaSaindoZero('docker', ['image', 'inspect', IMAGEM])) pular(`a imagem ${IMAGEM} não existe (IMAGEM=… para outra)`);
// O rollout REAL é opcional; pedido e ausente é PULADO, não vermelho — o usuário pode ter limpado
// o `~/.codex/sessions/`. A prova sintética (sem ROLLOUT) continua valendo por si.
if (ROLLOUT && !fs.existsSync(ROLLOUT)) pular(`ROLLOUT aponta para um arquivo que não existe: ${ROLLOUT}`);

// ─── Fail-closed do socket (contrato da spec §3.4) ───────────────────────────
const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !PREFIXO_SOCKET.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — este smoke só trabalha em socket próprio. Abortando.`);
  process.exit(1);
}
// O nome é SEMPRE fabricado aqui; o herdado, mesmo válido, é ignorado.
const SOCKET = `cockpit-erro-codex-${process.pid}`;
const t = (args, { tolerante = false } = {}) => {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { if (tolerante) return ''; throw e; }
};
if (t(['ls'], { tolerante: true }).trim()) { console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`); process.exit(1); }

// ─── Fixtures ────────────────────────────────────────────────────────────────
const temporarios = [];
const mk = (prefixo) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefixo)); temporarios.push(d); return d; };

const ev = (timestamp, payload) => JSON.stringify({ timestamp, type: 'event_msg', payload });
const item = (timestamp, it) => ev(timestamp, { type: 'item_completed', item: it });
const completo = (timestamp, extra) => ev(timestamp, {
  type: 'task_complete', turn_id: 'T1', last_agent_message: null,
  started_at: 1788395125, completed_at: 1788395127, duration_ms: 1404, ...extra,
});
const meta = (id, cwd) => JSON.stringify({
  timestamp: NASCIMENTO, type: 'session_meta',
  payload: { session_id: id, id, timestamp: NASCIMENTO, cwd, originator: 'codex-tui', cli_version: '0.152.1', source: 'cli' },
});
const tokenCount = (timestamp) => ev(timestamp, {
  type: 'token_count',
  info: { last_token_usage: { input_tokens: 13859 }, model_context_window: 258400 },
});

const ABAS = [
  {
    nome: 'projeto-a', pidFalso: 999999, id: '01a064a7-b2c5-7092-b437-f8b66db05976',
    esperadoAtualizadoEm: Date.parse(HORA_DO_ERRO),
    corpo: (cwd) => [
      meta('01a064a7-b2c5-7092-b437-f8b66db05976', cwd),
      ev('2026-09-03T00:25:25.000Z', { type: 'task_started', turn_id: 'T1' }),
      item('2026-09-03T00:25:25.500Z', { id: 'u1', type: 'UserMessage', content: [{ type: 'text', text: 'Teste' }] }),
      tokenCount('2026-09-03T00:25:27.000Z'),
      completo(HORA_DO_ERRO, { error: { message: USAGE_LIMIT, codex_error_info: 'usage_limit_exceeded' } }),
    ],
  },
  {
    nome: 'projeto-d', pidFalso: 999998, id: '01a064a7-0000-7000-8000-000000000002',
    esperadoAtualizadoEm: Date.parse(HORA_DO_ERRO_2),
    corpo: (cwd) => [
      meta('01a064a7-0000-7000-8000-000000000002', cwd),
      ev('2026-09-03T00:25:25.000Z', { type: 'task_started', turn_id: 'T1' }),
      item('2026-09-03T00:25:25.500Z', { id: 'u1', type: 'UserMessage', content: [{ type: 'text', text: 'Teste' }] }),
      item('2026-09-03T00:25:26.000Z', { id: 'a1', type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'text', text: 'Recebido.' }] }),
      tokenCount('2026-09-03T00:25:27.000Z'),
      completo(HORA_DO_ERRO_2, { last_agent_message: 'Recebido.', error: { message: 'rede caiu' } }),
    ],
  },
];

/** A árvore `/proc` de mentira — cópia fiel do `arvoreProc` do gate-codex.js (52 campos). */
function plantarProcesso(raiz, pid, p) {
  const dir = path.join(raiz, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = `(${p.comm ?? 'proc'})`;
  campos[2] = p.estado ?? 'S';
  campos[3] = String(p.ppid ?? 1);
  campos[4] = String(p.pgrp ?? pid);          // campo 5
  campos[5] = String(p.sessao ?? pid);
  campos[6] = '34816';
  campos[7] = String(p.tpgid ?? -1);          // campo 8
  campos[21] = String(p.starttime ?? 1000);   // campo 22
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), `${(p.argv || ['proc']).join('\0')}\0`);
  if (p.cwd) fs.symlinkSync(p.cwd, path.join(dir, 'cwd'));
  const tarefa = path.join(dir, 'task', String(pid));
  fs.mkdirSync(tarefa, { recursive: true });
  fs.writeFileSync(path.join(tarefa, 'children'), `${(p.filhos || []).join(' ')}${p.filhos?.length ? ' ' : ''}`);
  if (p.nascidoEm) fs.utimesSync(dir, p.nascidoEm, p.nascidoEm);
}

const feitos = [];
const problemas = [];
let servidor = null;

async function portaLivre(porta) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(porta, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
const pedir = (caminho) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: caminho }, (res) => {
    let corpo = '';
    res.on('data', (c) => { corpo += c; });
    res.on('end', () => resolve({ status: res.statusCode, corpo }));
  }).on('error', reject);
});
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function derrubarServidor() {
  if (!servidor || servidor.exitCode !== null) return;
  const saiu = new Promise((r) => servidor.once('exit', r));
  servidor.kill('SIGTERM');
  const veredito = await Promise.race([saiu.then(() => 'saiu'), espera(5000).then(() => 'travou')]);
  if (veredito === 'travou') { servidor.kill('SIGKILL'); await saiu; }
}

function limpar() {
  // Só o socket FABRICADO, e só se a sessão dele existir. Nunca o padrão (#2).
  try {
    execFileSync('tmux', ['-L', SOCKET, 'has-session', '-t', `${SESSAO}:`], { stdio: 'ignore' });
    execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
  } catch { /* nunca subiu, ou já caiu */ }
  // O `kill-server` derruba o servidor mas pode deixar o ARQUIVO do socket em `/tmp/tmux-<uid>/`
  // (medido em 03/09: três arquivos mortos depois de três rodadas). Só se apaga o arquivo do
  // socket FABRICADO aqui, e só depois de confirmar que não há servidor nele.
  if (!t(['ls'], { tolerante: true }).trim()) {
    const arquivoDoSocket = path.join(process.env.TMUX_TMPDIR || os.tmpdir(), `tmux-${process.getuid()}`, SOCKET);
    fs.rmSync(arquivoDoSocket, { force: true });
  }
  for (const d of temporarios) fs.rmSync(d, { recursive: true, force: true });
}

(async () => {
  try {
    if (!(await portaLivre(PORT))) pular(`a porta ${PORT} está ocupada (PORT=… para outra)`);
    fs.mkdirSync(SAIDA, { recursive: true });

    const procRaiz = mk('erro-codex-proc-');
    const codexRaiz = mk('erro-codex-rollouts-');
    const certVazio = mk('erro-codex-cert-');
    const dia = path.join(codexRaiz, '2026', '09', '03');
    fs.mkdirSync(dia, { recursive: true });

    // 1. o tmux próprio: uma janela por aba, cada uma rodando `sleep` na pasta dela.
    for (const [i, aba] of ABAS.entries()) {
      aba.cwd = mk(`erro-codex-${aba.nome}-`);
      if (i === 0) t(['new-session', '-d', '-s', SESSAO, '-n', aba.nome, '-c', aba.cwd, 'sleep 3600']);
      else t(['new-window', '-t', `${SESSAO}:`, '-n', aba.nome, '-c', aba.cwd, 'sleep 3600']);
    }
    const panes = t(['list-panes', '-s', '-t', `${SESSAO}:`, '-F', '#{window_name}\t#{pane_pid}']).trim().split('\n');
    for (const linha of panes) {
      const [nome, pid] = linha.split('\t');
      const aba = ABAS.find((a) => a.nome === nome);
      if (aba) aba.panePid = Number(pid);
    }
    if (ABAS.some((a) => !a.panePid)) throw new Error(`não achei o pane_pid de alguma aba: ${JSON.stringify(panes)}`);

    // 2. o /proc de mentira: o `sleep` da pane com o codex fictício em foreground.
    for (const aba of ABAS) {
      plantarProcesso(procRaiz, aba.panePid, { comm: 'sleep', argv: ['sleep', '3600'], pgrp: aba.panePid, tpgid: aba.pidFalso, filhos: [aba.pidFalso] });
      plantarProcesso(procRaiz, aba.pidFalso, {
        comm: 'codex', argv: ['/usr/bin/codex', '--yolo'], ppid: aba.panePid, pgrp: aba.pidFalso, tpgid: aba.pidFalso,
        cwd: aba.cwd, filhos: [], nascidoEm: PROC_START,
      });
    }

    // 3. os rollouts — sintéticos, ou o REAL no lugar do da `projeto-a`.
    for (const aba of ABAS) {
      const arquivo = path.join(dia, `rollout-2026-09-03T00-25-07-${aba.id}.jsonl`);
      if (ROLLOUT && aba.nome === 'projeto-a') {
        const info = fs.statSync(ROLLOUT);
        const linhas = fs.readFileSync(ROLLOUT, 'utf8').split('\n');
        const primeira = JSON.parse(linhas[0]);
        primeira.payload.cwd = aba.cwd;           // o casamento compara com o cwd da pane fabricada
        linhas[0] = JSON.stringify(primeira);
        fs.writeFileSync(arquivo, linhas.join('\n'));
        fs.utimesSync(arquivo, info.atime, info.mtime);
        console.log(`  · aba projeto-a usa o rollout REAL: ${ROLLOUT}`);
      } else {
        fs.writeFileSync(arquivo, `${aba.corpo(aba.cwd).join('\n')}\n`);
      }
    }

    // 4. o servidor, sem TLS, só com as raízes fabricadas.
    servidor = spawn(process.execPath, ['server.js'], {
      cwd: RAIZ_DO_REPO,
      env: {
        ...process.env, PORT: String(PORT), COCKPIT_HOST: '127.0.0.1', COCKPIT_CERT_DIR: certVazio, COCKPIT_TOKEN: '',
        COCKPIT_TMUX_SOCKET: SOCKET, COCKPIT_TMUX_SESSAO: SESSAO, COCKPIT_PROC_RAIZ: procRaiz, COCKPIT_CODEX_RAIZ: codexRaiz,
        COCKPIT_JOBS_DIR: path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logDoServidor = '';
    servidor.stdout.on('data', (c) => { logDoServidor += c; });
    servidor.stderr.on('data', (c) => { logDoServidor += c; });
    let pronto = false;
    for (let i = 0; i < 20 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      try { await pedir('/'); pronto = true; } catch { await espera(500); }
    }
    if (!pronto) throw new Error(`o servidor não subiu em 10 s na ${PORT}:\n${logDoServidor.slice(-600)}`);

    // 5. a prova do lado do servidor, ANTES do navegador (spec §3.4 passo 4).
    const lista = JSON.parse((await pedir('/api/abas')).corpo);
    const doCodex = (lista.abas || []).filter((a) => a.agente === 'codex');
    const okApi = (c, txt) => { (c ? feitos : problemas).push(`api: ${txt}`); return c; };
    okApi(doCodex.length === 2, `exatamente 2 abas de Codex na lista (${doCodex.length}) — ${JSON.stringify(doCodex).slice(0, 300)}`);
    for (const aba of ABAS) {
      const daLista = doCodex.find((a) => a.titulo === aba.nome);
      if (!okApi(Boolean(daLista), `a aba ${aba.nome} está na lista`)) continue;
      okApi(daLista.casamento === 'ok', `${aba.nome}: casamento ok (${daLista.casamento})`);
      okApi(daLista.rodando === false, `${aba.nome}: rodando false — o busy/idle não regrediu (${daLista.rodando})`);
      okApi(daLista.atualizadoEm === aba.esperadoAtualizadoEm,
        `${aba.nome}: atualizadoEm é a hora do ERRO (${daLista.atualizadoEm} vs ${aba.esperadoAtualizadoEm}) — horaDaUltimaMensagem viu a bolha`);
    }
    if (problemas.length) throw new Error('a API já reprovou — não vale fotografar');

    // 6. o navegador, no container.
    const roteiro = fs.mkdtempSync(path.join(os.tmpdir(), 'erro-codex-roteiro-'));
    temporarios.push(roteiro);
    const mjs = path.join(roteiro, 's.mjs');
    fs.writeFileSync(mjs, ROTEIRO_MJS);
    const args = [
      'run', '--rm', '--entrypoint', 'node', '--network', 'host',
      '-e', `BASE=http://127.0.0.1:${PORT}`, '-e', `PREFIXO_VISIVEL=${PREFIXO_VISIVEL}`,
      '-v', `${mjs}:/s.mjs:ro`, '-v', `${SAIDA}:/saida`, IMAGEM, '/s.mjs',
    ];
    let saida = '';
    let codigo = 0;
    try {
      saida = execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    } catch (e) { codigo = e.status ?? 1; saida = `${e.stdout || ''}${e.stderr || ''}`; }
    process.stdout.write(saida);
    if (codigo !== 0) problemas.push(`o navegador reprovou (exit ${codigo})`);
  } catch (e) {
    problemas.push(`o smoke estourou — ${String(e && e.message).slice(0, 800)}`);
  } finally {
    await derrubarServidor();
    limpar();
    const livre = await portaLivre(PORT);
    (livre ? feitos : problemas).push(`porta ${PORT} ${livre ? 'livre' : 'AINDA OCUPADA'} depois do teardown`);
    // A prova do teardown do tmux sai DAQUI, porque só o script sabe o nome que fabricou.
    const sobrou = t(['ls'], { tolerante: true }).trim();
    (sobrou ? problemas : feitos).push(`socket ${SOCKET} ${sobrou ? 'AINDA TEM SESSÃO: ' + sobrou : 'derrubado'}`);
  }

  for (const f of feitos) console.log(`  ✅ ${f}`);
  for (const p of problemas) console.error(`  ❌ ${p}`);
  if (problemas.length) {
    console.error(`\n🔴 smoke da bolha de erro: ${problemas.length} problema(s) — os PNGs NÃO valem como prova.`);
    process.exit(1);
  }
  console.log(`\n✅ smoke da bolha de erro: verde. PNGs em ${SAIDA}`);
  process.exit(0);
})();

// ─── O roteiro que roda DENTRO do container ──────────────────────────────────
// Import por caminho ABSOLUTO: por nome, o resolver procuraria `node_modules` relativo ao `/`.
const ROTEIRO_MJS = String.raw`
import puppeteer from '/app/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const BASE = process.env.BASE;
const PREFIXO_VISIVEL = process.env.PREFIXO_VISIVEL;
const problemas = [];
const feitos = [];
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const navegador = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

const CELULAR = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** rota → ação → ASSERT de DOM → foto. O olho humano vem depois do assert. */
async function roteiro(nome, { acao, assert, arg }) {
  const pagina = await navegador.newPage();
  try {
    await pagina.setViewport(CELULAR);
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await pagina.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
    await espera(1500);
    if (acao) await acao(pagina);
    await espera(1500);
    const veredito = await pagina.evaluate(assert, arg);
    if (!veredito.ok) { problemas.push(nome + ': ' + veredito.porque); return; }
    await pagina.screenshot({ path: '/saida/' + nome + '.png', fullPage: false });
    feitos.push(nome + ' — ' + veredito.porque);
  } catch (e) {
    problemas.push(nome + ': o roteiro estourou — ' + String(e && e.message).slice(0, 200));
  } finally {
    await pagina.close().catch(() => {});
  }
}

/** Clica na linha da lista cujo título é exatamente \`titulo\`. */
const abrir = (titulo) => async (pagina) => {
  const achou = await pagina.evaluate((alvo) => {
    const linhas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa'));
    // O nome mora em .conversa-nome (app.js, nome.className = 'conversa-nome'), irmão do
    // pino e do chip do agente dentro de .conversa-titulo. Até 09/09 este smoke lia os NÓS
    // DE TEXTO soltos do título, e isso parou de achar qualquer coisa quando o nome ganhou o
    // próprio <span>: sobraram só espaços em branco. O fallback nos nós de texto fica para o
    // caso de o <span> sumir de novo — a busca falha alto, não silenciosa.
    const nomeDe = (b) => {
      const proprio = b.querySelector('.conversa-nome');
      if (proprio) return (proprio.textContent || '').trim();
      return Array.from(b.querySelector('.conversa-titulo')?.childNodes || [])
        .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    };
    const linha = linhas.find((b) => nomeDe(b) === alvo);
    if (linha) linha.click();
    return Boolean(linha);
  }, titulo);
  if (!achou) throw new Error('não há linha com título "' + titulo + '" na lista');
  await espera(2500);
};

// 01 — a lista: duas linhas de Codex, as duas "te esperando". Presença — a CAUSA (hora do
// erro) foi provada pela API antes do navegador.
await roteiro('01-lista-te-esperando', {
  assert: () => {
    const linhas = Array.from(document.querySelectorAll('#abas .conversa-grupo[data-cwd] .conversa-linha'))
      .filter((l) => (l.querySelector('.conversa-agente')?.textContent || '').trim() === 'codex');
    if (linhas.length !== 2) return { ok: false, porque: linhas.length + ' linha(s) de Codex na lista, esperava 2' };
    for (const l of linhas) {
      const pino = (l.querySelector('.conversa-pino')?.textContent || '').trim();
      const estado = (l.querySelector('.conversa-estado')?.textContent || '').trim();
      if (pino !== '◆') return { ok: false, porque: 'pino "' + pino + '" em vez de ◆' };
      if (!/te esperando/.test(estado)) return { ok: false, porque: 'estado "' + estado + '" em vez de "te esperando"' };
    }
    return { ok: true, porque: 'as duas linhas de Codex com ◆ e "te esperando"' };
  },
});

// 02 — a BOLHA PRÓPRIA: turno sem AgentMessage. Uma fala, um parágrafo, começando por ⚠️.
await roteiro('02-celular-bolha-propria', {
  acao: abrir('projeto-a'),
  arg: PREFIXO_VISIVEL,
  assert: (prefixo) => {
    const eu = Array.from(document.querySelectorAll('.painel .fita .bolha-eu')).map((b) => b.textContent.trim());
    if (!eu.includes('Teste')) return { ok: false, porque: 'a bolha "Teste" do humano não está na fita (' + JSON.stringify(eu) + ')' };
    const falas = Array.from(document.querySelectorAll('.painel .fita .fala'));
    if (falas.length !== 1) return { ok: false, porque: falas.length + ' fala(s) do agente, esperava 1' };
    const ps = Array.from(falas[0].querySelectorAll('.fala-corpo p'));
    if (ps.length !== 1) return { ok: false, porque: ps.length + ' parágrafo(s) na fala, esperava 1' };
    const texto = ps[0].textContent.trim();
    if (!texto.startsWith(prefixo)) return { ok: false, porque: 'o parágrafo não começa pelo prefixo: ' + JSON.stringify(texto.slice(0, 80)) };
    if (!/usage limit/.test(texto)) return { ok: false, porque: 'o parágrafo não traz "usage limit"' };
    const largura = document.documentElement.scrollWidth;
    if (largura > 400) return { ok: false, porque: 'a página vaza para a direita: scrollWidth ' + largura + 'px' };
    return { ok: true, porque: 'bolha própria com ' + JSON.stringify(texto.slice(0, 60)) + '…, sem vazar (' + largura + 'px)' };
  },
});

// 03 — o PARÁGRAFO NA FALA: turno com AgentMessage antes. Uma fala, DOIS parágrafos — é isto
// que prova no cliente de verdade que o "\n\n" do adaptador vira parágrafo, e não texto colado.
await roteiro('03-celular-paragrafo-na-fala', {
  acao: abrir('projeto-d'),
  arg: PREFIXO_VISIVEL,
  assert: (prefixo) => {
    const falas = Array.from(document.querySelectorAll('.painel .fita .fala'));
    if (falas.length !== 1) return { ok: false, porque: falas.length + ' fala(s) do agente, esperava 1' };
    const ps = Array.from(falas[0].querySelectorAll('.fala-corpo p')).map((p) => p.textContent.trim());
    if (ps.length !== 2) return { ok: false, porque: ps.length + ' parágrafo(s) na fala, esperava 2: ' + JSON.stringify(ps) };
    if (ps[0] !== 'Recebido.') return { ok: false, porque: 'o 1º parágrafo não é "Recebido.": ' + JSON.stringify(ps[0]) };
    if (!ps[1].startsWith(prefixo) || !/rede caiu/.test(ps[1])) return { ok: false, porque: 'o 2º parágrafo não é a bolha de erro: ' + JSON.stringify(ps[1]) };
    return { ok: true, porque: '"Recebido." e depois ' + JSON.stringify(ps[1].slice(0, 60)) + ' como dois parágrafos' };
  },
});

await navegador.close();
for (const f of feitos) console.log('  ✅ ' + f);
for (const p of problemas) console.error('  ❌ ' + p);
if (problemas.length) { console.error('\n🔴 ' + problemas.length + ' roteiro(s) reprovaram.'); process.exit(1); }
console.log('\n✅ ' + feitos.length + ' roteiros, todos com assert de DOM ANTES do obturador.');
`;
