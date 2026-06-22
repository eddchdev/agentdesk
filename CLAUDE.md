# AgentDesk — regras globais para qualquer Claude da equipe

Estas regras valem para **toda sessão** do Claude Code conectada ao MCP `agentdesk`.

## Conceito-chave: AGENTE vs SESSÃO

- **Agente**: identidade persistente (ex: "Jonathan/frontend"). Tem nome humano, cargo, pasta, histórico, status, personalidade. Sobrevive ao fechamento do Claude.
- **Sessão**: execução runtime atual desse agente. Tem `session_id`, heartbeat, travas. Quando você fecha o Claude, a sessão morre — mas o agente continua existindo (status `paused` ou `dead`).
- Ao reabrir, você **retoma o mesmo agente** (mesmo nome, mesmo histórico), em vez de virar Frontend-02, Frontend-03, etc.

## Comandos disponíveis

| Comando | Ferramenta MCP | O que faz |
|---|---|---|
| `/abrir` | `abrir_ou_retornar_agente` | Onboarding: retoma agente compatível ou cria um novo com nome persistente. |
| `/agentes` | `listar_agentes` | Lista todos os agentes da equipe. |
| `/retomar <nome>` | `retomar_agente` | Retoma um agente específico. |
| `/inbox` | `inbox_agente` | Mostra pedidos/alertas/handoffs pendentes pro agente atual. |
| `/status` | `listar_status` | Agentes + sessões ativas + travas + chat. |
| `/falar <msg>` | `enviar_mensagem` | Mensagem geral no chat. |
| `/pedir <quem> <msg>` | `pedir_acao` | Pedido direcionado (por nome do agente OU cargo). |
| `/passar <quem> <nota>` | `passar_tarefa` | Handoff de tarefa. |
| `/travar <arquivos>` | `travar_arquivos` | Trava arquivos antes de editar. |
| `/atualizar <progresso>` | `atualizar_progresso` | Registra progresso curto. |
| `/feito <resumo>` | `marcar_feito` | Conclui tarefa, libera travas. |
| `/pausar [motivo]` | `pausar_agente` | Pausa o agente (sessão fecha, agente continua). |
| `/fechar [motivo]` | `fechar_sessao` | Encerra sessão; agente vai pra `paused`. |
| `/auto` | `entrar_modo_auto` + `/loop /auto-tick` | Entra em modo autônomo (self-paced). |
| `/sair-auto` | `entrar_modo_auto` (ligar=false) | Sai do modo autônomo. |
| — | `criar_tarefa_estruturada` | Cria work item com dono/alvo, escopos, dependências e aceite. |
| — | `listar_tarefas_estruturadas` | Lista fila estruturada por status/agente/cargo. |
| — | `assumir_tarefa` | Assume work item, trava escopos e cria worktree isolada. |
| — | `bloquear_tarefa` | Marca work item bloqueado com motivo concreto. |
| — | `entregar_tarefa` | Entrega work item para review com validação. |
| — | `revisar_tarefa` | QA/gerente aprova ou reprova work item. |
| — | `tick_autonomo`, `marcar_lido` | Usados pelo loop interno. |
| — | `heartbeat`, `listar_chat`, `listar_contexto_time`, `detectar_conflitos` | Auxiliares. |

## Modo autônomo (`/auto`)

Quando você roda `/auto`, o Claude entra em loop self-paced. Cada tick:

1. Chama `tick_autonomo` — recebe inbox novo + handoffs + estado da tarefa + sugestão (AGIR/AGUARDAR/OCIOSO) e delay (30s/60s/120s/300s).
2. Age conforme a sugestão (responde alerta, continua tarefa, escala pro usuário).
3. Chama `marcar_lido` pra não re-agir nas mesmas mensagens.
4. Agenda próximo wakeup com `ScheduleWakeup` usando o delay sugerido.

Em paralelo, o **watcher externo** (`scripts/agentdesk-watcher.mjs`) assiste o DB e, quando entra mensagem direcionada a um agente em auto com `tmux_pane`, faz `tmux send-keys` na pane dele pra acelerar o próximo tick. Watcher é opcional — sem ele o loop ainda funciona, só com latência igual ao delay configurado.

## Estados do agente
`available` → ainda nunca foi usado nessa execução · `working` → tem sessão ativa agora · `paused` → fechou sessão limpo, pronto pra retomar · `dead` → sessão morreu sem fechar · `archived` → removido da equipe.

## As 10 regras duras + autonomia

