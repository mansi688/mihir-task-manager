package com.mihir.taskmanager;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Background location for an employee's WORK SESSION — a foreground service of type "location".
 *
 *  - Visible: Android shows a permanent notification ("Sharing location — work session on") with a
 *    Stop button for as long as this runs. It never runs outside a session the employee started.
 *  - Battery: GPS every movingIntervalSec while moving; when the phone has not moved for ~3 minutes
 *    it drops to stationaryIntervalSec with a bigger distance filter, and speeds up again as soon as
 *    it moves. Fixes are uploaded in batches (uploadEverySec), not one by one.
 *  - Offline: every fix goes into PointStore (SQLite) first and is deleted only after the server has
 *    answered for it, so a site with no signal just uploads later.
 *  - Indoor (optional): if the company has BLE beacons, scans for ~4 s every 30 s and sends the
 *    beacons it hears; the server turns that into a room/zone.
 *  - Stops itself when the server says the session is over, or the upload token is revoked.
 *
 * Started only from MainActivity (in the foreground), after the location permission was granted.
 * It is deliberately NOT restarted at boot: after a restart the employee opens the app, which resumes.
 */
public class LocationService extends Service implements LocationListener {
    static final String ACTION_START = "com.mihir.taskmanager.LOCATION_START";
    static final String ACTION_STOP = "com.mihir.taskmanager.LOCATION_STOP";
    static final String PREFS = "mihir_location";
    static final String CHANNEL = "location";
    static final int NOTIF_ID = 4801;

    // Read by MainActivity's bridge for the "My Location" page.
    static volatile boolean running = false;
    static volatile long lastFixAt = 0;
    static volatile float lastAccuracy = -1;
    static volatile String lastError = null;

