# Graph auto-commit and first recommendation regression

Run both initial graph creation for a sourced topic and a correction-only graph reconciliation.

## Expected flow

- A source change or new sourced topic starts graph work with `graphReconciliationRequired: true`. For correction-only work against a valid graph, set the flag only after a complete ready response passes validation and hash rechecks, immediately before the first durable graph or known-set write.
- Accept for persistence only a validated specialist response with exact `mode: "complete"` and `status: "ready"`; never persist a chunk response.
- Recheck source and state hashes, then atomically persist `response.graph` as `concept_graph.json` and `{"conceptIds": response.knownConcepts}` as `known_set.json`. Clear reconciliation last.
- Do not show a graph preview or ask the learner to approve, reject, or correct the graph before committing it.
- Immediately select a prerequisite-ready unknown concept from the committed graph. Suggest it with a brief reason after the commit, even when rendering fails.
- Surface the specialist's validated graph-summary sections and citations, but create no learning artifact or recommendation state.
- Keep quiz-result approval and destructive-operation safeguards unchanged.

## Failure cases

- `mode: "chunk"`, malformed JSON, stale hashes, invalid graph structure, or a non-closed known set must not be committed.
- `status: "insufficient"` after a source change or new sourced topic leaves reconciliation pending and asks for more source material. On correction-only work it preserves the prior reconciliation flag and valid graph. Neither case invents a recommendation.
