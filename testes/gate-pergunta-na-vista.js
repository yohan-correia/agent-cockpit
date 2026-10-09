#!/usr/bin/env node
'use strict';
// GATE — a pergunta da TUI tem que estar NA VISTA quando ela abre.
//
// O DEFEITO que motivou este arquivo (medido em 23/09/2026, no cockpit do dono, no celular):
// a `.pergunta` era `position: absolute; inset: 0` dentro da `.mensagens`, que é um ROLADOR.
// Filho `absolute` de rolador NÃO se mede pela vista dele — se mede pelo topo do CONTEÚDO, e
// rola junto. Como abrir a pergunta chama `rolarFim` (`pintarTelaDaPane`, public/app.js), o
// painel nascia no começo do rolo e a vista ia para o fim: `top = -7671px` numa conversa de
// 60 mensagens em 390x844. Presente no DOM, `hidden = false`, e fora do campo de visão.
//
// POR QUE ISSO PASSOU no smoke de 22/09: ele usa conversa CURTA. Sem rolagem, o topo do
// conteúdo É a vista, e o mesmo CSS quebrado acerta o lugar. É exatamente por isso que o caso
// `comprida` existe aqui — e é o único que reprova o código de ontem.
//
// O que este gate mede, e o `testes/gate-ui.js` não consegue: GEOMETRIA. Lá o DOM é de
// mentira e não faz layout; a asserção de lá é de TEXTO do CSS e prova só a régua. Aqui roda
// um Chromium de verdade sobre o `public/estilo.css` de verdade.
//
// A régua, nas quatro combinações de (largura × tamanho da conversa):
//   R1  a `.pergunta` intersecta a área visível da `.mensagens`
//   R2  quem responde no CENTRO dessa área é a própria `.pergunta` (não a conversa por baixo)
//   R3  o botão `Enter` do menu está dentro da viewport (é o alvo do dedo)
//   R4  a CAIXA DE ESCRITA continua alcançável — foi por isso que o `fixed` caiu em 22/09,
//       e um conserto que a cubra de novo troca um defeito por outro
// E, no celular com conversa comprida, o caso que o dono pediu (23/09):
//   R5  rolando para cima a conversa REAPARECE — a pergunta não é modal, ele quer poder ler
//
// DESENHO: a página é montada aqui, com o `public/estilo.css` de verdade. Para ela não
// apodrecer em silêncio quando o `criarPainel` mudar, o gate confere ANTES (R0) que cada
// classe que ele usa ainda é montada em `public/app.js`, e na mesma ordem dentro da
// `.mensagens`. Sem isso, o gate passaria a medir uma tela que não existe mais.
//
// Porta 7895 (7893/7894 são dos outros gates de navegador · 7899 é dos jobs · 7879 é
// PRODUÇÃO — nunca). Os PNGs vão para `~/.cockpit/smoke-shots/`, nunca para /tmp.
//
// Como rodar:
//   node testes/gate-pergunta-na-vista.js
//   SAIDA=~/.cockpit/smoke-shots/minha-pasta node testes/gate-pergunta-na-vista.js
//
// Códigos de saída: 0 = passou · 1 = defeito · 2 = ambiente indisponível.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..');
const PUBLICO = path.join(RAIZ, 'public');
const PORTA = 7895;
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';
const HOJE = new Date().toISOString().slice(0, 10);
const SAIDA = process.env.SAIDA
  || path.join(os.homedir(), '.cockpit', 'smoke-shots', `${HOJE}-pergunta-na-vista`);

let falhas = 0;
let feitos = 0;
const ok = (cond, texto) => {
  feitos += 1;
  if (!cond) falhas += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${texto}`);
  return cond;
};

try {
  execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
} catch {
  console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe nesta máquina.`);
  process.exit(2);
}

// ─── R0 — a tela que este gate monta ainda é a que o app monta ───────────────

