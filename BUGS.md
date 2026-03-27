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
