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
