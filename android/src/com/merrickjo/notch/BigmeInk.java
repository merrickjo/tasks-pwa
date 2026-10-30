package com.merrickjo.notch;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * Native low-latency ink on Bigme e-ink devices.
 *
 * Bigme firmware ("xrz") ships a pen service, /system/bin/handwrittenservice,
 * reached through the hidden class com.xrz.HandwrittenClient. It is what
 * Bigme's own notes app uses: pen input goes straight to the service, the app
 * paints into a panel-mapped buffer, and the service refreshes just that
 * rectangle with a dedicated handwriting waveform — skipping the WebView,
 * the compositor and the normal e-ink page refresh, which is where the lag
 * in the web canvas comes from.
 *
 * API facts (names, argument shapes, mode numbers, call order) come from the
 * public reverse-engineering notes in the Kalamos InkSDK project; this file is
 * an independent, minimal implementation for Notch.
 *
 * Lifecycle: attach() once per WebView size, start(bounds) when the journal's
 * ink page is on screen, stop() when it isn't, detach() on pause. Every call
 * is reflective and fails closed: if anything is missing, available() is
 * false and the journal keeps its ordinary web-canvas ink.
 *
 * Threading: onInputTouch arrives on a binder thread and paints there (as
 * the service expects); every control call runs on the main thread.
 */
final class BigmeInk {
    interface Sink {
        /** Completed stroke: flat [x, y, pressure(0..1), ...] in view pixels. tool: "pen" | "rubber". */
        void onStroke(String tool, float[] pts, int n);
        /** Pen touched outside the writing bounds (DOWN..UP). */
        void onExcludedTap(float x, float y, long downTime, long upTime);
    }

    private static final String TAG = "NotchInk";
    private static final String CLIENT = "com.xrz.HandwrittenClient";
    private static final String LISTENER = "com.xrz.HandwrittenClient$InputListener";
    private static final int A_DOWN = 1, A_MOVE = 2, A_UP = 3, A_LEAVE = 4;
    private static final int T_RUBBER = 1, T_FINGER = 2;
    private static final int MODE_HANDWRITE = 1029;
    private static final int MODE_GU16 = 132;          // 16-grey, no flash: used to wipe the overlay
    private static final long COMMIT_MS = 16;           // batch MOVE refreshes to ~60/s

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Sink sink;
    private Class<?> cls;
    private Object client;
    private Method mGetCanvas, mInvalidate, mSetInput, mSetOverlay, mSetBlend;
    private View view;
    private int attachedW, attachedH;
    private String failure = null;
    private boolean probed = false;

    // writing state (written on main, read on the binder thread)
    private volatile boolean active = false;
    private volatile boolean eraserMode = false;
    private volatile int bL, bT, bR, bB;               // writing bounds, view px
    private volatile float baseWidth = 4f;             // px at full pressure
    private volatile boolean inked = false;            // overlay holds ink not yet wiped

    // per-stroke state (binder thread only)
    private final Paint paint = new Paint();
    private final Rect dirty = new Rect();
    private float[] pts = new float[3 * 512];
    private int n = 0;
    private float lastX, lastY;
    private long lastCommit, downTime;
    private boolean stroking, excluded, rubber;
    private float exX, exY;

    BigmeInk(Sink sink) {
        this.sink = sink;
        paint.setAntiAlias(true);
        paint.setColor(Color.BLACK);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
    }

    /** Is the Bigme pen service present on this device? Cheap after the first call. */
    boolean available() {
        if (!probed) {
            probed = true;
            try {
                cls = Class.forName(CLIENT);
                // Bigme's framework classes sit behind Android's hidden-API
                // policy; this lifts it for this app only.
                org.lsposed.hiddenapibypass.HiddenApiBypass.addHiddenApiExemptions("L");
                mGetCanvas = cls.getMethod("getCanvas");
                mInvalidate = cls.getMethod("inValidate", Rect.class, int.class);
                mSetInput = cls.getMethod("setInputEnabled", boolean.class);
                mSetOverlay = cls.getMethod("setOverlayEnabled", boolean.class);
                mSetBlend = cls.getMethod("setBlendEnabled", boolean.class);
            } catch (Throwable t) {
                failure = "no Bigme pen service (" + t.getClass().getSimpleName() + ")";
                cls = null;
            }
        }
        return cls != null && failure == null;
    }

    String status() {
        if (!available()) return failure == null ? "unavailable" : failure;
        if (failure != null) return failure;
        return client == null ? "ready" : (active ? "writing" : "idle");
    }

    boolean isActive() { return active; }

