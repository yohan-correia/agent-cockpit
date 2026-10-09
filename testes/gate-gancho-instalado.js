#!/usr/bin/env node
'use strict';
// GATE DO "HOOK DA PERGUNTA ESTÁ INSTALADO?" — `lib/pergunta.js`, `estadoDoGancho` e `arquivosDeSettings`
// (spec 2026-10-09-pergunta-sem-gancho-avisa, card `pergunta-sem-gancho-avisa`).
//
// O aviso "Cartão da pergunta desligado" só pode sair quando o hook REALMENTE falta. `null` em
// `perguntaPendente` não serve de sinal (tem seis causas legítimas com o hook instalado); o sinal é a
// configuração: o `PreToolUse` do settings cita um `gancho-pergunta.js` que existe. Este gate prova os três
// resultados (`instalado` / `ausente` / `nao-sei`), que em dúvida ele CALA (`nao-sei`), o cache por
// mtime+size+ino, e que nada aqui escreve no settings.
//
// Node puro: sem server, sem porta, sem tmux. Todo settings é falso, numa pasta temporária — nunca o
// `~/.claude/settings.json` de quem roda (o runner troca o HOME, e mesmo assim nenhum caso usa o HOME
// para ler settings: os caminhos vão explícitos em `arquivos`).
//
// Uso:  node testes/gate-gancho-instalado.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let acertos = 0;
let falhas = 0;
const ok = (c, t) => {
  const bom = Boolean(c);
  console.log(`  ${bom ? '✅' : '❌'} ${t}`);
  if (bom) acertos++; else falhas++;
  return bom;
};
function grupo(rotulo, fn) {
  console.log(rotulo);
  try { fn(); } catch (e) { ok(false, `${rotulo}: o grupo estourou — ${e.message}`); }
}

let pergunta = null;
try { pergunta = require('../lib/pergunta'); } catch (e) { ok(false, `lib/pergunta.js não carregou — ${e.message}`); }
const estado = (arquivos) => pergunta.estadoDoGancho({ arquivos });

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-offline-gancho-'));
let contador = 0;
const pasta = () => { const p = path.join(TEMP, `c${contador++}`); fs.mkdirSync(p, { recursive: true }); return p; };

// O script "instalado" — o conteúdo não importa, só que o arquivo exista.
const SCRIPT = path.join(TEMP, 'share', 'gancho-pergunta.js');
fs.mkdirSync(path.dirname(SCRIPT), { recursive: true });
fs.writeFileSync(SCRIPT, '// falso\n');

/** O objeto que o `instalar` do D74 imprime (`bin/gancho-pergunta.js:132`). */
const objetoD74 = (script = SCRIPT, matcher = 'AskUserQuestion') => ({
  ...(matcher === undefined ? {} : { matcher }),
  hooks: [{ type: 'command', command: `/usr/bin/node ${script} 2>/dev/null || true`, timeout: 5 }],
});
const FREIO = { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: '/opt/freio.sh' }] };

/** Grava um settings numa pasta nova e devolve o caminho. `conteudo` string = bruto; objeto = JSON. */
function settings(conteudo) {
  const arquivo = path.join(pasta(), 'settings.json');
  fs.writeFileSync(arquivo, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo, null, 2));
  return arquivo;
}
const comHooks = (hooks, extra = {}) => settings({ model: 'x', ...extra, hooks });

// ---- os três resultados ---------------------------------------------------------------------------

