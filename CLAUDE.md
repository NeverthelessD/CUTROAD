# CUTROAD — notes for Claude

**Read `PROJECT_NOTES.md` first** (structure, decisions, progress checklist) and update it at the end of every task.
CUTROAD is a personal, lightweight macOS (Apple Silicon) + Windows 10/11 video editor for **Nevertheless_D**, who is not a programmer.
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

**Windows (since 1.3.0, user request 2026-11-03):** one `CUTROAD.exe` = launcher + engine (`engine/launcher_windows.go`, MSROAD/YTROAD
pattern, Edge/Chrome `--app` window). There is no Swift shell, so the **engine does the video work** (`engineNative()`): the page's
`CR.native` goes to `POST /api/native` (`engine/web/js/win.js`), answered by `nat.go` with the same shapes as the Swift bridge —
`media.go` (ffprobe probe · keyframe thumbnails · waveform · preview proxies for HEVC/PCM), `photos.go` (JPG/PNG via Go + EXIF, HEIC via ffmpeg),
`beats.go` (port of Beats in Photos.swift), `plan.go`/`render.go`/`imgops.go`/`text.go` (port of Render.swift/Export.swift: Go compositor,
ffmpeg decodes per clip and encodes libx264/GIF, audio via an ffmpeg filter graph), `captions.go` (whisper-cli). Keep these in step with the
Swift files and `model.js` (same timing, same effect values). ffmpeg 8.0.1 essentials (pinned + sha256) is downloaded on first start (`tools.go`);
the whisper model ggml-small.bin (sha256) on first auto-caption use; `whisper-cli.exe` is embedded (static MinGW build, `scripts/build-whisper-win.sh`).
File/folder picking is an in-app picker (`/api/fs/list`), drag & drop finds the file by name+size+mtime (`/api/drop`).
Build/release: `scripts/build-win.sh --notes …` → `releases/CUTROAD-win-<v>.zip` + `latest-win.json` + `download/CUTROAD-Windows.zip`.
Test on Linux: `CUTROAD_NATIVE=engine CUTROAD_FAKE_OS=windows` (+ `CUTROAD_WHISPER`, `CUTROAD_MODEL_URL`=local file) with real ffmpeg; the real exe under
Wine (`CUTROAD_NO_UI=1`, `CUTROAD_FFMPEG_URL`=local zip). Details in PROJECT_NOTES.md.
