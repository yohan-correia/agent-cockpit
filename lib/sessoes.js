'use strict';
// Sessões do cockpit — cada conversa vive numa sessão tmux própria.
//
// Por que tmux e não um processo filho do servidor: assim o turno sobrevive ao restart do
// cockpit-server. É o mesmo padrão que o `orquestrador` usa há meses e que funciona.
//
// SOCKET DEDICADO (`tmux -L cockpit`): as sessões do usuário (a `main`, com Projeto-a, Projeto-d,
// Projeto-b…) vivem no socket default. Um servidor tmux separado torna IMPOSSÍVEL que um bug
// daqui derrube o terminal de trabalho dele. Decidido em 20/08, a pedido dele.
//
// O turno NÃO é lido da tela do tmux — isso seria parsear framebuffer, descartado na D4.
// Ele escreve NDJSON num arquivo e o servidor acompanha o arquivo. Tela é para humano.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const {
  traduzir, novoId, montarArgs, usoDaMensagem, usoDoResultado, ENV_A_LIMPAR,
} = require('./adaptador-claude');
const externo = require('./externo');

const SOCKET = 'cockpit';
const PREFIXO = 'cockpit-'; // trava: só encerramos sessão com este prefixo
const RAIZ = path.join(os.homedir(), '.cockpit', 'sessoes');
// Trava do excluir(): o id que vira caminho no disco precisa ser exatamente um UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tmux(args, { silencioso = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCKET, ...args], { timeout: 8000 }, (erro, saida, err) => {
      // `tmux ls` sem servidor rodando sai com erro — isso é "nenhuma sessão", não falha.
      if (erro && !silencioso) return reject(new Error(String(err || erro.message).trim()));
      resolve(String(saida || ''));
    });
  });
}

async function sessoesVivas() {
  const saida = await tmux(['ls', '-F', '#{session_name}'], { silencioso: true });
  return new Set(saida.split('\n').map((s) => s.trim()).filter(Boolean));
}

/**
 * Quantas janelas cada sessão tem. A âncora (`sleep infinity`) é sempre uma; qualquer
 * janela além dela é um turno rodando.
 *
 * É isto que distingue "trabalhando" de turno MORTO. Antes, um turno interrompido antes
 * de gravar o `.code` ficava eternamente "em andamento": o cockpit bloqueava turno novo
 * com 409 e a UI deixava o botão Enviar desabilitado para sempre. Foi o que aconteceu com
 * a conversa do bling-gpt-mcp quando o servidor tmux caiu.
 *
 * Uma chamada só para todas as sessões — `-a` lista as janelas do socket inteiro.
 */
async function janelasPorSessao() {
  const saida = await tmux(['list-windows', '-a', '-F', '#{session_name}'], { silencioso: true });
  const conta = new Map();
  for (const linha of saida.split('\n')) {
    const nome = linha.trim();
    if (nome) conta.set(nome, (conta.get(nome) || 0) + 1);
  }
  return conta;
}

const nomeTmux = (id) => `${PREFIXO}${id.slice(0, 8)}`;
const pasta = (id) => path.join(RAIZ, id);

