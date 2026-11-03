package main

// Windows 판: 파일 정보 · 썸네일 · 파형 · 미리보기용 사본 (맥의 Media.swift 와 같은 답)

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	videoExts = map[string]bool{".mov": true, ".mp4": true}
	audioExts = map[string]bool{".mp3": true, ".wav": true, ".m4a": true}
	photoExts = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".heic": true, ".heif": true}
)

// ff runs ffmpeg/ffprobe without a console window.
func (n *Nat) ff(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, n.tools.Path(name), args...)
	hideWindow(cmd)
	return cmd
}

func cacheKey(path string) string {
	var size, mt int64
	if st, err := os.Stat(path); err == nil {
		size, mt = st.Size(), st.ModTime().UnixNano()
	}
	h := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d|v1", path, size, mt)))
	return hex.EncodeToString(h[:12])
}

func (n *Nat) cacheDir(sub string) string {
	d := filepath.Join(n.cache, sub)
	os.MkdirAll(d, 0o755)
	return d
}

// ---------------------------------------------------------------- 파일 정보

type ffStream struct {
	CodecType    string            `json:"codec_type"`
	CodecName    string            `json:"codec_name"`
	Width        int               `json:"width"`
	Height       int               `json:"height"`
	RFrameRate   string            `json:"r_frame_rate"`
	AvgFrameRate string            `json:"avg_frame_rate"`
	Duration     string            `json:"duration"`
	Tags         map[string]string `json:"tags"`
	SideData     []map[string]any  `json:"side_data_list"`
	Disposition  map[string]int    `json:"disposition"`
}

