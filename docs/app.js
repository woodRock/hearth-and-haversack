import { readReceipt, planDays, writeRecipe, prepareImage, hasKey, getKey, setKey, ClaudeError } from "./claude.js?v=5";
import * as cloud from "./cloud.js?v=5";

const SAVE_KEY = "hh-save-v1";
const XP_PER_LEVEL = 200;
const AISLE_ORDER = ["Produce", "Butcher & Fishmonger", "Dairy", "Bakery", "Larder", "Frozen", "Household", "Added by you"];

const CLASSES = {
  rogue: { name: "Bargain Rogue", blurb: "+20 gold in the weekly purse." },
  paladin: { name: "Meal-Prep Paladin", blurb: "+10 XP for every dinner cooked." },
  mage: { name: "Leftover Wild Mage", blurb: "Double XP from leftover alchemy." },
};

const TIPS = [
  "Leftovers spoil fast. Combine them in the Pack before they're lost.",
  "Cooking what a companion likes raises their approval.",
  "A natural 20 on a new recipe adds it to your recipe book for good.",
  "Scan your receipt after shopping and the loot goes straight into your Pack.",
  "Finishing an act under budget earns bonus XP.",
  "Skipping a dinner costs nothing. Rest anyway and try again tomorrow.",
  "Bigger dishes leave leftovers for tomorrow's lunch.",
  "Swap a dinner to tonight if something in the Pack is about to spoil.",
];

const LINES = [
  "Smells like something good is about to happen.",
  "I could eat. I could always eat.",
  "Whose turn is it to wash up? Not mine. Definitely not mine.",
  "If we're cooking tonight, I'll set the table.",
  "That pot has seen things.",
];

// Placeholder text for the companion fields on the creation screen.
const EXAMPLE_PARTY = [
  { name: "Mira", likes: "soup, vegetables", dislikes: "lamb" },
  { name: "Tobin", likes: "anything meaty", dislikes: "mushrooms" },
  { name: "Biscuit", likes: "whatever gets dropped", dislikes: "" },
];

let S = null;
let tab = "camp";
let picked = [];

/* ---------- Helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z ]/g, "").replace(/(es|s)\b/g, "").trim();
const sameItem = (a, b) => { const x = norm(a), y = norm(b); return x && y && (x === y || x.includes(y) || y.includes(x)); };
const titleCase = (s) => s.replace(/\b\w/g, (m) => m.toUpperCase());
const clampQty = (n) => Math.min(99, Math.max(1, parseInt(n, 10) || 1));

// Reads an amount typed with an item: "Soup x5", "Soup × 5", "Soup (5)", "5 x Soup", "5 soups".
function splitQty(text) {
  const t = String(text).trim().replace(/\s+/g, " ");
  let m = t.match(/^(.+?)\s*(?:[x×*]\s*(\d+)|\((\d+)\))$/i);
  if (m) return { name: m[1].trim(), qty: clampQty(m[2] || m[3]) };
  m = t.match(/^(\d+)\s*(?:[x×*]\s*)?\s(.+)$/i) || t.match(/^(\d+)\s*[x×*]\s*(.+)$/i);
  if (m) return { name: m[2].trim(), qty: clampQty(m[1]) };
  return { name: t, qty: 1 };
}

// Pack items stack when they're the same thing: same name ignoring case and plurals.
const stackKey = (p) => (p.leftover ? "leftover:" : "") + norm(p.name).replace(/\s+/g, " ");

// Splits amounts out of item names and merges duplicates into one stack.
// Returns true if anything changed, so callers know to save the repair.
function tidyPack(st) {
  if (!Array.isArray(st?.pack)) return false;
  let changed = false;
  const stacks = new Map();
  for (const p of st.pack) {
    const { name, qty } = splitQty(p.name);
    if (qty > 1 || name !== p.name) {
      p.name = titleCase(name);
      p.qty = (Number(p.qty) || 1) * qty;
      changed = true;
    }
    const key = stackKey(p);
    const have = stacks.get(key);
    if (!have) { stacks.set(key, p); continue; }
    have.qty += Number(p.qty) || 1;
    if (p.spoil) have.spoil = have.spoil ? Math.min(have.spoil, p.spoil) : p.spoil;
    changed = true;
  }
  if (changed) st.pack = [...stacks.values()];
  return changed;
}
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const gold = (n) => `${Math.round(n)}g`;

function dateFor(i) {
  const d = new Date(S.actStart + "T12:00:00");
  d.setDate(d.getDate() + i);
  return d;
}
const weekday = (d, style = "short") => d.toLocaleDateString(undefined, { weekday: style });

function rarityFor(aisle, price, spoil) {
  if (price >= 15) return "epic";
  if (price >= 6) return "rare";
  if (spoil && spoil <= 10 && ["Produce", "Dairy", "Bakery", "Butcher & Fishmonger"].includes(aisle)) return "uncommon";
  return "common";
}

function companions() { return S.party.slice(1); }

/* ---------- Save ---------- */
function save() {
  if (!S) return;
  S.savedAt = Date.now();
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch {}
  cloud.saveCloud(S);
}
function loadSave() {
  let st = null;
  try { const raw = localStorage.getItem(SAVE_KEY); st = raw ? JSON.parse(raw) : null; } catch { return null; }
  // Repair in place without touching savedAt, so it never looks like a newer campaign than the account's.
  if (tidyPack(st)) storeLocal(st);
  return st;
}
function storeLocal(state) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch {}
}
function deleteSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
  cloud.deleteCloudCampaign().catch(() => {});
  S = null;
}
const summary = (st) => `${st.party[0].name} · Act ${st.act}, Day ${Math.min(st.day + 1, 7)} · Level ${st.level}`;

/* ---------- Account sync ---------- */
let unwatch = () => {};
let syncKey = false;

async function onSignedIn() {
  let remote;
  try { remote = await cloud.loadCloud(); } catch { toast(`<span class="n">Couldn't reach your saved campaign. Playing on this device for now.</span>`); return; }
  syncKey = Boolean(remote?.apiKey);
  if (remote?.apiKey && !hasKey()) setKey(remote.apiKey);
  const local = S || loadSave();
  const cloudState = remote?.state;
  if (cloudState && local && cloudState.savedAt !== local.savedAt) {
    await new Promise((resolve) => modal(`<div class="dialog"><h3>Two campaigns found</h3>
      <p>Which one should this account keep? The other is replaced on every device.</p>
      <div class="choices">
        <button class="choice" data-pick="cloud"><b>Your account's campaign</b><small>${esc(summary(cloudState))}</small></button>
        <button class="choice" data-pick="local"><b>This device's campaign</b><small>${esc(summary(local))}</small></button>
      </div></div>`,
      (root) => root.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => {
        if (b.dataset.pick === "cloud") { S = cloudState; storeLocal(S); }
        else { S = local; save(); cloud.flush(); }
        closeModal(); resolve();
      })));
  } else if (cloudState) {
    S = cloudState; storeLocal(S);
  } else if (local) {
    S = local; save(); cloud.flush();
  }
  if (tidyPack(S)) { save(); cloud.flush(); }
  unwatch();
  unwatch = cloud.watchCloud(applyRemote);
  refreshScreen();
}

function applyRemote(remote) {
  if (remote.apiKey && remote.apiKey !== getKey()) setKey(remote.apiKey);
  if (!remote.state || (S && remote.savedAt <= (S.savedAt || 0))) return;
  S = remote.state;
  if (tidyPack(S)) save(); else storeLocal(S);
  if (!modalOpen) { toast("Synced from your other device"); refreshScreen(); }
}

// Redraw whichever screen is showing after the campaign changes underneath it.
function refreshScreen() {
  if (!$("#game").hidden) {
    if (!S) return renderMenu();
    if (S.planning) return openCouncil();
    if (S.day >= 7) return showActEnd();
    return render();
  }
  if (!$("#menu").hidden) renderMenu();
}

/* ---------- Screens ---------- */
function show(id) {
  for (const el of document.querySelectorAll(".screen")) el.hidden = el.id !== id;
  document.body.classList.toggle("in-game", id === "game");
  window.scrollTo(0, 0);
}

function toast(html) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = html;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 2900);
}

/* Modal queue: one dialog at a time, the next opens when the current closes. */
const modalQueue = [];
let modalOpen = false;
function modal(html, bind) {
  modalQueue.push({ html, bind });
  if (!modalOpen) nextModal();
}
function nextModal() {
  const m = modalQueue.shift();
  if (!m) { modalOpen = false; $("#modal").innerHTML = ""; return; }
  modalOpen = true;
  $("#modal").innerHTML = `<div class="scrim" role="dialog" aria-modal="true">${m.html}</div>`;
  m.bind?.($("#modal"));
  $("#modal").querySelector("button, input")?.focus();
}
const closeModal = () => nextModal();

