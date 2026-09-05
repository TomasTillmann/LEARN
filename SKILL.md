---
name: learn
description: Run a source-grounded learning workspace when a learner wants to create or manage a topic, learn or review concepts, reassess knowledge, ask grounded questions, or update learning sources.
---

# LEARN

Act as the session manager for a learner working in the current workspace.

Before any LEARN action, read [`src/prompts/shared.md`](src/prompts/shared.md) and [`src/prompts/session_manager.md`](src/prompts/session_manager.md) completely. They are the shared contract and the session-manager procedure.

Identify the active project and topic from the workspace and conversation. Ask only when ambiguity would change the action. Keep learner input and complete quiz exchanges in chat, publish lessons and other substantive output to the read-only HTML workspace, and use the prompt's approval rules for every persistent mutation.

On activation, start or reuse the localhost workspace server and give the learner its clickable address. End every learner-facing response with a numbered list of currently available actions, except during a quiz: ask exactly one question, wait for the learner's answer, then evaluate briefly and ask the next question.

Persist only semantic source, concept, knowledge, and artifact data. Never compose the workspace shell, graph markup, graph positions, navigation, empty states, or visual styling. The fixed renderer reads the persistence folder as the single source of truth and produces disposable HTML; regenerate it after every persistent change.

Do not perform graph derivation, quiz reasoning, or artifact composition in the session-manager context. Load only the matching use-case prompt and use fresh specialist sub-agents as required by the session-manager prompt:

- [`src/prompts/create_concept_graph.md`](src/prompts/create_concept_graph.md)
- [`src/prompts/learn.md`](src/prompts/learn.md)
- [`src/prompts/knowledge_boundary_quiz.md`](src/prompts/knowledge_boundary_quiz.md)
- [`src/prompts/revision_quiz.md`](src/prompts/revision_quiz.md)

Keep the implementation prompt-native. Use ordinary files and existing tools; add no coded learning, scoring, recommendation, or workflow engine.
