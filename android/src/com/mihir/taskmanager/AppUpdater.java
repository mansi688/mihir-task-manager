package com.mihir.taskmanager;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Updates the MIHIR app by itself (v1.9+).
 *
 * The site says which version is newest (GET /app/android/version). When this app is older, it downloads the new
 * APK, checks its SHA-256, and installs it with Android's PackageInstaller:
 *  - Android 12+ after the first in-app update (this app is then the "installer of record" of itself): Android
 *    installs it silently in the background — nobody taps anything.
 *  - Otherwise Android shows its own "Update this app?" screen once: one tap on Update.
 * Android always checks the new APK is signed with the same key, so nobody else can push an app this way.
 * Runs from the 15-minute background job (NotifyJobService) and when the app opens.
 */
public class AppUpdater extends BroadcastReceiver {
    static final String PREFS = "mihir_tasks";
    static final String ACTION = "com.mihir.taskmanager.UPDATE_STATUS";
    static volatile String status = "idle";       // idle | checking | downloading | installing | waiting_user | allow_needed | failed:… | up_to_date
    static volatile boolean running = false;

    static int myVersion(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionCode; } catch (Exception e) { return 0; }
    }

    static boolean canInstall(Context c) {
        if (Build.VERSION.SDK_INT < 26) return true;
        try { return (Boolean) c.getPackageManager().getClass().getMethod("canRequestPackageInstalls").invoke(c.getPackageManager()); }
        catch (Exception e) { return false; }
    }

    /** Opens "Install unknown apps → Allow from this source" for MIHIR (needed once, Android 8+). */
    static void openAllowScreen(Context c) {
        try {
            Intent i = new Intent("android.settings.MANAGE_UNKNOWN_APP_SOURCES", Uri.parse("package:" + c.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Exception e) {
            try { Intent i = new Intent(Settings.ACTION_SECURITY_SETTINGS); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); c.startActivity(i); } catch (Exception ignored) { }
        }
    }

    static String site(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String s = p.getString("site_url", null);
        if (s == null || s.isEmpty()) s = c.getString(R.string.site_url);
        return s;
    }

    /** Checks and, if a newer app exists, downloads and installs it. interactive = started by the person (may show screens). */
    static void checkAndUpdate(final Context ctx, final boolean interactive) {
        if (running) return;
        running = true;
        final Context c = ctx.getApplicationContext();
        new Thread(new Runnable() { @Override public void run() {
            try { doUpdate(c, interactive); }
            catch (Throwable t) { status = "failed:" + t.getClass().getSimpleName(); }
            finally { running = false; }
        } }).start();
    }

    private static void doUpdate(Context c, boolean interactive) throws Exception {
        String site = site(c);
        if (site == null || !site.startsWith("https://")) { status = "failed:no-site"; return; }
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // background: at most every 3 hours
        if (!interactive && System.currentTimeMillis() - p.getLong("update_checked_at", 0) < 3 * 3600 * 1000L) return;
        p.edit().putLong("update_checked_at", System.currentTimeMillis()).apply();
        status = "checking";
        JSONObject v = new JSONObject(get(site + "/app/android/version"));
        int latest = v.optInt("versionCode", 0);
        if (latest <= myVersion(c)) { status = "up_to_date"; return; }
        if (!canInstall(c)) {
            status = "allow_needed";
            if (interactive) openAllowScreen(c);
            return;
        }
        status = "downloading";
        File dir = new File(c.getCacheDir(), "update"); dir.mkdirs();
        for (File old : dir.listFiles() == null ? new File[0] : dir.listFiles()) old.delete();
        File apk = new File(dir, "MIHIR-" + latest + ".apk");
        download(site + v.optString("path", "/app/android"), apk);
        String want = v.optString("sha256", "");
        if (!want.isEmpty() && !want.equalsIgnoreCase(sha256(apk))) { apk.delete(); status = "failed:checksum"; return; }
        status = "installing";
        install(c, apk);
    }

    private static String get(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000); conn.setReadTimeout(20000);
        conn.setRequestProperty("Cache-Control", "no-cache");
        try (InputStream in = conn.getInputStream()) {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString("UTF-8");
        } finally { conn.disconnect(); }
    }

    private static void download(String url, File to) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000); conn.setReadTimeout(60000);
        conn.setInstanceFollowRedirects(true);
        if (conn.getResponseCode() != 200) throw new Exception("HTTP " + conn.getResponseCode());
        try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[16384]; int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally { conn.disconnect(); }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) { byte[] buf = new byte[16384]; int n; while ((n = in.read(buf)) > 0) md.update(buf, 0, n); }
        StringBuilder sb = new StringBuilder(); for (byte b : md.digest()) sb.append(String.format("%02x", b)); return sb.toString();
    }

    private static void install(Context c, File apk) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(c.getPackageName());
        // Android 12+: no confirmation when this app is the installer of record of itself (USER_ACTION_NOT_REQUIRED = 2)
        if (Build.VERSION.SDK_INT >= 31) {
            try { params.getClass().getMethod("setRequireUserAction", int.class).invoke(params, 2); } catch (Exception ignored) { }
        }
        int id = pi.createSession(params);
        PackageInstaller.Session s = pi.openSession(id);
        try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("base.apk", 0, apk.length())) {
            byte[] buf = new byte[65536]; int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            s.fsync(out);
        }
        Intent i = new Intent(c, AppUpdater.class).setAction(ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? 0x02000000 /* FLAG_MUTABLE */ : 0);
        PendingIntent pend = PendingIntent.getBroadcast(c, id, i, flags);
        s.commit(pend.getIntentSender());
        s.close();
    }

    /** PackageInstaller reports here: needs the person's OK (show Android's screen), done, or failed. */
    @Override public void onReceive(Context c, Intent intent) {
        // Just updated: the work session (location) was running before → start it again by itself.
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            try {
                String cfg = c.getSharedPreferences(LocationService.PREFS, Context.MODE_PRIVATE).getString("config", null);
                if (cfg != null) LocationService.start(c, cfg);
            } catch (Exception ignored) { }
            try { NotifyJobService.show(c, 77, "MIHIR app updated to the newest version ✓"); } catch (Exception ignored) { }
            return;
        }
        int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            status = "waiting_user";
            Intent confirm = (Intent) intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                // open Android's "Update?" screen now if MIHIR is on screen; otherwise a notification opens it
                if (MainActivity.inForeground) { try { c.startActivity(confirm); return; } catch (Exception ignored) { } }
                try {
                    PendingIntent tap = PendingIntent.getActivity(c, 7701, confirm, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    NotifyJobService.showWithIntent(c, 7701, "📲 New MIHIR app ready — tap here, then tap Update", tap);
                } catch (Exception e) { status = "failed:confirm"; }
            }
        } else if (st == PackageInstaller.STATUS_SUCCESS) {
            status = "installed";
        } else {
            status = "failed:" + st + " " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        }
    }
}
