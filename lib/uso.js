'use strict';
// Para onde vão os tokens — quanto cada PROJETO e cada WORKTREE gastaram da assinatura.
//
// A fonte é a mesma que lib/contexto.js e lib/externo.js já leem: cada linha `assistant` de
// ~/.claude/projects/<pasta>/<sessao>.jsonl traz `message.usage` com os quatro campos. A
// diferença é o RECORTE — aqui não é "esta conversa", é "todo mundo, agrupado por projeto e
// por origem (aba de terminal ou worktree de job)". Card `para-onde-vao-meus-tokens`.
//
// FRONTEIRA (spec §3.1.1, armadilha #10): formato interno do CLI. Linha que não parseia, ou
// sem `usage` reconhecível, é PULADA — nunca lança. Sem nada reconhecível o relatório vem
// vazio, e a tela diz que não achou dado. Degradar, não quebrar.
//
// PROMESSA DE PRIVACIDADE (spec §3.1.1): nenhum byte de `content` é copiado para estrutura
// nossa, gravado no cache ou devolvido na resposta. O objeto do `JSON.parse` é descartado ao
// fim de cada linha; o que sobrevive são cinco números, um id de modelo e uma data. G10 prova
// o comportamento (a string SEGREDO não aparece na saída); G26 prova a FORMA (toda chave, em
// toda profundidade, pertence a uma whitelist fechada).
//
// `isSidechain` (subagente) NÃO é excluído aqui — ao contrário de lib/contexto.js:medir, que o
// pula porque a janela dele é OUTRA conversa. Aqui a pergunta é "quanto saiu da assinatura", e
// o subagente gasta da mesma assinatura de quem o chamou (R1 da /audita: a árvore de
// ~/.claude/projects NÃO é plana — subagente grava em <pasta>/<sessao>/subagents/agent-*.jsonl,
// e uma varredura rasa perderia 183 arquivos / 12% do gasto do dia).

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// ─── constantes ─────────────────────────────────────────────────────────────

// 64 KB — mesmo bloco de lib/externo.js:linhasDoArquivo, medido lá como o tamanho que faz
// caber ~729 MB em segundos sem materializar o arquivo inteiro.
const BLOCO = 64 * 1024;

// 1 MB — R3 da spec. Medido no disco em 04/09: a maior linha de qualquer .jsonl tem 3.496.971
// bytes (imagem em base64, armadilha #38); a maior linha QUE TEM `usage`, em 47 mil linhas
// examinadas, tem 124.761 bytes. 8x de folga sobre o pior caso real, e a linha descartada não
// passa por Buffer.concat nem toString — só os ~1 KB iniciais (que já estavam em mãos) são
// olhados, para achar o dia a que ela pertence (§3.1.3).
const TETO_LINHA = 1024 * 1024;

// Muda o formato do cache em disco ⇒ sobe este número, e todo cache velho é ignorado inteiro
// (revarre do zero) em vez de ser lido pela metade.
//
// 1 → 2 (04/09, card `tokens-mais-detalhe`): o array do agregado passou de 5 para 7 posições
// (a escrita de cache repartida por duração). Um cache v1 devolveria `undefined` em [5]/[6], e
// `undefined + n` é `NaN` — o modo de falha mais silencioso possível num contador. O preço é
// UMA revarredura completa (~6 s para 729 MB), uma vez.
const VERSAO_CACHE = 2;

// Preços da API avulsa, US$ por 1M de tokens. CONSULTADOS NA SKILL `claude-api` EM 2026-09-04
// — nunca de memória. Fonte de `entrada`/`saida`: claude-api § Current Models. Fonte das três
// colunas de cache: shared/prompt-caching.md:144 — "Cache reads cost ~0.1× base input price —
// 0.025× on Claude Fable 5.1 ($0.25/MTok). Cache writes cost 1.25× for 5-minute TTL, 2× for
// 1-hour TTL".
//
// Os multiplicadores estão APLICADOS, não derivados em runtime, de propósito: a Fable 5.1 lê
// cache a 0,25 (0,025×, não 0,1×) e uma fórmula com exceção embutida é onde o próximo preço
// entra errado. G36 confere linha a linha contra a regra e cobra a exceção nominalmente.
// Preço muda ⇒ mexe-se AQUI e em lugar nenhum mais.
//
// `claude-mythos-5-1` fica FORA de propósito: a fonte diz que a taxa de leitura de cache dele
// "is open at launch" (indefinida). Entrar com um número que a fonte não afirma seria chute —
// ele cai em "sem preço conhecido", que é honesto.
const PRECOS_CONSULTADOS_EM = '2026-09-04';
const PRECOS = {
  'claude-fable-5-1': { entrada: 10, saida: 50, escrita5m: 12.5, escrita1h: 20, leitura: 0.25 },
  'claude-fable-5':   { entrada: 10, saida: 50, escrita5m: 12.5, escrita1h: 20, leitura: 1.00 },
  'claude-opus-5':    { entrada: 5, saida: 25, escrita5m: 6.25, escrita1h: 10, leitura: 0.50 },
  'claude-opus-4-8':  { entrada: 5, saida: 25, escrita5m: 6.25, escrita1h: 10, leitura: 0.50 },
  'claude-opus-4-7':  { entrada: 5, saida: 25, escrita5m: 6.25, escrita1h: 10, leitura: 0.50 },
  'claude-opus-4-6':  { entrada: 5, saida: 25, escrita5m: 6.25, escrita1h: 10, leitura: 0.50 },
  'claude-sonnet-5':  { entrada: 2, saida: 10, escrita5m: 2.5, escrita1h: 4, leitura: 0.20 },
  'claude-sonnet-4-6': { entrada: 3, saida: 15, escrita5m: 3.75, escrita1h: 6, leitura: 0.30 },
  'claude-haiku-4-5': { entrada: 1, saida: 5, escrita5m: 1.25, escrita1h: 2, leitura: 0.10 },
};

