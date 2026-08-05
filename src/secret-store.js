const fs = require("fs");
const path = require("path");
const { Emitter } = require("event-kit");

// Public: Somewhere to keep an access token, available as `atom.secrets`.
//
// For the sensitive strings a package must remember between sessions — a
// forge token, an API key, a password. Never `atom.config`: everything in
// there is written to disk in plain text and shown in the settings view.
//
// Keys are opaque strings and values are strings. Namespace your own keys, by
// convention with the package name:
//
// ```js
// await atom.secrets.set('github.token', token)
// const token = await atom.secrets.get('github.token')
// ```
//
// ## Storage
//
// Values are encrypted with the operating system's own facility — DPAPI on
// Windows, the Keychain on macOS, libsecret or kwallet on Linux — and kept as
// base64 in one file under the config directory.
//
// Where the OS offers no encryption, typically a headless Linux box with no
// keyring, the store keeps values in memory for the session only and warns the
// user once. It never writes a secret to disk in the clear. A package should
// therefore expect {::get} to return `null` for something it stored in an
// earlier session, and ask again rather than fail.
class SecretStore {
  constructor({ safeStorage, storagePath, notify } = {}) {
    this._safeStorage = safeStorage;
    this.storagePath = storagePath;
    this.notify = notify || null;
    this.emitter = new Emitter();
    this.entries = null; // Map<key, base64 ciphertext>, loaded on first use
    this.memory = new Map(); // session-only fallback when encryption is off
    this.encryptionAvailable = null;
    this.warned = false;
  }

  get safeStorage() {
    if (this._safeStorage == null) {
      this._safeStorage = require("@electron/remote").safeStorage;
    }
    return this._safeStorage;
  }

  /*
  Section: Storing Secrets
  */

  // Extended: Whether the operating system will encrypt what is stored.
  //
  // When it will not, secrets last for this session only. Worth checking before
  // telling the user that a token has been saved — the first call warns them
  // once on its own.
  //
  // Returns a {Boolean}.
  isEncryptionAvailable() {
    if (this.encryptionAvailable === null) {
      try {
        this.encryptionAvailable = Boolean(this.safeStorage.isEncryptionAvailable());
      } catch {
        this.encryptionAvailable = false;
      }
      if (!this.encryptionAvailable) this.warnUnavailable();
    }
    return this.encryptionAvailable;
  }

  warnUnavailable() {
    if (this.warned) return;
    this.warned = true;
    const message =
      "Secret storage encryption is unavailable, so secrets such as access tokens are kept only for this session and are not saved to disk.";
    if (this.notify) {
      this.notify(message);
    } else {
      console.warn(message);
    }
  }

  loadEntries() {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, "utf8"));
      for (const key of Object.keys(parsed)) {
        if (typeof parsed[key] === "string") this.entries.set(key, parsed[key]);
      }
    } catch {
      // No store yet, or an unreadable/corrupt file: start empty.
    }
    return this.entries;
  }

  persistEntries() {
    const object = {};
    for (const [key, value] of this.loadEntries()) object[key] = value;
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    fs.writeFileSync(this.storagePath, JSON.stringify(object), { mode: 0o600 });
  }

  // Essential: Read a secret.
  //
  // * `key` The {String} key it was stored under.
  //
  // Returns a {Promise} that resolves to the {String} value, or to `null` when
  // nothing is stored under the key or it can no longer be decrypted — which
  // happens after the OS credential store is reset, or when this session has no
  // encryption and an earlier one did.
  async get(key) {
    if (!this.isEncryptionAvailable()) {
      return this.memory.has(key) ? this.memory.get(key) : null;
    }
    const ciphertext = this.loadEntries().get(key);
    if (ciphertext == null) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
    } catch {
      return null;
    }
  }

  // Essential: Store a secret.
  //
  // * `key` The {String} key to store it under.
  // * `value` The {String} to store. `null` or `undefined` deletes the key, as
  //   {::delete} would.
  //
  // Returns a {Promise} that resolves once the value is written.
  async set(key, value) {
    if (value == null) return this.delete(key);
    if (!this.isEncryptionAvailable()) {
      this.memory.set(key, String(value));
      this.emitter.emit("did-change", { key });
      return;
    }
    const ciphertext = this.safeStorage.encryptString(String(value)).toString("base64");
    this.loadEntries().set(key, ciphertext);
    this.persistEntries();
    this.emitter.emit("did-change", { key });
  }

  // Public: Forget a secret.
  //
  // Deleting a key that was never stored is not an error and emits nothing.
  //
  // * `key` The {String} key to remove.
  //
  // Returns a {Promise} that resolves once the key is gone.
  async delete(key) {
    let changed = this.memory.delete(key);
    if (this.loadEntries().delete(key)) {
      this.persistEntries();
      changed = true;
    }
    if (changed) this.emitter.emit("did-change", { key });
  }

  /*
  Section: Event Subscription
  */

  // Public: Invoke the callback when a secret is stored or removed.
  //
  // The event names the key but never carries the value; read it with {::get}
  // if you need it.
  //
  // * `callback` {Function} called with an {Object}.
  //   * `key` The {String} key that changed.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  dispose() {
    this.emitter.dispose();
  }
}

module.exports = SecretStore;
