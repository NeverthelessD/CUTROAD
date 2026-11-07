package main

// Windows 판 내보내기 — 맥의 Render.swift(Compositor) · Export.swift 와 같은 순서 · 같은 값으로 장면을 그려요.
//
//   영상 클립: ffmpeg 가 잘라서(-ss · -t) 속도 · 회전 · 크기를 맞춘 RGBA 장면을 차례로 보내 줘요
//   사진 클립: Go 가 한 번 읽어서 크기를 맞춰 둬요 (흰 액자 · 흐린 배경도 미리)
//   장면마다: 움직임 → 흐린 배경 → 블러 → 색감 → 필름 가장자리 → 페이드 → 넘기기 → 박자 효과 → 글자
//   소리: ffmpeg 필터(자르기 · 속도 · 볼륨 · 페이드 · 넘기기 동안 서로 바뀌기 · 배경음악)로 먼저 m4a 를 만들고
//   장면(RGBA)은 ffmpeg(libx264)로 보내서 MP4 를 만들어요. 움짤은 같은 장면을 GIF 로.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"image"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/draw"
)

type renderErr struct{ msg string }

func (e renderErr) Error() string { return e.msg }

func rerr(f string, a ...any) error { return renderErr{fmt.Sprintf(f, a...)} }

// ---------------------------------------------------------------- 클립 그림 (layer)

type layer struct {
	i          int
	c          clipSpec
	start, end float64
	cw, ch     int     // 내용(크기를 맞춘 그림) 크기
	ox, oy     float64 // 내용의 왼쪽 위 (화면 좌표)
	content    *image.RGBA
	bg         *image.RGBA // 흐린 배경 (사진, 화면을 다 못 채울 때)
	vid        *videoSource
	err        error
}

func (L *layer) progress(t float64) float64 {
	if L.end <= L.start {
		return 0
	}
	return clamp((t-L.start)/(L.end-L.start), 0, 1)
}

func (L *layer) fade(t float64) float64 {
	f := 1.0
	if L.c.fadeIn > 0 && t < L.start+L.c.fadeIn {
		f = (t - L.start) / L.c.fadeIn
	}
	if L.c.fadeOut > 0 && t > L.end-L.c.fadeOut {
		f = math.Min(f, (L.end-t)/L.c.fadeOut)
	}
	return clamp(f, 0, 1)
}

// videoSource: ffmpeg 가 보내 주는 장면들 (클립 안의 시각 j/fps 마다 한 장)
type videoSource struct {
	cmd    *exec.Cmd
	r      *bufio.Reader
	w, h   int
	next   int // 다음에 읽을 장면 번호
	cur    *image.RGBA
	spare  *image.RGBA
	curIdx int
	done   bool
	tail   *stderrTail
}

func (v *videoSource) frame(idx int) *image.RGBA {
	for !v.done && (v.cur == nil || v.curIdx < idx) {
		if v.spare == nil {
			v.spare = newRGBA(v.w, v.h)
		}
		if _, err := io.ReadFull(v.r, v.spare.Pix); err != nil {
			v.done = true // 끝: 마지막 장면을 계속 보여 줘요
			break
		}
		v.cur, v.spare = v.spare, v.cur
		v.curIdx = v.next
		v.next++
	}
	return v.cur
}

func (v *videoSource) close() {
	if v.cmd != nil && v.cmd.Process != nil {
		v.cmd.Process.Kill()
		v.cmd.Wait()
	}
}

type renderer struct {
	n        *Nat
	ctx      context.Context
	p        *plan
	W, H     int
	fps      int
	fill     bool
	layers   []*layer
	texts    []*textArt
	vignette []uint8
	white    *image.RGBA
	bufA     *image.RGBA
	bufB     *image.RGBA
	bufT     *image.RGBA
	out      *image.RGBA
	from     float64 // 이 시각부터 그려요 (움짤 구간)
}

func (r *renderer) closeAll() {
	for _, L := range r.layers {
		if L.vid != nil {
			L.vid.close()
			L.vid = nil
		}
	}
}

// geometry: Render.swift layerImage 의 맞춤 계산 (회전한 원본 크기 w×h → 내용 크기 · 위치)
func (r *renderer) geometry(L *layer, w, h float64) {
	k := 1.0
	if L.c.isImage() && r.p.photoFrame {
		k = 0.86
	}
	W, H := float64(r.W), float64(r.H)
	s := math.Min(W/w, H/h)
	if r.fill {
		s = math.Max(W/w, H/h)
	}
	s *= k
	L.cw, L.ch = max(2, int(math.Round(w*s))), max(2, int(math.Round(h*s)))
	L.ox, L.oy = math.Round((W-float64(L.cw))/2), math.Round((H-float64(L.ch))/2)
}

