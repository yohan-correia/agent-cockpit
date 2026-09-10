'use strict';
/**
 * Arquivos — a OUTRA porta de arquivo do cockpit, ao lado do clipe.
 *
 * O clipe (`/api/abas/:chave/anexos`, `lib/abas.js`) é para foto e PDF de até 20 MB e não
 * muda. Esta porta é para QUALQUER tipo até 2 GB (um vídeo, um zip), direto para
 * `~/taildrop-inbox/<pasta>/`, e para a fila do Taildrop nos dois sentidos. Tudo que fala
 * com disco e com o Tailscale mora aqui; `server.js` só roteia.
 *
 * NUNCA usa `lerBinario`: ele acumula o corpo inteiro na RAM, e 2 GB derrubariam o serviço.
 * O corpo vai por `pipeline` para um `~parcial` no disco e só ganha nome bom no fim (R4).
 *
 * Três travas de caminho, todas contra o CLIENTE HTTP (a fronteira de confiança, §3.1.0):
 *   R1 — mandar pra fora só de dentro das três raízes fixas, com `realpath` ANTES de qualquer
 *        `startsWith` (symlink fura allowlist de string, #18); a CLI recebe o realpath.
 *   R2 — a pasta de destino é um NOME casado exato contra o `readdir` do inbox; caminho de
 *        disco nunca entra pelo cliente (#22).
 *   R7 — o nome do arquivo é `basename` + lavagem + trava do `dirname`, extensão preservada.
 * Configuração por env, lida em TEMPO DE CHAMADA (padrão de `lib/abas.js`), para o gate trocar
 * inbox, binário, socket, teto e silêncios sem mexer no `require.cache`.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');

/** Erro com `codigo`: a rota traduz em status. Sem código é falha operacional → 500 (R42). */
const erro = (codigo, mensagem) => Object.assign(new Error(mensagem), { codigo });

// ── Configuração, lida em tempo de chamada ──────────────────────────────────

/** Inteiro seguro positivo, ou o padrão. Vazio, negativo, decimal e lixo caem no padrão. */
function inteiroPositivo(valor, padrao) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return padrao;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n > 0 ? n : padrao;
}

const raizDoInbox = () => process.env.COCKPIT_INBOX || path.join(os.homedir(), 'taildrop-inbox');
const binarioTailscale = () => process.env.COCKPIT_BIN_TAILSCALE || '/usr/bin/tailscale';
const socketTailscale = () => process.env.COCKPIT_TAILSCALE_SOCKET || '/var/run/tailscale/tailscaled.sock';
const tetoDoUpload = () => inteiroPositivo(process.env.COCKPIT_TETO_ARQUIVO, 2 * 1024 ** 3);
/** Silêncio (não duração) que derruba UM upload: 2 min sem chegar byte (R22/R24). */
const silencioDoUpload = () => inteiroPositivo(process.env.COCKPIT_SILENCIO_UPLOAD_MS, 120000);
/** Silêncio que derruba QUALQUER requisição — substitui o `requestTimeout` de 5 min (R31). */
const silencioGeral = () => inteiroPositivo(process.env.COCKPIT_SILENCIO_MS, 300000);

const MAXIMO_UPLOADS = 3;              // 429 acima disto (R22/R51)
const MAXIMO_ENVIOS = 2;               // processos `tailscale file cp` vivos por até 2 h (R54)
const MARGEM_DISCO = 256 * 1024 * 1024; // o sistema e o serviço nunca ficam com zero (R59)
const TENTATIVAS_DE_NOME = 20;         // EEXIST no open/link recalcula o nome até aqui, depois 409
const TETO_LOCALAPI = 1 << 20;         // resposta da localapi acima disto é defeito, não dado (R37)
const TETO_SAIDA_CLI = 2000;           // o que a tela mostra do que a CLI disse
const MAX_BUFFER_CLI = 1 << 20;        // estourou → a CLI "falou demais" (R53)
const TIMEOUT_GET_MS = 900000;         // 15 min: o `get` move arquivo LOCAL; é folga para travamento
const TIMEOUT_CP_MS = 7200000;         // 2 h: o `cp` atravessa a rede; 2 GB por 4G passa de 15 min (R46)
const TAMANHO_MAXIMO_DO_NOME = 120;

