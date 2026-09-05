# LEARN shared contract

The host agent supplies educational judgment; files and tools provide grounding, persistence, and presentation. Do not recreate semantic learning behavior as code.

## Authority and grounding

1. The current topic's canonical knowledge-bank Markdown is the sole canonical factual source.
2. Ground every canonical fact, concept, prerequisite edge, lesson, answer, example, and quiz question in that bank.
3. Never invent missing content. Omit unsupported claims or handle them as authorized external information.
4. Never use an existing learning artifact as factual or semantic input. It is output and may be stale.
5. After source conversion, learning work reads the canonical Markdown, never the original media.
6. Attribute substantive claims precisely enough that the learner can locate the supporting bank source.
7. If canonical sources disagree, identify and attribute every relevant position without fabricating consensus or silently favoring one.

## State model

- There is one current mutable topic state: knowledge bank, concept graph, known set, and artifacts.
- The persistence folder is the single source of truth. Rendered HTML is disposable.
- `concept_graph.json` contains semantic concepts and prerequisite relationships only, never presentation data.
- There are no versions, snapshots, or archives.
- The graph has one node per concept and directed prerequisite-to-dependent edges. It represents conceptual dependency, not source order.
- Understanding is binary: **understood** or **not understood**. Persist no score, confidence, percentage, or partial mastery.
- The persisted learner state is the known set. The knowledge boundary is derived from that set and the graph; it is not separately persisted.
- A concept may be understood without a learning artifact.
- Quiz questions, answers, evaluations, proposals, and progress are ephemeral.
- Authorized research remains ephemeral unless published as labelled external artifact output or promoted into the bank. Unpromoted material is noncanonical and excluded from graph and quiz grounding.

## Chat and HTML boundary

- Chat is the only input and control surface and the complete surface for quizzes.
- Run every quiz turn in chat: ask exactly one question, wait for the learner's answer, then briefly evaluate it and ask the next question when useful. Keep quiz results and approval in chat too.
- HTML is the substantive output surface for lessons, answers, explanations, comparisons, graph views, non-quiz proposals, and citations.
- The fixed renderer alone creates the application shell and visual graph. Agents write validated JSON, canonical Markdown, and semantic artifact fragments; they never generate layout, navigation, graph coordinates, empty states, or styling.
- Outside quizzes, chat contains short operational messages and a numbered list of next actions, without duplicating substantive HTML.
- HTML is read-only and never mutates state or changes the chat flow.

## Learner authority and approvals

- The learner has the final word on what they understand and study.
- A direct declaration such as “mark this understood” or “I do not understand this” is authoritative and may bypass a quiz.
- For a next-concept recommendation, choose an unknown concept closest to the known set; resolve ties with judgment, explain briefly, and allow an override. Never use source order as the tiebreaker.
- Briefly announce work before starting and say whether persistent state may change.
- An agent-proposed persistent mutation requires explicit learner approval.
- A direct, explicit learner command authorizes that exact non-destructive mutation. Do not ask again.
- A direct, unambiguous learner command authorizes its exact deletion. Clarify ambiguous targets; agent-proposed deletion requires approval.
- Knowledge-bank approval does not authorize a graph mutation. Apply the bank change, then separately propose any graph change.
- One graph approval may include its clearly explained prerequisite-consistency consequences.
- Internet-search permission does not authorize promotion into the bank.
- Never hide a bank, graph, known-set, project, or topic mutation inside teaching or assessment.
- After a persistent mutation, report exactly what changed and every automatic consequence.

## Prerequisite consistency

The known set must be prerequisite-closed:

- Marking a concept understood marks all transitive prerequisites understood.
- Marking a concept not understood marks all transitive dependents not understood.
- A new concept defaults to not understood.
- A new prerequisite of an already-understood concept, plus its prerequisites, is inferred understood.
- Removing a concept removes its known-state entry and incident edges.
- Removing a prerequisite edge does not demote anything.
- Materially changing a concept immediately marks it and all transitive dependents not understood as a consequence of the approved bank update.

Explain every closure. The learner may override it or request a boundary reassessment.

## External information

When the bank cannot answer a question:

1. Say that the bank is insufficient.
2. Ask permission to search or invite another source. A direct search request grants permission.
3. If permitted, research only the gap and publish the result in HTML as **External information** with citations.
4. Never use unpromoted external material in the graph or a quiz.
5. Offer promotion into the bank. Promotion needs separate approval; only afterward may it support a separately approved graph change.

## Runtime and persistence

Resolve `<skill-root>` as the absolute directory containing `SKILL.md` and `src/`. Resolve `<workspace-root>` as the directory containing `workspace.json`. A topic's relative `path` resolves beneath `<workspace-root>` to `<topic-root>`. Stored paths must not escape their owner. IDs use lowercase letters, digits, hyphens, or underscores, start with a letter or digit, and are unique in scope.

The renderer reads persistence, validates it, and lays out the graph. Selecting a node opens the artifact whose `conceptId` matches. Never patch rendered output; regenerate it.

`<workspace-root>/workspace.json`:

```json
{
  "name": "Workspace name",
  "current": { "projectId": "project-id", "topicId": "topic-id" },
  "projects": [
    {
      "id": "project-id",
      "name": "Project name",
      "topics": [
        {
          "id": "topic-id",
          "name": "Topic name",
          "path": "projects/project-id/topics/topic-id"
        }
      ]
    }
  ]
}
```

`<topic-root>/topic.json`:

