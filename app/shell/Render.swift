// CUTROAD — 타임라인을 맥 내장 기능(AVFoundation · Core Image · Core Text)으로 실제 영상으로 만들기
// made by. Nevertheless_D
//
// 화면(app.js)이 보내는 프로젝트 내용(spec)을 받아서
//   1) AVMutableComposition: 클립을 A/B 두 줄에 번갈아 놓아요 (트랜지션 동안 두 클립이 겹치게)
//   2) AVMutableAudioMix: 클립 소리 · 배경음악의 볼륨 · 페이드 · 트랜지션 동안 서로 바뀌기(크로스페이드)
//   3) 직접 만든 Compositor: 한 장면마다 방향 맞추기 · 회전 · 화면 맞춤 · 블러 · 페이드 · 트랜지션 · 글자를 그려요
// 시간 계산은 app.js 의 timing() 과 똑같아야 해요 (미리보기와 결과가 같게).

import AppKit
import AVFoundation
import CoreImage
import CoreText

struct RenderError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

func num(_ d: [String: Any], _ k: String, _ def: Double) -> Double {
    if let v = d[k] as? Double { return v }
    if let v = d[k] as? Int { return Double(v) }
    if let v = d[k] as? NSNumber { return v.doubleValue }
    return def
}

func str(_ d: [String: Any], _ k: String, _ def: String) -> String { (d[k] as? String) ?? def }

func ct(_ s: Double) -> CMTime { CMTime(seconds: max(0, s), preferredTimescale: 6000) }

struct ClipSpec {
    let path: String
    let inT: Double
    let outT: Double
    let speed: Double
    let volume: Double
    let fadeIn: Double
    let fadeOut: Double
    let blur: Double
    let rotate: Int
    let transType: String?
    let transDur: Double
    var dur: Double { (outT - inT) / speed }

    init(_ d: [String: Any]) {
        path = str(d, "path", "")
        inT = max(0, num(d, "in", 0))
        outT = max(inT + 0.05, num(d, "out", inT + 1))
        speed = min(4, max(0.25, num(d, "speed", 1)))
        volume = min(1, max(0, num(d, "volume", 1)))
        fadeIn = max(0, num(d, "fadeIn", 0))
        fadeOut = max(0, num(d, "fadeOut", 0))
        blur = max(0, num(d, "blur", 0))
        rotate = ((Int(num(d, "rotate", 0)) % 360) + 360) % 360
        if let t = d["trans"] as? [String: Any], let type = t["type"] as? String, !type.isEmpty {
            transType = type
            transDur = max(0, num(t, "dur", 0.8))
        } else {
            transType = nil
            transDur = 0
        }
    }
}

struct AudioSpec {
    let path: String
    let start: Double
    let inT: Double
    let outT: Double
    let volume: Double
    let fadeIn: Double
    let fadeOut: Double
    init(_ d: [String: Any]) {
        path = str(d, "path", "")
        start = max(0, num(d, "start", 0))
        inT = max(0, num(d, "in", 0))
        outT = max(inT + 0.05, num(d, "out", inT + 1))
        volume = min(1, max(0, num(d, "volume", 1)))
        fadeIn = max(0, num(d, "fadeIn", 0))
        fadeOut = max(0, num(d, "fadeOut", 0))
    }
}

struct TextSpec {
    let text: String
    let start: Double
    let end: Double
    let pos: String
    let size: String
    let box: Bool
    init(_ d: [String: Any]) {
        text = str(d, "text", "")
        start = max(0, num(d, "start", 0))
        end = max(start, num(d, "end", start + 2))
        pos = str(d, "pos", "bottom")
        size = str(d, "size", "m")
        box = (d["box"] as? Bool) ?? true
    }
}

/// 프로젝트 내용 + 시간 계산
struct Plan {
    var clips: [ClipSpec]
    var audio: [AudioSpec]
    var texts: [TextSpec]
    var aspect: String
    var fit: String
    var starts: [Double] = []
    var trans: [Double] = []   // trans[i] = 클립 i 와 i+1 사이 트랜지션 길이
    var total: Double = 0