console.log('\nR0 — o molde de tela deste gate bate com o criarPainel() de verdade');
const app = fs.readFileSync(path.join(PUBLICO, 'app.js'), 'utf8');
// `pergunta-cartao` e `pergunta-terminal` entraram com o card pergunta-do-agente-em-cartao
// (D74): a .pergunta ganhou o cartão e o <details> que guarda a tela crua.
const CLASSES = ['painel', 'chat-topo', 'mensagens', 'puxar-selo', 'fita',
  'pergunta', 'pergunta-cartao', 'pergunta-terminal', 'pergunta-tela', 'pergunta-teclas',
  'aviso-escrita', 'aviso-gancho', 'envio', 'envio-area'];
for (const classe of CLASSES) {
  ok(new RegExp(`className = '${classe}'`).test(app), `public/app.js ainda monta .${classe}`);
}
// A ORDEM dentro do rolador importa para a medição: a pergunta é o ÚLTIMO bloco, depois da
// fita. Invertida, "rolou até o fim" deixaria de significar "a pergunta está na vista".
ok(/mensagens\.append\(puxarSelo, fitaEl, pergunta\)/.test(app),
  'e a pergunta é o ÚLTIMO filho da .mensagens, depois da fita');
// A ordem DENTRO da .pergunta: cartão, terminal (<details>), teclas FORA dele (a coluna flex
// desce as teclas ao rodapé por `margin-top: auto`; dentro de um <details> isso não vale) e
// o aviso de escrita.
ok(/pergunta\.append\(cartaoEl, terminalPergunta, perguntaTeclas, avisoEscrita, avisoGancho\)/.test(app),
  'e dentro da .pergunta a ordem é cartão → terminal → teclas → aviso → aviso do hook (as teclas ficam FORA do <details>)');
// O `rolarFim` na primeira pintura é a metade do defeito: sem ele a vista nunca ia para o fim
// e o `absolute` quebrado não apareceria. Se ele sair, esta medição deixa de valer.
ok(/if \(primeira\) rolarFim\(painel\)/.test(app),
  'e a primeira pintura da tela da pane ainda rola para o fim (é o que expunha o defeito)');

if (falhas) {
  console.error('\n🔴 o molde divergiu do app — conserte o gate ANTES de confiar na medição.');
  process.exit(1);
}

// ─── A página de medição ─────────────────────────────────────────────────────

const PAGINA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/estilo.css"><title>gate pergunta na vista</title></head>
<body>
<div class="app" data-vista="chat" data-lateral="fechada">
  <aside class="lateral"></aside>
  <main class="chat">
    <div class="paineis">
      <div class="painel" data-tipo="aba" data-foco="1">
        <div class="chat-topo"><div class="chat-identidade"><div class="chat-nome">
          <h1 class="chat-titulo">aba do gate</h1></div></div></div>
        <div class="mensagens">
          <div class="puxar-selo" aria-hidden="true"><span class="puxar-anel"></span></div>
          <div class="fita"></div>
          <div class="pergunta" hidden>
            <div class="pergunta-cartao" hidden></div>
            <details class="pergunta-terminal" data-sem-cartao="1" open>
              <summary class="pergunta-terminal-rotulo">ver terminal</summary>
              <pre class="pergunta-tela">Do you want to proceed?
  1. Yes
❯ 2. No, tell Claude what to do differently
  3. Yes, and don't ask again</pre>
            </details>
            <div class="pergunta-teclas">
              <button class="btn tecla" data-tecla="Left">←</button>
              <button class="btn tecla" data-tecla="Up">↑</button>
              <button class="btn tecla" data-tecla="Down">↓</button>
              <button class="btn tecla" data-tecla="Right">→</button>
              <button class="btn btn-principal tecla" data-tecla="Enter">Enter</button>
              <button class="btn tecla" data-tecla="Escape">Esc</button>
            </div>
            <div class="aviso-escrita">Escrever aqui manda Esc antes do texto.</div>
            <div class="aviso-gancho">Cartão da pergunta desligado: o hook não está instalado (DECISOES.md, D74).</div>
          </div>
        </div>
        <div class="envio"><div class="envio-area"><div class="envio-caixa">
          <textarea rows="1" placeholder="escreva..."></textarea>
          <button class="btn btn-principal">Enviar</button>
        </div></div></div>
      </div>
    </div>
  </main>
