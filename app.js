const SKELETON_HTML = `
  <div class="section-loader">
    <div class="spin-ring"></div>
    <div class="spin-label">Loading…</div>
  </div>
  <div class="skeleton-card"><div class="sk-head"></div><div class="sk-body"><div class="sk-team"></div><div class="sk-score"></div><div class="sk-team"></div></div><div class="sk-tip"></div></div>
  <div class="skeleton-card"><div class="sk-head"></div><div class="sk-body"><div class="sk-team"></div><div class="sk-score"></div><div class="sk-team"></div></div><div class="sk-tip"></div></div>
  <div class="skeleton-card"><div class="sk-head"></div><div class="sk-body"><div class="sk-team"></div><div class="sk-score"></div><div class="sk-team"></div></div><div class="sk-tip"></div></div>
`;

function flashSectionLoading(type) {
  const dataEl    = document.getElementById(type === "free" ? "freeData" : "vipData");
  const emptyEl   = document.getElementById(type === "free" ? "emptyFree" : "emptyVip");
  const summaryEl = document.getElementById(type === "free" ? "summaryFree" : "summaryVip");
  const skelEl    = document.getElementById(type === "free" ? "freeSkeletonRows" : "vipSkeletonRows");

  const alreadyHasContent = dataEl.style.display !== "none" && dataEl.innerHTML.trim() !== "";
  if (alreadyHasContent) {
    processTodayMatches();
    return;
  }

  dataEl.style.display = "none";
  emptyEl.classList.add("hidden");
  summaryEl.style.display = "none";

  skelEl.style.opacity = "1";
  skelEl.style.display = "block";
  skelEl.innerHTML = SKELETON_HTML;

  processTodayMatches();
}

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import {
  getFirestore, collection, query, where, limit,
  onSnapshot, doc, getDoc, getDocs, setDoc, updateDoc,
  serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

const firebaseConfig = {
  apiKey:            "AIzaSyDbfaPPAFdOSJm09OxQeMqQ-UsLkQzsdxk",
  authDomain:        "vip-app-b82d3.firebaseapp.com",
  projectId:         "vip-app-b82d3",
  storageBucket:     "vip-app-b82d3.firebasestorage.app",
  messagingSenderId: "412845975498",
  appId:             "1:412845975498:web:e577440f7ae87de7b4d133"
};
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");

const TEXT_INPUT_IDS = ["vipCodeInput", "identityName", "identityEmail"];
document.addEventListener("contextmenu", e => {
  if (TEXT_INPUT_IDS.includes(e.target.id)) return;
  e.preventDefault();
});
document.addEventListener("copy", e => e.preventDefault());
document.addEventListener("cut", e => e.preventDefault());
document.addEventListener("selectstart", e => {
  if (!TEXT_INPUT_IDS.includes(e.target.id)) e.preventDefault();
});
document.addEventListener("dragstart", e => e.preventDefault());

document.documentElement.setAttribute("data-theme", "dark");

let splashHidden = false;
const splashMinTimePromise = new Promise(res => setTimeout(res, 900));

function hideSplash() {
  const el = document.getElementById("splashScreen");
  if (!el) return;
  el.classList.add("hide");
  setTimeout(() => el.remove(), 550);
}

function trySplashHide() {
  if (splashHidden) return;
  splashHidden = true;
  splashMinTimePromise.then(hideSplash);
}

setTimeout(trySplashHide, 6000);

function swapSkeletonForContent(skeletonEl) {
  if (!skeletonEl || skeletonEl.style.display === "none") return;
  skeletonEl.style.opacity = "0";
  setTimeout(() => { skeletonEl.style.display = "none"; }, 300);
}

function renderWithFade(el, html) {
  if (!el) return;
  el.style.transition = "opacity .22s ease";
  el.style.opacity = "0";
  setTimeout(() => {
    el.innerHTML = html;
    requestAnimationFrame(() => { el.style.opacity = "1"; });
  }, 180);
}

let vipUnlocked     = false;
let vipExpiryDate   = null;
let autoLogoutTimer = null;
let codeUnsub       = null;
let currentVipCode  = localStorage.getItem("vipCode") || null;
let notifiedMatches = JSON.parse(localStorage.getItem("notifiedMatches") || "{}");
let notifications   = JSON.parse(localStorage.getItem("vipNotifications") || "[]");
let selectedPlan    = null;

// Sound alerts removed — the browser Audio API can't detect a phone's
// physical silent/mute switch, so beeps played at full volume even when
// the device was set to silent. Vibration + system notifications are
// used instead, since those respect the device's own settings.

let serverOffsetMs = 0;

async function syncServerTime() {
  try {
    const ref = doc(db, "_meta", "serverTime");
    const t0  = Date.now();
    await setDoc(ref, { ts: serverTimestamp() }, { merge: true });
    const snap = await getDoc(ref);
    const t1   = Date.now();
    const serverMillis = snap.data()?.ts?.toMillis?.();
    if (serverMillis) {
      const localMidpoint = (t0 + t1) / 2;
      serverOffsetMs = serverMillis - localMidpoint;
    }
  } catch (e) {
    console.warn("Could not sync server time, falling back to device clock:", e.message);
  }
}
function now() {
  return new Date(Date.now() + serverOffsetMs);
}

let today = null;
let date  = null;

const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function computeDateFromNow() {
  today = now();
  date  = [
    String(today.getDate()).padStart(2,"0"),
    String(today.getMonth()+1).padStart(2,"0"),
    today.getFullYear()
  ].join(".");

  if (localStorage.getItem("lastDate") !== date) {
    localStorage.removeItem("notifiedMatches");
    notifiedMatches = {};
    localStorage.setItem("lastDate", date);
  }

  const weekday = WEEKDAYS[today.getDay()];
  document.getElementById("title").innerText = `TODAY — ${weekday}, ${date}`;
}

let currentUid = null;
let authReadyPromise = null;

function ensureAnonAuth() {
  if (authReadyPromise) return authReadyPromise;
  authReadyPromise = new Promise((resolve) => {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        currentUid = user.uid;
        resolve(user.uid);
      } else {
        signInAnonymously(auth).catch((e) => {
          console.error("Anonymous sign-in failed:", e.code, e.message);
          resolve(null);
        });
      }
    });
  });
  return authReadyPromise;
}

function getVisitorId() {
  return currentUid;
}

async function trackVisit() {
  try {
    const visitorId = getVisitorId();
    if (!visitorId) return;
    const ref  = doc(db, "analytics_visitors", visitorId);
    const snap = await getDoc(ref).catch(() => null);
    const nowISO = now().toISOString();
    const identity = getStoredIdentity();

    if (snap && snap.exists()) {
      const data = snap.data();
      const isNewDay = data.lastDate !== date;
      await setDoc(ref, {
        lastSeen:   nowISO,
        lastDate:   date,
        visits:     increment(1),
        daysActive: isNewDay ? increment(1) : increment(0),
        ...(identity ? { name: identity.name, email: identity.email } : {})
      }, { merge: true });
    } else {
      await setDoc(ref, {
        firstSeen:       nowISO,
        lastSeen:        nowISO,
        lastDate:        date,
        visits:          1,
        daysActive:      1,
        vipUnlockedEver: false,
        name:            identity ? identity.name  : null,
        email:           identity ? identity.email : null
      }, { merge: true });
    }
  } catch (e) {
    console.warn("Visitor tracking failed:", e.message);
  }
}

