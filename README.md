# Cockpit de Agentes

Português | [English](README.en.md)

Interface web para conversar com **Claude Code e Codex CLI que rodam em panes tmux**. Use no computador ou no celular. O servidor fica na sua máquina Linux; os agentes continuam trabalhando quando você fecha o navegador.

O Cockpit roda em **localhost por padrão**. Tailscale, outra VPN ou reverse proxy são opções de acesso remoto. Você adapta a configuração ao seu setup, sem editar o código. É uma ferramenta para um único usuário de confiança, não um serviço multiusuário.

## Por que este projeto existe

Criei este Cockpit para continuar o mesmo trabalho em qualquer aparelho: computador, celular ou tablet. A ideia é acessar os mesmos arquivos e as mesmas sessões, sem precisar reconstruir a conversa, o contexto ou as decisões cada vez que troco de dispositivo.

O trabalho fica na máquina que executa os agentes. O navegador é a porta de acesso. Trocar de aparelho não exige começar outra sessão nem copiar o projeto para outro lugar. A continuidade depende dos registros e recursos do harness utilizado; o Cockpit não cria memória ilimitada nem substitui backups.

## Livre para escolher e adaptar

O projeto não está atrelado ao Claude Code, ao Codex ou a um fornecedor de modelos. A proposta é servir de interface para o harness que você quiser usar — a ferramenta que executa o agente e gerencia suas sessões. **Hoje, as integrações implementadas são Claude Code e Codex CLI.** Outros harnesses exigem desenvolvimento de integração; instalar outro CLI sozinho não o torna compatível.

Você escolhe onde rodar e como acessar: localhost, Tailscale, outra VPN ou reverse proxy. Você também pode fazer um fork, modificar, redistribuir e usar o código comercialmente sob a [licença MIT](LICENSE), mantendo os avisos de copyright e licença. Não precisa pedir autorização nem contribuir de volta para manter seu próprio fork. As licenças e condições dos agentes, modelos e assets de terceiros continuam valendo para eles.

## O que faz

| Recurso | Disponibilidade |
|---|---|
| Conversas Claude Code e Codex CLI | Histórico dos CLIs e atualizações por SSE |
| Abas do terminal | Abrir, acompanhar, enviar mensagens e fechar panes |
| Anexos, comandos e skills | Envio de arquivos e autocomplete por agente |
| Desktop e celular | Layout responsivo, painéis lado a lado e PWA |
| Notificações e arquivos | Web Push com contexto seguro e contato VAPID; [Taildrop opcional](docs/configuracao.md) |
| Jobs do orquestrador | Lidos direto do disco, sem serviço externo; pasta configurável |

## Requisitos

| Componente | Requisito |
|---|---|
| Servidor | Linux com `/proc`, Node.js 22.16+ e tmux |
| Agente | Claude Code ou Codex CLI instalado e autenticado pelo mesmo usuário Linux |
| Cliente | Navegador moderno; HTTPS para acesso remoto com PWA e notificações |
| Dependências npm | Nenhuma para executar o servidor ou os testes offline |

