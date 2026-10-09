'use strict';
// "Para onde vão meus tokens" — a metade do CODEX. Espelho de `lib/uso.js`, mas com a fonte,
// o acumulador e o cache PRÓPRIOS (spec `2026-09-22-codex-no-relatorio-de-tokens-design.md`,
// D3-D5): o rollout do Codex não tem a mesma semântica de campos do Claude, e reusar o array
// de 7 posições de lá contaria o cache DUAS vezes (D3).
//
// A MESMA promessa de privacidade de `lib/uso.js:14`: nenhum byte de CONTEÚDO sai na resposta
// nem entra no cache. O risco aqui é MAIOR, não menor — o rollout do Codex carrega
// `base_instructions.text` (o system prompt inteiro) e o texto de toda mensagem. O que
// sobrevive de cada linha: cinco números, um id de modelo, um nome de projeto e uma data. O
// objeto do `JSON.parse` é descartado ao fim de cada linha, como em `lib/uso.js`.
//
// A fonte é `event_msg`/`token_count` (D1 — `token_usage_record` some em 2/3 do disco). O
// campo que interessa, `total_token_usage`, é o ACUMULADO da sessão inteira, não um incremento
// — por isso todo o miolo deste módulo é `deltaDe()`: o corte de segmento é decidido UMA vez
// pelo `total_tokens` e aplicado aos demais campos (D2).
//
// Reusa de `lib/uso.js` (D4): `linhasDe`/`assinaturaDe` (a leitura em blocos de 64 KB, o teto
// de 1 MB por linha, a assinatura dos 256 bytes antes do offset), `num`/`horaDe` e, desde
// 25/09 (card `tela-de-uso-no-fuso-do-aparelho`), `diaNoFuso`/`janelaNoFuso`/`rotuloDoFuso`/
// `fusoValido` — o dia local no fuso do aparelho é a MESMA regra dos dois lados. NÃO reusa
// `sessionMetaDe` do adaptador-codex (D4.2 — ela exige `source === 'cli'` e perderia 96% dos
// arquivos, todo `codex exec`). A assinatura vai HASHEADA (sha256), não em hex cru (D4.1): o
// hex de `assinaturaDe` é reversível, e aqui o arquivo é pior que o do Claude.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { linhasDe, assinaturaDe, num, horaDe, diaNoFuso, janelaNoFuso, rotuloDoFuso, fusoValido } = require('./uso');
const { varrerRollouts } = require('./adaptador-codex');
const { dirJobs } = require('./limite');

// Lidos do ENV a CADA chamada (nunca constante de topo) — é o que permite ao gate trocar de
// cenário no MESMO processo, mesmo hábito de `lib/uso.js:93` e `lib/adaptador-codex.js:39`.
function dirCache() {
  return process.env.COCKPIT_USO_CODEX_DIR || path.join(os.homedir(), '.cockpit', 'uso-codex');
}
function caminhoCache() {
  return path.join(dirCache(), 'cache.json');
}

// 1 → 2 (25/09, card `tela-de-uso-no-fuso-do-aparelho`): a chave do agregado passou de dia UTC
// para hora UTC (`AAAA-MM-DDTHH`), espelhando `lib/uso.js:55`. Um cache v1 tem `dias`, não
// `horas`; é ignorado inteiro e revarrido.
const VERSAO_CACHE = 2;

// ─── funções puras ──────────────────────────────────────────────────────────

/**
 * A classificação de um `cwd` de rollout — regra COPIADA (não importada) de `classificar`
 * (`lib/uso.js:164`), porque lá ela é casada com o NOME ACHATADO de pasta que o CLI da
 * Anthropic fabrica (`cru()`); aqui já se tem o caminho ABSOLUTO (D5).
 *
 * `meta` é o `meta.json` do orquestrador já parseado (ou `null`) — quem lê o disco é `varrer()`,
 * esta função é pura (mesmo contrato de `classificar(pasta, meta)`).
 *
 *   `${homedir()}/projetos/<nome>/…`                      → `<nome>`
 *   `${COCKPIT_WORKTREES_DIR || homedir()/.cockpit/worktrees}/<id>/…` → `meta.project`, senão
 *                                                            `(job sem registro)`
 *   nada disso                                             → `(fora de projeto)`
 */
