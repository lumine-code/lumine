# Brand art

The README banners and desktop wallpapers use the website's warm neutral palette, full-width rules and gold application mark. The logo comes directly from `resources/app-icons/lumine.svg`; the banner description comes from `package.json`.

| Asset                                 | Size        | Appearance              |
| ------------------------------------- | ----------- | ----------------------- |
| `resources/brand/banner.png`          | 1600 × 600  | Light README banner     |
| `resources/brand/banner-dark.png`     | 1600 × 600  | Dark README banner      |
| `resources/brand/wallpaper.png`       | 1920 × 1080 | Dark desktop wallpaper  |
| `resources/brand/wallpaper-light.png` | 1920 × 1080 | Light desktop wallpaper |

Each PNG has a generated SVG sibling. The README selects its banner using the reader's color preference. PNGs preserve the exported typography on every platform; SVG text uses Segoe UI and Consolas, so their appearance depends on the viewer's installed fonts.

To regenerate only these assets on Windows:

```sh
npm run generate:branding -- --brand-only
npm run check:branding -- --brand-only
```

The layout and palette live in `script/brand-art.js`. The existing branding generator renders the SVGs through Electron and checks their generated files. It requires Segoe UI, as the Windows installer artwork does. Use `--out <directory>` to preview an export elsewhere. A full branding run also regenerates these marketing assets.

Application screenshots are separate: capture them from running Lumine. A banner or wallpaper is graphic design, never a substitute for an editor screenshot.

## README gallery

The original lossless PNG captures live in `.github/gallery/view-1.png` through `view-4.png`. Capture the application's rectangular content area at default editor font settings, excluding the operating system's window border and rounded corners. Their captions and capture context are recorded in `.github/gallery/captures.json`. Keep the captures authentic: replace them with new captures from the application, never with reconstructed UI or generated editor views.

The gallery generator fits those unaltered captures onto four separate numbered panels with matching backgrounds and full-height rules. A rounded clipping frame gives the editor clean corners without bringing the desktop or system window border into the capture. Each panel has light and dark versions. The README places them together in one HTML block, with top-aligned images and no intervening paragraphs, to preserve the sequence. All eight panels are generated from the same four captures:

```sh
npm run generate:branding -- --gallery-only
npm run check:branding -- --gallery-only
```

The composition lives in `script/gallery-art.js` and reuses the banner palette. The website can link directly to the repository's original captures or gallery images; it does not need another copy of them.