Instale e autentique o agente conforme a documentação de [Claude Code](https://code.claude.com/docs/en/setup) ou [Codex CLI](https://learn.chatgpt.com/docs/codex/cli). O Cockpit não inclui essas ferramentas nem suas credenciais. Uso de modelos segue a conta e a configuração do seu CLI.

## Instalação local

1. Baixe o código e entre na pasta `cockpit-agentes`. Confira os requisitos:

   ```bash
   node --version
   tmux -V
   command -v claude
   command -v codex
   ```

   Basta ter um dos dois agentes. Execute-o no terminal para concluir login e confirmações iniciais.

2. Crie a configuração, preservando qualquer `.env` existente:

   ```bash
   test -e .env || cp .env.example .env
   chmod 600 .env
   ```

   Em `.env`, configure `COCKPIT_BIN_CLAUDE` e/ou `COCKPIT_BIN_CODEX` com o caminho retornado por `command -v`. Configure `COCKPIT_PROJETOS_DIR` com a pasta que contém seus projetos. Use caminhos absolutos; `~` e `$HOME` não são expandidos dentro do arquivo.

3. Abra uma sessão tmux. Se `main` já existe, o comando a preserva:

   ```bash
   tmux has-session -t main 2>/dev/null || tmux new-session -d -s main
   ```

4. Inicie o servidor:

   ```bash
   npm start
   ```

5. Abra **http://localhost:7879**, clique em **Nova** e escolha projeto e agente. A pasta de projetos padrão é `~/projetos`. Diretórios ocultos e symlinks de projeto não entram na lista.

Não precisa de build nem de `npm install`. `npm start` usa o suporte a [arquivos `.env` do Node](https://nodejs.org/api/cli.html#--env-file-if-existsfile). Variáveis já exportadas no ambiente têm precedência sobre o arquivo.

## Idioma da interface

Em **Configuração → Este aparelho → Idioma**, escolha **Português** ou **English**. A troca é imediata, sem recarregar a página, e fica salva neste navegador. No primeiro acesso, navegadores em inglês usam inglês; os demais usam português.

A escolha muda os controles e textos da interface. Mensagens, nomes de arquivos, comandos e respostas dos agentes mantêm o conteúdo original. Cada aparelho pode usar um idioma diferente.

## Seu setup

| Configuração em `.env` | Padrão | Quando mudar |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `7879` | Endereço e porta do servidor |
| `COCKPIT_PROJETOS_DIR` | `~/projetos` | Projetos em outra pasta |
| `COCKPIT_BIN_CLAUDE` / `COCKPIT_BIN_CODEX` | `/usr/bin/claude` / `/usr/bin/codex` | Caminho real dos CLIs |
| `COCKPIT_TMUX_SESSAO` / `COCKPIT_TMUX_SOCKET` | `main` / socket padrão | Usar seu tmux existente ou um socket separado |
| `COCKPIT_TOKEN` | Vazio | Obrigatório fora de localhost; use também atrás de proxy/VPN |
| `COCKPIT_TLS_CERT` / `COCKPIT_TLS_KEY` | Não definidos | HTTPS direto; use ambos ou configure TLS no proxy |
| `COCKPIT_CODEX_SEM_APROVACAO` | `0` | `1` desativa aprovações e sandbox nas novas abas Codex |

Para usar um socket próprio, crie a sessão com `tmux -L cockpit-local new-session -d -s main` e defina `COCKPIT_TMUX_SOCKET=cockpit-local`. O Cockpit usa o usuário Linux que iniciou o servidor. Execute-o sem root.

**Acesso remoto:** mantenha localhost quando seu proxy ou túnel termina na mesma máquina. Defina um token, preserve o header `Host` no proxy e habilite HTTPS. Não é necessário instalar Tailscale para usar o Cockpit. Veja [acesso remoto](docs/acesso-remoto.md) e [segurança](SECURITY.md).

Para notificações, Taildrop, inbox e opções avançadas, veja [configuração](docs/configuracao.md).

## Rodar como serviço

Use uma pasta estável da release. O serviço executará o código dessa pasta; não troque branches nela durante o uso.

```bash
node bin/instala-servico.js
```

O script cria `~/.config/systemd/user/cockpit-agentes.service`. Não sobrescreve uma unit existente e não inicia o serviço sozinho.

Os próximos comandos iniciam o servidor configurado. Uma porta já ocupada impede a inicialização.

```bash
systemctl --user daemon-reload
systemctl --user enable --now cockpit-agentes.service
systemctl --user status cockpit-agentes.service
```

Veja [operação](docs/operacao.md) para atualização, rollback e funcionamento após logout.

## Testar e contribuir

```bash
npm run check
npm test
```

A suíte padrão usa dados sintéticos e não chama modelos pagos. Os testes reais de TUI são separados e opcionais; veja [CONTRIBUTING.md](CONTRIBUTING.md). Não execute todos os arquivos de `testes/` por descoberta: alguns gates históricos usam a assinatura do CLI.

## Limites conhecidos

Os formatos de sessão dos CLIs são internos e podem mudar. A versão Codex 0.153.4 foi usada no smoke local de `/clear`; isso não garante compatibilidade automática com versões futuras. O host Linux e `/proc` são necessários; acesso pelo navegador de Windows/macOS é possível, mas esses sistemas não são hosts nativos suportados nesta release. **WSL2 ainda não foi testado; a compatibilidade precisa ser validada.**

Os menus iniciais podem ser respondidos pelo Cockpit. Nem todo pedido de aprovação do Codex é detectável depois de a conversa começar; se o agente parar esperando, confira o terminal. O padrão preserva as aprovações do CLI. Ativar `COCKPIT_CODEX_SEM_APROVACAO=1` dá ao agente execução sem aprovação e sem sandbox: faça isso apenas num ambiente que você decidiu isolar e confiar.

O token dá controle sobre as panes e arquivos acessíveis ao usuário do servidor. Não compartilhe uma instância entre pessoas sem a mesma confiança. Reiniciar o servidor preserva os processos tmux, mas a fila de mensagens ainda sem eco é mantida em memória.

Detalhes internos: [arquitetura](docs/arquitetura.md). Para preparar uma distribuição, veja [publicação](docs/publicacao.md).

O que vem por aí: [roadmap](ROADMAP.md).

## Licença

Código sob [MIT](LICENSE). Fontes Inter sob [SIL OFL 1.1](public/fontes/OFL.txt). Veja [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Este projeto é independente e não é um produto oficial da Anthropic ou da OpenAI.
