# Glossary

One name per concept, in code, docs and messages. "Not" lists names to avoid. Rules are in [docs/design.md](docs/design.md).

| Term                | Meaning                                                                                                     | Not                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| Onlooker            | The second model that reviews the agent and reports findings; its display name is configurable with `name`. | guard, executor           |
| Observed Agent      | The Pi agent that the Onlooker reviews.                                                                     |                           |
| Onlooker Session    | The private Pi session where the Onlooker works.                                                            | shared memory             |
| Onlooker Prompt     | The system prompt of the Onlooker Session. Setting: `prompt`.                                               | main-agent prompt         |
| Tool Grant          | The read tools the Onlooker can call: `read`, `grep`, `find`, `ls`.                                         | extension allowlist       |
| Turn                | One model response of the Observed Agent and its tool calls.                                                |                           |
| Request             | Everything from one user prompt to the end of its run, including Corrective Turns.                          |                           |
| Read-only Turn      | A turn whose tool calls all only read.                                                                      | exploration turn          |
| Review              | One check of the Review Backlog, ended by one `onlooker_report` call.                                       |                           |
| Review Backlog      | Completed turns that no finished Review covers yet.                                                         | pending advice            |
| Review Cadence      | When Reviews start. Setting: `reviewEvery`.                                                                 | polling interval          |
| Catch-up Wait       | A short pause of the agent while a running Review catches up. Not an approval.                              | approval wait             |
| Review Evidence     | The agent's messages as its model received them, prepared for the Onlooker.                                 | transcript dump           |
| Tool-Call Reference | The `ref` that links a tool call to its result in Review Evidence.                                          | tool-call ID              |
| Context Seed        | The first Review Evidence of an Onlooker Session, fitted to the seed budget.                                | snapshot                  |
| Observed Setup      | The part of the Context Seed that describes the agent: its system prompt and tool summaries.                |                           |
| Finding             | One problem reported by a Review, with a severity and evidence.                                             |                           |
| Intervention        | A finding delivered to the agent.                                                                           | veto, approval gate       |
| Blocker             | Severity for wrong or unsafe work.                                                                          | execution veto            |
| Concern             | Severity for a real risk or a likely wrong path.                                                            |                           |
| Nit                 | Severity for small, low-risk cleanup.                                                                       |                           |
| Corrective Turn     | A hidden turn after a Concern or Blocker, so the agent decides and continues its task.                      |                           |
| Consultation        | One `onlooker_ask` call and its answer. Creates no finding.                                                 | delegation, manual Review |
| Paused              | Enabled but stopped after an error. The agent continues.                                                    | disabled                  |
