# CUTROAD — notes for Claude

**Read `PROJECT_NOTES.md` first** (structure, decisions, progress checklist) and update it at the end of every task.
CUTROAD is a personal, lightweight macOS (Apple Silicon) video editor for **Nevertheless_D**, who is not a programmer.
Talk to them in Korean, in plain words. Never ask them to use Terminal. Never mention GitHub (or the repo name) in anything the user sees.

Same Dock-app pattern as MSROAD (road-mac-app skill): Swift shell (`app/shell/*.swift`, WKWebView window) → Go supervisor → Go engine
(`engine/`, serves the web UI in `engine/web`, projects, settings, media for preview, self-update from `releases/latest.json`).
**Video work is done in the Swift shell with built-in macOS frameworks** (AVFoundation · Core Image · Core Text · Speech):
probe/thumbnails/waveform (`Media.swift`), timeline → composition + custom compositor (`Render.swift`), MP4/GIF/passthrough export
(`Export.swift`), auto captions (`Captions.swift`). The page talks to it via `window.webkit.messageHandlers.cutroad` (see `Bridge` in main.swift).
Timing math must stay identical in `Render.swift` (`Plan.timing`) and `engine/web/js/model.js` (`CR.timing`).

The app can only be built on a Mac: pushing changes under app/, engine/ or VERSION triggers `.github/workflows/build-mac.yml`, which builds,
ad-hoc signs, runs real-Mac smoke tests (incl. real exports) and force-pushes results to the `ci-results` branch (read results via git:
`git fetch origin +refs/heads/ci-results:refs/remotes/origin/ci-results`). Release with `scripts/release.sh --notes …`.
In tests use `pkill -x`, never `pkill -f cutroad-engine`. Commit author: `Nevertheless_D <NeverthelessD@users.noreply.github.com>`.
UI can be tested on Linux: build the engine, run it with CUTROAD_SUPPORT/CUTROAD_TOKEN, open in headless Chromium (`CR.mock` fakes the native bridge).
