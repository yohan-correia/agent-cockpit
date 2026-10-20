#!/usr/bin/env node
'use strict';
// PRINT DA SAÍDA DO `!` EM CARTÃO (card `saida-do-comando-em-cartao`, D79) — a prova de TELA.
//
// Mudou pixel, tem print: 390x844 (o celular que motivou o card), tema escuro e claro, ANTES (código da
// develop, balão cru do dono) e DEPOIS (cartão de terminal). O print só vale se o cartão estiver NA VISTA: antes
// do obturador o roteiro EXIGE o que mudou (cartão, classe `colado`, faixa `stderr`, "mostrar tudo"),
// e reprova em vez de fotografar uma tela que subiu mas não tem o recurso.
//
// Mundo próprio, como o `print-vitrine.js`: socket de tmux só dele, HOME de mentira, pasta de jobs vazia, uma
// aba de nome genérico e uma conversa escrita à mão (trava de publicação D78: nada de nome real aqui).
// NUNCA aponte para a instância de produção.
//
// Navegador no HOST (a imagem docker de smoke não existe mais): os DOIS caminhos vêm por env, sem padrão —
//   PUPPETEER_CORE=<pasta do puppeteer-core>  CHROME_BIN=<executável do chrome>
//
// Card `saida-do-comando-legivel` (D80): depois dos 4 casos da D79 (que continuam iguais — a saída não-JSON não
// mudou), o roteiro reproduz AO VIVO dois `!` mandados PELO COCKPIT (caixa + botão Enviar, o POST respondido aqui com
// 202 — o send-keys não é o que se prova): com a aba parada, e o print de 11/10 (a fala do agente gravada DEPOIS da
// bolha pendente, depois o eco + a saída JSON de ~1500 caracteres numa linha). ANTES (código sem a D80) o roteiro
// EXIGE os defeitos na vista — cabeçalho "saída" e JSON numa linha; DEPOIS, `$ comando`, 10 linhas e "mostrar tudo".
//
// Uso:
//   SAIDA=/tmp/saida PUPPETEER_CORE=… CHROME_BIN=… node testes/print-saida-comando.js
//   ANTES=1 RAIZ_CODIGO=<cópia git archive da develop sem a D80> SAIDA=… (mesmos dois) node testes/print-saida-comando.js
//
// Códigos de saída: 0 = PNGs gerados · 1 = falhou no meio · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const PORTA = 7967;
const SAIDA = process.env.SAIDA || '';
const ANTES = process.env.ANTES === '1';
const RAIZ_CODIGO = process.env.RAIZ_CODIGO || path.join(__dirname, '..');
const PUPPETEER = process.env.PUPPETEER_CORE || '';
const CHROME = process.env.CHROME_BIN || '';
const SOCKET = `cockpit-smoke-saida-${process.pid}`;
const SESSAO = 'saida';
const CARIMBO = `ancora-saida-${process.pid}`;
const MINHAS_SESSOES = new Set(['ancora', SESSAO]);
const ABA = { nome: 'projeto-a', cwd: '/home/usuario/projetos/projeto-a', sessaoId: 'sess-projeto-a' };
const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

// ─── Fail-closed antes de tocar em qualquer coisa ────────────────────────────

const HERDADO = process.env.COCKPIT_TMUX_SOCKET || '';
if (HERDADO && !/^cockpit-smoke-/.test(HERDADO)) {
  console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${HERDADO}" — abortando antes de tocar em nada.`);
  process.exit(1);
}

// `-f /dev/null` em TODO comando: sem ele o ~/.tmux.conf do dono carrega e o continuum-restore recria as
// sessões dele dentro do socket "isolado".
function t(args, { tolerante = false } = {}) {
  try {
    return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerante) return '';
    throw e;
  }
}

if (t(['ls'], { tolerante: true }).trim()) {
  console.error(`🔴 o socket ${SOCKET} JÁ EXISTE — não é meu. Abortando.`);
  process.exit(1);
}