/* Loading screen. Runs `task` (if any) and stays up at least `min` ms. */
async function loading({ title, sub = "", min = 1400, task, cancellable = false }) {
  const prev = [...document.querySelectorAll(".screen")].find((s) => !s.hidden)?.id;
  $("#loading-title").textContent = title;
  $("#loading-sub").textContent = sub;
  $("#loading-tip").textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  const fill = $("#loading-fill");
  fill.style.width = "0%";
  show("loading");
  const ctrl = new AbortController();
  const cancel = $("#loading-cancel");
  cancel.hidden = !cancellable;
  cancel.onclick = () => ctrl.abort();
  let pct = 0;
  const tick = setInterval(() => { pct += (92 - pct) * 0.08; fill.style.width = pct + "%"; }, 120);
  try {
    const [result] = await Promise.all([task ? task(ctrl.signal) : null, sleep(reducedMotion ? 300 : min)]);
    fill.style.width = "100%";
    await sleep(250);
    return result;
  } catch (err) {
    if (prev) show(prev);
    throw err;
  } finally {
    clearInterval(tick);
    cancel.hidden = true;
  }
}

/* ---------- Main menu ---------- */
function renderMenu() {
  const saved = S || loadSave();
  const cont = $("#menu-continue");
  cont.disabled = !saved;
  $("#continue-detail").textContent = saved ? summary(saved) : "No campaign yet";
  const u = cloud.user;
  $("#menu-account").textContent = u ? "Sign out" : "Sign in to sync";
  $("#menu-status").innerHTML = [
    hasKey() ? `Claude: <b>ready</b>` : `Claude: <b class="off">add your API key in Settings</b>`,
    u ? `Synced as <b>${esc(u.displayName || u.email)}</b>` : "Saved on this device only",
  ].join("<br>");
  show("menu");
}

$("#menu-account").onclick = async () => {
  if (cloud.user) {
    await cloud.flush();
    unwatch(); unwatch = () => {};
    await cloud.signOut();
    toast("Signed out. Your campaign stays on this device too.");
    renderMenu();
    return;
  }
  try { await cloud.signIn(); }
  catch (err) { toast(`<span class="n">${esc(err.message)}</span>`); }
};

$("#menu-continue").onclick = async () => {
  S = S || loadSave();
  if (!S) return;
  await loading({ title: `Act ${S.act}`, sub: S.planning ? "The war council gathers…" : S.day >= 7 ? "The week's tale is told…" : `Returning to camp, Day ${S.day + 1}…`, min: 1200 });
  if (S.planning) openCouncil();
  else if (S.day >= 7) showActEnd();
  else enterGame();
};
$("#menu-new").onclick = () => {
  const start = () => { renderCreate(); show("create"); };
  if (S || loadSave()) {
    modal(`<div class="dialog"><h3>Start over?</h3><p>Your current campaign on this device will be replaced.</p>
      <div class="row"><button class="btn" data-x="no">Keep it</button><button class="btn danger" data-x="yes">Start a new one</button></div></div>`,
      (root) => {
        root.querySelector('[data-x="no"]').onclick = closeModal;
        root.querySelector('[data-x="yes"]').onclick = () => { closeModal(); start(); };
      });
  } else start();
};
$("#menu-settings").onclick = () => openSettings();

function openSettings() {
  const budget = S?.budget ?? 120;
  modal(`<div class="dialog left"><h3>Settings</h3>
    <div class="settings">
      <label class="field"><span>Claude API key</span>
        <div class="keyrow"><input id="set-key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(getKey())}"><button class="btn" id="set-key-show" type="button">Show</button></div>
        <small class="hint">Sent only to Claude. Create one at platform.claude.com, and set a monthly spend limit there. Reading a receipt costs about a cent.</small>
      </label>
      ${cloud.user ? `<label class="class-card" style="cursor:pointer"><input type="checkbox" id="set-sync-key" ${syncKey ? "checked" : ""}>
        <span><b style="font-size:17px">Keep the key in my account</b><small>Your other signed-in devices get it automatically. Only you can read it.</small></span></label>` : ""}
      ${S ? `<label class="field"><span>Weekly budget</span><div class="money"><input id="set-budget" type="number" min="10" max="2000" step="5" value="${budget}"><b>gold</b></div></label>` : ""}
      <div class="field"><span>Campaign</span>
        <div class="row" style="justify-content:flex-start"><button class="btn danger" id="set-delete" ${S || loadSave() ? "" : "disabled"}>Delete campaign</button></div>
      </div>
    </div>
    <div class="row" style="margin-top:18px"><button class="btn primary" id="set-done">Save</button></div></div>`,
    (root) => {
      root.querySelector("#set-key-show").onclick = (e) => {
        const k = root.querySelector("#set-key");
        k.type = k.type === "password" ? "text" : "password";
        e.target.textContent = k.type === "password" ? "Show" : "Hide";
      };
      const del = root.querySelector("#set-delete");
      del.onclick = () => {
        if (del.dataset.armed) { deleteSave(); closeModal(); toast(cloud.user ? "Campaign deleted from every device" : "Campaign deleted"); renderMenu(); return; }
        del.dataset.armed = "1";
        del.textContent = "Tap again to delete for good";
      };
      root.querySelector("#set-done").onclick = () => {
        setKey(root.querySelector("#set-key").value);
        const sk = root.querySelector("#set-sync-key");
        if (sk) {
          syncKey = sk.checked;
          cloud.saveCloudKey(syncKey ? getKey() : "").catch(() => toast(`<span class="n">Couldn't update the key in your account.</span>`));
        }
        const b = root.querySelector("#set-budget");
        if (S && b) { S.budget = Math.max(10, Number(b.value) || S.budget); save(); }
        closeModal();
        toast("Settings saved");
        if (!$("#game").hidden) render();
        else if (!$("#actend").hidden) showActEnd();
        else renderMenu();
      };
    });
}

/* ---------- Character creation ---------- */
function renderCreate() {
  $("#class-list").innerHTML = Object.entries(CLASSES).map(([id, c], i) => `
    <label class="class-card"><input type="radio" name="cls" value="${id}" ${i === 1 ? "checked" : ""}>
      <span><b>${c.name}</b><small>${c.blurb}</small></span></label>`).join("");
  $("#companion-rows").innerHTML = [0, 1, 2].map((i) => `
    <div class="companion">
      <input id="c${i}-name" maxlength="20" placeholder="${EXAMPLE_PARTY[i].name}" aria-label="Companion ${i + 1} name">
      <input id="c${i}-likes" maxlength="60" placeholder="Likes: ${EXAMPLE_PARTY[i].likes}" aria-label="Companion ${i + 1} likes">
      <input id="c${i}-dislikes" maxlength="60" placeholder="Dislikes: ${EXAMPLE_PARTY[i].dislikes || "nothing"}" aria-label="Companion ${i + 1} dislikes">
    </div>`).join("");
  $("#hero-name").focus();
}
$("#create-back").onclick = renderMenu;
$("#create-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("#hero-name").value.trim() || "Hearthkeeper";
  const cls = document.querySelector('input[name="cls"]:checked')?.value || "paladin";
  const comps = [0, 1, 2]
    .map((i) => ({ name: $(`#c${i}-name`).value.trim(), likes: $(`#c${i}-likes`).value.trim(), dislikes: $(`#c${i}-dislikes`).value.trim() }))
    .filter((c) => c.name);
  const budget = Math.max(10, Number($("#budget").value) || 120);
  S = newCampaign({ name, cls, comps, budget });
  save();
  await loading({ title: "Prologue", sub: "Pitching camp and unpacking the haversack…", min: 2200 });
  openCouncil();
};

function newCampaign({ name, cls, comps, budget }) {
  const party = [{ name, role: CLASSES[cls].name, approval: 80, likes: "", dislikes: "" }];
  for (const c of comps) party.push({ ...c, approval: 60 });
  S = {
    v: 1, cls, act: 1, actStart: todayISO(), day: 0, planning: true, council: null,
    level: 1, xp: 0, budget: budget + (cls === "rogue" ? 20 : 0), spent: 0,
    perks: [], party, quests: [], supplies: [], pack: [], journal: [], recent: [],
    stats: { cooked: 0, skipped: 0, wasted: 0, actXP: 0 }, suppliesBonus: false, bark: null,
  };
  logLine(`${name} the ${CLASSES[cls].name} pitched camp.`);
  return S;
}

function suppliesFrom(quests) {
  const map = new Map();
  for (const q of quests) {
    for (const ing of q.ingredients) {
      const k = norm(ing.name);
      if (map.has(k)) { const s = map.get(k); s.cost += ing.cost; if (!s.for.includes(q.name)) s.for.push(q.name); }
      else map.set(k, { id: uid(), name: ing.name, aisle: ing.aisle, cost: ing.cost, for: [q.name], got: false });
    }
  }
  return [...map.values()].map((s) => ({ ...s, cost: Math.round(s.cost * 100) / 100 }));
}

function logLine(text) {
  S.journal.unshift({ t: `A${S.act} D${S.day + 1}`, text });
  S.journal = S.journal.slice(0, 30);
}

/* ---------- XP & levels ---------- */
function gainXP(n, why) {
  S.xp += n;
  S.stats.actXP += n;
  toast(`<span class="g">+${n} XP</span> · ${esc(why)}`);
  while (S.xp >= XP_PER_LEVEL) {
    S.xp -= XP_PER_LEVEL;
    S.level += 1;
    levelUp();
  }
}

