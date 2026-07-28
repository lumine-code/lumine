const jschardet = require("jschardet");
const fs = require("fs");

module.exports = class EncodingListView {
  constructor(encodings) {
    this.encodings = encodings;
  }

  destroy() {}

  getEncodingItems(editor) {
    const items = [];
    if (fs.existsSync(editor.getPath())) {
      items.push({ id: "detect", name: "Auto Detect" });
    }
    for (const id in this.encodings) {
      items.push({ id, name: this.encodings[id].list });
    }
    return items;
  }

  toggle() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return null;

    const currentEncoding = editor.getEncoding();

    return atom.modals.toggle({
      id: "encoding-selector.encodings",
      className: "encoding-selector",
      placeholder: "Select an encoding",
      markActive: true,
      source: this.getEncodingItems(editor),
      renderer: {
        entry: (encoding) => ({ id: encoding.id, text: encoding.name }),
        row: (encoding) => ({
          label: encoding.name,
          active: encoding.id === currentEncoding,
          dataset: { encoding: encoding.id },
        }),
      },
      confirm: ({ item, target }) => {
        if (item.id === "detect") {
          this.detectEncoding(target.editor);
        } else {
          target.editor.setEncoding(item.id);
        }
      },
    });
  }

  detectEncoding(editor) {
    const filePath = editor.getPath();
    if (!fs.existsSync(filePath)) return;

    fs.readFile(filePath, (error, buffer) => {
      if (error) return;
      let { encoding } = jschardet.detect(buffer) || {};
      if (encoding === "ascii") {
        encoding = "utf8";
      }

      // Only switch to an encoding this picker actually offers (its ids are
      // defined in main.js and passed in as `this.encodings`).
      const id = encoding.toLowerCase().replace(/[^0-9a-z]|:\d{4}$/g, "");
      if (this.encodings[id]) {
        editor.setEncoding(id);
      }
    });
  }
};