if (!SAIDA) { console.error('🟡 SAIDA é obrigatória (pasta dos PNGs).'); process.exit(2); }
if (!PUPPETEER || !CHROME) {
  console.error('🟡 ambiente indisponível: PUPPETEER_CORE e CHROME_BIN são obrigatórios (sem padrão).');
  process.exit(2);
}
let puppeteer;
try { puppeteer = require(PUPPETEER); } catch (e) {
  console.error(`🟡 ambiente indisponível: não consegui carregar o puppeteer-core (${String(e.message).split('\n')[0]}).`);
  process.exit(2);
}
if (!fs.existsSync(CHROME)) { console.error('🟡 ambiente indisponível: CHROME_BIN não existe.'); process.exit(2); }

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── A fixture: /proc, sessions e conversa, todos de mentira ─────────────────

const raizProc = (scratch) => path.join(scratch, 'proc');

/** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}` no padrão "exec direto". */
function plantarAgenteFalso(scratch, pid, starttime) {
  const dir = path.join(raizProc(scratch), String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const campos = new Array(52).fill('0');
  campos[0] = String(pid);
  campos[1] = '(claude)';
  campos[2] = 'S';
  campos[3] = '1';
  campos[4] = String(pid);
  campos[5] = String(pid);
  campos[6] = '34816';
  campos[7] = String(pid);
  campos[21] = String(starttime);
  fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), '/usr/bin/claude\0');
  fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
}

function escreverSessao(home, { pid, janela, pane, sessaoId, cwd, starttime }) {
  const raiz = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(raiz, { recursive: true });
  fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
    kind: 'interactive', sessionId: sessaoId, cwd, status: 'idle', updatedAt: Date.now(), pid, procStart: starttime,
    tmux: `${SESSAO}:${janela}.${pane}`,
  }));
}

function caminhoDoJsonl(home, cwd, sessaoId) {
  const pasta = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', pasta, `${sessaoId}.jsonl`);
}

const linhaUser = (iso, texto) => `${JSON.stringify({ type: 'user', timestamp: iso, message: { content: texto } })}\n`;
const linhaAssistente = (iso, texto) => `${JSON.stringify({ type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: texto }] } })}\n`;

/** A conversa da foto: os 4 casos do cartão (curto, stderr, longo recolhido, sem par), nomes neutros. */
function conversa(caminho) {
  const base = Date.now() - 30 * 60000;
  const em = (n) => new Date(base + n * 20000).toISOString();
  const log = Array.from({ length: 40 }, (_, i) => `a1b2c3d feat: item ${i + 1}${i === 6 ? ' -&gt; ok' : ''}`).join('\n');
  const linhas = [
    linhaUser(em(0), 'limpa a branch velha e confere o lint'),
    linhaAssistente(em(1), 'Pode rodar direto com ! que eu acompanho.'),
    linhaUser(em(2), '<bash-input> git branch -D feature/exemplo</bash-input>'),
    linhaUser(em(3), '<bash-stdout>Deleted branch feature/exemplo (was 1a2b3c4).</bash-stdout><bash-stderr></bash-stderr>'),
    linhaUser(em(4), '<bash-input>npm run lint</bash-input>'),
    linhaUser(em(5), '<bash-stdout></bash-stdout><bash-stderr>sh: 1: eslint: not found\n</bash-stderr>'),
    linhaUser(em(6), '<bash-input>git log --oneline -40</bash-input>'),
    linhaUser(em(7), `<bash-stdout>${log}</bash-stdout><bash-stderr></bash-stderr>`),
    linhaAssistente(em(8), 'Pronto. A branch saiu; o lint precisa do eslint instalado.'),
    // Sem `<bash-input>` antes: o caso "sem par" (o cartão não pode grudar na fala do agente).
    linhaUser(em(9), '<bash-stdout>/home/usuario/projetos/projeto-a</bash-stdout><bash-stderr></bash-stderr>'),
  ];
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, linhas.join(''));
}

