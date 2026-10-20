'use strict';
// GATE da saída do `!` em cartão (card `saida-do-comando-em-cartao`, D79). Node puro: HOME falso
// ANTES do require (RAIZ_PROJETOS de lib/externo.js resolve no topo do módulo). Nasceu VERMELHO
// contra a develop d08b1b4: lá a saída virava `humano` com o XML cru.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-saida-'));
const HOME = path.join(dir, 'home');
process.env.HOME = HOME; os.homedir = () => HOME;
const externo = require('../lib/externo');
const abas = require('../lib/abas');

const FIXTURE = path.join(__dirname, 'fixtures', 'saida-comando', 'conversa.jsonl');
const ID = '00000000-0000-4000-8000-0000000000e7';
const CWD = '/home/usuario/projetos/projeto-a';
// u1…u19 da fixture, 1-based como no plano: L(2) é a saída do `git branch -D`.
const L = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const u = (n) => L[n - 1];
const ev = (n) => externo.eventosDoObjeto(u(n));
const SAIDAS = [2, 4, 6, 8, 10, 12, 14, 16, 19];

(async () => {
  let falhas = 0;
  const caso = async (nome, fn) => {
    try { await fn(); } catch (e) { console.error(`❌ ${nome}`); console.error(e); falhas += 1; }
  };

  await caso('S1 saidaDeComando exportada', () => {
    assert.equal(typeof externo.saidaDeComando, 'function');
  });

  await caso('S2 saída vira saida_comando, campos limpos', () => {
    assert.deepEqual(ev(2), [{ tipo: 'saida_comando', origem: 'bash', stdout: 'Deleted branch feature/exemplo (was 1a2b3c4).', stderr: '', quando: u(2).timestamp }]);
    const e4 = ev(4)[0];
    assert.equal(e4.stdout, ''); assert.equal(e4.stderr, 'sh: 1: eslint: not found');
    const e6 = ev(6)[0];
    assert.equal(e6.stdout, '(Bash completed with no output)');
    assert.equal(e6.stderr, 'Shell cwd was reset to /home/usuario/projetos/projeto-a');
    const e8 = ev(8)[0];
    assert.equal(e8.stdout, ''); assert.equal(e8.stderr, '');
    assert.equal(ev(10)[0].stdout, 'main: 1a2b3c4 -> 5d6e7f8 &lt;b&gt; <script>x</script>', 'entidades numa passada só');
    assert.equal(ev(12)[0].stdout, 'lib\nREADME.md', 'sem ESC nem CR');
    assert.equal(ev(14)[0].stdout.split('\n').length, 200);
    const e16 = ev(16)[0];
    assert.equal(e16.tipo, 'saida_comando'); assert.equal(e16.origem, 'barra');
    assert.equal(e16.stdout, 'Set model to modelo-exemplo'); assert.equal(e16.stderr, '');
  });

  await caso('S3 nenhuma saída vira humano', () => {
    for (const n of SAIDAS) assert.equal(ev(n).filter((e) => e.tipo === 'humano').length, 0, `u${n}`);
  });

  await caso('S4 citação no meio continua fala', () => {
    const texto = u(17).message.content;
    assert.deepEqual(ev(17).map(({ tipo, texto: t }) => ({ tipo, texto: t })), [{ tipo: 'humano', texto }]);
  });

  await caso('S5 isMeta some', () => {
    assert.deepEqual(ev(18), []);
  });

  await caso('S6 envelope digitado vira cartão (risco aceito da spec §3, crava a escolha)', () => {
    assert.equal(ev(19)[0].tipo, 'saida_comando');
  });

  const chave = 'gate-saida';
  await caso('S7 o !cmd segue desembrulhado e consome a pendente (#95)', () => {
    const e1 = ev(1)[0];
    assert.equal(e1.tipo, 'humano'); assert.equal(e1.texto, '! git branch -D feature/exemplo');
    const ficha = abas.registrarPendente(chave, { id: 's7', texto: '! git branch -D feature/exemplo', mensagem: '! git branch -D feature/exemplo' }, Date.parse(u(1).timestamp) - 200);
    assert.equal(abas.consumirPendente(chave, e1.texto, e1.quando), ficha);
    const e15 = ev(15)[0];
    assert.equal(e15.tipo, 'humano'); assert.equal(e15.texto, '/model');
  });
  abas.esquecerPendentes(chave);

  await caso('S8 leitor da abertura', async () => {
    const { eventos } = await externo.lerConversa(FIXTURE, 0);
    assert.deepEqual(eventos.filter((e) => e.tipo === 'humano').map((e) => e.texto),
      ['! git branch -D feature/exemplo', '!npm run lint', '!git push', '!true', '!git log -1', '!ls --color', '!seq 200', '/model', u(17).message.content]);
    const saidas = eventos.filter((e) => e.tipo === 'saida_comando');
    assert.equal(saidas.length, 9);
    assert.deepEqual(saidas.map((e) => e.quando), SAIDAS.map((n) => u(n).timestamp), 'na ordem do arquivo');
  });

  await caso('S9 trocasDeFora ignora a saída', async () => {
    const pasta = path.join(HOME, '.claude', 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(pasta, { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(pasta, `${ID}.jsonl`));
    const blocos = await externo.trocasDeFora(ID, CWD, []);
    for (const b of blocos) for (const e of b.eventos) {
      const t = String(e.texto || '');
      assert.ok(!t.startsWith('<bash-stdout>') && !t.startsWith('<local-command-stdout>'), `evento com saída crua: ${t.slice(0, 40)}`);
    }
    assert.equal(blocos.length, 9, 'um bloco por fala: os 8 comandos + u17');
  });

  // D80 (card `saida-do-comando-legivel`): indentar JSON é DESENHO, mora na tela. O evento leva o texto como o
  // comando imprimiu (limpo, S3), numa linha só — um leitor que não seja a fita recebe o dado, não a apresentação.
  await caso('S10 o servidor não reformata JSON', () => {
    const json = '[{"id":"a","body":null},{"id":"b","n":12345678901234567890}]';
    assert.deepEqual(externo.saidaDeComando(`<bash-stdout>${json}\n</bash-stdout><bash-stderr>{"e":1}</bash-stderr>`),
      { origem: 'bash', stdout: json, stderr: '{"e":1}' });
  });

  abas.esquecerPendentes(chave);
  fs.rmSync(dir, { recursive: true, force: true });
  if (falhas) { console.error(`❌ GATE VERMELHO (${falhas})`); process.exitCode = 1; }
  else console.log('GATE VERDE — a saída do ! vira saida_comando, não fala do dono');
})();
