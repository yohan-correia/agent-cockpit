'use strict';
// O que aconteceu dentro de um JOB do orquestrador — o terceiro leitor do contrato
// (lib/externo.js, lib/adaptador-codex.js, e este).
//
// Um job roda `claude -p` em stream-json, gravando em `<pasta-do-job>/claude.log`. Esse
// arquivo NÃO é o `.jsonl` da conversa interativa que `lib/externo.js` lê — é outro formato,
// com outro envelope (spec `2026-09-09-ver-a-conversa-do-job-design.md`, §2.1). O miolo
// (`message.content`, blocos `text`/`tool_use`/`tool_result`) é o MESMO objeto da API
// Anthropic; a casca é diferente. Este módulo traduz a casca — o que se COMPARTILHA com os
// irmãos é o CONTRATO (`lerConversa`/`doArquivo`), não o código.
//
// As três diferenças em relação a `lib/externo.js`:
//
//   1. ENVELOPE — a marca de subagente é `parent_tool_use_id`, não `isSidechain`.
//   2. SUBAGENTE MARCADO, NUNCA DESCARTADO — `lib/externo.js` faz
//      `if (obj.isSidechain) return []`. Aqui o evento leva `sub` = o `parent_tool_use_id`
//      (identidade, nunca booleano: dois subagentes em paralelo com `sub: true` teriam suas
//      falas coladas na mesma bolha). Motivo medido: em jobs dominados por subagente, jogar
//      esse trabalho fora deixaria a fita vazia.
//   3. A CONTAGEM DA CAUDA INCLUI OS DOIS LADOS — sem isso, um job com rajada longa de
//      subagente faria a leitura para trás varrer o `TETO_DURO` inteiro e voltar com pouca
//      coisa (medido: 8 MB e só 11 passos do principal). Ver o comentário em `lerConversa`.
//
// O que ele NÃO faz: escrever, aprovar, mergear ou falar com um job. Um job só se LÊ
// (`lib/agentes.js`, campo `executavel: false`).
//
// TEM sim janela de contexto para medir (card `contexto-da-sessao-do-job`, 22/09): medido, um
// job tem uma sessão PRINCIPAL contínua, do primeiro ao último evento, com subagentes
// pendurados nela — não são "muitos agentes em sequência". `doArquivo` (abaixo) varre para
// trás e devolve o `usage` da sessão principal; nunca o do subagente.
//
// Sem nenhuma dependência do painel do orquestrador: a lista de ids válidos sai do DISCO
// (`idValido` + `existe`, abaixo), nunca de `/api/jobs` — que é HTTP filtrado e pode estar
// fora do ar.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { dirJobs } = require('./limite');
const { somaDoUso, tetoDoModelo, janelaLongaConfigurada } = require('./contexto');

/** Texto de uma mensagem, seja ela string ou lista de blocos — igual ao dos dois irmãos. */
function textoDe(mensagem) {
  const conteudo = mensagem?.content;
  if (typeof conteudo === 'string') return conteudo;
  if (!Array.isArray(conteudo)) return '';
  return conteudo.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');
}

/**
 * Uma linha do `claude.log` virando os eventos que a fita desenha, mais o efeito colateral
 * de aprender o nome de um subagente novo em `mapaAgentes`.
 *
 * REIMPLEMENTADO, não importado de `lib/externo.js:333` — aquele começa com
 * `if (obj.isSidechain) return []` e nunca marca `sub`, os dois comportamentos que este
 * leitor precisa inverter (spec §3.3). O que se compartilha é o CONTRATO, não a função.
 *
 * `sub` é anexado a TODO evento que sai daqui (aditivo — os outros dois leitores nunca o
 * mandam): `null` no agente principal, o `parent_tool_use_id` no subagente. `subNome` e
 * `subTarefa` NÃO são resolvidos aqui — dependem do `mapaAgentes`, que pode ainda não ter o
 * `Agent` correspondente nesta mesma passada (a varredura da cauda é de trás para frente, e
 * o `Agent` pode estar num bloco mais ANTIGO que os filhos). A resolução é uma segunda
 * passada, feita por `resolverSubagentes` sobre o conjunto já lido inteiro.
 */