function getStoredIdentity() {
  try {
    const raw = localStorage.getItem("userIdentity");
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function showIdentityModalIfNeeded() {
  if (!getStoredIdentity()) {
    document.getElementById("identityModal").style.display = "flex";
    setTimeout(() => document.getElementById("identityName")?.focus(), 200);
  }
}
async function saveIdentity(name, email) {
  const identity = { name, email: email || null, savedAt: now().toISOString() };
  localStorage.setItem("userIdentity", JSON.stringify(identity));
  try {
    const ref  = doc(db, "analytics_visitors", getVisitorId());
    const snap = await getDoc(ref).catch(() => null);

    if (snap && snap.exists()) {
      await setDoc(ref, { name, email: email || null }, { merge: true });
    } else {
      const nowISO = now().toISOString();
      await setDoc(ref, {
        firstSeen: nowISO,
        lastSeen: nowISO,
        lastDate: date,
        visits: 1,
        daysActive: 1,
        vipUnlockedEver: false,
        name, email: email || null
      }, { merge: true });
    }
  } catch (e) {
    console.warn("Could not save identity to server:", e.message);
  }
}
window.submitIdentity = async function() {
  const nameEl  = document.getElementById("identityName");
  const emailEl = document.getElementById("identityEmail");
  const msgEl   = document.getElementById("identityMsg");
  const btn     = document.getElementById("identityBtn");
  const name    = nameEl.value.trim();
  const email   = emailEl.value.trim();

  msgEl.style.color = "var(--coral)";

  if (!name) {
    msgEl.innerText = "Please enter your name first";
    nameEl.focus();
    return;
  }
  if (!email) {
    msgEl.innerText = "Please enter your email";
    emailEl.focus();
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    msgEl.innerText = "Invalid email, please check again";
    emailEl.focus();
    return;
  }

  btn.disabled = true; btn.innerText = "SAVING…";
  msgEl.style.color = "var(--pitch)";
  msgEl.innerText = "";

  await saveIdentity(name, email);

  document.getElementById("identityModal").style.display = "none";
  addNotification(`Welcome ${name}! You're all set. 👋`, "👋");
  btn.disabled = false; btn.innerText = "Continue ➜";
};

function startVisitorHeartbeat() {
  setInterval(async () => {
    try {
      const visitorId = getVisitorId();
      if (!visitorId) return;
      const ref = doc(db, "analytics_visitors", visitorId);
      await setDoc(ref, { lastSeen: now().toISOString() }, { merge: true });
    } catch (e) { /* ignore transient failures */ }
  }, 120000);
}

async function markVisitorVipUnlocked() {
  try {
    const ref = doc(db, "analytics_visitors", getVisitorId());
    await setDoc(ref, { vipUnlockedEver: true }, { merge: true });
  } catch (e) { /* non-critical */ }
}

let blockedUnsub = null;
function startBlockedWatcher() {
  const myId = getVisitorId();
  if (!myId) return;
  if (blockedUnsub) blockedUnsub();
  blockedUnsub = onSnapshot(doc(db, "analytics_visitors", myId), snap => {
    const data = snap.exists() ? snap.data() : null;
    const isBlocked = !!(data && data.blocked);
    document.getElementById("blockedScreen").style.display = isBlocked ? "flex" : "none";
  }, () => { /* ignore transient read errors */ });
}

let deviceResetUnsub = null;
function startDeviceResetWatcher() {
  const myId = getVisitorId();
  if (!myId) return;
  if (deviceResetUnsub) deviceResetUnsub();

  deviceResetUnsub = onSnapshot(doc(db, "device_resets", myId), async snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.resetRequested !== true) return;

    try {
      localStorage.clear();
      sessionStorage.clear();

      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }

      await updateDoc(doc(db, "device_resets", myId), { resetRequested: false });

      window.location.href = window.location.href.split("#")[0];
    } catch (e) {
      console.warn("Device reset failed:", e.message);
    }
  }, () => { /* ignore transient read errors */ });
}

function startDateRolloverWatcher() {
  setInterval(() => {
    const n = now();
    const newDate = [
      String(n.getDate()).padStart(2,"0"),
      String(n.getMonth()+1).padStart(2,"0"),
      n.getFullYear()
    ].join(".");
    if (newDate !== date) {
      window.location.reload();
    }
  }, 60000);
}

function handleDesktopNav() {
  const desktopNav = document.getElementById("desktopNav");
  desktopNav.style.display = window.innerWidth >= 900 ? "flex" : "none";
}
handleDesktopNav();
window.addEventListener("resize", handleDesktopNav);

function renderNotifications() {
  const list    = document.getElementById("notifList");
  const countEl = document.getElementById("notifCount");
  if (notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    countEl.classList.add("hidden");
    return;
  }
  list.innerHTML = notifications.slice(0, 8).map(n =>
    `<div class="notif-item">${n.icon || "🔔"} ${n.msg}<br>
     <span style="font-size:9px;opacity:.4;font-family:'JetBrains Mono',monospace;">${n.time}</span></div>`
  ).join("");
  countEl.innerText = Math.min(notifications.length, 9);
  countEl.classList.remove("hidden");
}
function addNotification(msg, icon = "🔔") {
  const time = now().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  notifications.unshift({ msg, icon, time });
  if (notifications.length > 20) notifications.pop();
  localStorage.setItem("vipNotifications", JSON.stringify(notifications));
  renderNotifications();
}
window.toggleNotifPanel = function() {
  document.getElementById("notifPanel").classList.toggle("open");
};
window.clearNotifications = function() {
  notifications = [];
  localStorage.setItem("vipNotifications", JSON.stringify(notifications));
  renderNotifications();
};
document.addEventListener("click", e => {
  if (!e.target.closest(".notif-panel") && !e.target.closest("#notifBell")) {
    document.getElementById("notifPanel").classList.remove("open");
  }
});
renderNotifications();

function showToast(message) {
  document.getElementById("toast")?.remove();
  const toast = Object.assign(document.createElement("div"), { id:"toast", innerText: message });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}
window.closePopup = () => { document.getElementById("popup").style.display = "none"; };
window.showPopup  = function(msg) {
  document.getElementById("popupMsg").innerText = msg;
  document.getElementById("popup").style.display = "flex";
  navigator.vibrate?.([200, 100, 200]);
  if (Notification.permission === "granted" && "serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then(reg =>
      reg.showNotification("BM SURESCORE", {
        body: msg,
        icon: "https://cdn-icons-png.flaticon.com/512/1828/1828884.png",
        vibrate: [200, 100, 200]
      })
    );
  }
};

window.showSection = function(type) {
  ["freeSection","vipSection","historySection"].forEach(id =>
    document.getElementById(id).classList.add("hidden")
  );
  ["bnavFree","bnavVip","bnavHistory"].forEach(id =>
    document.getElementById(id).classList.remove("active")
  );
  ["dnavFree","dnavVip","dnavHistory"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = "dnav-btn";
  });

  if (type === "free") {
    document.getElementById("freeSection").classList.remove("hidden");
    document.getElementById("bnavFree").classList.add("active");
    const d = document.getElementById("dnavFree");
    if (d) d.classList.add("active-free");
    flashSectionLoading("free");
  } else if (type === "vip") {
    document.getElementById("vipSection").classList.remove("hidden");
    document.getElementById("bnavVip").classList.add("active");
    const d = document.getElementById("dnavVip");
    if (d) d.classList.add("active-vip");
    if (!vipUnlocked) {
      document.getElementById("authBox").style.display = "block";
      document.getElementById("vipCtaBanner").style.display = "flex";
    }
    flashSectionLoading("vip");
  } else {
    document.getElementById("historySection").classList.remove("hidden");
    document.getElementById("bnavHistory").classList.add("active");
    const d = document.getElementById("dnavHistory");
    if (d) d.classList.add("active-hist");
    const histType = document.getElementById("historyVipWrap").classList.contains("hidden") ? "free" : "vip";
    showHistoryType(histType);
  }
  navigator.vibrate?.([10]);
};

