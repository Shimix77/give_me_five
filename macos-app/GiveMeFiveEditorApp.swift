import AppKit
import WebKit
import Darwin

private enum EditorError: LocalizedError {
    case missingResource(String)
    case localEngineDidNotStart

    var errorDescription: String? {
        switch self {
        case .missingResource(let name):
            return "V aplikácii chýba potrebná súčasť: \(name)."
        case .localEngineDidNotStart:
            return "Lokálny video engine sa nespustil. Skúste aplikáciu zavrieť a otvoriť znova."
        }
    }
}

// Krátky lokálny záznam štartu. Ak macOS nedovolí aplikácii spustiť engine,
// používateľ ani test nezostanú bez konkrétneho dôvodu zlyhania.
private func bootLog(_ message: String) {
    let line = "[Give Me Five Editor] \(message)\n"
    NSLog("%@", line)
    let logDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Give Me Five Editor", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let logURL = logDirectory.appendingPathComponent("launch.log")
        if FileManager.default.fileExists(atPath: logURL.path) {
            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            try handle.write(contentsOf: Data(line.utf8))
            try handle.close()
        } else {
            try Data(line.utf8).write(to: logURL, options: .atomic)
        }
    } catch {
        NSLog("Give Me Five Editor nemôže zapísať štartovací log: %@", error.localizedDescription)
    }
}

private final class LocalEngine {
    private var process: Process?
    private var outputHandle: FileHandle?
    private let port: Int

