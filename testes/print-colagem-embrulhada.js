#!/usr/bin/env node
'use strict';
// PRINT DO CARD `fila-presa-com-colagem-embrulhada` — celular 390×844, CLI real (2.1.280).
//
// Regra da casa (25/08): mudou tela, tem print, e o print tem que conter o que mudou. Aqui o
// alvo é a bolha da COLAGEM (várias linhas, com foto, enviada com o turno rodando — o caso H
// da spec) saindo da fila:
//
//   ANTES=1  → o código da `develop` COM a válvula da Fase 1 (armadilha #78) mas SEM o
//              conserto: a bolha fica `bolha-pendente` para sempre, mesmo depois do turno
//              acabar e depois de recarregar a página.
//   ANTES=0  → esta branch: a bolha sai da fila e a recarga mostra o texto limpo, com o
//              clipe `📎 Image #N`, sem cabeçalho cru.
//
// Como rodar os dois lados:
//   SAIDA=~/.cockpit/smoke-shots/2026-09-24-colagem-embrulhada/depois node testes/print-colagem-embrulhada.js
//   (e o mesmo arquivo, com ANTES=1, de dentro de uma cópia do commit da Fase 1 — ver plano §6.3)
//
// Porta 7891 (7879 é PRODUÇÃO, 7899 é dos jobs — nunca; 7890/7893/7894/7896/7897 ocupadas).
// Idioma forçado em pt-BR no localStorage, como o molde `print-escrever-na-pergunta.js`.
//
// Códigos de saída: 0 = verde · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta dos PNGs> (use ~/.cockpit/smoke-shots/..., nunca /tmp)');
  process.exit(2);
}
const ANTES = process.env.ANTES === '1';
const PORTA = 7891;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';

let falhas = 0;
let feitos = 0;
const ok = (c, t) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}". Abortando.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-colagem-${process.pid}`;

