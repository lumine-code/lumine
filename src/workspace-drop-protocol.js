const crypto = require("crypto");

const PROTOCOL_VERSION = 1;
const MIME_PREFIX = "application/x-lumine-drag";

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value))];
}

function dataTransferTypes(dataTransfer) {
  const types = Array.from(dataTransfer?.types || []);
  for (const item of Array.from(dataTransfer?.items || [])) {
    if (item?.type && !types.includes(item.type)) types.push(item.type);
  }
  return types;
}

function nativeSummary(dataTransfer) {
  let hasFileItems = false;
  let hasFiles = false;
  let hasDirectories = false;
  let known = true;
  for (const item of Array.from(dataTransfer?.items || [])) {
    if (item?.kind !== "file") continue;
    hasFileItems = true;
    const getEntry = item.getAsEntry || item.webkitGetAsEntry;
    let entry = null;
    try {
      entry = getEntry?.call(item) || null;
    } catch {
      // Chromium deliberately hides native entry details in protected mode.
    }
    if (!entry) known = false;
    else if (entry.isDirectory) hasDirectories = true;
    else if (entry.isFile) hasFiles = true;
    else known = false;
  }
  if (!hasFileItems && (dataTransfer?.files?.length || 0) > 0) {
    hasFileItems = true;
    known = false;
  }
  return { hasFileItems, hasFiles, hasDirectories, known };
}

function normalizeDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new TypeError("A workspace drag descriptor must be an object");
  }
  if (typeof descriptor.kind !== "string" || !descriptor.kind) {
    throw new TypeError("A workspace drag descriptor must have a kind");
  }
  const source =
    descriptor.source && typeof descriptor.source === "object" ? descriptor.source : {};
  const normalized = {
    ...descriptor,
    version: PROTOCOL_VERSION,
    id:
      descriptor.id ||
      descriptor.token ||
      crypto.randomUUID?.() ||
      crypto.randomBytes(16).toString("hex"),
    effect: ["copy", "move", "copyMove"].includes(descriptor.effect) ? descriptor.effect : "copy",
    allowedLocations: uniqueStrings(descriptor.allowedLocations || ["center"]),
    source: { ...source },
    items: Array.isArray(descriptor.items) ? descriptor.items : [],
  };
  if (normalized.allowedLocations.length === 0) normalized.allowedLocations = ["center"];
  return normalized;
}

function mimeTypeForDescriptor(descriptor) {
  const fields = [
    `v=${PROTOCOL_VERSION}`,
    `k=${encodeURIComponent(descriptor.kind)}`,
    `e=${encodeURIComponent(descriptor.effect)}`,
    `l=${descriptor.allowedLocations.map(encodeURIComponent).join(".")}`,
  ];
  if (descriptor.token) fields.push(`t=${encodeURIComponent(descriptor.token)}`);
  if (descriptor.source?.windowId != null) fields.push(`w=${descriptor.source.windowId}`);
  if (descriptor.source?.paneId != null) fields.push(`p=${descriptor.source.paneId}`);
  if (descriptor.source?.onlyItem) fields.push("o=1");
  if (descriptor.items.some((item) => item?.type === "file")) fields.push("f=1");
  if (descriptor.items.some((item) => item?.type === "directory")) fields.push("d=1");
  return `${MIME_PREFIX};${fields.join(";")}`;
}

function parseMimeType(type) {
  if (typeof type !== "string" || !type.toLowerCase().startsWith(`${MIME_PREFIX};`)) return null;
  const fields = Object.create(null);
  try {
    for (const part of type.slice(MIME_PREFIX.length + 1).split(";")) {
      const separator = part.indexOf("=");
      if (separator > 0) {
        fields[part.slice(0, separator)] = decodeURIComponent(part.slice(separator + 1));
      }
    }
  } catch {
    return null;
  }
  if (Number(fields.v) !== PROTOCOL_VERSION || !fields.k) return null;
  const offer = {
    type,
    version: PROTOCOL_VERSION,
    kind: fields.k,
    effect: fields.e || "copy",
    allowedLocations: fields.l ? fields.l.split(".") : ["center"],
    token: fields.t,
    files: fields.f === "1",
    directories: fields.d === "1",
    source: {},
  };
  if (fields.w != null) offer.source.windowId = Number(fields.w);
  if (fields.p != null) offer.source.paneId = Number(fields.p);
  if (fields.o === "1") offer.source.onlyItem = true;
  return offer;
}

function write(dataTransfer, descriptor) {
  const normalized = normalizeDescriptor(descriptor);
  for (const type of dataTransferTypes(dataTransfer)) {
    if (type.toLowerCase().startsWith(MIME_PREFIX)) dataTransfer.clearData?.(type);
  }
  const type = mimeTypeForDescriptor(normalized);
  dataTransfer.setData(type, JSON.stringify(normalized));
  return normalized;
}

function inspect(dataTransfer) {
  for (const type of dataTransferTypes(dataTransfer)) {
    const offer = parseMimeType(type);
    if (offer) return offer;
  }
  if (nativeSummary(dataTransfer).hasFileItems) {
    return {
      version: PROTOCOL_VERSION,
      kind: "native-paths",
      effect: "copy",
      allowedLocations: ["center"],
      native: true,
    };
  }
  return null;
}

function read(dataTransfer) {
  const offer = inspect(dataTransfer);
  if (!offer || offer.native) return null;
  try {
    const parsed = JSON.parse(dataTransfer.getData(offer.type));
    if (parsed?.version !== PROTOCOL_VERSION) return null;
    const descriptor = normalizeDescriptor(parsed);
    if (descriptor.kind !== offer.kind) return null;
    return descriptor;
  } catch {
    return null;
  }
}

module.exports = {
  PROTOCOL_VERSION,
  MIME_PREFIX,
  inspect,
  mimeTypeForDescriptor,
  nativeSummary,
  normalizeDescriptor,
  parseMimeType,
  read,
  uniqueStrings,
  write,
};
