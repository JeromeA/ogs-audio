# ogs-audio

This repository contains a Tampermonkey userscript for `online-go.com` that adds blind audio support.

The script implements two features:

1. When the opponent plays, it announces the move coordinate.
2. When you move the pointer across the board, it announces the current intersection so you can place a move
   blindfolded.

## Install

For regular use, install the userscript from this URL:

```text
https://github.com/JeromeA/ogs-audio/raw/refs/heads/main/ogs-audio.user.js
```

Chrome blocks userscript installation from URLs outside the Chrome Web Store, so
install it through Tampermonkey:

1. Open Tampermonkey.
2. Go to `Dashboard`.
3. Open `Utilities`.
4. Use `Import from URL`.
5. Paste the URL above and import the script.

## Developer installation

From the repository root, start a simple HTTP server:

```bash
python3 -m http.server 8123
```

Install it through Tampermonkey using the same import flow:

```text
http://127.0.0.1:8123/ogs-audio.user.js
```

In Tampermonkey, open `Dashboard`, then `Utilities`, then `Import from URL`.
Paste the local URL above and import the script.

## Updating the script

After each change to the userscript, update the `@version` field in
`ogs-audio.user.js`. Tampermonkey uses the version number to detect
that an installed script has changed.