// Estado de módulo: um processo, um contador de cada.
let subindo = 0;      // uploads em curso
let reservado = 0;    // soma dos content-length dos uploads em curso (R59)
let puxando = false;  // um `tailscale file get` por vez (R34)
let enviando = 0;     // `tailscale file cp` em curso

const existe = (caminho) => fsp.lstat(caminho).then(() => true, () => false);
const dentroDe = (alvo, base) => alvo.startsWith(base + path.sep);

// ── §3.1.1 — as pastas do inbox ─────────────────────────────────────────────

/**
 * A ÚNICA escrita fora do upload (R60): `mkdir -p <inbox>/_triagem` com modo 0o755. Se já
 * existir e NÃO for diretório real (arquivo, symlink) → 500. Chamada pela rota `/pastas` e
 * por `pastaDeDestino` antes do `readdir`.
 */
async function garantirTriagem() {
  const triagem = path.join(raizDoInbox(), '_triagem');
  try {
    await fsp.mkdir(triagem, { recursive: true, mode: 0o755 });
    const estado = await fsp.lstat(triagem);
    if (!estado.isDirectory()) throw new Error(`${triagem} não é diretório`);
  } catch (e) {
    console.error('arquivos: não consegui criar _triagem —', e.message);
    throw erro(500, 'não consegui criar _triagem');
  }
}

/**
 * Só lê. `Dirent.isDirectory()` é falso para symlink — `pasta-link` já fica de fora aqui;
 * o `realpath` de `pastaDeDestino` é a segunda cerca. Ordenada, `_triagem` primeiro.
 */
async function pastasDoInbox() {
  const entradas = await fsp.readdir(raizDoInbox(), { withFileTypes: true });
  const nomes = entradas
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  const i = nomes.indexOf('_triagem');
  if (i > 0) { nomes.splice(i, 1); nomes.unshift('_triagem'); }
  return nomes.map((nome) => ({ nome }));
}

// ── §3.1.2 — a pasta de destino (R2, R21) ───────────────────────────────────

/**
 * Igualdade EXATA de string contra `pastasDoInbox()` (a régua do `POST /api/abas`). Qualquer
 * outra coisa — `..`, `/`, vazio, `_triagem/x` — devolve `null` e a rota responde 400.
 * Depois de casar o nome, confere ONDE a pasta está: `realpath(pasta)` tem que começar com
 * `realpath(inbox) + sep` (R21). O caminho de disco nunca entra pelo cliente.
 */
async function pastaDeDestino(nome) {
  if (typeof nome !== 'string' || !nome) return null;
  await garantirTriagem();
  const pastas = await pastasDoInbox();
  if (!pastas.some((p) => p.nome === nome)) return null;
  const inbox = raizDoInbox();
  const pasta = path.join(inbox, nome);
  try {
    const realInbox = await fsp.realpath(inbox);
    const realPasta = await fsp.realpath(pasta);
    if (!dentroDe(realPasta, realInbox)) return null;
  } catch {
    return null;
  }
  return pasta;
}

/**
 * Depois do `open` do `~parcial` (R26/R32): `wx` não segue symlink no ARQUIVO, mas não
 * protege os diretórios do caminho. Se a pasta virou symlink no meio, o temporário nasceu
 * fora do inbox — quem chama apaga (foi este módulo que o criou) e responde 400.
 */
async function conferirTemporario(temporario) {
  let real;
  let realInbox;
  try {
    realInbox = await fsp.realpath(raizDoInbox());
    real = await fsp.realpath(temporario);
  } catch {
    throw erro(400, 'a pasta de destino mudou no meio do envio');
  }
  if (!dentroDe(real, realInbox)) throw erro(400, 'a pasta de destino saiu do inbox');
}

