# Phase scripts

Working detail for the five phases. The rules of dialogue from SKILL.md apply
throughout: one question per message, options where possible, short turns.

## 1. Recall & resume

Before the first question:

- `search` memory for the topic and skim the hits; `read` anything clearly
  relevant. The user should never have to re-explain what memory already knows.
- Check for an existing `brainstorm-<slug>` page on this topic. If found:
  summarize in 3 lines where it stopped (phase, live options, partial
  decisions) and ask ONE question: continue from there, or reframe?
- If memory contradicts what the user just said, surface it ("last month you
  ruled X out because Y — has that changed?") instead of silently picking one.

## 2. Frame

Classify first, silently or aloud:

| Type | The question sounds like | Bias the session toward |
|---|---|---|
| decision | "A or B?", "should I…" | criteria early, options are given |
| ideation | "what could we…", "ideas for…" | wide divergence, defer criteria |
| diagnosis | "why is X happening" | evidence before options |
| plan | "how do I get to X" | sequencing, first step, risks |

Stakes: high when the outcome is hard to reverse, expensive, or shapes years
(one-way door). High stakes → slower convergence, deep-mode offer in phase 4.
Low stakes → say so and keep the whole session under ~10 exchanges.

Scale check: if the topic is really 2–3 independent questions, split it now.
Name the sub-questions, ask which one to take first, give each its own page.

Then establish, one question at a time, capturing the user's wording:

1. **The question.** One sentence, sharp enough that an outsider could judge
   whether an answer resolves it. Rewrite together until it is.
2. **Success criteria.** "How will you know you chose well, 6–12 months out?"
   2–4 criteria max; force-rank them if more than two.
3. **Constraints.** Money, time, people, energy, identity ("I won't be the
   kind of person who…"). Real ones only — challenge suspected fake
   constraints ("is that a fact or a fear?").
4. **Non-goals.** What this session is NOT deciding. Prevents scope bleed.

Confirm the frame in ≤5 lines before diverging. The frame is the contract for
the rest of the session.

## 3. Diverge

Quantity first, judgment later — and say that out loud so the user stops
self-censoring. Concretely:

- Ask for the user's raw options first (they hold context you don't). Then add
  your own — aim to bring 2–3 the user did NOT think of, drawn from a lens.
- Pick 1–2 lenses that fit the classification and NAME them ("let me run this
  through an inversion pass"). Lenses are in `lenses-business.md` and
  `lenses-lifestyle.md`; each lists when it applies and the questions to run.
- Force one deliberately extreme option: cheapest possible, most ambitious
  possible, or "do nothing for a year". Extremes reveal the real constraints.
- Include the status quo as an explicit option. It is always on the ballot and
  usually undervalued or overvalued — make it compete.
- Park tangents on a visible list instead of chasing them ("parking: X — worth
  its own session?").

Stop diverging when new options are recombinations of old ones, or the user's
energy drops. 4–7 live options is plenty; more means the frame is too wide.

## 4. Challenge

Attack the 2–3 front-runners before falling in love with them:

- **Assumption audit.** For each front-runner: "this only works if ___ is
  true." List the load-bearing assumptions; mark each as known / checkable /
  pure hope. A front-runner resting on pure hope gets flagged, not killed.
- **Pre-mortem.** "It's a year later and this failed. What happened?" Ask the
  user first, then add your own failure modes.
- **Inversion.** "What would guarantee this fails?" — then check which
  guaranteed-failure ingredients are already present.
- **Cheap tests.** For the biggest unknown on each front-runner: is there a
  test that costs a day or a week instead of committing? A brainstorm that can
  end in "run this cheap test first" should.

High stakes? Recommend deep mode here, once, with the one-line cost note
(`deep-mode.md`). Run it only on explicit yes; never re-offer after a no.

## 5. Converge & commit

- Score the finalists against the phase-2 criteria — a compact table, one line
  per criterion. No new criteria may appear now; if one does, it was hiding in
  phase 2, so go back and name it, then re-score.
- Present 2–3 finalists with honest trade-offs. YOUR recommendation goes
  first, with the argument. Not a neutral menu.
- Confirm in sections, each ending with one question: decision → rationale →
  risks & mitigations → actions. Wait for a yes on each before the next.
- If the user stalls between two finalists, offer the tiebreakers: which is
  easier to reverse; which failure mode would they rather explain a year from
  now; which option they'd be relieved to have someone forbid.
- A legitimate outcome is also: "not decidable yet — missing information X;
  the action is to get X by <date>." Record it as such; don't force a choice.

Then write the decision doc (`decision-doc.md`), save to memory, and run the
output routing from SKILL.md (file offer → user's places).

## Pacing

A focused session is 15–30 exchanges. If it passes ~40, propose to converge on
what's mature and park the rest as a follow-up session with its own page.