// Os dois caminhos ao vivo do `!` digitado no cockpit (D80), em sequência na mesma página:
//  · `parada` — a aba estava ociosa: o `enviar` acende o "trabalhando" DEPOIS da bolha, e ele fica ali;
//  · `fila`   — o print de 11/10: com o turno rodando (o "trabalhando" do envio anterior continua aceso), a fala final
//    do agente é gravada DEPOIS da bolha pendente e só então vêm o eco aparado (#95) e a saída JSON numa linha.
const ITENS = Array.from({ length: 7 }, (_, i) => ({
  id: `item-exemplo-${String(i + 1).padStart(2, '0')}-com-um-identificador-comprido`,
  title: `Item de exemplo ${i + 1} com um título de tamanho realista para a triagem`,
  body: null, area: 'geral', type: 'melhoria', priority: i % 2 ? 'media' : 'alta', by: 'usuario',
  createdAt: `2026-10-0${i + 1}T12:00:00.000Z`,
}));
const LINHAS_JSON = JSON.stringify(ITENS, null, 2).split('\n').length;
const AO_VIVO = [
  { n: 5, nome: 'parada', cmd: 'git status --short', fala: null, stdout: ' M lib/exemplo.js\n?? notas.txt', token: 'notas.txt', json: false },
  { n: 6, nome: 'fila', cmd: 'ssh servidor "docker exec banco psql -t -A" < consulta.sql', fala: 'Fechei a triagem; os itens estão no quadro.',
    stdout: JSON.stringify(ITENS), token: 'item-exemplo-01', json: true },
];

/** O que o CLI grava depois do envio, na ordem do disco real: a fala (se houver), o eco aparado (#95), a saída. */
function gravarAoVivo(caminho, caso) {
  const agora = Date.now();
  const em = (n) => new Date(agora + n * 300).toISOString();
  if (caso.fala) fs.appendFileSync(caminho, linhaAssistente(em(0), caso.fala));
  fs.appendFileSync(caminho, linhaUser(em(1), `<bash-input>${caso.cmd}</bash-input>`));
  fs.appendFileSync(caminho, linhaUser(em(2), `<bash-stdout>${caso.stdout}\n</bash-stdout><bash-stderr></bash-stderr>`));
}

function saude() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/health', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── O roteiro do navegador — roda NO PRÓPRIO processo ───────────────────────

const CASOS = [
  { n: 1, nome: 'curto', token: 'Deleted branch feature/exemplo' },
  { n: 2, nome: 'stderr', token: 'eslint: not found' },
  { n: 3, nome: 'longo', token: 'item 1' },
  { n: 4, nome: 'sem-par', token: '/home/usuario/projetos/projeto-a' },
];

