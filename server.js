#!/usr/bin/env node
// Cockpit de Agentes — HTTP puro, zero dependência (mesmo padrão do painel-externo).
//
// O que ele é: a casca de conversa por cima das CLIs oficiais, para falar com os agentes
// do celular e do desktop. As CLIs continuam sendo quem roda — é o login delas que carrega
// a assinatura do usuário (docs/arquitetura.md, D2).
//
// O que ele NÃO é: o painel de jobs. Aquele é o `painel-externo` na 7878, só leitura, e
// continua intocado. Porta própria aqui para que um bug deste lado não derrube aquela tela.
//
// Transporte: SSE para receber, POST para enviar. O tráfego é assimétrico (muitos eventos
// descendo, uma frase subindo de vez em quando) e SSE reconecta sozinho no navegador —
// WebSocket traria handshake e reconexão manual sem ganho.
//
// Escuta em localhost por padrão. Acesso remoto depende da configuração da instância.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { X509Certificate, randomUUID } = require('node:crypto');
const sessoes = require('./lib/sessoes');
const catalogo = require('./lib/catalogo');
const limite = require('./lib/limite');
const avisos = require('./lib/avisos');
const vigiaAbas = require('./lib/vigia-abas');
const abas = require('./lib/abas');
const lidas = require('./lib/lidas');
const leituras = require('./lib/leituras');
const agentes = require('./lib/agentes');
const externo = require('./lib/externo');
const contexto = require('./lib/contexto');
const statusCodex = require('./lib/status-codex');
const arquivos = require('./lib/arquivos');
const uso = require('./lib/uso');
const usoCodex = require('./lib/uso-codex');
const jobs = require('./lib/jobs');
const revisar = require('./lib/revisar');
const adaptadorJob = require('./lib/adaptador-job');
const acesso = require('./lib/acesso');
const monitor = require('./lib/monitor');
const disco = require('./lib/monitor-disco');
// Faixa PROD FORA (D87): só leitura do estado do vigia de prod.
const sites = require('./lib/sites');
const financas = require('./lib/financas');
const terminou = require('./lib/terminou');
const confianca = require('./lib/confianca');
const subagente = require('./lib/subagente');
const grafoLoja = require('./lib/grafo-loja');
const grafoGit = require('./lib/grafo-git');
const grafoInventario = require('./lib/grafo-inventario');
const grafoFazer = require('./lib/grafo-fazer');
const grafoMapa = require('./lib/grafo-mapa');
const diff = require('./lib/diff');
const github = require('./lib/github');
// Um escritor, dois leitores (D69, S6): o GET /api/abas e o vigia de push chamam `abas.listar()`
// por esta função, que anota `terminouEm` em cada aba.
const listarAbasComFim = terminou.listarComFim({ listar: abas.listar, mapaDeLidas: lidas.mapa });

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 7879);
const HOST = process.env.HOST || '127.0.0.1';
// Obrigatório fora de localhost: /api exige "Authorization: Bearer <token>" ou ?token=.
// Sem token, o acesso fica restrito a localhost com validação de origem e Host.
const TOKEN = process.env.COCKPIT_TOKEN || '';
acesso.validarConfiguracao(HOST, TOKEN);
const RAIZ_PROJETOS = process.env.COCKPIT_PROJETOS_DIR || path.join(os.homedir(), 'projetos');
if (!path.isAbsolute(RAIZ_PROJETOS)) throw new Error('COCKPIT_PROJETOS_DIR precisa ser um caminho absoluto.');
// Whitelist FECHADA de `/api/uso?dias=`, não `Number()` livre (plano §2.1). Sem ela,
// `?dias=99999` faz o servidor somar 274 anos de agregado por request — mesma disciplina do
// whitelist de `projeto` em POST /api/abas.
const DIAS_ACEITOS = new Set([1, 7, 30]);

// HTTPS não é enfeite aqui: o navegador só libera service worker, instalação do app e
// notificação em contexto seguro (HTTPS ou localhost). Em `http://<ip>` o cockpit nunca
// vai passar de uma aba — o sw.js estava lá desde o início e jamais chegou a registrar.
//
// HTTPS pode terminar no proxy ou usar certificado e chave configurados nesta instância.
// Um par explicitamente configurado precisa ser válido; sem TLS configurado, usa HTTP.
const DIR_CERT = process.env.COCKPIT_CERT_DIR || path.join(os.homedir(), '.cockpit', 'cert');
if (Boolean(process.env.COCKPIT_TLS_CERT) !== Boolean(process.env.COCKPIT_TLS_KEY)) {
  throw new Error('Configure COCKPIT_TLS_CERT e COCKPIT_TLS_KEY juntos.');
}

function lerCertificado() {
  try {
    const cert = fs.readFileSync(process.env.COCKPIT_TLS_CERT || path.join(DIR_CERT, 'servidor.crt'));
    const key = fs.readFileSync(process.env.COCKPIT_TLS_KEY || path.join(DIR_CERT, 'servidor.key'));
    const nome = new X509Certificate(cert).subject.replace(/^CN=/, '').trim();
    return { cert, key, nome };
  } catch (e) {
    if (process.env.COCKPIT_TLS_CERT || process.env.COCKPIT_TLS_KEY) throw e;
    return null;
  }
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function enviarJson(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(texto),
    'cache-control': 'no-store',
  });
  res.end(texto);
}

/**
 * Recusa ANTES de consumir o corpo (R58/R36): o cliente pode já estar mandando 2 GB quando
 * o 400/413/429/507 sai, e drenar isso tudo para manter o keep-alive seria pagar o upload
 * inteiro para dizer não. `connection: close`, o JSON, e o socket destruído no callback do
 * `res.end` — depois do flush, para o JSON ter chance de chegar antes do reset.
 */
function recusar(req, res, codigo, mensagem) {
  // É o SOCKET da resposta que diz se há para quem responder — não `req.destroyed`: depois
  // de um `pipeline` que terminou, o `IncomingMessage` já está destruído (autoDestroy) com o
  // socket vivo, e olhar o `req` deixaria a conexão pendurada sem resposta (visto no gate).
  const socket = res.socket;
  if (res.headersSent || res.destroyed || !socket || socket.destroyed) {
    if (socket && !socket.destroyed) socket.destroy();
    return;
  }
  const texto = JSON.stringify({ erro: mensagem });
  res.writeHead(codigo, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(texto),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(texto, () => socket.destroy());
}

async function enviarArquivo(res, arquivo) {
  try {
    const dados = await fsp.readFile(arquivo);
    res.writeHead(200, {
      'content-type': TIPOS[path.extname(arquivo)] || 'application/octet-stream',
      'content-length': dados.length,
      'cache-control': 'no-cache',
    });
    res.end(dados);
  } catch {
    enviarJson(res, 404, { erro: 'nao encontrado' });
  }
}

/** Mesma coisa, mas com cache longo: assets do dashboard do grafo têm hash de conteúdo no nome. */
async function enviarArquivoImutavel(res, arquivo) {
  try {
    const dados = await fsp.readFile(arquivo);
    res.writeHead(200, {
      'content-type': TIPOS[path.extname(arquivo)] || 'application/octet-stream',
      'content-length': dados.length,
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(dados);
  } catch {
    enviarJson(res, 404, { erro: 'nao encontrado' });
  }
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    req.on('data', (b) => {
      bruto += b;
      if (bruto.length > 1e6) {
        // `destroy` não é detalhe: sem ele a promessa rejeita mas o socket continua
        // despejando na memória até o cliente cansar.
        req.destroy();
        reject(new Error('corpo grande demais'));
      }
    });
    req.on('end', () => {
      try { resolve(bruto ? JSON.parse(bruto) : {}); } catch { reject(new Error('json inválido')); }
    });
  });
}

// Imagem de celular passa de 1 MB com folga, e o corpo do turno é JSON. Anexo vem cru,
// num caminho próprio, direto para o disco.
const TETO_ANEXO = 20 * 1024 * 1024;
const TIPOS_ANEXO = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function lerBinario(req, teto) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    req.on('data', (b) => {
      total += b.length;
      if (total > teto) {
        req.destroy();
        return reject(new Error(`arquivo maior que ${Math.round(teto / 1e6)} MB`));
      }
      pedacos.push(b);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(pedacos)));
  });
}

/** Projetos disponíveis para abrir sessão. Conveniência: evita digitar caminho no celular. */
async function listarProjetos() {
  const raiz = RAIZ_PROJETOS;
  try {
    const nomes = await fsp.readdir(raiz, { withFileTypes: true });
    return nomes
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ nome: d.name, cwd: path.join(raiz, d.name) }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  } catch {
    return [];
  }
}

// Nome de pasta que a aba nova pode criar (card `criar-pasta-na-aba-nova`): letras, números, - e _, até
// 64, começando por letra ou número. Sem espaço e sem ponto — o tmux troca `.` por `_` no nome da janela.
// A MESMA régua mora em `public/app.js` (`NOME_DE_PASTA`); mudou uma, muda a outra.
const NOME_DE_PASTA = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** "É a mesma pasta para um humano": sem acento, sem caixa. A mesma chave do filtro da tela (`normalizarBusca`). */
const chaveDePasta = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
// Checar e criar em FILA (S16): dois pedidos simultâneos (`Dup-A` e `dup-a`) leriam a mesma lista e
// criariam os dois — o Linux distingue caixa e o EEXIST só pega o nome exato.
let filaDePastas = Promise.resolve();

// ─── /grafo/<projeto>/ — dashboard do grafo (sempre o da develop) ───────────
// Spec `2026-10-16-grafo-do-projeto-no-cockpit`, #16/#18/#22: casca estática responde 200/404 só
// pelo FORMATO do nome (NOME_DE_PASTA), sem oráculo de existência; os dados (com token) é que
// conferem se o projeto existe e tem grafo. Nomes de dado iguais aos que `public/grafo/ponte.js`
// reescreve.
const DADOS_DO_GRAFO = new Set(['/knowledge-graph.json', '/meta.json', '/config.json', '/staleness.json',
  '/domain-graph.json', '/diff-overlay.json', '/file-content.json']);

const LINGUAGEM_POR_EXTENSAO = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  py: 'python', html: 'markup', htm: 'markup', css: 'css', json: 'json', md: 'markdown', txt: 'text',
};
function linguagemPorExtensao(caminho) {
  const ext = path.posix.extname(caminho).slice(1).toLowerCase();
  return LINGUAGEM_POR_EXTENSAO[ext] || 'text';
}

/** `{graphs:{knowledge: <GraphFreshnessResult>}}` — envelope que o dashboard valida (`freshness.ts`). */
async function rotaDeStaleness(res, repo, grafo) {
  const d = await grafoGit.refDaDevelop(repo);
  if (!d) {
    return enviarJson(res, 200, { graphs: { knowledge: {
      status: 'unknown', reason: 'graph-commit-unavailable', graphCommitHash: grafo.sha,
    } } });
  }
  const resultado = await grafoInventario.freshnessDoGrafo(repo, grafo.sha, d.sha, grafo.analyzedAt);
  return enviarJson(res, 200, { graphs: { knowledge: resultado } });
}

/** O conteúdo é sempre da VERSÃO do grafo (nunca do checkout) — #18, `git show <sha>:<caminho>`. */
async function rotaDeFileContent(res, repo, pasta, grafoAtual, url) {
  const caminhoRaw = url.searchParams.get('path') || '';
  if (!caminhoRaw || caminhoRaw.includes('\0') || path.posix.isAbsolute(caminhoRaw)) {
    return enviarJson(res, 400, { erro: 'path invalido' });
  }
  const normalizado = path.posix.normalize(caminhoRaw);
  if (normalizado === '..' || normalizado.startsWith('../') || path.posix.isAbsolute(normalizado)) {
    return enviarJson(res, 400, { erro: 'path invalido' });
  }

  const shaParam = url.searchParams.get('sha');
  let grafoEscolhido = grafoAtual;
  if (shaParam) {
    if (shaParam === grafoAtual.sha) {
      grafoEscolhido = grafoAtual;
    } else {
      const anterior = grafoLoja.resumoDoGrafo(pasta, { anterior: true });
      if (anterior && shaParam === anterior.sha) grafoEscolhido = anterior;
      else return enviarJson(res, 409, { erro: 'o grafo mudou, recarregue' });
    }
  }

  if (!grafoEscolhido.arquivos.has(normalizado)) return enviarJson(res, 404, { erro: 'arquivo fora do grafo' });

  const conteudoBuf = await grafoGit.conteudo(repo, grafoEscolhido.sha, normalizado);
  if (conteudoBuf === null) return enviarJson(res, 404, { erro: 'nao encontrado' });
  if (conteudoBuf.length > 1024 * 1024) return enviarJson(res, 413, { erro: 'arquivo grande demais' });
  if (conteudoBuf.includes(0)) return enviarJson(res, 415, { erro: 'arquivo binario' });

  const content = conteudoBuf.toString('utf8');
  return enviarJson(res, 200, {
    path: normalizado,
    language: linguagemPorExtensao(normalizado),
    content,
    sizeBytes: conteudoBuf.length,
    lineCount: content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length,
  });
}

/** Dado do grafo (com token): existência (repo em `listarProjetos()`, é repo, tem grafo) só aqui. */
async function rotaDeDadosDoGrafo(req, res, nome, resto, url) {
  if (!tokenDoPedidoOk(req, url)) return enviarJson(res, 401, { erro: 'token inválido' });
  const projeto = (await listarProjetos()).find((p) => p.nome === nome);
  if (!projeto) return enviarJson(res, 404, { erro: 'sem grafo' });
  const repo = await grafoGit.repoPrincipal(projeto.cwd);
  if (!repo) return enviarJson(res, 404, { erro: 'sem grafo' });
  const pasta = grafoLoja.pastaDo(nome);
  // Só o resumo enxuto fica em memória (sha, data, arquivos); o grafo inteiro sai direto do disco.
  const grafo = grafoLoja.resumoDoGrafo(pasta);
  if (!grafo) return enviarJson(res, 404, { erro: 'sem grafo' });

  if (resto === '/knowledge-graph.json') return enviarArquivo(res, grafoLoja.arquivoDoGrafo(pasta, false));
  if (resto === '/meta.json') return enviarJson(res, 200, JSON.parse(await fsp.readFile(path.join(pasta, 'meta.json'), 'utf8')));
  if (resto === '/domain-graph.json') return enviarJson(res, 200, null);
  if (resto === '/diff-overlay.json' || resto === '/config.json') return enviarJson(res, 200, {});
  if (resto === '/staleness.json') return rotaDeStaleness(res, repo, grafo);
  if (resto === '/file-content.json') return rotaDeFileContent(res, repo, pasta, grafo, url);
  return enviarJson(res, 404, { erro: 'nao encontrado' });
}

/**
 * Tabela fechada do mapa (M6): fora de `token`, só `{}` (nível 1), `{camada}`/`{camada,pasta}`
 * (nível 2) ou `{arquivo}`/`{arquivo,completo=1}` (nível 3) passam; qualquer outra combinação,
 * chave fora da lista ou chave repetida → `null` (o chamador devolve 400 ANTES de ler a loja).
 */
function validarParametrosDoMapa(url) {
  const permitidas = new Set(['camada', 'pasta', 'arquivo', 'completo']);
  const vistas = new Set();
  for (const chave of url.searchParams.keys()) {
    if (chave === 'token') continue;
    if (!permitidas.has(chave) || vistas.has(chave)) return null;
    vistas.add(chave);
  }
  const tem = (k) => vistas.has(k);
  if (vistas.size === 0) return { modo: 1 };
  if (tem('camada') && !tem('arquivo') && !tem('completo') && (vistas.size === 1 || (vistas.size === 2 && tem('pasta')))) {
    return { modo: 2, camada: url.searchParams.get('camada'), pasta: tem('pasta') ? url.searchParams.get('pasta') : undefined };
  }
  if (tem('arquivo') && !tem('camada') && !tem('pasta')
    && (vistas.size === 1 || (vistas.size === 2 && tem('completo') && url.searchParams.get('completo') === '1'))) {
    return { modo: 3, arquivo: url.searchParams.get('arquivo'), completo: tem('completo') };
  }
  return null;
}

/**
 * Tabela fechada genérica (molde `validarParametrosDoMapa`, sem mexer nela): chave fora da
 * lista `permitidas` ou repetida → `null` (o chamador devolve 400 ANTES de ler disco/git).
 * `token` sempre ignorado.
 */
function parametrosFechados(url, permitidas) {
  const mapa = new Map();
  for (const chave of url.searchParams.keys()) {
    if (chave === 'token') continue;
    if (!permitidas.includes(chave) || mapa.has(chave)) return null;
    mapa.set(chave, url.searchParams.get(chave));
  }
  return mapa;
}

/** Projeto pelo NOME (card `ver-a-diff-do-codigo`, D95) — `{nome, repo}` ou `null`. Nada do cliente vira caminho (#22). */
async function projetoDoNome(nome) {
  if (!NOME_DE_PASTA.test(nome)) return null;
  const projeto = (await listarProjetos()).find((p) => p.nome === nome);
  if (!projeto) return null;
  const repo = await grafoGit.repoPrincipal(projeto.cwd);
  if (!repo) return null;
  return { nome: projeto.nome, repo };
}

/** Dados do mapa (card `grafo-mapa-simples`, D91): existência pelas MESMAS travas de `rotaDeDadosDoGrafo`. */
async function rotaDeMapaDoGrafo(res, nomeCru, url) {
  const pedido = validarParametrosDoMapa(url);
  if (!pedido) return enviarJson(res, 400, { erro: 'pedido inválido' });

  let nome;
  try { nome = decodeURIComponent(nomeCru); } catch { return enviarJson(res, 404, { erro: 'sem grafo' }); }
  if (!NOME_DE_PASTA.test(nome)) return enviarJson(res, 404, { erro: 'sem grafo' });

  const projeto = (await listarProjetos()).find((p) => p.nome === nome);
  if (!projeto) return enviarJson(res, 404, { erro: 'sem grafo' });
  const repo = await grafoGit.repoPrincipal(projeto.cwd);
  if (!repo) return enviarJson(res, 404, { erro: 'sem grafo' });
  const lido = grafoMapa.indiceDo(grafoLoja.pastaDo(nome));
  if (!lido) return enviarJson(res, 404, { erro: 'sem grafo' });
  const { indice, bytes } = lido;

  let corpo;
  if (pedido.modo === 1) corpo = grafoMapa.nivel1(indice);
  else if (pedido.modo === 2) corpo = grafoMapa.nivel2(indice, pedido.camada, pedido.pasta);
  else corpo = grafoMapa.nivel3(indice, pedido.arquivo, { completo: pedido.completo });
  if (!corpo) return enviarJson(res, 404, { erro: 'fora do grafo' });

  corpo.cabecalho.bytes = bytes;
  corpo.cabecalho.projeto = nome; // o nome validado da rota vence o `project.name` do grafo
  return enviarJson(res, 200, corpo);
}