</div>
<script>
  const fita = document.querySelector('.fita');
  const quantas = Number(new URLSearchParams(location.search).get('bolhas') || 60);
  for (let i = 0; i < quantas; i++) {
    const b = document.createElement('div');
    b.className = i % 2 ? 'bolha-eu' : 'fala';
    b.textContent = 'mensagem ' + i + ' — texto de enchimento para a fita ficar comprida o bastante para rolar de verdade.';
    fita.append(b);
  }
  // O que o app faz de verdade ao abrir a pergunta: mostra o bloco e rola para o fim
  // (marcarPergunta → atualizarTelaDaPane → pintarTelaDaPane → rolarFim).
  window.__abrirPergunta = () => {
    const m = document.querySelector('.mensagens');
    // \`scroll-behavior: smooth\` ANIMA a rolagem, e medir no meio da animação mentiria. O app
    // desliga isso no despejo da rajada (\`data-pintando\`); aqui desligo pelo mesmo motivo.
    m.style.scrollBehavior = 'auto';
    document.querySelector('.pergunta').hidden = false;
    m.scrollTop = m.scrollHeight;
  };
  window.__medir = () => {
    const m = document.querySelector('.mensagens');
    const p = document.querySelector('.pergunta');
    const r = p.getBoundingClientRect();
    const rm = m.getBoundingClientRect();
    const noPonto = document.elementFromPoint(
      Math.round(rm.left + rm.width / 2), Math.round(rm.top + rm.height / 2));
    const cx = document.querySelector('.envio textarea').getBoundingClientRect();
    const naCaixa = document.elementFromPoint(
      Math.round(cx.left + cx.width / 2), Math.round(cx.top + cx.height / 2));
    const en = document.querySelector('[data-tecla="Enter"]').getBoundingClientRect();
    return {
      position: getComputedStyle(p).position,
      hidden: p.hidden,
      topo: Math.round(r.top), base: Math.round(r.bottom),
      vistaTopo: Math.round(rm.top), vistaBase: Math.round(rm.bottom),
      naVista: r.bottom > rm.top && r.top < rm.bottom,
      noCentro: noPonto ? (noPonto.closest('.pergunta') ? 'pergunta' : (noPonto.className || noPonto.tagName)) : 'nada',
      naCaixa: naCaixa ? (naCaixa.tagName === 'TEXTAREA' ? 'textarea' : (naCaixa.className || naCaixa.tagName)) : 'nada',
      enterNaVista: en.top >= 0 && en.bottom <= window.innerHeight,
      // R5: com a pergunta aberta, rolar para cima tem que devolver a conversa.
      conversaAoSubir: (() => {
        const antes = m.scrollTop;
        m.scrollTop = 0;
        const q = document.elementFromPoint(
          Math.round(rm.left + rm.width / 2), Math.round(rm.top + rm.height / 2));
        const nome = q ? (q.closest('.pergunta') ? 'pergunta' : (q.className || q.tagName)) : 'nada';
        m.scrollTop = antes;
        return nome;
      })(),
    };
  };
