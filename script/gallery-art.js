const fs = require("node:fs");
const path = require("node:path");
const { PALETTES } = require("./brand-art");

const WIDTH = 1600;
const ROW_HEIGHT = 1088;

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character];
  });
}

module.exports = function galleryAssets(root) {
  const directory = path.join(root, ".github", "gallery");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "captures.json"), "utf8"));
  const scenes = manifest.scenes.map((scene) => {
    if (path.basename(scene.file) !== scene.file || !scene.file.endsWith(".png")) {
      throw new Error(`Invalid gallery capture name: ${scene.file}`);
    }
    return {
      ...scene,
      image: fs.readFileSync(path.join(directory, scene.file)).toString("base64"),
    };
  });
  return Object.entries(PALETTES).flatMap(([theme, palette]) =>
    scenes.map((scene) => {
      if (!new RegExp(`^\\d{2}-${theme}\\.png$`).test(scene[theme])) {
        throw new Error(`Invalid gallery panel name: ${scene[theme]}`);
      }
      const panel = `<g>
        <path d="M0 0H1600" stroke="${palette.line}"/>
        <text x="96" y="42" font-family="Consolas, monospace" font-size="20" letter-spacing="1.5" fill="${palette.muted}">${escapeXml(scene.label)}</text>
        <text x="96" y="94" font-size="40" font-weight="600" letter-spacing="-1">${escapeXml(scene.title)}</text>
        <text x="96" y="132" font-size="24" fill="${palette.muted}">${escapeXml(scene.description)}</text>
        <defs><clipPath id="capture"><rect x="96" y="160" width="1408" height="880" rx="12"/></clipPath></defs>
        <rect x="95.5" y="159.5" width="1409" height="881" rx="12.5" fill="none" stroke="${palette.line}"/>
        <image x="96" y="160" width="1408" height="880" preserveAspectRatio="xMidYMid meet" clip-path="url(#capture)" href="data:image/png;base64,${scene.image}"/>
      </g>`;
      return {
        file: `.github/gallery/${scene[theme]}`,
        kind: "canvas-png",
        width: WIDTH,
        height: ROW_HEIGHT,
        markup: `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${ROW_HEIGHT}" viewBox="0 0 ${WIDTH} ${ROW_HEIGHT}">
        <rect width="${WIDTH}" height="${ROW_HEIGHT}" fill="${palette.bg}"/>
        <path d="M64 0V${ROW_HEIGHT}M1536 0V${ROW_HEIGHT}" stroke="${palette.line}"/>
        <path d="M64 0V${ROW_HEIGHT}" stroke="${palette.gold}" stroke-opacity="0.5"/>
        <g font-family="Segoe UI, sans-serif" fill="${palette.ink}">${panel}</g>
        <text x="96" y="1072" font-family="Consolas, monospace" font-size="16" fill="${palette.muted}">LUMINE / EDITOR</text>
        <text x="1504" y="1072" text-anchor="end" font-family="Consolas, monospace" font-size="16" fill="${palette.muted}">CAPTURED ${escapeXml(scene.capturedOn || manifest.capturedOn)}</text>
      </svg>`,
      };
    }),
  );
};
