'use strict';
// Faixa PROD FORA (D87; spec 2026-10-16-faixa-prod-fora-design.md): o Cockpit LÊ o estado que um vigia
// de prod externo (script fora deste repo, timer de 1 min, que também avisa por mensagem) grava em JSON.
// Só leitura: sem rede, sem escrita, sem relógio. Uma checagem, duas telas.
//
// `COCKPIT_VIGIA_PROD_ARQ` é DUAS coisas: onde o arquivo mora e o interruptor dos testes. Ela VENCE um
// HOME falso (#62) — por isso `bin/testes.js` a define. Sem ela e sem o arquivo no padrão, o recurso fica
// desligado: arquivo ausente = nada na tela.
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const PARADO_S = 300;            // P5 — 5 min sem check = vigia parado
const FALHAS_QUEDA = 2;          // S1 — o limiar padrão do vigia; é outro processo, a env dele não chega aqui
const TETO_ARQUIVO = 256 * 1024;
const MAX_SITES = 20;
const NOME = /^[A-Za-z0-9][\w.-]{0,39}$/;
const DETALHE = /^[A-Za-z0-9_]{1,40}$/;

// Resolvida a CADA chamada (molde `lib/monitor.js:dirDe`): o gate troca o arquivo entre os casos.
const arqDe = () => process.env.COCKPIT_VIGIA_PROD_ARQ
  || path.join(os.homedir(), '.cockpit', 'vigia-prod', 'estado.json');

/**
 * Um site do arquivo do vigia → `{ nome, situacao, fora, parado, foraHaS, checadoHaS, detalhe }`.
 * Campo inválido é "não sei", nunca "no ar": `falhas` fora do inteiro ≥ 0 força `parado`.
 */
function umSite(nome, s, agoraMs) {
  const checadoMs = Date.parse(s.ultimo_check);
  const checadoValido = Number.isFinite(checadoMs);
  const checadoHaS = checadoValido ? Math.max(0, Math.floor((agoraMs - checadoMs) / 1000)) : null;
  let parado = !checadoValido || checadoHaS > PARADO_S;

  const falhas = s.falhas;
  const falhasValidas = Number.isInteger(falhas) && falhas >= 0;
  let fora = false;
  if (falhasValidas) {
    fora = falhas >= FALHAS_QUEDA || (s.status === 'down' && falhas > 0);
  } else {
    parado = true; // campo inválido = "não sei", nunca "no ar"
  }
  const situacao = fora ? 'fora' : (parado ? 'parado' : 'no-ar');

  let foraHaS = null;
  if (fora && checadoValido) {
    // Mesma conta do vigia: início derivado de quando a 1ª falha aconteceu.
    const derivadoMs = checadoMs - (falhas - 1) * 60000;
    let inicioMs = derivadoMs;
    if (s.status === 'down') {
      const desdeMs = Date.parse(s.desde);
      // Uma volta sem aviso deixa `desde` velho e a queda nova entra sem reescrevê-lo — sem o
      // `max`, essa queda recente apareceria com a duração da queda antiga.
      if (Number.isFinite(desdeMs)) inicioMs = Math.max(desdeMs, derivadoMs);
    }
    foraHaS = Math.max(0, Math.floor((agoraMs - inicioMs) / 1000));
  }

  // Campo ausente/nulo não vira o texto "undefined"/"null" na tela — é tratado como SEM detalhe.
  const bruto = s.ultimo_detalhe;
  const detalhe = (bruto === undefined || bruto === null) ? null
    : (DETALHE.test(String(bruto)) ? String(bruto) : null);

  return { nome, situacao, fora, parado, foraHaS, checadoHaS, detalhe };
}

/** Pura: `{ arquivo, sites }` a partir do TEXTO do arquivo (nunca lê disco). */
function interpretar(texto, agoraMs) {
  if (texto === null) return { arquivo: 'ausente', sites: [] };
  if (typeof texto !== 'string' || texto.length > TETO_ARQUIVO) return { arquivo: 'ilegivel', sites: [] };
  let dado;
  try { dado = JSON.parse(texto); } catch { return { arquivo: 'ilegivel', sites: [] }; }
  if (!dado || typeof dado !== 'object' || Array.isArray(dado)) return { arquivo: 'ilegivel', sites: [] };
  const sites = [];
  for (const [nome, s] of Object.entries(dado)) {
    if (sites.length >= MAX_SITES) break;
    if (!NOME.test(nome)) continue; // nunca ecoado — nome fora do padrão é pulado
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    sites.push(umSite(nome, s, agoraMs));
  }
  return { arquivo: 'ok', sites };
}

