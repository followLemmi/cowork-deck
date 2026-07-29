# Project Ways Template

Ways are contextual guidance that loads once per session when triggered.
Each way lives in its own directory: `{domain}/{wayname}/{wayname}.md`

## Creating a Way

1. Create a directory: `.claude/ways/{domain}/{wayname}/`
2. Add `{wayname}.md` with YAML frontmatter + guidance

### Pattern matching (for known keywords):

```yaml
---
pattern: component|hook|useState|useEffect
files: \.(jsx|tsx)$
commands: npm\ run\ build
---
# React Way
- Use functional components with hooks
```

### Semantic matching (for broad concepts):

```yaml
---
description: React component design, hooks, state management
vocabulary: component hook useState useEffect jsx props render state
threshold: 2.0
---
# React Way
- Use functional components with hooks
```

Matching is additive — a way can have both pattern and semantic triggers.

## Tips

- Keep guidance compact and actionable
- Include the *why* — agents apply better judgment when they understand the reason
- Use `ways suggest <file>` to find vocabulary gaps
