package main

// 장면 그리기에 쓰는 그림 연산 (Core Image 대신). 그림은 모두 image.RGBA(= 알파를 곱해 둔 RGBA)예요.
// 화면 줄을 나눠서 여러 코어로 동시에 계산해요.

import (
	"image"
	"math"
	"runtime"
	"sync"
)

var nWorkers = max(1, min(16, runtime.NumCPU()))

// parallelRows calls fn(y0, y1) on row bands in parallel.
func parallelRows(h int, fn func(y0, y1 int)) {
	if h <= 0 {
		return
	}
	n := min(nWorkers, h)
	if n <= 1 || h < 64 {
		fn(0, h)
		return
	}
	var wg sync.WaitGroup
	step := (h + n - 1) / n
	for y := 0; y < h; y += step {
		y0, y1 := y, min(h, y+step)
		wg.Add(1)
		go func() { defer wg.Done(); fn(y0, y1) }()
	}
	wg.Wait()
}

func newRGBA(w, h int) *image.RGBA { return image.NewRGBA(image.Rect(0, 0, w, h)) }

func fillRGBA(img *image.RGBA, r, g, b, a uint8) {
	p := img.Pix
	if len(p) < 4 {
		return
	}
	p[0], p[1], p[2], p[3] = r, g, b, a
	for k := 4; k < len(p); k *= 2 {
		copy(p[k:], p[:k])
	}
}

func clearRGBA(img *image.RGBA) {
	for i := range img.Pix {
		img.Pix[i] = 0
	}
}

func cloneRGBA(img *image.RGBA) *image.RGBA {
	c := &image.RGBA{Pix: make([]uint8, len(img.Pix)), Stride: img.Stride, Rect: img.Rect}
	copy(c.Pix, img.Pix)
	return c
}

// affine: 화면 좌표(아래로 +y)의 변환 x' = a*x + b*y + c, y' = d*x + e*y + f
type affine struct{ a, b, c, d, e, f float64 }

var identity = affine{1, 0, 0, 0, 1, 0}

func (m affine) isIdentity() bool { return m == identity }

// around: 화면 가운데를 기준으로 크기 s · 시계 방향 rotDeg · 이동(dx, dy 픽셀) — CSS: translate(dx,dy) rotate(rot) scale(s)
func around(W, H int, s, rotDeg, dx, dy float64) affine {
	cx, cy := float64(W)/2, float64(H)/2
	r := rotDeg * math.Pi / 180
	cs, sn := math.Cos(r)*s, math.Sin(r)*s
	// x' = C + T + R*S*(x - C)
	return affine{cs, -sn, cx + dx - cs*cx + sn*cy, sn, cs, cy + dy - sn*cx - cs*cy}
}

func (m affine) invert() affine {
	det := m.a*m.e - m.b*m.d
	if det == 0 {
		return identity
	}
	ia, ib, id, ie := m.e/det, -m.b/det, -m.d/det, m.a/det
	return affine{ia, ib, -(ia*m.c + ib*m.f), id, ie, -(id*m.c + ie*m.f)}
}

func (m affine) apply(x, y float64) (float64, float64) {
	return m.a*x + m.b*y + m.c, m.d*x + m.e*y + m.f
}

