#!/usr/bin/env node
'use strict';
// GATE de lib/uso-codex.js — card `codex-no-relatorio-de-tokens`, Fase 1.
//
// Offline, sem servidor, sem gastar token da assinatura: monta um HOME de mentira em mkdtemp,
// aponta COCKPIT_CODEX_RAIZ para uma árvore de fixtures GERADA por
// `testes/fixtures/rollout-codex/gera.js` (a alavanca — regenera-se se o formato do CLI
// mudar, não se edita JSON à mão), e COCKPIT_USO_CODEX_DIR para outro tmp. Nunca encosta em
// `~/.codex` nem em `~/.cockpit` de verdade (armadilhas #48/#78).
//
// 🔴 Datas das fixtures são DERIVADAS de `Date.now()` a cada execução deste gate — nunca
// chumbadas (é o defeito que o caso 72 do `gate-codex.js` tinha antes desta entrega).
//
// Inventário fechado — 9 casos (plano, Fase 1): GC1, GC2, GC3, GC4, GC6, GC7, GC8, GC8b, GC12.
// Os que faltam (GC5, GC9, GC10, GC10b, GC11, GC13, GC14, GC15) nascem nas fases que os
// sustentam: GC9 precisa da rota (Fase 2); GC5/GC10/GC10b/GC11 precisam de
// `abas.consumoDoCodex()` (Fase 3, `gate-codex.js`); GC13/GC14/GC15 precisam do HTML e do
// cliente (Fase 4, `gate-ui.js`).
//
// node testes/gate-uso-codex.js — só a parte 1 (offline). A parte 2 (rota) é
// `testes/gate-uso-codex.js parte2`, que sobe `server.js` filho — Fase 2.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ_REPO = path.resolve(__dirname, '..');
const LIB_USO_CODEX = path.join(RAIZ_REPO, 'lib', 'uso-codex.js');
const { gerar } = require('./fixtures/rollout-codex/gera');

let passou = 0;
let totalAsserts = 0;
let vermelho = false;
const CASOS = new Set();
const CASOS_ESPERADOS = ['GC1', 'GC2', 'GC3', 'GC4', 'GC6', 'GC7', 'GC8', 'GC8b', 'GC12',
  // card `tela-de-uso-no-fuso-do-aparelho` — GC18 (a rota) fica de fora: nasce na parteB()
  // (fase 4), e o inventário abaixo é conferido DENTRO da parteA() — mesmo precedente do GC9.
  'GC16', 'GC17'];

function ok(condicao, mensagem) {
  totalAsserts += 1;
  if (condicao) { passou += 1; console.log(`  ✅ ${mensagem}`); return true; }
  vermelho = true;
  console.log(`  ❌ ${mensagem}`);
  return false;
}
function assert(condicao, mensagem) { return ok(Boolean(condicao), mensagem); }
function titulo(t) {
  const m = /^(GC\d+b?)\b/.exec(t);
  if (m) CASOS.add(m[1]);
  console.log(`\n${t}`);
}
async function bloco(nomeParaTitulo, fn) {
  titulo(nomeParaTitulo);
  try {
    await fn();
  } catch (e) {
    vermelho = true;
    console.log(`  ❌ o bloco estourou — ${e && e.message}`);
    if (e && e.stack) console.log(`     ${e.stack.split('\n').slice(1, 3).join('\n     ')}`);
  }
}

// ─── o mundo de mentira ──────────────────────────────────────────────────────

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-codex-home-'));
process.env.HOME = HOME; // ANTES do require — projetoDe() lê os.homedir() a cada chamada, mas HOME já estável aqui
const WORKTREES = path.join(HOME, '.cockpit', 'worktrees');
const JOBS = path.join(HOME, '.cockpit', 'jobs');
fs.mkdirSync(WORKTREES, { recursive: true });
fs.mkdirSync(JOBS, { recursive: true });
process.env.COCKPIT_JOBS_DIR = JOBS;

const RAIZ_ROLLOUTS = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-codex-raiz-'));
process.env.COCKPIT_CODEX_RAIZ = RAIZ_ROLLOUTS;
process.env.COCKPIT_USO_CODEX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-codex-cache-'));
let usoCodex = require(LIB_USO_CODEX);

