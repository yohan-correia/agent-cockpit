#!/usr/bin/env node
'use strict';
// SMOKE DO FLUXO REAL DO CODEX — o único lugar onde envio, busy/idle, medidor e interrupção
// são provados contra um `codex` de verdade, num socket de tmux dedicado.
//
// 💸 CUSTO DECLARADO: DOIS TURNOS da assinatura OpenAI do usuário (plano Plus).
//    O passo 4 gasta um (uma palavra, para provar que `\r` submete) e o passo 7 gasta o
//    outro (um prompt longo, cortado no meio, para provar que a interrupção para um turno
//    EM ANDAMENTO). Interromper um turno já terminado não testa nada.
//
// Por que ele existe: `digitarNaAba()` não muda uma linha para o Codex — ele já manda
// `-l --`, espera 150 ms e manda `Enter`, tudo mirando `aba.pane`. O que falta é PROVA, não
// código: a armadilha #7 é sobre a TUI do *Claude*, e nada garante que a do Codex trate `\n`
// e `\r` do mesmo jeito.
//
// FAIL-CLOSED em quatro camadas, na mesma ordem do `smoke-abas-tmux.js`:
//
//   1. o valor HERDADO de COCKPIT_TMUX_SOCKET só passa com o prefixo `cockpit-codex-probe-`.
//      Vazio NÃO aborta: é o caso normal, e o passo 2 o preenche;
//   2. o nome é FABRICADO aqui — `cockpit-codex-probe-<pid>` —, ignorando o que veio de fora;
//   3. RECUSA se aquele socket já existir;
//   4. o script guarda o socket e a sessão que ELE MESMO criou, e o teardown só roda contra
//      esses dois valores guardados — nunca contra o que estiver na env na hora. E confere
//      `has-session` antes de matar.
//
// 🔴 O `codex --yolo` do usuário roda na pane %71 do socket PADRÃO. Nada aqui pode tocá-la:
//    todo comando leva `-L <socket de teste>`, e `kill-server` só acontece no socket próprio,
//    com a janela âncora carimbada provando a posse.
//
// Códigos de saída:  0 = verde · 1 = defeito · 2 = ambiente indisponível/pulado.
// A ÚLTIMA linha do stdout é o nome do socket — é o que o gate final lê para o `--teardown`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let falhas = 0;
let feitos = 0;
const ok = (c, t) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };

const MANTER = process.argv.includes('--manter');
const SEM_TURNO = process.env.SMOKE_CODEX_SEM_TURNO === '1';
const PREFIXO = /^cockpit-codex-probe-\d+$/;

