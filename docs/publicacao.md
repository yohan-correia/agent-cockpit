# Preparar uma distribuição pública

O script exporta apenas código, assets, testes e documentação pública versionados. Não copia `.git`, roadmap, relatórios internos ou `.env`. Ele exige um checkout limpo e recusa um destino existente.

```bash
COCKPIT_PUBLICACAO_PROIBIDOS=/caminho/lista.txt node bin/prepara-publicacao.js /tmp/cockpit-agentes-publico
```

Revise a pasta e confira o manifesto:

```bash
cd /tmp/cockpit-agentes-publico
sha256sum -c SHA256SUMS
npm run check
npm test
```

`SHA256SUMS` é gerado para a distribuição e ignorado pelo Git. Ele verifica o pacote recebido; não é uma lista para manter a cada commit. Gere uma nova exportação para obter um manifesto atualizado.

A triagem automática bloqueia alguns padrões de chave, domínios de tailnet, endereços da faixa CGNAT e o caminho de home do usuário que executa a exportação. Esses padrões são genéricos: o script não contém identificadores da infraestrutura do autor. Ela não substitui revisão humana de texto e imagens: texto DESENHADO em imagem (`docs/img/*.png`) a lista não enxerga — o arquivo passa pela busca como bytes, mas nome em pixel não é texto. O histórico do repo de origem não é distribuído; apagar segredos do último commit não bastaria para publicar esse histórico.

## Lista de termos proibidos

Além dos padrões genéricos, a exportação recusa qualquer nome que você pôr numa lista sua. A lista mora FORA do repo, em `COCKPIT_PUBLICACAO_PROIBIDOS` (caminho do arquivo) ou, sem ela, em `~/.cockpit/publicacao-proibidos.txt`: ela tem nome de cliente, e versioná-la seria publicar o que ela protege.

- Um termo por linha; `#` comenta; linha vazia é ignorada.
- Sem caixa e sem acento: `Cliente-Fictício` casa `cliente-ficticio`.
- Substring, de propósito: um termo curto casa dentro de palavra (`bsd` em `jobsDaLista`). Prefira o termo mais específico.
- Vale para o conteúdo e para o nome do arquivo.
- Exceção única: a linha `Copyright` do `LICENSE` (o titular é o autor). Os padrões genéricos e o caminho do home valem no arquivo todo.
- Lista ausente ou sem nenhum termo: a exportação recusa e diz onde criar. Exportar sem lista é o caso que publica nome privado.
- A recusa lista TODOS os problemas de uma vez e não cria o destino.

Exemplo (fictício):

```text
# clientes
loja-do-fulano
# máquinas
maquina-de-casa
```

Antes de criar o repositório remoto, confirme licença e autoria. No GitHub, habilite **Private vulnerability reporting**, configure `main` como branch padrão, crie `develop` e proteja as duas branches com PR e CI. Essas configurações pertencem ao repositório remoto e não são aplicadas por este script.

A pasta exportada serve para iniciar um histórico público novo. Mantenha o repositório interno preservado. Publique somente a cópia revisada, nunca o histórico interno por engano.