/** Casca do dashboard: `/grafo` sem nome é 404 (sem página-índice — quem lista é o diálogo). */
async function rotaDoGrafo(req, res, rota, url) {
  const m = rota.match(/^\/grafo\/([^/]+)(\/.*)?$/);
  if (!m) return enviarJson(res, 404, { erro: 'nao encontrado' });
  let nome;
  try { nome = decodeURIComponent(m[1]); } catch { return enviarJson(res, 404, { erro: 'nao encontrado' }); }
  if (!NOME_DE_PASTA.test(nome)) return enviarJson(res, 404, { erro: 'nao encontrado' });
  const resto = m[2] || '';

  if (!resto) {
    res.writeHead(301, { location: `${nome}/${url.search || ''}` });
    return res.end();
  }
  if (resto === '/' || resto === '/index.html') return enviarArquivo(res, path.join(PUBLIC_DIR, 'grafo', 'ua', 'index.html'));
  if (resto === '/ponte.js') return enviarArquivo(res, path.join(PUBLIC_DIR, 'grafo', 'ponte.js'));
  if (DADOS_DO_GRAFO.has(resto)) return rotaDeDadosDoGrafo(req, res, nome, resto, url);

  // Estático dentro de public/grafo/ua/, preso à pasta — mesma trava de `:2242` (com separador).
  const baseUa = path.resolve(path.join(PUBLIC_DIR, 'grafo', 'ua'));
  const pedido = path.resolve(path.join(baseUa, resto));
  if (pedido !== baseUa && !pedido.startsWith(baseUa + path.sep)) return enviarJson(res, 403, { erro: 'fora do dashboard' });
  // Assets com hash de conteúdo no nome: cache longo (2,6 MB por abertura pesaria no celular).
  // index.html e ponte.js (acima) continuam no-cache.
  if (resto.startsWith('/assets/')) return enviarArquivoImutavel(res, pedido);
  return enviarArquivo(res, pedido);
}

/** Casca do mapa simples (D91): 200/404 só pelo FORMATO do nome, sem oráculo — igual à do dashboard. */
async function rotaDoMapa(res, rota, url) {
  const m = rota.match(/^\/mapa\/([^/]+)(\/.*)?$/);
  if (!m) return enviarJson(res, 404, { erro: 'nao encontrado' });
  let nome;
  try { nome = decodeURIComponent(m[1]); } catch { return enviarJson(res, 404, { erro: 'nao encontrado' }); }
  if (!NOME_DE_PASTA.test(nome)) return enviarJson(res, 404, { erro: 'nao encontrado' });
  const resto = m[2] || '';
  if (!resto) { res.writeHead(301, { location: `${nome}/${url.search || ''}` }); return res.end(); }
  if (resto === '/') return enviarArquivo(res, path.join(PUBLIC_DIR, 'mapa', 'index.html'));
  return enviarJson(res, 404, { erro: 'nao encontrado' });
}

/** Casca da diff de commit e de job (card `ver-a-diff-do-codigo`, D95): mesmo molde do mapa. */
async function rotaDoDiff(res, rota, url) {
  if (rota === '/diff') { res.writeHead(301, { location: `diff/${url.search || ''}` }); return res.end(); }
  if (rota === '/diff/' || rota === '/diff/index.html') return enviarArquivo(res, path.join(PUBLIC_DIR, 'diff', 'index.html'));
  return enviarJson(res, 404, { erro: 'nao encontrado' });
}

// Jobs do orquestrador. Até 2026-09-10 quem sabia o estado de um job era o `painel-externo`
// (um serviço à parte, na 7878), e esta rota só fazia um `http.get` nele — o que deixava um
// recurso do cockpit dependendo de um programa que não está neste repositório. Quem clonasse
// não tinha o painel, `COCKPIT_PAINEL_JOBS` ficava vazia e o grupo de jobs nunca aparecia.
// Agora quem lê o disco é `lib/jobs.js`, aqui dentro. `COCKPIT_PAINEL_JOBS` não é mais lida
// por ninguém: virar fallback manteria de pé exatamente a dependência que esta entrega existe
// para matar.

// Quem terminou BEM sai da vista em 1 HORA (decisão do dono, 11/09): `done`, `merged` e
// `teardown` são o fim feliz, e ninguém os relê. 24 h os empilhavam por cima do que importa.
// O nome mudou junto com o significado: esta janela não é mais "dos encerrados" — o `failed`
// também encerrou e NÃO é medido por ela (ver a isenção logo abaixo).
const JANELA_FIM_FELIZ_MS = 60 * 60 * 1000;
// §4.1.2 — teto de segurança do `?tudo=1`, e ele CEDE para quem exige ação: `running`,
// `blocked`, `orfao` e estado desconhecido nunca são cortados, só os encerrados (do mais
// antigo). Com os dados de hoje (16 linhas) o teto nem encosta — é rede, não regra do dia a dia.
const TETO_JOBS = 40;
// Os sete estados que o painel hoje emite (spec §2). Fora daqui é "desconhecido" — e
// desconhecido conta como PROTEGIDO (§4.2): o cockpit não sabe se ele exige ação, e no
// escuro se mostra, em vez de sumir ou fingir que sabe o que ele é.
const ESTADOS_CONHECIDOS = new Set(['running', 'done', 'teardown', 'failed', 'merged', 'blocked', 'orfao']);
// ALLOWLIST, não denylist (§4.1): `kind: null` (a linha do `status.log` que não bateu o
// formato esperado, `lib/jobs.js:97`) passaria por uma denylist `kind !== 'working'`
// carregando o TEXTO CRU do disco — medido: 1 job de 179 tem isso hoje. Allowlist protege do
// que o orquestrador inventar depois, sem avisar o cockpit.
const KINDS_DE_DESFECHO = new Set(['done', 'failed', 'blocked']);

/**
 * O desfecho de um job do disco (`lib/jobs.js`), pela mesma allowlist de `KINDS_DE_DESFECHO`.
 *
 * Extraído para ter UM DONO só: a rota `/api/jobs?tudo=1` (abaixo) e `acompanharJob` (a fonte
 * do fluxo SSE de um job, ver a seção SSE) precisam do MESMO cálculo, e escrevê-lo duas vezes
 * é a armadilha #40 — a regra se separa da legenda e uma das duas envelhece calada, e sem a
 * allowlist um evento `working` viraria "desfecho" na tela. `fim` fica de FORA desta função de
 * propósito: ele nasce em `lib/jobs.js` (`j.fim`, o TÉRMINO do trabalho — não a última linha,
 * que pode ser a faxina do teardown) e é consumido pela janela de 1 h, pelo `rank` e pela
 * ordenação antes do `.map` final — derivá-lo de novo aqui seria a mesma #40 de novo.
 */
function desfechoDoJob(j) {
  return KINDS_DE_DESFECHO.has(j.event?.kind) ? (j.event.text ?? null) : null;
}

// Quantos bytes de `result.md` a etiqueta "parou no limite" lê — só o INÍCIO do relatório,
// nunca o arquivo inteiro (ele pode chegar a 64 KB, ver TETO_RESULTADO abaixo).
const TETO_LEITURA_LIMITE = 4 * 1024;
const RE_PAROU_NO_LIMITE = /hit your (session )?limit/i;

/** A etiqueta "parou no limite" (plano 2026-10-04): só os primeiros 4 KB do `result.md`. */
async function paraNoLimite(id) {
  try {
    const caminho = path.join(limite.dirJobs(), id, 'result.md');
    const fd = await fsp.open(caminho, 'r');
    try {
      const buf = Buffer.alloc(TETO_LEITURA_LIMITE);
      const { bytesRead } = await fd.read(buf, 0, TETO_LEITURA_LIMITE, 0);
      return RE_PAROU_NO_LIMITE.test(buf.toString('utf8', 0, bytesRead));
    } finally { await fd.close().catch(() => {}); }
  } catch { return false; }
}

// Até quanto do `result.md` a etiqueta "pede decisão" lê. O `needs-decision:` costuma vir no FIM do
// relatório, depois de um `done:` (13 de 30 no disco, às vezes na linha 86) — por isso o arquivo inteiro,
// não os 4 KB do limite. O maior `result.md` medido tem 20 KB; o teto só existe pro pior caso.
const TETO_DECISAO = 1024 * 1024;

/**
 * 'pede' (há linha `needs-decision:`), 'nao' (não há, ou o job não deixou relatório) ou 'ilegivel'
 * (maior que o teto sem a linha, ou erro de leitura que não é ENOENT). Spec D3: "não consegui ler"
 * nunca vira "não pede decisão" — esse é o falso Pronto de volta.
 */
async function decisaoDoRelatorio(id) {
  let fd;
  try { fd = await fsp.open(path.join(limite.dirJobs(), id, 'result.md'), 'r'); } catch (e) {
    return e && e.code === 'ENOENT' ? 'nao' : 'ilegivel';
  }
  try {
    const { size } = await fd.stat();
    const buf = Buffer.alloc(Math.min(size, TETO_DECISAO));
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    if (revisar.pedeDecisaoNoTexto(buf.toString('utf8', 0, bytesRead))) return 'pede';
    return size > TETO_DECISAO ? 'ilegivel' : 'nao';
  } catch { return 'ilegivel'; } finally { await fd.close().catch(() => {}); }
}

// O teto do `/api/jobs/resultado` — o relatório inteiro do `result.md`, cortado em 64 KB.
const TETO_RESULTADO = 64 * 1024;

// ─── SSE ─────────────────────────────────────────────────────────────────────

/**
 * Fluxo de eventos de uma sessão: primeiro o histórico inteiro (do disco), depois o ao vivo.
 * O cliente pode cair e voltar quando quiser — a verdade nunca esteve nele.
 */