function eventosDoObjeto(obj, mapaAgentes) {
  const sub = obj.parent_tool_use_id || null;
  const quando = typeof obj.timestamp === 'string' && obj.timestamp ? obj.timestamp : null;
  const comHora = (evento) => (quando ? { ...evento, quando } : evento);
  const comSub = (evento) => ({ ...evento, sub });

  // tool_result e texto de gente chegam os dois como `user` — o formato não os separa por
  // tipo. `content` pode ser uma STRING (texto puro) ou uma lista de blocos (`tool_result`);
  // só a segunda forma é testada por `Array.isArray` antes de entrar no ramo de ferramenta.
  if (obj.type === 'user') {
    const partes = Array.isArray(obj.message?.content) ? obj.message.content : null;
    if (partes && partes.some((p) => p.type === 'tool_result')) {
      const saidas = [];
      for (const parte of partes) {
        if (parte.type !== 'tool_result') continue;
        const bruto = typeof parte.content === 'string'
          ? parte.content
          : (Array.isArray(parte.content)
            ? parte.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
            : '');
        saidas.push(comSub({
          tipo: 'resultado_ferramenta',
          id: parte.tool_use_id,
          saida: String(bruto).slice(0, 4000),
          erro: Boolean(parte.is_error),
          ...(quando ? { t: quando } : {}),
        }));
      }
      return saidas;
    }

    const texto = textoDe(obj.message).trim();
    if (!texto) return [];
    // 🔴 Texto de gente COM `parent_tool_use_id` é o PROMPT que o agente principal mandou ao
    // filho — medido em 12/09: existe um por subagente lançado. Ele já está na tela como a
    // `entrada` do cartão da ferramenta `Agent`, desenhado logo acima. Emiti-lo como `humano`
    // faria uma bolha "eu" que o dono nunca escreveu (a confusão de autoria que a §2.4 da
    // spec existe para barrar, com causa nova). Descartar, não desenhar como fala marcada.
    if (sub) return [];
    return [comHora({ tipo: 'humano', texto, sub: null })];
  }

  if (obj.type === 'assistant') {
    const eventos = [];
    for (const parte of obj.message?.content || []) {
      if (parte.type === 'text' && parte.text.trim()) {
        eventos.push(comSub(comHora({ tipo: 'texto', texto: parte.text })));
      } else if (parte.type === 'tool_use') {
        // O `tool_use` do `Agent` é onde o nome do subagente mora (`subagent_type`,
        // `description`) — não vem de graça no envelope dos EVENTOS do subagente (medido
        // 12/09, §0 do plano). `id` deste `tool_use` é exatamente o `parent_tool_use_id`
        // dos filhos, então ele é a CHAVE do mapa.
        if (parte.name === 'Agent' && mapaAgentes) {
          mapaAgentes.set(parte.id, {
            subNome: parte.input?.subagent_type || null,
            subTarefa: parte.input?.description || null,
          });
        }
        eventos.push(comSub({
          tipo: 'ferramenta', id: parte.id, nome: parte.name, entrada: parte.input,
          ...(quando ? { t: quando } : {}),
        }));
      }
      // `thinking` → ignorado: o `claude.log` tem blocos com `thinking: ""` e uma
      // `signature` de ~1 KB; virariam bolha vazia.
    }
    return eventos;
  }

  // `system`, `tool_progress`, `rate_limit_event`, `result` — máquina falando com máquina,
  // e nenhum vira bolha (81 `system` e 2 `rate_limit_event` medidos nos primeiros 300 KB de
  // um `claude.log` real em 12/09).
  return [];
}

