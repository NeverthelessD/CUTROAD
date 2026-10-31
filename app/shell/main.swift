// CUTROAD — Dock 에 보이는 맥 앱 껍데기
// made by. Nevertheless_D
//
// 왜 이 껍데기가 있나요?
//   macOS 27 의 '백그라운드 앱 활동' 규칙에 맞춰, 엔진은 Dock 에 보이는 이 앱의 자식으로 '앱이 켜져 있는 동안만' 돌아요.
//   규칙을 피해 가는 장치(종료 신호 무시, 몰래 도는 도우미 앱)는 쓰지 않아요.
//
// 하는 일
//   1) 앱 안의 엔진을 ~/Library/Application Support/CUTROAD/bin 으로 복사 (업데이트로 앱 묶음이 바뀌어도 안전하게)
//   2) 엔진(지킴이 모드)을 자식으로 켜고, 127.0.0.1 + 토큰 주소를 앱 창(WKWebView)에 띄움
//   3) Dock 아이콘을 누르면 창을 다시 보여 주고, 앱을 종료하면 엔진도 깔끔하게 끔
//   4) 엔진이 끝나면 앱도 끝남 · 업데이트 후에는 새 버전을 다시 엶
//   5) 모든 단계를 launcher.log 에 기록
//   6) 영상 처리: 화면이 부탁하면 맥 내장 기능(AVFoundation · Core Image · Speech)으로
//      파일 정보 · 썸네일 · 파형 · 내보내기(MP4 · GIF) · 자동 자막을 해요 (Media.swift · Render.swift · Export.swift · Captions.swift)

import AppKit
import AVFoundation
import Darwin
import UniformTypeIdentifiers
import WebKit

// MARK: - 경로 · 기록

enum Paths {
    static let support: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("CUTROAD", isDirectory: true)
    }()
    static let bin = support.appendingPathComponent("bin", isDirectory: true)
    static let engine = bin.appendingPathComponent("cutroad-engine")
    static let cache = support.appendingPathComponent("cache", isDirectory: true)
    static func file(_ name: String) -> URL { support.appendingPathComponent(name) }
}

enum Log {
    static let lock = NSLock()
    static func write(_ message: String) {
        lock.lock(); defer { lock.unlock() }
        let fm = FileManager.default
        try? fm.createDirectory(at: Paths.support, withIntermediateDirectories: true)
        let url = Paths.file("launcher.log")
        if let attrs = try? fm.attributesOfItem(atPath: url.path), let size = attrs[.size] as? NSNumber, size.intValue > 262_144 {
            let prev = Paths.file("launcher.prev.log")
            try? fm.removeItem(at: prev)
            try? fm.moveItem(at: url, to: prev)
        }
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = "MM-dd HH:mm:ss"
        let line = "\(df.string(from: Date())) [앱 \(getpid())] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(data)
            h.closeFile()
        } else {
            try? data.write(to: url)
        }
    }
}

// MARK: - 엔진

final class Engine {
    var process: Process?
    var port: Int = 0
    var token: String = ""
    let build: String
    var onExit: ((Int32, Bool) -> Void)?

