#!/usr/bin/env node
'use strict';
// Só testes offline ou com providers locais. Nunca execute gates pagos por descoberta.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-offline-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(COCKPIT_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/.test(key)) delete env[key];
Object.assign(env, { HOME: temp, CODEX_HOME: path.join(temp, '.codex'), HOST: '127.0.0.1',
  COCKPIT_CERT_DIR: '/dev/null', COCKPIT_TMUX_SOCKET: `cockpit-offline-${process.pid}`,
  COCKPIT_BIN_CODEX: '/usr/bin/codex', COCKPIT_BIN_CLAUDE: '/usr/bin/claude',
  // O vigia de abas (lib/vigia-abas.js) desligado para todo gate que sobe server.js — sem
  // isso ele ganharia um relógio de tmux dentro. COCKPIT_PUSH_DIR não é redundante com o
  // HOME falso: ela VENCE o HOME (lib/avisos.js:17).
  COCKPIT_VIGIA_MS: '0', COCKPIT_PUSH_DIR: path.join(temp, 'push'),
  // O amostrador do monitor escreve desde o boot; a env vence o HOME (#62). Relógio desligado
  // e pasta temporária, como a COCKPIT_PUSH_DIR.
  COCKPIT_MONITOR_DIR: path.join(temp, 'monitor'), COCKPIT_MONITOR_MS: '0',
  // #78: `du`/`docker`/`gh` falsos; gate que esquecer cai em "indisponível", nunca no real (D97: o `gh` fala com o GitHub).
  COCKPIT_DU_BIN: path.join(temp, 'sem-du'), COCKPIT_DOCKER_BIN: path.join(temp, 'sem-docker'),
  COCKPIT_GH_BIN: path.join(temp, 'sem-gh'),
  // Faixa PROD FORA (D87): a env VENCE o HOME falso (#62) — sem ela, qualquer gate que exporte a
  // variável no shell leria o arquivo real do vigia de prod.
  COCKPIT_VIGIA_PROD_ARQ: path.join(temp, 'sem-vigia', 'estado.json'),
  // Painel de Finanças (D90): a env VENCE o HOME falso (#62).
  COCKPIT_FINANCAS_DIR: path.join(temp, 'sem-financas') });
