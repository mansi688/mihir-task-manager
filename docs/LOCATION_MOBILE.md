# Mobile apps — background location for work sessions

Browsers cannot record location in the background, so background tracking needs the phone apps.
Both apps are thin shells around the website (every website update reaches them automatically) plus
a native location component. They talk to the page through one bridge with the same contract:

| Page → app | App → page |
|---|---|
| `locationStart(config)` → `"ok"` / `"asking"` / `"denied"` | `window.__mihirLocationResult('started' \| 'denied')` |
| `locationStop()` | `window.__mihirNativeStatusUpdate({running, queued, lastFixAt, lastAccuracy, permission, gpsEnabled})` (iOS) |
| `locationStatus()` → JSON (Android) | |

`config` = `{ uploadUrl, sightingsUrl, token (upload token), sessionId, config: {movingIntervalSec, stationaryIntervalSec, distanceFilterM, uploadEverySec, indoor: {enabled, uuids}} }`.
The app refuses an `uploadUrl` that is not HTTPS on the site's own host.

## 1. Android (version 1.5, versionCode 6)

Files: `android/src/com/mihir/taskmanager/LocationService.java` (foreground service),
`PointStore.java` (SQLite offline queue), `BeaconParser.java`, bridge methods in `MainActivity.java`,
`AndroidManifest.xml`.

- **Foreground service, type `location`**, started only from the visible app when the employee
  taps Start. A permanent notification "Sharing location — work session on" with a **Stop work
  session** button is shown the whole time (tapping Stop also ends the session on the server).
- **Permissions requested**: `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` (the normal "While
  using the app" dialog), `POST_NOTIFICATIONS` (Android 13+), `BLUETOOTH_SCAN` (Android 12+, only if
  the company has indoor beacons). **`ACCESS_BACKGROUND_LOCATION` ("Allow all the time") is NOT
  requested** — a location foreground service started from the app counts as "while in use".
- **Battery**: GPS + network every `movingIntervalSec` (default 15 s, ≥ 20 m) while moving; after
  ~3 min without moving: every `stationaryIntervalSec` (120 s, ≥ 50 m); back to fast as soon as it
  moves. Duplicate fixes from two providers are merged; fixes worse than 500 m are dropped.
  Uploads are batched every `uploadEverySec` (60 s). No Google Play services dependency.
- **Offline**: every fix goes to SQLite first; deleted only after the server answers (accepted,
  duplicate or refused). Network errors / 5xx / 429 → kept and retried with backoff (30 s → 10 min).
  Up to 20,000 fixes (~5 days) are kept; oldest dropped beyond that. Fixes recorded in an earlier
  session keep that session's token and are still uploaded to it.
- **Stops itself** when the server says the session ended (stopped on the web, auto-stop, Admin) or
  the token is revoked (password change).
- **Indoor**: if beacon UUIDs are configured, scans BLE for 4 s every 30 s and sends iBeacons heard.
- Not restarted at phone boot (by design — tracking must be visibly started by the employee). If a
  session is still on after a reboot, opening the app resumes it.

### Building the APK

The existing script builds without Android Studio/Gradle, but needs an **API 29+ `android.jar`**
(for `foregroundServiceType`). Use the one from Android Studio's SDK:

```
sudo apt install openjdk-17-jdk-headless aapt dalvik-exchange zipalign apksigner
ANDROID_JAR=$HOME/Android/Sdk/platforms/android-34/android.jar VERSION_CODE=6 VERSION_NAME=1.5 ./android/build-apk.sh
./android/test.sh          # JVM unit test (iBeacon parser)
```

The included `android/MIHIR-Tasks.apk` (1.5) was built this way and signed with the existing
`mihir-tasks.keystore`, so it installs as an update over 1.4. Verified here with `aapt`: manifest has
`LocationService` with `foregroundServiceType=location (0x8)`, targetSdk 34, the permissions above,
and the same signing certificate (SHA-256 `7739b502…49cb`) as the previous APK. **It has not been run
on a phone in this environment.** (The `android.jar` used for that build came from the public
`Sable/android-platforms` mirror because Google's SDK download is not reachable from this
environment; for your release builds use the official SDK.)

> ⚠️ **Security:** `android/mihir-tasks.keystore` and its password (in `build-apk.sh`) are committed to
> a **public** GitHub repository. Anyone can sign a fake "update" that Android would accept over your
> app — more serious now that the app records location. Recommended: make the repo private, move the
> keystore and password out of git (e.g. a password manager / CI secret). Rotating the key forces
> everyone to uninstall and reinstall once (Android does not allow a key change for side-loaded apps).

