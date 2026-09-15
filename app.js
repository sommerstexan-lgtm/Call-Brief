const STORE_KEY = "callbrief.v1";

const DEFAULT = {
  homeNpa: "936",
  homeNxx: "",
  events: [],
  notes: {}
};

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return structuredClone(DEFAULT);
    return Object.assign(structuredClone(DEFAULT), JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT);
  }
}
function save(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

let state = load();
let current = null;
let tab = "lookup";

function onlyDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

function normalize(raw) {
  let d = onlyDigits(raw);
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length === 10) return { ok: true, national: d, e164: "+1" + d, npa: d.slice(0, 3), nxx: d.slice(3, 6), line: d.slice(6) };
  if (d.length === 7 && state.homeNpa) {
    const n = state.homeNpa + d;
    return { ok: true, national: n, e164: "+1" + n, npa: n.slice(0, 3), nxx: n.slice(3, 6), line: n.slice(6), assumedArea: true };
  }
  if (d.length > 0 && d.length < 10) return { ok: false, partial: d, reason: "Need 10 digits (or 7 if home area is set)." };
  if (d.length > 11) return { ok: false, partial: d, reason: "Too many digits for a NANP number." };
  return { ok: false, partial: d, reason: "Enter a 10-digit U.S./Canada number." };
}

function pretty(n) {
  if (!n || n.length !== 10) return n || "";
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
}

function analyze(info) {
  const pills = [];
  const clues = [];
  const npa = info.npa;
  const nxx = info.nxx;
  const line = info.line;
  const geo = AREA_CODES[npa] || "Unknown area code (may be new overlay or non-NANP)";

  if (TOLL_FREE.has(npa)) {
    pills.push({ t: "Toll-free", k: "warn" });
    clues.push("Toll-free numbers are often used by businesses — and by robocall operations hiding behind 800-style trunks.");
  } else if (PREMIUM.has(npa)) {
    pills.push({ t: "Premium-rate", k: "bad" });
    clues.push("900/976-style numbers can bill the called party. Treat as hostile unless you initiated it.");
  } else if (AREA_CODES[npa]) {
    pills.push({ t: geo.split("—")[0].trim(), k: "sky" });
  } else {
    pills.push({ t: "Unknown NPA", k: "warn" });
  }

  if (/^([0-9])\1{2}$/.test(npa) && npa !== "888" && npa !== "800") {
    pills.push({ t: "Repeating area", k: "warn" });
  }
  if (nxx === "555" && line >= "0100" && line <= "0199") {
    pills.push({ t: "Fictional 555", k: "warn" });
    clues.push("555-01xx is reserved for fiction. Real carriers should not complete these.");
  }
  if (nxx[0] === "1" || nxx === "555") {
    /* NXX historically could not start with 0/1; 555 is special. Modern overlays still avoid 0/1. */
  }
  if (nxx[0] === "0" || nxx[0] === "1") {
    pills.push({ t: "Odd exchange", k: "warn" });
    clues.push("NXX (the next three digits) normally does not start with 0 or 1 on a real assigned number.");
  }

  const seq = info.national;
  if (/(\d)\1{5,}/.test(seq)) {
    pills.push({ t: "Repeated digits", k: "warn" });
    clues.push("Long runs of the same digit are common in generated lists.");
  }
  const rising = "01234567890";
  const falling = "09876543210";
  if (rising.includes(seq.slice(3)) || falling.includes(seq.slice(3)) || rising.includes(seq) || falling.includes(seq)) {
    pills.push({ t: "Sequential", k: "warn" });
  }

  if (state.homeNpa && npa === state.homeNpa) {
    pills.push({ t: "Local area code", k: "good" });
    clues.push("Local area code can be a real neighbor — or neighbor spoofing, which spam shops use on purpose.");
    if (state.homeNxx && nxx === state.homeNxx) {
      pills.push({ t: "Same prefix as you", k: "warn" });
      clues.push("Matching your exact exchange is a classic neighbor-spoof pattern.");
    }
  }

  const prefix6 = npa + nxx;
  const hits = state.events.filter((e) => e.national && e.national.slice(0, 6) === prefix6);
  if (hits.length >= 2) {
    pills.push({ t: hits.length + " from this prefix", k: "bad" });
    clues.push("You have already logged multiple numbers from this 6-digit prefix. That cluster is a watch signal.");
  }

  const prior = state.events.filter((e) => e.national === info.national);
  if (prior.length) {
    pills.push({ t: "Seen " + prior.length + "×", k: "warn" });
  }

  const lastVerdict = prior.length ? prior[0].verdict : (state.notes[info.national] || {}).verdict;
  if (lastVerdict === "spam") pills.push({ t: "You marked spam", k: "bad" });
  if (lastVerdict === "ok") pills.push({ t: "You marked real", k: "good" });

  if (!TOLL_FREE.has(npa) && !PREMIUM.has(npa)) {
    clues.push("This tool cannot see live carrier line-type (mobile vs VoIP) without a paid lookup. Geography below is the number’s area code, not the caller’s GPS.");
  }

  return { geo, pills, clues, prefix6, prior };
}

