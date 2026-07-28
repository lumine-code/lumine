"use strict";

const { CompositeDisposable, Disposable } = require("event-kit");
const { ModalQueryEditor } = require("./modal-query-editor");
const { ModalListTemplate } = require("./modal-list-template");
const { ModalInputTemplate } = require("./modal-input-template");

// The single `<atom-modal>` host. One per window, created lazily, reset
// completely between views.
//
// Focus policy, stated once here instead of 33 times across packages:
//   * Focus lives on the query editor for the entire life of a stack. Rows are
//     activated through `aria-activedescendant`, never focused.
//   * Tab is a kernel command with roving activation over the host's own
//     controls; the panel's `focus-trap` is deliberately NOT used, because the
//     container builds it without `allowOutsideClick`, which would cancel every
//     mousedown outside the modal and make click-to-dismiss impossible.
//   * The blur decision runs off `focusout` + a zero timer, never
//     `requestAnimationFrame`: the spec harness fakes timers but cannot drive
//     frames, and headless Electron windows throttle rAF to about 1 Hz.

const INTERACTIVE_SELECTOR =
  "input, textarea, select, button, a[href], [tabindex], atom-text-editor, .modals-preview *";

class ModalHostElement extends HTMLElement {
  initialize(manager) {
    this.manager = manager;
    this.session = null;
    this.template = null;
    this.subscriptions = new CompositeDisposable();
    this.viewSubscriptions = new CompositeDisposable();
    this.blurTimer = null;
    this.showHelp = false;

    this.setAttribute("role", "dialog");
    this.setAttribute("aria-modal", "true");
    this.classList.add("modals-host", "select-list");

    this.breadcrumb = document.createElement("div");
    this.breadcrumb.classList.add("modals-breadcrumb");
    this.breadcrumb.style.display = "none";

    this.headerSlot = document.createElement("div");
    this.headerSlot.classList.add("modals-header");
    this.headerSlot.style.display = "none";

    this.queryRow = document.createElement("div");
    this.queryRow.classList.add("modals-query");

    this.queryEditor = new ModalQueryEditor({
      onDidChange: () => {
        if (this.session) this.session.didChangeQuery();
      },
    });
    this.queryRow.appendChild(this.queryEditor.element);

    this.helpToggle = document.createElement("button");
    this.helpToggle.classList.add("modals-help-toggle", "icon", "icon-question");
    this.helpToggle.setAttribute("aria-label", "Show help");
    this.helpToggle.setAttribute("aria-expanded", "false");
    this.helpToggle.tabIndex = -1;
    this.helpToggle.style.display = "none";
    this.helpToggle.addEventListener("mousedown", (event) => event.preventDefault());
    this.helpToggle.addEventListener("click", () => this.toggleHelp());
    this.queryRow.appendChild(this.helpToggle);

    this.checkboxRow = document.createElement("div");
    this.checkboxRow.classList.add("modals-checkboxes");
    this.checkboxRow.style.display = "none";

    this.statusRow = document.createElement("div");
    this.statusRow.classList.add("modals-status");
    this.statusRow.setAttribute("aria-live", "polite");
    this.statusRow.style.display = "none";

    this.split = document.createElement("div");
    this.split.classList.add("modals-split");

    this.footerSlot = document.createElement("div");
    this.footerSlot.classList.add("modals-footer");
    this.footerSlot.style.display = "none";

    this.helpPanel = document.createElement("div");
    this.helpPanel.classList.add("modals-help");
    this.helpPanel.style.display = "none";

    this.append(
      this.breadcrumb,
      this.headerSlot,
      this.queryRow,
      this.checkboxRow,
      this.statusRow,
      this.split,
      this.helpPanel,
      this.footerSlot,
    );

    this.registerCommands();
    this.installFocusPolicy();
    return this;
  }

  get sessionId() {
    return this.session ? this.session.id : "none";
  }

  // ── focus policy ──────────────────────────────────────────────────────────

