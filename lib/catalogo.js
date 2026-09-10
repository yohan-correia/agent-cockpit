'use strict';
// Catálogo de comandos e skills que o agente entende — serve o autocomplete do "/" no cliente.
//
// Só sai daqui NOME e DESCRIÇÃO. O corpo dos arquivos é do usuário e não tem por que trafegar
// numa resposta HTTP; o autocomplete só precisa saber o que existe e o que cada coisa faz.
//
// Cache de 60s porque são ~170 arquivos espalhados em quatro raízes e o cliente pede isto
// toda vez que alguém digita "/". Ler o disco a cada tecla seria desperdício puro.
//
// Nenhum caminho vem do cliente. O cwd do projeto é derivado do meta.json da sessão, nunca
// do que o navegador mandou — ver a rota em server.js.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const RAIZ_CLAUDE = path.join(os.homedir(), '.claude');
const TTL_MS = 60_000;

const cache = new Map(); // chave (cwd ou '') -> { em, itens }

/**
 * Descrição de um arquivo de skill/comando.
 * Frontmatter YAML quando existe (`description:`); senão a primeira linha de prosa —
 * várias skills antigas do usuário não têm frontmatter e começam direto no título.
 */
function descrever(texto) {
  const bloco = texto.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (bloco) {
    const linha = bloco[1].split('\n').find((l) => /^description\s*:/i.test(l));
    if (linha) {
      return linha.replace(/^description\s*:\s*/i, '').replace(/^["']|["']$/g, '').trim().slice(0, 240);
    }
  }
  const prosa = texto
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('>'));
  return (prosa || '').slice(0, 240);
}

async function ler(arquivo) {
  try {
    // 8 KB bastam para o frontmatter e a primeira linha de prosa; alguns SKILL.md têm 40 KB.
    const fd = await fsp.open(arquivo, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fd.close();
    }
  } catch {
    return '';
  }
}

/** `<dir>/*.md` → um comando por arquivo. Ignora `.md.bak-*` e afins por não terminarem em .md. */
async function comandosDe(dir, origem) {
  let nomes = [];
  try {
    nomes = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const alvos = nomes.filter((n) => n.endsWith('.md'));
  return Promise.all(alvos.map(async (arquivo) => ({
    nome: arquivo.slice(0, -3),
    tipo: 'comando',
    origem,
    descricao: descrever(await ler(path.join(dir, arquivo))),
  })));
}

/** `<dir>/<nome>/SKILL.md` → uma skill por pasta. */
async function skillsDe(dir, origem, prefixo = '') {
  let entradas = [];
  try {
    entradas = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pastas = entradas.filter((d) => d.isDirectory());
  const achadas = await Promise.all(pastas.map(async (d) => {
    const texto = await ler(path.join(dir, d.name, 'SKILL.md'));
    if (!texto) return null;
    return { nome: prefixo + d.name, tipo: 'skill', origem, descricao: descrever(texto) };
  }));
  return achadas.filter(Boolean);
}

/** Skills de plugin: cache/<marketplace>/<plugin>/<versao>/skills/<nome>/SKILL.md → `plugin:nome`. */
async function skillsDePlugins() {
  const raiz = path.join(RAIZ_CLAUDE, 'plugins', 'cache');
  const achadas = [];
  let marketplaces = [];
  try {
    marketplaces = await fsp.readdir(raiz, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const mercado of marketplaces.filter((d) => d.isDirectory())) {
    const dirMercado = path.join(raiz, mercado.name);
    let plugins = [];
    try {
      plugins = await fsp.readdir(dirMercado, { withFileTypes: true });
    } catch { continue; }
    for (const plugin of plugins.filter((d) => d.isDirectory())) {
      const dirPlugin = path.join(dirMercado, plugin.name);
      let versoes = [];
      try {
        versoes = await fsp.readdir(dirPlugin, { withFileTypes: true });
      } catch { continue; }
      for (const versao of versoes.filter((d) => d.isDirectory())) {
        achadas.push(...await skillsDe(
          path.join(dirPlugin, versao.name, 'skills'), 'plugin', `${plugin.name}:`,
        ));
      }
    }
  }
  return achadas;
}

/**
 * Rótulo dos comandos que o CLI traz dentro de si. Eles não existem como arquivo em lugar
 * nenhum do disco, então o nome viria pelado no autocomplete.
 *
 * Isto é só legenda, NUNCA fonte de verdade: um comando só aparece se o CLI o declarar no
 * `slash_commands` da sessão. Se a Anthropic tirar algum daqui, ele some sozinho da tela.
 */
const EMBUTIDOS = {
  clear: 'Limpa o contexto e recomeça a conversa do zero.',
  compact: 'Resume a conversa para liberar contexto sem perder o fio.',
  context: 'Mostra quanto da janela de contexto já está em uso.',
  usage: 'Consumo do plano e quanto falta para o limite.',
  cost: 'Custo acumulado desta conversa.',
  model: 'Troca o modelo desta sessão.',
  status: 'Diagnóstico da sessão, da conta e da instalação.',
  config: 'Configurações do Claude Code.',
  doctor: 'Checa a saúde da instalação.',
  agents: 'Gerencia os subagentes disponíveis.',
  init: 'Cria um CLAUDE.md descrevendo o projeto.',
  help: 'Lista o que a sessão entende.',
  memory: 'Abre os arquivos de memória do projeto.',
  review: 'Revisa um pull request.',
  todos: 'Lista de tarefas da sessão.',
  export: 'Exporta a conversa.',
  rewind: 'Volta a conversa para um ponto anterior.',
  resume: 'Retoma uma conversa anterior.',
};

/** Tudo que existe no disco, indexado por nome. */
async function doDisco(cwd) {
  const chave = cwd || '';
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.em < TTL_MS) return guardado.itens;

  const buscas = [
    comandosDe(path.join(RAIZ_CLAUDE, 'commands'), 'global'),
    skillsDe(path.join(RAIZ_CLAUDE, 'skills'), 'global'),
    skillsDePlugins(),
  ];
  if (cwd) {
    buscas.push(
      comandosDe(path.join(cwd, '.claude', 'commands'), 'projeto'),
      skillsDe(path.join(cwd, '.claude', 'skills'), 'projeto'),
    );
  }

  const peso = { projeto: 0, global: 1, plugin: 2 };
  const vistos = new Set();
  const itens = (await Promise.all(buscas))
    .flat()
    .sort((a, b) => (peso[a.origem] - peso[b.origem]) || a.nome.localeCompare(b.nome))
    // Comando de projeto ganha do global de mesmo nome — é o que o CLI faz.
    .filter((i) => !vistos.has(i.nome) && vistos.add(i.nome));

  cache.set(chave, { em: Date.now(), itens });
  return itens;
}

const PESO = { projeto: 0, global: 1, plugin: 2, embutido: 3 };

const porPeso = (a, b) => (PESO[a.origem] - PESO[b.origem]) || a.nome.localeCompare(b.nome);

/**
 * Tudo que o agente aceita depois de uma barra.
 *
 * Quem manda é `declarados`: a lista que o próprio CLI publica no `init` da sessão. Ela
 * inclui os embutidos (/clear, /context, /compact) que não existem como arquivo e que o
 * disco, sozinho, jamais encontraria. O disco entra só para dar a descrição de cada um.
 *
 * Sem `declarados` o disco é o que temos — e é o caso NORMAL desde que o cockpit virou a
 * tela das abas do terminal: ali o CLI é do usuário, o cockpit nunca rodou o `init` do
 * stream-json e nunca vai ter essa lista. Antes disso o autocomplete perdia justamente o
 * /clear e o /compact, os dois comandos que ele mais usa do celular. Nesse caso os
 * embutidos entram pela legenda, sem substituir nada que exista no disco.
 *
 * @param {string} [cwd] diretório da sessão; traz também `<cwd>/.claude/commands` e `/skills`.
 * @param {string[]} [declarados] nomes vindos do `slash_commands` do CLI.
 */
async function listar(cwd, declarados, agente = 'claude') {
  if (agente === 'codex') return require('./catalogo-codex').listar(cwd);
  const disco = await doDisco(cwd);
  if (!Array.isArray(declarados) || !declarados.length) {
    const noDisco = new Set(disco.map((i) => i.nome));
    const extras = Object.keys(EMBUTIDOS)
      .filter((nome) => !noDisco.has(nome))
      .map((nome) => ({ nome, tipo: 'comando', origem: 'embutido', descricao: EMBUTIDOS[nome] }));
    // Cópia, não `disco.sort()`: o array do disco é o que fica no cache.
    return [...disco, ...extras].sort(porPeso);
  }

  const porNome = new Map(disco.map((i) => [i.nome, i]));
  return declarados
    .map((nome) => porNome.get(nome) || {
      nome,
      tipo: 'comando',
      origem: 'embutido',
      descricao: EMBUTIDOS[nome] || '',
    })
    .sort(porPeso);
}

module.exports = { listar };
