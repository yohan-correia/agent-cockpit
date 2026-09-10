'use strict';
// Quanto do plano já foi gasto — o "limite de sessão" que o usuário quer ver.
//
// Isto NÃO é a janela de contexto (essa vem de graça no stream de cada turno, ver
// lib/sessoes.js). É o teto da assinatura, e desde a medição de 2026-09-08 (spec
// `medidor-de-sessao-de-graca`, §1.1) o `rate_limit_event` que o CLI publica PASSOU A trazer
// a porcentagem consumida em `unifiedWindows` — não só "allowed" e quando a janela reseta.
// `lib/adaptador-claude.js:janelasDoLimite` extrai isso; `dasJanelas()` abaixo lê o último
// evento gravado num `claude.log` de job (o evento não existe no `.jsonl` da conversa — só
// no stream de `claude -p`, ver docs/arquitetura.md) e devolve isso DE GRAÇA, sem turno nenhum.
//
// Por isso o `/usage` (via `claude -p`) DEIXOU de ser a fonte primária. Ele continua
// existindo porque é o ÚNICO com o Fable Weekly, e agora roda só SOB CLIQUE — o botão
// "atualizar" do painel, nunca ao abrir. O preço de chamá-lo é um turno de verdade — daí o
// cache e o modelo mais barato.
//
// O parse do `/usage` depende do texto do CLI, que pode mudar sem aviso. Quando não
// reconhecer nada, devolve `itens: []` e o painel cai no que `dasJanelas()` já dá de graça.
// Degradar, não quebrar.

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { ENV_A_LIMPAR, janelasDoLimite } = require('./adaptador-claude');

const BLOCO_CAUDA = 64 * 1024;   // mesmo tamanho de lib/externo.js:313 — "não escrever leitura nova"
const TETO_CAUDA = 256 * 1024;   // §2.1 da spec: cobre os 6 claude.log mais recentes medidos
const JANELA_RECENTE_MS = 24 * 3600_000; // arquivo OU medição mais velha que isto não compete

const TTL_MS = 5 * 60_000;
const TETO_MS = 90_000;
const DIR = path.join(os.homedir(), '.cockpit', 'limite');

let cache = null;      // { em, dados }
let emVoo = null;      // promessa em andamento: duas telas abertas = uma consulta só

/** `Current session: 25% used · resets Aug 20, 5:20pm (UTC)` */
const LINHA = /^Current ([^:]+):\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+?))?\s*$/gm;

function rotular(bruto) {
  const nome = bruto.trim();
  if (nome === 'session') return 'Sessão (5h)';
  const semana = nome.match(/^week\s*\((.+)\)$/i);
  if (semana) {
    return semana[1].toLowerCase() === 'all models' ? 'Semana (tudo)' : `Semana (${semana[1]})`;
  }
  return nome;
}

/**
 * `Aug 20, 5:20pm (UTC)` → epoch em ms, para o painel poder dizer "faltam 2h13".
 * O CLI não manda o ano; assumimos o corrente e corrigimos a virada de dezembro.
 */
function paraEpoch(texto, agora = Date.now()) {
  const m = String(texto || '').match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)$/i);
  if (!m) return null;
  let hora = Number(m[3]) % 12;
  if (/pm/i.test(m[5])) hora += 12;
  const ano = new Date(agora).getUTCFullYear();
  const alvo = Date.parse(`${m[1]} ${m[2]}, ${ano} ${String(hora).padStart(2, '0')}:${m[4] || '00'}:00 UTC`);
  if (Number.isNaN(alvo)) return null;
  // Reset é sempre no futuro próximo. Muito atrás = a data é do ano seguinte.
  return alvo < agora - 30 * 24 * 3600e3
    ? Date.parse(`${m[1]} ${m[2]}, ${ano + 1} ${String(hora).padStart(2, '0')}:${m[4] || '00'}:00 UTC`)
    : alvo;
}

function analisar(texto, agora = Date.now()) {
  const itens = [];
  LINHA.lastIndex = 0;
  let achado;
  while ((achado = LINHA.exec(texto)) !== null) {
    const reseta = (achado[3] || '').trim() || null;
    itens.push({
      rotulo: rotular(achado[1]),
      usado: Number(achado[2]),
      reseta,
      resetaEm: paraEpoch(reseta, agora),
    });
  }
  return itens;
}

function rodarUsage() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, COCKPIT_SESSAO: '1' };
    for (const chave of ENV_A_LIMPAR) delete env[chave];
    // Diretório próprio e vazio: o /usage não olha o projeto, e assim nenhum CLAUDE.md
    // de repo entra no prompt à toa.
    execFile('claude', ['-p', '/usage', '--model', 'haiku'],
      { cwd: DIR, env, timeout: TETO_MS, maxBuffer: 4e6 },
      (erro, saida, err) => {
        if (erro && !String(saida).trim()) return reject(new Error(String(err || erro.message).trim().slice(0, 300)));
        resolve(String(saida));
      });
  });
}

