package main

// Windows 판: 맥에서 앱 껍데기(Swift)가 하던 일을 엔진이 해요.
// 화면(util.js 의 CR.native)은 맥에서는 앱 껍데기에, Windows 에서는 POST /api/native 로 같은 부탁을 보내고
// 같은 모양의 답을 받아요 (probe · thumbs · waveform · scanPhotos · beats · export · captions · job …).
// 파일 · 폴더 고르기는 Windows 에서 화면 안 고르기 창(picker, /api/fs/*)으로 해요.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type Nat struct {
	support string
	cache   string
	tools   *Tools
	jobs    *Jobs
	pmu     sync.Mutex
	proxies map[string]string // 원본 경로 → 미리보기용 사본 (만드는 중이면 "")
}

func NewNat(support string) *Nat {
	n := &Nat{support: support, cache: filepath.Join(support, "cache"), tools: NewTools(support), jobs: &Jobs{m: map[string]*Job{}},
		proxies: map[string]string{}}
	os.MkdirAll(n.cache, 0o755)
	n.tools.Start()
	return n
}

func (n *Nat) routes(api func(string, http.HandlerFunc)) {
	api("/api/native", n.handle)
	api("/api/fs/list", handleFsList)
	api("/api/fs/mkdir", handleFsMkdir)
	api("/api/tools/retry", func(w http.ResponseWriter, r *http.Request) {
		n.tools.Start()
		writeJSON(w, n.tools.State())
	})
	api("/api/drop", n.handleDrop)
}

// waitTools: ffmpeg 가 아직 받는 중이면 기다려요 (처음 켤 때만)
func (n *Nat) waitTools() error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	return n.tools.Wait(ctx)
}

func (n *Nat) handle(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var m map[string]any
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(&m); err != nil {
		jsonError(w, 400, "bad request")
		return
	}
	typ, _ := m["type"].(string)
	out, err := n.dispatch(typ, m)
	if err != nil {
		jsonError(w, 400, err.Error())
		return
	}
	writeJSON(w, out)
}

func (n *Nat) dispatch(typ string, m map[string]any) (any, error) {
	needTools := map[string]bool{"probe": true, "thumbs": true, "waveform": true, "beats": true, "export": true, "captions": true}
	if needTools[typ] {
		if err := n.waitTools(); err != nil {
			return nil, err
		}
	}
	switch typ {
	case "probe":
		return map[string]any{"items": n.probeAll(strSlice(m["paths"]))}, nil
	case "thumbs":
		return n.thumbnails(mStr(m, "path"), mNum(m, "height", 90)), nil
	case "waveform":
		return n.waveform(mStr(m, "path")), nil
	case "scanPhotos":
		rec := true
		if v, ok := m["recursive"].(bool); ok {
			rec = v
		}
		return map[string]any{"paths": scanPhotos(mStr(m, "path"), rec)}, nil
	case "beats":
		return n.beats(mStr(m, "path")), nil
	case "reveal":
		if p := mStr(m, "path"); p != "" {
			revealPaths([]string{p})
		}
		return map[string]any{"ok": true}, nil
	case "openFile":
		if p := mStr(m, "path"); p != "" {
			openPaths([]string{p})
		}
		return map[string]any{"ok": true}, nil
	case "export":
		spec, _ := m["spec"].(map[string]any)
		j := n.jobs.add("export")
		go func() { defer recoverJob(j); n.runExport(spec, j) }()
		return map[string]any{"id": j.id}, nil
	case "compress":
		j := n.jobs.add("compress")
		go func() { defer recoverJob(j); n.runCompress(m, j) }()
		return map[string]any{"id": j.id}, nil
	case "captions":
		spec, _ := m["spec"].(map[string]any)
		j := n.jobs.add("captions")
		go func() { defer recoverJob(j); n.runCaptions(spec, j) }()
		return map[string]any{"id": j.id}, nil
	case "job":
		return n.jobs.snapshot(mStr(m, "id")), nil
	case "cancelJob":
		n.jobs.cancel(mStr(m, "id"))
		return map[string]any{"ok": true}, nil
	case "speechStatus":
		// Windows 는 허용 창이 없어요. 모델을 아직 안 받았으면 화면이 '처음 한 번 약 470MB 받아요'라고 알려 줘요
		return map[string]any{"status": "authorized", "needModel": !n.tools.ModelReady(), "modelMB": modelSize / 1_000_000}, nil
	case "openSpeechSettings", "title":
		return map[string]any{"ok": true}, nil
	}
	return nil, fmt.Errorf("알 수 없는 요청이에요 (%s)", typ)
}

// ---------------------------------------------------------------- 작업 (내보내기 · 받아쓰기)

type Job struct {
	id, kind string
	mu       sync.Mutex
	state    string
	progress float64
	message  string
	err      string
	result   map[string]any
	ctx      context.Context
	cancelFn context.CancelFunc
}

