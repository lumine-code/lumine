"use strict";

const { buildRowElement } = require("./modal-row");

// The `"list"` template: renders visible rows into `ol.list-group`, owns focus
// movement and scroll, and reports mouse interaction back to the frame.
//
// The emitted markup deliberately matches what `select-list` produced —
// `ol.list-group > li > div.primary-line > span.primary-text` — because all
// three themes and sixteen package stylesheets key off it. Renaming is a
// separate, purely-CSS pass once every consumer has migrated.

class ModalListTemplate {
  constructor(host, spec) {
    this.host = host;
    this.spec = spec;

    this.element = document.createElement("div");
    this.element.classList.add("modals-body");

    this.list = document.createElement("ol");
    this.list.classList.add("list-group");
    // Reserves the check-glyph gutter on every row. Set on the list rather than
    // derived from the visible rows, so filtering the active row out does not
    // shift the whole list sideways.
    if (spec.markActive) this.list.classList.add("mark-active");
    if (spec.itemsClassList) this.list.classList.add(...[].concat(spec.itemsClassList));
    this.list.setAttribute("role", "listbox");
    this.list.id = `modals-${host.sessionId}-list`;
    this.element.appendChild(this.list);

    this.emptyMessage = document.createElement("div");
    this.emptyMessage.classList.add("empty-message");
    this.emptyMessage.style.display = "none";
    this.element.appendChild(this.emptyMessage);

    this.rows = [];
    this.renderedKey = null;

    this.onMouseDown = (event) => {
      // Keep focus on the query editor: rows are activated through
      // `aria-activedescendant`, never by focusing the row itself.
      if (event.target.closest("button")) return;
      event.preventDefault();
    };
    this.onClick = (event) => {
      const button = event.target.closest("button.modals-row-button");
      const li = event.target.closest("li[data-modal-index]");
      if (!li) return;
      const index = Number(li.dataset.modalIndex);
      event.preventDefault();
      if (button) {
        this.host.didClickRowButton(index, button);
      } else {
        this.host.didClickRow(index);
      }
    };
    this.onContextMenu = (event) => {
      const li = event.target.closest("li[data-modal-index]");
      if (!li) return;
      this.host.didFocusIndex(Number(li.dataset.modalIndex));
    };

    this.list.addEventListener("mousedown", this.onMouseDown);
    this.list.addEventListener("click", this.onClick);
    this.list.addEventListener("contextmenu", this.onContextMenu);
  }

  setMultiSelectable(multi) {
    if (multi) this.list.setAttribute("aria-multiselectable", "true");
    else this.list.removeAttribute("aria-multiselectable");
  }

  update(state) {
    const { visibleItems, focusedIndex, checked } = state;

    if (visibleItems.length === 0) {
      this.list.replaceChildren();
      this.rows = [];
      const message = state.emptyMessage ?? this.spec.emptyMessage;
      if (message != null && !state.status.busy) {
        this.emptyMessage.replaceChildren();
        if (typeof message === "string") this.emptyMessage.textContent = message;
        else this.emptyMessage.appendChild(message);
        this.emptyMessage.style.display = "";
      } else {
        this.emptyMessage.style.display = "none";
      }
      this.host.setActiveDescendant(null);
      return;
    }

    this.emptyMessage.style.display = "none";

    // Replacing the rows resets scrollTop; a list that is being edited in place
    // (removing entries, toggling flags) should not jump to the top each time.
    const scrollTop = this.spec.keepScrollPosition === false ? null : this.list.scrollTop;

    const fragment = document.createDocumentFragment();
    const rows = [];
    for (let index = 0; index < visibleItems.length; index++) {
      const visible = visibleItems[index];
      const li = this.buildRow(visible, index, focusedIndex, checked);
      rows.push(li);
      fragment.appendChild(li);
    }
    this.list.replaceChildren(fragment);
    this.rows = rows;
    if (scrollTop != null) this.list.scrollTop = scrollTop;

    const focused = rows[focusedIndex];
    this.host.setActiveDescendant(focused ? focused.id : null);
    if (focused) this.revealRow(focused);
  }

  buildRow(visible, index, focusedIndex, checked) {
    let li;
    try {
      li = buildRowElement(visible.row, visible.ctx);
    } catch (error) {
      // One bad row must not take out the render loop — and with a singleton
      // host, a half-rendered list would poison every later modal.
      console.error("modals: row renderer threw", error);
      li = document.createElement("li");
      li.classList.add("modals-row-error");
      li.textContent = String(visible.entry?.text ?? "");
    }

    li.dataset.modalIndex = String(index);
    li.id = `modals-${this.host.sessionId}-row-${index}`;
    li.setAttribute("role", visible.row.kind === "separator" ? "presentation" : "option");
    if (visible.row.kind !== "separator") {
      li.setAttribute("aria-selected", index === focusedIndex ? "true" : "false");
      if (visible.row.disabled) li.setAttribute("aria-disabled", "true");
      // Screen readers must not spell a filename out letter by letter, which is
      // what the `.character-match` splits would otherwise cause.
      const label = visible.entry?.text;
      if (label) li.setAttribute("aria-label", label);
    }
    if (index === focusedIndex) li.classList.add("selected");
    if (checked && checked.has(visible.item)) li.classList.add("checked");
    return li;
  }

  revealRow(element) {
    const list = this.list;
    const top = element.offsetTop;
    const bottom = top + element.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }

  getScrollTop() {
    return this.list.scrollTop;
  }

  setScrollTop(value) {
    this.list.scrollTop = value;
  }

  // Rows per page for `core:page-up` / `core:page-down`.
  getPageSize() {
    const first = this.rows[0];
    if (!first || !first.offsetHeight) return 10;
    return Math.max(1, Math.floor(this.list.clientHeight / first.offsetHeight));
  }

  destroy() {
    this.list.removeEventListener("mousedown", this.onMouseDown);
    this.list.removeEventListener("click", this.onClick);
    this.list.removeEventListener("contextmenu", this.onContextMenu);
    this.element.remove();
  }
}

module.exports = { ModalListTemplate };