// ── §3.1.3 — o nome (R7, R25) ───────────────────────────────────────────────

/**
 * A lavagem do `guardarAnexo` preservando a extensão. Cada SEQUÊNCIA inválida vira UM `-`;
 * sem ponto/hífen nas pontas (`..` e `.escondido` não nascem); nome só de caracteres
 * inválidos vira `arquivo`; o corte de 120 é no nome-base, nunca na extensão. `~` não está
 * em `[\w.-]`, então nenhum nome daqui colide com um `~parcial`.
 */
function nomeSeguro(nome) {
  const lavado = path.basename(String(nome || '')).replace(/[^\w.-]+/g, '-');
  const ext = path.extname(lavado).slice(0, 16);
  let base = lavado.slice(0, lavado.length - ext.length).replace(/^[.-]+|[.-]+$/g, '');
  if (!base) base = 'arquivo';
  return base.slice(0, TAMANHO_MAXIMO_DO_NOME - ext.length) + ext;
}

/**
 * S1: o primeiro nome livre — `nome`, depois `base (1).ext`, `(2)`… — conferindo `final` E
 * `final~parcial`. `path.extname` pega só a última extensão: `a.tar.gz` vira `a.tar (1).gz`.
 * Devolve o caminho absoluto.
 */
async function nomeLivre(pasta, nome, inicio = 0) {
  const ext = path.extname(nome);
  const base = nome.slice(0, nome.length - ext.length);
  for (let n = inicio; n < inicio + 10000; n += 1) {
    const final = path.join(pasta, n === 0 ? nome : `${base} (${n})${ext}`);
    if (!(await existe(final)) && !(await existe(`${final}~parcial`))) return final;
  }
  throw erro(409, 'não achei um nome livre');
}

// ── §3.1.4 — o upload por stream (R4) ───────────────────────────────────────

/**
 * `content-length` como número (R52): ausente → `null`; até 15 dígitos → `Number`; 16 ou
 * mais → maior que qualquer teto possível, logo 413 na hora — nunca "ausente".
 */
function tamanhoDeclarado(req) {
  const bruto = req.headers['content-length'];
  if (bruto === undefined) return null;
  const texto = String(bruto).trim();
  if (/^\d{1,15}$/.test(texto)) return Number(texto);
  throw erro(413, 'arquivo maior que o teto');
}

/**
 * O corpo do `req` vai para `<pasta>/<nome>~parcial` e, no fim, ganha o nome bom por
 * `link` + `unlink` — NUNCA `rename`, que substituiria um arquivo que apareceu por fora (R27).
 *
 * Ordem das recusas antes do primeiro byte: 429 (simultâneos) → 413 (teto) → 507 (disco).
 * Duas variáveis (R30): `temporario` fica FIXO a partir do `wx` que deu certo; `final` pode
 * ser recalculado até o instante do `link`. Toda limpeza é de `temporario`.
 * Um dono só do descritor (R41): o `FileHandle`; o stream nasce de `fd.createWriteStream()`
 * e fecha o handle quando termina ou erra.
 * Abrir → conferir → consumir (R35): `conferirTemporario` roda ANTES de qualquer byte sair do
 * `req`, que só é lido dentro do `pipeline`.
 * Contrato de erro (R42): erro com `codigo` vira status; qualquer outro é 500 genérico; cliente
 * que sumiu não recebe resposta — só a limpeza roda. O 408 do silêncio é marcador para o log.
 */
