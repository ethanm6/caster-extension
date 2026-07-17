// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const box = document.getElementById("enabled");
const hideFabBox = document.getElementById("hideFab");

browser.storage.local
  .get(["enabled", "hideFab"])
  .then((r) => {
    box.checked = r.enabled !== false;
    hideFabBox.checked = r.hideFab === true;
  })
  .catch(() => {});

box.addEventListener("change", () => {
  browser.storage.local.set({ enabled: box.checked }).catch(() => {});
});

hideFabBox.addEventListener("change", () => {
  browser.storage.local.set({ hideFab: hideFabBox.checked }).catch(() => {});
});

// The options page is embedded in Firefox's settings UI, so a plain link
// navigates that frame (or is blocked by the site's framing rules) instead
// of opening a browser tab. Open the URL in a real tab instead.
for (const link of document.querySelectorAll("a[data-url]")) {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    browser.tabs.create({ url: link.dataset.url }).catch(() => {});
  });
}
