#!/usr/bin/env bash
# SMOKE DE NAVEGADOR DA ABA DE CODEX — Chromium de verdade, com assert de DOM antes de cada
# foto.
#
# 🔴 Ele é um WRAPPER, não um script Node do repo, e a razão é dura: este projeto tem ZERO
# DEPENDÊNCIA por regra, então `require('puppeteer-core')` não resolve no `node` daqui. O
# puppeteer mora dentro de uma imagem de container que já existe nesta máquina, e é lá que o
# roteiro roda — montado num `.mjs` temporário, por caminho ABSOLUTO dentro do container.
#
# `--network host`, e não a rede do wrapper do servidor: o alvo é `127.0.0.1:7899` NO HOST, e
# nenhuma rede de container o alcança. É a diferença entre este smoke e o do Projeto-a.
#
# Por que ele existe ao lado do `smoke-navegador-externo`, e não no lugar dele: aquele wrapper
# visita caminhos e reprova por CSS em 404, imagem quebrada, erro de console e request >= 400
# — coisas que este roteiro não olha. E ele TRAVA em 1600x1000, sem aceitar `VIEWPORT=`, então
# o PNG de celular (390x844) que a regra de 25/08 exige sai daqui. São dois gates com alvos
# diferentes, não um substituindo o outro.
#
# ⚠️ Assert falhou ⇒ exit 1 e NENHUM PNG é apresentado como prova. Em 24/08 quatro smokes
# passaram verdes fotografando a tela de "escolha uma conversa" — o PNG provava que a página
# subiu, que é outra coisa.
#
# Variáveis:  BASE (obrigatória, ex.: http://127.0.0.1:7899) · SAIDA (onde os PNGs caem)
#             IMAGEM (padrão: cockpit-smoke:latest)
#             ENTRADA_FASE7=0 pula o PNG 05 (o diálogo do campo Agente)

set -euo pipefail

BASE="${BASE:?defina BASE, ex.: BASE=http://127.0.0.1:7899}"
SAIDA="${SAIDA:-$PWD/.smoke-codex-shots}"
IMAGEM="${IMAGEM:-cockpit-smoke:latest}"
ENTRADA_FASE7="${ENTRADA_FASE7:-1}"

mkdir -p "$SAIDA"

docker image inspect "$IMAGEM" >/dev/null 2>&1 || {
  echo "ERRO: imagem '$IMAGEM' não existe nesta máquina. Buildar antes, ou passar IMAGEM=..." >&2
  exit 2
}

SCRIPT=$(mktemp /tmp/smoke-codex-XXXXXX.mjs)
trap 'rm -f "$SCRIPT"' EXIT

cat > "$SCRIPT" <<'JSEOF'
// O import é por CAMINHO ABSOLUTO dentro do container: por nome, o resolver do Node
// procuraria em `node_modules` relativo ao `.mjs`, que está em `/`.
import puppeteer from '/app/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const BASE = process.env.BASE;
const COM_DIALOGO = process.env.ENTRADA_FASE7 === '1';
const problemas = [];
const feitos = [];

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const navegador = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

/** Um roteiro: rota → ação → ASSERT de DOM → foto. O olho do humano vem depois do assert. */
async function roteiro(nome, { viewport = { width: 1280, height: 900 }, acao, assert }) {
  const pagina = await navegador.newPage();
  try {
    await pagina.setViewport(viewport);
    // 🔴 ANTES do goto, sempre: `evaluateOnNewDocument` só alcança documentos que ainda vão
    // NASCER — instalado depois da navegação, `window.__limites` fica vazio para sempre. Ele
    // guarda a resposta que a TELA recebeu, que é contra o que o assert 07 compara o DOM.
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
    await pagina.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
    await espera(1500);
    if (acao) await acao(pagina);
    await espera(1200);
    const veredito = await pagina.evaluate(assert);
    if (!veredito.ok) {
      problemas.push(`${nome}: ${veredito.porque}`);
      return;
    }
    await pagina.screenshot({ path: `/saida/${nome}.png`, fullPage: false });
    feitos.push(`${nome} — ${veredito.porque}`);
  } catch (e) {
    problemas.push(`${nome}: o roteiro estourou — ${String(e && e.message).slice(0, 200)}`);
  } finally {
    await pagina.close().catch(() => {});
  }
}

