'use strict';
// Parsing e armazenamento do /status nativo do Codex CLI — a exceção restrita à D4
// (docs/arquitetura.md) pedida pelo usuário em 08/09: o Cockpit executa `/status` na pane, captura
// SÓ o bloco de resposta e devolve o texto literal. Sem parser geral de TUI: o que sai
// daqui é pequeno e versionado pela fixture da 0.153.4 (testes/fixtures/status-codex/).
//
// Sem `require('./abas')`: os dois módulos se comunicam só pelo retorno de
// `abas.consultarStatus()`, que é quem chama as funções de parsing daqui. Import circular
// nenhum, de propósito (spec `2026-09-08-resposta-status-codex-design.md`).

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const TETO_SNAPSHOT = 16 * 1024;      // 16 KiB por resposta — teto do texto guardado, EM BYTES
const TETO_SNAPSHOTS = 20;            // por sessão — histórico solicitado, sem descarte por idade
const SESSAO_ID_VALIDA = /^[\w-]{1,80}$/;
const ID_ENVIO_VALIDO = /^[\w-]{1,64}$/;

/**
 * A raiz do storage, resolvida em TEMPO DE CHAMADA — nunca uma constante de módulo.
 *
 * Mesmo hábito de `binDoClaude()`/`procRaiz()` em lib/abas.js: o gate troca de raiz entre
 * blocos de casos (mkdtemp por teste) sem mexer no `require.cache`, e a produção usa o
 * default `~/.cockpit/status-codex` sem env nenhuma.
 */
function raizStorage() {
  return process.env.COCKPIT_STATUS_CODEX_DIR || path.join(os.homedir(), '.cockpit', 'status-codex');
}

/** O arquivo de uma sessão — `null` se o id não bate no formato esperado (nunca path livre). */
function arquivoDaSessao(sessaoId) {
  if (!SESSAO_ID_VALIDA.test(String(sessaoId || ''))) return null;
  return path.join(raizStorage(), `${sessaoId}.json`);
}

/**
 * Os snapshots gravados desta sessão, mais antigo primeiro. Arquivo ausente, corrompido ou
 * com forma inesperada devolve lista vazia — nunca inventa conteúdo, nunca derruba quem
 * chamou (o fluxo SSE precisa continuar de pé mesmo com um arquivo ilegível no disco).
 */
async function lerSnapshots(sessaoId) {
  const arquivo = arquivoDaSessao(sessaoId);
  if (!arquivo) return [];
  let handle;
  try {
    handle = await fsp.open(arquivo, 'r');
    const tetoArquivo = TETO_SNAPSHOTS * TETO_SNAPSHOT * 6 + 16384;
    const tamanho = (await handle.stat()).size;
    if (tamanho > tetoArquivo) return [];
    const buffer = Buffer.alloc(Math.min(tamanho + 1, tetoArquivo + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const dados = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!Array.isArray(dados)) return [];
    const unicos = new Map();
    for (const s of dados) {
      if (!s || typeof s.id !== 'string' || !ID_ENVIO_VALIDO.test(s.id)
        || typeof s.texto !== 'string' || Buffer.byteLength(s.texto) > TETO_SNAPSHOT
        || typeof s.quando !== 'string' || !Number.isFinite(Date.parse(s.quando))
        || s.sessaoId !== sessaoId) continue;
      unicos.set(s.id, { id: s.id, sessaoId, quando: s.quando, texto: sanitizarTela(s.texto) });
    }
    return [...unicos.values()].slice(-TETO_SNAPSHOTS);
  } catch { return []; }
  finally { if (handle) await handle.close(); }
}

async function gravarSnapshots(sessaoId, lista) {
  const arquivo = arquivoDaSessao(sessaoId);
  if (!arquivo) throw Object.assign(new Error('sessaoId inválido para storage'), { codigo: 500 });
  await fsp.mkdir(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(lista), { mode: 0o600, flag: 'wx' });
    await fsp.rename(tmp, arquivo);
  } finally { await fsp.unlink(tmp).catch(() => {}); }
}

// Serializa leitura+escrita POR SESSÃO — duas consultas quase simultâneas na mesma sessão
// não podem ler o mesmo array e escrever cada uma por cima da outra (lost update). Mesmo
// desenho de `enfileirarPorAba` em lib/abas.js, só que a chave é a sessão, não a aba.
const filasPorSessao = new Map();
function enfileirarPorSessao(sessaoId, tarefa) {
  const anterior = filasPorSessao.get(sessaoId) || Promise.resolve();
  const proxima = anterior.then(tarefa, tarefa);
  filasPorSessao.set(sessaoId, proxima);
  const soltar = () => { if (filasPorSessao.get(sessaoId) === proxima) filasPorSessao.delete(sessaoId); };
  proxima.then(soltar, soltar);
  return proxima;
}