    init(_ spec: [String: Any]) {
        clips = (spec["clips"] as? [[String: Any]] ?? []).map(ClipSpec.init).filter { !$0.path.isEmpty }
        audio = (spec["audio"] as? [[String: Any]] ?? []).map(AudioSpec.init).filter { !$0.path.isEmpty }
        texts = (spec["texts"] as? [[String: Any]] ?? []).map(TextSpec.init).filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        aspect = str(spec, "aspect", "16:9")
        fit = str(spec, "fit", "fit")
        timing()
    }

    /// app.js 의 timing() 과 같은 계산
    mutating func timing() {
        let n = clips.count
        starts = Array(repeating: 0, count: n)
        trans = Array(repeating: 0, count: n)
        var t = 0.0
        for i in 0..<n {
            starts[i] = t
            if i + 1 < n, clips[i].transType != nil {
                trans[i] = min(clips[i].transDur, clips[i].dur / 2, clips[i + 1].dur / 2)
            }
            t += clips[i].dur - trans[i]
        }
        total = n > 0 ? starts[n - 1] + clips[n - 1].dur : 0
    }

    func end(_ i: Int) -> Double { starts[i] + clips[i].dur }

    /// 화면 비율과 프리셋에 맞는 결과 크기
    func renderSize(preset: String, fallbackShortSide: Int) -> CGSize {
        let short: Int
        var asp = aspect
        switch preset {
        case "4k": short = 2160
        case "small": short = 720
        case "vertical": short = 1080; asp = "9:16"
        case "original": short = max(240, min(2160, fallbackShortSide))
        case "gif": short = asp == "1:1" ? 360 : 270
        default: short = 1080
        }
        func even(_ v: Double) -> CGFloat { CGFloat(Int((v / 2).rounded()) * 2) }
        switch asp {
        case "9:16": return CGSize(width: even(Double(short)), height: even(Double(short) * 16 / 9))
        case "1:1": return CGSize(width: even(Double(short)), height: even(Double(short)))
        default: return CGSize(width: even(Double(short) * 16 / 9), height: even(Double(short)))
        }
    }
}

// MARK: - 그리기에 필요한 정보 (Compositor 가 장면마다 읽어요)

final class Layer {
    let trackID: CMPersistentTrackID
    let orientation: CGImagePropertyOrientation
    let userRotate: CGImagePropertyOrientation?
    let start: Double, end: Double, fadeIn: Double, fadeOut: Double, blur: Double
    init(trackID: CMPersistentTrackID, sourceRotation: Int, userRotation: Int, start: Double, end: Double, fadeIn: Double, fadeOut: Double, blur: Double) {
        self.trackID = trackID
        self.orientation = Layer.orient(sourceRotation) ?? .up
        self.userRotate = Layer.orient(userRotation)
        self.start = start; self.end = end; self.fadeIn = fadeIn; self.fadeOut = fadeOut; self.blur = blur
    }
    static func orient(_ deg: Int) -> CGImagePropertyOrientation? {
        switch deg {
        case 90: return .right
        case 180: return .down
        case 270: return .left
        default: return nil
        }
    }
    func fade(at t: Double) -> Double {
        var f = 1.0
        if fadeIn > 0, t < start + fadeIn { f = (t - start) / fadeIn }
        if fadeOut > 0, t > end - fadeOut { f = min(f, (end - t) / fadeOut) }
        return min(1, max(0, f))
    }
}

final class RenderShared {
    let renderSize: CGSize
    let fill: Bool
    let texts: [TextSpec]
    private var cache: [Int: CIImage] = [:]
    private let lock = NSLock()
    init(renderSize: CGSize, fill: Bool, texts: [TextSpec]) {
        self.renderSize = renderSize; self.fill = fill; self.texts = texts
    }
    func textImage(_ i: Int) -> CIImage? {
        lock.lock(); defer { lock.unlock() }
        if let c = cache[i] { return c }
        let img = TextArt.make(texts[i], renderSize: renderSize)
        if let img = img { cache[i] = img }
        return img
    }
}