type ffProbe struct {
	Streams []ffStream `json:"streams"`
	Format  struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

func (n *Nat) ffprobe(path string) (*ffProbe, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := n.ff(ctx, "ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path).Output()
	if err != nil {
		return nil, err
	}
	var p ffProbe
	if err := json.Unmarshal(out, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (p *ffProbe) video() *ffStream {
	for i := range p.Streams {
		s := &p.Streams[i]
		if s.CodecType == "video" && s.Disposition["attached_pic"] == 0 {
			return s
		}
	}
	return nil
}

func (p *ffProbe) audio() *ffStream {
	for i := range p.Streams {
		if p.Streams[i].CodecType == "audio" {
			return &p.Streams[i]
		}
	}
	return nil
}

// rotation: 화면에 보일 때 시계 방향으로 돌아가는 각도 (0 · 90 · 180 · 270) — Media.swift 의 rotation 과 같은 뜻
func (s *ffStream) rotation() int {
	r := 0.0
	for _, sd := range s.SideData {
		if v, ok := sd["rotation"].(float64); ok {
			r = -v
		}
	}
	if t, ok := s.Tags["rotate"]; ok && r == 0 {
		r, _ = strconv.ParseFloat(t, 64)
	}
	d := int(math.Round(r/90)) * 90
	return ((d % 360) + 360) % 360
}

func parseRate(s string) float64 {
	a, b, ok := strings.Cut(s, "/")
	x, _ := strconv.ParseFloat(a, 64)
	if !ok {
		return x
	}
	y, _ := strconv.ParseFloat(b, 64)
	if y == 0 {
		return 0
	}
	return x / y
}

func (n *Nat) probeAll(paths []string) []map[string]any {
	out := make([]map[string]any, len(paths))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i, p := range paths {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, p string) {
			defer func() { <-sem; wg.Done() }()
			defer func() {
				if v := recover(); v != nil {
					log.Printf("probe panic %s: %v", p, v)
					out[i] = map[string]any{"path": p, "name": filepath.Base(p), "error": "이 파일은 읽을 수 없어요"}
				}
			}()
			out[i] = n.probe(p)
		}(i, p)
	}
	wg.Wait()
	return out
}

func (n *Nat) probe(path string) map[string]any {
	ext := strings.ToLower(filepath.Ext(path))
	out := map[string]any{"path": path, "name": filepath.Base(path)}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		out["error"] = "파일을 찾을 수 없어요"
		return out
	}
	if photoExts[ext] {
		return n.probePhoto(path)
	}
	if !videoExts[ext] && !audioExts[ext] {
		out["error"] = "지원하지 않는 파일이에요 (MOV · MP4 · MP3 · WAV · M4A · JPG · PNG · HEIC)"
		return out
	}
	out["size"] = st.Size()
	p, err := n.ffprobe(path)
	if err != nil {
		out["error"] = "이 파일은 읽을 수 없어요"
		return out
	}
	dur, _ := strconv.ParseFloat(p.Format.Duration, 64)
	v, a := p.video(), p.audio()
	if a != nil && dur <= 0 {
		dur, _ = strconv.ParseFloat(a.Duration, 64)
	}
	out["duration"] = dur
	out["hasAudio"] = a != nil
	if v != nil && videoExts[ext] {
		w, h := v.Width, v.Height
		rot := v.rotation()
		if rot == 90 || rot == 270 {
			w, h = h, w
		}
		fps := parseRate(v.AvgFrameRate)
		if fps <= 0 || fps > 240 {
			fps = parseRate(v.RFrameRate)
		}
		out["kind"], out["width"], out["height"], out["fps"], out["rotation"] = "video", w, h, math.Round(fps*1000)/1000, rot
		out["codec"] = v.CodecName
	} else {
		out["kind"] = "audio"
	}
	if !(dur > 0) || (v == nil && a == nil) {
		out["error"] = "이 파일은 읽을 수 없어요"
	}
	if out["error"] == nil && n.needsProxy(p, ext) {
		go n.makeProxy(path, ext) // 미리보기용 사본은 뒤에서 미리 만들어 둬요
	}
	return out
}

// ---------------------------------------------------------------- 썸네일

var ptsRe = regexp.MustCompile(`pts_time:\s*([0-9.]+)`)

// thumbnails: 타임라인에 보여 줄 작은 그림들 (2초마다 한 장쯤, 4~60장) — 키프레임만 읽어서 빠르게
func (n *Nat) thumbnails(path string, height float64) map[string]any {
	empty := map[string]any{"frames": []string{}, "interval": 0}
	p, err := n.ffprobe(path)
	if err != nil || p.video() == nil {
		return empty
	}
	dur, _ := strconv.ParseFloat(p.Format.Duration, 64)
	if dur <= 0 {
		return empty
	}
	v := p.video()
	w0, h0 := float64(v.Width), float64(v.Height)
	if r := v.rotation(); r == 90 || r == 270 {
		w0, h0 = h0, w0
	}
	aspect := 16.0 / 9.0
	if h0 > 0 {
		aspect = w0 / h0
	}
	h := math.Max(40, math.Min(240, height)) * 2
	count := int(math.Max(4, math.Min(60, math.Ceil(dur/2))))
	interval := dur / float64(count)
	key := cacheKey(path)
	cf := filepath.Join(n.cacheDir("thumbs"), fmt.Sprintf("%s-%d.json", key, int(h)))
	if b, err := os.ReadFile(cf); err == nil {
		var j map[string]any
		if json.Unmarshal(b, &j) == nil {
			return j
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	scale := fmt.Sprintf("showinfo,scale=-2:%d", int(h))
	cmd := n.ff(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-skip_frame", "nokey", "-i", path, "-map", "0:v:0", "-an",
		"-vf", scale, "-fps_mode", "passthrough", "-c:v", "mjpeg", "-q:v", "6", "-f", "image2pipe", "pipe:1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	jpgs, err := cmd.Output()
	if err != nil && len(jpgs) == 0 {
		log.Printf("thumbs %s: %v %s", filepath.Base(path), err, lastLine(stderr.String()))
		return empty
	}
	imgs := splitJPEGs(jpgs)
	var times []float64
	for _, m := range ptsRe.FindAllStringSubmatch(stderr.String(), -1) {
		t, _ := strconv.ParseFloat(m[1], 64)
		times = append(times, t)
	}
	if len(imgs) == 0 {
		return empty
	}
	frames := make([]string, count)
	for i := 0; i < count; i++ {
		want := (float64(i) + 0.5) * interval
		best := 0
		if len(times) == len(imgs) {
			bd := math.Inf(1)
			for k, t := range times {
				if d := math.Abs(t - want); d < bd {
					bd, best = d, k
				}
			}
		} else {
			best = int(math.Min(float64(len(imgs)-1), math.Floor(want/dur*float64(len(imgs)))))
		}
		frames[i] = "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(imgs[best])
	}
	res := map[string]any{"frames": frames, "interval": interval, "aspect": aspect}
	if b, err := json.Marshal(res); err == nil {
		os.WriteFile(cf, b, 0o644)
	}
	return res
}

func splitJPEGs(b []byte) [][]byte {
	var out [][]byte
	for len(b) > 4 {
		s := bytes.Index(b, []byte{0xFF, 0xD8, 0xFF})
		if s < 0 {
			break
		}
		e := bytes.Index(b[s+2:], []byte{0xFF, 0xD9})
		if e < 0 {
			break
		}
		end := s + 2 + e + 2
		// 다음 그림이 바로 이어지지 않으면 EOI 가 그림 안의 값일 수 있어요 → 다음 SOI 까지
		for end < len(b) && !bytes.HasPrefix(b[end:], []byte{0xFF, 0xD8, 0xFF}) {
			nx := bytes.Index(b[end:], []byte{0xFF, 0xD9})
			if nx < 0 {
				end = len(b)
				break
			}
			end += nx + 2
		}
		out = append(out, b[s:end])
		b = b[end:]
	}
	return out
}

// ---------------------------------------------------------------- 파형

const wavePerSec = 50

func (n *Nat) waveform(path string) map[string]any {
	cf := filepath.Join(n.cacheDir("wave"), cacheKey(path)+".json")
	if b, err := os.ReadFile(cf); err == nil {
		var j map[string]any
		if json.Unmarshal(b, &j) == nil {
			return j
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := n.ff(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return map[string]any{"perSec": wavePerSec, "peaks": []float64{}}
	}
	if err := cmd.Start(); err != nil {
		return map[string]any{"perSec": wavePerSec, "peaks": []float64{}}
	}
	r := bufio.NewReaderSize(stdout, 1<<16)
	bucket := 8000 / wavePerSec
	peaks := []float64{}
	var cur int32
	cnt := 0
	buf := make([]byte, 1<<15)
	carry := []byte{}
	for {
		k, rerr := r.Read(buf)
		data := append(carry, buf[:k]...)
		i := 0
		for ; i+1 < len(data); i += 2 {
			v := int32(int16(uint16(data[i]) | uint16(data[i+1])<<8))
			if v < 0 {
				v = -v
			}
			if v > cur {
				cur = v
			}
			cnt++
			if cnt >= bucket {
				peaks = append(peaks, math.Round(float64(cur)/32768*1000)/1000)
				cur, cnt = 0, 0
			}
		}
		carry = append([]byte{}, data[i:]...)
		if rerr != nil {
			break
		}
	}
	cmd.Wait()
	if cnt > 0 {
		peaks = append(peaks, math.Round(float64(cur)/32768*1000)/1000)
	}
	res := map[string]any{"perSec": wavePerSec, "peaks": peaks}
	if len(peaks) > 0 {
		if b, err := json.Marshal(res); err == nil {
			os.WriteFile(cf, b, 0o644)
		}
	}
	return res
}

// readPCM decodes the first audio track to mono float32 at the given rate.
func (n *Nat) readPCM(ctx context.Context, path string, rate int) ([]float32, error) {
	cmd := n.ff(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", strconv.Itoa(rate), "-f", "f32le", "pipe:1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	b, err := cmd.Output()
	if err != nil && len(b) == 0 {
		return nil, fmt.Errorf("소리를 읽지 못했어요: %s", lastLine(stderr.String()))
	}
	out := make([]float32, len(b)/4)
	for i := range out {
		u := uint32(b[4*i]) | uint32(b[4*i+1])<<8 | uint32(b[4*i+2])<<16 | uint32(b[4*i+3])<<24
		out[i] = math.Float32frombits(u)
	}
	return out, nil
}

// ---------------------------------------------------------------- 미리보기용 사본 (브라우저가 못 여는 영상)

// needsProxy: Edge · Chrome 이 바로 재생하지 못하는 형식 (iPhone HEVC, ProRes, ALAC · PCM 소리 …)
func (n *Nat) needsProxy(p *ffProbe, ext string) bool {
	if v := p.video(); v != nil && videoExts[ext] {
		if v.CodecName != "h264" {
			return true
		}
	}
	if a := p.audio(); a != nil {
		switch a.CodecName {
		case "aac", "mp3", "opus", "vorbis", "flac":
		case "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_u8":
			if ext != ".wav" {
				return true
			}
		default:
			return true
		}
	}
	return false
}

func (n *Nat) proxyPath(path string) string {
	return filepath.Join(n.cacheDir("proxy"), cacheKey(path)+".mp4")
}

var proxySem = make(chan struct{}, 1)

// proxyFor: 미리보기 요청이 오면 사본을 돌려줘요 (만드는 중이면 끝날 때까지 기다려요). 필요 없으면 "".
func (n *Nat) proxyFor(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if !videoExts[ext] && !audioExts[ext] {
		return ""
	}
	px := n.proxyPath(path)
	if fileExists(px) {
		return px
	}
	n.pmu.Lock()
	state, known := n.proxies[path]
	n.pmu.Unlock()
	if !known {
		p, err := n.ffprobe(path)
		if err != nil || !n.needsProxy(p, ext) {
			n.pmu.Lock()
			n.proxies[path] = "no"
			n.pmu.Unlock()
			return ""
		}
		go n.makeProxy(path, ext)
	} else if state == "no" || state == "fail" {
		return ""
	}
	for i := 0; i < 20*60*4; i++ {
		if fileExists(px) {
			return px
		}
		n.pmu.Lock()
		s := n.proxies[path]
		n.pmu.Unlock()
		if s == "fail" {
			return ""
		}
		time.Sleep(250 * time.Millisecond)
	}
	return ""
}

func (n *Nat) makeProxy(path, ext string) {
	defer recoverLog("proxy")
	n.pmu.Lock()
	if s, ok := n.proxies[path]; ok && s != "" {
		n.pmu.Unlock()
		return
	}
	n.proxies[path] = "making"
	n.pmu.Unlock()
	proxySem <- struct{}{}
	defer func() { <-proxySem }()
	px := n.proxyPath(path)
	if fileExists(px) {
		return
	}
	tmp := px + ".part.mp4"
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-y", "-i", path}
	if videoExts[ext] {
		args = append(args, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=-2:'min(720,ih)':flags=bilinear,format=yuv420p",
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "30", "-c:a", "aac", "-b:a", "160k")
	} else {
		args = append(args, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k")
	}
	args = append(args, "-movflags", "+faststart", tmp)
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
	defer cancel()
	out, err := n.ff(ctx, "ffmpeg", args...).CombinedOutput()
	n.pmu.Lock()
	defer n.pmu.Unlock()
	if err != nil {
		os.Remove(tmp)
		n.proxies[path] = "fail"
		log.Printf("미리보기 사본 실패 %s: %v %s", filepath.Base(path), err, lastLine(string(out)))
		return
	}
	os.Rename(tmp, px)
	n.proxies[path] = px
	log.Printf("미리보기 사본 완료 %s (%.1f초)", filepath.Base(path), time.Since(started).Seconds())
}

// stderrTail keeps the last bytes of a command's stderr for error messages.
type stderrTail struct {
	mu  sync.Mutex
	buf []byte
}

func (s *stderrTail) Write(p []byte) (int, error) {
	s.mu.Lock()
	s.buf = append(s.buf, p...)
	if len(s.buf) > 8192 {
		s.buf = s.buf[len(s.buf)-8192:]
	}
	s.mu.Unlock()
	return len(p), nil
}

func (s *stderrTail) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.TrimSpace(string(s.buf))
}

var _ io.Writer = (*stderrTail)(nil)
