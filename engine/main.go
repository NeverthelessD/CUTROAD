// CUTROAD — 가벼운 영상 편집기 (macOS, Apple Silicon)
// made by. Nevertheless_D
//
// 이 엔진이 하는 일: 앱 화면(web/) 보여 주기 · 프로젝트 저장 · 설정 · 영상/소리 파일을 화면에 보내기(미리보기용) ·
// 자동 업데이트 · 진단 기록. 영상 처리(내보내기 · 파형 · 썸네일 · 자동 자막)는 앱 껍데기(app/shell, Swift)가 맥 내장
// 기능(AVFoundation · Speech)으로 해요.
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// build is the app version, set with -ldflags "-X main.build=1.2.3".
var build = "0.0.0-dev"

//go:embed web
var webFiles embed.FS

type Settings struct {
	Appearance   string         `json:"appearance"`   // system | light | dark
	AutoSave     bool           `json:"autoSave"`     // 편집하면 바로 저장
	AutoUpdate   bool           `json:"autoUpdate"`   // 새 버전을 알아서 받기
	ExportPreset string         `json:"exportPreset"` // 기본 내보내기 프리셋
	ExportDir    string         `json:"exportDir"`    // 내보낸 파일을 저장할 폴더
	OpenOnStart  string         `json:"openOnStart"`  // (시험용) 켜자마자 열 프로젝트 — 한 번 쓰면 지워요
	UI           map[string]any `json:"ui"`
}

type App struct {
	support string
	token   string
	port    int

	mu       sync.Mutex
	settings Settings

	upd      *Updater
	projects *Projects

	lastVis  atomic.Int64
	lastSeen atomic.Int64
}

var app *App

var started = time.Now()

func touch() { app.lastSeen.Store(int64(time.Since(started))) }

const idleLimit = 90 * time.Minute

func env(k string) string { return os.Getenv("CUTROAD_" + k) }

func main() {
	log.SetFlags(log.LstdFlags)
	home, _ := os.UserHomeDir()
	support := env("SUPPORT")
	if support == "" {
		if runtime.GOOS == "darwin" {
			support = filepath.Join(home, "Library", "Application Support", "CUTROAD")
		} else {
			support = filepath.Join(home, ".cutroad")
		}
	}
	if env("SUPERVISOR") == "1" {
		os.MkdirAll(support, 0o755)
		runSupervisor(support)
		return
	}
	token := env("TOKEN")
	if token == "" {
		token = randID(16)
	}
	app = &App{support: support, token: token}
	os.MkdirAll(support, 0o755)
	os.Rename(filepath.Join(support, "engine.log"), filepath.Join(support, "engine.prev.log"))
	if f, err := os.OpenFile(filepath.Join(support, "engine.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644); err == nil {
		log.SetOutput(io.MultiWriter(os.Stderr, f))
	}
	app.loadSettings()
	touch()
	app.upd = NewUpdater(support)
	app.projects = NewProjects(filepath.Join(support, "projects"))

	go heartbeat(support)
	ln := listen(env("PORT"), env("PORT_WAIT") == "1")
	app.port = ln.Addr().(*net.TCPAddr).Port
	writeFileAtomic(filepath.Join(support, "token"), []byte(token), 0o600)
	writeFileAtomic(filepath.Join(support, "port"), []byte(strconv.Itoa(app.port)), 0o644)
	writeFileAtomic(filepath.Join(support, "lastport"), []byte(strconv.Itoa(app.port)), 0o644)
	log.Printf("CUTROAD %s listening on %d (pid %d, 지킴이 %v)", build, app.port, os.Getpid(), env("CHILD") == "1")

	if app.port != defaultPort {
		go func() {
			defer recoverLog("diag listener")
			if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", defaultPort)); err == nil {
				m := http.NewServeMux()
				m.HandleFunc("/diag", app.handleDiag)
				http.Serve(ln, hostGuard(m))
			}
		}()
	}
	go app.idleWatcher()
	go app.watchParent()
	go func() { defer recoverLog("autoLoop"); app.upd.autoLoop() }()
	srv := &http.Server{Handler: hostGuard(recordRequests(app.routes())), ErrorLog: log.Default()}
	log.Fatal(srv.Serve(ln))
}

// defaultPort: 늘 같은 주소를 쓰면 엔진이 다시 켜져도 열려 있던 창이 이어지고, 진단 페이지도 찾기 쉬워요.
const defaultPort = 47931

func listen(pref string, wait bool) net.Listener {
	p, err := strconv.Atoi(pref)
	if err != nil || p <= 0 {
		p = defaultPort
	}
	tries := 1
	if wait {
		tries = 20
	}
	for i := 0; i < tries; i++ {
		if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			return ln
		}
		time.Sleep(150 * time.Millisecond)
	}
	if p != defaultPort {
		if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", defaultPort)); err == nil {
			return ln
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	return ln
}

// ---------------------------------------------------------------- lifecycle

