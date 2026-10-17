# Select-list action sessions

Hosted SelectLists provide the `select-list:toggle-keep-open` action unless they opt out. F12 runs it from the query editor, and Shift+F10 exposes it in Actions. An accented frame marks the active mode; One and Aura use an accented shadow instead. Each fresh opening starts with the mode off; opening Actions or another modal-flow step and returning preserves the existing session and its mode. The internal Actions list operates on its owner and does not provide a second keep-open toggle of its own.

## Completion policy

The list owns whether it supports the mode. Pass `supportsKeepOpen: false` to `buildSelectList` or `addSelectList` for a surface that always completes one choice, or already stays open by its own contract. The default is `true`. An opted-out list hides the toggle from Actions, disables its F12 command and rejects `setKeepOpen(true)`. `supportsKeepOpen()` reports the capability. Updating the option to `false` immediately switches the mode off; enabling support again leaves it off until the user chooses it.

An action declares its completion policy with `disposition`:

| Disposition | Successful completion                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| `close`     | Close normally, or leave the list open when its captured keep-open mode is on. |
| `complete`  | Always close a completed one-shot choice, including in keep-open mode.         |
| `stay`      | Keep the existing session open.                                                |
| `push`      | Leave modal-flow navigation to the action that opens the next step.            |

Use `complete` when selecting an item resolves a pending request, consumes a callback, or invalidates the remaining choices. An action that can be repeated should use `close` and retain its captured target until the host's `onDidHide` event. Modal-flow suspension does not emit that event. Do not clear the editor, pane, request or other session state merely because one action ran successfully.

The action context captures `keepOpen` and `sessionId` when execution begins. Changing the mode while an asynchronous action runs affects subsequent actions. Ending the session invalidates work that has not reached its handler. Accepted operations may finish, but their late completion cannot close a freshly reopened dialog or replace its status. Query text, selection and scrolling are preserved during repeated execution. After an action returns, a visible list in keep-open mode takes keyboard focus back; a newly opened modal step keeps its own focus.

## Conditional or early acceptance

Prefer declaring `disposition` on the action. Some operations must validate a callback result before requesting closure, or accept a job before its output finishes. Such an action declares `stay` and requests the appropriate disposition at that acceptance boundary:

```js
const list = lumine.workspace.buildSelectList({
  commands: {
    "example:run": {
      description: "Run the selected job.",
      didDispatch: async ({ detail }) => {
        const receipt = await startJob(detail.item);
        if (receipt.accepted) {
          list.requestDisposition("close", { context: detail });
        }
        return receipt.done;
      },
    },
  },
  actions: [{ command: "example:run", context: "item", disposition: "stay" }],
});
```

Pass the original context so the request uses the mode and session belonging to that execution. Calling the host's `hide()` is an unconditional dismissal and bypasses this action policy; reserve it for an explicit hide operation or terminal session cleanup.

## Preview and cancellation

A preview is temporary until an action commits it. After each successful commit in keep-open mode, save a fresh baseline. Escape then discards only previews made since the latest commit. Preserve that baseline when moving through Actions or other modal-flow steps, and release it when the session ends. If an asynchronous commit can outlive its session, verify that the captured editor and session still own the result before updating preview state.

`isKeepOpen()`, `setKeepOpen(boolean)` and `onDidChangeKeepOpen(callback)` expose the model state. The normal UI toggle remains the registered action, so keyboard execution and Actions share availability and execution handling. The host reflects the mode with a `keep-open` attribute on `lumine-panel.modal`. Core supplies an accented outline. One and Aura suppress that outline and tint their existing shadows through `--modal-shadow-near-color` and `--modal-shadow-far-color`, preserving the card's border, radius and shadow geometry.
