import CoreLocation
import UIKit

/// Work-session location for iOS.
///  - Uses "When In Use" permission + background location updates started from the foreground, so
///    iOS shows the blue location indicator the whole time (the visible tracking status). "Always"
///    permission is not needed and not requested.
///  - Battery: best accuracy with a distance filter while moving; after ~3 minutes without moving it
///    drops to 100 m accuracy / 50 m filter, and goes back up as soon as the phone moves.
///  - Offline: fixes are queued (PointQueue) and uploaded in batches when there is a connection.
///  - Indoor: if the company has iBeacons, ranges them and sends what it hears (room/zone level).
///  - Stops when the employee stops, or when the server says the session has ended.
/// NOT compiled or device-tested by the author (no Xcode available) — see docs/LOCATION_MOBILE.md.
final class LocationTracker: NSObject, CLLocationManagerDelegate {
    static let shared = LocationTracker()

    var onResult: ((String) -> Void)?
    var onStatus: (([String: Any]) -> Void)?

    private let manager = CLLocationManager()
    private let queue = PointQueue()
    private var config: [String: Any] = [:]
    private var token = "", uploadURL: URL?, sightingsURL: URL?, sessionId = 0
    private var movingSec = 15.0, stationarySec = 120.0, distanceM = 20.0, uploadSec = 60.0
    private var running = false, moving = true, uploading = false
    private var anchor: CLLocation?, anchorAt = Date(), lastStored: CLLocation?, lastUpload = Date.distantPast
    private var beaconBest: [String: Int] = [:], lastBeaconSend = Date.distantPast
    private var pendingStart = false
    private let defaultsKey = "mihir_location_config"

    override init() {
        super.init()
        manager.delegate = self
        manager.activityType = .otherNavigation
        manager.pausesLocationUpdatesAutomatically = false
    }

    // MARK: start / stop
    func start(config cfg: [String: Any]) {
        config = cfg
        UserDefaults.standard.set(try? JSONSerialization.data(withJSONObject: cfg), forKey: defaultsKey)
        apply(cfg)
        switch manager.authorizationStatus {
        case .notDetermined:
            pendingStart = true
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            onResult?("denied")
        default:
            begin()
            onResult?("started")
        }
    }
    func resumeIfConfigured() {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let cfg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        config = cfg; apply(cfg)
        if manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways { begin() }
    }
    func stop(reason: String) {
        running = false
        manager.stopUpdatingLocation()
        for c in manager.rangedBeaconConstraints { manager.stopRangingBeacons(satisfying: c) }
        UserDefaults.standard.removeObject(forKey: defaultsKey)
        uploadAll()
        publishStatus()
    }

    private func apply(_ cfg: [String: Any]) {
        token = cfg["token"] as? String ?? ""
        uploadURL = (cfg["uploadUrl"] as? String).flatMap(URL.init(string:))
        sightingsURL = (cfg["sightingsUrl"] as? String).flatMap(URL.init(string:))
        sessionId = cfg["sessionId"] as? Int ?? Int(cfg["sessionId"] as? Double ?? 0)
        if let c = cfg["config"] as? [String: Any] {
            movingSec = max(5, c["movingIntervalSec"] as? Double ?? 15)
            stationarySec = max(30, c["stationaryIntervalSec"] as? Double ?? 120)
            distanceM = max(5, c["distanceFilterM"] as? Double ?? 20)
            uploadSec = max(15, c["uploadEverySec"] as? Double ?? 60)
        }
    }
    private func begin() {
        guard uploadURL != nil, !token.isEmpty else { return }
        running = true; moving = true
        manager.allowsBackgroundLocationUpdates = true      // requires UIBackgroundModes = location
        manager.showsBackgroundLocationIndicator = true     // the blue pill: tracking is visible
        setAccuracy()
        manager.startUpdatingLocation()
        startBeacons()
        publishStatus()
    }
    private func setAccuracy() {
        manager.desiredAccuracy = moving ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
        manager.distanceFilter = moving ? distanceM : max(50, distanceM)
    }

