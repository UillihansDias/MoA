import SwiftUI
import WebKit

private let moaURL = URL(string: "http://127.0.0.1:4317")!
private let darkWindowBackground = NSColor(srgbRed: 6 / 255, green: 16 / 255, blue: 24 / 255, alpha: 1)
private let lightWindowBackground = NSColor(srgbRed: 245 / 255, green: 248 / 255, blue: 250 / 255, alpha: 1)

private func color(from hex: String) -> NSColor? {
    let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard value.count == 6, let rgb = UInt64(value, radix: 16) else { return nil }
    return NSColor(
        srgbRed: CGFloat((rgb >> 16) & 0xff) / 255,
        green: CGFloat((rgb >> 8) & 0xff) / 255,
        blue: CGFloat(rgb & 0xff) / 255,
        alpha: 1
    )
}

@main
struct MoAApp: App {
    @State private var isLightTheme = false
    @State private var windowBackgroundColor = darkWindowBackground

    var body: some Scene {
        WindowGroup("MoA") {
            ZStack {
                Color(nsColor: windowBackgroundColor)
                    .ignoresSafeArea()

                MoAWebView(url: moaURL, isLightTheme: $isLightTheme, windowBackgroundColor: $windowBackgroundColor)
            }
            .preferredColorScheme(isLightTheme ? .light : .dark)
            .frame(minWidth: 980, minHeight: 640)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 900)
    }
}

private struct MoAWebView: NSViewRepresentable {
    let url: URL
    @Binding var isLightTheme: Bool
    @Binding var windowBackgroundColor: NSColor

    func makeCoordinator() -> Coordinator {
        Coordinator(isLightTheme: $isLightTheme, windowBackgroundColor: $windowBackgroundColor)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(context.coordinator, name: "themeChanged")
        configuration.userContentController.add(context.coordinator, name: "chooseWorkspace")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = windowBackgroundColor
        webView.allowsMagnification = true
        context.coordinator.startServiceAndLoad(url)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        webView.underPageBackgroundColor = windowBackgroundColor

        guard webView.url == nil else { return }
        context.coordinator.startServiceAndLoad(url)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "themeChanged")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "chooseWorkspace")
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        coordinator.cancelRetry()
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        private var isLightTheme: Binding<Bool>
        private var windowBackgroundColor: Binding<NSColor>
        private var serviceStartInProgress = false
        private var retryWorkItem: DispatchWorkItem?

        init(isLightTheme: Binding<Bool>, windowBackgroundColor: Binding<NSColor>) {
            self.isLightTheme = isLightTheme
            self.windowBackgroundColor = windowBackgroundColor
        }

        func startServiceAndLoad(_ url: URL) {
            guard !serviceStartInProgress else { return }
            serviceStartInProgress = true
            retryWorkItem?.cancel()

            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let script = FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent(".MoA/service-manager.sh")
                if FileManager.default.isExecutableFile(atPath: script.path) {
                    let process = Process()
                    process.executableURL = URL(fileURLWithPath: "/bin/bash")
                    process.arguments = [script.path, "start"]
                    process.standardOutput = FileHandle.nullDevice
                    process.standardError = FileHandle.nullDevice
                    try? process.run()
                    process.waitUntilExit()
                }

                DispatchQueue.main.async {
                    guard let self else { return }
                    self.serviceStartInProgress = false
                    self.webView?.load(URLRequest(
                        url: url,
                        cachePolicy: .reloadIgnoringLocalCacheData,
                        timeoutInterval: 15
                    ))
                }
            }
        }

        func cancelRetry() {
            retryWorkItem?.cancel()
            retryWorkItem = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            cancelRetry()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            scheduleRetry()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            scheduleRetry()
        }

        private func scheduleRetry() {
            retryWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                self?.startServiceAndLoad(moaURL)
            }
            retryWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75, execute: workItem)
        }

        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping ([URL]?) -> Void
        ) {
            let panel = NSOpenPanel()
            panel.title = "Add documents and images"
            panel.message = "Choose up to 10 files to include as task context."
            panel.prompt = "Add"
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.begin { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "chooseWorkspace" {
                let panel = NSOpenPanel()
                panel.title = "Choose a workspace"
                panel.message = "Select the project folder MoA should work in."
                panel.prompt = "Choose"
                panel.canChooseFiles = false
                panel.canChooseDirectories = true
                panel.allowsMultipleSelection = false
                panel.canCreateDirectories = true
                panel.begin { [weak self] response in
                    let selectedPath = response == .OK ? panel.url?.path : nil
                    self?.sendWorkspaceSelection(selectedPath)
                }
                return
            }

            guard message.name == "themeChanged" else { return }

            if let theme = message.body as? String {
                isLightTheme.wrappedValue = theme == "light"
                windowBackgroundColor.wrappedValue = theme == "light" ? lightWindowBackground : darkWindowBackground
                return
            }

            guard let appearance = message.body as? [String: Any],
                  let theme = appearance["theme"] as? String else { return }
            isLightTheme.wrappedValue = theme == "light"
            if let hex = appearance["background"] as? String, let background = color(from: hex) {
                windowBackgroundColor.wrappedValue = background
            } else {
                windowBackgroundColor.wrappedValue = theme == "light" ? lightWindowBackground : darkWindowBackground
            }
        }

        private func sendWorkspaceSelection(_ path: String?) {
            let value: String
            if let path,
               let data = try? JSONSerialization.data(withJSONObject: path, options: .fragmentsAllowed),
               let encoded = String(data: data, encoding: .utf8) {
                value = encoded
            } else {
                value = "null"
            }
            webView?.evaluateJavaScript("window.__moaWorkspaceSelected?.(\(value))")
        }
    }
}
