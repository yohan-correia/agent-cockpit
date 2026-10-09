'use strict';
// Cliente do Cockpit — JS puro, sem framework, sem build.
//
// Princípio que manda no arquivo: a tela NÃO guarda verdade. Ela desenha o que o servidor
// manda. Ao abrir uma conversa, recebe o histórico inteiro e depois os eventos ao vivo pelo
// mesmo canal (SSE). Por isso fechar o app, trocar de aparelho ou perder a rede não perde
// nada: nunca houve estado aqui para perder.
//
// Regra que vale para o arquivo inteiro: NADA de innerHTML. O texto desenhado aqui vem do
// agente e do conteúdo dos arquivos que ele leu — colar isso como HTML seria XSS
// auto-infligido. Todo nó nasce de createElement e todo texto entra por textContent.


const idiomaUI = globalThis.cockpitI18n;
const tr = (...args) => idiomaUI.t(...args);

const $ = (id) => document.getElementById(id);
const app = $('app');

let atual = null;      // chave do painel FOCADO (split view, fase 2 — nunca ler isto de um
                       // controle que se multiplica; ver a "regra do dono" no plano)
let fluxo = null;      // EventSource — um cano só, multiplexado por `?abas=`, compartilhado
                       // por todos os painéis (server.js, `/api/eventos`)

// Um painel por conversa aberta. Hoje nasce sempre um só (fase 2); a fase 3 é quem abre N.
// Guarda tanto os elementos DOM da conversa quanto o estado que antes era de módulo:
// `ocupado`, `perguntando`, `destinoFita`, `ultimaFala`, `ultimaHora`, `pendentes`,
// `grupoFerramentas`, `ferramentaSolta`, `desenhandoDeFora`, `catalogo`, `anexos`,
// `contexto`, `textoNaCaixa`, `historicoEntrada`, `posHistorico`, `rascunho`,
// `rolagemGuardada`.
const paineis = new Map();

// O texto e os anexos de um painel que saiu da tela numa TROCA de conjunto, sem o usuário ter
// pedido para fechá-lo (R28 da spec — split view, fase 3): `tirarPainel` grava aqui, e
// `criarPainel` devolve se a mesma chave voltar a abrir NESTA sessão. Recarregar a página
// descarta os órfãos, como tudo o mais (§4.5) — não é `localStorage`, é `Map` em memória.
const orfaos = new Map();

// Arrastar a aba para o split (D73): a linha da conversa na lateral vira origem de arrasto (só
// desktop) e a área dos painéis vira alvo com ZONAS por painel. Ver `alvoDoSolto` e os ouvintes
// de arrasto de ABA, ao lado dos de arquivo. Tipo PRÓPRIO no `dataTransfer` — é o que separa este
// arrasto do de anexo; nunca `text/plain` (soltar na caixa de escrita colaria a chave).
const TIPO_ARRASTO_ABA = 'application/x-cockpit-aba';
// Fração da largura do painel que conta como BORDA, de cada lado (S1 da spec). O resto é centro.
const FRACAO_BORDA = 0.25;
let arrastoAba = null;        // { chave, titulo } do arrasto em andamento NESTA página; null fora dele
let alvoDoArrasto = null;     // o alvo que o preview mostra agora (`alvoDoSolto`); null = nenhum
let repinturaAdiada = false;  // `desenharAbas` pedida no meio do arrasto (§3.7 da spec)

// Map(chave da aba → { texto, anexos }) — o ÚLTIMO envio recusado daquela aba, guardado
// INTEIRO (card menu-da-tui-do-codex-na-tela, R11). Um por aba: guardar de novo revoga as
// `objectURL` do par anterior. Só nesta sessão do navegador, como `orfaos` acima — F5 descarta.
const recusados = new Map();

/** Guarda o par recusado da aba, revogando `objectURL` do que estava guardado antes. */
function guardarRecusado(chave, texto, anexos) {
  const velho = recusados.get(chave);
  if (velho) for (const a of velho.anexos) if (a.url) URL.revokeObjectURL(a.url);
  recusados.set(chave, { texto, anexos });
}

/**
 * Devolve o par recusado INTEIRO para a caixa do painel, e só quando a composição está
 * VAZIA — é o que garante que ele nunca substitui o que o usuário escreveu depois, nem casa
 * texto antigo com anexo novo. Os dois únicos pontos de consumo: o `catch` do envio (quando o
 * selo bate) e `criarPainel`, depois do bloco de `orfaos` (órfão tem precedência).
 */
function restaurarRecusado(painel) {
  const guardado = recusados.get(painel.chave);
  if (!guardado) return false;
  if (painel.textoNaCaixa !== '' || painel.anexos.length) return false;   // composição ocupada
  recusados.delete(painel.chave);
  escreverNaCaixa(painel, guardado.texto);
  painel.anexos = guardado.anexos;
  desenharAnexos(painel);
  return true;
}

// O painel de quem está desenhando NA FITA agora — "a regra do dono" do plano. Só QUATRO
// funções escrevem `P`: `aplicarNoPainel` (1ª linha), `criarPainel`/`abrirAba` (antes de
// `limparFita`), `recarregarPainel`, e o helper `noPainel(painel, fn)` — usado por todo
// caminho FORA de `aplicarNoPainel` que ainda assim precisa desenhar na fita (uma bolha de
// erro depois de um `await`, por exemplo). Toda função que só DESENHA (bolha, blocoFerramenta,
// marcaDeCorte, os grupos de ferramenta...) lê `P` — nunca recebe painel por parâmetro; são
// chamadas de dentro de `aplicarNoPainel` ou de um `noPainel(...)` que já ajustou `P` antes.
let P = null;

/** Roda `fn` com `P` apontando para `painel`, e restaura o `P` de antes ao sair. */
function noPainel(painel, fn) {
  const anterior = P;
  P = painel;
  try {
    return fn();
  } finally {
    P = anterior;
  }
}

/** A fita "de verdade" (ou a rajada, fora da página) do painel que está sendo desenhado. */
function fitaDe(painel) {
  return painel.destinoFita || painel.fita;
}

/**
 * O dono ÚNICO do `.entrada.value` de um painel (R35 da spec). Atribuição programática não
 * dispara `input` — o ouvinte que mantém `painel.textoNaCaixa` em dia na digitação não vê
 * essas quatro escritas: `enviar()` limpando depois do envio, a paleta preenchendo o comando
 * escolhido, a navegação de histórico e o Escape restaurando o rascunho. As quatro passam
 * por aqui, que escreve o `.value` E o campo do painel juntos.
 *
 * Caixa de envio por painel (2026-09-09): a caixa é do PAINEL, não do módulo — sem `?.`
 * de propósito. Com `painel` nulo, `entrada.value = texto` estoura DENTRO de um handler
 * (o modo de morte silenciosa do risco R1 da spec); quem garante o painel é o chamador.
 */
function escreverNaCaixa(painel, texto, entrada = painel.entrada) {
  entrada.value = texto;
  painel.textoNaCaixa = texto;
  painel.seloComposicao += 1;
}

// As abas do terminal são a ÚNICA lista desde 21/08: o cockpit deixou de criar conversas
// próprias, por decisão de projeto. `atual` guarda a chave da aba (`aba-7`).
let abasDoTerminal = [];
// Map(chave da aba → títulos dos jobs do capitão rodando naquele projeto). Quem calcula o
// casamento é o servidor; aqui só se desenha a bolinha. Ver `atualizarFaixaJobs`.
let jobsPorAba = new Map();
// Os jobs `running` da última leitura de `/api/jobs` (M3/P4). Só isto — job TERMINADO não
// chega ao cliente (o servidor filtra por propósito), então "job rodando há Xmin" é o que dá
// para dizer sem inventar. Zerado junto com `jobsPorAba` em `semNoticiaDosJobs()`: sem
// notícia é ignorância, não "zero jobs".
let jobsRodando = [];
// Os ids `running` da última leitura BEM-SUCEDIDA de `api/jobs?tudo=1` — o "antes" da transição
// que avisa o Pra revisar (D76). `null` = ainda sem linha de base (boot). Ao contrário de
// `jobsRodando`, NÃO é zerado em `semNoticiaDosJobs()`: lá zerar diz "não sei"; aqui diria
// "todos terminaram", e cada queda de rede rodaria o git da tela Pra revisar (D60, #61).
let idsRodandoNaUltimaLeitura = null;

// ── Rede ────────────────────────────────────────────────────────────────
//
// O tailnet pode ter máquinas de terceiros, então o /api exige token. Ele chega uma
// vez pela URL (`?token=...`), fica no localStorage e some da barra de endereço — token
// em histórico de navegador é token vazado. O EventSource não aceita cabeçalho, então
// para o SSE ele vai na query mesmo; é o único jeito.

const CHAVE_TOKEN = 'cockpit-token';
let token = '';

try {
  const daUrl = new URL(location.href).searchParams.get('token');
  if (daUrl) {
    localStorage.setItem(CHAVE_TOKEN, daUrl);
    const limpa = new URL(location.href);
    limpa.searchParams.delete('token');
    history.replaceState(null, '', limpa.pathname + limpa.search + limpa.hash);
  }
  token = localStorage.getItem(CHAVE_TOKEN) || '';
} catch { /* modo privado: segue sem token e o servidor decide */ }

/** Junta o token na query — para o EventSource, que não tem como mandar cabeçalho. */
function comToken(rota) {
  if (!token) return rota;
  return `${rota}${rota.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

async function api(rota, opcoes = {}) {
  const cabecalhos = {};
  if (token) cabecalhos.authorization = `Bearer ${token}`;
  if (opcoes.corpo) cabecalhos['content-type'] = 'application/json';

  const resposta = await fetch(rota, {
    ...opcoes,
    headers: cabecalhos,
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  if (resposta.status === 401) {
    pedirToken();
    throw new Error(tr('token ausente ou inválido'));
  }
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = new Error(dados.erro || tr`falha ${resposta.status}`);
    // O status na exceção: a lista de aparelhos precisa distinguir 404 ("descadastrou no
    // meio", a linha diz e a lista fica) de erro de rede, e comparar a MENSAGEM do servidor
    // quebraria na primeira tradução. Quem lê: a lista de aparelhos (404) e
    // `carregarMaisHistorico` (409 = âncora morta, que não adianta retentar).
    erro.status = resposta.status;
    // `colado` é ADITIVO (card menu-da-tui-do-codex-na-tela, R11): ninguém o lia antes de
    // hoje. Este é o ÚNICO lugar onde `false` existe de verdade — o servidor só manda
    // `colado` ausente ou `true` (nunca `false`); aqui, ausente vira `false` porque é onde
    // o valor é consumido como condição.
    erro.colado = Boolean(dados.colado);
    // `parcial` (card pergunta-do-agente-em-cartao): o servidor avisa que ao menos uma tecla
    // da resposta do cartão JÁ saiu — o cartão abre o "ver terminal" para o usuário terminar.
    erro.parcial = Boolean(dados.parcial);
    throw erro;
  }
  return dados;
}

/**
 * O endereço completo, com token, para abrir noutro aparelho.
 *
 * Monta a partir do que a página já é: assim continua certo se o cockpit mudar de porta,
 * de domínio ou passar a viver sob /cockpit. Nada aqui é chumbado.
 */
function linkDeAcesso() {
  const base = `${location.origin}${location.pathname}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * Copia o link. `navigator.clipboard` exige contexto seguro e permissão — em HTTP nem
 * existe, e mesmo em HTTPS o navegador pode negar. Quando falha, o diálogo mostra o
 * endereço selecionado para copiar na mão, que é o ponto: nunca deixar o usuário sem saída.
 */
async function copiarAcesso(botao) {
  const link = linkDeAcesso();
  try {
    await navigator.clipboard.writeText(link);
    if (botao) {
      // P9: o botão virou linha com ícone + rótulo — escrever direto no botão apagaria os
      // dois. Quem guarda e restaura é só o span do rótulo (`#acesso-rotulo`).
      const rotulo = $('acesso-rotulo');
      const original = rotulo.textContent;
      idiomaUI.bind(rotulo, 'textContent', () => tr('copiado'));
      botao.dataset.feito = '1';
      setTimeout(() => { idiomaUI.bind(rotulo, 'textContent', () => tr(original)); delete botao.dataset.feito; }, 2000);
    }
    return true;
  } catch {
    mostrarAcesso();
    return false;
  }
}

function mostrarAcesso() {
  const campo = $('txt-acesso');
  campo.value = linkDeAcesso();
  $('dialogo-acesso').showModal();
  campo.focus();
  campo.select();
}

/** Sem token não há tela: em vez de uma lista vazia sem explicação, diz o que fazer. */
function pedirToken() {
  const dialogo = $('dialogo-token');
  if (!dialogo.open) dialogo.showModal();
}

const encurtarCaminho = (t) => String(t).replace(/^\/home\/[^/]+/, '~');

// ── Markdown ────────────────────────────────────────────────────────────
// Renderizador próprio, pequeno de propósito. Cobre o que um agente de fato escreve:
// blocos de código, títulos, listas, citação, tabela, e ênfase/código/link inline.
// O que não cobre cai como texto normal — degradar é melhor do que travar.

// A PRIMEIRA alternativa é a cerca de crase DUPLA, e ela vem antes da simples porque é a
// mais longa: é assim que o markdown mostra um trecho que CONTÉM crase, e é o que qualquer
// agente escreve numa tabela explicando markdown. Sem ela, ` `` `curl x` `` ` casava o par
// errado — crase, espaço, crase — e deixava o miolo solto no meio da frase. O buraco existia
// desde sempre; o autolink só o tornou visível, transformando o miolo solto em link (visto
// no celular em 24/08).
//
// A última alternativa é a URL escrita SOLTA no texto. Ela vem por último de propósito: em
// qualquer posição onde uma URL começa, nenhuma das outras pode casar (todas exigem crase,
// `*`, `_`, `~` ou `[`), e o `[` de um link markdown aparece ANTES do `http` dele na string —
// então `[rótulo](url)` continua ganhando sem precisar de ordem esperta.
//
// O detalhe que mais morde: o ÚLTIMO caractere não pode ser pontuação. Sem isso, "veja
// https://exemplo.../jobs." vira um link com o ponto final da frase dentro dele — link que
// não abre, e ninguém entende por quê. O preço é uma URL que termine legitimamente em `)`
// (as da Wikipédia) perder o parêntese; é o lado certo do erro para o que o agente escreve.
const INLINE = /(``[\s\S]+?``)|(`[^`]+`)|(\*\*[^*]+?\*\*)|(__[^_]+?__)|(\*[^*\n]+?\*)|(~~[^~]+?~~)|(\[[^\]\n]+\]\((?:<[^<>\n]+>|[^()\s]+)\))|((?:https?:\/\/|mailto:)[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}])/g;

/**
 * Trechos inline de uma linha, já como nós. Nunca devolve HTML em string.
 *
 * A regex é reinstanciada a cada chamada de propósito. `inline` chama a si mesma para o
 * conteúdo de **negrito**, e uma regex /g é um objeto com estado (`lastIndex`): compartilhar
 * a mesma instância entre a chamada de fora e a de dentro faz o cursor da externa voltar
 * ao zero quando a interna termina — laço infinito, que travou o gate na primeira execução.
 */
/**
 * O `<a>` da fala, com as travas que todo link daqui precisa.
 *
 * `javascript:` num href é execução de código, então só esquema conhecido vira link — a
 * checagem fica aqui e não em quem chama, para não haver dois lugares para esquecer dela.
 * Devolve `null` quando o esquema não serve, e aí quem chamou desenha texto puro.
 */
// A mesma cauda do ramo de URL solta da INLINE, mas ANCORADA nas duas pontas: aqui a
// string inteira precisa ser a URL, e não um pedaço dela no meio de outras palavras.
const URL_INTEIRA = /^(?:https?:\/\/|mailto:)[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]$/;

/**
 * Código inline que é SÓ uma URL: continua com cara de código, mas vira clicável.
 *
 * Agente escreve endereço entre crases o tempo todo, e a crase ganha do autolink na INLINE
 * — o endereço saía cinza e morto. No celular isso é sem saída: não há barra de endereço
 * para digitar à mão. O problema apareceu em 24/08 com um link de container.
 *
 * O `<code>` fica POR DENTRO do `<a>`: a cara de código é informação, quem escreveu quis
 * dizer "isto é literal". Some o cinza e some o aviso.
 *
 * Estrito de propósito — só quando o conteúdo INTEIRO é a URL. Em `curl https://ex.com/a`
 * o miolo continua código puro: adivinhar onde a URL termina dentro de um comando é errar
 * calado, e o gate guarda os dois casos.
 */
function codigoTalvezLink(texto) {
  const codigo = document.createElement('code');
  codigo.textContent = texto;
  if (!URL_INTEIRA.test(texto)) return { no: codigo, ehLink: false };
  const link = criarLink(texto, '');
  if (!link) return { no: codigo, ehLink: false };
  link.append(codigo);
  return { no: link, ehLink: true };
}

function criarLink(url, rotulo) {
  if (!/^(https?:|mailto:)/i.test(url)) return null;
  const no = document.createElement('a');
  no.href = url;
  no.target = '_blank';
  no.rel = 'noopener noreferrer';
  no.textContent = rotulo;
  return no;
}

function inline(texto, destino) {
  const re = new RegExp(INLINE.source, 'g');
  let cursor = 0;
  let achado;
  while ((achado = re.exec(texto)) !== null) {
    if (achado.index > cursor) destino.append(texto.slice(cursor, achado.index));
    const bruto = achado[0];
    let no;
    // Só os dois ramos de link acendem isto. `no.tagName` não serve de régua: o DOM de
    // mentira do gate não o tem, e o link pode acabar virando texto puro (esquema recusado).
    let ehLink = false;
    let caminhoLocal = null;
    if (bruto.startsWith('``')) {
      // Regra do CommonMark: um espaço de cada lado é afastamento da cerca, não conteúdo —
      // é o que deixa ` `` ` `` ` mostrar uma crase sozinha sem as duas colarem.
      ({ no, ehLink } = codigoTalvezLink(bruto.slice(2, -2).replace(/^ ([\s\S]*) $/, '$1')));
    } else if (bruto.startsWith('`')) {
      ({ no, ehLink } = codigoTalvezLink(bruto.slice(1, -1)));
    } else if (bruto.startsWith('**') || bruto.startsWith('__')) {
      no = document.createElement('strong');
      inline(bruto.slice(2, -2), no);
    } else if (bruto.startsWith('~~')) {
      no = document.createElement('del');
      inline(bruto.slice(2, -2), no);
    } else if (bruto.startsWith('*')) {
      no = document.createElement('em');
      inline(bruto.slice(1, -1), no);
    } else if (/^(https?:|mailto:)/i.test(bruto)) {
      // URL solta: o rótulo é ela mesma. Este ramo tem que vir ANTES do `else` de baixo —
      // lá o despacho assume link markdown e faz `indexOf('](')`, que numa URL solta devolve
      // -1 e pica a string em href e rótulo de mentira, calado.
      no = criarLink(bruto, bruto);
      ehLink = Boolean(no);
    } else {
      const corte = bruto.indexOf('](');
      const endereco = bruto.slice(corte + 2, -1).replace(/^<([\s\S]*)>$/, '$1');
      const rotulo = bruto.slice(1, corte);
      if (/^(?:\/(?!\/)|~\/)/.test(endereco)) {
        // Referência do Codex ao disco do servidor, não uma rota HTTP do Cockpit.
        caminhoLocal = endereco;
        no = document.createElement('code');
        const linha = endereco.match(/:\d+(?::\d+)?$/)?.[0] || '';
        no.textContent = rotulo + (linha && !rotulo.endsWith(linha) ? linha : '');
        no.title = endereco;
      } else {
        no = criarLink(endereco, rotulo);
        ehLink = Boolean(no);
      }
    }
    if (!no) no = document.createTextNode(bruto);
    destino.append(no);
    // Todo link ganha o botão de copiar do lado, e não só o `title` do navegador: no celular
    // não existe parar o mouse em cima (armadilha #31), e é justamente lá que o usuário lê. O
    // toque longo do Android já daria "copiar endereço", mas ninguém descobre toque longo.
    if (ehLink) {
      destino.append(botaoCopiar(() => no.href, tr`Copiar o endereço ${no.href}`,
        { classe: 'copiar-link', texto: '⧉', feito: '✓' }));
    }
    if (caminhoLocal) {
      destino.append(botaoCopiar(() => caminhoLocal, tr`Copiar caminho ${caminhoLocal}`,
        { classe: 'copiar-link', texto: '⧉', feito: '✓' }));
    }
    cursor = achado.index + bruto.length;
  }
  if (cursor < texto.length) destino.append(texto.slice(cursor));
}

/** Linhas de um parágrafo: quebra do agente é quebra na tela (ele escreve em blocos). */
function paragrafo(linhas) {
  const p = document.createElement('p');
  linhas.forEach((linha, i) => {
    if (i) p.append(document.createElement('br'));
    inline(linha, p);
  });
  return p;
}

/**
 * Botão de copiar. O texto vem de uma FUNÇÃO, não de uma string: a fala do agente cresce
 * enquanto o turno roda, e o que vale é o que estiver lá na hora do clique.
 *
 * `navigator.clipboard` exige contexto seguro e ainda pode ser negado pelo navegador.
 * Quando falha, o botão não mente: fica como estava, calado. Sem toast, sem biblioteca.
 */
function botaoCopiar(pegarTexto, rotulo, { classe = 'copiar', texto = 'copiar', feito = 'copiado' } = {}) {
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = classe;
  idiomaUI.bind(botao, 'textContent', () => tr(texto));
  idiomaUI.attr(botao, 'aria-label', () => tr(rotulo));
  botao.onclick = async () => {
    try {
      await navigator.clipboard.writeText(pegarTexto());
    } catch {
      return;
    }
    idiomaUI.bind(botao, 'textContent', () => tr(feito));
    botao.dataset.feito = '1';
    // A fala é redesenhada INTEIRA a cada pedaço do turno (ver o `case 'texto'`), então este
    // botão pode não existir mais quando o relógio bater. Não é problema: a escrita no
    // clipboard já aconteceu, e o nó novo nasce em 'copiar'. Nada de estado global para
    // "consertar" isso — seria guardar sujeira para um retorno de 1,5s.
    setTimeout(() => {
      idiomaUI.bind(botao, 'textContent', () => tr(texto));
      delete botao.dataset.feito;
    }, 1500);
  };
  return botao;
}

function blocoCodigo(linhas, lingua) {
  const caixa = document.createElement('div');
  caixa.className = 'bloco-codigo';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = linhas.join('\n');
  pre.append(code);
  caixa.append(pre);
  if (lingua) {
    const tag = document.createElement('span');
    tag.className = 'bloco-lingua';
    tag.textContent = lingua;
    caixa.append(tag);
  }
  // Copia SÓ este bloco, e o código como o agente escreveu — não o que a tela renderizou.
  caixa.append(botaoCopiar(() => code.textContent, lingua ? tr`Copiar o código em ${lingua}` : tr('Copiar o código')));
  return caixa;
}

const celulas = (linha) => linha.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function tabela(linhas) {
  const tab = document.createElement('table');
  const cabecalho = document.createElement('thead');
  const trCabecalho = document.createElement('tr');
  for (const texto of celulas(linhas[0])) {
    const th = document.createElement('th');
    inline(texto, th);
    trCabecalho.append(th);
  }
  cabecalho.append(trCabecalho);
  tab.append(cabecalho);

  const corpo = document.createElement('tbody');
  for (const linha of linhas.slice(2)) {
    const tr = document.createElement('tr');
    for (const texto of celulas(linha)) {
      const td = document.createElement('td');
      inline(texto, td);
      tr.append(td);
    }
    corpo.append(tr);
  }
  tab.append(corpo);

  const rolagem = document.createElement('div');
  rolagem.className = 'tabela-rolagem';
  rolagem.append(tab);
  return rolagem;
}

const CERCA = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const TITULO = /^\s{0,3}(#{1,6})\s+(.*)$/;
const REGUA = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM_LISTA = /^(\s*)[-*+]\s+(.*)$/;
const ITEM_NUM = /^(\s*)\d+[.)]\s+(.*)$/;
const CITACAO = /^\s{0,3}>\s?(.*)$/;
const SEPARADOR_TABELA = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** Texto markdown → nós dentro de `destino`. */
function markdown(texto, destino) {
  const linhas = String(texto).split('\n');
  let i = 0;
  let solto = [];

  const despejar = () => {
    if (solto.length) destino.append(paragrafo(solto));
    solto = [];
  };

  while (i < linhas.length) {
    const linha = linhas[i];
    const cerca = linha.match(CERCA);

    if (cerca) {
      despejar();
      const fecha = cerca[1][0];
      const corpo = [];
      i++;
      while (i < linhas.length && !(linhas[i].match(CERCA) || {})[1]?.startsWith(fecha)) {
        corpo.push(linhas[i]);
        i++;
      }
      i++; // consome a cerca de fechamento (ou passa do fim, se o turno foi cortado)
      destino.append(blocoCodigo(corpo, cerca[2]));
      continue;
    }

    if (!linha.trim()) { despejar(); i++; continue; }

    if (REGUA.test(linha)) {
      despejar();
      destino.append(document.createElement('hr'));
      i++;
      continue;
    }

    const titulo = linha.match(TITULO);
    if (titulo) {
      despejar();
      // h1/h2 do agente viram h3/h4: o <h1> da página é o título da conversa.
      const el = document.createElement(titulo[1].length <= 2 ? 'h3' : 'h4');
      inline(titulo[2], el);
      destino.append(el);
      i++;
      continue;
    }

    // Tabela GFM: cabeçalho + linha de separação. Sem a segunda linha, é parágrafo.
    if (linha.includes('|') && SEPARADOR_TABELA.test(linhas[i + 1] || '')) {
      despejar();
      const bloco = [linhas[i], linhas[i + 1]];
      i += 2;
      while (i < linhas.length && linhas[i].includes('|') && linhas[i].trim()) {
        bloco.push(linhas[i]);
        i++;
      }
      destino.append(tabela(bloco));
      continue;
    }

    if (ITEM_LISTA.test(linha) || ITEM_NUM.test(linha)) {
      despejar();
      const numerada = !ITEM_LISTA.test(linha);
      const lista = document.createElement(numerada ? 'ol' : 'ul');
      while (i < linhas.length) {
        const item = linhas[i].match(numerada ? ITEM_NUM : ITEM_LISTA);
        if (!item) {
          // Continuação recuada do item anterior pertence a ele, não a um item novo.
          if (lista.lastChild && /^\s{2,}\S/.test(linhas[i])) {
            lista.lastChild.append(document.createElement('br'));
            inline(linhas[i].trim(), lista.lastChild);
            i++;
            continue;
          }
          break;
        }
        const li = document.createElement('li');
        inline(item[2], li);
        lista.append(li);
        i++;
      }
      destino.append(lista);
      continue;
    }

    const citacao = linha.match(CITACAO);
    if (citacao) {
      despejar();
      const bloco = document.createElement('blockquote');
      const dentro = [];
      while (i < linhas.length && CITACAO.test(linhas[i])) {
        dentro.push(linhas[i].match(CITACAO)[1]);
        i++;
      }
      markdown(dentro.join('\n'), bloco);
      destino.append(bloco);
      continue;
    }

    solto.push(linha);
    i++;
  }
  despejar();
}

// ── Abas do terminal ────────────────────────────────────────────────────
// As conversas que já estão abertas no tmux do usuário. O cockpit não as criou e não as
// encerra: lê o histórico do arquivo do CLI e digita na aba viva. Ver lib/abas.js.

// ── Lido e "te esperando" ───────────────────────────────────────────────
//
// A marca é por `sessaoId`, NÃO pela chave da aba: `aba-7` vem do window_id do tmux e
// muda quando a aba é fechada e reaberta, mas a conversa continua a mesma. Desde 14/09
// (D53) o carimbo mora no SERVIDOR, não no aparelho: o dono usa celular e desktop no
// mesmo dia, e ler numa ponta tem de apagar o destaque na outra. `aba.lidoEm` chega pronto
// dentro de cada aba, no `GET /api/abas` (o tique de 5s já busca) — não há mapa nem chave
// própria no cliente para isso.

/**
 * Marca a conversa desta aba como lida ATÉ o ponto em que o servidor a conhece.
 *
 * Dois lugares chamam: ao ABRIR a aba, e no `turno_fim` com ela aberta na tela — você está
 * olhando, então não faz sentido a lista dizer que a conversa te espera.
 *
 * O carimbo é o `atualizadoEm` que a aba TINHA neste instante, não `Date.now()`. O relógio
 * do aparelho não entra na conta: a comparação lá embaixo é contra `atualizadoEm`, que é do
 * SERVIDOR, e misturar os dois relógios fazia o "te esperando" mentir sozinho. Celular
 * atrasado gravava um número menor que o do servidor e a aba voltava a te esperar assim que
 * a lista batia de novo; adiantado, o oposto — nunca mais te esperava. Quem usa pode estar
 * viajando, então "o aparelho está no mesmo relógio do servidor" não é suposição que se possa
 * fazer.
 *
 * `quando` explícito continua valendo (o gate usa), mas ninguém no cliente passa hora.
 *
 * Sem `atualizadoEm` (aba que ainda não tem arquivo de conversa) não há o que comparar:
 * a marca fica como estava. Gravar 0 aqui carimbaria "lida" numa conversa nunca lida.
 *
 * Esta função existiu, morreu no corte das 513 linhas de 21/08 e a CHAMADA no `turno_fim`
 * ficou: o evento estourava ReferenceError ANTES de fechar os cartões de ferramenta e de
 * reabilitar o Enviar, e o botão ficava travado até reabrir a aba.
 */
function marcarLido(chave, quando) {
  const aba = abasDoTerminal.find((a) => a.chave === chave);
  if (!aba || !aba.sessaoId) return;
  const carimbo = quando === undefined ? aba.atualizadoEm : quando;
  if (!carimbo) return;
  // Já lida até aqui: não há o que dizer ao servidor. Esta linha é o que segura o volume —
  // `turno_fim` chama esta função para TODAS as abas abertas, e a aba parada repete o mesmo
  // carimbo em cada turno. Sem ela sai um POST por painel por turno, e cada POST é um
  // `tmp+rename` no disco do servidor.
  if (Number(aba.lidoEm || 0) >= carimbo) return;
  // Otimista: a tela responde AGORA, com o número que o servidor acabou de mandar. Esperar
  // o POST voltar deixaria o `◆` aceso por um ida-e-volta na conversa que ele está abrindo.
  aba.lidoEm = carimbo;
  api('api/lidas', { method: 'POST', corpo: { sessaoId: aba.sessaoId, carimbo } })
    .catch(() => { /* Servidor fora, ou POST recusado: a marca vale até a próxima batida da
                      lista, que traz o `lidoEm` do servidor e apaga esta. E é o certo — desde
                      a D53 a fonte é o servidor, e marca que só vive no aparelho é exatamente
                      o que este card veio matar. Degrada (um `◆` que volta), não quebra. */ });
  desenharAbas();
}

async function carregarAbas() {
  try {
    const { abas } = await api('api/abas');
    abasDoTerminal = abas || [];
  } catch {
    abasDoTerminal = [];   // sem tmux, sem abas. Não é erro de tela.
  }
  desenharAbas();
}

/**
 * A última mexida desta conversa, no formato mais curto que ainda diz a verdade:
 * **hoje só a hora (`14:32`), outro dia só o dia (`19/08`)**.
 *
 * O porquê do formato: cinco caracteres nos dois casos, então a linha da lista não muda de
 * largura conforme o dia vira, e é o que cabe no celular ao lado do caminho e do estado.
 * Data por extenso ("19 de agosto") não cabe; "há 5 minutos" precisaria de um relógio só
 * para se reescrever, e a D21 diz que aqui só existe um. Dia-da-semana ("ter 14:32") não
 * serve porque some a partir de uma semana atrás — o `dd/mm` vale para qualquer idade.
 *
 * `atualizadoEm` nulo (aba sem arquivo de conversa ainda) devolve '' e a tela não desenha
 * nada: placeholder de "—" seria ruído numa linha que já tem cinco sinais.
 */
function quandoCurto(ms) {
  if (!ms) return '';
  const data = new Date(ms);
  if (Number.isNaN(data.getTime())) return '';
  const agora = new Date();
  const hoje = data.getFullYear() === agora.getFullYear()
    && data.getMonth() === agora.getMonth()
    && data.getDate() === agora.getDate();
  return hoje
    ? data.toLocaleTimeString(idiomaUI.idioma, { hour: '2-digit', minute: '2-digit' })
    : data.toLocaleDateString(idiomaUI.idioma, { day: '2-digit', month: '2-digit' });
}

/**
 * Os cinco booleanos que a linha da lista lê, numa função pura — a ordenação (Fase 2) e a linha
 * usam os MESMOS. `pendente` é "esta aba está parada por minha causa?": pergunta aberta ou
 * resposta que você ainda não leu. `●` (trabalhando) NÃO é pendente — ele não espera por você.
 */
function estadoDaAba(aba) {
  // O cockpit passou a ter mais de um agente, e `temClaude` virou LEGADO: ele diz "é
  // claude", não "tem alguém rodando". Uma aba de Codex tem `temClaude: false` e
  // `temAgente: true` — sem esta linha ela nasceria visualmente QUEBRADA em nove pontos
  // da lista, com pino de "fechado", linha apagada e bolha de erro.
  //
  // O `??` é obrigatório: mais de dez fixtures do gate montam abas só com `temClaude`, e
  // trocar direto reprovaria todos eles por uma mudança que não é sobre nenhum.
  const temAgente = aba.temAgente ?? aba.temClaude;
  // "Te esperando" é o arquivo da conversa ter mexido DEPOIS da última vez que você
  // abriu ela aqui. Aba sem agente não entra na conta: não há conversa viva ali.
  const esperando = Boolean(temAgente && !aba.rodando && aba.atualizadoEm
    && aba.atualizadoEm > (aba.lidoEm || 0));
  // Estado PRÓPRIO, e diferente de "te esperando": o terminal abriu um menu e não anda
  // sem alguém escolher. Vem do CLI (`status: waiting`), não de heurística — e é o que
  // fazia a aba parecer livre enquanto o Claude estava parado esperando resposta.
  //
  // O `preSessao` entra no MESMO sinal porque a lista responde a uma pergunta só: "esta
  // aba está parada por minha causa?". No prompt de confiança de pasta nova está, e ela
  // aparecia com o `✓` de conversa lida — o pior sinal possível, porque diz "tudo em dia".
  const pergunta = Boolean(aba.esperando) || Boolean(aba.preSessao);
  // Os ~1,6 s entre "criei a aba" e "o CLI escreveu o arquivo de sessão". Os dois só
  // valem sem agente: `temAgente` ganha de tudo, senão o `nascendo` viraria buraco na
  // trava da #6. Nunca verdadeiros juntos — quem garante é a máquina de estados do
  // servidor —, e o `&&` aqui é o que faz a tela mostrar UM só mesmo se ela falhar.
  const abrindo = Boolean(!temAgente && aba.nascendo);
  const naoSubiu = Boolean(!temAgente && !abrindo && aba.falhou);
  return { temAgente, esperando, pergunta, abrindo, naoSubiu, pendente: pergunta || esperando };
}

function desenharAbas() {
  // Repintar no meio de um arrasto tiraria do DOM a linha que está sendo arrastada — e nó de
  // origem removido não recebe `dragend` (#91): o preview ficaria pendurado depois de um Esc. Os
  // dados continuam chegando no ciclo de 5 s; só a pintura espera o gesto acabar
  // (`encerrarArrasto` repinta).
  if (arrastoAba) { repinturaAdiada = true; return; }
  const alvo = $('abas');
  const rolagem = alvo.scrollTop;   // como hoje: a repintura preserva a posição DESTA vista
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  app.dataset.listaVista = vistaDaLateral;
  idiomaUI.bind($('titulo-lista'), 'textContent', () => (vistaDaLateral === 'agentes' ? tr('agentes')
    : vistaDaLateral === 'leituras' ? tr('leituras') : `${tr('conversas')} · ${abasDoTerminal.length}`));

  if (vistaDaLateral === 'leituras') {
    alvo.append(grupoDeLeituras());
  } else if (vistaDaLateral === 'agentes') {
    const g = grupoDeJobs();
    if (g) alvo.append(g);
    else {
      // A vista É a lista agora: sem esta linha o #abas fica em branco sob o título `agentes`.
      // "na janela" e não "nenhum agente": done/merged/teardown saem da vista em 1h
      // (JANELA_FIM_FELIZ_MS) — dizer "nenhum agente" afirmaria que nada rodou hoje.
      const p = document.createElement('p');
      p.className = 'lista-vazia';
      idiomaUI.bind(p, 'textContent', () => tr('nenhum agente na janela'));
      alvo.append(p);
    }
  } else if (!abasDoTerminal.length) {
    // O aviso fala de abas — não é pintado na vista de agentes.
    const p = document.createElement('p');
    p.className = 'lista-vazia';
    idiomaUI.bind(p, 'textContent', () => tr('Nenhuma aba aberta no seu terminal.'));
    alvo.append(p);
  } else {
  const lista = document.createElement('section');
  lista.id = 'lista-conversas';
  // D69: a ordem é `terminouEm` — a hora em que o último turno terminou, do servidor —, mais
  // recente primeiro. Só o fim de um turno move uma conversa: abrir, enviar e Alt+J/K não movem, e
  // a ● fica onde o turno anterior a deixou. Nulo conta como 0 e vai para o fim; empate fica na
  // ordem do tmux — o sort é estável.
  const ordenadas = abasDoTerminal
    .map((aba) => ({ aba, estado: estadoDaAba(aba) }))
    .sort((a, b) => (b.aba.terminouEm || 0) - (a.aba.terminouEm || 0));

  for (const { aba, estado: { temAgente, esperando, pergunta, abrindo, naoSubiu } } of ordenadas) {

    const linha = document.createElement('div');
    linha.className = 'conversa-linha';
    linha.dataset.estado = aba.rodando ? 'trabalhando' : 'pronta';
    if (!temAgente) linha.dataset.semClaude = '1';
    if (pergunta) linha.dataset.perguntando = '1';
    else if (esperando) linha.dataset.esperando = '1';
    // Split view, fase 3 (R9 da spec): com N painéis, uma aba pode estar ABERTA sem ser a
    // FOCADA — o `aria-current` já diz quem tem o foco; isto diz quais outras já têm painel
    // na tela, para não clicar de novo achando que vai abrir uma segunda vez.
    if (aba.chave !== atual && paineis.has(aba.chave)) linha.dataset.aberta = '1';

    const botao = document.createElement('button');
    botao.className = 'conversa';
    botao.dataset.chave = aba.chave;
    botao.setAttribute('aria-current', String(aba.chave === atual));

    const titulo = document.createElement('div');
    titulo.className = 'conversa-titulo';
    const pino = document.createElement('span');
    pino.className = 'conversa-pino';
    // SEIS sinais, nesta ordem de urgência: esperando você · trabalhando · abrindo ·
    // claude fechado · te esperando · lida. A ORDEM da lista é outra conversa (D69: a hora em que o
    // último turno terminou) — o pino diz o estado, a posição diz a urgência. O `?` vem primeiro porque é o único estado em que a conversa
    // está parada por sua causa: ninguém mais vai destravá-la.
    //
    // O `⋯` entra entre o `●` e o `○` e NÃO ganha cor própria: é estado de ~1,6 s, e uma
    // variável a mais nos dez blocos de tema não paga (#29). Herda a do `○`.
    pino.textContent = `${pergunta ? '?' : (aba.rodando ? '●' : (abrindo ? '⋯' : (!temAgente ? '○' : (esperando ? '◆' : '✓'))))} `;
    idiomaUI.bind(pino, 'title', () => tr(pergunta
      ? (aba.preSessao && !aba.esperando
        ? tr('o agente está pedindo uma confirmação no terminal e ainda não abriu conversa')
        : tr('o terminal está com uma pergunta aberta e parou esperando você escolher'))
      : (abrindo
        ? tr('o agente ainda está subindo nesta aba')
        : (naoSubiu
          ? tr('o agente não subiu nesta aba — ela ficou como um terminal comum')
          : (!temAgente
            ? tr('esta aba não tem agente rodando — dá para ler, não para enviar')
            : (aba.rodando ? tr('trabalhando agora')
              : (esperando ? tr('mexeu depois da última vez que você abriu') : tr('você já leu esta conversa'))))))));
    const nome = document.createElement('span');
    nome.className = 'conversa-nome';
    nome.textContent = aba.titulo;
    // O CSS corta o nome comprido em reticências (uma linha só); o inteiro fica aqui.
    nome.title = aba.titulo;
    titulo.append(pino, nome);

    // O CHIP do agente. Ele entrou nesta entrega porque a chave virou por PANE: a janela do
    // Projeto-a passou a render DUAS linhas, as duas com o mesmo `window_name` ("Projeto-a"),
    // mesmo pino e mesmo estado possível — indistinguíveis sem ele.
    //
    // Aparece SEMPRE que há agente, não só quando há duas na mesma janela: regra condicional
    // na tela é regra que ninguém entende, e a lista muda de composição a cada refresh.
    // Reusa `var(--texto-2)`, que já existe nos dez blocos de tema — variável nova teria que
    // entrar nos dez (#29) e um chip não paga esse custo. E é conteúdo de verdade no DOM,
    // não `title`: tooltip não aparece em toque (#31).
    if (aba.agente) {
      const chip = document.createElement('span');
      chip.className = 'conversa-agente';
      chip.dataset.agente = aba.agente;
      chip.textContent = aba.agente;
      titulo.append(chip);
    }

    // Job do capitão rodando no projeto desta aba. Bolinha e title, nada mais: é
    // informação de canto de olho, e a faixa do topo é quem conta a história inteira.
    const comJob = jobsPorAba.get(aba.chave);
    if (comJob && comJob.length) {
      const marca = document.createElement('span');
      marca.className = 'conversa-job';
      marca.textContent = ' •';
      idiomaUI.bind(marca, 'title', () => tr(comJob.length === 1
        ? tr`job rodando: ${comJob[0]}`
        : tr`${comJob.length} jobs rodando: ${comJob.join(', ')}`));
      titulo.append(marca);
    }

    // Quando esta conversa mexeu pela última vez. Sai do `atualizadoEm` que a lista JÁ
    // recebe (mtime do .jsonl) — sem leitura de disco nova, sem rota nova, sem relógio
    // novo: quem atualiza é o mesmo ciclo de 5s da lista (D21). Desde D63 ela é o ÚLTIMO
    // item da 1ª linha, à direita; quem encolhe primeiro quando aperta é o nome.
    // Sem `atualizadoEm` não há placeholder — a marca simplesmente não existe.
    const marcaHora = quandoCurto(aba.atualizadoEm);
    if (marcaHora) {
      const hora = document.createElement('time');
      hora.className = 'conversa-hora';
      hora.setAttribute('datetime', new Date(aba.atualizadoEm).toISOString());
      hora.textContent = marcaHora;
      titulo.append(hora);
    }
    botao.append(titulo);

    // A 2ª linha só existe quando há algo a dizer (D63). "no terminal" e "agente fechado"
    // saíram: o ✓ e o ○ já dizem isso, e repetir em palavras era o que empurrava a lista
    // para 6 por tela no celular. O aviso é escolhido UMA vez; o `bind` só traduz.
    const aviso = pergunta ? 'esperando você escolher'
      : (temAgente
        ? (aba.rodando ? 'trabalhando' : (esperando ? 'te esperando' : null))
        : (abrindo ? 'abrindo o agente…' : (naoSubiu ? 'o agente não subiu' : null)));
    if (aviso) {
      const rodape = document.createElement('div');
      rodape.className = 'conversa-rodape';
      const estado = document.createElement('span');
      estado.className = 'conversa-estado';
      idiomaUI.bind(estado, 'textContent', () => tr(aviso));
      rodape.append(estado);
      botao.append(rodape);
    }
    botao.onclick = (evento) => {
      // O clique FANTASMA: terminado o arrasto de puxar para atualizar, o navegador ainda
      // dispara um `click` no que estava debaixo do dedo. Sem esta carência, puxar a lista
      // para baixo abria uma conversa sozinha. Ver `PUXAR_CARENCIA`.
      if (Date.now() < toqueBloqueadoAte) return;
      // Ctrl/Cmd+clique ABRE AO LADO (§3.2 do plano do split view) — gesto deliberado, do
      // desktop. `evento` pode faltar (o gate chama `botao.onclick()` na mão para simular o
      // clique fantasma): sem ele, é clique normal.
      const aoLado = Boolean(evento && (evento.ctrlKey || evento.metaKey));
      abrirAba(aba.chave, aoLado ? { aoLado: true } : undefined);
    };
    // Clique do MEIO — a versão de mouse do Ctrl+clique, sem precisar da tecla.
    botao.addEventListener('auxclick', (evento) => {
      if (evento.button !== 1) return;
      abrirAba(aba.chave, { aoLado: true });
    });
    // Arrastar a linha para a área dos painéis (D73): borda de um painel abre ao lado dele, centro
    // troca a conversa dele. Só desktop — no celular o atributo nem existe, e um long-press do
    // Android não vira arrasto. Perguntado a cada repintura (D30), nunca no boot.
    botao.draggable = !matchMedia('(max-width: 760px)').matches;
    botao.addEventListener('dragstart', (evento) => {
      // A janela pode ter estreitado entre a repintura e o gesto.
      if (matchMedia('(max-width: 760px)').matches) { evento.preventDefault(); return; }
      arrastoAba = { chave: aba.chave, titulo: aba.titulo };
      evento.dataTransfer.setData(TIPO_ARRASTO_ABA, aba.chave);
      evento.dataTransfer.effectAllowed = 'move';
    });
    botao.addEventListener('dragend', () => encerrarArrasto());
    linha.append(botao);

    // ⧉ — a versão DESCOBRÍVEL do Ctrl+clique (§3.2 do plano): sem ela, "abrir ao lado"
    // só existiria escondido atrás de um modificador de teclado, e recurso que só vive
    // assim é recurso que não foi entregue. `display: none` por padrão (CSS) — só aparece
    // no hover/foco da linha, e só no desktop (some no celular, onde não há split).
    const abrirAoLado = document.createElement('button');
    abrirAoLado.className = 'abrir-ao-lado';
    abrirAoLado.type = 'button';
    idiomaUI.bind(abrirAoLado, 'title', () => tr('Abrir ao lado (Ctrl+clique)'));
    idiomaUI.attr(abrirAoLado, 'aria-label', () => tr('Abrir ao lado (Ctrl+clique)'));
    abrirAoLado.textContent = '⧉';
    abrirAoLado.onclick = (evento) => {
      // Sem isto o clique vazaria para `botao` (que é o alvo por baixo) e trocaria o
      // conjunto inteiro em vez de acrescentar — o oposto do que o botão promete.
      evento?.stopPropagation?.();
      abrirAba(aba.chave, { aoLado: true });
    };
    linha.append(abrirAoLado);

    // ✎ — renomear a aba (card `renomear-a-aba`, decisão de 11/09): um lápis ao lado do nome.
    // Irmão do `.conversa`, como o ⧉: botão dentro de botão é HTML inválido. Com mouse o CSS o
    // esconde até o hover da linha; no toque ele fica sempre à vista (`estilo.css`, `.renomear-aba`).
    const renomear = document.createElement('button');
    renomear.className = 'renomear-aba';
    renomear.type = 'button';
    renomear.setAttribute('aria-haspopup', 'dialog');
    idiomaUI.bind(renomear, 'title', () => tr('Renomear a aba'));
    idiomaUI.attr(renomear, 'aria-label', () => tr('Renomear a aba'));
    renomear.append(iconeContorno('icone-botao', 'M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z', 'M13.5 6.5l3 3'));
    renomear.onclick = (evento) => {
      evento?.stopPropagation?.();
      // A mesma carência do cartão (`botao.onclick`, acima): no toque o ✎ está SEMPRE à vista, e
      // o clique fantasma do fim do puxar-para-atualizar o acharia sem esta linha.
      if (Date.now() < toqueBloqueadoAte) return;
      abrirRenomear(aba);
    };
    linha.append(renomear);
    lista.append(linha);
  }
  alvo.append(lista);
  }

  pintarFiltroDeLeituras();   // roda em toda vista — é ela quem ESCONDE fora de leituras
  alvo.scrollTop = rolagem;   // quem troca de vista é trocarVistaDaLateral, não aqui (passo 2.2)
  pintarResumoVazio();
  pintarBarraDeAgentes();
  pintarBarraDeLeituras();
}

/**
 * M3 (04/09): o resumo de relance na tela vazia — o que já dá para saber sem abrir nada. As
 * contagens usam o MESMO critério de `desenharAbas()` (rodando / te esperando), então nunca
 * divergem do que a lista já mostra. O terceiro pedaço (job rodando) só aparece quando HÁ
 * job — job terminado não chega ao cliente (P4), então "último job há Xmin" não dá para
 * dizer sem mexer no server.js. Chamada única (um dono só) por `desenharAbas()` e por
 * `atualizarFaixaJobs()`, os dois lugares que mexem no que ela mostra.
 */
function pintarResumoVazio() {
  const alvo = $('vazio-resumo');
  if (!abasDoTerminal.length) { idiomaUI.bind(alvo, 'textContent', () => tr('')); return; }
  const trabalhando = abasDoTerminal.filter((a) => a.rodando).length;
  const teEsperando = abasDoTerminal.filter((a) => {
    const temAgente = a.temAgente ?? a.temClaude;
    return Boolean(temAgente && !a.rodando && a.atualizadoEm && a.atualizadoEm > (a.lidoEm || 0));
  }).length;
  const partes = [tr`${trabalhando} trabalhando`, tr`${teEsperando} te esperando`];
  if (jobsRodando.length) {
    const desde = jobsRodando[0].desde;
    const rotuloJob = jobsRodando.length === 1 ? tr('job rodando') : tr('jobs rodando');
    partes.push(`${jobsRodando.length} ${rotuloJob} ${haQuantoTempo(desde)}`);
  }
  idiomaUI.bind(alvo, 'textContent', () => tr(partes.join(' · ')));
}

/** Só escreve quando o TEXTO muda. `bind` recria o nó de texto, e o aria-live do aviso
 *  reanunciaria a cada 5s com a mesma frase. `calcular` lê o estado de módulo (não locais),
 *  para que um registro antigo continue devolvendo o valor certo na troca de idioma. */
function pintarRotulo(el, calcular) {
  if (el.textContent !== calcular()) idiomaUI.bind(el, 'textContent', calcular);
}

/**
 * A barra fina no rodapé da lateral (§2.2 da spec): o contador de agentes precisa estar à
 * vista nas DUAS vistas, senão a barra some justo quando ela seria mais útil. Chamada de um
 * lugar só, o fim de `desenharAbas()` — como `pintarResumoVazio()`, ao lado.
 */
function pintarBarraDeAgentes() {
  const barra = $('barra-agentes');
  // `null` é ignorância (ainda não li o painel nenhuma vez): não afirmar nada (§4.6 da D49).
  barra.hidden = painelDosJobs === null;
  if (barra.hidden) return;
  barra.setAttribute('aria-pressed', String(vistaDaLateral === 'agentes'));

  const nomeEl = $('barra-agentes-nome');
  const avisoEl = $('barra-agentes-aviso');
  const trabalhoEl = $('barra-agentes-trabalho');

  // A barra diz para ONDE o clique leva, não onde você está (o dono, 14/09): na vista de
  // agentes ela é a porta de volta, e mostrar "agentes · 12" ali seria o rótulo do que já
  // está na tela. O contador e o aviso ficam para a vista de conversas, que é onde eles
  // denunciam algo invisível — na vista de agentes o travado está à vista, na própria lista.
  const naVistaDeAgentes = vistaDaLateral === 'agentes';

  pintarRotulo(nomeEl, () => (naVistaDeAgentes
    ? tr('conversas')
    : (painelDosJobs === false
      ? tr('agentes')
      : `${tr('agentes')} · ${jobsDaLista.length}`)));

  // Travado = blocked + orfao (§4.8 da spec da D49): os dois estados que exigem AÇÃO. Um
  // rótulo por vez, travado ganha de rodando.
  pintarRotulo(avisoEl, () => (naVistaDeAgentes ? '' : tr(painelDosJobs === false
    ? tr('sem contato com o painel')
    : (() => {
      const travados = jobsDaLista.filter((j) => j.estado === 'blocked' || j.estado === 'orfao').length;
      return travados ? `${travados} ${travados === 1 ? tr('travado') : tr('travados')}` : '';
    })())));

  pintarRotulo(trabalhoEl, () => (naVistaDeAgentes ? '' : tr((() => {
    if (painelDosJobs === false) return '';
    const travados = jobsDaLista.filter((j) => j.estado === 'blocked' || j.estado === 'orfao').length;
    const rodando = jobsDaLista.filter((j) => j.estado === 'running').length;
    return (!travados && rodando) ? tr`${rodando} rodando` : '';
  })())));
}

/**
 * A barra de leituras (D59): função PRÓPRIA, não dentro de `pintarBarraDeAgentes` — ela sai
 * cedo com `painelDosJobs === null` (acima), e a barra de leituras ficaria sem texto até o
 * painel responder. `#barra-leituras` nunca fica `hidden` — não depende do painel de jobs.
 */
function pintarBarraDeLeituras() {
  const naVista = vistaDaLateral === 'leituras';
  $('barra-leituras').setAttribute('aria-pressed', String(naVista));
  pintarRotulo($('barra-leituras-nome'), () => tr(naVista ? 'conversas' : 'leituras'));
}

// ── O painel de uma conversa ─────────────────────────────────────────────
//
// `criarPainel` monta a árvore que morava em `.chat-topo`/`.mensagens` no `index.html` antes
// da fase 2 do split view (docs/superpowers/plans/2026-09-08-split-view-plano.md). Nasce por
// `createElement` — nunca `innerHTML` (regra do arquivo inteiro) — e SEM `id` em nenhum
// elemento (R17 da spec): só `className`, com a mesma palavra do id de ontem. É o que deixa o
// `porIdDe` do gate achar cada peça sem duplicar `getElementById`, e o que evita que N
// painéis com `id="fita"` façam `getElementById` devolver sempre o primeiro.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Um nó SVG — `createElementNS`, nunca `innerHTML`. */
function noSvg(tag, atributos) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const nome in atributos) el.setAttribute(nome, atributos[nome]);
  return el;
}

/** Os ícones de contorno do cabeçalho (←, ↻, ✕) — os MESMOS `<svg>` que saíram do HTML. */
function iconeContorno(classe, ...caminhos) {
  const svg = noSvg('svg', {
    class: classe, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  });
  for (const d of caminhos) svg.append(noSvg('path', { d }));
  return svg;
}

/** O quadrado do Parar — preenchido, sem contorno. */
function iconeParar() {
  const svg = noSvg('svg', {
    class: 'icone-parar', viewBox: '0 0 24 24', fill: 'currentColor',
    'aria-hidden': 'true', focusable: 'false',
  });
  svg.append(noSvg('rect', { x: '6', y: '6', width: '12', height: '12', rx: '1' }));
  return svg;
}

// O `<dialog>` de matar aba é UM só, compartilhado — o `✕` de CADA painel grava aqui qual
// deles pediu (R17 da spec). `matarAba()` lê daqui, nunca de `atual`.
let painelPedindoMorte = null;

// O `<dialog>` de renomear também é UM só, compartilhado pelas linhas da lista (card
// `renomear-a-aba`). Cada toque no ✎ grava aqui um objeto NOVO — `{ chave }` —, e é a IDENTIDADE
// dele, não a chave, que diz à resposta de um `PATCH` se a edição dela ainda é a que está na tela:
// salvar A, cancelar e abrir B não pode deixar a resposta de A fechar B.
let edicaoDoNome = null;
// Duas guardas contra resposta fora de ordem, cada uma com a SUA pergunta:
//  - `aplicadoPorChave`: o número do envio MAIS NOVO que já teve SUCESSO em cada aba. Um sucesso
//    só escreve o nome devolvido no cabeçalho se for mais novo que ele — salvar a mesma aba duas
//    vezes com as respostas invertidas não deixa o nome da primeira por cima. Recusa não entra na
//    conta (um 2º Salvar recusado não impede o 1º, que deu certo, de aparecer), e é por CHAVE (um
//    envio em B não mexe na régua de A). O servidor aplica os PATCH de uma aba na ordem em que
//    chegam (fila por aba), então "mais novo no envio" é "o que ficou no tmux";
//  - `leituraDoNome`: quantas leituras de lista um rename BEM-SUCEDIDO já pediu. Só a mais recente
//    copia os títulos da lista para os cabeçalhos: se A e B forem renomeadas em sequência, a lista
//    pedida por A pode chegar DEPOIS da de B, com o nome velho de B. Recusa não pede leitura.
let enviosDoNome = 0;
const aplicadoPorChave = new Map();
let leituraDoNome = 0;

/**
 * Monta o painel de uma conversa. Devolve o objeto com os elementos e o estado que hoje era
 * de módulo — os handlers são ligados AQUI, no closure, e é isso que faz a "regra do dono"
 * (§4.7 da spec) valer: o `✕`, o `Parar`, o `↻`, o `←`, as seis teclas e o clique no medidor
 * deste painel só podem mexer NESTE painel, nunca em `atual`.
 */
function criarPainel(chave, info) {
  // O prefixo `job-` (§7.1) já é a declaração de tipo — `trocarConjunto` (abaixo) monta o
  // `info` a partir de `abasDoTerminal`, que nunca tem job dentro, então o tipo não pode
  // viajar por ali. A CHAVE é o tipo, sempre.
  const tipo = chave.startsWith('job-') ? 'job' : 'aba';
  const raiz = document.createElement('div');
  raiz.className = 'painel';
  // Gravado no elemento também, para o CSS e o smoke poderem ver — mesma forma do conserto
  // de 08/09 (hoje `#lista-conversas`): atributo que só o lugar carrega.
  raiz.dataset.tipo = tipo;
  // A chave no elemento (D73): o arrasto, o gate e o print leem a ordem dos painéis pela tela.
  raiz.dataset.chave = chave;

  // ── .chat-topo ──────────────────────────────────────────────────────
  const topo = document.createElement('div');
  topo.className = 'chat-topo';

  const voltar = document.createElement('button');
  voltar.className = 'voltar btn-voltar';
  idiomaUI.attr(voltar, 'aria-label', () => tr('Voltar para a lista'));
  voltar.append(iconeContorno('icone-botao', 'M19 12H5M11 18l-6-6 6-6'));
  voltar.onclick = pedirLista;

  const identidade = document.createElement('div');
  identidade.className = 'chat-identidade';
  const nomeLinha = document.createElement('div');
  nomeLinha.className = 'chat-nome';
  const titulo = document.createElement('h1');
  titulo.className = 'chat-titulo';
  titulo.textContent = '.';
  const agente = document.createElement('span');
  agente.className = 'conversa-agente chat-agente';
  agente.textContent = info?.agente || '';
  agente.dataset.agente = info?.agente || '';
  agente.hidden = !info?.agente;
  nomeLinha.append(titulo, agente);
  const caminho = document.createElement('div');
  caminho.className = 'caminho chat-caminho';
  const aviso = document.createElement('div');
  aviso.className = 'aviso-agente';
  aviso.hidden = true;
  identidade.append(nomeLinha, caminho, aviso);

  const medidorTrilho = document.createElement('span');
  medidorTrilho.className = 'medidor-barra medidor-trilho';
  const medidorCheio = document.createElement('i');
  medidorCheio.className = 'medidor-cheio';
  medidorTrilho.append(medidorCheio);
  const medidorModelo = document.createElement('span');
  medidorModelo.className = 'medidor-modelo';
  const medidorEffort = document.createElement('span');
  medidorEffort.className = 'medidor-effort';
  medidorEffort.hidden = true;
  const medidorPct = document.createElement('span');
  medidorPct.className = 'medidor-pct';
  const medidorEl = document.createElement('button');
  medidorEl.className = 'medidor';
  medidorEl.type = 'button';
  medidorEl.hidden = true;
  medidorEl.setAttribute('aria-haspopup', 'dialog');
  idiomaUI.bind(medidorEl, 'title', () => tr('Ver os números desta conversa'));
  medidorEl.append(medidorTrilho, medidorModelo, medidorEffort, medidorPct);
  medidorEl.onclick = () => abrirContexto(painel);

  const faixaPino = document.createElement('span');
  faixaPino.className = 'faixa-pino';
  faixaPino.setAttribute('aria-hidden', 'true');
  faixaPino.textContent = '●';
  const faixaConta = document.createElement('span');
  faixaConta.className = 'faixa-conta';
  // 🔴 `aria-live` na CONTA, não na faixa inteira (achado do painel, rodada 1). O
  // `bbf90c0^` punha `aria-live="polite"` no botão, e a etapa embaixo carrega
  // `haQuantoTempo(j.desde)`: o texto muda SOZINHO de "há 4 min" para "há 5 min" a cada
  // minuto, e um leitor de tela releria a faixa inteira nessa cadência. É a mesma decisão
  // que a `.barra-agentes` já tomou (`index.html`: "aria-live só no AVISO … na barra
  // inteira, o contador anunciaria a cada 5s — tagarelice"). A conta só muda quando o
  // NÚMERO de jobs muda, que é a notícia que vale interromper alguém.
  faixaConta.setAttribute('aria-live', 'polite');
  const faixaTitulos = document.createElement('span');
  faixaTitulos.className = 'faixa-titulos';
  const faixaEtapa = document.createElement('span');
  faixaEtapa.className = 'faixa-etapa';
  const faixaEl = document.createElement('button');
  faixaEl.className = 'faixa-jobs';
  faixaEl.type = 'button';
  faixaEl.hidden = true;
  idiomaUI.bind(faixaEl, 'title', () => tr('Ver os agentes'));
  faixaEl.append(faixaPino, faixaConta, faixaTitulos, faixaEtapa);
  faixaEl.onclick = verOsAgentes;   // §4.5 — o destino mudou com a D51

  const pararRotulo = document.createElement('span');
  pararRotulo.className = 'parar-rotulo';
  idiomaUI.bind(pararRotulo, 'textContent', () => tr('Parar'));
  const btnParar = document.createElement('button');
  btnParar.className = 'btn btn-parar';
  btnParar.type = 'button';
  btnParar.hidden = true;
  idiomaUI.bind(btnParar, 'title', () => tr('Parar o turno em andamento'));
  btnParar.append(iconeParar(), pararRotulo);
  // Sem confirmação de propósito: é reversível — a mensagem continua no histórico da caixa
  // e basta reenviar. Quem manda parar é o Escape, a mesma tecla que a TUI anuncia.
  btnParar.onclick = async () => {
    btnParar.disabled = true;
    try {
      await api(`api/abas/${painel.chave}/turnos/atual`, { method: 'DELETE' });
    } catch (erro) {
      noPainel(painel, () => bolha('bolha-erro', tr`não deu para parar: ${erro.message}`));
    } finally {
      btnParar.disabled = false;
    }
  };

  const btnRecarregar = document.createElement('button');
  btnRecarregar.className = 'icone-so recarregar btn-recarregar-conversa';
  btnRecarregar.type = 'button';
  idiomaUI.bind(btnRecarregar, 'title', () => tr('Recarregar esta conversa'));
  idiomaUI.attr(btnRecarregar, 'aria-label', () => tr('Recarregar esta conversa'));
  btnRecarregar.append(iconeContorno('icone-botao', 'M3 3v6h6', 'M3.5 9a9 9 0 1 1 .8 6.4'));
  btnRecarregar.onclick = (evento) => recarregar(evento.currentTarget, () => recarregarPainel(painel));

  // O divisor entre o ⊟ (tira o painel da TELA) e o ✕ (mata a aba no TMUX): os dois são
  // MUITO diferentes em gravidade — um é reversível na hora, o outro é o único botão
  // irreversível da tela — e moram lado a lado só por falta de espaço melhor.
  const divisorTopo = document.createElement('span');
  divisorTopo.className = 'chat-topo-divisor';
  divisorTopo.setAttribute('aria-hidden', 'true');

  // ⊟ — split view, fase 3: tira ESTE painel da tela, sem tocar na aba do terminal (ela
  // continua rodando; `fecharPainel` é o gesto do usuário, ver o plano). Fica ANTES do ✕
  // de propósito (§4.2 da spec): errar o alvo aqui é recuperável, errar o do ✕ não é.
  const btnFecharPainel = document.createElement('button');
  btnFecharPainel.className = 'icone-so fechar-painel';
  btnFecharPainel.type = 'button';
  idiomaUI.bind(btnFecharPainel, 'title', () => tr('Tirar este painel da tela (a aba continua aberta no terminal)'));
  idiomaUI.attr(btnFecharPainel, 'aria-label', () => tr('Tirar este painel da tela'));
  btnFecharPainel.textContent = '⊟';
  btnFecharPainel.onclick = () => fecharPainel(painel.chave);

  const btnMatarAba = document.createElement('button');
  btnMatarAba.className = 'icone-so fechar-aba btn-matar-aba';
  btnMatarAba.type = 'button';
  btnMatarAba.setAttribute('aria-haspopup', 'dialog');
  idiomaUI.bind(btnMatarAba, 'title', () => tr('Fechar esta aba no terminal'));
  idiomaUI.attr(btnMatarAba, 'aria-label', () => tr('Fechar esta aba no terminal'));
  btnMatarAba.append(iconeContorno('icone-botao', 'M6 6l12 12M18 6L6 18'));
  btnMatarAba.onclick = () => {
    painelPedindoMorte = painel;
    idiomaUI.bind($('nota-matar-aba'), 'textContent', () => tr(''));
    idiomaUI.bind($('matar-aba-estado'), 'textContent', () => tr(estadoParaMatar(abasDoTerminal.find((a) => a.chave === painel.chave))));
    $('dialogo-matar-aba').showModal();
  };

  topo.append(voltar, identidade, medidorEl, faixaEl, btnParar, btnRecarregar, divisorTopo, btnFecharPainel, btnMatarAba);

  // ── .mensagens ──────────────────────────────────────────────────────
  const mensagens = document.createElement('div');
  mensagens.className = 'mensagens';

  const puxarSelo = document.createElement('div');
  puxarSelo.className = 'puxar-selo';
  puxarSelo.setAttribute('aria-hidden', 'true');
  const puxarAnel = document.createElement('span');
  puxarAnel.className = 'puxar-anel';
  puxarSelo.append(puxarAnel);

  const fitaEl = document.createElement('div');
  fitaEl.className = 'fita';

  const TECLAS = [
    ['left', 'Left', '←', tr('Seta para a esquerda'), tr('Seta para a esquerda')],
    ['up', 'Up', '↑', tr('Seta para cima'), tr('Seta para cima')],
    ['down', 'Down', '↓', tr('Seta para baixo'), tr('Seta para baixo')],
    ['right', 'Right', '→', tr('Seta para a direita'), tr('Seta para a direita')],
  ];
  const perguntaTeclas = document.createElement('div');
  perguntaTeclas.className = 'pergunta-teclas';
  const botoesTecla = TECLAS.map(([sufixo, valorTecla, simbolo, title, ariaLabel]) => {
    const botao = document.createElement('button');
    botao.className = `btn tecla tecla-${sufixo}`;
    botao.type = 'button';
    botao.dataset.tecla = valorTecla;
    idiomaUI.bind(botao, 'title', () => tr(title));
    idiomaUI.attr(botao, 'aria-label', () => tr(ariaLabel));
    botao.textContent = simbolo;
    botao.onclick = () => apertarTecla(painel, valorTecla);
    return botao;
  });
  const teclaEnter = document.createElement('button');
  teclaEnter.className = 'btn btn-principal tecla tecla-enter';
  teclaEnter.type = 'button';
  teclaEnter.dataset.tecla = 'Enter';
  idiomaUI.bind(teclaEnter, 'title', () => tr('Confirmar a opção marcada'));
  teclaEnter.textContent = 'Enter';
  teclaEnter.onclick = () => apertarTecla(painel, 'Enter');
  const teclaEsc = document.createElement('button');
  teclaEsc.className = 'btn tecla tecla-esc';
  teclaEsc.type = 'button';
  teclaEsc.dataset.tecla = 'Escape';
  // O que o botão FAZ, não o que ele consegue: no prompt de update do Codex o Esc não fecha
  // nada, e no prompt de confiança ele ENCERRA o agente — "Cancelar" mentiria nos dois.
  idiomaUI.bind(teclaEsc, 'title', () => tr('Mandar a tecla Esc para o terminal'));
  teclaEsc.textContent = 'Esc';
  teclaEsc.onclick = () => apertarTecla(painel, 'Escape');
  perguntaTeclas.append(...botoesTecla, teclaEnter, teclaEsc);

  const telaDaPane = document.createElement('pre');
  telaDaPane.className = 'pergunta-tela';

  // O cartão da pergunta (card pergunta-do-agente-em-cartao, D74): o servidor manda `cartao`
  // na resposta da tela quando o hook do Claude Code gravou a pergunta E a tela confere. O
  // terminal cru vira um "ver terminal" fechado; sem cartão ele fica aberto e a tela é a de
  // sempre (quebrando linha). As teclas ficam FORA do <details> de propósito: a .pergunta é
  // coluna flex e elas descem ao rodapé por `margin-top: auto` — dentro do <details> isso
  // deixaria de valer. Nasce no estado "sem cartão" para os menus que não são pergunta.
  const cartaoEl = document.createElement('div');
  cartaoEl.className = 'pergunta-cartao';
  cartaoEl.hidden = true;
  const terminalPergunta = document.createElement('details');
  terminalPergunta.className = 'pergunta-terminal';
  terminalPergunta.open = true;
  terminalPergunta.dataset.semCartao = '1';
  const terminalRotulo = document.createElement('summary');
  terminalRotulo.className = 'pergunta-terminal-rotulo';
  idiomaUI.bind(terminalRotulo, 'textContent', () => tr('ver terminal'));
  terminalPergunta.append(terminalRotulo, telaDaPane);
  // As teclas só aparecem com o terminal aberto quando há cartão (spec §4.8).
  terminalPergunta.addEventListener('toggle', () => {
    perguntaTeclas.hidden = Boolean(painel.cartao) && !terminalPergunta.open;
  });

  // Card escrever-texto-na-pergunta-aberta (spec §5.1): o Enviar destravado não pode
  // parecer o Enviar de sempre — mandar Esc antes do texto tem consequência, e ela precisa
  // estar visível ANTES do dedo. Descreve a AÇÃO, não o resultado (não promete "cancela a
  // pergunta": há menu que o Esc não fecha, `:3244-3247`). No DOM, nunca em `title` (#31):
  // `title` é tooltip de mouse, não existe no celular. Visível só com `motivo === 'menu'`
  // (marcarPergunta decide) — `.pergunta` é flex COLUNA (estilo.css), então esta linha é
  // item PRÓPRIO e não quebra letra a letra.
  const avisoEscrita = document.createElement('div');
  avisoEscrita.className = 'aviso-escrita';
  avisoEscrita.hidden = true;
  idiomaUI.bind(avisoEscrita, 'textContent', () => tr('Escrever aqui manda Esc antes do texto.'));

  // Card pergunta-sem-gancho-avisa: sem o hook do D74 o cartão nunca nasce e a pergunta cai calada no
  // terminal cru. O servidor diz `semGancho` (lê o settings, só leitura); aqui só se mostra. Item PRÓPRIO
  // da coluna flex, no FIM: a 1ª pintura rola para o fim, e é ali que o olho está no celular. No DOM,
  // nunca em `title` (#31). Não é botão e não captura tecla — a resposta pelas teclas continua igual.
  const avisoGancho = document.createElement('div');
  avisoGancho.className = 'aviso-gancho';
  avisoGancho.hidden = true;
  idiomaUI.bind(avisoGancho, 'textContent', () => tr('Cartão da pergunta desligado: o hook não está instalado (DECISOES.md, D74).'));

  const pergunta = document.createElement('div');
  pergunta.className = 'pergunta';
  pergunta.hidden = true;
  pergunta.append(cartaoEl, terminalPergunta, perguntaTeclas, avisoEscrita, avisoGancho);

  mensagens.append(puxarSelo, fitaEl, pergunta);

  // ── .envio ──────────────────────────────────────────────────────────
  // Caixa de envio por painel (2026-09-09, D42): cada painel ganha a PRÓPRIA caixa de
  // escrita, os PRÓPRIOS anexos, a PRÓPRIA paleta e a PRÓPRIA dica — a D39 (split view)
  // dava tudo isso ao painel FOCADO; isso deixou de valer. §3.1/§5.1 da spec: nenhum
  // elemento aqui tem `id` — a convenção é a mesma classe do id de ontem, casada pelo CSS
  // existente e pelo `porIdDe` do gate.
  //
  // `#envio-para` (o rótulo "para onde vai a mensagem") SAI (D42): com a caixa colada
  // embaixo do próprio painel, a proximidade física já diz o destino — melhor do que um
  // texto diria.
  const envio = document.createElement('div');
  envio.className = 'envio';
  const envioArea = document.createElement('div');
  envioArea.className = 'envio-area';

  // Preenchido pelo app.js quando o texto começa com "/". Fica ancorado acima da caixa
  // para o dedo no celular não precisar viajar.
  const paleta = document.createElement('div');
  paleta.className = 'paleta';
  paleta.hidden = true;
  paleta.setAttribute('role', 'listbox');
  idiomaUI.attr(paleta, 'aria-label', () => tr('Comandos e skills'));

  const anexosEl = document.createElement('div');
  anexosEl.className = 'anexos';
  anexosEl.hidden = true;

  const envioCaixa = document.createElement('div');
  envioCaixa.className = 'envio-caixa';

  const btnAnexar = document.createElement('button');
  btnAnexar.className = 'icone-so anexar btn-anexar';
  btnAnexar.type = 'button';
  idiomaUI.bind(btnAnexar, 'title', () => tr('Anexar imagem ou PDF'));
  idiomaUI.attr(btnAnexar, 'aria-label', () => tr('Anexar arquivo'));
  btnAnexar.append(iconeContorno('icone-botao', 'M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'));
  btnAnexar.onclick = () => inpArquivo.click();

  const inpArquivo = document.createElement('input');
  inpArquivo.type = 'file';
  inpArquivo.className = 'inp-arquivo';
  inpArquivo.accept = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain';
  inpArquivo.multiple = true;
  inpArquivo.hidden = true;
  inpArquivo.addEventListener('change', (evento) => {
    for (const arquivo of evento.target.files) subirArquivo(painel, arquivo);
    evento.target.value = ''; // permite escolher o mesmo arquivo de novo
  });

  // Sem `placeholder` fixo aqui: o texto depende da LARGURA (M1/P5, #40) e quem escreve é
  // `pintarPlaceholderNo()` no app.js — um dono só, como a `.dica`.
  const entrada = document.createElement('textarea');
  entrada.className = 'entrada';
  entrada.rows = 1;
  entrada.autocomplete = 'off';
  entrada.addEventListener('input', () => {
    entrada.style.height = 'auto';
    entrada.style.height = `${Math.min(entrada.scrollHeight, 200)}px`;
    // R35 da spec: o ouvinte de `input` é quem mantém `painel.textoNaCaixa` em dia na
    // digitação — `escreverNaCaixa` cobre as quatro escritas PROGRAMÁTICAS, que não
    // disparam este evento.
    painel.textoNaCaixa = entrada.value;
    painel.seloComposicao += 1;
    talvezAbrirPaleta(painel);
  });
  // O fechamento por SAÍDA é do `blur` — quem abre por CURSOR é o `focus`, e nenhum dos
  // dois é `focar()` (§3.6 da spec: a paleta pertence ao cursor, não ao painel focado).
  entrada.addEventListener('blur', () => setTimeout(() => fecharPaleta(painel), 120));
  // O caminho do `Tab`: o `pointerdown` delegado já foca o painel no clique, mas não cobre
  // sair de A e entrar em B pelo teclado (§3.7 da spec).
  entrada.addEventListener('focus', () => { if (painel.chave !== atual) focar(painel); });
  entrada.addEventListener('keydown', (e) => {
    // A régua de quem ganha a tecla com a pergunta aberta (card
    // escrever-texto-na-pergunta-aberta, spec §5.3): caixa VAZIA cede as seis ao menu (D57,
    // intacta); caixa COM TEXTO é dona da tecla — o Enviar destravou (Fase 5), e o Enter que
    // envia não pode virar Enter de menu. O `keydown` do elemento roda na fase de ALVO,
    // antes do ouvinte do `document`, então a decisão mora AQUI — o de lá não tem como saber
    // que este já agiu.
    if (painel.perguntando && TECLAS_FISICAS[e.key]) {
      // Modificador é ATALHO (`combinacaoDe`, :6319), e IME em composição não é tecla de
      // ninguém. `return` e não `stopPropagation`: seguir daqui cairia abaixo, que dispara
      // `enviar()` sem olhar ctrl/alt/meta NEM `isComposing` — hoje quem protege os dois é a
      // cessão ao `document`, cujas guardas 2 e 4 os descartam. Cortar a propagação sem
      // repetir as duas guardas aqui transformaria `Ctrl+Enter` e o Enter de IME em envio.
      if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      // Vazia: cede as seis ao menu — a D57, intacta.
      if (painel.textoNaCaixa.trim() === '') return;
      // Com texto: a tecla é DESTA caixa. A decisão mora aqui (#77 metade 2) porque
      // `escreverNaCaixa('')` esvazia a caixa antes de o evento chegar ao `document`.
      e.stopPropagation();
    }
    const paletaAberta = !painel.paleta.hidden;
    if (paletaAberta) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return navegarPaleta(painel, 1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return navegarPaleta(painel, -1); }
      if (e.key === 'Escape') { e.preventDefault(); return fecharPaleta(painel); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return escolher(painel, painel.indicePaleta); }
    }
    // Enter depende do APARELHO. Com o dedo não existe Shift, então a regra do teclado
    // físico mandava a mensagem pela metade toda vez que a intenção era só pular uma
    // linha — no celular quebrar linha é o comum e enviar tem o botão Enviar do lado. Com
    // ponteiro fino (mouse/teclado do note) nada muda: Enter envia, Shift+Enter quebra.
    // A pergunta é feita AQUI, na tecla, e não uma vez no carregamento: o mesmo aparelho
    // pode ganhar um teclado no meio da sessão, e uma constante congelada no boot só se
    // corrigiria recarregando o app.
    const comDedo = matchMedia('(pointer: coarse)').matches;
    // De carona na pergunta que a tecla acabou de fazer: se o ponteiro mudou desde a
    // última pintura, a dica se corrige aqui — sem recarregar o app, que é o que a D29
    // evita.
    pintarDica(comDedo);
    if (e.key === 'Enter' && !e.shiftKey && !comDedo) { e.preventDefault(); enviar(painel); }

    // Só navega o histórico com o cursor na borda certa. No meio de um texto de várias
    // linhas, seta para cima tem que continuar sendo seta para cima.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const antesDoCursor = entrada.value.slice(0, entrada.selectionStart);
      const depoisDoCursor = entrada.value.slice(entrada.selectionEnd);
      const naBorda = e.key === 'ArrowUp' ? !antesDoCursor.includes('\n') : !depoisDoCursor.includes('\n');
      if (naBorda && navegarHistorico(painel, e.key === 'ArrowUp' ? -1 : 1, entrada)) e.preventDefault();
      return;
    }

    if (e.key === 'Escape' && painel.posHistorico !== null) {
      e.preventDefault();
      escreverNaCaixa(painel, painel.rascunho);
      sairDoHistorico(painel);
      pousarNoFim(entrada);
    }
  });

  const btnEnviar = document.createElement('button');
  btnEnviar.className = 'btn btn-principal btn-enviar';
  idiomaUI.bind(btnEnviar, 'textContent', () => tr('Enviar'));
  btnEnviar.onclick = () => enviar(painel);

  envioCaixa.append(btnAnexar, inpArquivo, entrada, btnEnviar);

  // Vazia de propósito: quem escreve a dica é o `pintarDicaNo()` do app.js, porque o texto
  // DEPENDE do aparelho — com o dedo o Enter quebra linha e quem manda é o botão Enviar
  // (D30/D33). Deixar a frase do teclado físico chumbada aqui era ter dois lugares a
  // atualizar, e um deles mentiu por um dia. Ver armadilha #40.
  const dica = document.createElement('div');
  dica.className = 'dica';

  envioArea.append(paleta, anexosEl, envioCaixa, dica);
  envio.append(envioArea);

  raiz.append(topo, mensagens, envio);

  // Os controles que miram uma aba do tmux não fazem sentido num painel de job (§4.4): não
  // há objeto para o ✕ matar (o único botão irreversível da tela, #51) e não se fala com um
  // job (Fase 0 do card) — a caixa inteira some. `btnParar` já nasce `hidden = true` acima
  // (nenhum turno para parar na abertura); a guarda extra contra `marcarOcupado`/
  // `marcarPergunta` reescreverem isso está NELAS, não aqui (4.4 do plano).
  if (tipo === 'job') {
    btnMatarAba.hidden = true;
    envio.hidden = true;
  }

  const painel = {
    chave, raiz, tipo, topo, titulo, caminho, agente, aviso, voltar,
    medidor: {
      el: medidorEl, trilho: medidorTrilho, cheio: medidorCheio,
      modelo: medidorModelo, effort: medidorEffort, pct: medidorPct,
    },
    faixa: { el: faixaEl, pino: faixaPino, conta: faixaConta, titulos: faixaTitulos, etapa: faixaEtapa },
    btnParar, pararRotulo, btnRecarregar, btnFecharPainel, btnMatarAba,
    mensagens, fita: fitaEl, selo: puxarSelo, pergunta, telaDaPane, avisoEscrita, avisoGancho,
    // O cartão da pergunta: `cartao` é o último `{ toolUseId, perguntas }` pintado,
    // `respostasCartao` o que o usuário marcou (uma entrada por pergunta) e `estadoCartao` em
    // que pé está o envio ('editando' | 'enviando' | 'enviado' | 'erro').
    cartaoEl, terminalPergunta, perguntaTeclas,
    cartao: null, respostasCartao: [], estadoCartao: 'editando',
    envio, entrada, btnEnviar, btnAnexar, inpArquivo, paleta, anexosEl, dica,
    // A escolha da paleta é do PAINEL, não de módulo (§3.5 da spec): mover o DOM e deixar
    // o estado para trás é a #51 uma camada acima.
    escolhidosPaleta: [], indicePaleta: 0,
    // estado que hoje era de módulo:
    destinoFita: null, ultimaFala: null, ultimaHora: null, pendentes: [],
    grupoFerramentas: null, ferramentaSolta: null, desenhandoDeFora: false,
    // `motivoPergunta` só tem sentido com `perguntando` true; fora disso é o valor de
    // repouso `'menu'`, para nenhum texto ter que tratar `null` (ver `marcarPergunta`).
    ocupado: false, perguntando: false, motivoPergunta: 'menu',
    catalogo: null, anexos: [], contexto: null,
    textoNaCaixa: '', historicoEntrada: [], posHistorico: null, rascunho: '',
    rolagemGuardada: null, timerTerminou: null,
    // O selo do envio recuperável (card menu-da-tui-do-codex-na-tela, R11) — NÃO confundir
    // com `painel.selo`, que é o elemento DOM do gesto de puxar-para-recarregar, alguns
    // campos acima. Um inteiro que sobe a cada mudança da composição (texto/anexo): se ele
    // mudou entre o momento do envio e a resposta, a composição já não é a mesma, e o par
    // recusado vai para a gaveta (`recusados`) em vez de voltar para a caixa na hora.
    seloComposicao: 0,
    // O nó do aviso enquanto um envio espera anexo subir (card foto-some-entre-upload-e-envio).
    esperandoAnexo: null,
    // Tocou Enviar de novo DEPOIS do último × durante a espera: o toque novo decide (o × zera).
    tocouDeNovo: false,
    // O `/status` do Codex (develop, 08/09). Eram `let` de módulo; com N painéis, duas abas
    // de Codex na tela dividiriam o mesmo bloco de resultado e a mesma dedupe por `id`.
    statusCodexSessao: null, statusCodexGeracao: 0, statusCodexEl: null,
    statusCodexIds: new Set(),
    // O chip `início` virando controle (card `carregar-mais-historico`): a âncora do
    // próximo clique, a bandeira de pedido em voo, a geração que descarta resposta vencida,
    // o `sessaoId` PRÓPRIO desta guarda (não `statusCodexSessao`, que é do `/status`), o
    // elemento da marca (para mover/atualizar) e a bandeira que neutraliza o replay.
    inicioDoHistorico: 0, carregandoHistorico: false, geracaoHistorico: 0,
    sessaoDaConversa: null, marcaDeInicio: null, replayAntigo: false,
  };

  pintarDicaNo(painel);
  pintarPlaceholderNo(painel);

  // Split view, fase 3 (R28 da spec): se esta aba tinha saído da tela numa TROCA de
  // conjunto (não um fechamento — `tirarPainel` é quem guarda), o texto e os anexos voltam
  // aqui. Só nesta SESSÃO: recarregar a página descarta os órfãos, como tudo o mais (§4.5).
  const orfao = orfaos.get(chave);
  if (orfao) {
    painel.textoNaCaixa = orfao.textoNaCaixa;
    painel.anexos = orfao.anexos;
    orfaos.delete(chave);
    // Caixa de envio por painel: sem troca de foco, ninguém restaura o rascunho na caixa —
    // quem restaurava era `focar() → escreverNaCaixa` (§3.4 da spec, irmã da #47).
    escreverNaCaixa(painel, orfao.textoNaCaixa);
    desenharAnexos(painel);
  }
  // O envio recusado desta aba (card menu-da-tui-do-codex-na-tela, R11) — SEMPRE depois do
  // bloco de `orfaos` acima, nunca antes: o órfão é a composição de AGORA (o que o usuário
  // estava escrevendo) e tem precedência sobre o par de um envio anterior. `restaurarRecusado`
  // só age com a caixa vazia, então os dois nunca se misturam.
  restaurarRecusado(painel);

  ligarGestoDePuxar(painel);
  // Registra e monta — quem chama `criarPainel` não precisa repetir os dois passos (e é o
  // que deixa `carregarCliente()` do gate-ui.js montar um painel de partida chamando só
  // `criarPainel` + `focar`, sem duplicar o `Map`/DOM do cliente real — §5.5 da spec).
  paineis.set(chave, painel);
  $('paineis').append(painel.raiz);
  // Depois do `append`, nunca antes: fora da tela o painel mede 0 e o observador não teria o
  // que medir. Ele dispara uma vez na primeira medição, e é ela que acerta o placeholder.
  observadorDeLargura?.observe(painel.entrada);
  // `criarPainel` é um dos quatro escritores de `P` (§4.7 da spec): o painel recém-criado
  // vira o alvo do desenho até o próximo `aplicarNoPainel`/`noPainel` apontar para outro.
  P = painel;
  atualizarBotaoFecharPainel();
  pintarFaixaDe(painel);

  return painel;
}

/**
 * O ⊟ só faz sentido a partir do SEGUNDO painel: com um só, tirá-lo da tela é o mesmo que a
 * lista já oferece (nenhuma vantagem sobre `←`), e mantê-lo escondido é o que garante zero
 * pixel novo no celular (lá `paineis.size` nunca passa de 1 — Fase 0 do card) sem precisar
 * perguntar `matchMedia`. Chamado depois de QUALQUER entrada/saída do `Map` de painéis.
 */
function atualizarBotaoFecharPainel() {
  const mostrar = paineis.size > 1;
  for (const p of paineis.values()) p.btnFecharPainel.hidden = !mostrar;
}

/** O painel FOCADO agora — o objeto de estado, não o elemento DOM. */
function painelAtual() {
  return paineis.get(atual);
}

/**
 * O painel a que `alvo` pertence, subindo até o `.painel` mais próximo — o mesmo resolvedor
 * que o `pointerdown` e o `drop` já faziam à mão, extraído para não repetir uma terceira vez
 * no `paste` (§3.9 da spec, consequência 1).
 */
function painelDoAlvo(alvo) {
  return [...paineis.values()].find((p) => p.raiz === alvo?.closest?.('.painel'));
}

/**
 * Marca `painel` como o SELECIONADO (`atual`) — a borda `data-foco`, a marca de lido na
 * lista, o `#vazio` e o `Alt+C` (§3.9 da spec). D42 revoga o trecho da D39 que dava a caixa
 * de escrita, os anexos, a paleta e o Enviar ao painel focado: esses agora são do painel do
 * CURSOR ou do painel do botão, nunca do selecionado — `focar()` não toca em nenhum deles.
 * `focar()` também NÃO chama `.focus()`: o foco de verdade é responsabilidade de quem chama
 * (§3.7/§3.9) — roubar o cursor aqui mataria a seleção de texto na fita.
 */
function focar(painel) {
  const anterior = paineis.get(atual);
  if (anterior && anterior !== painel) anterior.raiz.dataset.foco = '';
  atual = painel.chave;
  painel.raiz.dataset.foco = '1';
  // Achado no PNG de 6 painéis, não no gate: com a faixa rolando de lado, o painel que
  // acabou de ganhar o foco pode estar FORA da vista — e a caixa de escrita passa a falar
  // com uma conversa que o usuário não está vendo. Escrever para o agente errado é o pior
  // defeito possível desta tela (§4.3 da spec), e o rótulo sozinho não basta quando o
  // painel nem aparece. `inline: 'nearest'` só rola o que precisa: painel já visível não
  // se mexe, e a rolagem VERTICAL da fita nunca é tocada (`block: 'nearest'`).
  painel.raiz.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  desenharAbas();
}

/**
 * Fecha o `EventSource` da conversa aberta e abre um novo com a lista de chaves de agora.
 * Zero painel não abre nada — `#vazio` volta (fica a cargo de quem chamou mostrar `#vazio`).
 */
function religarFluxo() {
  fluxo?.close();
  const chaves = [...paineis.keys()];
  if (!chaves.length) { fluxo = null; return; }
  fluxo = new EventSource(comToken('api/eventos?abas=' + chaves.map(encodeURIComponent).join(',')));
  // O cano DESTA chamada. `close()` para a entrega no navegador, mas um callback já
  // agendado pode rodar depois — e como o painel continua no `Map`, `paineis.get(aba)`
  // sozinho não o barraria: o cano velho repintaria a conversa que o novo acabou de trocar.
  // A guarda veio do develop de 08/09 (o `fluxoDaVez` do `/status` do Codex) e vale mais
  // aqui, onde um cano carrega N painéis em vez de um.
  const fluxoDaVez = fluxo;
  fluxo.onmessage = (e) => {
    if (fluxo !== fluxoDaVez) return;
    const { aba, evento } = JSON.parse(e.data);
    const painel = paineis.get(aba);
    if (!painel) return;   // envelope de aba que não está mais aberta — ignora
    // `sessao` é o primeiro evento do fluxo, inclusive quando o `EventSource` reconecta
    // sozinho: é o marco de "vem histórico aí", e por isso a rajada começa AQUI — no
    // caminho real de chegada do evento, nunca dentro de `aplicarNoPainel` (que os 176
    // `cliente.aplicar({...})` do gate chamam DIRETO, sem passar por este `onmessage`, e não
    // podem ganhar uma rajada de propósito).
    if (evento.tipo === 'sessao') {
      // O cano falou: ele está vivo. Zera o contador e tira a faixa, se estiver no ar.
      falhasDoCano = 0;
      pintarCanoCaido(false);
      // R31/R33 da spec de 08/09: a rolagem é guardada ANTES do `limparFita()`, na caixa de
      // VERDADE — é o único instante em que ela ainda reflete onde o usuário estava. Cobre
      // religar, a reconexão automática e o `/clear` com o mesmo caminho.
      painel.rolagemGuardada = { noFim: estaNoFim(painel), scrollTop: painel.mensagens.scrollTop };
      P = painel;
      limparFita();
      segurarFita();
      painel.ultimaFala = null;
      painel.historicoEntrada = [];
    }
    aplicarNoPainel(painel, evento);
  };
  // O `EventSource` reconecta sozinho, e quase sempre volta — por isso nunca houve aviso
  // aqui. O que o split muda: um cano morto agora deixa **N** painéis mudos em vez de um, e
  // "a tela toda parou e não disse nada" é pior do que "uma conversa parou". Na TERCEIRA
  // falha seguida sem um `sessao` no meio, a faixa aparece. Ela NÃO conserta o caso do
  // deploy (uma página aberta antes do restart roda o JS velho e nunca chega aqui) — isso
  // pede F5, e está dito na D39.
  fluxo.onerror = () => {
    falhasDoCano += 1;
    if (falhasDoCano >= 3) pintarCanoCaido(true);
  };
}

// Quantas falhas seguidas do cano, sem um `sessao` no meio (que é o que prova que ele
// voltou). Zerado no `sessao`, em `religarFluxo` — e o contador é do CANO, não do painel:
// é o cano que cai, e ele leva todos juntos.
let falhasDoCano = 0;

/** A faixa de "perdi o fluxo". Um nó só, no topo da área dos painéis. */
function pintarCanoCaido(caido) {
  const area = $('paineis');
  const existente = area.querySelector('.cano-caido');
  if (!caido) { existente?.remove(); return; }
  if (existente) return;
  const faixa = document.createElement('div');
  faixa.className = 'cano-caido';
  faixa.setAttribute('role', 'status');
  idiomaUI.bind(faixa, 'textContent', () => tr('Perdi o fluxo das conversas. Toque no ↻ de um painel para reabrir.'));
  area.prepend(faixa);
}

/**
 * Tira o painel da TELA: sai do `Map` e do DOM e guarda
 * o texto e os anexos no `Map` de órfãos (R28) para o caso de a mesma aba reabrir NESTA
 * sessão. PURA: não decide foco, não religa o cano, não mexe na vista — quem decide é
 * `fecharPainel` (o gesto do usuário) ou `trocarConjunto` (a transação de troca de conjunto).
 * Devolve o painel removido, ou `null` se `chave` já não estava no `Map`.
 */
function tirarPainel(chave) {
  const painel = paineis.get(chave);
  if (!painel) return null;
  observadorDeLargura?.unobserve(painel.entrada);
  orfaos.set(chave, { textoNaCaixa: painel.textoNaCaixa, anexos: painel.anexos });
  painel.seloComposicao += 1;
  paineis.delete(chave);
  painel.raiz.remove();
  atualizarBotaoFecharPainel();
  return painel;
}

/**
 * Troca o conjunto INTEIRO de painéis abertos por `chaves`, numa transação só: os que saem
 * são tirados, os que entram nascem, o primeiro painel NOVO ganha o foco e o cano religa UMA
 * vez (R27 da spec). NUNCA passa por `fecharPainel`: se passasse, o penúltimo fechamento
 * veria "não sobrou ninguém" e chamaria `pedirLista()` — a tela voltaria para a lista em vez
 * de abrir a conversa que o usuário acabou de clicar.
 */
function trocarConjunto(chaves) {
  const manter = new Set(chaves);
  for (const antiga of [...paineis.keys()]) {
    if (!manter.has(antiga)) tirarPainel(antiga);
  }
  let primeiroNovo = null;
  for (const chave of chaves) {
    if (paineis.has(chave)) continue;
    const info = abasDoTerminal.find((a) => a.chave === chave);
    const painel = criarPainel(chave, info);
    // Os avisos de "abrindo"/"não subiu"/"sem agente" moram no CABEÇALHO, não na fita: o
    // `sessao` que o `religarFluxo()` abaixo vai disparar chama `limparFita()`, e uma bolha
    // criada na fita aqui seria apagada por ele um instante depois (medido).
    desenharAvisoDoAgente(painel, info);
    if (!primeiroNovo) primeiroNovo = painel;
  }
  if (primeiroNovo) focar(primeiroNovo);
  religarFluxo();
}

/**
 * Abre uma aba do terminal na mesma tela de conversa das sessões do cockpit.
 *
 * Chave já aberta num painel → só foca (não recria, não religa — §4.2 da spec). Sem
 * `aoLado`, o conjunto inteiro é substituído por esta conversa (`trocarConjunto`, o
 * comportamento de sempre: clicar na lista troca o que está na tela). Com `aoLado`, o painel
 * novo se ACRESCENTA ao que já está aberto e rouba o foco (R25) — ignorado no celular, onde
 * só existe um painel por vez (D30, `matchMedia` perguntado na hora, nunca no boot). Com `soltoEm`
 * (o arrasto da linha, D73), o painel vai para a zona escolhida — ver `encaixarPainel`.
 *
 * Dá para reusar `aplicarNoPainel()` inteiro porque o servidor traduz o arquivo do CLI para
 * o MESMO vocabulário de eventos do adaptador. O que muda é só o que não existe aqui: uso,
 * arquivos e encerrar são da sessão do cockpit, e somem.
 */
async function abrirAba(chave, { aoLado = false, soltoEm = null } = {}) {
  const jaAberta = paineis.has(chave);
  if (soltoEm && !matchMedia('(max-width: 760px)').matches) {
    // Arrastada para uma zona de um painel (D73). Âncora sumida no meio do gesto: nada muda, e o
    // rabo abaixo NÃO roda — ele marcaria lida uma conversa que nem abriu.
    if (!encaixarPainel(chave, soltoEm)) return;
  } else if (jaAberta) {
    const painel = paineis.get(chave);
    focar(painel);
    // Redesenhar o aviso é barato e idempotente (é a MESMA leitura de `abasDoTerminal` que
    // `desenharAbas()` já faz sempre) — mantém o cabeçalho fiel ao estado mais recente da aba
    // sem pagar o custo de recriar o painel nem de religar o cano.
    desenharAvisoDoAgente(painel, abasDoTerminal.find((a) => a.chave === chave));
    // "Já aberta" só dispensa religar se HÁ cano de verdade cobrindo o painel — sem isto,
    // um painel que por algum motivo ficou sem `fluxo` (o único caso de produção é nenhum,
    // mas é a garantia que o R41 pede: painel aberto SEMPRE coberto pelo cano) ficaria mudo
    // para sempre, clicado de novo sem nunca conectar.
    if (!fluxo) religarFluxo();
  } else if (aoLado && !matchMedia('(max-width: 760px)').matches) {
    const info = abasDoTerminal.find((a) => a.chave === chave);
    const painel = criarPainel(chave, info);
    desenharAvisoDoAgente(painel, info);
    focar(painel);
    religarFluxo();
  } else {
    trocarConjunto([chave]);
  }

  // Você está abrindo: a partir daqui esta conversa está lida. `desenharAbas` sai de dentro.
  marcarLido(chave);
  desenharAbas();
  // A faixa é por projeto agora, então trocar de aba troca o que ela mostra. Não é relógio
  // novo — é a mesma leitura do ciclo de 15s, adiantada para o instante em que muda.
  atualizarFaixaJobs();

  $('vazio').hidden = true;
  // A dica só fica visível a partir daqui: é o momento de conferir o ponteiro deste aparelho.
  pintarDica();
  empilharConversa();
  app.dataset.vista = 'chat';
  paineis.get(atual)?.entrada.focus();
}


/**
 * Põe a conversa `chave` no lugar que o arrasto escolheu (§3.5 da spec). Devolve `false` sem tocar
 * em nada quando a âncora do alvo já não está na tela (o tmux fechou a aba no meio do gesto).
 * Conversa já aberta MUDA de lugar (P4); nova nasce lá. O `Map` acompanha o DOM — `fecharPainel`,
 * `Alt+J/K` e o colapso do celular leem a ordem dele como a da tela. O cano só religa quando o
 * CONJUNTO mudou: o servidor não liga para a ordem do `?abas=`.
 */
function encaixarPainel(chave, alvo) {
  const ancora = alvo.tipo === 'trocar' ? alvo.chave : alvo.antesDe;
  if (ancora && !paineis.has(ancora)) return false;
  const jaAberta = paineis.has(chave);
  if (ancora === chave) { focar(paineis.get(chave)); return true; }
  const ordem = [...paineis.keys()].filter((k) => k !== chave);
  let painel = paineis.get(chave);
  if (!painel) {
    const info = abasDoTerminal.find((a) => a.chave === chave);
    painel = criarPainel(chave, info);
    desenharAvisoDoAgente(painel, info);
  }
  moverPainel(painel, ancora ? paineis.get(ancora).raiz : null);
  if (alvo.tipo === 'trocar') {
    ordem.splice(ordem.indexOf(alvo.chave), 1, chave);
    tirarPainel(alvo.chave);
  } else {
    ordem.splice(alvo.antesDe ? ordem.indexOf(alvo.antesDe) : ordem.length, 0, chave);
  }
  ordenarMapa(ordem);
  focar(painel);
  atualizarBotaoFecharPainel();
  if (!jaAberta || alvo.tipo === 'trocar') religarFluxo();
  return true;
}

/**
 * Põe o `raiz` do painel antes de `ref` (ou no fim) em `#paineis`. Mover um nó o tira e o põe de
 * volta, e o navegador ZERA a rolagem da `.mensagens` e tira o cursor da caixa (medido no Chromium
 * em 08/10, §5 da spec) — por isso guarda os dois antes e devolve depois (#52).
 */
function moverPainel(painel, ref) {
  const caixa = painel.mensagens;
  const rolagem = { noFim: estaNoFim(painel), scrollTop: caixa.scrollTop };
  const { entrada } = painel;
  const comCursor = document.activeElement === entrada;
  const selecao = [entrada.selectionStart, entrada.selectionEnd];
  $('paineis').insertBefore(painel.raiz, ref);
  if (rolagem.noFim) rolarFim(painel);
  else caixa.scrollTop = rolagem.scrollTop;
  if (comCursor) {
    entrada.focus();
    entrada.setSelectionRange(selecao[0], selecao[1]);
  }
}

/** Recria o `Map` de painéis na ordem `chaves` (só as que existem) — a ordem do `Map` é a da tela. */
function ordenarMapa(chaves) {
  const lista = chaves.map((k) => paineis.get(k)).filter(Boolean);
  paineis.clear();
  for (const p of lista) paineis.set(p.chave, p);
}

/**
 * O alvo do solto pela posição X do cursor — PURA (§3.2 da spec). `faixas` são os painéis abertos
 * na ordem do `Map` (`{ chave, left, right }`). Um painel colapsado (largura 0) nunca contém o X e
 * sai sozinho da conta. A âncora é a CHAVE do vizinho, nunca um índice: se o tmux fechar uma aba no
 * meio do gesto, o índice mudaria calado; a chave some e o `drop` cancela.
 */
function alvoDoSolto(x, faixas, chaveArrastada) {
  if (!faixas.length) return { tipo: 'vazio' };
  const i = faixas.findIndex((f) => x >= f.left && x < f.right);
  if (i === -1) return null;
  const { chave, left, right } = faixas[i];
  const fracao = (x - left) / (right - left);
  let alvo;
  if (fracao < FRACAO_BORDA) alvo = { tipo: 'inserir', antesDe: chave };
  else if (fracao > 1 - FRACAO_BORDA) alvo = { tipo: 'inserir', antesDe: faixas[i + 1]?.chave ?? null };
  else alvo = { tipo: 'trocar', chave };
  // S4: a conversa já aberta, solta onde ela JÁ está, não muda nada.
  const j = faixas.findIndex((f) => f.chave === chaveArrastada);
  if (j !== -1) {
    if (alvo.tipo === 'trocar' && alvo.chave === chaveArrastada) return null;
    const depoisDela = faixas[j + 1]?.chave ?? null;
    if (alvo.tipo === 'inserir' && (alvo.antesDe === chaveArrastada || alvo.antesDe === depoisDela)) return null;
  }
  return alvo;
}

/** As faixas horizontais dos painéis abertos, na ordem do `Map` — a entrada de `alvoDoSolto`. */
function faixasDosPaineis() {
  return [...paineis.values()].map((p) => {
    const r = p.raiz.getBoundingClientRect();
    return { chave: p.chave, left: r.left, right: r.right };
  });
}

/** Tira o preview da tela (coluna fantasma, destaque do centro, marca da origem). Idempotente. */
function limparPreview() {
  $('paineis').querySelector('.fantasma-painel')?.remove();
  for (const p of paineis.values()) {
    delete p.raiz.dataset.alvoTroca;
    delete p.raiz.dataset.arrastoOrigem;
    p.raiz.querySelector('.rotulo-troca')?.remove();
  }
  alvoDoArrasto = null;
}

/**
 * Desenha o preview de `alvo` (§3.4 da spec) — só mexe no DOM quando o alvo MUDOU. A coluna
 * fantasma é item flex como o painel: os outros encolhem e a tela mostra COMO VAI FICAR.
 */
function mostrarPreview(alvo) {
  const igual = (a, b) => a === b
    || Boolean(a && b && a.tipo === b.tipo && a.antesDe === b.antesDe && a.chave === b.chave);
  if (igual(alvo, alvoDoArrasto)) return;
  limparPreview();
  if (!alvo) return;
  alvoDoArrasto = alvo;
  const { titulo } = arrastoAba;
  if (alvo.tipo === 'trocar') {
    const raiz = paineis.get(alvo.chave).raiz;
    raiz.dataset.alvoTroca = '1';
    const rotulo = document.createElement('div');
    rotulo.className = 'rotulo-troca';
    rotulo.setAttribute('aria-hidden', 'true');
    idiomaUI.bind(rotulo, 'textContent', () => tr`Troca por: ${titulo}`);
    raiz.append(rotulo);
  } else {
    const coluna = document.createElement('div');
    coluna.className = 'fantasma-painel';
    coluna.setAttribute('aria-hidden', 'true');
    const nome = document.createElement('span');
    idiomaUI.bind(nome, 'textContent', () => tr`Abre aqui: ${titulo}`);
    coluna.append(nome);
    const antes = alvo.tipo === 'inserir' && alvo.antesDe ? paineis.get(alvo.antesDe).raiz : null;
    $('paineis').insertBefore(coluna, antes);
  }
  // S3: a conversa já aberta que vai mudar de lugar — na borda colapsa (o nº de colunas do preview é
  // o do resultado), no centro só esmaece.
  const origem = paineis.get(arrastoAba.chave);
  if (origem) origem.raiz.dataset.arrastoOrigem = alvo.tipo === 'trocar' ? 'esmaece' : 'colapsa';
}

/** Fim do gesto, por qualquer porta (drop, dragend, rede do pointerdown). Idempotente. */
function encerrarArrasto() {
  limparPreview();
  arrastoAba = null;
  if (repinturaAdiada) {
    repinturaAdiada = false;
    desenharAbas();
  }
}

/** O arrasto é de uma ABA desta tela (tipo próprio), não de arquivo. */
function ehArrastoDeAba(evento) {
  return [...(evento.dataTransfer?.types || [])].includes(TIPO_ARRASTO_ABA);
}

/**
 * Abre o PAINEL de um job — irmã de `abrirAba` (§7.3 do plano), não um parâmetro dela: um
 * job não tem `sessaoId` (`marcarLido`), não casa `abasDoProjeto` (`atualizarFaixaJobs`), não
 * tem caixa de escrita (`pintarDica`, `entrada.focus()` chamaria o teclado do celular numa
 * tela sem escrita). Enfiar isso em `abrirAba` seria a armadilha #40 pela porta dos fundos.
 *
 * No desktop o job abre AO LADO do que já está na tela (o mesmo caminho de `aoLado: true` em
 * `abrirAba` — split view de graça, D40); no celular só existe um painel por vez, e o caminho
 * é `trocarConjunto`, como `abrirAba` sem `aoLado`.
 */
async function abrirJob(id) {
  const chave = `job-${id}`;
  const jaAberta = paineis.has(chave);
  if (jaAberta) {
    // 🔴 O ramo "já aberta" NÃO é opcional (§4.2). Sem ele, o segundo clique cairia em
    // `trocarConjunto([chave])`, que tira TODOS os outros painéis e PULA a criação deste
    // (`paineis.has` já é `true`) — e portanto nunca chama `focar`: `atual` ficaria
    // apontando para uma chave que acabou de ser removida da tela.
    focar(paineis.get(chave));
    if (!fluxo) religarFluxo();
  } else if (!matchMedia('(max-width: 760px)').matches) {
    const painel = criarPainel(chave, undefined);
    focar(painel);
    religarFluxo();
  } else {
    trocarConjunto([chave]);
  }

  // 🔴 `desenharAbas()` tem de estar aqui: é ela que redesenha `#abas` (grupo de jobs
  // incluído) — sem ela, `linha.dataset.aberta` (§4.3) só acenderia no ciclo de 15 s.
  desenharAbas();

  $('vazio').hidden = true;
  empilharConversa();
  app.dataset.vista = 'chat';
}

// ── Recarregar na mão ───────────────────────────────────────────────────
//
// "Às vezes buga" e não havia como forçar uma atualização sem fechar o app inteiro. O que
// este botão NÃO é: `location.reload()`. Recarregar a página derruba o que estava digitado
// na caixa e os anexos já escolhidos — justo no celular, onde redigitar é o pior castigo.
// O que ele faz é refazer o caminho que a tela já tem: a lista, ou o fluxo da conversa.

/**
 * Religa o cano com a MESMA lista de abas — substitui `reabrirAba()` (R26 da spec).
 *
 * Honestidade sobre o alcance: como o cano é um só, religar reemite `sessao` para TODOS os
 * painéis abertos, não só o do botão — em fase 2 isso é sempre o mesmo painel, então não há
 * o que notar; a fase 3 é quem sente essa diferença. O que sobrevive: o rascunho, os anexos e
 * a posição de rolagem de cada painel (a fita é reconstruída do disco, como em qualquer
 * reconexão do `EventSource`).
 */
async function recarregarPainel(painel) {
  // A lista de anexos NÃO sai do lugar durante o `await` (card foto-some-entre-upload-e-envio):
  // a troca por `[]` era resto do `reabrirAba()` antigo, que recriava a conversa. Com o envio
  // que espera a foto subir, um upload terminando nessa janela mandava o texto sem ela. O selo
  // continua subindo — o envio recuperável (R11) conta com isso.
  painel.seloComposicao += 1;
  await carregarAbas();
  try {
    religarFluxo();
  } finally {
    desenharAnexos(painel);
  }
}

/**
 * Roda `tarefa` mostrando no PRÓPRIO botão que ela está rodando.
 *
 * Nada de "modo recarregando" global nem véu de página inteira: o resto da tela continua
 * legível e clicável enquanto isto anda. O retorno visual é o `data-recarregando` que o CSS
 * gira, e ele também é a trava contra dedo duplo — dois toques não abrem dois fluxos.
 */
async function recarregar(botao, tarefa) {
  if (botao.dataset.recarregando === '1') return;
  botao.dataset.recarregando = '1';
  try {
    await tarefa();
  } finally {
    botao.dataset.recarregando = '';
  }
}

// ── Conversa ────────────────────────────────────────────────────────────

/** Limpa a fita DO PAINEL `P` (a "regra do dono" — ver a declaração de `P` no topo). */
function limparFita() {
  idiomaUI.bind(P.fita, 'textContent', () => tr(''));
  P.destinoFita = null;
  P.desenhandoDeFora = false;
  P.pendentes = [];
  P.ultimaHora = null;   // fita nova, minuto nenhum desenhado ainda
  P.grupoFerramentas = null;
  P.ferramentaSolta = null;
  // O `/status` do Codex (develop, 08/09) guardava estes quatro em variáveis de MÓDULO. São
  // estado de CONVERSA — com N painéis, o bloco de status do painel B apareceria no A e a
  // dedupe por `id` de um comeria a do outro. Mesma regra do resto do arquivo: campo do painel.
  P.statusCodexSessao = null;
  P.statusCodexGeracao += 1;
  P.statusCodexEl = null;      // o bloco "Resultados de /status" é reconstruído pelo replay do SSE
  P.statusCodexIds = new Set();
  // O chip `início` (card `carregar-mais-historico`): um `/clear` ou uma reconexão do
  // `EventSource` não pode deixar o painel apontando para a âncora da conversa velha
  // (armadilha #33). `geracaoHistorico` INCREMENTA, nunca zera — é o que descarta uma
  // resposta em voo mesmo quando a âncora nova por acaso é igual à antiga.
  P.inicioDoHistorico = 0;
  P.carregandoHistorico = false;
  P.geracaoHistorico += 1;
  P.sessaoDaConversa = null;
  P.marcaDeInicio = null;
  P.replayAntigo = false;
}

/**
 * Onde o desenho cai AGORA — a fita de verdade do painel `P`, ou um DocumentFragment fora
 * da página.
 *
 * Abrir uma aba despeja o histórico de uma vez, evento por evento. Com cada um indo direto
 * para a fita viva, o navegador refazia layout e rolava a cada evento, e no celular a
 * conversa inteira desfilava na frente do usuário antes de dar para digitar. Durante essa
 * rajada o desenho vai para um fragmento, que não está na página e por isso não custa
 * layout nenhum; ele entra de uma vez só quando chega o `sincronizado`, com uma rolagem só.
 * Depois disso é a fita de verdade de novo, evento a evento, como sempre foi.
 */
function fita() {
  return fitaDe(P);
}

/** Começa a rajada: daqui até o `sincronizado`, nada do que for desenhado toca a página. */
function segurarFita() {
  P.destinoFita = document.createDocumentFragment();
}

/**
 * Despeja a rajada do painel `P` na fita de verdade — e restaura a rolagem de onde o usuário
 * estava, em vez de sempre pular para o fim (R31/R33 da spec de 08/09: o guardado vem de
 * `painel.rolagemGuardada`, capturado no `case 'sessao'` ANTES do `limparFita()`, e cobre
 * religar, a reconexão automática do `EventSource` e o `/clear` — os três recriam a rajada
 * pelo mesmo caminho).
 */
function despejarFita() {
  if (!P.destinoFita) return;
  const pronto = P.destinoFita;
  P.destinoFita = null;
  // O histórico inteiro entra de uma vez, e é isso que o `data-pintando` cobre: sem ele a
  // caixa tem `scroll-behavior: smooth` e ir ao fim ANIMA a rolagem — a conversa inteira
  // desfilando na frente do usuário, que foi exatamente o que se viu no celular. As bolhas
  // também não podem tocar o `@keyframes entrar`: 60 elementos animando de uma vez é a
  // mesma cena por outro caminho.
  const caixa = P.mensagens;
  caixa.dataset.pintando = '1';
  P.fita.append(pronto);
  const guardado = P.rolagemGuardada;
  caixa.scrollTop = (!guardado || guardado.noFim) ? caixa.scrollHeight : guardado.scrollTop;
  // rAF quando existe navegador; o gate roda este arquivo fora de um, e lá o setTimeout
  // faz o mesmo papel de "no próximo respiro".
  const proximoQuadro = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);
  proximoQuadro(() => { delete caixa.dataset.pintando; });
}

// Quantos pixels de folga ainda contam como "está no fim". Serve aos DOIS lugares que
// preservam a posição do usuário: a fita da conversa (aqui) e a tela da pane (`pintarTelaDaPane`).
const FOLGA_FIM = 24;

function rolarFim(painel) {
  const caixa = painel.mensagens;
  caixa.scrollTop = caixa.scrollHeight;
}

/**
 * Rola ao fim SÓ se o usuário já estava lá.
 *
 * Evento do agente não é gesto dele. Enquanto o turno rodava, CADA evento do fluxo chamava
 * `rolarFim()` sem perguntar nada, e a vista era arrastada de volta ao fim no meio da
 * leitura — ler o histórico com o agente trabalhando era impossível na prática. A regra
 * certa já existia neste arquivo desde 28/08, mas só para a tela da pane
 * (`pintarTelaDaPane`); a fita nunca a recebeu.
 *
 * Os OUTROS chamadores de `rolarFim` continuam incondicionais de propósito: enviar
 * mensagem, o "trabalhando" nascendo e as bolhas de erro são gestos DELE ou respostas
 * diretas a um gesto dele — ali ir ao fim é o certo.
 */
function rolarFimSeGrudado(painel, estavaNoFim) {
  if (estavaNoFim) rolarFim(painel);
}

/**
 * Estava colado no fim? A pergunta tem que ser feita ANTES de o evento desenhar.
 *
 * Medir depois é medir o mundo errado: o bloco novo já está na fita, o `scrollHeight` já
 * cresceu, e a distância até o fim virou a ALTURA DO BLOCO — sempre maior que a folga.
 * Quem estava acompanhando ao vivo era classificado como "está lendo" e a fita parava de
 * seguir sozinha, justo quando chega raciocínio ou comando (08/09). O gate não pegava
 * porque o DOM falso congelava o `scrollHeight`.
 *
 * Recebe o painel (§4.7 da spec): com N painéis cada um tem a SUA caixa de rolagem, e medir
 * a régua na caixa errada é o defeito de `b9799bf` de volta, multiplicado.
 */
function estaNoFim(painel) {
  const caixa = painel.mensagens;
  return caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight <= FOLGA_FIM;
}

/**
 * M5 (04/09): bolha longa recolhe — o dono ÚNICO do texto da bolha, chamado pelos DOIS
 * caminhos que escrevem nela (`bolha()`, no desenho, e `absorverPendente`, na absorção —
 * R3: sem os dois, a absorção reescreveria um `<details>` já montado e o recolhimento
 * sumiria sozinho, só na mensagem que voltou do disco).
 *
 * A conta é só QUEBRA DE LINHA (P8) — nada de altura pintada, que nem o DOM de mentira nem
 * o navegador sabem medir sem layout. `\n` no fim conta como linha (o `split` dá duas), e é
 * assim mesmo: o texto TEM duas linhas na tela.
 */
function pintarTextoDaBolha(el, texto) {
  const linhas = String(texto).split('\n');
  if (linhas.length <= 12) { el.textContent = texto; return; }
  idiomaUI.bind(el, 'textContent', () => tr(''));
  const det = document.createElement('details');
  det.className = 'bolha-longa';
  const sum = document.createElement('summary');
  idiomaUI.bind(sum, 'textContent', () => tr('ver tudo'));
  det.append(sum, texto);
  el.append(det);
}

function bolha(classe, texto, quando) {
  // `bolha()` é a única função de desenho que entra na fita SEM passar por evento — o envio
  // do usuário e os recados de erro (parar, apertar, anexo, pergunta aberta) a chamam direto,
  // fora do `aplicar()`. O ponto do topo de `aplicar()` não alcança esses seis chamadores;
  // este encerra o grupo para eles. Redundante nos caminhos que vêm de evento — e redundante
  // é no-op (D2b).
  encerrarGrupoFerramentas();
  // A hora vem ANTES da bolha: quando ela aparece, é o cabeçalho do minuto que começa ali.
  const hora = marcarHora(quando, classe === 'bolha-eu' ? 'eu' : 'agente');
  const div = document.createElement('div');
  div.className = P.desenhandoDeFora ? `${classe} de-fora` : classe;
  pintarTextoDaBolha(div, texto);
  // Quem absorve a bolha pendente precisa achar a hora dela para corrigir o rótulo.
  // Fica pendurado na bolha e não numa lista à parte: quem tem a bolha tem a hora.
  div.horaEl = hora;
  fita().append(div);
  return div;
}

// ── Hora das mensagens ──────────────────────────────────────────────────
//
// O `.jsonl` grava `timestamp` em ISO 8601 UTC, e `lib/externo.js` o propaga como `quando`
// nos eventos de conversa. Quem formata é AQUI, no aparelho: quem lê pode estar em outro
// fuso, e a hora tem que bater com o relógio que ele está olhando, não com o do servidor.
//
// A hora não entra DENTRO da bolha por dois motivos. Empurraria o texto, e no celular a
// largura é o recurso escasso. E quem absorve a bolha pendente reescreve o `textContent`
// dela — um <span> lá dentro sumiria junto, que foi a lição do selo "na fila".
//
// E ela não aparece em toda bolha: numa conversa de 60 bolhas isso vira poluição. Só
// quando o MINUTO muda, e aí ela é o cabeçalho do grupo que começa ali.

/** O rótulo `HH:MM` no fuso do APARELHO, ou null se a hora não der para ler. */
function horaLocal(quando) {
  if (quando === undefined || quando === null || quando === '') return null;
  const data = new Date(quando);
  if (Number.isNaN(data.getTime())) return null;
  return data.toLocaleTimeString(idiomaUI.idioma, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Desenha a hora se ela mudou de minuto desde a última. Devolve o elemento, ou null
 * quando não havia o que desenhar — evento sem `quando` (arquivo velho, linha torta)
 * cai aqui e a bolha sai como sempre saiu, sem hora e sem quebrar.
 *
 * `ultimaHora` é do PAINEL `P` — cada conversa tem o próprio "último minuto desenhado".
 */
function marcarHora(quando, lado) {
  const rotulo = horaLocal(quando);
  if (!rotulo || rotulo === P.ultimaHora) return null;
  P.ultimaHora = rotulo;
  const el = document.createElement('time');
  el.className = 'hora-fita';
  el.dataset.lado = lado;
  el.setAttribute('datetime', new Date(quando).toISOString());
  el.textContent = rotulo;
  fita().append(el);
  return el;
}

/**
 * A bolha pendente nasceu com a hora do ENVIO, porque o disco ainda não tinha nada — e é
 * essa mesmo que tem que aparecer enquanto ela espera na fila. Quando o evento volta do
 * CLI ele traz a hora de verdade; se caiu noutro minuto, o rótulo é reescrito no lugar.
 *
 * `ultimaHora` NÃO se mexe aqui: entre o envio e a volta do disco pode ter entrado fala do
 * agente, e mudá-la apagaria a hora da mensagem seguinte.
 */
function corrigirHora(el, quando) {
  const rotulo = horaLocal(quando);
  if (!el || !el.horaEl || !rotulo) return;
  el.horaEl.textContent = rotulo;
  el.horaEl.setAttribute('datetime', new Date(quando).toISOString());
}

// ── Bolha pendente ──────────────────────────────────────────────────────
//
// O problema: a mensagem do usuário aparecia DUAS vezes. O cockpit desenha a bolha na hora
// do envio (senão o celular parece travado enquanto o `send-keys` sobe), e ~1s depois o
// CLI grava o mesmo prompt no .jsonl — o SSE devolve o MESMO texto como evento `humano` e
// desenhava outra bolha embaixo.
//
// A saída: a bolha desenhada na hora fica MARCADA como pendente, e o evento que casar com
// ela ABSORVE a bolha em vez de criar uma segunda.

const MS_PENDENTE = 60000;

/**
 * Marca a bolha que o cockpit acabou de desenhar como "ainda esperando voltar do disco".
 *
 * `em` é parâmetro e não `Date.now()` fixo porque quem sabe QUANDO a mensagem saiu é quem
 * a mandou — e é isso que deixa o gate exercitar a expiração sem esperar um minuto.
 *
 * `naFila` é o recado de 22/08: dá para escrever com o turno rodando, e nesse caso a
 * mensagem não está sendo respondida agora — está esperando o turno acabar, exatamente
 * como no terminal. O selo é CSS puro (`[data-fila]::before`), não um nó dentro da bolha:
 * quem absorve reescreve o `textContent` dela, e um selo de verdade sumiria junto.
 */
function marcarPendente(el, texto, em = Date.now(), naFila = false, id = null) {
  el.className += ' bolha-pendente';
  if (naFila) el.dataset.fila = '1';
  // `id` (D-n) é a chave da dedupe do aviso ao vivo (D-m) — dado do envio, `null` quando
  // não veio nenhum. `ocioso` é semeado com `em` (nunca `Date.now()` nem `naFila`): no
  // caminho local os dois são a mesma coisa, e é isso que mantém de pé o teste de expiração
  // que já existe (`marcarPendente(el, 'sumiu', Date.now() - 61000)`,
  // testes/gate-ui.js:761) — ele fabrica a idade pelo `em`, exatamente como este comentário
  // sempre disse que dava. `naFila` diria "ocupada" numa aba parada (é sempre `true` numa
  // pendente reemitida, D-g) e estragaria a régua de ociosidade da D-d.
  const p = { el, texto: String(texto).trim(), em, id, ocioso: P.ocupado ? null : em, soltou: false };
  P.pendentes.push(p);
  // Pendurado no elemento, não numa lista à parte: quem tem a bolha tem a ficha — mesmo
  // idioma do `div.horaEl` (public/app.js:938).
  el.fichaPendente = p;
  return el;
}

/**
 * A pendente venceu? Mede OCIOSIDADE da aba, nunca tempo de parede (D-d) — enquanto o turno
 * está rodando (`ocioso === null`) ela não envelhece, por mais longo que o turno seja: é o
 * que consertou o defeito B (uma mensagem "na fila" de verdade não pode expirar só porque o
 * agente demorou). `p.em` NUNCA entra aqui: ele pode ser do relógio do SERVIDOR (numa
 * pendente reemitida), e comparar isso com o `Date.now()` do aparelho é a armadilha #35 ao
 * pé da letra (D-i).
 */
function pendenteVencida(p, agora) {
  return p.ocioso !== null && agora - p.ocioso > MS_PENDENTE;
}

// DUPLICADA em `lib/abas.js` — o navegador não faz `require`; a paridade é trancada no
// `gate-ui`. Mudou aqui, muda lá.
//
// A forma "para casar": linha em branco fora, espaço solto no fim de cada linha fora. É o que
// o CLI colapsa sozinho quando a colagem vem junto de uma foto (armadilha #84).
function formaDeCasar(texto) {
  return String(texto || '').split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n').trim();
}
// O grau do casamento: 1 = idêntico, 2 = igual sem linha em branco (ou sem o espaço do "!"
// inicial), 3 = termina igual sem linha em branco (#21: foto/rascunho na frente), 0 = não casa.
// Menor é melhor.
function casaComEnviado(doDisco, enviado) {
  const cru = String(doDisco || '').trim();
  const alvo = String(enviado || '').trim();
  if (!cru || !alvo) return 0;
  if (cru === alvo) return 1;
  const a = formaDeCasar(cru);
  const b = formaDeCasar(alvo);
  if (!a || !b) return 0;
  // "! cmd" que passou pela fila do CLI volta "!cmd" (#95).
  if (a === b || a.replace(/^! +/, '!') === b.replace(/^! +/, '!')) return 2;
  return a.endsWith(b) ? 3 : 0;
}

/**
 * Acha a bolha pendente que casa com o texto que voltou do disco, desmarca e devolve.
 * Sem par, devolve null — e aí o evento vira bolha nova, como sempre foi.
 *
 * O casamento é por GRAU (`casaComEnviado`, acima), menor primeiro, empate → a mais antiga:
 * `send-keys` CONCATENA com o que já estivesse digitado na aba (armadilha #21), então o que
 * volta pode ser "<rascunho do usuário><o que eu mandei>" — e desde o CLI 2.1.280 uma colagem
 * com foto ainda colapsa a linha em branco do texto (armadilha #84). Exato primeiro evita que
 * essa tolerância roube a pendente CERTA numa colisão de duas mensagens parecidas.
 *
 * Pendente que nunca casa — a aba engoliu o texto, o CLI morreu no meio — não pode ficar
 * presa para sempre: passados 60s ela volta a ser bolha normal e não absorve mais nada.
 */
function absorverPendente(texto, quando) {
  const agora = Date.now();
  const alvo = String(texto).trim();
  const vivas = [];
  for (const p of P.pendentes) {
    if (pendenteVencida(p, agora)) { desmarcarPendente(p.el); continue; }
    vivas.push(p);
  }
  let achada = null;
  let grauAchada = 4;
  for (const p of vivas) {
    // `soltou` (D-l): o POST dela foi recusado, a bolha já perdeu o selo e virou bolha
    // comum ao lado do erro. Ela NÃO absorve mais nada — mas continua na lista, porque a
    // dedupe por `id` do aviso ao vivo (D-m) ainda precisa enxergá-la.
    if (p.soltou || !alvo) continue;
    const grau = casaComEnviado(alvo, p.texto);
    if (grau && grau < grauAchada) { achada = p; grauAchada = grau; }
  }
  P.pendentes = achada ? vivas.filter((p) => p !== achada) : vivas;
  if (!achada) return null;
  desmarcarPendente(achada.el);
  // A hora do envio dá lugar à do disco, no mesmo ponto em que a bolha vira definitiva.
  corrigirHora(achada.el, quando);
  return achada.el;
}

function desmarcarPendente(el) {
  el.className = String(el.className).replace(/ ?bolha-pendente/, '');
  // O evento voltou do disco: a mensagem saiu da fila e virou turno. O selo sai com ela.
  delete el.dataset.fila;
}

/** Régua que abre e fecha o trecho que passou por fora do cockpit. */
function marcaDeFora(quando) {
  const div = document.createElement('div');
  div.className = 'corte corte-fora';
  const rotulo = document.createElement('span');
  rotulo.className = 'corte-rotulo';
  idiomaUI.bind(rotulo, 'textContent', () => tr('terminal'));
  const nota = document.createElement('span');
  nota.className = 'corte-nota';
  idiomaUI.bind(nota, 'textContent', () => tr(quando
    ? tr`esta parte foi conversada fora do cockpit, em ${new Date(quando).toLocaleString(idiomaUI.idioma)}`
    : tr('esta parte foi conversada fora do cockpit')));
  div.append(rotulo, nota);
  fita().append(div);
}

// Ícone e alvo dão ao cartão de ferramenta a informação que importa de relance:
// o que foi feito e em quê. O resto continua recolhido.
const ICONES = {
  Read: '▤', NotebookRead: '▤',
  Write: '✎', Edit: '✎', NotebookEdit: '✎',
  Bash: '$', BashOutput: '$', KillShell: '$',
  Grep: '⌕', Glob: '⌕',
  WebFetch: '↗', WebSearch: '↗',
  Task: '⛶', Agent: '⛶', Skill: '◆', TodoWrite: '☑', TaskCreate: '☑', TaskUpdate: '☑',
};

function alvoDaFerramenta(entrada) {
  if (!entrada) return '';
  if (typeof entrada === 'string') return entrada.split('\n')[0];
  if (entrada.command) return String(entrada.command).split('\n')[0];
  if (entrada.file_path) return encurtarCaminho(entrada.file_path);
  if (entrada.pattern) return entrada.pattern + (entrada.path ? `  em ${encurtarCaminho(entrada.path)}` : '');
  if (entrada.url) return entrada.url;
  if (entrada.query) return entrada.query;
  if (entrada.skill) return entrada.skill;
  if (entrada.description) return entrada.description;
  if (entrada.prompt) return String(entrada.prompt).split('\n')[0].slice(0, 90);
  return '';
}

function resumirEntrada(entrada) {
  if (!entrada) return '';
  if (typeof entrada === 'string') return entrada;
  if (entrada.command) return entrada.command;
  if (entrada.file_path) return entrada.file_path + (entrada.content ? `\n\n${entrada.content}` : '');
  return JSON.stringify(entrada, null, 2);
}

/** Chamada de ferramenta: bastidor. Fica recolhida para não competir com a conversa. */
function blocoFerramenta(evento) {
  const det = document.createElement('details');
  det.className = P.desenhandoDeFora ? 'ferramenta de-fora' : 'ferramenta';
  det.dataset.ferramentaId = evento.id || '';
  det.dataset.estado = 'rodando';
  if (evento.t) det.dataset.t = evento.t;
  // A marca de subagente TAMBÉM vai no cartão de ferramenta (§4.5 item 6 do plano): num job,
  // ferramenta é o que domina a fita — sem a marca aqui, a cauda ficaria cheia de cartões
  // anônimos, e é justamente neles que a tabela de riscos apoia a mitigação declarada.
  if (evento.sub) det.dataset.sub = evento.sub;

  const sum = document.createElement('summary');

  const icone = document.createElement('span');
  icone.className = 'fer-icone';
  icone.textContent = ICONES[evento.nome] || '◇';

  const nome = document.createElement('span');
  nome.className = 'fer-nome';
  nome.textContent = evento.nome;

  const alvo = document.createElement('span');
  alvo.className = 'fer-alvo';
  alvo.textContent = alvoDaFerramenta(evento.entrada);

  const estado = document.createElement('span');
  estado.className = 'fer-estado';
  estado.textContent = '·';

  sum.append(icone, nome, alvo, estado);
  // O NOME do subagente, visível — não só o `data-sub` de cima. A tabela de riscos do plano
  // justifica contar os dois lados na cauda dizendo que "40 passos rotulados └ executor-plano
  // contam a verdade", e passo, na fita, é ESTE cartão: sem o rótulo aqui, a mitigação
  // declarada não existia (achado do painel de execução, 12/09). `data-sub` continua sendo o
  // que o CSS e o gate leem; este é o que o olho lê.
  if (evento.sub) {
    const marca = document.createElement('span');
    marca.className = 'fer-sub';
    marca.textContent = `└ ${evento.subNome || 'subagente'}`;
    sum.append(marca);
  }
  det.append(sum);

  const pre = document.createElement('pre');
  pre.textContent = resumirEntrada(evento.entrada);
  det.append(pre);

  // Decisão de destino (D2): grupo vivo → entra nele; ferramenta solta viva → nasce o
  // grupo, promovendo a solta; senão → o caminho de hoje, intacto.
  if (P.grupoFerramentas) {
    entrarNoGrupo(det);
  } else if (P.ferramentaSolta) {
    abrirGrupo(P.ferramentaSolta);
    entrarNoGrupo(det);
  } else {
    fita().append(det);
    P.ferramentaSolta = det;
  }
  return det;
}

const CORTES = {
  clear: tr('contexto zerado daqui para baixo — o agente não lembra do que está acima'),
  compact: tr('conversa resumida aqui — daqui para cima o agente só tem o resumo'),
};

/** Régua no meio da fita marcando onde a memória do agente foi cortada. */
function marcaDeCorte(qual, texto) {
  const div = document.createElement('div');
  div.className = 'corte';
  const rotulo = document.createElement('span');
  rotulo.className = 'corte-rotulo';
  rotulo.textContent = `/${qual}`;
  const nota = document.createElement('span');
  nota.className = 'corte-nota';
  idiomaUI.bind(nota, 'textContent', () => tr(CORTES[qual] || texto));
  div.append(rotulo, nota);
  fita().append(div);
  return div;
}

/**
 * Régua no topo da fita: o arquivo do CLI era grande demais e só a cauda foi carregada — e,
 * a partir do card `carregar-mais-historico`, o botão que pede o lote anterior.
 *
 * Sem ela a conversa simplesmente começa no meio de um assunto, e não há como distinguir
 * "foi só isto que aconteceu" de "o resto ficou de fora". Discreta de propósito: é um
 * aviso, não um erro.
 *
 * Três leituras de `inicio`, e a distinção importa — é o que dispensa uma função "marca de
 * fim" própria (a spec trata "fim" como um ESTADO desta marca, não como irmã dela):
 *   `inicio > 0`    → a nota de sempre, COM o botão (há histórico atrás)
 *   `inicio === 0`  → "este é o começo da conversa", sem botão
 *   `undefined`     → a nota de sempre, sem botão — o evento sem âncora que
 *                     `gate-ui.js:1096` e `:2283` aplicam
 */
function marcaDeInicio(inicio) {
  const div = document.createElement('div');
  div.className = 'corte corte-inicio';
  const rotulo = document.createElement('span');
  rotulo.className = 'corte-rotulo';
  idiomaUI.bind(rotulo, 'textContent', () => tr('início'));
  const nota = document.createElement('span');
  nota.className = 'corte-nota';
  const textoDaNota = inicio === 0
    ? 'este é o começo da conversa'
    : 'o começo do histórico não foi carregado — só a parte mais recente está aqui';
  idiomaUI.bind(nota, 'textContent', () => tr(textoDaNota));
  div.append(rotulo, nota);
  if (inicio > 0) {
    // O painel é CAPTURADO aqui, na construção do botão — não no instante do clique. `P` no
    // instante do clique é o último painel que recebeu evento do SSE, não necessariamente o
    // dono deste botão (split view): `onclick = () => carregarMaisHistorico(P)` leria o
    // painel ERRADO.
    const dono = P;
    const botao = document.createElement('button');
    botao.className = 'corte-mais';
    botao.type = 'button';
    idiomaUI.bind(botao, 'textContent', () => tr('carregar mais'));
    botao.onclick = () => carregarMaisHistorico(dono);
    div.append(botao);
  }
  fita().append(div);
  P.marcaDeInicio = div;
  return div;
}

/**
 * Troca o texto do botão e da nota do elemento guardado em `painel.marcaDeInicio` — os
 * quatro estados que NÃO são a marca recém-desenhada (`marcaDeInicio`) ganham UMA função só,
 * nunca uma cada. `ancoraMorta()`/`estadoErro()` não existem e não devem ser criadas.
 *
 * Os textos saem por `idiomaUI.bind`, nunca `textContent` cru — senão o rótulo fica em
 * português no inglês, e nenhum gate de hoje pega isso além do H14.
 */
const TEXTOS_ESTADO_MARCA = {
  parado: {
    nota: 'o começo do histórico não foi carregado — só a parte mais recente está aqui',
    botao: true, rotulo: 'carregar mais', desabilitado: false,
  },
  carregando: {
    nota: 'o começo do histórico não foi carregado — só a parte mais recente está aqui',
    botao: true, rotulo: 'carregando…', desabilitado: true,
  },
  erro: {
    nota: 'o começo do histórico não foi carregado — só a parte mais recente está aqui',
    botao: true, rotulo: 'tentar de novo', desabilitado: false,
  },
  morta: {
    nota: 'a conversa mudou — recarregue',
    botao: false, rotulo: null, desabilitado: true,
  },
};
function pintarEstadoDaMarca(painel, estado) {
  const marca = painel.marcaDeInicio;
  if (!marca) return;
  const cfg = TEXTOS_ESTADO_MARCA[estado];
  const nota = marca.querySelector('.corte-nota');
  if (nota) idiomaUI.bind(nota, 'textContent', () => tr(cfg.nota));
  const botao = marca.querySelector('.corte-mais');
  if (botao) {
    botao.hidden = !cfg.botao;
    botao.disabled = cfg.desabilitado;
    if (cfg.rotulo) idiomaUI.bind(botao, 'textContent', () => tr(cfg.rotulo));
  }
}

/**
 * O clique no botão `.corte-mais` — pede à `GET /api/historico` o lote ANTERIOR ao que já
 * está na tela.
 *
 * `painel` é o CAPTURADO no fecho do `onclick` de `marcaDeInicio`, nunca lido de `P`: fora do
 * bloco síncrono de `desenharLoteAntigo`, `P` não é lido para NADA — nem para a geração. Ler
 * `++P.geracaoHistorico` antes do `await` incrementaria a geração do painel VIZINHO no split.
 */
async function carregarMaisHistorico(painel) {
  if (painel.carregandoHistorico || !painel.inicioDoHistorico) return;
  painel.carregandoHistorico = true;
  pintarEstadoDaMarca(painel, 'carregando');
  const ate = painel.inicioDoHistorico;
  // A geração é do painel CAPTURADO, nunca de `P`.
  const geracao = ++painel.geracaoHistorico;
  try {
    const sessao = painel.sessaoDaConversa ? `&sessao=${encodeURIComponent(painel.sessaoDaConversa)}` : '';
    const r = await api(`api/historico?chave=${encodeURIComponent(painel.chave)}&ate=${ate}${sessao}`);
    // O único `await` da função ficou para trás: uma resposta de geração vencida (um
    // `limparFita()` correu no meio) é descartada AQUI, antes de tocar a fita.
    if (painel.geracaoHistorico !== geracao) return;
    desenharLoteAntigo(painel, r);
  } catch (e) {
    if (painel.geracaoHistorico !== geracao) return;
    pintarEstadoDaMarca(painel, e.status === 409 ? 'morta' : 'erro');
  } finally {
    // O `finally` TAMBÉM confere a geração: um `painel.carregandoHistorico = false`
    // incondicional deixaria a bandeira falsa enquanto um pedido NOVO ainda está em voo —
    // pedido antigo → `limparFita()` → pedido novo → a resposta antiga chega e libera a
    // guarda do novo (achado do painel, Codex [Média] #3).
    if (painel.geracaoHistorico === geracao) painel.carregandoHistorico = false;
  }
}

/**
 * Desenha o lote antigo por cima da fita — SÍNCRONA do começo ao fim, sem `await` nenhum no
 * meio: é o que garante que nenhum evento do SSE ao vivo possa ser desviado para dentro do
 * fragmento deste lote (armadilha #47, pelo caminho do `destinoFita`).
 */
function desenharLoteAntigo(painel, r) {
  const antes = painel.mensagens.scrollHeight;
  const salvo = {
    ultimaFala: painel.ultimaFala, grupoFerramentas: painel.grupoFerramentas,
    ferramentaSolta: painel.ferramentaSolta, ultimaHora: painel.ultimaHora,
    desenhandoDeFora: painel.desenhandoDeFora, destinoFita: painel.destinoFita,
  };
  // A marca SE MOVE, não duplica — mas ela só sai DEPOIS de a nova entrar na fita (lá
  // embaixo, junto do `prepend`). Removê-la aqui, antes do desenho, deixava o usuário SEM o
  // chip e SEM o botão se o desenho estourasse: o `finally` restaura os campos salvos, e a
  // marca não é um deles — `pintarEstadoDaMarca(…, 'erro')` pintaria um nó fora do documento
  // e o erro não apareceria em lugar nenhum (achado do painel de execução, os dois modelos).
  const marcaAntiga = painel.marcaDeInicio;
  let entrou = false;
  noPainel(painel, () => {
    try {
      painel.ultimaFala = null;
      painel.grupoFerramentas = null;
      painel.ferramentaSolta = null;
      painel.ultimaHora = null;
      painel.desenhandoDeFora = false;
      painel.replayAntigo = true;
      segurarFita();
      // PRIMEIRO no fragmento ⇒ topo do lote, depois de prependado.
      marcaDeInicio(r.cortado ? r.inicio : 0);
      for (const evento of r.eventos) aplicarNoPainel(painel, evento);
      encerrarGrupoFerramentas(); // fecha um grupo de ferramenta aberto no fim do lote
      const fragmento = painel.destinoFita;
      painel.destinoFita = null;
      painel.mensagens.dataset.pintando = '1';
      painel.fita.prepend(fragmento); // na FITA, não na `mensagens`
      // SÓ AGORA a marca velha sai: a nova já está na fita, e ninguém chega a ver as duas
      // (isto é síncrono). Falhou antes daqui? A velha continua na tela, com o botão.
      marcaAntiga?.remove();
      entrou = true;
    } finally {
      // Devolve tudo, inclusive `destinoFita` — no painel CAPTURADO, nunca em `P` (armadilha
      // #47: restaurar em `P` deixaria o painel A com o destino setado se `P` tivesse mudado).
      Object.assign(painel, salvo);
      painel.replayAntigo = false;
      // O ponteiro volta para a marca que está NA TELA. Sem isto, depois de uma exceção ele
      // apontaria para a marca nova — que ficou dentro do fragmento, fora do documento — e o
      // estado de erro seria pintado onde ninguém vê.
      if (!entrou) painel.marcaDeInicio = marcaAntiga;
    }
  });
  // Nada abaixo daqui roda se o desenho estourou: a exceção sobe para o `catch` do
  // `carregarMaisHistorico`, que pinta o estado de erro na marca que sobreviveu.
  painel.inicioDoHistorico = r.cortado ? r.inicio : 0;
  const depois = painel.mensagens.scrollHeight;
  painel.mensagens.scrollTop += (depois - antes);
  const proximoQuadro = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);
  proximoQuadro(() => { delete painel.mensagens.dataset.pintando; });
}

/**
 * O prompt gravado em disco carrega um cabeçalho `[anexo] /caminho` que existe para o
 * AGENTE saber onde estão os arquivos. Na tela isso é ruído: o usuário escreveu a frase,
 * não os caminhos. Separa um do outro para a bolha mostrar só o que ele digitou.
 *
 * Desde que foto vira `[Image #N]` na frente da mensagem (CLI 2.1.258), a linha `[anexo]`
 * correspondente perde o caminho — só resta a ORDEM (N tokens ↔ N linhas, medido no caso real
 * de 4 fotos, card fila-presa-com-colagem-embrulhada). Por decisão (spec §4.3): a bolha
 * RECARREGADA do disco mostra o clipe como `📎 Image #N`, não o nome do arquivo — o CLI
 * apagou o caminho da fala, e costurá-lo de volta é escopo novo. A bolha AO VIVO (evento
 * `pendente`) continua com o nome de sempre, porque usa `evento.mensagem`, não este caminho.
 */
function separarAnexos(texto) {
  const casou = String(texto).match(/^((?:\[Image #\d+\]\s*)*)((?:\[anexo\][^\n]*\n)+)\n?Os arquivos acima[^\n]*\n\n?([\s\S]*)$/);
  if (!casou) return { texto, anexos: [] };
  const imagens = casou[1].match(/Image #\d+/g) || [];
  let proxima = 0;
  const anexados = casou[2].trim().split('\n').map((l) => {
    const caminho = l.replace(/^\[anexo\]\s*/, '');
    return caminho ? caminho.split('/').pop() : (imagens[proxima++] || 'anexo');
  });
  return { texto: casou[3], anexos: anexados };
}

// ── Ferramentas agrupadas ──────────────────────────────────────────────
//
// Ferramentas seguidas viram um grupo só (ver D2/D2b). `ferramentaSolta` é a ponte: a
// primeira de uma sequência já foi desenhada como cartão solto quando a segunda chega, e é
// ela que vira o primeiro passo do grupo. `ultimaFala`, `grupoFerramentas` e
// `ferramentaSolta` são do PAINEL `P` — ver a declaração de `P` no topo do arquivo.

// A forma EXATA do estado do grupo. Não há `primeiroT`/`ultimoT`: as duas pontas do tempo são
// derivadas dos passos a cada `atualizarResumoGrupo` (ver D3), justamente para não existirem
// dois lugares dizendo a mesma coisa.
function novoGrupo(el, passosEl, resumo) {
  return {
    el,                    // o <details class="grupo-ferramentas">
    passosEl,              // o <div class="grupo-passos"> onde os passos entram
    resumo,                // { conta, tipos, tempo, estado } — os <span> do <summary>
    passos: [],            // os <details class="ferramenta passo">, na ordem
    tipos: new Map(),      // nome da ferramenta -> quantas vezes (ordem de inserção = 1ª aparição)
    encerrado: false,      // já veio um separador; ver a regra de fechamento tardio abaixo
  };
}

/** "820ms" / "4s" (0s omitido) / "1min 12s" ("Nmin" quando os segundos dão zero). */
function formatarDuracaoGrupo(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) {
    const seg = Math.round(ms / 1000);
    return seg === 0 ? null : `${seg}s`;
  }
  const min = Math.floor(ms / 60000);
  const seg = Math.round((ms % 60000) / 1000);
  return seg === 0 ? `${min}min` : `${min}min ${seg}s`;
}

/**
 * Cabeçalho do grupo: conta, tipos, tempo (derivado dos passos) e estado — e é aqui, no
 * fim, que mora a regra de fechamento tardio (ver D2b/3.2): um separador pode chegar com
 * passos ainda rodando, e é o recálculo seguinte — quando o resultado tardio completa o
 * grupo — que também o fecha.
 */
function atualizarResumoGrupo(g) {
  idiomaUI.bind(g.resumo.conta, 'textContent', () => tr`${g.passos.length} passos`);

  const partes = [];
  for (const [nome, qtd] of g.tipos) partes.push(qtd > 1 ? `${nome} ×${qtd}` : nome);
  idiomaUI.bind(g.resumo.tipos, 'textContent', () => tr(partes.join(' · ')));

  // .grupo-tempo — regra fechada de dados ruins (D3/3.3): omitido sempre que os dois lados
  // não derem um número bom. Timestamp que `Date.parse` não entende é ignorado no min/max.
  let primeiroT = null;
  let ultimoT = null;
  for (const passo of g.passos) {
    const t = Date.parse(passo.dataset.t || '');
    if (!Number.isNaN(t) && (primeiroT === null || t < primeiroT)) primeiroT = t;
    const tFim = Date.parse(passo.dataset.tFim || '');
    if (!Number.isNaN(tFim) && (ultimoT === null || tFim > ultimoT)) ultimoT = tFim;
  }
  let textoTempo = null;
  if (primeiroT !== null && ultimoT !== null && ultimoT - primeiroT >= 0) {
    textoTempo = formatarDuracaoGrupo(ultimoT - primeiroT);
  }
  if (textoTempo === null) {
    if (g.resumo.tempo) { g.resumo.tempo.remove(); g.resumo.tempo = null; }
  } else {
    if (!g.resumo.tempo) {
      const tempo = document.createElement('span');
      tempo.className = 'grupo-tempo';
      // Sem `insertBefore` no DOM de mentira: tira o `.grupo-estado`, põe o tempo, recoloca
      // o estado — a mesma ordem visual (conta, tipos, tempo, estado) com só `remove`+`append`.
      g.resumo.estado.remove();
      g.el.querySelector('.grupo-resumo').append(tempo, g.resumo.estado);
      g.resumo.tempo = tempo;
    }
    idiomaUI.bind(g.resumo.tempo, 'textContent', () => tr(textoTempo));
  }

  // data-grupo-estado / .grupo-estado — NUNCA data-estado (R1): erro > rodando > parada > feita.
  let temErro = false, temRodando = false, temParada = false;
  for (const passo of g.passos) {
    const est = passo.dataset.estado;
    if (est === 'erro') temErro = true;
    else if (est === 'rodando') temRodando = true;
    else if (est === 'parada') temParada = true;
  }
  const estadoGrupo = temErro ? 'erro' : temRodando ? 'rodando' : temParada ? 'parada' : 'feita';
  g.el.dataset.grupoEstado = estadoGrupo;
  idiomaUI.bind(g.resumo.estado, 'textContent', () => tr({ rodando: '●', erro: '✕', parada: '—', feita: '✓' }[estadoGrupo]));

  // Fechamento tardio: só aqui, não em `encerrarGrupoFerramentas` — um separador pode chegar
  // com passos ainda rodando, e é o resultado que completa o grupo que também o fecha.
  const todosTerminaram = g.passos.every((p) => p.dataset.estado !== 'rodando');
  if (g.encerrado && todosTerminaram && g.el.dataset.tocado !== '1') g.el.open = false;
}

/**
 * Único caminho de entrada no grupo — usado pela `primeira` (promovida) e por todas as
 * ferramentas seguintes. `det` já tem `dataset.t` gravado por `blocoFerramenta`.
 */
function entrarNoGrupo(det) {
  det.className += ' passo';
  P.grupoFerramentas.passosEl.append(det);
  det.grupo = P.grupoFerramentas;
  P.grupoFerramentas.passos.push(det);
  const nome = det.querySelector('.fer-nome').textContent;
  P.grupoFerramentas.tipos.set(nome, (P.grupoFerramentas.tipos.get(nome) || 0) + 1);
  atualizarResumoGrupo(P.grupoFerramentas);
}

/**
 * Nasce a segunda ferramenta de uma sequência: cria o `<details class="grupo-ferramentas">`,
 * move a `primeira` (já desenhada solta) para dentro pelo MESMO caminho que a segunda usa
 * (`entrarNoGrupo`) — duas entradas para a mesma coisa é onde bug mora; há uma só.
 */
function abrirGrupo(primeira) {
  const grupo = document.createElement('details');
  grupo.className = 'grupo-ferramentas';
  grupo.open = true;

  const resumoEl = document.createElement('summary');
  resumoEl.className = 'grupo-resumo';
  const conta = document.createElement('span');
  conta.className = 'grupo-conta';
  const tipos = document.createElement('span');
  tipos.className = 'grupo-tipos';
  const estado = document.createElement('span');
  estado.className = 'grupo-estado';
  resumoEl.append(conta, tipos, estado);
  // `data-tocado` só vem de CLIQUE de verdade no summary — nunca de `toggle`, que também
  // dispara na mudança programática `el.open = false` e marcaria "tocado" o grupo que o
  // próprio código acabou de fechar (D2b/3.2).
  resumoEl.addEventListener('click', () => { grupo.dataset.tocado = '1'; });
  grupo.append(resumoEl);

  const passosEl = document.createElement('div');
  passosEl.className = 'grupo-passos';
  grupo.append(passosEl);

  primeira.remove();            // sai da fita — invariante do D2b garante que é o último nó
  fita().append(grupo);         // o grupo toma o lugar dela
  P.grupoFerramentas = novoGrupo(grupo, passosEl, { conta, tipos, tempo: null, estado });
  P.ferramentaSolta = null;
  entrarNoGrupo(primeira);
}

/** Chamada de dois pontos só (D2b): o topo de `aplicarNoPainel()` e o topo de `bolha()`. */
function encerrarGrupoFerramentas() {
  if (P.grupoFerramentas) {
    P.grupoFerramentas.encerrado = true;
    atualizarResumoGrupo(P.grupoFerramentas);
  }
  P.grupoFerramentas = null;
  P.ferramentaSolta = null;
}

/**
 * Chamada pelo `case 'resultado_ferramenta'`, depois de gravar `dataset.tFim` no cartão. Não
 * sobe pelo DOM (`parentNode` não existe no DOM falso do gate) nem depende do grupo estar
 * vivo: cada passo carrega a referência do grupo dele, pendurada em `entrarNoGrupo`. Um
 * resultado tardio, de um grupo já encerrado, ainda atualiza o grupo certo.
 */
function atualizarGrupoDoPasso(passo) {
  const g = passo.grupo;
  if (!g) return;
  atualizarResumoGrupo(g);
}

/**
 * Bolha da fala do agente. Devolve o estado dela, não o elemento: o markdown é redesenhado
 * a cada bloco de texto novo e é o `bruto` que o botão de copiar entrega.
 *
 * O markdown vive num `.fala-corpo` próprio justamente por isso — redesenhar limpa o
 * corpo e deixa o botão de copiar de pé, em vez de apagá-lo a cada pedaço que chega.
 *
 * É um `<details open>`, e não uma `<div>`, porque no evento seguinte esta fala pode virar
 * nota de trabalho (ver `recolherFala`). Enquanto está aberta o CSS esconde o `summary`, e
 * ela é exatamente a bolha de sempre — o `<details>` não aparece em lugar nenhum.
 *
 * `evento` é OPCIONAL, e é aditivo (§4.5 item 3 do plano): o chamador de sempre (`:2617`, uma
 * conversa de aba) não muda uma linha. Quando vem, `sub` marca a fala como de subagente —
 * `└ ${subNome}` no topo dela — e fica gravado em `fala.sub`/`dataset.sub` para a
 * concatenação de `case 'texto'` distinguir autores.
 */
function desenharFala(bruto, quando, evento = null) {
  const sub = evento?.sub ?? null;
  const fala = { bruto, sub };
  // Mesma regra da bolha: a hora só aparece quando o minuto muda, e vem antes da fala.
  marcarHora(quando, 'agente');
  fala.el = document.createElement('details');
  fala.el.className = P.desenhandoDeFora ? 'fala de-fora' : 'fala';
  fala.el.open = true;

  // A marca de subagente (§4.5 item 3) vai PRIMEIRO na ordem de `append` — é o que a põe no
  // TOPO da fala sem precisar de `prepend` (que o `<details>` desta tela nunca usou até
  // aqui). `subTarefa` NÃO é desenhada nesta entrega: o texto é longo e, em 60 falas, vira
  // ruído; `title` seria a #31 (tooltip não existe no celular). O campo continua no evento,
  // para quem desenhar depois.
  if (sub) {
    const marca = document.createElement('div');
    marca.className = 'fala-sub';
    marca.textContent = `└ ${evento.subNome || 'subagente'}`;
    fala.el.append(marca);
    fala.el.dataset.sub = sub;
  }

  fala.resumo = document.createElement('summary');
  fala.resumo.className = 'fala-resumo';
  const rotulo = document.createElement('span');
  rotulo.className = 'fala-rotulo';
  idiomaUI.bind(rotulo, 'textContent', () => tr('raciocínio'));
  fala.resumo.append(rotulo);

  fala.corpo = document.createElement('div');
  fala.corpo.className = 'fala-corpo';
  markdown(bruto, fala.corpo);

  fala.copiar = botaoCopiar(() => fala.bruto, tr('Copiar a resposta do agente'));
  fala.el.append(fala.resumo, fala.corpo, fala.copiar);
  fita().append(fala.el);
  return fala;
}

/**
 * A fala que veio logo ANTES de uma ferramenta não era a resposta: era o agente dizendo o
 * que ia fazer antes de fazer. O que se quer ver é comando e resposta final — e a escolha foi
 * RECOLHER, não apagar: o raciocínio continua a um clique de distância.
 *
 * Vale igual para o histórico lido do disco e para o turno em andamento, porque os dois
 * chegam pelo mesmo `aplicar()`. A última fala do turno nunca passa por aqui: não há
 * ferramenta depois dela, e é justamente ela que fica aberta.
 */
function recolherFala() {
  if (!P.ultimaFala) return;
  const fala = P.ultimaFala;
  P.ultimaFala = null;
  fala.el.open = false;
  fala.el.className += ' fala-nota';
  // O botão de copiar MUDA DE LUGAR, não some: dentro do `details` ele só apareceria com a
  // nota aberta, que é justamente quando copiar já era fácil.
  fala.resumo.append(fala.copiar);
  // Sem isto, o clique no copiar também abriria e fecharia a nota.
  fala.copiar.addEventListener('click', (evento) => evento.stopPropagation());
}

/**
 * A faixa de cor da barra. Os mesmos limiares do consumo do plano — é o mesmo vocabulário
 * visual (`data-nivel` em `atencao` e `cheio`) que o CSS já espera nos dois lugares.
 *
 * Esta função é chamada em `desenharPlano` e MORREU no corte das 513 linhas de 21/08 — a
 * chamada ficou. Irmã do `marcarLido`: o ReferenceError estourava no PRIMEIRO item, e o
 * diálogo "Consumo do plano" abria com a lista vazia em todo aparelho. Voltou com os
 * limiares originais (commit ba05bbc).
 */
function nivelDe(pct) {
  return pct >= 85 ? 'cheio' : pct >= 65 ? 'atencao' : 'ok';
}

/** `claude-opus-5[1m]` → `opus-5 1m`. Cabe no topo sem virar uma linha só de id de modelo. */
function nomeCurtoModelo(modelo) {
  if (!modelo) return '';
  return String(modelo)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\[(\w+)\]/, ' $1');
}

/**
 * Quanto da janela do agente já está ocupado, no topo do chat DAQUELE painel.
 *
 * O número vem pronto do servidor (lib/contexto.js), lido do `.jsonl` da conversa — nada
 * aqui calcula teto nem adivinha modelo. Três estados, e nenhum deles mente:
 *
 * - `null` → não há `usage` na cauda do arquivo. O medidor some, como se nunca tivesse
 *   existido; é exatamente a tela de antes deste job.
 * - com `pct` → barra, cor e porcentagem.
 * - sem `pct` (modelo cujo teto não dá para saber) → só a contagem de tokens, e o trilho
 *   some junto. Barra sem teto seria desenho inventado.
 *
 * `painel.contexto` guarda o último contexto desenhado (R30 da spec): o `<dialog>` do
 * medidor (`abrirContexto`) mostra ESTE número, e não um pedido novo ao servidor — o dado
 * já chegou pelo evento, e global faria o medidor de um painel abrir os números de outro.
 */
function desenharMedidor(painel, contexto) {
  const caixa = painel.medidor.el;
  painel.contexto = contexto && contexto.usados ? contexto : null;
  if (!contexto || !contexto.usados) {
    caixa.hidden = true;
    return;
  }
  caixa.hidden = false;
  painel.medidor.modelo.textContent = nomeCurtoModelo(contexto.modelo);
  // O chip é resolvido AQUI, antes do `return` do estado sem teto conhecido: lá embaixo ele
  // ficaria com o valor da conversa anterior toda vez que o modelo novo não tivesse teto.
  // Sem `esforco` o chip some — conversa gravada por uma versão do CLI que não escrevia o
  // campo simplesmente não mostra nada, que é a mesma regra dos três estados do medidor.
  const chipEffort = painel.medidor.effort;
  chipEffort.textContent = contexto.esforco || '';
  chipEffort.hidden = !contexto.esforco;

  const tokens = () => Number(contexto.usados).toLocaleString(idiomaUI.idioma);
  const pct = contexto.pct;
  if (pct === null || pct === undefined) {
    painel.medidor.trilho.hidden = true;
    idiomaUI.bind(painel.medidor.pct, 'textContent', () => tr(`${Math.round(contexto.usados / 1000)}k`));
    caixa.dataset.nivel = 'ok';
    idiomaUI.attr(caixa, 'title', () => tr`${tokens()} tokens · janela deste modelo desconhecida`);
    return;
  }
  painel.medidor.trilho.hidden = false;
  idiomaUI.bind(painel.medidor.pct, 'textContent', () => tr(`${Math.round(pct)}%`));
  painel.medidor.cheio.style.width = `${Math.max(2, Math.min(100, pct))}%`;
  caixa.dataset.nivel = nivelDe(pct);
  idiomaUI.attr(caixa, 'title', () => tr`${tokens()} de ${Number(contexto.teto).toLocaleString(idiomaUI.idioma)} tokens${contexto.modelo ? ` · ${contexto.modelo}` : ''}`);
}

/**
 * Os números do medidor por extenso, um par por linha.
 *
 * Nada aqui calcula teto nem inventa porcentagem: o que não veio do servidor é dito com
 * todas as letras. Sem teto conhecido saem só os tokens e a frase que explica por quê —
 * número errado com cara de número certo é pior do que número nenhum (D22).
 */
function linhasDoContexto(contexto) {
  if (!contexto || !contexto.usados) return [['contexto', tr('sem número para esta conversa')]];
  const tokens = Number(contexto.usados).toLocaleString(idiomaUI.idioma);
  const semTeto = contexto.pct === null || contexto.pct === undefined || !contexto.teto;
  const linhas = [];
  if (semTeto) {
    linhas.push([tr('tokens usados'), tokens]);
    linhas.push([tr('janela do modelo'), tr('desconhecida — por isso não há porcentagem')]);
  }
  linhas.push(['modelo', contexto.modelo || tr('não informado no arquivo')]);
  // Só quando há: linha "effort: desconhecido" seria rótulo inventado, que é justamente o que
  // a D22 recusa. E o que este número diz é o esforço DESTA conversa, não o padrão de agora.
  if (contexto.esforco) linhas.push([tr('effort desta conversa'), contexto.esforco]);
  return linhas;
}

/**
 * O painel do medidor.
 *
 * Existe porque `title` é tooltip de MOUSE — no celular ele não aparece, e era ali que
 * estavam os tokens exatos, o teto e o nome cheio do modelo. Reaproveita o `<dialog>` que
 * o "Consumo do plano" já usa; componente novo aqui seria peso sem motivo.
 */
function abrirContexto(painel) {
  const alvo = $('contexto-grade');
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  // O `<dialog>` é UM SÓ no documento e é reusado por todo painel (job e aba) — atribuição
  // INCONDICIONAL nos dois estados. Escrito como `if (job) p.hidden = false`, a frase sobre
  // subagentes vazaria para o diálogo da aba na abertura seguinte.
  $('contexto-nota-job').hidden = painel.tipo !== 'job';
  const destaque = $('contexto-destaque');
  const contextoAtual = painel.contexto;
  const pct = contextoAtual && contextoAtual.pct;
  const temPercentual = pct !== null && pct !== undefined && contextoAtual && contextoAtual.teto;
  destaque.hidden = !temPercentual;
  if (temPercentual) {
    idiomaUI.bind($('contexto-percentual'), 'textContent', () => tr(`${Math.round(pct)}%`));
    $('contexto-cheio').style.width = `${Math.max(0, Math.min(100, pct))}%`;
    idiomaUI.bind($('contexto-legenda'), 'textContent', () => tr`${Number(contextoAtual.usados).toLocaleString(idiomaUI.idioma)} de ${Number(contextoAtual.teto).toLocaleString(idiomaUI.idioma)} tokens`);
    destaque.dataset.nivel = nivelDe(pct);
  }
  for (const [rotulo, valor] of linhasDoContexto(contextoAtual)) {
    const dt = document.createElement('dt');
    idiomaUI.bind(dt, 'textContent', () => tr(rotulo));
    const dd = document.createElement('dd');
    idiomaUI.bind(dd, 'textContent', () => tr(valor));
    alvo.append(dt, dd);
  }
  $('dialogo-contexto').showModal();
}

// `job_estado` é estado de CABEÇALHO (§4.5 item 7 do plano) — o mesmo papel que `turno_fim`
// já tem aqui: não pode partir ao meio um grupo de ferramentas seguidas de um job.
//
// `contexto` (card `contexto-da-sessao-do-job`, 22/09) é a mesma história: o evento sai sempre
// que um `assistant` novo traz `usage` novo — ENTRE as ferramentas de uma rajada — e sem estar
// aqui, cada atualização do medidor partia em dois o grupo aberto na fita. Defeito
// PRÉ-EXISTENTE (a aba emite `contexto` desde 24/08): esta entrada não o cria, ela o conserta —
// nas duas superfícies, aba e job.
const NEUTROS_DO_GRUPO = new Set(['ferramenta', 'resultado_ferramenta', 'turno_fim', 'job_estado', 'contexto']);

/**
 * A casca fina que as 176 chamadas `cliente.aplicar({...})` do gate continuam falando com:
 * "aplica no painel corrente". Quem desenha de verdade é `aplicarNoPainel` — reescrever as
 * 176 chamadas seria churn sem ganho (§4.7 da spec).
 *
 * Sem painel corrente, é no-op: não há onde aplicar. Cobre o `removida` que chega depois do
 * painel já ter fechado (a mesma chegada dupla DELETE+evento que `fecharPainel` já aguenta).
 */
function aplicar(evento) {
  const painel = paineis.get(atual);
  if (!painel) return;
  aplicarNoPainel(painel, evento);
}

/**
 * A função de verdade — primeira linha escreve `P` (a "regra do dono": todo controle que só
 * DESENHA, de `bolha()` a `blocoFerramenta()`, lê `P` e nunca um parâmetro).
 *
 * A limpeza da rajada (`limparFita`/`segurarFita`/captura da rolagem) mora no
 * `fluxo.onmessage` de `religarFluxo()`, NÃO aqui: as 176 chamadas `cliente.aplicar({...})`
 * do gate falam com esta função DIRETO, sem passar pelo `onmessage`, e não podem ganhar uma
 * rajada de propósito — só quem chega pelo cano de verdade abre e fecha uma.
 */
function aplicarNoPainel(painel, evento) {
  P = painel;
  // A régua é lida AQUI, antes de qualquer desenho: depois do bloco entrar na fita já é
  // tarde (ver `estaNoFim`).
  const estavaNoFim = estaNoFim(painel);
  // Ferramentas SEGUIDAS viram um grupo só. Qualquer outro evento — fala, bolha, corte, fim do
  // despejo do histórico — fecha o grupo aberto. Um lugar, e não uma chamada em cada função de
  // desenho: quem esquecer uma delas deixa o grupo engolindo o que vier depois.
  if (!NEUTROS_DO_GRUPO.has(evento.tipo)) encerrarGrupoFerramentas();
  switch (evento.tipo) {
    case 'sessao': {
      painel.statusCodexSessao = evento.meta.sessaoId || null;
      // Campo PRÓPRIO do chip `início` (card `carregar-mais-historico`) — nunca reusar
      // `statusCodexSessao`, que é do `/status` do Codex: amarrar as duas guardas de
      // identidade faz quem mexer numa quebrar a outra sem saber.
      painel.sessaoDaConversa = evento.meta.sessaoId || null;
      // O `/clear` do Codex (develop, 08/09): a aba fica sem arquivo e o cabeçalho passa a
      // dizer "Conversa limpa". A aba é a DESTE painel — `atual` é o painel FOCADO, e com N
      // painéis o `sessao` que chega quase nunca é o do foco.
      const info = abasDoTerminal.find((a) => a.chave === painel.chave);
      if (info && Object.hasOwn(evento.meta, 'reiniciada')) {
        info.reiniciada = evento.meta.reiniciada;
        desenharAvisoDoAgente(painel, info);
      }
      painel.titulo.textContent = evento.meta.titulo;
      // `cwd: null` é o contrato de um job (§5.3 do plano — worktree é caminho de disco e
      // não vai para o navegador): sem a guarda, `encurtarCaminho(null)` escreve a STRING
      // "null" no cabeçalho. `''` é o mesmo vazio que a conversa de sempre nunca produzia,
      // porque toda aba tem `cwd`.
      painel.caminho.textContent = evento.meta.cwd ? encurtarCaminho(evento.meta.cwd) : '';
      // O caminho CHEIO no `title` — extra de desktop (tooltip é coisa de mouse, #31), e por
      // isso nunca é a entrega: no celular a entrega é o caminho visível e inteiro, que a
      // linha 1 do topo em duas linhas dá. `encurtarCaminho` fica intacto — é compartilhado
      // com a lista e com os cartões de ferramenta.
      painel.caminho.title = evento.meta.cwd || '';
      desenharMedidor(painel, evento.meta.contexto);
      // O estado de PARTIDA de um job aparece já na abertura, não só na transição
      // (`job_estado` abaixo) — sem isto, um job já `blocked` ao abrir o painel ficaria com
      // o aviso mudo até a próxima mudança de estado, que pode nunca vir.
      if (evento.meta.job) desenharEstadoDoJob(painel, evento.meta.job);
      break;
    }
    // O topo se corrigindo ENTRE turnos, sem relógio novo: o relógio de arquivo que já
    // existia passou a medir o pedaço que ele acabou de ler, e manda isto quando o valor
    // muda. O `if` é a outra metade da defesa do pisca-pisca: `null` por este caminho é
    // "não deu para medir agora", não "não há contexto" — quem zera o topo é só o `sessao`.
    case 'contexto': {
      if (evento.contexto) desenharMedidor(painel, evento.contexto);
      break;
    }
    // A pendente do SERVIDOR (D-a): chega na abertura do fluxo (reconexão, recarga, outro
    // aparelho) e ao vivo, logo depois de um envio bem-sucedido (D-m). A dedupe é pelo `id`
    // do envio — por texto, dois "continua" legítimos virariam uma bolha só (D-n).
    case 'pendente': {
      if (evento.id && painel.pendentes.some((p) => p.id === evento.id)) break;
      const { texto: limpo, anexos: enviados } = separarAnexos(evento.mensagem || evento.texto);
      const rotulo = enviados.length ? `${enviados.map((n) => `📎 ${n}`).join('\n')}\n\n${limpo}` : limpo;
      const el = marcarPendente(bolha('bolha-eu', rotulo, evento.em), evento.texto, evento.em, true, evento.id);
      // O `em` do evento é do relógio do SERVIDOR: serve para o rótulo de hora e nada mais.
      // O envelhecimento mede com o relógio DESTE aparelho, sempre (D-i/#35).
      el.fichaPendente.ocioso = painel.ocupado ? null : Date.now();
      break;
    }
    case 'humano': {
      painel.ultimaFala = null;
      const { texto, anexos: enviados } = separarAnexos(evento.texto);
      // Lote antigo (`carregarMaisHistorico`): não empurrar para o fim de `historicoEntrada`
      // (a seta-para-cima ofereceria a mensagem mais VELHA como se fosse a última enviada).
      if (!painel.replayAntigo) lembrar(painel, texto);
      // O eco de um `/effort` é o CLI devolvendo, do disco, o prompt que ele LEU de verdade —
      // e é o gatilho honesto da conferência: antes dele não há o que conferir. Vale igual
      // para o que saiu do painel e para o que o usuário digitou aqui na fita, à mão.
      if (texto.trim().startsWith('/effort')) carregarEffort();
      // /clear e /compact não são conversa, são um corte nela. A fita é lida do disco e
      // continua mostrando tudo que veio antes — sem esta marca, o usuário veria o histórico
      // inteiro na tela sem saber que o agente já não lembra de nada dali para trás.
      const corte = texto.trim().match(/^\/(clear|compact)\b/);
      const rotulo = enviados.length ? `${enviados.map((n) => `📎 ${n}`).join('\n')}\n\n${texto}` : texto;
      // Esta mensagem pode ser a MINHA, voltando do disco um segundo depois de eu
      // desenhá-la. Se for, a bolha que já está na tela vira a definitiva — e recebe o
      // texto do disco, que é o que o agente realmente leu (com o rascunho grudado, se
      // houver). Uma bolha, e ela conta a verdade.
      // Idem: um `continua` no lote antigo não pode roubar o selo da pendente ATUAL (ela casa
      // por TEXTO, não por data) nem corrigir a hora dela para a hora antiga.
      // `evento.texto` (cru, com cabeçalho), não `texto` (já sem ele): é o MESMO texto que o
      // servidor usa em `consumirPendente` (armadilha #84) — com entradas diferentes, o
      // casamento por grau escolheria pendentes diferentes numa colisão com foto.
      const minha = painel.replayAntigo ? null : absorverPendente(evento.texto, evento.quando);
      if (minha) {
        // /clear vira régua, não bolha: a hora que nasceu com a pendente sai junto com ela.
        if (corte) { if (minha.horaEl) minha.horaEl.remove(); minha.remove(); }
        else { pintarTextoDaBolha(minha, rotulo); break; }
      }
      if (corte) marcaDeCorte(corte[1], texto.trim());
      else bolha('bolha-eu', rotulo, evento.quando);
      break;
    }
    case 'texto': {
      // Blocos de texto seguidos do mesmo turno pertencem à mesma fala — MAS só quando são
      // do MESMO autor. `sub` é a identidade do subagente (job) ou `null` (todo mundo mais):
      // `null === null` junta o principal com ele mesmo; qualquer outra combinação separa —
      // sem isso, a fala de um avaliador colaria na do agente principal (§3.4 da spec).
      // Com markdown não dá para concatenar no nó já renderizado: guardamos o cru e
      // redesenhamos a fala inteira.
      const sub = evento.sub ?? null;
      if (painel.ultimaFala && painel.ultimaFala.sub === sub) {
        painel.ultimaFala.bruto += evento.texto;
        idiomaUI.bind(painel.ultimaFala.corpo, 'textContent', () => tr(''));
        markdown(painel.ultimaFala.bruto, painel.ultimaFala.corpo);
      } else {
        painel.ultimaFala = desenharFala(evento.texto, evento.quando, evento);
      }
      break;
    }
    case 'ferramenta':
      // A fala aberta vira nota: quem fala e em seguida usa ferramenta estava pensando. MAS
      // num JOB a fala entre as ações é a única coisa que se quer ler (§1.3 da spec): toda
      // fala tem ferramenta em seguida, e recolher entregaria uma parede de notas. Zerar
      // `ultimaFala` sem recolher continua SEPARANDO a próxima fala desta — sem isso, ela
      // cairia no `if` do `case 'texto'` e seria anexada à bolha de cima, fora de ordem.
      if (painel.tipo === 'job') painel.ultimaFala = null;
      else recolherFala();
      blocoFerramenta(evento);
      break;
    case 'resultado_ferramenta': {
      const cartao = fita().querySelector(`[data-ferramenta-id="${CSS.escape(evento.id || '')}"]`);
      if (!cartao) break;
      cartao.dataset.estado = evento.erro ? 'erro' : 'feita';
      idiomaUI.bind(cartao.querySelector('.fer-estado'), 'textContent', () => tr(evento.erro ? '✕' : '✓'));
      const alvo = cartao.querySelector('pre');
      if (alvo && evento.saida) {
        alvo.textContent += `\n\n${String(evento.saida).slice(0, 4000)}`;
        if (evento.erro) alvo.style.color = 'var(--perigo)';
      }
      if (evento.t) cartao.dataset.tFim = evento.t;
      atualizarGrupoDoPasso(cartao);
      break;
    }
    case 'erro':
      painel.ultimaFala = null;
      // Estado, não falha: o servidor marca os cinco textos do ramo "sem arquivo" com
      // `nivel: 'aviso'` (server.js) porque esse `erro` sobrevive ao `limparFita()` do
      // `sessao` — e o cabeçalho (`desenharAvisoDoAgente`) já conta a mesma história, sem
      // pintar a fita de vermelho. `erro` SEM `nivel` continua sendo falha de verdade.
      if (evento.nivel === 'aviso') break;
      bolha('bolha-erro', evento.mensagem);
      break;
    case 'historico_cortado':
      // A conversa é grande e só a cauda veio. Ver ALVO_MENSAGENS/TETO_DURO em lib/externo.js.
      //
      // A ÂNCORA primeiro, no painel — sem esta linha o botão nasce morto:
      // `inicioDoHistorico` nasce `0` (criarPainel) e a primeira linha do clique é
      // `if (… || !painel.inicioDoHistorico) return;` — nenhum pedido sairia nunca.
      //
      // `marcaDeInicio` recebe `evento.inicio`, NÃO o campo já coagido do painel: um evento
      // SEM âncora (`gate-ui.js:1096`/`:2283`, sem o campo `inicio`) precisa continuar
      // desenhando a nota muda de hoje — `undefined` é uma das três leituras que a função
      // distingue. Coagir para `0` aqui trocaria essa nota por "este é o começo da conversa".
      painel.inicioDoHistorico = Number(evento.inicio) || 0;
      marcaDeInicio(evento.inicio);
      break;
    case 'sincronizado':
      // Fim da rajada inicial: o histórico inteiro entra na página de uma vez.
      despejarFita();
      marcarOcupado(painel, Boolean(evento.turnoEmAndamento));
      break;
    // A transição de estado de um JOB (Fase 3 do plano) — irmã de `esperando`/`status_codex`:
    // atualiza o cabeçalho sem tocar na fita (§5.3.3 da spec). Quem limpa a fita é só o
    // `sessao`. `marcarOcupado` ajusta o "trabalhando" pela MESMA régua do cabeçalho.
    case 'job_estado':
      if (evento.job) desenharEstadoDoJob(painel, evento.job);
      marcarOcupado(painel, evento.job?.estado === 'running');
      break;
    case 'fim':
      if (evento.negacoes && evento.negacoes.length) {
        bolha('bolha-erro', tr`${evento.negacoes.length} ação(ões) foram negadas pelas permissões.`);
      }
      break;
    case 'esperando':
      // O CLI diz que a TUI abriu (ou fechou) uma pergunta. É o único aviso que existe:
      // menu de múltipla escolha não passa pelo arquivo da conversa. Desde 09/09 o mesmo
      // evento carrega o prompt de confiança de pasta nova, no `motivo` — ver `podeVerTela`.
      marcarPergunta(painel, Boolean(evento.valor), evento.motivo || 'menu');
      break;
    case 'turno_fim': {
      painel.ultimaFala = null;
      // Fim de turno é quando o contexto muda. Vem carona no evento que já chegava aqui:
      // relógio novo para isto seria repetir o problema dos dois relógios da D21.
      desenharMedidor(painel, evento.contexto);
      // Ferramenta sem resultado quando o turno acabou: o turno morreu no meio dela.
      for (const cartao of fita().querySelectorAll('[data-estado="rodando"]')) {
        cartao.dataset.estado = 'parada';
        idiomaUI.bind(cartao.querySelector('.fer-estado'), 'textContent', () => tr('—'));
      }
      marcarOcupado(painel, false);
      // O que muda na lista quando o turno acaba é o estado da aba: de "trabalhando" para
      // "no terminal". Contexto e arquivos eram da sessão do cockpit e não existem mais.
      //
      // E é SÓ DEPOIS dessa volta que a conversa é marcada como lida: o carimbo agora é o
      // `atualizadoEm` do servidor, e o que a lista trazia é de ANTES da resposta que
      // acabou de chegar. Marcar com o valor velho deixaria a aba acendendo "te esperando"
      // na batida seguinte — a conversa que você está olhando neste instante.
      //
      // TODAS as chaves abertas agora, não só a deste turno (Fase 0 do card, item 4; R38 da
      // spec): "lido" segue "aberto" (visível na tela), nunca o foco — um painel lateral que
      // não terminou turno nenhum continua sendo algo que o usuário está OLHANDO agora.
      const abertasAgora = [...paineis.keys()];
      carregarAbas().then(() => { for (const chave of abertasAgora) marcarLido(chave); });
      encerrarGrupoFerramentas();
      break;
    }
    case 'fora_inicio':
      painel.ultimaFala = null;
      painel.desenhandoDeFora = true;
      marcaDeFora(evento.quando);
      break;
    case 'fora_fim':
      painel.ultimaFala = null;
      painel.desenhandoDeFora = false;
      break;
    case 'removida':
      // A aba foi fechada no terminal enquanto você estava dentro dela.
      fecharPainel(painel.chave);
      carregarAbas();
      break;
    // A resposta de /status: replay (reconexão/recarga) e ao vivo chegam pelo MESMO
    // evento; `statusCodexResultado` dedupe por `id` (o HTTP e o SSE podem entregar o
    // mesmo id, e o replay pode repetir o que o HTTP já desenhou).
    case 'status_codex':
      statusCodexResultado(evento);
      break;
  }
  // Na rajada inicial não há o que rolar: nada disto está na página ainda, e o despejo
  // rola uma vez só no fim. Fora dela, respeita onde o usuário parou de ler.
  //
  // `sincronizado` é especial (R33): o `estavaNoFim` medido no TOPO desta chamada olhou a
  // fita ainda VAZIA (o histórico inteiro estava no fragmento da rajada, não na página) — a
  // conta `0 - 0 - clientHeight <= 24` sempre dá `true`, e usá-la aqui desfaria a restauração
  // que `despejarFita()` acabou de fazer no mesmo tique. Para este evento, quem manda é o
  // instantâneo tirado no `sessao`, sobre a caixa de VERDADE.
  const estavaNoFimFinal = evento.tipo === 'sincronizado' && painel.rolagemGuardada
    ? painel.rolagemGuardada.noFim
    : estavaNoFim;
  if (!painel.destinoFita) rolarFimSeGrudado(painel, estavaNoFimFinal);
}

/**
 * O turno está rodando (ou parou de rodar).
 *
 * Isto acende o "trabalhando" e o botão Parar — e SÓ isso. Até 22/08 travava o Enviar
 * junto, o que fazia turno rodando virar "não pode digitar". No terminal sempre deu para
 * escrever no meio de um turno; o texto entra na fila do CLI. A decisão foi ter o
 * mesmo aqui, e o servidor já enfileirava (`lib/abas.js`) — quem impedia era esta linha.
 *
 * Quem trava o Enviar é `marcarPergunta`, e por outro motivo: com menu aberto na TUI cada
 * letra vira tecla de menu (armadilha #6/#25). Isso é guarda contra escolher opção errada,
 * não trava de concorrência.
 */
function marcarOcupado(painel, valor) {
  // D-d: `ocioso` mede quanto tempo a aba está PARADA, contínuo, não acumulado. Turno
  // começando (`true`) zera — o CLI está trabalhando, e o que ele pegou da fila pode ser
  // exatamente esta mensagem, não importa a duração. Turno acabando (`false`) carimba
  // `Date.now()` só nas que ainda estiverem `null`, para não perturbar quem já estava
  // esperando de um turno anterior.
  if (valor) {
    for (const p of painel.pendentes) p.ocioso = null;
  } else {
    for (const p of painel.pendentes) if (p.ocioso === null) p.ocioso = Date.now();
  }
  painel.ocupado = valor;
  // Parar vale com turno rodando E com pergunta aberta: nos dois casos a tecla é o Escape.
  // Num painel de JOB não há turno para parar — a guarda entra AQUI, no escritor, e não só
  // no nascimento do painel: `sincronizado { turnoEmAndamento: true }` para job `running`
  // (Fase 3) reescreveria este mesmo campo a cada tique se a guarda vivesse só na criação.
  painel.btnParar.hidden = painel.tipo === 'job' || (!valor && !painel.perguntando);
  const alvoFita = fitaDe(painel);
  const existente = alvoFita.querySelector('.trabalhando');
  if (valor && !existente) {
    const div = document.createElement('div');
    div.className = 'trabalhando';
    div.append(...[0, 1, 2].map(() => {
      const p = document.createElement('span');
      p.className = 'ponto';
      return p;
    }));
    div.append(document.createTextNode(' trabalhando'));
    alvoFita.append(div);
    // R33 da spec de 08/09: a bolha "trabalhando" entrando não é motivo para arrastar quem
    // está lendo o meio da conversa — só rola se já estiver no fim.
    if (estaNoFim(painel)) rolarFim(painel);
  } else if (!valor && existente) {
    existente.remove();
  }
}

/**
 * A aba abriu (ou fechou) uma pergunta na TUI.
 *
 * Três coisas mudam ao mesmo tempo, e é de propósito que sejam as três: aparece o aviso com
 * a tela do terminal (senão a fita fica muda e parece que não há nada acontecendo), o Enviar
 * trava **só no `pre-sessao`** (D58: com `menu` ele fica ATIVO, e escrever ali manda `Esc`
 * antes do texto — no `pre-sessao` o Esc fecharia o agente, por isso lá a trava fica) e o
 * Parar assume o papel de cancelar a pergunta, que é o Escape de sempre.
 *
 * `motivo` são DOIS estados com o mesmo desenho e textos diferentes (`lib/abas.js`,
 * `podeVerTela`): `'menu'` é o menu de múltipla escolha de sempre; `'pre-sessao'` é o prompt
 * de confiança de pasta nova, e nele o Escape NÃO cancela uma pergunta — ele **fecha o
 * agente**, porque a TUI ainda não tem conversa para voltar. Prometer "Cancelar pergunta"
 * ali seria o rótulo mentindo sobre um botão que mata o que o usuário acabou de abrir.
 */
function marcarPergunta(painel, valor, motivo = 'menu') {
  if (valor === painel.perguntando && (!valor || motivo === painel.motivoPergunta)) return;
  painel.perguntando = valor;
  painel.motivoPergunta = valor ? motivo : 'menu';
  // Um job nunca tem TUI — este evento não deveria nem chegar a um painel de job, mas a
  // guarda entra no escritor por hábito da casa (o mesmo raciocínio do `btnParar` acima).
  painel.pergunta.hidden = painel.tipo === 'job' || !valor;
  const preSessao = valor && painel.motivoPergunta === 'pre-sessao';
  // P7/R2: escrever direto no botão apagaria o SVG (M2) — quem muda é só o rótulo.
  // O ramo `menu` diz o genérico "Parar", não "Cancelar pergunta": no prompt de UPDATE do
  // Codex (`menu-update-disponivel.txt`, que a régua classifica como menu) o Esc NÃO fecha
  // nada — medido. O rótulo não pode prometer o que o Esc às vezes não faz.
  idiomaUI.bind(painel.pararRotulo, 'textContent', () => tr(valor ? (preSessao ? tr('Fechar o agente') : tr('Parar')) : tr('Parar')));
  idiomaUI.bind(painel.btnParar, 'title', () => tr(valor
    ? (preSessao
      ? tr('O agente ainda não abriu conversa: Esc aqui FECHA o agente desta aba')
      : tr('Mandar a tecla Esc para o terminal'))
    : tr('Parar o turno em andamento')));
  painel.btnParar.hidden = painel.tipo === 'job' || (!valor && !painel.ocupado);
  // A trava do Enviar (card escrever-texto-na-pergunta-aberta): só no `pre-sessao`. Com
  // `menu` o servidor faz o gesto (Escape → reconfere → cola → Enter) em vez do cliente
  // recusar de cara — ver lib/abas.js `digitarNaAba`. Caixa de envio por painel (D42): o
  // botão é do PAINEL, não do foco — cada Enviar trava pelo `perguntando` do SEU painel,
  // nunca pelo de outro.
  painel.btnEnviar.disabled = valor && motivo === 'pre-sessao';
  // O aviso da AÇÃO (não do resultado — §5.1 da spec), só quando o Esc de fato vai sair:
  // no `pre-sessao` o Enviar continua travado, e este texto não se aplica.
  painel.avisoEscrita.hidden = !valor || preSessao;
  if (valor) {
    atualizarTelaDaPane(painel);
  } else {
    idiomaUI.bind(painel.telaDaPane, 'textContent', () => tr(''));
    // Pergunta fechada: o cartão (e o que o usuário marcou nele) vai junto — reabrir, mesmo
    // com o mesmo `toolUseId`, monta de novo do zero.
    painel.avisoGancho.hidden = true;
    limparCartao(painel);
  }
  // A lista também muda: a aba aberta passa a mostrar (ou deixa de mostrar) o `?`.
  carregarAbas();
}

/**
 * Escreve a tela da pane no `pre` sem tirar da vista o que o usuário está lendo.
 *
 * Duas coisas que parecem detalhe e eram o bug inteiro (print do celular, 24/08):
 *
 * 1. `moldarTela` (lib/abas.js) guarda as ÚLTIMAS 80 linhas de propósito — a pergunta e as
 *    opções estão embaixo, então a vista tem que nascer no FIM. Desde 28/08 quem rola é a
 *    CONVERSA (a pergunta perdeu o teto de altura e o rolador próprio), e é por isso que a
 *    primeira pintura chama `rolarFim`: sem ele, abrir a pergunta deixava o usuário olhando o
 *    histórico com o menu do terminal esperando lá embaixo.
 * 2. Reatribuir `textContent` reconstrói os filhos e ZERA `scrollTop` e `scrollLeft`. Com o
 *    tique de 5s da lista chamando isto, rolar para achar as opções durava no máximo 5s.
 *    Tela igual não se repinta; tela nova preserva a âncora — quem estava no fim continua
 *    no fim, quem rolou fica onde parou.
 *
 * O `rolarFim` é SÓ na primeira pintura de propósito: rolar para cima e ler o histórico é o
 * que esta mudança veio permitir, e um tique de 5s arrastando a vista de volta para o fim
 * tiraria justamente isso.
 *
 * A rolagem LATERAL volta sempre: no celular a pane tem 168–211 colunas, e é ela
 * que carrega metade da leitura.
 */
function pintarTelaDaPane(painel, tela) {
  const el = painel.telaDaPane;
  const texto = tela || tr('(o terminal não devolveu nada)');
  if (el.textContent === texto) return;
  const primeira = el.textContent === '';
  const noFim = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLGA_FIM;
  const ondeEstava = { y: el.scrollTop, x: el.scrollLeft };
  el.textContent = texto;
  el.scrollTop = noFim ? el.scrollHeight : ondeEstava.y;
  el.scrollLeft = ondeEstava.x;
  if (primeira) rolarFim(painel);
}

/**
 * Volta ao estado "sem cartão": é a tela de sempre (menu de permissão, confiança de pasta,
 * Codex), só que quebrando linha. Cartão escondido, terminal ABERTO com o rótulo escondido
 * (`data-sem-cartao`, o CSS cuida) e as seis teclas à vista.
 */
function limparCartao(painel) {
  painel.cartao = null;
  painel.respostasCartao = [];
  painel.estadoCartao = 'editando';
  painel.cartaoEl.textContent = '';
  painel.cartaoEl.hidden = true;
  painel.terminalPergunta.open = true;
  painel.terminalPergunta.dataset.semCartao = '1';
  painel.perguntaTeclas.hidden = false;
}

/** Uma pergunta está respondida: uma opção marcada, ou texto na Outra resposta. */
function perguntaRespondida(resposta) {
  return resposta.opcoes.length > 0 || resposta.texto.trim() !== '';
}

/**
 * Põe o DOM do cartão em dia com `painel.respostasCartao` e `painel.estadoCartao`: quem está
 * marcado, se o Enviar destrava e o texto ao lado dele. Só lê estado e DOM do cartão — é o
 * único lugar que escreve `aria-pressed` e `disabled`, para os dois nunca discordarem.
 */
function sincronizarCartao(painel) {
  const travado = painel.estadoCartao !== 'editando';
  painel.cartaoEl.querySelectorAll('.cartao-questao').forEach((questao, i) => {
    const resposta = painel.respostasCartao[i];
    questao.querySelectorAll('.cartao-opcao').forEach((botao, k) => {
      botao.setAttribute('aria-pressed', resposta.opcoes.includes(k) ? 'true' : 'false');
      botao.disabled = travado;
    });
    questao.querySelector('.cartao-outra-campo').disabled = travado;
  });
  const completo = painel.respostasCartao.every(perguntaRespondida);
  const enviar = painel.cartaoEl.querySelector('.cartao-enviar');
  enviar.disabled = travado || !completo;
  idiomaUI.bind(enviar, 'textContent',
    () => tr(painel.estadoCartao === 'enviando' ? 'Enviando…' : 'Enviar respostas'));
  const aviso = painel.cartaoEl.querySelector('.cartao-aviso');
  const frases = { enviado: 'Respostas enviadas.', erro: 'Termine pelo terminal.' };
  const frase = frases[painel.estadoCartao] || (painel.estadoCartao === 'editando' && !completo
    ? 'Responda todas as perguntas.' : '');
  idiomaUI.bind(aviso, 'textContent', () => tr(frase));
}

/**
 * Desenha o cartão da pergunta do agente (card pergunta-do-agente-em-cartao, D74, spec §4.8).
 *
 * O conteúdo vem do arquivo que o hook do Claude Code gravou, nunca do terminal. É tudo
 * `createElement`/`textContent`: texto de pergunta e de opção é dado do agente e nunca vira
 * HTML (por isso também nenhum `title` — não existe no celular — e nenhum `placeholder`).
 *
 * Três regras do tique de 5s, que chama isto com o que o servidor devolveu AGORA:
 *  - mesmo `toolUseId`: não refaz — o que o usuário marcou fica;
 *  - `toolUseId` novo: refaz do zero;
 *  - `null`: some, EXCETO no meio do envio e com erro. A 1ª tecla que o servidor manda já
 *    tira a tela do estado inicial, a conferência deixa de casar e o tique passa a dizer
 *    `null` — sem esta exceção o "Enviando…" e o erro sumiriam junto com o cartão. Depois de
 *    `enviado` ele SAI: o CLI pode abrir outro menu na mesma aba ainda `waiting` ("Teach auto
 *    mode", medido), e esse menu precisa do terminal e das teclas à vista.
 */
function pintarCartao(painel, cartao) {
  if (!cartao) {
    if (painel.cartao && (painel.estadoCartao === 'editando' || painel.estadoCartao === 'enviado')) limparCartao(painel);
    return;
  }
  if (painel.cartao && painel.cartao.toolUseId === cartao.toolUseId) return;

  painel.cartao = cartao;
  painel.estadoCartao = 'editando';
  painel.respostasCartao = cartao.perguntas.map(() => ({ opcoes: [], texto: '' }));

  const questoes = cartao.perguntas.map((pergunta, i) => {
    const resposta = painel.respostasCartao[i];
    const questao = document.createElement('section');
    questao.className = 'cartao-questao';
    const chip = document.createElement('span');
    chip.className = 'cartao-chip';
    chip.textContent = pergunta.cabecalho;
    const texto = document.createElement('div');
    texto.className = 'cartao-texto';
    texto.textContent = pergunta.texto;
    questao.append(chip, texto);
    if (pergunta.multipla) {
      const dica = document.createElement('div');
      dica.className = 'cartao-multipla';
      idiomaUI.bind(dica, 'textContent', () => tr('Pode marcar mais de uma.'));
      questao.append(dica);
    }
    const lista = document.createElement('div');
    lista.className = 'cartao-opcoes';
    const campo = document.createElement('input');
    pergunta.opcoes.forEach((opcao, k) => {
      const botao = document.createElement('button');
      botao.className = 'cartao-opcao';
      botao.type = 'button';
      botao.dataset.cartao = '1';
      botao.setAttribute('aria-pressed', 'false');
      const rotulo = document.createElement('span');
      rotulo.className = 'cartao-opcao-rotulo';
      rotulo.textContent = opcao.rotulo;
      botao.append(rotulo);
      if (opcao.descricao) {
        const descricao = document.createElement('span');
        descricao.className = 'cartao-opcao-descricao';
        descricao.textContent = opcao.descricao;
        botao.append(descricao);
      }
      botao.onclick = () => {
        if (painel.estadoCartao !== 'editando') return;
        if (pergunta.multipla) {
          resposta.opcoes = resposta.opcoes.includes(k)
            ? resposta.opcoes.filter((n) => n !== k)
            : [...resposta.opcoes, k].sort((a, b) => a - b);
        } else {
          // Simples: a Outra resposta é "mais uma opção" — tocar uma opção a esvazia.
          resposta.opcoes = [k];
          resposta.texto = '';
          campo.value = '';
        }
        sincronizarCartao(painel);
      };
      lista.append(botao);
    });
    questao.append(lista);

    const outra = document.createElement('label');
    outra.className = 'cartao-outra';
    const outraRotulo = document.createElement('span');
    outraRotulo.className = 'cartao-outra-rotulo';
    idiomaUI.bind(outraRotulo, 'textContent', () => tr('Outra resposta'));
    campo.className = 'cartao-outra-campo';
    campo.type = 'text';
    campo.maxLength = 500;
    campo.autocomplete = 'off';
    campo.dataset.cartao = '1';
    campo.addEventListener('input', () => {
      if (painel.estadoCartao !== 'editando') return;
      resposta.texto = campo.value;
      // Simples: escrever na Outra resposta desmarca a opção. Multi: o texto soma.
      if (!pergunta.multipla && resposta.texto.trim() !== '') resposta.opcoes = [];
      sincronizarCartao(painel);
    });
    outra.append(outraRotulo, campo);
    questao.append(outra);
    return questao;
  });

  const erro = document.createElement('div');
  erro.className = 'cartao-erro';
  erro.setAttribute('role', 'alert');
  erro.hidden = true;
  const rodape = document.createElement('div');
  rodape.className = 'cartao-rodape';
  const enviar = document.createElement('button');
  enviar.className = 'btn btn-principal cartao-enviar';
  enviar.type = 'button';
  enviar.dataset.cartao = '1';
  enviar.onclick = () => enviarCartao(painel);
  const aviso = document.createElement('span');
  aviso.className = 'cartao-aviso';
  aviso.setAttribute('aria-live', 'polite');
  rodape.append(enviar, aviso);

  painel.cartaoEl.textContent = '';
  painel.cartaoEl.append(...questoes, erro, rodape);
  painel.cartaoEl.hidden = false;
  // Primeira pintura deste `toolUseId`: o terminal cru fica FECHADO (abrir depois é do
  // usuário) e as teclas só aparecem com ele aberto.
  painel.terminalPergunta.open = false;
  delete painel.terminalPergunta.dataset.semCartao;
  painel.perguntaTeclas.hidden = true;
  sincronizarCartao(painel);
}

/**
 * Manda as respostas do cartão: UM POST, e o servidor digita na TUI conferindo cada passo.
 * Estados: `editando` → `enviando` → `enviado` | `erro`. Fora de `editando` o clique não faz
 * nada (o segundo clique durante o envio não pode virar um segundo POST), e `erro` trava o
 * Enviar de vez: com `parcial` já saiu tecla, e refazer por cima bagunçaria a TUI.
 */
async function enviarCartao(painel) {
  const cartao = painel.cartao;
  if (!cartao || painel.estadoCartao !== 'editando') return;
  if (!painel.respostasCartao.every(perguntaRespondida)) return;
  painel.estadoCartao = 'enviando';
  sincronizarCartao(painel);
  const erroEl = painel.cartaoEl.querySelector('.cartao-erro');
  erroEl.hidden = true;
  erroEl.textContent = '';
  try {
    await api(`api/abas/${painel.chave}/pergunta`, {
      method: 'POST',
      corpo: {
        toolUseId: cartao.toolUseId,
        respostas: painel.respostasCartao.map((r) => ({ opcoes: r.opcoes, texto: r.texto.trim() })),
      },
    });
    // O cartão foi refeito ou limpo durante o `await`: esta resposta é de um cartão que já
    // não existe, e não pode mexer no novo.
    if (painel.cartao !== cartao) return;
    painel.estadoCartao = 'enviado';
  } catch (erro) {
    if (painel.cartao !== cartao) return;
    painel.estadoCartao = 'erro';
    erroEl.textContent = erro.message;
    erroEl.hidden = false;
    if (erro.parcial) {
      // Já saiu tecla: o resto se termina no terminal, que tem de estar à vista.
      painel.terminalPergunta.open = true;
      painel.perguntaTeclas.hidden = false;
    }
  }
  sincronizarCartao(painel);
}

/**
 * Busca a tela da pane. Só existe enquanto a aba está `waiting` — fora disso o servidor
 * responde 409, e é assim que esta rota não vira espelho do terminal na web.
 *
 * Sai de dois lugares: da hora em que a pergunta aparece e do ciclo da lista que já
 * roda. Sem relógio novo.
 */
async function atualizarTelaDaPane(painel) {
  if (!painel || !painel.perguntando) return;
  try {
    const { tela, cartao, semGancho } = await api(`api/abas/${painel.chave}/tela`);
    // ANTES de pintar: o `rolarFim` da 1ª pintura mede o `scrollHeight` naquela hora — desesconder depois
    // deixaria o aviso abaixo da dobra (card pergunta-sem-gancho-avisa, achado do painel da spec).
    painel.avisoGancho.hidden = !(semGancho === true && painel.perguntando);
    pintarTelaDaPane(painel, tela);
    // Se a pergunta fechou enquanto a resposta voltava, o cartão não pode renascer.
    if (painel.perguntando) pintarCartao(painel, cartao || null);
  } catch {
    // 409 = a pergunta já foi respondida no terminal e o estado ainda não chegou aqui.
    // Não vira erro na tela: o evento `esperando` do fluxo fecha o bloco na sequência.
  }
}

/**
 * Aperta uma tecla do menu na aba, e redesenha a tela com o que a TUI repintou.
 *
 * São seis teclas — as quatro setas, Enter e Escape —, e a lista é fechada NO SERVIDOR
 * (lib/abas.js): tecla livre daqui viraria teclado remoto, que é o que a D4 e a D6
 * recusaram. Seta e Enter respondem qualquer menu sem o cockpit precisar entender o que
 * está escrito na tela — ler layout de TUI para desenhar um botão por opção quebra no
 * primeiro menu desconhecido.
 *
 * Dois toques rápidos no `↓` não se atropelam: o servidor passa as teclas pela mesma fila
 * por aba dos envios de texto (armadilha #28), então elas chegam na ordem em que saíram.
 *
 * Recebe o painel — capturado no closure do botão que apertou (§4.7 da spec): é ELE quem
 * pediu, e um `await` no meio não pode trocar de alvo debaixo do dedo.
 */
async function apertarTecla(painel, nome) {
  if (!painel.perguntando) return;
  // A luz do botão (card responder-a-pergunta-pelo-teclado): `painel.pergunta.querySelector`
  // porque `painel.perguntaTeclas` NÃO existe fora do closure de `criarPainel` — `.pergunta`
  // CONTÉM `.pergunta-teclas`, e o `data-tecla` já existe nos seis botões. Vale para o
  // clique também: um caminho só, a mesma marca.
  const botao = painel.pergunta.querySelector(`[data-tecla="${nome}"]`);
  // CONTADOR, não booleano (R8): a própria função avisa que "dois toques rápidos no ↓" é
  // esperado — um booleano apagaria a luz na primeira resposta a voltar, com a segunda
  // tecla ainda no ar. `+1` antes do `await`, `-1` no `finally`, some só em zero.
  if (botao) botao.dataset.apertada = String(Number(botao.dataset.apertada || 0) + 1);
  try {
    const r = await api(`api/abas/${painel.chave}/teclas`, { method: 'POST', corpo: { tecla: nome } });
    // O Esc (e o Enter que fecha o menu) tira a aba de `waiting`. O servidor avisa nesse
    // mesmo retorno, e o bloco some na hora em vez de esperar o evento do fluxo chegar.
    //
    // O `motivo` volta junto porque o Enter que ACEITA a pasta muda o estado sem fechar o
    // bloco: a aba sai do prompt de confiança e o agente começa a subir na mesma tela. Sem
    // reaplicar o motivo aqui, o rótulo do Parar ficaria preso em "Fechar o agente" até o
    // próximo tique do fluxo.
    if (r.esperando === false) marcarPergunta(painel, false);
    else {
      marcarPergunta(painel, true, r.motivo || 'menu');
      pintarTelaDaPane(painel, r.tela);
    }
  } catch (erro) {
    noPainel(painel, () => bolha('bolha-erro', tr`não deu para apertar ${nome}: ${erro.message}`));
    rolarFim(painel);
  } finally {
    if (botao) {
      const restantes = Number(botao.dataset.apertada || 0) - 1;
      if (restantes <= 0) delete botao.dataset.apertada;
      else botao.dataset.apertada = String(restantes);
    }
  }
}

/**
 * Fecha o painel — o GESTO do usuário (R15/R27/R40/R41 da spec). `chave` fora do `Map` é
 * no-op: aguenta a chegada dupla do DELETE do `✕` com o evento `removida` que o servidor
 * manda em seguida.
 *
 * Fechar um painel LATERAL não mexe no foco (R40): com três painéis, uma `removida` do de
 * fora mudaria o destinatário da caixa debaixo do usuário sem ele ter pedido nada. Só quando o
 * painel fechado ERA o foco é que outro assume — o vizinho da DIREITA e, faltando, o da
 * ESQUERDA. `religarFluxo()` (R41) religa o cano mesmo sobrando painéis: sem isto o servidor
 * seguiria acompanhando a aba fechada até a próxima reconexão por outro motivo.
 */
function fecharPainel(chave) {
  if (!paineis.has(chave)) return;
  const eraFoco = atual === chave;
  // Medida ANTES do `tirarPainel()` abaixo (§3.9 da spec): ele remove o nó da árvore, e no
  // navegador remover o elemento focado já o desfoca — ler `document.activeElement` DEPOIS
  // seria lê-lo sempre falso.
  const oCursorEstavaAqui = paineis.get(chave).entrada === document.activeElement;
  const ordem = [...paineis.keys()];
  const indice = ordem.indexOf(chave);
  const painel = tirarPainel(chave);
  religarFluxo();
  fecharPaleta(painel);
  if (eraFoco) {
    const direita = ordem.slice(indice + 1).find((k) => paineis.has(k));
    const esquerda = [...ordem.slice(0, indice)].reverse().find((k) => paineis.has(k));
    const proximo = direita || esquerda;
    if (proximo) {
      focar(paineis.get(proximo));
      // §3.9 da spec, consequência 2: CONDICIONAL, e só quando o CURSOR estava neste
      // painel — um painel pode morrer PELO TERMINAL (`removida`), sem gesto nenhum do
      // usuário, e um `.focus()` incondicional arrancaria o cursor de A (que segue
      // escrevendo) e o levaria para C. Cursor no `<body>` é inerte; roubá-lo em silêncio
      // para a caixa de outro agente é o pior defeito possível desta tela.
      if (oCursorEstavaAqui) paineis.get(proximo).entrada.focus();
    } else atual = null;
  }
  if (!paineis.size) {
    $('vazio').hidden = false;
    // Desempilha em vez de trocar a vista na mão: a entrada que `abrirAba` empilhou tem que
    // sair junto com a conversa, senão o voltar do aparelho gastaria um toque à toa nela.
    // Só quando NÃO sobra painel nenhum — trocar de conjunto não é isto (R27), e passa por
    // `trocarConjunto`/`tirarPainel`, nunca por aqui.
    pedirLista();
  }
  desenharAbas();
}

// ── Abrir e fechar aba do terminal ──────────────────────────────────────
//
// A primeira vez que o cockpit CRIA e DESTRÓI coisa no terminal do usuário. Até aqui ele só
// lia a lista e digitava na aba que já existia.
//
// Duas regras que valem para os dois caminhos:
//   · o caminho de disco NUNCA sai daqui — o corpo do POST leva o NOME do projeto e quem
//     resolve o caminho é o servidor (#22, a cicatriz do anexo);
//   · o recado de erro vai DENTRO do diálogo, que continua aberto. Os dois painéis são
//     <dialog> MODAIS: uma bolha na fita nasceria atrás deles, invisível (D32).

// A lista de modelos do agente escolhido e o agente padrão — guardados aqui para
// `mostrarModelos()` reler sem precisar de outro `fetch` a cada troca do <select> de agente.
let agentesDaAba = [];
let agentePadraoDaAba = 'claude';

// O campo Projeto que filtra (card `pesquisar-a-pasta-na-aba-nova`). O diálogo é ÚNICO, então o
// estado é de módulo, como o de cima — não é por painel. `projetosDaAba` é a lista que VALE para
// recusar nome, e só troca quando o GET responde (S4 da spec): o Criar clicado durante o `fetch`
// não pode validar contra lista vazia. O servidor valida de novo de qualquer jeito (#22).
let projetosDaAba = [];
let escolhidosProjeto = [];
let indiceProjeto = 0;
// Criar pasta pela aba nova (card `criar-pasta-na-aba-nova`). A MESMA régua do servidor (`server.js`,
// `NOME_DE_PASTA`); mudou uma, muda a outra.
const NOME_DE_PASTA = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Cada abertura do diálogo ganha um número (S15): a resposta de um POST só vale para a abertura que o
// pediu — senão criar `x`, fechar, reabrir e escolher `app` terminaria com o campo trocado para `x`.
let aberturaDaAba = 0;
// A abertura com um POST de pasta em voo (S10): dois toques = um POST, e a trava de uma abertura velha
// não trava a nova.
let criandoPasta = null;
// A abertura cujo GET de projetos já respondeu (S17): antes disso não há como saber se o nome existe, e o
// item de criar não aparece.
let aberturaLida = 0;

/** Enche a lista do campo Projeto com os projetos de ~/projetos. Só o NOME vem do servidor. */
async function carregarProjetos() {
  // Reset SÍNCRONO, antes do primeiro `await`: sem ele, o Criar fica habilitado (`:3508`)
  // antes de `carregarAgentes()` terminar, e com `/api/agentes` lento a escolha da abertura
  // ANTERIOR do diálogo (ex.: Fable) sairia numa aba que o usuário achava estar em Padrão.
  const campoModelo = $('campo-modelo-novo');
  if (campoModelo) campoModelo.hidden = true;
  const selModelo = $('sel-modelo-novo');
  if (selModelo) idiomaUI.bind(selModelo, 'textContent', () => tr(''));

  // O campo zera e a lista fecha na hora; `projetosDaAba` só troca quando o GET responde (S4).
  // S15/S17 (card `criar-pasta-na-aba-nova`): cada abertura tem número; respostas de abertura velha não escrevem.
  aberturaDaAba += 1;
  const abertura = aberturaDaAba;
  const alvo = $('sel-projeto-novo');
  alvo.value = '';
  fecharListaProjetos();
  idiomaUI.bind($('nota-nova-aba'), 'textContent', () => tr(''));
  let projetos = [];
  try {
    projetos = (await api('api/projetos')).projetos || [];
    if (abertura !== aberturaDaAba) return;   // S17a: uma abertura mais nova já cuida da tela
    projetosDaAba = projetos.map((p) => p.nome);
    aberturaLida = abertura;                  // S17b: agora dá para oferecer criar pasta
  } catch (erro) {
    if (abertura !== aberturaDaAba) return;   // S17a
    idiomaUI.bind($('nota-nova-aba'), 'textContent', () => tr`não deu para ler os projetos: ${erro.message}`);
  }
  // Sem projeto não há o que criar, e o Criar nasce travado com o motivo escrito — nunca
  // um botão que só sabe falhar.
  $('btn-criar-aba').disabled = projetos.length === 0;
  if (!projetos.length) idiomaUI.bind($('nota-nova-aba'), 'textContent', () => tr('nenhum projeto em ~/projetos'));

  // O `autofocus` pôs o cursor no campo antes do GET voltar: a lista do foco foi desenhada com a
  // lista velha (ou vazia). Redesenha com a nova — só se o cursor continua lá.
  if (document.activeElement === alvo) filtrarProjetos();
  await carregarAgentes();
}

// ── A lista do campo Projeto: o padrão da paleta de comandos (`desenharPaleta`/`escolher`),
// num campo no topo de um diálogo. Itens com as classes da paleta; contêiner próprio.

/** Recorta `projetosDaAba` pelo que está no campo: sem acento e sem caixa, prefixo primeiro. */
function filtrarProjetos() {
  const busca = normalizarBusca($('sel-projeto-novo').value);
  // S4 (card `criar-pasta-na-aba-nova`): "Meu Projeto" acha `Meu-Projeto` pelo nome convertido — senão a lista
  // diria "nenhuma pasta" e o item de criar também sumiria (a pasta existe), um beco sem saída.
  const convertida = normalizarBusca(nomeDePasta($('sel-projeto-novo').value));
  const casa = (nome) => normalizarBusca(nome).includes(busca) || (convertida !== '' && normalizarBusca(nome).includes(convertida));
  const comeca = (nome) => (normalizarBusca(nome).startsWith(busca) ? 0 : 1);
  // `sort` é estável: dentro de cada grupo fica a ordem do servidor (localeCompare).
  escolhidosProjeto = projetosDaAba
    .filter(casa)
    .sort((a, b) => comeca(a) - comeca(b));
  // S5: sem nome nenhum, nada nasce destacado — Enter "no vazio" não pode criar pasta.
  indiceProjeto = escolhidosProjeto.length ? 0 : -1;
  desenharProjetos();
}

function desenharProjetos() {
  const lista = $('lista-projeto-novo');
  const campo = $('sel-projeto-novo');
  lista.textContent = '';
  lista.hidden = false;
  campo.setAttribute('aria-expanded', 'true');
  // O destacado guardado aqui, e não relido por id: no DOM falso do gate `getElementById` cria qualquer id (#55).
  let destacado = null;
  if (!escolhidosProjeto.length) {
    const vazio = document.createElement('div');
    vazio.className = 'paleta-vazia';
    idiomaUI.bind(vazio, 'textContent', () => tr('Nenhuma pasta com esse nome.'));
    lista.append(vazio);
  }
  escolhidosProjeto.forEach((nome, i) => {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'paleta-item';
    botao.id = `projeto-opcao-${i}`;
    botao.setAttribute('tabindex', '-1');
    botao.setAttribute('role', 'option');
    botao.setAttribute('aria-selected', String(i === indiceProjeto));
    botao.textContent = nome;
    // mousedown, não click: o clique tira o foco do campo e o `blur` fecharia a lista antes.
    botao.onmousedown = (evento) => { evento.preventDefault(); escolherProjeto(i); };
    lista.append(botao);
    if (i === indiceProjeto) destacado = botao;
  });
  // O "+ Criar pasta" no FIM (card `criar-pasta-na-aba-nova`): é a última posição da navegação (S6).
  const pasta = pastaOferecida();
  if (pasta) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'paleta-item paleta-criar';
    botao.id = 'projeto-opcao-criar';
    botao.dataset.criar = '1';
    botao.setAttribute('tabindex', '-1');
    botao.setAttribute('role', 'option');
    botao.setAttribute('aria-selected', String(indiceProjeto === escolhidosProjeto.length));
    idiomaUI.bind(botao, 'textContent', () => tr`+ Criar pasta ${pasta}`);
    botao.onmousedown = (evento) => { evento.preventDefault(); criarPasta(); };
    lista.append(botao);
    if (indiceProjeto === escolhidosProjeto.length) destacado = botao;
  }
  if (destacado) {
    campo.setAttribute('aria-activedescendant', destacado.id);
    destacado.scrollIntoView({ block: 'nearest' });
  } else {
    campo.removeAttribute('aria-activedescendant');
  }
}

function fecharListaProjetos() {
  const lista = $('lista-projeto-novo');
  const campo = $('sel-projeto-novo');
  lista.textContent = '';
  lista.hidden = true;
  campo.setAttribute('aria-expanded', 'false');
  campo.removeAttribute('aria-activedescendant');
  escolhidosProjeto = [];
  indiceProjeto = 0;
}

/** Escreve o nome CANÔNICO no campo — é o que o Criar compara, byte a byte (S3). */
function escolherProjeto(i) {
  const nome = escolhidosProjeto[i];
  if (nome === undefined) return;
  $('sel-projeto-novo').value = nome;
  fecharListaProjetos();
  idiomaUI.bind($('nota-nova-aba'), 'textContent', () => tr(''));
}

/**
 * Abre a lista sem digitar (foco, clique, ↓). Com o campo valendo EXATAMENTE um nome da lista —
 * acabou de escolher —, mostra todas as pastas com a escolhida destacada: filtrar pelo nome
 * inteiro daria 1 item, e trocar de ideia exigiria apagar o texto à mão (S8 da spec).
 */
function abrirListaProjetos() {
  const valor = $('sel-projeto-novo').value;
  if (!projetosDaAba.includes(valor)) return filtrarProjetos();
  escolhidosProjeto = [...projetosDaAba];
  indiceProjeto = escolhidosProjeto.indexOf(valor);
  desenharProjetos();
}

function navegarProjetos(passo) {
  if ($('lista-projeto-novo').hidden) return abrirListaProjetos();
  // O item de criar pasta é a última posição (S6).
  const total = escolhidosProjeto.length + (pastaOferecida() ? 1 : 0);
  if (!total) return;
  if (indiceProjeto < 0) indiceProjeto = passo > 0 ? 0 : total - 1;
  else indiceProjeto = (indiceProjeto + passo + total) % total;
  desenharProjetos();
}

/**
 * O nome de pasta que o texto digitado vira (card `criar-pasta-na-aba-nova`, S1): sem acento, espaço vira
 * hífen, o resto que não for letra/número/-/_ sai. A caixa fica: há pastas camelCase.
 */
function nomeDePasta(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim()
    .replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '');
}

/** O convertido do campo quando ele vale o item "+ Criar pasta" (S1–S3); senão `null`. */
function pastaOferecida() {
  // S17b: sem a lista DESTA abertura não dá para saber se o nome já existe.
  if (aberturaLida !== aberturaDaAba) return null;
  const nome = nomeDePasta($('sel-projeto-novo').value);
  if (!NOME_DE_PASTA.test(nome)) return null;
  // A mesma chave do servidor (sem acento, sem caixa): `Demo` existindo, `demo` não é oferecido — o
  // servidor devolveria 409.
  const chave = normalizarBusca(nome);
  return projetosDaAba.some((n) => normalizarBusca(n) === chave) ? null : nome;
}

/**
 * Cria a pasta e a deixa escolhida no campo (decisão 6). O Criar continua sendo quem abre a aba.
 *
 * POST e GET em `try` separados (#32): o 201 já prova que a pasta existe, então um GET que falha não é
 * erro para a tela (S9). E a resposta só vale para a abertura do diálogo que a pediu (S15): UMA
 * conferência depois dos dois `await`, antes de qualquer escrita.
 */
async function criarPasta() {
  const nome = pastaOferecida();
  const abertura = aberturaDaAba;
  if (!nome || criandoPasta === abertura) return;
  criandoPasta = abertura;
  try {
    const criada = await api('api/projetos', { method: 'POST', corpo: { nome } });
    let lista = null;
    try { lista = ((await api('api/projetos')).projetos || []).map((p) => p.nome); }
    catch { /* S9: o 201 já provou que a pasta existe */ }
    if (abertura !== aberturaDaAba) return;
    if (lista) projetosDaAba = lista;
    if (!projetosDaAba.includes(criada.nome)) projetosDaAba.push(criada.nome);
    $('sel-projeto-novo').value = criada.nome;
    fecharListaProjetos();
    idiomaUI.bind($('nota-nova-aba'), 'textContent', () => tr(''));
    // Com a pasta de projetos vazia o Criar nascia travado; a primeira pasta o destrava.
    $('btn-criar-aba').disabled = projetosDaAba.length === 0;
  } catch (erro) {
    if (abertura !== aberturaDaAba) return;
    // A lista fecha para a nota ficar à vista no celular; o texto digitado fica.
    fecharListaProjetos();
    idiomaUI.bind($('nota-nova-aba'), 'textContent', () => tr(erro.message));
  } finally {
    if (criandoPasta === abertura) criandoPasta = null;
  }
}

/**
 * Enche o <select> do agente. A lista vem do SERVIDOR, nunca chumbada aqui.
 *
 * Quem sabe quais agentes existem é o registro `lib/agentes.js`, e é ele também que valida
 * o POST com 400. Duas listas — uma na tela, outra no servidor — é a #40 esperando: no dia
 * em que o Cursor entrar, uma das duas envelheceria calada.
 *
 * Falhar aqui NÃO trava o diálogo: o campo fica com o padrão e o POST vai sem `agente`, que
 * o servidor resolve para o `AGENTE_PADRAO`. Abrir aba de Claude é o caso de 100% das abas
 * de ontem; travar o Criar por causa do campo novo seria pior que o campo não aparecer.
 */
async function carregarAgentes() {
  const alvo = $('sel-agente-novo');
  if (!alvo) return;
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  let lista = [];
  let padrao = 'claude';
  try {
    const r = await api('api/agentes');
    lista = r.agentes || [];
    padrao = r.padrao || padrao;
  } catch { /* o campo fica vazio e o POST vai sem `agente` — o servidor usa o padrão */ }
  agentesDaAba = lista;
  agentePadraoDaAba = padrao;
  for (const a of lista) {
    const opcao = document.createElement('option');
    opcao.value = a.id;
    opcao.textContent = a.rotulo;
    if (a.id === padrao) opcao.selected = true;
    alvo.append(opcao);
  }
  alvo.onchange = mostrarModelos;
  mostrarModelos();
}

/**
 * Enche o <select> do Modelo com a lista do agente ESCOLHIDO — some quando ele não tem
 * lista (Codex, #40). A lista vem do servidor (`agentesDaAba`, lido em `carregarAgentes()`);
 * reabre sempre em Padrão: esvaziar e reencher a cada troca garante que voltar do Codex para
 * o Claude não arrasta a escolha de antes.
 */
function mostrarModelos() {
  const campo = $('campo-modelo-novo');
  const alvo = $('sel-modelo-novo');
  if (!campo || !alvo) return;
  const id = $('sel-agente-novo')?.value || agentePadraoDaAba;
  const modelos = (agentesDaAba.find((a) => a.id === id)?.modelos) || [];
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  const padrao = document.createElement('option');
  padrao.value = '';
  idiomaUI.bind(padrao, 'textContent', () => tr('Padrão'));
  padrao.selected = true;
  alvo.append(padrao);
  for (const m of modelos) {
    const opcao = document.createElement('option');
    opcao.value = m.id;
    opcao.textContent = m.rotulo;
    alvo.append(opcao);
  }
  alvo.value = '';
  campo.hidden = modelos.length === 0;
}

/**
 * Cria a aba e já entra nela.
 *
 * A trava contra dedo duplo é o MESMO `data-recarregando` que o `recarregar()` usa: no
 * celular dois toques rápidos são dois POST e duas abas, e "criar não é destrutivo" não
 * torna isso desejável — é ruído que ele teria que limpar no terminal, que é a coisa que
 * este recurso existe para acabar. Ela solta no `finally`, INCLUSIVE quando o pedido falha:
 * senão o Criar morre no primeiro erro.
 *
 * `carregarAbas()` no `await` da resposta é o "sem esperar o tique de 5 s" que o card pede.
 * Não é relógio novo — a D21 diz que aqui só existe um; é a mesma leitura, adiantada.
 */
async function criarAba(botao) {
  if (botao && botao.dataset.recarregando === '1') return;
  // Nome fora da lista não sai daqui (card `pesquisar-a-pasta-na-aba-nova`). Valor EXATO, sem
  // trim: o servidor preserva espaço no nome da pasta, e aparar `app ` mandaria a aba para `app`
  // (S3). A recusa é conforto — quem garante é o servidor (#22), que casa exato e devolve 400.
  const projeto = $('sel-projeto-novo').value;
  if (!projetosDaAba.includes(projeto)) {
    idiomaUI.bind($('nota-nova-aba'), 'textContent', () => (projeto
      ? tr`nenhuma pasta "${projeto}" em ~/projetos — escolha uma da lista`
      : tr('escolha um projeto da lista')));
    return;
  }
  if (botao) botao.dataset.recarregando = '1';
  idiomaUI.bind($('nota-nova-aba'), 'textContent', () => tr(''));
  try {
    // O corpo leva o NOME do projeto, o ID do agente e o ID do modelo — nunca caminho de
    // disco nenhum, dos dois lados (#22). `agente`/`modelo` vazios são omitidos de
    // propósito: ausente vira o padrão no servidor, e mandar string vazia seria pedir uma
    // validação que não precisa existir. `hidden === false`, não `!hidden`: no DOM falso do
    // gate `hidden` pode nascer `undefined` (#55), e "não sei" deve valer como escondido.
    const agente = $('sel-agente-novo')?.value || '';
    const modelo = $('campo-modelo-novo')?.hidden === false ? ($('sel-modelo-novo')?.value || '') : '';
    const nova = await api('api/abas', {
      method: 'POST',
      corpo: { projeto, ...(agente ? { agente } : {}), ...(modelo ? { modelo } : {}) },
    });
    $('dialogo-nova-aba').close();
    await carregarAbas();
    await abrirAba(nova.chave);
  } catch (erro) {
    idiomaUI.bind($('nota-nova-aba'), 'textContent', () => tr(erro.message));
  } finally {
    if (botao) botao.dataset.recarregando = '';
  }
}

/**
 * A linha de aviso do cabeçalho — o que ESTA aba tem de diferente.
 *
 * 🔴 Ela existe por causa do R1, e ele é o risco aceito desta entrega: o Codex NÃO publica
 * nada equivalente ao `status: waiting` do Claude. Não há campo no rollout, não há arquivo
 * por pid, e o par `task_*` só distingue "turno rodando" de "turno parado". Uma aba de Codex
 * com menu aberto na TUI é INDISTINGUÍVEL de uma aba parada — e o que o usuário mandar vira
 * TECLA de menu, que é a #25 na letra.
 *
 * Ler a tela com `capture-pane` para descobrir se há menu seria parsear framebuffer de TUI,
 * que a D4 recusou. Travar o envio travaria o uso normal — a aba parada é justamente quando
 * se escreve —, o que a D13 recusa com todas as letras: "não quero trava porque pode me
 * travar sem eu querer, eu já conheço os riscos". Sobra o aviso, que é o que ela aceita.
 *
 * E ele mora no CABEÇALHO, não como bolha na fita: o evento `sessao` do fluxo chama
 * `limparFita()`, e uma bolha criada aqui seria apagada por ele um instante depois. Medido —
 * o aviso aparecia e sumia sozinho, e o smoke de navegador pegou.
 *
 * As duas frases do casamento são DIFERENTES de propósito: "ainda não achei" é o estado
 * normal dos ~5 s que o rollout leva para nascer e some sozinha no `sessao` seguinte; "não
 * deu para saber qual" NÃO some, porque há duas abas de Codex no mesmo projeto e a regra é
 * aba SEM fita, nunca a fita da outra. Uma frase só para os dois estados é a #40.
 *
 * Segunda família, entrada de 02/09: o ESTADO da aba (abrindo/não subiu/sem agente), que até
 * então virava `bolha('bolha-erro', …)` dentro de `abrirAba` — e essas bolhas tinham o MESMO
 * problema do parágrafo acima, com um agravante: a de "abrindo" descrevia um CLI subindo
 * normalmente, mas chegava vermelha. A correção é a mesma: mora aqui, sobrevive ao
 * `limparFita`, e só o `falhou` (falha operacional de verdade) pinta em tom de erro — a marca
 * é `data-tom="erro"` na própria `<div>` da linha, nunca no container, porque este container
 * COMPÕE avisos (o de estado e o do Codex podem sair juntos) e um atributo nele pintaria de
 * vermelho um aviso vizinho que é neutro.
 */
function desenharAvisoDoAgente(painel, info) {
  const alvo = painel.aviso;
  if (!alvo) return;
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  alvo.hidden = true;
  if (!info) return;

  const linhas = [];   // [{ texto, erro }]
  if (!(info.temAgente ?? info.temClaude)) {
    if (info.nascendo) {
      linhas.push({ texto: tr('Abrindo o agente nesta aba… o histórico aparece em instantes.') });
    } else if (info.falhou) {
      linhas.push({ texto: tr('O agente não subiu nesta aba. Ela ficou como um terminal comum.'), erro: true });
    } else {
      linhas.push({ texto: tr('Esta aba está sem agente rodando. Dá para ler o histórico, mas não para enviar.') });
    }
  }
  if (info.agente === 'codex') {
    // O aviso PERMANENTE de "o cockpit não enxerga menu aberto" saiu em 10/09. Ele nasceu na
    // fase 6 do Codex (f163225) como mitigação de o Codex não publicar `status: waiting`, mas
    // era incondicional: ocupava quatro linhas do topo do celular em TODA aba de Codex, o
    // tempo inteiro, por um risco que só existe quando a TUI está mesmo num menu. Aviso que
    // aparece sempre para de ser lido — e este ficava exatamente onde a conversa começa.
    // O risco continua real (#6/#25) e quem o resolve de verdade é o card
    // `menu-da-tui-do-codex-na-tela`: enxergar o menu, como já se faz com o Claude.
    // Os avisos abaixo FICAM: os três são condicionais e dizem algo que aconteceu.
    if (info.casamento === 'ambiguo') {
      linhas.push({ texto: tr('não deu para saber qual conversa é desta aba (duas abas de Codex no mesmo projeto)') });
    } else if (info.reiniciada) {
      linhas.push({ texto: tr('Conversa limpa. Envie uma mensagem para começar.') });
    } else if (info.casamento === 'nenhum') {
      linhas.push({ texto: tr('ainda não achei a conversa desta aba de Codex') });
    }
  }
  if (!linhas.length) return;
  for (const { texto, erro } of linhas) {
    const linha = document.createElement('div');
    idiomaUI.bind(linha, 'textContent', () => tr(texto));
    if (erro) linha.dataset.tom = 'erro';
    alvo.append(linha);
  }
  alvo.hidden = false;
}

/**
 * Escreve o estado + desfecho de um JOB no cabeçalho (`painel.aviso`) — chamada tanto pelo
 * `case 'sessao'` (estado de PARTIDA, para não ficar mudo até a primeira transição) quanto
 * pelo `case 'job_estado'` (a transição em si). NUNCA toca na fita: é irmã de `esperando` e
 * `status_codex`, que já atualizam estado sem mexer no histórico (§5.3.3 da spec — o `sessao`
 * continua sendo o único que limpa a fita).
 *
 * `aviso` nasce escondido (`criarPainel`) e `desenharAvisoDoAgente(painel, undefined)` o
 * esconde de novo — é o que `trocarConjunto` chama para TODO painel novo, job incluído. Este
 * escritor tem de SOLTAR o `hidden` de novo, e escreve pelo `idiomaUI.bind` como todo texto
 * desta tela — senão a troca de idioma apaga a frase.
 */
function desenharEstadoDoJob(painel, job) {
  const alvo = painel.aviso;
  if (!alvo) return;
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  const rotulo = ROTULOS_DE_JOB[job.estado] || job.estado || tr('desconhecido');
  const linha = document.createElement('div');
  idiomaUI.bind(linha, 'textContent', () => tr(job.desfecho ? `${tr(rotulo)} — ${job.desfecho}` : tr(rotulo)));
  alvo.append(linha);
  alvo.hidden = false;
}

/** O que a confirmação escreve, tirado da aba que a lista JÁ tem. */
function estadoParaMatar(aba) {
  if (!aba) return tr('Esta aba não está mais na lista.');
  if (aba.rodando) return tr('Esta aba está TRABALHANDO agora. Fechar mata o turno em andamento.');
  if (aba.esperando) return tr('Esta aba está com uma pergunta aberta no terminal.');
  if (aba.temAgente ?? aba.temClaude) return tr('Fechar encerra o agente desta aba.');
  if (aba.nascendo) return tr('O agente desta aba ainda está subindo.');
  if (aba.falhou) return tr('O agente não subiu nesta aba — ela ficou como um terminal comum.');
  return tr('Esta aba não tem agente rodando.');
}

/**
 * Fecha a aba no terminal.
 *
 * UM caminho só para fechar a vista (R4): quem fecha é o `fecharPainel()` de sempre, que
 * tira o painel do `Map` e desempilha uma vez. O `removida` que o servidor manda logo em
 * seguida cai no caminho de sempre e vira no-op, porque o painel já saiu do `Map`. Dois
 * `history.back()` sairiam do app — o defeito que a D31 consertou.
 *
 * `painel` vem de `painelPedindoMorte` (R17 da spec): o `<dialog>` é UM só, compartilhado, e
 * é o `✕` de CADA painel que grava ali qual deles pediu — nunca `atual`.
 *
 * E quando o DELETE FALHA, a conversa continua aberta: fechar a vista de uma aba que não
 * morreu seria pior que o erro.
 */
async function matarAba(painel, botao) {
  if (!painel) return;
  if (botao && botao.dataset.recarregando === '1') return;
  if (botao) botao.dataset.recarregando = '1';
  idiomaUI.bind($('nota-matar-aba'), 'textContent', () => tr(''));
  try {
    await api(`api/abas/${painel.chave}`, { method: 'DELETE' });
    $('dialogo-matar-aba').close();
    fecharPainel(painel.chave);
    await carregarAbas();
  } catch (erro) {
    idiomaUI.bind($('nota-matar-aba'), 'textContent', () => tr(erro.message));
  } finally {
    if (botao) botao.dataset.recarregando = '';
  }
}

/**
 * Abre o diálogo de renomear para `aba` (card `renomear-a-aba`). Objeto NOVO em `edicaoDoNome` a
 * cada abertura: é o que deixa um `PATCH` antigo saber que a edição dele já acabou.
 */
function abrirRenomear(aba) {
  edicaoDoNome = { chave: aba.chave, enviando: false };
  // A trava de duplo toque é da EDIÇÃO, não do botão (que é um só): um pedido de A ainda no ar não
  // pode deixar o Salvar de B travado e mudo. Abrir destrava o botão; quem trava é o envio DESTA
  // edição (`renomearAba`).
  $('btn-confirma-renomear-aba').dataset.recarregando = '';
  const campo = $('nome-aba');
  campo.value = aba.titulo || '';
  idiomaUI.bind($('nota-renomear-aba'), 'textContent', () => tr(''));
  $('dialogo-renomear-aba').showModal();
  // `setSelectionRange`, não `select()`: o DOM de mentira do gate não tem `select`, e um TypeError
  // dentro de handler morre calado (#55).
  campo.focus();
  campo.setSelectionRange(0, campo.value.length);
}

/**
 * Manda o nome novo. O que é do SERVIDOR acontece sempre (o nome já mudou no tmux, a tela tem de
 * refletir); o que é do DIÁLOGO só se a edição ainda for a mesma — ver `edicaoDoNome`.
 */
async function renomearAba(botao) {
  const edicao = edicaoDoNome;
  // Duplo toque: a trava mora na EDIÇÃO (ver `abrirRenomear`). O `data-recarregando` do botão é
  // só o retorno visual, o mesmo do `criarAba`/`matarAba`.
  if (!edicao || edicao.enviando) return;
  edicao.enviando = true;
  if (botao) botao.dataset.recarregando = '1';
  const chave = edicao.chave;
  enviosDoNome += 1;
  const envio = enviosDoNome;
  idiomaUI.bind($('nota-renomear-aba'), 'textContent', () => tr(''));
  try {
    const r = await api(`api/abas/${chave}`, { method: 'PATCH', corpo: { nome: $('nome-aba').value } });
    if (envio > (aplicadoPorChave.get(chave) || 0)) {
      aplicadoPorChave.set(chave, envio);
      const painel = paineis.get(chave);
      if (painel) painel.titulo.textContent = r.titulo;
    }
    if (edicaoDoNome === edicao) $('dialogo-renomear-aba').close();
    leituraDoNome += 1;
    const leitura = leituraDoNome;
    await carregarAbas();
    // Todo painel aberto copia o título da lista nova. Desde a D66 o ✎ de uma pane de janela dividida
    // não muda a irmã (#67 resolvida), mas o caminho `rename-window` (janela de 1 pane, aba de janela)
    // ainda muda o `window_name`, que é o título de toda pane sem nome próprio — e um nome trocado
    // pelo terminal também chega aqui. O cliente não sabe quem divide janela com quem; a lista sabe.
    // Lista vazia (o GET falhou) não acha ninguém e não apaga título nenhum. E só a
    // leitura MAIS RECENTE sincroniza (ver `leituraDoNome`): a de um rename antigo pode ser velha.
    if (leitura !== leituraDoNome) return;
    for (const [chaveDoPainel, p] of paineis) {
      const daLista = abasDoTerminal.find((a) => a.chave === chaveDoPainel);
      if (daLista && daLista.titulo) p.titulo.textContent = daLista.titulo;
    }
  } catch (erro) {
    if (edicaoDoNome === edicao) idiomaUI.bind($('nota-renomear-aba'), 'textContent', () => tr(erro.message));
  } finally {
    edicao.enviando = false;
    // Só destrava o botão se ele ainda for DESTA edição: se B já abriu (e talvez já esteja
    // enviando), o botão é de B e quem o destrava é o `finally` de B.
    if (botao && edicaoDoNome === edicao) botao.dataset.recarregando = '';
  }
}

// ── /status do Codex: bloco nativo, sem turno de modelo ──────────────────
//
// `/status` exato numa aba de Codex vai para a rota dedicada (`POST /api/abas/:chave/status`),
// nunca para `/turnos`: não é conversa com o agente, é o Cockpit perguntando ao próprio CLI.
// Por isso não há bolha "eu", não há `marcarOcupado`, e a resposta mora num bloco PRÓPRIO,
// persistido no servidor e reconstruído pelo replay do SSE (`case 'status_codex'` acima).
// Ver docs/superpowers/specs/2026-09-08-resposta-status-codex-design.md.

// Os quatro campos que este bloco usa (`statusCodexSessao`, `statusCodexGeracao`,
// `statusCodexEl`, `statusCodexIds`) nasceram como `let` de MÓDULO no develop de 08/09 e
// viraram campos do PAINEL no merge do split view: são estado de conversa, e com N painéis
// duas conversas de Codex na tela compartilhariam o bloco de status e a dedupe por `id`.
// Quem só DESENHA lê `P` (a regra do dono, ver a declaração de `P` no topo); quem tem
// `await` recebe o painel e o captura antes.

function blocoStatusCodex() {
  // Cache simples, sem checar presença no DOM: `limparFita()` é o ÚNICO lugar que zera
  // `statusCodexEl`, exatamente como `ultimaFala` é reciclado por outros eventos. Não há
  // caminho que remova o bloco da fita sem passar por ali.
  if (P.statusCodexEl) return P.statusCodexEl;
  const div = document.createElement('div');
  div.className = 'status-codex';
  const titulo = document.createElement('div');
  titulo.className = 'status-codex-titulo';
  idiomaUI.bind(titulo, 'textContent', () => tr('Resultados de /status'));
  div.append(titulo);
  fita().append(div);
  P.statusCodexEl = div;
  return div;
}

/** A espera nasce com o `id` do envio, para `statusCodexResultado` achar e remover a dela
 * mesma se a resposta chegar primeiro pelo SSE (replay ou outro aparelho). */
function statusCodexEspera(idEnvio) {
  const bloco = blocoStatusCodex();
  const espera = document.createElement('div');
  espera.className = 'status-codex-espera';
  espera.dataset.id = idEnvio;
  idiomaUI.bind(espera, 'textContent', () => tr('Consultando status…'));
  bloco.append(espera);
  return espera;
}

/** A espera com este `id`, dentro do bloco — sem depender de seletor composto (`.classe` +
 * `[data-x]` juntos), que nem todo motor de seletor (inclusive o DOM de mentira do gate)
 * resolve igual. */
function statusCodexEsperaDe(bloco, id) {
  if (!id) return null;
  return Array.from(bloco.querySelectorAll('.status-codex-espera')).find((el) => el.dataset.id === id) || null;
}

function statusCodexErro(idEnvio, mensagem) {
  const bloco = blocoStatusCodex();
  const espera = statusCodexEsperaDe(bloco, idEnvio);
  if (espera) espera.remove();
  const div = document.createElement('div');
  div.className = 'status-codex-erro';
  idiomaUI.bind(div, 'textContent', () => tr(mensagem));
  bloco.append(div);
}

/** Desenha um snapshot — vindo do HTTP (resposta do POST) ou do SSE (ao vivo/replay). */
function statusCodexResultado({ id, quando, texto, sessaoId }) {
  if (!sessaoId || sessaoId !== P.statusCodexSessao || typeof id !== 'string' || typeof texto !== 'string') return;
  if (P.statusCodexIds.has(id)) return;
  P.statusCodexIds.add(id);
  const bloco = blocoStatusCodex();
  const espera = statusCodexEsperaDe(bloco, id);
  if (espera) espera.remove();

  const item = document.createElement('details');
  item.className = 'status-codex-item';
  item.dataset.id = id;
  item.dataset.quando = quando;
  item.open = true;
  const sum = document.createElement('summary');
  const rotulo = new Date(quando).toLocaleString(idiomaUI.idioma);
  const rotuloTexto = document.createElement('span');
  idiomaUI.bind(rotuloTexto, 'textContent', () => tr`Status do Codex · saída do terminal${rotulo ? ` — ${rotulo}` : ''}`);
  const copiar = botaoCopiar(() => texto, tr('Copiar o status do Codex'), { classe: 'status-codex-copiar' });
  copiar.addEventListener('click', (ev) => ev.stopPropagation());
  sum.append(rotuloTexto, copiar);
  const pre = document.createElement('pre');
  pre.className = 'status-codex-texto';
  pre.textContent = texto;
  item.append(sum, pre);
  bloco.append(item);
  const itens = Array.from(bloco.querySelectorAll('.status-codex-item')).sort((a, b) => String(a.dataset.quando).localeCompare(String(b.dataset.quando)));
  for (const antigo of itens.slice(0, Math.max(0, itens.length - 20))) {
    P.statusCodexIds.delete(antigo.dataset.id);
    antigo.remove();
  }
  for (const visivel of itens.slice(-20)) bloco.append(visivel);
}

/**
 * `/status` exato numa aba de Codex: sem bolha, sem `marcarOcupado`, sem POST /turnos.
 *
 * Guarda a CHAVE no início do await — resultado ou erro tardio não pinta se o usuário já
 * navegou para outra conversa (spec: "resultado/erro tardio não vaza ao navegar").
 */
async function enviarStatusCodex(painel) {
  const entrada = painel.entrada;
  escreverNaCaixa(painel, '', entrada);
  entrada.style.height = 'auto';
  fecharPaleta(painel);
  lembrar(painel, '/status');
  sairDoHistorico(painel);

  // O painel é capturado, não relido: `atual` pode ter mudado de dono enquanto o POST
  // andava. `aindaAqui` pergunta pelo PAINEL (ele ainda está na tela? é a mesma conversa?),
  // não pelo foco — resultado tardio pinta no painel certo mesmo se o usuário já clicou noutro.
  const sessaoDaVez = painel.statusCodexSessao;
  const geracaoDaVez = painel.statusCodexGeracao;
  const aindaAqui = () => paineis.get(painel.chave) === painel
    && painel.statusCodexSessao === sessaoDaVez && painel.statusCodexGeracao === geracaoDaVez;
  const idEnvio = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const estavaNoFim = estaNoFim(painel);
  noPainel(painel, () => statusCodexEspera(idEnvio));
  rolarFimSeGrudado(painel, estavaNoFim);

  try {
    const resultado = await api(`api/abas/${painel.chave}/status`, { method: 'POST', corpo: { id: idEnvio } });
    if (!aindaAqui()) return;
    const colado = estaNoFim(painel);
    noPainel(painel, () => statusCodexResultado(resultado));
    rolarFimSeGrudado(painel, colado);
  } catch (erro) {
    if (!aindaAqui()) return;
    if (!painel.statusCodexIds.has(idEnvio)) noPainel(painel, () => statusCodexErro(idEnvio, erro.message));
  }
}

/**
 * Comando nativo do Codex (`/clear`, `/new`, `/compact`, `/diff`) — develop de 08/09,
 * adaptado ao painel no merge do split view.
 *
 * Como todo caminho com `await`, ele recebe o painel e o captura: `atual` é o painel FOCADO,
 * e entre o POST e a resposta o usuário pode ter clicado noutro. `aindaAqui` pergunta pelo
 * PAINEL (ainda está na tela? é a mesma conversa?), não pelo foco.
 */
async function enviarComandoCodex(painel, texto) {
  const geracao = painel.statusCodexGeracao;
  const aindaAqui = () => paineis.get(painel.chave) === painel && painel.statusCodexGeracao === geracao;
  const entrada = painel.entrada;
  escreverNaCaixa(painel, '', entrada);
  entrada.style.height = 'auto';
  fecharPaleta(painel);
  lembrar(painel, texto);
  sairDoHistorico(painel);
  const aviso = noPainel(painel, () => bolha('bolha-aviso', tr`Enviando ${texto} ao terminal…`));
  rolarFim(painel);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await api(`api/abas/${painel.chave}/turnos`, { method: 'POST', corpo: { texto, id } });
    if (!aindaAqui()) return;
    if (texto === '/clear' || texto === '/new') {
      // O servidor confirmou e persistiu o reset. Recarregar o painel usa a mesma fonte da
      // recarga manual — `abrirAba` aqui trocaria o CONJUNTO de painéis (§4.2 da spec).
      await recarregarPainel(painel);
    } else idiomaUI.bind(aviso, 'textContent', () => tr`${texto} enviado ao terminal.`);
  } catch (erro) {
    if (!aindaAqui()) return;
    aviso.remove();
    noPainel(painel, () => bolha('bolha-erro', erro.message));
  }
}

/**
 * O texto vai para a aba do terminal, digitado nela por `send-keys`.
 *
 * O anexo não viaja como binário: ele já subiu para ~/.cockpit/anexos/ e o que vai na
 * mensagem é o CAMINHO, que o CLI abre com o Read.
 */
async function enviar(painel) {
  if (!painel) return;
  const entrada = painel.entrada;
  const texto = entrada.value.trim();
  if (!texto) {
    // Caixa vazia COM anexo: o servidor exige texto (lib/abas.js:1207). O toque responde em vez de
    // sumir — "não acontece nada" foi o relato de 29/09. Sem anexo não há o que mandar.
    if (painel.anexos.length) {
      noPainel(painel, () => bolha('bolha-erro', tr('Escreva uma mensagem para ir junto do anexo.')));
      rolarFim(painel);
    }
    return;
  }
  // `pre-sessao`: o prompt de confiança de pasta nova. Mandar o usuário "cancelar com Esc"
  // ali o faria fechar o agente que ele acabou de abrir — a trava continua, e o recado é
  // o que resolve: responder pelas setas, que é o que os botões logo acima já fazem.
  //
  // `menu` (card escrever-texto-na-pergunta-aberta): a guarda SAIU. O servidor faz o gesto
  // (Escape → reconfere → cola → Enter, `lib/abas.js` `digitarNaAba`) em vez de recusar de
  // cara — o POST segue, e é o servidor quem decide.
  if (painel.perguntando && painel.motivoPergunta === 'pre-sessao') {
    const recado = tr('O agente está pedindo uma confirmação no terminal e ainda não abriu conversa. ')
      + tr('Responda pelas setas e o Enter aqui em cima — o Esc FECHA o agente.');
    noPainel(painel, () => bolha('bolha-erro', recado));
    rolarFim(painel);
    return;
  }
  // Anexo ainda subindo (card foto-some-entre-upload-e-envio): o toque ESPERA e o envio sai
  // sozinho. Antes isto era um `return` calado — com 3,6 MB no 4G, segundos de "não acontece
  // nada", e o usuário acabava mandando o texto sem as fotos. Depois da espera o envio RELÊ a
  // caixa (o que vale é o que está nela quando sai) e passa por todas as regras outra vez.
  const subindo = painel.anexos.filter((a) => a.estado === 'subindo');
  if (subindo.length) {
    const avisar = () => noPainel(painel, () => bolha('bolha-aviso',
      tr`Esperando ${subindo.length} anexo(s) subir — a mensagem sai sozinha.`));
    if (painel.esperandoAnexo) {
      // Segundo toque: não duplica. Redesenha o aviso no fim — se um `sessao` o levou, o toque
      // continua tendo resposta. Sem `isConnected`: o DOM do gate não o tem (#55).
      painel.esperandoAnexo.remove();
      painel.esperandoAnexo = avisar();
      painel.tocouDeNovo = true;
      rolarFim(painel);
      return;
    }
    painel.tocouDeNovo = false;
    painel.esperandoAnexo = avisar();
    rolarFim(painel);
    try {
      await Promise.all(subindo.map((a) => a.subida));
    } finally {
      painel.esperandoAnexo.remove();
      painel.esperandoAnexo = null;
    }
    if (paineis.get(painel.chave) !== painel) return;   // o painel saiu da tela no meio
    // Tirou no `×` um anexo que estava esperando: foi desistência, não "manda sem ela". O
    // envio automático para aqui — a caixa fica como o usuário deixou e o próximo toque decide.
    // Se esse próximo toque JÁ veio (Enviar depois do ×, com outra foto ainda subindo), ele não
    // pode ser engolido: vale a última ação do usuário.
    const tocouDeNovo = painel.tocouDeNovo;
    painel.tocouDeNovo = false;
    if (!tocouDeNovo && subindo.some((a) => !painel.anexos.includes(a))) return;
    return enviar(painel);
  }
  // Anexo que não subiu: nada sai e nada some. Antes o envio filtrava só `pronto` e mandava o
  // texto sem a foto, calado.
  if (painel.anexos.some((a) => a.estado === 'erro')) {
    noPainel(painel, () => bolha('bolha-erro',
      tr('Um anexo não subiu. Toque no × dele e anexe de novo — nada foi enviado.')));
    rolarFim(painel);
    return;
  }

  // `/status` exato numa aba de Codex: rota dedicada, nunca /turnos. Com anexo, a spec
  // pede recusa — nem status (o anexo seria ignorado sem aviso), nem envio genérico (o
  // Codex trataria /status como conversa, que é o que a rota dedicada existe para evitar).
  // A aba é a DESTE painel, não a focada: com N painéis os dois podem divergir.
  const infoDaAba = abasDoTerminal.find((a) => a.chave === painel.chave);
  if (texto === '/status' && infoDaAba?.agente === 'codex') {
    if (painel.anexos.some((a) => a.estado === 'pronto')) {
      noPainel(painel, () => bolha('bolha-erro', tr('/status não aceita anexo. Envie sem anexo para consultar o status.')));
      rolarFim(painel);
      return;
    }
    return enviarStatusCodex(painel);
  }
  if (/^\/(clear|new|compact|diff)$/.test(texto) && infoDaAba?.agente === 'codex') {
    if (painel.anexos.some((a) => a.estado === 'pronto')) {
      noPainel(painel, () => bolha('bolha-erro', tr`${texto} não aceita anexo. Envie o comando sem anexo.`));
      rolarFim(painel);
      return;
    }
    return enviarComandoCodex(painel, texto);
  }

  const caminhos = painel.anexos.filter((a) => a.estado === 'pronto').map((a) => a.caminho);
  const nomes = painel.anexos.filter((a) => a.estado === 'pronto').map((a) => a.nome);

  // O envio recusado (card menu-da-tui-do-codex-na-tela, R11) precisa dos ANEXOS de antes de
  // `limparAnexos` zerar a lista — capturado AQUI, antes das duas limpezas de baixo (que
  // fazem parte do envio, não mudança do usuário: o selo colhido depois delas é que prova
  // isso; ver `seloDaComposicao` abaixo).
  const anexosDoEnvio = painel.anexos.slice();

  // R35 da spec: `escreverNaCaixa` é o dono ÚNICO do `.value` — a atribuição programática
  // não dispara `input`, e é o `input` quem mantém `painel.textoNaCaixa` em dia na digitação.
  escreverNaCaixa(painel, '');
  entrada.style.height = 'auto';
  fecharPaleta(painel);
  lembrar(painel, texto);
  sairDoHistorico(painel);
  painel.ultimaFala = null;
  // Pendente: em ~1s o mesmo texto volta pelo arquivo do CLI, e é ESTA bolha que ele
  // preenche. Sem a marca, o SSE desenhava uma segunda logo embaixo.
  // Com turno rodando, esta mensagem não vai ser lida agora: ela fica na fila do CLI até
  // o turno acabar. A bolha diz isso enquanto o evento não volta do disco.
  // A hora é a do ENVIO, não a da leitura: mensagem na fila pode ficar minutos pendente, e
  // o que ele precisa ver é quando ele mandou. O evento que volta do disco corrige.
  const saiuEm = Date.now();
  // O `id` (D-n): nasce AQUI porque a bolha nasce ANTES do POST — um id devolvido na
  // resposta chegaria tarde, e o aviso do barramento pode passar na frente do 202.
  const idEnvio = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const el = noPainel(painel, () => marcarPendente(
    bolha('bolha-eu', nomes.length ? `${nomes.map((n) => `📎 ${n}`).join('\n')}\n\n${texto}` : texto, saiuEm),
    texto, saiuEm, painel.ocupado, idEnvio,
  ));
  const ficha = el.fichaPendente;   // §3.3: marcarPendente devolve o ELEMENTO, a ficha vai nele
  limparAnexos(painel);
  // O selo vem DEPOIS das duas limpezas (`escreverNaCaixa`/`limparAnexos`) de propósito: elas
  // são PARTE do envio, não mudança do usuário. Colhê-lo antes invalidaria o próprio envio que
  // ele existe para proteger — nenhuma restauração aconteceria nem no caso feliz.
  const seloDaComposicao = painel.seloComposicao;
  // Se o POST falhar, o "trabalhando" volta ao que ERA, não a `false`: com a mensagem indo
  // para a fila havia um turno rodando antes deste envio, e apagá-lo mentiria na tela.
  const jaRodava = painel.ocupado;
  marcarOcupado(painel, true);
  rolarFim(painel);

  try {
    await api(`api/abas/${painel.chave}/turnos`, {
      method: 'POST',
      corpo: caminhos.length ? { texto, anexos: caminhos, id: idEnvio } : { texto, id: idEnvio },
    });
    // Sucesso: os anexos não voltam para lugar nenhum — SÓ agora as `objectURL` são
    // revogadas (`limparAnexos`, acima, deixou de fazer isso — card menu-da-tui-do-codex-na-tela).
    for (const a of anexosDoEnvio) if (a.url) URL.revokeObjectURL(a.url);
  } catch (erro) {
    marcarOcupado(painel, jaRodava);
    // D-l: o servidor já desfez o registro dele (rollback do envio que falhou). Falta a
    // metade da tela — a bolha continuava dizendo "na fila" sobre uma mensagem que o
    // servidor acabou de dizer que NÃO enviou. Se o EventSource reconectou entre o desenho e
    // esta falha, o `sessao` já limpou a fita e zerou `pendentes` (D-e): o nó saiu do DOM, e
    // desmarcá-lo seria escrever no vazio — o texto não se perde, `lembrar(texto)` (acima) já
    // o guardou no histórico da caixa.
    if (painel.pendentes.includes(ficha)) { ficha.soltou = true; desmarcarPendente(ficha.el); }
    // Envio recuperável (card menu-da-tui-do-codex-na-tela, R11): 409 SEM `colado` é "nada
    // saiu" — o par volta para a gaveta da aba e, se a composição ainda for a MESMA daquele
    // envio (selo bate) e o painel continuar vivo, volta direto para a caixa. Qualquer outro
    // erro (409 com `colado`, rede, 500) não guarda nada: o texto já pode ter chegado à TUI
    // (colado) ou ao agente (rede/500), e reoferecer duplicaria (#21).
    const vivo = paineis.get(painel.chave);
    if (erro.status === 409 && !erro.colado) {
      guardarRecusado(painel.chave, texto, anexosDoEnvio);
      if (vivo === painel && painel.seloComposicao === seloDaComposicao) restaurarRecusado(painel);
    } else {
      for (const a of anexosDoEnvio) if (a.url) URL.revokeObjectURL(a.url);
    }
    noPainel(painel, () => bolha('bolha-erro', erro.message));
  }
}

// ── Paleta de comandos e skills ─────────────────────────────────────────
// Some `/` ou `$` no começo da mensagem e o cockpit mostra o que o agente entende. Quem
// executa é o CLI; o catálogo fornece /comando ou $skill conforme o agente. Sem isto,
// usar uma skill do celular exige lembrar o nome exato de cor.
//
// `/` busca comando e skill juntos, como sempre. `$` busca só skill — no Codex isso separa
// um comando embutido (`/clear`, sem arquivo nenhum) de uma skill homônima (`$clear`), que
// coexistem sem conflito.

// A escolha (`escolhidosPaleta`/`indicePaleta`) é campo DO PAINEL, não de módulo (§3.5 da
// spec): com N caixas, cada uma tem o PRÓPRIO catálogo filtrado e a própria seleção — deixar
// isto de módulo seria a #51 se repetindo uma camada acima (elemento que vira plural leva o
// ESTADO dele junto).

const PREFIXO_COMANDO = /^[/$]([\w:.-]*)$/;

/**
 * `painel.catalogo` — itens da sessão daquele painel, buscados uma vez.
 *
 * A comparação de "a conversa mudou durante a consulta" é por PAINEL, não por chave (§4.7 da
 * spec): comparar `atual !== abaConsultada` bastava com um painel só, mas o que importa de
 * verdade é se ESTE objeto de painel continua sendo o registrado sob a própria chave — ele
 * pode ter sido fechado (e a chave reaberta como outro painel) enquanto o `await` estava no ar.
 */
async function garantirCatalogo(painel) {
  if (painel.catalogo) return painel.catalogo;
  // `aba=`, não `sessao=`: desde a D17 a conversa aberta é sempre uma aba do terminal, e
  // pedir por sessão fazia o servidor não achar nada — o catálogo vinha sem os embutidos
  // e o /clear sumia do autocomplete. Quem resolve o cwd é o servidor, por lib/abas.js;
  // caminho nunca sai daqui.
  const { itens } = await api(`api/catalogo?aba=${encodeURIComponent(painel.chave)}`);
  if (paineis.get(painel.chave) !== painel) throw new Error(tr('A conversa mudou durante a consulta.'));
  painel.catalogo = itens || [];
  return painel.catalogo;
}

function fecharPaleta(painel) {
  const paleta = painel.paleta;
  paleta.hidden = true;
  paleta.textContent = '';
  painel.escolhidosPaleta = [];
  painel.indicePaleta = 0;
}

function desenharPaleta(painel) {
  const paleta = painel.paleta;
  paleta.textContent = '';
  paleta.hidden = false;

  if (!painel.escolhidosPaleta.length) {
    const p = document.createElement('div');
    p.className = 'paleta-vazia';
    idiomaUI.bind(p, 'textContent', () => tr('Nada com esse nome.'));
    paleta.append(p);
    return;
  }

  painel.escolhidosPaleta.forEach((item, i) => {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'paleta-item';
    botao.dataset.origem = item.origem;
    botao.setAttribute('role', 'option');
    botao.setAttribute('aria-selected', String(i === painel.indicePaleta));

    const linha = document.createElement('div');
    linha.className = 'paleta-nome';
    const nome = document.createElement('b');
    nome.textContent = item.invocacao || `/${item.nome}`;
    const tag = document.createElement('span');
    tag.className = 'paleta-tag';
    idiomaUI.bind(tag, 'textContent', () => tr(item.origem === 'projeto' ? 'projeto' : item.tipo));
    linha.append(nome, tag);
    botao.append(linha);

    if (item.descricao) {
      const desc = document.createElement('div');
      desc.className = 'paleta-desc';
      desc.textContent = item.descricao;
      botao.append(desc);
    }

    // mousedown, não click: o clique tira o foco do textarea e a paleta fecharia antes.
    botao.onmousedown = (evento) => { evento.preventDefault(); escolher(painel, i); };
    paleta.append(botao);
  });

  paleta.children[painel.indicePaleta]?.scrollIntoView({ block: 'nearest' });
}

function escolher(painel, i) {
  const item = painel.escolhidosPaleta[i];
  if (!item) return;
  escreverNaCaixa(painel, `${item.invocacao || `/${item.nome}`} `);
  fecharPaleta(painel);
  painel.entrada.focus();
}

async function talvezAbrirPaleta(painel) {
  const achado = painel.entrada.value.match(PREFIXO_COMANDO);
  if (!achado) return fecharPaleta(painel);

  let itens;
  try {
    itens = await garantirCatalogo(painel);
  } catch {
    // §3.6 da spec: a guarda é pelo CURSOR, não por `atual` — cobre de uma vez o painel que
    // saiu da tela (nó removido nunca é o `activeElement`) e o cursor que foi para outra
    // caixa enquanto o catálogo vinha pela rede.
    if (painel.entrada !== document.activeElement || !painel.entrada.value.match(PREFIXO_COMANDO)) return;
    fecharPaleta(painel);
    const erro = document.createElement('div');
    erro.className = 'paleta-vazia';
    idiomaUI.bind(erro, 'textContent', () => tr('Não consegui carregar o catálogo. Tente digitar novamente.'));
    painel.paleta.append(erro);
    painel.paleta.hidden = false;
    return;
  }
  if (painel.entrada !== document.activeElement) return;
  // A digitação pode ter mudado enquanto o catálogo vinha pela rede.
  const agora = painel.entrada.value.match(PREFIXO_COMANDO);
  if (!agora) return fecharPaleta(painel);

  // `$` busca só skills — pela invocação explícita, nunca pelo tipo: itens sem `invocacao`
// (o catálogo do Claude, que usa / para ambos os tipos) continuam aparecendo
  // nos dois prefixos, como sempre. `/` continua mostrando tudo — a descoberta de sempre.
  const soSkills = painel.entrada.value.startsWith('$');
  const base = soSkills ? itens.filter((i) => !i.invocacao || i.invocacao.startsWith('$')) : itens;
  const busca = agora[1].toLowerCase();
  painel.escolhidosPaleta = base
    .filter((i) => i.nome.toLowerCase().includes(busca))
    .sort((a, b) => {
      const pa = a.nome.toLowerCase().startsWith(busca) ? 0 : 1;
      const pb = b.nome.toLowerCase().startsWith(busca) ? 0 : 1;
      return pa - pb;
    })
    .slice(0, 60);
  painel.indicePaleta = 0;
  desenharPaleta(painel);
}

function navegarPaleta(painel, passo) {
  if (!painel.escolhidosPaleta.length) return;
  painel.indicePaleta = (painel.indicePaleta + passo + painel.escolhidosPaleta.length) % painel.escolhidosPaleta.length;
  desenharPaleta(painel);
}

// ── Histórico da caixa de texto ─────────────────────────────────────────
// Seta para cima traz o que já foi escrito, como num terminal. O histórico vem do próprio
// servidor: ao abrir a conversa o SSE reentrega tudo que o usuário já digitou ali, então
// funciona mesmo tendo escrito de outro aparelho. Nada guardado no navegador.

// `historicoEntrada`, `posHistorico` e `rascunho` são do PAINEL — R29 da spec: `rascunho` (o
// texto de ANTES de navegar, restaurado pelo Escape) é nome já ocupado por essa navegação, e
// por isso o campo novo do painel para "o que está na caixa agora" chama `textoNaCaixa`, não
// `rascunho`. Ver `escreverNaCaixa`.

/** Guarda o que foi enviado. Repetição seguida não entra, igual ao ignoredups do shell. */
function lembrar(painel, texto) {
  const limpo = String(texto).trim();
  if (!limpo) return;
  if (painel.historicoEntrada[painel.historicoEntrada.length - 1] === limpo) return;
  painel.historicoEntrada.push(limpo);
}

function pousarNoFim(entrada) {
  entrada.style.height = 'auto';
  entrada.style.height = `${Math.min(entrada.scrollHeight, 200)}px`;
  const fim = entrada.value.length;
  entrada.setSelectionRange(fim, fim);
}

/**
 * Anda pelo histórico. `passo` -1 é para trás (seta para cima), +1 para frente.
 * Devolve false quando não havia para onde ir, e aí a tecla segue o caminho normal
 * de mover o cursor — que é o que se espera num campo de várias linhas.
 */
function navegarHistorico(painel, passo, entrada) {
  if (!painel.historicoEntrada.length) return false;

  if (painel.posHistorico === null) {
    if (passo > 0) return false;          // seta para baixo sem estar no passado: nada a fazer
    painel.rascunho = entrada.value;      // guarda o que ele estava escrevendo
    painel.posHistorico = painel.historicoEntrada.length;
  }

  const alvo = painel.posHistorico + passo;
  if (alvo < 0) return true;              // já está no mais antigo: segura ali
  if (alvo >= painel.historicoEntrada.length) {
    painel.posHistorico = null;
    escreverNaCaixa(painel, painel.rascunho, entrada);   // voltou para o presente
    pousarNoFim(entrada);
    return true;
  }
  painel.posHistorico = alvo;
  escreverNaCaixa(painel, painel.historicoEntrada[alvo], entrada);
  pousarNoFim(entrada);
  return true;
}

function sairDoHistorico(painel) {
  painel.posHistorico = null;
  painel.rascunho = '';
}

// ── Notificação ─────────────────────────────────────────────────────────
// O ponto disto é o usuário NÃO estar com a tela aberta: o agente trabalha vinte minutos no
// servidor e chama o celular quando termina ou quando precisa de resposta. Quem recebe com o
// app fechado é o service worker, não este arquivo.
//
// Exige HTTPS (contexto seguro) e um gesto do usuário para pedir permissão — pedir sozinho
// no carregamento faz o navegador negar para sempre, sem nem mostrar o diálogo.

const b64ParaBytes = (texto) => {
  const normal = texto.replace(/-/g, '+').replace(/_/g, '/');
  const cru = atob(normal + '='.repeat((4 - (normal.length % 4)) % 4));
  return Uint8Array.from(cru, (c) => c.charCodeAt(0));
};

// `navigator.serviceWorker.ready` NUNCA rejeita: se o service worker não registrou, ela
// fica pendente para sempre e o clique em "Ativar" morre sem erro, sem diálogo, sem nada.
// Foi exatamente esse silêncio que escondeu a falha da primeira vez.
function comLimite(promessa, ms, recado) {
  return Promise.race([
    promessa,
    new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error(recado)), ms)),
  ]);
}

// Preenchida lá embaixo, no registro do service worker. Engolir esse erro custou uma
// rodada inteira de investigação às cegas.
let erroDoServiceWorker = null;

const podeAvisar = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function estadoDosAvisos() {
  if (!podeAvisar()) return 'indisponivel';
  if (Notification.permission === 'denied') return 'negado';
  const registro = await navigator.serviceWorker.getRegistration();
  const inscricao = await registro?.pushManager.getSubscription();
  if (!inscricao) return 'desligado';
  // Ter assinatura no NAVEGADOR não é estar inscrito no COCKPIT. O fluxo tem quatro passos e
  // o quarto (o POST que registra) pode falhar sozinho — a assinatura fica ÓRFÃ: o navegador
  // tem, o servidor não. Nesse estado o botão se pintava "ligadas" e o clique virava TESTE,
  // que sai para os aparelhos da lista do servidor: o dono via "enviado para 1 aparelho" e a
  // notificação aparecia no computador AO LADO, enquanto este aqui nunca receberia nada — e
  // não havia como se inscrever, porque o botão não oferecia mais esse caminho.
  //
  // A pergunta certa já existia em `/api/push/inscricao/consulta` (server.js:1283), criada
  // para esta distinção exata; quem a usava era só a tela de diagnóstico (`diagnosticoDeAvisos`).
  try {
    const { conhecida } = await api('api/push/inscricao/consulta', {
      method: 'POST', corpo: { endpoint: inscricao.endpoint },
    });
    return conhecida ? 'ligado' : 'desligado';
  } catch {
    // Rede fora do ar não pode DESLIGAR o que está ligado: sem resposta, vale o que o
    // navegador diz, que é exatamente o comportamento de antes desta consulta existir.
    return 'ligado';
  }
}

async function pintarBotaoAvisos() {
  const botao = $('btn-avisos');
  const estado = await estadoDosAvisos();
  botao.hidden = estado === 'indisponivel';
  botao.dataset.estadoAviso = estado;
  idiomaUI.bind($('avisos-rotulo'), 'textContent', () => tr({
    ligado: tr('Notificações ligadas · testar'),
    desligado: tr('Ativar notificações'),
    negado: tr('Notificações bloqueadas no navegador'),
  }[estado] || ''));
  // O valor curto da linha (P9): mesma fonte do estado, texto que casa com o que o botão
  // já diz hoje ("Notificações bloqueadas no navegador") — por isso "bloqueadas", não
  // "negadas".
  idiomaUI.bind($('avisos-valor'), 'textContent', () => tr({
    ligado: 'ligadas',
    desligado: 'desligadas',
    negado: 'bloqueadas',
  }[estado] || ''));
  botao.disabled = estado === 'negado';
}

/**
 * Roda um passo do fluxo de avisos carregando o NOME dele junto do erro.
 *
 * O que sai daqui é um erro com `passo`, `tipo` e `mensagem` separados, para o painel de
 * falha dizer QUAL passo quebrou. Sem isso, "TypeError: Failed to fetch" podia ser
 * qualquer uma das duas chamadas de rede do fluxo — e a tela não ajudava a escolher.
 */
async function passoDeAviso(nome, fn) {
  try {
    return await fn();
  } catch (erro) {
    const marcado = new Error(`${nome}: ${erro.name || tr('Erro')} — ${erro.message}`);
    marcado.passo = nome;
    marcado.tipo = erro.name || tr('Erro');
    marcado.mensagem = erro.message;
    throw marcado;
  }
}

async function ligarAvisos() {
  const botao = $('btn-avisos');
  const estado = await estadoDosAvisos();

  // Já ligado: o clique vira teste. É o jeito de provar o caminho inteiro sem esperar um
  // turno de verdade terminar.
  if (estado === 'ligado') {
    idiomaUI.bind($('avisos-rotulo'), 'textContent', () => tr('mandando...'));
    try {
      const r = await api('api/push/teste', { method: 'POST', corpo: {} });
      idiomaUI.bind($('avisos-rotulo'), 'textContent', () => rotuloDoTeste(r));
    } catch (erro) {
      idiomaUI.bind($('avisos-rotulo'), 'textContent', () => tr`falhou: ${erro.message}`);
    }
    setTimeout(pintarBotaoAvisos, 3000);
    return;
  }

  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    mostrarFalhaDeAviso(new Error(tr`o navegador respondeu "${permissao}" ao pedido de permissão`));
    return pintarBotaoAvisos();
  }

  // Quatro passos NOMEADOS, e não um `try` só em volta de tudo.
  //
  // Motivo: o erro que o usuário vê no celular é "TypeError: Failed to fetch", que é o que o
  // `fetch()` lança — e há DUAS chamadas de rede aqui, a da chave e a da inscrição, com um
  // `subscribe()` no meio. Com um `catch` único a tela não dizia qual das duas falhou, e
  // sem isso o conserto vira chute; já se chutou demais neste recurso. `subscribe()` lança
  // DOMException, não TypeError, então distinguir os passos já separa rede de navegador.
  // Declarado ANTES do `try`: o passo que usa a resposta mora depois dele (ver abaixo).
  let inscrito = null;
  try {
    const chave = await passoDeAviso(tr('pegar a chave VAPID no cockpit'),
      async () => (await api('api/push/chave')).chave);
    const registro = await passoDeAviso(tr('esperar o service worker ficar pronto'),
      () => comLimite(navigator.serviceWorker.ready, 5000, tr('não ficou pronto em 5s')));
    const assinar = () => registro.pushManager.subscribe({
      userVisibleOnly: true,             // obrigatório no Chrome; sem isso ele recusa
      applicationServerKey: b64ParaBytes(chave),
    });
    const inscricao = await passoDeAviso(tr('assinar no PushManager do navegador'), async () => {
      try {
        // Com a MESMA chave, `subscribe()` devolve a assinatura que já existe — é o que faz
        // o aparelho de assinatura órfã se registrar aqui sem pedir permissão de novo.
        return await assinar();
      } catch (erro) {
        // `InvalidStateError` é o navegador dizendo "já tenho uma assinatura, com OUTRA
        // chave VAPID". Acontece em aparelho que assinou antes de um `vapid.json` novo, e
        // sem isto ele fica preso para sempre: a assinatura velha não serve e não sai
        // sozinha. Descartar a velha é a única saída, e é seguro — ela não vale mais.
        if (erro?.name !== 'InvalidStateError') throw erro;
        const velha = await registro.pushManager.getSubscription();
        await velha?.unsubscribe();
        return assinar();
      }
    });
    inscrito = await passoDeAviso(tr('registrar a inscrição no cockpit'),
      () => api('api/push/inscricao', {
        method: 'POST',
        corpo: { ...inscricao.toJSON(), aparelho: nomeSugerido() },
      }));
  } catch (erro) {
    // Mensagem de erro que some em quatro segundos é mensagem perdida — ainda mais no
    // celular, onde não há console para abrir. Aqui ela fica na tela até ser fechada,
    // junto do diagnóstico que diz QUAL das pré-condições falhou.
    mostrarFalhaDeAviso(erro);
    pintarBotaoAvisos();
    return;
  }
  // O `await` NÃO é estilo: `pintarBotaoAvisos` é async, escreve no MESMO `#avisos-rotulo` e
  // só termina quando a rede responde. Sem ele, um `abrirAparelhos` que rejeitasse no
  // primeiro microtask escreveria a mensagem e a pintura a sobrescreveria com "Notificações
  // ligadas · testar" — o dono ficaria sem lista e sem aviso.
  await pintarBotaoAvisos();
  // Pedir o nome DEPOIS do 201, nunca antes: um campo de texto entre o clique e o
  // `requestPermission()` é a forma clássica de perder o gesto do usuário. E FORA do `try`,
  // porque o `catch` dele mostra "inscrição recusada" — um erro do DIÁLOGO apareceria como
  // inscrição falhada, com a inscrição feita e gravada.
  if (inscrito?.id) {
    abrirAparelhos({ editar: inscrito.id }).catch((erro) => {
      console.error('aparelhos:', erro.message);
      // E na TELA, não só no console: num celular `console.error` é informação que não existe.
      idiomaUI.bind($('avisos-rotulo'), 'textContent',
        () => tr('avisos ligados — não consegui abrir a lista de aparelhos'));
    });
  }
}

/**
 * O que precisa estar de pé para o push funcionar, e o que de fato está.
 *
 * As duas últimas linhas são as que separam os casos que "granted + sw ativo" confundia:
 * o aparelho tem inscrição no navegador? e o cockpit conhece ESSA inscrição? Do endpoint
 * sai só o HOST — o resto dele é credencial e não vai para tela nenhuma.
 */
async function diagnosticoDeAvisos() {
  let registro = null;
  try { registro = await navigator.serviceWorker.getRegistration(); } catch { /* nada */ }
  let inscricao = null;
  try { inscricao = (await registro?.pushManager.getSubscription()) || null; } catch { /* nada */ }

  let conhecida = tr('não perguntei: este aparelho não tem inscrição');
  if (inscricao) {
    try {
      const r = await api('api/push/inscricao/consulta', {
        method: 'POST', corpo: { endpoint: inscricao.endpoint },
      });
      conhecida = tr`${r.conhecida ? 'sim' : tr('NÃO')} (${r.inscritos} inscrito(s) no cockpit)`;
    } catch (erro) {
      conhecida = tr`não deu para perguntar — ${erro.name || tr('Erro')}: ${erro.message}`;
    }
  }

  return [
    [tr('endereço seguro (https)'), String(window.isSecureContext)],
    [tr('serviceWorker no navegador'), String('serviceWorker' in navigator)],
    [tr('PushManager no navegador'), String('PushManager' in window)],
    [tr('Notification no navegador'), String('Notification' in window)],
    [tr('permissão'), typeof Notification !== 'undefined' ? Notification.permission : tr('sem Notification')],
    [tr('service worker registrado'), registro ? (registro.active ? 'ativo' : tr('registrado, não ativo')) : tr('não')],
    [tr('erro ao registrar o sw'), erroDoServiceWorker
      ? `${erroDoServiceWorker.name || tr('Erro')}: ${erroDoServiceWorker.message}`
      : 'nenhum'],
    [tr('inscrição neste aparelho'), inscricao
      ? tr`sim, em ${new URL(inscricao.endpoint).host}`
      : 'nenhuma'],
    [tr('o cockpit conhece esta inscrição'), conhecida],
    [tr('rodando como app instalado'), String(matchMedia('(display-mode: standalone)').matches)],
    ['navegador', navigator.userAgent.slice(0, 110)],
  ];
}

async function mostrarFalhaDeAviso(erro) {
  const alvo = $('lista-diagnostico');
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  const motivo = document.createElement('p');
  motivo.className = 'diag-erro';
  // Com passo, a primeira linha do painel já responde "onde": é o que faltava para não ter
  // que adivinhar qual das duas chamadas de rede devolveu "Failed to fetch".
  idiomaUI.bind(motivo, 'textContent', () => tr(erro.passo
    ? tr`Falhou ao ${erro.passo} — ${erro.tipo}: ${erro.mensagem}`
    : `${erro.name || tr('Erro')}: ${erro.message}`));
  alvo.append(motivo);

  const grade = document.createElement('dl');
  grade.className = 'uso-grade';
  for (const [rotulo, valor] of await diagnosticoDeAvisos()) {
    const dt = document.createElement('dt');
    idiomaUI.bind(dt, 'textContent', () => tr(rotulo));
    const dd = document.createElement('dd');
    idiomaUI.bind(dd, 'textContent', () => tr(valor));
    grade.append(dt, dd);
  }
  alvo.append(grade);
  $('dialogo-diagnostico').showModal();
}

// ── Aparelhos que recebem aviso (spec 2026-09-12-nome-do-aparelho-no-push) ──────────────
// O campo `aparelho` era gravado desde sempre e ninguém o lia. Daqui saem as duas coisas que
// o dono vê: a lista com o nome editável, e o rótulo do botão "testar" nomeando quem recebeu.
//
// Tudo por `createElement` + `textContent`, nunca `innerHTML` (proibido no arquivo inteiro):
// o nome vem do dono, passa pelo servidor e volta — `textContent` fecha essa porta por
// construção. E tudo em escopo TOP-LEVEL: é o que faz o `vm` do gate-ui e o `page.evaluate`
// do smoke alcançarem `nomeSugerido` e `rotuloDoTeste`.

/**
 * A sugestão de nome, derivada do user agent: plataforma + navegador.
 *
 * Notebook e desktop dão a MESMA sugestão, e isso não é defeito — é exatamente o fato que
 * originou o card. Ela existe só para o campo não nascer vazio; quem desempata é o dono.
 */
function nomeSugerido() {
  const ua = navigator.userAgent;
  const plataforma = /Android/.test(ua) ? 'Android'
    : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
      : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows'
        : /Linux/.test(ua) ? 'Linux' : 'Aparelho';
  // A ordem importa: `Edg/` e `OPR/` contêm `Chrome/`; `Chrome/` contém `Safari/`.
  const navegador = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  return navegador ? `${plataforma} · ${navegador}` : plataforma;
}

const TETO_NOME = 32;    // nome maior que isso é UA cru, não nome
// 48 é ESTIMATIVA, não medição: ~360px de diálogo em 390, menos ícone e paddings, a 13px. O
// `06-testar-celular-depois.png` existe para conferir esse número com o olho — se a frase
// estourar no print, o número é que está errado. O modo de falha de um teto curto demais é
// SILENCIOSO (cai na contagem e o dono acha que o recurso não funcionou).
const TETO_FRASE = 48;

/**
 * O rótulo do botão depois de um teste — função PRÓPRIA e pura, por dois motivos: o `gate-ui`
 * assere os quatro ramos sem navegador, e o roteiro do smoke a chama por `page.evaluate` para
 * fotografar o texto sem precisar de push de verdade.
 *
 * A régua não é "tem nome?" — é "esse nome serve para DISTINGUIR?". Os 3 aparelhos de
 * produção têm 80 caracteres de user agent idêntico no campo: uma guarda ingênua passaria, e
 * a única superfície que já funcionava nasceria pior do que era.
 */
function rotuloDoTeste(r) {
  if (!r.enviados) return tr('nenhum aparelho inscrito');
  const quem = (r.nomes || []).filter(Boolean);
  const contagem = tr`enviado para ${r.enviados} aparelho(s)`;
  // Nomear só quando os nomes de fato DISTINGUEM os aparelhos. Qualquer "não" cai na contagem:
  if (quem.length !== r.enviados) return contagem;              // algum sem nome
  if (quem.some((n) => n.length > TETO_NOME)) return contagem;  // UA cru, mesmo escondido no "e mais N"
  if (new Set(quem).size !== quem.length) return contagem;      // dois com o mesmo nome
  const [a, b, ...resto] = quem;
  const frase = !b ? tr`enviado para ${a}`
    : !resto.length ? tr`enviado para ${a} e ${b}`
      : tr`enviado para ${a}, ${b} e mais ${resto.length}`;
  // Medido no texto JÁ TRADUZIDO: quem tem de caber no botão é o que o dono vê. "enviado
  // para" tem 12 caracteres e "sent to" tem 7, então a fronteira cai em lugar diferente em
  // cada idioma — de propósito.
  return frase.length > TETO_FRASE ? contagem : frase;
}

// O estado da lista. Nenhum relógio: esta lista NUNCA se redesenha sozinha (ver
// `salvarNomeDeAparelho`), e é por isso que a edição pode ser inline em vez de um 13º diálogo.
const dadosDeAparelho = new Map();      // id → o último dado conhecido daquele aparelho
const linhasDeAparelho = new Map();     // id → o <div> da linha, para redesenhar SÓ ela
const edicaoDeAparelho = new Map();     // id → o objeto da edição ABERTA agora
const aplicadoPorId = new Map();        // id → o número do envio mais novo já aplicado
const enviandoDeAparelho = new Set();   // id com POST em voo: um salvamento por aparelho
let enviosDeAparelho = 0;
let idDesteAparelho = null;

/**
 * Qual das linhas é a DESTE aparelho. É um extra e falha sozinho: o caminho passa por
 * `getSubscription()`, que não existe em todo lugar, e um TypeError dentro de um `onclick`
 * morre calado. Dois `try/catch` separados, um por chamada — quando não responde, a lista
 * abre sem a marca. A marca é conforto; a lista é o recurso.
 */
async function descobrirIdDesteAparelho() {
  let endpoint = null;
  try {
    const registro = await navigator.serviceWorker.getRegistration();
    const inscricao = await registro.pushManager.getSubscription();
    endpoint = inscricao ? inscricao.endpoint : null;
  } catch { return null; }
  if (!endpoint) return null;
  try {
    const r = await api('api/push/inscricao/consulta', { method: 'POST', corpo: { endpoint } });
    return r.id || null;
  } catch { return null; }
}

/** O "Atualizar a lista" fica travado enquanto houver edição aberta — e a legenda diz por quê. */
function atualizarBotaoDaLista() {
  const botao = $('btn-atualizar-aparelhos');
  const editando = edicaoDeAparelho.size > 0;
  if (botao) botao.disabled = editando;
  // "Desabilita quando não pode" é mais honesto que "some quando não pode": sem a trava, um
  // 404 na linha A com rascunho aberto em B daria ao dono um botão que apaga o que ele digita.
  idiomaUI.bind($('nota-aparelhos'), 'textContent',
    () => (editando ? tr('salve o nome que está editando antes de atualizar') : tr('')));
}

/** A linha em modo leitura. `recado` aparece embaixo dela quando o servidor tem o que dizer. */
function pintarLinhaDeAparelho(id, recado) {
  const item = linhasDeAparelho.get(id);
  const ap = dadosDeAparelho.get(id);
  if (!item || !ap) return;
  edicaoDeAparelho.delete(id);
  item.textContent = '';

  const linha = document.createElement('div');
  linha.className = 'aparelho-linha';
  item.append(linha);

  const nome = document.createElement('span');
  nome.className = ap.nome ? 'aparelho-nome' : 'aparelho-nome aparelho-vazio';
  // NENHUM `title` carrega informação aqui: no celular `title` não existe. Quem quer ver o
  // nome inteiro toca no ✎ — o campo mostra o valor completo e é rolável. Uma porta só.
  if (ap.nome) nome.textContent = ap.nome;
  else idiomaUI.bind(nome, 'textContent', () => tr('sem nome'));
  linha.append(nome);

  if (idDesteAparelho && id === idDesteAparelho) {
    const marca = document.createElement('span');
    marca.className = 'aparelho-marca';
    idiomaUI.bind(marca, 'textContent', () => tr('(este aparelho)'));
    linha.append(marca);
  }

  // `criadoEm` ausente NÃO vira data: `new Date(null)` é 01/01/1970, mentira com cara de dado.
  // E a data é formatada no APARELHO, nunca no servidor, que viaja.
  if (ap.criadoEm) {
    const data = document.createElement('span');
    data.className = 'aparelho-data';
    data.textContent = new Date(ap.criadoEm).toLocaleDateString();
    linha.append(data);
  }

  // Os 8 primeiros hex: os MESMOS que o journal imprime (`aparelho 9f8e7d6c`). Não é enfeite —
  // é o que liga a linha da tela à linha do log, e sem eles esse ganho só existe no papel.
  const marcaId = document.createElement('span');
  marcaId.className = 'aparelho-id';
  marcaId.textContent = String(id).slice(0, 8);
  linha.append(marcaId);

  const editar = document.createElement('button');
  editar.className = 'aparelho-editar';
  editar.type = 'button';
  editar.textContent = '✎';
  editar.onclick = () => editarAparelho(id);
  linha.append(editar);

  if (recado) {
    const nota = document.createElement('small');
    nota.className = 'config-nota';
    idiomaUI.bind(nota, 'textContent', recado);
    item.append(nota);
  }
  atualizarBotaoDaLista();
}

/** O ✎: a linha vira campo + Cancelar + Salvar. Objeto NOVO de edição a cada abertura. */
function editarAparelho(id) {
  const item = linhasDeAparelho.get(id);
  const ap = dadosDeAparelho.get(id);
  if (!item || !ap) return;
  const edicao = { id };
  edicaoDeAparelho.set(id, edicao);
  item.textContent = '';

  const linha = document.createElement('div');
  linha.className = 'aparelho-linha aparelho-editando';
  item.append(linha);

  const campo = document.createElement('input');
  campo.className = 'aparelho-campo';
  campo.type = 'text';
  campo.autocomplete = 'off';
  campo.spellcheck = false;
  // SEM `maxlength`: o teto de 80 é do SERVIDOR, e uma terceira cópia da regra aqui se
  // separaria dele calada. O corte aparece quando a linha redesenha com o que ele gravou.
  campo.value = ap.nome || '';
  edicao.campo = campo;
  linha.append(campo);

  const nota = document.createElement('small');
  nota.className = 'config-nota';
  edicao.nota = nota;
  linha.append(nota);

  const acoes = document.createElement('div');
  acoes.className = 'aparelho-acoes';
  const cancelar = document.createElement('button');
  cancelar.className = 'btn';
  cancelar.type = 'button';
  idiomaUI.bind(cancelar, 'textContent', () => tr('Cancelar'));
  cancelar.onclick = () => pintarLinhaDeAparelho(id);
  const salvar = document.createElement('button');
  salvar.className = 'btn btn-principal';
  salvar.type = 'button';
  idiomaUI.bind(salvar, 'textContent', () => tr('Salvar'));
  salvar.onclick = () => salvarNomeDeAparelho(id);
  acoes.append(cancelar, salvar);
  linha.append(acoes);

  atualizarBotaoDaLista();
  // O campo NASCE de `createElement`, então toda chamada além de `.value` vai com guarda: o
  // DOM de mentira do gate não tem `focus` nem `setSelectionRange`, e um TypeError dentro de
  // handler morre calado.
  campo.focus?.();
  campo.setSelectionRange?.(0, campo.value.length);
  // E de volta ao COMEÇO: selecionar tudo rola o campo para o fim do texto, e com 80
  // caracteres de user agent o dono veria "…Gecko) Chrome/14" — que não diz qual aparelho
  // ele está prestes a renomear. Medido no print de 390px; `'backward'` no
  // `setSelectionRange` não resolve no Chromium.
  campo.scrollLeft = 0;
}

/**
 * Manda o nome novo. Três guardas, e nenhuma substitui as outras — ver o corpo.
 *
 * A lista INTEIRA nunca se redesenha aqui, nem no sucesso nem no erro: um `carregarAparelhos()`
 * disparado por uma resposta apagaria, calado, o rascunho de quem estivesse digitando em outra
 * linha. Quem redesenha a lista é abrir o diálogo ou o "Atualizar a lista".
 */
async function salvarNomeDeAparelho(id) {
  const edicao = edicaoDeAparelho.get(id);
  if (!edicao) return;
  // GUARDA 1 — um salvamento por aparelho de cada vez. O contador sozinho NÃO basta: o
  // servidor serializa pela ordem de CHEGADA, então dois pedidos em voo podem persistir
  // trocados e o disco ficar com o nome velho enquanto a tela mostra o novo.
  if (enviandoDeAparelho.has(id)) return;
  enviandoDeAparelho.add(id);
  enviosDeAparelho += 1;
  const envio = enviosDeAparelho;
  const nome = edicao.campo.value;
  idiomaUI.bind(edicao.nota, 'textContent', () => tr(''));
  try {
    const r = await api('api/push/inscricao/nome', { method: 'POST', corpo: { id, nome } });
    // GUARDA 2 — resposta velha nunca vence resposta nova.
    if (envio <= (aplicadoPorId.get(id) || 0)) return;
    aplicadoPorId.set(id, envio);
    dadosDeAparelho.set(id, { ...dadosDeAparelho.get(id), nome: r.nome || null });
    // GUARDA 3 — não pisar em edição aberta. Salvar, cancelar e REABRIR a mesma linha é outra
    // edição com o MESMO id: as guardas 1 e 2 não pegam esse caso, e sem esta a resposta do
    // primeiro salvamento apagaria o rascunho novo.
    if (edicaoDeAparelho.get(id) === edicao) pintarLinhaDeAparelho(id);
  } catch (erro) {
    if (edicaoDeAparelho.get(id) !== edicao) return;
    // O aparelho se descadastrou no meio: a LINHA diz, a lista fica como está.
    if (erro.status === 404) pintarLinhaDeAparelho(id, () => tr('este aparelho não está mais inscrito'));
    // Erro de rede: a mensagem na própria linha e a edição CONTINUA aberta, com o que ele digitou.
    else idiomaUI.bind(edicao.nota, 'textContent', () => tr(erro.message));
  } finally {
    enviandoDeAparelho.delete(id);
  }
}

/** Monta a lista do zero. Só é chamada ao ABRIR o diálogo e no "Atualizar a lista". */
async function carregarAparelhos() {
  const caixa = $('aparelho-lista');
  dadosDeAparelho.clear();
  linhasDeAparelho.clear();
  edicaoDeAparelho.clear();
  caixa.textContent = '';
  atualizarBotaoDaLista();

  let r;
  try {
    r = await api('api/push/inscricoes');
  } catch (erro) {
    const aviso = document.createElement('p');
    aviso.className = 'config-nota';
    idiomaUI.bind(aviso, 'textContent', () => tr(erro.message));
    const denovo = document.createElement('button');
    denovo.className = 'btn';
    denovo.type = 'button';
    idiomaUI.bind(denovo, 'textContent', () => tr('Tentar de novo'));
    denovo.onclick = () => carregarAparelhos();
    caixa.append(aviso, denovo);
    return;
  }

  idDesteAparelho = await descobrirIdDesteAparelho();

  if (!r.aparelhos.length) {
    const vazio = document.createElement('p');
    vazio.className = 'config-nota';
    // A chave que o botão "testar" já usa — uma segunda quase-igual no mesmo catálogo seria
    // a duplicação que as frases inteiras existem para evitar.
    idiomaUI.bind(vazio, 'textContent', () => tr('nenhum aparelho inscrito'));
    caixa.append(vazio);
    return;
  }

  for (const ap of r.aparelhos) {
    dadosDeAparelho.set(ap.id, ap);
    const item = document.createElement('div');
    item.className = 'aparelho-item';
    linhasDeAparelho.set(ap.id, item);
    caixa.append(item);
    pintarLinhaDeAparelho(ap.id);
  }
}

/** Abre o diálogo; com `editar`, já entra na linha daquele id (é o pós-inscrição). */
async function abrirAparelhos({ editar } = {}) {
  $('dialogo-aparelhos').showModal();
  await carregarAparelhos();
  if (editar && dadosDeAparelho.has(editar)) editarAparelho(editar);
}

// ── Anexos ──────────────────────────────────────────────────────────────
// A TUI do terminal não recebe binário por `send-keys`. O que o CLI faz é abrir arquivo com
// o Read, e o Read enxerga imagem. Então o caminho é: sobe o arquivo para o servidor, ele
// grava em ~/.cockpit/anexos/ (diretório NEUTRO — a aba não tem pasta de sessão), e a
// mensagem cita o CAMINHO. Provado em 21/08 que o CLI lê fora do cwd sem pedir permissão.

// `anexos` é do PAINEL — a caixa `#anexos` continua compartilhada (segue o foco), mas o QUE
// está anexado é da conversa em que foi solto (§4.3 da spec).

const TIPOS_ACEITOS = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain',
]);

function desenharAnexos(painel) {
  // A caixa de anexos é do PAINEL agora (D42) — sem guarda de foco nenhuma.
  const caixa = painel.anexosEl;
  caixa.textContent = '';
  caixa.hidden = !painel.anexos.length;

  painel.anexos.forEach((anexo, i) => {
    const item = document.createElement('div');
    item.className = 'anexo';
    item.dataset.estado = anexo.estado;

    if (anexo.url) {
      const mini = document.createElement('img');
      mini.src = anexo.url;
      mini.alt = '';
      item.append(mini);
    }

    const nome = document.createElement('span');
    nome.className = 'anexo-nome';
    nome.textContent = anexo.estado === 'erro' ? `${anexo.nome}: ${anexo.erro}` : anexo.nome;
    item.append(nome);

    const tira = document.createElement('button');
    tira.className = 'anexo-tira';
    tira.type = 'button';
    tira.textContent = '×';
    idiomaUI.attr(tira, 'aria-label', () => tr`Tirar ${anexo.nome}`);
    tira.onclick = () => {
      anexo.soltar?.();   // desistir de esperar: libera um `enviar()` que esteja aguardando esta subida
      painel.tocouDeNovo = false;   // o × é a ação mais nova: um Enviar de antes dele não vale mais
      if (anexo.url) URL.revokeObjectURL(anexo.url);
      painel.anexos.splice(i, 1);
      painel.seloComposicao += 1;
      desenharAnexos(painel);
    };
    item.append(tira);
    caixa.append(item);
  });
}

function limparAnexos(painel) {
  // NÃO revoga `objectURL` aqui (card menu-da-tui-do-codex-na-tela, R11): no caminho de
  // envio, quem chama isto ainda pode precisar mostrar os MESMOS anexos de volta (a caixa
  // recuperando o par recusado) — revogar cedo deixaria a miniatura quebrada. A lista some da
  // tela do mesmo jeito; a revogação passa para depois do POST bem-sucedido, em `enviar()`.
  painel.anexos = [];
  painel.seloComposicao += 1;
  desenharAnexos(painel);
}

async function subirArquivo(painel, arquivo) {
  if (!painel) return;
  if (!TIPOS_ACEITOS.has(arquivo.type)) {
    noPainel(painel, () => bolha('bolha-erro', tr`${arquivo.name || 'arquivo'}: tipo não aceito (${arquivo.type || 'desconhecido'}).`));
    return;
  }
  const anexo = {
    nome: arquivo.name || 'colado',
    caminho: null,
    estado: 'subindo',
    url: arquivo.type.startsWith('image/') ? URL.createObjectURL(arquivo) : null,
  };
  // A promessa da subida (card foto-some-entre-upload-e-envio): é nela que o `enviar()` espera
  // quando o toque chega com o anexo ainda subindo. Resolve em QUALQUER saída — o `finally`
  // abaixo envolve o fetch e o desenho — e nunca rejeita; o `×` também solta (desistência).
  let soltar;
  anexo.subida = new Promise((r) => { soltar = r; });
  anexo.soltar = soltar;
  painel.anexos.push(anexo);
  // O selo sobe ao ADICIONAR também, não só ao remover (card menu-da-tui-do-codex-na-tela,
  // R11): anexar durante um request é mudança da composição, e sem este incremento o
  // invariante do selo ficava com um buraco — a guarda de "composição vazia" salvava o caso,
  // mas por acidente, não por desenho.
  painel.seloComposicao += 1;
  desenharAnexos(painel);

  try {
    const cabecalhos = { 'content-type': arquivo.type };
    if (token) cabecalhos.authorization = `Bearer ${token}`;
    const resposta = await fetch(`api/abas/${painel.chave}/anexos?nome=${encodeURIComponent(anexo.nome)}`, {
      method: 'POST', headers: cabecalhos, body: arquivo,
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(dados.erro || tr`falha ${resposta.status}`);
    anexo.caminho = dados.arquivo;
    anexo.nome = dados.nome;
    anexo.estado = 'pronto';
  } catch (erro) {
    anexo.estado = 'erro';
    anexo.erro = erro.message;
  }
  // O `catch` acima não deixa nada escapar; a única saída por exceção que sobrava era o desenho.
  try {
    desenharAnexos(painel);
  } finally {
    anexo.soltar();
  }
}

// ── Arquivos: mandar e receber pelo Taildrop ────────────────────────
//
// O nono <dialog> (spec 2026-09-03). É a OUTRA porta de arquivo, ao lado do clipe: qualquer
// tipo até o teto que o SERVIDOR manda (2 GB hoje), direto em ~/taildrop-inbox/<pasta>/, mais
// a fila do Taildrop ("Puxar tudo") e mandar um arquivo do servidor para outro aparelho do
// tailnet. Regras do bloco: nada aqui apaga arquivo (§1.4); tudo que vem do servidor ou da
// CLI entra por textContent (R38); os quatro blocos carregam em paralelo e cada um degrada
// sozinho (R6); a tela nunca vê caminho absoluto — só nome relativo à raiz escolhida (S4/#22).
// O upload é por XMLHttpRequest, não fetch: só o XHR expõe `upload.onprogress`, e sem
// progresso um envio de 2 GB parece travado (R3).

let raizEnvio = 'inbox';
let caminhoEnvio = '';
// Vem de GET /api/arquivos/pastas (R15/#40): o rótulo "até X GB" nunca é escrito à mão.
let tetoDoUpload = 0;

/** `1,2 GB` / `412,3 MB` / `18 KB` — vírgula, padrão da tela. */
function formatarBytes(n) {
  const v = Number(n) || 0;
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (v >= GB) return `${(v / GB).toLocaleString(idiomaUI.idioma, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  if (v >= MB) return `${(v / MB).toLocaleString(idiomaUI.idioma, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

/** Uma linha de lista: pasta é um botão que entra nela; arquivo tem nome, tamanho e (se pedido) o Mandar. */
function linhaDeArquivo({ nome, bytes = 0, pasta = false, aoEntrar = null, acao = null }) {
  const linha = document.createElement('div');
  linha.className = pasta ? 'arquivos-item arquivos-pasta' : 'arquivos-item';
  if (pasta) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'nome';
    botao.textContent = nome === '..' ? '..' : `${nome}/`;
    botao.onclick = aoEntrar;
    linha.append(botao);
    return linha;
  }
  const span = document.createElement('span');
  span.className = 'nome';
  span.textContent = nome;
  linha.append(span);
  const tamanho = document.createElement('span');
  tamanho.className = 'tamanho';
  idiomaUI.bind(tamanho, 'textContent', () => tr(formatarBytes(bytes)));
  linha.append(tamanho);
  if (acao) {
    const estado = document.createElement('span');
    estado.className = 'estado';
    linha.append(estado);
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'btn';
    idiomaUI.bind(botao, 'textContent', () => tr('Mandar'));
    botao.onclick = () => acao(estado, botao);
    linha.append(botao);
  }
  return linha;
}

async function carregarPastasInbox() {
  const alvo = $('sel-pasta-inbox');
  const dados = await api('api/arquivos/pastas');
  const pastas = dados.pastas || [];
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  for (const p of pastas) {
    const opcao = document.createElement('option');
    opcao.value = p.nome;
    opcao.textContent = p.nome;
    alvo.append(opcao);
  }
  alvo.value = pastas.some((p) => p.nome === '_triagem') ? '_triagem' : (pastas[0] ? pastas[0].nome : '');
  tetoDoUpload = Number(dados.teto) || 0;
  idiomaUI.bind($('rotulo-arquivo-servidor'), 'textContent', () => tr(tetoDoUpload
    ? tr`Arquivo (qualquer tipo, até ${formatarBytes(tetoDoUpload)})`
    : tr('Arquivo (qualquer tipo)')));
  $('btn-mandar-servidor').disabled = pastas.length === 0;
}

async function carregarFila() {
  const lista = $('lista-taildrop');
  const botao = $('btn-puxar-taildrop');
  const dados = await api('api/taildrop/fila');
  idiomaUI.bind(lista, 'textContent', () => tr(''));
  if (!Array.isArray(dados.fila)) {
    idiomaUI.bind($('resumo-taildrop'), 'textContent', () => tr('Fila indisponível'));
    idiomaUI.bind($('nota-taildrop'), 'textContent', () => tr(dados.erro || tr('não consegui ler a fila do Taildrop')));
    idiomaUI.bind(botao, 'textContent', () => tr('Puxar tudo'));
    botao.disabled = true;
    return;
  }
  if (!dados.fila.length) {
    const vazio = document.createElement('div');
    vazio.className = 'arquivos-vazio';
    idiomaUI.bind(vazio, 'textContent', () => tr('nada chegando'));
    lista.append(vazio);
  }
  for (const item of dados.fila) lista.append(linhaDeArquivo({ nome: item.nome, bytes: item.bytes }));
  const n = dados.fila.length;
  idiomaUI.bind($('resumo-taildrop'), 'textContent', () => tr(n ? `${n} ${n === 1 ? tr('arquivo') : tr('arquivos')}` : tr('Nenhum arquivo')));
  idiomaUI.bind(botao, 'textContent', () => tr(n ? tr`Puxar tudo (${n} ${n === 1 ? tr('arquivo') : tr('arquivos')})` : tr('Puxar tudo')));
  botao.disabled = n === 0;
}

async function carregarDestinos() {
  const alvo = $('sel-destino-taildrop');
  const dados = await api('api/taildrop/destinos');
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  if (!Array.isArray(dados.destinos)) {
    idiomaUI.bind($('nota-envio'), 'textContent', () => tr(dados.erro || tr('não consegui listar os aparelhos')));
    return;
  }
  for (const d of dados.destinos) {
    const opcao = document.createElement('option');
    opcao.value = d.nome;
    opcao.textContent = d.online ? d.nome : `${d.nome} · offline`;
    alvo.append(opcao);
  }
  if (!dados.destinos.length) idiomaUI.bind($('nota-envio'), 'textContent', () => tr('nenhum aparelho no tailnet'));
  else alvo.value = (dados.destinos.find((d) => d.online) || dados.destinos[0]).nome;
}

// Como o caminho é montado (R43): `caminhoEnvio` é relativo, '' na raiz, segmentos por '/'.
// O cliente nunca monta `..` — e mesmo que montasse, é o servidor que decide (realpath, R1).
const caminhoDe = (item) => (caminhoEnvio ? `${caminhoEnvio}/${item.nome}` : item.nome);

async function carregarListaEnvio(raiz, caminho) {
  raizEnvio = raiz;
  caminhoEnvio = caminho;
  $('caminho-envio').textContent = caminho ? `${raiz}/${caminho}` : raiz;
  try {
    const dados = await api(`api/arquivos/lista?${new URLSearchParams({ raiz, caminho })}`);
    desenharListaEnvio(dados.itens || []);
  } catch (erro) {
    idiomaUI.bind($('nota-envio'), 'textContent', () => tr(erro.message));
  }
}

function desenharListaEnvio(itens) {
  const lista = $('lista-envio');
  idiomaUI.bind(lista, 'textContent', () => tr(''));
  if (caminhoEnvio) {
    lista.append(linhaDeArquivo({
      nome: '..', pasta: true,
      aoEntrar: () => carregarListaEnvio(raizEnvio, caminhoEnvio.split('/').slice(0, -1).join('/')),
    }));
  }
  if (!itens.length) {
    const vazio = document.createElement('div');
    vazio.className = 'arquivos-vazio';
    idiomaUI.bind(vazio, 'textContent', () => tr('pasta vazia'));
    lista.append(vazio);
  }
  for (const item of itens) {
    if (item.tipo === 'pasta') {
      lista.append(linhaDeArquivo({ nome: item.nome, pasta: true, aoEntrar: () => carregarListaEnvio(raizEnvio, caminhoDe(item)) }));
    } else {
      lista.append(linhaDeArquivo({ nome: item.nome, bytes: item.bytes, acao: (estado, botao) => enviarParaFora(item, estado, botao) }));
    }
  }
}

/**
 * UM upload: abre o XHR, informa o andamento pelo `aoProgredir` e resolve com o que o
 * servidor devolveu. Não toca na tela — quem decide o que a nota e a barra dizem é o
 * chamador. Fechar o painel durante o envio NÃO cancela (R49): não existe `abort()` aqui.
 */
function subirUmArquivo(arquivo, pasta, aoProgredir) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // A pasta também é codificada: `clientes & vendas` ou um `#` no nome chegariam partidos.
    xhr.open('POST', `api/arquivos?${new URLSearchParams({ pasta, nome: arquivo.name })}`);
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (evento) => {
      if (!evento.lengthComputable) return;
      aoProgredir(evento.loaded, evento.total);
    };
    xhr.onload = () => {
      let resposta = {};
      try { resposta = JSON.parse(xhr.responseText || '{}'); } catch { resposta = {}; }
      if (xhr.status === 401) { pedirToken(); reject(new Error(tr('token ausente ou inválido'))); return; }
      if (xhr.status >= 400) { reject(new Error(resposta.erro || tr`falha ${xhr.status}`)); return; }
      resolve(resposta);
    };
    xhr.onerror = () => reject(new Error(tr('a conexão caiu — tente de novo')));
    xhr.send(arquivo);
  });
}

/**
 * O upload de N arquivos. Recusa local ANTES de abrir o XHR (R36): acima do teto ou vazio
 * nem sai daqui — mas a recusa é POR ARQUIVO, e o ruim do meio não derruba o lote: os bons
 * sobem e o resumo diz quais ficaram de fora e por quê.
 *
 * Um de cada vez, de propósito: o servidor RECUSA o 4º upload simultâneo com 429
 * ("já tem 3 arquivos subindo", `lib/arquivos.js:209`) — ele não enfileira. Medido em
 * 2026-09-18 com quatro POSTs sobrepostos: 3× 201 e 1× 429. Mandar em paralelo perderia
 * arquivo em silêncio a partir do quarto.
 *
 * UMA barra e UMA nota é o que existe na tela (`prog-arquivo-servidor`/`nota-arquivo-servidor`),
 * e no celular não cabe mais: a barra é do LOTE, medida em BYTES, e a nota ganha o prefixo
 * "2 de 5". Em bytes, e não em "arquivo 2 de 5", porque a barra anda sozinha do começo ao fim
 * em vez de voltar a zero a cada arquivo. Com UM arquivo o prefixo some — "1 de 1" é ruído.
 *
 * O botão trava por `data-recarregando` (o mesmo de `criarAba`) e destrava no `finally`, ou
 * seja, só no fim de TODOS. Fechar o painel durante o envio NÃO cancela (R49): não existe
 * `abort()` em lugar nenhum — o <dialog> só some da tela, o DOM persiste, e ao reabrir a
 * barra está onde parou. Cancelar é fechar o app, como no clipe.
 */
async function mandarParaOServidor(botao) {
  if (botao && botao.dataset.recarregando === '1') return;
  const nota = $('nota-arquivo-servidor');
  const barra = $('prog-arquivo-servidor');
  const escolhidos = Array.from($('inp-arquivo-servidor').files || []);
  if (!escolhidos.length) { idiomaUI.bind(nota, 'textContent', () => tr('escolha um arquivo primeiro')); return; }
  const pasta = $('sel-pasta-inbox').value;
  if (!pasta) { idiomaUI.bind(nota, 'textContent', () => tr('escolha uma pasta da lista')); return; }
  // A triagem é síncrona e vem ANTES do primeiro XHR: assim o total do lote já é o número
  // de arquivos que de fato vão subir, e o "2 de 3" não conta quem nunca teve chance.
  const bons = [];
  const falhas = [];
  for (const candidato of escolhidos) {
    if (candidato.size === 0) { falhas.push(`${candidato.name} (${tr('arquivo vazio')})`); continue; }
    if (tetoDoUpload && candidato.size > tetoDoUpload) {
      falhas.push(`${candidato.name} (${tr`passa do teto de ${formatarBytes(tetoDoUpload)}`})`);
      continue;
    }
    bons.push(candidato);
  }
  if (botao) botao.dataset.recarregando = '1';
  barra.hidden = false;
  barra.value = 0;
  const totalDoLote = bons.length;
  const bytesDoLote = bons.reduce((soma, a) => soma + (a.size || 0), 0);
  // O prefixo só existe em lote de verdade; com um arquivo a frase é a mesma de sempre.
  const doLote = (posicao, texto) => (totalDoLote > 1 ? tr`${posicao} de ${totalDoLote} · ${texto}` : texto);
  let bytesJaEnviados = 0;
  let ultimo = null;
  let prontos = 0;
  try {
    for (let i = 0; i < totalDoLote; i += 1) {
      const arquivo = bons[i];
      const posicao = i + 1;
      const enviadosAntes = bytesJaEnviados;
      idiomaUI.bind(nota, 'textContent', () => doLote(posicao, tr`subindo 0 B de ${formatarBytes(arquivo.size)}… pode fechar o painel, o envio continua`));
      try {
        const dados = await subirUmArquivo(arquivo, pasta, (carregado, total) => {
          barra.value = Math.round(((enviadosAntes + carregado) / (bytesDoLote || total)) * 100);
          idiomaUI.bind(nota, 'textContent', () => doLote(posicao, tr`subindo ${formatarBytes(carregado)} de ${formatarBytes(total)}… pode fechar o painel, o envio continua`));
        });
        prontos += 1;
        ultimo = dados;
      } catch (erro) {
        falhas.push(`${arquivo.name} (${erro.message})`);
      }
      bytesJaEnviados += arquivo.size || 0;
      barra.value = bytesDoLote ? Math.round((bytesJaEnviados / bytesDoLote) * 100) : 100;
    }
    if (prontos) barra.value = 100;
    const recusados = falhas.join('; ');
    // Uma nota só, no fim, dizendo o que aconteceu com o lote inteiro.
    if (!falhas.length && prontos === 1 && ultimo) {
      idiomaUI.bind(nota, 'textContent', () => tr`chegou: ${ultimo.nome} em ${ultimo.pasta}`);
    } else if (!falhas.length) {
      idiomaUI.bind(nota, 'textContent', () => tr`chegaram ${prontos} arquivos em ${pasta}`);
    } else if (!prontos) {
      idiomaUI.bind(nota, 'textContent', () => tr`nenhum arquivo subiu — ${recusados}`);
    } else {
      idiomaUI.bind(nota, 'textContent', () => tr`chegaram ${prontos} de ${escolhidos.length} em ${pasta} — falharam: ${recusados}`);
    }
    if (prontos && raizEnvio === 'inbox') carregarListaEnvio(raizEnvio, caminhoEnvio);
  } finally {
    if (botao) botao.dataset.recarregando = '';
  }
}

async function puxarTaildrop(botao) {
  if (botao && botao.dataset.recarregando === '1') return;
  if (botao) botao.dataset.recarregando = '1';
  const nota = $('nota-taildrop');
  idiomaUI.bind(nota, 'textContent', () => tr('puxando…'));
  let texto = '';
  try {
    const dados = await api('api/taildrop/puxar', { method: 'POST', corpo: {} });
    const n = Number(dados.puxados) || 0;
    // "novos na raiz", nunca "puxei N": o número é medido no disco, não devolvido pela CLI (R28).
    texto = tr`${n} ${n === 1 ? tr('arquivo novo') : tr('arquivos novos')} na raiz do inbox${dados.saida ? ` — ${dados.saida}` : ''}`;
  } catch (erro) {
    texto = erro.message;
  } finally {
    if (botao) botao.dataset.recarregando = '';
  }
  await carregarFila().catch(() => {});
  idiomaUI.bind(nota, 'textContent', () => tr(texto));
  if (raizEnvio === 'inbox') carregarListaEnvio(raizEnvio, caminhoEnvio);
}

async function enviarParaFora(item, estado, botao) {
  if (botao.dataset.recarregando === '1') return;
  const destino = $('sel-destino-taildrop').value;
  if (!destino) { idiomaUI.bind($('nota-envio'), 'textContent', () => tr('escolha um aparelho')); return; }
  botao.dataset.recarregando = '1';
  idiomaUI.bind(estado, 'textContent', () => tr('enviando…'));
  try {
    const dados = await api('api/taildrop/enviar', {
      method: 'POST', corpo: { raiz: raizEnvio, caminho: caminhoDe(item), destino },
    });
    idiomaUI.bind(estado, 'textContent', () => tr`enviado para ${dados.destino}`);
  } catch (erro) {
    idiomaUI.bind(estado, 'textContent', () => tr(erro.message));
  } finally {
    botao.dataset.recarregando = '';
  }
}

/** Abre o painel e dispara as QUATRO cargas em paralelo, cada uma com o próprio catch (R6). */
function abrirArquivos() {
  $('dialogo-arquivos').showModal();
  carregarPastasInbox().catch((erro) => { idiomaUI.bind($('nota-arquivo-servidor'), 'textContent', () => tr`não deu para ler as pastas: ${erro.message}`); });
  carregarFila().catch((erro) => { idiomaUI.bind($('nota-taildrop'), 'textContent', () => tr(erro.message)); });
  carregarDestinos().catch((erro) => { idiomaUI.bind($('nota-envio'), 'textContent', () => tr(erro.message)); });
  carregarListaEnvio(raizEnvio, caminhoEnvio);
}

// ── O nível de esforço GLOBAL ───────────────────────────────────────────
//
// Duas fontes de effort convivem nesta tela, e cada controle é alimentado por UMA delas:
//
//   chip `#medidor-effort`  ← o `esforco` do `.jsonl` DESTA conversa  (histórico, por conversa)
//   select `#sel-effort`    ← `GET /api/effort` ← `effortLevel` do CLI (global, de agora)
//
// Trocar de aba muda o chip e NÃO pode mexer no select: o `.jsonl` é por conversa, e uma aba
// nascida com `--effort low` grava `low` nas linhas dela para sempre. Se o select se
// populasse dali, o painel exibiria o histórico daquela conversa como se fosse o padrão
// global — mentira sobre alcance, que é justamente o que este controle existe para evitar.
//
// E a TROCA é o comando `/effort <nível>` mandado para a aba aberta, pelo mesmo caminho de
// qualquer mensagem. O cockpit não escreve na config do CLI: quem escreve é o CLI (D14).

const NIVEIS_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
// O último nível que o SERVIDOR confirmou. Nunca escrito pela escolha do usuário — só por uma
// resposta do `GET /api/effort`. É isto que quer dizer "não há atualização otimista": mandar
// o comando não é o nível ter mudado.
let effortConfirmado = null;
// Geração da reconsulta. São três gatilhos (abrir o painel, o eco na fita, o eco de um
// /effort digitado à mão) e eles se sobrepõem: duas consultas no ar, e a que SAIU primeiro
// pode VOLTAR depois. Sem isto, a resposta velha sobrescreveria a nova e o painel exibiria um
// nível que já não vale. A última PEDIDA ganha, sempre — mesma disciplina do guarda de
// geração do servidor, deste lado.
let geracaoEffort = 0;

/** O recado padrão do painel: o que o cliente sabe agora, sem inventar nada. */
function notaBaseDoEffort() {
  if (!atual) return tr('abra uma conversa — o /effort é enviado para a aba aberta');
  // Nada a dizer quando o select JÁ está mostrando o nível global: repetir o mesmo valor
  // logo abaixo dele é ruído, não informação (25/08). A frase volta sozinha no
  // único caso em que ela informa alguma coisa — o select apontando para um nível que
  // ainda não é o do CLI, que é o intervalo entre escolher e a troca pegar.
  if (effortConfirmado) {
    return $('sel-effort').value === effortConfirmado ? '' : tr`nível global: ${effortConfirmado}`;
  }
  return tr('não deu para ler o nível atual da configuração do CLI — dá para trocar assim mesmo');
}

function escreverNotaDoEffort(mensagem) {
  idiomaUI.bind($('effort-nota'), 'textContent', () => tr(mensagem || notaBaseDoEffort()));
}

/**
 * Pergunta ao servidor qual é o nível GLOBAL agora, e marca o select com ele.
 *
 * É a única coisa que escreve `effortConfirmado`. Nível que o servidor não conhece (ou que
 * não é nenhuma das cinco opções) deixa o select em branco e a nota dizendo que não deu para
 * saber — o controle continua usável, porque não saber o nível de agora não impede trocar.
 */
async function carregarEffort() {
  const minha = geracaoEffort += 1;
  let nivel = null;
  try {
    nivel = (await api(comToken('api/effort'))).nivel;
  } catch { nivel = null; }
  // Resposta atrasada de uma consulta que outra já substituiu: morre aqui, antes de encostar
  // em qualquer estado.
  if (minha !== geracaoEffort) return;
  effortConfirmado = NIVEIS_EFFORT.includes(nivel) ? nivel : null;
  $('sel-effort').value = effortConfirmado || '';
  escreverNotaDoEffort();
  $('effort-valor').textContent = $('sel-effort').value;
}

/**
 * A troca: `/effort <nível>` para a aba aberta, pela rota que qualquer mensagem já usa.
 *
 * O `sel.value` FICA no nível escolhido depois do 202 (tirá-lo dali na hora seria
 * pisca-pisca), mas `effortConfirmado` não muda: a tela diz "enviado", nunca "aplicado".
 * Quem transforma um no outro é a reconsulta, quando o eco do comando voltar do disco.
 */
async function trocarEffort(painel) {
  const sel = $('sel-effort');
  const nivel = sel.value;
  $('effort-valor').textContent = sel.value;
  // Defesa dupla: no navegador o `disabled` já barra. A guarda existe para a regra não
  // depender de um atributo — sem aba não há para onde mandar o comando. `painel` é o
  // FOCADO no instante do clique, capturado antes do `await` (§4.7 da spec).
  if (!painel) {
    sel.value = effortConfirmado || '';
    escreverNotaDoEffort();
    $('effort-valor').textContent = sel.value;
    return;
  }
  sel.disabled = true;
  escreverNotaDoEffort(tr`enviando /effort ${nivel}…`);
  try {
    await api(comToken(`api/abas/${painel.chave}/turnos`), { method: 'POST', corpo: { texto: `/effort ${nivel}` } });
    escreverNotaDoEffort(tr('enviado — aguardando o eco do CLI para conferir'));
  } catch (erro) {
    // O motivo da recusa (409) vem do servidor, que é quem sabe se a aba tem claude vivo ou
    // pergunta aberta na TUI. Ele aparece AQUI e não como bolha na fita: o painel é modal, a
    // fita fica atrás dele, e a bolha nasceria invisível.
    sel.value = effortConfirmado || '';
    escreverNotaDoEffort(erro.message);
    $('effort-valor').textContent = sel.value;
  } finally {
    sel.disabled = !atual;
  }
}

// ── Consumo do plano ────────────────────────────────────────────────────
// As janelas da assinatura valem para TUDO que roda no servidor — cockpit, terminal, jobs do
// capitão. Por isso isto sobreviveu ao corte do painel "esta conversa", que era medido a
// partir dos arquivos de turno do cockpit e deixou de existir junto com eles.

function tempoAte(epoch) {
  if (!epoch) return '';
  const ms = epoch - Date.now();
  if (ms <= 0) return tr('já resetou');
  const minutos = Math.round(ms / 60000);
  if (minutos < 60) return tr`faltam ${minutos}min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  if (horas < 24) return tr`faltam ${horas}h${resto ? ` ${resto}min` : ''}`;
  return tr`faltam ${Math.floor(horas / 24)}d ${horas % 24}h`;
}

// O inverso de `tempoAte`: há quanto tempo algo aconteceu, no MESMO estilo relativo — nunca
// data absoluta (a #35 já ensinou que hora de servidor comparada com hora do aparelho mente).
// Usado só pelas janelas de graça: a hora delas vem do stream, sempre no passado.
// "~há agora" não é português. O `~` só faz sentido quando há uma distância a estimar; em
// cima da hora, "agora" já diz tudo. Uma função para os DOIS lugares que escrevem idade (a
// linha do painel e a nota do diálogo) — senão eles divergem no dia em que um for ajustado.
// Duas formas da MESMA idade, porque os dois lugares têm larguras diferentes — e as duas
// tratam "agora" igual: `~agora` e `~há agora` não são português, e o `~` só faz sentido
// quando há uma distância a estimar.
//   longa  → a nota do diálogo, que tem a linha inteira: "medido ~há 2min, no último job"
//   curta  → a linha do painel em 390px, onde cada caractere come o rótulo: "62% · ~2min"
function idadeLonga(epoch) {
  const t = tempoDesde(epoch);
  return t === 'agora' ? 'agora' : tr`~há ${t}`;
}
function idadeCurta(epoch) {
  const t = tempoDesde(epoch);
  return t === 'agora' ? 'agora' : `~${t}`;
}

function tempoDesde(epoch) {
  if (!epoch) return '';
  const ms = Date.now() - epoch;
  if (ms <= 0) return 'agora';
  const minutos = Math.round(ms / 60000);
  if (minutos < 1) return 'agora';
  if (minutos < 60) return `${minutos}min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  if (horas < 24) return `${horas}h${resto ? ` ${resto}min` : ''}`;
  return `${Math.floor(horas / 24)}d ${horas % 24}h`;
}

/**
 * Um `.plano-item` completo (topo + trilho) — o MESMO desenho para os três blocos do painel
 * (janelas de graça, `/usage` e Codex): a tela não ganha um terceiro jeito de desenhar a
 * mesma barra. As três chamadas passam o mesmo formato de 4 chaves, de propósito.
 */
function nodeJanela(item) {
  const bloco = document.createElement('div');
  bloco.className = 'plano-item';

  const topo = document.createElement('div');
  topo.className = 'plano-topo';
  const nome = document.createElement('span');
  idiomaUI.bind(nome, 'textContent', () => tr(item.rotulo));
  const direita = document.createElement('span');
  const falta = document.createElement('span');
  falta.className = 'plano-falta';
  idiomaUI.bind(falta, 'textContent', () => tr(item.resetaEm ? `${tempoAte(item.resetaEm)} · ` : ''));
  const pct = document.createElement('b');
  idiomaUI.bind(pct, 'textContent', () => tr(`${item.usado}%`));
  direita.append(falta, pct);
  topo.append(nome, direita);

  const trilho = document.createElement('div');
  trilho.className = 'plano-trilho';
  trilho.dataset.nivel = nivelDe(item.usado);
  const cheio = document.createElement('i');
  cheio.style.width = `${Math.max(2, Math.min(100, item.usado))}%`;
  trilho.append(cheio);

  bloco.append(topo, trilho);
  return bloco;
}

/**
 * As janelas do plano DE GRAÇA (rate_limit_event, do último job) — bloco IRMÃO de
 * `#uso-plano-lista`, NUNCA filho: é o que impede a contagem de `.plano-trilho` dentro dela
 * de mudar (R1/#44 — um bloco novo reusando o componente não pode inflar a contagem de um
 * assert que já existia). `janelas` ausente ou sem itens ⇒ o container fica VAZIO — ausência,
 * não `0%` — sem cabeçalho órfão nem nota pendurada.
 */
function desenharJanelas(janelas) {
  const alvo = $('uso-plano-janelas');
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  if (!janelas || !Array.isArray(janelas.itens) || !janelas.itens.length) return;

  const titulo = document.createElement('div');
  titulo.className = 'plano-nota';
  titulo.dataset.consumo = 'claude';
  titulo.textContent = janelas.plano ? `Claude · ${janelas.plano}` : 'Claude';
  alvo.append(titulo);

  for (const item of janelas.itens) alvo.append(nodeJanela(item));

  const nota = document.createElement('div');
  nota.className = 'plano-nota';
  // O `~` é obrigatório (P5): a hora vem da linha do stream POSTERIOR ao evento, então é
  // uma estimativa por construção — nunca "ao vivo".
  idiomaUI.bind(nota, 'textContent', () => tr`medido ${idadeLonga(janelas.medidoEmAprox)}, no último job · não custa turno`);
  alvo.append(nota);
}

/**
 * O aviso de que "atualizar" custa um turno da assinatura — PERMANENTE, sempre o ÚLTIMO
 * filho de `#uso-plano-lista`, em QUALQUER estado (cache vazio, cache quente ou erro). Um
 * aviso que sumisse justo quando o número já está na tela seria o pior momento para sumir.
 * `dataset.consumo = 'custo'` é a âncora estável — o gate encontra por ela, nunca por posição.
 */
function desenharAvisoDeCusto(lista) {
  const nota = document.createElement('div');
  nota.className = 'plano-nota';
  nota.dataset.consumo = 'custo';
  idiomaUI.bind(nota, 'textContent', () => tr('atualizar consulta a Anthropic e custa um turno da assinatura'));
  lista.append(nota);
}

/**
 * Qual número mostra na linha "Consumo do plano" do painel de Configuração (P3/P8). Procura
 * o item `Sessão (5h)` nas DUAS fontes — `janelas` (de graça) e `itens` (`/usage`, pago).
 * Achou nas duas: ganha a mais RECENTE (senão clicar em "atualizar" traria número novo e a
 * linha continuaria mostrando o antigo). Não achou em nenhuma: `null`, e a linha fica vazia —
 * mostrar o semanal numa linha que diz "5h" seria pior que não mostrar nada.
 */
function resumoDoPlano(dados) {
  const doUsage = (dados.itens || []).find((i) => i.rotulo === tr('Sessão (5h)'));
  const daJanela = (dados.janelas?.itens || []).find((i) => i.rotulo === tr('Sessão (5h)'));
  if (daJanela && (!doUsage || (dados.janelas.medidoEmAprox || 0) > (dados.consultadoEm || 0))) {
    return { item: daJanela, medidoEmAprox: dados.janelas.medidoEmAprox };
  }
  if (doUsage) return { item: doUsage, medidoEmAprox: null };
  return null;
}

let seqLimite = 0; // guarda contra resposta fora de ordem (§4.5.3 do plano) — quem manda é a
                    // consulta mais NOVA, não a que responder primeiro.

/**
 * Consumo do plano. As janelas de graça e o Codex são de graça sempre; o `/usage` só roda
 * com `forcar` — é o único que custa um turno de verdade no CLI (o servidor cacheia por 5
 * minutos, e "atualizar" fura o cache).
 */
async function carregarLimite(forcar) {
  const lista = $('uso-plano-lista');
  const janelasAlvo = $('uso-plano-janelas');
  const botao = $('btn-atualiza-limite');
  idiomaUI.bind(lista, 'textContent', () => tr(''));
  idiomaUI.bind(janelasAlvo, 'textContent', () => tr(''));
  const carregando = document.createElement('div');
  carregando.className = 'plano-nota';
  idiomaUI.bind(carregando, 'textContent', () => tr(forcar ? tr('consultando a Anthropic...') : 'carregando...'));
  lista.append(carregando);
  botao.disabled = true;

  const minha = ++seqLimite;
  let dados;
  try {
    dados = await api(`api/limite${forcar ? '?forcar=1' : ''}`);
  } catch (erro) {
    dados = { itens: [], erro: erro.message };
  }
  if (minha !== seqLimite) return; // chegou tarde: quem manda é a consulta mais nova
  botao.disabled = false;
  idiomaUI.bind(lista, 'textContent', () => tr(''));

  desenharJanelas(dados.janelas);

  const resumo = resumoDoPlano(dados);
  // Sem `resetaEm`, SÓ a porcentagem: `tempoAte(null)` devolve string vazia, e concatenar
  // mesmo assim deixaria um "62% · " pendurado, anunciando um dado que não veio.
  //
  // 🔴 DUAS informações disputam uma linha de 390px, e só cabe uma. Pego pelo PNG, não pelo
  // gate (o `gate-ui` roda num DOM sem layout — é a #43 outra vez): com `61% · faltam 1h 1min
  // · ~há 3min`, o `.ajuste-valor` é `flex: none` e o `.ajuste-rotulo` encolheu até o ellipsis
  // comer "Consumo do plano" INTEIRO. Sobrou um ícone e um número sem dono — a #40 na veia.
  //
  // Quem fica depende da FONTE, porque a pergunta muda:
  //   · veio de graça  ⇒ "de quando é este número" (D-g, o card exige) — o reset está no
  //                      diálogo, a um toque;
  //   · veio do /usage ⇒ acabou de ser pago, a idade é zero e não informa nada; aí vale o
  //                      reset, que é o que a linha sempre mostrou.
  idiomaUI.bind($('plano-valor'), 'textContent', () => tr(resumo
    ? `${resumo.item.usado}%` + (resumo.medidoEmAprox
      // Forma CURTA: cada caractere a mais come o rótulo (o `.ajuste-valor` é `flex: none` e
      // quem encolhe é o `.ajuste-rotulo`). E ela trata "agora" — `~agora` sairia na tela toda
      // vez que um job tivesse acabado de rodar, que é o caso comum aqui.
      ? ` · ${idadeCurta(resumo.medidoEmAprox)}`
      : (resumo.item.resetaEm ? ` · ${tempoAte(resumo.item.resetaEm)}` : ''))
    : ''));

  // O `return` daqui era um beco: com a Anthropic falhando (`itens: []`) a função saía ANTES
  // de desenhar qualquer coisa, e o bloco do Codex — que é de graça e não falha — nunca
  // apareceria justamente no cenário em que ele é mais útil. Vira desvio: a nota da Anthropic
  // entra, e o desenho segue para o Codex.
  const semAnthropic = !dados.itens || !dados.itens.length;
  if (semAnthropic) {
    const nota = document.createElement('div');
    nota.className = 'plano-nota';
    // Sem erro, ninguém consultou (D-a: abrir o painel não gasta mais turno sozinho) — dizer
    // "o CLI não devolveu desta vez" aqui seria mentir, já que o CLI nem foi chamado.
    idiomaUI.bind(nota, 'textContent', () => tr(dados.erro
      ? tr`não deu para consultar: ${dados.erro}`
      : tr('Semana (Fable) só vem do /usage, que custa um turno — toque em atualizar')));
    lista.append(nota);
  }

  for (const item of (semAnthropic ? [] : dados.itens)) {
    lista.append(nodeJanela(item));
  }

  if (!semAnthropic) {
    const nota = document.createElement('div');
    nota.className = 'plano-nota';
    const quando = new Date(dados.consultadoEm).toLocaleTimeString(idiomaUI.idioma, { hour: '2-digit', minute: '2-digit' });
    idiomaUI.bind(nota, 'textContent', () => tr`consultado às ${quando} · conta só as sessões desta máquina`);
    lista.append(nota);
  }

  desenharConsumoDoCodex(lista, dados.codex);
  desenharAvisoDeCusto(lista);
}

/**
 * O consumo da assinatura OPENAI, num bloco próprio ABAIXO do da Anthropic.
 *
 * Os dois NUNCA viram uma lista só. São assinaturas diferentes, e intercalar porcentagens de
 * planos distintos é exatamente o tipo de número com cara de certo que a #10 proíbe — quem
 * olhasse a tela leria "82%" sem saber de qual plano.
 *
 * `codex: null` ⇒ o bloco inteiro não é desenhado — é AUSÊNCIA, nunca `0%`. Desde o card
 * `codex-no-relatorio-de-tokens` isso já não significa "sem aba de Codex viva": o servidor
 * também tenta o disco (D6), e só devolve `null` quando NEM aba, NEM rollout algum respondem.
 *
 * `fonte` diz de onde veio o número: `'aba'` desenha como sempre (com `titulo`, se houver mais
 * de uma aba viva); `'disco'` não tem `.aba` — o rótulo vira "do último uso" e a IDADE
 * (`medidoEm`) entra, pelo mesmo motivo que o medidor de graça do Claude já mostra a idade do
 * número (`DECISOES.md`).
 *
 * As barras são as MESMAS do bloco de cima, e é por isso que o servidor devolve o formato de
 * `lib/limite.js` — a tela não ganha um segundo jeito de desenhar a mesma coisa.
 */
function desenharConsumoDoCodex(lista, codex) {
  if (!codex || !Array.isArray(codex.limites) || !codex.limites.length) return;

  const titulo = document.createElement('div');
  titulo.className = 'plano-nota';
  titulo.dataset.consumo = 'codex';
  if (codex.fonte === 'disco') {
    // Sem aba viva, o número vem do disco — a idade dele é o que falta dizer (#10).
    const idade = codex.medidoEm ? ` · ${idadeCurta(codex.medidoEm)}` : '';
    idiomaUI.bind(titulo, 'textContent', () => `${tr('Codex (OpenAI)')} · ${tr('do último uso')}${idade}`);
  } else if (codex.varias && codex.titulo) {
    // Com mais de uma aba de Codex viva, o cabeçalho diz de QUAL delas o número saiu.
    idiomaUI.bind(titulo, 'textContent', () => tr`Codex (OpenAI) · ${codex.titulo}`);
  } else {
    idiomaUI.bind(titulo, 'textContent', () => tr('Codex (OpenAI)'));
  }
  lista.append(titulo);

  for (const item of codex.limites) lista.append(nodeJanela(item));
}

function linhaUso(grade, rotulo, valor, mono) {
  const dt = document.createElement('dt');
  idiomaUI.bind(dt, 'textContent', () => tr(rotulo));
  const dd = document.createElement('dd');
  if (mono) dd.className = 'mono';
  idiomaUI.bind(dd, 'textContent', () => tr(valor));
  grade.append(dt, dd);
}

// ── Lateral recolhível ──────────────────────────────────────────────────
// Só governa o desktop. No celular a lista é uma tela inteira e quem manda é `data-vista`.

const CHAVE_LATERAL = 'cockpit-lateral-fechada';

function aplicarLateral(fechada) {
  app.dataset.lateral = fechada ? 'fechada' : 'aberta';
  try { localStorage.setItem(CHAVE_LATERAL, fechada ? '1' : '0'); } catch { /* modo privado */ }
}

try {
  aplicarLateral(localStorage.getItem(CHAVE_LATERAL) === '1');
} catch {
  aplicarLateral(false);
}

// ── Tema ────────────────────────────────────────────────────────────────
// A escolha é por aparelho (localStorage) e quem a aplica é o script inline do
// index.html, antes da primeira pintura. Daqui saem só o seletor e a troca.

const CHAVE_TEMA = 'cockpit-tema';

// `barra` é o que vai no <meta theme-color>, que pinta a barra do navegador no Android.
// Ele só aceita cor literal, não `var(--fundo)` — por isso o hex aparece aqui de novo,
// e é sempre o mesmo --fundo que o tema declara no estilo.css.
const TEMAS = [
  { slug: '', nome: 'Padrão (do sistema)', barra: '#0f1115' },
  { slug: 'catppuccin-mocha', nome: 'Catppuccin Mocha', barra: '#181825' },
  { slug: 'catppuccin-latte', nome: 'Catppuccin Latte', barra: '#eff1f5' },
  { slug: 'tokyo-night', nome: 'Tokyo Night', barra: '#16161e' },
  { slug: 'nord', nome: 'Nord', barra: '#2e3440' },
  { slug: 'gruvbox-dark', nome: 'Gruvbox Dark', barra: '#1d2021' },
  { slug: 'everforest-dark', nome: 'Everforest Dark', barra: '#232a2e' },
  { slug: 'rose-pine', nome: 'Rosé Pine', barra: '#191724' },
  { slug: 'rose-pine-dawn', nome: 'Rosé Pine Dawn', barra: '#faf4ed' },
  // `--fundo` do Ryu, como nos outros — e não o `#050505` da lateral. A barra do Android
  // encosta no topo da CONVERSA quando há conversa aberta, que é onde o app passa o tempo.
  { slug: 'ryu', nome: 'Ryu', barra: '#0d0d0d' },
  // `--fundo` do Abyss é a CONVERSA, a mais escura do tema — a escala aqui é normal,
  // ao contrário do Ryu logo acima. Mesma regra de sempre: a barra segue o `--fundo`.
  { slug: 'abyss', nome: 'Abyss', barra: '#06090b' },
];

function temaGuardado() {
  try { return localStorage.getItem(CHAVE_TEMA) || ''; } catch { return ''; }
}

function pintarBarraDoSistema(slug) {
  const tema = TEMAS.find((t) => t.slug === slug) || TEMAS[0];
  $('meta-tema').setAttribute('content', tema.barra);
}

/** O nome por extenso do tema, para a linha de ajuste (`#tema-valor`) — mesma fonte da barra. */
function pintarValorDoTema(slug) {
  idiomaUI.bind($('tema-valor'), 'textContent', () => tr((TEMAS.find((t) => t.slug === slug) || TEMAS[0]).nome));
}

function aplicarTema(slug) {
  // Sem slug o atributo SAI: é o que devolve a conversa ao prefers-color-scheme.
  if (slug) document.documentElement.setAttribute('data-tema', slug);
  else document.documentElement.removeAttribute('data-tema');
  try { localStorage.setItem(CHAVE_TEMA, slug); } catch { /* modo privado */ }
  pintarBarraDoSistema(slug);
  pintarValorDoTema(slug);
}

function montarTemas() {
  const seletor = $('sel-tema');
  for (const tema of TEMAS) {
    const opcao = document.createElement('option');
    opcao.value = tema.slug;
    idiomaUI.bind(opcao, 'textContent', () => tr(tema.nome));
    seletor.append(opcao);
  }
  // Tema desconhecido no localStorage cai sozinho no primeiro item, que é o padrão.
  seletor.value = temaGuardado();
  seletor.onchange = () => aplicarTema(seletor.value);
  pintarBarraDoSistema(temaGuardado());
  pintarValorDoTema(temaGuardado());
}

// ── A dica embaixo da caixa ─────────────────────────────────────────────
//
// Ela é o único texto da tela que ensina teclado — e desde a D30 mentia no aparelho de dedo:
// lá Enter QUEBRA LINHA e quem manda a mensagem é o botão Enviar. Quem escolhe a frase é o
// MESMO `matchMedia` do keydown, perguntado na hora e não no carregamento, pelo mesmo motivo
// da D30: um tablet que ganha teclado no meio da sessão se corrige sozinho.
//
// Com o dedo sai o Ctrl+V do print: no celular não existe Ctrl, e colar é o gesto de segurar
// e escolher "Colar". A seta ↑ FICA — teclado de celular pode ter setas (é opção de quem o
// configura), então cortá-la esconderia um atalho que funciona. O `/` também fica: digita-se
// com o dedo, e o item da paleta se escolhe tocando.

const DICA_TECLADO = ['Enter envia. Shift + Enter quebra linha. ', { tecla: '/' },
  ' lista comandos e skills. ', { tecla: '↑' }, ' repete o que você escreveu. Ctrl+V cola imagem.'];
const DICA_DEDO = ['Enter quebra linha. O botão Enviar manda. ', { tecla: '/' },
  ' lista comandos e skills. ', { tecla: '↑' }, ' repete o que você escreveu.'];

// Qual das duas está escrita agora. Existe para não reescrever o nó a cada tecla: só o
// aparelho TROCANDO de ponteiro repinta.
let dicaComDedo = null;

/** Pinta a dica de UM painel, sem consultar o memo — quem chama decide o aparelho. */
function pintarDicaNo(painel, comDedo = matchMedia('(pointer: coarse)').matches) {
  const alvo = painel.dica;
  alvo.textContent = '';
  for (const parte of comDedo ? DICA_DEDO : DICA_TECLADO) {
    if (typeof parte === 'string') {
      const texto = document.createTextNode('');
      idiomaUI.texto(texto, parte);
      alvo.append(texto);
      continue;
    }
    const tecla = document.createElement('kbd');
    tecla.textContent = parte.tecla;
    alvo.append(tecla);
  }
}

/**
 * O memo + todos os painéis (§3.8 da spec). A pergunta é do APARELHO
 * (`pointer: coarse`), não do painel — por isso continua de módulo. O memo existe para não
 * reescrever cada nó a cada tecla: só o aparelho TROCANDO de ponteiro repinta. Um painel
 * criado DEPOIS do memo já fixado nasceria sem dica nenhuma se dependesse só disto — por
 * isso `criarPainel` chama `pintarDicaNo` direto, sem passar por aqui (#40).
 */
function pintarDica(comDedo = matchMedia('(pointer: coarse)').matches) {
  if (comDedo === dicaComDedo) return;
  dicaComDedo = comDedo;
  for (const painel of paineis.values()) pintarDicaNo(painel, comDedo);
}

// ── O placeholder da caixa (M1) ──────────────────────────────────────────
//
// Por LARGURA (`max-width: 760px`, P5), não por ponteiro (D33 é sobre teclado — pergunta
// diferente). Mesmo breakpoint que o CSS já usa para virar tela de celular (estilo.css). Um
// dono só: o atributo `placeholder` saiu do index.html (R5/#40) para não haver dois textos a
// manter — a próxima mudança só precisa acertar aqui.
// Os dois limiares, e a régua é a largura do TEXTAREA — não a do painel, não a da janela.
//
// Foram três réguas até chegar nesta, e cada troca teve um print por trás:
//   1. a JANELA (`matchMedia`, o de sempre): numa tela de 1600px responde "largo" para um
//      painel de 320px, e o texto saía cortado ao meio no split de 6.
//   2. o PAINEL (`raiz.clientWidth`): melhor, mas empata dois casos que não são iguais — um
//      painel de 360px no DESKTOP tem 24px de padding de cada lado, e um celular de 360px tem
//      14px (bloco de 760px do estilo.css). Mesma largura de painel, larguras de caixa
//      diferentes. Um celular pequeno cairia no texto que só o split de 6 precisa.
//   3. o TEXTAREA (`entrada.clientWidth`): é o elemento que precisa CABER o texto, e ele já
//      chega com o padding, o 📎, o Enviar e os gaps descontados. A pergunta certa não era
//      "que tela é esta?" nem "que painel é este?", era "quanto espaço tem a caixa?".
//
// Os números saíram de medições, não de palpite (os `medidas-*.json` do smoke da caixa,
// gravados fora do repositório): celular de 390px → textarea de 232px, e o texto
// curto cabe; desktop com um painel → 870px, e o longo cabe; split de 6 (painel de 320px) →
// ~165px, onde nem o curto cabe e ele quebrava em duas linhas dentro de um textarea de
// `min-height: 44px`, com a segunda CORTADA AO MEIO.
const CAIXA_LARGA = 460;   // acima daqui o texto longo cabe
// 180, e não 200: com 200 a folga para o celular PEQUENO era de DOIS pixels. Medido em 09/09,
// depois de o painel de execução pedir o viewport de 360px — um Galaxy S8 dá `entradaLargura`
// de 202px, e o limiar de 200 o deixava a um pixel de meia fonte de cair no texto do split de
// 6. Limiar não é "onde o texto para de caber", é "onde eu troco de texto", e ele precisa de
// folga para os dois lados: 180 deixa 22px de margem para o celular e 15px para o split de 6
// (~165px). Os dois números são medidos (`medidas-360.json` e o PNG de 6 painéis).
const CAIXA_MINIMA = 180;  // abaixo daqui nem o curto cabe

/**
 * O placeholder de UM painel, pela largura da própria caixa.
 *
 * **Sem largura medida, a resposta é o texto CURTO, e isso é decisão.** `clientWidth` é `0`
 * enquanto o textarea não está layoutado (é o instante do `criarPainel`) e `undefined` no DOM
 * de mentira do gate. Nos dois casos não se sabe a largura — e o único texto que cabe em
 * QUALQUER largura é o curto. Escolher o longo "porque provavelmente é desktop" foi o que
 * produziu a regressão de 09/09: o celular nasceu com o texto longo cortado ao meio, e as 35
 * medidas do smoke passaram verdes porque o placeholder não era uma delas (agora é).
 */
function pintarPlaceholderNo(painel, largura = painel.entrada.clientWidth || 0) {
  if (largura && largura < CAIXA_MINIMA) idiomaUI.bind(painel.entrada, 'placeholder', () => tr('Mensagem'));
  else if (!largura || largura < CAIXA_LARGA) idiomaUI.bind(painel.entrada, 'placeholder', () => tr('Escreva para o agente'));
  else idiomaUI.bind(painel.entrada, 'placeholder', () => tr('Escreva para o agente, ou / para comandos e skills'));
}

// UM dono para "a largura desta caixa mudou", e é o `ResizeObserver`. Três coisas mudam essa
// largura — a caixa nascer e ser layoutada, a janela redimensionar, e outro painel entrar ou
// sair —, e a primeira versão disto tratava as três em três lugares diferentes. Duas
// funcionaram e a do NASCIMENTO não: no `criarPainel` o painel ainda não está na tela,
// `clientWidth` é 0, e no celular o placeholder ficava com o texto de desktop, cortado. É a
// #51 outra vez, num lugar novo: N chamadas espalhadas para uma pergunta só, e a que falta é
// sempre a que ninguém testou. O observador cobre as três de uma vez, porque a pergunta que
// ele responde é exatamente a que importa — não "o que mudou?", mas "quanto ela mede AGORA?".
const observadorDeLargura = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entradas) => {
    for (const entrada of entradas) {
      const painel = painelDoAlvo(entrada.target);
      if (painel) pintarPlaceholderNo(painel);
    }
  })
  : null;

// ── O colapso do split ao estreitar a janela (R18/R41 da spec) ───────────
//
// O CSS do celular esconde `⊟`/`⧉` e trava `.painel` na largura da tela, mas isso sozinho
// não tira painel nenhum do `Map` nem do cano: sem este ouvinte, encolher a janela deixaria
// N painéis VIVOS com os controles escondidos pelo CSS — tela quebrada, e o gesto de recarga
// do celular (o botão sumiu; ali é o toque na fita) mirando num painel que talvez nem seja o
// focado. A ida é ATIVA: voltar a ficar largo NÃO reabre nada sozinho — o usuário reabre o que
// quiser (D30/D33: a pergunta é feita na hora, nunca no boot).
//
// NÃO passa por `fecharPainel`: o foco já está decidido (é quem sobra) e não existe "sobrou
// nenhum" aqui — o próprio painel focado continua na tela.
function colapsarParaFocoNoEstreito() {
  const chaves = [...paineis.keys()];
  if (chaves.length <= 1) return;   // já colapsado (ou nunca chegou a abrir mais de um)
  for (const chave of chaves) {
    if (chave !== atual) tirarPainel(chave);
  }
  religarFluxo();
}
matchMedia('(max-width: 760px)').addEventListener('change', () => colapsarParaFocoNoEstreito());

// ── O voltar do aparelho ────────────────────────────────────────────────
//
// No celular a conversa é uma TELA inteira, não uma coluna ao lado da lista. O botão de
// voltar do Android fechava o cockpit de dentro da conversa; o esperado é o primeiro toque
// devolver a LISTA e só o segundo, já na lista, sair do app.
//
// O jeito de conseguir isso é dar ao Android o que ele sabe desfazer: uma entrada no
// histórico. Abrir conversa empilha uma, e `popstate` — o evento que o aparelho dispara ao
// voltar — é o ÚNICO lugar do arquivo que devolve a vista para 'lista'. O botão da tela
// pede `history.back()` em vez de trocar a vista na mão de propósito: com dois caminhos
// mexendo na vista, o do botão deixaria a entrada empilhada para trás e o voltar do
// aparelho passaria a exigir um toque a mais para cada volta pelo botão.
//
// Quem entra pela notificação (`#c=<chave>`) também fica servido: a página nasce na lista,
// então a entrada de partida JÁ é a lista, e o push da conversa cai em cima dela.

// Sobe para `true` quando alguém JÁ pôs na pilha a entrada que serve de conversa — hoje só
// o deep link com o app aberto (ver `abrirPeloEndereco`). Vale para uma abertura só.
let pulaProximoEmpilhar = false;

/** Empilha a entrada da conversa. Trocar de aba não empilha de novo — já se está no chat. */
function empilharConversa() {
  if (pulaProximoEmpilhar) { pulaProximoEmpilhar = false; return; }
  if (app.dataset.vista === 'chat') return;
  history.pushState({ vista: 'chat' }, '');
}

/** Pede a lista pelo caminho do aparelho: desempilha e deixa o `popstate` trocar a vista. */
function pedirLista() {
  if (app.dataset.vista === 'chat') history.back();
}

window.addEventListener('popstate', () => {
  // Voltar de dentro da conversa cai na lista. Voltar já estando na lista não é nosso: é o
  // aparelho saindo do app, e é isso mesmo que se quer no segundo toque.
  if (app.dataset.vista !== 'chat') return;
  app.dataset.vista = 'lista';
  // Chegar na lista e olhar um estado de até 5s atrás era o buraco: quem volta olha logo
  // quem está trabalhando e quem está parado. Mesma dupla do `visibilitychange` — o relógio
  // reinicia ANTES para o tique seguinte contar a partir desta leitura, e não cair em cima
  // dela. Sem relógio novo e sem rota nova: é o `carregarAbas` de sempre, adiantado.
  ligarRelogioDaLista();
  carregarAbas();
});

// ── Ligações ────────────────────────────────────────────────────────────

montarTemas();
pintarDica();
// Sem `pintarPlaceholder()` aqui: no boot o `Map` de painéis está vazio, e quem pinta cada
// caixa é o `ResizeObserver` na primeira medição dela. Uma função que só o teste chamava era
// abstração de uso único — apontado pelo painel de execução.

// O `←`, o ↻, o ✕ e o Enviar de CADA conversa moram no closure de `criarPainel` (a "regra
// do dono", D42): não há mais `#btn-voltar`/`#btn-recarregar-conversa`/`#btn-matar-aba`/
// `#btn-enviar` únicos.
/** O que o ↻ e o puxar recarregam: a lista que está À VISTA. Uma função, senão os dois
 *  caminhos divergem no dia em que alguém mexer só num deles (achado da /audita). */
function recarregarAVista() {
  if (vistaDaLateral === 'leituras') return carregarLeituras();
  return vistaDaLateral === 'agentes' ? atualizarFaixaJobs() : carregarAbas();
}

// O recarregar da LISTA continua aqui — o da conversa está em `criarPainel`.
$('btn-recarregar').onclick = (evento) => recarregar(evento.currentTarget, recarregarAVista);

// A barra dos agentes vive DENTRO da lateral, então só é clicável com ela já aberta — no
// desktop e no celular. Sem `aplicarLateral(false)`/`pedirLista()` (o que o antigo
// `verOsJobsNaLista` fazia): guarda para estado inalcançável é a armadilha #30.
$('barra-agentes').onclick = () =>
  trocarVistaDaLateral(vistaDaLateral === 'agentes' ? 'conversas' : 'agentes');

// A 3ª vista (D59). Mesmo desenho do alternador acima: o rótulo diz o destino.
$('barra-leituras').onclick = () =>
  trocarVistaDaLateral(vistaDaLateral === 'leituras' ? 'conversas' : 'leituras');

// Tocar em QUALQUER lugar de um painel o foca — é assim que o usuário troca de agente com N
// painéis lado a lado sem precisar mirar num botão específico. UM ouvinte delegado na
// `.paineis` (não N, um por painel): painéis nascem e morrem em tempo de execução, e um
// ouvinte por painel teria que ser religado a cada `criarPainel`/`tirarPainel`.
//
// Sem `.focus()` nenhum, de propósito (§3.9 da spec, consequência 3): clicar na fita de B
// para LER não é o mesmo gesto que clicar na caixa de B para ESCREVER — focar ali mataria a
// seleção de texto na fita (arrastar para selecionar também começa com um `pointerdown`).
$('paineis').addEventListener('pointerdown', (evento) => {
  const painel = painelDoAlvo(evento.target);
  if (painel && painel.chave !== atual) focar(painel);
});

// ── Puxar para atualizar (a LISTA, e desde 02/09 a CONVERSA também) ─────────
//
// A alternativa de dedo ao ↻. Até 02/09 era SÓ na lista, por decisão de 24/08: a
// fita da conversa abre grudada no fim (`rolarFim`), então lá o gesto quase nunca estaria
// armado e pareceria quebrado. O card da primeira leva do design pediu o contrário, porque
// no celular o ↻ saiu do topo da conversa (bloco de 760px do CSS) e o gesto é o caminho de
// recarga que sobra ali. O que NÃO mudou: o gesto continua raramente armado na conversa —
// quando arma, funciona; quando não arma, a conversa já abriu atualizada. E o repique não
// veio junto (ver o bloco da fita, mais abaixo).
//
// Não se pergunta `matchMedia('(pointer: coarse)')` aqui, de propósito. `touchstart` só
// existe onde há toque; trackpad e mouse não emitem evento de toque. Perguntar o ponteiro
// seria redundante e ainda compraria a dívida da armadilha #40 — mais um comportamento
// derivado do aparelho para alguma legenda escrita à mão passar a mentir.
//
// O selo do gesto vale AQUI TAMBÉM desde 04/09 — o selo nasceu na conversa e foi
// levado ao menu. Até 03/09 a lista não tinha selo (tirado depois do primeiro
// smoke) e quem mostrava o gesto era só A PRÓPRIA LISTA descendo: ela desce colada no dedo e,
// ao soltar, volta passando um pouco ACIMA do lugar e assentando — o retorno pedido no
// segundo smoke. Isso NÃO mudou; o selo se soma a ele. É `transform`, não altura: não custa
// reflow nenhum, e `.lateral` tem `overflow: hidden`, então a lista descida nunca pinta por
// cima do topo.
//
// O selo é irmão da `.conversas`, dentro da `.lista-area`, e não filho dela: a `.conversas` é
// quem desce, e um selo dentro dela desceria junto — na conversa quem desce é a `#fita` e o
// selo fica no rolador, parado. Ela também é reescrita inteira pelo `desenharLista`.
//
// Quem executa é o MESMO `recarregar` do botão, com o próprio ↻ como alvo: ele gira junto e
// a trava contra dedo duplo passa a valer para os dois caminhos de uma vez, sem estado novo.

// Folga antes de assumir o gesto: dedo parado treme, e roubar a rolagem por 2px de tremor
// deixaria a lista impossível de rolar.
const PUXAR_FOLGA = 8;
// Quanto o dedo anda, em px, para soltar valer uma atualização.
const PUXAR_LIMIAR = 96;
// O quanto a LISTA desce, no máximo. O dedo anda o dobro: a resistência de 0.5 é o que dá a
// sensação de elástico e evita que um puxão jogue a lista para fora da tela.
const PUXAR_TETO = 72;
// Quanto dura a volta com o repique. Tem que casar com a `transition` do `[data-voltando]`
// no CSS — é ela quem desenha; este número só diz quando limpar o atributo.
const PUXAR_VOLTA = 320;
// Carência do toque depois do gesto. O `preventDefault` do arrasto já mata o clique
// fantasma no Chrome; isto é a rede para quando não matar. 600ms engole o fantasma (que
// chega em ~300ms) sem atrapalhar o toque DELIBERADO logo depois de a lista se refazer —
// que é o que 2s bloquearia.
const PUXAR_CARENCIA = 600;

// Enquanto `Date.now()` for menor que isto, cartão de conversa não abre. Lido no `onclick`
// de cada cartão, escrito só aqui.
let toqueBloqueadoAte = 0;

let puxadaDe = null;      // clientY onde o dedo encostou, ou null se este toque não serve
let puxadaViva = false;   // o gesto já passou da folga e é NOSSO (a rolagem já foi barrada)
let puxadaAndou = 0;      // o quanto o dedo desceu desde que encostou, em px

const listaRolavel = $('abas');

// `passive: true` aqui: este ouvinte não barra nada, só decide se o toque INTERESSA. Barrar
// é trabalho do `touchmove`, e só depois da folga.
/** A lista desce `px` colada no dedo. Sem transição: transição aqui atrasaria o dedo. */
function desenharPuxada(px) {
  listaRolavel.dataset.voltando = '';
  listaRolavel.style.transform = px ? `translateY(${px}px)` : '';
}

/** Soltou: a lista volta com repique — passa um pouco acima do lugar e assenta. */
function voltarPuxada() {
  listaRolavel.dataset.voltando = '1';
  listaRolavel.style.transform = '';
  setTimeout(() => { listaRolavel.dataset.voltando = ''; }, PUXAR_VOLTA);
}

listaRolavel.addEventListener('touchstart', (evento) => {
  puxadaViva = false;
  puxadaAndou = 0;
  // Dois dedos é pinça, não puxada. E fora do topo da lista o gesto é rolagem normal —
  // a régua é o `scrollTop`, não a posição do dedo na tela.
  puxadaDe = evento.touches.length === 1 && listaRolavel.scrollTop <= 0
    ? evento.touches[0].clientY
    : null;
}, { passive: true });

// `passive: false` é obrigatório: sem isso o `preventDefault` abaixo é ignorado (com aviso
// mudo no console), a lista rola junto e o clique fantasma volta a passar.
listaRolavel.addEventListener('touchmove', (evento) => {
  if (puxadaDe === null || evento.touches.length !== 1) return;
  const andou = evento.touches[0].clientY - puxadaDe;
  // Dedo subindo é rolagem de verdade. Enquanto o gesto não foi assumido, desistir dele
  // aqui devolve o toque inteiro para a lista — inclusive o clique no cartão.
  if (andou <= 0 && !puxadaViva) { puxadaDe = null; return; }
  if (!puxadaViva && andou < PUXAR_FOLGA) return;
  puxadaViva = true;
  puxadaAndou = andou;
  // Barra a rolagem E o clique fantasma que viria no fim deste toque.
  evento.preventDefault();
  const desceu = Math.min(PUXAR_TETO, andou * 0.5);
  desenharPuxada(desceu);
  desenharSelo(seloLista, desceu, andou >= PUXAR_LIMIAR);
}, { passive: false });

listaRolavel.addEventListener('touchend', () => {
  if (!puxadaViva) { puxadaDe = null; return; }
  const valeu = puxadaAndou >= PUXAR_LIMIAR;
  puxadaDe = null;
  puxadaViva = false;
  puxadaAndou = 0;
  toqueBloqueadoAte = Date.now() + PUXAR_CARENCIA;
  voltarPuxada();
  if (!valeu) { apagarSelo(seloLista); return; }
  // Mesmo contrato do selo da fita: o `finally` apaga em qualquer saída, porque recarga que
  // falha também precisa parar de girar (#10).
  seloLista.dataset.girando = '1';
  seloLista.dataset.armado = '';
  recarregar($('btn-recarregar'), recarregarAVista).finally(() => {
    seloLista.dataset.girando = '';
    apagarSelo(seloLista);
  });
}, { passive: true });

// Toque cancelado pelo sistema (chamada chegando, gesto do Android assumindo a tela): o
// gesto morre sem atualizar nada.
listaRolavel.addEventListener('touchcancel', () => {
  puxadaDe = null;
  puxadaViva = false;
  puxadaAndou = 0;
  voltarPuxada();
  apagarSelo(seloLista);
}, { passive: true });

// ── O mesmo gesto, na CONVERSA (02/09) ──────────────────────────────────
//
// A mesma lógica da lista, com as MESMAS cinco constantes — dois números diferentes para o
// mesmo gesto em duas listas seria a #40 esperando acontecer. O que muda, e só isto:
//   ouve o toque em : .mensagens do PAINEL — é quem tem o `scrollTop` que arma o gesto
//   DESCE           : .fita do PAINEL — NUNCA a .mensagens. A tela da pane (`.pergunta`) é
//                     FILHA dela e no celular é `position: fixed; inset: 0`; um ancestral com
//                     `transform` vira o bloco de contenção dela e ela deixaria de cobrir a
//                     viewport. Descendo a fita (irmã da pane), a pane fica intocada E o
//                     `overflow-y: auto` da `.mensagens` recorta a fita descida — o que a
//                     `.lateral` faz pela lista com o `overflow: hidden` dela.
//   ao soltar       : `recarregar(painel.btnRecarregar, () => recarregarPainel(painel))` — o
//                     botão é o alvo do `data-recarregando` mesmo estando `display: none` no
//                     celular, exatamente como o gesto da lista usa o ↻ dela.
//   guarda           : tela da pane aberta bloqueia o gesto (ver o comentário no touchstart).
// Sem repique: a fita só chega ao topo quando alguém rolou até lá para LER histórico, e o
// repique empurraria de volta o texto que ele está lendo. A volta é reta (CSS da `.fita`).
//
// Liga-se por painel (split view, fase 2): o gesto vive na `.mensagens`/`.fita` DAQUELE
// painel, criadas em `criarPainel` — não há mais um `#mensagens` único no `index.html`.

const seloLista = $('puxar-selo-lista');

// O selo é o retorno visual do gesto (03/09). A fita descer já mostra que ALGO acontece, mas
// não diz o quê nem quando vale — o ↻ saiu do celular e isto entrou no lugar.
//
// `--puxar` é a fração do curso, 0 a 1, e é a ÚNICA coisa que o JS escreve enquanto o dedo
// anda: opacidade, escala e giro saem dela no CSS. O limiar chega como `armado` porque o JS
// já o conhece (`PUXAR_LIMIAR` é sobre o quanto o DEDO andou, não sobre o quanto a fita
// desceu) e recalculá-lo no CSS duplicaria a régua.
function desenharSelo(selo, px, armado) {
  selo.style.setProperty('--puxar', String(Math.min(1, px / PUXAR_TETO)));
  selo.dataset.armado = armado ? '1' : '';
}

/** Apaga o selo. Some junto com a fita, não depois: sobrar aceso pareceria travado. */
function apagarSelo(selo) {
  selo.style.removeProperty('--puxar');
  selo.dataset.armado = '';
}

/** Liga o gesto de puxar-para-atualizar na `.mensagens`/`.fita` DESTE painel. */
function ligarGestoDePuxar(painel) {
  const conversaRolavel = painel.mensagens;
  const fitaPuxavel = painel.fita;
  const seloPuxada = painel.selo;

  let puxadaFitaDe = null;
  let puxadaFitaViva = false;
  let puxadaFitaAndou = 0;

  function desenharPuxadaDaFita(px) {
    fitaPuxavel.dataset.voltando = '';
    fitaPuxavel.style.transform = px ? `translateY(${px}px)` : '';
  }

  function voltarPuxadaDaFita() {
    fitaPuxavel.dataset.voltando = '1';
    fitaPuxavel.style.transform = '';
    setTimeout(() => { fitaPuxavel.dataset.voltando = ''; }, PUXAR_VOLTA);
  }

  conversaRolavel.addEventListener('touchstart', (evento) => {
    puxadaFitaViva = false;
    puxadaFitaAndou = 0;
    puxadaFitaDe = null;
    // A tela da pane é FILHA de `.mensagens` e existe para ser arrastada com o dedo: sem
    // isto, ler o framebuffer recarregaria a conversa no meio de um menu esperando resposta.
    // A régua é o `hidden`, que é a que `marcarPergunta` já mantém.
    if (!painel.pergunta.hidden) { puxadaFitaDe = null; return; }
    puxadaFitaDe = evento.touches.length === 1 && conversaRolavel.scrollTop <= 0
      ? evento.touches[0].clientY
      : null;
  }, { passive: true });

  conversaRolavel.addEventListener('touchmove', (evento) => {
    if (puxadaFitaDe === null || evento.touches.length !== 1) return;
    const andou = evento.touches[0].clientY - puxadaFitaDe;
    if (andou <= 0 && !puxadaFitaViva) { puxadaFitaDe = null; return; }
    if (!puxadaFitaViva && andou < PUXAR_FOLGA) return;
    puxadaFitaViva = true;
    puxadaFitaAndou = andou;
    evento.preventDefault();
    const desceu = Math.min(PUXAR_TETO, andou * 0.5);
    desenharPuxadaDaFita(desceu);
    desenharSelo(seloPuxada, desceu, andou >= PUXAR_LIMIAR);
  }, { passive: false });

  conversaRolavel.addEventListener('touchend', () => {
    if (!puxadaFitaViva) { puxadaFitaDe = null; return; }
    const valeu = puxadaFitaAndou >= PUXAR_LIMIAR;
    puxadaFitaDe = null;
    puxadaFitaViva = false;
    puxadaFitaAndou = 0;
    voltarPuxadaDaFita();
    if (!valeu) { apagarSelo(seloPuxada); return; }
    // Girando: o selo se descola do dedo e passa a marcar o TEMPO DA RECARGA. O `finally`
    // apaga em qualquer saída — recarga que falha também precisa parar de girar, senão o
    // selo fica rodando para sempre dizendo uma coisa que não está mais acontecendo (#10).
    seloPuxada.dataset.girando = '1';
    seloPuxada.dataset.armado = '';
    recarregar(painel.btnRecarregar, () => recarregarPainel(painel)).finally(() => {
      seloPuxada.dataset.girando = '';
      apagarSelo(seloPuxada);
    });
  }, { passive: true });

  conversaRolavel.addEventListener('touchcancel', () => {
    puxadaFitaDe = null;
    puxadaFitaViva = false;
    puxadaFitaAndou = 0;
    voltarPuxadaDaFita();
    apagarSelo(seloPuxada);
  }, { passive: true });
}
$('btn-lateral').onclick = () => aplicarLateral(app.dataset.lateral !== 'fechada');
// O clique no medidor (e o `←`/↻/✕/teclas de cada conversa) mora no closure de
// `criarPainel` desde a fase 2 do split view — a "regra do dono": não há mais um único
// `#medidor` para ligar aqui.
// O painel de configuração, onde moram os quatro controles que saíram do rodapé da lateral.
// Abre e fecha só pelo <dialog>: nada de `pushState` aqui de propósito — o voltar do Android
// chega como pedido de fechar e o navegador o consome no diálogo aberto, então o gesto fecha
// o painel SEM sair da conversa. Empilhar uma entrada "para o voltar funcionar" daria um
// degrau morto na pilha, que é a armadilha #36 vista de outro ângulo (ver #39).
function abrirConfig() {
  $('dialogo-config').showModal();
  // O que o cliente sabe ANTES de perguntar qualquer coisa: se há aba aberta. Sem ela não há
  // para onde mandar o `/effort`, e o controle nasce travado com o motivo escrito — nunca
  // some calado. Depois disso pergunta ao servidor qual é o nível global, no mesmo padrão do
  // `btn-plano` → `carregarLimite(false)`.
  $('sel-effort').disabled = !atual;
  escreverNotaDoEffort();
  carregarEffort();
  montarAtalhos();
  // As janelas de graça (D-a) fazem a linha "Consumo do plano" ter número SEM custar turno
  // — antes disso `#plano-valor` ficava vazio até alguém abrir o diálogo "Consumo do plano".
  carregarLimite(false);
}
// Recorte, não reescrita (§6.13): com o atalho Alt+/, o painel ganha um SEGUNDO gatilho para
// a mesma função — duplicar o corpo é como os dois divergem.
$('btn-config').onclick = abrirConfig;
$('sel-effort').onchange = () => trocarEffort(paineis.get(atual));
$('btn-fechar-config').onclick = () => $('dialogo-config').close();
// Abrir e fechar aba. Os dois <dialog> abrem como os outros seis: sem `pushState`, porque o
// voltar do Android chega neles como pedido de FECHAR e morre ali (#39).
$('btn-nova-aba').onclick = () => { $('dialogo-nova-aba').showModal(); carregarProjetos(); };
$('btn-fechar-nova-aba').onclick = () => $('dialogo-nova-aba').close();
$('btn-criar-aba').onclick = (evento) => criarAba(evento && evento.currentTarget ? evento.currentTarget : $('btn-criar-aba'));
// O campo Projeto — ligado UMA vez: é estático no HTML, não nasce por abertura do diálogo. Os
// ouvintes globais de tecla saem com o diálogo aberto (`DIALOGOS`), então seta/Enter/Esc daqui
// nunca chegam à pane.
// O fechar pendente do `blur`: o foco que VOLTA antes dos 120 ms o cancela — senão Tab para fora
// e de volta reabre a lista e ela fecha sozinha logo depois (achado do painel de execução).
let fechaProjetoNoBlur = null;
$('sel-projeto-novo').addEventListener('focus', () => { clearTimeout(fechaProjetoNoBlur); abrirListaProjetos(); });
// Campo JÁ focado não recebe `focus` de novo: sem o clique, a lista escolhida não reabre (S8).
$('sel-projeto-novo').addEventListener('click', () => { if ($('lista-projeto-novo').hidden) abrirListaProjetos(); });
$('sel-projeto-novo').addEventListener('input', filtrarProjetos);
// O mesmo atraso da paleta: dá tempo do `mousedown` de uma opção escolher antes de fechar.
$('sel-projeto-novo').addEventListener('blur', () => { fechaProjetoNoBlur = setTimeout(fecharListaProjetos, 120); });
$('sel-projeto-novo').addEventListener('keydown', (e) => {
  if (e.isComposing) return;                      // Enter de IME não escolhe
  const aberta = !$('lista-projeto-novo').hidden;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    navegarProjetos(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  // Enter escolhe o nome destacado, ou cria a pasta quando o destacado é o item de criar (S6). Sem nada
  // destacado (zero nomes, S5), não faz nada.
  if (e.key === 'Enter' && aberta && indiceProjeto >= 0) {
    e.preventDefault();
    if (indiceProjeto < escolhidosProjeto.length) escolherProjeto(indiceProjeto);
    else criarPasta();
    return;
  }
  // Esc em dois tempos: com a lista aberta, o `preventDefault` segura o CloseWatcher do <dialog>
  // (#39) e só a lista fecha; com ela fechada, o Esc segue e o diálogo fecha sozinho.
  if (e.key === 'Escape' && aberta) {
    e.preventDefault();
    fecharListaProjetos();
    return;
  }
  if (e.key === 'Tab') fecharListaProjetos();     // sem preventDefault: Tab continua navegando
});
// O `✕` de CADA painel abre este <dialog> compartilhado e grava `painelPedindoMorte` — não
// há mais um único `#btn-matar-aba` para ligar aqui (a "regra do dono", em `criarPainel`).
$('btn-fechar-matar-aba').onclick = () => $('dialogo-matar-aba').close();
$('btn-confirma-matar-aba').onclick = (evento) => matarAba(painelPedindoMorte,
  evento && evento.currentTarget ? evento.currentTarget : $('btn-confirma-matar-aba'));
// Renomear a aba — o 11º <dialog>, aberto pelo ✎ de CADA linha (a chave vem de `edicaoDoNome`,
// nunca de `atual`). Sem pushState (#39): o voltar do Android fecha o diálogo sozinho.
$('btn-fechar-renomear-aba').onclick = () => $('dialogo-renomear-aba').close();
$('btn-confirma-renomear-aba').onclick = (evento) => renomearAba(
  evento && evento.currentTarget ? evento.currentTarget : $('btn-confirma-renomear-aba'));
$('nome-aba').onkeydown = (evento) => {
  if (evento.key !== 'Enter' || evento.isComposing) return;
  evento.preventDefault();
  renomearAba($('btn-confirma-renomear-aba'));
};
// Arquivos — o nono <dialog>, aberto como os outros: sem pushState (#39).
$('btn-arquivos').onclick = abrirArquivos;
$('btn-fechar-arquivos').onclick = () => $('dialogo-arquivos').close();
$('btn-mandar-servidor').onclick = (evento) => mandarParaOServidor(evento && evento.currentTarget ? evento.currentTarget : $('btn-mandar-servidor'));
$('btn-puxar-taildrop').onclick = (evento) => puxarTaildrop(evento && evento.currentTarget ? evento.currentTarget : $('btn-puxar-taildrop'));
// As três raízes são ids FECHADOS no servidor (R1); aqui só o rótulo de cada uma.
for (const [id, rotulo] of [['inbox', 'taildrop-inbox'], ['projetos', 'projetos'], ['cockpit', '.cockpit']]) {
  const opcao = document.createElement('option');
  opcao.value = id;
  idiomaUI.bind(opcao, 'textContent', () => tr(rotulo));
  $('sel-raiz-envio').append(opcao);
}
$('sel-raiz-envio').value = 'inbox';
$('sel-raiz-envio').onchange = () => carregarListaEnvio($('sel-raiz-envio').value, '');
$('btn-fechar-contexto').onclick = () => $('dialogo-contexto').close();
$('inp-arquivo-servidor').onchange = () => {
  const escolhidos = Array.from($('inp-arquivo-servidor').files || []);
  // Um arquivo continua mostrando nome e tamanho; vários viram contagem e soma, que é o que
  // cabe na linha do celular — cinco nomes empilhados empurrariam o botão para fora da tela.
  const soma = escolhidos.reduce((t, a) => t + (a.size || 0), 0);
  $('arquivo-servidor-selecionado').textContent = escolhidos.length > 1
    ? tr`${escolhidos.length} arquivos · ${formatarBytes(soma)}`
    : (escolhidos.length === 1
      ? `${escolhidos[0].name} · ${formatarBytes(escolhidos[0].size)}`
      : tr('Nenhum arquivo escolhido'));
};
$('btn-plano').onclick = () => { $('dialogo-plano').showModal(); carregarLimite(false); };
$('btn-aparelhos').onclick = () => abrirAparelhos();
$('btn-atualizar-aparelhos').onclick = () => carregarAparelhos();
$('btn-fechar-aparelhos').onclick = () => $('dialogo-aparelhos').close();
// URL relativa CRUA — window.open já resolve contra o <base> do documento (o /cockpit do
// tailscale serve). `new URL(..., document.baseURI)` está PROIBIDO aqui: document.baseURI
// não existe no DOM de mentira do gate-ui.js, e essa troca seria uma bomba armada para o
// primeiro teste que clicasse no botão (§5, Verificado/OK da spec). Sem token na URL —
// mesma origem, mesmo localStorage (P2/§1.6).
// A tela de tokens vem para dentro do app (fase 2b, 04/09): antes era `window.open`, uma
// página solta; agora é o dialog nativo, no mesmo padrão dos outros dezessete (D32) — sem
// `pushState` (#39), o voltar do Android fecha o diálogo sem sair da conversa. `abrir()` é a
// ÚNICA entrada pública do `uso.js` — nunca `carregar(1)` direto, que chumbaria "Hoje" e
// apagaria o período que o usuário tinha escolhido da última vez.
$('btn-uso').onclick = () => { $('dialogo-uso').showModal(); telaUso.abrir(); };
$('btn-fechar-uso').onclick = () => $('dialogo-uso').close();
$('btn-fechar-plano').onclick = () => $('dialogo-plano').close();
$('btn-atualiza-limite').onclick = () => carregarLimite(true);
$('btn-copiar-acesso').onclick = (evento) => copiarAcesso(evento.currentTarget);
$('btn-avisos').onclick = ligarAvisos;
$('btn-fechar-diagnostico').onclick = () => $('dialogo-diagnostico').close();
$('btn-copiar-diagnostico').onclick = async () => {
  const texto = (await diagnosticoDeAvisos()).map(([k, v]) => `${k}: ${v}`).join('\n');
  const erro = $('lista-diagnostico').querySelector('.diag-erro');
  navigator.clipboard?.writeText(`${erro ? `${erro.textContent}\n` : ''}${texto}`).catch(() => {});
};
$('btn-fechar-acesso').onclick = () => $('dialogo-acesso').close();
$('btn-copiar-de-novo').onclick = () => {
  const campo = $('txt-acesso');
  campo.select();
  navigator.clipboard?.writeText(campo.value).catch(() => document.execCommand('copy'));
};
// O `Parar` e as seis teclas do menu de CADA conversa moram no closure de `criarPainel`
// desde a fase 2 do split view — ver o comentário ali sobre a "regra do dono". Não há mais
// `#btn-parar`/`#tecla-*` únicos para ligar aqui.

// ── Atalhos de teclado, globais e configuráveis ───────────────────────────
//
// Um único ouvinte no `document` cobre as cinco ações. A regra que evita "digitar vira
// atalho": toda combinação exige Ctrl, Alt ou Meta — tecla nua nunca dispara (§3.1 da spec).
// Ver docs/superpowers/specs/2026-08-29-atalhos-de-teclado-configuraveis-design.md.

// A tabela da decisão A (§2.1.2): id, rótulo (o que a tela de config mostra), padrão de
// fábrica e a função que já existe e faz o trabalho. Trocar um padrão é trocar uma string;
// tirar uma ação é apagar a linha — nada mais muda (§2.1.3).
const ACOES = [
  { id: 'aba-anterior', rotulo: 'Aba anterior', padrao: 'Alt+K', rodar: () => pularAba(-1) },
  { id: 'aba-seguinte', rotulo: 'Aba seguinte', padrao: 'Alt+J', rodar: () => pularAba(1) },
  { id: 'focar-caixa', rotulo: 'Escrever', padrao: 'Alt+C', rodar: () => paineis.get(atual)?.entrada.focus() },
  {
    id: 'lista', rotulo: 'Mostrar/esconder a lista', padrao: 'Alt+L',
    rodar: () => aplicarLateral(app.dataset.lateral !== 'fechada'),
  },
  { id: 'config', rotulo: 'Configuração e atalhos', padrao: 'Alt+/', rodar: () => abrirConfig() },
];

// Os nove <dialog> da tela (§1.4). Lista literal, não querySelectorAll — o DOM de mentira do
// gate não tem esse método, e ids literais são o padrão do arquivo. O gate confere que esta
// lista bate com o HTML (asserção 16): é a rede contra a armadilha #40.
const DIALOGOS = [
  'dialogo-diagnostico', 'dialogo-acesso', 'dialogo-token', 'dialogo-config',
  'dialogo-plano', 'dialogo-contexto', 'dialogo-nova-aba', 'dialogo-matar-aba',
  'dialogo-arquivos',
  // O décimo, da fase 2b (04/09). Sem ele aqui, `Alt+J`/`Alt+K` continuariam trocando de
  // aba POR BAIXO da tela de tokens aberta — o vazamento que a guarda 3 existe para impedir
  // nos outros nove.
  'dialogo-uso',
  // O 11º (card `renomear-a-aba`): sem ele aqui, as letras digitadas no nome não disparam atalho
  // (tecla nua já é ignorada), mas Alt+J/Alt+K trocariam de aba POR BAIXO do diálogo aberto.
  'dialogo-renomear-aba',
  // O 12º (card `nome-do-aparelho-no-push`): a lista tem um <input> por linha em edição, e
  // sem ele aqui o Alt+J/Alt+K trocaria de aba por baixo do diálogo aberto.
  'dialogo-aparelhos',
  // O 13º (plano 2026-10-04, tela "Pra revisar"): sem ele aqui, Alt+J/Alt+K trocariam de aba
  // por baixo do diálogo aberto, igual aos doze anteriores.
  'dialogo-revisar',
  // O 14º (card do monitor, D64): mesmo motivo dos treze anteriores.
  'dialogo-monitor',
];

// Combinações que o navegador já usa (§3.5): recusadas por igualdade exata. Existe para dar
// MENSAGEM boa — a rede de verdade é "se o navegador rouba, nada chega ao campo".
const RESERVADAS_COMBINACAO = new Set([
  ...['T', 'N', 'W', 'R', 'L', 'P', 'S', 'D', 'F', 'H', 'J', 'O', 'U', 'Q'].map((k) => `Ctrl+${k}`),
  ...['T', 'N', 'W', 'I', 'J', 'P', 'Q', 'Delete'].map((k) => `Ctrl+Shift+${k}`),
  ...'123456789'.split('').map((n) => `Ctrl+${n}`),
  ...'123456789'.split('').map((n) => `Alt+${n}`),
  'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+E', 'Alt+F',
]);

// Teclas de que a CAIXA já é dona (app.js:2802-2838), recusadas com QUALQUER modificador
// (§5.4) — mais as que o navegador usa sozinho (F1…F12) e o `+`, que é o separador da forma
// canônica e por isso não pode também ser a tecla (§6.26).
const RESERVADAS_TECLA = new Set([
  'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  '+',
]);

const CHAVE_ATALHOS = 'cockpit-atalhos';

/**
 * KeyboardEvent → combinação canônica ("Alt+J") ou `null` quando a tecla é texto (§3.3).
 *
 * Letra vem de `e.code` (`KeyJ` → `J`): `e.key` sob Alt varia com layout e SO, e quatro dos
 * cinco padrões são letras (§6.7). O resto (setas, Enter, `/`) vem de `e.key`, que aqui é o
 * estável — `e.code` delas é que varia com o layout.
 */
function combinacaoDe(e) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;                 // tecla nua é texto
  if (e.ctrlKey && e.altKey) return null;                                 // AltGr: Ctrl+Alt juntos
  if (e.getModifierState && e.getModifierState('AltGraph')) return null;  // AltGr, o outro jeito
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return null;
  const tecla = /^Key[A-Z]$/.test(e.code || '') ? e.code.slice(3) : e.key;
  const partes = [];
  if (e.ctrlKey) partes.push('Ctrl');
  if (e.altKey) partes.push('Alt');
  if (e.shiftKey) partes.push('Shift');
  if (e.metaKey) partes.push('Meta');
  partes.push(tecla);
  return partes.join('+');
}

// Nomes de tecla que `e.key` produz sem ser um caractere só — a lista fechada do item 2 do
// validador (§3.5.3): sem ela, "Alt+TeclaInexistente" pareceria uma combinação válida.
const NOMES_TECLA_CONHECIDA = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'Insert', 'Delete', 'Backspace', 'Enter', 'Escape', 'Tab',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

/**
 * O VALIDADOR ÚNICO (§3.5.3). Recebe uma STRING (nunca um evento) e devolve a frase do
 * problema, ou `null` se a combinação pode ser gravada. A gravação mostra a frase ao usuário;
 * a leitura (`mapaAtual`) descarta a entrada calada — os dois chamam esta mesma função, então
 * não há como divergir.
 */
function motivoDeRecusa(combinacao, mapa) {
  if (typeof combinacao !== 'string' || !combinacao) return tr('combinação inválida');

  // 1. a forma canônica: Ctrl, Alt, Shift, Meta — nesta ordem, cada um opcional — e uma
  // tecla no fim. Remonta e compara: se não bater, não é canônica.
  let resto = combinacao;
  const mods = { Ctrl: false, Alt: false, Shift: false, Meta: false };
  for (const nome of ['Ctrl', 'Alt', 'Shift', 'Meta']) {
    if (resto.startsWith(`${nome}+`)) { mods[nome] = true; resto = resto.slice(nome.length + 1); }
  }
  const tecla = resto;
  const canonico = [...['Ctrl', 'Alt', 'Shift', 'Meta'].filter((n) => mods[n]), tecla].join('+');
  if (!tecla || canonico !== combinacao) return tr('essa combinação não é reconhecida');

  // 2. a tecla precisa ser uma tecla que um KeyboardEvent de verdade produz.
  if (tecla.length !== 1 && !NOMES_TECLA_CONHECIDA.has(tecla)) return tr('essa tecla não existe');

  // 3. sem Ctrl/Alt/Meta — tecla nua (§3.1)
  if (!mods.Ctrl && !mods.Alt && !mods.Meta) return tr('atalho precisa de Ctrl ou Alt');

  // 4. Ctrl e Alt juntos — é o AltGr do teclado físico (§3.1/§6.11)
  if (mods.Ctrl && mods.Alt) return tr('isso é o AltGr do teclado — não dá para usar como atalho');

  // 5. só Meta (§6.4)
  if (mods.Meta && !mods.Ctrl && !mods.Alt) {
    return tr('a tecla do sistema não chega ao navegador de forma confiável');
  }

  // 6. o navegador já usa esta combinação
  if (RESERVADAS_COMBINACAO.has(combinacao)) return tr`o navegador usa ${combinacao}`;

  // 7. a caixa de escrita (ou o navegador) já é dona desta tecla, com qualquer modificador
  if (RESERVADAS_TECLA.has(tecla)) {
    if (tecla === '+') return tr('o + é o separador dos atalhos; escolha outra tecla');
    if (/^F\d+$/.test(tecla)) return tr`o navegador usa ${tecla}`;
    return tr`a caixa de escrita já usa ${tecla}`;
  }

  // 8. já pertence a outra ação
  if (mapa && mapa.has(combinacao)) {
    const dono = ACOES.find((a) => a.id === mapa.get(combinacao));
    return tr`${combinacao} já é ${dono ? dono.rotulo : mapa.get(combinacao)}`;
  }

  return null;
}

/**
 * Combinação → id da ação, em duas passadas sobre ACOES na ordem de declaração (§3.5.4). O
 * override do disco ganha do padrão; quem perde a tecla fica SEM atalho em vez de roubar a
 * de outro. Montado na hora — são cinco entradas, memoizar custaria uma invalidação à toa.
 */
function mapaAtual() {
  const guardado = atalhosGuardados();
  const mapa = new Map();
  // A) escolha do usuário: cada ação com override válido no disco
  for (const acao of ACOES) {
    const override = guardado[acao.id];
    if (typeof override !== 'string') continue;
    if (motivoDeRecusa(override, mapa) === null) mapa.set(override, acao.id);
  }
  // B) o resto: cada ação ainda sem combinação tenta o próprio padrão
  for (const acao of ACOES) {
    const jaAlocada = [...mapa.values()].includes(acao.id);
    if (jaAlocada) continue;
    if (!mapa.has(acao.padrao)) mapa.set(acao.padrao, acao.id);
    // senão: fica sem atalho — a tela mostra "—" (Fase 2)
  }
  return mapa;
}

/**
 * A persistência (decisão B, §2.2): por aparelho, como as outras três preferências do
 * cockpit. `try/catch` nos dois lados, como `aplicarTema` (app.js:2460).
 */
function atalhosGuardados() {
  try {
    const bruto = localStorage.getItem(CHAVE_ATALHOS);
    if (!bruto) return {};
    const obj = JSON.parse(bruto);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function gravarAtalhos(obj) {
  try { localStorage.setItem(CHAVE_ATALHOS, JSON.stringify(obj)); } catch { /* modo privado */ }
}

/**
 * Troca de aba por deslocamento de índice (§3.2). Com MAIS de um painel aberto, o atalho
 * move o FOCO entre eles — trocar a conversa desmontaria o split que o usuário acabou de
 * montar (R6 da spec). Com um painel só, comportamento de sempre: lista vazia não estoura;
 * `atual` fora da lista (nenhuma aba aberta, ou ela foi fechada no tmux) abre a primeira; o
 * caso normal grampeia nas pontas — não circula, para o usuário nunca perder onde está.
 */
function pularAba(passo) {
  if (paineis.size > 1) {
    const chaves = [...paineis.keys()];
    const indice = chaves.indexOf(atual);
    const alvo = indice === -1 ? 0 : Math.min(chaves.length - 1, Math.max(0, indice + passo));
    focar(paineis.get(chaves[alvo]));
    // §3.9 da spec, consequência 2: `Alt+J`/`Alt+K` é atalho de TECLADO — quem o usa está
    // com as mãos no teclado e quer continuar escrevendo. Incondicional (sem risco de
    // teclado virtual — o atalho exige `Alt`).
    paineis.get(atual).entrada.focus();
    return;
  }
  // A ordem que o atalho percorre é a DA TELA (D69: a hora em que o último turno terminou) — é o
  // que o usuário vê. `#lista-conversas` é a âncora de LUGAR (#52): na vista de agentes/leituras
  // ela não existe, e o atalho é no-op (BA-5); uma seção estranha dentro de #abas não entra (G16).
  const lista = $('abas').querySelector('#lista-conversas');
  const chaves = lista ? [...lista.querySelectorAll('.conversa')].map((b) => b.dataset.chave) : [];
  const indice = chaves.indexOf(atual);
  if (indice === -1) { if (chaves[0]) abrirAba(chaves[0]); return; }
  const destino = indice + passo;
  if (destino >= 0 && destino < chaves.length) abrirAba(chaves[destino]);
}

// id da ação em captura na tela de config, ou `null`. Zerado no `close`/`cancel` do
// <dialog> (§5.6) — não só na abertura, porque os atalhos ficariam mortos entre um
// fechamento pelo Escape/voltar do Android e a próxima vez que o painel abrisse.
let capturando = null;

// O ouvinte global. Guardas na ordem exata da §3.4 — a 0 é a mais barata e evita o bug mais
// feio (autorepeat abrindo dezenas de EventSource em rajada, §5.5).
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;                          // guarda 0 — autorepeat não é atalho
  const combinacao = combinacaoDe(e);
  if (combinacao === null) return;                // guarda 1 — tecla nua é texto
  if (capturando) return;                         // guarda 2 — a tela de config está gravando
  if (DIALOGOS.some((id) => $(id).open)) return;   // guarda 3 — painel aberto manda no teclado
  // guarda 4 — a paleta já é dona. Pelo CURSOR, não por `atual` (§3.6 da spec): com B
  // selecionado e o cursor em A, a paleta aberta é a de A, e ler `atual` liberaria `Alt+J`
  // por cima do autocomplete em uso — a mesma pergunta que o `paste` faz, com o mesmo
  // resolvedor.
  if (painelDoAlvo(document.activeElement)?.paleta.hidden === false) return;
  const id = mapaAtual().get(combinacao);
  if (!id) return;                                 // guarda 5 — combinação fora do mapa
  const acao = ACOES.find((a) => a.id === id);
  e.preventDefault();
  acao.rodar();
});

// As seis teclas físicas do menu da TUI (card responder-a-pergunta-pelo-teclado). Mapa
// FECHADO de propósito (D-A/D4/D6): tecla livre daqui viraria teclado remoto, o que o
// projeto já recusou. Os mesmos seis valores de `lib/abas.js:1658`.
const TECLAS_FISICAS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Enter', Escape: 'Escape',
};

/** `tagName`/`isContentEditable` — nunca `document.activeElement` (§3.2 da spec: as duas
 * leituras coincidem no navegador, mas são independentes no DOM de mentira do gate). */
function ehCampoDeEscrita(alvo) {
  return alvo?.tagName === 'INPUT' || alvo?.tagName === 'TEXTAREA' || alvo?.isContentEditable === true;
}

/** Enter com o foco num destes ativa por `click` nativo — o ouvinte tem que ceder a vez
 * (R1), senão o Enter vira DUAS teclas: a do clique nativo e a deste ouvinte. */
function ehAtivavelPorEnter(alvo) {
  return alvo?.tagName === 'BUTTON' || (alvo?.tagName === 'A' && !!alvo.href) || alvo?.tagName === 'SUMMARY';
}

// Ouvinte IRMÃO do de atalhos acima — não uma alteração dele: aquele trata combinação com
// modificador, este trata tecla NUA (a resposta ao menu da TUI). `e.target`, nunca
// `document.activeElement`, nas guardas de campo-de-escrita/ativável-por-Enter/pergunta —
// no navegador as duas leituras coincidem, mas o DOM de mentira do gate as separa (R2).
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;                                    // guarda 1 — autorepeat não é resposta (R4)
  if (e.altKey || e.ctrlKey || e.metaKey) return;           // guarda 2 — combinação é atalho, não menu
  const valor = TECLAS_FISICAS[e.key];
  if (!valor) return;                                       // guarda 3 — fora do mapa fechado
  if (e.isComposing) return;                                // guarda 4 — Enter de IME não é menu (R6)
  // guarda 5 — não rouba a tecla de quem escreve (D-C), MAS a caixa só é dona do teclado
  // enquanto ela é utilizável. Esta linha NÃO mudou no card escrever-texto-na-pergunta-aberta,
  // e a justificativa dela sim: desde a D58 o envio com `motivo: 'menu'` NÃO é mais recusado e
  // o Enviar NÃO está mais travado. O que mantém esta guarda correta é outra coisa — a caixa
  // VAZIA continua sem ter o que fazer com a tecla, e é ela que cede. Com texto, quem decide
  // é o `keydown` do próprio `<textarea>` (`:1462`), que corta a propagação antes de chegar
  // aqui. Ou seja: esta guarda nunca vê a tecla de uma caixa que tem texto.
  //
  // Isto NÃO é teoria: com a guarda simples ("é campo de escrita → sai"), o gate ficou verde
  // e o teclado não respondia NADA no navegador — `abrirAba()` põe o cursor na `.entrada`
  // (`:1806`), então TODA seta morria aqui. Medido no smoke (`focoTag: "TEXTAREA"`), não
  // deduzido. É por painel: escrever em A enquanto B tem menu aberto continua protegido.
  if (ehCampoDeEscrita(e.target) && !painelDoAlvo(e.target)?.perguntando) return;
  // guarda 5b (D74/R4, card pergunta-do-agente-em-cartao) — campo e botões do CARTÃO nunca
  // mandam tecla à pane: a seta/Enter ali é do formulário, e mexeria no cursor da TUI.
  if (e.target?.dataset?.cartao) return;
  if (e.key === 'Enter' && ehAtivavelPorEnter(e.target)) return; // guarda 6 — clique nativo já responde (R1)
  if (DIALOGOS.some((id) => $(id).open)) return;            // guarda 7 — painel aberto manda no teclado (R3)
  // guarda 8 — a conversa não está na tela (R7): as DUAS condições, porque só juntas o
  // `.chat` some (só no celular a lista some o menu; no desktop `vista='lista'` continua
  // mostrando o `.chat`).
  if (app.dataset.vista !== 'chat' && matchMedia('(max-width: 760px)').matches) return;
  // guarda 9 — quem responde é o painel do CURSOR, e na falta dele o SELECIONADO (D-B): o
  // mesmo resolvedor do `paste` (`:6547`), para não inventar uma terceira regra de "dono
  // do teclado" numa tela que já tem duas.
  const painel = painelDoAlvo(e.target) || painelAtual();
  if (!painel || !painel.perguntando) return;
  // Com o cartão à vista e o "ver terminal" fechado, a seta nua mexeria no cursor da TUI e a
  // conferência do estado inicial deixaria de casar (D74/R4). Sem cartão a D57 é a de sempre
  // (#77), e com o terminal aberto também.
  if (painel.cartao && !painel.terminalPergunta.open) return;
  e.preventDefault();
  apertarTecla(painel, valor);
});

// ── A tela de configuração dos atalhos (§3.5) ──────────────────────────────

/** `mapaAtual()`, mas SEM as entradas da ação `id` — é o que deixa recapturar a própria
 * combinação (ou o próprio padrão) sem que o validador acuse "já usada por outra ação". */
function mapaSemAcao(id) {
  const mapa = mapaAtual();
  for (const [combinacao, dono] of [...mapa.entries()]) {
    if (dono === id) mapa.delete(combinacao);
  }
  return mapa;
}

/** Uma linha: `<rótulo> <button class="atalho-tecla">Alt+J</button>`. O `keydown` de captura
 * mora no PRÓPRIO botão — "como todo editor faz" (o card), nunca digitar "Ctrl+K" como texto. */
function linhaAtalho(acao, combinacao) {
  const linha = document.createElement('div');
  linha.className = 'atalho-linha';
  const rotulo = document.createElement('span');
  idiomaUI.bind(rotulo, 'textContent', () => tr(acao.rotulo));
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'atalho-tecla';
  botao.dataset.acao = acao.id;
  botao.setAttribute('aria-pressed', 'false');
  idiomaUI.attr(botao, 'aria-label', () => tr`${tr(acao.rotulo)}, atalho ${combinacao || tr('nenhum')}`);
  botao.textContent = combinacao || '—';
  botao.onclick = () => {
    capturando = acao.id;
    botao.setAttribute('aria-pressed', 'true');
    idiomaUI.bind(botao, 'textContent', () => tr('aperte a combinação…'));
    idiomaUI.bind($('nota-atalhos'), 'textContent', () => tr(''));
  };
  botao.addEventListener('keydown', (e) => {
    if (capturando !== acao.id) return;   // só reage enquanto ESTA linha está em captura
    if (e.repeat) { e.preventDefault(); return; }
    if (e.key === 'Tab') { capturando = null; montarAtalhos(); return; }  // sem preventDefault: Tab continua navegando
    if (e.key === 'Escape') {
      // Sem preventDefault, o MESMO Escape seria consumido pelo CloseWatcher do <dialog>
      // (#39) e fecharia o painel junto — o segundo Escape, já fora da captura, faz isso.
      e.preventDefault();
      capturando = null;
      montarAtalhos();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      const guardado = atalhosGuardados();
      delete guardado[acao.id];
      gravarAtalhos(guardado);
      capturando = null;
      montarAtalhos();
      const mapaDepois = mapaAtual();
      if (![...mapaDepois.values()].includes(acao.id)) {
        const dono = ACOES.find((a) => a.id === mapaDepois.get(acao.padrao));
        idiomaUI.bind($('nota-atalhos'), 'textContent', () => tr(dono ? tr`${acao.padrao} está em ${dono.rotulo}` : tr('voltou ao padrão')));
      } else {
        idiomaUI.bind($('nota-atalhos'), 'textContent', () => tr('voltou ao padrão'));
      }
      return;
    }
    e.preventDefault();
    const combinacaoNova = combinacaoDe(e);
    if (combinacaoNova === null) { idiomaUI.bind($('nota-atalhos'), 'textContent', () => tr('atalho precisa de Ctrl ou Alt')); return; }
    const motivo = motivoDeRecusa(combinacaoNova, mapaSemAcao(acao.id));
    if (motivo) { idiomaUI.bind($('nota-atalhos'), 'textContent', () => tr(motivo)); return; }
    const guardado = atalhosGuardados();
    // A mesma combinação que já é o padrão de fábrica: o override SAI (§3.5.2), em vez de
    // gravar igual — é o que faz um padrão novo, numa versão futura, valer sem migração.
    if (combinacaoNova === acao.padrao) delete guardado[acao.id];
    else guardado[acao.id] = combinacaoNova;
    gravarAtalhos(guardado);
    capturando = null;
    montarAtalhos();
    idiomaUI.bind($('nota-atalhos'), 'textContent', () => tr('gravado'));
  });
  linha.append(rotulo, botao);
  return linha;
}

/** Desenha a seção de atalhos inteira e decide aberta/recolhida — a pergunta ao `matchMedia`
 * é feita AQUI, na hora de abrir (§3.5.1/D30/D33), não uma vez no carregamento. */
function montarAtalhos() {
  capturando = null;
  const mapa = mapaAtual();
  const combinacaoDaAcao = new Map([...mapa.entries()].map(([combinacao, id]) => [id, combinacao]));
  const lista = $('atalhos-lista');
  idiomaUI.bind(lista, 'textContent', () => tr(''));
  for (const acao of ACOES) lista.append(linhaAtalho(acao, combinacaoDaAcao.get(acao.id) || null));
  idiomaUI.bind($('nota-atalhos'), 'textContent', () => tr(''));
  const comDedo = matchMedia('(pointer: coarse)').matches;
  $('btn-atalhos-abrir').hidden = !comDedo;
  $('atalhos-corpo').hidden = comDedo;
  // O valor da linha de ajuste (D34: os atalhos moram no localStorage, por aparelho).
  const nMudados = Object.keys(atalhosGuardados()).length;
  idiomaUI.bind($('atalhos-valor'), 'textContent', () => tr(nMudados > 0 ? tr`${nMudados} mudados` : tr('padrão')));
}

// No celular a seção nasce recolhida; tocar aqui revela as cinco linhas — sem isto o celular
// fica com uma seção que NUNCA abre (§3.5.1).
$('btn-atalhos-abrir').onclick = () => {
  $('atalhos-corpo').hidden = false;
  $('btn-atalhos-abrir').hidden = true;
};
$('btn-atalhos-padrao').onclick = () => {
  // APAGA a chave, não grava `{}`. Os dois são lidos igual por `atalhosGuardados()`, mas só
  // este deixa o `localStorage` como estava antes de existir atalho configurado — "voltar ao
  // padrão" que deixa rastro não voltou ao padrão. Apontado pelo painel de execução.
  try { localStorage.removeItem(CHAVE_ATALHOS); } catch { /* modo privado */ }
  capturando = null;
  montarAtalhos();
  idiomaUI.bind($('nota-atalhos'), 'textContent', () => tr('atalhos voltaram ao padrão'));
};
// O <dialog> fecha por caminhos que este JS não vê — Escape e o voltar do Android são o
// MESMO CloseWatcher nativo (#39) — e os dois disparam `close`/`cancel` de qualquer jeito.
// Sem isto, `capturando` travado em `true` mataria todos os atalhos até recarregar (§5.6).
$('dialogo-config').addEventListener('close', () => { capturando = null; });
$('dialogo-config').addEventListener('cancel', () => { capturando = null; });

$('form-token').addEventListener('submit', (evento) => {
  evento.preventDefault();
  const valor = $('inp-token').value.trim();
  if (!valor) return;
  try { localStorage.setItem(CHAVE_TOKEN, valor); } catch { /* modo privado */ }
  location.reload();
});

// O `#btn-anexar`/`#inp-arquivo` únicos saíram — moraram para o closure de `criarPainel`
// (D42): o seletor de arquivos é do painel do BOTÃO, não do foco.

// Colar print direto do Ctrl+V: no celular e no desktop é o caminho mais curto. Colar é
// operação de CURSOR (§3.9 da spec, consequência 1) — o painel sai do próprio evento, não
// de `atual`. O `|| paineis.get(atual)` cobre colar com o foco no `<body>`, que é o de hoje.
document.addEventListener('paste', (evento) => {
  const painel = painelDoAlvo(evento.target) || paineis.get(atual);
  if (!painel) return;
  const arquivos = [...(evento.clipboardData?.files || [])];
  if (!arquivos.length) return;
  evento.preventDefault();
  for (const arquivo of arquivos) subirArquivo(painel, arquivo);
});

const chat = $('chat');
// Split view, fase 3 (R7 da spec): o arrasto resolve o painel pelo ALVO embaixo do cursor,
// nunca pelo foco — soltar um arquivo no painel B não pode anexar no painel A só porque A
// estava com o teclado. Delegado em `.chat` porque `.painel` nasce e morre em tempo de
// execução; sem painel nenhum debaixo do cursor, o gesto é ignorado.
chat.addEventListener('dragover', (evento) => {
  if (ehArrastoDeAba(evento)) return;   // arrasto de ABA (D73) — tem ouvinte próprio, abaixo
  const raiz = evento.target.closest?.('.painel');
  if (!raiz) return;
  evento.preventDefault();
  raiz.dataset.arrasto = '1';
});
chat.addEventListener('dragleave', (evento) => {
  if (ehArrastoDeAba(evento)) return;   // arrasto de ABA (D73) — tem ouvinte próprio, abaixo
  const raiz = evento.target.closest?.('.painel');
  if (raiz) delete raiz.dataset.arrasto;
});
chat.addEventListener('drop', (evento) => {
  if (ehArrastoDeAba(evento)) return;   // arrasto de ABA (D73) — tem ouvinte próprio, abaixo
  const raiz = evento.target.closest?.('.painel');
  if (raiz) delete raiz.dataset.arrasto;
  if (!raiz) return;   // sem painel debaixo do cursor (R7) — ignora, não cai no foco
  evento.preventDefault();
  const painel = painelDoAlvo(evento.target);
  if (!painel) return;
  focar(painel);
  // Incondicional (§3.9 da spec, consequência 2): o `preventDefault()` acima impede o
  // navegador de mover foco nenhum sozinho — soltar um arquivo em B e digitar a mensagem
  // que o acompanha tem que escrever em B.
  painel.entrada.focus();
  for (const arquivo of evento.dataTransfer?.files || []) subirArquivo(painel, arquivo);
});

// Arrasto de ABA (D73) — irmão do de arquivo logo acima, separado pelo tipo no `dataTransfer`. Só
// age com `arrastoAba` preenchido: o mesmo tipo vindo de OUTRA janela do cockpit chega sem a chave
// (no `dragover` o `getData` volta vazio — modo protegido, #91) e é ignorado. O alvo sai da
// COORDENADA, nunca do `evento.target` nem de `atual` (#51).
chat.addEventListener('dragover', (evento) => {
  if (!ehArrastoDeAba(evento) || !arrastoAba) return;
  if (matchMedia('(max-width: 760px)').matches) { limparPreview(); return; }
  evento.preventDefault();
  if (evento.dataTransfer) evento.dataTransfer.dropEffect = 'move';
  // Histerese: a coluna fantasma ocupa justamente a posição que anuncia. Sem isto, inseri-la
  // empurra os painéis, o cursor cai noutra zona e o preview pisca.
  const coluna = $('paineis').querySelector('.fantasma-painel');
  if (coluna) {
    const r = coluna.getBoundingClientRect();
    if (evento.clientX >= r.left && evento.clientX < r.right) return;
  }
  mostrarPreview(alvoDoSolto(evento.clientX, faixasDosPaineis(), arrastoAba.chave));
});
chat.addEventListener('dragleave', (evento) => {
  if (!ehArrastoDeAba(evento) || !arrastoAba) return;
  // `dragleave` dispara a cada passagem de um filho para outro; a régua é a geometria, não o
  // `relatedTarget` (que o Chromium nem sempre preenche). Saiu da área: só o PREVIEW some — a
  // pessoa pode voltar com o mesmo gesto.
  const r = chat.getBoundingClientRect();
  const dentro = evento.clientX > r.left && evento.clientX < r.right
    && evento.clientY > r.top && evento.clientY < r.bottom;
  if (!dentro) limparPreview();
});
chat.addEventListener('drop', (evento) => {
  if (!ehArrastoDeAba(evento) || !arrastoAba) return;
  evento.preventDefault();
  const { chave } = arrastoAba;
  const alvo = alvoDoArrasto;   // o que a pessoa VIU é o que acontece
  encerrarArrasto();
  if (matchMedia('(max-width: 760px)').matches) return;
  if (!alvo) {
    // S4: solta onde ela já está — só ganha o foco (sem marcar lida: já estava aberta).
    if (paineis.has(chave)) focar(paineis.get(chave));
    return;
  }
  if (alvo.tipo === 'vazio') { abrirAba(chave); return; }
  const ancora = alvo.tipo === 'trocar' ? alvo.chave : alvo.antesDe;
  if (ancora && !paineis.has(ancora)) return;   // o tmux fechou a âncora no meio do gesto
  abrirAba(chave, { soltoEm: alvo });
});
// Rede do `dragend` perdido (#91): durante um arrasto nativo não existe `pointerdown`, então o
// primeiro clique com `arrastoAba` ainda preenchido prova que o gesto acabou sem avisar.
document.addEventListener('pointerdown', () => { if (arrastoAba) encerrarArrasto(); }, true);

// Os ouvintes de `input`/`blur`/`keydown`/`focus` da caixa e o `#btn-anexar`/`#inp-arquivo`
// únicos saíram — moraram para o closure de `criarPainel` (D42): cada painel tem a PRÓPRIA
// caixa, os PRÓPRIOS anexos e a PRÓPRIA paleta.

// ── Faixa de jobs ───────────────────────────────────────────────────────
//
// Indicador de TELA, não notificação: mostra o que o capitão tem rodando agora e o que
// acabou de terminar enquanto você olhava. Com o app fechado na hora do fim, ninguém vê o
// "terminou" — e é assim mesmo; quem avisa de longe é o push.
//
// Pega carona no ciclo de 15s da lista de conversas. Um relógio próprio só para isto seria
// um segundo jeito da tela discordar de si mesma.

// ── O grupo de jobs na lista lateral (desenho C, spec 2026-09-08) ────────
//
// TODOS os jobs do `?tudo=1` — os sete estados, não só `running`. Nome PRÓPRIO: `jobsRodando`
// (acima) e `jobsPorAba` continuam só com `estado === 'running'` (R4) — misturar as duas
// perguntas faria o resumo da tela vazia (M3) mentir, e o A11 do gate existe para provar isso.
let jobsDaLista = [];
// null = ainda não li o painel nenhuma vez (ignorância) · true = painel vivo · false = sem
// contato (notícia ruim). A distinção importa: `null` no boot não pode piscar erro (§4.6).
let painelDosJobs = null;
// Contador de sequência (§4.7): `atualizarFaixaJobs` é chamada de QUATRO lugares (abrir aba,
// boot, tique de 15s, `visibilitychange`), e uma leitura lenta que aterrissa depois de uma
// mais nova não pode repintar a tela com o passado.
let sequenciaJobs = 0;

// A vista da lateral: 'conversas' (as abas do terminal), 'agentes' (os jobs) ou 'leituras' (D59,
// card leituras-trilhas). MOMENTÂNEA — NÃO vai para o localStorage, ao contrário de CHAVE_TEMA
// (:4857) e CHAVE_LATERAL (:4840), que são PREFERÊNCIA. Recarregar a página nasce em conversas,
// sempre.
let vistaDaLateral = 'conversas';

// Uma rolagem POR VISTA. Zerar nos dois sentidos (o que este plano propunha antes) joga fora
// justamente o que interessa na volta: quem rolou até a décima conversa, entrou em agentes e
// voltou, esperaria estar onde estava. O código atual já gasta duas variáveis para nunca
// perder scroll (`rolagem` e `rolagemJobs` em desenharAbas) — isto é a mesma disciplina, com
// as duas rolagens agora compartilhando um scroller só.
const rolagemPorVista = { conversas: 0, agentes: 0, leituras: 0 };

// O último `GET /api/leituras` (ou `{ erro }` se a rede falhou). `null` = ainda não buscou
// nenhuma vez — distingue "carregando" de "veio vazio" na pintura (molde `painelDosJobs`).
let leituras = null;
// Contador de sequência (molde `sequenciaJobs`, :6805): uma resposta que aterrissa depois de
// uma mais nova não pode repintar a tela com o passado (R4 da spec).
let sequenciaLeituras = 0;
// id → valor PRETENDIDO enquanto o POST está em voo. O tique de 5s repinta `#abas` do cache
// (desenharAbas), e sem isto a caixa reabilitaria — ou pior, desmarcaria sozinha — no meio do
// salvamento (R4).
const livrosSalvando = new Map();
// id → valor PRETENDIDO de "lendo" enquanto o POST está em voo — mesmo papel de `livrosSalvando`.
const livrosLendoSalvando = new Map();
// A mensagem CRUA (do servidor ou da rede) do último POST que falhou — o prefixo traduzido
// "não salvou:" é montado na pintura, por `bind`, para acompanhar a troca de idioma. Sobrevive
// ao GET que o próprio POST dispara (senão piscaria e sumiria na mesma hora); some na próxima
// carga bem-sucedida.
let erroLeituras = '';

// O filtro da vista de leituras (D61): PREFERÊNCIA do aparelho, como CHAVE_TEMA — não é dado,
// não vai para o servidor. A VISTA continua momentânea (LT-8); o filtro é o que fica.
const CHAVE_FILTRO_LEITURAS = 'cockpit-leituras-filtro';
const STATUS_DE_LEITURA = ['todos', 'lendo', 'a-ler', 'lidos'];
let filtroLeituras = (() => {
  const padrao = { status: 'todos', trilha: '', texto: '' };
  try {
    const v = JSON.parse(localStorage.getItem(CHAVE_FILTRO_LEITURAS) || '{}');
    return {
      status: STATUS_DE_LEITURA.includes(v?.status) ? v.status : 'todos',
      trilha: typeof v?.trilha === 'string' ? v.trilha : '',
      texto: typeof v?.texto === 'string' ? v.texto.slice(0, 100) : '',
    };
  } catch { return padrao; }
})();
function salvarFiltroLeituras() {
  try { localStorage.setItem(CHAVE_FILTRO_LEITURAS, JSON.stringify(filtroLeituras)); } catch { /* modo privado */ }
}
// A assinatura das trilhas cujas opções do seletor estão desenhadas — recriar só quando o
// CATÁLOGO muda (recriar com o seletor aberto o fecharia na mão do usuário).
let assinaturaDasOpcoes = null;

// Trilhas recolhidas (ajuste 05/10 da D61): preferência SÓ do aparelho, chave própria, como o
// filtro. Padrão: todas abertas. Guarda os ids; id que sumiu do catálogo só não casa com nada.
const CHAVE_TRILHAS_RECOLHIDAS = 'cockpit-leituras-recolhidas';
const trilhasRecolhidas = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(CHAVE_TRILHAS_RECOLHIDAS) || '[]');
    return new Set(Array.isArray(v) ? v.filter((id) => typeof id === 'string') : []);
  } catch { return new Set(); }
})();
function salvarTrilhasRecolhidas() {
  try { localStorage.setItem(CHAVE_TRILHAS_RECOLHIDAS, JSON.stringify([...trilhasRecolhidas])); } catch { /* modo privado */ }
}
// Com texto na busca, toda trilha com resultado aparece ABERTA — sem gravar isso como
// preferência. O toque no cabeçalho durante a busca recolhe só AQUI, em memória; mudar ou
// limpar a busca esquece, e a tela volta ao recolhido salvo.
const recolhidasNaBusca = new Set();
function alternarTrilha(id) {
  const alvo = normalizarBusca(filtroLeituras.texto) !== '' ? recolhidasNaBusca : trilhasRecolhidas;
  if (alvo.has(id)) alvo.delete(id);
  else alvo.add(id);
  if (alvo === trilhasRecolhidas) salvarTrilhasRecolhidas();
  desenharAbas();
}

// A busca (D61) nasce no HTML e só recebe o valor salvo aqui, uma vez. `oninput` repinta a lista
// — o campo em si nunca é recriado (ver o comentário do index.html). Tem de vir AQUI, depois da
// declaração de `filtroLeituras` acima — ligar perto do `$('barra-leituras').onclick` (:6018)
// leria a variável na zona morta (`ReferenceError` que derruba o boot inteiro).
$('filtro-texto').value = filtroLeituras.texto;
idiomaUI.attr($('filtro-texto'), 'placeholder', () => tr('buscar livro'));
idiomaUI.attr($('filtro-texto'), 'aria-label', () => tr('buscar livro'));
$('filtro-texto').oninput = (e) => {
  filtroLeituras.texto = String((e?.currentTarget || $('filtro-texto')).value).slice(0, 100);
  recolhidasNaBusca.clear();
  salvarFiltroLeituras();
  desenharAbas();
};
// O seletor de trilha (ajuste 05/10): `<select>` nativo — no celular abre o seletor do sistema.
// Nasce no HTML, fora do `#abas`, pelo mesmo motivo da busca: repintado a cada 5 s, ele
// fecharia aberto na mão do usuário. Mesmo estado e mesma chave do filtro de antes.
idiomaUI.attr($('filtro-trilha'), 'aria-label', () => tr('filtrar por trilha'));
$('filtro-trilha').onchange = (e) => {
  filtroLeituras.trilha = String((e?.currentTarget || $('filtro-trilha')).value);
  salvarFiltroLeituras();
  desenharAbas();
};

function trocarVistaDaLateral(vista) {
  if (!['agentes', 'conversas', 'leituras'].includes(vista)) return;
  if (vistaDaLateral === vista) return;
  const alvo = $('abas');
  rolagemPorVista[vistaDaLateral] = alvo.scrollTop;   // guarda a que SAI
  vistaDaLateral = vista;
  desenharAbas();                                     // repinta (e preserva o scrollTop atual)
  alvo.scrollTop = rolagemPorVista[vista];            // e SÓ ENTÃO restaura a que ENTRA
  // O catálogo pode ter mudado desde a última vez (decisão 4 da spec) — busca de novo toda
  // vez que a vista é aberta, não só na primeira.
  if (vista === 'leituras') carregarLeituras();
}

/**
 * Busca `/api/leituras` e repinta. `manterErro` existe só para o `finally` de `marcarLivro`:
 * o erro de um POST tem de sobreviver ao GET que o próprio POST dispara.
 */
async function carregarLeituras({ manterErro = false } = {}) {
  const minha = ++sequenciaLeituras;
  let dados;
  try { dados = await api('api/leituras'); }
  catch (e) { dados = { erro: e.message }; }
  if (minha !== sequenciaLeituras) return;   // uma resposta mais nova já pintou
  leituras = dados;
  if (!dados.erro && !manterErro) erroLeituras = '';
  desenharAbas();
}

/** O handler do checkbox: `terminado` é o valor que o navegador ACABOU de alternar. */
async function marcarLivro(livroId, terminado) {
  livrosSalvando.set(livroId, terminado);
  desenharAbas();
  let falhou = false;
  try {
    await api('api/leituras', { method: 'POST', corpo: { livroId, terminado } });
  } catch (e) {
    falhou = true;
    erroLeituras = e.message;
  } finally {
    livrosSalvando.delete(livroId);
    await carregarLeituras({ manterErro: falhou });
  }
}

/** O handler do botão "lendo" (D61): `lendo` é o valor NOVO pretendido. */
async function marcarLendo(livroId, lendo) {
  livrosLendoSalvando.set(livroId, lendo);
  desenharAbas();
  let falhou = false;
  try {
    await api('api/leituras', { method: 'POST', corpo: { livroId, lendo } });
  } catch (e) {
    falhou = true;
    erroLeituras = e.message;
  } finally {
    livrosLendoSalvando.delete(livroId);
    await carregarLeituras({ manterErro: falhou });
  }
}

/** Busca sem diferenciar maiúscula nem acento: "Rápido" e "rapido" são a mesma coisa. */
function normalizarBusca(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}
/** S7: os três status são disjuntos — terminado ganha de lendo. */
function statusDoLivro(l) {
  if (l.terminado_em) return 'lidos';
  if (l.lendo_desde) return 'lendo';
  return 'a-ler';
}
function livroPassaNoFiltro(l, filtro) {
  if (filtro.status !== 'todos' && statusDoLivro(l) !== filtro.status) return false;
  const busca = normalizarBusca(filtro.texto);
  if (!busca) return true;
  return [l.titulo, l.original, l.autor].some((campo) => campo && normalizarBusca(campo).includes(busca));
}
/** S14: trilha salva que sumiu do catálogo vale "todas" na TELA — o valor salvo não muda. */
function trilhaEfetiva(trilhas) {
  return trilhas.some((t) => t.id === filtroLeituras.trilha) ? filtroLeituras.trilha : '';
}

/**
 * A vista "leituras" (D59): um grupo por trilha, livro na ordem do catálogo, checkbox,
 * próximo destacado. Tudo por `createElement`/`textContent` — regra do arquivo inteiro (:9):
 * o catálogo é arquivo de OUTRO projeto, texto dele é dado, nunca marcação.
 */
function grupoDeLeituras() {
  const frag = document.createDocumentFragment();

  if (erroLeituras) {
    const p = document.createElement('p');
    p.className = 'leituras-aviso';
    const mensagem = erroLeituras;
    idiomaUI.bind(p, 'textContent', () => tr`não salvou: ${mensagem}`);
    frag.append(p);
  }

  if (leituras === null) {
    const p = document.createElement('p');
    p.className = 'lista-vazia';
    idiomaUI.bind(p, 'textContent', () => tr('carregando…'));
    frag.append(p);
    return frag;
  }
  if (leituras.erro) {
    const p = document.createElement('p');
    p.className = 'leituras-aviso';
    p.textContent = leituras.erro;
    frag.append(p);
    return frag;
  }

  if (!leituras.catalogo.ok) {
    const p = document.createElement('p');
    p.className = 'lista-vazia';
    idiomaUI.bind(p, 'textContent', () => tr(leituras.catalogo.motivo === 'invalido' ? 'catálogo inválido' : 'catálogo não encontrado'));
    frag.append(p);
    const caminho = document.createElement('p');
    caminho.className = 'leituras-caminho';
    caminho.textContent = leituras.catalogo.caminho;
    frag.append(caminho);
    if (leituras.catalogo.motivo === 'invalido') {
      const detalhe = document.createElement('p');
      detalhe.className = 'leituras-caminho';
      detalhe.textContent = leituras.catalogo.detalhe;
      frag.append(detalhe);
    }
    return frag;
  }

  let bloqueado = false;
  if (leituras.progresso && !leituras.progresso.ok) {
    const p = document.createElement('p');
    p.className = 'leituras-aviso';
    const detalhe = leituras.progresso.detalhe;
    idiomaUI.bind(p, 'textContent', () => tr`progresso ilegível: ${detalhe}`);
    frag.append(p);
    bloqueado = true;
  }

  if (leituras.trilhas.length === 0) {
    const p = document.createElement('p');
    p.className = 'lista-vazia';
    idiomaUI.bind(p, 'textContent', () => tr('nenhuma trilha no catálogo'));
    frag.append(p);
    return frag;
  }

  const trilhaDoFiltro = trilhaEfetiva(leituras.trilhas);
  const buscaAtiva = normalizarBusca(filtroLeituras.texto) !== '';
  const filtroAtivo = filtroLeituras.status !== 'todos' || trilhaDoFiltro !== '' || buscaAtiva;

  // "Lendo agora" (D61, S10 + ajuste 06/10): atalho no topo da lista, ordem do catálogo, e passa
  // pelo MESMO predicado das linhas das trilhas (trilha + `livroPassaNoFiltro`) — a S9 ("não é
  // filtrado") foi revogada: com Economia escolhida, um livro de IA no topo parecia filtro quebrado.
  // Em voo vale o valor PRETENDIDO (aparece/some na hora do toque, como o `checked` do R4).
  const lendoAgora = leituras.trilhas
    .filter((t) => !trilhaDoFiltro || t.id === trilhaDoFiltro)
    .flatMap((t) => t.livros
      .filter((l) => !l.terminado_em
        && (livrosLendoSalvando.has(l.id) ? livrosLendoSalvando.get(l.id) : Boolean(l.lendo_desde))
        && livroPassaNoFiltro(l, filtroLeituras))
      .map((l) => [l, t]));
  if (lendoAgora.length) {
    const secao = document.createElement('section');
    secao.className = 'leituras-lendo-agora';
    const cabecalho = document.createElement('h2');
    cabecalho.className = 'conversa-grupo-titulo leituras-cabecalho';
    idiomaUI.bind(cabecalho, 'textContent', () => tr('Lendo agora'));
    secao.append(cabecalho);
    for (const [livro, trilha] of lendoAgora) secao.append(linhaDeLivro(livro, trilha, { bloqueado, lendoAgora: true }));
    frag.append(secao);
  }

  let desenhadas = 0;
  for (const trilha of leituras.trilhas) {
    if (trilhaDoFiltro && trilha.id !== trilhaDoFiltro) continue;
    const livros = trilha.livros.filter((l) => livroPassaNoFiltro(l, filtroLeituras));
    if (filtroAtivo && livros.length === 0) continue;   // trilha sem livro casado some
    desenhadas += 1;

    const secao = document.createElement('section');
    secao.className = 'leituras-trilha';
    secao.dataset.trilha = trilha.id;
    // Recolhida (ajuste 05/10): com busca, vale o que o toque fez DURANTE a busca (padrão aberta);
    // sem busca, a preferência salva. Status e trilha do seletor não abrem nada sozinhos.
    const aberta = buscaAtiva ? !recolhidasNaBusca.has(trilha.id) : !trilhasRecolhidas.has(trilha.id);
    if (!aberta) secao.dataset.recolhida = '1';

    const cabecalho = document.createElement('h2');
    cabecalho.className = 'conversa-grupo-titulo leituras-cabecalho';
    // O cabeçalho É o botão (botão dentro do h2, não o contrário): o leitor de tela lê o título
    // e o "expandido/recolhido" juntos, e o contador k/N continua à vista com a trilha fechada.
    const alternar = document.createElement('button');
    alternar.type = 'button';
    alternar.className = 'leituras-alternar';
    alternar.setAttribute('aria-expanded', String(aberta));
    alternar.onclick = () => alternarTrilha(trilha.id);
    const seta = document.createElement('span');
    seta.className = 'leituras-seta';
    seta.setAttribute('aria-hidden', 'true');
    seta.textContent = aberta ? '▾' : '▸';
    const tituloSpan = document.createElement('span');
    tituloSpan.className = 'leituras-trilha-titulo';
    tituloSpan.textContent = trilha.titulo;
    const contadorSpan = document.createElement('span');
    contadorSpan.className = 'leituras-contador';
    // O contador é o TOTAL do servidor — nunca recontado pelo filtro.
    contadorSpan.textContent = `${trilha.feitos}/${trilha.total}`;
    alternar.append(seta, tituloSpan, contadorSpan);
    cabecalho.append(alternar);
    secao.append(cabecalho);

    if (aberta) {
      for (const livro of livros) {
        secao.append(linhaDeLivro(livro, trilha, { bloqueado }));
      }
    }

    frag.append(secao);
  }

  // "nenhum livro" só quando NADA passou em lugar nenhum — nunca ao lado de um "Lendo agora".
  if (filtroAtivo && desenhadas === 0 && lendoAgora.length === 0) {
    const p = document.createElement('p');
    p.className = 'lista-vazia';
    idiomaUI.bind(p, 'textContent', () => tr('nenhum livro'));
    frag.append(p);
  }

  return frag;
}

/**
 * Uma linha de livro da vista "leituras" (D61). `lendoAgora` diz se esta linha é a cópia na
 * seção "Lendo agora" — o mesmo livro aparece também na trilha, então o `data-*` de papel troca
 * (`data-lendo-agora` em vez de `data-livro`, #52) e o `próximo` não é mostrado ali (em voo, o
 * livro clicado nasceria ali com o destaque de próximo, duplicando `[data-proximo]`).
 */
function linhaDeLivro(livro, trilha, { bloqueado, lendoAgora = false }) {
  const lendo = livrosLendoSalvando.has(livro.id) ? livrosLendoSalvando.get(livro.id) : Boolean(livro.lendo_desde);

  const linha = document.createElement('div');
  linha.className = 'livro';
  if (lendoAgora) linha.dataset.lendoAgora = livro.id;
  else linha.dataset.livro = livro.id;
  if (livro.terminado_em) linha.dataset.terminado = '1';
  if (!lendoAgora && livro.id === trilha.proximo) linha.dataset.proximo = '1';
  if (lendo && !livro.terminado_em) linha.dataset.lendo = '1';

  const label = document.createElement('label');
  label.className = 'livro-corpo';

  const caixa = document.createElement('input');
  caixa.type = 'checkbox';
  caixa.checked = livrosSalvando.has(livro.id) ? livrosSalvando.get(livro.id) : Boolean(livro.terminado_em);
  caixa.disabled = bloqueado || livrosSalvando.has(livro.id);
  caixa.onchange = (e) => marcarLivro(livro.id, (e?.currentTarget || caixa).checked);
  label.append(caixa);

  if (livro.n) {
    const n = document.createElement('span');
    n.className = 'livro-n';
    n.textContent = livro.n;
    label.append(n);
  }

  const texto = document.createElement('span');
  texto.className = 'livro-texto';
  const tituloLivro = document.createElement('span');
  tituloLivro.className = 'livro-titulo';
  tituloLivro.textContent = livro.titulo;
  texto.append(tituloLivro);
  if (livro.autor) {
    const autor = document.createElement('span');
    autor.className = 'livro-autor';
    autor.textContent = ` — ${livro.autor}`;
    texto.append(autor);
  }
  label.append(texto);

  // As etiquetas moram numa linha PRÓPRIA, sob o título: soltas na linha do livro elas
  // disputavam largura com ele e, na lateral de 320px, "na estante" quebrava em duas
  // linhas dentro da pílula (visto no PNG do smoke, 02/10).
  const etiquetas = document.createElement('span');
  etiquetas.className = 'livro-etiquetas';
  if (livro.opcional) {
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta etiqueta-opcional';
    idiomaUI.bind(etiqueta, 'textContent', () => tr('opcional'));
    etiquetas.append(etiqueta);
  }
  if (livro.gratis) {
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta etiqueta-gratis';
    idiomaUI.bind(etiqueta, 'textContent', () => tr('grátis'));
    etiquetas.append(etiqueta);
  }
  if (livro.na_estante) {
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta etiqueta-estante';
    idiomaUI.bind(etiqueta, 'textContent', () => tr('na estante'));
    etiquetas.append(etiqueta);
  }
  // Sem etiqueta "lendo" (ajuste 05/10): o botão "● lendo" da própria linha já diz isso — com
  // ela, o dono via "lendo" três vezes no mesmo livro.
  if (!lendoAgora && livro.id === trilha.proximo) {
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta etiqueta-proximo';
    idiomaUI.bind(etiqueta, 'textContent', () => tr('próximo'));
    etiquetas.append(etiqueta);
  }
  if (lendoAgora) {
    const etiqueta = document.createElement('span');
    etiqueta.className = 'etiqueta etiqueta-trilha';
    etiqueta.textContent = trilha.titulo;   // dado do catálogo — textContent, nunca marcação
    etiquetas.append(etiqueta);
  }
  texto.append(etiquetas);   // vazia some pelo CSS (`.livro-etiquetas:empty`)

  if (livro.terminado_em) {
    const data = document.createElement('span');
    data.className = 'livro-data';
    data.textContent = new Date(livro.terminado_em).toLocaleDateString(idiomaUI.idioma, { day: '2-digit', month: '2-digit' });
    label.append(data);
  }

  linha.append(label);

  if (!livro.terminado_em) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'livro-lendo';
    botao.setAttribute('aria-pressed', String(lendo));
    botao.disabled = bloqueado || livrosLendoSalvando.has(livro.id);
    idiomaUI.bind(botao, 'textContent', () => tr('lendo'));
    // `attr`, não `bind`: aria-label é ATRIBUTO — `bind` gravaria propriedade JS solta.
    idiomaUI.attr(botao, 'aria-label', () => (lendo ? tr`deixar de ler ${livro.titulo}` : tr`marcar ${livro.titulo} como lendo`));
    botao.onclick = () => marcarLendo(livro.id, !lendo);
    linha.append(botao);
  }

  return linha;
}

/**
 * A barra de filtro (D61). Vive FORA do `#abas` e nasce uma vez: aqui só se mostra/esconde e se
 * acertam os `aria-pressed`. O `value` da busca NUNCA é escrito na pintura — escrever durante a
 * digitação jogaria o cursor para o fim.
 */
function pintarFiltroDeLeituras() {
  const barra = $('leituras-filtro');
  const visivel = vistaDaLateral === 'leituras' && Boolean(leituras?.catalogo?.ok) && leituras.trilhas.length > 0;
  barra.hidden = !visivel;
  if (!visivel) return;

  const status = $('filtro-status');
  if (status.children.length === 0) {   // `children`/`remove` existem no navegador E no DOM falso
    idiomaUI.attr(status, 'aria-label', () => tr('filtrar por status'));
    const rotulos = { todos: 'todos', lendo: 'lendo', 'a-ler': 'a ler', lidos: 'lidos' };
    for (const s of STATUS_DE_LEITURA) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.filtroStatus = s;
      idiomaUI.bind(chip, 'textContent', () => tr(rotulos[s]));
      chip.onclick = () => { filtroLeituras.status = s; salvarFiltroLeituras(); desenharAbas(); };
      status.append(chip);
    }
  }
  for (const chip of status.children) chip.setAttribute('aria-pressed', String(chip.dataset.filtroStatus === filtroLeituras.status));

  // Sai do catálogo CRU (`leituras.trilhas`), nunca da lista filtrada: escolher "IA" não pode
  // colapsar o seletor numa opção só (painel da spec, Claude).
  const trilhaEl = $('filtro-trilha');
  const assinatura = leituras.trilhas.map((t) => `${t.id}\u0000${t.titulo}`).join('\u0001');
  if (assinatura !== assinaturaDasOpcoes) {
    assinaturaDasOpcoes = assinatura;
    while (trilhaEl.children.length) trilhaEl.children[0].remove();
    const todas = document.createElement('option');
    todas.value = '';
    idiomaUI.bind(todas, 'textContent', () => tr('todas as trilhas'));
    trilhaEl.append(todas);
    for (const t of leituras.trilhas) {
      const opcao = document.createElement('option');
      opcao.value = t.id;
      opcao.textContent = t.titulo;   // dado do catálogo — textContent, nunca marcação
      trilhaEl.append(opcao);
    }
  }
  // S14: trilha salva que sumiu do catálogo mostra "todas". Só escreve quando muda — a batida
  // de 5 s não mexe num seletor que já está certo.
  const efetiva = trilhaEfetiva(leituras.trilhas);
  if (trilhaEl.value !== efetiva) trilhaEl.value = efetiva;
}

/**
 * "agora mesmo", "há 4 min", "há 1h12".
 *
 * O tempo é metade do sinal: "editando app.js há 2 min" é trabalho, e o MESMO texto há 40
 * minutos é job pendurado. Sem ele, uma etapa congelada parece atividade.
 */
function haQuantoTempo(iso) {
  // Medido (spec §4.3): `new Date(null)` é 1º de janeiro de 1970, e a guarda de baixo (`ms <
  // 0`) não pega — o número é positivo e enorme. `haQuantoTempo(null)` devolvia "há
  // 496915h00", e existe job com `event.at: null` no disco agora.
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return tr('agora mesmo');
  if (min < 60) return tr`há ${min} min`;
  return tr`há ${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

/** O nome de um job na tela: título, senão o projeto, senão o id. Subiu de dentro de
 *  `atualizarFaixaJobs` (era `nomeDo` local) quando ganhou o segundo e o terceiro dono
 *  — `mostrarFaixa` e `linhaDaEtapa`, que vivem fora daquela função. */
function nomeDoJob(j) {
  return j.titulo || j.projeto || j.id;
}

/** Os TRÊS nós pelo MESMO caminho (`pintarRotulo`), e não um `idiomaUI.bind` na conta com
 *  `textContent` cru nos irmãos, como o `bbf90c0^` fazia. Os dois motores funcionam — o
 *  `bind` com valor vazio desregistra (`i18n.js:76`) e o `refresh` descarta registro cujo
 *  texto trocou de dono —, mas inconsistência entre irmãos é dívida sem contrapartida.
 *  `pintarRotulo` ainda evita reescrever nó que já está vazio. */
function esconderFaixa(painel) {
  painel.faixa.el.hidden = true;
  pintarRotulo(painel.faixa.conta, () => '');
  pintarRotulo(painel.faixa.titulos, () => '');
  pintarRotulo(painel.faixa.etapa, () => '');
}

/**
 * `meus` são os JOBS, não o texto pronto — achado da `/audita` (risco 🟡 "a faixa não
 * retraduz no ar"). O `bbf90c0^` passava `` `${n} ${tr('job rodando')}` `` já montado, e o
 * `idiomaUI.bind` reexecutava uma closure que devolvia a string CONGELADA no idioma de
 * quando a faixa foi pintada. É o mesmo cuidado que o comentário de `pintarRotulo`
 * (`app.js:1005`) descreve: o `calcular` tem de ler DADO, nunca uma local já traduzida.
 *
 * E os TRÊS nós vão por `pintarRotulo`, não só a conta (achado do painel, rodada 1): os
 * títulos e a etapa também carregam texto traduzido (`tr('sem sinal ainda')`, `tr('sem
 * sinal')`, e o `tr('agora mesmo')` de dentro do `haQuantoTempo`). Escrever `textContent`
 * cru neles deixaria a linha de baixo no idioma antigo até o tique seguinte — o §8 diz que
 * este defeito foi corrigido, e "corrigido pela metade" seria o §8 mentindo. `pintarRotulo`
 * ainda dá de graça o "só escreve quando o texto MUDA", que é o que segura o `aria-live`
 * da conta.
 *
 * As closures capturam a local `meus`, e o contrato de `pintarRotulo` diz "lê o estado de
 * módulo (não locais)" — o painel (rodada 2) apontou que isto ESTREITA o contrato original, e
 * é verdade. A diferença que importa: o que aquele contrato proíbe é capturar TEXTO já
 * traduzido, que congela o idioma para sempre. `meus` é DADO, e a closure refaz o texto a
 * cada `refresh()` do i18n — o pior caso é um retrato de ≤15 s (o tique), não uma string
 * eterna. Amarrar ao módulo exigiria um segundo dono do "quais são os meus jobs" por painel,
 * que é justamente o que o §4.3 evita.
 */
function mostrarFaixa(painel, meus) {
  // 🔴 `hidden = false` PRIMEIRO (achado do painel, rodada 2). Região `aria-live` dentro de
  // subárvore `hidden` não anuncia, e torná-la visível também não — pintar antes de revelar
  // deixaria MUDO justamente o caso que o `aria-live` existe para dar: nasceu job onde não
  // havia nenhum. Revelar primeiro e escrever depois é o que faz a escrita virar notícia.
  painel.faixa.el.hidden = false;
  pintarRotulo(painel.faixa.conta,
    () => `${meus.length} ${meus.length === 1 ? tr('job rodando') : tr('jobs rodando')}`);
  pintarRotulo(painel.faixa.titulos, () => meus.map(nomeDoJob).join(', '));
  pintarRotulo(painel.faixa.etapa, () => linhaDaEtapa(meus));
}

/** A linha de baixo da faixa. Com vários jobs, cada etapa precisa dizer de quem é. */
function linhaDaEtapa(vivos) {
  if (vivos.length === 1) {
    const [j] = vivos;
    return [j.etapa || tr('sem sinal ainda'), haQuantoTempo(j.desde)].filter(Boolean).join(' · ');
  }
  return vivos.map((j) => `${nomeDoJob(j)}: ${j.etapa || tr('sem sinal')}`).join(' · ');
}

/**
 * A faixa DESTE painel, pintada a partir da última leitura de jobs. Lê `jobsRodando` (estado
 * de módulo) em vez de receber a lista: assim `criarPainel` a chama sem pedir rede, e os três
 * caminhos de abrir painel (`abrirAba`, `trocarConjunto`, `abrirJob`) ficam cobertos por um
 * dono só. Dois donos do desenho seriam duas verdades sobre a mesma tela.
 *
 * R9/P4: a faixa é do PAINEL, não da conversa focada — com N painéis, cada um mostra os jobs
 * do PRÓPRIO projeto. Quem casou job com aba foi o SERVIDOR (`abas.abasDoProjeto`), então
 * aqui só se compara CHAVE com CHAVE: nunca `projeto` cru (o meta.json diz "Loja Exemplo", a
 * pasta diz "loja-exemplo" — a nota do card).
 *
 * Painel de JOB (`tipo: 'job'`, chave `job-<id>`) nunca casa: `j.abas` só traz `aba-N`. É por
 * construção, e é por isso que NÃO há guarda `tipo === 'job'` aqui — uma condição que outra
 * regra já torna inalcançável é a armadilha #30.
 */
function pintarFaixaDe(painel) {
  const meus = jobsRodando.filter((j) => (j.abas || []).includes(painel.chave));
  if (!meus.length) return esconderFaixa(painel);
  return mostrarFaixa(painel, meus);
}

/**
 * Sem notícia de quem sabe. Some da tela e NÃO mexe na última leitura: um job só "termina"
 * quando o painel diz que ele saiu de rodando. Ficar sem resposta é ignorância, não fim —
 * tratar os dois igual faria a rede caindo anunciar um término que nunca houve.
 */
function semNoticiaDosJobs() {
  // A bolinha na lista some junto: sem notícia, ela seria uma afirmação sem fonte. O mesmo
  // vale pro terceiro pedaço do resumo (M3/P4) — sem notícia é ignorância, não "zero jobs".
  jobsPorAba = new Map();
  jobsRodando = [];
  // O grupo de jobs também é notícia ruim: `painel: false` acende a linha "não deu para
  // falar com o painel" em vez de o grupo simplesmente desaparecer (§4.6) — silêncio seria
  // mentira, ele diria a mesma coisa que "não há nada rodando".
  jobsDaLista = [];
  painelDosJobs = false;
  for (const painel of paineis.values()) esconderFaixa(painel);
  desenharAbas();
}

/**
 * A faixa de jobs é do PAINEL, não da conversa focada (R9 da spec): com N painéis na tela,
 * cada um mostra os jobs do PRÓPRIO projeto — quem vigia três agentes precisa ver os
 * três, não só o que está com o teclado.
 */
async function atualizarFaixaJobs() {
  // §4.7: guarda de sequência. Uma leitura lenta que aterrissa depois de uma mais nova não
  // pode escrever estado nenhum — nem sucesso, nem "sem notícia". `semNoticiaDosJobs()` não
  // sabe de sequência; quem decide é sempre quem a chama, aqui.
  const minha = ++sequenciaJobs;
  let dados;
  try {
    dados = await api('api/jobs?tudo=1');
  } catch {
    if (minha !== sequenciaJobs) return;
    return semNoticiaDosJobs();
  }
  if (minha !== sequenciaJobs) return;
  // `painel: false` é o cockpit avisando que não conseguiu falar com o painel — bem
  // diferente de "não há nada rodando". Nada disso vira erro na tela: a faixa só some.
  if (dados.painel === false) return semNoticiaDosJobs();
  jobsDaLista = dados.jobs || [];
  painelDosJobs = dados.painel !== false;
  // A faixa continua igual: só os `running`, e é o que ela sempre mostrou.
  const jobs = (dados.jobs || []).filter((j) => j.estado === 'running');
  // D76: um id que estava `running` na última leitura boa e não está nesta terminou — ou sumiu
  // da janela do fim feliz enquanto a página não lia (o celular que volta do bolso). Quem
  // decide se ele entra no Pra revisar é o servidor; aqui só se avisa que vale reler.
  const idsAgora = new Set(jobs.map((j) => j.id));
  const algumTerminou = idsRodandoNaUltimaLeitura !== null
    && [...idsRodandoNaUltimaLeitura].some((id) => !idsAgora.has(id));
  idsRodandoNaUltimaLeitura = idsAgora;

  // A LISTA usa isto: a bolinha na linha de cada aba cujo projeto tem job rodando. Quem
  // casou job com aba foi o servidor — daqui só vem a chave, nunca o caminho da worktree.
  jobsPorAba = new Map();
  // O terceiro pedaço do resumo de relance (M3/P4): só os jobs `running` desta leitura.
  jobsRodando = jobs;
  for (const j of jobs) {
    for (const chave of j.abas || []) {
      if (!jobsPorAba.has(chave)) jobsPorAba.set(chave, []);
      jobsPorAba.get(chave).push(nomeDoJob(j));
    }
  }
  desenharAbas();
  pintarResumoVazio();
  for (const painel of paineis.values()) pintarFaixaDe(painel);
  // Por último: nada do que o tique já desenhava depende disto. O `revisar.js` carrega depois
  // e pode não existir (página sem o dialog, gate que só carrega o app.js) — por isso a checagem.
  const revisar = globalThis.cockpitRevisar;
  if (algumTerminou && revisar && typeof revisar.aoTerminarJob === 'function') revisar.aoTerminarJob();
}

// Pino, `data-estado` e rótulo por estado do job (spec §4.3/§4.4). Estado fora dos sete não
// tem entrada aqui de propósito: o fallback (`|| ...`) é a allowlist vista do outro lado —
// não dá para saber se um estado inventado é bom ou ruim, e inventar uma cor seria mentir.
const PINOS_DE_JOB = { running: '●', blocked: '◆', orfao: '◆', done: '✓', merged: '✓', teardown: '✓', failed: '✕' };
const DATA_ESTADO_DE_JOB = {
  running: 'trabalhando', blocked: 'bloqueado', orfao: 'bloqueado',
  done: 'pronta', merged: 'pronta', teardown: 'pronta', failed: 'interrompida',
};
const ROTULOS_DE_JOB = {
  running: 'rodando', blocked: 'bloqueado', orfao: 'órfão',
  done: 'terminou', merged: 'mergeado', teardown: 'encerrado', failed: 'falhou',
};

/**
 * O tempo mostrado na linha de um job — estado por estado (spec §4.3, "a guarda que
 * faltava"). `running`/`orfao` mostram a IDADE do job (`desde`): o `status.log` não escreve
 * nada entre o nascimento e o fim (§3.1 da spec), então o `fim` de um órfão é a hora em que
 * ele NASCEU, não a hora em que morreu — dizer "travado há Xh" inventaria o instante da
 * morte. `blocked` é diferente: o evento terminal foi escrito no momento do bloqueio, e o
 * `fim` é honesto — cai no `desde` só se faltar (job sem `event.at` legível).
 */
function tempoDoJob(j) {
  if (j.estado === 'running' || j.estado === 'orfao') return haQuantoTempo(j.desde);
  if (j.estado === 'blocked') return haQuantoTempo(j.fim) || haQuantoTempo(j.desde);
  return haQuantoTempo(j.fim);
}

/**
 * A linha de UM job, na mesma marcação da linha de conversa (`.conversa-linha` >
 * `.conversa` > `.conversa-titulo` + `.conversa-rodape`) — é o wrapper `.conversa-titulo`
 * que dá alvo ao negrito do bloqueado no CSS (§4.4); montar sem ele deixaria o negrito sem
 * onde pintar, sem nenhum assert pegar.
 *
 * O clique abre o PRÓPRIO job (`abrirJob`, card `ver-a-conversa-do-job`) — não mais a aba do
 * projeto no terminal. Isso tira a dependência de `j.abas`/`vivas` que existia aqui: o job
 * sempre tem destino, com aba viva ou sem (§6.3 da spec — melhoria real, sem custo de decisão).
 */
function linhaDeJob(j) {
  const linha = document.createElement('div');
  linha.className = 'conversa-linha';
  linha.dataset.estado = DATA_ESTADO_DE_JOB[j.estado] || 'desconhecido';
  // O mesmo feedback que a lista de conversas já dá — uma linha (§4.3 do plano).
  if (paineis.has(`job-${j.id}`)) linha.dataset.aberta = '';

  // Clicável SEMPRE: o job agora tem destino PRÓPRIO (abrirJob), e não depende mais de haver
  // uma aba viva do mesmo projeto no terminal. Cai a dependência de `vivas` (§6.3 da spec).
  const alvo = document.createElement('button');
  alvo.className = 'conversa';
  // O tipo saiu do lugar de destaque e vem para cá: no desktop ele continua alcançável, e
  // no celular ninguém sente falta — "ataca" ou "ship" nunca foi o que diferencia um job.
  alvo.title = [j.tipo, j.titulo].filter(Boolean).join(' · ');
  alvo.onclick = () => {
    // O clique FANTASMA (§4.5): mesmo container (`#abas`), mesmo gesto de puxar para
    // atualizar, mesma guarda das linhas de conversa.
    if (Date.now() < toqueBloqueadoAte) return;
    abrirJob(j.id);
  };

  const titulo = document.createElement('div');
  titulo.className = 'conversa-titulo';
  const pino = document.createElement('span');
  pino.className = 'conversa-pino';
  pino.textContent = `${PINOS_DE_JOB[j.estado] || '•'} `;
  const nome = document.createElement('span');
  nome.className = 'conversa-nome';
  // O TÍTULO, não o tipo. Até 09/09 esta linha era `j.tipo`, e o resultado é que a lista
  // inteira dizia "ataca" — nove linhas com o mesmo nome, e não dava para achar job nenhum
  // na lista. O título só existia no `title=`, que é tooltip e no celular não existe.
  // O tipo continua no fallback: job antigo, criado antes do `orquestrador` aprender a
  // derivar título, pode não ter nenhum, e linha sem nome é pior que linha com nome feio.
  nome.textContent = j.titulo || j.tipo || '';
  titulo.append(pino, nome);

  const rodape = document.createElement('div');
  rodape.className = 'conversa-rodape';
  const estado = document.createElement('span');
  estado.className = 'conversa-estado';
  const rotulo = ROTULOS_DE_JOB[j.estado] || j.estado;
  idiomaUI.bind(estado, 'textContent', () => tr([`${tr(rotulo)} · ${j.projeto || ''}`, tempoDoJob(j)].filter(Boolean).join(' · ')));
  rodape.append(estado);

  alvo.append(titulo, rodape);

  // Só o bloqueado ganha o motivo, e é por construção: o órfão nunca tem `desfecho` (seu
  // último evento é sempre `working`, fora da allowlist do servidor), então este ramo nunca
  // dispara para ele. O motivo NÃO fica no `title` (#31) — é o único estado em que o usuário
  // precisa AGIR, e a frase que diz o que fazer ficaria inalcançável no celular.
  //
  // 🔴 Dentro do `.conversa` (`alvo`), NUNCA irmão dele em `.conversa-linha`: `.conversa-linha`
  // é `display: flex` (estilo.css) e um item flex a mais ali espreme o `.conversa` até ele
  // quebrar palavra (e, com nome curto, letra) no meio — família da armadilha #43 (item flex
  // sem `min-width: 0` num container flex). Medido: com o motivo como irmão, "ataca-bloqueado"
  // saía quebrado verticalmente e o texto do motivo vazava para fora da linha.
  if (j.estado === 'blocked' && j.desfecho) {
    const motivo = document.createElement('div');
    motivo.className = 'conversa-estado';
    motivo.textContent = j.desfecho;
    alvo.append(motivo);
  }

  linha.append(alvo);
  return linha;
}

/**
 * O clique da faixa leva à VISTA DE AGENTES — o mesmo destino do clique na `#barra-agentes`
 * (`:5485`). O destino de ontem (rolar até o grupo dentro da lista de conversas) morreu com
 * a D51: `#abas` mostra uma vista OU a outra.
 *
 * As duas guardas são ALCANÇÁVEIS daqui, ao contrário do que vale para a barra (que só é
 * clicável com a lateral já à vista — ver o comentário em `:5482`): a faixa vive no
 * CABEÇALHO do painel, e dali o usuário alcança o clique com a lateral fechada pelo ☰ (o
 * desktop) e com a lista fora da tela (o celular). Não é guarda para estado inalcançável
 * (armadilha #30) — é o caso normal deste botão.
 */
function verOsAgentes() {
  if (vistaDaLateral !== 'agentes') trocarVistaDaLateral('agentes');
  if (app.dataset.lateral === 'fechada') aplicarLateral(false);   // desktop: lateral escondida pelo ☰
  // Sem `if (app.dataset.vista === 'chat')` em volta: `pedirLista()` JÁ faz esse teste
  // (`app.js:5445-5447`). O `bbf90c0^` duplicava a guarda; repeti-la num documento que
  // recusa guarda inalcançável pela #30 seria incoerente. `pedirLista()` na lista é no-op.
  pedirLista();                                                   // celular: history.back() → popstate
}

/**
 * O grupo JOBS da lista lateral (desenho C, spec 2026-09-08). Devolve `null` quando não há
 * nada a mostrar: `painelDosJobs === null` é ignorância (ainda não li) e `jobsDaLista` vazio
 * com painel vivo é "nada na janela" — os dois casos em que o grupo simplesmente não existe
 * (§4.6). Silêncio só é seguro nesses dois; `painel: false` é notícia RUIM e precisa da linha
 * de aviso, nunca de silêncio (que mentiria "nada rodando").
 */
function grupoDeJobs() {
  if (painelDosJobs === null) return null;
  const semContato = painelDosJobs === false;
  if (!semContato && jobsDaLista.length === 0) return null;

  const secao = document.createElement('section');
  secao.id = 'grupo-jobs';
  secao.className = 'conversa-grupo';   // SEM data-cwd — a âncora do R1

  const conteudo = document.createElement('div');
  conteudo.className = 'projeto-conteudo';
  secao.append(conteudo);

  if (semContato) {
    const p = document.createElement('p');
    p.className = 'lista-vazia';
    // "painel" era o serviço externo que respondia por esta lista até 2026-09-10. Quem lê os
    // jobs agora é o próprio servidor, direto do disco (D43) — falar em painel aqui mandaria
    // quem visse a mensagem procurar um processo que não existe mais. A string é literal em
    // `testes/gate-ui.js` (G5) e em `testes/print-celular-jobs.mjs`: mudá-la aqui sem mudar
    // lá deixa `npm test` vermelho.
    idiomaUI.bind(p, 'textContent', () => tr('não deu para ler os jobs'));
    conteudo.append(p);
    return secao;
  }

  for (const j of jobsDaLista) conteudo.append(linhaDeJob(j));
  return secao;
}

// A leitura mora no servidor desde 14/09 (D53). A chave velha fica no aparelho para sempre se
// ninguém a remover — e um dia alguém a lê achando que vale. Some no primeiro boot depois do
// deploy; o `try` é o modo privado do Safari, onde `localStorage` LANÇA em vez de falhar.
// Não é migração (P2): remove sem ler.
try { localStorage.removeItem('cockpit-lidas'); } catch { /* sem armazenamento: nada a apagar */ }
// D63: ordem e recolhimento por projeto deixaram de existir. A chave fica no aparelho para sempre
// se ninguém a remover. Mesmo tratamento da `cockpit-lidas`: remove sem ler, sem migrar.
try { localStorage.removeItem('cockpit-projetos'); } catch { /* sem armazenamento: nada a apagar */ }

carregarAbas().then(abrirPeloEndereco).catch(() => { /* pedirToken já avisou */ });
atualizarFaixaJobs();

// ── O relógio da lista ────────────────────────────────────────
//
// A lista acompanha o terminal sozinha: aba aberta ou fechada lá aparece aqui na próxima
// batida. É por isso que o cockpit não precisa de botão para abrir nem para fechar. Desde
// 22/08 a batida é de 5s: `/api/abas` responde em 14 ms e 2,2 KB, então o estado da lista
// custa quase nada para chegar mais cedo.
//
// A faixa de jobs NÃO acompanha esse ritmo: até 2026-09-10 ela batia num painel externo por
// HTTP; hoje `/api/jobs` varre a pasta de jobs no disco (readdir + `tmux ls` + a cauda do
// `claude.log` de cada `running`), leitura bem mais cara que a de `/api/abas`. Por isso
// continua saindo a cada 15s, ou seja, em 1 de cada 3 batidas. Quem dá os dois ritmos é o
// contador, NÃO um segundo setInterval — a tela já teve o problema de dois relógios
// discordando entre si.
const MS_LISTA = 5000;
const BATIDAS_POR_JOBS = 3;
let relogioDaLista = null;
let batida = 0;

function tiqueDaLista() {
  carregarAbas();
  // Mesmo ciclo, sem relógio novo: com a pergunta aberta, a tela do terminal reflete o que
  // mudou lá. Fora de `waiting` isto sai na primeira linha e não pede nada.
  atualizarTelaDaPane(paineis.get(atual));
  batida += 1;
  if (batida < BATIDAS_POR_JOBS) return;
  batida = 0;
  atualizarFaixaJobs();
}

/** Liga o relógio do zero. Nunca deixa dois de pé: o anterior morre antes de nascer o novo. */
function ligarRelogioDaLista() {
  clearInterval(relogioDaLista);
  batida = 0;
  relogioDaLista = setInterval(tiqueDaLista, MS_LISTA);
}

function pausarRelogioDaLista() {
  clearInterval(relogioDaLista);
  relogioDaLista = null;
}

ligarRelogioDaLista();

/**
 * O caso que mais incomoda no celular: desbloquear o aparelho e olhar para um estado velho.
 * Voltando para a frente, lista e faixa saem NA HORA — sem esperar o próximo tique — e a
 * contagem recomeça do zero. Escondido, o relógio para: celular no bolso não precisa bater
 * no servidor a cada 5s.
 *
 * O EventSource da conversa aberta não é tocado aqui. Ele é empurrado pelo servidor, não
 * puxado daqui, e derrubá-lo custaria o histórico inteiro na volta.
 *
 * A guarda do relógio já de pé é o que segura aparelho que dispara `visibilitychange` várias
 * vezes seguidas: sem ela, cada disparo repetiria a rajada de requisições da volta.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return pausarRelogioDaLista();
  if (relogioDaLista) return;
  ligarRelogioDaLista();
  carregarAbas();
  atualizarFaixaJobs();
  atualizarTelaDaPane(paineis.get(atual));
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(pintarBotaoAvisos).catch((erro) => {
    erroDoServiceWorker = erro;
    pintarBotaoAvisos();
  });
}

// A notificação abre o cockpit em `#c=<id>`: entra direto na conversa que chamou.
function abrirPeloEndereco({ jaEmpilhou = false } = {}) {
  const casou = location.hash.match(/^#c=([\w-]+)$/);
  if (!casou) return false;
  history.replaceState(null, '', location.pathname + location.search);
  // Com o app JÁ ABERTO, o service worker chama `janela.navigate('#c=…')` (public/sw.js) e
  // o próprio navegador empilha uma entrada pela troca de hash — o `replaceState` acima
  // limpa a URL dela, mas a entrada continua na pilha. Empilhar OUTRA aqui daria ao voltar
  // do aparelho um degrau que não leva a lugar nenhum: o primeiro toque devolveria a lista
  // e o segundo, em vez de sair do app, cairia nesse fantasma. A entrada do hash já é a
  // entrada da conversa; `abrirAba` só não pode empilhar de novo em cima dela.
  pulaProximoEmpilhar = jaEmpilhou;
  abrirAba(casou[1]);
  return true;
}
window.addEventListener('hashchange', () => abrirPeloEndereco({ jaEmpilhou: true }));

// A escolha afeta só este navegador. Nenhum reload, reconexão ou alteração do composer.
function configurarIdioma() {
  const seletor = $('sel-idioma');
  const valor = $('idioma-valor');
  if (!seletor || !valor) return;
  seletor.value = idiomaUI.idioma;
  valor.textContent = idiomaUI.idioma === 'en' ? 'English' : 'Português';
  seletor.onchange = () => {
    if (!idiomaUI.definir(seletor.value)) return;
    valor.textContent = idiomaUI.idioma === 'en' ? 'English' : 'Português';
    desenharAbas();
    dicaComDedo = null;
    pintarDica();
  };
}
configurarIdioma();
