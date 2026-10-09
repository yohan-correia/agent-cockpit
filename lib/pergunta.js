'use strict';
// A PERGUNTA DO AGENTE EM CARTÃO — as regras puras (spec 2026-10-08-pergunta-do-agente-em-cartao, D74).
//
// Quando o Claude Code abre uma AskUserQuestion, o texto da pergunta não está em lugar nenhum: o
// `.jsonl` só ganha o `tool_use` na resposta. O hook (`bin/gancho-pergunta.js`) grava o arquivo
// `<pasta>/<session_id>.json` ANTES do menu abrir; este módulo decide quando esse arquivo vale
// (`lerPendente`), valida o que o cartão devolve (`validarCorpo`/`validarRespostas`), monta as teclas
// (`planoDeTeclas`) e as executa CONFERINDO a tela a cada passo (`executar`).
//
// A tela da TUI nunca produz conteúdo nem destaque aqui (D4/D57): o conteúdo vem do arquivo do hook, e
// a tela só pode dizer NÃO — `confere()` devolve true/false, e o "não" para a sequência antes da
// próxima tecla. O pior erro possível desta leitura é recusar uma resposta válida (o dono cai no
// terminal cru), nunca escolher a opção errada. Em dúvida, `null`/`false`.
//
// Só `node:*`, nada do repo: testável sozinho (`testes/gate-pergunta.js`, contra a TUI falsa).
// `lib/abas.js` é quem faz tmux, fila por aba e identidade — aqui a E/S entra injetada em `executar`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TETO_TEXTO = 500;
const PRAZO_PASSO_MS = 1500;
const INTERVALO_MS = 100;
const ORCAMENTO_MS = 30000;
const PRAZO_RESPOSTA_MS = 3000;
const JANELA_GANCHO_MS = 60000;
const TETO_LEITURA = 16 * 1024 * 1024;
// O arquivo do hook nunca passa de 256 KB (o hook não grava acima); folga para ler sem surpresa.
const TETO_ARQUIVO_HOOK = 300 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_FERRAMENTA = /^[A-Za-z0-9_-]{1,128}$/;
// C0, DEL, C1, U+2028 e U+2029: quebra de linha, ESC, controle. Escritos por escape no fonte.
const CONTROLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Erro TIPADO (mesma forma de lib/abas.js): o código vem junto; `parcial` quando alguma tecla já saiu. */
const erro = (codigo, mensagem, extra) => Object.assign(new Error(mensagem), { codigo }, extra);

const ehObjeto = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const soChaves = (o, chaves) => ehObjeto(o) && Object.keys(o).length === chaves.length
  && chaves.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const textoOk = (s, min, max) => typeof s === 'string' && s.length >= min && s.length <= max && !CONTROLE.test(s);
const colapsar = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Onde o hook grava (lida em tempo de chamada: o gate troca o ambiente entre os casos). */
const dirPerguntas = () => process.env.COCKPIT_PERGUNTAS_DIR || path.join(os.homedir(), '.cockpit', 'perguntas');

// ---- o hook está instalado? (card pergunta-sem-gancho-avisa) ----------------------------------------

// O aviso de "hook não instalado" (spec 2026-10-09-pergunta-sem-gancho-avisa §3). `null` em `lerPendente` NÃO
// é sinal — tem seis causas legítimas com o hook instalado. O sinal é a CONFIGURAÇÃO: o `PreToolUse` de algum
// settings carregado cita um `gancho-pergunta.js` que existe. Só leitura: nada aqui escreve em lugar nenhum.
// Em dúvida (`nao-sei`), o aviso cala — o pior erro desta leitura é não avisar, nunca avisar à toa.
const TETO_SETTINGS = 1024 * 1024;
const NOME_GANCHO = /["']?([^\s"']*gancho-pergunta\.js)/;
// caminho → { mtimeMs, size, ino, achados } — `achados` = os caminhos de script citados por um `PreToolUse`
// que casa AskUserQuestion, ou 'nao-sei'. Relê só quando o `stat` muda. Sem relógio, sem watcher.
const cacheSettings = new Map();

/** O `matcher` do Claude Code: ausente/""/"*" casa tudo; senão regex do nome inteiro; regex inválida = exato. */
function casaPergunta(matcher) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test('AskUserQuestion'); } catch { return matcher === 'AskUserQuestion'; }
}

