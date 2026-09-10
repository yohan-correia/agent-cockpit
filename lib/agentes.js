'use strict';
// O REGISTRO DOS AGENTES — o único lugar do projeto que sabe que existe mais de um CLI.
//
// Por que ele existe: o Codex entrou, e o Cursor vem depois. Um `if (agente === 'codex')`
// espalhado por quatro arquivos é a armadilha #40 esperando acontecer — a regra se separa
// da legenda e um dos dois envelhece calado. Aqui a regra é uma tabela, e quem quiser saber
// qual leitor usar pergunta em vez de decidir.
//
// O que cada campo é:
//
//   rotulo     o nome que a TELA mostra. Nunca o caminho do binário (#22).
//   bin()      o caminho do executável, resolvido em TEMPO DE CHAMADA — nunca no `require`.
//              Constante de módulo é capturada na primeira carga, e o gate não conseguiria
//              trocar de binário entre um bloco de casos e outro sem mexer no `require.cache`.
//   args       as flags com que a aba criada pelo cockpit sobe. SEPARADO do `bin` de
//              propósito: a validação do `criar()` (regex fechada + isFile + X_OK) roda
//              sobre o `bin` puro, e `/usr/bin/codex --yolo` reprovaria na própria trava que
//              existe para barrar injeção.
//   padraoCmd  o que casa contra o `argv[0]` do processo na árvore de /proc. Contra o
//              `argv[0]`, nunca contra o cmdline inteiro: com o cmdline todo,
//              `bash -c '/usr/bin/codex --foo'` casaria e o `send-keys` iria para um SHELL,
//              que é a armadilha #6 pela porta dos fundos.
//   leitor     quem transforma o arquivo da conversa em fita.
//   medidor    quem lê o contexto ocupado na cauda do mesmo arquivo.
//
// Aprovações e sandbox seguem o padrão do CLI. O bypass só é acrescentado quando
// COCKPIT_CODEX_SEM_APROVACAO=1; veja SECURITY.md antes de habilitar.

const AGENTES = {
  claude: {
    id: 'claude',
    rotulo: 'Claude Code',
    bin: () => process.env.COCKPIT_BIN_CLAUDE || '/usr/bin/claude',
    args: [],
    padraoCmd: /(^|\/)claude(\s|$)/,
    leitor: require('./externo'),
    medidor: require('./contexto'),
  },
  codex: {
    id: 'codex',
    rotulo: 'Codex CLI',
    bin: () => process.env.COCKPIT_BIN_CODEX || '/usr/bin/codex',
    // Decisão explícita de quem instala. O padrão preserva as aprovações do CLI.
    get args() { return process.env.COCKPIT_CODEX_SEM_APROVACAO === '1'
      ? ['--dangerously-bypass-approvals-and-sandbox'] : []; },
    padraoCmd: /(^|\/)codex(\s|$)/,
    leitor: require('./adaptador-codex'),
    medidor: require('./adaptador-codex'),
  },
};

const AGENTE_PADRAO = 'claude';

/**
 * O agente daquele id — NUNCA `null`.
 *
 * Id desconhecido, `undefined` ou `null` caem no `AGENTE_PADRAO`. Isso é fail-safe, não
 * frouxidão: quem chama isto quer um leitor para ler um arquivo, e "não sei qual agente" tem
 * uma resposta certa neste projeto — o Claude, que é o que 100% das abas eram até ontem. O
 * duble de `lib/abas` do `gate-troca-arquivo.js` monta abas sem o campo `agente`, e consertar
 * o teste para o código passar seria o avesso do que se quer.
 */
const de = (id) => AGENTES[id] || AGENTES[AGENTE_PADRAO];

/** Os ids conhecidos. É esta lista, e nenhuma outra, que o campo `Agente` oferece. */
const ids = () => Object.keys(AGENTES);

/**
 * Aquele id existe? — a função de VALIDAÇÃO, separada de `de()` de propósito.
 *
 * Quem lê quer sempre um leitor; quem valida quer saber a verdade. É esta, e só esta, que o
 * `POST /api/abas` usa para recusar com 400 — mesma regra do whitelist de `projeto`.
 */
const existe = (id) => Object.prototype.hasOwnProperty.call(AGENTES, String(id));

module.exports = { de, ids, existe, AGENTE_PADRAO };
