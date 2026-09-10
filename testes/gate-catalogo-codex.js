'use strict';
// Processo simulado: prova handshake, cache e whitelist sem chamar modelos ou TUIs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-catalogo-codex-'));
const bin = path.join(raiz, 'codex-falso');
const log = path.join(raiz, 'chamadas');
const antigo = process.env.COCKPIT_BIN_CODEX;

// `skillsJson` é o literal que o processo falso devolve em `skills/list` — trocável entre
// chamadas para provar o catálogo vazio sem duplicar o script inteiro.
const escreverBin = (skillsJson) => fs.writeFileSync(bin, `#!/usr/bin/env node
const fs=require('fs');
require('readline').createInterface({input:process.stdin}).on('line',l=>{
 const m=JSON.parse(l);fs.appendFileSync(${JSON.stringify(log)},m.method+'\\n');
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='skills/list') console.log(JSON.stringify({id:m.id,result:{data:[{cwd:m.params.cwds[0],skills:${skillsJson}}]}}));
});`, { mode: 0o700 });

// `clear` homônima do comando nativo: prova que $clear (skill) e /clear (comando) coexistem.
const SKILLS_PADRAO = `[
 {name:'codex-only',enabled:true,scope:'user',description:'Descrição acentuada',path:'/privado/SKILL.md'},
 {name:'codex-only',enabled:true,scope:'user'},
 {name:'desligada',enabled:false,scope:'user'},
 {name:'do-projeto',enabled:true,scope:'repo'},
 {name:'plugin-skill',enabled:true,scope:'user',pluginId:'plugin'},
 {name:'clear',enabled:true,scope:'user',description:'Skill homônima do comando'}
]`;
escreverBin(SKILLS_PADRAO);
process.env.COCKPIT_BIN_CODEX = bin;

const COMANDOS_ESPERADOS = ['clear', 'compact', 'diff', 'new', 'status'];

/** Os cinco comandos nativos: uma vez cada, alfabeticamente, com o shape da spec. */
function conferirComandos(itens, onde) {
  const comandos = itens.filter((i) => i.tipo === 'comando' && i.origem === 'embutido');
  assert.deepEqual(comandos.map((c) => c.nome), COMANDOS_ESPERADOS,
    `${onde}: os cinco comandos, uma vez cada, alfabeticamente`);
  assert.deepEqual(itens.slice(0, COMANDOS_ESPERADOS.length), comandos,
    `${onde}: comandos vêm antes das skills`);
  for (const c of comandos) {
    assert.equal(c.invocacao, '/' + c.nome, `${onde}: invocacao de ${c.nome}`);
    assert.ok(c.descricao && c.descricao.length > 0, `${onde}: ${c.nome} tem descrição`);
  }
  assert.ok(!itens.some((i) => i.nome === 'context'), `${onde}: não herda /context do Claude`);
  const status = comandos.find((c) => c.nome === 'status');
  const diff = comandos.find((c) => c.nome === 'diff');
  // /status ganhou captura nativa (card `resposta-status-codex`, 08/09): a resposta chega
  // aqui na conversa, não mais "vá olhar o terminal" — /diff continua fora dessa extensão.
  assert.equal(status.descricao, 'Mostra o estado da sessão aqui na conversa.',
    `${onde}: status descreve a resposta chegando na conversa`);
  assert.ok(diff.descricao.includes('no terminal'), `${onde}: diff descreve execução no terminal`);
  const compact = comandos.find((c) => c.nome === 'compact');
  assert.ok(compact.descricao.startsWith('Usa o modelo'), `${onde}: compact avisa que usa o modelo`);
}

(async () => {
  const catalogo = require('../lib/catalogo');
  const [a, b] = await Promise.all([catalogo.listar(raiz, null, 'codex'), catalogo.listar(raiz, null, 'codex')]);
  assert.deepEqual(a, b);
  conferirComandos(a, 'catálogo padrão');

  const skills = a.filter((i) => i.tipo === 'skill');
  assert.deepEqual(skills.map((s) => s.nome), ['clear', 'codex-only', 'do-projeto', 'plugin-skill']);
  const clearSkill = skills.find((s) => s.nome === 'clear');
  const codexOnly = skills.find((s) => s.nome === 'codex-only');
  const doProjeto = skills.find((s) => s.nome === 'do-projeto');
  const pluginSkill = skills.find((s) => s.nome === 'plugin-skill');
  assert.equal(clearSkill.invocacao, '$clear');
  assert.equal(codexOnly.invocacao, '$codex-only');
  assert.equal(codexOnly.descricao, 'Descrição acentuada');
  assert.equal(doProjeto.origem, 'projeto');
  assert.equal(pluginSkill.origem, 'plugin');
  assert.ok(!JSON.stringify(a).includes('/privado/'));

  // $clear (skill) e /clear (comando) coexistem, cada um com sua invocação.
  const clearComando = a.find((i) => i.tipo === 'comando' && i.nome === 'clear');
  assert.equal(clearComando.invocacao, '/clear');
  assert.equal(clearSkill.invocacao, '$clear');

  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'skills/list']);
  await catalogo.listar(raiz, null, 'codex');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 3);

  const claude = await catalogo.listar(raiz, null, 'claude');
  assert.ok(!claude.some((s) => s.nome === 'codex-only'));
  assert.ok(claude.some((s) => s.nome === 'clear'));

  // Catálogo vazio de skills ainda entrega os cinco comandos — cwd novo, sem cache do anterior.
  const raizVazia = fs.mkdtempSync(path.join(raiz, 'vazio-'));
  escreverBin('[]');
  const vazio = await catalogo.listar(raizVazia, null, 'codex');
  conferirComandos(vazio, 'catálogo com skills vazias');
  assert.equal(vazio.filter((i) => i.tipo === 'skill').length, 0);
  fs.rmSync(raizVazia, { recursive: true, force: true });

  // Falha continua rejeitando e removendo o cache — cwd separado, nunca consultado antes.
  fs.writeFileSync(bin, '#!/usr/bin/env node\nprocess.exit(1);', { mode: 0o700 });
  const raizFalha = fs.mkdtempSync(path.join(raiz, 'falha-'));
  await assert.rejects(catalogo.listar(raizFalha, null, 'codex'));
  escreverBin(SKILLS_PADRAO);
  const recuperado = await catalogo.listar(raizFalha, null, 'codex');
  conferirComandos(recuperado, 'retry no mesmo cwd depois de falhar');
  assert.ok(recuperado.some((i) => i.invocacao === '$codex-only'),
    'retry recupera também as skills, sem ficar preso à promessa rejeitada');

  console.log('GATE VERDE — catálogo Codex: cinco comandos, homônimos, origem, cache concorrente, isolamento, invocação e falha segura');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  if (antigo === undefined) delete process.env.COCKPIT_BIN_CODEX; else process.env.COCKPIT_BIN_CODEX = antigo;
  fs.rmSync(raiz, { recursive: true, force: true });
});
