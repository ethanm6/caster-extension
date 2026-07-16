// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

/*
 * Top frame only: the floating cast button that appears when the page has
 * videos, and the bottom-sheet panel to pick one. Tapping a row navigates
 * to an intent:// URI that launches the Caster app.
 *
 * Shares the frame's content-script scope with scanner.js, which loads
 * first (in every frame) and owns extEnabled, pushVideos(),
 * lastScanSummary and the onEnabledChange hook this file registers.
 */

// ---------- UI (top frame only) ----------

const UI_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, sans-serif; margin: 0; }
.fab {
  position: fixed; z-index: 2147483647;
  width: 52px; height: 52px; border-radius: 50%; border: none; padding: 0;
  background: rgba(97, 97, 97, 0.92); color: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  touch-action: none; user-select: none;
  transition: opacity 0.15s ease;
}
.fab[hidden] { display: none; }
.fab.snap { transition: left 0.2s ease, top 0.2s ease, opacity 0.15s ease; }
.fab.ducked { opacity: 0; pointer-events: none; }
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
  touch-action: none;
  transition: opacity 0.2s ease;
}
.scrim.off { opacity: 0; }
.panel {
  /* placePanel supplies the geometry (left/width/bottom/max-height). */
  position: fixed; z-index: 2147483647;
  display: flex; flex-direction: column;
  background: #fdfdff; color: #1a1a2e;
  border-radius: 28px 28px 0 0;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.35);
  font-size: 15px;
  padding-bottom: 3px; /* covers the overhang placePanel adds */
}
.panel[hidden] { display: none; }
.panel.anim { transition: transform 0.25s ease; }
.head {
  flex: none;
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px 8px; font-weight: 600;
  touch-action: none;
}
.list { overflow-y: auto; min-height: 0; overscroll-behavior: contain; touch-action: none; }
.close {
  border: none; background: none; color: inherit;
  font-size: 30px; line-height: 1; padding: 6px 14px; cursor: pointer;
}
.info { font-size: 23px; opacity: 0.7; }
.dismiss {
  position: fixed; z-index: 2147483646;
  width: 56px; height: 56px; border-radius: 50%;
  background: rgba(30, 30, 30, 0.85); color: #fff;
  border: 2px solid rgba(255, 255, 255, 0.9);
  display: flex; align-items: center; justify-content: center;
  font-size: 28px; line-height: 1;
  opacity: 0; pointer-events: none;
  transform: scale(calc(var(--vs, 1) * 0.5));
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.dismiss.show { opacity: 1; transform: scale(var(--vs, 1)); }
.dismiss.hot {
  background: #d32f2f;
  transform: scale(calc(var(--vs, 1) * 1.25));
}
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
};

let ui = null;
let videos = [];
let panelOpen = false;
let panelOff = true; // panel is translated off-screen below the viewport
let panelAnimTimer = null;
let debugOpen = false;
let debugInfo = null;
let fabCorner = "br"; // "t"/"b" + "l"/"r"
let fabDragging = false;
let fabDismissed = false; // dragged onto the × — hidden until navigation
let lastFabAnchor = ""; // last applied anchoring, to skip redundant writes
let lastPanelAnchor = "";
let redockTimer = null;
let lastMoveTime = 0; // last scroll/resize event, for the redock debounce
let scrollDir = "down"; // last vertical scroll direction
let lastVvTop = 0;
let lastPinTop = null; // vertical edge last anchored to, for duck-on-flip

// Fixed positioning anchors to the layout viewport, which can be wider than
// the screen (overflowing pages, pinch zoom) — everything here works in
// visual-viewport space so the UI stays on screen at a constant size.
function viewportBox() {
  const vv = window.visualViewport;
  return {
    left: vv.offsetLeft,
    top: vv.offsetTop,
    width: vv.width,
    height: vv.height,
    scale: vv.scale || 1,
  };
}

