'use strict';
// TUDO que sabe o formato do Codex mora aqui — o casamento aba↔conversa, a fita, o medidor,
// o busy/idle e o consumo do plano. É o espelho de `lib/externo.js` + `lib/contexto.js`, com
// a MESMA assinatura pública, para o `server.js` trocar de leitor sem saber de qual CLI se
// trata.
//
// A fronteira, e ela é dura nos dois sentidos: `/proc` é assunto de `lib/abas.js`, que já
// tem a raiz injetável e a árvore de processos; `~/.codex/` é assunto daqui, e nada fora
// deste arquivo abre um rollout. Quem chama entrega a pane já resolvida (pid, procStartMs,
// cwd) e recebe de volta a conversa.
//
// 🔴 O QUE ELE RECUSA, e por quê: o `~/.codex/state_5.sqlite`.
//
// A tabela `threads` daquele banco responderia o casamento com uma query indexada, e mesmo
// assim ele está fora. O motivo decisivo é o `_5` no nome: um número de versão no nome do
// arquivo transforma uma atualização de CLI em lista vazia sem uma linha de erro. Somem-se
// a dependência de um módulo sqlite (o `node:sqlite` do Node 22 é experimental), o schema de
// 37 colunas e o WAL, que em `mode=ro` pode devolver dado velho. O `session_meta` do próprio
// rollout traz `cwd` e `timestamp`, que é tudo de que o casamento precisa, e ler cauda de
// arquivo é exatamente o que `lib/externo.js` e `lib/contexto.js` já fazem. Zero dependência
// nova é a regra da casa; isto aqui é ela sendo cumprida, não uma preferência de estilo.
//
// E o degrade é a armadilha #10 na letra: formato que não se reconhece devolve "não casou",
// `null` ou lista vazia. A aba de Codex aparece na lista, com o `cwd` da pane, sem fita e
// sem medidor — igual a uma aba cujo CLI morreu, que a tela já sabe desenhar. Um número
// inventado é pior que número nenhum.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * Onde os rollouts moram, resolvido em TEMPO DE CHAMADA.
 *
 * Raiz injetável pela mesma razão do `COCKPIT_PROC_RAIZ`: o gate é offline e monta uma
 * árvore de fixtures num `mkdtemp`. Constante de módulo é capturada na primeira carga e o
 * gate não trocaria de raiz entre um bloco de casos e outro.
 */
const raizDosRollouts = () => process.env.COCKPIT_CODEX_RAIZ
  || path.join(os.homedir(), '.codex', 'sessions');

// O prefixo que se lê de cada rollout candidato. Em 08/09 os campos estruturais, incluindo
// `source`, aparecem antes do byte 756. Instruções podem passar de 100 KB; não se lê a linha
// toda para identificar uma TUI. Campos fora do prefixo degradam para "não casou" (#10).
const PREFIXO = 4096;

// ─── A extração do `session_meta` ────────────────────────────────────────────
//
// Só campos diretos do primeiro payload. Regex sem profundidade confundia `source` de
// subagente/instruções com a origem real. A leitura continua limitada a 4 KB: o prefixo pode
// terminar dentro de base_instructions, depois dos campos estruturais que nos interessam.
function camposDoMeta(prefixo) {
  const texto = prefixo.split('\n', 1)[0];
  let i = 0;
  const espacos = () => { while (i < texto.length && /\s/.test(texto[i])) i++; };
  const string = () => {
    const m = /^"(?:[^"\\]|\\.)*"/.exec(texto.slice(i));
    if (!m) throw new Error('string incompleta');
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  // Pula valores compostos sem capturar nenhum de seus campos e sem parsear instruções.
  const pularComposto = () => {
    const pilha = [];
    do {
      const c = texto[i];
      if (c === '"') { string(); continue; }
      if (c === '{' || c === '[') pilha.push(c);
      if (c === '}' || c === ']') {
        if (pilha.pop() !== (c === '}' ? '{' : '[')) throw new Error('fechamento inválido');
      }
      i++;
    } while (i < texto.length && pilha.length);
    if (pilha.length) throw new Error('composto incompleto');
    return null;
  };
  const objeto = (envelope = false) => {
    espacos();
    if (texto[i++] !== '{') return null;
    const campos = Object.create(null);
    while (i < texto.length) {
      espacos();
      if (texto[i] === '}') { i++; return campos; }
      const nome = string();
      if (Object.hasOwn(campos, nome)) return null;
      espacos();
      if (texto[i++] !== ':') return null;
      espacos();
      // Marcar presença antes da leitura impede fallback de id inválido/incompleto.
      campos[nome] = null;
      try {
        if (envelope && nome === 'payload') campos[nome] = objeto();
        else if (texto[i] === '"') campos[nome] = string();
        else if (texto[i] === '{' || texto[i] === '[') pularComposto();
        else {
          const inicio = i;
          while (i < texto.length && !/[\s,}\]]/.test(texto[i])) i++;
          campos[nome] = JSON.parse(texto.slice(inicio, i));
        }
      } catch {
        // Prefixo cortado num valor final: conservar apenas os campos já completos.
        i = texto.length;
        return campos;
      }
      espacos();
      if (i === texto.length) return campos;
      if (texto[i] === '}') { i++; return campos; }
      if (texto[i++] !== ',') return null;
    }
    return campos;
  };
  try {
    const envelope = objeto(true);
    return envelope?.type === 'session_meta' ? envelope.payload : null;
  } catch { return null; }
}

/**
 * Cache com chave = O CAMINHO, e só ele.
 *
 * Nada de `(caminho, mtime, size)`: o rollout ATIVO cresce a cada append, então mtime e size
 * mudam a cada batida e o arquivo vivo — justamente o que interessa — seria relido para
 * sempre. O que se lê é o PREFIXO, e ele é imutável: `session_meta` é a primeira linha e
 * nunca é reescrita. O nome carrega carimbo + UUID, então "mesmo caminho, outro conteúdo"
 * não existe.
 */
const cacheDoMeta = new Map();