final class Instruction: NSObject, AVVideoCompositionInstructionProtocol {
    let timeRange: CMTimeRange
    let enablePostProcessing: Bool = false
    let containsTweening: Bool = true
    let requiredSourceTrackIDs: [NSValue]?
    let passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid
    let layers: [Layer]
    let transition: String?
    let tStart: Double
    let tDur: Double
    let shared: RenderShared

    init(range: CMTimeRange, layers: [Layer], transition: String?, tStart: Double, tDur: Double, shared: RenderShared) {
        self.timeRange = range
        self.layers = layers
        self.transition = transition
        self.tStart = tStart
        self.tDur = tDur
        self.shared = shared
        self.requiredSourceTrackIDs = layers.map { NSNumber(value: $0.trackID) }
    }
}

final class Compositor: NSObject, AVVideoCompositing {
    let sourcePixelBufferAttributes: [String: Any]? = [
        kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_32BGRA],
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ]
    let requiredPixelBufferAttributesForRenderContext: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_32BGRA],
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ]
    private static let ci = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, .cacheIntermediates: false])
    private let queue = DispatchQueue(label: "cutroad.compositor")

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        queue.async {
            autoreleasepool {
                guard let ins = request.videoCompositionInstruction as? Instruction,
                      let out = request.renderContext.newPixelBuffer() else {
                    request.finish(with: RenderError("장면을 그리지 못했어요"))
                    return
                }
                let img = Compositor.frame(request, ins)
                let size = request.renderContext.size
                Compositor.ci.render(img, to: out, bounds: CGRect(origin: .zero, size: size), colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
                request.finish(withComposedVideoFrame: out)
            }
        }
    }

    func cancelAllPendingVideoCompositionRequests() {}

    static func frame(_ request: AVAsynchronousVideoCompositionRequest, _ ins: Instruction) -> CIImage {
        let R = request.renderContext.size
        let full = CGRect(origin: .zero, size: R)
        let black = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: full)
        let t = request.compositionTime.seconds

        func layerImage(_ L: Layer) -> CIImage {
            guard let pb = request.sourceFrame(byTrackID: L.trackID) else { return black }
            var img = CIImage(cvPixelBuffer: pb).oriented(L.orientation)
            if let r = L.userRotate { img = img.oriented(r) }
            img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
            let w = img.extent.width, h = img.extent.height
            guard w > 0, h > 0 else { return black }
            let s = ins.shared.fill ? max(R.width / w, R.height / h) : min(R.width / w, R.height / h)
            let nw = w * s, nh = h * s
            img = img.transformed(by: CGAffineTransform(scaleX: s, y: s))
                .transformed(by: CGAffineTransform(translationX: (R.width - nw) / 2, y: (R.height - nh) / 2))
            let rect = CGRect(x: (R.width - nw) / 2, y: (R.height - nh) / 2, width: nw, height: nh).intersection(full)
            if L.blur > 0.01 {
                let sigma = L.blur * Double(min(R.width, R.height)) / 1080.0
                img = img.clampedToExtent().applyingGaussianBlur(sigma: sigma).cropped(to: rect)
            } else {
                img = img.cropped(to: rect)
            }
            let f = CGFloat(L.fade(at: t))
            if f < 0.999 {
                img = img.applyingFilter("CIColorMatrix", parameters: [
                    "inputRVector": CIVector(x: f, y: 0, z: 0, w: 0),
                    "inputGVector": CIVector(x: 0, y: f, z: 0, w: 0),
                    "inputBVector": CIVector(x: 0, y: 0, z: f, w: 0),
                ])
            }
            return img.composited(over: black)
        }

        var out = black
        if ins.layers.count >= 2, let tr = ins.transition {
            let a = layerImage(ins.layers[0])
            let b = layerImage(ins.layers[1])
            let p = CGFloat(min(1, max(0, ins.tDur > 0 ? (t - ins.tStart) / ins.tDur : 1)))
            switch tr {
            case "fadeblack":
                let f = p < 0.5 ? 1 - p * 2 : p * 2 - 1
                let src = p < 0.5 ? a : b
                out = src.applyingFilter("CIColorMatrix", parameters: [
                    "inputRVector": CIVector(x: f, y: 0, z: 0, w: 0),
                    "inputGVector": CIVector(x: 0, y: f, z: 0, w: 0),
                    "inputBVector": CIVector(x: 0, y: 0, z: f, w: 0),
                ])
            case "wipe":
                out = b.cropped(to: CGRect(x: 0, y: 0, width: R.width * p, height: R.height)).composited(over: a)
            case "slide":
                let movedA = a.transformed(by: CGAffineTransform(translationX: -R.width * p, y: 0))
                let movedB = b.transformed(by: CGAffineTransform(translationX: R.width * (1 - p), y: 0))
                out = movedB.composited(over: movedA).composited(over: black)
            default: // dissolve
                out = b.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: p)]).composited(over: a)
            }
        } else if let L = ins.layers.first {
            out = layerImage(L)
        }
        for (i, x) in ins.shared.texts.enumerated() where t >= x.start && t < x.end {
            if let img = ins.shared.textImage(i) { out = img.composited(over: out) }
        }
        return out.cropped(to: full)
    }
}