async function abrirFluxo(req, res, id) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const mandar = (evento) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evento)}\n\n`);
  };

  let acompanhando = null;
  try {
    const { meta, eventos } = await sessoes.historico(id);
    mandar({ tipo: 'sessao', meta });
    for (const evento of eventos) mandar(evento);

    const emAndamento = await sessoes.turnoEmAndamento(id);
    mandar({ tipo: 'sincronizado', turnoEmAndamento: emAndamento });

    if (emAndamento) {
      // Turno já rodando (o cliente chegou no meio): acompanha do início do arquivo.
      const arq = sessoes.arquivosDoTurno(id, emAndamento);
      acompanhando = sessoes.acompanhar(arq.saida, arq.codigo);
      acompanhando.on('evento', (e) => mandar({ ...e, turno: emAndamento }));
      acompanhando.on('fim', (f) => mandar({ tipo: 'turno_fim', ...f }));
    }
  } catch (erro) {
    mandar({ tipo: 'erro', mensagem: erro.message });
    return res.end();
  }

  // Novos turnos disparados enquanto este cliente está conectado.
  const aoTurno = ({ sessaoId, turno, arquivo, codigo }) => {
    if (sessaoId !== id) return;
    acompanhando?.parar?.();
    acompanhando = sessoes.acompanhar(arquivo, codigo);
    acompanhando.on('evento', (e) => mandar({ ...e, turno }));
    acompanhando.on('fim', (f) => mandar({ tipo: 'turno_fim', ...f }));
  };
  barramento.on('turno', aoTurno);

  // Sessão excluída embaixo dos pés deste cliente: sem isto, `acompanhar` ficaria
  // reagendando a cada 250ms para sempre, esperando um arquivo .code que nunca virá.
  const aoRemover = ({ sessaoId }) => {
    if (sessaoId !== id) return;
    acompanhando?.parar?.();
    mandar({ tipo: 'removida', id });
    res.end();
  };
  barramento.on('removida', aoRemover);

  const batida = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
  req.on('close', () => {
    clearInterval(batida);
    barramento.off('turno', aoTurno);
    barramento.off('removida', aoRemover);
    acompanhando?.parar?.();
  });
}

/**
 * Acompanha o turno DO LADO DO SERVIDOR só para notificar no fim.
 *
 * Não dá para pendurar isso no fluxo SSE: o ponto da notificação é justamente o usuário
 * NÃO estar com a tela aberta. Sem um vigia próprio, o único caso em que o aviso sairia
 * seria aquele em que ele não é necessário.
 */
function vigiarParaAvisar(id, turno, arquivo, codigo) {
  const vigia = sessoes.acompanhar(arquivo, codigo);
  vigia.on('fim', async () => {
    vigia.parar?.();
    try {
      const meta = await sessoes.lerMeta(id);
      if (!meta) return;
      const { pergunta } = await sessoes.estado(meta, await sessoes.janelasPorSessao());
      const fecho = await sessoes.ultimoTextoDoTurno(id, turno);
      await avisos.avisar({
        titulo: pergunta ? `${meta.titulo} precisa de você` : `${meta.titulo}: terminou`,
        corpo: (fecho || '').replace(/\s+/g, ' ').trim().slice(0, 180) || 'Turno concluído.',
        sessaoId: id,
      });
    } catch (erro) {
      console.error('não deu para avisar:', erro.message);
    }
  });
}

/**
 * O fluxo de uma ABA do terminal.
 *
 * Diferente do fluxo de sessão do cockpit em dois pontos: a fonte é o arquivo do CLI (o
 * cockpit não gerou turno nenhum aqui, então não há `.ndjson` dele para acompanhar), e o
 * fim do turno não é um arquivo `.code` aparecendo — é a linha de status da TUI parando de
 * dizer "esc to interrupt". Por isso o par de relógios: um lê o que cresceu no arquivo,
 * outro pergunta se ainda está rodando.
 */
/**
 * Acompanha UMA aba. Não abre HTTP nenhum — `mandar(evento)` é quem entrega, `aoEncerrar()`
 * é quem avisa que esta aba morreu (o cano continua vivo para as outras, R5). Retorno
 * SÍNCRONO: `{ parar, bater }`. A inicialização (o `sessao` inicial, a leitura da cauda do
 * arquivo, os relógios) roda num runner assíncrono por dentro, e `parar()` já existe antes de
 * qualquer `await` — fechar a página no primeiro segundo não pode deixar relógio órfão.
 */
function acompanharAba(chave, mandar, aoEncerrar) {
  let morto = false;
  // Limpezas registradas conforme a inicialização avança — o que existe é encerrado, o que
  // ainda não existe (a página fechou antes do primeiro `await` terminar) não precisa de nada.
  const aoParar = [];
  const parar = () => {
    if (morto) return;
    morto = true;
    aoParar.forEach((fn) => fn());
  };
  // `bater(linha)` é o corpo do relogioEstado de hoje, recebendo a linha da aba em vez de ir
  // buscá-la — quem tem o `setInterval` de 2 s agora é o CANO (um por cano, não um por aba,
  // R22). Antes de o runner terminar, é no-op: o estado inicial ainda está sendo montado.
  let bater = () => {};
  const alvo = { parar, bater: (linha) => bater(linha) };

  (async () => {
    const aba = await abas.buscar(chave);
    if (morto) return;
    if (!aba) {
      mandar({ tipo: 'erro', mensagem: 'essa aba não está mais aberta no terminal' });
      return aoEncerrar();
    }

    // QUEM lê esta aba, resolvido UMA vez no topo do fluxo. O `server.js` deixa de saber de
    // qual CLI se trata: quem sabe é o registro, e as assinaturas casam de propósito (o
    // adaptador do Codex é espelho de `lib/externo.js` + `lib/contexto.js`, não do
    // `adaptador-claude.js`). Aba sem agente, ou com um id que não existe, cai no padrão — é o
    // fail-safe que mantém o duble do `gate-troca-arquivo.js` funcionando.
    const { leitor, medidor } = agentes.de(aba.agente);

    // Quanto da janela do agente já está ocupado. Sai junto do `sessao` porque é a mesma
    // identidade da conversa que o topo do chat desenha — título, pasta e "quanto ainda cabe".
    // Vem `null` quando a cauda do arquivo não tem `usage` reconhecível, e aí a tela
    // simplesmente não mostra o medidor. Ver lib/contexto.js.
    const ctxInicial = await medidor.doArquivo(aba.arquivo);
    if (morto) return;
    // A régua do "mudou" do relógio de baixo: uma STRING, não o objeto. Ela nasce com o
    // contexto que este `sessao` acabou de mandar — nunca `undefined`, nunca a chave de um
    // arquivo que não é o da tela. Sem isto, depois de um `/clear` a conversa nova herdaria a
    // chave da velha e o primeiro contexto de verdade seria engolido (armadilha #33).
    let ultimoContexto = contexto.chaveDoContexto(ctxInicial);
    mandar({
      tipo: 'sessao',
      // `sessaoId` viaja aqui e em toda troca de arquivo (ver `bater` abaixo): é o que o
      // cliente guarda para recusar `status_codex` de outra sessão (a guarda de identidade
      // do /status, spec `2026-09-08-resposta-status-codex-design.md`).
      meta: { titulo: aba.titulo, cwd: aba.cwd, contexto: ctxInicial, sessaoId: aba.sessaoId || null,
        reiniciada: Boolean(aba.reiniciada) },
    });

    // A janela longa é config do CLI, e config é I/O. Lida UMA vez por fluxo, aqui, onde já
    // nascem as outras coisas de vida longa do SSE: ler isso a cada 700 ms seria I/O novo pela
    // porta dos fundos, e ela não muda entre uma batida e outra.
    //
    // E só para o CLAUDE: o teto do Codex vem dentro do próprio rollout
    // (`model_context_window`), então toda a heurística de `[1m]`/200k/1M fica de fora — ler o
    // `settings.json` do Claude para desenhar o medidor de outro CLI seria a #40.
    const longa = aba.agente === 'claude' ? await contexto.janelaLongaConfigurada() : false;
    if (morto) return;

    let lido = 0;
    if (aba.arquivo) {
      // Leitura inicial é a CAUDA do arquivo, cortada por NÚMERO DE MENSAGENS, não por byte
      // (ver lib/externo.js). O maior .jsonl do disco tem 44 MB: despejar tudo fazia a
      // conversa inteira passar na tela do celular antes de dar para digitar. `cortado`
      // avisa a tela de que o começo ficou de fora — sem isso o usuário veria o histórico
      // começar no meio de um assunto sem saber por quê.
      const lida = await leitor.lerConversa(aba.arquivo, 0);
      if (morto) return;
      // `null` é a ABSTENÇÃO do leitor: o arquivo existe, as linhas parseiam, e o esquema é um
      // que ele não sabe ler (o Codex trocou o da fita inteiro em quatro semanas). Fita vazia
      // seria indistinguível de conversa nova, e mentiria; dizer que não sabe, não.
      if (lida === null) {
        mandar({ tipo: 'erro', mensagem: 'não sei ler esta conversa — o formato do CLI mudou' });
      } else {
        const { eventos, tamanho, cortado, inicio } = lida;
        if (cortado) mandar({ tipo: 'historico_cortado', inicio });
        // D-b: a leitura inicial despeja a cauda inteira do histórico. Um `humano` que voltou
        // do disco é o servidor sabendo que aquele texto já saiu da fila — a pendente daquela
        // aba que casar com ele (por texto E por tempo) é consumida ANTES de reemitir nada.
        for (const evento of eventos) {
          if (evento.tipo === 'humano') abas.consumirPendente(chave, evento.texto, evento.quando);
          mandar(evento);
        }
        lido = tamanho;
      }
    } else {
      // Sem arquivo, a razão importa: a aba pode ter acabado de nascer (o CLI leva ~1,6 s
      // para escrever `~/.claude/sessions/<pid>.json`) ou o claude pode ter falhado em subir
      // nela. Texto fixo aqui é a #40 — descrever com uma frase só um estado que passou a ser
      // transitório. Continua `tipo: 'erro'`, que é o único tipo que o cliente sabe desenhar —
      // mas este ramo manda o evento DEPOIS do `sessao`, então ele SOBREVIVE ao `limparFita()`
      // do cliente (ao contrário do que este comentário dizia até 02/09: a bolha NÃO some
      // sozinha). É por isso que o servidor marca `nivel: 'aviso'` — estado, não falha —, e o
      // cliente aprende a diferença em vez de pintar tudo de vermelho (spec 2026-09-02,
      // Achado B). O campo é ADITIVO: cliente que não conhece `nivel` continua desenhando a
      // bolha de sempre.
      mandar({
        tipo: 'erro',
        nivel: 'aviso',
        mensagem: aba.nascendo
          ? 'o agente ainda está subindo nesta aba — o histórico aparece assim que ele abrir'
          : (aba.falhou
            ? 'o agente não subiu nesta aba, então não há histórico para mostrar'
            // As duas frases do casamento do Codex são DIFERENTES de propósito: "não achei
            // ainda" some sozinha nos ~5 s que o rollout leva para nascer; "não sei qual" não
            // some, e é o ponto. Colapsá-las numa só é a #40.
            : (aba.casamento === 'ambiguo'
              ? 'não deu para saber qual conversa é desta aba (duas abas de Codex no mesmo projeto)'
              // O cliente não desenha este aviso (PL-3); ele existe para o relato do servidor não mentir.
              : (aba.preSessao && aba.pedeConfianca
                ? `esta pasta ainda não é confiável para o ${agentes.de(aba.agente).rotulo} — ele pergunta antes de abrir a conversa`
                : (aba.agente === 'codex'
                  ? (aba.reiniciada ? 'Conversa limpa. Envie uma mensagem para começar.' : 'ainda não achei a conversa desta aba de Codex')
                  : 'não achei o histórico desta aba no disco do CLI')))),
      });
    }
    let rodando = Boolean(aba.rodando);
    mandar({ tipo: 'sincronizado', turnoEmAndamento: rodando });

    // A pendente que sobrevive à reconexão (D-a/D-m). DEPOIS do `sincronizado`: o cliente
    // segura a fita num fragmento até ele (`public/app.js:863`, `despejarFita`) — emitido
    // antes, a bolha entraria no meio do histórico.
    //
    // Daqui até o fim do laço NÃO há `await`: o Node é uma thread só, então nenhum
    // `barramento.emit` de outro pedido consegue se intercalar entre registrar o ouvinte e ler
    // o registro. É isso que garante "nem perdido, nem duplicado" — sem fila de espera, sem
    // flag. Pôr um `await` no meio deste bloco reabre o buraco (R2).
    const aoPendente = (p) => { if (p.chave === chave) mandar({ tipo: 'pendente', ...p }); };
    barramento.on('pendente', aoPendente);
    aoParar.push(() => barramento.off('pendente', aoPendente));
    for (const p of abas.pendentesDe(chave)) mandar({ tipo: 'pendente', ...p });

    // O resultado de `/status`, publicado por sessão (nunca por aba: a mesma sessão pode ser
    // olhada de outra aba/aparelho reconectando). `aba.sessaoId` é lido no MOMENTO do evento,
    // não capturado agora — é o mesmo objeto que `bater` atualiza numa troca de arquivo,
    // então a guarda acompanha a identidade atual, nunca a velha. O listener registra ANTES
    // do replay assíncrono: um `status_codex` publicado durante a leitura do disco chega
    // pelos dois caminhos, e o cliente deduplica por `id` — perder é pior que duplicar aqui.
    const aoStatusCodex = (p) => {
      if (!morto && aba.agente === 'codex' && aba.sessaoId && p.sessaoId === aba.sessaoId) {
        mandar({ tipo: 'status_codex', ...p });
      }
    };
    barramento.on('status_codex', aoStatusCodex);
    aoParar.push(() => barramento.off('status_codex', aoStatusCodex));
    if (aba.agente === 'codex' && aba.sessaoId) {
      for (const snap of await statusCodex.snapshotsDe(aba.sessaoId)) {
        if (morto) return;
        mandar({ tipo: 'status_codex', id: snap.id, sessaoId: snap.sessaoId, quando: snap.quando, texto: snap.texto });
      }
    }
    if (morto) return;

    // Pergunta aberta na TUI: o `.jsonl` não sabe disto (o menu vive só na tela), então sem
    // este evento a fita fica muda e o cockpit dá a entender que não há nada acontecendo.
    //
    // Desde 09/09 o mesmo evento carrega o `preSessao` (o prompt de confiança de pasta nova),
    // porque o que o CLIENTE precisa fazer é idêntico nos dois: mostrar a tela da pane e
    // travar o Enviar. O que muda é só o TEXTO, e para isso vai o `motivo`. Canal novo aqui
    // seria um segundo relógio dizendo quase a mesma coisa — a D21 no servidor.
    let esperando = abas.podeVerTela(aba);
    let motivo = abas.motivoDaTela(aba);
    mandar({ tipo: 'esperando', valor: esperando, motivo });

    // Sobe de 1 toda vez que a aba passa a gravar em outro `.jsonl` (ver o `bater` abaixo).
    // Serve para o relógio de baixo saber que a leitura que ele tinha no ar é de um arquivo
    // que não é mais o da tela.
    let geracao = 0;

    // O arquivo é a conversa; olhar rápido nele é o que faz a resposta aparecer no celular
    // enquanto o agente ainda está escrevendo.
    const relogioArquivo = setInterval(async () => {
      if (morto || !aba.arquivo) return;
      const minha = geracao;
      try {
        const parcial = await leitor.lerConversa(aba.arquivo, lido, { contexto: { longa } });
        // No incremental o leitor não se abstém — o pedaço novo pode ser só um `token_count`, e
        // apagar a fita que já está na tela por causa disso seria pior que o silêncio.
        if (!parcial) return;
        const { eventos, tamanho, contexto: ctx } = parcial;
        // A leitura é assíncrona: o arquivo pode ter trocado enquanto ela estava no ar. Aí
        // tanto os eventos quanto o `tamanho` são do arquivo VELHO — gravar esse tamanho em
        // `lido` faria a conversa nova começar no meio, e mandar os eventos encheria de fala
        // antiga uma fita que o `sessao` acabou de limpar. Descartar a leitura inteira.
        if (minha !== geracao) return;
        lido = tamanho;
        // D-b, DENTRO do guarda de geração (R6/#33): consumir ANTES dele comeria a pendente
        // mesmo quando a leitura é de um arquivo velho que um `/clear` já descartou — a bolha
        // nunca teria sido desenhada e a mensagem sumiria de novo.
        for (const evento of eventos) {
          if (evento.tipo === 'humano') abas.consumirPendente(chave, evento.texto, evento.quando);
          mandar(evento);
        }
        // Daqui até o fim do bloco é SÍNCRONO, de propósito e por regra: ler a régua, decidir,
        // mandar e reescrever a régua são quatro passos sem um único `await` no meio. O
        // `setInterval` async já pode reentrar hoje (isso é de antes e não regride aqui); o que
        // impede duas batidas de intercalar "eu li a chave" com "o outro escreveu a chave" é
        // não haver ponto de suspensão entre elas. E tudo isto vive DEPOIS do guarda acima.
        //
        // `ctx` nulo nunca vira evento: um pedaço só com ferramenta não tem `usage`, e mandar
        // `null` esconderia o medidor no meio do turno para ele voltar no `turno_fim` —
        // pisca-pisca justo quando o usuário está olhando. Sem número novo, o topo continua com
        // o último conhecido, que é verdade.
        if (ctx) {
          const chaveCtx = contexto.chaveDoContexto(ctx);
          if (chaveCtx !== ultimoContexto) {
            mandar({ tipo: 'contexto', contexto: ctx });
            ultimoContexto = chaveCtx;
          }
        }
      } catch { /* arquivo sumiu ou está sendo reescrito: a próxima batida pega */ }
    }, 700);
    aoParar.push(() => clearInterval(relogioArquivo));

    // Já a TUI é cara de ler e muda devagar: 2s bastam para o "trabalhando" sumir na hora
    // certa sem ficar capturando tela o tempo todo. Quem chama `bater` de 2 em 2 segundos
    // agora é o CANO — uma `abas.listar()` só, para todas as abas dele (R22).
    bater = async (linha) => {
      if (morto) return;
      if (!linha) {
        mandar({ tipo: 'removida', id: chave });
        return aoEncerrar();
      }
      // `/clear` não mata a sessão do CLI: o processo continua o mesmo, mas ele passa a gravar
      // num sessionId novo — logo, em OUTRO `.jsonl`. O caminho resolvido na abertura do fluxo
      // para de crescer e a tela congela; sair da conversa e voltar "resolvia" só porque reabrir
      // o fluxo re-resolvia o arquivo. Reemitir `sessao` é o conserto: o cliente já limpa a fita
      // nesse evento, que é o mesmo que ele recebe ao abrir e ao reconectar.
      // O `&&` não é zelo à toa: quando o claude daquela aba morre, a aba continua na lista
      // mas sem arquivo nenhum (`arquivo: null`). Sem o guarda, isso contaria como troca e a
      // conversa que o usuário estava LENDO sumiria da tela — pior do que o defeito consertado.
      // Um `/clear` no Codex CONFIRMA-se por outro caminho: a aba fica sem arquivo e marcada
      // `reiniciada`. Sem este ramo, a troca não seria detectada e a guarda de identidade do
      // `/status` continuaria escopada na sessão velha (#33 pela porta do status).
      const clearConfirmado = linha.agente === 'codex' && linha.reiniciada
        && !linha.arquivo && Boolean(aba.arquivo || aba.sessaoId);
      if (clearConfirmado || (linha.arquivo && linha.arquivo !== aba.arquivo)) {
        // O contexto vem ANTES de mexer em qualquer estado, porque ele tem `await`: com a
        // troca no meio, o relógio do arquivo se intercalaria entre o reset e o `sessao` e a
        // tela ficaria com bolha órfã. Daqui para baixo é tudo síncrono, de uma vez.
        const ctx = await medidor.doArquivo(linha.arquivo);
        if (morto) return;
        geracao += 1;
        aba.arquivo = linha.arquivo;
        // A identidade que a guarda de `/status` compara.
        aba.sessaoId = linha.sessaoId || null;
        aba.agente = linha.agente;
        lido = 0;
        // O RESET da régua: a conversa nova começa com a chave do contexto DELA. Herdar a chave
        // da conversa velha faria o primeiro `contexto` de verdade ser engolido (#33).
        ultimoContexto = contexto.chaveDoContexto(ctx);
        mandar({
          tipo: 'sessao',
          meta: { titulo: linha.titulo, cwd: linha.cwd, contexto: ctx, sessaoId: aba.sessaoId,
            reiniciada: Boolean(linha.reiniciada) },
        });
        // D-j: sem isto a fita ficava MUDA depois de um `/clear` — `despejarFita()` só existe
        // no `case 'sincronizado'` (public/app.js:1658), e o cliente chama `segurarFita()` em
        // TODO `sessao` (public/app.js:770). É também o que deixa a pendente reemitida logo
        // abaixo cair na fita VIVA, e não presa no fragmento que o `sessao` acabou de segurar.
        rodando = Boolean(linha.rodando);
        mandar({ tipo: 'sincronizado', turnoEmAndamento: rodando });
        for (const p of abas.pendentesDe(chave)) mandar({ tipo: 'pendente', ...p });
        const sessaoReplay = aba.sessaoId;
        const geracaoReplay = geracao;
        if (aba.agente === 'codex' && sessaoReplay) {
          const snapshots = await statusCodex.snapshotsDe(sessaoReplay);
          if (!morto && geracaoReplay === geracao && aba.sessaoId === sessaoReplay) {
            for (const snapshot of snapshots) mandar({ tipo: 'status_codex', ...snapshot });
          }
        }
        // Nada mais neste tique: `esperando`/`turno_fim` falariam do arquivo que acabou de sair.
        return;
      }
      // O `motivo` entra na comparação de propósito: a aba SAI do `preSessao` e ENTRA no
      // `waiting` sem passar por falso no meio (o CLI publica a sessão já com um menu aberto),
      // e sem isto o cliente ficaria com o texto do prompt de confiança numa pergunta de
      // permissão. Estado igual com motivo diferente é estado diferente.
      const perguntando = abas.podeVerTela(linha);
      const motivoAgora = abas.motivoDaTela(linha);
      if (perguntando !== esperando || (perguntando && motivoAgora !== motivo)) {
        esperando = perguntando;
        motivo = motivoAgora;
        mandar({ tipo: 'esperando', valor: esperando, motivo });
      }
      const agora = Boolean(linha.rodando);
      if (agora === rodando) return;
      rodando = agora;
      // Turno acabou: o cliente fecha os cartões de ferramenta que ficaram abertos e volta a
      // deixar enviar. Começou: acende o "trabalhando".
      if (agora) {
        mandar({ tipo: 'sincronizado', turnoEmAndamento: true });
        return;
      }
      // Fim de turno é o único instante em que o número do contexto muda de verdade, e o
      // cliente JÁ recebe este evento: o medidor pega carona nele em vez de ganhar um relógio
      // próprio — dois relógios discordando entre si é problema que esta tela já teve (D21).
      mandar({ tipo: 'turno_fim', aba: chave, contexto: await medidor.doArquivo(linha.arquivo) });
    };
  })().catch((e) => {
    // R23: `parar()` calado deixaria o painel conectado e mudo para sempre. O cliente
    // precisa saber que ESTA aba morreu — o cano continua vivo para as outras.
    //
    // R34/#47: o `sessao` já pode ter saído ANTES desta exceção, então o cliente está com a
    // fita segura num fragmento fora da página. Só o `sincronizado` a despeja. Mandar só o
    // `erro` faria a bolha cair no fragmento invisível — quem segura tem que soltar no MESMO
    // caminho, inclusive no caminho da falha.
    mandar({ tipo: 'erro', mensagem: `não deu para acompanhar esta aba: ${e.message}` });
    mandar({ tipo: 'sincronizado', turnoEmAndamento: false });
    parar();
    console.error('acompanharAba', chave, e.message);
  });

  return alvo;
}

// Avisa os fluxos abertos que um turno novo começou.
const barramento = new (require('node:events').EventEmitter)();
barramento.setMaxListeners(0);

/**
 * Acompanha UM job do orquestrador. Irmã de `acompanharAba`, NÃO um parâmetro dela: um job
 * não tem troca de arquivo (#33), `esperando`, `status_codex`, pendentes nem medidor de
 * verdade — enfiar oito `if (ehJob)` ali seria a armadilha #40 pela porta dos fundos.
 *
 * 🔴 NÃO é `async function`. `acompanharAba` (acima) tem retorno SÍNCRONO com um runner
 * assíncrono por dentro: monta `{ parar, bater }` e devolve na hora, disparando o trabalho de
 * verdade num `(async () => {...})()`. Escrever `async function acompanharJob` faria
 * `paradas.set(chave, <Promise>)` — e no relógio consolidado, `paradas.get(chave)?.bater`
 * viraria `undefined`, calado: o job para de receber estado e ninguém vê erro nenhum.
 *
 * Definida DEPOIS do `barramento`, e não junto de `acompanharAba` acima, para não entrar no
 * recorte de texto que `testes/gate-ui.js` faz entre `function acompanharAba` e
 * `// Avisa os fluxos abertos` (aquele teste conta quantos `tipo: 'sessao'` existem SÓ na
 * função da aba — um `acompanharJob` colado ali contaria um terceiro `sessao` que não é dela).
 */