/**
 * O `session_meta` daquele rollout — ou `null`.
 *
 * Campo que não achar ⇒ o rollout NÃO é candidato (degrade #10), nunca um valor chutado.
 *
 * @returns {?{sessaoId: string, cwd: string, originator: string, nascimento: number}}
 */
async function sessionMetaDe(caminho) {
  if (cacheDoMeta.has(caminho)) return cacheDoMeta.get(caminho);
  let meta = null;
  let alca = null;
  try {
    alca = await fsp.open(caminho, 'r');
    const buffer = Buffer.alloc(PREFIXO);
    const { bytesRead } = await alca.read(buffer, 0, PREFIXO, 0);
    const prefixo = buffer.subarray(0, bytesRead).toString('utf8');
    const campos = camposDoMeta(prefixo);
    const sessaoId = campos && (Object.hasOwn(campos, 'id') ? campos.id : campos.session_id);
    const { timestamp: carimbo, cwd, originator, source } = campos || {};
    const nascimento = Date.parse(carimbo || '');
    if ([sessaoId, cwd, originator, carimbo].every((v) => typeof v === 'string' && v)
        && source === 'cli' && Number.isFinite(nascimento)) {
      meta = { sessaoId, cwd, originator, nascimento };
    }
  } catch {
    meta = null;
  } finally {
    await alca?.close().catch(() => {});
  }
  cacheDoMeta.set(caminho, meta);
  return meta;
}

// ─── A varredura ─────────────────────────────────────────────────────────────

/**
 * Todos os rollouts do disco, com o `mtime` de cada um. UMA passada, por chamada.
 *
 * O filtro é por `mtime`, NÃO por pasta de dia: uma TUI viva há semanas tem o rollout numa
 * pasta antiga, e a lista de dias cresceria sem teto. Medido em 29/08 com 600 rollouts:
 * `glob` 2,5 ms, `stat` de todos 5,2 ms, e sobram DOIS para abrir. Abrir 1 KB dos 600
 * custaria 234,6 ms — a cada 5 s.
 *
 * A contagem de `readdir` não pode multiplicar pelo número de panes: quatro panes de Codex
 * disparando quatro varreduras é a regressão silenciosa mais provável deste módulo, e é a
 * que um teto de milissegundos não pegaria numa máquina rápida.
 */
async function varrerRollouts() {
  const raiz = raizDosRollouts();
  const achados = [];
  const descer = async (dir, nivel) => {
    let entradas;
    try {
      entradas = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      const caminho = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (nivel < 3) await descer(caminho, nivel + 1);
        continue;
      }
      if (nivel !== 3 || !/^rollout-.*\.jsonl$/.test(e.name)) continue;
      const info = await fsp.stat(caminho).catch(() => null);
      if (info) achados.push({ caminho, mtimeMs: info.mtimeMs });
    }
  };
  // Nível 0 é a própria `sessions/`, e os arquivos moram no 3: `AAAA/MM/DD/rollout-*.jsonl`.
  await descer(raiz, 0);
  return achados;
}

// ─── O casamento ─────────────────────────────────────────────────────────────

// A folga de relógio da regra do `procStart`. Medido no R7: entre o processo subir e o
// `session_meta` ser escrito passam ~5 s, mas o carimbo do payload pode vir um pouco ANTES
// do `mtime` de `/proc/<pid>` por arredondamento — 2 s cobre isso sem afrouxar a regra.
const FOLGA_MS = 2000;

/**
 * As conversas de Codex vivas AGORA, indexadas por "sessãoTmux:@janela.%pane".
 *
 * Espelho de `sessoesDoCli()`, com o MESMO formato de chave — por PANE, e o `%71` faz parte
 * dela. Chavear por janela reabre a #6: duas panes de CLI na mesma janela colapsariam numa
 * entrada só, e uma das duas leria a conversa da outra.
 *
 * As panes chegam JÁ RESOLVIDAS por `lib/abas.js`: `pid` e `procStartMs` vêm da detecção de
 * agente, e `cwd` do `readlink` de `/proc/<pid>/cwd`. É a fronteira do módulo — nada aqui
 * abre `/proc`.
 *
 * As regras, na ordem, e cada uma existe porque o Codex NÃO publica o mapa pid→sessão que o
 * Claude publica:
 *
 *   3. candidatos: `mtime >= procStart` · `session_meta.cwd === cwd da pane` · `originator`
 *      começando com `codex-tui` · `source === 'cli'` · `nascimento >= procStart − 2 s`.
 *   4. POSSE: um rollout pertence à pane que subiu por ÚLTIMO antes de ele nascer. O sinal é
 *      o mesmo do R7 — entre a TUI subir e o `session_meta` ser escrito passam ~2 a 5 s —, e
 *      é ele que separa duas abas no mesmo `cwd`: a mais nova é a única que pode ter aberto
 *      o rollout mais novo. Uma pane só casa com o rollout de que é dona. Empate de posse
 *      (duas TUIs subindo dentro da mesma folga de 2 s) apaga o sinal ⇒ as duas ficam
 *      `ambiguo`, e o rollout não vai para ninguém. Isto é a D15 mantida onde ela vale:
 *      nunca mostrar a conversa do vizinho — mas sem cegar as duas abas quando dá para
 *      saber. A versão anterior descartava por CONTAGEM de panes no `cwd`, e por isso um
 *      Codex aberto na segunda-feira roubava a única resposta possível do aberto hoje.
 *   5. escolha: vence o de maior `mtime`. É o que cobre o `/new` dentro da mesma TUI, que
 *      abre um rollout novo com o mesmo processo.
 *  5b. SOBREPOSIÇÃO: havendo mais de um candidato, o casamento só vale se eles forem
 *      sequenciais. Todo perdedor tem que ter parado antes de o vencedor nascer.
 *   6. sem candidato ⇒ aba sem fita, e o campo `casamento` diz `'nenhum'`.
 *
 * O `originator` é o equivalente exato do `kind: "interactive"` da D15: `codex-tui` + `source:
 * cli` é a TUI de gente, `codex_exec` + `source: exec` é o headless. Sem esse filtro, o
 * `codex exec` do `avaliador-externo` — que roda DENTRO da worktree do job — roubaria a
 * fita de uma aba aberta ali. O risco não é hipotético: aconteceu durante a redação da spec.
 *
 * @param {Array<{sessaoTmux, janelaId, paneId, pid, procStartMs, cwd}>} panes
 * @returns {Map<string, {pid, procStart, sessaoId, cwd, arquivo, pane, rodando, casamento}>}
 */