async function receber({ req, pasta, nome }) {
  if (subindo >= MAXIMO_UPLOADS) throw erro(429, `já tem ${MAXIMO_UPLOADS} arquivos subindo`);
  subindo += 1;
  let declarado = null;
  let reservei = false;
  let temporario = null;
  try {
    // Silêncio (R24): callback EXPLÍCITO. O `req.destroy` faz o `pipeline` rejeitar com o 408
    // (marcador para o log, nunca resposta); o socket é destruído aqui também, porque o
    // `IncomingMessage` do Node 22 não o derruba sozinho — e a conexão que silenciou não
    // recebe resposta nenhuma (R42).
    req.setTimeout(silencioDoUpload(), () => {
      const socket = req.socket;
      req.destroy(erro(408, 'o envio parou de chegar'));
      if (socket && !socket.destroyed) socket.destroy();
    });
    const teto = tetoDoUpload();
    declarado = tamanhoDeclarado(req);
    if (declarado !== null && declarado > teto) throw erro(413, `arquivo maior que o teto de ${teto} bytes`);
    if (declarado !== null) {
      const disco = await fsp.statfs(pasta);
      const livre = Number(disco.bavail) * Number(disco.bsize);
      if (livre < declarado + reservado + MARGEM_DISCO) throw erro(507, 'não cabe no disco');
      reservado += declarado;
      reservei = true;
    }

    const seguro = nomeSeguro(nome);
    let final = await nomeLivre(pasta, seguro);
    // Trava final, depois da lavagem — a mesma cicatriz de lib/abas.js.
    if (path.dirname(path.resolve(final)) !== path.resolve(pasta)) throw erro(400, 'nome recusado');

    let fd = null;
    for (let tentativa = 0; ; tentativa += 1) {
      temporario = `${final}~parcial`;
      try {
        fd = await fsp.open(temporario, 'wx', 0o644);
        break;
      } catch (e) {
        temporario = null;
        if (e.code !== 'EEXIST') throw e;
        if (tentativa >= TENTATIVAS_DE_NOME - 1) throw erro(409, 'não consegui um nome livre para o temporário');
        final = await nomeLivre(pasta, seguro);
      }
    }
    try {
      await conferirTemporario(temporario);
    } catch (e) {
      await fd.close();
      throw e;
    }

    let bytes = 0;
    const contador = new Transform({
      transform(pedaco, codificacao, cb) {
        bytes += pedaco.length;
        if (bytes > teto) return cb(erro(413, `arquivo maior que o teto de ${teto} bytes`));
        return cb(null, pedaco);
      },
    });
    await pipeline(req, contador, fd.createWriteStream());

    if (bytes === 0) throw erro(400, 'arquivo vazio');
    if (declarado !== null && bytes !== declarado) throw erro(400, 'tamanho não bate com o content-length');

    for (let tentativa = 0; ; tentativa += 1) {
      try {
        await fsp.link(temporario, final);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (tentativa >= TENTATIVAS_DE_NOME - 1) throw erro(409, 'não consegui um nome livre para o arquivo');
        final = await nomeLivre(pasta, seguro);
      }
    }
    // O arquivo bom existe: é 201 mesmo que o unlink do temporário falhe (R42); o órfão fica
    // escondido pelas listas (R8).
    const limpar = temporario;
    temporario = null;
    await fsp.unlink(limpar).catch((e) => console.error('arquivos: ~parcial órfão —', e.message));
    return { nome: path.basename(final), bytes, pasta: path.basename(pasta) };
  } catch (e) {
    if (temporario) await fsp.unlink(temporario).catch(() => {});
    throw e;
  } finally {
    subindo -= 1;
    if (reservei) reservado -= declarado;
  }
}

// ── §3.1.5/§3.1.6 — a localapi do tailscaled (R6, R16, R37, R45) ────────────

