# Preparar uma distribuição pública

O script exporta apenas código, assets, testes e documentação pública versionados. Não copia `.git`, roadmap, relatórios internos ou `.env`. Ele exige um checkout limpo e recusa um destino existente.

```bash
node bin/prepara-publicacao.js /tmp/cockpit-agentes-publico
```

Revise a pasta e confira o manifesto:

```bash
cd /tmp/cockpit-agentes-publico
sha256sum -c SHA256SUMS
npm run check
npm test
```

`SHA256SUMS` é gerado para a distribuição e ignorado pelo Git. Ele verifica o pacote recebido; não é uma lista para manter a cada commit. Gere uma nova exportação para obter um manifesto atualizado.

A triagem automática bloqueia alguns padrões de chave, domínios de tailnet, endereços da faixa CGNAT e o caminho de home do usuário que executa a exportação. Esses padrões são genéricos: o script não contém identificadores da infraestrutura do autor. Ela não substitui revisão humana de texto e imagens. O histórico do repo de origem não é distribuído; apagar segredos do último commit não bastaria para publicar esse histórico.

Antes de criar o repositório remoto, confirme licença e autoria. No GitHub, habilite **Private vulnerability reporting**, configure `main` como branch padrão, crie `develop` e proteja as duas branches com PR e CI. Essas configurações pertencem ao repositório remoto e não são aplicadas por este script.

A pasta exportada serve para iniciar um histórico público novo. Mantenha o repositório interno preservado. Publique somente a cópia revisada, nunca o histórico interno por engano.
