# Segurança

O Cockpit é um painel de controle do seu usuário Linux. Um token válido permite enviar comandos aos agentes, manipular panes e acessar os arquivos permitidos pelas rotas do aplicativo. Ele não implementa isolamento entre usuários, equipes ou tenants.

| Camada | Regra |
|---|---|
| Rede | Localhost por padrão. Bind externo exige `COCKPIT_TOKEN`. Atrás de proxy/túnel local, configure token mesmo assim |
| Transporte | Use HTTPS para acesso remoto. Não registre query strings: SSE usa token na URL |
| Navegador | Token fica no localStorage. Não use máquinas ou perfis compartilhados |
| Agentes | Aprovações seguem o CLI. `COCKPIT_CODEX_SEM_APROVACAO=1` desativa aprovações e sandbox nas novas abas Codex |
| Arquivos | Execute sem root. Proteja `.env`, `~/.cockpit` e diretórios dos CLIs com permissões do usuário |
| Proxy | Preserve `Host`; origens diferentes são recusadas. Não habilite CORS amplo |

O servidor recusa origens cruzadas e, quando não há token, hostnames que não sejam localhost/loopback. Essa proteção não transforma uma máquina comprometida em ambiente confiável. HTTPS deve terminar no proxy ou nos arquivos definidos em `COCKPIT_TLS_CERT` e `COCKPIT_TLS_KEY`.

Para revogar acesso, troque `COCKPIT_TOKEN` em `.env` e reinicie o servidor. Os clientes deverão informar o novo token. Nunca envie `.env`, credenciais dos CLIs, rollouts reais ou o link com token em issues e screenshots.

## Relatar uma vulnerabilidade

Use **Security → Report a vulnerability** no repositório público para um relato privado. Se esse recurso ainda não estiver disponível, abra uma issue apenas pedindo um canal privado, sem detalhes técnicos, tokens ou dados sensíveis. Não publique a exploração numa issue comum.

Inclua versão/commit, plataforma, configuração sem segredos, impacto e passos mínimos com dados sintéticos. A linha de manutenção inicial é `0.1.x`; correções serão disponibilizadas na versão mais recente dessa linha. Não há SLA de suporte.
