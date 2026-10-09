'use strict';
// A medida do disco do monitor — o que ocupa o disco do servidor (card
// `monitor-maior-com-top-10-por-eixo`, D68; spec
// docs/superpowers/specs/2026-10-07-monitor-maior-com-top-10-por-eixo-design.md, §4.1).
// Roda `du` (home e raiz) e `docker system df` — processos externos que levam dezenas de segundos —,
// por isso mora fora do `lib/monitor.js` (que mede `/proc` em milissegundos), com trava e relógio
// próprios. Regras de produto que moram aqui:
//   - SÓ LEITURA: nada aqui apaga, limpa ou faz prune;
//   - `du`/`docker` por `COCKPIT_DU_BIN`/`COCKPIT_DOCKER_BIN` (default `du`/`docker`), lidas a cada
//     chamada: é o que deixa o gate trocar os dois por scripts falsos (#78 — gate nunca roda `du`
//     nem `docker` de verdade);
//   - o stderr NUNCA é lido (o `du` o enche de caminhos): só o código de erro vai para log;
//   - um escritor só: `medirAgora()` devolve a MESMA promessa enquanto houver uma medição em curso;
//   - `disco.json` mora em `COCKPIT_MONITOR_DIR` (a mesma pasta do histórico, via `monitor.dirDe`);
//   - `COCKPIT_MONITOR_MS=0` desliga o relógio de fundo (o interruptor de testes da D64).
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const monitor = require('./monitor');

const TOP = 10;
const VALIDADE_S = 21600;          // 6 h
const ESPERA_FALHA_S = 900;        // 15 min depois de uma falha TOTAL (spec §4.1)
const TETO_ARQUIVO = 256 * 1024;
const TIPOS_DOCKER = { Images: 'imagens', Containers: 'conteineres', 'Local Volumes': 'volumes', 'Build Cache': 'cache' };
const ORDEM_DOCKER = ['imagens', 'conteineres', 'volumes', 'cache'];
const UNIDADES = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }; // go-units: DECIMAL
const FALHAS = new Set(['tempo', 'saida', 'indisponivel', 'vazio', 'falhou']);

// Resolvidos a CADA chamada, como `dirDe` do irmão: o gate troca de falso entre os casos.
const binDu = () => process.env.COCKPIT_DU_BIN || 'du';
const binDocker = () => process.env.COCKPIT_DOCKER_BIN || 'docker';

// ─── Funções PURAS ───────────────────────────────────────────────────────────────────────

/** Dentro da home → `~/<resto>`; senão o caminho (na raiz, `/<nome>`). O nome de usuário nunca sai. */
function rotuloDe(caminho, home) {
  if (caminho === home) return '~';
  if (home && caminho.startsWith(`${home}/`)) return `~/${caminho.slice(home.length + 1)}`;
  return caminho;
}

/**
 * Saída de `du -x -k -d 1 -0 <alvo>` (registros `"<KiB>\t<caminho>\0"`; `-0` porque nome de pasta
 * pode ter `\n`). O registro cujo caminho é o próprio alvo é o `total`; só filhos DIRETOS entram.
 */
function lerSaidaDu(texto, alvo, home) {
  const prefixo = alvo === '/' ? '/' : `${alvo}/`;
  let total = null;
  const itens = [];
  for (const registro of String(texto).split('\0')) {
    const m = /^(\d+)\t([\s\S]+)$/.exec(registro);
    if (!m) continue;
    const bytes = Number(m[1]) * 1024;
    const caminho = m[2];
    if (caminho === alvo) { total = bytes; continue; }
    if (!caminho.startsWith(prefixo)) continue;
    const resto = caminho.slice(prefixo.length);
    if (!resto || resto.includes('/')) continue;
    itens.push({ rotulo: rotuloDe(caminho, home), bytes, contemHome: home === caminho || home.startsWith(`${caminho}/`) });
  }
  itens.sort((a, b) => b.bytes - a.bytes);
  return { total, itens: itens.slice(0, TOP) };
}