// ─── Modo `--teardown <socket>`: só derruba, não testa nada ──────────────────
//
// Ele RECUSA um nome fora do prefixo e um socket sem sessão viva. É o que o `finally` do
// gate final chama, e é por isso que ele não pode aceitar qualquer string: um nome vazio ou
// torto viraria comando de tmux no socket PADRÃO, onde vivem as abas do usuário.
if (process.argv[2] === '--teardown') {
  const alvo = String(process.argv[3] || '');
  if (!PREFIXO.test(alvo)) {
    console.error(`🔴 --teardown recusado: "${alvo}" não é um socket deste smoke.`);
    process.exit(1);
  }
  const vivo = (() => {
    try {
      execFileSync('tmux', ['-L', alvo, 'has-session', '-t', 'probe:'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch { return false; }
  })();
  if (!vivo) {
    console.error(`🔴 --teardown recusado: o socket "${alvo}" não tem a sessão probe viva.`);
    process.exit(1);
  }
  try {
    execFileSync('tmux', ['-L', alvo, 'kill-server'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* já foi */ }
  console.log(`socket ${alvo} derrubado`);
  process.exit(0);
}

// ─── Os cinco pré-requisitos, conferidos ANTES de qualquer coisa ─────────────
//
// Faltando qualquer um, o smoke PULA com código 2 e o motivo vai no relatório. Pular NÃO é
// reprovar: só o código 1 (o passo rodou e falhou) barra a entrega. E o skip nunca sai 0 —
// um skip que saísse 0 ficaria indistinguível de um smoke que passou.
function pular(motivo) {
  console.error(`\n⚠ SMOKE DE CODEX PULADO — ${motivo}\n`);
  // Pular NÃO pode deixar lixo. Quando o skip acontece DEPOIS de a sessão e a casa nascerem
  // — o caso do prompt de atualização —, o `finally` nunca roda, e sem esta linha ficariam
  // um servidor de tmux e uma pasta em `~/.cache` a cada rodada do gate.
  try { limpar(); } catch { /* ainda não havia o que limpar: o skip veio nos pré-requisitos */ }
  console.log(`cockpit-codex-probe-${process.pid}`);
  process.exit(2);
}

const rodaSaindoZero = (bin, args) => {
  try {
    execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 });
    return true;
  } catch { return false; }
};

const BIN_CODEX = process.env.COCKPIT_BIN_CODEX || '/usr/bin/codex';
if (!rodaSaindoZero('tmux', ['-V'])) pular('não há tmux nesta máquina');
if (!rodaSaindoZero(BIN_CODEX, ['--version'])) pular(`\`${BIN_CODEX} --version\` não saiu 0`);
// Só `stat`, NUNCA `cat`: é credencial, e credencial não se lê nem se imprime.
if (!fs.statSync(path.join(os.homedir(), '.codex', 'auth.json'), { throwIfNoEntry: false })) {
  pular('não há ~/.codex/auth.json — o Codex não está logado nesta máquina');
}
// O `--yolo` do registro é alias OCULTO de `--dangerously-bypass-approvals-and-sandbox`.
// Como não aparece no `--help`, ele PODE sumir numa versão futura sem aviso — e aí a aba
// criada pelo cockpit nasceria morta. Afirmar que o BINÁRIO ACEITA AS FLAGS, e não só que
// ele existe, é o que transforma esse sumiço num vermelho em vez de num mistério.
const ARGS_DO_REGISTRO = require('../lib/agentes').de('codex').args;
if (!rodaSaindoZero(BIN_CODEX, [...ARGS_DO_REGISTRO, '--version'])) {
  pular(`\`${BIN_CODEX} ${ARGS_DO_REGISTRO.join(' ')} --version\` não saiu 0 — as flags do registro `
    + 'deixaram de ser aceitas (o `--yolo` é alias oculto e pode sumir sem aviso)');
}

// ─── Fail-closed do socket, na ordem ─────────────────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !PREFIXO.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — este smoke só trabalha em socket `
    + 'próprio (^cockpit-codex-probe-). Abortando antes de tocar em qualquer coisa.');
  process.exit(1);
}

const SOCKET = `cockpit-codex-probe-${process.pid}`;
const SESSAO = 'probe';
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

// ⚠️ O diretório temporário é o PIOR caso possível para o Codex, e é justamente por isso que
// ele está aqui: um `mkdtemp` nunca está na lista `trust_level` do `~/.codex/config.toml`,
// então o `codex` PURO abriria o menu de confiança antes de qualquer coisa. O `send-keys` do
// passo 3 iria para um menu em vez da caixa (#6/#25) e o smoke queimaria os 2 turnos sem
// provar nada. Com o `--yolo` do registro o menu não aparece — e isto é o que a produção faz.
//
// Suposição DECLARADA: que `--yolo` pula o prompt de confiança em pasta não-confiada é o
// comportamento pretendido da flag, e não foi verificado nesta máquina (verificar custaria um
// turno). Se o rollout não nascer em 60 s, a causa provável é o menu — e o passo 2 diz ISSO,
// não "o agente não subiu".
const TRABALHO = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-codex-probe-cwd-'));

// `CODEX_HOME` próprio: sem ele o smoke herda o `~/.codex/config.toml` do usuário inteiro,
// inclusive os SEIS `mcp_servers` remotos — e aí "o rollout nasce em < 30 s" passa a
// depender de rede de terceiros. Os 4,96 s medidos no R7 foram numa sessão quente, em projeto
// confiado. A casa mínima tem só o `auth.json`, por LINK (nunca cópia: credencial não se
// duplica no disco), e o `trust_level` da pasta de trabalho.
//
// E ela NÃO pode morar em `/tmp`: medido em 02/09, o Codex recusa criar os helper binaries
// sob diretório temporário —
//   "Refusing to create helper binaries under temporary dir /tmp"
// — e segue meio-quebrado. `~/.cache/` é do usuário, não é temporário para o CLI, e some no
// `finally` como qualquer fixture.
const RAIZ_DA_CASA = path.join(os.homedir(), '.cache');
fs.mkdirSync(RAIZ_DA_CASA, { recursive: true });
const CASA = fs.mkdtempSync(path.join(RAIZ_DA_CASA, 'cockpit-codex-probe-home-'));
fs.mkdirSync(path.join(CASA, 'sessions'), { recursive: true });
try {
  fs.symlinkSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(CASA, 'auth.json'));
} catch {
  pular('não deu para ligar o auth.json na casa mínima do smoke');
}
// 🔴 O SEGUNDO menu que trava a TUI antes de qualquer coisa, e ele NÃO é o de confiança: é o
// de ATUALIZAÇÃO. Medido em 02/09 — a TUI abriu com
//
//   ✨ Update available! 0.147.0 -> 0.152.1
//   › 1. Update now (runs `npm install -g @openai/codex`)   2. Skip   3. Skip until next version
//
// e ficou parada esperando um Enter, com "Update now" JÁ SELECIONADO. O `--yolo` não cobre
// isso: ele pula aprovação e sandbox, não o prompt de versão. Quem o desliga é a chave
// `check_for_update_on_startup` do `config.toml` — plantar `version.json` com
// `dismissed_version` alto NÃO basta, porque o CLI re-checa pela rede e sobrescreve.
//
// ⚠️ Isto vale para a PRODUÇÃO, e sobe como decisão para o usuário: uma aba de Codex criada
// pelo cockpit numa casa em que este prompt apareça trava exatamente como travaria no menu
// de confiança — o rollout não nasce, a aba cai em `falhou`, e a tela diz "o agente não
// subiu" quando o que há é um menu esperando resposta que ele não tem como dar do celular.
// E o `~/.codex/version.json` desta máquina diz `dismissed_version: 0.145.0` contra
// `latest_version: 0.152.1`, então o prompt apareceria na casa dele também.
fs.writeFileSync(path.join(CASA, 'config.toml'),
  `check_for_update_on_startup = false\n\n[projects."${TRABALHO}"]\ntrust_level = "trusted"\n`);