grupo('G-resultado — instalado / ausente / nao-sei', () => {
  ok(estado([settings({ model: 'x' })]) === 'ausente', 'settings sem `hooks` → ausente');
  ok(estado([path.join(pasta(), 'nao-existe.json')]) === 'ausente', 'settings que não existe → ausente (nada carregado = nenhum hook)');
  ok(estado([]) === 'ausente', 'lista vazia → ausente');
  ok(estado([comHooks({ PreToolUse: [FREIO, objetoD74()], PostToolUse: [objetoD74()] })]) === 'instalado',
    'o settings do D74 (freio + gancho no Pre, gancho no Post) → instalado');
  ok(estado([comHooks({ PreToolUse: [objetoD74()] })]) === 'instalado', 'só o PreToolUse (sem Post) → instalado: é o Pre que grava o arquivo');
  ok(estado([comHooks({ PreToolUse: [FREIO], PostToolUse: [objetoD74()] })]) === 'ausente',
    'só o PostToolUse → ausente (o cartão nunca nasce sem o Pre)');
  ok(estado([comHooks({ PreToolUse: [FREIO] })]) === 'ausente', 'matcher `Edit|Write|…` NÃO casa AskUserQuestion → ausente');
  ok(estado([comHooks({ PreToolUse: [objetoD74(SCRIPT, 'Bash|AskUserQuestion')] })]) === 'instalado', 'matcher regex `Bash|AskUserQuestion` → instalado');
  ok(estado([comHooks({ PreToolUse: [objetoD74(SCRIPT, '*')] })]) === 'instalado', 'matcher `*` → instalado');
  ok(estado([comHooks({ PreToolUse: [objetoD74(SCRIPT, '')] })]) === 'instalado', 'matcher `""` → instalado');
  ok(estado([comHooks({ PreToolUse: [objetoD74(SCRIPT, undefined)] })]) === 'instalado', 'sem matcher → instalado');
  ok(estado([comHooks({ PreToolUse: [objetoD74(SCRIPT, 'AskUser')] })]) === 'ausente', 'matcher `AskUser` (casa só o pedaço) → ausente: o casamento é do nome inteiro');
  ok(estado([comHooks({ PreToolUse: [objetoD74(SCRIPT, '(')] })]) === 'ausente', 'matcher regex inválida `(` → comparação exata → ausente');
  ok(estado([comHooks({ PreToolUse: [objetoD74(path.join(TEMP, 'sumiu', 'gancho-pergunta.js'))] })]) === 'ausente',
    'comando cita um caminho absoluto que NÃO existe → ausente (o `|| true` deixaria o hook mudo)');
  ok(estado([comHooks({ PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'node gancho-pergunta.js' }] }] })]) === 'instalado',
    'caminho relativo (não dá para conferir) → instalado');
  ok(estado([comHooks({ PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `/usr/bin/node '${SCRIPT}' || true` }] }] })]) === 'instalado',
    'caminho entre aspas → instalado');
  ok(estado([comHooks({ PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/opt/outro-hook.sh' }] }] })]) === 'ausente',
    'matcher AskUserQuestion com OUTRO script → ausente');
  ok(estado([comHooks({ PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'prompt', prompt: 'gancho-pergunta.js' }] }] })]) === 'ausente',
    '`type: "prompt"` é forma válida, só não conta → ausente');
});

grupo('G-duvida — em dúvida, cala (nao-sei)', () => {
  ok(estado([settings('{nao json')]) === 'nao-sei', 'JSON inválido → nao-sei');
  ok(estado([settings('[]')]) === 'nao-sei', 'raiz que não é objeto → nao-sei');
  ok(estado([comHooks('texto')]) === 'nao-sei', '`hooks` string → nao-sei');
  ok(estado([comHooks({ PreToolUse: { matcher: 'AskUserQuestion' } })]) === 'nao-sei', '`PreToolUse` objeto (não array) → nao-sei');
  ok(estado([comHooks({ PreToolUse: ['x'] })]) === 'nao-sei', 'item do PreToolUse que não é objeto → nao-sei');
  ok(estado([comHooks({ PreToolUse: [{ matcher: 7, hooks: [] }] })]) === 'nao-sei', 'matcher número → nao-sei');
  ok(estado([comHooks({ PreToolUse: [{ matcher: 'AskUserQuestion', hooks: 'x' }] })]) === 'nao-sei', '`hooks` do item que não é array → nao-sei');
  ok(estado([comHooks({ PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command' }] }] })]) === 'nao-sei', 'item de comando sem `command` → nao-sei');
  ok(estado([comHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 9 }] }] })]) === 'nao-sei', '`command` não-string, mesmo noutro matcher → nao-sei');
  const grande = settings(`{"hooks":{}}${' '.repeat(1024 * 1024 + 10)}`);
  ok(estado([grande]) === 'nao-sei', 'settings acima de 1 MB → nao-sei');
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const fechado = settings({ hooks: {} });
    fs.chmodSync(fechado, 0o000);
    ok(estado([fechado]) === 'nao-sei', 'settings sem permissão de leitura → nao-sei');
    fs.chmodSync(fechado, 0o600);
  } else {
    console.log('  (root: o caso "sem permissão" não se aplica)');
  }
  ok(pergunta.estadoDoGancho() === 'nao-sei' && pergunta.estadoDoGancho({ arquivos: 'x' }) === 'nao-sei', 'sem lista (ou lista que não é array) → nao-sei, sem lançar');
});

