#!/usr/bin/env node
'use strict';
// GATE DO HOOK DA PERGUNTA — `bin/gancho-pergunta.js` roda dentro de TODA sessão do Claude Code
// (matcher AskUserQuestion). Duas regras valem acima do resto (F3 da spec): ele sai SEMPRE com 0
// e NUNCA escreve em stdout/stderr (o stdout de um PreToolUse pode virar decisão de permissão, e
// uma linha a mais na tela do dono aparece como "hook error"). Por isso toda chamada do modo
// gancho passa por `rodar()`, que afirma status 0 + stdout vazio + stderr vazio — nos casos bons
// e nos ruins. Só o `instalar` (e o argumento desconhecido) têm direito a falar.
//
// Sem servidor, sem tmux, sem porta. HOME e COCKPIT_PERGUNTAS_DIR sempre num mkdtemp; o
// ~/.cockpit e o ~/.claude reais nunca são tocados. Payloads: testes/fixtures/pergunta/ganchos/.
//
// Casos: H1 grava · H2 .jsonl ausente · H3 Post apaga · H4 Post de outro id · H5 stdin lixo ·
// H6 outra ferramenta · H7 ids hostis · H8 pasta sem permissão · H9 payload grande · H10 stdin que
// não fecha · H11 limpeza · H12 instalar · H13 instalar com espaço · H14 argumento desconhecido.
//
// Uso:  node testes/gate-gancho-pergunta.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

let acertos = 0;
let falhas = 0;
const ok = (c, t) => {
  const bom = Boolean(c);
  console.log(`  ${bom ? '✅' : '❌'} ${t}`);
  if (bom) acertos++; else falhas++;
  return bom;
};

const SCRIPT = path.join(__dirname, '..', 'bin', 'gancho-pergunta.js');
const GANCHOS = path.join(__dirname, 'fixtures', 'pergunta', 'ganchos');
const carregar = (nome) => JSON.parse(fs.readFileSync(path.join(GANCHOS, nome), 'utf8'));

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-offline-gancho-'));
let contador = 0;
/** Uma pasta de trabalho nova por caso: { base, dir (de perguntas), transcript }. */
function mundo() {
  const base = path.join(TEMP, `m${contador++}`);
  fs.mkdirSync(base, { recursive: true });
  return { base, dir: path.join(base, 'perguntas'), transcript: path.join(base, 'conversa.jsonl') };
}
const envDe = (m, extras = {}) => {
  const env = { PATH: process.env.PATH, HOME: m.base, COCKPIT_PERGUNTAS_DIR: m.dir, ...extras };
  return env;
};

/** O modo gancho, com a regra F3 afirmada em TODA chamada. */
function rodar(m, entrada, rotulo, extras) {
  const r = spawnSync(process.execPath, [SCRIPT], { input: entrada, env: envDe(m, extras), encoding: 'utf8', timeout: 8000 });
  ok(r.status === 0 && r.stdout === '' && r.stderr === '', `${rotulo}: exit 0, stdout e stderr vazios`);
  return r;
}