async function sessoesDoCodex(panes) {
  const mapa = new Map();
  const doCodex = (panes || []).filter((p) => p && p.paneId);
  if (!doCodex.length) return mapa;

  // UMA varredura, seja qual for o número de panes.
  const todos = await varrerRollouts();

  // ── Passada 1: os candidatos de cada pane, e o piso de todas elas no mapa ───────────────
  //
  // Toda pane entra no mapa já aqui, com `casamento: 'nenhum'`. As passadas seguintes só
  // sobrescrevem — assim uma pane que cai fora em qualquer ponto nunca some do retorno.
  const candidatosDe = new Map();
  const aptas = [];

  for (const pane of doCodex) {
    const chave = `${pane.sessaoTmux}:${pane.janelaId}.${pane.paneId}`;
    const base = {
      pid: pane.pid ?? null,
      procStart: pane.procStartMs ?? null,
      sessaoId: null,
      cwd: pane.cwd || null,
      arquivo: null,
      pane: pane.paneId,
      rodando: null,
      casamento: 'nenhum',
    };
    mapa.set(chave, base);

    // Sem `cwd` ou sem `procStart` não há casamento possível: fica no piso.
    if (!pane.cwd || !Number.isFinite(pane.procStartMs)) continue;

    const candidatos = [];
    for (const { caminho, mtimeMs } of todos) {
      // O filtro barato primeiro: um rollout tocado ANTES de o processo subir não pode ser a
      // conversa dele. É isto que resolve o "abriu, fechou, abriu de novo no mesmo cwd" sem
      // regra nenhuma a mais, e é a razão de o critério ser o `procStart` e não o `mtime` só.
      if (mtimeMs < pane.procStartMs) continue;
      const meta = await sessionMetaDe(caminho);
      if (!meta) continue;
      if (meta.cwd !== pane.cwd) continue;
      if (!String(meta.originator).startsWith('codex-tui')) continue;
      if (meta.nascimento < pane.procStartMs - FOLGA_MS) continue;
      candidatos.push({ caminho, mtimeMs, meta });
    }

    candidatosDe.set(chave, candidatos);
    aptas.push({ pane, chave, base });
  }

  // ── Passada 2: a regra 4, a posse ──────────────────────────────────────────────────────
  //
  // Um rollout disputado por várias panes é de UMA só: a que subiu por último antes de ele
  // nascer. O caso real que a contagem por `cwd` não dava conta: o usuário tinha um Codex
  // aberto em `~/projetos/cockpit-agentes` desde 28/08 e abriu outro no MESMO cwd em 02/09.
  // O rollout de 02/09 passa no filtro dos DOIS — para a pane velha, "nasceu depois do
  // processo subir" é verdade para tudo que veio depois de 28/08 —, mas ele nasceu 2 s
  // depois de a pane NOVA subir. Só ela pode tê-lo aberto.
  //
  // A folga é a mesma FOLGA_MS, e pela mesma razão: se duas TUIs subiram com menos de 2 s
  // de diferença, o carimbo não separa uma da outra. Aí o sinal sumiu e ninguém casa.
  const disputadas = new Set();
  const donoDe = new Map();
  const pretendentes = new Map();

  for (const { pane, chave } of aptas) {
    for (const c of candidatosDe.get(chave)) {
      if (!pretendentes.has(c.caminho)) pretendentes.set(c.caminho, []);
      pretendentes.get(c.caminho).push({ chave, procStartMs: pane.procStartMs });
    }
  }

  for (const [caminho, lista] of pretendentes) {
    const ultimo = Math.max(...lista.map((x) => x.procStartMs));
    const topo = lista.filter((x) => x.procStartMs >= ultimo - FOLGA_MS);
    if (topo.length > 1) {
      // Empate de posse: nenhuma das empatadas casa com NADA. Uma pane que disputa um
      // rollout sem conseguir prová-lo está com o sinal fraco, e a resposta certa aí é a
      // mesma de sempre — sem fita, nunca a conversa da vizinha.
      for (const t of topo) disputadas.add(t.chave);
      donoDe.set(caminho, null);
      continue;
    }
    donoDe.set(caminho, topo[0].chave);
  }

  // ── Passada 3: regras 5, 5b e 6, dentro do que sobrou para cada pane ────────────────────
  for (const { pane, chave, base } of aptas) {
    if (disputadas.has(chave)) {
      mapa.set(chave, { ...base, casamento: 'ambiguo' });
      continue;
    }

    const candidatos = candidatosDe.get(chave).filter((c) => donoDe.get(c.caminho) === chave);

    if (!candidatos.length) {
      mapa.set(chave, base);
      continue;
    }

    // Regra 5: vence o de maior `mtime`.
    let vencedor = candidatos[0];
    let empatado = false;
    for (const c of candidatos.slice(1)) {
      if (c.mtimeMs > vencedor.mtimeMs) { vencedor = c; empatado = false; } else if (c.mtimeMs === vencedor.mtimeMs) empatado = true;
    }
    // `mtime` de baixa resolução: dois candidatos com o MESMO carimbo. Empate é ambiguidade,
    // não desempate por ordem de `readdir` — quando o sinal é fraco, a resposta é sem fita.
    if (empatado) {
      mapa.set(chave, { ...base, casamento: 'ambiguo' });
      continue;
    }

    // Regra 5b, a trava da sobreposição. O furo que ela tapa: o usuário tem um Codex vivo em
    // `~/projetos/X`, abre um SEGUNDO no mesmo cwd, conversa nele e fecha aquela pane. Agora
    // há uma pane viva e dois rollouts, e o da pane MORTA tem o `mtime` maior — a regra 4 não
    // pega (só há uma pane agora) e a regra 5 escolheria a conversa de uma aba que não existe
    // mais. Sequenciais casa (`/new` na mesma TUI); sobrepostos, nenhum.
    const sobrepostos = candidatos.some((c) => c !== vencedor && c.mtimeMs > vencedor.meta.nascimento);
    if (sobrepostos) {
      mapa.set(chave, { ...base, casamento: 'ambiguo' });
      continue;
    }

    mapa.set(chave, {
      ...base,
      sessaoId: vencedor.meta.sessaoId,
      arquivo: vencedor.caminho,
      casamento: 'ok',
      // `rodando` é da fase do busy/idle. Enquanto `estadoDoTurno` for o degrade, ele sai
      // `null` — que é valor legítimo do contrato: `lib/abas.js` já produz `null` para aba
      // sem CLI, e a tela desenha `null` como "pronta".
      rodando: await estadoDoTurno(vencedor.caminho, { processoVivo: true }),
    });
  }
  return mapa;
}

