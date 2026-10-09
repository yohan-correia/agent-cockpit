#!/usr/bin/env node
'use strict';

/**
 * Gate de `lib/adaptador-job.js` — o terceiro leitor do contrato (§1.3 do plano
 * `2026-09-12-ver-a-conversa-do-job-plano.md`) — e, na Seção 2, do registro do job como
 * agente só-leitura em `lib/agentes.js` (§Fase 2 do mesmo plano).
 *
 * Fabrica a própria pasta em `tmp` e aponta `COCKPIT_JOBS_DIR` para lá. Nunca encosta em
 * `~/.cockpit/jobs` nem na pasta de jobs do orquestrador. Molde: `testes/gate-jobs-disco.js`.
 *
 * Uso: COCKPIT_CERT_DIR=/dev/null HOST=127.0.0.1 node testes/gate-adaptador-job.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let falhas = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) falhas += 1;
  return cond;
};

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-'));
process.env.COCKPIT_JOBS_DIR = RAIZ;

const adaptador = require('../lib/adaptador-job');

const FIXTURE = path.join(__dirname, 'fixtures', 'job-claude.log');
// A FIXTURE ANTIGA (acima) fica intocada — `testes/smoke-celular-job-passos.js:176` lê o
// MESMO arquivo, e ganhar `usage` ali faria o medidor aparecer nos PNGs sem ninguém ter
// pedido. Esta é a NOVA, com `usage` — números PLAUSÍVEIS (principal ~390 k de 1 M ⇒ ~39 %,
// depois um subagente Sonnet com número MAIOR, para provar que a escolha é por PAPEL, não por
// tamanho).
const FIXTURE_COM_USO = path.join(__dirname, 'fixtures', 'job-claude-com-usage.log');

// ─── Seção 1 — o leitor ─────────────────────────────────────────────────────

async function secao1() {
  console.log('\n── Seção 1 — lib/adaptador-job.js: o leitor ──\n');

  const lida = await adaptador.lerConversa(FIXTURE, 0, {});
  ok(lida !== null, 'a fixture é lida (não se abstém)');
  const { eventos, cortado, bytesLidos, tamanho } = lida;

  // G-J1a — envelope traduzido: 1 humano, falas do principal com sub: null.
  const humanos = eventos.filter((e) => e.tipo === 'humano');
  ok(humanos.length === 1, `G-J1a: 1 humano (veio ${humanos.length})`);
  const textoPrincipal = eventos.filter((e) => e.tipo === 'texto' && e.sub === null);
  ok(textoPrincipal.length === 2, `G-J1a: 2 falas do principal, com sub: null (vieram ${textoPrincipal.length})`);

  // G-J1b — sub é IDENTIDADE, nunca true.
  const subs = eventos.filter((e) => e.sub).map((e) => e.sub);
  ok(subs.length > 0 && subs.every((s) => typeof s === 'string'), 'G-J1b: sub é sempre string quando presente, nunca true');
  ok(new Set(subs).has('toolu_agente_1') && new Set(subs).has('toolu_agente_2'), 'G-J1b: dois subagentes têm identidades DIFERENTES (toolu_agente_1 ≠ toolu_agente_2)');

  // G-J1c — subNome/subTarefa resolvidos pelo mapa do Agent.
  const falaSub1 = eventos.find((e) => e.sub === 'toolu_agente_1' && e.tipo === 'texto');
  const falaSub2 = eventos.find((e) => e.sub === 'toolu_agente_2' && e.tipo === 'texto');
  ok(Boolean(falaSub1) && falaSub1.subNome === 'executor-plano', `G-J1c: subNome de toolu_agente_1 é executor-plano (veio ${falaSub1 && falaSub1.subNome})`);
  ok(Boolean(falaSub2) && falaSub2.subNome === 'avalia-plano', `G-J1c: subNome de toolu_agente_2 é avalia-plano (veio ${falaSub2 && falaSub2.subNome})`);
  ok(falaSub1.subTarefa === 'Executa o plano', `G-J1c: subTarefa de toolu_agente_1 é a description do Agent (veio "${falaSub1.subTarefa}")`);

  // G-J1k — user com parent_tool_use_id e texto NÃO vira humano.
  ok(humanos.length === 1 && humanos[0].texto === 'Execute o plano fase a fase, na risca.',
    'G-J1k: o prompt do subagente (mesmo texto do brief, mas com parent_tool_use_id) não duplicou o humano');
  ok(!eventos.some((e) => e.sub && e.tipo === 'humano'), 'G-J1k: nenhum evento humano carrega sub — a bolha "eu" falsa nunca existiu');

  // G-J1e — system/rate_limit_event/tool_progress/result/thinking não viram evento.
  const tiposConhecidos = new Set(['humano', 'texto', 'ferramenta', 'resultado_ferramenta']);
  ok(eventos.every((e) => tiposConhecidos.has(e.tipo)), 'G-J1e: só os quatro tipos do contrato saem do leitor');
  ok(eventos.filter((e) => e.tipo === 'texto').length === 6, `G-J1e: 6 falas de texto ao todo (2 principal + 2 sub1 + 2 sub2), vieram ${eventos.filter((e) => e.tipo === 'texto').length} — thinking/system/rate_limit não contam`);

  // G-J1f — abstenção: arquivo de linhas irreconhecíveis.
  const lixo = path.join(RAIZ, 'lixo.log');
  fs.writeFileSync(lixo, 'isto não é json\nnem isto\n');
  ok((await adaptador.lerConversa(lixo, 0, {})) === null, 'G-J1f: arquivo sem nenhuma linha JSON reconhecível ⇒ null');

  // G-J1g — incremental: só o que cresceu.
  const inc = path.join(RAIZ, 'incremental.log');
  const linhaBase = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'primeira' }] }, timestamp: '2026-01-01T00:00:00.000Z' })}\n`;
  fs.writeFileSync(inc, linhaBase);
  const primeira = await adaptador.lerConversa(inc, 0, {});
  fs.appendFileSync(inc, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'segunda' }] }, timestamp: '2026-01-01T00:00:01.000Z' })}\n`);
  const segunda = await adaptador.lerConversa(inc, primeira.tamanho, {});
  ok(segunda.eventos.length === 1 && segunda.eventos[0].texto === 'segunda', `G-J1g: leitura incremental devolve só o que cresceu (veio ${JSON.stringify(segunda.eventos.map((e) => e.texto))})`);

  // G-J1h — teto de bytes e cortado, com a fixture pequena (não deveria cortar).
  ok(bytesLidos <= adaptador.TETO_DURO, `G-J1h: bytesLidos (${bytesLidos}) <= TETO_DURO`);
  ok(cortado === false && bytesLidos === tamanho, 'G-J1h: fixture pequena não corta (cortado === false, bytesLidos === tamanho)');

  // G-J1h2 — o TETO DE BYTES de verdade, exercitado. O assert de cima passaria mesmo se o
  // teto fosse removido do leitor: fixture pequena nunca o alcança. Aqui se fabrica um log
  // MAIOR que `TETO_DURO` com um alvo de mensagens que a contagem nunca satisfaz — quem tem
  // de mandar parar é o teto, e só ele. É a rede da §2.5 da spec (contagem pura leu 8 MB e
  // voltou com 11 mensagens); sem este caso, ela não estava provada.
  const tetoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-teto-'));
  const tetoArq = path.join(tetoDir, 'claude.log');
  // Cada linha é uma ferramenta (não conta como "mensagem" para o alvo) com um campo de
  // enchimento — é assim que o arquivo passa do teto sem a contagem nunca fechar.
  const enchimento = 'x'.repeat(8 * 1024);
  const umaLinha = `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: enchimento } }] },
    timestamp: '2026-01-01T00:00:00.000Z',
  })}\n`;
  const quantas = Math.ceil((adaptador.TETO_DURO * 1.3) / umaLinha.length);
  fs.writeFileSync(tetoArq, umaLinha.repeat(quantas));
  const doTeto = await adaptador.lerConversa(tetoArq, 0, { alvoMensagens: 100000 });
  const tamanhoDoTeto = fs.statSync(tetoArq).size;
  ok(tamanhoDoTeto > adaptador.TETO_DURO, `G-J1h2: pré-condição — o arquivo (${(tamanhoDoTeto / 1048576).toFixed(1)} MB) passa do TETO_DURO`);
  ok(doTeto.bytesLidos <= adaptador.TETO_DURO && doTeto.bytesLidos > adaptador.TETO_DURO - adaptador.BLOCO,
    `G-J1h2: a leitura PARA no teto (leu ${(doTeto.bytesLidos / 1048576).toFixed(2)} MB de ${(tamanhoDoTeto / 1048576).toFixed(1)} MB)`);
  ok(doTeto.cortado === true, 'G-J1h2: e avisa que cortou (cortado === true)');
  fs.rmSync(tetoDir, { recursive: true, force: true });

  // G-J1d — Agent fora da cauda lida ⇒ sub preenchido, subNome === null.
  //
  // A fixture curta NÃO produz este corte (a leitura processa o bloco de 64 KB inteiro antes
  // de reavaliar a contagem, e o Agent continua no mesmo bloco). Fabrica-se aqui um log com o
  // Agent no começo e mais de 64 KB de eventos depois dele, para que a leitura pare no
  // primeiro bloco (o mais recente) sem nunca alcançar o bloco onde o Agent está.
  const corteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-corte-'));
  const corteArq = path.join(corteDir, 'claude.log');
  const linhasCorte = [];
  linhasCorte.push(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_fora_da_cauda', name: 'Agent', input: { subagent_type: 'executor-plano', description: 'x' } }] },
    timestamp: '2026-01-01T00:00:00.000Z',
  }));
  for (let i = 0; i < 2000; i += 1) {
    linhasCorte.push(JSON.stringify({
      type: 'assistant', parent_tool_use_id: 'toolu_fora_da_cauda',
      message: { content: [{ type: 'text', text: `passo ${i}` }] },
      timestamp: '2026-01-01T00:00:01.000Z',
    }));
  }
  fs.writeFileSync(corteArq, `${linhasCorte.join('\n')}\n`);
  const tamanhoCorte = fs.statSync(corteArq).size;
  const lidaCorte = await adaptador.lerConversa(corteArq, 0, {});
  ok(lidaCorte.cortado === true, 'G-J1d: a leitura corta (o arquivo é grande demais para caber inteiro no alvo)');
  ok(lidaCorte.bytesLidos < tamanhoCorte, `G-J1d: bytesLidos (${lidaCorte.bytesLidos}) < tamanho do arquivo (${tamanhoCorte}) — o Agent ficou fora`);
  const comSubSemNome = lidaCorte.eventos.filter((e) => e.sub === 'toolu_fora_da_cauda');
  ok(comSubSemNome.length > 0 && comSubSemNome.every((e) => e.subNome === null),
    `G-J1d: todo evento do subagente sem o Agent na cauda tem sub preenchido e subNome === null (${comSubSemNome.length} eventos)`);
  fs.rmSync(corteDir, { recursive: true, force: true });

  // G-J-ATE — o contrato `ate`/`inicio` (card `carregar-mais-historico`): funciona no leitor
  // do job, sob `ate` o leitor não abstém num trecho ilegível, o ramo incremental devolve
  // `inicio: desde`, e um passo do lote antigo sem o `Agent` pai no Map cai no rótulo
  // `└ subagente` sem estourar (R8 da spec — a rota nunca repassa o Map por fluxo).
  {
    const ateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-ate-'));
    const ateArq = path.join(ateDir, 'claude.log');
    const linhasAte = [];
    for (let i = 0; i < 600; i += 1) {
      linhasAte.push(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `passo ${String(i).padStart(4, '0')}${'x'.repeat(200)}` }] },
        timestamp: '2026-01-01T00:00:00.000Z',
      }));
    }
    fs.writeFileSync(ateArq, `${linhasAte.join('\n')}\n`);
    const primeiraLeitura = await adaptador.lerConversa(ateArq, 0, { alvoMensagens: 50 });
    ok(primeiraLeitura !== null && primeiraLeitura.inicio > 0,
      `G-J-ATE: primeira leitura corta e devolve inicio > 0 (veio ${primeiraLeitura && primeiraLeitura.inicio})`);
    const segundaLeitura = await adaptador.lerConversa(ateArq, 0, { ate: primeiraLeitura.inicio, alvoMensagens: 50 });
    ok(segundaLeitura !== null && segundaLeitura.eventos.length > 0,
      'G-J-ATE: o pedido ate=inicio traz a janela ANTERIOR');
    fs.rmSync(ateDir, { recursive: true, force: true });
  }
  {
    const lixoAteArq = path.join(RAIZ, 'lixo-ate.log');
    fs.writeFileSync(lixoAteArq, 'isto nao e json\nnem isto\n');
    const tamanhoLixo = fs.statSync(lixoAteArq).size;
    const semAte = await adaptador.lerConversa(lixoAteArq, 0, {});
    ok(semAte === null, 'G-J-ATE2: sem ate, arquivo ilegível continua se abstendo (null)');
    const comAte = await adaptador.lerConversa(lixoAteArq, 0, { ate: tamanhoLixo });
    ok(comAte !== null && comAte.eventos.length === 0,
      `G-J-ATE2: sob ate, o mesmo arquivo NÃO se abstém — devolve eventos vazios (veio ${JSON.stringify(comAte)})`);
  }
  {
    const incAteArq = path.join(RAIZ, 'incremental-ate.log');
    fs.writeFileSync(incAteArq, `${JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] }, timestamp: '2026-01-01T00:00:00.000Z',
    })}\n`);
    const baseAte = await adaptador.lerConversa(incAteArq, 0, {});
    fs.appendFileSync(incAteArq, `${JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] }, timestamp: '2026-01-01T00:00:01.000Z',
    })}\n`);
    const incrementalAte = await adaptador.lerConversa(incAteArq, baseAte.tamanho, {});
    ok(incrementalAte.inicio === baseAte.tamanho,
      `G-J-ATE3: o ramo incremental devolve inicio === desde (${incrementalAte.inicio} === ${baseAte.tamanho})`);
  }
  {
    const semAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-semagent-'));
    const semAgentArq = path.join(semAgentDir, 'claude.log');
    fs.writeFileSync(semAgentArq, `${JSON.stringify({
      type: 'assistant', parent_tool_use_id: 'toolu_sem_pai',
      message: { content: [{ type: 'text', text: 'filho orfao no lote antigo' }] },
      timestamp: '2026-01-01T00:00:00.000Z',
    })}\n`);
    const tamanhoSemAgent = fs.statSync(semAgentArq).size;
    let estourouSemAgent = null;
    let leituraSemAgent = null;
    try {
      leituraSemAgent = await adaptador.lerConversa(semAgentArq, 0, { ate: tamanhoSemAgent });
    } catch (e) { estourouSemAgent = e; }
    ok(estourouSemAgent === null, `G-J-ATE4: nenhum Agent pai no Map não estoura (${estourouSemAgent && estourouSemAgent.message})`);
    const orfao = leituraSemAgent && leituraSemAgent.eventos.find((e) => e.sub === 'toolu_sem_pai');
    ok(Boolean(orfao) && orfao.subNome === null,
      `G-J-ATE4: o filho órfão sai com sub preenchido e subNome null, rótulo └ subagente (veio ${JSON.stringify(orfao)})`);
    fs.rmSync(semAgentDir, { recursive: true, force: true });
  }

  // G-J2 — idValido e existe.
  ok(adaptador.idValido('../../etc/passwd') === false, 'G-J2: idValido rejeita "../../etc/passwd"');
  ok(adaptador.idValido('20260912-210000-projeto-abcd') === true, 'G-J2: idValido aceita um id no formato do orquestrador');
  ok(adaptador.idValido('a'.repeat(121)) === false, 'G-J2: idValido rejeita id acima de 120 caracteres');
  ok((await adaptador.existe('id-que-nao-existe')) === false, 'G-J2: existe() nega id sem pasta correspondente');
  const idFabricado = 'job-fabricado-para-o-gate';
  fs.mkdirSync(path.join(RAIZ, idFabricado), { recursive: true });
  ok((await adaptador.existe(idFabricado)) === true, 'G-J2: existe() confirma id de pasta fabricada de verdade');
  ok(adaptador.caminhoDoLog(idFabricado) === path.join(RAIZ, idFabricado, 'claude.log'), 'G-J2: caminhoDoLog monta o caminho a partir de dirJobs()');

  // G-J1i (par, R1/G13) — doArquivo() não devolve null SEMPRE: devolve null quando não há o
  // que medir (fixture SEM usage — `grep -c usage` = 0), e o `usados` do PRINCIPAL quando há
  // (fixture COM usage). Reescrito, não apagado: a frase "sempre" deixou de ser verdade.
  ok((await adaptador.doArquivo(FIXTURE)) === null,
    'G-J1i: doArquivo() devolve null quando não há usage nenhum (fixture antiga, intocada)');
  const medidoFixtureComUso = await adaptador.doArquivo(FIXTURE_COM_USO);
  ok(medidoFixtureComUso !== null && medidoFixtureComUso.usados === 390505,
    `G-J1i (par): doArquivo() devolve o usados do PRINCIPAL quando a fixture tem usage (veio ${JSON.stringify(medidoFixtureComUso)})`);

  // G-J1j — o mapa de subagentes SOBREVIVE ao incremental, quando o CHAMADOR o passa.
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-persist-'));
  const persistArq = path.join(persistDir, 'claude.log');
  fs.writeFileSync(persistArq, `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_persistente', name: 'Agent', input: { subagent_type: 'executor-plano', description: 'segue o plano' } }] },
    timestamp: '2026-01-01T00:00:00.000Z',
  })}\n`);
  const mapaCompartilhado = new Map();
  const leituraUm = await adaptador.lerConversa(persistArq, 0, { subagentes: mapaCompartilhado });
  ok(mapaCompartilhado.has('toolu_persistente'), 'G-J1j: o Agent da primeira leitura entrou no Map do chamador');
  fs.appendFileSync(persistArq, `${JSON.stringify({
    type: 'assistant', parent_tool_use_id: 'toolu_persistente',
    message: { content: [{ type: 'text', text: 'o filho chegou na leitura seguinte' }] },
    timestamp: '2026-01-01T00:00:01.000Z',
  })}\n`);
  const leituraDois = await adaptador.lerConversa(persistArq, leituraUm.tamanho, { subagentes: mapaCompartilhado });
  const filho = leituraDois.eventos.find((e) => e.sub === 'toolu_persistente');
  ok(Boolean(filho) && filho.subNome === 'executor-plano',
    `G-J1j: com o MESMO Map, o filho da leitura seguinte já vem com subNome resolvido (veio ${filho && filho.subNome})`);
  // Contraprova: SEM o Map persistido, o filho da segunda leitura não sabe o nome.
  const semMapa = await adaptador.lerConversa(persistArq, leituraUm.tamanho, {});
  const filhoSemMapa = semMapa.eventos.find((e) => e.sub === 'toolu_persistente');
  ok(Boolean(filhoSemMapa) && filhoSemMapa.subNome === null,
    'G-J1j (contraprova): sem o Map do chamador, a leitura incremental não sabe nomear o filho');
  fs.rmSync(persistDir, { recursive: true, force: true });
}

// ─── Seção 1.5 — a medição (card `contexto-da-sessao-do-job`, 22/09) ──────
//
// G1–G9 da spec §7, mais G-g/G-h (achados do painel na rodada 2). NENHUMA asserção aqui sobre
// `teto`/`pct` fora de `tetoDoModelo(...)` DIRETO (G6): `doArquivo`/`lerConversa` lêem
// `janelaLongaConfigurada()` por dentro, que sai de `os.homedir()` sem override por env — uma
// asserção de teto/pct nos outros gates passaria no servidor (que tem `[1m]`) e quebraria num
// clone limpo (spec §7.3). Por isso a `FIXTURE_COM_USO` foi desenhada com `usados` ACIMA de
// 200 k: a regra 4 de `tetoDoModelo` deduz 1 M do próprio valor, e o teto fica estável nos
// dois cenários — sem precisar tocar em `janelaLongaConfigurada()`.

async function secaoContexto() {
  console.log('\n── Seção 1.5 — lib/adaptador-job.js: a medição do contexto ──\n');
  const contextoLib = require('../lib/contexto');

  // G1 — medir() pega o PRINCIPAL, não o subagente (o subagente é o ÚLTIMO evento do arquivo,
  // e tem `usados` MAIOR — provando que a escolha é por PAPEL, não por ordem nem por tamanho).
  const medidoG1 = await adaptador.doArquivo(FIXTURE_COM_USO);
  ok(medidoG1 !== null && medidoG1.usados === 390505,
    `G1: doArquivo pega o usados do PRINCIPAL, não do subagente (veio ${JSON.stringify(medidoG1)})`);
  ok(medidoG1.modelo === 'claude-opus-5', `G1: e o modelo é o do principal (veio ${medidoG1.modelo})`);
  ok(medidoG1.usados !== 450000, 'G1: usados não é o valor (maior) do subagente');

  // G2 — a marca é o VALOR, não a chave. A fixture tem `parent_tool_use_id: null` EXPLÍCITO
  // no principal — um filtro por PRESENÇA de chave trataria TODO evento assistant como
  // subagente (a chave está em todos) e `doArquivo` nunca acharia o principal.
  const brutoFixtureComUso = fs.readFileSync(FIXTURE_COM_USO, 'utf8');
  ok(brutoFixtureComUso.includes('"parent_tool_use_id":null'),
    'G2 (pré-condição): a fixture tem parent_tool_use_id: null EXPLÍCITO no principal');
  ok(medidoG1 !== null && medidoG1.usados === 390505,
    'G2: com o VALOR truthy (não a chave), o principal ainda é achado');

  // G3 — cauda só com subagente: o último principal fica ANTES de 64 KB de subagente puro.
  // `doArquivo` tem de varrer mais fundo e achar — é o gate que reprova a armadilha #69.
  {
    const dirG3 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-g3-'));
    const arqG3 = path.join(dirG3, 'claude.log');
    const linhasG3 = [];
    linhasG3.push(JSON.stringify({
      type: 'assistant', parent_tool_use_id: null,
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'fala do principal' }],
        usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 66900 } },
      timestamp: '2026-01-01T00:00:00.000Z',
    }));
    const enchimentoG3 = 'y'.repeat(300);
    for (let i = 0; i < 400; i += 1) {
      linhasG3.push(JSON.stringify({
        type: 'assistant', parent_tool_use_id: 'toolu_sub_g3',
        message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `passo ${i} ${enchimentoG3}` }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 990 } },
        timestamp: '2026-01-01T00:00:01.000Z',
      }));
    }
    fs.writeFileSync(arqG3, `${linhasG3.join('\n')}\n`);
    const tamanhoG3 = fs.statSync(arqG3).size;
    ok(tamanhoG3 > adaptador.BLOCO,
      `G3 (pré-condição): o arquivo (${tamanhoG3} B) passa de um BLOCO (${adaptador.BLOCO} B) — o último bloco só tem subagente`);
    const medidoG3 = await adaptador.doArquivo(arqG3);
    ok(medidoG3 !== null && medidoG3.usados === 67900,
      `G3: doArquivo varre mais fundo e acha o principal fora do último bloco (veio ${JSON.stringify(medidoG3)})`);
    fs.rmSync(dirG3, { recursive: true, force: true });
  }

  // G4 — log sem usage nenhum ⇒ null, sem lançar (a fixture antiga, intocada).
  let estourouG4 = null;
  let medidoG4 = null;
  try { medidoG4 = await adaptador.doArquivo(FIXTURE); } catch (e) { estourouG4 = e; }
  ok(estourouG4 === null && medidoG4 === null, `G4: log sem usage ⇒ null, sem lançar (${estourouG4 && estourouG4.message})`);

  // G5 — usage ZERADO (evento sintético) no FIM: pula, e devolve o principal anterior.
  {
    const dirG5 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-g5-'));
    const arqG5 = path.join(dirG5, 'claude.log');
    const linhasG5 = [
      JSON.stringify({
        type: 'assistant', parent_tool_use_id: null,
        message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'fala real' }],
          usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000 } },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant', parent_tool_use_id: null,
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: '' }],
          usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
    ];
    fs.writeFileSync(arqG5, `${linhasG5.join('\n')}\n`);
    const medidoG5 = await adaptador.doArquivo(arqG5);
    ok(medidoG5 !== null && medidoG5.usados === 10000,
      `G5: usage zerado no fim é pulado, devolve o principal ANTERIOR (veio ${JSON.stringify(medidoG5)})`);
    fs.rmSync(dirG5, { recursive: true, force: true });
  }

  // G6 — teto com `[1m]` configurado: só via tetoDoModelo(...) DIRETO, nunca exercitando
  // janelaLongaConfigurada() (spec §7.3 — ver o comentário no topo da seção).
  ok(contextoLib.tetoDoModelo('claude-opus-5', 68111, { longa: true }) === 1000000,
    'G6: tetoDoModelo com longa:true devolve 1 M (o cenário real do job de 22/09)');
  ok(contextoLib.tetoDoModelo('claude-opus-5', 68111, { longa: false }) === 200000,
    'G6: e com longa:false devolve 200 k — a diferença de 34% vs 6,8% do §2.6 da spec');

  // G7 — lerConversa SEM a opção `contexto`: o retorno não tem a chave `contexto` — a
  // proteção dos outros chamadores (R7 da spec).
  const semOpcaoG7 = await adaptador.lerConversa(FIXTURE_COM_USO, 0, {});
  ok(!Object.hasOwn(semOpcaoG7, 'contexto'), 'G7: lerConversa sem a opção contexto não tem a chave contexto');
  const comOpcaoG7 = await adaptador.lerConversa(FIXTURE_COM_USO, 0, { contexto: { longa: false } });
  ok(Object.hasOwn(comOpcaoG7, 'contexto'), 'G7 (contraprova): com a opção, a chave contexto aparece');

  // G8 — lerConversa com a opção, lote INCREMENTAL só de subagente ⇒ contexto: null.
  {
    const dirG8 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-g8-'));
    const arqG8 = path.join(dirG8, 'claude.log');
    fs.writeFileSync(arqG8, `${JSON.stringify({
      type: 'assistant', parent_tool_use_id: null,
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a' }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 } },
      timestamp: '2026-01-01T00:00:00.000Z',
    })}\n`);
    const baseG8 = await adaptador.lerConversa(arqG8, 0, {});
    fs.appendFileSync(arqG8, `${JSON.stringify({
      type: 'assistant', parent_tool_use_id: 'toolu_sub_g8',
      message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'filho fala' }],
        usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 450 } },
      timestamp: '2026-01-01T00:00:01.000Z',
    })}\n`);
    const parcialG8 = await adaptador.lerConversa(arqG8, baseG8.tamanho, { contexto: { longa: false } });
    ok(parcialG8 !== null && parcialG8.contexto === null,
      `G8: lote incremental só de subagente ⇒ contexto: null (veio ${JSON.stringify(parcialG8 && parcialG8.contexto)})`);
    fs.rmSync(dirG8, { recursive: true, force: true });
  }

  // G9 — emenda de linha (#11): o evento principal cai EM CIMA de uma fronteira de bloco de
  // 64 KB. `doArquivo` tem de reconstruir a linha pelo `carry` e ainda assim achar o usage.
  {
    const dirG9 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-g9-'));
    const arqG9 = path.join(dirG9, 'claude.log');
    const principalG9 = JSON.stringify({
      type: 'assistant', parent_tool_use_id: null,
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'principal na fronteira do bloco' }],
        usage: { input_tokens: 12345, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const linhaBytes = Buffer.byteLength(principalG9, 'utf8');
    // A fronteira (`size - BLOCO`) cai no MEIO da linha do principal — nem no início nem no
    // fim dela — para provar a emenda de verdade, não um caso de sorte na borda.
    const boundaryNaLinha = Math.floor(linhaBytes / 2);
    const tamanhoAlvo = adaptador.BLOCO + boundaryNaLinha;
    const paddingLen = tamanhoAlvo - linhaBytes - 1; // -1 pelo '\n' depois do principal
    const padding = 'z'.repeat(Math.max(0, paddingLen)); // uma linha SÓ, sem '\n' interno
    fs.writeFileSync(arqG9, `${principalG9}\n${padding}`);
    const tamanhoRealG9 = fs.statSync(arqG9).size;
    ok(tamanhoRealG9 > adaptador.BLOCO,
      `G9 (pré-condição): o arquivo (${tamanhoRealG9} B) passa de um BLOCO — a fronteira cai dentro da linha do principal`);
    const medidoG9 = await adaptador.doArquivo(arqG9);
    ok(medidoG9 !== null && medidoG9.usados === 12345,
      `G9: doArquivo reconstrói a linha na fronteira (carry) e acha o usage (veio ${JSON.stringify(medidoG9)})`);
    fs.rmSync(dirG9, { recursive: true, force: true });
  }

  // G-g (achado do Codex) — abertura com log VAZIO: a primeira leitura não tem nada a medir; um
  // principal com usage chega DEPOIS, mas com `desde` ainda em 0 (o `lido` de uma leitura de
  // arquivo vazio) — cai no ramo INICIAL, não no incremental. É o gate do ramo inicial (Fase
  // 1, passo 3): sem medir ali, esse número nunca seria visto se o job terminasse ali.
  {
    const dirGg = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-gg-'));
    const arqGg = path.join(dirGg, 'claude.log');
    fs.writeFileSync(arqGg, '');
    const primeiraGg = await adaptador.lerConversa(arqGg, 0, { contexto: { longa: false } });
    ok(primeiraGg !== null && primeiraGg.contexto === null && primeiraGg.tamanho === 0,
      `G-g (pré-condição): log vazio na abertura ⇒ contexto null, tamanho 0 (veio ${JSON.stringify(primeiraGg)})`);
    fs.writeFileSync(arqGg, `${JSON.stringify({
      type: 'assistant', parent_tool_use_id: null,
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'primeira fala, já com usage' }],
        usage: { input_tokens: 4000, cache_creation_input_tokens: 0, cache_read_input_tokens: 21000 } },
      timestamp: '2026-01-01T00:00:02.000Z',
    })}\n`);
    // `desde` continua 0 (o `lido` do servidor não avançou na leitura vazia) — cai no ramo
    // INICIAL, não no incremental (que exige `inicio > 0`).
    const segundaGg = await adaptador.lerConversa(arqGg, primeiraGg.tamanho, { contexto: { longa: false } });
    ok(segundaGg !== null && segundaGg.contexto !== null && segundaGg.contexto.usados === 25000,
      `G-g: o ramo INICIAL mede o principal que chegou depois da abertura vazia (veio ${JSON.stringify(segundaGg && segundaGg.contexto)})`);
    fs.rmSync(dirGg, { recursive: true, force: true });
  }

  // G-h (achado do Claude, rodada 2) — DOIS principais no MESMO bloco ⇒ vale o SEGUNDO
  // (cronológico), nunca o primeiro. É a régua "dentro de um bloco" da Fase 1, passo 3.
  {
    const dirGh = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-gh-'));
    const arqGh = path.join(dirGh, 'claude.log');
    const linhasGh = [
      JSON.stringify({
        type: 'assistant', parent_tool_use_id: null,
        message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'primeiro principal' }],
          usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 } },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant', parent_tool_use_id: null,
        message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'segundo principal' }],
          usage: { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 1800 } },
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
    ];
    fs.writeFileSync(arqGh, `${linhasGh.join('\n')}\n`);
    const medidoGh = await adaptador.doArquivo(arqGh);
    ok(medidoGh !== null && medidoGh.usados === 2000,
      `G-h: dois principais no mesmo bloco ⇒ vale o SEGUNDO, cronológico (veio ${JSON.stringify(medidoGh)})`);
    fs.rmSync(dirGh, { recursive: true, force: true });
  }

  // G12 (R6) — as três legendas revogadas: o arquivo não afirma mais que a medição é
  // impossível. Asserção de FONTE, não de comportamento — é a #40 pela porta do comentário.
  const fonteAdaptador = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adaptador-job.js'), 'utf8');
  ok(!/devolve sempre .?null.?/i.test(fonteAdaptador),
    'G12: lib/adaptador-job.js não afirma mais que doArquivo "devolve sempre null"');
  ok(!/não tem janela de contexto para medir/i.test(fonteAdaptador),
    'G12: nem que um job "não tem janela de contexto para medir"');
}

// ─── Seção 2 — o registro (Fase 2: job como agente só-leitura) ─────────────

const http = require('node:http');
const { execFileSync } = require('node:child_process');

/** Mesmo molde de `testes/gate-jobs-rota.js`: fail-closed, nunca herda porta ocupada. */
function portaLivre(porta) {
  try {
    const saida = execFileSync('ss', ['-H', '-lptn'], { encoding: 'utf8' });
    return !saida.split('\n').some((linha) => {
      const campos = linha.trim().split(/\s+/);
      return (campos[3] || '').endsWith(`:${porta}`);
    });
  } catch {
    return true;
  }
}