// drawOver: src 를 (ox, oy) 에 놓고 tr 로 옮긴 그림을 dst 위에 덮어요 (opacity 0~1). 가장자리는 부드럽게.
func drawOver(dst, src *image.RGBA, ox, oy float64, tr affine, opacity float64) {
	if opacity <= 0.001 || src == nil {
		return
	}
	sw, sh := src.Rect.Dx(), src.Rect.Dy()
	W, H := dst.Rect.Dx(), dst.Rect.Dy()
	// 빠른 길: 옮기지 않고 정수 위치면 줄 단위로 복사/덮기
	if tr.isIdentity() && ox == math.Trunc(ox) && oy == math.Trunc(oy) {
		x0, y0 := int(ox), int(oy)
		cx0, cy0 := max(0, x0), max(0, y0)
		cx1, cy1 := min(W, x0+sw), min(H, y0+sh)
		if cx1 <= cx0 || cy1 <= cy0 {
			return
		}
		op := uint32(math.Round(opacity * 255))
		parallelRows(cy1-cy0, func(r0, r1 int) {
			for y := cy0 + r0; y < cy0+r1; y++ {
				so := (y-y0)*src.Stride + (cx0-x0)*4
				do := y*dst.Stride + cx0*4
				n := (cx1 - cx0) * 4
				s, d := src.Pix[so:so+n], dst.Pix[do:do+n]
				for i := 0; i < n; i += 4 {
					sa := uint32(s[i+3])
					if op == 255 {
						if sa == 255 {
							d[i], d[i+1], d[i+2], d[i+3] = s[i], s[i+1], s[i+2], 255
							continue
						}
						if sa == 0 {
							continue
						}
						k := 255 - sa
						d[i] = uint8(uint32(s[i]) + (uint32(d[i])*k+127)/255)
						d[i+1] = uint8(uint32(s[i+1]) + (uint32(d[i+1])*k+127)/255)
						d[i+2] = uint8(uint32(s[i+2]) + (uint32(d[i+2])*k+127)/255)
						d[i+3] = uint8(sa + (uint32(d[i+3])*k+127)/255)
						continue
					}
					sa = sa * op / 255
					k := 255 - sa
					d[i] = uint8((uint32(s[i])*op + uint32(d[i])*k + 127) / 255)
					d[i+1] = uint8((uint32(s[i+1])*op + uint32(d[i+1])*k + 127) / 255)
					d[i+2] = uint8((uint32(s[i+2])*op + uint32(d[i+2])*k + 127) / 255)
					d[i+3] = uint8(sa + (uint32(d[i+3])*k+127)/255)
				}
			}
		})
		return
	}
	// 일반: 화면 픽셀마다 거꾸로 계산해서 src 를 두 겹 보간으로 읽어요
	inv := tr.invert()
	// 그릴 범위 (src 네 모서리를 옮긴 상자)
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, c := range [][2]float64{{ox, oy}, {ox + float64(sw), oy}, {ox, oy + float64(sh)}, {ox + float64(sw), oy + float64(sh)}} {
		x, y := tr.apply(c[0], c[1])
		minX, minY, maxX, maxY = math.Min(minX, x), math.Min(minY, y), math.Max(maxX, x), math.Max(maxY, y)
	}
	bx0, by0 := max(0, int(math.Floor(minX))-1), max(0, int(math.Floor(minY))-1)
	bx1, by1 := min(W, int(math.Ceil(maxX))+1), min(H, int(math.Ceil(maxY))+1)
	if bx1 <= bx0 || by1 <= by0 {
		return
	}
	sp := src.Pix
	stride := src.Stride
	parallelRows(by1-by0, func(r0, r1 int) {
		for y := by0 + r0; y < by0+r1; y++ {
			fy := float64(y) + 0.5
			for x := bx0; x < bx1; x++ {
				fx := float64(x) + 0.5
				sx := inv.a*fx + inv.b*fy + inv.c - ox - 0.5
				sy := inv.d*fx + inv.e*fy + inv.f - oy - 0.5
				if sx < -1 || sy < -1 || sx > float64(sw) || sy > float64(sh) {
					continue
				}
				x0 := int(math.Floor(sx))
				y0 := int(math.Floor(sy))
				tx, ty := sx-float64(x0), sy-float64(y0)
				var acc [4]float64
				for k := 0; k < 4; k++ {
					xx, yy := x0+(k&1), y0+(k>>1)
					if xx < 0 || yy < 0 || xx >= sw || yy >= sh {
						continue
					}
					w := (1 - tx) * (1 - ty)
					switch k {
					case 1:
						w = tx * (1 - ty)
					case 2:
						w = (1 - tx) * ty
					case 3:
						w = tx * ty
					}
					o := yy*stride + xx*4
					acc[0] += w * float64(sp[o])
					acc[1] += w * float64(sp[o+1])
					acc[2] += w * float64(sp[o+2])
					acc[3] += w * float64(sp[o+3])
				}
				sa := acc[3] * opacity
				if sa <= 0.01 {
					continue
				}
				d := y*dst.Stride + x*4
				k := 1 - sa/255
				dp := dst.Pix
				dp[d] = clamp8(acc[0]*opacity + float64(dp[d])*k)
				dp[d+1] = clamp8(acc[1]*opacity + float64(dp[d+1])*k)
				dp[d+2] = clamp8(acc[2]*opacity + float64(dp[d+2])*k)
				dp[d+3] = clamp8(sa + float64(dp[d+3])*k)
			}
		}
	})
}