/** `"89.82GB"` → bytes (base 1000, como o Docker); qualquer outra coisa → `null`, nunca `NaN`. */
function bytesDocker(texto) {
  const m = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB)$/.exec(String(texto).trim());
  return m ? Math.round(Number(m[1]) * UNIDADES[m[2]]) : null;
}

/** Saída de `docker system df --format '{{json .}}'` → `[{ tipo, bytes, recuperavel }]` na ordem fixa. */
function lerDockerDf(texto) {
  const achados = {};
  for (const linha of String(texto).split('\n')) {
    let o = null;
    try { o = JSON.parse(linha); } catch { continue; }
    // `Object.hasOwn`, nunca `TIPOS_DOCKER[o.Type]`: `__proto__` passaria pelo acesso direto.
    if (!o || typeof o !== 'object' || !Object.hasOwn(TIPOS_DOCKER, o.Type)) continue;
    const tipo = TIPOS_DOCKER[o.Type];
    const bytes = bytesDocker(o.Size);
    if (bytes === null) continue;
    achados[tipo] = { tipo, bytes, recuperavel: bytesDocker(String(o.Reclaimable || '').trim().split(/\s+/)[0]) };
  }
  return ORDEM_DOCKER.filter((t) => achados[t]).map((t) => achados[t]);
}

/** `true` se não há medida ou se ela tem `validadeS` segundos ou mais. */
const estaVelha = (medida, agoraS, validadeS) => !medida || agoraS - medida.em >= validadeS;

// ─── Execução ─────────────────────────────────────────────────────────────────────────────

/** Roda SEM shell, com teto de tempo e de saída; o stderr é ignorado de propósito (tem caminhos). */
function rodar(bin, args, tempoMs) {
  return new Promise((resolve) => {
    let filho;
    try {
      filho = execFile(bin, args, { timeout: tempoMs, maxBuffer: 4 << 20, encoding: 'utf8' },
        (erro, stdout) => resolve({ erro, stdout: String(stdout || '') }));
    } catch (erro) { resolve({ erro, stdout: '' }); return; }
    // Prioridade de CPU baixa (S6). Só com pid numérico: pid 0 seria o PRÓPRIO servidor.
    if (Number.isInteger(filho.pid) && filho.pid > 0) {
      try { os.setPriority(filho.pid, 19); } catch { /* o filho já saiu (ESRCH) */ }
    }
  });
}

/** Precedência da spec §4.1 — a primeira regra que casa decide; saída parcial de quem foi morto NÃO
 *  vale. O `maxBuffer` vem ANTES do `killed`: quando ele estoura o Node mata o filho e liga os dois
 *  campos, e o código específico é o que diz o porquê. */