    // MARK: delegate
    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        guard pendingStart else { publishStatus(); return }
        switch m.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: pendingStart = false; begin(); onResult?("started")
        case .denied, .restricted: pendingStart = false; UserDefaults.standard.removeObject(forKey: defaultsKey); onResult?("denied")
        default: break
        }
    }
    func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard running else { return }
        for loc in locations where loc.horizontalAccuracy >= 0 && loc.horizontalAccuracy <= 500 {
            updateMotion(loc)
            if let last = lastStored, loc.timestamp.timeIntervalSince(last.timestamp) < (moving ? movingSec : stationarySec) / 2, loc.distance(from: last) < distanceM { continue }
            lastStored = loc
            let id = "i\(sessionId)-\(Int64(loc.timestamp.timeIntervalSince1970 * 1000))"
            var p: [String: CodableValue] = [
                "id": .string(id), "t": .number(loc.timestamp.timeIntervalSince1970 * 1000),
                "lat": .number(loc.coordinate.latitude), "lng": .number(loc.coordinate.longitude),
                "acc": .number(loc.horizontalAccuracy), "moving": .bool(moving), "src": .string("ios"),
            ]
            if loc.verticalAccuracy >= 0 { p["alt"] = .number(loc.altitude) }
            if loc.speed >= 0 { p["spd"] = .number(loc.speed) }
            if loc.course >= 0 { p["hdg"] = .number(loc.course) }
            UIDevice.current.isBatteryMonitoringEnabled = true
            if UIDevice.current.batteryLevel >= 0 { p["bat"] = .number(Double(UIDevice.current.batteryLevel)) }
            queue.add(.init(id: id, token: token, url: uploadURL!.absoluteString, t: loc.timestamp.timeIntervalSince1970, point: p))
        }
        if Date().timeIntervalSince(lastUpload) >= uploadSec { uploadAll() }
        publishStatus()
    }
    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) { publishStatus() }

    private func updateMotion(_ loc: CLLocation) {
        guard let a = anchor else { anchor = loc; anchorAt = loc.timestamp; return }
        let noise = max(30, loc.horizontalAccuracy)
        if loc.speed > 1.2 || loc.distance(from: a) > noise + 20 {
            anchor = loc; anchorAt = loc.timestamp
            if !moving { moving = true; setAccuracy() }
        } else if moving && loc.timestamp.timeIntervalSince(anchorAt) > 180 {
            moving = false; setAccuracy()
        }
    }

    // MARK: upload
    func uploadAll() {
        guard !uploading else { return }
        lastUpload = Date()
        uploading = true
        uploadNext(rounds: 0)
    }
    private func uploadNext(rounds: Int) {
        guard rounds < 50, let batch = queue.nextBatch(max: 200), let url = URL(string: batch.url) else { uploading = false; publishStatus(); return }
        var req = URLRequest(url: url, timeoutInterval: 75)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Location \(batch.token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["points": batch.entries.map { $0.point.mapValues { $0.any } }])
        let bgTask = UIApplication.shared.beginBackgroundTask(withName: "mihir-upload", expirationHandler: nil)
        URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
            defer { UIApplication.shared.endBackgroundTask(bgTask) }
            guard let self = self else { return }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            DispatchQueue.main.async {
                if [200, 400, 409, 413].contains(code) {
                    self.queue.remove(ids: Set(batch.entries.map { $0.id }))   // decided by the server
                    if (json["sessionActive"] as? Bool) == false && batch.token == self.token { self.uploading = false; self.stop(reason: "session_ended"); return }
                    self.uploadNext(rounds: rounds + 1)
                } else if code == 401 {
                    self.queue.remove(token: batch.token)                       // revoked: can never be accepted
                    if batch.token == self.token { self.uploading = false; self.stop(reason: "signed_out"); return }
                    self.uploadNext(rounds: rounds + 1)
                } else {
                    self.uploading = false; self.publishStatus()                // offline / server busy: retry later
                }
            }
        }.resume()
    }

    // MARK: indoor (iBeacon)
    private func startBeacons() {
        guard let c = config["config"] as? [String: Any], let indoor = c["indoor"] as? [String: Any],
              (indoor["enabled"] as? Bool) == true, let uuids = indoor["uuids"] as? [String] else { return }
        for s in uuids { if let u = UUID(uuidString: s) { manager.startRangingBeacons(satisfying: CLBeaconIdentityConstraint(uuid: u)) } }
    }
    func locationManager(_ m: CLLocationManager, didRange beacons: [CLBeacon], satisfying constraint: CLBeaconIdentityConstraint) {
        for b in beacons where b.rssi < 0 {
            let id = "\(b.uuid.uuidString.lowercased()):\(b.major.intValue):\(b.minor.intValue)"
            beaconBest[id] = max(beaconBest[id] ?? -200, b.rssi)
        }
        guard running, Date().timeIntervalSince(lastBeaconSend) >= 30, !beaconBest.isEmpty, let url = sightingsURL else { return }
        lastBeaconSend = Date()
        let body: [String: Any] = ["t": Date().timeIntervalSince1970 * 1000, "beacons": beaconBest.map { ["id": $0.key, "rssi": $0.value] }]
        beaconBest = [:]
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Location \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: status for the page
    func publishStatus() {
        let auth: String
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: auth = "granted"
        case .notDetermined: auth = "ask"
        default: auth = "missing"
        }
        var st: [String: Any] = ["running": running, "queued": queue.count, "permission": auth, "gpsEnabled": CLLocationManager.locationServicesEnabled()]
        if let l = lastStored { st["lastFixAt"] = l.timestamp.timeIntervalSince1970 * 1000; st["lastAccuracy"] = l.horizontalAccuracy }
        onStatus?(st)
    }
}
