/** @babel */
/** @jsx etch.dom */

import etch from "@lumine-code/etch";
import dedent from "dedent";
import CodeBlock from "./code-block";

export default class ExampleSelectListView {
  constructor() {
    this.jsExampleCode = dedent`
    const selectListView = atom.workspace.buildSelectList({
      items: ['one', 'two', 'three'],
      elementForItem: (item) => {
        const li = document.createElement('li')
        li.textContent = item
        return li
      },
      didConfirmSelection: (item) => {
        console.log('confirmed', item)
      },
      didCancelSelection: () => {
        console.log('cancelled')
      }
    })
    `;

    // The list is built rather than rendered as an etch component: the editor
    // hands back an instance, and etch needs a constructor in tag position. Its
    // element is adopted into the tree below instead.
    this.selectListView = atom.workspace.buildSelectList({
      items: ["one", "two", "three"],
      // This is a static showcase, not a live picker in a fixed modal.
      // Auto-selecting an item would call scrollIntoViewIfNeeded and
      // scroll the whole styleguide down to this mid-page example.
      initialSelectionIndex: undefined,
      elementForItem: this.elementForItem.bind(this),
      didConfirmSelection: this.didConfirmSelection.bind(this),
      didCancelSelection: this.didCancelSelection.bind(this),
    });

    etch.initialize(this);
    this.refs.host.appendChild(this.selectListView.element);
  }

  elementForItem(item) {
    const li = document.createElement("li");
    li.textContent = item;
    return li;
  }

  didConfirmSelection(item) {
    console.log("confirmed", item);
  }

  didCancelSelection() {
    console.log("cancelled");
  }

  render() {
    return (
      <div className="example">
        <div className="example-rendered">
          <atom-panel className="modal" ref="host" />
        </div>
        <div className="example-code show-example-space-pen">
          <CodeBlock
            cssClass="example-space-pen"
            grammarScopeName="source.js"
            code={this.jsExampleCode}
          />
        </div>
      </div>
    );
  }

  update() {}

  destroy() {
    this.selectListView.destroy();
    return etch.destroy(this);
  }
}