/** Clica na primeira linha da lista de abas cujo texto casa. */
const abrirALinha = (casa) => async (pagina) => {
  await pagina.evaluate((padrao) => {
    const linhas = Array.from(document.querySelectorAll('#abas .conversa'));
    const alvo = linhas.find((b) => new RegExp(padrao).test(b.textContent)) || linhas[0];
    if (alvo) alvo.click();
  }, casa);
  await espera(2500);
};

// 01 — a aba de Codex existe na lista, com o CHIP que a distingue. O chip é o assert que
// impede este PNG de voltar a provar só que a página subiu.
await roteiro('01-lista-com-codex', {
  assert: () => {
    const chips = Array.from(document.querySelectorAll('#abas .conversa-agente'));
    const doCodex = chips.filter((c) => c.textContent.trim() === 'codex');
    if (!doCodex.length) return { ok: false, porque: `nenhum chip "codex" na lista (${chips.length} chips)` };
    const linha = doCodex[0].closest('.conversa-linha');
    const titulo = linha ? linha.textContent.replace(/\s+/g, ' ').trim() : '';
    if (!titulo) return { ok: false, porque: 'o chip existe mas a linha não tem texto legível' };
    return { ok: true, porque: `a aba de Codex está na lista, com chip: "${titulo.slice(0, 60)}"` };
  },
});

// 02 — a fita tem BOLHAS COM TEXTO, não uma moldura vazia.
await roteiro('02-fita-codex', {
  acao: abrirALinha('codex'),
  assert: () => {
    const linhaAtual = document.querySelector('#abas .conversa[aria-current="true"]');
    if (!linhaAtual) return { ok: false, porque: 'nenhuma linha ficou com aria-current=true' };
    const bolhas = Array.from(document.querySelectorAll('#fita .bolha, #fita [class*="bolha"]'))
      .filter((b) => b.textContent.trim().length > 0);
    if (bolhas.length < 2) return { ok: false, porque: `só ${bolhas.length} bolha(s) com texto na fita` };
    return { ok: true, porque: `${bolhas.length} bolhas com texto na fita da aba de Codex` };
  },
});

// 03 — o medidor mostra um número que faz sentido. `0%` ou `2026%` reprovam aqui, antes de
// alguém precisar olhar a figura.
await roteiro('03-medidor-codex', {
  acao: abrirALinha('codex'),
  assert: () => {
    const medidor = document.getElementById('medidor');
    if (!medidor || medidor.hidden) return { ok: false, porque: 'o #medidor não está visível' };
    const texto = (document.getElementById('medidor-pct') || {}).textContent || '';
    const n = parseFloat(String(texto).replace('%', '').replace(',', '.'));
    if (!Number.isFinite(n)) return { ok: false, porque: `o medidor não mostra número (${JSON.stringify(texto)})` };
    if (n < 0 || n > 100) return { ok: false, porque: `porcentagem fora de 0..100: ${n}%` };
    return { ok: true, porque: `medidor em ${n}% — dentro de 0..100` };
  },
});

// 04 — o aviso PERMANENTE de menu saiu em 10/09; o print agora prova a AUSÊNCIA dele. Ele
// ocupava quatro linhas do topo de toda aba de Codex por um risco que só existe às vezes, e
// quem resolve o risco de verdade é o card `menu-da-tui-do-codex-na-tela`. Este caso continua
// existindo porque a prova de que sumiu vale tanto quanto a de que estava lá — foi um merge
// distraído (`--ours` em a7a231c) que o trouxe de volta da primeira vez.
await roteiro('04-sem-aviso-de-menu', {
  acao: abrirALinha('codex'),
  assert: () => {
    // No CABEÇALHO, não na fita: a bolha seria apagada pelo `limparFita()` do `sessao`.
    const aviso = document.getElementById('aviso-agente');
    const texto = (aviso && !aviso.hidden ? aviso.textContent : '') || '';
    if (/não enxerga menu aberto/.test(texto)) {
      return { ok: false, porque: `o aviso permanente VOLTOU: ${JSON.stringify(texto.slice(0, 90))}` };
    }
    return { ok: true, porque: texto.trim()
      ? `sem o aviso de menu; o cabeçalho mostra só: "${texto.replace(/\s+/g, ' ').trim().slice(0, 90)}"`
      : 'o cabeçalho da aba de Codex está limpo — nenhum aviso permanente' };
  },
});

