#!/usr/bin/env node
'use strict';
// GATE DA ROTA — `GET /api/jobs` (card `painel-de-jobs-dentro-do-app`, spec/plano de 2026-09-08).
//
// Prova o SERVIDOR, não um mock. `carregarCliente({aoBuscar})` do `gate-ui.js` responde o que
// o teste mandou (`gate-ui.js:328-333`) — usá-lo aqui provaria o mock, não o `server.js`. Como
// `server.js` não tem `module.exports`, a função não pode ser importada: este gate sobe o
// servidor DE VERDADE (`require` em processo, mesmo molde de `gate-troca-arquivo.js` e
// `gate-fila-pendente.js`) e fala HTTP com ele. O painel de jobs também é um HTTP de mentira,
// no MESMO processo — sem isso o `?tudo=1` não teria ninguém real para responder.
//
// Uso:  node testes/gate-jobs-rota.js
//
// Nasce VERMELHO de propósito (Fase 1 do plano): `?tudo=1` ainda não existe em `server.js`.
// A Fase 2 implementa a rota e este MESMO arquivo passa a fechar verde — nenhum assert daqui
// é reescrito para isso, só o `server.js` muda.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); if (!c) falhas += 1; return c; };
let falhas = 0;

// ─── Portas — 7891-7898, nunca 7879 (produção) nem 7899 (gate dos jobs do orquestrador, #24) ───

function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => {
      const campos = linha.trim().split(/\s+/);
      return (campos[3] || '').endsWith(`:${porta}`);
    });
  } catch {
    return true; // `ss` indisponível — o `listen()` denuncia se a porta estiver ocupada
  }
}

const PORTA_SERVIDOR = Number(process.env.PORT || 7891);

for (const p of [PORTA_SERVIDOR]) {
  if (p < 7891 || p > 7898) {
    console.error(`🔴 porta ${p} fora da faixa 7891-7898 — nunca 7879 (produção) nem 7899 (#24).`);
    process.exit(2);
  }
  if (!portaLivre(p)) {
    console.error(`🔴 a porta ${p} já está ocupada (conferido com \`ss -H -lptn\`). Tente outra.`);
    process.exit(1);
  }
}

// ─── tmux — socket PRÓPRIO, nunca o `main` do usuário (D35) ────────────────────────────────
//
// A rota chama `abas.listar()`/`abas.abasDoProjeto()`, e sem `COCKPIT_TMUX_SOCKET` próprio
// `lib/abas.js:56,62` caem no socket/sessão PADRÃO — o tmux real do usuário. Aqui não é preciso
// carimbo de posse nem sessão viva: a rota só LÊ (`list-panes`), nunca cria pane nenhuma, e um
// `tmux -L <socket-inexistente> list-panes` erra na hora, sem subir servidor (medido: nenhum
// arquivo de socket nasce disso) — então não há nada para o `finally` derrubar além de
// confirmar que continua vazio.

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(2);
}
const SOCKET_TMUX = `gate-jobs-rota-${process.pid}`;
const SESSAO_TMUX = 'gate-jobs-rota';
try {
  execFileSync('tmux', ['-L', SOCKET_TMUX, 'ls'], { stdio: 'ignore' });
  console.error(`🔴 o socket ${SOCKET_TMUX} já existe — não é meu. Abortando.`);
  process.exit(1);
} catch { /* esperado: socket fabricado com o próprio pid, não deveria existir */ }

const CERT_DIR_VAZIO = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-jobs-rota-cert-'));

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── A pasta de jobs de mentira ─────────────────────────────────────────────────────────
//
// Até 2026-09-10 este bloco era um `http.createServer` fingindo ser o `painel-externo`, e a
// rota consumia JSON pronto. Agora a rota lê o DISCO (`lib/jobs.js`), então a fixture tem de
// ser disco também: `plantarJobs(lista)` recebe os MESMOS objetos que as `fixtura*()` já
// montavam e escreve as pastas que fazem `lib/jobs.js` produzi-los de volta.
//
// 🔴 É essa tradução que deixa os 15 asserts originais INTOCADOS. Reescrevê-los para caber no
// resultado novo seria trocar a pergunta pela resposta — o gate deixaria de provar que a rota
// preservou o contrato e passaria a provar que alguém sabe editar arquivo de teste.
//
// A pasta é trocada por inteiro entre um cenário e outro: cada J-assert planta o que precisa,
// nunca dividindo estado com o teste vizinho.

