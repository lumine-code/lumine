"use babel";

import { TextEditor } from "atom";
import { setLineEnding } from "./main";

const LINE_ENDINGS = [
  { label: "LF", value: "\n" },
  { label: "CRLF", value: "\r\n" },
];

// Opens the line-ending picker. `atom.modals` owns the panel, so there is no
// view to keep around between invocations.
export function showSelector() {
  return atom.modals.toggle({
    id: "line-ending-selector.endings",
    placeholder: "Select a line ending",
    source: LINE_ENDINGS,
    confirm: ({ item, target }) => {
      const editor = target.editor;
      if (editor instanceof TextEditor) setLineEnding(editor, item.value);
    },
  });
}
