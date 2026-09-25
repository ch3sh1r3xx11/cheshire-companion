# CHESHIRE Companion

[![CI](https://github.com/ch3sh1r3xx11/cheshire-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/ch3sh1r3xx11/cheshire-companion/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-ec1561) ![Platform: Windows](https://img.shields.io/badge/platform-Windows-3ddbd9)

**A dry, spitefully loyal demon cat that lives on your desktop.**
An AI companion with hands, a memory — and a collar.

<!-- demo: docs/demo.gif -->

CHESHIRE sits in a transparent window above your desktop, blinks, yawns, and occasionally tells you that the work won't do itself. Hover over it and a chat opens. It answers in character — lowercase, no emoji, never pleased — but it **always** gives you the actual answer. It can look around its own folder, write notes, run a small set of safe commands, see images you paste, and remember facts about you across restarts.

It speaks **English** and **Polish** (switch in the menu).

## Features

- 🐈‍⬛ **Braille cat** with blinking, yawning, smiling and a palette shimmer — drag it anywhere, it remembers where it sits
- 💬 **Chat** on **Gemini** (cloud, free tier) or any **Ollama** model (local / LAN)
- 🖐️ **Tools**: read/write files, list folders, run collared commands — every command and write needs your OK in a native dialog
- 🧠 **Memory**: lasting facts go into `memory.md` and into the system prompt; the conversation survives restarts
- 👁️ **Vision**: paste (`Ctrl+V`, even Print Screen) or drop an image into the chat
- ⌨️ **Terminal**: ask the cat from PowerShell and get a ready-to-run command back
- 📝 **Canvas**: a shared markdown notebook — you write, the cat writes back
- ⏰ **Agenda**: reminds you of things at set times, or nags about loose commitments
- 🎚️ **Claws**: dial the spite from "jokes, no venom" to "no mercy"
- 🔒 **Security first** — see [SECURITY.md](SECURITY.md)

## Quick start

Requirements: **Windows 10/11**, **Node.js 22+**, and either a free [Gemini API key](https://aistudio.google.com/apikey) or [Ollama](https://ollama.com).

```bash
git clone https://github.com/ch3sh1r3xx11/cheshire-companion.git
cd cheshire-companion
npm install
copy .env.example .env      # then paste your key into .env
npm start
```

- **Hover** the cat for 2 s → chat. **Click** → a remark. **Drag** → move. **Right-click** → menu.
- The menu sets fur colour, gaze, claws, model, language and "start with Windows".
- `Esc` hides the chat. **vanish** quits.

No Gemini key? Pick an Ollama model in the menu (point `ollama.url` in the config at your server).

## Configuration

Settings from the menu live in `%APPDATA%\cheshire-companion\cat-settings.json`.
Machine-specific things go into **`%APPDATA%\cheshire-companion\config.json`** — see [`config.example.json`](config.example.json). All keys are optional:

| Key | What it does |
|---|---|
| `operatorName` | How the cat refers to you |
| `homeDir` | The cat's own folder (default `~/Documents/Cheshire`) — memory, canvas, notes |
| `personaExtra` | Extra lines for the system prompt: your projects, your habits, your in-jokes |
| `ollama.url`, `ollama.hiddenModels` | Your Ollama server; models to keep out of the menu (and your screenshots) |
| `gemini.models` | Gemini models offered in the menu |
| `launchers` | Apps the cat opens on "open …" — matched by code, never by the model |
| `vision.*StatsUrl` | JSON stats endpoints; the cat warns about hot CPUs, full disks and suspicious open ports |
| `apiPort` | Port of the local API (default `5599`) |

## Ask from the terminal

Add to your PowerShell profile (`notepad $PROFILE`):

```powershell
function ask {
  $q = ($args -join ' ').Trim()
  $r = Invoke-RestMethod http://127.0.0.1:5599/ask -Method Post -Headers @{ 'X-Cheshire' = '1' } `
       -ContentType 'application/json; charset=utf-8' -Body (@{ q = $q } | ConvertTo-Json -Compress) -TimeoutSec 130
  if ($r.cmd) { $r.cmd } else { $r.text }
}
```

The answer shows up in the cat's chat too — one conversation, one memory. Other endpoints (all require the `X-Cheshire` header): `/show`, `/hide`, `/toggle`, `/say?text=…`, `/canvas` (read the canvas now).

## Development

```bash
npm test          # unit tests (node:test, no extra deps)
npm run lint      # ESLint
npm run check     # both
```

Run a second, isolated cat (its own settings, chat log and config):

```powershell
$env:CHESHIRE_USER_DATA = "$env:TEMP\cheshire-dev"; npm start
```

Layout:

```
src/main/        main process: agent, tools + guard, LLM clients, local API, windows
src/preload/     the only bridge between windows and the main process
src/renderer/    the cat and the chat (plain HTML/CSS/JS, strict CSP)
src/persona/     the cat's character and every line it says, per language
test/            node:test suites
```

Adding a language = one file in `src/persona/` with the same keys (a test checks it).

## Credits

The cat is **`cat3`** from **[PixelSergey/meow](https://github.com/PixelSergey/meow)** by Sergey Ichtchenko (MIT) — the braille art every frame is carved from. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE) © 2026 Mateusz Połomski
