'use strict';
// O que aconteceu na conversa FORA do cockpit.
//
// O problema, provado em 20/08: a mesma sessão tem duas memórias. A do agente vive em
// ~/.claude/projects/<projeto>/<id>.jsonl e é o que o `--resume` relê; a da tela vive em
// ~/.cockpit/sessoes/<id>/turno-N.* e é o que o cockpit desenha. Quem abrir
// `claude --resume <id>` num terminal escreve só na primeira. O agente passa a lembrar de
// coisas que a tela não mostra, e o usuário lê respostas sobre perguntas invisíveis.
//
// Este módulo lê a memória do agente e devolve o que falta na tela.
//
// FRONTEIRA IMPORTANTE: o formato deste arquivo é INTERNO do Claude Code, não é o
// stream-json documentado que o adaptador consome. Ele pode mudar sem aviso. Por isso é
// complemento, nunca fonte principal: quando não reconhece nada, devolve lista vazia e o
// cockpit segue mostrando o que sempre mostrou.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
// Só a medição do contexto — e só quem PEDE paga por ela (ver o `contexto` opt-in de
// `lerConversa`). Não há ciclo: lib/contexto.js requer apenas fs/os/path.
const { medir: medirContexto } = require('./contexto');

const RAIZ_PROJETOS = path.join(os.homedir(), '.claude', 'projects');

/**
 * Onde o CLI guardou esta sessão.
 *
 * O nome da pasta é o cwd com os separadores trocados por hífen, mas essa regra é
 * convenção do CLI e já mudou de forma antes. Como o id da sessão é único, procurar por
 * ele custa um readdir e não depende de adivinhar nomenclatura.
 */