const RAIZ_JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-jobs-rota-disco-'));

// Um pid que NÃO existe — é o que faz um `working` no log virar `orfao` em vez de `running`.
// Um acima do teto do sistema nunca foi atribuído a ninguém.
const PID_MORTO = (() => {
  try { return Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1; }
  catch { return 4194304; }
})();

// A linha de `claude.log` que vira a etapa `editando app.js` — o sujeito do J1.
const LINHA_DE_ETAPA = `${JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/public/app.js' } }] },
})}\n`;

/**
 * Escreve no disco as pastas que reproduzem `lista`.
 *
 * O caminho de volta é a máquina de estados de `lib/jobs.js` (os nove passos), lida ao
 * contrário: para o job sair com `state: X`, o que tem de estar no disco é isto —
 *
 * | `state` pedido      | o que a pasta ganha                                            |
 * |---------------------|----------------------------------------------------------------|
 * | `teardown`          | `meta.teardown_at` (passo 1, vence tudo)                        |
 * | `merged`            | `meta.merged_at` (passo 2)                                     |
 * | `done`/`failed`/`blocked` | última linha do `status.log` com esse `kind` (passos 3-5) |
 * | `running`           | `kind: working` + `meta.pid` VIVO (passo 6)                     |
 * | `orfao`             | `kind: working` + `meta.pid` morto (passo 6, do outro lado)     |
 * | desconhecido        | `meta.status` com o nome cru + `kind` que não é nenhum dos acima |
 *
 * 🔴 `event: null` vira AUSÊNCIA do `status.log`, não um arquivo vazio: é o que dá `event:
 * null` de volta, e é o sujeito do J9.
 *
 * 🔴 `event.at` que o painel entregava como `null` não existe no disco — uma linha sem hora
 * legível também não tem `kind` legível (o parser é um regex só). Onde a fixture pedia
 * `{ at: null, kind: 'done' }`, o disco recebe uma hora que NÃO parseia; o efeito medido é o
 * mesmo (fora da janela) e o J13 continua provando o que provava.
 */
function plantarJobs(lista) {
  fs.rmSync(RAIZ_JOBS, { recursive: true, force: true });
  fs.mkdirSync(RAIZ_JOBS, { recursive: true });

  for (const j of lista) {
    const dir = path.join(RAIZ_JOBS, j.id);
    fs.mkdirSync(dir, { recursive: true });

    const meta = {
      id: j.id,
      type: j.type,
      project: j.project,
      title: j.title,
      created_at: j.created_at,
      origin: j.origin,
      // Os três campos que o J4 vigia entram no disco COM valor sentinela, e é isso que dá
      // dentes ao assert: sem eles aqui, "não vazou" provaria que a fixture não os tinha.
      // `source_repo` é a exceção declarada — `lib/jobs.js` sequer o lê, então ele virou
      // vácuo: continua na fixture para o dia em que alguém o reintroduzir sem pensar.
      worktree: j.worktree,
      branch: j.branch,
      source_repo: j.source_repo,
      merged_at: null,
      approved_at: null,
      status: 'running',
      pid: PID_MORTO,
    };

    let linhaStatus = null;
    const at = j.event && j.event.at !== undefined ? j.event.at : null;
    // Hora ausente vira uma que não parseia: o disco não sabe representar "sem hora, com
    // kind" (ver o comentário do cabeçalho).
    const hora = at || 'sem-hora-legivel';
    const texto = (j.event && j.event.text) || 'x';

    switch (j.state) {
      case 'teardown':
        meta.teardown_at = at || j.created_at;
        meta.merged_at = at || j.created_at;
        linhaStatus = `${hora} ${(j.event && j.event.kind) || 'done'}: ${texto}\n`;
        break;
      case 'merged':
        meta.merged_at = at || j.created_at;
        linhaStatus = `${hora} ${(j.event && j.event.kind) || 'done'}: ${texto}\n`;
        break;
      case 'running':
        meta.pid = process.pid;
        linhaStatus = `${hora} working: ${texto}\n`;
        fs.writeFileSync(path.join(dir, 'claude.log'), LINHA_DE_ETAPA);
        break;
      case 'orfao':
        linhaStatus = `${hora} working: ${texto}\n`;
        break;
      case 'done': case 'failed': case 'blocked':
        // O `kind: null` do J5 é uma linha que NÃO bate o formato — sem hora e sem `kind:`,
        // ela volta como `{ at: null, kind: null, text: <cru> }`, e o estado cai no `meta`.
        meta.status = j.state;
        linhaStatus = j.event === null ? null
          : (j.event.kind === null ? `${texto}\n` : `${hora} ${j.event.kind}: ${texto}\n`);
        break;
      default:
        // Desconhecido: o nome cru no `meta.status`, e um `kind` fora dos quatro reconhecidos
        // para que nenhum passo anterior ao 9 o capture.
        meta.status = j.state;
        linhaStatus = j.event === null ? null : `${hora} carimbou: ${texto}\n`;
        break;
    }

    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    if (linhaStatus !== null) fs.writeFileSync(path.join(dir, 'status.log'), linhaStatus);
  }
}

