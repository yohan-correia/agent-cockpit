'use strict';
// Adaptador do Claude Code — o ÚNICO arquivo do cockpit que sabe o que é `stream-json`.
//
// Todo o resto do sistema enxerga apenas o "evento interno" definido aqui. É essa fronteira
// que permite acrescentar cursor e codex depois sem reescrever núcleo, gateway ou UI
// (ver docs/arquitetura.md — camadas).
//
// O ambiente do Claude Code pai precisa ser limpo: herdar CLAUDECODE/CLAUDE_CODE_*
// pode fazer o processo filho se confundir com a sessão do pai.
// COCKPIT_SESSAO=1 identifica o fluxo legado para hooks que optem por reconhecê-lo.
// O contexto adicional descreve a interface, sem dispensar regras do projeto.

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

// Herdadas do Claude Code que estiver rodando este servidor. Precisam sair do filho.
const ENV_A_LIMPAR = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

function novoId() {
  return crypto.randomUUID();
}

function montarEnv() {
  const env = { ...process.env };
  for (const chave of ENV_A_LIMPAR) delete env[chave];
  env.COCKPIT_SESSAO = '1'; // ver armadilha 1 no cabeçalho
  return env;
}

// As três chaves "conhecidas" de `unifiedWindows`, na ordem em que a tela mostra (spec D-c).
// Uma chave que não está aqui entra no fim, em ordem alfabética, com o nome cru como rótulo:
// o CLI pode publicar uma janela nova sem aviso, e sumir da tela seria pior que um rótulo feio.
const ORDEM_JANELAS = ['five_hour', 'seven_day', 'seven_day_overage_included'];
const ROTULO_JANELA = {
  five_hour: 'Sessão (5h)',
  seven_day: 'Semana (tudo)',
  seven_day_overage_included: 'Semana (com extra)',
};

/**
 * As janelas do plano que o `rate_limit_event` publica, no MESMO formato que
 * `lib/limite.js:analisar()` produz para o `/usage` (4 chaves, nem uma a mais) — é assim que
 * as duas fontes desenham na mesma tela sem a UI precisar saber de onde veio cada item.
 *
 * Duas escalas que NÃO podem se confundir (ver docs/arquitetura.md): aqui `utilization` é uma
 * FRAÇÃO 0..1; o `used_percent` que o Codex publica (lib/adaptador-codex.js:747) é 0..100.
 * Mesmo campo na tela, duas fontes, duas escalas.
 *
 * @param {object} info    o `rate_limit_info` do evento (`bruto.rate_limit_info`)
 * @param {number} [agora] epoch em ms; default `Date.now()` — parâmetro para o caller (e o
 *                         gate) poderem testar "janela já resetada" sem depender do relógio.
 * @returns {?Array<{rotulo: string, usado: number, reseta: null, resetaEm: ?number}>}
 *          `null` quando não há `unifiedWindows`, ou quando todo item cai nos descartes
 *          abaixo — NUNCA `[]` (spec D-b): `[]` afirmaria "este plano não tem limite".
 */
function janelasDoLimite(info, agora = Date.now()) {
  const uw = info && info.unifiedWindows;
  if (!uw || typeof uw !== 'object') return null;

  const chaves = Object.keys(uw);
  const conhecidas = ORDEM_JANELAS.filter((c) => chaves.includes(c));
  const desconhecidas = chaves.filter((c) => !ORDEM_JANELAS.includes(c)).sort();

  const itens = [];
  for (const chave of [...conhecidas, ...desconhecidas]) {
    const janela = uw[chave];
    if (!janela || typeof janela !== 'object') continue;

    // 🔴 `typeof === 'number'` ANTES do `Number()`, e não é preciosismo: `Number(null)` e
    // `Number('')` são **0** (⇒ "0% usado", tela mentindo que a janela está vazia) e
    // `Number(true)` é **1** (⇒ "100% usado", alarme falso). Os três passariam por um
    // `Number.isFinite` sozinho. Achado do painel de execução, reproduzido em memória.
    const utilization = janela.utilization;
    // Fora de 0..1, ausente ou não-numérica: item DESCARTADO. Número com cara de número
    // certo é o que a armadilha #10 proíbe.
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)
      || utilization < 0 || utilization > 1) continue;

    const resetsAt = janela.resetsAt;
    const resetaEm = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0
      ? resetsAt * 1000 : null;
    // 🔴 Janela já resetada: aquela `utilization` é de uma janela que não existe mais — um
    // "87% · faltam -2d" seria o mesmo número com cara de certo, de outro ângulo.
    if (resetaEm !== null && resetaEm < agora) continue;

    itens.push({
      rotulo: ROTULO_JANELA[chave] || chave,
      usado: Math.round(utilization * 100),
      reseta: null, // string humana; ninguém publica isso aqui. `null` EXPLÍCITO (R3): omitir
                    // faz o campo sumir do JSON e o "formato compartilhado" virar dois formatos.
      resetaEm,
    });
  }
  return itens.length ? itens : null;
}