1. **Nunca codar antes de `/abrir`.** Toda janela nova começa com `abrir_ou_retornar_agente`. Se já existe agente compatível (mesmo cargo + mesma pasta), você **DEVE retomá-lo** — não crie identidade nova sem necessidade.

2. **Antes de trabalhar, leia o INBOX.** O `/abrir` já te entrega o inbox. Releia com `/inbox` sempre que voltar de uma pausa longa.
   - Se houver **alerta CRÍTICO do gerente**, pare tudo e obedeça antes de continuar a tarefa.
   - Se houver **handoff pendente** pro seu cargo/nome, considere aceitar antes de pegar trabalho novo.

3. **Antes de editar um arquivo, use `/travar`.** Lock cooperativo: o MCP grava `agent_id` + `agent_name` na trava, então fica claro quem está mexendo mesmo se a sessão morrer.
   - Pode travar escopos: `api/**`, `src/painel/**/*.tsx`, `bot/src/routes/*`.
   - Escopos sobrepostos conflitam automaticamente: `api/**` bloqueia `api/src/index.ts`.

4. **Se o arquivo estiver travado por outro agente ativo, PARE.** Use `/pedir <agente> "preciso editar X, libera?"`. Nunca tente "só dar uma olhada e desistir".

5. **Heartbeat implícito.** Toda chamada de ferramenta atualiza heartbeat da sessão E do agente. Se ficar mais de 2 minutos trabalhando sem chamar nenhuma ferramenta, chame `heartbeat` ou `atualizar_progresso` explicitamente.

6. **Para envolver outro cargo, use `/pedir` ou `/passar`.** O destinatário pode ser:
   - Nome do agente: `Jonathan`, `Marta` (vai direto pra inbox dele)
   - Cargo: `backend`, `qa` (vai pra inbox de TODOS desse cargo)
   - Para trabalho real com mais de um arquivo, prefira `criar_tarefa_estruturada` ou `delegar_tarefa`; `delegar_tarefa` agora cria um work item automaticamente.

7. **Decisões pequenas e reversíveis: você decide sozinho.** Não pergunte ao usuário se vai criar `tmp/x.ts`, se vai usar `useMemo`, etc.
   **Decisões estruturais ou irreversíveis: peça ao gerente.** Mudança de schema, nova dependência, refactor amplo, restart de bot WhatsApp, etc.

8. **Ao terminar parte importante, use `/atualizar`.** Progresso curto (1-3 linhas) para a equipe acompanhar.

9. **Ao finalizar a tarefa, use `/feito`.** Marca tarefa, libera travas, registra resumo no chat.
   - Se a tarefa veio como work item, use `entregar_tarefa` com `resumo` e `validacao`. QA/gerente fecha com `revisar_tarefa`.

10. **Antes de fechar a janela, use `/fechar` ou `/pausar`.** Sem isso, sua sessão fica como `dead` em 3min e suas travas são liberadas automaticamente — mas suas tarefas em andamento entram em estado `pending` sem contexto pra quem assumir.

## Work items e worktrees

Quando houver paralelismo real, use work items estruturados em vez de só chat:

1. Gerente cria/delega a tarefa (`criar_tarefa_estruturada` ou `delegar_tarefa`).
2. Agente chama `assumir_tarefa`.
3. O MCP tenta travar `arquivos_ou_escopos` e criar uma worktree em `/tmp/agentdesk-worktrees`.
4. Agente trabalha na worktree/branch informada.
5. Agente chama `entregar_tarefa` com validação executada.
6. QA ou gerente chama `revisar_tarefa`.

Se `assumir_tarefa` apontar conflito de lock, não edite. O work item vai para `blocked` com o motivo.

## Boas práticas de chat

- 1 linha por mensagem. Resultado, decisão, próximo passo.
- Tipos: `falar` (geral), `pedir` (assinala alguém), `passar` (handoff), `alerta` (risco), `decisao` (registro), `erro` (incidente).
- Mensagens aparecem como `[2026-06-16 02:34:09] Jonathan/frontend: ...` (com nome do agente, não com `AgentDesk-Frontend-01`).
- Se a mensagem virou parágrafo, faça `/atualizar` em vez de `/falar`.

## Cargos
Detalhes em `.claude/roles/*.md`: `gerente`, `backend`, `frontend`, `bugs`, `whatsapp`, `qa`.

## Compatibilidade

A ferramenta legada `abrir_sessao` continua funcionando — agora ela também cria um agente novo por baixo dos panos. Mas prefira sempre `abrir_ou_retornar_agente` (via `/abrir`).
