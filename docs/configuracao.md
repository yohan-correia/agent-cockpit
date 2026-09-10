# Configuração

Copie `.env.example` para `.env` e ajuste apenas o que seu setup precisa. O arquivo é lido pelo Node ao usar `npm start` ou a unit gerada. Caminhos precisam ser absolutos: `~` e `$HOME` não são expandidos no `.env`. Variáveis exportadas no processo têm precedência. Reinicie o servidor depois de mudar a configuração.

## Notificações e arquivos

| Variável | Padrão | Efeito |
|---|---|---|
| `COCKPIT_CONTATO` | Não definido | Contato VAPID real de quem opera: `mailto:voce@example.com` ou URL HTTPS. Sem ele, ativar Web Push retorna uma mensagem de configuração; o chat continua funcionando |
| `COCKPIT_PLANO` | Não definido | Rótulo informativo do plano. Não modifica cobrança, assinatura ou limites |
| `COCKPIT_INBOX` | `~/taildrop-inbox` | Raiz dos arquivos recebidos e das pastas de destino de uploads |
| `COCKPIT_BIN_TAILSCALE` | `/usr/bin/tailscale` | Executável Tailscale; confira com `command -v tailscale` |
| `COCKPIT_TAILSCALE_SOCKET` | `/var/run/tailscale/tailscaled.sock` | Socket local do daemon Tailscale |
| `COCKPIT_TETO_ARQUIVO` | `2147483648` bytes (2 GiB) | Teto por upload. Ajuste também o limite do proxy, se houver |

Os endereços `example.com` acima são exemplos, não contatos prontos para usar. O contato VAPID é enviado ao serviço de push do navegador; use um endereço de suporte que você aceita compartilhar com esse serviço. As chaves VAPID são geradas e guardadas localmente; não as troque para mudar apenas o contato.

Para usar Taildrop, configure o Tailscale no servidor e permita ao mesmo usuário Linux do Cockpit acessar o daemon e a CLI sem `sudo`. O chat não depende dessa integração. No painel **Arquivos**, **Puxar tudo** recebe a fila Taildrop na raiz de `COCKPIT_INBOX`. Nomes repetidos são renomeados, sem sobrescrever os arquivos existentes.

A pasta `_triagem` é criada dentro do inbox quando a lista de destinos é consultada. Os uploads do navegador usam uma das subpastas disponíveis; você pode criar outras subpastas no inbox. Os anexos de conversa ficam separados, em `~/.cockpit/anexos`. Para mudar o inbox, por exemplo, defina `COCKPIT_INBOX=/srv/cockpit/inbox` no `.env` e conceda escrita nessa pasta ao usuário que roda o servidor.

## Opções avançadas

| Variável | Padrão | Uso |
|---|---|---|
| `COCKPIT_SILENCIO_UPLOAD_MS` | `120000` ms | Timeout de inatividade no upload |
| `COCKPIT_SILENCIO_MS` | `300000` ms | Timeout de inatividade geral das requisições |
| `COCKPIT_CARENCIA_ABA_MS` | `30000` ms | Tempo para identificar o nascimento do agente; faixa aceita: 50–600000 |
| `COCKPIT_CERT_DIR` | `~/.cockpit/cert` | Certificados com nomes legados `servidor.crt` e `servidor.key`; prefira `COCKPIT_TLS_CERT` e `COCKPIT_TLS_KEY` |
| `COCKPIT_PUSH_DIR` | `~/.cockpit/push` | Chaves VAPID e inscrições; mover exige preservar os dados |
| `COCKPIT_USO_DIR` | `~/.cockpit/uso` | Dados do medidor de uso |
| `COCKPIT_STATUS_CODEX_DIR` | `~/.cockpit/status-codex` | Snapshots de status |
| `COCKPIT_CLEAR_CODEX_DIR` | `~/.cockpit/clear-codex` | Registros persistentes de reset |
| `COCKPIT_JOBS_DIR` | `~/.cockpit/jobs` | Fonte opcional de registros locais para o medidor |
| `COCKPIT_WORKTREES_DIR` | `~/.cockpit/worktrees` | Onde o orquestrador cria worktrees; o medidor usa o prefixo para separar job de aba |
| `COCKPIT_CODEX_RAIZ` | `~/.codex/sessions` | Raiz dos rollouts lidos pelo adaptador. Configure também esta variável se seu CLI usa um CODEX_HOME personalizado |
| `COCKPIT_PROC_RAIZ` | `/proc` | Injeção de fixtures nos testes. Não substitua em operação normal |

As variáveis de host, porta, token, projetos, CLIs, tmux, TLS e jobs HTTP estão no [README](../README.md). Não aponte diretórios de dados para dentro do checkout público. Preserve permissões e conteúdo ao mover registros; uma pasta vazia não é equivalente à anterior.

## Idioma por navegador

Abra **Configuração → Este aparelho → Idioma** e escolha Português ou English. A preferência fica em `localStorage`, na chave `cockpit-idioma`; não exige `.env`, restart ou alteração dos agentes. Sem escolha salva, um navegador em inglês inicia em inglês; os demais iniciam em português. Com storage bloqueado, a escolha funciona enquanto a página estiver aberta.

A troca preserva a conversa aberta, o rascunho, os anexos selecionados e o fluxo de eventos. Ela traduz os textos da interface, não o conteúdo das conversas nem a saída original dos CLIs. Diagnósticos externos e notificações enviadas pelo servidor podem manter seu idioma de origem.
