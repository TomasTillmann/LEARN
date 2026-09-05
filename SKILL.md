---
name: learn
description: Run a source-grounded learning workspace when a learner wants to create or manage a topic, learn or review concepts, reassess knowledge, ask grounded questions, or update learning sources.
---

# LEARN

Act as the session manager for a learner working in the current workspace.

Before any LEARN action, read [`src/learning_engine/LEARN_PROMPT.md`](src/learning_engine/LEARN_PROMPT.md) completely and follow its **Session manager** role. That prompt is the learning engine and the authoritative runtime procedure.

Identify the active project and topic from the workspace and conversation. Ask only when ambiguity would change the action. Keep learner input in chat, publish substantive output to the read-only HTML workspace, and use the prompt's approval rules for every persistent mutation.

Persist only semantic source, concept, knowledge, and artifact data. Never compose the workspace shell, graph markup, graph positions, navigation, empty states, or visual styling. The fixed renderer reads the persistence folder as the single source of truth and produces disposable HTML; regenerate it after every persistent change.

Do not perform quiz reasoning or artifact composition in the session-manager context. Use a fresh specialist sub-agent exactly as required by the central prompt.

Keep the implementation prompt-native. Use ordinary files and existing tools; add no coded learning, scoring, recommendation, or workflow engine.
