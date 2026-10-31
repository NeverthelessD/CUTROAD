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
    let kind: String          // video | image
    let inT: Double
    let outT: Double
    let speed: Double
    let volume: Double
    let fadeIn: Double
    let fadeOut: Double
    let blur: Double
    let rotate: Int
    let motion: String        // Effects.motion
    let filter: String        // Effects.filters
    let w: Double, h: Double  // 사진 크기 (방향 반영)
    let transType: String?
    let transDur: Double
    var dur: Double { (outT - inT) / speed }
    var isImage: Bool { kind == "image" }

    init(_ d: [String: Any]) {
        path = str(d, "path", "")
        kind = str(d, "kind", "video")
        inT = max(0, num(d, "in", 0))
        outT = max(inT + 0.05, num(d, "out", inT + 1))
        speed = kind == "image" ? 1 : min(4, max(0.25, num(d, "speed", 1)))
        volume = min(1, max(0, num(d, "volume", 1)))
        fadeIn = max(0, num(d, "fadeIn", 0))
        fadeOut = max(0, num(d, "fadeOut", 0))
        blur = max(0, num(d, "blur", 0))
        rotate = ((Int(num(d, "rotate", 0)) % 360) + 360) % 360
        motion = str(d, "motion", "none")
        filter = str(d, "filter", "none")
        w = num(d, "w", 0); h = num(d, "h", 0)
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
    let pos: String           // top | center | bottom | br(오른쪽 아래 구석)
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

/// 박자 효과 (타임라인 시각 기준) — app.js 의 CR.beatFxAt() 과 같은 계산
struct BeatFx {
    var pulse = false, flash = false, shake = false
    var beats: [Double] = [], flashes: [Double] = [], climax: [[Double]] = []
    init() {}
    init(_ d: [String: Any]?) {
        guard let d = d else { return }
        pulse = (d["pulse"] as? Bool) ?? false
        flash = (d["flash"] as? Bool) ?? false
        shake = (d["shake"] as? Bool) ?? false
        beats = (d["beats"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.doubleValue }.sorted()
        flashes = (d["flashes"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.doubleValue }.sorted()
        climax = (d["climax"] as? [[Any]] ?? []).map { $0.compactMap { ($0 as? NSNumber)?.doubleValue } }.filter { $0.count == 2 }
    }
    var any: Bool { (pulse || shake) && !beats.isEmpty || flash && !flashes.isEmpty }
    static func last(_ a: [Double], _ t: Double) -> Double? {
        var lo = 0, hi = a.count - 1, r = -1
        while lo <= hi { let m = (lo + hi) / 2; if a[m] <= t { r = m; lo = m + 1 } else { hi = m - 1 } }
        return r >= 0 ? a[r] : nil
    }
    /// (크기, 가로 이동, 세로 이동(아래 +), 흰색 번쩍 0~1) — 이동은 화면 너비에 대한 비율
    func at(_ t: Double) -> (s: Double, dx: Double, dy: Double, white: Double) {
        var s = 1.0, dx = 0.0, dy = 0.0, white = 0.0
        if let b = BeatFx.last(beats, t) {
            let e = t - b
            if pulse && e < 0.5 { s = 1 + 0.035 * exp(-e / 0.12) }
            if shake && e < 0.6 && climax.contains(where: { t >= $0[0] && t < $0[1] }) {
                let a = 0.012 * exp(-e / 0.25)
                dx = a * sin(2 * .pi * 7 * t)
                dy = 0.6 * a * cos(2 * .pi * 9 * t)
            }
        }
        if flash, let f = BeatFx.last(flashes, t), t - f < 0.45 { white = 0.45 * exp(-(t - f) / 0.09) }
        return (s, dx, dy, white)
    }
}

/// 움직임 · 색감 (app.js 의 CR.MOTION · CR.FILTERS 와 같은 값)
enum Effects {
    /// 사진 한 장이 보이는 동안 p(0→1) 에 따라: 크기 · 가로/세로 이동(화면 너비/높이 비율, 아래 +) · 기울기(시계 방향 °)
    static func motion(_ m: String, _ p: Double) -> (s: Double, dx: Double, dy: Double, rot: Double) {
        switch m {
        case "zoomIn": return (1 + 0.12 * p, 0, 0, 0)
        case "zoomOut": return (1.12 - 0.12 * p, 0, 0, 0)
        case "panL": return (1.12, 0.05 - 0.10 * p, 0, 0)
        case "panR": return (1.12, -0.05 + 0.10 * p, 0, 0)
        case "up": return (1.12, 0, -0.04 + 0.08 * p, 0)
        case "down": return (1.12, 0, 0.04 - 0.08 * p, 0)
        case "tilt": return (1.1 + 0.08 * p, 0, 0, -3 + 3 * p)
        default: return (1, 0, 0, 0)
        }
    }

    /// CSS filter 함수와 같은 순서 · 같은 값 (화면 미리보기와 결과가 같게)
    static let filters: [String: [(String, Double)]] = [
        "warm": [("sepia", 0.25), ("saturate", 1.3), ("hue", -8)],
        "cool": [("saturate", 1.1), ("hue", 18), ("brightness", 1.05)],
        "vivid": [("saturate", 1.7), ("contrast", 1.15)],
        "mono": [("grayscale", 1), ("contrast", 1.2)],
        "vintage": [("sepia", 0.75), ("contrast", 0.9), ("brightness", 1.05)],
        "film": [("contrast", 1.15), ("saturate", 0.75), ("sepia", 0.2)],
        "faded": [("contrast", 0.8), ("brightness", 1.12), ("saturate", 0.65)],
    ]

    /// 3×3 + 더하기 (CSS Filter Effects 명세의 색 행렬)
    struct M {
        var m: [Double] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
        var b: [Double] = [0, 0, 0]
    }

    static func op(_ name: String, _ a: Double) -> M {
        var x = M()
        switch name {
        case "grayscale":
            let s = 1 - min(1, a)
            x.m = [0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s,
                   0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s,
                   0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s]
        case "sepia":
            let s = 1 - min(1, a)
            x.m = [0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s,
                   0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s,
                   0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s]
        case "saturate":
            let s = a
            x.m = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
                   0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
                   0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]
        case "hue":
            let r: Double = a * Double.pi / 180
            let c: Double = cos(r), s: Double = sin(r)
            let m0: Double = 0.213 + c * 0.787 - s * 0.213
            let m1: Double = 0.715 - c * 0.715 - s * 0.715
            let m2: Double = 0.072 - c * 0.072 + s * 0.928
            let m3: Double = 0.213 - c * 0.213 + s * 0.143
            let m4: Double = 0.715 + c * 0.285 + s * 0.140
            let m5: Double = 0.072 - c * 0.072 - s * 0.283
            let m6: Double = 0.213 - c * 0.213 - s * 0.787
            let m7: Double = 0.715 - c * 0.715 + s * 0.715
            let m8: Double = 0.072 + c * 0.928 + s * 0.072
            x.m = [m0, m1, m2, m3, m4, m5, m6, m7, m8]
        case "brightness":
            x.m = [a, 0, 0, 0, a, 0, 0, 0, a]
        case "contrast":
            x.m = [a, 0, 0, 0, a, 0, 0, 0, a]
            x.b = [0.5 - 0.5 * a, 0.5 - 0.5 * a, 0.5 - 0.5 * a]
        default: break
        }
        return x
    }

    static func apply(_ img: CIImage, ops: [(String, Double)]) -> CIImage {
        if ops.isEmpty { return img }
        var out = img
        // CSS 는 단계마다 0~1 로 자르므로 같은 방식으로
        for (name, a) in ops {
            let x = op(name, a)
            out = out.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: CGFloat(x.m[0]), y: CGFloat(x.m[1]), z: CGFloat(x.m[2]), w: 0),
                "inputGVector": CIVector(x: CGFloat(x.m[3]), y: CGFloat(x.m[4]), z: CGFloat(x.m[5]), w: 0),
                "inputBVector": CIVector(x: CGFloat(x.m[6]), y: CGFloat(x.m[7]), z: CGFloat(x.m[8]), w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                "inputBiasVector": CIVector(x: CGFloat(x.b[0]), y: CGFloat(x.b[1]), z: CGFloat(x.b[2]), w: 0),
            ]).applyingFilter("CIColorClamp")
        }
        return out
    }

    static func brightness(_ img: CIImage, _ f: CGFloat) -> CIImage {
        img.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: f, y: 0, z: 0, w: 0),
            "inputGVector": CIVector(x: 0, y: f, z: 0, w: 0),
            "inputBVector": CIVector(x: 0, y: 0, z: f, w: 0),
        ])
    }

    static func alpha(_ img: CIImage, _ a: CGFloat) -> CIImage {
        img.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: a)])
    }

    /// 필름 색감의 어두운 가장자리 (CSS: radial-gradient(circle farthest-corner, transparent 45%, rgba(0,0,0,.6)))
    static func vignette(_ R: CGSize) -> CIImage {
        let half = sqrt(R.width * R.width + R.height * R.height) / 2
        return CIFilter(name: "CIRadialGradient", parameters: [
            "inputCenter": CIVector(x: R.width / 2, y: R.height / 2),
            "inputRadius0": half * 0.45, "inputRadius1": half,
            "inputColor0": CIColor(red: 0, green: 0, blue: 0, alpha: 0),
            "inputColor1": CIColor(red: 0, green: 0, blue: 0, alpha: 0.6),
        ])!.outputImage!.cropped(to: CGRect(origin: .zero, size: R))
    }

    /// 화면 가운데를 기준으로 크기 · 기울기 · 이동 (CSS: translate(dx, dy) rotate(rot) scale(s), 원점 = 가운데)
    static func around(_ R: CGSize, s: Double, rotDeg: Double, dxPx: Double, dyPxDown: Double) -> CGAffineTransform {
        let cx = R.width / 2, cy = R.height / 2
        return CGAffineTransform(translationX: -cx, y: -cy)
            .concatenating(CGAffineTransform(scaleX: CGFloat(s), y: CGFloat(s)))
            .concatenating(CGAffineTransform(rotationAngle: CGFloat(-rotDeg * .pi / 180)))
            .concatenating(CGAffineTransform(translationX: cx + CGFloat(dxPx), y: cy - CGFloat(dyPxDown)))
    }
}