    /** Bind the pen service to the WebView. Main thread. */
    private boolean attach(View v) {
        if (!available()) return false;
        int w = v.getWidth(), h = v.getHeight();
        if (w <= 0 || h <= 0) return false;
        if (client != null && view == v && w == attachedW && h == attachedH) return true;
        detach();
        Object c = null;
        try {
            c = cls.getConstructor(android.content.Context.class).newInstance(v.getContext());
            cls.getMethod("bindView", View.class).invoke(c, v);
            Class<?> lc = Class.forName(LISTENER);
            Object listener = Proxy.newProxyInstance(cls.getClassLoader(), new Class<?>[]{lc}, new Input());
            cls.getMethod("registerInputListener", lc).invoke(c, listener);
            Object ok = cls.getMethod("connect", int.class, int.class).invoke(c, w, h);
            if (!Boolean.TRUE.equals(ok)) throw new IllegalStateException("connect refused");
            // The service can replay its whole overlay on an idle timer; we
            // own every refresh, so turn that off where the firmware allows.
            try { cls.getMethod("setRecommitEnabled", boolean.class, int.class, int.class).invoke(c, false, 0, MODE_GU16); }
            catch (Throwable ignored) { }
            mSetInput.invoke(c, false);
            mSetOverlay.invoke(c, false);
            mSetBlend.invoke(c, false);
            // Order matters: rotation first, then layout (layout reads rotation).
            cls.getMethod("updateRotation").invoke(c);
            Object laid = cls.getMethod("updateLayout").invoke(c);
            if (Boolean.FALSE.equals(laid)) throw new IllegalStateException("layout refused");
            Object cv = mGetCanvas.invoke(c);
            if (!(cv instanceof Canvas)) throw new IllegalStateException("no canvas");
            Canvas canvas = (Canvas) cv;
            boolean sized = (canvas.getWidth() == w && canvas.getHeight() == h) || (canvas.getWidth() == h && canvas.getHeight() == w);
            if (!sized) throw new IllegalStateException("canvas " + canvas.getWidth() + "x" + canvas.getHeight() + " for view " + w + "x" + h);
            // A reused buffer may hold another app's pixels: wipe before showing.
            canvas.drawColor(Color.WHITE, PorterDuff.Mode.SRC);
            inked = false;
            mSetBlend.invoke(c, true);
            client = c; view = v; attachedW = w; attachedH = h;
            Log.i(TAG, "attached " + w + "x" + h);
            return true;
        } catch (Throwable t) {
            Throwable cause = t.getCause() != null ? t.getCause() : t;
            failure = "pen service refused: " + cause.getClass().getSimpleName() + (cause.getMessage() == null ? "" : " " + cause.getMessage());
            Log.w(TAG, failure, cause);
            if (c != null) release(c);
            return false;
        }
    }

    private void release(Object c) {
        try { mSetInput.invoke(c, false); } catch (Throwable ignored) { }
        try { mSetBlend.invoke(c, false); } catch (Throwable ignored) { }
        try { mSetOverlay.invoke(c, false); } catch (Throwable ignored) { }
        try { cls.getMethod("disconnect").invoke(c); } catch (Throwable ignored) { }
        try { cls.getMethod("unBindView").invoke(c); } catch (Throwable ignored) { }
    }

    /** Begin native writing inside [l,t,r,b] (view px). Main thread. */
    boolean start(View v, int l, int t, int r, int b, float widthPx) {
        if (!attach(v)) return false;
        bL = l; bT = t; bR = r; bB = b;
        baseWidth = Math.max(1f, widthPx);
        try {
            mSetOverlay.invoke(client, true);
            mSetInput.invoke(client, true);
            active = true;
            return true;
        } catch (Throwable th) {
            failure = "start failed: " + th.getClass().getSimpleName();
            detach();
            return false;
        }
    }

    void setBounds(int l, int t, int r, int b) { bL = l; bT = t; bR = r; bB = b; }
    void setWidth(float px) { baseWidth = Math.max(1f, px); }
    void setEraser(boolean on) { eraserMode = on; }

    /** Wipe native ink from the panel (the web canvas underneath already has it).
     *  A wipe is a visible e-ink refresh, so it's skipped when nothing was drawn. */
    void clear() {
        Object c = client;
        if (c == null || !inked) return;
        inked = false;
        try {
            Canvas canvas = (Canvas) mGetCanvas.invoke(c);
            if (canvas != null) canvas.drawColor(Color.WHITE, PorterDuff.Mode.SRC);
            mInvalidate.invoke(c, new Rect(0, 0, attachedW, attachedH), MODE_GU16);
        } catch (Throwable t) { Log.w(TAG, "clear: " + t); }
    }

    void stop() {
        if (client == null) { active = false; return; }
        active = false;
        try { mSetInput.invoke(client, false); } catch (Throwable ignored) { }
        clear();
        try { mSetOverlay.invoke(client, false); } catch (Throwable ignored) { }
    }

    void detach() {
        active = false;
        if (client != null) {
            Object c = client;
            client = null;
            try {
                Canvas canvas = (Canvas) mGetCanvas.invoke(c);
                if (canvas != null) canvas.drawColor(Color.WHITE, PorterDuff.Mode.SRC);
            } catch (Throwable ignored) { }
            release(c);
        }
        view = null; attachedW = attachedH = 0;
    }

