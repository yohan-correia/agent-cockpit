#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — celular, o grupo JOBS na lista lateral (card `painel-de-jobs-dentro-do-app`,
// desenho C, spec 2026-09-08).
//
// Prova de tela nos DOIS viewports (D51, plano de 2026-09-13 — a barra que troca a vista no
// lugar da caixa fixa da D50): 390×844 (celular, regra de 25/08 — provar no aparelho que
// motivou a mudança) e 1600×1000 (desktop). `VIEWPORT=LxA` no ambiente escolhe qual; sem ele
// o padrão continua sendo o celular. Antes/depois, com os MESMOS doze jobs (mesmo
// id/título/projeto/estado) dos dois lados — só o CANAL muda: o `develop` ("antes")
// ainda lê o painel externo por HTTP (`COCKPIT_PAINEL_JOBS`, mock nesta pasta); esta worktree
// ("depois") lê a pasta do disco (`COCKPIT_JOBS_DIR`, ver `montarJobsNoDisco`). Sem os MESMOS
// dados dos dois lados o par deixa de comparar a MUDANÇA e passa a comparar dois dados
// diferentes (o erro de 24/08 com outra roupa).
//
// Molde: `testes/smoke-celular-primeira-leva.js` (as quatro panes reais num tmux carimbado, o
// /proc de mentira, o HOME fabricado) e `testes/smoke-conversa-transicoes.js` (dois `server.js`
// em portas distintas, um deles a árvore inteira do `develop` via `git archive`).
//
// Diferente dos dois moldes: aqui NÃO há MODO=/BASE= de entrada — este script É o entrypoint
// único. Ele mesmo escolhe as portas, sobe os DOIS `server.js` (o do `develop` e o desta
// worktree), cada um com sua própria fonte de jobs, roda o percurso duas vezes e derruba tudo
// no `finally`.
//
// Uso: SAIDA=<pasta NOVA, sem PNG dentro> [VIEWPORT=LxA] node testes/smoke-celular-jobs.js
//
// Códigos de saída: 0 = os dois modos passaram · 1 = falha de produto/assert em algum dos dois
// · 2 = erro de USO ou de AMBIENTE (falta SAIDA, pasta já tem PNG, porta ocupada, imagem
// docker ausente, `git archive` falhou, servidor não subiu).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync, spawn } = require('node:child_process');

// ─── Contrato de uso — validado ANTES de tocar em qualquer coisa ─────────────

const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os seis PNGs vão cair>');
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
// Cenário de LISTA CURTA (duas abas, um projeto cada): o caso em que sobra espaço na
// lateral e o `sticky` não tem o que grudar. Ver o comentário no bloco de enchimento.
const LISTA_CURTA = process.env.LISTA_CURTA === '1';
const RAIZ = path.join(__dirname, '..');
// Mesmo cálculo do roteiro (dentro do container): sem isto o script no HOST não sabe se o
// cenário é celular para decidir se `depois-conversa-aberta`/`antes-conversa-aberta` entram
// na lista de conferência dos PNGs (§2.4 da spec — só existe no celular).
const [VP_LARGURA_HOST] = String(process.env.VIEWPORT || '').split('x').map(Number);
const EH_CELULAR_HOST = !(Number.isFinite(VP_LARGURA_HOST) && VP_LARGURA_HOST > 760);

// Portas: dois `server.js` (antes/depois) + o mock do painel + uma de folga. Nunca 7899 (#24)
// nem 7879 (produção) — a faixa inteira já fica fora dos dois.
const PORTA_ANTES = 7891;
const PORTA_DEPOIS = 7892;
const PORTA_FOLGA = 7894;

// A lista de verificação (D51, 2026-09-13): a caixa fixa da D50 morreu — `depois-caixa-fixa`
// virou `depois-agentes` (o clique na barra, ocupando a lateral inteira), e ganhou
// `depois-volta-conversas` (o segundo clique, provando o alternador). TODO PNG novo entra
// aqui, senão um `screenshot()` que não gerou arquivo passa verde — o modo de falha que a
// regra de 25/08 existe para pegar. `depois-conversa-aberta` só entra no celular (a perda
// declarada da §2.4 da spec) — é acrescentada mais abaixo, condicionalmente.
const PNGS_DEPOIS = ['depois-lista', 'depois-agentes', 'depois-primeira-dobra', 'depois-jobs-rolados', 'depois-clique-job', 'depois-volta-conversas'];

// ─── Fail-closed do socket, mesmo padrão dos outros smokes de celular ────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}
const SOCKET = `cockpit-smoke-jobs-${process.pid}`;
const SESSAO = 'main';
const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;

function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

