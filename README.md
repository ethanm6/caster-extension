# Caster extension

A Firefox for Android extension that finds videos on the page you're viewing and casts them to a Chromecast with the [Caster](https://github.com/ethanm6/Caster) app.

## What it does

- Detects videos two ways: scanning the page for `<video>` elements (in every frame) and sniffing network traffic for media streams (HLS, DASH, MP4, WebM, …).
- When videos are found, a floating cast button slides in over the page. Tapping it opens a panel listing each source with its type, resolution, and duration.
- Tapping a source hands the URL to the Caster app via an Android intent — the URL is passed exactly as found, so the stream plays directly over your LAN.

## Requirements

- Firefox for Android 142 or later.
- The [Caster](https://github.com/ethanm6/Caster) app installed on the same device.

## Installing

Not yet listed on addons.mozilla.org. Until then, build the package yourself:

```bash
zip -r -FS caster-extension.xpi manifest.json background.js scanner.js ui.js content.css options.html options.js icons LICENSE
```

Release Firefox for Android only installs signed extensions, so load the xpi in Firefox Nightly: Settings → Extensions → Install extension from file.

## Support

If you find this project useful, you can support development:

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/ethanm6)

## License

[GPL-3.0-or-later](LICENSE)