// 🔴 O SEGUNDO menu que trava a TUI antes de qualquer coisa, e ele NÃO é o de confiança:
// é o de ATUALIZAÇÃO. Medido em 02/09 numa casa limpa — a TUI abriu com
//
//   ✨ Update available! 0.147.0 -> 0.150.1
//   › 1. Update now   2. Skip   3. Skip until next version
//
// e ficou parada esperando um Enter. O `--yolo` não cobre isso: ele pula aprovação e
// sandbox, não o prompt de versão. Quem o suprime é o `version.json` da casa, com
// `dismissed_version` acima do que está disponível — e é por isso que a casa MÍNIMA precisa
// dele: uma casa recém-criada nunca dispensou versão nenhuma.
//
// ⚠️ Isto vale para a PRODUÇÃO também, e sobe como decisão para o usuário: uma aba de Codex
// criada pelo cockpit num ambiente em que este prompt apareça trava exatamente como travaria
// no menu de confiança — o rollout não nasce, a aba cai em `falhou`, e a tela diz "o agente
// não subiu" quando há uma pergunta esperando resposta.
fs.writeFileSync(path.join(CASA, 'version.json'), JSON.stringify({
  latest_version: '999.0.0',
  last_checked_at: new Date().toISOString(),
  dismissed_version: '999.0.0',
}));

// O servidor tmux guarda uma cópia do ambiente no nascimento. Estas variáveis precisam
// existir ANTES do `new-session`; defini-las depois faria a TUI herdar o ~/.codex real.
process.env.COCKPIT_TMUX_SOCKET = SOCKET;
process.env.COCKPIT_TMUX_SESSAO = SESSAO;
process.env.CODEX_HOME = CASA;
process.env.COCKPIT_CODEX_RAIZ = path.join(CASA, 'sessions');

t(['new-session', '-d', '-s', SESSAO, '-n', CARIMBO, '-c', '/tmp', 'sleep 900']);

const abas = require('../lib/abas');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const linhas = (texto) => String(texto).split('\n').map((l) => l.trim()).filter(Boolean);
const ancora = () => linhas(t(['list-windows', '-t', `${SESSAO}:`, '-F', '#{window_id}\t#{window_name}'], { tolerante: true }))
  .map((l) => l.split('\t')).find(([, nome]) => nome === CARIMBO)?.[0] || null;

