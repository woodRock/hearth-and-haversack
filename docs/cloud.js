// Google sign-in and campaign sync through Firebase. Each player's campaign
// lives in one Firestore document, users/{uid}, readable only by them.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut as fbSignOut,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, deleteField,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

// Firebase web config is public by design; access is controlled by firestore.rules.
const app = initializeApp({
  apiKey: "AIzaSyDElktKCymeNlEbdtcKQ9jbmPGxTxw7v0Q",
  authDomain: "hearth-and-haversack.firebaseapp.com",
  projectId: "hearth-and-haversack",
  storageBucket: "hearth-and-haversack.firebasestorage.app",
  messagingSenderId: "134112650016",
  appId: "1:134112650016:web:b9844e0b09a93a73f26d45",
});
const auth = getAuth(app);
const db = getFirestore(app);

export const DEVICE = (() => {
  try {
    let id = localStorage.getItem("hh-device");
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem("hh-device", id); }
    return id;
  } catch { return Math.random().toString(36).slice(2, 10); }
})();

export let user = null;
export const onUser = (fn) => onAuthStateChanged(auth, (u) => { user = u; fn(u); });

export async function signIn() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err?.code === "auth/popup-blocked") return signInWithRedirect(auth, provider);
    if (err?.code === "auth/popup-closed-by-user" || err?.code === "auth/cancelled-popup-request") return;
    if (err?.code === "auth/unauthorized-domain") throw new Error("Sign-in isn't enabled for this web address yet.");
    throw new Error("Sign-in didn't work. Try again.");
  }
}
export const signOut = () => fbSignOut(auth);

const ref = () => doc(db, "users", user.uid);

// Returns { state, savedAt, device, apiKey } or null when this account has no campaign yet.
export async function loadCloud() {
  if (!user) return null;
  const snap = await getDoc(ref());
  if (!snap.exists()) return null;
  const d = snap.data();
  return { state: d.state ? JSON.parse(d.state) : null, savedAt: d.savedAt || 0, device: d.device, apiKey: d.apiKey || "" };
}

let timer = null;
let pending = null;
export function saveCloud(state) {
  if (!user) return;
  pending = state;
  clearTimeout(timer);
  timer = setTimeout(flush, 1200);
}
export async function flush() {
  clearTimeout(timer);
  if (!user || !pending) return;
  const state = pending;
  pending = null;
  try {
    await setDoc(ref(), { state: JSON.stringify(state), savedAt: state.savedAt, device: DEVICE }, { merge: true });
  } catch (err) {
    console.warn("Cloud save failed", err);
  }
}
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

export async function deleteCloudCampaign() {
  if (!user) return;
  await setDoc(ref(), { state: deleteField(), savedAt: Date.now(), device: DEVICE }, { merge: true });
}

export async function saveCloudKey(key) {
  if (!user) return;
  await setDoc(ref(), { apiKey: key ? key : deleteField() }, { merge: true });
}

// Calls fn with campaigns saved from other devices.
export function watchCloud(fn) {
  if (!user) return () => {};
  return onSnapshot(ref(), (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    const d = snap.data();
    if (d.device === DEVICE || !d.state) return;
    fn({ state: JSON.parse(d.state), savedAt: d.savedAt || 0, apiKey: d.apiKey || "" });
  });
}
