#!/usr/bin/env python3
"""notch-projects-sync — keeps Obsidian project notes and Notch's projects in step.

Two-way, like notch-tasks-sync. A project is any vault note whose
frontmatter has `type: project` (most live in Command Center/Projects).
Its `id` (a uuid) is the key on both sides; tasks point at it with
`project_id`, so renaming a note or a project never breaks a link.

  vault note property        D1 projects column     Notch API field
  title                      title                  title
  space                      space                  space (work|ministry|study)
  status                     status                 status (Active|Paused|Done)
  goal                       description            description
  next_milestone             next                   next
  next_milestone_date        next_due               nextDue
  due                        due                    due
  updated_at                 updated_at             updatedAt

Rules, per project id:
  only in the vault          → pushed to Notch (a note without `id` gets one)
  only in Notch, never seen  → new note in Command Center/Projects (made on the phone)
  on both, fields differ     → the side with the newer updated_at wins
  gone from the vault        → removed from Notch (its tasks keep the task, lose the link)
  gone from Notch only       → pushed again (the phone can't delete projects)

Runs at the end of each notch-tasks-sync pass, after the journal mirror;
a failure here is logged and never stops task sync. Only frontmatter lines
it owns are rewritten; every other property and the body are left alone.

Usage: notch_projects_sync.py [--dry-run] [--vault PATH] [--config PATH]
"""
import argparse, datetime as dt, hashlib, json, os, re, subprocess, sys, tempfile, uuid

HOME = os.path.expanduser("~")
APP_DIR = os.path.join(HOME, "Library", "Application Support", "Notch")
DEFAULT_VAULT = os.path.join(HOME, "Obsidian", "Vault")
STATE_FILE = os.path.join(APP_DIR, "projects-sync-state.json")
LOG_FILE = os.path.join(APP_DIR, "tasks-sync.log")  # one log for the whole sync
NEW_FOLDER = "Command Center/Projects"
SKIP_DIRS = ("_", ".")                                # _migration, _attachments, .obsidian …
SPACES = ("work", "ministry", "study")
STATUSES = ("Active", "Paused", "Done")
# vault property → D1 column
FIELDS = [("title", "title"), ("space", "space"), ("status", "status"), ("goal", "description"),
          ("next_milestone", "next"), ("next_milestone_date", "next_due"), ("due", "due")]
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def log(msg):
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} projects: {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_config(path):
    cfg = {}
    with open(path, encoding="utf-8") as f:
        for raw in f:
            if "=" in raw and not raw.strip().startswith("#"):
                k, v = raw.strip().split("=", 1)
                cfg[k.strip()] = v.strip().strip("'\"")
    return cfg


def call(cfg, method, path, body=None):
    args = ["curl", "-sS", "--max-time", "30", "-X", method, cfg["WORKER_URL"] + path,
            "-H", f"x-app-key: {cfg['APP_KEY']}", "-H", "content-type: application/json",
            "-w", "\n%{http_code}"]
    if body is not None:
        args += ["--data-binary", json.dumps(body)]
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"curl {method} {path}: {p.stderr.strip()}")
    out, _, code = p.stdout.rpartition("\n")
    if not code.startswith("2"):
        raise RuntimeError(f"{method} {path}: HTTP {code} {out[:200]}")
    return json.loads(out) if out else {}


def atomic_write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".notch-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


# ── frontmatter, line-level (never re-serialises properties we don't own) ──
FM_RE = re.compile(r"^---\n(.*?)\n---\n?", re.S)


def split_fm(text):
    m = FM_RE.match(text)
    return (m.group(1), text[m.end():]) if m else (None, text)


def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        try:
            return json.loads(v)
        except ValueError:
            return v[1:-1]
    if len(v) >= 2 and v[0] == "'" and v[-1] == "'":
        return v[1:-1].replace("''", "'")
    return v


def fm_get(fm, key):
    m = re.search(r"^" + re.escape(key) + r":[ \t]*(.*)$", fm, re.M)
    return unquote(m.group(1)) if m else None


def fm_set(fm, key, value):
    line = f"{key}: {json.dumps(value, ensure_ascii=False)}" if value not in (None, "") else f"{key}: \"\""
    pat = re.compile(r"^" + re.escape(key) + r":.*(\n[ \t]+.*)*$", re.M)   # incl. folded/list continuation
    if pat.search(fm):
        return pat.sub(lambda _m: line, fm, count=1)
    return fm.rstrip("\n") + "\n" + line


def norm_date(v):
    v = (v or "").strip()
    return v[:10] if DATE_RE.match(v) else ""


def vault_row(fm, path):
    """Vault note → the normalised row both sides compare."""
    row = {}
    for prop, col in FIELDS:
        v = fm_get(fm, prop) or ""
        if col in ("next_due", "due"):
            v = norm_date(v)
        row[col] = v.strip()
    if not row["title"]:
        row["title"] = os.path.basename(path)[:-3]
    row["space"] = row["space"].lower() if row["space"].lower() in SPACES else ""
    row["status"] = row["status"] if row["status"] in STATUSES else "Active"
    return row


def d1_row(r):
    return {
        "title": (r.get("title") or "").strip(), "space": r.get("space") or "",
        "status": r.get("status") if r.get("status") in STATUSES else "Active",
        "description": (r.get("description") or "").strip(), "next": (r.get("next") or "").strip(),
        "next_due": norm_date(r.get("next_due")), "due": norm_date(r.get("due")),
    }