/**
 * Registra um snapshot novo — ou devolve o que já existe com este `id` (idempotência: ID
 * repetido nunca redigita nem duplica no histórico). Grava ANTES de o chamador publicar no
 * SSE (contrato do server.js: nunca anuncia o que não está no disco).
 *
 * Teto de 20 por sessão: os mais antigos saem quando o 21º chega. Isto NÃO é o descarte por
 * IDADE que a spec recusa — é o teto de CONTAGEM já decidido (D-status); nenhum snapshot
 * some antes da hora por ter "envelhecido".
 */
function registrarSnapshot(sessaoId, { id, texto, quando }) {
  if (typeof id !== 'string' || !ID_ENVIO_VALIDO.test(id)) {
    throw Object.assign(new Error('id de envio inválido'), { codigo: 400 });
  }
  return enfileirarPorSessao(sessaoId, async () => {
    const lista = await lerSnapshots(sessaoId);
    const existente = lista.find((s) => s.id === id);
    if (existente) return { criado: false, snapshot: existente };

    const snapshot = {
      id,
      sessaoId,
      quando: quando || new Date().toISOString(),
      texto: truncarPorBytes(texto, TETO_SNAPSHOT),
    };
    const nova = [...lista, snapshot].slice(-TETO_SNAPSHOTS);
    await gravarSnapshots(sessaoId, nova);
    return { criado: true, snapshot };
  });
}

/** Os snapshots desta sessão, para o replay do SSE e para o dedupe de `id` na rota. */
async function snapshotsDe(sessaoId) {
  return lerSnapshots(sessaoId);
}

// ─── parsing da TUI (só o que /status precisa; nada de parser geral) ───────────────────

const PLACEHOLDER_COMPOSER = 'Ask Codex to do anything';