grupo('G-varios — usuário + projeto', () => {
  const semHook = comHooks({ PreToolUse: [FREIO] });
  const comHook = comHooks({ PreToolUse: [objetoD74()] });
  const quebrado = settings('{nao json');
  const ausenteArq = path.join(pasta(), 'nao-existe.json');
  ok(estado([semHook, comHook]) === 'instalado', 'usuário sem, projeto com → instalado');
  ok(estado([quebrado, comHook]) === 'instalado', 'usuário ilegível, projeto com → instalado (achar vence a dúvida)');
  ok(estado([quebrado, semHook]) === 'nao-sei', 'usuário ilegível, projeto sem → nao-sei');
  ok(estado([semHook, ausenteArq]) === 'ausente', 'usuário sem, projeto inexistente → ausente');
});

grupo('G-arquivos — a lista de settings que a aba carrega', () => {
  const casa = pasta();
  const antes = process.env.HOME;
  process.env.HOME = casa;
  try {
    const u = path.join(casa, '.claude', 'settings.json');
    const l = pergunta.arquivosDeSettings('/srv/demo');
    ok(JSON.stringify(l) === JSON.stringify([u, '/srv/demo/.claude/settings.json', '/srv/demo/.claude/settings.local.json']),
      `cwd → usuário + settings e settings.local do projeto (${JSON.stringify(l)})`);
    ok(JSON.stringify(pergunta.arquivosDeSettings(null)) === JSON.stringify([u]), 'sem cwd → só o do usuário');
    ok(JSON.stringify(pergunta.arquivosDeSettings('')) === JSON.stringify([u]), 'cwd vazio → só o do usuário');
    const h = pergunta.arquivosDeSettings(casa);
    ok(JSON.stringify(h) === JSON.stringify([u, path.join(casa, '.claude', 'settings.local.json')]), 'cwd = HOME → sem repetir o do usuário');
  } finally {
    process.env.HOME = antes;
  }
});

// ---- cache --------------------------------------------------------------------------------------

