# Security

CHESHIRE is an AI agent with hands: it can read and write files and run commands on your machine. A language model decides what to do, and a language model can be manipulated — by a file it reads, a pasted screenshot, a web page it summarizes. So the design assumes the model is **untrusted input** and puts every capability behind code that does not care what the model says.

## Threat model in one table

| Layer | What it stops |
|---|---|
| **Renderer isolation** — `contextIsolation`, Chromium `sandbox`, no `nodeIntegration`, a preload exposing ~10 narrow functions | Text from the model becoming code with access to your system |
| **Text-only rendering** — messages are built with `textContent`, never `innerHTML` | Script injection through model output (`<img onerror=…>`, `<script>`) |
| **Content Security Policy** — `default-src 'none'`, scripts only from the app | Anything the renderer might try to load or call on the network |
| **Conversation in the main process** — windows only display events | The API key reaching a window; a window executing tools |
| **API key in a header**, read from `.env`, never stored in settings | Keys leaking into URLs, logs, error messages or the settings file |
| **Native consent dialogs** for every command and every write | A spoofed "Allow" button — the dialog comes from the OS, not from a page |
| **The collar** (`src/main/tools/guard.js`) | Shells, interpreters, chaining (`&&`, `\|`), redirection (`>`), variable expansion (`%`), deletion, downloads, dangerous `git` options, binaries run by path |
| **Home containment** with symlink/junction resolution | File writes and `mkdir/copy/move/ren` escaping the cat's folder |
| **Executable resolution** — PATH only, never the current directory | The cat planting `git.exe` in its home and running it |
| **Local API** — loopback only, `X-Cheshire` header required, `Origin` rejected, `Host` checked | Web pages poking the API (`<img src=…>`, `fetch`, DNS rebinding) |
| **IPC sender checks** — every handler verifies which window is calling | One window using another window's privileges |
| **Navigation, pop-ups, webviews and permissions denied** | A window being turned into a browser |

What CHESHIRE deliberately **does not** protect against: malware already running as your user (it can do anything the cat can, and more), and you clicking **Allow** on something you did not read. The dialogs show the full command or path — read them.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability). You will get an answer within a week.