    init() {
        let v = Bundle.main.url(forResource: "version", withExtension: "txt")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "0.0.0"
        build = v.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func readText(_ name: String) -> String? {
        guard let s = try? String(contentsOf: Paths.file(name), encoding: .utf8) else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// 앱 안의 엔진을 앱 전용 폴더로 복사해요 (버전이 바뀌었을 때만)
    func prepare() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: Paths.bin, withIntermediateDirectories: true)
        let buildFile = Paths.bin.appendingPathComponent("build")
        let installed = (try? String(contentsOf: buildFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let want = build + "-native"
        if installed != want || !fm.isExecutableFile(atPath: Paths.engine.path) {
            guard let src = Bundle.main.url(forResource: "cutroad-engine", withExtension: nil) else {
                throw NSError(domain: "CUTROAD", code: 1, userInfo: [NSLocalizedDescriptionKey: "앱 안에서 엔진을 찾지 못했어요"])
            }
            let tmp = Paths.bin.appendingPathComponent("cutroad-engine.new")
            try? fm.removeItem(at: tmp)
            try fm.copyItem(at: src, to: tmp)
            chmod(tmp.path, 0o755)
            removexattr(tmp.path, "com.apple.quarantine", 0)
            if rename(tmp.path, Paths.engine.path) != 0 {
                throw NSError(domain: "CUTROAD", code: 2, userInfo: [NSLocalizedDescriptionKey: "엔진을 준비하지 못했어요"])
            }
            try want.write(to: buildFile, atomically: true, encoding: .utf8)
            Log.write("엔진 준비 (v\(build))")
        }
        removexattr(Paths.engine.path, "com.apple.quarantine", 0)
    }

    func request(_ method: String, port: Int, path: String, token: String, timeout: TimeInterval) -> Data? {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue(token, forHTTPHeaderField: "x-token")
        if method == "POST" {
            req.httpBody = "{}".data(using: .utf8)
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let sem = DispatchSemaphore(value: 0)
        var out: Data?
        let task = URLSession.shared.dataTask(with: req) { data, resp, _ in
            if let h = resp as? HTTPURLResponse, h.statusCode == 200 { out = data ?? Data() }
            sem.signal()
        }
        task.resume()
        if sem.wait(timeout: .now() + timeout + 0.5) == .timedOut { task.cancel() }
        return out
    }

    /// 이미 켜져 있는 엔진(예전 버전)이 있으면 끄고 새로 켜요
    func stopExisting() {
        guard let p = readText("port").flatMap({ Int($0) }), let t = readText("token") else { return }
        guard request("GET", port: p, path: "/api/ping", token: t, timeout: 1) != nil else { return }
        Log.write("이미 켜져 있던 엔진(포트 \(p))을 끄고 새로 켜요")
        _ = request("POST", port: p, path: "/api/quit", token: t, timeout: 2)
        for _ in 0..<40 {
            if request("GET", port: p, path: "/api/ping", token: t, timeout: 0.5) == nil { break }
            usleep(150_000)
        }
    }

    func start() throws {
        let fm = FileManager.default
        token = readText("token") ?? Engine.randomToken()
        try? fm.removeItem(at: Paths.file("port"))
        try? fm.removeItem(at: Paths.file("restart-requested"))

        let p = Process()
        p.executableURL = Paths.engine
        var env = ProcessInfo.processInfo.environment
        for k in ["CUTROAD_RESTART", "CUTROAD_PORT", "CUTROAD_CHILD", "CUTROAD_GRACE_SEC"] { env.removeValue(forKey: k) }
        env["CUTROAD_SUPERVISOR"] = "1"
        env["CUTROAD_SHELL"] = "native"
        env["CUTROAD_VIA"] = "native"
        env["CUTROAD_TOKEN"] = token
        env["CUTROAD_SUPPORT"] = Paths.support.path
        env["CUTROAD_APP"] = Bundle.main.bundlePath
        env["CUTROAD_PARENT_PID"] = String(getpid())
        env["CUTROAD_PORT_WAIT"] = "1"
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            DispatchQueue.main.async { self?.exited(code) }
        }
        try p.run()
        process = p
        Log.write("엔진 켬 (지킴이 pid \(p.processIdentifier))")
    }

    func waitForPort() -> Int? {
        for _ in 0..<100 {
            if let v = readText("port").flatMap({ Int($0) }) {
                port = v
                return v
            }
            usleep(150_000)
        }
        return nil
    }

    private func exited(_ code: Int32) {
        let restart = FileManager.default.fileExists(atPath: Paths.file("restart-requested").path)
        process = nil
        onExit?(code, restart)
    }

    func stop(completion: @escaping () -> Void) {
        guard let p = process, p.isRunning else { completion(); return }
        let port = self.port, token = self.token
        DispatchQueue.global(qos: .userInitiated).async {
            _ = self.request("POST", port: port, path: "/api/quit", token: token, timeout: 2)
            for _ in 0..<30 where p.isRunning { usleep(100_000) }
            if p.isRunning {
                p.terminate()
                for _ in 0..<20 where p.isRunning { usleep(100_000) }
            }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            DispatchQueue.main.async { completion() }
        }
    }

    static func randomToken() -> String {
        let chars = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<32).map { _ in chars[Int(arc4random_uniform(UInt32(chars.count)))] })
    }
}