// ─── A fita ──────────────────────────────────────────────────────────────────

// As três constantes da leitura para trás, iguais às de `lib/externo.js` de propósito: dois
// leitores com réguas diferentes é a #40 esperando acontecer.
//
// O teto de 4 MB não é zelo aqui: as linhas do rollout chegam a 23,5 KB (`world_state`) e
// 18,5 KB (`session_meta`), e um `world_state` grande sozinho é a mesma família da #38.
const BLOCO = 64 * 1024;
const ALVO_MENSAGENS = 80;
const TETO_DURO = 4 * 1024 * 1024;

/**
 * Os `event_msg` que este módulo SABE que existem, mesmo os que não viram fita.
 *
 * Ela existe por causa do degrade de nível 2, e a distinção é fina: um arquivo em que só há
 * `task_started` e `token_count` é uma conversa que ainda não teve fala — fita vazia é a
 * verdade. Um arquivo em que há `agent_message` (o esquema de quatro semanas atrás) é uma
 * conversa que este módulo NÃO SABE LER — e aí a resposta certa é a abstenção, não o vazio.
 *
 * Sem esta lista os dois casos ficam idênticos, e a tela diria "não sei ler esta conversa"
 * para todo turno recém-começado.
 */
const PAYLOADS_CONHECIDOS = new Set([
  'item_completed', 'item_started', 'item_updated',
  'task_started', 'task_complete', 'token_count', 'thread_settings_applied',
]);

// Mesmo teto de `lib/externo.js:170`. Saída de comando é para caber numa bolha de celular,
// não para transportar um `cat` de arquivo grande.
const TETO_DE_SAIDA = 4000;

const textoDoConteudo = (conteudo) => (Array.isArray(conteudo) ? conteudo : [])
  .map((p) => (typeof p?.text === 'string' ? p.text : ''))
  .filter(Boolean)
  .join('\n');

/**
 * A mensagem legível de um `task_complete.error` — ou `null`.
 *
 * `{ message }` é o formato medido (03/09); string direta é aceita porque é dado do CLI, não
 * invenção. Qualquer outra forma, e mensagem vazia, devolvem `null`: bolha vazia ou com
 * `[object Object]` é pior que nenhuma (#10). O corte é o MESMO teto da saída de comando —
 * uma bolha de celular não transporta 9 KB de erro.
 */
const mensagemDoErro = (erro) => {
  const bruto = typeof erro === 'string' ? erro : erro?.message;
  const texto = typeof bruto === 'string' ? bruto.trim() : '';
  return texto ? texto.slice(0, TETO_DE_SAIDA) : null;
};

// O que a fita mostra quando um turno fecha com erro. O `\n\n` da frente é formatação do
// conteúdo: colado a uma fala anterior pelo cliente, o erro vira parágrafo próprio; sozinho,
// as linhas em branco somem no markdown. Sem ele a tela mostraria `Recebido.⚠️ O Codex…`.
const PREFIXO_DO_ERRO = '\n\n⚠️ O Codex não completou o turno: ';

/**
 * Uma linha do rollout → os eventos internos que a fita desenha.
 *
 * FONTE ÚNICA: `event_msg/item_completed`. O `response_item` é ignorado INTEIRO, e a razão
 * está medida — os ordinais 343 e 344 do rollout analisado são a mesma frase ("Teste"), uma
 * como `response_item/message` e outra como `item_completed/UserMessage`. Ler os dois faz a
 * fita sair em dobro. O `task_complete.last_agent_message` cai fora pelo mesmo motivo — mas o
 * `task_complete.error` entra, como `texto`: é o único lugar onde um turno que falhou (cota,
 * rede) deixa rastro, e sem ele a tela fica muda (03/09). Ele conta como fala (`ehFala`) de
 * propósito: é mensagem para o usuário, e é a hora que a lista deve mostrar.
 *
 * O vocabulário de saída é o MESMO de `lib/externo.js` — `humano`, `texto`, `ferramenta`,
 * `resultado_ferramenta` —, e é isso que faz a aba de Codex ser desenhada com zero linha de
 * tela nova.
 *
 * `quando` só nos DOIS eventos de fala. É a régua de `horaDaUltimaMensagem` e de
 * `eventosDoObjeto` do Claude, de propósito: `ferramenta` e `resultado_ferramenta` são
 * máquina falando com máquina e não viram bolha com hora própria.
 *
 * @param {object} linha  a linha já desserializada
 * @param {number} ordinal  a posição dela no arquivo, para o id de reserva do par
 */