// prepare: 클립이 처음 필요할 때 (영상이면 ffmpeg 를 켜고, 사진이면 그림을 읽어요)
func (r *renderer) prepare(L *layer) {
	if L.content != nil || L.vid != nil || L.err != nil {
		return
	}
	if L.c.isImage() {
		r.prepareImage(L)
		return
	}
	p, err := r.n.ffprobe(L.c.path)
	if err != nil || p.video() == nil {
		L.err = rerr("영상이 없는 파일이에요: %s", filepath.Base(L.c.path))
		return
	}
	v := p.video()
	w, h := float64(v.Width), float64(v.Height)
	if rot := v.rotation(); rot == 90 || rot == 270 {
		w, h = h, w
	}
	if L.c.rotate == 90 || L.c.rotate == 270 {
		w, h = h, w
	}
	r.geometry(L, w, h)
	srcDur, _ := strconv.ParseFloat(p.Format.Duration, 64)
	if d, err := strconv.ParseFloat(v.Duration, 64); err == nil && d > 0 {
		srcDur = d
	}
	// 그리기 시작 시각 (움짤 구간이 클립 중간부터면 그 근처로 건너뛰어요)
	j0 := 0
	if r.from > L.start {
		j0 = int(math.Floor((r.from - L.start) * float64(r.fps)))
	}
	a := L.c.inT + float64(j0)/float64(r.fps)*L.c.speed
	b := L.c.outT
	if srcDur > 0 {
		b = math.Min(b, srcDur)
		a = math.Min(a, math.Max(0, srcDur-0.05))
	}
	vf := []string{fmt.Sprintf("setpts=(PTS-STARTPTS)/%g", L.c.speed), fmt.Sprintf("fps=%d", r.fps)}
	switch L.c.rotate {
	case 90:
		vf = append(vf, "transpose=1")
	case 180:
		vf = append(vf, "hflip,vflip")
	case 270:
		vf = append(vf, "transpose=2")
	}
	vf = append(vf, fmt.Sprintf("scale=%d:%d:flags=bicubic", L.cw, L.ch), "format=rgba")
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-ss", ftoa(a), "-t", ftoa(math.Max(0.05, b-a)), "-i", L.c.path,
		"-map", "0:v:0", "-an", "-sn", "-vf", strings.Join(vf, ","), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"}
	cmd := r.n.ff(r.ctx, "ffmpeg", args...)
	tail := &stderrTail{}
	cmd.Stderr = tail
	out, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		L.err = rerr("영상을 읽지 못했어요: %s", filepath.Base(L.c.path))
		return
	}
	L.vid = &videoSource{cmd: cmd, r: bufio.NewReaderSize(out, 1<<20), w: L.cw, h: L.ch, next: j0, curIdx: -1, tail: tail}
}

func (r *renderer) prepareImage(L *layer) {
	maxSide := int(float64(max(r.W, r.H)) * 1.3)
	img, err := r.n.loadImage(L.c.path, maxSide)
	if err != nil {
		L.err = rerr("사진을 읽지 못했어요: %s", filepath.Base(L.c.path))
		return
	}
	switch L.c.rotate {
	case 90:
		img = orientImage(img, 6)
	case 180:
		img = orientImage(img, 3)
	case 270:
		img = orientImage(img, 8)
	}
	b := img.Bounds()
	w, h := float64(b.Dx()), float64(b.Dy())
	r.geometry(L, w, h)
	content := newRGBA(L.cw, L.ch)
	draw.CatmullRom.Scale(content, content.Bounds(), img, b, draw.Src, nil)
	if r.p.photoFrame { // 흰 액자: 짧은 변의 1.2%
		bw := int(math.Round(0.012 * float64(min(r.W, r.H))))
		framed := newRGBA(L.cw+2*bw, L.ch+2*bw)
		fillRGBA(framed, 255, 255, 255, 255)
		drawOver(framed, content, float64(bw), float64(bw), identity, 1)
		content = framed
		L.ox -= float64(bw)
		L.oy -= float64(bw)
	}
	L.content = content
	if r.p.bgBlur && !r.fill { // 흐린 배경: 화면을 덮도록 1.1배 키워서 흐리게, 밝기 75%
		W, H := float64(r.W), float64(r.H)
		cs := math.Max(W/w, H/h) * 1.1
		bw, bh := int(math.Round(w*cs)), int(math.Round(h*cs))
		big := newRGBA(bw, bh)
		draw.BiLinear.Scale(big, big.Bounds(), img, b, draw.Src, nil)
		bg := newRGBA(r.W, r.H)
		drawOver(bg, big, math.Round((W-float64(bw))/2), math.Round((H-float64(bh))/2), identity, 1)
		blurBig(bg, 0.04*math.Min(W, H))
		scaleRGB(bg, 0.75)
		L.bg = bg
	}
}

// blurBig: 큰 흐림은 줄여서 흐린 뒤 다시 키워요 (빠르고 거의 같아요)
func blurBig(img *image.RGBA, sigma float64) {
	if sigma < 8 {
		gaussianBlur(img, sigma)
		return
	}
	f := math.Max(2, math.Floor(sigma/4))
	W, H := img.Rect.Dx(), img.Rect.Dy()
	sw, sh := max(4, int(float64(W)/f)), max(4, int(float64(H)/f))
	small := newRGBA(sw, sh)
	draw.BiLinear.Scale(small, small.Bounds(), img, img.Bounds(), draw.Src, nil)
	gaussianBlur(small, sigma*float64(sw)/float64(W))
	draw.BiLinear.Scale(img, img.Bounds(), small, small.Bounds(), draw.Src, nil)
}

