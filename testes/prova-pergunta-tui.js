#!/usr/bin/env node
'use strict';
// PROVA PONTA A PONTA NA TUI REAL — a pergunta do agente em cartão (D74).
//
// ESTE SCRIPT GASTA TOKEN: ele abre um `claude --model sonnet` de verdade e pede três vezes que
// ele use a ferramenta AskUserQuestion. Por isso fica FORA do `npm test` (família #20 — o que gasta
// assinatura roda à mão, uma vez, com o dono sabendo). Quem o roda é o orquestrador (Fase 6 do plano).
//
// O que ele prova — e nenhum gate offline consegue: que as teclas que o cockpit digita DE VERDADE
// numa TUI do Claude Code real viram a resposta CERTA. O veredito de cada rodada é a linha
// `tool_result` do `.jsonl` da sessão: `toolUseResult.answers` com a opção E o texto esperados, e
// sem `is_error` (o "User declined" do Esc seria o falso verde que esta prova existe para barrar).
//
//   A — 2 perguntas (Audio simples; Aviso LGPD multi), pelo NAVEGADOR: clica a opção 2 da Audio,
//       escreve na Outra resposta da LGPD, PNG em 1600x1000 e 390x844, clica "Enviar respostas".
//   B — 1 pergunta simples, por HTTP (`POST …/pergunta`, opção de índice 1).
//   C — 2 perguntas (multi sem texto + simples última com texto), por HTTP.
//
// O arreio (cada peça existe por um motivo medido, spec §7 e R10):
//   - tmux num socket PRÓPRIO (`-L cockpit-smoke-prova-<pid> -f /dev/null`). Antes de abrir o claude,
//     300 janelas são criadas e mortas: os ids da janela/pane do claude passam de @300/%300. O
//     `sessions/<pid>.json` do CLI guarda a chave `@janela.%pane`, e um id baixo poderia casar com
//     uma pane REAL do servidor tmux padrão (@102/%105 em produção) e enganar o cockpit. O script
//     aborta se o servidor padrão já passou de 250.
//   - o hook vai no `.claude/settings.json` DO PROJETO de teste (`${SCRATCH}/demo`), nunca no
//     `~/.claude/settings.json` real, com `COCKPIT_PERGUNTAS_DIR` apontando para o scratch.
//   - servidor de prova: `spawn` do server.js desta worktree (nunca `require`), HOME falso cujo
//     `.claude` é um LINK para o real (o V3 do hook compara por realpath), `HOST=127.0.0.1`,
//     porta alta, `COCKPIT_CERT_DIR` vazia, e TODAS as pastas de estado dentro do scratch.
//
// Uso: SCRATCH=/tmp/d6aa/prova SAIDA=<pasta dos PNGs> [PORT=7959] node testes/prova-pergunta-tui.js
//   SCRATCH tem de estar vazio (ou não existir). Nada é apagado dele no fim: o caminho é impresso.
// Nunca 7879 (produção), 7897, 7899 (jobs) nem 7912.
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SCRATCH = process.env.SCRATCH ? path.resolve(process.env.SCRATCH) : '';
const SAIDA = process.env.SAIDA ? path.resolve(process.env.SAIDA) : '';
if (!SCRATCH || !SAIDA) {
  console.error('🔴 defina SCRATCH=<pasta vazia, ex. /tmp/d6aa/prova> e SAIDA=<pasta dos PNGs>');
  process.exit(2);
}
// O caminho vai dentro do comando do hook (roda por shell): só caracteres sem significado para ele.
if (!/^[A-Za-z0-9._/-]+$/.test(SCRATCH)) {
  console.error(`🔴 SCRATCH "${SCRATCH}" tem caractere fora de [A-Za-z0-9._/-] — o comando do hook rodaria por shell.`);
  process.exit(2);
}
const PORTA = Number(process.env.PORT) || 7959;
if ([7879, 7897, 7899, 7912].includes(PORTA)) {
  console.error(`🔴 a porta ${PORTA} é de produção ou dos jobs — recuso.`);
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const RAIZ = path.resolve(__dirname, '..');
const GANCHO = path.join(RAIZ, 'bin', 'gancho-pergunta.js');
const HOME_REAL = os.homedir();

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-prova-${process.pid}`;
const SESSAO = 'prova';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);

// O claude desta prova tem de ser um claude NOVO, não um filho do que está rodando este script:
// as variáveis de sessão do Claude Code e do tmux de quem chamou não podem vazar para a pane.
const ENV_LIMPO = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_') && k !== 'TMUX' && k !== 'TMUX_PANE'));

function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV_LIMPO });
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
async function ate(fn, prazoMs, passo = 300) {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) { if (await fn()) return true; await espera(passo); }
  return false;
}

function pedir(metodo, rota, corpo) {
  return new Promise((resolve) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const cabecalhos = dados === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) };
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers: cabecalhos, timeout: 90000, agent: false }, (res) => {
      let texto = '';
      res.on('data', (d) => { texto += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(texto); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (dados !== null) req.write(dados);
    req.end();
  });
}

// ─── Os três pedidos (o texto das rodadas B e C vem das medições; a A é a do cartão de 2 perguntas) ───

const PEDIDO_A = 'Use a ferramenta AskUserQuestion AGORA, sem fazer mais nada antes, com 2 perguntas: '
  + '(1) header "Audio", pergunta "Qual formato de audio salvar no desenho que vamos montar para o cliente, '
  + 'considerando o espaco em disco e a qualidade final?", multiSelect false, 3 opcoes com descricao longa cada; '
  + '(2) header "Aviso LGPD", pergunta "Quais avisos mostrar na tela de consentimento?", multiSelect true, '
  + '3 opcoes com descricao. Depois de receber a resposta, apenas repita as respostas literalmente.';
const PEDIDO_B = 'Use a ferramenta AskUserQuestion AGORA, sem fazer mais nada antes, com 1 pergunta: '
  + 'header "Cor", pergunta "Qual cor?", multiSelect false, opcoes Azul e Verde com descricao curta. '
  + 'Depois de receber a resposta, apenas repita a resposta literalmente.';
const PEDIDO_C = 'Use a ferramenta AskUserQuestion AGORA, sem fazer mais nada antes, com 2 perguntas: '
  + '(1) header "Frutas", pergunta "Quais frutas?", multiSelect true, opcoes Uva, Pera, Kiwi com descricao curta; '
  + '(2) header "Bebida", pergunta "Qual bebida?", multiSelect false, opcoes Agua e Suco com descricao curta. '
  + 'Depois de receber a resposta, apenas repita as respostas literalmente.';
const TEXTO_A = 'Aviso de gravacao, com letra grande';
const TEXTO_C = 'suco de limao, sem acucar';

// ─── O roteiro do navegador da rodada A — roda DENTRO do container ───────────

const ROTEIRO = `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const TEXTO_A = ${JSON.stringify(TEXTO_A)};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const problemas = [];
  const medidas = {};

  const nova = async (largura, altura, celular) => {
    const p = await navegador.newPage();
    await p.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* modo privado */ } });
    await p.setViewport(celular
      ? { width: largura, height: altura, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { width: largura, height: altura });
    await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await p.waitForSelector('#abas', { timeout: 15000 });
    await espera(700);
    const abriu = await p.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('#abas .conversa-linha'));
      const linha = linhas.find((l) => {
        const t2 = l.querySelector('.conversa-titulo');
        return t2 && t2.textContent.includes('demo');
      });
      const botao = linha && linha.querySelector('.conversa');
      if (!botao) return false;
      botao.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    });
    if (!abriu) problemas.push('não achei a aba "demo" na lista');
    const cartao = await p.waitForFunction(() => {
      const el = document.querySelector('.painel:not([hidden]) .pergunta-cartao');
      return Boolean(el) && !el.hidden && el.querySelectorAll('.cartao-questao').length === 2;
    }, { timeout: 30000 }).then(() => true, () => false);
    if (!cartao) problemas.push('o cartão de 2 perguntas não apareceu (' + largura + 'px)');
    return p;
  };

  /** Opção 2 da Audio + texto na Outra resposta da LGPD. */
  const preencher = async (p) => {
    const questoes = await p.$$('.painel:not([hidden]) .cartao-questao');
    if (questoes.length !== 2) return;
    const opcoes = await questoes[0].$$('.cartao-opcao');
    await opcoes[1].click();
    const campos = await p.$$('.painel:not([hidden]) .cartao-outra-campo');
    await campos[1].type(TEXTO_A);
    await espera(300);
  };

  const noInicioDoCartao = (p) => p.evaluate(() => {
    const raiz = document.querySelector('.painel:not([hidden])');
    const m = raiz.querySelector('.mensagens');
    m.style.scrollBehavior = 'auto';
    const alvo = raiz.querySelector('.pergunta-cartao:not([hidden])');
    if (alvo) m.scrollTop += alvo.getBoundingClientRect().top - m.getBoundingClientRect().top - 8;
  });

  const estado = (p) => p.evaluate(() => {
    const raiz = document.querySelector('.painel:not([hidden])');
    return {
      pressionadas: raiz.querySelectorAll('.cartao-opcao[aria-pressed="true"]').length,
      campos: Array.from(raiz.querySelectorAll('.cartao-outra-campo')).map((c) => c.value),
      enviarHabilitado: (() => { const b = raiz.querySelector('.cartao-enviar'); return b ? !b.disabled : null; })(),
    };
  });

  try {
    const grande = await nova(1600, 1000, false);
    await preencher(grande);
    await noInicioDoCartao(grande);
    await espera(400);
    medidas.antesDeEnviar = await estado(grande);
    await grande.screenshot({ path: '/out/prova-A-cartao-1600.png' });

    // O 390x844 é um SEGUNDO carregamento, ainda antes de enviar: o cartão preenchido no celular.
    const celular = await nova(390, 844, true);
    await preencher(celular);
    await noInicioDoCartao(celular);
    await espera(400);
    medidas.celular = await estado(celular);
    await celular.screenshot({ path: '/out/prova-A-cartao-390.png' });
    await celular.close();

    if (medidas.antesDeEnviar.pressionadas < 1) problemas.push('1600: nenhuma opção marcada');
    if (medidas.antesDeEnviar.campos[1] !== TEXTO_A) problemas.push('1600: a Outra resposta não tem o texto');
    if (medidas.antesDeEnviar.enviarHabilitado !== true) problemas.push('1600: o Enviar deveria estar habilitado com as duas respondidas');

    // Enviar: o servidor digita na TUI real conferindo cada passo (até 30 s). Depois do 200 o evento
    // esperando:false fecha o bloco — então "enviado" vale pelo texto OU pelo bloco fechado.
    await grande.evaluate(() => document.querySelector('.painel:not([hidden]) .cartao-enviar').click());
    const desfecho = await grande.waitForFunction(() => {
      const raiz = document.querySelector('.painel:not([hidden])');
      const erro = raiz.querySelector('.cartao-erro');
      const aviso = raiz.querySelector('.cartao-aviso');
      const pergunta = raiz.querySelector('.pergunta');
      if (erro && !erro.hidden && erro.textContent) return { tipo: 'erro', texto: erro.textContent };
      if (aviso && /enviadas/i.test(aviso.textContent)) return { tipo: 'enviado' };
      if (pergunta && pergunta.hidden) return { tipo: 'fechou' };
      return false;
    }, { timeout: 90000 }).then((h) => h.jsonValue(), () => ({ tipo: 'nada' }));
    medidas.desfecho = desfecho;
    if (desfecho.tipo === 'erro') problemas.push('o Enviar voltou erro: ' + desfecho.texto);
    if (desfecho.tipo === 'nada') problemas.push('o Enviar não terminou em 90 s');
    await grande.close();
  } catch (e) {
    problemas.push('o roteiro estourou: ' + String(e && e.message).slice(0, 300));
  }

  await navegador.close();
  console.log('@@MEDIDAS-PROVA@@' + JSON.stringify({ medidas, problemas }));
  process.exit(problemas.length ? 1 : 0);
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e);
  process.exit(1);
});
`;

// ─── Corrida ──────────────────────────────────────────────────────────────

(async () => {
  let saida = 1;
  let servidor = null;
  let pane = null;          // "%NNN" — onde o claude está
  let agentePid = null;
  const elos = [];          // links que EU criei (o `.claude` do HOME falso): removidos no fim

  const tela = () => (pane ? t(['capture-pane', '-p', '-t', pane], { tolerante: true }) : '');
  const sessaoDoCli = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(HOME_REAL, '.claude', 'sessions', `${agentePid}.json`), 'utf8'));
    } catch { return null; }
  };
  const statusDoCli = () => (sessaoDoCli() || {}).status || null;
  const escreverNaPane = async (texto) => {
    t(['send-keys', '-t', pane, '-l', '--', texto]);
    await espera(400);
    t(['send-keys', '-t', pane, 'Enter']);
  };

  function limpar() {
    let falhouLimpeza = false;
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor de prova (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
    // D35: o carimbo prova que EU criei o socket; a enumeração prova que não há mais ninguém nele.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean);
    const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      falhouLimpeza = true;
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else if (sessoesAgora.length) {
      falhouLimpeza = true;
      falhas += 1;
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    // Só o LINK, nunca o conteúdo: o `.claude` do HOME falso aponta para o `~/.claude` REAL.
    for (const elo of elos) { try { fs.unlinkSync(elo); } catch { /* já saiu */ } }
    return !falhouLimpeza;
  }

  /** A linha `tool_result` do `toolUseId` no `.jsonl` da sessão (o veredito de cada rodada). */
  function lerToolResult(toolUseId) {
    const sessao = sessaoDoCli();
    if (!sessao) return null;
    const arquivo = path.join(HOME_REAL, '.claude', 'projects', String(sessao.cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${sessao.sessionId}.jsonl`);
    let texto = '';
    try { texto = fs.readFileSync(arquivo, 'utf8'); } catch { return null; }
    for (const linha of texto.split('\n')) {
      if (!linha.includes(toolUseId) || !linha.includes('tool_result')) continue;
      try {
        const obj = JSON.parse(linha);
        const conteudo = Array.isArray(obj.message && obj.message.content) ? obj.message.content : [];
        const item = conteudo.find((c) => c && c.type === 'tool_result' && c.tool_use_id === toolUseId);
        if (item) return { linha, item, resultado: obj.toolUseResult };
      } catch { /* linha cortada no fim: o próximo tique lê inteira */ }
    }
    return null;
  }

  /** Confere o `tool_result` de uma rodada: sem is_error, com `answers` e com o esperado dentro. */
  async function conferirRodada(nome, toolUseId, esperados) {
    const achou = await ate(() => lerToolResult(toolUseId) !== null, 60000, 500);
    ok(achou, `${nome}: o .jsonl ganhou a linha tool_result do ${toolUseId}`);
    if (!achou) return false;
    const { linha, item, resultado } = lerToolResult(toolUseId);
    console.log(`  · ${nome} — tool_result: ${linha.length > 1500 ? `${linha.slice(0, 1500)}…` : linha}`);
    const respostas = resultado && typeof resultado.answers === 'object' ? JSON.stringify(resultado.answers) : '';
    let bom = ok(item.is_error !== true, `${nome}: o tool_result NÃO é is_error (não é o "User declined")`);
    bom = ok(Boolean(respostas), `${nome}: toolUseResult.answers existe`) && bom;
    for (const esperado of esperados) {
      bom = ok(respostas.includes(JSON.stringify(esperado).slice(1, -1)), `${nome}: as respostas contêm "${esperado}"`) && bom;
    }
    return bom;
  }

  /** Pede a pergunta ao claude e espera o cartão chegar na API (o `waiting` vem do CLI). */
  async function abrirPergunta(nome, pedido, chave, nPerguntas) {
    // Sem `idle` a rodada NÃO segue: o pedido digitado num menu ainda aberto vira tecla dele (o dígito
    // do texto marca opção) e contamina a rodada seguinte — medido em 08/10.
    if (!ok(await ate(() => statusDoCli() === 'idle', 120000, 500), `${nome}: o claude está idle antes do pedido`)) {
      console.log(`--- pane (rodada ${nome} pulada) ---\n${tela()}\n--- fim ---`);
      return null;
    }
    await escreverNaPane(pedido);
    const esperou = await ate(() => statusDoCli() === 'waiting', 180000, 500);
    ok(esperou, `${nome}: o claude abriu a pergunta (status waiting)`);
    let cartao = null;
    if (esperou) {
      await ate(async () => {
        const r = await pedir('GET', `/api/abas/${chave}/tela`);
        cartao = r.json && r.json.cartao;
        return Boolean(cartao);
      }, 30000, 500);
    }
    ok(Boolean(cartao) && cartao.perguntas.length === nPerguntas,
      `${nome}: GET …/tela devolveu o cartão de ${nPerguntas} pergunta(s) (hook + tela conferida)`);
    if (!cartao) console.log(`--- pane ---\n${tela()}\n--- fim ---`);
    return cartao;
  }

  /** Depois de responder: a tela da pane e a espera do claude voltar ao idle (o "Teach auto mode" sai com Esc). */
  async function aposRodada(nome) {
    await ate(() => statusDoCli() !== 'waiting', 60000, 500);
    console.log(`--- pane depois de ${nome} ---\n${tela()}\n--- fim ---`);
    let escapes = 0;
    ok(await ate(async () => {
      const s = statusDoCli();
      if (s === 'idle') return true;
      // Um menu que abre DEPOIS do envio (spec §3.1: "Teach auto mode") não é pergunta do cartão.
      if (s === 'waiting' && /auto mode/i.test(tela()) && escapes < 2) {
        escapes += 1;
        t(['send-keys', '-t', pane, 'Escape']);
        await espera(800);
      }
      return false;
    }, 180000, 700), `${nome}: o claude voltou ao idle`);
  }

  try {
    // ── pré-condições ──
    let claude = '';
    try { claude = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim(); } catch { claude = ''; }
    if (!claude) { console.error('🟡 ambiente indisponível: não há `claude` no PATH.'); return process.exit(2); }
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      return process.exit(2);
    }
    if (!fs.existsSync(GANCHO)) { console.error(`🟡 falta ${GANCHO}`); return process.exit(2); }
    if (fs.existsSync(SCRATCH) && fs.readdirSync(SCRATCH).length) {
      console.error(`🔴 SCRATCH ${SCRATCH} não está vazio — use uma pasta nova. A prova recusa misturar.`);
      return process.exit(2);
    }
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. A prova recusa sobrescrever.`);
      return process.exit(2);
    }

    // R10: o servidor tmux PADRÃO não pode ter ids altos demais — os do claude de teste vão passar de 300.
    let maiorPadrao = 0;
    try {
      const saidaPadrao = execFileSync('tmux', ['list-panes', '-a', '-F', '#{window_id} #{pane_id}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: ENV_LIMPO });
      for (const m of saidaPadrao.matchAll(/[@%](\d+)/g)) maiorPadrao = Math.max(maiorPadrao, Number(m[1]));
    } catch { /* sem servidor padrão no ar: nada a conferir */ }
    if (maiorPadrao > 250) {
      console.error(`🔴 o servidor tmux padrão já está em @/%${maiorPadrao} (> 250): os ids de teste (> 300) poderiam colidir. Abortando.`);
      return process.exit(2);
    }
    console.log(`  · servidor tmux padrão: maior id ${maiorPadrao} (limite 250)`);

    // ── a pasta de teste, com o hook no settings.json DO PROJETO ──
    const demo = path.join(SCRATCH, 'demo');
    const dirPerguntas = path.join(SCRATCH, 'perguntas');
    const home = path.join(SCRATCH, 'home');
    fs.mkdirSync(path.join(demo, '.claude'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(SCRATCH, 'cert-vazio'), { recursive: true });
    fs.writeFileSync(path.join(demo, 'leiame.txt'), 'pasta da prova da pergunta em cartao\n');
    const comandoDoGancho = `COCKPIT_PERGUNTAS_DIR=${dirPerguntas} ${process.execPath} ${GANCHO} 2>/dev/null || true`;
    const objetoDoGancho = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: comandoDoGancho, timeout: 5 }] };
    fs.writeFileSync(path.join(demo, '.claude', 'settings.json'),
      `${JSON.stringify({ hooks: { PreToolUse: [objetoDoGancho], PostToolUse: [objetoDoGancho] } }, null, 2)}\n`);
    // HOME falso: tudo que o servidor grava cai no scratch; só o `.claude` é o REAL (leitura de sessions/projects).
    const elo = path.join(home, '.claude');
    fs.symlinkSync(path.join(HOME_REAL, '.claude'), elo);
    elos.push(elo);

    // ── tmux próprio, com os ids empurrados para cima de @300/%300 ──
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '3600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'semente', '-x', '140', '-y', '50', '-c', os.tmpdir(), 'sleep', '3600']);
    for (let i = 0; i < 300; i += 1) {
      const id = t(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${SESSAO}:`, '-n', 'x', '-c', os.tmpdir(), 'sleep', '60']).trim();
      t(['kill-window', '-t', id]);
    }
    const nasceu = t(['new-window', '-d', '-P', '-F', '#{window_id} #{pane_id} #{pane_pid}', '-t', `${SESSAO}:`, '-n', 'demo', '-c', demo,
      `${claude} --model sonnet`]).trim().split(' ');
    const [janelaId, paneId, panePid] = nasceu;
    pane = paneId;
    const idsAltos = Number(janelaId.slice(1)) > 300 && Number(paneId.slice(1)) > 300;
    if (!ok(idsAltos, `os ids do claude de teste passam de 300 (janela ${janelaId}, pane ${paneId})`)) {
      limpar();
      return process.exit(1);
    }

    // ── confiança da pasta e sessão publicada ──
    let confirmou = false;
    const subiu = await ate(() => {
      const atual = tela();
      if (!confirmou && /trust this folder|Quick safety check/i.test(atual)) {
        confirmou = true;
        t(['send-keys', '-t', pane, 'Down']);
        setTimeout(() => t(['send-keys', '-t', pane, 'Enter'], { tolerante: true }), 400);
      }
      const candidatos = [panePid];
      try {
        candidatos.push(...execFileSync('pgrep', ['-P', panePid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
          .split('\n').map((s) => s.trim()).filter(Boolean));
      } catch { /* sem filhos */ }
      for (const c of candidatos) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(HOME_REAL, '.claude', 'sessions', `${c}.json`), 'utf8'));
          if (s.status === 'idle' && s.sessionId) { agentePid = c; return true; }
        } catch { /* ainda não publicou */ }
      }
      return false;
    }, 90000, 500);
    if (!ok(subiu, 'o claude subiu e publicou sessions/<pid>.json (idle)')) {
      console.log(`--- pane ---\n${tela()}\n--- fim ---`);
      limpar();
      return process.exit(2);
    }

    // ── o servidor de prova ──
    const ambiente = { ...ENV_LIMPO };
    delete ambiente.COCKPIT_TOKEN;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      // Sem `TMUX` no ambiente (o ENV_LIMPO tira) e sem locale (o job não tem), o CLIENTE tmux troca o
      // TAB do `-F` do `listar()` por `_` e a lista volta vazia — medido em 08/10, mesmo fato da D67.
      LC_ALL: 'C.UTF-8',
      COCKPIT_CERT_DIR: path.join(SCRATCH, 'cert-vazio'),
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PERGUNTAS_DIR: dirPerguntas,
      COCKPIT_JOBS_DIR: path.join(SCRATCH, 'sem-jobs'), // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
      COCKPIT_LIDAS_DIR: path.join(SCRATCH, 'lidas'),
      COCKPIT_LEITURAS_DIR: path.join(SCRATCH, 'leituras'),
      COCKPIT_MONITOR_DIR: path.join(SCRATCH, 'monitor'),
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PUSH_DIR: path.join(SCRATCH, 'push'),
      COCKPIT_BIN_CLAUDE: claude,
    });
    servidor = spawn(process.execPath, [path.join(RAIZ, 'server.js')], { env: ambiente, stdio: ['ignore', 'ignore', 'pipe'] });
    let erroDoServidor = '';
    servidor.stderr.on('data', (d) => { erroDoServidor += d; if (erroDoServidor.length > 65536) erroDoServidor = erroDoServidor.slice(-32768); });
    const noAr = await ate(async () => servidor.exitCode === null && (await pedir('GET', '/health')).status === 200, 15000, 200);
    if (!ok(noAr, `o servidor de prova subiu em http://127.0.0.1:${PORTA} (pid ${servidor.pid})`)) {
      console.error(erroDoServidor.trim().split('\n').slice(-5).join('\n'));
      limpar();
      return process.exit(1);
    }

    let chave = null;
    let ultimaLista = null;
    // Pelo agente e pela sessão, não pelo título: com `-f /dev/null` o `automatic-rename` do tmux
    // troca o nome da janela pelo do programa que roda nela. O socket é só desta prova, então a
    // única aba com claude e sessão é a nossa.
    const viu = await ate(async () => {
      const lista = (await pedir('GET', '/api/abas')).json;
      const todas = Array.isArray(lista) ? lista : ((lista && lista.abas) || []);
      ultimaLista = todas;
      const aba = todas.find((a) => a.agente === 'claude' && a.sessaoId);
      if (aba) chave = aba.chave;
      return Boolean(aba);
    }, 30000, 500);
    if (!ok(viu, 'o cockpit enxerga a aba de teste com o claude e a sessão')) {
      console.error(`  · /api/abas devolveu: ${JSON.stringify(ultimaLista)}`);
    }
    if (!chave) { limpar(); return process.exit(1); }

    // ── A — 2 perguntas, pelo NAVEGADOR ──
    console.log('\nRodada A — 2 perguntas (Audio simples, Aviso LGPD multi), pelo navegador');
    const cartaoA = await abrirPergunta('A', PEDIDO_A, chave, 2);
    if (cartaoA) {
      fs.writeFileSync(path.join(SCRATCH, 'roteiro.js'), ROTEIRO);
      const docker = spawn('docker', [
        'run', '--rm', '--network', 'host', '--entrypoint', 'node',
        '-e', `BASE=http://127.0.0.1:${PORTA}`,
        '-v', `${SCRATCH}:/w:ro`,
        '-v', `${SAIDA}:/out`,
        IMAGEM, '/w/roteiro.js',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let saidaDocker = '';
      docker.stdout.on('data', (d) => { saidaDocker += d; });
      docker.stderr.on('data', (d) => { saidaDocker += d; });
      const codigo = await new Promise((r) => docker.on('close', r));
      const MARCADOR = '@@MEDIDAS-PROVA@@';
      const abre = saidaDocker.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) { try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; } }
      if (!relatorio) console.log(saidaDocker);
      else console.log(`  · medidas do navegador: ${JSON.stringify(relatorio.medidas)}`);
      const problemas = relatorio ? relatorio.problemas : [`o roteiro não devolveu JSON (código ${codigo})`];
      ok(problemas.length === 0, problemas.length ? `A: o navegador reprovou: ${problemas.join(' · ')}` : 'A: o navegador marcou, escreveu e clicou "Enviar respostas"');
      for (const png of ['prova-A-cartao-1600.png', 'prova-A-cartao-390.png']) {
        const arquivo = path.join(SAIDA, png);
        ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
      }
      await conferirRodada('A', cartaoA.toolUseId, [cartaoA.perguntas[0].opcoes[1].rotulo, TEXTO_A]);
      await aposRodada('A');
    }

    // ── B — 1 pergunta simples, por HTTP ──
    console.log('\nRodada B — 1 pergunta simples (opção de índice 1), por HTTP');
    const cartaoB = await abrirPergunta('B', PEDIDO_B, chave, 1);
    if (cartaoB) {
      const r = await pedir('POST', `/api/abas/${chave}/pergunta`, { toolUseId: cartaoB.toolUseId, respostas: [{ opcoes: [1], texto: '' }] });
      ok(r.status === 200 && r.json && r.json.respondido === true, `B: POST …/pergunta ⇒ 200 { respondido: true } (achei ${r.status} ${JSON.stringify(r.json)})`);
      await conferirRodada('B', cartaoB.toolUseId, [cartaoB.perguntas[0].opcoes[1].rotulo]);
      await aposRodada('B');
    }

    // ── C — multi sem texto + simples última com texto, por HTTP ──
    console.log('\nRodada C — multi (opções 0 e 2, sem texto) + simples última com texto, por HTTP');
    const cartaoC = await abrirPergunta('C', PEDIDO_C, chave, 2);
    if (cartaoC) {
      const r = await pedir('POST', `/api/abas/${chave}/pergunta`, {
        toolUseId: cartaoC.toolUseId,
        respostas: [{ opcoes: [0, 2], texto: '' }, { opcoes: [], texto: TEXTO_C }],
      });
      ok(r.status === 200 && r.json && r.json.respondido === true, `C: POST …/pergunta ⇒ 200 { respondido: true } (achei ${r.status} ${JSON.stringify(r.json)})`);
      await conferirRodada('C', cartaoC.toolUseId,
        [cartaoC.perguntas[0].opcoes[0].rotulo, cartaoC.perguntas[0].opcoes[2].rotulo, TEXTO_C]);
      await aposRodada('C');
    }

    saida = falhas ? 1 : 0;
  } catch (e) {
    console.error('\n🔴 a prova estourou:', e && e.stack || e);
    if (pane) console.log(`--- pane ---\n${tela()}\n--- fim ---`);
    saida = 1;
  } finally {
    // Fim: /exit no claude (ele apaga o próprio sessions/<pid>.json), depois o que é meu.
    if (pane && agentePid) {
      t(['send-keys', '-t', pane, '-l', '--', '/exit'], { tolerante: true });
      await espera(400);
      t(['send-keys', '-t', pane, 'Enter'], { tolerante: true });
      await espera(3000);
    }
    const limpezaOk = limpar();
    if (!limpezaOk) saida = saida || 1;
    // As sobras: a conversa do claude de teste mora no `~/.claude/projects` REAL, sob o slug do scratch.
    const sobras = path.join(HOME_REAL, '.claude', 'projects', path.join(SCRATCH, 'demo').replace(/[^a-zA-Z0-9]/g, '-'));
    let lista = [];
    try { lista = fs.readdirSync(sobras); } catch { lista = []; }
    console.log(`\nSobras da prova (para apagar à mão, com o "vai" do dono):`);
    console.log(`  · ${SCRATCH}`);
    console.log(`  · ${sobras}${lista.length ? ` (${lista.length} arquivo(s))` : ' (não existe)'}`);
    console.log(`\n${falhas || saida ? '❌ PROVA NA TUI REAL VERMELHA' : '✅ PROVA NA TUI REAL VERDE'} — ${feitos - falhas}/${feitos} · PNGs em ${SAIDA}\n`);
  }
  process.exit(saida);
})();
