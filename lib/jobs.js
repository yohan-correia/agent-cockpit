'use strict';

/**
 * Os jobs do orquestrador, lidos DO DISCO.
 *
 * Até 2026-09-10 quem sabia o estado de um job era o `painel-externo` (um serviço à parte, na
 * 7878), e `server.js` só fazia um `http.get` nele. Isso deixava um recurso do cockpit
 * dependendo de um programa que não está neste repositório: quem clona não tem o painel, a
 * variável `COCKPIT_PAINEL_JOBS` fica vazia e o grupo de jobs nunca aparece. Este módulo é o
 * porte daquela leitura para cá — mesma pasta, mesmas regras, uma verdade só.
 *
 * O que ele NÃO faz, de propósito: escrever. Nada aqui cria, move ou apaga job — a máquina
 * de estados do orquestrador continua sendo dele. Este arquivo lê `meta.json`, `status.log` e
 * o `mtime` do `claude.log`, e mais nada.
 *
 * A pasta vem de `limite.dirJobs()` (`COCKPIT_JOBS_DIR`, com `~/.cockpit/jobs` de padrão) —
 * um dono só para o caminho, lido a cada chamada, para o gate poder trocar de cenário no
 * mesmo processo.
 */

const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { dirJobs } = require('./limite');

// Quanto da cauda do `claude.log` a etapa lê. O NDJSON de um `/ataca` passa dos megabytes, e
// ler o arquivo inteiro a cada varredura derrubaria a rota — que é consultada a cada 15 s
// pela faixa do celular.
const CAUDA_LOG = 64 * 1024;

// Teto de pastas por varredura. Não é paranoia: são 179 no disco hoje, e a pasta só cresce —
// nada aqui apaga job. O corte é pelo NOME em ordem decrescente, que para os ids do
// orquestrador (`AAAAMMDD-HHMMSS-…`) é ordem cronológica invertida: o teto sempre corta os
// mais VELHOS, nunca o job que acabou de nascer.
const TETO_PASTAS = 400;

// Os sete estados que este módulo emite. Quem lê a lista trata o que não estiver aqui como
// desconhecido — e desconhecido é protegido, nunca escondido (§4.2 da spec).
const ESTADOS = new Set(['running', 'done', 'teardown', 'failed', 'merged', 'blocked', 'orfao']);

// Os três que ficam pendurados para sempre se ninguém os arquivar. `blocked` é o pior: nasce
// de "teardown recusado: job não merged", que NUNCA muda sozinho. `done`/`merged`/`teardown`
// ficam de fora de propósito — são o fim feliz, e ninguém os lê como pendência.
const ESTADOS_QUE_ARQUIVAM = new Set(['blocked', 'failed', 'orfao']);

/**
 * Depois de quantas horas um job parado sai da vista. FUNÇÃO e não constante de topo pelo
 * mesmo motivo de `dirJobs()`: constante congela o valor no `require` e o gate não consegue
 * exercitar duas janelas no mesmo processo.
 *
 * Arquivar não é teardown: a worktree e a branch continuam de pé e o orquestrador continua
 * mostrando tudo. É só a vista.
 */
function horasArquiva() {
  const bruto = Number(process.env.COCKPIT_HORAS_ARQUIVA);
  return Number.isFinite(bruto) && bruto > 0 ? bruto : 24;
}

// ─── Estado real ────────────────────────────────────────────────────────────

/**
 * As sessões tmux vivas, numa chamada só — 179 jobs × `tmux has-session` seria lento à toa.
 *
 * 🔴 `if (err && !stdout) return Set()` não é tolerância preguiçosa: `tmux ls` sai com erro
 * quando não há servidor rodando, e isso é "nenhuma sessão", não uma falha. É também o que
 * faz a bateria passar num CI que não tem `tmux` instalado — sem esta linha, um clone limpo
 * veria a lista de jobs inteira virar erro.
 */
function sessoesTmux() {
  // Mesmo idioma de `lib/abas.js:67`: socket vazio é o socket PADRÃO, onde as sessões de
  // verdade vivem; preenchido, é o socket de teste do gate.
  const socket = process.env.COCKPIT_TMUX_SOCKET || '';
  const args = socket ? ['-L', socket, 'ls', '-F', '#{session_name}'] : ['ls', '-F', '#{session_name}'];
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: 4000 }, (err, stdout) => {
      if (err && !stdout) return resolve(new Set());
      resolve(new Set(String(stdout).split('\n').map((s) => s.trim()).filter(Boolean)));
    });
  });
}