async function lerMeta(id) {
  try {
    return JSON.parse(await fsp.readFile(path.join(pasta(id), 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function gravarMeta(meta) {
  await fsp.mkdir(pasta(meta.id), { recursive: true });
  await fsp.writeFile(path.join(pasta(meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
}

/**
 * Garante que a sessão tmux desta conversa existe, recriando-a se preciso.
 *
 * Sessão tmux morrer é normal, não excepcional: o servidor do socket desliga sozinho
 * quando a ÚLTIMA sessão dele sai, e ainda tem reboot e limpeza de /tmp. Antes disto o
 * cockpit tratava como falha fatal e a conversa virava tijolo, com um
 * "no server running on /tmp/tmux-1000/cockpit" na cara do usuário.
 *
 * Ressuscitar não perde nada: o histórico da conversa vive nos arquivos do CLI e o
 * `--resume` os relê pelo session-id. O tmux aqui é só o lugar onde o turno roda.
 */
async function garantirViva(meta) {
  const vivas = await sessoesVivas();
  if (vivas.has(meta.tmux_session)) return false;
  if (!fs.existsSync(meta.cwd)) throw new Error(`cwd sumiu do disco: ${meta.cwd}`);
  await tmux(['new-session', '-d', '-s', meta.tmux_session, '-c', meta.cwd, 'sleep infinity']);
  return true;
}

/** Cria a sessão. A janela âncora existe só para o tmux não encerrar a sessão entre turnos. */
async function criar({ cwd, titulo }) {
  if (!cwd) throw new Error('sessão precisa de cwd explícito');
  if (!fs.existsSync(cwd)) throw new Error(`cwd não existe: ${cwd}`);

  const id = novoId();
  const nome = nomeTmux(id);
  await fsp.mkdir(pasta(id), { recursive: true });
  await tmux(['new-session', '-d', '-s', nome, '-c', cwd, 'sleep infinity']);

  const meta = {
    id,
    titulo: titulo || path.basename(cwd),
    cwd,
    tmux_socket: SOCKET,
    tmux_session: nome,
    criado_em: new Date().toISOString(),
    turnos: 0,
  };
  await gravarMeta(meta);
  return meta;
}

/**
 * Estado de uma conversa para a lista lateral. São quatro, e cada um responde a uma
 * pergunta diferente do usuário olhando o celular:
 *
 *   trabalhando  → o agente está rodando agora (turno sem arquivo .code)
 *   respondeu    → terminou e a última fala dele é uma pergunta: a bola está com você
 *   pronta       → terminou sem perguntar nada
 *   nova         → nunca rodou turno
 *
 * "já li ou não" NÃO entra aqui: isso é por aparelho e vive no localStorage do cliente.
 * O servidor dá o fato (terminou, perguntou); o aparelho sabe se você olhou.
 */
async function estado(meta, janelas) {
  const n = meta.turnos || 0;
  if (!n) return { estado: 'nova', pergunta: false, terminouEm: null };

  const dir = pasta(meta.id);
  if (!fs.existsSync(path.join(dir, `turno-${n}.code`))) {
    // Sem `.code` só significa "rodando" se houver de fato onde rodar. O turno vive numa
    // janela do tmux; sem ela, o processo morreu antes de gravar o código de saída.
    const rodando = (janelas.get(meta.tmux_session) || 0) > 1;
    return { estado: rodando ? 'trabalhando' : 'interrompida', pergunta: false, terminouEm: null };
  }

  let terminouEm = null;
  try {
    terminouEm = fs.statSync(path.join(dir, `turno-${n}.code`)).mtimeMs;
  } catch { /* sumiu no meio: trata como sem data */ }

  return { estado: perguntouNoFim(dir, n) ? 'respondeu' : 'pronta', pergunta: perguntouNoFim(dir, n), terminouEm };
}

/**
 * A última fala do agente termina em pergunta?
 *
 * Não existe sinal formal para isto: `AskUserQuestion` não é oferecida em `claude -p`, e
 * uma pergunta sai como texto igual a qualquer outro. Então é heurística mesmo — olhar o
 * fim do último texto. Erra para o lado seguro: no máximo marca "respondeu" uma conversa
 * que só terminou com uma frase interrogativa retórica.
 *
 * Lê apenas o FIM do arquivo: um turno longo tem megabytes e isto roda a cada 15s.
 */
function perguntouNoFim(dir, n) {
  const ultimo = ultimoTexto(dir, n);
  // Última linha com conteúdo: uma pergunta raramente é seguida de mais prosa.
  const fim = ultimo.trim().split('\n').filter((l) => l.trim()).pop() || '';
  return /\?\s*$/.test(fim.replace(/[*_`)\]]+$/, ''));
}

/** O último texto que o agente falou no turno. Lê só o fim do arquivo. */
function ultimoTexto(dir, n) {
  const arquivo = path.join(dir, `turno-${n}.jsonl`);
  let bruto = '';
  try {
    const tamanho = fs.statSync(arquivo).size;
    const inicio = Math.max(0, tamanho - 64 * 1024);
    const fd = fs.openSync(arquivo, 'r');
    try {
      const buffer = Buffer.alloc(tamanho - inicio);
      fs.readSync(fd, buffer, 0, buffer.length, inicio);
      bruto = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }

  let ultimo = '';
  for (const linha of bruto.split('\n')) {
    if (!linha.trim() || !linha.startsWith('{')) continue; // linha cortada pelo recorte
    let obj;
    try { obj = JSON.parse(linha); } catch { continue; }
    if (obj.type !== 'assistant') continue;
    for (const parte of obj.message?.content || []) {
      if (parte.type === 'text' && parte.text.trim()) ultimo = parte.text;
    }
  }
  return ultimo;
}

async function listar() {
  let ids = [];
  try {
    ids = await fsp.readdir(RAIZ);
  } catch {
    return [];
  }
  const [vivas, janelas] = await Promise.all([sessoesVivas(), janelasPorSessao()]);
  const metas = (await Promise.all(ids.map(lerMeta))).filter(Boolean);
  const comEstado = await Promise.all(metas.map(async (m) => ({
    ...m,
    viva: vivas.has(m.tmux_session),
    ...await estado(m, janelas),
  })));
  return comEstado.sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
}

async function encerrar(id) {
  const meta = await lerMeta(id);
  if (!meta) throw new Error(`sessão desconhecida: ${id}`);
  // Trava dupla: nunca kill-server, e só derruba sessão com o nosso prefixo.
  if (!meta.tmux_session.startsWith(PREFIXO)) {
    throw new Error(`recusado: "${meta.tmux_session}" não é sessão do cockpit`);
  }
  await tmux(['kill-session', '-t', meta.tmux_session], { silencioso: true });
  return { id, encerrada: true };
}

/**
 * Encerra E APAGA a sessão: tmux derrubado, pasta de estado removida. Não tem volta.
 *
 * A ordem importa. Matar o tmux primeiro encerra o `bash` do turno; só então a pasta some.
 * Ao contrário, o script continuaria escrevendo num arquivo já deletado e o `sleep infinity`
 * da janela âncora viraria processo órfão.
 *
 * Duas travas antes do `rm`: o id tem que ser UUID (nada de `..` ou caminho), e o caminho
 * resolvido tem que cair dentro de RAIZ. É a única operação destrutiva do sistema.
 */
async function excluir(id) {
  if (!UUID.test(String(id))) throw new Error(`id fora do formato: ${id}`);
  const meta = await lerMeta(id);
  if (!meta) throw new Error(`sessão desconhecida: ${id}`);

  const alvo = path.resolve(pasta(id));
  if (alvo !== path.join(path.resolve(RAIZ), id)) {
    throw new Error(`recusado: ${alvo} está fora de ${RAIZ}`);
  }

  await encerrar(id);
  await fsp.rm(alvo, { recursive: true, force: true });
  return { id, excluida: true };
}

/**
 * Guarda um anexo enviado pelo navegador e devolve o caminho absoluto dele.
 *
 * Vai para `~/.cockpit/sessoes/<id>/anexos/`, NUNCA para o cwd do projeto: escrever no
 * repo do usuário sujaria o `git status` dele com arquivo que não é código. O CLI lê
 * caminho absoluto fora do cwd sem reclamar — testado antes de escrever isto.
 *
 * O nome vem do navegador, então não pode virar caminho: só o basename, e sem nada além
 * de letra, número, ponto, hífen e sublinhado.
 */
async function guardarAnexo({ id, nome, extensao, dados }) {
  const meta = await lerMeta(id);
  if (!meta) throw new Error(`sessão desconhecida: ${id}`);

  const limpo = path.basename(String(nome || 'anexo'))
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'anexo';
  const base = limpo.toLowerCase().endsWith(extensao) ? limpo.slice(0, -extensao.length) : limpo;

  const dir = path.join(pasta(id), 'anexos');
  await fsp.mkdir(dir, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const arquivo = path.join(dir, `${carimbo}-${base}${extensao}`);

  // Trava final: o nome já foi lavado, mas quem escreve no disco confere de novo.
  if (path.dirname(path.resolve(arquivo)) !== path.resolve(dir)) {
    throw new Error('nome de anexo recusado');
  }
  await fsp.writeFile(arquivo, dados);
  return { arquivo, nome: path.basename(arquivo), bytes: dados.length };
}

/**
 * Dispara um turno DENTRO da sessão tmux e devolve um emissor de eventos internos.
 * O comando vai num script (como o `run.sh` do servidor) para não depender de escaping de shell.
 */
async function rodarTurno({ id, texto, modelo, anexos = [] }) {
  const meta = await lerMeta(id);
  if (!meta) throw new Error(`sessão desconhecida: ${id}`);
  if (!texto || !String(texto).trim()) throw new Error('turno sem texto');

  const n = (meta.turnos || 0) + 1;
  const dir = pasta(id);
  const arqPrompt = path.join(dir, `turno-${n}.prompt`);
  const arqSaida = path.join(dir, `turno-${n}.jsonl`);
  const arqScript = path.join(dir, `turno-${n}.sh`);

  // Caminho de anexo vem do CLIENTE, então não pode ser caminho livre: sem esta trava,
  // um pedido forjado apontaria o agente para ~/.secrets/ e pediria para ele "ler o anexo".
  const pastaAnexos = path.resolve(path.join(pasta(id), 'anexos'));
  for (const caminho of anexos) {
    const resolvido = path.resolve(String(caminho));
    if (path.dirname(resolvido) !== pastaAnexos) {
      throw new Error('anexo fora da pasta da conversa');
    }
    if (!fs.existsSync(resolvido)) throw new Error(`anexo não existe: ${path.basename(resolvido)}`);
  }

  // O anexo entra como CAMINHO no prompt. O CLI não recebe binário por stdin em -p; ele
  // abre o arquivo com o Read, que enxerga imagem. Provado antes de construir isto.
  const cabecalho = anexos.length
    ? `${anexos.map((a) => `[anexo] ${a}`).join('\n')}\n\n`
      + `Os arquivos acima foram enviados pelo usuário junto desta mensagem. Abra o que precisar.\n\n`
    : '';
  await fsp.writeFile(arqPrompt, cabecalho + texto);
  const args = montarArgs({ texto: '__PROMPT__', sessionId: id, retomar: n > 1, modelo })
    .map((a) => (a === '__PROMPT__' ? `"$(cat ${JSON.stringify(arqPrompt)})"` : JSON.stringify(a)))
    .join(' ');

  const script = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    // Identifica o fluxo legado para hooks opcionais (ver adaptador-claude.js).
    'export COCKPIT_SESSAO=1',
    ...ENV_A_LIMPAR.map((v) => `unset ${v}`),
    `cd ${JSON.stringify(meta.cwd)} || exit 90`,
    `claude ${args} > ${JSON.stringify(arqSaida)} 2> ${JSON.stringify(arqSaida + '.err')}`,
    `echo $? > ${JSON.stringify(path.join(dir, `turno-${n}.code`))}`,
    '',
  ].join('\n');
  await fsp.writeFile(arqScript, script, { mode: 0o755 });
  await fsp.writeFile(arqSaida, '');

  const ressuscitada = await garantirViva(meta);

  await gravarMeta({ ...meta, turnos: n, ultimo_turno_em: new Date().toISOString() });
  await tmux(['new-window', '-d', '-t', meta.tmux_session, '-c', meta.cwd, `bash ${JSON.stringify(arqScript)}`]);

  return {
    turno: n,
    arquivo: arqSaida,
    ressuscitada,
    emissor: acompanhar(arqSaida, path.join(dir, `turno-${n}.code`)),
  };
}

/** Acompanha o NDJSON do turno e emite eventos internos — inclusive de um turno já em curso. */
function acompanhar(arquivo, arquivoCodigo) {
  const emissor = new EventEmitter();
  let posicao = 0;
  let parcial = '';
  let encerrado = false;

  const tick = () => {
    if (encerrado) return;
    let tamanho = 0;
    try {
      tamanho = fs.statSync(arquivo).size;
    } catch {
      return agendar();
    }
    if (tamanho > posicao) {
      const fd = fs.openSync(arquivo, 'r');
      const buffer = Buffer.alloc(tamanho - posicao);
      fs.readSync(fd, buffer, 0, buffer.length, posicao);
      fs.closeSync(fd);
      posicao = tamanho;
      parcial += buffer.toString('utf8');
      const linhas = parcial.split('\n');
      parcial = linhas.pop() || '';
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        try {
          for (const evento of traduzir(JSON.parse(linha))) emissor.emit('evento', evento);
        } catch {
          emissor.emit('evento', { tipo: 'erro', mensagem: `linha ilegível: ${linha.slice(0, 120)}` });
        }
      }
    }
    if (fs.existsSync(arquivoCodigo)) {
      const codigo = Number(String(fs.readFileSync(arquivoCodigo, 'utf8')).trim());
      encerrado = true;
      return emissor.emit('fim', { codigo });
    }
    agendar();
  };

  const agendar = () => { if (!encerrado) setTimeout(tick, 250).unref?.(); };
  setTimeout(tick, 50).unref?.();
  emissor.parar = () => { encerrado = true; };
  return emissor;
}

/**
 * Todo o histórico da sessão, relido do disco. É isto que um cliente que acabou de conectar
 * recebe antes dos eventos ao vivo — a UI não guarda verdade nenhuma, só desenha.
 */
async function historico(id) {
  const meta = await lerMeta(id);
  if (!meta) throw new Error(`sessão desconhecida: ${id}`);
  const eventos = [];
  const prompts = [];

  for (let n = 1; n <= (meta.turnos || 0); n++) {
    const dir = pasta(id);
    // O que o usuário escreveu não está no stream-json de saída; vem do arquivo do prompt.
    let prompt = null;
    try {
      prompt = await fsp.readFile(path.join(dir, `turno-${n}.prompt`), 'utf8');
      prompts.push(prompt);
      eventos.push({ tipo: 'humano', texto: prompt, turno: n });
    } catch { /* turno sem prompt gravado: segue */ }

    let bruto = '';
    try {
      bruto = await fsp.readFile(path.join(dir, `turno-${n}.jsonl`), 'utf8');
    } catch { continue; }
    for (const linha of bruto.split('\n')) {
      if (!linha.trim()) continue;
      try {
        for (const evento of traduzir(JSON.parse(linha))) eventos.push({ ...evento, turno: n });
      } catch { /* linha truncada de turno em curso: ignora */ }
    }
  }

  // O que passou pelo terminal na mesma sessão. Sem isto, o agente responde na tela sobre
  // perguntas que a tela nunca mostrou — ver lib/externo.js.
  let deFora = [];
  try {
    deFora = await externo.trocasDeFora(id, meta.cwd, prompts);
  } catch { /* formato do CLI mudou: segue sem, em vez de quebrar a conversa */ }

  if (!deFora.length) return { meta, eventos };

  // Intercala: cada bloco entra logo depois do turno do cockpit que o precedeu.
  const finais = [];
  let proximo = 0;
  for (let n = 0; n <= (meta.turnos || 0); n++) {
    if (n > 0) finais.push(...eventos.filter((e) => e.turno === n));
    while (proximo < deFora.length && deFora[proximo].depoisDoTurno === n) {
      finais.push({ tipo: 'fora_inicio', quando: deFora[proximo].quando });
      finais.push(...deFora[proximo].eventos);
      finais.push({ tipo: 'fora_fim' });
      proximo += 1;
    }
  }
  return { meta, eventos: finais };
}

/**
 * Quanto esta conversa já consumiu: contexto, custo, turnos e o que o CLI aceita depois
 * de uma barra. Tudo relido do disco, como o resto do sistema — o servidor não guarda
 * contador em memória que possa divergir da verdade depois de um restart.
 *
 * O contexto que vale é o da ÚLTIMA mensagem do assistente, não a soma dos turnos: cada
 * request carrega a conversa inteira, então somar contaria o mesmo histórico N vezes.
 */
async function uso(id) {
  const meta = await lerMeta(id);
  if (!meta) throw new Error(`sessão desconhecida: ${id}`);

  const resumo = {
    id,
    titulo: meta.titulo,
    cwd: meta.cwd,
    criadoEm: meta.criado_em,
    turnos: meta.turnos || 0,
    modelo: null,
    janela: null,
    maxSaida: null,
    contexto: 0,
    custoUSD: 0,
    entradaTotal: 0,
    saidaTotal: 0,
    cacheLidoTotal: 0,
    ultimaDuracaoMs: 0,
    comandos: [],
    limite: null,
  };

  for (let n = 1; n <= resumo.turnos; n++) {
    let bruto = '';
    try {
      bruto = await fsp.readFile(path.join(pasta(id), `turno-${n}.jsonl`), 'utf8');
    } catch { continue; }

    for (const linha of bruto.split('\n')) {
      if (!linha.trim()) continue;
      let obj;
      try { obj = JSON.parse(linha); } catch { continue; }

      if (obj.type === 'rate_limit_event') {
        // Teto do plano: vale o último visto, é estado da conta e não da conversa.
        const [evento] = traduzir(obj);
        if (evento) resumo.limite = evento;
      } else if (obj.type === 'system' && obj.subtype === 'init') {
        if (obj.model) resumo.modelo = obj.model;
        if (Array.isArray(obj.slash_commands) && obj.slash_commands.length) {
          resumo.comandos = obj.slash_commands;
        }
      } else if (obj.type === 'assistant') {
        const m = usoDaMensagem(obj);
        // A última mensagem manda: é o modelo que de fato está respondendo ao usuário,
        // e o contexto que ela carregava é o tamanho real da conversa hoje.
        if (m && m.contexto) resumo.contexto = m.contexto;
        if (m && m.modelo) resumo.modelo = m.modelo;
      } else if (obj.type === 'result') {
        const r = usoDoResultado(obj);
        resumo.custoUSD += r.custoUSD;
        resumo.entradaTotal += r.entrada;
        resumo.saidaTotal += r.saida;
        resumo.cacheLidoTotal += r.cacheLido;
        resumo.ultimaDuracaoMs = r.duracaoMs;
        // A janela é a do modelo que está respondendo — não a do auxiliar que apareceu
        // no mesmo turno. Opus com 1M e Haiku com 200k no mesmo result é o caso normal.
        const doModelo = r.porModelo[resumo.modelo] || r.porModelo[r.modelo] || {};
        if (doModelo.contextWindow) resumo.janela = doModelo.contextWindow;
        else if (r.janela) resumo.janela = r.janela;
        if (doModelo.maxOutputTokens || r.maxSaida) resumo.maxSaida = doModelo.maxOutputTokens || r.maxSaida;
        if (!resumo.modelo && r.modelo) resumo.modelo = r.modelo;
      }
    }
  }

  resumo.porcentagem = resumo.janela ? Math.min(100, (resumo.contexto / resumo.janela) * 100) : null;
  return resumo;
}

// Ferramentas que ESCREVEM. Só o que passou por uma delas entra na lista de downloads;
// um `Read` em ~/.secrets/ jamais vira link. É a diferença entre "o agente produziu isto"
// e "o agente encostou nisto".
const ESCREVEM = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

/**
 * Arquivos que o agente produziu nesta conversa, para o usuário baixar.
 *
 * Duas regras que definem a superfície exposta, e nenhuma delas é opcional:
 *   1. só arquivos tocados por ferramenta de ESCRITA no histórico desta conversa;
 *   2. só dentro do cwd da sessão — comparado com separador, senão `/projetos/x-outro`
 *      passaria por `/projetos/x`.
 *
 * O que fica de fora, e é bom que fique: PDF gerado por um comando no Bash. O evento não
 * diz o que o comando escreveu. Varrer o cwd por mtime pegaria isso, e pegaria junto todo
 * arquivo que o build tocou — vira explorador de arquivos, que é o que não queremos.
 */
async function arquivos(id) {
  const meta = await lerMeta(id);
  if (!meta) throw new Error(`sessão desconhecida: ${id}`);
  const raiz = path.resolve(meta.cwd);
  const achados = new Map();

  for (let n = 1; n <= (meta.turnos || 0); n++) {
    let bruto = '';
    try {
      bruto = await fsp.readFile(path.join(pasta(id), `turno-${n}.jsonl`), 'utf8');
    } catch { continue; }

    for (const linha of bruto.split('\n')) {
      if (!linha.trim()) continue;
      let obj;
      try { obj = JSON.parse(linha); } catch { continue; }
      if (obj.type !== 'assistant') continue;
      for (const parte of obj.message?.content || []) {
        if (parte.type !== 'tool_use' || !ESCREVEM.has(parte.name)) continue;
        const alvo = parte.input?.file_path;
        if (!alvo) continue;
        const cheio = path.resolve(String(alvo));
        if (cheio !== raiz && !cheio.startsWith(raiz + path.sep)) continue;
        achados.set(cheio, { caminho: cheio, relativo: path.relative(raiz, cheio), turno: n, ferramenta: parte.name });
      }
    }
  }

  // Existe ainda? O agente pode ter apagado ou renomeado depois.
  return (await Promise.all([...achados.values()].map(async (a) => {
    try {
      const info = await fsp.stat(a.caminho);
      if (!info.isFile()) return null;
      return { ...a, bytes: info.size, mtime: info.mtimeMs };
    } catch {
      return null;
    }
  }))).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
}

/**
 * Confere que um caminho pedido para download é MESMO um dos arquivos gerados.
 *
 * A lista é a autorização: nada de aceitar caminho do cliente e só "conferir se está
 * dentro do cwd". Se não saiu de uma escrita do agente, não desce.
 */
async function arquivoParaBaixar(id, relativo) {
  const lista = await arquivos(id);
  const achado = lista.find((a) => a.relativo === relativo);
  if (!achado) throw new Error('arquivo não está na lista desta conversa');
  return achado;
}

/**
 * Número do turno realmente rodando, ou null.
 *
 * Faltar o `.code` não basta: o turno pode ter morrido com o tmux e nunca tê-lo gravado.
 * Quem responde de verdade é a janela no tmux. Sem esta checagem, uma conversa cujo turno
 * morreu recusa turno novo com 409 e o Enviar fica desabilitado para sempre.
 */
async function turnoEmAndamento(id) {
  const meta = await lerMeta(id);
  if (!meta || !meta.turnos) return null;
  const n = meta.turnos;
  if (fs.existsSync(path.join(pasta(id), `turno-${n}.code`))) return null;
  const janelas = await janelasPorSessao();
  return (janelas.get(meta.tmux_session) || 0) > 1 ? n : null;
}

/**
 * Mata o turno que está rodando agora. Devolve null quando não há nenhum.
 *
 * O que morre é a JANELA do turno, nunca a sessão: a âncora (a de menor índice, com o
 * `sleep infinity`) fica de pé para a conversa continuar existindo e aceitar o próximo
 * turno sem precisar ressuscitar nada.
 *
 * Não inventa estado. Sem a janela e sem o `.code`, `estado()` já responde `interrompida`
 * — o mesmo caminho de um turno que morreu junto com o tmux, que é testado e destrava o
 * Enviar sozinho. Reenviar a mensagem é o desfazer.
 */
async function cancelarTurno(id) {
  const n = await turnoEmAndamento(id);
  if (n === null) return null;

  const meta = await lerMeta(id);
  // A mesma trava do encerrar(): fora do prefixo do cockpit não se mata nada. E nunca
  // kill-server — o socket é dedicado, mas as OUTRAS conversas do usuário vivem nele.
  if (!meta.tmux_session.startsWith(PREFIXO)) {
    throw new Error(`recusado: "${meta.tmux_session}" não é sessão do cockpit`);
  }

  const saida = await tmux(['list-windows', '-t', meta.tmux_session, '-F', '#{window_index}'], { silencioso: true });
  // `filter(Boolean)` antes do Number: a última linha do tmux vem vazia, e `Number('')`
  // é 0 — um índice válido, menor que o da âncora. Sem isto o cancelar matava a âncora.
  const indices = saida.split('\n').map((l) => l.trim()).filter(Boolean)
    .map(Number).filter((i) => Number.isInteger(i)).sort((a, b) => a - b);
  for (const indice of indices.slice(1)) {
    await tmux(['kill-window', '-t', `${meta.tmux_session}:${indice}`], { silencioso: true });
  }

  return { cancelado: true, turno: n };
}

/** Fecho de um turno, para o corpo da notificação. */
async function ultimoTextoDoTurno(id, n) {
  return ultimoTexto(pasta(id), n);
}

/** Caminhos dos arquivos de um turno — quem acompanha precisa deles. */
function arquivosDoTurno(id, n) {
  const dir = pasta(id);
  return { saida: path.join(dir, `turno-${n}.jsonl`), codigo: path.join(dir, `turno-${n}.code`) };
}

module.exports = {
  criar, listar, encerrar, excluir, rodarTurno, acompanhar, historico, turnoEmAndamento, uso,
  cancelarTurno,
  estado, perguntouNoFim, janelasPorSessao, guardarAnexo, arquivos, arquivoParaBaixar,
  ultimoTextoDoTurno,
  garantirViva,
  arquivosDoTurno, lerMeta, SOCKET, PREFIXO, RAIZ,
};
