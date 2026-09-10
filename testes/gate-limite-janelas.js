#!/usr/bin/env node
'use strict';
// GATE do medidor de sessão de graça — card `medidor-de-sessao-de-graca`.
//
// NÃO GASTA TOKEN DA ASSINATURA (armadilha #20). Diferente de `gate-fase-2.js` e
// `gate-fase-3.js` — que importam `traduzir`/rodam sessão de verdade e por isso custam —,
// este gate só lê fixtures escritas em `/tmp/gate-limite-<pid>/` e, na parte `rota`, espia
// `child_process.execFile` (nunca deixa passar uma chamada real a `claude`).
//
// Três blocos, cada um rodável isolado:
//   node testes/gate-limite-janelas.js           # tudo
//   node testes/gate-limite-janelas.js puro      # só os casos 1-9  (janelasDoLimite)
//   node testes/gate-limite-janelas.js disco     # só os casos 10-21 (dasJanelas)
//   node testes/gate-limite-janelas.js rota      # só os casos 22-27 (servidor + espião)
//
// Os 27 casos abaixo cobrem parsing, leitura do disco e a rota HTTP.
//
// IMPORTANTE — modo interno, não chame direto: `node testes/gate-limite-janelas.js
// rota-filho` é o SUBPROCESSO que a parte `rota` usa para isolar HOME/COCKPIT_JOBS_DIR e
// espiar o `execFile` sem tocar em `~/.cockpit` nem `~/.cockpit/jobs` de verdade (§3.2 do
// plano). Por isso o guard abaixo vem ANTES de qualquer require de lib/limite ou
// lib/adaptador-claude: espião instalado DEPOIS do require não pega (o `require('node:
// child_process')` de lib/limite já teria destruturado o `execFile` de verdade).
const MODO_FILHO = process.argv[2] === 'rota-filho';
if (MODO_FILHO) rodarFilhoDaRota();
// O `main()` só é chamado no FIM do arquivo (depois de `const CASOS`, `PASTA` etc. — todos
// declarados mais abaixo): chamar aqui em cima estouraria "Cannot access before
// initialization" no modo normal, e no modo filho ele nem deve rodar.

function rodarFilhoDaRota() {
  const fs = require('node:fs');
  const path = require('node:path');
  const cp = require('node:child_process');

  const registro = process.env.GATE_REGISTRO_CHAMADAS;
  const falharUsage = process.env.GATE_FALHAR_USAGE === '1';

  // 1) instalar o espião — ANTES de qualquer require de lib/limite (direto ou via server.js).
  cp.execFile = (bin, args, opts, cb) => {
    const pronto = cb || opts;
    // Só o `claude` é o que os casos 22-27 espiam (o turno de verdade). `lib/abas.js`
    // também passa por `execFile` (tmux, para o consumo do Codex) — deixar isso passar
    // sem registrar evita contar "chamada a claude" onde não houve nenhuma.
    if (bin !== 'claude') return pronto(null, '', '');
    fs.appendFileSync(registro, `${JSON.stringify({ bin, args })}\n`);
    if (falharUsage) return pronto(new Error('simulado: /usage indisponível'), '', 'erro simulado');
    return pronto(null, 'Current session: 42% used · resets Aug 20, 5:20pm (UTC)\n', '');
  };

  // 2) limpar qualquer cache (defensivo — processo nasce limpo, mas o desenho de
  //    `comEspiao` de testes/gate-ui.js:431-458 faz isso, e reusar o desenho é o pedido).
  try { delete require.cache[require.resolve('../lib/limite')]; } catch { /* ainda não requerido */ }

  // Um cenário de jobs válido, se o pai pediu (a fixture do "cache frio"/"forcar"/"quente").
  // Cenários que precisam de pasta INVÁLIDA (caso 26) simplesmente não setam isto — a pasta
  // não existe ou é um arquivo, e o `readdir` de dentro de `dasJanelas` falha sozinho.
  if (process.env.GATE_FIXTURA_JOBS === '1') {
    const dirJobs = process.env.COCKPIT_JOBS_DIR;
    const dir = path.join(dirJobs, 'job-rota');
    fs.mkdirSync(dir, { recursive: true });
    const agoraSeg = Math.floor(Date.now() / 1000);
    const infoEvento = {
      status: 'allowed',
      resetsAt: agoraSeg + 3600 * 5,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.33, resetsAt: agoraSeg + 3600 * 5 },
        seven_day: { utilization: 0.2, resetsAt: agoraSeg + 3600 * 24 * 7 },
      },
    };
    const linhas = [
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: infoEvento }),
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [] } }),
    ];
    fs.writeFileSync(path.join(dir, 'claude.log'), `${linhas.join('\n')}\n`);
  }

  // A ponte pro pai pular o relógio adiante sem esperar os 5 min de TTL_MS de verdade
  // (caso 25 — cache expirado). Só afeta ESTE processo filho, nunca lib/limite.js.
  process.on('SIGUSR2', () => {
    const original = Date.now;
    const deslocamento = 6 * 60_000; // > TTL_MS (5 min)
    Date.now = () => original() + deslocamento;
  });

  // 3) só agora — server.js já sobe ouvindo, com o execFile mockado e o HOME isolado.
  require('../server');
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// A partir daqui só roda no processo PAI (nunca no `rota-filho`, que já retornou acima).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const adaptador = require('../lib/adaptador-claude');
const limite = require('../lib/limite');

