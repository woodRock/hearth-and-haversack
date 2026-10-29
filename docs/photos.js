// Photos of cooked dinners. Each is kept on this device in IndexedDB and, when signed in,
// in the household's campaign so everyone sees it. The game state stores only photo ids.
import * as cloud from "./cloud.js?v=12";

const open = () => new Promise((resolve, reject) => {
  const req = indexedDB.open("hh-photos", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("photos");
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function local(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", mode);
    const req = fn(tx.objectStore("photos"));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const cache = new Map();

export async function putPhoto(id, dataUrl) {
  cache.set(id, dataUrl);
  try { await local("readwrite", (s) => s.put(dataUrl, id)); } catch {}
  try { await cloud.saveCloudPhoto(id, dataUrl); } catch (err) { console.warn("Photo upload failed", err); }
}

export async function getPhoto(id) {
  if (cache.has(id)) return cache.get(id);
  let data = null;
  try { data = await local("readonly", (s) => s.get(id)); } catch {}
  if (!data) {
    try { data = await cloud.loadCloudPhoto(id); } catch {}
    if (data) { try { await local("readwrite", (s) => s.put(data, id)); } catch {} }
  }
  if (data) cache.set(id, data);
  return data || null;
}

export async function deletePhoto(id) {
  cache.delete(id);
  try { await local("readwrite", (s) => s.delete(id)); } catch {}
  try { await cloud.deleteCloudPhoto(id); } catch {}
}

// Fills every <img data-photo="id"> under root once its photo has loaded.
export function showPhotos(root) {
  root.querySelectorAll("img[data-photo]").forEach(async (img) => {
    const data = await getPhoto(img.dataset.photo);
    if (data) { img.src = data; img.hidden = false; }
  });
}