// 05 — o campo `Agente` ao lado do Projeto.
if (COM_DIALOGO) {
  await roteiro('05-dialogo-agente', {
    acao: async (pagina) => {
      await pagina.evaluate(() => document.getElementById('btn-nova-aba')?.click());
      await espera(1500);
    },
    assert: () => {
      const dialogo = document.getElementById('dialogo-nova-aba');
      if (!dialogo || !dialogo.open) return { ok: false, porque: 'o #dialogo-nova-aba não está aberto' };
      const projeto = document.getElementById('sel-projeto-novo');
      const agente = document.getElementById('sel-agente-novo');
      if (!projeto) return { ok: false, porque: 'falta o #sel-projeto-novo' };
      if (!agente) return { ok: false, porque: 'falta o #sel-agente-novo' };
      const opcoes = agente.querySelectorAll('option').length;
      if (opcoes < 2) return { ok: false, porque: `o campo Agente tem ${opcoes} opção(ões), esperava 2` };
      return { ok: true, porque: `os dois campos no diálogo, e o Agente com ${opcoes} opções` };
    },
  });
}

// 06 — CELULAR. A regra de 25/08: prova no aparelho que motivou a mudança. O
// `smoke-navegador-externo` trava em 1600x1000, e é por isso que este PNG sai daqui.
await roteiro('06-celular-fita', {
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  acao: abrirALinha('codex'),
  assert: () => {
    const bolhas = Array.from(document.querySelectorAll('#fita .bolha, #fita [class*="bolha"]'))
      .filter((b) => b.textContent.trim().length > 0);
    if (bolhas.length < 2) return { ok: false, porque: `só ${bolhas.length} bolha(s) com texto em 390px` };
    // Vazar para a direita em 390 px é o defeito que só o celular mostra.
    const largura = document.documentElement.scrollWidth;
    if (largura > 400) return { ok: false, porque: `a página vaza para a direita: scrollWidth ${largura}px em 390px` };
    const medidor = document.getElementById('medidor');
    if (medidor && !medidor.hidden && medidor.scrollWidth > medidor.clientWidth + 2) {
      return { ok: false, porque: `o #medidor tem overflow horizontal (${medidor.scrollWidth} > ${medidor.clientWidth})` };
    }
    return { ok: true, porque: `${bolhas.length} bolhas cabem em 390px, sem vazar (scrollWidth ${largura}px)` };
  },
});

