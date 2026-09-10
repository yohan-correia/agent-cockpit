# Operação

O serviço roda sob seu usuário Linux e lê `.env` na pasta de instalação. O script `bin/instala-servico.js` grava a unit de usuário sem sobrescrever uma existente. Não use root.

```bash
systemctl --user status cockpit-agentes.service
journalctl --user -u cockpit-agentes.service -n 50
```

O serviço de usuário segue a política de login da sua distribuição. Se precisar mantê-lo após logout ou iniciar sem login, configure lingering com o administrador da máquina. Não é habilitado automaticamente.

## Atualização e rollback

1. Extraia a nova release em outra pasta. Preserve a pasta da versão anterior.
2. Copie sua `.env` para a nova pasta com permissão `600`. Leia as notas da release. Não copie rollouts nem credenciais para dentro do código.
3. Rode `npm run check` e `npm test` na nova pasta.
4. Ajuste `WorkingDirectory` e o caminho de `server.js` em `~/.config/systemd/user/cockpit-agentes.service` para a nova pasta. Use o mesmo binário Node que foi testado.

O restart interrompe conexões HTTP e descarta a fila ainda sem eco. Os processos tmux e o histórico dos CLIs continuam no disco.

```bash
systemctl --user daemon-reload
systemctl --user restart cockpit-agentes.service
systemctl --user status cockpit-agentes.service
```

Confira `/health` e uma conversa depois da atualização. Para rollback, aponte a unit para a pasta anterior e repita os comandos. Se a instalação usa drop-ins de systemd, `ExecStart` pode estar definido neles; confira `systemctl --user show cockpit-agentes.service -p ExecStart`.

## Dados locais

| Diretório | Conteúdo |
|---|---|
| `~/.cockpit` | Anexos, status/reset e configurações de notificações |
| `~/.claude` | Sessões e configurações do Claude Code |
| `~/.codex` ou `CODEX_HOME` | Sessões e configurações do Codex CLI |
| Pasta de projetos configurada | Arquivos de trabalho dos agentes |

Faça backup conforme a sensibilidade dos seus projetos. A remoção do código do Cockpit não remove esses dados. Não inclua esses diretórios no repositório público.
