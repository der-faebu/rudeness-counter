(() => {
  const DEFAULT_NAMES = { a: "Player one", b: "Player two" };
  const POLL_MS = 4000;

  const state = {
    names: { ...DEFAULT_NAMES },
    incidents: [],          // [{id, who, kind: "rude"|"nice", date: "YYYY-MM-DD", quote, at}]
    loaded: false,
    online: false,
    openForm: null,         // {who, kind}
    confirming: null,       // incident id
    filter: "all",
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  };

  let toastTimer;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }
  function setStatus(msg, warn = false) {
    const s = $("status"); s.textContent = msg; s.classList.toggle("warn", warn);
  }

  /* ---------- Dates (all in the viewer's local time) ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const today = () => ymd(new Date());
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
  const validYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseYmd(s));

  function dayLabel(date) {
    if (date === today()) return "Today";
    if (date === daysAgo(1)) return "Yesterday";
    return parseYmd(date).toLocaleDateString(undefined, { weekday: "long" });
  }
  const longDate = (date) => parseYmd(date).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const timeOf = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };

  const isLocked = (who) => nameOf(who) !== DEFAULT_NAMES[who];
  const nameOf = (who) => state.names[who] || DEFAULT_NAMES[who];
  const chrono = (x, y) => (x.date + x.at).localeCompare(y.date + y.at);

  // Walk each person's entries in date order: a nice act cancels the oldest
  // rude one still standing, and does nothing when there's none to cancel.
  // Marks each entry with .effect: "counts" | "cancelled" (rude) | "cancels" | "unused" (nice).
  function settle() {
    for (const who of ["a", "b"]) {
      const standing = [];
      for (const i of state.incidents.filter((x) => x.who === who).sort(chrono)) {
        if (i.kind === "rude") { i.effect = "counts"; i.cancelledBy = null; standing.push(i); }
        else if (standing.length) { const r = standing.shift(); r.effect = "cancelled"; r.cancelledBy = i; i.effect = "cancels"; i.cancels = r; }
        else { i.effect = "unused"; i.cancels = null; }
      }
    }
  }

  function tally(who) {
    const list = state.incidents.filter((i) => i.who === who);
    const rude = list.filter((i) => i.kind === "rude"), nice = list.filter((i) => i.kind === "nice");
    const t = today(), week = daysAgo(6);
    const net = (xs) => xs.filter((i) => i.kind === "rude").length - xs.filter((i) => i.kind === "nice").length;
    return {
      score: rude.filter((i) => i.effect === "counts").length,
      rude: rude.length,
      nice: nice.length,
      today: net(list.filter((i) => i.date === t)),
      week: net(list.filter((i) => i.date >= week && i.date <= t)),
    };
  }
  const signed = (n) => (n > 0 ? "+" + n : n < 0 ? "−" + -n : "0");

  /* ---------- Server ---------- */
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  function apply(data) {
    const names = (data && data.names) || {};
    state.names = {
      a: (typeof names.a === "string" && names.a) || DEFAULT_NAMES.a,
      b: (typeof names.b === "string" && names.b) || DEFAULT_NAMES.b,
    };
    state.incidents = (Array.isArray(data && data.incidents) ? data.incidents : []).map((x) => {
      const at = typeof x.at === "string" ? x.at : "";
      const fromAt = at && !isNaN(new Date(at)) ? ymd(new Date(at)) : today();
      return {
        id: String(x.id || ""),
        who: x.who === "b" ? "b" : "a",
        kind: x.kind === "nice" ? "nice" : "rude",   // older entries were all rude
        date: validYmd(x.date) ? x.date : fromAt,   // older entries only had a timestamp
        quote: typeof x.quote === "string" ? x.quote : "",
        at,
      };
    });
    settle();
    state.loaded = true;
    state.online = true;
    setStatus("Saved to rudeness.json");
  }

  let lastJson = "";
  async function refresh() {
    try {
      const data = await api("GET", "/api/data");
      const json = JSON.stringify(data);
      if (json !== lastJson) {
        lastJson = json; apply(data);
        // Don't wipe a half-typed entry or name when the other person logs something.
        const busy = state.openForm || (document.activeElement && document.activeElement.classList.contains("name"));
        if (!busy) render();
      } else if (!state.online) { state.online = true; setStatus("Saved to rudeness.json"); render(); }
    } catch (_) {
      state.loaded = true;
      if (state.online || !lastJson) {
        state.online = false;
        setStatus(location.protocol === "file:" ? "Start server.py, then open http://127.0.0.1:8000" : "Can't reach server.py. Is it still running?", true);
        render();
      }
    }
  }

  /* ---------- Render ---------- */
  function render() {
    const ta = tally("a"), tb = tally("b");
    const leader = ta.score === tb.score ? null : ta.score > tb.score ? "a" : "b";

    const v = $("verdict");
    if (!state.loaded) v.textContent = "Loading…";
    else if (!state.incidents.length) v.textContent = "Nobody has been rude yet.";
    else if (!ta.score && !tb.score) v.textContent = "All square. Every rude remark has been made up for.";
    else if (!leader) v.textContent = `Dead level at ${ta.score} each. Equally rude.`;
    else v.textContent = `${nameOf(leader)} is ruder by ${Math.abs(ta.score - tb.score)}`;

    renderSide("a", ta, leader === "a");
    renderSide("b", tb, leader === "b");
    renderFilters();
    renderLog();
  }

  function renderSide(who, t, leading) {
    const box = $("side-" + who);
    box.classList.toggle("leading", leading);
    box.replaceChildren();

    const nameInput = el("input", {
      class: "name", id: "name-" + who, maxlength: "28",
      "aria-label": "Name for side " + who.toUpperCase(), disabled: !state.online,
      readonly: isLocked(who),
    });
    nameInput.value = nameOf(who);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") nameInput.blur(); if (e.key === "Escape") { nameInput.value = nameOf(who); nameInput.blur(); } });
    nameInput.addEventListener("change", () => saveName(who, nameInput.value));
    box.append(el("div", { class: "name-row" }, nameInput, leading ? el("span", { class: "tag", text: "Ruder" }) : null));

    box.append(el("div", {},
      el("div", { class: "count", text: String(t.score) }),
      el("div", { class: "count-label", text: t.score === 1 ? "rude remark standing" : "rude remarks standing" })
    ));

    const pips = el("div", { class: "cards", "aria-hidden": "true" });
    for (let i = 0; i < Math.min(t.score, 60); i++) pips.append(el("span", { class: "pip" }));
    box.append(pips);

    const stat = (n, label) => el("span", {}, el("b", { text: n }), document.createTextNode(" " + label));
    box.append(el("div", { class: "split" },
      stat(String(t.rude), "rude"),
      stat(String(t.nice), "nice"),
      stat(signed(t.today), "today"),
      stat(signed(t.week), "last 7 days")
    ));

    const form = state.openForm && state.openForm.who === who ? state.openForm : null;
    if (!form) {
      const open = (kind) => () => { state.openForm = { who, kind }; state.confirming = null; render(); };
      box.append(el("div", { class: "book-btns" },
        el("button", { class: "btn btn-r", type: "button", id: "rude-" + who, disabled: !state.online, onclick: open("rude") }, document.createTextNode("Was rude")),
        el("button", { class: "btn btn-nice", type: "button", id: "nice-" + who, disabled: !state.online, onclick: open("nice") }, document.createTextNode("Was nice"))
      ));
    } else {
      const nice = form.kind === "nice";
      const quote = el("textarea", { id: "quote-" + who, maxlength: "280", placeholder: nice ? "e.g. Brought me a coffee without asking" : "e.g. “Did you even read the ticket?”" });
      const date = el("input", { type: "date", id: "date-" + who, max: today(), required: true });
      date.value = today();
      const formEl = el("form", { class: "booking" },
        el("div", { class: "field" }, el("label", { for: "quote-" + who, text: nice ? `What did ${nameOf(who)} do? (optional)` : `What did ${nameOf(who)} say? (optional)` }), quote),
        el("div", { class: "field" }, el("label", { for: "date-" + who, text: "When" }), date),
        el("div", { class: "form-row" },
          el("button", { class: "btn btn-ghost", type: "button", onclick: () => { state.openForm = null; render(); } }, document.createTextNode("Cancel")),
          el("button", { class: "btn " + (nice ? "btn-nice" : "btn-r"), type: "submit", id: "submit-" + who }, document.createTextNode(nice ? "Log nice" : "Log rude"))
        )
      );
      formEl.addEventListener("submit", (e) => { e.preventDefault(); addIncident(who, form.kind, quote.value, date.value, formEl); });
      box.append(formEl);
      setTimeout(() => quote.focus(), 0);
    }
  }

  function renderFilters() {
    const f = $("filters"); f.replaceChildren();
    [["all", "Both"], ["a", nameOf("a")], ["b", nameOf("b")]].forEach(([key, label]) => {
      f.append(el("button", {
        class: "chip", type: "button", "aria-pressed": String(state.filter === key), title: label, text: label,
        onclick: () => { state.filter = key; render(); },
      }));
    });
  }

  function renderLog() {
    const root = $("days"); root.replaceChildren();
    const message = (title, text) => {
      root.append(el("ol", { class: "entries" },
        el("li", { class: "empty", style: "display:block" }, title ? el("strong", { text: title }) : null, el("div", { text }))));
    };
    if (!state.loaded) return message("", "Loading…");
    if (!state.online && !state.incidents.length) {
      return message("Server not running", "Run  python3 server.py  in this folder, then open http://127.0.0.1:8000 in your browser.");
    }
    const list = state.incidents
      .filter((i) => state.filter === "all" || i.who === state.filter)
      .sort((x, y) => chrono(y, x));
    if (!list.length) {
      return message("Nothing logged yet", "When someone is rude or nice, press the button under their name. It shows up here under the day it happened.");
    }

    const groups = new Map();
    for (const i of list) { if (!groups.has(i.date)) groups.set(i.date, []); groups.get(i.date).push(i); }

    for (const [date, items] of groups) {
      const net = (who) => items.filter((i) => i.who === who).reduce((n, i) => n + (i.kind === "rude" ? 1 : -1), 0);
      const score = state.filter === "all"
        ? `${nameOf("a")} ${signed(net("a"))} · ${nameOf("b")} ${signed(net("b"))}`
        : signed(net(state.filter));
      const ol = el("ol", { class: "entries" });
      for (const i of items) {
        const actions = el("div", { class: "actions" });
        if (state.online) {
          if (state.confirming === i.id) {
            actions.append(el("div", { class: "confirm" },
              el("button", { class: "btn btn-ghost rescind", type: "button", onclick: () => { state.confirming = null; render(); }, text: "Keep" }),
              el("button", { class: "btn btn-ink rescind", type: "button", onclick: () => removeIncident(i.id), text: "Remove" })
            ));
          } else {
            actions.append(el("button", { class: "btn btn-ghost rescind", type: "button", onclick: () => { state.confirming = i.id; render(); }, text: "Appeal" }));
          }
        }
        const logged = i.at ? (ymd(new Date(i.at)) === date ? "at " + timeOf(i.at) : "logged later") : "";
        const short = (d) => (d === today() ? "today" : d === daysAgo(1) ? "yesterday" : longDate(d));
        const effect = {
          counts: "",
          cancelled: i.cancelledBy ? `made up for ${short(i.cancelledBy.date)}` : "",
          cancels: i.cancels ? `cancels the rude one from ${short(i.cancels.date)}` : "",
          unused: "nothing to cancel",
        }[i.effect] || "";
        const meta = [logged, effect].filter(Boolean).join(" · ");
        const spent = i.effect === "cancelled" || i.effect === "unused";
        ol.append(el("li", {},
          el("span", { class: "entry-card" + (i.kind === "nice" ? " nice" : "") + (spent ? " spent" : ""), "aria-hidden": "true" }),
          el("div", { class: "entry-body" },
            el("div", { class: "entry-title" + (i.effect === "cancelled" ? " struck" : ""), text: `${nameOf(i.who)} was ${i.kind}` }),
            i.quote ? el("p", { class: "quote", text: i.quote }) : null,
            meta ? el("div", { class: "meta", text: meta }) : null
          ),
          actions
        ));
      }
      root.append(el("section", { class: "day", "aria-label": longDate(date) },
        el("div", { class: "day-head" },
          el("div", {}, el("span", { class: "day-name", text: dayLabel(date) }), document.createTextNode(" "), el("span", { class: "day-date", text: longDate(date) })),
          el("div", { class: "day-score", text: score })
        ),
        ol
      ));
    }
  }

  /* ---------- Actions ---------- */
  function saved(data) { lastJson = JSON.stringify(data); apply(data); }
  const failed = () => toast("That didn't save. Is server.py still running?");

  async function addIncident(who, kind, quote, date, form) {
    if (!validYmd(date) || date > today()) { toast("Pick a date that isn't in the future."); return; }
    const btn = form.querySelector("[type=submit]"); btn.disabled = true;
    try {
      saved(await api("POST", "/api/incidents", { who, kind, date, quote: quote.trim().slice(0, 280) }));
      state.openForm = null;
      toast(`Logged: ${nameOf(who)} was ${kind} ${date === today() ? "today" : "on " + longDate(date)}`);
      render();
    } catch (_) { btn.disabled = false; failed(); }
  }

  async function removeIncident(id) {
    try {
      saved(await api("DELETE", "/api/incidents/" + encodeURIComponent(id)));
      state.confirming = null; toast("Removed"); render();
    } catch (_) { failed(); }
  }

  async function saveName(who, raw) {
    const name = raw.trim().slice(0, 28);
    if (isLocked(who) || !name || name === nameOf(who)) { render(); return; }
    try { saved(await api("PUT", "/api/names", { [who]: name })); toast("Name saved"); }
    catch (_) { failed(); }
    render();
  }

  /* ---------- Boot ---------- */
  render();
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
