package com.mihir.taskmanager;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.MimeTypeMap;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.URLDecoder;

/**
 * MIHIR Tasks for Android — a thin shell around the live website, so the app always shows the
 * same data and works exactly like the site (every website update reaches the app automatically,
 * no reinstall needed). The shell adds what a plain WebView can't do on its own: choosing files to
 * upload, saving downloads to the phone, the Back button, and opening WhatsApp / phone / email links
 * in their own apps.
 */
public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int STORAGE_PERMISSION_REQUEST = 1002;
    private static final String PREFS = "mihir_tasks";
    private static final String KEY_URL = "site_url";

    private WebView webView;
    private ProgressBar progress;
    private FrameLayout root;
    private View errorView;
    private ValueCallback<Uri[]> fileCallback;
    private String siteUrl;
    private String pendingSaveData, pendingSaveName;
    private long lastBackPress = 0;
    static volatile boolean inForeground = false;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1003;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 21) getWindow().setStatusBarColor(Color.parseColor("#1f3a5f"));
        root = new FrameLayout(this);
        setContentView(root);
        siteUrl = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null);
        if (siteUrl == null || siteUrl.isEmpty()) {
            String built = getString(R.string.site_url);
            if (built != null && built.startsWith("https://")) siteUrl = built;
        }
        if (siteUrl == null || siteUrl.isEmpty()) showSetup(null);
        else startWebView(savedInstanceState);
    }

    // ---------- first-run: ask for the site address ----------
    private void showSetup(String message) {
        root.removeAllViews();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(28), dp(80), dp(28), dp(28));
        TextView title = new TextView(this);
        title.setText("MIHIR Tasks");
        title.setTextSize(26); title.setTextColor(Color.parseColor("#1f3a5f"));
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        TextView hint = new TextView(this);
        hint.setText(message != null ? message : "Enter your Task Manager website address (the same one you open in the browser).");
        hint.setTextSize(15); hint.setPadding(0, dp(12), 0, dp(16));
        final EditText input = new EditText(this);
        input.setHint("https://your-site.onrender.com");
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        if (siteUrl != null) input.setText(siteUrl);
        Button go = new Button(this);
        go.setText("Open");
        go.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) {
            String u = input.getText().toString().trim();
            if (!u.startsWith("http")) u = "https://" + u;
            u = u.replaceAll("/+$", "");
            if (!u.startsWith("https://") || u.length() < 12) { Toast.makeText(MainActivity.this, "Please enter the full https:// address", Toast.LENGTH_LONG).show(); return; }
            siteUrl = u;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, u).apply();
            startWebView(null);
        } });
        box.addView(title); box.addView(hint); box.addView(input); box.addView(go);
        root.addView(box);
    }

    // ---------- the website ----------
    private void startWebView(Bundle state) {
        root.removeAllViews();
        webView = new WebView(this);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(progress, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // the site keeps your login in localStorage
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setTextZoom(100);                    // same layout as the website, whatever the phone's font size
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " MihirTasksAndroid/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.setWebViewClient(new WebViewClient() {
            // Android 7+ calls this one; Android 6 calls the String version below.
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) { progress.setVisibility(View.VISIBLE); }
            @Override public void onPageFinished(WebView view, String url) { progress.setVisibility(View.GONE); CookieManager.getInstance().flush(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError(error.getDescription() == null ? "" : error.getDescription().toString());
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int p) { progress.setProgress(p); }
            // "Choose file" buttons on the site (import spreadsheet, attachments, photos).
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick;
                try { pick = params.createIntent(); } catch (Exception e) { pick = new Intent(Intent.ACTION_GET_CONTENT).setType("*/*"); }
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                // Spreadsheets often report odd types — let the person pick any file; the site checks it.
                String[] types = params.getAcceptTypes();
                boolean onlyImages = types != null && types.length > 0 && types[0] != null && types[0].startsWith("image/");
                if (!onlyImages) pick.setType("*/*");
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(Intent.createChooser(pick, "Choose file"), FILE_CHOOSER_REQUEST); }
                catch (ActivityNotFoundException e) { fileCallback = null; Toast.makeText(MainActivity.this, "No file picker found on this phone", Toast.LENGTH_LONG).show(); return false; }
                return true;
            }
        });
        if (state != null) webView.restoreState(state);
        else webView.loadUrl(siteUrl);
    }

    private boolean handleUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        Uri home = Uri.parse(siteUrl);
        if (("https".equals(scheme) || "http".equals(scheme)) && home.getHost() != null && home.getHost().equalsIgnoreCase(uri.getHost())) return false; // stay in the app
        if ("data".equals(scheme) || "blob".equals(scheme) || "about".equals(scheme) || "javascript".equals(scheme)) return false;
        try {
            Intent i = "intent".equals(scheme) ? Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, uri);
            startActivity(i);  // WhatsApp, phone, email, maps, other websites
        } catch (Exception e) { Toast.makeText(this, "No app on this phone can open that link", Toast.LENGTH_SHORT).show(); }
        return true;
    }

    private void showError(String detail) {
        if (errorView != null) root.removeView(errorView);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.WHITE);
        box.setPadding(dp(28), dp(90), dp(28), dp(28));
        TextView t = new TextView(this);
        t.setText("Can't reach the Task Manager");
        t.setTextSize(22); t.setTypeface(null, android.graphics.Typeface.BOLD); t.setTextColor(Color.parseColor("#1f3a5f"));
        TextView d = new TextView(this);
        d.setText("Check the internet connection and try again. If the site was asleep it can take up to a minute to wake up.\n\n" + siteUrl + (detail.isEmpty() ? "" : "\n(" + detail + ")"));
        d.setTextSize(15); d.setPadding(0, dp(12), 0, dp(20));
        Button retry = new Button(this); retry.setText("Try again");
        retry.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { root.removeView(errorView); errorView = null; webView.loadUrl(siteUrl); } });
        Button change = new Button(this); change.setText("Change site address");
        change.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { errorView = null; showSetup("Enter the correct website address."); } });
        box.addView(t); box.addView(d); box.addView(retry); box.addView(change);
        errorView = box;
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // ---------- downloads (called from the site) ----------
    private class Bridge {
        @JavascriptInterface public boolean isApp() { return true; }
        // Called by the website after login: store the notifications-only device token and start
        // the background check. Asks for notification permission once on Android 13+.
        @JavascriptInterface public void setDeviceSession(String deviceToken, String username, String latestId) {
            long last = 0; try { last = Long.parseLong(latestId); } catch (Exception e) { /* 0 */ }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("device_token", deviceToken).putString("device_user", username)
                .putLong("last_notification_id", last).putString(KEY_URL, siteUrl).apply();
            NotifyJobService.schedule(MainActivity.this);
            new Handler(Looper.getMainLooper()).post(new Runnable() { @Override public void run() {
                if (Build.VERSION.SDK_INT >= 33 && MainActivity.this.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    MainActivity.this.requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, NOTIFICATION_PERMISSION_REQUEST);
                }
            } });
        }
        @JavascriptInterface public boolean isIgnoringBatteryOptimizations() {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            return pm == null || pm.isIgnoringBatteryOptimizations(getPackageName());
        }
        @JavascriptInterface public void requestBackgroundPermission() {
            new Handler(Looper.getMainLooper()).post(new Runnable() { @Override public void run() {
                try {
                    Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                } catch (Exception e) {
                    try { startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
                    catch (Exception e2) { Toast.makeText(MainActivity.this, "Open Settings → Apps → MIHIR Tasks → Battery → Unrestricted", Toast.LENGTH_LONG).show(); }
                }
            } });
        }
        @JavascriptInterface public boolean hasDeviceSession(String username) {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            return p.getString("device_token", null) != null && username != null && username.equals(p.getString("device_user", null));
        }
        @JavascriptInterface public void clearDeviceSession() {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("device_token").remove("device_user").remove("last_notification_id").apply();
            NotifyJobService.cancel(MainActivity.this);
        }
        @JavascriptInterface public void saveFile(final String dataUrl, final String fileName) {
            new Handler(Looper.getMainLooper()).post(new Runnable() { @Override public void run() {
                if (Build.VERSION.SDK_INT < 29 && MainActivity.this.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    pendingSaveData = dataUrl; pendingSaveName = fileName;
                    MainActivity.this.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_PERMISSION_REQUEST);
                    return;
                }
                saveToDownloads(dataUrl, fileName);
            } });
        }
    }

    private void saveToDownloads(String dataUrl, String fileName) {
        try {
            int comma = dataUrl.indexOf(',');
            String meta = comma > 5 ? dataUrl.substring(5, comma) : "";
            String body = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
            byte[] bytes = meta.contains(";base64") ? Base64.decode(body, Base64.DEFAULT) : URLDecoder.decode(body, "UTF-8").getBytes("UTF-8");
            String mime = meta.split(";")[0];
            String safeName = fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
            if (mime.isEmpty() || mime.equals("application/octet-stream")) {
                String ext = MimeTypeMap.getFileExtensionFromUrl(safeName.replace(" ", "_"));
                String guess = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
                mime = guess != null ? guess : "application/octet-stream";
            }
            Uri saved;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContentResolver();
                ContentValues v = new ContentValues();
                v.put("_display_name", safeName);
                v.put("mime_type", mime);
                v.put("relative_path", Environment.DIRECTORY_DOWNLOADS + "/MIHIR Tasks");
                v.put("is_pending", 1);
                saved = cr.insert(Uri.parse("content://media/external/downloads"), v);
                if (saved == null) throw new Exception("Could not create the file");
                OutputStream out = cr.openOutputStream(saved);
                out.write(bytes); out.close();
                ContentValues done = new ContentValues(); done.put("is_pending", 0);
                cr.update(saved, done, null, null);
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "MIHIR Tasks");
                dir.mkdirs();
                File f = new File(dir, safeName);
                FileOutputStream out = new FileOutputStream(f); out.write(bytes); out.close();
                saved = null; // file:// links can't be shared with other apps on Android 7+
            }
            Toast.makeText(this, "Saved to Downloads / MIHIR Tasks:\n" + safeName, Toast.LENGTH_LONG).show();
            if (saved != null) {
                Intent open = new Intent(Intent.ACTION_VIEW).setDataAndType(saved, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { startActivity(open); } catch (ActivityNotFoundException e) { /* saved; no viewer installed — that's fine */ }
            }
        } catch (Exception e) {
            Toast.makeText(this, "Couldn't save the file: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == STORAGE_PERMISSION_REQUEST && pendingSaveData != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) saveToDownloads(pendingSaveData, pendingSaveName);
            else Toast.makeText(this, "Storage permission is needed to save files", Toast.LENGTH_LONG).show();
            pendingSaveData = null; pendingSaveName = null;
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    result = new Uri[data.getClipData().getItemCount()];
                    for (int i = 0; i < result.length; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) result = new Uri[]{ data.getData() };
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ---------- Back button: let the site close menus/panels first ----------
    @Override public void onBackPressed() {
        if (webView == null) { super.onBackPressed(); return; }
        if (errorView != null) { super.onBackPressed(); return; }
        webView.evaluateJavascript("(window.__androidBack ? window.__androidBack() : false)", new ValueCallback<String>() { @Override public void onReceiveValue(String result) {
            if ("true".equals(result)) return;
            if (webView.canGoBack()) { webView.goBack(); return; }
            long now = System.currentTimeMillis();
            if (now - lastBackPress < 2000) MainActivity.this.finish();
            else { lastBackPress = now; Toast.makeText(MainActivity.this, "Press back again to exit", Toast.LENGTH_SHORT).show(); }
        } });
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); if (webView != null) webView.saveState(out); }
    @Override protected void onPause() { super.onPause(); inForeground = false; CookieManager.getInstance().flush(); if (webView != null) webView.onPause(); }
    @Override protected void onResume() { super.onResume(); inForeground = true; if (webView != null) webView.onResume(); }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