// layerImage: 한 클립의 장면 (검은 바탕 위) → dst
func (r *renderer) layerImage(L *layer, t float64, dst *image.RGBA) error {
	r.prepare(L)
	if L.err != nil {
		return L.err
	}
	clearRGBA(dst)
	var content *image.RGBA
	if L.vid != nil {
		idx := int(math.Floor((t-L.start)*float64(r.fps) + 1e-6))
		content = L.vid.frame(max(0, idx))
		if content == nil {
			if r.ctx.Err() != nil {
				return rerr("취소했어요")
			}
			return rerr("영상을 읽지 못했어요: %s (%s)", filepath.Base(L.c.path), lastLine(L.vid.tail.String()))
		}
	} else {
		content = L.content
	}
	if L.bg != nil {
		copy(dst.Pix, L.bg.Pix)
	}
	s, dx, dy, rot := motionAt(L.c.motion, L.progress(t), L.c.motionAmt)
	tr := identity
	if s != 1 || dx != 0 || dy != 0 || rot != 0 {
		tr = around(r.W, r.H, s, rot, dx*float64(r.W), dy*float64(r.H))
	}
	drawOver(dst, content, L.ox, L.oy, tr, 1)
	if L.c.blur > 0.01 {
		sigma := L.c.blur * float64(min(r.W, r.H)) / 1080
		blurBig(dst, sigma)
	}
	if ops, ok := colorFilters[L.c.filter]; ok {
		applyColor(dst, ops)
	}
	if L.c.filter == "film" {
		if r.vignette == nil {
			r.vignette = vignetteMask(r.W, r.H)
		}
		applyVignette(dst, r.vignette)
	}
	scaleRGB(dst, L.fade(t))
	overBlack(dst)
	return nil
}

// frameAt: t 시각의 한 장면 (Render.swift Compositor.frame 과 같은 순서)
func (r *renderer) frameAt(t float64) (*image.RGBA, error) {
	p := r.p
	n := len(p.clips)
	// 이 시각의 클립(들): 혼자 나오는 구간 [시작+앞 넘기기, 끝-뒤 넘기기) 또는 i → i+1 넘기기 구간 [끝-넘기기, 끝)
	cur, nxt := -1, -1
	for i := 0; i < n; i++ {
		if t < p.end(i)-p.trans[i] {
			cur = i
			break
		}
		if p.trans[i] > 0 && i+1 < n && t < p.end(i) {
			cur, nxt = i, i+1
			break
		}
	}
	if cur < 0 && n > 0 && t < p.vEnd+0.5/float64(max(1, r.fps)) {
		cur = n - 1 // 끝 (반올림 오차): 마지막 장면. 그보다 뒤(음악만 계속)는 검은 화면
	}
	// 지난 클립의 ffmpeg 는 닫아요
	for k, L := range r.layers {
		if L.vid != nil && k < cur {
			L.vid.close()
			L.vid = nil
		}
	}
	out := r.out
	if cur < 0 {
		fillRGBA(out, 0, 0, 0, 255)
	} else if nxt < 0 {
		if err := r.layerImage(r.layers[cur], t, out); err != nil {
			return nil, err
		}
	} else {
		a, b := r.bufA, r.bufB
		if err := r.layerImage(r.layers[cur], t, a); err != nil {
			return nil, err
		}
		if err := r.layerImage(r.layers[nxt], t, b); err != nil {
			return nil, err
		}
		tStart, tDur := p.end(cur)-p.trans[cur], p.trans[cur]
		pr := 1.0
		if tDur > 0 {
			pr = clamp((t-tStart)/tDur, 0, 1)
		}
		r.transition(p.clips[cur].transType, pr, a, b, out)
	}
	// 박자 효과
	if p.beatFx.any() {
		s, dx, dy, white := p.beatFx.at(t)
		if s != 1 || dx != 0 || dy != 0 {
			src := r.bufT
			copy(src.Pix, out.Pix)
			fillRGBA(out, 0, 0, 0, 255)
			drawOver(out, src, 0, 0, around(r.W, r.H, s, 0, dx*float64(r.W), dy*float64(r.W)), 1)
		}
		overColor(out, 255, 255, 255, white)
	}
	for i, x := range p.texts {
		if t >= x.start && t < x.end && r.texts[i] != nil {
			ta := r.texts[i]
			drawOver(out, ta.img, float64(ta.x), float64(ta.y), identity, 1)
		}
	}
	return out, nil
}

