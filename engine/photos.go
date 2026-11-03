package main

// Windows 판: 사진 폴더 읽기 · 사진 정보(크기 · 방향 · 찍은 날짜) · 미리보기 JPG (맥의 Photos.swift 와 같은 답)
// JPG · PNG 는 Go 로 직접 읽고(EXIF 방향 · 날짜도), HEIC 는 ffmpeg 로 바꿔서 읽어요.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/image/draw"
)

func scanPhotos(dir string, recursive bool) []string {
	out := []string{}
	if !dirExists(dir) {
		return out
	}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if p != dir && (strings.HasPrefix(name, ".") || strings.HasPrefix(name, "$")) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if p != dir && !recursive {
				return filepath.SkipDir
			}
			return nil
		}
		if photoExts[strings.ToLower(filepath.Ext(name))] {
			out = append(out, p)
			if len(out) >= 2000 {
				return filepath.SkipAll
			}
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return naturalLess(out[i], out[j]) })
	return out
}

// naturalLess: 'IMG_2.jpg' 가 'IMG_10.jpg' 보다 앞에 오게 (맥 Finder 순서처럼)
func naturalLess(a, b string) bool {
	ra, rb := []rune(strings.ToLower(a)), []rune(strings.ToLower(b))
	i, j := 0, 0
	for i < len(ra) && j < len(rb) {
		if unicode.IsDigit(ra[i]) && unicode.IsDigit(rb[j]) {
			si := i
			for i < len(ra) && unicode.IsDigit(ra[i]) {
				i++
			}
			sj := j
			for j < len(rb) && unicode.IsDigit(rb[j]) {
				j++
			}
			na, nb := strings.TrimLeft(string(ra[si:i]), "0"), strings.TrimLeft(string(rb[sj:j]), "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		if ra[i] != rb[j] {
			return ra[i] < rb[j]
		}
		i++
		j++
	}
	return len(ra)-i < len(rb)-j
}

// ---------------------------------------------------------------- 사진 정보

func (n *Nat) probePhoto(path string) map[string]any {
	out := map[string]any{"path": path, "name": filepath.Base(path), "kind": "image", "duration": 3600, "hasAudio": false}
	st, err := os.Stat(path)
	if err != nil {
		out["error"] = "파일을 찾을 수 없어요"
		return out
	}
	out["size"] = st.Size()
	key := cacheKey(path)
	dir := n.cacheDir("img")
	prev := filepath.Join(dir, key+".jpg")
	thumbF := filepath.Join(dir, key+"-t.jpg")
	meta := readPhotoMeta(path)
	taken := meta.taken
	if taken.IsZero() {
		taken = st.ModTime()
	}
	out["taken"] = taken.UnixMilli()
	w, h := meta.w, meta.h
	if !fileExists(prev) || !fileExists(thumbF) || w == 0 {
		img, err := n.loadImage(path, 1600)
		if err != nil {
			out["error"] = "이 사진은 읽을 수 없어요"
			return out
		}
		b := img.Bounds()
		if w == 0 || h == 0 { // 원래 크기를 모르면(HEIC) 줄인 그림의 비율로
			w, h = b.Dx(), b.Dy()
			if full, ok := n.heicSize(path); ok {
				w, h = full[0], full[1]
			}
		}
		writeJPEG(prev, img, 82)
		writeJPEG(thumbF, resizeFit(img, 200), 65)
	}
	if w == 0 || h == 0 {
		out["error"] = "이 사진은 읽을 수 없어요"
		return out
	}
	out["width"], out["height"] = w, h
	if fileExists(prev) {
		out["preview"] = prev
	} else {
		out["error"] = "이 사진은 읽을 수 없어요"
	}
	if t, err := os.ReadFile(thumbF); err == nil {
		out["thumb"] = "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(t)
	}
	return out
}

func writeJPEG(p string, img image.Image, q int) error {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
		return err
	}
	return writeFileAtomicErr(p, buf.Bytes(), 0o644)
}

// resizeFit: 가장 긴 변이 maxSide 가 되게 줄여요 (이미 작으면 그대로)
func resizeFit(img image.Image, maxSide int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= maxSide && h <= maxSide {
		return img
	}
	s := float64(maxSide) / float64(max(w, h))
	nw, nh := max(1, int(float64(w)*s+0.5)), max(1, int(float64(h)*s+0.5))
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	draw.BiLinear.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst
}

var imgDecodeSem = make(chan struct{}, 3) // 큰 사진을 한꺼번에 너무 많이 풀지 않게

// loadImage: 방향을 바로잡은 그림 (가장 긴 변 ≤ maxSide, 0 이면 원래 크기)
func (n *Nat) loadImage(path string, maxSide int) (image.Image, error) {
	imgDecodeSem <- struct{}{}
	defer func() { <-imgDecodeSem }()
	ext := strings.ToLower(filepath.Ext(path))
	var img image.Image
	var err error
	orient := 1
	if ext == ".heic" || ext == ".heif" {
		img, err = n.ffmpegImage(path, maxSide)
	} else {
		var f *os.File
		if f, err = os.Open(path); err == nil {
			img, _, err = image.Decode(f)
			f.Close()
		}
		if err == nil {
			orient = readPhotoMeta(path).orient
		} else {
			img, err = n.ffmpegImage(path, maxSide) // Go 가 못 읽는 JPG 는 ffmpeg 로
		}
	}
	if err != nil {
		return nil, err
	}
	if maxSide > 0 {
		img = resizeFit(img, maxSide)
	}
	return orientImage(img, orient), nil
}