  installFocusPolicy() {
    const onFocusOut = (event) => this.didLoseFocus(event);
    const onMouseDown = (event) => this.didMouseDown(event);
    this.addEventListener("focusout", onFocusOut);
    this.addEventListener("mousedown", onMouseDown);
    this.subscriptions.add(
      new Disposable(() => {
        this.removeEventListener("focusout", onFocusOut);
        this.removeEventListener("mousedown", onMouseDown);
      }),
    );
  }

  didLoseFocus(event) {
    if (!this.session || this.manager.isClosing) return;
    if (this.contains(event.relatedTarget)) return;
    if (this.blurTimer != null) clearTimeout(this.blurTimer);
    this.blurTimer = setTimeout(() => {
      this.blurTimer = null;
      if (!this.session) return;
      if (this.session.view.dismissOnBlur === false) return;
      // A window-level blur (alt-tab, DevTools) must not dismiss: only focus
      // moving to another element *inside this window* counts.
      if (!document.hasFocus()) return;
      if (this.contains(document.activeElement)) return;
      this.session.cancel("blur");
    }, 0);
  }

  didMouseDown(event) {
    if (this.queryEditor.element.contains(event.target)) return;
    if (this.isInteractiveTarget(event.target)) return;
    event.preventDefault();
    this.queryEditor.focus();
  }

  isInteractiveTarget(node) {
    if (!node || !node.closest) return false;
    const match = node.closest(INTERACTIVE_SELECTOR);
    return !!match && match !== this && this.contains(match);
  }

  focusQuery() {
    this.queryEditor.focus();
  }

  // Roving Tab across the host's own controls, so `aria-activedescendant`
  // stays truthful and no keybinding ever goes dead on a stray Tab.
  focusNextControl(direction = 1) {
    const controls = Array.from(
      this.querySelectorAll("button:not([disabled]), input, select, textarea, a[href]"),
    ).filter((el) => el.offsetParent !== null);
    if (controls.length === 0) return;
    const current = controls.indexOf(document.activeElement);
    const next = current < 0 ? 0 : (current + direction + controls.length) % controls.length;
    controls[next].focus();
  }

  // ── commands ──────────────────────────────────────────────────────────────

  registerCommands() {
    const withSession = (fn) => (event) => {
      if (!this.session) return;
      event.stopPropagation();
      fn(this.session, event);
    };

    this.subscriptions.add(
      atom.commands.add(this, {
        "core:confirm": withSession((session, event) =>
          session.confirmDefault({ event: event.originalEvent ?? event }),
        ),
        "core:cancel": withSession((session) => {
          if (session.canPop()) session.pop(1);
          else session.cancel("escape");
        }),
        "core:move-up": withSession((session) => session.moveFocus(-1)),
        "core:move-down": withSession((session) => session.moveFocus(1)),
        "core:move-to-top": withSession((session) => session.focusEdge("first")),
        "core:move-to-bottom": withSession((session) => session.focusEdge("last")),
        "core:page-up": withSession((session) => session.moveFocus(-this.getPageSize())),
        "core:page-down": withSession((session) => session.moveFocus(this.getPageSize())),
        "modals:confirm-secondary": withSession((session, event) =>
          session.confirmDefault({ secondary: true, event: event.originalEvent ?? event }),
        ),
        "modals:cancel-all": withSession((session) => session.cancel("escape")),
        "modals:back": withSession((session) => {
          if (session.canPop()) session.pop(1);
        }),
        "modals:help": withSession(() => this.toggleHelp()),
        "modals:toggle-check": withSession((session) => session.toggleChecked()),
        "modals:check-all": withSession((session) => {
          for (const item of session.getVisibleItems()) session.setChecked(item, true);
        }),
        "modals:uncheck-all": withSession((session) => session.clearChecked()),
        "modals:query-from-selection": withSession((session) => session.setQueryFromSelection()),
        "modals:focus-next-control": withSession(() => this.focusNextControl(1)),
        "modals:focus-previous-control": withSession(() => this.focusNextControl(-1)),
      }),
    );
  }

  getPageSize() {
    return this.template && this.template.getPageSize ? this.template.getPageSize() : 10;
  }

  // ── view application ──────────────────────────────────────────────────────

