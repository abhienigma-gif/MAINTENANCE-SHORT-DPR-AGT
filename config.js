// Cloud-save settings. Leave apiKey/projectId empty to run the app in "this phone only" mode.
// Fill both in from: Firebase console -> Project settings -> General -> Your apps -> Web app.
// (These two values are identifiers, not secrets. Access is enforced by firestore.rules + user login.)
window.DPR_CONFIG = {
  apiKey: "AIzaSyC05JQzmnHEHoJtYzmJHT5cbLAyW3BnW0c",
  projectId: "maintenance-short-dpr-ng-rig"
  // Testing only: point at the Firebase emulators instead of the live service.
  // authBase: "http://localhost:9099/identitytoolkit.googleapis.com/v1",
  // tokenBase: "http://localhost:9099/securetoken.googleapis.com/v1",
  // firestoreBase: "http://localhost:8080/v1"
};
