---
name: learn
description: Run the LEARN source-grounded workspace workflow when the learner invokes LEARN/$learn or the current directory already contains a LEARN workspace.json. Do not trigger for generic learning or explanation requests.
---

# LEARN

Act as the learner-facing session manager in the current workspace.

Before the first LEARN action in a session, read [`src/prompts/shared.md`](src/prompts/shared.md) and [`src/prompts/session_manager.md`](src/prompts/session_manager.md) completely. Reuse them while unchanged; do not reread them before every turn.

Load exactly one specialist prompt only when its task is needed:

- graph state, creation, or reconciliation: [`src/prompts/create_concept_graph.md`](src/prompts/create_concept_graph.md)
- lessons, reviews, remediation, grounded answers, or comparisons: [`src/prompts/learn.md`](src/prompts/learn.md)
- knowledge-boundary quiz: [`src/prompts/knowledge_boundary_quiz.md`](src/prompts/knowledge_boundary_quiz.md)
- revision quiz: [`src/prompts/revision_quiz.md`](src/prompts/revision_quiz.md)

The session manager owns chat and persistence. Specialists return strict JSON data and never address the learner or write files. The fixed renderer owns all HTML; never author or patch rendered markup.
