'use strict';
// `terminouEm` de cada conversa: a hora em que o ÚLTIMO TURNO terminou (D69). É a chave da ordem
// da lista — só o fim de um turno move uma conversa; abrir, enviar e Alt+J/K não movem.
// Spec: docs/superpowers/specs/2026-10-07-fila-so-sobe-quando-o-turno-acaba-design.md (S2 e §5.1).
//
// As três regras (o fim de turno se VÊ ou se CONFIRMA, nunca se infere de uma leitura só):
//   1. VIU PARAR — a aba estava `rodando === true` e agora está parada, COM `statusDesde` (Claude):
//      vale o `statusDesde`, sem nunca recuar. Sem `statusDesde` (Codex) a parada vista cai na regra 2:
//      a ordem das chamadas não é a ordem das capturas, e uma captura velha de "parado" pode trazer a
//      fala do ENVIO (T20). E o `statusDesde` tem de ser NOVO — diferente do último visto com a aba
//      parada —, senão a mesma captura velha reaplicaria o carimbo de uma parada já contada.
//   2. CANDIDATO EM DUAS LEITURAS — parada com fala nova sem ter visto o turno: só vira fim se uma
//      leitura que COMEÇOU depois do FIM da que criou o candidato repetir a mesma fala parada.
//      Isso mata a corrida do envio (o CLI publica `busy` ANTES de gravar a fala do humano).
//   3. CONGELA RODANDO — rodando ou desconhecido (`null`) não muda nada.
// Em memória (S4), podado por TETO (S7), e uma leitura mais velha que a última aplicada é ignorada.

const TETO = 500;
// sessaoId -> { fim, rodando, candidato, candidatoAte, vistoEm, statusParado }
//   candidato: a fala que espera confirmação; candidatoAte: o FIM da leitura que a criou;
//   vistoEm: o INÍCIO da última leitura aplicada a esta entrada (leitura mais velha é ignorada);
//   statusParado: o `statusDesde` da última leitura em que a aba estava PARADA.
const guardado = new Map();
const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);

/** Grava e poda pelo TETO: sai o menor `fim` (null = 0); `id` recém-gravado é imune (S7). */
function gravar(id, estado) {
  guardado.delete(id);
  guardado.set(id, estado);
  if (guardado.size <= TETO) return;
  let menor = null;
  for (const [k, e] of guardado) if (k !== id && (menor === null || (e.fim || 0) < (guardado.get(menor).fim || 0))) menor = k;
  if (menor !== null) guardado.delete(menor);
}

/**
 * Anota `terminouEm` em cada aba (muta) e atualiza o mapa. Nunca lança.
 * `leitura = { inicio, fim }`: instantes do servidor em volta da chamada de `listar()`.
 */
function observar(abas, lidoDe = () => undefined, leitura = { inicio: 0, fim: 0 }) {
  for (const aba of abas) {
    const id = aba.sessaoId;
    if (!id) { aba.terminouEm = null; continue; }
    const antes = guardado.get(id);
    if (antes && leitura.inicio < antes.vistoEm) { aba.terminouEm = antes.fim; continue; }   // leitura velha
    const parado = aba.rodando === false;
    const fala = num(aba.atualizadoEm);
    let fim = antes ? antes.fim : null;
    let candidato = null;
    let candidatoAte = 0;
    if (!antes) {
      fim = parado && fala ? fala : (num(lidoDe(id)) ?? null);
    } else if (parado && antes.rodando === true && num(aba.statusDesde)
      && aba.statusDesde !== antes.statusParado) {                  // viu parar (Claude), parada NOVA
      fim = Math.max(fim || 0, aba.statusDesde);
    } else if (parado && fala && fala > (fim || 0)) {              // fala nova sem ver o turno
      if (antes.candidato === fala && leitura.inicio > antes.candidatoAte) fim = fala;
      else if (antes.candidato === fala) { candidato = fala; candidatoAte = antes.candidatoAte; }  // sobreposta: espera
      else { candidato = fala; candidatoAte = leitura.fim; }
    }
    const statusParado = parado ? num(aba.statusDesde) : (antes ? antes.statusParado : null);
    gravar(id, { fim, rodando: aba.rodando ?? null, candidato, candidatoAte, vistoEm: leitura.inicio, statusParado });
    aba.terminouEm = fim;
  }
  return abas;
}

/** A única porta de entrada: lista + carimbos de lido, e o `observar` por cima. */
function listarComFim({ listar, mapaDeLidas }) {
  let relogio = 0;   // contador do processo: ordem total, sem empate (Date.now() empata no mesmo ms)
  return async () => {
    const inicio = ++relogio;
    const [lista, carimbos] = await Promise.all([listar(), mapaDeLidas()]);
    return observar(lista, (id) => carimbos[id], { inicio, fim: ++relogio });
  };
}

module.exports = { observar, listarComFim, TETO, _zerar: () => guardado.clear() };