function acompanharJob(chave, mandar, aoEncerrar) {
  let morto = false;
  const aoParar = [];
  const parar = () => {
    if (morto) return;
    morto = true;
    aoParar.forEach((fn) => fn());
  };
  let bater = () => {};
  const alvo = { parar, bater: (linha) => bater(linha) };

  // `job-<id>` (§7.1): o prefixo é hífen, não `:`, porque a rota valida cada chave por
  // `chaveValida` e `:` cairia em 400 mudo (armadilha #17 — a mesma que fez `aba-N`).
  const id = chave.slice(4);

  (async () => {
    // Duas travas (§5.4): a FORMA do id (idValido) e a EXISTÊNCIA de verdade no disco
    // (existe) — a lista de ids válidos sai do disco, nunca de `/api/jobs`, que é HTTP
    // filtrado e pode estar fora do ar.
    if (!adaptadorJob.idValido(id) || !(await adaptadorJob.existe(id))) {
      mandar({ tipo: 'erro', mensagem: 'não achei este job' });
      // R34/#47: sem o `sincronizado`, a fita do cliente fica presa no fragmento que
      // `segurarFita()` criou — os DOIS eventos, sempre.
      mandar({ tipo: 'sincronizado', turnoEmAndamento: false });
      return aoEncerrar();
    }
    if (morto) return;

    const dadosIniciais = await jobs.listar();
    if (morto) return;
    const jInicial = dadosIniciais && Array.isArray(dadosIniciais.jobs)
      ? dadosIniciais.jobs.find((j) => j && j.id === id) : null;

    const caminho = adaptadorJob.caminhoDoLog(id);
    // O mapa de subagentes SOBREVIVE por todo o fluxo deste job (Fase 1.1 item 3 do plano):
    // sem ele, o incremental perderia o nome de um `Agent` lido numa leitura anterior.
    const subagentes = new Map();

    // `cwd: null` é regra de hoje — worktree é caminho de disco e não vai para o navegador
    // (§5.3). `desfecho`/`fim` usam a MESMA função da rota (`desfechoDoJob`, acima) — nunca
    // uma segunda derivação (#40).
    mandar({
      tipo: 'sessao',
      meta: {
        titulo: jInicial ? jInicial.title : null, cwd: null, contexto: null, sessaoId: null,
        reiniciada: false,
        job: {
          estado: jInicial ? jInicial.state : null,
          desfecho: jInicial ? desfechoDoJob(jInicial) : null,
          desde: jInicial ? (jInicial.created_at || null) : null,
          fim: jInicial ? (jInicial.fim || null) : null,
        },
      },
    });

    let lido = 0;
    const lida = await adaptadorJob.lerConversa(caminho, 0, { subagentes });
    if (morto) return;
    if (lida === null) {
      mandar({ tipo: 'erro', mensagem: 'não sei ler esta conversa — o formato do job mudou' });
    } else {
      const { eventos, tamanho, cortado, inicio } = lida;
      if (cortado) mandar({ tipo: 'historico_cortado', inicio });
      for (const evento of eventos) mandar(evento);
      lido = tamanho;
    }
    if (morto) return;

    let estadoAtual = jInicial ? jInicial.state : null;
    mandar({ tipo: 'sincronizado', turnoEmAndamento: estadoAtual === 'running' });

    // Quanto da janela do agente já está ocupado (card `contexto-da-sessao-do-job`, 22/09) —
    // a sessão PRINCIPAL do job, nunca a do subagente (D1). ANTES do `setInterval` abaixo e
    // ANTES do `if (ESTADOS_TERMINAIS…)`: entre o `sincronizado` e o terminal existe o relógio
    // de 700 ms, e pôr este bloco DEPOIS dele faria os dois escreverem `ultimoContexto`
    // concorrentemente; e num job já terminado ao abrir (D4) o relógio nem chega a nascer —
    // este `doArquivo` é a ÚNICA medição que acontece nesse caso. `doArquivo` varre do FIM do
    // arquivo para trás — não depende de onde a leitura inicial (`lida`, acima) parou; bytes
    // entre `lido` e agora acabam medidos duas vezes, e `chaveDoContexto` dedupa, que é para o
    // que ela existe.
    const longa = await contexto.janelaLongaConfigurada();
    if (morto) return;
    const ctxInicial = await adaptadorJob.doArquivo(caminho);
    if (morto) return;
    let ultimoContexto = contexto.chaveDoContexto(ctxInicial);
    if (ctxInicial) mandar({ tipo: 'contexto', contexto: ctxInicial });

    // Vira `true` no INÍCIO do término (síncrono, antes de qualquer `await` de término) para
    // que uma batida do relógio de arquivo que já estava no ar seja descartada ao voltar —
    // sem isso, a última fala sairia duas vezes (§5.3.2/G-J4: ler antes de parar deixa duas
    // leituras no mesmo offset).
    let terminando = false;
    // `true` depois que o término JÁ foi processado uma vez. Separado de `terminando` de
    // propósito: aquele dura só a leitura final; este diz que ela não se repete. `done →
    // merged → teardown` continuam chegando à tela como `job_estado`.
    let encerrado = false;

    // A allowlist é dos TERMINAIS (§5.3.1) — tudo o mais (`blocked`, `orfao`, desconhecido)
    // segue lendo. Errar para o lado de continuar custa um relógio de 700 ms parado à toa;
    // errar para o outro lado perde a conversa.
    const ESTADOS_TERMINAIS = new Set(['done', 'merged', 'teardown', 'failed']);

    // O arquivo é a conversa; olhar rápido nele é o que faz a fala aparecer enquanto o job
    // ainda escreve. Sem contador de geração — a armadilha #33 NÃO se aplica aqui (§7.10 da
    // spec): o caminho do `claude.log` de um job nunca muda, não há `/clear` num `claude -p`.
    // Declarado para ninguém reimplementar a troca de arquivo por analogia.
    //
    // TENTATIVAS_DE_ABERTURA — a GARANTIA da medição (achado dos DOIS avaliadores,
    // independente, nas duas rodadas). Nem o `doArquivo` da abertura (acima) nem a medição do
    // ramo inicial de `lerConversa` bastam sozinhos: o primeiro pode ter achado o log VAZIO, e
    // o segundo tem a régua de 80 eventos (`ALVO_MENSAGENS`) — uma rajada de subagente pode
    // engolir o principal antes dela. Enquanto NUNCA se mediu nada (`!ultimoContexto`), e só
    // quando o arquivo CRESCEU, o relógio refaz a varredura FUNDA (`doArquivo`, sem a régua de
    // 80). Com TETO de tentativas: sem ele, um job que nunca tem `usage` (21% dos jobs, spec
    // D4) pagaria uma varredura de até 4 MB a cada 700 ms, para sempre. Esgotado o teto, o
    // medidor fica sem número e o incremental continua valendo — degrada, não quebra.
    const TENTATIVAS_DE_ABERTURA = 5;
    let tentativasDeAbertura = 0;
    const relogioArquivo = setInterval(async () => {
      if (morto || terminando) return;
      try {
        const antesDoLote = lido;
        const parcial = await adaptadorJob.lerConversa(caminho, lido, { subagentes, contexto: { longa } });
        if (morto || terminando || !parcial) return;
        const { eventos, tamanho, contexto: ctxDoLote } = parcial;
        lido = tamanho;
        for (const evento of eventos) mandar(evento);

        let ctx = ctxDoLote;
        const cresceu = tamanho > antesDoLote;
        if (!ctx && !ultimoContexto && cresceu && tentativasDeAbertura < TENTATIVAS_DE_ABERTURA) {
          tentativasDeAbertura += 1;
          ctx = await adaptadorJob.doArquivo(caminho);
          if (morto || terminando) return;
        }

        // `ctx` nulo nunca vira evento (mesma régua de `server.js:557-560`): um lote só de
        // subagente não tem número novo do principal, e mandar `null` apagaria o medidor para
        // ele voltar depois — pisca-pisca justo quando o usuário está olhando. Sem número
        // novo, o topo mantém o último, que é verdade.
        if (ctx) {
          const chaveCtx = contexto.chaveDoContexto(ctx);
          if (chaveCtx !== ultimoContexto) {
            mandar({ tipo: 'contexto', contexto: ctx });
            ultimoContexto = chaveCtx;
          }
        }
      } catch { /* arquivo sumiu ou está sendo reescrito: a próxima batida pega */ }
    }, 700);
    aoParar.push(() => clearInterval(relogioArquivo));

    // Job que JÁ nasce terminado (o caso comum: abrir a conversa de um job de ontem) não tem
    // término a processar — a leitura inicial já pegou o arquivo inteiro, e ele não cresce
    // mais. Sem isto o relógio de 700 ms ficaria lendo 0 byte para sempre, e o término nunca
    // dispararia (não há MUDANÇA de estado para detectar). Achado do painel de execução.
    if (ESTADOS_TERMINAIS.has(estadoAtual)) {
      encerrado = true;
      clearInterval(relogioArquivo);
    }

    // O que o relógio consolidado do cano chama a cada 2 s (server.js, seção SSE).
    //
    // `linha` pode ser: um job da lista (objeto de `jobs.listar().jobs`), `null` (sumiu da
    // LISTA — só vira `removida` depois de conferir a pasta no DISCO, §7.13b: a janela de
    // 24 h tira da lista sem apagar nada) ou `undefined` ("não sei": a raiz existe e o
    // `readdir` falhou, `lib/jobs.js:300` — mantém o que estava, nunca `removida`).
    bater = async (linha) => {
      // 🔴 TUDO dentro de um `try`: o relógio consolidado chama `bater(...)` SEM `await` e sem
      // `.catch` (`server.js`, seção SSE) — o `try` de lá só pega exceção síncrona. Uma
      // rejeição aqui (o `claude.log` apagado no meio da leitura final, por exemplo) seria
      // `unhandledRejection`, e em Node 22 isso MATA O PROCESSO: o cockpit inteiro cai por
      // causa de um job. Achado do painel de execução, 12/09.
      try {
        if (morto || terminando) return;
        if (linha === undefined) return; // "não sei" — nada muda
        if (linha === null) {
          if (!(await adaptadorJob.existe(id))) {
            mandar({ tipo: 'removida', id: chave });
            return aoEncerrar();
          }
          return;
        }

        const mudou = linha.state !== estadoAtual;
        if (!mudou) return;

        // O TÉRMINO acontece UMA vez — na PRIMEIRA transição para um estado terminal.
        // `done → merged → teardown` são transições DEPOIS dele, e continuam valendo: o que
        // não se repete é a leitura final. Sem separar as duas coisas, o cabeçalho congelava
        // no primeiro terminal e o resto da vida do job sumia da tela (painel de execução).
        const primeiroTermino = ESTADOS_TERMINAIS.has(linha.state) && !encerrado;
        estadoAtual = linha.state;

        if (primeiroTermino) {
          // Ordem obrigatória (§5.3.2/G-J4): PARAR antes de ler de novo. Ler o resto primeiro
          // deixaria duas leituras vivas no mesmo offset, e a última fala sairia duas vezes.
          terminando = true;
          encerrado = true;
          clearInterval(relogioArquivo);
          const final = await adaptadorJob.lerConversa(caminho, lido, { subagentes, contexto: { longa } });
          if (morto) return;
          if (final) {
            for (const evento of final.eventos) mandar(evento);
            lido = final.tamanho;
            // A leitura FINAL também mede (R2): sem isto o medidor congela no PENÚLTIMO
            // valor quando o job acaba — o sintoma pior possível, porque nada quebra e a tela
            // mostra um número plausível e errado, e ninguém vai olhar de novo depois.
            //
            // 🔴 E aqui NÃO existe um `doArquivo` de última chance, de propósito. O painel de
            // execução levantou o caso ("job que termina antes de qualquer medição acabaria
            // `done` sem número") e eu cheguei a escrever a rede. O gate `G-i` de
            // `testes/gate-job-fluxo.js` REFUTOU: ele passa com a rede removida, e só fica
            // vermelho quando se remove `TENTATIVAS_DE_ABERTURA` (acima). O motivo é a
            // aritmética dos relógios — o de ARQUIVO bate a cada 700 ms e o de ESTADO (quem
            // detecta o término) a cada 2 s, então a rede do relógio SEMPRE roda primeiro.
            // Guarda cuja condição outra regra impede é a armadilha #30, e conserto que "deve
            // ajudar" é hipótese: foi revertido.
            if (final.contexto) {
              const chaveCtxFinal = contexto.chaveDoContexto(final.contexto);
              if (chaveCtxFinal !== ultimoContexto) {
                mandar({ tipo: 'contexto', contexto: final.contexto });
                ultimoContexto = chaveCtxFinal;
              }
            }
          }
          terminando = false; // a leitura final acabou; transições seguintes voltam a valer
          mandar({
            tipo: 'job_estado',
            job: { estado: linha.state, desfecho: desfechoDoJob(linha), desde: linha.created_at || null, fim: linha.fim || null },
          });
          // O fluxo fica ABERTO — quem fecha o painel é o usuário, nunca o servidor.
          mandar({ tipo: 'sincronizado', turnoEmAndamento: false });
          return;
        }

        // Toda outra MUDANÇA — `running`, `blocked`, `orfao`, desconhecido, e também
        // `done → merged → teardown` depois do término. Só na mudança: sem isso sairia um
        // `job_estado` a cada 2 s, e cada um parte o grupo de ferramentas seguidas ao meio no
        // cliente (`encerrarGrupoFerramentas()` roda para todo evento fora de
        // `NEUTROS_DO_GRUPO`). O relógio de arquivo NUNCA para por aqui.
        mandar({
          tipo: 'job_estado',
          job: { estado: linha.state, desfecho: desfechoDoJob(linha), desde: linha.created_at || null, fim: linha.fim || null },
        });
      } catch (e) {
        // Batida que estourou é batida perdida; a próxima vem em 2 s. O que não pode é a
        // rejeição subir para lugar nenhum (ver o comentário no topo desta função).
        console.error('bater do job', chave, e.message);
      }
    };
  })().catch((e) => {
    // Mesma régua de `acompanharAba`: os DOIS eventos, sempre — sem o `sincronizado`, a fita
    // do cliente fica presa no fragmento que `segurarFita()` criou.
    mandar({ tipo: 'erro', mensagem: `não deu para acompanhar este job: ${e.message}` });
    mandar({ tipo: 'sincronizado', turnoEmAndamento: false });
    parar();
    console.error('acompanharJob', chave, e.message);
  });

  return alvo;
}

// `undefined` = não sei (a fonte não respondeu — a raiz existe e o `readdir` falhou,
// `lib/jobs.js:300`); `null` = não está lá. São coisas DIFERENTES para o `bater` de
// `acompanharJob`, e trocá-las fecharia o painel do usuário por um soluço de disco.
//
// Intencional e declarado: `jobs.listar()` NÃO filtra `origin === 'capitao'` — quem filtra é
// a rota `/api/jobs`. O `bater` usa o módulo direto, então acharia um job de outra origem.
// Não é buraco: a lista lateral só oferece jobs de `capitao`, e um id que o usuário não vê
// ele não clica. Errar para o lado de achar é melhor do que fechar um painel aberto.
function linhaDoJob(dados, chave) {
  if (!dados || !Array.isArray(dados.jobs)) return undefined;
  return dados.jobs.find((j) => j && j.id === chave.slice(4)) || null;
}

/**
 * A FORMA de uma chave de painel no cano (`/api/eventos`) e no histórico (`/api/historico`) —
 * #17: aba casa `[\w-]+`; job é `job-` + o alfabeto do id de job, que tem `.` (card
 * `job-com-underscore-ou-ponto-no-id`). `/` fica fora nos dois. A forma NÃO é a trava de
 * caminho: quem barra `.` e `..` é `adaptadorJob.idValido`, adiante.
 */
function chaveValida(chave) {
  return /^[\w-]+$/.test(chave) || /^job-[\w.-]+$/.test(chave);
}

// ─── Rotas ───────────────────────────────────────────────────────────────────

/** `true` sem token configurado; com token, a mesma conferência de sempre (Bearer ou `?token=`). */
function tokenDoPedidoOk(req, url) {
  if (!TOKEN) return true;
  const enviado = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token');
  return acesso.tokenIgual(enviado, TOKEN);
}

