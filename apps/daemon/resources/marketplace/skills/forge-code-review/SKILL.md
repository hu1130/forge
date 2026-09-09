---
name: forge-code-review
description: Review code changes for correctness, security, regressions, and missing tests with findings ordered by risk.
---

# Forge Code Review

Use this skill when the user asks to review a change, branch, patch, pull request, or implementation.

1. Read the stated goal and the actual diff before judging the code.
2. Look first for correctness bugs, security problems, data loss, regressions, broken contracts, and missing error handling.
3. Check boundary cases and whether tests exercise the changed behavior.
4. Report only actionable findings. Give each finding a severity, exact file and line, impact, and smallest safe correction.
5. Keep style-only preferences out of the findings unless they create a real maintenance or correctness risk.
6. If there are no material findings, say so plainly and name any testing limitation that remains.