function levelUp() {
  const pool = [
    ["Cuisine: Japanese", "Claude will plan Japanese dishes"], ["Cuisine: Mexican", "Claude will plan Mexican dishes"],
    ["Cuisine: Indian", "Claude will plan Indian dishes"], ["Cuisine: Middle Eastern", "Claude will plan Middle Eastern dishes"],
    ["Skill: Batch Cook", "Claude plans bigger cooks with leftovers"], ["Skill: Thirty-Minute Meals", "Claude keeps weeknights quick"],
    ["Skill: Budget Feasts", "Claude favours cheaper ingredients"], ["Skill: Bread & Pastry", "Claude adds baking"],
  ].filter(([p]) => !S.perks.includes(p));
  const options = pool.sort(() => Math.random() - 0.5).slice(0, 3);
  const level = S.level;
  modal(`<div class="dialog"><h3>Level ${level}</h3><p>The company grows stronger. Choose a perk.</p>
    <div class="choices">${options.map(([t, d]) => `<button class="choice" data-perk="${esc(t)}"><b>${esc(t)}</b><small>${esc(d)}</small></button>`).join("")}</div></div>`,
    (root) => root.querySelectorAll("[data-perk]").forEach((b) => b.onclick = () => {
      S.perks.push(b.dataset.perk);
      logLine(`Reached level ${level} and learned ${b.dataset.perk}.`);
      closeModal(); toast(`Learned <span class="g">${esc(b.dataset.perk)}</span>`); render();
    }));
}

/* ---------- Dice ---------- */
function rollD20({ title, sub, dc, onDone }) {
  modal(`<div class="dialog"><h3>${esc(title)}</h3><p>${esc(sub)} · DC ${dc}</p>
    <div class="die spin" id="die">?</div><p id="roll-out">The die tumbles…</p><div class="row" id="roll-btns"></div></div>`,
    (root) => {
      const die = root.querySelector("#die");
      let ticks = 0;
      const timer = setInterval(() => {
        die.textContent = 1 + Math.floor(Math.random() * 20);
        if (++ticks < (reducedMotion ? 1 : 11)) return;
        clearInterval(timer);
        const r = 1 + Math.floor(Math.random() * 20);
        die.textContent = r;
        die.classList.toggle("crit", r === 20);
        die.classList.toggle("fail", r === 1);
        const { text, button } = onDone(r, r >= dc);
        root.querySelector("#roll-out").textContent = text;
        root.querySelector("#roll-btns").innerHTML = `<button class="btn primary" id="roll-ok">${esc(button || "Continue")}</button>`;
        root.querySelector("#roll-ok").onclick = () => { closeModal(); render(); };
        root.querySelector("#roll-ok").focus();
      }, 70);
    });
}

/* ---------- Game ---------- */
function enterGame() {
  show("game");
  const h = location.hash.slice(1);
  if (["camp", "quests", "supplies", "pack", "party"].includes(h)) tab = h;
  render();
}

function header() {
  const hero = S.party[0];
  $("#hero-line").textContent = hero.name;
  $("#lvl-line").textContent = `Level ${S.level} ${hero.role} · Act ${S.act}`;
  const left = S.budget - S.spent;
  $("#gold").textContent = gold(left);
  $("#gold").classList.toggle("over", left < 0);
  $("#xpfill").style.width = `${(S.xp / XP_PER_LEVEL) * 100}%`;
  $("#xpnum").textContent = `${S.xp} / ${XP_PER_LEVEL}`;
}

const VIEWS = { camp: viewCamp, quests: viewQuests, supplies: viewSupplies, pack: viewPack, party: viewParty };
function render() {
  if (!S) return;
  header();
  $("#view").innerHTML = VIEWS[tab]();
  document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
  save();
}

function goTab(t) { tab = t; picked = []; render(); window.scrollTo(0, 0); }

/* Camp */
function pickBark() {
  const tonight = S.quests[S.day];
  const comps = companions();
  if (tonight && tonight.status === "planned" && tonight.no.length) {
    const who = tonight.no[0];
    return { who, line: `${tonight.name}? You know how I feel about that.`, kind: "dislike" };
  }
  const spoiling = S.pack.filter((p) => p.spoil && p.spoil <= 1);
  if (spoiling.length) {
    return { who: comps[0]?.name || S.party[0].name, line: `Something in the pack smells brave. The ${spoiling[0].name}, I think.`, kind: "spoil" };
  }
  const left = S.supplies.filter((s) => !s.got).length;
  if (left > 2 && S.day <= 2) {
    return { who: comps[1]?.name || comps[0]?.name || S.party[0].name, line: `We still need ${left} supplies for this act. Who's doing the run?`, kind: "supplies" };
  }
  const who = comps.length ? comps[Math.floor(Math.random() * comps.length)].name : S.party[0].name;
  return { who, line: LINES[Math.floor(Math.random() * LINES.length)], kind: "idle" };
}

function barkReplies(b) {
  if (b.kind === "dislike") return [
    { act: "persuade", label: "Trust me, this version is different.", tag: "Persuasion" },
    { act: "swap", label: "Fine. Let's have something else tonight." },
    { act: "dismiss", label: "You'll survive." },
  ];
  if (b.kind === "spoil") return [{ act: "pack", label: "Let's see what we can make with it." }, { act: "dismiss", label: "Later." }];
  if (b.kind === "supplies") return [{ act: "scan", label: "Already went. I'll scan the receipt." }, { act: "supplies", label: "Show me the list." }];
  return [{ act: "dismiss", label: "Mm." }];
}

function viewCamp() {
  const q = S.quests[S.day];
  const d = dateFor(S.day);
  const spoiling = S.pack.filter((p) => p.spoil && p.spoil <= 2).sort((a, b) => a.spoil - b.spoil);
  const left = S.supplies.filter((s) => !s.got);
  const b = S.bark;
  const comp = S.party.find((m) => m.name === b?.who);
  return `<section class="panel">
    <p class="eyebrow">Act ${S.act} · Day ${S.day + 1} of 7</p>
    <h2 class="view-title">${weekday(d, "long")} at camp</h2>
    <p class="lede">${d.toLocaleDateString(undefined, { day: "numeric", month: "long" })}. The fire's lit.</p>

    <div class="tonight">
      <p class="eyebrow" style="margin:0">Tonight's quest</p>
      <p class="dish">${esc(q.name)}</p>
      <div class="q-meta" style="margin:0">${questChips(q)}</div>
      ${approvalLine(q)}
      <div class="row">${tonightActions(q)}</div>
    </div>

    ${b ? `<div class="section-gap"></div>
    <div class="bark">
      <div class="crest" aria-hidden="true">${esc((b.who || "?")[0])}</div>
      <div>
        <div class="speaker">${esc(b.who)}${comp && comp !== S.party[0] ? "" : ""}</div>
        <p class="line">“${esc(b.line)}”</p>
        ${b.done ? "" : `<div class="replies">${barkReplies(b).map((r, i) => `<button class="reply" data-bark="${r.act}"><span>${i + 1}.</span>${r.tag ? `<em>[${r.tag}]</em>` : ""}${esc(r.label)}</button>`).join("")}</div>`}
      </div>
    </div>` : ""}

    <div class="section-gap"></div>
    <p class="eyebrow">Camp report</p>
    <div class="alerts">
      ${spoiling.map((p) => `<button class="alert" data-go="pack"><i class="dot"></i><span>${esc(p.name)} spoils ${p.spoil <= 1 ? "after tonight" : "in 2 days"}</span><b class="eyebrow" style="margin:0">Pack</b></button>`).join("")}
      ${left.length
        ? `<button class="alert info" data-go="supplies"><i class="dot"></i><span>${left.length} supplies still to gather (${gold(left.reduce((a, s) => a + s.cost, 0))})</span><b class="eyebrow" style="margin:0">Supplies</b></button>`
        : `<div class="alert ok"><i class="dot"></i><span>All supplies gathered for this act.</span></div>`}
      <button class="alert info" data-act="scan"><i class="dot"></i><span>Back from the shops? Scan the receipt.</span><b class="eyebrow" style="margin:0">Scan</b></button>
    </div>
  </section>`;
}

function questChips(q) {
  if (q.status === "out") return `<span class="chip status">Night off</span>`;
  const status = q.status === "done" ? "Complete" : q.status === "skipped" ? "Skipped" : S.quests[S.day] === q ? "Tonight" : "Planned";
  return `<span class="chip status">${status}</span><span class="chip ${q.diff.toLowerCase()}">${q.diff}</span><span class="chip">${q.mins} min</span>${q.newRecipe ? `<span class="chip new">New recipe</span>` : ""}`;
}
function approvalLine(q) {
  if (q.status === "out") return `<p class="q-approve">No cooking tonight. Eat out, order in, or raid the leftovers.</p>`;
  if (q.newRecipe && q.status === "planned") return `<p class="q-approve">Nobody's tried this before. Roll to see how it goes.</p>`;
  const yes = q.yes.length ? `<span class="yes">${q.yes.map(esc).join(", ")} will approve</span>` : "";
  const no = q.no.length ? `<span class="no">${q.no.map(esc).join(", ")} will disapprove</span>` : "";
  return `<p class="q-approve">${[yes, no].filter(Boolean).join(" · ") || "No strong opinions in camp."}</p>`;
}
function tonightActions(q) {
  const i = S.quests.indexOf(q);
  if (q.status === "planned") {
    const cook = q.newRecipe
      ? `<button class="btn primary" data-roll="${i}">Roll d20 to attempt</button>`
      : `<button class="btn primary" data-cook="${i}">Cooked it</button>`;
    return `${cook}<button class="btn" data-recipe="${q.id}">Recipe</button><button class="btn" data-act="rest">Long rest</button>`;
  }
  return `<button class="btn primary" data-act="rest">Long rest · end Day ${S.day + 1}</button>`;
}

