'use strict';
// Gate da leitura em blocos de `lib/externo.js` — o card `externo-le-o-jsonl-inteiro-na-ram`.
//
//   node testes/gate-externo-blocos.js              (RSS informativo)
//   GATE_RSS=1 node testes/gate-externo-blocos.js   (o teto de RSS também REPROVA)
//
// Vive separado do `gate-ui.js` de propósito: outro job pode estar naquele arquivo, e um assert
// novo no meio dele viraria conflito. Não lê nada de ~/.claude/projects — TODA fixture nasce
// aqui, num mkdtemp, determinística. Isso é o que faz este gate rodar em qualquer máquina.
//
// A régua de cada caso é dupla, e as duas existem por motivo diferente:
//   1. contra a IMPLEMENTAÇÃO DE REFERÊNCIA (`readFile` + `split`, a regra de antes) — provar
//      equivalência com o comportamento antigo é literalmente o objetivo do card;
//   2. contra um VALOR LITERAL congelado — porque duas implementações podem concordar estando
//      as duas erradas, e valor literal é auditável a olho.
//
// O RSS (casos 5 e 9) é a única asserção que fala de recurso, e recurso é sempre sobre UMA
// máquina: por padrão ele mede e informa; só com `GATE_RSS=1` ele reprova. Os 15 checks
// restantes são de valor e reprovam em qualquer lugar.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const RSS_REPROVA = process.env.GATE_RSS === '1';
const RAIZ = path.resolve(__dirname, '..');
const LIB_EXTERNO = path.join(RAIZ, 'lib', 'externo.js');

let passou = 0;
let total = 0;
let vermelho = false;
// O rodapé confere CASOS, não asserções: exigir um número fixo de asserções faria o gate ficar
// vermelho toda vez que alguém acrescentasse um `ok()` — o que ele precisa garantir é que
// nenhum dos 17 casos deixou de rodar (por um `return` esquecido ou uma exceção engolida).
const CASOS = new Set();
const CASOS_ESPERADOS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14a', '14b', '15', '16'];

function ok(condicao, mensagem) {
  total += 1;
  if (condicao) { passou += 1; console.log(`  ✅ ${mensagem}`); }
  else { vermelho = true; console.log(`  ❌ ${mensagem}`); }
  return Boolean(condicao);
}
function titulo(t) {
  CASOS.add(String(t).match(/^([\d]+[ab]?)\./)[1]);
  console.log(`\n${t}`);
}

// ─── as peças das fixtures ────────────────────────────────────────────────────────────────────

const linha = (o) => `${JSON.stringify(o)}\n`;
const humano = (t, extra) => linha({ type: 'user', timestamp: '2026-09-02T00:00:00.000Z', message: { content: t }, ...extra });
const agente = (t) => linha({ type: 'assistant', timestamp: '2026-09-02T00:00:01.000Z', message: { content: [{ type: 'text', text: t }] } });
const imagem = (kb) => linha({ type: 'user', message: { content: [{ type: 'tool_result', content: 'A'.repeat(kb * 1024) }] } });

/** A conversa mínima que tem UMA troca de fora no meio — a base dos casos 1, 2, 4, 7, 12 e 15. */
const conversaBase = (textoDoAgenteFora = 'resp-fora') =>
  humano('p1') + agente('r1') + humano('fora') + agente(textoDoAgenteFora) + humano('p2') + agente('r2');
const PROMPTS_BASE = ['p1', 'p2'];

/**
 * A implementação de REFERÊNCIA: o `trocasDeFora` de antes, com `readFile` + `split`.
 *
 * Cópia deliberada da regra velha, não um `require` do módulo — é contra ela que a nova é
 * comparada, então ela precisa sobreviver à mudança do arquivo real.
 */