// MARK: - 글자 (제목 · 자막)

enum TextArt {
    /// app.js 의 미리보기 글자와 같은 비율: 짧은 변의 4.5% · 6% · 8.5%, 아래/위 여백은 높이의 7%
    static func fontSize(_ size: String, _ R: CGSize) -> CGFloat {
        let base = min(R.width, R.height)
        let k: CGFloat = size == "s" ? 0.045 : (size == "l" ? 0.085 : 0.06)
        return max(10, base * k)
    }

    static func make(_ x: TextSpec, renderSize R: CGSize) -> CIImage? {
        let fs = fontSize(x.size, R)
        let font = CTFontCreateWithName("AppleSDGothicNeo-Bold" as CFString, fs, nil)
        let attrs: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: CGColor(gray: 1, alpha: 1)]
        guard let attr = CFAttributedStringCreate(nil, x.text as CFString, attrs as CFDictionary) else { return nil }
        let ts = CTTypesetterCreateWithAttributedString(attr)
        let len = CFAttributedStringGetLength(attr)
        let maxW = Double(R.width * 0.86)
        var lines: [CTLine] = []
        var widths: [CGFloat] = []
        var start = 0
        while start < len && lines.count < 6 {
            let cnt = CTTypesetterSuggestLineBreak(ts, start, maxW)
            if cnt <= 0 { break }
            let line = CTTypesetterCreateLine(ts, CFRange(location: start, length: cnt))
            let w = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth(line))
            lines.append(line)
            widths.append(max(0, w))
            start += cnt
        }
        guard !lines.isEmpty else { return nil }
        let ascent = CTFontGetAscent(font), descent = CTFontGetDescent(font)
        let lineH = (ascent + descent) * 1.18
        let textW = widths.max() ?? 0
        let textH = lineH * CGFloat(lines.count) - (lineH - (ascent + descent))
        let padX = x.box ? fs * 0.5 : fs * 0.3
        let padY = x.box ? fs * 0.28 : fs * 0.2
        let iw = Int((textW + padX * 2).rounded(.up)), ih = Int((textH + padY * 2).rounded(.up))
        guard iw > 0, ih > 0, let ctx = CGContext(data: nil, width: iw, height: ih, bitsPerComponent: 8, bytesPerRow: 0,
                                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        if x.box {
            ctx.setFillColor(CGColor(gray: 0, alpha: 0.62))
            ctx.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: iw, height: ih), cornerWidth: fs * 0.28, cornerHeight: fs * 0.28, transform: nil))
            ctx.fillPath()
        } else {
            ctx.setShadow(offset: CGSize(width: 0, height: -fs * 0.05), blur: fs * 0.3, color: CGColor(gray: 0, alpha: 0.9))
        }
        for (i, line) in lines.enumerated() {
            let y = CGFloat(ih) - padY - ascent - CGFloat(i) * lineH
            ctx.textPosition = CGPoint(x: (CGFloat(iw) - widths[i]) / 2, y: y)
            CTLineDraw(line, ctx)
        }
        guard let cg = ctx.makeImage() else { return nil }
        let margin = R.height * 0.07
        let x0 = ((R.width - CGFloat(iw)) / 2).rounded()
        let y0: CGFloat
        switch x.pos {
        case "top": y0 = R.height - CGFloat(ih) - margin
        case "center": y0 = (R.height - CGFloat(ih)) / 2
        default: y0 = margin
        }
        return CIImage(cgImage: cg).transformed(by: CGAffineTransform(translationX: x0, y: y0.rounded()))
    }
}