/** Remove sequências CSI (`\x1b[...letra`) — cor, negrito, dim. Não mexe em `\n`. */
function limparAnsi(texto) {
  return String(texto || '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Tira o que não é texto (controle) e normaliza quebra de linha, DEPOIS de tirar o ANSI. */
function sanitizarTela(bruto) {
  return limparAnsi(bruto)
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * A linha do composer — aquela cujo PRIMEIRO caractere visível (depois de tirar ANSI e
 * espaço) é o marcador `›`. Varre de BAIXO para cima: o composer é o último elemento
 * interativo da pane, então a busca acha ele antes de qualquer eco antigo.
 *
 * Exigir que `›` seja o PRIMEIRO caractere — não `.includes('›')` em qualquer posição —
 * é o que distingue o composer de uma fala de transcrição que meramente CONTÉM um `›` no
 * meio da prosa (achado de revisão, 08/09: aceitar qualquer linha com `›` deixava um
 * rascunho antigo, ou uma fala citando o símbolo, ser lido como se fosse a caixa de texto).
 * Devolve também o ÍNDICE e todas as linhas, para o chamador conferir a linha SEGUINTE.
 */
function dadosDoComposer(brutoAnsi) {
  const linhas = String(brutoAnsi || '').split('\n');
  for (let i = linhas.length - 1; i >= 0; i -= 1) {
    if (/^›(?: |$)/.test(limparAnsi(linhas[i]))) {
      return { linha: linhas[i], abaixo: linhas.slice(i + 1) };
    }
  }
  return null;
}

function linhaDoComposer(brutoAnsi) { return dadosDoComposer(brutoAnsi)?.linha || null; }

// Só o rodapé conhecido ou o autocomplete exato podem aparecer depois da caixa.
// Qualquer outra linha é continuação de rascunho ou layout desconhecido: recusa.
function abaixoReconhecido(abaixo, autocomplete) {
  const linhas = abaixo.map(limparAnsi).filter(l => l.trim());
  if (!linhas.length) return true;
  if (autocomplete && linhas.length === 2
    && /^  \/status\s+show current session configuration and token usage\s*$/.test(linhas[0])
    && /^  \/statusline\s+configure which items appear in the status line\s*$/.test(linhas[1])) return true;
  return linhas.length === 1 && /^  [^›\n]+ · [^\n]+$/.test(linhas[0]);
}

function composerVazio(brutoAnsi) {
  const dados = dadosDoComposer(brutoAnsi);
  if (!dados || !abaixoReconhecido(dados.abaixo, false)) return false;
  const restoRaw = dados.linha.slice(dados.linha.indexOf('›') + 1);
  const resto = limparAnsi(restoRaw).trim();
  if (!resto) return true;
  // Placeholder inteiro dim; palavras digitadas sem esse estilo nunca contam como vazio.
  return resto === PLACEHOLDER_COMPOSER && /\x1b\[(?:0;)?2m/.test(restoRaw);
}

function composerContemExatamente(brutoAnsi, esperado) {
  const dados = dadosDoComposer(brutoAnsi);
  return Boolean(dados && abaixoReconhecido(dados.abaixo, true)
    && limparAnsi(dados.linha).slice(1).trim() === esperado);
}

// O scrollback pode cortar marcadores. Se a contagem não cresceu, não há prova de novidade.
function capturaNova(antes, depois) {
  const contar = t => sanitizarTela(t).split('\n').filter(l => l.trim() === '/status').length;
  return contar(depois) > contar(antes);
}

/**
 * O bloco COMPLETO da última execução de `/status`, ou o motivo de não ter achado.
 *
 * Algoritmo (pequeno de propósito, só o que a fixture da 0.153.4 pede):
 *   1. acha a ÚLTIMA linha que é exatamente `/status` (o eco do comando, em linha própria).
 *      Pega a ÚLTIMA — não a primeira — para nunca confundir uma resposta velha, ainda
 *      visível no scrollback, com a que acabou de sair.
 *   2. dali para baixo, acha a moldura: linha que abre com `╭`/`┌` até a que fecha com
 *      `╰`/`┘`. Sem as duas, a resposta ainda não terminou de desenhar (retry, não erro).
 *   3. dentro do bloco, o campo `Session:` tem que casar com `sessaoIdEsperada` — resposta
 *      de outra sessão nunca é aceita como se fosse desta.
 *
 * `sessaoIdEsperada` obrigatória: sem ela nada pode ser confirmado como "desta sessão".
 */
function extrairBlocoStatus(capturaBruta, sessaoIdEsperada) {
  if (!sessaoIdEsperada) return { ok: false, motivo: 'sessao-desconhecida' };
  const linhas = sanitizarTela(capturaBruta).split('\n');

  let marcador = -1;
  for (let i = linhas.length - 1; i >= 0; i -= 1) {
    if (linhas[i].trim() === '/status') { marcador = i; break; }
  }
  if (marcador < 0) return { ok: false, motivo: 'sem-marcador' };

  const apos = linhas.slice(marcador + 1);
  const inicio = apos.findIndex((l) => /^[╭┌]/.test(l.trim()));
  if (inicio < 0) return { ok: false, motivo: 'sem-moldura' };
  const fim = apos.findIndex((l, i) => i > inicio && /^[╰└]/.test(l.trim()));
  if (fim < 0) return { ok: false, motivo: 'moldura-incompleta' };

  const bloco = apos.slice(inicio, fim + 1);
  const texto = bloco.join('\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  const casamento = /Session:\s*([0-9a-fA-F-]{6,})/.exec(texto);
  if (!casamento) return { ok: false, motivo: 'sem-session' };
  if (casamento[1] !== sessaoIdEsperada) return { ok: false, motivo: 'sessao-divergente' };

  if (Buffer.byteLength(texto) > TETO_SNAPSHOT) return { ok: false, motivo: 'bloco-grande' };
  return { ok: true, texto };
}

/**
 * Corta `texto` em `tetoBytes` BYTES (UTF-8), não caracteres. Achado de revisão (08/09):
 * `String.slice()` conta code units, e a moldura do bloco é cheia de box-drawing (`╭│╰`),
 * que são multibyte em UTF-8 — um corte por caractere podia gravar MAIS de 16 KiB reais no
 * disco. Cortar o `Buffer` no meio de um caractere multibyte decodifica o resto como
 * `U+FFFD` (replacement character): degrada visualmente na borda, nunca quebra o JSON.
 */
function truncarPorBytes(texto, tetoBytes) {
  const str = sanitizarTela(texto);
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= tetoBytes) return str;
  // O corte em `tetoBytes` pode cair NO MEIO de um caractere multibyte. `toString('utf8')`
  // decodifica o resto incompleto como `U+FFFD` (replacement character) — que sozinho
  // ocupa 3 bytes em UTF-8. Cortar exatamente no byte pode, então, devolver uma STRING que
  // reencodada excede levemente o teto. Em vez de confiar no corte único, apara um
  // caractere de cada vez até o resultado caber de verdade — poucas iterações no pior caso.
  let cortado = buf.subarray(0, tetoBytes).toString('utf8');
  while (Buffer.byteLength(cortado, 'utf8') > tetoBytes) cortado = cortado.slice(0, -1);
  return cortado;
}

module.exports = {
  raizStorage, arquivoDaSessao,
  registrarSnapshot, snapshotsDe,
  composerVazio, composerContemExatamente, linhaDoComposer,
  extrairBlocoStatus, sanitizarTela, limparAnsi, capturaNova, truncarPorBytes,
  TETO_SNAPSHOT, TETO_SNAPSHOTS,
};
