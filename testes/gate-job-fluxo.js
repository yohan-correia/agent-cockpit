#!/usr/bin/env node
'use strict';

/**
 * Gate de `server.js` — o job como fonte do fluxo SSE (Fase 3 do plano
 * `2026-09-12-ver-a-conversa-do-job-plano.md`).
 *
 * Sobe `server.js` DE VERDADE, num processo FILHO (`spawn`, nunca `require` — armadilha: um
 * `require('../server.js')` sem `PORT` sobe na porta de produção). Porta alta da faixa
 * 7890-7898, fail-closed (molde: `testes/gate-jobs-rota.js`). Nunca a 7899 (jobs, #24) nem a
 * 7879 (produção). `COCKPIT_JOBS_DIR` aponta para uma pasta fabricada em `tmp` — nunca
 * `~/.cockpit/jobs` nem a pasta de jobs do orquestrador.
 *
 * Uso: COCKPIT_CERT_DIR=/dev/null HOST=127.0.0.1 PORT=7893 node testes/gate-job-fluxo.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

let falhas = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) falhas += 1;
  return cond;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Porta — fail-closed, nunca herdada, nunca 7879/7899 ───────────────────────────────────

function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => {
      const campos = linha.trim().split(/\s+/);
      return (campos[3] || '').endsWith(`:${porta}`);
    });
  } catch {
    return true;
  }
}

const PORTA = Number(process.env.PORT || 7893);
if (PORTA < 7890 || PORTA > 7898) {
  console.error(`🔴 porta ${PORTA} fora da faixa 7890-7898 — nunca 7879 (produção) nem 7899 (#24).`);
  process.exit(2);
}
if (!portaLivre(PORTA)) {
  console.error(`🔴 a porta ${PORTA} já está ocupada. Tente outra.`);
  process.exit(1);
}

// ─── tmux — socket PRÓPRIO, nunca o `main` do usuário ──────────────────────────────────────
//
// Sobrescreve (não rejeita) um valor herdado: `bin/testes.js` injeta `COCKPIT_TMUX_SOCKET`
// para TODO gate da lista (menos `gate-jobs-rota.js`, que tem trava própria) — rejeitar aqui
// derrubaria este gate assim que ele entrasse no `npm test`. Este socket nunca é o real: um
// `tmux -L <socket-inexistente> list-panes` erra na hora, sem subir servidor nenhum.
const SOCKET_TMUX = `gate-job-fluxo-${process.pid}`;

// ─── A pasta de jobs fabricada ──────────────────────────────────────────────────────────────

const RAIZ_JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-job-fluxo-jobs-'));
const CERT_DIR_VAZIO = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-job-fluxo-cert-'));

function escreverJob(id, { status = '', log = '', pid = process.pid } = {}) {
  const dir = path.join(RAIZ_JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, type: 'ataca', project: `/tmp/projeto-${id}`, title: `título de ${id}`,
    created_at: new Date().toISOString(), origin: 'capitao', pid,
  }));
  fs.writeFileSync(path.join(dir, 'status.log'), status);
  fs.writeFileSync(path.join(dir, 'claude.log'), log);
  return dir;
}

const linhaEvento = (texto) => `${JSON.stringify({
  type: 'assistant', message: { content: [{ type: 'text', text: texto }] },
  timestamp: new Date().toISOString(),
})}\n`;

// Um `assistant` PRINCIPAL (`parent_tool_use_id: null` explícito) com `usage` — o card
// `contexto-da-sessao-do-job`. Só `usados`; nunca `teto`/`pct` nestes gates (spec §7.3): o
// servidor de verdade lê `~/.claude/settings.json` DA MÁQUINA, e uma asserção de teto passaria
// no servidor (que tem `[1m]`) e quebraria num clone limpo.
const linhaEventoComUso = (texto, usados, modelo = 'claude-opus-5') => `${JSON.stringify({
  type: 'assistant', parent_tool_use_id: null,
  message: { role: 'assistant', model: modelo, content: [{ type: 'text', text: texto }],
    usage: { input_tokens: usados, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  timestamp: new Date().toISOString(),
})}\n`;

const linhaStatus = (kind, texto) => `${new Date().toISOString()} ${kind}: ${texto}\n`;

// ─── Cliente SSE mínimo ─────────────────────────────────────────────────────────────────────

/**
 * Conecta no cano e devolve `{ status, eventos, encerrar }`. `eventos` é um array que continua
 * sendo preenchido DEPOIS do resolve — quem chama espera o tempo que precisar e olha o array.
 * Para resposta de erro (status != 200, sem stream), resolve só depois do corpo inteiro.
 */
