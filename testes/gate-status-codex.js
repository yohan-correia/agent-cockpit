#!/usr/bin/env node
'use strict';
// GATE DO /status NATIVO DO CODEX — parser, storage, orquestração da pane e rota+SSE.
//
// Três andares, cada um provando uma coisa diferente, nenhum tocando tmux de verdade nem
// gastando turno de modelo:
//
//   1) lib/status-codex.js direto — parser (fixture real 0.153.4, sessão errada, moldura
//      parcial, ANSI) e storage (teto, truncamento, idempotência, isolamento, reload).
//   2) lib/abas.js#consultarStatus com fronteiras dubladas (mesma costura do
//      gate-envio-skill-codex.js): busy/esperando/sem-sessão recusam sem tocar tecla,
//      composer sujo recusa antes do Enter, timeout aos ~5,3s, fila serializa duas chamadas.
//   3) server.js com lib/abas dublado no require.cache (mesmo padrão do
//      gate-troca-arquivo.js): a tabela HTTP inteira e o SSE (replay, dedupe, escopo por
//      sessão, listener morre no close).
//
// Uso:  node testes/gate-status-codex.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const assert = require('node:assert/strict');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };
let tudoOk = true;
const marcar = (c, t) => { if (!ok(c, t)) tudoOk = false; };

// ─── raiz de storage isolada, uma por processo de teste inteiro ────────────────────────
const raizStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-status-codex-'));
process.env.COCKPIT_STATUS_CODEX_DIR = raizStorage;