function handleBark(act) {
  const b = S.bark;
  if (!b) return;
  if (act === "dismiss") { b.done = true; render(); return; }
  if (act === "pack") { b.done = true; goTab("pack"); return; }
  if (act === "supplies") { b.done = true; goTab("supplies"); return; }
  if (act === "scan") { b.done = true; render(); scanReceipt(); return; }
  if (act === "swap") {
    const j = S.quests.findIndex((q, k) => k > S.day && q.status === "planned" && !q.no.includes(b.who));
    b.done = true;
    if (j < 0) { toast("Nothing else on the plan suits them. Tonight stays."); render(); return; }
    [S.quests[S.day], S.quests[j]] = [S.quests[j], S.quests[S.day]];
    b.line = `${S.quests[S.day].name}? Now that's more like it.`;
    toast(`Swapped tonight for <span class="g">${esc(S.quests[S.day].name)}</span>`);
    render(); return;
  }
  if (act === "persuade") {
    const member = S.party.find((m) => m.name === b.who);
    const q = S.quests[S.day];
    b.done = true;
    rollD20({
      title: "Persuasion check", sub: `Convincing ${b.who}`, dc: 10,
      onDone: (r, ok) => {
        if (ok) {
          q.no = q.no.filter((n) => n !== b.who);
          if (!q.yes.includes(b.who)) q.yes.push(b.who);
          if (member) member.approval = Math.min(100, member.approval + 4);
          b.line = r === 20 ? "Fine. I'm actually excited now. Don't tell anyone." : "Alright. I'll give it a fair go.";
          gainXP(15, "Persuasion");
          return { text: r === 20 ? `Natural 20! ${b.who} is fully won over.` : `${b.who} is persuaded.` };
        }
        if (member) member.approval = Math.max(0, member.approval - 3);
        b.line = "I'll eat it. I won't enjoy it.";
        return { text: r === 1 ? `Natural 1. ${b.who} is now sulking dramatically.` : `${b.who} isn't convinced, but they'll eat it.` };
      },
    });
  }
}

/* Cooking */
function completeQuest(i, bonus = 0) {
  const q = S.quests[i];
  q.status = "done";
  S.stats.cooked += 1;
  for (const name of q.uses || []) {
    const p = S.pack.find((x) => sameItem(x.name, name));
    if (p) { p.qty -= 1; }
  }
  S.pack = S.pack.filter((p) => p.qty > 0);
  if (q.diff !== "Easy" || S.perks.includes("Skill: Batch Cook")) {
    S.pack.push({ id: uid(), name: `Leftover ${q.name}`, qty: 1, spoil: 3, rarity: "uncommon", leftover: true });
  }
  q.yes.forEach((n, k) => setTimeout(() => toast(`<span class="y">${esc(n)} approves.</span>`), 400 * (k + 1)));
  q.no.forEach((n, k) => setTimeout(() => toast(`<span class="n">${esc(n)} disapproves.</span>`), 400 * (q.yes.length + k + 1)));
  for (const m of S.party) {
    if (q.yes.includes(m.name)) m.approval = Math.min(100, m.approval + 6);
    if (q.no.includes(m.name)) m.approval = Math.max(0, m.approval - 4);
  }
  if (S.party[0]) S.party[0].approval = Math.min(100, S.party[0].approval + 2);
  logLine(`Cooked ${q.name}.`);
  gainXP(Math.max(5, 40 + bonus + (S.cls === "paladin" ? 10 : 0)), "Quest complete");
}

function attemptNewRecipe(i) {
  const q = S.quests[i];
  rollD20({
    title: "Skill check: Cooking", sub: q.name, dc: 12,
    onDone: (r, ok) => {
      let text, bonus;
      if (r === 20) { text = "Critical success! It goes in the recipe book for good."; bonus = 60; S.perks.push(`Recipe: ${q.name}`); }
      else if (ok) { text = "Success. A fine new dish."; bonus = 25; }
      else if (r > 1) { text = "A messy attempt, but everyone ate. That still counts."; bonus = 5; }
      else { text = "Critical fail. You ordered takeaway. Bravery still earns XP."; bonus = -35; }
      if (ok) q.yes = companions().map((m) => m.name).slice(0, 2);
      q.newRecipe = false;
      completeQuest(i, bonus);
      return { text, button: "Serve it" };
    },
  });
}

/* Long rest & day cycle */
function askRest() {
  const q = S.quests[S.day];
  if (q.status !== "planned") return longRest();
  modal(`<div class="dialog"><h3>Rest without cooking?</h3><p>${esc(q.name)} will be marked as skipped. No penalty. Life happens.</p>
    <div class="row"><button class="btn" data-x="no">Not yet</button><button class="btn primary" data-x="yes">Rest anyway</button></div></div>`,
    (root) => {
      root.querySelector('[data-x="no"]').onclick = closeModal;
      root.querySelector('[data-x="yes"]').onclick = () => { closeModal(); longRest(); };
    });
}

async function longRest() {
  const q = S.quests[S.day];
  if (q.status === "planned") { q.status = "skipped"; S.stats.skipped += 1; logLine(`Skipped ${q.name}.`); }
  await loading({ title: "Long Rest", sub: "The party settles in by the fire…", min: 2000 });
  const spoiled = [];
  for (const p of S.pack) {
    if (p.spoil == null) continue;
    p.spoil -= 1;
    if (p.spoil <= 0) spoiled.push(p.name);
  }
  S.pack = S.pack.filter((p) => p.spoil == null || p.spoil > 0);
  S.stats.wasted += spoiled.length;
  if (spoiled.length) logLine(`Lost to spoilage: ${spoiled.join(", ")}.`);
  S.day += 1;
  if (S.day >= 7) { save(); showActEnd(); return; }
  S.bark = pickBark();
  tab = "camp";
  show("game");
  render();
  const d = dateFor(S.day);
  modal(`<div class="dialog"><h3>Day ${S.day + 1} · ${weekday(d, "long")}</h3>
    <p>${spoiled.length ? `Overnight, these spoiled: <b class="no">${spoiled.map(esc).join(", ")}</b>.` : "Nothing spoiled overnight."}<br>Tonight: <b>${esc(S.quests[S.day].name)}</b>.</p>
    <div class="row"><button class="btn primary" id="ok">Rise and shine</button></div></div>`,
    (root) => { root.querySelector("#ok").onclick = closeModal; });
}

function showActEnd() {
  const st = S.stats;
  const under = S.spent <= S.budget;
  $("#actend-body").innerHTML = `
    <p class="kicker">Act ${S.act} complete</p>
    <h2>The week is won</h2>
    <p class="lede">Here's how the campaign went.</p>
    <div class="ledger">
      <div><span>Dinners cooked</span><b class="good">${st.cooked} of ${S.quests.filter((q) => q.status !== "out").length}</b></div>
      <div><span>Dinners skipped</span><b>${st.skipped}</b></div>
      <div><span>Items lost to spoilage</span><b class="${st.wasted ? "bad" : "good"}">${st.wasted}</b></div>
      <div><span>Gold spent</span><b class="${under ? "good" : "bad"}">${gold(S.spent)} of ${gold(S.budget)}</b></div>
      <div><span>XP earned this act</span><b>${st.actXP}${under ? " + 50 under budget" : ""}${st.wasted === 0 ? " + 30 zero waste" : ""}</b></div>
    </div>
    <div class="stack">
      <button class="btn primary" id="plan-claude">Plan Act ${S.act + 1}</button>
      <button class="btn" id="plan-repeat">Repeat this week's menu</button>
    </div>
    <p class="note">${hasKey() ? "Pick any dinners you want and Claude plans the rest around your party and your Pack." : "Add your Claude API key in Settings and Claude can plan the week with you."}</p>`;
  show("actend");
  $("#plan-claude").onclick = () => startNextAct(true);
  $("#plan-repeat").onclick = () => startNextAct(false);
}

async function startNextAct(plan) {
  const lastWeek = S.quests.filter((q) => q.status !== "out").map((q) => q.name);
  const bonus = (S.spent <= S.budget ? 50 : 0) + (S.stats.wasted === 0 ? 30 : 0);
  S.recent = [...lastWeek, ...S.recent].slice(0, 21);
  S.act += 1; S.actStart = todayISO(); S.day = 0; S.spent = 0; S.suppliesBonus = false;
  S.stats = { cooked: 0, skipped: 0, wasted: 0, actXP: 0 };
  S.pendingBonus = bonus;
  if (plan) {
    S.planning = true;
    S.council = null;
    save();
    await loading({ title: `Act ${S.act}`, sub: "The war council gathers…", min: 1200 });
    openCouncil();
    return;
  }
  S.quests = S.quests.map((q) => ({ ...q, id: uid(), status: q.status === "out" ? "out" : "planned" }));
  S.supplies = S.supplies.map((s) => ({ ...s, id: uid(), got: false }));
  await beginAct("Repeated last week's menu");
}

