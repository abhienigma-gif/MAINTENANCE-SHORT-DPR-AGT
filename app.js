"use strict";
/* Maintenance Short DPR – NG-2000 rigs.
   Every DPR is stored on the phone first (IndexedDB), then uploaded to the cloud whenever
   the phone is signed in and online. Records carry a `dirty` flag until the upload succeeds. */

const VERSION = "1.1.5";
const RIGS = ["NG-2000-1", "NG-2000-2", "NG-2000-3"];
// With cloud save on, the rig comes from the person's login (their entry in `allowedUsers`):
// "NG-2000-1" / "NG-2000-2" / "NG-2000-3", or "ALL" for the view-only coordinator login.
const BY_LOGIN = Cloud.configured;
let VIEWER = false; // true for the "ALL" login: can read every rig, cannot save or delete
const LEGACY_DBS = ["maintenance-dpr-ng2000-2-v6", "maintenance-dpr-ng2000-1-v6", "maintenance-dpr-ng2000-3-v6"];
const PAGE = 200;

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};

const equipmentGroups = [
  ["Power Pack", ["PP-1", "PP-2", "PP-3", "PP-4"]], ["Mud Pump", ["MP-1", "MP-2", "MP-3"]],
  ["DrawWorks", ["DW", "DWM-A", "DWM-B"]], ["Travelling Block", ["TB"]], ["Crown Block", ["CB"]],
  ["TDS", ["TDS"]], ["AVPH", ["AVPH"]], ["ShaleShaker", ["SS-1", "SS-2", "SS-3"]],
  ["Mud Cleaner", ["MC", "DESILTER", "DESANDER"]], ["Mud Mixer", ["HPP-1", "HPP-2"]],
  ["Super Charger", ["SC-1", "SC-2", "SC-3"]], ["Service HPU", ["SHP-1", "SHP-2", "SHP-3", "SHP-4"]],
  ["Elec. Air. Comp", ["EAC-1", "EAC-2"]], ["DSA Diesel Gen", ["ASHOK LEYLAND", "MAHINDRA"]], ["FGCS", ["FGCS"]], ["NGR", ["NGR"]]
];
const hvacGroups = [["Drill PCR", ["HVAC-1", "HVAC-2", "HVAC-3"]], ["Mud PCR", ["HVAC-1", "HVAC-2", "HVAC-3"]], ["DCC", ["HVAC-1", "HVAC-2"]], ["AVPH Panel", ["HVAC-1"]], ["AVPH Dog House", ["HVAC-1"]]];
const FIELDS = ["dprNo", "fromDT", "toDT", "spudDate", "targetDepth", "currentDepth", "currentOperation", "shutdown", "shutdownReason",
  "energy", "hsdPP", "hsdDSA", "hsdOther", "pol", "grease", "air", "mechanical", "elecInst", "criticalRequirement", "materialsReceived", "materialsSent", "dayCrew", "nightCrew"];

let RIG = null;
let equipmentStatus = {}, hvacStatus = {};
let formDirty = false, draftTimer = null;

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg; t.className = "show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ""; }, kind === "err" ? 5000 : 2800);
}

