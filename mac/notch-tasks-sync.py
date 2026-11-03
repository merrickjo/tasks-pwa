#!/usr/bin/env python3
"""notch-tasks-sync — the Obsidian vault is the source of truth for Notch tasks.

Each task is one note in <vault>/Notch/Tasks/. D1 (behind the tasks-proxy
Worker) is only a cache so the Notch PWA on the phone keeps working. This runs
from launchd every 5 minutes and reconciles both sides:

  * changed only in the vault  -> pushed to D1
  * changed only in D1 (phone) -> written into the vault note
  * changed on both            -> newer updated_at wins (vault edits use the
                                  file's mtime when hand-edited in Obsidian)
  * new note without an id     -> gets a UUID, then pushed
  * note deleted in the vault  -> deleted from D1 (unless D1 changed since,
                                  in which case the note is recreated)

State (last-synced hash per task) lives in ~/Library/Application Support/Notch.
Usage: notch_tasks_sync.py [--dry-run] [--vault PATH]
"""
import argparse, datetime as dt, hashlib, json, os, re, subprocess, sys, tempfile, uuid

HOME = os.path.expanduser("~")
APP_DIR = os.path.join(HOME, "Library", "Application Support", "Notch")
DEFAULT_VAULT = os.path.join(HOME, "Obsidian", "Vault")
TASKS_SUBDIR = os.path.join("Notch", "Tasks")
STATE_FILE = os.path.join(APP_DIR, "tasks-sync-state.json")
LOG_FILE = os.path.join(APP_DIR, "tasks-sync.log")

# Fields mirrored to D1. Anything else in a note's frontmatter is vault-only and preserved.
SYNC_FIELDS = ["title", "status", "priority", "due", "area", "labels", "notes",
               "completed_at", "source", "recurrence"]
FM_ORDER = ["id", "title", "status", "priority", "due", "area", "labels", "completed_at",
            "source", "recurrence", "created_at", "updated_at"]
STATUSES = {"to do": "To do", "todo": "To do", "backlog": "To do", "doing": "To do",
            "waiting": "To do", "blocked": "To do", "done": "Done", "canceled": "Canceled",
            "cancelled": "Canceled"}
PRIORITIES = ["P1 - Critical", "P2 - High", "P3 - Medium", "P4 - Low"]
AREAS = ["Church", "Blibli", "Fitness", "Family", "Personal"]
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{dt.datetime.now(dt.timezone.utc).microsecond // 1000:03d}Z"


def jakarta_today():
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=7)).strftime("%Y-%m-%d")


def log(msg):
    os.makedirs(APP_DIR, exist_ok=True)
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        with open(LOG_FILE, encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) > 1000:
            with open(LOG_FILE, "w", encoding="utf-8") as f:
                f.writelines(lines[-400:])
    except OSError:
        pass


# ── tiny YAML-frontmatter reader/writer (flat keys, scalars and string lists) ──

def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        inner = v[1:-1]
        if v[0] == "'":
            return inner.replace("''", "'")
        return re.sub(r'\\(["\\nt])', lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), inner)
    return v


def _scalar(v):
    v = v.strip()
    if v in ("", "null", "~"):
        return None
    if v.startswith("[") and v.endswith("]"):
        body = v[1:-1].strip()
        if not body:
            return []
        out, cur, q = [], "", None
        for ch in body:
            if q:
                cur += ch
                if ch == q:
                    q = None
            elif ch in "'\"":
                q = ch
                cur += ch
            elif ch == ",":
                out.append(_unquote(cur))
                cur = ""
            else:
                cur += ch
        if cur.strip():
            out.append(_unquote(cur))
        return [x for x in out if x != ""]
    return _unquote(v)