// Shared start of every act once its quests and supplies are set.
async function beginAct(note) {
  S.planning = false;
  S.council = null;
  S.bark = pickBark();
  logLine(`Act ${S.act} began. ${note}.`);
  save();
  await loading({ title: `Act ${S.act}`, sub: "A new week on the road…", min: 1400 });
  tab = "camp";
  enterGame();
  if (S.pendingBonus) { gainXP(S.pendingBonus, "Act rewards"); S.pendingBonus = 0; }
  render();
}

/* ---------- War council: plan the week ---------- */
// S.council holds the in-progress plan so it survives reloads and syncs:
// { days: [{ request, busy, out, quest? }], notes, kitchen, reviewed }
function councilDays() {
  if (!S.council) {
    S.council = { days: Array.from({ length: 7 }, () => ({ request: "", busy: false, out: false, quest: null })), notes: "", kitchen: "", reviewed: false };
  }
  return S.council;
}

function openCouncil() {
  S.actStart = S.council?.reviewed ? S.actStart : todayISO();
  const c = councilDays();
  save();
  if (c.reviewed) return renderReview();
  const knownPack = S.pack.map((p) => p.name).join(", ");
  $("#council-body").innerHTML = `
    <p class="eyebrow">Act ${S.act} · War council</p>
    <h2 class="create-title">Plan the week</h2>
    <p class="lede" style="margin:-8px 0 0">Choose any dinners you already want, mark busy nights and nights off, and Claude fills in the rest.</p>
    <div class="council-days">${c.days.map((d, i) => {
      const date = dateFor(i);
      return `<div class="council-day ${d.out ? "is-out" : ""}">
        <div class="day"><span>${weekday(date)}</span><b>${date.getDate()}</b></div>
        <div class="cd-main">
          <input id="cd-req-${i}" maxlength="60" value="${esc(d.request)}" placeholder="${d.out ? "Night off" : "Leave blank for Claude"}" aria-label="Dinner for ${weekday(date, "long")}" ${d.out ? "disabled" : ""}>
          <div class="cd-tags">
            <label class="tag"><input type="checkbox" id="cd-busy-${i}" ${d.busy ? "checked" : ""} ${d.out ? "disabled" : ""}>Busy night</label>
            <label class="tag"><input type="checkbox" id="cd-out-${i}" ${d.out ? "checked" : ""}>Night off</label>
          </div>
        </div>
      </div>`;
    }).join("")}</div>
    <label class="field"><span>Notes for Claude</span>
      <textarea id="cd-notes" rows="3" maxlength="500" placeholder="e.g. More vegetables this week. Mira's birthday on Saturday. Use up the chicken in the freezer.">${esc(c.notes)}</textarea>
    </label>
    <label class="field"><span>Already in the kitchen</span>
      <input id="cd-kitchen" maxlength="300" value="${esc(c.kitchen)}" placeholder="e.g. rice, half a cabbage, eggs, frozen peas">
      <small class="hint">${knownPack ? `Your Pack already has: ${esc(knownPack)}.` : "Comma-separated. Or scan your last receipt to fill your Pack."}</small>
    </label>
    <details class="how">
      <summary>How does Claude plan?</summary>
      <p>Claude sees what you enter here, your party's likes and dislikes, everything in your Pack (items that spoil soon come first), your weekly budget, the cuisines you've unlocked and your recent dinners so it doesn't repeat them. It doesn't see your receipts directly: scanned items go into your Pack, and Claude reads the Pack.</p>
    </details>
    <div class="create-actions">
      <button type="button" class="btn" id="cd-scan">Scan a receipt first</button>
      <button type="button" class="btn primary" id="cd-plan">${hasKey() ? "Ask Claude to plan" : "Plan it myself"}</button>
    </div>
    ${hasKey() ? "" : `<p class="hint">Add your Claude API key in Settings and Claude can fill in the blank nights and write the shopping list.</p>`}`;
  show("council");
  const read = () => {
    c.days.forEach((d, i) => {
      d.request = $(`#cd-req-${i}`).value.trim();
      d.busy = $(`#cd-busy-${i}`).checked;
      d.out = $(`#cd-out-${i}`).checked;
    });
    c.notes = $("#cd-notes").value.trim();
    c.kitchen = $("#cd-kitchen").value.trim();
    save();
  };
  $("#council-body").onchange = (e) => {
    read();
    if (e.target.id?.startsWith("cd-out-")) openCouncil();
  };
  $("#cd-scan").onclick = () => { read(); scanReceipt(); };
  $("#cd-plan").onclick = async () => {
    read();
    addKitchenToPack(c);
    if (!hasKey()) {
      const missing = c.days.filter((d) => !d.out && !d.request).length;
      if (missing) { toast(`<span class="n">Name a dinner for every night, or mark it as a night off.</span>`); return; }
      c.days.forEach((d) => { if (!d.out) d.quest = manualQuest(d.request, d.busy); });
      c.reviewed = true; save(); renderReview(); return;
    }
    const cook = c.days.map((d, i) => ({ d, i })).filter(({ d }) => !d.out);
    if (!cook.length) { toast("Every night is a night off. Enjoy the week!"); }
    try {
      const plan = cook.length ? await loading({
        title: `Act ${S.act}`, sub: "Claude is consulting the old recipe books…", min: 1500, cancellable: true,
        task: (signal) => planDays({ ...planContext(), days: cook.map(({ d, i }) => dayInfo(d, i)), signal }),
      }) : { quests: [] };
      cook.forEach(({ d }, k) => { d.quest = plan.quests[k] ? fromPlan(plan.quests[k]) : manualQuest(d.request || "Cook's Choice", d.busy); });
      c.reviewed = true; save(); renderReview();
    } catch (err) {
      toast(`<span class="n">${esc(err instanceof ClaudeError ? err.message : "Planning failed. Try again.")}</span>`);
    }
  };
}

function addKitchenToPack(c) {
  if (!c.kitchen) return;
  for (const entry of c.kitchen.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean)) {
    const { name, qty } = splitQty(entry);
    addToPack({ name: titleCase(name), qty, aisle: "Larder", price: 0, spoil: null });
  }
  c.kitchen = "";
}

function planContext() {
  return {
    party: S.party.map(({ name, likes, dislikes }) => ({ name, likes, dislikes })),
    pack: S.pack.map(({ name, qty, spoil }) => ({ name, qty, spoil })),
    perks: S.perks, recent: S.recent, notes: S.council.notes, budget: S.budget,
  };
}
const dayInfo = (d, i) => ({ label: dateFor(i).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), request: d.request, busy: d.busy });

function fromPlan(q) {
  const names = new Set(S.party.map((m) => m.name));
  return {
    name: q.name, diff: ["Easy", "Moderate", "Hard"].includes(q.difficulty) ? q.difficulty : "Easy",
    mins: Number(q.minutes) || 40, newRecipe: !!q.new_recipe,
    yes: (q.approves || []).filter((n) => names.has(n)), no: (q.disapproves || []).filter((n) => names.has(n)),
    uses: q.uses_from_pack || [],
    ingredients: (q.ingredients || []).map((g) => ({ name: g.name, aisle: AISLE_ORDER.includes(g.aisle) ? g.aisle : "Larder", cost: Number(g.cost) || 0 })),
  };
}
const manualQuest = (name, busy) => ({ name: name || "Cook's Choice", diff: "Easy", mins: busy ? 30 : 45, newRecipe: false, yes: [], no: [], uses: [], ingredients: [] });

function renderReview() {
  const c = councilDays();
  const cost = c.days.reduce((a, d) => a + (d.quest?.ingredients || []).reduce((x, g) => x + g.cost, 0), 0);
  $("#council-body").innerHTML = `
    <p class="eyebrow">Act ${S.act} · War council</p>
    <h2 class="create-title">The plan</h2>
    <p class="lede" style="margin:-8px 0 0">Change anything you like before the act begins. Shopping list estimate: <b>${gold(cost)}</b> of your ${gold(S.budget)}.</p>
    <div class="quests">${c.days.map((d, i) => {
      const date = dateFor(i);
      const q = d.quest;
      return `<article class="quest ${d.out ? "out" : ""}">
        <div class="day"><span>${weekday(date)}</span><b>${date.getDate()}</b></div>
        <div class="q-body">
          ${d.out ? `<p class="q-title">Night off</p><div class="row"><button class="btn" data-rv-cook="${i}">Cook this night</button></div>` : `
          <p class="q-title">${esc(q?.name || "Cook's Choice")}</p>
          <div class="q-meta"><span class="chip ${(q?.diff || "Easy").toLowerCase()}">${q?.diff || "Easy"}</span><span class="chip">${q?.mins || 40} min</span>${q?.newRecipe ? `<span class="chip new">New recipe</span>` : ""}${d.request ? `<span class="chip status">Your pick</span>` : ""}</div>
          <p class="q-approve">${(q?.ingredients || []).length ? `Needs: ${esc(q.ingredients.map((g) => g.name).join(", "))}` : "Nothing to buy for this one yet."}</p>
          <div class="row">
            ${hasKey() ? `<button class="btn" data-rv-reroll="${i}">Something else</button>` : ""}
            <button class="btn" data-rv-edit="${i}">Choose my own</button>
            <button class="btn" data-rv-out="${i}">Night off</button>
          </div>`}
        </div>
      </article>`;
    }).join("")}</div>
    <div class="create-actions">
      <button type="button" class="btn" id="rv-back">Back to planning</button>
      <button type="button" class="btn primary" id="rv-begin">Begin Act ${S.act}</button>
    </div>`;
  show("council");
  $("#council-body").onchange = null;
  $("#rv-back").onclick = () => { c.reviewed = false; save(); openCouncil(); };
  $("#rv-begin").onclick = finishCouncil;
  $("#council-body").querySelectorAll("[data-rv-out]").forEach((b) => b.onclick = () => { c.days[+b.dataset.rvOut].out = true; save(); renderReview(); });
  $("#council-body").querySelectorAll("[data-rv-cook]").forEach((b) => b.onclick = () => {
    const d = c.days[+b.dataset.rvCook];
    d.out = false;
    if (!d.quest) d.quest = manualQuest(d.request || "Cook's Choice", d.busy);
    save(); renderReview();
  });
  $("#council-body").querySelectorAll("[data-rv-reroll]").forEach((b) => b.onclick = () => rerollDay(+b.dataset.rvReroll));
  $("#council-body").querySelectorAll("[data-rv-edit]").forEach((b) => b.onclick = () => chooseOwn(+b.dataset.rvEdit));
}