function projetoDe(cwd, meta) {
  if (typeof cwd !== 'string' || !cwd) return '(fora de projeto)';
  const preProjeto = `${path.join(os.homedir(), 'projetos')}${path.sep}`;
  if (cwd.startsWith(preProjeto)) {
    const resto = cwd.slice(preProjeto.length);
    const nome = resto.split(path.sep)[0];
    return nome || '(fora de projeto)';
  }
  const preWorktree = `${process.env.COCKPIT_WORKTREES_DIR || path.join(os.homedir(), '.cockpit', 'worktrees')}${path.sep}`;
  if (cwd.startsWith(preWorktree)) {
    if (meta && typeof meta.project === 'string' && meta.project) return meta.project;
    return '(job sem registro)';
  }
  return '(fora de projeto)';
}

const CAMPOS_TOTAL = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens', 'total_tokens'];

/**
 * O coração do módulo (D2). `atual`/`anterior` são o `total_token_usage` cru do `token_count`
 * (ou `null` para `anterior`, quando é a primeira leitura do arquivo).
 *
 * O corte é decidido UMA VEZ, pelo `total_tokens`, e aplicado aos DEMAIS campos — decidir
 * campo a campo permitiria que `input` abrisse segmento novo e `output` não. Todo campo passa
 * por `num()` (clamp ≥ 0, nunca NaN/negativo/string solta).
 */
function deltaDe(atual, anterior) {
  const a = {};
  for (const campo of CAMPOS_TOTAL) a[campo] = num(atual && atual[campo]);
  const segmentoNovo = !anterior || a.total_tokens < num(anterior.total_tokens);
  const delta = {};
  for (const campo of CAMPOS_TOTAL) {
    delta[campo] = segmentoNovo ? a[campo] : num(a[campo] - num(anterior[campo]));
  }
  return delta;
}

/**
 * Soma um evento já parseado no acumulador de UM arquivo (`alvo.horas`), com o contexto
 * mutável de UMA varredura sequencial (`estado.modelo`/`estado.cwd`) — os dois vêm de linhas
 * DIFERENTES da que carrega o `token_count` (`session_meta`/`turn_context`), diferente do
 * Claude, onde tudo mora na mesma linha `assistant`.
 *
 * Pura e testável sem disco: quem lê o arquivo é `varrer()`, que popula `estado` e persiste
 * `alvo.modelo`/`alvo.ultimoTotal`/`alvo.projeto` ao fim da varredura.
 *
 * O acumulador de CADA (hora, modelo) tem 5 posições — D3: `[entrada, saida, cacheLeitura,
 * raciocinio, n]`. `cache_write_input_tokens` é DESCARTADO (medido: sempre 0).
 */
function agregarEvento(obj, alvo, estado) {
  if (!obj || typeof obj !== 'object') return;

  if (obj.type === 'session_meta') {
    const cwd = obj.payload && typeof obj.payload.cwd === 'string' ? obj.payload.cwd : null;
    if (cwd) estado.cwd = cwd;
    return;
  }
  if (obj.type === 'turn_context') {
    const modelo = obj.payload && typeof obj.payload.model === 'string' ? obj.payload.model : null;
    if (modelo) estado.modelo = modelo;
    return;
  }
  if (obj.type !== 'event_msg' || !obj.payload || obj.payload.type !== 'token_count') return;
  const totalUso = obj.payload.info && obj.payload.info.total_token_usage;
  if (!totalUso || typeof totalUso !== 'object') return;

  const delta = deltaDe(totalUso, alvo.ultimoTotal);
  alvo.ultimoTotal = {};
  for (const campo of CAMPOS_TOTAL) alvo.ultimoTotal[campo] = num(totalUso[campo]);

  const soma = delta.input_tokens + delta.output_tokens + delta.cached_input_tokens + delta.reasoning_output_tokens;
  if (soma === 0) return; // evento duplicado: nada a somar (GC1)

  const hora = horaDe(obj.timestamp);
  const modelo = estado.modelo || alvo.modelo || 'desconhecido';
  if (!alvo.horas[hora]) alvo.horas[hora] = {};
  if (!alvo.horas[hora][modelo]) alvo.horas[hora][modelo] = [0, 0, 0, 0, 0];
  const arr = alvo.horas[hora][modelo];
  arr[0] += delta.input_tokens;
  arr[1] += delta.output_tokens;
  arr[2] += delta.cached_input_tokens;
  arr[3] += delta.reasoning_output_tokens;
  arr[4] += 1;
}

// ─── o cache em disco — mesma forma de `lib/uso.js:365` ────────────────────
//
// `arquivos` é uma LISTA de `{caminho, ino, offset, assinatura, modelo, ultimoTotal, dias,
// ignoradas, projeto}` — NUNCA um objeto indexado por caminho (GC7: um caminho absoluto como
// CHAVE json escaparia da whitelist fechada; como VALOR sob a chave `caminho`, não escapa). O
// envelope `{versao, arquivos}` é o que dá a `VERSAO_CACHE` onde morar — sem ele a constante é
// enfeite: formato mudou, o cache velho seria lido como bom.