function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}
if (t(['list-sessions'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} já existe. Abortando.`);
  process.exit(1);
}

const BIN = '/usr/bin/claude';
if (!fs.existsSync(BIN)) { console.error(`⚠️  não há claude em ${BIN}.`); process.exit(2); }
try { execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' }); } catch {
  console.error(`⚠️  a imagem docker ${IMAGEM} não existe.`); process.exit(2);
}

const RAIZ_CODIGO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'print-colagem-'));
const LIDAS = path.join(TMP, 'lidas');            // #78 — nunca o ~/.cockpit de produção
const PUSH = path.join(TMP, 'push');
const ANEXOS = path.join(TMP, 'anexos');
const SEM_JOBS = path.join(TMP, 'sem-jobs');
const CWD_AGENTE = path.join(TMP, 'projeto');
fs.mkdirSync(CWD_AGENTE, { recursive: true });
// ~30 linhas — para o turno de `Read` em laço (8x) demorar o suficiente para caber o envio
// da colagem NO MEIO dele (caso H da spec).
fs.writeFileSync(path.join(CWD_AGENTE, 'leiame.txt'),
  Array.from({ length: 30 }, (_, i) => `linha ${i + 1} do leiame de teste`).join('\n') + '\n');
fs.copyFileSync(path.join(RAIZ_CODIGO, 'public', 'icone-192.png'), path.join(TMP, 'foto.png'));
fs.mkdirSync(SAIDA, { recursive: true });

const ENV_SERVIDOR = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: String(PORTA),
  COCKPIT_CERT_DIR: '/dev/null',
  COCKPIT_TMUX_SOCKET: SOCKET,
  COCKPIT_TMUX_SESSAO: 'print',
  COCKPIT_LIDAS_DIR: LIDAS,
  COCKPIT_JOBS_DIR: SEM_JOBS,
  COCKPIT_VIGIA_MS: '0',
  // A válvula do card (§4.4): sem ela, o upload da foto chamaria `limparAnexosVelhos()` na
  // pasta de PRODUÇÃO. É por isso que o "antes" (Fase 6.3) roda o SHA da Fase 1 — já tem a
  // válvula — e não o `develop` puro (achado do Codex, painel do plano).
  COCKPIT_PUSH_DIR: PUSH,
  COCKPIT_ANEXOS_DIR: ANEXOS,
  // D64 (#82): quem sobe server.js isola o monitor, senão o amostrador grava em ~/.cockpit
  // de produção desde o primeiro segundo. Script nasceu antes do monitor; a M-rede cobrou.
  COCKPIT_MONITOR_MS: '0',
  COCKPIT_MONITOR_DIR: path.join(os.tmpdir(), 'print-colagem-monitor'),
};

const servidores = [];
const tela = () => t(['capture-pane', '-p', '-t', 'print'], { tolerante: true });

function statusDoCli(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')).status || null;
  } catch { return null; }
}
function sessionIdDoCli(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')).sessionId || null;
  } catch { return null; }
}
async function ate(fn, prazoMs, passo = 300) {
  const fim = Date.now() + prazoMs;
  while (Date.now() < fim) { if (await fn()) return true; await espera(passo); }
  return false;
}
function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (corpo) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers }, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => { let j = {}; try { j = d ? JSON.parse(d) : {}; } catch { j = { cru: d }; } resolve({ status: res.statusCode, corpo: j }); });
    });
    req.on('error', reject);
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

// Acha o `.jsonl` da sessão em `~/.claude/projects/<pasta>/<sessionId>.jsonl` (varredura, como
// `lib/externo.js:arquivoDaSessao` — mas síncrona, o print não paga o custo de ser async aqui).
function acharJsonl(sessionId) {
  const raizProjetos = path.join(os.homedir(), '.claude', 'projects');
  let pastas = [];
  try { pastas = fs.readdirSync(raizProjetos); } catch { return null; }
  for (const pasta of pastas) {
    const alvo = path.join(raizProjetos, pasta, `${sessionId}.jsonl`);
    if (fs.existsSync(alvo)) return alvo;
  }
  return null;
}

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');
const BASE = process.env.BASE;
const CHAVE = process.env.CHAVE;
const ANTES = process.env.ANTES === '1';
const TEXTO = 'Vendas ta quebrada quando a tela fica pequena\\n\\nExames tambem\\n\\nNa imagem eu deveria conseguir conciliar parcial';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function statusDaAba() {
  const resp = await fetch(BASE + '/api/abas');
  const j = await resp.json();
  const abas = Array.isArray(j) ? j : (j.abas || []);
  const a = abas.find((x) => x.chave === CHAVE);
  return a ? a.status : null;
}

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const problemas = [];
  const medidas = {};
  const pagina = await navegador.newPage();
  try {
    // Ancorado no TEXTO, não em "existe uma .bolha-pendente": o turno longo TAMBÉM nasce
    // pendente com data-fila (via o evento 'pendente' do barramento, disparado quando o
    // fetch cru do passo 2 — sem passar pelo enviar() do cliente — é ecoado pelo SSE).
    await pagina.evaluateOnNewDocument(() => {
      window.daColagem = function (sel) {
        return Array.prototype.slice.call(document.querySelectorAll('.painel:not([hidden]) ' + sel))
          .filter(function (b) { return (b.textContent || '').indexOf('Vendas ta quebrada') >= 0; });
      };
    });
    await pagina.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pagina.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await pagina.evaluate(() => localStorage.setItem('cockpit-idioma', 'pt-BR'));
    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    await espera(800);

    const linha = await pagina.$('#abas .conversa-grupo[data-cwd] .conversa');
    if (!linha) problemas.push('a aba não apareceu na lista');
    else await linha.click();
    await espera(1500);

    // 2a. Upload da foto — SÓ DEPOIS disparamos o turno longo (achado do Codex: disparar
    // antes deixa o turno acabar antes do envio da colagem).
    const inp = await pagina.$('.painel:not([hidden]) .inp-arquivo');
    if (!inp) problemas.push('o input de anexo não existe');
    else {
      await inp.uploadFile('/w/foto.png');
      const subiu = await pagina.waitForSelector('.painel:not([hidden]) .anexo[data-estado="pronto"]', { timeout: 10000 })
        .then(function () { return true; }, function () { return false; });
      if (!subiu) problemas.push('o chip do anexo não apareceu em 10s');
    }

    // 2b. O turno longo, disparado PELA PÁGINA (fetch cru — não passa pelo enviar() do
    // cliente, então a bolha dele só nasce via o evento SSE 'pendente', com data-fila).
    await pagina.evaluate(function (chave) {
      return fetch('/api/abas/' + chave + '/turnos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texto: 'leia o leiame.txt com a ferramenta Read 8 vezes seguidas, uma chamada por vez, e depois diga ok' }),
      });
    }, CHAVE);

    let ficouBusy = false;
    {
      const fim = Date.now() + 30000;
      while (Date.now() < fim) {
        if (await statusDaAba() === 'busy') { ficouBusy = true; break; }
        await espera(500);
      }
    }
    if (!ficouBusy) problemas.push('a aba não ficou busy em 30s — o turno longo não começou a tempo');

    // 3. Com o turno rodando, escreve a colagem (com a foto já anexada) e envia — o caso H
    // da spec: mid-turn, com foto, com linha em branco.
    await pagina.evaluate(function (texto) {
      const c = document.querySelector('.painel:not([hidden]) .entrada');
      if (!c) return;
      c.value = texto;
      c.dispatchEvent(new Event('input', { bubbles: true }));
    }, TEXTO);
    const botao = await pagina.$('.painel:not([hidden]) .btn-enviar');
    if (botao) await botao.click(); else problemas.push('o botão Enviar não existe');

    // 4. A bolha "na fila" — o estado de PARTIDA, igual nos dois lados do par.
    const temFila = await pagina.waitForFunction(
      function () { return window.daColagem('.bolha-pendente[data-fila]').length >= 1; },
      { timeout: 5000 },
    ).then(function () { return true; }, function () { return false; });
    if (!temFila) problemas.push('a bolha da colagem não apareceu como pendente — sem fila não há o que provar');
    await pagina.screenshot({ path: '/out/01-na-fila.png' });

    // 5. Esperar o turno acabar — idle em DUAS leituras seguidas, mais a folga do relógio
    // de 700ms do servidor. Teto estourado tem que REPROVAR (achado do Claude): sem isso o
    // ANTES ficaria verde com a bolha presa por um motivo trivial (turno que não terminou).
    let acabou = false;
    {
      const fim = Date.now() + 180000;
      let seguidas = 0;
      while (Date.now() < fim) {
        if (await statusDaAba() === 'idle') { seguidas += 1; if (seguidas >= 2) { acabou = true; break; } } else seguidas = 0;
        await espera(1000);
      }
    }
    if (!acabou) problemas.push('o turno não acabou em 180s');
    await espera(4000);

    // 6. Rolar até o fim e medir.
    await pagina.evaluate(function () {
      // .mensagens e quem rola (overflow-y: auto, public/estilo.css); .fita fica de reserva. (Sem crase: vive dentro do template literal do roteiro.)
      const rolador = document.querySelector('.painel:not([hidden]) .mensagens')
        || document.querySelector('.painel:not([hidden]) .fita');
      if (rolador) rolador.scrollTop = rolador.scrollHeight;
    });
    await espera(300);
    await pagina.screenshot({ path: '/out/02-depois-do-turno.png' });
    medidas.pendentesDepois = await pagina.evaluate(function () { return window.daColagem('.bolha-pendente').length; });
    medidas.ultimaBolhaEuDepois = await pagina.evaluate(function () {
      const lista = window.daColagem('.bolha-eu');
      return lista.length ? lista[lista.length - 1].textContent : null;
    });

    // 7. Recarregar — a metade SERVER-SIDE da prova: a pendente reemitida na abertura.
    await pagina.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });
    const linha2 = await pagina.$('#abas .conversa-grupo[data-cwd] .conversa');
    if (linha2) await linha2.click(); else problemas.push('a aba sumiu depois de recarregar');
    await espera(3000);
    await pagina.evaluate(function () {
      // .mensagens e quem rola (overflow-y: auto, public/estilo.css); .fita fica de reserva. (Sem crase: vive dentro do template literal do roteiro.)
      const rolador = document.querySelector('.painel:not([hidden]) .mensagens')
        || document.querySelector('.painel:not([hidden]) .fita');
      if (rolador) rolador.scrollTop = rolador.scrollHeight;
    });
    await espera(300);
    await pagina.screenshot({ path: '/out/03-recarregado.png' });
    medidas.pendentesRecarregado = await pagina.evaluate(function () { return window.daColagem('.bolha-pendente').length; });
    medidas.ultimaBolhaEuRecarregado = await pagina.evaluate(function () {
      const lista = window.daColagem('.bolha-eu');
      return lista.length ? lista[lista.length - 1].textContent : null;
    });

    if (ANTES) {
      if (!(medidas.pendentesDepois >= 1)) problemas.push('ANTES: esperava a bolha ainda pendente logo depois do turno (o defeito)');
      if (!(medidas.pendentesRecarregado >= 1)) problemas.push('ANTES: esperava a bolha ainda pendente depois de recarregar (o defeito)');
    } else {
      if (medidas.pendentesDepois !== 0) problemas.push('DEPOIS: a bolha não deveria continuar pendente logo depois do turno');
      // Zero pendente só vale se a bolha EXISTE: sumir e voltar no reload também daria zero.
      if ((medidas.ultimaBolhaEuDepois || '').indexOf('Vendas ta quebrada') < 0) problemas.push('DEPOIS: a bolha da colagem sumiu da fita logo depois do turno');
      if (medidas.pendentesRecarregado !== 0) problemas.push('DEPOIS: a bolha não deveria continuar pendente depois de recarregar');
      const ultima = medidas.ultimaBolhaEuRecarregado || '';
      if (ultima.indexOf('Vendas ta quebrada') < 0) problemas.push('DEPOIS: a última bolha recarregada não contém o texto enviado');
      if (ultima.indexOf('📎') < 0) problemas.push('DEPOIS: a bolha recarregada não mostra o clipe do anexo');
      if (ultima.indexOf('[anexo]') >= 0 || ultima.indexOf('pasted_content') >= 0 || ultima.indexOf('Os arquivos acima') >= 0) {
        problemas.push('DEPOIS: a bolha recarregada ainda mostra cabeçalho cru');
      }
    }
  } catch (e) {
    problemas.push('o roteiro estourou — ' + String(e && e.message).slice(0, 300));
  }
  await navegador.close();
  console.log('@@MEDIDAS-COLAGEM@@' + JSON.stringify({ problemas, medidas }));
})();
`;
}

async function principal() {
  // TRAVA ANTI-PRODUÇÃO, fail-closed, ANTES do servidor subir (achado do Claude, painel do
  // plano): se `require('./lib/abas').PASTA_ANEXOS` não cair dentro do TMP deste print — SHA
  // errado no `git archive`, válvula ausente —, aborta SEM subir servidor nenhum. É isso que
  // torna o "antes" seguro mesmo rodando fora desta worktree (Fase 6.3 do plano).
  const pastaAnexosResolvida = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(require('./lib/abas').PASTA_ANEXOS)"],
    { cwd: RAIZ_CODIGO, env: ENV_SERVIDOR, encoding: 'utf8' },
  );
  if (!pastaAnexosResolvida.startsWith(TMP + path.sep)) {
    console.error(`🔴 PASTA_ANEXOS resolveu para "${pastaAnexosResolvida}", fora do TMP deste print (${TMP}). Abortando SEM subir servidor.`);
    return 2;
  }

  // Detector de dano: contagem ANTES de qualquer coisa tocar disco. Comparado no fim — nunca
  // apaga nada, só CONTA.
  const PRODUCAO_ANEXOS = path.join(os.homedir(), '.cockpit', 'anexos');
  const contarAnexosDeProducao = () => { try { return fs.readdirSync(PRODUCAO_ANEXOS).length; } catch { return 0; } };
  const anexosDeProducaoAntes = contarAnexosDeProducao();

  t(['new-session', '-d', '-s', 'print', '-c', CWD_AGENTE, '-x', '120', '-y', '40', BIN, '--model', 'haiku']);
  const panePid = t(['list-panes', '-t', 'print', '-F', '#{pane_pid}']).trim();
  if (!await ate(() => /trust this folder|Quick safety check/i.test(tela()), 30000)) {
    console.error('⚠️  o claude não chegou ao prompt de confiança.'); return 2;
  }
  t(['send-keys', '-t', 'print', 'Down']);
  await espera(400);
  t(['send-keys', '-t', 'print', 'Enter']);

  let agentePid = null;
  const candidatos = () => {
    const lista = [panePid];
    try {
      lista.push(...execFileSync('pgrep', ['-P', panePid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').map((s) => s.trim()).filter(Boolean));
    } catch { /* sem filhos */ }
    return lista;
  };
  if (!await ate(() => { for (const c of candidatos()) if (statusDoCli(c)) { agentePid = c; return true; } return false; }, 40000)) {
    console.error('⚠️  o CLI não publicou sessions/<pid>.json.'); return 2;
  }
  ok(true, `o agente subiu (pid ${agentePid})`);

  const filho = spawn(process.execPath, [path.join(RAIZ_CODIGO, 'server.js')], {
    cwd: RAIZ_CODIGO,
    env: ENV_SERVIDOR,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  servidores.push(filho);
  let erroDoFilho = '';
  filho.stderr.on('data', (b) => { erroDoFilho += b; });
  if (!await ate(() => pedir('GET', '/health').then((r) => r.status === 200, () => false), 15000)) {
    console.error(`⚠️  servidor não subiu: ${erroDoFilho.trim().split('\n').slice(-3).join(' | ')}`); return 2;
  }

  const r = await listarAba();
  if (!r) { console.error('⚠️  o cockpit não enxergou a aba.'); return 2; }

  fs.writeFileSync(path.join(TMP, 'roteiro.js'), montarRoteiro());
  const docker = spawn('docker', [
    'run', '--rm', '--network', 'host', '--entrypoint', 'node',
    '-e', `BASE=http://127.0.0.1:${PORTA}`,
    '-e', `CHAVE=${r.chave}`,
    '-e', `ANTES=${ANTES ? '1' : '0'}`,
    '-v', `${TMP}:/w:ro`,
    '-v', `${SAIDA}:/out`,
    IMAGEM, '/w/roteiro.js',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let saidaDocker = '';
  docker.stdout.on('data', (d) => { saidaDocker += d; });
  docker.stderr.on('data', (d) => { saidaDocker += d; });
  await new Promise((res) => docker.on('close', res));

  const MARCADOR = '@@MEDIDAS-COLAGEM@@';
  const abre = saidaDocker.indexOf(MARCADOR);
  let rel = null;
  if (abre >= 0) { try { rel = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { rel = null; } }
  if (!rel) { console.log(saidaDocker); ok(false, 'o roteiro não devolveu JSON'); return 1; }

  console.log(`  · medidas: ${JSON.stringify(rel.medidas)}`);
  ok(rel.problemas.length === 0, rel.problemas.length ? `o percurso reprovou: ${rel.problemas.join(' · ')}` : 'o percurso passou');

  for (const nome of ['01-na-fila.png', '02-depois-do-turno.png', '03-recarregado.png']) {
    const png = path.join(SAIDA, nome);
    ok(fs.existsSync(png) && fs.statSync(png).size > 1000, `${png} gerado`);
  }

  // Detector de dano: a pasta de PRODUÇÃO não pode ter mudado de tamanho, e a do print (TMP)
  // tem que ter recebido a foto — sem isso o print poderia estar "passando" sem upload nenhum.
  const anexosDeProducaoDepois = contarAnexosDeProducao();
  ok(anexosDeProducaoDepois === anexosDeProducaoAntes,
    `~/.cockpit/anexos não mudou (${anexosDeProducaoAntes} → ${anexosDeProducaoDepois})`);
  const anexosDoPrint = (() => { try { return fs.readdirSync(ANEXOS).length; } catch { return 0; } })();
  ok(anexosDoPrint >= 1, `a pasta isolada do print recebeu ao menos 1 anexo (${anexosDoPrint})`);

  // Prova de que o cenário aconteceu de verdade no .jsonl: enqueue com a colagem embrulhada
  // → consumida (mid-turn OU user) → o agente respondeu depois.
  const sessionId = sessionIdDoCli(agentePid);
  const arquivoJsonl = sessionId ? acharJsonl(sessionId) : null;
  if (!arquivoJsonl) {
    ok(false, 'não achei o .jsonl da sessão para provar o cenário (sem ele, o veredito acima é cego)');
  } else {
    const linhas = fs.readFileSync(arquivoJsonl, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let idxEnqueue = -1;
    for (let i = 0; i < linhas.length; i += 1) {
      const l = linhas[i];
      const conteudo = typeof l.content === 'string' ? l.content : '';
      if (l.type === 'queue-operation' && l.operation === 'enqueue'
        && conteudo.includes('pasted_content') && conteudo.includes('[Image #') && conteudo.includes('Vendas ta quebrada')) {
        idxEnqueue = i; break;
      }
    }
    ok(idxEnqueue >= 0, 'jsonl: achei a linha enqueue com pasted_content + [Image # + Vendas ta quebrada (a colagem embrulhada de verdade)');

    let idxConsumo = -1;
    let caminhoConsumo = null;
    if (idxEnqueue >= 0) {
      for (let i = idxEnqueue + 1; i < linhas.length; i += 1) {
        const l = linhas[i];
        if (l.type === 'queue-operation' && l.operation === 'remove' && l.reason === 'absorbed_mid_turn'
          && typeof l.content === 'string' && l.content.includes('Vendas ta quebrada')) {
          idxConsumo = i; caminhoConsumo = 'absorbed_mid_turn'; break;
        }
        if (l.type === 'user' && !l.isMeta && !l.isSidechain) {
          const conteudoMsg = l.message && l.message.content;
          const textoMsg = typeof conteudoMsg === 'string' ? conteudoMsg
            : (Array.isArray(conteudoMsg) ? conteudoMsg.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '');
          if (textoMsg.includes('Vendas ta quebrada')) { idxConsumo = i; caminhoConsumo = 'user'; break; }
        }
      }
    }
    ok(idxConsumo >= 0, `jsonl: a mesma mensagem foi consumida depois do enqueue (caminho: ${caminhoConsumo || 'nenhum achado'})`);

    let temAssistant = false;
    if (idxConsumo >= 0) {
      for (let i = idxConsumo + 1; i < linhas.length; i += 1) if (linhas[i].type === 'assistant') { temAssistant = true; break; }
    }
    ok(temAssistant, 'jsonl: depois do consumo, o agente respondeu (linha assistant) — o cenário aconteceu de ponta a ponta');
  }

  return falhas === 0 ? 0 : 1;

  async function listarAba() {
    const resp = (await pedir('GET', '/api/abas')).corpo;
    const abas = Array.isArray(resp) ? resp : (resp.abas || []);
    return abas[0] || null;
  }
}

let saida = 1;
principal()
  .then((c) => { saida = c; })
  .catch((e) => { console.error('🔴 erro:', e.message); saida = 1; })
  .finally(() => {
    for (const s of servidores) { try { s.kill('SIGTERM'); } catch { /* já morreu */ } }
    try { t(['kill-server'], { tolerante: true }); } catch { /* já caiu */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* deixa no /tmp */ }
    const veredito = feitos === 0 ? '⚠️  INCONCLUSIVO (nenhuma asserção rodou)'
      : (falhas === 0 && saida === 0 ? '✅ PRINT VERDE' : '❌ PRINT VERMELHO');
    console.log(`\n${veredito} — ${feitos - falhas}/${feitos} asserções`);
    process.exit(saida);
  });
