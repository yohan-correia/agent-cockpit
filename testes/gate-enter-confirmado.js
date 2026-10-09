'use strict';
// GATE do Enter CONFIRMADO — o envio só termina quando a caixa do terminal esvazia.
//
// ── O defeito que este gate existe para impedir ────────────────────────────────────────
//
// Medido na pane REAL do dono em 2026-09-23, 04:03 UTC (`main:@187.%191`, projeto
// midia-exemplo). O cockpit colou a mensagem, mandou `Enter` 150 ms depois e devolveu
// "enviado". A pane mostrava:
//
//     ✻ Baked for 40s · done 4:03
//     ────────────────────────────────────────────────
//     ❯ [Image #5][anexo]
//       Os arquivos acima foram enviados pelo usuário junto desta mensagem…
//       Ai está a prova
//     ────────────────────────────────────────────────
//
// Texto no COMPOSER, CLI em `idle`, agente parado. Um único `send-keys Enter` mandado à
// mão esvaziou a caixa e o turno começou na hora — ou seja, o texto chegou e o Enter NÃO.
//
// POR QUE com anexo, e por que INTERMITENTE: a mensagem com anexo carrega o caminho do
// arquivo, e a TUI para para LER e CODIFICAR a imagem em base64 antes de aceitar tecla. O
// CLI tem cache (`~/.claude/image-cache`): imagem repetida volta rápida, imagem nova paga o
// custo inteiro. Nos 150 ms fixos de `digitarNaAba` a TUI ainda está mastigando, e o Enter
// cai no vazio. É CORRIDA, não regra — quatro tentativas em laboratório passaram porque
// reusavam a MESMA imagem (cache quente) e só a pane real, com arquivo novo, reprovou.
//
// Por isso o conserto NÃO é aumentar a espera: o tamanho do arquivo do dia muda a corrida
// de lugar. É CONFERIR — o Enter vira "mandar até a caixa esvaziar", com teto.
//
// ── Molde ──────────────────────────────────────────────────────────────────────────────
// Mesmo de `testes/gate-gesto-escape.js`: fatia `digitarNaAba` do fonte e roda em
// `vm.runInNewContext` com as fronteiras dubladas. `composerTemTexto` é dublado POR CASO —
// a implementação real (que lê a pane) tem gate próprio em `gate-composer.js`.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const fonte = fs.readFileSync(path.join(__dirname, '../lib/abas.js'), 'utf8');
const inicio = fonte.indexOf('async function digitarNaAba(');
const codigo = fonte.slice(inicio, fonte.indexOf('\n}\n', inicio) + 2);

// Os valores REAIS, do módulo — nunca retipados aqui: retipar faria o gate concordar
// consigo mesmo enquanto `lib/abas.js` mudava o número por baixo (a #40). Mesmo padrão que
// `gate-gesto-escape.js` usa para `RECUSA_PERGUNTA`.
const { TENTATIVAS_DE_ENTER, ESPERA_CONFIRMACAO } = require('../lib/abas');

const abaBase = (extra) => ({
  chave: 'aba-e1', agente: 'claude', pane: '%77', alvo: '@77', titulo: 'teste',
  panePid: 10, agentePid: 11, esperando: false, preSessao: false, ...extra,
});

/**
 * @param composerSequencia uma resposta por chamada de `composerTemTexto`, na ordem
 *        (`true` = ainda tem texto na caixa · `false` = esvaziou · `null` = não sei ler).
 *        A última repete se a lista acabar.
 */
async function rodar({ aba, texto = 'oi', composerSequencia = [false], anexos = [] }) {
  const chamadas = [];
  let indice = 0;
  let chamouComposer = 0;
  const contexto = {
    path, PASTA_ANEXOS: '/tmp', limpar: (x) => x,
    fsSync: { existsSync: () => true },
    buscar: async () => aba,
    motivoDeRecusa: () => null,
    mesmaIdentidade: async () => null,
    estadoDoMenu: async () => 'livre',
    RECUSA_PERGUNTA: 'recusa',
    ESPERA_REPINTAR: 250,
    TENTATIVAS_DE_ENTER,
    ESPERA_CONFIRMACAO,
    espera: async () => {},
    registrarPendente: (chave, dados) => dados,
    esquecerPendente: () => {},
    tmux: async (args) => { chamadas.push(args); },
    tmuxDoStatus: async (args) => { chamadas.push(args); return ''; },
    autorizarEscrita: async () => null,
    detectarAgente: async () => ({ agente: aba.agente, pid: aba.agentePid }),
    composerTemTexto: async () => {
      chamouComposer += 1;
      const v = composerSequencia[indice] ?? composerSequencia.at(-1);
      indice += 1;
      return v;
    },
  };
  vm.runInNewContext(codigo, contexto);
  let rejeitou = null;
  try { await contexto.digitarNaAba(aba.chave, texto, anexos); } catch (e) { rejeitou = e; }
  return { rejeitou, chamadas, chamouComposer };
}

const teclas = (chamadas) => chamadas.map((a) => a.at(-1));
const quantosEnter = (chamadas) => teclas(chamadas).filter((t) => t === 'Enter').length;