function pedir(caminho) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORTA_SERVIDOR, path: caminho }, (res) => {
      let corpo = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, corpo: JSON.parse(corpo) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── As fixtures — §1.2 do plano ──────────────────────────────────────────────────────────

const H = 60 * 60 * 1000;
const D = 24 * H;
const iso = (deltaMs) => new Date(Date.now() - deltaMs).toISOString();

/**
 * Um job do painel, com os TRÊS campos proibidos (`worktree`, `branch`, `source_repo`) sempre
 * presentes, com valor SENTINELA. O J4 prova que o servidor os CORTA — sem eles na entrada, o
 * assert passaria mesmo numa implementação que os repassasse (provaria que o mock não os tinha,
 * não que o servidor os tira).
 */
function job(id, over = {}) {
  return {
    id,
    type: 'ataca',
    project: `/home/smoke/projetos/${id}`,
    title: `título de ${id}`,
    created_at: iso(0),
    origin: 'capitao',
    state: 'running',
    etapa: null,
    event: null,
    worktree: '/home/SENTINELA/worktrees/x',
    branch: 'SENTINELA-branch',
    source_repo: '/home/SENTINELA/projetos/x',
    ...over,
  };
}

/** A fixture padrão: um job de cada forma que importa (plano, tabela da §1.2). */
function fixturaPadrao() {
  return [
    job('j-run', {
      state: 'running', origin: 'capitao', etapa: 'editando app.js',
      created_at: iso(2 * H), event: { at: iso(2 * H), kind: 'working' },
    }),
    job('j-blk', {
      state: 'blocked', created_at: iso(5 * D),
      event: { at: iso(4 * D), kind: 'blocked', text: 'teardown recusado: job não merged e descarte não aprovado' },
    }),
    // 5 dias, não 3h: com 3h passaria mesmo numa implementação que aplicasse a janela ao
    // órfão — J2/J6 existem para provar que não aplica.
    job('j-orf', {
      state: 'orfao', created_at: iso(5 * D + H),
      event: { at: iso(5 * D), kind: 'working', text: 'worktree criada em /home/usuario/.cockpit/worktrees/x' },
    }),
    job('j-23h', { state: 'done', created_at: iso(30 * H), event: { at: iso(23 * H), kind: 'done' } }),
    job('j-25h', { state: 'done', created_at: iso(40 * H), event: { at: iso(25 * H), kind: 'done' } }),
    // `blocked`, não `done` — como `done` seria excluído pela janela e o campo que o J5 quer
    // testar nunca teria sujeito (§1.2 do plano).
    job('j-nulo', {
      state: 'blocked', created_at: iso(H),
      event: { at: iso(H), kind: null, text: '/home/usuario/linha-crua-do-status-log' },
    }),
    job('j-sem', { state: 'blocked', created_at: iso(H), event: null }),
    job('j-semfim', { state: 'done', created_at: iso(2 * D), event: { at: null, kind: 'done' } }),
    job('j-tel', {
      state: 'running', origin: 'telegram', etapa: 'outra coisa',
      created_at: iso(H), event: { at: iso(H), kind: 'working' },
    }),
    job('j-fail', {
      state: 'failed', created_at: iso(6 * H),
      event: { at: iso(5 * H), kind: 'failed', text: 'executor saiu com código 1' },
    }),
    job('j-mrg', {
      state: 'merged', created_at: iso(30 * H),
      event: { at: iso(23 * H), kind: 'done', text: 'merge comprovado' },
    }),
    job('j-mrg-velho', { state: 'merged', created_at: iso(40 * H), event: { at: iso(25 * H), kind: 'done' } }),
    job('j-trd', {
      state: 'teardown', created_at: iso(30 * H),
      event: { at: iso(23 * H), kind: 'done', text: 'teardown concluído' },
    }),
    job('j-trd-velho', { state: 'teardown', created_at: iso(40 * H), event: { at: iso(25 * H), kind: 'done' } }),
    // 3 dias, não 1h: mesmo raciocínio do órfão, do outro lado do fallback (§1.2).
    job('j-inv', { state: 'inventado', created_at: iso(4 * D), event: { at: iso(3 * D), kind: 'done' } }),
    job('j-inv2', { state: 'inventado2', created_at: iso(H), event: null }),
  ];
}

/** 3 running + 2 blocked (protegidos) + 60 encerrados — para o J8. */
function fixturaTeto() {
  const protegidos = [
    job('teto-run-0', { state: 'running' }),
    job('teto-run-1', { state: 'running' }),
    job('teto-run-2', { state: 'running' }),
    job('teto-blk-0', { state: 'blocked', event: { at: iso(H), kind: 'blocked', text: 'x' } }),
    job('teto-blk-1', { state: 'blocked', event: { at: iso(H), kind: 'blocked', text: 'x' } }),
  ];
  // `i=0` é o mais NOVO (1 min atrás); `i=59`, o mais velho (60 min atrás) — todos na janela.
  const encerrados = Array.from({ length: 60 }, (_, i) => job(`teto-done-${i}`, {
    state: 'done', event: { at: iso((i + 1) * 60000), kind: 'done' },
  }));
  return [...protegidos, ...encerrados];
}

/** 41 protegidos, zero encerrados — para o J11 (o teto CEDE). */
function fixturaProtegidos41() {
  return Array.from({ length: 41 }, (_, i) => job(`prot-${i}`, i % 2 === 0
    ? { state: 'running' }
    : { state: 'blocked', event: { at: iso(H), kind: 'blocked', text: 'x' } }));
}

/** 50 `capitao` + 30 `telegram`, os `telegram` mais recentes — para o J14. */
function fixturaOrigin() {
  const capitao = Array.from({ length: 50 }, (_, i) => job(`origin-cap-${i}`, {
    state: 'done', origin: 'capitao', event: { at: iso((i + 1) * 60000), kind: 'done' },
  }));
  const telegram = Array.from({ length: 30 }, (_, i) => job(`origin-tel-${i}`, {
    state: 'done', origin: 'telegram', event: { at: iso((i + 1) * 1000), kind: 'done' },
  }));
  return [...capitao, ...telegram];
}

// ─── Os asserts — J1 a J15 (spec §8) ──────────────────────────────────────────────────────

/** J1 — PRESERVAÇÃO: sem parâmetro, o payload de hoje não muda, chave a chave e na ordem. */
async function testeJ1() {
  const fixture = fixturaPadrao();
  plantarJobs(fixture);
  const resp = await pedir('/api/jobs');
  const jRun = fixture.find((j) => j.id === 'j-run');
  const esperado = {
    jobs: [
      { id: 'j-run', titulo: jRun.title, projeto: jRun.project, estado: 'running', etapa: jRun.etapa, desde: jRun.created_at, abas: [] },
    ],
    painel: true,
  };
  ok(JSON.stringify(resp.corpo) === JSON.stringify(esperado), `J1 (preservação): sem parâmetro devolve exatamente o payload de hoje — ${JSON.stringify(resp.corpo)}`);
}

async function testeJ2() {
  const fixture = fixturaPadrao();
  plantarJobs(fixture);
  // `&arquivados=1` porque os dois sujeitos (4 d e 5 d) caem na régua de 24 h que esta
  // entrega trouxe. A pergunta é a mesma de sempre — "aparece sem sofrer a JANELA dos
  // encerrados?" —, e é a lista completa que a responde agora.
  const resp = await pedir('/api/jobs?tudo=1&arquivados=1');
  const blk = resp.corpo.jobs.find((j) => j.id === 'j-blk');
  const orf = resp.corpo.jobs.find((j) => j.id === 'j-orf');
  const fxBlk = fixture.find((j) => j.id === 'j-blk');
  const fxOrf = fixture.find((j) => j.id === 'j-orf');
  ok(Boolean(blk) && blk.fim === fxBlk.event.at, `J2: blocked aparece com ?tudo=1, sem janela, fim=evento — ${JSON.stringify(blk)}`);
  ok(Boolean(orf) && orf.fim === fxOrf.event.at, `J2: órfão idem, mesmo 5 dias depois — ${JSON.stringify(orf)}`);
}

async function testeJ3() {
  const resp = await pedir('/api/jobs?tudo=1');
  const h23 = resp.corpo.jobs.some((j) => j.id === 'j-23h');
  const h25 = resp.corpo.jobs.some((j) => j.id === 'j-25h');
  ok(h23 && !h25, `J3: a janela mede o TÉRMINO — 23h entra, 25h não (23h=${h23}, 25h=${h25})`);
}

/** J4 — PRESERVAÇÃO: `server.js:653` já não emite os três campos; o novo campo não reabre a porta. */
async function testeJ4() {
  const resp = await pedir('/api/jobs?tudo=1');
  const vazou = resp.corpo.jobs.some((j) => 'worktree' in j || 'branch' in j || 'source_repo' in j);
  ok(!vazou, 'J4 (preservação): nenhum campo proibido vaza, mesmo com ?tudo=1');
}

async function testeJ5() {
  const resp = await pedir('/api/jobs?tudo=1');
  const nulo = resp.corpo.jobs.find((j) => j.id === 'j-nulo');
  ok(Boolean(nulo) && nulo.desfecho === null, `J5: \`kind: null\` não vaza o texto cru do status.log como desfecho — ${JSON.stringify(nulo)}`);
}

async function testeJ6() {
  const resp = await pedir('/api/jobs?tudo=1&arquivados=1');   // o órfão tem 5 d — ver J2
  const orf = resp.corpo.jobs.find((j) => j.id === 'j-orf');
  ok(Boolean(orf) && orf.desfecho === null, `J6: órfão (último evento \`working\`) não ganha desfecho — ${JSON.stringify(orf)}`);
}

/** J7 — PRESERVAÇÃO: o filtro de origin foi mantido de propósito, não por esquecimento. */
async function testeJ7() {
  const resp = await pedir('/api/jobs?tudo=1');
  const tel = resp.corpo.jobs.some((j) => j.id === 'j-tel');
  ok(!tel, 'J7 (preservação): origin `telegram` continua fora, mesmo com ?tudo=1');
}

async function testeJ8() {
  plantarJobs(fixturaTeto());
  const resp = await pedir('/api/jobs?tudo=1');
  const idsEsperados = new Set([
    'teto-run-0', 'teto-run-1', 'teto-run-2', 'teto-blk-0', 'teto-blk-1',
    ...Array.from({ length: 35 }, (_, i) => `teto-done-${i}`),
  ]);
  const idsRecebidos = new Set(resp.corpo.jobs.map((j) => j.id));
  const bate = idsRecebidos.size === 40 && [...idsEsperados].every((id) => idsRecebidos.has(id));
  ok(bate, `J8: teto corta 60 encerrados para 35 (+ 5 protegidos) = 40, pelo lado certo — recebido ${idsRecebidos.size}`);
}

async function testeJ9() {
  plantarJobs(fixturaPadrao());
  const resp = await pedir('/api/jobs?tudo=1');
  const sem = resp.corpo.jobs.find((j) => j.id === 'j-sem');
  const chavesOk = Boolean(sem) && 'fim' in sem && 'desfecho' in sem && sem.fim === null && sem.desfecho === null;
  ok(chavesOk, `J9: job com \`event: null\` chega com \`fim\`/\`desfecho\` NULL — chave sempre, valor null — ${JSON.stringify(sem)}`);
}

async function testeJ10() {
  const fixture = fixturaPadrao();
  plantarJobs(fixture);
  const resp = await pedir('/api/jobs?tudo=1&arquivados=1');   // o blocked tem 4 d — ver J2
  const blk = resp.corpo.jobs.find((j) => j.id === 'j-blk');
  const fx = fixture.find((j) => j.id === 'j-blk');
  const bate = Boolean(blk) && blk.tipo === 'ataca' && blk.fim === fx.event.at && blk.desfecho === fx.event.text;
  ok(bate, `J10: um blocked de verdade chega com tipo/fim/desfecho corretos, por VALOR — ${JSON.stringify(blk)}`);
}

async function testeJ11() {
  plantarJobs(fixturaProtegidos41());
  const resp = await pedir('/api/jobs?tudo=1');
  ok(resp.corpo.jobs.length === 41, `J11: o teto CEDE para 41 protegidos (nunca 40) — recebido ${resp.corpo.jobs.length}`);
}

async function testeJ12() {
  plantarJobs(fixturaPadrao());
  const resp = await pedir('/api/jobs?tudo=1');
  const inv = resp.corpo.jobs.find((j) => j.id === 'j-inv');
  const inv2 = resp.corpo.jobs.find((j) => j.id === 'j-inv2');
  ok(Boolean(inv) && inv.estado === 'inventado', `J12: estado desconhecido entra cru, sem janela (3 dias) — ${JSON.stringify(inv)}`);
  ok(Boolean(inv2) && inv2.estado === 'inventado2', `J12: e mesmo sem \`event\` nenhum — ${JSON.stringify(inv2)}`);
}

/** J13 — FRONTEIRA: nasce verde. `done` sem hora não cabe numa janela nem hoje nem depois. */
async function testeJ13() {
  const resp = await pedir('/api/jobs?tudo=1');
  const semfim = resp.corpo.jobs.some((j) => j.id === 'j-semfim');
  ok(!semfim, 'J13 (fronteira): `done` com `event.at: null` não aparece nem com ?tudo=1');
}

async function testeJ14() {
  plantarJobs(fixturaOrigin());
  const resp = await pedir('/api/jobs?tudo=1');
  const ids = resp.corpo.jobs.map((j) => j.id);
  const todosCapitao = ids.every((id) => id.startsWith('origin-cap-'));
  const esperados = new Set(Array.from({ length: 40 }, (_, i) => `origin-cap-${i}`));
  const bateIds = ids.length === 40 && [...esperados].every((id) => ids.includes(id));
  ok(todosCapitao && bateIds, `J14: o filtro de origin roda ANTES do teto — 40 \`capitao\` mais novas, nenhum \`telegram\` — recebido ${ids.length}`);
}

async function testeJ15() {
  plantarJobs(fixturaPadrao());
  const resp = await pedir('/api/jobs?tudo=1');
  const mrg = resp.corpo.jobs.find((j) => j.id === 'j-mrg');
  const mrgVelho = resp.corpo.jobs.some((j) => j.id === 'j-mrg-velho');
  const trd = resp.corpo.jobs.find((j) => j.id === 'j-trd');
  const trdVelho = resp.corpo.jobs.some((j) => j.id === 'j-trd-velho');
  const bate = Boolean(mrg) && mrg.estado === 'merged' && !mrgVelho
    && Boolean(trd) && trd.estado === 'teardown' && !trdVelho;
  ok(bate, `J15: \`merged\`/\`teardown\` seguem a janela como os outros encerrados, com estado próprio — mrg=${JSON.stringify(mrg)}, trd=${JSON.stringify(trd)}`);
}

/**
 * J16/J17 — a régua de 24 h, os dois lados.
 *
 * Ela é a D40 sendo revogada: até esta entrega, `blocked`/`orfao`/`failed` NUNCA eram
 * cortados, e o resultado era um `blocked` de 02/09 ainda contando como "travado" uma semana
 * depois. Agora eles saem da vista depois de 24 h parados — e voltam com `?arquivados=1`,
 * porque sair da vista não é sumir do disco.
 */
async function testeJ16() {
  plantarJobs([
    job('reg-blk-velho', { state: 'blocked', created_at: iso(5 * D), event: { at: iso(4 * D), kind: 'blocked', text: 'travado há dias' } }),
    job('reg-blk-novo', { state: 'blocked', created_at: iso(2 * H), event: { at: iso(H), kind: 'blocked', text: 'travado agora' } }),
  ]);
  const semParam = await pedir('/api/jobs?tudo=1');
  const comParam = await pedir('/api/jobs?tudo=1&arquivados=1');
  const velhoSem = semParam.corpo.jobs.some((j) => j.id === 'reg-blk-velho');
  const velhoCom = comParam.corpo.jobs.some((j) => j.id === 'reg-blk-velho');
  ok(!velhoSem, `J16: \`blocked\` de 4 dias SOME da lista padrão (a D40 dizia que nunca sairia) — apareceu=${velhoSem}`);
  ok(velhoCom, `J16: e volta com \`?arquivados=1\` — sair da vista não é sumir do disco (apareceu=${velhoCom})`);
}

async function testeJ17() {
  const semParam = await pedir('/api/jobs?tudo=1');
  const novo = semParam.corpo.jobs.find((j) => j.id === 'reg-blk-novo');
  ok(Boolean(novo) && novo.estado === 'blocked', `J17: \`blocked\` de 1 hora FICA — a régua corta por idade, não por estado — ${JSON.stringify(novo)}`);
}

/**
 * J18 — o desarquivado não paga o teto, e não fura a fila dos que exigem ação.
 *
 * Fixture: 40 encerrados recentes (o teto já cheio) + 1 `failed` de 4 dias, arquivado. Com
 * `?arquivados=1` a resposta continua tendo 40 linhas: `vagas = 40 − 0 protegidos − 1
 * desarquivado = 39`, então entram o desarquivado e os 39 encerrados mais novos.
 */
async function testeJ18() {
  const encerrados = Array.from({ length: 40 }, (_, i) => job(`t18-done-${i}`, {
    state: 'done', created_at: iso((i + 1) * 60000), event: { at: iso((i + 1) * 60000), kind: 'done' },
  }));
  plantarJobs([...encerrados, job('t18-fail-velho', {
    state: 'failed', created_at: iso(5 * D), event: { at: iso(4 * D), kind: 'failed', text: 'falhou há dias' },
  })]);

  const semParam = await pedir('/api/jobs?tudo=1');
  ok(semParam.corpo.jobs.length === 40 && !semParam.corpo.jobs.some((j) => j.id === 't18-fail-velho'),
    `J18: sem o parâmetro, 40 encerrados e nenhum \`failed\` velho — recebido ${semParam.corpo.jobs.length}`);

  const resp = await pedir('/api/jobs?tudo=1&arquivados=1');
  const ids = resp.corpo.jobs.map((j) => j.id);
  const temDesarquivado = ids.includes('t18-fail-velho');
  ok(resp.corpo.jobs.length === 40 && temDesarquivado,
    `J18: com o parâmetro, o teto continua 40 no TOTAL e o desarquivado entra (vagas = 40−0−1 = 39) — recebido ${resp.corpo.jobs.length}, desarquivado=${temDesarquivado}`);
  ok(ids.filter((id) => id.startsWith('t18-done-')).length === 39,
    `J18: e são 39 encerrados, não 40 — o desarquivado ocupou uma vaga como qualquer outro (${ids.filter((id) => id.startsWith('t18-done-')).length})`);
  // 🔴 A posição importa: o desarquivado NÃO é `protegido` (isso mudaria o `rank`), então ele
  // se ordena entre os encerrados pelo término. Um `failed` de 4 dias no TOPO da lista, na
  // frente do que exige ação hoje, seria o oposto do que a ordem por urgência serve.
  ok(ids[0] !== 't18-fail-velho', `J18: e ele não fura a fila — o mais velho não abre a lista (topo=${ids[0]})`);
}

/**
 * A8b — o contador `arquivados` conta o que ESTA rota esconderia: depois do filtro de origem,
 * antes de esconder. Contar antes do filtro somaria jobs que a rota nunca mostra; contar
 * depois de esconder daria sempre zero.
 */
async function testeA8b() {
  plantarJobs([
    job('cnt-cap-velho', { state: 'blocked', created_at: iso(5 * D), event: { at: iso(4 * D), kind: 'blocked', text: 'travado' } }),
    job('cnt-tel-velho', { state: 'blocked', origin: 'telegram', created_at: iso(5 * D), event: { at: iso(4 * D), kind: 'blocked', text: 'travado' } }),
    job('cnt-cap-novo', { state: 'blocked', created_at: iso(H), event: { at: iso(H), kind: 'blocked', text: 'travado agora' } }),
  ]);
  const resp = await pedir('/api/jobs?tudo=1');
  ok(resp.corpo.arquivados === 1, `A8b: o contador diz 1 — o \`telegram\` velho não conta (a rota nunca o mostraria) e o \`capitao\` novo também não — veio ${resp.corpo.arquivados}`);
  const semTudo = await pedir('/api/jobs');
  ok(!('arquivados' in semTudo.corpo), `A8b: e a chave NÃO existe no ramo sem parâmetro — o J1 compara o objeto inteiro — ${JSON.stringify(semTudo.corpo)}`);
}

// ─── Execução ──────────────────────────────────────────────────────────────────────────────

async function principal() {
  process.env.PORT = String(PORTA_SERVIDOR);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = CERT_DIR_VAZIO;
  process.env.COCKPIT_TOKEN = '';
  // A pasta é DESTE gate e some no fim. Posta aqui dentro, e não herdada do ambiente:
  // `bin/testes.js:11` apaga toda variável `COCKPIT_*` antes de chamar cada teste.
  process.env.COCKPIT_JOBS_DIR = RAIZ_JOBS;
  // A janela do arquivamento é fixada no padrão de propósito: os asserts J16-J18 medem a
  // régua de 24 h, e um valor herdado do ambiente de quem roda os faria passar ou falhar por
  // motivo nenhum.
  delete process.env.COCKPIT_HORAS_ARQUIVA;
  process.env.COCKPIT_TMUX_SOCKET = SOCKET_TMUX;
  process.env.COCKPIT_TMUX_SESSAO = SESSAO_TMUX;
  process.env.COCKPIT_VIGIA_MS = '0'; // sem HOME falso aqui — cinto e suspensório
  require(path.join(__dirname, '..', 'server.js'));
  await espera(400); // o `listen()` do http assentar

  console.log('\n── GET /api/jobs — sem parâmetro (preservação) ──\n');
  await testeJ1();

  console.log('\n── GET /api/jobs?tudo=1 ──\n');
  await testeJ2();
  await testeJ3();
  await testeJ4();
  await testeJ5();
  await testeJ6();
  await testeJ7();
  await testeJ8();
  await testeJ9();
  await testeJ10();
  await testeJ11();
  await testeJ12();
  await testeJ13();
  await testeJ14();
  await testeJ15();

  console.log('\n── a régua de 24 h (a D40 revogada) ──\n');
  await testeJ16();
  await testeJ17();
  await testeJ18();
  await testeA8b();

  // NENHUM `kill-server` aqui, e isso é a D35 levada a sério: este gate não SOBE servidor
  // tmux nenhum (o `-L <socket inexistente>` faz `abas.listar()` errar na hora e devolver
  // lista vazia, que é exatamente o isolamento que se quer). Matar "por via das dúvidas" um
  // socket que não se provou ser seu é o oposto de fail-closed — se um dia o nome colidir,
  // o `kill-server` derruba o servidor de outra pessoa. Não há o que limpar: nada nasceu.
  fs.rmSync(CERT_DIR_VAZIO, { recursive: true, force: true });
  fs.rmSync(RAIZ_JOBS, { recursive: true, force: true });

  console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — GET /api/jobs\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.error('🔴 o gate estourou —', e);
  // Idem: sem `kill-server` sem posse, nem no caminho de erro (D35).
  process.exit(1);
});
