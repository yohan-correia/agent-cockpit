#!/usr/bin/env node
'use strict';
// GATE — o monitor do servidor (lib/monitor.js): fórmulas de CPU/RAM/disco, histórico de 24 h,
// aviso com histerese e top de processos (card do monitor, D64, a spec
// do monitor, 2026-10-06, §6).
//
// M1-M8 provam as funções PURAS e a varredura de `/proc` contra fixtures em texto (nunca
// `statfs` nem `/proc` ao vivo: o gate não pode reprovar porque o disco encheu).
//
// Isolamento: as envs do monitor são definidas ANTES do `require` — o módulo resolve a pasta
// do histórico em tempo de chamada, mas quem importa sem isolamento e liga o relógio gravaria
// no `~/.cockpit` de produção (armadilhas #62/#78).
//
// Uso: node testes/gate-monitor.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

let falhas = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas += 1; return cond; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-monitor-'));
const WT = path.join(RAIZ, 'worktrees');
process.env.COCKPIT_WORKTREES_DIR = WT;
process.env.COCKPIT_MONITOR_DIR = path.join(RAIZ, 'monitor');
process.env.COCKPIT_MONITOR_MS = '0';
// #78: gate que esquece o falso cai em "indisponivel", nunca no `du`/`docker` de verdade.
process.env.COCKPIT_DU_BIN = path.join(RAIZ, 'nao-existe-du');
process.env.COCKPIT_DOCKER_BIN = path.join(RAIZ, 'nao-existe-docker');
const monitor = require('../lib/monitor');
let disco = null;
try { disco = require('../lib/monitor-disco'); } catch (e) { /* D0 abaixo reprova com mensagem legível */ }

// ─── Fixtures de /proc ───────────────────────────────────────────────────────────────────

/** Um `stat` com utime/stime/rss nas posições certas (campo 14, 15 e 24 do arquivo real). */
function textoStat(pid, nome, utime, stime, rssPaginas) {
  const campos = new Array(50).fill('0'); // índice 0 = campo 3
  campos[0] = 'S';
  campos[11] = String(utime);
  campos[12] = String(stime);
  campos[21] = String(rssPaginas);
  return `${pid} (${nome}) ${campos.join(' ')}\n`;
}

/** cmdline REAL: argumentos separados por NUL. Montado por array — `'\0'` seguido de dígito em
 *  literal é escape octal e dá SyntaxError em modo estrito. */
const cmdlineDe = (args) => args.join('\0') + '\0';

const PROCESSOS = [
  { pid: 101, nome: 'node', args: ['node', '/home/x/ua-grafo-det.mjs', '--threads', '4'], ticks: [100, 50], rss: 300000, cwd: path.join(WT, 'job-x') },
  { pid: 102, nome: 'claude', args: ['claude', '-p', 'minha senha secreta', '--token=abc123'], ticks: [10, 10], rss: 90000 },
  { pid: 103, nome: 'sh', args: ['sh', '--token', 'abc123'], ticks: [5, 5], rss: 1000 },
  { pid: 104, nome: 'python', args: ['python', '-p', 'senhaSecreta'], ticks: [200, 0], rss: 50000, cwd: '/tmp/fora-de-worktree' },
  { pid: 105, nome: 'cat', args: ['cat', '/home/x/.env'], ticks: [1, 1], rss: 500 },
  { pid: 106, nome: 'bash (x)', args: ['bash'], ticks: [30, 30], rss: 20000 },
  { pid: 107, nome: 'sleep', args: ['sleep', '60'], ticks: [0, 0], rss: 100 },
  { pid: 108, nome: 'redis', args: ['redis'], ticks: [0, 0], rss: 80000 },
  { pid: 109, nome: 'nginx', args: ['nginx'], ticks: [0, 0], rss: 70000 },
  { pid: 110, nome: 'java', args: ['java'], ticks: [0, 0], rss: 60000 },
  { pid: 111, nome: 'ruby', args: ['ruby'], ticks: [0, 0], rss: 40000 },
  { pid: 112, nome: 'php', args: ['php'], ticks: [0, 0], rss: 30000 },
  { pid: 113, nome: 'perl', args: ['perl'], ticks: [0, 0], rss: 10000 },
];

/** Planta a árvore de /proc falsa (só os pids; a raiz com `stat`/`meminfo` é do chamador). */
function plantarPids(raiz, ticksExtra = {}) {
  fs.mkdirSync(raiz, { recursive: true });
  for (const p of PROCESSOS) {
    const dir = path.join(raiz, String(p.pid));
    fs.mkdirSync(dir, { recursive: true });
    const [u, s] = p.ticks;
    const extra = ticksExtra[p.pid] || 0;
    fs.writeFileSync(path.join(dir, 'stat'), textoStat(p.pid, p.nome, u + extra, s, p.rss));
    fs.writeFileSync(path.join(dir, 'cmdline'), cmdlineDe(p.args));
    if (p.cwd) { // a função roda duas vezes no M8: só cria o symlink se ainda não existir
      const alvo = path.join(dir, 'cwd');
      try { fs.lstatSync(alvo); } catch { fs.symlinkSync(p.cwd, alvo); }
    }
  }
}

/** Um executável FALSO (Node com shebang): anota `<nome> <último argumento>` no log, escreve no
 *  stderr um caminho de mentira (o corpo da rota NÃO pode trazê-lo), escreve `saida` (ou
 *  `porAlvo[último argumento]`), dorme `dormeMs` ANTES ou DEPOIS da saída e sai com `codigo`. */
function criarFalso(dir, nome, { saida = '', porAlvo = null, codigo = 0, dormeMs = 0, emiteAntes = false, log }) {
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, nome);
  const cfg = JSON.stringify({ saida, porAlvo, codigo, dormeMs, emiteAntes, log, nome });
  fs.writeFileSync(arq, `#!/usr/bin/env node
const fs = require('fs'); const c = ${cfg};
const alvo = process.argv[process.argv.length - 1];
fs.appendFileSync(c.log, c.nome + ' ' + alvo + '\\n');
process.stderr.write('du: cannot read directory /segredo/caminho-do-stderr: Permission denied\\n');
const texto = c.porAlvo ? (c.porAlvo[alvo] || '') : c.saida;
if (c.emiteAntes) process.stdout.write(texto);
setTimeout(() => { if (!c.emiteAntes) process.stdout.write(texto); process.exitCode = c.codigo; }, c.dormeMs);
`, { mode: 0o755 });
  return arq;
}
const linhasDoLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

// Fixtures de texto do disco: registros "<KiB>\t<caminho>\0" (`du -x -k -d 1 -0`).
const reg = (kib, caminho) => `${kib}\t${caminho}\0`;
const PASTAS_HOME = [['midia', 162870312], ['.orquestrador', 69563336], ['dados', 38414964], ['backups', 28029492],
  ['projetos', 23661092], ['.cache', 17394872], ['.ollama', 12115104], ['.npm', 9053408], ['.local', 8243260],
  ['.vscode-server', 5667100], ['.hermes', 3313448], ['.claude', 3169728]];
