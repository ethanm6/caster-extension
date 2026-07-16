// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

/*
 * Runs in every frame: scans for <video> elements and reports castable
 * (http/https) sources to the background store.
 *
 * The floating-button UI lives in ui.js, injected into the top frame only.
 * Same-extension content scripts share a frame's script scope, so ui.js
 * (always loaded after this file) uses extEnabled, pushVideos() and
 * lastScanSummary directly, and registers onEnabledChange.
 */

let extEnabled = true; // options-page switch; off = no scanning, fab hidden
let enabledReady = null; // storage read, deferred until the first video is found
let lastPushed = "";
let scanTimer = null;
let lastScanSummary = "not scanned yet";
// ui.js (top frame only) sets this to react in the UI when the switch flips.
let onEnabledChange = null;

function collectVideos() {
  const out = [];
  const els = document.querySelectorAll("video");
  const notes = [];
  for (const v of els) {
    let src = v.currentSrc || v.src || "";
    notes.push((src ? src.split(":")[0] : "nosrc") + "/rs" + v.readyState);
    if (!/^https?:/i.test(src)) {
      src = "";
      for (const s of v.querySelectorAll("source")) {
        if (/^https?:/i.test(s.src)) {
          src = s.src;
          break;
        }
      }
    }
    if (!src) continue; // blob:/MSE sources aren't castable; sniffer covers those
    out.push({
      url: src,
      width: v.videoWidth || 0,
      height: v.videoHeight || 0,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      title: document.title || "",
    });
  }
  lastScanSummary =
    els.length + " <video>" + (notes.length ? ": " + notes.join(", ") : "");
  return out;
}

// Most frames never see a video; reading the switch only once one turns up
// spares every ad iframe an async storage round-trip at load.
function ensureEnabled() {
  if (!enabledReady) {
    enabledReady = browser.storage.local
      .get("enabled")
      .then((r) => {
        extEnabled = r.enabled !== false;
        if (!extEnabled && onEnabledChange) onEnabledChange();
      })
      .catch(() => {});
  }
  return enabledReady;
}

function pushVideos() {
  const videos = collectVideos();
  if (!videos.length && !lastPushed) return; // nothing found yet — stay idle
  ensureEnabled().then(() => {
    if (!extEnabled) return;
    const key = JSON.stringify(videos);
    if (key === lastPushed) return;
    lastPushed = key;
    if (videos.length) {
      browser.runtime
        .sendMessage({ type: "dom-videos", videos })
        .catch(() => {});
    }
  });
}

function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    pushVideos();
  }, 500);
}

// Media events don't bubble — capture catches dynamically added players.
for (const ev of ["loadedmetadata", "durationchange", "play"]) {
  document.addEventListener(ev, scheduleScan, true);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  extEnabled = changes.enabled.newValue !== false;
  enabledReady = Promise.resolve(); // current value known; skip the lazy read
  if (extEnabled) {
    lastPushed = ""; // scanning was frozen while off — rescan and re-report
    scheduleScan();
  }
  if (onEnabledChange) onEnabledChange();
});

pushVideos();