// MARK: - 화면과 주고받기

/// 화면(app.js)에서 오는 부탁: window.webkit.messageHandlers.cutroad.postMessage({type: …})
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var app: AppDelegate?
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.securityOrigin.host == "127.0.0.1",
              let body = message.body as? [String: Any], let type = body["type"] as? String, let app = app else {
            replyHandler(nil, "허용되지 않은 요청이에요")
            return
        }
        // 오래 걸리는 일은 뒤에서 하고, 답은 언제나 메인 스레드에서 보내요
        let reply: ([String: Any]) -> Void = { v in DispatchQueue.main.async { replyHandler(v, nil) } }
        switch type {
        case "open": app.openFiles(kind: body["kind"] as? String ?? "", reply: reply)
        case "chooseFolder": app.chooseFolder(start: body["start"] as? String, purpose: body["purpose"] as? String ?? "", reply: reply)
        case "scanPhotos":
            let dir = body["path"] as? String ?? ""
            let rec = body["recursive"] as? Bool ?? true
            DispatchQueue.global(qos: .userInitiated).async { reply(["paths": Photos.scan(dir, recursive: rec)]) }
        case "beats":
            let path = body["path"] as? String ?? ""
            DispatchQueue.global(qos: .userInitiated).async { reply(Beats.analyze(path)) }
        case "reveal":
            if let p = body["path"] as? String { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)]) }
            reply(["ok": true])
        case "openFile":
            if let p = body["path"] as? String { NSWorkspace.shared.open(URL(fileURLWithPath: p)) }
            reply(["ok": true])
        case "probe":
            let paths = body["paths"] as? [String] ?? []
            DispatchQueue.global(qos: .userInitiated).async { reply(["items": Media.probeAll(paths)]) }
        case "thumbs":
            let path = body["path"] as? String ?? ""
            let height = body["height"] as? Double ?? 90
            DispatchQueue.global(qos: .utility).async { reply(Media.thumbnails(path, height: height)) }
        case "waveform":
            let path = body["path"] as? String ?? ""
            DispatchQueue.global(qos: .utility).async { reply(Media.waveform(path)) }
        case "export":
            reply(Jobs.shared.startExport(body["spec"] as? [String: Any] ?? [:]))
        case "captions":
            reply(Jobs.shared.startCaptions(body["spec"] as? [String: Any] ?? [:]))
        case "job":
            reply(Jobs.shared.snapshot(body["id"] as? String ?? ""))
        case "cancelJob":
            Jobs.shared.cancel(body["id"] as? String ?? "")
            reply(["ok": true])
        case "speechStatus":
            Captions.authorize { status in reply(["status": status]) }
        case "openSpeechSettings":
            if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition") {
                NSWorkspace.shared.open(u)
            }
            reply(["ok": true])
        case "diag":
            app.openDiag()
            reply(["ok": true])
        case "title":
            let t = body["title"] as? String ?? ""
            app.window.title = t.isEmpty ? "CUTROAD" : "\(t) — CUTROAD"
            reply(["ok": true])
        default: replyHandler(nil, "알 수 없는 요청이에요")
        }
    }
}

/// 파일을 창에 끌어다 놓으면, 경로를 화면에 알려 줘요 (웹 화면은 파일 경로를 알 수 없어서 여기서 받아요)
final class DropWebView: WKWebView {
    weak var app: AppDelegate?

