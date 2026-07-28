/** @babel */
/** @jsx etch.dom */

import etch from "@lumine-code/etch";
import dedent from "dedent";
import CodeBlock from "./code-block";

export default class ExampleSelectListView {
  constructor() {
    this.jsExampleCode = dedent`
    const session = atom.modals.open({
      id: 'my-package.numbers',
      source: ['one', 'two', 'three'],
      confirm: ({ item }) => {
        console.log('confirmed', item)
      },
      didClose: (result) => {
        if (result.status === 'cancelled') console.log('cancelled')
      }
    })
    `;
    etch.initialize(this);
    this.mountExample();
  }

  // A live inline session rather than a picture of one: `mount` gives the same
  // rendering and keyboard handling with no panel, no focus policy and no
  // global commands, so it cannot take over the page it is documenting.
  mountExample() {
    if (!this.refs.example) return;
    this.session = atom.modals.mount(this.refs.example, {
      id: "styleguide.example-list",
      source: ["one", "two", "three"],
      // Nothing is focused on first paint: activating a row would scroll the
      // styleguide down to this mid-page example.
      initialActivation: "none",
      confirm: ({ item }) => {
        console.log("confirmed", item);
        return { keepOpen: true };
      },
    });
  }

  render() {
    return (
      <div className="example">
        <div className="example-rendered">
          <div ref="example" />
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
    if (this.session) this.session.cancel("api");
    return etch.destroy(this);
  }
}