async function rerollDay(i, request = "") {
  const c = councilDays();
  const d = c.days[i];
  const others = c.days.filter((x, k) => k !== i && x.quest && !x.out).map((x) => x.quest.name);
  try {
    const plan = await loading({
      title: request ? "Writing it up" : "Another idea", sub: request ? `Claude is writing up ${request}…` : "Claude is leafing through the recipe books…", min: 900, cancellable: true,
      task: (signal) => planDays({
        ...planContext(), recent: [...others, d.quest?.name, ...S.recent].filter(Boolean),
        days: [{ ...dayInfo(d, i), request }], signal,
      }),
    });
    if (plan.quests[0]) d.quest = fromPlan(plan.quests[0]);
    d.request = request;
  } catch (err) {
    toast(`<span class="n">${esc(err instanceof ClaudeError ? err.message : "That didn't work. Try again.")}</span>`);
  }
  save();
  renderReview();
}

function chooseOwn(i) {
  const d = councilDays().days[i];
  modal(`<div class="dialog left"><h3>Your choice</h3><p>What's for dinner on ${weekday(dateFor(i), "long")}?</p>
    <form id="own"><input id="own-name" maxlength="60" value="${esc(d.request || d.quest?.name || "")}" aria-label="Dish name">
    <div class="row" style="margin-top:14px"><button type="button" class="btn" id="own-x">Cancel</button><button class="btn primary">Save</button></div></form>
    ${hasKey() ? `<p class="hint" style="margin:12px 0 0">Claude will work out the ingredients for it.</p>` : ""}</div>`,
    (root) => {
      root.querySelector("#own-x").onclick = closeModal;
      root.querySelector("#own").onsubmit = (e) => {
        e.preventDefault();
        const v = root.querySelector("#own-name").value.trim();
        closeModal();
        if (!v) return;
        if (hasKey()) { rerollDay(i, v); return; }
        d.request = v; d.quest = manualQuest(v, d.busy); save(); renderReview();
      };
    });
}

async function finishCouncil() {
  const c = councilDays();
  S.quests = c.days.map((d) => d.out
    ? { id: uid(), name: "Night off", diff: "Easy", mins: 0, newRecipe: false, status: "out", yes: [], no: [], uses: [] }
    : { id: uid(), ...d.quest, status: "planned", buy: (d.quest.ingredients || []).map((g) => g.name), ingredients: undefined });
  S.supplies = suppliesFrom(c.days.filter((d) => !d.out && d.quest).map((d) => ({ name: d.quest.name, ingredients: d.quest.ingredients || [] })));
  // Supplies already gathered (e.g. a receipt scanned during planning) start ticked.
  for (const s of S.supplies) if (S.pack.some((p) => !p.leftover && sameItem(p.name, s.name))) s.got = true;
  await beginAct(hasKey() ? "The war council planned the week with Claude" : "The week was planned by hand");
}

/* Quests */
function viewQuests() {
  const done = S.quests.filter((q) => q.status === "done").length;
  return `<section class="panel">
    <p class="eyebrow">Act ${S.act} · Week of ${dateFor(0).toLocaleDateString(undefined, { day: "numeric", month: "long" })}</p>
    <h2 class="view-title">Quest Log</h2>
    <p class="lede">${done} of 7 dinners conquered.</p>
    <div class="quests">
      ${S.quests.map((q, i) => {
        const d = dateFor(i);
        const today = i === S.day;
        let actions = "";
        if (today && q.status === "planned") actions = tonightActions(q);
        else if (i > S.day && q.status === "planned") actions = `<button class="btn" data-recipe="${q.id}">Recipe</button><button class="btn" data-totonight="${i}">Make it tonight</button><button class="btn" data-rename="${i}">Change dish</button>`;
        else if (q.status === "done" || q.status === "skipped") actions = `<button class="btn" data-recipe="${q.id}">Recipe</button>`;
        return `<article class="quest ${today ? "today" : ""} ${q.status}">
          <div class="day"><span>${weekday(d)}</span><b>${d.getDate()}</b></div>
          <div class="q-body">
            <p class="q-title">${esc(q.name)}</p>
            <div class="q-meta">${questChips(q)}</div>
            ${q.status === "planned" ? approvalLine(q) : ""}
            ${actions ? `<div class="row">${actions}</div>` : ""}
          </div>
        </article>`;
      }).join("")}
    </div>
  </section>`;
}

function renameQuest(i) {
  const q = S.quests[i];
  modal(`<div class="dialog left"><h3>Change dish</h3><p>What's for dinner on ${weekday(dateFor(i), "long")}?</p>
    <form id="rn"><input id="rn-name" maxlength="60" value="${esc(q.name)}" aria-label="Dish name">
    <div class="row" style="margin-top:14px"><button type="button" class="btn" id="rn-x">Cancel</button><button class="btn primary">Save</button></div></form></div>`,
    (root) => {
      root.querySelector("#rn-x").onclick = closeModal;
      root.querySelector("#rn").onsubmit = (e) => {
        e.preventDefault();
        const v = root.querySelector("#rn-name").value.trim();
        if (v && v !== q.name) { q.name = v; q.yes = []; q.no = []; q.uses = []; q.buy = []; q.newRecipe = false; q.recipe = null; }
        closeModal(); render();
      };
    });
}

/* Recipes */
// Claude writes a dinner's recipe the first time it's opened; it's kept on the quest after that.
let recipeTicks = new Set();
let wakeLock = null;

async function openRecipe(id, { rewrite = false } = {}) {
  const q = S.quests.find((x) => x.id === id);
  if (!q) return;
  if ((!q.recipe || rewrite) && hasKey()) {
    try {
      const recipe = await loading({
        title: q.name, sub: "Claude is copying out the recipe…", min: 900, cancellable: true,
        task: (signal) => writeRecipe({
          dish: q.name, minutes: q.mins || 40, busy: (q.mins || 40) <= 30,
          eaters: S.party.map((m) => m.name),
          pack: S.pack.filter((p) => !p.leftover).map((p) => p.name),
          buy: q.buy || [],
          dislikes: S.party.map((m) => m.dislikes).filter(Boolean).join("; "),
          signal,
        }),
      });
      q.recipe = recipe;
      recipeTicks = new Set();
      save();
    } catch (err) {
      toast(`<span class="n">${esc(err instanceof ClaudeError ? err.message : "The recipe couldn't be written. Try again.")}</span>`);
      if (!q.recipe) { show("game"); render(); return; }
    }
  }
  renderRecipe(q);
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}

function ingredientSource(name) {
  if (S.pack.some((p) => !p.leftover && sameItem(p.name, name))) return ["have", "In your Pack"];
  const s = S.supplies.find((x) => sameItem(x.name, name));
  if (s) return s.got ? ["have", "Bought"] : ["buy", "On the shopping list"];
  return ["check", "Check the cupboard"];
}