function eventosDoObjeto(linha, ordinal = 0) {
  if (!linha || linha.type !== 'event_msg') return [];
  const payload = linha.payload;
  if (!payload) return [];

  const quando = typeof linha.timestamp === 'string' && linha.timestamp ? linha.timestamp : null;
  const comHora = (evento) => (quando ? { ...evento, quando } : evento);

  // O turno que fechou COM ERRO. O único lugar do rollout onde o erro existe é aqui — não há
  // `AgentMessage` para ele (medido em 03/09: `last_agent_message: null`, e a tela ficou muda
  // com a cota da OpenAI estourada). Vira `texto`, o vocabulário que a fita já desenha; o
  // `last_agent_message` continua de fora (caso 4). Sem `error` — o caso normal — não sai nada.
  if (payload.type === 'task_complete') {
    const mensagem = mensagemDoErro(payload.error);
    return mensagem ? [comHora({ tipo: 'texto', texto: PREFIXO_DO_ERRO + mensagem })] : [];
  }

  if (payload.type !== 'item_completed') return [];
  const item = payload.item;
  if (!item || typeof item.type !== 'string') return [];

  // O `item.id` veio preenchido nas 110 ocorrências medidas. O de reserva é único dentro do
  // arquivo por construção, e o id só precisa casar o par dentro da MESMA fita.
  const id = item.id || `codex-${ordinal}`;

  switch (item.type) {
    case 'UserMessage':
      return [comHora({ tipo: 'humano', texto: textoDoConteudo(item.content).trim() })];

    case 'AgentMessage':
      // `phase` NÃO filtra: `commentary` e `final_answer` são as duas fala do agente, e a
      // fita desenha as duas.
      return [comHora({ tipo: 'texto', texto: textoDoConteudo(item.content) })];

    case 'Reasoning':
      // `summary_text` e `raw_content` vieram VAZIOS nas 46 ocorrências medidas — o conteúdo
      // real vem cifrado no `response_item`, que este módulo não lê. Mesma exclusão que o
      // `isSidechain` já faz do outro lado.
      return [];

    case 'CommandExecution':
      return [
        { tipo: 'ferramenta', id, nome: 'Bash', entrada: { command: (item.command || []).join(' '), cwd: item.cwd } },
        {
          tipo: 'resultado_ferramenta',
          id,
          saida: String(item.aggregated_output ?? '').slice(0, TETO_DE_SAIDA),
          // Campo AUSENTE nunca vira cartão vermelho. `exit_code` que não veio significa
          // "esta versão do CLI não publica", não "o comando falhou" — pintar de vermelho
          // sem evidência é inventar estado, o mesmo pecado de chutar um teto no medidor.
          erro: Number.isInteger(item.exit_code) ? item.exit_code !== 0 : false,
        },
      ];

    case 'FileChange': {
      const mudancas = item.changes && typeof item.changes === 'object' ? item.changes : {};
      return [
        { tipo: 'ferramenta', id, nome: 'Edit', entrada: { caminhos: Object.keys(mudancas) } },
        {
          tipo: 'resultado_ferramenta',
          id,
          // Os tipos e os caminhos, NUNCA o `unified_diff`: a fita do Claude também não
          // desenha diff, e um diff inteiro numa bolha de celular é ilegível.
          saida: Object.entries(mudancas).map(([c, v]) => `${v?.type ?? '?'} ${c}`).join('\n'),
          erro: item.status === 'failed' || Boolean(String(item.stderr ?? '').trim()),
        },
      ];
    }

    case 'ImageView':
      // O par COMPLETO, não só a ferramenta: um cartão que nunca fecha fica girando na tela
      // para sempre — é o `resultado_ferramenta` que apaga o `estado: 'rodando'` do cliente.
      return [
        { tipo: 'ferramenta', id, nome: 'Read', entrada: { path: item.path } },
        { tipo: 'resultado_ferramenta', id, saida: String(item.path ?? ''), erro: false },
      ];

    default:
      // Degrade de NÍVEL 1: um `item.type` que não conhecemos é PULADO. Um tipo novo no meio
      // de uma conversa que se lê não pode derrubar a fita inteira.
      return [];
  }
}

const ehFala = (e) => e.tipo === 'humano' || e.tipo === 'texto';

/**
 * Uma janela de texto do rollout → eventos, com as duas contagens do degrade.
 *
 * `desconhecidos` é o que separa "esta conversa ainda não teve fala" de "esta conversa está
 * num esquema que eu não sei ler" — ver `PAYLOADS_CONHECIDOS`.
 */
function traduzir(texto, ordinalBase = 0) {
  const eventos = [];
  let falas = 0;
  let desconhecidos = 0;
  const linhas = texto.split('\n');
  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i];
    if (!linha.trim()) continue;
    let obj;
    // Linha ilegível no meio não derruba a leitura: pode ser um pedaço de escrita em curso.
    try { obj = JSON.parse(linha); } catch { continue; }
    if (obj?.type === 'event_msg' && !PAYLOADS_CONHECIDOS.has(obj.payload?.type)) desconhecidos += 1;
    const saiu = eventosDoObjeto(obj, ordinalBase + i);
    for (const e of saiu) if (ehFala(e)) falas += 1;
    eventos.push(...saiu);
  }
  return { eventos, falas, desconhecidos };
}

/**
 * A fita de uma conversa de Codex — MESMA assinatura e mesmo algoritmo de
 * `lib/externo.js`: leitura para trás em blocos de 64 KB, `carry` para a emenda de linha
 * (#11), teto duro de 4 MB, corte por número de MENSAGENS, e incremental para frente quando
 * `desde > 0`.
 *
 * 🔴 O degrade tem DOIS níveis, e eles NÃO são a mesma coisa:
 *
 *   1. item desconhecido dentro de um arquivo legível ⇒ PULA (em `eventosDoObjeto`);
 *   2. arquivo inteiro sem NENHUM evento de fala conhecido, e com `event_msg` que não se
 *      reconhece ⇒ devolve **`null`**, e a tela diz "não sei ler esta conversa".
 *
 * O nível 2 existe porque foi MEDIDO: o Codex trocou o esquema da fita inteiro entre
 * `0.144.6` (31/07: 58 `agent_message`, 0 `item_completed`) e `0.147.0` (28/08: o contrário),
 * com quatro semanas de intervalo. Duas consequências práticas — conversa antiga retomada com
 * `codex resume` sairia vazia, e a próxima atualização do Codex zeraria a fita de toda aba.
 * `[]` AFIRMA "não há mensagens" e é indistinguível de conversa nova; `null` é a abstenção
 * que a #10 pede. Nunca bolha quebrada, e nunca fita vazia mentindo.
 *
 * Ler o esquema velho está FORA de escopo: o cockpit não precisa de dois tradutores, precisa
 * saber que não sabe. Suportar o `0.144.6` seria feature, não degradê.
 */
