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
//   modelos    lista FECHADA de aliases do CLI que o campo `Modelo` da aba nova oferece.
//              Agente ausente deste campo não tem escolha de modelo (Codex, job) — o campo
//              some da tela e a rota ignora o que vier.
//   executavel `false` para um agente que só se LÊ — nunca cria aba, nunca aparece no
//              seletor de criar. Até o job entrar (2026-09-12) esse campo não existia
//              porque todo agente era os dois: quem EXECUTA (bin/args/padraoCmd) e quem
//              LÊ (leitor/medidor). Um job é só leitura — ver a entrada `job` abaixo — e
//              `existe()` passou a significar "existe E executa" por causa dele.
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
    // Os modelos que o campo `Modelo` da aba nova oferece. O `id` é o ALIAS do CLI e é ele
    // que vai na flag `--model` — por isso só [a-z]. Lista FECHADA: é ela, e nenhuma outra,
    // que a rota valida e a tela mostra.
    modelos: [
      { id: 'opus', rotulo: 'Opus' },
      { id: 'fable', rotulo: 'Fable' },
      { id: 'sonnet', rotulo: 'Sonnet' },
      { id: 'haiku', rotulo: 'Haiku' },
    ],
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
  job: {
    id: 'job',
    rotulo: 'Job do orquestrador',
    // Um job só se LÊ. Sem bin/args/padraoCmd de propósito — ver o campo `executavel` no
    // cabeçalho do arquivo.
    executavel: false,
    leitor: require('./adaptador-job'),
    medidor: require('./adaptador-job'),
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
 * Quem lê quer sempre um leitor; quem valida quer saber "dá para criar uma aba com ele?".
 * É esta, e só esta, que o `POST /api/abas` usa para recusar com 400 — mesma regra do
 * whitelist de `projeto`.
 *
 * Desde a entrada do `job` (2026-09-12), "existe" passou a significar "existe E executa":
 * até então os dois eram a mesma coisa, porque todo agente da tabela executava. Um agente
 * com `executavel: false` está na tabela (tem leitor, aparece em `ids()`) mas não é
 * material para abrir aba — `hasOwnProperty` sozinho deixaria `agentes.de('job').bin()`
 * estourar em `lib/abas.js:criar()`.
 */
const existe = (id) => Object.prototype.hasOwnProperty.call(AGENTES, String(id))
  && AGENTES[String(id)].executavel !== false;

/** Os modelos daquele agente — `[]` para quem não tem lista (Codex, job). */
const modelosDe = (id) => (existe(id) && AGENTES[String(id)].modelos) || [];

/** Aquele modelo existe NA LISTA daquele agente? A função de VALIDAÇÃO do campo. */
const modeloExiste = (id, modelo) => modelosDe(id).some((m) => m.id === String(modelo));

module.exports = { de, ids, existe, modelosDe, modeloExiste, AGENTE_PADRAO };