(async () => {
  // ═══ 1) PARSER E STORAGE, direto de lib/status-codex.js ═══════════════════════════════
  console.log('\n── 1) parser e storage (lib/status-codex.js) ──\n');
  {
    const statusCodex = require('../lib/status-codex');
    const SESSAO = '01a08228-aa4c-7be1-bc86-f6c698933c7d';
    const fixture = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'status-codex', '0.153.4-status.txt'), 'utf8',
    );

    const okReal = statusCodex.extrairBlocoStatus(fixture, SESSAO);
    marcar(okReal.ok === true, 'fixture real da 0.153.4 (r3a7_t1p) parseia com a Session esperada');
    marcar(okReal.texto.startsWith('╭') && okReal.texto.endsWith('╯'),
      'o bloco extraído é a MOLDURA inteira, do topo ao fim');
    marcar(okReal.texto.includes('Token usage:') && okReal.texto.includes('Limits:'),
      'e leva o corpo inteiro (Token usage, Context window, Limits)');
    marcar(!okReal.texto.includes('Ask Codex to do anything'),
      'sem o composer nem o rodapé — só o bloco, nada da tela ao redor (não é espelho geral, D4)');

    const sessaoErrada = statusCodex.extrairBlocoStatus(fixture, 'outra-sessao-que-nao-bate');
    marcar(sessaoErrada.ok === false && sessaoErrada.motivo === 'sessao-divergente',
      'Session de outra sessão nunca é aceita como se fosse desta (wrongSession)');

    const semNada = statusCodex.extrairBlocoStatus('nada de /status nesta tela', SESSAO);
    marcar(semNada.ok === false && semNada.motivo === 'sem-marcador',
      'tela sem o eco de /status não confirma resposta nenhuma (stale)');

    const parcial = statusCodex.extrairBlocoStatus(
      `/status\n╭──────╮\n│ Session: ${SESSAO}`, SESSAO,
    );
    marcar(parcial.ok === false && parcial.motivo === 'moldura-incompleta',
      'moldura sem fechamento é "ainda não terminou", não erro (parcial)');

    // A ÚLTIMA ocorrência de /status vence — uma resposta VELHA ainda visível no scrollback
    // não pode ser confundida com a que acabou de sair.
    const duasRespostas = `/status\n╭──╮\n│ Session: sessao-velha         │\n╰──╯\n\n`
      + `/status\n╭──────────────────────────────╮\n│ Session: ${SESSAO}             │\n╰──────────────────────────────╯`;
    const maisNova = statusCodex.extrairBlocoStatus(duasRespostas, SESSAO);
    marcar(maisNova.ok === true, 'com duas respostas na tela, a ÚLTIMA é a que conta (freshness)');
    const maisNovaSessaoVelha = statusCodex.extrairBlocoStatus(duasRespostas, 'sessao-velha');
    marcar(maisNovaSessaoVelha.ok === false,
      'e a resposta VELHA nunca é aceita mesmo pedindo a sessão dela — só a última bloco conta');

    // ANSI + controle: o parser sanitiza antes de procurar a moldura.
    const comAnsi = `\x1b[2m/status\x1b[0m\n\x1b[1m╭──────────────────────────────╮\x1b[0m\n`
      + `│ Session: ${SESSAO}             │\n╰──────────────────────────────╯`;
    const viaAnsi = statusCodex.extrairBlocoStatus(comAnsi, SESSAO);
    marcar(viaAnsi.ok === true && !viaAnsi.texto.includes('\x1b'),
      'ANSI/negrito ao redor do bloco não impede o parse, e não sobra sequência de escape no texto');

    // Composer: vazio de verdade (placeholder dim) × rascunho (texto sem dim) × marcador só.
    const composerVazioDim = '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m';
    const composerRascunho = '\x1b[1m›\x1b[0m rascunho de teste';
    const composerVazioLiteral = '\x1b[1m›\x1b[0m';
    marcar(statusCodex.composerVazio(composerVazioDim) === true, 'composer com placeholder dim é vazio');
    marcar(statusCodex.composerVazio(composerRascunho) === false, 'composer com rascunho NÃO é vazio');
    marcar(statusCodex.composerVazio(composerVazioLiteral) === true, 'marcador sem nada depois também é vazio');
    marcar(statusCodex.composerVazio('sem marcador nenhum aqui') === false,
      'formato de composer não identificável recusa por padrão (nunca aceita por omissão)');
    marcar(statusCodex.composerContemExatamente('\x1b[1m›\x1b[0m /status', '/status') === true,
      'composer com exatamente /status casa antes do Enter');
    marcar(statusCodex.composerContemExatamente('\x1b[1m›\x1b[0m /status extra', '/status') === false,
      'composer com texto a mais não casa — nunca aperta Enter sobre algo diferente');

    // Achado de revisão do capitão (08/09): `›` dentro de PROSA (uma fala citando o
    // símbolo, ou um eco antigo) não pode ser lido como se fosse a caixa de texto — o
    // marcador só conta quando é o PRIMEIRO caractere visível da linha.
    const falaComSimboloNoMeio = 'Olha o prompt: › isto não é o composer, é uma fala';
    marcar(statusCodex.composerVazio(falaComSimboloNoMeio) === false,
      '› no MEIO de uma fala não é lido como composer (recusa por formato desconhecido)');
    const composerDeVerdadeAcimaDeFala = [
      falaComSimboloNoMeio,
      '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m',
    ].join('\n');
    marcar(statusCodex.composerVazio(composerDeVerdadeAcimaDeFala) === true,
      'com o composer de VERDADE mais abaixo, é ele quem decide — a fala acima não atrapalha');

    // Achado de revisão (08/09): rascunho que QUEBRA em duas linhas visuais não pode passar
    // por "vazio" só porque a primeira linha do composer ficou sem texto pelo word-wrap.
    const composerQuebrado = '\x1b[1m›\x1b[0m \nrestinho do rascunho que quebrou linha';
    marcar(statusCodex.composerVazio(composerQuebrado) === false,
      'composer com a linha seguinte NÃO em branco recusa (rascunho quebrado em duas linhas)');
    const composerVazioDeVerdadeComLinhaEmBrancoDepois = '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n\n  mock default · /cwd';
    marcar(statusCodex.composerVazio(composerVazioDeVerdadeComLinhaEmBrancoDepois) === true,
      'e o composer vazio de verdade, com o rodapé (linha em branco) depois, continua aceito');

    // Truncamento por BYTES, não por caractere — achado de revisão (08/09): a moldura tem
    // box-drawing (╭│╰), multibyte em UTF-8, e `String.slice()` conta code units.
    const boxDrawingRepetido = '╭'.repeat(9000);   // cada ╭ = 3 bytes UTF-8 ⇒ 27 000 bytes
    const { snapshot: truncadoMultibyte } = await statusCodex.registrarSnapshot('sessao-truncamento-multibyte', {
      id: 'env-multibyte', texto: boxDrawingRepetido, quando: '2026-09-08T10:00:00.000Z',
    });
    const bytesReais = Buffer.byteLength(truncadoMultibyte.texto, 'utf8');
    marcar(bytesReais <= statusCodex.TETO_SNAPSHOT,
      `o texto gravado cabe em 16 KiB de BYTES de verdade, não de caracteres (${bytesReais} bytes)`);

    // ─ storage ─
    const S1 = 'sessao-armazenamento-1';
    const S2 = 'sessao-armazenamento-2';

    const r1 = await statusCodex.registrarSnapshot(S1, { id: 'env-1', texto: 'primeiro', quando: '2026-09-08T10:00:00.000Z' });
    marcar(r1.criado === true, 'primeiro registro de um id novo é gravado');
    const r1de = await statusCodex.registrarSnapshot(S1, { id: 'env-1', texto: 'MUDOU (não devia)', quando: '2026-09-08T10:05:00.000Z' });
    marcar(r1de.criado === false && r1de.snapshot.texto === 'primeiro',
      'id repetido devolve o snapshot ORIGINAL — idempotência, nunca redigita');

    // `registrarSnapshot` recusa o id ANTES de entrar na fila — estoura síncrono, não como
    // promessa rejeitada, e por isso a chamada precisa estar dentro de uma função.
    assert.throws(
      () => statusCodex.registrarSnapshot(S1, { id: 'id inválido com espaço', texto: 'x' }),
      (e) => e.codigo === 400,
      'id de envio fora do formato é 400',
    );

    const grande = 'x'.repeat(20 * 1024);
    const { snapshot: truncado } = await statusCodex.registrarSnapshot(S1, { id: 'env-grande', texto: grande, quando: '2026-09-08T10:10:00.000Z' });
    marcar(truncado.texto.length === statusCodex.TETO_SNAPSHOT, `resposta maior que 16 KiB é truncada (ficou ${truncado.texto.length} bytes)`);

    // Teto de 20 por sessão: o mais antigo sai quando o 21º chega.
    const S3 = 'sessao-teto';
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await statusCodex.registrarSnapshot(S3, { id: `t-${i}`, texto: `snap ${i}`, quando: `2026-09-08T11:${String(i).padStart(2, '0')}:00.000Z` });
    }
    const antesDoTeto = await statusCodex.snapshotsDe(S3);
    marcar(antesDoTeto.length === 20, `com 20 registros, os 20 ficam (achou ${antesDoTeto.length})`);
    await statusCodex.registrarSnapshot(S3, { id: 't-20', texto: 'snap 20', quando: '2026-09-08T11:20:00.000Z' });
    const depoisDoTeto = await statusCodex.snapshotsDe(S3);
    marcar(depoisDoTeto.length === 20, 'o 21º entra sem passar de 20 no total');
    marcar(!depoisDoTeto.some((s) => s.id === 't-0'), 'o MAIS ANTIGO (t-0) é quem sai');
    marcar(depoisDoTeto.some((s) => s.id === 't-20'), 'e o novo (t-20) está lá');

    // Isolamento: sessões diferentes nunca leem snapshot uma da outra, mesmo com ids iguais.
    await statusCodex.registrarSnapshot(S2, { id: 'env-1', texto: 'sessao 2, id igual', quando: '2026-09-08T10:00:00.000Z' });
    const doS1 = await statusCodex.snapshotsDe(S1);
    const doS2 = await statusCodex.snapshotsDe(S2);
    marcar(doS1.find((s) => s.id === 'env-1').texto === 'primeiro'
      && doS2.find((s) => s.id === 'env-1').texto === 'sessao 2, id igual',
    'duas sessões com o MESMO id de envio guardam textos independentes (isolamento)');

    // Leitura de arquivo corrompido não derruba o chamador — devolve lista vazia.
    const S4 = 'sessao-corrompida';
    const arquivoS4 = statusCodex.arquivoDaSessao(S4);
    fs.mkdirSync(path.dirname(arquivoS4), { recursive: true });
    fs.writeFileSync(arquivoS4, '{ isto não é json válido');
    const lidoCorrompido = await statusCodex.snapshotsDe(S4);
    marcar(Array.isArray(lidoCorrompido) && lidoCorrompido.length === 0,
      'arquivo de snapshot corrompido devolve lista vazia, nunca inventa conteúdo nem estoura');

    // Achado de revisão (08/09): arquivo ADULTERADO/gigante não pode ser lido para a
    // memória inteiro só para ser descartado depois — o teto entra ANTES do readFile.
    const S5 = 'sessao-arquivo-gigante';
    const arquivoS5 = statusCodex.arquivoDaSessao(S5);
    fs.mkdirSync(path.dirname(arquivoS5), { recursive: true });
    fs.writeFileSync(arquivoS5, JSON.stringify([{
      id: 'x', sessaoId: S5, quando: '2026-09-08T10:00:00.000Z', texto: 'y'.repeat(2 * 1024 * 1024),
    }]));
    const lidoGigante = await statusCodex.snapshotsDe(S5);
    marcar(Array.isArray(lidoGigante) && lidoGigante.length === 0,
      'arquivo MAIOR que o teto de leitura é recusado (lista vazia), nunca lido inteiro para a memória');

    const unicode = await statusCodex.registrarSnapshot('utf8', {id:'x',texto:'á'.repeat(16000)});
    assert.ok(Buffer.byteLength(unicode.snapshot.texto) <= 16384);
    fs.writeFileSync(statusCodex.arquivoDaSessao('teto-leitura'), JSON.stringify(Array.from({length:25},(_,i)=>({id:'i'+i,sessaoId:'teto-leitura',quando:'2026-09-08T12:00:00Z',texto:'ok'}))));
    assert.equal((await statusCodex.snapshotsDe('teto-leitura')).length,20);
    assert.equal(statusCodex.sanitizarTela('\x1b]8;;https://fixture.test\x07texto\x1b]8;;\x07'),'texto');
    marcar(true,'UTF-8, teto de leitura e remoção de link ANSI conferidos');

    // "Reload do módulo": o storage é o DISCO, não memória — apagar do require.cache e
    // carregar de novo tem que continuar lendo os mesmos snapshots (persistência real).
    delete require.cache[require.resolve('../lib/status-codex')];
    const recarregado = require('../lib/status-codex');
    const apoReload = await recarregado.snapshotsDe(S1);
    marcar(apoReload.some((s) => s.id === 'env-1' && s.texto === 'primeiro'),
      'depois de recarregar o módulo, os snapshots continuam lá — o estado é do disco');

    // Raiz muda em TEMPO DE CHAMADA (troca de env), como lib/abas.js faz com binDoClaude().
    const outraRaiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-status-codex-outra-'));
    const raizAntiga = process.env.COCKPIT_STATUS_CODEX_DIR;
    process.env.COCKPIT_STATUS_CODEX_DIR = outraRaiz;
    await recarregado.registrarSnapshot('sessao-outra-raiz', { id: 'x', texto: 'noutra raiz', quando: '2026-09-08T10:00:00.000Z' });
    marcar(fs.existsSync(path.join(outraRaiz, 'sessao-outra-raiz.json')),
      'trocar COCKPIT_STATUS_CODEX_DIR em tempo de chamada muda ONDE se grava, sem reiniciar nada');
    marcar(!fs.existsSync(path.join(raizAntiga, 'sessao-outra-raiz.json')),
      'e nada vaza para a raiz antiga');
    process.env.COCKPIT_STATUS_CODEX_DIR = raizAntiga;
    fs.rmSync(outraRaiz, { recursive: true, force: true });
  }

  // ═══ 2) ORQUESTRAÇÃO DA PANE — lib/abas.js#consultarStatus, fronteiras dubladas ═══════
  console.log('\n── 2) consultarStatus (lib/abas.js), tmux dublado ──\n');
  await testeOrquestracao();

  // ═══ 3) ROTA + SSE — server.js com lib/abas dublado no require.cache ═════════════════
  console.log('\n── 3) rota HTTP e SSE (server.js) ──\n');
  await testeRotaESse();

  console.log(`\n${tudoOk ? '✅ GATE VERDE' : '❌ GATE VERMELHO'} — /status do Codex\n`);
  fs.rmSync(raizStorage, { recursive: true, force: true });
  process.exit(tudoOk ? 0 : 1);
})().catch((erro) => {
  console.error('\n❌ o gate quebrou:', erro.stack || erro.message, '\n');
  fs.rmSync(raizStorage, { recursive: true, force: true });
  process.exit(1);
});

