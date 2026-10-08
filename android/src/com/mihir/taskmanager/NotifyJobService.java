package com.mihir.taskmanager;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Calendar;

/**
 * Free phone notifications without Firebase: Android runs this job about every 15 minutes (Android
 * decides the exact moment to save battery). It asks the server for this person's new unread
 * notifications using a notifications-only device token, and shows them in the notification bar.
 * Quiet at night (22:00–07:00) — that also lets the free Render server sleep overnight.
 */
public class NotifyJobService extends JobService {
    static final int JOB_ID = 4711;
    static final String PREFS = "mihir_tasks";
    static final String CHANNEL_ID = "tasks";

    public static void schedule(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, NotifyJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build();
        js.schedule(job);
    }

    public static void cancel(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js != null) js.cancel(JOB_ID);
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(new Runnable() {
            @Override public void run() {
                try { checkNow(NotifyJobService.this); } catch (Throwable t) { /* try again next time */ }
                jobFinished(params, false);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) { return true; }

    static void checkNow(Context c) throws Exception {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String token = p.getString("device_token", null);
        String site = p.getString("site_url", null);
        if (site == null || site.isEmpty()) site = c.getString(R.string.site_url);
        if (token == null || site == null || !site.startsWith("https://")) return;
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        if (hour < 7 || hour >= 22) return;
        long lastId = p.getLong("last_notification_id", 0);

        HttpURLConnection conn = (HttpURLConnection) new URL(site + "/api/device/notifications?after=" + lastId).openConnection();
        conn.setRequestProperty("Authorization", "Device " + token);
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(75000); // a sleeping free server can take ~1 minute to wake
        int code = conn.getResponseCode();
        if (code == 401) { p.edit().remove("device_token").apply(); cancel(c); return; } // signed out elsewhere
        if (code != 200) return;
        StringBuilder sb = new StringBuilder();
        BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
        String line; while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        JSONObject json = new JSONObject(sb.toString());
        JSONArray items = json.optJSONArray("items");
        long latest = json.optLong("latestId", lastId);
        p.edit().putLong("last_notification_id", Math.max(lastId, latest)).apply();
        if (items == null || items.length() == 0) return;
        if (MainActivity.inForeground) return; // the app is open — its own bell already shows them
        if (items.length() <= 3) {
            for (int i = 0; i < items.length(); i++) {
                JSONObject n = items.getJSONObject(i);
                show(c, (int) (n.optLong("id") % 100000), n.optString("message"));
            }
        } else {
            show(c, 1, items.length() + " new notifications — " + items.getJSONObject(items.length() - 1).optString("message"));
        }
    }

    static void show(Context c, int id, String text) throws Exception {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            // NotificationChannel (Android 8+) via reflection — the app is compiled against Android 6.
            Class<?> chClass = Class.forName("android.app.NotificationChannel");
            Object channel = chClass.getConstructor(String.class, CharSequence.class, int.class)
                    .newInstance(CHANNEL_ID, "Task notifications", 4 /* IMPORTANCE_HIGH */);
            NotificationManager.class.getMethod("createNotificationChannel", chClass).invoke(nm, channel);
            b = (Notification.Builder) Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(c, CHANNEL_ID);
        } else {
            b = new Notification.Builder(c);
            b.setDefaults(Notification.DEFAULT_ALL);
            b.setPriority(Notification.PRIORITY_HIGH);
        }
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        b.setSmallIcon(R.drawable.ic_stat_notify)
         .setColor(0xFF2D5FA8)
         .setContentTitle("MIHIR Tasks")
         .setContentText(text)
         .setStyle(new Notification.BigTextStyle().bigText(text))
         .setAutoCancel(true)
         .setContentIntent(pi);
        nm.notify(id, b.build());
    }
}
