package main

// Windows 판에 필요한 도구 (맥은 macOS 에 들어 있는 기능을 써서 필요 없어요)
//
//	ffmpeg · ffprobe — 영상 읽기 · 썸네일 · 파형 · 내보내기. 처음 켤 때 한 번 받아요(약 100MB, 사용자 결정 2026-11-03).
//	whisper-cli      — 자동 자막(받아쓰기). exe 안에 들어 있다가(tools_embed_windows.go) 처음 쓸 때 꺼내요.
//	ggml-small.bin   — 받아쓰기 모델. 자동 자막을 처음 쓸 때만 받아요(약 470MB, 사용자 결정 2026-11-03).
//
// 받은 파일은 sha256 을 확인하고, 다 받은 뒤에만 bin 폴더로 옮겨요(중간에 끊기면 다음에 처음부터).
// 리눅스 시험: CUTROAD_FFMPEG_DIR(없으면 PATH) 의 ffmpeg · ffprobe 를 복사, CUTROAD_WHISPER · CUTROAD_WHISPER_MODEL 은 파일 경로.

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

func exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

type dlSource struct {
	URL    string
	SHA256 string // 비어 있으면 확인하지 않음 (예비 주소)
}

// ffmpeg: 고정된 버전(8.0.1, 검사값 확인) → 안 되면 gyan.dev 의 최신판
var ffmpegSources = []dlSource{
	{"https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip", "e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673"},
	{"https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", ""},
}

// 받아쓰기 모델 (whisper small, 다국어)
const modelSize = 487601967

var modelSources = []dlSource{
	{"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin", "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"},
	{"https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin", "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"},
}

type Tools struct {
	mu      sync.Mutex
	support string
	bin     string
	state   string // idle | down | ready | error
	err     string
	done    int64
	total   int64
	ready   chan struct{}
	once    sync.Once
	running bool
}

func NewTools(support string) *Tools {
	t := &Tools{support: support, bin: filepath.Join(support, "bin"), state: "idle", ready: make(chan struct{})}
	if t.installed() {
		t.state = "ready"
		t.once.Do(func() { close(t.ready) })
	}
	return t
}

func (t *Tools) Path(name string) string { return filepath.Join(t.bin, exe(name)) }

func (t *Tools) installed() bool {
	return isExecutable(t.Path("ffmpeg")) && isExecutable(t.Path("ffprobe"))
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir() && st.Size() > 0
}

func (t *Tools) State() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	return map[string]any{"state": t.state, "error": t.err, "done": t.done, "total": t.total}
}

func (t *Tools) Ready() bool {
	select {
	case <-t.ready:
		return true
	default:
		return false
	}
}

// Wait waits until ffmpeg is ready (starting the install if needed).
func (t *Tools) Wait(ctx context.Context) error {
	if t.Ready() {
		return nil
	}
	t.Start()
	select {
	case <-t.ready:
		return nil
	case <-ctx.Done():
		t.mu.Lock()
		e := t.err
		t.mu.Unlock()
		if e != "" {
			return errors.New(e)
		}
		return errors.New("영상 도구를 아직 준비하는 중이에요. 잠시 뒤에 다시 해 주세요")
	}
}

// Start installs ffmpeg · ffprobe in the background (once at a time).
func (t *Tools) Start() {
	t.mu.Lock()
	if t.running || t.Ready() {
		t.mu.Unlock()
		return
	}
	t.running, t.state, t.err, t.done, t.total = true, "down", "", 0, 0
	t.mu.Unlock()
	go func() {
		defer recoverLog("tools")
		err := t.install()
		t.mu.Lock()
		t.running = false
		if err != nil {
			t.state, t.err = "error", err.Error()
			log.Printf("도구 설치 실패: %v", err)
		} else {
			t.state = "ready"
			log.Printf("영상 도구(ffmpeg) 준비 완료")
		}
		t.mu.Unlock()
		if err == nil {
			t.once.Do(func() { close(t.ready) })
		}
	}()
}

func (t *Tools) install() error {
	os.MkdirAll(t.bin, 0o755)
	if runtime.GOOS != "windows" { // 리눅스 시험: 이미 있는 ffmpeg 를 복사
		for _, n := range []string{"ffmpeg", "ffprobe"} {
			src := ""
			if d := env("FFMPEG_DIR"); d != "" {
				src = filepath.Join(d, n)
			} else if p, err := exec.LookPath(n); err == nil {
				src = p
			}
			if src == "" {
				return fmt.Errorf("%s 을 찾지 못했어요", n)
			}
			if err := copyFile(src, t.Path(n)); err != nil {
				return err
			}
			os.Chmod(t.Path(n), 0o755)
		}
		return nil
	}
	tmp := filepath.Join(t.support, "setup-tmp")
	os.RemoveAll(tmp)
	os.MkdirAll(tmp, 0o755)
	defer os.RemoveAll(tmp)
	zipPath := filepath.Join(tmp, "ffmpeg.zip")
	var lastErr error
	srcs := ffmpegSources
	if u := env("FFMPEG_URL"); u != "" { // 시험용
		srcs = []dlSource{{URL: u}}
	}
	for _, s := range srcs {
		lastErr = fetch(context.Background(), s, zipPath, func(d, tot int64) {
			t.mu.Lock()
			t.done, t.total = d, tot
			t.mu.Unlock()
		})
		if lastErr == nil {
			lastErr = extractZipFiles(zipPath, map[string]string{"ffmpeg.exe": t.Path("ffmpeg"), "ffprobe.exe": t.Path("ffprobe")})
		}
		if lastErr == nil {
			return nil
		}
		log.Printf("ffmpeg 받기 실패 (%s): %v", s.URL, lastErr)
		os.Remove(zipPath)
	}
	return fmt.Errorf("영상 도구를 받지 못했어요 — %v", lastErr)
}