/** O conteúdo de um settings → os scripts citados, ou 'nao-sei' em qualquer forma inesperada. */
function scriptsDoSettings(dados) {
  if (!ehObjeto(dados)) return 'nao-sei';
  if (dados.hooks === undefined) return [];
  if (!ehObjeto(dados.hooks)) return 'nao-sei';
  const pre = dados.hooks.PreToolUse;
  if (pre === undefined) return [];
  if (!Array.isArray(pre)) return 'nao-sei';
  const achados = [];
  for (const item of pre) {
    if (!ehObjeto(item)) return 'nao-sei';
    if (item.matcher !== undefined && typeof item.matcher !== 'string') return 'nao-sei';
    if (!Array.isArray(item.hooks)) return 'nao-sei';
    for (const h of item.hooks) {
      if (!ehObjeto(h)) return 'nao-sei';
      if (h.type !== 'command') continue;
      if (typeof h.command !== 'string') return 'nao-sei';
      const m = NOME_GANCHO.exec(h.command);
      if (m && casaPergunta(item.matcher)) achados.push(m[1]);
    }
  }
  return achados;
}

/** Um settings → `null` (não existe), 'nao-sei', ou a lista de scripts citados. Cache por mtime+size+ino. */
function lerSettings(arquivo) {
  let st;
  try {
    st = fs.statSync(arquivo);
  } catch (e) {
    cacheSettings.delete(arquivo);
    return e && e.code === 'ENOENT' ? null : 'nao-sei';
  }
  const c = cacheSettings.get(arquivo);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size && c.ino === st.ino) return c.achados;
  let achados;
  try {
    achados = st.size > TETO_SETTINGS ? 'nao-sei' : scriptsDoSettings(JSON.parse(fs.readFileSync(arquivo, 'utf8')));
  } catch {
    achados = 'nao-sei';
  }
  cacheSettings.set(arquivo, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, achados });
  return achados;
}

/**
 * O script citado existe? `true` | `false` | 'nao-sei'. Caminho não absoluto não dá para conferir: vale como
 * instalado. Só `ENOENT`/`ENOTDIR` (ou não ser arquivo) é "não existe"; outro erro de `stat` (EACCES, EIO) é
 * dúvida — "não consegui olhar" não pode virar "hook não instalado" (achado do painel do plano, rodada 1).
 */
function scriptExiste(caminho) {
  if (!path.isAbsolute(caminho)) return true;
  try {
    return fs.statSync(caminho).isFile();
  } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? false : 'nao-sei';
  }
}

/**
 * 'instalado' | 'ausente' | 'nao-sei' (spec §3). `arquivos` = os settings que a aba carrega
 * (`arquivosDeSettings`). Achar o hook em qualquer um vence; senão, qualquer dúvida vence o "ausente".
 * Nunca lança. O `stat` do script roda a cada chamada: é o que pega o script apagado sem mexer no settings.
 */
function estadoDoGancho({ arquivos } = {}) {
  try {
    if (!Array.isArray(arquivos)) return 'nao-sei';
    let duvida = false;
    for (const arquivo of arquivos) {
      const achados = lerSettings(arquivo);
      if (achados === 'nao-sei') { duvida = true; continue; }
      for (const script of achados || []) {
        const existe = scriptExiste(script);
        if (existe === true) return 'instalado';
        if (existe === 'nao-sei') duvida = true;
      }
    }
    return duvida ? 'nao-sei' : 'ausente';
  } catch {
    return 'nao-sei';
  }
}

/** Os settings que o Claude Code junta para uma aba: o do usuário e os de projeto do `cwd`. Sem repetir. */
function arquivosDeSettings(cwd) {
  const lista = [path.join(os.homedir(), '.claude', 'settings.json')];
  if (typeof cwd === 'string' && cwd) {
    lista.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  }
  return [...new Set(lista)];
}

// ---- o formato da pergunta (V6) -----------------------------------------------------------------

/**
 * `tool_input.questions` do hook → o formato do cartão, ou `null`. Estrito de propósito (#10): chave
 * desconhecida (ex.: `preview`) pode mudar o desenho da TUI, e a sequência de teclas não foi medida
 * para ela — vira terminal cru.
 */