async function api(req, res, rota, url) {
  if (!tokenDoPedidoOk(req, url)) return enviarJson(res, 401, { erro: 'token inválido' });

  // Rota MORTA desde a D17 — ninguém consumia. Ela ressuscita para o diálogo de abrir aba,
  // e volta no hábito da casa: só o NOME sai daqui. Quem resolve nome → caminho é o
  // servidor, e o navegador nunca vê `~/projetos/<x>`. É a #22 outra vez, e ela não
  // precisa ser reaprendida.
  if (rota === '/api/projetos' && req.method === 'GET') {
    // Só o booleano sai, nunca o `cwd` (#22).
    return enviarJson(res, 200, {
      projetos: (await listarProjetos()).map(({ nome, cwd }) => ({
        nome,
        codexPedeConfianca: confianca.estadoDaPasta('codex', cwd) === 'nao-confiada',
      })),
    });
  }

  // O grafo mostrado é sempre o da develop (decisão do dono, spec `grafo-do-projeto-no-cockpit`):
  // o diálogo do botão "Grafos" lista estado por projeto, nunca caminho/sha/ref (#22).
  if (rota === '/api/grafos' && req.method === 'GET') {
    const projetos = await grafoInventario.resumoParaTela(RAIZ_PROJETOS, listarProjetos);
    return enviarJson(res, 200, { projetos: projetos.map((p) => (grafoFazer.gerando(p.nome) ? { ...p, gerando: true } : p)) });
  }

  // Botão "Fazer grafo" (card `grafo-botao-fazer-grafo`, D89): gera o grafo com o gerador
  // determinístico (sem IA) e instala o hook do git do projeto. O caminho é sempre o `cwd` da
  // lista do servidor, nunca do cliente (#22) — nome inválido/fora da lista nunca lê o disco.
  if (rota === '/api/grafos/fazer' && req.method === 'POST') {
    let corpo;
    try { corpo = await lerCorpo(req); }
    catch (erro) { return enviarJson(res, 400, { erro: erro.message }); }
    const nome = corpo && typeof corpo.nome === 'string' ? corpo.nome : '';
    if (!NOME_DE_PASTA.test(nome)) return enviarJson(res, 400, { erro: grafoFazer.MENSAGENS.nomeInvalido });
    const projeto = (await listarProjetos()).find((p) => p.nome === nome);
    if (!projeto) return enviarJson(res, 404, { erro: grafoFazer.MENSAGENS.naoEncontrado });
    const { status, corpo: resposta } = await grafoFazer.fazer(projeto);
    return enviarJson(res, status, resposta);
  }

  // Mapa simples do grafo (card `grafo-mapa-simples`, D91): o servidor agrega e manda só o pedaço do
  // nível pedido. Nada do cliente vira caminho (#22): o nome passa pelas MESMAS três travas de
  // `rotaDeDadosDoGrafo`; camada/pasta/arquivo só indexam Maps do próprio grafo (lib/grafo-mapa.js).
  const mMapa = rota.match(/^\/api\/grafos\/([^/]+)\/mapa$/);
  if (mMapa && req.method === 'GET') return rotaDeMapaDoGrafo(res, mMapa[1], url);

  // Criar a pasta pela aba nova (card `criar-pasta-na-aba-nova`): "quando eu digitar e não achar, me dê a
  // opção de criar". Só o NOME vai e volta (#22) — o caminho é montado aqui, e a resposta não o leva. A
  // pasta nasce VAZIA: sem git init, sem CLAUDE.md. A política de acesso é a de todas as rotas: token em
  // `api()`, Origin/Host em `atender()`. Ordem de propósito: nome inválido nunca lê o disco.
  if (rota === '/api/projetos' && req.method === 'POST') {
    let corpo;
    try { corpo = await lerCorpo(req); }
    catch (erro) { return enviarJson(res, 400, { erro: erro.message }); }
    const nome = corpo && typeof corpo.nome === 'string' ? corpo.nome : '';
    if (!NOME_DE_PASTA.test(nome)) {
      return enviarJson(res, 400, { erro: 'nome de pasta inválido: use letras, números, - e _ (até 64)' });
    }
    const raiz = path.resolve(RAIZ_PROJETOS);
    const destino = path.join(raiz, nome);
    // A regex já impede `/` e `..`; conferir o pai é a segunda trava (#22), não a primeira.
    if (path.dirname(destino) !== raiz) return enviarJson(res, 400, { erro: 'nome de pasta inválido' });
    // S16: checar e criar em fila — o segundo pedido só lê a lista depois do `mkdir` do primeiro.
    const vez = filaDePastas.then(async () => {
      if ((await listarProjetos()).some((p) => chaveDePasta(p.nome) === chaveDePasta(nome))) {
        return [409, { erro: 'já existe uma pasta com esse nome' }];
      }
      try {
        await fsp.mkdir(destino);       // sem `recursive`: a raiz tem de existir, e EEXIST é sinal
        return [201, { nome }];
      } catch (erro) {
        if (erro.code === 'EEXIST') return [409, { erro: 'já existe uma pasta com esse nome' }];
        if (erro.code === 'ENOENT') return [500, { erro: 'a pasta de projetos não existe no servidor' }];
        return [500, { erro: 'não deu para criar a pasta' }];
      }
    });
    filaDePastas = vez.catch(() => {});  // a fila nunca para por um pedido que falhou
    const [status, resposta] = await vez;
    return enviarJson(res, status, resposta);
  }

  // A faixa de "tem job rodando" no topo do chat, e (com `?tudo=1`) o grupo JOBS da lista
  // lateral (spec 2026-09-08, §4.1/§4.2). Só os disparados pelo capitão: telegram e cli não
  // são trabalho que o usuário mandou desta tela e só fariam ruído — filtro mantido de propósito,
  // a decisão sobre alargá-lo continua em aberto (ver docs/arquitetura.md).
  //
  // Nada de `worktree`, `branch` ou `source_repo` em NENHUM dos dois ramos: mesmo hábito da
  // rota de arquivos — a árvore do disco não vai para o navegador.
  if (rota === '/api/jobs' && req.method === 'GET') {
    const dados = await jobs.listar();

    // A tela "Pra revisar" (plano 2026-10-04): jobs terminados cuja branch ainda tem algo
    // fora da `develop` do repo deles. Tratamento PRÓPRIO — alarga o filtro de origem só
    // para esta chamada (docs/arquitetura.md) — e retorna antes do resto da rota, que nunca
    // manda `worktree`/`branch`/`source_repo` pro navegador.
    if (url.searchParams.get('revisar') === '1') {
      if (dados && dados.ausente) return enviarJson(res, 200, { jobs: [], atencao: [], habilitado: false });
      if (!dados || !Array.isArray(dados.jobs)) return enviarJson(res, 200, { jobs: [], atencao: [], erro: true });

      const { principal, atencao } = await revisar.filtrarPraRevisar(dados.jobs);
      // `parou-no-limite` só é calculado para quem ENTRA (e para as relações deles) — nunca lê
      // `result.md` de quem saiu por VAZIO/SQUASH_OK/ancestralidade.
      const miolo = async (item) => {
        const etiquetas = [];
        if (item.motivo) etiquetas.push(item.motivo);
        if (item.estado === 'needs-review') etiquetas.push('pede-revisao');
        const decisao = await decisaoDoRelatorio(item.job.id);
        if (item.estado === 'needs-decision' || decisao === 'pede') etiquetas.push('pede-decisao');
        else if (decisao === 'ilegivel') etiquetas.push('relatorio-ilegivel');
        if (await paraNoLimite(item.job.id)) etiquetas.push('parou-no-limite');
        return { id: item.job.id, titulo: item.job.title, estado: item.estado, fim: revisar.fimDoJob(item.job), temResultado: item.job.hasResult, etiquetas };
      };
      const resumo = async (item) => {
        const base = await miolo(item);
        if (item.retomou.length) base.etiquetas.push('retomada');
        // Prévia do merge (só leitura, card pra-revisar-aviso-de-conflito-no-merge). Só o item de topo:
        // retomou[]/inclui[] estão contidos na branch dele. Não vira etiqueta — o filtro não muda.
        const previa = await revisar.previaDoMerge({
          repo: item.job.source_repo, base: item.base, shaBase: item.shaBase,
          branch: item.branchEfetiva, shaBranch: item.shaBranch,
        });
        return {
          id: base.id, titulo: base.titulo, projeto: item.job.project, estado: base.estado, fim: base.fim,
          temResultado: base.temResultado, etiquetas: base.etiquetas,
          retomou: await Promise.all(item.retomou.map(miolo)),
          inclui: await Promise.all(item.inclui.map(miolo)),
          merge: previa && { estado: previa.estado, base: item.base, n: previa.n, arquivos: previa.arquivos },
        };
      };
      const ordenar = (lista) => lista.sort((a, b) => String(b.fim || '').localeCompare(String(a.fim || ''))
        || String(b.id || '').localeCompare(String(a.id || '')));
      const doItem = async (lista) => ordenar(await Promise.all(lista.map(resumo)));

      return enviarJson(res, 200, {
        jobs: await doItem(principal),
        atencao: await doItem(atencao),
        habilitado: true,
      });
    }

    // Pasta de jobs inexistente é o estado NORMAL de quem clonou este repositório e não usa
    // orquestrador nenhum: `habilitado: false` é o mesmo contrato que a variável de ambiente
    // vazia produzia antes, e a tela desenha "nenhum job" em vez de um erro.
    if (dados && dados.ausente) return enviarJson(res, 200, { jobs: [], painel: null, habilitado: false });
    // `null` é a ABSTENÇÃO do leitor (a raiz existe e não deu para lê-la). Não é falha do
    // cockpit e não pode virar erro na tela — mesma resposta que o painel fora do ar dava.
    if (!dados || !Array.isArray(dados.jobs)) return enviarJson(res, 200, { jobs: [], painel: false });
    // Quem casa job com aba é o SERVIDOR: o casamento precisa do `cwd` de cada aba, e cwd
    // é caminho de disco — exatamente o que nunca sai daqui. O cliente recebe só a chave.
    const abertas = await abas.listar();
    const tudo = url.searchParams.get('tudo') === '1';
    const comArquivados = url.searchParams.get('arquivados') === '1';
    const doOrigin = dados.jobs.filter((j) => j && j.origin === 'capitao');
    // 🔴 A contagem é ANTES de esconder e DEPOIS de filtrar por origem: contar antes do filtro
    // somaria jobs que esta rota nunca mostra, e contar depois de esconder daria sempre zero.
    const nArquivados = doOrigin.filter((j) => j.arquivado).length;
    // Daqui para baixo ninguém mais lê `doOrigin`: quem foi arquivado só volta com
    // `?arquivados=1`, e um consumidor esquecido lá atrás é um vazamento silencioso.
    const visiveis = comArquivados ? doOrigin : doOrigin.filter((j) => !j.arquivado);

    // SEM `?tudo=1`: o caminho de HOJE, intocado — mesmo filtro, mesmos sete campos, mesma
    // ordem de chaves (o J1 do gate prova byte a byte). Só os que estão RODANDO: a faixa nunca
    // usou o resto, e o resto é quase tudo — com 70 jobs no histórico isto ia de 17 KB para
    // algumas centenas de bytes, a cada 15s, em celular, por tailnet.
    //
    // Depois desta entrega `atualizarFaixaJobs()` só pede `?tudo=1` — este ramo fica
    // PRESERVADO SEM CONSUMIDOR INTERNO, e é de propósito, não esquecido: a regra da casa
    // manda sinalizar código sem chamador em vez de apagar, a Fase 0 do card já tinha decidido
    // que a resposta de hoje não regride, e é o contrato que qualquer `curl` do usuário já
    // conhece.
    if (!tudo) {
      return enviarJson(res, 200, {
        jobs: visiveis
          .filter((j) => j.state === 'running')
          .map((j) => ({
            id: j.id, titulo: j.title, projeto: j.project, estado: j.state,
            // `etapa` é a última ação do agente, que o painel tira do fim do log do job.
            // Vem null quando o job ainda não agiu ou quando o log não diz nada — a faixa
            // trata os dois como "sem sinal" em vez de sumir.
            etapa: j.etapa || null,
            desde: j.created_at || null,
            // As abas do terminal cujo projeto é o deste job. Vazio = ele não é de nenhuma
            // conversa aberta e não aparece na faixa; quem mostra tudo é o painel /jobs.
            abas: abas.abasDoProjeto(j.project, abertas),
          })),
        painel: true,
      });
    }

    // `?tudo=1` — os sete estados do painel, e o que o cockpit não conhece também (§4.2):
    //   running, blocked, orfao          → sempre, SEM janela (são os que exigem AÇÃO)
    //   done, merged, teardown           → só se terminaram dentro da JANELA (o fim feliz)
    //   failed                           → terminou, mas EXIGE AÇÃO: isento desta janela
    //                                       (ver a isenção logo abaixo — o prazo dele é outro)
    //   estado fora dos sete             → entra sempre, como protegido — não dá para saber
    //                                       se exige ação, e no escuro se mostra
    const agora = Date.now();
    const comFim = visiveis.map((j) => {
      const protegido = j.state === 'running' || j.state === 'blocked' || j.state === 'orfao'
        || !ESTADOS_CONHECIDOS.has(j.state);
      // `j.fim` é o TÉRMINO do trabalho (`lib/jobs.js`, `eventoDoTermino`), não a última linha
      // do `status.log` — a faxina do teardown vinha depois e ressuscitava job de semanas atrás
      // nesta janela (card `lista-de-agentes-ressuscita-job-na-limpeza`, 06/10/2026).
      return { j, fim: j.fim || null, protegido };
    });
    // 🔴 `j.arquivado` isenta da JANELA sem virar `protegido`: quem pediu `?arquivados=1`
    // quer ver justamente os velhos, e a janela de 24 h os cortaria na entrada. Mas mexer em
    // `protegido` mudaria o `rank` lá embaixo e faria um job arquivado subir na frente de um
    // `running` — a urgência não é a mesma coisa que a visibilidade.
    //
    // `failed` terminou, mas EXIGE AÇÃO — é justamente o que não pode sumir enquanto você dormia
    // (decisão do dono, 11/09). Ele é ISENTO desta janela, e não ganha uma segunda: quem já
    // cuida do prazo dele é `estaArquivado()`/`horasArquiva()` (24 h, `lib/jobs.js:244`), que
    // corta em `visiveis` (`:941`) antes daqui. Uma constante de 24 h nesta linha seria código
    // morto — a condição dela nunca é alcançada (armadilha #30).
    //
    // 🔴 A guarda da isenção mede DATA, não "tem alguma coisa". `estaArquivado()` devolve
    // `false` quando não consegue ler carimbo nenhum (`lib/jobs.js:248` — "na dúvida, aparecer é
    // o erro barato"), então um `failed` sem data legível NUNCA é arquivado, e uma isenção sem
    // guarda o deixaria na tela PARA SEMPRE. Hoje quem o corta é a aritmética da janela, que
    // vira `NaN <= …` ⇒ false.
    //
    // E `fim` NÃO é uma data validada: `lib/jobs.js:97` tira o `at` do PRIMEIRO TOKEN da última
    // linha do `status.log` (`return m ? { at: m[1], … }`). Uma linha `lixo failed: x` casa o
    // regex e produz `at: 'lixo'` — truthy. Por isso `Number.isFinite(Date.parse(fim))`, e não
    // `fim &&`: com o teste de verdade, o job de carimbo podre voltaria a ficar eterno.
    const dataBoa = (fim) => Number.isFinite(Date.parse(fim));
    const naJanela = comFim.filter(({ j, fim, protegido }) => (
      protegido || j.arquivado || (j.state === 'failed' && dataBoa(fim))
      || (dataBoa(fim) && agora - Date.parse(fim) <= JANELA_FIM_FELIZ_MS)
    ));

    const protegidos = naJanela.filter((x) => x.protegido);
    // O terceiro balde: pedidos explicitamente por `?arquivados=1`. Isento do teto pelo mesmo
    // motivo da janela — cortá-los devolveria uma lista incompleta a quem pediu a lista
    // completa, e sem dizer que cortou.
    const desarquivados = naJanela.filter((x) => !x.protegido && x.j.arquivado);
    // Mais novo primeiro — é o que deixa o corte do teto, abaixo, tirar sempre do FIM da lista.
    const encerrados = naJanela.filter((x) => !x.protegido && !x.j.arquivado)
      .sort((a, b) => new Date(b.fim).getTime() - new Date(a.fim).getTime());

    // O teto corta SÓ encerrados, do mais antigo, e CEDE se os protegidos já passarem dele
    // sozinhos (§4.1.2) — cortar quem exige ação recriaria a cegueira que a entrega existe
    // para matar.
    const vagas = Math.max(0, TETO_JOBS - protegidos.length - desarquivados.length);
    const selecionados = [...protegidos, ...desarquivados, ...encerrados.slice(0, vagas)];

    // Ordem por urgência (§4.2): running primeiro, depois blocked/orfao/desconhecido, depois
    // os encerrados por término decrescente. A lista de CONVERSAS não reordena — mas jobs não
    // têm ordem que o usuário saiba de cor, e aqui ordenar por urgência é o que serve.
    const rank = (x) => (x.j.state === 'running' ? 0 : x.protegido ? 1 : 2);
    selecionados.sort((a, b) => {
      const diferenca = rank(a) - rank(b);
      if (diferenca !== 0) return diferenca;
      if (rank(a) < 2) return 0; // dentro de running/protegido, mantém a ordem do painel
      return new Date(b.fim).getTime() - new Date(a.fim).getTime();
    });

    return enviarJson(res, 200, {
      jobs: selecionados.map(({ j, fim }) => ({
        id: j.id, titulo: j.title, projeto: j.project, estado: j.state,
        // `tipo` é o NOME da linha na tela (`ataca`, `ship`, …).
        tipo: j.type || null,
        etapa: j.etapa || null,
        desde: j.created_at || null,
        // Hora do TÉRMINO — é o que a janela dos encerrados mede. `null` para quem ainda não
        // terminou, ou cujo `status.log` não registrou um evento final legível.
        fim,
        // Substitui a `etapa` nula dos encerrados — só para os kinds da allowlist (ver a
        // constante). Chave SEMPRE presente, com valor `null`: ausente e vazio são a mesma
        // coisa (§4.1). O `?? null` importa — `JSON.stringify` APAGA chave com valor
        // `undefined` (`j.event.text` ausente viraria a chave sumindo, não `desfecho: null`).
        desfecho: desfechoDoJob(j),
        abas: abas.abasDoProjeto(j.project, abertas),
      })),
      painel: true,
      // Quantos ficaram de fora por idade — o número que a tela usa para oferecer
      // `?arquivados=1` sem ter de adivinhar se há algo escondido. SÓ neste ramo: o de cima é
      // comparado por `JSON.stringify` do objeto inteiro, e uma chave a mais lá quebra o
      // contrato que qualquer `curl` já conhece.
      arquivados: nArquivados,
    });
  }

  // O relatório (`result.md`) de um job, pra tela "Pra revisar" (plano 2026-10-04). Duas
  // travas, não uma (§7.8 da spec de jobs): `idValido` barra a FORMA, `existe` barra o id
  // inventado que passe na forma mas não exista no disco.
  if (rota === '/api/jobs/resultado' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!adaptadorJob.idValido(id) || !(await adaptadorJob.existe(id))) {
      return enviarJson(res, 404, { erro: 'não achei este job' });
    }
    const caminho = path.join(limite.dirJobs(), id, 'result.md');
    let buf;
    try { buf = await fsp.readFile(caminho); } catch { return enviarJson(res, 200, { texto: '', cortado: false }); }
    const cortado = buf.length > TETO_RESULTADO;
    const aparado = revisar.cortarUtf8Seguro(cortado ? buf.subarray(0, TETO_RESULTADO) : buf);
    return enviarJson(res, 200, { texto: aparado.toString('utf8'), cortado });
  }

  // Diff de commit e de job (card `ver-a-diff-do-codigo`, D95) — só leitura, três rotas GET.
  // Tabela fechada de parâmetros (V3); nenhum caminho sai na resposta (nem `worktree`, `branch`,
  // `source_repo`): V4/#22. Erro inesperado do git (`Error('git')` de lib/diff.js) → 502, nunca
  // a mensagem crua do git nem 200 vazio (13b).
  if (rota === '/api/diff/commits' && req.method === 'GET') {
    const parametros = parametrosFechados(url, ['projeto', 'topo', 'pular']);
    if (!parametros) return enviarJson(res, 400, { erro: 'pedido inválido' });
    const nomeProjeto = parametros.get('projeto') || '';
    if (!nomeProjeto) return enviarJson(res, 400, { erro: 'pedido inválido' });
    const topoCru = parametros.get('topo');
    const pularCru = parametros.get('pular');
    if ((topoCru == null) !== (pularCru == null)) return enviarJson(res, 400, { erro: 'pedido inválido' });
    if (topoCru != null && !diff.RE_SHA.test(topoCru)) return enviarJson(res, 400, { erro: 'pedido inválido' });
    if (pularCru != null && !/^\d{1,6}$/.test(pularCru)) return enviarJson(res, 400, { erro: 'pedido inválido' });

    const projeto = await projetoDoNome(nomeProjeto);
    if (!projeto) return enviarJson(res, 404, { erro: 'projeto não encontrado' });

    let topoReal;
    if (topoCru != null) {
      topoReal = await diff.resolverCommit(projeto.repo, topoCru);
      if (!topoReal) return enviarJson(res, 404, { erro: 'commit não encontrado' });
    }

    let resultado;
    try {
      resultado = await diff.commitsDe(projeto.repo, topoReal ? { topo: topoReal, pular: Number(pularCru) } : {});
    } catch { return enviarJson(res, 502, { erro: 'não consegui ler o git agora' }); }
    if (resultado.semBase) return enviarJson(res, 404, { erro: 'este projeto não tem develop nem main' });

    return enviarJson(res, 200, {
      projeto: projeto.nome, base: resultado.base.nome, topo: resultado.topo,
      commits: resultado.commits.map((c) => ({ sha: c.sha, autor: c.autor, data: c.data, assunto: c.assunto, merge: c.merge, arquivos: c.arquivos, mais: c.mais, menos: c.menos })),
      mais: resultado.mais, cortado: resultado.cortado,
    });
  }

  if (rota === '/api/diff/commit' && req.method === 'GET') {
    const parametros = parametrosFechados(url, ['projeto', 'sha']);
    if (!parametros) return enviarJson(res, 400, { erro: 'pedido inválido' });
    const nomeProjeto = parametros.get('projeto') || '';
    const shaCru = parametros.get('sha') || '';
    if (!nomeProjeto || !shaCru) return enviarJson(res, 400, { erro: 'pedido inválido' });
    if (!diff.RE_SHA.test(shaCru)) return enviarJson(res, 400, { erro: 'sha inválido' });

    const projeto = await projetoDoNome(nomeProjeto);
    if (!projeto) return enviarJson(res, 404, { erro: 'projeto não encontrado' });

    const shaCompleto = await diff.resolverCommit(projeto.repo, shaCru);
    if (!shaCompleto) return enviarJson(res, 404, { erro: 'commit não encontrado' });

    let resultado;
    try { resultado = await diff.commitInteiro(projeto.repo, shaCompleto); }
    catch { return enviarJson(res, 502, { erro: 'não consegui ler o git agora' }); }

    return enviarJson(res, 200, { projeto: projeto.nome, ...resultado });
  }

  if (rota === '/api/diff/job' && req.method === 'GET') {
    const parametros = parametrosFechados(url, ['id']);
    if (!parametros) return enviarJson(res, 400, { erro: 'pedido inválido' });
    const id = parametros.get('id') || '';
    if (!id) return enviarJson(res, 400, { erro: 'pedido inválido' });
    if (!adaptadorJob.idValido(id) || !(await adaptadorJob.existe(id))) {
      return enviarJson(res, 404, { erro: 'não achei este job' });
    }

    const SEM_PROJETO_CONHECIDO = { erro: 'o repo deste job não é de um projeto conhecido' };
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(limite.dirJobs(), id, 'meta.json'), 'utf8')); }
    catch { return enviarJson(res, 404, { erro: 'não achei este job' }); }

    let realDoJob;
    try { realDoJob = fs.realpathSync(meta.source_repo); } catch { return enviarJson(res, 404, SEM_PROJETO_CONHECIDO); }
    const nomeDaPasta = path.basename(realDoJob);
    const projetoDaLista = (await listarProjetos()).find((p) => p.nome === nomeDaPasta);
    if (!projetoDaLista) return enviarJson(res, 404, SEM_PROJETO_CONHECIDO);

    // Um `rev-parse` por PEDIDO, não um por projeto (painel R2, Claude, residual).
    let repoDoProjeto;
    try { repoDoProjeto = fs.realpathSync(await grafoGit.repoPrincipal(projetoDaLista.cwd)); } catch { repoDoProjeto = null; }
    if (!repoDoProjeto || repoDoProjeto !== realDoJob) return enviarJson(res, 404, SEM_PROJETO_CONHECIDO);

    let resultado;
    try { resultado = await diff.mudancasDoJob({ meta, repo: repoDoProjeto }); }
    catch { return enviarJson(res, 502, { erro: 'não consegui ler o git agora' }); }

    return enviarJson(res, 200, { id, titulo: meta.title || '', projeto: projetoDaLista.nome, ...resultado });
  }

  // PRs abertos do GitHub (card `ver-a-diff-do-codigo`, D97) — só leitura. A lista vem do `gh` com cache curto
  // (lib/github.js); `gh` fora do ar NUNCA vira 5xx aqui: a tela "Em aberto" degrada pra só os jobs.
  if (rota === '/api/diff/prs' && req.method === 'GET') {
    if (!parametrosFechados(url, [])) return enviarJson(res, 400, { erro: 'pedido inválido' });
    const l = await github.listarPrs();
    if (!l.ok) return enviarJson(res, 200, { prs: [], limite: false, github: 'falhou' });
    return enviarJson(res, 200, { prs: l.prs.map((p) => ({ repo: p.repo, numero: p.numero, titulo: p.titulo, autor: p.autor, atualizado: p.atualizado, rascunho: p.rascunho })), limite: l.limite, github: 'ok' });
  }

  // Um PR: o par (repo, número) só passa se estiver na lista que o PRÓPRIO servidor obteve (allowlist) — nada do
  // cliente vira argumento do `gh` sem isso.
  if (rota === '/api/diff/pr' && req.method === 'GET') {
    const parametros = parametrosFechados(url, ['repo', 'numero']);
    if (!parametros) return enviarJson(res, 400, { erro: 'pedido inválido' });
    const repo = parametros.get('repo') || '';
    const numeroCru = parametros.get('numero') || '';
    if (!github.repoValido(repo) || !github.RE_NUMERO.test(numeroCru)) return enviarJson(res, 400, { erro: 'pedido inválido' });
    const numero = Number(numeroCru);
    const daLista = await github.prDaLista(repo, numero);
    if (daLista && daLista.falhou) return enviarJson(res, 502, { erro: 'não consegui ler o GitHub agora' });
    if (!daLista) return enviarJson(res, 404, { erro: 'este PR não está mais aberto no GitHub' });
    const d = await github.detalheDoPr(repo, numero);
    if (d.erro) return enviarJson(res, 502, { erro: 'não consegui ler o GitHub agora' });
    return enviarJson(res, 200, d);
  }

  // As conversas que rodam nas abas do terminal do usuário, fora do cockpit. Leitura vem do
  // arquivo do CLI; escrita é `send-keys` na aba viva, sem criar processo. Ver lib/abas.js.
  if (rota === '/api/abas' && req.method === 'GET') {
    const [lista, carimbos] = await Promise.all([listarAbasComFim(), lidas.mapa()]);
    return enviarJson(res, 200, {
      abas: lista.map((a) => ({
        ...abas.paraCliente(a),
        // O carimbo desta conversa, ou null se nunca foi lida em aparelho nenhum. Sai só
        // para as abas VIVAS: o mapa inteiro nunca cruza a rede (card, Fase 1). `?? null`,
        // não `|| null`: carimbo 0 nunca é gravado (lib/lidas.js exige > 0), e `??` diz a
        // intenção exata — "ausente vira null", não "falsy vira null".
        lidoEm: a.sessaoId ? (carimbos[a.sessaoId] ?? null) : null,
      })),
    });
  }

  // Marcar uma conversa como lida, do aparelho que está com ela na tela. O estado saiu do
  // localStorage e virou do servidor (D53): ler no celular apaga o destaque no note, e
  // vice-versa. A LEITURA não tem rota — ela pega carona no GET /api/abas acima, que o tique
  // de 5s já busca.
  if (rota === '/api/lidas' && req.method === 'POST') {
    // `lerCorpo` DENTRO do try: ela rejeita com `new Error('json inválido')` SEM `codigo`, e
    // fora daqui essa rejeição sobe até o catch geral do request handler e vira 500 — aqui a
    // validação de lib/lidas.js promete 400.
    let corpo;
    try { corpo = await lerCorpo(req); }
    catch (erro) { return enviarJson(res, 400, { erro: erro.message }); }
    try {
      // `corpo?.` porque `JSON.parse('null')` devolve `null`, e `null.sessaoId` lançaria um
      // TypeError sem `codigo` — que subiria como 500 onde a tabela promete 400. A validação
      // de `lib/lidas.js` já recusa `undefined` e devolve o 400 certo.
      return enviarJson(res, 200, await lidas.marcar(corpo?.sessaoId, corpo?.carimbo));
    } catch (erro) {
      if (erro.codigo === 400) return enviarJson(res, 400, { erro: erro.message });
      throw erro;
    }
  }

  // As trilhas de leitura (card `leituras-trilhas`, D59). O catálogo é de outro projeto e só é
  // LIDO; o progresso é deste servidor (molde /api/lidas). GET sempre 200 — o estado do
  // catálogo vai dentro, para a tela dizer "não encontrado" sem parecer erro de rede.
  // + lendo, D61.
  if (rota === '/api/leituras' && req.method === 'GET') {
    return enviarJson(res, 200, await leituras.estado());
  }
  if (rota === '/api/leituras' && req.method === 'POST') {
    let corpo;
    try { corpo = await lerCorpo(req); }
    catch (erro) { return enviarJson(res, 400, { erro: erro.message }); }
    try {
      // D61: o corpo diz a ação — `lendo` OU `terminado`. A guarda vem antes do `hasOwn`:
      // `Object.hasOwn(null, …)` lança TypeError, que viraria 500 (R6 crava `null` ⇒ 400).
      const ehObjeto = corpo !== null && typeof corpo === 'object' && !Array.isArray(corpo);
      const temLendo = ehObjeto && Object.hasOwn(corpo, 'lendo');
      if (temLendo && Object.hasOwn(corpo, 'terminado')) {
        return enviarJson(res, 400, { erro: 'mande terminado OU lendo, não os dois' });
      }
      return enviarJson(res, 200, temLendo
        ? await leituras.marcarLendo(corpo.livroId, corpo.lendo)
        : await leituras.marcar(corpo?.livroId, corpo?.terminado));
    } catch (erro) {
      if ([400, 404, 409, 500].includes(erro.codigo)) return enviarJson(res, erro.codigo, { erro: erro.message });
      throw erro;
    }
  }

  /**
   * Abrir uma aba nova no terminal do usuário.
   *
   * A rota LÊ `projeto` e IGNORA o resto do corpo — regra uniforme, e ela é a fronteira de
   * segurança inteira: o navegador manda o NOME, o servidor resolve o CAMINHO pelo
   * whitelist de `~/projetos`. `cwd` junto de um `projeto` válido é ignorado (a janela
   * nasce no caminho do projeto); `cwd` SEM `projeto` válido é 400 — não porque o `cwd`
   * incomoda, mas porque o `projeto` faltou. Caminho de disco vindo do cliente é a #22, e
   * o anexo já pagou esse preço uma vez.
   *
   * O casamento é por igualdade EXATA de string, sem normalizar: a lista vem de um
   * `readdir` de um diretório só, e o sistema de arquivos já garante nome único ali.
   * Normalizar criaria empate onde não há — `Projeto-a` e `projeto-a` seriam duas pastas
   * legítimas e diferentes.
   */
  if (rota === '/api/abas' && req.method === 'POST') {
    const corpo = await lerCorpo(req);
    const pedido = corpo && typeof corpo.projeto === 'string' ? corpo.projeto : '';
    const escolhido = (await listarProjetos()).find((p) => p.nome === pedido);
    if (!escolhido) return enviarJson(res, 400, { erro: 'escolha um projeto da lista' });
    // O agente segue a MESMA regra do projeto: ausente cai no padrão, fora da lista é 400.
    // A lista é o registro, e `existe()` é a função de validação — `de()` nunca devolve null
    // e serve para quem quer LER, não para quem quer saber a verdade.
    const agente = corpo && typeof corpo.agente === 'string' && corpo.agente
      ? corpo.agente : agentes.AGENTE_PADRAO;
    if (!agentes.existe(agente)) return enviarJson(res, 400, { erro: 'escolha um agente da lista' });
    // O modelo segue a regra do agente, com uma diferença: agente SEM lista (Codex) IGNORA o
    // campo em vez de recusar — o campo some da tela com Codex (P4), e um cliente velho ou um
    // select que não limpou o valor não pode virar 400 para quem não escolheu modelo nenhum.
    const temLista = agentes.modelosDe(agente).length > 0;
    // `pedidoModelo`, não `pedido`: este bloco já declara `const pedido` para o projeto.
    const pedidoModelo = corpo && typeof corpo.modelo === 'string' && corpo.modelo ? corpo.modelo : null;
    const modelo = temLista ? pedidoModelo : null;
    if (modelo !== null && !agentes.modeloExiste(agente, modelo)) {
      return enviarJson(res, 400, { erro: 'escolha um modelo da lista' });
    }
    try {
      return enviarJson(res, 201, await abas.criar({ cwd: escolhido.cwd, nome: escolhido.nome, agente, modelo }));
    } catch (erro) {
      // O `codigo` que o módulo pendura no erro é o que se traduz aqui — sem `regex` em
      // cima de mensagem. Erro SEM código é falha operacional de verdade: 500, e nunca
      // estado do mundo disfarçado.
      return enviarJson(res, erro.codigo || 500, { erro: erro.message });
    }
  }

  /**
   * Quais agentes o campo `Agente` oferece. Só `{id, rotulo, modelos}`.
   *
   * O caminho do binário NUNCA sai daqui — mesmo hábito da `/api/projetos`, que manda o
   * nome do projeto e nunca o `cwd` (#22). O navegador não precisa saber onde o `codex`
   * mora, e o dia em que precisar é o dia em que alguém pode escolher outro.
   */
  if (rota === '/api/agentes' && req.method === 'GET') {
    return enviarJson(res, 200, {
      // Só quem EXECUTA — o `job` está na tabela para ser LIDO (o campo `executavel: false`
      // de `lib/agentes.js`), e este seletor é para escolher com quem abrir uma aba nova.
      agentes: agentes.ids()
        .filter((id) => agentes.de(id).executavel !== false)
        .map((id) => ({
          id,
          rotulo: agentes.de(id).rotulo,
          // Cópia RASA — nunca o array do registro, para ninguém mutar a constante pelo JSON.
          modelos: agentes.modelosDe(id).map(({ id: m, rotulo }) => ({ id: m, rotulo })),
        })),
      padrao: agentes.AGENTE_PADRAO,
    });
  }

  /**
   * ── Arquivos: a porta de QUALQUER tipo até 2 GB, direto em ~/taildrop-inbox/<pasta>/ ──
   *
   * O clipe (`/api/abas/:chave/anexos`, logo abaixo) NÃO muda: continua nos 6 tipos e 20 MB,
   * com `lerBinario` — decisão do projeto ("não quero mudar o clip não"). Esta é outra porta,
   * com outra pasta e outro contrato: o corpo vai por stream para o disco (`lib/arquivos.js`),
   * a pasta é um NOME da lista que o servidor monta (R2), o nome do arquivo é lavado com a
   * extensão preservada (R7), e toda recusa antes do corpo fecha a conexão (R58).
   *
   * A ordem 429 → 413 → 507 vive inteira em `receber` (R44): a rota só mapeia a pasta e o
   * nome; não olha `content-length`. Erro com `codigo` vira status; sem código é 500 genérico
   * com o detalhe só no log (R42); cliente que sumiu não recebe resposta nenhuma.
   */
  if (rota === '/api/arquivos/pastas' && req.method === 'GET') {
    try {
      await arquivos.garantirTriagem();
    } catch (erro) {
      // O `mkdir -p` de `_triagem` falhou: permissão, disco só leitura, ou `_triagem` que não
      // é diretório (R50/R60). Sem ela a lista mente — melhor dizer.
      return enviarJson(res, erro.codigo || 500, { erro: erro.message });
    }
    try {
      return enviarJson(res, 200, { pastas: await arquivos.pastasDoInbox(), teto: arquivos.tetoDoUpload() });
    } catch (erro) {
      console.error('arquivos: inbox ilegível —', erro.message);
      return enviarJson(res, 500, { erro: 'não consegui ler o inbox' });
    }
  }

  if (rota === '/api/arquivos' && req.method === 'POST') {
    const nome = url.searchParams.get('nome') || '';
    if (!nome) return recusar(req, res, 400, 'falta o nome do arquivo');
    if (nome.length > 1024) return recusar(req, res, 400, 'nome grande demais');
    let pasta = null;
    try {
      pasta = await arquivos.pastaDeDestino(url.searchParams.get('pasta'));
    } catch (erro) {
      return recusar(req, res, erro.codigo || 500, erro.message);
    }
    if (!pasta) return recusar(req, res, 400, 'escolha uma pasta da lista');
    try {
      // 201 { nome, bytes, pasta } — `pasta` é o NOME, nunca o caminho (#22).
      return enviarJson(res, 201, await arquivos.receber({ req, pasta, nome }));
    } catch (erro) {
      // Cliente que sumiu (queda, silêncio, reset): não há para quem responder — só a
      // limpeza do módulo rodou. Pelo socket da RESPOSTA (ver `recusar`).
      if (res.destroyed || !res.socket || res.socket.destroyed) return undefined;
      if (!erro.codigo) console.error('arquivos: upload falhou —', erro);
      return recusar(req, res, erro.codigo || 500, erro.codigo ? erro.message : 'não consegui gravar o arquivo');
    }
  }

  // Um nível por vez, dentro de três raízes FECHADAS por id (R1). `caminho` ausente = a raiz.
  if (rota === '/api/arquivos/lista' && req.method === 'GET') {
    try {
      return enviarJson(res, 200, await arquivos.listar(url.searchParams.get('raiz') || '', url.searchParams.get('caminho') || ''));
    } catch (erro) {
      if (!erro.codigo) console.error('arquivos: lista falhou —', erro.message);
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui listar' });
    }
  }

  /**
   * A localapi do tailscaled NÃO é contrato público (#10): o formato pode mudar numa
   * atualização do Tailscale. Por isso `fila` e `destinos` respondem 200 com `null` + `erro`
   * em vez de 5xx — a tela degrada SÓ aquele bloco, e o upload continua funcionando (R6).
   */
  if (rota === '/api/taildrop/fila' && req.method === 'GET') return enviarJson(res, 200, await arquivos.lerFila());
  if (rota === '/api/taildrop/destinos' && req.method === 'GET') return enviarJson(res, 200, await arquivos.destinos());

  if (rota === '/api/taildrop/puxar' && req.method === 'POST') {
    // Silêncio DESLIGADO logo antes de esperar a CLI (R39): enquanto o `file get` roda não
    // passa byte nenhum no socket. O limite aqui é o `timeout` do execFile e a trava de um por vez.
    req.setTimeout(0);
    try {
      return enviarJson(res, 200, await arquivos.puxar());
    } catch (erro) {
      if (!erro.codigo) console.error('arquivos: puxar falhou —', erro.message);
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui puxar a fila' });
    }
  }

  if (rota === '/api/taildrop/enviar' && req.method === 'POST') {
    const corpo = await lerCorpo(req);
    const { raiz, caminho, destino } = corpo || {};
    if (typeof raiz !== 'string' || typeof caminho !== 'string' || typeof destino !== 'string') {
      return enviarJson(res, 400, { erro: 'raiz, caminho e destino têm que ser texto' });
    }
    // Só DEPOIS de ler o corpo e validar os três campos (R39): um JSON pela metade continua
    // caindo no silêncio geral — é o que o gate R31 prova justamente nesta rota.
    req.setTimeout(0);
    try {
      return enviarJson(res, 200, await arquivos.enviarParaFora({ raiz, caminho, destino }));
    } catch (erro) {
      if (!erro.codigo) console.error('arquivos: enviar falhou —', erro.message);
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui enviar' });
    }
  }

  // UM cano de SSE, N abas — `?abas=a,b,c`. É o caminho do desktop (várias abas) e do
  // celular (uma só) ao mesmo tempo: um contrato, um decodificador (D29 — nada de rota viva
  // só para o celular enquanto o cliente de verdade abre outra).
  if (rota === '/api/eventos' && req.method === 'GET') {
    const chaves = [...new Set(
      (url.searchParams.get('abas') || '').split(',').map((s) => s.trim()).filter(Boolean),
    )];
    if (chaves.length === 0) return enviarJson(res, 400, { erro: 'abas= é obrigatório' });
    for (const chave of chaves) {
      if (!chaveValida(chave)) return enviarJson(res, 400, { erro: `chave inválida: ${chave}` });
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const mandar = (envelope) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(envelope)}\n\n`);
    };
    const paradas = new Map();
    for (const chave of chaves) {
      // O prefixo `job-` é a declaração de tipo (§7.1) — desviado ANTES de `abas.buscar`.
      paradas.set(chave, (chave.startsWith('job-') ? acompanharJob : acompanharAba)(
        chave,
        (e) => mandar({ aba: chave, evento: e }),
        () => paradas.get(chave)?.parar(),
      ));
    }
    // `jobs.listar()` só é pago quando há job no cano — calculado UMA vez, fora do relógio,
    // porque a lista de chaves não muda enquanto o cano vive.
    const temJob = chaves.some((c) => c.startsWith('job-'));
    // Um relógio de estado só para o cano inteiro (R22): `abas.listar()` varre o tmux UMA
    // vez por batida, não N — N `acompanharAba` liam a MESMA tabela N vezes por segundo.
    //
    // O `try` não é zelo à toa, e ele é NOVO: com um relógio por aba, uma exceção derrubava
    // um fluxo; consolidados num só, ela derruba os N painéis do cano — e, em Node 22,
    // rejeição não tratada dentro de um `setInterval(async …)` mata o PROCESSO. Consolidar
    // relógio aumenta o raio da falha, então o guarda entra junto. Batida que estourou é
    // batida perdida, e a próxima vem em 2 s.
    const relogioEstado = setInterval(async () => {
      if (res.writableEnded) return;
      try {
        const linhas = await abas.listar();
        const dadosJobs = temJob ? await jobs.listar() : null;
        if (res.writableEnded) return;
        for (const chave of chaves) {
          paradas.get(chave)?.bater(chave.startsWith('job-')
            ? linhaDoJob(dadosJobs, chave)
            : (linhas.find((l) => l.chave === chave) || null));
        }
      } catch (e) {
        console.error('relógio de estado do cano:', e.message);
      }
    }, 2000);
    const batida = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
    req.on('close', () => {
      clearInterval(relogioEstado);
      clearInterval(batida);
      for (const p of paradas.values()) p.parar();
    });
    return;
  }

  // O histórico ANTERIOR ao que já chegou pelo `/api/eventos` — o botão do chip `início`
  // (card `carregar-mais-historico`). Pedido sob demanda, resposta única, pode falhar sozinho:
  // por isso é HTTP, irmã de `/api/eventos`, e não mais um tipo de evento no SSE.
  if (rota === '/api/historico' && req.method === 'GET') {
    const chave = url.searchParams.get('chave') || '';
    if (!chaveValida(chave)) return enviarJson(res, 400, { erro: `chave inválida: ${chave}` });
    // `searchParams.get` devolve STRING: `Number.isInteger('4194304')` é `false`. A conversão
    // é obrigatória ANTES da checagem — senão a rota daria 400 em 100% dos pedidos.
    const ate = Number(url.searchParams.get('ate'));
    if (!Number.isInteger(ate) || ate <= 0) return enviarJson(res, 400, { erro: 'ate= precisa ser um inteiro > 0' });

    let arquivo;
    let leitor;
    let aba = null;
    if (chave.startsWith('job-')) {
      const id = chave.slice(4);
      if (!adaptadorJob.idValido(id)) return enviarJson(res, 400, { erro: `id de job inválido: ${id}` });
      arquivo = adaptadorJob.caminhoDoLog(id);
      leitor = adaptadorJob;
    } else {
      aba = await abas.buscar(chave);
      if (!aba || !aba.arquivo) return enviarJson(res, 404, { erro: 'conversa não está mais aberta' });
      arquivo = aba.arquivo;
      leitor = agentes.de(aba.agente).leitor;
    }

    let info;
    try {
      info = await fsp.stat(arquivo);
    } catch {
      // Arquivo sumiu: sem este `stat`, o leitor SANEIA em vez de recusar e a rota voltaria
      // 200 dizendo "este é o começo da conversa" — mentira que o achado do painel apontou.
      return enviarJson(res, 404, { erro: 'conversa não está mais aberta' });
    }
    // A âncora é de um arquivo que o `/clear` já trocou (armadilha #33). Não sanear para
    // `info.size`: isso devolveria a cauda de novo, duplicada na tela.
    if (ate > info.size) return enviarJson(res, 409, { erro: 'a conversa mudou' });

    // A mesma guarda de identidade que o `/status` do Codex já usa — só vale para aba: job
    // não tem `sessaoId` e o caminho do `claude.log` nunca muda.
    const sessao = url.searchParams.get('sessao');
    if (aba && sessao && aba.sessaoId && sessao !== aba.sessaoId) {
      return enviarJson(res, 409, { erro: 'a conversa mudou' });
    }

    const lida = await leitor.lerConversa(arquivo, 0, { ate });
    // `null` aqui só pode ser o `stat` do job falhando (§3.2 da spec) — como a rota SEMPRE
    // passa `ate`, a abstenção por formato deixou de existir neste caminho.
    if (lida === null) return enviarJson(res, 404, { erro: 'conversa não está mais aberta' });
    return enviarJson(res, 200, { eventos: lida.eventos, inicio: lida.inicio, cortado: lida.cortado });
  }

  // Os passos de UM sub-agente da aba (card `ver-os-subagentes-da-aba`, D86) — pedido sob demanda, quando o dono
  // abre o cartão `Agent` da fita. Só leitura. A fita principal não muda: o `isSidechain` continua de fora.
  if (rota === '/api/subagente' && req.method === 'GET') {
    const chave = url.searchParams.get('chave') || '';
    if (!chaveValida(chave) || chave.startsWith('job-')) return enviarJson(res, 400, { erro: 'chave inválida' });
    const ferramenta = url.searchParams.get('ferramenta') || '';
    const id = url.searchParams.get('id');
    if (!subagente.idValido(ferramenta) || (id !== null && !subagente.idValido(id))) {
      return enviarJson(res, 400, { erro: 'id inválido' });
    }
    const aba = await abas.buscar(chave);
    if (!aba || !aba.arquivo) return enviarJson(res, 404, { erro: 'conversa não está mais aberta' });
    if (aba.agente !== 'claude') return enviarJson(res, 404, { erro: 'esta aba não tem sub-agentes' });
    const sessao = url.searchParams.get('sessao');
    if (sessao && aba.sessaoId && sessao !== aba.sessaoId) return enviarJson(res, 409, { erro: 'a conversa mudou' });
    try {
      const caminho = await subagente.acharArquivo(aba.arquivo, { ferramenta, id });
      const lido = caminho ? await subagente.lerSubagente(caminho) : null;
      if (!lido) return enviarJson(res, 404, { erro: 'sub-agente não encontrado' });
      return enviarJson(res, 200, lido);
    } catch (e) {
      console.error('subagente:', e.code || e.name);
      return enviarJson(res, 500, { erro: 'não deu para ler o sub-agente' });
    }
  }

  // A tela da pane — a ÚNICA leitura de TUI do projeto, e só com a aba em `waiting`.
  //
  // Por que ela existe: o menu de múltipla escolha do CLI não passa pelo `.jsonl`, então a
  // fita fica muda e a lista diz "no terminal", igual a uma aba livre (visto em 22/08). Por
  // que ela é travada: sem o 409, esta rota viraria um espelho geral do terminal na web, que
  // é exatamente o que a D4 e a D6 recusaram.
  /**
   * `/status` nativo do Codex, sem turno de modelo — rota DEDICADA, separada de
   * `/turnos`: nunca registra pendente, nunca marca a aba ocupada, e o corpo só aceita
   * `id` (dedupe). Anexo, comando ou cwd/sessão livres no corpo são 400 — o cliente nunca
   * escolhe QUAL comando roda aqui, só se pergunta ou não.
   *
   * Dedupe, captura e gravação acontecem dentro da mesma fila em abas.consultarStatus.
   */
  const mAbaStatus = rota.match(/^\/api\/abas\/([\w-]+)\/status$/);
  if (mAbaStatus && req.method === 'POST') {
    const chave = mAbaStatus[1];
    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (erro) {
      return enviarJson(res, 400, { erro: erro.message });
    }
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return enviarJson(res, 400, { erro: 'corpo deve ser um objeto' });
    const camposExtras = Object.keys(corpo).filter((k) => k !== 'id');
    if (camposExtras.length) {
      return enviarJson(res, 400, { erro: 'este pedido só aceita o campo id' });
    }
    let { id } = corpo || {};
    if (id !== undefined && (typeof id !== 'string' || !abas.idValido(id))) {
      return enviarJson(res, 400, { erro: 'id de envio inválido' });
    }
    if (id === undefined) id = randomUUID();

    const aba = await abas.buscar(chave);
    if (!aba) return enviarJson(res, 404, { erro: 'aba não encontrada' });

    try {
      const snapshot = await abas.consultarStatus(chave, id);
      const atual = await abas.buscar(chave);
      if (!atual || atual.agente !== 'codex' || atual.sessaoId !== snapshot.sessaoId
        || atual.pane !== aba.pane || atual.arquivo !== aba.arquivo || atual.casamento === 'ambiguo') {
        return enviarJson(res, 409, { erro: 'a sessão mudou durante a consulta' });
      }
      barramento.emit('status_codex', {
        id: snapshot.id, sessaoId: snapshot.sessaoId, quando: snapshot.quando, texto: snapshot.texto,
      });
      return enviarJson(res, 200, {
        id: snapshot.id, sessaoId: snapshot.sessaoId, quando: snapshot.quando, texto: snapshot.texto,
      });
    } catch (erro) {
      if (!erro.codigo) console.error('status codex: falhou —', erro.message);
      // `/status` tem rota PRÓPRIA — não passa pela de `/turnos` acima, e sem esta linha o
      // marcador `colado` morria aqui (o caminho do `/status` também cola texto na TUI).
      // O código HTTP continua sendo o `erro.codigo` de sempre: o que viaja é o `colado`.
      return enviarJson(res, erro.codigo || 500, {
        erro: erro.codigo ? erro.message : 'não consegui consultar o status',
        ...(erro.colado ? { colado: true } : {}),
      });
    }
  }

  const mAbaTela = rota.match(/^\/api\/abas\/([\w-]+)\/tela$/);
  if (mAbaTela && req.method === 'GET') {
    const alvo = await abas.buscar(mAbaTela[1]);
    if (!alvo) return enviarJson(res, 404, { erro: 'aba não encontrada' });
    try {
      return enviarJson(res, 200, await abas.tela(alvo));
    } catch (erro) {
      // 409: estado do mundo ("não está esperando resposta"), não bug daqui.
      return enviarJson(res, 409, { erro: erro.message });
    }
  }

  // Responder o menu da TUI pelo celular: seta, Enter e Esc — e mais nada.
  //
  // A lista de teclas é FECHADA no módulo (lib/abas.js). Tecla livre vinda do navegador
  // seria teclado remoto, que é o que a D4 e a D6 recusaram; seta + Enter responde qualquer
  // menu sem o cockpit ter que ler o que está escrito na tela. Os dois códigos de recusa
  // dizem coisas diferentes de propósito: 400 é pedido malformado (tecla que não existe
  // aqui), 409 é estado do mundo (a aba não está com pergunta aberta).
  const mAbaTecla = rota.match(/^\/api\/abas\/([\w-]+)\/teclas$/);
  if (mAbaTecla && req.method === 'POST') {
    const { tecla } = await lerCorpo(req);
    if (!abas.teclaValida(tecla)) {
      return enviarJson(res, 400, { erro: `tecla não permitida: ${String(tecla).slice(0, 20)}` });
    }
    try {
      // A resposta traz a tela JÁ repintada: sem ela o usuário aperta a seta e não vê nada
      // mudar até a próxima batida da lista.
      return enviarJson(res, 200, await abas.tecla(mAbaTecla[1], tecla));
    } catch (erro) {
      const codigo = /aba não encontrada/.test(erro.message) ? 404 : 409;
      return enviarJson(res, codigo, { erro: erro.message });
    }
  }

  // Responder a pergunta do agente pelo cartão (D74). A lista de teclas é FECHADA no módulo (lib/abas.js
  // + lib/pergunta.js): dígitos 1-4, Down, Enter e o texto validado contra a pergunta pendente, com a
  // tela conferida a cada passo. Os três códigos dizem coisas diferentes: 400 é pedido malformado
  // (corpo ou resposta fora da pergunta), 404 aba que não existe, 409 estado do mundo (a pergunta mudou,
  // a tela não bateu) — com `parcial` quando alguma tecla já saiu.
  const mAbaPergunta = rota.match(/^\/api\/abas\/([\w-]+)\/pergunta$/);
  if (mAbaPergunta && req.method === 'POST') {
    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (erro) {
      return enviarJson(res, 400, { erro: erro.message });
    }
    try {
      return enviarJson(res, 200, await abas.responderPergunta(mAbaPergunta[1], corpo));
    } catch (erro) {
      if (!erro.codigo) console.error('pergunta: falhou —', erro.message);
      return enviarJson(res, erro.codigo || 500, {
        erro: erro.codigo ? erro.message : 'não consegui responder a pergunta',
        ...(erro.parcial ? { parcial: true } : {}),
      });
    }
  }

  // Anexo do navegador para uma aba: corpo binário cru, tipo no content-type, nome na query.
  // Fica em ~/.cockpit/anexos/ e a mensagem recebe só o CAMINHO — o CLI abre com o Read.
  const mAbaAnexo = rota.match(/^\/api\/abas\/([\w-]+)\/anexos$/);
  if (mAbaAnexo && req.method === 'POST') {
    // A aba precisa existir: sem isto a rota seria um upload aberto para qualquer chave.
    if (!await abas.buscar(mAbaAnexo[1])) return enviarJson(res, 404, { erro: 'aba não encontrada' });
    const tipo = String(req.headers['content-type'] || '').split(';')[0].trim();
    const extensao = TIPOS_ANEXO[tipo];
    if (!extensao) return enviarJson(res, 415, { erro: `tipo não aceito: ${tipo || 'sem content-type'}` });
    const dados = await lerBinario(req, TETO_ANEXO);
    if (!dados.length) return enviarJson(res, 400, { erro: 'arquivo vazio' });
    const guardado = await abas.guardarAnexo({ nome: url.searchParams.get('nome'), extensao, dados });
    // Par com o log do turno logo abaixo: foto que subiu e não aparece num turno depois dela
    // foi largada pelo NAVEGADOR (medido em 23/09 — upload no disco, mensagem sem cabeçalho).
    console.log(`anexo: ${guardado.nome} subiu para ${mAbaAnexo[1]} (${guardado.bytes} bytes)`);
    return enviarJson(res, 201, guardado);
  }

  const mAbaTurno = rota.match(/^\/api\/abas\/([\w-]+)\/turnos$/);
  if (mAbaTurno && req.method === 'POST') {
    const chave = mAbaTurno[1];
    const { texto, anexos, id } = await lerCorpo(req);
    // FORA do try: lá dentro o catch viraria isto em 409, que é "estado do mundo". Forma
    // errada de campo é pedido errado, e isso é 400. Dois significados no mesmo status
    // tiram do cliente a capacidade de mostrar o recado certo (D-n).
    if (id !== undefined && !abas.idValido(id)) {
      return enviarJson(res, 400, { erro: 'id de envio inválido' });
    }
    const nomesDosAnexos = (Array.isArray(anexos) ? anexos : []).map((a) => path.basename(String(a)));
    console.log(`anexo: turno ${id || '-'} para ${chave} com ${nomesDosAnexos.length} anexo(s)${nomesDosAnexos.length ? ': ' + nomesDosAnexos.join(', ') : ''}`);
    try {
      const { ficha, ...publico } = await abas.enviar(chave, texto, anexos || [], id);
      // Só avisa se a ficha AINDA estiver registrada: entre o `await` acima e esta linha o
      // relógio de 700ms pode ter lido o prompt do disco e consumido a ficha. Avisar depois
      // disso pintaria, nos outros aparelhos, a bolha "na fila" de uma mensagem que já está
      // na fita (D-m).
      if (abas.pendenteViva(chave, ficha)) barramento.emit('pendente', { chave, ...ficha });
      return enviarJson(res, 202, { ...publico, id: ficha?.id || publico.id });
    } catch (erro) {
      // 409 e não 500: "a aba não está rodando claude" é estado do mundo, não bug daqui —
      // e é o que o cliente precisa distinguir para mostrar o recado certo.
      // `colado` é ADITIVO e o contrato é "ausente ou `true`, nunca `false`": ausente
      // responde "nada saiu da fila" (o cliente pode devolver o texto para a caixa),
      // `true` responde "o texto JÁ está no composer da TUI" (devolver duplicaria — #21).
      // Quem o produz é o `catch` de escopo dos caminhos de texto em `lib/abas.js`.
      return enviarJson(res, 409, { erro: erro.message, ...(erro.colado ? { colado: true } : {}) });
    }
  }

  /**
   * Fechar uma aba do terminal — a primeira rota do cockpit que DESTRÓI trabalho.
   *
   * Casa `[\w-]+` como as outras (#17) e não colide com
   * `/api/abas/:chave/turnos/atual`: outro regex, outro método.
   *
   * As travas que importam moram no módulo (`lib/abas.js`): a última janela da sessão é
   * recusada com 409 — `kill-window` nela destrói a SESSÃO INTEIRA, medido em 27/08 —, e o
   * alvo é conferido contra `list-windows -t <SESSAO_DAS_ABAS>:`, então chave forjada só
   * alcança janela daquela sessão. Não há trava por ESTADO: matar aba `rodando` é
   * permitido, com aviso na tela, porque a D13 é explícita.
   */
  const mAbaMatar = rota.match(/^\/api\/abas\/([\w-]+)$/);
  if (mAbaMatar && req.method === 'DELETE') {
    try {
      return enviarJson(res, 200, await abas.matar(mAbaMatar[1]));
    } catch (erro) {
      return enviarJson(res, erro.codigo || 500, { erro: erro.message });
    }
  }

  // Renomear a aba — a JANELA do tmux (card `renomear-a-aba`, decisão de 05/09). Mesmo matcher do
  // DELETE, outro método: não há regex nova. A validação (400), a guarda da sessão (404) e o
  // escape para o tmux moram em `abas.renomear` — o nome passa inteiro, sem tocar nele aqui.
  if (mAbaMatar && req.method === 'PATCH') {
    const corpo = await lerCorpo(req);
    try {
      return enviarJson(res, 200, await abas.renomear(mAbaMatar[1], corpo && corpo.nome));
    } catch (erro) {
      return enviarJson(res, erro.codigo || 500, { erro: erro.message });
    }
  }

  // Parar o turno da aba: Escape na pane, que é a tecla que a própria TUI anuncia.
  const mAbaParar = rota.match(/^\/api\/abas\/([\w-]+)\/turnos\/atual$/);
  if (mAbaParar && req.method === 'DELETE') {
    try {
      return enviarJson(res, 200, await abas.interromper(mAbaParar[1]));
    } catch (erro) {
      return enviarJson(res, 409, { erro: erro.message });
    }
  }

  // Catálogo do autocomplete de "/". O cwd vem do meta.json da sessão (ou da aba do tmux),
  // NUNCA do cliente: caminho vindo do navegador é caminho que alguém escolhe.
  //
  // Duas origens porque são dois mundos. Numa SESSÃO do cockpit os nomes vêm do
  // `slash_commands` que o CLI publicou no init — é de lá que saem /clear e /context, que
  // não existem no disco. Numa ABA do terminal esse init não existe (o cockpit não criou
  // processo nenhum ali), então só o cwd é conhecido e os embutidos entram pela legenda do
  // lib/catalogo.js. Chave de aba que não existe mais responde o catálogo sem cwd, não 500:
  // aba fechada no terminal é estado do mundo, não erro daqui.
  if (rota === '/api/catalogo' && req.method === 'GET') {
    const idSessao = url.searchParams.get('sessao');
    const chaveAba = url.searchParams.get('aba');
    let cwd = null;
    let comandos = null;
    let agente = 'claude';
    if (idSessao) {
      const dados = await sessoes.uso(idSessao).catch(() => null);
      cwd = dados?.cwd || null;
      comandos = dados?.comandos || null;
    } else if (chaveAba) {
      const aba = await abas.buscar(chaveAba).catch(() => null);
      cwd = aba?.cwd || null;
      agente = aba?.agente || 'claude';
    }
    try {
      return enviarJson(res, 200, { itens: await catalogo.listar(cwd, comandos, agente) });
    } catch {
      return enviarJson(res, 503, { erro: 'Não consegui carregar o catálogo. Tente novamente.' });
    }
  }

  // Consumo do plano. `janelas` (Claude, do rate_limit_event) e `codex` são DE GRAÇA — leitura
  // de cauda de arquivo, nunca um turno. O `/usage` é a exceção: CUSTA UM TURNO, e por isso
  // só roda com `?forcar=1` (o botão "atualizar"); sem isso, no máximo se aproveita um cache
  // que já foi pago. É a lição do caso 73 (testes/gate-ui.js:7443) aplicada aos DOIS lados de
  // graça: os dois saem ANTES do try, e por isso vão nos dois ramos — o dado grátis não pode
  // sumir justo quando a Anthropic falha.
  if (rota === '/api/limite' && req.method === 'GET') {
    const codex = await abas.consumoDoCodex().catch(() => null);
    const janelas = await limite.dasJanelas().catch(() => null);
    const forcar = url.searchParams.get('forcar') === '1';
    if (!forcar) {
      const guardado = limite.emCache();
      return enviarJson(res, 200, { ...(guardado || { itens: [] }), janelas, codex });
    }
    try {
      const daAnthropic = await limite.consultar(true);
      return enviarJson(res, 200, { ...daAnthropic, janelas, codex });
    } catch (erro) {
      // Falhar aqui não pode derrubar o painel: ele ainda tem contexto e custo para mostrar.
      return enviarJson(res, 200, { itens: [], erro: String(erro.message).slice(0, 200), janelas, codex });
    }
  }

  // Monitor do servidor (card do monitor, D64): CPU, RAM e disco do servidor. Três rotas
  // porque três ritmos — a faixa bate a cada 15 s e só precisa do "agora"; o histórico (~35 KB)
  // e a varredura de /proc só quando o painel está aberto. Nenhum parâmetro de entrada; nenhum
  // caminho de disco no corpo (#22 — `comandoCurto` só deixa passar nome de flag e basename).
  if (rota === '/api/monitor' && req.method === 'GET') {
    await monitor.pronto;
    const agora = await monitor.agora();
    return enviarJson(res, 200, { agora, aviso: monitor.historicoAtual().aviso, limites: monitor.limites(), relogio: monitor.estado().relogio, maquina: os.hostname() });
  }
  if (rota === '/api/monitor/historico' && req.method === 'GET') {
    await monitor.pronto;
    const fim = Math.floor(Date.now() / 1000);
    return enviarJson(res, 200, { amostras: monitor.historicoAtual().amostras, inicio: fim - 86400, fim });
  }
  if (rota === '/api/monitor/processos' && req.method === 'GET') {
    await monitor.pronto;
    return enviarJson(res, 200, await monitor.processos());
  }
  // D68: a medida do disco. O GET devolve o que há e dispara a medição se estiver velha ("ao abrir o
  // painel"); o POST é o "medir agora", idempotente. O corpo só traz `~/<nome>`, `/<nome>` e números.
  if (rota === '/api/monitor/disco' && req.method === 'GET') {
    await monitor.pronto;
    return enviarJson(res, 200, await disco.estado({ disparar: true }));
  }
  if (rota === '/api/monitor/disco' && req.method === 'POST') {
    await monitor.pronto;
    disco.medirAgora();                       // sem await: a medida leva dezenas de segundos
    return enviarJson(res, 202, await disco.estado());
  }

  // Faixa PROD FORA (D87): o estado do vigia de prod, só leitura. Sem parâmetro, sem URL nem
  // caminho no corpo (#22) — `lib/sites.js` só deixa sair nome, situação, tempos e o código.
  if (rota === '/api/sites' && req.method === 'GET') return enviarJson(res, 200, await sites.ler());

  // Página de Finanças (D90 → D92, card pagina-financas): leitura do resumo diário, dos
  // lançamentos linha por linha, o arquivo pra exportar (bytes idênticos ao disco) e o envio
  // por destino da lista fixa. O `POST .../pdf` (D90, único cliente era o modal) saiu nesta
  // fase — `enviar()` substitui. Nenhum caminho de disco no corpo (#22).
  if (rota === '/api/financas/estado' && req.method === 'GET') return enviarJson(res, 200, await financas.estado());
  if (rota === '/api/financas' && req.method === 'GET') return enviarJson(res, 200, await financas.ler());
  if (rota === '/api/financas/lancamentos' && req.method === 'GET') {
    const pessoa = url.searchParams.get('pessoa');
    try {
      return enviarJson(res, 200, await financas.lerLancamentos(pessoa));
    } catch (erro) {
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui ler os lançamentos' });
    }
  }
  if (rota === '/api/financas/arquivo' && req.method === 'GET') {
    const pessoa = url.searchParams.get('pessoa');
    const formato = url.searchParams.get('formato');
    try {
      const { real } = await financas.localizarArquivo({ pessoa, formato });
      const conteudo = await fsp.readFile(real);
      res.writeHead(200, {
        'content-type': financas.FORMATOS[formato],
        'content-length': conteudo.length,
        'content-disposition': `attachment; filename="financas-${pessoa}.${formato}"`,
        'cache-control': 'no-store',
      });
      return res.end(conteudo);
    } catch (erro) {
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui ler o arquivo' });
    }
  }
  if (rota === '/api/financas/enviar' && req.method === 'POST') {
    let corpo;
    try { corpo = await lerCorpo(req); } catch { return enviarJson(res, 400, { erro: 'corpo inválido' }); }
    const pessoa = corpo && corpo.pessoa;
    const formato = corpo && corpo.formato;
    const destino = corpo && corpo.destino;
    if (typeof pessoa !== 'string' || typeof formato !== 'string' || typeof destino !== 'string') {
      return enviarJson(res, 400, { erro: 'pessoa, formato e destino têm que ser texto' });
    }
    req.setTimeout(0); // só depois do corpo lido e validado (molde /api/taildrop/enviar)
    try {
      return enviarJson(res, 200, await financas.enviar({ pessoa, formato, destino }));
    } catch (erro) {
      if (!erro.codigo) console.error('financas: enviar falhou —', erro.message);
      return enviarJson(res, erro.codigo || 500, { erro: erro.codigo ? erro.message : 'não consegui enviar o arquivo' });
    }
  }

  // Para onde vão os tokens — quanto cada projeto/worktree gastou (card
  // `para-onde-vao-meus-tokens`). Vizinho temático de /api/limite: os dois falam de consumo,
  // um da assinatura como um todo, este do recorte por projeto. `DIAS_ACEITOS` é whitelist
  // fechada (topo do arquivo) — nunca `Number()` livre. Nenhum caminho de disco no corpo
  // (armadilha #22): `uso.relatorio()` já garante isso (G26).
  if (rota === '/api/uso' && req.method === 'GET') {
    const pedido = Number(url.searchParams.get('dias'));
    const dias = DIAS_ACEITOS.has(pedido) ? pedido : 1;
    // Quem valida o fuso é fusoValido(), dentro de montar() (um dono só) — nunca validação
    // duplicada aqui.
    const fuso = url.searchParams.get('fuso') || undefined;
    return enviarJson(res, 200, await uso.relatorio({ dias, fuso }));
  }

  // A metade CODEX do relatório acima (card `codex-no-relatorio-de-tokens`) — rota IRMÃ, não
  // um campo dentro de `/api/uso`: os dois disparam em paralelo e a varredura fria de um lado
  // (medida: ~7 s) não pode segurar o relatório do outro, que hoje funciona (D5 da spec).
  // Mesma whitelist `DIAS_ACEITOS`, nunca `Number()` livre.
  if (rota === '/api/uso-codex' && req.method === 'GET') {
    const pedido = Number(url.searchParams.get('dias'));
    const dias = DIAS_ACEITOS.has(pedido) ? pedido : 1;
    // Quem valida o fuso é fusoValido(), dentro de montar() (um dono só) — nunca validação
    // duplicada aqui.
    const fuso = url.searchParams.get('fuso') || undefined;
    return enviarJson(res, 200, await usoCodex.relatorio({ dias, fuso }));
  }

  // O nível de esforço GLOBAL do CLI, para o painel de Configuração. É LEITURA e só: quem
  // escreve `effortLevel` é o próprio CLI, quando recebe um `/effort` (D14/D-c) — o cockpit
  // continua sem encostar na config viva dele.
  //
  // 200 SEMPRE, no padrão da /api/limite logo acima: falhar aqui não pode derrubar o painel
  // de Configuração, que ainda tem tema, link de acesso e consumo do plano para mostrar. Sem
  // o nível, a tela diz que não sabe (D22) em vez de sumir. Nenhum caminho de arquivo sai na
  // resposta, e nada aqui vem do cliente.
  if (rota === '/api/effort' && req.method === 'GET') {
    try {
      return enviarJson(res, 200, { nivel: await contexto.effortConfigurado() });
    } catch {
      return enviarJson(res, 200, { nivel: null });
    }
  }

  // Notificação no celular. A chave pública é o que o aparelho precisa para se inscrever;
  // a privada nunca sai do servidor.
  if (rota === '/api/push/chave' && req.method === 'GET') {
    try { return enviarJson(res, 200, { chave: avisos.chavePublica() }); }
    catch (erro) {
      if (erro.codigo === 503) return enviarJson(res, 503, { erro: erro.message });
      throw erro;
    }
  }
  if (rota === '/api/push/inscricao' && req.method === 'POST') {
    // O log é o que prova, do lado de cá, que o aparelho realmente chegou a pedir. Sem
    // ele a única evidência era a existência do arquivo — e "não existe" não distingue
    // "o POST nunca veio" de "veio e falhou".
    const corpo = await lerCorpo(req);
    try {
      const r = await avisos.inscrever(corpo);
      // `r.nome` (limpo, como ficou no disco), nunca `corpo.aparelho`, que é cru e vem da
      // rede: um `\n` ali fabricaria uma linha de journal inteira. E o endpoint não é
      // opcional — sem ele o id seria o hash da string "undefined", igual para todo aparelho.
      console.log(`push: inscrito ${avisos.rotuloDeLog(r.nome, corpo.endpoint)} — ${new URL(corpo.endpoint).hostname} (${r.inscritos} no total)`);
      return enviarJson(res, 201, r);
    } catch (erro) {
      console.error('push: inscrição recusada:', erro.message);
      if (erro.codigo === 503) return enviarJson(res, 503, { erro: erro.message });
      throw erro;
    }
  }
  // A lista de aparelhos para a tela (spec 2026-09-12). GET sem corpo é seguro aqui porque o
  // `id` NÃO é credencial: ele é `sha256(endpoint)`, irreversível — o motivo que obrigou o
  // `consulta` abaixo a ser POST (endpoint em linha de log de acesso) não se aplica.
  if (rota === '/api/push/inscricoes' && req.method === 'GET') {
    return enviarJson(res, 200, await avisos.listar());
  }
  // Renomear é POST porque ESCREVE. Troca só o campo `aparelho`: endpoint e keys não são
  // lidos nem reescritos, então renomear nunca invalida a inscrição.
  if (rota === '/api/push/inscricao/nome' && req.method === 'POST') {
    const { id, nome } = await lerCorpo(req);
    if (!id || typeof id !== 'string') return enviarJson(res, 400, { erro: 'id ausente' });
    const r = await avisos.renomear(id, nome);
    if (!r.renomeados) return enviarJson(res, 404, { erro: 'aparelho não encontrado' });
    return enviarJson(res, 200, r);
  }
  // "O cockpit conhece a inscrição que este aparelho tem?" — só isto, sim ou não. É a
  // pergunta que faltava no diagnóstico: permissão concedida e service worker ativo não
  // distinguem quem se inscreveu de quem assinou no navegador e nunca chegou a registrar
  // aqui. O endpoint vai no CORPO, não na query: ele é credencial e não pode virar linha
  // de log de acesso.
  if (rota === '/api/push/inscricao/consulta' && req.method === 'POST') {
    const { endpoint } = await lerCorpo(req);
    if (!endpoint) return enviarJson(res, 400, { erro: 'endpoint ausente' });
    return enviarJson(res, 200, await avisos.conhece(endpoint));
  }
  if (rota === '/api/push/inscricao' && req.method === 'DELETE') {
    const { endpoint } = await lerCorpo(req);
    return enviarJson(res, 200, await avisos.descadastrar(endpoint));
  }
  // Botão "testar" do cliente: prova o caminho inteiro sem precisar rodar um turno.
  if (rota === '/api/push/teste' && req.method === 'POST') {
    const r = await avisos.avisar({
      titulo: 'Cockpit de Agentes',
      corpo: 'Se você está lendo isto no celular, a notificação funciona.',
      sessaoId: null,
      tag: 'teste',
    });
    // `enviados` = o serviço ACEITOU (2xx), não que apareceu na tela. Aparelho inscrito e nenhum
    // aceito NÃO é "nenhum aparelho inscrito" — responder 200 fazia a tela dizer isso. 502, não 503
    // (já é "contato não configurado" aqui) nem 401 (a tela pede o token de novo).
    if (r.inscritos > 0 && r.enviados === 0) return enviarJson(res, 502, { ...r, erro: avisos.explicarRecusa(r) });
    return enviarJson(res, 200, r);
  }

  if (rota === '/api/sessoes' && req.method === 'GET') {
    return enviarJson(res, 200, { sessoes: await sessoes.listar() });
  }

  if (rota === '/api/sessoes' && req.method === 'POST') {
    const { cwd, titulo } = await lerCorpo(req);
    return enviarJson(res, 201, await sessoes.criar({ cwd, titulo }));
  }

  // Anexo do navegador: corpo binário cru, tipo no content-type, nome na query. Fica em
  // ~/.cockpit/sessoes/<id>/anexos/ e o turno recebe só o CAMINHO.
  const mAnexo = rota.match(/^\/api\/sessoes\/([\w-]+)\/anexos$/);
  if (mAnexo && req.method === 'POST') {
    const tipo = String(req.headers['content-type'] || '').split(';')[0].trim();
    const extensao = TIPOS_ANEXO[tipo];
    if (!extensao) return enviarJson(res, 415, { erro: `tipo não aceito: ${tipo || 'sem content-type'}` });
    const dados = await lerBinario(req, TETO_ANEXO);
    if (!dados.length) return enviarJson(res, 400, { erro: 'arquivo vazio' });
    const guardado = await sessoes.guardarAnexo({
      id: mAnexo[1], nome: url.searchParams.get('nome'), extensao, dados,
    });
    return enviarJson(res, 201, guardado);
  }

  const mTurno = rota.match(/^\/api\/sessoes\/([\w-]+)\/turnos$/);
  if (mTurno && req.method === 'POST') {
    const { texto, modelo, anexos } = await lerCorpo(req);
    const id = mTurno[1];
    const emAndamento = await sessoes.turnoEmAndamento(id);
    if (emAndamento) return enviarJson(res, 409, { erro: 'já existe turno em andamento', turno: emAndamento });
    const { turno, arquivo, ressuscitada } = await sessoes.rodarTurno({ id, texto, modelo, anexos });
    const { codigo } = sessoes.arquivosDoTurno(id, turno);
    barramento.emit('turno', { sessaoId: id, turno, arquivo, codigo });
    vigiarParaAvisar(id, turno, arquivo, codigo);
    return enviarJson(res, 202, { turno, ressuscitada });
  }

  // Parar o turno no meio. Só a janela do turno morre; a conversa continua de pé e o
  // estado dela vira `interrompida`, que é o mesmo de um turno que morreu sozinho.
  const mCancelar = rota.match(/^\/api\/sessoes\/([\w-]+)\/turnos\/atual$/);
  if (mCancelar && req.method === 'DELETE') {
    const cancelado = await sessoes.cancelarTurno(mCancelar[1]);
    if (!cancelado) return enviarJson(res, 404, { erro: 'nenhum turno em andamento' });
    return enviarJson(res, 200, cancelado);
  }

  // Contexto, custo e modelo desta conversa. Relido do disco a cada pedido.
  const mUso = rota.match(/^\/api\/sessoes\/([\w-]+)\/uso$/);
  if (mUso && req.method === 'GET') {
    const dados = await sessoes.uso(mUso[1]);
    // A lista de comandos é do autocomplete, não do painel: 150 nomes por pedido à toa.
    const { comandos, ...resumo } = dados;
    return enviarJson(res, 200, resumo);
  }

  // Arquivos que o agente escreveu nesta conversa. A lista É a autorização do download.
  const mArquivos = rota.match(/^\/api\/sessoes\/([\w-]+)\/arquivos$/);
  if (mArquivos && req.method === 'GET') {
    const lista = await sessoes.arquivos(mArquivos[1]);
    // O caminho absoluto não sai daqui: o cliente só precisa do relativo, que é o que
    // ele devolve no download. Menos superfície, e nada de expor a árvore do disco.
    return enviarJson(res, 200, {
      arquivos: lista.map(({ caminho, ...resto }) => resto),
    });
  }

  const mBaixar = rota.match(/^\/api\/sessoes\/([\w-]+)\/arquivos\/baixar$/);
  if (mBaixar && req.method === 'GET') {
    const relativo = url.searchParams.get('caminho');
    if (!relativo) return enviarJson(res, 400, { erro: 'falta o caminho' });
    const achado = await sessoes.arquivoParaBaixar(mBaixar[1], relativo);
    const dados = await fsp.readFile(achado.caminho);
    res.writeHead(200, {
      'content-type': TIPOS[path.extname(achado.caminho)] || 'application/octet-stream',
      'content-length': dados.length,
      // attachment sempre: nunca renderizar no mesmo domínio arquivo escrito pelo agente.
      'content-disposition': `attachment; filename="${path.basename(achado.caminho).replace(/["\\]/g, '')}"`,
      'cache-control': 'no-store',
    });
    return res.end(dados);
  }

  const mEventos = rota.match(/^\/api\/sessoes\/([\w-]+)\/eventos$/);
  if (mEventos && req.method === 'GET') return abrirFluxo(req, res, mEventos[1]);

  const mSessao = rota.match(/^\/api\/sessoes\/([\w-]+)$/);
  if (mSessao && req.method === 'DELETE') {
    const id = mSessao[1];
    // Sem `?apagar=1` continua sendo só encerrar — a semântica antiga, que o gate 3 usa.
    if (url.searchParams.get('apagar') !== '1') {
      return enviarJson(res, 200, await sessoes.encerrar(id));
    }
    const resposta = await sessoes.excluir(id);
    barramento.emit('removida', { sessaoId: id });
    return enviarJson(res, 200, resposta);
  }

  return enviarJson(res, 404, { erro: 'rota desconhecida' });
}