const KIB_HOME = PASTAS_HOME.reduce((s, [, k]) => s + k, 0) + 1 + 100000;
const duHome = (home) => reg(KIB_HOME, home) + PASTAS_HOME.map(([n, k]) => reg(k, `${home}/${n}`)).join('')
  + reg(1, `${home}/com\nquebra`) + 'abc\tnada\0';
const PASTAS_RAIZ = [['usr', 5730512], ['tmp', 3501932], ['var', 2622816], ['etc', 10208], ['snap', 24],
  ['lost+found', 16], ['services', 8], ['opt', 8], ['srv', 4], ['root', 4], ['mnt', 4]];
// o item que CONTÉM a home é o 1º segmento dela (com HOME=/home/x é /home; com o HOME do gate, /tmp)
const duRaiz = (home) => reg(KIB_HOME + 9000000, '/') + reg(KIB_HOME, '/' + home.split('/')[1])
  + PASTAS_RAIZ.filter(([n]) => n !== home.split('/')[1]).map(([n, k]) => reg(k, `/${n}`)).join('');
const DOCKER_TEXTO = [
  { Type: 'Images', TotalCount: '35', Active: '12', Size: '89.82GB', Reclaimable: '45.26GB (50%)' },
  { Type: 'Containers', TotalCount: '14', Active: '9', Size: '823.9MB', Reclaimable: '823.9MB (100%)' },
  { Type: 'Local Volumes', TotalCount: '20', Active: '8', Size: '22.93GB', Reclaimable: '22.93GB (100%)' },
  { Type: 'Build Cache', TotalCount: '300', Active: '0', Size: '253.1GB', Reclaimable: '157.6GB' },
  { Type: 'Outro', Size: '1GB' },
].map((o) => JSON.stringify(o)).join('\n') + '\n{"Type":"__proto__","Size":"1GB"}\nisto nao e json\n';
/** Aponta COCKPIT_DU_BIN/COCKPIT_DOCKER_BIN para falsos novos em `dir`; devolve o caminho do log. */
function usarFalsos(dir, home, { du = {}, docker = {}, log = path.join(dir, 'falsos.log') } = {}) {
  process.env.COCKPIT_DU_BIN = criarFalso(dir, 'du', { porAlvo: { [home]: duHome(home), '/': duRaiz(home) }, codigo: 1, log, ...du });
  process.env.COCKPIT_DOCKER_BIN = criarFalso(dir, 'docker', { saida: DOCKER_TEXTO, log, ...docker });
  return log;
}
const esperarAte = async (fn, tetoMs, passoMs = 50) => {
  const fim = Date.now() + tetoMs;
  while (Date.now() < fim) { if (await fn()) return true; await espera(passoMs); }
  return Boolean(await fn());
};

