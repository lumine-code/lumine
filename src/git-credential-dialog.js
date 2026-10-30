// The default prompt handler for the git auth broker. Git's askpass protocol
// asks for one value at a time (a username, a password, or an SSH/GPG
// passphrase), each with its own prompt string, so this is a single-field modal
// that echoes git's prompt and returns the value the user enters. The reply key
// is always `password` because that is the transport field the helper reads —
// it carries whatever single value git asked for.

const { CompositeDisposable } = require("@lumine-code/event-kit");

function promptForGitCredential(query = {}, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const workspace = globalThis.lumine && globalThis.lumine.workspace;
  if (!workspace) {
    return Promise.reject(new Error("No workspace is available to prompt for credentials"));
  }

  const prompt = query.prompt || "Enter git credentials";
  const masked = /password|passphrase|secret|token/i.test(prompt);

  return new Promise((resolve, reject) => {
    const window = workspace.getFocusedWindow() ?? workspace.getMainWindow();
    const document = window.getDocument();
    const message = document.createElement("div");
    message.classList.add("dialog-header", "git-credential-dialog-prompt");
    message.textContent = prompt;

    const buttons = document.createElement("div");
    buttons.classList.add("dialog-actions", "git-credential-dialog-buttons");
    const okButton = document.createElement("button");
    okButton.type = "button";
    okButton.classList.add("btn", "btn-primary");
    okButton.textContent = "OK";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.classList.add("btn");
    cancelButton.textContent = "Cancel";
    buttons.append(cancelButton, okButton);

    const host = workspace.addInputDialog(
      { headerElement: message, contentElement: buttons },
      { className: "git-credential-dialog", window },
    );
    const model = host.getModel();
    const input = model.getQueryEditor().getElement();
    input.classList.add("git-credential-dialog-input");
    input.setAttribute("aria-label", prompt);
    const element = model.getElement();
    element.classList.add("git-credential-dialog");
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-label", prompt);
    const subscriptions = new CompositeDisposable();
    if (masked) {
      const editor = model.getQueryEditor();
      const updateMask = () => {
        input.style.webkitTextSecurity = editor.getBuffer().getLength() > 0 ? "disc" : "none";
      };
      subscriptions.add(editor.getBuffer().onDidChangeText(updateMask));
      updateMask();
    }
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      subscriptions.dispose();
      // Do not retain a credential in the host's last-query snapshot or the
      // mini editor while asynchronous teardown completes.
      model.setQuery("");
      void Promise.resolve()
        .then(() => host.destroy())
        .then(() => fn(value), reject);
    };
    const accept = ({ query }) => finish(resolve, { password: query });
    const cancel = () => finish(reject, new Error("Git credential prompt was cancelled"));
    const abort = () => finish(reject, signal.reason);
    signal?.addEventListener("abort", abort, { once: true });

    subscriptions.add(
      model.onDidConfirm(accept),
      host.onDidHide(cancel),
      host.onDidDestroy(cancel),
    );

    okButton.addEventListener("click", () => model.confirm());
    cancelButton.addEventListener("click", () => host.cancel());
    void host.show().catch((error) => finish(reject, error));
  });
}

module.exports = { promptForGitCredential };
