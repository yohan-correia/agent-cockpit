#!/usr/bin/env node
'use strict';
// GATE do cartão vivo do sub-agente (card ver-os-subagentes-da-aba, D86).
//
// Spec: docs/superpowers/specs/2026-10-16-ver-os-subagentes-da-aba-design.md (§4).
//
//   node testes/gate-subagente.js          roda TUDO (parte pura + rota)
//   node testes/gate-subagente.js puro     só a parte pura (sem servidor, sem porta)
//
// Parte PURA — Node puro, sem servidor, sem porta: os dois dados novos de `eventosDoObjeto`
// (agente em `resultado_ferramenta`, o evento `tarefa_fim`) e o leitor `lib/subagente.js` (os
// passos de UM sub-agente). HOME falso ANTES de qualquer `require` de `lib/` — `RAIZ_PROJETOS`
// de `lib/externo.js` é calculado na carga do módulo.
//
// Parte ROTA — `GET /api/subagente`, molde do arreio de `testes/gate-segundo-plano.js`: tmux
// REAL em socket isolado, `/proc` falso via `COCKPIT_PROC_RAIZ`, `server.js` filho numa porta
// própria. Nasceu VERMELHO: a rota não existe.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); return Boolean(c); };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Inventário dos casos — o rodapé de cada parte confere que NENHUM ficou de fora (um `return`
// esquecido ou uma exceção engolida não pode passar por "verde" só porque nada rodou).
const CASOS = new Set();
const titulo = (t) => { CASOS.add(t); console.log(`\n${t}`); };
function conferirInventario(esperados) {
  const faltaram = esperados.filter((c) => !CASOS.has(c));
  if (faltaram.length) console.log(`❌ casos que NÃO rodaram: ${faltaram.join(', ')}`);
  return faltaram;
}

// ─── HOME falso, ANTES de qualquer require de lib/ (RAIZ_PROJETOS de lib/externo.js:24 é
// calculado na carga do módulo) ───────────────────────────────────────────────────────────────
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-subagente-'));
process.env.HOME = HOME;

const externo = require('../lib/externo');
// lib/subagente.js ainda não existe nas fases iniciais do plano — require defensivo: as
// asserções de SA-S* reportam vermelho uma a uma, em vez de explodir o script inteiro e
// escond. os casos SA-P* que já valem.
let subagente = null;
try { subagente = require('../lib/subagente'); } catch { /* ainda não existe — ver SA-S* */ }

function escreverJsonl(caminho, objetos) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, objetos.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

// A fixture do cabeçalho do plano, ao pé da letra.
const linha = (o) => JSON.stringify(o);
const notif = ({ tarefa, ferramenta, status = 'completed' }) =>
  `<task-notification>\n<task-id>${tarefa}</task-id>\n${ferramenta ? `<tool-use-id>${ferramenta}</tool-use-id>\n` : ''}` +
  `<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>Agent "teste" completed</summary>\n</task-notification>`;

// ═══════════════════════════════════════════════════════════════════════════════════════════
// PARTE PURA
// ═══════════════════════════════════════════════════════════════════════════════════════════

