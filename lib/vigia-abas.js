'use strict';
// O vigia central das abas: quem manda a notificação de fim de turno e de pedido de
// intervenção quando ninguém está com o cockpit aberto. Vive FORA do fluxo SSE de propósito —
// `server.js:300` já registrou o raciocínio para sessões, e ele vale aqui: o ponto da
// notificação é justamente o usuário NÃO estar olhando a tela; um relógio pendurado no cano
// SSE morre com o navegador, que é exatamente o caso em que o aviso serve.
//
// Duas metades separadas de propósito (spec 2026-09-10-avisar-fim-e-intervencao-nas-abas):
// `decidir()` é PURA — sem I/O, sem relógio, sem rede — e se prova com fixture; `iniciar()` é
// a casca, com o relógio e as duas travas de segurança (§3.4). Só `menu` (linha.esperando) e
// `fim` (linha.rodando) avisam — `pre-sessao` ficou de fora por ser derivado de AUSÊNCIA (§2.5).

const path = require('node:path');
const abas = require('./abas');
const avisos = require('./avisos');

/**
 * O `Estado` guarda só o que a decisão usa. Nada de `titulo` (o texto do aviso lê
 * `linha.titulo` no instante do envio) nem `sessaoId`/`pane` — cada dono guarda o seu estado,
 * o que se compartilha é a leitura (armadilha #33).
 */
function doZero(linha) {
  return {
    rodando: linha.rodando,
    tela: linha.esperando === true,
    arquivo: linha.arquivo ?? null,
    reiniciada: Boolean(linha.reiniciada),
  };
}

/**
 * Espelha `server.js:314-317` de propósito — dois textos diferentes para a mesma coisa seriam
 * a #40. "O agente parou", não "Turno concluído": `lib/adaptador-codex.js:978` trata
 * `task_complete` e `turn_aborted` como o mesmo `rodando: false` — o dado não sabe se o agente
 * concluiu ou se o usuário apertou Escape.
 */
function construirAviso(tipo, linha, arquivo) {
  const em = linha.cwd ? ` em ${path.basename(linha.cwd)}` : '';
  const { titulo, corpo } = tipo === 'intervencao'
    ? { titulo: `${linha.titulo} precisa de você`, corpo: `Tem uma pergunta aberta no terminal${em}.` }
    : { titulo: `${linha.titulo}: terminou`, corpo: `O agente parou${em}.` };
  return { chave: linha.chave, tipo, titulo, corpo, arquivo };
}

/**
 * A metade pura: decide quem avisa, a partir do estado anterior e da leitura atual de
 * `abas.listar()`. NÃO muta `anterior` — devolve sempre um `Map` novo (armadilha #33: comparar
 * contra um Map que está sendo escrito no meio da passada é a classe de bug que ela registra).
 *
 * `anterior === null` ⇒ semeadura: grava o estado de cada aba e não avisa nada (§2.3) — um
 * restart do serviço nunca vira rajada de notificações.
 */
function decidir(anterior, linhas) {
  const estado = new Map();
  const avisosGerados = [];

  if (anterior === null) {
    for (const linha of linhas) estado.set(linha.chave, doZero(linha));
    return { avisos: avisosGerados, estado };
  }

  for (const linha of linhas) {
    const antes = anterior.get(linha.chave);
    // A regra 1 é um `continue`, e vem PRIMEIRO: `arquivo`, `trocou` e `telaAntes`
    // desreferenciam `antes`, que é `undefined` numa chave nova. Escrito como ramo de tabela
    // avaliado em ordem, seria TypeError na primeira aba que aparecer.
    if (!antes) { estado.set(linha.chave, doZero(linha)); continue; }

    // Dois jeitos de "não sei", e os dois PRESERVAM o último booleano conhecido:
    //   `esperando === null`  → o arquivo do CLI não foi lido (lib/abas.js:568).
    //   `temAgente === false` → detectarAgente() não achou processo; `esperando` sai `false`
    //                           CRAVADO (o ternário de :568 cai no ramo do não-Claude), e
    //                           `false` por ausência de detecção é indistinguível de "sem
    //                           menu". Sem isto, `waiting → falha → waiting` reemite a MESMA
    //                           pergunta e o aparelho vibra de novo.
    const naoSei = linha.esperando === null || linha.temAgente === false;
    const tela = naoSei ? Boolean(antes.tela) : linha.esperando === true;
    // `arquivo` segue a MESMA regra: `null` é "não sei", não "trocou" — a falha de leitura zera
    // os dois campos juntos (lib/abas.js:568 e :595), e ler a VOLTA como troca reemitiria o
    // menu.
    const arquivo = linha.arquivo ?? antes.arquivo ?? null;
    // O `&&` é de `server.js:575`, mas o PORQUÊ aqui é outro: `arquivo → null` acontece quando
    // o CLI morre e no `/clear` do Claude, e nos dois a aba de fato parou — contar como "troca"
    // suprimiria um `fim` verdadeiro. O `/clear` do Codex já é tratado pelo `reiniciada` da
    // regra 3; duas guardas para o mesmo caso seriam a #40.
    const trocou = Boolean(linha.arquivo) && linha.arquivo !== antes.arquivo;
    // A comparação da regra 2 desconsidera o anterior na troca — conversa nova é pergunta
    // nova. NÃO se zera o `tela` observado: isso SUPRIMIRIA o aviso, que é o oposto do que se
    // quer.
    const telaAntes = trocou ? false : Boolean(antes.tela);

    let avisado = false;
    if (tela && !telaAntes) {
      avisosGerados.push(construirAviso('intervencao', linha, arquivo));
      avisado = true;
    }
    // A regra 3 só cede a um aviso REALMENTE emitido — se a intervenção foi suprimida (ex:
    // já estava esperando), o fim continua elegível.
    if (!avisado && antes.rodando === true && linha.rodando === false
        && linha.reiniciada !== true && !trocou) {
      avisosGerados.push(construirAviso('fim', linha, arquivo));
    }

    estado.set(linha.chave, { rodando: linha.rodando, tela, arquivo, reiniciada: Boolean(linha.reiniciada) });
  }

  return { avisos: avisosGerados, estado };
}

