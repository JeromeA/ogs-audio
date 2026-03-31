NOTES

This file records useful debugging conclusions that are not bugs in themselves but help explain the current OGS
integration approach.

## Board mutation analysis for committed moves

After instrumenting the board shadow-root observer with detailed SVG node dumps, two mutation messages were captured
when the opponent played.

### First message

The first message had 2 records:

- removal of one `circle.last-move`
- addition of one `circle.last-move`

There was no stone node added, no translated grid child group, and no stone `use` element. This means the first
message is only the "last move" marker being refreshed or reattached. By itself it is not a reliable move signal.

### Second message

The second message had 6 records:

- removal of the previous `circle.last-move`
- addition of a new `g` under parent class `grid` with `transform="translate(708,1062)"`
- addition of a shadow `circle` under parent class `shadow-layer`
- addition of a `use` node with `href="#white-shell-0-59-96"`
- one attribute mutation on a `circle`
- addition of a new `circle.last-move`

This is the full committed-move render sequence.

### Conclusions

1. Live moves are observable through board DOM mutations, even though transport and goban-engine hooks have not yet
   exposed them reliably.

2. The reliable signature of a committed move is not merely that the `last-move` circle changed. The useful pattern
   is:

   - a new translated `g` under `g.grid`
   - a new stone `use` node
   - a new `last-move` marker

3. Hover previews and committed moves should be distinguishable. Hover previews do not appear to add the full
   combination of translated grid group, stone `use`, and last-move marker refresh.

4. The DOM appears to contain enough information to recover the move coordinate. The key field is the added group
   transform, for example `translate(708,1062)`.

5. The move coordinate should be derivable by:

   - detecting the added `g` under `g.grid`
   - reading its translate coordinates
   - reusing the existing SVG grid metrics
   - mapping the translated stone position to the nearest board intersection

6. If move announcements for both players are acceptable, DOM-based committed-move detection is likely the most
   robust path forward.

### Color detection note

The stone-color clues are mixed:

- the stone asset href `#white-shell-0-59-96` strongly suggests a white stone
- the new `last-move` circle had `stroke="#ffffff"`, which by itself is not a trustworthy color indicator

So if player color is needed, the stone asset href should be trusted more than the marker stroke color.

### Recommended next implementation

Use DOM-based committed-move detection from board shadow-root mutations:

1. Observe the board shadow root.
2. Ignore mutation batches that only refresh `circle.last-move`.
3. Trigger on batches that include an added translated `g` under `g.grid` and/or an added stone `use` node.
4. Parse the added group transform.
5. Convert that position to board coordinates from the existing SVG grid metrics.
6. Announce both players' moves, using the stone asset href to infer color if needed.

## Board mutation analysis for local hover and local committed moves

After capturing a local play sequence, the logs show one hover-preview message before the click and four additional
messages after the click.

### Hover preview before the click

The pre-click hover message had 2 records:

- addition of a new `g` under parent class `grid` with `transform="translate(472,944)"`
- addition of a stone `use` node with `href="#white-shell-2-59-88"` and `opacity="0.6"`

This is the local shadow-stone preview. The key differences from a committed move are:

- the stone asset is already inserted under `g.grid`
- the stone asset is semi-transparent with `opacity="0.6"`
- there is no `last-move` marker update yet
- there is no added `shadow-layer` circle yet

So a translated `g.grid` child plus a `use` node is not by itself a reliable committed-move signal, because the same
pattern appears during hover preview.

### First message after the click

The first post-click message had 8 records. Its useful operations were:

- removal of the preview `use` node with `opacity="0.6"`
- addition of a `circle` under parent class `shadow-layer` with `transform="translate(472,944)"`
- addition of a stone `use` node with the same href but now `opacity="1"`
- one attribute mutation on a `circle`
- removal of the previous `circle.last-move` with `stroke="#ffffff"`
- repeated add/remove/add churn for a new `circle.last-move` with `stroke="#000000"`

This is the main "preview becomes committed move" transition for a local play. The important point is that the
translated stone position already existed from hover preview, so the committed move is expressed mostly as:

- preview stone removed
- opaque real stone added at the same location
- shadow-layer circle added
- `last-move` marker switched to the new location and new contrast color

Unlike the remote-play case, the translated `g.grid` group did not need to be added here because it had already been
created during hover.

### Second message after the click

The second post-click message had 2 records:

- removal of a `circle.last-move` with `stroke="#000000"`
- addition of a `circle.last-move` with `stroke="#000000"`

This is marker refresh noise only. By itself it is not a move signal.

### Third message after the click

The third post-click message had 4 records:

- removal of a `circle.last-move`
- removal of the stone `use` node
- removal of the `shadow-layer` circle
- addition of a new `circle.last-move` with `stroke="#ffffff"`

This looks like a transient board refresh pass after the local move was committed. It removes the just-added stone and
shadow artifacts from the previous rendering pass while keeping the move marker semantics alive.

### Fourth message after the click

The fourth post-click message had 5 records:

- removal of a `circle.last-move` with `stroke="#ffffff"`
- addition of a `shadow-layer` circle at `translate(472,944)`
- addition of a solid stone `use` node with `opacity="1"`
- one attribute mutation on a `circle`
- addition of a new `circle.last-move` with `stroke="#000000"`

This appears to be the stable final render after the transient refresh pass in the third message. It restores the
opaque stone and the new last-move marker at the committed location.

### Combined conclusions from remote and local sequences

1. Remote and local committed moves are both visible through board shadow-root mutations.

2. Remote plays and local plays do not produce identical mutation shapes:

- remote plays add a translated `g.grid` child as part of the committed move
- local plays may add that translated `g.grid` child earlier during hover preview

3. Because of hover preview, an added translated `g.grid` child and added stone `use` node are not enough on their
   own to identify a committed local move.

4. The strongest committed-move signals are currently:

- a stone `use` node becoming opaque (`opacity="1"`)
- a `shadow-layer` circle appearing at the same translated position
- a `circle.last-move` update in the same mutation burst or an immediately adjacent one

5. The local-play sequence includes extra churn after the click, so the implementation should deduplicate announcements
   by board coordinate and possibly by a short time window.

6. The move coordinate is still best derived from the translated stone position, for example `translate(472,944)`,
   using the existing SVG grid metrics.

### Updated implementation direction

The move detector should be DOM-based and treat local and remote moves as two variants of the same rendering pipeline:

1. Observe the board shadow root.
2. Ignore pure `last-move` refresh batches.
3. For remote plays, accept batches that introduce a new translated `g.grid` child together with stone rendering.
4. For local plays, accept the click-time batches where a preview stone is replaced by an opaque stone and a
   `shadow-layer` circle plus `last-move` marker appear for the same translated position.
5. Extract the translated stone position and map it through the parsed SVG grid metrics.
6. Deduplicate announcements so the local multi-batch refresh sequence only speaks once.
