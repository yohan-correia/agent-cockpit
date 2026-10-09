'use strict';
// O livro de entregas: quem já recebeu qual aviso.
//
// `lib/avisos.js` manda um aviso para cada aparelho inscrito; `lib/vigia-abas.js` decide QUANDO
// avisar. O que faltava era memória de ENTREGA: dois observadores que veem a mesma transição
// (dois cockpits de pé na mesma pasta de push), um reenvio depois de falha parcial, uma fila
// retomada depois de um restart — todos mandariam de novo para quem já tinha recebido.
//
// A pergunta "esse evento já foi para esse aparelho?" mora aqui, e só aqui. Pelo menos uma vez,
// nunca "exatamente uma vez": o serviço de push pode aceitar e a resposta não chegar (timeout),
// e isso é indistinguível de "não chegou". Nesses casos o livro deixa tentar de novo — a mesma
// `tag` substitui o aviso anterior na bandeja (public/sw.js).
//
// No disco, dentro da pasta de push (a mesma trava de isolamento dos testes):
//   <raiz>/<evento>/<aparelho>.reserva   { pid, token, desde } — alguém está tentando AGORA
//   <raiz>/<evento>/<aparelho>.final     { desfecho, em }      — escrito UMA vez; existir = final
// Os dois nascem com `flag: 'wx'` (O_CREAT|O_EXCL): o sistema de arquivos garante um vencedor
// só, entre chamadas do mesmo processo e entre processos. Exige disco LOCAL.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Vinte vezes o timeout de UMA tentativa (lib/push.js, 15 s). É rede de segurança para dono
// vivo e travado, não a régua principal: a principal é "o dono está vivo?" (armadilha #46).
const TETO_RESERVA_MS = 5 * 60 * 1000;
// Reserva ILEGÍVEL (criada e não escrita): quem escreve termina em milissegundos, então uma
// ilegível com mais que isto é de alguém que morreu no meio ou cuja escrita falhou (disco
// cheio). Esperar o teto inteiro travaria todo retry em `em-voo` por minutos.
const PRAZO_ILEGIVEL_MS = 10 * 1000;
// Tem de ser MAIOR que o prazo de qualquer reenvio: apagar o registro antes do último retry
// faria o retry reenviar para quem já aceitou.
const RETENCAO_MS = 24 * 3600 * 1000;
const INTERVALO_LIMPEZA_MS = 3600 * 1000;

const FINAIS = new Set(['aceito', 'descartado']);
const DESFECHOS = new Set(['aceito', 'descartado', 'falhou', 'incerto']);
const normalizar = (desfecho) => (DESFECHOS.has(desfecho) ? desfecho : 'incerto');

// Os tokens das tentativas em voo NESTE processo. É do módulo, não do livro: dois livros na
// mesma pasta, no mesmo processo, precisam enxergar as reservas um do outro.
const emVoo = new Set();

const resumo = (texto) => crypto.createHash('sha256').update(texto).digest('hex').slice(0, 32);

/**
 * A identidade de um evento de aviso — PURA, sem I/O. Dois observadores que leem a mesma
 * transição chegam ao mesmo valor; eventos diferentes, a valores diferentes.
 *
 * `marco` é o `statusUpdatedAt` do arquivo de sessão do CLI: o instante em que o status mudou.
 * NÃO a hora da última mensagem — ela não conta ferramenta, e dois pedidos de permissão
 * seguidos no mesmo turno teriam a mesma hora (o segundo aviso seria suprimido).
 *
 * `null` quando falta qualquer parte: sem identidade, quem chama envia como sempre enviou.
 * Duplicata é incômodo; aviso perdido é defeito.
 */
function identidade({ chave, sessaoId, tipo, marco } = {}) {
  if (!chave || !sessaoId || !tipo) return null;
  if (!Number.isFinite(marco) || marco <= 0) return null;
  return resumo(JSON.stringify(['v1', chave, sessaoId, tipo, marco]));
}

/** `EPERM` é processo que existe e é de outro usuário: vivo. */
function vivoPorSinal(pid) {
  try { process.kill(pid, 0); return true; }
  catch (erro) { return erro.code === 'EPERM'; }
}

/**
 * Um livro numa pasta. NÃO toca o disco aqui: `lib/avisos.js` cria o livro no `require`, e
 * require não pode ter efeito de disco.
 *
 * `agora`, `vivo` e `disco` são injetáveis só para o gate: relógio controlado, dono "morto" sem
 * matar processo nenhum, e falha de disco DEPOIS da tentativa sem precisar encher o disco.
 */
