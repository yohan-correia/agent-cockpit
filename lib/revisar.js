'use strict';

/**
 * A regra de "Pra revisar" (plano docs/superpowers/plans/2026-10-04-tela-pra-revisar-plano.md;
 * v2: docs/superpowers/specs/2026-10-06-pra-revisar-v2-design.md), 1:1 com o oráculo v2
 * `esteira-jobs/bin/pra-revisar` (branch `feature/pra-revisar-v2`). Mudou uma, muda a outra.
 *
 * O que entra: jobs terminados (`done`/`needs-review`) cuja branch ainda tem algo que não está
 * na base do repo (`develop`, ou `main` se não há `develop`). O que NÃO faz, de propósito: ler `result.md` (isso é do chamador, que
 * sabe o caminho de disco) e cruzar com pid/tmux (`j.state` de `lib/jobs.js`) — a Suposição do
 * plano é clara: o estado desta regra vem do LOG, com o `kind` aceitando hífen, nunca do estado
 * cruzado com processo. Um `needs-review` cujo `meta.json` ainda diz `running` (o revisor
 * escreveu e saiu antes do orquestrador atualizar o meta) não pode virar `orfao` aqui.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ESTADOS_QUE_ENTRAM = new Set(['done', 'needs-review']);
const RE_BRANCH_VALIDA = /^[\w./-]+$/;
// Mesmo parser hífen-tolerante do oráculo, aplicado sobre o `event.text` CRU quando o regex
// de `lib/jobs.js:93` (que não aceita `-` no kind) não bateu.
const RE_ESTADO_NO_TEXTO = /^(\S+)\s+([\w-]+):/;

function parseEstadoDoTexto(texto) {
  const m = String(texto || '').match(RE_ESTADO_NO_TEXTO);
  return m ? { at: m[1], kind: m[2] } : null;
}

/**
 * O estado e o carimbo de fim DESTA regra — nunca `j.state` (que cruza com pid/tmux).
 * Passo 1 da tabela.
 */
function estadoERaw(j) {
  const evento = j.event;
  if (evento && evento.kind) return { estado: evento.kind, at: evento.at };
  const bruto = evento && evento.text ? parseEstadoDoTexto(evento.text) : null;
  if (bruto) return { estado: bruto.kind, at: bruto.at };
  return { estado: j.declared || null, at: null };
}

/** `fim` da resposta HTTP (contrato): `event.at`, ou o primeiro token de `event.text`. */
function fimDoJob(j) {
  const evento = j.event;
  if (!evento) return null;
  if (evento.at) return evento.at;
  if (evento.text) {
    const token = String(evento.text).trim().split(/\s+/)[0];
    return token || null;
  }
  return null;
}

/** `git -C <repo> <args…>`, sem shell, com timeout de 4s. Nunca lança — devolve o código. `env` (opcional) soma ao ambiente. */
function runGit(repo, args, env) {
  return new Promise((resolve) => {
    const opcoes = { timeout: 4000 };
    if (env) opcoes.env = { ...process.env, ...env };
    execFile('git', ['-C', repo, ...args], opcoes, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout || '') });
      const code = typeof error.code === 'number' ? error.code : null;
      resolve({ code, stdout: String(stdout || ''), erro: true, mensagem: error.message });
    });
  });
}

function logErroGit(repo, acao, r) {
  // eslint-disable-next-line no-console
  console.error(`[lib/revisar] git ${acao} falhou em ${repo}: ${r.mensagem || `rc=${r.code}`}`);
}