/**
 * Um GET na localapi pelo unix socket. `Host: local-tailscaled.sock` é obrigatório (R16 —
 * medido na spec: sem ele o tailscaled responde 403 "invalid localapi request"; o curl
 * escondia isso porque a URL já levava o host). A opção `timeout` só EMITE o evento; é o
 * `destroy` que rejeita a Promise (R45). Corpo acima de 1 MiB é destruído e rejeitado —
 * nunca se acumula uma resposta defeituosa inteira na RAM (R37). Resolve `{ status, corpo }`
 * e rejeita SÓ por exceção de rede: quem decide o que é "falha" são as duas funções abaixo.
 *
 * A localapi NÃO é contrato público (#10 aplicada ao tailscaled): o formato de `files/` e de
 * `file-targets` pode mudar numa atualização. Por isso `lerFila` e `destinos` nunca lançam —
 * devolvem `null` + `erro`, a rota responde 200 e a tela degrada SÓ aquele bloco (R6).
 */
function localapi(caminho) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: socketTailscale(),
      path: caminho,
      method: 'GET',
      headers: { host: 'local-tailscaled.sock' },
      timeout: 3000,
    }, (res) => {
      const pedacos = [];
      let total = 0;
      res.on('data', (pedaco) => {
        total += pedaco.length;
        if (total > TETO_LOCALAPI) {
          res.destroy(new Error('resposta da localapi grande demais'));
          return;
        }
        pedacos.push(pedaco);
      });
      res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(pedacos).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout na localapi')));
    req.on('error', reject);
    req.end();
  });
}

/** `{ fila: [{ nome, bytes }] }` ou `{ fila: null, erro }`. `null` no corpo é fila vazia. Nunca lança. */
async function lerFila() {
  try {
    const { status, corpo } = await localapi('/localapi/v0/files/');
    if (status !== 200) throw new Error(`localapi respondeu ${status}`);
    const dados = JSON.parse(corpo);
    if (dados === null) return { fila: [] };
    if (!Array.isArray(dados)) throw new Error('files/ não é lista');
    const fila = dados.map((item) => {
      if (!item || typeof item.Name !== 'string') throw new Error('item sem Name');
      return { nome: item.Name, bytes: Number(item.Size) || 0 };
    });
    return { fila };
  } catch (e) {
    return { fila: null, erro: 'não consegui ler a fila do Taildrop' };
  }
}

/** `{ destinos: [{ nome, online, so }] }` ou `{ destinos: null, erro }`. Só isso sai para o cliente. */
async function destinos() {
  try {
    const { status, corpo } = await localapi('/localapi/v0/file-targets');
    if (status !== 200) throw new Error(`localapi respondeu ${status}`);
    const dados = JSON.parse(corpo);
    if (dados === null) return { destinos: [] };
    if (!Array.isArray(dados)) throw new Error('file-targets não é lista');
    const lista = dados.map((item) => {
      const no = item && item.Node;
      if (!no || typeof no.ComputedName !== 'string') throw new Error('destino sem ComputedName');
      return {
        nome: no.ComputedName,
        online: Boolean(no.Online),
        so: no.Hostinfo && typeof no.Hostinfo.OS === 'string' ? no.Hostinfo.OS : '',
      };
    });
    return { destinos: lista };
  } catch (e) {
    return { destinos: null, erro: 'não consegui listar os aparelhos' };
  }
}

// ── §3.1.7 — a CLI (R5, R23, R29, R34, R38, R53) ────────────────────────────

/**
 * Tudo que vem da CLI passa por aqui antes de sair para o cliente. `rotulos` é a lista
 * `[[caminhoAbsoluto, rotulo], …]` dos caminhos que ESTE módulo passou à CLI nesta chamada,
 * trocados do mais longo para o mais curto; depois `os.homedir()` vira `~` e qualquer
 * `/home/<usuário>` restante vira `~` também. A promessa é esta e só esta (R29): um caminho
 * que a CLI invente por conta própria não é coberto. Lava ANSI e caracteres de controle
 * fora de `\n`/`\t` (R38) e corta em 2000 — do lado da tela, tudo entra por `textContent`.
 */
