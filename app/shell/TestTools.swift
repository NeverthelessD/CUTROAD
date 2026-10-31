// CUTROAD — 시험용 명령 (맥 빌드 서버의 scripts/smoke-mac.sh 가 써요. 사용자는 쓸 일이 없어요)
// made by. Nevertheless_D
//
//   CUTROAD --test-sample <out.mov> <초> [가로 세로]   색이 바뀌는 시험 영상 + 소리(가운데는 조용)
//   CUTROAD --test-tone <out.wav> <초>                 시험용 소리 파일
//   CUTROAD --test-probe <파일>                        파일 정보(JSON)
//   CUTROAD --test-waveform <파일>                     파형 개수
//   CUTROAD --test-thumbs <파일>                       썸네일 개수
//   CUTROAD --test-export <spec.json>                  내보내기 (화면에서 하는 것과 같은 길)

import AppKit
import AVFoundation
import CoreText
import ImageIO

enum TestTools {
    static func run(_ args: [String]) -> Int32? {
        guard args.count >= 2, args[1].hasPrefix("--test-") else { return nil }
        let a = Array(args.dropFirst(2))
        func out(_ v: Any) {
            if let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) { print(s) }
        }
        switch args[1] {
        case "--test-sample":
            guard a.count >= 2, let secs = Double(a[1]) else { return 2 }
            let w = a.count >= 4 ? Int(a[2]) ?? 640 : 640, h = a.count >= 4 ? Int(a[3]) ?? 360 : 360
            do { try sample(URL(fileURLWithPath: a[0]), seconds: secs, width: w, height: h); print("ok"); return 0 } catch {
                print("sample 실패: \(error.localizedDescription)"); return 1
            }
        case "--test-tone":
            guard a.count >= 2, let secs = Double(a[1]) else { return 2 }
            do { try tone(URL(fileURLWithPath: a[0]), seconds: secs, quietFrom: 2, quietTo: 1); print("ok"); return 0 } catch { return 1 }
        case "--test-probe":
            guard let p = a.first else { return 2 }
            let r = Media.probe(p); out(r); return r["error"] == nil ? 0 : 1
        case "--test-waveform":
            guard let p = a.first else { return 2 }
            let r = Media.waveform(p); let n = (r["peaks"] as? [Double])?.count ?? 0
            out(["count": n, "perSec": r["perSec"] ?? 0, "max": (r["peaks"] as? [Double])?.max() ?? 0]); return n > 0 ? 0 : 1
        case "--test-thumbs":
            guard let p = a.first else { return 2 }
            let r = Media.thumbnails(p, height: 90); let n = (r["frames"] as? [String])?.filter { !$0.isEmpty }.count ?? 0
            out(["count": n]); return n > 0 ? 0 : 1
        case "--test-frame":
            // 결과 영상의 한 장면을 PNG 로 (시험 결과 확인용)
            guard a.count >= 3, let t = Double(a[1]) else { return 2 }
            let gen = AVAssetImageGenerator(asset: Media.asset(a[0]))
            gen.appliesPreferredTrackTransform = true
            gen.requestedTimeToleranceBefore = .zero
            gen.requestedTimeToleranceAfter = .zero
            guard let img = try? gen.copyCGImage(at: ct(t), actualTime: nil),
                  let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, "public.png" as CFString, 1, nil) else { return 1 }
            CGImageDestinationAddImage(dest, img, nil)
            return CGImageDestinationFinalize(dest) ? 0 : 1
        case "--test-photos":
            // 시험 사진: 번호가 적힌 색 사진 n장 (3장마다 세로 사진 1장), JPG · PNG 섞어서
            guard a.count >= 2, let n = Int(a[1]) else { return 2 }
            try? FileManager.default.createDirectory(atPath: a[0], withIntermediateDirectories: true)
            for i in 0..<n {
                let portrait = i % 3 == 2
                let w = portrait ? 600 : 1200, h = portrait ? 900 : 800
                guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return 1 }
                let hue = CGFloat(i) / CGFloat(max(1, n))
                let c = NSColor(hue: hue, saturation: 0.55, brightness: 0.85, alpha: 1).cgColor
                ctx.setFillColor(c); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
                ctx.setFillColor(CGColor(gray: 1, alpha: 0.85)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h / 5))
                let font = CTFontCreateWithName("Menlo-Bold" as CFString, CGFloat(h) * 0.35, nil)
                if let str = CFAttributedStringCreate(nil, "\(i + 1)" as CFString, [kCTFontAttributeName: font, kCTForegroundColorAttributeName: CGColor(gray: 1, alpha: 1)] as CFDictionary) {
                    ctx.textPosition = CGPoint(x: CGFloat(w) * 0.3, y: CGFloat(h) * 0.35)
                    CTLineDraw(CTLineCreateWithAttributedString(str), ctx)
                }
                guard let img = ctx.makeImage() else { return 1 }
                let png = i % 4 == 3
                let url = URL(fileURLWithPath: a[0]).appendingPathComponent(String(format: "사진%02d.%@", i + 1, png ? "png" : "jpg"))
                guard let dest = CGImageDestinationCreateWithURL(url as CFURL, (png ? "public.png" : "public.jpeg") as CFString, 1, nil) else { return 1 }
                CGImageDestinationAddImage(dest, img, nil)
                if !CGImageDestinationFinalize(dest) { return 1 }
            }
            print("ok"); return 0
        case "--test-clicks":
            // 시험 음악: bpm 박자마다 '딱' 소리 (4박마다 더 크게), 가운데 1/3 은 더 크게
            guard a.count >= 3, let bpm = Double(a[1]), let secs = Double(a[2]) else { return 2 }
            do { try clicks(URL(fileURLWithPath: a[0]), bpm: bpm, seconds: secs); print("ok"); return 0 } catch { return 1 }
        case "--test-beats":
            guard let p = a.first else { return 2 }
            let r = Beats.analyze(p)
            out(["bpm": r["bpm"] ?? 0, "beats": (r["beats"] as? [Double])?.count ?? 0, "first": Array(((r["beats"] as? [Double]) ?? []).prefix(6)),
                 "downbeats": (r["downbeats"] as? [Double])?.count ?? 0, "climax": r["climax"] ?? [], "error": r["error"] ?? ""])
            return r["error"] == nil ? 0 : 1
        case "--test-scan":
            guard let p = a.first else { return 2 }
            let paths = Photos.scan(p, recursive: true)
            let items = Media.probeAll(paths)
            out(["count": paths.count, "ok": items.filter { $0["error"] == nil && $0["preview"] != nil }.count,
                 "portrait": items.filter { (($0["height"] as? Int) ?? 0) > (($0["width"] as? Int) ?? 0) }.count])
            return paths.isEmpty ? 1 : 0
        case "--test-base":
            do { let t = try Builder.baseTrack(); out(["ok": true, "duration": t.timeRange.end.seconds]); return 0 } catch {
                out(["ok": false, "error": Exporter.detail(error)]); return 1
            }
        case "--test-export":
            guard let p = a.first, let d = try? Data(contentsOf: URL(fileURLWithPath: p)),
                  let spec = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { print("spec 을 읽지 못했어요"); return 2 }
            let job = Jobs.shared.add("export")
            Exporter.run(spec, job)
            let s = job.snapshot(); out(s)
            return (s["state"] as? String) == "done" ? 0 : 1
        default:
            return nil
        }
    }

    /// 시험 영상: 1초마다 바뀌는 색 + 움직이는 막대 + 초 숫자, 소리는 440Hz (가운데 30~50% 는 조용)
    static func sample(_ url: URL, seconds: Double, width: Int, height: Int) throws {
        let tmpVideo = url.deletingLastPathComponent().appendingPathComponent(".sample-video-\(UUID().uuidString.prefix(6)).mov")
        let tmpAudio = url.deletingLastPathComponent().appendingPathComponent(".sample-audio-\(UUID().uuidString.prefix(6)).wav")
        defer { try? FileManager.default.removeItem(at: tmpVideo); try? FileManager.default.removeItem(at: tmpAudio) }
        try? FileManager.default.removeItem(at: url)

        let writer = try AVAssetWriter(outputURL: tmpVideo, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw RenderError("시험 영상을 만들지 못했어요") }
        writer.startSession(atSourceTime: .zero)
        let fps = 30
        let frames = Int(seconds * Double(fps))
        let colors: [(CGFloat, CGFloat, CGFloat)] = [(0.85, 0.35, 0.2), (0.2, 0.55, 0.85), (0.3, 0.7, 0.4), (0.8, 0.7, 0.2), (0.55, 0.35, 0.8)]
        for f in 0..<frames {
            while !input.isReadyForMoreMediaData { usleep(2000) }
            guard let pool = adaptor.pixelBufferPool else { throw RenderError("픽셀 버퍼 풀이 없어요") }
            var pbOut: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOut)
            guard let pb = pbOut else { throw RenderError("픽셀 버퍼를 만들지 못했어요") }
            CVPixelBufferLockBaseAddress(pb, [])
            if let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: width, height: height, bitsPerComponent: 8,
                                   bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                let sec = f / fps
                let c = colors[sec % colors.count]
                ctx.setFillColor(CGColor(red: c.0, green: c.1, blue: c.2, alpha: 1))
                ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
                ctx.setFillColor(CGColor(gray: 1, alpha: 0.9))
                let x = CGFloat(f % fps) / CGFloat(fps) * CGFloat(width - 40)
                ctx.fill(CGRect(x: x, y: 20, width: 40, height: CGFloat(height) * 0.2))
                let font = CTFontCreateWithName("Menlo-Bold" as CFString, CGFloat(height) * 0.3, nil)
                let attrs: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: CGColor(gray: 1, alpha: 1)]
                if let s = CFAttributedStringCreate(nil, "\(sec)" as CFString, attrs as CFDictionary) {
                    let line = CTLineCreateWithAttributedString(s)
                    ctx.textPosition = CGPoint(x: CGFloat(width) * 0.4, y: CGFloat(height) * 0.4)
                    CTLineDraw(line, ctx)
                }
            }
            CVPixelBufferUnlockBaseAddress(pb, [])
            adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: CMTimeScale(fps)))
        }
        input.markAsFinished()
        let sem = DispatchSemaphore(value: 0)
        writer.finishWriting { sem.signal() }
        sem.wait()
        guard writer.status == .completed else { throw RenderError("시험 영상을 마무리하지 못했어요: \(writer.error?.localizedDescription ?? "")") }

        try tone(tmpAudio, seconds: seconds, quietFrom: seconds * 0.3, quietTo: seconds * 0.5)
        let comp = AVMutableComposition()
        let va = AVURLAsset(url: tmpVideo), aa = AVURLAsset(url: tmpAudio)
        let range = CMTimeRange(start: .zero, duration: va.duration)
        try comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)?
            .insertTimeRange(range, of: va.tracks(withMediaType: .video)[0], at: .zero)
        try comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)?
            .insertTimeRange(CMTimeRange(start: .zero, duration: min(va.duration, aa.duration)), of: aa.tracks(withMediaType: .audio)[0], at: .zero)
        guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality) else { throw RenderError("합치지 못했어요") }
        ex.outputURL = url
        ex.outputFileType = url.pathExtension.lowercased() == "mp4" ? .mp4 : .mov
        let sem2 = DispatchSemaphore(value: 0)
        ex.exportAsynchronously { sem2.signal() }
        sem2.wait()
        guard ex.status == .completed else { throw RenderError("시험 영상을 합치지 못했어요: \(ex.error?.localizedDescription ?? "")") }
    }

    static func clicks(_ url: URL, bpm: Double, seconds: Double) throws {
        let rate = 44100
        let n = Int(seconds * Double(rate))
        var samples = [Int16](repeating: 0, count: n)
        let period = 60 / bpm
        var k = 0
        var t0 = 0.25
        while t0 < seconds {
            let loud = (t0 > seconds / 3 && t0 < seconds * 2 / 3) ? 1.0 : 0.6
            let amp = (k % 4 == 0 ? 1.0 : 0.55) * loud * 20000
            let s0 = Int(t0 * Double(rate))
            for i in 0..<Int(0.06 * Double(rate)) where s0 + i < n {
                let tt = Double(i) / Double(rate)
                let v = sin(2 * .pi * (k % 4 == 0 ? 1200 : 800) * tt) * exp(-tt * 60) + 0.3 * sin(2 * .pi * 90 * tt) * exp(-tt * 25)
                samples[s0 + i] = Int16(max(-32767, min(32767, v * amp)))
            }
            k += 1
            t0 += period
        }
        var data = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; data.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; data.append(Data(bytes: &x, count: 2)) }
        data.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + n * 2)); data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        data.append("data".data(using: .ascii)!); u32(UInt32(n * 2))
        samples.withUnsafeBufferPointer { data.append(Data(buffer: $0)) }
        try data.write(to: url)
    }

    /// 16비트 모노 48kHz WAV (quietFrom~quietTo 초는 조용)
    static func tone(_ url: URL, seconds: Double, quietFrom: Double, quietTo: Double) throws {
        let rate = 48000
        let n = Int(seconds * Double(rate))
        var data = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; data.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; data.append(Data(bytes: &x, count: 2)) }
        data.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + n * 2)); data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        data.append("data".data(using: .ascii)!); u32(UInt32(n * 2))
        var samples = [Int16](repeating: 0, count: n)
        for i in 0..<n {
            let t = Double(i) / Double(rate)
            let quiet = t >= quietFrom && t < quietTo
            samples[i] = quiet ? 0 : Int16(sin(2 * .pi * 440 * t) * 9000)
        }
        samples.withUnsafeBufferPointer { data.append(Data(buffer: $0)) }
        try data.write(to: url)
    }
}