// A fixed element only holds still on screen while the visual viewport is
// pinned against the layout viewport edge it is anchored to. On normal
// pages the two viewports match, so any anchoring is trivially pinned. On
// pages whose layout viewport exceeds the screen, the visual viewport rests
// against the top edge at page top and gets pinned to the bottom edge while
// scrolling down (top edge while scrolling up) — so anchor to the edge the
// viewport is actually at, falling back to the scroll direction's target
// edge mid-transition. Static CSS offsets let the compositor keep the
// button glued (JS chasing always lags); it only drifts briefly between
// edges after a direction change.
// Detect overflowing/zoomed pages by width — the dynamic toolbar animates
// the viewport heights mid-scroll, so any height-based test flaps.
function overflowingPage(box) {
  return (
    Math.abs(box.scale - 1) > 0.01 ||
    box.left > 1 ||
    window.innerWidth - box.width > 8
  );
}

function vvPinned(box) {
  if (!overflowingPage(box)) return true;
  const excess = window.innerHeight - box.height;
  return box.top < 8 || excess - box.top < 8;
}

function pinnedEdgeIsTop(box, T) {
  if (!overflowingPage(box)) return T;
  const excess = window.innerHeight - box.height;
  if (box.top < 8) return true;
  if (excess - box.top < 8) return false;
  return scrollDir === "up";
}

function anchorFab(fab, box) {
  const s = Math.round(box.scale * 100) / 100;
  const tf = Math.abs(s - 1) > 0.01 ? "scale(" + 1 / s + ")" : "";
  const L = fabCorner.includes("l");
  const T = fabCorner.includes("t");
  const pinTop = pinnedEdgeIsTop(box, T);
  // Only write styles when the anchor itself changes: mid-scroll geometry
  // is noisy (toolbar animation) and chasing it per event reads as jitter.
  // Any staleness left behind is corrected by the settle glide.
  const key = [fabCorner, pinTop, tf].join("|");
  if (lastFabAnchor === key) return;
  lastFabAnchor = key;
  // Switching edges teleports the button (no static anchor can hold the
  // corner mid-transition): fade it out and fade back in once re-pinned.
  if (lastPinTop !== null && pinTop !== lastPinTop && !fab.hidden)
    fab.classList.add("ducked");
  lastPinTop = pinTop;
  const mx = 16 / s;
  const my = 24 / s;
  const h = (fab.offsetHeight || 52) / s;
  const left = L ? (Math.max(0, box.left) + mx).toFixed(1) + "px" : "";
  const right = L
    ? ""
    : (Math.max(0, window.innerWidth - box.left - box.width) + mx).toFixed(1) +
      "px";
  const vNear = my.toFixed(1) + "px";
  const vFar = (box.height - h - my).toFixed(1) + "px";
  const top = pinTop ? (T ? vNear : vFar) : "";
  const bottom = pinTop ? "" : T ? vFar : vNear;
  fab.style.transformOrigin =
    (pinTop ? "top " : "bottom ") + (L ? "left" : "right");
  fab.style.transform = tf;
  fab.style.left = left;
  fab.style.right = right;
  fab.style.top = top;
  fab.style.bottom = bottom;
}

function fabMisplaced(fab) {
  if (fab.hidden) return false;
  const box = viewportBox();
  const p = cornerPos(fab, box);
  const r = fab.getBoundingClientRect();
  return Math.abs(r.left - p.left) > 2 || Math.abs(r.top - p.top) > 2;
}

function cornerPos(fab, box) {
  const s = box.scale;
  const w = (fab.offsetWidth || 52) / s;
  const h = (fab.offsetHeight || 52) / s;
  const mx = 16 / s;
  const my = 24 / s;
  return {
    left: fabCorner.includes("l")
      ? box.left + mx
      : box.left + box.width - w - mx,
    top: fabCorner.includes("t")
      ? box.top + my
      : box.top + box.height - h - my,
  };
}

