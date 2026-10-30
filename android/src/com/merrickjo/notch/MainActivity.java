package com.merrickjo.notch;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.Window;
import android.view.MotionEvent;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Notch — a thin shell around the live web app (GitHub Pages).
 *
 * Every deploy of the web app reaches this APK on its next launch; the APK
 * itself only needs rebuilding if this shell changes. The page's own service
 * worker keeps it working offline after the first online launch. Anything
 * outside the app's own address (Google sign-in, links in notes) opens in the
 * system browser — Google refuses OAuth inside embedded WebViews, and the
 * Worker keeps the Google token server-side, so connecting there still
 * connects the app.
 */
public class MainActivity extends Activity implements BigmeInk.Sink {
    static final String HOME = "https://merrickjo.github.io/tasks-pwa/index.html";
    static final String SCOPE_HOST = "merrickjo.github.io";
    static final String SCOPE_PATH = "/tasks-pwa";
    private WebView web;
    private BigmeInk ink;
    private long lastStylusDown = 0;      // uptime of the last pen DOWN the WebView itself received

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Window w = getWindow();
        w.getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        web = new WebView(this);
        web.setBackgroundColor(0xFFFFFFFF);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setTextZoom(100);               // the layout is measured; don't let system font scale break it
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " NotchAndroid/1.2");
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (inScope(u)) return false;
                openOutside(u);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                // Only the page itself, and only when nothing is cached yet
                // (after the first launch the service worker answers offline).
                if (req.isForMainFrame()) {
                    view.loadDataWithBaseURL(HOME, OFFLINE_HTML, "text/html", "utf-8", null);
                }
            }
        });

        // 1.1 — native fast ink on Bigme (see BigmeInk). The page sees
        // window.NotchInk only inside this APK; in a browser it stays absent
        // and the journal uses its own canvas ink.
        ink = new BigmeInk(this);
        web.addJavascriptInterface(new InkBridge(), "NotchInk");

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(HOME);
    }

    static boolean inScope(Uri u) {
        if (u == null) return false;
        String path = u.getPath() == null ? "" : u.getPath();
        return "https".equals(u.getScheme()) && SCOPE_HOST.equals(u.getHost()) && path.startsWith(SCOPE_PATH);
    }

    void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) { }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri u = intent.getData();
        if (inScope(u)) web.loadUrl(u.toString());
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    // ── 1.1 native ink bridge ───────────────────────────────────────────────
    // Methods arrive on the WebView's bridge thread; every engine call is
    // posted to the main thread. Results come back through
    // window.__notchInk.state(...) and window.__notchInk.stroke(...).
    final class InkBridge {
        @JavascriptInterface public String engine() {
            return ink.available() ? "bigme" : "none";
        }
        @JavascriptInterface public String status() { return ink.status(); }
        @JavascriptInterface public void start(final int l, final int t, final int r, final int b, final float w) {
            web.post(() -> {
                boolean ok = ink.start(web, l, t, r, b, w);
                sendState(ok);
            });
        }
        @JavascriptInterface public void bounds(final int l, final int t, final int r, final int b) {
            web.post(() -> ink.setBounds(l, t, r, b));
        }
        @JavascriptInterface public void width(final float w) { web.post(() -> ink.setWidth(w)); }
        @JavascriptInterface public void eraser(final boolean on) { web.post(() -> ink.setEraser(on)); }
        @JavascriptInterface public void clear() { web.post(() -> ink.clear()); }
        @JavascriptInterface public void stop() { web.post(() -> { ink.stop(); sendState(false); }); }
        @JavascriptInterface public void retry() { web.post(() -> ink.resetFailure()); }
    }

    void sendState(boolean active) {
        String js = "window.__notchInk&&window.__notchInk.state({active:" + active
            + ",status:" + quote(ink.status()) + "})";
        web.evaluateJavascript(js, null);
    }

    static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\"";
    }

    @Override
    public void onStroke(String tool, float[] pts, int n) {
        StringBuilder sb = new StringBuilder(n * 6 + 64);
        sb.append("window.__notchInk&&window.__notchInk.stroke(\"").append(tool).append("\",[");
        for (int i = 0; i < n; i++) {
            if (i > 0) sb.append(',');
            float v = pts[i];
            if (i % 3 == 2) sb.append(Math.round(v * 1000) / 1000f); else sb.append(Math.round(v));
        }
        sb.append("])");
        web.evaluateJavascript(sb.toString(), null);
    }

    // While the pen service owns the stylus, a pen tap on a button outside
    // the paper may never reach the page. If the WebView didn't see a pen
    // DOWN for that tap, replay it as a finger tap so the UI still answers.
    @Override
    public void onExcludedTap(float x, float y, long downTime, long upTime) {
        if (lastStylusDown >= downTime - 80) return;   // the page already got it
        long t0 = SystemClock.uptimeMillis();
        MotionEvent d = MotionEvent.obtain(t0, t0, MotionEvent.ACTION_DOWN, x, y, 0);
        MotionEvent u = MotionEvent.obtain(t0, t0 + 40, MotionEvent.ACTION_UP, x, y, 0);
        d.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        u.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        web.dispatchTouchEvent(d);
        web.dispatchTouchEvent(u);
        d.recycle(); u.recycle();
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (ev.getActionMasked() == MotionEvent.ACTION_DOWN && ev.getPointerCount() > 0) {
            int tt = ev.getToolType(0);
            if (tt == MotionEvent.TOOL_TYPE_STYLUS || tt == MotionEvent.TOOL_TYPE_ERASER) lastStylusDown = ev.getEventTime();
        }
        return super.dispatchTouchEvent(ev);
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration c) {
        super.onConfigurationChanged(c);
        // New geometry: drop the binding; the page restarts ink on resize.
        if (ink != null) { ink.detach(); ink.resetFailure(); sendState(false); }
    }

    @Override
    protected void onPause() {
        // Lets the page's visibilitychange handlers flush unsaved journal
        // text and ink before Android can freeze the app.
        if (ink != null) ink.detach();   // never leave the pen service holding the panel
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);        // keep state; don't kill the app on back
    }

    static final String OFFLINE_HTML =
        "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
      + "<body style='font-family:sans-serif;padding:32px;color:#111;background:#fff'>"
      + "<h2 style='font-weight:600'>Notch can't connect</h2>"
      + "<p>The first launch needs internet so the app can save itself for offline use. "
      + "After that it opens without a connection.</p>"
      + "<p><button style='font-size:16px;padding:10px 18px;border:1px solid #111;background:#fff;border-radius:8px' "
      + "onclick=\"location.href='" + HOME + "'\">Try again</button></p></body>";
}
