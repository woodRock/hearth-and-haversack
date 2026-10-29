// Google sign-in and campaign sync through Firebase.
// A campaign lives in campaigns/{id} and is shared by its members (a household).
// users/{uid} holds which campaign an account plays and its private API key.
// Invite codes in invites/{code} let someone join a household.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut as fbSignOut,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, deleteField, arrayUnion, arrayRemove,
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
// The local cache keeps the campaign readable and queues saves while offline.
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

export const DEVICE = (() => {
  try {
    let id = localStorage.getItem("hh-device");
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem("hh-device", id); }
    return id;
  } catch { return Math.random().toString(36).slice(2, 10); }
})();

export let user = null;
export let campaignId = null;
let resolveReady;
export const authReady = new Promise((r) => { resolveReady = r; });
export const onUser = (fn) => onAuthStateChanged(auth, (u) => {
  user = u;
  if (!u) campaignId = null;
  resolveReady();
  fn(u);
});

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

const userRef = () => doc(db, "users", user.uid);
const campaignRef = (id = campaignId) => doc(db, "campaigns", id);
const myName = () => user.displayName || user.email || "Someone";

function unpack(d) {
  return {
    state: d.state ? JSON.parse(d.state) : null,
    savedAt: d.savedAt || 0,
    members: Object.entries(d.names || {}).map(([uid, name]) => ({ uid, name, owner: uid === d.owner, me: uid === user.uid })),
    owner: d.owner === user.uid,
  };
}

// Loads this account's campaign. Returns { state, savedAt, members, owner, apiKey }.
// Moves a campaign saved by an older version (inside users/{uid}) into its own document.
export async function loadCloud() {
  if (!user) return null;
  const snap = await getDoc(userRef());
  const d = snap.exists() ? snap.data() : {};
  const apiKey = d.apiKey || "";
  if (d.campaignId) {
    try {
      const c = await getDoc(campaignRef(d.campaignId));
      if (c.exists() && (c.data().members || []).includes(user.uid)) {
        campaignId = d.campaignId;
        return { ...unpack(c.data()), apiKey };
      }
    } catch { /* removed from that household */ }
    await setDoc(userRef(), { campaignId: deleteField() }, { merge: true });
  }
  campaignId = null;
  if (d.state) {
    await createCampaign({ state: d.state, savedAt: d.savedAt || Date.now() });
    await setDoc(userRef(), { state: deleteField(), savedAt: deleteField(), device: deleteField() }, { merge: true });
    return { state: JSON.parse(d.state), savedAt: d.savedAt || 0, members: [{ uid: user.uid, name: myName(), owner: true, me: true }], owner: true, apiKey };
  }
  return { state: null, savedAt: 0, members: [], owner: true, apiKey };
}

async function createCampaign({ state, savedAt }) {
  const id = doc(collection(db, "campaigns")).id;
  await setDoc(campaignRef(id), {
    state, savedAt, device: DEVICE, owner: user.uid, members: [user.uid], names: { [user.uid]: myName() },
  });
  await setDoc(userRef(), { campaignId: id }, { merge: true });
  campaignId = id;
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
    const data = JSON.stringify(state);
    if (!campaignId) await createCampaign({ state: data, savedAt: state.savedAt });
    else await setDoc(campaignRef(), { state: data, savedAt: state.savedAt, device: DEVICE }, { merge: true });
  } catch (err) {
    console.warn("Cloud save failed", err);
  }
}
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

export async function deleteCloudCampaign() {
  if (!user || !campaignId) return;
  await setDoc(campaignRef(), { state: deleteField(), savedAt: Date.now(), device: DEVICE }, { merge: true });
}

export async function saveCloudKey(key) {
  if (!user) return;
  await setDoc(userRef(), { apiKey: key ? key : deleteField() }, { merge: true });
}

// onState gets campaigns saved by other devices or household members.
// onHousehold gets the member list whenever it changes, or null if this account was removed.
let unwatch = () => {};
export function watchCloud(onState, onHousehold) {
  unwatch();
  if (!user || !campaignId) { unwatch = () => {}; return; }
  unwatch = onSnapshot(campaignRef(), (snap) => {
    if (!snap.exists()) return;
    const d = snap.data();
    if (!(d.members || []).includes(user.uid)) { onHousehold(null); return; }
    const info = unpack(d);
    onHousehold(info.members, info.owner);
    if (snap.metadata.hasPendingWrites || d.device === DEVICE || !d.state) return;
    onState(info);
  }, () => onHousehold(null));
}
export const stopWatching = () => { unwatch(); unwatch = () => {}; };

/* Household invites */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export async function createInvite() {
  if (!user) throw new Error("Sign in first.");
  if (!campaignId) throw new Error("Start a campaign first, then invite people to it.");
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await setDoc(doc(db, "invites", code), { campaignId, createdBy: user.uid, expires });
  return { code, expires };
}

// Joins the household behind an invite code and returns its campaign.
export async function joinWithCode(raw) {
  if (!user) throw new Error("Sign in first.");
  const code = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  let invite;
  try { invite = await getDoc(doc(db, "invites", code)); } catch { invite = null; }
  if (!invite?.exists() || invite.data().expires < Date.now()) throw new Error("That code doesn't work or has expired. Ask for a new one.");
  const id = invite.data().campaignId;
  if (id === campaignId) throw new Error("You're already in this household.");
  await updateDoc(campaignRef(id), { members: arrayUnion(user.uid), [`names.${user.uid}`]: myName() });
  await setDoc(userRef(), { campaignId: id }, { merge: true });
  campaignId = id;
  const c = await getDoc(campaignRef(id));
  return unpack(c.data());
}

export async function leaveHousehold() {
  if (!user || !campaignId) return;
  await updateDoc(campaignRef(), { members: arrayRemove(user.uid), [`names.${user.uid}`]: deleteField() });
  await setDoc(userRef(), { campaignId: deleteField() }, { merge: true });
  stopWatching();
  campaignId = null;
}

export async function removeMember(uid) {
  if (!user || !campaignId) return;
  await updateDoc(campaignRef(), { members: arrayRemove(uid), [`names.${uid}`]: deleteField() });
}

/* Dinner photos: one document each in campaigns/{id}/photos, so the campaign itself stays small. */
const photoRef = (id) => doc(db, "campaigns", campaignId, "photos", id);
export async function saveCloudPhoto(id, data) {
  if (!user || !campaignId) return;
  await setDoc(photoRef(id), { data, by: user.uid, at: Date.now() });
}
export async function loadCloudPhoto(id) {
  if (!user || !campaignId) return null;
  const snap = await getDoc(photoRef(id));
  return snap.exists() ? snap.data().data : null;
}
export async function deleteCloudPhoto(id) {
  if (!user || !campaignId) return;
  await deleteDoc(photoRef(id));
}
