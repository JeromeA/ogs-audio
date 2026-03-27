BUGS

This document lists past bugs, their symptoms, and how they were fixed. Add any new bugs you find to the end of this
list. The first entry below shows a template.

## Short description of the bug

[How the code was trying to do things right]

[What was actually happening and why]

[How it was fixed]

## The OGS userscript could fail silently

The first OGS blind-audio userscript tried to hook WebSocket, fetch, XHR, and pointer events and infer move and
board data from runtime traffic.

When the script did not work on a real OGS page, there was almost no instrumentation to tell whether the userscript
had loaded at all, whether the browser hooks were attached, or which runtime path OGS was actually using.

The script now emits broad debug logs across the main runtime functions so we can verify script startup, hook
installation, payload parsing, move detection, board detection, and pointer tracking directly from the browser
console.

## The cursor-audio board lookup was using the wrong search strategy

The first cursor-audio implementation tried to discover the OGS board by scanning visible square `canvas` and `svg`
elements globally and choosing the highest-scoring one.

On a real OGS game page, pointer events were firing but the board lookup never found a usable surface. The source
dump and runtime logs showed that OGS uses target-relative pointer math, so a global canvas-only scan was too weak
and could miss the actual board container entirely.

The board lookup now starts from the hovered element, walks its ancestors, inspects `elementsFromPoint`, and only
then falls back to broader board-like selectors. The logs now include the top scored candidates so failed matches are
observable.

## The first target-driven board candidate scoring still preferred containers that were too large

The first refinement of the cursor-audio lookup did stop missing the board completely, but it still ranked some large
board-adjacent containers above the actual playable surface.

That produced coordinates that were consistently far from the hovered intersection because the math was using the
wrong rectangle, even though the rectangle was square and near the pointer.

The candidate scoring now strongly prefers smaller pointer-local square elements over large containers, while still
keeping the candidate summary logs that help diagnose wrong picks.

## Container rectangles were still too indirect for accurate cursor coordinates

Even after the board picker was improved, the cursor logic was still converting mouse positions by dividing a chosen
container rectangle into equal cells.

That remained inaccurate because the actual playable grid sits inside the SVG with its own exact line positions, and
the container rectangle does not tell us where those lines really are.

The cursor logic now parses the SVG grid path, extracts the exact vertical and horizontal line coordinates, and maps
the mouse to the nearest real grid line, with the playable area extending half a cell beyond the first and last
lines.

## The SVG grid parser could still be skipped even when hovering the real board

The first SVG-based cursor implementation relied on the previously selected board surface to find the board SVG.

On the live page, that surface heuristic could still resolve to a nearby container that did not expose the live SVG in
the way the parser expected, so the code silently fell back to the old rectangle-based mapping and picked up a default
or text-derived board size such as `19x19`.

The cursor logic now searches for the SVG directly from the hovered element, from `elementsFromPoint`, and only then
from the broader board surface. It also logs when it had to fall back, so a missed SVG parse is visible.