    private func droppedPaths(_ info: NSDraggingInfo) -> [String] {
        let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.map { $0.path }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if !droppedPaths(sender).isEmpty {
            app?.callJS("window.cutroadDragHover && window.cutroadDragHover(true)")
            return .copy
        }
        return super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if !droppedPaths(sender).isEmpty { return .copy }
        return super.draggingUpdated(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        app?.callJS("window.cutroadDragHover && window.cutroadDragHover(false)")
        super.draggingExited(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if !droppedPaths(sender).isEmpty { return true }
        return super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let paths = droppedPaths(sender)
        if paths.isEmpty { return super.performDragOperation(sender) }
        app?.callJS("window.cutroadDragHover && window.cutroadDragHover(false)")
        app?.dropped(paths)
        return true
    }
}

// MARK: - 앱

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: DropWebView!
    let engine = Engine()
    var quitting = false
    var pageURL: URL?
    var pendingOpen: [String] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        if env["CUTROAD_RESTART"] == "1" && env["CUTROAD_RELAUNCHED"] != "1" {
            Log.write("직접 실행됨 → 정식 방법으로 다시 열어요")
            relaunch()
            return
        }
        Log.write("시작 v\(engine.build) · macOS \(ProcessInfo.processInfo.operatingSystemVersionString) · \(Bundle.main.bundlePath)")
        buildMenu()
        makeWindow()
        showLoading()
        engine.onExit = { [weak self] code, restart in self?.engineExited(code: code, restart: restart) }
        boot()
    }