const PASTA = path.join(os.tmpdir(), `gate-limite-${process.pid}`);
// O `rota-filho` chega até aqui (require('../server') dentro de rodarFilhoDaRota() retorna
// assim que o `.listen()` registra o socket — não bloqueia). Sem este guard, CADA filho
// criaria e "esqueceria" a sua PRÓPRIA pasta vazia em /tmp a cada chamada de subirFilho().
if (!MODO_FILHO) {
  fs.mkdirSync(PASTA, { recursive: true });
  process.on('exit', () => { try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* melhor esforço */ } });
}

let passou = 0;
let total = 0;
let vermelho = false;
const CASOS = new Set();
const CASOS_ESPERADOS = Array.from({ length: 27 }, (_, i) => String(i + 1));

function ok(condicao, mensagem) {
  total += 1;
  if (condicao) { passou += 1; console.log(`  ✅ ${mensagem}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${mensagem}`);
  return false;
}
function titulo(t) {
  // A maioria dos blocos é "N. ...", mas o 22-25 é um range só (os quatro precisam do MESMO
  // subprocesso, na mesma ordem) — por isso o regex também aceita "N-M.".
  const m = /^(\d+)(?:-(\d+))?\./.exec(t);
  if (m) {
    const de = Number(m[1]);
    const ate = m[2] ? Number(m[2]) : de;
    for (let n = de; n <= ate; n++) CASOS.add(String(n));
  }
  console.log(`\n${t}`);
}
async function bloco(nome, fn) {
  titulo(nome);
  try {
    await fn();
  } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.message}`);
    if (e && e.stack) console.log(`     ${e.stack.split('\n').slice(1, 3).join('\n     ')}`);
  }
}

// ─── as 4 formas reais de §1.1 da spec, medidas em ~/.cockpit/jobs/*/claude.log (2026-09-08) ─

/** `five_hour` + `seven_day` — 824 das 1.236 amostras reais. */
const FORMA_5H_7D = {
  five_hour: { utilization: 0.18, resetsAt: 0 }, // resetsAt é preenchido por evento() por caso
  seven_day: { utilization: 0.15, resetsAt: 0 },
};
/** As três juntas — 341 amostras reais. */
const FORMA_TRES = {
  five_hour: { utilization: 0.4, resetsAt: 0 },
  seven_day: { utilization: 0.22, resetsAt: 0 },
  seven_day_overage_included: { utilization: 0.05, resetsAt: 0 },
};
/** `seven_day` + `seven_day_overage_included`, SEM `five_hour` — 1 amostra real. */
const FORMA_SEM_5H = {
  seven_day: { utilization: 0.6, resetsAt: 0 },
  seven_day_overage_included: { utilization: 0.1, resetsAt: 0 },
};
// A 4ª forma (70 amostras) é a AUSÊNCIA de `unifiedWindows` — não precisa de constante.

/**
 * Um `rate_limit_info` completo, na forma exata de §1.1 da spec. `unifiedWindows` recebe
 * `resetsAt` relativo a `agora` (futuro, por padrão) para os testes não apodrecerem com o
 * calendário. Nunca montar o JSON à mão dentro de um caso — é para isso que isto existe.
 */
function evento(unifiedWindows, { agora = Date.now(), futuro = true, extras = {} } = {}) {
  const info = {
    status: 'allowed',
    resetsAt: Math.floor(agora / 1000) + 3600 * 5,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
    ...extras,
  };
  if (unifiedWindows !== undefined) {
    const agoraSeg = Math.floor(agora / 1000);
    const clonado = {};
    // Sentinelas de teste: `resetsAt: 0` (ou a chave ausente) = "auto-preenche no futuro" —
    // é o atalho que a maioria dos casos usa. `resetsAt: null` = "campo REALMENTE ausente",
    // para os poucos casos (7) que testam justo essa ausência.
    for (const [chave, janela] of Object.entries(unifiedWindows)) {
      const copia = { ...janela };
      if (janela.resetsAt === null) {
        delete copia.resetsAt;
      } else if (!('resetsAt' in janela) || janela.resetsAt === 0) {
        copia.resetsAt = agoraSeg + (futuro ? 3600 * 5 : -3600);
      }
      clonado[chave] = copia;
    }
    info.unifiedWindows = clonado;
  }
  return info;
}

async function main() {
  const parte = process.argv[2];
  if (!parte || parte === 'puro') await rodarPuro();
  if (!parte || parte === 'disco') await rodarDisco();
  if (!parte || parte === 'rota') await rodarRota();

  if (!parte) {
    const faltando = CASOS_ESPERADOS.filter((c) => !CASOS.has(c));
    if (faltando.length) {
      vermelho = true;
      console.log(`\n❌ casos que NÃO rodaram: ${faltando.join(', ')}`);
    }
  }

  console.log(`\n${passou}/${total} passaram.`);
  process.exit(vermelho ? 1 : 0);
}

// ════════════════════════════════════════════════════════════════════════════════════════
// PURO — casos 1-9: lib/adaptador-claude.js:janelasDoLimite
// ════════════════════════════════════════════════════════════════════════════════════════

async function rodarPuro() {
  await bloco('1. five_hour + seven_day (824 amostras) — 2 itens, na ordem', () => {
    const itens = adaptador.janelasDoLimite(evento(FORMA_5H_7D));
    ok(Array.isArray(itens) && itens.length === 2, `2 itens (${JSON.stringify(itens)})`);
    ok(itens?.[0]?.rotulo === 'Sessão (5h)' && itens?.[1]?.rotulo === 'Semana (tudo)',
      `ordem five_hour → seven_day (${itens?.map((i) => i.rotulo)})`);
  });

  await bloco('2. as três juntas (341 amostras) — 3 itens, overage por último', () => {
    const itens = adaptador.janelasDoLimite(evento(FORMA_TRES));
    ok(itens?.length === 3, `3 itens (${JSON.stringify(itens?.map((i) => i.rotulo))})`);
    ok(itens?.[2]?.rotulo === 'Semana (com extra)', `overage por último (${itens?.[2]?.rotulo})`);
  });

  await bloco('3. sem five_hour (1 amostra real) — nenhum item inventado (D-c)', () => {
    const itens = adaptador.janelasDoLimite(evento(FORMA_SEM_5H));
    ok(itens?.length === 2, `2 itens, nunca 3 (${JSON.stringify(itens?.map((i) => i.rotulo))})`);
    ok(!itens?.some((i) => i.rotulo === 'Sessão (5h)'), 'e nenhum deles é "Sessão (5h)" inventada');
  });

  await bloco('4. sem unifiedWindows (70 amostras) — null, NUNCA [] (D-b)', () => {
    const semJanelas = adaptador.janelasDoLimite(evento(undefined));
    ok(semJanelas === null, `null (veio ${JSON.stringify(semJanelas)})`);
    const semInfo = adaptador.janelasDoLimite({});
    ok(semInfo === null, `null também com info vazio (veio ${JSON.stringify(semInfo)})`);
  });

  await bloco('5. utilization inválida — item descartado; todos inválidos ⇒ null (D-d)', () => {
    // 🔴 `null`, `''` e `false` viram **0** no `Number()`, e `true` vira **1**. Sem a checagem
    // de `typeof`, os quatro passariam pelo `Number.isFinite` e desenhariam "0%" (janela vazia
    // que não está) ou "100%" (alarme falso). Achado do painel de execução, que os reproduziu.
    for (const bad of [-0.1, 1.5, '18', undefined, null, '', false, true, '0.5', NaN, {}]) {
      const uw = {
        five_hour: { utilization: bad, resetsAt: 0 },
        seven_day: { utilization: 0.5, resetsAt: 0 },
      };
      const itens = adaptador.janelasDoLimite(evento(uw));
      ok(itens?.length === 1 && itens[0].rotulo === 'Semana (tudo)',
        `utilization=${JSON.stringify(bad)} descarta só a janela ruim (${JSON.stringify(itens)})`);
    }
    const todasRuins = adaptador.janelasDoLimite(evento({ five_hour: { utilization: -1, resetsAt: 0 } }));
    ok(todasRuins === null, `todas inválidas ⇒ null (veio ${JSON.stringify(todasRuins)})`);
  });

  await bloco('6. usado = round(utilization*100), sem casa decimal (D-d)', () => {
    const i1 = adaptador.janelasDoLimite(evento({ five_hour: { utilization: 0.18, resetsAt: 0 } }));
    ok(i1?.[0]?.usado === 18, `0.18 ⇒ 18 (veio ${i1?.[0]?.usado})`);
    const i2 = adaptador.janelasDoLimite(evento({ five_hour: { utilization: 0.005, resetsAt: 0 } }));
    ok(i2?.[0]?.usado === 1, `0.005 ⇒ 1, nunca 0.5 (veio ${i2?.[0]?.usado})`);
  });

  await bloco('7. resetaEm = resetsAt*1000, sempre > 1e12, nunca 1970', () => {
    const agora = 0; // agora=0 isola este caso da regra de "janela já resetada" (caso 8)
    const info = evento({ five_hour: { utilization: 0.1, resetsAt: 1788807600 } }, { agora, futuro: false });
    const itens = adaptador.janelasDoLimite(info, agora);
    ok(itens?.[0]?.resetaEm === 1788807600000, `1788807600 ⇒ 1788807600000 (veio ${itens?.[0]?.resetaEm})`);
    ok(itens?.[0]?.resetaEm > 1e12, 'e é > 1e12, nunca uma data de 1970');
    const semReset = adaptador.janelasDoLimite(evento({ five_hour: { utilization: 0.1, resetsAt: null } }), agora);
    ok(semReset?.[0]?.resetaEm === null, `resetsAt ausente ⇒ resetaEm null (veio ${semReset?.[0]?.resetaEm})`);
  });

  await bloco('8. 🔴 janela já resetada ⇒ item DESCARTADO (P4)', () => {
    const agora = Date.now();
    const passado = Math.floor(agora / 1000) - 3600;
    const uw = {
      five_hour: { utilization: 0.87, resetsAt: passado },
      seven_day: { utilization: 0.3, resetsAt: Math.floor(agora / 1000) + 3600 },
    };
    const info = evento(uw, { agora });
    // evento() só sobrescreve resetsAt quando ausente ou 0 — aqui os dois já vêm com valor.
    const itens = adaptador.janelasDoLimite(info, agora);
    ok(itens?.length === 1 && itens[0].rotulo === 'Semana (tudo)',
      `só a janela ainda válida sobra (${JSON.stringify(itens)})`);
    const infoSoPassada = evento({ five_hour: { utilization: 0.87, resetsAt: passado } }, { agora });
    const soPassada = adaptador.janelasDoLimite(infoSoPassada, agora);
    ok(soPassada === null, `todas resetadas ⇒ null (veio ${JSON.stringify(soPassada)})`);
  });

  await bloco('9. 🔴 contrato: mesmas 4 chaves de lib/limite.js:analisar() (R3/P1)', () => {
    const itemJanela = adaptador.janelasDoLimite(evento(FORMA_5H_7D))[0];
    const itemUsage = limite.analisar('Current session: 25% used · resets Aug 20, 5:20pm (UTC)')[0];
    const chavesJanela = Object.keys(itemJanela).sort();
    const chavesUsage = Object.keys(itemUsage).sort();
    ok(JSON.stringify(chavesJanela) === JSON.stringify(chavesUsage),
      `mesmo conjunto de chaves (${chavesJanela} vs ${chavesUsage})`);
    ok('reseta' in itemJanela && itemJanela.reseta === null, 'e `reseta` é null EXPLÍCITO, não undefined');
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════
// DISCO — casos 10-21: lib/limite.js:dasJanelas / eventoDoLog
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * Escreve um claude.log de mentira em `<dirJobs>/<id>/claude.log` — o helper que torna os
 * casos 10-18 possíveis sem tocar em `~/.cockpit/jobs`. `mtime` crava a hora do arquivo via
 * `utimes`. `linhas` é a lista de linhas NDJSON da mais ANTIGA para a mais NOVA: string
 * pronta (ruído incluso, não precisa ser JSON válido) ou objeto (vira JSON.stringify).
 * `ultimaLinhaCrua`, se definida, é anexada ao final SEM newline — simula o arquivo sendo
 * escrito no meio de uma linha (caso 13).
 */
function logFalso(dirJobs, id, { linhas = [], ultimaLinhaCrua, mtime } = {}) {
  const dir = path.join(dirJobs, id);
  fs.mkdirSync(dir, { recursive: true });
  const caminho = path.join(dir, 'claude.log');
  let texto = linhas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  if (linhas.length) texto += '\n';
  if (ultimaLinhaCrua !== undefined) texto += ultimaLinhaCrua;
  fs.writeFileSync(caminho, texto);
  if (mtime !== undefined) {
    const t = new Date(mtime);
    fs.utimesSync(caminho, t, t);
  }
  return caminho;
}

function novaJobsDir() {
  return fs.mkdtempSync(path.join(PASTA, 'jobs-'));
}

/** Uma linha `assistant` com timestamp — o que dá a hora aproximada ao evento vizinho. */
function linhaComTimestamp(iso) {
  return { type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: 'ok' }] } };
}

/**
 * Log com o evento a `distanciaAteInicioDoEvento` bytes do FIM do arquivo. Usado nos casos
 * 10-12 (teto de 256 KB e a emenda entre blocos de 64 KB) — o número é a única coisa que
 * varia entre eles.
 */
function fixturaDistancia(dirJobs, id, distanciaAteInicioDoEvento, { agora = Date.now() } = {}) {
  const linhaEventoTxt = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: evento(FORMA_5H_7D, { agora }) });
  const linhaAposTxt = JSON.stringify(linhaComTimestamp(new Date(agora).toISOString()));
  const baseDepois = linhaEventoTxt.length + 1 + linhaAposTxt.length + 1;
  const faltamNoFim = Math.max(0, distanciaAteInicioDoEvento - baseDepois);
  const padFim = faltamNoFim > 0 ? 'x'.repeat(faltamNoFim) : '';
  const padAntes = 'z'.repeat(8192); // volume antes do evento — não afeta a distância medida
  const linhas = [padAntes, linhaEventoTxt, linhaAposTxt];
  if (padFim) linhas.push(padFim);
  return logFalso(dirJobs, id, { linhas, mtime: agora });
}

async function rodarDisco() {
  await bloco('10. fixture com o evento a 250 KB do fim ⇒ acha (teto de 256 KB)', async () => {
    const dir = novaJobsDir();
    fixturaDistancia(dir, 'job-10', 250 * 1024);
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas();
    ok(r !== null && Array.isArray(r.itens) && r.itens.length > 0,
      `achou o evento a 250 KB (veio ${JSON.stringify(r)})`);
  });

  await bloco('11. 🔴 fixture com o evento a 300 KB do fim ⇒ null (teto de VERDADE)', async () => {
    const dir = novaJobsDir();
    fixturaDistancia(dir, 'job-11', 300 * 1024);
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas();
    ok(r === null, `300 KB estoura o teto de 256 KB ⇒ null (veio ${JSON.stringify(r)})`);
  });

  await bloco('12. 🔴 linha do evento cortada na emenda entre blocos de 64 KB ⇒ lida inteira', async () => {
    const dir = novaJobsDir();
    // O boundary de bloco fica a 65536 B do fim. Com o evento começando a 65536+200 B do
    // fim (e tendo bem mais que 200 B de comprimento), o corte cai NO MEIO da linha — é
    // exatamente o caso que o `carry` existe para resolver (#11/R5).
    fixturaDistancia(dir, 'job-12', 65536 + 200);
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas();
    ok(r !== null && r.itens?.[0]?.usado === 18,
      `o evento sobrevive à emenda de blocos (veio ${JSON.stringify(r)})`);
  });

  await bloco('13. 🔴 última linha incompleta (arquivo sendo escrito) ⇒ pulada, sem derrubar', async () => {
    const dir = novaJobsDir();
    const agora = Date.now();
    logFalso(dir, 'job-13', {
      linhas: [
        { type: 'rate_limit_event', rate_limit_info: evento(FORMA_5H_7D, { agora }) },
        linhaComTimestamp(new Date(agora).toISOString()),
      ],
      ultimaLinhaCrua: '{"type":"user","message":{"content":[{"type":"text","text":"me',
      mtime: agora,
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas();
    ok(r !== null && Array.isArray(r.itens), `a linha pela metade não derruba a varredura (veio ${JSON.stringify(r)})`);
  });

  await bloco('14. linha não-JSON no meio (ruído de hook) ⇒ pulada (#8/#10)', async () => {
    const dir = novaJobsDir();
    const agora = Date.now();
    logFalso(dir, 'job-14', {
      linhas: [
        'isto não é JSON nenhum {{{ ruído de hook',
        { type: 'system', subtype: 'hook_started' },
        { type: 'rate_limit_event', rate_limit_info: evento(FORMA_5H_7D, { agora }) },
        'outra linha quebrada ]]] ainda ruído',
        linhaComTimestamp(new Date(agora).toISOString()),
      ],
      mtime: agora,
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas();
    ok(r !== null && Array.isArray(r.itens) && r.itens.length > 0,
      `acha o evento apesar do ruído em volta (veio ${JSON.stringify(r)})`);
  });

  await bloco('15. 🔴 dois logs: mtime MAIOR tem evento mais VELHO ⇒ ganha medidoEmAprox maior (P2)', async () => {
    const dir = novaJobsDir();
    const agora = Date.now();
    // job-A: tocado AGORA (mtime maior), mas a medição em si é de 3h atrás.
    logFalso(dir, 'job-A', {
      linhas: [
        { type: 'rate_limit_event', rate_limit_info: evento({ five_hour: { utilization: 0.11, resetsAt: 0 } }, { agora }) },
        linhaComTimestamp(new Date(agora - 3 * 3600_000).toISOString()),
      ],
      mtime: agora,
    });
    // job-B: tocado há 1h (mtime menor), mas a medição é de 10min atrás — mais NOVA que a de A.
    logFalso(dir, 'job-B', {
      linhas: [
        { type: 'rate_limit_event', rate_limit_info: evento({ five_hour: { utilization: 0.77, resetsAt: 0 } }, { agora }) },
        linhaComTimestamp(new Date(agora - 10 * 60_000).toISOString()),
      ],
      mtime: agora - 3600_000,
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas(agora);
    ok(r?.itens?.[0]?.usado === 77,
      `ganha job-B (medidoEmAprox mais novo), não job-A (mtime maior) (veio ${JSON.stringify(r)})`);
  });

  await bloco('16. log com mtime > 24h ⇒ ignorado mesmo sendo o único', async () => {
    const dir = novaJobsDir();
    const agora = Date.now();
    logFalso(dir, 'job-velho', {
      linhas: [
        { type: 'rate_limit_event', rate_limit_info: evento(FORMA_5H_7D, { agora }) },
        linhaComTimestamp(new Date(agora - 25 * 3600_000).toISOString()),
      ],
      mtime: agora - 25 * 3600_000,
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas(agora);
    ok(r === null, `arquivo de 25h atrás não compete (veio ${JSON.stringify(r)})`);
  });

  await bloco('17. 🔴 candidato sem timestamp na cauda ⇒ descartado (§2.1)', async () => {
    const dir = novaJobsDir();
    const agora = Date.now();
    // job-A: mtime de AGORA, mas NENHUMA linha com timestamp depois do evento.
    logFalso(dir, 'job-A', {
      linhas: [{ type: 'rate_limit_event', rate_limit_info: evento({ five_hour: { utilization: 0.9, resetsAt: 0 } }, { agora }) }],
      mtime: agora,
    });
    // job-B: mtime de 1h atrás, mas COM timestamp (de 1h atrás) depois do evento.
    logFalso(dir, 'job-B', {
      linhas: [
        { type: 'rate_limit_event', rate_limit_info: evento({ five_hour: { utilization: 0.5, resetsAt: 0 } }, { agora }) },
        linhaComTimestamp(new Date(agora - 3600_000).toISOString()),
      ],
      mtime: agora - 3600_000,
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas(agora);
    ok(r?.itens?.[0]?.usado === 50, `job-A (sem timestamp) perde mesmo com mtime maior (veio ${JSON.stringify(r)})`);
  });

  await bloco('18. 🔴 evento medido há 30h num log tocado AGORA ⇒ descartado pela idade da MEDIÇÃO', async () => {
    const dir = novaJobsDir();
    const agora = Date.now();
    logFalso(dir, 'job-medicao-velha', {
      linhas: [
        { type: 'rate_limit_event', rate_limit_info: evento(FORMA_5H_7D, { agora }) },
        linhaComTimestamp(new Date(agora - 30 * 3600_000).toISOString()),
      ],
      mtime: agora, // arquivo tocado AGORA — só o conteúdo é velho
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas(agora);
    ok(r === null, `mtime recente não salva uma medição de 30h atrás (veio ${JSON.stringify(r)})`);
  });

  await bloco('19. pasta vazia · pasta inexistente · log sem evento ⇒ null, sem lançar (R6)', async () => {
    const vazia = novaJobsDir();
    process.env.COCKPIT_JOBS_DIR = vazia;
    ok((await limite.dasJanelas()) === null, 'pasta vazia ⇒ null');

    process.env.COCKPIT_JOBS_DIR = path.join(PASTA, 'esta-pasta-nao-existe-' + Date.now());
    ok((await limite.dasJanelas()) === null, 'pasta inexistente ⇒ null, sem lançar');

    const dir = novaJobsDir();
    const agora = Date.now();
    logFalso(dir, 'job-sem-evento', {
      linhas: [linhaComTimestamp(new Date(agora).toISOString()), { type: 'user', message: { content: [] } }],
      mtime: agora,
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    ok((await limite.dasJanelas(agora)) === null, 'log sem nenhum rate_limit_event ⇒ null');
  });

  await bloco('20. COCKPIT_PLANO — presente vira rótulo; ausente, null (D-e)', async () => {
    const dir = novaJobsDir();
    const agora = Date.now();
    logFalso(dir, 'job-plano', {
      linhas: [
        { type: 'rate_limit_event', rate_limit_info: evento(FORMA_5H_7D, { agora }) },
        linhaComTimestamp(new Date(agora).toISOString()),
      ],
      mtime: agora,
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    process.env.COCKPIT_PLANO = 'MAX 20x';
    const comPlano = await limite.dasJanelas(agora);
    ok(comPlano?.plano === 'MAX 20x', `plano vem preenchido (veio ${comPlano?.plano})`);
    delete process.env.COCKPIT_PLANO;
    const semPlano = await limite.dasJanelas(agora);
    ok(semPlano?.plano === null, `ausente ⇒ null, nunca chumbado (veio ${semPlano?.plano})`);
  });

  await bloco('21. 🔴 nenhum caminho de disco no retorno (R7)', async () => {
    const dir = novaJobsDir();
    const agora = Date.now();
    const idSecreto = 'job-nao-pode-vazar';
    logFalso(dir, idSecreto, {
      linhas: [
        { type: 'rate_limit_event', rate_limit_info: evento(FORMA_5H_7D, { agora }) },
        linhaComTimestamp(new Date(agora).toISOString()),
      ],
      mtime: agora,
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas(agora);
    ok(r?.fonte === 'jobs', `fonte é o rótulo fixo 'jobs' (veio ${r?.fonte})`);
    const texto = JSON.stringify(r);
    ok(!texto.includes(idSecreto), 'o id do job não vaza na resposta');
    ok(!texto.includes(dir), 'nem o caminho da pasta de jobs');
  });

  await bloco('28. 🔴 evento recente SEM janelas válidas ⇒ null, nunca o evento ANTERIOR', async () => {
    // O bug que este caso prende: o `break` do laço interno saía só do loop do BLOCO, e o
    // `while` seguia para blocos anteriores. Um evento recente inútil (sem `unifiedWindows`)
    // fazia a função pescar um evento MAIS VELHO, de outro bloco, e apresentá-lo como o
    // consumo de agora. Reproduzido pelo painel de execução: "77% antigos ao separá-los por
    // 70 KB". Os dois eventos PRECISAM cair em blocos de 64 KB diferentes — no mesmo bloco o
    // defeito não aparece, e foi por isso que os casos 10-21 (um evento por arquivo) o
    // deixaram passar.
    const dir = novaJobsDir();
    const agora = Date.now();
    const recheio = { type: 'system', subtype: 'ruido', dados: 'x'.repeat(70 * 1024) };
    logFalso(dir, 'job-dois-eventos', {
      linhas: [
        // ANTIGO, lá atrás, com janelas boas e 77% — é ele que não pode vencer.
        { type: 'rate_limit_event', rate_limit_info: evento({ five_hour: { utilization: 0.77, resetsAt: Math.floor(agora / 1000) + 3600 } }, { agora }) },
        linhaComTimestamp(new Date(agora - 7200_000).toISOString()),
        recheio,
        // RECENTE, no fim, SEM unifiedWindows (é o formato dos 70 logs antigos medidos).
        { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(agora / 1000) + 3600 } },
        linhaComTimestamp(new Date(agora).toISOString()),
      ],
      mtime: agora,
    });
    process.env.COCKPIT_JOBS_DIR = dir;
    const r = await limite.dasJanelas(agora);
    ok(r === null,
      `o último evento manda, e ele não tem janelas ⇒ null (veio ${JSON.stringify(r)})`);
    ok(!JSON.stringify(r).includes('77'),
      'e os 77% do evento ANTERIOR não vazam como se fossem de agora');
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════
// ROTA — casos 22-27: server.js /api/limite, com o `execFile` espiado num subprocesso
// ════════════════════════════════════════════════════════════════════════════════════════

/** Sobe `node testes/gate-limite-janelas.js rota-filho` com HOME e COCKPIT_JOBS_DIR próprios
 * (§3.2 do plano) — é o que impede o gate de ler `~/.cockpit/jobs` de verdade ou escrever em
 * `~/.cockpit/limite`. Espera a linha "cockpit-agentes em http" no stdout antes de devolver. */
function subirFilho({ comFixturaJobs = true, falharUsage = false } = {}) {
  const casa = path.join(PASTA, `home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dirJobs = path.join(casa, '.cockpit', 'jobs');
  fs.mkdirSync(casa, { recursive: true });
  const registro = path.join(casa, 'chamadas.jsonl');
  fs.writeFileSync(registro, '');
  const porta = 20000 + Math.floor(Math.random() * 10000);

  const proc = spawn(process.execPath, [__filename, 'rota-filho'], {
    env: {
      ...process.env,
      HOME: casa,
      COCKPIT_JOBS_DIR: dirJobs,
      COCKPIT_CERT_DIR: '/dev/null', // #19 — sem isto o servidor tenta TLS e nunca imprime a linha de pronto
      PORT: String(porta),
      HOST: '127.0.0.1',
      GATE_REGISTRO_CHAMADAS: registro,
      GATE_FIXTURA_JOBS: comFixturaJobs ? '1' : '0',
      GATE_FALHAR_USAGE: falharUsage ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saida = '';
  const pronto = new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      saida += d.toString();
      if (/cockpit-agentes em http/.test(saida)) resolve();
    });
    proc.stderr.on('data', (d) => { saida += d.toString(); });
    proc.on('exit', (codigo) => reject(new Error(`o filho morreu antes de ficar pronto (código ${codigo})\n${saida}`)));
    setTimeout(() => reject(new Error(`o filho não ficou pronto em 5s\n${saida}`)), 5000);
  });

  return {
    porta,
    registro,
    async esperar() { await pronto; },
    chamadas() {
      const conteudo = fs.readFileSync(registro, 'utf8').trim();
      return conteudo ? conteudo.split('\n') : [];
    },
    pularRelogio() { proc.kill('SIGUSR2'); },
    matar() { proc.kill('SIGTERM'); },
  };
}

