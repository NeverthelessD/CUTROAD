package main

// 프로젝트 내용(spec) + 시간 계산 — app/shell/Render.swift 의 Plan 과 같은 계산 (= model.js 의 CR.timing)

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

type clipSpec struct {
	path, kind       string
	inT, outT, speed float64
	volume           float64
	fadeIn, fadeOut  float64
	blur             float64
	rotate           int
	motion           string
	motionAmt        float64
	filter           string
	w, h             float64
	transType        string
	transDur         float64
}

func (c clipSpec) dur() float64  { return (c.outT - c.inT) / c.speed }
func (c clipSpec) isImage() bool { return c.kind == "image" }

func clamp(v, a, b float64) float64 { return math.Max(a, math.Min(b, v)) }

func newClipSpec(d map[string]any) clipSpec {
	c := clipSpec{path: mStr(d, "path"), kind: mStr(d, "kind")}
	if c.kind == "" {
		c.kind = "video"
	}
	c.inT = math.Max(0, mNum(d, "in", 0))
	c.outT = math.Max(c.inT+0.05, mNum(d, "out", c.inT+1))
	c.speed = 1
	if c.kind != "image" {
		c.speed = clamp(mNum(d, "speed", 1), 0.25, 4)
	}
	c.volume = clamp(mNum(d, "volume", 1), 0, 1)
	c.fadeIn = math.Max(0, mNum(d, "fadeIn", 0))
	c.fadeOut = math.Max(0, mNum(d, "fadeOut", 0))
	c.blur = math.Max(0, mNum(d, "blur", 0))
	c.rotate = ((int(mNum(d, "rotate", 0)) % 360) + 360) % 360
	c.motion = mStr(d, "motion")
	if c.motion == "" {
		c.motion = "none"
	}
	c.motionAmt = clamp(mNum(d, "motionAmt", 1), 0, 3)
	c.filter = mStr(d, "filter")
	if c.filter == "" {
		c.filter = "none"
	}
	c.w, c.h = mNum(d, "w", 0), mNum(d, "h", 0)
	if t, ok := d["trans"].(map[string]any); ok {
		if typ := mStr(t, "type"); typ != "" {
			c.transType = typ
			c.transDur = math.Max(0, mNum(t, "dur", 0.8))
		}
	}
	return c
}

type audioSpec struct {
	path                    string
	start, inT, outT        float64
	volume, fadeIn, fadeOut float64
	keep                    bool // 영상이 끝나도 계속 (뒤는 검은 화면) — 1.4.0
}

func newAudioSpec(d map[string]any) audioSpec {
	a := audioSpec{path: mStr(d, "path"), keep: mBool(d, "keep", false)}
	a.start = math.Max(0, mNum(d, "start", 0))
	a.inT = math.Max(0, mNum(d, "in", 0))
	a.outT = math.Max(a.inT+0.05, mNum(d, "out", a.inT+1))
	a.volume = clamp(mNum(d, "volume", 1), 0, 1)
	a.fadeIn = math.Max(0, mNum(d, "fadeIn", 0))
	a.fadeOut = math.Max(0, mNum(d, "fadeOut", 0))
	return a
}

type textSpec struct {
	text       string
	start, end float64
	pos, size  string
	box        bool
}

func newTextSpec(d map[string]any) textSpec {
	t := textSpec{text: mStr(d, "text"), pos: mStr(d, "pos"), size: mStr(d, "size"), box: mBool(d, "box", true)}
	t.start = math.Max(0, mNum(d, "start", 0))
	t.end = math.Max(t.start, mNum(d, "end", t.start+2))
	if t.pos == "" {
		t.pos = "bottom"
	}
	if t.size == "" {
		t.size = "m"
	}
	return t
}

// beatFx: 박자 효과 (타임라인 시각 기준) — model.js 의 CR.beatFxAt() · Render.swift 의 BeatFx 와 같은 계산
type beatFx struct {
	pulse, flash, shake bool
	beats, flashes      []float64
	climax, pulseIn     [][]float64
}