func (a *App) idleWatcher() {
	defer recoverLog("idleWatcher")
	// Dock 앱(CUTROAD.app)이 켠 엔진은 앱이 켜져 있는 동안 계속 켜 둬요.
	if nativeShell() {
		return
	}
	for range time.Tick(15 * time.Second) {
		idle := time.Since(started) - time.Duration(a.lastSeen.Load())
		if idle > idleLimit && !a.upd.Busy() {
			a.shutdownWhy("오래 쉼")
		}
	}
}

func nativeShell() bool { return env("SHELL") == "native" }

func (a *App) watchParent() {
	if env("CHILD") != "1" {
		return
	}
	ppid := os.Getppid()
	for range time.Tick(2 * time.Second) {
		if os.Getppid() != ppid {
			a.shutdownWhy("지킴이가 사라짐")
		}
	}
}

func (a *App) shutdownWhy(why string) {
	log.Printf("shutdown: %s", why)
	markCleanExit(a.support, why)
	if b, err := os.ReadFile(filepath.Join(a.support, "port")); err == nil && string(b) == strconv.Itoa(a.port) {
		os.Remove(filepath.Join(a.support, "port"))
	}
	os.Exit(0)
}

// ---------------------------------------------------------------- settings

func (a *App) settingsPath() string { return filepath.Join(a.support, "settings.json") }

func (a *App) loadSettings() {
	home, _ := os.UserHomeDir()
	a.settings = Settings{Appearance: "system", AutoSave: true, AutoUpdate: true, ExportPreset: "hd",
		ExportDir: filepath.Join(home, "Movies"), UI: map[string]any{}}
	if b, err := os.ReadFile(a.settingsPath()); err == nil {
		_ = json.Unmarshal(b, &a.settings)
	}
	if a.settings.UI == nil {
		a.settings.UI = map[string]any{}
	}
	if a.settings.ExportDir == "" {
		a.settings.ExportDir = filepath.Join(home, "Movies")
	}
}

func (a *App) saveSettings() {
	b, _ := json.MarshalIndent(a.settings, "", "  ")
	writeFileAtomic(a.settingsPath(), b, 0o644)
}

func (a *App) Settings() Settings {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.settings
	s.UI = make(map[string]any, len(a.settings.UI))
	for k, v := range a.settings.UI {
		s.UI[k] = v
	}
	return s
}

func (a *App) settingsJSON() map[string]any {
	s := a.Settings()
	home, _ := os.UserHomeDir()
	return map[string]any{
		"appearance":   s.Appearance,
		"autoSave":     s.AutoSave,
		"autoUpdate":   s.AutoUpdate,
		"exportPreset": s.ExportPreset,
		"exportDir":    s.ExportDir,
		"ui":           s.UI,
		"home":         home,
		"build":        build,
		"platform":     runtime.GOOS + "/" + runtime.GOARCH,
	}
}

