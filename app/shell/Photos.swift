// CUTROAD — 사진 (폴더 읽기 · 정보 · 미리보기) · 음악 박자 찾기
// made by. Nevertheless_D

import Accelerate
import AppKit
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

enum Photos {
    static let extensions = ["jpg", "jpeg", "png", "heic", "heif"]

    /// 폴더 안의 사진 (하위 폴더까지, 최대 2000장, 숨김 파일 빼고)
    static func scan(_ dir: String, recursive: Bool) -> [String] {
        let fm = FileManager.default
        let root = URL(fileURLWithPath: dir, isDirectory: true)
        var out: [String] = []
        let opts: FileManager.DirectoryEnumerationOptions = recursive ? [.skipsHiddenFiles, .skipsPackageDescendants] : [.skipsHiddenFiles, .skipsSubdirectoryDescendants]
        guard let en = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey], options: opts) else { return [] }
        for case let u as URL in en {
            if extensions.contains(u.pathExtension.lowercased()) { out.append(u.path) }
            if out.count >= 2000 { break }
        }
        return out.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    static func cacheDir() -> URL {
        let d = Paths.cache.appendingPathComponent("img", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// 방향을 반영해서 줄인 그림 (가장 긴 변 maxSide)
    static func cgImage(_ path: String, maxSide: Int) -> CGImage? {
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(16, maxSide),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
    }

    static let dateParser: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy:MM:dd HH:mm:ss"
        return f
    }()

    /// 사진 정보: 크기(방향 반영) · 찍은 날짜 · 미리보기 JPG(화면용) · 작은 그림(타임라인용)
    static func probe(_ path: String) -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        var out: [String: Any] = ["path": path, "name": url.lastPathComponent, "kind": "image", "duration": 3600, "hasAudio": false]
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else {
            out["error"] = "이 사진은 읽을 수 없어요"
            return out
        }
        var w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
        var h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
        let orient = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        if orient >= 5 { swap(&w, &h) }
        guard w > 0, h > 0 else { out["error"] = "이 사진은 읽을 수 없어요"; return out }
        out["width"] = w
        out["height"] = h
        var taken: Date?
        if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any], let s = exif[kCGImagePropertyExifDateTimeOriginal] as? String {
            taken = dateParser.date(from: s)
        }
        if taken == nil, let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any], let s = tiff[kCGImagePropertyTIFFDateTime] as? String {
            taken = dateParser.date(from: s)
        }
        let attrs = (try? FileManager.default.attributesOfItem(atPath: path)) ?? [:]
        if taken == nil { taken = (attrs[.creationDate] as? Date) ?? (attrs[.modificationDate] as? Date) }
        out["taken"] = Int((taken ?? Date()).timeIntervalSince1970 * 1000)
        out["size"] = (attrs[.size] as? NSNumber)?.int64Value ?? 0

        let key = Media.cacheKey(path)
        let prev = cacheDir().appendingPathComponent(key + ".jpg")
        if !FileManager.default.fileExists(atPath: prev.path), let img = cgImage(path, maxSide: 1600), let jpg = Media.jpeg(img, quality: 0.82) {
            try? jpg.write(to: prev)
        }
        if FileManager.default.fileExists(atPath: prev.path) { out["preview"] = prev.path }
        let thumbFile = cacheDir().appendingPathComponent(key + "-t.jpg")
        var thumb = try? Data(contentsOf: thumbFile)
        if thumb == nil, let img = cgImage(path, maxSide: 200), let jpg = Media.jpeg(img, quality: 0.65) {
            try? jpg.write(to: thumbFile)
            thumb = jpg
        }
        if let t = thumb { out["thumb"] = "data:image/jpeg;base64," + t.base64EncodedString() }
        if out["preview"] == nil { out["error"] = "이 사진은 읽을 수 없어요" }
        return out
    }

    /// 여러 장을 한꺼번에 (맥의 여러 코어로 나눠서)
    static func probeAll(_ paths: [String]) -> [[String: Any]] {
        var res = [[String: Any]](repeating: [:], count: paths.count)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: paths.count) { i in
            let r = autoreleasepool { probe(paths[i]) }
            lock.lock(); res[i] = r; lock.unlock()
        }
        return res
    }
}

// MARK: - 음악 박자 찾기

