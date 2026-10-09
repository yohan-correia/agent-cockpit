# Fixtures medidas do AskUserQuestion

Telas (`telas/`) e payloads do hook (`ganchos/`) capturados do Claude Code de verdade, sem inventar nada.

- **medição 1** (Claude Code 2.1.292): telas com prefixo `m1-`. A `m1-01-pergunta-aberta.txt` é a abertura do `ganchos/01-pre.json`.
- **medição 2** (Claude Code 2.1.294): telas `a*`, `b*`, `c*`, `e*`. Elas casam com os payloads `a-`, `b-`, `c-`, `e-` de `ganchos/`: a tela `b1` é a abertura do `b-pre.json`, e assim por diante. `recusa-pre.json` é a pergunta que foi recusada com Esc.
- Os caminhos dos payloads foram reescritos para `/home/usuario/projetos/demo`; nenhum nome de projeto real fica aqui.
- Cada `*-pre.json` tem o `*-post.json` do mesmo caminho (o Post só dispara quando a pergunta é respondida).
