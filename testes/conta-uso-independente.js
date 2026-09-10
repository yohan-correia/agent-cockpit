#!/usr/bin/env node
'use strict';
// A segunda opinião de spec §3.8 — critério de aceite 4: o total que a tela mostra bate com
// uma contagem INDEPENDENTE do mesmo disco.
//
// Independente de verdade: o algoritmo é DIFERENTE do de lib/uso.js em tudo que pode divergir
// por acaso — leitura por `readline` + `createReadStream` (não o laço de blocos manual), SEM
// cache (relê tudo sempre), SEM aplicar TETO_LINHA (conta as linhas grandes EM SEPARADO em vez
// de descartá-las). O que ele REPETE de propósito — porque tem que ser igual, senão os dois
// nunca bateriam por definição — é a recursão (R1), o dia UTC (§2.1), a coerção `num()`
// (§3.1.5), a exclusão de soma-zero e a inclusão de `isSidechain`.
//
// A ÚNICA coisa que importa de lib/uso.js é a constante `TETO_LINHA` — importar o algoritmo
// destruiria a independência (a comparação provaria que um script concorda consigo mesmo).
//
// Uso:
//   node testes/conta-uso-independente.js --dias=1              (só a contagem própria)
//   node testes/conta-uso-independente.js --dias=1 --comparar   (+ lib/uso.js, fecha campo a
//                                                                  campo, sai 0/1)

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

// `let`, não `const`: o modo --snapshot a reaponta para uma cópia congelada (ver `congelar`).
let RAIZ = path.join(os.homedir(), '.claude', 'projects');

/**
 * Copia `~/.claude/projects` para um tmp e reaponta HOME e RAIZ para lá.
 *
 * Existe porque o Gate 4.2 é INTERMITENTE sem isto, e a causa é a ironia deste card: os dois
 * lados varrem 729 MB em ~5 s CADA, sequencialmente, e o agente que roda o teste **escreve no
 * próprio .jsonl** entre uma varredura e a outra. Medido em 2026-09-04, duas execuções
 * seguidas: a 1ª acusou -110.320 em cacheLeitura (o lib/uso.js, que varre depois, viu linhas
 * que o independente não tinha visto); a 2ª fechou exata, e o total geral havia subido de
 * 810,3M para 811,5M no intervalo. Nenhuma das duas dizia nada sobre o código.
 *
 * A ferramenta que mede consumo de token não consegue medir a si mesma enquanto mede — medir
 * gasta token. Então o universo é congelado antes de contar.
 *
 * Cópia REAL, não `cp -al`: hardlink aponta para o mesmo inode, e um arquivo em append
 * continuaria crescendo por baixo do snapshot — que é exatamente o que se está tentando
 * evitar. ~730 MB e alguns segundos, uma vez, num gate que roda uma vez.
 */
function congelar() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conta-uso-snapshot-'));
  const homeFalso = path.join(tmp, 'home');
  const destino = path.join(homeFalso, '.claude', 'projects');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  execFileSync('cp', ['-a', RAIZ, destino], { stdio: ['ignore', 'ignore', 'pipe'] });
  // ANTES de qualquer `require('../lib/uso')`: aquele módulo resolve a raiz dele a partir de
  // os.homedir() no topo, então os dois lados precisam do HOME novo já em pé.
  process.env.HOME = homeFalso;
  // Idem gate-uso.js: a pasta dos jobs vem do ENV agora, e o HOME falso sozinho não a move.
  process.env.COCKPIT_JOBS_DIR = path.join(homeFalso, '.cockpit', 'jobs');
  RAIZ = destino;
  return { tmp, destino };
}