async function main() {
  // ─── M1 ───
  {
    const a = monitor.lerStat('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1 1 1 1 1 1 1\n');
    ok(a && a.total === 1000 && a.ocioso === 800, `M1: lerStat → total 1000, ocioso 800 (veio ${JSON.stringify(a)})`);
    const b = { total: 2000, ocioso: 1300 };
    ok(monitor.cpuEntre(a, b) === 50, `M1: cpuEntre(a, b) === 50 (veio ${monitor.cpuEntre(a, b)})`);
    ok(monitor.cpuEntre(a, a) === null, 'M1: cpuEntre(a, a) (Δ zero) → null');
    ok(monitor.cpuEntre(null, b) === null, 'M1: cpuEntre(null, b) → null');
    ok(monitor.lerStat('sem linha cpu\n') === null, 'M1: sem a linha `cpu ` → null');
  }

  // ─── M2 ───
  {
    const m = monitor.lerMeminfo('MemTotal: 32769376 kB\nMemFree: 1 kB\nMemAvailable: 26274976 kB\n');
    ok(m && m.total === 32769376 * 1024, `M2: total em bytes (veio ${m && m.total})`);
    ok(monitor.pctRam(m) === 20, `M2: pctRam === 20 (veio ${monitor.pctRam(m)})`);
    ok(monitor.lerMeminfo('MemTotal: 32769376 kB\nMemFree: 1 kB\n') === null, 'M2: sem MemAvailable → null');
  }

  // ─── M3 ───
  {
    const f = { blocks: 239287606, bfree: 45124194, bavail: 32950626, bsize: 4096 };
    const d = monitor.pctDisco(f);
    ok(d.pct === 85, `M3: pct === 85 (veio ${d.pct})`);
    ok(d.total === 239287606 * 4096, `M3: total em bytes (veio ${d.total})`);
    ok(d.usado === (239287606 - 45124194) * 4096, `M3: usado em bytes (veio ${d.usado})`);
    ok(Number.isInteger(d.total) && Number.isInteger(d.usado), 'M3: total/usado inteiros, nunca NaN');
    const big = monitor.pctDisco({ blocks: 239287606n, bfree: 45124194n, bavail: 32950626n, bsize: 4096n });
    ok(igual(big, d), `M3: os mesmos campos em BigInt dão os mesmos números (veio ${JSON.stringify(big)})`);
  }

  // ─── M4 ───
  {
    const agora = 1_800_000_000;
    const h = monitor.criarHistorico();
    h.adicionar([agora - 90000, 1, 1, 1], agora);
    ok(h.amostras().length === 0, 'M4: amostra de 25 h some mesmo com o anel vazio (a régua é o TEMPO)');
    h.adicionar([agora - 3600, 1, 1, 1], agora);
    ok(h.amostras().length === 1, 'M4: amostra de 1 h atrás fica');
    const h2 = monitor.criarHistorico();
    for (let i = 3000; i >= 1; i -= 1) h2.adicionar([agora - i * 2, 5, 5, 5], agora);
    const am = h2.amostras();
    ok(am.length === 2880, `M4: 3000 amostras de 2 s → o cinto segura em 2880 (veio ${am.length})`);
    ok(am[0][0] === agora - 2880 * 2, `M4: a primeira é a mais antiga que sobrou (veio ${agora - am[0][0]} s atrás)`);
    ok(am.every((a, i) => i === 0 || a[0] > am[i - 1][0]), 'M4: ordem preservada');
  }

  // ─── M5a ───
  {
    const agora = 1_800_000_000;
    const h1 = monitor.criarHistorico();
    h1.adicionar([agora - 120, 10, 20, 30], agora);
    h1.adicionar([agora - 60, 11, 21, 31], agora);
    h1.adicionar([agora, null, 22, 32], agora);
    h1.aviso.ram = true;
    const h2 = monitor.criarHistorico().carregar(h1.serializar(), agora);
    ok(igual(h2.amostras(), h1.amostras()), 'M5a: ida e volta do formato — mesmas amostras');
    ok(h2.aviso.ram === true && h2.aviso.cpu === false, 'M5a: aviso.ram === true sobrevive à ida e volta');
  }

  // ─── M6 ───
  {
    const agora = 1_800_000_000;
    const vazio = (h) => h.amostras().length === 0;
    const mk = (obj) => JSON.stringify(obj);
    const silenciar = console.error; console.error = () => {};
    try {
      ok(vazio(monitor.criarHistorico().carregar('x'.repeat(monitor.TETO_ARQUIVO + 1), agora)), 'M6: texto > teto → vazio');
      ok(vazio(monitor.criarHistorico().carregar('{nao json', agora)), 'M6: JSON quebrado → vazio');
      ok(vazio(monitor.criarHistorico().carregar(mk({ versao: 2, amostras: [[agora, 1, 1, 1]], aviso: {} }), agora)), 'M6: versao 2 → vazio');
    } finally { console.error = silenciar; }
    const hf = monitor.criarHistorico().carregar(mk({ versao: 1, amostras: [[agora + 600, 1, 1, 1], [agora, 1, 1, 1]], aviso: {} }), agora);
    ok(hf.amostras().length === 1 && hf.amostras()[0][0] === agora, 'M6: amostra do futuro (+10 min) some, a boa fica');
    const hp = monitor.criarHistorico().carregar(mk({ versao: 1, amostras: [[agora, 150, 1, 1], [agora, 1, 1, 1], [agora, 1, 1]], aviso: {} }), agora);
    ok(hp.amostras().length === 1, 'M6: amostra com 150 % e amostra de 3 posições somem');
  }

  // ─── M7 ───
  {
    const f = { cpu: false, ram: false, disco: false };
    ok(monitor.avaliarAviso(f, { cpuMedia: null, ram: 89, disco: null }).ram === false, 'M7: 89 → desligado');
    ok(monitor.avaliarAviso(f, { cpuMedia: null, ram: 90, disco: null }).ram === true, 'M7: 90 → ligado');
    const on = { cpu: true, ram: true, disco: true };
    ok(monitor.avaliarAviso(on, { cpuMedia: null, ram: 87, disco: 87 }).ram === true, 'M7: a partir de ligado, 87 → continua ligado (histerese)');
    ok(monitor.avaliarAviso(on, { cpuMedia: null, ram: 84, disco: null }).ram === false, 'M7: 84 → desliga');
    ok(monitor.avaliarAviso(on, { cpuMedia: null, ram: null, disco: null }).cpu === true, 'M7: cpuMedia null mantém o anterior (true)');
    const t = 1_800_000_000;
    const am = [[t - 240, 20], [t - 180, 20], [t - 120, 100], [t - 60, 20], [t, 20]];
    ok(monitor.mediaRecente(am, t, 300, 1) === 36, `M7: média [20,20,100,20,20] === 36 (veio ${monitor.mediaRecente(am, t, 300, 1)})`);
    ok(monitor.mediaRecente(am.slice(0, 2), t, 300, 1) === null, 'M7: 2 amostras → null');
    const velha = [[t - 600, 100], [t - 120, 20], [t - 60, 20], [t, 20]];
    ok(monitor.mediaRecente(velha, t, 300, 1) === 20, 'M7: amostra de 10 min atrás não entra na média');
    ok(monitor.mediaRecente([[t - 60, null], [t - 30, null], [t, 20], [t - 10, 20]], t, 300, 1) === null, 'M7: amostras null não contam');
  }

  // ─── M8 ───
  {
    const raiz = path.join(RAIZ, 'proc-m8');
    plantarPids(raiz);
    const v1 = { em: 1_000_000, mapa: await monitor.lerProcessos(raiz) };
    ok(v1.mapa.size === 13, `M8: lerProcessos acha os 13 pids (veio ${v1.mapa.size})`);
    ok(v1.mapa.get(106).nome === 'bash (x)', 'M8: nome entre o primeiro ( e o ÚLTIMO ) — "bash (x)" inteiro');
    // 2ª varredura: 101 +1000 ticks, 104 +500, 103 +200; o 107 morreu entre as varreduras
    plantarPids(raiz, { 101: 1000, 104: 500, 103: 200 });
    fs.rmSync(path.join(raiz, '107'), { recursive: true, force: true });
    const r = await monitor.processosDe(raiz, v1, v1.em + 10000, WT + path.sep);
    ok(r.cpu.length === 10, `M8: cpu tem 10 (veio ${r.cpu.length})`);
    ok(!r.cpu.some((p) => p.pid === 113 || p.pid === 105), 'M8: o 11º e o 12º de CPU ficam fora');
    ok(r.cpu[0].pid === 101 && r.cpu[0].cpu === 100, `M8: cpu[0] é o de maior Δticks (101, 100 % de um núcleo; veio ${r.cpu[0].pid}/${r.cpu[0].cpu})`);
    ok(r.cpu[1].pid === 104 && r.cpu[2].pid === 103, `M8: cpu em ordem decrescente (veio ${r.cpu.map((c) => c.pid).join(',')})`);
    ok(r.ram[0].pid === 101 && r.ram[0].rss === 300000 * 4096, `M8: ram[0] é o de maior rss, em bytes (veio ${r.ram[0].pid}/${r.ram[0].rss})`);
    ok(r.ram.length === 10, 'M8: ram tem 10');
    ok(!r.ram.some((p) => p.pid === 103 || p.pid === 105), 'M8: o 11º e o 12º de RAM ficam fora');
    const todos = [...r.cpu, ...r.ram];
    ok(todos.every((p) => typeof p.job === 'boolean'), 'M8: job é booleano em todos');
    ok(r.cpu.find((p) => p.pid === 101).job === true, 'M8: 101 (cwd dentro da worktree) é job');
    ok(r.cpu.find((p) => p.pid === 104).job === false, 'M8: 104 (cwd fora da worktree) não é job');
    ok(!JSON.stringify(todos).includes('worktrees'), 'M8: só o booleano sai, nunca o caminho');
    ok(!todos.some((p) => p.pid === 107), 'M8: o pid removido entre as varreduras não aparece');
    const comandos = todos.map((p) => p.comando);
    const proibido = comandos.filter((c) => /[\/]|abc123|senha|secreta|home/.test(c));
    ok(proibido.length === 0, `M8: nenhum comando contém "/", abc123, senha, secreta ou home (vazaram: ${JSON.stringify(proibido)})`);
    ok(comandos.every((c) => c.length <= 60), 'M8: todos os comandos têm ≤ 60 caracteres');
    ok(monitor.comandoCurto(['node', '/x/ua-grafo-det.mjs', '--threads', '4'].join('\0')) === 'node ua-grafo-det.mjs --threads …',
      `M8: comandoCurto do processo do incidente (veio "${monitor.comandoCurto(['node', '/x/ua-grafo-det.mjs', '--threads', '4'].join('\0'))}")`);
    const c102 = r.ram.concat(r.cpu).find((p) => p.pid === 102);
    ok(c102 && c102.comando === 'claude -p … --token', `M8: claude -p '<texto>' --token=abc123 → "claude -p … --token" (veio "${c102 && c102.comando}")`);
    ok(monitor.comandoCurto('') === '' && monitor.comandoCurto([]) === '', 'M8: cmdline vazio → ""');
    // primeira chamada, sem varredura anterior: faz a 2ª varredura sozinha
    const t0 = Date.now();
    const sozinha = await monitor.processosDe(raiz, null, Date.now(), WT + path.sep);
    const dur = Date.now() - t0;
    ok(dur >= 1000, `M8: sem varredura anterior a função espera ≥ 1 s e varre de novo (levou ${dur} ms)`);
    ok(sozinha.cpu.length === 10 && sozinha.ram.length === 10, 'M8: …e devolve 10 + 10');
  }

  // ─── D0 — o módulo da medida do disco (D68, lib/monitor-disco.js) ───
  ok(disco !== null, 'D0: lib/monitor-disco.js existe e carrega');

  if (disco) {
    const antigoErro = console.error;
    const guardaEnv = ['HOME', 'COCKPIT_DU_BIN', 'COCKPIT_DOCKER_BIN', 'COCKPIT_MONITOR_DIR', 'COCKPIT_MONITOR_MS']
      .map((k) => [k, process.env[k]]);
    try {
      // ─── D1 — lerSaidaDu ───
      {
        const home = '/home/fulano';
        const r = disco.lerSaidaDu(duHome(home), home, home);
        ok(r.total === KIB_HOME * 1024, `D1: total = KiB do próprio alvo × 1024 (veio ${r.total})`);
        ok(r.itens.length === 10, `D1: 10 itens (veio ${r.itens.length})`);
        ok(r.itens[0].rotulo === '~/midia' && r.itens[0].bytes === 162870312 * 1024, `D1: o 1º é ~/midia com os bytes certos (veio ${JSON.stringify(r.itens[0])})`);
        ok(!r.itens.some((i) => /hermes|claude/.test(i.rotulo)), 'D1: o 11º e o 12º (.hermes, .claude) ficam fora');
        ok(r.itens.every((i, k) => k === 0 || r.itens[k - 1].bytes >= i.bytes), 'D1: ordem decrescente por bytes');
        ok(!JSON.stringify(r).includes('fulano'), 'D1: o nome do usuário nunca sai (a home vira ~)');
        const q = disco.lerSaidaDu('5\t/a/x\ny\0' + '9\t/a\0' + '3\t/a/x/z\0' + 'lixo sem tab\0' + '2\t/b/fora\0', '/a', '/h');
        ok(q.itens.length === 1 && q.itens[0].rotulo === '/a/x\ny', `D1: caminho com \\n no nome sobrevive; lixo, profundidade 2 e caminho fora do alvo ignorados (veio ${JSON.stringify(q.itens)})`);
        ok(q.total === 9 * 1024, 'D1: total do alvo pequeno');
        const raiz = disco.lerSaidaDu(duRaiz(home), '/', home);
        const h = raiz.itens.find((i) => i.rotulo === '/home'); const u = raiz.itens.find((i) => i.rotulo === '/usr');
        ok(h && h.contemHome === true, 'D1: /home tem contemHome === true');
        ok(u && u.contemHome === false, 'D1: /usr tem contemHome === false');
        ok(raiz.itens.length === 10 && raiz.itens.every((i) => /^\/[^/]+$/.test(i.rotulo)), `D1: raiz → 10 itens com rótulo /<nome> (veio ${raiz.itens.map((i) => i.rotulo).join(',')})`);
      }

      // ─── D2 — Docker ───
      {
        ok(disco.bytesDocker('89.82GB') === 89820000000, 'D2: bytesDocker("89.82GB") === 89820000000');
        ok(disco.bytesDocker('823.9MB') === 823900000, 'D2: bytesDocker("823.9MB") === 823900000');
        ok(disco.bytesDocker('0B') === 0, 'D2: bytesDocker("0B") === 0');
        ok(disco.bytesDocker('lixo') === null && disco.bytesDocker(undefined) === null, 'D2: lixo e undefined → null');
        ok(!Number.isNaN(disco.bytesDocker('1.5.2GB')), 'D2: nada de NaN');
        const d = disco.lerDockerDf(DOCKER_TEXTO);
        ok(igual(d.map((x) => x.tipo), ['imagens', 'conteineres', 'volumes', 'cache']), `D2: 4 itens na ordem fixa (veio ${d.map((x) => x.tipo)})`);
        ok(d[0].recuperavel === 45260000000 && d[0].bytes === 89820000000, `D2: imagens.recuperavel vem do primeiro pedaço de "45.26GB (50%)" (veio ${d[0].recuperavel})`);
        ok(d[3].recuperavel === 157600000000, `D2: cache sem percentual (veio ${d[3].recuperavel})`);
        ok(d.length === 4, 'D2: tipo Outro e __proto__ ignorados');
      }

      // ─── D3 — medir() com du/docker FALSOS ───
      {
        const home = path.join(RAIZ, 'home-d3');
        process.env.HOME = home;
        const dir = path.join(RAIZ, 'falsos-d3');
        let log = usarFalsos(dir, home);
        let m = await disco.medir();
        ok(m.home && m.home.itens.length === 10 && m.raiz && m.raiz.itens.length === 10 && m.docker && m.docker.length === 4 && igual(m.falhas, {}),
          `D3: du que sai 1 com saída vale; 10 + 10 + 4, falhas vazio (veio ${JSON.stringify(m.falhas)})`);
        ok(m.home.rotulo === '~' && m.raiz.rotulo === '/', 'D3: rótulos ~ e /');
        ok(linhasDoLog(log).length === 3, `D3: três chamadas (veio ${linhasDoLog(log).length})`);

        usarFalsos(path.join(RAIZ, 'falsos-d3b'), home, { docker: { codigo: 1 } });
        m = await disco.medir();
        ok(m.falhas.docker === 'indisponivel' && m.home && m.raiz && m.docker === null, `D3: docker sai 1 → falhas.docker === indisponivel e as pastas seguem (veio ${JSON.stringify(m.falhas)})`);

        usarFalsos(path.join(RAIZ, 'falsos-d3c'), home);
        process.env.COCKPIT_DU_BIN = '/nao/existe';
        m = await disco.medir();
        ok(m.falhas.home === 'indisponivel' && m.falhas.raiz === 'indisponivel', `D3: bin inexistente → indisponivel (veio ${JSON.stringify(m.falhas)})`);

        usarFalsos(path.join(RAIZ, 'falsos-d3d'), home, { du: { emiteAntes: true, dormeMs: 3000 } });
        m = await disco.medir({ tempoDuMs: 300 });
        ok(m.falhas.home === 'tempo' && m.home === null, `D3: du que emite e dorme além do teto → tempo e a saída parcial é DESCARTADA (veio ${JSON.stringify(m.falhas)})`);

        usarFalsos(path.join(RAIZ, 'falsos-d3e'), home, { du: { porAlvo: null, saida: '', codigo: 0 } });
        m = await disco.medir();
        ok(m.falhas.home === 'vazio', `D3: du código 0 sem saída → vazio (veio ${JSON.stringify(m.falhas)})`);

        usarFalsos(path.join(RAIZ, 'falsos-d3f'), home, { du: { porAlvo: null, saida: 'x'.repeat(5 << 20), codigo: 0 } });
        m = await disco.medir();
        ok(m.falhas.home === 'saida', `D3: du que escreve 5 MiB → saida (maxBuffer de 4 MiB; veio ${JSON.stringify(m.falhas)})`);
      }

      // ─── D4 trava / D5 persistência ───
      const dirD5 = path.join(RAIZ, 'dir-d5');
      const homeD5 = path.join(RAIZ, 'home-d5');
      let medidaD5 = null;
      {
        process.env.HOME = homeD5; process.env.COCKPIT_MONITOR_DIR = dirD5;
        const log = usarFalsos(path.join(RAIZ, 'falsos-d4'), homeD5, { du: { dormeMs: 400 }, docker: { dormeMs: 400 } });
        disco._zerarParaTeste();
        const a = disco.medirAgora(); const b = disco.medirAgora();
        ok(a === b, 'D4: duas medirAgora() simultâneas → a MESMA promessa');
        medidaD5 = await a;
        ok(linhasDoLog(log).length === 3, `D4: o log tem exatamente 3 linhas — 2 du + 1 docker (veio ${linhasDoLog(log).length})`);
        ok(linhasDoLog(log).filter((l) => l.startsWith('du ')).length === 2, 'D4: duas chamadas de du');

        const arq = path.join(dirD5, 'disco.json');
        ok(fs.existsSync(arq) && (fs.statSync(arq).mode & 0o777) === 0o600, 'D5: disco.json existe com modo 0600');
        ok(!fs.readdirSync(dirD5).some((n) => n.endsWith('~')), 'D5: nenhum temporário sobrou');
        disco._zerarParaTeste();
        const e = await disco.estado();
        ok(e.medida && e.medida.em === medidaD5.em, 'D5: _zerarParaTeste + estado() relê do arquivo (mesmo em)');
        console.error = () => {};
        const bom = JSON.parse(fs.readFileSync(arq, 'utf8'));
        const casos = [['{lixo', 'JSON lixo'], [JSON.stringify({ ...bom, versao: 2 }), 'versao 2'],
          [JSON.stringify({ ...bom, lixo: 'x'.repeat(disco.TETO_ARQUIVO) }), 'maior que o teto']];
        for (const [texto, nome] of casos) {
          fs.writeFileSync(arq, texto);
          disco._zerarParaTeste();
          ok((await disco.estado()).medida === null, `D5: arquivo inválido (${nome}) → sem medida`);
        }
        console.error = antigoErro;
        fs.writeFileSync(arq, JSON.stringify(bom));
      }

      // ─── D6 medida velha ───
      {
        const arq = path.join(dirD5, 'disco.json');
        const bom = JSON.parse(fs.readFileSync(arq, 'utf8'));
        const log = usarFalsos(path.join(RAIZ, 'falsos-d6'), homeD5);
        const agoraS = Math.floor(Date.now() / 1000);
        fs.writeFileSync(arq, JSON.stringify({ ...bom, em: agoraS - 7 * 3600 }));
        disco._zerarParaTeste();
        const e = await disco.estado({ disparar: true });
        ok(e.medindo === true, 'D6: medida de 7 h + disparar → medindo === true');
        await esperarAte(async () => !(await disco.estado()).medindo, 5000);
        ok(linhasDoLog(log).length === 3, `D6: a medição velha rodou (log com ${linhasDoLog(log).length} linhas)`);
        fs.writeFileSync(arq, JSON.stringify({ ...bom, em: agoraS - 3600 }));
        disco._zerarParaTeste();
        const antes = linhasDoLog(log).length;
        const e2 = await disco.estado({ disparar: true });
        ok(e2.medindo === false && linhasDoLog(log).length === antes, 'D6: medida de 1 h → não dispara');
      }

      // ─── D7 relógio ───
      {
        const stub = []; console.error = (...a) => { stub.push(a.join(' ')); };
        process.env.COCKPIT_MONITOR_MS = '0';
        const r = disco.iniciar();
        console.error = antigoErro;
        ok(r === null && stub.length === 0, `D7: COCKPIT_MONITOR_MS=0 → iniciar() null e calado (linhas: ${stub.length})`);
      }

      // ─── D9 tudo falhou ───
      {
        const dirD9 = path.join(RAIZ, 'dir-d9');
        process.env.COCKPIT_MONITOR_DIR = dirD9;
        const home = path.join(RAIZ, 'home-d9');
        process.env.HOME = home;
        const log = usarFalsos(path.join(RAIZ, 'falsos-d9-bom'), home);
        disco._zerarParaTeste();
        const m1 = await disco.medirAgora();
        const arq = path.join(dirD9, 'disco.json');
        const antesTexto = fs.readFileSync(arq, 'utf8');
        usarFalsos(path.join(RAIZ, 'falsos-d9-ruim'), home, { du: { porAlvo: null, saida: '', codigo: 2 }, docker: { codigo: 1 }, log });
        const n0 = linhasDoLog(log).length;
        await disco.medirAgora();
        const e = await disco.estado();
        ok(linhasDoLog(log).length === n0 + 3, 'D9: a medição ruim rodou os três processos');
        ok(e.medida && e.medida.em === m1.em && e.falhou === true, `D9: tudo falhou → a medida anterior continua e falhou === true (veio em=${e.medida && e.medida.em}, falhou=${e.falhou})`);
        ok(fs.readFileSync(arq, 'utf8') === antesTexto, 'D9: disco.json com o MESMO conteúdo de antes');
        const n1 = linhasDoLog(log).length;
        const e2 = await disco.estado({ disparar: true, validadeS: 0 });
        ok(e2.medindo === false && linhasDoLog(log).length === n1, 'D9: disparo automático logo depois NÃO roda (espera de 15 min)');
        await disco.medirAgora();
        ok(linhasDoLog(log).length === n1 + 3, 'D9: "medir agora" ignora a espera (log cresce 3)');

        // D9b — a espera conta do FIM da tentativa, não do começo (achado do painel de execução):
        // uma falha total que DEMORA (dois `du` estourando o teto de 15 min) não pode sair já com a
        // espera vencida. Em escala: cada falso falha depois de 1,2 s (~3,6 s a tentativa) e a
        // espera vira 3 s. Contada do começo, ela já venceu quando a tentativa acaba e o GET dispara.
        usarFalsos(path.join(RAIZ, 'falsos-d9b-lento'), home, { du: { porAlvo: null, saida: '', codigo: 2, dormeMs: 1200 }, docker: { codigo: 1, dormeMs: 1200 }, log });
        await disco.medirAgora();
        const n2 = linhasDoLog(log).length;
        const e3 = await disco.estado({ disparar: true, validadeS: 0, esperaS: 3 });
        ok(e3.medindo === false && linhasDoLog(log).length === n2, `D9b: falha total LENTA → a espera começa no fim dela; o GET logo depois NÃO dispara (medindo=${e3.medindo})`);
        await esperarAte(async () => !(await disco.estado()).medindo, 10000);
      }
    } finally {
      console.error = antigoErro;
      disco._zerarParaTeste();
      for (const [k, v] of guardaEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }


  // ─── M9 / M9b / M5b — o amostrador, contra um /proc falso e um statfs real de pasta real ───
  const statTexto = (total, ocioso) => `cpu  ${total - ocioso} 0 0 ${ocioso} 0 0 0 0 0 0\ncpu0 1 1 1 1 1 1 1 1 1 1\n`;
  const memTexto = (totalKb, dispKb) => `MemTotal: ${totalKb} kB\nMemFree: 1 kB\nMemAvailable: ${dispKb} kB\n`;
  const plantarRaiz = (dir, stat, mem) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stat'), stat);
    fs.writeFileSync(path.join(dir, 'meminfo'), mem);
  };
  const lerHistorico = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'historico.json'), 'utf8'));

  {
    // M9 — interruptor e faixa
    const stub = []; const antigo = console.error; console.error = (...a) => { stub.push(a.join(' ')); };
    try {
      monitor._zerarParaTeste();
      process.env.COCKPIT_MONITOR_MS = '0';
      ok(monitor.iniciar() === null && stub.length === 0, `M9: COCKPIT_MONITOR_MS=0 → null e calado (linhas: ${stub.length})`);
      process.env.COCKPIT_MONITOR_MS = '5';
      ok(monitor.iniciar() === null && stub.length === 1, `M9: '5' (fora da faixa) → null e UMA linha de erro (linhas: ${stub.length})`);
    } finally { console.error = antigo; }

    const raiz = path.join(RAIZ, 'proc-m9'); const dir = path.join(RAIZ, 'dir-m9');
    plantarRaiz(raiz, statTexto(1000, 900), memTexto(1000000, 400000));
    process.env.COCKPIT_PROC_RAIZ = raiz;
    process.env.COCKPIT_MONITOR_DIR = dir;
    process.env.COCKPIT_MONITOR_DISCO = dir.replace(/[^/]+$/, '');
    fs.mkdirSync(dir, { recursive: true });
    process.env.COCKPIT_MONITOR_MS = '60000';
    monitor._zerarParaTeste();
    await monitor.preparar();
    const r = monitor.iniciar();
    ok(r && typeof r.parar === 'function', 'M9: 60000 → devolve { parar }');
    ok(monitor.estado().relogio === true, 'M9: estado().relogio === true com o relógio ligado');
    await espera(300);
    const h = lerHistorico(dir);
    ok(h.versao === 1 && h.amostras.length === 1, `M9: historico.json existe com 1 amostra (veio ${h.amostras.length})`);
    const [, cpu, ram, disco] = h.amostras[0];
    ok(cpu === null && ram === 60 && Number.isInteger(disco), `M9: cpu null (1ª batida), ram 60, disco inteiro (veio ${JSON.stringify(h.amostras[0])})`);
    ok((fs.statSync(path.join(dir, 'historico.json')).mode & 0o777) === 0o600, 'M9: historico.json com modo 0600');
    ok(!fs.readdirSync(dir).some((n) => n.endsWith('~')), 'M9: nenhum temporário sobrou (rename atômico)');
    r.parar();
    ok(monitor.estado().relogio === false, 'M9: parar() desliga o relógio');
  }

  {
    // M9b — duas referências: o amostrador mede o minuto INTEIRO, não o intervalo do cliente
    const raiz = path.join(RAIZ, 'proc-m9b'); const dir = path.join(RAIZ, 'dir-m9b');
    const v1 = statTexto(1000, 900), v2 = statTexto(2000, 1000), v3 = statTexto(3000, 1900);
    plantarRaiz(raiz, v1, memTexto(1000000, 400000));
    process.env.COCKPIT_PROC_RAIZ = raiz; process.env.COCKPIT_MONITOR_DIR = dir;
    process.env.COCKPIT_MONITOR_MS = '60000';
    monitor._zerarParaTeste();
    await monitor.preparar();
    await espera(1100);
    fs.writeFileSync(path.join(raiz, 'stat'), v2);
    const a1 = await monitor.agora(); const a2 = await monitor.agora(); const a3 = await monitor.agora();
    ok(a1.cpu === 90, `M9b: o cliente mede v1→v2 = 90 % (veio ${a1.cpu})`);
    ok(a2 === a1 && a3 === a1, 'M9b: a 2ª e a 3ª chamadas vêm do cache de 5 s');
    await espera(1100);
    fs.writeFileSync(path.join(raiz, 'stat'), v3);
    const r = monitor.iniciar();
    await espera(300);
    r.parar();
    const cpu = lerHistorico(dir).amostras[0][1];
    const lido = (t) => monitor.lerStat(t);
    const inteiro = monitor.cpuEntre(lido(v1), lido(v3)), curto = monitor.cpuEntre(lido(v2), lido(v3));
    ok(inteiro === 50 && curto === 10, `M9b: as fixtures separam os dois números (50 × 10; veio ${inteiro} × ${curto})`);
    ok(cpu === inteiro, `M9b: a amostra gravada mede o intervalo INTEIRO v1→v3 (${inteiro}), não v2→v3 (${curto}); veio ${cpu}`);
  }

  {
    // M5b — o restart REAL, pelo arquivo: a histerese sobrevive
    const raiz = path.join(RAIZ, 'proc-m5b'); const dir = path.join(RAIZ, 'dir-m5b');
    plantarRaiz(raiz, statTexto(1000, 900), memTexto(1000000, 60000)); // RAM a 94 %
    process.env.COCKPIT_PROC_RAIZ = raiz; process.env.COCKPIT_MONITOR_DIR = dir;
    process.env.COCKPIT_MONITOR_MS = '60000';
    monitor._zerarParaTeste();
    await monitor.preparar();
    const r = monitor.iniciar();
    await espera(300);
    r.parar();
    ok(monitor.historicoAtual().aviso.ram === true, 'M5b: com a RAM a 94 % o aviso liga na primeira batida');
    monitor._zerarParaTeste();
    ok(monitor.historicoAtual().amostras.length === 0 && monitor.historicoAtual().aviso.ram === false, 'M5b: o módulo zerado não lembra de nada (é o "processo novo")');
    await monitor.preparar();
    const depois = monitor.historicoAtual();
    ok(depois.amostras.length === 1 && depois.aviso.ram === true, `M5b: o restart lê o arquivo — 1 amostra e aviso.ram === true (veio ${depois.amostras.length}/${depois.aviso.ram})`);
  }
  monitor._zerarParaTeste();
  process.env.COCKPIT_MONITOR_MS = '0';
  process.env.COCKPIT_MONITOR_DIR = path.join(RAIZ, 'monitor');
  delete process.env.COCKPIT_PROC_RAIZ;
  delete process.env.COCKPIT_MONITOR_DISCO;

  // ─── M10 — as três rotas, contra `server.js` DE VERDADE em processo FILHO ───
  // Nunca `require('server.js')`: ele sobe no `require`, na porta de produção.
  {
    const portaLivre = (porta) => {
      try {
        const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
        return !saida.split('\n').some((l) => (l.trim().split(/\s+/)[3] || '').endsWith(`:${porta}`));
      } catch { return true; }
    };
    // SÓ da lista — nunca `process.env.PORT`; nunca 7879 (produção), 7899 (jobs), 7897 (celular).
    const PORTA = [7893, 7892, 7891, 7894, 7895].find(portaLivre);
    const TOKEN = 'gate-monitor';
    const raizM10 = path.join(RAIZ, 'm10');
    const proc = path.join(raizM10, 'proc'); const dirHist = path.join(raizM10, 'monitor');
    const certVazio = path.join(raizM10, 'cert-vazio');
    fs.mkdirSync(certVazio, { recursive: true }); fs.mkdirSync(dirHist, { recursive: true });
    plantarRaiz(proc, statTexto(1000, 900), memTexto(32000000, 25600000)); // RAM 20 %
    plantarPids(proc);
    const agoraS = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(dirHist, 'historico.json'), JSON.stringify({
      versao: 1, amostras: [[agoraS - 180, 10, 20, 30], [agoraS - 120, 11, 21, 31], [agoraS - 60, 12, 22, 32]],
      aviso: { cpu: false, ram: false, disco: true },
    }));
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('COCKPIT_')) delete env[k];
    // D8: du/docker FALSOS (o GET de /api/monitor/disco dispara a medida — nunca o `du` de verdade)
    const homeM10 = path.join(raizM10, 'home');
    const logM10 = path.join(raizM10, 'falsos.log');
    const falsoDu = criarFalso(path.join(raizM10, 'falsos'), 'du', { porAlvo: { [homeM10]: duHome(homeM10), '/': duRaiz(homeM10) }, codigo: 1, dormeMs: 300, log: logM10 });
    const falsoDocker = criarFalso(path.join(raizM10, 'falsos'), 'docker', { saida: DOCKER_TEXTO, log: logM10 });
    Object.assign(env, {
      COCKPIT_DU_BIN: falsoDu, COCKPIT_DOCKER_BIN: falsoDocker,
      PORT: String(PORTA), HOST: '127.0.0.1', COCKPIT_CERT_DIR: certVazio, COCKPIT_TOKEN: TOKEN,
      HOME: path.join(raizM10, 'home'), COCKPIT_MONITOR_DIR: dirHist, COCKPIT_MONITOR_MS: '0',
      COCKPIT_PROC_RAIZ: proc, COCKPIT_VIGIA_MS: '0', COCKPIT_JOBS_DIR: path.join(raizM10, 'jobs-inexistente'),
      COCKPIT_TMUX_SOCKET: `gate-monitor-${process.pid}`, COCKPIT_WORKTREES_DIR: WT,
    });
    const pedir = (metodo, rota, { semToken = false } = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo,
        headers: semToken ? {} : { authorization: `Bearer ${TOKEN}` } }, (res) => {
        let bruto = ''; res.setEncoding('utf8');
        res.on('data', (c) => { bruto += c; });
        res.on('end', () => { let corpo = null; try { corpo = JSON.parse(bruto); } catch { /* não-JSON */ } resolve({ status: res.statusCode, corpo }); });
      });
      req.on('error', reject); req.end();
    });
    let filho = null;
    try {
      ok(PORTA !== undefined, `M10: achou porta livre na lista (${PORTA})`);
      filho = await new Promise((resolve, reject) => {
        const f = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
        let saiu = false;
        f.once('exit', (c) => { if (!saiu) reject(new Error(`server.js caiu antes de subir (código ${c})`)); });
        f.stdout.on('data', (d) => { if (!saiu && String(d).includes('cockpit-agentes em')) { saiu = true; resolve(f); } });
        f.stderr.on('data', (d) => process.stderr.write(`[server.js:${PORTA}] ${d}`));
        setTimeout(() => { if (!saiu) { saiu = true; resolve(f); } }, 3000);
      });
      const sem = await pedir('GET', '/api/monitor', { semToken: true });
      ok(sem.status === 401, `M10: GET /api/monitor sem token → 401 (veio ${sem.status})`);
      const r = await pedir('GET', '/api/monitor');
      const ag = r.corpo && r.corpo.agora;
      ok(r.status === 200 && ag && ag.ram === 20, `M10: /api/monitor → 200 e agora.ram === 20 (veio ${r.status}/${ag && ag.ram})`);
      ok(ag && ['ramUsado', 'ramTotal', 'discoTotal', 'discoUsado'].every((k) => Number.isInteger(ag[k])), `M10: ramUsado/ramTotal/discoTotal/discoUsado inteiros, nunca NaN (veio ${JSON.stringify(ag)})`);
      ok(r.corpo.aviso.disco === true, 'M10: aviso.disco === true — vem do arquivo carregado pelo preparar()');
      ok(r.corpo.limites.liga === 90 && r.corpo.limites.desliga === 85, 'M10: limites 90/85 publicados');
      ok(r.corpo.maquina === os.hostname(), 'M10: /api/monitor devolve maquina === os.hostname()');
      ok(r.corpo.relogio === false, 'M10: relogio === false (COCKPIT_MONITOR_MS=0), mas a rota mede ao vivo');
      const hi = await pedir('GET', '/api/monitor/historico');
      ok(hi.status === 200 && hi.corpo.amostras.length === 3, `M10: /historico devolve as 3 amostras da fixture (veio ${hi.corpo && hi.corpo.amostras.length})`);
      ok(hi.corpo.fim - hi.corpo.inicio === 86400, 'M10: /historico fim − inicio === 86400');
      const pr = await pedir('GET', '/api/monitor/processos');
      ok(pr.status === 200 && pr.corpo.cpu.length === 10 && pr.corpo.ram.length === 10, `M10: /processos → 10 + 10 (veio ${pr.corpo && pr.corpo.cpu.length}/${pr.corpo && pr.corpo.ram.length})`);
      ok(pr.corpo.cpu.some((p) => p.job === true), 'M10: algum item de /processos cpu com job === true');
      const textos = [...pr.corpo.cpu, ...pr.corpo.ram].map((p) => p.comando);
      ok(!textos.some((c) => /\/|abc123/.test(c)), `M10: nenhum comando com "/" nem abc123 (${JSON.stringify(textos.filter((c) => /\/|abc123/.test(c)))})`);
      const post = await pedir('POST', '/api/monitor');
      ok(post.status === 404, `M10: POST /api/monitor → 404 (veio ${post.status})`);

      // ─── D8 — as rotas do disco ───
      const corposD8 = [];
      const semD = await pedir('GET', '/api/monitor/disco', { semToken: true });
      ok(semD.status === 401, `D8: GET /api/monitor/disco sem token → 401 (veio ${semD.status})`);
      const d1 = await pedir('GET', '/api/monitor/disco'); corposD8.push(d1.corpo);
      ok(d1.status === 200 && d1.corpo && d1.corpo.medindo === true && d1.corpo.medida === null, `D8: 1ª resposta → medindo === true e medida === null (veio ${JSON.stringify(d1.corpo)})`);
      let dN = d1;
      await esperarAte(async () => { dN = await pedir('GET', '/api/monitor/disco'); return dN.corpo && dN.corpo.medida; }, 10000, 200);
      corposD8.push(dN.corpo);
      const md = dN.corpo && dN.corpo.medida;
      ok(md && md.home.itens.length === 10 && md.raiz.itens.length === 10 && md.docker.length === 4, 'D8: a medida chega com 10 + 10 + 4');
      ok(linhasDoLog(logM10).length === 3, `D8: o log tem 3 linhas (veio ${linhasDoLog(logM10).length})`);
      const [p1, p2] = await Promise.all([pedir('POST', '/api/monitor/disco'), pedir('POST', '/api/monitor/disco')]);
      corposD8.push(p1.corpo, p2.corpo);
      ok(p1.status === 202 && p2.status === 202 && p1.corpo.medindo === true && p2.corpo.medindo === true, `D8: dois POST simultâneos → 202 + 202 com medindo === true (veio ${p1.status}/${p2.status})`);
      await esperarAte(async () => { const x = await pedir('GET', '/api/monitor/disco'); return x.corpo && x.corpo.medindo === false; }, 10000, 200);
      ok(linhasDoLog(logM10).length === 6, `D8: o log tem 6 linhas — 3 + 3, não 3 + 6 (veio ${linhasDoLog(logM10).length})`);
      const brutoD8 = JSON.stringify(corposD8);
      ok(!brutoD8.includes('raizM10') && !brutoD8.includes(raizM10) && !brutoD8.includes('segredo'), 'D8: nenhum corpo traz a home absoluta nem o stderr do falso');
      const put = await pedir('PUT', '/api/monitor/disco');
      ok(put.status === 404, `D8: PUT /api/monitor/disco → 404 (veio ${put.status})`);
    } finally {
      if (filho && !filho.killed) filho.kill('SIGTERM'); // pelo PID — nunca pkill (#19)
    }
  }

  // ─── M-rede — todo script que SOBE server.js isola o monitor (#82) ───
  // O amostrador escreve em disco desde o boot de qualquer server.js; a pergunta não é "quem
  // exercita o monitor?" e sim "quem sobe server.js?". Molde: A10 de `gate-jobs-disco.js`.
  {
    const dirTestes = __dirname;
    const allowlist = {
      'gate-ui.js': 'cita server.js no texto; o servidor dele é fixture própria',
      'smoke-celular-medidor.js': 'exige BASE= de quem chama — não sobe servidor',
      'smoke-catalogo-codex.js': 'servidor de mentira próprio',
      'gate-jobs-disco.js': 'só cita server.js no texto da A10',
      'gate-vigia-abas.js': 'só cita em comentário',
      'gate-terminou.js': 'só lê o server.js como texto (T16, fiação do terminouEm); não sobe servidor',
      'gate-monitor.js': 'é este gate',
      'gate-publicacao.js': 'cria um server.js de uma linha num repo-fixture e roda só o prepara-publicacao; não sobe servidor',
    };
    const reprovados = [];
    const semDu = [];
    const semGh = [];
    let examinados = 0;
    for (const nome of fs.readdirSync(dirTestes).filter((n) => /\.(js|mjs|py)$/.test(n))) {
      if (allowlist[nome]) continue;
      const texto = fs.readFileSync(path.join(dirTestes, nome), 'utf8');
      if (!texto.includes('server.js')) continue;
      examinados += 1;
      const isola = texto.includes('COCKPIT_MONITOR_') || /\bHOME['"]?\s*[:=]/.test(texto) || texto.includes('subirServidor');
      if (!isola) reprovados.push(nome);
      // D68: abrir o painel (ou a rota do disco) dispara `du /` e `docker system df` de verdade — quem
      // faz isso tem de injetar o falso.
      if ((texto.includes('monitor/disco') || texto.includes('dialogo-monitor')) && !texto.includes('COCKPIT_DU_BIN')) semDu.push(nome);
      // D97: a raiz do /diff/ chama `api/diff/prs`, que roda `gh` (rede, GitHub). Quem abre a diff NUM NAVEGADOR
      // (puppeteer) injeta o falso. Só citar `/diff/` não basta: `gate-diff.js` pede a casca por HTTP sem navegador e
      // `gate-grafo-rota.js:281` cita "diff/config" num rótulo (falsos positivos medidos pelo painel do plano).
      if (texto.includes('puppeteer') && /\/diff\//.test(texto) && !texto.includes('COCKPIT_GH_BIN')) semGh.push(nome);
    }
    ok(examinados >= 15, `M-rede: examinou ${examinados} scripts que citam server.js (esperado ≥ 15 — o critério não pode ter ficado cego)`);
    ok(reprovados.length === 0, `M-rede: todo script que sobe server.js isola o monitor (sem isolamento: ${reprovados.join(', ') || 'nenhum'})`);
    ok(semDu.length === 0, `M-rede: quem abre o painel do disco injeta COCKPIT_DU_BIN (sem: ${semDu.join(', ') || 'nenhum'})`);
    ok(semGh.length === 0, `M-rede: quem abre /diff/ injeta COCKPIT_GH_BIN (sem: ${semGh.join(', ') || 'nenhum'})`);
    ok(fs.readFileSync(path.join(dirTestes, 'fixtures-arquivos.js'), 'utf8').includes('COCKPIT_MONITOR_'), 'M-rede: o helper fixtures-arquivos.js cita COCKPIT_MONITOR_');
  }

  fs.rmSync(RAIZ, { recursive: true, force: true });
  console.log(falhas ? `\n❌ ${falhas} falha(s)` : '\n✅ gate-monitor verde');
  process.exitCode = falhas ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