/* ---------- local database ---------- */
const dbp = new Promise((resolve, reject) => {
  if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
  const r = indexedDB.open("maintenance-dpr-v1", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("dprs", { keyPath: "id" });
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
dbp.catch(() => {});
function run(mode, fn) {
  return dbp.then(db => new Promise((resolve, reject) => {
    const t = db.transaction("dprs", mode);
    const req = fn(t.objectStore("dprs"));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}
const dbAll = () => run("readonly", s => s.getAll());
const dbGet = id => run("readonly", s => s.get(id));
const dbPut = rec => run("readwrite", s => s.put(rec));
const dbDelete = id => run("readwrite", s => s.delete(id));

const makeDocId = (from, to) => (from + "_" + to).replace(/:/g, "");
const recId = (rig, docId) => rig + "__" + docId;

/* ---------- radio groups (equipment / HVAC status) ---------- */
function radioGroup(containerId, groups, prefix, state) {
  const el = $(containerId); el.innerHTML = "";
  groups.forEach((g, gi) => {
    const t = document.createElement("div"); t.className = "group-title"; t.textContent = (gi + 1) + ". " + g[0]; el.appendChild(t);
    g[1].forEach((name, ii) => {
      const key = prefix + "_" + gi + "_" + ii;
      const r = document.createElement("div"); r.className = "status-group";
      const nameEl = document.createElement("div"); nameEl.className = "status-name"; nameEl.textContent = name;
      const choices = document.createElement("div"); choices.className = "choices";
      (g[0] === "NGR" ? ["In Service", "Bypass"] : ["RUN", "S/B", "U/M"]).forEach(v => {
        const wrap = document.createElement("span"); wrap.className = "choice";
        const btn = document.createElement("button"); btn.type = "button"; btn.textContent = v;
        if (state[key] === v) btn.classList.add("selected");
        btn.onclick = () => { state[key] = v; choices.querySelectorAll("button").forEach(b => b.classList.remove("selected")); btn.classList.add("selected"); markDirty(); };
        wrap.appendChild(btn); choices.appendChild(wrap);
      });
      r.appendChild(nameEl); r.appendChild(choices); el.appendChild(r);
    });
  });
}
function renderStatus() {
  radioGroup("equipment", equipmentGroups, "eq", equipmentStatus);
  radioGroup("hvac", hvacGroups, "hv", hvacStatus);
}

/* ---------- DPR number ---------- */
const pad = n => String(n).padStart(2, "0");
function nowLocal() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function setDefaultDates() { const s = nowLocal(); $("fromDT").value = s; $("toDT").value = s; }
function dprDateKey() { const v = $("toDT").value || $("fromDT").value; return v ? v.slice(0, 10) : nowLocal().slice(0, 10); }
function dprShiftSuffix() {
  const f = $("fromDT").value, t = $("toDT").value;
  if (!f || !t) return "";
  const fd = new Date(f), td = new Date(t);
  if (Number.isNaN(fd.getTime()) || Number.isNaN(td.getTime())) return "";
  const fDate = new Date(fd.getFullYear(), fd.getMonth(), fd.getDate());
  const tDate = new Date(td.getFullYear(), td.getMonth(), td.getDate());
  const dayDiff = Math.round((tDate - fDate) / 86400000);
  const startAM = fd.getHours() < 12, startPM = fd.getHours() >= 12;
  const endAM = td.getHours() < 12, endPM = td.getHours() >= 12;
  // Evening DPR: same calendar date, starting in AM and ending in PM.
  if (dayDiff === 0 && startAM && endPM) return "Evening";
  // Morning DPR: end date is one day later, starting in PM and ending in AM.
  if (dayDiff === 1 && startPM && endAM) return "Morning";
  return "";
}
function makeDprNo(dateKey) {
  const [y, m, d] = dateKey.split("-");
  const suffix = dprShiftSuffix();
  return `NG-${RIG.slice(-1)}-${d}${m}${y}${suffix ? "-" + suffix : ""}`;
}
function updateDprNo() { $("dprNo").value = makeDprNo(dprDateKey()); }

/* ---------- form state ---------- */
function collect() {
  const d = { rig: RIG, radios: { ...equipmentStatus, ...hvacStatus } };
  FIELDS.forEach(id => { d[id] = $(id).value; });
  return d;
}
// Sections 5 and 6 are free text. DPRs saved in earlier formats are converted when opened: rows of equipment + job become
// lines "equipment: job", and the old "generic jobs" are added as lines under Mechanical, so nothing is lost.
function sectionTexts(d) {
  const rows = a => (a || []).map(r => (r.eq ? r.eq + ": " : "") + (r.job || "")).filter(x => x.trim()).join("\n");
  if (typeof d.mechanical === "string" || typeof d.elecInst === "string") return [d.mechanical || "", d.elecInst || ""];
  if (Array.isArray(d.mechanical) || Array.isArray(d.elecInst)) return [rows(d.mechanical), rows(d.elecInst)];
  return [[rows(d.maintenance), ...(d.generic || []).filter(x => String(x || "").trim())].filter(Boolean).join("\n"), ""];
}
function fill(d) {
  FIELDS.forEach(id => { $(id).value = d[id] == null ? "" : d[id]; });
  $("rig").value = RIG;
  const [mech, ei] = sectionTexts(d);
  $("mechanical").value = mech; $("elecInst").value = ei;
  equipmentStatus = {}; hvacStatus = {};
  Object.entries(d.radios || {}).forEach(([k, v]) => { if (k.startsWith("eq_")) equipmentStatus[k] = v; else if (k.startsWith("hv_")) hvacStatus[k] = v; });
  renderStatus();
}
function resetForm() {
  FIELDS.forEach(id => { $(id).value = ""; });
  $("rig").value = RIG; setDefaultDates(); updateDprNo();
  equipmentStatus = {}; hvacStatus = {};
  renderStatus();
}

const draftKey = () => "dpr.draft." + RIG;
function saveDraft() { if (RIG && formDirty) store.set(draftKey(), JSON.stringify(collect())); }
function markDirty() { formDirty = true; clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); }
function clearDirty() { formDirty = false; clearTimeout(draftTimer); if (RIG) store.del(draftKey()); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveDraft(); else syncNow(); });
window.addEventListener("pagehide", saveDraft);
$("app").addEventListener("input", markDirty);

/* ---------- save / new / open / delete ---------- */
async function saveDpr() {
  if (VIEWER) return toast("This login is view-only. It cannot save DPRs.", "err");
  const from = $("fromDT").value, to = $("toDT").value;
  if (!from || !to) return toast("Enter both FROM and TO date & time first.", "err");
  if (to < from) return toast("TO date & time is earlier than FROM.", "err");
  updateDprNo();
  const docId = makeDocId(from, to), id = recId(RIG, docId);
  try {
    const existing = await dbGet(id);
    await dbPut({ id, rig: RIG, docId, dprNo: $("dprNo").value, fromDT: from, toDT: to, data: collect(), savedAt: Date.now(), dirty: 1, deleted: false, cloudAt: existing ? existing.cloudAt : null });
    clearDirty();
    const revived = existing && !existing.deleted;
    toast((revived ? "DPR updated: " : "DPR saved: ") + $("dprNo").value + (Cloud.signedIn() ? "" : " (on this phone)"), "ok");
  } catch (e) {
    return toast("Could not save on this phone: " + (e && e.message || e), "err");
  }
  updateChip(); syncNow();
}
$("save").onclick = saveDpr;

$("newDpr").onclick = () => {
  if (formDirty && !confirm("Start a new DPR? Changes you have not saved will be cleared.")) return;
  clearDirty(); resetForm();
};
$("fromDT").addEventListener("change", updateDprNo);
$("toDT").addEventListener("change", updateDprNo);

async function showHistory() {
  const list = $("historyList"); $("historyRig").textContent = "• " + RIG;
  let rows;
  try { rows = (await dbAll()).filter(r => r.rig === RIG && !r.deleted).sort((a, b) => (b.fromDT + b.toDT).localeCompare(a.fromDT + a.toDT)); }
  catch (e) { return toast("Could not read saved DPRs.", "err"); }
  list.innerHTML = "";
  if (!rows.length) list.innerHTML = "<p>No saved DPRs yet.</p>";
  rows.forEach(r => {
    const item = document.createElement("div"); item.className = "history-item";
    const badge = !r.dirty ? '<span class="badge ok">☁ Saved in cloud</span>'
      : Cloud.signedIn() ? '<span class="badge warn">⏳ Waiting to upload</span>'
        : '<span class="badge local">📱 On this phone only</span>';
    item.innerHTML = `<b>${esc(r.dprNo)}</b><br>${esc(fmt(r.fromDT))} TO ${esc(fmt(r.toDT))}<br>${badge}`;
    const actions = document.createElement("div"); actions.className = "history-actions";
    const openBtn = document.createElement("button"); openBtn.type = "button"; openBtn.textContent = "Open"; openBtn.className = "primary";
    openBtn.onclick = () => {
      if (formDirty && !confirm("Open this DPR? Changes you have not saved will be lost.")) return;
      clearDirty(); fill({ ...r.data, dprNo: r.dprNo }); $("historyModal").classList.remove("show");
    };
    const delBtn = document.createElement("button"); delBtn.type = "button"; delBtn.textContent = "Delete"; delBtn.className = "danger";
    delBtn.onclick = () => deleteDpr(r);
    actions.append(...(VIEWER ? [openBtn] : [openBtn, delBtn])); item.appendChild(actions); list.appendChild(item);
  });
  $("historyModal").classList.add("show");
}
async function deleteDpr(r) {
  if (!confirm("Delete " + r.dprNo + (r.cloudAt ? " from this phone and the cloud?" : "?"))) return;
  try {
    // Never uploaded: just remove it. Otherwise keep a "deleted" marker so the delete reaches the cloud and other phones.
    if (!r.cloudAt) await dbDelete(r.id);
    else await dbPut({ ...r, deleted: true, dirty: 1, savedAt: Date.now() });
  } catch (e) { return toast("Could not delete.", "err"); }
  showHistory(); updateChip(); syncNow();
}
$("history").onclick = showHistory;
$("closeHistory").onclick = () => $("historyModal").classList.remove("show");
$("historyModal").addEventListener("click", e => { if (e.target === $("historyModal")) $("historyModal").classList.remove("show"); });

/* ---------- WhatsApp / share text ---------- */
function fmt(v) { if (!v) return ""; const d = new Date(v); if (isNaN(d)) return v; return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function statusText(name, value) { return `${name}: ${value || "—"}`; }
function reportFull(d) {
  const lines = ["MAINTENANCE SHORT DPR", "RIG: " + d.rig, "DPR No.: " + d.dprNo, "DATE & TIME: " + fmt(d.fromDT) + " TO " + fmt(d.toDT), "SPUD DATE: " + d.spudDate, "TARGET DEPTH: " + d.targetDepth, "CURRENT DEPTH: " + d.currentDepth, "CURRENT OPERATION: " + d.currentOperation, "RIG SHUTDOWN STATUS: " + (d.shutdown || "—"), "Reason: " + (d.shutdownReason || "—"), "", "2. CRITICAL EQUIPMENT STATUS", "", "  A. RUNNING:"];
  const buckets = { "RUN": [], "S/B": [], "U/M": [] };
  equipmentGroups.forEach((g, gi) => {
    if (g[0] === "NGR") return;
    const byStatus = { "RUN": [], "S/B": [], "U/M": [] };
    g[1].forEach((n, ii) => { const st = d.radios["eq_" + gi + "_" + ii]; if (byStatus[st]) byStatus[st].push(n); });
    Object.keys(buckets).forEach(st => { if (byStatus[st].length) buckets[st].push(g[0] + " – " + byStatus[st].join(", ")); });
  });
  const statusLabels = ["RUN", "S/B", "U/M"], statusLetters = ["A", "B", "C"];
  statusLabels.forEach((st, idx) => {
    if (idx > 0) lines.push("", "  " + statusLetters[idx] + ". " + (st === "RUN" ? "RUNNING:" : st + ":"));
    if (buckets[st].length) lines.push(...buckets[st].map(x => "    " + x)); else lines.push("    —");
  });
  const ngrGroup = equipmentGroups.find(g => g[0] === "NGR");
  if (ngrGroup) {
    const gi = equipmentGroups.indexOf(ngrGroup);
    const vals = ngrGroup[1].map((n, ii) => d.radios["eq_" + gi + "_" + ii]).filter(Boolean);
    if (vals.length) { lines.push("", "  D. NGR STATUS:"); ngrGroup[1].forEach((n, ii) => { const v = d.radios["eq_" + gi + "_" + ii]; if (v) lines.push("    " + n + " – " + v); }); }
  }
  lines.push("", "3. HVAC STATUS", "");
  hvacGroups.forEach((g, gi) => {
    if (gi > 0) lines.push("");
    lines.push("  " + String.fromCharCode(65 + gi) + ". " + g[0]);
    g[1].forEach((n, ii) => lines.push("    " + statusText(n, d.radios["hv_" + gi + "_" + ii])));
  });
  lines.push("", "4. CRITICAL OPERATIONAL PARAMETERS", "");
  [["Total Energy Generated (MWHr)", d.energy], ["Total HSD Consumed – Power Pack (KL)", d.hsdPP], ["Total HSD Issued – DSA Genset (KL)", d.hsdDSA], ["HSD Issued to Other Dept (KL)", d.hsdOther], ["POL Consumption (Ltr)", d.pol], ["Grease Consumption (Kg)", d.grease], ["Air Pressure (Kg/cm²)", d.air]].forEach((a, i) => lines.push("  " + String.fromCharCode(65 + i) + ". " + a[0] + ": " + a[1]));
  const teamText = t => { const l = String(t || "").split(/\r?\n/).map(x => x.trim()); while (l.length && !l[l.length - 1]) l.pop(); return l.length ? l.map(x => (x ? "    " + x : "")) : ["    —"]; };
  lines.push("", "5. MECHANICAL DPR", "", ...teamText(d.mechanical));
  lines.push("", "6. ELEC & INST DPR", "", ...teamText(d.elecInst));
  lines.push("", "7. INVENTORY / REQUIREMENT", "", "  A. URGENT / CRITICAL REQUIREMENT:", "    " + (d.criticalRequirement || "—"), "", "  B. MATERIALS RECEIVED FROM BASE:", "    " + (d.materialsReceived || "—"), "", "  C. MATERIALS SENT TO BASE:", "    " + (d.materialsSent || "—"));
  lines.push("", "8. CREW DETAILS", "");
  const crewList = v => String(v || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const dayCrew = crewList(d.dayCrew), nightCrew = crewList(d.nightCrew);
  lines.push("  A. DAY SHIFT:");
  if (dayCrew.length) dayCrew.forEach((x, i) => lines.push("    " + (i + 1) + ". " + x)); else lines.push("    —");
  lines.push("");
  lines.push("  B. NIGHT SHIFT:");
  if (nightCrew.length) nightCrew.forEach((x, i) => lines.push("    " + (i + 1) + ". " + x)); else lines.push("    —");
  lines.push("", "END OF DPR"); return lines.join("\n");
}
/* Brief version: your section names and order, only U/M equipment listed, empty items left out, subsections lettered
   A), B), C) and indented, one parameter per line, and a blank line ONLY between sections. */
function reportBrief(d) {
  const lines = v => String(v || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const dmy = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || ""); return m ? `${m[3]}/${m[2]}/${m[1]}` : ""; };
  const I1 = "    ", I2 = "        ";
  const letter = i => String.fromCharCode(65 + i);
  const L = ["MAINTENANCE SHORT DPR"];
  // each block is {title, lines}: "A) title" at the first indent, its lines at the second
  const render = blocks => blocks.flatMap((b, i) => [I1 + letter(i) + ") " + b.title, ...b.lines.map(x => I2 + x)]);
  const section = (title, blocks) => { if (blocks.length) L.push("", title, ...render(blocks)); };

  const period = d.fromDT || d.toDT ? fmt(d.fromDT) + " TO " + fmt(d.toDT) : "";
  [["RIG", d.rig], ["DPR No.", d.dprNo], ["DATE & TIME", period], ["SPUD DATE", dmy(d.spudDate)], ["TARGET DEPTH", d.targetDepth],
    ["CURRENT DEPTH", d.currentDepth], ["CURRENT OPERATION", d.currentOperation], ["RIG SHUTDOWN STATUS", d.shutdown], ["Reason", d.shutdownReason]]
    .forEach(x => { const v = String(x[1] || "").trim(); if (v) L.push(x[0] + ": " + v); });

  // 2. equipment: only what is U/M, group by group (RUN and S/B are not listed)
  const by = { "RUN": [], "S/B": [], "U/M": [] };
  let ngr = "";
  equipmentGroups.forEach((g, gi) => {
    if (g[0] === "NGR") { ngr = d.radios["eq_" + gi + "_0"] || ""; return; }
    const s = { "RUN": [], "S/B": [], "U/M": [] };
    g[1].forEach((n, ii) => { const st = d.radios["eq_" + gi + "_" + ii]; if (s[st]) s[st].push(n); });
    Object.keys(by).forEach(k => { if (s[k].length) by[k].push(g[0] + " – " + s[k].join(", ")); });
  });
  const eq = [];
  if (by["U/M"].length) eq.push({ title: "U/M:", lines: by["U/M"] });
  if (ngr === "Bypass") eq.push({ title: "NGR STATUS:", lines: ["NGR – Bypass"] }); // NGR has no U/M; it is listed only when bypassed
  const anyMarked = by["RUN"].length || by["S/B"].length || by["U/M"].length || ngr;
  if (!eq.length && anyMarked) eq.push({ title: "NO EQUIPMENT IN U/M", lines: [] }); // so a reader can tell it was filled in
  section("2. CRITICAL EQUIPMENT STATUS", eq);

  // 3. HVAC: only what is not running
  const hv = [];
  hvacGroups.forEach((g, gi) => g[1].forEach((n, ii) => hv.push({ name: g[0] + " " + n, st: d.radios["hv_" + gi + "_" + ii] || "" })));
  const marked = hv.filter(x => x.st), unmarked = hv.length - marked.length;
  if (marked.length) {
    const off = marked.filter(x => x.st !== "RUN"), run = marked.filter(x => x.st === "RUN");
    const hb = off.map(x => ({ title: `${x.name} – ${x.st}`, lines: [] }));
    if (!off.length && !unmarked) hb.push({ title: "ALL UNITS – RUN", lines: [] });
    else if (!unmarked) hb.push({ title: "ALL OTHER UNITS – RUN", lines: [] });
    else if (run.length) hb.push({ title: "RUN: " + run.map(x => x.name).join(", "), lines: [] });
    section("3. HVAC STATUS", hb);
  }

  // 4. parameters: one per line, top to bottom, with your own wording and units
  const par = [["Total Energy Generated (MWHr)", d.energy], ["Total HSD Consumed – Power Pack (KL)", d.hsdPP], ["Total HSD Issued – DSA Genset (KL)", d.hsdDSA],
    ["HSD Issued to Other Dept (KL)", d.hsdOther], ["POL Consumption (Ltr)", d.pol], ["Grease Consumption (Kg)", d.grease], ["Air Pressure (Kg/cm²)", d.air]]
    .filter(x => String(x[1] || "").trim());
  if (par.length) L.push("", "4. CRITICAL OPERATIONAL PARAMETERS", ...par.map((x, i) => I1 + letter(i) + ") " + x[0] + ": " + String(x[1]).trim()));

  const teamSection = (title, t) => { const b = lines(t).map(x => I1 + x); if (b.length) L.push("", title, ...b); };
  teamSection("5. MECHANICAL DPR", d.mechanical);
  teamSection("6. ELEC & INST DPR", d.elecInst);
  section("7. INVENTORY / REQUIREMENT", [["URGENT / CRITICAL REQUIREMENT:", d.criticalRequirement], ["MATERIALS RECEIVED FROM BASE:", d.materialsReceived], ["MATERIALS SENT TO BASE:", d.materialsSent]]
    .filter(x => lines(x[1]).length).map(x => ({ title: x[0], lines: lines(x[1]) })));
  section("8. CREW DETAILS", [["DAY SHIFT:", d.dayCrew], ["NIGHT SHIFT:", d.nightCrew]].filter(x => lines(x[1]).length).map(x => ({ title: x[0], lines: lines(x[1]) })));
  L.push("", "END OF DPR");
  return L.join("\n");
}
const report = d => ($("reportFormat").value === "full" ? reportFull(d) : reportBrief(d));
$("reportFormat").onchange = () => store.set("dpr.format", $("reportFormat").value);
$("whatsapp").onclick = async () => {
  const text = report(collect());
  try {
    if (!navigator.share) throw new Error("no-share");
    await navigator.share({ title: "Maintenance Short DPR", text });
  } catch (e) {
    if (e && e.name === "AbortError") return; // user closed the share sheet
    try { await navigator.clipboard.writeText(text); toast("Complete DPR copied. Paste it into WhatsApp.", "ok"); }
    catch (e2) { toast("Could not open share or copy the DPR text.", "err"); }
  }
};

/* ---------- cloud sync ---------- */
let syncing = false, syncError = "", syncErrorCode = "", lastSync = Number(store.get("dpr.lastSync") || 0);
const sinceKey = rig => "dpr.since." + rig;

function cloudMessage(e) {
  switch (e && e.code) {
    case "credentials": return "Wrong User ID or password.";
    case "disabled": return "This account has been disabled. Contact your admin.";
    case "throttled": return "Too many attempts. Wait a few minutes and try again.";
    case "network": return "No internet connection.";
    case "denied": return "This login is not set up for DPR cloud save. Ask your admin to add your User ID to the allowed users.";
    case "norig": return "This login has no rig assigned. Ask your admin to add a rig to your entry in allowedUsers.";
    case "unauth": return "Please sign in again.";
    case "server": return "Cloud service is busy. Will retry.";
    case "config": return "Cloud is not configured.";
    default: return "Cloud error: " + (e && e.message || e);
  }
}

async function mergeRemote(rig, d) {
  const id = recId(rig, d.docId);
  const local = await dbGet(id);
  if (local && local.dirty) return; // a newer local edit is waiting to upload; it will replace the cloud copy
  let data;
  try { data = JSON.parse(d.payload); } catch (e) { return; }
  await dbPut({ id, rig, docId: d.docId, dprNo: d.dprNo, fromDT: d.fromDT, toDT: d.toDT, data, savedAt: Date.now(), dirty: 0, deleted: d.deleted, cloudAt: d.updatedAt });
}

async function syncNow(manual) {
  if (syncing || !RIG) return;
  if (!Cloud.configured || !Cloud.signedIn()) { updateChip(); return; }
  syncing = true; syncError = ""; syncErrorCode = ""; updateChip();
  try {
    // 0. which rig is this login for? (this also picks up a change made by the admin)
    applyProfile((await Cloud.profile()).rig);
    // 1. upload what is waiting on this phone, for this login's rig only
    if (!VIEWER) for (const r of (await dbAll()).filter(r => r.dirty && r.rig === RIG)) {
      const at = await Cloud.push(r);
      const cur = await dbGet(r.id);
      if (cur && cur.savedAt === r.savedAt) await dbPut({ ...cur, dirty: 0, cloudAt: at });
    }
    // 2. download what other phones changed since the last sync (the view-only login downloads every rig)
    for (const rig of (VIEWER ? RIGS : [RIG])) {
      let since = store.get(sinceKey(rig)) || "";
      for (;;) {
        const docs = await Cloud.pull(rig, since, PAGE);
        for (const d of docs) { await mergeRemote(rig, d); if (d.updatedAt) since = d.updatedAt; }
        store.set(sinceKey(rig), since);
        if (docs.length < PAGE) break;
      }
    }
    lastSync = Date.now(); store.set("dpr.lastSync", String(lastSync));
    if (manual) toast("Synced with cloud.", "ok");
  } catch (e) {
    if (e && e.code === "unauth") Cloud.signOut();
    syncError = cloudMessage(e); syncErrorCode = (e && e.code) || "";
    if (manual || (e && e.code !== "network" && e.code !== "server")) toast(syncError, "err");
  } finally {
    syncing = false; updateChip(); renderCloud();
    if ($("historyModal").classList.contains("show")) showHistory();
  }
}
window.addEventListener("online", () => syncNow());
setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, 120000);

/* ---------- header chip + cloud sheet ---------- */
async function updateChip() {
  const chip = $("cloudChip");
  let pending = 0;
  try { pending = (await dbAll()).filter(r => r.dirty).length; } catch (e) { /* ignore */ }
  let text, cls = "";
  if (!Cloud.configured) text = "📱 Phone only";
  else if (!Cloud.signedIn()) { text = "☁ Sign in"; cls = "warn"; }
  else if (syncing) text = "☁ Syncing…";
  else if (syncError && pending) { text = `⏳ ${pending} to upload`; cls = "warn"; }
  else if (syncError && syncErrorCode === "network") text = "📴 Offline";
  else if (syncError) { text = "⚠ Sync problem"; cls = "err"; }
  else if (pending) { text = `⏳ ${pending} to upload`; cls = "warn"; }
  else { text = "☁ Synced"; cls = "ok"; }
  chip.textContent = text; chip.className = "chip " + cls;
}
$("cloudChip").onclick = () => { renderCloud(true); $("cloudModal").classList.add("show"); };
$("closeCloud").onclick = () => $("cloudModal").classList.remove("show");
$("cloudModal").addEventListener("click", e => { if (e.target === $("cloudModal")) $("cloudModal").classList.remove("show"); });

function renderCloud(opening) {
  const signed = Cloud.configured && Cloud.signedIn();
  $("loginBox").hidden = !Cloud.configured || signed;
  $("accountBox").hidden = !signed;
  $("accountEmail").textContent = (Cloud.user() || "") + (VIEWER ? " (view-only, all rigs)" : RIG && BY_LOGIN ? " · " + RIG : "");
  $("syncBtn").disabled = syncing;
  if (opening) { $("loginErr").hidden = true; $("rigSelect").value = RIG; }
  $("cloudNote").textContent = !Cloud.configured
    ? "Cloud save is not set up in this copy of the app yet. DPRs are stored on this phone only. See README.md to connect it."
    : signed ? "Saved DPRs upload automatically. If there is no signal, they wait on the phone and upload when you are back online."
      : "Sign in to save DPRs to the cloud and to see DPRs saved from other phones.";
  const bits = [];
  if (signed) bits.push(lastSync ? "Last synced " + fmt(new Date(lastSync).toISOString()) : "Not synced yet");
  if (syncError) bits.push("⚠ " + syncError);
  $("syncInfo").textContent = bits.join(" • ");
  $("syncInfo").className = "small" + (syncError ? " err" : "");
}
$("loginBtn").onclick = async () => {
  const email = $("loginEmail").value, pw = $("loginPass").value, err = $("loginErr");
  err.hidden = true;
  if (!email.trim() || !pw) { err.textContent = "Enter your User ID and password."; err.hidden = false; return; }
  $("loginBtn").disabled = true;
  try {
    await Cloud.signIn(email, pw);
    $("loginPass").value = ""; toast("Signed in.", "ok");
    renderCloud(); updateChip(); syncNow(true);
  } catch (e) { err.textContent = cloudMessage(e); err.hidden = false; }
  finally { $("loginBtn").disabled = false; }
};
$("loginPass").addEventListener("keydown", e => { if (e.key === "Enter") $("loginBtn").click(); });
$("syncBtn").onclick = () => syncNow(true);
$("logoutBtn").onclick = async () => {
  let pending = 0;
  try { pending = (await dbAll()).filter(r => r.dirty).length; } catch (e) { /* ignore */ }
  if (pending && !confirm(pending + " DPR(s) have not been uploaded yet. They stay on this phone and upload after you sign in again. Sign out?")) return;
  Cloud.signOut(); syncError = ""; renderCloud(); updateChip();
};

/* rig selection */
RIGS.forEach(r => { const o = document.createElement("option"); o.value = r; o.textContent = r; $("rigSelect").appendChild(o); });
$("rigSelect").onchange = () => {
  const next = $("rigSelect").value;
  if (next === RIG) return;
  if (formDirty && !confirm("Switch rig? Changes you have not saved will be kept as a draft for " + RIG + ".")) { $("rigSelect").value = RIG; return; }
  saveDraft(); formDirty = false;
  setRig(next); startRig();
};
function setRig(r) { RIG = r; store.set("dpr.rig", r); }
function setRigSelectVisible(on) { const f = $("rigSelect").parentElement; f.hidden = !on; f.previousElementSibling.hidden = !on; }
// A person with a rig login cannot choose a rig. Only the view-only login (or a phone with no cloud set up) can.
function refreshRigUi() {
  setRigSelectVisible(!BY_LOGIN || VIEWER);
  $("save").disabled = VIEWER;
}
function adoptProfile(prof) {
  VIEWER = prof === "ALL";
  store.set("dpr.profile", prof);
  const last = store.get("dpr.rig");
  RIG = VIEWER ? (RIGS.includes(last) ? last : RIGS[0]) : prof;
  store.set("dpr.rig", RIG);
}
// Called with the rig read from the cloud. Rebuilds the screen only if it differs from what this phone remembered.
function applyProfile(prof) {
  if (prof !== "ALL" && !RIGS.includes(prof)) throw new Cloud.CloudError("norig", "Unknown rig " + prof);
  if (prof === store.get("dpr.profile") && RIG) { refreshRigUi(); return; }
  saveDraft(); formDirty = false;
  adoptProfile(prof); startRig();
}
function showRigPicker() {
  const box = $("rigChoices"); box.innerHTML = "";
  RIGS.forEach(r => { const b = document.createElement("button"); b.type = "button"; b.className = "primary"; b.textContent = r; b.onclick = () => { setRig(r); $("rigModal").classList.remove("show"); startRig(); }; box.appendChild(b); });
  $("rigModal").classList.add("show");
}
function startRig() {
  $("rigName").textContent = RIG; $("rig").value = RIG; $("rigSelect").value = RIG;
  document.title = "DPR – " + RIG;
  refreshRigUi();
  const draft = VIEWER ? null : store.get(draftKey());
  let restored = false;
  if (draft) { try { fill(JSON.parse(draft)); formDirty = true; restored = true; } catch (e) { store.del(draftKey()); } }
  if (!restored) { formDirty = false; resetForm(); } else toast("Restored your unsaved DPR.");
  updateChip(); renderCloud(true); syncNow();
  if (!VIEWER) migrateLegacy(RIG);
}

/* first launch (or a login the phone does not know yet): sign in, and the login decides the rig */
$("gateBtn").onclick = async () => {
  const email = $("gateEmail").value, pw = $("gatePass").value, err = $("gateErr");
  err.hidden = true;
  if (!email.trim() || !pw) { err.textContent = "Enter your User ID and password."; err.hidden = false; return; }
  $("gateBtn").disabled = true;
  try {
    await Cloud.signIn(email, pw);
    const me = await Cloud.profile();
    if (me.rig !== "ALL" && !RIGS.includes(me.rig)) throw new Cloud.CloudError("norig", "Unknown rig " + me.rig);
    adoptProfile(me.rig);
    $("gatePass").value = ""; $("gateModal").classList.remove("show");
    startRig();
  } catch (e) {
    if (Cloud.signedIn()) Cloud.signOut();
    err.textContent = cloudMessage(e); err.hidden = false;
  } finally { $("gateBtn").disabled = false; }
};
$("gatePass").addEventListener("keydown", e => { if (e.key === "Enter") $("gateBtn").click(); });
async function beginByLogin() {
  let prof = store.get("dpr.profile");
  if (!prof && Cloud.signedIn()) { try { prof = (await Cloud.profile()).rig; } catch (e) { /* ask for sign-in below */ } }
  if (prof === "ALL" || RIGS.includes(prof)) { adoptProfile(prof); startRig(); }
  else { store.del("dpr.profile"); updateChip(); renderCloud(true); $("gateModal").classList.add("show"); }
}

/* ---------- install prompt ---------- */
let installEvent = null;
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvent = e; $("installBtn").hidden = false; });
window.addEventListener("appinstalled", () => { installEvent = null; $("installBtn").hidden = true; $("installNote").textContent = "Installed."; });
$("installBtn").onclick = async () => { if (installEvent) { installEvent.prompt(); installEvent = null; $("installBtn").hidden = true; } };
$("installNote").textContent = standalone ? "Installed. You are running the app."
  : /iphone|ipad|ipod/i.test(navigator.userAgent) ? "On iPhone: tap the Share button in Safari, then “Add to Home Screen”."
    : "On Android: open the browser menu and tap “Install app” or “Add to Home screen”.";
$("appVersion").textContent = VERSION;

/* ---------- one-time import of DPRs saved by the older single-rig apps ---------- */
const migrating = new Set();
async function migrateLegacy(rig) {
  const flag = "dpr.migrated." + rig;
  if (store.get(flag) === "1" || migrating.has(rig)) return;
  migrating.add(rig);
  let names = [];
  try { names = (await indexedDB.databases()).map(d => d.name); } catch (e) { store.set(flag, "1"); migrating.delete(rig); return; }
  let imported = 0;
  for (const name of LEGACY_DBS.filter(n => names.includes(n))) {
    try {
      const old = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      let rows = [];
      if (old.objectStoreNames.contains("dprs")) rows = await new Promise(res => { const r = old.transaction("dprs").objectStore("dprs").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
      old.close();
      for (const d of rows.sort((a, b) => (a.id || 0) - (b.id || 0))) {
        if (d.rig !== rig || !d.fromDT || !d.toDT) continue; // the old apps shared one database: take only this login's rig
        const docId = makeDocId(d.fromDT, d.toDT), id = recId(d.rig, docId);
        const { id: legacyId, ...data } = d;
        await dbPut({ id, rig: d.rig, docId, dprNo: d.dprNo || "", fromDT: d.fromDT, toDT: d.toDT, data, savedAt: legacyId || Date.now(), dirty: 1, deleted: false, cloudAt: null });
        imported++;
      }
    } catch (e) { /* skip unreadable legacy database */ }
  }
  store.set(flag, "1"); migrating.delete(rig);
  if (imported) { toast(`Imported ${imported} DPR(s) saved by the earlier version.`, "ok"); updateChip(); syncNow(); }
}

/* ---------- start ---------- */
(async function init() {
  const p = new URLSearchParams(location.search).get("rig");
  const fromUrl = !BY_LOGIN && p && RIGS.find(r => r === p || r.endsWith("-" + p)); // links like ?rig=2 only work on a phone with no cloud set up
  if (fromUrl) store.set("dpr.rig", fromUrl);
  $("reportFormat").value = store.get("dpr.format") === "full" ? "full" : "brief";
  renderStatus(); refreshRigUi();
  try { await dbp; }
  catch (e) { toast("This browser is blocking on-phone storage. DPRs cannot be saved here.", "err"); }
  if (BY_LOGIN) await beginByLogin();
  else {
    const saved = store.get("dpr.rig");
    if (RIGS.includes(saved) || fromUrl) { RIG = fromUrl || saved; startRig(); }
    else { updateChip(); renderCloud(true); showRigPicker(); }
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
})();
