package main

// 글자 · 자막 그리기 — Render.swift 의 TextArt 와 같은 크기 · 위치 (짧은 변의 4.5% · 6% · 8.5%, 위/아래 여백 높이의 7%)

import (
	"image"
	"math"
	"strings"
	"sync"
	"unicode"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

var (
	fontOnce sync.Once
	textFont *opentype.Font
)

func loadTextFont() *opentype.Font {
	fontOnce.Do(func() {
		if len(textFontTTF) > 0 {
			textFont, _ = opentype.Parse(textFontTTF)
		}
	})
	return textFont
}

type textArt struct {
	img  *image.RGBA
	x, y int // 화면 위 왼쪽 위 모서리
}

func textFontSize(size string, W, H int) float64 {
	base := float64(min(W, H))
	k := 0.06
	switch size {
	case "s":
		k = 0.045
	case "l":
		k = 0.085
	}
	return math.Max(10, base*k)
}

// wrapLines: 낱말 단위로 줄을 나누고, 한 낱말이 너무 길면 글자 단위로 (줄바꿈 글자도 지켜요)
func wrapLines(face font.Face, text string, maxW float64) []string {
	measure := func(s string) float64 { return float64(font.MeasureString(face, s)) / 64 }
	var lines []string
	for _, para := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		words := strings.FieldsFunc(para, func(r rune) bool { return r == ' ' || r == '\t' })
		if len(words) == 0 {
			lines = append(lines, "")
			continue
		}
		cur := ""
		for _, w := range words {
			try := w
			if cur != "" {
				try = cur + " " + w
			}
			if measure(try) <= maxW || cur == "" && measure(w) <= maxW {
				cur = try
				continue
			}
			if cur != "" {
				lines = append(lines, cur)
				cur = ""
			}
			// 낱말 하나가 한 줄보다 길면 글자 단위로
			for measure(w) > maxW {
				rs := []rune(w)
				k := len(rs)
				for k > 1 && measure(string(rs[:k])) > maxW {
					k--
				}
				lines = append(lines, string(rs[:k]))
				w = string(rs[k:])
			}
			cur = w
		}
		if cur != "" {
			lines = append(lines, cur)
		}
	}
	return lines
}

func makeTextArt(x textSpec, W, H int) *textArt {
	f := loadTextFont()
	if f == nil {
		return nil
	}
	fs := textFontSize(x.size, W, H)
	face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: fs, DPI: 72, Hinting: font.HintingNone})
	if err != nil {
		return nil
	}
	defer face.Close()
	lines := wrapLines(face, strings.TrimRightFunc(x.text, unicode.IsSpace), float64(W)*0.86)
	if len(lines) > 6 {
		lines = lines[:6]
	}
	if len(lines) == 0 {
		return nil
	}
	met := face.Metrics()
	ascent, descent := float64(met.Ascent)/64, float64(met.Descent)/64
	lineH := (ascent + descent) * 1.18
	widths := make([]float64, len(lines))
	textW := 0.0
	for i, l := range lines {
		widths[i] = float64(font.MeasureString(face, strings.TrimRight(l, " "))) / 64
		textW = math.Max(textW, widths[i])
	}
	textH := lineH*float64(len(lines)) - (lineH - (ascent + descent))
	padX, padY := fs*0.3, fs*0.2
	if x.box {
		padX, padY = fs*0.5, fs*0.28
	}
	iw, ih := int(math.Ceil(textW+padX*2)), int(math.Ceil(textH+padY*2))
	if iw <= 0 || ih <= 0 {
		return nil
	}
	img := newRGBA(iw, ih)
	if x.box {
		roundRect(img, fs*0.28, 0, 0, 0, 0.62)
	}
	// 흰 글자 (알파 마스크로 그린 뒤 색을 입혀요)
	mask := image.NewAlpha(img.Rect)
	d := &font.Drawer{Dst: mask, Src: image.Opaque, Face: face}
	for i, l := range lines {
		d.Dot = fixed.Point26_6{X: fixed.Int26_6(((float64(iw) - widths[i]) / 2) * 64), Y: fixed.Int26_6((padY + ascent + float64(i)*lineH) * 64)}
		d.DrawString(l)
	}
	if !x.box { // 그림자: 아래로 조금, 부드럽게, 검정 90%
		sh := newRGBA(iw, ih)
		off := int(math.Round(fs * 0.05))
		for y := 0; y < ih; y++ {
			for xx := 0; xx < iw; xx++ {
				if y-off < 0 {
					continue
				}
				a := mask.Pix[(y-off)*mask.Stride+xx]
				sh.Pix[y*sh.Stride+xx*4+3] = uint8(float64(a)*0.9 + 0.5)
			}
		}
		gaussianBlur(sh, fs*0.15)
		drawOver(img, sh, 0, 0, identity, 1)
	}
	for i, a := range mask.Pix {
		if a == 0 {
			continue
		}
		o := (i/mask.Stride)*img.Stride + (i%mask.Stride)*4
		k := 255 - uint32(a)
		p := img.Pix[o : o+4]
		p[0] = uint8(uint32(a) + uint32(p[0])*k/255)
		p[1] = uint8(uint32(a) + uint32(p[1])*k/255)
		p[2] = uint8(uint32(a) + uint32(p[2])*k/255)
		p[3] = uint8(uint32(a) + uint32(p[3])*k/255)
	}
	margin := float64(H) * 0.07
	x0 := int(math.Round((float64(W) - float64(iw)) / 2))
	var top float64
	switch x.pos {
	case "top":
		top = margin
	case "center":
		top = (float64(H) - float64(ih)) / 2
	case "br":
		top = float64(H) - margin*0.6 - float64(ih)
		x0 = int(math.Round(float64(W) - float64(iw) - float64(W)*0.04))
	default:
		top = float64(H) - margin - float64(ih)
	}
	return &textArt{img: img, x: x0, y: int(math.Round(top))}
}

// roundRect fills the whole image with a rounded rectangle (premultiplied colour, alpha a).
func roundRect(img *image.RGBA, rad float64, r, g, b uint8, a float64) {
	W, H := img.Rect.Dx(), img.Rect.Dy()
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			cov := 1.0
			px, py := float64(x)+0.5, float64(y)+0.5
			cx, cy := px, py
			if px < rad {
				cx = rad
			} else if px > float64(W)-rad {
				cx = float64(W) - rad
			}
			if py < rad {
				cy = rad
			} else if py > float64(H)-rad {
				cy = float64(H) - rad
			}
			if cx != px || cy != py {
				d := math.Hypot(px-cx, py-cy)
				cov = clamp(rad-d+0.5, 0, 1)
			}
			al := a * cov
			o := y*img.Stride + x*4
			img.Pix[o] = uint8(float64(r)*al + 0.5)
			img.Pix[o+1] = uint8(float64(g)*al + 0.5)
			img.Pix[o+2] = uint8(float64(b)*al + 0.5)
			img.Pix[o+3] = uint8(255*al + 0.5)
		}
	}
}