// ── as mesmas definições de lib/uso.js, reimplementadas (não importadas) ────

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER ? Math.trunc(x) : 0;
}
function diaDe(texto) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(texto || ''));
  return m ? m[1] : 'sem-data';
}
function janelaUTC(dias, agora = Date.now()) {
  const hoje = new Date(agora).toISOString().slice(0, 10);
  const hojeUTC = Date.UTC(...hoje.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  const desde = new Date(hojeUTC - (dias - 1) * 86400000).toISOString().slice(0, 10);
  return { desde, ate: hoje };
}
function diaDentro(dia, desde, ate) {
  return dia !== 'sem-data' && dia >= desde && dia <= ate;
}
function novoTotal() { return [0, 0, 0, 0]; }

/** Soma 4 campos num Map(modelo → total[4]), criando a entrada na primeira vez. */
function somarPorModelo(mapa, modelo, valores) {
  if (!mapa.has(modelo)) mapa.set(modelo, novoTotal());
  const alvo = mapa.get(modelo);
  for (let i = 0; i < 4; i += 1) alvo[i] += valores[i];
}

/** Todos os .jsonl sob `raiz`, recursivo por pasta de 1º nível (R1 — subagente vive em
 * <pasta>/<sessao>/subagents/*.jsonl). Falha numa pasta pula SÓ ela, como lib/uso.js. */
async function acharArquivos(raiz) {
  const achados = [];
  let pastas = [];
  try { pastas = await fsp.readdir(raiz); } catch { return achados; }
  for (const pastaNome of pastas) {
    const pastaAbs = path.join(raiz, pastaNome);
    let st;
    // eslint-disable-next-line no-await-in-loop
    try { st = await fsp.stat(pastaAbs); } catch { continue; }
    if (!st.isDirectory()) continue;
    let arquivosDaPasta;
    // eslint-disable-next-line no-await-in-loop
    try { arquivosDaPasta = await fsp.readdir(pastaAbs, { recursive: true }); } catch { continue; }
    for (const relativo of arquivosDaPasta) {
      if (relativo.endsWith('.jsonl')) achados.push(path.join(pastaAbs, relativo));
    }
  }
  return achados;
}

/** Soma UM arquivo em `acc.tudo` (sempre) e, quando a linha passa de `TETO_LINHA`, TAMBÉM em
 * `acc.soGrandes` — ele CONHECE o teto mas conta em separado em vez de aplicá-lo (§3.8). */
async function contarArquivo(caminho, { desde, ate, TETO_LINHA }, acc) {
  let alca;
  try {
    alca = fs.createReadStream(caminho, { encoding: 'utf8' });
  } catch { return; }
  const rl = readline.createInterface({ input: alca, crlfDelay: Infinity });
  try {
    // eslint-disable-next-line no-restricted-syntax
    for await (const linha of rl) {
      if (!linha) continue;
      const tamanho = Buffer.byteLength(linha, 'utf8');
      let obj;
      try { obj = JSON.parse(linha); } catch { continue; }   // formato interno (#10): pula
      const u = obj && typeof obj === 'object' ? obj.message && obj.message.usage : null;
      if (!u || typeof u !== 'object') continue;
      const entrada = num(u.input_tokens);
      const saida = num(u.output_tokens);
      const cacheEscrita = num(u.cache_creation_input_tokens);
      const cacheLeitura = num(u.cache_read_input_tokens);
      if (entrada + saida + cacheEscrita + cacheLeitura === 0) continue;   // soma-zero: pulada
      const dia = diaDe(obj.timestamp);
      if (!diaDentro(dia, desde, ate)) continue;

      // O id do modelo, com a MESMA regra de lib/uso.js (ausente ⇒ 'desconhecido') e mais
      // nada: normalizar aqui seria copiar o algoritmo do outro lado, que é o oposto de uma
      // segunda opinião. O custo NÃO entra nesta comparação — reimplementar a mesma
      // multiplicação nos dois lados provaria só que duas cópias da fórmula concordam. O que
      // precisa de segunda opinião é a CONTAGEM.
      const modelo = (obj.message && typeof obj.message.model === 'string' && obj.message.model)
        || 'desconhecido';
      const valores = [entrada, saida, cacheEscrita, cacheLeitura];

      acc.tudo[0] += entrada; acc.tudo[1] += saida; acc.tudo[2] += cacheEscrita; acc.tudo[3] += cacheLeitura;
      somarPorModelo(acc.porModelo, modelo, valores);
      if (tamanho > TETO_LINHA) {
        acc.soGrandes[0] += entrada; acc.soGrandes[1] += saida;
        acc.soGrandes[2] += cacheEscrita; acc.soGrandes[3] += cacheLeitura;
        somarPorModelo(acc.porModeloGrandes, modelo, valores);
      }
    }
  } catch (erro) {
    if (!erro || !erro.syscall) throw erro;   // erro de I/O degrada; bug de programação sobe
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

(async () => {
  const args = process.argv.slice(2);
  const diasArg = args.find((a) => a.startsWith('--dias='));
  const dias = diasArg ? Number(diasArg.slice('--dias='.length)) : 1;
  const comparar = args.includes('--comparar');
  // Congelar é o PADRÃO no --comparar; `--sem-snapshot` existe só para diagnosticar.
  const congelado = comparar && !args.includes('--sem-snapshot') ? congelar() : null;
  if (congelado) console.log(`snapshot congelado em ${congelado.destino}`);

  // A constante — e SÓ ela — vem de lib/uso.js (spec §3.8).
  const { TETO_LINHA } = require('../lib/uso');

  const { desde, ate } = janelaUTC(dias);
  console.log(`raiz: ${RAIZ}  COCKPIT_USO_DIR: ${process.env.COCKPIT_USO_DIR || '(padrão ~/.cockpit/uso)'}  janela: ${desde}..${ate} (UTC)`);

  const arquivos = await acharArquivos(RAIZ);
  const acc = { tudo: novoTotal(), soGrandes: novoTotal(), porModelo: new Map(), porModeloGrandes: new Map() };
  for (const arq of arquivos) {
    // eslint-disable-next-line no-await-in-loop
    await contarArquivo(arq, { desde, ate, TETO_LINHA }, acc);
  }

  /** Map(modelo → total[4]) menos as linhas grandes, na ordem ALFABÉTICA do nome. A ordenação
   * não é estética: o G28 compara `frio.stdout === quente.stdout` byte a byte, e ordem de
   * inserção de `Map` depende do `readdir` do sistema de arquivos — o gate viraria
   * intermitente, que é o pior tipo de gate. */
  function modelosSemGrandes() {
    const fora = new Map();
    for (const [modelo, arr] of acc.porModelo) {
      const grandes = acc.porModeloGrandes.get(modelo) || novoTotal();
      fora.set(modelo, arr.map((v, i) => v - grandes[i]));
    }
    return Array.from(fora.entries()).sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)));
  }

  if (!comparar) {
    console.log(`tudo: ${JSON.stringify(acc.tudo)}`);
    console.log(`soGrandes: ${JSON.stringify(acc.soGrandes)}`);
    for (const [modelo, arr] of modelosSemGrandes()) console.log(`  ${modelo}: ${JSON.stringify(arr)}`);
    process.exit(0);
    return;
  }

  // Os dois lados no MESMO processo, na MESMA passagem (pontos 3/4 da 6ª rodada do painel) —
  // E sobre o SNAPSHOT CONGELADO. "Mesmo processo" garante o mesmo HOME e a mesma janela, mas
  // NÃO garante o mesmo instante: são duas varreduras de ~5 s em sequência, e no disco vivo o
  // .jsonl do próprio agente cresce entre elas. Só o congelamento fecha isso (ver `congelar`).
  const usoLib = require('../lib/uso');
  const relatorio = await usoLib.relatorio({ dias });
  const NOMES = ['entrada', 'saida', 'cacheEscrita', 'cacheLeitura'];
  const doLib = [relatorio.total.entrada, relatorio.total.saida, relatorio.total.cacheEscrita, relatorio.total.cacheLeitura];

  let ok = true;
  console.log(`${'campo'.padEnd(14)}${'independente'.padStart(14)}${'lib/uso.js'.padStart(14)}${'grandes'.padStart(10)}${'dif'.padStart(8)}`);
  for (let i = 0; i < 4; i += 1) {
    const semGigantes = acc.tudo[i] - acc.soGrandes[i];
    const dif = semGigantes - doLib[i];
    if (dif !== 0) ok = false;
    console.log(`${NOMES[i].padEnd(14)}${String(semGigantes).padStart(14)}${String(doLib[i]).padStart(14)}${String(acc.soGrandes[i]).padStart(10)}${String(dif).padStart(8)}`);
  }
  const bateuIgnoradas = acc.soGrandes.every((v) => v === 0) === (relatorio.leitura.linhasIgnoradas === 0);
  if (!bateuIgnoradas) ok = false;
  console.log(`linhasIgnoradas: ${relatorio.leitura.linhasIgnoradas} (independente viu ${JSON.stringify(acc.soGrandes)} nas grandes)  ${bateuIgnoradas ? '✅' : '❌'}`);

  // O eixo NOVO: a quebra por modelo, contada com o algoritmo deste script (readline, sem
  // cache, sem TETO_LINHA), campo a campo contra `porModelo` de lib/uso.js. Um modelo presente
  // de um lado e ausente do outro é FALHA, nunca uma linha faltando em silêncio.
  const doLibPorModelo = new Map(
    (relatorio.porModelo || []).map((m) => [m.modelo, [m.total.entrada, m.total.saida, m.total.cacheEscrita, m.total.cacheLeitura]]),
  );
  const meus = new Map(modelosSemGrandes());
  const todos = Array.from(new Set([...meus.keys(), ...doLibPorModelo.keys()]))
    .sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
  console.log(`\npor modelo (${todos.length}):`);
  for (const modelo of todos) {
    const meu = meus.get(modelo);
    const dele = doLibPorModelo.get(modelo);
    if (!meu || !dele) {
      ok = false;
      console.log(`  ${modelo.padEnd(30)} ❌ só ${meu ? 'o independente' : 'lib/uso.js'} viu este modelo`);
      continue;
    }
    const difs = meu.map((v, i) => v - dele[i]);
    const bateu = difs.every((d) => d === 0);
    if (!bateu) ok = false;
    console.log(`  ${modelo.padEnd(30)}${String(meu[0] + meu[1] + meu[2] + meu[3]).padStart(16)}  dif ${JSON.stringify(difs)}  ${bateu ? '✅' : '❌'}`);
  }
  if (congelado) fs.rmSync(congelado.tmp, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('erro:', e && e.message);
  process.exit(1);
});