const RAIZ = path.join(os.homedir(), '.claude', 'projects');
// A pasta dos jobs tem UM dono, `lib/limite.js` (`dirJobs()`), e ele a lê do ENV a cada
// chamada. Uma constante de topo aqui congelaria o caminho no `require` e faria este módulo
// discordar dos outros dois quando `COCKPIT_JOBS_DIR` está posto — que é o caso do gate e o de
// quem clona o repo sem ter um `~/.cockpit` (spec §6.5). Sem ciclo: `limite` requer só
// `adaptador-claude`, que não requer este arquivo.
//
// A função vem DESESTRUTURADA, e não o módulo inteiro: `:410` já tem um `const limite` local
// (uma data), e um `limite` de módulo no topo viveria com essa sombra por cima — hoje sem
// consequência, amanhã um `limite.dirJobs()` mudo dentro daquela função.
const { dirJobs } = require('./limite');

// O caminho do cache é lido do ENV a cada chamada (não numa constante de topo) para o gate
// poder trocar COCKPIT_USO_DIR entre cenários no MESMO processo, sem precisar de um novo
// `require`. `dirCache()`/`caminhoCache()` abaixo são as únicas funções que o consultam.
function dirCache() {
  return process.env.COCKPIT_USO_DIR || path.join(os.homedir(), '.cockpit', 'uso');
}
function caminhoCache() {
  return path.join(dirCache(), 'cache.json');
}

// Os prefixos são DERIVADOS de os.homedir(), nunca chumbados — regra da casa. `cru()` é a
// MESMA transformação que o próprio CLI aplica ao montar o nome da pasta (lib/externo.js:33,
// `cwd.replace(/[^a-zA-Z0-9]/g, '-')`).
const cru = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
// Lido do ENV a cada chamada, nunca numa constante de topo — mesmo hábito de `dirUso()` logo
// acima e de `limite.dirJobs()`: o gate troca de cenário no MESMO processo. A pasta de
// worktrees do orquestrador é configurável porque cada um usa a sua; quem não tem nenhuma
// simplesmente nunca casa o prefixo, e todo `.jsonl` cai em "aba" ou "outro".
function preWorktree() {
  const raiz = process.env.COCKPIT_WORKTREES_DIR || path.join(os.homedir(), '.cockpit', 'worktrees');
  return `${cru(raiz)}-`;
}
const PRE_PROJETO = `${cru(path.join(os.homedir(), 'projetos'))}-`;

// ─── funções puras (§3.1.4, §3.1.5) ────────────────────────────────────────

/**
 * Coerção única de qualquer valor de `usage` num inteiro seguro >= 0.
 *
 * `const x = Number(v)` na frente NÃO é opcional: sem ele a string "1234" cairia direto no
 * `Number.isFinite` de um valor que ainda é string e reprovaria para 0 — e é exatamente o que
 * G24a cobra (uma string numérica CONTA, porque se o CLI mudar o tipo do campo um dia, o
 * número continua certo em vez de virar zero calado). `NaN`, `Infinity`, negativo, ausente,
 * `null`/`undefined` e acima de MAX_SAFE_INTEGER viram 0 — nunca concatenação de string, nunca
 * NaN propagado.
 */
function num(v) {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER ? Math.trunc(x) : 0;
}

/** O dia UTC de um timestamp ISO, sem `new Date()` (§2.1 — parsear para reformatar só cria
 * chance de errar fuso). Sem casar com `^\d{4}-\d{2}-\d{2}`, cai em 'sem-data': a linha ainda
 * é agregada (ver agregarLinha), só não pertence a período nenhum. */
function diaDe(texto) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(texto || ''));
  return m ? m[1] : 'sem-data';
}

/**
 * O id de modelo que a tabela `PRECOS` usa: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`,
 * `claude-opus-5[1m]` → `claude-opus-5`.
 *
 * Nesta ordem: primeiro o sufixo `[…]` (armadilha #27 — hoje NENHUM registro de `message.model`
 * traz o `[1m]`, e custa uma linha ficar imune ao dia em que o CLI mudar isso), depois o
 * `-YYYYMMDD` (esse aparece de verdade: 2,4M de tokens de Haiku virariam "sem preço conhecido"
 * à toa sem ele). NADA além disso — nada de "parece um opus, cobra de opus". O id que sobra ou
 * está na tabela, ou é honestamente desconhecido.
 */