async function arquivoDaSessao(id, cwd) {
  if (cwd) {
    const provavel = path.join(RAIZ_PROJETOS, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
    try {
      await fsp.access(provavel);
      return provavel;
    } catch { /* cai na varredura */ }
  }
  let pastas = [];
  try {
    pastas = await fsp.readdir(RAIZ_PROJETOS);
  } catch {
    return null;
  }
  for (const pasta of pastas) {
    const alvo = path.join(RAIZ_PROJETOS, pasta, `${id}.jsonl`);
    try {
      await fsp.access(alvo);
      return alvo;
    } catch { /* segue */ }
  }
  return null;
}

/** Texto de uma mensagem, seja ela string ou lista de blocos. */
function textoDe(mensagem) {
  const conteudo = mensagem?.content;
  if (typeof conteudo === 'string') return conteudo;
  if (!Array.isArray(conteudo)) return '';
  return conteudo.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');
}

/**
 * O eco de um comando de barra (`/clear`, `/handoff`, `/effort high`), desembrulhado de volta
 * para o que o humano digitou — ou `null`, quando o texto não é esse envelope.
 *
 * O CLI não grava `/clear` no `.jsonl`: grava as tags `<command-name>`, `<command-message>` e
 * (só nos nativos) `<command-args>`. Sem desfazer isso, `consumirPendente` (lib/abas.js) compara
 * a ficha `/clear` com o XML inteiro, os dois testes (`===` e `endsWith`) falham, e a bolha
 * "na fila" fica presa até o teto de 30 min. Vale para SKILL também, não só para nativo — é por
 * isso que o conserto mora aqui, e não num desvio por nome de comando em `digitarNaAba`.
 *
 * Por que não um regex ancorado como o do `<bash-input>` logo abaixo: a ORDEM das tags muda
 * entre um caso e outro (`/clear` grava o nome primeiro; `/handoff` grava a mensagem primeiro),
 * e o nativo ainda indenta as linhas seguintes. Só a extração por tag avulsa cobre os dois.
 *
 * O `resto` é a trava contra falso positivo: uma fala de VERDADE que por acaso cite
 * `<command-name>` no meio de um parágrafo continua sendo a fala, e não vira `/algo`. Só
 * desembrulha o texto que é SÓ envelope.
 */
function desembrulharComando(texto) {
  const nome = /<command-name>([\s\S]*?)<\/command-name>/.exec(texto);
  if (!nome) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(texto);
  const resto = texto
    .replace(/<command-name>[\s\S]*?<\/command-name>/, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/, '')
    .trim();
  if (resto) return null;
  const barra = nome[1].trim();
  if (!barra) return null;
  // `/effort high` volta inteiro: a ficha guarda o que foi digitado, argumento incluído.
  const cauda = args ? args[1].trim() : '';
  return cauda ? `${barra} ${cauda}` : barra;
}

function textoDoHumano(obj) {
  const texto = textoDe(obj.message).trim();
  // Bash mode registra o eco como XML, embora o usuário tenha digitado !comando.
  // Preservar o espaço após ! faz o eco casar com a ficha enviada pelo Cockpit.
  const bash = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(texto);
  if (bash) return `!${bash[1]}`.trim();
  return desembrulharComando(texto) || texto;
}

/** A mensagem é uma fala de verdade do humano, e não injeção do sistema? */
function ehFalaDoHumano(obj) {
  if (obj.type !== 'user' || obj.isMeta || obj.isSidechain) return false;
  const conteudo = obj.message?.content;
  // tool_result também chega como `user`: é a máquina respondendo à máquina.
  if (Array.isArray(conteudo) && conteudo.every((p) => p.type === 'tool_result')) return false;
  return Boolean(textoDe(obj.message).trim());
}

/**
 * As linhas de um arquivo, lidas para FRENTE em blocos de `BLOCO` bytes.
 *
 * Existe porque `trocasDeFora` lia o `.jsonl` INTEIRO com `fsp.readFile` + `split('\n')` — duas
 * alocações do tamanho do arquivo, vivas ao mesmo tempo. Medido em 02/09 nos arquivos reais do
 * disco: o pico de memória era ~4,5x o tamanho do arquivo (+117,6 MB num `.jsonl` de 25 MB).
 * Aqui o custo é um bloco por vez, mais a maior linha.
 *
 * PARA FRENTE, e é o oposto das três irmãs deste repo — `doArquivo` (lib/contexto.js),
 * `lerConversa` (abaixo) e a do adaptador do Codex leem para TRÁS, porque o que elas querem está
 * no fim (o último `usage`, as últimas 80 mensagens). `trocasDeFora` não pode: ela conta os
 * prompts do cockpit desde o byte 0 para saber `depoisDoTurno`, e essa contagem é sequencial.
 *
 * E SEM TETO DE BYTES, também ao contrário das irmãs. Nelas o `TETO_DURO` é rede contra arquivo
 * patológico; aqui ele seria perda de dado — uma troca de fora antiga que não fosse lida some da
 * fita, que é exatamente o bug que este módulo existe para consertar.
 *
 * EMENDA DE BORDA (armadilha #11): a fronteira de um bloco cai no meio de uma linha. O pedaço
 * que sobra vai para `resto` — uma LISTA DE BUFFERS, nunca uma string — e é reconstruído com o
 * bloco seguinte. Guardar como string cortaria caractere multibyte na fronteira: um `é` partido
 * em dois blocos viraria `\uFFFD` calado. Por isso `toString('utf8')` só roda em fatia que
 * começa e termina em `\n`, no byte 0 ou no EOF. A outra metade da #11 — "devolva o marcador
 * para antes da linha incompleta" — NÃO se aplica: aquilo é para leitura incremental, e esta
 * função lê tudo de uma vez e não devolve offset nenhum.
 *
 * A ÚLTIMA LINHA SEM `\n` É ENTREGUE. O `split('\n')` de antes a entregava, e se ela estivesse
 * pela metade o `JSON.parse` falhava e o `catch` do chamador a descartava calado. Não emiti-la
 * mudaria o comportamento: sumiria a última troca de fora de todo arquivo que não termina em
 * `\n` — inclusive a de um turno rodando agora.
 *
 * LIMITE INICIAL DE BYTES, não snapshot de conteúdo: `info.size` diz QUANTO ler, não O QUÊ. Sem
 * ele, um `.jsonl` sendo escrito agora faria o laço perseguir o EOF e o chamador nunca retornar.
 * O conteúdo continua vindo do inode vivo — o que torna isso seguro é o `.jsonl` do CLI ser
 * APPEND-ONLY: ele acrescenta uma linha por mensagem e nunca reescreve o miolo. A única mutação
 * não-append real é o arquivo ser trocado inteiro no `/clear`, e aí o `open` já prendeu o inode
 * antigo, que fica íntegro até a alça fechar.
 *
 * Os dois `catch` filtram por `erro.syscall`, e isso não é preciosismo: todo erro de fs do Node
 * carrega `syscall`, e `TypeError`/`RangeError` de bug de programação não carregam. Um `catch`
 * cego transformaria uma regressão daqui em "conversa sem trocas de fora" — um bug disfarçado de
 * conversa vazia.
 *
 * EXPORTADO SÓ PARA TESTE, sem contrato público estável: nenhum arquivo de produção o chama, e
 * assinatura e comportamento podem mudar junto com `trocasDeFora`. Quem depende dele é
 * `testes/gate-externo-blocos.js`, que precisa consumi-lo passo a passo para exercitar as bordas.
 */
async function* linhasDoArquivo(arquivo) {
  // `try` próprio para o `open`: ele é a única operação antes de haver alça para fechar, e é a
  // que substitui o `catch` do `readFile` de antes — arquivo que sumiu vira `[]`, não exceção.
  let alca;
  try {
    alca = await fsp.open(arquivo, 'r');
  } catch (erro) {
    if (!erro || !erro.syscall) throw erro;
    return;                                   // nada emitido ⇒ o chamador devolve []
  }
  try {
    // Do HANDLE já aberto, nunca `fsp.stat(arquivo)`: entre resolver o nome duas vezes o arquivo
    // pode ser trocado, e o tamanho seria de um inode com o conteúdo de outro.
    const info = await alca.stat();
    let resto = [];        // Buffers do pedaço de linha sem '\n'; nunca contém '\n'.
    let de = 0;

    while (de < info.size) {
      const querido = Math.min(BLOCO, info.size - de);
      const buffer = Buffer.alloc(querido);
      // `read()` pode devolver menos bytes do que se pediu (a API do Node permite). Laço interno
      // até encher ou bater EOF, para não tratar um `read` curto como fim de arquivo — mesmo
      // cuidado de `lerConversa` e de lib/contexto.js.
      let preenchido = 0;
      while (preenchido < querido) {
        const { bytesRead } = await alca.read(buffer, preenchido, querido - preenchido, de + preenchido);
        if (bytesRead === 0) break;
        preenchido += bytesRead;
      }
      if (preenchido === 0) break;             // arquivo truncado sob a alça: para e devolve o que leu
      de += preenchido;

      const bloco = buffer.subarray(0, preenchido);
      let inicio = 0;
      for (;;) {
        const nl = bloco.indexOf(10, inicio);  // '\n'
        if (nl < 0) break;
        const pedaco = bloco.subarray(inicio, nl);
        // `Buffer.concat` só quando a linha cruza a fronteira; no caso comum é subarray + toString.
        yield resto.length
          ? Buffer.concat([...resto, pedaco]).toString('utf8')
          : pedaco.toString('utf8');
        resto = [];
        inicio = nl + 1;
      }
      if (inicio < bloco.length) resto.push(bloco.subarray(inicio));
    }

    if (resto.length) yield Buffer.concat(resto).toString('utf8');
  } catch (erro) {
    // Só erro de SYSCALL é absorvido — ver a docstring. Erro de I/O no meio para de emitir e o
    // chamador fica com o que já saiu; é a única diferença observável desta mudança.
    if (!erro || !erro.syscall) throw erro;
  } finally {
    // Cego de propósito, e só aqui: num `finally`, relançar substituiria a exceção real que
    // estivesse subindo por um `EBADF` de fechamento. Mesmo padrão de lib/contexto.js:305.
    await alca.close().catch(() => {});
  }
}

/**
 * As trocas que aconteceram fora do cockpit, já posicionadas.
 *
 * `depoisDoTurno` diz atrás de qual turno do cockpit o bloco entra: é o número de prompts
 * do cockpit que apareceram antes dele na memória do agente. Assim a fita fica na ordem
 * real, mesmo alternando terminal e cockpit várias vezes.
 *
 * A leitura é para FRENTE, em blocos de 64 KB (`linhasDoArquivo`, acima) — e não um
 * `readFile` do arquivo todo, como era até 02/09. Para frente porque o `jaVistos` abaixo conta
 * desde o byte 0; sem teto de bytes porque teto aqui seria troca de fora sumindo da fita. O
 * corpo deste laço não mudou nada com a troca: ele recebe as mesmas linhas, na mesma ordem.
 *
 * @param {string} id
 * @param {string} cwd
 * @param {string[]} promptsDoCockpit textos que o cockpit enviou, em ordem de turno.
 */
async function trocasDeFora(id, cwd, promptsDoCockpit) {
  const arquivo = await arquivoDaSessao(id, cwd);
  if (!arquivo) return [];

  const conhecidos = promptsDoCockpit.map((t) => String(t).trim());
  const blocos = [];
  let jaVistos = 0;      // quantos prompts do cockpit já passaram
  let atual = null;      // bloco de fora sendo montado

  for await (const linha of linhasDoArquivo(arquivo)) {
    if (!linha.trim()) continue;
    let obj;
    try { obj = JSON.parse(linha); } catch { continue; }

    if (ehFalaDoHumano(obj)) {
      const texto = textoDoHumano(obj);
      // Prompt que o cockpit mandou: fecha qualquer bloco de fora e avança o contador.
      if (jaVistos < conhecidos.length && texto === conhecidos[jaVistos]) {
        jaVistos += 1;
        atual = null;
        continue;
      }
      atual = { depoisDoTurno: jaVistos, quando: obj.timestamp || null, eventos: [] };
      atual.eventos.push({ tipo: 'humano', texto, deFora: true });
      blocos.push(atual);
      continue;
    }

    if (obj.type === 'assistant' && atual && !obj.isSidechain) {
      for (const parte of obj.message?.content || []) {
        if (parte.type === 'text' && parte.text.trim()) {
          atual.eventos.push({ tipo: 'texto', texto: parte.text, deFora: true });
        } else if (parte.type === 'tool_use') {
          atual.eventos.push({ tipo: 'ferramenta', id: parte.id, nome: parte.name, entrada: parte.input, deFora: true, ...(typeof obj.timestamp === 'string' && obj.timestamp ? { t: obj.timestamp } : {}) });
        }
      }
    }
  }

  return blocos;
}

/**
 * Uma linha do arquivo do CLI virando os eventos que a fita desenha.
 *
 * É o mesmo vocabulário do adaptador (`humano`, `texto`, `ferramenta`,
 * `resultado_ferramenta`), de propósito: assim a conversa de uma ABA do terminal cai no
 * mesmo `aplicar()` do cliente que já desenha as conversas do cockpit, sem código de tela
 * novo. Ver public/app.js.
 */
function eventosDoObjeto(obj) {
  if (obj.isSidechain) return [];  // subagente: barulho de máquina, não a conversa

  // Cada linha do arquivo traz `timestamp` em ISO 8601 UTC. É o único relógio confiável
  // desta conversa — o mtime do arquivo só sabe da última linha, e o servidor pode estar
  // num fuso diferente do aparelho. Quem converte para a hora local é a TELA, não aqui.
  // Só a conversa carrega hora: `ferramenta` e `resultado_ferramenta` são máquina falando
  // com máquina e não viram bolha com hora própria.
  const quando = typeof obj.timestamp === 'string' && obj.timestamp ? obj.timestamp : null;
  // Arquivo velho ou linha torta não tem o campo: o evento sai sem `quando` e a tela
  // desenha a bolha como sempre desenhou, sem hora. Nunca vira bolha quebrada.
  const comHora = (evento) => (quando ? { ...evento, quando } : evento);

  if (ehFalaDoHumano(obj)) {
    return [comHora({ tipo: 'humano', texto: textoDoHumano(obj) })];
  }

  // tool_result chega como `user`: é a máquina respondendo à máquina, e o que a fita quer
  // dele é só fechar o cartão da ferramenta que já está na tela.
  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    const saidas = [];
    for (const parte of obj.message.content) {
      if (parte.type !== 'tool_result') continue;
      const bruto = typeof parte.content === 'string'
        ? parte.content
        : (Array.isArray(parte.content)
          ? parte.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
          : '');
      saidas.push({
        tipo: 'resultado_ferramenta',
        id: parte.tool_use_id,
        saida: String(bruto).slice(0, 4000),
        erro: Boolean(parte.is_error),
        ...(quando ? { t: quando } : {}),
      });
    }
    return saidas;
  }

  if (obj.type === 'assistant') {
    const eventos = [];
    for (const parte of obj.message?.content || []) {
      if (parte.type === 'text' && parte.text.trim()) {
        eventos.push(comHora({ tipo: 'texto', texto: parte.text }));
      } else if (parte.type === 'tool_use') {
        eventos.push({ tipo: 'ferramenta', id: parte.id, nome: parte.name, entrada: parte.input, ...(quando ? { t: quando } : {}) });
      }
    }
    return eventos;
  }

  return [];
}

