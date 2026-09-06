# Concept granularity regression

Run this source through graph creation both as one text scope and as two chunk inventories split after line 5. Both paths must produce the same concept boundaries.

## Source

```text
1. A for loop repeats a block of code once for each item in a sequence.
2. Its notation names a loop variable, a sequence, and an indented body.
3. The loop variable refers to the current item during each repetition.
4. For example, a loop over a list of names can print each name.
5. Exercise: write a loop that prints every number in a list.
6. Exercise: rewrite three repeated print calls as one for loop.
7. A nested loop places one loop inside another to process combinations of items.
8. Understanding nested loops requires tracing how the inner loop completes for each outer-loop item.
9. For example, nested loops can generate every row-and-column coordinate in a grid.
10. Exercise: use nested loops to print a three-by-three grid.
```

## Expected graph semantics

- One concept for iteration with `for` loops, scoped to lines 1–6.
- One concept for nested iteration, scoped to lines 7–10.
- One prerequisite edge from `for`-loop iteration to nested iteration.
- Equivalent concepts, scopes, and edge whether processed whole or split after line 5.

## Forbidden fragment nodes

Do not create separate nodes for the loop variable, syntax, indentation, either example, either exercise, the print calls, the outer loop, or the inner loop.