function normalizarModelo(id) {
  return String(id || '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/**
 * A classificação de uma pasta de 1º nível de ~/.claude/projects.
 *
 * `meta` é o `meta.json` do orquestrador já parseado (ou `null`, quando não existe / não parseia /
 * não tem `project`) — quem lê o disco é `varrer()`, esta função é pura de propósito (G2 entra
 * sem tocar em nada). `meta.json` é relido em TODA varredura, nunca cacheado junto do agregado
 * (§3.1.4, ponto 8 da 3ª rodada do painel): o agregado é caro e imutável (token gasto não volta
 * atrás), a classificação é barata e MUDA quando um job é renomeado.
 *
 * @returns {{origem: 'job'|'aba'|'outro', projeto: string, rotulo: string, id: string}}
 */
function classificar(pasta, meta) {
  const preWt = preWorktree();
  if (pasta.startsWith(preWt)) {
    const id = pasta.slice(preWt.length);
    if (meta && typeof meta.project === 'string' && meta.project) {
      const tipo = typeof meta.type === 'string' && meta.type ? meta.type : '?';
      const titulo = typeof meta.title === 'string' && meta.title ? meta.title : id;
      return { origem: 'job', projeto: meta.project, rotulo: `${tipo}: ${titulo}`, id };
    }
    return { origem: 'job', projeto: '(job sem registro)', rotulo: id, id };
  }
  if (pasta.startsWith(PRE_PROJETO)) {
    const nome = pasta.slice(PRE_PROJETO.length);
    return { origem: 'aba', projeto: nome, rotulo: `aba ~/projetos/${nome}`, id: pasta };
  }
  return { origem: 'outro', projeto: '(fora de projeto)', rotulo: pasta, id: pasta };
}

/**
 * Soma uma linha `assistant` já parseada no acumulador de um arquivo (`alvo.dias`).
 *
 * Pura e testável sem disco (G24b chama com NaN/undefined, valores sem representação em
 * JSON, alcançáveis só pela API direta). `alvo` é a entrada de cache de UM arquivo — esta
 * função só mexe em `alvo.dias`, nunca em offset/ino/assinatura.
 *
 * O mapeamento dos 4 campos, na ORDEM do array (spec §3.1.5):
 *   [0] entrada       = message.usage.input_tokens
 *   [1] saida         = message.usage.output_tokens
 *   [2] cacheEscrita  = message.usage.cache_creation_input_tokens
 *   [3] cacheLeitura  = message.usage.cache_read_input_tokens
 *   [4] n             = quantas linhas somaram
 *   [5] escrita5m     = message.usage.cache_creation.ephemeral_5m_input_tokens
 *   [6] escrita1h     = message.usage.cache_creation.ephemeral_1h_input_tokens
 *
 * As duas últimas são um DETALHAMENTO de [2], não tokens a mais — medido no disco em 04/09,
 * `ephemeral_5m + ephemeral_1h === cache_creation_input_tokens` em 7.580 linhas. Elas existem
 * só porque a escrita de 1h custa 2× o input e a de 5m custa 1,25×: sem separar, o preço da
 * escrita seria assumido. Um CLI sem `cache_creation` degrada para zero nas duas, e quem
 * calcula o custo trata o resíduo como 5 min E DIZ que assumiu (montar/custoDe).
 *
 * Soma zero (mensagem sintética do CLI: rate limit, erro de API, `model: "<synthetic>"`) é
 * PULADA — contá-la poria um modelo fantasma em todo projeto. `isSidechain` NÃO é excluído
 * (ver o cabeçalho do arquivo). Linha sem timestamp reconhecível NÃO é pulada: ela soma
 * normalmente na chave 'sem-data', que nenhum período devolve (ver montar()).
 *
 * @returns {boolean} true se a linha contribuiu com algum token (para o `comUsage` da leitura).
 */
function agregarLinha(obj, alvo) {
  const u = obj && typeof obj === 'object' ? obj.message && obj.message.usage : null;
  if (!u || typeof u !== 'object') return false;

  const entrada = num(u.input_tokens);
  const saida = num(u.output_tokens);
  const cacheEscrita = num(u.cache_creation_input_tokens);
  const cacheLeitura = num(u.cache_read_input_tokens);
  // A guarda de soma-zero olha só os 4 campos ORIGINAIS de propósito: escrita5m/escrita1h são
  // um detalhamento de cacheEscrita, e somá-las aqui contaria a mesma escrita duas vezes.
  if (entrada + saida + cacheEscrita + cacheLeitura === 0) return false;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const escrita5m = cc ? num(cc.ephemeral_5m_input_tokens) : 0;
  const escrita1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;

  const dia = diaDe(obj.timestamp);
  const modelo = (obj.message && typeof obj.message.model === 'string' && obj.message.model)
    || 'desconhecido';

  if (!alvo.dias[dia]) alvo.dias[dia] = {};
  if (!alvo.dias[dia][modelo]) alvo.dias[dia][modelo] = [0, 0, 0, 0, 0, 0, 0];
  const arr = alvo.dias[dia][modelo];
  arr[0] += entrada; arr[1] += saida; arr[2] += cacheEscrita; arr[3] += cacheLeitura; arr[4] += 1;
  arr[5] = (arr[5] || 0) + escrita5m; arr[6] = (arr[6] || 0) + escrita1h;
  return true;
}

// ─── a leitura por blocos, com offset (§3.1.2) ─────────────────────────────

/**
 * As linhas de UM arquivo, lidas para FRENTE em blocos de `BLOCO` bytes, começando em `de` e
 * indo até `ate` (o `info.size` congelado no início da varredura daquele arquivo — um .jsonl
 * sendo escrito agora não faz o laço perseguir o EOF).
 *
 * Molde: `linhasDoArquivo` de lib/externo.js:120-170. IGUAL naquilo que importa: blocos de
 * `Buffer.alloc` + laço interno de `read()` (a API pode devolver menos do que se pediu); o
 * pedaço que sobra na fronteira vai para uma LISTA de Buffers, nunca uma string (armadilha
 * #11 — guardar como string cortaria um caractere multibyte na fronteira e viraria `�` calado).
 *
 * TRÊS diferenças deliberadas em relação ao molde (§3.1.2):
 *
 * 1. Começa num `offset` e DEVOLVE onde parou — o `return` do generator é o byte logo após o
 *    último '\n' consumido. Quem itera precisa usar `it.next()` manualmente (não
 *    `for await...of`, que não expõe o valor de retorno) para capturar esse offset final.
 * 2. A ÚLTIMA LINHA SEM '\n' NÃO é entregue — ao contrário do molde. O motivo é o oposto do de
 *    lá: uma conversa rodando agora tem a última linha sendo escrita, e contar meia linha é
 *    contar token errado. Ela fica no `resto`, é descartada, e o offset devolvido volta para
 *    ANTES dela — a leitura seguinte a lê inteira.
 * 3. `TETO_LINHA`: uma linha que cresce além do teto é IGNORADA em vez de entregue — e o
 *    descarte não materializa o corpo dela (nunca `Buffer.concat` nem `toString` do que
 *    passou do teto). Em vez de uma string, o generator produz `{ ignorada: true, dia }`, onde
 *    `dia` vem de uma regex sobre só os primeiros ~1 KB da linha (que já estavam em mãos desde
 *    o início dela) — mais barato que o filtro de `"usage"` que roda em toda linha normal.
 *    Ela é CONTADA, não silenciosa (R3 — o descarte que ninguém percebe é o que este contador
 *    existe para evitar).
 *
 * `estourou` é um sinalizador por linha: uma vez que a linha corrente passa do teto, os bytes
 * dela deixam de ser acumulados em `resto` (memória é solta cedo, no meio da linha — não só
 * quando o '\n' finalmente aparece), e só o PRIMEIRO pedaço (capturado antes de saber que ela
 * ia estourar) é guardado, para a regex do dia.
 */
async function* linhasDe(alca, de, ate) {
  let lido = de;
  let offset = de;
  let resto = [];
  let restoBytes = 0;
  let primeiroPedaco = null;
  let estourou = false;

  const iniciaLinha = () => { resto = []; restoBytes = 0; primeiroPedaco = null; estourou = false; };

  while (lido < ate) {
    const querido = Math.min(BLOCO, ate - lido);
    const buffer = Buffer.alloc(querido);
    let preenchido = 0;
    while (preenchido < querido) {
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await alca.read(buffer, preenchido, querido - preenchido, lido + preenchido);
      if (bytesRead === 0) break;
      preenchido += bytesRead;
    }
    if (preenchido === 0) break;             // arquivo encolheu sob a alça: para com o que já leu
    const bloco = buffer.subarray(0, preenchido);
    lido += preenchido;

    let inicio = 0;
    for (;;) {
      const nl = bloco.indexOf(10, inicio); // '\n'
      if (nl < 0) break;
      const pedaco = bloco.subarray(inicio, nl);
      if (primeiroPedaco === null) primeiroPedaco = resto.length ? resto[0] : pedaco;
      const tamanho = restoBytes + pedaco.length;

      if (estourou || tamanho > TETO_LINHA) {
        const amostra = primeiroPedaco.subarray(0, Math.min(1024, primeiroPedaco.length)).toString('utf8');
        const m = /"timestamp":"(\d{4}-\d{2}-\d{2})/.exec(amostra);
        yield { ignorada: true, dia: m ? m[1] : 'sem-data' };
      } else {
        yield resto.length ? Buffer.concat([...resto, pedaco]).toString('utf8') : pedaco.toString('utf8');
      }
      inicio = nl + 1;
      offset = lido - bloco.length + inicio;
      iniciaLinha();
    }
    if (inicio < bloco.length) {
      const restante = bloco.subarray(inicio);
      if (primeiroPedaco === null) primeiroPedaco = restante;
      if (!estourou && restoBytes + restante.length > TETO_LINHA) {
        estourou = true;
        resto = [];
        restoBytes = 0;
      } else if (!estourou) {
        resto.push(restante);
        restoBytes += restante.length;
      }
      // já estourou: não acumula mais nada, a memória fica solta (R3)
    }
  }
  return offset;
}

/**
 * Os até-256 bytes que TERMINAM em `offset` — a cauda do que já foi contado, em hex.
 *
 * NÃO os 256 bytes iniciais do arquivo (§3.1.3): a assinatura responde "o que eu já contei
 * continua exatamente ali?", e só o trecho imediatamente antes do offset responde isso.
 * Append nunca altera byte antes do offset, então a assinatura não muda com um append —
 * arquivo curto fica incremental como qualquer outro (não força releitura por ter <256 bytes).
 *
 * Lida SEMPRE, inclusive quando `size === offset` (ponto 1 da 4ª rodada do painel): sem abrir
 * o arquivo não há assinatura para conferir, e uma reescrita de mesmo tamanho e mesmo inode
 * passaria batida se o atalho pulasse esta leitura.
 */
async function assinaturaDe(alca, offset) {
  const inicio = Math.max(0, offset - 256);
  const tamanho = offset - inicio;
  if (tamanho <= 0) return '';
  const buffer = Buffer.alloc(tamanho);
  let preenchido = 0;
  while (preenchido < tamanho) {
    // eslint-disable-next-line no-await-in-loop
    const { bytesRead } = await alca.read(buffer, preenchido, tamanho - preenchido, inicio + preenchido);
    if (bytesRead === 0) break;
    preenchido += bytesRead;
  }
  return buffer.subarray(0, preenchido).toString('hex');
}

// ─── o cache em disco (§3.1.3) ──────────────────────────────────────────────
//
// Por OFFSET, não por mtime — armadilha #34: o CLI reescreve o .jsonl sozinho (linhas
// `type:"system"`) e o mtime anda sem ninguém ter falado nada. A régua certa é o offset,
// porque o .jsonl é APPEND-ONLY (lib/externo.js:105-108).
//
// Em MEMÓRIA, `cache.arquivos` é um objeto indexado por caminho (lookup O(1) na varredura).
// No DISCO, vira uma LISTA de { caminho, offset, ino, assinatura, ignoradas, mtimeMs, dias } —
// e não um objeto `{ [caminho]: entrada }`: um caminho absoluto como CHAVE json escaparia da
// whitelist fechada de §3.1.1 (que é sobre NOMES de chave); como valor sob a chave `caminho`,
// ele não escapa. É EXATAMENTE esta lista de campos, e só ela, que G26 confere no cache.json.

let cacheEmMemoria = null;   // { versao, arquivos } — carregado uma vez por processo/require
let emVoo = null;            // a promessa da varredura em andamento (§3.1.3, o `emVoo` é AQUI)

/**
 * O disco guarda `arquivos` como uma LISTA de `{ caminho, offset, ino, assinatura, ignoradas,
 * mtimeMs, dias }` — não um objeto indexado por caminho. A diferença importa para G26: um
 * objeto `{ [caminho]: entrada }` põe o CAMINHO ABSOLUTO do disco como CHAVE JSON, e a
 * whitelist fechada de §3.1.1 é sobre chaves. Como lista, `caminho` é só mais um VALOR dentro
 * de um objeto de chaves conhecidas — a mesma trava que já protege `rotulo` (texto livre do
 * meta.json) protege o caminho. Convertido de volta para um objeto (por `caminho`) só na
 * memória do processo, onde a varredura precisa de lookup rápido.
 */
async function carregarCacheDoDisco() {
  try {
    const texto = await fsp.readFile(caminhoCache(), 'utf8');
    const dados = JSON.parse(texto);
    if (dados && dados.versao === VERSAO_CACHE && Array.isArray(dados.arquivos)) {
      const arquivos = {};
      for (const item of dados.arquivos) {
        if (item && typeof item.caminho === 'string') {
          const { caminho, ...entrada } = item;
          arquivos[caminho] = entrada;
        }
      }
      return { versao: VERSAO_CACHE, arquivos };
    }
  } catch { /* não existe, EACCES, JSON quebrado, versão diferente — cai no cache vazio */ }
  return { versao: VERSAO_CACHE, arquivos: {} };
}

/** Cache é otimização, nunca fonte (contrato de falha do §3.1.3): falhar aqui NUNCA propaga —
 * a resposta já saiu, e a próxima varredura tenta gravar de novo. `.tmp` leva o PID no nome e o
 * `rename` é atômico: dois servidores gravando ao mesmo tempo, um vence, ninguém lê pela metade. */
async function gravarCacheNoDisco(cache) {
  try {
    await fsp.mkdir(dirCache(), { recursive: true });
    const tmp = path.join(dirCache(), `cache.${process.pid}.tmp`);
    const arquivos = Object.entries(cache.arquivos).map(([caminho, entrada]) => ({ caminho, ...entrada }));
    await fsp.writeFile(tmp, JSON.stringify({ versao: cache.versao, arquivos }));
    await fsp.rename(tmp, caminhoCache());
  } catch { /* otimização, nunca fonte — a próxima varredura tenta de novo */ }
}

/** Remove dias mais velhos que a janela máxima (30) e entradas cujo arquivo sumiu do disco
 * (R4). Chamado sempre antes de gravar — nunca antes de montar(), porque dias=30 nunca olha
 * mais longe que isto poda. */
async function podarEGravar(cache, vistos) {
  const limite = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  for (const caminho of Object.keys(cache.arquivos)) {
    if (!vistos.has(caminho)) {
      let existe = true;
      try { await fsp.access(caminho); } catch { existe = false; }
      if (!existe) { delete cache.arquivos[caminho]; continue; }
    }
    const entrada = cache.arquivos[caminho];
    for (const dia of Object.keys(entrada.ignoradas || {})) {
      if (dia !== 'sem-data' && dia < limite) delete entrada.ignoradas[dia];
    }
    for (const dia of Object.keys(entrada.dias || {})) {
      if (dia !== 'sem-data' && dia < limite) delete entrada.dias[dia];
    }
  }
  await gravarCacheNoDisco(cache);
}

// ─── a varredura (§3.1.3, §3.1.4) ───────────────────────────────────────────

/**
 * Popula o cache em memória a partir do disco e devolve o ESTADO que `montar()` consome —
 * mais rico que o que vai para o cache.json (que só tem offset/ino/assinatura/ignoradas/
 * mtimeMs/dias por arquivo): aqui também vai, TRANSIENTE (nunca serializado), a classificação
 * de cada pasta desta rodada (`classes`) e o mapa caminho→pasta (`caminhoParaPasta`) — é o que
 * permite `montar()` ser pura e mesmo assim agrupar por projeto sem tocar o disco de novo.
 *
 * A promessa de concorrência é DESTA função, nunca de `relatorio()` (ponto 1 do painel,
 * 1ª rodada): duas chamadas simultâneas com `dias` diferentes compartilham UMA varredura via
 * `emVoo`, e cada uma monta o SEU relatório em cima do mesmo estado (G16).
 *
 * A varredura é RECURSIVA por pasta (R1 — subagente vive em <pasta>/<sessao>/subagents/*.jsonl)
 * mas em DUAS camadas de `readdir`: primeiro um `readdir(RAIZ)` RASO para achar as pastas de
 * 1º nível, depois um `readdir(pasta, {recursive:true})` por pasta, cada um no seu try/catch
 * (ponto 6 da 4ª rodada do painel). Um `readdir` recursivo ÚNICO sobre a raiz rejeitaria a
 * chamada INTEIRA ao esbarrar numa subárvore sem permissão, e as outras 144 pastas sumiriam
 * junto — o oposto do que a spec exige. Gate G32.
 */
async function varrer() {
  if (emVoo) return emVoo;

  emVoo = (async () => {
    const t0 = Date.now();
    if (!cacheEmMemoria) cacheEmMemoria = await carregarCacheDoDisco();
    const cache = cacheEmMemoria;

    const vistos = new Set();
    const classes = {};             // pastaNome -> classificação (fresca, nunca cacheada)
    const caminhoParaPasta = {};    // caminho -> pastaNome
    let arquivosEncontrados = 0;
    let comUsage = 0;
    let relidos = 0;
    let bytesLidos = 0;
    let arquivosComErro = 0;

    let pastas = [];
    try {
      pastas = await fsp.readdir(RAIZ);
    } catch {
      pastas = [];   // readdir da raiz falhou: relatório vazio, leitura.arquivos = 0
    }

    for (const pastaNome of pastas) {
      const pastaAbs = path.join(RAIZ, pastaNome);
      let statPasta;
      try { statPasta = await fsp.stat(pastaAbs); } catch { continue; }
      if (!statPasta.isDirectory()) continue;

      // meta.json — RELIDO SEMPRE (§3.1.4, ponto 8 da 3ª rodada). Ceticismo igual ao .jsonl:
      // não existe, não parseia, sem `project` → cai na linha "sem registro" dentro de classificar().
      let meta = null;
      const preWt = preWorktree();
      if (pastaNome.startsWith(preWt)) {
        const id = pastaNome.slice(preWt.length);
        try {
          const dados = JSON.parse(await fsp.readFile(path.join(dirJobs(), id, 'meta.json'), 'utf8'));
          if (dados && typeof dados.project === 'string' && dados.project) meta = dados;
        } catch { /* sem registro — classificar() cai no caso "(job sem registro)" */ }
      }
      classes[pastaNome] = classificar(pastaNome, meta);

      let arquivosDaPasta;
      try {
        arquivosDaPasta = await fsp.readdir(pastaAbs, { recursive: true });
      } catch {
        continue;   // ISOLAMENTO — G32: esta pasta é pulada, as outras seguem
      }

      for (const relativo of arquivosDaPasta) {
        if (!relativo.endsWith('.jsonl')) continue;
        const caminho = path.join(pastaAbs, relativo);
        arquivosEncontrados += 1;
        vistos.add(caminho);
        caminhoParaPasta[caminho] = pastaNome;

        let alca = null;
        try {
          alca = await fsp.open(caminho, 'r');
          const info = await alca.stat();      // do handle já aberto, não fsp.stat(caminho)
          if (!info.isFile()) { await alca.close().catch(() => {}); continue; }

          let entrada = cache.arquivos[caminho];
          let relerDoZero = !entrada;
          let assinaturaAtual = null;

          if (entrada && !relerDoZero) {
            // `size < offset` (encolheu) é uma OTIMIZAÇÃO REDUNDANTE, não a trava — achado
            // durante a prova de vermelho de 1.5 (mutação 4b, 04/09). A CORRETUDE do
            // encolhimento já é garantida pelo branch de identidade logo abaixo: se o arquivo
            // encolheu, a janela `[entrada.offset-256, entrada.offset)` que `assinaturaDe` pede
            // cai total ou parcialmente ALÉM do novo fim de arquivo, `alca.read()` devolve
            // menos bytes do que pediu (ou zero), e o hex resultante nunca bate com uma
            // assinatura de 256 bytes reais — `relerDoZero` vira `true` pelo `else` mesmo assim.
            // Comprovado com as duas defesas desligadas ao mesmo tempo (mutação 4c,
            // `/tmp/uso-provas/04c-G5.txt`): só aí o G5 cai; com só esta aqui desligada
            // (mutação 4b), o branch de identidade sozinho já segura o caso, e o gate continua
            // verde. Este `if` existe por DOIS motivos que NÃO são corretude: (1) evita abrir
            // mão de uma leitura de disco inútil quando já se sabe, pelo `stat`, que o arquivo
            // encolheu; (2) declara a intenção da tabela de decisão da spec (§3.1.3) em vez de
            // deixar o leitor descobrir por inferência que um `read` além do EOF "por acaso"
            // resolve o caso. NÃO REMOVER achando que o branch de baixo já cobre: cobre agora,
            // mas se algum dia ele mudar (por exemplo, para não invalidar em toda leitura vazia
            // de assinatura), o encolhimento passa a vazar calado, e SÓ este `if` continuaria
            // pegando o caso, sozinho.
            if (info.size < entrada.offset) {
              relerDoZero = true;                                   // encolheu
            } else {
              assinaturaAtual = await assinaturaDe(alca, entrada.offset);
              if (info.ino !== entrada.ino || assinaturaAtual !== entrada.assinatura) {
                relerDoZero = true;                                 // outro arquivo no mesmo caminho
              } else if (info.size === entrada.offset) {
                // nada a fazer — o caminho mais barato do laço. NÃO conta em relidos/bytesLidos.
                entrada.mtimeMs = info.mtimeMs;
                cache.arquivos[caminho] = entrada;
                if (Object.keys(entrada.dias).length) comUsage += 1;
                await alca.close().catch(() => {});
                alca = null;
                continue;
              }
              // size > offset e assinatura bate: incremental, de = entrada.offset
            }
          }

          if (relerDoZero) {
            entrada = { offset: 0, ino: info.ino, assinatura: '', ignoradas: {}, mtimeMs: info.mtimeMs, dias: {} };
          }
          const de = relerDoZero ? 0 : entrada.offset;

          const it = linhasDe(alca, de, info.size);
          let resultado;
          for (;;) {
            // eslint-disable-next-line no-await-in-loop
            resultado = await it.next();
            if (resultado.done) break;
            const item = resultado.value;
            if (item && typeof item === 'object' && item.ignorada) {
              entrada.ignoradas[item.dia] = (entrada.ignoradas[item.dia] || 0) + 1;
              continue;
            }
            let obj;
            try { obj = JSON.parse(item); } catch { continue; }   // formato interno (#10): pula, nunca lança
            agregarLinha(obj, entrada);
          }
          const novoOffset = resultado.value;
          if (novoOffset > de) { relidos += 1; bytesLidos += (novoOffset - de); }

          entrada.offset = novoOffset;
          entrada.ino = info.ino;
          entrada.mtimeMs = info.mtimeMs;
          entrada.assinatura = await assinaturaDe(alca, entrada.offset);
          cache.arquivos[caminho] = entrada;
          if (Object.keys(entrada.dias).length) comUsage += 1;
        } catch (erro) {
          // Só erro de SYSCALL degrada (mesmo filtro de lib/externo.js:167-170) — TypeError de
          // bug de programação sobe, para não virar "projeto sem gasto" calado.
          if (erro && erro.syscall) { arquivosComErro += 1; } else { throw erro; }
        } finally {
          if (alca) await alca.close().catch(() => {});
        }
      }
    }

    const leitura = { arquivos: arquivosEncontrados, comUsage, relidos, bytesLidos, ms: Date.now() - t0, arquivosComErro };
    await podarEGravar(cache, vistos).catch(() => {});   // otimização — nunca deriva a resposta

    return { arquivos: cache.arquivos, classes, caminhoParaPasta, leitura };
  })().finally(() => { emVoo = null; });

  return emVoo;
}

// ─── montagem do relatório (§3.1.6) ─────────────────────────────────────────

const SOMA = (arr) => arr[0] + arr[1] + arr[2] + arr[3];
function novoTotal() { return [0, 0, 0, 0, 0, 0, 0]; }
// O `|| 0` nas duas posições novas NÃO é zelo: G25 e G29 constroem o `estado` à mão com
// arrays de CINCO elementos (é o formato que `montar()` sempre aceitou), e `0 + undefined` é
// `NaN` — que se propagaria calado até `US$ NaN` na tela. Mesma disciplina de `num()`. Um
// cache v1 sobrevivente (que não deveria existir, VERSAO_CACHE subiu) degrada pelo mesmo
// caminho: vira "escrita sem duração declarada", que a tela sabe dizer.
function somarNoTotal(alvo, arr) {
  alvo[0] += arr[0]; alvo[1] += arr[1]; alvo[2] += arr[2]; alvo[3] += arr[3]; alvo[4] += arr[4];
  alvo[5] += arr[5] || 0; alvo[6] += arr[6] || 0;
}
function totalParaObjeto(arr) {
  return { entrada: arr[0], saida: arr[1], cacheEscrita: arr[2], cacheLeitura: arr[3], linhas: arr[4] };
}
/** true se ALGUM dos 4 campos numéricos passou de MAX_SAFE_INTEGER — overflow do ACUMULADOR,
 * não do campo individual (que `num()` já protege na entrada, §3.1.5). */
function estourouSeguranca(arr) {
  return !Number.isSafeInteger(arr[0]) || !Number.isSafeInteger(arr[1])
    || !Number.isSafeInteger(arr[2]) || !Number.isSafeInteger(arr[3]);
}

/**
 * Quanto CUSTARIA um agregado na API avulsa — pura, e calculada na MONTAGEM, nunca gravada no
 * cache: preço muda e cache não deve invalidar por isso.
 *
 * A escrita de cache é cobrada pela duração REAL quando o disco a declara. Três casos, os três
 * com comportamento definido (spec §3.1.3):
 *   normal        e5+e1 === cacheEscrita  ⇒ e5 a 1,25× e e1 a 2×
 *   parcial       e5+e1  <  cacheEscrita  ⇒ o resíduo entra no lado 5m (o mais barato de assumir)
 *   inconsistente e5+e1  >  cacheEscrita  ⇒ as durações são DESCARTADAS, cobra-se cacheEscrita a 1,25×
 *
 * O caso inconsistente é deliberado: quando a fonte se contradiz, o número em que se confia é o
 * TOTAL (`cache_creation_input_tokens`, que existe desde sempre), não o detalhamento novo.
 * Cobrar pelo detalhamento faria o custo estourar o volume — e o volume é justamente o que a
 * tela mostra ao lado. Os dois casos que assumem alguma coisa aparecem em `cacheSemDuracaoDe`,
 * para a tela DIZER que assumiu em vez de calar.
 *
 * @returns {{usd:number, conhecido:boolean}} — `conhecido:false` ⇒ `usd` é 0 e NÃO soma em
 *   lugar nenhum. Somar zero mentiria para baixo; chutar um preço mentiria para os dois lados.
 */
function custoDe(modelo, arr) {
  const p = PRECOS[normalizarModelo(modelo)];
  if (!p) return { usd: 0, conhecido: false };
  const cw = arr[2] || 0;
  let e5 = arr[5] || 0;
  let e1 = arr[6] || 0;
  // `cw - e1` é `e5 + resíduo` num passo só: no caso normal o resíduo é 0 e e5 não muda.
  if (e5 + e1 > cw) { e5 = cw; e1 = 0; } else { e5 = cw - e1; }
  const usd = ((arr[0] || 0) * p.entrada + (arr[1] || 0) * p.saida
    + e5 * p.escrita5m + e1 * p.escrita1h
    + (arr[3] || 0) * p.leitura) / 1e6;
  return { usd, conhecido: true };
}

/** Quantos tokens de escrita de cache foram cobrados SEM duração declarada (assumidos 5 min).
 * `> 0` ⇒ a tela diz que assumiu. Espelha exatamente os dois casos não-normais de `custoDe`. */
function cacheSemDuracaoDe(arr) {
  const cw = arr[2] || 0;
  const e5 = arr[5] || 0;
  const e1 = arr[6] || 0;
  return (e5 + e1 > cw) ? cw : (cw - e5 - e1);
}

/**
 * O acumulador de custo de UM agrupamento (o topo, um projeto, um modelo, um dia).
 *
 * Existe porque `custoDe` e `cacheSemDuracaoDe` são NÃO-LINEARES: o clamp do caso
 * inconsistente faz `f(a) + f(b) !== f(a + b)`. Aplicá-las sobre agregados diferentes fazia o
 * número do topo discordar da soma dos dias — dois valores que a tela mostra um do lado do
 * outro. Medido em 04/09: dia inconsistente + dia sem duração dava US$ 16,25 no topo e
 * US$ 12,50 somando os dias, com `cacheSemDuracao` zerado nos dois.
 *
 * A correção é de granularidade, não de fórmula: o custo é calculado UMA vez por
 * `(dia, modelo)` — a unidade em que o dado foi observado — e daí em diante só se SOMA. Todo
 * agrupamento vira soma dos mesmos termos, e todos os eixos fecham por construção.
 */
function novoCusto() { return { usd: 0, conhecido: true, cacheSemDuracao: 0 }; }
function acumularCusto(alvo, modelo, arr) {
  const c = custoDe(modelo, arr);
  if (c.conhecido) alvo.usd += c.usd; else alvo.conhecido = false;
  alvo.cacheSemDuracao += cacheSemDuracaoDe(arr);
}
/** O que vai na resposta — `cacheSemDuracao` só aparece no custo do TOPO (§3.1.5). */
function custoParaObjeto(c) { return { usd: c.usd, conhecido: c.conhecido }; }

/** dias-calendário UTC, `dias` deles, terminando em HOJE inclusive (§2.1). */
function janelaUTC(dias, agora = Date.now()) {
  const hoje = new Date(agora).toISOString().slice(0, 10);
  const hojeUTC = Date.UTC(...hoje.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  const desde = new Date(hojeUTC - (dias - 1) * 86400000).toISOString().slice(0, 10);
  return { desde, ate: hoje };
}
function diaDentro(dia, desde, ate) {
  return dia !== 'sem-data' && dia >= desde && dia <= ate;
}

/**
 * Monta o relatório final a partir do ESTADO que `varrer()` devolveu — PURA, sem tocar disco,
 * barata o bastante para ser chamada uma vez por aba aberta.
 *
 * Exportada (junto de `classificar`/`agregarLinha`/`num`) porque é assim que um gate pode
 * provar overflow (G25) ou desempate de ordenação (G29) sem precisar fabricar 729 MB de
 * fixture: constrói o `estado` à mão, no MESMO formato que `varrer()` devolve.
 */
function montar(estado, dias) {
  const { desde, ate } = janelaUTC(dias);
  const porProjeto = new Map();     // projeto -> { total, modelos:Set, porModelo:Map, origens:Map(id -> {tipo,rotulo,total,modelos}) }
  // Os dois eixos que o card pede JÁ estavam no cache (a chave do agregado é [dia][modelo]) —
  // o que faltava era não jogá-los fora aqui. Três `Map.set` dentro do laço que já roda:
  // nenhuma varredura nova, nenhuma segunda passada no disco.
  const porModeloGeral = new Map();  // modelo -> { total: [], custo }
  const porDiaGeral = new Map();     // dia    -> { total: [], custo }
  const custoGeral = novoCusto();
  let linhasIgnoradas = 0;
  let precisaoPerdida = false;
  const totalGeral = novoTotal();

  for (const [caminho, entrada] of Object.entries(estado.arquivos || {})) {
    const pastaNome = estado.caminhoParaPasta ? estado.caminhoParaPasta[caminho] : undefined;
    const classe = pastaNome !== undefined ? estado.classes[pastaNome] : undefined;
    if (!classe) continue;   // sem classificação nesta rodada (não deveria acontecer em uso normal)

    for (const [dia, n] of Object.entries(entrada.ignoradas || {})) {
      if (diaDentro(dia, desde, ate)) linhasIgnoradas += n;
    }

    for (const [dia, porModelo] of Object.entries(entrada.dias || {})) {
      if (!diaDentro(dia, desde, ate)) continue;
      for (const [modelo, arr] of Object.entries(porModelo)) {
        if (!porProjeto.has(classe.projeto)) {
          porProjeto.set(classe.projeto, { total: novoTotal(), custo: novoCusto(), porModelo: new Map(), origens: new Map() });
        }
        const p = porProjeto.get(classe.projeto);
        somarNoTotal(p.total, arr);
        // Cada acumulador recebe o MESMO termo, calculado uma vez sobre este `(dia, modelo)`.
        // É o que faz topo, projeto, modelo e dia fecharem entre si (ver `acumularCusto`).
        acumularCusto(custoGeral, modelo, arr);
        acumularCusto(p.custo, modelo, arr);

        if (!p.porModelo.has(modelo)) p.porModelo.set(modelo, { total: novoTotal(), custo: novoCusto() });
        const pm = p.porModelo.get(modelo);
        somarNoTotal(pm.total, arr);
        acumularCusto(pm.custo, modelo, arr);

        if (!porModeloGeral.has(modelo)) porModeloGeral.set(modelo, { total: novoTotal(), custo: novoCusto() });
        const mg = porModeloGeral.get(modelo);
        somarNoTotal(mg.total, arr);
        acumularCusto(mg.custo, modelo, arr);

        if (!porDiaGeral.has(dia)) porDiaGeral.set(dia, { total: novoTotal(), custo: novoCusto() });
        const dg = porDiaGeral.get(dia);
        somarNoTotal(dg.total, arr);
        acumularCusto(dg.custo, modelo, arr);

        const chaveOrigem = classe.id;
        if (!p.origens.has(chaveOrigem)) {
          p.origens.set(chaveOrigem, { tipo: classe.origem, rotulo: classe.rotulo, total: novoTotal(), modelos: new Set() });
        }
        const o = p.origens.get(chaveOrigem);
        somarNoTotal(o.total, arr);
        o.modelos.add(modelo);

        somarNoTotal(totalGeral, arr);
      }
    }
  }

  const comparador = (a, b) => (SOMA(b.total) - SOMA(a.total)) || a.nome.localeCompare(b.nome, 'pt-BR');

  /** Map(modelo → {total, custo}) → a lista ordenada da resposta: tokens decrescentes,
   * desempate alfabético (o MESMO comparador dos projetos — sem desempate, dois modelos
   * empatados trocam de lugar entre execuções e o PNG do smoke deixa de ser comparável). */
  function listaPorModelo(mapaModelos) {
    return Array.from(mapaModelos.entries())
      .map(([modelo, v]) => ({ nome: modelo, modelo, total: v.total, custo: v.custo }))
      .sort(comparador)
      .map((m) => ({ modelo: m.modelo, total: totalParaObjeto(m.total), custo: custoParaObjeto(m.custo) }));
  }

  const projetos = Array.from(porProjeto.entries())
    // Projeto com total zero no período não entra na lista (§3.1.6) — filtrado ANTES de
    // converter `total` de array para objeto, enquanto `SOMA` ainda enxerga o array cru.
    .filter(([, p]) => SOMA(p.total) > 0)
    .map(([projeto, p]) => {
      if (estourouSeguranca(p.total)) precisaoPerdida = true;
      const origens = Array.from(p.origens.values())
        .map((o) => {
          if (estourouSeguranca(o.total)) precisaoPerdida = true;
          return { nome: o.rotulo, tipo: o.tipo, rotulo: o.rotulo, total: o.total, modelos: Array.from(o.modelos).sort() };
        })
        .sort(comparador)
        .map((o) => ({ tipo: o.tipo, rotulo: o.rotulo, total: totalParaObjeto(o.total), modelos: o.modelos }));
      return {
        nome: projeto, projeto, total: p.total,
        // `porModelo` SUBSTITUI a antiga lista `modelos` (só nomes) — o campo novo é
        // estritamente mais informativo (o nome sai de porModelo[].modelo) e manter os dois
        // deixaria um campo que ninguém lê. `origens[].modelos` NÃO muda: quebra por modelo
        // dentro de origem não está no card.
        porModelo: listaPorModelo(p.porModelo), custo: custoParaObjeto(p.custo), origens,
      };
    })
    .sort(comparador)
    .map((p) => ({ projeto: p.projeto, total: totalParaObjeto(p.total), custo: p.custo, porModelo: p.porModelo, origens: p.origens }));

  if (estourouSeguranca(totalGeral)) precisaoPerdida = true;

  const leituraBase = estado.leitura || { arquivos: 0, comUsage: 0, relidos: 0, bytesLidos: 0, ms: 0, arquivosComErro: 0 };

  // Os tokens de todo modelo SEM preço conhecido, somados nos 4 campos. `0` ⇒ a tela não
  // mostra aviso nenhum; `> 0` ⇒ ela diz quantos tokens ficaram fora da conta.
  let tokensSemPreco = 0;
  for (const [modelo, v] of porModeloGeral) {
    if (!PRECOS[normalizarModelo(modelo)]) tokensSemPreco += SOMA(v.total);
  }

  return {
    geradoEm: new Date().toISOString(),
    desde, ate, dias,
    total: totalParaObjeto(totalGeral),
    precos: { consultadoEm: PRECOS_CONSULTADOS_EM, moeda: 'USD' },
    custo: { ...custoParaObjeto(custoGeral), tokensSemPreco, cacheSemDuracao: custoGeral.cacheSemDuracao },
    porModelo: listaPorModelo(porModeloGeral),
    // CRESCENTE por data: é uma linha do tempo, não um ranking. Dia sem gasto dentro da janela
    // não entra — buraco na sequência é honesto, barra de zero é ruído.
    porDia: Array.from(porDiaGeral.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dia, v]) => ({ dia, total: totalParaObjeto(v.total), custo: custoParaObjeto(v.custo) })),
    projetos,
    leitura: { ...leituraBase, linhasIgnoradas, precisaoPerdida },
  };
}

async function relatorio({ dias = 1 } = {}) {
  const estado = await varrer();
  return montar(estado, dias);
}

module.exports = {
  relatorio, varrer, montar,
  classificar, agregarLinha, num,
  TETO_LINHA, BLOCO, VERSAO_CACHE,
  // Exportados para o gate poder cobrar a tabela de preço (G36) e a normalização (G38) sem
  // adivinhar o número por dentro do custo já calculado.
  normalizarModelo, custoDe, PRECOS, PRECOS_CONSULTADOS_EM,
  // Só para o gate poder cravar um `assinaturaDe`/`linhasDe` roto sem recompilar o resto do
  // arquivo — sem contrato público estável, mesmo espírito de lib/externo.js:linhasDoArquivo.
  linhasDe, assinaturaDe,
};