func (r *renderer) transition(kind string, p float64, a, b, out *image.RGBA) {
	W, H := r.W, r.H
	fillRGBA(out, 0, 0, 0, 255)
	switch kind {
	case "fadeblack":
		if p < 0.5 {
			scaleRGB(a, 1-p*2)
			copy(out.Pix, a.Pix)
		} else {
			scaleRGB(b, p*2-1)
			copy(out.Pix, b.Pix)
		}
	case "flash":
		if p < 0.5 {
			copy(out.Pix, a.Pix)
			overColor(out, 255, 255, 255, p*2)
		} else {
			copy(out.Pix, b.Pix)
			overColor(out, 255, 255, 255, (1-p)*2)
		}
	case "wipe":
		copy(out.Pix, a.Pix)
		cut := int(math.Round(float64(W) * p))
		for y := 0; y < H; y++ {
			o := y * out.Stride
			copy(out.Pix[o:o+cut*4], b.Pix[o:o+cut*4])
		}
	case "slide":
		drawOver(out, a, -math.Round(float64(W)*p), 0, identity, 1)
		drawOver(out, b, math.Round(float64(W)*(1-p)), 0, identity, 1)
	case "circle":
		rad := p * math.Hypot(float64(W), float64(H)) / 2
		cx, cy := float64(W)/2, float64(H)/2
		parallelRows(H, func(y0, y1 int) {
			for y := y0; y < y1; y++ {
				for x := 0; x < W; x++ {
					d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
					m := clamp(rad+1-d, 0, 1) // 1 픽셀 부드러운 가장자리
					o := y*out.Stride + x*4
					for c := 0; c < 4; c++ {
						out.Pix[o+c] = clamp8(float64(b.Pix[o+c])*m + float64(a.Pix[o+c])*(1-m))
					}
				}
			}
		})
	case "zoom":
		drawOver(out, a, 0, 0, around(W, H, 1+0.5*p, 0, 0, 0), 1)
		drawOver(out, b, 0, 0, around(W, H, 1.3-0.3*p, 0, 0, 0), p)
	case "spin":
		copy(out.Pix, a.Pix)
		drawOver(out, b, 0, 0, around(W, H, 0.6+0.4*p, -30*(1-p), 0, 0), p)
	case "blur":
		mb := 0.03 * float64(min(W, H))
		if p > 0.001 {
			blurBig(a, mb*p)
		}
		if p < 0.999 {
			blurBig(b, mb*(1-p))
		}
		blendInto(out, a, b, p)
	case "blinds":
		copy(out.Pix, a.Pix)
		sw := float64(W) / 10
		for k := 0; k < 10; k++ {
			x0 := int(math.Round(float64(k) * sw))
			x1 := min(W, int(math.Round(float64(k)*sw+sw*p)))
			if x1 <= x0 {
				continue
			}
			for y := 0; y < H; y++ {
				o := y*out.Stride + x0*4
				copy(out.Pix[o:o+(x1-x0)*4], b.Pix[o:o+(x1-x0)*4])
			}
		}
	default: // dissolve
		blendInto(out, a, b, p)
	}
	overBlack(out)
}

// newRenderer: 결과 크기 · 장면 수 · 클립 준비
func (n *Nat) newRenderer(ctx context.Context, p *plan, preset string) (*renderer, error) {
	if len(p.clips) == 0 {
		return nil, rerr("타임라인에 영상이 없어요")
	}
	fps, shortSide := 30, 1080
	c0 := p.clips[0]
	if !fileExists(c0.path) {
		return nil, rerr("파일을 찾을 수 없어요: %s", filepath.Base(c0.path))
	}
	if c0.isImage() {
		w, h := c0.w, c0.h
		if w <= 0 {
			w = 1080
		}
		if h <= 0 {
			h = 1080
		}
		shortSide = int(math.Min(w, h))
	} else if pr, err := n.ffprobe(c0.path); err == nil && pr.video() != nil {
		v := pr.video()
		f := parseRate(v.AvgFrameRate)
		if f <= 0 || f > 240 {
			f = parseRate(v.RFrameRate)
		}
		if f > 0 {
			best := 30
			for _, c := range []int{24, 25, 30, 50, 60} {
				if math.Abs(float64(c)-f) < math.Abs(float64(best)-f) {
					best = c
				}
			}
			fps = best
		}
		shortSide = min(v.Width, v.Height)
	}
	for _, c := range p.clips {
		if !fileExists(c.path) {
			return nil, rerr("파일을 찾을 수 없어요: %s", filepath.Base(c.path))
		}
	}
	if preset == "gif" {
		fps = 12
	}
	W, H := p.renderSize(preset, shortSide)
	r := &renderer{n: n, ctx: ctx, p: p, W: W, H: H, fps: fps, fill: p.fit == "fill" || preset == "vertical"}
	for i, c := range p.clips {
		r.layers = append(r.layers, &layer{i: i, c: c, start: p.starts[i], end: p.end(i)})
	}
	r.texts = make([]*textArt, len(p.texts))
	for i, x := range p.texts {
		r.texts[i] = makeTextArt(x, W, H)
	}
	r.bufA, r.bufB, r.bufT, r.out = newRGBA(W, H), newRGBA(W, H), newRGBA(W, H), newRGBA(W, H)
	return r, nil
}

