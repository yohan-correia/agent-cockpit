#!/usr/bin/env node
'use strict';
// GATE DA FASE 2 — a sessão sobrevive ao servidor.
//
// O teste dispara um turno e MORRE no meio dele (process.exit), como se o cockpit-server
// tivesse caído. Um segundo processo então volta, reencontra a sessão e lê o resultado.
// Modo "parte1" e "parte2" porque provar isso exige dois processos de verdade.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const s = require('../lib/sessoes');

const ESTADO = path.join(os.tmpdir(), 'gate-fase2-estado.json');
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };

async function parte1() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fase2-'));
  console.log(`\nGATE FASE 2 — sessões em tmux (socket "${s.SOCKET}")\n  cwd: ${cwd}\n`);
  console.log('[1] criando sessão e disparando turno longo...');
  const sessao = await s.criar({ cwd, titulo: 'gate-fase-2' });
  console.log(`      sessão ${sessao.id} (tmux: ${sessao.tmux_session})`);
  const { turno, arquivo } = await s.rodarTurno({
    id: sessao.id,
    texto: 'Faca nesta ordem: 1) rode no bash: sleep 20; 2) crie o arquivo sobreviveu.txt com o texto "servidor caiu e o turno seguiu". Responda so: feito',
    modelo: 'haiku',
  });
  fs.writeFileSync(ESTADO, JSON.stringify({ id: sessao.id, cwd, turno, arquivo }));
  console.log(`      turno ${turno} disparado. MATANDO este processo agora (finge crash do servidor).`);
  process.exit(0); // sem cleanup, sem despedida — é um crash
}

async function parte2() {
  const { id, cwd } = JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
  console.log('\n[2] processo NOVO (o servidor voltou):');
  let tudoOk = true;

  const lista = await s.listar();
  const achada = lista.find((x) => x.id === id);
  tudoOk &= ok(Boolean(achada), 'a sessão reaparece na lista depois do crash');
  tudoOk &= ok(achada?.viva === true, 'a sessão tmux continua VIVA');
  tudoOk &= ok(achada?.cwd === cwd, 'manteve o cwd');

  console.log('      esperando o turno terminar (foi disparado antes do crash)...');
  const arquivoCodigo = path.join(s.RAIZ, id, 'turno-1.code');
  for (let i = 0; i < 90 && !fs.existsSync(arquivoCodigo); i++) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  tudoOk &= ok(fs.existsSync(arquivoCodigo), 'o turno terminou mesmo sem ninguém olhando');
  const alvo = path.join(cwd, 'sobreviveu.txt');
  tudoOk &= ok(fs.existsSync(alvo), 'o arquivo que o turno devia criar existe');
  if (fs.existsSync(alvo)) console.log(`      conteúdo: ${JSON.stringify(fs.readFileSync(alvo, 'utf8').trim())}`);

  console.log('\n[3] eventos lidos do arquivo (não da tela):');
  const linhas = fs.readFileSync(path.join(s.RAIZ, id, 'turno-1.jsonl'), 'utf8').split('\n').filter(Boolean);
  const tipos = new Set();
  const { traduzir } = require('../lib/adaptador-claude');
  for (const l of linhas) { try { for (const e of traduzir(JSON.parse(l))) tipos.add(e.tipo); } catch {} }
  console.log(`      tipos: ${[...tipos].join(', ')}`);
  tudoOk &= ok(tipos.has('inicio') && tipos.has('ferramenta') && tipos.has('fim'), 'eventos internos normalizados');

  console.log('\n[4] travas de segurança:');
  const antes = await new Promise((r) => execFile('tmux', ['ls', '-F', '#{session_name}'], (e, o) => r(String(o || ''))));
  tudoOk &= ok(antes.includes('main'), 'a sessão "main" do usuário segue de pé no socket default');
  tudoOk &= ok(!antes.includes('cockpit-'), 'nenhuma sessão do cockpit poluiu o socket default');

  let recusou = false;
  try {
    const falsa = path.join(s.RAIZ, 'sessao-forjada');
    fs.mkdirSync(falsa, { recursive: true });
    fs.writeFileSync(path.join(falsa, 'meta.json'), JSON.stringify({ id: 'sessao-forjada', tmux_session: 'main', cwd }));
    await s.encerrar('sessao-forjada');
  } catch (e) {
    recusou = /recusado/.test(e.message);
  }
  tudoOk &= ok(recusou, 'encerrar() RECUSA derrubar sessão sem o prefixo cockpit- (tentei "main")');

  await s.encerrar(id);
  const depois = await s.listar();
  tudoOk &= ok(depois.find((x) => x.id === id)?.viva === false, 'encerrar() derruba a sessão do cockpit');

  console.log(`\n${tudoOk ? '✅ GATE DA FASE 2: VERDE' : '❌ GATE DA FASE 2: VERMELHO'}\n`);
  process.exit(tudoOk ? 0 : 1);
}

(process.argv[2] === 'parte2' ? parte2() : parte1()).catch((e) => {
  console.error('erro:', e.message);
  process.exit(1);
});