function conectarSSE(query) {
  return new Promise((resolve, reject) => {
    const eventos = [];
    let buffer = '';
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: `/api/eventos?abas=${query}` }, (res) => {
      if (res.statusCode !== 200) {
        let corpo = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { corpo += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(corpo); } catch { /* não é json */ }
          resolve({ status: res.statusCode, corpo: json ?? corpo, eventos, encerrar: () => req.destroy() });
        });
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const bloco = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const linha = bloco.split('\n').find((l) => l.startsWith('data: '));
          if (!linha) continue;
          try { eventos.push(JSON.parse(linha.slice(6))); } catch { /* ping ou lixo: ignora */ }
        }
      });
      resolve({ status: 200, eventos, encerrar: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

const doJob = (eventos, chave) => eventos.filter((e) => e.aba === chave).map((e) => e.evento);

// ─── G-J4 — término: a última fala aparece UMA vez só ──────────────────────────────────────

async function testeG_J4() {
  console.log('\n── G-J4 — término: escreve no log e marca done na mesma batida ──\n');
  escreverJob('j-termino', { status: linhaStatus('working', 'trabalhando'), log: linhaEvento('primeira fala') });

  const { status, eventos, encerrar } = await conectarSSE('job-j-termino');
  ok(status === 200, `G-J4: SSE conecta (status ${status})`);
  await espera(900);

  const dir = path.join(RAIZ_JOBS, 'j-termino');
  // "na mesma batida": a última fala e o `done` chegam ao disco juntos, ANTES de qualquer
  // tique dos relógios do servidor os ver.
  fs.appendFileSync(path.join(dir, 'claude.log'), linhaEvento('última fala do job'));
  fs.appendFileSync(path.join(dir, 'status.log'), linhaStatus('done', 'entregue'));

  // Duas batidas do relógio de estado (2 s) de folga, mais o de arquivo (700 ms).
  await espera(4500);
  encerrar();

  const meus = doJob(eventos, 'job-j-termino');
  const falas = meus.filter((e) => e.tipo === 'texto' && e.texto === 'última fala do job');
  ok(falas.length === 1, `G-J4: a última fala aparece EXATAMENTE uma vez (veio ${falas.length})`);
  const estados = meus.filter((e) => e.tipo === 'job_estado');
  ok(estados.length === 1 && estados[0].job.estado === 'done', `G-J4: um job_estado só, com estado done (veio ${JSON.stringify(estados.map((e) => e.job.estado))})`);
  const sincronizados = meus.filter((e) => e.tipo === 'sincronizado');
  ok(sincronizados.length >= 2 && sincronizados[sincronizados.length - 1].turnoEmAndamento === false,
    'G-J4: o último sincronizado diz turnoEmAndamento: false');
  // Ordem: job_estado tem de vir DEPOIS da última fala, e sincronizado(false) depois do job_estado.
  const idxFala = meus.indexOf(falas[0]);
  const idxEstado = meus.indexOf(estados[0]);
  const idxSincFinal = meus.lastIndexOf(sincronizados[sincronizados.length - 1]);
  ok(idxFala < idxEstado && idxEstado < idxSincFinal,
    `G-J4: ordem fala(${idxFala}) < job_estado(${idxEstado}) < sincronizado-final(${idxSincFinal})`);
}

// ─── G-J24 — a vida do job CONTINUA depois do término ──────────────────────────────────────
//
// Achado do painel de execução (12/09): a primeira versão marcava `terminando = true` e nunca
// revertia, então `done → merged → teardown` sumia da tela — e um job que JÁ nascia terminado
// nunca chegava a processar término nenhum (não há MUDANÇA para detectar), deixando o relógio
// de arquivo lendo 0 byte para sempre. Este caso prova os dois consertos de uma vez.

async function testeG_J24() {
  console.log('\n── G-J24 — job que abre JÁ terminado, e transição depois do término ──\n');
  escreverJob('j-pos-termino', {
    status: `${linhaStatus('working', 'trabalhando')}${linhaStatus('done', 'entregue')}`,
    log: linhaEvento('a fala que fechou o job'),
  });

  const { status, eventos, encerrar } = await conectarSSE('job-j-pos-termino');
  ok(status === 200, `G-J24: SSE conecta (status ${status})`);
  await espera(900);

  const abertura = doJob(eventos, 'job-j-pos-termino');
  const sessao = abertura.find((e) => e.tipo === 'sessao');
  ok(sessao?.meta?.job?.estado === 'done', `G-J24a: abre JÁ com o estado done no sessao (veio ${sessao?.meta?.job?.estado})`);
  ok(abertura.some((e) => e.tipo === 'texto' && e.texto === 'a fala que fechou o job'), 'G-J24a: e com a conversa inteira na fita');

  // Agora o job é mergeado — transição DEPOIS de um estado terminal. `merged` NÃO sai do
  // `status.log`: quem o produz é o `merged_at` do `meta.json` (`lib/jobs.js:213`), que é
  // como o orquestrador de verdade registra o merge. Escrever `merged:` no log daria
  // `unknown` — o cenário tem de ser fiel à fonte, senão o assert prova outra coisa.
  const metaPath = path.join(RAIZ_JOBS, 'j-pos-termino', 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.merged_at = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  await espera(4500);
  encerrar();

  const meus = doJob(eventos, 'job-j-pos-termino');
  const estados = meus.filter((e) => e.tipo === 'job_estado');
  ok(estados.some((e) => e.job.estado === 'merged'),
    `G-J24b: done → merged CHEGA à tela depois do término (veio ${JSON.stringify(estados.map((e) => e.job.estado))})`);
  ok(!meus.some((e) => e.tipo === 'removida'), 'G-J24b: e nada de "removida" — a pasta continua no disco');
}

// ─── G-J5 — não emite `removida` por soluço da lista, só quando some do disco ──────────────

async function testeG_J5() {
  console.log('\n── G-J5 — job terminado ou fora da LISTA (mas com pasta) não emite removida ──\n');

  // (a) job já terminado: outras batidas repetindo o mesmo `done` não podem reabrir nada.
  escreverJob('j-terminado', { status: linhaStatus('done', 'entregue'), log: linhaEvento('fala única') });
  const a = await conectarSSE('job-j-terminado');
  await espera(4500);
  a.encerrar();
  const meusA = doJob(a.eventos, 'job-j-terminado');
  ok(!meusA.some((e) => e.tipo === 'removida'), 'G-J5a: job já terminado — nenhuma "removida" mesmo com o disco parado');

  // (b) job SOME da LISTA (meta.json corrompido faz `lib/jobs.js:lerJob` pular a pasta), mas
  // a PASTA continua no disco — `adaptadorJob.existe()` confirma e o fluxo NÃO fecha.
  const dirB = escreverJob('j-sumiu-da-lista', { status: linhaStatus('working', 'x'), log: linhaEvento('fala') });
  const b = await conectarSSE('job-j-sumiu-da-lista');
  await espera(900);
  fs.writeFileSync(path.join(dirB, 'meta.json'), '{ isto não é json');
  await espera(4500);
  b.encerrar();
  const meusB = doJob(b.eventos, 'job-j-sumiu-da-lista');
  ok(!meusB.some((e) => e.tipo === 'removida'), 'G-J5b: some da LISTA (meta quebrado) mas a pasta existe — nenhuma "removida"');

  // (c) contraprova: a pasta INTEIRA some do disco — aí sim é "removida".
  const dirC = escreverJob('j-removido-de-verdade', { status: linhaStatus('working', 'x'), log: linhaEvento('fala') });
  const c = await conectarSSE('job-j-removido-de-verdade');
  await espera(900);
  fs.rmSync(dirC, { recursive: true, force: true });
  await espera(4500);
  c.encerrar();
  const meusC = doJob(c.eventos, 'job-j-removido-de-verdade');
  ok(meusC.some((e) => e.tipo === 'removida'), 'G-J5c (contraprova): pasta removida de verdade ⇒ "removida" aparece');
}

// ─── G-J6 — done × failed × blocked, com textos diferentes ─────────────────────────────────

async function testeG_J6() {
  console.log('\n── G-J6 — done × failed × blocked produzem job_estado com textos diferentes ──\n');
  escreverJob('j-vai-done', { status: linhaStatus('working', 'x'), log: linhaEvento('fala') });
  escreverJob('j-vai-failed', { status: linhaStatus('working', 'x'), log: linhaEvento('fala') });
  escreverJob('j-vai-blocked', { status: linhaStatus('working', 'x'), log: linhaEvento('fala') });

  const { eventos, encerrar } = await conectarSSE('job-j-vai-done,job-j-vai-failed,job-j-vai-blocked');
  await espera(900);

  fs.appendFileSync(path.join(RAIZ_JOBS, 'j-vai-done', 'status.log'), linhaStatus('done', 'entregue com sucesso'));
  fs.appendFileSync(path.join(RAIZ_JOBS, 'j-vai-failed', 'status.log'), linhaStatus('failed', 'os testes reprovaram'));
  fs.appendFileSync(path.join(RAIZ_JOBS, 'j-vai-blocked', 'status.log'), linhaStatus('blocked', 'teardown recusado: job não merged'));

  await espera(4500);
  encerrar();

  const estadoDe = (chave) => doJob(eventos, chave).find((e) => e.tipo === 'job_estado');
  const done = estadoDe('job-j-vai-done');
  const failed = estadoDe('job-j-vai-failed');
  const blocked = estadoDe('job-j-vai-blocked');

  ok(Boolean(done) && done.job.estado === 'done' && done.job.desfecho === 'entregue com sucesso',
    `G-J6: done com desfecho próprio (veio ${JSON.stringify(done && done.job)})`);
  ok(Boolean(failed) && failed.job.estado === 'failed' && failed.job.desfecho === 'os testes reprovaram',
    `G-J6: failed com desfecho próprio (veio ${JSON.stringify(failed && failed.job)})`);
  ok(Boolean(blocked) && blocked.job.estado === 'blocked' && blocked.job.desfecho === 'teardown recusado: job não merged',
    `G-J6: blocked TRAZ O MOTIVO no desfecho (veio ${JSON.stringify(blocked && blocked.job)})`);
  ok(new Set([done.job.desfecho, failed.job.desfecho, blocked.job.desfecho]).size === 3,
    'G-J6: os três textos são DIFERENTES entre si');
}

// ─── Contexto do job (card `contexto-da-sessao-do-job`, 22/09) — G-a, G-b, G-c, G-f, G11 ────

async function testeG_a() {
  console.log('\n── G-a — job vivo: sai um contexto na abertura, com usados > 0 ──\n');
  escreverJob('j-ctx-abertura', {
    status: linhaStatus('working', 'trabalhando'),
    log: linhaEventoComUso('primeira fala com usage', 12000),
  });
  const { status, eventos, encerrar } = await conectarSSE('job-j-ctx-abertura');
  ok(status === 200, `G-a: SSE conecta (status ${status})`);
  await espera(900);
  encerrar();
  const meus = doJob(eventos, 'job-j-ctx-abertura');
  const contextos = meus.filter((e) => e.tipo === 'contexto');
  ok(contextos.length >= 1 && contextos[0].contexto.usados === 12000,
    `G-a: sai um contexto na abertura, com usados > 0 (vieram ${JSON.stringify(contextos.map((c) => c.contexto && c.contexto.usados))})`);
}

async function testeG_b() {
  console.log('\n── G-b — dedupe: o mesmo valor de contexto não é emitido duas vezes ──\n');
  escreverJob('j-ctx-dedupe', {
    status: linhaStatus('working', 'trabalhando'),
    log: linhaEventoComUso('fala com usage', 8000),
  });
  const { eventos, encerrar } = await conectarSSE('job-j-ctx-dedupe');
  await espera(900);
  // Nada muda no log — o relógio de 700 ms bate de novo sem `usage` novo. Só o contexto da
  // abertura deveria ter saído.
  await espera(2500);
  encerrar();
  const meus = doJob(eventos, 'job-j-ctx-dedupe');
  const contextos = meus.filter((e) => e.tipo === 'contexto');
  ok(contextos.length === 1, `G-b: um contexto só, mesmo com várias batidas do relógio (vieram ${contextos.length})`);
}

async function testeG_c() {
  console.log('\n── G-c — a fresta: doArquivo (abertura) não depende de onde a leitura INICIAL parou ──\n');
  // A leitura INICIAL (sem `contexto`, `server.js:751`) para em `ALVO_MENSAGENS` (80) eventos,
  // contando os dois lados. Fabrica-se um log com um principal ANTIGO (dentro do alcance da
  // cauda de 80) seguido de mais de 80 eventos de enchimento, e um principal NOVO no fim — fora
  // do alcance da cauda por CONTAGEM. Se o medidor da abertura dependesse de `lido` (onde a
  // leitura inicial parou), mostraria o valor ANTIGO. `doArquivo` é uma varredura FRESCA, do
  // FIM do arquivo para trás, e tem de achar o NOVO — é o que fecha a fresta que o Codex
  // reproduziu (spec §4.2, R3).
  let logFresta = linhaEventoComUso('fala antiga, com usage antigo', 5000);
  for (let i = 0; i < 90; i += 1) logFresta += linhaEvento(`enchimento ${i}`);
  logFresta += linhaEventoComUso('fala nova, com usage novo', 77000);
  escreverJob('j-ctx-fresta', { status: linhaStatus('working', 'trabalhando'), log: logFresta });

  const { eventos, encerrar } = await conectarSSE('job-j-ctx-fresta');
  await espera(900);
  encerrar();
  const meus = doJob(eventos, 'job-j-ctx-fresta');
  const contextos = meus.filter((e) => e.tipo === 'contexto');
  ok(contextos.length >= 1 && contextos[0].contexto.usados === 77000,
    `G-c: o contexto da abertura é o do PRINCIPAL NOVO (fim do arquivo), não o antigo dentro da cauda de 80 (vieram ${JSON.stringify(contextos.map((c) => c.contexto && c.contexto.usados))})`);
}

async function testeG_f() {
  console.log('\n── G-f — job já done ao abrir: emite o contexto da abertura e NENHUM depois (D4) ──\n');
  escreverJob('j-ctx-done', {
    status: linhaStatus('done', 'entregue'),
    log: linhaEventoComUso('fala única, já terminado', 30000),
  });
  const { eventos, encerrar } = await conectarSSE('job-j-ctx-done');
  await espera(900);
  const abertura = doJob(eventos, 'job-j-ctx-done');
  const contextosAbertura = abertura.filter((e) => e.tipo === 'contexto');
  ok(contextosAbertura.length === 1 && contextosAbertura[0].contexto.usados === 30000,
    `G-f: job já done ao abrir emite o contexto na abertura (vieram ${JSON.stringify(contextosAbertura.map((c) => c.contexto && c.contexto.usados))})`);
  await espera(4500);
  encerrar();
  const meus = doJob(eventos, 'job-j-ctx-done');
  const contextosTotais = meus.filter((e) => e.tipo === 'contexto');
  ok(contextosTotais.length === 1, `G-f: e NENHUM contexto depois — o relógio de arquivo nem chega a nascer (vieram ${contextosTotais.length} ao todo)`);
}

async function testeG11() {
  console.log('\n── G11 — a leitura FINAL do término mede (R2), não o penúltimo trecho ──\n');
  escreverJob('j-ctx-final', {
    status: linhaStatus('working', 'trabalhando'),
    log: linhaEventoComUso('fala inicial, com usage inicial', 4000),
  });
  const { eventos, encerrar } = await conectarSSE('job-j-ctx-final');

  // A JANELA que faz a barreira ficar no lugar certo (achado do Codex — "escrever depois do
  // job_estado" não funciona; a barreira fica ENTRE parar o relógio e a leitura final). O
  // relógio de ARQUIVO bate em ~700/1400/2100 ms; o de ESTADO (o cano SSE, `server.js:1347`)
  // bate em ~2000/4000 ms. Escrevendo ENTRE a batida de arquivo de 1400 ms e a de estado de
  // 2000 ms: quando o relógio de estado notar o `done` (em ~2000 ms) e chamar
  // `clearInterval(relogioArquivo)` SÍNCRONO, a próxima batida de arquivo (~2100 ms) nunca
  // chega a rodar — só a leitura FINAL pode ter visto os bytes novos. Sincronização
  // determinística pela ARITMÉTICA dos dois relógios, não por sorte de `sleep`.
  await espera(1600);

  const dir = path.join(RAIZ_JOBS, 'j-ctx-final');
  // Um `usados` ÚNICO: escrito e o `done` marcado na MESMA rajada síncrona (mesma técnica de
  // G-J4, linha ~143) — os dois chegam ao disco juntos, dentro da janela acima.
  fs.appendFileSync(path.join(dir, 'claude.log'), linhaEventoComUso('fala final, com usage final', 99999));
  fs.appendFileSync(path.join(dir, 'status.log'), linhaStatus('done', 'entregue'));

  await espera(3000); // a batida de estado de ~2000 ms + a leitura final + a emissão
  encerrar();

  const meus = doJob(eventos, 'job-j-ctx-final');
  const contextos = meus.filter((e) => e.tipo === 'contexto');
  const ultimo = contextos[contextos.length - 1];
  ok(Boolean(ultimo) && ultimo.contexto.usados === 99999,
    `G11: o ÚLTIMO contexto emitido é o do FIM do log — a leitura final mediu (vieram ${JSON.stringify(contextos.map((c) => c.contexto && c.contexto.usados))})`);
  const estados = meus.filter((e) => e.tipo === 'job_estado');
  ok(estados.some((e) => e.job.estado === 'done'), 'G11 (pré-condição): o job chegou a done');
}

/**
 * G-i — o job que TERMINA antes de o relógio conseguir medir ainda mostra o número.
 *
 * O caso que o painel de execução REPRODUZIU e que o código não cobria: o `claude.log` nasce
 * vazio, o principal chega escondido atrás de uma rajada de subagente (mais que
 * `ALVO_MENSAGENS`, então a cauda por contagem do ramo inicial não o alcança) e o job termina
 * ANTES da primeira batida útil do relógio de arquivo. Nesse ponto o `relogioArquivo` JÁ foi
 * parado pelo término, então a rede de `TENTATIVAS_DE_ABERTURA` não roda mais nunca — e o
 * número existia no arquivo o tempo todo.
 *
 * A última chance é o `doArquivo` dentro do término (`server.js`, no `primeiroTermino`), que
 * não tem a régua de contagem. Sem ele este teste fica vermelho.
 */
async function testeG_i() {
  console.log('\n── G-i — job que termina antes de o relógio medir AINDA mostra o número ──\n');
  // Nasce VAZIO: é o que faz `lido` ficar 0 e a leitura seguinte cair no ramo INICIAL.
  escreverJob('j-ctx-corrida', { status: linhaStatus('working', 'trabalhando'), log: '' });
  const { eventos, encerrar } = await conectarSSE('job-j-ctx-corrida');

  const dir = path.join(RAIZ_JOBS, 'j-ctx-corrida');
  // O principal PRIMEIRO, depois a rajada que o esconde. 200 eventos de subagente passam de
  // `ALVO_MENSAGENS` (80) com folga: a cauda por contagem para antes de chegar ao principal.
  let bloco = linhaEventoComUso('o principal falou uma vez só', 12345);
  for (let i = 0; i < 200; i += 1) {
    bloco += `${JSON.stringify({
      type: 'assistant', parent_tool_use_id: 'toolu_rajada', subagent_type: 'executor-plano',
      message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `passo ${i} do subagente` }],
        usage: { input_tokens: 500000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      timestamp: new Date().toISOString(),
    })}\n`;
  }
  // Log e `done` na MESMA rajada síncrona: os dois chegam ao disco juntos, e o término vem
  // pela batida do relógio de ESTADO (~2000 ms) — antes de qualquer batida útil do de arquivo.
  fs.appendFileSync(path.join(dir, 'claude.log'), bloco);
  fs.appendFileSync(path.join(dir, 'status.log'), linhaStatus('done', 'entregue'));

  await espera(4000);
  encerrar();

  const meus = doJob(eventos, 'job-j-ctx-corrida');
  const contextos = meus.filter((e) => e.tipo === 'contexto');
  const valores = contextos.map((c) => c.contexto && c.contexto.usados);
  ok(valores.includes(12345),
    `G-i: o número do PRINCIPAL (12.345) chegou à tela mesmo com o job terminando antes da medição (vieram ${JSON.stringify(valores)})`);
  // E a outra metade: em nenhum momento saiu o número do subagente (500.000), que está no
  // fim do arquivo e é o que uma leitura sem separação pegaria.
  ok(!valores.includes(500000),
    `G-i: e NUNCA saiu o 500.000 do subagente, que é o último do arquivo (vieram ${JSON.stringify(valores)})`);
  ok(meus.some((e) => e.tipo === 'job_estado' && e.job.estado === 'done'), 'G-i (pré-condição): o job chegou a done');
}

// ─── G-J2b — o namespace de chave não abre porta para leitura fora da pasta ────────────────

async function testeG_J2b() {
  console.log('\n── G-J2b — ?abas=job-../../etc nunca lê arquivo fora da pasta ──\n');
  const { status, corpo } = await conectarSSE('job-..%2F..%2Fetc');
  ok(status === 400, `G-J2b: chave com "../" ⇒ 400 (veio ${status}, corpo ${JSON.stringify(corpo)})`);
}

// ─── Subida e queda do servidor ─────────────────────────────────────────────────────────────

let filho = null;

function subirServidor() {
  return new Promise((resolve, reject) => {
    filho = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORTA), HOST: '127.0.0.1', COCKPIT_CERT_DIR: CERT_DIR_VAZIO, COCKPIT_TOKEN: '',
        COCKPIT_JOBS_DIR: RAIZ_JOBS, COCKPIT_TMUX_SOCKET: SOCKET_TMUX, COCKPIT_VIGIA_MS: '0',
        COCKPIT_MONITOR_MS: '0', // o amostrador do monitor escreve desde o boot (#82)
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saiu = false;
    filho.once('exit', (codigo) => {
      if (!saiu) reject(new Error(`server.js caiu antes de subir (código ${codigo})`));
    });
    filho.stdout.on('data', (d) => {
      if (!saiu && String(d).includes('cockpit-agentes em')) { saiu = true; resolve(); }
    });
    filho.stderr.on('data', (d) => process.stderr.write(`[server.js] ${d}`));
    // Rede de segurança: se o `console.log` não bater (mudou de texto), sobe mesmo assim
    // depois de um tempo — a checagem HTTP em cada teste denuncia se não subiu de verdade.
    setTimeout(() => { if (!saiu) { saiu = true; resolve(); } }, 2500);
  });
}

function derrubarServidor() {
  if (filho && !filho.killed) filho.kill('SIGTERM'); // pelo PID — nunca pkill (#19)
}

async function principal() {
  try {
    await subirServidor();
    await testeG_J4();
    await testeG_J24();
    await testeG_J5();
    await testeG_J6();
    await testeG_a();
    await testeG_b();
    await testeG_c();
    await testeG_f();
    await testeG11();
    await testeG_i();
    await testeG_J2b();
  } finally {
    derrubarServidor();
    fs.rmSync(RAIZ_JOBS, { recursive: true, force: true });
    fs.rmSync(CERT_DIR_VAZIO, { recursive: true, force: true });
  }
  console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — server.js: o job como fonte do fluxo\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.error('🔴 o gate estourou —', e);
  derrubarServidor();
  process.exit(1);
});