async function roteiro(base, caminhoConversa) {
  const problemas = [];
  const gerados = [];
  const navegador = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const tema of ['dark', 'light']) {
      const pagina = await navegador.newPage();
      const pre = ANTES ? `antes-${tema}` : tema;
      const problemasAntes = problemas.length;
      // Cada tema parte da MESMA conversa: o caso ao vivo do tema anterior acrescentou linhas no arquivo.
      conversa(caminhoConversa);
      try {
        await pagina.setRequestInterception(true);
        // Só o POST do envio é respondido aqui (202, como o servidor faz): o que se prova é a fita, não o tmux.
        pagina.on('request', (req) => {
          if (req.method() === 'POST' && /\/api\/abas\/[\w-]+\/turnos$/.test(req.url())) {
            req.respond({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
          } else req.continue();
        });
        await pagina.setViewport(VIEWPORT);
        await pagina.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: tema }]);
        await pagina.evaluateOnNewDocument(() => { try { localStorage.setItem('cockpit-idioma', 'pt-BR'); } catch (e) { /* vale nesta página */ } });
        await pagina.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 });
        await pagina.waitForSelector('#abas', { timeout: 15000 });
        await espera(800);
        const clicou = await pagina.evaluate((nome) => {
          const linha = Array.from(document.querySelectorAll('#abas .conversa-linha'))
            .find((l) => { const x = l.querySelector('.conversa-titulo'); return x && x.textContent.includes(nome); });
          const botao = linha && linha.querySelector('.conversa');
          if (botao) botao.click();
          return Boolean(botao);
        }, ABA.nome);
        if (!clicou) { problemas.push(`${pre}: não achei a linha de ${ABA.nome}`); continue; }
        // Espera a .fita DESENHAR (o modo de falha clássico é o print da tela "escolha uma conversa").
        let desenhou = false;
        for (let i = 0; i < 50 && !desenhou; i += 1) {
          desenhou = await pagina.evaluate(() => { const f = document.querySelector('.fita'); return Boolean(f && f.textContent.trim().length > 200); });
          if (!desenhou) await espera(200);
        }
        if (!desenhou) { problemas.push(`${pre}: a .fita não desenhou a conversa`); continue; }
        await espera(600);

        // O que a fita TEM, lido do DOM antes do obturador.
        const fato = await pagina.evaluate(() => {
          const fita = document.querySelector('.fita');
          const filhos = Array.from(fita.children);
          const cartoes = filhos.filter((n) => n.classList.contains('saida-comando')).map((n) => ({
            colado: n.classList.contains('colado'),
            cabecalho: (n.querySelector('.saida-comando-texto') || {}).textContent || '',
            stderr: Boolean(n.querySelector('.saida-stderr')),
            mais: (n.querySelector('.saida-mais') || {}).textContent || '',
          }));
          const crus = filhos.filter((n) => n.classList.contains('bolha-eu') && n.textContent.includes('<bash-stdout>')).length;
          return { cartoes, crus };
        });
        // Os 4 casos da D79 valem nos DOIS modos: a saída que não é JSON não muda com a D80.
        {
          const [c1, c2, c3, c4] = fato.cartoes;
          if (fato.cartoes.length < 4) problemas.push(`${pre}: esperava ≥ 4 cartões, achei ${fato.cartoes.length}`);
          if (fato.crus) problemas.push(`${pre}: ainda há ${fato.crus} balão(ões) do dono com <bash-stdout>`);
          if (!(c1 && c1.colado && c1.cabecalho.startsWith('$ git branch -D'))) problemas.push(`${pre}: cartão 1 sem colado/cabeçalho "$ git branch -D" (${JSON.stringify(c1)})`);
          if (!(c2 && c2.stderr)) problemas.push(`${pre}: cartão 2 sem a faixa stderr`);
          if (!(c3 && c3.mais === 'mostrar tudo (40 linhas)')) problemas.push(`${pre}: cartão 3 sem "mostrar tudo (40 linhas)" (${JSON.stringify(c3 && c3.mais)})`);
          if (!(c4 && !c4.colado && c4.cabecalho === 'saída')) problemas.push(`${pre}: cartão 4 devia estar solto, com cabeçalho "saída" (${JSON.stringify(c4)})`);
        }
        if (problemas.length > problemasAntes) continue;

        for (const caso of CASOS) {
          // Alvo: filho DIRETO da .fita com o token (nunca o cabeçalho da conversa, que cita o caminho).
          const achou = await pagina.evaluate((token) => {
            const fita = document.querySelector('.fita');
            const alvo = Array.from(fita.children).find((n) => n.textContent.includes(token));
            if (!alvo) return false;
            alvo.scrollIntoView({ block: 'center' });
            return true;
          }, caso.token);
          if (!achou) { problemas.push(`${pre}-${caso.n}-${caso.nome}: não achei o token na fita`); continue; }
          await espera(400);
          const arq = path.join(SAIDA, `${pre}-${caso.n}-${caso.nome}.png`);
          await pagina.screenshot({ path: arq });
          gerados.push(arq);
        }

        // ── Os casos ao vivo (D80): `!` digitado no cockpit, o POST respondido aqui, as linhas do CLI no arquivo ──
        for (const caso of AO_VIVO) {
          const rotulo = `${pre}-${caso.n}-${caso.nome}`;
          const digitou = await pagina.evaluate((texto) => {
            const caixa = document.querySelector('.painel .entrada');
            const botao = document.querySelector('.painel .btn-enviar');
            if (!caixa || !botao) return false;
            caixa.value = texto;
            caixa.dispatchEvent(new Event('input', { bubbles: true }));
            botao.click();
            return true;
          }, `! ${caso.cmd}`);
          if (!digitou) { problemas.push(`${rotulo}: não achei a caixa/botão de envio`); break; }
          let pendente = false;
          for (let i = 0; i < 25 && !pendente; i += 1) {
            pendente = await pagina.evaluate(() => Boolean(document.querySelector('.fita .bolha-pendente')));
            if (!pendente) await espera(200);
          }
          if (!pendente) { problemas.push(`${rotulo}: a bolha pendente do envio não apareceu`); break; }
          gravarAoVivo(caminhoConversa, caso);
          let vivo = null;
          for (let i = 0; i < 50 && !vivo; i += 1) {
            vivo = await pagina.evaluate((token) => {
              const filhos = Array.from(document.querySelector('.fita').children);
              const cartao = filhos.filter((n) => n.classList.contains('saida-comando')).find((n) => n.textContent.includes(token));
              if (!cartao) return null;
              const pre = cartao.querySelector('pre');
              const acima = filhos[filhos.indexOf(cartao) - 1];
              return {
                cabecalho: (cartao.querySelector('.saida-comando-texto') || {}).textContent || '',
                colado: cartao.classList.contains('colado'),
                linhas: pre ? pre.textContent.split('\n').length : 0,
                mais: (cartao.querySelector('.saida-mais') || {}).textContent || '',
                pendentes: document.querySelectorAll('.fita .bolha-pendente').length,
                acima: acima ? acima.className : '',
              };
            }, caso.token);
            if (!vivo) await espera(200);
          }
          if (!vivo) { problemas.push(`${rotulo}: o cartão da saída não chegou`); break; }
          console.log(`  · ${rotulo}: ${JSON.stringify(vivo)}`);
          const antesDeste = problemas.length;
          if (vivo.pendentes) problemas.push(`${rotulo}: a pendente não foi absorvida (${vivo.pendentes})`);
          if (ANTES) {
            if (vivo.cabecalho !== 'saída') problemas.push(`${rotulo}: ANTES devia mostrar o defeito — cabeçalho "saída" (${vivo.cabecalho})`);
            if (caso.json && (vivo.linhas !== 1 || vivo.mais)) problemas.push(`${rotulo}: ANTES devia mostrar o JSON numa linha só (${vivo.linhas} linhas, mais="${vivo.mais}")`);
          } else {
            if (vivo.cabecalho !== `$ ${caso.cmd}`) problemas.push(`${rotulo}: cabeçalho devia ser "$ ${caso.cmd}" (${vivo.cabecalho})`);
            // D80 L3: com "trabalhando" (parada) ou fala do agente (fila) logo acima, o cartão sai solto.
            if (vivo.colado) problemas.push(`${rotulo}: não devia estar colado — o nó acima é "${vivo.acima}"`);
            if (caso.json && (vivo.linhas !== 10 || vivo.mais !== `mostrar tudo (${LINHAS_JSON} linhas)`)) problemas.push(`${rotulo}: devia recolher em 10 linhas com "mostrar tudo (${LINHAS_JSON} linhas)" (${vivo.linhas}, "${vivo.mais}")`);
            // A saída que não é JSON fica como veio: 2 linhas, sem botão.
            if (!caso.json && (vivo.linhas !== 2 || vivo.mais)) problemas.push(`${rotulo}: saída não-JSON mudou (${vivo.linhas} linhas, "${vivo.mais}")`);
          }
          if (problemas.length > antesDeste) break;
          // O topo do cartão um pouco abaixo do topo da tela: o cabeçalho E o que está acima dele na mesma foto.
          // Conta direta e `behavior: 'instant'`: um scrollIntoView suave ainda estaria andando quando a folga fosse aplicada.
          const focar = (folga) => pagina.evaluate((token, f) => {
            const cartao = Array.from(document.querySelectorAll('.fita .saida-comando')).find((n) => n.textContent.includes(token));
            const caixa = cartao.closest('.mensagens');
            const alvo = caixa.scrollTop + cartao.getBoundingClientRect().top - caixa.getBoundingClientRect().top - f;
            caixa.scrollTo({ top: alvo, behavior: 'instant' });
          }, caso.token, folga);
          await focar(260);
          await espera(400);
          const arq = path.join(SAIDA, `${rotulo}${caso.json ? '-recolhido' : ''}.png`);
          await pagina.screenshot({ path: arq });
          gerados.push(arq);
          if (ANTES || !caso.json) continue;
          const aberto = await pagina.evaluate((token) => {
            const cartao = Array.from(document.querySelectorAll('.fita .saida-comando')).find((n) => n.textContent.includes(token));
            cartao.querySelector('.saida-mais').click();
            return cartao.querySelector('pre').textContent.split('\n').length;
          }, caso.token);
          if (aberto !== LINHAS_JSON) { problemas.push(`${rotulo}: aberto devia ter ${LINHAS_JSON} linhas (${aberto})`); break; }
          await focar(120);
          await espera(400);
          const arqAberto = path.join(SAIDA, `${rotulo}-aberto.png`);
          await pagina.screenshot({ path: arqAberto });
          gerados.push(arqAberto);
        }
      } catch (e) {
        problemas.push(`${pre}: o roteiro estourou — ${String(e && e.message).slice(0, 300)}`);
      } finally {
        await pagina.close().catch(() => {});
      }
    }
  } finally {
    await navegador.close().catch(() => {});
  }
  return { gerados, problemas };
}

