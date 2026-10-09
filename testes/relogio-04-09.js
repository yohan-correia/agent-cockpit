'use strict';
// Preload que desloca o relógio do processo para 2026-09-04T12:00Z (e anda normal a partir dali).
//
// Por que existe: os fixtures de `testes/gate-uso.js` têm data CRAVADA em 2026-09-04 e pedem
// `dias: 1`. Sem relógio fixo, todo bloco que procura o projeto na janela vem `undefined` e o
// gate fica vermelho por DATA VENCIDA, não por código. É o relógio do `gate-uso.js` dentro do
// `npm test` (`bin/testes.js`, card `tela-de-uso-no-fuso-do-aparelho`, spec D10): relógio fixo
// é determinístico para sempre — datas relativas mudariam de dia da semana, de horário de
// verão e de mês a cada execução.
//
// Uso:  NODE_OPTIONS="--require ./testes/relogio-04-09.js" node testes/gate-uso.js
// (NODE_OPTIONS, e não `node -r`, para os processos filhos que o gate dispara herdarem.)
const Real = Date;
const delta = Real.UTC(2026, 8, 4, 12, 0, 0) - Real.now();
class Deslocado extends Real {
  constructor(...args) { if (args.length === 0) super(Real.now() + delta); else super(...args); }
  static now() { return Real.now() + delta; }
}
globalThis.Date = Deslocado;
