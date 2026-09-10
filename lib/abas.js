'use strict';
// As conversas que rodam nas SUAS abas do terminal, não nas do cockpit.
//
// O cockpit vive num socket tmux dedicado (`tmux -L cockpit`, lib/sessoes.js) justamente
// para não encostar nas janelas do usuário. Este módulo olha para o outro lado: o socket
// PADRÃO, onde ficam as abas de verdade — Projeto-a, Projeto-d, Projeto-b e companhia.
//
// A diferença que manda no desenho: aquelas abas já têm um `claude` interativo vivo. Abrir
// um segundo `claude --resume` no mesmo id é o que embaralha a memória (provado em 20/08,
// ver lib/externo.js). Então aqui não se cria processo nenhum: escreve-se na aba que já
// existe, com `send-keys`, como se o usuário tivesse digitado. Um dono só do arquivo, sempre.
//
// De ONDE vem o casamento aba <-> conversa: `~/.claude/sessions/<pid>.json`, que o próprio
// CLI escreve e onde está tudo que faltava — `sessionId`, `cwd`, `status` e o campo `tmux`
// no formato "main:@7.%7". A primeira versão disto adivinhava pelo .jsonl mais recente do
// diretório e ERRAVA: duas abas no mesmo projeto (ou uma aba e uma sessão do cockpit)
// disputavam o mesmo arquivo e a tela mostrava a conversa do vizinho. Adivinhação foi
// trocada por leitura.
//
// Bônus do mesmo arquivo: `status` diz "busy" enquanto o turno roda, e "waiting" quando a
// TUI abriu uma pergunta e não anda sem alguém escolher.
//
// A TUI é lida em DOIS lugares — `tela()` e o retorno de `tecla()` —, e nos dois apenas com
// a aba em `waiting`. A D4 aposentou o `capture-pane` porque parsear framebuffer para virar
// bolha é inferno; mas o menu de múltipla escolha vive só na tela, não passa pelo `.jsonl`,
// então ali o arquivo não tem a informação. Fora de `waiting` os dois recusam: a exceção
// está no código, não na confiança.
//
// E responder o menu não parseia nada: `tecla()` aperta seta/Enter/Esc de uma lista FECHADA
// (nunca tecla livre do cliente) e devolve a tela repintada. Seta e Enter funcionam em
// qualquer menu sem o cockpit entender o que está escrito nele.

const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentes = require('./agentes');
const statusCodex = require('./status-codex');
const clearCodex = require('./clear-codex');

const RAIZ_PROJETOS = path.join(os.homedir(), '.claude', 'projects');
const RAIZ_SESSOES_CLI = path.join(os.homedir(), '.claude', 'sessions');

// A configuração do CLI — onde mora o "confio nesta pasta" de cada projeto. Vizinha das duas
// raízes acima pelo mesmo motivo: é estado do CLI que o cockpit LÊ, nunca estado do cockpit.
const CONFIG_DO_CLI = path.join(os.homedir(), '.claude.json');
// Onde ficam os arquivos que sobem do celular. Diretório NEUTRO, fora de qualquer projeto:
// a aba do terminal não tem pasta de sessão (o cockpit não a criou), e jogar anexo dentro do
// repo sujaria o git de quem estivesse trabalhando ali.
const PASTA_ANEXOS = path.join(os.homedir(), '.cockpit', 'anexos');
// Anexo é de passagem, não é arquivo do projeto. Sem isto a pasta cresce para sempre.
const DIAS_DE_ANEXO = 7;
// "main:@7.%7" — sessão tmux, id da janela, id da pane.
// A sessão tmux cujas panes viram abas na tela. O `list-panes -a` abaixo varre o
// socket INTEIRO, e o socket tem mais gente: cada job do orquestrador (`/ataca`) abre uma sessão
// própria rodando numa worktree, e ela caía na lista do usuário como se fosse aba dele —
// visto em 24/08 com dois jobs do Projeto-a. Job do orquestrador não é aba de trabalho.
// Env var, e não nome cravado, porque o dia em que a sessão mudar de nome a lista fica
// VAZIA — e aí o conserto é uma variável, não um deploy.
const SESSAO_DAS_ABAS = process.env.COCKPIT_TMUX_SESSAO || 'main';

// Env var e não nome cravado, pela mesma razão da #41: o conserto tem que ser uma
// variável, não um deploy. Vazio = socket PADRÃO, que é onde as abas do usuário vivem —
// então a unit do systemd não muda. Sem isto não existe "socket de teste": o gate e o
// smoke só teriam a sessão `main` do usuário para exercitar, que é o que o card proíbe.
const SOCKET_DAS_ABAS = process.env.COCKPIT_TMUX_SOCKET || '';
const comSocket = (args) => (SOCKET_DAS_ABAS ? ['-L', SOCKET_DAS_ABAS, ...args] : args);

// Resolvido no lado do NODE: o comando roda no ambiente do servidor tmux (o login shell do
// usuário), não no do node, e PATH diferente faz a janela abrir e fechar sozinha sem uma
// linha de erro. Caminho absoluto tira esse modo de falha mudo.
//
// Lidos em TEMPO DE CHAMADA, não no require: constante de módulo é capturada no primeiro
// `require` e o gate não conseguiria trocar de binário entre um bloco de casos e outro sem
// mexer no `require.cache`.
const binDoClaude = () => process.env.COCKPIT_BIN_CLAUDE || '/usr/bin/claude';
/**
 * A linha que roda dentro da aba nova. O ponto de extensão prometido, agora exercido.
 *
 * A aba criada pelo cockpit fica IDÊNTICA a uma que o usuário abriu à mão (shell → agente →
 * shell), em vez de ser um tipo especial de aba que some sozinha quando ele dá `/exit`.
 *
 * O binário e as flags vêm SEPARADOS do registro, e isso não é estilo: a validação do
 * `criar()` (regex fechada + `isFile` + `X_OK`) roda sobre o `bin` PURO, e
 * `/usr/bin/codex --yolo` reprovaria na própria trava que existe para barrar injeção. É
 * aqui, e só aqui, que os dois viram uma linha.
 *
 * Id desconhecido ESTOURA, e é de propósito: cair no padrão calado faria um `agente:
 * 'cursor'` que escapasse da validação da rota abrir uma aba de Claude sem ninguém saber
 * por quê. Quem valida é `agentes.existe()`, na rota, com 400.
 */
function comandoDaAba(id = agentes.AGENTE_PADRAO) {
  if (!agentes.existe(id)) throw erro(400, `agente desconhecido: ${String(id).slice(0, 20)}`);
  const { bin, args } = agentes.de(id);
  const flags = args.length ? ` ${args.join(' ')}` : '';
  return `${bin()}${flags}; exec \${SHELL:-/bin/bash} -l`;
}
// Quanto tempo a aba nova tem para o CLI subir antes de a lista parar de dizer "abrindo".
// Medido em 27/08: 1562 ms num projeto conhecido. 30 s é folga para disco frio.
// Faixa FECHADA: `|| 30_000` sozinho engolia 0 e aceitava negativo, e carência negativa
// deixaria a máquina de estados num estado que ninguém consegue diagnosticar.
const CARENCIA_MS = () => {
  const n = Number(process.env.COCKPIT_CARENCIA_ABA_MS);
  return Number.isFinite(n) && n >= 50 && n <= 600_000 ? n : 30_000;
};

const CAMPO_TMUX = /^([^:]+):(@\d+)\.(%\d+)$/;
// O tanto de tela da pane que sai daqui quando a aba está `waiting`. A pane tem ~50 linhas;
// o teto existe para um `cat` de arquivo grande na tela não virar resposta de 4 MB no celular.
const LINHAS_TELA = 80;
const TETO_TELA = 8000;

/**
 * tmux no socket PADRÃO — sem `-L`. É o oposto de lib/sessoes.js de propósito.
 *
 * Nunca chame `kill-server` nem `kill-session` daqui: as abas deste socket são as do
 * usuário, não do cockpit. Este módulo só lê e digita.
 */
function tmux(args) {
  return new Promise((resolve) => {
    execFile('tmux', comSocket(args), { timeout: 8000, maxBuffer: 4 << 20 }, (erro, saida) => {
      // Sem servidor tmux rodando, `tmux ls` sai com erro. Isso é "nenhuma aba", não falha.
      resolve(erro ? '' : String(saida || ''));
    });
  });
}

/**
 * Como `tmux()`, mas ESTOURA — e carrega POR QUE estourou.
 *
 * O leniente acima está CERTO para `listar()`: "sem servidor tmux" é *nenhuma aba*, não
 * falha. E está ERRADO para criar/matar, onde `''` não distingue "deu certo e não imprimiu
 * nada" de "a sessão não existe" — `matar()` não saberia se matou, e `criar()` devolveria a
 * chave de uma janela que nunca nasceu.
 */
function tmuxEstrito(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', comSocket(args), { timeout: 8000, maxBuffer: 4 << 20 }, (e, saida, err) => {
      if (!e) return resolve(String(saida || ''));
      const falha = new Error(String(err || e.message).trim() || 'tmux falhou');
      falha.stderrTmux = String(err || '');
      // `killed` é como o execFile marca o estouro do `timeout`. Sem este campo, um tmux
      // pendurado viraria "não há sessão", que é mentira.
      falha.expirou = Boolean(e.killed);
      reject(falha);
    });
  });
}

// A ÚNICA leitura de mensagem de erro deste projeto — e ela é do TMUX, não nossa. A regra
// abaixo (`erro.codigo`) proíbe regex em cima das NOSSAS mensagens; aqui não há
// alternativa: o tmux sai com 1 tanto para "sessão não existe" quanto para qualquer outra
// falha, e só o stderr separa os dois. O que não casar CAI NO GENÉRICO (500), nunca no
// estado do mundo — inclusive timeout, que é barrado antes pelo `expirou`.
//
// Três frases, e as três querem dizer a mesma coisa: "não há tmux/sessão aí". Medido em
// 27/08: socket cujo servidor morreu diz `no server running on /tmp/...`; socket que nunca
// existiu diz `error connecting to /tmp/... (No such file or directory)`. Sem a terceira,
// um tmux inteiramente fora do ar viraria 500 ("bug do cockpit") em vez de 404/409.
const SEM_SESSAO = /can't find session|no server running|session not found|error connecting to/i;
const semSessao = (e) => !e.expirou && SEM_SESSAO.test(e.stderrTmux || e.message || '');

/**
 * Erro TIPADO — o código vem junto, em vez de o servidor adivinhar lendo a mensagem.
 *
 * O módulo hoje só joga `Error` e o servidor decide o código com regex em cima do texto.
 * Para criar/matar isso não serve: cada recusa tem um código próprio (400 pedido
 * malformado, 404 aba que não existe, 409 estado do mundo) e mensagem é para gente ler.
 * Erro que chega sem `codigo` é falha operacional de verdade: a rota devolve 500.
 */
const erro = (codigo, mensagem) => Object.assign(new Error(mensagem), { codigo });

/**
 * A chave da aba — UMA conta, num lugar só. São DOIS formatos, e a diferença entre eles é
 * DESTRUTIVA: é ela, e nada mais, que decide `kill-pane` ou `kill-window` no `matarAgora()`.
 *
 *   `aba-p<pane_id>`  — a aba É uma pane. Fechar mata a PANE.
 *   `aba-<window_id>` — a aba representa a JANELA inteira. Fechar mata a JANELA.
 *
 * Quem ganha qual: uma pane com agente vira uma aba própria (`aba-p<n>`); uma janela sem
 * agente em pane nenhuma vira UMA aba só, como hoje — e essa aba leva o formato de PANE
 * quando a janela tem uma pane só, porque aí a aba É a pane e o tmux já destrói a janela
 * junto ao matar a última pane dela (medido em 31/08). Com duas ou mais panes e nenhum
 * agente, a aba representa mesmo a janela e leva `aba-<window_id>`: `kill-pane` ali mataria
 * uma das três, a janela sobreviveria e a aba VOLTARIA na lista seguinte depois de o usuário
 * ter recebido 200.
 *
 * A janela de uma pane usar o formato de pane não é detalhe: é o que mantém a chave da aba
 * recém-criada IGUAL antes e depois de o agente subir. `criar()` registra `aba-p<n>` no
 * `nascendoEm`, e se o `listar()` do primeiro segundo — quando o CLI ainda não publicou
 * nada — devolvesse `aba-<n>`, a varredura apagaria a entrada pela linha 1 e o "⋯ abrindo"
 * e o "não subiu" nunca apareceriam.
 *
 * O `trim()` NÃO é zelo: `new-window -P -F` devolve "%1\n", e sem ele a chave vira
 * "aba-p1\n" — que não casa o `[\w-]+` da rota (#17), não acha no `nascendoEm` e quebra a
 * URL do DELETE. Sem o helper, `criar()` indexaria por um lado e `listar()` procuraria por
 * outro.
 */