/**
 * A costura do andar 2: extrai `motivoDeRecusaDeStatus` + `executarConsultaStatus` +
 * `consultarStatus` de lib/abas.js — MESMA técnica de testes/gate-envio-skill-codex.js —
 * e roda num `vm` com `tmux`/`buscar`/`espera` dublados. `enfileirarPorAba` entra REAL (é
 * só seis linhas) para provar que a fila de verdade serializa duas consultas na mesma aba.
 */
async function testeOrquestracao() {
  const fonte = fs.readFileSync(path.join(__dirname, '../lib/abas.js'), 'utf8');
  const inicio = fonte.indexOf('const TEMPO_MAX_CONSULTA_STATUS_MS');
  const fim = fonte.indexOf('\n/**\n * Quanto da assinatura OPENAI', inicio);
  const filaInicio = fonte.indexOf('function enfileirarPorAba(');
  const filaFim = fonte.indexOf('\n}\n', filaInicio) + 2;
  const codigo = fonte.slice(inicio, fim) + '\n' + fonte.slice(filaInicio, filaFim);
  const statusReal = require('../lib/status-codex');
  const sessao = '01a08228-aa4c-7be1-bc86-f6c698933c7d';
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/status-codex/0.153.4-status.txt'), 'utf8');
  const resposta = '/status\n' + statusReal.extrairBlocoStatus(fixture, sessao).texto + '\n';
  const vazio = '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m';
  let seq = 0;
  function criar(op = {}) {
    let tempo = Date.now();
    let aba = { chave:'aba-7', agente:'codex', temAgente:true, esperando:false,
      sessaoId:sessao, arquivo:'/fixture/rollout.jsonl', pane:'%7', rodando:false, casamento:'ok', ...op.aba };
    let fase = 'vazio'; let saida = op.anterior || ''; let n = 0;
    const chamadas=[]; const salvos=new Map();
    const contexto={
      filasPorAba:new Map(), idValido:id=>/^[\w-]{1,64}$/.test(id),
      erro:(codigo,mensagem)=>Object.assign(new Error(mensagem),{codigo}),
      Date: class extends Date { static now(){return tempo;} },
      espera:async ms=>{tempo+=ms;}, comSocket:a=>['-L','fixture',...a],
      buscar:async()=>aba,
      statusCodex:{...statusReal,
        snapshotsDe:async()=>[...salvos.values()],
        registrarSnapshot:async(s, r)=>{if(op.storageFalha)throw new Error('disco indisponível');const snapshot={...r,sessaoId:s};salvos.set(r.id,snapshot);return {snapshot};}},
      execFile:(bin,args,opts,cb)=>{
        assert.equal(bin,'tmux');assert.equal(args[0],'-L');assert.equal(args[1],'fixture');
        assert.ok(opts.timeout<=1000 && opts.maxBuffer<=262144);
        const a=args.slice(2);chamadas.push(a);
        if(op.tmuxFalha)return cb(Object.assign(new Error('falha'),{killed:op.tmuxFalha==='timeout'}));
        if(a[0]==='send-keys') {
          assert.equal(a[2],'%7');
          if(a.at(-1)==='Enter') {fase='resposta';if(!op.stale)saida+=resposta;if(op.mudarDepois)aba={...aba,...op.mudarDepois};}
          else {assert.equal(a.at(-1),'/status');fase='digitado';}
          return cb(null,'');
        }
        let tela;
        if(fase==='vazio')tela=saida+(op.rascunho ?? vazio);
        else if(fase==='digitado')tela=saida+(op.digitado ?? '\x1b[1m›\x1b[0m /status');
        else {n++;tela=op.parcial ? '/status\n╭──╮' : saida;
          if(op.limiteTardio && n===1)tela=tela.replace('not available for this account','loading');}
        if(op.mudarAntes && fase==='vazio')aba={...aba,...op.mudarAntes};
        cb(null,tela);
      },
    };
    vm.createContext(contexto);vm.runInContext(codigo,contexto);
    return {ctx:contexto,chamadas,salvos,run:id=>contexto.consultarStatus('aba-7',id||'req-'+(++seq))};
  }
  for(const rodando of [true,null,undefined]) {
    const c=criar({aba:{rodando}});await assert.rejects(c.run(),e=>e.codigo===409);
    assert.equal(c.chamadas.length,0);marcar(true,`estado ${rodando} não envia teclas`);
  }
  for(const aba of [{esperando:true},{sessaoId:null,arquivo:null},{agente:'claude'},{pane:null},{casamento:'ambiguo'}]) {
    const c=criar({aba});await assert.rejects(c.run(),e=>e.codigo===409);assert.equal(c.chamadas.length,0);
  }
  for(const rascunho of ['› texto','›\n  texto em outra linha','› Ask Codex to do anything','texto com ›']) {
    const c=criar({rascunho});await assert.rejects(c.run(),e=>e.codigo===409);
    assert.ok(!c.chamadas.some(a=>a[0]==='send-keys'));
  }
  marcar(true,'rascunho multiline, placeholder sem dim e marcador em texto recusam sem teclas');
  const alterado=criar({digitado:'› /status\n  texto extra'});
  await assert.rejects(alterado.run(),e=>e.codigo===409);
  assert.ok(!alterado.chamadas.some(a=>a.at(-1)==='Enter'));
  marcar(true,'composer alterado após digitar não recebe Enter');
  const feliz=criar({anterior:resposta,limiteTardio:true});const r=await feliz.run('id-feliz');
  assert.equal(r.sessaoId,sessao);assert.ok(r.texto.includes('not available'));
  assert.equal(feliz.chamadas.filter(a=>a[0]==='send-keys').length,2);
  assert.equal(feliz.salvos.size,1);marcar(true,'resposta nova estável persiste após um literal e um Enter na pane');
  await feliz.run('id-feliz');assert.equal(feliz.chamadas.filter(a=>a[0]==='send-keys').length,2);
  marcar(true,'repetir id usa snapshot sem tecla adicional');
  for(const op of [{anterior:resposta,stale:true},{parcial:true}]) {
    const c=criar(op);await assert.rejects(c.run(),e=>e.codigo===504);assert.equal(c.salvos.size,0);
  }
  marcar(true,'resposta velha ou parcial termina em timeout sem gravar snapshot');
  for(const mudarDepois of [{sessaoId:'outra'},{pane:'%8'},{arquivo:'/outro'},{agente:'claude'},{rodando:true}]) {
    const c=criar({mudarDepois});await assert.rejects(c.run(),e=>e.codigo===409);assert.equal(c.salvos.size,0);
  }
  const antes=criar({mudarAntes:{arquivo:'/outro'}});await assert.rejects(antes.run(),e=>e.codigo===409);
  assert.ok(!antes.chamadas.some(a=>a[0]==='send-keys'));
  marcar(true,'identidade e estado são revalidados antes das teclas e da gravação');
  for(const tmuxFalha of ['erro','timeout']) {const c=criar({tmuxFalha});await assert.rejects(c.run(),e=>e.codigo===(tmuxFalha==='timeout'?504:500));}
  const disco=criar({storageFalha:true});await assert.rejects(disco.run(),/disco/);
  marcar(true,'falha real do helper ou do storage não vira sucesso');
  const fila=criar();await Promise.all([fila.run('igual'),fila.run('igual')]);
  assert.equal(fila.chamadas.filter(a=>a[0]==='send-keys').length,2);
  const ordem=[];await Promise.all([
    fila.ctx.enfileirarPorAba('aba-7',async()=>{ordem.push('envio');await Promise.resolve();ordem.push('fim');}),
    fila.ctx.enfileirarPorAba('aba-7',()=>ordem.push('consulta')),
  ]);assert.deepEqual(ordem,['envio','fim','consulta']);
  marcar(true,'requisições simultâneas com mesmo id não duplicam Enter; fila compartilhada preserva ordem');
}