function applyCorner(fab, animate) {
  const box = viewportBox();
  if (animate) {
    // Glide in left/top coordinates, then settle into the final anchoring.
    lastFabAnchor = "";
    const r = fab.getBoundingClientRect();
    fab.style.right = "";
    fab.style.bottom = "";
    fab.style.left = r.left.toFixed(1) + "px";
    fab.style.top = r.top.toFixed(1) + "px";
    void fab.offsetWidth; // flush so the glide starts from here
    const p = cornerPos(fab, box);
    fab.classList.add("snap");
    fab.style.left = p.left.toFixed(1) + "px";
    fab.style.top = p.top.toFixed(1) + "px";
    setTimeout(() => {
      fab.classList.remove("snap");
      applyCorner(fab, false);
    }, 250);
    return;
  }
  if (vvPinned(box)) {
    anchorFab(fab, box);
  } else {
    // Mid-drift on an overflowing page: place absolutely for where the
    // viewport sits right now; the next scroll re-anchors to an edge.
    lastFabAnchor = "";
    const p = cornerPos(fab, box);
    fab.style.right = "";
    fab.style.bottom = "";
    fab.style.left = p.left.toFixed(1) + "px";
    fab.style.top = p.top.toFixed(1) + "px";
  }
  fab.classList.remove("ducked");
}

// Detection entrance: slide in from the top or bottom edge the corner
// sits on, then settle into normal anchoring.
function slideInFab(fab) {
  const box = viewportBox();
  const p = cornerPos(fab, box);
  const h = (fab.offsetHeight || 52) / box.scale;
  lastFabAnchor = "";
  fab.classList.remove("snap");
  fab.style.right = "";
  fab.style.bottom = "";
  const offT = fabCorner.includes("t")
    ? box.top - h - 8
    : box.top + box.height + 8;
  fab.style.left = p.left.toFixed(1) + "px";
  fab.style.top = offT.toFixed(1) + "px";
  void fab.offsetWidth; // flush so the glide starts off screen
  fab.classList.add("snap");
  fab.style.top = p.top.toFixed(1) + "px";
  setTimeout(() => {
    fab.classList.remove("snap");
    applyCorner(fab, false);
  }, 250);
}

function placePanel(panel) {
  const box = viewportBox();
  const s = box.scale;
  const scale = Math.abs(s - 1) > 0.01 ? "scale(" + 1 / s + ")" : "";
  // The slide-in/out offset rides the same transform as the pinch
  // counter-scale (extra 40px keeps the top shadow off screen too).
  const off = panelOff ? "translateY(calc(100% + 40px))" : "";
  const tf = scale && off ? scale + " " + off : scale || off;
  const left = box.left.toFixed(1) + "px";
  const width = (box.width * s).toFixed(1) + "px";
  // innerHeight is integer CSS px but the visual viewport height is
  // fractional, so a "flush" bottom leaves a sliver of page visible under
  // the panel. Overhang the edge by 3px (matched by the panel's bottom
  // padding); anything past the viewport is clipped, so it never shows.
  const bottom =
    (Math.max(0, window.innerHeight - box.top - box.height) - 3).toFixed(1) +
    "px";
  const maxHeight = (box.height * s * 0.65).toFixed(0) + "px";
  const key = [left, width, bottom, maxHeight, tf].join("|");
  if (lastPanelAnchor === key) return;
  lastPanelAnchor = key;
  panel.style.left = left;
  panel.style.width = width;
  panel.style.bottom = bottom;
  panel.style.maxHeight = maxHeight;
  panel.style.transformOrigin = "bottom left";
  panel.style.transform = tf;
}

function repositionUi() {
  if (!ui || fabDragging) return;
  const box = viewportBox();
  if (box.top - lastVvTop > 4) scrollDir = "down";
  else if (lastVvTop - box.top > 4) scrollDir = "up";
  lastVvTop = box.top;
  anchorFab(ui.fab, box);
  if (ui.fab.classList.contains("ducked") && vvPinned(box))
    ui.fab.classList.remove("ducked");
  if (panelOpen) placePanel(ui.panel);
  // A stop mid-drift can leave the button away from its corner: glide back
  // once events go quiet. Timestamp debounce — one live timer that re-arms
  // for the remainder, instead of clear+create on every scroll event.
  lastMoveTime = performance.now();
  if (!redockTimer) redockTimer = setTimeout(checkRedock, 150);
}

