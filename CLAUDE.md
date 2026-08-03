# AgentDesk — protocolo autônomo de equipe

Estas regras valem para toda sessão conectada ao MCP `agentdesk`.

## Entrada única

1. Toda janela nova começa chamando `abrir`, sem escolher cargo nem tarefa.
2. O primeiro agente de cada pasta/equipe é eleito gerente único.
3. Os seguintes entram como trabalhadores `disponivel`.
4. `abrir` já liga `auto_mode`, restaura a identidade quando possível e tenta assumir o próximo work item pronto.
5. Guarde `session_id` e siga `proximo_passo`. Não peça ao usuário para chamar `/auto` separadamente.
6. A entrada é limpa: o histórico anterior da pasta (inbox, chat, work items, travas) não é despejado, só contado. Se a resposta indicar contexto guardado e o trabalho for mesmo a continuação, reabra com `recuperar=true`. Trabalho antigo ou de outro assunto: ignore e siga a fila.

O usuário ainda precisa abrir as janelas/terminais. O AgentDesk coordena agentes existentes; ele não cria processos Claude sozinho.

## Autoridade e papel são coisas diferentes

- `authority=manager` é uma capacidade protegida, eleita uma vez por equipe.
- `role` é apenas o papel atual, texto livre atribuído pelo gerente conforme o trabalho.
- Não existe catálogo de cargos.
- Um trabalhador com papel chamado `gerente` continua trabalhador e não recebe privilégios.
- Use `atribuir_papel` somente quando precisar trocar o papel fora da distribuição normal.

## Fluxo do gerente

Quando o usuário fornecer uma lista ou objetivo composto:

1. Decomponha em itens independentes, pequenos o bastante para execução paralela.
2. Defina `chave`, `titulo`, `papel`, aceite, escopos de arquivo e apenas dependências reais.
3. Chame `distribuir_tarefas` uma única vez com o lote completo.
4. Use `estrategia=balanceada` por padrão; `especialidade` quando papéis existentes importarem; `fila` quando agentes ainda não estiverem abertos.
5. Não microgerencie decisões locais. Monitore somente bloqueios, integração e prioridade.
6. Revisões são assíncronas e podem ser feitas por qualquer par da equipe que não seja o autor.

Dependências dentro do lote usam a `chave` do item. IDs existentes também são aceitos. Para uma nota que não bloqueia, prefixe com `nota:`.

## Fluxo do trabalhador

Cada pulso chama `tick_autonomo` no modo `compacto`:

- O MCP lê apenas deltas do inbox.
- Assume atomicamente o próximo item pronto destinado ao agente/papel.
- Adota o papel escolhido pelo gerente.
- Trava os escopos e prepara uma worktree automaticamente quando possível.
- Retorna uma única `acao` e o contexto necessário do item.

Ao receber `EXECUTAR`:

1. Trabalhe na `worktree` retornada, se houver.
2. Decida sozinho tudo que for reversível e estiver dentro do aceite.
3. Registre progresso apenas em marcos úteis, não a cada passo.
4. Valide com build/test/check proporcional ao risco.
5. Chame `entregar_tarefa`; o item vai para revisão assíncrona e o próximo item pronto é assumido sem espera.

Ao encontrar impedimento real, chame `bloquear_tarefa` com causa concreta. Locks são liberados, o gerente é avisado e outro item pronto é puxado imediatamente.

## Política de decisão sem gargalo

Decida sem consultar o gerente quando a decisão for local, reversível e coberta pelo aceite, incluindo estrutura interna, nomes, pequenos refactors e escolha de teste.

Escale somente quando houver pelo menos uma destas condições:

- ação externa ou irreversível;
- mudança de contrato público, schema destrutivo ou dependência nova de alto impacto;
- escopo conflitante que não pode ser isolado;
- credencial, autorização ou informação essencial ausente;
- duas interpretações que mudariam materialmente o produto.

Ao escalar, envie uma mensagem curta com evidência, impacto e recomendação. Enquanto aguarda, execute outro item pronto.

## Concorrência e economia de tokens

- Prefira `distribuir_tarefas` a várias chamadas de `delegar_tarefa`.
- Use `tick_autonomo(modo="compacto")`; peça `detalhado` só para diagnóstico.
- Não repita contexto já salvo no work item.
- Divida por escopos que não se sobrepõem; declare `arquivos_ou_escopos` no lote.
- Não consulte status em loop enquanto está executando código.
- Mensagens internas devem ter resultado, risco e próximo passo em poucas linhas.
- Se a fila estiver vazia, fique ocioso sem inventar trabalho nem solicitar decisão.

## Tools principais

| Objetivo | Tool |
|---|---|
| Entrar/retomar e ligar auto | `abrir` |
| Distribuir uma lista em paralelo | `distribuir_tarefas` |
| Trocar papel livre | `atribuir_papel` |
| Pulso e auto-claim | `tick_autonomo` |
| Progresso útil | `atualizar_progresso` |
| Entregar e puxar próximo | `entregar_tarefa` |
| Bloquear e puxar próximo | `bloquear_tarefa` |
| Revisão por par | `revisar_tarefa` |
| Mensagem direcionada | `pedir_acao` |
| Fechar corretamente | `fechar_sessao` ou `pausar_agente` |

As tools `abrir_ou_retornar_agente`, `abrir_sessao` e `delegar_tarefa` continuam disponíveis para clientes antigos. Novos fluxos devem usar `abrir` e `distribuir_tarefas`.