function referencia(bruto, promptsDoCockpit) {
  const textoDe = (mensagem) => {
    const c = mensagem?.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');
  };
  const ehFala = (obj) => {
    if (obj.type !== 'user' || obj.isMeta || obj.isSidechain) return false;
    const c = obj.message?.content;
    if (Array.isArray(c) && c.every((p) => p.type === 'tool_result')) return false;
    return Boolean(textoDe(obj.message).trim());
  };
  const conhecidos = promptsDoCockpit.map((t) => String(t).trim());
  const blocos = [];
  let jaVistos = 0;
  let atual = null;
  for (const l of bruto.split('\n')) {
    if (!l.trim()) continue;
    let obj;
    try { obj = JSON.parse(l); } catch { continue; }
    if (ehFala(obj)) {
      const texto = textoDe(obj.message).trim();
      if (jaVistos < conhecidos.length && texto === conhecidos[jaVistos]) { jaVistos += 1; atual = null; continue; }
      atual = { depoisDoTurno: jaVistos, quando: obj.timestamp || null, eventos: [] };
      atual.eventos.push({ tipo: 'humano', texto, deFora: true });
      blocos.push(atual);
      continue;
    }
    if (obj.type === 'assistant' && atual && !obj.isSidechain) {
      for (const parte of obj.message?.content || []) {
        if (parte.type === 'text' && parte.text.trim()) atual.eventos.push({ tipo: 'texto', texto: parte.text, deFora: true });
        else if (parte.type === 'tool_use') atual.eventos.push({ tipo: 'ferramenta', id: parte.id, nome: parte.name, entrada: parte.input, deFora: true });
      }
    }
  }
  return blocos;
}

// ─── o ambiente onde `trocasDeFora` é alcançável ──────────────────────────────────────────────

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-blocos-'));
const HOME = path.join(dir, 'home');
const PASTA = path.join(HOME, '.claude', 'projects', '-gate');
fs.mkdirSync(PASTA, { recursive: true });
process.env.HOME = HOME;
os.homedir = () => HOME;
const externo = require(LIB_EXTERNO);   // depois do HOME: `RAIZ_PROJETOS` resolve no topo do módulo

let seq = 0;
/** Grava uma fixture como sessão do CLI e devolve `{ id, caminho }`. */
function fixture(conteudo) {
  const id = `sess-${seq += 1}`;
  const caminho = path.join(PASTA, `${id}.jsonl`);
  fs.writeFileSync(caminho, conteudo);
  return { id, caminho };
}
const rodar = (id, prompts = []) => externo.trocasDeFora(id, null, prompts);
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Pico de RSS de UMA chamada, num subprocesso — mediana de 3. */
function picoMB(caminho, prompts) {
  const script = `
    const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-'));
    const pasta = path.join(home, '.claude', 'projects', '-x');
    fs.mkdirSync(pasta, { recursive: true });
    fs.symlinkSync(${JSON.stringify(caminho)}, path.join(pasta, 'x.jsonl'));
    process.env.HOME = home; os.homedir = () => home;
    const externo = require(${JSON.stringify(LIB_EXTERNO)});
    const hwm = () => Number(/VmHWM:\\s+(\\d+) kB/.exec(fs.readFileSync('/proc/self/status','utf8'))[1]);
    (async () => {
      const a = hwm();
      await externo.trocasDeFora('x', null, ${JSON.stringify(prompts || [])});
      console.log((hwm() - a) / 1024);
      fs.rmSync(home, { recursive: true, force: true });
    })();`;
  const voltas = [];
  for (let i = 0; i < 3; i += 1) {
    // `process.execPath`, não a string 'node': o PATH pode resolver outro binário, e aí o
    // número mediria um runtime enquanto o cabeçalho descreve outro.
    voltas.push(Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim()));
  }
  voltas.sort((x, y) => x - y);
  return Math.round(voltas[1] * 10) / 10;      // mediana
}

function conferePico(rotulo, caminho, prompts, teto) {
  if (!fs.existsSync('/proc/self/status')) {
    console.log(`  ℹ️  ${rotulo}: sem /proc, medição de RSS pulada (${process.platform})`);
    return;
  }
  const pico = picoMB(caminho, prompts);
  if (RSS_REPROVA) ok(pico <= teto, `${rotulo}: pico +${pico} MB ≤ teto ${teto} MB`);
  else console.log(`  ℹ️  ${rotulo}: pico +${pico} MB (referência: ≤ ${teto} MB; use GATE_RSS=1 para reprovar)`);
}

// ─── o molde de 128 B dos casos 10 e 11 ───────────────────────────────────────────────────────

