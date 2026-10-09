#!/usr/bin/env node
'use strict';
// GERADOR das fixtures de rollout do Codex — a ALAVANCA do card `codex-no-relatorio-de-tokens`.
//
// Formato do CLI mudou? Regenera-se este arquivo (a estrutura), não se edita JSON à mão.
// Parte da ESTRUTURA real medida em 22/09 (spec `2026-09-22-codex-no-relatorio-de-tokens-design.md`,
// §1.1/§3), com todo TEXTO substituído por sintético — nenhum byte de conversa do dono no git.
//
// 🔴 Datas são DERIVADAS de `Date.now()` (ou de `opts.agora`), nunca chumbadas — um `resets_at`
// fixo no passado é exatamente o defeito do caso 72 do `gate-codex.js` que este card corrigiu.
//
// Uso:
//   node gera.js                      → escreve em __dirname (a fixture do repo, para o print)
//   node gera.js <raiz>                → escreve em <raiz> (o gate chama assim, num mkdtemp)
//   require('./gera').gerar(raiz, opts) → a mesma coisa, programaticamente
//
// `opts.jobsDir`, quando informado, TAMBÉM grava o `meta.json` do job do fixture `exec` — sem
// ele (uso padrão, sem argumento), NADA é escrito fora de `raiz`: rodar `node gera.js` na
// máquina de verdade nunca toca em `~/.cockpit/jobs`.
//
// As NOVE fixtures e o que cada uma exercita — tabela da Fase 1 do plano:
//   normal            session_meta cwd=<home>/projetos/loja-exemplo, source:"cli", turn_context,
//                     3 token_count CRESCENTES
//   duplicado         dois token_count IDÊNTICOS seguidos (GC1)
//   reset             acumulado que CAI no meio (GC2)
//   exec              source:"exec", cwd de worktree de job (GC12)
//   subagente         source como OBJETO {subagent:{thread_spawn:…}} (GC12)
//   corrompido        linha que não parseia + linha > 1 MB (GC3)
//   segredo           SEGREDO-NAO-PODE-VAZAR em message, em base_instructions.text e nos
//                     últimos 256 bytes do arquivo (GC6)
//   sem-secundaria    primary presente, secondary: null, credits.has_credits:false (GC5)
//   vencido           resets_at no PASSADO (GC11)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIN = 60 * 1000;
const DIA = 24 * 60 * MIN;

