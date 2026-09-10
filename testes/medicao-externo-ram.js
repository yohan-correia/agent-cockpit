'use strict';
// Quanta memória UMA abertura de fita custa — o número que o card
// `externo-le-o-jsonl-inteiro-na-ram` exige, e que nenhuma opinião substitui.
//
// Uso:
//   node testes/medicao-externo-ram.js <arquivo.jsonl> <saida.json> [nPrompts] [libDir]
//
// `nPrompts` 0 (ou ausente) é a captura A — `promptsDoCockpit = []`, que produz a saída MAIOR:
// nenhum prompt casa, então todo evento vira "de fora" e nada é filtrado pelo `jaVistos`.
// `nPrompts` 6 é a captura B, com as 6 primeiras falas humanas DO PRÓPRIO arquivo — é ela que
// exercita o casamento de `lib/externo.js:109`, o `jaVistos += 1` e o `depoisDoTurno`. Só a
// A não bastava: metade da função ficava sem prova em arquivo real.
//
// `libDir` aponta de onde carregar o `externo.js`. O padrão é a `lib/` deste repositório, e ele
// existe para poder RE-MEDIR o código antigo (guardado à parte) depois que o novo já entrou.
//
// A ORDEM das operações é o contrato, não detalhe: o `VmHWM` do "depois" é lido ANTES de
// serializar e gravar. Medir depois somaria a serialização — que pode ser centenas de KB — ao
// custo da leitura, e o número deixaria de ser o que se quer comparar.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [, , alvo, saida, nPrompts, libDir] = process.argv;
if (!alvo || !saida) {
  console.error('uso: node testes/medicao-externo-ram.js <arquivo.jsonl> <saida.json> [nPrompts] [libDir]');
  process.exit(2);
}

// Nunca relativo ao `cwd`: quem roda isto de outro diretório mediria outra coisa.
const LIB = libDir ? path.resolve(libDir) : path.resolve(__dirname, '..', 'lib');

/**
 * A marca d'água alta de memória do processo, em KB.
 *
 * `VmHWM` e não o RSS instantâneo: o RSS já perdeu o pico quando a função retorna, e é
 * justamente o pico que a mudança ataca. Em compensação `VmHWM` NUNCA desce — ver a `nota` do
 * retorno para o que isso significa quando a conta dá zero.
 */
const hwm = () => {
  const achado = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
  return achado ? Number(achado[1]) : -1;
};

/**
 * As `n` primeiras falas do humano, pela MESMA régua de `ehFalaDoHumano` (lib/externo.js:66).
 *
 * Copiada em vez de importada de propósito: importar a função sob teste para montar a entrada
 * do teste faria o casamento passar por construção, mesmo se a régua estivesse errada dos dois
 * lados. Aqui elas precisam concordar por acerto, não por origem comum.
 */
function promptsDoArquivo(arquivo, n) {
  const saida = [];
  for (const linha of fs.readFileSync(arquivo, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    let obj;
    try { obj = JSON.parse(linha); } catch { continue; }
    if (obj.type !== 'user' || obj.isMeta || obj.isSidechain) continue;
    const conteudo = obj.message?.content;
    if (Array.isArray(conteudo) && conteudo.every((p) => p.type === 'tool_result')) continue;
    const texto = typeof conteudo === 'string'
      ? conteudo
      : (Array.isArray(conteudo)
        ? conteudo.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n')
        : '');
    if (texto.trim()) saida.push(texto.trim());
    if (saida.length >= n) break;
  }
  return saida;
}

(async () => {
  // `trocasDeFora` procura a sessão em ~/.claude/projects/<pasta>/<id>.jsonl. Um HOME temporário
  // com um SYMLINK entrega o arquivo lá sem copiar 26 MB e sem depender do HOME de verdade.
  const id = path.basename(alvo, '.jsonl');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'med-externo-'));
  try {
    const pasta = path.join(home, '.claude', 'projects', '-medicao');
    fs.mkdirSync(pasta, { recursive: true });
    fs.symlinkSync(path.resolve(alvo), path.join(pasta, `${id}.jsonl`));

    // As DUAS coisas: a env para quem a lê, e o `os.homedir` para quem já o chamou. O `require`
    // do módulo vem depois, porque ele resolve `RAIZ_PROJETOS` no topo (lib/externo.js:24).
    process.env.HOME = home;
    os.homedir = () => home;
    const externo = require(path.join(LIB, 'externo.js'));

    const prompts = Number(nPrompts) > 0 ? promptsDoArquivo(path.resolve(alvo), Number(nPrompts)) : [];

    const antes = hwm();
    const t0 = process.hrtime.bigint();
    const blocos = await externo.trocasDeFora(id, null, prompts);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const depois = hwm();                       // ← AQUI. Antes de serializar, antes de gravar.
    const rssFinal = process.memoryUsage().rss;

    // O que sobra DEPOIS do lixo ser recolhido — a memória que a função de fato segura, contra
    // o pico, que inclui o lixo transitório. Sem `--expose-gc` não há como saber: `null`, nunca
    // um número inventado.
    let heapRetido = null;
    if (typeof global.gc === 'function') {
      global.gc(); global.gc();
      heapRetido = process.memoryUsage().heapUsed;
    }

    fs.writeFileSync(saida, JSON.stringify(blocos));

    const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
    const picoExtraMB = Math.round(((depois - antes) / 1024) * 10) / 10;
    const linha = {
      arquivo: path.basename(alvo),
      arquivoMB: Math.round((fs.statSync(alvo).size / 1048576) * 100) / 100,
      picoExtraMB,
      rssFinalMB: mb(rssFinal),
      heapRetidoMB: heapRetido === null ? null : mb(heapRetido),
      ms: Math.round(ms * 10) / 10,
      blocos: blocos.length,
      eventos: blocos.reduce((soma, b) => soma + b.eventos.length, 0),
      prompts: prompts.length,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    };
    // Zero aqui NÃO quer dizer "não gastou": quer dizer que a chamada não passou da marca que o
    // próprio runtime já tinha deixado. Quem lê o número precisa saber disso.
    if (picoExtraMB === 0) {
      linha.nota = 'pico abaixo do baseline do runtime — a chamada nao elevou a marca d agua';
    }
    console.log(JSON.stringify(linha));
  } finally {
    // No `finally`, e não no fim do caminho feliz: se a leitura ou a gravação lançar, o HOME
    // temporário sai do mesmo jeito.
    fs.rmSync(home, { recursive: true, force: true });
  }
})();