async function lerConversa(arquivo, desde = 0, { alvoMensagens = ALVO_MENSAGENS } = {}) {
  const alvo = Math.max(1, Math.trunc(Number(alvoMensagens)) || ALVO_MENSAGENS);
  let info;
  try {
    info = await fsp.stat(arquivo);
  } catch {
    return { eventos: [], tamanho: 0, cortado: false, bytesLidos: 0 };
  }
  const inicio = desde > info.size ? 0 : desde;
  if (inicio === info.size) return { eventos: [], tamanho: info.size, cortado: false, bytesLidos: 0 };

  // Incremental: continua para FRENTE do offset até o fim, sem teto — é o que faz a resposta
  // aparecer no celular enquanto o agente ainda escreve. Aqui NÃO se devolve `null`: o
  // pedaço novo pode ser só um `token_count`, e abstenção no meio de um turno apagaria a
  // fita que já está na tela.
  if (inicio > 0) {
    let bruto = '';
    const alca = await fsp.open(arquivo, 'r');
    try {
      const buffer = Buffer.alloc(info.size - inicio);
      const { bytesRead } = await alca.read(buffer, 0, buffer.length, inicio);
      bruto = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await alca.close();
    }
    const sobra = bruto.endsWith('\n') ? '' : (bruto.split('\n').pop() ?? '');
    const util = sobra ? bruto.slice(0, bruto.length - sobra.length) : bruto;
    const { eventos } = traduzir(util);
    return {
      eventos,
      tamanho: info.size - Buffer.byteLength(sobra, 'utf8'),
      cortado: false,
      bytesLidos: info.size - inicio,
    };
  }

  const alca = await fsp.open(arquivo, 'r');
  try {
    let de = info.size;
    let carry = [];      // LISTA de Buffers do pedaço de linha que falta emendar; nunca tem '\n'.
    const blocos = [];   // listas de eventos, do mais ANTIGO para o mais novo (unshift).
    let lidos = 0;
    let msgs = 0;
    let desconhecidos = 0;
    let sobra = null;

    while (de > 0 && msgs < alvo && lidos < TETO_DURO) {
      const tamanhoDoBloco = Math.min(BLOCO, TETO_DURO - lidos, de);
      const novoDe = de - tamanhoDoBloco;

      // `read()` pode devolver menos bytes do que se pediu (a API do Node permite). Laço
      // interno até encher o bloco ou bater EOF, para não tratar um `read` curto como se
      // fosse uma linha perdida.
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
          // Bloco inteiro é continuação de UMA linha — o miolo de um `world_state` de 23 KB.
          // Nada a traduzir nesta volta, e a emenda continua pendente.
          carry.unshift(bloco);
          de = novoDe;
          continue;
        }
        corpo = Buffer.concat([bloco.subarray(nl + 1), ...carry]);
        carry = [bloco.subarray(0, nl)];
      } else {
        // Chegou ao byte 0 do arquivo: nada é carry, a primeira linha vem inteira.
        corpo = Buffer.concat([bloco, ...carry]);
        carry = [];
      }

      const texto = corpo.toString('utf8');
      let util = texto;
      if (sobra === null) {
        // Primeira volta que produz um `corpo` = a do EOF: o último pedaço é a linha sem
        // '\n' no fim (escrita em curso). Sai da conta, não passa por `JSON.parse`.
        const cauda = texto.split('\n').pop() ?? '';
        sobra = Buffer.byteLength(cauda, 'utf8');
        util = cauda ? texto.slice(0, texto.length - cauda.length) : texto;
      }

      const traduzido = traduzir(util, novoDe);
      desconhecidos += traduzido.desconhecidos;
      msgs += traduzido.falas;
      blocos.unshift(traduzido.eventos);
      de = novoDe;
    }

    const eventos = [].concat(...blocos);
    const tamanho = info.size - (sobra ?? 0);
    const cortado = de > 0;

    // O degrade de nível 2. A condição tem as DUAS metades de propósito: sem fala E com
    // `event_msg` que não se reconhece. Só a primeira faria toda conversa recém-aberta —
    // aquela que só tem `task_started` e `token_count` — dizer "não sei ler".
    if (!eventos.some(ehFala) && desconhecidos > 0) return null;

    return { eventos, tamanho, cortado, bytesLidos: lidos };
  } finally {
    await alca.close();
  }
}

// ─── O medidor ───────────────────────────────────────────────────────────────

/**
 * Os rótulos das janelas de consumo, DERIVADOS do dado — nunca fixos.
 *
 * A OpenAI já trocou o esquema do rollout uma vez em quatro semanas. Um rótulo derivado de
 * `window_minutes` sobrevive a uma janela nova; um rótulo fixo mente na cara do usuário.
 */
function rotuloDaJanela(minutos) {
  const m = Number(minutos);
  if (!Number.isFinite(m) || m <= 0) return 'Codex';
  if (m === 300) return 'Codex — 5h';
  if (m === 10080) return 'Codex — semana';
  if (m === 1440) return 'Codex — dia';
  return `Codex — ${Math.round(m / 60)}h`;
}

/**
 * O `rate_limits` daquele `token_count` → o MESMO formato que `lib/limite.js` produz para a
 * Anthropic: `{ rotulo, usado, reseta, resetaEm }`.
 *
 * Mesmo formato de propósito: a tela não pode ganhar um segundo jeito de desenhar a mesma
 * barra. `reseta` (a string humana, tipo "3h") fica `null` — não temos essa string, o cliente
 * já sabe derivar de `resetaEm`, e `undefined` em contrato some do JSON e faz do "formato
 * exato" uma mentira.
 *
 * O degrade tem TRÊS níveis, e o do meio é o que se erra:
 *   sem `token_count`                    ⇒ `null`   (quem chama é `doArquivo`)
 *   com `token_count`, sem `rate_limits` ⇒ `null`, e NÃO `[]` — `[]` afirmaria "sem limite"
 *   só um dos dois lados                 ⇒ lista de 1, que aqui é a verdade
 */
