# MIHIR Tasks — iOS app (work-session location)

A thin WKWebView shell around the MIHIR website (like the Android app) that adds background
location for **work sessions the employee starts**. See `docs/LOCATION_MOBILE.md` for the full
build, permission and test guide.

**Status: source only.** This code was written without access to a Mac/Xcode, so it has **not been
compiled or run**. Expect to fix small compile issues the first time you build it.

Build (on a Mac with Xcode 15+):
```
brew install xcodegen
cd ios && xcodegen generate
open MIHIRTasks.xcodeproj   # set your Team under Signing & Capabilities, then Run on a device
```
Distribute with TestFlight / Apple Business Manager (custom app) — needs an Apple Developer account.
