const definitions = [
  require("./pane-container-element").elementDefinition,
  require("./pane-axis-element").elementDefinition,
  require("./pane-element").elementDefinition,
  require("./pane-resize-handle-element").elementDefinition,
  require("./panel-container-element").elementDefinition,
  require("./styles-element").elementDefinition,
  require("./text-editor-element").elementDefinition,
  require("./workspace-element").elementDefinition,
];

module.exports = function registerCoreElements(elementRegistry) {
  for (const definition of definitions) {
    if (!definition) throw new Error("A core custom element has no realm-local definition");
    elementRegistry.define(definition.name, definition.factory, definition.options);
  }
};
