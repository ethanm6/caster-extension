// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

/*
 * Per-tab video findings store.
 *
 * Sources:
 *  - webRequest sniffing (media content-types / file extensions)
 *  - DOM <video> reports pushed by content scripts (all frames)
 *
 * Entries are enriched here (not in content scripts, whose fetches are
 * subject to the page's CORS): HLS masters get best-variant resolution and
 * summed duration, DASH MPDs get mediaPresentationDuration and max
 * Representation size.
 */

const MAX_ENTRIES = 30;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

// Options-page on/off switch. Off = stop sniffing network traffic and ignore
// DOM reports; existing findings are kept and the content script hides the
// in-page UI.
let extEnabled = true;
browser.storage.local
  .get("enabled")
  .then((r) => {
    extEnabled = r.enabled !== false;
  })
  .catch(() => {});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled)
    extEnabled = changes.enabled.newValue !== false;
});

const CT_KINDS = {
  "application/x-mpegurl": "hls",
  "application/vnd.apple.mpegurl": "hls",
  "audio/mpegurl": "hls",
  "audio/x-mpegurl": "hls",
  "application/dash+xml": "dash",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/mp2t": "ts",
};

const EXT_KINDS = {
  m3u8: "hls",
  mpd: "dash",
  mp4: "mp4",
  m4v: "mp4",
  mkv: "mkv",
  webm: "webm",
  mov: "mov",
  ts: "ts",
};

const KIND_MIMES = {
  hls: "application/x-mpegURL",
  dash: "application/dash+xml",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  ts: "video/mp2t",
  video: "video/*",
};

// tabId -> { entries: Map(url -> entry), variantUrls: Set, hasHls: bool,
//            log: string[] }
const tabStores = new Map();

function getStore(tabId) {
  let store = tabStores.get(tabId);
  if (!store) {
    store = {
      entries: new Map(),
      variantUrls: new Set(),
      hasHls: false,
      log: [],
    };
    tabStores.set(tabId, store);
  }
  return store;
}

// Diagnostics shown in the panel's ⓘ view: per-tab ring log of media-looking
// responses; tabless events (workers, prefetch) land in a global log.
const MAX_LOG = 50;
const MEDIAISH_URL = /\.(m3u8|mpd|mp4|m4v|mkv|webm|mov)(\?|#|$)/i;
const MEDIAISH_CT = /mpegurl|dash|video\//i;
const globalLog = [];

function logLine(buf, line) {
  buf.push(new Date().toISOString().slice(11, 19) + " " + line);
  if (buf.length > MAX_LOG) buf.shift();
}

function urlTail(url) {
  return url.length > 120 ? "…" + url.slice(-119) : url;
}

function findingsFor(tabId) {
  const store = tabStores.get(tabId);
  return store ? [...store.entries.values()] : [];
}

// Findings arrive in bursts (entry, then title, then enrichment) — coalesce
// so the panel re-renders once per burst instead of once per step.
const notifyTimers = new Map();

function notify(tabId) {
  if (notifyTimers.has(tabId)) return;
  notifyTimers.set(
    tabId,
    setTimeout(() => {
      notifyTimers.delete(tabId);
      browser.tabs
        .sendMessage(tabId, { type: "videos", videos: findingsFor(tabId) })
        .catch(() => {});
    }, 50)
  );
}

function fileNameOf(url) {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(segs[segs.length - 1] || "") || null;
  } catch (e) {
    return null;
  }
}

function classifyByContentType(ct) {
  if (!ct) return null;
  ct = ct.split(";")[0].trim().toLowerCase();
  return CT_KINDS[ct] || (ct.startsWith("video/") ? "video" : null);
}

function classifyByUrl(url) {
  let path;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch (e) {
    return null;
  }
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_KINDS[path.slice(dot + 1)] || null;
}

function headerValue(headers, name) {
  for (const h of headers || []) {
    if (h.name.toLowerCase() === name) return h.value;
  }
  return null;
}

// Full size even for 206 chunks (Content-Range holds the total).
function sizeFrom(details) {
  const cr = headerValue(details.responseHeaders, "content-range");
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) return parseInt(m[1], 10) || null;
  }
  if (details.statusCode === 200) {
    const cl = headerValue(details.responseHeaders, "content-length");
    if (cl) return parseInt(cl, 10) || null;
  }
  return null;
}