window.showHistoryType = function(type) {
  document.getElementById("historyFreeWrap").classList.toggle("hidden", type !== "free");
  document.getElementById("historyVipWrap").classList.toggle("hidden",  type !== "vip");
  document.getElementById("histFreeBtn").classList.toggle("on-free", type === "free");
  document.getElementById("histVipBtn").classList.toggle("on-vip",  type === "vip");
};

window.selectPlan = function(el) {
  document.querySelectorAll(".plan-card").forEach(c => c.classList.remove("selected"));
  el.classList.add("selected");
  selectedPlan = { plan: el.dataset.plan, price: el.dataset.price, label: el.dataset.label };
  navigator.vibrate?.([10]);
};

function scheduleAutoLogout(expiryDate) {
  if (autoLogoutTimer) clearTimeout(autoLogoutTimer);
  const msLeft = expiryDate - now();
  if (msLeft <= 0) { performExpiryLogout(); return; }
  const maxTimeout = 2147483647;
  if (msLeft > maxTimeout) {
    autoLogoutTimer = setTimeout(() => scheduleAutoLogout(expiryDate), maxTimeout);
  } else {
    autoLogoutTimer = setTimeout(performExpiryLogout, msLeft);
  }
}

function performExpiryLogout() {
  clearStoredCode();
  vipUnlocked   = false;
  vipExpiryDate = null;
  document.getElementById("vipRequestCard")?.remove();
  document.getElementById("authBox").style.display = "block";
  document.getElementById("vipCtaBanner").style.display = "flex";
  showPopup("⏰ Your VIP code has expired. Please request a new code.");
  addNotification("Your VIP code has expired.", "⏰");
}

let countdownInterval = null;
function startCountdownDisplay() {
  updateCountdownDisplay();
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(updateCountdownDisplay, 1000);
}
function updateCountdownDisplay() {
  if (!vipExpiryDate) return;
  const wrap = document.getElementById("vipCountdownWrap");
  if (!wrap) return;
  const msLeft = vipExpiryDate - now();
  if (msLeft <= 0) {
    wrap.innerHTML = `<div class="cd-unit"><b>0</b><span>Expired</span></div>`;
    return;
  }
  const totalSeconds = Math.floor(msLeft / 1000);
  const days    = Math.floor(totalSeconds / 86400);
  const hours   = Math.floor((totalSeconds % 86400) / 3600);
  const mins    = Math.floor((totalSeconds % 3600) / 60);
  const secs    = totalSeconds % 60;

  wrap.innerHTML = `
    <div class="cd-unit"><b>${days}</b><span>Days</span></div>
    <span class="cd-sep">:</span>
    <div class="cd-unit"><b>${String(hours).padStart(2,"0")}</b><span>Hrs</span></div>
    <span class="cd-sep">:</span>
    <div class="cd-unit"><b>${String(mins).padStart(2,"0")}</b><span>Min</span></div>
    <span class="cd-sep">:</span>
    <div class="cd-unit"><b>${String(secs).padStart(2,"0")}</b><span>Sec</span></div>`;
  wrap.classList.toggle("urgent", days < 1);
}

function getVipTier(daysRemaining) {
  if (daysRemaining >= 90) return { cls: "diamond", icon: "💎", label: "DIAMOND" };
  if (daysRemaining >= 30) return { cls: "gold",    icon: "🥇", label: "GOLD" };
  if (daysRemaining >= 7)  return { cls: "silver",  icon: "🥈", label: "SILVER" };
  return { cls: "bronze", icon: "🥉", label: "BRONZE" };
}

function buildVipCard(html) {
  document.getElementById("vipRequestCard")?.remove();
  const card = document.createElement("div");
  card.id = "vipRequestCard";
  card.style.cssText = "max-width:520px;margin:0 auto 20px;";
  card.innerHTML = html;
  document.getElementById("vipBox").appendChild(card);
}

function clearStoredCode() {
  localStorage.removeItem("vipCode");
  localStorage.removeItem("vipWasUnlocked");
  currentVipCode = null;
}

function subscribeToCode(code) {
  if (codeUnsub) codeUnsub();
  const q = query(collection(db, "vip_codes"), where("code", "==", code), limit(1));
  codeUnsub = onSnapshot(q, snap => {
    vipUnlocked   = false;
    vipExpiryDate = null;
    if (autoLogoutTimer)   clearTimeout(autoLogoutTimer);
    if (countdownInterval) clearInterval(countdownInterval);
    document.getElementById("vipRequestCard")?.remove();

    if (snap.empty) {
      clearStoredCode();
      document.getElementById("authBox").style.display = "block";
      document.getElementById("vipCtaBanner").style.display = "flex";
      return;
    }

    const data = snap.docs[0].data();
    const n    = now();
    const exp  = data.expiry ? new Date(data.expiry + "T23:59:59") : null;
    const myId = getVisitorId();

    if (data.redeemedBy && data.redeemedBy !== myId) {
      clearStoredCode();
      document.getElementById("authBox").style.display = "block";
      document.getElementById("vipCtaBanner").style.display = "flex";
      showPopup("This code is now active on another device ❌");
      window.dispatchEvent(new Event("vip-status-changed"));
      return;
    }

    if (data.active && exp && n <= exp) {
      vipUnlocked   = true;
      vipExpiryDate = exp;

      scheduleAutoLogout(exp);
      document.getElementById("authBox").style.display = "none";
      document.getElementById("vipCtaBanner").style.display = "none";

      if (!localStorage.getItem("vipWasUnlocked")) {
        localStorage.setItem("vipWasUnlocked", "1");
        setTimeout(() => { showToast("🎉 VIP tips unlocked!"); }, 500);
        addNotification("VIP access activated! Enjoy premium predictions.", "💎");
        markVisitorVipUnlocked();
      }

      buildVipCard(`
        <div class="vip-status-active">
          <div class="vip-status-left">
            <span class="vip-crown">👑</span>
            <div>
              <div class="vip-status-title">VIP ACTIVE</div>
              <div class="vip-expiry">Expires ${data.expiry}</div>
            </div>
          </div>
          <div class="vip-countdown-live" id="vipCountdownWrap"></div>
        </div>
      `);

      startCountdownDisplay();
      window.dispatchEvent(new Event("vip-status-changed"));
    } else {
      const wasStored = currentVipCode === code;
      clearStoredCode();
      document.getElementById("authBox").style.display = "block";
      document.getElementById("vipCtaBanner").style.display = "flex";
      if (wasStored) {
        showPopup(!data.active ? "This VIP code has been disabled ❌" : "This VIP code has expired ⏰");
      }
      window.dispatchEvent(new Event("vip-status-changed"));
    }
  });
}

function initVipCode() {
  if (currentVipCode) {
    subscribeToCode(currentVipCode);
  } else {
    document.getElementById("authBox").style.display = "block";
    document.getElementById("vipCtaBanner").style.display = "flex";
  }
}

