'use strict';
// O mapa `sessaoId → carimbo` de "isto já foi lido" — desde 14/09 (D53) mora aqui, no
// servidor, e não mais no `localStorage` de cada aparelho: ler no celular tem de apagar o
// destaque no note, e vice-versa. Ver docs/superpowers/specs/2026-09-14-lido-compartilhado-
// -entre-aparelhos-design.md.
//
// `COCKPIT_LIDAS_DIR` é DUAS coisas ao mesmo tempo — configuração de onde o mapa mora, e o
// INTERRUPTOR que isola os testes — e ela VENCE um `HOME` falso: `DIR = env || homedir()`
// resolve a env var primeiro, então isolar `HOME` sozinho não protege ninguém. É a mesma
// estrutura da `COCKPIT_PUSH_DIR` (armadilha #62): um gate rodado à mão, fora do
// `bin/testes.js`, com esta env var esquecida no shell, grava no `~/.cockpit/lidas.json` DE
// PRODUÇÃO do dono — marcando conversas dele como lidas de verdade.
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const DIR = process.env.COCKPIT_LIDAS_DIR || path.join(os.homedir(), '.cockpit');
const ARQ = path.join(DIR, 'lidas.json');
const TETO = 500;

// Erro TIPADO, no mesmo padrão de `lib/abas.js:172`: o código de HTTP vem junto, em vez de o
// servidor adivinhar lendo a mensagem.
const erro = (codigo, mensagem) => Object.assign(new Error(mensagem), { codigo });

/**
 * `sessaoId` chega do navegador e vira CHAVE de um objeto gravado em disco.
 *
 * O `typeof` não é zelo: `String(id)` (o jeito que `lib/abas.js:845` valida um id parecido)
 * transforma `undefined` na string `"undefined"`, `null` em `"null"`, `123` em `"123"` — e as
 * três PASSAM na regex, o que devolveria 200 para um POST sem `sessaoId` e gravaria a chave
 * literal `undefined` no disco. Aqui a chave persiste e consome o teto de 500; lá ela vive
 * numa Map em memória, de vida curta — a mesma regra não pode ser copiada sem o `typeof`.
 */
function idValido(id) {
  return typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
}

/**
 * O carimbo é o `atualizadoEm` do servidor, sempre > 0. `Number.isFinite` barra `NaN` e
 * `Infinity`: um carimbo `NaN` envenenaria a entrada PARA SEMPRE — `Math.max(NaN, x)` é
 * `NaN`, `NaN > x` é `false`, e nenhum POST posterior conseguiria consertar aquele registro.
 */
function carimboValido(n) {
  return Number.isFinite(n) && n > 0;
}

/**
 * O mapa inteiro, lido do disco. `Object.create(null)` é ESTRUTURAL, não estético: num
 * objeto literal, `mapa['__proto__'] = 123` não cria own property (muda o protótipo, ou é
 * ignorado em silêncio) e o carimbo daquela chave some sem erro nenhum. Num objeto sem
 * protótipo ela vira uma own property normal — inclusive para essa chave.
 *
 * Sem cache, de propósito: medido nesta worktree, 500 entradas custam 0,35 ms para ler mais
 * `JSON.parse`, contra 14 ms do `/api/abas` inteiro. Cache seria uns 2,5% de ganho pago com
 * um estado stale entre processos — `lib/uso.js:401` já ensina que cache é otimização, nunca
 * fonte.
 *
 * Qualquer falha (arquivo ausente, corrompido, ilegível) devolve mapa vazio: perder o mapa de
 * lidas custa um `◆` a mais numa lista, nunca uma falha visível — o primeiro `marcar()`
 * reescreve o arquivo por cima.
 */
async function mapa() {
  try {
    return Object.assign(Object.create(null), JSON.parse(await fsp.readFile(ARQ, 'utf8')));
  } catch {
    return Object.create(null);
  }
}

/**
 * Grava o mapa inteiro, atômico. Privada.
 *
 * O `mode: 0o600` vai no `writeFile` do TEMPORÁRIO, não depois: `rename` preserva o modo do
 * arquivo de origem, então pôr o modo no alvo depois do rename deixaria uma janela em que o
 * arquivo existe com o `umask` do processo. O temporário fica no MESMO diretório do alvo
 * (`rename` entre filesystems falha com `EXDEV`), com PID + `hrtime` no nome — dois processos
 * (dev e produção) escrevendo ao mesmo tempo não brigam pelo mesmo `.tmp`.
 */
async function gravarJson(arquivo, conteudo) {
  await fsp.mkdir(DIR, { recursive: true });
  const tmp = path.join(DIR, `${path.basename(arquivo, '.json')}.${process.pid}.${process.hrtime.bigint()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(conteudo), { mode: 0o600 });
  await fsp.rename(tmp, arquivo);
}

// Uma fila para o arquivo de lidas, copiada de `lib/avisos.js:180-181`. `marcar()` faz
// `ler → decidir (max) → gravar` com `await` no meio: duas chamadas concorrentes NO MESMO
// processo se intercalam, e a segunda gravaria por cima de uma decisão que não viu o carimbo
// da primeira. `.then(tarefa, tarefa)` é obrigatório: tarefa que rejeita não pode envenenar a
// fila das seguintes.
let fila = Promise.resolve();
const naFila = (tarefa) => { fila = fila.then(tarefa, tarefa); return fila; };

function podar(mapaAtual, imune) {
  const chaves = Object.keys(mapaAtual);
  if (chaves.length > TETO) {
    // Poda pelo MENOR carimbo, com a entrada recém-inserida imune — sem essa imunidade, um
    // POST com carimbo antigo num mapa cheio devolveria `{ lidoEm }` de um número que nunca
    // foi para o disco.
    const sobrando = chaves.filter((k) => k !== imune).sort((a, b) => mapaAtual[a] - mapaAtual[b]);
    for (const k of sobrando.slice(0, chaves.length - TETO)) delete mapaAtual[k];
  }
}

/**
 * O único nome público de ESCRITA. `Math.max(atual, carimbo)` é a regra inteira da corrida
 * entre celular e desktop: o carimbo só CRESCE, então não importa a ordem de chegada dos
 * POSTs — o resultado final é sempre o maior. Isso só é seguro porque não existe "marcar como
 * não lido"; se um dia existir, esta regra é a primeira a cair.
 */
async function marcar(sessaoId, carimbo) {
  return naFila(async () => {
    if (!idValido(sessaoId)) throw erro(400, 'sessaoId inválido');
    if (!carimboValido(carimbo)) throw erro(400, 'carimbo inválido');

    const atual = await mapa();
    const anterior = atual[sessaoId] || 0;
    const novo = Math.max(anterior, carimbo);
    // Nada mudou: não grava. Corta a maioria das escritas do `turno_fim` — ele chama
    // `marcarLido` para TODAS as abas abertas a cada turno, e a aba aberta e parada repete o
    // mesmo carimbo em todas elas.
    if (novo === anterior) return { sessaoId, lidoEm: anterior };

    atual[sessaoId] = novo;
    podar(atual, sessaoId);
    await gravarJson(ARQ, atual);
    return { sessaoId, lidoEm: novo };
  });
}

module.exports = { mapa, marcar };