let cacheEmMemoria = null;
let emVoo = null;

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

async function gravarCacheNoDisco(cache) {
  try {
    await fsp.mkdir(dirCache(), { recursive: true });
    const tmp = path.join(dirCache(), `cache.${process.pid}.tmp`);
    const arquivos = Object.entries(cache.arquivos).map(([caminho, entrada]) => ({ caminho, ...entrada }));
    await fsp.writeFile(tmp, JSON.stringify({ versao: cache.versao, arquivos }));
    await fsp.rename(tmp, caminhoCache());
  } catch { /* otimização, nunca fonte — a próxima varredura tenta de novo */ }
}

/** sha256 do HEX de `assinaturaDe` (D4.1) — nunca o hex cru, que é reversível. */
function assinaturaHasheada(hex) {
  return crypto.createHash('sha256').update(hex).digest('hex');
}

const PREFIXO_WORKTREE = () => `${process.env.COCKPIT_WORKTREES_DIR || path.join(os.homedir(), '.cockpit', 'worktrees')}${path.sep}`;

/** Lê `${dirJobs()}/<id>/meta.json` para o `cwd` de worktree — mesmo ceticismo de
 * `lib/uso.js:486-495`: não existe, não parseia, sem `project` → `null`, e `projetoDe` cai no
 * caso "(job sem registro)". */
async function metaDoJobPara(cwd) {
  if (!cwd) return null;
  const preWt = PREFIXO_WORKTREE();
  if (!cwd.startsWith(preWt)) return null;
  const id = cwd.slice(preWt.length).split(path.sep)[0];
  try {
    const dados = JSON.parse(await fsp.readFile(path.join(dirJobs(), id, 'meta.json'), 'utf8'));
    if (dados && typeof dados.project === 'string' && dados.project) return dados;
  } catch { /* sem registro */ }
  return null;
}

function temDias(dias) {
  return Boolean(dias && Object.keys(dias).length);
}

/**
 * Popula o cache em memória a partir do disco e devolve o ESTADO que `montar()` consome.
 * Espelho de `lib/uso.js:456` (`varrer`), com a fonte trocada: em vez de `readdir` de
 * `~/.claude/projects`, os candidatos vêm de `varrerRollouts()` (D4, reuso do
 * `lib/adaptador-codex.js`).
 *
 * 🔴 Divergiu `ino` ou assinatura ⇒ a entrada é reconstruída INTEIRA — `ultimoTotal`
 * sobrevivente de um arquivo truncado faria o primeiro delta nascer negativo e o clamp o
 * zeraria calado (GC8b).
 */