// MARK: - 조립

final class Built {
    let composition: AVMutableComposition
    let videoComposition: AVMutableVideoComposition?
    let audioMix: AVMutableAudioMix?
    let renderSize: CGSize
    let fps: Int
    let duration: Double
    init(composition: AVMutableComposition, videoComposition: AVMutableVideoComposition?, audioMix: AVMutableAudioMix?, renderSize: CGSize, fps: Int, duration: Double) {
        self.composition = composition; self.videoComposition = videoComposition; self.audioMix = audioMix
        self.renderSize = renderSize; self.fps = fps; self.duration = duration
    }
    var hasAudio: Bool { !composition.tracks(withMediaType: .audio).isEmpty }
}

enum Builder {
    /// 트랙 끝이 `at` 보다 뒤라면(반올림 오차) 잘라내고, 앞이라면 빈 구간을 넣어서 정확히 `at` 에 붙여요
    static func place(_ track: AVMutableCompositionTrack, at: CMTime) {
        let end = track.timeRange.end
        if track.segments.isEmpty {
            if at > .zero { track.insertEmptyTimeRange(CMTimeRange(start: .zero, end: at)) }
            return
        }
        if end > at {
            track.removeTimeRange(CMTimeRange(start: at, end: end))
        } else if end < at {
            track.insertEmptyTimeRange(CMTimeRange(start: end, end: at))
        }
    }

    static func insert(_ track: AVMutableCompositionTrack, from src: AVAssetTrack, inT: Double, outT: Double, at: Double, dur: Double) throws {
        let srcDur = src.timeRange.end.seconds
        let a = min(inT, max(0, srcDur - 0.05))
        let b = min(outT, srcDur)
        guard b > a else { return }
        let range = CMTimeRange(start: ct(a), end: ct(b))
        place(track, at: ct(at))
        try track.insertTimeRange(range, of: src, at: ct(at))
        let target = ct(dur * (b - a) / (outT - inT))
        if abs(range.duration.seconds - target.seconds) > 0.0005 {
            track.scaleTimeRange(CMTimeRange(start: ct(at), duration: range.duration), toDuration: target)
        }
    }

