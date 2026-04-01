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

## The real OGS board SVG was hidden behind an open shadow root

The later cursor-audio lookup changes assumed that once the correct goban host element was found, the board SVG would
also be reachable through normal light-DOM selectors such as `querySelector('svg')`.

On the live OGS page, the actual rendered board SVG sits inside the open `shadowRoot` of the innermost
`.Goban[data-pointers-bound="true"]` host. That made the light-DOM SVG search miss the real board entirely and pick
unrelated zero-size SVG fragments elsewhere on the page.

The lookup now targets the goban host element directly, checks its open `shadowRoot`, and prefers rendered SVGs found
there over unrelated light-DOM SVG candidates.

## Opponent move detection could stay completely silent even when cursor audio worked

Once the cursor-audio path was working, the userscript still produced no useful diagnostics when the opponent played a
move.

That made it unclear whether OGS was delivering moves over WebSocket, `fetch`, `XMLHttpRequest`, or some other path,
and whether the script was seeing the traffic but failing to extract a coordinate or not seeing move traffic at all.

The transport and move-analysis paths now log WebSocket, `fetch`, and XHR activity for OGS game-related traffic, plus
payload parsing, coordinate extraction, and remote-move suppression decisions.

## Live OGS moves could bypass generic browser network hooks entirely

After adding transport diagnostics, the logs still showed only startup REST traffic and nothing when later moves were
played.

That meant the active game was not exposing its live move stream through the generic `window.WebSocket`, `fetch`, or
XHR paths in a way the userscript could observe after startup. The source dump also showed OGS has its own internal
socket and goban engine layers.

The userscript now also scans for the live goban/engine instance and instruments move-application methods such as
`place`, `editPlace`, and `jumpTo`, so the next log capture can show whether moves are entering through engine state
changes rather than browser-level network APIs.

## It was too easy to misread logs from an older installed userscript version

While debugging the move path, it was possible to reload the page with an older Tampermonkey-installed version and
mistake those logs for the current code.

That made some log captures misleading, because the absence of a new probe did not necessarily mean the new code path
had failed. It could also mean the browser was still running an older userscript build.

The userscript now logs its own version at startup so each log capture can be tied to the exact installed build.

## The old rectangle fallback for cursor audio could still produce wrong coordinates

Even after the SVG-grid cursor path was working, the earlier rectangle-based fallback was still present in the code.

That fallback was known to be structurally wrong for OGS because it divided a container rectangle into equal cells
instead of using the actual grid geometry from the board SVG.

The fallback has now been removed so cursor audio only runs when the SVG-grid path succeeds.

## Board mutation logs were too coarse to distinguish hover previews from committed moves

After adding a shadow-root mutation observer on the rendered board, the logs did prove that hover previews and played
moves both mutated the board SVG.

But the first mutation summaries only logged target tags and added/removed node counts. That was too little
information to tell a transient half-transparent shadow stone from a committed move stone or its "last move" marker.

The board mutation summaries now include the actual added and removed SVG nodes with tag names, classes, hrefs,
coordinates, transforms, fill and stroke data, and opacity-related attributes.

## Raw board mutation batches were too noisy to drive rigorous move announcements

Even after the detailed SVG mutation dumps were added, the userscript was still reasoning directly on raw
`MutationRecord` batches.

That made the move path too loose. Local hover previews, marker-only refreshes, local commit churn, and remote
commits all came through the same observer, but the code did not have a strict model for which exact batch shapes were
allowed to count as moves and which ones should be treated as assumption breaks.

The move path now normalizes each mutation batch into stone-render facts, classifies the batch strictly as preview,
local move, remote move, marker noise, or unmatched, maps committed stone positions through the parsed SVG grid
metrics, and logs unmatched batch shapes explicitly so the remaining gaps can be debugged without silent fallthrough.

## Empty normalized board batches were still being logged as unmatched moves

After the strict move classifier was added, the board observer could still emit `move batch unmatched` during page
startup even before any moves were played.

Those logs came from mutation callbacks whose raw DOM changes were real, but whose normalized stone-render summary was
completely empty. In other words, they were irrelevant board churn, not a broken classifier assumption.

The move path now drops empty normalized batches before classification, so startup noise does not appear as a false
unmatched move. The simple startup logs were also changed to plain-text messages so the installed version and observed
game id are visible without expanding console objects.

## Local move batches mixed incompatible SVG point conventions

The first strict local-move classifier compared raw SVG point keys from preview stones, opaque stones, and shadow
circles as if they all represented the same anchor point.

In practice, local click batches mix different point conventions. Added opaque stones and shadow circles can resolve to
different raw SVG coordinates for the same board intersection, while detached removed preview nodes can collapse to
`0,0`. That made real local moves fall into `unmatched-batch-shape` even though the classifier was seeing the right
nodes.

The move path now normalizes stone, grid-group, and shadow-circle entries to the nearest board intersection using the
parsed SVG grid metrics, matches local commits on that normalized board coordinate, and treats removed-node origin
points like `0,0` as unusable rather than trustworthy move geometry.

## Move-detection logs did not expose the actual classifier evidence

When a remote move was unexpectedly classified as local, the console output showed only the final label and reason.

That proved the misclassification happened, but it did not show which predicates were true inside the classifier, such
as whether a recent preview match or a grid-group match triggered the wrong branch. Debugging then depended on manual
console expansion and still left some decision inputs implicit.

The move-detection log now includes the classifier evidence directly in each `move detected` record, including the
chosen intersection, the raw point key, and the booleans that decided between the local and remote branches.

## The local move rule treated shadow circles as local-only evidence

After classifier evidence was logged, a remote move was shown matching the local branch even though there was no
removed preview and no recent preview at the committed intersection.

The deciding mistake was that the local predicate accepted `shadowCircleAtCommitPoint` as if it were evidence of a
local click. But remote committed moves can also add a shadow circle at the played intersection, so that condition was
not specific to local moves at all.

The local predicate now requires actual preview evidence only: either a removed preview at the committed intersection
or a recent preview remembered for that same intersection. Shadow circles remain part of the observed rendering, but
they no longer force the local branch by themselves.

## Remote and reload detections were still populating local move memory

While reloading a game with existing moves, the logs still showed `rememberLocalMove` for the current board state even
though the move had been classified as remote.

That was semantically wrong. Remote or reload detections should not populate the local move memory that is meant to
suppress re-announcing the user's own just-played move.

The payload and raw-text analyzers already limited `rememberLocalMove` to outgoing traffic, but the higher-level
`announceDetectedMove` path was still recording every detected move as local. It now only records moves whose source is
actually `local`.

## Color debugging needed the actual stone candidates, not just the chosen result

When a reload correctly classified the last move as remote but assigned the wrong color, the logs showed only the
chosen `commitStoneColor`.

That still hid the key question: whether the parser had chosen the wrong stone node from the batch or whether it had
parsed the chosen stone's href incorrectly.

The move-detection evidence now includes the chosen stone href and the full list of opaque stone candidates in the
batch, each with href, parsed color, raw point key, and normalized board coordinate.

## Shell asset names did not reliably encode the played stone color

After the opaque stone candidates were logged, reload batches showed multiple stones named like `#white-shell-*` even
though only one of those stones was actually white and the current last move could be black.

That means the shell asset name is a rendering-style identifier, not a trustworthy color signal. Using it directly for
speech color made reload announcements say the wrong color.

The move classifier now prefers the last-move marker stroke to infer color. A white marker stroke implies a black
stone underneath, and a black marker stroke implies a white stone underneath. The shell href color is now only a
fallback and debug aid when marker evidence is absent.
