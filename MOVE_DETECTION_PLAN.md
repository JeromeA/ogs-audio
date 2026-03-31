# Implement Rigorous Move Detection From OGS Board Mutations

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and
`Outcomes & Retrospective` must be kept up to date as work proceeds.

This repository contains `PLANS.md` at the repository root. This document must be maintained in accordance with
`PLANS.md`.

## Purpose / Big Picture

After this change, the userscript in `ogs-audio.user.js` will be able to identify both local and remote moves from the
rendered OGS board in a way that is stable enough to drive speech output. The important user-visible result is that,
when either player plays a move, the script will speak the coordinate once, using the same board geometry that already
powers the working cursor-audio feature.

The way to see it working is simple. Open a live OGS game with the userscript enabled, make one local move, wait for
one remote move, and watch the browser console. The console should show one structured detection log per committed
move, each containing the move kind (`local` or `remote`), the translated SVG position, and the derived coordinate.
The page should not announce hover previews, marker refreshes, or repeated refresh passes as separate moves.

This work will likely require a debug loop. During that phase, the classifier must be conservative and explicit. It is
not enough to "mostly match" a mutation batch. Every announced move must correspond to a batch shape that we can
describe precisely, and every batch that does not satisfy one of those precise shapes must be logged as an assumption
break so the next iteration can refine the rules.

## Progress

- [x] (2026-03-31 11:45Z) Collected and analyzed remote move mutation logs in `NOTES.md`.
- [x] (2026-03-31 12:10Z) Collected and analyzed local hover and local move mutation logs in `NOTES.md`.
- [x] (2026-03-31 12:20Z) Chose DOM mutation classification as the primary move-detection strategy.
- [x] (2026-03-31 12:45Z) Implemented a mutation normalizer that converts raw `MutationRecord` batches into
      stone-render facts.
- [x] (2026-03-31 12:45Z) Implemented a strict classifier for preview, local move, remote move, marker noise, and
      unmatched batch shapes.
- [x] (2026-03-31 12:45Z) Mapped committed stone positions to board coordinates using the existing SVG grid metrics.
- [x] (2026-03-31 12:45Z) Added validation logs for classified batches, detected moves, deduped moves, and unmatched
      assumptions.
- [x] (2026-03-31 12:45Z) Added assumption-break logs for every batch shape that does not match the current
      classifier rules.
- [ ] Exercise the script against a live game and update this plan with the observed outcomes.

## Surprises & Discoveries

- Observation: Browser-level network hooks and attempted goban-engine instrumentation did not expose live move events
  reliably.
  Evidence: the captured logs showed startup traffic only, while board shadow-root mutations changed on every move.

- Observation: The board SVG lives inside the open shadow root of `.Goban[data-pointers-bound="true"]`.
  Evidence: cursor audio only became reliable after SVG discovery was changed to search the board host's
  `shadowRoot`.

- Observation: A local hover preview already inserts a translated `g.grid` child and a stone `use` node before the
  user clicks.
  Evidence: the pre-click local hover log shows `transform="translate(472,944)"` and a stone `use` with
  `opacity="0.6"`.

- Observation: A remote committed move and a local committed move are rendered differently.
  Evidence: remote play adds the translated `g.grid` child during the committed move, while local play mostly changes
  the existing preview stone from translucent to opaque and adds marker-related nodes.

- Observation: The most reliable runtime point available from newly added SVG nodes is the rendered SVG center from
  `getBBox()` plus `getCTM()`, not just the raw `translate(...)` string.
  Evidence: the new classifier extracts stone and shadow-circle positions from live SVG nodes and only falls back to a
  parsed ancestor `transform` when geometry APIs are unavailable.

## Decision Log

- Decision: Use board shadow-root DOM mutations as the authoritative move source instead of generic transport hooks.
  Rationale: the transport hooks do not see live moves reliably, while the board DOM always changes when the visual
  board changes.
  Date/Author: 2026-03-31 / Codex

- Decision: Derive the move coordinate from the translated SVG stone position and the existing parsed grid metrics.
  Rationale: the cursor-audio path already proves that SVG grid parsing is accurate, and it avoids guessing from outer
  container rectangles.
  Date/Author: 2026-03-31 / Codex

- Decision: Treat local and remote moves as separate committed-move signatures that feed into one normalized move
  object.
  Rationale: the logs show that local and remote render sequences are related but not identical, so one loose rule
  would either miss moves or announce hover previews.
  Date/Author: 2026-03-31 / Codex