function validarPerguntas(brutas) {
  if (!Array.isArray(brutas) || brutas.length < 1 || brutas.length > 4) return null;
  const vistos = new Set();
  const saida = [];
  for (const q of brutas) {
    if (!soChaves(q, ['question', 'header', 'options', 'multiSelect'])) return null;
    if (!textoOk(q.question, 1, 2000) || !textoOk(q.header, 1, 60)) return null;
    if (typeof q.multiSelect !== 'boolean') return null;
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return null;
    if (vistos.has(q.question)) return null;
    vistos.add(q.question);
    const opcoes = [];
    for (const o of q.options) {
      if (!soChaves(o, ['label', 'description'])) return null;
      if (!textoOk(o.label, 1, 200) || !textoOk(o.description, 0, 2000)) return null;
      opcoes.push({ rotulo: o.label, descricao: o.description });
    }
    saida.push({ texto: q.question, cabecalho: q.header, multipla: q.multiSelect, opcoes });
  }
  return saida;
}

// ---- a pergunta pendente (V2-V6) ----------------------------------------------------------------

/** Lê `[offset, fim)` do arquivo. `null` se não existe/ilegível/menor que o offset/grande demais. */
function lerDepoisDoOffset(arquivo, offset) {
  let fd = null;
  try {
    fd = fs.openSync(arquivo, 'r');
    const tamanho = fs.fstatSync(fd).size;
    if (tamanho < offset || tamanho - offset > TETO_LEITURA) return null;
    const buf = Buffer.alloc(tamanho - offset);
    let lido = 0;
    while (lido < buf.length) {
      const n = fs.readSync(fd, buf, lido, buf.length - lido, offset + lido);
      if (n <= 0) break;
      lido += n;
    }
    return buf.subarray(0, lido);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* já fechado */ } }
  }
}

/**
 * V2-V6 da spec §4.2. A cola (`lib/abas.js: perguntaPendente`) faz a V1 (agente/esperando/…) antes de
 * chamar. Devolve `{ toolUseId, perguntas, offset }` ou `null` — em QUALQUER dúvida. Nunca lança.
 */
function lerPendente({ dir, sessaoId, arquivo, statusDesde } = {}) {
  try {
    if (typeof dir !== 'string' || typeof arquivo !== 'string') return null;
    if (typeof sessaoId !== 'string' || !UUID.test(sessaoId)) return null;
    const caminho = path.join(dir, `${sessaoId}.json`);
    if (fs.statSync(caminho).size > TETO_ARQUIVO_HOOK) return null;
    const d = JSON.parse(fs.readFileSync(caminho, 'utf8'));
    // V2
    if (!ehObjeto(d) || d.versao !== 1 || d.sessionId !== sessaoId) return null;
    if (typeof d.toolUseId !== 'string' || !ID_FERRAMENTA.test(d.toolUseId)) return null;
    if (typeof d.transcript !== 'string' || !Number.isInteger(d.offset) || d.offset < 0 || !Number.isFinite(d.em)) return null;
    // V3 — o offset só significa algo no MESMO arquivo; realpath cobre HOME com link.
    if (fs.realpathSync(d.transcript) !== fs.realpathSync(arquivo)) return null;
    // V4 — arquivo órfão não vira cartão. Negativo (o waiting antes do gancho) também é null.
    if (!Number.isFinite(statusDesde)) return null;
    const atraso = statusDesde - d.em;
    if (atraso < 0 || atraso > JANELA_GANCHO_MS) return null;
    // V6
    const perguntas = validarPerguntas(d.perguntas);
    if (!perguntas) return null;
    // V5 — a pergunta acabou quando o `tool_result` dela entra no .jsonl (respondida OU recusada: o
    // Esc também grava um). O `tool_use` sozinho NÃO diz nada: até a 2.1.294 ele só chegava junto do
    // resultado, mas a 2.1.295 o grava ~420 ms depois do gancho, com a pergunta ainda aberta (medido
    // em 08/10, #93). Formato desconhecido (`nao-sei`) também é `null` (#10).
    // `.jsonl` menor que o offset ou ilegível sai como `nao-sei` e também derruba.
    if (situacaoNoArquivo(arquivo, d.offset, d.toolUseId) !== 'ausente') return null;
    return { toolUseId: d.toolUseId, perguntas, offset: d.offset };
  } catch {
    return null;
  }
}

// ---- resposta × recusa --------------------------------------------------------------------------

/**
 * O que o `.jsonl` diz da pergunta, a partir do offset: `'respondida'` (tool_result sem `is_error` e com
 * `toolUseResult.answers` objeto), `'recusada'` (`is_error: true` — alguém mandou Esc), `'ausente'`
 * (sem linha) ou `'nao-sei'` (linha com o id em formato desconhecido, ou arquivo ilegível — #10).
 * Linha cortada no fim (ainda sendo escrita) só atrasa um tique (#11).
 */
