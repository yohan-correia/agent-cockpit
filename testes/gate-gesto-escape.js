'use strict';
// GATE do gesto "sair do menu e falar" — Escape → reconfere → cola → Enter.
//
// Card `escrever-texto-na-pergunta-aberta`. Spec:
// docs/superpowers/specs/2026-09-21-escrever-texto-na-pergunta-aberta-design.md
// Plano: docs/superpowers/plans/2026-09-21-escrever-texto-na-pergunta-aberta-plano.md (Fase 3)
//
// Executa `digitarNaAba` de VERDADE, com as fronteiras dubladas — mesmo molde de
// `testes/gate-envio-skill-codex.js` (fatia o fonte + `vm.runInNewContext`). Não é o molde
// de `gate-envio-na-pane.js` (aquele é regex sobre o FONTE, não executa nada).
//
// `estadoDoMenu`/`mesmaIdentidade` são controláveis por caso (não a implementação real —
// essa já tem gate próprio, `gate-estado-do-menu.js`); `RECUSA_PERGUNTA` vem do módulo real,
// para o gate comparar contra ELA em vez de retipar a frase (duas cópias seriam a #40).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const abasReal = require('../lib/abas');
const { RECUSA_PERGUNTA } = abasReal;

const fonte = fs.readFileSync(path.join(__dirname, '../lib/abas.js'), 'utf8');
const inicio = fonte.indexOf('async function digitarNaAba(');
const codigo = fonte.slice(inicio, fonte.indexOf('\n}\n', inicio) + 2);

const abaBase = (extra) => ({
  chave: 'aba-p7', agente: 'codex', pane: '%42', alvo: '@42', titulo: 'teste',
  panePid: 10, agentePid: 11, esperando: false, preSessao: false, ...extra,
});

/**
 * Roda `digitarNaAba` fatiado, com as peças do gesto DUBLADAS e controláveis por chamada.
 * `estadoDoMenuSequencia`: uma resposta por chamada de `estadoDoMenu`, na ordem; a última
 * repete se a lista acabar.
 */
async function rodar({
  aba, texto = 'oi, tudo bem?', motivoDeRecusaResultado = null, mesmaIdentidadeResultado = null,
  mesmaIdentidadeSequencia = null, estadoDoMenuSequencia = [], composerSequencia = [null],
  autorizarEscritaResultado = null,
}) {
  const chamadas = [];
  let registrouPendente = 0;
  let esqueceu = 0;
  let indiceEstado = 0;
  let chamouEstadoDoMenu = 0;
  let indiceIdentidade = 0;
  let indiceComposer = 0;
  const contexto = {
    path, PASTA_ANEXOS: '/tmp', limpar: (x) => x,
    buscar: async () => aba,
    motivoDeRecusa: () => motivoDeRecusaResultado,
    mesmaIdentidade: async () => {
      if (!mesmaIdentidadeSequencia) return mesmaIdentidadeResultado;
      // Por ÍNDICE, nunca `??`: `null` aqui é resposta ("é o mesmo processo"), não "acabou a lista" —
      // com `??` o caso k rejeitava ANTES da leitura e não testava a corrida (painel de execução).
      const v = indiceIdentidade < mesmaIdentidadeSequencia.length
        ? mesmaIdentidadeSequencia[indiceIdentidade] : mesmaIdentidadeSequencia.at(-1);
      indiceIdentidade += 1;
      return v;
    },
    estadoDoMenu: async () => {
      chamouEstadoDoMenu += 1;
      const v = estadoDoMenuSequencia[indiceEstado] ?? estadoDoMenuSequencia.at(-1);
      indiceEstado += 1;
      return v;
    },
    RECUSA_PERGUNTA,
    ESPERA_REPINTAR: 250,
    // O Enter confirmado (23/09) roda DENTRO de `digitarNaAba`: sem estas três o fatiado
    // estoura `ReferenceError`. A caixa devolve `null` ("não sei ler") de propósito — este
    // gate é sobre o GESTO do Escape, e a conferência do Enter tem gate próprio.
    TENTATIVAS_DE_ENTER: abasReal.TENTATIVAS_DE_ENTER,
    ESPERA_CONFIRMACAO: abasReal.ESPERA_CONFIRMACAO,
    composerTemTexto: async () => {
      const v = composerSequencia[indiceComposer] ?? composerSequencia.at(-1);
      indiceComposer += 1;
      return v;
    },
    espera: async () => {},
    registrarPendente: (chave, dados) => { registrouPendente += 1; return dados; },
    esquecerPendente: () => { esqueceu += 1; },
    tmux: async (args) => { chamadas.push(args); },
    tmuxDoStatus: async (args) => { chamadas.push(args); return ''; },
    autorizarEscrita: async () => autorizarEscritaResultado,
    detectarAgente: async () => ({ agente: aba.agente, pid: aba.agentePid }),
  };
  vm.runInNewContext(codigo, contexto);
  let rejeitou = null;
  let resultado = null;
  try { resultado = await contexto.digitarNaAba(aba.chave, texto); } catch (e) { rejeitou = e; }
  return { rejeitou, chamadas, resultado, registrouPendente, chamouEstadoDoMenu, esqueceu };
}

