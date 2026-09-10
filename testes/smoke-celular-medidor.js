#!/usr/bin/env node
'use strict';
// SMOKE DE NAVEGADOR — celular, o medidor de sessão de graça (card `medidor-de-sessao-de-graca`).
//
// Prova de tela em 390×844 de que o consumo do plano aparece SEM custar turno: as barras do
// `rate_limit_event` no diálogo "Consumo do plano" e o número na linha do painel de
// Configuração. O wrapper `smoke-navegador-externo` trava em 1600×1000; o card é de CELULAR,
// então o roteiro é próprio (regra do usuário de 25/08: prova no aparelho que motivou a mudança).
//
// MODO=antes|depois é OBRIGATÓRIO.
//   `antes`  → roda contra um servidor do `develop`. Lá abrir o diálogo CUSTA um turno de
//              haiku (server.js chama consultar(false) e o cache está frio) e não existe
//              `#uso-plano-janelas`. É o par que mostra a mudança de ORIGEM e de CUSTO.
//   `depois` → roda contra esta branch. Zero turno, `janelas` preenchido.
//
// BASE é OBRIGATÓRIO: este script NÃO sobe servidor. Quem sobe é quem chama, com a porta do
// momento — sem isso o antes/depois não é reproduzível. Padrão de
// `testes/smoke-navegador-codex.sh:29`.
//
// 🔴 A resposta comparada é a que a TELA recebeu (`window.__limites`, capturada por um hook
// no `fetch` instalado ANTES do goto), nunca uma consulta paralela deste script: abrir a
// Configuração e depois o Consumo dispara DUAS chamadas, e entre uma consulta própria e o que
// o DOM desenhou o cache pode expirar ou uma janela resetar — DOM certo, smoke vermelho.
//
// Molde: `testes/smoke-celular-primeira-leva.js` (docker run --network host, PNGs em /out,
// saída 0/1/2). O `--network host` é o que deixa o Chromium do container alcançar o
// `127.0.0.1:<porta>` do host — sem ele dá ERR_CONNECTION_REFUSED.
//
// Códigos de saída: 0 = passou · 1 = falha de produto/assert · 2 = erro de USO ou de AMBIENTE.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

// ─── Contrato de uso — validado ANTES de tocar em qualquer coisa ─────────────

const MODO = process.env.MODO;
if (MODO !== 'antes' && MODO !== 'depois') {
  console.error('🔴 defina MODO=antes ou MODO=depois');
  process.exit(2);
}
const BASE = process.env.BASE;
if (!BASE) {
  console.error('🔴 defina BASE=http://127.0.0.1:<porta> — este script não sobe servidor');
  process.exit(2);
}
const SAIDA = process.env.SAIDA;
if (!SAIDA) {
  console.error('🔴 defina SAIDA=<pasta onde os PNGs caem>');
  process.exit(2);
}
const IMAGEM = process.env.IMAGEM || 'cockpit-smoke:latest';

try {
  execFileSync('docker', ['image', 'inspect', IMAGEM], { stdio: 'ignore' });
} catch {
  console.error(`🟡 ambiente indisponível: a imagem docker ${IMAGEM} não existe nesta máquina.`);
  process.exit(2);
}

fs.mkdirSync(SAIDA, { recursive: true });

// ─── O roteiro que roda DENTRO do container ──────────────────────────────────

