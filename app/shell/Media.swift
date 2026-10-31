// CUTROAD — 파일 정보 · 썸네일 · 파형 (맥 내장 AVFoundation)
// made by. Nevertheless_D

import AppKit
import AVFoundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

enum Media {
    /// 가져올 수 있는 파일 (사용자 요청: mov · mp4 · mp3 · wav · m4a, 1.1: 사진 jpg · png · heic)
    static let allowedExtensions = ["mov", "mp4", "mp3", "wav", "m4a"] + Photos.extensions
    static let audioExtensions = ["mp3", "wav", "m4a"]
    static let videoExtensions = ["mov", "mp4"]

    static func asset(_ path: String) -> AVURLAsset {
        AVURLAsset(url: URL(fileURLWithPath: path), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    }

    /// 영상 트랙의 방향을 반영한 화면 크기
    static func orientedSize(_ track: AVAssetTrack) -> CGSize {
        let s = track.naturalSize.applying(track.preferredTransform)
        return CGSize(width: abs(s.width), height: abs(s.height))
    }

    /// 영상 트랙의 회전 (0 · 90 · 180 · 270, 시계 방향)
    static func rotation(_ t: CGAffineTransform) -> Int {
        let angle = atan2(t.b, t.a) * 180 / .pi
        var r = Int((angle / 90).rounded()) * 90
        r = ((r % 360) + 360) % 360
        return r
    }

    /// 여러 파일 정보 (사진은 여러 코어로 한꺼번에)
    static func probeAll(_ paths: [String]) -> [[String: Any]] {
        let photos = paths.filter { Photos.extensions.contains(URL(fileURLWithPath: $0).pathExtension.lowercased()) }
        var pm: [String: [String: Any]] = [:]
        for (p, r) in zip(photos, Photos.probeAll(photos)) { pm[p] = r }
        return paths.map { pm[$0] ?? probe($0) }
    }

    static func probe(_ path: String) -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        let ext = url.pathExtension.lowercased()
        if Photos.extensions.contains(ext) && FileManager.default.fileExists(atPath: path) { return Photos.probe(path) }
        var out: [String: Any] = ["path": path, "name": url.lastPathComponent]
        guard FileManager.default.fileExists(atPath: path) else {
            out["error"] = "파일을 찾을 수 없어요"
            return out
        }
        guard allowedExtensions.contains(ext) else {
            out["error"] = "지원하지 않는 파일이에요 (MOV · MP4 · MP3 · WAV · M4A · JPG · PNG · HEIC)"
            return out
        }
        let a = asset(path)
        let dur = a.duration.seconds
        let v = a.tracks(withMediaType: .video).first
        let au = a.tracks(withMediaType: .audio).first
        out["duration"] = dur.isFinite ? dur : 0
        out["hasAudio"] = au != nil
        if let v = v, videoExtensions.contains(ext) {
            let s = orientedSize(v)
            out["kind"] = "video"
            out["width"] = Int(s.width)
            out["height"] = Int(s.height)
            out["fps"] = Double(v.nominalFrameRate)
            out["rotation"] = rotation(v.preferredTransform)
        } else {
            out["kind"] = "audio"
        }
        if !(dur > 0) || (v == nil && au == nil) {
            out["error"] = "이 파일은 읽을 수 없어요"
        }
        if let attrs = try? FileManager.default.attributesOfItem(atPath: path) {
            out["size"] = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        }
        return out
    }

    /// 타임라인에 보여 줄 작은 그림들 (2초마다 한 장쯤, 4~60장)
    static func thumbnails(_ path: String, height: Double) -> [String: Any] {
        let a = asset(path)
        let dur = a.duration.seconds
        guard dur > 0, let v = a.tracks(withMediaType: .video).first else { return ["frames": [], "interval": 0] }
        let size = orientedSize(v)
        let h = max(40, min(240, height))
        let w = size.height > 0 ? h * size.width / size.height : h * 16 / 9
        let count = max(4, min(60, Int((dur / 2).rounded(.up))))
        let interval = dur / Double(count)
        let gen = AVAssetImageGenerator(asset: a)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: w * 2, height: h * 2)
        gen.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
        gen.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
        var frames: [String] = []
        for i in 0..<count {
            let t = CMTime(seconds: (Double(i) + 0.5) * interval, preferredTimescale: 600)
            if let img = try? gen.copyCGImage(at: t, actualTime: nil), let jpg = jpeg(img, quality: 0.6) {
                frames.append("data:image/jpeg;base64," + jpg.base64EncodedString())
            } else {
                frames.append(frames.last ?? "")
            }
        }
        return ["frames": frames, "interval": interval, "aspect": size.height > 0 ? size.width / size.height : 16.0 / 9.0]
    }

    static func jpeg(_ img: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }

    // MARK: 파형

    static let wavePerSec = 50

    static func cacheKey(_ path: String) -> String {
        let attrs = (try? FileManager.default.attributesOfItem(atPath: path)) ?? [:]
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let digest = SHA256.hash(data: Data("\(path)|\(size)|\(mtime)|v1".utf8))
        return digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    /// 소리의 크기를 1초에 50번 잰 값 (0~1). 한 번 만들면 cache 폴더에 저장해 둬요.
    static func waveform(_ path: String) -> [String: Any] {
        let dir = Paths.cache.appendingPathComponent("wave", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(cacheKey(path) + ".json")
        if let d = try? Data(contentsOf: file), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            return j
        }
        let peaks = readPeaks(path)
        let out: [String: Any] = ["perSec": wavePerSec, "peaks": peaks]
        if !peaks.isEmpty, let d = try? JSONSerialization.data(withJSONObject: out) {
            try? d.write(to: file)
        }
        return out
    }

    static func readPeaks(_ path: String) -> [Double] {
        let a = asset(path)
        guard let track = a.tracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: a) else { return [] }
        let rate = 8000
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: rate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return [] }
        reader.add(output)
        guard reader.startReading() else { return [] }
        let bucket = rate / wavePerSec
        var peaks: [Double] = []
        var cur: Int32 = 0
        var n = 0
        while reader.status == .reading, let sb = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sb) else { continue }
            let total = CMBlockBufferGetDataLength(block)
            let count = total / 2
            if count == 0 { continue }
            var samples = [Int16](repeating: 0, count: count)
            let st = samples.withUnsafeMutableBytes { raw -> OSStatus in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count * 2, destination: raw.baseAddress!)
            }
            if st != kCMBlockBufferNoErr { continue }
            for s in samples {
                let v = Int32(s)
                let m = v < 0 ? -v : v
                if m > cur { cur = m }
                n += 1
                if n >= bucket {
                    peaks.append((Double(cur) / 32768.0 * 1000).rounded() / 1000)
                    cur = 0
                    n = 0
                }
            }
        }
        if n > 0 { peaks.append((Double(cur) / 32768.0 * 1000).rounded() / 1000) }
        return peaks
    }
}
