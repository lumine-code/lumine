const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function externalUrlError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function normalizeExternalUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw externalUrlError("ERR_INVALID_EXTERNAL_URL", "External URL must be a non-empty string");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw externalUrlError("ERR_INVALID_EXTERNAL_URL", "External URL must be absolute and valid");
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    throw externalUrlError(
      "ERR_UNSUPPORTED_EXTERNAL_PROTOCOL",
      `External URL protocol "${url.protocol}" is not allowed`,
    );
  }

  return url.href;
}

module.exports = { ALLOWED_EXTERNAL_PROTOCOLS, normalizeExternalUrl };
