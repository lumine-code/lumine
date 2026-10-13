// Marketing art shares the website's palette and full-length rules. The logo
// is supplied by generate-branding.js from the canonical application SVG.
const PALETTES = {
  light: { bg: "#f2f1ee", ink: "#161616", muted: "#69665f", line: "#ccc9c0", gold: "#8a5900" },
  dark: { bg: "#171716", ink: "#f2f1ee", muted: "#aaa79d", line: "#45443e", gold: "#edbd52" },
};

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character];
  });
}

function document(width, height, title, palette, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${escapeXml(title)}</title>
  <rect width="${width}" height="${height}" fill="${palette.bg}"/>
  <g font-family="Segoe UI, sans-serif" fill="${palette.ink}">${body}</g>
</svg>
`;
}

function rules(width, height, palette, columns, rows) {
  const lines = [
    ...columns.map((x) => `M${x} 0V${height}`),
    ...rows.map((y) => `M0 ${y}H${width}`),
  ];
  return `<path d="${lines.join(" ")}" fill="none" stroke="${palette.line}" stroke-width="1"/>`;
}

function label(x, y, text, palette, anchor = "start") {
  return `<text x="${x}" y="${y}" fill="${palette.muted}" font-family="Consolas, monospace" font-size="20" letter-spacing="1.5" text-anchor="${anchor}">${escapeXml(text)}</text>`;
}

function logo(art, x, y, size) {
  return `<g transform="translate(${x} ${y}) scale(${size / 128})"><defs>${art.gradient}</defs>${art.disc}<g fill="#fff">${art.mark}</g></g>`;
}

function banner(art, palette, description) {
  return document(
    1600,
    600,
    `Lumine — ${description}`,
    palette,
    `${rules(1600, 600, palette, [64, 1120, 1536], [72, 488])}
    ${label(112, 45, "LUMINE / TEXT EDITOR", palette)}
    ${label(1488, 45, "OPEN SOURCE", palette, "end")}
    <text x="106" y="305" font-size="176" font-weight="600" letter-spacing="-9">Lumine</text>
    <text x="112" y="382" font-size="26">${escapeXml(description)}</text>
    ${logo(art, 1200, 152, 256)}
    <path d="M64 488H384" stroke="${palette.gold}" stroke-width="3"/>
    ${label(112, 552, "YOUR EDITOR. YOUR WAY.", palette)}
    ${label(1488, 552, "LUMINE-CODE.GITHUB.IO", palette, "end")}`,
  );
}

function wallpaper(art, palette) {
  return document(
    1920,
    1080,
    "Lumine wallpaper",
    palette,
    `${rules(1920, 1080, palette, [96, 608, 1312, 1824], [96, 900, 984])}
    ${label(136, 62, "LUMINE / WORKSPACE", palette)}
    ${logo(art, 880, 310, 160)}
    <text x="960" y="615" text-anchor="middle" font-size="112" font-weight="600" letter-spacing="-5">Lumine</text>
    ${label(960, 682, "YOUR EDITOR. YOUR WAY.", palette, "middle")}
    <path d="M96 900H352" stroke="${palette.gold}" stroke-width="3"/>
    ${label(136, 950, "OPEN SOURCE / EXTENSIBLE", palette)}
    ${label(1784, 950, "LUMINE-CODE.GITHUB.IO", palette, "end")}`,
  );
}

module.exports = function brandAssets(art, description) {
  return [
    { name: "banner", markup: banner(art, PALETTES.light, description), width: 1600, height: 600 },
    {
      name: "banner-dark",
      markup: banner(art, PALETTES.dark, description),
      width: 1600,
      height: 600,
    },
    { name: "wallpaper", markup: wallpaper(art, PALETTES.dark), width: 1920, height: 1080 },
    { name: "wallpaper-light", markup: wallpaper(art, PALETTES.light), width: 1920, height: 1080 },
  ].flatMap(({ name, ...asset }) => [
    { ...asset, file: `resources/brand/${name}.svg`, kind: "svg" },
    { ...asset, file: `resources/brand/${name}.png`, kind: "opaque-png", background: "#ffffff" },
  ]);
};

module.exports.PALETTES = PALETTES;