/**
 * Segunda passada: resolve `subNome`/`subTarefa` de cada evento marcado, usando o
 * `mapaAgentes` já completo (depois que a leitura inteira — todos os blocos — terminou).
 *
 * Precisa ser uma passada SEPARADA da que monta os eventos: a varredura da cauda anda de
 * trás para frente por blocos, e um `Agent` lido num bloco mais ANTIGO (processado depois,
 * nesse sentido) tem de conseguir nomear filhos que vieram de um bloco mais NOVO (processado
 * antes). Rodar esta função só depois de concluída a leitura inteira garante isso.
 *
 * Evento sem `sub` (principal) não ganha `subNome`/`subTarefa` — os campos ficam ausentes,
 * como nos dois leitores irmãos, que nunca os mandam.
 */
function resolverSubagentes(eventos, mapaAgentes) {
  for (const evento of eventos) {
    if (!evento.sub) continue;
    const info = mapaAgentes.get(evento.sub);
    // `Agent` fora da cauda lida ⇒ `info` é `undefined`, e `subNome` sai `null` — honesto:
    // a tela desenha "└ subagente" em vez de inventar um nome.
    evento.subNome = info ? info.subNome : null;
    evento.subTarefa = info ? info.subTarefa : null;
  }
  return eventos;
}

/**
 * As duas constantes da leitura para trás — MESMOS valores de `lib/externo.js` e
 * `lib/adaptador-codex.js`, de propósito (o irmão do Codex fez igual), mas declaradas
 * LOCAIS: importar criaria um acoplamento que nenhum dos dois pede de volta.
 *
 * `ALVO_MENSAGENS` conta TODO evento emitido — ferramenta, resultado, texto e humano, dos
 * dois lados (principal e subagente) — e não só bolha com hora, como o `lib/externo.js`
 * conta para a conversa interativa. Motivo (spec §2.5/§3.3 item 3): um job pode ter uma
 * rajada longa de subagente com pouquíssimo texto solto; contar só bolha faria a leitura
 * varrer o `TETO_DURO` inteiro atrás de 80 falas que talvez nem existam nessa quantidade —
 * medido: contando só passos do PRINCIPAL, uma leitura de 8 MB voltava com apenas 11.
 * Contando os dois lados (qualquer evento, de qualquer autor), a leitura converge bem antes
 * do teto na maioria dos jobs medidos.
 */
const BLOCO = 64 * 1024;
const ALVO_MENSAGENS = 80;
const TETO_DURO = 4 * 1024 * 1024;

/**
 * O `usage` da sessão PRINCIPAL de um pedaço de `claude.log` — espelha `lib/contexto.js:medir`
 * na FORMA do retorno (`{usados, teto, pct, modelo, esforco}`) e REUSA `somaDoUso`/`tetoDoModelo`
 * de lá; o que muda é só o envelope do job:
 *
 * - Descarta subagente por `obj.parent_tool_use_id` **truthy** — nunca
 *   `'parent_tool_use_id' in obj`: a chave existe em TODO evento `assistant` do `claude.log`,
 *   com `null` no principal (ver o cabeçalho do módulo).
 * - `esforco` é **sempre `null`** — o `claude.log` não traz o campo (medido). Rótulo inventado é
 *   pior que rótulo nenhum: o chip simplesmente some.
 * - `usage` todo zerado (evento sintético do CLI) é pulado, igual à irmã.
 *
 * SEM o parâmetro `cortado` da irmã: os dois chamadores (o laço de `doArquivo` e o ramo
 * incremental de `lerConversa`, abaixo) garantem linha inteira por construção — um parâmetro
 * cuja condição nunca acontece é a armadilha #30.
 *
 * @param {string} bruto texto do pedaço lido.
 * @param {{longa?: boolean}} opcoes `longa` = o CLI está configurado na janela de 1M.
 */
function medir(bruto, { longa = false } = {}) {
  const linhas = String(bruto || '').split('\n');
  let achado = null;
  for (const linha of linhas) {
    if (!linha.trim()) continue;
    let obj;
    try { obj = JSON.parse(linha); } catch { continue; }
    if (obj.type !== 'assistant') continue;
    if (obj.parent_tool_use_id) continue;
    const usados = somaDoUso(obj.message?.usage);
    if (usados <= 0) continue;
    achado = { usados, modelo: obj.message?.model || null };
  }
  if (!achado) return null;
  const teto = tetoDoModelo(achado.modelo, achado.usados, { longa });
  return {
    usados: achado.usados,
    teto,
    pct: teto ? Math.round((achado.usados / teto) * 1000) / 10 : null,
    modelo: achado.modelo,
    esforco: null,
  };
}

