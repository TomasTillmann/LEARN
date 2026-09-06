# Artifact Markdown handoff regression

Use a text source registered as `pricing` with lines 1–20 in scope. Run the learning-content specialist and session-manager conversion for the same concept.

## Specialist response

```markdown
# Derivative pricing foundations

## Pricing logic

Derivative pricing combines mathematical tools with assumptions about traded assets and no-arbitrage reasoning. [`pricing`: lines 1-8]

## Conflict: Two pricing assumptions

The first position uses assumption A. [`pricing`: lines 9-12] The second uses assumption B. [`pricing`: lines 13-16]
```

## Expected conversion

- The specialist returns Markdown, never JSON.
- The stored title is `Derivative pricing foundations`; the two H2 headings become two sections in order.
- The stored section bodies contain `[1]` and, in the conflict section, `[1]` and `[2]`; no source marker remains.
- The first section has one source citation with locator `lines 1-8`. The conflict section has two source citations with locators `lines 9-12` and `lines 13-16`.
- The second section is `kind: "conflict"` with stored title `Two pricing assumptions`; both sections receive the task's mapped purpose.
- All generated IDs are unique, `sourceHashes` contains exactly the current hash for `pricing`, and artifact metadata matches `topic.json`.

## Required variants

- `append` omits H1, preserves the prior title/summary/kind/concept ID and old section order, allocates fresh non-colliding IDs, and uses a fresh artifact ID/path/date.
- `preview` is accepted only for answer/comparison and produces an `answer` session rather than an artifact.
- `# Insufficient source material` plus a reason produces no artifact or preview.
- Reject an out-of-scope range, a PDF `page` marker on this text source, prose outside H2 sections, a claim without an adjacent marker, and a conflict with fewer than two distinct attributed citations.
