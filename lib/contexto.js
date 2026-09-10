'use strict';
// Quanto da janela do agente já está ocupado — lido do disco, sem gastar um token.
//
// O medidor de contexto existia no cockpit antigo e morreu no corte da D17 (21/08): ele era
// medido a partir dos arquivos de turno da sessão DO COCKPIT, que deixaram de existir. Sobrou
// o CSS (`.medidor`) sem HTML nem JS. As abas do terminal nunca tiveram medidor nenhum, e é
// justamente delas que o usuário precisa saber "quanto ainda cabe" quando está no celular.
//
// A fonte é o mesmo `.jsonl` que a fita já lê: cada linha `assistant` traz `message.usage`.
// Perguntar o número para o CLI custaria um turno; aqui não custa nada.
//
// FRONTEIRA: o formato deste arquivo é INTERNO do Claude Code (armadilha #10). Por isso tudo
// aqui degrada para `null` em vez de chutar — sem `usage` reconhecível não há medidor na
// tela, e a tela sem medidor continua sendo a tela que sempre existiu.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * As duas constantes da caça ao `usage` na cauda (spec §6 do corte por mensagem, 24/08).
 *
 * `BLOCO` — 64 KB. Medido nas 9 abas vivas em 24/08: nas NOVE o `usage` estava dentro do
 * primeiro bloco. O caso comum ficou mais barato do que os 256 KB de janela fixa de antes.
 * `TETO_DURO` — 4 MB, o mesmo de `lib/externo.js`. Rede contra arquivo patológico: sem ela,
 * uma cauda de imagens encadeadas faria a busca varrer um `.jsonl` de 44 MB a cada fim de
 * turno. Estourar o teto sem achar `usage` devolve `null` — a tela fica sem medidor, que é
 * o mesmo que ela sempre fez quando o número não dá para saber.
 */
const BLOCO = 64 * 1024;
const TETO_DURO = 4 * 1024 * 1024;

// A config do próprio CLI. É o único lugar onde o sufixo da janela longa aparece de verdade
// — ver `janelaLongaConfigurada`. `settings.local.json` vem primeiro porque é ele que vence.
const CONFIGS_DO_CLI = [
  path.join(os.homedir(), '.claude', 'settings.local.json'),
  path.join(os.homedir(), '.claude', 'settings.json'),
];

// A janela padrão de todo modelo Claude atual.
const TETO_PADRAO = 200000;
// A janela longa. Chega por sufixo no id (`claude-opus-5[1m]`) — ver `tetoDoModelo`.
const TETO_LONGO = 1000000;

/** Só o que a soma da janela conta. `output_tokens` é o que SAIU, não o que está ocupado. */
function somaDoUso(uso) {
  if (!uso || typeof uso !== 'object') return 0;
  return Number(uso.input_tokens || 0)
    + Number(uso.cache_creation_input_tokens || 0)
    + Number(uso.cache_read_input_tokens || 0);
}

/**
 * O CLI desta máquina está configurado para a janela longa?
 *
 * Esta pergunta existe porque a resposta NÃO está no `.jsonl`: conferido no disco em 22/08,
 * `message.model` vem gravado como `claude-opus-5` mesmo em sessão de 1M — a API devolve o
 * id sem o sufixo. Quem guarda a verdade é a config do próprio CLI, que é de onde toda aba
 * interativa nasce (`"model": "opus[1m]"` no `~/.claude/settings.json` do usuário).
 *
 * Ler arquivo do CLI é o mesmo hábito de lib/abas.js (`~/.claude/sessions/<pid>.json`), com
 * a mesma ressalva da armadilha #10: formato interno, pode mudar. Quando mudar, isto devolve
 * `false` e o teto volta a ser o padrão — degrada, não quebra. Aba aberta com `--model`
 * diferente do configurado também cai no padrão, e aí a regra do `usados` abaixo cobre.
 */