const chaveDaAba = ({ paneId, janelaId }) => (paneId
  ? `aba-p${String(paneId).trim().replace('%', '')}`
  : `aba-${String(janelaId).trim().replace('@', '')}`);

/**
 * A raiz de `/proc`, resolvida em TEMPO DE CHAMADA.
 *
 * Metade do catálogo de casos do agente depende de `/proc/<pid>/stat`, `/cmdline`, `/cwd` e
 * `/task/*\/children` de pids DE MENTIRA, e o gate é declarado offline. Espionar
 * `fsp.readFile` não resolveria o `readlink` do `cwd`, então a costura é uma raiz
 * injetável — o gate monta uma árvore falsa num `mkdtemp` e a remove no `finally`. Fora do
 * gate a variável não existe e o caminho é `/proc`, como sempre.
 *
 * Em tempo de chamada, e não no `require`, pela mesma razão dos binários: constante de
 * módulo é capturada na primeira carga e o gate não trocaria de raiz entre blocos de casos.
 */
const procRaiz = () => process.env.COCKPIT_PROC_RAIZ || '/proc';

/** Os campos do `/proc/<pid>/stat` DEPOIS do nome do executável. Índice 0 = campo 3. */
async function camposDoStat(pid) {
  try {
    const stat = await fsp.readFile(`${procRaiz()}/${pid}/stat`, 'utf8');
    // O nome vem entre parênteses e pode conter espaços — por isso o corte é a partir do
    // ÚLTIMO ')', nunca um split no espaço.
    const corte = stat.lastIndexOf(')');
    if (corte < 0) return null;
    return stat.slice(corte + 2).split(' ');
  } catch {
    return null;
  }
}

/**
 * O processo daquele pid ainda é o MESMO que escreveu o arquivo?
 *
 * Só "existe /proc/<pid>" não basta: pid é reciclado, e o servidor fica meses de pé. O campo
 * 22 do /proc/<pid>/stat é o instante de partida do processo em ticks desde o boot, e o CLI
 * guarda esse mesmo número em `procStart`. Se os dois batem, é ele; se não, o arquivo é
 * lápide de um claude que já morreu e o pid foi parar em outro programa qualquer.
 *
 * O nome do executável no /proc/<pid>/stat vem entre parênteses e pode conter espaços —
 * por isso a leitura corta a partir do ÚLTIMO ')' em vez de dar split no espaço.
 */
async function mesmoProcesso(pid, procStart) {
  if (!pid || !procStart) return false;
  const campos = await camposDoStat(pid);
  if (!campos) return false;
  return campos[19] === String(procStart);   // campo 22 do stat = índice 19 depois do nome
}

/**
 * QUAL agente roda nesta pane — descendo a árvore de processos a partir do `pane_pid`.
 *
 * `pane_current_command` NÃO serve, e isso foi medido: o binário do Codex é distribuído por
 * npm com um wrapper, então a pane do codex diz `node`. Vale para qualquer CLI empacotada
 * assim, hoje e amanhã.
 *
 * O algoritmo, e cada linha dele existe por um motivo:
 *
 *   tpgid   o pgrp que está em PRIMEIRO PLANO naquele tty. `<= 0` ⇒ pane sem processo em
 *           foreground ⇒ nenhum agente.
 *   fila    `[pane_pid, ...filhos]` — o PRÓPRIO `pane_pid` entra, e não é detalhe: um
 *           `exec codex` numa pane SUBSTITUI o shell, e o `pane_pid` É o agente, sem filho
 *           nenhum. Começar nos filhos devolveria "nenhum agente" numa aba que tem um.
 *   pgrp    quem não está no grupo do foreground é PULADO. Sem esta trava, um `codex &`, um
 *           `codex` suspenso com Ctrl-Z ou um filho esquecido na mesma pane seriam
 *           detectados, a aba diria "tem agente", e o `send-keys` iria para o SHELL — que é
 *           exatamente a armadilha #6. É a mesma pergunta que o terminal faz para decidir
 *           quem recebe as teclas, que é literalmente o que o `send-keys` vai fazer.
 *   argv[0] o PRIMEIRO campo NUL-separado do `cmdline`, nunca a linha inteira. Com a linha
 *           toda, `bash -c '/usr/bin/codex --foo'` casaria e liberaria o envio para um
 *           shell. Com `argv[0]`, o vencedor é o binário rust da profundidade 2 — o
 *           `node /usr/bin/codex` da profundidade 1 tem `argv[0] = "node"` e não casa.
 *
 * Busca em LARGURA: entre dois processos que casem vence sempre o mais raso, seja qual for
 * a ordem em que o kernel lista os filhos. Determinismo, não preferência.
 *
 * `procStartMs` sai do `mtime` do diretório `/proc/<pid>`, não de aritmética de ticks: o
 * Node não expõe `sysconf(SC_CLK_TCK)` e presumir 100 seria chute. Medido em 29/08, o
 * `mtime` bate ao segundo com a conta difícil. O `mesmoProcesso()` acima CONTINUA no campo
 * 22 — ele compara ticks com ticks e não precisa de epoch nenhum; aqui a comparação é
 * contra o `timestamp` do rollout, e por isso precisa de milissegundos.
 *
 * Qualquer leitura de `/proc` que falhe devolve `null`, nunca exceção: processo que morre no
 * meio da varredura é o caso comum, não o excepcional.
 *
 * @returns {?{agente: string, pid: number, procStartMs: number}}
 */
async function detectarAgente(panePid) {
  const raiz = Number(panePid);
  if (!Number.isInteger(raiz) || raiz <= 0) return null;

  const daPane = await camposDoStat(raiz);
  if (!daPane) return null;
  const tpgid = Number(daPane[5]);              // campo 8 do stat
  if (!Number.isInteger(tpgid) || tpgid <= 0) return null;

  const registro = agentes.ids().map((id) => [id, agentes.de(id).padraoCmd]);
  const vistos = new Set();
  let fila = [raiz];

  for (let nivel = 0; nivel < 6 && fila.length; nivel += 1) {
    const proxima = [];
    for (const pid of fila) {
      if (vistos.has(pid)) continue;
      vistos.add(pid);

      const campos = await camposDoStat(pid);
      if (!campos) continue;

      // A trava do foreground decide se ESTE pid pode ser o agente — não se a árvore dele é
      // explorada. Os dois são coisas diferentes, e confundi-los quebra o caso normal: o
      // `pane_pid` é o SHELL da pane, que está esperando (`pgrp !== tpgid`) por construção,
      // e o agente é filho dele. Barrar a descida ali devolveria "nenhum agente" em toda aba
      // que não tenha sido aberta com `exec`.
      const noForeground = Number(campos[2]) === tpgid;   // campo 5 do stat = pgrp

      if (noForeground) {
        let argv0 = '';
        try {
          const cru = await fsp.readFile(`${procRaiz()}/${pid}/cmdline`, 'utf8');
          argv0 = cru.split('\0')[0] || '';
        } catch { /* processo morreu no meio da varredura: só não casa */ }

        for (const [id, padrao] of registro) {
          if (!argv0 || !padrao.test(argv0)) continue;
          const info = await fsp.stat(`${procRaiz()}/${pid}`).catch(() => null);
          if (!info) continue;
          return { agente: id, pid, procStartMs: info.mtimeMs };
        }
      }

      try {
        const tarefas = await fsp.readdir(`${procRaiz()}/${pid}/task`);
        for (const tarefa of tarefas) {
          const filhos = await fsp.readFile(`${procRaiz()}/${pid}/task/${tarefa}/children`, 'utf8')
            .catch(() => '');
          for (const bruto of filhos.split(/\s+/)) {
            const filho = Number(bruto);
            if (Number.isInteger(filho) && filho > 0 && !vistos.has(filho)) proxima.push(filho);
          }
        }
      } catch { /* sem /task: o processo já era, ou a árvore falsa não o descreve */ }
    }
    fila = proxima;
  }
  return null;
}

/**
 * As sessões do CLI que estão vivas AGORA, indexadas por "sessãoTmux:@janela.%pane".
 *
 * Fica só o que interessa: `interactive` (o `claude -p` dos jobs do capitão não é aba de
 * ninguém) e com o campo `tmux` preenchido. Quando duas sessões apontam para a mesma
 * PANE — acontece quando um claude morreu sem limpar o arquivo e outro nasceu ali — vence
 * a de `updatedAt` mais recente.
 *
 * A pane entra na chave, e isso não é cosmética. O `CAMPO_TMUX` já captura os três pedaços
 * ("main:@7.%7") e a versão anterior DESCARTAVA o terceiro: com uma aba por janela isso era
 * inofensivo, mas com uma aba por PANE duas panes de CLI na mesma janela receberiam o mesmo
 * `sessaoId`, o mesmo `arquivo` e o mesmo `status` — ler de um CLI e digitar no outro, que é
 * a armadilha #6 pela porta dos fundos. O desempate por `updatedAt` continua: duas sessões
 * podem apontar para a MESMA pane quando o usuário reinicia o `claude` ali.
 */
async function sessoesDoCli() {
  let nomes = [];
  try {
    nomes = (await fsp.readdir(RAIZ_SESSOES_CLI)).filter((n) => n.endsWith('.json'));
  } catch {
    return new Map();
  }

  const porPane = new Map();
  await Promise.all(nomes.map(async (nome) => {
    let dados;
    try {
      dados = JSON.parse(await fsp.readFile(path.join(RAIZ_SESSOES_CLI, nome), 'utf8'));
    } catch {
      return;
    }
    if (dados.kind !== 'interactive' || !dados.sessionId) return;
    const partes = CAMPO_TMUX.exec(String(dados.tmux || ''));
    if (!partes) return;
    if (!await mesmoProcesso(dados.pid, dados.procStart)) return;

    const chave = `${partes[1]}:${partes[2]}.${partes[3]}`;
    const anterior = porPane.get(chave);
    if (anterior && Number(anterior.updatedAt || 0) >= Number(dados.updatedAt || 0)) return;
    porPane.set(chave, {
      pid: dados.pid,
      sessaoId: dados.sessionId,
      cwd: dados.cwd || null,
      // "busy" é o CLI dizendo que tem turno rodando; "idle" e "shell" são as outras duas.
      status: dados.status || null,
      updatedAt: dados.updatedAt || null,
      pane: partes[3],
    });
  }));
  return porPane;
}