function renderRecipe(q) {
  const r = q.recipe;
  const i = S.quests.indexOf(q);
  const tonight = i === S.day && q.status === "planned";
  const known = [...new Set([...(q.uses || []), ...(q.buy || [])])];
  $("#recipe-body").innerHTML = `
    <button class="btn" id="rc-back">← Back</button>
    <p class="eyebrow">${tonight ? "Tonight's quest" : `${weekday(dateFor(i), "long")} · ${q.status === "done" ? "Complete" : q.status === "skipped" ? "Skipped" : "Planned"}`}</p>
    <h2 class="recipe-title">${esc(q.name)}</h2>
    <div class="q-meta">
      <span class="chip ${q.diff.toLowerCase()}">${q.diff}</span>
      <span class="chip">${r ? r.minutes : q.mins} min</span>
      ${r ? `<span class="chip">Serves ${r.servings}</span>` : ""}
      ${q.newRecipe ? `<span class="chip new">New recipe</span>` : ""}
    </div>
    ${r ? `
      <section class="recipe-block">
        <h3>Ingredients</h3>
        <p class="hint">Tap each one as you get it out.</p>
        <ul class="ingredients">${r.ingredients.map((g, k) => {
          const [kind, label] = ingredientSource(g.name);
          return `<li><button class="ing ${recipeTicks.has(k) ? "ticked" : ""}" data-ing="${k}" aria-pressed="${recipeTicks.has(k)}">
            <span class="box">${recipeTicks.has(k) ? "✓" : ""}</span>
            <span class="ing-name"><b>${esc(g.amount)}</b> ${esc(g.name)}</span>
            <span class="src ${kind}">${label}</span>
          </button></li>`;
        }).join("")}</ul>
      </section>
      <section class="recipe-block">
        <h3>Method</h3>
        <ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        ${r.tip ? `<p class="tip"><b>Tip</b> ${esc(r.tip)}</p>` : ""}
      </section>` : `
      <section class="recipe-block">
        <h3>Ingredients</h3>
        ${known.length ? `<ul class="plain">${known.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : `<p class="hint">No ingredients noted for this dish.</p>`}
        <p class="hint">Add your Claude API key in Settings and Claude will write out the full recipe, with amounts and the method.</p>
      </section>`}
    <div class="row recipe-actions">
      ${tonight ? (q.newRecipe
        ? `<button class="btn primary" id="rc-cook">Roll d20 to attempt</button>`
        : `<button class="btn primary" id="rc-cook">Cooked it</button>`) : ""}
      ${hasKey() && r ? `<button class="btn" id="rc-rewrite">Write a different version</button>` : ""}
    </div>`;
  show("recipe");
  $("#rc-back").onclick = closeRecipe;
  $("#recipe-body").querySelectorAll("[data-ing]").forEach((b) => b.onclick = () => {
    const k = +b.dataset.ing;
    recipeTicks.has(k) ? recipeTicks.delete(k) : recipeTicks.add(k);
    renderRecipe(q);
  });
  const cook = $("#rc-cook");
  if (cook) cook.onclick = () => {
    closeRecipe();
    if (q.newRecipe) attemptNewRecipe(i);
    else { completeQuest(i); render(); }
  };
  const rewrite = $("#rc-rewrite");
  if (rewrite) rewrite.onclick = () => openRecipe(q.id, { rewrite: true });
}

function closeRecipe() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  recipeTicks = new Set();
  show("game");
  render();
}

/* Supplies */
function viewSupplies() {
  const got = S.supplies.filter((s) => s.got).length;
  const total = S.supplies.reduce((a, s) => a + s.cost, 0);
  const aisles = AISLE_ORDER.filter((a) => S.supplies.some((s) => s.aisle === a));
  return `<section class="panel">
    <p class="eyebrow">For Act ${S.act}</p>
    <h2 class="view-title">Supply Run</h2>
    <p class="lede">Built from this week's quests. Tap items as they go in the basket, or scan the receipt afterwards.</p>
    <button class="scan" data-act="scan">
      <svg viewBox="0 0 24 24"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>
      <span><b>Scan a receipt</b><small>${hasKey() ? "Take a photo and Claude adds everything to your Pack." : "Add your Claude API key in Settings to use this."}</small></span>
    </button>
    <div class="tally"><span>Gathered <b>${got}/${S.supplies.length}</b></span><span>Estimated <b>${gold(total)}</b></span></div>
    <form class="add" id="addform">
      <input id="additem" placeholder="Add a supply (e.g. Bread)" autocomplete="off" aria-label="Add a supply">
      <button class="btn" type="submit">Add</button>
    </form>
    ${aisles.length ? aisles.map((a) => {
      const items = S.supplies.filter((s) => s.aisle === a);
      const left = items.filter((s) => !s.got).length;
      return `<div class="aisle"><h3><span>${esc(a)}</span><span>${left ? `${left} left` : "Cleared"}</span></h3>
        <div class="list">${items.map((s) => `
          <button class="item ${s.got ? "got" : ""}" data-sup="${s.id}" aria-pressed="${s.got}">
            <span class="box">${s.got ? "✓" : ""}</span>
            <span class="nm"><b>${esc(s.name)}</b><small>${s.for.length ? `For ${esc(s.for.join(", "))}` : "Your own addition"}</small></span>
            <span class="cost">${gold(s.cost)}</span>
          </button>`).join("")}</div></div>`;
    }).join("") : `<div class="empty">Nothing to buy this act.</div>`}
  </section>`;
}

function toggleSupply(id) {
  const s = S.supplies.find((x) => x.id === id);
  if (!s) return;
  s.got = !s.got;
  if (s.got) {
    S.spent += s.cost;
    addToPack({ name: s.name, qty: 1, aisle: s.aisle, price: s.cost, spoil: null });
    toast(`<span class="g">+1 ${esc(s.name)}</span> added to Pack`);
    checkSuppliesCleared();
  } else {
    S.spent -= s.cost;
    const p = S.pack.find((x) => sameItem(x.name, s.name) && !x.leftover);
    if (p) { p.qty -= 1; S.pack = S.pack.filter((x) => x.qty > 0); }
  }
}
function checkSuppliesCleared() {
  if (!S.suppliesBonus && S.supplies.length && S.supplies.every((x) => x.got)) {
    S.suppliesBonus = true;
    setTimeout(() => { gainXP(50, "Supply run cleared"); render(); }, 600);
  }
}

function addToPack({ name, qty, aisle, price, spoil }) {
  const key = stackKey({ name });
  const have = S.pack.find((p) => stackKey(p) === key);
  if (have) {
    have.qty += qty;
    if (spoil) have.spoil = have.spoil ? Math.max(have.spoil, spoil) : spoil;
  } else {
    S.pack.push({ id: uid(), name, qty, spoil: spoil || null, rarity: rarityFor(aisle, price, spoil) });
  }
}

/* Pack */
function viewPack() {
  const leftovers = S.pack.filter((p) => p.leftover || (p.spoil && p.spoil <= 2));
  return `<section class="panel">
    <p class="eyebrow">Fridge, freezer &amp; larder</p>
    <h2 class="view-title">Pack</h2>
    <p class="lede">${S.pack.length} items carried. Red numbers are days until something spoils.</p>
    ${S.pack.length ? `<div class="grid">${S.pack.map((p) => `
      <button class="slot ${picked.includes(p.id) ? "pick" : ""}" style="--rc:var(--r-${p.rarity})" data-pack="${p.id}" aria-pressed="${picked.includes(p.id)}" title="${esc(p.name)}">
        ${p.spoil && p.spoil <= 3 ? `<span class="spoil">${p.spoil}d</span>` : ""}
        ${p.leftover ? `<span class="lo">LEFT</span>` : ""}
        <span class="glyph">${esc(p.name.replace(/^Leftover /, "")[0])}</span>
        <span class="lbl">${esc(p.name)}</span>
        <span class="qty">×${p.qty}</span>
      </button>`).join("")}</div>` : `<div class="empty">Your Pack is empty. Scan a receipt to fill it.</div>`}
    <div class="legend">
      <span><i style="background:var(--r-common)"></i>Staple</span>
      <span><i style="background:var(--r-uncommon)"></i>Fresh</span>
      <span><i style="background:var(--r-rare)"></i>Pricey</span>
      <span><i style="background:var(--r-epic)"></i>Treasure</span>
    </div>
    <div class="alchemy">
      <h3>Leftover Alchemy</h3>
      <p>${leftovers.length ? "Pick two or more leftovers or soon-to-spoil items and combine them into a meal." : "Nothing at risk right now. Bigger dinners leave leftovers here."}</p>
      <div class="row">
        <button class="btn primary" data-act="brew" ${picked.length >= 2 ? "" : "disabled"}>Combine ${picked.length >= 2 ? picked.length + " items" : ""}</button>
        <button class="btn" data-act="scan">Scan a receipt</button>
      </div>
    </div>
  </section>`;
}

function togglePick(id) {
  const p = S.pack.find((x) => x.id === id);
  if (!p) return;
  if (!(p.leftover || (p.spoil && p.spoil <= 2))) { toast(`${esc(p.name)} keeps for now. Pick leftovers or items about to spoil.`); return; }
  picked = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
  render();
}

function brew() {
  const items = picked.map((id) => S.pack.find((p) => p.id === id)).filter(Boolean);
  if (items.length < 2) return;
  const names = items.map((p) => p.name.replace(/^Leftover /, ""));
  const dish = names.length === 2 ? `${names[0]} & ${names[1]} Hash` : `Camp Stew of ${names.length} Things`;
  for (const p of items) p.qty -= 1;
  S.pack = S.pack.filter((p) => p.qty > 0);
  picked = [];
  logLine(`Turned ${names.join(", ")} into ${dish}.`);
  toast(`Brewed <span class="g">${esc(dish)}</span>`);
  gainXP((S.cls === "mage" ? 2 : 1) * 15 * items.length, "Nothing wasted");
  render();
}

/* Party */
function viewParty() {
  return `<section class="panel">
    <p class="eyebrow">Your household</p>
    <h2 class="view-title">The Party</h2>
    <p class="lede">Approval rises when you cook what someone likes.</p>
    <div class="party">${S.party.map((m, i) => `
      <div class="member">
        <div class="crest" aria-hidden="true">${esc(m.name[0])}</div>
        <div class="info">
          <b>${esc(m.name)}</b>
          <small>${i === 0 ? esc(m.role) : [m.likes && `Likes ${esc(m.likes)}`, m.dislikes && `dislikes ${esc(m.dislikes)}`].filter(Boolean).join(" · ") || "No stated tastes"}</small>
          <div class="meter" role="meter" aria-label="${esc(m.name)} approval" aria-valuenow="${m.approval}" aria-valuemin="0" aria-valuemax="100"><i style="width:${m.approval}%"></i></div>
        </div>
        <span class="mood">${m.approval >= 90 ? "Devoted" : m.approval >= 70 ? "Pleased" : m.approval >= 50 ? "Content" : "Grumbling"}</span>
      </div>`).join("")}</div>
    <p class="eyebrow">Perks &amp; recipes</p>
    <div class="perks">${S.perks.length ? S.perks.map((p) => `<span class="chip">${esc(p)}</span>`).join("") : `<span class="hint">Level up to unlock cuisines and skills.</span>`}</div>
    <div class="section-gap"></div>
    <p class="eyebrow">Journal</p>
    <div class="journal">${S.journal.map((j) => `<div><time>${esc(j.t)}</time><span>${esc(j.text)}</span></div>`).join("")}</div>
  </section>`;
}

/* ---------- Receipt scanning ---------- */
function scanReceipt() {
  if (!hasKey()) {
    modal(`<div class="dialog"><h3>Claude needs a key</h3><p>Receipt scanning uses your Claude API key. Add it in Settings and try again.</p>
      <div class="row"><button class="btn" data-x="no">Not now</button><button class="btn primary" data-x="yes">Open Settings</button></div></div>`,
      (root) => {
        root.querySelector('[data-x="no"]').onclick = closeModal;
        root.querySelector('[data-x="yes"]').onclick = () => { closeModal(); openSettings(); };
      });
    return;
  }
  const input = $("#receipt-input");
  input.value = "";
  input.click();
}

$("#receipt-input").onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  let result;
  try {
    result = await loading({
      title: "Reading the receipt", sub: "Claude is deciphering the merchant's scroll…", min: 1200, cancellable: true,
      task: async (signal) => readReceipt({ ...(await prepareImage(file)), signal }),
    });
  } catch (err) {
    toast(`<span class="n">${esc(err instanceof ClaudeError ? err.message : "That receipt couldn't be read. Try a flatter, sharper photo.")}</span>`);
    return;
  }
  if (S.planning) openCouncil();
  else { show("game"); render(); }
  showLoot(result);
};

function showLoot(result) {
  const items = (result.items || []).filter((it) => it.name);
  if (!result.is_receipt || !items.length) {
    modal(`<div class="dialog"><h3>No loot found</h3><p>That doesn't look like a receipt Claude can read. Try again with the whole receipt flat and in focus.</p>
      <div class="row"><button class="btn primary" id="ok">OK</button></div></div>`, (root) => { root.querySelector("#ok").onclick = closeModal; });
    return;
  }
  const sum = items.reduce((a, it) => a + (Number(it.price) || 0), 0);
  modal(`<div class="dialog left"><h3>Loot${result.store ? ` from ${esc(result.store)}` : ""}</h3>
    <p>${items.length} items found${result.total ? ` · receipt total ${result.total.toFixed(2)}` : ""}. Untick anything that isn't for the Pack.</p>
    <div class="loot">${items.map((it, i) => `
      <label><input type="checkbox" id="loot-${i}" checked>
        <span class="nm">${esc(it.name)}${it.qty > 1 ? ` ×${it.qty}` : ""}<small>${esc(it.aisle)}${it.spoil_days ? ` · keeps ~${it.spoil_days}d` : ""}</small></span>
        <span class="pr">${(Number(it.price) || 0).toFixed(2)}</span></label>`).join("")}</div>
    <div class="row"><button class="btn" id="loot-x">Discard</button><button class="btn primary" id="loot-take">Take all</button></div></div>`,
    (root) => {
      const boxes = [...root.querySelectorAll(".loot input")];
      const take = root.querySelector("#loot-take");
      const label = () => { const n = boxes.filter((b) => b.checked).length; take.textContent = n === items.length ? "Take all" : `Take ${n}`; take.disabled = n === 0; };
      boxes.forEach((b) => b.onchange = label);
      root.querySelector("#loot-x").onclick = closeModal;
      take.onclick = () => {
        const chosen = items.filter((_, i) => boxes[i].checked);
        collectLoot(chosen, result.store);
        closeModal();
        if (S.planning) openCouncil(); else render();
      };
    });
  return sum;
}

function collectLoot(items, store) {
  let spent = 0, ticked = 0;
  for (const it of items) {
    const qty = Math.max(1, Number(it.qty) || 1);
    const price = Number(it.price) || 0;
    spent += price;
    addToPack({ name: it.name, qty, aisle: it.aisle, price, spoil: it.spoil_days > 0 ? it.spoil_days : null });
    const s = S.supplies.find((x) => !x.got && sameItem(x.name, it.name));
    if (s) { s.got = true; ticked += 1; }
  }
  S.spent += spent;
  logLine(`Brought back ${items.length} items${store ? ` from ${store}` : ""} for ${gold(spent)}.`);
  toast(`<span class="g">+${items.length} items</span> added to Pack`);
  if (ticked) setTimeout(() => toast(`Ticked off <span class="g">${ticked}</span> on the supply list`), 450);
  gainXP(Math.min(40, 5 * items.length), "Loot collected");
  checkSuppliesCleared();
}

/* ---------- Events ---------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t || $("#game").hidden) return;
  const d = t.dataset;
  if (d.tab) return goTab(d.tab);
  if (d.go) return goTab(d.go);
  if (d.cook) { completeQuest(+d.cook); return render(); }
  if (d.roll) return attemptNewRecipe(+d.roll);
  if (d.totonight) {
    const i = +d.totonight;
    [S.quests[S.day], S.quests[i]] = [S.quests[i], S.quests[S.day]];
    toast(`<span class="g">${esc(S.quests[S.day].name)}</span> is now tonight's quest`);
    return render();
  }
  if (d.rename) return renameQuest(+d.rename);
  if (d.recipe) return openRecipe(d.recipe);
  if (d.sup) { toggleSupply(d.sup); return render(); }
  if (d.pack) return togglePick(d.pack);
  if (d.bark) return handleBark(d.bark);
  if (d.act === "rest") return askRest();
  if (d.act === "scan") return scanReceipt();
  if (d.act === "brew") return brew();
  if (t.id === "open-menu") { save(); renderMenu(); }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "addform") return;
  e.preventDefault();
  const v = $("#additem").value.trim();
  if (!v) return;
  S.supplies.push({ id: uid(), aisle: "Added by you", name: v, cost: 2, for: [], got: false });
  S.suppliesBonus = S.suppliesBonus && S.supplies.every((x) => x.got);
  toast(`<span class="g">${esc(v)}</span> added to the supply run`);
  render();
  $("#additem").focus();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalOpen && $("#modal [data-x='no'], #modal #loot-x, #modal #rn-x")) {
    $("#modal [data-x='no'], #modal #loot-x, #modal #rn-x").click();
  }
  if (!$("#game").hidden && !modalOpen && /^[1-3]$/.test(e.key) && document.activeElement?.tagName !== "INPUT") {
    document.querySelectorAll(".reply")[+e.key - 1]?.click();
  }
});

