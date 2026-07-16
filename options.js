// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const box = document.getElementById("enabled");

browser.storage.local
  .get("enabled")
  .then((r) => {
    box.checked = !r || r.enabled !== false;
  })
  .catch(() => {});

box.addEventListener("change", () => {
  browser.storage.local.set({ enabled: box.checked }).catch(() => {});
});