```json
{
  "title": "Topic title",
  "eyebrow": "Short context label",
  "summary": "Topic summary",
  "updatedAt": "YYYY-MM-DD",
  "graphReconciliationRequired": false,
  "sources": [
    {
      "id": "source-id",
      "title": "Source title",
      "type": "Source type",
      "author": "Author when known",
      "locator": "Human-readable scope or locator",
      "addedAt": "YYYY-MM-DD",
      "path": "knowledge_bank/source-id.md"
    }
  ],
  "artifacts": [
    {
      "id": "artifact-id",
      "conceptId": "concept-id",
      "title": "Artifact title",
      "summary": "Artifact summary",
      "updatedAt": "YYYY-MM-DD",
      "labels": ["canonical"],
      "path": "html/artifacts/artifact-id.html",
      "citations": [
        { "sourceId": "source-id", "locator": "Exact locator", "note": "Optional note" }
      ]
    }
  ]
}
```

`author` and `locator` are optional when unavailable. Artifact labels are `canonical`, `external`, or `conflict`. Artifact `conceptId` and canonical citation `sourceId` values must exist. Canonical citations require an exact `locator`; external citations use `{ "label": "...", "href": "https://...", "note": "..." }`. Old artifacts may outlive concept or source removal; never repair them or use them as factual input.

`<topic-root>/concept_graph.json`:

```json
{
  "nodes": [
    {
      "id": "concept-id",
      "label": "Concept label",
      "description": "Grounded description",
      "sourceIds": ["source-id"]
    }
  ],
  "edges": [
    { "from": "prerequisite-id", "to": "dependent-id", "sourceIds": ["source-id"] }
  ]
}
```

Every node and edge has at least one current source ID. The graph is acyclic, has no self-edge, and every edge points from prerequisite to dependent. While `graphReconciliationRequired` is true, only the inactive previous graph may temporarily reference a removed source; no missing source may survive reconciliation.

`<topic-root>/known_set.json`:

```json
{ "conceptIds": ["concept-id"] }
```

Every known ID exists in the graph and the set is prerequisite-closed. Canonical Markdown lives in `knowledge_bank/<source-id>.md`; durable artifact fragments live at the paths declared in `topic.json`. Do not persist a separate boundary, frontier, proposal, or session file.

After a durable mutation, render with:

```text
node "<skill-root>/src/scripts/render-workspace.mjs" "<workspace-root>" "<workspace-root>/html"
```

Before first renderer use and after editing it, run:

```text
node "<skill-root>/src/scripts/render-workspace.mjs" --check
```

For temporary learner-facing non-quiz work, create one unique OS temporary directory outside `<workspace-root>`. Write `<os-temp-dir>/session.json` using only this shape:

```json
{
  "active": true,
  "kind": "graph-proposal",
  "title": "Optional title",
  "context": "Optional plain-text context",
  "html": "<section>Optional semantic HTML</section>",
  "proposedKnownSet": ["concept-id"],
  "proposedGraph": {
    "nodes": [
      {
        "id": "concept-id",
        "label": "Concept label",
        "description": "Grounded description",
        "sourceIds": ["source-id"]
      }
    ],
    "edges": []
  },
  "sourceRefs": [{ "sourceId": "source-id", "locator": "Exact locator" }]
}
```

`active` and `kind` are required. `kind` is `graph-proposal` or `answer`. A graph proposal requires `proposedGraph` and `proposedKnownSet`; an answer requires `html`. Omit irrelevant optional fields. Quiz questions, answers, evaluations, progress, and results stay in chat and never use session JSON or temporary HTML.

Render a temporary session with:

```text
node "<skill-root>/src/scripts/render-workspace.mjs" "<workspace-root>" "<os-temp-dir>/rendered" "<os-temp-dir>/session.json"
```

Open its rendered `index.html`. Keep session JSON and rendered HTML outside the workspace. Replace them as the session changes; remove the entire temporary directory when it ends. Durable answers and artifacts are separately persisted and rendered.

## Source conversion

Use the skill-root converter for every source addition or update. Never paraphrase, summarize, repair, or complete source content during conversion.

- web HTML: Trafilatura main-content extraction;
- DOCX and EPUB: Pandoc;
- text-native PDF: Poppler with page markers;
- complex or scanned PDF: Docling only after explicit fallback approval;
- YouTube: a genuine browser-acquired caption transcript;
- other audio or video: require a supplied transcript in v1.

Stage conversion in a unique OS temporary directory outside the workspace:

```text
uv run --offline "<skill-root>/src/scripts/convert-source.py" "<source>" "<os-temp-dir>/source.md" --canonical-destination "<topic-root>/knowledge_bank/<source-id>.md"
```

For browser-acquired UTF-8 text or WebVTT, add `--transcript-for`, `--caption-language`, and `--caption-type authored|automatic`. Add `--docling` only after explicit approval.

Before first use, run `uv run --offline "<skill-root>/src/scripts/convert-source.py" --check`. If a pinned dependency is unavailable offline, read the PEP 723 header, explain the exact package/version and uv cache effect, and obtain setup approval before one online check. Return to offline use afterward. Never install uv, Pandoc, Poppler, Docling, or another converter implicitly.

Inspect staged Markdown only for structural conversion success. Promote it only after validation and authorization. On failure, leave bank and graph unchanged, report the issue, and offer supplied Markdown/transcript or the supported fallback. Remove the temporary directory after promotion or failure.

## Implementation boundary

Semantic decisions remain in prompts and agent reasoning: concept extraction, prerequisites, material-change judgment, recommendations, adaptive questions, answer evaluation, conflict explanation, and teaching structure.

Use plain folders, Markdown, JSON, HTML, existing tools, and native file operations. Scripts are only for repeated deterministic mechanics such as conversion, exact approved mutation, graph closure, validation, or rendering. The renderer owns UI structure; agent HTML is sanitized semantic content only.

Do not create a coded learning engine, scoring system, fixed question tree, recommendation service, workflow runtime, database, vector store, embedding pipeline, queue, scheduler, or speculative abstraction.