func (j *Job) set(p float64, msg string) {
	j.mu.Lock()
	if p < 0 {
		p = 0
	}
	if p > 1 {
		p = 1
	}
	j.progress = p
	if msg != "" {
		j.message = msg
	}
	j.mu.Unlock()
}
func (j *Job) finish(r map[string]any) {
	j.mu.Lock()
	j.state, j.progress, j.result = "done", 1, r
	j.mu.Unlock()
}
func (j *Job) fail(e string) {
	j.mu.Lock()
	if j.ctx.Err() != nil {
		j.state, j.err = "cancelled", "취소했어요"
	} else {
		j.state, j.err = "error", e
	}
	j.mu.Unlock()
}
func (j *Job) cancelled() bool { return j.ctx.Err() != nil }
func (j *Job) getProgress() float64 {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.progress
}

type Jobs struct {
	mu sync.Mutex
	m  map[string]*Job
	n  int
}

func (js *Jobs) add(kind string) *Job {
	js.mu.Lock()
	defer js.mu.Unlock()
	js.n++
	ctx, cancel := context.WithCancel(context.Background())
	j := &Job{id: fmt.Sprintf("%s-%d-%d", kind, js.n, time.Now().Unix()), kind: kind, state: "running", ctx: ctx, cancelFn: cancel, result: map[string]any{}}
	js.m[j.id] = j
	return j
}

func (js *Jobs) snapshot(id string) map[string]any {
	js.mu.Lock()
	j := js.m[id]
	js.mu.Unlock()
	if j == nil {
		return map[string]any{"state": "error", "error": "작업을 찾지 못했어요"}
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return map[string]any{"id": j.id, "kind": j.kind, "state": j.state, "progress": j.progress, "message": j.message, "error": j.err, "result": j.result}
}

func (js *Jobs) cancel(id string) {
	js.mu.Lock()
	j := js.m[id]
	js.mu.Unlock()
	if j != nil {
		j.cancelFn()
	}
}

func (js *Jobs) cancelAll() {
	js.mu.Lock()
	defer js.mu.Unlock()
	for _, j := range js.m {
		j.cancelFn()
	}
}

func recoverJob(j *Job) {
	if v := recover(); v != nil {
		buf := make([]byte, 8<<10)
		buf = buf[:runtime.Stack(buf, false)]
		log.Printf("PANIC in job %s: %v\n%s", j.id, v, buf)
		j.fail("앱 안에서 문제가 생겼어요. 다시 시도해 주세요")
	}
}

// ---------------------------------------------------------------- 앱 안 파일 고르기 (/api/fs/*)

var importExts = map[string]bool{".mov": true, ".mp4": true, ".mp3": true, ".wav": true, ".m4a": true,
	".jpg": true, ".jpeg": true, ".png": true, ".heic": true, ".heif": true}

type fsEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Dir   bool   `json:"dir,omitempty"`
	Size  int64  `json:"size,omitempty"`
	MTime int64  `json:"mtime,omitempty"`
	Icon  string `json:"icon,omitempty"`
}

func quickPlaces() []fsEntry {
	home, _ := os.UserHomeDir()
	out := []fsEntry{}
	for _, p := range []struct{ name, dir, icon string }{
		{"바탕 화면", "Desktop", "desk"}, {"동영상", "Videos", "film"}, {"사진", "Pictures", "image"},
		{"음악", "Music", "music"}, {"다운로드", "Downloads", "down"}, {"문서", "Documents", "doc"},
	} {
		d := filepath.Join(home, p.dir)
		if dirExists(d) {
			out = append(out, fsEntry{Name: p.name, Path: d, Icon: p.icon, Dir: true})
		}
	}
	if od := os.Getenv("OneDrive"); od != "" && dirExists(od) {
		out = append(out, fsEntry{Name: "OneDrive", Path: od, Icon: "cloud", Dir: true})
	}
	return out
}

func drives() []fsEntry {
	out := []fsEntry{}
	if runtime.GOOS != "windows" {
		return append(out, fsEntry{Name: "내 컴퓨터", Path: "/", Icon: "drive", Dir: true})
	}
	for c := 'C'; c <= 'Z'; c++ {
		root := string(c) + ":\\"
		if _, err := os.Stat(root); err == nil {
			out = append(out, fsEntry{Name: string(c) + ": 드라이브", Path: root, Icon: "drive", Dir: true})
		}
	}
	return out
}