delete env.PORT;
delete env.PORTA_PAINEL;
const tests = ['gate-idioma.js', 'gate-confianca.js', 'gate-instalacao.js', 'gate-clear-codex.js', 'gate-envio-skill-codex.js',
  'gate-fila-pendente.js', 'gate-jobs-disco.js', 'gate-jobs-rota.js',
  // A tela "Pra revisar" (plano 2026-10-04-tela-pra-revisar-plano.md) entrou em 04/10/2026.
  // Mesmo molde de portas do `gate-jobs-rota.js` — precisa da mesma guarda contra o
  // COCKPIT_TMUX_SOCKET herdado, logo abaixo. `gate-revisar-md.js` é Node puro (sem server,
  // sem porta): as funções puras de markdown/smoke de `public/revisar.js`.
  'gate-revisar.js', 'gate-revisar-md.js',
  // Prévia do merge no Pra revisar (card `pra-revisar-aviso-de-conflito-no-merge`): Node puro
  // (sem server, sem porta), repos de fixture no tmp. Nasceu VERMELHO.
  'gate-merge-previa.js',
  // O Pra revisar acompanha o job que termina (card `pra-revisar-nao-atualiza-sozinho`, D76): Node
  // puro (app.js + revisar.js num `vm`, sem server, sem porta). Nasceu VERMELHO.
  'gate-revisar-transicao.js',
  // A rota `GET /api/historico` (card `carregar-mais-historico`) entrou em 16/09/2026. Mesmo
  // molde de portas do `gate-jobs-rota.js` — precisa da mesma guarda contra o
  // COCKPIT_TMUX_SOCKET herdado, logo abaixo.
  'gate-historico-rota.js',
  'gate-ui.js', 'gate-codex.js',
  // O gate-uso.js voltou para esta lista em 25/09/2026 (card `tela-de-uso-no-fuso-do-aparelho`):
  // as fixtures são de 04/09 e um relógio fixo é determinístico para sempre (spec D10). Roda
  // com o relógio de `testes/relogio-04-09.js`, injetado só para ele logo abaixo.
  'gate-uso.js',
  // O relatório de tokens do Codex (card `codex-no-relatorio-de-tokens`, `lib/uso-codex.js`)
  // entrou em 22/09/2026. Nasce VERDE — assim como `gate-uso.js`, que voltou a esta lista em
  // 25/09/2026 (card `tela-de-uso-no-fuso-do-aparelho`) — e gate que não roda no `npm test` não
  // é gate, é documentação (mesma lição do `gate-eco-bash`, abaixo).
  'gate-uso-codex.js',
  // A parte 2 (a rota, `gate-uso-codex.js parte2`) entra aqui em 25/09/2026 (card
  // `tela-de-uso-no-fuso-do-aparelho`): hoje ela só rodava com o argumento `parte2` na mão, e
  // o runner nunca passava argumento — nem o GC9 rodava aqui. Sobe `server.js` na 7894 e se
  // isola sozinha (delete COCKPIT_TMUX_SOCKET, HOME falso — gate-uso-codex.js:330-337).
  'gate-uso-codex.js parte2',
  // O terceiro leitor do contrato (lib/adaptador-job.js) e o job como fonte do fluxo SSE
  // entraram em 12/09/2026 (card `ver-a-conversa-do-job`). Mesma lição do gate-eco-bash: gate
  // que não roda aqui não é gate, é documentação.
  'gate-adaptador-job.js', 'gate-job-fluxo.js',
  // Os dois ecos (bash mode e comando de barra) entraram aqui em 10/09/2026: o gate-eco-bash
  // vivia FORA desta lista e passou dois dias vermelho sem ninguém ver — a fixture dele tinha
  // data cravada e venceu o teto de 30 min da pendente. Gate que não roda no `npm test` não é
  // gate, é documentação.
  // O terceiro eco (mensagem escrita com o agente trabalhando) entrou em 11/09/2026, no mesmo
  // dia em que o defeito foi medido no `.jsonl`.
  // O quarto eco (colagem embrulhada em <pasted_content>, Claude Code 2.1.280) entrou em 24/09/2026.
  'gate-eco-bash.js', 'gate-eco-comando.js', 'gate-eco-mid-turn.js', 'gate-colagem-embrulhada.js',
  // A "\" final que a TUI do Claude come (card `fila-presa-com-barra-invertida-no-fim`, #100) entrou
  // em 13/10/2026: Node puro, sem server, sem porta. Nasceu VERMELHO.
  'gate-barra-final.js',
  // A saída do `!` em cartão de terminal (card `saida-do-comando-em-cartao`, D79) entrou em 11/10/2026: Node
  // puro, HOME falso. Nasceu VERMELHO — gate que não roda no `npm test` não é gate, é documentação.
  'gate-saida-comando.js',
  // O vigia de abas (lib/vigia-abas.js) entrou em 11/09/2026. Ele domina COCKPIT_CONTATO e
  // COCKPIT_VIGIA_MS no PRÓPRIO processo (setando e removendo por caso) — sem isso, o
  // COCKPIT_VIGIA_MS:'0' que esta lista injeta para os outros gates faria iniciar() devolver
  // `null` em todo caso que precisa de relógio vivo.
  // O livro de entregas (lib/entregas.js) entrou em 11/09/2026. Ele domina COCKPIT_PUSH_DIR e
  // COCKPIT_CONTATO no próprio processo, como o gate do vigia.
  'gate-vigia-abas.js', 'gate-entregas.js',
  // A fila de reenvio do push (lib/avisos.js) entrou em 11/09/2026: transporte simulado +
  // relógio controlado; sobe um servidor filho isolado (COCKPIT_JOBS_DIR próprio) para o R19.
  'gate-push-retry.js',
  // O nome do aparelho (lib/avisos.js: listar/renomear/idDe + as 2 rotas) entrou em 15/09/2026:
  // pasta de push própria (R1 — sem ela o gate RENOMEARIA os aparelhos vivos do dono) e um
  // servidor filho em porta sorteada para as rotas.
  'gate-aparelhos.js',
  // O mapa de "lido" no servidor (lib/lidas.js) entrou em 14/09/2026: sobe server.js filho
  // (COCKPIT_JOBS_DIR/COCKPIT_LIDAS_DIR próprios) e traz junto a varredura durável (caso 14)
  // que impede um smoke novo de escrever no ~/.cockpit de produção.
  'gate-lidas.js',
  // D69: o fim de turno se VÊ ou se CONFIRMA (lib/terminou.js). Node puro — sem servidor, sem tmux,
  // sem disco; a fiação do server.js é por texto-fonte.
  'gate-terminou.js',
  // A aba que troca de sessão no tmux (`move-window`, 06/10/2026, incidente em produção) entrou
  // aqui no mesmo dia: tmux REAL em socket isolado + /proc falso + server.js filho na 7888.
  // Nasceu VERMELHO no código anterior (chave "sessão:@janela.%pane") e ficou verde com a
  // chave "@janela.%pane" — gate que não roda no `npm test` não é gate, é documentação.
  'gate-aba-movida.js',
  // A aba com Agent em background segurava `status: busy` no CLI (card
  // `trabalhando-nao-distingue-subagente`, 14/10/2026): tmux real em socket isolado + /proc
  // falso + server.js filho na 7889. Nasceu VERMELHO — `emBackground` ainda não existe.
  'gate-segundo-plano.js',
  // O cartão vivo do sub-agente (card `ver-os-subagentes-da-aba`, D86, 16/10/2026): a parte
  // pura (lib/externo.js/lib/subagente.js) mais tmux real em socket isolado + /proc falso +
  // server.js filho na 7966 para GET /api/subagente. Nasceu VERMELHO.
  'gate-subagente.js',
  // O progresso das trilhas de leitura (card `leituras-trilhas`, lib/leituras.js) entrou em
  // 02/10/2026: sobe server.js filho (COCKPIT_JOBS_DIR/COCKPIT_LIDAS_DIR/COCKPIT_LEITURAS_DIR/
  // COCKPIT_TRILHAS próprios) e traz junto a varredura durável (R10, molde do caso 14 acima).
  'gate-leituras.js',
  // O menu aberto do Codex (card menu-da-tui-do-codex-na-tela) entrou em 10-11/09: gate fora
  // do runner não é gate, é documentação — mesmo motivo do gate-eco-bash acima.
  'gate-menu-codex.js',
  // O catálogo do menu do Claude (card responder-a-pergunta-pelo-teclado, §4.1/C3) entrou em
  // 18/09: mesma lição — sem ele nesta lista, a medição que sustenta a decisão de NÃO
  // interpretar a TUI (D-D) apodrece no dia em que o Claude Code mudar o formato do prompt.
  'gate-menu-claude.js',
  // O diálogo que o Claude abre sozinho (card mensagem-some-no-menu-do-auto-mode, D85a) — 16/10/2026.
  'gate-menu-claude-dialogo.js',
  // O gesto "sair do menu e falar" (card escrever-texto-na-pergunta-aberta) entrou em
  // 21/09/2026: `estadoDoMenu(aba)` e o gesto Escape → reconfere → cola → Enter em
  // `digitarNaAba`. Mesma lição do gate-eco-bash — gate que não roda no `npm test` não é
  // gate, é documentação.
  'gate-estado-do-menu.js', 'gate-gesto-escape.js',
  // A assinatura do cache de uso (card assinatura-do-cache-guarda-conteudo-em-hex) entrou em
  // 24/09/2026. É um gate de PRIVACIDADE, e o `gate-uso.js` — onde moram G10/G26 — voltou a
  // esta lista em 25/09/2026: sem este aqui, a volta do hex cru passaria sem ninguém ver.
  'gate-assinatura-cache.js',
  // O Enter CONFIRMADO (23/09): o envio só termina quando a caixa do terminal esvazia.
  // Nasceu de defeito medido na pane real, não de hipótese — o retrato da pane travada é
  // uma das asserções (R1), e é ele que quebra se a régua de leitura apodrecer.
  'gate-enter-confirmado.js',
  // O campo Modelo da aba nova (card modelo-na-nova-aba) entrou em 05/10/2026: o modelo
  // escolhido vira `--model <alias>` no comando da aba, validado por lista fechada do
  // registro (`lib/agentes.js`) em três camadas (módulo, rota, HTTP via servidor filho).
  'gate-modelo-aba.js',
  // O teto por MODELO (card medidor-teto-errado-com-haiku) entrou em 06/10/2026: a tabela de
  // janela conhecida em lib/contexto.js:tetoDoModelo. Funções puras, sem disco — nasceu
  // VERMELHO na develop 4f5cab4 (opus-5-5 dava 200k; haiku com [1m] dava 1M).
  'gate-teto-por-modelo.js',
  // O monitor do servidor (card do monitor, D64) entrou em 06/10/2026: fórmulas de
  // CPU/RAM/disco, histórico de 24 h, aviso com histerese, rotas e a rede de isolamento
  // (todo script que sobe server.js). Gate que não roda no npm test não é gate, é documentação.
  'gate-monitor.js',
  // A tela do monitor (faixa, selo, painel): funções puras de public/monitor.js em Node puro e
  // a costura (DIALOGOS, media queries do selo, catálogo de i18n) como texto. Sem servidor.
  'gate-monitor-ui.js',
  // A faixa PROD FORA (D87): o leitor do estado do vigia de prod, a rota GET /api/sites e a
  // costura da tela (faixa vermelha + bolinhas por site). Nasceu VERMELHO.
  'gate-sites.js',
  // O Painel de Finanças (D90): o leitor do resumo diário, a rota POST do PDF e a costura da
  // tela. Nasceu VERMELHO (fase 1); entra aqui já com o F11 (fase 2).
  'gate-financas.js',
  // Nome por painel (card `nome-por-painel`, 07/10/2026): tmux real em socket isolado, sem servidor.
  // Gate que não roda no npm test não é gate, é documentação.
  'gate-nome-por-painel.js',
  // A retomada do claude depois do reboot (card reboot-retoma-o-claude) entrou em 07/10/2026:
  // tmux REAL em socket isolado com `-f /dev/null` e HOME falso, rodando só o bin/retoma-claude.js
  // — nunca o save.sh/restore.sh do resurrect.
  'gate-retoma-claude.js',
  // A trava de conteúdo do bin/prepara-publicacao.js (08/10/2026): linear na sequência sem ponto
  // da fixture de 1,1 MB e ainda pegando chave, *.ts.net e CGNAT. Sem servidor.
  'gate-publicacao.js',
  // O hook do AskUserQuestion (bin/gancho-pergunta.js, D74) entrou em 08/10/2026: Node puro, sem servidor.
  // Afirma exit 0 e stdout/stderr VAZIOS em toda chamada — ele roda dentro de toda sessão do Claude.
  'gate-gancho-pergunta.js',
  // As regras puras da pergunta em cartão (lib/pergunta.js, D74): V1-V6, plano de teclas e `executar` contra a
  // TUI falsa de testes/tui-pergunta-falsa.js, conferida com as telas MEDIDAS. Sem servidor, sem tmux.
  'gate-pergunta.js',
  // O aviso de hook da pergunta não instalado (card `pergunta-sem-gancho-avisa`, 09/10/2026): `estadoDoGancho`
  // lê o settings só leitura, com cache por mtime. Node puro, settings falsos em mkdtemp. Nasceu VERMELHO.
  'gate-gancho-instalado.js',
  // Criar pasta na aba nova (card `criar-pasta-na-aba-nova`, 08/10/2026): a rota POST /api/projetos por
  // HTTP, com server.js filho e a raiz de projetos SEMPRE num mkdtemp. Nasceu VERMELHO (rota inexistente).
  'gate-criar-pasta.js',
  // O extrator multi-linguagem do grafo do projeto (card `grafo-do-projeto-no-cockpit`, Fase 1,
  // 16/10/2026) entrou em três unidades (1a JS/TS, 1b Python, 1c HTML/schema/herança). Node
  // puro, sem servidor, sem porta — fixtures em memória. Nasceu VERMELHO em cada unidade.
  'gate-grafo-extrator.js',
  // Git/loja/hooks do grafo do projeto (mesmo card, Fase 2, 16/10/2026): repos de fixture em
  // mkdtemp, HOME e COCKPIT_GRAFOS_DIR sempre no tmp. Separado em dois pelo orçamento de tempo —
  // gate-grafo-gatilhos.js dispara commit/merge/fetch reais e espera o hook rodar em background.
  'gate-grafo-hook.js', 'gate-grafo-gatilhos.js',
  // O grafo do projeto (card `grafo-do-projeto-no-cockpit`) entrou em 16/10/2026: dashboard
  // vendorizado (Fase 4, Node puro), rotas /api/grafos e /grafo/<projeto>/ (Fase 5, server.js
  // filho na porta 7933, ambiente fechado) e a tela — botão + diálogo (Fase 6, Node puro/vm).
  'gate-grafo-viewer.js', 'gate-grafo-rota.js', 'gate-grafo-tela.js',
  // O botão "Fazer grafo" (card `grafo-botao-fazer-grafo`, 17/10/2026): rota POST /api/grafos/fazer,
  // server.js filho numa release simulada (porta 7942/7944, sem `.git`, loja/cópia no tmp).
  // Separado em dois pelo teto de 120 s — o segundo cobre hook, concorrência e janela do commit.
  'gate-grafo-fazer.js', 'gate-grafo-fazer-hook.js',
  // O mapa simples do grafo (card `grafo-mapa-simples`, D91, 17/10/2026): índice puro + rotas
  // /api/grafos/<nome>/mapa e /mapa/<nome>/, server.js filho na porta 7973. Nasceu VERMELHO.
  'gate-grafo-mapa.js',
  // Diff de commit e de job (card `ver-a-diff-do-codigo`, D95, 19/10/2026): lib/diff.js (parser
  // + git com teto), rotas /api/diff/* e casca /diff/, server.js filho na porta 7987.
  'gate-diff.js',
  // PRs do GitHub (D97): `gh` falso + server.js filho na 7981.
  'gate-diff-prs.js',
  // Regra da casa D96 (19/10/2026): toda tela do cockpit abre DENTRO do app — reprova window.open/_blank/target=
  // fora da lista fechada (link externo de verdade). Node puro, sem servidor, sem porta.
  'gate-dentro-do-app.js'];