let falhas = 0;
let feitos = 0;
const ok = (c, texto) => { feitos += 1; if (!c) falhas += 1; console.log(`  ${c ? '✅' : '❌'} ${texto}`); return c; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function portaOcupada(porta) {
  const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
  return saida.split('\n').some((l) => l.includes(`:${porta} `) || l.includes(`:${porta}\t`));
}

// ─── As duas abas da fixture — uma casa com o job "running", a outra não ────
//
// `abasDoProjeto()` (`lib/abas.js:705`) casa por NOME: o `project` do job contra o basename
// normalizado do `cwd` da aba. `painelalvo` casa; `semaba` não casa com nenhuma das duas —
// os jobs "encerrados"/"bloqueado"/"falhou" não precisam de aba viva para aparecer na lista.

const CWD_ALVO = '/home/smoke/projetos/painelalvo';
const CWD_FORA = '/home/smoke/projetos/painelfora';
const SESSID_ALVO = 'sess-painelalvo';
const SESSID_FORA = 'sess-painelfora';

function raizProc(scratch) {
  return path.join(scratch, 'proc');
}

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` — molde `gate-codex.js:63-94`. */
function plantarAgenteFalso(scratch, pid, { comm = 'claude', argv = ['/usr/bin/claude'], starttime }) {
  const dir = path.join(raizProc(scratch), String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = `(${comm})`;
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);
  campos[5] = String(pid);
  campos[6] = '34816';
  campos[7] = String(pid);
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime, status }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive',
    sessionId: sessaoId,
    cwd,
    status,
    updatedAt: Date.now(),
    pid,
    procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

function escreverConversa(caminho, linhas) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhas.join(''));
}

const linhaHumano = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto) => `${JSON.stringify({
  type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] },
})}\n`;

/** Uma conversa pequena (4 linhas), última mensagem no `T` dado. Devolve `T` em ms. */
function conversaPequena(caminho, baseMs) {
  const linhas = [];
  let quando = baseMs - 3 * 60000;
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'oi, tudo bem por aí?')); quando += 60000;
  linhas.push(linhaAssistente(new Date(quando).toISOString(), 'tudo certo — o que você precisa?')); quando += 60000;
  linhas.push(linhaHumano(new Date(quando).toISOString(), 'só confirmando que a aba está viva')); quando += 60000;
  linhas.push(linhaAssistente(new Date(quando).toISOString(), 'confirmado, sigo por aqui.'));
  escreverConversa(caminho, linhas);
  return quando;
}

// ─── A fixture em DISCO, para o `server.js` "depois" ─────────────────────────
//
// Uma fixture só, para os DOIS lados. Até a absorção do painel mergear, o "antes" (a árvore
// do `develop`) lia os jobs de um serviço externo por HTTP e precisava de um mock; hoje as duas
// árvores leem a mesma pasta de disco, e o mock virou código morto que ATRAPALHA — a variável
// antiga passaria a ser ignorada, o "antes" ficaria sem pasta nenhuma, e o smoke reprovaria a
// ausência do grupo como se fosse defeito da branch.
//
// O que sobrou de "antes/depois" ainda vale: as duas árvores desenham a MESMA tela a partir do
// MESMO dado, e é isso que pega regressão entre a `develop` e a branch de trabalho.
//
// O formato das pastas é o que `lib/jobs.js:lerJob` espera.
function escreverJobNoDisco(pastaJobs, id, { type, project, title, criadoEm, statusMeta, linhaStatus, comEtapa }) {
  const dir = path.join(pastaJobs, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id, type, project, title,
    created_at: new Date(criadoEm).toISOString(),
    worktree: '', branch: '', origin: 'capitao', merged_at: null, approved_at: null,
    status: statusMeta, pid: process.pid, tmux_session: null,
  }));
  fs.writeFileSync(path.join(dir, 'status.log'), `${linhaStatus}\n`);
  if (comEtapa) {
    // Duas linhas de NDJSON, não uma: a primeira é uma FALA (bloco de texto) — sem ela, o
    // clique no job (depois-clique-job) só provaria "o painel abriu", não a §8 do plano
    // ("a fita do job tem falas de verdade"). A segunda é a mesma de sempre, e é o que faz a
    // linha "rodando" da lista ter uma etapa em vez de ficar muda (`etapaAtual()`,
    // `lib/jobs.js`).
    const linhasDoLog = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'revendo o arquivo antes de editar — smoke da caixa fixa' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/lib/exemplo.js' } }] } },
    ];
    fs.writeFileSync(path.join(dir, 'claude.log'), linhasDoLog.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }
}

function montarJobsNoDisco(pastaJobs) {
  const agora = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  escreverJobNoDisco(pastaJobs, 'job-rodando', {
    type: 'ataca', project: 'painelalvo', title: 'painel-alvo', criadoEm: agora - 5 * 60000,
    statusMeta: 'running', linhaStatus: `${iso(agora - 5 * 60000)} working: rodando`, comEtapa: true,
  });
  escreverJobNoDisco(pastaJobs, 'job-bloqueado', {
    type: 'ataca', project: 'semaba', title: 'painel-bloqueado', criadoEm: agora - 4 * 3600000,
    statusMeta: 'blocked',
    linhaStatus: `${iso(agora - 2 * 3600000)} blocked: teardown recusado: worktree com alteração pendente`,
  });
  // 🔴 Re-datado para MINUTOS (era 5h). A janela do fim feliz agora é de 1h
  // (`JANELA_FIM_FELIZ_MS`, server.js — Fase 1 deste plano), e um `done` de 5h sairia da
  // resposta: o `exigir(detalhes.temPronta, …)` mais abaixo LANÇARIA antes do obturador, e
  // nenhum PNG do "depois" chegaria a nascer. Achado do painel de avaliação.
  escreverJobNoDisco(pastaJobs, 'job-pronto', {
    type: 'ship', project: 'semaba', title: 'painel-pronto', criadoEm: agora - 10 * 60000,
    statusMeta: 'done', linhaStatus: `${iso(agora - 5 * 60000)} done: concluído`,
  });
  escreverJobNoDisco(pastaJobs, 'job-falhou', {
    type: 'ataca', project: 'semaba', title: 'painel-falhou', criadoEm: agora - 3 * 3600000,
    statusMeta: 'failed', linhaStatus: `${iso(agora - 2 * 3600000)} failed: executor saiu com código 1`,
  });

  // Oito de ENCHIMENTO (Fase 4 do plano, achado do painel): quatro jobs não estouram
  // `max-height` nenhum e não provam o A4 (a caixa ficar dentro de ~40% da lateral no
  // desktop). Mesmos quatro estados de sempre, sem sujeito novo — só volume. Os `done`
  // ficam em MINUTOS (janela de 1h); `blocked`/`failed` continuam em horas (protegido/isento,
  // sem janela nenhuma).
  const enchimento = [
    ['running', agora - 8 * 60000, `${iso(agora - 3 * 60000)} working: rodando`],
    ['blocked', agora - 5 * 3600000, `${iso(agora - 3 * 3600000)} blocked: teardown recusado: worktree com alteração pendente`],
    ['done', agora - 12 * 60000, `${iso(agora - 8 * 60000)} done: concluído`],
    ['failed', agora - 6 * 3600000, `${iso(agora - 4 * 3600000)} failed: executor saiu com código 1`],
    ['running', agora - 6 * 60000, `${iso(agora - 2 * 60000)} working: rodando`],
    ['blocked', agora - 6 * 3600000, `${iso(agora - 4 * 3600000)} blocked: teardown recusado: worktree com alteração pendente`],
    ['done', agora - 15 * 60000, `${iso(agora - 10 * 60000)} done: concluído`],
    ['failed', agora - 7 * 3600000, `${iso(agora - 5 * 3600000)} failed: executor saiu com código 1`],
  ];
  enchimento.forEach(([estado, criadoEm, linhaStatus], i) => {
    escreverJobNoDisco(pastaJobs, `job-enchimento-${i + 1}`, {
      type: 'ataca', project: 'semaba', title: `painel-enchimento-${i + 1}`,
      criadoEm, statusMeta: estado, linhaStatus,
    });
  });
  // Total visível: os 4 de cima + estes 8 = DOZE — o bastante para estourar o `max-height`
  // e provar a rolagem própria da caixa (desktop) e o fim da página (celular, D-e).

  // 🔴 O décimo-terceiro job existe para dar DENTE ao assert de baixo ("o de 25h não
  // aparece"). Sem ele na pasta, aquele assert passa vazio: prova que a fixture não o tinha,
  // não que a janela o cortou.
  //
  // E quem o corta é a JANELA do fim feliz (`JANELA_FIM_FELIZ_MS`, no server.js — 1h desde a
  // Fase 1 deste plano), não o arquivamento (`horasArquiva()`, na lib) — são duas réguas
  // diferentes, e é fácil trocá-las: `done` de fato nunca ARQUIVA, mas a janela o corta do
  // mesmo jeito, e por isso o `total === 12` continua valendo com treze jobs no disco.
  escreverJobNoDisco(pastaJobs, 'job-fora-da-janela', {
    type: 'ship', project: 'semaba', title: 'painel-antigo', criadoEm: agora - 30 * 3600000,
    statusMeta: 'done', linhaStatus: `${iso(agora - 25 * 3600000)} done: concluído`,
  });
}

function saude(porta) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── O roteiro do navegador — roda DENTRO do container, uma vez por MODO ─────

function montarRoteiro() {
  return `'use strict';
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const MODO = process.env.MODO;
// VIEWPORT vem do AMBIENTE (Fase 4 do plano de 2026-09-13) — o MESMO roteiro roda em
// 390×844 (celular, default de sempre) e em 1600×1000 (desktop, onde a caixa fixa sticky
// vive), sem precisar de um segundo script. Acima de 760px \`isMobile\`/\`hasTouch\` desligam
// JUNTOS: com eles ligados o Chromium reporta \`hover: none\`/\`pointer: coarse\` mesmo numa
// tela de desktop — armadilha #66.
const [VP_LARGURA, VP_ALTURA] = String(process.env.VIEWPORT || '').split('x').map(Number);
const LARGURA_VIEWPORT = Number.isFinite(VP_LARGURA) && VP_LARGURA > 0 ? VP_LARGURA : 390;
const ALTURA_VIEWPORT = Number.isFinite(VP_ALTURA) && VP_ALTURA > 0 ? VP_ALTURA : 844;
const EH_CELULAR = LARGURA_VIEWPORT <= 760;
const VIEWPORT = {
  width: LARGURA_VIEWPORT, height: ALTURA_VIEWPORT,
  isMobile: EH_CELULAR, hasTouch: EH_CELULAR, deviceScaleFactor: EH_CELULAR ? 2 : 1,
};
// Atalho de leitura: o que muda de PROMESSA entre os dois viewports é se a caixa tem
// rolagem propria (desktop) ou rola junto com a pagina (celular, D-e).
const DESKTOP = !EH_CELULAR;
// Repetidos dentro do roteiro (que vira string e roda no container) para o assert poder
// comparar o PEDIDO com o que o Chromium de fato abriu.
const VIEWPORT_L = LARGURA_VIEWPORT;
const VIEWPORT_A = ALTURA_VIEWPORT;
console.log('VIEWPORT efetivo: ' + JSON.stringify(VIEWPORT));