/* ---------- Embers ---------- */
function embers() {
  const c = $("#embers");
  const ctx = c.getContext("2d");
  let w, h, dpr;
  const resize = () => { dpr = Math.min(2, devicePixelRatio || 1); w = c.width = innerWidth * dpr; h = c.height = innerHeight * dpr; };
  resize();
  addEventListener("resize", resize);
  const spawn = () => ({ x: Math.random() * w, y: h + Math.random() * h * 0.3, r: (0.6 + Math.random() * 1.8) * dpr, vy: (0.3 + Math.random() * 0.9) * dpr, vx: (Math.random() - 0.5) * 0.3 * dpr, life: 0.6 + Math.random() * 0.4, t: Math.random() * 100 });
  const parts = Array.from({ length: 70 }, () => { const p = spawn(); p.y = Math.random() * h; return p; });
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.t += 0.02; p.y -= p.vy; p.x += p.vx + Math.sin(p.t) * 0.3 * dpr;
      const a = Math.max(0, Math.min(1, p.y / h)) * p.life;
      ctx.beginPath();
      ctx.fillStyle = `rgba(${230 + Math.random() * 25 | 0}, ${140 + Math.random() * 50 | 0}, 60, ${a})`;
      ctx.shadowColor = "rgba(230,150,60,.8)"; ctx.shadowBlur = 8 * dpr;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      if (p.y < -10) Object.assign(p, spawn());
    }
    if (!document.body.classList.contains("in-game")) requestAnimationFrame(draw);
    else setTimeout(() => requestAnimationFrame(draw), 500);
  };
  if (!reducedMotion) draw();
}

/* ---------- Boot ---------- */
embers();
S = loadSave();
renderMenu();
cloud.onUser((u) => {
  if (u) onSignedIn();
  else if (!$("#menu").hidden) renderMenu();
});