function addEntry(tabId, store, props) {
  const entry = Object.assign(
    {
      url: null,
      kind: "video",
      mime: null,
      size: null,
      width: null,
      height: null,
      duration: null,
      file: null,
      pageTitle: null,
    },
    props
  );
  entry.mime = entry.mime || KIND_MIMES[entry.kind];
  entry.file = entry.file || fileNameOf(entry.url);
  store.entries.set(entry.url, entry);

  if (entry.kind === "hls") {
    store.hasHls = true;
    // Segment noise is pointless once we have the playlist itself.
    for (const [url, e] of store.entries) {
      if (e.kind === "ts") store.entries.delete(url);
    }
    enrichHls(store, entry).then(() => notify(tabId));
  } else if (entry.kind === "dash") {
    enrichDash(entry).then(() => notify(tabId));
  }
  if (!entry.pageTitle) {
    browser.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.title) {
          entry.pageTitle = tab.title;
          notify(tabId);
        }
      })
      .catch(() => {});
  }
  notify(tabId);
}

// ---------- network sniffer ----------

// The main video often starts loading last (after thumbnails and preview
// clips), so on overflow evict the oldest plain entry, never a manifest.
function makeRoom(store) {
  if (store.entries.size < MAX_ENTRIES) return true;
  for (const [url, e] of store.entries) {
    if (e.kind !== "hls" && e.kind !== "dash") {
      store.entries.delete(url);
      return true;
    }
  }
  return false;
}

browser.webRequest.onResponseStarted.addListener(
  (details) => {
    if (!extEnabled) return;
    const ct = headerValue(details.responseHeaders, "content-type");
    const kind = classifyByContentType(ct) || classifyByUrl(details.url);
    if (details.tabId < 0) {
      if (kind && kind !== "ts") handleTabless(details, ct, kind);
      return;
    }
    if (!kind && !MEDIAISH_URL.test(details.url) && !MEDIAISH_CT.test(ct || ""))
      return;

    const store = getStore(details.tabId);
    // Segments are too noisy to log.
    if (kind !== "ts")
      logLine(
        store.log,
        (kind || "?") + " " + (ct || "-") + " " + urlTail(details.url)
      );
    if (!kind) return;
    if (store.entries.has(details.url) || store.variantUrls.has(details.url))
      return;
    if (kind === "ts" && store.hasHls) return;
    if (!makeRoom(store)) return;

    addEntry(details.tabId, store, {
      url: details.url,
      kind,
      size: sizeFrom(details),
    });
  },
  {
    urls: ["<all_urls>"],
    // Streams only arrive via these request classes — letting Firefox drop
    // images/scripts/styles/fonts up front keeps the listener off the vast
    // majority of page traffic.
    types: [
      "main_frame",
      "sub_frame",
      "xmlhttprequest",
      "media",
      "object",
      "speculative",
      "other",
    ],
  },
  ["responseHeaders"]
);

// Worker/prefetch requests carry tabId -1; attribute them to open tabs of
// the initiating origin so those videos aren't silently lost.
function handleTabless(details, ct, kind) {
  logLine(globalLog, kind + " " + (ct || "-") + " " + urlTail(details.url));
  const src = details.documentUrl || details.originUrl;
  if (!src) return;
  let origin;
  try {
    origin = new URL(src).origin;
  } catch (e) {
    return;
  }
  if (!/^https?:/.test(origin)) return;
  browser.tabs
    .query({ url: origin + "/*" })
    .then((tabs) => {
      for (const tab of tabs) {
        const store = getStore(tab.id);
        if (
          store.entries.has(details.url) ||
          store.variantUrls.has(details.url)
        )
          continue;
        if (!makeRoom(store)) continue;
        logLine(store.log, "tabless " + kind + " " + urlTail(details.url));
        addEntry(tab.id, store, {
          url: details.url,
          kind,
          size: sizeFrom(details),
        });
      }
    })
    .catch(() => {});
}

// ---------- manifest enrichment ----------

async function fetchText(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, { signal: ctrl.signal, credentials: "omit" });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const len = parseInt(resp.headers.get("content-length") || "0", 10);
    if (len > MAX_MANIFEST_BYTES) return null;
    return await resp.text();
  } catch (e) {
    return null;
  }
}

function parseHlsMaster(text, baseUrl) {
  const variants = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
    const bw = /BANDWIDTH=(\d+)/i.exec(line);
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l || l.startsWith("#")) continue;
      uri = l;
      break;
    }
    if (!uri) continue;
    try {
      variants.push({
        url: new URL(uri, baseUrl).href,
        width: res ? parseInt(res[1], 10) : null,
        height: res ? parseInt(res[2], 10) : null,
        bandwidth: bw ? parseInt(bw[1], 10) : 0,
      });
    } catch (e) {
      /* malformed variant URI */
    }
  }
  return variants;
}