async function parteP() {
  console.log('\n── eventosDoObjeto / idDeAgenteValido (SA-P1..P17) ──');
  let tudoOk = true;
  const T = Date.parse('2026-10-16T10:00:00.000Z');
  const iso = (ms) => new Date(T + ms).toISOString();

  titulo('SA-P1');
  {
    const obj = {
      type: 'user', timestamp: iso(0),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'saida' }] },
      toolUseResult: { status: 'completed', agentId: 'a1b2c3', totalDurationMs: 65000 },
    };
    const ev = externo.eventosDoObjeto(obj);
    tudoOk = ok(ev.length === 1 && ev[0].tipo === 'resultado_ferramenta', 'SA-P1: 1 evento resultado_ferramenta') && tudoOk;
    const agente = ev[0] && ev[0].agente;
    tudoOk = ok(Boolean(agente) && agente.id === 'a1b2c3' && agente.fundo === false && agente.duracaoMs === 65000,
      `SA-P1: agente = {id:'a1b2c3', fundo:false, duracaoMs:65000} (achado ${JSON.stringify(agente)})`) && tudoOk;
  }

  titulo('SA-P2');
  {
    const obj = {
      type: 'user', timestamp: iso(1000),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'ok' }] },
      toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'a9f' },
    };
    const ev = externo.eventosDoObjeto(obj);
    const agente = ev[0] && ev[0].agente;
    tudoOk = ok(Boolean(agente) && agente.id === 'a9f' && agente.fundo === true && !('duracaoMs' in agente),
      `SA-P2: agente = {id:'a9f', fundo:true} sem duracaoMs (achado ${JSON.stringify(agente)})`) && tudoOk;
  }

  titulo('SA-P3');
  {
    const obj = {
      type: 'user', timestamp: iso(2000),
      message: { content: [
        { type: 'tool_result', tool_use_id: 'tu-3a', content: 'a' },
        { type: 'tool_result', tool_use_id: 'tu-3b', content: 'b' },
      ] },
      toolUseResult: { status: 'completed', agentId: 'a3' },
    };
    const ev = externo.eventosDoObjeto(obj);
    tudoOk = ok(ev.length === 2 && ev.every((e) => !('agente' in e)),
      `SA-P3: 2 tool_result na mesma linha — nenhum evento tem agente (achado ${JSON.stringify(ev)})`) && tudoOk;
  }

  titulo('SA-P4');
  {
    const obj = {
      type: 'user', timestamp: iso(3000),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-4', content: 'x' }] },
      toolUseResult: { status: 'completed', agentId: 'a/b' },
    };
    const ev = externo.eventosDoObjeto(obj);
    tudoOk = ok(Boolean(ev[0]) && !('agente' in ev[0]), `SA-P4: agentId inválido ("a/b") — sem agente (achado ${JSON.stringify(ev[0])})`) && tudoOk;
  }

  titulo('SA-P5');
  {
    const semStatus = externo.eventosDoObjeto({
      type: 'user', timestamp: iso(4000),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-5a', content: 'x' }] },
      toolUseResult: { agentId: 'a5a' },
    });
    const statusRodando = externo.eventosDoObjeto({
      type: 'user', timestamp: iso(4100),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-5b', content: 'x' }] },
      toolUseResult: { agentId: 'a5b', status: 'running' },
    });
    tudoOk = ok(Boolean(semStatus[0]) && !('agente' in semStatus[0]) && Boolean(statusRodando[0]) && !('agente' in statusRodando[0]),
      'SA-P5: status ausente ou desconhecido — sem agente nos dois') && tudoOk;
  }

  titulo('SA-P6');
  {
    const t = iso(5000);
    const obj = { type: 'queue-operation', operation: 'enqueue', content: notif({ tarefa: 'a1', ferramenta: 'tu-9' }), timestamp: t, sessionId: 'x' };
    const ev = externo.eventosDoObjeto(obj);
    tudoOk = ok(ev.length === 1 && ev[0].tipo === 'tarefa_fim' && ev[0].tarefa === 'a1' && ev[0].id === 'tu-9'
      && ev[0].status === 'completed' && ev[0].t === t,
      `SA-P6: [{tipo:'tarefa_fim',tarefa:'a1',id:'tu-9',status:'completed',t}] (achado ${JSON.stringify(ev)})`) && tudoOk;
    tudoOk = ok(Boolean(ev[0]) && !('quando' in ev[0]), 'SA-P6: o evento tarefa_fim não tem quando') && tudoOk;
  }

  titulo('SA-P7');
  {
    const notifTxt = notif({ tarefa: 'a1', ferramenta: 'tu-9' });
    const semReason = externo.eventosDoObjeto({ type: 'queue-operation', operation: 'remove', content: notifTxt, timestamp: iso(5100) });
    const comReason = externo.eventosDoObjeto({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', content: notifTxt, timestamp: iso(5200) });
    tudoOk = ok(semReason.length === 0 && comReason.length === 0, 'SA-P7: remove (com e sem absorbed_mid_turn) não emite — duplicata do enqueue') && tudoOk;
  }

  titulo('SA-P8');
  {
    const ev = externo.eventosDoObjeto({
      type: 'attachment', timestamp: iso(5300),
      attachment: { type: 'queued_command', prompt: notif({ tarefa: 'a1' }) },
    });
    tudoOk = ok(ev.length === 0, 'SA-P8: attachment/queued_command não emite — duplicata do enqueue') && tudoOk;
  }

  titulo('SA-P9');
  {
    const ev = externo.eventosDoObjeto({
      type: 'user', timestamp: iso(5400), origin: { kind: 'task-notification' },
      message: { content: notif({ tarefa: 'a2' }) },
    });
    tudoOk = ok(ev.length === 1 && ev[0].tipo === 'tarefa_fim' && ev[0].tarefa === 'a2' && ev[0].id === null,
      `SA-P9: só [{tipo:'tarefa_fim', tarefa:'a2', id:null, …}] (achado ${JSON.stringify(ev)})`) && tudoOk;
    tudoOk = ok(!ev.some((e) => e.tipo === 'humano'), 'SA-P9: nenhum humano') && tudoOk;
  }

  titulo('SA-P10');
  {
    const ev = externo.eventosDoObjeto({ type: 'user', timestamp: iso(5500), message: { content: notif({ tarefa: 'a3' }) } });
    tudoOk = ok(ev.length === 1 && ev[0].tipo === 'humano', `SA-P10: sem origin — o dono colou o XML, vira humano (achado ${JSON.stringify(ev)})`) && tudoOk;
  }

  titulo('SA-P11');
  {
    const texto = 'o que é <task-notification> no jsonl?';
    const ev = externo.eventosDoObjeto({ type: 'user', timestamp: iso(5600), origin: { kind: 'task-notification' }, message: { content: texto } });
    tudoOk = ok(ev.length === 1 && ev[0].tipo === 'humano', `SA-P11: citação da tag no meio da frase continua humano (achado ${JSON.stringify(ev)})`) && tudoOk;
  }

  titulo('SA-P12');
  {
    const ev = externo.eventosDoObjeto({ type: 'queue-operation', operation: 'enqueue', content: 'veja <task-id>a1</task-id> aqui', timestamp: iso(5700) });
    tudoOk = ok(ev.length === 0, 'SA-P12: task-id citado no meio de uma frase não emite') && tudoOk;
  }

  titulo('SA-P13');
  {
    const outroEnvelope = '<agent-message from="a1">oi</agent-message>';
    const ev = externo.eventosDoObjeto({ type: 'queue-operation', operation: 'enqueue', content: outroEnvelope, timestamp: iso(5800) });
    tudoOk = ok(ev.length === 0, 'SA-P13: envelope de outra tag não emite') && tudoOk;
  }

  titulo('SA-P14');
  {
    const semTaskId = '<task-notification>\n<status>completed</status>\n<summary>Agent "teste" completed</summary>\n</task-notification>';
    const ev = externo.eventosDoObjeto({ type: 'queue-operation', operation: 'enqueue', content: semTaskId, timestamp: iso(5900) });
    tudoOk = ok(ev.length === 0, 'SA-P14: notificação sem task-id não emite') && tudoOk;
  }

  titulo('SA-P15');
  {
    const falhou = externo.eventosDoObjeto({ type: 'queue-operation', operation: 'enqueue', content: notif({ tarefa: 'a4', status: 'failed' }), timestamp: iso(6000) });
    const morto = externo.eventosDoObjeto({ type: 'queue-operation', operation: 'enqueue', content: notif({ tarefa: 'a5', status: 'killed' }), timestamp: iso(6100) });
    tudoOk = ok(falhou[0]?.status === 'failed' && morto[0]?.status === 'killed',
      `SA-P15: status failed/killed refletido no tarefa_fim (achados ${falhou[0]?.status}, ${morto[0]?.status})`) && tudoOk;
  }

  titulo('SA-P16');
  {
    const sessao = 's1';
    const cwd = '/tmp/x';
    const arq = path.join(HOME, '.claude', 'projects', '-tmp-x', `${sessao}.jsonl`);
    escreverJsonl(arq, [
      { type: 'user', timestamp: iso(7000), message: { content: 'fala do dono fora do cockpit' } },
      { type: 'user', timestamp: iso(7100), origin: { kind: 'task-notification' }, message: { content: notif({ tarefa: 'a9' }) } },
      { type: 'assistant', timestamp: iso(7200), message: { content: [{ type: 'text', text: 'resposta depois da notificação' }] } },
    ]);
    const blocos = await externo.trocasDeFora(sessao, cwd, []);
    const temNotifComoHumano = blocos.some((b) => b.eventos.some((e) => e.tipo === 'humano' && String(e.texto).includes('<task-notification>')));
    tudoOk = ok(!temNotifComoHumano, 'SA-P16: trocasDeFora não trata a notificação de tarefa como bolha humano') && tudoOk;
  }

  titulo('SA-P17');
  {
    if (typeof externo.idDeAgenteValido !== 'function') {
      tudoOk = ok(false, 'SA-P17: idDeAgenteValido existe em lib/externo.js (exportada)') && tudoOk;
    } else {
      const casos = [
        ['a1b2', true], ['toolu_01AbC-x', true], ['', false], ['a'.repeat(101), false],
        ['../x', false], ['a/b', false], [undefined, false], [123, false],
      ];
      let bate = true;
      const achados = [];
      for (const [valor, esperado] of casos) {
        const achado = externo.idDeAgenteValido(valor);
        achados.push(achado);
        if (Boolean(achado) !== esperado) bate = false;
      }
      tudoOk = ok(bate, `SA-P17: idDeAgenteValido nos 8 casos (achados ${JSON.stringify(achados)})`) && tudoOk;
    }
  }

  const faltaram = conferirInventario(['SA-P1', 'SA-P2', 'SA-P3', 'SA-P4', 'SA-P5', 'SA-P6', 'SA-P7', 'SA-P8', 'SA-P9', 'SA-P10',
    'SA-P11', 'SA-P12', 'SA-P13', 'SA-P14', 'SA-P15', 'SA-P16', 'SA-P17']);
  return tudoOk && faltaram.length === 0;
}

async function parteS() {
  console.log('\n── lib/subagente.js (SA-S1..S12) ──');
  let tudoOk = true;
  const T = Date.parse('2026-10-16T11:00:00.000Z');
  const iso = (ms) => new Date(T + ms).toISOString();

  if (!subagente) {
    for (const id of ['SA-S1', 'SA-S2', 'SA-S3', 'SA-S4', 'SA-S5', 'SA-S6', 'SA-S7', 'SA-S8', 'SA-S9', 'SA-S10', 'SA-S11', 'SA-S12']) {
      titulo(id);
      tudoOk = ok(false, `${id}: lib/subagente.js ainda não existe`) && tudoOk;
    }
    return tudoOk;
  }

  const convArq = path.join(HOME, '.claude', 'projects', '-tmp-x', 's1.jsonl');
  const pastaSub = path.join(HOME, '.claude', 'projects', '-tmp-x', 's1', 'subagents');
  fs.mkdirSync(pastaSub, { recursive: true });

  titulo('SA-S1');
  {
    fs.writeFileSync(path.join(pastaSub, 'agent-a1.jsonl'), '');
    fs.writeFileSync(path.join(pastaSub, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'tu-1' }));
    const achado = await subagente.acharArquivo(convArq, { ferramenta: 'tu-1' });
    tudoOk = ok(achado === path.join(pastaSub, 'agent-a1.jsonl'), `SA-S1: acha o arquivo pelo toolUseId do meta (achado ${achado})`) && tudoOk;
  }

  titulo('SA-S2');
  {
    const achado = await subagente.acharArquivo(convArq, { ferramenta: 'tu-x', id: 'a1' });
    tudoOk = ok(achado === path.join(pastaSub, 'agent-a1.jsonl'), `SA-S2: acha pelo id, mesmo com ferramenta errada (achado ${achado})`) && tudoOk;
  }

  titulo('SA-S3');
  {
    fs.writeFileSync(path.join(pastaSub, 'agent-a2.jsonl'), '');
    fs.writeFileSync(path.join(pastaSub, 'agent-a2.meta.json'), '{ isto não é json');
    fs.writeFileSync(path.join(pastaSub, 'agent-a3.jsonl'), '');
    fs.writeFileSync(path.join(pastaSub, 'agent-a3.meta.json'), JSON.stringify({ toolUseId: 'tu-3' }));
    let explodiu = false;
    let achado = null;
    try { achado = await subagente.acharArquivo(convArq, { ferramenta: 'tu-3' }); } catch { explodiu = true; }
    tudoOk = ok(!explodiu && achado === path.join(pastaSub, 'agent-a3.jsonl'),
      `SA-S3: pula o meta ilegível e acha o bom, sem lançar (achado ${achado}, explodiu=${explodiu})`) && tudoOk;
  }

  titulo('SA-S4');
  {
    const a = await subagente.acharArquivo(convArq, { ferramenta: '../x' });
    const b = await subagente.acharArquivo(convArq, { ferramenta: 'tu-1', id: '../a1' });
    const c = await subagente.acharArquivo(convArq, { ferramenta: 'a/b' });
    tudoOk = ok(a === null && b === null && c === null,
      `SA-S4: ferramenta/id inválido → null, sem abrir nada fora da pasta (achados ${a}, ${b}, ${c})`) && tudoOk;
  }

  titulo('SA-S5');
  {
    const achado = await subagente.acharArquivo(convArq, { ferramenta: 'tu-nao-existe' });
    tudoOk = ok(achado === null, 'SA-S5: ferramenta que não existe → null') && tudoOk;
  }

  titulo('SA-S6');
  {
    const arqS6 = path.join(pastaSub, 'agent-s6.jsonl');
    escreverJsonl(arqS6, [
      { type: 'user', timestamp: iso(0), message: { content: 'investiga isso' } },
      { type: 'assistant', timestamp: iso(100), message: { content: [{ type: 'tool_use', id: 'p1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', timestamp: iso(200), message: { content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'ok' }] } },
      { type: 'assistant', timestamp: iso(300), message: { content: [{ type: 'tool_use', id: 'p2', name: 'Read', input: { file_path: '/tmp/f.txt' } }] } },
      { type: 'user', timestamp: iso(400), message: { content: [{ type: 'tool_result', tool_use_id: 'p2', is_error: true, content: 'falhou' }] } },
      { type: 'assistant', timestamp: iso(500), message: { content: [{ type: 'tool_use', id: 'p3', name: 'Write', input: { file_path: '/tmp/secreto.txt', content: 'SEGREDO' } }] } },
      { type: 'assistant', timestamp: iso(600), message: { content: [{ type: 'text', text: 'Investigação concluída.' }], stop_reason: 'end_turn' } },
    ]);
    const r = await subagente.lerSubagente(arqS6);
    tudoOk = ok(Boolean(r) && r.passos.length === 3, `SA-S6: passos.length === 3 (achado ${r && r.passos.length})`) && tudoOk;
    const estados = r ? r.passos.map((p) => p.estado).join(',') : '';
    tudoOk = ok(estados === 'feita,erro,rodando', `SA-S6: estados feita/erro/rodando (achado ${estados})`) && tudoOk;
    tudoOk = ok(Boolean(r) && r.total === 3, `SA-S6: total === 3 (achado ${r && r.total})`) && tudoOk;
    tudoOk = ok(Boolean(r) && JSON.stringify(r.tipos) === JSON.stringify([['Bash', 1], ['Read', 1], ['Write', 1]]),
      `SA-S6: tipos = [['Bash',1],['Read',1],['Write',1]] (achado ${r && JSON.stringify(r.tipos)})`) && tudoOk;
    tudoOk = ok(Boolean(r) && r.resposta === 'Investigação concluída.', `SA-S6: resposta = texto final (achado ${r && r.resposta})`) && tudoOk;
    tudoOk = ok(Boolean(r) && r.terminou === true, 'SA-S6: terminou === true') && tudoOk;
    tudoOk = ok(!JSON.stringify(r).includes('SEGREDO'), 'SA-S6: JSON.stringify(resultado) não contém SEGREDO (nunca o content de um Write)') && tudoOk;
  }

  titulo('SA-S7');
  let r7 = null;
  {
    const linhasS7 = [];
    for (let i = 0; i < 250; i += 1) {
      linhasS7.push({ type: 'assistant', timestamp: iso(1000 + i), message: { content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: `echo ${i}` } }] } });
    }
    linhasS7.push({ type: 'assistant', timestamp: iso(1300), message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/x' } }] } });
    const arqS7 = path.join(pastaSub, 'agent-s7.jsonl');
    escreverJsonl(arqS7, linhasS7);
    r7 = await subagente.lerSubagente(arqS7);
    tudoOk = ok(Boolean(r7) && r7.passos.length === 200, `SA-S7: passos.length === 200 (TETO_PASSOS, achado ${r7 && r7.passos.length})`) && tudoOk;
    tudoOk = ok(Boolean(r7) && r7.total === 251, `SA-S7: total === 251 (achado ${r7 && r7.total})`) && tudoOk;
    tudoOk = ok(Boolean(r7) && JSON.stringify(r7.tipos) === JSON.stringify([['Bash', 250], ['Read', 1]]),
      `SA-S7: tipos = [['Bash',250],['Read',1]] (achado ${r7 && JSON.stringify(r7.tipos)})`) && tudoOk;
  }

  titulo('SA-S8');
  {
    tudoOk = ok(Boolean(r7) && r7.terminou === false, 'SA-S8: última linha assistant com tool_use → terminou === false') && tudoOk;
  }

  titulo('SA-S9');
  {
    const textoGrande = 'x'.repeat(25000);
    const arqS9 = path.join(pastaSub, 'agent-s9.jsonl');
    escreverJsonl(arqS9, [
      { type: 'assistant', timestamp: iso(1400), message: { content: [{ type: 'text', text: textoGrande }], stop_reason: 'end_turn' } },
    ]);
    const r9 = await subagente.lerSubagente(arqS9);
    tudoOk = ok(Boolean(r9) && r9.resposta && r9.resposta.length === 20000,
      `SA-S9: resposta.length === 20000 (TETO_RESPOSTA, achado ${r9 && r9.resposta && r9.resposta.length})`) && tudoOk;
    tudoOk = ok(Boolean(r9) && r9.respostaCortada === true, 'SA-S9: respostaCortada === true') && tudoOk;
  }

  titulo('SA-S10');
  {
    const r10 = await subagente.lerSubagente(path.join(pastaSub, 'agent-nao-existe.jsonl'));
    tudoOk = ok(r10 === null, 'SA-S10: arquivo inexistente → null') && tudoOk;
  }

  titulo('SA-S11');
  {
    const arquivoComoPai = path.join(pastaSub, 'nao-e-pasta');
    fs.writeFileSync(arquivoComoPai, 'x');
    const rEnotdir = await subagente.lerSubagente(path.join(arquivoComoPai, 'sub.jsonl'));
    tudoOk = ok(rEnotdir === null, 'SA-S11: ENOTDIR (o PAI do caminho é um arquivo) → null') && tudoOk;

    if (process.getuid && process.getuid() === 0) {
      tudoOk = ok(true, 'SA-S11: EACCES pulado — rodando como root') && tudoOk;
    } else {
      const pastaTrancada = path.join(pastaSub, 'trancada');
      fs.mkdirSync(pastaTrancada, { recursive: true });
      const arqTrancado = path.join(pastaTrancada, 'agent-x.jsonl');
      fs.writeFileSync(arqTrancado, '');
      fs.chmodSync(pastaTrancada, 0o000);
      let rejeitou = false;
      try {
        await subagente.lerSubagente(arqTrancado);
      } catch {
        rejeitou = true;
      } finally {
        fs.chmodSync(pastaTrancada, 0o700);
      }
      tudoOk = ok(rejeitou, 'SA-S11: EACCES (pasta trancada) rejeita — lança, não vira null') && tudoOk;
    }
  }

  titulo('SA-S12');
  {
    const comandoGrande = 'c'.repeat(1000);
    const arqS12 = path.join(pastaSub, 'agent-s12.jsonl');
    escreverJsonl(arqS12, [
      { type: 'assistant', timestamp: iso(1500), message: { content: [{ type: 'tool_use', id: 'g1', name: 'Bash', input: { command: comandoGrande } }] } },
    ]);
    const r12 = await subagente.lerSubagente(arqS12);
    const entrada = r12 && r12.passos[0] && r12.passos[0].entrada;
    tudoOk = ok(Boolean(entrada) && entrada.command && entrada.command.length === 300,
      `SA-S12: entrada.command.length === 300 (TETO_CAMPO, achado ${entrada && entrada.command && entrada.command.length})`) && tudoOk;
  }

  // Painel de EXECUÇÃO (16/10, Claude): conversa SEM pasta `subagents/` (a aba nunca lançou sub-agente) → null,
  // nunca exceção — é o caminho de "aba sem sub-agentes" da rota.
  titulo('SA-S13');
  {
    const conversaSemSub = path.join(HOME, '.claude', 'projects', '-tmp-x', 'sem-sub.jsonl');
    fs.writeFileSync(conversaSemSub, '');
    let r13;
    let lancou = false;
    try { r13 = await subagente.acharArquivo(conversaSemSub, { ferramenta: 'tu-1' }); } catch { lancou = true; }
    tudoOk = ok(!lancou && r13 === null, `SA-S13: conversa sem pasta subagents/ → null, sem exceção (${lancou ? 'lançou' : r13})`) && tudoOk;
  }

  const faltaram = conferirInventario(['SA-S1', 'SA-S2', 'SA-S3', 'SA-S4', 'SA-S5', 'SA-S6', 'SA-S7', 'SA-S8', 'SA-S9', 'SA-S10', 'SA-S11', 'SA-S12', 'SA-S13']);
  return tudoOk && faltaram.length === 0;
}

