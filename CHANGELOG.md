# Changelog

## 0.1.0 — preparação da primeira release pública

- Interface para panes Claude Code e Codex CLI, histórico por SSE, anexos e notificações.
- Instalação local configurável, com acesso remoto escolhido pelo usuário.
- Token obrigatório para bind externo e proteção de origem.
- Aprovações do Codex preservadas por padrão; bypass explícito.
- Correção do envio após `/clear` e `/new`, incluindo mensagem longa.
- Jobs do orquestrador lidos direto do disco (`COCKPIT_JOBS_DIR`), sem serviço externo.
- Suíte offline, documentação de contribuição e licenças dos assets.

Esta versão depende dos formatos internos dos CLIs. Veja os limites no README.
