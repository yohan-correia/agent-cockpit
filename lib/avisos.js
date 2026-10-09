'use strict';
// Quem recebe as notificações, e quando disparar.
//
// A parte de criptografia mora em lib/push.js. Aqui é a parte chata e necessária: guardar
// as inscrições dos aparelhos, decidir o texto do aviso e limpar o que morreu.
//
// Estado no disco, como todo o resto do cockpit: um restart do serviço não pode fazer o
// celular parar de receber.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const push = require('./push');
const entregas = require('./entregas');

// Sobrescrito nos testes, para o gate não mexer nas inscrições de verdade do usuário.
const DIR = process.env.COCKPIT_PUSH_DIR || path.join(os.homedir(), '.cockpit', 'push');
const ARQ_VAPID = path.join(DIR, 'vapid.json');
const ARQ_INSCRICOES = path.join(DIR, 'inscricoes.json');
const ARQ_PENDENTES = path.join(DIR, 'pendentes.json');
// Quem já recebeu qual aviso (lib/entregas.js). Mora DENTRO da pasta de push: herda a trava
// de isolamento dos testes (COCKPIT_PUSH_DIR, armadilha #62) sem variável nova.
const livro = entregas.criar(path.join(DIR, 'entregas'));

/**
 * A política de reenvio (spec 2026-09-11-push-retry-persistente §2.1).
 *
 * `PRAZO_MS` é TETO, não régua (#46): a pergunta "o aviso ainda vale?" é de quem o gerou — o vigia
 * passa `aindaVale` e a fila pergunta a cada reenvio. O prazo só decide onde ninguém pergunta:
 * fila restaurada depois de um restart, o botão "testar", o fluxo de sessões.
 */
const POLITICA = Object.freeze({
  MAX_TENTATIVAS: 5,         // a original + 4 repetições
  BASE_MS: 10000,            // 10 s → 30 s → 90 s → 270 s (nominais)
  FATOR: 3,
  PRAZO_MS: 15 * 60 * 1000,  // contado de quando o avisar() começou
  PISO_ARMAR_MS: 1000,       // trava contra laço quente no relógio de reenvio
});

// Só erro de REDE se repete. `push.enviar` também lança síncrono, antes da rede, para chave do
// aparelho podre, chave VAPID podre e endpoint que não é URL — repetir não conserta nenhum desses.
const ERROS_DE_REDE = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
  'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED']);

function agendarDeVerdade(fn, ms) {
  // O teto é o int32 do setTimeout: acima dele o Node dispara em 1 ms (lib/vigia-abas.js:144-147).
  const t = setTimeout(fn, Math.min(Math.max(0, ms), 2147483647));
  t.unref();
  return () => clearTimeout(t);
}
const RELOGIO_PADRAO = { agora: () => Date.now(), aleatorio: Math.random, agendar: agendarDeVerdade };
let relogio = RELOGIO_PADRAO;

/**
 * Troca o relógio. SÓ para o gate, como `bater`/`relogio` do vigia: a produção nunca chama isto.
 * Sem ele, provar 10 s → 30 s → 90 s → 270 s custaria minutos por rodada de `npm test`.
 * `usarRelogio({})` volta ao padrão.
 */
function usarRelogio(novo = {}) { relogio = { ...RELOGIO_PADRAO, ...novo }; }

/** `Retry-After` em segundos ou em data HTTP (RFC 9110 §10.2.3). Inválido ⇒ `null`. */
function lerRetryAfter(valor, agora) {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor).trim();
  if (/^\d+$/.test(texto)) return Number(texto) * 1000;
  const data = Date.parse(texto);
  return Number.isFinite(data) ? Math.max(0, data - agora) : null;
}

/**
 * O que fazer com a resposta de UM envio (spec §2.2). `aceito` = o serviço aceitou (2xx) — NÃO
 * prova que a notificação apareceu na tela.
 */