func clamp8(v float64) uint8 {
	if v <= 0 {
		return 0
	}
	if v >= 255 {
		return 255
	}
	return uint8(v + 0.5)
}

// overColor: 단색(흰색 번쩍 등)을 alpha 만큼 덮어요
func overColor(img *image.RGBA, r, g, b uint8, alpha float64) {
	if alpha <= 0.001 {
		return
	}
	a := clamp(alpha, 0, 1)
	k := 1 - a
	cr, cg, cb := float64(r)*a, float64(g)*a, float64(b)*a
	parallelRows(img.Rect.Dy(), func(y0, y1 int) {
		p := img.Pix[y0*img.Stride : y1*img.Stride]
		for i := 0; i+3 < len(p); i += 4 {
			p[i] = clamp8(cr + float64(p[i])*k)
			p[i+1] = clamp8(cg + float64(p[i+1])*k)
			p[i+2] = clamp8(cb + float64(p[i+2])*k)
			p[i+3] = clamp8(255*a + float64(p[i+3])*k)
		}
	})
}

// scaleRGB: 밝기 (페이드 · 검은 화면 넘기기) — RGB 만 곱해요 (Core Image 의 CIColorMatrix 처럼)
func scaleRGB(img *image.RGBA, f float64) {
	if f >= 0.999 {
		return
	}
	k := uint32(clamp(f, 0, 1)*256 + 0.5)
	parallelRows(img.Rect.Dy(), func(y0, y1 int) {
		p := img.Pix[y0*img.Stride : y1*img.Stride]
		for i := 0; i+3 < len(p); i += 4 {
			p[i] = uint8(uint32(p[i]) * k >> 8)
			p[i+1] = uint8(uint32(p[i+1]) * k >> 8)
			p[i+2] = uint8(uint32(p[i+2]) * k >> 8)
		}
	})
}

// overBlack: 투명한 곳을 검게 (= 검은 바탕 위에 놓기)
func overBlack(img *image.RGBA) {
	parallelRows(img.Rect.Dy(), func(y0, y1 int) {
		p := img.Pix[y0*img.Stride : y1*img.Stride]
		for i := 3; i < len(p); i += 4 {
			p[i] = 255
		}
	})
}

// ---------------------------------------------------------------- 흐리게 (가우시안 ≈ 상자 흐림 세 번, 가장자리는 늘려서)

func boxSizes(sigma float64, n int) []int {
	wIdeal := math.Sqrt(12*sigma*sigma/float64(n) + 1)
	wl := int(math.Floor(wIdeal))
	if wl%2 == 0 {
		wl--
	}
	wu := wl + 2
	mIdeal := (12*sigma*sigma - float64(n*wl*wl) - 4*float64(n*wl) - 3*float64(n)) / (-4*float64(wl) - 4)
	m := int(math.Round(mIdeal))
	out := make([]int, n)
	for i := range out {
		if i < m {
			out[i] = wl
		} else {
			out[i] = wu
		}
	}
	return out
}

func gaussianBlur(img *image.RGBA, sigma float64) {
	if sigma < 0.3 {
		return
	}
	W, H := img.Rect.Dx(), img.Rect.Dy()
	tmp := make([]uint8, len(img.Pix))
	for _, bs := range boxSizes(sigma, 3) {
		r := (bs - 1) / 2
		if r < 1 {
			continue
		}
		boxH(img.Pix, tmp, W, H, img.Stride, r)
		boxV(tmp, img.Pix, W, H, img.Stride, r)
	}
}

