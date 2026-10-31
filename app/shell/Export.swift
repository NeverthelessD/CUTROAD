// CUTROAD — 내보내기 (MP4 · GIF · 컷 편집만: 원래 화질 그대로) · 작업 목록
// made by. Nevertheless_D
//
// MP4 는 H.264 + AAC 로 만들어요 (어디서나 재생되게). 맥의 하드웨어 인코더를 써서 빨라요.
// 결과는 먼저 같은 폴더의 숨김 임시 파일로 만들고, 다 되면 이름을 바꿔요 (중간에 끊겨도 반쯤 된 파일이 남지 않게).

import AppKit
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

final class Job {
    let id: String
    let kind: String
    private let lock = NSLock()
    private(set) var state = "running"   // running | done | error | cancelled
    private(set) var progress = 0.0
    private(set) var message = ""
    private(set) var error = ""
    private(set) var result: [String: Any] = [:]
    private(set) var cancelled = false

    init(id: String, kind: String) { self.id = id; self.kind = kind }

    func set(progress p: Double, message m: String? = nil) {
        lock.lock(); progress = min(1, max(0, p)); if let m = m { message = m }; lock.unlock()
    }
    func finish(_ r: [String: Any]) { lock.lock(); state = "done"; progress = 1; result = r; lock.unlock() }
    func fail(_ e: String) { lock.lock(); state = cancelled ? "cancelled" : "error"; error = e; lock.unlock() }
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["id": id, "kind": kind, "state": state, "progress": progress, "message": message, "error": error, "result": result]
    }
}

final class Jobs {
    static let shared = Jobs()
    private var jobs: [String: Job] = [:]
    private let lock = NSLock()
    private var counter = 0

    func add(_ kind: String) -> Job {
        lock.lock(); defer { lock.unlock() }
        counter += 1
        let j = Job(id: "\(kind)-\(counter)-\(Int(Date().timeIntervalSince1970))", kind: kind)
        jobs[j.id] = j
        return j
    }
    func get(_ id: String) -> Job? { lock.lock(); defer { lock.unlock() }; return jobs[id] }
    func snapshot(_ id: String) -> [String: Any] { get(id)?.snapshot() ?? ["state": "error", "error": "작업을 찾지 못했어요"] }
    func cancel(_ id: String) { get(id)?.cancel() }
    func cancelAll() { lock.lock(); let all = Array(jobs.values); lock.unlock(); all.forEach { $0.cancel() } }

    func startExport(_ spec: [String: Any]) -> [String: Any] {
        let job = add("export")
        DispatchQueue.global(qos: .userInitiated).async { Exporter.run(spec, job) }
        return ["id": job.id]
    }

    func startCaptions(_ spec: [String: Any]) -> [String: Any] {
        let job = add("captions")
        DispatchQueue.global(qos: .userInitiated).async { Captions.run(spec, job) }
        return ["id": job.id]
    }
}