## Outcomes & Retrospective

The core implementation is now in place. The userscript can observe board mutations, normalize them into stone-render
facts, classify them strictly, and log unmatched assumptions. The remaining work is live validation against OGS and
refinement of any unmatched shapes that appear in fresh logs.

## Context and Orientation

This repository is a small Tampermonkey project. The active code lives in `ogs-audio.user.js`. The files
`85496146.html` and `ogs.5.1.js` are source snapshots of the target OGS page and bundle and are used only as
reference. The file `NOTES.md` records what has already been learned from instrumented logs.

The cursor-audio feature already works. It finds the real board SVG inside the open shadow root of the live
`.Goban[data-pointers-bound="true"]` host, parses the board grid from the first grid-drawing SVG path, and maps
pointer positions to board coordinates. That existing SVG grid parsing is important because the move-detection feature
should reuse it rather than re-derive board geometry.

In this plan, a "mutation batch" means the array of `MutationRecord` objects delivered by one `MutationObserver`
callback. A "stone-render event" means the useful facts extracted from those raw records, such as "a stone `use` node
with `opacity=1` was added at translate `(472,944)`". A "committed move" means a move that should be announced. A
"hover preview" means the translucent stone shown before a local click and must never be announced.

## Plan of Work

The implementation should stay inside `ogs-audio.user.js` and should build on the existing board shadow-root observer
rather than replacing it. The first change is to stop reasoning directly on raw `MutationRecord` objects in the
observer callback. Introduce a normalization layer near the current mutation logging code that walks the callback's
records and collects a compact summary of the facts relevant to move detection.

That normalizer should extract, for each batch, whether the batch contains an added translated `g` under `g.grid`,
whether it contains an added or removed stone `use` node, the stone asset href, the opacity of the stone, whether a
`shadow-layer` circle was added or removed, and whether a `circle.last-move` was added or removed. The normalizer
should also carry the most specific translated position it can prove for the stone. When a stone `use` does not carry
its own `transform`, the code should read the transform from its nearest stone group ancestor, because that is where
the logs show the board coordinate lives.

The next change is to introduce a committed-move classifier. This should be a small stateful component kept near the
observer code, because local plays span several adjacent mutation batches. The classifier should accept normalized
batches and emit either nothing or one normalized move object. The normalized move object should include the source
kind (`local` or `remote`), the translated SVG position, the derived board coordinate, the stone color if it can be
determined from the `href`, and a short reason string explaining which signature matched.

The classifier must be intentionally strict. A rule is valid only if it controls the full message shape it is claiming
to recognize. In practice that means a rule should name which stone additions or removals must be present, which marker
changes are allowed or required, which opacity values are accepted, and which translated positions must agree. If a
batch contains extra facts that the rule does not account for, the code should treat that batch as unmatched and log
the normalized summary for later analysis.

The remote-move rule should require the batch to add a translated `g.grid` child and solid stone rendering for that
position. The local-move rule should require either preview replacement or stable post-click rendering: a previously
seen preview position becomes an opaque stone at the same translate, and the same translate is accompanied by
`shadow-layer` and `last-move` activity either in the same batch or the immediately following batch. The classifier
must reject pure `last-move` refresh batches and pure preview batches.

Because local moves produce several refresh bursts, the classifier needs deduplication. Maintain a short-lived cache of
recently announced coordinates keyed by board coordinate plus stone color, with a very small time window such as a few
hundred milliseconds. The goal is not long-term state; it is only to collapse the post-click refresh churn into one
announcement.

Once the classifier emits a move object, map its translated SVG position to a board coordinate using the same parsed
grid metrics already used for cursor audio. Do not guess from the outer SVG rectangle. The mapping function should be
shared with the cursor-audio geometry where practical so that one coordinate system is used everywhere.

After the feature is working, trim the temporary mutation dump logs. Keep only narrow logs that prove classification,
such as one line when a batch is classified as preview, one line when a move is emitted, and one line when a batch is
ignored as marker-only noise. During the debug loop, also log every unmatched batch with a compact normalized summary
and a reason like `unmatched-batch-shape` or `ambiguous-local-sequence`. Those logs are the mechanism for tightening
the rules without guessing.

## Concrete Steps

Work from `/home/jerome/Data/ogs-audio`.

First, inspect the current observer and geometry helpers:

  sed -n '1,260p' ogs-audio.user.js
  sed -n '261,520p' ogs-audio.user.js