/** A linha do índice `i`, com EXATAMENTE 127 bytes — 128 com o `\n`. */
function molde(i) {
  const n = String(i).padStart(4, '0');
  for (let pad = 0; pad < 200; pad += 1) {
    const s = JSON.stringify({
      type: 'user', timestamp: '2026-09-02T00:00:00.000Z', message: { content: `L${n}${'x'.repeat(pad)}` },
    });
    if (Buffer.byteLength(s) === 127) return s;
  }
  throw new Error(`molde(${i}) nao fecha em 127 bytes`);
}
const textoDoMolde = (i) => JSON.parse(molde(i)).message.content;

// ─── os checks ────────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\ngate-externo-blocos — ${process.version} ${process.platform}/${process.arch}` +
    `  ·  RSS ${RSS_REPROVA ? 'REPROVA (GATE_RSS=1)' : 'informativo'}`);

  // 1 — conversa normal. Referência + literal.
  titulo('1. conversa normal: uma troca de fora no meio');
  {
    const f = fixture(conversaBase());
    const obtido = await rodar(f.id, PROMPTS_BASE);
    ok(igual(obtido, referencia(conversaBase(), PROMPTS_BASE)), 'bate com a implementação de referência');
    ok(igual(obtido, [{
      depoisDoTurno: 1, quando: '2026-09-02T00:00:00.000Z',
      eventos: [
        { tipo: 'humano', texto: 'fora', deFora: true },
        { tipo: 'texto', texto: 'resp-fora', deFora: true },
      ],
    }]), 'e com o literal congelado: 1 bloco, depoisDoTurno 1, os dois eventos marcados deFora');
  }

  // 2 — linha de 300 KB atravessando ~5 blocos: a emenda (#11/#38).
  titulo('2. linha de 300 KB no meio: a emenda entre blocos');
  {
    const conteudo = humano('p1') + agente('r1') + humano('fora') + agente('resp-fora') + imagem(300) + humano('p2') + agente('r2');
    const f = fixture(conteudo);
    const obtido = await rodar(f.id, PROMPTS_BASE);
    ok(igual(obtido, referencia(conteudo, PROMPTS_BASE)), 'bate com a referência');
    ok(obtido.length === 1 && obtido[0].eventos.length === 2, 'a imagem de 300 KB não vira evento nem quebra a troca de fora');
  }

  // 3 — acento e emoji EM CIMA da fronteira de 64 KB.
  titulo('3. multibyte sobre a fronteira de 64 KB');
  {
    const prefixo = humano('p1') + agente('r1') + humano('fora') + '{"type":"assistant","timestamp":"2026-09-02T00:00:01.000Z","message":{"content":[{"type":"text","text":"';
    const enche = 65536 - Buffer.byteLength(prefixo);
    const texto = 'x'.repeat(enche) + 'éé🙂' + 'y'.repeat(50);
    const conteudo = humano('p1') + agente('r1') + humano('fora') + agente(texto) + humano('p2') + agente('r2');
    // A asserção de posição vem ANTES de testar: cálculo errado reprova aqui, não calado adiante.
    const buf = Buffer.from(conteudo, 'utf8');
    const offsetDoAcento = buf.indexOf(Buffer.from('éé🙂', 'utf8'));
    ok(offsetDoAcento === 65536, `o 'é' cai no byte 65536 (medido ${offsetDoAcento}) — a fronteira do bloco 1`);
    const f = fixture(conteudo);
    const obtido = await rodar(f.id, PROMPTS_BASE);
    ok(igual(obtido, referencia(conteudo, PROMPTS_BASE)), 'bate com a referência');
    ok(obtido[0] && obtido[0].eventos[1].texto === texto, 'o texto volta intacto');
    ok(obtido[0] && !obtido[0].eventos[1].texto.includes('�'), 'sem �: nenhum caractere foi partido');
  }

  // 4 — sem `\n` no fim. É este que a mutação da "prova de que o gate morde" derruba.
  //
  // A conversa TERMINA na troca de fora, e não em `agente('r2')` como a `conversaBase`. Isso é
  // deliberado e custou uma rodada de mutação para descobrir: com a base, a última linha vem
  // DEPOIS do prompt `p2` do cockpit, quando `atual` já é `null` — ela não vira evento nenhum, e
  // apagá-la não mudava a saída. O gate ficava verde com o `yield` final removido. Aqui a última
  // linha É um evento do bloco de fora, então perdê-la some com um evento e o caso reprova.
  titulo('4. arquivo sem \\n no fim, terminando NA troca de fora');
  {
    const conteudo = (humano('p1') + agente('r1') + humano('fora') + agente('resp-fora')).slice(0, -1);
    const f = fixture(conteudo);
    const obtido = await rodar(f.id, PROMPTS_BASE);
    const esperado = referencia(conteudo, PROMPTS_BASE);
    ok(igual(obtido, esperado), 'caso 4 — arquivo sem \\n no fim: bate com a referência');
    ok(obtido.length === 1 && obtido[0].eventos.length === 2,
      'caso 4 — arquivo sem \\n no fim: a última linha NÃO sumiu (a resposta de fora está lá)');
    ok(obtido[0] && obtido[0].eventos[1] && obtido[0].eventos[1].texto === 'resp-fora',
      'caso 4 — arquivo sem \\n no fim: e ela é exatamente a última linha do arquivo');
  }

  // 5 — UMA linha de 2 MB. Valor sempre; RSS sob GATE_RSS.
  titulo('5. uma linha só, de 2 MB');
  {
    const conteudo = imagem(2048);
    const f = fixture(conteudo);
    const obtido = await rodar(f.id, []);
    ok(igual(obtido, referencia(conteudo, [])), 'bate com a referência');
    ok(obtido.length === 0, 'tool_result sozinho não vira troca de fora');
    conferePico('caso 5 (1 linha de 2 MB)', f.caminho, [], 12);
  }

  // 6 — arquivo vazio.
  titulo('6. arquivo de 0 byte');
  {
    const f = fixture('');
    ok(igual(await rodar(f.id, []), []), 'devolve [] sem laço infinito');
  }

  // 7 — linha em branco e lixo não-JSON no meio.
  titulo('7. linha em branco e linha que não é JSON');
  {
    const conteudo = humano('p1') + agente('r1') + '\n\nisto nao e json\n' + humano('fora') + agente('resp-fora') + humano('p2') + agente('r2');
    const f = fixture(conteudo);
    const obtido = await rodar(f.id, PROMPTS_BASE);
    ok(igual(obtido, referencia(conteudo, PROMPTS_BASE)), 'bate com a referência');
    ok(obtido.length === 1 && obtido[0].eventos.length === 2, 'lixo é pulado calado, a troca de fora sobrevive');
  }

  // 8 — arquivo inexistente. O par do 14a: ENOENT tem `syscall`, então degrada.
  titulo('8. arquivo que não existe');
  {
    ok(igual(await rodar('nao-existe-em-lugar-nenhum', []), []), 'trocasDeFora devolve [] sem lançar');
    const linhas = [];
    let lancou = false;
    try { for await (const l of externo.linhasDoArquivo(path.join(dir, 'nada.jsonl'))) linhas.push(l); }
    catch { lancou = true; }
    ok(!lancou && linhas.length === 0, 'linhasDoArquivo com ENOENT: zero linhas, sem exceção');
  }

  // 9 — 12 MB. A maior do gate: é aqui que uma emenda errada apareceria.
  titulo('9. 12 MB, doze linhas de 1 MB');
  {
    let conteudo = '';
    for (let i = 0; i < 12; i += 1) conteudo += humano(`p${i}`) + agente(`r${i}`) + imagem(1024);
    const f = fixture(conteudo);
    const obtido = await rodar(f.id, []);
    ok(igual(obtido, referencia(conteudo, [])), 'bate com a referência num arquivo de 12 MB');
    ok(obtido.length === 12, `as 12 trocas de fora estão lá (${obtido.length})`);
    conferePico('caso 9 (12 MB)', f.caminho, [], 24);
  }

  // 10 e 11 — mutação ENTRE BLOCOS, em subprocesso com timeout de verdade.
  const fixtureMolde = () => Array.from({ length: 1536 }, (_, i) => molde(i)).join('\n') + '\n';
  const scriptDeCaso = (mutacao) => `
    const externo = require(${JSON.stringify(LIB_EXTERNO)});
    const fs = require('node:fs');
    const arquivo = process.argv[2];
    (async () => {
      const it = externo.linhasDoArquivo(arquivo);
      try {
        // next() devolve UMA linha, nao um bloco: o bloco 1 ja foi lido e o tamanho ja foi
        // congelado, mas o valor desta linha E o primeiro item do resultado.
        const primeira = await it.next();
        const obtido = [primeira.value];
        ${mutacao}
        for await (const l of it) obtido.push(l);
        console.log(JSON.stringify(obtido.map((l) => JSON.parse(l).message.content)));
      } finally { await it.return(); }
    })();`;

  titulo('10. truncamento entre dois blocos');
  {
    const f = fixture(fixtureMolde());
    ok(fs.statSync(f.caminho).size === 196608, `a fixture tem 196.608 B = 3 blocos exatos (${fs.statSync(f.caminho).size})`);
    const script = path.join(dir, 'caso10.js');
    fs.writeFileSync(script, scriptDeCaso("fs.truncateSync(arquivo, 131072);"));
    const r = spawnSync(process.execPath, [script, f.caminho], { timeout: 5000, encoding: 'utf8' });
    if (r.signal) { ok(false, `travou (${r.signal}) — o laço não termina com o arquivo truncado`); }
    else {
      const esperado = Array.from({ length: 1024 }, (_, i) => textoDoMolde(i));
      ok(igual(JSON.parse(r.stdout || 'null'), esperado),
        'devolve EXATAMENTE as 1.024 linhas dos blocos 1 e 2 (L0000–L1023), nenhuma do 3');
    }
  }

  titulo('11. crescimento entre dois blocos');
  {
    const f = fixture(fixtureMolde());
    const script = path.join(dir, 'caso11.js');
    const apend = Array.from({ length: 4 }, (_, i) => molde(9000 + i)).join('\n') + '\n';
    fs.writeFileSync(script, scriptDeCaso(`fs.appendFileSync(arquivo, ${JSON.stringify(apend)});`));
    const r = spawnSync(process.execPath, [script, f.caminho], { timeout: 5000, encoding: 'utf8' });
    if (r.signal) { ok(false, `travou (${r.signal}) — sem o limite de bytes, o laço persegue o EOF`); }
    else {
      const saiu = JSON.parse(r.stdout || 'null');
      const esperado = Array.from({ length: 1536 }, (_, i) => textoDoMolde(i));
      ok(igual(saiu, esperado), 'devolve as 1.536 linhas originais, e NENHUMA das 4 apensadas');
      ok(Array.isArray(saiu) && !saiu.some((t) => t.startsWith('L9')), 'nenhuma L9xxx entrou');
      ok(fs.statSync(f.caminho).size === 197120, 'o append aconteceu de verdade (197.120 B)');
    }
  }

  // 12 — o `\n` exatamente na borda do bloco, nos dois sentidos.
  titulo('12. \\n exatamente na borda do bloco');
  for (const alvo of [65535, 65536]) {
    const cabeca = humano('p1');
    const meio = '{"type":"assistant","timestamp":"2026-09-02T00:00:01.000Z","message":{"content":[{"type":"text","text":"';
    const cauda = '"}]}}\n';
    const enche = alvo - Buffer.byteLength(cabeca) - Buffer.byteLength(meio) - Buffer.byteLength(cauda) + 1;
    const conteudo = cabeca + agente('z'.repeat(enche)) + humano('fora') + agente('resp-fora') + humano('p2') + agente('r2');
    const posDoNl = Buffer.from(conteudo, 'utf8').indexOf(10, Buffer.byteLength(cabeca));
    ok(posDoNl === alvo, `o \\n da 2ª linha cai no byte ${alvo} (medido ${posDoNl})`);
    const f = fixture(conteudo);
    ok(igual(await rodar(f.id, PROMPTS_BASE), referencia(conteudo, PROMPTS_BASE)), `borda ${alvo}: bate com a referência`);
  }

  // 13 — erro de PROGRAMAÇÃO no corpo do laço tem que SUBIR.
  titulo('13. TypeError vindo do corpo do laço sobe');
  {
    const conteudo = conversaBase() + linha({ type: 'assistant', message: { content: [{ type: 'text' }] } });
    // Sem `text`, `parte.text.trim()` de lib/externo.js lança. Fora do bloco de fora ele nem
    // chega lá, então a linha entra logo depois de um `humano` de fora.
    const quebrado = humano('p1') + agente('r1') + humano('fora')
      + linha({ type: 'assistant', message: { content: [{ type: 'text' }] } });
    const f = fixture(quebrado);
    let subiu = null;
    try { await rodar(f.id, PROMPTS_BASE); } catch (e) { subiu = e; }
    ok(subiu instanceof TypeError, `o TypeError sobe em vez de virar [] (${subiu && subiu.constructor.name})`);
    void conteudo;
  }

  // 14a — TypeError no `open` sobe; 14b — TypeError na varredura sobe.
  titulo('14a. TypeError no open sobe (o catch do open não é cego)');
  {
    let subiu = null;
    try { for await (const _ of externo.linhasDoArquivo({})) { void _; } } catch (e) { subiu = e; }
    ok(subiu instanceof TypeError, `TypeError sobe do open (${subiu && subiu.constructor.name})`);
  }

  titulo('14b. TypeError na varredura sobe (o catch da varredura não é cego)');
  {
    const conteudo = humano('p1') + agente('r1') + humano('fora') + agente('resp-fora') + imagem(300) + humano('p2') + agente('r2');
    const f = fixture(conteudo);
    const original = Buffer.concat;
    let subiu = null;
    try {
      Buffer.concat = () => { throw new TypeError('bug forçado pelo gate'); };
      for await (const _ of externo.linhasDoArquivo(f.caminho)) { void _; }
    } catch (e) { subiu = e; }
    finally { Buffer.concat = original; }
    ok(subiu instanceof TypeError, `TypeError sobe da varredura (${subiu && subiu.constructor.name})`);
  }

  // 15 — `read` curto: a API do Node pode devolver menos do que se pediu.
  titulo('15. read curto (100 B por chamada)');
  {
    const conteudo = conversaBase();
    const f = fixture(conteudo);
    const fsp = require('node:fs/promises');
    const openOriginal = fsp.open;
    let obtido;
    try {
      fsp.open = async (...args) => {
        const alca = await openOriginal(...args);
        const readOriginal = alca.read.bind(alca);
        alca.read = (buf, off, len, pos) => readOriginal(buf, off, Math.min(len, 100), pos);
        return alca;
      };
      obtido = await rodar(f.id, PROMPTS_BASE);
    } finally { fsp.open = openOriginal; }
    ok(igual(obtido, referencia(conteudo, PROMPTS_BASE)),
      'com read de 100 B por chamada, a saída é a MESMA — o laço interno funciona');
  }

  // 16 — erro de I/O COM syscall no meio: parcial, não exceção, não [].
  titulo('16. EIO no meio da varredura: retorno parcial, sem lançar');
  {
    let conteudo = '';
    for (let i = 0; i < 12; i += 1) conteudo += humano(`p${i}`) + agente(`r${i}`) + imagem(1024);
    const f = fixture(conteudo);
    const inteiro = referencia(conteudo, []);
    const fsp = require('node:fs/promises');
    const openOriginal = fsp.open;
    let obtido = null;
    let lancou = false;
    try {
      fsp.open = async (...args) => {
        const alca = await openOriginal(...args);
        const readOriginal = alca.read.bind(alca);
        let n = 0;
        alca.read = (...a) => {
          if ((n += 1) >= 5) { const e = new Error('EIO simulado'); e.syscall = 'read'; e.code = 'EIO'; throw e; }
          return readOriginal(...a);
        };
        return alca;
      };
      obtido = await rodar(f.id, []);
    } catch { lancou = true; }
    finally { fsp.open = openOriginal; }
    ok(!lancou, 'não lança — erro de syscall degrada');
    ok(Array.isArray(obtido) && obtido.length < inteiro.length,
      `devolve PARCIAL, não o arquivo inteiro (${obtido && obtido.length} < ${inteiro.length})`);
  }

  // ─── rodapé ─────────────────────────────────────────────────────────────────────────────────
  const faltaram = CASOS_ESPERADOS.filter((c) => !CASOS.has(c));
  console.log(`\n${passou}/${total} asserções · ${CASOS.size}/${CASOS_ESPERADOS.length} casos`);
  if (faltaram.length) {
    vermelho = true;
    console.log(`❌ casos que NÃO rodaram: ${faltaram.join(', ')}`);
  }
  console.log(`\n${vermelho ? '❌ GATE VERMELHO' : '✅ GATE VERDE'} — externo em blocos\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(vermelho ? 1 : 0);
})().catch((e) => {
  console.error('\n❌ GATE EXPLODIU:', e);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