/** A tela da pane, para conferir o que a TUI mostra. Read-only, e só no socket de teste. */
const telaDa = (pane) => t(['capture-pane', '-p', '-t', pane], { tolerante: true });

/** Espera uma condição virar verdadeira, ou desiste. */
async function ate(condicao, { teto = 30000, passo = 500 } = {}) {
  const limite = Date.now() + teto;
  while (Date.now() < limite) {
    const r = await condicao();
    if (r) return r;
    await espera(passo);
  }
  return null;
}

/** Limpeza FAIL-CLOSED: só derruba o que ele mesmo criou, e só com o carimbo na mão. */
function limpar() {
  const vivas = linhas(t(['list-sessions', '-F', '#{session_name}'], { tolerante: true }));
  const intrusas = vivas.filter((s) => s !== SESSAO);
  if (intrusas.length) {
    console.error(`  🔴 o socket ${SOCKET} tem sessão que NÃO é minha (${intrusas.join(', ')}) — não dou kill-server.`);
    t(['kill-session', '-t', SESSAO], { tolerante: true });
  } else if (!ancora() && vivas.length) {
    console.error(`  🔴 a janela âncora (${CARIMBO}) sumiu — não provo a posse deste socket. Não derrubo nada.`);
  } else {
    t(['kill-server'], { tolerante: true });
  }
  // `typeof` porque `limpar()` também é chamada pelo `pular()` dos pré-requisitos, que
  // acontece ANTES de estas duas constantes existirem — ali não há o que apagar.
  if (typeof TRABALHO === 'string') fs.rmSync(TRABALHO, { recursive: true, force: true });
  if (typeof CASA === 'string') fs.rmSync(CASA, { recursive: true, force: true });
}

// ─── Os oito passos ──────────────────────────────────────────────────────────

let relogio = null;

