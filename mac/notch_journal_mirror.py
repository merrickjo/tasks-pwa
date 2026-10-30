#!/usr/bin/env python3
"""notch-journal-mirror — copies the Notch JOURNAL into the Obsidian vault.

One-way: Notch (D1, behind the tasks-proxy Worker) is where the journal is
written, on the web app or the APK. This mirrors every page into
<vault>/Notch/Journal so it lives in Obsidian like the tasks do:

  Notch/Journal/Daily/2026-10-30.md      daily log (typed text + CONCURSUS)
  Notch/Journal/Weekly/2026-W44.md       weekly spread
  Notch/Journal/Monthly/2026-10.md       monthly log
  Notch/Journal/Ink/2026-10-30 p1.svg    handwriting, one SVG per ink page,
                                         embedded in the page's note

Edits made to these notes in Obsidian are overwritten on the next change in
Notch — the header of every note says so. Runs at the end of each
notch-tasks-sync pass (every 5 minutes); a failure here is logged and never
stops task sync. Only pages changed since the last run are fetched.

Usage: notch_journal_mirror.py [--dry-run] [--vault PATH] [--full]
"""
import argparse, datetime as dt, json, os, subprocess, sys, tempfile

HOME = os.path.expanduser("~")
APP_DIR = os.path.join(HOME, "Library", "Application Support", "Notch")
DEFAULT_VAULT = os.path.join(HOME, "Obsidian", "Vault")
STATE_FILE = os.path.join(APP_DIR, "journal-mirror-state.json")
LOG_FILE = os.path.join(APP_DIR, "tasks-sync.log")  # one log for the whole sync
PAGE_W, PAGE_H = 1000, 1333
DOMAINS = ["intake", "synthesis", "exercise", "scripture", "family"]
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def log(msg):
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} journal: {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_config():
    cfg = {}
    with open(os.path.join(APP_DIR, "config"), encoding="utf-8") as f:
        for raw in f:
            if "=" in raw and not raw.strip().startswith("#"):
                k, v = raw.strip().split("=", 1)
                cfg[k.strip()] = v.strip().strip("'\"")
    return cfg


def call(cfg, path):
    p = subprocess.run(
        ["curl", "-sS", "--max-time", "30", cfg["WORKER_URL"] + path,
         "-H", f"x-app-key: {cfg['APP_KEY']}", "-w", "\n%{http_code}"],
        capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"curl {path}: {p.stderr.strip()}")
    body, _, code = p.stdout.rpartition("\n")
    if code != "200":
        raise RuntimeError(f"GET {path}: HTTP {code} {body[:200]}")
    return json.loads(body)


def atomic_write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".notch-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


# ── ink → SVG ────────────────────────────────────────────────────────────────
def decode(p):
    pts, x, y, pr = [], 0, 0, 0
    for i in range(0, len(p) - 2, 3):
        x += p[i]; y += p[i + 1]; pr += p[i + 2]
        pts.append((x, y, pr))
    return pts


def ink_svg(strokes, title):
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {PAGE_W} {PAGE_H}" width="{PAGE_W}" height="{PAGE_H}">',
           f'<rect width="{PAGE_W}" height="{PAGE_H}" fill="#ffffff"/>',
           f'<text x="60" y="70" font-family="monospace" font-size="28" font-weight="700" fill="#2c2c2c">{esc(title)}</text>',
           '<g fill="none" stroke="#111111" stroke-linecap="round" stroke-linejoin="round">']
    for s in strokes:
        pts = decode(s.get("p") or [])
        if not pts:
            continue
        avg = sum(p[2] for p in pts) / len(pts)
        w = max(0.8, float(s.get("w") or 3) * (0.35 + 0.65 * avg / 15))
        if len(pts) == 1:
            x, y, _ = pts[0]
            out.append(f'<circle cx="{x}" cy="{y}" r="{w / 2:.1f}" fill="#111111" stroke="none"/>')
            continue
        d = "M" + " L".join(f"{x} {y}" for x, y, _ in pts)
        out.append(f'<path d="{d}" stroke-width="{w:.1f}"/>')
    out.append("</g></svg>")
    return "\n".join(out)


def esc(t):
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── page → note ──────────────────────────────────────────────────────────────
def iso_week_days(key):
    # key "w:2026-W44" → the seven ISO dates, Monday first
    y, w = key[2:].split("-W")
    monday = dt.date.fromisocalendar(int(y), int(w), 1)
    return [monday + dt.timedelta(days=i) for i in range(7)]


def marks(snap):
    if not snap:
        return ""
    done = snap.get("done") or {}
    return "".join("■" if done.get(k) else "□" for k in DOMAINS) + f" d{snap.get('roll')}" + (" · notch" if snap.get("notch") else "")


