# Changelog

## 0.1.0 — preparação da primeira release pública

- Interface para panes Claude Code e Codex CLI, histórico por SSE, anexos e notificações.
- Instalação local configurável, com acesso remoto escolhido pelo usuário.
- Token obrigatório para bind externo e proteção de origem.
- Aprovações do Codex preservadas por padrão; bypass explícito.
- Correção do envio após `/clear` e `/new`, incluindo mensagem longa.
- Jobs do orquestrador lidos direto do disco (`COCKPIT_JOBS_DIR`), sem serviço externo.
- Tela "Pra revisar": jobs terminados fora da develop do repo deles, com veredito e roteiro de smoke — só leitura.
- Lista de conversas chata: sem grupo por projeto, mais recente primeiro, uma linha por conversa.
- Lista de conversas: a ordem é a hora em que o último turno terminou — abrir, escrever e trocar de aba não mexem na fila.
- Monitor do servidor: CPU, RAM e disco na lateral, painel de 24 h e aviso a 90 %.
- Monitor maior: tela cheia no celular, toque em CPU, RAM ou disco para ver o top 10 — no disco, as pastas que mais ocupam e o Docker.
- Faixa PROD FORA: o Cockpit lê o estado de um vigia de prod externo e mostra uma faixa vermelha em toda tela, com uma bolinha por site na faixa do monitor.
- Painel de Finanças: diálogo que lê o resumo financeiro diário de um gerador externo (saldo, renda × gasto por mês, categorias, reembolsos) e manda o PDF do relatório para um aparelho do tailnet.
- Para onde vão meus tokens: a Sonnet 5.5 tem preço (antes caía em "sem preço conhecido" e o total virava piso).
- Pra revisar v2: repo sem develop compara com main; job retomado some; branch sumida vai pra Atenção; branch contida vira detalhe.
- Aba nova: o campo Projeto filtra ao digitar (sem acento e sem caixa), escolhe pelo teclado e recusa nome que não está em ~/projetos.
- A aba nova cria a pasta que não existe: "+ Criar pasta" no fim da lista do campo Projeto (POST /api/projetos).
- Renomear uma aba de janela dividida muda só aquele painel; no terminal a janela mantém um nome.
- Depois de um reboot, as panes que tinham Claude Code voltam com a mesma conversa (ganchos do tmux-resurrect).
- Arrastar a conversa da lista para a área dos painéis abre ao lado, troca ou move o painel, com preview antes de soltar (D73).
- A pergunta do agente (AskUserQuestion) vira cartão: texto inteiro, opções com descrição, "Outra resposta" e um "Enviar respostas"; lida de um hook do Claude Code (`bin/gancho-pergunta.js instalar`). O terminal cru de qualquer menu quebra linha (D74).
- Pra revisar: cada job mostra se o merge na develop sai limpo, com conflito (e em quais arquivos) ou só no roadmap.json — só leitura.
- Pra revisar acompanha o job que termina: o número do ícone e a lista aberta se atualizam sem recarregar.
- A saída de `!comando` vira um cartão de terminal com `$ comando` no topo — também quando o `!` sai do cockpit com o agente trabalhando —, e saída que é JSON inteiro aparece indentada, recolhida em 10 linhas (D79, D80).
- Suíte offline, documentação de contribuição e licenças dos assets.
- Pra revisar: job já entregue (meta `merged`/`teardown`) sai da lista, e job que parou pedindo decisão vai pro filtro Atenção com "pede decisão" — nunca mais Pronto.
- Cartão do sub-agente na fita: tipo, descrição, "rodando · tempo" ou "terminou em", ✓ só no fim de verdade; tocar abre os passos e a resposta final; o "livre · N agente(s) em background" leva até ele (D86).
- Grafo do projeto: botão Grafos na lateral, um grafo por projeto, sempre da develop, gerado por hook do git e desenhado com o dashboard do understand-anything.
- Botão "Fazer grafo": projeto com develop e sem grafo ganha um botão ativo que gera o grafo pela própria tela (sem IA) e instala o hook do git — "gerando…" enquanto roda, erro ou aviso numa linha se algo não sair como esperado.
- Mapa simples do grafo: o botão "Grafo" abre um mapa leve, um nível por vez — camadas como blocos com as ligações mais fortes, a pasta com a lista de arquivos, o arquivo com quem ele usa e quem usa ele. O servidor manda só o pedaço da vez (KB); o dashboard completo continua no link "Visão completa".
- Cartão do sub-agente legível: o resumo "N passos" recolhe só a lista de passos (nasce recolhida) e o pedido aparece formatado — título, campos ligados e o texto em markdown, com "mostrar o pedido inteiro" (D93).
- Ver a diff do código: página própria com a lista de commits da develop de cada projeto, o commit aberto (cabeçalho, um bloco recolhível por arquivo, lado a lado no desktop e uma coluna no celular) e a diff de um job — o que o merge traria. Entradas: "Ver mudanças" no Pra revisar e no painel do job, botão Commits na lateral. Só leitura (D95).

Esta versão depende dos formatos internos dos CLIs. Veja os limites no README.