function montarRoteiro() {
  return `
const puppeteer = require('/app/node_modules/puppeteer-core');

const BASE = process.env.BASE;
const MODO = process.env.MODO;
const VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const falhas = [];
const feitos = [];
const ok = (cond, msg) => { (cond ? feitos : falhas).push(msg); return cond; };
// 🔴 O obturador é PRIVILÉGIO de quem já passou nos asserts. \`ok()\` sozinho é mole: ele
// acumula a falha e o roteiro segue até fotografar assim mesmo — e um PNG de estado reprovado
// no disco, com o nome de sempre, é pior que PNG nenhum (alguém abre e acredita). \`exigir()\`
// estoura ANTES da foto. Achado do painel de execução.
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

    // ANTES do goto: evaluateOnNewDocument so alcanca documentos que ainda vao nascer.
    // Instalado depois da navegacao, window.__limites ficaria vazio para sempre.
    await pagina.evaluateOnNewDocument(() => {
      window.__limites = [];
      const orig = window.fetch;
      window.fetch = async (...a) => {
        const r = await orig(...a);
        try {
          if (String(a[0]).includes('api/limite')) window.__limites.push(await r.clone().json());
        } catch { /* resposta nao-JSON: nao e a nossa */ }
        return r;
      };
    });

    const erros = [];
    pagina.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
    pagina.on('pageerror', (e) => erros.push('pageerror: ' + e.message));

    await pagina.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });

    // ── PNG 1 — a linha do painel de Configuração ────────────────────────────
    await pagina.evaluate(() => document.getElementById('btn-config')?.click());
    await new Promise((r) => setTimeout(r, 2500));

    const linha = await pagina.evaluate(() => ({
      valor: (document.getElementById('plano-valor')?.textContent || '').trim(),
      temContainerNovo: Boolean(document.getElementById('uso-plano-janelas')),
      resposta: (window.__limites || []).at(-1) || null,
    }));

    if (MODO === 'antes') {
      // No develop abrir a Configuracao NAO consulta nada (era o assert A6), entao a linha
      // fica vazia. Fotografar isso É o ponto: é o defeito que a entrega conserta.
      exigir(!linha.temContainerNovo, 'antes: #uso-plano-janelas NÃO existe (é mesmo o develop)');
      ok(linha.valor === '', \`antes: #plano-valor vazio — o defeito (valor="\${linha.valor}")\`);
    } else {
      exigir(linha.temContainerNovo, 'depois: #uso-plano-janelas existe');
      const r = linha.resposta;
      exigir(r !== null, 'depois: a Configuração consultou /api/limite (de graça)');
      exigir(r && r.janelas !== null && r.janelas !== undefined,
        'depois: a resposta trouxe janelas — sem isso não há o que fotografar');
      // Condicional ao DADO: sem Sessao (5h) a linha fica vazia DE PROPOSITO (a janela
      // pode ter acabado de resetar e ser descartada). Assert seco reprovaria o produto certo.
      const temSessao = Boolean(r && r.janelas && (r.janelas.itens || []).some((i) => i.rotulo === 'Sessão (5h)'));
      if (temSessao) {
        ok(/\\d+%/.test(linha.valor), \`depois: #plano-valor com % (valor="\${linha.valor}")\`);
        ok(/~|agora/.test(linha.valor), \`depois: e com a IDADE do número (valor="\${linha.valor}")\`);
      } else {
        ok(linha.valor === '', 'depois: sem Sessão(5h) no dado, a linha fica vazia (correto)');
      }
    }

    // Só agora, com as guardas passadas, a foto vale como prova.
    await pagina.screenshot({ path: '/out/' + MODO + '-1-config.png' });

    // ── PNG 2 — o diálogo "Consumo do plano" ─────────────────────────────────
    await pagina.evaluate(() => document.getElementById('btn-plano')?.click());
    // 25 s: no MODO=antes o servidor roda claude -p /usage, que e um turno de verdade.
    await new Promise((r) => setTimeout(r, MODO === 'antes' ? 25000 : 3000));

    const tela = await pagina.evaluate(() => {
      const janelas = document.getElementById('uso-plano-janelas');
      const lista = document.getElementById('uso-plano-lista');
      const filhos = Array.from(lista ? lista.children : []);
      const iCodex = filhos.findIndex((n) => n.dataset && n.dataset.consumo === 'codex');
      return {
        resposta: (window.__limites || []).at(-1) || null,
        nasJanelas: janelas ? janelas.querySelectorAll('.plano-item').length : 0,
        naLista: lista ? lista.querySelectorAll('.plano-item').length : 0,
        // Barras da ANTHROPIC dentro da lista = as que vem ANTES do cabecalho do Codex.
        anthropicNaLista: (iCodex < 0 ? filhos : filhos.slice(0, iCodex))
          .filter((n) => n.classList.contains('plano-item')).length,
        notaCusto: (lista?.querySelector('[data-consumo="custo"]')?.textContent || '').trim(),
        notaJanelas: janelas ? Array.from(janelas.querySelectorAll('.plano-nota')).map((n) => n.textContent.trim()) : [],
        cabecalhos: Array.from(document.querySelectorAll('#uso-plano-janelas .plano-nota, #uso-plano-lista .plano-nota'))
          .map((n) => n.textContent.trim()),
      };
    });

    if (MODO === 'antes') {
      // NAO basta .plano-item >= 1: desenharConsumoDoCodex escreve na MESMA lista, entao
      // um >= 1 aprovaria uma foto com ZERO barra da Anthropic — que não prova nada.
      const r = tela.resposta;
      exigir(r && (r.itens || []).length > 0,
        \`antes: o /usage respondeu (\${(r && r.itens || []).length} janelas) — custou um turno\`);
      exigir(tela.anthropicNaLista >= 1,
        \`antes: \${tela.anthropicNaLista} barra(s) da Anthropic na lista, pagas pelo /usage\`);
    } else {
      const r = tela.resposta;
      exigir(r && r.janelas && (r.janelas.itens || []).length > 0,
        'depois: a resposta que a TELA recebeu tem janelas de graça');
      exigir(tela.nasJanelas >= 1, \`depois: \${tela.nasJanelas} barra(s) em #uso-plano-janelas\`);
      // A contagem é DERIVADA da resposta que a tela desenhou, nunca um número fixo.
      const esperado = (r?.janelas?.itens?.length || 0) + (r?.itens?.length || 0)
        + (r?.codex?.limites?.length || 0);
      exigir(tela.nasJanelas + tela.naLista === esperado,
        \`depois: DOM desenhou tudo que recebeu (\${tela.nasJanelas}+\${tela.naLista} = \${esperado})\`);
      exigir(tela.notaJanelas.some((t) => /~há|medido agora/.test(t) && /não custa turno/.test(t)),
        \`depois: a nota diz de quando é e que não custa turno (\${JSON.stringify(tela.notaJanelas)})\`);
      exigir(/turno/.test(tela.notaCusto),
        \`depois: o aviso de que atualizar custa um turno está na tela ("\${tela.notaCusto}")\`);
      exigir(tela.cabecalhos.filter((t) => /^Claude/.test(t)).length === 1,
        'depois: exatamente 1 cabeçalho "Claude"');
    }

    // Erro de console também é guarda: tela com JS quebrado não é prova de nada.
    exigir(erros.length === 0, \`sem erro de console (\${erros.slice(0, 3).join(' | ') || 'nenhum'})\`);

    // Todas as guardas passaram: agora a foto vale.
    await pagina.screenshot({ path: '/out/' + MODO + '-2-plano.png' });

    console.log('@@MEDIDAS@@' + JSON.stringify({ feitos, falhas, tela, linha }, null, 2));
  } finally {
    await navegador.close();
  }
})().catch((e) => { console.error('🔴 roteiro estourou:', e.message); process.exit(1); });
`;
}