// handleFsList: 폴더 안의 폴더 · (고를 수 있는) 파일. kind = video(가져오기) | music | folder
func handleFsList(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
		Kind string `json:"kind"`
	}
	readJSON(r, &in)
	p := in.Path
	if p == "" || !dirExists(p) {
		home, _ := os.UserHomeDir()
		p = home
		if v := filepath.Join(home, "Videos"); in.Kind != "folder" && dirExists(v) {
			p = v
		}
	}
	p = filepath.Clean(p)
	ents, err := os.ReadDir(p)
	dirs, files := []fsEntry{}, []fsEntry{}
	exts := importExts
	if in.Kind == "music" {
		exts = map[string]bool{".mp3": true, ".wav": true, ".m4a": true}
	} else if in.Kind == "movie" { // 용량 줄이기: 영상만
		exts = map[string]bool{".mov": true, ".mp4": true}
	}
	if err == nil {
		for _, e := range ents {
			nm := e.Name()
			if strings.HasPrefix(nm, ".") || strings.HasPrefix(nm, "$") || nm == "System Volume Information" || strings.EqualFold(nm, "desktop.ini") {
				continue
			}
			full := filepath.Join(p, nm)
			isDir := e.IsDir()
			if !isDir && e.Type()&os.ModeSymlink != 0 {
				isDir = dirExists(full)
			}
			if isDir {
				dirs = append(dirs, fsEntry{Name: nm, Path: full, Dir: true})
			} else if in.Kind != "folder" && exts[strings.ToLower(filepath.Ext(nm))] {
				fe := fsEntry{Name: nm, Path: full}
				if info, err := e.Info(); err == nil {
					fe.Size, fe.MTime = info.Size(), info.ModTime().UnixMilli()
				}
				files = append(files, fe)
			}
		}
	}
	less := func(a []fsEntry) func(i, j int) bool {
		return func(i, j int) bool { return strings.ToLower(a[i].Name) < strings.ToLower(a[j].Name) }
	}
	sort.Slice(dirs, less(dirs))
	sort.Slice(files, less(files))
	parent := filepath.Dir(p)
	if parent == p {
		parent = ""
	}
	writeJSON(w, map[string]any{"path": p, "name": filepath.Base(p), "parent": parent, "dirs": dirs, "files": files,
		"places": quickPlaces(), "drives": drives(), "readable": err == nil})
}

func handleFsMkdir(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	readJSON(r, &in)
	name := strings.TrimSpace(in.Name)
	if name == "" || strings.ContainsAny(name, `\/:*?"<>|`) || name == "." || name == ".." {
		jsonError(w, 400, "폴더 이름에 쓸 수 없는 글자가 있어요")
		return
	}
	dir := filepath.Join(in.Path, name)
	if err := os.Mkdir(dir, 0o755); err != nil {
		if os.IsExist(err) {
			jsonError(w, 400, "같은 이름의 폴더가 이미 있어요")
			return
		}
		jsonError(w, 500, "이 위치에는 폴더를 만들 수 없어요")
		return
	}
	writeJSON(w, map[string]any{"ok": true, "path": dir})
}

// handleDrop: 창에 끌어다 놓은 파일. 브라우저는 파일의 위치를 알려 주지 않아서
// 이름 · 크기 · 수정 시각이 같은 파일을 자주 쓰는 폴더에서 찾아요 (못 찾으면 화면이 '가져오기'로 안내해요).
func (n *Nat) handleDrop(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Files []struct {
			Name  string `json:"name"`
			Size  int64  `json:"size"`
			MTime int64  `json:"mtime"`
		} `json:"files"`
		Hints []string `json:"hints"` // 최근에 가져온 파일들의 폴더
	}
	readJSON(r, &in)
	roots := []string{}
	seen := map[string]bool{}
	addRoot := func(d string) {
		if d != "" && !seen[d] && dirExists(d) {
			seen[d] = true
			roots = append(roots, d)
		}
	}
	for _, h := range in.Hints {
		addRoot(h)
	}
	for _, p := range quickPlaces() {
		addRoot(p.Path)
	}
	found := []string{}
	missing := []string{}
	deadline := time.Now().Add(6 * time.Second)
	for _, f := range in.Files {
		hit := ""
		for _, root := range roots {
			if hit = findFile(root, f.Name, f.Size, f.MTime, 3, deadline); hit != "" {
				break
			}
		}
		if hit != "" {
			found = append(found, hit)
		} else {
			missing = append(missing, f.Name)
		}
	}
	writeJSON(w, map[string]any{"paths": found, "missing": missing})
}

func findFile(dir, name string, size, mtime int64, depth int, deadline time.Time) string {
	if time.Now().After(deadline) {
		return ""
	}
	cand := filepath.Join(dir, name)
	if st, err := os.Stat(cand); err == nil && !st.IsDir() && st.Size() == size && (mtime == 0 || absI64(st.ModTime().UnixMilli()-mtime) < 2500) {
		return cand
	}
	if depth <= 0 {
		return ""
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range ents {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") && !strings.HasPrefix(e.Name(), "$") {
			if p := findFile(filepath.Join(dir, e.Name()), name, size, mtime, depth-1, deadline); p != "" {
				return p
			}
		}
	}
	return ""
}

func absI64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// ---------------------------------------------------------------- 작은 도우미

func mStr(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func mNum(m map[string]any, k string, def float64) float64 {
	switch v := m[k].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	}
	return def
}

func mBool(m map[string]any, k string, def bool) bool {
	if v, ok := m[k].(bool); ok {
		return v
	}
	return def
}

func strSlice(v any) []string {
	a, _ := v.([]any)
	out := make([]string, 0, len(a))
	for _, x := range a {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func numSlice(v any) []float64 {
	a, _ := v.([]any)
	out := make([]float64, 0, len(a))
	for _, x := range a {
		if f, ok := x.(float64); ok {
			out = append(out, f)
		}
	}
	return out
}

func execCtx(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	return cmd
}
