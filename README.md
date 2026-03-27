# playgogame-audio

This repository contains a Tampermonkey userscript for `playgogame.org`.

## Install

For regular use, install the userscript from this URL:

```text
https://github.com/JeromeA/playgogame-audio/raw/refs/heads/main/playgogame-audio.user.js
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
http://127.0.0.1:8123/playgogame-audio.user.js
```

In Tampermonkey, open `Dashboard`, then `Utilities`, then `Import from URL`.
Paste the local URL above and import the script.

## Updating the script

After each change to the userscript, update the `@version` field in
`playgogame-audio.user.js`. Tampermonkey uses the version number to detect
that an installed script has changed.
