# LEARN

LEARN is a source-grounded Codex skill that turns learner-provided text and PDFs into a local concept graph and detailed learning material. It preserves the source's depth: graph concepts retain exact source page or line scopes, and lessons read only those scopes instead of summarizing the whole source.

## Architecture

The session manager owns learner chat, approvals, workspace state, and rendering. Fresh specialists receive no chat history and return strict JSON only:

1. PDF text is extracted locally with PyMuPDF4LLM. Large PDFs are structurally surveyed, divided into exhaustive page chunks, and inventoried by the required number of fresh agents.
2. Every validated chunk inventory is checkpointed outside conversation context. A fresh synthesis agent merges only true duplicates and remaps existing evidence-backed edges into the final graph.
3. Each graph node persists exact `sourceScopes`. A fresh lesson agent reads only those regions and preserves their definitions, reasoning, examples, qualifications, and useful wording.
4. The deterministic renderer validates workspace JSON and builds the read-only layered DAG and learning pages as one local HTML file.

Original sources and validated JSON are durable. Rendered HTML, graph proposals, and chunk checkpoints are disposable. Specialists never write files or address the learner; the session manager validates their output before persistence.

## Files

```text
.
├── SKILL.md                         Skill entry point and routing
├── PRODUCT_SPEC.md                  Product contract and release gates
├── publish                          Exact global-skill publisher
└── src
    ├── prompts
    │   ├── shared.md                Universal invariants
    │   ├── session_manager.md       Workspace, delegation, and persistence
    │   ├── create_concept_graph.md  Graph inventory and synthesis contract
    │   ├── learn.md                 Lesson and grounded-answer contract
    │   └── *quiz.md                 Assessment contracts
    ├── scripts
    │   ├── extract-pdf.py           Local page-scoped PDF extraction
    │   └── render-workspace.mjs     Validation and static rendering
    └── ui/index.html                Fixed LEARN interface
```

## Develop, validate, publish

Develop and commit the skill in this repository. Useful local checks are:

```sh
uv run --with pymupdf --with pymupdf4llm python src/scripts/extract-pdf.py --check
node src/scripts/render-workspace.mjs --check
uv run --with pyyaml python "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" .
```

Run `./publish` to mirror the exact current repository tree into `${CODEX_HOME:-$HOME/.codex}/skills/learn`. It excludes only `.git`, deletes stale installed files, and verifies the two trees are byte-for-byte identical afterward. Publishing does not commit or push; Git remains a separate repository step.
