'use strict';
// O monitor do servidor — CPU, RAM e disco do servidor, com histórico de 24 h e aviso a 90 %
// (card do monitor, D64; a spec do monitor, 2026-10-06).
// Fonte: `/proc` + `statfs`, sem dependência nova e sem shell. Quatro regras de produto moram aqui:
//   S4 — RAM e disco avisam pelo valor da amostra do minuto; a CPU pela média dos últimos 5 min
//        (mínimo 3 amostras: o aviso de CPU é cego nos primeiros minutos depois do boot — declarado);
//   S5 — histerese de 5 pontos (liga em >= 90, desliga em < 85), avaliada a cada amostra, nunca
//        no pedido do cliente: um estado só, um escritor só, e ele persiste com o histórico;
//   S7 — o "comando curto" de um processo NUNCA carrega caminho nem valor (armadilha #22);
//   S8 — a CPU de um processo é o delta entre duas varreduras de `/proc`, como o `top`.
//
// `COCKPIT_MONITOR_DIR` é DUAS coisas ao mesmo tempo — configuração de onde o histórico mora, e
// o INTERRUPTOR que isola os testes — e ela VENCE um `HOME` falso: `env || homedir()` resolve a
// env var primeiro, então isolar `HOME` sozinho não protege ninguém (armadilhas #62/#78). Aqui o
// risco é maior que o das irmãs (`lib/lidas.js`): o amostrador ESCREVE em disco a cada minuto,
// desde o boot de qualquer `server.js`.
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { setTimeout: dormir } = require('node:timers/promises');

const LIGA = 90, DESLIGA = 85;            // S5 — histerese de 5 pontos
const JANELA_S = 86400;                    // 24 h, por TEMPO
const TETO_CONTAGEM = 2880;                // cinto: 24 h a 30 s; nunca a régua
const TETO_ARQUIVO = 512 * 1024;           // texto maior que isto é ignorado no carregar
const CLK_TCK = 100;                       // Node não expõe; medido `getconf CLK_TCK` = 100
const PAGINA = 4096;
const JANELA_CPU_S = 300;                  // S4 — média dos últimos 5 min, mínimo 3 amostras
const TOP = 10;                            // D68: top 10 dentro do eixo clicado; era 5 na D64

// ─── Funções PURAS ───────────────────────────────────────────────────────────────────────

/** A linha agregada `cpu ` (com espaço: `cpu0` é por núcleo) de `/proc/stat`. */
function lerStat(texto) {
  const linha = String(texto).split('\n').find((l) => l.startsWith('cpu '));
  if (!linha) return null;
  const campos = linha.trim().split(/\s+/).slice(1).map(Number);
  if (campos.length < 5 || campos.some((n) => !Number.isFinite(n))) return null;
  const total = campos.reduce((a, n) => a + n, 0);
  return { total, ocioso: campos[3] + campos[4] }; // idle + iowait
}

/** % de CPU ocupada entre duas leituras de `lerStat`; Δ zero (ou leitura ausente) = `null`. */
function cpuEntre(a, b) {
  if (!a || !b) return null;
  const dt = b.total - a.total;
  if (!(dt > 0)) return null;
  const pct = Math.round(100 * (1 - (b.ocioso - a.ocioso) / dt));
  return Math.min(100, Math.max(0, pct));
}

/** `MemTotal` e `MemAvailable` de `/proc/meminfo`, em BYTES (o arquivo fala em kB). */
function lerMeminfo(texto) {
  const total = /^MemTotal:\s+(\d+) kB/m.exec(String(texto));
  const disponivel = /^MemAvailable:\s+(\d+) kB/m.exec(String(texto));
  if (!total || !disponivel) return null;
  return { total: Number(total[1]) * 1024, disponivel: Number(disponivel[1]) * 1024 };
}

function pctRam({ total, disponivel }) {
  return Math.round(100 * (1 - disponivel / total));
}

/**
 * A conta do `df`: usado = blocks − bfree; % = usado / (usado + bavail). O `statfs` pode devolver
 * BigInt — `Number()` em cada campo. `bsize` entra na assinatura: é ele que transforma blocos em
 * bytes. O `df` arredonda para cima e a tela usa `Math.round`: pode mostrar 1 ponto a menos.
 */
