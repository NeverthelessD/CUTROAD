package main

// Windows 판: 음악 박자 찾기 — 맥 Photos.swift 의 Beats 와 같은 계산 (Accelerate FFT → Go FFT)
// 결과: BPM · 박자 시각 · 강박(마디 첫 박) · 박자마다 소리 크기(0~1) · 절정 구간. cache/beats 에 저장해요.

import (
	"context"
	"encoding/json"
	"math"
	"math/cmplx"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const (
	beatSR  = 22050.0
	beatN   = 1024
	beatHop = 512
)

func (n *Nat) beats(path string) map[string]any {
	cf := filepath.Join(n.cacheDir("beats"), cacheKey(path)+"-b2.json")
	if b, err := os.ReadFile(cf); err == nil {
		var j map[string]any
		if json.Unmarshal(b, &j) == nil {
			return j
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	x, err := n.readPCM(ctx, path, int(beatSR))
	if err != nil {
		return map[string]any{"error": "음악을 읽지 못했어요"}
	}
	out := computeBeats(x)
	if out["error"] == nil {
		if b, err := json.Marshal(out); err == nil {
			os.WriteFile(cf, b, 0o644)
		}
	}
	return out
}

// fftRadix2 is an in-place iterative complex FFT (len must be a power of two).
func fftRadix2(a []complex128) {
	n := len(a)
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			a[i], a[j] = a[j], a[i]
		}
	}
	for size := 2; size <= n; size <<= 1 {
		ang := -2 * math.Pi / float64(size)
		wl := complex(math.Cos(ang), math.Sin(ang))
		for i := 0; i < n; i += size {
			w := complex(1, 0)
			for k := 0; k < size/2; k++ {
				u, v := a[i+k], a[i+k+size/2]*w
				a[i+k], a[i+k+size/2] = u+v, u-v
				w *= wl
			}
		}
	}
}

func r1000(v float64) float64 { return math.Round(v*1000) / 1000 }

func computeBeats(x []float32) map[string]any {
	n, hop, sr := beatN, beatHop, beatSR
	dur := float64(len(x)) / sr
	if len(x) <= n*8 {
		return map[string]any{"error": "음악이 너무 짧거나 읽을 수 없어요", "duration": dur}
	}
	fps := sr / float64(hop)
	frames := (len(x) - n) / hop

	// 1) 스펙트럼 변화량(onset) · 소리 크기(rms)
	window := make([]float64, n)
	for i := range window {
		window[i] = 0.5 * (1 - math.Cos(2*math.Pi*float64(i)/float64(n)))
	}
	prev := make([]float64, n/2)
	onset := make([]float64, frames)
	rms := make([]float64, frames)
	buf := make([]complex128, n)
	for f := 0; f < frames; f++ {
		base := f * hop
		var ss float64
		for i := 0; i < n; i++ {
			v := float64(x[base+i])
			ss += v * v
			buf[i] = complex(v*window[i], 0)
		}
		rms[f] = math.Sqrt(ss / float64(n))
		fftRadix2(buf)
		var flux float64
		for k := 1; k < n/2; k++ {
			mag := 2 * cmplx.Abs(buf[k]) // vDSP_fft_zrip 은 2배 크기로 줘요
			v := math.Log(1 + 10*mag)
			if d := v - prev[k]; d > 0 {
				flux += d
			}
			prev[k] = v
		}
		onset[f] = flux
	}
	win := max(3, int(fps*0.25))
	o := make([]float64, frames)
	acc := 0.0
	for i := 0; i < frames; i++ {
		acc += onset[i]
		if i > 2*win {
			acc -= onset[i-2*win-1]
		}
		mean := acc / float64(min(i+1, 2*win+1))
		o[i] = math.Max(0, onset[max(0, i-win)]-mean)
	}
	o = append(o[win:], make([]float64, win)...)
	oMax := 0.0
	for _, v := range o {
		oMax = math.Max(oMax, v)
	}
	if oMax <= 0 {
		return beatFallback(dur)
	}

	// 2) 빠르기(BPM): 자기상관 + 120 BPM 근처 가중치
	minLag, maxLag := int(fps*60/200), int(fps*60/60)
	ac := make([]float64, maxLag*2+2)
	for L := minLag; L <= min(maxLag*2+1, frames-1); L++ {
		s := 0.0
		for i := 0; i+L < frames; i++ {
			s += o[i] * o[i+L]
		}
		ac[L] = s / float64(frames-L)
	}
	best, bestScore := minLag, -1.0
	for L := minLag; L <= maxLag; L++ {
		bpm := 60 * fps / float64(L)
		w := math.Exp(-0.5 * math.Pow(math.Log2(bpm/120)/0.9, 2))
		a2 := 0.0
		if 2*L < len(ac) {
			a2 = ac[2*L]
		}
		if score := (ac[L] + 0.5*a2) * w; score > bestScore {
			bestScore, best = score, L
		}
	}
	period := float64(best)
	if best > minLag && best < maxLag {
		a, b, c := ac[best-1], ac[best], ac[best+1]
		if den := a - 2*b + c; den != 0 {
			period += 0.5 * (a - c) / den
		}
	}
	for 60*fps/period < 90 {
		half := int(math.Round(period / 2))
		if half < minLag || half >= len(ac) || 60*fps/(period/2) > 150 {
			break
		}
		if ac[half] >= 0.35*ac[int(math.Round(period))] {
			period /= 2
		} else {
			break
		}
	}
	bpm := 60 * fps / period

	// 3) 박자 위치
	bestPhase, phaseScore := 0, -1.0
	for ph := 0; ph < max(1, int(period)); ph++ {
		s := 0.0
		for p := float64(ph); p < float64(frames); p += period {
			s += o[int(p)]
		}
		if s > phaseScore {
			phaseScore, bestPhase = s, ph
		}
	}
	var beatsF []float64
	expect := float64(bestPhase)
	reach := max(2, int(period*0.12))
	for expect < float64(frames)-1 {
		c := int(math.Round(expect))
		bi, bv := c, -1.0
		for k := max(0, c-reach); k <= min(frames-1, c+reach); k++ {
			d := float64(k-c) / float64(reach)
			if v := o[k] * math.Exp(-2*d*d); v > bv {
				bv, bi = v, k
			}
		}
		pos := 0.7*float64(bi) + 0.3*expect
		beatsF = append(beatsF, pos)
		expect = pos + period
	}
	toSec := func(f float64) float64 { return (f*float64(hop) + float64(n)/2) / sr }
	beats := []float64{}
	for _, f := range beatsF {
		if t := r1000(toSec(f)); t < dur {
			beats = append(beats, t)
		}
	}

	// 4) 박자마다 소리 크기 · 강박 · 절정
	energy := make([]float64, len(beats))
	for i, b := range beats {
		a := int(b * fps)
		nb := b + period/fps
		if i+1 < len(beats) {
			nb = beats[i+1]
		}
		e := int(nb * fps)
		s, cnt := 0.0, 0
		for k := max(0, a); k < min(frames, max(a+1, e)); k++ {
			s += rms[k]
			cnt++
		}
		if cnt > 0 {
			energy[i] = s / float64(cnt)
		}
	}
	sorted := append([]float64{}, energy...)
	sort.Float64s(sorted)
	top := 1.0
	if len(sorted) > 0 {
		top = math.Max(1e-6, sorted[int(float64(len(sorted)-1)*0.95)])
	}
	for i := range energy {
		energy[i] = math.Min(1, energy[i]/top)
	}
	downPhase, dpScore := 0, -1.0
	for ph := 0; ph < 4; ph++ {
		s := 0.0
		for i, b := range beats {
			if i%4 == ph {
				s += o[min(frames-1, int(b*fps))]
			}
		}
		if s > dpScore {
			dpScore, downPhase = s, ph
		}
	}
	downbeats := []float64{}
	for i, b := range beats {
		if i%4 == downPhase {
			downbeats = append(downbeats, b)
		}
	}
	smooth := make([]float64, len(energy))
	for i := range energy {
		a, b := max(0, i-4), min(len(energy)-1, i+4)
		s := 0.0
		for k := a; k <= b; k++ {
			s += energy[k]
		}
		smooth[i] = s / float64(b-a+1)
	}
	st := append([]float64{}, smooth...)
	sort.Float64s(st)
	thr := 1.0
	if len(st) > 0 {
		thr = st[int(float64(len(st)-1)*0.75)]
	}
	climax := [][]float64{}
	runStart := -1
	for i := 0; i <= len(smooth); i++ {
		hot := i < len(smooth) && smooth[i] >= thr && thr > 0.3
		if hot && runStart < 0 {
			runStart = i
		}
		if !hot && runStart >= 0 {
			if i-runStart >= 8 {
				end := dur
				if i < len(beats) {
					end = beats[i]
				}
				climax = append(climax, []float64{beats[runStart], end})
			}
			runStart = -1
		}
	}
	en := make([]float64, len(energy))
	for i, v := range energy {
		en[i] = math.Round(v*100) / 100
	}
	return map[string]any{"bpm": math.Round(bpm*10) / 10, "beats": beats, "downbeats": downbeats,
		"energy": en, "climax": climax, "duration": dur}
}

// 박자를 못 찾으면 100 BPM 으로 고르게
func beatFallback(dur float64) map[string]any {
	p := 0.6
	beats, down, en := []float64{}, []float64{}, []float64{}
	for i, t := 0, 0.0; t < dur; i, t = i+1, t+p {
		beats = append(beats, r1000(t))
		if i%4 == 0 {
			down = append(down, r1000(t))
		}
		en = append(en, 0.5)
	}
	return map[string]any{"bpm": 100, "beats": beats, "downbeats": down, "energy": en, "climax": [][]float64{}, "duration": dur, "guessed": true}
}
