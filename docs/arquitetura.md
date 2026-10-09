# Arquitetura

O navegador envia mensagens por HTTP e acompanha eventos por SSE. O servidor identifica o agente vivo em cada pane tmux e lê o histórico produzido pelo CLI. O processo do agente continua existindo quando o servidor ou o navegador reinicia.

| Arquivo | Responsabilidade |
|---|---|
| `server.js` | Rotas HTTP, SSE, configuração e lista de projetos |
| `lib/acesso.js` | Validação de bind, origem e token |
| `lib/abas.js` | Associação de panes, envio serializado e ciclo de vida das abas |
| `lib/agentes.js` | Registro de CLIs e política de inicialização |
| `lib/externo.js` / `lib/adaptador-codex.js` | Leitura e tradução dos arquivos dos CLIs |
| `lib/clear-codex.js` / `lib/status-codex.js` | Reset confirmado e snapshots de status |
| `public/app.js` | Fita de eventos, painéis, fila visual e interação |
| `lib/arquivos.js` / `lib/avisos.js` | Arquivos e notificações |

A sessão tmux e o socket são configuração do servidor. O cliente manda uma chave de pane e um nome de projeto, não comandos livres de shell ou caminhos de executável. A criação de aba valida o binário e usa a lista de projetos do servidor.

O histórico é a fonte persistente da conversa. Pendentes ainda sem eco ficam na memória do servidor. A associação de Codex é conservadora: quando os dados não distinguem duas sessões, a tela informa a ambiguidade. Escolher o arquivo mais recente esconderia o erro e poderia enviar uma mensagem ao destino errado.

`lib/sessoes.js` e os gates de fase 1/2/3 pertencem ao fluxo legado de sessões próprias. São mantidos para compatibilidade e não são o caminho principal da interface atual. Não execute esses gates sem entender o uso de modelos reais.

`/api/jobs` filtra por `origin === 'capitao'` (a decisão sobre alargar esse filtro pra sempre continua em aberto). O ramo `?revisar=1` (tela "Pra revisar", D60) é a ÚNICA exceção: alarga o filtro de origem só pra ele mesmo, porque a regra de "quem ainda não entrou na develop" vale pra job disparado de qualquer origem, não só pela caixa de envio do app. A resposta tem `jobs[]` e `atencao[]` (branch sumida), cada job com `retomou[]`/`inclui[]`; a regra vive em `lib/revisar.js`, 1:1 com o oráculo v2 do esteira-jobs (D70). Cada item de topo leva `merge` (`{ estado, base, n, arquivos }` ou `null`), prévia só leitura (`lib/revisar.js` `previaDoMerge`, D75), que não filtra e não escreve no repo.

## Decisões que orientam os adaptadores

As CLIs mantêm o login e executam os turnos; o Cockpit não cria uma assinatura ou autenticação paralela. A tela não deve escolher um arquivo por recência para esconder ambiguidade. O conteúdo das conversas vem dos arquivos dos CLIs, não de parsing da tela do terminal. A captura de tela tem usos restritos: menus identificados e a resposta do `/status` nativo.

No medidor, percentuais de `utilization` e frações de `used / total` são escalas diferentes. Preserve a unidade declarada na origem. Eventos de limite do stream `claude -p` não estão garantidos no arquivo JSONL da conversa. Esses contratos têm fixtures próprias nos gates de uso e limites.
