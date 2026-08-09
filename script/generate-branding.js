/*
 * Renders every Lumine branding asset from the master art in
 * `resources/app-icons/lumine.svg`: the application icon for all three
 * platforms, the document icon, the Windows installer's bitmaps and Start-menu
 * tiles, the raw mark, and the square badge.
 *
 * Two sibling SVGs carry the same mark recolored for a run mode --
 * `lumine-safe.svg` (safe mode) and `lumine-dev.svg` (dev mode). Those only
 * ever need the runtime app icon and the square badge -- nothing else about a
 * run mode is a distinct build, so they skip the document icon, the installer
 * art and the Start-menu tiles, and their PNGs go straight into
 * `resources/app-icons/` as `lumine-<mode>.png` / `lumine-square-<mode>.png`.
 *
 * Usage:
 *   electron --no-sandbox script/generate-branding.js [options]
 *
 * Options:
 *   --check        render in memory and byte-compare against the committed
 *                  files; write nothing, exit 1 on any drift
 *   --out <dir>    write under <dir> instead of the repo, for eyeballing a
 *                  design change without dirtying the tree
 *
 * Before this script the rasters were hand-exported from art that no longer
 * matched lumine.svg: every white element carried a drop shadow the vector
 * does not have, and the .ico/.icns/tile sets had drifted apart. Everything is
 * now flat and derived from the one vector, so `--check` is what proves the
 * committed binaries still match it.
 *
 * Must run under Electron, not node: the art is rasterized by Chromium, which
 * is the only renderer this repo already depends on. Outputs are committed as
 * binaries and this script is invoked by hand — it is deliberately NOT wired
 * into `npm run dist`, and `--check` deliberately does NOT run in CI. The lint
 * lane installs with `npm ci --ignore-scripts` and so has no Electron binary at
 * all, and a byte-exact check would go red on any Electron bump that shifts
 * Skia's anti-aliasing by a single level. Treat `--check` as a local sanity
 * tool for "did I forget to regenerate after editing lumine.svg".
 *
 * The installer sidebar's wordmark is set in Segoe UI Semibold, which means
 * regeneration requires Windows. That is deliberate: the sidebar is a
 * Windows-only asset and Segoe is the face the surrounding installer chrome
 * uses. The script hard-fails rather than silently falling back to another
 * font. If regeneration ever has to happen off-Windows, drop the wordmark
 * instead of substituting a face — NSIS already prints "Welcome to the Lumine
 * Setup Wizard" right beside the sidebar, so the panel reads fine without it.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { app, BrowserWindow, Menu } = require("electron");

// This utility uses a hidden frameless window and never needs an application
// menu. Suppress Electron's default menu before `ready`.
Menu.setApplicationMenu(null);

const REPO_ROOT = path.resolve(__dirname, "..");
const APP_ICONS_DIR = path.join(REPO_ROOT, "resources", "app-icons");
const MASTER_SVG = path.join(APP_ICONS_DIR, "lumine.svg");

// Each run mode gets its own recolored sibling of lumine.svg -- same mark,
// same gradient shape, different hue. See readMasterArt(): all three are read
// through the identical extraction, so a shape edit to one and not the others
// fails loudly via the same "no longer has the expected shape" check.
const MODE_VARIANTS = [
  { name: "safe", svg: path.join(APP_ICONS_DIR, "lumine-safe.svg") },
  { name: "dev", svg: path.join(APP_ICONS_DIR, "lumine-dev.svg") },
];

// Must be at least the largest asset (the 1024px icns slice). Every capture is
// a rect out of this one viewport, so the stage is laid out and shown once
// rather than resized per asset — a resize means another relayout plus another
// frame wait, and the small icon sizes would hit the Windows ~132px minimum
// window width.
const STAGE = 1024;

const WORDMARK_FAMILY = "Segoe UI";
const WORDMARK_WEIGHT = 600;
const WORDMARK_SIZE = 26;

// The mark's ink spans 19..109 of lumine.svg's 128-unit canvas (a 90-unit
// box). Scaling that canvas by 0.77 inside a tile reproduces the ink box of
// the tiles this repo shipped before (35..115 at 150px), so the tiles do not
// gratuitously shift when the mark itself changes shape.
const MARK_FRACTION = 0.77;

// The gold disc is r=60 on the 128-unit canvas, so the artwork is 120 units
// across. Badge placements scale against that, not against the canvas.
const DISC_DIAMETER = 120;

// The raw mark drops the disc, so the ink is free to grow into the corner-to-
// corner space the disc used to occupy. 1.32 takes the 19..109 ink box out to
// 4.6..123.4, which fills the square while leaving the eight ray tips clear of
// a rounded-corner crop.
const RAW_SCALE = 1.32;

// The square badge keeps the disc's own footprint (the same 120-unit box, same
// 4-unit margin) but swaps the circle for an actual square -- sharp corners,
// not a rounded rect -- so the mark sits at the exact scale and position it
// already has on the disc; nothing about squareBody() needs to know the
// mark's geometry, only the shape behind it.
const SQUARE_SIDE = DISC_DIAMETER;
const SQUARE_INSET = (128 - SQUARE_SIDE) / 2;
const SQUARE_RADIUS = 0;

// Throws rather than exiting on the spot: app.exit() only schedules the exit,
// so the rest of the current async turn would keep running against a torn-down
// window and bury the real message under a follow-on error.
class Fail extends Error {}

function fail(message) {
  throw new Fail(message);
}

// --- argument parsing -------------------------------------------------------

// Electron's own switches share process.argv with ours and their position is
// not guaranteed, so anchor on the script path rather than slicing a constant.
function scriptArgs(argv) {
  const index = argv.findIndex((arg) => arg.endsWith(path.basename(__filename)));
  return index === -1 ? [] : argv.slice(index + 1);
}

function parseArgs(argv) {
  const options = { check: false, outDir: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--check":
        options.check = true;
        break;
      case "--out":
        options.outDir = path.resolve(argv[++i] ?? fail("--out needs a value"));
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }
  return options;
}

// --- master art -------------------------------------------------------------

// Pull the gradient, the disc and the white mark straight out of the given SVG
// so none of it is ever retyped here: the SVG stays the single source of
// truth, and an edit that changes its shape breaks loudly instead of quietly
// emitting blank art. Takes a path rather than always reading MASTER_SVG so
// the same extraction serves lumine.svg and its safe/dev siblings alike.
function readMasterArt(svgPath) {
  const source = fs.readFileSync(svgPath, "utf8");
  const gradient = source.match(/<radialGradient\b[\s\S]*?<\/radialGradient>/)?.[0];
  const mark = source.match(/<g fill="#fff">([\s\S]*?)<\/g>\s*<\/svg>/)?.[1];
  const disc = source.match(/<circle\b[^>]*r="60"[^>]*\/>/)?.[0];
  if (!gradient || !mark || !disc) {
    fail(
      `${path.relative(REPO_ROOT, svgPath)} no longer has the expected shape ` +
        "(a <radialGradient>, an r=60 <circle>, and a white <g> of paths)",
    );
  }
  return { gradient, mark, disc };
}

// --- art ---------------------------------------------------------------------

// Sized in percentages so one string renders at any pixel size: the stage div
// is what fixes the output dimensions.
function svg(viewBox, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" ` +
    `viewBox="${viewBox}">${body}</svg>`
  );
}

// A standalone .svg document rather than a fragment for the stage: same art,
// but sized in units so a consumer that ignores viewBox still gets 128x128.
function svgDocument(viewBox, size, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" ` +
    `width="${size}" height="${size}">\n  ${body}\n</svg>\n`
  );
}

// The application icon, exactly as lumine.svg draws it: gold disc, white mark,
// transparent outside the disc. Flat — no drop shadow on the white elements.
function appArt({ gradient, disc, mark }) {
  return svg("0 0 128 128", `<defs>${gradient}</defs>${disc}<g fill="#fff">${mark}</g>`);
}

// The raw mark: the same mark, grown to fill the square and painted flat
// black now that the disc (and the gold with it) is gone. Nothing in the
// editor loads it — it is the avatar art, for the GitHub organisation and
// anywhere else the logo needs to sit in a square, in one plain ink color,
// rather than float as a colored badge. Black rather than the brand gold
// because this is the mark at its most reusable: it prints, it stencils, it
// reads on any light background without a gradient renderer or a color
// carrying meaning it doesn't have here.
function rawBody({ mark }) {
  return `<g fill="#000" transform="translate(64 64) scale(${RAW_SCALE}) translate(-64 -64)">${mark}</g>`;
}

// The square badge: the app icon's own disc and mark, at the identical
// footprint and scale, just with the circle swapped for a rounded rect. Reuses
// the gradient and the disc's own fill reference verbatim rather than
// reconstructing either, so it tracks whichever gradient id the source SVG
// actually declares (lumine-gold, lumine-safe, lumine-dev, ...) instead of
// assuming one. Body only, no <svg> wrapper — like rawBody(), this feeds both
// a standalone .svg document and a rasterized .png from the same markup.
function squareBody({ gradient, disc, mark }) {
  const fill = disc.match(/fill="(url\([^)]+\))"/)?.[1];
  if (!fill) fail('the disc has no fill="url(...)" for the square badge to reuse');
  return (
    `<defs>${gradient}</defs>` +
    `<rect x="${SQUARE_INSET}" y="${SQUARE_INSET}" width="${SQUARE_SIDE}" ` +
    `height="${SQUARE_SIDE}" rx="${SQUARE_RADIUS}" fill="${fill}"/>` +
    `<g fill="#fff">${mark}</g>`
  );
}

// The document icon: a page with a dog-eared corner carrying the app icon as a
// badge. The page keeps a hairline border so it still reads against a light
// background now that the drop shadow is gone.
function documentArt(art) {
  const badge = 56;
  const scale = badge / DISC_DIAMETER;
  return svg(
    "0 0 128 128",
    `<defs>${art.gradient}</defs>` +
      `<path d="M24 8 H82 L104 30 V120 H24 Z" fill="#ffffff" stroke="#d4d4d4" ` +
      `stroke-width="1.5" stroke-linejoin="round"/>` +
      `<path d="M82 8 L104 30 H82 Z" fill="#e6e6e6" stroke="#d4d4d4" ` +
      `stroke-width="1.5" stroke-linejoin="round"/>` +
      `<g transform="translate(64 72) scale(${scale}) translate(-64 -64)">` +
      `${art.disc}<g fill="#fff">${art.mark}</g></g>`,
  );
}

// Start-menu tiles are white-on-transparent; Windows composites them over the
// manifest's BackgroundColor, so the gold disc is deliberately absent here.
function tileArt({ mark }) {
  return svg(
    "0 0 128 128",
    `<g fill="#fff" transform="translate(64 64) scale(${MARK_FRACTION}) translate(-64 -64)">` +
      `${mark}</g>`,
  );
}

// 164x314, MUI_WELCOMEFINISHPAGE_BITMAP (and, since uninstallerSidebar is left
// unset, MUI_UNWELCOMEFINISHPAGE_BITMAP too). The gradient's cx/cy/r are
// objectBoundingBox units, so filling a 164x314 rect stretches the icon's
// circular falloff into an ellipse matching the panel — which is what a
// full-bleed brand panel wants.
function sidebarArt({ gradient, mark }) {
  return svg(
    "0 0 164 314",
    `<defs>${gradient}</defs>` +
      `<rect width="164" height="314" fill="url(#lumine-gold)"/>` +
      `<g fill="#fff" transform="translate(34 75) scale(0.75)">${mark}</g>` +
      `<text x="82" y="215" fill="#fff" text-anchor="middle" letter-spacing="0.5" ` +
      `font-family="${WORDMARK_FAMILY}" font-weight="${WORDMARK_WEIGHT}" ` +
      `font-size="${WORDMARK_SIZE}">Lumine</text>`,
  );
}

// 150x57, MUI_HEADERIMAGE_BITMAP, drawn top-right against MUI2's white page
// background (electron-builder does not override MUI_BGCOLOR). This one uses
// the full icon, gold disc included: the white-only mark would be invisible.
function headerArt({ gradient, disc, mark }) {
  return svg(
    "0 0 150 57",
    `<defs>${gradient}</defs>` +
      `<rect width="150" height="57" fill="#ffffff"/>` +
      `<g transform="translate(99 8) scale(0.3203125)">${disc}<g fill="#fff">${mark}</g></g>`,
  );
}

// --- asset table -------------------------------------------------------------

// Windows ICO and macOS ICNS both take PNG payloads at every slice, which is
// what the previously committed files did too.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const LINUX_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 384];
// ic11/ic12/ic13/ic14 are the @2x companions of 16/32/128/256.
const ICNS_SLICES = [
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic09", size: 512 },
  { type: "ic10", size: 1024 },
  { type: "ic11", size: 32 },
  { type: "ic12", size: 64 },
  { type: "ic13", size: 256 },
  { type: "ic14", size: 512 },
];

function assetList(art) {
  const appIcon = appArt(art);
  const documentIcon = documentArt(art);
  const tile = tileArt(art);
  const raw = rawBody(art);
  const square = squareBody(art);

  return [
    // --- application icon ---
    { file: "resources/app-icons/lumine.png", kind: "png", markup: appIcon, size: 1024 },
    { file: "resources/app-icons/lumine.ico", kind: "ico", markup: appIcon, sizes: ICO_SIZES },
    { file: "resources/app-icons/lumine.icns", kind: "icns", markup: appIcon },
    ...LINUX_SIZES.map((size) => ({
      file: `resources/icons/${size}x${size}.png`,
      kind: "png",
      markup: appIcon,
      size,
    })),

    // --- raw mark ---
    // Generated rather than drawn by hand for the reason the whole script
    // exists: the copy of the logo the website keeps has already drifted from
    // this one, and a second hand-maintained vector would drift the same way.
    // The PNG is what GitHub takes — it rejects SVG for an avatar — at 1024 to
    // match lumine.png and clear the 500px minimum with room to spare.
    {
      file: "resources/app-icons/lumine-raw.svg",
      kind: "svg",
      markup: svgDocument("0 0 128 128", 128, raw),
    },
    {
      file: "resources/app-icons/lumine-raw.png",
      kind: "png",
      markup: svg("0 0 128 128", raw),
      size: 1024,
    },

    // --- square badge ---
    // The disc's own gold and mark, on a rounded rect instead of a circle, for
    // any context that wants a square icon rather than a floating circular one.
    {
      file: "resources/app-icons/lumine-square.svg",
      kind: "svg",
      markup: svgDocument("0 0 128 128", 128, square),
    },
    {
      file: "resources/app-icons/lumine-square.png",
      kind: "png",
      markup: svg("0 0 128 128", square),
      size: 1024,
    },

    // --- document icon ---
    { file: "resources/win/file.ico", kind: "ico", markup: documentIcon, sizes: ICO_SIZES },
    { file: "resources/mac/file.icns", kind: "icns", markup: documentIcon },

    // --- Windows installer ---
    {
      file: "resources/win/installerSidebar.bmp",
      kind: "bmp",
      markup: sidebarArt(art),
      width: 164,
      height: 314,
      background: "#ffffff",
    },
    {
      file: "resources/win/installerHeader.bmp",
      kind: "bmp",
      markup: headerArt(art),
      width: 150,
      height: 57,
      background: "#ffffff",
    },

    // --- Start-menu tiles ---
    // Sized at the 200% plateau so Windows only ever scales down. There are no
    // .scale-* variants on purpose: scale-qualified lookup resolves only
    // through MRM, which needs a Resources.pri built by the Windows SDK's
    // makepri.exe. Mozilla tried that route in bug 1283909 and abandoned it.
    {
      file: "resources/win/visualElements/Square150x150Logo.png",
      kind: "png",
      markup: tile,
      size: 300,
    },
    {
      file: "resources/win/visualElements/Square70x70Logo.png",
      kind: "png",
      markup: tile,
      size: 140,
    },
  ];
}

// The two runtime assets a run-mode variant needs: the app icon (the window
// and dock icon src/lumine-window.js swaps between at launch) and the square
// badge (for any context that wants a square rather than a circle). Everything
// else in assetList() is packaging-time art that exists once, gold, regardless
// of which mode the running app happens to be in — a release is one build, not
// three, so the document icon, the installer bitmaps and the Start-menu tiles
// never vary by mode.
function modeVariantAssets(art, name) {
  return [
    {
      file: `resources/app-icons/lumine-${name}.png`,
      kind: "png",
      markup: appArt(art),
      size: 1024,
    },
    {
      file: `resources/app-icons/lumine-square-${name}.png`,
      kind: "png",
      markup: svg("0 0 128 128", squareBody(art)),
      size: 1024,
    },
  ];
}

// --- render harness ---------------------------------------------------------

// All of these must be set before app.whenReady(). disableHardwareAcceleration
// is the biggest reproducibility lever: GPU and CPU raster anti-alias
// differently, and pinning CPU raster makes the output a pure function of the
// Electron version.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("disable-lcd-text");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// The stage div carries the background, not the page: once <html> has one of
// its own, <body>'s no longer propagates to the canvas, and the capture rect is
// exactly the stage anyway.
const SHELL_HTML = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; overflow: hidden; }
  #stage { position: absolute; top: 0; left: 0; }
  svg { display: block; }
</style><div id="stage"></div>`;

async function openStage() {
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: STAGE,
    height: STAGE,
    // width/height are the viewport, not the outer frame; frameless also
    // sidesteps the Windows minimum-window-width clamp.
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      zoomFactor: 1,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SHELL_HTML)}`);
  win.webContents.setZoomFactor(1);
  win.webContents.setVisualZoomLevelLimits(1, 1);
  // The window has to be genuinely on screen: this Chromium serves a hidden or
  // occluded window's requestAnimationFrame from a ~1 Hz synthetic tick source
  // regardless of `backgroundThrottling: false`, which would stall the frame
  // wait in capture(). Same trap, same fix as src/initialize-test-window.js.
  win.showInactive();
  return win;
}

// document.fonts.check() is useless for this: it inspects the FontFaceSet, and
// a system font that is absent still resolves through fallback, so it answers
// true for a face that will not be used. Measuring against monospace does not
// lie — an absent family falls back to monospace and the widths match exactly.
async function assertWordmarkFont(win) {
  const available = await win.webContents.executeJavaScript(
    `(() => {
       const context = document.createElement("canvas").getContext("2d");
       context.font = '${WORDMARK_WEIGHT} 72px monospace';
       const fallback = context.measureText("Lumine").width;
       context.font = '${WORDMARK_WEIGHT} 72px "${WORDMARK_FAMILY}", monospace';
       return context.measureText("Lumine").width !== fallback;
     })()`,
  );
  if (!available) {
    fail(
      `the installer sidebar's wordmark needs ${WORDMARK_FAMILY} ${WORDMARK_WEIGHT}, which this ` +
        "machine does not have — regenerate on Windows (see the header of this script)",
    );
  }
}

async function capture(win, { markup, background, width, height }) {
  await win.webContents.executeJavaScript(
    `(() => {
       const stage = document.getElementById("stage");
       stage.style.background = ${JSON.stringify(background)};
       stage.style.width = ${JSON.stringify(`${width}px`)};
       stage.style.height = ${JSON.stringify(`${height}px`)};
       stage.innerHTML = ${JSON.stringify(markup)};
       return new Promise((resolve) => {
         requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
       });
     })()`,
  );

  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  const size = image.getSize();
  if (size.width !== width || size.height !== height) {
    fail(`captured ${size.width}x${size.height}, expected ${width}x${height}`);
  }
  const bitmap = image.toBitmap();
  // getSize() reports DIP, so it stays 164x314 even at a 1.5x device scale
  // while the buffer is 246x471. The byte count is the only honest check, and
  // the fix is never image.resize(): resampling a 1.5x capture is a different,
  // softer image and quietly non-reproducible.
  if (bitmap.length !== width * height * 4) {
    fail(
      `captured ${bitmap.length} bytes for ${width}x${height} ` +
        `(expected ${width * height * 4}) — the device scale factor is not 1`,
    );
  }
  return bitmap;
}

// Recovers straight-alpha RGBA by compositing the same art over black and over
// white. For a pixel of colour C and alpha a, the two results are C*a and
// C*a + 255*(1-a), so their difference gives alpha exactly and the black pass
// then gives the colour. Both passes are fully opaque, which also makes
// toBitmap()'s premultiplication a no-op — the arithmetic below is on true
// composited values, not premultiplied ones. This beats capturing a transparent
// window, whose behaviour on Windows is its own adventure.
async function captureRgba(win, { markup, width, height }, label) {
  const overBlack = await capture(win, { markup, background: "#000000", width, height });
  const overWhite = await capture(win, { markup, background: "#ffffff", width, height });
  assertOpaque(overBlack, label);
  assertOpaque(overWhite, label);

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < overBlack.length; i += 4) {
    // toBitmap() is BGRA; the output is RGBA.
    const alphas = [
      255 - (overWhite[i] - overBlack[i]),
      255 - (overWhite[i + 1] - overBlack[i + 1]),
      255 - (overWhite[i + 2] - overBlack[i + 2]),
    ];
    const spread = Math.max(...alphas) - Math.min(...alphas);
    if (spread > 3) {
      fail(
        `${label}: alpha disagrees across channels by ${spread} at byte ${i} — ` +
          "the two passes did not render the same geometry",
      );
    }
    const alpha = Math.max(0, Math.min(255, Math.round((alphas[0] + alphas[1] + alphas[2]) / 3)));
    // Fully transparent pixels keep white rather than black, so that a viewer
    // compositing without honouring alpha does not ring the art with dark edges.
    const unpremultiply = (value) =>
      alpha === 0 ? 255 : Math.max(0, Math.min(255, Math.round((value * 255) / alpha)));
    rgba[i] = unpremultiply(overBlack[i + 2]); // R
    rgba[i + 1] = unpremultiply(overBlack[i + 1]); // G
    rgba[i + 2] = unpremultiply(overBlack[i]); // B
    rgba[i + 3] = alpha;
  }
  return rgba;
}

// nativeImage.toBitmap()'s channel layout is documented as platform-dependent,
// so prove it once against a known colour before rendering anything real.
// Without this a layout change ships a blue-and-gold app icon in silence.
async function assertOpaqueBgra(win) {
  const probe = await capture(win, {
    markup: "",
    background: "rgb(255, 0, 0)",
    width: 2,
    height: 2,
  });
  if (probe[0] !== 0 || probe[1] !== 0 || probe[2] !== 255 || probe[3] !== 255) {
    fail(`nativeImage.toBitmap() is not opaque BGRA here: got ${[...probe.subarray(0, 4)]}`);
  }
}

// --- encoders ---------------------------------------------------------------

// A 24-bit BI_RGB, bottom-up BMP with a plain 40-byte BITMAPINFOHEADER: the
// only variant NSIS/MUI2 is proven to take. Every one of the 33 bitmaps NSIS
// itself ships under Contrib/Graphics is exactly this shape (bpp 4, 8 or 24;
// never 32). MUI2 blits the DIB into a static control and never alpha-blends,
// so a 32bpp file's alpha is not merely ignored — depending on visual style it
// renders as a black rectangle.
function encodeBmp24(bgra, width, height, background) {
  const rowSize = (width * 3 + 3) & ~3; // rows pad to a 4-byte boundary
  const pixelBytes = rowSize * height;
  // Buffer.alloc zero-fills, which is exactly what the row padding must be.
  const out = Buffer.alloc(54 + pixelBytes);

  // BITMAPFILEHEADER, 14 bytes
  out.write("BM", 0, "ascii"); //  0  bfType
  out.writeUInt32LE(54 + pixelBytes, 2); //  2  bfSize (whole file)
  out.writeUInt16LE(0, 6); //  6  bfReserved1
  out.writeUInt16LE(0, 8); //  8  bfReserved2
  out.writeUInt32LE(54, 10); // 10  bfOffBits = 14 + 40, no colour table

  // BITMAPINFOHEADER, 40 bytes
  out.writeUInt32LE(40, 14); // 14  biSize
  out.writeInt32LE(width, 18); // 18  biWidth
  out.writeInt32LE(height, 22); // 22  biHeight, positive => bottom-up
  out.writeUInt16LE(1, 26); // 26  biPlanes
  out.writeUInt16LE(24, 28); // 28  biBitCount
  out.writeUInt32LE(0, 30); // 30  biCompression = BI_RGB
  out.writeUInt32LE(pixelBytes, 34); // 34  biSizeImage
  out.writeInt32LE(2835, 38); // 38  biXPelsPerMeter (72dpi; NSIS ignores it)
  out.writeInt32LE(2835, 42); // 42  biYPelsPerMeter
  out.writeUInt32LE(0, 46); // 46  biClrUsed
  out.writeUInt32LE(0, 50); // 50  biClrImportant

  for (let y = 0; y < height; y++) {
    const src = y * width * 4; // capture row y, counting from the top
    const dst = 54 + (height - 1 - y) * rowSize; // same row, counting from the bottom
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + x * 3;
      const alpha = bgra[s + 3];
      if (alpha === 255) {
        out[d] = bgra[s]; // B
        out[d + 1] = bgra[s + 1]; // G
        out[d + 2] = bgra[s + 2]; // R
      } else {
        // toBitmap() hands back PREMULTIPLIED BGRA (Skia's kN32_kPremul), so
        // the source term is already scaled by alpha and only the background is
        // attenuated: out = src + bg*(1-a). Straight alpha would need
        // out = src*a + bg*(1-a) instead. assertOpaque() means this branch
        // never runs today; it exists so that if it ever does it is right
        // rather than subtly dark.
        const inv = 255 - alpha;
        out[d] = Math.min(255, bgra[s] + Math.round((background.b * inv) / 255));
        out[d + 1] = Math.min(255, bgra[s + 1] + Math.round((background.g * inv) / 255));
        out[d + 2] = Math.min(255, bgra[s + 2] + Math.round((background.r * inv) / 255));
      }
    }
  }
  return out;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  // The CRC covers the type and the data, not the length field. zlib.crc32 is
  // exactly PNG's CRC-32: zlib.crc32(Buffer.from("IEND")) === 0xae426082.
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Applies one filter type to every scanline, or picks per row by the smallest
// sum of absolute differences when `uniformType` is null.
function filterScanlines(rgba, width, height, uniformType) {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  const types = uniformType === null ? [0, 1, 2, 3, 4] : [uniformType];

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const previous = (y - 1) * stride;
    let best = null;
    let bestScore = Infinity;

    for (const type of types) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = rgba[row + i];
        const a = i >= bpp ? rgba[row + i - bpp] : 0;
        const b = y > 0 ? rgba[previous + i] : 0;
        const c = y > 0 && i >= bpp ? rgba[previous + i - bpp] : 0;
        let value;
        switch (type) {
          case 1:
            value = x - a;
            break;
          case 2:
            value = x - b;
            break;
          case 3:
            value = x - ((a + b) >> 1);
            break;
          case 4:
            value = x - paeth(a, b, c);
            break;
          default:
            value = x;
        }
        candidate[i] = value & 0xff;
        // Sum of absolute values treating each filtered byte as signed.
        score += candidate[i] < 128 ? candidate[i] : 256 - candidate[i];
      }
      if (score < bestScore) {
        bestScore = score;
        best = { type, bytes: Buffer.from(candidate) };
      }
    }

    out[y * (stride + 1)] = best.type;
    best.bytes.copy(out, y * (stride + 1) + 1);
  }
  return out;
}

// Deflate every filter strategy and keep whichever is actually smallest,
// rather than trusting a heuristic. The usual sum-of-absolute-differences rule
// is a heuristic about entropy, not about deflate: on this art it picks a
// different filter for nearly every row, which destroys the cross-row matches
// deflate lives on and comes out LARGER than no filtering at all. Six trial
// deflates cost a couple of seconds for a script run by hand, and they
// guarantee the committed binaries are never worse than the naive encoding.
function deflateSmallest(rgba, width, height) {
  let best = null;
  for (const type of [0, 1, 2, 3, 4, null]) {
    const deflated = zlib.deflateSync(filterScanlines(rgba, width, height, type), { level: 9 });
    if (best === null || deflated.length < best.length) best = deflated;
  }
  return best;
}

// Hand-rolled rather than nativeImage.toPNG(), whose bytes would drift with
// Electron's bundled libpng and which re-introduces the premultiply question.
function encodePngRgba(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSmallest(rgba, width, height)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ICONDIR + one ICONDIRENTRY per slice + the PNG payloads. PNG-compressed
// slices are read by every Windows since Vista, and Lumine's floor is Windows
// 10, so there is no reason to also emit the legacy BMP+AND-mask form.
function encodeIco(slices) {
  const directory = Buffer.alloc(6 + slices.length * 16);
  directory.writeUInt16LE(0, 0); // idReserved
  directory.writeUInt16LE(1, 2); // idType: 1 = icon
  directory.writeUInt16LE(slices.length, 4); // idCount

  let offset = directory.length;
  slices.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    // 256 is stored as 0 — the field is a single byte.
    directory[entry] = size >= 256 ? 0 : size; // bWidth
    directory[entry + 1] = size >= 256 ? 0 : size; // bHeight
    directory[entry + 2] = 0; // bColorCount: 0 = truecolour
    directory[entry + 3] = 0; // bReserved
    directory.writeUInt16LE(1, entry + 4); // wPlanes
    directory.writeUInt16LE(32, entry + 6); // wBitCount
    directory.writeUInt32LE(png.length, entry + 8); // dwBytesInRes
    directory.writeUInt32LE(offset, entry + 12); // dwImageOffset
    offset += png.length;
  });

  return Buffer.concat([directory, ...slices.map((slice) => slice.png)]);
}

// Every ICNS element is a 4-char type, a big-endian length that INCLUDES these
// 8 header bytes, then the payload. The file itself is one such element typed
// "icns" wrapping all the others.
function icnsElement(type, data) {
  const out = Buffer.alloc(8 + data.length);
  out.write(type, 0, "ascii");
  out.writeUInt32BE(8 + data.length, 4);
  data.copy(out, 8);
  return out;
}

function encodeIcns(slices) {
  const elements = slices.map(({ type, png }) => icnsElement(type, png));
  // The optional "TOC " element repeats each following element's type and
  // length so a reader can seek without walking the file.
  const toc = Buffer.alloc(elements.length * 8);
  elements.forEach((element, index) => element.copy(toc, index * 8, 0, 8));
  return icnsElement("icns", Buffer.concat([icnsElement("TOC ", toc), ...elements]));
}

// --- capture assertions -----------------------------------------------------

function assertOpaque(bgra, label) {
  for (let i = 3; i < bgra.length; i += 4) {
    if (bgra[i] !== 255) fail(`${label}: capture is not fully opaque at byte ${i}`);
  }
}

// A uniform frame is what a missed composite looks like, and it is otherwise
// indistinguishable from a legitimate render at the smaller sizes.
function assertNotUniform(bgra, label) {
  for (let i = 4; i < bgra.length; i += 4) {
    if (bgra[i] !== bgra[0] || bgra[i + 1] !== bgra[1] || bgra[i + 2] !== bgra[2]) return;
  }
  fail(`${label}: every pixel is ${bgra[2]},${bgra[1]},${bgra[0]} — the frame never composited`);
}

// The gradient's last stop, #9a6214, is what the sidebar's far corner clamps
// to. Getting something else there means the gradient did not resolve — the
// likeliest cause being a lumine.svg edit that renamed the `lumine-gold` id.
function assertSidebarGradient(bgra, width, height) {
  const corner = (height - 1) * width * 4 + (width - 1) * 4;
  const actual = { b: bgra[corner], g: bgra[corner + 1], r: bgra[corner + 2] };
  const off = Math.abs(actual.b - 0x14) + Math.abs(actual.g - 0x62) + Math.abs(actual.r - 0x9a);
  if (off > 12) {
    fail(
      `installerSidebar.bmp: far corner is rgb(${actual.r},${actual.g},${actual.b}), ` +
        "expected the gradient's final stop rgb(154,98,20) — did lumine.svg's gradient id change?",
    );
  }
}

// Transparent art must actually be transparent at the corners, and opaque
// somewhere in the middle. Catches both a stray background rect and a render
// that produced nothing at all.
function assertTransparentEdges(rgba, width, height, label) {
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, (height * width - 1) * 4];
  for (const corner of corners) {
    if (rgba[corner + 3] !== 0) {
      fail(
        `${label}: corner alpha is ${rgba[corner + 3]}, expected 0 — the art is not transparent`,
      );
    }
  }
  const centre = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  if (rgba[centre + 3] === 0) fail(`${label}: the centre pixel is transparent — nothing rendered`);
}

// --- main -------------------------------------------------------------------

const BACKGROUNDS = {
  "#ffffff": { r: 255, g: 255, b: 255 },
  "#000000": { r: 0, g: 0, b: 0 },
};

async function renderPng(win, markup, size, label) {
  const rgba = await captureRgba(win, { markup, width: size, height: size }, label);
  assertTransparentEdges(rgba, size, size, label);
  return encodePngRgba(rgba, size, size);
}

async function renderAsset(win, asset) {
  const label = path.basename(asset.file);
  switch (asset.kind) {
    case "bmp": {
      const bgra = await capture(win, asset);
      assertOpaque(bgra, label);
      assertNotUniform(bgra, label);
      if (label === "installerSidebar.bmp") {
        assertSidebarGradient(bgra, asset.width, asset.height);
      }
      return encodeBmp24(bgra, asset.width, asset.height, BACKGROUNDS[asset.background]);
    }
    case "png":
      return renderPng(win, asset.markup, asset.size, label);
    // Nothing to rasterize: the markup is the file. It still goes through the
    // asset table so --check covers it and it lands beside the art it derives
    // from.
    case "svg":
      return Buffer.from(asset.markup, "utf8");
    case "ico": {
      const slices = [];
      for (const size of asset.sizes) {
        slices.push({ size, png: await renderPng(win, asset.markup, size, `${label} @${size}`) });
      }
      return encodeIco(slices);
    }
    case "icns": {
      // Several slices share a pixel size (ic08/ic13 are both 256), so render
      // each size once and reuse the bytes.
      const rendered = new Map();
      const slices = [];
      for (const { type, size } of ICNS_SLICES) {
        if (!rendered.has(size)) {
          rendered.set(size, await renderPng(win, asset.markup, size, `${label} @${size}`));
        }
        slices.push({ type, png: rendered.get(size) });
      }
      return encodeIcns(slices);
    }
    default:
      return fail(`${label}: unknown asset kind ${asset.kind}`);
  }
}

async function main() {
  const options = parseArgs(scriptArgs(process.argv));
  const art = readMasterArt(MASTER_SVG);
  const assets = assetList(art);
  for (const variant of MODE_VARIANTS) {
    assets.push(...modeVariantAssets(readMasterArt(variant.svg), variant.name));
  }

  const win = await openStage();
  await assertOpaqueBgra(win);
  await assertWordmarkFont(win);

  const rendered = [];
  for (const asset of assets) {
    rendered.push({ ...asset, bytes: await renderAsset(win, asset) });
  }
  win.destroy();

  if (options.check) {
    let drifted = 0;
    for (const asset of rendered) {
      const target = path.join(REPO_ROOT, asset.file);
      const committed = fs.existsSync(target) ? fs.readFileSync(target) : null;
      let state = "ok";
      if (committed === null) state = "missing";
      else if (!committed.equals(asset.bytes)) state = "differs";
      if (state !== "ok") drifted++;
      console.log(`  ${state.padEnd(8)} ${asset.file}`);
    }
    console.log(
      `branding: ${rendered.length} assets checked, ${drifted} out of date` +
        (drifted > 0 ? " — run `npm run generate:branding`" : ""),
    );
    app.exit(drifted > 0 ? 1 : 0);
    return;
  }

  for (const asset of rendered) {
    const target = path.join(options.outDir, asset.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, asset.bytes);
    console.log(`  ${String(asset.bytes.length).padStart(8)}  ${asset.file}`);
  }
  const sources = [MASTER_SVG, ...MODE_VARIANTS.map((v) => v.svg)].map((p) => path.basename(p));
  console.log(`branding: ${rendered.length} assets written from ${sources.join(", ")}`);
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(`ERROR: ${error instanceof Fail ? error.message : (error.stack ?? error)}`);
    app.exit(1);
  }),
);