### Phone settings employees may need

- Xiaomi / Redmi / POCO: Settings → Apps → MIHIR Tasks → Battery saver → **No restrictions**; Autostart **on**.
- Vivo / iQOO: Settings → Battery → Background power consumption → MIHIR Tasks → **Allow**.
- Oppo / Realme / OnePlus: Settings → Battery → MIHIR Tasks → **Allow background activity**.
- Samsung: Settings → Battery → Background usage limits → **Never sleeping apps** → add MIHIR Tasks.
The My Location page shows an "Allow MIHIR to run in the background" link when Android reports the
app is battery-optimised.

## 2. iOS (source only)

Files in `ios/` (XcodeGen spec `project.yml`, Swift sources). **Written without a Mac/Xcode — not
compiled or run.** Expect to fix small compile errors on the first build.

- WKWebView shell + `mihirNative` message handler (only accepts messages from the site's own host).
- `LocationTracker`: "When In Use" permission, `allowsBackgroundLocationUpdates = true`,
  `showsBackgroundLocationIndicator = true` (blue pill = visible status), `UIBackgroundModes: location`.
  Best accuracy + distance filter while moving; 100 m / 50 m when stationary ~3 min. Uploads in
  batches from location callbacks (timers don't run when suspended). Offline queue: JSON file in
  Application Support (file protection until first unlock).
- iBeacon ranging for configured UUIDs (iOS ranges in the background only while location updates
  are active — to be verified on devices).

Build: `brew install xcodegen && cd ios && xcodegen generate && open MIHIRTasks.xcodeproj`, set your
Team, run on a device. Distribution needs an **Apple Developer Program** account (TestFlight, or Apple
Business Manager custom app). App Store review requires the location purpose strings (present in
`project.yml`) and that background location is clearly user-initiated (it is).

## 3. Commercial SDK alternative

If you prefer a battle-tested SDK with motion-activity detection and its own SQLite/HTTP layer, the
server already accepts the Transistorsoft *background-geolocation* HTTP format (`{location: …}`),
so the SDK can post straight to `/api/location/points` with header `Authorization: Location <token>`.
It needs a paid license for Android release builds and a Capacitor/React Native app — a larger change
than the current WebView shells.

## 4. Web (any browser)

`navigator.geolocation.watchPosition` while the page is open (laptops, or phones without the app).
Fixes are queued in `localStorage` and uploaded every minute/20 fixes; resumed after a reload.
The page warns that it stops when the page is closed.

## 5. Device test plan (must be done on real phones — not possible here)

Run on at least: one Samsung (Android 13/14), one Xiaomi/Redmi (MIUI/HyperOS), one older Android 8–10,
one iPhone (iOS 16/17) if the iOS app is built. Server: staging with `ENABLE_LOCATION_TRACKING=true`.

| # | Test | Expected |
|---|---|---|
| 1 | Install APK 1.5 over 1.4 | Installs as update, login kept |
| 2 | My Location → accept notice → Start | Android asks "While using the app"; notification appears; pill shows on web |
| 3 | Deny permission | Session stopped, page explains how to allow |
| 4 | Lock phone, walk/drive 20 min | Live map updates every ~1 min; route continuous |
| 5 | Swipe app away from recents | Notification stays; tracking continues |
| 6 | Airplane mode 15 min while moving, then off | Points appear afterwards with correct times; no duplicates |
| 7 | Stay still 10 min | Fix interval drops (≈2 min), battery use low |
| 8 | Arrive at a place, stay > min stay, leave | Arrival + departure in History; task linked; alerts fire |
| 9 | Drive past a place without stopping | No visit |
| 10 | Tap Stop in the notification | Notification gone; session ended on web |
| 11 | Stop on the web | Phone notification disappears within a minute |
| 12 | Change password | Phone stops within a minute (token revoked) |
| 13 | Turn GPS off during session | "GPS is off" shown on My Location; signal-lost alert after N min |
| 14 | 8-hour shift | Battery drain noted (target < 10–15 %/8 h when mostly stationary) |
| 15 | Reboot phone with session on | No silent tracking; opening the app resumes |
| 16 | Indoor: walk between beacon zones | Zone changes within ~30–60 s |
| 17 | iPhone: background + blue indicator | Indicator visible; route continuous; stop works |
