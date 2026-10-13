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
    if (path.basename(scene.file) !== scene.file || !scene.file.endsWith(".jpg")) {
      throw new Error(`Invalid gallery capture name: ${scene.file}`);
    }
    return {
      ...scene,
      image: fs.readFileSync(path.join(directory, scene.file)).toString("base64"),
    };
  });
  const height = ROW_HEIGHT * scenes.length + 72;

  return Object.entries(PALETTES).map(([theme, palette]) => {
    const rows = scenes.map((scene, index) => {
      const y = index * ROW_HEIGHT;
      return `<g transform="translate(0 ${y})">
        <path d="M0 0H1600" stroke="${palette.line}"/>
        <text x="96" y="42" font-family="Consolas, monospace" font-size="20" letter-spacing="1.5" fill="${palette.muted}">${escapeXml(scene.label)}</text>
        <text x="96" y="94" font-size="40" font-weight="600" letter-spacing="-1">${escapeXml(scene.title)}</text>
        <text x="96" y="132" font-size="24" fill="${palette.muted}">${escapeXml(scene.description)}</text>
        <rect x="95.5" y="159.5" width="1409" height="881" fill="${palette.line}"/>
        <image x="96" y="160" width="1408" height="880" preserveAspectRatio="xMidYMid meet" href="data:image/jpeg;base64,${scene.image}"/>
      </g>`;
    });

    return {
      file: `.github/gallery/gallery-${theme}.png`,
      kind: "canvas-png",
      width: WIDTH,
      height,
      markup: `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
        <rect width="${WIDTH}" height="${height}" fill="${palette.bg}"/>
        <path d="M64 0V${height}M1536 0V${height}" stroke="${palette.line}"/>
        <path d="M64 0V${height}" stroke="${palette.gold}" stroke-opacity="0.5"/>
        <g font-family="Segoe UI, sans-serif" fill="${palette.ink}">${rows.join("\n")}</g>
        <path d="M0 ${height - 72}H1600" stroke="${palette.line}"/>
        <text x="96" y="${height - 28}" font-family="Consolas, monospace" font-size="20" fill="${palette.muted}">LUMINE / DEVELOPMENT BUILD</text>
        <text x="1504" y="${height - 28}" text-anchor="end" font-family="Consolas, monospace" font-size="20" fill="${palette.muted}">CAPTURED ${escapeXml(manifest.capturedOn)}</text>
      </svg>`,
    };
  });
};