(async () => {
  console.log('\n── Gate do Enter confirmado (a caixa do terminal esvaziou?) ──');
  let tudoOk = true;
  const ok = (cond, msg) => {
    if (cond) console.log(`  ✅ ${msg}`);
    else { console.log(`  ❌ ${msg}`); tudoOk = false; }
    return cond;
  };

  // G1 — o caminho feliz não muda de forma: um Enter só quando a caixa esvazia de primeira.
  {
    const r = await rodar({ aba: abaBase(), composerSequencia: [false] });
    ok(!r.rejeitou, 'G1: envio normal não rejeita');
    ok(quantosEnter(r.chamadas) === 1,
      `G1: caixa vazia na 1ª conferência ⇒ UM Enter só (achei ${quantosEnter(r.chamadas)})`);
    ok(r.chamouComposer === 1,
      `G1: confere uma vez e para (achei ${r.chamouComposer} conferências)`);
  }

  // G2 — O DEFEITO DA PANE REAL: o Enter se perdeu, a caixa continua cheia. Tem que
  // REINSISTIR. É esta asserção que fica vermelha no código de 23/09 antes do conserto.
  {
    const r = await rodar({ aba: abaBase(), composerSequencia: [true, false] });
    ok(!r.rejeitou, 'G2: Enter perdido não vira erro — o texto está lá, é só reinsistir');
    ok(quantosEnter(r.chamadas) === 2,
      `G2: caixa cheia na 1ª conferência ⇒ SEGUNDO Enter (achei ${quantosEnter(r.chamadas)})`);
  }

  // G3 — o teto existe: caixa que NUNCA esvazia não vira Enter infinito.
  {
    const r = await rodar({ aba: abaBase(), composerSequencia: [true] });
    const n = quantosEnter(r.chamadas);
    ok(n >= 2, `G3: insiste mais de uma vez (achei ${n})`);
    ok(n <= 4, `G3: e PARA — teto de tentativas, não laço infinito (achei ${n})`);
  }

  // G4 — não sei ler a tela ⇒ degrada para o comportamento de hoje, nunca martela às cegas.
  {
    const r = await rodar({ aba: abaBase(), composerSequencia: [null] });
    ok(quantosEnter(r.chamadas) === 1,
      `G4: leitura inconclusiva ⇒ UM Enter, como hoje (achei ${quantosEnter(r.chamadas)})`);
  }

  // G5 — a conferência é DEPOIS do Enter, nunca antes: conferir antes leria a caixa cheia
  // do texto que acabamos de colar e mandaria Enter duplicado em todo envio.
  {
    const r = await rodar({ aba: abaBase(), composerSequencia: [false] });
    const ordem = teclas(r.chamadas);
    const primeiroEnter = ordem.indexOf('Enter');
    const colagem = ordem.findIndex((t) => typeof t === 'string' && t.includes('\x1b[200~'));
    ok(colagem >= 0 && primeiroEnter > colagem, 'G5: cola primeiro, Enter depois');
  }

  // G6 — com ANEXO (o caso medido) o caminho é o MESMO: o cabeçalho do anexo não pula a
  // conferência. Sem esta, um `if (!anexos.length) return` passaria despercebido.
  {
    const r = await rodar({
      aba: abaBase(), anexos: ['/tmp/foto.jpg'], composerSequencia: [true, false],
    });
    ok(quantosEnter(r.chamadas) === 2,
      `G6: com anexo, reinsiste igual (achei ${quantosEnter(r.chamadas)})`);
  }

  // ── A RÉGUA DE LEITURA, agora de verdade ─────────────────────────────────────────────
  // Acima `composerTemTexto` é dublada. Aqui roda a implementação REAL contra telas
  // capturadas no formato que a TUI desenha — senão o conserto inteiro se apoia numa
  // função que ninguém nunca leu.
  console.log('\n── A régua: a caixa do terminal tem texto? ──');
  {
    const inicioC = fonte.indexOf('async function composerTemTexto(');
    assert.ok(inicioC > 0, 'composerTemTexto tem que existir em lib/abas.js');
    const codigoC = fonte.slice(inicioC, fonte.indexOf('\n}\n', inicioC) + 2);

    const lerCom = async (tela, aba = { agente: 'claude', pane: '%1' }) => {
      const ctx = { tmux: async () => tela };
      vm.runInNewContext(codigoC, ctx);
      return ctx.composerTemTexto(aba);
    };

    const BARRA = '─'.repeat(40);
    // O retrato exato da pane travada (midia-exemplo, 04:03 UTC de 23/09).
    const travada = [
      '✻ Baked for 40s · done 4:03', BARRA,
      '❯ [Image #5][anexo]',
      '  Os arquivos acima foram enviados pelo usuário junto desta mensagem.',
      '  Ai está a prova', BARRA,
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n');
    ok(await lerCom(travada) === true, 'R1: a pane travada de 23/09 lê como CHEIA');

    const livre = ['● pronto', BARRA, '❯ ', BARRA, '  ⏵⏵ auto mode on'].join('\n');
    ok(await lerCom(livre) === false, 'R2: composer vazio lê como VAZIA');

    // A fala JÁ ENVIADA usa o mesmo `❯`. Vence a ÚLTIMA — sem isso, toda aba com histórico
    // seria lida como cheia e levaria Enter sobrando em todo envio.
    const comHistorico = [
      '❯ mandei os dois pelo taildrop', '● beleza', BARRA, '❯ ', BARRA,
    ].join('\n');
    ok(await lerCom(comHistorico) === false,
      'R3: fala antiga no histórico não conta — vale o ÚLTIMO prompt');

    ok(await lerCom(travada, { agente: 'codex', pane: '%1' }) === null,
      'R4: Codex devolve "não sei" — régua dele é outra, e analogia aqui seria chute');
    ok(await lerCom('') === null, 'R5: captura vazia (prazo estourado) ⇒ não sei');
    ok(await lerCom('sem prompt nenhum aqui') === null, 'R6: tela sem prompt ⇒ não sei');
  }

  console.log(tudoOk ? '\n✅ GATE VERDE — Enter confirmado\n' : '\n❌ GATE VERMELHO — Enter confirmado\n');
  process.exit(tudoOk ? 0 : 1);
})();
