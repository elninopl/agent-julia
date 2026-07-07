# Decision doc & session state

Two artifacts share one memory page: the **working state** while the session
is live, and the **decision doc** it becomes when the session lands. Page id:
`brainstorm-<slug>` where the slug is a short kebab-case topic name.

## Working state (live session)

Upsert after EVERY phase, not just at the end — a session interrupted
mid-phase must be resumable from the page alone, on another day or device.

```markdown
---
title: Brainstorm: <topic>
status: active
tags: [brainstorm]
---

**Phase:** <recall | frame | diverge | challenge | converge>
**Type / stakes:** <decision|ideation|diagnosis|plan> / <low|high>

## Frame
- Question: <user's wording, verbatim>
- Criteria: <ranked>
- Constraints: <…>
- Non-goals: <…>

## Options on the table
- <option> — <one-line state: fresh / front-runner / needs evidence on X>

## Killed
- <option> — <one-line reason>

## Partial decisions & notes
- <anything already agreed; parked tangents; deep-mode findings>
```

## Decision doc (session landed)

Rewrite the same page — don't create a second one. Set `status: decided`
(or `status: parked` for "not decidable yet").

```markdown
---
title: Decision: <topic>
status: decided
tags: [brainstorm, decision]
---

**Decided:** <date> · **Type / stakes:** <…>

## Question
<final wording>

## Decision
<one sentence, no hedging>

## Rationale
<the argument that carried it, compact>

## Options considered
- <option> — killed because <reason>   ← one line each; reasons matter more
- <option> — runner-up; lost on <criterion>    than descriptions

## Risks & mitigations
- <risk> → <mitigation or "accepted">

## Actions
- [ ] <action> — <owner if not the user> — <when>

## Review
<date or trigger to revisit, e.g. "after the Q3 numbers" — every decision
gets one; "never" must be said explicitly>
```

Rules:

- The killed-options list with reasons is the most valuable section months
  later — it prevents relitigating. Never omit it.
- Use the user's own wording for the question and decision.
- If the outcome is "run a cheap test first", the doc is still a decision —
  the decision to test, with the test as the action and the review date as
  the test's deadline.

## File export

After saving to memory, ask once: "Want this as a file — Markdown or HTML?"

- **Markdown:** the decision doc as-is, written to a sensible filename
  (`decision-<slug>.md`) in the working directory or a location the user
  names.
- **HTML:** for sharing with less technical people. Self-contained single
  file, no external assets, readable typography (a system font stack, a
  max-width column, generous line-height). Same content; render the actions
  as checkboxes and the killed options as a struck-through list. No framework
  needed — write the HTML directly.

## Routing to the user's places

Last step. Check which tools are actually connected in THIS session (task
managers, note/wiki apps, team chat, calendars — inspect the available tools;
never assume a specific product). Then, at most one line: "The actions could
go to <their task manager> and the doc to <their notes app> — want that?"

- Only propose destinations that exist in the session AND fit how this user
  routinely files such things (memory may know their habits — check it).
- Act on approval; on "no", drop it without comment.
- Actions with dates deserve the proposal most — a decision doc in memory
  doesn't remind anyone of anything.