/**
 * Consumo do plano. Cacheado: o número anda devagar e cada consulta custa um turno.
 * @param {boolean} [forcar] ignora o cache (o botão "atualizar" do painel).
 */
async function consultar(forcar = false) {
  if (!forcar && cache && Date.now() - cache.em < TTL_MS) return cache.dados;
  if (emVoo) return emVoo;

  emVoo = (async () => {
    await fsp.mkdir(DIR, { recursive: true });
    const texto = await rodarUsage();
    const dados = { itens: analisar(texto), consultadoEm: Date.now() };
    cache = { em: Date.now(), dados };
    return dados;
  })().finally(() => { emVoo = null; });

  return emVoo;
}

/** O que o `/usage` já entregou, SE ainda vale. Nunca dispara consulta — é o oposto de
 * `consultar()`: o servidor a usa para o caminho de graça (sem `?forcar=1`), e um cache
 * vazio ou expirado devolve `null` em vez de sair perguntando à Anthropic. */
function emCache() {
  return cache && Date.now() - cache.em < TTL_MS ? cache.dados : null;
}

// Lido do ENV a cada chamada (não numa constante de topo) para o gate poder trocar de
// cenário no MESMO processo — mesmo hábito de lib/uso.js:83-88 (COCKPIT_USO_DIR).
function dirJobs() {
  return process.env.COCKPIT_JOBS_DIR || path.join(os.homedir(), '.cockpit', 'jobs');
}

/**
 * O último `rate_limit_event` de um `claude.log` + a hora aproximada dele.
 *
 * Leitura para trás em blocos de `BLOCO_CAUDA`, teto duro `TETO_CAUDA` — o MESMO padrão de
 * `lib/externo.js:313-345` ("não escrever leitura nova"), com o `carry` resolvendo tanto a
 * primeira linha cortada de cada bloco quanto a última linha do arquivo (que pode estar
 * sendo escrita agora mesmo). `try/catch` por linha: uma que não parseia é PULADA (#8/#10) —
 * o log tem centenas de linhas `system` de hook no meio.
 *
 * A hora do evento não é o `mtime` do arquivo (#34): é o `timestamp` da linha
 * `assistant`/`user` mais próxima, DEPOIS do evento — a varredura anda de trás para frente,
 * então basta ir sobrescrevendo esse candidato a cada linha com `timestamp` vista; quando o
 * evento aparece, o valor guardado é exatamente o da linha posterior a ele.
 * 🔴 Sem NENHUM `timestamp` visto na cauda antes do evento, o candidato inteiro é
 * DESCARTADO — nunca cai no `mtime` (§2.1: um evento de anteontem seguido de escrita de
 * agora ganharia idade de agora e venceria uma medição mais nova de verdade).
 *
 * @returns {Promise<?{itens: Array, medidoEmAprox: number}>}
 */