function pedir(porta, caminho, { metodo = 'GET', corpo = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo,
      headers: corpo ? { 'content-type': 'application/json' } : {} }, (res) => {
      let bruto = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { bruto += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, corpo: JSON.parse(bruto) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (corpo) req.end(JSON.stringify(corpo)); else req.end();
  });
}

async function secao2() {
  console.log('\n── Seção 2 — lib/agentes.js: o job como agente só-leitura (Fase 2) ──\n');

  const agentesLib = require('../lib/agentes');
  const abasLib = require('../lib/abas');

  // G-J3a
  ok(agentesLib.ids().includes('job'), 'G-J3a: agentes.ids() inclui "job"');
  ok(agentesLib.de('job').leitor === require('../lib/adaptador-job'),
    'G-J3a: agentes.de("job").leitor é o adaptador do job');

  // G-J3b
  ok(agentesLib.existe('job') === false, 'G-J3b: agentes.existe("job") é false');
  ok(agentesLib.existe('claude') === true, 'G-J3b: agentes.existe("claude") continua true');

  // G-J3c — o registro de `detectarAgente` (lib/abas.js) não estoura com `job` na tabela
  // (job não tem `padraoCmd`; sem o filtro, `undefined.test(argv0)` derrubaria a detecção
  // de TODA aba do terminal). Chamada real, com o próprio pid do gate — não precisa de tmux.
  let estourou = null;
  try {
    await abasLib.detectarAgente(process.pid);
  } catch (e) {
    estourou = e;
  }
  ok(estourou === null, `G-J3c: detectarAgente não lança TypeError com "job" no registro (${estourou && estourou.message})`);

  // ── G-J3d/G-J3e — via HTTP, com um server.js DEDICADO a esta seção ──
  // A porta é ESCOLHIDA na faixa, não chumbada: a 7892 é a mesma que
  // `testes/smoke-celular-job-passos.js` usa, e rodar os dois ao mesmo tempo derrubava este
  // gate por colisão — falha de AGENDA lida como falha de código (aconteceu em 12/09).
  // Continua fail-closed: se a faixa inteira estiver ocupada, aborta sem subir nada. Nunca a
  // 7879 (produção) nem a 7899 (jobs, #24).
  const PORTA = [7892, 7894, 7890, 7897].find((p) => portaLivre(p));
  if (!PORTA) {
    console.error('🔴 nenhuma porta livre na faixa para a Seção 2 — abortando sem subir servidor.');
    falhas += 1;
    return;
  }
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-cert-'));
  const projetosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-adaptador-job-projetos-'));
  fs.mkdirSync(path.join(projetosDir, 'projeto-a'), { recursive: true });

  process.env.PORT = String(PORTA);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = certDir;
  process.env.COCKPIT_TOKEN = '';
  process.env.COCKPIT_PROJETOS_DIR = projetosDir;
  // COCKPIT_JOBS_DIR já é RAIZ (topo do arquivo). Dedicado — nunca o socket `main` real.
  process.env.COCKPIT_TMUX_SOCKET = `gate-adaptador-job-${process.pid}`;
  process.env.COCKPIT_VIGIA_MS = '0';
  process.env.COCKPIT_MONITOR_MS = '0'; // o amostrador do monitor escreve desde o boot (#82)

  require(path.join(__dirname, '..', 'server.js'));
  await new Promise((r) => setTimeout(r, 400));

  // G-J3d
  const respAgentes = await pedir(PORTA, '/api/agentes');
  const ids = (respAgentes.corpo.agentes || []).map((a) => a.id);
  ok(!ids.includes('job'), `G-J3d: /api/agentes não traz "job" (veio ${JSON.stringify(ids)})`);
  ok(ids.includes('claude') && ids.includes('codex'), 'G-J3d: e continua trazendo claude e codex');

  // G-J3e
  const respAbas = await pedir(PORTA, '/api/abas', { metodo: 'POST', corpo: { projeto: 'projeto-a', agente: 'job' } });
  ok(respAbas.status === 400, `G-J3e: POST /api/abas {agente:'job'} responde 400 (veio ${respAbas.status})`);
  ok(typeof respAbas.corpo.erro === 'string', 'G-J3e: e a resposta 400 tem uma mensagem de erro');

  fs.rmSync(certDir, { recursive: true, force: true });
  fs.rmSync(projetosDir, { recursive: true, force: true });
}

// ─── Corrida ────────────────────────────────────────────────────────────────

async function principal() {
  try {
    await secao1();
    await secaoContexto();
    await secao2();
  } finally {
    fs.rmSync(RAIZ, { recursive: true, force: true });
  }
  console.log(`\n${falhas === 0 ? '✅ GATE VERDE' : `❌ GATE VERMELHO (${falhas} falha(s))`} — lib/adaptador-job.js\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch((e) => {
  console.error('🔴 o gate estourou —', e);
  process.exit(1);
});