const problemas = [];
const feitos = [];
const ok = (cond, msg) => { (cond ? feitos : problemas).push(msg); return cond; };
// Guarda ANTES do obturador (achado do painel de execução): um PNG de estado reprovado no
// disco, com o nome de sempre, é pior que PNG nenhum — alguém abre e acredita.
const exigir = (cond, msg) => {
  if (!ok(cond, msg)) throw new Error('guarda reprovou antes do obturador: ' + msg);
};

(async () => {
  const navegador = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const pagina = await navegador.newPage();
    await pagina.setViewport(VIEWPORT);
    await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

    const erros = [];
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });

    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await pagina.waitForSelector('#abas', { timeout: 15000 });

    if (MODO === 'antes') {
      // O que este assert mede: "o 'antes' é MESMO o código de antes". Ele nasceu exigindo a
      // AUSÊNCIA de #grupo-jobs, quando o desenho C ainda era a novidade da branch. O desenho
      // C mergeou, e desde então #grupo-jobs É o estado da develop: o assert envelheceu e o
      // smoke passou a reprovar o próprio "antes". Invertido em 2026-09-10, junto da absorção
      // do painel: continua medindo a mesma coisa, do lado certo.
      //
      // Envelheceu DE NOVO em 14/09, pelo mesmo motivo: a D51 mergeou, a develop nasce na
      // vista de CONVERSAS e ali #grupo-jobs não existe mais (BA-4). O que É o estado da
      // develop hoje é a BARRA, e é ela que este "antes" tem de encontrar — o grupo vem
      // depois do clique, como na vista de agentes de verdade.
      //
      // 🔴 E "a barra existe" sozinho é fraco: ela nasce hidden e grupoDeJobs()
      // (public/app.js) desenha o grupo TAMBÉM quando não há notícia dos jobs, para pintar a
      // linha de aviso. Um "antes" com erro de token, de rota ou de fixture passaria. São
      // quatro dentes, não um: a barra está visível, o clique abre o grupo, ele tem LINHA de
      // job, e não é a linha de aviso.
      await pagina.waitForSelector('#barra-agentes:not([hidden])', { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 1500));
      const estado = await pagina.evaluate(() => {
        const barraNome = document.getElementById('barra-agentes-nome');
        const antesDoClique = {
          barraTexto: barraNome ? barraNome.textContent : '',
          linhas: document.querySelectorAll('#abas .conversa-linha').length,
        };
        return antesDoClique;
      });
      exigir(/agente?s/.test(estado.barraTexto || ''),
        'antes: a barra da develop diz "agentes · N" na vista de conversas (' + estado.barraTexto + ')');
      exigir(estado.linhas >= 2, 'antes: as duas abas da fixture aparecem na lista (' + estado.linhas + ')');
      exigir(erros.length === 0, 'antes: sem erro de console (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
      // 🔴 O PAR do depois-lista: esta é a barra ANTES dos ajustes finos de 14/09 — miúda, à
      // esquerda. É contra esta foto que a barra maior/centralizada/bold se compara.
      await pagina.screenshot({ path: '/out/antes-lista.png' });

      // Só AGORA o grupo: na develop de hoje ele mora atrás do clique na barra.
      await pagina.evaluate(() => document.getElementById('barra-agentes').click());
      await new Promise((r) => setTimeout(r, 500));
      const comGrupo = await pagina.evaluate(() => ({
        temGrupo: Boolean(document.getElementById('grupo-jobs')),
        linhasDeJob: document.querySelectorAll('#grupo-jobs .conversa-linha').length,
        texto: (document.getElementById('grupo-jobs') || {}).textContent || '',
      }));
      exigir(comGrupo.temGrupo, 'antes: o clique na barra abre #grupo-jobs (a develop já tem a D51)');
      exigir(comGrupo.linhasDeJob >= 1, 'antes: e tem linha de JOB, não só o cabeçalho (' + comGrupo.linhasDeJob + ')');
      exigir(!comGrupo.texto.includes('não deu para'), 'antes: e NÃO é a linha de aviso — o cenário foi montado, a página não só abriu');
      // O PAR do depois-agentes: a vista de agentes com a barra ANTIGA no rodapé.
      await pagina.screenshot({ path: '/out/antes-agentes.png' });
      // De volta para conversas, senão o antes-conversa-aberta abaixo clicaria numa linha de
      // JOB achando que é conversa.
      await pagina.evaluate(() => document.getElementById('barra-agentes').click());
      await new Promise((r) => setTimeout(r, 300));

      // antes-conversa-aberta — só no CELULAR: o PAR do depois-conversa-aberta, do MESMO
      // percurso, na árvore da develop. Sem este par, o depois-conversa-aberta compararia
      // contra a lista (uma tela diferente), que é o erro de 24/08 com outra roupa.
      if (!DESKTOP) {
        const clicouConversaAntes = await pagina.evaluate(() => {
          const linha = document.querySelector('#abas .conversa-linha .conversa');
          if (!linha) return false;
          linha.click();
          return true;
        });
        exigir(clicouConversaAntes, 'antes: consegui clicar numa conversa para abrir');
        await pagina.waitForSelector('.fita', { timeout: 15000 });
        await new Promise((r) => setTimeout(r, 500));
        await pagina.screenshot({ path: '/out/antes-conversa-aberta.png' });
      }
    } else {
      // 🔴 O :not([hidden]) não é zelo: a barra nasce hidden e só aparece quando a primeira
      // leitura de api/jobs chega. Na vista de CONVERSAS #grupo-jobs nunca existe (D51) — um
      // waitForSelector('#grupo-jobs') aqui esperaria 15s e abortaria antes do 1o exigir.
      await pagina.waitForSelector('#barra-agentes:not([hidden])', { timeout: 15000 });

      // ── depois-primeira-dobra: o estado NATURAL da vista de CONVERSAS — a barra denuncia
      // no rodapé, sem precisar clicar. #grupo-jobs NÃO existe aqui (BA-4, exclusão mútua).
      await new Promise((r) => setTimeout(r, 500));
      const primeira = await pagina.evaluate(() => ({
        temGrupo: Boolean(document.getElementById('grupo-jobs')),
        linhasAbas: document.querySelectorAll('#lista-conversas .conversa-linha').length,
        barraVisivel: (() => {
          const b = document.getElementById('barra-agentes');
          if (!b || b.hidden) return false;
          const r = b.getBoundingClientRect();
          return r.top < window.innerHeight && r.bottom > 0 && r.height > 0;
        })(),
        larguraReal: window.innerWidth, alturaReal: window.innerHeight,
      }));
      exigir(primeira.larguraReal === VIEWPORT_L && primeira.alturaReal === VIEWPORT_A,
        'depois: o navegador abriu NA viewport pedida — nao adianta o -e atravessar o docker e o Chromium ignorar ('
        + primeira.larguraReal + 'x' + primeira.alturaReal + ' pedido ' + VIEWPORT_L + 'x' + VIEWPORT_A + ')');
      exigir(!primeira.temGrupo, 'depois: na vista de CONVERSAS, #grupo-jobs NÃO existe (D51, BA-4)');
      exigir(primeira.linhasAbas >= 2, 'depois: as abas da fixture continuam na lista (' + primeira.linhasAbas + ')');
      exigir(primeira.barraVisivel, 'depois: a barra dos agentes está visível, no rodapé da lateral');
      await pagina.screenshot({ path: '/out/depois-primeira-dobra.png' });

      // ── depois-lista: a vista de CONVERSAS, com a barra denunciando "X travados" em
      // vermelho — a fixture tem job-bloqueado (blocked), então o aviso não pode vir vazio.
      await pagina.evaluate(() => { document.getElementById('abas').scrollTop = 0; });
      await new Promise((r) => setTimeout(r, 300));
      const listaConversas = await pagina.evaluate(() => {
        const aviso = document.getElementById('barra-agentes-aviso');
        const barra = document.getElementById('barra-agentes');
        return {
          avisoTexto: aviso ? aviso.textContent : '',
          corAviso: aviso ? getComputedStyle(aviso).color : '',
          corBarra: barra ? getComputedStyle(barra).color : '',
          pesoAviso: aviso ? getComputedStyle(aviso).fontWeight : '',
        };
      });
      // Os DOIS idiomas: "travados" vira "stuck" em inglês (traducoes.js:369), e o Chromium do
      // smoke sai em en. Um regex por idioma faria o assert depender de qual idioma o
      // container escolheu — mesmo cuidado que o assert do rótulo da barra já toma.
      exigir(/travad|stuck/.test(listaConversas.avisoTexto || ''),
        'depois: a barra denuncia os travados (' + listaConversas.avisoTexto + ')');
      // "em vermelho" é REQUISITO (spec §2.2: a barra tem de DENUNCIAR), então o assert mede a
      // cor em vez de só afirmá-la na mensagem — assert que diz uma coisa e mede outra é
      // exatamente o que este card proíbe.
      exigir(listaConversas.corAviso !== listaConversas.corBarra && Number(listaConversas.pesoAviso) >= 600,
        'depois: e denuncia em COR PRÓPRIA e peso, não no cinza do resto da barra ('
        + JSON.stringify({ aviso: listaConversas.corAviso, barra: listaConversas.corBarra, peso: listaConversas.pesoAviso }) + ')');
      exigir(erros.length === 0, 'depois: sem erro de console até aqui (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
      await pagina.screenshot({ path: '/out/depois-lista.png' });

      // ── depois-agentes: clica na barra — a vista de AGENTES passa a ocupar a lateral
      // inteira (não há mais caixa fixa: a D50 morreu por completo na D51).
      await pagina.evaluate(() => { document.getElementById('barra-agentes').click(); });
      await pagina.waitForSelector('#grupo-jobs', { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 300));
      const detalhes = await pagina.evaluate(() => {
        const linhas = Array.from(document.querySelectorAll('#grupo-jobs .conversa-linha'));
        const porEstado = (estado) => linhas.find((l) => l.dataset.estado === estado);
        const bloqueada = porEstado('bloqueado');
        const motivoEl = bloqueada && bloqueada.querySelectorAll('.conversa-estado')[1];
        const rodando = porEstado('trabalhando');
        const botaoRodando = rodando && rodando.querySelector('.conversa');
        return {
          total: linhas.length,
          temTrabalhando: Boolean(porEstado('trabalhando')),
          temBloqueado: Boolean(porEstado('bloqueado')),
          temPronta: Boolean(porEstado('pronta')),
          temInterrompida: Boolean(porEstado('interrompida')),
          contemAntigo: /painel-antigo/.test(document.getElementById('grupo-jobs').textContent),
          motivo: motivoEl ? motivoEl.textContent : null,
          rodandoEhBotao: Boolean(botaoRodando && botaoRodando.tagName === 'BUTTON'),
          linhasAbas: document.querySelectorAll('#lista-conversas').length,
        };
      });
      exigir(detalhes.total === 12, 'depois: doze linhas de job na tela (' + detalhes.total + ')');
      exigir(detalhes.temTrabalhando, 'depois: a linha "trabalhando" (rodando) está na tela');
      exigir(detalhes.temBloqueado, 'depois: a linha "bloqueado" está na tela');
      exigir(detalhes.temPronta, 'depois: a linha "pronta" (done na janela) está na tela');
      exigir(detalhes.temInterrompida, 'depois: a linha "interrompida" (failed) está na tela');
      exigir(!detalhes.contemAntigo, 'depois: o job de 25h (fora da janela de 1h) NÃO aparece');
      exigir(Boolean(detalhes.motivo && /teardown recusado/.test(detalhes.motivo)),
        'depois: o motivo do bloqueado está no DOM, legível (' + detalhes.motivo + ')');
      exigir(detalhes.rodandoEhBotao, 'depois: a linha "rodando" é clicável (casa com a aba painelalvo)');
      exigir(detalhes.linhasAbas === 0,
        'depois: na vista de AGENTES, nenhum #lista-conversas — as conversas não estão ali (BA-4)');
      await pagina.screenshot({ path: '/out/depois-agentes.png' });

      // ── depois-jobs-rolados: rola #abas — o ÚNICO scroller da lateral agora, nos DOIS
      // aparelhos (é a queixa das duas rolagens que esta entrega fecha). O cabeçalho
      // "agentes · N" migrou para a barra (fora do scroller), e é lá que se lê.
      const rolagem = await pagina.evaluate(() => {
        const abas = document.getElementById('abas');
        const grupo = document.getElementById('grupo-jobs');
        const linhas = grupo.querySelectorAll('.conversa-linha');
        const ultima = linhas[linhas.length - 1];
        abas.scrollTop = abas.scrollHeight;
        const barraNome = document.getElementById('barra-agentes-nome');
        const rUltima = ultima.getBoundingClientRect();
        // 🔴 A prova central desta entrega: nenhum DESCENDENTE de #abas pode ter rolagem
        // própria — antes a caixa de jobs era sticky com overflow-y:auto por dentro; agora
        // quem rola é sempre #abas, e é isto que fecha a queixa das duas rolagens.
        const algumFilhoComOverflowProprio = Array.from(document.querySelectorAll('#abas *')).some((el) => {
          const overflow = getComputedStyle(el).overflowY;
          return overflow === 'auto' || overflow === 'scroll';
        });
        // "nenhum filho rola" sozinho passaria numa lateral onde NADA rola. A promessa é
        // "UMA rolagem", não "zero" — então mede-se que #abas ANDOU de verdade.
        const abasRolouDeFato = abas.scrollTop > 0 && abas.scrollHeight > abas.clientHeight + 1;
        // "a barra está no viewport" não é "a barra está no rodapé". A régua é a base da
        // .lateral: é o que o dono reprovou na D50 (a caixa desgrudava com lista curta).
        const barra = document.getElementById('barra-agentes');
        const lateral = document.querySelector('.lateral');
        const rBarra = barra.getBoundingClientRect();
        const rLateral = lateral.getBoundingClientRect();
        return {
          total: linhas.length,
          cabecalhoTexto: barraNome ? barraNome.textContent : '',
          ultimaVisivel: rUltima.top < window.innerHeight && rUltima.bottom > 0,
          algumFilhoComOverflowProprio,
          abasRolouDeFato,
          folgaAteORodape: Math.round(rLateral.bottom - rBarra.bottom),
        };
      });
      await new Promise((r) => setTimeout(r, 300));
      exigir(rolagem.total === 12, 'depois: doze jobs na tela, para rolar de verdade (' + rolagem.total + ')');
      // Estamos na vista de AGENTES, e desde 14/09 a barra diz para onde o clique LEVA, não
      // onde você está (BA-9): aqui ela lê "conversas". O smoke roda com a UI em INGLÊS, onde
      // sai "conversations" — os dois idiomas no mesmo regex, senão o gate passa a depender
      // de qual idioma o Chromium escolheu.
      exigir(/conversa(s|tions)/.test(rolagem.cabecalhoTexto || ''),
        'depois: a BARRA continua legível ao rolar — ela fica fora do scroller (' + rolagem.cabecalhoTexto + ')');
      exigir(!rolagem.algumFilhoComOverflowProprio,
        'depois: #abas é o scroller ÚNICO da lateral — nenhum descendente tem overflow-y próprio, no celular NEM no desktop');
      // O par do assert acima: "nenhum filho rola" é metade da promessa. A outra metade é que
      // #abas rola DE VERDADE — senão uma lateral travada passaria nos dois.
      exigir(rolagem.abasRolouDeFato,
        'depois: e #abas ROLA de fato — uma rolagem, não zero (' + JSON.stringify(rolagem) + ')');
      // A barra ENCOSTADA no rodapé da .lateral, não só "dentro do viewport". É o defeito que
      // o dono reprovou na D50 (a caixa desgrudava e nascia no meio), e o cenário LISTA_CURTA
      // é onde ele aparecia.
      exigir(Math.abs(rolagem.folgaAteORodape) <= 2,
        'depois: a barra está COLADA no rodapé da .lateral, não só visível (folga ' + rolagem.folgaAteORodape + 'px)');
      exigir(rolagem.ultimaVisivel, 'depois: o ÚLTIMO job está alcançável (' + JSON.stringify(rolagem) + ')');
      await pagina.screenshot({ path: '/out/depois-jobs-rolados.png' });

      // ── depois-clique-job: clica no job "running" que casa com a aba viva (title contém
      // "painel-alvo" — seletor por TÍTULO, não por posição: com doze jobs há três
      // "trabalhando", e só este tem o \`claude.log\` com a fala) e exige uma FALA
      // identificável na fita — "o painel abriu" não é a prova que a §8 do plano pede.
      // Mesmo par de seletores do smoke irmão (\`smoke-celular-job-passos.js\`).
      await pagina.evaluate(() => {
        const botao = document.querySelector('#grupo-jobs .conversa[title*="painel-alvo"]');
        if (botao) botao.click();
      });
      await pagina.waitForSelector('.painel[data-tipo="job"]', { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 900));
      const clique = await pagina.evaluate(() => {
        const painel = document.querySelector('.painel[data-tipo="job"]');
        const fita = painel && painel.querySelector('.fita');
        return {
          tipo: painel && painel.dataset.tipo,
          falas: fita ? fita.querySelectorAll('.fala').length : 0,
          // O TEXTO, não a contagem: uma fala qualquer, de outro job, satisfaria \`falas > 0\`
          // e o assert diria "a conversa do job abriu" sem que fosse a conversa DELE.
          // Achado do painel de execução.
          texto: fita ? fita.textContent : '',
          titulo: painel ? (painel.querySelector('.chat-titulo') || {}).textContent || '' : '',
        };
      });
      exigir(clique.tipo === 'job', 'depois: o clique abriu o painel do JOB (' + JSON.stringify({ tipo: clique.tipo, falas: clique.falas }) + ')');
      exigir(clique.falas > 0, 'depois: a fita do job tem uma FALA de verdade, não só ferramenta (' + clique.falas + ')');
      exigir(/smoke da caixa fixa/.test(clique.texto),
        'depois: e a fala é a DESTE job — o texto plantado no claude.log dele está na fita (' + clique.texto.slice(0, 80) + ')');
      exigir(/painel-alvo/.test(clique.titulo),
        'depois: o cabeçalho do painel nomeia o job clicado (' + clique.titulo + ')');
      await pagina.screenshot({ path: '/out/depois-clique-job.png' });

      // ── depois-volta-conversas: volta para a lista e clica na barra de NOVO — o SEGUNDO
      // clique, provando o alternador (BA-1). As conversas voltam, o grupo de jobs some.
      await pagina.evaluate(() => { const v = document.querySelector('.voltar'); if (v) v.click(); });
      await new Promise((r) => setTimeout(r, 400));
      await pagina.evaluate(() => { document.getElementById('barra-agentes').click(); });
      await new Promise((r) => setTimeout(r, 300));
      const volta = await pagina.evaluate(() => ({
        temGrupo: Boolean(document.getElementById('grupo-jobs')),
        linhasAbas: document.querySelectorAll('#lista-conversas .conversa-linha').length,
      }));
      exigir(!volta.temGrupo, 'depois: de volta em CONVERSAS, #grupo-jobs some de novo — o alternador funciona nos dois sentidos');
      exigir(volta.linhasAbas >= 2, 'depois: e as abas voltam a aparecer (' + volta.linhasAbas + ')');
      await pagina.screenshot({ path: '/out/depois-volta-conversas.png' });

      // ── depois-conversa-aberta: só no CELULAR — a perda DECLARADA da §2.4 da spec. Com
      // uma conversa aberta a '.lateral' inteira sai da tela (celular, data-vista="chat"), e
      // a barra mora dentro dela — o contador de agentes não tem mais canal nenhum ali.
      if (!DESKTOP) {
        const abriuConversa = await pagina.evaluate(() => {
          const linha = document.querySelector('#abas .conversa-linha .conversa');
          if (!linha) return false;
          linha.click();
          return true;
        });
        exigir(abriuConversa, 'depois: consegui clicar numa conversa para abrir');
        await pagina.waitForSelector('.fita', { timeout: 15000 });
        await new Promise((r) => setTimeout(r, 500));
        await pagina.screenshot({ path: '/out/depois-conversa-aberta.png' });
      }

      exigir(erros.length === 0, 'depois: sem erro de console no percurso inteiro (' + (erros.slice(0, 3).join(' | ') || 'nenhum') + ')');
    }

    console.log('@@MEDIDAS-JOBS@@' + JSON.stringify({ feitos, problemas }));
  } finally {
    await navegador.close();
  }
})().catch((e) => {
  console.error('ROTEIRO QUEBROU:', e.message);
  console.log('@@MEDIDAS-JOBS@@' + JSON.stringify({ feitos: [], problemas: ['roteiro estourou: ' + e.message] }));
  process.exitCode = 1;
});
`;
}

// ─── Rodar um MODO dentro do container, contra a BASE dada ───────────────────

function rodarModo({ modo, base, scratch }) {
  return new Promise((resolve) => {
    const docker = spawn('docker', [
      'run', '--rm', '--network', 'host', '--entrypoint', 'node',
      '-e', `BASE=${base}`,
      '-e', `MODO=${modo}`,
      // Sem este `-e`, `process.env.VIEWPORT` é `undefined` DENTRO do container — o roteiro
      // cairia no default de celular e um `depois-desktop` sairia em 390×844 com nome de
      // desktop (achado do painel; a variável do HOST não atravessa o `docker run` sozinha).
      '-e', `VIEWPORT=${process.env.VIEWPORT || ''}`,
      '-v', `${scratch}:/w:ro`,
      '-v', `${SAIDA}:/out`,
      IMAGEM, '/w/pane.js',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let saidaDocker = '';
    docker.stdout.on('data', (d) => { saidaDocker += d; });
    docker.stderr.on('data', (d) => { saidaDocker += d; });
    docker.on('close', (codigo) => {
      console.log(saidaDocker);
      const MARCADOR = '@@MEDIDAS-JOBS@@';
      const abre = saidaDocker.indexOf(MARCADOR);
      let relatorio = null;
      if (abre >= 0) {
        try { relatorio = JSON.parse(saidaDocker.slice(abre + MARCADOR.length)); } catch { relatorio = null; }
      }
      resolve(relatorio || { feitos: [], problemas: [`o roteiro (${modo}) não devolveu JSON (código ${codigo})`] });
    });
  });
}

// ─── Corrida ──────────────────────────────────────────────────────────────

(async () => {
  let servidorAntes = null;
  let servidorDepois = null;
  let scratch = null;
  let antesDir = null;
  let pastaJobs = null;

  function limpar() {
    let falhouLimpeza = false;
    for (const [nome, s] of [['antes', servidorAntes], ['depois', servidorDepois]]) {
      if (s && s.exitCode === null) {
        try { process.kill(s.pid); } catch { /* já morreu */ }
        console.log(`  · servidor ${nome} (pid ${s.pid}) derrubado pelo pid exato`);
      }
    }
    // Fail-closed de verdade: se a janela-âncora sumiu, isto é FALHA — não um aviso que o
    // smoke ignora. Sem incrementar `falhas`, um smoke que perdeu a posse do socket podia
    // sair 0 deixando um servidor tmux vivo, contaminando a execução seguinte (a #24 por
    // outro caminho).
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    if (temCarimbo) {
      t(['kill-server'], { tolerante: true });
    } else if (scratch) {
      // Só é falha se a fixture chegou a existir (socket criado) — abortos antes da fixture
      // não têm carimbo para achar.
      falhouLimpeza = true;
      falhas += 1;
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (antesDir) fs.rmSync(antesDir, { recursive: true, force: true });
    if (pastaJobs) fs.rmSync(pastaJobs, { recursive: true, force: true });
    return !falhouLimpeza;
  }

  try {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
    } catch {
      console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe.`);
      limpar();
      return process.exit(2);
    }

    fs.mkdirSync(SAIDA, { recursive: true });
    const jaTemPng = fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'));
    if (jaTemPng) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. O smoke recusa sobrescrever.`);
      limpar();
      return process.exit(2);
    }

    for (const porta of [PORTA_ANTES, PORTA_DEPOIS, PORTA_FOLGA]) {
      if (portaOcupada(porta)) {
        console.error(`🔴 a porta ${porta} já está em uso — aborta antes de subir qualquer coisa.`);
        limpar();
        return process.exit(2);
      }
    }

    // ── 1) a árvore inteira do `develop` (o "antes") — `server.js` sozinho não sobe ────
    antesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-antes-jobs-'));
    const shaDevelop = execSync('git rev-parse develop', { cwd: RAIZ, encoding: 'utf8' }).trim();
    execSync(`git archive develop | tar -x -C ${antesDir}`, { cwd: RAIZ });
    console.log(`  · árvore do "antes" = develop@${shaDevelop}, extraída em ${antesDir}`);

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-celular-jobs-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });

    // ── 2) as panes: duas COM agente + seis de ENCHIMENTO, num socket próprio ──────────
    // Oito abas em CINCO projetos, não duas (Fase 4 do plano, achado do painel): a queixa
    // que originou o card é "com 3 projetos abertos a caixa já nasce abaixo da dobra"
    // (spec §1.2) — com duas abas a lista nem enche a tela, e o desktop não prova que a
    // caixa fica visível com a lista de conversas LONGA, que é o ponto inteiro da entrega.
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', 'painelalvo', '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-window', '-t', SESSAO, '-n', 'painelfora', '-c', os.tmpdir(), 'sleep', '600']);

    // Seis abas de ENCHIMENTO, em três projetos NOVOS (2 abas cada — 5 projetos ao todo com
    // painelalvo/painelfora). SEM `plantarAgenteFalso`/`escreverSessao` de propósito: aba
    // sem agente ainda é aba na lista (`estilo.css:601`, "Aba sem claude ainda é aba") — o
    // que se quer aqui é ALTURA, não mais um agente fingido. Comentário aqui para a próxima
    // pessoa não "consertar" a falta do agente. O `cwd` PRECISA existir de verdade: é o `-c`
    // do `tmux new-window`, e quem dá identidade a uma aba SEM sessão é o `pane_current_path`
    // REAL (`lib/abas.js:553`), não uma string fabricada como a de `CWD_ALVO`/`CWD_FORA`.
    //
    // `LISTA_CURTA=1` pula as seis: com só painelalvo/painelfora a lista NÃO estoura, e é o
    // outro caso do dia a dia — o que o `sticky` faz quando SOBRA espaço. Ele não sai do
    // fluxo, então a caixa nasce logo abaixo das conversas, e não colada no rodapé. Isso é o
    // desenho, não bug, mas ninguém tinha FOTOGRAFADO (achado do painel de execução), e o
    // título da D49 ("gruda no rodapé") só vale com a lista cheia.
    for (const nomeProjeto of (LISTA_CURTA ? [] : ['projeto-c', 'projeto-d', 'projeto-e'])) {
      const dirProjeto = path.join(scratch, 'projetos', nomeProjeto);
      fs.mkdirSync(dirProjeto, { recursive: true });
      for (let i = 1; i <= 2; i += 1) {
        t(['new-window', '-t', SESSAO, '-n', `${nomeProjeto}-${i}`, '-c', dirProjeto, 'sleep', '600']);
      }
    }

    const saidaPanes = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']);
    const panes = {};
    for (const linha of saidaPanes.split('\n')) {
      if (!linha.trim()) continue;
      const [nome, janelaId, paneId, panePid] = linha.split('\t');
      panes[nome] = { janelaId, paneId, panePid: Number(panePid) };
    }
    for (const nome of ['painelalvo', 'painelfora']) {
      if (!panes[nome]) throw new Error(`a pane "${nome}" não apareceu no list-panes`);
    }

    // ── 3) só então: /proc falso + sessions/<pid>.json + a conversa, com os números REAIS ──
    const T_ALVO = conversaPequena(caminhoDoJsonl(home, CWD_ALVO, SESSID_ALVO), Date.now() - 20 * 60000);
    const T_FORA = conversaPequena(caminhoDoJsonl(home, CWD_FORA, SESSID_FORA), Date.now() - 20 * 60000);

    plantarAgenteFalso(scratch, panes.painelalvo.panePid, { starttime: 1000001 });
    escreverSessao(home, {
      pid: panes.painelalvo.panePid, janela: panes.painelalvo.janelaId, pane: panes.painelalvo.paneId,
      sessaoId: SESSID_ALVO, cwd: CWD_ALVO, starttime: 1000001, status: 'idle',
    });
    plantarAgenteFalso(scratch, panes.painelfora.panePid, { starttime: 1000002 });
    escreverSessao(home, {
      pid: panes.painelfora.panePid, janela: panes.painelfora.janelaId, pane: panes.painelfora.paneId,
      sessaoId: SESSID_FORA, cwd: CWD_FORA, starttime: 1000002, status: 'idle',
    });
    void T_ALVO; void T_FORA;

    // ── 4) o painel dos dois lados: o "antes" (develop) só fala HTTP com o mock; o "depois"
    //    (esta worktree) lê `COCKPIT_JOBS_DIR` do disco — dados equivalentes, canal diferente
    //    (ver o comentário de `montarJobsNoDisco`, acima).
    pastaJobs = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-jobs-depois-'));
    montarJobsNoDisco(pastaJobs);

    // ── 5) sobe os DOIS server.js, na MESMA fixture de abas/proc — só o painel de jobs muda ──
    const ambienteBase = { ...process.env };
    delete ambienteBase.COCKPIT_TOKEN;
    Object.assign(ambienteBase, {
      HOST: '127.0.0.1',
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
    });

    servidorAntes = spawn(process.execPath, [path.join(antesDir, 'server.js')], {
      cwd: antesDir,
      // A MESMA pasta de disco do "depois". Era um mock HTTP (`COCKPIT_PAINEL_JOBS`) enquanto a
      // develop ainda lia os jobs de um serviço externo; a absorção mergeou, e desde então as
      // duas árvores leem do mesmo lugar. Deixar o mock aqui não é inofensivo: a variável
      // passaria a ser ignorada, o "antes" ficaria SEM pasta de jobs, e o smoke reprovaria a
      // ausência do grupo como se fosse defeito da branch.
      env: { ...ambienteBase, PORT: String(PORTA_ANTES), COCKPIT_JOBS_DIR: pastaJobs },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    servidorDepois = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
      cwd: RAIZ,
      env: { ...ambienteBase, PORT: String(PORTA_DEPOIS), COCKPIT_JOBS_DIR: pastaJobs },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    for (const [nome, s, porta] of [['antes', servidorAntes, PORTA_ANTES], ['depois', servidorDepois, PORTA_DEPOIS]]) {
      let pronto = false;
      for (let i = 0; i < 60 && !pronto; i += 1) {
        if (s.exitCode !== null) break;
        pronto = await saude(porta);
        if (!pronto) await espera(200);
      }
      if (!ok(pronto, `servidor ${nome} (${porta}) subiu`)) {
        limpar();
        return process.exit(1);
      }
      console.log(`  · servidor ${nome} no ar em http://127.0.0.1:${porta} (pid ${s.pid})`);
    }

    // ── 6) o roteiro, dentro do container — os DOIS modos, mesmo mock ─────────────
    fs.writeFileSync(path.join(scratch, 'pane.js'), montarRoteiro());

    const relatorioAntes = await rodarModo({ modo: 'antes', base: `http://127.0.0.1:${PORTA_ANTES}`, scratch });
    const relatorioDepois = await rodarModo({ modo: 'depois', base: `http://127.0.0.1:${PORTA_DEPOIS}`, scratch });

    for (const f of relatorioAntes.feitos) console.log(`  ✅ [antes] ${f}`);
    for (const f of relatorioAntes.problemas) console.error(`  ❌ [antes] ${f}`);
    for (const f of relatorioDepois.feitos) console.log(`  ✅ [depois] ${f}`);
    for (const f of relatorioDepois.problemas) console.error(`  ❌ [depois] ${f}`);

    ok(relatorioAntes.problemas.length === 0, 'MODO=antes: nenhum problema');
    ok(relatorioDepois.problemas.length === 0, 'MODO=depois: nenhum problema');

    const pngsEsperados = ['antes-lista', 'antes-agentes', ...PNGS_DEPOIS,
      ...(EH_CELULAR_HOST ? ['antes-conversa-aberta', 'depois-conversa-aberta'] : [])];
    for (const nome of pngsEsperados) {
      const arquivo = path.join(SAIDA, `${nome}.png`);
      ok(fs.existsSync(arquivo) && fs.statSync(arquivo).size > 1000, `${arquivo} gerado`);
    }
  } catch (e) {
    console.error('🔴 o smoke estourou:', e && e.message);
    falhas += 1;
  } finally {
    limpar();
  }

  if (falhas > 0) {
    console.error(`\n🔴 ${falhas} problema(s) — os seis PNGs (se existirem) NÃO valem como prova.`);
    process.exit(1);
  }
  console.log(`\n✅ ${feitos} verificações, os dois modos passaram. PNGs em ${SAIDA}`);
  console.log('FALTA AINDA, e não é automático: abrir os seis PNGs e OLHAR (regra de 25/08).');
})();