async function eventoDoLog(caminho, agora) {
  let info;
  try {
    info = await fsp.stat(caminho);
  } catch {
    return null;
  }

  const alca = await fsp.open(caminho, 'r');
  try {
    let de = info.size;
    let carry = [];
    let lidos = 0;
    let sobraTratada = false;
    let ultimoTimestamp = null;
    let encontrado = null;
    let desistir = false;   // o último rate_limit_event já foi visto: não há mais o que buscar

    while (de > 0 && !encontrado && !desistir && lidos < TETO_CAUDA) {
      const tamanhoDoBloco = Math.min(BLOCO_CAUDA, TETO_CAUDA - lidos, de);
      const novoDe = de - tamanhoDoBloco;

      const buffer = Buffer.alloc(tamanhoDoBloco);
      let preenchido = 0;
      while (preenchido < tamanhoDoBloco) {
        const { bytesRead } = await alca.read(buffer, preenchido, tamanhoDoBloco - preenchido, novoDe + preenchido);
        if (bytesRead === 0) break;
        preenchido += bytesRead;
      }
      const bloco = buffer.subarray(0, preenchido);
      lidos += bloco.length;
      if (bloco.length === 0) break;

      let corpo;
      if (novoDe > 0) {
        const nl = bloco.indexOf(10); // '\n'
        if (nl < 0) {
          // Bloco inteiro é continuação de uma linha: nada a parsear nesta volta.
          carry.unshift(bloco);
          de = novoDe;
          continue;
        }
        corpo = Buffer.concat([bloco.subarray(nl + 1), ...carry]);
        carry = [bloco.subarray(0, nl)];
      } else {
        corpo = Buffer.concat([bloco, ...carry]);
        carry = [];
      }

      const linhas = corpo.toString('utf8').split('\n');
      if (!sobraTratada) {
        linhas.pop(); // a última linha do ARQUIVO — completa ou não, nunca conta como evento
        sobraTratada = true;
      }

      // De trás para frente DENTRO do bloco: é assim que "a linha mais recentemente vista"
      // fica certa mesmo quando um bloco carrega várias linhas de uma vez.
      for (let i = linhas.length - 1; i >= 0; i--) {
        const linha = linhas[i];
        if (!linha.trim()) continue;
        let obj;
        try { obj = JSON.parse(linha); } catch { continue; }

        if ((obj.type === 'assistant' || obj.type === 'user') && typeof obj.timestamp === 'string') {
          ultimoTimestamp = obj.timestamp;
        } else if (obj.type === 'rate_limit_event') {
          // 🔴 O ÚLTIMO evento do arquivo decide, e ponto — achado ou não, a varredura ACABA
          // aqui. `break` sozinho saía só do loop do BLOCO, e o `while` seguia para blocos
          // anteriores: um evento recente sem janelas válidas fazia a função devolver um
          // evento MAIS VELHO como se fosse o consumo de agora (reproduzido pelo painel de
          // execução: 77% antigos quando os dois eventos ficavam a 70 KB um do outro).
          // `desistir` é o que leva a decisão para fora do `for`.
          desistir = true;
          if (ultimoTimestamp === null) break; // §2.1 — sem timestamp na cauda, não compete
          const medidoEmAprox = Date.parse(ultimoTimestamp);
          if (!Number.isFinite(medidoEmAprox)) break;
          const itens = janelasDoLimite(obj.rate_limit_info || {}, agora);
          if (itens) encontrado = { itens, medidoEmAprox };
          break;
        }
      }
      de = novoDe;
    }
    return encontrado;
  } finally {
    await alca.close();
  }
}

/**
 * As janelas do plano, DE GRAÇA, do último job que rodou. `null` se não houver — nunca `[]`
 * (D-b): ausência é "não sei", não "zero limite".
 *
 * Sem cache de TTL, ao contrário de `consultar()`: isto é leitura de cauda de arquivo, não
 * turno de assinatura — o mesmo espírito de `lib/abas.js:consumoDoCodex` (🔴 "aquele cache
 * tem TTL porque consultar a Anthropic CUSTA UM TURNO; isto é de graça").
 *
 * @returns {Promise<?{itens: Array, medidoEmAprox: number, fonte: 'jobs', plano: ?string}>}
 */
async function dasJanelas(agora = Date.now()) {
  let nomes;
  try {
    nomes = await fsp.readdir(dirJobs());
  } catch {
    return null; // pasta ausente, sem permissão, o que for — R6: nunca derruba a rota
  }

  const candidatos = [];
  for (const nome of nomes) {
    const caminho = path.join(dirJobs(), nome, 'claude.log');
    let stat;
    try {
      stat = await fsp.stat(caminho);
    } catch {
      continue; // não é pasta de job, ou não tem claude.log — ignora
    }
    if (agora - stat.mtimeMs > JANELA_RECENTE_MS) continue; // arquivo velho não compete
    candidatos.push({ caminho, mtime: stat.mtimeMs });
  }
  if (!candidatos.length) return null;

  // Os 5 mais recentes por mtime — não vale a pena medir mais que isso, e mede TODOS (não
  // para no primeiro que responder: `mtime` maior não é `medidoEmAprox` maior, ver P2).
  candidatos.sort((a, b) => b.mtime - a.mtime);
  const medidos = [];
  for (const candidato of candidatos.slice(0, 5)) {
    const medida = await eventoDoLog(candidato.caminho, agora).catch(() => null);
    if (!medida) continue;
    if (agora - medida.medidoEmAprox > JANELA_RECENTE_MS) continue; // idade da MEDIÇÃO, não do arquivo
    medidos.push({ ...medida, mtime: candidato.mtime });
  }
  if (!medidos.length) return null;

  // O mesmo `sort` de lib/abas.js:1365 para o Codex: medidoEmAprox decrescente, empate no mtime.
  medidos.sort((a, b) => b.medidoEmAprox - a.medidoEmAprox || b.mtime - a.mtime);
  const [vencedor] = medidos;

  return {
    itens: vencedor.itens,
    medidoEmAprox: vencedor.medidoEmAprox,
    fonte: 'jobs', // rótulo FIXO (R7) — nenhum caminho de disco sai daqui
    plano: process.env.COCKPIT_PLANO || null, // D-e: configuração opcional, nunca chumbado
  };
}

module.exports = { consultar, emCache, dasJanelas, analisar, paraEpoch, dirJobs };