    /// videoOnly=false · audioOnlyClips=true 는 자동 자막용(클립 소리만)
    static func build(_ plan: Plan, preset: String, includeVideo: Bool = true, includeBGM: Bool = true) throws -> Built {
        guard !plan.clips.isEmpty else { throw RenderError("타임라인에 영상이 없어요") }
        let comp = AVMutableComposition()
        var assets: [String: AVURLAsset] = [:]
        func asset(_ p: String) throws -> AVURLAsset {
            if let a = assets[p] { return a }
            guard FileManager.default.fileExists(atPath: p) else {
                throw RenderError("파일을 찾을 수 없어요: \(URL(fileURLWithPath: p).lastPathComponent)")
            }
            let a = Media.asset(p)
            assets[p] = a
            return a
        }

        var vTracks: [AVMutableCompositionTrack] = []
        var aTracks: [AVMutableCompositionTrack] = []
        func vTrack(_ i: Int) -> AVMutableCompositionTrack {
            while vTracks.count <= i % 2 { vTracks.append(comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!) }
            return vTracks[i % 2]
        }
        func aTrack(_ i: Int) -> AVMutableCompositionTrack {
            while aTracks.count <= i % 2 { aTracks.append(comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!) }
            return aTracks[i % 2]
        }

        var layers: [Layer] = []
        var fps = 30
        var shortSide = 1080
        var clipAudioOn: [Int: Bool] = [:]
        for (i, c) in plan.clips.enumerated() {
            let a = try asset(c.path)
            guard let sv = a.tracks(withMediaType: .video).first else {
                throw RenderError("영상이 없는 파일이에요: \(URL(fileURLWithPath: c.path).lastPathComponent)")
            }
            if i == 0 {
                let f = Int(sv.nominalFrameRate.rounded())
                fps = [24, 25, 30, 50, 60].min(by: { abs($0 - f) < abs($1 - f) }) ?? 30
                if f <= 0 { fps = 30 }
                let s = Media.orientedSize(sv)
                shortSide = Int(min(s.width, s.height))
            }
            if includeVideo {
                let vt = vTrack(i)
                try insert(vt, from: sv, inT: c.inT, outT: c.outT, at: plan.starts[i], dur: c.dur)
                layers.append(Layer(trackID: vt.trackID, sourceRotation: Media.rotation(sv.preferredTransform), userRotation: c.rotate,
                                    start: plan.starts[i], end: plan.end(i), fadeIn: c.fadeIn, fadeOut: c.fadeOut, blur: c.blur))
            }
            if c.volume > 0, let sa = a.tracks(withMediaType: .audio).first {
                try insert(aTrack(i), from: sa, inT: c.inT, outT: c.outT, at: plan.starts[i], dur: c.dur)
                clipAudioOn[i] = true
            }
        }

        // 배경음악: 겹치는 곡은 다른 줄에
        var bTracks: [(AVMutableCompositionTrack, Double)] = []
        var bgmParams: [AVMutableAudioMixInputParameters] = []
        var bgmPlans: [(AVMutableCompositionTrack, AudioSpec, Double, Double)] = []
        if includeBGM {
            for x in plan.audio.sorted(by: { $0.start < $1.start }) {
                guard x.start < plan.total - 0.05 else { continue }
                let a = try asset(x.path)
                guard let sa = a.tracks(withMediaType: .audio).first else { continue }
                let outT = min(x.outT, x.inT + (plan.total - x.start))
                guard outT > x.inT + 0.05 else { continue }
                let idx = bTracks.firstIndex(where: { $0.1 <= x.start + 0.0001 })
                let tr: AVMutableCompositionTrack
                if let k = idx { tr = bTracks[k].0 } else {
                    tr = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
                    bTracks.append((tr, 0))
                }
                try insert(tr, from: sa, inT: x.inT, outT: outT, at: x.start, dur: outT - x.inT)
                let k = idx ?? bTracks.count - 1
                bTracks[k].1 = x.start + (outT - x.inT)
                bgmPlans.append((tr, x, x.start, x.start + (outT - x.inT)))
            }
        }

        // 소리: 볼륨 · 페이드 · 트랜지션 동안 크로스페이드
        var params: [CMPersistentTrackID: AVMutableAudioMixInputParameters] = [:]
        func p(_ tr: AVMutableCompositionTrack) -> AVMutableAudioMixInputParameters {
            if let x = params[tr.trackID] { return x }
            let x = AVMutableAudioMixInputParameters(track: tr)
            x.audioTimePitchAlgorithm = .spectral
            params[tr.trackID] = x
            return x
        }
        func envelope(_ pr: AVMutableAudioMixInputParameters, s: Double, e: Double, vol: Double, inR: Double, outR: Double) {
            let d = e - s
            var a = max(0, inR), b = max(0, outR)
            if a + b > d { let k = d / (a + b); a *= k; b *= k }
            let v = Float(vol)
            if a > 0.001 {
                pr.setVolumeRamp(fromStartVolume: 0, toEndVolume: v, timeRange: CMTimeRange(start: ct(s), end: ct(s + a)))
            } else {
                pr.setVolume(v, at: ct(s))
            }
            if b > 0.001 {
                pr.setVolumeRamp(fromStartVolume: v, toEndVolume: 0, timeRange: CMTimeRange(start: ct(e - b), end: ct(e)))
            }
        }
        for (i, c) in plan.clips.enumerated() where clipAudioOn[i] == true {
            let prevT = i > 0 ? plan.trans[i - 1] : 0
            envelope(p(aTrack(i)), s: plan.starts[i], e: plan.end(i), vol: c.volume,
                     inR: max(c.fadeIn, prevT), outR: max(c.fadeOut, plan.trans[i]))
        }
        for (tr, x, s, e) in bgmPlans {
            envelope(p(tr), s: s, e: e, vol: x.volume, inR: x.fadeIn, outR: x.fadeOut)
        }
        bgmParams = Array(params.values)
        let mix: AVMutableAudioMix? = bgmParams.isEmpty ? nil : {
            let m = AVMutableAudioMix()
            m.inputParameters = bgmParams
            return m
        }()

        let renderSize = plan.renderSize(preset: preset, fallbackShortSide: shortSide)
        var vc: AVMutableVideoComposition?
        if includeVideo {
            let shared = RenderShared(renderSize: renderSize, fill: plan.fit == "fill" || preset == "vertical", texts: plan.texts)
            var ins: [Instruction] = []
            let compEnd = comp.duration
            func add(_ s: Double, _ e: Double, _ ls: [Layer], _ tr: String?, _ ts: Double, _ td: Double) {
                let a = ct(s)
                var b = ct(e)
                if b > compEnd { b = compEnd }
                guard b > a else { return }
                ins.append(Instruction(range: CMTimeRange(start: a, end: b), layers: ls, transition: tr, tStart: ts, tDur: td, shared: shared))
            }
            for i in 0..<plan.clips.count {
                let soloS = plan.starts[i] + (i > 0 ? plan.trans[i - 1] : 0)
                let soloE = plan.end(i) - plan.trans[i]
                add(soloS, soloE, [layers[i]], nil, 0, 0)
                if plan.trans[i] > 0, i + 1 < plan.clips.count {
                    add(soloE, plan.end(i), [layers[i], layers[i + 1]], plan.clips[i].transType, soloE, plan.trans[i])
                }
            }
            // 마지막 장면이 컴포지션 끝까지 닿게 (반올림 오차)
            if let last = ins.last, last.timeRange.end < compEnd {
                ins[ins.count - 1] = Instruction(range: CMTimeRange(start: last.timeRange.start, end: compEnd), layers: last.layers,
                                                 transition: last.transition, tStart: last.tStart, tDur: last.tDur, shared: shared)
            }
            let v = AVMutableVideoComposition()
            v.customVideoCompositorClass = Compositor.self
            v.renderSize = renderSize
            v.frameDuration = CMTime(value: 1, timescale: CMTimeScale(preset == "gif" ? 12 : fps))
            v.instructions = ins
            vc = v
        }
        return Built(composition: comp, videoComposition: vc, audioMix: mix, renderSize: renderSize,
                     fps: preset == "gif" ? 12 : fps, duration: min(plan.total, comp.duration.seconds))
    }
}