function checkRedock() {
  const remaining = 150 - (performance.now() - lastMoveTime);
  if (remaining > 16) {
    redockTimer = setTimeout(checkRedock, remaining);
    return;
  }
  redockTimer = null;
  if (!ui || fabDragging) return;
  if (fabMisplaced(ui.fab)) applyCorner(ui.fab, true);
  else ui.fab.classList.remove("ducked");
}

// Drag-to-dismiss target: an × bubble at the bottom middle of the screen,
// shown only while the button is being dragged. Returns its center and
// magnet radius in layout coordinates for the drag loop.
function showDismiss() {
  const d = ui.dismiss;
  const box = viewportBox();
  const s = box.scale;
  d.style.setProperty("--vs", String(Math.round(100 / s) / 100));
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height - 52 / s;
  d.style.left = (cx - 28).toFixed(1) + "px";
  d.style.top = (cy - 28).toFixed(1) + "px";
  d.classList.add("show");
  return { cx, cy, r: 60 / s };
}

function makeDraggable(fab) {
  let pid = null;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dismissTarget = null;
  let dismissHot = false;

  fab.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary) return;
    pid = e.pointerId;
    fabDragging = true;
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
    if (!moved) {
      moved = true;
      dismissTarget = showDismiss();
      dismissHot = false;
    }
    lastFabAnchor = "";
    fab.classList.remove("snap");
    fab.style.right = "";
    fab.style.bottom = "";
    const box = viewportBox();
    const r = fab.getBoundingClientRect();
    const maxL = box.left + box.width - r.width;
    const maxT = box.top + box.height - r.height;
    let nl = Math.min(Math.max(startLeft + dx, box.left), maxL);
    let nt = Math.min(Math.max(startTop + dy, box.top), maxT);
    if (dismissTarget) {
      dismissHot =
        Math.hypot(
          nl + r.width / 2 - dismissTarget.cx,
          nt + r.height / 2 - dismissTarget.cy
        ) < dismissTarget.r;
      ui.dismiss.classList.toggle("hot", dismissHot);
      if (dismissHot) {
        // Magnetized: the button rides the × instead of the finger.
        nl = dismissTarget.cx - r.width / 2;
        nt = dismissTarget.cy - r.height / 2;
      }
    }
    fab.style.left = nl + "px";
    fab.style.top = nt + "px";
  });

  const finish = (e) => {
    if (pid === null || e.pointerId !== pid) return;
    pid = null;
    fabDragging = false;
    const wasHot = dismissHot;
    dismissTarget = null;
    dismissHot = false;
    if (ui) ui.dismiss.classList.remove("show", "hot");
    if (!moved) return;
    if (wasHot) {
      fabDismissed = true;
      fab.hidden = true;
      return;
    }
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

// Panning the list natively lets the browser drive the dynamic toolbar in
// and out (and resize the viewport under the sheet). touch-action: none
// keeps the browser out of these touches entirely, so the list scrolls
// itself: direct drag plus a decaying fling.
function makeListScroller(list) {
  let tracking = false;
  let dragging = false;
  let lastY = 0;
  let lastT = 0;
  let vel = 0; // px/ms, positive scrolls toward the end
  let raf = null;

  list.addEventListener(
    "touchstart",
    (e) => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      tracking = true;
      dragging = false;
      vel = 0;
      lastY = e.touches[0].clientY;
      lastT = e.timeStamp;
    },
    { passive: true }
  );

  list.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking || e.touches.length > 1) return;
      const y = e.touches[0].clientY;
      const dy = lastY - y;
      if (!dragging) {
        if (Math.abs(dy) < 6) return; // still a tap
        dragging = true;
        lastY = y;
        lastT = e.timeStamp;
        return;
      }
      e.preventDefault(); // no tap-click after a drag
      const dt = Math.max(1, e.timeStamp - lastT);
      list.scrollTop += dy;
      vel = 0.7 * (dy / dt) + 0.3 * vel;
      lastY = y;
      lastT = e.timeStamp;
    },
    { passive: false }
  );

  list.addEventListener("touchend", () => {
    tracking = false;
    if (!dragging || Math.abs(vel) < 0.05) return;
    let prev = performance.now();
    const step = (now) => {
      raf = null;
      const dt = now - prev;
      prev = now;
      list.scrollTop += vel * dt;
      vel *= Math.pow(0.998, dt);
      const max = list.scrollHeight - list.clientHeight;
      if (Math.abs(vel) >= 0.02 && list.scrollTop > 0 && list.scrollTop < max)
        raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  });
  list.addEventListener("touchcancel", () => {
    tracking = false;
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
  // Parsed, not innerHTML-assigned: AMO's linter flags innerHTML even for
  // static markup like the glyph.
  const glyphDoc = new DOMParser().parseFromString(
    CAST_GLYPH,
    "image/svg+xml"
  );
  fab.appendChild(document.importNode(glyphDoc.documentElement, true));
  fab.hidden = true;
  const badge = document.createElement("span");
  badge.className = "badge";
  fab.appendChild(badge);
  makeDraggable(fab);

  const dismiss = document.createElement("div");
  dismiss.className = "dismiss";
  dismiss.textContent = "×";

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
  makeListScroller(list);
  panel.append(head, list);
  shadow.append(dismiss, fab, scrim, panel);
  document.documentElement.appendChild(host);

  ui = { host, fab, badge, dismiss, scrim, panel, list };
  applyCorner(fab, false);

  // Only track viewport changes once there's something to reposition;
  // video-less pages never pay for these listeners.
  window.addEventListener("resize", repositionUi);
  window.addEventListener("scroll", repositionUi, { passive: true });
  window.visualViewport.addEventListener("resize", repositionUi);
  window.visualViewport.addEventListener("scroll", repositionUi);
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
    const vp = viewportBox();
    const lines = [
      "vp: win=" +
        window.innerWidth +
        "×" +
        window.innerHeight +
        " vis=" +
        Math.round(vp.width) +
        "×" +
        Math.round(vp.height) +
        " off=" +
        Math.round(vp.left) +
        "," +
        Math.round(vp.top) +
        " s=" +
        vp.scale.toFixed(2),
      "dom(top): " + lastScanSummary,
    ];
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
  const wasHidden = fab.hidden;
  fab.hidden = videos.length === 0 || fabDismissed || !extEnabled;
  if (wasHidden && !fab.hidden) slideInFab(fab);
  badge.textContent = String(videos.length);
  if (panelOpen) renderList();
}

function showPanel() {
  const u = ensureUi();
  renderList();
  if (panelAnimTimer) clearTimeout(panelAnimTimer);
  panelOpen = true;
  // Render off-screen below first, then transition the transform so the
  // sheet slides up. Transitions don't run from display:none — the layout
  // flush after unhiding establishes the start state.
  u.panel.classList.remove("anim");
  panelOff = true;
  placePanel(u.panel);
  u.panel.hidden = false;
  u.scrim.hidden = false;
  u.scrim.classList.add("off");
  void u.panel.offsetWidth;
  u.panel.classList.add("anim");
  panelOff = false;
  placePanel(u.panel);
  u.scrim.classList.remove("off");
  panelAnimTimer = setTimeout(() => {
    panelAnimTimer = null;
    // Done sliding: repositioning writes must land instantly again.
    u.panel.classList.remove("anim");
  }, 300);
}

function hidePanel() {
  if (!ui || !panelOpen) return;
  panelOpen = false;
  if (panelAnimTimer) clearTimeout(panelAnimTimer);
  ui.panel.classList.add("anim");
  panelOff = true;
  placePanel(ui.panel);
  ui.scrim.classList.add("off");
  panelAnimTimer = setTimeout(() => {
    panelAnimTimer = null;
    ui.panel.classList.remove("anim");
    ui.panel.hidden = true;
    ui.scrim.hidden = true;
    ui.scrim.classList.remove("off");
  }, 300);
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
    if (/^[tb][lr]$/.test(r.fabCorner || "")) {
      fabCorner = r.fabCorner;
      repositionUi();
    }
  })
  .catch(() => {});

// scanner.js keeps extEnabled current; this hook reacts to the flip in the UI.
onEnabledChange = () => {
  if (!extEnabled) hidePanel();
  updateUi();
};