function addEvent(info, verdict, note) {
  const v = verdict || "logged";
  const n = (note || "").trim();
  const existing = state.events.find((e) => e.national === info.national);
  if (existing) {
    existing.verdict = v;
    existing.note = n;
    existing.ts = Date.now();
    existing.e164 = info.e164;
  } else {
    state.events.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      national: info.national,
      e164: info.e164,
      ts: Date.now(),
      verdict: v,
      note: n
    });
  }
  if (!state.notes[info.national]) state.notes[info.national] = {};
  state.notes[info.national].verdict = v;
  state.notes[info.national].note = n;
  save(state);
  render();
}

function showLookup(raw) {
  const info = normalize(raw);
  current = info.ok ? info : null;
  const box = document.getElementById("result");
  if (!info.ok) {
    box.innerHTML = `<div class="card"><p class="meta">${escapeHtml(info.reason || "Enter a number.")}</p></div>`;
    return;
  }
  const a = analyze(info);
  const savedNote = (state.notes[info.national] || {}).note || "";
  const savedV = (state.notes[info.national] || {}).verdict;
  const labels = { spam: "Spam", maybe: "Not sure", ok: "Real person", logged: "Saved" };
  const already = savedV
    ? `Now tagged <strong>${escapeHtml(labels[savedV] || savedV)}</strong>. Tap a different button to change it. Use Not sure while you wait for another call.`
    : "<strong>Tap one button below to save</strong> this number and note into History.";
  box.innerHTML = `
    <div class="card">
      <div class="pretty">${pretty(info.national)}</div>
      <div class="meta">${info.e164}${info.assumedArea ? " · used your home area code" : ""}</div>
      <div class="pills">${a.pills.map((p) => `<span class="pill ${p.k}">${escapeHtml(p.t)}</span>`).join("")}</div>
      <p class="meta" style="margin-top:10px"><strong>Number geography:</strong> ${escapeHtml(a.geo)}</p>
      <p class="meta"><strong>Prefix watch:</strong> ${info.npa}-${info.nxx}-xxxx</p>
      <ul class="hint">${a.clues.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
      <label class="hint" for="note">Your note</label>
      <textarea id="note" rows="2" placeholder="Medicare pitch, quiet, hung up…">${escapeHtml(savedNote)}</textarea>
      <p class="hint">${already}</p>
      <div class="verdicts">
        <button class="v-spam" data-v="spam">${savedV ? "Change to Spam" : "Save as Spam"}</button>
        <button class="v-maybe" data-v="maybe">${savedV ? "Change to Not sure" : "Save as Not sure"}</button>
        <button class="v-ok" data-v="ok">${savedV ? "Change to Real" : "Save as Real"}</button>
        <button class="v-info" data-v="logged">Save note only</button>
      </div>
    </div>`;
  box.querySelectorAll("[data-v]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const note = document.getElementById("note").value;
      const verdict = btn.getAttribute("data-v");
      addEvent(info, verdict, note);
      showSaved(info, verdict, note);
    });
  });
}

function showSaved(info, verdict, note) {
  const labels = { spam: "Spam", maybe: "Not sure", ok: "Real person", logged: "Saved" };
  const box = document.getElementById("result");
  box.innerHTML = `
    <div class="card">
      <div class="pretty">${pretty(info.national)}</div>
      <p class="meta"><strong>Saved as ${escapeHtml(labels[verdict] || verdict)}</strong></p>
      <p class="meta">Prefix group: ${info.npa}-${info.nxx}-xxxx</p>
      ${note ? `<p class="meta">Note: ${escapeHtml(note)}</p>` : ""}
      <p class="hint">Wrong tag? Change it below. Not sure is the right parking spot while you wait for another call from this number or prefix.</p>
      <div class="verdicts">
        <button class="v-spam" data-v="spam">Change to Spam</button>
        <button class="v-maybe" data-v="maybe">Change to Not sure</button>
        <button class="v-ok" data-v="ok">Change to Real</button>
        <button class="v-info" data-v="logged">Save note only</button>
      </div>
      <div class="row">
        <button class="primary" type="button" id="newNum">Clear — new number</button>
        <button class="ghost" type="button" id="goHist">Open History</button>
      </div>
    </div>`;
  box.querySelectorAll("[data-v]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-v");
      const n = note || "";
      addEvent(info, next, n);
      showSaved(info, next, n);
    });
  });
  document.getElementById("newNum").addEventListener("click", () => {
    document.getElementById("num").value = "";
    box.innerHTML = "";
    document.getElementById("num").focus();
  });
  document.getElementById("goHist").addEventListener("click", () => setTab("history"));
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function eventsByTab() {
  if (tab === "history") return state.events;
  return state.events;
}

