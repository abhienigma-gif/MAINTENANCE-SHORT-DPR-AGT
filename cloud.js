// Cloud layer: Firebase Auth (email + password) and Firestore over their REST APIs.
// No SDK is loaded, so nothing extra has to be cached for offline use.
// Documents live at rigs/{rig}/dprs/{docId}; `updatedAt` is stamped by the server so that
// phones with wrong clocks cannot hide their changes from other phones.
(function () {
  "use strict";
  const cfg = window.DPR_CONFIG || {};
  const AUTH = cfg.authBase || "https://identitytoolkit.googleapis.com/v1";
  const TOKEN = cfg.tokenBase || "https://securetoken.googleapis.com/v1";
  const FS = cfg.firestoreBase || "https://firestore.googleapis.com/v1";
  const configured = !!(cfg.apiKey && cfg.projectId);
  const SESSION_KEY = "dpr.session";
  const DOCS = `projects/${cfg.projectId}/databases/(default)/documents`;

  class CloudError extends Error {
    constructor(code, message, status) { super(message || code); this.code = code; this.status = status; }
  }

  let session = null; // {email, uid, refreshToken}
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { /* ignore */ }
  let idToken = null, idExpiry = 0;

  function persist() {
    try { session ? localStorage.setItem(SESSION_KEY, JSON.stringify(session)) : localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function classify(status, message, apiStatus) {
    if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_EMAIL|MISSING_PASSWORD|MISSING_EMAIL/.test(message)) return "credentials";
    if (/USER_DISABLED/.test(message)) return "disabled";
    if (/TOO_MANY_ATTEMPTS/.test(message)) return "throttled";
    if (status === 401 || apiStatus === "UNAUTHENTICATED") return "unauth";
    if (status === 403 || apiStatus === "PERMISSION_DENIED") return "denied";
    if (status >= 500) return "server";
    return "error";
  }

  async function call(url, opts) {
    let res;
    try { res = await fetch(url, opts); } catch (e) { throw new CloudError("network", "No connection"); }
    let body = null;
    try { body = await res.json(); } catch (e) { /* empty or non-JSON body */ }
    if (!res.ok) {
      const err = body && body.error || {};
      throw new CloudError(classify(res.status, err.message || "", err.status || ""), err.message || ("HTTP " + res.status), res.status);
    }
    return body;
  }

  async function signIn(email, password) {
    if (!configured) throw new CloudError("config", "Cloud is not configured");
    const b = await call(`${AUTH}/accounts:signInWithPassword?key=${encodeURIComponent(cfg.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true })
    });
    session = { email: b.email, uid: b.localId, refreshToken: b.refreshToken };
    idToken = b.idToken; idExpiry = Date.now() + Number(b.expiresIn) * 1000;
    persist();
    return session.email;
  }

  function signOut() { session = null; idToken = null; idExpiry = 0; persist(); }

  async function token() {
    if (!session) throw new CloudError("unauth", "Not signed in");
    if (idToken && Date.now() < idExpiry - 60000) return idToken;
    try {
      const b = await call(`${TOKEN}/token?key=${encodeURIComponent(cfg.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken })
      });
      idToken = b.id_token; idExpiry = Date.now() + Number(b.expires_in) * 1000;
      if (b.refresh_token && b.refresh_token !== session.refreshToken) { session.refreshToken = b.refresh_token; persist(); }
      return idToken;
    } catch (e) {
      // A rejected refresh token (revoked, user deleted/disabled) means the session is over.
      // Network errors keep the session so the phone can retry later.
      if (e.code !== "network" && e.code !== "server") { signOut(); throw new CloudError("unauth", "Session expired. Please sign in again."); }
      throw e;
    }
  }

  async function authedPost(url, body) {
    for (let attempt = 0; ; attempt++) {
      const t = await token();
      try {
        return await call(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
          body: JSON.stringify(body)
        });
      } catch (e) {
        if (e.code === "unauth" && attempt === 0) { idToken = null; continue; }
        throw e;
      }
    }
  }

  const s = v => ({ stringValue: String(v == null ? "" : v) });

  // Upsert one DPR record (including soft-deleted ones). Returns the server commit time.
  async function push(rec) {
    const fields = {
      rig: s(rec.rig), dprNo: s(rec.dprNo), fromDT: s(rec.fromDT), toDT: s(rec.toDT),
      payload: s(JSON.stringify(rec.data)),
      deleted: { booleanValue: !!rec.deleted },
      updatedBy: s(session && session.email),
      clientSavedAt: { integerValue: String(rec.savedAt || Date.now()) }
    };
    const res = await authedPost(`${FS}/${DOCS}:commit`, {
      writes: [{
        update: { name: `${DOCS}/rigs/${rec.rig}/dprs/${rec.docId}`, fields },
        updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]
      }]
    });
    return res.commitTime || "";
  }

  // Fetch DPRs of one rig changed after `since` (an RFC3339 timestamp, or "" for everything), oldest first.
  async function pull(rig, since, limit) {
    const q = {
      from: [{ collectionId: "dprs" }],
      orderBy: [{ field: { fieldPath: "updatedAt" }, direction: "ASCENDING" }],
      limit
    };
    if (since) q.where = { fieldFilter: { field: { fieldPath: "updatedAt" }, op: "GREATER_THAN", value: { timestampValue: since } } };
    const rows = await authedPost(`${FS}/${DOCS}/rigs/${rig}:runQuery`, { structuredQuery: q });
    return rows.filter(r => r.document).map(r => {
      const f = r.document.fields || {};
      return {
        docId: r.document.name.split("/").pop(),
        dprNo: (f.dprNo || {}).stringValue || "",
        fromDT: (f.fromDT || {}).stringValue || "",
        toDT: (f.toDT || {}).stringValue || "",
        payload: (f.payload || {}).stringValue || "",
        deleted: !!(f.deleted || {}).booleanValue,
        updatedAt: (f.updatedAt || {}).timestampValue || ""
      };
    });
  }

  window.Cloud = {
    configured, CloudError, signIn, signOut, push, pull,
    signedIn: () => !!session,
    user: () => (session && session.email) || null
  };
})();