    /** Clears a sticky failure so the next start() retries (e.g. after rotation). */
    void resetFailure() { if (cls != null) failure = null; }

    // ── pen input, on the service's binder thread ────────────────────────────
    private final class Input implements InvocationHandler {
        @Override
        public Object invoke(Object proxy, Method m, Object[] a) {
            String name = m.getName();
            if (!"onInputTouch".equals(name) || a == null || a.length < 5) {
                if ("hashCode".equals(name)) return System.identityHashCode(proxy);
                if ("equals".equals(name)) return a != null && a.length > 0 && a[0] == proxy;
                if ("toString".equals(name)) return "NotchInk.Input";
                return m.getReturnType() == int.class ? (Object) 0 : m.getReturnType() == boolean.class ? (Object) false : null;
            }
            try { handle(((Number) a[0]).intValue(), ((Number) a[1]).floatValue(), ((Number) a[2]).floatValue(),
                    ((Number) a[3]).floatValue() / 4096f, ((Number) a[4]).intValue()); }
            catch (Throwable t) { Log.w(TAG, "input: " + t); }
            return 0; // 0 = let the system deliver the event as usual
        }
    }

    private boolean inside(float x, float y) { return x >= bL && x < bR && y >= bT && y < bB; }

    private void push(float x, float y, float p) {
        if (n + 3 > pts.length) { float[] g = new float[pts.length * 2]; System.arraycopy(pts, 0, g, 0, n); pts = g; }
        pts[n++] = x; pts[n++] = y; pts[n++] = p;
    }

    private float widthFor(float p) { return Math.max(1f, baseWidth * (0.35f + 0.65f * Math.min(1f, Math.max(0f, p)))); }

    private void handle(int action, float x, float y, float p, int tool) {
        if (tool == T_FINGER || !active) return;              // fingers scroll/tap as normal
        Object c = client;
        if (c == null) return;
        long now = SystemClock.uptimeMillis();

        if (action == A_DOWN) {
            n = 0;
            excluded = !inside(x, y);
            if (excluded) { exX = x; exY = y; downTime = now; return; }
            stroking = true;
            rubber = tool == T_RUBBER || eraserMode;
            push(x, y, p);
            lastX = x; lastY = y; lastCommit = now;
            if (!rubber) {
                try {
                    Canvas canvas = (Canvas) mGetCanvas.invoke(c);
                    float w = widthFor(p);
                    paint.setStrokeWidth(w);
                    canvas.drawPoint(x, y, paint);
                    inked = true;
                    int pad = (int) w + 2;
                    mInvalidate.invoke(c, new Rect((int) x - pad, (int) y - pad, (int) x + pad, (int) y + pad), MODE_HANDWRITE);
                } catch (Throwable t) { Log.w(TAG, "down: " + t); }
                dirty.setEmpty();
            }
            return;
        }
        if (excluded) {
            if (action == A_UP || action == A_LEAVE) {
                excluded = false;
                final float tx = exX, ty = exY;
                final long d = downTime;
                if (Math.hypot(x - tx, y - ty) < 24 && now - d < 600) {
                    main.post(() -> sink.onExcludedTap(tx, ty, d, now));
                }
            }
            return;
        }
        if (!stroking) return;
        if (action == A_MOVE) {
            push(x, y, p);
            if (!rubber) {
                try {
                    Canvas canvas = (Canvas) mGetCanvas.invoke(c);
                    float w = widthFor(p);
                    paint.setStrokeWidth(w);
                    canvas.drawLine(lastX, lastY, x, y, paint);
                    inked = true;
                    int pad = (int) w + 2;
                    Rect seg = new Rect((int) Math.min(lastX, x) - pad, (int) Math.min(lastY, y) - pad,
                            (int) Math.max(lastX, x) + pad, (int) Math.max(lastY, y) + pad);
                    if (dirty.isEmpty()) dirty.set(seg); else dirty.union(seg);
                    if (now - lastCommit >= COMMIT_MS) {
                        mInvalidate.invoke(c, new Rect(dirty), MODE_HANDWRITE);
                        dirty.setEmpty();
                        lastCommit = now;
                    }
                } catch (Throwable t) { Log.w(TAG, "move: " + t); }
            }
            lastX = x; lastY = y;
            return;
        }
        if (action == A_UP || action == A_LEAVE) {
            stroking = false;
            if (!rubber && !dirty.isEmpty()) {
                try { mInvalidate.invoke(c, new Rect(dirty), MODE_HANDWRITE); } catch (Throwable ignored) { }
                dirty.setEmpty();
            }
            final float[] copy = new float[n];
            System.arraycopy(pts, 0, copy, 0, n);
            final int count = n;
            final String kind = rubber ? "rubber" : "pen";
            n = 0;
            main.post(() -> sink.onStroke(kind, copy, count));
        }
    }
}
