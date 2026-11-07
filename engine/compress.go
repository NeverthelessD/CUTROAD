// CUTROAD — 용량 줄이기 (Windows: ffmpeg 로 바로 다시 만들기)
// made by. Nevertheless_D
//
// 크기 · 비트레이트는 화면(compress.js CR.sizePlan)이 계산해서 보내 줘요. 맥은 Compress.swift 가 같은 일을 해요.
// ffmpeg 는 돌려 찍은 영상을 알아서 세워 주니까(autorotate), width×height 는 보이는 방향 그대로예요.
package main

import (
	"bufio"
	"errors"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func (n *Nat) runCompress(m map[string]any, j *Job) {
	src := mStr(m, "path")
	dir := mStr(m, "dir")
	if dir == "" {
		dir = filepath.Dir(src)
	}
	if !dirWritable(dir) { // 원본 폴더에 쓸 수 없으면 동영상 폴더에
		home, _ := os.UserHomeDir()
		dir = defaultExportDir(home)
	}
	started := time.Now()
	fail := func(err error) {
		log.Printf("⚠️ 용량 줄이기 실패: %v", err)
		var re renderErr
		if j.cancelled() {
			j.fail("멈췄어요")
		} else if errors.As(err, &re) {
			j.fail(re.msg)
		} else {
			j.fail("줄이지 못했어요 (" + err.Error() + ")")
		}
	}
	if !fileExists(src) {
		fail(rerr("파일을 찾을 수 없어요: %s", filepath.Base(src)))
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(rerr("저장할 폴더를 만들지 못했어요"))
		return
	}
	dest := ""
	if rp := mStr(m, "replace"); rp != "" && strings.EqualFold(filepath.Clean(filepath.Dir(rp)), filepath.Clean(dir)) {
		dest = rp // 목표 크기를 넘어서 다시 만드는 경우: 앞에 만든 파일을 바꿔요
	} else {
		name := mStr(m, "name")
		if name == "" {
			name = strings.TrimSuffix(filepath.Base(src), filepath.Ext(src)) + " (작게)"
		}
		dest = uniquePath(dir, name, "mp4")
	}
	tmp := filepath.Join(dir, "."+randID(4)+".cutroad-part.mp4")
	defer os.Remove(tmp)
	W, H := int(mNum(m, "width", 1920)), int(mNum(m, "height", 1080))
	W, H = max(2, W/2*2), max(2, H/2*2)
	vbps, abps := max(80000, int(mNum(m, "vbps", 4e6))), max(64000, int(mNum(m, "abps", 128000)))
	log.Printf("용량 줄이기 시작: %s → %dx%d · %dkbps", filepath.Base(src), W, H, vbps/1000)

	dur := 0.0
	fps := 30
	if pr, err := n.ffprobe(src); err == nil {
		if d, e := strconv.ParseFloat(pr.Format.Duration, 64); e == nil {
			dur = d
		}
		if v := pr.video(); v != nil {
			f := parseRate(v.AvgFrameRate)
			if f <= 0 || f > 240 {
				f = parseRate(v.RFrameRate)
			}
			if f > 0 {
				fps = int(math.Round(f))
			}
		} else {
			fail(rerr("영상이 없는 파일이에요: %s", filepath.Base(src)))
			return
		}
	}
	vf := "scale=" + strconv.Itoa(W) + ":" + strconv.Itoa(H) + ":out_color_matrix=bt709:out_range=tv:flags=bicubic,format=yuv420p"
	if fps > 60 {
		vf = "fps=60," + vf
		fps = 60
	}
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
		"-vf", vf, "-c:v", "libx264", "-preset", "medium", "-b:v", strconv.Itoa(vbps), "-maxrate", strconv.Itoa(vbps * 2), "-bufsize", strconv.Itoa(vbps * 2),
		"-profile:v", "high", "-g", strconv.Itoa(max(1, fps*2)), "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
		"-c:a", "aac", "-b:a", strconv.Itoa(abps), "-ar", "48000", "-ac", "2",
		"-map_metadata", "-1", "-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4", tmp}
	cmd := n.ff(j.ctx, "ffmpeg", args...)
	tail := &stderrTail{}
	cmd.Stderr = tail
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fail(err)
		return
	}
	if err := cmd.Start(); err != nil {
		fail(rerr("영상 도구를 실행하지 못했어요: %v", err))
		return
	}
	j.set(0, "줄이는 중")
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		line := sc.Text()
		if v, ok := strings.CutPrefix(line, "out_time_us="); ok && dur > 0 {
			if us, e := strconv.ParseFloat(v, 64); e == nil {
				j.set(math.Min(0.99, us/1e6/dur), "줄이는 중")
			}
		}
	}
	if err := cmd.Wait(); err != nil {
		if j.cancelled() {
			fail(rerr("멈췄어요"))
			return
		}
		log.Printf("ffmpeg: %s", tail.String())
		fail(rerr("줄이지 못했어요 (%s)", lastLine(tail.String())))
		return
	}
	if fileExists(dest) {
		os.Remove(dest)
	}
	if err := os.Rename(tmp, dest); err != nil {
		fail(err)
		return
	}
	var size int64
	if st, e := os.Stat(dest); e == nil {
		size = st.Size()
	}
	secs := time.Since(started).Seconds()
	log.Printf("용량 줄이기 완료: %s · %dMB · %.0f초", filepath.Base(dest), size/1_000_000, secs)
	j.finish(map[string]any{"path": dest, "name": filepath.Base(dest), "size": size, "seconds": secs})
}

func dirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".cutroad-w-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}