def note_for(entry, cc, ink_links):
    key, kind, sec = entry["key"], entry["kind"], entry.get("sections") or {}
    period = key[2:]
    head = ["---", f"notch_key: \"{key}\"", f"kind: {kind}", f"period: \"{period}\"",
            f"updated_at: \"{entry.get('updated_at') or ''}\"", "source: Notch", "tags: [notch-journal]", "---", "",
            "> [!note] Mirrored from Notch — write in the Notch JOURNAL tab; edits here are overwritten.", ""]
    body = []

    def block(title, text):
        text = (text or "").rstrip()
        if text:
            # Bullet-journal "> migrated" must not turn into a Markdown quote,
            # and each logged line stays its own line in Obsidian's reader.
            lines = [("\\" + l if l.lstrip().startswith(">") else l) for l in text.split("\n")]
            body.extend([f"## {title}", "", "  \n".join(lines), ""])

    if kind == "day":
        d = dt.date.fromisoformat(period)
        body.append(f"# {d:%a %d %b %Y}")
        body.append("")
        m = marks(cc.get(period))
        if m:
            body.extend([f"**CONCURSUS** {m}", ""])
        block("Rapid log", sec.get("log"))
        week = dt.date.fromisoformat(period).isocalendar()
        body.extend([f"Week: [[{week[0]}-W{week[1]:02d}]] · Month: [[{period[:7]}]]", ""])
    elif kind == "week":
        days = iso_week_days(key)
        body.extend([f"# Week {period.split('-W')[1]} · {days[0]:%d %b} – {days[6]:%d %b %Y}", ""])
        block("Focus", sec.get("focus"))
        lines = []
        for i, d in enumerate(days):
            iso = d.isoformat()
            plan = (sec.get(f"d{i}") or "").strip()
            m = marks(cc.get(iso))
            lines.append(f"- **{DOW[i]} {d.day}** [[{iso}]]" + (f" · {m}" if m else "") + (f" — {plan}" if plan else ""))
        body.extend(["## Days", ""] + lines + [""])
        block("Review", sec.get("review"))
    else:
        y, mo = map(int, period.split("-"))
        body.extend([f"# {dt.date(y, mo, 1):%B %Y}", ""])
        block("Goals", sec.get("goals"))
        lines = []
        d = dt.date(y, mo, 1)
        while d.month == mo:
            iso = d.isoformat()
            text = (sec.get(f"l{d.day:02d}") or "").strip()
            m = marks(cc.get(iso))
            if text or m:
                lines.append(f"- **{d.day} {DOW[d.weekday()][0]}** [[{iso}]]" + (f" · {m}" if m else "") + (f" — {text}" if text else ""))
            d += dt.timedelta(days=1)
        if lines:
            body.extend(["## Calendar", ""] + lines + [""])
        block("Tasks", sec.get("tasks"))
    if ink_links:
        body.extend(["## Handwritten", ""] + [f"![[{name}]]" for name in ink_links] + [""])
    return "\n".join(head + body).rstrip() + "\n"


def note_path(vault, entry):
    period = entry["key"][2:]
    sub = {"day": "Daily", "week": "Weekly", "month": "Monthly"}[entry["kind"]]
    return os.path.join(vault, "Notch", "Journal", sub, period + ".md")


def mirror(vault, dry=False, full=False, cfg=None):
    cfg = cfg or load_config()
    state = {}
    if os.path.exists(STATE_FILE) and not full:
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                state = json.load(f)
        except (OSError, ValueError):
            state = {}
    cursor = state.get("cursor", "")
    written = 0
    for _ in range(50):  # 200 pages per call; plenty of headroom
        entries = call(cfg, "/api/sync/journal?since=" + cursor).get("entries", [])
        if not entries:
            break
        dates = sorted({e["key"][2:] for e in entries if e["kind"] == "day"} |
                       {d.isoformat() for e in entries if e["kind"] == "week" for d in iso_week_days(e["key"])} |
                       {f"{e['key'][2:]}-01" for e in entries if e["kind"] == "month"})
        lo = min(dates)
        hi_d = max(dates)
        if any(e["kind"] == "month" for e in entries):
            y, m = map(int, max(e["key"][2:] for e in entries if e["kind"] == "month").split("-"))
            last = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)).isoformat()
            hi_d = max(hi_d, last)
        cc = call(cfg, f"/api/concursus?from={lo}&to={hi_d}").get("days", {})
        for e in entries:
            period = e["key"][2:]
            links = []
            for page in sorted(e.get("ink") or [], key=lambda p: p["page"]):
                if not page.get("strokes"):
                    continue
                name = f"{period} p{page['page'] + 1}.svg"
                if not dry:
                    atomic_write(os.path.join(vault, "Notch", "Journal", "Ink", name),
                                 ink_svg(page["strokes"], f"{period} · p.{page['page'] + 1}"))
                links.append(name)
            if not dry:
                atomic_write(note_path(vault, e), note_for(e, cc, links))
            written += 1
            cursor = max(cursor, e.get("updated_at") or "")
        if len(entries) < 200:
            break
    if not dry:
        state["cursor"] = cursor
        state["last_run"] = dt.datetime.now(dt.timezone.utc).isoformat()
        atomic_write(STATE_FILE, json.dumps(state, indent=1))
    if written:
        log(("DRY " if dry else "") + f"mirrored {written} page(s)")
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--full", action="store_true", help="ignore the cursor and rewrite every page")
    ap.add_argument("--vault", default=DEFAULT_VAULT)
    a = ap.parse_args()
    try:
        mirror(a.vault, a.dry_run, a.full)
        return 0
    except Exception as e:
        log(f"error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
