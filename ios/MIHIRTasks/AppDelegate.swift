import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
        // If iOS relaunched the app for a location event while a work session was on, keep going.
        LocationTracker.shared.resumeIfConfigured()
        return true
    }
}