function limitesDe(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const itens = [];
  for (const lado of ['primary', 'secondary']) {
    const bruto = rateLimits[lado];
    if (!bruto || typeof bruto !== 'object') continue;
    const usado = Number(bruto.used_percent);
    // Fora de `0..100`, ausente ou não-numérico: o item é DESCARTADO. Número com cara de
    // número certo é o que a #10 proíbe.
    if (!Number.isFinite(usado) || usado < 0 || usado > 100) continue;
    const segundos = Number(bruto.resets_at);
    itens.push({
      rotulo: rotuloDaJanela(bruto.window_minutes),
      usado,
      reseta: null,
      // O campo vem em SEGUNDOS e o resto do cockpit trabalha em milissegundos. Errar o
      // ×1000 põe a data em 1970 sem uma linha de erro na tela.
      resetaEm: Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : null,
    });
  }
  return itens.length ? itens : null;
}

/**
 * O contexto ocupado e o consumo do plano, lidos na CAUDA do rollout.
 *
 * Mesma forma de `lib/contexto.js`: para trás, em blocos de 64 KB, com `carry` para a emenda
 * e teto duro de 4 MB. O alvo é o ÚLTIMO `event_msg/token_count`; o `modelo` e o `esforco`
 * saem do último `turn_context`, que costuma estar a poucas linhas dali.
 *
 * 🔴 `usados` é `info.last_token_usage.input_tokens`, e SÓ ele.
 *
 * O briefing do card mandava usar `total_token_usage`, e isso teria ido para o código: medido
 * no rollout real, `total_token_usage.total_tokens` são 5.236.004 contra uma janela de
 * 258.400 — **2026%** na tela. Aquele campo é o acumulado da SESSÃO INTEIRA, não o contexto
 * ocupado. E `cached_input_tokens` é SUBCONJUNTO de `input_tokens` no Codex (128.000 ≤
 * 128.823), diferente do Claude, onde o cache é somado por fora: somá-lo aqui contaria duas
 * vezes.
 *
 * O que o Codex DISPENSA em relação ao Claude: `janelaLongaConfigurada()`, `tetoDoModelo()` e
 * toda a heurística de `[1m]`/200k/1M. O teto vem no arquivo — `model_context_window`. Não se
 * lê `settings.json` nem se deduz nada.
 *
 * Degrade: sem `token_count` na cauda dentro do teto ⇒ `null`, e a tela não mostra medidor,
 * que é o que ela já faz quando não sabe. `model_context_window` ausente ⇒ `teto: null`,
 * `pct: null`, e os tokens aparecem sem porcentagem — teto chutado é número errado com cara
 * de número certo.
 */
async function doArquivo(caminho) {
  if (!caminho) return null;
  let info;
  try { info = await fsp.stat(caminho); } catch { return null; }
  if (!info.size) return null;

  let alca;
  try {
    alca = await fsp.open(caminho, 'r');
    let de = info.size;
    let carry = [];
    let lidos = 0;
    let contagem = null;   // o último `token_count`
    let turno = null;      // o último `turn_context`

    while (de > 0 && lidos < TETO_DURO && !(contagem && turno)) {
      const tamanhoDoBloco = Math.min(BLOCO, TETO_DURO - lidos, de);
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
          // Bloco inteiro é continuação de UMA linha (o miolo de um `world_state` de 23 KB).
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

      // Do fim para o começo dentro do bloco: o primeiro que aparecer é o último do arquivo.
      const linhas = corpo.toString('utf8').split('\n');
      for (let i = linhas.length - 1; i >= 0; i -= 1) {
        if (!linhas[i].trim()) continue;
        let obj;
        try { obj = JSON.parse(linhas[i]); } catch { continue; }
        if (!contagem && obj?.type === 'event_msg' && obj.payload?.type === 'token_count') contagem = obj;
        if (!turno && obj?.type === 'turn_context') turno = obj;
        if (contagem && turno) break;
      }
      de = novoDe;
    }

    if (!contagem) return null;

    const dados = contagem.payload?.info;
    const usados = Number(dados?.last_token_usage?.input_tokens);
    if (!Number.isFinite(usados) || usados <= 0) return null;
    const tetoBruto = Number(dados?.model_context_window);
    const teto = Number.isFinite(tetoBruto) && tetoBruto > 0 ? tetoBruto : null;
    const modo = turno?.payload?.collaboration_mode?.settings;

    return {
      usados,
      teto,
      // Uma casa decimal: o cliente arredonda para inteiro na etiqueta e usa o número cheio
      // na largura da barra. Mesma conta de `lib/contexto.js`.
      pct: teto ? Math.round((usados / teto) * 1000) / 10 : null,
      modelo: turno?.payload?.model || null,
      // `null` quando o CLI não publica o campo — medido, ele vem `null` mesmo. O chip de
      // esforço fica AUSENTE, não vazio: rótulo inventado é pior que rótulo nenhum.
      esforco: modo?.reasoning_effort ?? null,
      // O consumo da assinatura OpenAI, irmão de `info` no MESMO evento. Custo zero: a cauda
      // já foi lida e o evento já está desserializado.
      limites: limitesDe(contagem.payload?.rate_limits),
      // QUANDO esta medição foi feita — o `timestamp` do próprio evento, não o `mtime` do
      // arquivo (que muda por qualquer escrita, inclusive de um turno que não emitiu
      // `token_count`). É o que permite escolher, entre duas abas de Codex vivas, qual fala
      // pelo plano.
      medidoEm: Date.parse(contagem.timestamp || '') || null,
    };
  } catch {
    return null;
  } finally {
    await alca?.close().catch(() => {});
  }
}