function criar(raiz, { agora = Date.now, vivo = vivoPorSinal, disco = fsp } = {}) {
  let ultimaLimpeza = -Infinity;
  const logados = new Map();   // origem -> código/mensagem já impresso

  function logarUmaVez(origem, erro) {
    const marca = erro && (erro.code ?? erro.message);
    if (logados.get(origem) === marca) return;
    logados.set(origem, marca);
    console.error(`livro de entregas: ${origem} — ${erro && erro.message ? erro.message : erro}`);
  }

  /** A reserva no disco é órfã? `true`/`false`, ou `null` quando ela sumiu no meio da pergunta. */
  async function orfa(arquivo) {
    let texto;
    try { texto = await disco.readFile(arquivo, 'utf8'); }
    catch (erro) { if (erro.code === 'ENOENT') return null; throw erro; }
    let dados = null;
    try { dados = JSON.parse(texto); } catch { /* ilegível: a idade sai do mtime, abaixo */ }
    if (dados && Number.isInteger(dados.pid) && Number.isFinite(dados.desde)) {
      if (agora() - dados.desde > TETO_RESERVA_MS) return true;
      // Reserva DESTE processo cujo token não está em voo aqui: uma que não conseguimos soltar,
      // ou o pid reusado pelo processo novo depois de um restart.
      if (dados.pid === process.pid) return !emVoo.has(dados.token);
      return !vivo(dados.pid);
    }
    let info;
    try { info = await disco.stat(arquivo); }
    catch (erro) { if (erro.code === 'ENOENT') return null; throw erro; }
    return agora() - info.mtimeMs > PRAZO_ILEGIVEL_MS;
  }

  async function criarReserva(arquivo, token) {
    const conteudo = JSON.stringify({ pid: process.pid, token, desde: agora() });
    try { await disco.writeFile(arquivo, conteudo, { flag: 'wx', mode: 0o600 }); return true; }
    catch (erro) { if (erro.code === 'EEXIST') return false; throw erro; }
  }

  /** `true` = reservou; `false` = outro está tentando agora. */
  async function reservar(arquivo, token) {
    for (let volta = 0; volta < 2; volta += 1) {
      if (await criarReserva(arquivo, token)) return true;
      const situacao = await orfa(arquivo);
      if (situacao === false) return false;
      if (situacao === true) {
        try { await disco.unlink(arquivo); }
        catch (erro) { if (erro.code !== 'ENOENT') throw erro; }
      }
      // `null`: foi solta entre o EEXIST e a leitura — tenta criar de novo.
    }
    return false;   // perdeu a corrida duas vezes: alguém acabou de reservar
  }

  /**
   * Solta a reserva só se ela ainda for NOSSA. Um dono antigo que perdeu a reserva no teto e
   * volta depois não apaga a de quem assumiu. Ler e apagar são duas operações: a corrida no
   * meio delas está declarada na spec (§2.7) — custa, no pior caso, uma entrega a mais.
   */
  async function soltar(arquivo, token) {
    try {
      const dados = JSON.parse(await disco.readFile(arquivo, 'utf8'));
      if (dados.token !== token) return;
      await disco.unlink(arquivo);
    } catch (erro) {
      if (erro.code !== 'ENOENT') logarUmaVez('soltar a reserva', erro);
    }
  }

  /** O desfecho final gravado, ou `null`. Arquivo que existe e não se lê ainda é final. */
  async function lerFinal(arquivo) {
    let texto;
    try { texto = await disco.readFile(arquivo, 'utf8'); }
    catch (erro) { if (erro.code === 'ENOENT') return null; throw erro; }
    try {
      const { desfecho } = JSON.parse(texto);
      if (FINAIS.has(desfecho)) return desfecho;
    } catch { /* criado e não escrito: o desfecho JÁ era final quando ele nasceu */ }
    return 'aceito';
  }

  async function gravarFinal(arquivo, desfecho) {
    try {
      await disco.writeFile(arquivo, JSON.stringify({ desfecho, em: agora() }), { flag: 'wx', mode: 0o600 });
    } catch (erro) {
      // EEXIST: outro já finalizou este aparelho — fica o dele, que nunca é rebaixado.
      if (erro.code !== 'EEXIST') logarUmaVez('gravar o desfecho', erro);
    }
  }

  /** Apaga eventos parados há mais de RETENCAO_MS. Devolve quantos apagou. */
  async function limpar() {
    let nomes;
    try { nomes = await disco.readdir(raiz); }
    catch (erro) { if (erro.code === 'ENOENT') return 0; throw erro; }
    let apagados = 0;
    for (const nome of nomes) {
      const alvo = path.join(raiz, nome);
      const info = await disco.stat(alvo).catch(() => null);
      if (!info || !info.isDirectory() || agora() - info.mtimeMs <= RETENCAO_MS) continue;
      await disco.rm(alvo, { recursive: true, force: true });
      apagados += 1;
    }
    return apagados;
  }

  /**
   * O carimbo é gravado ANTES de qualquer `await`: `avisar()` chama `umaVez` para N aparelhos
   * dentro de um `Promise.all`, e sem isso as N passariam pela checagem e disparariam N
   * limpezas. E a limpeza não é esperada — o primeiro aviso da hora não paga um `readdir`.
   */
  function limparDeVezEmQuando() {
    const instante = agora();
    if (instante - ultimaLimpeza < INTERVALO_LIMPEZA_MS) return;
    ultimaLimpeza = instante;
    limpar().catch((erro) => logarUmaVez('limpeza', erro));
  }

  function naoReenviado(evento, aparelho, motivo, rotulo) {
    // É o que mostra, no journal, que a dedupe disparou. Raro por natureza: só existe com dois
    // observadores ou com um reenvio. Os dois ids são resumos — nada de endpoint em claro.
    // O `rotulo` é o nome do aparelho, quando quem chama tem um curto o bastante para servir de
    // rótulo (lib/avisos.js). Sem ele a linha sai byte a byte como sempre saiu.
    console.log(`livro de entregas: aviso ${evento.slice(0, 8)} → aparelho ${aparelho.slice(0, 8)}${rotulo ? ` (${rotulo})` : ''}: ${motivo}, não reenviado`);
  }

  /**
   * Uma tentativa, no máximo, por (evento, aparelho) sem desfecho final.
   *
   * `tentar()` faz UMA tentativa — sem espera de backoff dentro: a reserva existe enquanto ele
   * roda — e devolve 'aceito' | 'descartado' | 'falhou' | 'incerto'.
   *
   * Devolve `{ tentou: true, desfecho }` ou `{ tentou: false, motivo }`, com motivo 'aceito' ou
   * 'descartado' (resolvido: tirar da fila) ou 'em-voo' (outro está tentando: reagendar).
   * Nunca rejeita por causa do livro — só se `tentar` lançar.
   */
  async function umaVez(evento, endpoint, tentar, { rotulo = null } = {}) {
    if (!evento) return { tentou: true, desfecho: normalizar(await tentar()) };
    limparDeVezEmQuando();

    const pasta = path.join(raiz, evento);
    const aparelho = resumo(String(endpoint));   // o endpoint é credencial: nunca em claro no disco
    const arqReserva = path.join(pasta, `${aparelho}.reserva`);
    const arqFinal = path.join(pasta, `${aparelho}.final`);
    const token = crypto.randomUUID();
    // ANTES de a reserva existir: se entrasse depois, outra chamada DESTE processo leria a
    // reserva recém-criada com o nosso pid e um token fora de voo, e a roubaria como órfã.
    emVoo.add(token);

    let reservou = false;
    try {
      await disco.mkdir(pasta, { recursive: true, mode: 0o700 });
      reservou = await reservar(arqReserva, token);
      if (!reservou) {
        emVoo.delete(token);
        naoReenviado(evento, aparelho, 'em-voo', rotulo);
        return { tentou: false, motivo: 'em-voo' };
      }
      // A ÚNICA conferência do final, com a reserva na mão: quem termina grava o final ANTES
      // de soltar a reserva, então quem reserva depois sempre o vê.
      const final = await lerFinal(arqFinal);
      if (final) {
        await soltar(arqReserva, token);
        emVoo.delete(token);
        naoReenviado(evento, aparelho, final, rotulo);
        return { tentou: false, motivo: final };
      }
    } catch (erro) {
      // Livro quebrado (permissão, disco cheio, pasta inválida) não cala o push: envia sem ele.
      if (reservou) await soltar(arqReserva, token);
      emVoo.delete(token);
      logarUmaVez('reserva', erro);
      return { tentou: true, desfecho: normalizar(await tentar()) };
    }

    let desfecho = 'incerto';   // `tentar` que lança conta como incerto — e o erro é relançado
    try {
      desfecho = normalizar(await tentar());
      return { tentou: true, desfecho };
    } finally {
      if (FINAIS.has(desfecho)) await gravarFinal(arqFinal, desfecho);
      // SEMPRE: se gravar o final falhou, prender a reserva faria todo retry ver `em-voo` até
      // o teto, com o disco já recuperado. Soltar custa, no pior caso, um reenvio.
      await soltar(arqReserva, token);
      emVoo.delete(token);
    }
  }

  return { umaVez, limpar };
}

module.exports = { identidade, criar, resumo, TETO_RESERVA_MS, PRAZO_ILEGIVEL_MS, RETENCAO_MS };