function situacaoNoArquivo(arquivo, offset, toolUseId) {
  const buf = lerDepoisDoOffset(arquivo, offset);
  if (buf === null) return 'nao-sei';
  const texto = buf.toString('utf8');
  const partes = texto.split('\n');
  const ultimaIncompleta = !texto.endsWith('\n');
  let desconhecido = false;
  for (let i = 0; i < partes.length; i += 1) {
    const linha = partes[i];
    if (!linha.includes(toolUseId)) continue;
    let obj;
    try { obj = JSON.parse(linha); } catch {
      if (!(i === partes.length - 1 && ultimaIncompleta)) desconhecido = true;
      continue;
    }
    const conteudo = obj && obj.message && obj.message.content;
    const itens = Array.isArray(conteudo) ? conteudo : [];
    const resultado = itens.find((c) => c && c.type === 'tool_result' && c.tool_use_id === toolUseId);
    if (resultado) {
      if (resultado.is_error === true) return 'recusada';
      if (ehObjeto(obj.toolUseResult) && ehObjeto(obj.toolUseResult.answers)) return 'respondida';
      desconhecido = true;
      continue;
    }
    if (!itens.some((c) => c && c.type === 'tool_use' && c.id === toolUseId)) desconhecido = true;
  }
  return desconhecido ? 'nao-sei' : 'ausente';
}

/**
 * A regra inteira do fim (§4.6.5): o `.jsonl` manda; sem linha, o arquivo do hook decide — o
 * `PostToolUse` só dispara na RESPOSTA (o Esc não dispara), então arquivo sumido ou de outro id =
 * respondida (rede para formato do `.jsonl` que mude, #10); ainda com o id = ainda não sei.
 */
function situacaoFinal({ arquivo, offset, toolUseId, dir, sessaoId }) {
  const s = situacaoNoArquivo(arquivo, offset, toolUseId);
  if (s !== 'ausente') return s;
  if (typeof sessaoId !== 'string' || !UUID.test(sessaoId)) return 'ausente';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, `${sessaoId}.json`), 'utf8'));
    return ehObjeto(d) && d.toolUseId === toolUseId ? 'ausente' : 'respondida';
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'respondida' : 'ausente';
  }
}

// ---- o que o cliente manda (400) ----------------------------------------------------------------

/** A FORMA do corpo (§4.4.1). Devolve `{ toolUseId, respostas }` ou lança 400. */
function validarCorpo(corpo) {
  if (!soChaves(corpo, ['toolUseId', 'respostas'])) throw erro(400, 'corpo inválido: esperado { toolUseId, respostas }');
  if (typeof corpo.toolUseId !== 'string' || !ID_FERRAMENTA.test(corpo.toolUseId)) throw erro(400, 'toolUseId inválido');
  if (!Array.isArray(corpo.respostas)) throw erro(400, 'respostas deve ser uma lista');
  for (const r of corpo.respostas) {
    if (!soChaves(r, ['opcoes', 'texto'])) throw erro(400, 'cada resposta deve ter só { opcoes, texto }');
    if (!Array.isArray(r.opcoes) || !r.opcoes.every(Number.isInteger)) throw erro(400, 'opcoes deve ser uma lista de inteiros');
    if (typeof r.texto !== 'string') throw erro(400, 'texto deve ser uma string');
  }
  return { toolUseId: corpo.toolUseId, respostas: corpo.respostas.map((r) => ({ opcoes: r.opcoes.slice(), texto: r.texto })) };
}

/**
 * O CONTEÚDO contra a pergunta pendente (§4.4.6). Devolve as respostas normalizadas (opções em ordem
 * crescente, texto aparado) ou lança 400. Texto com controle é RECUSADO, não limpo.
 */
function validarRespostas(perguntas, respostas) {
  if (!Array.isArray(respostas) || respostas.length !== perguntas.length) throw erro(400, 'uma resposta por pergunta, na ordem');
  return respostas.map((r, i) => {
    const p = perguntas[i];
    const m = p.opcoes.length;
    const vistas = new Set();
    for (const k of r.opcoes) {
      if (k < 0 || k >= m) throw erro(400, `a opção ${k} não existe na pergunta ${i + 1}`);
      if (vistas.has(k)) throw erro(400, `a opção ${k} repetida na pergunta ${i + 1}`);
      vistas.add(k);
    }
    if (CONTROLE.test(r.texto)) throw erro(400, `o texto da pergunta ${i + 1} tem caractere de controle`);
    const texto = r.texto.trim();
    if (texto.length > TETO_TEXTO) throw erro(400, `o texto da pergunta ${i + 1} passa de ${TETO_TEXTO} caracteres`);
    const opcoes = [...vistas].sort((a, b) => a - b);
    if (!p.multipla) {
      if (opcoes.length + (texto ? 1 : 0) !== 1) throw erro(400, `a pergunta ${i + 1} pede uma opção OU um texto`);
    } else if (opcoes.length === 0 && !texto) {
      throw erro(400, `a pergunta ${i + 1} precisa de ao menos uma opção ou um texto`);
    }
    return { opcoes, texto };
  });
}

