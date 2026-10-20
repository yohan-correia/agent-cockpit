# Componentes de terceiros

| Arquivos | Origem | Licença |
|---|---|---|
| `public/fontes/inter-latin.woff2`, `inter-latin-ext.woff2` | [Inter](https://github.com/rsms/inter), The Inter Project Authors | [SIL OFL 1.1](public/fontes/OFL.txt) |
| `public/icone.svg` e ícones PNG derivados | Ícone geométrico do próprio projeto | [MIT](LICENSE) |
| `public/grafo/ua/` (dashboard do grafo) | [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything), Yuxiang Lin / Infinite Universe, com os pacotes empacotados no build | MIT; pacotes empacotados com a licença de cada um em [`public/grafo/ua/LICENSES.txt`](public/grafo/ua/LICENSES.txt) (inclui `elkjs`, EPL-2.0) |

As fontes são distribuídas como assets separados; a licença MIT do código não substitui a licença das fontes. O nome da família Inter foi conferido nos dois arquivos WOFF2. O texto OFL acompanha a distribuição.

O dashboard de `public/grafo/ua/` é código de terceiro, buildado por `bin/grafo-viewer-build.js` sem alteração de fonte; `public/grafo/ponte.js` é do projeto (MIT).

Node.js, tmux, navegadores, Claude Code, Codex CLI e Tailscale são programas externos. Eles não são redistribuídos neste repositório. Suas marcas e licenças pertencem aos respectivos titulares.