/**
 * Traduz uma linha do stream-json para evento interno.
 * Devolve um array porque um `assistant` pode carregar texto e chamada de ferramenta juntos.
 */
function traduzir(bruto) {
  const eventos = [];

  if (bruto.type === 'system' && bruto.subtype === 'init') {
    eventos.push({
      tipo: 'inicio',
      sessionId: bruto.session_id,
      cwd: bruto.cwd,
      modelo: bruto.model,
      modoPermissao: bruto.permissionMode,
      ferramentas: Array.isArray(bruto.tools) ? bruto.tools.length : 0,
      // O CLI declara aqui TUDO que aquela sessão entende depois de uma barra, inclusive
      // os embutidos (/clear, /context, /compact) que não existem como arquivo em lugar
      // nenhum. É a única fonte honesta para o autocomplete.
      comandos: Array.isArray(bruto.slash_commands) ? bruto.slash_commands : [],
    });
    return eventos;
  }

  if (bruto.type === 'assistant') {
    for (const parte of bruto.message?.content || []) {
      if (parte.type === 'text' && parte.text) {
        eventos.push({ tipo: 'texto', texto: parte.text });
      } else if (parte.type === 'tool_use') {
        eventos.push({ tipo: 'ferramenta', id: parte.id, nome: parte.name, entrada: parte.input });
      }
    }
    return eventos;
  }

  if (bruto.type === 'user') {
    for (const parte of bruto.message?.content || []) {
      if (parte.type === 'tool_result') {
        eventos.push({
          tipo: 'resultado_ferramenta',
          id: parte.tool_use_id,
          erro: Boolean(parte.is_error),
          saida: typeof parte.content === 'string' ? parte.content : JSON.stringify(parte.content),
        });
      }
    }
    return eventos;
  }

  if (bruto.type === 'result') {
    // permission_denials importa: em stream-json, o que o CLI não pôde fazer sozinho é
    // negado EM SILÊNCIO e só aparece aqui. Sem isto, uma sessão capada parece saudável.
    eventos.push({
      tipo: 'fim',
      resultado: bruto.result,
      erro: Boolean(bruto.is_error),
      negacoes: bruto.permission_denials || [],
      duracaoMs: bruto.duration_ms,
      custoUSD: bruto.total_cost_usd,
      uso: usoDoResultado(bruto),
    });
    return eventos;
  }

  if (bruto.type === 'rate_limit_event') {
    // O teto do PLANO, que não tem nada a ver com a janela de contexto. O CLI manda status
    // e quando a janela reseta, e desde a medição de 2026-09-08 (spec §1.1) também manda a
    // porcentagem consumida em `unifiedWindows` — é o que `janelasDoLimite` extrai abaixo.
    const r = bruto.rate_limit_info || {};
    eventos.push({
      tipo: 'limite',
      status: r.status || null,                       // allowed | ...
      resetaEm: r.resetsAt ? r.resetsAt * 1000 : null, // epoch em segundos, vira ms
      janela: r.rateLimitType || null,                 // five_hour, weekly...
      usandoExtra: Boolean(r.isUsingOverage),
      janelas: janelasDoLimite(r),
    });
    return eventos;
  }

  return eventos; // o que sobra é ruído de protocolo, ignorado de propósito
}

/**
 * Quanto do contexto uma mensagem do assistente ocupava quando foi pedida.
 *
 * O que conta como "contexto usado" é tudo que subiu naquele request: o que foi lido do
 * cache, o que foi gravado nele e o que foi enviado cru. A saída não entra — ela ainda
 * não estava lá. É a mesma conta que a barra de contexto do Claude Code mostra.
 */
function usoDaMensagem(bruto) {
  const u = bruto?.message?.usage;
  if (!u) return null;
  return {
    contexto: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    saida: u.output_tokens || 0,
    modelo: bruto.message.model || null,
  };
}

/**
 * Fechamento de um turno: custo, tamanho da janela e totais do modelo usado.
 *
 * `modelUsage` costuma trazer MAIS DE UM modelo — o principal da conversa e os menores
 * que o CLI usa por baixo (subagente, resumo de ferramenta). Pegar o primeiro da lista
 * fazia uma sessão de Opus se declarar Haiku. O principal é o de maior custo.
 */
