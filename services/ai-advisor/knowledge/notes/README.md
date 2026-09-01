# Staff notes

Short pieces of guidance Waterfind staff write directly for the advisor — a correction, a rule, a
house position, a seasonal reminder. Maintained through the AI Trainer (chat or the Notes tab), which
records every change; the format is documented here because the files are plain markdown and
reviewable in git.

## Delivery modes

| `mode` | Where it lands | Use when |
|---|---|---|
| `pin` | injected into the advisor's system prompt on every turn | the advisor states the wrong thing, or omits the point, without being asked |
| `retrieve` | returned by `search_knowledge` when triggers/keywords match | the default |

Pinning costs tokens on every turn for every client; there is no cap. `ADVISOR_NOTES=0` drops the
whole block (kill switch).

## File format

```yaml
---
id: kebab-case, unique
title: what the note is about
mode: pin | retrieve
scope: jurisdiction or topic label (free text)
triggers: comma-separated phrases that should surface it
source_urls:                # optional
  - https://...
as_at: YYYY-MM-DD
---
The note itself: one short paragraph (max 700 characters once flattened). Rendered into the prompt
from a fixed template with tags/markdown stripped and whitespace collapsed — a note can say
anything, but it cannot open a new section of the prompt.
```