// ffmpegImage: HEIC 등 → PNG (ffmpeg 가 방향도 바로잡아요)
func (n *Nat) ffmpegImage(path string, maxSide int) (image.Image, error) {
	if n == nil || n.tools == nil {
		return nil, errors.New("no ffmpeg")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	vf := "format=rgb24"
	if maxSide > 0 {
		vf = fmt.Sprintf("scale='if(gt(iw,ih),min(%d,iw),-2)':'if(gt(iw,ih),-2,min(%d,ih))',format=rgb24", maxSide, maxSide)
	}
	cmd := n.ff(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", path, "-frames:v", "1", "-vf", vf, "-c:v", "png", "-f", "image2pipe", "pipe:1")
	b, err := cmd.Output()
	if err != nil || len(b) == 0 {
		return nil, fmt.Errorf("사진을 읽지 못했어요")
	}
	img, _, err := image.Decode(bytes.NewReader(b))
	return img, err
}

var heicSizes sync.Map

// heicSize: HEIC 원래 크기(방향 반영)
func (n *Nat) heicSize(path string) ([2]int, bool) {
	if v, ok := heicSizes.Load(path); ok {
		return v.([2]int), true
	}
	p, err := n.ffprobe(path)
	if err != nil || p.video() == nil {
		return [2]int{}, false
	}
	best := [2]int{}
	for _, s := range p.Streams { // HEIC 은 타일 여러 개 + 전체 그림: 가장 큰 것
		if s.CodecType == "video" && s.Width*s.Height > best[0]*best[1] {
			best = [2]int{s.Width, s.Height}
			if r := s.rotation(); r == 90 || r == 270 {
				best = [2]int{s.Height, s.Width}
			}
		}
	}
	heicSizes.Store(path, best)
	return best, best[0] > 0
}

// orientImage applies EXIF orientation 2…8.
func orientImage(img image.Image, o int) image.Image {
	if o <= 1 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	ow, oh := w, h
	if o >= 5 {
		ow, oh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, ow, oh))
	src := toRGBA(img)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			si := src.PixOffset(b.Min.X+x, b.Min.Y+y)
			di := dst.PixOffset(dx, dy)
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}

func toRGBA(img image.Image) *image.RGBA {
	if r, ok := img.(*image.RGBA); ok {
		return r
	}
	b := img.Bounds()
	dst := image.NewRGBA(b)
	draw.Draw(dst, b, img, b.Min, draw.Src)
	return dst
}

// ---------------------------------------------------------------- EXIF (방향 · 찍은 날짜 · 크기)

type photoMeta struct {
	w, h   int // 방향 반영
	orient int
	taken  time.Time
}

func readPhotoMeta(path string) photoMeta {
	m := photoMeta{orient: 1}
	f, err := os.Open(path)
	if err != nil {
		return m
	}
	defer f.Close()
	if cfg, _, err := image.DecodeConfig(f); err == nil {
		m.w, m.h = cfg.Width, cfg.Height
	}
	if ext := strings.ToLower(filepath.Ext(path)); ext == ".jpg" || ext == ".jpeg" {
		f.Seek(0, 0)
		head := make([]byte, 256<<10)
		k, _ := f.Read(head)
		parseJPEGExif(head[:k], &m)
	}
	if m.orient >= 5 {
		m.w, m.h = m.h, m.w
	}
	return m
}

func parseJPEGExif(b []byte, m *photoMeta) {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return
	}
	i := 2
	for i+4 <= len(b) {
		if b[i] != 0xFF {
			return
		}
		marker := b[i+1]
		size := int(binary.BigEndian.Uint16(b[i+2:]))
		if marker == 0xDA || size < 2 || i+2+size > len(b) {
			return
		}
		seg := b[i+4 : i+2+size]
		if marker == 0xE1 && len(seg) > 6 && string(seg[:6]) == "Exif\x00\x00" {
			parseTIFF(seg[6:], m)
			return
		}
		i += 2 + size
	}
}

func parseTIFF(t []byte, m *photoMeta) {
	if len(t) < 8 {
		return
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return
	}
	readIFD := func(off int, fn func(tag, typ uint16, count uint32, val []byte)) {
		if off < 8 || off+2 > len(t) {
			return
		}
		n := int(bo.Uint16(t[off:]))
		for k := 0; k < n; k++ {
			e := off + 2 + 12*k
			if e+12 > len(t) {
				return
			}
			fn(bo.Uint16(t[e:]), bo.Uint16(t[e+2:]), bo.Uint32(t[e+4:]), t[e+8:e+12])
		}
	}
	str := func(count uint32, val []byte) string {
		if count <= 4 {
			return strings.TrimRight(string(val[:count]), "\x00")
		}
		o := int(bo.Uint32(val))
		if o < 0 || o+int(count) > len(t) {
			return ""
		}
		return strings.TrimRight(string(t[o:o+int(count)]), "\x00")
	}
	parseDate := func(s string) time.Time {
		tm, err := time.ParseInLocation("2006:01:02 15:04:05", strings.TrimSpace(s), time.Local)
		if err != nil {
			return time.Time{}
		}
		return tm
	}
	var dt time.Time
	exifOff := 0
	readIFD(int(bo.Uint32(t[4:])), func(tag, typ uint16, count uint32, val []byte) {
		switch tag {
		case 0x0112:
			m.orient = int(bo.Uint16(val))
		case 0x0132:
			dt = parseDate(str(count, val))
		case 0x8769:
			exifOff = int(bo.Uint32(val))
		}
	})
	readIFD(exifOff, func(tag, typ uint16, count uint32, val []byte) {
		if tag == 0x9003 {
			if d := parseDate(str(count, val)); !d.IsZero() {
				m.taken = d
			}
		}
	})
	if m.taken.IsZero() {
		m.taken = dt
	}
}