/**
 * A costura do andar 3: server.js de verdade, `lib/abas` e `lib/status-codex` DUBLADOS no
 * `require.cache` — mesmo padrão do testes/gate-troca-arquivo.js. Prova a ROTA e o SSE;
 * a lógica de captura da pane já foi provada no andar 2.
 */
async function testeRotaESse() {
  let PORTA = 0;
  const path2 = (p) => path.join(__dirname, '..', p);

  const chamadasConsultar = [];
  const respostasConsultar = new Map();   // chave -> função(id) => resultado ou throw
  const abasFalsas = new Map();

  const dubleAbas = {
    ...require(path2('lib/abas.js')),
    buscar: async (chave) => abasFalsas.get(chave) || null,
    // O relógio de estado do SSE virou UM por cano no split view (08/09) e lê `listar()`
    // uma vez, em vez de `buscar()` por aba — `abas.buscar` é `(await listar()).find(...)`
    // e N varreduras do mesmo tmux por segundo não escalam. O duble precisa das duas, da
    // MESMA fonte, senão a rota enxerga um mundo e a fila enxerga outro.
    listar: async () => [...abasFalsas.values()],
    idValido: (id) => /^[\w-]{1,64}$/.test(String(id)),
    pendentesDe: () => [],
    paraCliente: (a) => a,
    abasDoProjeto: () => [],
    consultarStatus: async (chave, id) => {
      const storage = require('../lib/status-codex');
      const salvo = (await storage.snapshotsDe(abasFalsas.get(chave)?.sessaoId)).find(s => s.id === id);
      if (salvo) return salvo;
      chamadasConsultar.push({ chave, id });
      const fn = respostasConsultar.get(chave);
      if (!fn) throw Object.assign(new Error('sem resposta configurada'), { codigo: 500 });
      const resultado = await fn(id);
      return (await storage.registrarSnapshot(resultado.sessaoId, { id, ...resultado })).snapshot;
    },
  };
  require.cache[require.resolve(path2('lib/abas.js'))] = {
    id: require.resolve(path2('lib/abas.js')), filename: require.resolve(path2('lib/abas.js')),
    loaded: true, exports: dubleAbas,
  };

  process.env.PORT = String(PORTA);
  process.env.HOST = '127.0.0.1';
  process.env.COCKPIT_CERT_DIR = '/dev/null';
  process.env.COCKPIT_TOKEN = '';
  process.env.COCKPIT_JOBS_DIR = path.join(os.tmpdir(), `cockpit-sem-jobs-${process.pid}`); // pasta nunca criada: painel de jobs desligado, não lê os jobs reais de quem roda o teste
  process.env.COCKPIT_VIGIA_MS = '0'; // sem HOME falso aqui — cinto e suspensório
  const criarServer = http.createServer;
  let servidor;
  http.createServer = (...args) => { servidor = criarServer(...args); return servidor; };
  require(path2('server.js'));
  http.createServer = criarServer;
  if (!servidor.listening) await new Promise(r => servidor.once('listening', r));
  PORTA = servidor.address().port;

  function pedir(metodo, rota, corpo) {
    return new Promise((resolve, reject) => {
      const dados = corpo === undefined ? null : JSON.stringify(corpo);
      const req = http.request({
        host: '127.0.0.1', port: PORTA, method: metodo, path: rota,
        headers: dados ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) } : {},
      }, (res) => {
        let bruto = '';
        res.on('data', (b) => { bruto += b; });
        res.on('end', () => {
          let parseado = null;
          try { parseado = bruto ? JSON.parse(bruto) : null; } catch { /* corpo não-JSON */ }
          resolve({ status: res.statusCode, corpo: parseado });
        });
      });
      req.on('error', reject);
      if (dados) req.write(dados);
      req.end();
    });
  }

  function abrirFluxo(chave, recebido) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        // O cano é UM só desde o split view (08/09): `?abas=` e envelope `{aba, evento}`.
        // `desembrulhar` tira a casca — nenhuma asserção abaixo muda, e é isso que prova
        // que a extração para `acompanharAba` não mexeu no comportamento por aba.
        { host: '127.0.0.1', port: PORTA, path: `/api/eventos?abas=${chave}`, headers: { accept: 'text/event-stream' } },
        (res) => {
          let sobra = '';
          res.setEncoding('utf8');
          res.on('data', (pedaco) => {
            sobra += pedaco;
            const partes = sobra.split('\n\n');
            sobra = partes.pop();
            for (const parte of partes) {
              const dado = parte.split('\n').find((l) => l.startsWith('data: '));
              if (dado) recebido.push(JSON.parse(dado.slice(6)).evento);
            }
          });
          resolve(req);
        },
      );
      req.on('error', reject);
    });
  }
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  // (a) 404 — aba ausente.
  marcar((await pedir('POST', '/api/abas/aba-fantasma/status', {})).status === 404, '404: aba ausente');

  abasFalsas.set('aba-1', { chave: 'aba-1', sessaoId: 'sess-1', agente: 'codex' });

  // (b) 400 — corpo com campo além de `id`.
  marcar((await pedir('POST', '/api/abas/aba-1/status', { id: 'abc', anexos: ['x'] })).status === 400,
    '400: corpo com campo além de id (anexo, comando, cwd, sessão livres)');
  // (b2) 400 — id fora do formato.
  marcar((await pedir('POST', '/api/abas/aba-1/status', { id: 'tem espaço' })).status === 400,
    '400: id de envio fora do formato');

  for (const corpo of [[], null, 42, 'texto', {id:42}, {id:null}]) {
    assert.equal((await pedir('POST','/api/abas/aba-1/status',corpo)).status,400);
  }
  marcar(true,'corpos primitivos/array e IDs não textuais recusam com 400');

  // (c) 409 — consultarStatus recusa (estado do mundo).
  respostasConsultar.set('aba-1', () => { throw Object.assign(new Error('busy'), { codigo: 409 }); });
  const r409 = await pedir('POST', '/api/abas/aba-1/status', { id: 'req-409' });
  marcar(r409.status === 409, '409: estado do mundo (busy/esperando/sem-sessão) — o próprio erro decide o texto');

  // (d) 504 — timeout.
  respostasConsultar.set('aba-1', () => { throw Object.assign(new Error('tempo esgotado'), { codigo: 504 }); });
  marcar((await pedir('POST', '/api/abas/aba-1/status', { id: 'req-504' })).status === 504, '504: timeout');

  // (e) 500 — falha de storage (sessaoId inválido faz registrarSnapshot rejeitar).
  abasFalsas.set('aba-storage-falha', { chave: 'aba-storage-falha', sessaoId: 'sessão com espaço e acento é inválida!!', agente: 'codex' });
  respostasConsultar.set('aba-storage-falha', () => ({ texto: 'Session: x', sessaoId: 'sessão com espaço e acento é inválida!!', quando: new Date().toISOString() }));
  const r500 = await pedir('POST', '/api/abas/aba-storage-falha/status', { id: 'req-500' });
  marcar(r500.status === 500, '500: falha de storage não vira sucesso — sessão inválida nunca grava');

  // (f) 200 — sucesso, com id/sessaoId/quando/texto.
  respostasConsultar.set('aba-1', () => ({ texto: 'Session: sess-1\nToken usage: 0', sessaoId: 'sess-1', quando: '2026-09-08T12:00:00.000Z' }));
  const r200 = await pedir('POST', '/api/abas/aba-1/status', { id: 'req-200' });
  marcar(r200.status === 200 && r200.corpo.id === 'req-200' && r200.corpo.sessaoId === 'sess-1'
    && r200.corpo.texto.includes('Session: sess-1') && r200.corpo.quando === '2026-09-08T12:00:00.000Z',
  '200: id/sessaoId/quando/texto no corpo');

  // (g) id repetido: 200 SEM chamar consultarStatus de novo (idempotência na rota).
  const chamadasAntes = chamadasConsultar.filter((c) => c.chave === 'aba-1').length;
  const rRepetido = await pedir('POST', '/api/abas/aba-1/status', { id: 'req-200' });
  marcar(rRepetido.status === 200 && rRepetido.corpo.texto.includes('Session: sess-1'),
    'id repetido devolve o mesmo resultado, 200');
  marcar(chamadasConsultar.filter((c) => c.chave === 'aba-1').length === chamadasAntes,
    'e NÃO chama consultarStatus de novo — nenhuma tecla nova na pane');

  // (h) id omitido: o servidor gera um, e funciona.
  const rSemId = await pedir('POST', '/api/abas/aba-1/status', {});
  marcar(rSemId.status === 200 && typeof rSemId.corpo.id === 'string' && rSemId.corpo.id.length > 0,
    'id omitido: o servidor gera um id válido sozinho');

  respostasConsultar.set('aba-1', () => {
    abasFalsas.set('aba-1', {...abasFalsas.get('aba-1'),sessaoId:'sess-trocada'});
    return {texto:'velho',sessaoId:'sess-1',quando:'2026-09-08T12:00:00Z'};
  });
  assert.equal((await pedir('POST','/api/abas/aba-1/status',{id:'troca-final'})).status,409);
  marcar(true,'rota recusa identidade que mudou antes de publicar resposta');

  let barramentoStatus;
  const emitter = require('node:events').EventEmitter.prototype;
  const onOriginal = emitter.on;
  emitter.on = function(nome, fn) { if(nome === 'status_codex') barramentoStatus = this; return onOriginal.call(this,nome,fn); };

  // ── SSE: replay, dedupe, escopo por sessão, listener morre no close ──
  abasFalsas.set('aba-sse', { chave: 'aba-sse', sessaoId: 'sess-sse', agente: 'codex', cwd: '/x', titulo: 'sse' });
  respostasConsultar.set('aba-sse', () => ({ texto: 'Session: sess-sse\nToken usage: 1', sessaoId: 'sess-sse', quando: '2026-09-08T12:30:00.000Z' }));
  await pedir('POST', '/api/abas/aba-sse/status', { id: 'sse-salvo-antes' });   // já persistido ANTES do fluxo abrir

  const recebidoA = [];
  const reqA = await abrirFluxo('aba-sse', recebidoA);
  await espera(500);
  marcar(recebidoA.some((e) => e.tipo === 'status_codex' && e.id === 'sse-salvo-antes'),
    'abrir o fluxo faz REPLAY dos snapshots já salvos daquela sessão');

  const corteVivo = recebidoA.length;
  await pedir('POST', '/api/abas/aba-sse/status', { id: 'sse-ao-vivo' });
  await espera(300);
  marcar(recebidoA.slice(corteVivo).some((e) => e.tipo === 'status_codex' && e.id === 'sse-ao-vivo'),
    'e resultado NOVO chega AO VIVO no mesmo fluxo, sem precisar reabrir');

  // Escopo por sessão: outra aba com OUTRA sessão não recebe o evento.
  abasFalsas.set('aba-outra-sessao', { chave: 'aba-outra-sessao', sessaoId: 'sess-diferente', agente: 'codex', cwd: '/y', titulo: 'outra' });
  const recebidoB = [];
  const reqB = await abrirFluxo('aba-outra-sessao', recebidoB);
  await espera(300);
  const corteB = recebidoB.length;
  await pedir('POST', '/api/abas/aba-sse/status', { id: 'sse-nao-deve-vazar' });
  await espera(300);
  marcar(!recebidoB.slice(corteB).some((e) => e.tipo === 'status_codex'),
    'aba de OUTRA sessão nunca recebe o status_codex desta — escopo por sessão, não por aba');

  await require('../lib/status-codex').registrarSnapshot('sess-sse-nova', {id:'apos-clear',texto:'STATUS NOVO',quando:'2026-09-08T12:00:00Z'});
  abasFalsas.set('aba-sse', {...abasFalsas.get('aba-sse'),sessaoId:'sess-sse-nova',arquivo:'/dev/null'});
  const corteTroca = recebidoA.length;
  await espera(2300);
  assert.ok(recebidoA.slice(corteTroca).some(e => e.tipo==='sessao' && e.meta.sessaoId==='sess-sse-nova'));
  assert.ok(recebidoA.slice(corteTroca).some(e => e.tipo==='status_codex' && e.id==='apos-clear'));
  marcar(true,'troca de arquivo atualiza identidade e faz replay da sessão nova no mesmo SSE');

  reqA.destroy();
  reqB.destroy();
  await espera(200);

  assert.equal(barramentoStatus.listenerCount('status_codex'),0);
  const storage = require('../lib/status-codex');
  const lerOriginal = storage.snapshotsDe;
  let liberar; let entrou=false;
  const trava = new Promise(r => {liberar=r;});
  storage.snapshotsDe = async sessao => { if(sessao==='sess-fechar'){entrou=true;await trava;} return lerOriginal(sessao); };
  abasFalsas.set('aba-fechar',{chave:'aba-fechar',sessaoId:'sess-fechar',agente:'codex',cwd:'/fixture',titulo:'fechar'});
  const reqFechar = await abrirFluxo('aba-fechar',[]);
  while(!entrou) await espera(5);
  reqFechar.destroy(); await espera(50);
  assert.equal(barramentoStatus.listenerCount('status_codex'),0);
  liberar(); await espera(50);
  assert.equal(barramentoStatus.listenerCount('status_codex'),0);
  storage.snapshotsDe = lerOriginal;
  emitter.on = onOriginal;
  marcar(true,'close durante replay pendente remove listener e não o recria após await');

  // Listener morre no close: um novo POST depois de fechar não deve mais alimentar o
  // fluxo antigo (indireto — provado por não estourar e por não crescer `recebidoA`).
  const tamanhoFinal = recebidoA.length;
  await pedir('POST', '/api/abas/aba-sse/status', { id: 'sse-depois-do-close' });
  await espera(300);
  marcar(recebidoA.length === tamanhoFinal, 'depois do close, o fluxo antigo não recebe mais nada (sem vazamento de listener)');
}