// ---- o plano de teclas --------------------------------------------------------------------------

/**
 * §4.5. Só dígitos 1-4, `Down`, `Enter` e texto literal — NUNCA Escape, Up, Left, Right nem Tab. Cada
 * passo carrega a `espera` que a tela tem de mostrar DEPOIS dele (e que vira a pré-condição do
 * seguinte). O último passo espera `{ tipo: 'final' }`: a resposta, lida do `.jsonl`.
 */
function planoDeTeclas(perguntas, respostas) {
  const n = perguntas.length;
  const passos = [];
  const tecla = (valor, espera) => passos.push({ tipo: 'tecla', valor, espera });
  const texto = (valor, espera) => passos.push({ tipo: 'texto', valor, espera });
  const unicaSimples = n === 1 && !perguntas[0].multipla;
  // O que a tela mostra quando a pergunta i está fechada.
  const depois = (i) => {
    if (unicaSimples) return { tipo: 'final' };
    return i < n - 1 ? { tipo: 'aba', q: i + 1 } : { tipo: 'revisao' };
  };
  perguntas.forEach((p, i) => {
    const m = p.opcoes.length;
    const r = respostas[i];
    const descer = (ate) => { for (let j = 1; j <= ate; j += 1) tecla('Down', { tipo: 'cursor', q: i, alvo: j + 1 }); };
    if (!p.multipla) {
      if (r.opcoes.length) { tecla(String(r.opcoes[0] + 1), depois(i)); return; }
      descer(m);
      texto(r.texto, { tipo: 'texto', q: i, texto: r.texto });
      tecla('Enter', depois(i));
      return;
    }
    for (const k of r.opcoes) tecla(String(k + 1), { tipo: 'marca', q: i, opcao: k });
    descer(m);
    if (r.texto) texto(r.texto, { tipo: 'texto', q: i, texto: r.texto });
    tecla('Down', { tipo: 'cursor', q: i, alvo: i < n - 1 ? 'next' : 'submit' });
    tecla('Enter', depois(i));
  });
  if (!unicaSimples) tecla('Enter', { tipo: 'final' });
  return passos;
}

// ---- a leitura da tela (verificação, não fonte) -------------------------------------------------

const SEPARADOR = /^─{10,}\s*$/;
const BARRA = /^←\s+(.+?)\s+✔ Submit\s+→\s*$/;
const UNICA = /^ ☐ (\S.*?)\s*$/;
const OPCAO = /^(?:(❯) |  )(\d+)\. (.*?)\s*$/;
const NAVEGACAO = /^(?:(❯) |  )   (Next|Submit)\s*$/;

/** Sai o `│` que a TUI põe em pergunta longa (medido, telas e1/e7 e m1-01/m1-11). */
const semBarra = (l) => l.replace(/\r$/, '').replace(/^\s*│ ?/, '');

/**
 * Lê o trecho da tela que importa: da ÚLTIMA barra de abas (`←  ☐ h1  ☐ h2  ✔ Submit  →`) — ou, na
 * pergunta única simples, da linha ` ☐ <header>` — até o primeiro separador `────`. O histórico de cima
 * (onde o `❯` do composer também aparece) fica de fora por construção. `null` sem âncora.
 */
