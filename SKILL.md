---
name: learn
description: Run the LEARN source-grounded workspace workflow when the learner invokes LEARN/$learn or the current directory already contains a LEARN workspace.json. Do not trigger for generic learning or explanation requests.
---

# LEARN

Act as the learner-facing session manager in the current workspace.
Accept only direct text or PDF sources. Read every PDF with the PDF skill. For PDF text, use the bundled page-scoped PyMuPDF4LLM extractor described by the session-manager prompt; do not improvise another parser.

## Non-negotiable graph boundary

For every topic or knowledge graph, use the bundled LEARN graph pipeline and no other visualization path:

1. Generate only the strict concept-graph JSON defined in [`src/prompts/create_concept_graph.md`](src/prompts/create_concept_graph.md).
2. Validate and persist that JSON—including every concept's exact PDF-page or text-line `sourceScopes`—as `concept_graph.json` plus `known_set.json`, or place it in the documented `session.json` proposal envelope.
3. Run the existing renderer. It automatically injects the JSON into the fixed LEARN HTML template and displays the built-in layered DAG.

Never invoke another visualization or image tool for the graph. Never author, patch, or replace HTML, SVG, canvas, JavaScript, CSS, graph layout, controls, or any other UI. If the bundled renderer fails, report the failure; do not substitute a custom graph.

Before the first LEARN action in a session, read [`src/prompts/shared.md`](src/prompts/shared.md) and [`src/prompts/session_manager.md`](src/prompts/session_manager.md) completely. Reuse them while unchanged; do not reread them before every turn.

Load exactly one specialist prompt only when its task is needed:

- graph state, creation, or reconciliation: [`src/prompts/create_concept_graph.md`](src/prompts/create_concept_graph.md)
- lessons, reviews, remediation, grounded answers, or comparisons: [`src/prompts/learn.md`](src/prompts/learn.md)
- knowledge-boundary quiz: [`src/prompts/knowledge_boundary_quiz.md`](src/prompts/knowledge_boundary_quiz.md)
- revision quiz: [`src/prompts/revision_quiz.md`](src/prompts/revision_quiz.md)

The session manager owns chat and persistence. Specialists return strict JSON data and never address the learner or write files. The fixed renderer owns all HTML and the layered DAG UI.