// ---------------------------------------------------------------- 소리 (ffmpeg 필터)

type audioInput struct {
	path        string
	a, b        float64 // 원본에서 쓸 구간
	tempo       float64
	at          float64 // 타임라인에 놓는 시각
	dur         float64 // 타임라인 위 길이
	vol         float64
	inR, outR   float64
}

func (n *Nat) hasAudioStream(path string) (bool, float64) {
	p, err := n.ffprobe(path)
	if err != nil || p.audio() == nil {
		return false, 0
	}
	d, _ := strconv.ParseFloat(p.audio().Duration, 64)
	if d <= 0 {
		d, _ = strconv.ParseFloat(p.Format.Duration, 64)
	}
	return true, d
}

// audioInputs: Render.swift Builder.build 의 소리 부분과 같은 계산
func (n *Nat) audioInputs(p *plan, includeBGM bool) []audioInput {
	var ins []audioInput
	for i, c := range p.clips {
		if c.isImage() || c.volume <= 0 {
			continue
		}
		ok, srcDur := n.hasAudioStream(c.path)
		if !ok {
			continue
		}
		a, b := c.inT, c.outT
		if srcDur > 0 {
			a, b = math.Min(c.inT, math.Max(0, srcDur-0.05)), math.Min(c.outT, srcDur)
		}
		if b <= a {
			continue
		}
		dur := c.dur() * (b - a) / (c.outT - c.inT)
		prevT := 0.0
		if i > 0 {
			prevT = p.trans[i-1]
		}
		ins = append(ins, audioInput{path: c.path, a: a, b: b, tempo: (b - a) / dur, at: p.starts[i], dur: dur, vol: c.volume,
			inR: math.Max(c.fadeIn, prevT), outR: math.Max(c.fadeOut, p.trans[i])})
	}
	if includeBGM {
		for _, x := range p.audio {
			if x.start >= p.vEnd-0.05 {
				continue
			}
			ok, srcDur := n.hasAudioStream(x.path)
			if !ok {
				continue
			}
			outT := math.Min(x.outT, x.inT+(p.audioEnd(x)-x.start))
			if srcDur > 0 {
				outT = math.Min(outT, srcDur)
			}
			if outT <= x.inT+0.05 {
				continue
			}
			ins = append(ins, audioInput{path: x.path, a: x.inT, b: outT, tempo: 1, at: x.start, dur: outT - x.inT, vol: x.volume, inR: x.fadeIn, outR: x.fadeOut})
		}
	}
	return ins
}

func ftoa(v float64) string { return strconv.FormatFloat(v, 'f', 4, 64) }

func atempoChain(t float64) string {
	if math.Abs(t-1) < 0.0005 {
		return ""
	}
	var parts []string
	for t < 0.5 {
		parts = append(parts, "atempo=0.5")
		t /= 0.5
	}
	for t > 2 {
		parts = append(parts, "atempo=2.0")
		t /= 2
	}
	parts = append(parts, "atempo="+strconv.FormatFloat(t, 'f', 5, 64))
	return strings.Join(parts, ",") + ","
}

