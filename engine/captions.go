package main

// Windows 판 자동 자막 — whisper(받아쓰기 모델, 처음 쓸 때 받아요)로 타임라인의 '영상 소리'를 받아써요.
// 소리 만들기는 내보내기와 같은 계산(buildAudio, 배경음악 빼고) → 16kHz WAV → whisper-cli → 낱말들 → 자막 줄 (맥과 같은 규칙)

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf8"
)

type word struct {
	text       string
	start, end float64
}

var progRe = regexp.MustCompile(`progress\s*=\s*(\d+)%`)

func (n *Nat) runCaptions(spec map[string]any, j *Job) {
	lines, err := n.transcribe(spec, j)
	if err != nil {
		log.Printf("⚠️ 자동 자막 실패: %v", err)
		j.fail(err.Error())
		return
	}
	log.Printf("자동 자막 완료: %d줄", len(lines))
	j.finish(map[string]any{"lines": lines})
}

func (n *Nat) transcribe(spec map[string]any, j *Job) ([]map[string]any, error) {
	lang := map[string]string{"ko-KR": "ko", "en-US": "en", "ja-JP": "ja"}[mStr(spec, "lang")]
	if lang == "" {
		lang = "ko"
	}
	maxLen := int(mNum(spec, "maxLen", 16))
	p := newPlan(spec)
	if len(p.clips) == 0 {
		return nil, rerr("타임라인에 영상이 없어요")
	}
	// 1) 받아쓰기 도구 · 모델 (처음 한 번만 받아요)
	j.set(0, "받아쓰기 준비 중")
	err := n.tools.EnsureWhisper(j.ctx, func(msg string, done, total int64) {
		pr := 0.0
		if total > 0 {
			pr = float64(done) / float64(total)
		}
		j.set(pr*0.5, fmt.Sprintf("%s · %d / %dMB", msg, done/1_000_000, max(total, modelSize)/1_000_000))
	})
	if err != nil {
		return nil, err
	}
	base := 0.0
	if j.getProgress() > 0.01 { // 모델을 받았으면 진행 막대의 절반을 썼어요
		base = 0.5
	}
	// 2) 영상 소리만 → 16kHz 모노 WAV
	tmpDir, err := os.MkdirTemp("", "cutroad-captions-")
	if err != nil {
		return nil, rerr("임시 폴더를 만들지 못했어요")
	}
	defer os.RemoveAll(tmpDir)
	wav := filepath.Join(tmpDir, "audio.wav")
	j.set(base, "소리 준비 중")
	ok, err := n.buildAudio(j.ctx, p, false, 0, p.vEnd, wav, []string{"-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"})
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, rerr("타임라인의 영상에 소리가 없어요")
	}
	// 3) whisper-cli: 낱말마다 시각 (-ml 1 -sow), JSON 으로
	outBase := filepath.Join(tmpDir, "out")
	threads := max(1, min(8, runtime.NumCPU()))
	args := []string{"-m", n.tools.modelPath(), "-f", wav, "-l", lang, "-t", strconv.Itoa(threads), "-ml", "1", "-sow",
		"-oj", "-of", outBase, "-pp", "-sns"}
	cmd := execCtx(j.ctx, n.tools.whisperPath(), args...)
	stderr, _ := cmd.StderrPipe()
	tail := &stderrTail{}
	if err := cmd.Start(); err != nil {
		return nil, rerr("받아쓰기 도구를 실행하지 못했어요: %v", err)
	}
	j.set(base, "받아쓰는 중")
	sc := bufio.NewScanner(stderr)
	for sc.Scan() {
		line := sc.Text()
		tail.Write([]byte(line + "\n"))
		if m := progRe.FindStringSubmatch(line); m != nil {
			v, _ := strconv.Atoi(m[1])
			j.set(base+(0.98-base)*float64(v)/100, "받아쓰는 중")
		}
	}
	if err := cmd.Wait(); err != nil {
		if j.cancelled() {
			return nil, rerr("취소했어요")
		}
		log.Printf("whisper: %v %s", err, tail.String())
		return nil, rerr("받아쓰지 못했어요 (%s)", lastLine(tail.String()))
	}
	b, err := os.ReadFile(outBase + ".json")
	if err != nil {
		return nil, rerr("받아쓴 결과를 읽지 못했어요")
	}
	words := parseWhisperJSON(b)
	return groupWords(words, maxLen), nil
}

func parseWhisperJSON(b []byte) []word {
	// whisper-cli 가 가끔 깨진 UTF-8 조각을 내보내요 → 바로잡고 읽어요
	b = []byte(strings.ToValidUTF8(string(b), ""))
	var res struct {
		Transcription []struct {
			Offsets struct {
				From int64 `json:"from"`
				To   int64 `json:"to"`
			} `json:"offsets"`
			Text string `json:"text"`
		} `json:"transcription"`
	}
	if json.Unmarshal(b, &res) != nil {
		return nil
	}
	var out []word
	for _, s := range res.Transcription {
		t := strings.TrimSpace(s.Text)
		if t == "" || strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") || strings.HasPrefix(t, "(") && strings.HasSuffix(t, ")") {
			continue // [음악] · (웃음) 같은 표시는 빼요
		}
		// 앞 낱말에 붙어야 하는 조각(띄어쓰기 없이 나온 토큰)은 이어 붙여요
		if len(out) > 0 && !strings.HasPrefix(s.Text, " ") && float64(s.Offsets.From)/1000-out[len(out)-1].end < 0.05 {
			out[len(out)-1].text += t
			out[len(out)-1].end = float64(s.Offsets.To) / 1000
			continue
		}
		w := word{text: t, start: float64(s.Offsets.From) / 1000, end: float64(s.Offsets.To) / 1000}
		if w.end-w.start > 1.5 { // 말 앞의 조용한 부분까지 낱말에 붙는 일이 있어요 → 낱말은 길어야 1초쯤
			w.start = w.end - 1.0
		}
		out = append(out, w)
	}
	return out
}

// groupWords: Captions.swift 의 group 과 같은 규칙 — 0.8초 넘게 쉬거나, 한 줄 길이를 넘거나, 문장이 끝나면 새 줄
func groupWords(words []word, maxLen int) []map[string]any {
	type line struct {
		text       string
		start, end float64
	}
	var lines []line
	cur, s, e := "", 0.0, 0.0
	flush := func() {
		if t := strings.TrimSpace(cur); t != "" {
			lines = append(lines, line{t, s, e})
		}
		cur = ""
	}
	for _, w := range words {
		wd := strings.TrimSpace(w.text)
		if wd == "" {
			continue
		}
		if cur != "" && (w.start-e > 0.8 || utf8.RuneCountInString(cur+" "+wd) > maxLen) {
			flush()
		}
		if cur == "" {
			s = w.start
			cur = wd
		} else {
			cur += " " + wd
		}
		e = w.end
		if r, _ := utf8.DecodeLastRuneInString(wd); strings.ContainsRune(".?!。", r) {
			flush()
		}
	}
	flush()
	out := []map[string]any{}
	for i, l := range lines {
		end := math.Max(l.end+0.3, l.start+0.8)
		if i+1 < len(lines) {
			end = math.Min(end, lines[i+1].start-0.02)
		}
		out = append(out, map[string]any{"text": l.text, "start": math.Round(l.start*100) / 100, "end": math.Round(math.Max(end, l.start+0.3)*100) / 100})
	}
	return out
}