/**
 * A conversa inteira de um `claude.log`, ou só o pedaço que cresceu desde `desde` bytes —
 * mesmo contrato de `lib/externo.js:lerConversa` e `lib/adaptador-codex.js:lerConversa`.
 *
 * `subagentes`, opcional: um `Map` de `tool_use.id → {subNome, subTarefa}` que o CHAMADOR
 * mantém vivo por fluxo (`server.js`, `acompanharJob`). Sem ele, cada chamada usa um `Map`
 * local — comportamento de hoje, sem memória entre chamadas. COM ele, o nome de um `Agent`
 * lido numa leitura sobrevive para nomear filhos que só aparecem numa leitura seguinte
 * (incremental). Cache DENTRO do módulo, por caminho de arquivo, está recusado: vazaria
 * memória por job aberto e ninguém saberia quando limpar — por isso o Map é do chamador.
 *
 * `contexto`, opcional (`{longa}`): OPT-IN, espelhando `lib/externo.js:442-443`. Sem ele, o
 * retorno é byte por byte o de hoje — nem a medição acontece, nem a chave `contexto` aparece.
 * COM ele, OS DOIS RAMOS medem (ao contrário da irmã, que só mede no incremental): um job
 * aberto com o log ainda vazio tem o primeiro lote com `usage` entrando pelo ramo INICIAL, e
 * se o job terminar sem escrever mais nada, só esse ramo teria a chance de medir aquele
 * número. A medição do ramo inicial é `best-effort`, não garantia — ver `server.js:acompanharJob`.
 */