window.unlockVipCode = async function() {
  const input = document.getElementById("vipCodeInput");
  const msgEl = document.getElementById("codeMsg");
  const btn   = document.getElementById("authBtn");
  const code  = input.value.trim().toUpperCase();

  if (!code) {
    msgEl.style.color = "var(--coral)";
    msgEl.innerText = "Please enter a VIP code first";
    return;
  }

  btn.disabled = true; btn.innerText = "CHECKING…";
  msgEl.style.color = "var(--slate)";
  msgEl.innerText = "";

  try {
    const q = query(collection(db, "vip_codes"), where("code", "==", code), limit(1));
    const snap = await getDocs(q);

    if (snap.empty) {
      msgEl.style.color = "var(--coral)";
      msgEl.innerText = "Invalid code ❌";
    } else {
      const codeDoc = snap.docs[0];
      const data    = codeDoc.data();
      const n       = now();
      const exp     = data.expiry ? new Date(data.expiry + "T23:59:59") : null;
      const myId    = getVisitorId();

      if (!data.active) {
        msgEl.style.color = "var(--coral)";
        msgEl.innerText = "This code has been disabled ❌";
      } else if (!exp || n > exp) {
        msgEl.style.color = "var(--coral)";
        msgEl.innerText = "This code has expired ⏰";
      } else if (data.redeemedBy && data.redeemedBy !== myId) {
        msgEl.style.color = "var(--coral)";
        msgEl.innerText = "This code is already in use on another device ❌";
      } else {
        try {
          if (!data.redeemedBy) {
            await updateDoc(codeDoc.ref, { redeemedBy: myId, redeemedAt: n.toISOString() });
          }
          localStorage.setItem("vipCode", code);
          currentVipCode = code;
          msgEl.style.color = "var(--pitch)";
          msgEl.innerText = "Code accepted ✅ Unlocking…";
          subscribeToCode(code);
        } catch (claimErr) {
          console.error("claim failed:", claimErr.code, claimErr.message);
          msgEl.style.color = "var(--coral)";
          msgEl.innerText = "This code has already been claimed ❌";
        }
      }
    }
  } catch (e) {
    console.error("unlockVipCode failed:", e.code, e.message);
    msgEl.style.color = "var(--coral)";
    msgEl.innerText = "Error: " + (e.message || "please try again");
  }

  btn.disabled = false; btn.innerText = "UNLOCK VIP";
};

window.pasteVipCode = async function() {
  const input = document.getElementById("vipCodeInput");
  const msgEl = document.getElementById("codeMsg");
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      input.value = text.trim().toUpperCase();
      input.focus();
      navigator.vibrate?.([10]);
    } else {
      msgEl.style.color = "var(--slate)";
      msgEl.innerText = "Clipboard is empty";
    }
  } catch (e) {
    msgEl.style.color = "var(--coral)";
    msgEl.innerText = "Couldn't read clipboard — long-press the field and choose Paste instead";
    input.focus();
  }
};

window.goWhatsAppBlocked = function() {
  const msg = `Hello 👋\n\nI've been blocked from accessing the BM SURESCORE app. Please help me check my account.`;
  window.open(`https://wa.me/255617123799?text=${encodeURIComponent(msg)}`, "_blank");
};

window.goWhatsApp = function() {
  let msg;
  if (selectedPlan) {
    msg = `Hello 👋\n\nI would like to buy a VIP code 💎 for BM SURESCORE.\n\nPlan selected: ${selectedPlan.label} — Tsh ${selectedPlan.price}\n\nPlease send me payment instructions.`;
  } else {
    msg = `Hello 👋\n\nI would like to get a VIP code 💎 for BM SURESCORE.\n\nPlease send me access.`;
  }
  window.open(`https://wa.me/255617123799?text=${encodeURIComponent(msg)}`, "_blank");
};

function humanizeTip(tip, m) {
  if (!tip) return tip;
  const teams = splitTeams(m.match);
  const home = teams ? teams.home : "Home";
  const away = teams ? teams.away : "Away";
  const t = tip.toUpperCase().trim();
  if (t.includes(" & ")) {
    return t.split(" & ").map(leg => humanizeSingle(leg.trim(), home, away)).join(" & ");
  }
  return humanizeSingle(t, home, away);
}

function humanizeSingle(tRaw, home, away) {
  let t = tRaw;
  let prefix = "";
  if (t.startsWith("HT ") || t.startsWith("1H ")) {
    prefix = "1st Half: ";
    t = t.replace(/^(HT|1H)\s+/, "");
  }

  const htft = t.match(/^(1|X|2)\s*\/\s*(1|X|2)$/);
  if (htft) {
    const map = { "1": home, "X": "Draw", "2": away };
    return `HT/FT: ${map[htft[1]]} / ${map[htft[2]]}`;
  }

  if (t === "1" || t === "HOME") return prefix + `${home} Wins`;
  if (t === "2" || t === "AWAY") return prefix + `${away} Wins`;
  if (t === "X" || t === "DRAW") return prefix + "Draw";
  if (t === "1X") return prefix + `Double Chance (${home} or Draw)`;
  if (t === "X2") return prefix + `Double Chance (${away} or Draw)`;
  if (t === "12") return prefix + `Double Chance (${home} or ${away})`;
  if (t === "DNB HOME") return prefix + `${home} Wins (Draw No Bet)`;
  if (t === "DNB AWAY") return prefix + `${away} Wins (Draw No Bet)`;

  if (t.includes("BTTS") || t.includes("BOTH")) {
    if (t.includes("YES")) return prefix + "Both Teams to Score - Yes";
    if (t.includes("NO"))  return prefix + "Both Teams to Score - No";
  }

  if (t.includes("QUALIFY")) {
    return prefix + (t.includes("HOME") ? `${home} to Qualify` : `${away} to Qualify`);
  }

  if (t.includes("WIN EITHER HALF")) {
    return prefix + (t.includes("HOME") ? `${home} Wins Either Half` : `${away} Wins Either Half`);
  }

  if (t.includes("HOME OVER"))  return prefix + `${home} Over ${t.split(" ").pop()} Goals`;
  if (t.includes("AWAY OVER"))  return prefix + `${away} Over ${t.split(" ").pop()} Goals`;
  if (t.includes("HOME UNDER")) return prefix + `${home} Under ${t.split(" ").pop()} Goals`;
  if (t.includes("AWAY UNDER")) return prefix + `${away} Under ${t.split(" ").pop()} Goals`;

  if (t.includes("GOALS") && /\d+\s*-\s*\d+/.test(t)) {
    const r = t.match(/(\d+)\s*-\s*(\d+)/);
    if (t.includes("HOME")) return prefix + `${home} Goals ${r[1]}-${r[2]}`;
    if (t.includes("AWAY")) return prefix + `${away} Goals ${r[1]}-${r[2]}`;
    return prefix + `Total Goals ${r[1]}-${r[2]}`;
  }

  if (t.includes("OVER"))  return prefix + `Over ${t.split(" ").pop()} Goals`;
  if (t.includes("UNDER")) return prefix + `Under ${t.split(" ").pop()} Goals`;
  if (t === "ODD")  return prefix + "Total Goals - Odd";
  if (t === "EVEN") return prefix + "Total Goals - Even";
  if (t === "HOME CLEAN SHEET") return prefix + `${home} Clean Sheet`;
  if (t === "AWAY CLEAN SHEET") return prefix + `${away} Clean Sheet`;
  if (t === "HOME WIN TO NIL") return prefix + `${home} Wins to Nil`;
  if (t === "AWAY WIN TO NIL") return prefix + `${away} Wins to Nil`;

  if (t.includes("AH")) {
    const line = t.split(" ").pop();
    return prefix + (t.includes("AWAY") ? `${away} Handicap (${line})` : `${home} Handicap (${line})`);
  }

  if (/^\d+-\d+$/.test(t)) return prefix + `Correct Score ${t}`;

  return prefix + tRaw;
}