function classificar(resposta, erro, agora = relogio.agora()) {
  if (erro) {
    return ERROS_DE_REDE.has(erro.code)
      ? { classe: 'transitoria', motivo: erro.code, esperaMs: null }
      : { classe: 'definitiva', motivo: erro.code || 'erro local', esperaMs: null };
  }
  const status = resposta && resposta.status;
  if (status >= 200 && status < 300) return { classe: 'aceito', motivo: `HTTP ${status}`, esperaMs: null };
  if (status === 404 || status === 410) return { classe: 'morta', motivo: `HTTP ${status}`, esperaMs: null };
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
    return { classe: 'transitoria', motivo: `HTTP ${status}`, esperaMs: lerRetryAfter(resposta.retryAfter, agora) };
  }
  // 400, 401, 403, 413 e o resto: repetir não conserta. 401/403 é VAPID/configuração — NÃO
  // remover a inscrição nem tocar o vapid.json (#14).
  return { classe: 'definitiva', motivo: `HTTP ${status}`, esperaMs: null };
}

/** Backoff com "equal jitter", nunca abaixo do que o serviço pediu. */
function atrasoDa(tentativas, esperaMs) {
  const nominal = POLITICA.BASE_MS * POLITICA.FATOR ** (tentativas - 1);
  return Math.max(nominal * (0.5 + 0.5 * relogio.aleatorio()), esperaMs ?? 0);
}

/** Quando tentar de novo, ou `null` se esgotou (teto de tentativas ou prazo). */
function proximaTentativa(tentativas, esperaMs, criadoEm, agora) {
  if (tentativas >= POLITICA.MAX_TENTATIVAS) return null;
  const proxima = agora + atrasoDa(tentativas, esperaMs);
  return proxima > criadoEm + POLITICA.PRAZO_MS ? null : proxima;
}

/** A frase do 502 de `/api/push/teste` (spec §3.8). Nunca termina em ": " pendurado. */
function explicarRecusa({ pendentes = 0, falhas = 0, removidos = 0 } = {}) {
  const partes = [];
  if (pendentes) partes.push(`${pendentes} aparelho(s) aguardando nova tentativa`);
  if (falhas) partes.push(`${falhas} com falha definitiva (veja o log do servidor)`);
  if (removidos) partes.push(`${removidos} inscrição(ões) expirada(s) e removida(s) — reative os avisos neste aparelho`);
  return partes.length
    ? `o serviço de push não aceitou o aviso: ${partes.join('; ')}`
    : 'o serviço de push não aceitou o aviso (veja o log do servidor)';
}

const hostDe = (endpoint) => { try { return new URL(endpoint).hostname; } catch { return 'endpoint inválido'; } };