enum Exporter {
    static func run(_ spec: [String: Any], _ job: Job) {
        let out = spec["out"] as? [String: Any] ?? [:]
        let preset = str(out, "preset", "hd")
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let dir = URL(fileURLWithPath: str(out, "dir", home + "/Movies"), isDirectory: true)
        let ext = preset == "gif" ? "gif" : "mp4"
        let started = Date()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = uniqueURL(dir: dir, name: str(out, "name", "CUTROAD"), ext: ext)
            let tmp = dir.appendingPathComponent(".\(UUID().uuidString.prefix(8)).cutroad-part.\(ext)")
            defer { try? FileManager.default.removeItem(at: tmp) }
            Log.write("내보내기 시작: \(preset) → \(dest.lastPathComponent)")
            let plan = Plan(spec)
            var note = ""
            switch preset {
            case "gif":
                try writeGIF(plan, out: out, to: tmp, job: job)
            case "quick":
                note = try writeQuick(plan, to: tmp, job: job)
            default:
                let built = try Builder.build(plan, preset: preset)
                try writeMP4(built, to: tmp, job: job)
            }
            if job.isCancelled { throw RenderError("취소했어요") }
            try FileManager.default.moveItem(at: tmp, to: dest)
            let size = ((try? FileManager.default.attributesOfItem(atPath: dest.path))?[.size] as? NSNumber)?.int64Value ?? 0
            let secs = Date().timeIntervalSince(started)
            Log.write("내보내기 완료: \(dest.lastPathComponent) · \(size / 1_000_000)MB · \(Int(secs))초 \(note)")
            job.finish(["path": dest.path, "name": dest.lastPathComponent, "size": size, "seconds": secs, "note": note])
        } catch {
            Log.write("⚠️ 내보내기 실패: \(Exporter.detail(error))")
            job.fail(job.isCancelled ? "취소했어요" : Exporter.friendly(error))
        }
    }

    /// 진단 기록용: 맥이 알려 준 오류를 자세히 (종류 · 번호 · 원인)
    static func detail(_ e: Error) -> String {
        if let r = e as? RenderError { return r.message }
        let n = e as NSError
        var s = "\(n.localizedDescription) [\(n.domain) \(n.code)]"
        if let f = n.localizedFailureReason { s += " " + f }
        if let u = n.userInfo[NSUnderlyingErrorKey] as? NSError { s += " ← [\(u.domain) \(u.code)] \(u.localizedDescription)" }
        return s
    }

    /// 화면에 보여 줄 말: 맥의 짧은 오류 문구 대신 무엇을 하다 안 됐는지 알려 줘요
    static func friendly(_ e: Error) -> String {
        if let r = e as? RenderError { return r.message }
        return "영상을 만들지 못했어요 (" + detail(e) + ")"
    }

    static func uniqueURL(dir: URL, name: String, ext: String) -> URL {
        var base = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if base.lowercased().hasSuffix("." + ext) { base = String(base.dropLast(ext.count + 1)) }
        if base.isEmpty || base.hasPrefix(".") { base = "CUTROAD" + base }
        var url = dir.appendingPathComponent("\(base).\(ext)")
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent("\(base) (\(n)).\(ext)")
            n += 1
        }
        return url
    }

    // MARK: MP4 (H.264 + AAC)

    static func writeMP4(_ built: Built, to url: URL, job: Job) throws {
        let comp = built.composition
        let reader = try AVAssetReader(asset: comp)
        reader.timeRange = CMTimeRange(start: .zero, duration: ct(built.duration))
        let vOut = AVAssetReaderVideoCompositionOutput(videoTracks: comp.tracks(withMediaType: .video),
                                                       videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        vOut.videoComposition = built.videoComposition
        vOut.alwaysCopiesSampleData = false
        guard reader.canAdd(vOut) else { throw RenderError("영상을 읽을 준비를 하지 못했어요") }
        reader.add(vOut)
        var aOut: AVAssetReaderAudioMixOutput?
        let aTracks = comp.tracks(withMediaType: .audio)
        if !aTracks.isEmpty {
            let o = AVAssetReaderAudioMixOutput(audioTracks: aTracks, audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            ])
            o.audioMix = built.audioMix
            o.audioTimePitchAlgorithm = .spectral
            o.alwaysCopiesSampleData = false
            if reader.canAdd(o) { reader.add(o); aOut = o }
        }

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let W = Int(built.renderSize.width), H = Int(built.renderSize.height)
        let bitrate = min(60_000_000, max(2_000_000, Int(Double(W * H * built.fps) * 0.2)))
        let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: W,
            AVVideoHeightKey: H,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoMaxKeyFrameIntervalKey: built.fps * 2,
                AVVideoExpectedSourceFrameRateKey: built.fps,
            ] as [String: Any],
        ])
        vIn.expectsMediaDataInRealTime = false
        guard writer.canAdd(vIn) else { throw RenderError("영상 저장을 준비하지 못했어요") }
        writer.add(vIn)
        var aIn: AVAssetWriterInput?
        if aOut != nil {
            let i = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000,
            ])
            i.expectsMediaDataInRealTime = false
            if writer.canAdd(i) { writer.add(i); aIn = i }
        }

        guard reader.startReading() else { throw RenderError("영상을 읽지 못했어요: \(reader.error?.localizedDescription ?? "")") }
        guard writer.startWriting() else { throw RenderError("파일을 만들지 못했어요: \(writer.error?.localizedDescription ?? "")") }
        writer.startSession(atSourceTime: .zero)

        let group = DispatchGroup()
        let total = max(0.1, built.duration)
        func pump(_ input: AVAssetWriterInput, _ output: AVAssetReaderOutput, label: String, video: Bool) {
            group.enter()
            var done = false
            let q = DispatchQueue(label: "cutroad.export.\(label)")
            input.requestMediaDataWhenReady(on: q) {
                if done { return }
                while input.isReadyForMoreMediaData {
                    if job.isCancelled || reader.status != .reading {
                        done = true; input.markAsFinished(); group.leave(); return
                    }
                    guard let sb = output.copyNextSampleBuffer() else {
                        done = true; input.markAsFinished(); group.leave(); return
                    }
                    if video {
                        let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
                        if t.isFinite { job.set(progress: t / total * 0.99, message: "영상 만드는 중") }
                    }
                    if !input.append(sb) {
                        done = true; input.markAsFinished(); group.leave(); return
                    }
                }
            }
        }
        pump(vIn, vOut, label: "video", video: true)
        if let aIn = aIn, let aOut = aOut { pump(aIn, aOut, label: "audio", video: false) }
        group.wait()

        if job.isCancelled {
            reader.cancelReading(); writer.cancelWriting()
            throw RenderError("취소했어요")
        }
        if reader.status == .failed {
            writer.cancelWriting()
            throw RenderError("영상을 읽다가 문제가 생겼어요: \(reader.error?.localizedDescription ?? "")")
        }
        if writer.status == .failed {
            throw RenderError("파일을 쓰다가 문제가 생겼어요: \(writer.error?.localizedDescription ?? "")")
        }
        let sem = DispatchSemaphore(value: 0)
        writer.finishWriting { sem.signal() }
        sem.wait()
        if writer.status != .completed {
            throw RenderError("파일을 마무리하지 못했어요: \(writer.error?.localizedDescription ?? "")")
        }
    }

    // MARK: GIF (움짤)

    static func writeGIF(_ plan: Plan, out: [String: Any], to url: URL, job: Job) throws {
        let built = try Builder.build(plan, preset: "gif", includeBGM: false)
        var a = 0.0, b = min(built.duration, 10)
        if let r = out["range"] as? [Any], r.count == 2 {
            let x = (r[0] as? NSNumber)?.doubleValue ?? 0, y = (r[1] as? NSNumber)?.doubleValue ?? 0
            if y > x { a = max(0, x); b = min(built.duration, y) }
        }
        b = min(b, a + 30)   // 움짤은 30초까지
        guard b - a > 0.1 else { throw RenderError("움짤로 만들 구간이 너무 짧아요") }
        let fps = 12.0
        let count = max(1, Int(((b - a) * fps).rounded()))
        let gen = AVAssetImageGenerator(asset: built.composition)
        gen.videoComposition = built.videoComposition
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = .zero
        gen.maximumSize = built.renderSize
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString, count, nil) else {
            throw RenderError("움짤 파일을 만들지 못했어요")
        }
        CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
        let frameProps = [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 1.0 / fps, kCGImagePropertyGIFUnclampedDelayTime: 1.0 / fps]] as CFDictionary
        for k in 0..<count {
            if job.isCancelled { throw RenderError("취소했어요") }
            let t = a + Double(k) / fps
            let img = try gen.copyCGImage(at: ct(min(t, built.duration - 0.01)), actualTime: nil)
            CGImageDestinationAddImage(dest, img, frameProps)
            job.set(progress: Double(k + 1) / Double(count) * 0.97, message: "움짤 만드는 중")
        }
        guard CGImageDestinationFinalize(dest) else { throw RenderError("움짤 파일을 마무리하지 못했어요") }
    }

    // MARK: 컷 편집만 — 원래 화질 그대로 (다시 인코딩하지 않음)

    static func writeQuick(_ plan: Plan, to url: URL, job: Job) throws -> String {
        if plan.clips.contains(where: { $0.isImage }) { return try reencodeQuick(plan, to: url, job: job, firstSize: nil) }
        let comp = AVMutableComposition()
        guard let vt = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw RenderError("영상을 준비하지 못했어요")
        }
        var at = CMTime.zero
        var at2 = CMTime.zero
        var aTrack: AVMutableCompositionTrack?
        var firstSize = CGSize(width: 1920, height: 1080)
        for (i, c) in plan.clips.enumerated() {
            guard FileManager.default.fileExists(atPath: c.path) else {
                throw RenderError("파일을 찾을 수 없어요: \(URL(fileURLWithPath: c.path).lastPathComponent)")
            }
            let a = Media.asset(c.path)
            guard let sv = a.tracks(withMediaType: .video).first else { continue }
            if i == 0 {
                vt.preferredTransform = sv.preferredTransform
                firstSize = Media.orientedSize(sv)
            }
            let srcEnd = sv.timeRange.end.seconds
            let range = CMTimeRange(start: ct(min(c.inT, srcEnd)), end: ct(min(c.outT, srcEnd)))
            guard range.duration > .zero else { continue }
            try vt.insertTimeRange(range, of: sv, at: at)
            if let sa = a.tracks(withMediaType: .audio).first {
                if aTrack == nil { aTrack = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) }
                if let t = aTrack {
                    if at2 < at { t.insertEmptyTimeRange(CMTimeRange(start: at2, end: at)) }
                    try t.insertTimeRange(range, of: sa, at: at)
                    at2 = at + range.duration
                }
            }
            at = at + range.duration
        }
        guard at > .zero else { throw RenderError("저장할 부분이 없어요") }

        if let session = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough),
           session.supportedFileTypes.contains(.mp4) {
            session.outputURL = url
            session.outputFileType = .mp4
            session.shouldOptimizeForNetworkUse = true
            let sem = DispatchSemaphore(value: 0)
            session.exportAsynchronously { sem.signal() }
            while sem.wait(timeout: .now() + 0.2) == .timedOut {
                if job.isCancelled { session.cancelExport() }
                job.set(progress: Double(session.progress) * 0.99, message: "원래 화질 그대로 저장하는 중")
            }
            if session.status == .completed { return "원본 그대로" }
            if job.isCancelled { throw RenderError("취소했어요") }
            Log.write("원본 그대로 저장이 안 돼서 다시 만들어요: \(session.error?.localizedDescription ?? "")")
            try? FileManager.default.removeItem(at: url)
        }
        return try reencodeQuick(plan, to: url, job: job, firstSize: firstSize)
    }

    /// 원본 형식이 MP4 에 그대로 담기지 않거나(예: 일부 MOV 의 무압축 소리) 사진이 섞여 있으면 원본 크기로 다시 만들어요
    static func reencodeQuick(_ plan: Plan, to url: URL, job: Job, firstSize: CGSize?) throws -> String {
        var p = plan
        var fs = firstSize ?? CGSize(width: 1920, height: 1080)
        if firstSize == nil, let c = plan.clips.first, c.isImage, c.w > 0, c.h > 0 { fs = CGSize(width: c.w, height: c.h) }
        let r = fs.height > 0 ? fs.width / fs.height : 16.0 / 9.0
        p.aspect = r > 1.2 ? "16:9" : (r < 0.8 ? "9:16" : "1:1")
        p.fit = "fit"
        job.set(progress: 0, message: "MP4로 다시 만드는 중")
        let built = try Builder.build(p, preset: "original")
        try writeMP4(built, to: url, job: job)
        return "다시 인코딩"
    }
}
