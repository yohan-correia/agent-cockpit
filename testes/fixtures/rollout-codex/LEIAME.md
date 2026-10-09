# Fixtures de rollout do Codex

Card `codex-no-relatorio-de-tokens` (2026-09-22). Usadas por `testes/gate-uso-codex.js` e por
`testes/print-codex-nos-tokens.js`.

## De onde o formato saiu

Da **estrutura real** de `~/.codex/sessions/<AAAA>/<MM>/<DD>/rollout-*.jsonl`, medida em
**2026-09-22** sobre **1.617 arquivos / 1,28 GB**. `cli_version` de referência: **0.147.0**
(o campo é reproduzido nas fixtures; o CLI instalado na máquina já é mais novo — o valor está
aqui porque é o que o formato abaixo descreve, não porque seja a versão corrente).

**Nenhum byte de conversa real está aqui.** Todo texto é sintético; o que se preserva do disco
é a *forma* dos eventos.

## O que foi medido, e que as fixtures reproduzem

| Fato | Medida |
|---|---|
| `event_msg` / `token_count` existe em | **1.614 / 1.617** arquivos (99,8%) |
| `token_usage_record` existe em | 578 (35,7%) — CLI novo, **por isso não é a fonte** |
| `total_token_usage` é **acumulado** da sessão | evento duplicado em 57 arquivos · reset do contador em 3 |
| `total_tokens == input + output` | 8.929 eventos de 09/2026, **100%** |
| `cached_input_tokens <= input_tokens` | 100% — é **subconjunto**, não parcela à parte |
| `reasoning_output_tokens <= output_tokens` | 100% — idem |
| `cache_write_input_tokens` | **sempre 0** — por isso é descartado |
| `session_meta.source` | `"exec"` 1.550 · `"cli"` 57 · **objeto** `{subagent:…}` 15 |

O último é o motivo de o módulo **não** reusar `sessionMetaDe` (que exige `source === 'cli'`):
ela descartaria 96% dos arquivos. Duas fixtures cobrem isso — `exec` e `subagente`.

## Como regerar

```bash
node testes/fixtures/rollout-codex/gera.js        # popula ./2026/<MM>/<DD>/
```

`gerar(raiz, { home, agora })` também é chamada **em tempo de execução** pelo gate (num
`mkdtemp` próprio) e pelo print. É por isso que ela existe como função:

- 🔴 **datas derivadas de `Date.now()`, nunca chumbadas.** `resets_at` fixo fica verde hoje e
  mente em semanas — foi exatamente o que aconteceu com o caso 72 do `gate-codex.js`, cujo
  `resets_at` de 29/08 virou passado e derrubaria o filtro de janela vencida;
- 🔴 **`home` é parâmetro.** O `cwd` de cada fixture é montado a partir dele; quem grava com um
  home e lê com outro vê todo gasto cair em `(fora de projeto)` — o número certo com o rótulo
  errado, e o gate passando.

As cópias commitadas em `2026/` servem de referência de formato para leitura humana. **Quem
executa gera as suas.**

## Os arquivos

| Fixture | O que exercita |
|---|---|
| `rollout-normal` | caso feliz: `cwd` de projeto, `source:"cli"`, 3 `token_count` crescentes |
| `rollout-duplicado` | dois `token_count` idênticos seguidos (GC1) |
| `rollout-reset` | acumulado que **cai** no meio, `/new` na mesma sessão (GC2) |
| `rollout-exec` | `source:"exec"` — como os jobs e avaliadores rodam (GC12) |
| `rollout-subagente` | `source` como **objeto** (GC12) |
| `rollout-corrompido` | linha que não parseia **e** linha > 1 MB — as duas contam em `linhasIgnoradas` (GC3) |
| `rollout-segredo` | segredo em `message`, em `base_instructions.text` e **nos últimos 256 bytes** — o trecho que vira assinatura (GC6) |
| `rollout-sem-secundaria` | `secondary: null` não vira barra de 0% (GC5) |
| `rollout-vencido` | `resets_at` no passado — o candidato é descartado inteiro (GC11) |