function classificar({ erro, stdout }, ler, contar) {
  if (erro && erro.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { falha: 'saida' };
  if (erro && erro.killed) return { falha: 'tempo' };
  if (erro && (erro.code === 'ENOENT' || erro.code === 'EACCES')) return { falha: 'indisponivel' };
  if (erro && typeof erro.code === 'number') {
    if (!ler) return { falha: 'indisponivel' };             // docker que saiu ≠ 0
    const dado = ler(stdout);
    return contar(dado) ? { dado } : { falha: 'vazio' };    // du que saiu 1 por Permission denied
  }
  if (erro) return { falha: 'falhou' };
  const dado = (ler || lerDockerDf)(stdout);
  return contar(dado) ? { dado } : { falha: 'vazio' };
}

/** Três fontes em série: `du` na home, `du` na raiz, `docker system df`. Uma que falha não derruba as outras. */
async function medir({ tempoDuMs = 900000, tempoDockerMs = 120000 } = {}) {
  const inicio = Date.now();
  const home = os.homedir();
  const falhas = {};
  const duDe = async (alvo, chave, rotulo) => {
    const r = classificar(await rodar(binDu(), ['-x', '-k', '-d', '1', '-0', alvo], tempoDuMs),
      (texto) => lerSaidaDu(texto, alvo, home), (d) => d.itens.length > 0);
    if (r.falha) { falhas[chave] = r.falha; return null; }
    return { rotulo, ...r.dado };
  };
  const homeMedida = await duDe(home, 'home', '~');
  const raizMedida = await duDe('/', 'raiz', '/');
  const rd = classificar(await rodar(binDocker(), ['system', 'df', '--format', '{{json .}}'], tempoDockerMs),
    null, (d) => d.length > 0);
  if (rd.falha) falhas.docker = rd.falha;
  return {
    versao: 1, em: Math.floor(inicio / 1000), duracaoMs: Date.now() - inicio,
    home: homeMedida, raiz: raizMedida, docker: rd.falha ? null : rd.dado, falhas,
  };
}

// ─── Persistência ─────────────────────────────────────────────────────────────────────────

const inteiroNaoNeg = (n) => Number.isInteger(n) && n >= 0;

/** Reconstrói a medida campo a campo; `null` se o texto não for uma medida válida (dado de disco não é de confiança). */
function validar(texto, agoraS) {
  if (typeof texto !== 'string' || texto.length > TETO_ARQUIVO) return { motivo: 'grande demais' };
  let o = null;
  try { o = JSON.parse(texto); } catch { return { motivo: 'JSON' }; }
  if (!o || typeof o !== 'object' || o.versao !== 1) return { motivo: 'versão' };
  if (!Number.isInteger(o.em) || o.em > agoraS + 300) return { motivo: 'horário' };
  const bloco = (b, rotulo) => {
    if (b === null) return null;
    if (!b || typeof b !== 'object' || b.rotulo !== rotulo) throw new Error('bloco');
    if (b.total !== null && !inteiroNaoNeg(b.total)) throw new Error('total');
    if (!Array.isArray(b.itens) || b.itens.length > TOP) throw new Error('itens');
    return {
      rotulo, total: b.total,
      itens: b.itens.map((i) => {
        if (!i || typeof i.rotulo !== 'string' || i.rotulo.length > 256 || !inteiroNaoNeg(i.bytes) || typeof i.contemHome !== 'boolean') throw new Error('item');
        return { rotulo: i.rotulo, bytes: i.bytes, contemHome: i.contemHome };
      }),
    };
  };
  try {
    let docker = null;
    if (o.docker !== null) {
      if (!Array.isArray(o.docker) || o.docker.length > ORDEM_DOCKER.length) throw new Error('docker');
      docker = o.docker.map((d) => {
        if (!d || !ORDEM_DOCKER.includes(d.tipo) || !inteiroNaoNeg(d.bytes) || (d.recuperavel !== null && !inteiroNaoNeg(d.recuperavel))) throw new Error('docker');
        return { tipo: d.tipo, bytes: d.bytes, recuperavel: d.recuperavel };
      });
    }
    const falhas = {};
    for (const [k, v] of Object.entries(o.falhas && typeof o.falhas === 'object' ? o.falhas : {})) {
      if (!['home', 'raiz', 'docker'].includes(k) || !FALHAS.has(v)) throw new Error('falhas');
      falhas[k] = v;
    }
    return {
      medida: {
        versao: 1, em: o.em, duracaoMs: inteiroNaoNeg(o.duracaoMs) ? o.duracaoMs : 0,
        home: bloco(o.home, '~'), raiz: bloco(o.raiz, '/'), docker, falhas,
      },
    };
  } catch (e) { return { motivo: e.message }; }
}

// ─── Estado do módulo ─────────────────────────────────────────────────────────────────────

let medida = null;
let carga = null;       // memo de PROMESSA, não booleano: duas chamadas simultâneas não veem `null` de passagem
let emCurso = null;     // a promessa da medição em andamento (a trava de um escritor só)
let falhou = false;     // "a última tentativa falhou inteira" — booleano: comparar segundos empataria
let falhouEm = 0;
let primeira = null;
let relogio = null;

const carregar = () => {
  carga ||= (async () => {
    const texto = await fsp.readFile(path.join(monitor.dirDe(), 'disco.json'), 'utf8').catch(() => null);
    if (texto === null) return;
    const r = validar(texto, Math.floor(Date.now() / 1000));
    if (r.medida) medida = r.medida;
    else console.error(`monitor-disco: disco.json ignorado (${r.motivo})`); // nunca o conteúdo
  })();
  return carga;
};

/** Escrita atômica (molde `lib/monitor.js` `gravar`): tmp no MESMO diretório, `0o600`, `rename`. */
async function gravar(m) {
  const dir = monitor.dirDe();
  const arq = path.join(dir, 'disco.json');
  try {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${arq}.${process.pid}.${process.hrtime.bigint()}~`;
    await fsp.writeFile(tmp, JSON.stringify(m), { mode: 0o600 });
    await fsp.rename(tmp, arq);
  } catch (e) {
    console.error(`monitor-disco: ${(e && (e.code || e.name)) || 'erro'}`);
  }
}

function medirAgora(opcoes) {
  if (emCurso) return emCurso;              // um escritor só: quem chega no meio leva a MESMA promessa
  emCurso = (async () => {
    try {
      await carregar();
      const nova = await medir(opcoes);
      if (nova.home || nova.raiz || nova.docker) { medida = nova; falhou = false; await gravar(nova); }
      // Tudo falhou: a medida anterior continua (spec §4.1). A espera conta do FIM da tentativa —
      // `nova.em` é o começo, e uma falha que leva 15 min (dois `du` no teto) sairia com a espera vencida.
      else { falhou = true; falhouEm = Math.floor(Date.now() / 1000); }
    } catch (e) {
      falhou = true; falhouEm = Math.floor(Date.now() / 1000);
      console.error(`monitor-disco: ${(e && (e.code || e.name)) || 'erro'}`);
    } finally {
      emCurso = null;
    }
    return medida;
  })();
  return emCurso;
}

/** O que a rota devolve. Com `disparar`, mede em background se a medida estiver velha (e nada em curso). */
async function estado({ disparar = false, validadeS = VALIDADE_S, esperaS = ESPERA_FALHA_S } = {}) {
  await carregar();
  const agoraS = Math.floor(Date.now() / 1000);
  const esperando = falhou && agoraS - falhouEm < esperaS;
  if (disparar && !emCurso && !esperando && estaVelha(medida, agoraS, validadeS)) medirAgora();
  return { medindo: Boolean(emCurso), medida, falhou, validadeS };
}

/** O relógio de fundo: confere de hora em hora se a medida tem mais de 6 h (S7). */
function iniciar({ checaMs = 3600000, atrasoMs = 60000 } = {}) {
  if (process.env.COCKPIT_MONITOR_MS === '0') return null;
  const checar = () => { estado({ disparar: true }).catch(() => {}); };
  primeira = setTimeout(checar, atrasoMs);
  relogio = setInterval(checar, checaMs);
  primeira.unref(); relogio.unref();
  return { parar() { clearTimeout(primeira); clearInterval(relogio); primeira = null; relogio = null; } };
}

/** Só o gate usa: devolve o módulo ao estado de recém-carregado. */
function _zerarParaTeste() {
  if (primeira) clearTimeout(primeira);
  if (relogio) clearInterval(relogio);
  primeira = null; relogio = null;
  medida = null; carga = null; emCurso = null; falhou = false; falhouEm = 0;
}

module.exports = {
  lerSaidaDu, rotuloDe, bytesDocker, lerDockerDf, estaVelha, medir, medirAgora,
  estado, iniciar, _zerarParaTeste, TETO_ARQUIVO, VALIDADE_S, ESPERA_FALHA_S,
};