// buildAudio writes the timeline sound to out (from..to). false = 소리 없음.
func (n *Nat) buildAudio(ctx context.Context, p *plan, includeBGM bool, from, to float64, out string, codec []string) (bool, error) {
	ins := n.audioInputs(p, includeBGM)
	var args []string
	var fc []string
	var labels []string
	k := 0
	for _, x := range ins {
		if x.at+x.dur <= from || x.at >= to {
			continue
		}
		args = append(args, "-ss", ftoa(x.a), "-t", ftoa(x.b-x.a+0.05), "-i", x.path)
		d := x.dur
		ia, ib := math.Max(0, x.inR), math.Max(0, x.outR)
		if ia+ib > d {
			kk := d / (ia + ib)
			ia, ib = ia*kk, ib*kk
		}
		env := ftoa(x.vol)
		if ia > 0.001 {
			env = fmt.Sprintf("if(lt(t,%s),%s*t/%s,%s)", ftoa(ia), ftoa(x.vol), ftoa(ia), env)
		}
		if ib > 0.001 {
			env = fmt.Sprintf("if(gt(t,%s),%s*max(0,(%s-t))/%s,%s)", ftoa(d-ib), ftoa(x.vol), ftoa(d), ftoa(ib), env)
		}
		delay := int(math.Round((x.at - from) * 1000))
		trimStart := 0.0
		if delay < 0 { // 구간(from)보다 앞에서 시작하는 소리는 앞부분을 잘라요
			trimStart = -float64(delay) / 1000
			delay = 0
		}
		chain := fmt.Sprintf("[%d:a:0]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,%satrim=0:%s,asetpts=PTS-STARTPTS,volume='%s':eval=frame",
			k, atempoChain(x.tempo), ftoa(d), env)
		if trimStart > 0 {
			chain += fmt.Sprintf(",atrim=start=%s,asetpts=PTS-STARTPTS", ftoa(trimStart))
		}
		if delay > 0 {
			chain += fmt.Sprintf(",adelay=%d:all=1", delay)
		}
		lab := fmt.Sprintf("a%d", k)
		fc = append(fc, chain+"["+lab+"]")
		labels = append(labels, "["+lab+"]")
		k++
	}
	if k == 0 {
		return false, nil
	}
	total := to - from
	mix := strings.Join(labels, "")
	if k > 1 {
		mix += fmt.Sprintf("amix=inputs=%d:normalize=0:dropout_transition=0:duration=longest,", k)
	} else {
		mix += "anull,"
	}
	fc = append(fc, mix+fmt.Sprintf("apad=whole_dur=%s,atrim=0:%s[aout]", ftoa(total), ftoa(total)))
	graph := strings.Join(fc, ";")
	full := append([]string{"-hide_banner", "-nostdin", "-v", "error", "-y"}, args...)
	scriptFile := ""
	if len(graph) > 12000 { // Windows 명령 줄 길이 제한을 피해요
		scriptFile = out + ".filter.txt"
		os.WriteFile(scriptFile, []byte(graph), 0o644)
		defer os.Remove(scriptFile)
		full = append(full, n.filterScriptFlag(), scriptFile)
	} else {
		full = append(full, "-filter_complex", graph)
	}
	full = append(full, "-map", "[aout]")
	full = append(full, codec...)
	full = append(full, out)
	cmd := n.ff(ctx, "ffmpeg", full...)
	tail := &stderrTail{}
	cmd.Stderr = tail
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return false, rerr("취소했어요")
		}
		log.Printf("소리 만들기 실패: %v %s", err, tail.String())
		return false, rerr("소리를 만들지 못했어요 (%s)", lastLine(tail.String()))
	}
	return true, nil
}

var (
	ffVerOnce sync.Once
	ffMajor   int
)

// filterScriptFlag: ffmpeg 7 부터는 -/filter_complex 파일, 그 전은 -filter_complex_script
func (n *Nat) filterScriptFlag() string {
	ffVerOnce.Do(func() {
		out, _ := n.ff(context.Background(), "ffmpeg", "-hide_banner", "-version").Output()
		s := string(out)
		if i := strings.Index(s, "version "); i >= 0 {
			v := strings.TrimLeft(s[i+8:], "n")
			fmt.Sscanf(v, "%d", &ffMajor)
		}
		if ffMajor == 0 {
			ffMajor = 8
		}
	})
	if ffMajor >= 7 {
		return "-/filter_complex"
	}
	return "-filter_complex_script"
}

// ---------------------------------------------------------------- 내보내기

func uniquePath(dir, name, ext string) string {
	base := strings.TrimSpace(strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "", "\"", "", "<", "", ">", "", "|", "-").Replace(name))
	if strings.HasSuffix(strings.ToLower(base), "."+ext) {
		base = base[:len(base)-len(ext)-1]
	}
	base = strings.TrimRight(base, ". ")
	if base == "" || strings.HasPrefix(base, ".") {
		base = "CUTROAD" + base
	}
	p := filepath.Join(dir, base+"."+ext)
	for k := 2; fileExists(p); k++ {
		p = filepath.Join(dir, fmt.Sprintf("%s (%d).%s", base, k, ext))
	}
	return p
}

func (n *Nat) runExport(spec map[string]any, j *Job) {
	out, _ := spec["out"].(map[string]any)
	if out == nil {
		out = map[string]any{}
	}
	preset := mStr(out, "preset")
	if preset == "" {
		preset = "hd"
	}
	home, _ := os.UserHomeDir()
	dir := mStr(out, "dir")
	if dir == "" {
		dir = defaultExportDir(home)
	}
	ext := "mp4"
	if preset == "gif" {
		ext = "gif"
	}
	started := time.Now()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		j.fail("저장할 폴더를 만들지 못했어요")
		return
	}
	name := mStr(out, "name")
	if name == "" {
		name = "CUTROAD"
	}
	dest := uniquePath(dir, name, ext)
	tmp := filepath.Join(dir, "."+randID(4)+".cutroad-part."+ext)
	defer os.Remove(tmp)
	log.Printf("내보내기 시작: %s → %s", preset, filepath.Base(dest))
	p := newPlan(spec)
	note := ""
	var err error
	switch preset {
	case "gif":
		err = n.writeGIF(j, p, out, tmp)
	case "quick":
		note, err = n.writeQuick(j, p, tmp)
	default:
		err = n.writeMP4(j, p, preset, tmp)
	}
	if err == nil && j.cancelled() {
		err = rerr("취소했어요")
	}
	if err == nil {
		err = os.Rename(tmp, dest)
	}
	if err != nil {
		log.Printf("⚠️ 내보내기 실패: %v", err)
		var re renderErr
		if errors.As(err, &re) {
			j.fail(re.msg)
		} else {
			j.fail("영상을 만들지 못했어요 (" + err.Error() + ")")
		}
		return
	}
	var size int64
	if st, e := os.Stat(dest); e == nil {
		size = st.Size()
	}
	secs := time.Since(started).Seconds()
	log.Printf("내보내기 완료: %s · %dMB · %.0f초 %s", filepath.Base(dest), size/1_000_000, secs, note)
	j.finish(map[string]any{"path": dest, "name": filepath.Base(dest), "size": size, "seconds": secs, "note": note})
}