const atender = async (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (!acesso.origemPermitida(req, TOKEN)) return enviarJson(res, 403, { erro: 'origem não permitida' });
  // Silêncio de 5 min por requisição (R31): substitui o `requestTimeout` de 5 min do Node —
  // que media DURAÇÃO total e matava um upload de 2 GB por 4G — por INATIVIDADE. `lerCorpo` e
  // `lerBinario` ficam cobertos sem uma linha neles; o SSE manda `: ping` a cada 20 s.
  req.setTimeout(arquivos.silencioGeral(), () => req.destroy());
  // O Tailscale publica isto sob um path (/cockpit), então o pathname chega com prefixo —
  // mesma armadilha que o painel-externo levou e corrigiu no commit a84cc96.
  const url = new URL(req.url, 'http://localhost');
  const rota = url.pathname.replace(/^\/cockpit(?=\/|$)/, '') || '/';

  try {
    // `requestTimeout` do Server VIVO (R48): é como o gate prova por comportamento, no servidor
    // que ele mesmo subiu, que o 0 do R3 está no objeto e não só no fonte.
    if (rota === '/health') {
      return enviarJson(res, 200, {
        ok: true, servico: 'cockpit-agentes', porta: PORT,
        requestTimeout: req.socket && req.socket.server ? req.socket.server.requestTimeout : null,
      });
    }
    if (rota.startsWith('/api/')) return await api(req, res, rota, url);
    if (rota === '/' || rota === '/index.html') return enviarArquivo(res, path.join(PUBLIC_DIR, 'index.html'));
    if (rota === '/grafo' || rota.startsWith('/grafo/')) return await rotaDoGrafo(req, res, rota, url);
    if (rota === '/mapa' || rota.startsWith('/mapa/')) return await rotaDoMapa(res, rota, url);
    if (rota === '/diff' || rota.startsWith('/diff/')) return await rotaDoDiff(res, rota, url);

    // Estático, preso ao public/: sem isso, "/../.." leria qualquer arquivo do usuário.
    const pedido = path.resolve(path.join(PUBLIC_DIR, rota));
    // Com separador: sem ele, "/home/x/publicoutro" passa por "/home/x/public".
    if (pedido !== path.resolve(PUBLIC_DIR) && !pedido.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
      return enviarJson(res, 403, { erro: 'fora do public' });
    }
    return enviarArquivo(res, pedido);
  } catch (erro) {
    if (!res.headersSent) return enviarJson(res, 500, { erro: String(erro && erro.message) });
    res.end();
  }
};