/**
 * As três constantes da leitura para trás (§2.3 da spec 2026-08-24).
 *
 * `BLOCO` — 64 KB. Um bloco basta para achar a última mensagem em 9 das 10 abas reais.
 * `ALVO_MENSAGENS` — 80. É a ordem que o job pediu, ~4x o que o celular mostra numa
 * rolagem confortável.
 * `TETO_DURO` — 4 MB. Rede contra arquivo patológico. Medido com o protótipo: com 2 MB,
 * `aba-10` continuava em 3 mensagens e `aba-25` em 11 — o bug NÃO era consertado nessas
 * duas, porque as próprias imagens comem o orçamento de bytes. Com 4 MB, `aba-10` sobe
 * para 10 mensagens (arquivo inteiro, 2,52 MB, 33 ms) e `aba-25` para 29 (4 MB lidos,
 * 43 ms). Com 8 MB o ganho já não compensa o custo extra. 4 MB conserta as duas abas
 * doentes e mantém o `.jsonl` de 44 MB em ~35 ms — pago UMA vez por abertura de fluxo.
 */
const BLOCO = 64 * 1024;
const ALVO_MENSAGENS = 80;
const TETO_DURO = 4 * 1024 * 1024;

/**
 * A conversa inteira de um arquivo do CLI, ou só o pedaço que cresceu desde `desde` bytes.
 *
 * O corte da leitura INICIAL é por NÚMERO DE MENSAGENS, não por byte (spec
 * 2026-08-24-historico-corte-por-mensagem). Uma mensagem é o evento que a fita desenha
 * como bolha — evento com `quando` que o `Date.parse` entende, a mesma régua de
 * `horaDaUltimaMensagem` em lib/abas.js. O defeito do corte por byte: um print mandado
 * pelo cockpit vira base64 numa LINHA SÓ do `.jsonl`, e essa linha sozinha podia ocupar a
 * janela inteira — medida em `aba-10` em 24/08, uma linha de 710 KB dentro de uma janela
 * de 256 KB. O histórico da aba chegava com 3 mensagens.
 *
 * A leitura para trás anda em blocos de `BLOCO` bytes, do fim para o começo, até juntar
 * `alvoMensagens` mensagens, chegar ao byte 0, ou gastar `TETO_DURO` bytes — o que vier
 * primeiro. `TETO_DURO` é rede de segurança contra arquivo patológico, não a regra: a
 * regra é a contagem de mensagens.
 *
 * O retorno traz `tamanho` para o chamador continuar de onde parou: é assim que o fluxo da
 * aba acompanha um turno rodando sem reler um arquivo que passa fácil de 1 MB a cada
 * batida. Ler a partir de um offset pode cair no meio de uma linha — a última linha
 * incompleta fica de fora e o `tamanho` devolvido para antes dela, para ela vir inteira na
 * próxima leitura.
 *
 * Na leitura inicial (`desde` 0), a PRIMEIRA linha de um bloco pode cair no meio de uma
 * escrita antiga — ela é reconstruída pela emenda com o bloco seguinte (`carry`), e só é
 * descartada quando sobra no fim do laço, ao chegar no teto ou no alvo antes do byte 0.
 * `cortado` sai no retorno para o chamador poder dizer na tela que o começo do histórico
 * não está lá.
 */
