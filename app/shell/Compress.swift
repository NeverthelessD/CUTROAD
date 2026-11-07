// CUTROAD — 용량 줄이기 (영상 컴프레서) · 소리 고르게 (오디오 컴프레서)
// made by. Nevertheless_D
//
// 용량 줄이기: 영상 파일 하나를 정해진 크기(가로×세로) · 비트레이트로 다시 만들어요 (H.264 또는 HEVC + AAC).
//   크기 · 비트레이트는 화면(compress.js CR.sizePlan)이 계산해서 보내 줘요. 여기서는 그대로 만들기만 해요.
//   돌려 찍은 영상(세로)은 맥 기본 합성기(AVVideoComposition)로 바로 세워서 저장하고, HDR 영상은 일반(BT.709) 색으로 바꿔요.
// 소리 고르게: 내보낼 때 섞인 소리(48kHz 스테레오)에 컴프레서 → 보정 → 리미터(-1dB). 값은 compress.js CR.AUDIO_COMP 와 같아요.

import AVFoundation

extension Jobs {
    func startCompress(_ body: [String: Any]) -> [String: Any] {
        let job = add("compress")
        DispatchQueue.global(qos: .userInitiated).async { Compressor.run(body, job) }
        return ["id": job.id]
    }
}

enum Compressor {
    static func run(_ m: [String: Any], _ job: Job) {
        let src = URL(fileURLWithPath: str(m, "path", ""))
        var dir = URL(fileURLWithPath: str(m, "dir", src.deletingLastPathComponent().path), isDirectory: true)
        if !FileManager.default.isWritableFile(atPath: dir.path) {
            // 원본 폴더에 쓸 수 없으면(읽기 전용 디스크 등) 동영상 폴더에
            dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies", isDirectory: true)
        }
        let started = Date()
        let tmp = dir.appendingPathComponent(".\(UUID().uuidString.prefix(8)).cutroad-part.mp4")
        defer { try? FileManager.default.removeItem(at: tmp); Exporter.cleanup(tmp) }
        do {
            guard FileManager.default.fileExists(atPath: src.path) else {
                throw RenderError("파일을 찾을 수 없어요: \(src.lastPathComponent)")
            }
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let replace = str(m, "replace", "")
            let dest: URL
            if !replace.isEmpty, URL(fileURLWithPath: replace).deletingLastPathComponent().standardizedFileURL.path == dir.standardizedFileURL.path {
                dest = URL(fileURLWithPath: replace) // 목표 크기를 넘어서 다시 만드는 경우: 앞에 만든 파일을 바꿔요
            } else {
                dest = Exporter.uniqueURL(dir: dir, name: str(m, "name", src.deletingPathExtension().lastPathComponent + " (작게)"), ext: "mp4")
            }
            let W = Int(num(m, "width", 1920)), H = Int(num(m, "height", 1080))
            let vbps = Int(num(m, "vbps", 4_000_000)), abps = Int(num(m, "abps", 128_000))
            let hevc = str(m, "codec", "h264") == "hevc"
            Log.write("용량 줄이기 시작: \(src.lastPathComponent) → \(W)×\(H) · \(vbps / 1000)kbps · \(hevc ? "HEVC" : "H.264")")
            try encode(src, to: tmp, W: W, H: H, vbps: vbps, abps: abps, hevc: hevc, job: job)
            if job.isCancelled { throw RenderError("멈췄어요") }
            if FileManager.default.fileExists(atPath: dest.path) { try FileManager.default.removeItem(at: dest) }
            try FileManager.default.moveItem(at: tmp, to: dest)
            let size = ((try? FileManager.default.attributesOfItem(atPath: dest.path))?[.size] as? NSNumber)?.int64Value ?? 0
            let secs = Date().timeIntervalSince(started)
            Log.write("용량 줄이기 완료: \(dest.lastPathComponent) · \(size / 1_000_000)MB · \(Int(secs))초")
            job.finish(["path": dest.path, "name": dest.lastPathComponent, "size": size, "seconds": secs])
        } catch {
            Log.write("⚠️ 용량 줄이기 실패: \(Exporter.detail(error))")
            job.fail(job.isCancelled ? "멈췄어요" : Exporter.friendly(error))
        }
    }