function usoDoResultado(bruto) {
  const porModelo = bruto.modelUsage || {};
  const modelo = Object.entries(porModelo)
    .sort((a, b) => (b[1].costUSD || 0) - (a[1].costUSD || 0))
    .map(([nome]) => nome)[0] || null;
  const m = modelo ? porModelo[modelo] : {};
  const u = bruto.usage || {};
  return {
    modelo,
    janela: m.contextWindow || null,
    maxSaida: m.maxOutputTokens || null,
    entrada: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    saida: u.output_tokens || 0,
    cacheLido: u.cache_read_input_tokens || 0,
    custoUSD: bruto.total_cost_usd || 0,
    duracaoMs: bruto.duration_ms || 0,
    porModelo,
  };
}

/**
 * Monta os argumentos do CLI para um turno. Exportado porque a camada de sessões precisa
 * rodar o mesmo comando dentro do tmux, e duplicar essa lista seria pedir para divergir.
 */
// Ver armadilha 2 no cabeçalho. Diz ao agente o que esta sessão realmente é.
const CONTEXTO_COCKPIT = [
  'Esta sessão roda dentro do Cockpit de Agentes.',
  'Apesar de usar `claude -p`, NÃO é execução headless delegada: há um humano lendo e',
  'respondendo ao vivo, do celular ou do desktop — é sessão interativa, apenas em outra',
  'superfície. Respeite as instruções do projeto e as aprovações configuradas no CLI.',
].join(' ');

function montarArgs({ texto, sessionId, retomar = false, modelo }) {
  const args = ['-p', texto, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'auto', '--append-system-prompt', CONTEXTO_COCKPIT];
  args.push(...(retomar ? ['--resume', sessionId] : ['--session-id', sessionId]));
  if (modelo) args.push('--model', modelo);
  return args;
}

/**
 * Dispara um turno. Devolve um EventEmitter que emite 'evento' (interno) e 'fim'.
 *
 * @param {object} opts
 * @param {string} opts.texto      o que o usuário escreveu
 * @param {string} opts.cwd        diretório de trabalho da sessão (sempre explícito)
 * @param {string} [opts.sessionId] id da sessão; gerado se ausente
 * @param {boolean} [opts.retomar]  true => --resume; false => --session-id (sessão nova)
 * @param {string} [opts.modelo]    opcional; ausente = modelo padrão do usuário
 */
function iniciarTurno({ texto, cwd, sessionId, retomar = false, modelo }) {
  if (!texto || !String(texto).trim()) throw new Error('turno sem texto');
  if (!cwd) throw new Error('turno sem cwd — sessão precisa de diretório explícito');

  const id = sessionId || novoId();
  const args = montarArgs({ texto, sessionId: id, retomar, modelo });

  const emissor = new EventEmitter();
  emissor.sessionId = id;

  const proc = spawn('claude', args, { cwd, env: montarEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  emissor.pid = proc.pid;

  let erroStderr = '';
  proc.stderr.on('data', (bloco) => { erroStderr += bloco.toString(); });

  const linhas = readline.createInterface({ input: proc.stdout });
  linhas.on('line', (linha) => {
    if (!linha.trim()) return;
    let bruto;
    try {
      bruto = JSON.parse(linha);
    } catch {
      // Uma linha ilegível não pode derrubar o turno inteiro.
      emissor.emit('evento', { tipo: 'erro', mensagem: `linha ilegível: ${linha.slice(0, 120)}` });
      return;
    }
    for (const evento of traduzir(bruto)) emissor.emit('evento', evento);
  });

  proc.on('error', (erro) => {
    emissor.emit('evento', { tipo: 'erro', mensagem: String(erro.message) });
    emissor.emit('fim', { codigo: -1, sessionId: id });
  });

  proc.on('close', (codigo) => {
    if (codigo !== 0 && erroStderr.trim()) {
      emissor.emit('evento', { tipo: 'erro', mensagem: erroStderr.trim().slice(0, 500) });
    }
    emissor.emit('fim', { codigo, sessionId: id });
  });

  emissor.encerrar = () => proc.kill('SIGTERM');
  return emissor;
}

module.exports = {
  iniciarTurno, traduzir, novoId, montarEnv, montarArgs, usoDaMensagem, usoDoResultado,
  janelasDoLimite, ENV_A_LIMPAR, CONTEXTO_COCKPIT,
};