grupo('G-cache — relê só quando mtime/size/ino mudam', () => {
  const MTIME = 1700000000;
  const corpoCom = JSON.stringify({ hooks: { PreToolUse: [objetoD74()] } });
  // Mesmo tamanho, sem o hook: troca o nome do script por um que não casa (mesmo comprimento).
  const corpoSem = corpoCom.replace('gancho-pergunta.js', 'gancho-perguntaXjs');
  if (corpoSem.length !== corpoCom.length) throw new Error('os dois corpos precisam ter o mesmo tamanho');
  const arquivo = path.join(pasta(), 'settings.json');
  fs.writeFileSync(arquivo, corpoCom);
  fs.utimesSync(arquivo, MTIME, MTIME);
  ok(estado([arquivo]) === 'instalado', 'primeira leitura: instalado');
  const ino = fs.statSync(arquivo).ino;
  fs.writeFileSync(arquivo, corpoSem); // escrita no lugar: mesmo inode
  fs.utimesSync(arquivo, MTIME, MTIME);
  ok(fs.statSync(arquivo).ino === ino, '(o arreio manteve o inode)');
  ok(estado([arquivo]) === 'instalado', 'conteúdo trocado com mtime/size/ino iguais → NÃO relê (ainda instalado)');
  fs.utimesSync(arquivo, MTIME + 5, MTIME + 5);
  ok(estado([arquivo]) === 'ausente', 'mtime novo → relê (agora ausente)');

  // Rename atômico: mesmo mtime e tamanho, inode novo.
  fs.writeFileSync(arquivo, corpoCom);
  fs.utimesSync(arquivo, MTIME, MTIME);
  ok(estado([arquivo]) === 'instalado', 'regravado com o hook: instalado');
  const tmp = `${arquivo}.tmp`;
  fs.writeFileSync(tmp, corpoSem);
  fs.utimesSync(tmp, MTIME, MTIME);
  fs.renameSync(tmp, arquivo);
  ok(estado([arquivo]) === 'ausente', 'rename atômico (inode novo, mesmo mtime/size) → relê');

  // Settings apagado depois de lido.
  fs.writeFileSync(arquivo, corpoCom);
  ok(estado([arquivo]) === 'instalado', 'de novo com o hook: instalado');
  fs.unlinkSync(arquivo);
  ok(estado([arquivo]) === 'ausente', 'settings apagado → ausente');

  // Script apagado entre chamadas, SEM mexer no settings: o stat do script roda toda vez.
  const script = path.join(pasta(), 'gancho-pergunta.js');
  fs.writeFileSync(script, '// falso\n');
  const s = comHooks({ PreToolUse: [objetoD74(script)] });
  ok(estado([s]) === 'instalado', 'script presente: instalado');
  fs.unlinkSync(script);
  ok(estado([s]) === 'ausente', 'script apagado, settings intocado → ausente na chamada seguinte');
  fs.writeFileSync(script, '// voltou\n');
  ok(estado([s]) === 'instalado', 'script reinstalado → instalado');
});

grupo('G-script — "não consegui olhar o script" não vira "hook ausente"', () => {
  // O script mora numa pasta sem permissão de busca: o `stat` dele dá EACCES, não ENOENT.
  const fechada = path.join(pasta(), 'fechada');
  fs.mkdirSync(fechada);
  const script = path.join(fechada, 'gancho-pergunta.js');
  fs.writeFileSync(script, '// falso\n');
  const s = comHooks({ PreToolUse: [objetoD74(script)] });
  ok(pergunta.estadoDoGancho({ arquivos: [s] }) === 'instalado', 'pasta aberta: instalado');
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    fs.chmodSync(fechada, 0o000);
    try {
      ok(pergunta.estadoDoGancho({ arquivos: [s] }) === 'nao-sei', 'stat do script com EACCES → nao-sei (não ausente)');
      const outro = comHooks({ PreToolUse: [objetoD74()] });
      ok(pergunta.estadoDoGancho({ arquivos: [s, outro] }) === 'instalado', 'EACCES num, script ok noutro → instalado');
    } finally {
      fs.chmodSync(fechada, 0o700);
    }
  } else {
    console.log('  (root: o caso EACCES não se aplica)');
  }
  const sub = comHooks({ PreToolUse: [objetoD74(path.join(SCRIPT, 'gancho-pergunta.js'))] });
  ok(pergunta.estadoDoGancho({ arquivos: [sub] }) === 'ausente', 'caminho que atravessa um ARQUIVO (ENOTDIR) → ausente');
});

// ---- só leitura ---------------------------------------------------------------------------------

grupo('G-leitura — nada aqui escreve', () => {
  const dir = pasta();
  const arquivo = path.join(dir, 'settings.json');
  fs.writeFileSync(arquivo, JSON.stringify({ hooks: { PreToolUse: [FREIO] } }));
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex');
  const antesHash = hash();
  const antesMtime = fs.statSync(arquivo).mtimeMs;
  for (let i = 0; i < 3; i++) estado([arquivo, path.join(dir, 'local.json')]);
  ok(hash() === antesHash && fs.statSync(arquivo).mtimeMs === antesMtime, 'o settings fica byte a byte igual, mesmo mtime');
  ok(JSON.stringify(fs.readdirSync(dir)) === JSON.stringify(['settings.json']), 'nenhum arquivo novo na pasta do settings');
});

fs.rmSync(TEMP, { recursive: true, force: true });
console.log(`\n${acertos} ✅  ${falhas} ❌`);
if (falhas) process.exitCode = 1;