function arquivosSob(raiz) {
  const achados = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) andar(p); else achados.push(p);
    }
  };
  if (fs.existsSync(raiz)) andar(raiz);
  return achados;
}
const nadaCriado = (raiz) => arquivosSob(raiz).length === 0;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pre = carregar('b-pre.json');
  const post = carregar('b-post.json');
  const sid = pre.session_id;

  // ---- H1. grava ----------------------------------------------------------------------------
  console.log('H1. PreToolUse grava a pergunta pendente');
  {
    const m = mundo();
    fs.writeFileSync(m.transcript, Buffer.alloc(1234, 0x20));
    const p = { ...pre, transcript_path: m.transcript };
    const antes = Date.now();
    rodar(m, JSON.stringify(p), 'H1');
    const depois = Date.now();
    const arq = path.join(m.dir, `${sid}.json`);
    ok(fs.existsSync(arq), 'existe <pasta>/<session_id>.json');
    if (fs.existsSync(arq)) {
      ok((fs.statSync(arq).mode & 0o777) === 0o600, 'arquivo com modo 0600');
      ok((fs.statSync(m.dir).mode & 0o777) === 0o700, 'pasta com modo 0700');
      const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
      ok(j.versao === 1 && j.sessionId === sid && j.toolUseId === pre.tool_use_id, 'versao 1, sessionId e toolUseId do payload');
      ok(j.transcript === m.transcript, 'transcript = o caminho do payload');
      ok(j.offset === 1234, 'offset = tamanho do .jsonl no instante do gancho (1234)');
      ok(typeof j.em === 'number' && j.em >= antes && j.em <= depois, 'em é o instante da chamada');
      ok(JSON.stringify(j.perguntas) === JSON.stringify(pre.tool_input.questions), 'perguntas iguais a tool_input.questions');
    }
    ok(fs.readdirSync(m.dir).every((n) => !n.endsWith('.tmp')), 'nenhum .tmp sobrou');
  }

  // ---- H2. .jsonl inexistente ---------------------------------------------------------------
  console.log('H2. .jsonl ainda não existe');
  {
    const m = mundo();
    rodar(m, JSON.stringify({ ...pre, transcript_path: m.transcript }), 'H2');
    const j = JSON.parse(fs.readFileSync(path.join(m.dir, `${sid}.json`), 'utf8'));
    ok(j.offset === 0, 'offset 0');
  }

  // ---- H3. Post apaga -----------------------------------------------------------------------
  console.log('H3. PostToolUse apaga o arquivo da mesma pergunta');
  {
    const m = mundo();
    rodar(m, JSON.stringify({ ...pre, transcript_path: m.transcript }), 'H3 pre');
    const arq = path.join(m.dir, `${sid}.json`);
    ok(fs.existsSync(arq), 'o Pre gravou');
    rodar(m, JSON.stringify({ ...post, transcript_path: m.transcript }), 'H3 post');
    ok(!fs.existsSync(arq), 'o Post apagou');
  }

  // ---- H4. Post de outro id -----------------------------------------------------------------
  console.log('H4. PostToolUse com outro tool_use_id não toca');
  {
    const m = mundo();
    rodar(m, JSON.stringify({ ...pre, transcript_path: m.transcript }), 'H4 pre');
    const arq = path.join(m.dir, `${sid}.json`);
    rodar(m, JSON.stringify({ ...post, tool_use_id: 'toolu_outraPergunta', transcript_path: m.transcript }), 'H4 post');
    ok(fs.existsSync(arq), 'arquivo intacto');
    rodar(m, JSON.stringify({ ...post, transcript_path: m.transcript }), 'H4 post sem arquivo (ok)');
    rodar(mundo(), JSON.stringify({ ...post }), 'H4 post com pasta que nem existe');
  }

  // ---- H5. stdin lixo -----------------------------------------------------------------------
  console.log('H5. stdin que não é um evento');
  for (const [rotulo, entrada] of [['lixo', '{nao json'], ['vazio', ''], ['null', 'null'], ['array', '[]'], ['número', '42'], ['texto', '"oi"']]) {
    const m = mundo();
    rodar(m, entrada, `H5 ${rotulo}`);
    ok(nadaCriado(m.base), `H5 ${rotulo}: nada criado`);
  }
  {
    // Cada campo exigido do payload, tirado um a um.
    for (const campo of ['session_id', 'tool_use_id', 'tool_input', 'transcript_path']) {
      const m = mundo();
      const p = { ...pre, transcript_path: m.transcript };
      delete p[campo];
      rodar(m, JSON.stringify(p), `H5 sem ${campo}`);
      ok(nadaCriado(m.base), `H5 sem ${campo}: nada criado`);
    }
    const m = mundo();
    rodar(m, JSON.stringify({ ...pre, transcript_path: 'relativo/conversa.jsonl' }), 'H5 transcript relativo');
    ok(nadaCriado(m.base), 'H5 transcript relativo: nada criado');
    const m2 = mundo();
    rodar(m2, JSON.stringify({ ...pre, transcript_path: m2.transcript, tool_input: { questions: 'não é array' } }), 'H5 questions não-array');
    ok(nadaCriado(m2.base), 'H5 questions não-array: nada criado');
    const m3 = mundo();
    rodar(m3, JSON.stringify({ ...pre, transcript_path: m3.transcript, hook_event_name: 'SessionStart' }), 'H5 outro evento');
    ok(nadaCriado(m3.base), 'H5 outro evento: nada criado');
  }

  // ---- H6. outra ferramenta -----------------------------------------------------------------
  console.log('H6. outra ferramenta');
  {
    const m = mundo();
    rodar(m, JSON.stringify({ ...pre, transcript_path: m.transcript, tool_name: 'Bash' }), 'H6');
    ok(nadaCriado(m.base), 'nada criado');
  }

  // ---- H7. ids hostis -----------------------------------------------------------------------
  console.log('H7. session_id e tool_use_id hostis');
  {
    const m = mundo();
    const fundo = path.join(m.base, 'x', 'y');
    fs.mkdirSync(fundo, { recursive: true });
    const m2 = { ...m, dir: path.join(fundo, 'perguntas') };
    rodar(m2, JSON.stringify({ ...pre, transcript_path: m.transcript, session_id: '../../x' }), 'H7 session_id');
    rodar(m2, JSON.stringify({ ...pre, transcript_path: m.transcript, tool_use_id: 'a/b' }), 'H7 tool_use_id');
    rodar(m2, JSON.stringify({ ...pre, transcript_path: m.transcript, tool_use_id: 'x'.repeat(129) }), 'H7 tool_use_id longo');
    ok(nadaCriado(m.base), 'nenhum arquivo nasceu em lugar nenhum (nem fora da pasta)');
  }

  // ---- H8. pasta sem permissão --------------------------------------------------------------
  console.log('H8. pasta de perguntas sem permissão');
  if (process.getuid && process.getuid() === 0) {
    console.log('  (pulado: root ignora permissão de pasta)');
  } else {
    const m = mundo();
    const pai = path.join(m.base, 'pai');
    fs.mkdirSync(pai);
    fs.chmodSync(pai, 0o500);
    try {
      rodar({ ...m, dir: path.join(pai, 'perguntas') }, JSON.stringify({ ...pre, transcript_path: m.transcript }), 'H8');
      ok(nadaCriado(pai), 'nada criado');
    } finally { fs.chmodSync(pai, 0o700); }
  }

  // ---- H9. payload grande -------------------------------------------------------------------
  console.log('H9. perguntas de ~300 KB');
  {
    const m = mundo();
    const grande = { ...pre, transcript_path: m.transcript, tool_input: { questions: [{ question: 'x'.repeat(300 * 1024), header: 'h', options: [], multiSelect: false }] } };
    rodar(m, JSON.stringify(grande), 'H9');
    ok(nadaCriado(m.base), 'nada gravado (teto de 256 KB)');
  }

  // ---- H10. stdin que nunca fecha -----------------------------------------------------------
  console.log('H10. stdin que nunca fecha');
  {
    const m = mundo();
    const t0 = Date.now();
    const filho = spawn(process.execPath, [SCRIPT], { env: envDe(m), stdio: ['pipe', 'pipe', 'pipe'] });
    let saida = '';
    let erro = '';
    filho.stdout.on('data', (d) => { saida += d; });
    filho.stderr.on('data', (d) => { erro += d; });
    filho.stdin.write('{"parcial":');
    const codigo = await new Promise((resolve) => {
      const guarda = setTimeout(() => { filho.kill('SIGKILL'); resolve('travou'); }, 6000);
      filho.on('exit', (c) => { clearTimeout(guarda); resolve(c); });
    });
    const dur = Date.now() - t0;
    ok(codigo === 0, `saiu sozinho com exit 0 (saiu com ${codigo})`);
    ok(dur <= 4000, `em até 4 s (levou ${dur} ms)`);
    ok(saida === '' && erro === '', 'mudo');
    ok(nadaCriado(m.base), 'nada criado');
  }

  // ---- H11. limpeza -------------------------------------------------------------------------
  console.log('H11. limpeza de arquivos velhos depois de gravar');
  {
    const m = mundo();
    fs.mkdirSync(m.dir, { recursive: true });
    const velho = (nome, ms) => {
      const p = path.join(m.dir, nome);
      fs.writeFileSync(p, '{}');
      const t = new Date(Date.now() - ms);
      fs.utimesSync(p, t, t);
      return p;
    };
    const D = 24 * 3600 * 1000;
    const v1 = velho('velho1.json', 8 * D);
    const v2 = velho('velho2.json', 8 * D);
    const n6 = velho('novo.json', 6 * D);
    const tmp = velho('.x.tmp', 2 * 3600 * 1000);
    rodar(m, JSON.stringify({ ...pre, transcript_path: m.transcript }), 'H11');
    ok(!fs.existsSync(v1) && !fs.existsSync(v2), 'os de 8 dias sumiram');
    ok(!fs.existsSync(tmp), 'o .tmp de 2 h sumiu');
    ok(fs.existsSync(n6), 'o de 6 dias ficou');
    ok(fs.existsSync(path.join(m.dir, `${sid}.json`)), 'o recém-gravado ficou');
  }

  // ---- H12. instalar ------------------------------------------------------------------------
  console.log('H12. instalar com destino temporário');
  {
    const m = mundo();
    const destino = path.join(m.base, 'a', 'gancho-pergunta.js');
    const r = spawnSync(process.execPath, [SCRIPT, 'instalar'], { env: envDe(m, { COCKPIT_GANCHO_DESTINO: destino }), encoding: 'utf8' });
    ok(r.status === 0, 'exit 0');
    ok(fs.existsSync(destino) && Buffer.compare(fs.readFileSync(destino), fs.readFileSync(SCRIPT)) === 0, 'destino existe com o MESMO conteúdo do script');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(destino)).digest('hex');
    ok(r.stdout.includes(`sha256 ${sha}`) && /sha256 [0-9a-f]{64}/.test(r.stdout), 'imprime o sha256 do destino');
    ok(r.stdout.includes(destino), 'imprime o caminho do destino');
    for (const palavra of ['PreToolUse', 'PostToolUse', 'AskUserQuestion', '"timeout": 5', '2>/dev/null || true']) {
      ok(r.stdout.includes(palavra), `stdout tem ${palavra}`);
    }
    const lin = r.stdout.split('\n');
    const i = lin.indexOf('--- json ---');
    const f = lin.indexOf('--- fim ---');
    ok(i >= 0 && f > i, 'linhas --- json --- e --- fim ---');
    let bloco = null;
    try { bloco = JSON.parse(lin.slice(i + 1, f).join('\n')); } catch { /* ok(false) abaixo */ }
    ok(bloco !== null, 'o bloco JSON parseia');
    if (bloco) {
      const cmd = `${process.execPath} ${destino} 2>/dev/null || true`;
      for (const ev of ['PreToolUse', 'PostToolUse']) {
        const o = bloco[ev] && bloco[ev][0];
        ok(o && o.matcher === 'AskUserQuestion' && o.hooks[0].command === cmd && o.hooks[0].timeout === 5 && o.hooks[0].type === 'command', `${ev}: matcher AskUserQuestion e comando com node + destino`);
      }
    }
    ok(!fs.existsSync(path.join(m.base, '.claude')), 'nenhum ~/.claude foi criado no HOME falso');
  }

  // ---- H13. instalar com espaço -------------------------------------------------------------
  console.log('H13. instalar com destino que tem espaço');
  {
    const m = mundo();
    const destino = path.join(m.base, 'com espaco', 'gancho-pergunta.js');
    const r = spawnSync(process.execPath, [SCRIPT, 'instalar'], { env: envDe(m, { COCKPIT_GANCHO_DESTINO: destino }), encoding: 'utf8' });
    ok(r.status === 1, 'exit 1');
    ok(!fs.existsSync(path.dirname(destino)), 'nada copiado');
  }

  // ---- H14. argumento desconhecido ----------------------------------------------------------
  console.log('H14. argumento desconhecido');
  {
    const m = mundo();
    const r = spawnSync(process.execPath, [SCRIPT, 'foo'], { env: envDe(m), encoding: 'utf8' });
    ok(r.status === 2 && r.stderr.includes('uso:'), 'exit 2 com "uso:" no stderr');
    ok(nadaCriado(m.base), 'nada criado');
  }
}

main().catch((e) => { ok(false, `exceção fora dos casos — ${e.stack || e.message}`); }).finally(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
  console.log(`\n${acertos} ✅  ${falhas} ❌`);
  if (falhas) process.exitCode = 1;
});
