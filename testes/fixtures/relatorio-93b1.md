done: a frente A está implementada e comitada na branch da worktree (`0 11` sobre a `develop` `f57d33ee`). Todos os gates automatizados passaram. Nada foi empurrado nem mergeado. Ficam pendentes só o smoke de produto do dono e a leitura de prod.

**Alterei arquivos:** sim, só na worktree, em 11 commits (`fc9a572d` … `d422db1f`).

## O que o card não sabia
- A regra que gravava taxa ou juros sozinha já tinha saído em 12/09 (card `hcL0`).
- O botão "Confirmar" da sugestão em Entradas não existe mais desde 11/09. Toda sugestão passa por "Revisar", que abre o `ComposeSheet`, e o `handleConfirm` do `page.tsx` virou código morto (sinalizei, não apaguei).
- A regra financeira **não mudou** e não há decisão pendente. A taxa lançada substitui a estimativa da `CardFeeRule` na comissão, sem contar duas vezes.

## O que entrou
- Antes de gravar qualquer crédito, a tela mostra:
  - o banco;
  - paciente e venda;
  - o efeito: "já registrado, só vincula" ou "cria recebimento novo";
  - a diferença com direção (banco a mais ou a menos);
  - o ajuste que será gravado.
- Valor igual ou dentro de 2 centavos abre um modal novo de revisão, com 1 clique a mais que hoje. Diferença maior abre o modal de classificar de sempre, com o mesmo bloco de identidade e sem clique a mais.
- Duplo clique grava uma vez só.
- O modal fica aberto durante o envio e depois de um erro, então a classificação e a seleção não se perdem.
- O servidor passou a recusar com 409 o mesmo recebimento em duas conciliações. Antes aceitava calado.
- Saídas continuam como estavam.

## Validações executadas

| Gate | Resultado |
|---|---|
| tsc / vitest | 0 / 358 arquivos, 4667 testes |
| lint | mesmo perfil da base, 0 linhas novas |
| build | rc=0 |
| Teste do servidor contra o banco (recebimento duplicado) | 5/5; falhava em 3 casos antes do conserto |
| Testes de conciliação contra o banco de dev | 27/27 |
| Smoke, 8 casos em 840 e 1280 | 134/134 |
| Banco de dev conferido | 8/8: igual/tolerância sem ajuste, taxa 38,00, juros 26,90, parcial 700,00, taxa 10,00 após erro e nova tentativa |
| Controle negativo na tela da develop | reprovou com 42/42 falhas, todas por falta da revisão |
| Percurso novo | OK na branch, reprova na develop |
| Medidor de larguras (6 rotas do financeiro) | 18×18 medições, 0 regressão |
| Dados SMOKE no dev | removidos, 0 linhas |

- **Prints com o modal aberto:** `docs/superpowers/plans/2026-09-30-revisao-central-evidencias/antes/` e `depois/`. Abri e olhei.
- **Defeito que só o print pegou:** no caso "Falta receber" a frase de direção contradizia o valor mostrado. Corrigido nos commits `5e69cd2d` e `d159eae9`.

## Avaliação externa
- **Spec, 2 rodadas:** Claude e Codex responderam nas duas. O 🔴 do Codex eram contradições no texto e foram corrigidas.
- **Plano, 2 rodadas:** Claude deu ✅; o 🔴 final do Codex era um caso de teste listado no grupo errado, corrigido.
- **Execução, 1 rodada:** 🟡 dos dois; corrigi 3 achados.
- Nas três etapas o teto de rodadas fechou pelo meu julgamento.

## Pendências e registros
- **ARMADILHA #290:** seeds de smoke do mesmo dia se enxergam no banco de dev. Um valor meu a menos de 5% do de outro cenário vira sugestão lá e quebrava o percurso da baixa parcial. Troquei o valor e esse percurso passou a escolher o candidato pelo saldo; ele fecha 38/38 com os dois cenários no ar.
- **Card novo:** `PVTI_lAHOCIsyic4Bde1bzg9vd-M`, "API aceita alocação parcial em recebimento já existente" (Sugestões, prioridade Média).
- **Card principal:** continua em Fazendo. O texto novo foi acrescentado no fim, e conferi que os 6728 bytes originais continuam idênticos.
- **Para a frente B:** em "Todas" a revisão mostra "forma Pix", que é o que o sistema grava hoje, enquanto a conferência diz "sem forma registrada". Escolher a forma de verdade fica para a B.
- **Trilha de decisões:** `<pasta-de-jobs>/20260930-164255-…-93b1/decisoes.tsv`. Memória gravada em `~/brain/projetos/loja-exemplo/conciliacao-revisao-central-estado.md`.

**Pendências para o dono:**
1. Smoke de produto: o clique a mais quando o valor bate serve no dia a dia? O texto "vira a taxa lançada… no lugar da estimativa" ficou claro?
2. Antes do deploy, contar em prod os recebimentos que já estão em duas ou mais conciliações. O SQL está no plano, e a leitura de prod é barrada para o job.
3. Merge na develop.