function getHalves(m) {
  let h1 = null, h2 = null;
  if (m.ht && m.ht.includes("-")) {
    const [hh, ha] = m.ht.split("-").map(Number);
    if (!isNaN(hh) && !isNaN(ha)) h1 = { home: hh, away: ha };
  }
  if (h1 && m.ft && m.ft.includes("-")) {
    const [fh, fa] = m.ft.split("-").map(Number);
    if (!isNaN(fh) && !isNaN(fa) && fh >= h1.home && fa >= h1.away) {
      h2 = { home: fh - h1.home, away: fa - h1.away };
    }
  }
  return { h1, h2 };
}

function evalAtomic(tip, home, away) {
  const total = home + away;

  if (tip === "HOME" || tip === "1") return home > away ? "win" : "lost";
  if (tip === "AWAY" || tip === "2") return away > home ? "win" : "lost";
  if (tip === "DRAW" || tip === "X") return home === away ? "win" : "lost";
  if (tip === "1X") return home >= away ? "win" : "lost";
  if (tip === "X2") return away >= home ? "win" : "lost";
  if (tip === "12") return home !== away ? "win" : "lost";
  if (tip === "DNB HOME") return home > away ? "win" : home === away ? "pending" : "lost";
  if (tip === "DNB AWAY") return away > home ? "win" : home === away ? "pending" : "lost";
  if (tip.includes("BTTS") || tip.includes("BOTH")) {
    const both = home > 0 && away > 0;
    if (tip.includes("YES")) return both ? "win" : "lost";
    if (tip.includes("NO"))  return !both ? "win" : "lost";
  }
  if (tip.includes("HOME OVER"))  return home > parseFloat(tip.split(" ").pop()) ? "win" : "lost";
  if (tip.includes("AWAY OVER"))  return away > parseFloat(tip.split(" ").pop()) ? "win" : "lost";
  if (tip.includes("HOME UNDER")) return home < parseFloat(tip.split(" ").pop()) ? "win" : "lost";
  if (tip.includes("AWAY UNDER")) return away < parseFloat(tip.split(" ").pop()) ? "win" : "lost";

  if (tip.includes("GOALS") && /\d+\s*-\s*\d+/.test(tip)) {
    const rangeMatch = tip.match(/(\d+)\s*-\s*(\d+)/);
    const lo = Number(rangeMatch[1]);
    const hi = Number(rangeMatch[2]);
    if (isNaN(lo) || isNaN(hi)) return "pending";
    if (tip.includes("HOME")) return (home >= lo && home <= hi) ? "win" : "lost";
    if (tip.includes("AWAY")) return (away >= lo && away <= hi) ? "win" : "lost";
    return (total >= lo && total <= hi) ? "win" : "lost";
  }

  if (tip.includes("OVER"))  return total > parseFloat(tip.split(" ").pop()) ? "win" : "lost";
  if (tip.includes("UNDER")) return total < parseFloat(tip.split(" ").pop()) ? "win" : "lost";
  if (tip === "ODD")  return total % 2 === 1 ? "win" : "lost";
  if (tip === "EVEN") return total % 2 === 0 ? "win" : "lost";
  if (tip === "HOME CLEAN SHEET") return away === 0 ? "win" : "lost";
  if (tip === "AWAY CLEAN SHEET") return home === 0 ? "win" : "lost";
  if (tip === "HOME WIN TO NIL") return (home > away && away === 0) ? "win" : "lost";
  if (tip === "AWAY WIN TO NIL") return (away > home && home === 0) ? "win" : "lost";
  if (tip.includes("AH")) {
    const line = parseFloat(tip.split(" ").pop());
    if (isNaN(line)) return "pending";
    const diff = tip.includes("AWAY") ? (away - home) : (home - away);
    const adj = diff + line;
    return adj > 0 ? "win" : adj === 0 ? "pending" : "lost";
  }
  if (/^\d+-\d+$/.test(tip)) return tip === `${home}-${away}` ? "win" : "lost";
  return null;
}

function combineStatuses(list) {
  if (list.some(s => s === "lost")) return "lost";
  if (list.some(s => s === "pending" || s === null)) return "pending";
  return "win";
}

function getStatus(m) {
  if (!m.ft || m.ft === "???" || !m.ft.includes("-")) return "pending";
  const [home, away] = m.ft.split("-").map(Number);
  if (isNaN(home) || isNaN(away)) return "pending";
  const tip = m.tip.toUpperCase().trim();
  const { h1, h2 } = getHalves(m);
  const ftCode = home > away ? "1" : home < away ? "2" : "X";

  if (m.tipType === "htft" || /(^|:)\s*(1|X|2)\s*\/\s*(1|X|2)\s*$/.test(tip)) {
    if (!h1) return "pending";
    const htCode = h1.home > h1.away ? "1" : h1.home < h1.away ? "2" : "X";
    const match = tip.match(/(1|X|2)\s*\/\s*(1|X|2)\s*$/);
    return match ? ((htCode === match[1] && ftCode === match[2]) ? "win" : "lost") : "pending";
  }

  if (tip.includes("QUALIFY")) {
    if (!m.qualified) return "pending";
    const wantHome = tip.includes("HOME");
    return (m.qualified.toUpperCase() === (wantHome ? "HOME" : "AWAY")) ? "win" : "lost";
  }

  if (tip.includes("WIN EITHER HALF")) {
    if (!h1 || !h2) return "pending";
    const isHome = tip.includes("HOME");
    const wonH1 = isHome ? h1.home > h1.away : h1.away > h1.home;
    const wonH2 = isHome ? h2.home > h2.away : h2.away > h2.home;
    return (wonH1 || wonH2) ? "win" : "lost";
  }

  if (m.tipType === "corners") {
    const corners = Number(m.corners) || 0;
    const parts = tip.split(" ");
    const line = parseFloat(parts[parts.length - 1]);
    if (isNaN(line)) return "pending";
    if (tip.includes("OVER"))  return corners > line ? "win" : "lost";
    if (tip.includes("UNDER")) return corners < line ? "win" : "lost";
    return "pending";
  }

  if (tip.startsWith("HT ") || tip.startsWith("1H ")) {
    if (!h1) return "pending";
    const inner = tip.replace(/^(HT|1H)\s+/, "");
    return evalAtomic(inner, h1.home, h1.away) ?? "lost";
  }

  if (tip.includes(" & ")) {
    const legs = tip.split(" & ").map(s => s.trim());
    const results = legs.map(leg => {
      if (leg.startsWith("HT ") || leg.startsWith("1H ")) {
        if (!h1) return "pending";
        return evalAtomic(leg.replace(/^(HT|1H)\s+/, ""), h1.home, h1.away) ?? "lost";
      }
      return evalAtomic(leg.replace(/^DC\s+/, ""), home, away) ?? "lost";
    });
    return combineStatuses(results);
  }

  return evalAtomic(tip, home, away) ?? "lost";
}

function getCountdownLabel(matchTime) {
  const diff = matchTime - now();
  if (diff > 0) {
    const hrs  = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    return `⏳ ${hrs}h ${mins}m`;
  }
  return "Kick-off";
}

function buildMatchTime(dateStr, timeStr) {
  const [d, mo, y] = dateStr.split(".");
  return new Date(`${y}-${mo}-${d}T${timeStr || "00:00"}`);
}