async function lerConversa(arquivo, desde = 0, { alvoMensagens = ALVO_MENSAGENS, contexto = null } = {}) {
  const alvo = Math.max(1, Math.trunc(Number(alvoMensagens)) || ALVO_MENSAGENS);
  // OPT-IN, e é o ponto: `horaDaUltimaMensagem` (lib/abas.js) chama esta função para TODAS as
  // abas a cada 5 s, só para pegar UM timestamp. Medir sempre cobraria dela o `medir()` e o
  // `janelaLongaConfigurada()` — I/O de até dois arquivos de config por aba, por batida — numa
  // função que acabou de ser otimizada. Sem a opção, o retorno é byte por byte o de antes:
  // nem a medição acontece, nem o campo aparece.
  const medeContexto = Boolean(contexto);
  const comContexto = (retorno, medido) => (medeContexto ? { ...retorno, contexto: medido } : retorno);
  let info;
  try {
    info = await fsp.stat(arquivo);
  } catch {
    return comContexto({ eventos: [], tamanho: 0, cortado: false, bytesLidos: 0 }, null);
  }
  // Arquivo encolheu: /clear ou sessão recomeçada. Relê do zero em vez de devolver lixo.
  const inicio = desde > info.size ? 0 : desde;
  // Sem bytes novos não há texto para medir — `null`, e o servidor não emite nada.
  if (inicio === info.size) return comContexto({ eventos: [], tamanho: info.size, cortado: false, bytesLidos: 0 }, null);

  // Incremental: continua a leitura para FRENTE do offset até o fim, sem teto — é o que faz
  // a resposta aparecer no celular enquanto o agente ainda escreve. Nada aqui muda com a
  // regra nova, além do `bytesLidos` no retorno.
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
      try {
        eventos.push(...eventosDoObjeto(JSON.parse(linha)));
      } catch { /* linha pela metade ou formato que não conhecemos: segue */ }
    }
    return comContexto({
      eventos,
      tamanho: info.size - Buffer.byteLength(sobra, 'utf8'),
      cortado: false,
      bytesLidos: info.size - inicio,
      // `cortado: false` aqui não é chute: o `tamanho` devolvido para antes de uma linha
      // incompleta faz o `inicio` da próxima leitura cair sempre numa fronteira de linha (a
      // docstring acima diz isso), então a primeira linha deste pedaço vem sempre inteira.
      // O `longa` chega já resolvido de fora — lê-lo aqui seria I/O de config a cada 700 ms.
    }, medeContexto ? medirContexto(bruto, { cortado: false, longa: Boolean(contexto.longa) }) : null);
  }

  // Leitura inicial: para trás, em blocos, pela regra de mensagens (§2.2.1 da spec).
  const alca = await fsp.open(arquivo, 'r');
  try {
    let de = info.size;
    let carry = [];       // LISTA de Buffers do pedaço de linha que falta emendar; nunca contém '\n'.
    let blocos = [];       // lista de listas de eventos, do mais ANTIGO para o mais novo (unshift).
    let lidos = 0;
    let msgs = 0;
    let sobra = null;      // bytes da linha incompleta do FIM do arquivo — determinada uma única vez.

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
      // Arquivo encolheu entre o `stat` e o `read`: para o laço, devolve o que já se tem.
      // Não relê nem recalcula o stat — o tique de 700 ms seguinte pega o arquivo novo.
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
        // UM concat, linear no tamanho — a busca pelo '\n' foi só no bloco recém-lido.
        corpo = Buffer.concat([bloco.subarray(nl + 1), ...carry]);
        carry = [bloco.subarray(0, nl)];
      } else {
        // Chegou ao byte 0 do arquivo: nada é carry, a primeira linha vem inteira.
        corpo = Buffer.concat([bloco, ...carry]);
        carry = [];
      }

      const linhas = corpo.toString('utf8').split('\n');
      if (sobra === null) {
        // Primeira volta que produz um `corpo` = a do EOF: o último elemento é a linha
        // sem '\n' no fim (escrita em curso). Sai da lista, não passa por JSON.parse.
        sobra = Buffer.byteLength(linhas.pop(), 'utf8');
      }

      const eventosDoBloco = [];
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        try {
          eventosDoBloco.push(...eventosDoObjeto(JSON.parse(linha)));
        } catch { /* linha que não parseia não vira nada */ }
      }
      msgs += eventosDoBloco.filter((e) => Number.isFinite(Date.parse(e.quando || ''))).length;
      blocos.unshift(eventosDoBloco);
      de = novoDe;
    }

    // Saída — o `carry` pendente é jogado fora sem JSON.parse. Pela invariante do laço,
    // isso só acontece quando `de > 0`, exatamente quando `cortado` é `true`.
    const eventos = [].concat(...blocos);
    // Caso patológico: o laço terminou sem NUNCA produzir um `corpo` (a última linha passa
    // do teto). `sobra` fica indefinida e a decisão é `tamanho = info.size` (§2.2.1/§6):
    // perde-se só a linha que estava sendo escrita, e o incremental não relê 4 MB para sempre.
    const tamanho = info.size - (sobra ?? 0);
    const cortado = de > 0;
    const bytesLidos = lidos;
    // A leitura INICIAL (cauda, para trás) não é o caminho do relógio de 700 ms: quem abre o
    // fluxo já paga um `contexto.doArquivo()` próprio junto do `sessao`. Medir aqui seria a
    // mesma conta duas vezes, então esta saída devolve `null` de propósito.
    return comContexto({ eventos, tamanho, cortado, bytesLidos }, null);
  } finally {
    await alca.close();
  }
}

module.exports = { trocasDeFora, arquivoDaSessao, eventosDoObjeto, lerConversa, linhasDoArquivo, BLOCO, ALVO_MENSAGENS, TETO_DURO };