// renderTo: from..to 의 장면들을 ffmpeg 인코더(stdin)로 보내요
func (n *Nat) renderTo(j *Job, r *renderer, from, to float64, encArgs []string, msg string) error {
	defer r.closeAll()
	r.from = from
	count := int(math.Ceil((to-from)*float64(r.fps) - 1e-6))
	if count < 1 {
		count = 1
	}
	args := append([]string{"-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba",
		"-s", fmt.Sprintf("%dx%d", r.W, r.H), "-framerate", strconv.Itoa(r.fps), "-i", "pipe:0"}, encArgs...)
	cmd := n.ff(j.ctx, "ffmpeg", args...)
	tail := &stderrTail{}
	cmd.Stderr = tail
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return rerr("영상 도구를 실행하지 못했어요: %v", err)
	}
	// 그리기와 보내기를 겹쳐서 (장면 두 장 미리)
	frames := make(chan []byte, 2)
	writeErr := make(chan error, 1)
	go func() {
		var e error
		for b := range frames {
			if e == nil {
				_, e = stdin.Write(b)
			}
		}
		stdin.Close()
		writeErr <- e
	}()
	var drawErr error
	pool := [][]byte{make([]byte, r.W*r.H*4), make([]byte, r.W*r.H*4), make([]byte, r.W*r.H*4), make([]byte, r.W*r.H*4)}
	for k := 0; k < count; k++ {
		if j.cancelled() {
			drawErr = rerr("취소했어요")
			break
		}
		t := from + float64(k)/float64(r.fps)
		img, err := r.frameAt(t)
		if err != nil {
			drawErr = err
			break
		}
		buf := pool[k%len(pool)]
		copy(buf, img.Pix)
		frames <- buf
		if k%3 == 0 {
			j.set(float64(k+1)/float64(count)*0.99, msg)
		}
	}
	close(frames)
	we := <-writeErr
	if drawErr != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return drawErr
	}
	if err := cmd.Wait(); err != nil {
		if j.cancelled() {
			return rerr("취소했어요")
		}
		log.Printf("인코더: %v %s", err, tail.String())
		return rerr("영상을 저장하지 못했어요 (%s)", lastLine(tail.String()))
	}
	if we != nil {
		return rerr("영상을 저장하지 못했어요 (%v)", we)
	}
	return nil
}

func (n *Nat) writeMP4(j *Job, p *plan, preset, tmp string) error {
	r, err := n.newRenderer(j.ctx, p, preset)
	if err != nil {
		return err
	}
	total := p.total
	j.set(0, "소리 준비 중")
	audio := tmp + ".audio.m4a"
	defer os.Remove(audio)
	hasAudio, err := n.buildAudio(j.ctx, p, true, 0, total, audio, []string{"-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"})
	if err != nil {
		return err
	}
	bitrate := int(math.Min(60_000_000, math.Max(2_000_000, float64(r.W*r.H*r.fps)*0.2)))
	enc := []string{}
	if hasAudio {
		enc = append(enc, "-i", audio)
	}
	enc = append(enc, "-map", "0:v")
	if hasAudio {
		enc = append(enc, "-map", "1:a", "-c:a", "copy")
	}
	enc = append(enc, "-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic,format=yuv420p",
		"-c:v", "libx264", "-preset", "fast", "-b:v", strconv.Itoa(bitrate), "-maxrate", strconv.Itoa(bitrate*3/2), "-bufsize", strconv.Itoa(bitrate*2),
		"-profile:v", "high", "-g", strconv.Itoa(r.fps*2), "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
		"-t", ftoa(total), "-movflags", "+faststart", "-f", "mp4", tmp)
	return n.renderTo(j, r, 0, total, enc, "영상 만드는 중")
}

func (n *Nat) writeGIF(j *Job, p *plan, out map[string]any, tmp string) error {
	r, err := n.newRenderer(j.ctx, p, "gif")
	if err != nil {
		return err
	}
	a, b := 0.0, math.Min(p.vEnd, 10) // GIF 는 소리가 없어서 영상 부분만 (Export.swift 와 같음)
	if rg := numSlice(out["range"]); len(rg) == 2 && rg[1] > rg[0] {
		a, b = math.Max(0, rg[0]), math.Min(p.vEnd, rg[1])
	}
	b = math.Min(b, a+30)
	if b-a <= 0.1 {
		return rerr("움짤로 만들 구간이 너무 짧아요")
	}
	enc := []string{"-filter_complex", "[0:v]split[x][y];[x]palettegen=stats_mode=diff[pal];[y][pal]paletteuse=dither=bayer:bayer_scale=4",
		"-loop", "0", "-f", "gif", tmp}
	return n.renderTo(j, r, a, b, enc, "움짤 만드는 중")
}