// ─── Corrida ─────────────────────────────────────────────────────────────────

(async () => {
  let servidor = null;
  let scratch = null;

  function limpar() {
    if (servidor && servidor.exitCode === null) {
      try { process.kill(servidor.pid); } catch { /* já morreu */ }
      console.log(`  · servidor (pid ${servidor.pid}) derrubado pelo pid exato`);
    }
    // Duas respostas, não uma (D35): o carimbo prova que EU criei, a enumeração prova que não há mais ninguém
    // no socket. Matar exige as duas.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const intrusas = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean)
      .filter((n) => !MINHAS_SESSOES.has(n));
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      console.error(`  ❌ a janela âncora (${CARIMBO}) sumiu — não provo a posse do socket. Não derrubo nada.`);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  try {
    fs.mkdirSync(SAIDA, { recursive: true });
    if (fs.readdirSync(SAIDA).some((n) => n.endsWith('.png'))) {
      console.error(`🔴 ${SAIDA} já tem PNG — apague ou troque de pasta. Não sobrescrevo print antigo às cegas.`);
      return process.exit(2);
    }
    if (!fs.existsSync(path.join(RAIZ_CODIGO, 'server.js'))) {
      console.error('🟡 RAIZ_CODIGO não tem o servidor.');
      return process.exit(2);
    }

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'saida-'));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(raizProc(scratch), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'jobs'), { recursive: true });

    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', ABA.nome, '-c', os.tmpdir(), 'sleep', '600']);
    const linha = t(['list-panes', '-a', '-F', '#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')
      .map((l) => l.split('\t')).find((p) => p[0] === ABA.nome);
    if (!linha) throw new Error(`a pane "${ABA.nome}" não apareceu no list-panes`);
    const [, janelaId, paneId, panePid] = linha;
    plantarAgenteFalso(scratch, Number(panePid), 3000001);
    escreverSessao(home, { pid: Number(panePid), janela: janelaId, pane: paneId, sessaoId: ABA.sessaoId, cwd: ABA.cwd, starttime: 3000001 });
    const caminhoConversa = caminhoDoJsonl(home, ABA.cwd, ABA.sessaoId);
    conversa(caminhoConversa);
    console.log(`  · fixture pronta: ${ABA.nome} (${ANTES ? 'ANTES' : 'DEPOIS'})`);

    // Ambiente do servidor por LISTA FECHADA (#78/#82): parte do processo, apaga tudo que é do cockpit/agentes e
    // reescreve só o que o mundo de mentira precisa — nada de pasta, token ou socket do dono vaza.
    const ambiente = { ...process.env };
    for (const k of Object.keys(ambiente)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(k)) delete ambiente[k];
    delete ambiente.PORT;
    Object.assign(ambiente, {
      HOST: '127.0.0.1',
      PORT: String(PORTA),
      HOME: home,
      COCKPIT_CERT_DIR: '/dev/null',
      COCKPIT_TMUX_SOCKET: SOCKET,
      COCKPIT_TMUX_SESSAO: SESSAO,
      COCKPIT_PROC_RAIZ: raizProc(scratch),
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'),
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'),
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
      COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
    });
    servidor = spawn(process.execPath, [path.join(RAIZ_CODIGO, 'server.js')], { env: ambiente, cwd: RAIZ_CODIGO, stdio: ['ignore', 'ignore', 'pipe'] });

    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i += 1) {
      if (servidor.exitCode !== null) break;
      pronto = await saude();
      if (!pronto) await espera(200);
    }
    if (!pronto) {
      console.error(`🔴 o servidor (${PORTA}) não subiu`);
      limpar();
      return process.exit(1);
    }
    console.log(`  · servidor no ar em http://127.0.0.1:${PORTA} (pid ${servidor.pid}), socket ${SOCKET}`);

    const { gerados, problemas } = await roteiro(`http://127.0.0.1:${PORTA}`, caminhoConversa);
    for (const g of gerados) console.log(`  ✅ ${g}`);
    for (const p of problemas) console.error(`  ❌ ${p}`);
    limpar();
    return process.exit(problemas.length ? 1 : 0);
  } catch (e) {
    console.error('🔴 estourou:', e && e.message ? e.message : e);
    limpar();
    return process.exit(1);
  }
})();