function pedirJson(porta, caminho) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: caminho, timeout: 4000 }, (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, corpo: JSON.parse(corpo) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function rodarRota() {
  await bloco('22-25. cache frio → forçar → cache quente → cache expirado (P2/P4)', async () => {
    const filho = subirFilho({ comFixturaJobs: true });
    try {
      await filho.esperar();

      // 22 — cache FRIO: o espião não pode ver NENHUM `claude`, e `janelas` vem preenchido
      // ANTES de qualquer forcar — é o dado de graça que a D-a existe para entregar.
      const frio = await pedirJson(filho.porta, '/api/limite');
      ok(frio.status === 200, `22: 200 (veio ${frio.status})`);
      ok(filho.chamadas().length === 0, `22: 🔴 cache frio NÃO chama claude (${filho.chamadas().length} chamadas)`);
      ok(Array.isArray(frio.corpo.itens) && frio.corpo.itens.length === 0, '22: itens vem [] (ninguém pagou ainda)');
      ok(frio.corpo.janelas && frio.corpo.janelas.itens?.length > 0,
        `22: janelas vem preenchido de graça (${JSON.stringify(frio.corpo.janelas)})`);

      // 23 — forcar=1: a ÚNICA forma de o espião ver um `claude -p /usage`.
      const forcado = await pedirJson(filho.porta, '/api/limite?forcar=1');
      ok(forcado.status === 200, `23: 200 (veio ${forcado.status})`);
      ok(filho.chamadas().length === 1, `23: exatamente 1 chamada a claude (${filho.chamadas().length})`);
      ok(forcado.corpo.itens?.length > 0, '23: itens agora vem preenchido (pago)');

      // 24 — cache QUENTE: logo depois do forcar, sem forcar de novo — NENHUMA chamada nova,
      // e `itens` CONTINUA preenchido (não é o comportamento do 22 — aqui seria o bug).
      const quente = await pedirJson(filho.porta, '/api/limite');
      ok(filho.chamadas().length === 1, `24: 🔴 cache quente não chama claude de novo (${filho.chamadas().length})`);
      ok(quente.corpo.itens?.length > 0, '24: e itens continua preenchido (cache pago ainda vale)');
      ok(quente.corpo.consultadoEm === forcado.corpo.consultadoEm, '24: mesmo consultadoEm do (23) — é cache, não consulta nova');

      // 25 — cache EXPIRADO (relógio adiantado além do TTL_MS): volta ao comportamento do 22.
      filho.pularRelogio();
      await new Promise((r) => setTimeout(r, 200));
      const expirado = await pedirJson(filho.porta, '/api/limite');
      ok(filho.chamadas().length === 1, `25: expirado ainda NÃO chama claude sozinho (${filho.chamadas().length})`);
      ok(Array.isArray(expirado.corpo.itens) && expirado.corpo.itens.length === 0,
        `25: itens volta a [] — o cache expirou e ninguém pagou de novo (${JSON.stringify(expirado.corpo.itens)})`);
    } finally {
      filho.matar();
    }
  });

  await bloco('26. 🔴 dasJanelas() estourando ⇒ 200 com janelas:null e codex intacto (R6)', async () => {
    const filho = subirFilho({ comFixturaJobs: false }); // pasta de jobs nunca é criada ⇒ readdir falha
    try {
      await filho.esperar();
      const r = await pedirJson(filho.porta, '/api/limite');
      ok(r.status === 200, `200 mesmo com a pasta de jobs ausente (veio ${r.status})`);
      ok(r.corpo.janelas === null, `janelas: null, não um erro que derruba a rota (veio ${JSON.stringify(r.corpo.janelas)})`);
      ok('codex' in r.corpo, 'e a chave `codex` continua presente (mesmo tratamento do caso 73 do gate-ui)');
    } finally {
      filho.matar();
    }
  });

  await bloco('27. 🔴 /usage estourando ⇒ janelas PRESENTE no ramo de erro (P6)', async () => {
    const filho = subirFilho({ comFixturaJobs: true, falharUsage: true });
    try {
      await filho.esperar();
      const r = await pedirJson(filho.porta, '/api/limite?forcar=1');
      ok(r.status === 200, `200 mesmo com o /usage falhando (veio ${r.status})`);
      ok(typeof r.corpo.erro === 'string' && r.corpo.erro.length > 0, `e o erro vai na resposta (${r.corpo.erro})`);
      ok(r.corpo.janelas && r.corpo.janelas.itens?.length > 0,
        `janelas SOBREVIVE ao erro da Anthropic (${JSON.stringify(r.corpo.janelas)})`);
    } finally {
      filho.matar();
    }
  });
}

if (!MODO_FILHO) main();