func boxH(src, dst []uint8, W, H, stride, r int) {
	parallelRows(H, func(y0, y1 int) {
		div := float64(2*r + 1)
		for y := y0; y < y1; y++ {
			row := y * stride
			for c := 0; c < 4; c++ {
				at := func(x int) float64 {
					if x < 0 {
						x = 0
					} else if x >= W {
						x = W - 1
					}
					return float64(src[row+x*4+c])
				}
				acc := 0.0
				for x := -r; x <= r; x++ {
					acc += at(x)
				}
				for x := 0; x < W; x++ {
					dst[row+x*4+c] = uint8(acc/div + 0.5)
					acc += at(x+r+1) - at(x-r)
				}
			}
		}
	})
}

func boxV(src, dst []uint8, W, H, stride, r int) {
	n := min(nWorkers, W)
	var wg sync.WaitGroup
	step := (W + n - 1) / n
	for x0 := 0; x0 < W; x0 += step {
		xa, xb := x0, min(W, x0+step)
		wg.Add(1)
		go func() {
			defer wg.Done()
			div := float64(2*r + 1)
			for x := xa; x < xb; x++ {
				for c := 0; c < 4; c++ {
					col := x*4 + c
					at := func(y int) float64 {
						if y < 0 {
							y = 0
						} else if y >= H {
							y = H - 1
						}
						return float64(src[y*stride+col])
					}
					acc := 0.0
					for y := -r; y <= r; y++ {
						acc += at(y)
					}
					for y := 0; y < H; y++ {
						dst[y*stride+col] = uint8(acc/div + 0.5)
						acc += at(y+r+1) - at(y-r)
					}
				}
			}
		}()
	}
	wg.Wait()
}

// ---------------------------------------------------------------- 색감 (CSS filter 와 같은 행렬, 단계마다 0~1 로 자르기)

type colorOp struct {
	name string
	a    float64
}

var colorFilters = map[string][]colorOp{
	"warm":    {{"sepia", 0.25}, {"saturate", 1.3}, {"hue", -8}},
	"cool":    {{"saturate", 1.1}, {"hue", 18}, {"brightness", 1.05}},
	"vivid":   {{"saturate", 1.7}, {"contrast", 1.15}},
	"mono":    {{"grayscale", 1}, {"contrast", 1.2}},
	"vintage": {{"sepia", 0.75}, {"contrast", 0.9}, {"brightness", 1.05}},
	"film":    {{"contrast", 1.15}, {"saturate", 0.75}, {"sepia", 0.2}},
	"faded":   {{"contrast", 0.8}, {"brightness", 1.12}, {"saturate", 0.65}},
}

func colorMatrix(name string, a float64) (m [9]float64, b [3]float64) {
	m = [9]float64{1, 0, 0, 0, 1, 0, 0, 0, 1}
	switch name {
	case "grayscale":
		s := 1 - math.Min(1, a)
		m = [9]float64{0.2126 + 0.7874*s, 0.7152 - 0.7152*s, 0.0722 - 0.0722*s,
			0.2126 - 0.2126*s, 0.7152 + 0.2848*s, 0.0722 - 0.0722*s,
			0.2126 - 0.2126*s, 0.7152 - 0.7152*s, 0.0722 + 0.9278*s}
	case "sepia":
		s := 1 - math.Min(1, a)
		m = [9]float64{0.393 + 0.607*s, 0.769 - 0.769*s, 0.189 - 0.189*s,
			0.349 - 0.349*s, 0.686 + 0.314*s, 0.168 - 0.168*s,
			0.272 - 0.272*s, 0.534 - 0.534*s, 0.131 + 0.869*s}
	case "saturate":
		s := a
		m = [9]float64{0.213 + 0.787*s, 0.715 - 0.715*s, 0.072 - 0.072*s,
			0.213 - 0.213*s, 0.715 + 0.285*s, 0.072 - 0.072*s,
			0.213 - 0.213*s, 0.715 - 0.715*s, 0.072 + 0.928*s}
	case "hue":
		r := a * math.Pi / 180
		c, s := math.Cos(r), math.Sin(r)
		m = [9]float64{0.213 + c*0.787 - s*0.213, 0.715 - c*0.715 - s*0.715, 0.072 - c*0.072 + s*0.928,
			0.213 - c*0.213 + s*0.143, 0.715 + c*0.285 + s*0.140, 0.072 - c*0.072 - s*0.283,
			0.213 - c*0.213 - s*0.787, 0.715 - c*0.715 + s*0.715, 0.072 + c*0.928 + s*0.072}
	case "brightness":
		m = [9]float64{a, 0, 0, 0, a, 0, 0, 0, a}
	case "contrast":
		m = [9]float64{a, 0, 0, 0, a, 0, 0, 0, a}
		b = [3]float64{0.5 - 0.5*a, 0.5 - 0.5*a, 0.5 - 0.5*a}
	}
	return
}