/** `kill(pid, 0)` não mata: pergunta se o processo existe. `EPERM` é "existe, e não é meu". */
function pidVivo(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** A última linha do `status.log`, que é append-only — logo, o evento mais recente. */
function ultimoEvento(texto) {
  const linhas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) return null;
  const cru = linhas[linhas.length - 1];
  const m = cru.match(/^(\S+)\s+(\w+):\s*(.*)$/);
  // Linha que não bate o formato vira `kind: null` com o texto CRU — e quem consome trata
  // `kind` por allowlist, nunca por denylist: um `kind` inventado amanhã não pode passar
  // carregando texto de disco para a tela.
  return m ? { at: m[1], kind: m[2], text: m[3] } : { at: null, kind: null, text: cru };
}

// ─── A etapa (só de quem está rodando) ──────────────────────────────────────

const nomeDoArquivo = (c) => String(c || '').split('/').filter(Boolean).pop() || '?';
const curto = (t, n = 42) => {
  const limpo = String(t || '').replace(/\s+/g, ' ').trim();
  return limpo.length > n ? `${limpo.slice(0, n - 1)}…` : limpo;
};

/** Uma chamada de ferramenta virada frase. `null` quando não há nada honesto a dizer. */
function fraseDaFerramenta(parte) {
  const e = parte.input || {};
  switch (parte.name) {
    case 'Edit': case 'Write': case 'NotebookEdit': return `editando ${nomeDoArquivo(e.file_path)}`;
    case 'Read': return `lendo ${nomeDoArquivo(e.file_path)}`;
    case 'Bash': {
      // O comando cru cortado em 42 caracteres some justamente no que importa: um `/ataca`
      // edita arquivo por `python3 - <<'PY' p='docs/…'`, e a lista virava vinte linhas de
      // "rodando python3 - <<'PY' p='docs/superpowers/spec…" idênticas. Com o arquivo na
      // frente dá para ver em QUE peça ele está mexendo. O verbo continua "rodando" e não
      // "editando": daqui não dá para saber se aquele python escreve ou só lê.
      const cmd = String(e.command || '').trim();
      const prog = (cmd.split(/\s+/)[0] || '').split('/').pop();
      const alvo = (cmd.match(/[\w./@-]+\.(?:md|js|mjs|cjs|json|css|html|py|sh|ts|tsx|yml|yaml|txt)\b/) || [])[0];
      return alvo ? `rodando ${prog} · ${nomeDoArquivo(alvo)}` : `rodando ${curto(cmd)}`;
    }
    case 'Grep': case 'Glob': return `procurando ${curto(e.pattern || e.glob)}`;
    case 'Task': return `subagente: ${curto(e.description)}`;
    // Sem esta linha um `/ataca` mostra "usando Skill" — e é justamente a skill que diz em
    // que PARTE do fluxo o job está (audita, executa-plano).
    case 'Skill': return `skill /${curto(e.skill, 30)}`;
    case 'WebSearch': case 'WebFetch': return 'pesquisando na web';
    default: return `usando ${parte.name}`;
  }
}

/** A última ação do agente virada frase. `null` para o que é ruído. */
function etapaDoEvento(bruto) {
  if (!bruto || bruto.type !== 'assistant') return null;
  const partes = [...((bruto.message && bruto.message.content) || [])].reverse();
  for (const parte of partes) {
    if (parte.type !== 'tool_use') continue;
    // TodoWrite muda a cada dois passos e não diz nada sobre o trabalho: puro ruído
    // piscando na faixa.
    if (parte.name === 'TodoWrite') return null;
    return fraseDaFerramenta(parte);
  }
  return null;
}

/**
 * Em que etapa o job está, tirada da cauda do `claude.log`.
 *
 * 🔴 Só vale para job VIVO, e quem garante isso é o chamador: abrir o log dos 160 jobs
 * concluídos a cada varredura seria trabalho jogado fora — com 179 pastas no disco e um
 * `running` entre elas, é UM arquivo aberto, não 179.
 */