  // Fully resets the host for a new view. Every mutation made here must be
  // undone or overwritten, because a leaked class or listener becomes a global
  // bug affecting every later modal in the window.
  applyView(session, frame) {
    this.viewSubscriptions.dispose();
    this.viewSubscriptions = new CompositeDisposable();

    this.session = session;
    const spec = frame.spec;

    if (this.template) {
      try {
        this.template.destroy();
      } catch (error) {
        console.error("modals: template destroy threw", error);
      }
      this.template = null;
    }
    this.split.replaceChildren();

    // Reset every attribute and class the previous view could have set.
    this.className = "";
    this.classList.add("modals-host", "select-list");
    for (const key of Object.keys(this.dataset)) delete this.dataset[key];
    this.dataset.modalView = spec.id;
    this.dataset.template = frame.template;
    this.dataset.depth = String(session.depth);
    if (spec.className) {
      const names = Array.isArray(spec.className) ? spec.className : spec.className.split(/\s+/);
      this.classList.add(...names.filter(Boolean));
    }
    if (frame.spec.multiSelect) this.dataset.multiSelect = "";
    if (spec.help) this.dataset.help = "";
    this.setAttribute("aria-label", spec.title ?? spec.id);

    this.queryEditor.applyView(spec);
    this.queryEditor.element.setAttribute("role", "combobox");
    this.queryEditor.element.setAttribute("aria-autocomplete", "list");
    this.queryEditor.element.setAttribute("aria-expanded", frame.isList ? "true" : "false");

    this.showHelp = false;
    this.helpPanel.style.display = "none";
    this.helpToggle.style.display = spec.help ? "" : "none";
    this.helpToggle.setAttribute("aria-expanded", "false");

    this.registerViewActions(session, frame);
    this.renderSlot(this.headerSlot, spec.header);
    this.renderSlot(this.footerSlot, spec.footer);
    this.renderCheckboxes(spec);
    this.renderBreadcrumb(session);

    const TemplateClass = frame.isList ? ModalListTemplate : ModalInputTemplate;
    this.template = new TemplateClass(this, spec);
    this.template.setMultiSelectable(!!spec.multiSelect);
    this.split.appendChild(this.template.element);

    if (frame.isList) {
      this.queryEditor.element.setAttribute("aria-controls", this.template.list.id);
    } else {
      this.queryEditor.element.removeAttribute("aria-controls");
      this.queryEditor.element.removeAttribute("aria-activedescendant");
    }

    if (spec.content) {
      const content = typeof spec.content === "function" ? spec.content() : spec.content;
      if (content) {
        this.contentSlot = content;
        this.split.appendChild(content);
      }
    }
  }

  // Every action a view declares becomes a real `modals:<name>` command while
  // that view is on top, so verbs are bindable, discoverable in the command
  // palette, and dispatchable from a spec. Registered per view rather than
  // globally: only one view is ever on top, so names cannot collide.
  registerViewActions(session, frame) {
    const commands = {};
    for (const action of frame.actions) {
      if (typeof action.run !== "function") continue;
      const name = action.name;
      commands[`modals:${name}`] = (event) => {
        event.stopPropagation();
        session.dispatchAction(name, { event: event.originalEvent ?? event });
      };
    }
    if (Object.keys(commands).length === 0) return;
    this.viewSubscriptions.add(atom.commands.add(this, commands));
  }

  renderSlot(slot, value) {
    slot.replaceChildren();
    if (!value) {
      slot.style.display = "none";
      return;
    }
    const element = typeof value === "function" ? value() : value;
    if (!element) {
      slot.style.display = "none";
      return;
    }
    slot.appendChild(element);
    slot.style.display = "";
  }