// ─── Rodar ───────────────────────────────────────────────────────────────────

(async () => {
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'smoke-medidor-'));
  fs.writeFileSync(path.join(scratch, 'roteiro.js'), montarRoteiro());

  console.log(`· MODO=${MODO} · BASE=${BASE} · SAIDA=${SAIDA}`);

  const docker = spawn('docker', [
    'run', '--rm', '--network', 'host', '--entrypoint', 'node',
    '-e', `BASE=${BASE}`,
    '-e', `MODO=${MODO}`,
    '-v', `${scratch}:/w:ro`,
    '-v', `${SAIDA}:/out`,
    IMAGEM, '/w/roteiro.js',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let saida = '';
  docker.stdout.on('data', (d) => { saida += d; });
  docker.stderr.on('data', (d) => { saida += d; });
  const codigo = await new Promise((r) => docker.on('close', r));

  const marcador = saida.indexOf('@@MEDIDAS@@');
  const cabecalho = marcador >= 0 ? saida.slice(0, marcador) : saida;
  if (cabecalho.trim()) console.log(cabecalho.trim());

  let relatorio = null;
  if (marcador >= 0) {
    try { relatorio = JSON.parse(saida.slice(marcador + '@@MEDIDAS@@'.length)); } catch { /* fica null */ }
  }
  if (!relatorio) {
    console.error(`🔴 o roteiro não devolveu medidas (docker saiu com ${codigo})`);
    process.exit(codigo === 0 ? 1 : 2);
  }

  for (const f of relatorio.feitos) console.log(`  ✅ ${f}`);
  for (const f of relatorio.falhas) console.error(`  ❌ ${f}`);

  if (relatorio.falhas.length) {
    console.error(`\n🔴 ${relatorio.falhas.length} assert(s) reprovaram — NENHUM PNG vale como prova.`);
    process.exit(1);
  }
  console.log(`\n✅ ${relatorio.feitos.length} asserts, todos antes do obturador. PNGs em ${SAIDA}`);
})();
