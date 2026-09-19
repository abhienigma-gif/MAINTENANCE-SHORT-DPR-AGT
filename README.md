# Maintenance Short DPR – NG-2000 rigs (mobile app with cloud save)

One installable mobile app for **NG-2000-1, NG-2000-2 and NG-2000-3**. It is the V10/V11 DPR form with the same
fields, DPR numbering and WhatsApp report text, plus:

- **Installs on the phone** (Android and iPhone) and opens like a normal app. Works with no signal.
- **Cloud save.** Every saved DPR uploads to your Firebase project when the phone is signed in and online.
  If there is no signal it waits on the phone and uploads later. DPRs saved from other phones appear in History.
- **One app, three rigs.** The rig is chosen on first launch (change it from the cloud button at the top).
  A link ending in `?rig=1`, `?rig=2` or `?rig=3` preselects the rig.
- **Draft protection.** Half-typed entries are kept if the app is closed or the phone kills it, and restored on reopening.
- Fixes: the three rig copies used to share one local database name (their histories mixed); the "Share" sheet
  no longer also copies text when you just close it; From/To are required before saving.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `cloud.js` | Firebase login + Firestore sync (plain web APIs, no SDK) |
| `config.js` | **You fill in two values here** (see step 5) |
| `service-worker.js`, `manifest.json`, icons | Offline use and "install to home screen" |
| `firestore.rules` | Security rules to paste into Firebase |

## One-time cloud setup (about 15 minutes, free Firebase "Spark" plan)

1. Go to <https://console.firebase.google.com> → **Add project** (Google Analytics not needed).
2. **Build → Authentication → Get started → Email/Password → Enable.**
   Then *Settings → User actions* → turn **off** "Enable create (sign-up)" if the option is shown.
3. **Build → Firestore Database → Create database** → production mode → pick a region near you (e.g. `asia-south1`, Mumbai).
4. Firestore **Rules** tab → replace everything with the contents of `firestore.rules` → **Publish**.
5. **Project settings (gear) → General → Your apps → Web `</>`** → register an app → copy `apiKey` and `projectId`
   into `config.js`.
6. **Add each person who may use the app** (two clicks each):
   - Authentication → Users → **Add user** (email + password).
   - Firestore → **Start collection** `allowedUsers` → *Document ID* = that email **in lower case** → add any field
     (e.g. `active` = `true`) → Save. Without this document the person can sign in but cannot read or save DPRs.
7. **Host the folder over HTTPS** (phones will not install or run offline apps from plain files).
   Easiest, since you already use GitHub: put these files in a repository → *Settings → Pages* → deploy from the main branch.
   Firebase Hosting or any HTTPS web server also works.

### On each phone
- Open the link. **Android (Chrome):** menu → *Install app*. **iPhone (Safari):** Share → *Add to Home Screen*.
- Choose the rig, tap the cloud button at the top → sign in. It shows **☁ Synced** when everything is uploaded.

### Check it works
Save a DPR, then look in the Firebase console → Firestore → `rigs` → `NG-2000-x` → `dprs`. Your DPR should be there.

## How saving works

- **Save** always stores on the phone first, then uploads. The header button shows the state:
  `☁ Synced`, `⏳ 2 to upload`, `☁ Sign in`, or `📱 This phone only` (cloud not configured).
- Each DPR is one record per rig and time period (`FROM` + `TO`). Saving the same period again updates it.
- **Delete** removes it from the phone and marks it deleted in the cloud, so it disappears on other phones too
  (the record is kept in Firestore, flagged `deleted`).
- **Conflicts:** if two phones edit the *same* DPR while apart, the phone that saves last wins. Plan for one
  person to own each shift's DPR.
- Existing DPRs saved by the older apps in the same browser are imported once, automatically, and upload after sign-in.
- Data is kept in Firestore under `rigs/{rig}/dprs/{period}`; the full form is in the `payload` field as JSON.

## Updating the app
Replace the files on the host. Phones pick up the new version the second time the app is opened
(the first open shows the old copy while the new one downloads). To force it, change `CACHE` in `service-worker.js`.

## Optional hardening
In Google Cloud Console → *APIs & Services → Credentials*, restrict the Firebase API key to your hosting domain
(HTTP referrers) and to the Identity Toolkit and Firestore APIs. The key is an identifier, not a password;
access is controlled by the login and `firestore.rules`.

## Later: Android APK
The app can be wrapped with Capacitor to produce an APK if you need one for distribution outside a link. That needs
Android Studio and is not required for anything above.
