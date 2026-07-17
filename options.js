// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const box = document.getElementById("enabled");

browser.storage.local
  .get("enabled")
  .then((r) => {
    box.checked = r.enabled !== false;
  })
  .catch(() => {});

box.addEventListener("change", () => {
  browser.storage.local.set({ enabled: box.checked }).catch(() => {});
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