    init() {
        port = Self.reserveLoopbackPort()
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    private static func reserveLoopbackPort() -> Int {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return 4173 }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(0).bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else { return 4173 }
        var boundAddress = address
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        guard getsockname(descriptor, withUnsafeMutablePointer(to: &boundAddress) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { $0 }
        }, &length) == 0 else { return 4173 }
        return Int(UInt16(bigEndian: boundAddress.sin_port))
    }

    func start() throws {
        guard process == nil else { return }
        bootLog("Spúšťam lokálny engine na porte \(port).")
        guard let resources = Bundle.main.resourceURL else {
            throw EditorError.missingResource("Resources")
        }
        let engineURL = resources.appendingPathComponent("engine", isDirectory: true)
        let nodeURL = engineURL.appendingPathComponent("runtime/node")
        let serverURL = engineURL.appendingPathComponent("server.js")
        guard FileManager.default.isExecutableFile(atPath: nodeURL.path) else {
            throw EditorError.missingResource("lokálny Node runtime")
        }
        guard FileManager.default.fileExists(atPath: serverURL.path) else {
            throw EditorError.missingResource("video engine")
        }

        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("Give Me Five Editor", isDirectory: true)
        let workURL = appSupport.appendingPathComponent("work", isDirectory: true)
        try FileManager.default.createDirectory(at: workURL, withIntermediateDirectories: true)

        let logDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Give Me Five Editor", isDirectory: true)
        try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let engineLogURL = logDirectory.appendingPathComponent("engine.log")
        FileManager.default.createFile(atPath: engineLogURL.path, contents: nil)
        let logHandle = try FileHandle(forWritingTo: engineLogURL)
        try logHandle.seekToEnd()

        let engine = Process()
        engine.executableURL = nodeURL
        engine.arguments = [serverURL.path]
        engine.currentDirectoryURL = engineURL
        var environment = ProcessInfo.processInfo.environment
        environment["GMF_OPEN_BROWSER"] = "0"
        environment["GMF_PORT"] = String(port)
        environment["GMF_WORK_DIR"] = workURL.path
        environment["GMF_MODEL_DIR"] = resources.appendingPathComponent("models", isDirectory: true).path
        environment["GMF_FFMPEG_PATH"] = engineURL.appendingPathComponent("bin/ffmpeg").path
        environment["GMF_FFPROBE_PATH"] = engineURL.appendingPathComponent("bin/ffprobe").path
        engine.environment = environment

        engine.standardOutput = logHandle
        engine.standardError = logHandle
        engine.terminationHandler = { finishedEngine in
            bootLog("Lokálny engine sa ukončil (dôvod \(finishedEngine.terminationReason.rawValue), stav \(finishedEngine.terminationStatus)). Podrobnosti: \(engineLogURL.path)")
        }
        try engine.run()
        process = engine
        outputHandle = logHandle
        bootLog("Lokálny engine bol spustený.")
    }

    func waitUntilReady(completion: @escaping (Result<URL, Error>) -> Void) {
        let deadline = Date().addingTimeInterval(25)
        func attempt() {
            if self.process?.isRunning != true {
                completion(.failure(EditorError.localEngineDidNotStart))
                return
            }
            var request = URLRequest(url: self.baseURL.appendingPathComponent("api/health"))
            request.timeoutInterval = 1.5
            URLSession.shared.dataTask(with: request) { _, response, _ in
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    DispatchQueue.main.async { completion(.success(self.baseURL)) }
                } else if Date() < deadline {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.35, execute: attempt)
                } else {
                    DispatchQueue.main.async { completion(.failure(EditorError.localEngineDidNotStart)) }
                }
            }.resume()
        }
        attempt()
    }

    func stop() {
        guard let process else { return }
        if process.isRunning { process.terminate() }
        self.process = nil
        try? outputHandle?.close()
        outputHandle = nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private let engine = LocalEngine()
    private var window: NSWindow!
    private var webView: WKWebView!
    private var allowClose = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        bootLog("applicationDidFinishLaunching bolo zavolané.")
        NSApp.setActivationPolicy(.regular)
        NSApp.applicationIconImage = makeAppIcon()
        buildWindow()
        showPreparingScreen()
        do {
            try engine.start()
            engine.waitUntilReady { [weak self] result in
                switch result {
                case .success(let url): self?.webView.load(URLRequest(url: url))
                case .failure(let error):
                    bootLog("Lokálny engine neodpovedal: \(error.localizedDescription)")
                    self?.showFatalError(error)
                }
            }
        } catch {
            bootLog("Štart lokálneho enginu zlyhal: \(error.localizedDescription)")
            showFatalError(error)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        engine.stop()
    }

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "gmfDownload")
        configuration.preferences.isElementFullscreenEnabled = true

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Give Me Five Editor"
        window.minSize = NSSize(width: 1120, height: 720)
        window.center()
        window.contentView = webView
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeAppIcon() -> NSImage {
        let size = NSSize(width: 512, height: 512)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor(calibratedRed: 0.05, green: 0.12, blue: 0.23, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 112, yRadius: 112).fill()
        NSColor(calibratedRed: 0.39, green: 0.64, blue: 1, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 28, y: 28, width: 456, height: 456), xRadius: 94, yRadius: 94).fill()
        let label = "5" as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 330, weight: .heavy),
            .foregroundColor: NSColor(calibratedWhite: 1, alpha: 0.96)
        ]
        let bounds = label.boundingRect(with: size, options: .usesLineFragmentOrigin, attributes: attributes)
        label.draw(at: NSPoint(x: (size.width - bounds.width) / 2, y: (size.height - bounds.height) / 2 - 26), withAttributes: attributes)
        image.unlockFocus()
        return image
    }

    private func showPreparingScreen() {
        let html = """
        <html><body style=\"margin:0;background:#091423;color:#f6f8ff;font-family:-apple-system;display:grid;place-items:center;height:100vh\">
        <div style=\"text-align:center\"><div style=\"font-size:84px;font-weight:800;color:#6fa5ff\">5</div><h1>Pripravujem Give Me Five Editor</h1><p style=\"color:#aebbd0\">Spúšťam lokálny video engine. Vaše médiá zostávajú v tomto Macu.</p></div>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func showFatalError(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Editor sa nepodarilo spustiť"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "Zavrieť")
        alert.runModal()
        NSApp.terminate(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !allowClose else { return true }
        webView.evaluateJavaScript("Boolean(window.state && (state.renderedPreview?.rendering || state.exporting))") { [weak self] value, _ in
            guard let self else { return }
            if (value as? Bool) == true {
                let alert = NSAlert()
                alert.alertStyle = .warning
                alert.messageText = "Prebieha spracovanie videa"
                alert.informativeText = "Zatvorením aplikácie sa render zruší a dočasné video aj hudba sa vymažú. Prečo: tieto súbory zostávajú iba lokálne pre ochranu súkromia."
                alert.addButton(withTitle: "Pokračovať v renderi")
                alert.addButton(withTitle: "Zrušiť a zavrieť")
                if alert.runModal() == .alertSecondButtonReturn {
                    self.allowClose = true
                    self.engine.stop()
                    sender.close()
                }
            } else {
                self.allowClose = true
                self.engine.stop()
                sender.close()
            }
        }
        return false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.canShowMIMEType {
            decisionHandler(.allow)
        } else {
            decisionHandler(.download)
        }
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // WKWebView v samostatnej macOS aplikácii neotvorí výber súboru sám.
    // Webové tlačidlá „Vybrať video“ a „Vybrať audio“ preto odovzdáme
    // natívnemu NSOpenPanelu. Súbor ostáva lokálny; aplikácia dostane iba
    // adresu, ktorú následne odošle svojmu loopback enginu.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        // WKOpenPanelParameters v podporovaných macOS SDK neposkytuje HTML
        // `accept` hodnotu. Zobrazíme preto iba povolené média; konkrétne
        // tlačidlo v editore následne bezpečne určí, či je to video alebo hudba.
        panel.title = "Vyberte video alebo hudbu"
        panel.message = "Video: MOV alebo MP4, maximálne 90 sekúnd. Hudba: MP3, WAV alebo M4A."
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        panel.allowedContentTypes = [.movie, .audio]

        guard panel.runModal() == .OK else {
            completionHandler(nil)
            return
        }
        completionHandler(panel.urls)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "gmfDownload",
              let body = message.body as? [String: Any],
              let address = body["url"] as? String,
              let url = URL(string: address)
        else { return }
        var request = URLRequest(url: url)
        if let sessionId = body["sessionId"] as? String {
            request.setValue(sessionId, forHTTPHeaderField: "X-GMF-Session")
        }
        let task = URLSession.shared.downloadTask(with: request) { [weak self] temporaryURL, _, error in
            guard let self else { return }
            if let error {
                DispatchQueue.main.async { self.presentDownloadError(error) }
                return
            }
            guard let temporaryURL else { return }
            DispatchQueue.main.async {
                self.saveDownloadedFile(temporaryURL, suggestedName: body["filename"] as? String ?? "give_me_five_edited.mp4")
            }
        }
        task.resume()
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.title = "Kam uložiť hotové MP4?"
        panel.message = "Vyberte priečinok pre výsledné video. Prečo: miesto exportu neurčujeme automaticky, aby ste mali nad súborom kontrolu."
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        panel.allowedContentTypes = [.mpeg4Movie]
        completionHandler(panel.runModal() == .OK ? panel.url : nil)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first {
            NSWorkspace.shared.open(downloads)
        }
    }

    private func saveDownloadedFile(_ temporaryURL: URL, suggestedName: String) {
        let panel = NSSavePanel()
        panel.title = "Kam uložiť hotové MP4?"
        panel.message = "Vyberte priečinok pre výsledné video. Prečo: miesto exportu neurčujeme automaticky, aby ste mali nad súborom kontrolu."
        panel.nameFieldStringValue = suggestedName
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        panel.allowedContentTypes = [.mpeg4Movie]
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            try FileManager.default.removeItem(at: destination)
        } catch { }
        do {
            try FileManager.default.moveItem(at: temporaryURL, to: destination)
            NSWorkspace.shared.activateFileViewerSelecting([destination])
        } catch {
            presentDownloadError(error)
        }
    }

    private func presentDownloadError(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Hotové video sa nepodarilo uložiť"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "Rozumiem")
        alert.runModal()
    }
}

// `@main` na triede implementujúcej NSApplicationDelegate síce vytvorí
// macOS proces, ale pri samostatne kompilovanej AppKit aplikácii nemusí túto
// triedu priradiť ako delegate. Výsledok bol prázdne okno bez lokálneho
// Node/FFmpeg enginu. Vlastný vstupný bod lifecycle nastaví jednoznačne.
@main
struct GiveMeFiveEditorMain {
    static func main() {
        bootLog("Vstupný bod aplikácie bol spustený.")
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        bootLog("AppDelegate je priradený, vstupujem do AppKit event loop.")
        application.run()
        withExtendedLifetime(delegate) {}
    }
}