def parse_note(text):
    """Return (frontmatter dict, body str)."""
    fm, body = {}, text
    if text.startswith("---"):
        m = re.match(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", text, re.S)
        if m:
            body = text[m.end():]
            key = None
            for raw in m.group(1).splitlines():
                if not raw.strip() or raw.lstrip().startswith("#"):
                    continue
                item = re.match(r"^\s+-\s*(.*)$", raw) or re.match(r"^-\s+(.*)$", raw)
                if item and key is not None:
                    if not isinstance(fm.get(key), list):
                        fm[key] = []
                    val = _unquote(item.group(1))
                    if val != "":
                        fm[key].append(val)
                    continue
                kv = re.match(r"^([A-Za-z0-9_\-]+):\s?(.*)$", raw)
                if kv:
                    key = kv.group(1)
                    fm[key] = _scalar(kv.group(2))
    return fm, body


def _yaml_str(v):
    s = str(v)
    if "\n" in s or "\t" in s or "\\" in s:
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t") + '"'
    if s == "" or re.search(r"[:#\[\]{}&*!|>'\"%@`,]|^\s|\s$|^(true|false|null|yes|no|~|-)$", s, re.I) \
            or re.match(r"^[\d.+-]", s):
        return "'" + s.replace("'", "''") + "'"
    return s


def render_note(fm, body):
    keys = [k for k in FM_ORDER if k in fm] + [k for k in fm if k not in FM_ORDER]
    lines = ["---"]
    for k in keys:
        v = fm[k]
        if isinstance(v, list):
            if not v:
                lines.append(f"{k}: []")
            else:
                lines.append(f"{k}:")
                lines.extend(f"  - {_yaml_str(x)}" for x in v)
        elif v is None or v == "":
            lines.append(f"{k}:")
        else:
            lines.append(f"{k}: {_yaml_str(v)}")
    lines.append("---")
    body = (body or "").strip("\n")
    return "\n".join(lines) + "\n" + (body + "\n" if body else "")


# ── normalisation: vault note <-> D1 row ──

def norm_date(v):
    if not v:
        return None
    s = str(v).strip()
    return s if DATE_RE.match(s) else None


def norm_fields(d):
    """Canonical comparable form of the synced fields (from a note or a D1 row)."""
    labels = d.get("labels")
    if isinstance(labels, str):
        try:
            labels = json.loads(labels) if labels.strip().startswith("[") else [labels]
        except ValueError:
            labels = [labels]
    labels = [str(x) for x in (labels or []) if str(x).strip()]
    status = STATUSES.get(str(d.get("status") or "To do").strip().lower(), "To do")
    pr = d.get("priority")
    pr = pr if pr in PRIORITIES else (None if not pr else next((p for p in PRIORITIES if p.lower().startswith(str(pr).lower()[:2])), None))
    area = d.get("area")
    area = area if area in AREAS else None
    out = {
        "title": (str(d.get("title") or "").strip() or "(untitled)")[:200],
        "status": status,
        "priority": pr,
        "due": norm_date(d.get("due")),
        "area": area,
        "labels": labels,
        "notes": (d.get("notes") or "").strip(),
        "completed_at": norm_date(d.get("completed_at")),
        "source": (str(d.get("source")).strip() or None) if d.get("source") else None,
        "recurrence": (str(d.get("recurrence")).strip() or None) if d.get("recurrence") else None,
    }
    if out["status"] == "Done" and not out["completed_at"]:
        out["completed_at"] = None  # left as-is; Done-without-date is legal (old imports)
    return out


def fhash(fields):
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def note_fields(fm, body):
    d = dict(fm)
    d["notes"] = body
    return norm_fields(d)


def safe_filename(title):
    s = re.sub(r'[\\/:*?"<>|#^\[\]]', "-", title).strip().strip(".")
    s = re.sub(r"\s+", " ", s)
    return (s[:120].rstrip() or "Untitled")


# ── Worker API (curl keeps TLS identical to notch-cal) ──

class Api:
    def __init__(self, url, key, dry):
        self.url, self.key, self.dry = url.rstrip("/"), key, dry

    def call(self, method, path, body=None):
        if self.dry and method != "GET":
            return {"dry": True}
        cmd = ["curl", "-sS", "--max-time", "30", "-X", method, self.url + path,
               "-H", "content-type: application/json", "-H", f"x-app-key: {self.key}",
               "-w", "\n%{http_code}"]
        if body is not None:
            cmd += ["--data-binary", "@-"]
        p = subprocess.run(cmd, input=json.dumps(body) if body is not None else None,
                           capture_output=True, text=True)
        if p.returncode != 0:
            raise RuntimeError(f"curl {method} {path}: {p.stderr.strip()}")
        out, _, code = p.stdout.rpartition("\n")
        if not code.startswith("2"):
            raise RuntimeError(f"{method} {path} -> HTTP {code}: {out[:300]}")
        return json.loads(out) if out.strip() else {}


def load_config():
    cfg = {}
    with open(os.path.join(APP_DIR, "config"), encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*([A-Z_]+)=(.*)$", line)
            if m:
                cfg[m.group(1)] = m.group(2).strip().strip("'\"")
    return cfg


# ── vault IO ──

def atomic_write(path, text):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".notch-sync-", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def scan_vault(folder):
    notes = {}      # id -> dict(path, fm, body, fields, mtime)
    no_id = []      # notes that still need an id
    dupes = []
    if not os.path.isdir(folder):
        return notes, no_id, dupes
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".md") or name.startswith("."):
            continue
        path = os.path.join(folder, name)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        fm, body = parse_note(text)
        if "title" not in fm or not fm.get("title"):
            fm["title"] = name[:-3]
        rec = {"path": path, "fm": fm, "body": body, "fields": note_fields(fm, body),
               "mtime": os.path.getmtime(path)}
        tid = str(fm.get("id") or "").strip()
        if tid and UUID_RE.match(tid):
            if tid in notes:
                dupes.append(path)
                continue
            notes[tid] = rec
        else:
            no_id.append(rec)
    return notes, no_id, dupes


def row_to_note(row, existing_fm=None, existing_body=None):
    f = norm_fields(row)
    fm = dict(existing_fm or {})
    fm.update({
        "id": row["id"], "title": f["title"], "status": f["status"], "priority": f["priority"],
        "due": f["due"], "area": f["area"], "labels": f["labels"], "completed_at": f["completed_at"],
        "source": f["source"], "recurrence": f["recurrence"],
        "created_at": row.get("created_at") or fm.get("created_at"),
        "updated_at": row.get("updated_at") or fm.get("updated_at"),
    })
    return fm, f["notes"]


def note_to_row(tid, rec, updated_at, prev_status=None):
    f = rec["fields"]
    fm = rec["fm"]
    created = fm.get("created_at") or fm.get("created") or updated_at
    if created and DATE_RE.match(str(created)) and len(str(created)) == 10:
        created = str(created) + "T00:00:00.000Z"
    return {"id": tid, "title": f["title"], "status": f["status"], "priority": f["priority"],
            "due": f["due"], "area": f["area"], "labels": f["labels"], "notes": f["notes"],
            "completed_at": f["completed_at"] or (jakarta_today() if f["status"] == "Done" and prev_status != "Done" else None),
            "source": f["source"], "recurrence": f["recurrence"],
            "created_at": str(created), "updated_at": updated_at}


def mtime_iso(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# ── the reconcile ──

def run(vault, dry):
    folder = os.path.join(vault, TASKS_SUBDIR)
    cfg = load_config()
    api = Api(cfg["WORKER_URL"], cfg["APP_KEY"], dry)
    state = {"tasks": {}}
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, encoding="utf-8") as f:
            state = json.load(f)
    base = state.setdefault("tasks", {})

    rows = {r["id"]: r for r in api.call("GET", "/api/sync/tasks").get("tasks", [])}
    notes, no_id, dupes = scan_vault(folder)
    for p in dupes:
        log(f"warn: duplicate id, ignored: {os.path.basename(p)}")

    stats = dict(pushed=0, pulled=0, created_note=0, created_row=0, deleted_row=0,
                 recreated=0, conflicts=0, renamed=0)
    taken = {r["path"] for r in notes.values()} | {r["path"] for r in no_id}

    # 1) brand-new notes without an id
    for rec in no_id:
        tid = str(uuid.uuid4())
        ts = mtime_iso(rec["mtime"])
        rec["fm"]["id"] = tid
        rec["fm"].setdefault("created_at", rec["fm"].pop("created", None) or ts)
        rec["fm"]["updated_at"] = ts
        rec["fm"]["status"] = rec["fields"]["status"]
        row = note_to_row(tid, rec, ts)
        rec["fm"]["completed_at"] = row["completed_at"]
        api.call("PUT", f"/api/sync/tasks/{tid}", row)
        if not dry:
            atomic_write(rec["path"], render_note(rec["fm"], rec["body"]))
        base[tid] = fhash(note_fields(rec["fm"], rec["body"]))
        stats["created_row"] += 1
        log(f"new  -> D1  {rec['fields']['title'][:70]}")

    # 2) everything that has an id on either side
    for tid in sorted(set(notes) | set(rows)):
        rec, row, b = notes.get(tid), rows.get(tid), base.get(tid)
        vh = fhash(rec["fields"]) if rec else None
        rh = fhash(norm_fields(row)) if row else None

        if rec and row:
            if vh == rh:
                base[tid] = vh
                continue
            v_changed, r_changed = vh != b, rh != b
            if v_changed and r_changed and b is not None:
                stats["conflicts"] += 1
                v_ts = max(str(rec["fm"].get("updated_at") or ""), mtime_iso(rec["mtime"]))
                winner = "vault" if v_ts >= str(row.get("updated_at") or "") else "d1"
            elif b is None:
                # first sight of a pair (migration): D1 is the fresher copy
                winner = "d1"
            else:
                winner = "vault" if v_changed else "d1"
            if winner == "vault":
                ts = now_iso()
                out = note_to_row(tid, rec, ts, prev_status=norm_fields(row)["status"])
                api.call("PUT", f"/api/sync/tasks/{tid}", out)
                rec["fm"]["updated_at"] = ts
                rec["fm"]["completed_at"] = out["completed_at"]
                if not dry:
                    atomic_write(rec["path"], render_note(rec["fm"], rec["body"]))
                stats["pushed"] += 1
                base[tid] = fhash(note_fields(rec["fm"], rec["body"]))
                log(f"vault-> D1  {rec['fields']['title'][:70]}")
            else:
                fm, body = row_to_note(row, rec["fm"], rec["body"])
                path = rec["path"]
                want = os.path.join(folder, safe_filename(fm["title"]) + ".md")
                if want != path and not os.path.exists(want):
                    if not dry:
                        os.replace(path, want)
                    path = want
                    stats["renamed"] += 1
                if not dry:
                    atomic_write(path, render_note(fm, body))
                stats["pulled"] += 1
                base[tid] = rh
                log(f"D1 -> vault {fm['title'][:70]}")
        elif row and not rec:
            if b is not None and rh == b:
                # note was deleted in the vault and D1 hasn't changed since
                api.call("DELETE", f"/api/sync/tasks/{tid}")
                base.pop(tid, None)
                stats["deleted_row"] += 1
                log(f"deleted in vault -> removed from D1: {row['title'][:70]}")
                continue
            fm, body = row_to_note(row)
            path = os.path.join(folder, safe_filename(fm["title"]) + ".md")
            if path in taken or os.path.exists(path):
                path = os.path.join(folder, f"{safe_filename(fm['title'])} ({tid[:8]}).md")
            taken.add(path)
            if not dry:
                atomic_write(path, render_note(fm, body))
            base[tid] = rh
            stats["recreated" if b is not None else "created_note"] += 1
            if b is not None:
                log(f"recreated (changed in D1 after vault delete): {fm['title'][:70]}")
        elif rec and not row:
            # in the vault with an id D1 doesn't know (imported note, or D1 row lost)
            ts = rec["fm"].get("updated_at") or mtime_iso(rec["mtime"])
            api.call("PUT", f"/api/sync/tasks/{tid}", note_to_row(tid, rec, str(ts)))
            base[tid] = vh
            stats["created_row"] += 1
            log(f"vault-only -> D1  {rec['fields']['title'][:70]}")

    for tid in list(base):
        if tid not in notes and tid not in rows:
            base.pop(tid)

    state["last_run"] = now_iso()
    if not dry:
        os.makedirs(APP_DIR, exist_ok=True)
        atomic_write(STATE_FILE, json.dumps(state, indent=1, sort_keys=True))
    summary = " ".join(f"{k}={v}" for k, v in stats.items() if v)
    log(("DRY " if dry else "") + f"ok vault={len(notes) + len(no_id)} d1={len(rows)} {summary or 'no changes'}")
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--vault", default=DEFAULT_VAULT)
    a = ap.parse_args()
    lock = os.path.join(APP_DIR, "tasks-sync.lock")
    os.makedirs(APP_DIR, exist_ok=True)
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        if dt.datetime.now().timestamp() - os.path.getmtime(lock) < 600:
            log("skip: another sync is running")
            return 0
        os.remove(lock)
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        run(a.vault, a.dry_run)
        # 4.6 — journal mirror (Notch/Journal). Isolated: a failure is
        # logged by the mirror itself and never fails task sync.
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "notch_journal_mirror", os.path.join(APP_DIR, "notch_journal_mirror.py"))
            jm = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(jm)
            jm.mirror(a.vault, a.dry_run)
        except Exception as e:
            log(f"journal mirror error: {e}")
        return 0
    except Exception as e:  # keep launchd quiet but leave a trail
        log(f"error: {e}")
        return 1
    finally:
        os.close(fd)
        os.remove(lock)


if __name__ == "__main__":
    sys.exit(main())