func newBeatFx(v any) beatFx {
	d, _ := v.(map[string]any)
	if d == nil {
		return beatFx{}
	}
	pairs := func(x any) [][]float64 {
		out := [][]float64{}
		a, _ := x.([]any)
		for _, e := range a {
			if p := numSlice(e); len(p) == 2 {
				out = append(out, p)
			}
		}
		return out
	}
	b := beatFx{pulse: mBool(d, "pulse", false), flash: mBool(d, "flash", false), shake: mBool(d, "shake", false),
		beats: numSlice(d["beats"]), flashes: numSlice(d["flashes"]), climax: pairs(d["climax"]), pulseIn: pairs(d["pulseIn"])}
	sort.Float64s(b.beats)
	sort.Float64s(b.flashes)
	return b
}

func (b beatFx) any() bool {
	return (b.pulse || b.shake) && len(b.beats) > 0 || b.flash && len(b.flashes) > 0
}

func lastLE(a []float64, t float64) (float64, bool) {
	i := sort.Search(len(a), func(i int) bool { return a[i] > t }) - 1
	if i < 0 {
		return 0, false
	}
	return a[i], true
}

// at: (크기, 가로 이동, 세로 이동(아래 +), 흰색 번쩍 0~1) — 이동은 화면 너비에 대한 비율
func (b beatFx) at(t float64) (s, dx, dy, white float64) {
	s = 1
	in := func(r [][]float64) bool {
		for _, x := range r {
			if t >= x[0] && t < x[1] {
				return true
			}
		}
		return false
	}
	if bt, ok := lastLE(b.beats, t); ok {
		e := t - bt
		pulseHere := len(b.pulseIn) == 0 || in(b.pulseIn)
		if b.pulse && pulseHere && e < 0.5 {
			s = 1 + 0.035*math.Exp(-e/0.12)
		}
		if b.shake && e < 0.6 && in(b.climax) {
			a := 0.012 * math.Exp(-e/0.25)
			dx = a * math.Sin(2*math.Pi*7*t)
			dy = 0.6 * a * math.Cos(2*math.Pi*9*t)
		}
	}
	if b.flash {
		if f, ok := lastLE(b.flashes, t); ok && t-f < 0.45 {
			white = 0.45 * math.Exp(-(t-f)/0.09)
		}
	}
	return
}

// motion: 사진 한 장이 보이는 동안 p(0→1) 에 따라 크기 · 가로/세로 이동(화면 비율, 아래 +) · 기울기(시계 방향 °)
func motionAt(m string, p, k float64) (s, dx, dy, rot float64) {
	switch m {
	case "zoomIn":
		return 1 + 0.12*k*p, 0, 0, 0
	case "zoomOut":
		return 1 + 0.12*k*(1-p), 0, 0, 0
	case "panL":
		return 1 + 0.12*k, (0.05 - 0.10*p) * k, 0, 0
	case "panR":
		return 1 + 0.12*k, (-0.05 + 0.10*p) * k, 0, 0
	case "up":
		return 1 + 0.12*k, 0, (-0.04 + 0.08*p) * k, 0
	case "down":
		return 1 + 0.12*k, 0, (0.04 - 0.08*p) * k, 0
	case "tilt":
		return 1 + (0.1+0.08*p)*k, 0, 0, (-3 + 3*p) * k
	}
	return 1, 0, 0, 0
}

// audioComp: 소리 고르게 값 (compress.js CR.AUDIO_COMP) — 내보낼 때 섞인 소리에 컴프레서 → 보정 → 리미터(-1dB)
type audioComp struct{ threshold, ratio, attack, release, makeup float64 }

// filter: ffmpeg 필터 (Compress.swift Dynamics 와 같은 값: 무릎 6dB, 두 채널 같이, 봉우리 기준)
func (c *audioComp) filter() string {
	db := func(v float64) string { return ftoa(math.Pow(10, v/20)) }
	return fmt.Sprintf("acompressor=threshold=%s:ratio=%s:attack=%s:release=%s:makeup=%s:knee=2:detection=peak:link=maximum,alimiter=limit=0.891:attack=1:release=50:level=disabled",
		db(math.Max(-60, c.threshold)), ftoa(math.Min(20, c.ratio)), ftoa(c.attack*1000), ftoa(c.release*1000), db(math.Max(0, math.Min(36, c.makeup))))
}