async function janelaLongaConfigurada() {
  for (const arquivo of CONFIGS_DO_CLI) {
    try {
      const dados = JSON.parse(await fsp.readFile(arquivo, 'utf8'));
      if (typeof dados.model === 'string') return /\[1m\]/i.test(dados.model);
    } catch { /* não existe, ou não é JSON: tenta o próximo */ }
  }
  return false;
}

/**
 * O nível de esforço GLOBAL configurado no CLI desta máquina, ou `null` quando não dá para saber.
 *
 * Esta é a OUTRA fonte de effort do cockpit, e ela não se confunde com o `esforco` de
 * `medir()`: aquele é o nível daquela CONVERSA, gravado no `.jsonl` dela, histórico. Este é o
 * nível de agora, o que vale para a próxima aba. `/effort` — com argumento ou pelo menu —
 * grava `effortLevel` em `~/.claude/settings.json`; conferido no disco em 24/08
 * (`{"model":"opus[1m]", …, "effortLevel":"high", …}`). `settings.local.json` não existia
 * naquele dia, mas VENCE quando existir.
 *
 * MESMA constante `CONFIGS_DO_CLI` de `janelaLongaConfigurada()`, de propósito: uma segunda
 * lista dos mesmos caminhos é a próxima coisa a ficar velha calada (armadilha #40).
 *
 * Formato interno do CLI (armadilha #10): quando mudar, isto devolve `null`, a tela diz que
 * não sabe e o painel continua de pé — degrada, não quebra. Ela NUNCA rejeita.
 */
async function effortConfigurado() {
  for (const arquivo of CONFIGS_DO_CLI) {
    try {
      const dados = JSON.parse(await fsp.readFile(arquivo, 'utf8'));
      if (typeof dados.effortLevel === 'string') return dados.effortLevel;
    } catch { /* não existe, ou não é JSON: tenta o próximo */ }
  }
  return null;
}

/**
 * O teto da janela daquele modelo, ou `null` quando não dá para saber.
 *
 * Ordem das regras:
 *
 * 1. Sufixo `[1m]` no id do modelo → janela longa, sem discussão.
 * 2. Modelo que não é da família Claude (ou `<synthetic>`, que é mensagem de erro do próprio
 *    CLI) → `null`. A tela mostra os tokens e NENHUMA porcentagem: teto chutado é número
 *    errado com cara de número certo.
 * 3. Família Claude → 1M se o CLI está configurado na janela longa, senão 200k.
 * 4. E, em qualquer caso, uma conversa que JÁ carrega mais tokens que o teto calculado
 *    PROVA um teto maior. Isso é dedução, não chute, e sem ela o medidor mostraria "347%"
 *    numa sessão de 1M cujo `model` veio sem sufixo e cuja config não foi lida. Acima de 1M
 *    não há teto conhecido: volta a ser `null`.
 *
 * @param {string} modelo
 * @param {number} usados
 * @param {{longa?: boolean}} opcoes `longa` = o CLI está configurado na janela de 1M.
 */
function tetoDoModelo(modelo, usados = 0, { longa = false } = {}) {
  const nome = String(modelo || '').trim();
  if (!nome || nome === '<synthetic>') return null;
  if (/\[1m\]/i.test(nome)) return TETO_LONGO;
  if (!/^(claude[-.]|opus|sonnet|haiku|fable)/i.test(nome)) return null;
  if (usados > TETO_LONGO) return null;
  const base = longa ? TETO_LONGO : TETO_PADRAO;
  return usados > base ? TETO_LONGO : base;
}