/** Um `for-each-ref` por repo: os shas de TODAS as heads + `origin/develop`/`origin/main`, numa chamada só. */
async function shasDoRepo(repo) {
  const r = await runGit(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes/origin/develop', 'refs/remotes/origin/main']);
  if (r.code !== 0) {
    logErroGit(repo, 'for-each-ref', r);
    return { ok: false, mapa: new Map() };
  }
  const mapa = new Map();
  for (const linha of r.stdout.split('\n')) {
    const [ref, sha] = linha.trim().split(/\s+/);
    if (ref && sha) mapa.set(ref, sha);
  }
  return { ok: true, mapa };
}

// O veredito dos passos 7-10 (ancestralidade/diff/cherry), por `repo|shaBranch|shaBase|shaOrigin||base`.
// Os passos 1-6 NUNCA consultam este cache — correm em toda chamada (leitura de fs/ref, barata).
const cacheVeredito = new Map();
const TETO_CACHE = 2000;

async function calcularVereditoGit(repo, branch, base, temOrigin) {
  const refBranch = `refs/heads/${branch}`;
  const refBase = `refs/heads/${base}`;

  // Passo 7.
  let r = await runGit(repo, ['merge-base', '--is-ancestor', refBranch, refBase]);
  if (r.code === 0) return { sai: true };
  if (r.code !== 1) { logErroGit(repo, `merge-base --is-ancestor (${base})`, r); return { sai: false, motivo: 'nao-sei' }; }

  // Passo 8 — só se o ref remoto existir.
  if (temOrigin) {
    r = await runGit(repo, ['merge-base', '--is-ancestor', refBranch, `refs/remotes/origin/${base}`]);
    if (r.code === 0) return { sai: true };
    if (r.code !== 1) { logErroGit(repo, `merge-base --is-ancestor (origin/${base})`, r); return { sai: false, motivo: 'nao-sei' }; }
  }

  // Passo 9.
  r = await runGit(repo, ['diff', '--name-only', `${refBase}...${refBranch}`]);
  if (r.code !== 0) { logErroGit(repo, 'diff --name-only', r); return { sai: false, motivo: 'nao-sei' }; }
  if (!r.stdout.trim()) return { sai: true };

  // Passo 10.
  r = await runGit(repo, ['cherry', refBase, refBranch]);
  if (r.code !== 0) { logErroGit(repo, 'cherry', r); return { sai: false, motivo: 'nao-sei' }; }
  if (!/^\+/m.test(r.stdout)) return { sai: true }; // squash/rebase: já entrou com outro sha.

  // Passo 11 — o resto.
  return { sai: false, motivo: null };
}

async function vereditoGit(repo, branch, base, shaBranch, shaBase, shaOrigin) {
  const chave = `${repo}|${shaBranch}|${shaBase}|${shaOrigin || ''}||${base}`;
  if (cacheVeredito.has(chave)) return cacheVeredito.get(chave);
  const veredito = await calcularVereditoGit(repo, branch, base, Boolean(shaOrigin));
  // Teto: o servidor é 24/7 e todo commit novo gera chave nova. Passou do teto, recomeça —
  // o pior caso é recalcular uma vez, nunca crescer pra sempre.
  if (cacheVeredito.size >= TETO_CACHE) cacheVeredito.clear();
  cacheVeredito.set(chave, veredito);
  return veredito;
}

/** A branch em que a worktree está (`git -C <worktree> symbolic-ref`); null se detached/erro. */
async function symbolicRef(worktree) {
  const r = await runGit(worktree, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** `merge-base --is-ancestor a b`: rc 0 = sim; qualquer outra coisa = não. */
async function isAncestor(repo, a, b) {
  const r = await runGit(repo, ['merge-base', '--is-ancestor', a, b]);
  return r.code === 0;
}

/** Os refs `refs/heads/*` que contêm `ref`. Erro de git → Set vazio (quem pergunta fica na lista). */
async function forEachRefContains(repo, ref) {
  const r = await runGit(repo, ['for-each-ref', '--format=%(refname)', '--contains', ref, 'refs/heads/']);
  if (r.code !== 0) { logErroGit(repo, 'for-each-ref --contains', r); return new Set(); }
  return new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

// ── Prévia do merge (card pra-revisar-aviso-de-conflito-no-merge) ──────────────────────────
// SÓ LEITURA. Não é parte da regra de filtro (o oráculo não sabe disto): o servidor chama depois
// de filtrar. `git merge-tree --write-tree` grava objetos soltos; com GIT_OBJECT_DIRECTORY num tmp
// e o object dir do repo como alternate, nada novo entra no repo (medido: spec, Medições). O git
// ainda REFRESCA o mtime de objeto que já existe e coincide com o resultado — aceito (spec R1).
const RE_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ROADMAP_DO_BOARD = 'roadmap-board/data/roadmap.json';
const TETO_ARQUIVOS = 50;
const TTL_NAO_SEI = 60000;
const NAO_SEI = () => ({ estado: 'nao-sei', arquivos: [] });

/**
 * A saída de `merge-tree --name-only --no-messages -z`. rc=1 é conflito OU erro (ref inválida dá rc=1
 * com stdout vazio): conflito exige OID + pelo menos um arquivo. O resto é "não sei", nunca "limpo".
 */
function classificarMergeTree(code, stdout) {
  const partes = String(stdout || '').split('\0').filter(Boolean);
  const oid = partes[0] || '';
  const arquivos = [...new Set(partes.slice(1))];
  if (!RE_OID.test(oid)) return NAO_SEI();
  if (code === 0 && arquivos.length === 0) return { estado: 'limpo', arquivos: [] };
  if (code === 1 && arquivos.length > 0) {
    return { estado: arquivos.every((a) => a === ROADMAP_DO_BOARD) ? 'so-roadmap' : 'conflito', arquivos };
  }
  return NAO_SEI();
}

const objetosPorRepo = new Map(); // repo → caminho absoluto do object dir (só sucesso entra)
async function pastaDeObjetos(repo) {
  if (objetosPorRepo.has(repo)) return objetosPorRepo.get(repo);
  const r = await runGit(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const pasta = r.code === 0 ? r.stdout.trim() : '';
  if (!pasta) { logErroGit(repo, 'rev-parse --git-path objects', r); return null; }
  objetosPorRepo.set(repo, pasta);
  return pasta;
}

async function calcularPreviaDoMerge(repo, base, branch) {
  // O merge-tree EXECUTA merge driver customizado (medido): repo com driver não é lido.
  const drivers = await runGit(repo, ['config', '--get-regexp', '^merge\\..+\\.driver$']);
  if (drivers.code === 0) {
    // eslint-disable-next-line no-console
    console.error(`[lib/revisar] merge-tree recusado em ${repo}: há merge driver configurado`);
    return NAO_SEI();
  }
  if (drivers.code !== 1) { logErroGit(repo, 'config --get-regexp', drivers); return NAO_SEI(); }
  const objetos = await pastaDeObjetos(repo);
  if (!objetos) return NAO_SEI();
  let tmp;
  try { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cockpit-merge-tree-')); } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[lib/revisar] mkdtemp falhou: ${e.message}`);
    return NAO_SEI();
  }
  try {
    const r = await runGit(repo, ['-c', 'merge.renormalize=false', 'merge-tree', '--write-tree', '--name-only',
      '--no-messages', '-z', `refs/heads/${base}`, `refs/heads/${branch}`],
    { GIT_OBJECT_DIRECTORY: tmp, GIT_ALTERNATE_OBJECT_DIRECTORIES: objetos });
    const v = classificarMergeTree(r.code, r.stdout);
    if (v.estado === 'nao-sei') logErroGit(repo, `merge-tree ${base}…${branch}`, r);
    return v;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Por `repo|base|shaBase|branch|shaBranch`. "Não sei" fica só TTL_NAO_SEI (timeout passageiro não
// gruda, repo ruim não custa 4 s a cada abertura); o resto até um dos shas andar.
const cacheMerge = new Map();

/** `{ estado, n, arquivos (≤ 50) }`, ou `null` sem base/sha (branch sumida, sem base). Nunca lança. */
async function previaDoMerge({ repo, base, shaBase, branch, shaBranch }) {
  if (!repo || !base || !shaBase || !branch || !shaBranch) return null;
  const chave = `${repo}|${base}|${shaBase}|${branch}|${shaBranch}`;
  const guardado = cacheMerge.get(chave);
  if (guardado && (guardado.ate === null || guardado.ate > Date.now())) return guardado.valor;
  const v = await calcularPreviaDoMerge(repo, base, branch);
  const valor = { estado: v.estado, n: v.arquivos.length, arquivos: v.arquivos.slice(0, TETO_ARQUIVOS) };
  // Mesmo teto do vereditoGit: passou, recomeça — nunca cresce pra sempre.
  if (cacheMerge.size >= TETO_CACHE) cacheMerge.clear();
  cacheMerge.set(chave, { valor, ate: v.estado === 'nao-sei' ? Date.now() + TTL_NAO_SEI : null });
  return valor;
}

/** `created_at` COMO STRING (ISO no mesmo formato do disco), vazio perde, desempate `id` desc. */
function compararNovidade(a, b) {
  const ca = String(a.job.created_at || '');
  const cb = String(b.job.created_at || '');
  if (ca !== cb) return ca < cb ? 1 : -1;
  const ia = String(a.job.id || '');
  const ib = String(b.job.id || '');
  if (ia === ib) return 0;
  return ia < ib ? 1 : -1;
}
const maisNovo = (x, y) => compararNovidade(x, y) < 0;

function realpathOuString(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** O molde ÚNICO de item: todo push em principal/atencao usa este objeto (o servidor lê `retomou`/`inclui`). */
function novoItem(j, estado, at) {
  return {
    job: j, estado, at, real: null, motivo: null, retomou: [], inclui: [],
    branchEfetiva: j.branch, shaBranch: null, retomadaDe: null, retomadoPor: null, contidaEm: null,
    base: null, shaBase: null,
  };
}

/**
 * A lista de jobs que entram em "Pra revisar" v2: `{ principal, atencao }`, cada item com
 * `estado` (desta regra), `motivo` (`null`, `'sem-base'`, `'nao-sei'`; `'branch-sumiu'` só em
 * `atencao`), `retomou[]` e `inclui[]`. Recebe os objetos CRUS de `jobs.listar()` (com
 * `worktree`/`branch`/`source_repo`) — quem filtra para a resposta HTTP é o chamador, nunca
 * este módulo, que não sabe (nem precisa saber) o que vai para o navegador.
 */
async function filtrarPraRevisar(jobs) {
  let principal = [];
  const atencao = [];
  const cand = [];
  const shasPorRepo = new Map(); // repo → Promise<{ok, mapa}>, um `for-each-ref` por repo distinto.
  const shasPorRepoDe = (repo) => {
    if (!shasPorRepo.has(repo)) shasPorRepo.set(repo, shasDoRepo(repo));
    return shasPorRepo.get(repo);
  };

  // Passagem 1 — por job; o primeiro passo que decide encerra.
  for (const j of jobs) {
    const { estado, at } = estadoERaw(j);
    const it = novoItem(j, estado, at);

    // Passo 1.
    if (!ESTADOS_QUE_ENTRAM.has(estado)) continue;

    // Passo 2.
    if (j.worktree && !fs.existsSync(j.worktree)) continue;

    // Passo 2b — job sem worktree E sem branch (os `scout`, só-leitura): não há código pra
    // mergear, então sai (desvio decidido na execução do Gate C, plano 2026-10-04).
    if (!j.worktree && !j.branch) continue;

    // Passo 3.
    if (!j.source_repo || !j.branch || !j.worktree) {
      it.motivo = 'nao-sei';
      principal.push(it);
      continue;
    }

    // Passo 4 — forma da branch, SEM chamar o git com ela.
    if (!RE_BRANCH_VALIDA.test(j.branch) || j.branch.startsWith('-')) {
      it.motivo = 'nao-sei';
      principal.push(it);
      continue;
    }

    // Candidato: passou em 1-4 com worktree preenchida e existente.
    it.real = realpathOuString(j.worktree);
    cand.push(it);
  }

  // Passagem 2 — agrupar por worktree compartilhada (mesmo repo + mesmo diretório real).
  // O mais novo do grupo é a retomada; os outros, originais. Ninguém sai ainda (quem decide é o 5r).
  const grupos = new Map();
  for (const c of cand) {
    const chave = `${c.job.source_repo}|${c.real}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(c);
  }
  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;
    grupo.sort(compararNovidade);
    grupo[0].retomadaDe = grupo.slice(1);
    for (const original of grupo.slice(1)) original.retomadoPor = grupo[0];
  }

  // Passagem 3 — git, por candidato. As retomadas primeiro: o original já acha a branch efetiva resolvida.
  const ordem = cand.filter((c) => c.retomadaDe).concat(cand.filter((c) => !c.retomadaDe));
  for (const c of ordem) {
    const repo = c.job.source_repo;
    const { ok, mapa } = await shasPorRepoDe(repo);
    // Erro de git NUNCA vira "branch sumiu".
    if (!ok) { c.motivo = 'nao-sei'; principal.push(c); continue; }

    // Passo 5.
    c.shaBranch = mapa.get(`refs/heads/${c.branchEfetiva}`) || null;
    if (!c.shaBranch) {
      // Membro de um grupo de worktree compartilhada (retomada OU original): a branch do meta pode nunca
      // ter existido — numa retomada da retomada, a intermediária também. A verdade é a worktree (#87).
      if (c.retomadaDe || c.retomadoPor) {
        const br = await symbolicRef(c.job.worktree);
        if (!br || !RE_BRANCH_VALIDA.test(br) || br.startsWith('-')) { c.motivo = 'nao-sei'; principal.push(c); continue; }
        c.branchEfetiva = br;
        c.shaBranch = mapa.get(`refs/heads/${br}`) || null;
        if (!c.shaBranch) { c.motivo = 'nao-sei'; principal.push(c); continue; }
      } else {
        c.motivo = 'branch-sumiu';
        atencao.push(c);
        continue;
      }
    }

    // Passo 5r — o original só sai se o trabalho dele está dentro da retomada.
    if (c.retomadoPor) {
      const r = c.retomadoPor;
      if (r.shaBranch && r.branchEfetiva !== c.branchEfetiva
        && await isAncestor(repo, `refs/heads/${c.branchEfetiva}`, `refs/heads/${r.branchEfetiva}`)) {
        r.retomou.push(c);
        continue;
      }
      if (r.shaBranch && r.branchEfetiva === c.branchEfetiva) { r.retomou.push(c); continue; }
      // senão segue como job normal — na dúvida, mostra.
    }

    // Passo 6 — a base: `develop`, senão `main`, senão nada.
    const base = mapa.has('refs/heads/develop') ? 'develop' : (mapa.has('refs/heads/main') ? 'main' : null);
    if (!base) { c.motivo = 'sem-base'; principal.push(c); continue; }
    c.base = base;
    c.shaBase = mapa.get(`refs/heads/${base}`) || null;

    const veredito = await vereditoGit(
      repo, c.branchEfetiva, base, c.shaBranch,
      mapa.get(`refs/heads/${base}`), mapa.get(`refs/remotes/origin/${base}`),
    );
    if (veredito.sai) continue;
    c.motivo = veredito.motivo || null;
    principal.push(c);
  }

  // Passagem 4 — contida: quem está dentro de outra branch da lista (mesmo repo) sai e vira detalhe dela.
  const comSha = principal.filter((x) => x.shaBranch);
  for (const a of comSha) {
    const contem = await forEachRefContains(a.job.source_repo, `refs/heads/${a.branchEfetiva}`);
    const cima = comSha.filter((b) => b !== a
      && b.job.source_repo === a.job.source_repo
      // Mesmo ref não é "contida": é o mesmo trabalho.
      && b.branchEfetiva !== a.branchEfetiva
      && contem.has(`refs/heads/${b.branchEfetiva}`)
      && (a.shaBranch !== b.shaBranch || maisNovo(b, a)));
    a.contidaEm = cima.length ? cima : null;
  }
  const deCima = principal.filter((x) => !x.contidaEm); // calculado UMA vez
  const voltam = [];
  for (const a of principal) {
    if (!a.contidaEm) continue;
    const cimas = a.contidaEm.filter((b) => deCima.includes(b));
    if (cimas.length === 0) { voltam.push(a); continue; } // fail-closed: nenhuma de cima sobrou
    for (const b of cimas) b.inclui.push(a);
  }
  principal = deCima.concat(voltam);

  return { principal, atencao };
}

/**
 * Corta `buf` em até `teto` bytes, recuando até uma fronteira UTF-8 válida — nunca decodifica
 * com um caractere de substituição (`�`) no meio de uma sequência truncada.
 */
function cortarUtf8Seguro(buf) {
  if (buf.length === 0) return buf;
  let i = buf.length - 1;
  let recuo = 0;
  // Pula até 3 bytes de CONTINUAÇÃO (10xxxxxx) a partir do fim, procurando o byte-líder.
  while (i >= 0 && recuo < 3 && (buf[i] & 0xc0) === 0x80) { i -= 1; recuo += 1; }
  if (i < 0) return buf; // só continuação — algo muito estranho; não corta às cegas.
  const lead = buf[i];
  let esperado = 1;
  if ((lead & 0xe0) === 0xc0) esperado = 2;
  else if ((lead & 0xf0) === 0xe0) esperado = 3;
  else if ((lead & 0xf8) === 0xf0) esperado = 4;
  const presente = buf.length - i;
  return presente < esperado ? buf.slice(0, i) : buf;
}

module.exports = {
  filtrarPraRevisar, fimDoJob, cortarUtf8Seguro, previaDoMerge,
  // Exportados para o gate exercitar cada peça sem fabricar repo git por caso.
  estadoERaw, parseEstadoDoTexto, maisNovo, classificarMergeTree,
};