type plan struct {
	clips              []clipSpec
	audio              []audioSpec
	texts              []textSpec
	aspect, fit        string
	bgBlur, photoFrame bool
	beatFx             beatFx
	starts, trans      []float64
	audioComp          *audioComp // 소리 고르게 (1.5.0)
	maxShort           int        // 용량 선택: 결과의 짧은 변 최대 (0 = 그대로)
	vbps, abps         int        // 용량 선택: 비트레이트 (0 = 기본)
	vEnd               float64    // 영상(클립)이 끝나는 곳
	total              float64    // 전체 길이 = 영상 끝, 또는 ‘영상 끝나도 계속’ 배경음악이 끝나는 곳 (model.js CR.spanOf)
}

func newPlan(spec map[string]any) *plan {
	p := &plan{aspect: mStr(spec, "aspect"), fit: mStr(spec, "fit"), bgBlur: mBool(spec, "bgBlur", false), photoFrame: mBool(spec, "photoFrame", false)}
	if p.aspect == "" {
		p.aspect = "16:9"
	}
	if p.fit == "" {
		p.fit = "fit"
	}
	list := func(k string) []map[string]any {
		a, _ := spec[k].([]any)
		out := []map[string]any{}
		for _, e := range a {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	for _, d := range list("clips") {
		if c := newClipSpec(d); c.path != "" {
			p.clips = append(p.clips, c)
		}
	}
	for _, d := range list("audio") {
		if a := newAudioSpec(d); a.path != "" {
			p.audio = append(p.audio, a)
		}
	}
	for _, d := range list("texts") {
		if t := newTextSpec(d); strings.TrimSpace(t.text) != "" {
			p.texts = append(p.texts, t)
		}
	}
	p.beatFx = newBeatFx(spec["beatFx"])
	if d, ok := spec["audioComp"].(map[string]any); ok {
		p.audioComp = &audioComp{threshold: mNum(d, "threshold", -24), ratio: math.Max(1, mNum(d, "ratio", 3)), attack: math.Max(0.001, mNum(d, "attack", 0.01)),
			release: math.Max(0.01, mNum(d, "release", 0.2)), makeup: mNum(d, "makeup", 6)}
	}
	if o, ok := spec["out"].(map[string]any); ok {
		p.maxShort, p.vbps, p.abps = int(mNum(o, "maxShort", 0)), int(mNum(o, "vbps", 0)), int(mNum(o, "abps", 0))
	}
	p.timing()
	return p
}

func (p *plan) timing() {
	n := len(p.clips)
	p.starts, p.trans = make([]float64, n), make([]float64, n)
	t := 0.0
	for i := 0; i < n; i++ {
		p.starts[i] = t
		if i+1 < n && p.clips[i].transType != "" {
			p.trans[i] = math.Min(p.clips[i].transDur, math.Min(p.clips[i].dur()/2, p.clips[i+1].dur()/2))
		}
		t += p.clips[i].dur() - p.trans[i]
	}
	p.vEnd = 0
	if n > 0 {
		p.vEnd = p.starts[n-1] + p.clips[n-1].dur()
	}
	p.total = p.vEnd
	for _, a := range p.audio {
		if a.keep && a.start < p.vEnd+1e-6 {
			p.total = math.Max(p.total, a.start+(a.outT-a.inT))
		}
	}
}

// audioEnd: 배경음악이 실제로 나오는 끝 (model.js CR.audioEnd)
func (p *plan) audioEnd(a audioSpec) float64 {
	lim := p.vEnd
	if a.keep {
		lim = p.total
	}
	return math.Min(lim, a.start+(a.outT-a.inT))
}

func (p *plan) end(i int) float64 { return p.starts[i] + p.clips[i].dur() }

func even(v float64) int { return int(math.Round(v/2)) * 2 }

// renderSize: 화면 비율과 프리셋에 맞는 결과 크기
func (p *plan) renderSize(preset string, shortSide int) (int, int) {
	short := 1080
	asp := p.aspect
	switch preset {
	case "4k":
		short = 2160
	case "small":
		short = 720
	case "vertical":
		short, asp = 1080, "9:16"
	case "original":
		short = max(240, min(2160, shortSide))
	case "gif":
		short = 270
		if asp == "1:1" {
			short = 360
		}
	}
	if p.maxShort > 0 && preset != "gif" {
		short = min(short, max(240, p.maxShort))
	}
	switch asp {
	case "9:16":
		return even(float64(short)), even(float64(short) * 16 / 9)
	case "1:1":
		return even(float64(short)), even(float64(short))
	}
	return even(float64(short) * 16 / 9), even(float64(short))
}