function lerMenu(tela) {
  if (typeof tela !== 'string') return null;
  const linhas = tela.split('\n').map(semBarra);
  let ancora = -1;
  linhas.forEach((l, i) => { if (BARRA.test(l) || UNICA.test(l)) ancora = i; });
  if (ancora < 0) return null;
  let abas;
  const b = BARRA.exec(linhas[ancora]);
  if (b) {
    abas = (b[1].match(/[☐☒] .+?(?=  +[☐☒] |$)/g) || []).map((s) => ({ marca: s[0], cabecalho: s.slice(2).trim() }));
  } else {
    abas = [{ marca: '☐', cabecalho: UNICA.exec(linhas[ancora])[1] }];
  }
  const regiao = [];
  for (let i = ancora + 1; i < linhas.length; i += 1) {
    if (SEPARADOR.test(linhas[i])) break;
    regiao.push(linhas[i]);
  }
  const opcoes = [];
  let nav = null;
  regiao.forEach((l, i) => {
    const o = OPCAO.exec(l);
    if (o) { opcoes.push({ n: Number(o[2]), cursor: Boolean(o[1]), resto: o[3], linha: i }); return; }
    const v = NAVEGACAO.exec(l);
    if (v) nav = { cursor: Boolean(v[1]), rotulo: v[2] };
  });
  const comCursor = [...opcoes.filter((o) => o.cursor).map((o) => ({ tipo: 'opcao', n: o.n, resto: o.resto })),
    ...(nav && nav.cursor ? [{ tipo: 'nav', rotulo: nav.rotulo }] : [])];
  return {
    abas,
    regiao,
    texto: colapsar(regiao.join(' ')),
    opcoes,
    nav,
    // Só vale se for UM cursor; dois `❯` na região = tela que não é a que o cartão conhece.
    cursor: comCursor.length === 1 ? comCursor[0] : null,
  };
}

const MARCA = /^\[(✔| )\] (.*)$/;