function pctDisco({ blocks, bfree, bavail, bsize }) {
  const usado = Number(blocks) - Number(bfree);
  const livre = Number(bavail);
  const tam = Number(bsize);
  const pct = Math.round(100 * usado / (usado + livre));
  return { pct, total: Number(blocks) * tam, usado: usado * tam };
}

/** Média de `a[indice]` das amostras dos últimos `janelaS` segundos; menos de 3 válidas = `null`. */
function mediaRecente(amostras, agora, janelaS, indice) {
  const valores = amostras
    .filter((a) => a[0] >= agora - janelaS && a[indice] !== null && a[indice] !== undefined)
    .map((a) => a[indice]);
  if (valores.length < 3) return null;
  return valores.reduce((s, v) => s + v, 0) / valores.length;
}

/** Histerese por eixo; valor `null` (fonte falhou) mantém o estado anterior. */
function avaliarAviso(anterior, { cpuMedia, ram, disco }) {
  const eixo = (valor, antes) => (valor === null || valor === undefined
    ? antes
    : (antes ? valor >= DESLIGA : valor >= LIGA));
  return {
    cpu: eixo(cpuMedia, anterior.cpu),
    ram: eixo(ram, anterior.ram),
    disco: eixo(disco, anterior.disco),
  };
}

/**
 * O histórico em memória. A régua é o TEMPO (`janelaS`); `tetoContagem` é cinto contra arquivo
 * grande quando alguém liga o relógio a 2 s — não é a janela.
 */
function criarHistorico({ janelaS = JANELA_S, tetoContagem = TETO_CONTAGEM } = {}) {
  let lista = [];
  const h = {
    aviso: { cpu: false, ram: false, disco: false },
    adicionar(amostra, agora) {
      lista.push(amostra);
      lista = lista.filter((a) => a[0] >= agora - janelaS);
      if (lista.length > tetoContagem) lista = lista.slice(lista.length - tetoContagem);
    },
    amostras() { return lista.slice(); },
    serializar() { return JSON.stringify({ versao: 1, amostras: lista, aviso: h.aviso }); },
    carregar(texto, agora) {
      lista = [];
      h.aviso = { cpu: false, ram: false, disco: false };
      // Só o CÓDIGO do erro no log, nunca o conteúdo do arquivo.
      if (typeof texto !== 'string' || texto.length > TETO_ARQUIVO) {
        console.error('monitor: histórico ignorado (tamanho)');
        return h;
      }
      let dado;
      try { dado = JSON.parse(texto); } catch (e) {
        console.error(`monitor: histórico ignorado (${e.name})`);
        return h;
      }
      if (!dado || dado.versao !== 1) return h;
      const pctOuNulo = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 100);
      if (Array.isArray(dado.amostras)) {
        lista = dado.amostras.filter((a) => Array.isArray(a) && a.length === 4
          && Number.isInteger(a[0]) && a[0] >= agora - janelaS && a[0] <= agora + 300
          && pctOuNulo(a[1]) && pctOuNulo(a[2]) && pctOuNulo(a[3]));
        if (lista.length > tetoContagem) lista = lista.slice(lista.length - tetoContagem);
      }
      if (dado.aviso && typeof dado.aviso === 'object') {
        for (const eixo of ['cpu', 'ram', 'disco']) h.aviso[eixo] = dado.aviso[eixo] === true;
      }
      return h;
    },
  };
  return h;
}

/**
 * O comando de um processo SEM caminho e SEM valor (S7, spec §4.1): só IDENTIFICADOR entra.
 * (1) argv0 -> basename; (2) argumento que começa com `-` -> só o NOME da flag (corta no `=`);
 * (3) argumento com `/` -> só o basename; (4) qualquer outro vira `…`. Um nome com espaço
 * (flag ou basename) também vira `…`: não é identificador, é texto. `…` seguidos colapsam.
 */
function comandoCurto(cmdline) {
  const args = (Array.isArray(cmdline) ? cmdline : String(cmdline).split('\0')).filter((a) => a !== '');
  const identificador = (s) => (s && !/\s/.test(s) ? s : '…');
  const partes = args.map((arg, i) => {
    if (i === 0) return identificador(path.basename(arg));
    if (arg.startsWith('-')) return identificador(arg.split('=')[0]);
    if (arg.includes('/')) return identificador(path.basename(arg));
    return '…';
  });
  const colapsado = partes.filter((p, i) => !(p === '…' && partes[i - 1] === '…'));
  return colapsado.join(' ').slice(0, 60);
}

