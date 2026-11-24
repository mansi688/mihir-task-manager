// Runs first, from <head> (an external file so the page can forbid inline scripts — Content-Security-Policy).
  // Set the theme before any CSS paints, so dark-mode users never see a flash of the light
  // theme first. Must run here, blocking, before the stylesheet — not in app.js at the end of
  // body, which runs too late to prevent the flash.
  // try/catch: Safari with "Block all cookies" throws on any localStorage access.
  try { document.documentElement.setAttribute('data-theme', localStorage.getItem('ks_theme') || 'light'); }
  catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }

  // Startup safety net — deliberately old-style JavaScript so it runs on ANY browser, even ones too
  // old for the app itself. Records the first error, and if the app hasn't drawn anything 8 seconds
  // after the page loaded, replaces the blank white page with a plain explanation and the
  // technical details (to screenshot and send) instead of leaving people staring at nothing.
  (function () {
    var firstError = null;
    window.addEventListener('error', function (e) {
      if (firstError || !e) return;
      if (e.message) { firstError = e.message + (e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : ''); return; }
      // A resource failing to load (no message): only the app's own script matters — a blocked
      // web font or image is harmless and must not be reported as the cause.
      var t = e.target;
      if (t && t.tagName === 'SCRIPT' && /app\.js/.test(t.src || '')) firstError = 'app.js could not be downloaded (network, firewall or content blocker)';
    }, true);
    window.addEventListener('load', function () {
      setTimeout(function () {
        var app = document.getElementById('app');
        if (!app || app.children.length > 0) return;
        var ua = navigator.userAgent;
        var m = ua.match(/Version\/([\d.]+).*Safari/), c = ua.match(/Chrome\/([\d.]+)/), f = ua.match(/Firefox\/([\d.]+)/);
        var browser = c ? 'Chrome ' + c[1] : f ? 'Firefox ' + f[1] : m ? 'Safari ' + m[1] : 'Unknown browser';
        var storageOk = true; try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); } catch (e2) { storageOk = false; }
        var esc = function (t) { return String(t).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); };
        app.innerHTML = '<div style="max-width:560px;margin:60px auto;padding:28px;font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#fff;border:1px solid #ddd;border-radius:14px;color:#222;line-height:1.55;">' +
          '<h2 style="margin:0 0 10px;">The Task Manager couldn\'t start in this browser</h2>' +
          '<p style="margin:0 0 12px;">Please try these, in order:</p>' +
          '<ol style="margin:0 0 16px;padding-left:20px;">' +
          '<li><b>Update the browser</b> (on a Mac: Apple menu → System Settings → Software Update), or open the site in <b>Google Chrome</b>.</li>' +
          (storageOk ? '' : '<li><b>Safari is blocking website data.</b> Safari → Settings → Privacy → turn off <b>"Block all cookies"</b>, then reload.</li>') +
          '<li>Clear this site\'s data: Safari → Settings → Privacy → Manage Website Data → find this site → Remove. Then reload.</li>' +
          '<li>Check the Mac\'s <b>date and time</b> are correct (System Settings → General → Date &amp; Time → set automatically).</li>' +
          '</ol>' +
          '<div style="font-size:12px;background:#f4f4f4;border-radius:8px;padding:10px 12px;font-family:Menlo,monospace;word-break:break-word;">' +
          'Browser: ' + esc(browser) + '<br>Website data allowed: ' + (storageOk ? 'yes' : 'NO') + '<br>Error: ' + esc(firstError || 'none recorded (the app file may not have loaded)') + '</div>' +
          '<p style="font-size:12px;color:#777;margin:10px 0 0;">If none of this helps, send a screenshot of this page to your admin.</p></div>';
      }, 8000);
    });
  })();

// Images marked data-hide-on-error disappear when they fail to load (replaces inline onerror="").
document.addEventListener('error', function (e) {
  var t = e.target;
  if (t && t.tagName === 'IMG' && t.hasAttribute && t.hasAttribute('data-hide-on-error')) t.style.display = 'none';
}, true);