const validoPara = (tipo) => (tipo === 'intervencao' ? (e) => e.tela : (e) => e.rodando !== true);

/**
 * Sobe o vigia. `listar`/`avisar` entram por parâmetro para o gate injetar fixture e espião —
 * sem isso o gate provaria só a função pura, e a reentrância, a recuperação de erro e o
 * `unref` ficariam sem prova nenhuma.
 *
 * Devolve `null` quando a feature está desligada (sem contato válido ou intervalo fora da
 * faixa) — nesses casos NENHUM relógio é armado.
 */
function iniciar({
  // `??` NÃO serve aqui: `Environment=COCKPIT_VIGIA_MS=` na unit vira `''`, e `Number('')` = 0
  // ⇒ feature desligada por um valor que parece "deixa o padrão".
  intervaloMs = Number((process.env.COCKPIT_VIGIA_MS || '').trim() || 5000),
  listar = abas.listar,
  avisar = avisos.avisar,
} = {}) {
  // 1. FORMATO do contato, não presença. `lib/avisos.js:20-30` só aceita mailto:/HTTPS, então
  //    `COCKPIT_CONTATO=teste` passaria por um teste de truthiness e cada batida estouraria
  //    503. Reusar o dono da regra é o hábito da #40.
  //
  //    Isto é TAMBÉM a trava de isolamento dos testes (#57): a variável não é só "o e-mail do
  //    VAPID". Produção a recebe da unit (EnvironmentFile=~/cofre/cockpit.env); teste nenhum lê
  //    o cofre nem passa --env-file. É o que impede um smoke rodado à mão de mandar push de
  //    verdade para o aparelho do dono.
  //
  //    Calado quando alguém desligou de propósito (`=0`): senão os arquivos que sobem o
  //    servidor ganham uma linha de stderr cada. Ruído fixo treina a ignorar.
  try { avisos.exigirContato(); }
  catch (e) {
    if (process.env.COCKPIT_VIGIA_MS !== '0') console.error(`vigia de abas desligado: ${e.message}`);
    return null;
  }

  // 2. Faixa. O TETO não é zelo: `setInterval` guarda o atraso num int32, e acima de
  //    2147483647 o valor vira 1 ms com TimeoutOverflowWarning — um COCKPIT_VIGIA_MS grande,
  //    posto para bater MENOS, faria varrer o tmux mil vezes por segundo. O PISO é o oposto:
  //    `listar()` custa ~37 ms de parede, e menos que isso só enfileira batidas que a flag
  //    `ocupado` descarta.
  const PISO = 1000;
  const TETO = 3600000;
  if (!Number.isFinite(intervaloMs) || intervaloMs < PISO || intervaloMs > TETO) {
    if (process.env.COCKPIT_VIGIA_MS !== '0') {
      console.error(`vigia de abas desligado: COCKPIT_VIGIA_MS fora da faixa (${process.env.COCKPIT_VIGIA_MS})`);
    }
    return null;
  }

  let anterior = null;   // null = ainda não semeou (§2.3)
  let ocupado = false;
  const emVoo = new Map();          // chave -> { promessa, cancelado, valido, arquivo }
  const ultimosLogados = new Map(); // origem -> `${erro.code ?? erro.message}` já impresso

  /**
   * Deduplica por `origem + erro.code/message`, NÃO pela frase inteira: guardar "a última
   * mensagem" não serve quando o texto carrega a chave da aba — o mesmo erro de disco
   * alternando entre A e B produziria mensagens sempre diferentes e imprimiria todas. `origem`
   * é o TIPO do ponto de falha ('envio', 'batida'), não a aba; o texto impresso pode citar a
   * aba, a chave de dedup não.
   */
  function logarUmaVez(origem, erro, contexto) {
    const marca = erro && (erro.code ?? erro.message);
    if (ultimosLogados.get(origem) === marca) return;
    ultimosLogados.set(origem, marca);
    console.error(`vigia de abas: ${contexto || origem} — ${erro && erro.message ? erro.message : erro}`);
  }

  /**
   * Uma aba tem no máximo UM aviso em voo, e o mais novo VENCE: substituir, não enfileirar.
   * `lib/push.js:136` dá 15 s de timeout contra 5 s de batida — uma fila cresceria e acabaria
   * entregando perguntas já respondidas.
   */
  function enviarUltimo(chave, tarefa, valido, arquivo) {
    const anteriorEmVoo = emVoo.get(chave);
    if (anteriorEmVoo) anteriorEmVoo.cancelado = true;   // o que ainda não saiu não sai mais
    const ficha = { cancelado: false, valido, arquivo };
    // Checa ANTES de partir, e só: não há como abortar um push em voo, e não fingimos que há.
    const rodar = () => (ficha.cancelado ? undefined : tarefa());
    const limpar = () => { if (emVoo.get(chave) === ficha) emVoo.delete(chave); };
    ficha.promessa = (anteriorEmVoo?.promessa ?? Promise.resolve())
      .then(rodar, rodar)
      // `.then(fn, fn)`, NUNCA `.finally(fn)`: o `finally` devolve uma promessa NOVA que
      // rejeita junto com a original, e essa ninguém trata — rejeição não tratada derruba o
      // processo no Node 22.
      .then(limpar, (erro) => { logarUmaVez('envio', erro, `aviso de ${chave}`); limpar(); });
    emVoo.set(chave, ficha);
  }

  async function bater() {
    // 1. try/catch em volta de tudo: em Node 22, rejeição não tratada dentro de um
    //    `setInterval(async …)` mata o PROCESSO (server.js:988-993).
    // 2. Flag `ocupado`, liberada ANTES dos envios: um push lento não pode segurar o relógio.
    if (ocupado) return;
    ocupado = true;
    try {
      const linhas = await listar();
      const { avisos: pendentes, estado: novo } = decidir(anterior, linhas);
      // 3. A troca de estado é síncrona: `decidir()` roda inteira sem `await`, e só depois é
      //    que os envios partem.
      anterior = novo;
      ocupado = false;

      for (const aviso of pendentes) {
        enviarUltimo(aviso.chave, () => avisar({
          titulo: aviso.titulo, corpo: aviso.corpo,
          // NÃO é id de sessão: é a CHAVE DA ABA (`aba-p7`). O sw.js põe em `data.sessaoId`,
          // monta `./#c=<valor>` e o cliente chama `abrirAba(<valor>)` (public/app.js:6088,
          // DECISOES.md:812) — que espera chave de aba. O nome é herança do fluxo de sessões
          // e está mentindo; renomear obrigaria a mexer em sw.js + fluxo de sessões, fora do
          // escopo.
          sessaoId: aviso.chave, tag: aviso.chave,
        }), validoPara(aviso.tipo), aviso.arquivo);
      }

      // 5. Revalidar as pendências no fim, com o Estado recém-calculado — nunca a linha crua.
      for (const [chave, ficha] of emVoo) {
        if (ficha.cancelado) continue;
        const agora = anterior.get(chave);
        if (!agora || agora.reiniciada || ficha.arquivo !== agora.arquivo || !ficha.valido(agora)) {
          ficha.cancelado = true;
        }
      }
    } catch (erro) {
      ocupado = false;
      logarUmaVez('batida', erro, 'a varredura de abas falhou');
    }
  }

  bater();   // a primeira batida sai na SUBIDA e é muda (semeadura, §2.3)
  const relogio = setInterval(bater, intervaloMs);
  relogio.unref();   // não segura o event loop
  // É o que separa "o vigia não subiu" de "o aviso não saiu" quando P5/P6 falhar.
  console.log(`vigia de abas ativo (${intervaloMs} ms)`);

  return {
    parar: () => clearInterval(relogio),
    // Expostos só para o gate: a produção nunca chama `bater()` na mão nem inspeciona
    // `relogio` — quem dispara é o próprio relógio. Sem isto, provar reentrância, ordem e
    // revalidação exigiria esperar minutos de relógio real a cada `npm test`.
    bater, relogio,
  };
}

module.exports = { decidir, iniciar };
