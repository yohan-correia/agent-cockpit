'use strict';
// Refaz a medição do §2.1 da spec da saída do `!` (card `saida-do-comando-em-cartao`, D79) quando o CLI
// mudar. SÓ LEITURA, fora do `npm test` (lê o disco de quem roda). Nunca imprime conteúdo de linha: só contagens.
// Sai 1 se algum casado não tiver pai `<bash-input>`/`<command-name>` ou se algum eco `<bash-input>` casar
// ou se alguma saída não vier logo depois do eco no fluxo de eventos (D80).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const externo = require('../lib/externo');

const RAIZ = path.join(os.homedir(), '.claude', 'projects');
function* jsonls(pasta) {
  let itens = [];
  try { itens = fs.readdirSync(pasta, { withFileTypes: true }); } catch { return; }
  for (const i of itens) {
    const c = path.join(pasta, i.name);
    if (i.isDirectory()) yield* jsonls(c);
    else if (i.name.endsWith('.jsonl')) yield c;
  }
}

const r = {
  arquivos: 0, formas: { string: 0, lista: 0 }, casadas: 0, porOrigem: { bash: 0, barra: 0 },
  soStdout: 0, soStderr: 0, osDois: 0, vazios: 0, comEntidade: 0, comESC: 0, comCR: 0, maior: 0,
  semPai: 0, ecosQueCasam: 0, anteriorNaoHumano: 0, jsonInteiro: 0,
};
for (const arq of jsonls(RAIZ)) {
  r.arquivos += 1;
  const objs = [];
  for (const l of fs.readFileSync(arq, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { objs.push(JSON.parse(l)); } catch { /* linha torta */ }
  }
  const porUuid = new Map(objs.filter((o) => o.uuid).map((o) => [o.uuid, o]));
  for (const o of objs) {
    if (o.type !== 'user') continue;
    const c = o.message?.content;
    const bruto = typeof c === 'string' ? c : JSON.stringify(c || '');
    const tem = /bash-stdout|local-command-stdout/.test(bruto);
    if (tem) r.formas[typeof c === 'string' ? 'string' : 'lista'] += 1;
    if (typeof c !== 'string' || o.isMeta || o.isSidechain) continue;
    if (/^<bash-input>[\s\S]*<\/bash-input>$/.test(c.trim()) && externo.saidaDeComando(c.trim())) r.ecosQueCasam += 1;
    const s = externo.saidaDeComando(c.trim());
    if (!s) continue;
    r.casadas += 1; r.porOrigem[s.origem] += 1;
    if (s.stdout && s.stderr) r.osDois += 1; else if (s.stdout) r.soStdout += 1; else if (s.stderr) r.soStderr += 1; else r.vazios += 1;
    if (/&(lt|gt|amp|quot|#39);/.test(c)) r.comEntidade += 1;
    if (/\x1b\[/.test(c)) r.comESC += 1;
    if (c.includes('\r')) r.comCR += 1;
    r.maior = Math.max(r.maior, c.length);
    const pai = o.parentUuid && porUuid.get(o.parentUuid);
    const txt = pai && typeof pai.message?.content === 'string' ? pai.message.content.trim() : '';
    if (!(txt.startsWith('<bash-input>') || txt.includes('<command-name>'))) r.semPai += 1;
  }
  // D80 L1: o cabeçalho da saída vem do eco que a PRECEDE no fluxo de eventos. Na ordem do arquivo, o evento
  // anterior a todo `saida_comando` tem de ser o `humano` do `!`/`/` que o gerou.
  let anterior = null;
  for (const o of objs) {
    for (const ev of externo.eventosDoObjeto(o)) {
      if (ev.tipo === 'saida_comando') {
        if (!(anterior && anterior.tipo === 'humano' && /^[!/]/.test(anterior.texto))) r.anteriorNaoHumano += 1;
        for (const s of [ev.stdout, ev.stderr]) {
          if (!/^\s*[[{]/.test(s)) continue;
          try { JSON.parse(s); r.jsonInteiro += 1; } catch { /* não é JSON inteiro */ }
        }
      }
      anterior = ev;
    }
  }
}
console.log(JSON.stringify(r, null, 2));
process.exitCode = r.semPai || r.ecosQueCasam || r.anteriorNaoHumano ? 1 : 0;