async function etapaAtual(dir) {
  let fd = null;
  try {
    fd = await fsp.open(path.join(dir, 'claude.log'), 'r');
    const { size } = await fd.stat();
    if (!size) return null;
    const inicio = Math.max(0, size - CAUDA_LOG);
    const buf = Buffer.alloc(size - inicio);
    await fd.read(buf, 0, buf.length, inicio);
    const linhas = buf.toString('utf8').split('\n');
    // Cortar no meio de uma linha é o normal quando se lê só a cauda: a primeira fica
    // truncada e nunca vai parsear. Descartar é mais honesto do que deixar o catch comer.
    if (inicio > 0) linhas.shift();
    // De trás para frente: a etapa é a última AÇÃO, não a última linha qualquer.
    for (let i = linhas.length - 1; i >= 0; i -= 1) {
      if (!linhas[i]) continue;
      let bruto;
      try { bruto = JSON.parse(linhas[i]); } catch { continue; }
      const etapa = etapaDoEvento(bruto);
      if (etapa) return etapa;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/** O `mtime` de um arquivo em epoch, ou `null` — a hora em que o órfão parou de escrever. */
async function mtimeOuNull(caminho) {
  try { return (await fsp.stat(caminho)).mtimeMs; } catch { return null; }
}

// ─── A máquina de estados ───────────────────────────────────────────────────

/**
 * O estado real do job, por ordem de confiança das fontes. Nove passos, nesta ordem — trocar
 * dois de lugar troca o estado de jobs reais.
 *
 * `meta.status` é o campo que o script gravou na CRIAÇÃO e nem sempre é reescrito no fim: um
 * job que terminou bem continuou com `running` no meta enquanto o `status.log` já registrava
 * `done`. Por isso a fonte primária é o ÚLTIMO EVENTO do log, que é append-only —
 * `done`/`failed`/`blocked` são veredito final e valem sobre o meta.
 *
 * `working` é o único caso ambíguo: o job ou está vivo, ou morreu no meio sem escrever nada.
 * Aí sim o processo real (pid/tmux) decide, e "órfão" fica reservado para a morte silenciosa,
 * que é o caso em que sobra worktree para limpar.
 */
function estadoVivo(meta, sessoes, evento) {
  const alive = pidVivo(meta.pid);
  const tmux = meta.tmux_session ? sessoes.has(meta.tmux_session) : false;
  const declared = meta.status || 'unknown';
  const base = { alive, tmux, declared };

  // 1-2. Fim de linha do ciclo de vida: merge e teardown só existem no meta.
  if (meta.teardown_at) return { state: 'teardown', ...base };
  if (meta.merged_at) return { state: 'merged', ...base };

  // 3-5. Veredito escrito no log vale sobre tudo o que vem depois.
  const kind = evento && evento.kind;
  if (kind === 'done') return { state: 'done', ...base };
  if (kind === 'failed') return { state: 'failed', ...base };
  if (kind === 'blocked') return { state: 'blocked', ...base };

  // 6. `working` é ambíguo: o processo decide.
  if (kind === 'working') return { state: alive || tmux ? 'running' : 'orfao', ...base };

  // 7-9. Sem log legível: cai no meta, cruzado com o processo.
  if (declared === 'running' && !alive && !tmux) return { state: 'orfao', ...base };
  if (alive || tmux) return { state: 'running', ...base };
  return { state: declared, ...base };
}

/**
 * Job parado há tempo demais para valer a atenção de quem usa.
 *
 * 🔴 O relógio é o do EVENTO terminal, não o do nascimento: um job que rodou 6 h e falhou tem
 * de ficar visível 24 h depois de FALHAR, não 24 h depois de começar.
 *
 * 🔴 E o órfão não tem evento terminal — ele morreu calado, e é essa a definição dele. Sem o
 * `mtime` do `claude.log`, um órfão de um mês cujo `created_at` está ilegível ficaria visível
 * para sempre, ou (pior) um órfão nascido hoje seria arquivado por causa de um `created_at`
 * antigo herdado. O carimbo é o MAIOR dos dois: a última vez que aquele job deu sinal.
 *
 * `Math.max(NaN, x)` é `NaN` — daí o filtro ANTES, e não depois. Sem carimbo nenhum, MOSTRA:
 * na dúvida, aparecer é o erro barato.
 */
function estaArquivado(state, evento, criadoEm, mortoEm = null) {
  if (!ESTADOS_QUE_ARQUIVAM.has(state)) return false;
  const candidatos = [Date.parse((evento && evento.at) || criadoEm || ''), mortoEm]
    .filter(Number.isFinite);
  if (!candidatos.length) return false;
  return Date.now() - Math.max(...candidatos) > horasArquiva() * 3600 * 1000;
}

// ─── A leitura ──────────────────────────────────────────────────────────────

/**
 * Um job do disco, ou `null` para qualquer tropeço — `meta.json` ausente, quebrado, sem
 * permissão, pasta sumindo no meio da varredura (o orquestrador faz teardown enquanto isto
 * roda). 🔴 Um job ilegível PULA; nunca derruba a lista inteira.
 *
 * Nada de `readdir` por job aqui: o painel antigo listava a pasta de cada um para nada — o
 * único arquivo que a saída precisa saber que existe é o `result.md`, e para isso basta o
 * `stat` dele. Eram 179 leituras de diretório por varredura, a cada 15 s.
 */
async function lerJob(raiz, id) {
  const dir = path.join(raiz, id);
  let meta;
  try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; }
  if (!meta || typeof meta !== 'object') return null;

  const status = await fsp.readFile(path.join(dir, 'status.log'), 'utf8').catch(() => '');
  let resultado = 0;
  try { resultado = (await fsp.stat(path.join(dir, 'result.md'))).size; } catch { /* sem result.md */ }
  return { meta, dir, evento: ultimoEvento(status), temResultado: resultado > 0 };
}

/**
 * A lista inteira, e ela tem TRÊS formas de retorno — distinguidas pelo chamador, não
 * escondidas aqui:
 *
 * | situação                      | devolve                                  |
 * |-------------------------------|------------------------------------------|
 * | a pasta não existe (`ENOENT`) | `{ jobs: [], ausente: true, … }`         |
 * | outro erro ao abrir a raiz    | `null`                                   |
 * | leu                           | `{ jobs, arquivados, pulados, now }`     |
 *
 * A distinção importa: "não existe" é o estado NORMAL de quem clonou o repositório e não usa
 * orquestrador nenhum — a tela diz "nenhum job", não "deu erro". Já `EACCES` na raiz é um
 * problema de verdade, e `null` é como este módulo diz "não sei", sem inventar lista vazia.
 *
 * 🔴 A pasta é lida ANTES do `tmux ls`: sem jobs no disco não há por que pagar um `execFile`
 * de 4 s de timeout — que é justamente o caso do clone limpo e do CI.
 */
async function listar() {
  const raiz = dirJobs();
  const agora = new Date().toISOString();

  let nomes;
  try {
    nomes = await fsp.readdir(raiz);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { jobs: [], arquivados: 0, pulados: 0, now: agora, ausente: true };
    return null;
  }

  const ids = nomes.filter((n) => !n.startsWith('.')).sort().reverse().slice(0, TETO_PASTAS);
  if (!ids.length) return { jobs: [], arquivados: 0, pulados: 0, now: agora };

  const sessoes = await sessoesTmux();
  const jobs = [];
  let pulados = 0;

  for (const id of ids) {
    const j = await lerJob(raiz, id);
    if (!j) { pulados += 1; continue; }
    const vivo = estadoVivo(j.meta, sessoes, j.evento);
    // Só de quem está rodando: é o único caso em que "etapa" quer dizer alguma coisa.
    const etapa = vivo.state === 'running' ? await etapaAtual(j.dir) : null;
    // E só do órfão: é o único que não tem evento terminal para carimbar a idade.
    const mortoEm = vivo.state === 'orfao' ? await mtimeOuNull(path.join(j.dir, 'claude.log')) : null;
    jobs.push({
      etapa,
      id: j.meta.id || id,
      type: j.meta.type,
      project: j.meta.project,
      title: j.meta.title || '(sem título)',
      created_at: j.meta.created_at,
      worktree: j.meta.worktree || '',
      branch: j.meta.branch || '',
      origin: j.meta.origin,
      merged_at: j.meta.merged_at,
      approved_at: j.meta.approved_at,
      hasResult: j.temResultado,
      event: j.evento,
      ...vivo,
      arquivado: estaArquivado(vivo.state, j.evento, j.meta.created_at, mortoEm),
    });
  }

  // Mais recente primeiro. `created_at` é ISO com offset e ordena como string na mesma zona.
  //
  // 🔴 O desempate por `id` é explícito porque o empate é REAL: 6 grupos de jobs nascidos no
  // mesmo segundo no disco de hoje (o orquestrador dispara em lote). O painel antigo deixava
  // esses empates na ordem que o `readdir` devolvesse — que varia com o sistema de arquivos e
  // não se reproduz. Duas varreduras seguidas podiam trocar duas linhas de lugar na tela sem
  // nada ter mudado.
  jobs.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))
    || String(b.id || '').localeCompare(String(a.id || '')));
  return { jobs, arquivados: jobs.filter((j) => j.arquivado).length, pulados, now: agora };
}

module.exports = {
  listar,
  // Exportados para o gate exercitar cada peça sem fabricar uma pasta inteira por caso.
  estadoVivo, estaArquivado, ultimoEvento, pidVivo, horasArquiva, etapaAtual, ESTADOS,
};