function semCaminhos(texto, rotulos = []) {
  let saida = String(texto || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const ordenados = rotulos
    .filter(([caminho]) => typeof caminho === 'string' && caminho)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [caminho, rotulo] of ordenados) saida = saida.split(caminho).join(rotulo);
  const home = os.homedir();
  if (home && home !== '/') saida = saida.split(home).join('~');
  saida = saida.replace(/\/home\/[^/\s]+/g, '~');
  return saida.slice(0, TETO_SAIDA_CLI);
}

/**
 * `execFile` da CLI com `maxBuffer` de 1 MiB (R53): estourou → o processo é morto e a
 * resposta é 502 "a CLI falou demais". Qualquer outro erro é 502 com a mensagem da CLI já
 * passada por `semCaminhos`.
 */
function rodarCli(args, timeout, rotulos) {
  return new Promise((resolve, reject) => {
    execFile(binarioTailscale(), args, { timeout, maxBuffer: MAX_BUFFER_CLI }, (e, stdout, stderr) => {
      if (!e) return resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(erro(502, 'a CLI falou demais'));
      const texto = semCaminhos(`${stderr || ''}${stdout || ''}`.trim() || e.message, rotulos).trim();
      return reject(erro(502, texto || 'a CLI do Tailscale falhou'));
    });
  });
}

/** Os arquivos regulares (sem `*~parcial`) na raiz do inbox — a régua do `puxados`. */
async function nomesNaRaiz(inbox) {
  const entradas = await fsp.readdir(inbox, { withFileTypes: true }).catch(() => []);
  return new Set(entradas.filter((d) => d.isFile() && !d.name.endsWith('~parcial')).map((d) => d.name));
}

/**
 * `tailscale file get --conflict=rename <inbox>` — a fila INTEIRA pousa na raiz do inbox, como
 * manda a convenção. NUNCA `skip` (deixaria o repetido preso) nem `overwrite` (apagaria o que
 * já estava lá — é apagar sem o "vai"). Um por vez (R34): a segunda chamada concorrente é 409.
 * `puxados` é MEDIDO no disco: nomes novos na raiz enquanto a CLI rodava (R28) — a CLI não
 * devolve contagem, e é por isso que a tela escreve "N arquivos novos na raiz", nunca "puxei N".
 */
async function puxar() {
  if (puxando) throw erro(409, 'já estou puxando a fila');
  puxando = true;
  try {
    const inbox = raizDoInbox();
    const realInbox = await fsp.realpath(inbox).catch(() => inbox);
    const rotulos = [[realInbox, 'inbox'], [inbox, 'inbox']];
    const antes = await nomesNaRaiz(inbox);
    const { stdout, stderr } = await rodarCli(['file', 'get', '--conflict=rename', inbox], TIMEOUT_GET_MS, rotulos);
    const depois = await nomesNaRaiz(inbox);
    let puxados = 0;
    for (const nome of depois) if (!antes.has(nome)) puxados += 1;
    return { puxados, saida: semCaminhos(`${stdout}${stderr}`, rotulos).trim() };
  } finally {
    puxando = false;
  }
}

// ── §3.1.8/§3.1.9 — mandar pra fora (R1) ────────────────────────────────────

/** As três raízes, FECHADAS por id. Função (não constante) porque `HOME` e `COCKPIT_INBOX` são lidos na hora. */
function raizes() {
  return {
    inbox: raizDoInbox(),
    projetos: path.join(os.homedir(), 'projetos'),
    cockpit: path.join(os.homedir(), '.cockpit'),
  };
}

/**
 * `realpath` ANTES do `startsWith`, com separador (#18). Só `startsWith` na string resolvida
 * é furado por symlink: `~/projetos/x/link -> ~/.secrets` passa em `path.resolve` e cai dentro
 * de `~/.secrets` no disco. Alvo que não existe é 400 — "não existe" é estado do mundo, não falha.
 */
