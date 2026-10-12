import UIKit
import WebKit

/// The MIHIR website in a WKWebView, plus a small bridge the site uses for work-session location:
///   window.webkit.messageHandlers.mihirNative.postMessage({cmd: 'locationStart', config: {...}})
///   … {cmd: 'locationStop'} / {cmd: 'locationStatus'}
/// Results go back through window.__mihirLocationResult('started'|'denied') and
/// window.__mihirNativeStatusUpdate({...}) — the same contract as the Android app.
final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private let siteURL: URL = {
        let s = (Bundle.main.object(forInfoDictionaryKey: "MIHIRSiteURL") as? String) ?? "https://mihir-task-manager.onrender.com"
        return URL(string: s)!
    }()

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(WeakHandler(self), name: "mihirNative")
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "MihirTasksIOS/1.0"
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: siteURL))
        LocationTracker.shared.onResult = { [weak self] result in self?.js("window.__mihirLocationResult && window.__mihirLocationResult('\(result)')") }
        LocationTracker.shared.onStatus = { [weak self] status in
            guard let data = try? JSONSerialization.data(withJSONObject: status), let json = String(data: data, encoding: .utf8) else { return }
            self?.js("window.__mihirNativeStatusUpdate && window.__mihirNativeStatusUpdate(\(json))")
        }
    }

    private func js(_ code: String) { DispatchQueue.main.async { self.webView.evaluateJavaScript(code, completionHandler: nil) } }

    // MARK: bridge
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only our own site may drive the bridge.
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == siteURL.host,
              let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "locationStart":
            guard let cfg = body["config"] as? [String: Any],
                  let upload = cfg["uploadUrl"] as? String, let u = URL(string: upload), u.host == siteURL.host, u.scheme == "https" else { return }
            LocationTracker.shared.start(config: cfg)
        case "locationStop":
            LocationTracker.shared.stop(reason: "page")
        case "locationStatus":
            LocationTracker.shared.publishStatus()
        default:
            break
        }
    }

    // MARK: navigation — keep our site in the app, open everything else outside
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        if url.host == siteURL.host || ["about", "data", "blob"].contains(url.scheme ?? "") { return decisionHandler(.allow) }
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }
    // window.open / target=_blank
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }
    // alert() / confirm() / prompt() used by the site
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        present(a, animated: true)
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}
