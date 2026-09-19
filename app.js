"use strict";
/* Maintenance Short DPR – NG-2000 rigs.
   Every DPR is stored on the phone first (IndexedDB), then uploaded to the cloud whenever
   the phone is signed in and online. Records carry a `dirty` flag until the upload succeeds. */

const VERSION = "1.0.0";
const RIGS = ["NG-2000-1", "NG-2000-2", "NG-2000-3"];
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
  "energy", "hsdPP", "hsdDSA", "hsdOther", "pol", "grease", "air", "criticalRequirement", "materialsReceived", "materialsSent", "dayCrew", "nightCrew"];

let RIG = null;
let maintenance = [], generic = [], equipmentStatus = {}, hvacStatus = {};
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
  const d = { rig: RIG, radios: { ...equipmentStatus, ...hvacStatus }, maintenance: maintenance.map(r => ({ ...r })), generic: [...generic] };
  FIELDS.forEach(id => { d[id] = $(id).value; });
  return d;
}
function fill(d) {
  FIELDS.forEach(id => { $(id).value = d[id] == null ? "" : d[id]; });
  $("rig").value = RIG;
  maintenance = (d.maintenance || []).map(r => ({ eq: r.eq || "", issue: r.issue || "", job: r.job || "", spare: r.spare || "" }));
  generic = [...(d.generic || [])];
  equipmentStatus = {}; hvacStatus = {};
  Object.entries(d.radios || {}).forEach(([k, v]) => { if (k.startsWith("eq_")) equipmentStatus[k] = v; else if (k.startsWith("hv_")) hvacStatus[k] = v; });
  renderStatus(); renderRows();
}
function resetForm() {
  FIELDS.forEach(id => { $(id).value = ""; });
  $("rig").value = RIG; setDefaultDates(); updateDprNo();
  equipmentStatus = {}; hvacStatus = {}; maintenance = []; generic = [];
  renderStatus(); renderRows();
}

const draftKey = () => "dpr.draft." + RIG;
function saveDraft() { if (RIG && formDirty) store.set(draftKey(), JSON.stringify(collect())); }
function markDirty() { formDirty = true; clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); }
function clearDirty() { formDirty = false; clearTimeout(draftTimer); if (RIG) store.del(draftKey()); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveDraft(); else syncNow(); });
window.addEventListener("pagehide", saveDraft);
$("app").addEventListener("input", markDirty);

/* ---------- maintenance + generic rows ---------- */
function renderMaintenance() {
  const el = $("maintenanceRows"); el.innerHTML = "";
  if (!maintenance.length) maintenance.push({ eq: "", issue: "", job: "", spare: "" });
  const table = document.createElement("table"); table.className = "maintenance-table";
  table.innerHTML = `<thead><tr><th>Sl. No.</th><th>Equipment Name</th><th>Jobs Carried Out</th><th>Action</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  maintenance.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td data-label="Sl. No."><b>${i + 1}</b></td><td data-label="Equipment Name"><input class="m-eq" value="${esc(r.eq)}" placeholder="Equipment name"></td><td data-label="Jobs Carried Out"><textarea class="m-job" placeholder="Enter detailed maintenance activity / jobs carried out">${esc(r.job)}</textarea></td><td data-label="Action">${maintenance.length > 1 ? '<button class="danger" type="button">Remove</button>' : "—"}</td>`;
    tr.querySelector(".m-eq").addEventListener("input", e => { r.eq = e.target.value; });
    tr.querySelector(".m-job").addEventListener("input", e => { r.job = e.target.value; });
    const rm = tr.querySelector(".danger"); if (rm) rm.onclick = () => { maintenance.splice(i, 1); renderMaintenance(); markDirty(); };
    tbody.appendChild(tr);
  });
  el.appendChild(table);
}
function renderGeneric() {
  const el = $("genericRows"); el.innerHTML = "";
  if (!generic.length) generic.push("");
  generic.forEach((v, i) => {
    const d = document.createElement("div"); d.className = "row";
    d.innerHTML = `<div class="rowhead"><b>Sr. No. ${i + 1}</b>${generic.length > 1 ? '<button class="danger" type="button">Remove</button>' : ""}</div><textarea>${esc(v)}</textarea>`;
    d.querySelector("textarea").oninput = e => { generic[i] = e.target.value; };
    const b = d.querySelector("button"); if (b) b.onclick = () => { generic.splice(i, 1); renderGeneric(); markDirty(); };
    el.appendChild(d);
  });
}
function renderRows() { renderMaintenance(); renderGeneric(); }
$("addMaintenance").onclick = () => { maintenance.push({ eq: "", issue: "", job: "", spare: "" }); renderMaintenance(); markDirty(); };
$("addGeneric").onclick = () => { generic.push(""); renderGeneric(); markDirty(); };

