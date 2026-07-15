// concursus.js — CONCURSUS tab (Domain model v2) for the Tasks PWA
// Load order: AFTER app.js — reuses the global localISO(), the one date
// function this codebase trusts. Never toISOString()/toDateString() here
// for storage keys (Phase 0 req 9 / Phase 1 req 9).
//
// Storage is namespaced under concursus-state-v1 and never reads or writes
// tasks-cache-v2, tasks-cache-v1, tasks-cfg-v1, tasks-groups-collapsed-v1,
// or any Tasks view state (Phase 1 req 7).
//
// Public surface (Phase 1 req 3 / req 10): init, status, mandateFor,
// getProjectedTasks, toggleDomain, subscribe. Everything else here is
// private — storage parsing, roll derivation internals, re-roll timers,
// and CONCURSUS's own DOM rendering are not part of the contract app.js
// is allowed to depend on.

const CONCURSUS = (() => {
  const STATE_KEY = "concursus-state-v1";
  const LEGACY_STATE_KEY = "concursus_state";
  const NOVAXA_URL = "https://merrickjo.github.io/novaxa-fitness/";
  const DOMAIN_KEYS = ["intake", "synthesis", "exercise", "scripture"];

  // ---------- Domain model v2 ----------
  // Exact protocol language retained from the frozen standalone source.
  const INTAKE = [
    {
      name: "No Sugar + Savory BF",
      detail: "Zero added sugar all day (including sweetened coffee). Savory breakfast only. HbA1c 5.7% — flatten the morning glucose curve.",
    },
    {
      name: "No Fried + Clean Fat",
      detail: "Zero deep-fried food all day. Choose clean fats: olive oil, avocado, nuts, fatty fish. Hypercholesterolemia on Rosuvastatin 20mg.",
    },
    {
      name: "IF + Protein Front-Load",
      detail: "Intermittent fasting (16:8 minimum). Break the fast with 30g+ protein and fiber first. MPS threshold (Lyon) + glucose sequencing (Inchauspé).",
    },
  ];

  const SYNTHESIS = [
    { name: "Bible Project Podcast", detail: "One episode, notes in hand. One mode per day — no channel surfing." },
    { name: "Polymath Books", detail: "One deep block in the current book. Capture to Polymath Books Learning." },
    { name: "Acquire", detail: "Project-convergent skill work. Ship a visible artifact, however small." },
    { name: "Knowledge Podcast", detail: "One episode from the Snipd queue. Snip as you listen — no passive play." },
  ];

  const EXERCISE = [
    { name: "Low Heart Zone 2", detail: "Treadmill — 30–60 minutes at conversational pace, approximately 60–70% max HR." },
    { name: "Novaxa Session — 30 min", detail: "Generate today's session from Novaxa's recovery logic and complete 30 minutes.", href: NOVAXA_URL },
  ];

  // Exact daily non-negotiables retained from the standalone source.
  const NON_NEGOTIABLES = [
    ["Protein", "30g protein per meal minimum. At 83.9kg: 130–150g/day."],
    ["Fiber", "Fiber first, carbs last. Eat sayur or salad before rice at every meal."],
    ["ACV", "1 tbsp apple cider vinegar in water before high-carb meals."],
    ["Ferment", "One fermented food daily: kimchi, yogurt, tempe, or kombucha."],
    ["Rice", "Reduce rice portions by 30–40%; replace with protein or vegetables."],
    ["Sleep", "Stop eating three hours before sleep. Supports eGFR 88.3."],
    ["Coffee", "Default coffee: black or a splash of milk. Sweetened maximum 1–2 times per week."],
  ];

  // Triad → books verified against the C EXEGESIS reading plans, 15 Jul 2026.
  // Final Week: Passion Synthesis (Mark, John) is a capstone week in the NT
  // plan, not a rotation triad — deliberately excluded from the roll table.
  const OT_TRIADS = [
    { name: "Covenant", books: "Genesis · Exodus · Leviticus · Numbers · Deuteronomy" },
    { name: "Kingdom", books: "Joshua · Judges · Ruth · 1–2 Samuel · 1–2 Kings · 1–2 Chronicles" },
    { name: "Exile", books: "Ezra · Nehemiah · Esther · Lamentations · Daniel" },
    { name: "Prophets", books: "Isaiah · Jeremiah · Ezekiel · Hosea · Joel · Amos · Obadiah · Jonah · Micah · Nahum · Habakkuk · Zephaniah · Haggai · Zechariah · Malachi" },
    { name: "Promised One", books: "Psalms" },
    { name: "Wisdom", books: "Job · Proverbs · Ecclesiastes · Song of Solomon" },
  ];
  const NT_TRIADS = [
    { name: "The Righteousness Revolution", books: "Romans · Galatians · Hebrews" },
    { name: "The Apocalyptic Imagination", books: "Revelation · 1 Peter · Mark" },
    { name: "The Incarnate Word", books: "John · Philippians · Colossians · James" },
    { name: "The Kingdom Embodied", books: "Matthew · 1 Corinthians · Ephesians" },
    { name: "The Witness Unfolds", books: "Luke · Acts" },
    { name: "Epilogue · Letters That Remain", books: "1–2 Thessalonians · 1–2 Timothy · Titus · Philemon · 2 Peter · 1–3 John · Jude" },
  ];

  // ---------- Mandate derivation (Phase 1 req 10) ----------
  // Deterministic and total: every integer 1–20 resolves all four domains.
  // Distribution across rolls 1–20: synthesis 5/5/5/5 · exercise 10/10 ·
  // intake 7/7/6 · scripture: odd rolls OT, even rolls NT, triads cycled —
  // every triad appears at least once, eight appear twice. Tune by editing
  // the arrays, not the math.
  function mandateFor(roll) {
    if (!Number.isInteger(roll) || roll < 1 || roll > 20) {
      throw new RangeError("CONCURSUS.mandateFor: roll must be an integer 1–20, got " + roll);
    }
    const i = roll - 1;
    const testament = i % 2 === 0 ? "OT" : "NT";
    const triads = testament === "OT" ? OT_TRIADS : NT_TRIADS;
    const triad = triads[Math.floor(i / 2) % 6];
    return {
      intake: INTAKE[i % 3],
      synthesis: SYNTHESIS[i % 4],
      exercise: EXERCISE[i % 2],
      scripture: { name: testament + " · " + triad.name, detail: triad.books },
    };
  }

  // ---------- State (local-midnight reset via localISO) ----------
  function blankState() {
    return { date: localISO(), roll: null, done: { intake: false, synthesis: false, exercise: false, scripture: false } };
  }

  function isValidState(s) {
    if (!s || typeof s !== "object") return false;
    if (typeof s.date !== "string") return false;
    if (s.roll !== null && !(Number.isInteger(s.roll) && s.roll >= 1 && s.roll <= 20)) return false;
    if (!s.done || typeof s.done !== "object") return false;
    for (const key of DOMAIN_KEYS) {
      if (typeof s.done[key] !== "boolean") return false;
    }
    return true;
  }

  // Phase 1 req 8 — legacy migration, attempted only when the canonical key
  // is entirely absent, and only once (the legacy key is removed on success).
  function migrateLegacy() {
    let legacy;
    try {
      legacy = JSON.parse(localStorage.getItem(LEGACY_STATE_KEY));
    } catch {
      return null;
    }
    if (!legacy || typeof legacy !== "object") return null;
    if (legacy.date !== new Date().toDateString()) return null;
    if (!Number.isInteger(legacy.roll) || legacy.roll < 1 || legacy.roll > 20) return null;
    const migrated = {
      date: localISO(),
      roll: legacy.roll,
      done: {
        intake: !!(legacy.done && legacy.done.intake),
        synthesis: !!(legacy.done && legacy.done.synthesis),
        exercise: !!(legacy.done && legacy.done.exercise),
        scripture: !!(legacy.done && legacy.done.ot), // legacy key `ot` -> `scripture`
      },
    };
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_STATE_KEY); // only after the new write succeeds
      return migrated;
    } catch {
      return null; // migration write failed — leave legacy key alone, fall through to blank
    }
  }

  function loadState() {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw === null) {
      // Canonical key absent — this is the one point where legacy migration
      // is attempted (Phase 1 req 8), never on subsequent loads.
      const migrated = migrateLegacy();
      if (migrated) return migrated;
      return blankState();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return blankState(); // malformed storage resets safely
    }
    if (!isValidState(parsed)) return blankState();
    if (parsed.date !== localISO()) return blankState(); // local-midnight boundary
    return parsed;
  }

  function saveState(s) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(s));
      return true;
    } catch {
      return false; // storage-write failure — caller keeps previous visible state
    }
  }

  let state = loadState();
  let root = null;
  let boundContainer = null;
  let visibilityBound = false;
  let lastError = "";
  let lastProjectionError = ""; // set by getProjectedTasks() on a fail-closed mandate resolution

  // ---------- Subscribers (Phase 1 req 16) ----------
  const listeners = new Set();
  function notify() {
    const snapshot = status();
    listeners.forEach((fn) => {
      try { fn(snapshot); } catch { /* a bad subscriber doesn't break the module */ }
    });
  }
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ---------- Public status ----------
  function status() {
    state = loadState();
    const done = DOMAIN_KEYS.filter((k) => state.done[k]).length;
    return { date: state.date, roll: state.roll, done, total: 4, carpe: state.roll !== null && done === 4 };
  }

  // ---------- Projection (Phase 1 req 15, consumed by Phase 3) ----------
  function getProjectedTasks() {
    state = loadState();
    if (state.roll === null) return [];
    // Phase 3 req 13 -- fail closed: if the mandate can't resolve for any
    // reason, return no tasks at all rather than a partial four. This
    // shouldn't happen in practice (state.roll is already validated 1-20
    // by isValidState before it's ever stored), but getProjectedTasks() is
    // now load-bearing for the Tasks tab's own render() path, so a thrown
    // exception here must never propagate up and break Tasks rendering.
    let mandate;
    try {
      mandate = mandateFor(state.roll);
    } catch {
      lastProjectionError = "Couldn't resolve today's mandate for roll " + state.roll + ".";
      return [];
    }
    lastProjectionError = "";
    return DOMAIN_KEYS.map((key, idx) => {
      const task = {
        id: "concursus:" + state.date + ":" + key,
        domain: key,
        source: "concursus",
        title: mandate[key].name,
        detail: mandate[key].detail,
        completed: !!state.done[key],
        order: idx + 1,
      };
      if (mandate[key].href) task.href = mandate[key].href;
      return Object.freeze(task);
    });
  }

  // ---------- Actions ----------
  let pendingRoll = null;

  function commitRoll(n) {
    const next = { date: localISO(), roll: n, done: { intake: false, synthesis: false, exercise: false, scripture: false } };
    pendingRoll = null;
    if (!saveState(next)) {
      lastError = "Couldn't save the roll — storage may be full. Try again.";
      render();
      return false;
    }
    state = next;
    lastError = "";
    render();
    notify();
    return true;
  }

  function randomRoll() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return (buf[0] % 20) + 1;
  }

  function requestRoll(n) {
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      lastError = "Enter a number from 1 to 20.";
      render();
      return false;
    }
    state = loadState();
    if (state.roll === null) return commitRoll(n);
    pendingRoll = n;
    showRerollOverlay();
    return true;
  }

  function rollDie() { requestRoll(randomRoll()); }

  function toggleDomain(key) {
    if (!DOMAIN_KEYS.includes(key)) return false;
    state = loadState();
    if (state.roll === null) return false;
    const next = { ...state, done: { ...state.done, [key]: !state.done[key] } };
    if (!saveState(next)) {
      lastError = "Couldn't save that — storage may be full.";
      render();
      return false;
    }
    state = next;
    lastError = "";
    render();
    notify();
    return true;
  }

  // Re-roll friction: name the cost, make it wait. Confirm arms after 5s.
  // Closing/backgrounding the app while this is open loses `pendingRoll`
  // (it's in-memory only), so nothing commits silently (Phase 1 req 12).
  function showRerollOverlay() {
    const backdrop = el("div", "cc-overlay");
    const panel = el("div", "cc-overlay-panel");
    panel.appendChild(el("h2", "cc-overlay-title", "The die has spoken."));
    panel.appendChild(el("p", "cc-overlay-body",
      "A re-roll erases today's mandate and its progress. The point of the roll is that you don't get to pick."));
    const confirm = el("button", "cc-overlay-confirm", "RE-ROLL IN 5");
    confirm.disabled = true;
    let t = 5;
    const timer = setInterval(() => {
      t -= 1;
      confirm.textContent = t > 0 ? "RE-ROLL IN " + t : "RE-ROLL ANYWAY";
      if (t <= 0) { confirm.disabled = false; clearInterval(timer); }
    }, 1000);
    confirm.addEventListener("click", () => {
      if (confirm.disabled || pendingRoll === null) return;
      clearInterval(timer);
      document.body.removeChild(backdrop);
      commitRoll(pendingRoll);
    });
    const cancel = el("button", "cc-overlay-cancel", "Keep the roll");
    cancel.addEventListener("click", () => {
      clearInterval(timer);
      pendingRoll = null;
      document.body.removeChild(backdrop);
    });
    panel.appendChild(confirm);
    panel.appendChild(cancel);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
  }

  // ---------- Render (CONCURSUS's own surface — private) ----------
  const DOMAINS = [
    ["intake", "Intake"],
    ["synthesis", "Synthesis"],
    ["exercise", "Exercise"],
    ["scripture", "Scripture Triad"],
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  // Purely decorative — a flat-line d20 silhouette for the ungoverned empty
  // state. Static SVG string via innerHTML (safe: hardcoded, no user input)
  // rather than createElementNS boilerplate for a one-off icon. No fill, no
  // gradient/shadow/glow per the Signature Lock rules -- outline only, in
  // the one permitted accent color.
  function buildDieIcon() {
    const wrap = el("div", "cc-die-icon");
    wrap.innerHTML =
      '<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">' +
      '<path d="M60,10 L103.3,35 L103.3,85 L60,110 L16.7,85 L16.7,35 Z"/>' +
      '<path d="M60,10 L103.3,85 M60,10 L16.7,85 M60,110 L103.3,35 M60,110 L16.7,35"/>' +
      '</svg>';
    return wrap;
  }

  function buildManualEntry() {
    const wrap = el("div", "cc-manual");
    const row = el("div", "cc-manual-row");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "20";
    input.placeholder = "physical die";
    input.className = "cc-manual-input";
    const ok = el("button", "cc-manual-btn", "SET");
    ok.addEventListener("click", () => {
      const n = parseInt(input.value, 10);
      requestRoll(n);
    });
    row.appendChild(input);
    row.appendChild(ok);
    wrap.appendChild(row);
    if (lastError) wrap.appendChild(el("p", "cc-manual-error", lastError));
    return wrap;
  }

  function render() {
    if (!root) return;
    state = loadState();
    root.innerHTML = "";

    const head = el("div", "cc-head");
    head.appendChild(el("div", "cc-kicker", state.date));
    head.appendChild(el("h1", "cc-title", "CONCURSUS"));
    root.appendChild(head);

    if (state.roll === null) {
      const stage = el("div", "cc-roll-stage");
      stage.appendChild(buildDieIcon());
      stage.appendChild(el("p", "cc-ungoverned", "No roll yet — the day is ungoverned."));
      const btn = el("button", "cc-roll-btn", "ROLL D20");
      btn.addEventListener("click", rollDie);
      stage.appendChild(btn);
      stage.appendChild(buildManualEntry());
      root.appendChild(stage);
      return;
    }

    let m;
    try {
      m = mandateFor(state.roll);
    } catch {
      // Phase 3 req 13 -- fail closed. Show the failure plainly and offer
      // the one recovery path (a fresh roll) rather than rendering a
      // partial or garbled mandate.
      const errStage = el("div", "cc-roll-stage");
      errStage.appendChild(el("p", "cc-error",
        "Couldn't resolve today's mandate for roll " + state.roll + ". Try rolling again."));
      const retryBtn = el("button", "cc-roll-btn", "ROLL D20");
      retryBtn.addEventListener("click", rollDie);
      errStage.appendChild(retryBtn);
      root.appendChild(errStage);
      return;
    }
    const s = status();

    const rollLine = el("div", "cc-roll-line");
    rollLine.appendChild(el("span", "cc-roll-num", "ROLL " + state.roll));
    rollLine.appendChild(el("span", "cc-roll-count", s.done + " / 4"));
    const reroll = el("button", "cc-reroll", "re-roll");
    reroll.addEventListener("click", () => requestRoll(randomRoll()));
    rollLine.appendChild(reroll);
    root.appendChild(rollLine);

    if (s.carpe) root.appendChild(el("div", "cc-carpe", "⚡ CARPE POINT EARNED"));

    DOMAINS.forEach(([key, label]) => {
      const card = el("div", "cc-card" + (state.done[key] ? " done" : ""));
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      const top = el("div", "cc-card-top");
      top.appendChild(el("span", "cc-card-domain", label));
      top.appendChild(el("span", "cc-card-check", state.done[key] ? "COMPLETE" : "—"));
      card.appendChild(top);
      card.appendChild(el("div", "cc-card-name", m[key].name));
      card.appendChild(el("div", "cc-card-detail", m[key].detail));
      if (m[key].href) {
        const a = document.createElement("a");
        a.href = m[key].href;
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "cc-card-link";
        a.textContent = "Open Novaxa ↗";
        a.addEventListener("click", (e) => e.stopPropagation());
        card.appendChild(a);
      }
      card.addEventListener("click", () => toggleDomain(key));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleDomain(key);
        }
      });
      root.appendChild(card);
    });

    const nonneg = el("details", "cc-nonneg");
    const nonnegSummary = el("summary", "cc-nonneg-summary", "DAILY ALL-ROLLS · NON-NEGOTIABLES");
    nonneg.appendChild(nonnegSummary);
    const nonnegList = el("div", "cc-nonneg-list");
    NON_NEGOTIABLES.forEach(([label, text]) => {
      const item = el("div", "cc-nonneg-item");
      item.appendChild(el("strong", "cc-nonneg-label", label));
      item.appendChild(el("span", "cc-nonneg-text", text));
      nonnegList.appendChild(item);
    });
    nonneg.appendChild(nonnegList);
    root.appendChild(nonneg);
  }

  // ---------- init (Phase 1 req 4) ----------
  // No DOM mutation before init() is called. Idempotent: calling it again
  // (e.g. every time the CONCURSUS tab is switched into) re-renders but
  // never duplicates listeners, overlays, or timers.
  function init(container) {
    if (!container) {
      console.error("CONCURSUS.init: expected a container element, got", container);
      return; // fails visibly in development, never touches Tasks
    }
    root = container;
    boundContainer = container;
    render();
    if (!visibilityBound) {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") render();
      });
      visibilityBound = true;
    }
  }

  return { init, status, mandateFor, getProjectedTasks, toggleDomain, subscribe };
})();