async function resolverNaRaiz(raiz, caminho) {
  const mapa = raizes();
  if (typeof raiz !== 'string' || !Object.prototype.hasOwnProperty.call(mapa, raiz)) throw erro(400, 'raiz desconhecida');
  if (typeof caminho !== 'string') throw erro(400, 'caminho inválido');
  let base;
  let alvo;
  try {
    base = await fsp.realpath(mapa[raiz]);
    alvo = await fsp.realpath(path.resolve(base, caminho));
  } catch {
    throw erro(400, 'esse caminho não existe');
  }
  if (alvo !== base && !alvo.startsWith(base + path.sep)) throw erro(400, 'fora da raiz');
  return alvo;
}

/** Um nível, sem recursão: pastas primeiro, sem `.*`, sem `node_modules`, sem `*~parcial` (S2). */
async function listar(raiz, caminho = '') {
  const alvo = await resolverNaRaiz(raiz, caminho);
  let entradas;
  try {
    entradas = await fsp.readdir(alvo, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOTDIR') throw erro(400, 'isso não é uma pasta');
    throw e;
  }
  const itens = [];
  for (const d of entradas) {
    if (d.name.startsWith('.') || d.name === 'node_modules' || d.name.endsWith('~parcial')) continue;
    let estado;
    try {
      estado = await fsp.stat(path.join(alvo, d.name)); // symlink é listado pelo que o stat diz; o guarda roda de novo ao entrar/enviar
    } catch {
      continue; // symlink quebrado some da lista
    }
    itens.push({
      nome: d.name,
      tipo: estado.isDirectory() ? 'pasta' : 'arquivo',
      bytes: estado.size,
      modificadoEm: Math.round(estado.mtimeMs),
    });
  }
  itens.sort((a, b) => (a.tipo === b.tipo ? a.nome.localeCompare(b.nome) : (a.tipo === 'pasta' ? -1 : 1)));
  return { raiz, caminho, itens };
}

/**
 * `tailscale file cp <realpath> <destino>:`. O destino tem que casar EXATO um `nome` de
 * `destinos()` lido AGORA (não a lista que o cliente viu ao abrir); `ComputedName` é único
 * no tailnet (R55) e, por defesa, dois iguais é 502 sem enviar. No máximo 2 envios ao mesmo
 * tempo (R54). O caminho que vai para a CLI é o realpath, nunca a string do cliente.
 */
async function enviarParaFora({ raiz, caminho, destino }) {
  if (typeof destino !== 'string' || !destino) throw erro(400, 'escolha um aparelho da lista');
  const alvo = await resolverNaRaiz(raiz, caminho);
  const estado = await fsp.stat(alvo).catch(() => null);
  if (!estado || !estado.isFile()) throw erro(400, 'escolha um arquivo, não uma pasta');
  const lidos = await destinos();
  if (!lidos.destinos) throw erro(502, 'não consegui listar os aparelhos');
  const iguais = lidos.destinos.filter((d) => d.nome === destino);
  if (iguais.length === 0) throw erro(400, 'escolha um aparelho da lista');
  if (iguais.length > 1) throw erro(502, 'dois aparelhos com o mesmo nome — não escolho um');
  if (enviando >= MAXIMO_ENVIOS) throw erro(429, `já tem ${MAXIMO_ENVIOS} envios saindo`);
  enviando += 1;
  try {
    await rodarCli(['file', 'cp', alvo, `${destino}:`], TIMEOUT_CP_MS, [[alvo, path.basename(alvo)]]);
    return { enviado: true, bytes: estado.size, destino };
  } finally {
    enviando -= 1;
  }
}

module.exports = {
  erro,
  raizDoInbox,
  binarioTailscale,
  socketTailscale,
  tetoDoUpload,
  silencioDoUpload,
  silencioGeral,
  garantirTriagem,
  pastasDoInbox,
  pastaDeDestino,
  conferirTemporario,
  nomeSeguro,
  nomeLivre,
  tamanhoDeclarado,
  receber,
  localapi,
  lerFila,
  destinos,
  semCaminhos,
  puxar,
  raizes,
  resolverNaRaiz,
  listar,
  enviarParaFora,
};