function contato() {
  const valor = (process.env.COCKPIT_CONTATO || '').trim();
  let valido = /^mailto:[^@\s]+@[^@\s]+$/.test(valor);
  try {
    const url = new URL(valor);
    valido ||= url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { /* a mensagem abaixo explica como configurar */ }
  if (!valido) throw Object.assign(new Error(
    'Configure COCKPIT_CONTATO com mailto:seu-email ou uma URL HTTPS de contato para ativar notificações.'
  ), { codigo: 503 });
  return valor;
}

/**
 * As chaves do servidor, criadas na primeira vez e nunca mais.
 *
 * Trocar esse par invalida TODAS as inscrições já feitas: o aparelho guarda a chave
 * pública no momento em que se inscreve, e o push server recusa um remetente diferente.
 * Por isso o arquivo é criado uma vez e só lido depois.
 */
function chaves() {
  try {
    return JSON.parse(fs.readFileSync(ARQ_VAPID, 'utf8'));
  } catch (erro) {
    // ENOENT é a primeira execução: gerar é o certo. QUALQUER outra coisa é um par que EXISTE e
    // não pôde ser lido — sobrescrever ali invalida todas as inscrições (#14) sem ninguém saber.
    // Falhar alto é o único desfecho honesto: o dono reinscreve por decisão dele, não por um catch.
    if (erro.code !== 'ENOENT') {
      throw Object.assign(new Error(`vapid.json existe e não pôde ser lido (${erro.message}) — não vou sobrescrever`), { codigo: 500 });
    }
    fs.mkdirSync(DIR, { recursive: true });
    const novas = push.gerarVapid();
    fs.writeFileSync(ARQ_VAPID, JSON.stringify(novas, null, 2), { mode: 0o600 });
    return novas;
  }
}

async function inscricoes() {
  try {
    return JSON.parse(await fsp.readFile(ARQ_INSCRICOES, 'utf8'));
  } catch (erro) {
    // ENOENT é "ninguém se inscreveu ainda" — `[]` é a resposta certa. Outra coisa (permissão, JSON
    // truncado) é arquivo que EXISTE e não pôde ser lido: devolver `[]` faz `avisar()` sair em `:112`
    // com sucesso e zero envios, e o push para em SILÊNCIO. Com o vigia esse silêncio é para sempre.
    if (erro.code !== 'ENOENT') throw erro;
    return [];
  }
}

async function gravar(lista) {
  await fsp.mkdir(DIR, { recursive: true });
  await fsp.writeFile(ARQ_INSCRICOES, JSON.stringify(lista, null, 2), { mode: 0o600 });
}

// Uma fila para o arquivo de inscrições. `inscrever`, `descadastrar`, `conhece` e as duas metades
// do `avisar` (a leitura e a limpeza dos mortos) mutam ou leem o MESMO arquivo, e todas fazem
// ler → decidir → gravar com `await` no meio: sem fila, duas se intercalam e a que chega depois
// grava por cima de uma decisão que não viu. O caso que dói é o descadastro REVERTIDO — um
// aparelho que o dono removeu volta a receber título de conversa e nome de projeto.
//
// `.then(tarefa, tarefa)`: tarefa que rejeita não pode envenenar a fila para as seguintes.
let filaInscricoes = Promise.resolve();
const naFila = (tarefa) => { filaInscricoes = filaInscricoes.then(tarefa, tarefa); return filaInscricoes; };

/** O endpoint identifica o aparelho: reinscrever no mesmo celular atualiza, não duplica. */
async function inscrever(inscricao) {
  contato();
  if (!inscricao?.endpoint || !inscricao?.keys?.p256dh || !inscricao?.keys?.auth) {
    throw new Error('inscrição incompleta');
  }
  return naFila(async () => {
    const lista = (await inscricoes()).filter((i) => i.endpoint !== inscricao.endpoint);
    lista.push({
      endpoint: inscricao.endpoint,
      keys: { p256dh: inscricao.keys.p256dh, auth: inscricao.keys.auth },
      aparelho: nomeLimpo(inscricao.aparelho),
      criadoEm: new Date().toISOString(),
    });
    await gravar(lista);
    // O `nome` volta JÁ LIMPO: server.js loga a linha da inscrição com ele, nunca com o
    // `corpo.aparelho` cru da rede (§3.1). O `id` é o que a tela usa para abrir a lista na
    // linha nova (§4.4).
    return { inscritos: lista.length, id: idDe(inscricao.endpoint), nome: nomeLimpo(inscricao.aparelho) };
  });
}

/**
 * O cockpit já conhece esta inscrição?
 *
 * Serve ao diagnóstico da tela: "permissão granted + sw ativo" não distingue um aparelho
 * que se inscreveu de um que assinou no PushManager e nunca conseguiu registrar aqui — e
 * era essa a dúvida que sobrava quando o botão falhava com "Failed to fetch".
 *
 * Só responde sim/não sobre um endpoint que o aparelho já tem: não devolve a lista, que é
 * credencial dos outros aparelhos.
 */
async function conhece(endpoint) {
  const lista = await naFila(() => inscricoes());
  const conhecida = lista.some((i) => i.endpoint === endpoint);
  // O `id` é como o aparelho corrente acha a linha DELE na lista sem guardar estado (§4.3).
  return { conhecida, inscritos: lista.length, id: conhecida ? idDe(endpoint) : null };
}

async function descadastrar(endpoint) {
  return naFila(async () => {
    const lista = await inscricoes();
    const restante = lista.filter((i) => i.endpoint !== endpoint);
    await gravar(restante);
    return { removidos: lista.length - restante.length, inscritos: restante.length };
  });
}

// ── Nome do aparelho (spec 2026-09-12-nome-do-aparelho-no-push) ──────────────────────────
//
// O campo `aparelho` existe desde sempre e ninguém o lia. Daqui para baixo ele passa a
// valer: a tela lista, o dono renomeia, e o journal nomeia quem recebeu.

/** O id público do aparelho. Derivado, não gravado: as inscrições antigas já o têm (§2.3). */
const idDe = (endpoint) => entregas.resumo(String(endpoint));   // §2.3: uma fonte só

/**
 * O nome como ele entra no disco. Os caracteres de CONTROLE morrem aqui, antes do `slice`:
 * este texto vai para o journal (§3.2, §3.3), e um `\n` no meio dele FABRICA uma linha de log
 * inteira — "push: inscrito X" seguido do que o dono quiser que pareça uma mensagem do
 * servidor. O `trim()` sozinho não pega quebra no MEIO, nem ESC.
 */
// `\p{Cc}` (os controles, onde moram `\n`, `\r` e o ESC) MAIS os seis de reordenação bidi — e não
// `\p{Cf}` inteiro, que levaria junto o ZWJ (U+200D) e quebraria "👨‍💻 Notebook" em glifos soltos,
// calado. Injeção de log é o risco; emoji composto não é.
const CONTROLES = /[\p{Cc}\u202A-\u202E\u2066-\u2069]+/gu;
const nomeLimpo = (nome) => String(nome ?? '').replace(CONTROLES, ' ').trim().slice(0, 80);

/**
 * O nome que a tela e o journal mostram: vazio vira null, para quem chama decidir a legenda.
 *
 * Limpa na SAÍDA, não só na entrada — as inscrições que já estão no disco foram gravadas pelo
 * `slice(0, 80)` de hoje, que aceita `\n` no meio. Sanitizar só o que entra deixaria o valor
 * ANTIGO fabricando linha no log, e migrar o arquivo por causa disso seria caro e desnecessário.
 */
const nomeDeAparelho = (inscricao) => nomeLimpo(inscricao?.aparelho) || null;

/** A lista para a tela: SEM endpoint, SEM keys. O `id` é derivado (§2.3). */
async function listar() {
  const lista = await naFila(() => inscricoes());
  return { aparelhos: lista.map((i) => ({
    id: idDe(i.endpoint),
    nome: nomeDeAparelho(i),
    criadoEm: i.criadoEm || null,
  })) };
}

/** Troca SÓ o nome. `{ renomeados: 0 }` = id desconhecido (aparelho descadastrado no meio). */
async function renomear(id, nome) {
  const limpo = nomeLimpo(nome);
  return naFila(async () => {
    const lista = await inscricoes();
    let renomeados = 0;
    for (const i of lista) if (idDe(i.endpoint) === id) { i.aparelho = limpo; renomeados += 1; }
    if (renomeados) await gravar(lista);
    return { renomeados, nome: limpo };
  });
}

const TETO_NOME_LOG = 32;   // o mesmo número do TETO_NOME da tela (§4.2), pelo mesmo motivo:
                            // os 3 de produção têm 80 caracteres de UA cru, e meia user agent no
                            // começo da linha não ajuda ninguém a achar nada.

/** O nome, se ele servir de rótulo. `null` quando não serve — para quem chama decidir o que pôr. */
const nomeCurto = (nome) => (nome && nome.length <= TETO_NOME_LOG ? nome : null);

/**
 * O rótulo para uma linha de log que NÃO tem outro identificador. O fallback não é vazio: seria
 * uma faixa muda entre 33 e 80 caracteres, em que um nome legítimo some do journal calado. Entra
 * o id curto — os MESMOS 8 hex que a lista mostra (§4.3) —, então toda linha liga de volta à tela.
 */
const rotuloDeLog = (nome, endpoint) => nomeCurto(nome) || idDe(endpoint).slice(0, 8);

// O host NUNCA sai da linha: é ele que distingue FCM de Apple no diagnóstico.
const quem = (inscricao) => `${rotuloDeLog(nomeDeAparelho(inscricao), inscricao.endpoint)} (${hostDe(inscricao.endpoint)})`;

// A fila de reenvio (spec §3.3). A memória é a verdade; o disco é para o restart.
let fila = null;                 // null = ainda não carregou NESTE processo
let soMemoria = false;           // arquivo ilegível que nem deu para renomear: nunca gravar por cima
let gravacao = Promise.resolve();
const errosDeGravacao = new Set();
let ultimoErroLocal = null;
let cancelarRelogio = null;
let processando = false;
let contador = 0;
const ultimaSeq = new Map();     // tag -> seq do avisar() mais novo daquela tag

const registroValido = (r) => r && typeof r.id === 'string' && typeof r.endpoint === 'string'
  && typeof r.texto === 'string' && (r.tag === null || typeof r.tag === 'string')
  && [r.tentativas, r.criadoEm, r.proximaEm].every(Number.isFinite);

// Log de erro da fila: SÓ o código/nome, nunca `erro.message`. A mensagem de um `JSON.parse`
// traz um pedaço do texto inválido — e esse texto é o payload (título da aba, pasta) ou, no
// vapid.json, a chave privada. O endpoint também é credencial (server.js:1287-1288).
const codigoDe = (erro) => (erro && (erro.code || erro.name)) || 'erro';

function separarIlegivel(erro) {
  console.error(`push: pendentes.json ilegível (${codigoDe(erro)}) — separado como pendentes.json.ilegivel`);
  // UM arquivo só: ele guarda endpoints, que são credencial, e não pode se acumular.
  try { fs.renameSync(ARQ_PENDENTES, `${ARQ_PENDENTES}.ilegivel`); }
  catch (e) {
    soMemoria = true;
    console.error(`push: não deu para separar o pendentes.json (${codigoDe(e)}) — a fila roda só em memória`);
  }
}

/**
 * Carrega a fila UMA vez por processo, na primeira operação que a toca. Carga preguiçosa é decisão:
 * se só `retomar()` carregasse, um processo que não o chamou gravaria `[]` por cima da fila de antes
 * do restart (spec §3.3). Na primeira carga com registros, arma o relógio.
 */
function garantirFila() {
  if (fila) return fila;
  fila = [];
  let lidos;
  try {
    lidos = JSON.parse(fs.readFileSync(ARQ_PENDENTES, 'utf8'));
    if (!Array.isArray(lidos)) throw new Error('não é uma lista');
  } catch (erro) {
    if (erro.code !== 'ENOENT') separarIlegivel(erro);
    return fila;
  }
  fila = lidos.filter(registroValido);
  armar();
  return fila;
}

/**
 * Grava um retrato inteiro, serializado, com tmp + rename. NUNCA rejeita: a fila é acessória e não
 * pode derrubar o envio de primeira mão. Falha ⇒ uma linha por código de erro e segue em memória.
 */
function persistir() {
  gravacao = gravacao.then(async () => {
    if (soMemoria) return;
    const retrato = JSON.stringify(fila.map(({ aindaVale, ...resto }) => resto), null, 2);
    const tmp = `${ARQ_PENDENTES}.tmp`;
    try {
      await fsp.mkdir(DIR, { recursive: true });
      await fsp.writeFile(tmp, retrato, { mode: 0o600 });
      await fsp.rename(tmp, ARQ_PENDENTES);
      errosDeGravacao.clear();
    } catch (erro) {
      const marca = codigoDe(erro);
      if (!errosDeGravacao.has(marca)) {
        errosDeGravacao.add(marca);
        console.error(`push: não deu para gravar a fila de reenvio (${marca}) — segue em memória`);
      }
    }
  });
  return gravacao;
}

const existe = (id) => fila.some((r) => r.id === id);
const remover = (id) => { fila = fila.filter((r) => r.id !== id); };

function logarErroLocal(erro) {
  const marca = codigoDe(erro);
  if (marca === ultimoErroLocal) return;
  ultimoErroLocal = marca;
  // `chaves()` (:48) embute o `erro.message` do JSON.parse do vapid.json na própria mensagem —
  // imprimir `erro.message` aqui poderia vazar pedaço da chave privada no journal.
  console.error(`push: reenvio adiado por erro local (${marca}) — nova tentativa em ${POLITICA.BASE_MS / 1000} s`);
}

/**
 * Agenda `processarPendentes` para o próximo `proximaEm` da fila (ou não agenda nada, se ela
 * estiver vazia). Chamada sempre que a fila muda de forma que o próximo disparo pode ter mudado.
 */
function armar() {
  if (cancelarRelogio) { cancelarRelogio(); cancelarRelogio = null; }
  if (!fila.length) return;
  const proximaEm = Math.min(...fila.map((r) => r.proximaEm));
  const ms = Math.max(POLITICA.PISO_ARMAR_MS, proximaEm - relogio.agora());
  cancelarRelogio = relogio.agendar(() => { cancelarRelogio = null; return processarPendentes(); }, ms);
}

/** Descarta todo pendente da `tag` — o "mais novo vence" (spec §3.5) estendido à fila. */
async function descartarPendentes(tag) {
  if (!tag) return 0;
  garantirFila();
  const antes = fila.length;
  fila = fila.filter((r) => r.tag !== tag);
  const removidos = antes - fila.length;
  if (removidos) { armar(); await persistir(); }
  return removidos;
}

/** `tentar()`: também pega o lançamento SÍNCRONO de `push.enviar` (chave podre, endpoint ruim). */
async function tentar(inscricao, texto, vapid, remetente) {
  try { return { resposta: await push.enviar({ inscricao, texto, vapid, contato: remetente }) }; }
  catch (erro) { return { erro }; }
}

/**
 * Limpa as inscrições mortas (404/410), relendo o disco (mesmo raciocínio de `avisar()` abaixo):
 * entre a leitura da lista e a resposta de rede, um `inscrever`/`descadastrar` concorrente pode
 * ter mudado o arquivo, e gravar por cima da lista velha reverteria essa mudança.
 */
async function limparMortos(mortos) {
  if (!mortos.length) return 0;
  try {
    await naFila(async () => {
      const atual = await inscricoes();
      await gravar(atual.filter((i) => !mortos.includes(i.endpoint)));
    });
    return mortos.length;
  } catch (erro) {
    console.error(`push: não deu para limpar inscrição(ões) morta(s) (${codigoDe(erro)})`);
    return 0;
  }
}

/**
 * O relógio de reenvio (spec §3.6, passos 1-10, nesta ordem — não reordenar). Nunca é chamado
 * mais de uma vez ao mesmo tempo (`processando`), e nunca deixa uma rejeição escapar para o
 * `setTimeout` que o disparou (Node 22 derruba o processo nesse caso).
 */
async function processarPendentes() {
  if (processando) return;
  processando = true;
  try {
    garantirFila();
    const agoraPoda = relogio.agora();
    let podou = false;
    for (const r of [...fila]) {
      if (agoraPoda > r.criadoEm + POLITICA.PRAZO_MS) {
        remover(r.id);
        podou = true;
        console.error(`push: desisti de ${hostDe(r.endpoint)} — passou do prazo (${r.tag ?? 'sem tag'})`);
      }
    }

    const vencidos = fila.filter((r) => r.proximaEm <= agoraPoda);
    if (!vencidos.length) { if (podou) await persistir(); return; }

    let remetente;
    let vapid;
    try {
      remetente = contato();
      vapid = chaves();
    } catch (erro) {
      logarErroLocal(erro);
      const agoraAdiar = relogio.agora();
      for (const r of vencidos) r.proximaEm = agoraAdiar + POLITICA.BASE_MS;
      await persistir();
      return;
    }

    // Teto de tentativas ANTES da rede — segura o caso "crash durante a 5ª requisição".
    const lote = [];
    for (const r of vencidos) {
      if (r.tentativas >= POLITICA.MAX_TENTATIVAS) {
        remover(r.id);
        console.error(`push: desisti de ${hostDe(r.endpoint)} após ${r.tentativas} tentativa(s) (teto atingido)`);
      } else {
        lote.push(r);
      }
    }
    if (!lote.length) { await persistir(); return; }

    // Write-ahead: conta a tentativa ANTES de mandar, e grava — um crash durante a requisição
    // deixa a tentativa contada no disco.
    for (const r of lote) r.tentativas += 1;
    await persistir();

    let lista;
    try {
      lista = await naFila(() => inscricoes());
    } catch (erro) {
      logarErroLocal(erro);
      for (const r of lote) {
        if (existe(r.id)) { r.tentativas -= 1; r.proximaEm = relogio.agora() + POLITICA.BASE_MS; }
      }
      await persistir();
      return;
    }
    ultimoErroLocal = null;

    // A PARTIR DAQUI, nenhum `await` até disparar as requisições — fecha a janela do descadastro.
    const agora = relogio.agora();
    const mortos = [];
    const envios = [];
    for (const r of lote) {
      if (!existe(r.id)) continue;
      if (agora > r.criadoEm + POLITICA.PRAZO_MS) {
        remover(r.id);
        console.error(`push: desisti de ${hostDe(r.endpoint)} — passou do prazo (${r.tag ?? 'sem tag'})`);
        continue;
      }
      if (r.aindaVale) {
        let vale;
        try { vale = r.aindaVale(); }
        catch (erro) { vale = true; console.error(`push: aindaVale de ${r.tag ?? 'sem tag'} falhou (${codigoDe(erro)}) — enviando assim mesmo`); }
        if (!vale) {
          remover(r.id);
          console.log(`push: aviso de ${r.tag} perdeu a validade; reenvio cancelado`);
          continue;
        }
      }
      const insc = lista.find((i) => i.endpoint === r.endpoint);
      if (!insc) { remover(r.id); continue; }
      envios.push(tentar(insc, r.texto, vapid, remetente).then(aplicar(r)));
    }

    function aplicar(r) {
      return ({ resposta, erro }) => {
        const c = classificar(resposta, erro, relogio.agora());
        if (c.classe === 'morta') mortos.push(r.endpoint);
        if (!existe(r.id)) return;
        r.ultimoMotivo = c.motivo;
        const host = hostDe(r.endpoint);
        if (c.classe === 'aceito') {
          remover(r.id);
          console.log(`push: ${host} aceitou na tentativa ${r.tentativas}`);
        } else if (c.classe === 'morta' || c.classe === 'definitiva') {
          remover(r.id);
          if (c.classe === 'definitiva') console.error(`push: ${host} recusou (${c.motivo}) — não vou repetir`);
        } else {
          const p = proximaTentativa(r.tentativas, c.esperaMs, r.criadoEm, relogio.agora());
          if (p === null) {
            remover(r.id);
            console.error(`push: desisti de ${host} após ${r.tentativas} tentativas (último: ${c.motivo})`);
          } else {
            r.proximaEm = p;
            console.error(`push: nova tentativa em ${Math.round((p - relogio.agora()) / 1000)}s (${r.tentativas}/${POLITICA.MAX_TENTATIVAS})`);
          }
        }
      };
    }

    await Promise.all(envios);
    await limparMortos(mortos);
    await persistir();
  } catch (erro) {
    console.error(`push: reenvio falhou (${codigoDe(erro)})`);
  } finally {
    processando = false;
    armar();
  }
}

/** O restart: nunca lança (spec §3.7). Não reinicia contagem nem prazo do que já está no disco. */
function retomar() {
  try {
    try { contato(); } catch { return 0; }   // trava de isolamento (#62), calada
    garantirFila();
    const agora = relogio.agora();
    const antes = fila.length;
    fila = fila.filter((r) => agora <= r.criadoEm + POLITICA.PRAZO_MS);
    if (fila.length !== antes) persistir();  // nunca rejeita
    armar();
    if (fila.length) console.log(`push: ${fila.length} aviso(s) pendente(s) retomado(s)`);
    return fila.length;
  } catch (erro) {
    console.error(`push: não deu para retomar a fila de reenvio (${codigoDe(erro)})`);
    return 0;
  }
}

const copiaDosPendentes = () => garantirFila().map((r) => ({ ...r }));

/**
 * Manda o aviso para todos os aparelhos inscritos. Resolve depois da PRIMEIRA tentativa; falha
 * temporária vai para a fila de reenvio, que roda no relógio deste módulo e nunca dentro da
 * promessa de quem chamou.
 *
 * 404 e 410 significam inscrição morta — app desinstalado, permissão revogada, navegador
 * limpo. Some da lista na hora: sem isso ela só cresce e cada turno vira uma rajada de
 * requisições para endpoints que não existem mais.
 *
 * `evento` (lib/entregas.js) é opcional: com ele, aparelho que já recebeu este evento não
 * recebe de novo — nem de outro observador, nem de um reenvio. `enviados`/`removidos` contam
 * o que ESTA chamada fez.
 */
async function avisar({ titulo, corpo, sessaoId, tag, aindaVale, evento = null } = {}) {
  const chave = tag || sessaoId || null;
  const criadoEm = relogio.agora();
  const seq = ++contador;
  garantirFila();
  if (chave) { ultimaSeq.set(chave, seq); await descartarPendentes(chave); }

  const lista = await naFila(() => inscricoes());
  if (!lista.length) return { inscritos: 0, enviados: 0, pendentes: 0, falhas: 0, removidos: 0, nomes: [] };

  const remetente = contato();
  const vapid = chaves();
  const texto = JSON.stringify({ titulo, corpo, sessaoId, tag: tag || sessaoId });   // linha de hoje, intocada
  const mortos = [];
  const novos = [];
  // Na posição da inscrição, não na ordem em que a rede responde: com 3 aparelhos e o corte
  // em dois nomes + "e mais 1" (§4.2), o par exibido mudaria a cada clique no botão testar.
  const aceitos = [];
  let enviados = 0;
  let falhas = 0;

  // A PRIMEIRA tentativa de cada aparelho passa pelo livro (D47); o corpo é o da fila de
  // reenvio (D45). O desfecho que volta é o que o livro grava: 'aceito' e 'descartado' são
  // FINAIS (ninguém mais tenta este evento neste aparelho); 'falhou' e 'incerto' não são —
  // é o reenvio da fila que decide, e ele passa pelo livro de novo.
  await Promise.all(lista.map((inscricao, indice) => livro.umaVez(evento, inscricao.endpoint, async () => {
    const { resposta, erro } = await tentar(inscricao, texto, vapid, remetente);
    const c = classificar(resposta, erro, relogio.agora());
    if (c.classe === 'aceito') { enviados += 1; aceitos[indice] = nomeDeAparelho(inscricao); return 'aceito'; }
    if (c.classe === 'morta') { mortos.push(inscricao.endpoint); return 'descartado'; }
    if (c.classe === 'definitiva') { falhas += 1; console.error(`push: ${quem(inscricao)} recusou (${c.motivo}) — não vou repetir`); return 'falhou'; }
    // Transitória: quem lançou (timeout, rede) pode ter chegado ao serviço, e vira 'incerto';
    // status HTTP que não passou é 'falhou'. Nenhum dos dois é final (§2.6 da spec do livro).
    // LACUNA CONHECIDA do encontro das duas features: o registro da fila não carrega `evento`,
    // então `processarPendentes()` reenvia SEM passar pelo livro. Com um cockpit só de pé (o
    // caso de hoje) não duplica: o reenvio só existe porque a 1ª tentativa falhou. Com dois,
    // pode. Fechar isso é mexer no reenvio e no gate — trabalho de card, não de merge.
    const desfecho = erro ? 'incerto' : 'falhou';
    const proximaEm = proximaTentativa(1, c.esperaMs, criadoEm, relogio.agora());
    if (proximaEm === null) { falhas += 1; console.error(`push: ${quem(inscricao)} falhou (${c.motivo}) e a próxima tentativa passaria do prazo — desisti`); return desfecho; }
    novos.push({ id: crypto.randomUUID(), tag: chave, endpoint: inscricao.endpoint, texto,
      tentativas: 1, criadoEm, proximaEm, ultimoMotivo: c.motivo, ...(aindaVale ? { aindaVale } : {}) });
    console.error(`push: ${quem(inscricao)} falhou (${c.motivo}) — nova tentativa em ${Math.round((proximaEm - relogio.agora()) / 1000)} s (1/${POLITICA.MAX_TENTATIVAS})`);
    return desfecho;
  }, { rotulo: nomeCurto(nomeDeAparelho(inscricao)) })));

  // Passo 7 ANTES do 8: uma falha na limpeza dos mortos não pode perder o reenvio do vizinho.
  let pendentes = 0;
  if (novos.length && (!chave || ultimaSeq.get(chave) === seq)) {
    if (chave) fila = fila.filter((r) => r.tag !== chave);
    fila.push(...novos);
    pendentes = novos.length;
    armar();
    await persistir();
  }
  const removidos = await limparMortos(mortos);
  return { inscritos: lista.length, enviados, pendentes, falhas, removidos, nomes: aceitos.filter(Boolean) };
}

/** Só o que o aparelho precisa saber para se inscrever. A chave privada não sai daqui. */
const chavePublica = () => { contato(); return chaves().publica; };

module.exports = {
  chavePublica, inscrever, descadastrar, inscricoes, avisar, conhece,
  // O nome do aparelho (spec 2026-09-12): o que alguém de fora chama, mais o que o gate
  // exercita direto. `nomeCurto` e `quem` ficam locais — o gate os alcança por aqui.
  idDe, listar, renomear, nomeDeAparelho, rotuloDeLog,
  // Nome que não mente: `contato()` LANÇA e devolve string, não um booleano. `contatoValido`
  // faria `if (avisos.contatoValido())` passar sempre e `if (!…)` explodir.
  exigirContato: contato,
  classificar, explicarRecusa, usarRelogio, POLITICA,
  descartarPendentes, processarPendentes, retomar,
  pendentes: copiaDosPendentes,
};
