const DecorationManager = require("../src/decoration-manager");
const TextEditor = require("../src/text-editor");

describe("DecorationManager", function () {
  let decorationManager, buffer, editor, markerLayer1, markerLayer2;

  beforeEach(async function () {
    buffer = lumine.project.bufferForPathSync("sample.js");
    editor = new TextEditor({ buffer });
    markerLayer1 = editor.addMarkerLayer();
    markerLayer2 = editor.addMarkerLayer();
    decorationManager = new DecorationManager(editor);

    await lumine.packages.activatePackage("language-javascript");
  });

  afterEach(() => buffer.destroy());

  describe("decoration layer teardown", () => {
    it("releases all layer bookkeeping when layer decorations are repeatedly destroyed", () => {
      for (let i = 0; i < 3; i++) {
        const layer = editor.addMarkerLayer();
        const decoration = decorationManager.decorateMarkerLayer(layer, {
          type: "text",
          class: "semantic-tokens",
        });
        const subscription = decorationManager.layerUpdateDisposablesByLayer.get(layer);
        spyOn(subscription, "dispose").and.callThrough();
        expect(decorationManager.decorationCountsByLayer.get(layer)).toBe(1);

        decoration.destroy();
        decoration.destroy();
        expect(decorationManager.decorationCountsByLayer.size).toBe(0);
        expect(decorationManager.markerDecorationCountsByLayer.size).toBe(0);
        expect(decorationManager.layerDecorationsByMarkerLayer.size).toBe(0);
        expect(decorationManager.layerUpdateDisposablesByLayer.has(layer)).toBe(false);
        expect(subscription.dispose).toHaveBeenCalledTimes(1);
        layer.destroy();
      }
    });

    it("counts marker decorations separately when their layer decoration is destroyed", () => {
      const layer = editor.addMarkerLayer();
      const marker = layer.markBufferRange([
        [0, 0],
        [0, 1],
      ]);
      const layerDecoration = decorationManager.decorateMarkerLayer(layer, { type: "text" });
      const first = decorationManager.decorateMarker(marker, { type: "highlight", class: "one" });
      const second = decorationManager.decorateMarker(marker, { type: "highlight", class: "two" });
      expect(decorationManager.decorationCountsByLayer.get(layer)).toBe(3);
      expect(decorationManager.markerDecorationCountsByLayer.get(layer)).toBe(2);

      layerDecoration.destroy();
      expect(decorationManager.decorationCountsByLayer.get(layer)).toBe(2);
      expect(decorationManager.markerDecorationCountsByLayer.get(layer)).toBe(2);
      first.destroy();
      expect(decorationManager.decorationCountsByLayer.get(layer)).toBe(1);
      expect(decorationManager.markerDecorationCountsByLayer.get(layer)).toBe(1);
      expect(
        decorationManager.decorationPropertiesByMarkerForScreenRowRange(0, 1).get(marker),
      ).toEqual([second.getProperties()]);

      second.destroy();
      expect(decorationManager.decorationCountsByLayer.size).toBe(0);
      expect(decorationManager.markerDecorationCountsByLayer.size).toBe(0);
      expect(decorationManager.decorationsByMarker.size).toBe(0);
      expect(decorationManager.layerDecorationsByMarkerLayer.size).toBe(0);
      expect(decorationManager.layerUpdateDisposablesByLayer.has(layer)).toBe(false);
    });

    it("keeps a layer decoration active after its marker decoration is destroyed", () => {
      const layer = editor.addMarkerLayer();
      const marker = layer.markBufferRange([
        [0, 0],
        [0, 1],
      ]);
      const layerDecoration = decorationManager.decorateMarkerLayer(layer, {
        type: "text",
        class: "semantic-tokens",
      });
      const markerDecoration = decorationManager.decorateMarker(marker, { type: "highlight" });
      const subscription = decorationManager.layerUpdateDisposablesByLayer.get(layer);
      spyOn(subscription, "dispose").and.callThrough();

      markerDecoration.destroy();
      expect(decorationManager.decorationCountsByLayer.get(layer)).toBe(1);
      expect(decorationManager.markerDecorationCountsByLayer.size).toBe(0);
      expect(subscription.dispose).not.toHaveBeenCalled();
      expect(
        decorationManager.decorationPropertiesByMarkerForScreenRowRange(0, 1).get(marker),
      ).toEqual([layerDecoration.getProperties()]);

      layerDecoration.destroy();
      expect(decorationManager.decorationCountsByLayer.size).toBe(0);
      expect(decorationManager.layerDecorationsByMarkerLayer.size).toBe(0);
      expect(decorationManager.layerUpdateDisposablesByLayer.has(layer)).toBe(false);
      expect(subscription.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("decorations", function () {
    let [
      layer1Marker,
      layer2Marker,
      layer1MarkerDecoration,
      layer2MarkerDecoration,
      decorationProperties,
    ] = [];
    beforeEach(function () {
      layer1Marker = markerLayer1.markBufferRange([
        [2, 13],
        [3, 15],
      ]);
      decorationProperties = { type: "line-number", class: "one" };
      layer1MarkerDecoration = decorationManager.decorateMarker(layer1Marker, decorationProperties);
      layer2Marker = markerLayer2.markBufferRange([
        [2, 13],
        [3, 15],
      ]);
      layer2MarkerDecoration = decorationManager.decorateMarker(layer2Marker, decorationProperties);
    });

    it("can add decorations associated with markers and remove them", function () {
      expect(layer1MarkerDecoration).toBeDefined();
      expect(layer1MarkerDecoration.getProperties()).toBe(decorationProperties);
      expect(decorationManager.decorationsForScreenRowRange(2, 3)).toEqual({
        [layer1Marker.id]: [layer1MarkerDecoration],
        [layer2Marker.id]: [layer2MarkerDecoration],
      });

      layer1MarkerDecoration.destroy();
      expect(
        decorationManager.decorationsForScreenRowRange(2, 3)[layer1Marker.id],
      ).not.toBeDefined();
      layer2MarkerDecoration.destroy();
      expect(
        decorationManager.decorationsForScreenRowRange(2, 3)[layer2Marker.id],
      ).not.toBeDefined();
    });

    it("will not fail if the decoration is removed twice", function () {
      layer1MarkerDecoration.destroy();
      layer1MarkerDecoration.destroy();
    });

    it("does not allow destroyed markers to be decorated", function () {
      layer1Marker.destroy();
      expect(() =>
        decorationManager.decorateMarker(layer1Marker, {
          type: "overlay",
          item: document.createElement("div"),
        }),
      ).toThrowError("Cannot decorate a destroyed marker");
      expect(decorationManager.getOverlayDecorations()).toEqual([]);
    });

    it("does not allow destroyed marker layers to be decorated", function () {
      const layer = editor.addMarkerLayer();
      layer.destroy();
      expect(() =>
        decorationManager.decorateMarkerLayer(layer, { type: "highlight" }),
      ).toThrowError("Cannot decorate a destroyed marker layer");
    });

    describe("when a decoration is updated via Decoration::update()", () =>
      it("emits an 'updated' event containing the new and old params", function () {
        let updatedSpy;
        layer1MarkerDecoration.onDidChangeProperties((updatedSpy = jasmine.createSpy()));
        layer1MarkerDecoration.setProperties({
          type: "line-number",
          class: "two",
        });

        const { oldProperties, newProperties } = updatedSpy.calls.mostRecent().args[0];
        expect(oldProperties).toEqual(decorationProperties);
        expect(newProperties.type).toBe("line-number");
        expect(newProperties.gutterName).toBe("line-number");
        expect(newProperties.class).toBe("two");
      }));

    describe("::getDecorations(properties)", () =>
      it("returns decorations matching the given optional properties", function () {
        expect(decorationManager.getDecorations()).toEqual([
          layer1MarkerDecoration,
          layer2MarkerDecoration,
        ]);
        expect(decorationManager.getDecorations({ class: "two" }).length).toEqual(0);
        expect(decorationManager.getDecorations({ class: "one" }).length).toEqual(2);
      }));
  });

  describe("::decorateMarker", () =>
    describe("when decorating gutters", function () {
      let [layer1Marker] = [];

      beforeEach(
        () =>
          (layer1Marker = markerLayer1.markBufferRange([
            [1, 0],
            [1, 0],
          ])),
      );

      it("creates a decoration that is both of 'line-number' and 'gutter' type when called with the 'line-number' type", function () {
        const decorationProperties = { type: "line-number", class: "one" };
        const layer1MarkerDecoration = decorationManager.decorateMarker(
          layer1Marker,
          decorationProperties,
        );
        expect(layer1MarkerDecoration.isType("line-number")).toBe(true);
        expect(layer1MarkerDecoration.isType("gutter")).toBe(true);
        expect(layer1MarkerDecoration.isType(["highlight", "gutter"])).toBe(true);
        expect(layer1MarkerDecoration.isType(["highlight", "overlay"])).toBe(false);
        expect(layer1MarkerDecoration.isType([])).toBe(false);
        expect(layer1MarkerDecoration.getProperties().gutterName).toBe("line-number");
        expect(layer1MarkerDecoration.getProperties().class).toBe("one");
      });

      it("creates a decoration that is only of 'gutter' type if called with the 'gutter' type and a 'gutterName'", function () {
        const decorationProperties = {
          type: "gutter",
          gutterName: "test-gutter",
          class: "one",
        };
        const layer1MarkerDecoration = decorationManager.decorateMarker(
          layer1Marker,
          decorationProperties,
        );
        expect(layer1MarkerDecoration.isType("gutter")).toBe(true);
        expect(layer1MarkerDecoration.isType("line-number")).toBe(false);
        expect(layer1MarkerDecoration.getProperties().gutterName).toBe("test-gutter");
        expect(layer1MarkerDecoration.getProperties().class).toBe("one");
      });
    }));

  it("matches any requested type when the decoration itself has multiple types", function () {
    const marker = markerLayer1.markBufferPosition([0, 0]);
    const decoration = decorationManager.decorateMarker(marker, {
      type: ["line", "line-number"],
      class: "multi-type",
    });
    expect(decoration.isType(["highlight", "line"])).toBe(true);
    expect(decoration.isType(["overlay", "gutter"])).toBe(true);
    expect(decoration.isType(["highlight", "overlay"])).toBe(false);
  });
});