// ─── Busy/idle ───────────────────────────────────────────────────────────────

// O teto da busca de ESTADO é 32 MB, não os 4 MB da fita — 18× o maior rollout medido
// (1,72 MB). Ele pode ser tão maior porque achar o último `task_*` não precisa de
// `JSON.parse` de todas as linhas: basta procurar duas strings e parsear só a que casar.
const TETO_DO_ESTADO = 32 * 1024 * 1024;

// Seis horas. O turno mais longo do rollout medido durou 39,9 s, então isto é folga larga —
// e é o mesmo remédio da #4: turno que não fecha não pode ficar pendurado para sempre.
const IDADE_MAXIMA_MS = 6 * 3600 * 1000;

/**
 * A aba está TRABALHANDO agora? `true` | `false` | `null`.
 *
 * O Codex publica no arquivo o que o Claude não publica (a #25 ao contrário):
 *
 *   task_started  { turn_id, started_at, model_context_window }
 *     … os eventos do turno …
 *   token_count   { info, rate_limits }
 *   task_complete { turn_id, last_agent_message, duration_ms }
 *   turn_aborted  { turn_id, reason, duration_ms }       // Escape no 0.152.1+
 *
 * Varrendo a cauda de trás para frente, **o primeiro evento `task_*` estruturalmente válido
 * decide, e o `turn_id` NÃO é pareado**: `task_started` ⇒ `true`, `task_complete` ou
 * `turn_aborted` ⇒ `false`.
 * Isso funciona porque os dois são sequenciais no arquivo, sem entrelaçamento — medido: 7
 * pares, 0 órfãos, nenhum `task_started` de T2 antes do `task_complete` de T1.
 *
 * 🔴 A STRING É FILTRO, NÃO DECISÃO. As duas palavras podem aparecer no texto de uma
 * mensagem ou na saída de um comando — este projeto mesmo, que analisa o formato do Codex,
 * tem as duas dentro de um `custom_tool_call_output`. A linha que casar é `JSON.parse`-ada e
 * só vale com `type === 'event_msg'` E o `payload.type` exato; qualquer outra coisa é
 * descartada e a varredura CONTINUA para trás.
 *
 * As três travas da armadilha #4, todas obrigatórias:
 *
 *   1. processo morto ⇒ `false`, sempre. Se o Codex morrer no meio do turno (crash, Ctrl-C,
 *      aba fechada), fica um `task_started` órfão para sempre e a aba diria "trabalhando"
 *      até o fim dos tempos.
 *   2. `task_started` com mais de 6 h sem `task_complete` ⇒ `false`.
 *   3. teto estourado, ou nada válido achado ⇒ **`null`**.
 *
 * E a spec é honesta sobre o que `null` faz na tela: o cliente desenha `aba.rodando ?
 * 'trabalhando' : 'pronta'`, então `null` aparece como **"pronta"**. É a escolha certa mesmo
 * assim, porque os dois erros possíveis não têm o mesmo preço: dizer "pronta" para uma aba
 * que trabalha se corrige sozinho no tique seguinte de 5 s; dizer "trabalhando" para uma aba
 * parada é a #4, que fica pendurada para sempre e já custou uma rodada neste projeto.
 */
async function estadoDoTurno(caminho, { processoVivo = true } = {}) {
  // A trava 1 vence tudo, e vem antes de abrir o arquivo: sem processo não há turno.
  if (!processoVivo) return false;
  if (!caminho) return null;

  let info;
  try { info = await fsp.stat(caminho); } catch { return null; }
  if (!info.size) return null;

  let alca;
  try {
    alca = await fsp.open(caminho, 'r');
    let de = info.size;
    let carry = '';
    let lidos = 0;

    while (de > 0 && lidos < TETO_DO_ESTADO) {
      const tamanhoDoBloco = Math.min(BLOCO, TETO_DO_ESTADO - lidos, de);
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

      // A emenda (#11): o pedaço de linha que sobrou do bloco anterior é grudado no fim
      // deste. Sem ela, um `task_*` que caia na fronteira de dois blocos some.
      const texto = bloco.toString('utf8') + carry;
      const linhas = texto.split('\n');
      // No começo do arquivo a primeira linha vem inteira; fora dele, ela é continuação.
      carry = novoDe > 0 ? linhas.shift() ?? '' : '';

      for (let i = linhas.length - 1; i >= 0; i -= 1) {
        const linha = linhas[i];
        // O filtro barato primeiro: sem uma das duas palavras, nem chega ao parser.
        if (!linha.includes('task_started') && !linha.includes('task_complete')
          && !linha.includes('turn_aborted')) continue;
        let obj;
        try { obj = JSON.parse(linha); } catch { continue; }
        if (obj?.type !== 'event_msg') continue;      // a validação ESTRUTURAL
        const tipo = obj.payload?.type;
        if (tipo === 'task_complete' || tipo === 'turn_aborted') return false;
        if (tipo !== 'task_started') continue;
        // A trava 2. O carimbo da linha é o relógio confiável; o `started_at` do payload é o
        // reserva, para uma versão do CLI que pare de escrever o de fora.
        const quando = Date.parse(obj.timestamp || obj.payload?.started_at || '');
        if (Number.isFinite(quando) && Date.now() - quando > IDADE_MAXIMA_MS) return false;
        return true;
      }
      de = novoDe;
    }
    // Teto estourado, ou a varredura chegou ao começo sem achar nenhum `task_*` VÁLIDO — o
    // que é o mesmo desfecho, e é por isso que os dois devolvem a mesma coisa.
    return null;
  } catch {
    return null;
  } finally {
    await alca?.close().catch(() => {});
  }
}

module.exports = {
  lerConversa, doArquivo, eventosDoObjeto, estadoDoTurno, sessoesDoCodex, sessionMetaDe, PREFIXO_DO_ERRO,
  rotuloDaJanela, limitesDe,
  BLOCO, ALVO_MENSAGENS, TETO_DURO,
};
