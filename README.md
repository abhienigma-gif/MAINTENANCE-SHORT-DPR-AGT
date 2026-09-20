# Maintenance Short DPR – NG-2000 rigs (mobile app with cloud save)

**One app link for NG-2000-1, NG-2000-2 and NG-2000-3.** The DPR form, numbering and section order are the same as the
V10/V11 app. Each person's **login decides their rig**: a rig login can see and save only its own rig's DPRs, and a
separate **view-only login** can read all three rigs but cannot save or delete.

- **Installs on the phone** (Android and iPhone) and works with no signal. DPRs are saved on the phone first and
  upload when there is signal.
- **Brief WhatsApp text by default** (about 30 lines instead of about 120): same section numbers, empty sections
  left out, one line per equipment status, HVAC lists only what is not running. The full, unit-by-unit text is still
  available under **Settings → WhatsApp text**.
- **Form sections:** 1 DPR Control / Rig Details, 2 Critical Equipment Status, 3 HVAC Status, 4 Critical Operational Parameters,
  **5 Mechanical DPR** and **6 Elec & Inst DPR** (each is one blank box where that team types its DPR as free text),
  7 Inventory / Requirement, 8 Crew Details. DPRs saved in the older format still open: their maintenance rows and generic
  jobs appear as lines of text in the Mechanical box.
- **Fuel Gas Consumption (MMSCM)** is the last box in section 4. It accepts only a number (digits and one decimal point, so
  `12` and `12.5` both work) and shows the phone's numeric keypad. It is included in the WhatsApp text when filled.
- **Draft protection.** Half-typed entries survive the app being closed or the phone killing it.

## How rigs and logins work

Every person has **two** things:

1. a **login** (Firebase Authentication): a plain **User ID** and a password that you create and hand to them, and
2. an **entry in the `allowedUsers` collection** (Firestore): document id = their login name **in lower case**,
   with a field **`rig`** set to one of:

| `rig` value | What that login can do |
|---|---|
| `NG-2000-1`, `NG-2000-2` or `NG-2000-3` | Read and save **that rig only** |
| `ALL` | **View-only**: read all three rigs, cannot save or delete |
| *(missing, or no entry)* | Nothing |

This is enforced by the database rules (`firestore.rules`), not only by the app. Someone who bypasses the app still
cannot read or write another rig's DPRs.

The app reads the person's own entry after they sign in, so **the rig is never chosen on the phone**. If the admin
changes someone's `rig`, the phone switches at its next sync.

### User IDs: crew type `ng2-01`, not an email
Firebase only accepts email-shaped login names, so the app adds `@rigdpr.local` (set as `userDomain` in `config.js`)
to whatever the person types. The crew never see it, and it cannot be a real inbox. Capitals and stray spaces are
ignored. In the Firebase console the same login is written as `ng2-01@rigdpr.local`, and that full form is what you
enter there. Anyone who types a full email address is not changed, so real emails also work.

Suggested names, one login **per person** (do not share a login: each saved DPR records who saved it):

| Person | User ID typed in the app | Name to enter in the Firebase console | `rig` |
|---|---|---|---|
| NG-1 people (6) | `ng1-01` … `ng1-06` | `ng1-01@rigdpr.local` … | `NG-2000-1` |
| NG-2 people (6) | `ng2-01` … `ng2-06` | `ng2-01@rigdpr.local` … | `NG-2000-2` |
| NG-3 people (6) | `ng3-01` … `ng3-06` | `ng3-01@rigdpr.local` … | `NG-2000-3` |
| Coordinator (view-only) | `coord` | `coord@rigdpr.local` | `ALL` |

There is no "forgot password" (these are not real inboxes, so the console's emailed reset link cannot reach
anyone). To give someone a new password: Authentication → Users → delete that user, then **Add user** again with the
same name (`ng2-01@rigdpr.local`) and the new password. Their `allowedUsers` entry stays as it is, so nothing else
needs changing, and their DPRs are not affected.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `cloud.js` | Login and cloud sync (Firebase Auth and Firestore over plain web APIs) |
| `config.js` | Your Firebase `apiKey` and `projectId` (already filled in) |
| `service-worker.js`, `manifest.json`, icons | Offline use and "install to home screen" |
| `firestore.rules` | Security rules, pasted into Firebase → Firestore → Rules |