function prefixClusters() {
  const map = {};
  state.events.forEach((e) => {
    if (!e.national) return;
    const k = e.national.slice(0, 6);
    map[k] = map[k] || { key: k, count: 0, spam: 0, last: 0 };
    map[k].count++;
    if (e.verdict === "spam") map[k].spam++;
    if (e.ts > map[k].last) map[k].last = e.ts;
  });
  return Object.values(map).sort((a, b) => b.count - a.count || b.last - a.last);
}

function when(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

function renderHistory() {
  const el = document.getElementById("historyList");
  if (!state.events.length) {
    el.innerHTML = `<p class="empty">No numbers saved yet. Look one up and tap a verdict.</p>`;
    return;
  }
  el.innerHTML = state.events
    .slice(0, 200)
    .map((e) => {
      const v = e.verdict || "logged";
      return `<button class="item" data-n="${e.national}">
        <div>${pretty(e.national)} · ${escapeHtml(v)}</div>
        <div class="when">${escapeHtml(when(e.ts))}${e.note ? " · " + escapeHtml(e.note) : ""}</div>
      </button>`;
    })
    .join("");
  el.querySelectorAll("[data-n]").forEach((b) => {
    b.addEventListener("click", () => {
      document.getElementById("num").value = b.getAttribute("data-n");
      setTab("lookup");
      showLookup(b.getAttribute("data-n"));
    });
  });
}

function renderWatch() {
  const el = document.getElementById("watchList");
  const q = onlyDigits(document.getElementById("watchQ") ? document.getElementById("watchQ").value : "");
  let clusters = prefixClusters();
  if (q) clusters = clusters.filter((c) => c.key.startsWith(q));
  clusters = clusters.filter((c) => c.count >= 1);
  if (!clusters.length) {
    el.innerHTML = `<p class="empty">No prefix groups yet. Save a number first, then this list shows area+prefix (502-444).</p>`;
    return;
  }
  el.innerHTML = clusters
    .map((c) => {
      const npa = c.key.slice(0, 3);
      const nxx = c.key.slice(3);
      const geo = AREA_CODES[npa] || "";
      return `<button class="item" data-p="${c.key}">
        <div>${npa}-${nxx}-xxxx · ${c.count} hits${c.spam ? " · " + c.spam + " spam" : ""}</div>
        <div class="when">${escapeHtml(geo)}</div>
      </button>`;
    })
    .join("");
}

function setTab(name) {
  tab = name;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
  if (name === "history") renderHistory();
  if (name === "watch") renderWatch();
  if (name === "settings") {
    document.getElementById("homeNpa").value = state.homeNpa || "";
    document.getElementById("homeNxx").value = state.homeNxx || "";
  }
}

function render() {
  if (tab === "history") renderHistory();
  if (tab === "watch") renderWatch();
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "callbrief-backup.json";
  a.click();
}

function clearAll() {
  if (!confirm("Erase all local CallBrief history on this device?")) return;
  state = structuredClone(DEFAULT);
  save(state);
  render();
  document.getElementById("result").innerHTML = "";
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("go").addEventListener("click", () => showLookup(document.getElementById("num").value));
  document.getElementById("num").addEventListener("keydown", (e) => {
    if (e.key === "Enter") showLookup(document.getElementById("num").value);
  });
  document.getElementById("paste").addEventListener("click", async () => {
    try {
      const t = await navigator.clipboard.readText();
      document.getElementById("num").value = t;
      showLookup(t);
    } catch {
      document.getElementById("num").focus();
      alert("Clipboard blocked. Paste into the box, then tap Look up.");
    }
  });
  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  document.getElementById("saveHome").addEventListener("click", () => {
    state.homeNpa = onlyDigits(document.getElementById("homeNpa").value).slice(0, 3);
    state.homeNxx = onlyDigits(document.getElementById("homeNxx").value).slice(0, 3);
    save(state);
    alert("Home area saved on this device.");
  });
  document.getElementById("exportBtn").addEventListener("click", exportJson);
  document.getElementById("clearBtn").addEventListener("click", clearAll);
  document.getElementById("homeNpa").value = state.homeNpa || "";
  document.getElementById("homeNxx").value = state.homeNxx || "";
  const wq = document.getElementById("watchQ");
  if (wq) wq.addEventListener("input", renderWatch);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
