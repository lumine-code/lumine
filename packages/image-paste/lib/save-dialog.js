const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const INFO = "Enter a path relative to the current project or directory for the pasted image.";

module.exports = class SaveDialog {
  constructor({ nativeImage }) {
    this.nativeImage = nativeImage;

    // One stable node, reused across pastes: its `src` is a function of the
    // pasted image, not of what is typed, so it belongs in the content slot
    // rather than being rebuilt per keystroke.
    this.previewElement = document.createElement("div");
    this.previewElement.classList.add("image-paste-preview");

    this.warningElement = document.createElement("div");
    this.warningElement.classList.add("image-paste-warning");
    this.warningElement.setAttribute("role", "alert");
    this.previewElement.appendChild(this.warningElement);

    this.imageElement = document.createElement("img");
    this.imageElement.alt = "Clipboard image preview";
    this.previewElement.appendChild(this.imageElement);
  }

  destroy() {
    if (this.session) this.session.cancel("api");
  }

  prepare({ target, pngBuffer, sourceName = null }) {
    this.target = target;
    this.pngBuffer = Buffer.from(pngBuffer);

    const hash = crypto.createHash("md5").update(this.pngBuffer).digest("hex").slice(0, 8);
    let initialPath;
    if (target.type === "text-editor") {
      const selectedText = target.editor.getSelectedText();
      if (selectedText && !selectedText.includes("\n")) {
        initialPath = selectedText;
      } else {
        const editorName = target.editor.getPath()
          ? path.parse(target.editor.getPath()).name
          : "image";
        initialPath = path.join(
          atom.config.get("image-paste.assetsDirectory"),
          `${editorName}-${hash}.png`,
        );
      }
    } else {
      initialPath = sourceName || `${hash}.png`;
    }

    initialPath = this.normalizeImagePath(initialPath);
    if (atom.config.get("image-paste.forwardSlash")) {
      initialPath = initialPath.replace(/\\/g, "/");
    }

    this.clearWarning();
    this.imageElement.src = atom.config.get("image-paste.imagePreview")
      ? `data:image/png;base64,${this.pngBuffer.toString("base64")}`
      : "";

    return atom.modals.open({
      id: "image-paste.save",
      template: "input",
      className: "image-paste save-dialog",
      content: this.previewElement,
      value: initialPath,
      valueSelection: this.baseNameRange(initialPath),
      willOpen: (session) => {
        this.session = session;
        session.setStatus({ message: INFO, severity: "info" });
      },
      didClose: () => {
        this.session = null;
      },
      didChangeQuery: () => this.clearWarning(),
      actions: [
        {
          name: "confirm",
          label: "Save image",
          when: "always",
          // Writing the file blocks further confirms rather than needing a
          // hand-rolled `saving` flag to swallow the second Enter.
          busy: "block",
          run: (ctx) => this.confirm(ctx),
        },
      ],
    });
  }

  clearWarning() {
    this.overwritePath = null;
    this.warningElement.textContent = "";
  }

  warn(message) {
    this.warningElement.textContent = message;
  }

  baseNameRange(relativePath) {
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const slashIndex = normalizedPath.lastIndexOf("/");
    const extensionLength = path.extname(normalizedPath).length;
    return [slashIndex + 1, normalizedPath.length - extensionLength];
  }

  normalizeImagePath(relativePath) {
    relativePath = String(relativePath)
      .trim()
      .replace(/[<>:"|?*\0]/g, "");
    const extension = path.extname(relativePath).toLowerCase();
    if ([".png", ".jpg", ".jpeg"].includes(extension)) return relativePath;
    if (extension) return relativePath.slice(0, -extension.length) + ".png";
    return relativePath + ".png";
  }

  async confirm({ query }) {
    if (!this.target || !this.pngBuffer) return;

    const relativePath = this.normalizeImagePath(query.raw);
    if (path.isAbsolute(relativePath)) {
      this.warn("Enter a path relative to the selected project or directory.");
      return { keepOpen: true };
    }

    const filePath = path.resolve(this.target.basePath, relativePath);
    const pathFromBase = path.relative(this.target.basePath, filePath);
    if (pathFromBase.startsWith(".." + path.sep) || path.isAbsolute(pathFromBase)) {
      this.warn("The image must remain inside the selected project or directory.");
      return { keepOpen: true };
    }
    if (!path.basename(filePath)) return { keepOpen: true };

    // Overwriting takes a second Enter, and the path it applies to is
    // remembered so editing the path arms the guard again.
    if (fs.existsSync(filePath) && this.overwritePath !== filePath) {
      this.overwritePath = filePath;
      this.warn("The file already exists. Confirm again to overwrite it.");
      return { keepOpen: true };
    }

    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const extension = path.extname(filePath).toLowerCase();
      const imageBuffer = [".jpg", ".jpeg"].includes(extension)
        ? this.nativeImage.createFromBuffer(this.pngBuffer).toJPEG(95)
        : this.pngBuffer;
      await fs.promises.writeFile(filePath, imageBuffer);

      const editor = this.target.editor;
      if (editor && !editor.isDestroyed()) {
        const editorDirectory = editor.getPath()
          ? path.dirname(editor.getPath())
          : this.target.basePath;
        let insertionPath = path.relative(editorDirectory, filePath);
        if (atom.config.get("image-paste.forwardSlash")) {
          insertionPath = insertionPath.replace(/\\/g, "/");
        }
        editor.insertText(insertionPath);
      }
    } catch (error) {
      atom.notifications.addError("Unable to save the clipboard image.", {
        detail: error.message,
        dismissable: true,
      });
      return { keepOpen: true };
    }
  }
};