    /// W×H = 보이는 방향 그대로의 결과 크기 (짝수)
    static func encode(_ src: URL, to url: URL, W: Int, H: Int, vbps: Int, abps: Int, hevc: Bool, job: Job) throws {
        let asset = Media.asset(src.path)
        guard let vt = asset.tracks(withMediaType: .video).first else {
            throw RenderError("영상이 없는 파일이에요: \(src.lastPathComponent)")
        }
        let dur = max(0.1, asset.duration.seconds)
        var fps = Int(vt.nominalFrameRate.rounded())
        if fps <= 0 { fps = 30 }
        fps = min(60, max(10, fps))

        // 돌리기 · 크기 맞추기: 맥 기본 합성기 (GPU, 빠름)
        let t = vt.preferredTransform
        let r = CGRect(origin: .zero, size: vt.naturalSize).applying(t)
        guard r.width > 0, r.height > 0 else { throw RenderError("영상 크기를 읽지 못했어요: \(src.lastPathComponent)") }
        let fix = t.concatenating(CGAffineTransform(translationX: -r.minX, y: -r.minY))
            .concatenating(CGAffineTransform(scaleX: CGFloat(W) / r.width, y: CGFloat(H) / r.height))
        let vc = AVMutableVideoComposition()
        vc.renderSize = CGSize(width: W, height: H)
        vc.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))
        vc.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        vc.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        vc.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
        let ins = AVMutableVideoCompositionInstruction()
        ins.timeRange = CMTimeRange(start: .zero, duration: asset.duration)
        let li = AVMutableVideoCompositionLayerInstruction(assetTrack: vt)
        li.setTransform(fix, at: .zero)
        ins.layerInstructions = [li]
        vc.instructions = [ins]

        let reader = try AVAssetReader(asset: asset)
        let vOut = AVAssetReaderVideoCompositionOutput(videoTracks: [vt], videoSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        vOut.videoComposition = vc
        vOut.alwaysCopiesSampleData = false
        guard reader.canAdd(vOut) else { throw RenderError("영상을 읽을 준비를 하지 못했어요") }
        reader.add(vOut)
        var aOut: AVAssetReaderAudioMixOutput?
        let aTracks = asset.tracks(withMediaType: .audio)
        if !aTracks.isEmpty {
            let o = AVAssetReaderAudioMixOutput(audioTracks: aTracks, audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            ])
            o.alwaysCopiesSampleData = false
            if reader.canAdd(o) { reader.add(o); aOut = o }
        }

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let vIn = try Compressor.videoInput(writer, W: W, H: H, fps: fps, vbps: vbps, hevc: hevc)
        writer.add(vIn)
        var aIn: AVAssetWriterInput?
        if aOut != nil {
            let i = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: max(64_000, abps),
            ])
            i.expectsMediaDataInRealTime = false
            if writer.canAdd(i) { writer.add(i); aIn = i }
        }
        let aPair: (AVAssetWriterInput, AVAssetReaderOutput)? = (aIn != nil && aOut != nil) ? (aIn!, aOut! as AVAssetReaderOutput) : nil
        try Compressor.pump(reader: reader, writer: writer, video: (vIn, vOut as AVAssetReaderOutput), audio: aPair,
                            total: dur, job: job, message: "줄이는 중", dynamics: nil)
    }

    /// 영상 인코더 설정: 맥이 받아 주는 설정만 (못 받는 설정을 넣으면 앱이 멈출 수 있어서 canApply 로 먼저 확인)
    static func videoInput(_ writer: AVAssetWriter, W: Int, H: Int, fps: Int, vbps: Int, hevc: Bool) throws -> AVAssetWriterInput {
        var comp: [String: Any] = [
            AVVideoAverageBitRateKey: vbps,
            AVVideoMaxKeyFrameIntervalKey: fps * 2,
            AVVideoExpectedSourceFrameRateKey: fps,
        ] // 목표 크기를 넘으면 화면(compress.js)이 비트레이트를 낮춰 한 번 더 만들어요
        if !hevc { comp[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }
        let color: [String: Any] = [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ]
        func settings(_ c: [String: Any], _ withColor: Bool) -> [String: Any] {
            var s: [String: Any] = [AVVideoCodecKey: hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
                                    AVVideoWidthKey: W, AVVideoHeightKey: H, AVVideoCompressionPropertiesKey: c]
            if withColor { s[AVVideoColorPropertiesKey] = color }
            return s
        }
        let tries = [settings(comp, true), settings(comp, false)]
        guard let ok = tries.first(where: { writer.canApply(outputSettings: $0, forMediaType: .video) }) else {
            throw RenderError(hevc ? "이 맥에서는 HEVC 로 만들 수 없어요. ‘더 작게 (HEVC)’를 끄고 다시 해 주세요" : "영상 저장을 준비하지 못했어요")
        }
        let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: ok)
        vIn.expectsMediaDataInRealTime = false
        guard writer.canAdd(vIn) else { throw RenderError("영상 저장을 준비하지 못했어요") }
        return vIn
    }

    /// 읽어서 쓰기 (영상 · 소리 따로 줄 세워서). dynamics 가 있으면 소리에 컴프레서를 걸어요
    static func pump(reader: AVAssetReader, writer: AVAssetWriter, video: (AVAssetWriterInput, AVAssetReaderOutput),
                     audio: (AVAssetWriterInput, AVAssetReaderOutput)?, total: Double, job: Job, message: String, dynamics: Dynamics?) throws {
        guard reader.startReading() else { throw RenderError("영상을 읽지 못했어요: \(reader.error?.localizedDescription ?? "")") }
        guard writer.startWriting() else { throw RenderError("파일을 만들지 못했어요: \(writer.error?.localizedDescription ?? "")") }
        writer.startSession(atSourceTime: .zero)
        let group = DispatchGroup()
        func run(_ input: AVAssetWriterInput, _ output: AVAssetReaderOutput, label: String, isVideo: Bool) {
            group.enter()
            var done = false
            let q = DispatchQueue(label: "cutroad.pump.\(label)")
            input.requestMediaDataWhenReady(on: q) {
                if done { return }
                while input.isReadyForMoreMediaData {
                    if job.isCancelled || reader.status != .reading {
                        done = true; input.markAsFinished(); group.leave(); return
                    }
                    guard var sb = output.copyNextSampleBuffer() else {
                        done = true; input.markAsFinished(); group.leave(); return
                    }
                    if isVideo {
                        let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
                        if t.isFinite { job.set(progress: t / max(0.1, total) * 0.99, message: message) }
                    } else if let d = dynamics, let p = d.process(sb) {
                        sb = p
                    }
                    if !input.append(sb) {
                        done = true; input.markAsFinished(); group.leave(); return
                    }
                }
            }
        }
        run(video.0, video.1, label: "video", isVideo: true)
        if let a = audio { run(a.0, a.1, label: "audio", isVideo: false) }
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
}