// ---------------------------------------------------------------- routes

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFiles, "web")
	static := http.FileServer(http.FS(sub))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			if r.URL.Query().Get("t") != a.token {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusForbidden)
				io.WriteString(w, "<meta charset=utf-8><body style='font:15px -apple-system;padding:40px'>CUTROAD 앱을 다시 실행해 주세요.</body>")
				return
			}
			b, _ := webFiles.ReadFile("web/index.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Write(b)
			return
		}
		if strings.HasSuffix(r.URL.Path, ".js") || strings.HasSuffix(r.URL.Path, ".css") {
			w.Header().Set("Cache-Control", "no-cache")
		} else if strings.HasPrefix(r.URL.Path, "/fonts/") {
			w.Header().Set("Cache-Control", "public, max-age=604800")
		}
		static.ServeHTTP(w, r)
	})

	mux.HandleFunc("/diag", a.handleDiag)

	api := func(path string, h http.HandlerFunc) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			t := r.Header.Get("x-token")
			if t == "" {
				t = r.URL.Query().Get("t")
			}
			if t != a.token {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			touch()
			if r.URL.Query().Get("vis") == "1" {
				a.lastVis.Store(int64(time.Since(started)))
			}
			defer func() {
				if v := recover(); v != nil {
					log.Printf("PANIC in %s: %v\n%s", path, v, debug.Stack())
					jsonError(w, 500, "앱 안에서 문제가 생겼어요. 다시 시도해 주세요")
				}
			}()
			h(w, r)
		})
	}

	api("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "build": build, "shell": env("SHELL")})
	})
	api("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); a.shutdownWhy("종료 버튼") }()
	})
	api("/api/clientlog", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Items []string `json:"items"`
		}
		readJSON(r, &in)
		for i, x := range in.Items {
			if i >= 30 {
				break
			}
			if len(x) > 600 {
				x = x[:600]
			}
			diag.clientErr(x)
			log.Printf("client: %s", x)
		}
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/poll", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"build": build, "update": a.upd.State(), "shell": env("SHELL")})
	})
	api("/api/crash", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "report": crashReport(a.support)})
	})
	api("/api/settings", a.handleSettings)

	// 프로젝트
	api("/api/projects", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "projects": a.projects.List()})
	})
	api("/api/project", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		b, err := a.projects.Get(id)
		if err != nil {
			jsonError(w, 404, "프로젝트를 찾지 못했어요")
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(b)
	})
	api("/api/project/save", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		b, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
		if err != nil {
			jsonError(w, 400, "bad request")
			return
		}
		id, err := a.projects.Save(b)
		if err != nil {
			jsonError(w, 400, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true, "id": id})
	})
	api("/api/project/delete", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ID string `json:"id"`
		}
		readJSON(r, &in)
		if err := a.projects.Delete(in.ID); err != nil {
			jsonError(w, 400, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})

	// 미리보기용 영상 · 소리 파일 (가져온 파일만, 이 맥 안에서만)
	api("/api/media", a.handleMedia)
	// 자막 파일(.srt) 저장 — 내보낸 영상 옆에
	api("/api/write-text", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := readJSON(r, &in); err != nil || !filepath.IsAbs(in.Path) || strings.ToLower(filepath.Ext(in.Path)) != ".srt" || !dirExists(filepath.Dir(in.Path)) {
			jsonError(w, 400, "자막 파일을 저장할 수 없는 위치예요")
			return
		}
		if err := os.WriteFile(in.Path, []byte(in.Content), 0o644); err != nil {
			jsonError(w, 500, "자막 파일을 저장하지 못했어요")
			return
		}
		writeJSON(w, map[string]any{"ok": true, "path": in.Path})
	})

	api("/api/update/check", func(w http.ResponseWriter, r *http.Request) {
		a.upd.Check(true)
		writeJSON(w, a.upd.State())
	})
	api("/api/update/install", func(w http.ResponseWriter, r *http.Request) {
		go func() { defer recoverLog("install"); a.upd.Install() }()
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/update/rollback", func(w http.ResponseWriter, r *http.Request) {
		if err := a.upd.Rollback(); err != nil {
			jsonError(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/update/restart", func(w http.ResponseWriter, r *http.Request) {
		if err := a.upd.Restart(a.port, a.token); err != nil {
			jsonError(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})
	return mux
}

// Only answer requests addressed to 127.0.0.1 / localhost (DNS rebinding protection).
func hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if host != "127.0.0.1" && host != "localhost" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) handleSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var in map[string]json.RawMessage
		if err := readJSON(r, &in); err != nil {
			jsonError(w, 400, "bad request")
			return
		}
		a.mu.Lock()
		for k, v := range in {
			switch k {
			case "appearance":
				json.Unmarshal(v, &a.settings.Appearance)
			case "autoUpdate":
				json.Unmarshal(v, &a.settings.AutoUpdate)
			case "autoSave":
				json.Unmarshal(v, &a.settings.AutoSave)
			case "exportPreset":
				json.Unmarshal(v, &a.settings.ExportPreset)
			case "exportDir":
				var d string
				if json.Unmarshal(v, &d) == nil && dirExists(d) {
					a.settings.ExportDir = d
				}
			case "takeOpenOnStart":
				a.settings.OpenOnStart = ""
			case "ui":
				var ui map[string]any
				if json.Unmarshal(v, &ui) == nil {
					for kk, vv := range ui {
						a.settings.UI[kk] = vv
					}
				}
			}
		}
		a.saveSettings()
		a.mu.Unlock()
	}
	out := a.settingsJSON()
	out["openOnStart"] = a.Settings().OpenOnStart
	writeJSON(w, out)
}

// mediaTypes: 가져올 수 있는 파일 (사용자 요청: mov · mp4 · mp3 · wav · m4a)
var mediaTypes = map[string]string{
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
}

func (a *App) handleMedia(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("p")
	ct, ok := mediaTypes[strings.ToLower(filepath.Ext(p))]
	if !ok || !filepath.IsAbs(p) {
		http.Error(w, "not allowed", http.StatusForbidden)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, filepath.Base(p), st.ModTime(), f)
}

// ---------------------------------------------------------------- utils

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": msg})
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func randID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func writeFileAtomic(path string, b []byte, perm os.FileMode) {
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, perm) == nil {
		os.Rename(tmp, path)
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func dirExists(p string) bool {
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func init() {
	mime.AddExtensionType(".js", "text/javascript")
	mime.AddExtensionType(".woff2", "font/woff2")
}

func recoverLog(where string) {
	if v := recover(); v != nil {
		log.Printf("PANIC in %s: %v\n%s", where, v, debug.Stack())
	}
}

func crashReport(support string) string {
	var parts []string
	if b, err := os.ReadFile(filepath.Join(support, "engine.prev.out")); err == nil {
		t := string(b)
		if strings.Contains(t, "panic") || strings.Contains(t, "fatal error") || strings.Contains(t, "PANIC") {
			if len(t) > 6000 {
				t = t[len(t)-6000:]
			}
			parts = append(parts, "[지난번 실행]\n"+t)
		}
	}
	if b, err := os.ReadFile(filepath.Join(support, "engine.log")); err == nil {
		t := string(b)
		if i := strings.Index(t, "PANIC"); i >= 0 {
			t = t[i:]
			if len(t) > 6000 {
				t = t[:6000]
			}
			parts = append(parts, "[이번 실행]\n"+t)
		}
	}
	return strings.Join(parts, "\n\n")
}