def to_api(row, updated_at):
    return {"title": row["title"], "space": row["space"] or None, "status": row["status"],
            "description": row["description"], "next": row["next"],
            "nextDue": row["next_due"] or None, "due": row["due"] or None, "updated_at": updated_at}


def iso_mtime(path):
    return dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def scan_vault(vault):
    out = {}
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if not d.startswith(SKIP_DIRS) and d != "Archive"]
        for f in files:
            if not f.endswith(".md"):
                continue
            p = os.path.join(root, f)
            try:
                with open(p, encoding="utf-8") as h:
                    head = h.read(512)
                    if not head.startswith("---"):
                        continue
                    text = head + h.read()
            except (OSError, UnicodeDecodeError):
                continue
            fm, body = split_fm(text)
            if fm is None or (fm_get(fm, "type") or "").strip() != "project":
                continue
            out[p] = (fm, body)
    return out


def safe_name(s):
    return re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|#^\[\]]', " ", s)).strip()[:120] or "Untitled project"


def sync(vault, cfg, dry=False):
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    notes = scan_vault(vault)
    by_id, pushed, pulled, created, deleted = {}, 0, 0, 0, 0

    # 1. give every project note an id
    for p, (fm, body) in list(notes.items()):
        pid = (fm_get(fm, "id") or "").strip()
        if not re.fullmatch(r"[0-9a-f-]{36}", pid or ""):
            pid = str(uuid.uuid4())
            fm = fm_set(fm, "id", pid)
            if not dry:
                atomic_write(p, "---\n" + fm + "\n---\n" + body)
            notes[p] = (fm, body)
            log(f"id added: {os.path.relpath(p, vault)}")
        by_id[pid] = p

    remote = {r["id"]: r for r in call(cfg, "GET", "/api/sync/projects").get("projects", [])}
    new_state = {}

    for pid in sorted(set(by_id) | set(remote)):
        p = by_id.get(pid)
        r = remote.get(pid)
        if p and not r:
            if pid in state and state[pid].get("in_d1"):
                log(f"re-pushing (gone from Notch): {os.path.relpath(p, vault)}")
            fm, _ = notes[p]
            row = vault_row(fm, p)
            upd = fm_get(fm, "updated_at") or iso_mtime(p)
            if not dry:
                call(cfg, "PUT", f"/api/sync/projects/{pid}", to_api(row, upd))
            pushed += 1
            new_state[pid] = {"path": os.path.relpath(p, vault), "in_d1": True}
            continue
        if r and not p:
            if pid in state:  # was in the vault before → deleted there
                if not dry:
                    call(cfg, "DELETE", f"/api/sync/projects/{pid}")
                deleted += 1
                log(f"removed from Notch (note deleted): {state[pid].get('path')}")
                continue
            row = d1_row(r)
            path = os.path.join(vault, NEW_FOLDER, safe_name(row["title"]) + ".md")
            n = 2
            while os.path.exists(path):
                path = os.path.join(vault, NEW_FOLDER, f"{safe_name(row['title'])} {n}.md"); n += 1
            fm = "\n".join([f"title: {json.dumps(row['title'], ensure_ascii=False)}", f'id: "{pid}"', 'type: "project"'])
            for prop, col in FIELDS[1:]:
                fm = fm_set(fm, prop, row[col])
            fm = fm_set(fm, "updated_at", r.get("updated_at") or "")
            if not dry:
                atomic_write(path, "---\n" + fm + "\n---\n\nCreated in Notch.\n")
            created += 1
            log(f"new note from Notch: {os.path.relpath(path, vault)}")
            new_state[pid] = {"path": os.path.relpath(path, vault), "in_d1": True}
            continue
        # on both sides
        fm, body = notes[p]
        vrow, rrow = vault_row(fm, p), d1_row(r)
        new_state[pid] = {"path": os.path.relpath(p, vault), "in_d1": True}
        if vrow == rrow:
            continue
        v_upd = fm_get(fm, "updated_at") or iso_mtime(p)
        r_upd = r.get("updated_at") or ""
        if v_upd >= r_upd:
            if not dry:
                call(cfg, "PUT", f"/api/sync/projects/{pid}", to_api(vrow, v_upd))
            pushed += 1
        else:
            for prop, col in FIELDS:
                if prop == "title" and not rrow["title"]:
                    continue
                if vrow[col] != rrow[col]:
                    fm = fm_set(fm, prop, rrow[col])
            fm = fm_set(fm, "updated_at", r_upd)
            if not dry:
                atomic_write(p, "---\n" + fm + "\n---\n" + body)
            pulled += 1
            log(f"updated from Notch: {os.path.relpath(p, vault)}")

    if not dry:
        atomic_write(STATE_FILE, json.dumps(new_state, indent=1))
    if pushed or pulled or created or deleted:
        log(f"pushed {pushed}, pulled {pulled}, new notes {created}, removed {deleted}" + (" (dry run)" if dry else ""))
    return {"pushed": pushed, "pulled": pulled, "created": created, "deleted": deleted}


def main():
    global STATE_FILE
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--vault", default=DEFAULT_VAULT)
    ap.add_argument("--config", default=os.path.join(APP_DIR, "config"))
    ap.add_argument("--state", default=STATE_FILE)
    a = ap.parse_args()
    STATE_FILE = os.path.abspath(a.state)
    try:
        print(json.dumps(sync(a.vault, load_config(a.config), a.dry_run)))
    except Exception as e:  # never stop task sync
        log(f"failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