  renderCheckboxes(spec) {
    this.checkboxRow.replaceChildren();
    const checkboxes = spec.checkboxes;
    if (!checkboxes || checkboxes.length === 0) {
      this.checkboxRow.style.display = "none";
      return;
    }
    this.checkboxRow.style.display = "";
    this.localCheckboxState = this.localCheckboxState ?? new Map();

    checkboxes.forEach((checkbox, index) => {
      const label = document.createElement("label");
      label.classList.add("input-label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.classList.add("input-checkbox");
      input.tabIndex = -1;
      input.checked = this.isCheckboxChecked(checkbox, index);
      input.addEventListener("change", () => {
        this.didToggleCheckbox(checkbox, index, input.checked);
      });
      const text = document.createElement("span");
      text.classList.add("input-label-text");
      text.textContent = checkbox.label;
      label.append(input, text);
      this.checkboxRow.appendChild(label);

      // A config-bound checkbox is a view of the setting, so an external change
      // (including from another window) has to re-render it.
      if (checkbox.config) {
        this.viewSubscriptions.add(
          atom.config.onDidChange(checkbox.config, () => {
            input.checked = !!atom.config.get(checkbox.config);
          }),
        );
      }
    });
  }

  isCheckboxChecked(checkbox, index) {
    if (checkbox.config) return !!atom.config.get(checkbox.config);
    const key = `${this.dataset.modalView}:${index}`;
    if (this.localCheckboxState.has(key)) return this.localCheckboxState.get(key);
    return !!checkbox.checked;
  }

  didToggleCheckbox(checkbox, index, checked) {
    if (checkbox.config) {
      atom.config.set(checkbox.config, checked);
    } else {
      this.localCheckboxState.set(`${this.dataset.modalView}:${index}`, checked);
    }
    if (typeof checkbox.onChange === "function") {
      try {
        checkbox.onChange(checked, this.session);
      } catch (error) {
        console.error("modals: checkbox onChange threw", error);
      }
    }
    this.focusQuery();
  }

  renderBreadcrumb(session) {
    const crumbs = session.getStack();
    if (crumbs.length <= 1 || session.view.navigation?.hideBreadcrumb) {
      this.breadcrumb.style.display = "none";
      this.breadcrumb.replaceChildren();
      return;
    }
    this.breadcrumb.style.display = "";
    this.breadcrumb.replaceChildren();

    const back = document.createElement("button");
    back.classList.add("modals-back");
    back.textContent = "‹";
    back.tabIndex = -1;
    back.setAttribute("aria-label", "Back");
    back.addEventListener("mousedown", (event) => event.preventDefault());
    back.addEventListener("click", () => session.pop(1));
    this.breadcrumb.appendChild(back);

    crumbs.forEach((crumb, index) => {
      const span = document.createElement("span");
      span.classList.add("modals-crumb");
      span.textContent = crumb.title ?? crumb.id;
      if (index < crumbs.length - 1) {
        span.classList.add("clickable");
        span.addEventListener("mousedown", (event) => event.preventDefault());
        span.addEventListener("click", () => session.pop(crumbs.length - 1 - index));
      }
      this.breadcrumb.appendChild(span);
    });
  }

  // ── render ────────────────────────────────────────────────────────────────

  render(session) {
    if (session !== this.session) return;
    const state = session.templateState();

    this.renderStatus(state);

    if (this.showHelp) return;

    try {
      this.template.update(state);
    } catch (error) {
      // A template that throws would leave the singleton host half-rendered and
      // poison every later modal, so tear the host down instead.
      console.error("modals: template update threw", error);
      this.manager.recoverFromError(session, error);
    }
  }

  renderStatus(state) {
    const { status, validation } = state;
    const message = validation ? validation.message : status.message;
    const severity = validation ? validation.severity : status.severity;
    const hasContent = message != null || status.badge != null || status.busy;

    this.statusRow.replaceChildren();
    if (!hasContent) {
      this.statusRow.style.display = "none";
      return;
    }
    this.statusRow.style.display = "";
    this.statusRow.dataset.severity = severity ?? "info";

    if (status.busy) {
      const spinner = document.createElement("span");
      spinner.classList.add("loading", "loading-spinner-tiny", "inline-block");
      this.statusRow.appendChild(spinner);
    }
    if (message != null) {
      const span = document.createElement("span");
      span.classList.add("modals-status-message");
      if (typeof message === "string") span.textContent = message;
      else span.appendChild(message);
      this.statusRow.appendChild(span);
    }
    if (status.badge != null) {
      const badge = document.createElement("span");
      badge.classList.add("badge");
      badge.textContent = String(status.badge);
      this.statusRow.appendChild(badge);
    }
  }

  setActiveDescendant(id) {
    if (id) this.queryEditor.element.setAttribute("aria-activedescendant", id);
    else this.queryEditor.element.removeAttribute("aria-activedescendant");
  }

  didClickRow(index) {
    if (!this.session) return;
    this.session.focusIndex(index);
    this.session.confirmDefault({});
  }

  didClickRowButton(index, button) {
    if (!this.session) return;
    this.session.focusIndex(index);
    const action = button._modalRowAction;
    if (typeof action === "function") {
      this.session.runActionResult(action(this.session.actionContext({})), {
        ctx: this.session.actionContext({}),
      });
    } else if (button.dataset.modalRowButton) {
      this.session.dispatchAction(button.dataset.modalRowButton);
    }
  }

  didFocusIndex(index) {
    if (this.session) this.session.focusIndex(index);
  }

  didChangeHelp(session) {
    if (session !== this.session) return;
    this.helpToggle.style.display = session.view.help ? "" : "none";
    if (this.showHelp) this.renderHelp();
  }

  toggleHelp() {
    if (!this.session || !this.session.view.help) return;
    this.showHelp = !this.showHelp;
    this.helpToggle.setAttribute("aria-expanded", String(this.showHelp));
    if (this.showHelp) {
      this.renderHelp();
      this.helpPanel.style.display = "";
      this.split.style.display = "none";
    } else {
      this.helpPanel.style.display = "none";
      this.split.style.display = "";
      this.render(this.session);
    }
  }

  renderHelp() {
    const help = this.session.view.help;
    const markdown = typeof help === "function" ? help(this.session) : help;
    this.helpPanel.replaceChildren();
    const body = document.createElement("div");
    body.classList.add("modals-help-body", "markdown");
    if (atom.ui && atom.ui.markdown && atom.ui.markdown.render) {
      body.innerHTML = atom.ui.markdown.render(markdown ?? "");
    } else {
      body.textContent = markdown ?? "";
    }
    this.helpPanel.appendChild(body);

    const actions = this.session.frame.actions.filter(
      (action) => !action.hidden && (action.keystroke || action.builtin),
    );
    if (actions.length === 0) return;
    const table = document.createElement("table");
    table.classList.add("modals-help-actions");
    for (const action of actions) {
      const row = document.createElement("tr");
      const key = document.createElement("td");
      const keystroke = this.manager.keystrokeFor(this.session.view.id, action);
      key.textContent = keystroke ?? "";
      const label = document.createElement("td");
      label.textContent = action.label;
      row.append(key, label);
      table.appendChild(row);
    }
    this.helpPanel.appendChild(table);
  }

  // ── query proxy ───────────────────────────────────────────────────────────

  getQueryText() {
    return this.queryEditor.getText();
  }

  setQuery(text, opts) {
    this.queryEditor.setText(text, opts);
  }

  getQuerySelection() {
    return this.queryEditor.getSelection();
  }

  getScrollTop() {
    return this.template ? this.template.getScrollTop() : 0;
  }

  setScrollTop(value) {
    if (this.template) this.template.setScrollTop(value);
  }

  // ── teardown ──────────────────────────────────────────────────────────────

  releaseSession() {
    this.session = null;
    if (this.blurTimer != null) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
    this.viewSubscriptions.dispose();
    this.viewSubscriptions = new CompositeDisposable();
    if (this.template) {
      try {
        this.template.destroy();
      } catch (error) {
        console.error("modals: template destroy threw", error);
      }
      this.template = null;
    }
    this.split.replaceChildren();
    this.statusRow.replaceChildren();
    this.statusRow.style.display = "none";
    this.helpPanel.style.display = "none";
    this.split.style.display = "";
    this.contentSlot = null;
  }

  destroy() {
    this.releaseSession();
    if (this.blurTimer != null) clearTimeout(this.blurTimer);
    this.subscriptions.dispose();
    this.queryEditor.destroy();
    this.remove();
  }
}

window.customElements.define("atom-modal", ModalHostElement);

function createModalHostElement(manager) {
  return document.createElement("atom-modal").initialize(manager);
}

module.exports = { ModalHostElement, createModalHostElement };