Then implement the normalizer and classifier in `ogs-audio.user.js`, using `apply_patch` for the edits.

After each meaningful edit, run:

  node --check ogs-audio.user.js

The expected result is no output and exit status 0.

To validate in the browser, reload the userscript in Tampermonkey, open a live game, and capture console output while:

  1. hovering on an empty intersection without clicking
  2. playing one local move
  3. waiting for one remote move

The expected console shape after implementation is:

  [ogs-audio] move batch classified { kind: 'preview', translate: '472,944' }
  [ogs-audio] move detected { source: 'local', color: 'white', coordinate: 'E2', translate: '472,944' }
  [ogs-audio] move detected { source: 'remote', color: 'black', coordinate: 'C7', translate: '708,1062' }
  [ogs-audio] move batch unmatched { reason: 'unmatched-batch-shape', summary: ... }

The exact coordinates will depend on the board position, but the important requirement is one `move detected` log per
committed move and zero announcements for preview-only hover. During debugging, any batch that does not cleanly match a
known rule must produce an `unmatched` log instead of being silently absorbed.

## Validation and Acceptance

Acceptance is behavioral.

Hovering on intersections must not speak a move and must not produce a `move detected` log. A local click that commits
a move must produce exactly one detection log and one spoken move announcement. When the opponent plays, the script
must again produce exactly one detection log and one spoken move announcement. The coordinate in the log and in speech
must match the board intersection that received the stone.

During the debug phase, acceptance also requires observability: every mutation batch seen by the classifier must end up
in one of these categories:

- classified preview
- classified local committed move
- classified remote committed move
- classified marker-only noise
- logged as unmatched with enough summary detail to refine the rules later

Silent fallthrough is not acceptable, because it would hide the exact mutation shapes that still need to be modeled.

Run:

  node --check ogs-audio.user.js

and expect success.

Then manually validate in a real OGS game:

  - local hover preview: no move announcement
  - local committed move: one move announcement
  - remote committed move: one move announcement
  - no duplicate announcements from marker refresh churn

If the browser logs show repeated detections for the same coordinate after one click, the deduplication logic is still
too weak and the milestone is not complete.

## Idempotence and Recovery

The code changes are additive and can be retried safely. If a classifier rule proves too loose, disable that rule and
keep the observer logs rather than falling back to incorrect move announcements. It is better to miss a move during
debugging than to announce the wrong coordinate repeatedly.

If the implementation becomes noisy, revert only the temporary classification logs while keeping the normalization and
deduplication code. Do not restore the old rectangle-based cursor fallback; the SVG-based geometry is already known to
be the correct board model in this repository.

## Artifacts and Notes

Useful evidence already captured in `NOTES.md`:

  Remote committed move:
    add translated `g.grid` child
    add stone `use`
    add `circle.last-move`

  Local hover preview:
    add translated `g.grid` child
    add stone `use` with `opacity="0.6"`

  Local committed move:
    remove preview `use`
    add opaque stone `use`
    add `shadow-layer` circle
    refresh `circle.last-move`

This evidence is the basis for the first classifier rules and should be updated if later logs contradict it.

Debugging note: until the classifier is demonstrably stable, preserve the compact unmatched-batch logs even if they
seem noisy. They are the record of where the current assumptions stop matching the actual board renderer.

## Interfaces and Dependencies

In `ogs-audio.user.js`, define small helper functions close to the board observer. The exact names can change during
implementation, but the resulting structure should include:

  - a normalizer that accepts a `MutationRecord[]` batch and returns a compact summary of stone-related facts
  - a classifier that accepts the normalized batch plus recent state and returns either `null` or a normalized move
    object
  - a mapper that converts a translated SVG position into the board coordinate string already used by cursor audio
  - a deduper that suppresses repeated detections for the same committed move

The normalized move object should contain at least:

  {
    source: 'local' | 'remote',
    color: 'black' | 'white' | 'unknown',
    coordinate: string,
    translateX: number,
    translateY: number,
    reason: string
  }

Revision note: created on 2026-03-31 to turn the logged remote/local mutation evidence into an executable plan for
rigorous move detection and coordinate recovery.

Revision note: updated on 2026-03-31 after implementation to record that the mutation normalizer, strict classifier,
SVG coordinate mapping, and unmatched-batch logging were added to `ogs-audio.user.js`; live browser validation still
remains.
