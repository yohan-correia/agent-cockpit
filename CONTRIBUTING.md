# Contribuir

Comece pelo [README](README.md). Mudanças pequenas e com um objetivo são mais fáceis de revisar. Abra uma issue para mudanças de comportamento maiores. Para vulnerabilidades, siga [SECURITY.md](SECURITY.md).

1. Crie uma branch a partir de `develop`. A branch `main` representa a release estável.
2. Faça a alteração com dados e fixtures sintéticos.
3. Rode as verificações:

   ```bash
   npm run check
   npm test
   ```

4. Abra um PR para `develop`. Explique o problema, o comportamento resultante e como validou. Mudanças de tela devem incluir screenshots antes/depois, no viewport afetado, sem dados reais.

A suíte padrão não usa credenciais, CLIs instalados ou chamadas pagas. O runner cria um diretório de usuário temporário. Alguns testes antigos fora dessa suíte exigem instalações locais e podem gastar tokens; não execute `testes/*` indiscriminadamente.

## Smoke real opcional do Codex

Instale Codex CLI e tmux para esse teste. Ele usa provider HTTP local, CODEX_HOME temporário, cwd de fixture e socket próprio; não usa sua conta de modelos.

```bash
python3 testes/smoke-clear-codex.py
```

O smoke imprime a pasta de evidências em `/tmp`. Ele nunca deve receber seu CODEX_HOME real nem sua sessão tmux de trabalho. Os gates `gate-fase-1.js`, `gate-fase-2.js` e `gate-fase-3.js` chamam modelos reais e não fazem parte da CI.

## Contratos que precisam sobreviver

| Área | Invariante |
|---|---|
| Identidade | Não escolher o rollout mais recente para resolver ambiguidade |
| tmux | Enviar para a pane medida; nunca para a janela ativa por conveniência |
| Envio | Preservar serialização por aba, dedupe e bracketed paste do Codex |
| Reset | `/clear` confirmado não é pré-sessão; histórico real não deve ser apagado |
| Segurança | Não transformar mensagens em comandos de shell; validar agente vivo e caminhos |

Ao contribuir, você concorda em disponibilizar sua contribuição sob a licença MIT do projeto. Não inclua código ou assets de terceiros sem licença compatível e atribuição. Seja respeitoso: descreva problemas concretos, critique o código e não a pessoa.

## Traduções da interface

O catálogo está em `public/traducoes.js`; as chaves são os textos em português e os valores são as traduções em inglês. Preserve os parâmetros numerados (`{0}`, `{1}`) nas duas versões. Use `cockpitI18n.bind` ou `attr` para atualizar rótulos quando o idioma mudar. Não marque mensagens, nomes de arquivos ou saídas de ferramentas para tradução. O HTML estático é registrado uma vez, antes de montar as conversas.

`npm test` inclui o gate offline de idioma. O smoke opcional `testes/smoke-idioma.js` exige `puppeteer-core` no ambiente de testes, `CHROME_BIN` com o caminho do Chromium e `SAIDA` com a pasta dos screenshots. `PUPPETEER_MODULE` pode apontar para uma instalação separada de `puppeteer-core`. Ele cria um servidor HTTP de fixture em porta livre e não usa CLIs ou modelos.