function gerar(raiz, opts = {}) {
  const agora = opts.agora || Date.now();
  const home = opts.home || os.homedir();
  const worktreesDir = opts.worktreesDir || path.join(home, '.cockpit', 'worktrees');
  const jobsDir = opts.jobsDir || null;

  const t = (offsetMs) => new Date(agora + offsetMs).toISOString();
  const dataPasta = new Date(agora);
  const dia = [
    dataPasta.getUTCFullYear(),
    String(dataPasta.getUTCMonth() + 1).padStart(2, '0'),
    String(dataPasta.getUTCDate()).padStart(2, '0'),
  ].join('/');
  const pasta = path.join(raiz, dia);
  fs.mkdirSync(pasta, { recursive: true });

  const total = (input, output, cachedInput, reasoning) => ({
    input_tokens: input,
    cached_input_tokens: cachedInput,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  });

  const sessionMeta = ({
    sessaoId, cwd, originator = 'codex-tui', source = 'cli',
    nascimento, envelope, baseInstructions = 'x'.repeat(4000),
  }) => JSON.stringify({
    timestamp: envelope,
    type: 'session_meta',
    payload: {
      id: sessaoId, session_id: sessaoId, timestamp: nascimento, cwd, originator,
      cli_version: '0.147.0', source,
      base_instructions: { text: baseInstructions },
    },
  });

  const turnContext = ({ timestamp, modelo = 'gpt-6-astra', esforco = null }) => JSON.stringify({
    timestamp, type: 'turn_context',
    payload: { model: modelo, collaboration_mode: { mode: 'default', settings: { model: modelo, reasoning_effort: esforco } } },
  });

  const tokenCount = ({ timestamp, valores, rateLimits }) => JSON.stringify({
    timestamp, type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: valores, last_token_usage: valores, model_context_window: 272000 },
      ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }),
    },
  });

  const mensagem = ({ timestamp, texto }) => JSON.stringify({
    timestamp, type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: texto }] },
  });

  const escrever = (nome, linhas) => {
    fs.writeFileSync(path.join(pasta, `rollout-${nome}.jsonl`), `${linhas.join('\n')}\n`);
  };

  // ── normal: 3 token_count crescentes, source "cli" ──
  escrever('normal', [
    sessionMeta({ sessaoId: 'normal', cwd: path.join(home, 'projetos', 'loja-exemplo'), nascimento: t(-30 * MIN), envelope: t(-30 * MIN) }),
    turnContext({ timestamp: t(-29 * MIN) }),
    tokenCount({ timestamp: t(-28 * MIN), valores: total(1000, 200, 900, 50) }),
    tokenCount({ timestamp: t(-20 * MIN), valores: total(2500, 500, 2000, 150) }),
    tokenCount({ timestamp: t(-10 * MIN), valores: total(4200, 900, 3500, 300) }),
  ]);

  // ── duplicado: dois token_count IDÊNTICOS seguidos (GC1) ──
  escrever('duplicado', [
    sessionMeta({ sessaoId: 'duplicado', cwd: path.join(home, 'projetos', 'duplicado-demo'), nascimento: t(-30 * MIN), envelope: t(-30 * MIN) }),
    turnContext({ timestamp: t(-29 * MIN) }),
    tokenCount({ timestamp: t(-28 * MIN), valores: total(1000, 200, 900, 50) }),
    tokenCount({ timestamp: t(-27 * MIN), valores: total(1000, 200, 900, 50) }), // idêntico -> delta 0
    tokenCount({ timestamp: t(-20 * MIN), valores: total(1800, 400, 1600, 90) }),
  ]);

  // ── reset: o acumulado CAI no meio (GC2) ──
  escrever('reset', [
    sessionMeta({ sessaoId: 'reset', cwd: path.join(home, 'projetos', 'reset-demo'), nascimento: t(-30 * MIN), envelope: t(-30 * MIN) }),
    turnContext({ timestamp: t(-29 * MIN) }),
    tokenCount({ timestamp: t(-28 * MIN), valores: total(1000, 200, 900, 50) }),
    tokenCount({ timestamp: t(-25 * MIN), valores: total(3000, 600, 2600, 150) }), // pico do 1º segmento: 3600
    tokenCount({ timestamp: t(-20 * MIN), valores: total(500, 100, 400, 20) }),    // CAIU — segmento novo
    tokenCount({ timestamp: t(-10 * MIN), valores: total(2000, 400, 1700, 90) }),  // último do 2º: 2400
  ]);

  // ── exec: source "exec", cwd de worktree de job (GC12) ──
  const idJobExec = 'job-exec-demo';
  escrever('exec', [
    sessionMeta({
      sessaoId: 'exec', cwd: path.join(worktreesDir, idJobExec),
      originator: 'codex_exec', source: 'exec',
      nascimento: t(-30 * MIN), envelope: t(-30 * MIN),
    }),
    turnContext({ timestamp: t(-29 * MIN) }),
    tokenCount({ timestamp: t(-28 * MIN), valores: total(600, 100, 500, 30) }),
    tokenCount({ timestamp: t(-20 * MIN), valores: total(1400, 300, 1200, 70) }),
  ]);
  if (jobsDir) {
    fs.mkdirSync(path.join(jobsDir, idJobExec), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, idJobExec, 'meta.json'),
      JSON.stringify({ project: 'projeto-job', type: 'ataca', title: 'fixture do gate' }));
  }

  // ── subagente: `source` como OBJETO {subagent:{thread_spawn:…}} (GC12) ──
  escrever('subagente', [
    sessionMeta({
      sessaoId: 'subagente', cwd: path.join(home, 'projetos', 'subagente-demo'),
      source: { subagent: { thread_spawn: 'agente-x' } },
      nascimento: t(-30 * MIN), envelope: t(-30 * MIN),
    }),
    turnContext({ timestamp: t(-29 * MIN) }),
    tokenCount({ timestamp: t(-28 * MIN), valores: total(700, 150, 600, 40) }),
  ]);

  // ── corrompido: linha que não parseia + linha > 1 MB (GC3) ──
  escrever('corrompido', [
    sessionMeta({ sessaoId: 'corrompido', cwd: path.join(home, 'projetos', 'corrompido-demo'), nascimento: t(-30 * MIN), envelope: t(-30 * MIN) }),
    turnContext({ timestamp: t(-29 * MIN) }),
    tokenCount({ timestamp: t(-28 * MIN), valores: total(500, 100, 400, 20) }),
    // Duas classes de linha quebrada, e SÓ UMA precisa entrar em `linhasIgnoradas`:
    //
    //  (a) lixo que não é candidato — sem `token_count`/`session_meta`/`turn_context`, morre
    //      no filtro de orçamento ANTES do `JSON.parse`. Não carrega token por definição, e
    //      contá-la seria ruído: quase toda linha de um rollout é assim (mensagem, reasoning,
    //      tool call).
    'isto nao e json valido {{{ sobrou lixo aqui',
    //  (b) um `token_count` TRUNCADO — é como um `.jsonl` corrompe de verdade (escrita
    //      parcial, disco cheio, processo morto no meio da linha). Ele CASA o filtro, chega
    //      no `JSON.parse`, estoura, e PODE estar levando tokens junto. Essa tem que contar,
    //      senão o relatório afirma completude que não tem.
    '{"timestamp":"' + t(-27 * MIN) + '","type":"event_msg","payload":{"type":"token_count","info":{"total_toke',
    // > 1 MB de propósito (TETO_LINHA de lib/uso.js é 1 MiB) — tem "token_count" no meio
    // para provar que o corte por BYTES acontece ANTES de qualquer JSON.parse.
    JSON.stringify({
      timestamp: t(-25 * MIN), type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: total(999999, 1, 1, 1) }, lixo: 'x'.repeat(1100000) },
    }),
    tokenCount({ timestamp: t(-10 * MIN), valores: total(1200, 300, 1000, 60) }),
  ]);

  // ── segredo: SEGREDO-NAO-PODE-VAZAR em message, em base_instructions.text e nos
  //    ÚLTIMOS 256 bytes do arquivo (GC6) — a última linha é curta, para garantir que o
  //    segredo cai dentro da janela que vira assinatura. ──
  escrever('segredo', [
    sessionMeta({
      sessaoId: 'segredo', cwd: path.join(home, 'projetos', 'segredo-demo'),
      nascimento: t(-30 * MIN), envelope: t(-30 * MIN),
      baseInstructions: `${'x'.repeat(2000)}SEGREDO-NAO-PODE-VAZAR${'x'.repeat(2000)}`,
    }),
    turnContext({ timestamp: t(-29 * MIN) }),
    tokenCount({ timestamp: t(-28 * MIN), valores: total(800, 150, 700, 40) }),
    mensagem({ timestamp: t(-5 * MIN), texto: 'SEGREDO-NAO-PODE-VAZAR' }),
  ]);

  // ── sem-secundaria: primary presente, secondary: null, credits.has_credits:false (GC5) ──
  escrever('sem-secundaria', [
    sessionMeta({ sessaoId: 'sem-secundaria', cwd: path.join(home, 'projetos', 'sem-secundaria-demo'), nascimento: t(-30 * MIN), envelope: t(-30 * MIN) }),
    turnContext({ timestamp: t(-29 * MIN) }),
    tokenCount({
      timestamp: t(-10 * MIN), valores: total(900, 200, 800, 50),
      rateLimits: {
        // `window_minutes: 10080` (semanal) casa com o `resets_at` de +3 dias — e é a janela
        // que o plano real publica (medido em 22/09: `10080`, reset em 26/09). Com os `300`
        // de antes, a tela desenhava `Codex — 5h · faltam 3d 0h`: uma janela de 5 horas que
        // reseta em 3 dias não existe, e o print da entrega ficava provando um estado
        // impossível. Fixture incoerente é pior que fixture pobre — ela passa no gate e
        // engana quem olha o PNG.
        primary: { used_percent: 42, window_minutes: 10080, resets_at: Math.floor((agora + 3 * DIA) / 1000) },
        secondary: null,
        credits: { has_credits: false },
        plan_type: 'prolite',
      },
    }),
  ]);

  // ── vencido: resets_at no PASSADO (GC11) ──
  escrever('vencido', [
    sessionMeta({ sessaoId: 'vencido', cwd: path.join(home, 'projetos', 'vencido-demo'), nascimento: t(-30 * MIN), envelope: t(-30 * MIN) }),
    turnContext({ timestamp: t(-29 * MIN) }),
    tokenCount({
      timestamp: t(-10 * MIN), valores: total(1100, 250, 950, 60),
      rateLimits: {
        primary: { used_percent: 88, window_minutes: 10080, resets_at: Math.floor((agora - 2 * DIA) / 1000) },
        secondary: null,
      },
    }),
  ]);
}

if (require.main === module) {
  const raiz = process.argv[2] || __dirname;
  // Gravando no repo, o home é fictício: o home real entrava nas fixtures commitadas por aqui.
  gerar(raiz, process.argv[2] ? {} : { home: '/home/usuario-dev' });
  console.log(`fixtures do rollout-codex escritas em ${raiz}`);
}

module.exports = { gerar };