async function lerConversa(arquivo, desde = 0, { alvoMensagens = ALVO_MENSAGENS, subagentes, ate = null, contexto = null } = {}) {
  const alvo = Math.max(1, Math.trunc(Number(alvoMensagens)) || ALVO_MENSAGENS);
  const mapaAgentes = subagentes instanceof Map ? subagentes : new Map();
  const medeContexto = Boolean(contexto);
  const comContexto = (retorno, medido) => (medeContexto ? { ...retorno, contexto: medido } : retorno);

  let info;
  try {
    info = await fsp.stat(arquivo);
  } catch {
    return null;
  }

  const teto = Number.isFinite(Number(ate)) && Number(ate) > 0 ? Math.min(Math.trunc(Number(ate)), info.size) : info.size;
  const inicio = desde > info.size ? 0 : desde;
  if (inicio === teto) return comContexto({ eventos: [], tamanho: info.size, cortado: false, bytesLidos: 0, inicio }, null);

  // Incremental: continua a leitura para FRENTE do offset até o fim, sem teto — nunca se
  // abstém (o pedaço novo pode ser só um evento de máquina, e apagar a fita por isso seria
  // pior que o silêncio). Uma única passada basta: é chronológica, então o `Agent` sempre
  // precede os filhos dentro dela; e o `mapaAgentes` (se persistido pelo chamador) já carrega
  // o que veio de leituras anteriores.
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
    const linhas = bruto.split('\n');
    const sobra = bruto.endsWith('\n') ? '' : linhas.pop() ?? '';
    const eventos = [];
    for (const linha of linhas) {
      if (!linha.trim()) continue;
      let obj;
      try { obj = JSON.parse(linha); } catch { continue; }
      eventos.push(...eventosDoObjeto(obj, mapaAgentes));
    }
    resolverSubagentes(eventos, mapaAgentes);
    return comContexto({
      eventos,
      tamanho: info.size - Buffer.byteLength(sobra, 'utf8'),
      cortado: false,
      bytesLidos: info.size - inicio,
      inicio: desde,
    }, medeContexto ? medir(bruto, { longa: Boolean(contexto.longa) }) : null);
  }

  // Leitura inicial: para trás, em blocos, pela regra de mensagens (mesma forma de
  // `lib/externo.js:496`, valores explicados acima).
  const alca = await fsp.open(arquivo, 'r');
  try {
    let de = teto;
    let carry = [];       // LISTA de Buffers do pedaço de linha que falta emendar; nunca contém '\n'.
    let blocos = [];      // lista de listas de eventos, do mais ANTIGO para o mais novo (unshift).
    let lidos = 0;
    let msgs = 0;
    let sobra = null;     // bytes da linha incompleta do FIM do arquivo — determinada uma única vez.
    let algumaLinhaReconhecida = false; // pelo menos uma linha era JSON válido de verdade
    let inicioDoCorpo = null;
    // A medição do ramo inicial (`contexto`, opcional): duas réguas DIFERENTES, de propósito.
    // Entre BLOCOS (o laço externo, de trás para frente) vale o PRIMEIRO bloco com achado —
    // por isso `contextoAchado` só é fixado UMA vez, no bloco mais próximo do fim. DENTRO de
    // um bloco, a ordem é cronológica — por isso `achadoDoBloco` é sobrescrito sem `break`,
    // igual a `lib/contexto.js:medir`, e vale o ÚLTIMO principal daquele bloco.
    let contextoAchado = null;

    while (de > 0 && msgs < alvo && lidos < TETO_DURO) {
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
      // Arquivo encolheu entre o `stat` e o `read`: para o laço, devolve o que já se tem.
      if (bloco.length === 0) break;

      let corpo;
      if (novoDe > 0) {
        const nl = bloco.indexOf(10); // '\n'
        if (nl < 0) {
          // Bloco inteiro é continuação de UMA linha: nada a parsear nesta volta.
          carry.unshift(bloco);
          de = novoDe;
          continue;
        }
        corpo = Buffer.concat([bloco.subarray(nl + 1), ...carry]);
        carry = [bloco.subarray(0, nl)];
        if (corpo.length > 0) inicioDoCorpo = novoDe + nl + 1;
      } else {
        // Chegou ao byte 0 do arquivo: nada é carry, a primeira linha vem inteira.
        corpo = Buffer.concat([bloco, ...carry]);
        carry = [];
        if (corpo.length > 0) inicioDoCorpo = 0;
      }

      const linhas = corpo.toString('utf8').split('\n');
      if (sobra === null) {
        // Primeira volta que produz um `corpo` = a do EOF: o último elemento é a linha sem
        // '\n' no fim (escrita em curso). Sai da lista, não passa por JSON.parse.
        sobra = Buffer.byteLength(linhas.pop(), 'utf8');
      }

      const eventosDoBloco = [];
      // Achado do PRINCIPAL deste bloco — de graça: a linha já foi parseada acima para
      // `eventosDoObjeto`. Sobrescrito a cada `assistant` principal com `usage`, sem `break`:
      // dentro de UM bloco a ordem é cronológica, então o último encontrado é o certo.
      let achadoDoBloco = null;
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        let obj;
        try { obj = JSON.parse(linha); } catch { continue; }
        algumaLinhaReconhecida = true;
        eventosDoBloco.push(...eventosDoObjeto(obj, mapaAgentes));
        if (medeContexto && obj.type === 'assistant' && !obj.parent_tool_use_id) {
          const usados = somaDoUso(obj.message?.usage);
          if (usados > 0) achadoDoBloco = { usados, modelo: obj.message?.model || null };
        }
      }
      // Entre blocos vale o PRIMEIRO com achado (o mais próximo do fim do arquivo) — por isso
      // só fixa quando `contextoAchado` ainda é `null`.
      if (medeContexto && !contextoAchado && achadoDoBloco) {
        const tetoAchado = tetoDoModelo(achadoDoBloco.modelo, achadoDoBloco.usados, { longa: Boolean(contexto.longa) });
        contextoAchado = {
          usados: achadoDoBloco.usados,
          teto: tetoAchado,
          pct: tetoAchado ? Math.round((achadoDoBloco.usados / tetoAchado) * 1000) / 10 : null,
          modelo: achadoDoBloco.modelo,
          esforco: null,
        };
      }
      // Os dois lados contam — ver o comentário de `ALVO_MENSAGENS` acima.
      msgs += eventosDoBloco.length;
      blocos.unshift(eventosDoBloco);
      de = novoDe;
    }

    // Abstenção: nada do que foi lido era JSON reconhecível — arquivo de formato estranho ou
    // corrompido. Fita vazia mentiria "conversa nova"; `null` diz "não sei ler". Sob `ate`, o
    // leitor não abstém: o trecho ilegível é pulado e o botão continua vivo (§3.1 da spec).
    if (ate === null && !algumaLinhaReconhecida) return null;

    const eventos = [].concat(...blocos);
    resolverSubagentes(eventos, mapaAgentes);
    const tamanho = teto - (sobra ?? 0);
    const cortado = de > 0;
    const bytesLidos = lidos;
    const inicioDoLote = inicioDoCorpo ?? de;
    return comContexto({ eventos, tamanho, cortado, bytesLidos, inicio: inicioDoLote }, contextoAchado);
  } finally {
    await alca.close();
  }
}