async function parteUmPuro() {
  CASOS.clear();
  const okP = await parteP();
  const okS = await parteS();
  return okP && okS;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// PARTE ROTA — `GET /api/subagente`, molde do arreio de testes/gate-segundo-plano.js
// (linhas 1-140: socket tmux isolado, /proc falso, ~/.claude/sessions, limpar() fail-closed).
// ═══════════════════════════════════════════════════════════════════════════════════════════

async function parteRota() {
  console.log('\n── GET /api/subagente (SA-R1..R8) ──');
  CASOS.clear();

  const herdado = process.env.COCKPIT_TMUX_SOCKET || '';
  if (herdado && !/^cockpit-(smoke|offline)-/.test(herdado)) {
    console.error(`🔴 COCKPIT_TMUX_SOCKET herdado é "${herdado}" — abortando antes de tocar em nada.`);
    return false;
  }

  const SOCKET = `cockpit-smoke-subagente-${process.pid}`;
  const SESSAO = 'main';
  const JANELA = 'sa-rota';
  const SESSAO_ID = 'sa-rota';
  const CARIMBO = `dono-${process.pid}-${process.hrtime.bigint().toString(36)}`;
  const MINHAS_SESSOES = new Set(['ancora', SESSAO]);
  const PORTA = Number(process.env.PORT_SUBAGENTE || 7966);

  const t = (args, { tolerante = false } = {}) => {
    try {
      return execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (tolerante) return '';
      throw e;
    }
  };
  if (t(['ls'], { tolerante: true }).trim()) {
    console.error(`🔴 o socket ${SOCKET} já existe — não é meu. Abortando.`);
    return false;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-subagente-rota-'));
  const home = path.join(scratch, 'home');
  const raizProc = path.join(scratch, 'proc');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(raizProc, { recursive: true });

  let servidor = null;
  function limpar() {
    if (servidor && !servidor.killed) servidor.kill('SIGTERM');
    // Fail-closed (D35): o carimbo prova que EU criei o socket; a enumeração prova que não há
    // mais ninguém nele. Matar exige as duas respostas.
    const temCarimbo = t(['list-windows', '-a', '-F', '#{window_name}'], { tolerante: true })
      .split('\n').some((n) => n.trim() === CARIMBO);
    const sessoesAgora = t(['list-sessions', '-F', '#{session_name}'], { tolerante: true })
      .split('\n').map((n) => n.trim()).filter(Boolean);
    const intrusas = sessoesAgora.filter((n) => !MINHAS_SESSOES.has(n));
    let limpo = true;
    if (temCarimbo && !intrusas.length) {
      t(['kill-server'], { tolerante: true });
    } else if (temCarimbo) {
      for (const nome of MINHAS_SESSOES) t(['kill-session', '-t', nome], { tolerante: true });
      limpo = false;
      console.error(`  ❌ sessão que não é minha no socket (${intrusas.join(', ')}) — não derrubo o servidor tmux.`);
    } else {
      limpo = false;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    if (limpo && !t(['ls'], { tolerante: true }).trim()) {
      fs.rmSync(path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`, SOCKET), { force: true });
    }
    return limpo;
  }

  /** Planta `<raizProc>/<pid>/{stat,cmdline,task/<pid>/children}`, padrão "exec direto" (molde: gate-aba-movida.js:101-117). */
  function plantarAgenteFalso(pid, starttime) {
    const dir = path.join(raizProc, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    const campos = new Array(52).fill('0');
    campos[0] = String(pid);
    campos[1] = '(claude)';
    campos[2] = 'S';
    campos[3] = '1';
    campos[4] = String(pid);      // pgrp
    campos[5] = String(pid);      // session
    campos[6] = '34816';          // tty
    campos[7] = String(pid);      // tpgid = pgrp → está no foreground
    campos[21] = String(starttime);
    fs.writeFileSync(path.join(dir, 'stat'), `${campos.join(' ')}\n`);
    fs.writeFileSync(path.join(dir, 'cmdline'), '/usr/bin/claude\0');
    fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'task', String(pid), 'children'), '');
  }

  /** O arquivo que o CLI escreve ao nascer. */
  function escreverSessao({ pid, tmux, sessaoId, cwd, starttime, status, statusUpdatedAt }) {
    const raiz = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(raiz, { recursive: true });
    fs.writeFileSync(path.join(raiz, `${pid}.json`), JSON.stringify({
      kind: 'interactive', sessionId: sessaoId, cwd, status, updatedAt: Date.now(),
      pid, procStart: starttime, tmux, statusUpdatedAt,
    }));
  }

  function caminhoDoJsonl(cwd, sessaoId) {
    return path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessaoId}.jsonl`);
  }

  function pegarJson(caminho) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: PORTA, path: caminho }, (res) => {
        let corpo = '';
        res.setEncoding('utf8');
        res.on('data', (p) => { corpo += p; });
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(corpo) }); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
    });
  }

  let tudoOk = true;
  try {
    // ─── o cenário no tmux ───────────────────────────────────────────────────
    t(['new-session', '-d', '-s', 'ancora', '-n', CARIMBO, '-c', os.tmpdir(), 'sleep', '600']);
    t(['new-session', '-d', '-s', SESSAO, '-n', JANELA, '-c', os.tmpdir(), 'sleep', '600']);

    const panes = {};
    for (const l of t(['list-panes', '-a', '-F', '#{session_name}\t#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).split('\n')) {
      if (!l.trim()) continue;
      const [sessao, nome, janelaId, paneId, panePid] = l.split('\t');
      panes[nome] = { sessao, janelaId, paneId, panePid: Number(panePid) };
    }
    const pane = panes[JANELA];
    if (!pane) throw new Error(`a janela "${JANELA}" não apareceu no list-panes`);
    const starttime = 1000000 + pane.panePid;
    plantarAgenteFalso(pane.panePid, starttime);

    // ─── os arquivos do CLI: UMA aba Claude, status idle ───────────────────
    const cwd = '/home/gate/subagente/sa-rota';
    escreverSessao({
      pid: pane.panePid, tmux: `${SESSAO}:${pane.janelaId}.${pane.paneId}`, sessaoId: SESSAO_ID,
      cwd, starttime, status: 'idle', statusUpdatedAt: Date.now() - 90000,
    });

    const T = Date.parse('2026-10-16T13:00:00.000Z');
    const iso = (ms) => new Date(T + ms).toISOString();
    const arqConv = caminhoDoJsonl(cwd, SESSAO_ID);
    // fala do dono + tool_use Agent (tu-1) + tool_result com toolUseResult completed.
    escreverJsonl(arqConv, [
      { type: 'user', timestamp: iso(0), message: { content: 'roda isso num sub-agente' } },
      { type: 'assistant', timestamp: iso(100), message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Agent', input: { description: 'investigar', prompt: 'vai' } }] } },
      {
        type: 'user', timestamp: iso(200), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'Agent completed' }] },
        toolUseResult: { status: 'completed', agentId: 'a1', totalDurationMs: 4000 },
      },
    ]);

    const pastaSub = path.join(arqConv.replace(/\.jsonl$/, ''), 'subagents');
    fs.mkdirSync(pastaSub, { recursive: true });
    fs.writeFileSync(path.join(pastaSub, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'tu-1' }));
    escreverJsonl(path.join(pastaSub, 'agent-a1.jsonl'), [
      { type: 'assistant', timestamp: iso(110), message: { content: [{ type: 'tool_use', id: 'sp1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', timestamp: iso(150), message: { content: [{ type: 'tool_result', tool_use_id: 'sp1', content: 'ok' }] } },
      { type: 'assistant', timestamp: iso(190), message: { content: [{ type: 'text', text: 'Feito.' }], stop_reason: 'end_turn' } },
    ]);

    // ─── sobe o server.js filho, numa porta própria ────────────────────────
    const ambiente = {
      ...process.env, HOME: home, PORT: String(PORTA), HOST: '127.0.0.1',
      COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TOKEN: '',
      COCKPIT_TMUX_SOCKET: SOCKET, COCKPIT_TMUX_SESSAO: SESSAO, COCKPIT_PROC_RAIZ: raizProc,
      COCKPIT_BIN_CLAUDE: '/bin/true',
      COCKPIT_JOBS_DIR: path.join(scratch, 'jobs'),
      COCKPIT_PUSH_DIR: path.join(scratch, 'push'),
      COCKPIT_MONITOR_DIR: path.join(scratch, 'monitor'),
      COCKPIT_MONITOR_MS: '0',
      COCKPIT_VIGIA_MS: '0',
      COCKPIT_LIDAS_DIR: path.join(scratch, 'lidas'),
      COCKPIT_DU_BIN: path.join(scratch, 'sem-du'),
      COCKPIT_DOCKER_BIN: path.join(scratch, 'sem-docker'),
    };
    const logServidor = path.join(scratch, 'server.log');
    servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'), env: ambiente, stdio: ['ignore', 'ignore', 'pipe'],
    });
    servidor.stderr.pipe(fs.createWriteStream(logServidor));

    let resposta = null;
    for (let i = 0; i < 40 && !resposta; i += 1) {
      await espera(250);
      resposta = await pegarJson('/api/abas').catch(() => null);
    }
    if (!resposta) {
      console.error(fs.readFileSync(logServidor, 'utf8').slice(-800));
      throw new Error(`server.js não respondeu em /api/abas na porta ${PORTA} em 10s`);
    }

    const abaReal = (resposta.json.abas || []).find((a) => a.titulo === JANELA);
    if (!abaReal) throw new Error(`a aba "${JANELA}" não apareceu em /api/abas`);
    const chave = abaReal.chave;

    titulo('SA-R1');
    {
      const r = await pegarJson(`/api/subagente?chave=${encodeURIComponent(chave)}&ferramenta=tu-1`);
      tudoOk = ok(r.status === 200, `SA-R1: 200 (achado ${r.status})`) && tudoOk;
      const passos = r.json && r.json.passos;
      tudoOk = ok(Array.isArray(passos) && passos.length >= 1, `SA-R1: passos.length >= 1 (achado ${passos && passos.length})`) && tudoOk;
      tudoOk = ok(Boolean(r.json) && 'total' in r.json && 'tipos' in r.json && 'terminou' in r.json,
        `SA-R1: total/tipos/terminou presentes (achado ${JSON.stringify(r.json)})`) && tudoOk;
    }

    titulo('SA-R2');
    {
      const r = await pegarJson(`/api/subagente?chave=${encodeURIComponent(chave)}&ferramenta=tu-nao-existe`);
      tudoOk = ok(r.status === 404, `SA-R2: ferramenta inexistente → 404 (achado ${r.status})`) && tudoOk;
    }

    titulo('SA-R3');
    {
      const r = await pegarJson('/api/subagente?chave=job-x&ferramenta=tu-1');
      tudoOk = ok(r.status === 400, `SA-R3: chave=job-x → 400 (achado ${r.status})`) && tudoOk;
    }

    titulo('SA-R4');
    {
      const a = await pegarJson(`/api/subagente?chave=${encodeURIComponent(chave)}&ferramenta=${encodeURIComponent('../x')}`);
      const b = await pegarJson(`/api/subagente?chave=${encodeURIComponent(chave)}&ferramenta=`);
      const c = await pegarJson(`/api/subagente?chave=${encodeURIComponent(chave)}&ferramenta=tu-1&id=${encodeURIComponent('a/b')}`);
      tudoOk = ok(a.status === 400 && b.status === 400 && c.status === 400,
        `SA-R4: ferramenta=../x, ferramenta= vazio, id=a/b → 400 nos três (achados ${a.status}, ${b.status}, ${c.status})`) && tudoOk;
    }

    titulo('SA-R5');
    {
      const r = await pegarJson('/api/subagente?chave=aba-inexistente&ferramenta=tu-1');
      tudoOk = ok(r.status === 404, `SA-R5: chave de aba inexistente → 404 (achado ${r.status})`) && tudoOk;
    }

    titulo('SA-R6');
    {
      const r = await pegarJson(`/api/subagente?chave=${encodeURIComponent(chave)}&ferramenta=tu-1&sessao=outra`);
      tudoOk = ok(r.status === 409, `SA-R6: sessao= errada → 409 (achado ${r.status})`) && tudoOk;
    }

    titulo('SA-R7');
    {
      const r = await pegarJson(`/api/subagente?chave=${encodeURIComponent(chave)}&ferramenta=tu-1&sessao=${encodeURIComponent(SESSAO_ID)}`);
      tudoOk = ok(r.status === 200, `SA-R7: sessao= certa → 200 (achado ${r.status})`) && tudoOk;
    }

    titulo('SA-R8');
    {
      const r = await pegarJson(`/api/subagente?chave=${encodeURIComponent(chave)}&ferramenta=tu-1`);
      const corpo = JSON.stringify(r.json);
      tudoOk = ok(!corpo.includes(home) && !corpo.includes('/tmp/gate-subagente'),
        'SA-R8: a resposta não contém o caminho do HOME') && tudoOk;
    }

    const faltaram = conferirInventario(['SA-R1', 'SA-R2', 'SA-R3', 'SA-R4', 'SA-R5', 'SA-R6', 'SA-R7', 'SA-R8']);
    tudoOk = tudoOk && faltaram.length === 0;
  } catch (erro) {
    console.error('🔴 parte rota explodiu:', erro && erro.message);
    tudoOk = false;
  } finally {
    const limpo = limpar();
    if (!limpo) tudoOk = false;
  }
  return tudoOk;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ponto de entrada
// ═══════════════════════════════════════════════════════════════════════════════════════════

(async () => {
  const soPuro = process.argv[2] === 'puro';
  let tudoOk = await parteUmPuro();
  fs.rmSync(HOME, { recursive: true, force: true });
  if (!soPuro) tudoOk = (await parteRota()) && tudoOk;
  console.log(`\n${tudoOk ? '✅ GATE VERDE' : '❌ GATE VERMELHO'} — subagente${soPuro ? ' (puro)' : ''}\n`);
  process.exit(tudoOk ? 0 : 1);
})().catch((erro) => {
  console.error('\n❌ GATE EXPLODIU:', erro && erro.message);
  console.error(erro && erro.stack);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(1);
});