</script>
</body></html>`;

const ROTEIRO = `
const puppeteer = require('/app/node_modules/puppeteer-core');
const CASOS = ${JSON.stringify([
  { nome: 'celular-comprida', w: 390, h: 844, mobile: true, bolhas: 60 },
  { nome: 'celular-curta', w: 390, h: 844, mobile: true, bolhas: 1 },
  { nome: 'desktop-comprida', w: 1600, h: 1000, mobile: false, bolhas: 60 },
  { nome: 'desktop-curta', w: 1600, h: 1000, mobile: false, bolhas: 1 },
])};
(async () => {
  const nav = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const saida = {};
  for (const c of CASOS) {
    const p = await nav.newPage();
    await p.setViewport({ width: c.w, height: c.h, isMobile: c.mobile, hasTouch: c.mobile, deviceScaleFactor: 2 });
    await p.goto('http://127.0.0.1:${PORTA}/?bolhas=' + c.bolhas, { waitUntil: 'networkidle2', timeout: 30000 });
    await p.evaluate(() => window.__abrirPergunta());
    await new Promise((r) => setTimeout(r, 300));
    saida[c.nome] = await p.evaluate(() => window.__medir());
    await p.screenshot({ path: '/out/' + c.nome + '.png' });
    await p.close();
  }
  console.log('---JSON---');
  console.log(JSON.stringify(saida));
  await nav.close();
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
`;

// ─── Sobe, mede, derruba ─────────────────────────────────────────────────────

const servidor = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGINA);
  }
  const arq = path.join(PUBLICO, url.replace(/^\/+/, ''));
  if (!arq.startsWith(PUBLICO) || !fs.existsSync(arq)) { res.writeHead(404); return res.end(''); }
  res.writeHead(200, { 'content-type': url.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/plain' });
  res.end(fs.readFileSync(arq));
});

fs.mkdirSync(SAIDA, { recursive: true });
const trabalho = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-pergunta-'));
fs.writeFileSync(path.join(trabalho, 'roteiro.js'), ROTEIRO);

// 🔴 O docker roda por `spawn`, NUNCA por `execFileSync`: o servidor de medição vive NESTE
// processo, e a versão síncrona trava o event loop — o Chromium subia, pedia a página e
// tomava "Navigation timeout" de um servidor que não podia responder. Medido aqui mesmo.
servidor.listen(PORTA, '127.0.0.1', () => {
  const filho = spawn('docker', ['run', '--rm', '--network', 'host',
    '-v', `${path.join(trabalho, 'roteiro.js')}:/roteiro.js:ro`,
    '-v', `${SAIDA}:/out`, IMAGEM, 'node', '/roteiro.js'],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  let bruto = '';
  filho.stdout.on('data', (p) => { bruto += p; });
  filho.on('close', (codigo) => {
    servidor.close();
    if (codigo !== 0 || !bruto.includes('---JSON---')) {
      console.error(`\n🔴 o Chromium não completou a medição (código ${codigo}).`);
      process.exit(1);
    }
    conferir(JSON.parse(bruto.slice(bruto.indexOf('---JSON---') + 10).trim()));
  });
});

function conferir(medido) {

  for (const [caso, m] of Object.entries(medido)) {
    const celular = caso.startsWith('celular');
    const comprida = caso.endsWith('comprida');
    console.log(`\n${caso}  (position: ${m.position}, topo ${m.topo}, vista ${m.vistaTopo}..${m.vistaBase})`);
    ok(m.hidden === false, 'a pergunta está mostrada (hidden = false)');
    // R1 — a asserção que reprova o código de 22/09. Lá, neste caso, o topo dava -7671.
    ok(m.naVista, `R1 está DENTRO da vista da conversa (topo ${m.topo})`);
    // R2 — "está na vista" não basta: um bloco de 1px na borda passaria em R1. Quem responde
    // no centro tem que ser ELA, senão o que o usuário vê continua sendo a conversa.
    ok(m.noCentro === 'pergunta', `R2 é ela quem responde no centro da vista (achado: ${m.noCentro})`);
    ok(m.enterNaVista, 'R3 o botão Enter do menu está dentro da viewport');
    // R4 — a herança do 22/09: foi por cobrir a caixa que o `fixed` caiu. Um conserto que a
    // cubra de novo troca um defeito por outro.
    ok(m.naCaixa === 'textarea', `R4 a caixa de escrita continua alcançável (achado: ${m.naCaixa})`);
    // R5 — o pedido do dono (23/09): ele tirou o `fixed` porque QUER rolar. Só faz sentido
    // perguntar onde há rolagem; na conversa curta não há para onde subir.
    if (celular && comprida) {
      ok(m.conversaAoSubir !== 'pergunta' && m.conversaAoSubir !== 'nada',
        `R5 rolando para cima a conversa reaparece (achado: ${m.conversaAoSubir})`);
    }
  }

  console.log(`\nPNGs: ${SAIDA}`);
  console.log(falhas ? `\n🔴 ${falhas} de ${feitos} reprovaram.` : `\n🟢 ${feitos} asserções passaram.`);
  process.exit(falhas ? 1 : 0);
}