/**
 * O último `usage` de um pedaço de `.jsonl`, virando o que a tela desenha.
 *
 * Separada da leitura do disco de propósito: é assim que o gate exercita a conta inteira a
 * partir de um arquivo de mentira, sem sessão nenhuma no ar.
 *
 * Duas linhas são puladas, e as duas por motivo de verdade:
 * - `isSidechain` é subagente. Ele tem janela PRÓPRIA; contar o `usage` dele mostraria na
 *   tela o contexto de outra conversa. Mesma exclusão que lib/externo.js já faz na fita.
 * - `usage` todo zerado é mensagem sintética do CLI (rate limit, erro de API — elas chegam
 *   como `assistant` com `model: "<synthetic>"`). Se a última linha do arquivo for uma
 *   dessas, o medidor cairia para 0% justo quando o usuário mais quer olhar.
 *
 * O `esforco` sai da MESMA linha que entrega o `usage` — nenhuma leitura nova, nenhuma
 * varredura nova. Ele fica no NÍVEL RAIZ da linha (irmão de `message`, não dentro dele):
 * conferido no disco em 24/08 no `.jsonl` deste projeto, `effort: 'high'` ao lado de
 * `message`, `type`, `cwd` e `sessionId`. É formato interno do CLI (armadilha #10): quando
 * mudar, isto devolve `null` e o chip some — degrada, não quebra.
 *
 * ATENÇÃO ao que este campo NÃO é: ele é o effort DAQUELA CONVERSA, histórico, porque o
 * `.jsonl` é por conversa. O effort GLOBAL de agora mora na config do CLI e sai por
 * `effortConfigurado()`. Ligar um controle de troca neste campo faria o cockpit mentir sobre
 * o alcance (R9 da spec de 24/08).
 *
 * @param {string} bruto texto do pedaço lido.
 * @param {{cortado?: boolean, longa?: boolean}} opcoes `cortado` = o pedaço começa no meio
 *   de uma linha; `longa` = o CLI está configurado na janela de 1M.
 */
function medir(bruto, { cortado = false, longa = false } = {}) {
  const linhas = String(bruto || '').split('\n');
  // Cortar pelo byte cai no meio de uma linha: a primeira é sempre um pedaço de JSON.
  if (cortado) linhas.shift();

  let achado = null;
  for (const linha of linhas) {
    if (!linha.trim()) continue;
    let obj;
    try { obj = JSON.parse(linha); } catch { continue; }
    if (obj.isSidechain || obj.type !== 'assistant') continue;
    const usados = somaDoUso(obj.message?.usage);
    if (usados <= 0) continue;
    achado = { usados, modelo: obj.message?.model || null, esforco: obj.effort ?? null };
  }
  if (!achado) return null;

  const teto = tetoDoModelo(achado.modelo, achado.usados, { longa });
  return {
    usados: achado.usados,
    teto,
    // Uma casa decimal: o cliente arredonda para inteiro na etiqueta e usa o número cheio
    // na largura da barra.
    pct: teto ? Math.round((achado.usados / teto) * 1000) / 10 : null,
    modelo: achado.modelo,
    // O nível de esforço DAQUELA conversa. `null` quando a linha não traz o campo — conversa
    // gravada por uma versão do CLI que não o escrevia simplesmente não mostra o chip, que é
    // a mesma regra dos três estados do medidor: rótulo inventado é pior que rótulo nenhum.
    esforco: achado.esforco,
  };
}

/**
 * A chave de comparação do contexto — a régua do "mudou" do relógio de arquivo do fluxo SSE.
 *
 * Mora aqui porque é este módulo que define a FORMA do objeto, e é exportada porque o
 * `server.js` não é exigível pelo gate (ele sobe servidor no `require`): sem isto, a regra do
 * "mudou" só poderia ser testada por asserção de fonte, que não roda a conta.
 *
 * Três decisões, e cada uma existe para o servidor NÃO emitir evento quando nada mudou:
 *
 * - **Os quatro campos, nesta ordem:** `usados|teto|modelo|esforco`. `pct` fica de fora de
 *   propósito — ele é derivado de `usados` e `teto`, e incluí-lo só criaria uma segunda chance
 *   de a chave mudar sem o valor ter mudado.
 * - **`null` e `undefined` viram a MESMA string vazia.** Campo ausente e campo nulo significam
 *   a mesma coisa aqui ("não sei"); distinguir os dois faria o topo ser redesenhado à toa.
 * - **`null` (não há contexto) tem chave própria**, que nunca colide com um contexto de verdade.
 *
 * @param {?{usados:number, teto:?number, modelo:?string, esforco:?string}} c
 * @returns {?string} a chave, ou `null` quando não há contexto.
 */