/** `{ nome, campos }` de um `/proc/<pid>/stat`; o corte é no ÚLTIMO `)` (molde `lib/abas.js:244`). */
function camposDoStat(texto) {
  const abre = texto.indexOf('(');
  const fecha = texto.lastIndexOf(')');
  if (abre < 0 || fecha < 0) return null;
  // índice 0 = campo 3: utime = campos[11], stime = campos[12], rss (páginas) = campos[21]
  return { nome: texto.slice(abre + 1, fecha), campos: texto.slice(fecha + 2).split(' ') };
}

// ─── Funções com DISCO (raiz injetável) ──────────────────────────────────────────────────

/** Varre `<raiz>/<pid>/{stat,cmdline}`; pid que morreu entre o `readdir` e o `readFile` é pulado. */
async function lerProcessos(raizProc) {
  const mapa = new Map();
  let pids;
  try { pids = (await fsp.readdir(raizProc)).filter((n) => /^\d+$/.test(n)); } catch { return mapa; }
  await Promise.all(pids.map(async (pid) => {
    try {
      const st = camposDoStat(await fsp.readFile(path.join(raizProc, pid, 'stat'), 'utf8'));
      if (!st) return;
      const cmdline = await fsp.readFile(path.join(raizProc, pid, 'cmdline'), 'utf8').catch(() => '');
      const ticks = Number(st.campos[11]) + Number(st.campos[12]);
      const rss = Number(st.campos[21]);
      if (!Number.isFinite(ticks) || !Number.isFinite(rss)) return;
      mapa.set(Number(pid), { nome: st.nome, comando: comandoCurto(cmdline), ticks, rss });
    } catch { /* o processo morreu no meio — não é erro */ }
  }));
  return mapa;
}

/**
 * Top 10 de CPU (delta de ticks entre duas varreduras) e de RAM. Sem varredura anterior, ou com
 * uma de mais de 5 min, a função faz UMA segunda varredura depois de 1 s (S8) — é o preço da
 * primeira abertura do painel.
 */
async function processosDe(raizProc, varreduraAnterior, agoraMs, prefixo = '') {
  let anterior = varreduraAnterior;
  let atual;
  if (anterior && agoraMs - anterior.em > 0 && agoraMs - anterior.em <= 300000) {
    atual = { em: agoraMs, mapa: await lerProcessos(raizProc) };
  } else {
    anterior = { em: Date.now(), mapa: await lerProcessos(raizProc) };
    await dormir(1000);
    atual = { em: Date.now(), mapa: await lerProcessos(raizProc) };
  }
  const seg = Math.max((atual.em - anterior.em) / 1000, 0.001);
  const cpu = [];
  for (const [pid, p] of atual.mapa) {
    const antes = anterior.mapa.get(pid);
    if (!antes) continue;
    const pct = Math.round(100 * Math.max(0, p.ticks - antes.ticks) / CLK_TCK / seg);
    cpu.push({ pid, nome: p.nome, comando: p.comando, cpu: pct, _rss: p.rss });
  }
  cpu.sort((a, b) => b.cpu - a.cpu || b._rss - a._rss);
  const ram = [...atual.mapa].map(([pid, p]) => ({ pid, nome: p.nome, comando: p.comando, rss: p.rss * PAGINA }))
    .sort((a, b) => b.rss - a.rss);
  const topCpu = cpu.slice(0, TOP).map(({ _rss, ...resto }) => resto);
  const topRam = ram.slice(0, TOP);
  // S5 da spec D68: o cwd diz se é job, e só o BOOLEANO sai (#22). `readlink` só nos ≤ 20
  // escolhidos, nunca nos ~400 pids; processo de outro usuário dá EACCES → false.
  const marcas = new Map();
  await Promise.all([...new Set([...topCpu, ...topRam].map((p) => p.pid))].map(async (pid) => {
    let job = false;
    if (prefixo) {
      try { job = (await fsp.readlink(path.join(raizProc, String(pid), 'cwd'))).startsWith(prefixo); } catch { /* EACCES/ENOENT */ }
    }
    marcas.set(pid, job);
  }));
  return {
    cpu: topCpu.map((p) => ({ ...p, job: marcas.get(p.pid) })),
    ram: topRam.map((p) => ({ ...p, job: marcas.get(p.pid) })),
    varredura: atual,
  };
}