/**
 * O contexto da sessão PRINCIPAL de um job, lido na CAUDA do `claude.log` — para trás, em
 * blocos. MESMA forma de `lib/contexto.js:doArquivo` (carry de emenda #11, laço interno de
 * `read` curto, `finally` com `close`) — mas SEM `alvoMensagens`: a régua aqui é "achou o
 * alvo", não "juntou N mensagens" (armadilha #69). Copiar a parada por contagem de
 * `lerConversa` faria 80 eventos de uma rajada de subagente encerrarem a busca sem achar
 * nenhum principal.
 *
 * `janelaLongaConfigurada()` é lida UMA vez, fora do laço: a config do CLI não muda entre um
 * bloco e outro. `server.js:395` chama `medidor.doArquivo` na abertura de `acompanharJob` (e
 * o relógio de 700 ms reinsiste enquanto nunca mediu — ver lá).
 *
 * Sem achar dentro do `TETO_DURO` devolve `null` — a tela fica sem medidor, que é o mesmo
 * caminho que ela já desenha quando não há `usage` reconhecível.
 */
async function doArquivo(caminho) {
  if (!caminho) return null;
  let info;
  try { info = await fsp.stat(caminho); } catch { return null; }
  if (!info.size) return null;

  const longa = await janelaLongaConfigurada();

  let alca;
  try {
    alca = await fsp.open(caminho, 'r');
    let de = info.size;
    let carry = [];
    let lidos = 0;

    while (de > 0 && lidos < TETO_DURO) {
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
        const nl = bloco.indexOf(10);
        if (nl < 0) {
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

      const achado = medir(corpo.toString('utf8'), { longa });
      if (achado) return achado;
      de = novoDe;
    }
    return null;
  } catch {
    return null;
  } finally {
    await alca?.close().catch(() => {});
  }
}

/** `id` de job válido para virar caminho de disco — regex FECHADA e teto de tamanho. */
function idValido(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 120 && /^[0-9a-z-]+$/.test(id);
}

/** Onde o log de um job mora, dado o id — `dirJobs` é o dono único do caminho-base (§5.4). */
function caminhoDoLog(id) {
  return path.join(dirJobs(), id, 'claude.log');
}

/**
 * O id corresponde a uma pasta de verdade no disco de jobs?
 *
 * Duas travas, não uma (§7.8 da spec): `idValido` barra `../` na FORMA da string; esta
 * função barra id inventado que passe na forma mas não exista. A lista sai do DISCO
 * (`readdir`), nunca de `/api/jobs` — que é HTTP filtrado e pode estar fora do ar.
 */
async function existe(id) {
  try {
    const nomes = await fsp.readdir(dirJobs());
    return nomes.includes(id);
  } catch {
    return false;
  }
}

module.exports = {
  lerConversa, doArquivo, eventosDoObjeto, idValido, caminhoDoLog, existe,
  ALVO_MENSAGENS, TETO_DURO, BLOCO,
};