function chaveDoContexto(c) {
  if (!c) return null;
  return [c.usados, c.teto, c.modelo, c.esforco]
    .map((v) => (v === null || v === undefined ? '' : String(v)))
    .join('|');
}

/**
 * O contexto de uma conversa, lido na CAUDA do arquivo — para trás, em blocos.
 *
 * O maior `.jsonl` do disco tem 44 MB. Reler isso a cada fim de turno para achar um número
 * seria absurdo — e desnecessário, porque o que interessa é o ÚLTIMO `usage`, e ele está no
 * fim. Daí ler só a cauda.
 *
 * Mas UMA linha do `.jsonl` pode ser gigante: um print mandado pelo cockpit entra em base64
 * numa LINHA SÓ (medidas de 24/08: 398 KB, 453 KB, 710 KB). Entre a imagem ser escrita e o
 * agente responder, uma janela FIXA de 256 KB caía inteira dentro dessa linha — nenhum JSON
 * fechava, nenhum `usage` aparecia, e o medidor sumia da tela justo depois de o usuário mandar
 * o print. Por isso a cauda deixou de ser um tiro de tamanho fixo: agora é uma varredura para
 * trás em blocos de `BLOCO`, que só para quando acha `usage`, chega ao byte 0, ou gasta
 * `TETO_DURO` bytes. Mesma forma da leitura inicial de `lerConversa` (`lib/externo.js`), com
 * um alvo diferente: lá são 80 mensagens, aqui é UM número.
 *
 * O primeiro bloco que contém `usage` guarda, por construção, o ÚLTIMO do arquivo — os blocos
 * mais perto do fim já foram olhados e não tinham nenhum.
 *
 * Emenda de linha (armadilha #11): a primeira linha de cada bloco cai no meio de uma escrita
 * antiga. Ela vai para o `carry` e é RECONSTRUÍDA junto com o bloco seguinte, nunca parseada
 * pela metade — cada byte entra em exatamente UM `corpo`, então nada é lido duas vezes. Como
 * é este laço que corta linha, e ele já emenda, `medir` é chamado sempre com `cortado: false`.
 *
 * Sem `usage` em lugar nenhum dentro do teto devolve `null`, e a tela não mostra o medidor.
 */
async function doArquivo(caminho) {
  if (!caminho) return null;
  let info;
  try { info = await fsp.stat(caminho); } catch { return null; }
  if (!info.size) return null;

  // Lido UMA vez, fora do laço: a config do CLI não muda entre um bloco e outro.
  const longa = await janelaLongaConfigurada();

  let alca;
  try {
    alca = await fsp.open(caminho, 'r');
    let de = info.size;
    let carry = [];   // LISTA de Buffers do pedaço de linha que falta emendar; nunca contém '\n'.
    let lidos = 0;

    while (de > 0 && lidos < TETO_DURO) {
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
      // Arquivo encolheu entre o `stat` e o `read`: para o laço em vez de insistir. O fim de
      // turno seguinte pega o arquivo novo.
      if (bloco.length === 0) break;

      let corpo;
      if (novoDe > 0) {
        const nl = bloco.indexOf(10); // '\n'
        if (nl < 0) {
          // Bloco inteiro é continuação de UMA linha (o miolo de uma imagem): nada a medir.
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

      const achado = medir(corpo.toString('utf8'), { longa });
      if (achado) return achado;
      de = novoDe;
    }
    return null;
  } catch {
    return null;
  } finally {
    await alca?.close().catch(() => {});
  }
}

module.exports = {
  doArquivo, medir, tetoDoModelo, somaDoUso, janelaLongaConfigurada, chaveDoContexto,
  effortConfigurado,
  TETO_PADRAO, TETO_LONGO, BLOCO, TETO_DURO,
};