// MARK: - 소리 고르게 (오디오 컴프레서)

/// spec["audioComp"] = { threshold(dB), ratio, attack(초), release(초), makeup(dB) } — compress.js CR.AUDIO_COMP
struct AudioComp {
    let threshold: Double, ratio: Double, attack: Double, release: Double, makeup: Double
    init?(_ d: Any?) {
        guard let d = d as? [String: Any] else { return nil }
        threshold = num(d, "threshold", -24)
        ratio = max(1, num(d, "ratio", 3))
        attack = max(0.001, num(d, "attack", 0.01))
        release = max(0.01, num(d, "release", 0.2))
        makeup = num(d, "makeup", 6)
    }
}

/// 16비트 스테레오(섞인 소리)에: 컴프레서(무릎 6dB, 두 채널 같이) → 보정 → 리미터(-1dB, 바로 누르고 50ms 에 풀림)
final class Dynamics {
    private let thr: Double, slope: Double, knee = 6.0, makeup: Double
    private let aAtt: Double, aRel: Double, lRel: Double
    private let ceiling = 0.891 // -1dB
    private var env = 0.0        // 지금 누르는 양 (dB, 0 이하)
    private var lim = 1.0

    init(_ c: AudioComp, rate: Double = 48000) {
        thr = c.threshold; slope = 1 / c.ratio - 1; makeup = c.makeup
        aAtt = exp(-1 / (c.attack * rate)); aRel = exp(-1 / (c.release * rate)); lRel = exp(-1 / (0.05 * rate))
    }

    private func gainReduction(_ lvl: Double) -> Double {
        let over = lvl - thr
        if 2 * over < -knee { return 0 }
        if 2 * abs(over) <= knee { return slope * pow(over + knee / 2, 2) / (2 * knee) }
        return slope * over
    }

    /// 새 소리 조각을 돌려줘요 (못 바꾸면 nil → 원래 조각을 그대로 써요)
    func process(_ sb: CMSampleBuffer) -> CMSampleBuffer? {
        guard let fmt = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM, asbd.mBitsPerChannel == 16, asbd.mChannelsPerFrame >= 1 else { return nil }
        let ch = Int(asbd.mChannelsPerFrame)
        var block: CMBlockBuffer?
        var abl = AudioBufferList()
        let st = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: nil, bufferListOut: &abl,
            bufferListSize: MemoryLayout<AudioBufferList>.size, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block)
        guard st == noErr, let data = abl.mBuffers.mData else { return nil }
        let count = Int(abl.mBuffers.mDataByteSize) / 2
        let frames = count / ch
        guard frames > 0 else { return nil }
        let src = data.bindMemory(to: Int16.self, capacity: count)
        var out = [Int16](repeating: 0, count: count)
        for f in 0..<frames {
            var peak = 0.0
            for c in 0..<ch { peak = max(peak, abs(Double(src[f * ch + c]) / 32768)) }
            let gr = gainReduction(20 * log10(max(peak, 1e-6)))
            env = gr < env ? aAtt * env + (1 - aAtt) * gr : aRel * env + (1 - aRel) * gr
            let g = pow(10, (env + makeup) / 20)
            let p2 = peak * g
            let need = p2 > ceiling ? ceiling / p2 : 1
            lim = min(need, lRel * lim + (1 - lRel))
            let k = g * lim
            for c in 0..<ch {
                let v = Double(src[f * ch + c]) * k
                out[f * ch + c] = Int16(max(-32768, min(32767, v.rounded())))
            }
        }
        let bytes = count * 2
        var nb: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes, blockAllocator: kCFAllocatorDefault,
                                                 customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &nb) == noErr,
              let nbuf = nb else { return nil }
        let w = out.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: nbuf, offsetIntoDestination: 0, dataLength: bytes) }
        guard w == noErr else { return nil }
        var res: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: nbuf, formatDescription: fmt,
                                                                    sampleCount: frames, presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sb),
                                                                    packetDescriptions: nil, sampleBufferOut: &res) == noErr else { return nil }
        return res
    }
}