// ─── Estado do módulo, amostrador e leituras "agora" ──────────────────────────────────────

// Resolvidas a CADA chamada (como `procRaiz` em `lib/abas.js:237`): o gate troca de pasta entre
// os casos, e constante de módulo seria capturada na primeira carga.
const dirDe = () => process.env.COCKPIT_MONITOR_DIR || path.join(os.homedir(), '.cockpit', 'monitor');
const raizProc = () => process.env.COCKPIT_PROC_RAIZ || '/proc';
// Pasta das worktrees de job (molde `lib/uso.js:125`): o processo cujo cwd mora nela é job.
const prefixoWorktrees = () => `${process.env.COCKPIT_WORKTREES_DIR || path.join(os.homedir(), '.cockpit', 'worktrees')}${path.sep}`;
const discoAlvo = () => process.env.COCKPIT_MONITOR_DISCO || '/';

const historico = criarHistorico();
// DUAS referências de `/proc/stat`, nunca uma (spec §4.1): a do amostrador mede o minuto inteiro
// e é a que vai para o histórico e para a média do aviso; a da rota serve só o cliente. Com uma
// só, abrir o navegador encurtaria o intervalo medido pelo amostrador e o número gravado mudaria
// de significado conforme houvesse alguém olhando.
let refAmostrador = null;
let refRota = null;
let cacheAgora = null;          // { em, dados } — 5 s, só para a rota
let varreduraAnterior = null;
let cacheProcessos = null;      // { em, dados } — 5 s
let relogio = null;
let ocupado = false;
let pronto = Promise.resolve();

const lerArq = (arq) => fsp.readFile(path.join(raizProc(), arq), 'utf8').catch(() => null);

/** As três fontes, cada uma em seu `try`: uma que falha vira `null`, nunca derruba as outras. */
async function lerBruto() {
  const [stat, mem] = await Promise.all([lerArq('stat'), lerArq('meminfo')]);
  let disco = null;
  try { disco = await fsp.statfs(discoAlvo()); } catch { /* sem disco — o campo sai null */ }
  return { stat: stat === null ? null : lerStat(stat), mem: mem === null ? null : lerMeminfo(mem), disco };
}

/** Uma amostra completa. `ref` é a referência de CPU de QUEM mede (amostrador ou rota). */
async function medir(ref) {
  const { stat, mem, disco } = await lerBruto();
  const agoraMs = Date.now();
  const cpu = ref.valor && stat && agoraMs - ref.em >= 1000 ? cpuEntre(ref.valor, stat) : null;
  if (stat) { ref.valor = stat; ref.em = agoraMs; }
  const d = disco ? pctDisco(disco) : null;
  return {
    t: Math.floor(agoraMs / 1000),
    cpu,
    ram: mem ? pctRam(mem) : null,
    disco: d ? d.pct : null,
    nucleos: os.cpus().length,
    ramTotal: mem ? mem.total : null,
    ramUsado: mem ? mem.total - mem.disponivel : null, // a sub-linha do medidor de RAM precisa dele
    discoTotal: d ? d.total : null,
    discoUsado: d ? d.usado : null,
  };
}

/** O "agora" da rota: cache de 5 s para o cliente não custar uma leitura por pedido. */
async function agora() {
  if (cacheAgora && Date.now() - cacheAgora.em < 5000) return cacheAgora.dados;
  if (!refRota) refRota = { valor: null, em: 0 };
  const dados = await medir(refRota);
  cacheAgora = { em: Date.now(), dados };
  return dados;
}

/**
 * Carrega o histórico do disco e semeia as duas referências com UMA leitura de `/proc/stat`.
 * Roda SEMPRE, antes do `listen` (a promessa `pronto` fecha a janela "socket aceito, estado
 * ainda não existe"). Nunca rejeita: o boot do servidor não pode morrer por causa do monitor.
 */
function preparar() {
  pronto = (async () => {
    try {
      const texto = await fsp.readFile(path.join(dirDe(), 'historico.json'), 'utf8').catch(() => null);
      if (texto !== null) historico.carregar(texto, Math.floor(Date.now() / 1000));
      const stat = await lerArq('stat');
      const lido = stat === null ? null : lerStat(stat);
      refAmostrador = { valor: lido, em: Date.now() };
      refRota = { valor: lido, em: Date.now() };
    } catch (e) {
      console.error(`monitor: ${(e && (e.code || e.name)) || 'erro'}`);
    }
  })();
  return pronto;
}