// ---------------------------------------------------------------- 받아쓰기 (whisper)

func (t *Tools) whisperPath() string {
	if p := env("WHISPER"); p != "" {
		return p
	}
	return filepath.Join(t.bin, "whisper", exe("whisper-cli"))
}

func (t *Tools) modelPath() string {
	if p := env("WHISPER_MODEL"); p != "" {
		return p
	}
	return filepath.Join(t.support, "models", "ggml-small.bin")
}

// ModelReady: 받아쓰기 모델을 이미 받았는지 (처음이면 화면에 '약 470MB 받아요'라고 알려 줘요)
func (t *Tools) ModelReady() bool {
	st, err := os.Stat(t.modelPath())
	return err == nil && (env("WHISPER_MODEL") != "" || st.Size() == modelSize)
}

var whisperMu sync.Mutex

// EnsureWhisper puts whisper-cli in place and downloads the model if needed.
func (t *Tools) EnsureWhisper(ctx context.Context, progress func(msg string, done, total int64)) error {
	whisperMu.Lock()
	defer whisperMu.Unlock()
	wp := t.whisperPath()
	if !isExecutable(wp) {
		if len(whisperExe) == 0 {
			return errors.New("이 버전에는 받아쓰기 도구가 들어 있지 않아요")
		}
		os.MkdirAll(filepath.Dir(wp), 0o755)
		if err := writeFileAtomicErr(wp, whisperExe, 0o755); err != nil {
			return fmt.Errorf("받아쓰기 도구를 준비하지 못했어요: %v", err)
		}
	}
	if t.ModelReady() {
		return nil
	}
	mp := t.modelPath()
	os.MkdirAll(filepath.Dir(mp), 0o755)
	var lastErr error
	for _, s := range modelSources {
		if u := env("MODEL_URL"); u != "" { // 시험용
			s = dlSource{URL: u, SHA256: s.SHA256}
		}
		lastErr = fetch(ctx, s, mp, func(d, tot int64) { progress("받아쓰기 모델 받는 중 (처음 한 번만)", d, tot) })
		if lastErr == nil {
			return nil
		}
		if ctx.Err() != nil {
			return errors.New("취소했어요")
		}
		log.Printf("받아쓰기 모델 받기 실패 (%s): %v", s.URL, lastErr)
	}
	return fmt.Errorf("받아쓰기 모델을 받지 못했어요 — %v", lastErr)
}

// ---------------------------------------------------------------- 받기 도우미

// fetch downloads to dest (via dest.part) and checks sha256 when known.
func fetch(ctx context.Context, s dlSource, dest string, onProgress func(done, total int64)) error {
	if filepath.IsAbs(s.URL) || strings.HasPrefix(s.URL, "file:") { // 시험용: 로컬 파일
		return copyFile(strings.TrimPrefix(s.URL, "file:"), dest)
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", s.URL, nil)
	req.Header.Set("User-Agent", "CUTROAD/"+build)
	resp, err := (&http.Client{Timeout: 60 * time.Minute}).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("인터넷 연결을 확인해 주세요")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("받기 실패 (HTTP %d)", resp.StatusCode)
	}
	part := dest + ".part"
	f, err := os.Create(part)
	if err != nil {
		return err
	}
	h := sha256.New()
	total := resp.ContentLength
	var done int64
	buf := make([]byte, 512<<10)
	last := time.Time{}
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				os.Remove(part)
				return fmt.Errorf("저장하지 못했어요 (디스크 공간을 확인해 주세요): %v", werr)
			}
			h.Write(buf[:n])
			done += int64(n)
			if onProgress != nil && time.Since(last) > 200*time.Millisecond {
				onProgress(done, total)
				last = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(part)
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.New("받는 중에 끊겼어요. 인터넷 연결을 확인해 주세요")
		}
	}
	f.Close()
	if total > 0 && done != total {
		os.Remove(part)
		return errors.New("받는 중에 끊겼어요")
	}
	if s.SHA256 != "" && hex.EncodeToString(h.Sum(nil)) != s.SHA256 {
		os.Remove(part)
		return errors.New("받은 파일이 올바르지 않아요")
	}
	if onProgress != nil {
		onProgress(done, total)
	}
	os.Remove(dest)
	return os.Rename(part, dest)
}

// extractZipFiles copies the named members (matched by base name) to their destinations.
func extractZipFiles(zipPath string, want map[string]string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return errors.New("받은 파일이 손상됐어요")
	}
	defer zr.Close()
	found := 0
	for _, f := range zr.File {
		dest, ok := want[strings.ToLower(filepath.Base(f.Name))]
		if !ok || f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		part := dest + ".part"
		out, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			os.Remove(part)
			return err
		}
		os.Remove(dest)
		if err := os.Rename(part, dest); err != nil {
			return err
		}
		found++
	}
	if found < len(want) {
		return errors.New("받은 파일 안에 필요한 프로그램이 없어요")
	}
	return nil
}

func writeFileAtomicErr(path string, b []byte, perm os.FileMode) error {
	tmp := path + ".part"
	if err := os.WriteFile(tmp, b, perm); err != nil {
		return err
	}
	os.Remove(path)
	return os.Rename(tmp, path)
}