enum Beats {
    /// 음악의 박자: BPM · 박자 시각 · 강박(마디 첫 박) · 박자마다 소리 크기(0~1) · 절정 구간. cache 폴더에 저장해요.
    static func analyze(_ path: String) -> [String: Any] {
        let dir = Paths.cache.appendingPathComponent("beats", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(Media.cacheKey(path) + "-b2.json")
        if let d = try? Data(contentsOf: file), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { return j }
        let out = compute(path)
        if out["error"] == nil, let d = try? JSONSerialization.data(withJSONObject: out) { try? d.write(to: file) }
        return out
    }

    static let sr = 22050.0
    static let n = 1024
    static let hop = 512

    static func decode(_ path: String) -> [Float] {
        let a = Media.asset(path)
        guard let track = a.tracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: a) else { return [] }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sr, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
        ])
        guard reader.canAdd(output) else { return [] }
        reader.add(output)
        guard reader.startReading() else { return [] }
        var all: [Float] = []
        all.reserveCapacity(Int(sr * max(1, a.duration.seconds)))
        while reader.status == .reading, let sb = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sb) else { continue }
            let len = CMBlockBufferGetDataLength(block) / 4
            if len == 0 { continue }
            var buf = [Float](repeating: 0, count: len)
            _ = buf.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: len * 4, destination: $0.baseAddress!) }
            all.append(contentsOf: buf)
        }
        return all
    }

    static func compute(_ path: String) -> [String: Any] {
        let x = decode(path)
        let dur = Double(x.count) / sr
        guard x.count > n * 8 else { return ["error": "음악이 너무 짧거나 읽을 수 없어요", "duration": dur] }
        let fps = sr / Double(hop)
        let frames = (x.count - n) / hop

        // 1) 스펙트럼 변화량(onset) · 소리 크기(rms)
        let log2n = vDSP_Length(log2(Double(n)))
        guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return ["error": "분석을 준비하지 못했어요"] }
        defer { vDSP_destroy_fftsetup(setup) }
        var window = [Float](repeating: 0, count: n)
        vDSP_hann_window(&window, vDSP_Length(n), Int32(vDSP_HANN_NORM))
        var prev = [Float](repeating: 0, count: n / 2)
        var onset = [Float](repeating: 0, count: frames)
        var rms = [Float](repeating: 0, count: frames)
        var frame = [Float](repeating: 0, count: n)
        var re = [Float](repeating: 0, count: n / 2), im = [Float](repeating: 0, count: n / 2)
        var mag = [Float](repeating: 0, count: n / 2)
        x.withUnsafeBufferPointer { xp in
            for f in 0..<frames {
                let base = xp.baseAddress! + f * hop
                vDSP_vmul(base, 1, window, 1, &frame, 1, vDSP_Length(n))
                var r: Float = 0
                vDSP_rmsqv(base, 1, &r, vDSP_Length(n))
                rms[f] = r
                re.withUnsafeMutableBufferPointer { rp in
                    im.withUnsafeMutableBufferPointer { ip in
                        var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                        frame.withUnsafeBufferPointer { fp in
                            fp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { cp in
                                vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(n / 2))
                            }
                        }
                        vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                        vDSP_zvabs(&split, 1, &mag, 1, vDSP_Length(n / 2))
                    }
                }
                var flux: Float = 0
                for k in 1..<(n / 2) {
                    let v = log(1 + 10 * mag[k])
                    let d = v - prev[k]
                    if d > 0 { flux += d }
                    prev[k] = v
                }
                onset[f] = flux
            }
        }
        // 느린 변화를 빼고(평균 0.5초) 남은 '튀는 부분'만
        let win = max(3, Int(fps * 0.25))
        var o = [Double](repeating: 0, count: frames)
        var acc = 0.0
        let on = onset.map { Double($0) }
        for i in 0..<frames {
            acc += on[i]
            if i > 2 * win { acc -= on[i - 2 * win - 1] }
            let mean = acc / Double(min(i + 1, 2 * win + 1))
            o[i] = max(0, on[max(0, i - win)] - mean)
        }
        o = Array(o.dropFirst(win)) + [Double](repeating: 0, count: win)
        let oMax = o.max() ?? 0
        guard oMax > 0 else { return fallback(dur, rms: rms, fps: fps) }

        // 2) 빠르기(BPM): 자기상관 + 120 BPM 근처를 조금 더 좋아하는 가중치
        let minLag = Int(fps * 60 / 200), maxLag = Int(fps * 60 / 60)
        var ac = [Double](repeating: 0, count: maxLag * 2 + 2)
        for L in minLag...(min(maxLag * 2 + 1, frames - 1)) {
            var s = 0.0
            var i = 0
            while i + L < frames { s += o[i] * o[i + L]; i += 1 }
            ac[L] = s / Double(frames - L)
        }
        var best = minLag
        var bestScore = -1.0
        for L in minLag...maxLag {
            let bpm = 60 * fps / Double(L)
            let w = exp(-0.5 * pow(log2(bpm / 120) / 0.9, 2))
            let score = (ac[L] + 0.5 * (2 * L < ac.count ? ac[2 * L] : 0)) * w
            if score > bestScore { bestScore = score; best = L }
        }
        var period = Double(best)
        if best > minLag && best < maxLag {
            let a = ac[best - 1], b = ac[best], c = ac[best + 1]
            let den = a - 2 * b + c
            if den != 0 { period += 0.5 * (a - c) / den }
        }
        // 박자가 반으로 잡히는 일(예: 120 → 60)을 막아요: 두 배 빠르기에서도 잘 맞으면 그쪽을 골라요
        while 60 * fps / period < 90 {
            let half = Int((period / 2).rounded())
            guard half >= minLag, half < ac.count, 60 * fps / (period / 2) <= 150 else { break }
            if ac[half] >= 0.35 * ac[Int(period.rounded())] { period /= 2 } else { break }
        }
        let bpm = 60 * fps / period

        // 3) 박자 위치: 가장 잘 맞는 시작점을 찾고, 박자마다 가까운 튀는 곳에 살짝 맞춰요
        var bestPhase = 0
        var phaseScore = -1.0
        for ph in 0..<max(1, Int(period)) {
            var s = 0.0
            var p = Double(ph)
            while p < Double(frames) { s += o[Int(p)]; p += period }
            if s > phaseScore { phaseScore = s; bestPhase = ph }
        }
        var beatsF: [Double] = []
        var expect = Double(bestPhase)
        let reach = max(2, Int(period * 0.12))
        while expect < Double(frames) - 1 {
            let c = Int(expect.rounded())
            var bi = c, bv = -1.0
            for k in max(0, c - reach)...min(frames - 1, c + reach) {
                let d = Double(k - c) / Double(reach)
                let v = o[k] * exp(-2 * d * d)
                if v > bv { bv = v; bi = k }
            }
            let pos = 0.7 * Double(bi) + 0.3 * expect
            beatsF.append(pos)
            expect = pos + period
        }
        let toSec = { (f: Double) -> Double in (f * Double(self.hop) + Double(self.n) / 2) / self.sr }
        let beats = beatsF.map { (toSec($0) * 1000).rounded() / 1000 }.filter { $0 < dur }

        // 4) 박자마다 소리 크기 · 강박(4박 중 가장 센 자리) · 절정 구간
        var energy: [Double] = []
        for (i, b) in beats.enumerated() {
            let a = Int(b * fps), e = Int((i + 1 < beats.count ? beats[i + 1] : b + period / fps) * fps)
            var s: Float = 0
            var cnt = 0
            for k in max(0, a)..<min(frames, max(a + 1, e)) { s += rms[k]; cnt += 1 }
            energy.append(cnt > 0 ? Double(s) / Double(cnt) : 0)
        }
        let sorted = energy.sorted()
        let top = sorted.isEmpty ? 1 : max(1e-6, sorted[Int(Double(sorted.count - 1) * 0.95)])
        energy = energy.map { min(1, $0 / top) }
        var downPhase = 0
        var dpScore = -1.0
        for ph in 0..<4 {
            var s = 0.0
            for (i, b) in beats.enumerated() where i % 4 == ph { s += o[min(frames - 1, Int(b * fps))] }
            if s > dpScore { dpScore = s; downPhase = ph }
        }
        let downbeats = beats.enumerated().filter { $0.offset % 4 == downPhase }.map { $0.element }
        var smooth = [Double](repeating: 0, count: energy.count)
        for i in 0..<energy.count {
            let a = max(0, i - 4), b = min(energy.count - 1, i + 4)
            smooth[i] = energy[a...b].reduce(0, +) / Double(b - a + 1)
        }
        let st = smooth.sorted()
        let thr = st.isEmpty ? 1 : st[Int(Double(st.count - 1) * 0.75)]
        var climax: [[Double]] = []
        var runStart = -1
        for i in 0...smooth.count {
            let hot = i < smooth.count && smooth[i] >= thr && thr > 0.3
            if hot && runStart < 0 { runStart = i }
            if !hot && runStart >= 0 {
                if i - runStart >= 8 { climax.append([beats[runStart], i < beats.count ? beats[i] : dur]) }
                runStart = -1
            }
        }
        return ["bpm": (bpm * 10).rounded() / 10, "beats": beats, "downbeats": downbeats,
                "energy": energy.map { ($0 * 100).rounded() / 100 }, "climax": climax, "duration": dur]
    }

    /// 박자를 못 찾으면(조용하거나 박자가 없는 음악) 100 BPM 으로 고르게 나눠요
    static func fallback(_ dur: Double, rms: [Float], fps: Double) -> [String: Any] {
        let p = 0.6
        let beats = stride(from: 0.0, to: dur, by: p).map { ($0 * 1000).rounded() / 1000 }
        return ["bpm": 100, "beats": beats, "downbeats": beats.enumerated().filter { $0.offset % 4 == 0 }.map { $0.element },
                "energy": beats.map { _ in 0.5 }, "climax": [], "duration": dur, "guessed": true]
    }
}