/** Recarrega lib/uso-codex.js do zero — o único jeito de zerar `cacheEmMemoria`/`emVoo`
 * (singletons de módulo), igual a `recarregarUso` de gate-uso.js:98. Não é preciso aqui (este
 * gate usa um cenário só, do início ao fim), mas fica pronta para quem vier depois. */
function recarregarUsoCodex(novoCacheDir) {
  process.env.COCKPIT_USO_CODEX_DIR = novoCacheDir;
  delete require.cache[LIB_USO_CODEX];
  usoCodex = require(LIB_USO_CODEX);
  return usoCodex;
}
void recarregarUsoCodex;

// As NOVE fixtures, geradas AGORA — datas relativas a `Date.now()`, nunca chumbadas.
gerar(RAIZ_ROLLOUTS, { home: HOME, worktreesDir: WORKTREES, jobsDir: JOBS });

function encontrarRollout(nome) {
  const alvo = `rollout-${nome}.jsonl`;
  for (const ano of fs.readdirSync(RAIZ_ROLLOUTS)) {
    const pAno = path.join(RAIZ_ROLLOUTS, ano);
    for (const mes of fs.readdirSync(pAno)) {
      const pMes = path.join(pAno, mes);
      for (const dia of fs.readdirSync(pMes)) {
        const caminho = path.join(pMes, dia, alvo);
        if (fs.existsSync(caminho)) return caminho;
      }
    }
  }
  throw new Error(`fixture ${alvo} não encontrada em ${RAIZ_ROLLOUTS}`);
}

