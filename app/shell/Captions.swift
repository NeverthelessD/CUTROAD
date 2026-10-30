// CUTROAD — 자동 자막 (맥 내장 받아쓰기 · Speech)
// made by. Nevertheless_D
//
// 타임라인의 '영상 소리'만 골라 소리 파일로 만든 뒤, 맥의 음성 인식으로 받아써요.
// 맥이 기기 안 인식을 지원하면 기기 안에서만 처리하고, 아니면 Apple 의 인식 서버를 써요(인터넷 필요, 1분씩 나눠서).
// 받아쓴 낱말들을 쉬는 틈과 한 줄 길이에 맞춰 자막 줄로 묶어서 화면에 돌려줘요.

import AVFoundation
import Foundation
import Speech

enum Captions {
    static func statusName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "restricted"
        }
    }

    /// 처음에는 맥이 '음성 인식 허용' 창을 보여 줘요
    static func authorize(_ cb: @escaping (String) -> Void) {
        let s = SFSpeechRecognizer.authorizationStatus()
        if s != .notDetermined { cb(statusName(s)); return }
        SFSpeechRecognizer.requestAuthorization { st in cb(statusName(st)) }
    }

    static func run(_ spec: [String: Any], _ job: Job) {
        do {
            let lines = try transcribe(spec, job)
            job.finish(["lines": lines])
            Log.write("자동 자막 완료: \(lines.count)줄")
        } catch {
            Log.write("⚠️ 자동 자막 실패: \(error.localizedDescription)")
            job.fail(job.isCancelled ? "취소했어요" : error.localizedDescription)
        }
    }

    static func transcribe(_ spec: [String: Any], _ job: Job) throws -> [[String: Any]] {
        let sem = DispatchSemaphore(value: 0)
        var status = "notDetermined"
        authorize { s in status = s; sem.signal() }
        sem.wait()
        guard status == "authorized" else {
            throw RenderError("음성 인식이 허용되지 않았어요. 시스템 설정 → 개인정보 보호 및 보안 → 음성 인식에서 CUTROAD를 켜 주세요")
        }
        let lang = str(spec, "lang", "ko-KR")
        let maxLen = Int(num(spec, "maxLen", 16))
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) else {
            throw RenderError("이 언어는 받아쓰기를 지원하지 않아요")
        }
        guard recognizer.isAvailable else {
            throw RenderError("지금은 받아쓰기를 쓸 수 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요")
        }
        let onDevice = recognizer.supportsOnDeviceRecognition
        recognizer.queue = OperationQueue()

        let plan = Plan(spec)
        let built = try Builder.build(plan, preset: "hd", includeVideo: false, includeBGM: false)
        guard built.hasAudio else { throw RenderError("타임라인의 영상에 소리가 없어요") }
        let total = built.duration
        let chunk = onDevice ? 240.0 : 50.0
        let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent("cutroad-captions-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        var words: [(String, Double, Double)] = []
        var start = 0.0
        var k = 0
        while start < total - 0.2 {
            if job.isCancelled { throw RenderError("취소했어요") }
            let end = min(total, start + chunk)
            let part = tmpDir.appendingPathComponent("part\(k).m4a")
            job.set(progress: start / total * 0.95, message: "소리 준비 중")
            try exportAudio(built, from: start, to: end, url: part)
            job.set(progress: start / total * 0.95, message: onDevice ? "맥 안에서 받아쓰는 중" : "받아쓰는 중")
            let segs = try recognize(recognizer, url: part, onDevice: onDevice, timeout: (end - start) * 4 + 60, job: job)
            for s in segs { words.append((s.0, s.1 + start, s.2 + start)) }
            start = end
            k += 1
        }
        return group(words, maxLen: maxLen)
    }

    static func exportAudio(_ built: Built, from a: Double, to b: Double, url: URL) throws {
        guard let session = AVAssetExportSession(asset: built.composition, presetName: AVAssetExportPresetAppleM4A) else {
            throw RenderError("소리를 준비하지 못했어요")
        }
        session.outputURL = url
        session.outputFileType = .m4a
        session.audioMix = built.audioMix
        session.audioTimePitchAlgorithm = .spectral
        session.timeRange = CMTimeRange(start: ct(a), end: ct(b))
        let sem = DispatchSemaphore(value: 0)
        session.exportAsynchronously { sem.signal() }
        sem.wait()
        guard session.status == .completed else {
            throw RenderError("소리를 준비하지 못했어요: \(session.error?.localizedDescription ?? "")")
        }
    }

    static func recognize(_ r: SFSpeechRecognizer, url: URL, onDevice: Bool, timeout: Double, job: Job) throws -> [(String, Double, Double)] {
        let req = SFSpeechURLRecognitionRequest(url: url)
        req.shouldReportPartialResults = false
        req.taskHint = .dictation
        if onDevice { req.requiresOnDeviceRecognition = true }
        if #available(macOS 13.0, *) { req.addsPunctuation = true }
        let sem = DispatchSemaphore(value: 0)
        var out: [(String, Double, Double)] = []
        var err: Error?
        var finished = false
        let lock = NSLock()
        let task = r.recognitionTask(with: req) { result, error in
            lock.lock(); defer { lock.unlock() }
            if finished { return }
            if let result = result, result.isFinal {
                out = result.bestTranscription.segments.map { ($0.substring, $0.timestamp, $0.timestamp + $0.duration) }
                finished = true
                sem.signal()
            } else if let error = error {
                err = error
                finished = true
                sem.signal()
            }
        }
        let deadline = Date().addingTimeInterval(timeout)
        while sem.wait(timeout: .now() + 0.3) == .timedOut {
            if job.isCancelled || Date() > deadline {
                task.cancel()
                throw RenderError(job.isCancelled ? "취소했어요" : "받아쓰기가 너무 오래 걸려서 멈췄어요")
            }
        }
        if let e = err as NSError? {
            // 말소리가 전혀 없는 구간은 '인식 결과 없음' 오류로 와요 → 빈 결과로 봐요
            if e.domain == "kAFAssistantErrorDomain" && (e.code == 1110 || e.code == 1101) { return [] }
            if out.isEmpty { throw RenderError("받아쓰지 못했어요: \(e.localizedDescription)") }
        }
        return out
    }

    /// 낱말들을 자막 줄로: 0.8초 넘게 쉬거나, 한 줄 길이를 넘거나, 문장이 끝나면 새 줄
    static func group(_ words: [(String, Double, Double)], maxLen: Int) -> [[String: Any]] {
        var lines: [(String, Double, Double)] = []
        var cur = "", s = 0.0, e = 0.0
        func flush() {
            let t = cur.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { lines.append((t, s, e)) }
            cur = ""
        }
        for (w, ws, we) in words {
            let word = w.trimmingCharacters(in: .whitespaces)
            if word.isEmpty { continue }
            if !cur.isEmpty && (ws - e > 0.8 || (cur + " " + word).count > maxLen) { flush() }
            if cur.isEmpty { s = ws }
            cur += (cur.isEmpty ? "" : " ") + word
            e = we
            if let last = word.last, ".?!。".contains(last) { flush() }
        }
        flush()
        var out: [[String: Any]] = []
        for (i, l) in lines.enumerated() {
            var end = max(l.2 + 0.3, l.1 + 0.8)
            if i + 1 < lines.count { end = min(end, lines[i + 1].1 - 0.02) }
            out.append(["text": l.0, "start": (l.1 * 100).rounded() / 100, "end": (max(end, l.1 + 0.3) * 100).rounded() / 100])
        }
        return out
    }
}