/** Escrita atômica (molde `lib/lidas.js:73-83`): tmp no MESMO diretório, `0o600`, `rename`. */
async function gravar() {
  const dir = dirDe();
  const arq = path.join(dir, 'historico.json');
  try {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${arq}.${process.pid}.${process.hrtime.bigint()}~`;
    await fsp.writeFile(tmp, historico.serializar(), { mode: 0o600 });
    await fsp.rename(tmp, arq);
  } catch (e) {
    console.error(`monitor: não gravou o histórico (${(e && e.code) || 'erro'})`);
  }
}

/** Uma batida do relógio: mede, guarda, reavalia o aviso (um escritor só) e persiste. */
async function batida() {
  if (ocupado) return;
  ocupado = true;
  try {
    if (!refAmostrador) refAmostrador = { valor: null, em: 0 };
    const a = await medir(refAmostrador);
    historico.adicionar([a.t, a.cpu, a.ram, a.disco], a.t);
    historico.aviso = avaliarAviso(historico.aviso, {
      cpuMedia: mediaRecente(historico.amostras(), a.t, JANELA_CPU_S, 1), ram: a.ram, disco: a.disco,
    });
    await gravar();
  } catch (e) {
    console.error(`monitor: batida falhou (${(e && (e.code || e.name)) || 'erro'})`);
  } finally {
    ocupado = false;
  }
}

/**
 * Liga o relógio. Mesma forma do vigia (`lib/vigia-abas.js:145-182`): `''` → 60 s; `'0'` →
 * desligado e CALADO (é o interruptor dos testes); fora de [1 s, 1 h] → desligado com uma linha
 * de erro. Com o relógio desligado as rotas continuam vivas — medem ao vivo, e o histórico é o
 * do arquivo carregado.
 */
function iniciar({ intervaloMs = Number((process.env.COCKPIT_MONITOR_MS || '').trim() || 60000) } = {}) {
  if (process.env.COCKPIT_MONITOR_MS === '0') return null;
  if (!Number.isFinite(intervaloMs) || intervaloMs < 1000 || intervaloMs > 3600000) {
    console.error(`monitor desligado: COCKPIT_MONITOR_MS fora da faixa (${process.env.COCKPIT_MONITOR_MS})`);
    return null;
  }
  pronto.then(batida);
  relogio = setInterval(batida, intervaloMs);
  relogio.unref();
  return { parar() { clearInterval(relogio); relogio = null; } };
}

const estado = () => ({ relogio: Boolean(relogio) });
const historicoAtual = () => ({ amostras: historico.amostras(), aviso: { ...historico.aviso } });
const limites = () => ({ liga: LIGA, desliga: DESLIGA });

/** Top 10 de RAM e de CPU; cache de 5 s para o painel aberto não varrer `/proc` a cada pedido. */
async function processos() {
  if (cacheProcessos && Date.now() - cacheProcessos.em < 5000) return cacheProcessos.dados;
  const r = await processosDe(raizProc(), varreduraAnterior, Date.now(), prefixoWorktrees());
  varreduraAnterior = r.varredura;
  const dados = { cpu: r.cpu, ram: r.ram, nucleos: os.cpus().length };
  cacheProcessos = { em: Date.now(), dados };
  return dados;
}

/** Só o gate usa: devolve o módulo ao estado de recém-carregado. */
function _zerarParaTeste() {
  if (relogio) clearInterval(relogio);
  relogio = null; ocupado = false;
  refAmostrador = null; refRota = null;
  cacheAgora = null; cacheProcessos = null; varreduraAnterior = null;
  historico.carregar('{"versao":1,"amostras":[],"aviso":{}}', 0);
  pronto = Promise.resolve();
}

module.exports = {
  lerStat, cpuEntre, lerMeminfo, pctRam, pctDisco, mediaRecente, avaliarAviso,
  criarHistorico, comandoCurto, camposDoStat, lerProcessos, processosDe,
  agora, preparar, iniciar, estado, dirDe, historicoAtual, processos, limites,
  get pronto() { return pronto; }, _zerarParaTeste,
  TETO_ARQUIVO,
};
