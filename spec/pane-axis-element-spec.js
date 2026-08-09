const PaneAxis = require("../src/pane-axis");
const PaneContainer = require("../src/pane-container");
const Pane = require("../src/pane");

const buildPane = () =>
  new Pane({
    applicationDelegate: lumine.applicationDelegate,
    config: lumine.config,
    deserializerManager: lumine.deserializers,
    notificationManager: lumine.notifications,
    viewRegistry: lumine.views,
  });

describe("PaneAxisElement", () =>
  it("correctly subscribes and unsubscribes to the underlying model events on attach/detach", function () {
    const container = new PaneContainer({
      config: lumine.config,
      applicationDelegate: lumine.applicationDelegate,
      viewRegistry: lumine.views,
    });
    const axis = new PaneAxis({}, lumine.views);
    axis.setContainer(container);
    const axisElement = axis.getElement();

    const panes = [buildPane(), buildPane(), buildPane()];

    jasmine.attachToDOM(axisElement);
    axis.addChild(panes[0]);
    expect(axisElement.children[0]).toBe(panes[0].getElement());

    axisElement.remove();
    axis.addChild(panes[1]);
    expect(axisElement.children[2]).toBeUndefined();

    jasmine.attachToDOM(axisElement);
    expect(axisElement.children[2]).toBe(panes[1].getElement());

    axis.addChild(panes[2]);
    expect(axisElement.children[4]).toBe(panes[2].getElement());
  }));