// Memória da última leitura BOA (texto que deu `arquivo: 'ok'`) e do último código já logado — o
// log de arquivo estragado não pode encher o journal a cada 15 s de polling (S10h).
let ultimoTextoOk = null;
let ultimoCodigoLogado = null;

function marcarAusente() {
  ultimoTextoOk = null;
  ultimoCodigoLogado = null;
}

/**
 * Ilegível: loga o motivo só na transição e, com leitura boa guardada, reaproveita o retrato
 * antigo em tom de aviso — a queda conhecida não pode sumir só porque o arquivo quebrou depois.
 * Sem leitura boa guardada (servidor recém-subido com o arquivo já estragado) → `sites: []`.
 */
function resultadoIlegivel(motivo, agoraMs) {
  if (ultimoCodigoLogado !== motivo) {
    console.error(`sites: ${motivo}`); // só o código, nunca o caminho nem o conteúdo
    ultimoCodigoLogado = motivo;
  }
  if (ultimoTextoOk === null) return { agora: Math.floor(agoraMs / 1000), arquivo: 'ilegivel', sites: [] };
  const antigo = interpretar(ultimoTextoOk, agoraMs);
  const sites = antigo.sites.map((s) => ({ ...s, parado: true, situacao: s.fora ? 'fora' : 'parado' }));
  return { agora: Math.floor(agoraMs / 1000), arquivo: 'ilegivel', sites };
}

/** O motivo do log quando o CONTEÚDO (já lido) é quem reprova — mesma régua de `interpretar`. */
function motivoDoTextoIlegivel(texto) {
  return texto.length > TETO_ARQUIVO ? 'grande' : 'json';
}

/**
 * Lê o estado do vigia de prod. Nunca lança: arquivo ausente, corrompido, enorme ou com campo de
 * tipo errado vira estado (`ausente`/`ilegivel`/site pulado), nunca exceção — o servidor nunca
 * cai por causa desta leitura.
 */
async function ler() {
  const agoraMs = Date.now();
  try {
    const arq = arqDe();
    let st;
    try {
      st = await fsp.stat(arq);
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        marcarAusente();
        return { agora: Math.floor(agoraMs / 1000), arquivo: 'ausente', sites: [] };
      }
      return resultadoIlegivel((e && e.code) || 'erro', agoraMs);
    }
    if (!st.isFile()) return resultadoIlegivel('nao-arquivo', agoraMs);
    if (st.size > TETO_ARQUIVO) return resultadoIlegivel('grande', agoraMs);

    let texto;
    try {
      texto = await fsp.readFile(arq, 'utf8');
    } catch (e) {
      // Pode perder a corrida com um `rename` entre o `stat` e o `readFile` — mesmo tratamento.
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        marcarAusente();
        return { agora: Math.floor(agoraMs / 1000), arquivo: 'ausente', sites: [] };
      }
      return resultadoIlegivel((e && e.code) || 'erro', agoraMs);
    }

    const lido = interpretar(texto, agoraMs);
    if (lido.arquivo === 'ok') {
      ultimoTextoOk = texto;
      ultimoCodigoLogado = null;
      return { agora: Math.floor(agoraMs / 1000), arquivo: 'ok', sites: lido.sites };
    }
    return resultadoIlegivel(motivoDoTextoIlegivel(texto), agoraMs);
  } catch (e) {
    return resultadoIlegivel((e && (e.code || e.name)) || 'erro', agoraMs);
  }
}

/** Só o gate usa: devolve o módulo ao estado de recém-carregado (molde `lib/monitor.js`). */
function _zerarParaTeste() {
  ultimoTextoOk = null;
  ultimoCodigoLogado = null;
}

module.exports = { interpretar, ler, arqDe, _zerarParaTeste, PARADO_S, FALHAS_QUEDA, TETO_ARQUIVO };