function splitTeams(matchStr) {
  if (!matchStr) return null;
  const seps = [" vs ", " VS ", " v ", " - ", " – "];
  for (const sep of seps) {
    if (matchStr.includes(sep)) {
      const [home, away] = matchStr.split(sep);
      if (home && away) return { home: home.trim(), away: away.trim() };
    }
  }
  return null;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function buildLeagueLabel(m) {
  const league = (m.league && String(m.league).trim()) ? String(m.league).trim() : "";
  return league;
}

function buildLeagueHeader(league, timeLabel, status) {
  const lostFlag = status === "lost" ? '<span class="lost-flag">● Lost</span>' : "";
  return `
    <div class="league-header">
      <span class="league-name">🏆 ${escapeHtml(league)}</span>
      <span class="league-meta">${lostFlag}<span class="league-time">🕐 ${escapeHtml(timeLabel)}</span></span>
    </div>`;
}

function buildVipHeader(timeLabel, status) {
  const lostFlag = status === "lost" ? '<span class="lost-flag">● Lost</span>' : "";
  return `
    <div class="league-header vip-time-only">
      <span class="vtb"><span class="vtb-crown">👑</span>VIP MATCH<span class="vtb-time">🕐 ${escapeHtml(timeLabel)}</span></span>
      ${lostFlag}
    </div>`;
}

function buildStatusBadge(status, locked, countdown) {
  if (locked)               return `<span class="badge locked">🔒 VIP</span>`;
  if (status === "win")     return `<span class="badge win">✅ WON</span>`;
  if (status === "lost")    return `<span class="badge lost">❌ LOST</span>`;
  return `<span class="badge pending match-countdown">${countdown}</span>`;
}

function buildTipNote(m) {
  if (m.tipType === "corners" && m.corners) return `<span class="corners-note">🚩 corners: ${escapeHtml(m.corners)}</span>`;
  if (m.ht && (m.tipType === "htft" || /HT|1H|\//.test((m.tip||"").toUpperCase()))) {
    return `<span class="corners-note">⏱ HT: ${escapeHtml(m.ht)}</span>`;
  }
  return "";
}

function buildStatusIcon(status) {
  if (status === "win")  return `<span class="status-icon win">✓</span>`;
  if (status === "lost") return `<span class="status-icon lost">✗</span>`;
  return `<span class="status-icon pending">📅</span>`;
}

function buildRow(m, matchTime, isFree) {
  const status    = getStatus(m);
  const countdown = getCountdownLabel(matchTime);
  const oddVal    = parseFloat(m.odd) || 1;
  const locked    = !isFree && !vipUnlocked;

  const tipClass = isFree ? "free" : "vip-lock";
  let tipHTML, oddHTML;

  if (locked) {
    tipHTML = `<span class="tip-label vip-premium">🔒 Premium Tip</span>`;
    oddHTML = `<span class="odd-badge dim">•••</span>`;
  } else {
    tipHTML = `<span class="tip-label ${tipClass}">${escapeHtml(humanizeTip(m.tip, m))}</span>${buildTipNote(m)}`;
    oddHTML = `<span class="odd-badge">${escapeHtml(m.odd)}</span>`;
  }

  let teamsHTML;
  const teams = splitTeams(m.match);
  if (locked) {
    teamsHTML = `
      <div class="locked-teams-wrap">
        <div class="lock-badge">🔒 UNLOCK TO REVEAL</div>
      </div>`;
  } else if (teams) {
    const hasFt = m.ft && m.ft !== "???" && m.ft.includes("-");
    const scoreHTML = hasFt
      ? `<span class="score-pair"><span class="score-digits ${status === 'win' ? 'win' : status === 'lost' ? 'lost' : ''}">${escapeHtml(m.ft.split("-")[0])}</span>${buildStatusIcon(status)}<span class="score-digits ${status === 'win' ? 'win' : status === 'lost' ? 'lost' : ''}">${escapeHtml(m.ft.split("-")[1])}</span></span>`
      : `<span class="match-vs">VS</span>`;
    teamsHTML = `
      <div class="match-teams">
        <span class="match-team home">${escapeHtml(teams.home)}</span>
        ${scoreHTML}
        <span class="match-team away">${escapeHtml(teams.away)}</span>
      </div>`;
  } else {
    const ftSuffix = (m.ft && m.ft !== "???" && m.ft.includes("-")) ? ` <span style="opacity:.5;font-family:'JetBrains Mono',monospace;">(${escapeHtml(m.ft)})</span>` : "";
    teamsHTML = `<div class="match-single-name">${escapeHtml(m.match)}${ftSuffix}</div>`;
  }

  const cardStateClass = locked ? "" : status === "win" ? "is-win" : status === "lost" ? "is-lost" : "";

  return {
    html: `
    <div class="match-card ${cardStateClass}${locked ? ' is-locked' : ''}" data-mtime="${matchTime.getTime()}" data-status="${locked ? 'locked' : status}">
      <div class="match-body">
        ${teamsHTML}
      </div>
      <div class="match-tip-bar">
        <div>${tipHTML}</div>
        ${oddHTML}
      </div>
    </div>`,
    status,
    oddVal
  };
}

let latestFreeMatches = [];
let latestVipMatches  = [];
let freeLoaded = false;
let vipLoaded  = false;

function updateTicker(rows, globalStreak) {
  const track = document.getElementById("tickerTrack");
  const wins  = rows.filter(r => getStatus(r.m) === "win").length;
  const total = rows.filter(r => getStatus(r.m) !== "pending").length;
  const pending = rows.length - total;
  const parts = [
    `<span>●</span>&nbsp;LIVE FORM ${date || ""}`,
    `<b>${wins}</b> WINS TODAY`,
    `<b>${globalStreak}</b> STREAK`,
    `${pending} MATCHES PENDING`,
    `<b>BM SURESCORE</b> · PROFESSIONAL FOOTBALL PREDICTIONS`
  ];
  track.innerHTML = parts.join("&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;").repeat(2);
}

function renderGroupedByLeague(builtRows, isVip) {
  if (builtRows.length === 0) return "";
  return builtRows.map(row => {
    const timeLabel = row.m.time || "--:--";
    if (isVip) {
      if (vipUnlocked) {
        const league = buildLeagueLabel(row.m) || "OTHER MATCHES";
        return `
          <div class="league-group">
            ${buildLeagueHeader(league, timeLabel, row.status)}
            <div class="match-list">${row.styledHtml}</div>
          </div>`;
      }
      return `
        <div class="league-group">
          ${buildVipHeader(timeLabel, row.status)}
          <div class="match-list">${row.styledHtml}</div>
        </div>`;
    }
    const league = buildLeagueLabel(row.m) || "OTHER MATCHES";
    return `
      <div class="league-group">
        ${buildLeagueHeader(league, timeLabel, row.status)}
        <div class="match-list">${row.styledHtml}</div>
      </div>`;
  }).join("");
}

function processTodayMatches() {
  if (!freeLoaded || !vipLoaded) return;
  trySplashHide();

  const rows = [...latestFreeMatches, ...latestVipMatches].map(m => ({
    m,
    matchTime: buildMatchTime(m.date, m.time)
  }));

  rows.forEach(({ m, matchTime }) => {
    const diff = matchTime - now();
    if (diff > 0 && diff <= 600000) {
      const isVipOnly = (m.type || "vip") !== "free";
      if (!isVipOnly || vipUnlocked) {
        const key = m.match + m.time;
        if (!notifiedMatches[key]) {
          notifiedMatches[key] = true;
          localStorage.setItem("notifiedMatches", JSON.stringify(notifiedMatches));
          showPopup(`⏰ Starting soon:\n${m.match}`);
          addNotification(`${m.match} starts in ~10 minutes`, "⏰");
        }
      }
    }
  });

  rows.sort((a, b) => a.matchTime - b.matchTime);

  let stats = { winF:0, lostF:0, pendingF:0, oddsF:1, winV:0, lostV:0, pendingV:0, oddsV:1 };
  let freeStreakCount = 0, vipStreakCount = 0;
  let prevFreeWin = true, prevVipWin = true;
  const freeBuilt = [], vipBuilt = [];

  rows.forEach(({ m, matchTime }, idx) => {
    const isFree = (m.type || "vip") === "free";
    const { html, status, oddVal } = buildRow(m, matchTime, isFree);

    if (!isFree && vipUnlocked) {
      const key = "result_" + m.match + m.time;
      if (status !== "pending" && !notifiedMatches[key]) {
        notifiedMatches[key] = true;
        localStorage.setItem("notifiedMatches", JSON.stringify(notifiedMatches));
        if (status === "win")  addNotification(`WIN ✅ ${m.match}`, "✅");
        if (status === "lost") addNotification(`LOST ❌ ${m.match}`, "❌");
      }
    }

    const styledHtml = html.replace('class="match-card', `style="--i:${idx}" class="match-card`);

    if (isFree) {
      freeBuilt.push({ m, styledHtml, status });
      if (status === "win")       { stats.winF++; stats.oddsF *= oddVal; if(prevFreeWin) freeStreakCount++; prevFreeWin=true; }
      else if (status === "lost") { stats.lostF++; prevFreeWin=false; freeStreakCount=0; }
      else                        { stats.pendingF++; stats.oddsF *= oddVal; }
    } else {
      vipBuilt.push({ m, styledHtml, status });
      if (status === "win")       { stats.winV++; stats.oddsV *= oddVal; if(prevVipWin) vipStreakCount++; prevVipWin=true; }
      else if (status === "lost") { stats.lostV++; prevVipWin=false; vipStreakCount=0; }
      else                        { stats.pendingV++; stats.oddsV *= oddVal; }
    }
  });

  const fTotal = stats.winF + stats.lostF + stats.pendingF;
  const vTotal = stats.winV + stats.lostV + stats.pendingV;

  swapSkeletonForContent(document.getElementById("freeSkeletonRows"));
  swapSkeletonForContent(document.getElementById("vipSkeletonRows"));

  const freeDataEl  = document.getElementById("freeData");
  const vipDataEl   = document.getElementById("vipData");
  const emptyFreeEl = document.getElementById("emptyFree");
  const emptyVipEl  = document.getElementById("emptyVip");

  freeDataEl.innerHTML = renderGroupedByLeague(freeBuilt, false);
  vipDataEl.innerHTML  = renderGroupedByLeague(vipBuilt, true);

  if (fTotal > 0) {
    freeDataEl.style.display = "";
    freeDataEl.classList.add("fade-in-block");
    emptyFreeEl.classList.add("hidden");
    document.getElementById("summaryFree").style.display = "";
    document.getElementById("summaryFree").classList.add("fade-in-block");
  } else {
    freeDataEl.style.display = "none";
    emptyFreeEl.classList.remove("hidden");
    emptyFreeEl.classList.add("fade-in-block");
    document.getElementById("summaryFree").style.display = "none";
  }
  if (vTotal > 0) {
    vipDataEl.style.display = "";
    vipDataEl.classList.add("fade-in-block");
    emptyVipEl.classList.add("hidden");
    document.getElementById("summaryVip").style.display = "";
    document.getElementById("summaryVip").classList.add("fade-in-block");
  } else {
    vipDataEl.style.display = "none";
    emptyVipEl.classList.remove("hidden");
    emptyVipEl.classList.add("fade-in-block");
    document.getElementById("summaryVip").style.display = "none";
  }

  const fDone = stats.winF + stats.lostF;
  const vDone = stats.winV + stats.lostV;
  const fRate = fDone > 0 ? Math.round((stats.winF / fDone) * 100) : 0;
  const vRate = vDone > 0 ? Math.round((stats.winV / vDone) * 100) : 0;

  document.getElementById("sWinF").innerText  = stats.winF;
  document.getElementById("sLostF").innerText = stats.lostF;
  document.getElementById("sRateF").innerText = fRate + "%";
  document.getElementById("sOddsF").innerText = (fTotal > 0 ? stats.oddsF : 0).toFixed(2);
  document.getElementById("sProgLabelF").innerText = `${stats.winF} / ${fDone}`;
  setTimeout(() => { document.getElementById("sProgBarF").style.width = fRate + "%"; }, 300);

  document.getElementById("sWinV").innerText  = stats.winV;
  document.getElementById("sLostV").innerText = stats.lostV;
  document.getElementById("sRateV").innerText = vRate + "%";
  document.getElementById("sOddsV").innerText = (vTotal > 0 ? stats.oddsV : 0).toFixed(2);
  document.getElementById("sProgLabelV").innerText = `${stats.winV} / ${vDone}`;
  setTimeout(() => { document.getElementById("sProgBarV").style.width = vRate + "%"; }, 300);

  const globalStreak = Math.max(freeStreakCount, vipStreakCount);
  updateTicker(rows, globalStreak);

  document.getElementById("freeStreakBar").style.display = freeStreakCount > 0 ? "flex" : "none";
  if (freeStreakCount > 0) {
    document.getElementById("freeStreakNum").innerText = freeStreakCount;
    document.getElementById("freeStreakSub").innerText = `${freeStreakCount} consecutive win${freeStreakCount>1?'s':''} today`;
  }
  document.getElementById("vipStreakBar").style.display = vipStreakCount > 0 ? "flex" : "none";
  if (vipStreakCount > 0) {
    document.getElementById("vipStreakNum").innerText = vipStreakCount;
    document.getElementById("vipStreakSub").innerText = `${vipStreakCount} consecutive win${vipStreakCount>1?'s':''} today`;
  }

  updateVipCtaBanner(vTotal);
}

function updateVipCtaBanner(vTotal) {
  const banner = document.getElementById("vipCtaBanner");
  const sub    = document.getElementById("vipCtaSub");
  if (!banner) return;
  if (vipUnlocked) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  if (sub) {
    sub.innerText = vTotal > 0
      ? `${vTotal} premium predictions available — tap to unlock`
      : `Tap to View Pricing`;
  }
}

window.scrollToVipAuth = function() {
  document.getElementById("vipBox")?.scrollIntoView({ behavior: "smooth", block: "start" });
  navigator.vibrate?.([10]);
};

function startFreeMatchesListener() {
  const todayFreeQuery = query(collection(db, "matches_free"), where("date", "==", date));
  onSnapshot(todayFreeQuery, snapshot => {
    latestFreeMatches = [];
    snapshot.forEach(docSnap => latestFreeMatches.push({ ...docSnap.data(), type: "free" }));
    freeLoaded = true;
    processTodayMatches();
  });
}

function startVipMatchesListener() {
  const todayVipQuery = query(collection(db, "matches_vip"), where("date", "==", date));
  onSnapshot(todayVipQuery, snapshot => {
    latestVipMatches = [];
    snapshot.forEach(docSnap => latestVipMatches.push({ ...docSnap.data(), type: "vip" }));
    vipLoaded = true;
    processTodayMatches();
  });
}

window.addEventListener("vip-status-changed", () => processTodayMatches());

let latestFreeAll = null;
let latestVipAll  = null;

let freeHistGroups = {}, vipHistGroups = {};
let freeHistDates  = [], vipHistDates  = [];
let freeHistPage   = 0,  vipHistPage   = 0;

function isPastDate(dStr) {
  const [d, mo, y] = dStr.split(".").map(Number);
  const matchDay = new Date(y, mo - 1, d);
  const n = now();
  const todayDay = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return matchDay < todayDay;
}

function sortDatesDesc(groups) {
  const toISO = d => d.split(".").reverse().join("-");
  return Object.keys(groups).sort((a, b) => new Date(toISO(b)) - new Date(toISO(a)));
}

function buildHistoryCard(m, isFree) {
  const status = getStatus(m);
  const tipClass = isFree ? "free" : "vip-lock";
  const teams = splitTeams(m.match);
  const hasFt = m.ft && m.ft !== "???" && m.ft.includes("-");

  let teamsHTML;
  if (teams) {
    const scoreHTML = hasFt
      ? `<span class="score-pair"><span class="score-digits ${status === 'win' ? 'win' : status === 'lost' ? 'lost' : ''}">${escapeHtml(m.ft.split("-")[0])}</span>${buildStatusIcon(status)}<span class="score-digits ${status === 'win' ? 'win' : status === 'lost' ? 'lost' : ''}">${escapeHtml(m.ft.split("-")[1])}</span></span>`
      : `<span class="match-vs">VS</span>`;
    teamsHTML = `
      <div class="match-teams">
        <span class="match-team home">${escapeHtml(teams.home)}</span>
        ${scoreHTML}
        <span class="match-team away">${escapeHtml(teams.away)}</span>
      </div>`;
  } else {
    const ftSuffix = hasFt ? ` <span style="opacity:.5;font-family:'JetBrains Mono',monospace;">(${escapeHtml(m.ft)})</span>` : "";
    teamsHTML = `<div class="match-single-name">${escapeHtml(m.match)}${ftSuffix}</div>`;
  }

  const badge = status === "win" ? `<span class="badge win">✅ WON</span>`
    : status === "lost" ? `<span class="badge lost">❌ LOST</span>`
    : `<span class="badge pending">⏳ PENDING</span>`;

  return `
    <div class="match-card ${status === 'win' ? 'is-win' : status === 'lost' ? 'is-lost' : ''}">
      <div class="match-body">${teamsHTML}</div>
      <div class="match-tip-bar">
        <div>
          <span class="tip-label ${tipClass}">${escapeHtml(humanizeTip(m.tip, m))}</span>
          ${buildTipNote(m)}
        </div>
        <span class="odd-badge">${escapeHtml(m.odd)}</span>
      </div>
    </div>`;
}

function renderHistoryPage(type) {
  const isFree   = type === "free";
  const groups   = isFree ? freeHistGroups : vipHistGroups;
  const dates    = isFree ? freeHistDates  : vipHistDates;
  const pageIdx  = isFree ? freeHistPage   : vipHistPage;
  const targetEl = document.getElementById(isFree ? "historyFree" : "historyVip");

  if (dates.length === 0) {
    renderWithFade(targetEl, '<div class="empty-state"><div class="e-icon">📋</div><h3>No history yet</h3><p>Past results will appear here</p></div>');
    return;
  }

  const clamped = Math.min(Math.max(pageIdx, 0), dates.length - 1);
  if (isFree) freeHistPage = clamped; else vipHistPage = clamped;

  const d = dates[clamped];
  const matches = groups[d];

  const leaguesHTML = matches.map(m => {
    const status = getStatus(m);
    const headerHTML = buildLeagueHeader(buildLeagueLabel(m) || "OTHER MATCHES", m.time || "--:--", status);
    return `
      <div class="league-group">
        ${headerHTML}
        <div class="match-list">${buildHistoryCard(m, isFree)}</div>
      </div>`;
  }).join("");

  renderWithFade(targetEl, `
    <div class="hist-page-label">Page ${clamped + 1} of ${dates.length}</div>
    <div class="date-group">📅 ${d}</div>
    ${leaguesHTML}
    <div class="hist-pager">
      <button class="hist-pager-btn" onclick="changeHistoryPage('${type}', -1)" ${clamped === 0 ? "disabled" : ""}>‹ Prev Page</button>
      <button class="hist-pager-btn" onclick="changeHistoryPage('${type}', 1)" ${clamped === dates.length - 1 ? "disabled" : ""}>Next Page ›</button>
    </div>`);
}

window.changeHistoryPage = function(type, delta) {
  if (type === "free") freeHistPage += delta; else vipHistPage += delta;
  renderHistoryPage(type);
  navigator.vibrate?.([10]);
  document.getElementById(type === "free" ? "historyFreeWrap" : "historyVipWrap")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
};

function processHistory() {
  if (!latestFreeAll || !latestVipAll) return;

  const freeGroups = {}, vipGroups = {};

  latestFreeAll.forEach(docSnap => {
    const m = docSnap.data();
    if (m.date === date) return;
    if (!isPastDate(m.date)) return;
    if (!freeGroups[m.date]) freeGroups[m.date] = [];
    freeGroups[m.date].push(m);
  });

  latestVipAll.forEach(docSnap => {
    const m = docSnap.data();
    if (m.date === date) return;
    if (!isPastDate(m.date)) return;
    if (!vipGroups[m.date]) vipGroups[m.date] = [];
    vipGroups[m.date].push(m);
  });

  freeHistGroups = freeGroups;
  vipHistGroups  = vipGroups;
  freeHistDates  = sortDatesDesc(freeGroups);
  vipHistDates   = sortDatesDesc(vipGroups);

  renderHistoryPage("free");
  renderHistoryPage("vip");
}

function startHistoryListeners() {
  onSnapshot(collection(db, "matches_free"), snapshot => {
    latestFreeAll = snapshot.docs;
    processHistory();
  });
  onSnapshot(collection(db, "matches_vip"), snapshot => {
    latestVipAll = snapshot.docs;
    processHistory();
  });
}

function startCountdownRefresh() {
  setInterval(() => {
    document.querySelectorAll('.match-card[data-status="pending"]').forEach(card => {
      const mtime = Number(card.dataset.mtime);
      if (!mtime) return;
      const badge = card.querySelector(".match-countdown");
      if (badge) badge.innerText = getCountdownLabel(new Date(mtime));
    });
  }, 30000);
}

function renderTrustStrip(stats) {
  const wrap = document.getElementById("trustStrip");
  if (!wrap) return;
  const totalTips = stats.totalTips ?? null;
  const winRate   = stats.winRateAllTime ?? null;
  const vipUsers  = stats.vipUsersActive ?? null;
  if (totalTips == null && winRate == null && vipUsers == null) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "flex";
  wrap.innerHTML = `
    ${totalTips != null ? `<div class="trust-cell"><span class="t-val">${totalTips}+</span><span class="t-lbl">Tips analyzed</span></div>` : ""}
    ${winRate   != null ? `<div class="trust-cell"><span class="t-val">${winRate}%</span><span class="t-lbl">All-time win rate</span></div>` : ""}
    ${vipUsers  != null ? `<div class="trust-cell"><span class="t-val">${vipUsers}+</span><span class="t-lbl">Active VIP members</span></div>` : ""}
  `;
}

function startTrustStatsListener() {
  onSnapshot(doc(db, "_meta", "platformStats"), snap => {
    if (!snap.exists()) { renderTrustStrip({}); return; }
    renderTrustStrip(snap.data());
  }, () => renderTrustStrip({}));
}

async function initApp() {
  await ensureAnonAuth();
  startBlockedWatcher();
  startDeviceResetWatcher();
  await syncServerTime();
  computeDateFromNow();
  startDateRolloverWatcher();
  startFreeMatchesListener();
  startVipMatchesListener();
  startHistoryListeners();
  startCountdownRefresh();
  startTrustStatsListener();
  initVipCode();
  trackVisit();
  startVisitorHeartbeat();
  showIdentityModalIfNeeded();
}
initApp();
