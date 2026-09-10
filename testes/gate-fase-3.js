#!/usr/bin/env node
'use strict';
// GATE DA FASE 3 — o gateway entrega a conversa inteira a quem chega depois.
//
// Simula o que o navegador faz: abre o fluxo SSE, manda um turno, DERRUBA a conexão no meio
// (como um celular que perde a rede) e conecta de novo. O segundo cliente tem que receber a
// conversa completa, sem buraco e sem duplicata.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = { host: '127.0.0.1', port: Number(process.env.PORT || 7879) };
const ok = (c, t) => { console.log(`  ${c ? '✅' : '❌'} ${t}`); return c; };

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...BASE, path: rota, method: metodo,
      headers: corpo ? { 'content-type': 'application/json' } : {} }, (res) => {
      let dados = '';
      res.on('data', (d) => { dados += d; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: dados ? JSON.parse(dados) : {} }));
    });
    req.on('error', reject);
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

/** Abre o SSE e acumula eventos. `fecharApos` derruba a conexão no meio, de propósito. */
function ouvir(id, { fecharApos = null, ate = null, limiteMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const eventos = [];
    const req = http.request({ ...BASE, path: `/api/sessoes/${id}/eventos`, method: 'GET' }, (res) => {
      let buffer = '';
      const encerrar = () => { req.destroy(); resolve(eventos); };
      const relogio = setTimeout(encerrar, limiteMs);
      res.on('data', (bloco) => {
        buffer += bloco.toString();
        const partes = buffer.split('\n\n');
        buffer = partes.pop() || '';
        for (const parte of partes) {
          const linha = parte.split('\n').find((l) => l.startsWith('data: '));
          if (!linha) continue;
          const evento = JSON.parse(linha.slice(6));
          eventos.push(evento);
          if (fecharApos && eventos.length >= fecharApos) { clearTimeout(relogio); return encerrar(); }
          if (ate && evento.tipo === ate) { clearTimeout(relogio); return encerrar(); }
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('\nGATE FASE 3 — gateway SSE\n');
  let tudoOk = true;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fase3-'));

  const criada = await pedir('POST', '/api/sessoes', { cwd, titulo: 'gate 3' });
  tudoOk &= ok(criada.status === 201, `POST /api/sessoes cria a sessão (${criada.status})`);
  const id = criada.corpo.id;

  console.log('\n[1] cliente A conecta e manda um turno, depois CAI no meio:');
  const clienteA = ouvir(id, { fecharApos: 4 });
  await new Promise((r) => setTimeout(r, 300));
  const disparo = await pedir('POST', `/api/sessoes/${id}/turnos`, {
    texto: 'Crie o arquivo tela.txt com o texto: cockpit ok. Depois responda so: feito',
    modelo: 'haiku',
  });
  tudoOk &= ok(disparo.status === 202, `turno aceito (${disparo.status})`);

  const conflito = await pedir('POST', `/api/sessoes/${id}/turnos`, { texto: 'outro' });
  tudoOk &= ok(conflito.status === 409, `turno concorrente é recusado com 409 (${conflito.status})`);

  const eventosA = await clienteA;
  console.log(`      cliente A caiu depois de ${eventosA.length} eventos`);

  console.log('\n[2] cliente B conecta DEPOIS (celular voltando):');
  const eventosB = await ouvir(id, { ate: 'turno_fim' });
  const tipos = eventosB.map((e) => e.tipo);
  console.log(`      recebeu ${eventosB.length} eventos: ${[...new Set(tipos)].join(', ')}`);

  tudoOk &= ok(tipos[0] === 'sessao', 'primeiro evento é a sessão (para a tela se montar)');
  tudoOk &= ok(tipos.includes('humano'), 'o que o usuário escreveu veio no histórico');
  tudoOk &= ok(tipos.includes('sincronizado'), 'marca onde o histórico acaba e o ao vivo começa');
  tudoOk &= ok(tipos.includes('ferramenta'), 'chamadas de ferramenta chegaram');
  tudoOk &= ok(tipos.includes('turno_fim'), 'o fim do turno chegou ao cliente que entrou depois');
  tudoOk &= ok(tipos.filter((t) => t === 'humano').length === 1, 'sem duplicata do que foi escrito');
  tudoOk &= ok(fs.existsSync(path.join(cwd, 'tela.txt')), 'o trabalho aconteceu de verdade no disco');

  console.log('\n[3] arquivos do app instalável:');
  for (const arq of ['index.html', 'estilo.css', 'app.js', 'manifest.webmanifest', 'sw.js', 'icone.svg']) {
    tudoOk &= ok(fs.existsSync(path.join(__dirname, '..', 'public', arq)), `public/${arq}`);
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'estilo.css'), 'utf8');
  tudoOk &= ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'nenhum recurso externo no HTML');
  tudoOk &= ok(/prefers-reduced-motion/.test(css), 'respeita quem pediu menos animação');
  tudoOk &= ok(/prefers-color-scheme/.test(css), 'tem tema claro além do escuro');
  // Sem os comentários, pelo mesmo motivo da checagem de recurso externo três linhas acima:
  // o alvo é o texto que o usuário LÊ na tela, e `<!-- -->` não chega à tela. Contar comentário
  // como texto pintava o gate de vermelho por prosa de quem documentou o HTML — foi o que
  // aconteceu a partir do 1db6225, que encheu o arquivo de comentários com travessão.
  tudoOk &= ok(!/[—–]/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'sem travessão no texto da tela');

  await pedir('DELETE', `/api/sessoes/${id}`);
  console.log(`\n${tudoOk ? '✅ GATE DA FASE 3: VERDE' : '❌ GATE DA FASE 3: VERMELHO'}\n`);
  process.exit(tudoOk ? 0 : 1);
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