async function parteA() {
  let r1 = null;

  await bloco('GC1. evento token_count DUPLICADO soma 0 — total == último acumulado', async () => {
    r1 = await usoCodex.relatorio({ dias: 30 });
    const p = r1.projetos.find((x) => x.projeto === 'duplicado-demo');
    assert(p && p.total.tokens === 2200,
      `duplicado-demo: total.tokens === 2200 (o repetido não soma de novo) (veio ${p && p.total.tokens})`);
  });

  await bloco('GC2. acumulado que CAI no meio abre segmento novo — nada se perde', async () => {
    const p = r1.projetos.find((x) => x.projeto === 'reset-demo');
    assert(p && p.total.tokens === 6000,
      `reset-demo: total.tokens === pico do 1º segmento (3600) + último do 2º (2400) = 6000 (veio ${p && p.total.tokens})`);
  });

  await bloco('GC3. linha corrompida e linha > 1 MB são PULADAS — os eventos válidos contam', async () => {
    const p = r1.projetos.find((x) => x.projeto === 'corrompido-demo');
    assert(p && p.total.tokens === 1500,
      `corrompido-demo: total.tokens === 1500, só os 2 token_count válidos (veio ${p && p.total.tokens})`);
    // TRÊS linhas quebradas no `rollout-corrompido`, e só DUAS devem contar (achado do painel
    // de execução, e a fixture teve de crescer para provar a distinção):
    //   · lixo não-candidato        → morre no filtro de orçamento, NÃO conta (não tem token)
    //   · `token_count` TRUNCADO    → chega no `JSON.parse`, estoura, CONTA — pode levar token
    //   · linha > 1 MB              → estoura o teto, CONTA
    // `>= 1` passava com só a de 1 MB contada, mascarando o `catch` mudo do `JSON.parse`.
    assert(r1.leitura.linhasIgnoradas === 2,
      `leitura.linhasIgnoradas === 2 — a > 1 MB e o token_count truncado; o lixo não-candidato NÃO entra (veio ${r1.leitura.linhasIgnoradas})`);
    assert(r1.leitura.arquivosComErro === 0,
      'a linha que não parseia não conta como ARQUIVO com erro — é pulada dentro do arquivo, nunca lança');
  });

  await bloco('GC4. cacheLeitura e raciocínio são DETALHAMENTO — não entram em total.tokens', async () => {
    const p = r1.projetos.find((x) => x.projeto === 'loja-exemplo');
    assert(p && p.total.tokens === p.total.entrada + p.total.saida,
      `loja-exemplo: total.tokens = entrada + saida, sem cache/raciocínio (${JSON.stringify(p && p.total)})`);
    assert(p && p.total.cacheLeitura > 0 && p.total.raciocinio > 0,
      'e cache/raciocínio aparecem como detalhamento, com valor > 0 — não somem, não se somam');
  });

  await bloco('GC6 (=G10). SEGREDO não aparece na resposta nem no cache.json — nem o hex da assinatura', async () => {
    const bruto = JSON.stringify(r1);
    assert(!/SEGREDO/.test(bruto), 'a resposta (relatorio()) não contém a string "SEGREDO"');
    const cacheDisco = fs.readFileSync(path.join(process.env.COCKPIT_USO_CODEX_DIR, 'cache.json'), 'utf8');
    assert(!/SEGREDO/.test(cacheDisco), 'o cache.json gravado no disco não contém a string "SEGREDO"');
    const hexDoSegredo = Buffer.from('SEGREDO-NAO-PODE-VAZAR', 'utf8').toString('hex');
    assert(!cacheDisco.includes(hexDoSegredo),
      'a assinatura gravada NÃO contém o hex do segredo — ela é sha256(hex), não o hex cru (D4.1)');
    const p = r1.projetos.find((x) => x.projeto === 'segredo-demo');
    assert(p && p.total.tokens === 950, `e o arquivo ainda é lido normalmente: segredo-demo total.tokens === 950 (veio ${p && p.total.tokens})`);
  });

  await bloco('GC7 (=G26). whitelist FECHADA de chaves, em toda profundidade — resposta e cache.json', async () => {
    const PERMITIDAS = new Set([
      'geradoEm', 'desde', 'ate', 'dias', 'total',
      'entrada', 'saida', 'cacheLeitura', 'raciocinio', 'tokens',
      'porModelo', 'modelo', 'porDia', 'dia', 'projetos', 'projeto',
      'leitura', 'arquivos', 'comUsage', 'relidos', 'bytesLidos', 'ms', 'arquivosComErro',
      'linhasIgnoradas', 'precisaoPerdida',
      'versao', 'caminho', 'ino', 'offset', 'assinatura', 'ignoradas', 'ultimoTotal',
      'input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens', 'total_tokens',
      // card `tela-de-uso-no-fuso-do-aparelho` — chave do agregado virou hora, resposta ganhou
      // o fuso REALMENTE usado e o rótulo dele (D5/D6), espelhando gate-uso.js (G26).
      'horas', 'fuso', 'fusoRotulo',
    ]);
    // Lista FECHADA dos ids de modelo e nomes de projeto que ESTE gate injeta — de propósito
    // curta e explícita, mesmo espírito de gate-uso.js:763 (MODELOS_CONHECIDOS).
    const MODELOS_CONHECIDOS = new Set(['gpt-6-astra']);
    const PROJETOS_CONHECIDOS = new Set([
      'loja-exemplo', 'duplicado-demo', 'reset-demo', 'projeto-job', 'subagente-demo',
      'corrompido-demo', 'segredo-demo', 'sem-secundaria-demo', 'vencido-demo',
    ]);
    // `T\d{2}` OBRIGATÓRIO — mesma guarda de gate-uso.js (G26): a chave do agregado é hora.
    const RE_DIA_OU_SEMDATA = /^(\d{4}-\d{2}-\d{2}T\d{2}|sem-data)$/;
    const chaveOk = (k) => PERMITIDAS.has(k) || RE_DIA_OU_SEMDATA.test(k)
      || MODELOS_CONHECIDOS.has(k) || PROJETOS_CONHECIDOS.has(k);
    const achadas = new Set();
    function varreChaves(objeto) {
      if (!objeto || typeof objeto !== 'object') return;
      if (Array.isArray(objeto)) { for (const v of objeto) varreChaves(v); return; }
      for (const [k, v] of Object.entries(objeto)) { achadas.add(k); varreChaves(v); }
    }
    varreChaves(r1);
    const cacheDisco = JSON.parse(fs.readFileSync(path.join(process.env.COCKPIT_USO_CODEX_DIR, 'cache.json'), 'utf8'));
    varreChaves(cacheDisco);
    const foraDaLista = Array.from(achadas).filter((k) => !chaveOk(k));
    assert(foraDaLista.length === 0, `todas as chaves pertencem à whitelist (fora: ${JSON.stringify(foraDaLista)})`);
  });

  await bloco('GC12. `source:"exec"` (com meta.json de job) e `source` OBJETO entram com o projeto certo', async () => {
    const pExec = r1.projetos.find((x) => x.projeto === 'projeto-job');
    assert(pExec && pExec.total.tokens === 1700,
      `rollout-exec: resolve para o projeto do meta.json, "projeto-job" (veio ${pExec && pExec.total.tokens})`);
    const pSub = r1.projetos.find((x) => x.projeto === 'subagente-demo');
    assert(pSub && pSub.total.tokens === 850,
      `rollout-subagente: \`source\` como OBJETO {subagent:...} não quebra a varredura (veio ${pSub && pSub.total.tokens})`);
  });

  await bloco('GC8. append incremental — 2º relatorio() = 1º + delta real, NÃO reconta', async () => {
    const caminho = encontrarRollout('normal');
    const linhaNova = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 5200, output_tokens: 1100, cached_input_tokens: 4500,
            cache_write_input_tokens: 0, reasoning_output_tokens: 350, total_tokens: 6300,
          },
        },
      },
    })}\n`;
    fs.appendFileSync(caminho, linhaNova);
    const r2 = await usoCodex.relatorio({ dias: 30 });
    const p = r2.projetos.find((x) => x.projeto === 'loja-exemplo');
    assert(p && p.total.tokens === 6300,
      `append: o total sobe para o novo acumulado (6300) — não soma o antigo (5100) de novo (veio ${p && p.total.tokens})`);
  });

  await bloco('GC8b. ino/assinatura DIVERGIU (arquivo trocado) — a entrada é reconstruída INTEIRA', async () => {
    const caminho = encontrarRollout('normal');
    // Recria o arquivo do ZERO, com conteúdo MENOR: se `ultimoTotal` sobrevivesse de um
    // arquivo truncado, o primeiro delta nasceria negativo e o clamp o zeraria calado — a
    // prova certa é o total bater com o arquivo NOVO, nunca com a soma dos dois.
    fs.rmSync(caminho);
    const agora = new Date().toISOString();
    fs.writeFileSync(caminho, [
      JSON.stringify({
        timestamp: agora, type: 'session_meta',
        payload: {
          id: 'normal2', session_id: 'normal2', timestamp: agora,
          cwd: path.join(HOME, 'projetos', 'loja-exemplo'), originator: 'codex-tui', source: 'cli',
          cli_version: '0.147.0', base_instructions: { text: 'y'.repeat(500) },
        },
      }),
      JSON.stringify({
        timestamp: agora, type: 'turn_context',
        payload: { model: 'gpt-6-astra', collaboration_mode: { mode: 'default', settings: { model: 'gpt-6-astra', reasoning_effort: null } } },
      }),
      JSON.stringify({
        timestamp: agora, type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 300, output_tokens: 50, cached_input_tokens: 200,
              cache_write_input_tokens: 0, reasoning_output_tokens: 10, total_tokens: 350,
            },
          },
        },
      }),
      '',
    ].join('\n'));
    const r3 = await usoCodex.relatorio({ dias: 30 });
    const p = r3.projetos.find((x) => x.projeto === 'loja-exemplo');
    assert(p && p.total.tokens === 350,
      `o arquivo NOVO manda: total é 350, não 6300+350=6650 (veio ${p && p.total.tokens})`);
  });

  await bloco('GC16. `montar` no fuso do aparelho — mesmo caso do G40, no Codex (puro)', async () => {
    const estado = {
      arquivos: {
        '/x/r.jsonl': {
          projeto: 'gc16', ignoradas: {},
          horas: {
            '2026-09-04T01': { 'gpt-6-astra': [10, 0, 0, 0, 1] },
            '2026-09-04T03': { 'gpt-6-astra': [40, 0, 0, 0, 1] },
          },
        },
      },
    };
    const agora = Date.UTC(2026, 8, 4, 12);
    const comFuso = usoCodex.montar(estado, 1, 'America/Sao_Paulo', agora);
    const pComFuso = comFuso.projetos.find((x) => x.projeto === 'gc16');
    assert(pComFuso && pComFuso.total.entrada === 40,
      `São Paulo, agora=04/09 12:00Z: só a hora 03 (22h SP) entra — entrada=40 (veio ${pComFuso && pComFuso.total.entrada})`);
    assert(comFuso.fusoRotulo === 'UTC-3', `fusoRotulo é UTC-3 (veio ${comFuso.fusoRotulo})`);
    const semFuso = usoCodex.montar(estado, 1, undefined, agora);
    const pSemFuso = semFuso.projetos.find((x) => x.projeto === 'gc16');
    assert(pSemFuso && pSemFuso.total.entrada === 50,
      `sem fuso, as duas horas caem no dia UTC de hoje — entrada=50 (veio ${pSemFuso && pSemFuso.total.entrada})`);
  });

  await bloco('GC17. comUsage por VALOR no r1 que o gate já calcula', async () => {
    assert(r1 && r1.leitura.comUsage > 0, `comUsage > 0 (veio ${r1 && r1.leitura.comUsage})`);
  });

  const faltando = CASOS_ESPERADOS.filter((c) => !CASOS.has(c));
  assert(faltando.length === 0, `inventário completo — nenhum caso esperado ficou de fora (faltando: ${JSON.stringify(faltando)})`);
}

// ─── parte 2 — a rota, contra o servidor no ar (Fase 2) ────────────────────
//
// `server.js` filho na porta 7894 (7893 é do print irmão; 7899 é dos jobs; 7879 é PRODUÇÃO —
// nunca), `HOME` e `COCKPIT_*` isolados. GC9: a whitelist `DIAS_ACEITOS` do servidor, não do
// módulo — `?dias=7`→7, `?dias=30`→30, e tudo fora da lista (`999`, `abc`, `-1`, ausente)→1.
// Servidor derrubado no `finally` (#24: porta esquecida trava o job seguinte).

const PORTA_PARTE2 = 7894;

function pedirJson(porta, caminho) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: caminho, timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => { try { resolve({ status: res.statusCode, corpo: JSON.parse(d) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function parteB() {
  const { spawn } = require('node:child_process');
  const http = require('node:http');
  const homeServ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-codex-parte2-home-'));
  const raizServ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-codex-parte2-raiz-'));
  const cacheServ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-codex-parte2-cache-'));
  // GC18 (=G44, fase 4) bate também em /api/uso — precisa do cache do Claude isolado; o HOME
  // já é falso (homeServ), mas COCKPIT_USO_DIR precisa do próprio tmp para responder isolado.
  const cacheUsoServ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-uso-codex-parte2-cache-uso-'));
  gerar(raizServ, { home: homeServ });

  const ambiente = { ...process.env };
  delete ambiente.COCKPIT_TOKEN;
  delete ambiente.COCKPIT_TMUX_SOCKET;
  Object.assign(ambiente, {
    HOST: '127.0.0.1', PORT: String(PORTA_PARTE2), HOME: homeServ,
    COCKPIT_CERT_DIR: '/dev/null', COCKPIT_CODEX_RAIZ: raizServ, COCKPIT_USO_CODEX_DIR: cacheServ,
    COCKPIT_USO_DIR: cacheUsoServ,
    COCKPIT_JOBS_DIR: path.join(homeServ, 'sem-jobs'), COCKPIT_VIGIA_MS: '0',
  });
  const filho = spawn(process.execPath, [path.join(RAIZ_REPO, 'server.js')], {
    env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let erroDoFilho = '';
  filho.stderr.on('data', (d) => { erroDoFilho += d; });
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const saude = () => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA_PARTE2, path: '/health', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  try {
    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (filho.exitCode !== null) break;
      // eslint-disable-next-line no-await-in-loop
      pronto = await saude();
      // eslint-disable-next-line no-await-in-loop
      if (!pronto) await espera(200);
    }
    if (!pronto) throw new Error(`servidor não subiu na ${PORTA_PARTE2}: ${erroDoFilho.trim().split('\n').slice(-10).join(' | ')}`);

    await bloco('GC9. GET /api/uso-codex?dias= respeita a whitelist DIAS_ACEITOS do servidor', async () => {
      const r7 = await pedirJson(PORTA_PARTE2, '/api/uso-codex?dias=7');
      assert(r7.status === 200 && r7.corpo.dias === 7, `?dias=7 → 7 (veio ${r7.status}/${r7.corpo.dias})`);
      const r30 = await pedirJson(PORTA_PARTE2, '/api/uso-codex?dias=30');
      assert(r30.status === 200 && r30.corpo.dias === 30, `?dias=30 → 30 (veio ${r30.status}/${r30.corpo.dias})`);
      for (const [rotulo, qs] of [['999', '?dias=999'], ['abc', '?dias=abc'], ['-1', '?dias=-1'], ['ausente', '']]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await pedirJson(PORTA_PARTE2, `/api/uso-codex${qs}`);
        assert(r.status === 200 && r.corpo.dias === 1, `dias=${rotulo} → 1, nunca Number() livre (veio ${r.status}/${r.corpo.dias})`);
      }
    });

    await bloco('GC18 (=G44). /api/uso e /api/uso-codex aceitam ?fuso= — fuso inválido/ausente cai em UTC', async () => {
      const codexComFuso = await pedirJson(PORTA_PARTE2, '/api/uso-codex?fuso=America/Sao_Paulo');
      assert(codexComFuso.status === 200 && codexComFuso.corpo.fusoRotulo === 'UTC-3',
        `/api/uso-codex?fuso=America/Sao_Paulo → fusoRotulo UTC-3 (veio ${codexComFuso.status}/${codexComFuso.corpo.fusoRotulo})`);
      const usoComFuso = await pedirJson(PORTA_PARTE2, '/api/uso?fuso=America/Sao_Paulo');
      assert(usoComFuso.status === 200 && usoComFuso.corpo.fusoRotulo === 'UTC-3',
        `/api/uso?fuso=America/Sao_Paulo → fusoRotulo UTC-3 (veio ${usoComFuso.status}/${usoComFuso.corpo.fusoRotulo})`);
      const codexInvalido = await pedirJson(PORTA_PARTE2, '/api/uso-codex?fuso=Marte%2FBase');
      assert(codexInvalido.status === 200 && codexInvalido.corpo.fuso === 'UTC' && codexInvalido.corpo.fusoRotulo === 'UTC',
        `/api/uso-codex?fuso=Marte%2FBase → fuso/fusoRotulo UTC (veio ${codexInvalido.status}/${JSON.stringify({ fuso: codexInvalido.corpo.fuso, fusoRotulo: codexInvalido.corpo.fusoRotulo })})`);
      const usoSemFuso = await pedirJson(PORTA_PARTE2, '/api/uso');
      assert(usoSemFuso.status === 200 && usoSemFuso.corpo.fuso === 'UTC' && usoSemFuso.corpo.fusoRotulo === 'UTC',
        `/api/uso sem fuso → fuso/fusoRotulo UTC (veio ${usoSemFuso.status}/${JSON.stringify({ fuso: usoSemFuso.corpo.fuso, fusoRotulo: usoSemFuso.corpo.fusoRotulo })})`);
    });
  } finally {
    if (filho.exitCode === null) {
      try { process.kill(filho.pid); } catch { /* já morreu */ }
      await Promise.race([new Promise((r) => filho.on('exit', r)), espera(5000)]);
      if (filho.exitCode === null) { try { process.kill(filho.pid, 'SIGKILL'); } catch { /* já morreu */ } }
    }
  }
}

(async () => {
  const parte2 = process.argv[2] === 'parte2';
  if (parte2) await parteB(); else await parteA();

  console.log(`\n${passou}/${totalAsserts} asserções · ${CASOS.size} casos`);
  console.log(`\n${vermelho ? '❌ GATE VERMELHO' : '✅ GATE VERDE'} — lib/uso-codex.js (${parte2 ? 'parte 2' : 'parte 1'})\n`);
  process.exit(vermelho ? 1 : 0);
})().catch((e) => {
  console.error('🔴 o gate estourou:', e && e.stack);
  process.exit(1);
});