const certificado = lerCertificado();

/**
 * `requestTimeout = 0` (R3): o padrão do Node 22 é 5 min do primeiro byte ao último, e ele
 * derruba com 408 SEM LOG qualquer requisição mais longa — um upload de 2 GB por 4G morre no
 * meio e o cliente vê "falha de rede". Zero desliga o limite de DURAÇÃO; o que segura a porta
 * é o silêncio de `atender()` (inatividade) e os tetos de `lib/arquivos.js`. Tem que ser
 * escrito DEPOIS do `createServer`: `{ requestTimeout: 0 }` na opção cai no `|| 300000`.
 * `headersTimeout` (60 s) fica — ele mede só os cabeçalhos.
 */
function semTimeoutDeRequisicao(servidor) {
  servidor.requestTimeout = 0;
  return servidor;
}

// O cache de uso de versão anterior sai do disco no BOOT, não na primeira visita à tela de
// uso: o v2 guardava a cauda de cada conversa em hex (card assinatura-do-cache-guarda-
// conteudo-em-hex). A promessa nunca rejeita.
uso.descartarCacheDeOutraVersao();

// O monitor carrega o histórico e semeia a CPU ANTES do `listen`: a promessa `pronto` (que as
// rotas aguardam) fecha a janela entre o socket aberto e o estado carregado. Nunca rejeita.
monitor.preparar();

