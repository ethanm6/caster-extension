"use strict";

/*
 * Runs in every frame: scans for <video> elements and reports castable
 * (http/https) sources to the background store.
 *
 * The top frame additionally owns the UI: a floating cast button that
 * appears when the page has videos, and a bottom-sheet panel to pick one.
 * Tapping a row navigates to an intent:// URI that launches the Caster app.
 */

const IS_TOP = window.top === window;

// ---------- scanner (all frames) ----------

let lastPushed = "";
let scanTimer = null;
let lastScanSummary = "not scanned yet";

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

function pushVideos() {
  const videos = collectVideos();
  const key = JSON.stringify(videos);
  if (key === lastPushed) return;
  lastPushed = key;
  if (videos.length) {
    browser.runtime.sendMessage({ type: "dom-videos", videos }).catch(() => {});
  }
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
pushVideos();

// ---------- UI (top frame only) ----------

const UI_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, sans-serif; margin: 0; }
.fab {
  position: fixed; z-index: 2147483647;
  width: 52px; height: 52px; border-radius: 50%; border: none; padding: 0;
  background: rgba(63, 81, 181, 0.92); color: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  touch-action: none; user-select: none;
  transform-origin: top left;
}
.fab[hidden] { display: none; }
.fab.snap { transition: left 0.2s ease, top 0.2s ease; }
.fab svg { width: 30px; height: 24px; display: block; }
.badge {
  position: absolute; top: -4px; right: -4px;
  min-width: 20px; height: 20px; border-radius: 10px; padding: 0 5px;
  background: #ff5252; color: #fff;
  font-size: 12px; font-weight: 700; line-height: 20px; text-align: center;
}
.scrim {
  position: fixed; inset: 0; z-index: 2147483646;
  background: rgba(0, 0, 0, 0.4);
}
.panel {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  max-height: 65vh;
  display: flex; flex-direction: column;
  background: #fdfdff; color: #1a1a2e;
  border-radius: 16px 16px 0 0;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.35);
  font-size: 15px;
}
.panel[hidden] { display: none; }
.head {
  flex: none;
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px 8px; font-weight: 600;
}
.list { overflow-y: auto; min-height: 0; }
.close {
  border: none; background: none; color: inherit;
  font-size: 22px; line-height: 1; padding: 4px 10px; cursor: pointer;
}
.info { font-size: 16px; opacity: 0.7; }
.empty { padding: 4px 16px 16px; opacity: 0.7; }
.debug {
  padding: 10px 16px 16px;
  border-top: 1px solid rgba(128, 128, 128, 0.25);
  font-family: monospace; font-size: 11px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all; opacity: 0.75;
}
.row {
  display: block; width: 100%; text-align: left;
  border: none; background: none; color: inherit;
  padding: 12px 16px; cursor: pointer;
  border-top: 1px solid rgba(128, 128, 128, 0.25);
  font-size: 15px;
}
.row:active { background: rgba(63, 81, 181, 0.12); }
.name {
  display: block; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-weight: 500;
}
.meta { display: block; margin-top: 4px; font-size: 12.5px; opacity: 0.75; }
.chip {
  display: inline-block; border-radius: 4px; padding: 1px 6px; margin-right: 8px;
  background: rgba(63, 81, 181, 0.15); color: #3f51b5;
  font-size: 11px; font-weight: 700;
}
@media (prefers-color-scheme: dark) {
  .panel { background: #1e1e2a; color: #ececf4; }
  .chip { background: rgba(159, 168, 218, 0.2); color: #aab4ff; }
}
`;

const CAST_GLYPH = `
<svg viewBox="14 24 80 60" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">
  <path d="M24,30h60c2.2,0 4,1.8 4,4v40c0,2.2 -1.8,4 -4,4H56v-6h26V36H26v8h-6v-10c0,-2.2 1.8,-4 4,-4z"/>
  <path d="M20,72c3.3,0 6,2.7 6,6h-6zM20,62c8.8,0 16,7.2 16,16h-6c0,-5.5 -4.5,-10 -10,-10zM20,52c14.4,0 26,11.6 26,26h-6c0,-11 -9,-20 -20,-20z"/>
</svg>`;

const KIND_LABELS = {
  hls: "HLS",
  dash: "DASH",
  mp4: "MP4",
  mkv: "MKV",
  webm: "WebM",
  mov: "MOV",
  ts: "TS",
  video: "VIDEO",
};

let ui = null;
let videos = [];
let panelOpen = false;
let debugOpen = false;
let debugInfo = null;
let fabCorner = "br"; // "t"/"b" + "l"/"r"

// Fixed positioning anchors to the layout viewport, which can be wider than
// the screen (overflowing pages, pinch zoom) — everything here works in
// visual-viewport space so the UI stays on screen at a constant size.
function viewportBox() {
  const vv = window.visualViewport;
  if (vv) {
    return {
      left: vv.offsetLeft,
      top: vv.offsetTop,
      width: vv.width,
      height: vv.height,
      scale: vv.scale || 1,
    };
  }
  return {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    scale: 1,
  };
}

function applyCorner(fab, animate) {
  const box = viewportBox();
  const s = box.scale;
  fab.style.transform = s === 1 ? "" : "scale(" + 1 / s + ")";
  const w = (fab.offsetWidth || 52) / s;
  const h = (fab.offsetHeight || 52) / s;
  const mx = 16 / s;
  const my = 24 / s;
  const left = fabCorner.includes("l")
    ? box.left + mx
    : box.left + box.width - w - mx;
  const top = fabCorner.includes("t")
    ? box.top + my
    : box.top + box.height - h - my;
  if (animate) {
    fab.classList.add("snap");
    setTimeout(() => fab.classList.remove("snap"), 250);
  }
  fab.style.left = left + "px";
  fab.style.top = top + "px";
}

function placePanel(panel) {
  const box = viewportBox();
  const s = box.scale;
  panel.style.left = box.left + "px";
  panel.style.width = box.width * s + "px";
  panel.style.bottom = window.innerHeight - (box.top + box.height) + "px";
  panel.style.maxHeight = box.height * s * 0.65 + "px";
  panel.style.transformOrigin = "bottom left";
  panel.style.transform = s === 1 ? "" : "scale(" + 1 / s + ")";
}

function repositionUi() {
  if (!ui) return;
  applyCorner(ui.fab, false);
  if (panelOpen) placePanel(ui.panel);
}

function makeDraggable(fab) {
  let pid = null;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  fab.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) return;
    pid = e.pointerId;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const r = fab.getBoundingClientRect();
    startLeft = r.left;
    startTop = r.top;
    try {
      fab.setPointerCapture(pid);
    } catch (err) {
      /* pointer gone already */
    }
  });

  fab.addEventListener("pointermove", (e) => {
    if (pid === null || e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 8) return; // still a tap
    moved = true;
    fab.classList.remove("snap");
    const box = viewportBox();
    const r = fab.getBoundingClientRect();
    const maxL = box.left + box.width - r.width;
    const maxT = box.top + box.height - r.height;
    fab.style.left = Math.min(Math.max(startLeft + dx, box.left), maxL) + "px";
    fab.style.top = Math.min(Math.max(startTop + dy, box.top), maxT) + "px";
  });

  const finish = (e) => {
    if (pid === null || e.pointerId !== pid) return;
    pid = null;
    if (!moved) return;
    const r = fab.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const box = viewportBox();
    fabCorner =
      (cy < box.top + box.height / 2 ? "t" : "b") +
      (cx < box.left + box.width / 2 ? "l" : "r");
    applyCorner(fab, true);
    browser.storage.local.set({ fabCorner }).catch(() => {});
  };
  fab.addEventListener("pointerup", finish);
  fab.addEventListener("pointercancel", finish);

  fab.addEventListener("click", (e) => {
    if (moved) {
      // Tail end of a drag, not a tap.
      e.preventDefault();
      e.stopPropagation();
      moved = false;
      return;
    }
    togglePanel();
  });
}

function ensureUi() {
  if (ui) return ui;

  const host = document.createElement("caster-ext-host");
  const shadow = host.attachShadow({ mode: "closed" });

  // adoptedStyleSheets dodges page CSP on injected inline styles.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(UI_CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    const style = document.createElement("style");
    style.textContent = UI_CSS;
    shadow.appendChild(style);
  }

  const fab = document.createElement("button");
  fab.className = "fab";
  fab.title = "Cast videos on this page";
  fab.innerHTML = CAST_GLYPH;
  fab.hidden = true;
  const badge = document.createElement("span");
  badge.className = "badge";
  fab.appendChild(badge);
  makeDraggable(fab);

  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.hidden = true;
  scrim.addEventListener("click", () => hidePanel());

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.hidden = true;

  const head = document.createElement("div");
  head.className = "head";
  const heading = document.createElement("span");
  heading.textContent = "Videos on this page";
  const btns = document.createElement("span");
  const info = document.createElement("button");
  info.className = "close info";
  info.textContent = "ⓘ";
  info.title = "Diagnostics";
  info.addEventListener("click", () => toggleDebug());
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  close.title = "Close";
  close.addEventListener("click", () => hidePanel());
  btns.append(info, close);
  head.append(heading, btns);

  const list = document.createElement("div");
  list.className = "list";
  panel.append(head, list);
  shadow.append(fab, scrim, panel);
  document.documentElement.appendChild(host);

  ui = { host, fab, badge, scrim, panel, list };
  applyCorner(fab, false);
  return ui;
}

function fmtDuration(s) {
  if (!s || !Number.isFinite(s) || s <= 0) return null;
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtSize(bytes) {
  if (!bytes) return null;
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + " MB";
  return Math.max(1, Math.round(bytes / 1e3)) + " kB";
}

// Longest first; size breaks duration ties (unknowns count as 0).
function sortVideos(list) {
  return [...list].sort(
    (a, b) =>
      (b.duration || 0) - (a.duration || 0) || (b.size || 0) - (a.size || 0)
  );
}

function renderList() {
  const { list } = ensureUi();
  list.textContent = "";
  const sorted = sortVideos(videos);
  for (const v of sorted) {
    const row = document.createElement("button");
    row.className = "row";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = v.file || v.pageTitle || v.url;

    const meta = document.createElement("span");
    meta.className = "meta";
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = KIND_LABELS[v.kind] || "VIDEO";
    meta.appendChild(chip);

    const parts = [];
    if (v.width && v.height) {
      const res = `${v.width}×${v.height}`;
      parts.push(v.kind === "hls" ? `up to ${res}` : res);
    }
    const dur = fmtDuration(v.duration);
    if (dur) parts.push(dur);
    const size = fmtSize(v.size);
    if (size) parts.push(size);
    meta.appendChild(
      document.createTextNode(parts.length ? parts.join(" · ") : "—")
    );

    row.append(name, meta);
    row.addEventListener("click", () => castVideo(v));
    list.appendChild(row);
  }

  if (!sorted.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No videos found on this page.";
    list.appendChild(empty);
  }

  if (debugOpen) {
    const box = document.createElement("div");
    box.className = "debug";
    const lines = ["dom(top): " + lastScanSummary];
    if (debugInfo) {
      lines.push("— network (this tab) —");
      lines.push(...(debugInfo.tabLog.length ? debugInfo.tabLog : ["(empty)"]));
      lines.push("— network (no tab: workers/prefetch) —");
      lines.push(
        ...(debugInfo.globalLog.length ? debugInfo.globalLog : ["(empty)"])
      );
    } else {
      lines.push("(no background data)");
    }
    box.textContent = lines.join("\n");
    list.appendChild(box);
  }
}

function toggleDebug() {
  debugOpen = !debugOpen;
  if (!debugOpen) {
    renderList();
    return;
  }
  pushVideos(); // refresh the DOM scan summary
  browser.runtime
    .sendMessage({ type: "get-status" })
    .then((s) => {
      debugInfo = s || null;
      renderList();
    })
    .catch(() => {
      debugInfo = null;
      renderList();
    });
}

function updateUi() {
  if (!videos.length && !ui) return;
  const { fab, badge } = ensureUi();
  fab.hidden = videos.length === 0;
  badge.textContent = String(videos.length);
  if (panelOpen) renderList();
}

function showPanel() {
  const u = ensureUi();
  renderList();
  panelOpen = true;
  placePanel(u.panel);
  u.scrim.hidden = false;
  u.panel.hidden = false;
}

function hidePanel() {
  if (!ui) return;
  panelOpen = false;
  ui.scrim.hidden = true;
  ui.panel.hidden = true;
}

function togglePanel() {
  // Opens even with zero findings — the empty state and ⓘ diagnostics
  // are the tool for "why wasn't this video detected?".
  if (panelOpen) hidePanel();
  else showPanel();
}

function castVideo(v) {
  const m = /^(https?):\/\/(.+)$/i.exec(v.url);
  if (!m) return;
  const title = v.pageTitle || v.file || "Video";
  const intent =
    "intent://" +
    m[2] +
    "#Intent;scheme=" +
    m[1].toLowerCase() +
    ";action=android.intent.action.VIEW" +
    ";type=" +
    (v.mime || "video/*") +
    ";package=app.caster.video" +
    ";S.title=" +
    encodeURIComponent(title) +
    ";end";
  hidePanel();
  window.location.href = intent;
}

if (IS_TOP) {
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "videos") {
      videos = msg.videos || [];
      updateUi();
    } else if (msg.type === "toggle-panel") {
      togglePanel();
    }
  });

  // Sniffing may have started before this script loaded.
  browser.runtime
    .sendMessage({ type: "get-findings" })
    .then((found) => {
      videos = found || [];
      updateUi();
    })
    .catch(() => {});

  browser.storage.local
    .get("fabCorner")
    .then((r) => {
      if (r && /^[tb][lr]$/.test(r.fabCorner || "")) {
        fabCorner = r.fabCorner;
        repositionUi();
      }
    })
    .catch(() => {});

  window.addEventListener("resize", repositionUi);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", repositionUi);
    window.visualViewport.addEventListener("scroll", repositionUi);
  }
}