// 07 — os DOIS blocos de consumo na MESMA foto, com rótulos distintos. Assinaturas
// diferentes nunca viram uma lista só.
//
// 🔴 A contagem NÃO é um número fixo, e o motivo é concreto (D38, 08/09): desde que o painel
// deixou de chamar o `/usage` sozinho, as barras da Anthropic saem do `rate_limit_event` e vão
// para `#uso-plano-janelas` — `#uso-plano-lista` passou a receber SÓ o Codex, que legitimamente
// pode ter UMA janela (`lib/adaptador-codex.js:738`: "só um dos dois lados ⇒ lista de 1, que
// aqui é a verdade"). O antigo `barras < 2` sobre uma lista só ficaria vermelho sem bug nenhum.
//
// A expectativa vem da resposta que a TELA recebeu (`window.__limites`, capturado no `fetch`
// antes do `goto`), nunca de uma consulta própria daqui: abrir a Configuração e depois o
// Consumo dispara DUAS chamadas, e entre uma consulta paralela e o que o DOM desenhou o cache
// pode expirar ou uma janela resetar — DOM certo, smoke vermelho.
//
// É o caso em que a #44 autoriza somar containers: o que este roteiro prova é "o diálogo
// desenhou tudo que recebeu", e aí o número somado É exatamente a coisa que se quer provar.
await roteiro('07-consumo-codex', {
  acao: async (pagina) => {
    await pagina.evaluate(() => document.getElementById('btn-config')?.click());
    await espera(900);
    await pagina.evaluate(() => document.getElementById('btn-plano')?.click());
    // 20 s, e não 4: o Chromium precisa do tempo, e numa máquina ocupada o diálogo não monta
    // em quatro segundos. (Antes de 08/09 a espera existia por outra razão — o painel rodava
    // `claude -p /usage`, um turno de verdade. Hoje ele não roda mais; o número fica.)
    await espera(20000);
  },
  assert: () => {
    const lista = document.getElementById('uso-plano-lista');
    if (!lista) return { ok: false, porque: 'não achei o #uso-plano-lista' };
    const janelas = document.getElementById('uso-plano-janelas');
    const resposta = (window.__limites || []).at(-1);
    if (!resposta) return { ok: false, porque: 'a tela não recebeu /api/limite — sem expectativa, não há assert' };

    const notas = Array.from(lista.querySelectorAll('.plano-nota'))
      .concat(Array.from(janelas ? janelas.querySelectorAll('.plano-nota') : []));
    const doCodex = notas.filter((n) => /Codex/.test(n.textContent || ''));
    // 🔴 SEMPRE 1, nunca "0 se não vier Codex": este smoke inteiro é o do Codex — o roteiro 01
    // já exige a aba dele na lista. Um `? 1 : 0` deixaria uma regressão que APAGA o consumo do
    // Codex passar verde, que é o oposto do que o arquivo existe para pegar (achado do painel
    // de execução, reproduzido em memória).
    if (!(resposta.codex?.limites || []).length) {
      return { ok: false, porque: 'a resposta não trouxe consumo do Codex — sem ele este roteiro não prova nada' };
    }
    if (doCodex.length !== 1) {
      return { ok: false, porque: `o texto "Codex" aparece em ${doCodex.length} cabeçalho(s), esperava exatamente 1` };
    }

    const esperado = (resposta.janelas?.itens || []).length
      + (resposta.itens || []).length
      + (resposta.codex?.limites || []).length;
    const barras = lista.querySelectorAll('.plano-item').length
      + (janelas ? janelas.querySelectorAll('.plano-item').length : 0);
    if (barras !== esperado) {
      return { ok: false, porque: `${barras} barra(s) na tela para ${esperado} na resposta — o DOM não desenhou tudo que recebeu` };
    }
    if (!barras) return { ok: false, porque: 'a resposta não trouxe nenhuma janela — nada a fotografar' };
    return { ok: true, porque: `${barras} barras = as ${esperado} da resposta, com ${doCodex.length} cabeçalho(s) "Codex", numa foto só` };
  },
});

await navegador.close();

for (const f of feitos) console.log(`  ✅ ${f}`);
for (const p of problemas) console.error(`  ❌ ${p}`);
if (problemas.length) {
  console.error(`\n🔴 ${problemas.length} roteiro(s) reprovaram — NENHUM PNG vale como prova.`);
  process.exit(1);
}
console.log(`\n✅ ${feitos.length} roteiros, todos com assert de DOM ANTES do obturador.`);
JSEOF

printf '%s\n' "── smoke de navegador do Codex ──" >&2
printf 'base=%s  shots=%s  imagem=%s\n' "$BASE" "$SAIDA" "$IMAGEM" >&2

docker run --rm --entrypoint node --network host \
  -e BASE="$BASE" -e ENTRADA_FASE7="$ENTRADA_FASE7" \
  -v "$SCRIPT:/s.mjs:ro" -v "$SAIDA:/saida" \
  "$IMAGEM" /s.mjs
CODIGO=$?

if [ $CODIGO -eq 0 ]; then
  printf '\n✅ smoke de navegador do Codex: os roteiros passaram (PNGs em %s)\n' "$SAIDA" >&2
else
  printf '\n🔴 smoke de navegador do Codex: algum assert reprovou — os PNGs NÃO valem como prova\n' >&2
fi
exit $CODIGO
