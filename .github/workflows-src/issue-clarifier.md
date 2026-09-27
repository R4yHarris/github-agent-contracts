---
on:
  issues:
    types: [opened]
permissions: read-all
safe-outputs:
  add-comment:
---

# Issue clarifier

Read the newly opened issue.

If it already has a clear problem statement, reproduction steps (or equivalent), and a definition of done, leave a short acknowledgment comment and stop.

If it is missing any of those, add one comment that asks only for the missing pieces. Do not speculate. Do not create branches, commits, or pull requests.