    private LocationManager lm;
    private PointStore store;
    private HandlerThread worker;
    private Handler bg;
    private Handler main;
    private String token, uploadUrl, sightingsUrl;
    private long sessionId;
    private int movingSec = 15, stationarySec = 120, uploadSec = 60;
    private float distanceM = 20;
    private Set<String> beaconUuids = new HashSet<String>();
    private boolean moving = true;
    private Location anchor;          // where the phone was when it last "settled"
    private long anchorAt = 0;
    private Location lastStored;
    private int backoffSec = 0;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        store = new PointStore(this);
        worker = new HandlerThread("mihir-location"); worker.start();
        bg = new Handler(worker.getLooper());
        main = new Handler(Looper.getMainLooper());
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            boolean fromNotification = intent.getBooleanExtra("fromNotification", false);
            if (fromNotification) bg.post(new Runnable() { @Override public void run() { tellServerStopped(); } });
            shutdown();
            return START_NOT_STICKY;
        }
        if (!loadConfig()) { stopSelf(); return START_NOT_STICKY; }
        startInForeground();
        running = true; lastError = null;
        requestUpdates();
        bg.removeCallbacksAndMessages(null);
        bg.postDelayed(uploader, 5000);
        if (!beaconUuids.isEmpty()) bg.postDelayed(beaconScan, 8000);
        // START_STICKY: if Android kills the process under memory pressure it recreates the
        // service with the saved config (the session is still on), instead of silently stopping.
        return START_STICKY;
    }

    private boolean loadConfig() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        try {
            JSONObject c = new JSONObject(p.getString("config", "{}"));
            token = c.optString("token", null);
            uploadUrl = c.optString("uploadUrl", null);
            sightingsUrl = c.optString("sightingsUrl", null);
            sessionId = c.optLong("sessionId", 0);
            JSONObject cfg = c.optJSONObject("config");
            if (cfg != null) {
                movingSec = Math.max(5, cfg.optInt("movingIntervalSec", 15));
                stationarySec = Math.max(30, cfg.optInt("stationaryIntervalSec", 120));
                distanceM = (float) Math.max(5, cfg.optDouble("distanceFilterM", 20));
                uploadSec = Math.max(15, cfg.optInt("uploadEverySec", 60));
                JSONObject indoor = cfg.optJSONObject("indoor");
                beaconUuids.clear();
                if (indoor != null && indoor.optBoolean("enabled", false)) {
                    JSONArray u = indoor.optJSONArray("uuids");
                    for (int i = 0; u != null && i < u.length(); i++) beaconUuids.add(u.optString(i).toLowerCase());
                }
            }
        } catch (Exception e) { return false; }
        return token != null && uploadUrl != null && uploadUrl.startsWith("https://") && sessionId > 0;
    }

    // ---------- notification (the always-visible tracking status) ----------
    private void startInForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Location sharing (work session)", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown whenever your location is being shared during a work session.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        int piFlags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), piFlags);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, LocationService.class).setAction(ACTION_STOP).putExtra("fromNotification", true), piFlags);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_notify)
         .setContentTitle("Sharing location — work session on")
         .setContentText("MIHIR records your location until you stop the session.")
         .setOngoing(true)
         .setContentIntent(open)
         .addAction(new Notification.Action.Builder(0, "Stop work session", stop).build());
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTIF_ID, n);
    }

    // ---------- location ----------
    private boolean hasLocationPermission() {
        return Build.VERSION.SDK_INT < 23 || checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission("android.permission.ACCESS_COARSE_LOCATION") == PackageManager.PERMISSION_GRANTED;
    }
    private void requestUpdates() {
        if (lm == null) return;
        try { lm.removeUpdates(this); } catch (Exception e) { /* not registered */ }
        if (!hasLocationPermission()) { lastError = "permission"; return; }
        long minTime = (moving ? movingSec : stationarySec) * 1000L;
        float minDist = moving ? distanceM : Math.max(50f, distanceM);
        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, minTime, minDist, this, main.getLooper());
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, minTime, minDist, this, main.getLooper());
            lm.requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, minTime, minDist, this, main.getLooper());
        } catch (SecurityException e) { lastError = "permission"; }
    }

    @Override public void onLocationChanged(Location loc) {
        if (loc == null || !running) return;
        if (loc.hasAccuracy() && loc.getAccuracy() > 500) return; // a cell-tower guess, not a position
        // Same moment from two providers: keep the more accurate one.
        if (lastStored != null && Math.abs(loc.getTime() - lastStored.getTime()) < 3000
            && loc.hasAccuracy() && lastStored.hasAccuracy() && loc.getAccuracy() >= lastStored.getAccuracy()) return;
        updateMotion(loc);
        if (lastStored != null && loc.getTime() - lastStored.getTime() < (moving ? movingSec : stationarySec) * 1000L / 2
            && loc.distanceTo(lastStored) < distanceM) return;
        lastStored = loc;
        lastFixAt = System.currentTimeMillis();
        lastAccuracy = loc.hasAccuracy() ? loc.getAccuracy() : -1;
        try {
            JSONObject p = new JSONObject();
            String id = "a" + sessionId + "-" + loc.getTime() + "-" + (loc.getProvider() == null ? "x" : loc.getProvider().substring(0, 1));
            p.put("id", id);
            p.put("t", loc.getTime());
            p.put("lat", loc.getLatitude());
            p.put("lng", loc.getLongitude());
            if (loc.hasAccuracy()) p.put("acc", loc.getAccuracy());
            if (loc.hasAltitude()) p.put("alt", loc.getAltitude());
            if (loc.hasSpeed()) p.put("spd", loc.getSpeed());
            if (loc.hasBearing()) p.put("hdg", loc.getBearing());
            float bat = batteryLevel();
            if (bat >= 0) p.put("bat", bat);
            p.put("moving", moving);
            p.put("src", loc.getProvider());
            store.add(id, token, uploadUrl, loc.getTime(), p);
        } catch (Exception e) { lastError = "store: " + e.getMessage(); }
    }

    // Moving ↔ stationary, from the phone's own displacement (no Google Play services needed).
    private void updateMotion(Location loc) {
        long now = loc.getTime();
        boolean fast = loc.hasSpeed() && loc.getSpeed() > 1.2f;
        if (anchor == null) { anchor = loc; anchorAt = now; return; }
        float moved = loc.distanceTo(anchor);
        float noise = Math.max(30f, loc.hasAccuracy() ? loc.getAccuracy() : 30f);
        if (fast || moved > noise + 20) {
            anchor = loc; anchorAt = now;
            if (!moving) { moving = true; requestUpdates(); }
        } else if (moving && now - anchorAt > 3 * 60 * 1000) {
            moving = false; requestUpdates();
        }
    }

    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    @Override public void onProviderEnabled(String provider) { requestUpdates(); }
    @Override public void onProviderDisabled(String provider) { if (LocationManager.GPS_PROVIDER.equals(provider)) lastError = "gps_off"; }

    private float batteryLevel() {
        try {
            Intent i = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (i == null) return -1;
            int level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            return level >= 0 && scale > 0 ? level / (float) scale : -1;
        } catch (Exception e) { return -1; }
    }

    // ---------- upload (offline-safe) ----------
    private boolean online() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkInfo ni = cm == null ? null : cm.getActiveNetworkInfo();
        return ni != null && ni.isConnected();
    }
    private final Runnable uploader = new Runnable() {
        @Override public void run() {
            long next = uploadSec;
            try {
                if (online()) next = uploadAll() ? uploadSec : Math.min(600, Math.max(30, backoffSec = backoffSec == 0 ? 30 : backoffSec * 2));
            } catch (Throwable t) { lastError = "upload: " + t.getMessage(); }
            if (running) bg.postDelayed(this, next * 1000L);
        }
    };
    /** Uploads everything queued. false = a temporary failure (retry later with backoff). */
    private boolean uploadAll() throws Exception {
        for (int round = 0; round < 50; round++) {
            PointStore.Batch b = store.nextBatch(200);
            if (b == null || b.ids.isEmpty()) { backoffSec = 0; return true; }
            JSONObject body = new JSONObject();
            body.put("points", b.points);
            int[] code = new int[1];
            JSONObject res = post(b.url, b.token, body, code);
            if (code[0] == 200 || code[0] == 409 || code[0] == 400 || code[0] == 413) {
                // The server decided about these (stored, duplicate or refused) — never resend them.
                store.delete(b.ids);
                boolean active = res == null || res.optBoolean("sessionActive", true);
                if (!active && token != null && token.equals(b.token)) { main.post(new Runnable() { @Override public void run() { shutdown(); } }); return true; }
            } else if (code[0] == 401) {
                store.deleteToken(b.token); // token revoked (password changed / signed out): these can never be accepted
                if (token != null && token.equals(b.token)) { lastError = "signed_out"; main.post(new Runnable() { @Override public void run() { shutdown(); } }); return true; }
            } else {
                return false; // 5xx / 429 / network: keep them, try again later
            }
        }
        return true;
    }
    private JSONObject post(String url, String tok, JSONObject body, int[] codeOut) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(75000); // a sleeping free-plan server can take ~1 minute to wake
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Location " + tok);
            byte[] data = body.toString().getBytes("UTF-8");
            OutputStream os = conn.getOutputStream(); os.write(data); os.close();
            codeOut[0] = conn.getResponseCode();
            java.io.InputStream in = codeOut[0] < 400 ? conn.getInputStream() : conn.getErrorStream();
            if (in == null) return null;
            BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            StringBuilder sb = new StringBuilder(); String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            try { return new JSONObject(sb.toString()); } catch (Exception e) { return null; }
        } finally { conn.disconnect(); }
    }
    // The employee tapped "Stop" in the notification: end the session on the server too.
    private void tellServerStopped() {
        try {
            if (uploadAllQuietly() && uploadUrl != null) {
                String stopUrl = uploadUrl.replace("/api/location/points", "/api/location/sessions/stop-upload");
                post(stopUrl, token, new JSONObject(), new int[1]);
            }
        } catch (Throwable t) { /* the server also auto-stops sessions after the maximum length */ }
    }
    private boolean uploadAllQuietly() { try { return uploadAll(); } catch (Throwable t) { return false; } }

    // ---------- indoor: BLE beacons ----------
    private final Runnable beaconScan = new Runnable() {
        @Override public void run() {
            if (!running) return;
            try { scanOnce(); } catch (Throwable t) { lastError = "ble: " + t.getMessage(); }
            bg.postDelayed(this, 30000);
        }
    };
    private void scanOnce() {
        if (sightingsUrl == null || !online()) return;
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission("android.permission.BLUETOOTH_SCAN") != PackageManager.PERMISSION_GRANTED) return;
        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        BluetoothAdapter ad = bm == null ? null : bm.getAdapter();
        if (ad == null || !ad.isEnabled()) return;
        final BluetoothLeScanner sc = ad.getBluetoothLeScanner();
        if (sc == null) return;
        final Map<String, Integer> best = new HashMap<String, Integer>();
        final ScanCallback cb = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult r) {
                String id = iBeaconId(r.getScanRecord());
                if (id == null || !beaconUuids.contains(id.substring(0, 36))) return;
                Integer prev = best.get(id);
                if (prev == null || r.getRssi() > prev) best.put(id, r.getRssi());
            }
        };
        ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build();
        try { sc.startScan(null, settings, cb); } catch (SecurityException e) { return; }
        try { Thread.sleep(4000); } catch (InterruptedException e) { /* stop early */ }
        try { sc.stopScan(cb); } catch (Exception e) { /* adapter turned off */ }
        if (best.isEmpty()) return;
        try {
            JSONArray beacons = new JSONArray();
            for (Map.Entry<String, Integer> e : best.entrySet()) beacons.put(new JSONObject().put("id", e.getKey()).put("rssi", e.getValue()));
            post(sightingsUrl, token, new JSONObject().put("t", System.currentTimeMillis()).put("beacons", beacons), new int[1]);
        } catch (Exception e) { /* indoor positions are best-effort */ }
    }
    /** Apple iBeacon frame → "uuid:major:minor" (lower case), or null. */
    static String iBeaconId(ScanRecord rec) {
        return rec == null ? null : BeaconParser.iBeaconId(rec.getManufacturerSpecificData(0x004C));
    }
    // ---------- stop ----------
    private void shutdown() {
        running = false;
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception e) { /* ignore */ }
        bg.removeCallbacksAndMessages(null);
        // One last attempt to upload what is queued (anything left goes up next time the app tracks).
        bg.post(new Runnable() { @Override public void run() { uploadAllQuietly(); } });
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("config").apply();
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        stopSelf();
    }

    @Override public void onDestroy() {
        running = false;
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception e) { /* ignore */ }
        if (worker != null) worker.quitSafely();
        super.onDestroy();
    }

    // ---------- called by MainActivity ----------
    static void start(Context c, String configJson) {
        c.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("config", configJson).apply();
        Intent i = new Intent(c, LocationService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }
    static void stop(Context c) {
        if (!running) { c.getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("config").apply(); return; }
        c.startService(new Intent(c, LocationService.class).setAction(ACTION_STOP));
    }
    static long queued(Context c) { try { return new PointStore(c).count(); } catch (Exception e) { return -1; } }
}