/// 프로젝트 내용 + 시간 계산
struct Plan {
    var clips: [ClipSpec]
    var audio: [AudioSpec]
    var texts: [TextSpec]
    var aspect: String
    var fit: String
    var bgBlur: Bool          // 사진 뒤 흐린 배경
    var photoFrame: Bool      // 사진 흰 액자
    var beatFx: BeatFx
    var starts: [Double] = []
    var trans: [Double] = []   // trans[i] = 클립 i 와 i+1 사이 트랜지션 길이
    var total: Double = 0

    init(_ spec: [String: Any]) {
        clips = (spec["clips"] as? [[String: Any]] ?? []).map(ClipSpec.init).filter { !$0.path.isEmpty }
        audio = (spec["audio"] as? [[String: Any]] ?? []).map(AudioSpec.init).filter { !$0.path.isEmpty }
        texts = (spec["texts"] as? [[String: Any]] ?? []).map(TextSpec.init).filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        aspect = str(spec, "aspect", "16:9")
        fit = str(spec, "fit", "fit")
        bgBlur = (spec["bgBlur"] as? Bool) ?? false
        photoFrame = (spec["photoFrame"] as? Bool) ?? false
        beatFx = BeatFx(spec["beatFx"] as? [String: Any])
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
    let imagePath: String?     // 사진 클립이면 사진 파일
    let motion: String
    let filter: String
    init(trackID: CMPersistentTrackID, sourceRotation: Int, userRotation: Int, start: Double, end: Double,
         fadeIn: Double, fadeOut: Double, blur: Double, imagePath: String?, motion: String, filter: String) {
        self.trackID = trackID
        self.orientation = Layer.orient(sourceRotation) ?? .up
        self.userRotate = Layer.orient(userRotation)
        self.start = start; self.end = end; self.fadeIn = fadeIn; self.fadeOut = fadeOut; self.blur = blur
        self.imagePath = imagePath; self.motion = motion; self.filter = filter
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
    func progress(_ t: Double) -> Double { end > start ? min(1, max(0, (t - start) / (end - start))) : 0 }
}

final class RenderShared {
    let renderSize: CGSize
    let fill: Bool
    let bgBlur: Bool
    let photoFrame: Bool
    let texts: [TextSpec]
    let beatFx: BeatFx
    private var cache: [Int: CIImage] = [:]
    private var images: [String: CIImage] = [:]
    private let lock = NSLock()
    init(renderSize: CGSize, fill: Bool, bgBlur: Bool, photoFrame: Bool, texts: [TextSpec], beatFx: BeatFx) {
        self.renderSize = renderSize; self.fill = fill; self.bgBlur = bgBlur; self.photoFrame = photoFrame
        self.texts = texts; self.beatFx = beatFx
    }
    func textImage(_ i: Int) -> CIImage? {
        lock.lock(); defer { lock.unlock() }
        if let c = cache[i] { return c }
        let img = TextArt.make(texts[i], renderSize: renderSize)
        if let img = img { cache[i] = img }
        return img
    }
    /// 사진은 결과 크기에 알맞게 줄여서 한 번만 읽어요 (사진이 아주 커도 빠르게)
    func image(_ path: String) -> CIImage? {
        lock.lock(); defer { lock.unlock() }
        if let c = images[path] { return c }
        let side = Int(max(renderSize.width, renderSize.height) * 1.3)
        guard let cg = Photos.cgImage(path, maxSide: side) else { return nil }
        let img = CIImage(cgImage: cg)
        if images.count > 6 { images.removeAll() }   // 메모리를 아끼려고 조금만 기억해요
        images[path] = img
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

    /// 한 장면: 클립(들) → 트랜지션 → 박자 효과 → 글자.  app.js 의 Player.draw() 와 같은 순서 · 같은 값
    static func frame(_ request: AVAsynchronousVideoCompositionRequest, _ ins: Instruction) -> CIImage {
        let R = request.renderContext.size
        let full = CGRect(origin: .zero, size: R)
        let black = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: full)
        let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: full)
        let t = request.compositionTime.seconds
        let sh = ins.shared
        let minSide = Double(min(R.width, R.height))

        func layerImage(_ L: Layer) -> CIImage {
            var img: CIImage
            let isImage = L.imagePath != nil
            if let p = L.imagePath {
                guard let im = sh.image(p) else { return black }
                img = im
            } else {
                guard let pb = request.sourceFrame(byTrackID: L.trackID) else { return black }
                img = CIImage(cvPixelBuffer: pb).oriented(L.orientation)
            }
            if let r = L.userRotate { img = img.oriented(r) }
            img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
            let w = img.extent.width, h = img.extent.height
            guard w > 0, h > 0 else { return black }
            let framed = isImage && sh.photoFrame
            let k: CGFloat = framed ? 0.86 : 1
            let s = (sh.fill ? max(R.width / w, R.height / h) : min(R.width / w, R.height / h)) * k
            let nw = w * s, nh = h * s
            let x0 = (R.width - nw) / 2, y0 = (R.height - nh) / 2
            var content = img.transformed(by: CGAffineTransform(scaleX: s, y: s).concatenating(CGAffineTransform(translationX: x0, y: y0)))
                .cropped(to: CGRect(x: x0, y: y0, width: nw, height: nh))
            if framed {
                let b = CGFloat(0.012 * minSide)
                let border = white.cropped(to: CGRect(x: x0 - b, y: y0 - b, width: nw + 2 * b, height: nh + 2 * b))
                content = content.composited(over: border)
            }
            let mo = Effects.motion(L.motion, L.progress(t))
            if mo.s != 1 || mo.dx != 0 || mo.dy != 0 || mo.rot != 0 {
                content = content.transformed(by: Effects.around(R, s: mo.s, rotDeg: mo.rot, dxPx: mo.dx * Double(R.width), dyPxDown: mo.dy * Double(R.height)))
            }
            var layer = content
            // 사진이 화면을 다 채우지 못하면 뒤를 같은 사진을 흐리게 키워서 채워요
            if isImage && sh.bgBlur && !sh.fill {
                let cs = max(R.width / w, R.height / h) * 1.1
                let bg = img.transformed(by: CGAffineTransform(scaleX: cs, y: cs)
                    .concatenating(CGAffineTransform(translationX: (R.width - w * cs) / 2, y: (R.height - h * cs) / 2)))
                    .clampedToExtent().applyingGaussianBlur(sigma: 0.04 * minSide).cropped(to: full)
                layer = content.composited(over: Effects.brightness(bg, 0.75))
            }
            layer = layer.cropped(to: full)
            if L.blur > 0.01 {
                let rect = layer.extent
                layer = layer.clampedToExtent().applyingGaussianBlur(sigma: L.blur * minSide / 1080.0).cropped(to: rect)
            }
            if let ops = Effects.filters[L.filter] { layer = Effects.apply(layer, ops: ops) }
            if L.filter == "film" { layer = Effects.vignette(R).composited(over: layer) }
            let f = CGFloat(L.fade(at: t))
            if f < 0.999 { layer = Effects.brightness(layer, f) }
            return layer.composited(over: black)
        }

        var out = black
        if ins.layers.count >= 2, let tr = ins.transition {
            let a = layerImage(ins.layers[0])
            let b = layerImage(ins.layers[1])
            let p = CGFloat(min(1, max(0, ins.tDur > 0 ? (t - ins.tStart) / ins.tDur : 1)))
            let cx = R.width / 2, cy = R.height / 2
            func scaled(_ im: CIImage, _ s: CGFloat, rot: CGFloat = 0) -> CIImage {
                im.transformed(by: CGAffineTransform(translationX: -cx, y: -cy)
                    .concatenating(CGAffineTransform(scaleX: s, y: s))
                    .concatenating(CGAffineTransform(rotationAngle: rot))
                    .concatenating(CGAffineTransform(translationX: cx, y: cy)))
            }
            switch tr {
            case "fadeblack":
                out = p < 0.5 ? Effects.brightness(a, 1 - p * 2) : Effects.brightness(b, p * 2 - 1)
            case "flash":
                out = p < 0.5 ? Effects.alpha(white, p * 2).composited(over: a) : Effects.alpha(white, (1 - p) * 2).composited(over: b)
            case "wipe":
                out = b.cropped(to: CGRect(x: 0, y: 0, width: R.width * p, height: R.height)).composited(over: a)
            case "slide":
                let movedA = a.transformed(by: CGAffineTransform(translationX: -R.width * p, y: 0))
                let movedB = b.transformed(by: CGAffineTransform(translationX: R.width * (1 - p), y: 0))
                out = movedB.composited(over: movedA)
            case "circle":
                let r = p * sqrt(R.width * R.width + R.height * R.height) / 2
                let mask = CIFilter(name: "CIRadialGradient", parameters: [
                    "inputCenter": CIVector(x: cx, y: cy), "inputRadius0": r, "inputRadius1": r + 1,
                    "inputColor0": CIColor(red: 1, green: 1, blue: 1), "inputColor1": CIColor(red: 0, green: 0, blue: 0),
                ])!.outputImage!.cropped(to: full)
                out = b.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: a, kCIInputMaskImageKey: mask])
            case "zoom":
                out = Effects.alpha(scaled(b, 1.3 - 0.3 * p), p).composited(over: scaled(a, 1 + 0.5 * p))
            case "spin":
                out = Effects.alpha(scaled(b, 0.6 + 0.4 * p, rot: 30 * (1 - p) * .pi / 180), p).composited(over: a)
            case "blur":
                let mb = 0.03 * minSide
                let ba = p > 0.001 ? a.clampedToExtent().applyingGaussianBlur(sigma: mb * Double(p)).cropped(to: full) : a
                let bb = p < 0.999 ? b.clampedToExtent().applyingGaussianBlur(sigma: mb * Double(1 - p)).cropped(to: full) : b
                out = Effects.alpha(bb, p).composited(over: ba)
            case "blinds":
                let sw = R.width / 10
                var mask = black
                for k in 0..<10 {
                    mask = white.cropped(to: CGRect(x: CGFloat(k) * sw, y: 0, width: sw * p, height: R.height)).composited(over: mask)
                }
                out = b.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: a, kCIInputMaskImageKey: mask])
            default: // dissolve
                out = Effects.alpha(b, p).composited(over: a)
            }
            out = out.cropped(to: full).composited(over: black)
        } else if let L = ins.layers.first {
            out = layerImage(L)
        }
        // 박자 효과: 펄스(살짝 커짐) · 흔들림 · 번쩍
        if sh.beatFx.any {
            let fx = sh.beatFx.at(t)
            if fx.s != 1 || fx.dx != 0 || fx.dy != 0 {
                out = out.transformed(by: Effects.around(R, s: fx.s, rotDeg: 0, dxPx: fx.dx * Double(R.width), dyPxDown: fx.dy * Double(R.width)))
                    .cropped(to: full).composited(over: black)
            }
            if fx.white > 0.001 { out = Effects.alpha(white, CGFloat(fx.white)).composited(over: out) }
        }
        for (i, x) in sh.texts.enumerated() where t >= x.start && t < x.end {
            if let img = sh.textImage(i) { out = img.composited(over: out) }
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
        var x0 = ((R.width - CGFloat(iw)) / 2).rounded()
        let y0: CGFloat
        switch x.pos {
        case "top": y0 = R.height - CGFloat(ih) - margin
        case "center": y0 = (R.height - CGFloat(ih)) / 2
        case "br": y0 = margin * 0.6; x0 = (R.width - CGFloat(iw) - R.width * 0.04).rounded()
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
    /// 사진 클립 밑에 까는 검은 바탕 영상 (64×64, 10초) — 처음 한 번 만들어서 cache 에 둬요
    static let baseLock = NSLock()
    static var baseAsset: AVURLAsset?
    static func baseTrack() throws -> AVAssetTrack {
        baseLock.lock(); defer { baseLock.unlock() }
        try? FileManager.default.createDirectory(at: Paths.cache, withIntermediateDirectories: true)
        let url = Paths.cache.appendingPathComponent("base-v2.mov")
        if !FileManager.default.fileExists(atPath: url.path) {
            let tmp = Paths.cache.appendingPathComponent("base-v2-\(getpid())-tmp.mov")
            try? FileManager.default.removeItem(at: tmp)
            let w = try AVAssetWriter(outputURL: tmp, fileType: .mov)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180])
            input.expectsMediaDataInRealTime = false
            let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 180])
            guard w.canAdd(input) else { throw RenderError("사진용 바탕을 준비하지 못했어요") }
            w.add(input)
            guard w.startWriting() else { throw RenderError("사진용 바탕을 만들지 못했어요: \(w.error.map { Exporter.detail($0) } ?? "")") }
            w.startSession(atSourceTime: .zero)
            for f in 0..<300 {
                while !input.isReadyForMoreMediaData { usleep(1000) }
                var pb: CVPixelBuffer?
                if let pool = ad.pixelBufferPool { CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb) }
                guard let b = pb else { throw RenderError("사진용 바탕을 만들지 못했어요") }
                CVPixelBufferLockBaseAddress(b, [])
                memset(CVPixelBufferGetBaseAddress(b), 0, CVPixelBufferGetDataSize(b))
                CVPixelBufferUnlockBaseAddress(b, [])
                ad.append(b, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: 30))
            }
            input.markAsFinished()
            let sem = DispatchSemaphore(value: 0)
            w.finishWriting { sem.signal() }
            sem.wait()
            guard w.status == .completed else { throw RenderError("사진용 바탕을 마무리하지 못했어요: \(w.error.map { Exporter.detail($0) } ?? "")") }
            try? FileManager.default.removeItem(at: url)
            try FileManager.default.moveItem(at: tmp, to: url)
        }
        // 영상(asset)을 붙잡아 둬야 트랙을 쓸 수 있어요 (놓치면 '알 수 없는 오류 -12780')
        if baseAsset == nil { baseAsset = AVURLAsset(url: url) }
        guard let t = baseAsset?.tracks(withMediaType: .video).first else { throw RenderError("사진용 바탕을 읽지 못했어요") }
        return t
    }

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
            if c.isImage {
                // 사진: 장면 수만 맞춰 주는 검은 바탕 영상을 깔고, 그림은 Compositor 가 사진 파일에서 그려요
                guard FileManager.default.fileExists(atPath: c.path) else {
                    throw RenderError("파일을 찾을 수 없어요: \(URL(fileURLWithPath: c.path).lastPathComponent)")
                }
                if i == 0 { shortSide = Int(min(c.w > 0 ? c.w : 1080, c.h > 0 ? c.h : 1080)) }
                if includeVideo {
                    let base: AVAssetTrack
                    do { base = try baseTrack() } catch { throw RenderError("사진용 바탕을 만들지 못했어요: \(Exporter.detail(error))") }
                    let vt = vTrack(i)
                    do {
                        try insert(vt, from: base, inT: 0, outT: base.timeRange.end.seconds, at: plan.starts[i], dur: c.dur)
                    } catch { throw RenderError("사진 \(i + 1)번을 타임라인에 놓지 못했어요: \(Exporter.detail(error))") }
                    layers.append(Layer(trackID: vt.trackID, sourceRotation: 0, userRotation: c.rotate, start: plan.starts[i], end: plan.end(i),
                                        fadeIn: c.fadeIn, fadeOut: c.fadeOut, blur: c.blur, imagePath: c.path, motion: c.motion, filter: c.filter))
                }
                continue
            }
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
                                    start: plan.starts[i], end: plan.end(i), fadeIn: c.fadeIn, fadeOut: c.fadeOut, blur: c.blur,
                                    imagePath: nil, motion: c.motion, filter: c.filter))
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
            let shared = RenderShared(renderSize: renderSize, fill: plan.fit == "fill" || preset == "vertical", bgBlur: plan.bgBlur,
                                      photoFrame: plan.photoFrame, texts: plan.texts, beatFx: plan.beatFx)
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