function conferir(tela, espera, perguntas, respostas) {
  if (!espera || !Array.isArray(perguntas) || perguntas.length === 0) return false;
  const menu = lerMenu(tela);
  if (!menu) return false;
  const n = perguntas.length;
  const temPergunta = (q) => Boolean(perguntas[q]) && menu.texto.includes(colapsar(perguntas[q].texto));
  const cabecalhosIguais = () => menu.abas.length === n && menu.abas.every((a, i) => colapsar(a.cabecalho) === colapsar(perguntas[i].cabecalho));
  const cursorEm = (alvo) => {
    const c = menu.cursor;
    if (!c) return false;
    if (typeof alvo === 'number') return c.tipo === 'opcao' && c.n === alvo;
    return c.tipo === 'nav' && c.rotulo.toLowerCase() === alvo;
  };
  const q = espera.q;

  switch (espera.tipo) {
    case 'inicio': {
      const p = perguntas[0];
      const m = p.opcoes.length;
      if (!cabecalhosIguais() || !menu.abas.every((a) => a.marca === '☐') || !temPergunta(0)) return false;
      if (menu.opcoes.length !== m + 1 || menu.opcoes.some((o, i) => o.n !== i + 1)) return false;
      for (let k = 0; k < m; k += 1) {
        let resto = menu.opcoes[k].resto;
        if (p.multipla) {
          const mk = MARCA.exec(resto);
          if (!mk || mk[1] !== ' ') return false;
          resto = mk[2];
        }
        if (colapsar(resto) !== colapsar(p.opcoes[k].rotulo)) return false;
      }
      let livre = menu.opcoes[m].resto;
      if (p.multipla) {
        const mk = MARCA.exec(livre);
        if (!mk) return false;
        livre = mk[2];
      }
      if (!livre.startsWith('Type something')) return false;
      if (p.multipla ? !menu.nav || menu.nav.rotulo !== (n > 1 ? 'Next' : 'Submit') : Boolean(menu.nav)) return false;
      return cursorEm(1);
    }
    case 'cursor':
      return temPergunta(q) && cursorEm(espera.alvo);
    case 'marca': {
      const o = perguntas[q] && menu.opcoes[espera.opcao];
      if (!temPergunta(q) || !o || o.n !== espera.opcao + 1) return false;
      const mk = MARCA.exec(o.resto);
      return Boolean(mk) && mk[1] === '✔' && colapsar(mk[2]) === colapsar(perguntas[q].opcoes[espera.opcao].rotulo);
    }
    case 'texto': {
      if (!temPergunta(q)) return false;
      const m = perguntas[q].opcoes.length;
      const o = menu.opcoes[m];
      if (!o || o.n !== m + 1 || !cursorEm(m + 1)) return false;
      // Texto longo QUEBRA no campo (medido, tela f1: na palavra, recuo 5 embaixo): junta as linhas de
      // continuação até a próxima opção, a navegação ou uma linha vazia. O campo não tem descrição.
      let resto = o.resto;
      for (let i = o.linha + 1; i < menu.regiao.length; i += 1) {
        const l = menu.regiao[i];
        if (!l.trim() || OPCAO.test(l) || NAVEGACAO.test(l)) break;
        resto += ` ${l.trim()}`;
      }
      if (perguntas[q].multipla) {
        const mk = MARCA.exec(resto);
        if (!mk || mk[1] !== '✔') return false;
        resto = mk[2];
      }
      return colapsar(resto) === colapsar(espera.texto);
    }
    case 'aba': {
      if (!cabecalhosIguais() || !temPergunta(q) || !cursorEm(1)) return false;
      if (!menu.abas.every((a, i) => i >= q || a.marca === '☒')) return false;
      if (perguntas[q].multipla && menu.opcoes.some((o) => /^\[✔\]/.test(o.resto))) return false;
      return true;
    }
    case 'revisao': {
      if (!Array.isArray(respostas) || respostas.length !== n) return false;
      if (!cabecalhosIguais() || !menu.abas.every((a) => a.marca === '☒')) return false;
      const c = menu.cursor;
      if (!c || c.tipo !== 'opcao' || c.n !== 1 || c.resto !== 'Submit answers') return false;
      const inicio = menu.regiao.findIndex((l) => l.trim() === 'Review your answers');
      const fim = menu.regiao.findIndex((l) => l.trim() === 'Ready to submit your answers?');
      if (inicio < 0 || fim < inicio) return false;
      const blocos = [];
      for (const l of menu.regiao.slice(inicio + 1, fim)) {
        const t = l.trim();
        if (!t) continue;
        if (t.startsWith('●')) blocos.push(t.slice(1)); else if (blocos.length) blocos[blocos.length - 1] += ` ${t}`;
      }
      if (blocos.length !== n) return false;
      return blocos.every((bloco, i) => {
        const b = colapsar(bloco);
        const enunciado = colapsar(perguntas[i].texto);
        if (!b.startsWith(enunciado)) return false;
        const resto = b.slice(enunciado.length);
        const seta = resto.indexOf('→');
        if (seta < 0) return false;
        const resposta = resto.slice(seta + 1);
        const r = respostas[i];
        if (!r || (r.opcoes.length === 0 && !r.texto)) return false;
        // EXATA, não "contém" (painel de execução): tira o texto e cada rótulo pedido; o que sobrar
        // além de vírgula, aspas e espaço é uma resposta que ninguém pediu — uma opção marcada no
        // terminal no meio do envio, por exemplo — e o Enter final não sai. O texto sai primeiro: ele
        // pode conter um rótulo.
        let sobra = resposta;
        const tirar = (trecho) => {
          const j = sobra.indexOf(trecho);
          if (j < 0) return false;
          sobra = sobra.slice(0, j) + sobra.slice(j + trecho.length);
          return true;
        };
        if (r.texto && !tirar(colapsar(r.texto))) return false;
        const rotulos = r.opcoes.map((k) => perguntas[i].opcoes[k] && colapsar(perguntas[i].opcoes[k].rotulo));
        if (rotulos.some((x) => !x)) return false;
        for (const rotulo of [...rotulos].sort((a, b) => b.length - a.length)) if (!tirar(rotulo)) return false;
        return sobra.replace(/[\s,"]/g, '') === '';
      });
    }
    default:
      return false;
  }
}

/**
 * A conferência de §4.7: `espera` = `{ tipo: 'inicio' | 'cursor' | 'marca' | 'texto' | 'aba' | 'revisao', … }`.
 * Devolve true/false e NUNCA lança — um `confere` que estoura não pode apagar o terminal cru.
 */
function confere(tela, espera, perguntas, respostas) {
  try { return conferir(tela, espera, perguntas, respostas) === true; } catch { return false; }
}

// ---- executar conferindo ------------------------------------------------------------------------

const DESCRICAO = {
  cursor: 'o cursor na posição esperada',
  marca: 'a opção marcada',
  texto: 'o texto digitado',
  aba: 'a próxima pergunta',
  revisao: 'a revisão das respostas',
};

/**
 * §4.6 — fail-closed. Antes de CADA tecla: identidade da aba + captura nova que ainda casa o estado
 * esperado depois do passo anterior (o passo 0 casa o `inicio`). É o que fecha a janela do Parar, que
 * manda `Escape` FORA da fila por aba: se ele fechar o menu entre dois passos, a pré-condição do
 * seguinte falha e a tecla não sai. Depois de cada tecla, espera o efeito (100 ms em 100 ms, até
 * 1500 ms). Não veio → para ali, 409 `parcial`. Orçamento total de 30 s. O último passo espera a
 * RESPOSTA do `.jsonl`, distinguindo de recusa.
 *
 * `io = { capturar, tecla, texto, identidade, situacao, espera, agora, cancelado? }` — tudo injetado (o gate roda
 * sem tmux). `capturar` é o `capture-pane` CRU, nunca o `moldarTela`. `identidade()` devolve o motivo
 * (string) quando a aba mudou, ou falso.
 */
async function executar(passos, { perguntas, respostas, io, orcamentoMs = ORCAMENTO_MS }) {
  const t0 = io.agora();
  let enviadas = 0;
  const falhar = (mensagem) => { throw erro(409, mensagem, enviadas > 0 ? { parcial: true } : {}); };
  const estourou = () => io.agora() - t0 > orcamentoMs;
  const FRASE_ORCAMENTO = 'tempo esgotado no meio do envio; termine a pergunta pelo terminal';
  const chamar = async (f, frase) => { try { return await f(); } catch { return falhar(frase); } };

  for (let i = 0; i < passos.length; i += 1) {
    const passo = passos[i];
    const anterior = i === 0 ? { tipo: 'inicio' } : passos[i - 1].espera;
    if (estourou()) falhar(FRASE_ORCAMENTO);
    const motivo = await chamar(() => io.identidade(), 'não consegui conferir a aba; confira o terminal');
    if (motivo) falhar(String(motivo));
    const antes = await chamar(() => io.capturar(), 'não consegui ler o terminal; confira por lá');
    if (!confere(antes, anterior, perguntas, respostas)) {
      falhar(i === 0
        ? 'a pergunta já foi mexida no terminal; termine por lá'
        : 'o terminal mudou no meio do envio (a pergunta pode ter sido fechada); confira o terminal');
    }
    // O Parar com o cartão respondendo NÃO manda Escape (lib/abas.js, `cancelarRespostaEmCurso`): ele
    // marca, e a marca é lida AQUI, de forma síncrona, sem nenhum `await` entre ela e o send-keys —
    // não sobra janela entre a última conferência e a tecla (painel de execução).
    if (io.cancelado && io.cancelado()) falhar('o envio foi interrompido pelo Parar; termine a pergunta pelo terminal');
    enviadas += 1;
    await chamar(() => (passo.tipo === 'texto' ? io.texto(passo.valor) : io.tecla(passo.valor)), 'não consegui mandar a tecla ao terminal; confira por lá');
    if (passo.espera.tipo === 'final') break;
    const inicioDoPasso = io.agora();
    for (;;) {
      if (estourou()) falhar(FRASE_ORCAMENTO);
      const tela = await chamar(() => io.capturar(), 'não consegui ler o terminal; confira por lá');
      if (confere(tela, passo.espera, perguntas, respostas)) break;
      if (io.agora() - inicioDoPasso >= PRAZO_PASSO_MS) {
        falhar(`o terminal não mostrou ${DESCRICAO[passo.espera.tipo] || 'o efeito esperado'} (passo ${i + 1} de ${passos.length}); termine a pergunta pelo terminal${passo.tipo === 'texto' ? ' — o texto pode ter ficado na caixa dele' : ''}`);
      }
      await io.espera(INTERVALO_MS);
    }
  }

  if (!passos.length || passos[passos.length - 1].espera.tipo !== 'final') falhar('plano sem passo final');
  const inicioDaResposta = io.agora();
  for (;;) {
    const s = await chamar(() => io.situacao(), 'não consegui confirmar a resposta; confira o terminal');
    if (s === 'respondida') return { respondido: true };
    if (s === 'recusada') falhar('a pergunta foi cancelada no terminal durante o envio');
    if (io.agora() - inicioDaResposta >= PRAZO_RESPOSTA_MS) falhar('mandei o envio mas não consegui confirmar; confira o terminal');
    await io.espera(INTERVALO_MS);
  }
}

module.exports = {
  TETO_TEXTO,
  PRAZO_PASSO_MS,
  INTERVALO_MS,
  ORCAMENTO_MS,
  PRAZO_RESPOSTA_MS,
  JANELA_GANCHO_MS,
  TETO_LEITURA,
  dirPerguntas,
  estadoDoGancho,
  arquivosDeSettings,
  validarPerguntas,
  lerPendente,
  situacaoNoArquivo,
  situacaoFinal,
  validarCorpo,
  validarRespostas,
  planoDeTeclas,
  lerMenu,
  confere,
  executar,
};