async function varrer() {
  if (emVoo) return emVoo;

  emVoo = (async () => {
    const t0 = Date.now();
    if (!cacheEmMemoria) cacheEmMemoria = await carregarCacheDoDisco();
    const cache = cacheEmMemoria;

    const vistos = new Set();
    let arquivosEncontrados = 0;
    let comUsage = 0;
    let relidos = 0;
    let bytesLidos = 0;
    let arquivosComErro = 0;

    const achados = await varrerRollouts();

    for (const { caminho } of achados) {
      arquivosEncontrados += 1;
      vistos.add(caminho);

      let alca = null;
      try {
        alca = await fsp.open(caminho, 'r');
        const info = await alca.stat();
        if (!info.isFile()) { await alca.close().catch(() => {}); alca = null; continue; }

        let entrada = cache.arquivos[caminho];
        let relerDoZero = !entrada;

        if (entrada && !relerDoZero) {
          if (info.size < entrada.offset) {
            relerDoZero = true; // encolheu
          } else {
            const assinaturaAtual = assinaturaHasheada(await assinaturaDe(alca, entrada.offset));
            if (info.ino !== entrada.ino || assinaturaAtual !== entrada.assinatura) {
              relerDoZero = true; // outro arquivo no mesmo caminho
            } else if (info.size === entrada.offset) {
              // nada a fazer — caminho mais barato do laço
              if (temDias(entrada.horas)) comUsage += 1;
              cache.arquivos[caminho] = entrada;
              await alca.close().catch(() => {});
              alca = null;
              continue;
            }
          }
        }

        if (relerDoZero) {
          entrada = {
            offset: 0, ino: info.ino, assinatura: assinaturaHasheada(''),
            ignoradas: {}, horas: {}, ultimoTotal: null, modelo: null, projeto: null,
          };
        }
        const de = relerDoZero ? 0 : entrada.offset;
        const estado = { modelo: entrada.modelo, cwd: null };

        const it = linhasDe(alca, de, info.size);
        let resultado;
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          resultado = await it.next();
          if (resultado.done) break;
          const item = resultado.value;
          if (item && typeof item === 'object' && item.ignorada) {
            entrada.ignoradas[item.hora] = (entrada.ignoradas[item.hora] || 0) + 1;
            continue;
          }
          // Orçamento da varredura (D5): só `JSON.parse` nas linhas candidatas.
          if (!/"token_count"|"session_meta"|"turn_context"/.test(item)) continue;
          let obj;
          try {
            obj = JSON.parse(item);
          } catch {
            // Formato interno (#10): pula, nunca lança — MAS CONTA. `lib/uso.js:578` faz o
            // mesmo `continue` mudo, e é uma lacuna herdada, não um modelo: `linhasIgnoradas`
            // é o campo com que a tela AFIRMA quanto ficou de fora. Linha que some sem entrar
            // nele faz o relatório prometer completude que não tem — e uma linha candidata
            // (ela casou `token_count`) é justamente a que pode levar tokens junto.
            const hora = horaDe((/"timestamp":"([^"]{0,32})/.exec(item) || [])[1]);
            entrada.ignoradas[hora] = (entrada.ignoradas[hora] || 0) + 1;
            continue;
          }
          agregarEvento(obj, entrada, estado);
        }
        const novoOffset = resultado.value;
        if (novoOffset > de) { relidos += 1; bytesLidos += (novoOffset - de); }

        entrada.offset = novoOffset;
        entrada.ino = info.ino;
        entrada.assinatura = assinaturaHasheada(await assinaturaDe(alca, entrada.offset));
        if (estado.modelo) entrada.modelo = estado.modelo;
        if (!entrada.projeto) {
          const meta = await metaDoJobPara(estado.cwd);
          entrada.projeto = projetoDe(estado.cwd, meta);
        }
        cache.arquivos[caminho] = entrada;
        if (temDias(entrada.horas)) comUsage += 1;
      } catch (erro) {
        // Só erro de SYSCALL degrada (mesmo filtro de `lib/uso.js:590-593`) — TypeError de bug
        // de programação sobe, para não virar "projeto sem gasto" calado.
        if (erro && erro.syscall) { arquivosComErro += 1; } else { throw erro; }
      } finally {
        if (alca) await alca.close().catch(() => {});
      }
    }

    // Arquivo sumido sai do cache (poda, como `lib/uso.js:417`).
    for (const caminho of Object.keys(cache.arquivos)) {
      if (!vistos.has(caminho)) delete cache.arquivos[caminho];
    }

    const leitura = { arquivos: arquivosEncontrados, comUsage, relidos, bytesLidos, ms: Date.now() - t0, arquivosComErro };
    await gravarCacheNoDisco(cache).catch(() => {}); // otimização, nunca fonte

    return { arquivos: cache.arquivos, leitura };
  })().finally(() => { emVoo = null; });

  return emVoo;
}

// ─── montagem do relatório ──────────────────────────────────────────────────

function novoTotal() { return [0, 0, 0, 0, 0]; }
function somarNoTotal(alvo, arr) {
  alvo[0] += arr[0]; alvo[1] += arr[1]; alvo[2] += arr[2]; alvo[3] += arr[3]; alvo[4] += arr[4];
}
function totalParaObjeto(arr) {
  return { entrada: arr[0], saida: arr[1], cacheLeitura: arr[2], raciocinio: arr[3], tokens: arr[0] + arr[1] };
}
function estourouSeguranca(arr) {
  return !Number.isSafeInteger(arr[0]) || !Number.isSafeInteger(arr[1])
    || !Number.isSafeInteger(arr[2]) || !Number.isSafeInteger(arr[3]);
}
// Só `entrada + saida` — as MESMAS duas parcelas de `totalParaObjeto().tokens`. O `SOMA` de
// `lib/uso.js:…` soma as QUATRO posições e está certo lá, porque lá elas são disjuntas; aqui
// `cacheLeitura` é subconjunto de `entrada` e `raciocinio` é subconjunto de `saida` (D3), e
// somar os quatro daria um número que não é o exibido em lugar nenhum.
//
// Onde isso morde: `SOMA` é o comparador do ranking. Ordenar por um número e mostrar outro faz
// a lista aparecer fora de ordem para quem lê os valores — dois projetos com proporção de cache
// diferente trocam de lugar. Medido no disco real em 22/09 a ordem coincide, mas por perfis de
// cache parecidos entre os projetos, e coincidência de dado não é garantia de ordenação.
const SOMA = (arr) => arr[0] + arr[1];