// applyColor: 알파를 뺀 색에 행렬을 차례로 (투명한 곳은 그대로 투명)
func applyColor(img *image.RGBA, ops []colorOp) {
	if len(ops) == 0 {
		return
	}
	type mb struct {
		m [9]float64
		b [3]float64
	}
	ms := make([]mb, len(ops))
	for i, o := range ops {
		m, b := colorMatrix(o.name, o.a)
		ms[i] = mb{m, b}
	}
	parallelRows(img.Rect.Dy(), func(y0, y1 int) {
		p := img.Pix[y0*img.Stride : y1*img.Stride]
		for i := 0; i+3 < len(p); i += 4 {
			a := float64(p[i+3])
			if a == 0 {
				continue
			}
			r, g, b := float64(p[i])/a, float64(p[i+1])/a, float64(p[i+2])/a
			for _, x := range ms {
				nr := x.m[0]*r + x.m[1]*g + x.m[2]*b + x.b[0]
				ng := x.m[3]*r + x.m[4]*g + x.m[5]*b + x.b[1]
				nb := x.m[6]*r + x.m[7]*g + x.m[8]*b + x.b[2]
				r, g, b = clamp(nr, 0, 1), clamp(ng, 0, 1), clamp(nb, 0, 1)
			}
			p[i], p[i+1], p[i+2] = clamp8(r*a), clamp8(g*a), clamp8(b*a)
		}
	})
}

// vignetteMask: 필름 색감의 어두운 가장자리 (반지름 45% 부터 모서리까지 검정 0 → 0.6)
func vignetteMask(W, H int) []uint8 {
	m := make([]uint8, W*H)
	half := math.Hypot(float64(W), float64(H)) / 2
	r0 := half * 0.45
	cx, cy := float64(W)/2, float64(H)/2
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
			t := clamp((d-r0)/(half-r0), 0, 1)
			m[y*W+x] = uint8(t*0.6*255 + 0.5)
		}
	}
	return m
}

func applyVignette(img *image.RGBA, mask []uint8) {
	W := img.Rect.Dx()
	parallelRows(img.Rect.Dy(), func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			p := img.Pix[y*img.Stride:]
			for x := 0; x < W; x++ {
				a := uint32(mask[y*W+x])
				if a == 0 {
					continue
				}
				k := 255 - a
				i := x * 4
				p[i] = uint8(uint32(p[i]) * k / 255)
				p[i+1] = uint8(uint32(p[i+1]) * k / 255)
				p[i+2] = uint8(uint32(p[i+2]) * k / 255)
				p[i+3] = uint8(a + uint32(p[i+3])*k/255)
			}
		}
	})
}

// blend: out = b*alpha over a (둘 다 같은 크기)
func blendInto(dst, a, b *image.RGBA, alpha float64) {
	k := uint32(clamp(alpha, 0, 1)*256 + 0.5)
	parallelRows(dst.Rect.Dy(), func(y0, y1 int) {
		s := y0 * dst.Stride
		e := y1 * dst.Stride
		pa, pb, pd := a.Pix[s:e], b.Pix[s:e], dst.Pix[s:e]
		for i := 0; i+3 < len(pd); i += 4 {
			sa := uint32(pb[i+3]) * k >> 8
			inv := 255 - sa
			pd[i] = uint8((uint32(pb[i])*k>>8 + uint32(pa[i])*inv/255))
			pd[i+1] = uint8((uint32(pb[i+1])*k>>8 + uint32(pa[i+1])*inv/255))
			pd[i+2] = uint8((uint32(pb[i+2])*k>>8 + uint32(pa[i+2])*inv/255))
			pd[i+3] = uint8(sa + uint32(pa[i+3])*inv/255)
		}
	})
}
