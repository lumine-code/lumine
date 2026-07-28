const _ = require("@lumine-code/underscore-plus");
const { CompositeDisposable } = require("atom");
const { Liquid, Drop } = require("liquidjs");

const TEMPLATE = `\
<ul class="centered background-message">
  <li class="message"></li>
</ul>`;

const templateEngine = new Liquid({ jsTruthy: true });

// Set for the duration of a single renderTip() call so the `keystroke` filter
// can report that the tip asked for a binding nobody defines.
let renderState = null;

function bindingFor(command, selector) {
  if (typeof command !== "string") return null;
  const bindings = atom.keymaps.findKeyBindings({ command: command.trim() });
  let binding;
  if (selector) {
    binding = bindings.find((candidate) => candidate.selector === selector);
  } else {
    binding =
      bindings.find((candidate) => candidate.selector.includes(process.platform)) ?? bindings[0];
  }
  return binding && binding.keystrokes ? binding : null;
}

function keystrokeHtml(binding) {
  // a chord such as `ctrl-~ n` must not wrap onto two lines
  const label = _.humanizeKeystroke(binding.keystrokes).replace(/\s+/g, "&nbsp;");
  return `<span class="keystroke">${label}</span>`;
}

// `{{ "pkg:command" | keystroke }}` says the tip only makes sense with that
// keystroke in it, so an unbound command drops the tip instead of leaving a gap.
templateEngine.registerFilter("keystroke", (command, selector) => {
  const binding = bindingFor(command, selector);
  if (!binding) {
    if (renderState) renderState.missing = true;
    return "";
  }
  return keystrokeHtml(binding);
});

// `keys["pkg:command"]` only answers the question, so it can be tested in an
// `{% if %}` to write a tip that reads either way.
class KeystrokeDrop extends Drop {
  liquidMethodMissing(command) {
    const binding = bindingFor(command);
    return binding ? keystrokeHtml(binding) : "";
  }
}

const keys = new KeystrokeDrop();

module.exports = class BackgroundTipsElement {
  constructor() {
    this.element = document.createElement("background-tips");
    this.index = -1;
    this.workspaceCenter = atom.workspace.getCenter();
    this.startDelay = 1000;
    this.displayDuration = 10000;
    this.fadeDuration = 300;
    this.tips = [];
    this.started = false;
    this.disposables = new CompositeDisposable();
    const visibilityCallback = () => this.updateVisibility();
    this.disposables.add(
      this.workspaceCenter.onDidAddPane(visibilityCallback),
      this.workspaceCenter.onDidDestroyPane(visibilityCallback),
      this.workspaceCenter.onDidChangeActivePaneItem(visibilityCallback),
    );
    this.startTimeout = setTimeout(() => {
      this.started = true;
      this.start();
    }, this.startDelay);
  }

  destroy() {
    this.stop();
    this.disposables.dispose();
  }

  attach() {
    this.element.innerHTML = TEMPLATE;
    this.message = this.element.querySelector(".message");
    const paneView = atom.views.getView(this.workspaceCenter.getActivePane());
    const itemViews = paneView.querySelector(".item-views");
    let top = 0;
    if (itemViews && itemViews.offsetTop) {
      top = itemViews.offsetTop;
    }
    this.element.style.top = top + "px";
    paneView.appendChild(this.element);
  }

  updateVisibility() {
    if (this.shouldBeAttached()) {
      this.start();
    } else {
      this.stop();
    }
  }

  shouldBeAttached() {
    return (
      this.workspaceCenter.getPanes().length === 1 &&
      this.workspaceCenter.getActivePaneItem() == null
    );
  }

  start() {
    if (!this.shouldBeAttached() || this.interval != null) return;
    if (this.tips.length === 0) return;
    this.randomizeIndex();
    this.attach();
    this.showNextTip();
    this.interval = setInterval(() => this.showNextTip(), this.displayDuration);
  }

  stop() {
    this.element.remove();
    if (this.interval != null) {
      clearInterval(this.interval);
    }
    clearTimeout(this.startTimeout);
    clearTimeout(this.nextTipTimeout);
    this.interval = null;
  }

  randomizeIndex() {
    const len = this.tips.length;
    this.index = len > 0 ? Math.round(Math.random() * len) % len : 0;
  }

  showNextTip() {
    if (this.tips.length === 0) return;
    let html = null;
    for (let i = 0; i < this.tips.length; i++) {
      this.index = (this.index + 1) % this.tips.length;
      const tip = this.tips[this.index];
      if (atom.packages.isPackageDisabled(tip.packageName)) continue;
      html = this.renderTip(tip);
      if (html !== null) break;
    }
    if (html === null) {
      this.stop();
      return;
    }
    this.message.classList.remove("fade-in");
    this.nextTipTimeout = setTimeout(() => {
      this.message.innerHTML = html;
      this.message.classList.add("fade-in");
    }, this.fadeDuration);
  }

  addPackageTips(pkg) {
    const raw = pkg.metadata.backgroundTips;
    if (!Array.isArray(raw) || raw.length === 0) return;
    for (const source of raw) {
      if (typeof source !== "string" || source.trim() === "") continue;
      let template;
      try {
        template = templateEngine.parse(source);
      } catch (error) {
        // the tip belongs to the package, not to the user, so there is nothing
        // for a notification to ask them to do
        console.warn(`background-tips: ${pkg.name} ships an unparsable tip`, error);
        continue;
      }
      this.tips.push({ source, template, packageName: pkg.name });
    }
    if (this.started && this.interval == null) this.start();
  }

  removePackageTips(pkg) {
    const keep = this.tips.filter((tip) => tip.packageName !== pkg.name);
    if (keep.length === this.tips.length) return;
    this.tips = keep;
    if (this.interval != null) {
      if (this.tips.length === 0) {
        this.stop();
      } else {
        this.index = Math.min(this.index, this.tips.length - 1);
      }
    }
  }

  // Returns the tip's HTML, or null when it should be skipped: either it asked
  // for a keystroke that is not bound, or it rendered to nothing.
  renderTip(tip) {
    const state = { missing: false };
    const previous = renderState;
    renderState = state;
    let html;
    try {
      html = templateEngine.renderSync(tip.template, { keys, platform: process.platform });
    } catch (error) {
      console.warn(`background-tips: ${tip.packageName} failed to render a tip`, error);
      return null;
    } finally {
      renderState = previous;
    }
    if (state.missing) return null;
    return html.trim() || null;
  }
};