function diaDentro(dia, desde, ate) {
  return dia !== 'sem-data' && dia >= desde && dia <= ate;
}

/**
 * Monta o relatório final a partir do ESTADO que `varrer()` devolveu — PURA, sem tocar disco.
 * Exportada (junto de `projetoDe`/`deltaDe`/`agregarEvento`) para o gate poder provar casos
 * limite sem fabricar disco (mesmo espírito de `lib/uso.js:715`). **Sem `custo`, sem `precos`,
 * sem `origens`** (D3/§4.1) — `total.tokens` é calculado AQUI, no servidor.
 *
 * `fuso = fusoValido(fusoPedido)` dentro, como em `lib/uso.js:montar` — mesma regra, mesmo dono
 * único. `agora` repassado a `janelaNoFuso`/`rotuloDoFuso` (relógio só por relatório).
 */
function montar(estado, dias, fusoPedido = 'UTC', agora = Date.now()) {
  const fuso = fusoValido(fusoPedido);
  const { desde, ate } = janelaNoFuso(dias, fuso, agora);
  const porProjeto = new Map();
  const porModeloGeral = new Map();
  const porDiaGeral = new Map();
  const totalGeral = novoTotal();
  let linhasIgnoradas = 0;
  let precisaoPerdida = false;
  // Mesmo memo de `lib/uso.js:montar` — hora → dia local, por CHAMADA.
  const memoDia = new Map();
  const diaLocalDe = (hora) => {
    if (!memoDia.has(hora)) memoDia.set(hora, diaNoFuso(hora, fuso));
    return memoDia.get(hora);
  };

  for (const entrada of Object.values(estado.arquivos || {})) {
    const projeto = entrada.projeto || '(fora de projeto)';

    for (const [hora, n] of Object.entries(entrada.ignoradas || {})) {
      if (diaDentro(diaLocalDe(hora), desde, ate)) linhasIgnoradas += n;
    }

    for (const [hora, porModelo] of Object.entries(entrada.horas || {})) {
      const dia = diaLocalDe(hora);
      if (!diaDentro(dia, desde, ate)) continue;
      for (const [modelo, arr] of Object.entries(porModelo)) {
        if (!porProjeto.has(projeto)) porProjeto.set(projeto, novoTotal());
        somarNoTotal(porProjeto.get(projeto), arr);

        if (!porModeloGeral.has(modelo)) porModeloGeral.set(modelo, novoTotal());
        somarNoTotal(porModeloGeral.get(modelo), arr);

        if (!porDiaGeral.has(dia)) porDiaGeral.set(dia, novoTotal());
        somarNoTotal(porDiaGeral.get(dia), arr);

        somarNoTotal(totalGeral, arr);
      }
    }
  }

  const comparador = (a, b) => (SOMA(b.total) - SOMA(a.total)) || a.nome.localeCompare(b.nome, 'pt-BR');

  const projetos = Array.from(porProjeto.entries())
    .filter(([, arr]) => SOMA(arr) > 0)
    .map(([projeto, arr]) => {
      if (estourouSeguranca(arr)) precisaoPerdida = true;
      return { nome: projeto, projeto, total: arr };
    })
    .sort(comparador)
    .map((p) => ({ projeto: p.projeto, total: totalParaObjeto(p.total) }));

  const porModelo = Array.from(porModeloGeral.entries())
    .map(([modelo, arr]) => ({ nome: modelo, modelo, total: arr }))
    .sort(comparador)
    .map((m) => ({ modelo: m.modelo, total: totalParaObjeto(m.total) }));

  const porDia = Array.from(porDiaGeral.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dia, arr]) => ({ dia, total: totalParaObjeto(arr) }));

  if (estourouSeguranca(totalGeral)) precisaoPerdida = true;

  const leituraBase = estado.leitura || { arquivos: 0, comUsage: 0, relidos: 0, bytesLidos: 0, ms: 0, arquivosComErro: 0 };

  return {
    geradoEm: new Date(agora).toISOString(),
    desde, ate, dias,
    fuso, fusoRotulo: rotuloDoFuso(fuso, agora),
    total: totalParaObjeto(totalGeral),
    porModelo,
    porDia,
    projetos,
    leitura: { ...leituraBase, linhasIgnoradas, precisaoPerdida },
  };
}

async function relatorio({ dias = 1, fuso } = {}) {
  const estado = await varrer();
  return montar(estado, dias, fuso);
}

module.exports = { relatorio, varrer, montar, projetoDe, deltaDe, agregarEvento, VERSAO_CACHE };