const teclasEnviadas = (chamadas) => chamadas.map((a) => a.at(-1));
const todasNaPane = (chamadas, pane) => chamadas.every((a) => a[a.indexOf('-t') + 1] === pane);

(async () => {
  console.log('\n── Gate do gesto Escape → reconfere → cola → Enter ──');

  // ── Claude 'menu' → depois 'livre' ───────────────────────────────────────────────
  {
    const aba = abaBase({ agente: 'claude', esperando: true, pane: '%50' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['menu', 'livre'] });
    assert.equal(r.rejeitou, null, `Claude menu→livre não deveria rejeitar (${r.rejeitou && r.rejeitou.message})`);
    // Delimitado (Fase 4, card escrever-texto-na-pergunta-aberta): bracketed paste passou a
    // valer para o Claude também.
    assert.deepEqual(teclasEnviadas(r.chamadas), ['Escape', '\x1b[200~oi, tudo bem?\x1b[201~', 'Enter'],
      'Claude: send-keys na ordem Escape, texto (delimitado), Enter');
    assert.ok(todasNaPane(r.chamadas, '%50'), 'Claude: todos os send-keys miram a PANE (%50)');
    console.log('  ✅ Claude: menu → livre — Escape, texto, Enter, todos na pane');
  }

  // ── Codex 'menu' → depois 'livre' ────────────────────────────────────────────────
  {
    const aba = abaBase({ agente: 'codex', esperando: true, pane: '%51' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['menu', 'livre'] });
    assert.equal(r.rejeitou, null, `Codex menu→livre não deveria rejeitar (${r.rejeitou && r.rejeitou.message})`);
    assert.deepEqual(teclasEnviadas(r.chamadas), ['Escape', '\x1b[200~oi, tudo bem?\x1b[201~', 'Enter'],
      'Codex: send-keys na ordem Escape, texto (delimitado), Enter');
    assert.ok(todasNaPane(r.chamadas, '%51'), 'Codex: todos os send-keys miram a PANE (%51)');
    console.log('  ✅ Codex: menu → livre — Escape, texto, Enter, todos na pane');
  }

  // ── 'menu' → continua 'menu' (Escape engolido) ───────────────────────────────────
  {
    const aba = abaBase({ agente: 'codex', esperando: true });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['menu', 'menu'] });
    assert.ok(r.rejeitou, 'Escape engolido: rejeita');
    assert.match(r.rejeitou.message, /continua com um menu aberto/, 'a mensagem é a do passo 3');
    assert.equal(r.chamadas.length, 1, `só o Escape sai (achei ${r.chamadas.length})`);
    assert.equal(teclasEnviadas(r.chamadas)[0], 'Escape');
    assert.ok(!('colado' in r.rejeitou), "'colado' AUSENTE — nada foi colado ainda");
    assert.equal(r.registrouPendente, 0, 'nenhuma ficha pendente nasceu');
    console.log("  ✅ menu → continua menu: um send-keys só, erro sem 'colado', zero ficha");
  }

  // ── 'nao-sei' no passo 0 ─────────────────────────────────────────────────────────
  {
    const aba = abaBase({ agente: 'codex', esperando: true });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['nao-sei'] });
    assert.ok(r.rejeitou, 'nao-sei no passo 0: rejeita');
    assert.equal(r.rejeitou.message, RECUSA_PERGUNTA, 'a mensagem é RECUSA_PERGUNTA');
    assert.equal(r.chamadas.length, 0, `ZERO send-keys (achei ${r.chamadas.length})`);
    console.log("  ✅ 'nao-sei' no passo 0: zero send-keys, recusa com RECUSA_PERGUNTA");
  }

  // ── 'nao-sei' no passo 3 ─────────────────────────────────────────────────────────
  {
    const aba = abaBase({ agente: 'codex', esperando: true });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['menu', 'nao-sei'] });
    assert.ok(r.rejeitou, 'nao-sei no passo 3: rejeita');
    assert.equal(r.chamadas.length, 1, `um send-keys só (achei ${r.chamadas.length})`);
    console.log("  ✅ 'nao-sei' no passo 3: um send-keys só, recusa");
  }

  // ── 'livre' no passo 0, nos DOIS agentes: nenhum Escape ──────────────────────────
  for (const agente of ['claude', 'codex']) {
    const aba = abaBase({ agente, esperando: true });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['livre'] });
    assert.equal(r.rejeitou, null, `${agente} livre no passo 0 não deveria rejeitar`);
    assert.ok(!teclasEnviadas(r.chamadas).includes('Escape'), `${agente}: nenhum Escape saiu`);
    assert.equal(r.chamadas.length, 2, `${agente}: os DOIS send-keys de sempre (achei ${r.chamadas.length})`);
    console.log(`  ✅ ${agente}: 'livre' no passo 0 — nenhum Escape, envio segue como hoje`);
  }

  // ── preSessao: recusa em motivoDeRecusa, zero send-keys ──────────────────────────
  {
    const aba = abaBase({ agente: 'codex', esperando: true, preSessao: true });
    const r = await rodar({
      aba, motivoDeRecusaResultado: 'o agente desta aba está pedindo uma confirmação no terminal; responda pelas setas antes de escrever',
    });
    assert.ok(r.rejeitou, 'preSessao: rejeita');
    assert.equal(r.chamadas.length, 0, `preSessao: ZERO send-keys (achei ${r.chamadas.length})`);
    assert.equal(r.chamouEstadoDoMenu, 0, 'preSessao: o gesto nem chega a chamar estadoDoMenu');
    console.log('  ✅ preSessao: recusa em motivoDeRecusa, zero send-keys, gesto nem roda');
  }

  // ── Aba trocou de processo: recusa ANTES do Escape ───────────────────────────────
  {
    const aba = abaBase({ agente: 'codex', esperando: true });
    const r = await rodar({
      aba, mesmaIdentidadeResultado: 'a aba mudou de processo; confira o terminal antes de tentar novamente',
      estadoDoMenuSequencia: ['menu'],
    });
    assert.ok(r.rejeitou, 'trocou de processo: rejeita');
    assert.match(r.rejeitou.message, /mudou de processo/, 'a mensagem é de mesmaIdentidade');
    assert.equal(r.chamadas.length, 0, `ZERO send-keys — nenhum Escape saiu (achei ${r.chamadas.length})`);
    assert.equal(r.chamouEstadoDoMenu, 0, 'estadoDoMenu nem chega a ser chamado');
    console.log('  ✅ aba trocou de processo: recusa antes do Escape, zero send-keys');
  }

  // ── /compact com menu aberto (Codex): recusa por autorizarEscrita('texto'), zero Escape ──
  {
    const aba = abaBase({ agente: 'codex', esperando: true });
    const r = await rodar({
      aba, texto: '/compact',
      autorizarEscritaResultado: 'o terminal está com uma pergunta aberta; responda pelas setas antes de escrever',
    });
    assert.ok(r.rejeitou, '/compact com menu: rejeita');
    assert.equal(r.chamadas.length, 0, `/compact: ZERO send-keys (achei ${r.chamadas.length})`);
    assert.ok(!teclasEnviadas(r.chamadas).includes('Escape'), '/compact: nenhum Escape — o gesto não vale para comandos nativos (§4.5)');
    console.log("  ✅ /compact com menu aberto: recusa por autorizarEscrita('texto'), zero Escape");
  }

  // ── D85b/D85d (card mensagem-some-no-menu-do-auto-mode): Claude com esperando:false — o
  //    gesto roda mesmo sem pergunta vista, e nenhum Enter confirma um menu que abriu sozinho ──

  // a) menu → livre → livre: Esc, cola, Enter, e o retorno avisa que fechou um menu sozinho
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['menu', 'livre', 'livre'] });
    assert.equal(r.rejeitou, null, `menu→livre→livre não deveria rejeitar (${r.rejeitou && r.rejeitou.message})`);
    assert.deepEqual(teclasEnviadas(r.chamadas), ['Escape', '\x1b[200~oi, tudo bem?\x1b[201~', 'Enter'],
      'send-keys na ordem Escape, texto, Enter');
    assert.equal(r.resultado.menuFechado, true, 'o retorno avisa menuFechado: true');
    console.log('  ✅ Claude esperando:false — menu→livre→livre: Esc, cola, Enter, menuFechado: true');
  }

  // b) menu → menu: o Esc não fechou — recusa sem colar, sem ficha
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['menu', 'menu'] });
    assert.ok(r.rejeitou, 'menu→menu: rejeita');
    assert.match(r.rejeitou.message, /mandei Esc/, 'a mensagem é a do Esc que não fechou');
    assert.equal(r.registrouPendente, 0, 'nenhuma ficha pendente nasceu');
    assert.ok(!('colado' in r.rejeitou) || !r.rejeitou.colado, "'colado' AUSENTE/false — nada foi colado");
    assert.equal(r.chamadas.length, 1, `só o Escape sai (achei ${r.chamadas.length})`);
    console.log('  ✅ Claude esperando:false — menu→menu: só o Escape, recusa sem colar, zero ficha');
  }

  // c) menu → nao-sei: idem b) — depois do Esc, só 'livre' positivo libera
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['menu', 'nao-sei'] });
    assert.ok(r.rejeitou, 'menu→nao-sei: rejeita');
    assert.match(r.rejeitou.message, /mandei Esc/, 'a mensagem é a do Esc que não fechou');
    assert.equal(r.registrouPendente, 0, 'nenhuma ficha pendente nasceu');
    assert.ok(!('colado' in r.rejeitou) || !r.rejeitou.colado, "'colado' AUSENTE/false — nada foi colado");
    assert.equal(r.chamadas.length, 1, `só o Escape sai (achei ${r.chamadas.length})`);
    console.log('  ✅ Claude esperando:false — menu→nao-sei: só o Escape, recusa sem colar');
  }

  // d) nao-sei no passo 0, sem esperando: segue como hoje (D13) — sem Escape
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['nao-sei'] });
    assert.equal(r.rejeitou, null, `nao-sei sem esperando não deveria rejeitar (${r.rejeitou && r.rejeitou.message})`);
    assert.ok(!teclasEnviadas(r.chamadas).includes('Escape'), 'nenhum Escape saiu');
    assert.equal(r.chamadas.length, 2, `os dois send-keys de sempre (achei ${r.chamadas.length})`);
    assert.equal(r.resultado.menuFechado, undefined, 'sem Esc, sem menuFechado');
    console.log("  ✅ Claude esperando:false — 'nao-sei' no passo 0: segue como hoje, sem Escape");
  }

  // e) livre no passo 0: segue sem Escape, sem menuFechado
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['livre'] });
    assert.equal(r.rejeitou, null, `livre no passo 0 não deveria rejeitar (${r.rejeitou && r.rejeitou.message})`);
    assert.ok(!teclasEnviadas(r.chamadas).includes('Escape'), 'nenhum Escape saiu');
    assert.equal(r.resultado.menuFechado, undefined, 'sem menuFechado');
    console.log('  ✅ Claude esperando:false — livre no passo 0: segue sem Escape, sem menuFechado');
  }

  // f) menu antes do Enter, caixa vazia: a colagem foi descartada — erro SEM colado, ficha esquecida
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['livre', 'menu'], composerSequencia: [false] });
    assert.ok(r.rejeitou, 'menu antes do Enter, caixa vazia: rejeita');
    assert.equal(r.rejeitou.descartado, true, 'descartado === true');
    assert.ok(!r.rejeitou.colado, "'colado' NÃO veio — a flag é posta pelo catch, e descartado bloqueia");
    assert.ok(!teclasEnviadas(r.chamadas).includes('Enter'), 'nenhum Enter saiu');
    assert.equal(r.esqueceu, 1, 'a ficha foi esquecida');
    console.log('  ✅ Claude esperando:false — menu antes do Enter, caixa vazia: descartado, sem colado, sem Enter');
  }

  // g) menu antes do Enter, caixa com texto: o texto pode estar na TUI — colado: true
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['livre', 'menu'], composerSequencia: [true] });
    assert.ok(r.rejeitou, 'menu antes do Enter, caixa com texto: rejeita');
    assert.equal(r.rejeitou.colado, true, 'colado === true');
    assert.ok(!teclasEnviadas(r.chamadas).includes('Enter'), 'nenhum Enter saiu');
    console.log('  ✅ Claude esperando:false — menu antes do Enter, caixa com texto: colado, sem Enter');
  }

  // h) com Esc mandado, nao-sei antes do Enter também bloqueia (só 'livre' positivo libera)
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({
      aba, estadoDoMenuSequencia: ['menu', 'livre', 'nao-sei'], composerSequencia: [false],
    });
    assert.ok(r.rejeitou, 'com Esc mandado, nao-sei antes do Enter: rejeita');
    assert.ok(!teclasEnviadas(r.chamadas).includes('Enter'), 'nenhum Enter saiu');
    console.log('  ✅ Claude esperando:false — com Esc mandado, nao-sei antes do Enter: bloqueia');
  }

  // i) sem Esc, nao-sei antes do Enter segue (D13 outra vez, agora no 2º ponto)
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['livre', 'nao-sei'] });
    assert.equal(r.rejeitou, null, `sem Esc, nao-sei antes do Enter não deveria rejeitar (${r.rejeitou && r.rejeitou.message})`);
    assert.ok(teclasEnviadas(r.chamadas).includes('Enter'), 'o Enter saiu');
    console.log('  ✅ Claude esperando:false — sem Esc, nao-sei antes do Enter: segue, tem Enter');
  }

  // j) menu no reenvio: o 1º Enter já saiu — para, erro com colado, só UM Enter
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({
      aba, estadoDoMenuSequencia: ['livre', 'livre', 'menu'], composerSequencia: [true, true],
    });
    assert.ok(r.rejeitou, 'menu no reenvio: rejeita');
    assert.equal(r.rejeitou.colado, true, 'colado === true');
    const enters = teclasEnviadas(r.chamadas).filter((t) => t === 'Enter');
    assert.equal(enters.length, 1, `exatamente UM Enter saiu (achei ${enters.length})`);
    console.log('  ✅ Claude esperando:false — menu no reenvio: para, colado, exatamente um Enter');
  }

  // j2) menu no reenvio com a caixa já vazia: o 1º Enter já saiu — NUNCA descartado (duplicaria)
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({
      aba, estadoDoMenuSequencia: ['livre', 'livre', 'menu'], composerSequencia: [true, false],
    });
    assert.ok(r.rejeitou, 'menu no reenvio, caixa vazia: rejeita');
    assert.equal(r.rejeitou.colado, true, 'colado === true');
    assert.ok(!r.rejeitou.descartado, 'SEM descartado — devolver o texto duplicaria o envio (#21)');
    const enters = teclasEnviadas(r.chamadas).filter((t) => t === 'Enter');
    assert.equal(enters.length, 1, `exatamente UM Enter saiu (achei ${enters.length})`);
    console.log('  ✅ Claude esperando:false — menu no reenvio, caixa vazia: colado, sem descartado, um Enter');
  }

  // k) o processo troca DURANTE a 1ª leitura: a identidade repetida antes do Esc pega a troca
  {
    const aba = abaBase({ agente: 'claude', esperando: false, pane: '%60' });
    const r = await rodar({
      aba,
      mesmaIdentidadeSequencia: [null, 'a aba mudou de processo; confira o terminal antes de tentar novamente'],
      estadoDoMenuSequencia: ['menu'],
    });
    assert.ok(r.rejeitou, 'processo trocou na leitura: rejeita');
    assert.match(r.rejeitou.message, /mudou de processo/, 'a mensagem é de mesmaIdentidade');
    assert.equal(r.chamouEstadoDoMenu, 1, 'a tela FOI lida antes da rejeição — é a 2ª identidade que pega a troca');
    assert.equal(r.chamadas.length, 0, `ZERO send-keys — nenhum Escape saiu (achei ${r.chamadas.length})`);
    console.log('  ✅ Claude esperando:false — processo trocou entre a leitura e o Esc: zero send-keys');
  }

  // l) preSessao: true continua FORA do gesto — recusa em motivoDeRecusa, gesto nem roda
  {
    const aba = abaBase({ agente: 'claude', esperando: false, preSessao: true, pane: '%60' });
    const r = await rodar({ aba, motivoDeRecusaResultado: 'x' });
    assert.ok(r.rejeitou, 'preSessao: rejeita');
    assert.equal(r.chamouEstadoDoMenu, 0, 'preSessao: o gesto nem chega a chamar estadoDoMenu');
    console.log('  ✅ Claude esperando:false, preSessao: recusa em motivoDeRecusa, gesto nem roda');
  }

  // m) D58 intacto: Claude esperando:true continua sem menuFechado (o dono já estava vendo)
  {
    const aba = abaBase({ agente: 'claude', esperando: true, pane: '%60' });
    const r = await rodar({ aba, estadoDoMenuSequencia: ['menu', 'livre', 'livre'] });
    assert.equal(r.rejeitou, null, `D58 menu→livre→livre não deveria rejeitar (${r.rejeitou && r.rejeitou.message})`);
    assert.equal(r.resultado.menuFechado, undefined, 'D58 (esperando:true): sem menuFechado');
    console.log('  ✅ D58 intacto — Claude esperando:true: menuFechado continua undefined');
  }

  // ── Dois envios concorrentes na mesma aba: os seis send-keys não se intercalam (#28) ──
  {
    const registro = [];
    const tarefa = (rotulo) => async () => {
      for (const passo of ['Escape', 'texto', 'Enter']) {
        // Cede o event loop entre cada send-keys — se a fila não protegesse, os dois
        // envios se intercalariam aqui.
        await new Promise((pronto) => setImmediate(pronto));
        registro.push(`${rotulo}:${passo}`);
      }
      return rotulo;
    };
    await Promise.all([
      abasReal.enfileirarPorAba('aba-concorrente', tarefa('A')),
      abasReal.enfileirarPorAba('aba-concorrente', tarefa('B')),
    ]);
    const ordemLimpa = registro.join(',') === 'A:Escape,A:texto,A:Enter,B:Escape,B:texto,B:Enter'
      || registro.join(',') === 'B:Escape,B:texto,B:Enter,A:Escape,A:texto,A:Enter';
    assert.ok(ordemLimpa, `os seis send-keys não se intercalam (achei: ${registro.join(',')})`);
    console.log('  ✅ dois envios concorrentes na mesma aba: os seis send-keys não se intercalam');
  }

  console.log('\n✅ GATE VERDE — gesto Escape → reconfere → cola → Enter\n');
})().catch((e) => { console.error(e); process.exitCode = 1; });