if (!certificado) {
  semTimeoutDeRequisicao(http.createServer(atender)).listen(PORT, HOST, () => {
    console.log(`cockpit-agentes em http://${HOST}:${PORT}${TOKEN ? ' (token exigido)' : ''}`);
    console.log('HTTP local; para acesso remoto e PWA, configure HTTPS no servidor ou no proxy.');
    // O vigia das abas: quem manda a notificação de fim de turno e de pedido de intervenção.
    // Vive AQUI e não no fluxo SSE de propósito — o ponto da notificação é o usuário NÃO
    // estar com a tela aberta (o mesmo raciocínio de `vigiarParaAvisar`, :300).
    //
    // A posição NÃO protege teste nenhum: `server.js` sobe o `listen` no próprio `require`
    // (testes/gate-ui.js registra isso). Quem protege é a trava de `COCKPIT_CONTATO` do módulo.
    vigiaAbas.iniciar({ listar: listarAbasComFim });
    // O relógio do monitor, pelo mesmo motivo (ver o comentário do vigia acima).
    monitor.iniciar();
    disco.iniciar();
  });
} else {
  // Uma porta, dois esquemas. O primeiro byte de um handshake TLS é sempre 0x16; qualquer
  // outra coisa é HTTP em texto. Assim o link antigo (http://<ip>:7879) continua abrindo:
  // em vez de um erro ilegível de "conexão foi resetada", ele leva um redirect para o
  // endereço novo. Sem isso, todo bookmark e todo atalho salvo morreria calado.
  const seguro = semTimeoutDeRequisicao(https.createServer({ cert: certificado.cert, key: certificado.key }, atender));
  const redirecionador = semTimeoutDeRequisicao(http.createServer((req, res) => {
    res.writeHead(301, { location: `https://${certificado.nome}:${PORT}${req.url}` });
    res.end();
  }));

  net.createServer((socket) => {
    socket.once('data', (primeiro) => {
      socket.pause();
      socket.unshift(primeiro);
      (primeiro[0] === 0x16 ? seguro : redirecionador).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  }).listen(PORT, HOST, () => {
    console.log(`cockpit-agentes em https://${certificado.nome}:${PORT}${TOKEN ? ' (token exigido)' : ''}`);
    console.log(`http na mesma porta redireciona para o endereço seguro`);
    // Ver o comentário do ramo sem TLS acima. Produção roda ESTE ramo (30-caminhos.conf traz
    // COCKPIT_TLS_CERT/KEY), então fiar só o `if` deixaria a feature morta em produção.
    vigiaAbas.iniciar({ listar: listarAbasComFim });
    // O relógio do monitor, pelo mesmo motivo (ver o comentário do vigia acima).
    monitor.iniciar();
    disco.iniciar();
  });
}