try {
  for (const test of tests) {
    console.log(`\n${test}`);
    const [arquivo, ...args] = test.split(' ');
    const testEnv = { ...env };
    // Esse gate cria e valida seu próprio socket, recusando qualquer valor herdado.
    if (arquivo === 'gate-jobs-rota.js' || arquivo === 'gate-historico-rota.js' || arquivo === 'gate-revisar.js') delete testEnv.COCKPIT_TMUX_SOCKET;
    // O gate-uso.js precisa do relógio de 04/09 — as fixtures são cravadas nessa data (spec
    // D10). NODE_OPTIONS (caminho ABSOLUTO) porque o G28 dispara um Node filho por `execFile`
    // (gate-uso.js:1088) que só herda o relógio por essa variável.
    if (arquivo === 'gate-uso.js') {
      testEnv.NODE_OPTIONS = [testEnv.NODE_OPTIONS, `--require ${path.join(root, 'testes', 'relogio-04-09.js')}`]
        .filter(Boolean).join(' ');
    }
    const r = spawnSync(process.execPath, [path.join(root, 'testes', arquivo), ...args], { cwd: root, env: testEnv, stdio: 'inherit', timeout: 120000 });
    if (r.error || r.status !== 0) { console.error(r.error || `Falhou: ${test}`); process.exitCode = 1; break; }
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