// ---------------------------------------------------------------- 컷 편집만 (원래 화질 그대로)

func (n *Nat) writeQuick(j *Job, p *plan, tmp string) (string, error) {
	if ok := n.tryCopy(j, p, tmp); ok {
		return "원본 그대로", nil
	}
	if j.cancelled() {
		return "", rerr("취소했어요")
	}
	// 원본을 그대로 이어 붙일 수 없으면 원래 크기로 다시 만들어요 (맥과 같아요)
	q := *p
	fw, fh := 1920.0, 1080.0
	if len(p.clips) > 0 {
		c := p.clips[0]
		if c.isImage() && c.w > 0 && c.h > 0 {
			fw, fh = c.w, c.h
		} else if pr, err := n.ffprobe(c.path); err == nil && pr.video() != nil {
			v := pr.video()
			fw, fh = float64(v.Width), float64(v.Height)
			if rot := v.rotation(); rot == 90 || rot == 270 {
				fw, fh = fh, fw
			}
		}
	}
	ratio := fw / fh
	q.aspect = "16:9"
	if ratio < 0.8 {
		q.aspect = "9:16"
	} else if ratio <= 1.2 {
		q.aspect = "1:1"
	}
	q.fit = "fit"
	j.set(0, "MP4로 다시 만드는 중")
	return "다시 인코딩", n.writeMP4(j, &q, "original", tmp)
}

// tryCopy: 모든 컷이 키프레임에서 시작하고 같은 형식이면 다시 인코딩하지 않고 이어 붙여요
func (n *Nat) tryCopy(j *Job, p *plan, tmp string) bool {
	if len(p.clips) == 0 {
		return false
	}
	type sig struct {
		v, a      string
		w, h, rot int
	}
	var first *sig
	audioCodec := ""
	for _, c := range p.clips {
		if c.isImage() {
			return false
		}
		pr, err := n.ffprobe(c.path)
		if err != nil || pr.video() == nil {
			return false
		}
		v := pr.video()
		s := sig{v: v.CodecName, w: v.Width, h: v.Height, rot: v.rotation()}
		if a := pr.audio(); a != nil {
			s.a = a.CodecName
		}
		if first == nil {
			first = &s
			audioCodec = s.a
		} else if *first != s {
			return false
		}
		if c.inT > 0.02 && !n.isKeyframe(j.ctx, c.path, c.inT) {
			return false
		}
	}
	list := tmp + ".list.txt"
	defer os.Remove(list)
	var sb strings.Builder
	for _, c := range p.clips {
		sb.WriteString("file '" + strings.ReplaceAll(filepath.ToSlash(c.path), "'", `'\''`) + "'\n")
		if c.inT > 0.02 {
			sb.WriteString("inpoint " + ftoa(c.inT) + "\n")
		}
		sb.WriteString("outpoint " + ftoa(c.outT) + "\n")
	}
	os.WriteFile(list, []byte(sb.String()), 0o644)
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy"}
	if audioCodec == "aac" || audioCodec == "mp3" || audioCodec == "" {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "aac", "-b:a", "256k")
	}
	args = append(args, "-movflags", "+faststart", "-f", "mp4", tmp)
	j.set(0.1, "원래 화질 그대로 저장하는 중")
	cmd := n.ff(j.ctx, "ffmpeg", args...)
	tail := &stderrTail{}
	cmd.Stderr = tail
	if err := cmd.Run(); err != nil {
		log.Printf("원본 그대로 저장이 안 돼서 다시 만들어요: %v %s", err, lastLine(tail.String()))
		os.Remove(tmp)
		return false
	}
	// 길이가 맞는지 확인 (안 맞으면 다시 만들어요)
	want := 0.0
	for _, c := range p.clips {
		want += c.outT - c.inT
	}
	if pr, err := n.ffprobe(tmp); err == nil {
		got, _ := strconv.ParseFloat(pr.Format.Duration, 64)
		if math.Abs(got-want) > math.Max(0.4, want*0.02) {
			log.Printf("원본 그대로 저장한 길이가 달라요 (%.2f / %.2f) → 다시 만들어요", got, want)
			os.Remove(tmp)
			return false
		}
	}
	return true
}

func (n *Nat) isKeyframe(ctx context.Context, path string, t float64) bool {
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	from := math.Max(0, t-3)
	out, err := n.ff(c, "ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time",
		"-of", "csv=p=0", "-read_intervals", fmt.Sprintf("%s%%%s", ftoa(from), ftoa(t+0.5)), path).Output()
	if err != nil {
		return false
	}
	for _, l := range strings.Fields(string(out)) {
		if v, err := strconv.ParseFloat(strings.Trim(l, ","), 64); err == nil && math.Abs(v-t) < 0.02 {
			return true
		}
	}
	return false
}
