'use strict';
// Os passos de UM sub-agente, lidos do arquivo PRÓPRIO dele — `<conversa sem .jsonl>/subagents/agent-<id>.jsonl`
// (spec docs/superpowers/specs/2026-10-16-ver-os-subagentes-da-aba-design.md §4.2, D86). A fita principal continua
// descartando `isSidechain` (lib/externo.js): isto só roda quando o dono ABRE o cartão do sub-agente.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { linhasDoArquivo, idDeAgenteValido } = require('./externo');

const TETO_PASSOS = 200;
const TETO_RESPOSTA = 20000;
const TETO_CAMPO = 300;
// Só o que `alvoDaFerramenta` (public/app.js) lê — nunca o `content` de um Write nem o `new_string` de um Edit.
const CAMPOS_DA_ENTRADA = ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'skill', 'description', 'prompt', 'subagent_type'];

const idValido = idDeAgenteValido;

/** A pasta onde o CLI guarda os sub-agentes desta conversa — irmã do `.jsonl`, sem a extensão. */
function pastaDosSubagentes(arquivo) {
  return path.join(arquivo.replace(/\.jsonl$/, ''), 'subagents');
}

/**
 * O caminho do `.jsonl` de UM sub-agente, achado pelo `id` (se válido) ou varrendo os
 * `agent-*.meta.json` da pasta até achar o `toolUseId` que bate com `ferramenta`.
 *
 * Trava de caminho (spec §4.2): os dois parâmetros passam por `idValido` antes de virar nome de
 * arquivo, e o resultado é conferido com `path.dirname(resultado) === pasta` — nada fora da
 * pasta é aberto, nunca.
 */
async function acharArquivo(arquivo, { ferramenta, id } = {}) {
  const pasta = pastaDosSubagentes(arquivo);
  const dentro = (nome) => {
    const c = path.join(pasta, nome);
    return path.dirname(c) === pasta ? c : null;
  };

  // `id` FORNECIDO (≠ undefined/null) e inválido → null na hora, sem fallback para `ferramenta`:
  // a rota já devolve 400 antes, mas a biblioteca não confia em quem chama (painel r1, Codex #4).
  if (id !== undefined && id !== null) {
    if (!idValido(id)) return null;
    const c = dentro(`agent-${id}.jsonl`);
    if (c) {
      try { await fsp.access(c); return c; } catch { /* segue para o fallback por ferramenta */ }
    }
  }

  if (!idValido(ferramenta)) return null;

  let nomes;
  try { nomes = await fsp.readdir(pasta); } catch { return null; }
  for (const nome of nomes) {
    const m = /^agent-([\w-]+)\.meta\.json$/.exec(nome);
    if (!m) continue;
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(path.join(pasta, nome), 'utf8'));
    } catch (e) {
      console.warn('subagente: meta ilegível', e.code || e.name);
      continue;
    }
    if (meta.toolUseId !== ferramenta) continue;
    const c = dentro(`agent-${m[1]}.jsonl`);
    if (!c) continue;
    try { await fsp.access(c); return c; } catch { continue; }
  }
  return null;
}

/** Só os campos que a tela sabe desenhar, cada um cortado em `TETO_CAMPO` — nunca o corpo de um Write/Edit. */
function resumir(input) {
  const resumo = {};
  for (const campo of CAMPOS_DA_ENTRADA) {
    const valor = input && input[campo];
    if (typeof valor === 'string') resumo[campo] = valor.slice(0, TETO_CAMPO);
  }
  return resumo;
}

/**
 * O arquivo INTEIRO de um sub-agente, virando `{ passos, total, tipos, resposta, respostaCortada,
 * terminou, inicio, fim }` — ou `null` se o arquivo não existe (spec §4.2).
 */
async function lerSubagente(caminho) {
  try {
    await fsp.stat(caminho);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }

  const todos = [];
  const porId = new Map();
  const tipos = new Map();
  let inicio = null;
  let fim = null;
  let ultimoTexto = null;
  let ultimaAssistant = null;

  for await (const l of linhasDoArquivo(caminho)) {
    if (!l.trim()) continue;
    let obj;
    try { obj = JSON.parse(l); } catch { continue; }

    if (typeof obj.timestamp === 'string' && obj.timestamp) {
      if (inicio === null) inicio = obj.timestamp;
      fim = obj.timestamp;
    }

    if (obj.type === 'assistant') {
      const partes = obj.message?.content || [];
      for (const parte of partes) {
        if (parte.type !== 'tool_use') continue;
        const passo = { id: parte.id, nome: parte.name, entrada: resumir(parte.input), estado: 'rodando', t: obj.timestamp };
        todos.push(passo);
        porId.set(parte.id, passo);
        tipos.set(parte.name, (tipos.get(parte.name) || 0) + 1);
      }
      const texto = partes.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      if (texto.trim()) ultimoTexto = texto;
      ultimaAssistant = { stop: obj.message?.stop_reason, temTool: partes.some((p) => p.type === 'tool_use') };
      continue;
    }

    if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      for (const parte of obj.message.content) {
        if (parte.type !== 'tool_result') continue;
        const passo = porId.get(parte.tool_use_id);
        if (!passo) continue;
        passo.estado = parte.is_error ? 'erro' : 'feita';
        passo.tFim = obj.timestamp;
      }
    }
  }

  return {
    passos: todos.slice(-TETO_PASSOS),
    total: todos.length,
    tipos: [...tipos],
    resposta: ultimoTexto ? ultimoTexto.slice(0, TETO_RESPOSTA) : null,
    respostaCortada: Boolean(ultimoTexto && ultimoTexto.length > TETO_RESPOSTA),
    terminou: Boolean(ultimaAssistant && !ultimaAssistant.temTool && ['end_turn', 'stop_sequence'].includes(ultimaAssistant.stop)),
    inicio,
    fim,
  };
}

module.exports = { idValido, pastaDosSubagentes, acharArquivo, lerSubagente, TETO_PASSOS };