    // Finder 에서 영상 파일을 CUTROAD 아이콘에 끌어다 놓은 경우
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        dropped(filenames)
        sender.reply(toOpenOrPrint: .success)
    }

    func boot() {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try self.engine.prepare()
                self.engine.stopExisting()
                try self.engine.start()
                guard let port = self.engine.waitForPort() else {
                    throw NSError(domain: "CUTROAD", code: 3, userInfo: [NSLocalizedDescriptionKey: "엔진이 준비되지 않았어요"])
                }
                Log.write("엔진 준비됨 (포트 \(port))")
                DispatchQueue.main.async { self.loadApp(port: port) }
            } catch {
                Log.write("⚠️ 시작 실패: \(error.localizedDescription)")
                DispatchQueue.main.async { self.startFailed(error) }
            }
        }
    }

    func loadApp(port: Int) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/?t=\(engine.token)") else { return }
        pageURL = url
        web.load(URLRequest(url: url))
    }

    func startFailed(_ error: Error) {
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "CUTROAD를 시작하지 못했어요"
        a.informativeText = "\(error.localizedDescription)\n앱을 다시 실행해 보세요. 계속 안 되면 맥을 재시동한 뒤 시도해 주세요."
        a.addButton(withTitle: "다시 시도")
        a.addButton(withTitle: "종료")
        if a.runModal() == .alertFirstButtonReturn {
            boot()
        } else {
            quitting = true
            NSApp.terminate(nil)
        }
    }

    func engineExited(code: Int32, restart: Bool) {
        if quitting { return }
        if restart {
            relaunch()
            return
        }
        Log.write("엔진이 끝나서 앱도 닫아요 (코드 \(code))")
        quitting = true
        NSApp.terminate(nil)
    }

    func relaunch() {
        Log.write("새 버전으로 다시 열어요")
        quitting = true
        let appURL = URL(fileURLWithPath: Bundle.main.bundlePath)
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        cfg.activates = true
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "CUTROAD_RESTART")
        env["CUTROAD_RELAUNCHED"] = "1"
        cfg.environment = env
        unsetenv("CUTROAD_RESTART")
        NSWorkspace.shared.openApplication(at: appURL, configuration: cfg) { _, error in
            if let error = error { Log.write("⚠️ 다시 열지 못했어요: \(error.localizedDescription)") }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMain() }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Jobs.shared.cancelAll()
        guard engine.process != nil else { return .terminateNow }
        quitting = true
        Log.write("종료: 엔진을 끄는 중")
        engine.stop {
            Log.write("종료 완료")
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    // MARK: 창

    func makeWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.applicationNameForUserAgent = "CUTROADShell/\(engine.build)"
        cfg.mediaTypesRequiringUserActionForPlayback = []
        if #available(macOS 12.3, *) { cfg.preferences.isElementFullscreenEnabled = true }
        let bridge = Bridge()
        bridge.app = self
        cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "cutroad")
        web = DropWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: cfg)
        web.app = self
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = false
        if #available(macOS 13.3, *) { web.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "CUTROAD"
        window.minSize = NSSize(width: 1080, height: 700)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.delegate = self
        window.contentView = web
        if !window.setFrameUsingName("CUTROADMain") { window.center() }
        window.setFrameAutosaveName("CUTROADMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func showLoading() {
        let html = """
        <!doctype html><meta charset="utf-8"><style>
        :root{color-scheme:light dark}
        body{margin:0;height:100vh;display:grid;place-items:center;font:600 14px -apple-system,"Apple SD Gothic Neo",sans-serif;
             background:#F3F3F1;color:#4F5460}
        @media (prefers-color-scheme: dark){body{background:#0E0F12;color:#A2A8B3}}
        .w{display:flex;flex-direction:column;align-items:center;gap:14px}
        .s{width:22px;height:22px;border-radius:50%;border:2.5px solid rgba(128,128,140,.3);border-top-color:#FF5A1F;animation:r .9s linear infinite}
        @keyframes r{to{transform:rotate(360deg)}}
        </style><div class="w"><div class="s"></div>CUTROAD 준비 중…</div>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    @objc func showMain() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func openDiag() {
        if engine.port > 0, let u = URL(string: "http://127.0.0.1:\(engine.port)/diag") { NSWorkspace.shared.open(u) }
    }

    @objc func reloadPage() {
        if let u = pageURL { web.load(URLRequest(url: u)) }
    }

    func callJS(_ js: String) {
        DispatchQueue.main.async { self.web.evaluateJavaScript(js, completionHandler: nil) }
    }

    static func jsonString(_ v: Any) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: v), let s = String(data: d, encoding: .utf8) else { return "null" }
        return s
    }

    /// 끌어다 놓은 파일 · Finder 에서 연 파일을 화면에 넘겨요 (화면이 아직 준비되지 않았으면 기다렸다가)
    func dropped(_ paths: [String]) {
        let ok = paths.filter { Media.allowedExtensions.contains(URL(fileURLWithPath: $0).pathExtension.lowercased()) }
        let skipped = paths.count - ok.count
        Log.write("파일 받음: \(ok.count)개" + (skipped > 0 ? " (지원하지 않는 파일 \(skipped)개)" : ""))
        if pageURL == nil || web.isLoading {
            pendingOpen.append(contentsOf: ok)
            return
        }
        callJS("window.cutroadDropped && window.cutroadDropped(\(AppDelegate.jsonString(ok)), \(skipped))")
    }

    @objc func menuAction(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        showMain()
        callJS("window.cutroadMenu && window.cutroadMenu(\(AppDelegate.jsonString(id)))")
    }

    // MARK: 파일 고르기

    func openFiles(kind: String, reply: @escaping ([String: Any]) -> Void) {
        let panel = NSOpenPanel()
        let audio = kind == "audio" || kind == "music"
        panel.allowsMultipleSelection = kind != "music"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowedContentTypes = (audio ? Media.audioExtensions : Media.allowedExtensions).compactMap { UTType(filenameExtension: $0) }
        panel.message = audio ? "배경음악으로 쓸 소리 파일을 골라 주세요 (MP3 · WAV · M4A)"
            : "가져올 영상 · 소리 · 사진을 골라 주세요 (MOV · MP4 · MP3 · WAV · M4A · JPG · PNG · HEIC)"
        panel.prompt = audio ? "고르기" : "가져오기"
        showMain()
        panel.beginSheetModal(for: window) { r in
            reply(["paths": r == .OK ? panel.urls.map { $0.path } : []])
        }
    }

    func chooseFolder(start: String?, purpose: String, reply: @escaping ([String: Any]) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        let photos = purpose == "photos"
        panel.canCreateDirectories = !photos
        panel.prompt = photos ? "이 폴더의 사진 쓰기" : "이 폴더에 저장"
        panel.message = photos ? "영상으로 만들 사진이 들어 있는 폴더를 골라 주세요" : "내보낸 파일을 저장할 폴더를 골라 주세요"
        if let s = start { panel.directoryURL = URL(fileURLWithPath: s, isDirectory: true) }
        showMain()
        panel.beginSheetModal(for: window) { r in
            reply(["path": r == .OK ? (panel.url?.path ?? "") : ""])
        }
    }

    // MARK: WKWebView

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard pageURL != nil, !pendingOpen.isEmpty else { return }
        let paths = pendingOpen
        pendingOpen = []
        // 화면 스크립트가 준비될 시간을 조금 줘요
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            self.callJS("window.cutroadDropped && window.cutroadDropped(\(AppDelegate.jsonString(paths)), 0)")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = action.request.url else { decisionHandler(.allow); return }
        let scheme = u.scheme ?? ""
        if scheme == "about" || scheme == "data" || scheme == "blob" || u.host == "127.0.0.1" || u.host == "localhost" {
            decisionHandler(.allow)
            return
        }
        NSWorkspace.shared.open(u)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard pageURL != nil, !quitting else { return }
        Log.write("⚠️ 화면을 불러오지 못함: \(error.localizedDescription) → 다시 시도")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.reloadPage() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Log.write("⚠️ 화면 프로세스가 멈춤 → 다시 불러와요")
        reloadPage()
    }

    func webViewDidClose(_ webView: WKWebView) {
        window.orderOut(nil)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "확인")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "확인")
        a.addButton(withTitle: "취소")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    // MARK: 메뉴

    func item(_ title: String, _ id: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
        it.keyEquivalentModifierMask = mods
        it.representedObject = id
        it.target = self
        return it
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "CUTROAD에 관하여", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(item("설정…", "settings", ","))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "CUTROAD 가리기", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "기타 가리기", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "모두 보기", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "CUTROAD 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let file = NSMenu(title: "파일")
        file.addItem(item("새 프로젝트", "new", "n"))
        file.addItem(item("사진으로 영상 만들기…", "automake", "n", [.command, .shift]))
        file.addItem(item("처음 화면", "home", "o"))
        file.addItem(NSMenuItem.separator())
        file.addItem(item("가져오기…", "import", "i"))
        file.addItem(item("내보내기…", "export", "e"))
        fileItem.submenu = file

        // 편집 메뉴: 글자 칸에서는 맥 기본 동작, 타임라인에서는 화면이 ⌘Z · ⌘B 등을 직접 처리해요
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "편집")
        edit.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "실행 복귀", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "오려두기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "복사하기", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "모두 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "보기")
        view.addItem(item("전체 편집", "mode-full", "1"))
        view.addItem(item("컷 편집만", "mode-quick", "2"))
        view.addItem(NSMenuItem.separator())
        let fs = view.addItem(withTitle: "전체 화면", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        view.addItem(NSMenuItem.separator())
        let diag = view.addItem(withTitle: "진단 정보 보기", action: #selector(openDiag), keyEquivalent: "")
        diag.target = self
        viewItem.submenu = view

        let winItem = NSMenuItem()
        main.addItem(winItem)
        let win = NSMenu(title: "윈도우")
        win.addItem(withTitle: "최소화", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "확대/축소", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        win.addItem(withTitle: "닫기", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(NSMenuItem.separator())
        let show = win.addItem(withTitle: "CUTROAD 창 보기", action: #selector(showMain), keyEquivalent: "")
        show.target = self
        winItem.submenu = win

        let helpItem = NSMenuItem()
        main.addItem(helpItem)
        let help = NSMenu(title: "도움말")
        help.addItem(item("단축키 보기", "shortcuts", "/"))
        helpItem.submenu = help

        NSApp.mainMenu = main
        NSApp.windowsMenu = win
        NSApp.helpMenu = help
    }
}

// MARK: - 시작

// 시험용 명령 (맥 빌드 서버의 시험에서 써요): CUTROAD --test-… (TestTools.swift)
if let code = TestTools.run(CommandLine.arguments) {
    exit(code)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