## Setup (one time)

1. **Firebase project** with Email/Password login and a Firestore database in `asia-south1` (Mumbai). *(done)*
2. **Rules:** Firestore → **Rules** tab → replace everything with `firestore.rules` → **Publish**.
   *(Republish after this update. The rules changed from "any approved user" to "by rig".)*
3. **`config.js`** holds `apiKey` and `projectId` from Project settings → Your apps → Web app. *(done)*
4. **Add each person:**
   - Authentication → Users → **Add user**. In the "Email" box type the console name from the table above (for
     example `ng2-01@rigdpr.local`), then the password you choose. Tell the person their **User ID (`ng2-01`)**
     and password.
   - Firestore → `allowedUsers` → **Add document** → Document ID = the same console name in lower case
     (`ng2-01@rigdpr.local`) → field `rig` (string) = `NG-2000-1` / `NG-2000-2` / `NG-2000-3` / `ALL`.
   - Existing entries (from before this update) need the `rig` field added, or those people can do nothing.
5. **Host the folder over HTTPS** (phones will not install or run offline apps from plain files). GitHub Pages:
   put the files in a repository → Settings → Pages → deploy from the `main` branch.
   If you host under the same GitHub account as the older DPR apps, DPRs saved on phones by those apps are imported
   automatically (only the signed-in rig's DPRs).
6. **On each phone:** open the link. **Android (Chrome):** menu → *Install app*. **iPhone (Safari):** Share →
   *Add to Home Screen*. Open the app and sign in once. After that the phone remembers its rig and works offline.

### Test the rules in Firebase (recommended before the crew starts)
Firestore → **Rules** → **Rules Playground** (Develop & Test). Simulate **get** on
`/databases/(default)/documents/rigs/NG-2000-2/dprs/test` **authenticated**, provider `password`, with the email set
in the token. Expected results, given an `allowedUsers` entry with `rig` = `NG-2000-2` for `rig2@example.com`:

| Simulated request | Email | Expected |
|---|---|---|
| get `rigs/NG-2000-2/dprs/test` | rig2@example.com | **Allowed** |
| get `rigs/NG-2000-1/dprs/test` | rig2@example.com | **Denied** |
| create `rigs/NG-2000-1/dprs/test` | rig2@example.com | **Denied** |
| get `rigs/NG-2000-1/dprs/test` | (a `rig: ALL` login) | **Allowed** |
| create `rigs/NG-2000-2/dprs/test` | (a `rig: ALL` login) | **Denied** |
| get `allowedUsers/other@example.com` | rig2@example.com | **Denied** (only your own entry is readable) |

## How saving works

- **Save** stores on the phone first, then uploads. The top-right button shows the state: `☁ Synced`,
  `⏳ 2 to upload`, `📴 Offline`, `☁ Sign in`, or `📱 Phone only` (cloud not configured).
- Each DPR is one record per rig and time period (`FROM` + `TO`). Saving the same period again updates it.
- Any approved login for the rig sees the same DPRs after syncing, whichever phone saved them.
- **Delete** removes it from the phone and marks it deleted in the cloud so it disappears on other phones too.
- **Conflicts:** if two people edit the *same* DPR while apart, the last save wins.
- On a shared phone, signing out keeps the previous person's DPRs on the phone. Signing in as someone from another
  rig switches the app to that rig and does not show or upload the other rig's DPRs.

## Updating the app
Replace the files on the host. Phones pick up the new version the second time the app is opened.

## Optional hardening
In Google Cloud Console → *APIs & Services → Credentials*, restrict the Firebase API key to your hosting domain
(HTTP referrers) and to the Identity Toolkit and Firestore APIs. The key is an identifier, not a password.