function sumExtinf(text) {
  let total = 0;
  let found = false;
  for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) {
    total += parseFloat(m[1]);
    found = true;
  }
  return found ? total : null;
}

async function enrichHls(store, entry) {
  const text = await fetchText(entry.url);
  if (text == null) return;
  if (text.includes("#EXT-X-STREAM-INF")) {
    const variants = parseHlsMaster(text, entry.url);
    let best = null;
    for (const v of variants) {
      // Child playlists must not show up as findings of their own.
      store.variantUrls.add(v.url);
      store.entries.delete(v.url);
      if (
        !best ||
        (v.height || 0) > (best.height || 0) ||
        ((v.height || 0) === (best.height || 0) &&
          v.bandwidth > best.bandwidth)
      ) {
        best = v;
      }
    }
    if (best) {
      entry.width = best.width;
      entry.height = best.height;
      const mediaText = await fetchText(best.url);
      if (mediaText) entry.duration = sumExtinf(mediaText);
    }
  } else {
    entry.duration = sumExtinf(text);
  }
}

function parseIsoDuration(s) {
  if (!s) return null;
  const m =
    /^-?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      s
    );
  if (!m) return null;
  return (
    parseFloat(m[1] || "0") * 86400 +
    parseFloat(m[2] || "0") * 3600 +
    parseFloat(m[3] || "0") * 60 +
    parseFloat(m[4] || "0")
  );
}

async function enrichDash(entry) {
  const text = await fetchText(entry.url);
  if (text == null) return;
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const mpd = doc.documentElement;
  if (!mpd || mpd.nodeName === "parsererror") return;
  entry.duration = parseIsoDuration(
    mpd.getAttribute("mediaPresentationDuration")
  );
  let w = 0;
  let h = 0;
  for (const rep of doc.getElementsByTagName("Representation")) {
    const rw = parseInt(rep.getAttribute("width") || "0", 10);
    const rh = parseInt(rep.getAttribute("height") || "0", 10);
    if (rh > h) {
      h = rh;
      w = rw;
    }
  }
  if (h) {
    entry.width = w;
    entry.height = h;
  }
}

// ---------- DOM reports & panel queries ----------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return undefined;
  const tabId = sender.tab.id;

  if (msg.type === "open-options") {
    browser.runtime.openOptionsPage().catch(() => {});
    return undefined;
  }

  if (msg.type === "get-findings") {
    return Promise.resolve(findingsFor(tabId));
  }

  if (msg.type === "get-status") {
    const store = tabStores.get(tabId);
    return Promise.resolve({
      tabLog: store ? store.log.slice() : [],
      globalLog: globalLog.slice(),
    });
  }

  if (msg.type === "dom-videos") {
    if (!extEnabled) return undefined;
    const store = getStore(tabId);
    let changed = false;
    for (const v of msg.videos || []) {
      if (typeof v.url !== "string" || !/^https?:/i.test(v.url)) continue;
      if (store.variantUrls.has(v.url)) continue;
      const existing = store.entries.get(v.url);
      if (existing) {
        // The DOM knows the element's real dimensions and duration.
        if (v.width && v.height && !existing.width) {
          existing.width = v.width;
          existing.height = v.height;
          changed = true;
        }
        if (v.duration && !existing.duration) {
          existing.duration = v.duration;
          changed = true;
        }
        if (v.title && !existing.pageTitle) {
          existing.pageTitle = v.title;
          changed = true;
        }
      } else if (makeRoom(store)) {
        addEntry(tabId, store, {
          url: v.url,
          kind: classifyByUrl(v.url) || "video",
          width: v.width || null,
          height: v.height || null,
          duration: v.duration || null,
          pageTitle: v.title || null,
        });
        changed = true;
      }
    }
    if (changed) notify(tabId);
    return undefined;
  }

  return undefined;
});

// ---------- lifecycle ----------

browser.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  // Casting navigates to intent:// — the page itself survives that.
  if (/^intent:/i.test(details.url)) return;
  tabStores.delete(details.tabId);
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabStores.delete(tabId);
});

// Menu entry (secondary way in, since the button only shows on detection).
browser.browserAction.onClicked.addListener((tab) => {
  browser.tabs.sendMessage(tab.id, { type: "toggle-panel" }).catch(() => {});
});