(async () => {
  let saida = 0;
  let pulouOsCaros = false;
  try {
    // O timeout global: 180 s. Sem ele, uma TUI que trave deixa o job pendurado para sempre.
    relogio = setTimeout(() => {
      console.error('\n🔴 timeout global de 180 s — derrubando a sessão de teste e saindo.');
      try { limpar(); } catch { /* nada a fazer */ }
      process.exit(1);
    }, 180000);
    relogio.unref?.();

    // ── passo 1: a aba de Codex nasce ────────────────────────────────────────
    console.log('\n  · passo 1 — abrir uma aba de Codex no socket de teste');
    const nova = await abas.criar({ cwd: TRABALHO, nome: 'probe-codex', agente: 'codex' });
    ok(/^aba-p\d+$/.test(nova.chave), `a aba nasceu com chave por pane (${nova.chave})`);

    const detectada = await ate(async () => (await abas.listar()).find((a) => a.chave === nova.chave && a.agente === 'codex'));
    ok(Boolean(detectada), 'o processo do Codex foi encontrado na árvore de /proc daquela pane');
    if (!detectada) throw new Error('o Codex não subiu na aba — sem ele não há o que provar');
    const PANE = detectada.pane;

    // ── passo 2: o rollout nasce e o casamento o acha ────────────────────────
    console.log('\n  · passo 2 — o rollout nasce e o casamento acha o arquivo');
    let casada = await ate(async () => {
      const a = (await abas.listar()).find((x) => x.chave === nova.chave);
      return a?.arquivo ? a : null;
    }, { teto: 10000 });
    if (!casada) {
      // A causa, LIDA DA TELA — e não "o agente não subiu", que é a mensagem errada e manda
      // quem lê procurar no lugar errado. É a única leitura de TUI deste script, e ela só
      // acontece no caminho de FALHA, para explicar o que travou.
      const tela = telaDa(PANE);
      if (/Update available/.test(tela)) {
        // AMBIENTE, não defeito da entrega: o CLI achou versão nova e abriu o prompt de
        // atualização antes de qualquer coisa, com "Update now" já selecionado. Medido em
        // 02/09: 0.147.0 -> 0.152.1. O `--yolo` não cobre isso (ele pula aprovação e
        // sandbox, não o prompt de versão), plantar `version.json` com `dismissed_version`
        // alto não basta (o CLI re-checa pela rede e sobrescreve) e
        // `check_for_update_on_startup = false` no config.toml também não desligou.
        //
        // Dirigir o menu com `Down Down Enter` para "Skip until next version" seria digitar
        // às cegas numa TUI — a D4 recusa isso, e um Enter no item ERRADO dispara
        // `npm install -g @openai/codex` na máquina do usuário.
        pular('a TUI do Codex abriu o prompt de ATUALIZAÇÃO e ficou parada nele. '
          + 'Desbloqueio: atualizar o Codex (`codex update`) ou dispensar a versão uma vez '
          + 'na TUI, e rodar o smoke de novo. ⚠️ Isto NÃO é só do smoke: uma aba de Codex '
          + 'criada pelo cockpit trava igual, e a tela diz "o agente não subiu".');
      }
      if (/Ask Codex to do anything/.test(tela)) {
        ok(true, 'a TUI está pronta; nesta versão o rollout nasce só no primeiro turno');
      } else {
        ok(false, 'o rollout não nasceu e a caixa da TUI também não ficou pronta. Tela: '
          + JSON.stringify(tela.slice(-300)));
        throw new Error('sem rollout nem caixa pronta não há fluxo a provar');
      }
    } else {
      ok(casada.casamento === 'ok', `o casamento achou o rollout desta pane (${casada.casamento})`);
      ok(String(casada.arquivo).startsWith(path.join(CASA, 'sessions')),
        'e ele está na casa MÍNIMA do smoke, não no ~/.codex/ do usuário');
    }

    // ── passo 3: duas linhas na caixa, SEM enviar ────────────────────────────
    console.log('\n  · passo 3 — `\\n` quebra linha na caixa e NÃO submete (leitura pura)');
    const marca = `probe-${process.pid}`;
    await abas.tmuxEstrito(['send-keys', '-t', PANE, '-l', '--', `${marca}-linha1\n${marca}-linha2`]);
    await espera(1200);
    const naCaixa = telaDa(PANE);
    ok(naCaixa.includes(`${marca}-linha1`) && naCaixa.includes(`${marca}-linha2`),
      'as DUAS linhas aparecem na caixa da TUI');
    ok(!/task_started/.test(naCaixa), 'e nenhum turno começou — `\\n` não é `\\r`');

    if (SEM_TURNO) {
      console.log('\n  ⚠ SMOKE_CODEX_SEM_TURNO=1 — pulando os passos 4 a 7 (eles gastam 2 turnos '
        + 'da assinatura). Os passos 1-3 e 8 rodaram.');
      pulouOsCaros = true;
    } else {
      // ── passo 4: o Enter submete — GASTA 1 TURNO ──────────────────────────
      console.log('\n  · passo 4 — o Enter submete 💸 GASTA UM TURNO DA ASSINATURA');
      await abas.tmuxEstrito(['send-keys', '-t', PANE, 'Escape']);   // limpa a caixa do passo 3
      await espera(500);
      await abas.enviar(nova.chave, 'oi');
      await espera(1500);

      if (!casada) {
        casada = await ate(async () => {
          const a = (await abas.listar()).find((x) => x.chave === nova.chave);
          return a?.arquivo ? a : null;
        }, { teto: 30000, passo: 300 });
        ok(casada?.casamento === 'ok',
          `o primeiro turno criou o rollout e o casamento o achou (${casada?.casamento})`);
        ok(String(casada?.arquivo || '').startsWith(path.join(CASA, 'sessions')),
          'e o rollout novo está na casa MÍNIMA do smoke');
        if (!casada) throw new Error('o primeiro turno não criou um rollout detectável');
      }

      // ── passo 5: busy → idle ──────────────────────────────────────────────
      console.log('\n  · passo 5 — `rodando` acende durante o turno e apaga no fim');
      const rodou = await ate(async () => (await abas.listar()).find((a) => a.chave === nova.chave)?.rodando === true,
        { teto: 20000, passo: 300 });
      ok(Boolean(rodou), 'durante o turno, `rodando` é true (o `task_started` do rollout)');
      const parou = await ate(async () => (await abas.listar()).find((a) => a.chave === nova.chave)?.rodando === false,
        { teto: 120000, passo: 1000 });
      ok(Boolean(parou), 'e depois do `task_complete` ele volta a false — sem ficar pendurado (#4)');

      // ── passo 6: o medidor ────────────────────────────────────────────────
      console.log('\n  · passo 6 — o medidor sai do rollout, sem ler config nenhuma');
      const atual = (await abas.listar()).find((a) => a.chave === nova.chave);
      const medida = await require('../lib/agentes').de('codex').medidor.doArquivo(atual.arquivo);
      ok(Boolean(medida) && medida.usados > 0, `o medidor achou tokens usados (${medida?.usados})`);
      ok(medida?.pct === null || (medida.pct > 0 && medida.pct <= 100),
        `e a porcentagem cabe em 0..100 — nunca os 2026% do total_token_usage (${medida?.pct}%)`);
      ok(medida?.teto > 0, `o teto veio do próprio rollout, sem settings.json (${medida?.teto})`);

      // ── passo 7: a interrupção de VERDADE — GASTA O 2º TURNO ──────────────
      //
      // Um `Escape` num turno JÁ TERMINADO só provaria que a TUI sobrevive a um Escape.
      // Interromper é sobre parar um turno que ROLA, e é por isso que este passo manda um
      // prompt longo antes, espera o `rodando` acender, e só então chama `interromper()`.
      console.log('\n  · passo 7 — interromper um turno EM ANDAMENTO 💸 GASTA O SEGUNDO TURNO');
      await abas.enviar(nova.chave, 'Escreva um texto muito longo, de pelo menos vinte parágrafos, '
        + 'sobre a história dos sistemas de arquivos, com detalhes técnicos de cada um.');
      const acendeu = await ate(async () => (await abas.listar()).find((a) => a.chave === nova.chave)?.rodando === true,
        { teto: 30000, passo: 300 });
      ok(Boolean(acendeu), 'o turno longo começou (`rodando` acendeu)');
      if (acendeu) {
        await abas.interromper(nova.chave);
        const apagou = await ate(async () => (await abas.listar()).find((a) => a.chave === nova.chave)?.rodando === false,
          { teto: 15000, passo: 500 });
        ok(Boolean(apagou), 'e `rodando` voltou a false em menos de 15 s');
        // A TUI CONTINUA DE PÉ — interromper não é matar. Se ela tivesse caído, a pane não
        // teria mais o processo e a aba sumiria da lista.
        const viva = (await abas.listar()).find((a) => a.chave === nova.chave);
        ok(viva?.agente === 'codex', 'e a TUI continua de pé: a aba ainda é uma aba de Codex');
      }
    }

    // ── passo 8: teardown CONDICIONAL ────────────────────────────────────────
    console.log(`\n  · passo 8 — teardown ${MANTER ? 'ADIADO (--manter)' : 'agora'}`);
    ok(Boolean(ancora()), 'a janela âncora com o carimbo de posse continua lá');
  } catch (e) {
    ok(false, `o smoke estourou: ${e.message}`);
  } finally {
    clearTimeout(relogio);
    // `--manter` deixa a sessão VIVA de propósito: é esse o estado que o smoke de navegador
    // consome — uma aba de Codex com pelo menos um turno concluído. Sem ele os PNGs sairiam
    // vazios, que foi exatamente o defeito de 24/08.
    if (!MANTER) limpar();
    else console.log(`  · sessão MANTIDA em ${SOCKET} — o teardown é do orquestrador`);
    saida = falhas ? 1 : (pulouOsCaros ? 2 : 0);
    console.log(`\n${falhas ? '❌ SMOKE VERMELHO' : (pulouOsCaros ? '🟡 SMOKE PULADO (sem gastar turno)' : '✅ SMOKE VERDE')}`
      + ` — ${feitos - falhas}/${feitos} asserções`);
    if (!falhas && !pulouOsCaros) console.log('  💸 custo: 2 turnos da assinatura OpenAI');
  }
  // A ÚLTIMA linha do stdout é o nome do socket. O gate final a lê para o `--teardown`, e é
  // por isso que nada pode ser impresso depois dela.
  console.log(SOCKET);
  process.exit(saida);
})().catch((e) => {
  console.error('\n❌ o smoke quebrou:', e.message, '\n');
  clearTimeout(relogio);
  try { limpar(); } catch { /* nada a fazer */ }
  console.log(SOCKET);
  process.exit(1);
});
