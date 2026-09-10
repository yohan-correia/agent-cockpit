'use strict';
// Cliente de "Para onde vão meus tokens" — desde 04/09 vive DENTRO do index.html, como o
// miolo do <dialog id="dialogo-uso"> (spec 2026-09-04, P1/P2). A camada de desenho abaixo
// é a mesma de quando isto era página solta: reaproveitada byte a byte, só embrulhada numa
// IIFE — dois <script> clássicos declarando o MESMO `const $`/`const token` no escopo
// global é `SyntaxError: Identifier already declared`, e quem morreria era o app.js inteiro
// (R1). A IIFE isola os dois nomes; só `globalThis.telaUso` atravessa a fronteira.
//
// Regra que vale para o arquivo inteiro, a mesma de app.js: NADA de innerHTML. O `rotulo`
// de cada origem vem do meta.json do orquestrador — texto livre que este arquivo não escreveu — e
// entra sempre por textContent (armadilha #26).
(function () {


const idiomaUI = globalThis.cockpitI18n;
const tr = (...args) => idiomaUI.t(...args);

const $ = (id) => document.getElementById(id);

// ── token (P3-b): lido A CADA CHAMADA, nunca uma vez no carregamento ──
//
// Dentro do index.html quem extrai o `?token=…` da URL e grava no localStorage é o app.js,
// síncrono no topo dele. No PRIMEIRO acesso por link — como o usuário abre o cockpit num
// aparelho novo — um `const token` lido aqui, na hora do parse deste <script>, capturaria
// '' para sempre (mesmo com o app.js declarado ANTES no HTML, a ordem de execução dos dois
// <script> é irrelevante se o valor for congelado uma vez). A correção é não congelar nunca.
const tokenAgora = () => { try { return localStorage.getItem('cockpit-token') || ''; } catch { return ''; } };

async function api(rota) {
  const cabecalhos = {};
  const token = tokenAgora();
  if (token) cabecalhos.authorization = `Bearer ${token}`;
  const resposta = await fetch(rota, { headers: cabecalhos });
  if (resposta.status === 401) {
    const erro = new Error(tr('sem token'));
    erro.semToken = true;
    throw erro;
  }
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return resposta.json();
}

/** `112345678` → "112,3M"; `1005` → "1.005"; abaixo de mil, o número cheio. */
function curto(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toLocaleString(idiomaUI.idioma, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
  if (abs >= 1e3) return `${(v / 1e3).toLocaleString(idiomaUI.idioma, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
  return v.toLocaleString(idiomaUI.idioma);
}

/** '2026-09-04' → '04/09'. Sem `new Date()`: o servidor já manda o dia UTC pronto (§2.1). */
function dataBR(iso) {
  const partes = String(iso || '').split('-');
  return partes.length === 3 ? (idiomaUI.idioma === 'en' ? `${partes[1]}/${partes[2]}` : `${partes[2]}/${partes[1]}`) : String(iso || '');
}

/** "Hoje · 04/09 (UTC)" / "7 dias · 29/08–04/09 (UTC)" — a tela ESCREVE a data (§2.1). */
function rotuloPeriodo(dados) {
  if (dados.dias === 1) return tr`Hoje · ${dataBR(dados.ate)} (UTC)`;
  const nome = dados.dias === 30 ? tr('30 dias') : tr('7 dias');
  return `${nome} · ${dataBR(dados.desde)}–${dataBR(dados.ate)} (UTC)`;
}

function somaTotal(t) {
  return (t && (t.entrada + t.saida + t.cacheEscrita + t.cacheLeitura)) || 0;
}

/**
 * `348.9` → "US$ 348,90". A moeda é DÓLAR, não real: a tabela da Anthropic é em dólar e o
 * cockpit não tem cotação de câmbio — inventar uma taxa seria o mesmo pecado de chutar preço.
 *
 * Duas regras que existem para o número não mentir:
 * - qualquer valor acima de zero que arredondaria para `US$ 0,00` vira `< US$ 0,01`. Um projeto
 *   com 300 tokens de Haiku custa US$ 0,0003, e `US$ 0,00` na tela é visualmente idêntico a
 *   "não sei o preço deste modelo" — que é outra coisa, e tem texto próprio.
 * - `conhecido === false` ganha o prefixo `~`: o valor é a soma só dos modelos COM preço, um
 *   piso. Sem a marca, um projeto que rodou 90% num modelo desconhecido mostraria um custo
 *   baixo com cara de exato.
 */
function dinheiro(usd, conhecido) {
  const v = Number(usd) || 0;
  const prefixo = conhecido === false ? '~' : '';
  if (v > 0 && v < 0.005) return tr`${prefixo}< US$ 0,01`;
  return `${prefixo}US$ ${v.toLocaleString(idiomaUI.idioma, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** O cartão de custo do topo: o valor, a linha fixa de que é ESTIMATIVA, e os avisos do que
 * foi assumido. Sem a linha da estimativa o número mente — o usuário paga assinatura, não por
 * token, e nenhum destes dólares saiu do bolso dele. */
function nodeCusto(dados) {
  const custo = dados.custo || { usd: 0, conhecido: true, tokensSemPreco: 0, cacheSemDuracao: 0 };
  const caixa = document.createElement('div');
  caixa.className = 'uso-custo-caixa';

  const rotulo = document.createElement('span');
  rotulo.className = 'uso-custo-rotulo';
  idiomaUI.bind(rotulo, 'textContent', () => tr('Custo estimado'));

  const valor = document.createElement('b');
  valor.className = 'uso-custo-valor';
  idiomaUI.bind(valor, 'textContent', () => tr(dinheiro(custo.usd, custo.conhecido)));

  const nota = document.createElement('p');
  nota.className = 'uso-custo-nota';
  const quando = (dados.precos && dados.precos.consultadoEm) ? tr` Preços de ${dataBR(dados.precos.consultadoEm)}.` : '';
  idiomaUI.bind(nota, 'textContent', () => tr(tr('estimativa do que estes tokens custariam na API avulsa, por token. ')
    + tr`Você paga assinatura — esta não é a sua conta.${quando}`));

  caixa.append(rotulo, valor, nota);

  if (custo.tokensSemPreco > 0) {
    const p = document.createElement('p');
    p.className = 'uso-custo-aviso';
    idiomaUI.bind(p, 'textContent', () => tr`${curto(custo.tokensSemPreco)} tokens ficaram de fora: modelo sem preço conhecido.`);
    caixa.append(p);
  }
  if (custo.cacheSemDuracao > 0) {
    const p = document.createElement('p');
    p.className = 'uso-custo-aviso';
    idiomaUI.bind(p, 'textContent', () => tr`${curto(custo.cacheSemDuracao)} tokens de escrita de cache vieram sem a duração — cobrados como 5 min.`);
    caixa.append(p);
  }
  return caixa;
}

/**
 * Uma linha das seções "Por modelo" / "Por dia".
 *
 * As classes são `.uso-linha*`, NUNCA `.uso-item*`: o smoke conta `.uso-item` com um
 * `querySelectorAll` global, e reusar a classe faria estas linhas serem contadas como
 * projetos. `.uso-item-barra` é a exceção segura — essa só é buscada DENTRO de um `.uso-item`.
 */
function nodeLinha(nome, total, custo, maior) {
  const pct = maior > 0 ? (somaTotal(total) / maior) * 100 : 0;
  const linha = document.createElement('div');
  linha.className = 'uso-linha';

  const topo = document.createElement('div');
  topo.className = 'uso-linha-topo';
  const spanNome = document.createElement('span');
  spanNome.className = 'uso-linha-nome';
  spanNome.textContent = nome;
  const direita = document.createElement('span');
  direita.className = 'uso-linha-valor';
  const tokens = document.createElement('b');
  idiomaUI.bind(tokens, 'textContent', () => tr(curto(somaTotal(total))));
  direita.append(tokens);
  // `conhecido:false` COM `usd` zerado é o modelo que não tem preço nenhum — escreve o texto,
  // nunca um `US$ 0,00` que se confundiria com "custou quase nada". `conhecido:false` com
  // `usd > 0` é um agrupamento (um dia) que mistura modelos com e sem preço: aí o valor é um
  // piso e o `~` de `dinheiro()` já diz isso.
  if (custo && custo.conhecido === false && !(custo.usd > 0)) {
    const sem = document.createElement('span');
    sem.className = 'uso-linha-sem-preco';
    idiomaUI.bind(sem, 'textContent', () => tr('sem preço conhecido'));
    direita.append(sem);
  } else if (custo) {
    const dinheiroTxt = document.createElement('span');
    dinheiroTxt.className = 'uso-linha-custo';
    idiomaUI.bind(dinheiroTxt, 'textContent', () => tr(dinheiro(custo.usd, custo.conhecido)));
    direita.append(dinheiroTxt);
  }
  topo.append(spanNome, direita);

  // O detalhe cache/entrada/saída que a spec pede sob cada linha. NÃO reusa `linhaTotal()`:
  // aquela monta `.uso-item-numeros`, classe que R1 proíbe fora do ranking porque o smoke a
  // conta com um seletor global. Mesma informação, classe própria.
  const numeros = document.createElement('div');
  numeros.className = 'uso-linha-numeros';
  for (const [rotulo, valor] of [['cache', total.cacheLeitura], ['entrada', total.entrada], [tr('saída'), total.saida]]) {
    const span = document.createElement('span');
    idiomaUI.bind(span, 'textContent', () => tr(`${tr(rotulo)} ${curto(valor)}`));
    numeros.append(span);
  }

  const barra = document.createElement('div');
  barra.className = 'uso-item-barra';
  const cheio = document.createElement('i');
  cheio.style.width = `${Math.max(pct > 0 ? 1 : 0, Math.min(100, pct))}%`;
  barra.append(cheio);

  linha.append(topo, numeros, barra);
  return linha;
}

/** Monta uma seção inteira ("Por modelo" / "Por dia") no contêiner dela, ou a esvazia. */
function desenharSecao(idContainer, titulo, itens) {
  const alvo = $(idContainer);
  idiomaUI.bind(alvo, 'textContent', () => tr(''));
  if (!Array.isArray(itens) || !itens.length) return;
  const h2 = document.createElement('h2');
  idiomaUI.bind(h2, 'textContent', () => tr(titulo));
  alvo.append(h2);
  const maior = itens.reduce((m, i) => Math.max(m, somaTotal(i.total)), 0);
  for (const item of itens) {
    // `dia` vira "04/09"; `modelo` entra como veio (id do CLI, texto que este arquivo não
    // escreveu — sempre por textContent, armadilha #26).
    alvo.append(nodeLinha(item.dia ? dataBR(item.dia) : item.modelo, item.total, item.custo, maior));
  }
}

function linhaTotal(total) {
  const linha = document.createElement('div');
  linha.className = 'uso-item-numeros';
  const cache = document.createElement('span');
  idiomaUI.bind(cache, 'textContent', () => tr(`cache ${curto(total.cacheLeitura)}`));
  const entrada = document.createElement('span');
  idiomaUI.bind(entrada, 'textContent', () => tr`entrada ${curto(total.entrada)}`);
  const saida = document.createElement('span');
  idiomaUI.bind(saida, 'textContent', () => tr`saída ${curto(total.saida)}`);
  linha.append(cache, entrada, saida);
  return linha;
}

/** Uma linha de origem (aba ou job), dentro do `<details>` do projeto. */
function nodeOrigem(origem) {
  const li = document.createElement('div');
  li.className = 'uso-origem';
  const nome = document.createElement('span');
  nome.className = 'uso-origem-nome';
  nome.textContent = origem.rotulo;   // texto livre do meta.json — SEMPRE textContent (#26)
  const total = document.createElement('span');
  total.className = 'uso-origem-total';
  idiomaUI.bind(total, 'textContent', () => tr(curto(somaTotal(origem.total))));
  li.append(nome, total);
  return li;
}

/** Uma linha de projeto, com `<details>` para as origens. */
function nodeProjeto(projeto, totalGeral) {
  const total = somaTotal(projeto.total);
  const pct = totalGeral > 0 ? (total / totalGeral) * 100 : 0;

  const item = document.createElement('div');
  item.className = 'uso-item';

  const topo = document.createElement('div');
  topo.className = 'uso-item-topo';
  const nome = document.createElement('span');
  nome.className = 'uso-item-nome';
  nome.textContent = projeto.projeto;
  const direita = document.createElement('span');
  direita.className = 'uso-item-direita';
  const totalTxt = document.createElement('b');
  idiomaUI.bind(totalTxt, 'textContent', () => tr(curto(total)));
  const pctTxt = document.createElement('span');
  pctTxt.className = 'uso-item-pct';
  idiomaUI.bind(pctTxt, 'textContent', () => tr(`${pct.toLocaleString(idiomaUI.idioma, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`));
  direita.append(totalTxt, pctTxt);
  if (projeto.custo) {
    const custoTxt = document.createElement('span');
    custoTxt.className = 'uso-item-custo';
    idiomaUI.bind(custoTxt, 'textContent', () => tr(dinheiro(projeto.custo.usd, projeto.custo.conhecido)));
    direita.append(custoTxt);
  }
  topo.append(nome, direita);

  const barra = document.createElement('div');
  barra.className = 'uso-item-barra';
  const cheio = document.createElement('i');
  cheio.style.width = `${Math.max(pct > 0 ? 1 : 0, Math.min(100, pct))}%`;
  barra.append(cheio);

  const modelos = document.createElement('div');
  modelos.className = 'uso-item-modelos';
  // A linha que era só NOMES ("claude-opus-5 · claude-fable-5-1") passa a trazer o QUANTO de
  // cada um — é a pergunta da fase 1 do card ("o Fable comeu meu limite?") na forma mínima:
  // mesmo lugar, mesma linha, agora com o número.
  modelos.textContent = (projeto.porModelo || [])
    .map((m) => `${m.modelo} ${curto(somaTotal(m.total))}`)
    .join(' · ');

  item.append(topo, linhaTotal(projeto.total), barra, modelos);

  if (Array.isArray(projeto.origens) && projeto.origens.length) {
    const detalhes = document.createElement('details');
    detalhes.className = 'uso-origens';
    const resumo = document.createElement('summary');
    // "origem" → "origens": o plural troca o **m** por **ns**, não acrescenta "ns" no fim.
    // Escrito como duas palavras inteiras de propósito — a versão com sufixo produzia
    // "origemns" na tela, e o smoke passou verde porque nenhum assert olhava esta string.
    // Foi o PNG que pegou (a regra da casa desde 25/08: olhar o print, não só o veredito).
    idiomaUI.bind(resumo, 'textContent', () => tr(`${projeto.origens.length} ${projeto.origens.length === 1 ? tr('origem') : tr('origens')}`));
    detalhes.append(resumo);
    for (const origem of projeto.origens) detalhes.append(nodeOrigem(origem));
    item.append(detalhes);
  }

  return item;
}

/** Os 3 avisos — só aparecem quando o problema que descrevem é > 0 (P do card, §3.1.2/§3.1.5). */
function desenharAvisos(leitura) {
  const rodape = $('uso-rodape');
  idiomaUI.bind(rodape, 'textContent', () => tr(''));
  if (!leitura) return;

  const avisos = document.createElement('div');
  avisos.className = 'uso-avisos';
  let algum = false;

  if (leitura.linhasIgnoradas > 0) {
    const p = document.createElement('p');
    p.className = 'uso-aviso-linha';
    idiomaUI.bind(p, 'textContent', () => tr`${leitura.linhasIgnoradas} linha(s) grande(s) demais foram puladas — o total pode estar incompleto.`);
    avisos.append(p);
    algum = true;
  }
  if (leitura.arquivosComErro > 0) {
    const p = document.createElement('p');
    p.className = 'uso-aviso-linha';
    idiomaUI.bind(p, 'textContent', () => tr`${leitura.arquivosComErro} arquivo(s) não puderam ser lidos.`);
    avisos.append(p);
    algum = true;
  }
  if (leitura.precisaoPerdida) {
    const p = document.createElement('p');
    p.className = 'uso-aviso-linha';
    idiomaUI.bind(p, 'textContent', () => tr('um total passou do limite seguro de precisão — o número pode estar arredondado.'));
    avisos.append(p);
    algum = true;
  }

  if (algum) rodape.append(avisos);
}

/** Zera os três contêineres novos — chamado no início de toda carga E no `catch`. */
function limparSecoes() {
  idiomaUI.bind($('uso-custo'), 'textContent', () => tr(''));
  idiomaUI.bind($('uso-por-modelo'), 'textContent', () => tr(''));
  idiomaUI.bind($('uso-por-dia'), 'textContent', () => tr(''));
}

let diasAtual = 1;
let carregando = false;

async function carregar(dias) {
  if (carregando) return;
  carregando = true;
  diasAtual = dias;
  const lista = $('uso-lista');
  const resumo = $('uso-resumo');
  idiomaUI.bind(lista, 'textContent', () => tr(''));
  limparSecoes();
  idiomaUI.bind(resumo, 'textContent', () => tr('carregando…'));

  try {
    const dados = await api(`api/uso?dias=${dias}`);
    idiomaUI.bind(resumo, 'textContent', () => tr`${rotuloPeriodo(dados)} · total ${curto(somaTotal(dados.total))} · ${dados.leitura.arquivos} arquivos`);
    $('uso-custo').append(nodeCusto(dados));
    desenharSecao('uso-por-modelo', tr('Por modelo'), dados.porModelo);
    // Em "Hoje" a seção seria uma barra só, de 100%, repetindo o que o topo já disse.
    if (dados.dias > 1) desenharSecao('uso-por-dia', tr('Por dia'), dados.porDia);
    if (!dados.projetos || !dados.projetos.length) {
      const vazio = document.createElement('p');
      vazio.className = 'uso-vazio';
      idiomaUI.bind(vazio, 'textContent', () => tr('sem gasto registrado neste período.'));
      lista.append(vazio);
    } else {
      const totalGeral = somaTotal(dados.total);
      for (const projeto of dados.projetos) lista.append(nodeProjeto(projeto, totalGeral));
    }
    desenharAvisos(dados.leitura);
  } catch (erro) {
    idiomaUI.bind(lista, 'textContent', () => tr(''));
    // As três seções também são limpas aqui: sem isto, a tela de erro fica com o custo da
    // carga anterior por baixo — o mesmo cuidado que `resumo` e `rodape` já tinham.
    limparSecoes();
    const aviso = document.createElement('p');
    aviso.className = 'uso-vazio';
    // Sem token, ou 401: a tela diz o que fazer — nunca fica vazia sem explicação (§3.2,
    // mesma regra de app.js:116-118).
    idiomaUI.bind(aviso, 'textContent', () => tr(erro && erro.semToken
      ? tr('abra o cockpit primeiro (é de lá que vem o token de acesso).')
      : tr`não deu para carregar: ${erro && erro.message}`));
    lista.append(aviso);
    idiomaUI.bind(resumo, 'textContent', () => tr(''));
    idiomaUI.bind($('uso-rodape'), 'textContent', () => tr(''));
  } finally {
    carregando = false;
  }
}

/** A guarda vai no CHAMADOR, e não em `carregar()` (que fica intacta): `carregar()` é
 * `async` e sempre devolveria uma Promise, então usar o retorno dela como "aceitou/recusou"
 * obrigaria um `await` antes de pintar o `aria-pressed` — o toque ficaria sem resposta por
 * ~200ms. Recusando AQUI, o botão nem chega a mudar quando já há uma carga em voo. */
function selecionarPeriodo(dias) {
  if (carregando) return;
  for (const dado of [1, 7, 30]) {
    const botao = $(`btn-periodo-${dado}`);
    if (botao) botao.setAttribute('aria-pressed', String(dado === dias));
  }
  carregar(dias);
}

$('btn-periodo-1').onclick = () => selecionarPeriodo(1);
$('btn-periodo-7').onclick = () => selecionarPeriodo(7);
$('btn-periodo-30').onclick = () => selecionarPeriodo(30);

/**
 * A ÚNICA entrada que o app.js usa, chamada logo depois do `showModal()` de `#dialogo-uso`.
 * Recarrega SEMPRE, no período ATUAL (nunca "Hoje" chumbado) — fechar e reabrir no mesmo
 * período é o que qualquer tela de consulta faz, e voltar para "Hoje" sozinha apagaria uma
 * escolha do usuário. Os números mudam a cada turno; uma tela de consulta que mostra dado
 * velho sem dizer é pior que uma que demora 200ms.
 */
function abrir() {
  carregar(diasAtual);
}

// A ponte para fora da IIFE. `globalThis`, não `window`: o sandbox do gate-uso.js não tem
// `window`, e `globalThis` dentro de `vm.runInContext` É o objeto do contexto — no
// navegador, `globalThis === window`. Uma palavra serve aos dois (R8).
globalThis.telaUso = { abrir, carregar, selecionarPeriodo };

})();