/* ---------- save / new / open / delete ---------- */
async function saveDpr() {
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
    actions.append(openBtn, delBtn); item.appendChild(actions); list.appendChild(item);
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
function report(d) {
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
  lines.push("", "5. MAINTENANCE ACTIVITY", "");
  d.maintenance.forEach((r, i) => { lines.push("  " + String.fromCharCode(65 + i) + ". " + (r.eq || "—"), "", "    " + (r.job || "—")); if (i < d.maintenance.length - 1) lines.push(""); });
  lines.push("", "6. GENERIC JOBS CARRIED OUT", "");
  d.generic.forEach((x, i) => { lines.push("  " + String.fromCharCode(65 + i) + ". " + x); if (i < d.generic.length - 1) lines.push(""); });
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
let syncing = false, syncError = "", lastSync = Number(store.get("dpr.lastSync") || 0);
const sinceKey = rig => "dpr.since." + rig;

function cloudMessage(e) {
  switch (e && e.code) {
    case "credentials": return "Wrong email or password.";
    case "disabled": return "This account has been disabled. Contact your admin.";
    case "throttled": return "Too many attempts. Wait a few minutes and try again.";
    case "network": return "No internet connection.";
    case "denied": return "Your account is not allowed to use DPR cloud save. Ask your admin to add your email to the allowed users.";
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
  syncing = true; syncError = ""; updateChip();
  try {
    // 1. upload everything waiting on this phone
    for (const r of (await dbAll()).filter(r => r.dirty)) {
      const at = await Cloud.push(r);
      const cur = await dbGet(r.id);
      if (cur && cur.savedAt === r.savedAt) await dbPut({ ...cur, dirty: 0, cloudAt: at });
    }
    // 2. download what other phones changed since the last sync
    let since = store.get(sinceKey(RIG)) || "";
    for (;;) {
      const docs = await Cloud.pull(RIG, since, PAGE);
      for (const d of docs) { await mergeRemote(RIG, d); if (d.updatedAt) since = d.updatedAt; }
      store.set(sinceKey(RIG), since);
      if (docs.length < PAGE) break;
    }
    lastSync = Date.now(); store.set("dpr.lastSync", String(lastSync));
    if (manual) toast("Synced with cloud.", "ok");
  } catch (e) {
    if (e && e.code === "unauth") Cloud.signOut();
    syncError = cloudMessage(e);
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
  $("accountEmail").textContent = Cloud.user() || "";
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
  if (!email.trim() || !pw) { err.textContent = "Enter your email and password."; err.hidden = false; return; }
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
function showRigPicker() {
  const box = $("rigChoices"); box.innerHTML = "";
  RIGS.forEach(r => { const b = document.createElement("button"); b.type = "button"; b.className = "primary"; b.textContent = r; b.onclick = () => { setRig(r); $("rigModal").classList.remove("show"); startRig(); }; box.appendChild(b); });
  $("rigModal").classList.add("show");
}
function startRig() {
  $("rigName").textContent = RIG; $("rig").value = RIG; $("rigSelect").value = RIG;
  document.title = "DPR – " + RIG;
  const draft = store.get(draftKey());
  let restored = false;
  if (draft) { try { fill(JSON.parse(draft)); formDirty = true; restored = true; } catch (e) { store.del(draftKey()); } }
  if (!restored) { formDirty = false; resetForm(); } else toast("Restored your unsaved DPR.");
  updateChip(); renderCloud(true); syncNow();
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
async function migrateLegacy() {
  if (store.get("dpr.migrated") === "1") return;
  let names = [];
  try { names = (await indexedDB.databases()).map(d => d.name); } catch (e) { store.set("dpr.migrated", "1"); return; }
  let imported = 0;
  for (const name of LEGACY_DBS.filter(n => names.includes(n))) {
    try {
      const old = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      let rows = [];
      if (old.objectStoreNames.contains("dprs")) rows = await new Promise(res => { const r = old.transaction("dprs").objectStore("dprs").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
      old.close();
      for (const d of rows.sort((a, b) => (a.id || 0) - (b.id || 0))) {
        if (!RIGS.includes(d.rig) || !d.fromDT || !d.toDT) continue;
        const docId = makeDocId(d.fromDT, d.toDT), id = recId(d.rig, docId);
        const { id: legacyId, ...data } = d;
        await dbPut({ id, rig: d.rig, docId, dprNo: d.dprNo || "", fromDT: d.fromDT, toDT: d.toDT, data, savedAt: legacyId || Date.now(), dirty: 1, deleted: false, cloudAt: null });
        imported++;
      }
    } catch (e) { /* skip unreadable legacy database */ }
  }
  store.set("dpr.migrated", "1");
  if (imported) toast(`Imported ${imported} DPR(s) saved by the earlier version.`, "ok");
}

/* ---------- start ---------- */
(async function init() {
  const p = new URLSearchParams(location.search).get("rig");
  const fromUrl = p && RIGS.find(r => r === p || r.endsWith("-" + p));
  if (fromUrl) store.set("dpr.rig", fromUrl);
  const saved = store.get("dpr.rig");
  renderStatus(); renderRows();
  try { await dbp; await migrateLegacy(); }
  catch (e) { toast("This browser is blocking on-phone storage. DPRs cannot be saved here.", "err"); }
  if (RIGS.includes(saved) || fromUrl) { RIG = fromUrl || saved; startRig(); }
  else { updateChip(); renderCloud(true); showRigPicker(); }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
})();