/** Onde o CLI guarda a fita desta sessão. O nome da pasta é o cwd com hífens no lugar do resto. */
function arquivoDaSessao(cwd, sessaoId) {
  if (!cwd || !sessaoId) return null;
  return path.join(RAIZ_PROJETOS, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessaoId}.jsonl`);
}

/**
 * As abas do terminal, prontas para a lista.
 *
 * Só as janelas de `SESSAO_DAS_ABAS` — o socket tem outras sessões (jobs do orquestrador) que
 * não são abas de trabalho do usuário.
 *
 * A fonte é `list-panes -a`, não `list-windows -a`, e a regra de quantas abas cada janela
 * vira é a que o usuário decidiu em 29/08:
 *
 *   panes com CLI vivo  →  UMA ABA POR PANE
 *   nenhuma pane com CLI →  UMA aba só, a janela — exatamente como era antes
 *
 * O segundo ramo é requisito, não detalhe: antes disso TODA janela da sessão aparecia, com
 * CLI ou sem, e uma regra "só pane com CLI vira aba" faria janelas do usuário sumirem da lista
 * sem aviso. Já uma pane SEM CLI dentro de uma janela que tem CLI em outra pane não vira
 * aba — senão a lista encheria de `htop` e `tail -f`.
 *
 * Por que por pane e não por janela: ele usa uma janela por projeto, e a janela do Projeto-a
 * já tem dois CLIs — um claude na `%5` e um codex na `%71`. Com uma aba por janela, o
 * segundo fica invisível por construção.
 *
 * Ordenação: `window_index`, e dentro da janela o `pane_id` numérico crescente. Sem ordem
 * estável a lista embaralha entre dois refreshes.
 */
async function listar() {
  const observadoEm = Date.now();
  const saida = await tmux([
    'list-panes', '-a', '-F',
    ['#{window_id}', '#{session_name}', '#{window_index}', '#{window_name}',
      '#{pane_current_path}', '#{pane_id}', '#{pane_pid}'].join('\t'),
  ]);
  // Lista vazia ainda passa pela varredura: ela percorre o `nascendoEm`, não as abas, e é
  // justamente aqui que a linha 1 da máquina (a chave sumiu) tem trabalho a fazer. Sair
  // antes deixaria o Map segurando entrada de aba que já não existe.
  if (!saida.trim()) return varrerNascimento([]);

  const vivas = await sessoesDoCli();

  // Agrupa as panes por janela ANTES de decidir qualquer coisa: a regra dos dois ramos é
  // sobre a janela inteira, não sobre uma linha isolada do `list-panes`.
  const janelas = new Map();
  for (const linha of saida.split('\n')) {
    if (!linha.trim()) continue;
    const [janelaId, sessaoTmux, indice, nome, caminhoPane, paneId, panePid] = linha.split('\t');
    if (sessaoTmux !== SESSAO_DAS_ABAS) continue;
    if (!janelas.has(janelaId)) {
      janelas.set(janelaId, { janelaId, sessaoTmux, indice: Number(indice), nome, panes: [] });
    }
    janelas.get(janelaId).panes.push({
      paneId,
      panePid,
      caminhoPane,
      cli: vivas.get(`${sessaoTmux}:${janelaId}.${paneId}`) || null,
    });
  }

  // QUEM é o agente de cada pane. É este predicado, e não o `sessoesDoCli()`, que decide
  // quais panes viram aba: para o Claude os dois respondem a mesma coisa, e para o Codex só
  // este responde — o Codex não publica pid, tmux nem sessão em lugar nenhum.
  //
  // O Claude CONTINUA saindo de `sessoesDoCli()`, e isso é de propósito: só aquele arquivo
  // traz `status` (`busy`/`waiting`), que `/proc` não tem. A varredura serve para achar o
  // Codex e para saber quantos CLIs há na janela.
  await Promise.all([...janelas.values()].flatMap((j) => j.panes.map(async (pane) => {
    pane.detectado = await detectarAgente(pane.panePid);
    // O `cwd` do PROCESSO, não o da pane: é ele que o casamento do Codex compara com o
    // `session_meta.cwd` do rollout. Fica aqui, e não no adaptador, porque `/proc` é assunto
    // deste módulo — o adaptador só conhece `~/.codex/`.
    if (pane.detectado?.agente === 'codex') {
      pane.cwdDoProcesso = await fsp.readlink(`${procRaiz()}/${pane.detectado.pid}/cwd`).catch(() => null);
    }
  })));

  // O casamento aba↔conversa do Codex. Uma chamada só, com TODAS as panes de Codex de uma
  // vez: a varredura de `~/.codex/sessions/` é por chamada, não por pane, e é justamente a
  // multiplicação dela pelo número de panes a regressão silenciosa mais provável daqui.
  const panesDeCodex = [...janelas.values()].flatMap((j) => j.panes
    .filter((p) => p.detectado?.agente === 'codex')
    .map((p) => ({
      sessaoTmux: j.sessaoTmux,
      janelaId: j.janelaId,
      paneId: p.paneId,
      pid: p.detectado.pid,
      procStartMs: p.detectado.procStartMs,
      cwd: p.cwdDoProcesso || null,
    })));
  const doCodex = panesDeCodex.length
    ? await agentes.de('codex').leitor.sessoesDoCodex(panesDeCodex).catch(() => new Map())
    : new Map();

  const numeroDaPane = (p) => Number(String(p.paneId).replace('%', '')) || 0;
  const ordenadas = [...janelas.values()].sort((a, b) => a.indice - b.indice);

  const abas = [];
  for (const janela of ordenadas) {
    janela.panes.sort((a, b) => numeroDaPane(a) - numeroDaPane(b));
    const comCli = janela.panes.filter((p) => p.detectado);
    // Sem CLI em pane nenhuma, a aba é a JANELA. Ela leva a chave de pane quando a janela
    // tem uma pane só (a aba É a pane, e o tmux destrói a janela ao matar a última dela) e
    // a chave de janela quando há duas ou mais — ali `kill-pane` mataria uma das três e a
    // aba voltaria na lista seguinte depois de o usuário ter recebido 200.
    const escolhidas = comCli.length
      ? comCli
      : [{ ...janela.panes[0], comoJanela: janela.panes.length > 1 }];

    for (const pane of escolhidas) {
      // Pane escolhida pelo ramo (a) — a janela sem agente nenhum — não herda `cli`: se
      // houvesse um arquivo de sessão apontando para ela, ela teria agente e estaria no
      // outro ramo. Sem isto, uma aba com `agente: null` poderia sair com `sessaoId` e
      // `arquivo` de um CLI que a detecção acabou de recusar.
      const agente = pane.detectado?.agente || null;
      // Só o Claude fala por `pane.cli` (armadilha #48-b, incidente de 08/09): um executor
      // interativo do CLAUDE herdou TMUX/TMUX_PANE de uma pane onde o Codex já rodava, e
      // `agente ? (pane.cli || null) : null` deixava o registro Claude vencer no
      // sessaoId/arquivo de uma pane que `detectarAgente` tinha identificado como Codex. O
      // casamento do Codex (mais abaixo) é quem responde por essa pane; o registro do Claude
      // não pode nem ENTRAR na disputa quando o agente detectado é outro.
      const cli = agente === 'claude' ? (pane.cli || null) : null;
      // O Codex não publica `~/.claude/sessions/<pid>.json` — nada equivalente existe. Quem
      // responde por ele é o casamento do adaptador, que achou (ou não achou) o rollout.
      let codex = agente === 'codex'
        ? doCodex.get(`${janela.sessaoTmux}:${janela.janelaId}.${pane.paneId}`) || null
        : null;
      const processoCodex = codex && { pid: codex.pid, inicio: codex.procStart,
        socket: process.env.COCKPIT_TMUX_SOCKET || '', sessao: janela.sessaoTmux,
        pane: pane.paneId, cwd: codex.cwd };
      if (codex && Number.isFinite(codex.pid) && Number.isFinite(codex.procStart)) {
        try { codex = await clearCodex.aplicar(codex, processoCodex, observadoEm); }
        catch { codex = { ...codex, arquivo: null, sessaoId: null, rodando: null, casamento: 'nenhum' }; }
      }
      abas.push({
        chave: chaveDaAba(pane.comoJanela
          ? { janelaId: janela.janelaId }
          : { paneId: pane.paneId }),
        alvo: janela.janelaId,                          // interno: nunca vai para o navegador
        titulo: janela.nome || `${janela.sessaoTmux}:${janela.indice}`,
        sessao: janela.sessaoTmux,
        cwd: cli?.cwd || codex?.cwd || pane.caminhoPane || null,
      // Sem claude vivo, a aba aparece mas não recebe texto: mandar frase para um shell é
      // mandar comando para o shell. Ver a auditoria de 21/08.
        // NOVO: quem roda nesta aba, e se roda alguém. `temClaude` fica como LEGADO — os
        // fixtures do gate e o cliente ainda o leem, e trocá-lo direto reprovaria uma dúzia
        // de casos que não têm nada a ver com esta mudança.
        agente,
        temAgente: Boolean(agente),
        temClaude: agente === 'claude',
        sessaoId: cli?.sessaoId || codex?.sessaoId || null,
        status: cli?.status || null,
        // O Claude publica `busy` no arquivo do CLI; o Codex não publica nada equivalente, e
        // o estado dele sai do par `task_started`/`task_complete` do próprio rollout.
        rodando: cli ? cli.status === 'busy' : (codex ? codex.rodando : null),
      // `waiting` é o CLI dizendo que a TUI abriu uma pergunta (menu de múltipla escolha,
      // permissão) e não sai do lugar sem alguém escolher. Esse estado NÃO passa pelo
      // `.jsonl`: sem este campo a aba fica idêntica a uma aba livre e o cockpit dá a
      // entender que não tem nada acontecendo — foi o que aconteceu em 22/08. O campo vem
      // do CLI; não se infere nada da tela.
        // `waiting` NÃO EXISTE no Codex: não há campo no rollout, não há arquivo por pid, e
        // o par `task_*` só distingue "turno rodando" de "turno parado". Uma aba de Codex com
        // menu aberto na TUI é indistinguível de uma aba parada — o risco está declarado, e a
        // mitigação é o aviso na tela, não uma trava (a D13).
        esperando: agente === 'claude' ? (cli ? cli.status === 'waiting' : null) : false,
      // PRÉ-SESSÃO: o agente está VIVO na pane e o CLI ainda não publicou sessão nenhuma.
      //
      // É o degrau ANTES da #25, e o `waiting` não o cobre: no prompt de confiança de pasta
      // nova ("Do you trust this folder?") o Claude não escreve `~/.claude/sessions/<pid>.json`
      // e o Codex não abre rollout — medido nos dois em 09/09, socket tmux isolado. Sem este
      // campo a aba fica com `temAgente: true`, `esperando` falsy e `arquivo: null`: nenhum
      // aviso no cabeçalho, fita vazia, e o cockpit parece quebrado enquanto há uma pergunta
      // de sim/não esperando resposta que o usuário não tem como dar do celular.
      //
      // A janela é estreita de propósito — ela FECHA na primeira sessão publicada, que é o
      // primeiro turno de qualquer conversa. Não é o espelho geral do terminal que a D4 e a
      // D6 recusaram: uma aba com conversa nunca entra aqui.
      // /clear e /new confirmados também removem o ID, mas deixam o composer pronto.
      // Só o registro de reset validado para este processo autoriza essa exceção.
        preSessao: Boolean(agente) && !(cli?.sessaoId || codex?.sessaoId) && !codex?.reiniciada,
      // Quando alguém FALOU pela última vez nesta conversa — não quando o arquivo foi
      // tocado. Preenchido logo abaixo, por `horaDaUltimaMensagem`.
        atualizadoEm: null,
      // Os dois campos do nascimento saem SEMPRE, e sempre booleanos — a lista, o
      // `motivoDeRecusa` e o servidor leem `Boolean(...)` sem tratar ausência. Quem os
      // preenche de verdade é a varredura logo abaixo. Nunca verdadeiros ao mesmo tempo.
        nascendo: false,
        falhou: false,
        // Para o Claude o caminho se MONTA por convenção (o `cwd` com hífens); para o Codex
        // ele se GUARDA — o rollout vive em `~/.codex/sessions/AAAA/MM/DD/` com carimbo e
        // UUID no nome, e não há convenção derivável. Contrato diferente, mesmo campo.
        arquivo: cli ? arquivoDaSessao(cli.cwd, cli.sessaoId) : (codex?.arquivo || null),   // interno
        // Só a aba de Codex tem este campo. "Não achei candidato" e "achei mais de um e não
        // sei qual" são estados DIFERENTES, e a tela diz frases diferentes para os dois —
        // colapsá-los num `arquivo: null` seria a #40.
        ...(agente === 'codex' ? { casamento: codex?.casamento || 'nenhum',
          reiniciada: Boolean(codex?.reiniciada), processoCodex } : {}),
        // A pane DESTA aba, sempre — é onde `send-keys` digita e de onde `capture-pane` lê.
        // Aba que representa a janela inteira sai com `null` e o envio cai no `|| aba.alvo`,
        // como já caía. Detectar o CLI numa pane e digitar em outra é a #6 em pessoa.
        pane: pane.comoJanela ? null : pane.paneId,     // interno: leitura E escrita miram aqui
      });
    }
  }

  varrerNascimento(abas);

  // Quando alguém falou pela última vez nesta conversa. Sai só o NÚMERO — o caminho
  // continua interno, `paraCliente` o remove.
  await Promise.all(abas.map(async (aba) => {
    if (!aba.arquivo) return;
    aba.atualizadoEm = await horaDaUltimaMensagem(aba.arquivo, aba.agente);
  }));
  return abas;
}

/**
 * A máquina de estados do nascimento — a varredura preguiçosa do `nascendoEm`.
 *
 * Roda no fim do `listar()`, que já bate de 5 em 5 s: nada de relógio novo (D21). E
 * percorre o **Map**, não a lista de abas — aba fechada na mão no terminal some do
 * `listar()` e a entrada dela nunca seria visitada, que era o vazamento que este mecanismo
 * dizia evitar e não evitava.
 *
 * A ordem das seis linhas é de propósito, e a primeira que casar decide:
 *
 *   1. a chave não está mais na lista       → `delete`   (a aba não existe mais)
 *   2. `temAgente === true`                 → `delete`   — temAgente GANHA de tudo, senão
 *                                                          o `nascendo` viraria buraco na #6
 *   3. `!falhou` e dentro da carência       → fica       → `nascendo: true`
 *   4. `!falhou` e estourou                 → `{ em: agora, falhou: true }` — o relógio
 *                                             REINICIA, e é isso que dá a segunda carência
 *   5. `falhou` e dentro da carência        → fica       → `falhou: true`
 *   6. `falhou` e estourou                  → `delete`   → aba comum sem claude (`○`)
 *
 * A linha 4 é o que impede o estouro de virar silêncio: o CLI pode subir e MORRER (login
 * vencido, config quebrada), e aí a API já respondeu 201 e a tela voltaria a dizer só
 * "claude fechado" — verdade, mas sem contar o que aconteceu.
 */
function varrerNascimento(abas) {
  const porChave = new Map(abas.map((a) => [a.chave, a]));
  const agora = Date.now();
  const carencia = CARENCIA_MS();
  for (const [chave, estado] of nascendoEm) {
    const aba = porChave.get(chave);
    if (!aba) { nascendoEm.delete(chave); continue; }                                   // 1
    if (aba.temAgente) { nascendoEm.delete(chave); continue; }                          // 2
    if (!estado.falhou && agora - estado.em < carencia) continue;                       // 3
    if (!estado.falhou) { nascendoEm.set(chave, { em: agora, falhou: true }); continue; } // 4
    if (agora - estado.em < carencia) continue;                                         // 5
    nascendoEm.delete(chave);                                                           // 6
  }
  for (const aba of abas) {
    const estado = nascendoEm.get(aba.chave);
    aba.nascendo = Boolean(estado && !estado.falhou);
    aba.falhou = Boolean(estado && estado.falhou);
  }
  return abas;
}

/**
 * A hora da última MENSAGEM do arquivo, em ms. `null` quando não há arquivo nenhum.
 *
 * Aqui morava um `fsp.stat().mtimeMs`, e ele MENTIA. O mtime anda sozinho: o CLI reescreve
 * o `.jsonl` sem ninguém ter falado nada (linhas `type: "system"`, entre outras). Medido em
 * disco no dia 23/08 — a sessão `2d8aeb84-….jsonl` tinha mtime das 12:35 daquele dia e a
 * última fala de verdade era das 22:45 do dia ANTERIOR: 13,8 horas de diferença. Isso
 * estragava as duas coisas que dependem deste número: a hora da linha da lista mostrava um
 * horário em que ninguém disse nada, e o "te esperando" (public/app.js, `atualizadoEm >
 * ultimaLeitura`) reacendia sozinho numa conversa já lida.
 *
 * "Mensagem" é o que a fita DESENHARIA: fala do humano e fala do assistente. Quem sabe essa
 * regra é `eventosDoObjeto` em lib/externo.js, e é justamente ele que carimba `quando` só
 * nesses dois — `ferramenta` e `resultado_ferramenta` saem sem hora porque são máquina
 * falando com máquina. Então "último evento COM `quando`" já é a resposta, sem um segundo
 * leitor de `.jsonl` neste projeto para discordar do primeiro.
 *
 * Custo: isto roda para TODAS as abas a cada `/api/abas`, de 5 em 5 segundos. `lerConversa`
 * para na PRIMEIRA mensagem (`alvoMensagens: 1`), lendo só um bloco de 64 KB no caso comum
 * — e continua para trás quando a cauda inteira é imagem, que é o caso em que ela caía no
 * `mtime` (armadilha #38). Medido em 24/08, o código velho e o novo lado a lado na mesma
 * máquina no mesmo instante (`listar()`, mediana de 5, 10 abas): **27,0 ms antes, 16,3 ms
 * depois**. Ficou mais BARATO: parar na primeira mensagem lê 64 KB onde o corte por byte
 * lia 256 KB sempre. Só a aba cuja cauda inteira é imagem paga mais — e é justamente a que
 * antes desistia e caía no `mtime`.
 *
 * Sem mensagem reconhecível na cauda (arquivo recém-criado, ou cauda inteira tomada por um
 * tool_result gigante) cai no mtime, como era antes. Devolver `null` aqui apagaria da lista
 * a marca de hora que já funcionava — degrada, não some.
 */
async function horaDaUltimaMensagem(arquivo, agente = 'claude') {
  if (!arquivo) return null;
  try {
    // O DESPACHO, e ele tem que existir de verdade: aceitar o parâmetro e continuar usando
    // o leitor do Claude devolveria lista vazia para um rollout de Codex, a hora cairia no
    // `mtime` e a lista voltaria a mentir — que é exatamente a mentira de 13,8 horas que a
    // mudança de 24/08 consertou. O default `'claude'` mantém quem chama com um argumento só.
    const { leitor } = agentes.de(agente);
    const { eventos } = await leitor.lerConversa(arquivo, 0, { alvoMensagens: 1 });
    for (let i = eventos.length - 1; i >= 0; i -= 1) {
      const ms = Date.parse(eventos[i].quando || '');
      if (Number.isFinite(ms)) return ms;
    }
  } catch { /* arquivo sumiu ou formato que não conhecemos: cai no mtime abaixo */ }
  const info = await fsp.stat(arquivo).catch(() => null);
  return info ? Math.round(info.mtimeMs) : null;
}

/**
 * Nome de projeto reduzido ao que dá para comparar: minúsculas, sem acento, só letra e
 * número separados por hífen. "Cockpit-Agentes", "cockpit agentes" e "Cóckpit Agêntes"
 * viram a mesma coisa.
 */
function normalizarNome(valor) {
  return String(valor || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Quais abas do terminal são do mesmo projeto que aquele job.
 *
 * O casamento é por NOME — o projeto do job contra a pasta do `cwd` da aba —, e o que sai
 * daqui é só a CHAVE (`aba-7`). Worktree, branch e caminho de disco continuam sem ir para
 * o navegador, mesmo hábito da rota de arquivos.
 *
 * Job que não casa com aba nenhuma devolve lista vazia e simplesmente não aparece na
 * faixa: ele vive no painel /jobs, que é de onde ele nunca saiu.
 */
function abasDoProjeto(projeto, lista) {
  const alvo = normalizarNome(projeto);
  if (!alvo) return [];
  return (lista || [])
    .filter((a) => a.cwd && normalizarNome(path.basename(a.cwd)) === alvo)
    .map((a) => a.chave);
}

/** Uma aba pela chave, com os campos internos ainda dentro. */
async function buscar(chave) {
  return (await listar()).find((a) => a.chave === chave) || null;
}

/**
 * Tira do texto o que não é texto.
 *
 * `send-keys -l` manda byte a byte: um ESC no meio da frase vira sequência de controle
 * dentro da TUI. O `\n` fica — o Claude Code trata LF como quebra de linha e só CR como
 * enviar, que é o que deixa mandar mensagem de várias linhas sem submeter na primeira.
 */
function limpar(texto) {
  return String(texto || '')
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A aba pode mostrar a tela da pane? DONO ÚNICO desta regra — as três guardas leem daqui.
 *
 * São dois estados diferentes com a MESMA necessidade: a TUI está pedindo uma resposta que
 * não passa por arquivo nenhum, e sem ver a tela o usuário responde às cegas ou não responde.
 * `esperando` é o menu de múltipla escolha (#25); `preSessao` é o degrau antes dele, o
 * prompt de confiança de pasta nova. Quem os separa é o `motivoDaTela` logo abaixo, porque
 * o TEXTO muda; a permissão é a mesma.
 *
 * Regra dura que continua valendo: aba com conversa nunca entra aqui. É o que impede a rota
 * de virar espelho geral do terminal (D4/D6).
 */
const podeVerTela = (aba) => Boolean(aba) && (Boolean(aba.esperando) || Boolean(aba.preSessao));

/** Qual dos dois estados abriu a tela — o cliente escolhe o texto por este campo. */
const motivoDaTela = (aba) => (aba && aba.esperando ? 'menu' : 'pre-sessao');

/**
 * Por que esta aba não pode receber texto agora. `null` = pode.
 *
 * Separado de `enviar()` para o gate exercitar as duas recusas sem tmux nenhum no ar.
 *
 * A de `esperando` é nova: com um menu aberto na TUI, `send-keys` não escreve mensagem —
 * cada letra vira TECLA do menu, e alguma delas escolhe uma opção, provavelmente a errada.
 * Isto NÃO é a trava de concorrência que o usuário recusou na D13: não impede escrever em
 * conversa nenhuma, impede digitar às cegas num menu. Mesma família da armadilha #6
 * (`send-keys` num shell). O Parar continua de pé — é o Escape que fecha a pergunta.
 */
function motivoDeRecusa(aba) {
  if (!aba) return 'aba não encontrada';
  // Os dois ramos do nascimento vêm ANTES do genérico, e os dois CONTINUAM recusando: a
  // trava da #6 não afrouxa em momento nenhum, só o texto muda. É a diferença entre "esta
  // aba está quebrada" e "espera um segundo", numa aba que o usuário acabou de pedir.
  if (!aba.temAgente && aba.nascendo) {
    return 'o agente ainda está subindo nesta aba; tente de novo em um instante';
  }
  if (!aba.temAgente && aba.falhou) return 'o agente não subiu nesta aba';
  if (!aba.temAgente) return `a aba "${aba.titulo}" não tem agente rodando`;
  if (aba.esperando) return 'o terminal está com uma pergunta aberta; cancele com Esc para escrever';
  // Mesma trava, um degrau antes: no prompt de confiança de pasta nova o agente ainda não
  // tem conversa, e `send-keys` de texto vira TECLA de menu igual — cada letra é um atalho e
  // alguma delas escolhe "No, exit", que MATA o agente. Esta recusa não existia e o buraco
  // era real: até 09/09 uma aba recém-criada em projeto novo aceitava o POST calada.
  if (aba.preSessao) {
    return 'o agente desta aba está pedindo uma confirmação no terminal; responda pelas setas antes de escrever';
  }
  return null;
}

// Um envio é DOIS comandos de tmux com uma pausa no meio (o texto, 150ms, o Enter). Dois
// POSTs concorrentes na mesma aba intercalam esses passos e as duas mensagens viram uma só
// — `send-keys` concatena com o que já está na caixa (armadilha #21). Enquanto o cliente
// travava o Enviar com turno rodando isso não acontecia; mandar da fila abriu a porta.
//
// A guarda é uma fila POR ABA, não um mutex global: abas diferentes não têm caixa em comum
// e serializá-las juntas deixaria o celular esperando o Projeto-a para escrever no Projeto-b.
const filasPorAba = new Map();

// ─── A pendente que o servidor guarda (card `mensagem-na-fila-some-da-fita`) ──────────────
//
// DUAS COISAS DIFERENTES com o nome parecido de "fila": a de cima serializa os `send-keys`
// (ARMADILHA #28), a de baixo é o REGISTRO do que foi digitado e ainda não voltou do disco —
// é o que faz a bolha "na fila" sobreviver à reconexão do EventSource (spec D-a).
//
// O teto é do REGISTRO, não da tela: passados 30 min sem o texto aparecer no `.jsonl`, a
// entrada é podada e NUNCA MAIS reemitida — é a rede de segurança para a mensagem que a pane
// engoliu (D-c). A poda é PREGUIÇOSA: só roda quando `registrarPendente` ou `pendentesDe`
// passam por ali, nunca por relógio novo (D21).
const MS_PENDENTE_TETO = 30 * 60 * 1000;
const pendentesPorAba = new Map();   // chave -> [{ id, texto, mensagem, em }]

/** Um `id` de envio tem essa forma, e só essa — dado do cliente, nunca confiado sem crivo (D-n). */
function idValido(id) {
  return /^[\w-]{1,64}$/.test(String(id));
}

/** Remove da lista de `chave` as entradas que já passaram do teto de 30 min. */
function podarVencidas(chave, agora) {
  const lista = pendentesPorAba.get(chave);
  if (!lista) return;
  const vivas = lista.filter((p) => agora - p.em <= MS_PENDENTE_TETO);
  if (vivas.length) pendentesPorAba.set(chave, vivas);
  else pendentesPorAba.delete(chave);
}

/**
 * Registra que `chave` acabou de receber `texto` por `send-keys` e ainda não apareceu no
 * disco. Devolve a FICHA (a própria entrada empilhada) — é ela que `esquecerPendente` remove
 * por identidade, e que `pendenteViva` confere antes do aviso ao vivo (D-m).
 *
 * `em` é parâmetro com padrão, não `Date.now()` cravado: é o mesmo motivo do `em` de
 * `marcarPendente` no cliente (`public/app.js:1013`) — deixar o gate fabricar uma entrada de
 * 31 minutos sem esperar 31 minutos.
 *
 * O `id` de fallback (campo ausente) nasce no MESMO formato do cliente
 * (`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`) — este é o ÚNICO
 * gerador; `server.js` não gera id nenhum (D-n).
 */
function registrarPendente(chave, { id, texto, mensagem }, em = Date.now()) {
  podarVencidas(chave, em);
  const ficha = {
    id: id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    texto,
    mensagem,
    em,
  };
  const lista = pendentesPorAba.get(chave) || [];
  lista.push(ficha);
  pendentesPorAba.set(chave, lista);
  return ficha;
}

/** As pendentes vivas de `chave`, depois de podar as vencidas pelo teto. */
function pendentesDe(chave, agora = Date.now()) {
  podarVencidas(chave, agora);
  return pendentesPorAba.get(chave) || [];
}

/**
 * O texto que voltou do disco (`textoDoDisco`, no `timestamp` `quando`) casa com alguma
 * pendente de `chave`? Casando, remove UMA (a primeira) e a devolve; sem par, `null`.
 *
 * O casamento é por TEXTO, `===` ou `endsWith` — a MESMA regra de `absorverPendente`
 * (`public/app.js:1045`), de propósito: `send-keys` concatena com o rascunho da caixa
 * (armadilha #21), e o servidor ainda prefixa o cabeçalho `[anexo] …`. Nos dois casos o que
 * volta do disco TERMINA com o que mandamos; só `===` falharia exatamente aí.
 *
 * E o evento tem que ser MAIS NOVO que a pendente (`quando >= em`), sem folga nenhuma: `em`
 * é carimbado ANTES do primeiro `send-keys`, o `timestamp` do `.jsonl` é escrito pelo CLI
 * DEPOIS de ler o prompt — a desigualdade é estrita por construção (D-b). `quando` ausente
 * ou impossível de parsear vira `NaN`, que reprova toda comparação — a direção segura:
 * histórico velho não pode roubar uma pendente nova.
 */
function consumirPendente(chave, textoDoDisco, quando) {
  const lista = pendentesPorAba.get(chave);
  if (!lista || !lista.length) return null;
  const alvo = String(textoDoDisco || '').trim();
  if (!alvo) return null;
  const t = Date.parse(quando);
  for (let i = 0; i < lista.length; i += 1) {
    const p = lista[i];
    if (!(t >= p.em)) continue;
    if (alvo === p.texto || alvo.endsWith(p.texto)) {
      lista.splice(i, 1);
      if (!lista.length) pendentesPorAba.delete(chave);
      return p;
    }
  }
  return null;
}

/** A `ficha` ainda está registrada para `chave`? Comparação por IDENTIDADE (`===`), nunca
 * recasando por texto — é o que `server.js` confere antes do aviso ao vivo (D-m): entre o
 * `await abas.enviar(...)` e o `emit`, o relógio de 700ms pode já ter consumido a ficha. */
function pendenteViva(chave, ficha) {
  const lista = pendentesPorAba.get(chave);
  return Boolean(lista && lista.includes(ficha));
}

/** Desfaz UM registro — o rollback do envio que falhou no meio (D-b). Remove por
 * IDENTIDADE, nunca por `(texto, em)`: recalcular `Date.now()` no rollback não acharia nada,
 * e casar só por texto apagaria a ocorrência errada quando há duas iguais na fila. */
function esquecerPendente(chave, ficha) {
  const lista = pendentesPorAba.get(chave);
  if (!lista) return;
  const sem = lista.filter((p) => p !== ficha);
  if (sem.length) pendentesPorAba.set(chave, sem);
  else pendentesPorAba.delete(chave);
}

/** A aba morreu — esquece tudo que ela tinha na fila (R5). */
function esquecerPendentes(chave) {
  pendentesPorAba.delete(chave);
}

/**
 * As abas que ACABARAM de nascer, e em que fase do nascimento cada uma está.
 *
 * `chave → { em, falhou }`. `em` é o instante em que a fase ATUAL começou (não o do
 * `criar()`), `falhou` é booleano. Memória, não disco: reinício do servidor perde a
 * carência e a aba volta a dizer "claude fechado" — degrada para a verdade de hoje, não
 * para mentira.
 *
 * Existe porque a janela D16 dura ~1,6 s (medido em 27/08) e nesse intervalo QUATRO
 * lugares diriam que a aba recém-pedida está quebrada. E não pode virar `temClaude: true`:
 * isso liberaria `send-keys` para um shell, que é a #6 pela porta dos fundos.
 */
const nascendoEm = new Map();

// Fila ÚNICA, e não por aba como a de `send-keys`: o que se protege aqui é a CONTAGEM de
// janelas da sessão, que é grandeza GLOBAL. Duas mortes em abas diferentes são justamente
// o caso perigoso — dois DELETE leem "2 janelas", os dois passam pela guarda, cada um mata
// uma e a sessão morre (R11) —, então serializá-las juntas é o ponto, não efeito colateral.
let filaDestrutiva = Promise.resolve();

/**
 * Encadeia `tarefa` atrás do que já estiver na fila DESTA aba e devolve a promessa dela.
 *
 * O `then(tarefa, tarefa)` é o que impede um envio que falhou de envenenar o próximo: a
 * fila anda igual nos dois lados, e cada chamador recebe o seu próprio resultado ou erro.
 */
function enfileirarPorAba(chave, tarefa) {
  const anterior = filasPorAba.get(chave) || Promise.resolve();
  const proxima = anterior.then(tarefa, tarefa);
  filasPorAba.set(chave, proxima);
  // Sem esta limpeza o mapa guarda uma promessa por aba que já foi fechada no terminal.
  const soltar = () => { if (filasPorAba.get(chave) === proxima) filasPorAba.delete(chave); };
  proxima.then(soltar, soltar);
  return proxima;
}

/**
 * Digita na aba e aperta Enter.
 *
 * Não existe trava de "já tem turno rodando": decisão do projeto em 21/08, ciente de que
 * texto enviado no meio de um turno entra na fila do CLI. Desde 22/08 o cliente também
 * deixa escrever com o turno rodando — é a mensagem na fila que ele já tinha no terminal.
 * A única recusa aqui continua sendo a aba sem `claude` (o destinatário seria o bash) e a
 * aba com pergunta aberta (o texto viraria tecla de menu).
 *
 * O que existe é ORDEM: os envios da mesma aba passam um de cada vez por `enfileirarPorAba`,
 * senão os `send-keys` de duas mensagens se intercalam e o agente recebe as duas grudadas.
 */
function enviar(chave, texto, anexos = [], id = null) {
  return enfileirarPorAba(chave, () => digitarNaAba(chave, texto, anexos, id));
}

async function digitarNaAba(chave, texto, anexos = [], id = null) {
  const limpo = limpar(texto).trim();
  if (!limpo) throw new Error('texto vazio');
  const aba = await buscar(chave);
  const recusa = motivoDeRecusa(aba);
  if (recusa) throw new Error(recusa);

  // O caminho do anexo vem do CLIENTE, então não pode ser caminho livre: sem esta trava, um
  // pedido forjado apontaria o agente para ~/.secrets/ e pediria que ele "lesse o anexo".
  const raiz = path.resolve(PASTA_ANEXOS);
  for (const caminho of anexos) {
    const resolvido = path.resolve(String(caminho));
    if (path.dirname(resolvido) !== raiz) throw new Error('anexo fora da pasta de anexos');
    if (!fsSync.existsSync(resolvido)) throw new Error(`anexo não existe: ${path.basename(resolvido)}`);
  }

  const cabecalho = anexos.length
    ? `${anexos.map((a) => `[anexo] ${a}`).join('\n')}\n\n`
      + 'Os arquivos acima foram enviados pelo usuário junto desta mensagem. Abra o que precisar.\n\n'
    : '';
  const mensagem = cabecalho + limpo;

  // Comandos nativos não produzem eco humano no rollout. Esperar esse eco deixava
  // /clear e /diff presos em "na fila". Skills ($nome) continuam no caminho normal.
  if (aba.agente === 'codex' && /^\/(clear|new|compact|diff|status)$/.test(limpo)) {
    if (anexos.length) throw new Error(`${limpo} não aceita anexo. Envie o comando sem anexo.`);
    if (limpo === '/status') throw new Error('use a consulta de /status do Cockpit');
    if (limpo === '/clear' || limpo === '/new') {
      await reiniciarCodex(chave, aba, limpo, id);
    } else {
      await tmuxDoStatus(['send-keys', '-t', aba.pane, '-l', '--', limpo], Date.now() + 2000);
      await espera(150);
      await tmuxDoStatus(['send-keys', '-t', aba.pane, 'Enter'], Date.now() + 2000);
    }
    return { enviado: true, chave, titulo: aba.titulo, comando: limpo, id };
  }

  // O REGISTRO nasce ENTRE a validação e o primeiro `send-keys` — nunca depois do Enter.
  // Registrar depois abriria uma corrida: entre o Enter e a linha seguinte o CLI pode ler o
  // prompt e gravá-lo no `.jsonl`, o relógio de 700ms emitiria o `humano` sem ter o que
  // consumir, e o registro nasceria FANTASMA — vivo por 30 min e reemitido como bolha de uma
  // mensagem que já está na tela (D-a).
  const ficha = registrarPendente(chave, { id, texto: limpo, mensagem });
  try {
    // A PANE, não a janela: `send-keys -t @<janela>` entrega na pane ATIVA dela. Janela
    // splitada com outra coisa em foco engole a mensagem — em 28/08 a aba do Projeto-a tinha
    // um `codex --yolo` na segunda pane e foi ELE quem recebeu tudo que o usuário mandou.
    // `--` antes do texto: sem ele, uma mensagem começando com "-" vira flag do tmux.
    // No Codex, terminar em $skill deixa o autocomplete aberto: Enter só seleciona.
    // O espaço fecha o token antes do único Enter. Não muda o texto lógico da ficha.
    const textoTerminal = aba.agente === 'codex' && /(?:^|\s)\$[\w:.-]+$/.test(mensagem)
      ? mensagem + ' ' : mensagem;
    // Sem bracketed paste o Codex infere colagens por tempo e divide textos longos
    // em blocos; o Enter pode entrar nesses blocos, deixando o envio no composer.
    // Delimitar a colagem entrega o texto inteiro antes do único Enter. `limpar`
    // já remove ESC do conteúdo; os delimitadores pertencem só ao transporte.
    const colagem = aba.agente === 'codex' ? `\x1b[200~${textoTerminal}\x1b[201~` : textoTerminal;
    await tmux(['send-keys', '-t', aba.pane || aba.alvo, '-l', '--', colagem]);
    // O Enter separado, e depois de uma pausa: o mesmo byte colado junto do texto às vezes
    // chega antes de a TUI ter terminado de absorver a colagem, e a mensagem sai partida.
    await espera(150);
    await tmux(['send-keys', '-t', aba.pane || aba.alvo, 'Enter']);
  } catch (falha) {
    // O que este catch COBRE: uma exceção de verdade nascendo DENTRO do bloco acima — por
    // exemplo, `execFile` recusando a chamada antes mesmo de tentar rodar `tmux` (ARGV que
    // não é array, opções malformadas). Nesse caso o registro seria pura mentira (1º
    // `send-keys`) ou o texto ficaria só na CAIXA da TUI, sem Enter (o `Enter`) — o CLI não
    // recebeu a mensagem, ela não está em fila nenhuma (é rascunho do usuário, #21, não
    // nosso). Uma bolha "na fila" ali afirmaria que o agente vai responder algo que nunca viu.
    //
    // O que este catch NÃO COBRE, por desenho, não por descuido: `tmux()` (`:114-121`) é
    // LENIENTE — resolve `''` no erro, nunca rejeita (é o que sustenta a ARMADILHA #3,
    // "sessão tmux morrer é normal, não é falha"). Um `send-keys` que o tmux recusa (pane
    // fechada, socket sumido) hoje NUNCA lança para cá — `enviar()` resolve como se tivesse
    // dado certo, e o registro fica de pé mesmo sem a mensagem ter chegado à pane. Trocar
    // `tmux()` por uma variante que rejeita mudaria esse comportamento para TODO envio desta
    // função, não só os enfileirados — decisão do projeto (2026-09-05): não fazer isso aqui.
    esquecerPendente(chave, ficha);
    throw falha;
  }
  return { enviado: true, chave, titulo: aba.titulo, ficha };
}

/**
 * Abre uma aba nova na sessão do usuário — a primeira operação deste módulo que CRIA algo.
 *
 * `cwd` já vem resolvido pelo servidor a partir do whitelist de projetos: o navegador manda
 * o NOME, nunca o caminho. É a #22 outra vez, e ela não precisa ser reaprendida aqui.
 *
 * Nada vindo do cliente entra no shell-command do `new-window`, NUNCA. O único valor
 * interpolado é o `binDoClaude()`, que é configuração do servidor e passa pela validação
 * fechada do passo 2. O nome do projeto vai só no `-n`, que é argv separado do `execFile`.
 *
 * Criar NÃO é serializado, de propósito: dois POST simultâneos criam duas janelas, que é o
 * resultado honesto de dois pedidos, e nada é destruído. A fila existe onde há dano.
 */
/**
 * Marca a pasta como confiável no CLI, para a aba não nascer travada no "Quick safety check".
 *
 * Por que isto existe: enquanto o diálogo de confiança está aberto o CLI ainda NÃO publicou
 * `~/.claude/sessions/<pid>.json`. Sem esse arquivo `listar()` sai com `cli: null`, o
 * `esperando` fica `null` — e tanto `tela()` quanto `tecla()` recusam. A aba aparece na
 * lista, com o processo vivo, e não há como ler a pergunta nem responder: fica muda até
 * alguém ir ao terminal. Foi exatamente o que aconteceu em 04/09.
 *
 * TRÊS travas, e nenhuma é enfeite:
 *
 *  1. `~/.claude.json` é formato INTERNO do CLI (#10). Se `hasTrustDialogAccepted` não
 *     aparecer em projeto NENHUM, o formato mudou: não se escreve nada e a criação segue
 *     como antes. Gravar uma chave que o CLI não lê mais é pior que não gravar — parece
 *     resolvido e não está.
 *  2. Já confiado sai sem tocar no disco. Idempotência aqui não é elegância: cada escrita é
 *     uma chance de perder a corrida com o CLI, que reescreve este arquivo a cada sessão.
 *  3. A escrita é ATÔMICA — temporário ao lado do alvo e `rename`, com o modo do original
 *     (0600) preservado. O CLI grava aqui o tempo todo (`lastCost`, `lastSessionId`,
 *     `lastSessionMetrics`): duas escritas simultâneas podem fazer uma se perder, e isso é
 *     tolerável — o trust não pega e o diálogo volta. Um arquivo pela metade NÃO é
 *     tolerável: é a configuração de todos os projetos do usuário. `rename` no mesmo
 *     filesystem troca o arquivo inteiro de uma vez, ou não troca nada.
 *
 * Devolve `true` só quando confiou AGORA. Já confiava, formato estranho, leitura ou escrita
 * que falhou: `false`, e a criação da aba segue — degradar, não quebrar.
 */
async function confiarNaPasta(destino) {
  let bruto;
  try {
    bruto = await fsp.readFile(CONFIG_DO_CLI, 'utf8');
  } catch {
    return false;                                    // sem arquivo ou ilegível: não é nosso
  }

  let config;
  try {
    config = JSON.parse(bruto);
  } catch {
    return false;                                    // meio de uma escrita do CLI: sair fora
  }

  const projetos = config && typeof config.projects === 'object' && config.projects
    ? config.projects : null;
  if (!projetos) return false;

  // Trava 1: a chave precisa existir em ALGUM projeto para provar que o formato é este.
  const formatoConhecido = Object.values(projetos)
    .some((p) => p && typeof p === 'object' && 'hasTrustDialogAccepted' in p);
  if (!formatoConhecido) return false;

  // Trava 2: já confiado não se reescreve.
  if (projetos[destino] && projetos[destino].hasTrustDialogAccepted === true) return false;

  projetos[destino] = { ...(projetos[destino] || {}), hasTrustDialogAccepted: true };

  // Trava 3: temporário no MESMO diretório (senão o `rename` cruza filesystem e falha) e
  // com o modo do original — o arquivo é 0600 e um 0644 aqui vazaria a configuração.
  const temporario = `${CONFIG_DO_CLI}.cockpit-${process.pid}`;
  try {
    const modo = (await fsp.stat(CONFIG_DO_CLI)).mode & 0o777;
    await fsp.writeFile(temporario, JSON.stringify(config, null, 2), { mode: modo });
    await fsp.rename(temporario, CONFIG_DO_CLI);
    return true;
  } catch {
    await fsp.unlink(temporario).catch(() => {});
    return false;
  }
}

async function criar({ cwd, nome, agente = agentes.AGENTE_PADRAO }) {
  // 1. A 2ª trava do caminho (a 1ª é o whitelist da rota). Sem ela, um `cwd` que não é
  //    diretório faria o tmux abrir a janela e ela morrer sozinha, sem uma linha de erro.
  const destino = String(cwd || '');
  if (!destino || !fsSync.statSync(destino, { throwIfNoEntry: false })?.isDirectory()) {
    throw erro(409, 'o caminho do projeto não é um diretório');
  }

  // 1b. O agente. Whitelist é o REGISTRO, não uma lista solta aqui — a rota já recusa com
  //     400, e esta é a segunda trava, para quem chamar o módulo direto.
  if (!agentes.existe(agente)) throw erro(400, `agente desconhecido: ${String(agente).slice(0, 20)}`);

  // 2. O binário (R5). Regex FECHADA — absoluto, e só letra, número, ponto, sublinhado,
  //    hífen e barra; qualquer outro byte (espaço, `;`, `$`, crase, aspas) recusa. Mais
  //    `isFile()` E `X_OK`: `/usr/bin` é executável e passaria só no `accessSync`, o POST
  //    responderia 201 e a aba nasceria direto em `falhou` — quando o contrato manda 409
  //    ANTES de criar janela nenhuma. Symlink NÃO é resolvido: `/usr/bin/claude` é um, e
  //    resolvê-lo trocaria um caminho estável por um que muda a cada atualização do pacote.
  //
  //    A validação roda sobre o `bin` PURO do registro, sem as flags: com elas dentro, o
  //    `/usr/bin/codex --yolo` reprovaria no espaço — na própria trava que existe para
  //    barrar injeção.
  const bin = agentes.de(agente).bin();
  const rotulo = agentes.de(agente).rotulo;
  if (!/^\/[A-Za-z0-9._/-]+$/.test(bin)) {
    throw erro(409, `o caminho do ${rotulo} não é aceito: ${bin}`);
  }
  const info = fsSync.statSync(bin, { throwIfNoEntry: false });
  if (!info || !info.isFile()) throw erro(409, `o ${rotulo} não está em ${bin}`);
  try {
    fsSync.accessSync(bin, fsSync.constants.X_OK);
  } catch {
    throw erro(409, `o ${rotulo} em ${bin} não é executável`);
  }

  // 3. Sessão inexistente é detectada ANTES, por sonda própria — não por `catch` em cima do
  //    `new-window`. Um `catch` genérico ali classificaria timeout, permissão e qualquer
  //    tropeço do tmux como "não há sessão", que é mentira. NUNCA se cria sessão no socket
  //    do usuário: o que falta aqui é o terminal dele, e quem o abre é ele.
  try {
    await tmuxEstrito(['has-session', '-t', `${SESSAO_DAS_ABAS}:`]);
  } catch (e) {
    if (!semSessao(e)) throw e;          // timeout/permissão → 500, não estado do mundo
    throw erro(409, `não há sessão "${SESSAO_DAS_ABAS}" no terminal`);
  }

  // 4. `-d` NÃO é enfeite: sem ele, criar a aba do celular troca a janela ativa do terminal
  //    em que o usuário está trabalhando naquele instante (R6). E `-P -F '#{pane_id}'`
  //    devolve o id na hora — a chave sai sem um segundo `list-panes`, logo sem corrida
  //    com outra aba nascendo. Falha daqui para baixo é falha operacional: 500.
  //
  //    É a PANE, não a janela: a chave da aba é por pane desde 31/08, e devolver
  //    `#{window_id}` aqui indexaria `aba-7` enquanto o `listar()` produz `aba-p71` — a aba
  //    nova ficaria presa em `nascendo`, viraria `falhou`, e o 201 devolveria uma chave que
  //    a tela nunca acha.
  // 3b. Confiar na pasta ANTES da janela nascer. Depois já é tarde: o diálogo abre no
  //     primeiro instante do CLI, e uma aba parada nele é uma aba muda (ver `confiarNaPasta`).
  const confiou = await confiarNaPasta(destino);

  const id = await tmuxEstrito([
    'new-window', '-d', '-t', `${SESSAO_DAS_ABAS}:`, '-n', String(nome), '-c', destino,
    '-P', '-F', '#{pane_id}', comandoDaAba(agente),
  ]);

  const chave = chaveDaAba({ paneId: id });
  nascendoEm.set(chave, { em: Date.now(), falhou: false });
  // `confiou` é BOOLEANO de propósito: o caminho de disco não vai para o navegador (#22),
  // e quem chamou já sabe qual projeto escolheu.
  return { chave, titulo: String(nome), confiou };
}

/**
 * Fecha uma aba do terminal — a primeira operação do cockpit que DESTRÓI trabalho.
 *
 * DUAS filas, e a de FORA é a da ABA. A ordem importa e já foi errada uma vez: com
 * `filaDestrutiva.then(() => enfileirarPorAba(...))`, o registro na fila da aba acontece
 * uma microtask depois, e um `enviar()` chamado logo na sequência se registrava ANTES do
 * matar — a ordem deixava de ser a ordem das chamadas.
 *
 * Registrando na fila da aba de forma SÍNCRONA, quem chamou primeiro roda primeiro, sempre:
 *   - `enviar()` e depois `matar()` → os dois `send-keys` terminam e SÓ ENTÃO a janela morre
 *     (senão o segundo vai para uma janela morta, o tmux leniente devolve '' e o cliente vê
 *     `{ enviado: true }` para uma mensagem que não existe em lugar nenhum — R13);
 *   - `matar()` e depois `enviar()` → a janela morre e o `enviar` recusa no `buscar()`.
 *
 * Dentro dela entra a fila DESTRUTIVA, que é global porque a contagem de janelas da sessão
 * é global. Sem ciclo de espera: `matarAgora` não volta a pegar a fila da aba, e
 * `enviar`/`tecla` nunca pegam a destrutiva.
 */
function matar(chave) {
  return enfileirarPorAba(chave, () => {
    const proxima = filaDestrutiva.then(() => matarAgora(chave), () => matarAgora(chave));
    filaDestrutiva = proxima.catch(() => {});
    return proxima;
  });
}

async function matarAgora(chave) {
  // O ALVO sai da CHAVE, não do `listar()`: aquele usa o tmux LENIENTE, e um timeout dele
  // devolveria lista vazia — o DELETE responderia 404 "aba não encontrada" para uma aba que
  // existe (R15). Quem manda aqui é o `list-panes` ESTRITO logo abaixo, que estoura em
  // vez de mentir.
  //
  // 🔴 QUEM DECIDE `kill-pane` OU `kill-window` É O FORMATO DA CHAVE, e nada mais.
  //
  // A versão anterior desta decisão perguntava a `/proc` se a pane alvo tinha agente e, se
  // não tivesse, concluía "então esta aba é uma janela" e disparava `kill-window`. Isso MATA
  // O VIZINHO: `aba-p71` (o codex) mora na janela `@5` junto do claude da `%5`; basta o
  // codex morrer, ser suspenso com Ctrl-Z ou sair do foreground entre o `listar()` que
  // pintou a linha e o DELETE que chega segundos depois, e o claude do Projeto-a vai junto.
  // É a ARMADILHA #42 ao contrário: o alvo de tmux é sempre o objeto que você mediu, nunca
  // o pai dele. Decidido pelo usuário em 31/08, depois de medido.
  //
  // Não há ramo condicional "é a única pane da janela ⇒ kill-window": medido em socket de
  // prova em 31/08, o `kill-pane` na ÚLTIMA pane de uma janela já destrói a janela junto,
  // nativamente. Um comando a menos e um estado a menos para errar.
  const texto = String(chave);
  const ehPane = /^aba-p\d+$/.test(texto);
  const alvo = ehPane ? `%${texto.slice(5)}` : `@${texto.replace(/^aba-/, '')}`;
  if (!ehPane && !/^@\d+$/.test(alvo)) throw erro(400, 'chave de aba inválida');

  // Sessão inexistente é 404, não 500: sem sessão não há aba nenhuma, e "aba não encontrada"
  // é a resposta honesta — a tela recarrega a lista, que é o que ela faria de qualquer jeito.
  // A sonda vem antes por isso: sem ela o `list-windows` abaixo rejeitaria sem `codigo` e a
  // rota devolveria 500 para um estado do mundo.
  try {
    await tmuxEstrito(['has-session', '-t', `${SESSAO_DAS_ABAS}:`]);
  } catch (e) {
    if (!semSessao(e)) throw e;          // timeout/permissão → 500, não estado do mundo
    throw erro(404, 'aba não encontrada');
  }

  // Uma leitura só, e ela responde QUATRO perguntas: a pane existe? a janela existe? elas
  // pertencem à SESSAO_DAS_ABAS — o `-t <sessao>:` é o filtro da #41 em pessoa, e é o que
  // deixa job do orquestrador e sessão de terceiro inalcançáveis por chave forjada — e o alvo é a
  // última coisa da sessão? A recontagem acontece DENTRO da fila destrutiva: é ela que
  // fecha o TOCTOU. O `#{pane_pid}` NÃO é pedido: nada em `/proc` entra no caminho
  // destrutivo, de propósito.
  const linhas = (await tmuxEstrito([
    'list-panes', '-s', '-t', `${SESSAO_DAS_ABAS}:`, '-F', '#{pane_id}\t#{window_id}',
  ])).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('\t'));
  const panes = linhas.map(([pane]) => pane);
  const janelas = [...new Set(linhas.map(([, janela]) => janela))];
  // ORDEM IMPORTA: "não existe" vem ANTES de "é a última". Ao contrário, numa sessão com
  // uma janela só, matar `aba-999999` responderia 409 em vez de 404.
  if (!(ehPane ? panes : janelas).includes(alvo)) throw erro(404, 'aba não encontrada');
  // Medido em 27/08: `kill-window` na única janela restante leva a SESSÃO junto — e em
  // 31/08, `kill-pane` na única pane da única janela também. É guarda contra dano colateral,
  // não trava que trava o usuário, e é a única não negociável daqui.
  if ((ehPane ? panes.length : janelas.length) <= 1) throw erro(409, 'é a última aba do terminal');

  // O título é só para o recado da tela. Ele PODE falhar sem derrubar o matar — é o único
  // pedaço cosmético desta função, e por isso é o único que usa o tmux leniente.
  const titulo = (await listar().catch(() => [])).find((a) => a.chave === chave)?.titulo || chave;

  // `kill-pane`/`kill-window` e mais nada: `kill-server` e `kill-session` continuam
  // proibidos neste módulo (#2). E são os IDs, não os índices: índice reordena, `%71` e
  // `@7` não.
  await tmuxEstrito([ehPane ? 'kill-pane' : 'kill-window', '-t', alvo]);
  nascendoEm.delete(chave);
  esquecerPendentes(chave);
  return { morta: true, chave, titulo };
}

/**
 * Guarda um arquivo que veio do navegador e devolve o caminho dele.
 *
 * O agente recebe o CAMINHO, não o binário: o CLI abre o arquivo com o Read, que enxerga
 * imagem. Provado em 21/08, inclusive fora do cwd do projeto — o classificador do auto mode
 * libera sem perguntar, então o envio não trava esperando permissão.
 */
async function guardarAnexo({ nome, extensao, dados }) {
  const limpo = path.basename(String(nome || 'anexo'))
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'anexo';
  const base = limpo.toLowerCase().endsWith(extensao) ? limpo.slice(0, -extensao.length) : limpo;

  await fsp.mkdir(PASTA_ANEXOS, { recursive: true });
  await limparAnexosVelhos();
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const arquivo = path.join(PASTA_ANEXOS, `${carimbo}-${base}${extensao}`);

  // Trava final: o nome já foi lavado, mas quem escreve no disco confere de novo.
  if (path.dirname(path.resolve(arquivo)) !== path.resolve(PASTA_ANEXOS)) {
    throw new Error('nome de anexo recusado');
  }
  await fsp.writeFile(arquivo, dados);
  return { arquivo, nome: path.basename(arquivo), bytes: dados.length };
}

/** Apaga o que já passou da validade. Roda junto do upload; falhar aqui não pode derrubá-lo. */
async function limparAnexosVelhos() {
  const limite = Date.now() - DIAS_DE_ANEXO * 24 * 3600e3;
  try {
    for (const nome of await fsp.readdir(PASTA_ANEXOS)) {
      const alvo = path.join(PASTA_ANEXOS, nome);
      const info = await fsp.stat(alvo).catch(() => null);
      if (info && info.isFile() && info.mtimeMs < limite) await fsp.unlink(alvo).catch(() => {});
    }
  } catch { /* pasta ainda não existe, ou sumiu no meio: nada a limpar */ }
}

/**
 * A tela da pane, cortada e limpa para caber num celular.
 *
 * Separada de `tela()` para o gate exercitar a moldura sem tmux nenhum: o que importa aqui
 * é que nada de controle passe e que o tamanho tenha teto.
 */
function moldarTela(bruto) {
  const linhas = limpar(bruto).split('\n');
  // A pane vem preenchida até o fim da altura dela; as linhas vazias do rodapé são espaço
  // em branco, não conteúdo, e no celular empurrariam a pergunta para fora da vista.
  while (linhas.length && !linhas[linhas.length - 1].trim()) linhas.pop();
  const cortadas = linhas.slice(-LINHAS_TELA);
  let texto = cortadas.join('\n');
  // Corta pelo FIM: a pergunta e as opções estão embaixo, que é o que o usuário precisa ler.
  if (texto.length > TETO_TELA) texto = texto.slice(-TETO_TELA);
  return { tela: texto, linhas: cortadas.length, cortado: texto.length < linhas.join('\n').length };
}

/**
 * O ÚNICO `capture-pane` deste projeto — e ele só existe nos dois estados do `podeVerTela`.
 *
 * A D4 aposentou a leitura da TUI porque parsear framebuffer para virar bolha de chat é
 * inferno. Esta é a exceção que a própria D4 justifica: com um menu de múltipla escolha
 * aberto, a pergunta vive SÓ na tela — não entra no `.jsonl` —, então o arquivo não tem a
 * informação e a aba fica muda no cockpit (visto ao vivo em 22/08, aba do Projeto-a).
 *
 * Desde 09/09 a exceção cobre também o `preSessao`, que é a MESMA situação um degrau antes:
 * o prompt de confiança de pasta nova não tem arquivo nenhum para ler, nem sequer o
 * `<pid>.json` do CLI. Ver o campo em `listar()`.
 *
 * A exceção é feita valer no código, não na confiança: fora desses dois estados, isto
 * recusa. Assim a rota não vira um espelho geral do terminal na web.
 */
async function tela(aba) {
  if (!aba) throw new Error('aba não encontrada');
  if (!podeVerTela(aba)) throw new Error('a aba não está com pergunta aberta no terminal');
  const bruto = await tmux(['capture-pane', '-p', '-t', aba.pane || aba.alvo]);
  return { chave: aba.chave, motivo: motivoDaTela(aba), ...moldarTela(bruto) };
}

/**
 * As ÚNICAS teclas que o cockpit sabe apertar na pane. Nome que vem do cliente → nome do
 * tmux (aqui iguais; o mapa existe para a lista ser fechada, não para traduzir).
 *
 * Por que uma lista fechada e não "a tecla que o cliente mandar": tecla livre vinda do
 * navegador é teclado remoto, que é exatamente o que a D4 e a D6 recusaram. Seta e Enter
 * respondem QUALQUER menu sem o cockpit precisar entender o que está escrito na tela —
 * parsear layout de TUI para descobrir as opções é a família da armadilha #10, e quebraria
 * no primeiro menu que ninguém conhece de antemão.
 *
 * `Left` e `Right` entraram em 28/08 por requisito do projeto: nem todo menu do CLI é vertical —
 * confirmação de duas opções lado a lado, escolha de aba dentro do prompt e passo de
 * assistente andam na HORIZONTAL, e sem elas o cockpit ficava olhando para um menu que não
 * conseguia responder. A lista continua FECHADA: seis nomes, todos de navegação, nenhum
 * caractere. Nada aqui digita texto, que é o que a D4 e a D6 recusaram.
 */
const TECLAS = new Map([
  ['Up', 'Up'],
  ['Down', 'Down'],
  ['Left', 'Left'],
  ['Right', 'Right'],
  ['Enter', 'Enter'],
  ['Escape', 'Escape'],
]);

// A TUI precisa de um instante para repintar depois da tecla. Sem esta pausa a tela que
// volta é a de ANTES, e o usuário aperta a seta e não vê nada mudar.
const ESPERA_REPINTAR = 250;

const teclaValida = (nome) => TECLAS.has(String(nome));

/**
 * Por que esta tecla não pode ser apertada nesta aba agora. `null` = pode.
 *
 * Separado de `tecla()` pelo mesmo motivo de `motivoDeRecusa`: o gate exercita as duas
 * recusas sem tmux nenhum no ar. As duas são de naturezas diferentes e o servidor as
 * traduz em códigos diferentes — tecla fora da lista é pedido malformado (400), aba fora
 * de `waiting` é estado do mundo (409).
 */
function motivoDeRecusaDeTecla(aba, nome) {
  if (!teclaValida(nome)) return `tecla não permitida: ${String(nome).slice(0, 20)}`;
  if (!aba) return 'aba não encontrada';
  if (!podeVerTela(aba)) return 'a aba não está com pergunta aberta no terminal';
  return null;
}

/**
 * Aperta uma tecla do menu na pane e devolve a tela JÁ repintada.
 *
 * Passa pela MESMA fila por aba do `enviar()`: dois toques rápidos no `↓` são dois POSTs,
 * e sem a fila eles se intercalam como os `send-keys` de duas mensagens (armadilha #28).
 */
function tecla(chave, nome) {
  return enfileirarPorAba(chave, () => apertarNaAba(chave, nome));
}

async function apertarNaAba(chave, nome) {
  const aba = await buscar(chave);
  const recusa = motivoDeRecusaDeTecla(aba, nome);
  if (recusa) throw new Error(recusa);

  await tmux(['send-keys', '-t', aba.pane || aba.alvo, TECLAS.get(String(nome))]);
  await espera(ESPERA_REPINTAR);

  // Reconfere o estado ANTES de capturar de novo. O Escape (e o Enter que fecha o menu)
  // devolve a pane ao chat normal, e devolver essa tela seria o espelho geral do terminal
  // que a D4 recusa. Fora dos dois estados do `podeVerTela`, o que volta é `esperando: false`
  // e tela vazia — o cliente usa esse campo para fechar o bloco na hora, sem esperar o evento
  // do fluxo.
  //
  // No `preSessao` o Enter que aceita a pasta NÃO fecha o bloco na hora, e isso é de
  // propósito: o `<pid>.json` do CLI leva alguns segundos para aparecer, e nesse intervalo a
  // tela mostra o agente subindo em vez de piscar para uma fita vazia.
  const depois = await buscar(chave);
  if (!podeVerTela(depois)) {
    return {
      apertado: true, chave, tecla: String(nome), esperando: false, tela: '', linhas: 0, cortado: false,
    };
  }
  const bruto = await tmux(['capture-pane', '-p', '-t', depois.pane || depois.alvo]);
  return {
    apertado: true, chave, tecla: String(nome), esperando: true, motivo: motivoDaTela(depois),
    ...moldarTela(bruto),
  };
}

/**
 * Para o turno que está rodando na aba.
 *
 * É a mesma tecla que a própria TUI anuncia na linha de status ("esc to interrupt") — não
 * se mata processo nenhum, não se derruba janela: manda-se Escape, como se o usuário tivesse
 * apertado. Por isso não precisa de trava de prefixo como o `cancelarTurno` do cockpit: não
 * existe nada aqui que possa derrubar a conversa por engano.
 */
async function interromper(chave) {
  const aba = await buscar(chave);
  if (!aba) throw new Error('aba não encontrada');
  if (!aba.temAgente) throw new Error(`a aba "${aba.titulo}" não tem agente rodando`);
  await tmux(['send-keys', '-t', aba.pane || aba.alvo, 'Escape']);
  // Serve para os dois estados: interrompe o turno que roda E cancela a pergunta aberta —
  // é a mesma tecla nos dois casos, e é por isso que o Parar continua de pé em `waiting`.
  return { parado: true, chave, titulo: aba.titulo };
}

// ─── /status nativo do Codex — exceção restrita à D4 (docs/arquitetura.md) ─────────────────────
//
// Caminho DEDICADO, separado do `enviar()` genérico: nunca registra pendente (não é
// mensagem de chat, é o Cockpit perguntando ao próprio CLI), usa só o literal `/status` e
// captura a resposta com `capture-pane -e` — ANSI preservado, porque a guarda do composer
// depende dele (ver lib/status-codex.js). Passa pela MESMA fila por aba do `enviar()`: um
// envio de skill e uma consulta de status na mesma aba não podem se intercalar.

const TEMPO_MAX_CONSULTA_STATUS_MS = 5300;   // ~5,3s — decisão do capitão (painéis rodada2)
const INTERVALO_POLL_STATUS_MS = 150;
const ESTABILIDADE_STATUS_MS = 300;
const JANELA_CAPTURA_STATUS = ['-J', '-S', '-200'];

async function reiniciarCodex(chave, aba, comando, id) {
  if (await clearCodex.executado(aba.processoCodex, id)) return;
  // Repetir numa conversa já vazia não precisa mandar outra tecla destrutiva.
  if (aba.reiniciada && !aba.arquivo) return;
  const recusa = motivoDeRecusaDeStatus(aba);
  if (recusa) throw erro(recusa.codigo, recusa.mensagem);
  clearCodex.arquivo(aba.processoCodex); // identidade verificável antes de qualquer tecla
  const prazo = Date.now() + 6000;
  const validar = async () => {
    const atual = await buscar(chave);
    if (!mesmaIdentidadeStatus(aba, atual)
      || JSON.stringify(aba.processoCodex) !== JSON.stringify(atual.processoCodex)
      || atual.rodando !== false) throw erro(409, 'a sessão mudou; confira o terminal antes de tentar novamente');
  };
  const antes = await capturarPaneStatus(aba.pane, prazo);
  if (!statusCodex.composerVazio(antes)) throw erro(409, 'o composer não está vazio; confira o terminal antes de tentar novamente');
  await validar();
  // Espaço final fecha o autocomplete, mas não altera o comando.
  await tmuxDoStatus(['send-keys', '-t', aba.pane, '-l', '--', comando + ' '], prazo);
  await espera(150);
  if (!statusCodex.composerContemExatamente(await capturarPaneStatus(aba.pane, prazo), comando)) {
    throw erro(409, 'Confira o terminal antes de tentar novamente.');
  }
  await validar();
  await tmuxDoStatus(['send-keys', '-t', aba.pane, 'Enter'], prazo);
  while (Date.now() < prazo) {
    const tela = await capturarPaneStatus(aba.pane, prazo);
    if (clearCodex.confirmou(antes, tela, aba.sessaoId)) {
      await espera(300);
      if (clearCodex.confirmou(antes, await capturarPaneStatus(aba.pane, prazo), aba.sessaoId)) {
        await validar();
        await clearCodex.registrar(aba.processoCodex, aba.sessaoId, id);
        esquecerPendentes(chave);
        return;
      }
    }
    await espera(150);
  }
  throw erro(504, `não consegui confirmar ${comando}; confira o terminal antes de tentar novamente`);
}

function tmuxDoStatus(args, prazo) {
  const restante = prazo - Date.now();
  if (restante <= 0) return Promise.reject(erro(504, 'tempo esgotado consultando /status'));
  return new Promise((resolve, reject) => {
    execFile('tmux', comSocket(args), { timeout: Math.min(1000, restante), maxBuffer: 256 * 1024 }, (falha, saida) => {
      if (falha) return reject(erro(falha.killed ? 504 : 500, 'não consegui consultar o terminal; confira o terminal antes de tentar novamente'));
      resolve(String(saida || ''));
    });
  });
}

function capturarPaneStatus(pane, prazo) {
  return tmuxDoStatus(['capture-pane', '-e', '-p', ...JANELA_CAPTURA_STATUS, '-t', pane], prazo);
}

function mesmaIdentidadeStatus(a, b) {
  return Boolean(a && b && a.agente === 'codex' && b.agente === 'codex'
    && a.sessaoId === b.sessaoId && a.pane === b.pane && a.arquivo === b.arquivo
    && b.casamento !== 'ambiguo');
}

/**
 * Por que esta aba não pode responder `/status` agora. `null` = pode.
 *
 * As mensagens são as que o capitão fechou na rodada 2: "sessão ainda não identificada"
 * para aba sem `sessaoId`/`arquivo` (nunca terminou uma conversa no Codex ainda) é
 * DIFERENTE de "não foi possível confirmar que está ocioso" (`rodando` desconhecido) — os
 * dois são 409, mas dizem coisas diferentes, e colapsá-los é a #40.
 */
function motivoDeRecusaDeStatus(aba) {
  if (!aba) return { codigo: 404, mensagem: 'aba não encontrada' };
  if (aba.agente !== 'codex') return { codigo: 409, mensagem: 'este comando só existe para abas do Codex' };
  if (!aba.temAgente) return { codigo: 409, mensagem: `a aba "${aba.titulo}" não tem agente rodando` };
  if (!/^%\d+$/.test(aba.pane || '') || aba.casamento === 'ambiguo') return { codigo: 409, mensagem: 'não consegui confirmar a pane desta sessão' };
  if (aba.esperando) return { codigo: 409, mensagem: 'o terminal está com uma pergunta aberta; cancele com Esc para escrever' };
  if (!aba.sessaoId || !aba.arquivo) {
    return {
      codigo: 409,
      mensagem: 'Sessão ainda não identificada. Conclua uma conversa no Codex antes de consultar o status pelo Cockpit.',
    };
  }
  // `rodando === false` estrito: `true`, `null` e ausente recusam, cada um com um recado.
  if (aba.rodando === true) return { codigo: 409, mensagem: 'o Codex está com um turno em andamento; aguarde terminar' };
  if (aba.rodando !== false) return { codigo: 409, mensagem: 'não foi possível confirmar que o Codex está ocioso' };
  return null;
}

/** Consulta `/status` na aba, serializada pela mesma fila de `enviar()`/`tecla()`. */
function consultarStatus(chave, id) {
  return enfileirarPorAba(chave, async () => {
    if (typeof id !== 'string' || !idValido(id)) throw erro(400, 'id de envio inválido');
    const aba = await buscar(chave);
    if (!aba) throw erro(404, 'aba não encontrada');
    if (aba.agente !== 'codex' || !aba.sessaoId || !aba.arquivo || !aba.pane || aba.casamento === 'ambiguo') {
      const recusa = motivoDeRecusaDeStatus(aba);
      throw erro(recusa?.codigo || 409, recusa?.mensagem || 'sessão não identificada');
    }
    const existente = (await statusCodex.snapshotsDe(aba.sessaoId)).find(s => s.id === id);
    if (existente) {
      if (!mesmaIdentidadeStatus(aba, await buscar(chave))) throw erro(409, 'a sessão mudou durante a consulta');
      return existente;
    }
    const resultado = await executarConsultaStatus(chave, id);
    if (!mesmaIdentidadeStatus(aba, await buscar(chave))) throw erro(409, 'a sessão mudou durante a consulta');
    const { snapshot } = await statusCodex.registrarSnapshot(resultado.sessaoId, { id, ...resultado });
    if (!mesmaIdentidadeStatus(aba, await buscar(chave))) throw erro(409, 'a sessão mudou durante a consulta');
    return snapshot;
  });
}

async function executarConsultaStatus(chave, id) {
  const prazo = Date.now() + TEMPO_MAX_CONSULTA_STATUS_MS;
  const aba = await buscar(chave);
  const recusa = motivoDeRecusaDeStatus(aba);
  if (recusa) throw erro(recusa.codigo, recusa.mensagem);
  const pane = aba.pane;
  const validar = async () => {
    const atual = await buscar(chave);
    if (!mesmaIdentidadeStatus(aba, atual)) throw erro(409, 'a sessão mudou; confira o terminal antes de tentar novamente');
    const motivo = motivoDeRecusaDeStatus(atual);
    if (motivo) throw erro(motivo.codigo, motivo.mensagem);
    if (Date.now() >= prazo) throw erro(504, 'tempo esgotado consultando /status');
  };
  const aguardar = async ms => {
    if (Date.now() + ms >= prazo) throw erro(504, 'tempo esgotado aguardando a resposta do /status');
    await espera(ms);
  };
  const antesRaw = await capturarPaneStatus(pane, prazo);
  if (!statusCodex.composerVazio(antesRaw)) throw erro(409, 'o composer não está vazio; confira o terminal antes de tentar novamente');
  await validar();
  await tmuxDoStatus(['send-keys', '-t', aba.pane || aba.alvo, '-l', '--', '/status'], prazo);
  await aguardar(150);
  const digitadoRaw = await capturarPaneStatus(pane, prazo);
  if (!statusCodex.composerContemExatamente(digitadoRaw, '/status')) throw erro(409, 'Confira o terminal antes de tentar novamente.');
  await validar();
  await tmuxDoStatus(['send-keys', '-t', aba.pane || aba.alvo, 'Enter'], prazo);

  while (Date.now() < prazo) {
    const capturaA = await capturarPaneStatus(pane, prazo);
    if (statusCodex.capturaNova(antesRaw, capturaA)) {
      const resultadoA = statusCodex.extrairBlocoStatus(capturaA, aba.sessaoId);
      if (resultadoA.motivo === 'sessao-divergente') throw erro(409, 'a resposta veio de outra sessão');
      if (resultadoA.ok) {
        await aguardar(ESTABILIDADE_STATUS_MS);
        const capturaB = await capturarPaneStatus(pane, prazo);
        const resultadoB = statusCodex.extrairBlocoStatus(capturaB, aba.sessaoId);
        if (statusCodex.capturaNova(antesRaw, capturaB) && resultadoB.ok && resultadoB.texto === resultadoA.texto) {
          await validar();
          return { texto: resultadoB.texto, sessaoId: aba.sessaoId, quando: new Date().toISOString() };
        }
      }
    }
    await aguardar(INTERVALO_POLL_STATUS_MS);
  }
  throw erro(504, 'tempo esgotado aguardando resposta nova do /status');
}

/**
 * Quanto da assinatura OPENAI foi gasto — o que o painel de Configuração mostra abaixo do
 * consumo da Anthropic. `null` quando não há aba de Codex viva: é AUSÊNCIA, não `0%`.
 *
 * Mora aqui, e não no `server.js`, porque precisa da lista de abas e é este módulo que sabe
 * montá-la — pôr a varredura lá duplicaria o `list-panes`. E REAPROVEITA o `listar()` em vez
 * de varrer por conta própria: o painel de Configuração é uma tela que o usuário abre de
 * propósito, e um `listar()` a mais ali custa o mesmo que o refresh que já roda de 5 em 5 s.
 *
 * 🔴 Ele NÃO entra no cache de `lib/limite.js`, e isso não é detalhe. Aquele cache tem TTL
 * porque consultar a Anthropic CUSTA UM TURNO; o lado do Codex é uma leitura de cauda de
 * arquivo, de graça. Dentro do mesmo cache, a porcentagem do Codex CONGELARIA até o usuário
 * clicar em atualizar.
 *
 * Qual aba fala pelo plano, quando há mais de uma: vence a do `token_count` mais recente —
 * comparado pelo `timestamp` do EVENTO, não pelo `mtime` do arquivo, que muda por qualquer
 * escrita, inclusive de um turno que não emitiu `token_count`. Empate ⇒ o menor `pane_id`,
 * para ser determinístico. E o cabeçalho diz de QUAL aba veio: mostrar porcentagem de
 * assinatura sem dizer de onde ela saiu é o número com cara de certo que a #10 proíbe.
 *
 * @returns {?{limites: Array, titulo: string, varias: boolean}}
 */
async function consumoDoCodex() {
  const doCodex = (await listar()).filter((a) => a.agente === 'codex' && a.arquivo);
  if (!doCodex.length) return null;

  const { medidor } = agentes.de('codex');
  const medidas = [];
  for (const aba of doCodex) {
    const medida = await medidor.doArquivo(aba.arquivo).catch(() => null);
    if (medida?.limites) medidas.push({ aba, medida });
  }
  if (!medidas.length) return null;

  const numeroDaPane = (aba) => Number(String(aba.pane || '').replace('%', '')) || 0;
  medidas.sort((x, y) => (y.medida.medidoEm || 0) - (x.medida.medidoEm || 0)
    || numeroDaPane(x.aba) - numeroDaPane(y.aba));

  const [vencedora] = medidas;
  return {
    limites: vencedora.medida.limites,
    titulo: vencedora.aba.titulo,
    // Com uma aba só o cabeçalho fica `Codex (OpenAI)` limpo; com mais de uma ele diz de
    // qual delas o número veio.
    varias: doCodex.length > 1,
  };
}

/** O que sai para o navegador: sem `alvo`, sem `arquivo`. Caminho de disco não é do cliente. */
function paraCliente(aba) {
  const { alvo, arquivo, pane, processoCodex, ...resto } = aba;
  return resto;
}

module.exports = {
  listar, buscar, enviar, interromper, guardarAnexo, paraCliente, limpar, horaDaUltimaMensagem,
  sessoesDoCli, mesmoProcesso, detectarAgente, normalizarNome, abasDoProjeto, PASTA_ANEXOS,
  consumoDoCodex,
  tela, moldarTela, motivoDeRecusa, enfileirarPorAba,
  // A regra de "esta aba pode mostrar a tela da pane" tem UM dono, e o `server.js` lê daqui
  // para decidir o evento `esperando` do fluxo — duas cópias da regra seriam a #40.
  podeVerTela, motivoDaTela,
  tecla, teclaValida, motivoDeRecusaDeTecla, TECLAS,
  consultarStatus, motivoDeRecusaDeStatus,
  criar, matar, comandoDaAba,
  // Exportada para o gate: o caminho perigoso desta função é a escrita no `~/.claude.json`,
  // e ele precisa ser exercitado com um HOME de mentira, sem tmux nenhum no ar.
  confiarNaPasta,
  // O `tmux()` leniente NÃO sai daqui: quem chama de fora precisa do que estoura.
  tmuxEstrito, chaveDaAba, semSessao,
  // A pendente que sobrevive à reconexão (card `mensagem-na-fila-some-da-fita`, D-a).
  idValido, registrarPendente, pendentesDe, consumirPendente, pendenteViva,
  esquecerPendente, esquecerPendentes,
};
