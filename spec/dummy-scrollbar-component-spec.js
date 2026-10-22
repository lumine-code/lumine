const DummyScrollbarComponent = require("../src/dummy-scrollbar-component");

describe("DummyScrollbarComponent", () => {
  const requestedPosition = 10_498_244.805;
  let components;

  beforeEach(() => {
    components = [];
  });

  afterEach(() => {
    for (const component of components) component.destroy();
  });

  for (const { orientation, positionProperty } of [
    { orientation: "vertical", positionProperty: "scrollTop" },
    { orientation: "horizontal", positionProperty: "scrollLeft" },
  ]) {
    describe(`with a ${orientation} scrollbar`, () => {
      it("preserves selection when an overlay scrollbar receives a mouse down", () => {
        const didMouseDown = jasmine.createSpy("didMouseDown");
        const component = buildComponent(orientation, () => {}, didMouseDown);
        spyOn(component.element, "getBoundingClientRect").and.returnValue({
          bottom: 100,
          right: 100,
        });
        spyOn(component, "getRealScrollbarWidth").and.returnValue(0);
        spyOn(component, "getRealScrollbarHeight").and.returnValue(0);

        component.didMouseDown({ target: component.element, clientX: 75, clientY: 75 });

        expect(didMouseDown).not.toHaveBeenCalled();
      });

      it("forwards content mouse downs even when geometry overlaps the scrollbar", () => {
        const didMouseDown = jasmine.createSpy("didMouseDown");
        const component = buildComponent(orientation, () => {}, didMouseDown);
        spyOn(component.element, "getBoundingClientRect").and.returnValue({
          bottom: 100,
          right: 100,
        });
        spyOn(component, "getRealScrollbarWidth").and.returnValue(15);
        spyOn(component, "getRealScrollbarHeight").and.returnValue(15);
        const event = { target: component.innerElement, clientX: 95, clientY: 95 };

        component.didMouseDown(event);

        expect(didMouseDown).toHaveBeenCalledOnceWith(event);
      });

      it("uses measured scrollbar bounds for mouse downs without a target", () => {
        const didMouseDown = jasmine.createSpy("didMouseDown");
        const component = buildComponent(orientation, () => {}, didMouseDown);
        spyOn(component.element, "getBoundingClientRect").and.returnValue({
          bottom: 100,
          right: 100,
        });
        spyOn(component, "getRealScrollbarWidth").and.returnValue(15);
        spyOn(component, "getRealScrollbarHeight").and.returnValue(15);
        component.didMouseDown({ clientX: 95, clientY: 95 });
        expect(didMouseDown).not.toHaveBeenCalled();

        const contentEvent = { clientX: 50, clientY: 50 };
        component.didMouseDown(contentEvent);

        expect(didMouseDown).toHaveBeenCalledOnceWith(contentEvent);
      });

      it("ignores native scroll events echoing a quantized programmatic position", () => {
        const didScroll = jasmine.createSpy("didScroll");
        const component = buildComponent(orientation, didScroll);
        const nativePosition = emulateNativeQuantization(component.element, positionProperty);

        component.flushScrollPosition();

        expect(nativePosition.get()).toBe(Math.round(requestedPosition));
        expect(nativePosition.get()).not.toBe(requestedPosition);

        component.element.dispatchEvent(new Event("scroll"));
        component.element.dispatchEvent(new Event("scroll"));

        expect(didScroll).not.toHaveBeenCalled();
      });

      it("uses the latest native position when programmatic writes are coalesced", () => {
        const didScroll = jasmine.createSpy("didScroll");
        const component = buildComponent(orientation, didScroll);
        const nativePosition = emulateNativeQuantization(component.element, positionProperty);

        component.updateScrollPosition(requestedPosition + 64.2);
        component.updateScrollPosition(requestedPosition + 128.6);
        const latestNativePosition = nativePosition.get();
        component.element.dispatchEvent(new Event("scroll"));
        component.element.dispatchEvent(new Event("scroll"));

        expect(latestNativePosition).toBe(Math.round(requestedPosition + 128.6));
        expect(didScroll).not.toHaveBeenCalled();
      });

      it("reports native movement with its orientation and position", () => {
        const didScroll = jasmine.createSpy("didScroll");
        const component = buildComponent(orientation, didScroll);
        const nativePosition = emulateNativeQuantization(component.element, positionProperty);
        component.flushScrollPosition();
        const userPosition = nativePosition.get() - 64;

        nativePosition.set(userPosition);
        component.element.dispatchEvent(new Event("scroll"));

        expect(didScroll).toHaveBeenCalledOnceWith({ orientation, position: userPosition });
      });

      it("stops reporting native movement after it is destroyed", () => {
        const didScroll = jasmine.createSpy("didScroll");
        const component = buildComponent(orientation, didScroll);
        const nativePosition = emulateNativeQuantization(component.element, positionProperty);
        component.flushScrollPosition();
        component.destroy();

        nativePosition.set(nativePosition.get() - 64);
        component.element.dispatchEvent(new Event("scroll"));

        expect(didScroll).not.toHaveBeenCalled();
      });

      it("acknowledges native movement without writing it back and ignores duplicate events", () => {
        const didScroll = jasmine.createSpy("didScroll");
        const component = buildComponent(orientation, didScroll);
        const native = emulateNativeQuantization(component.element, positionProperty);
        component.flushScrollPosition();
        const write = spyOnProperty(component.element, positionProperty, "set").and.callThrough();
        const position = native.get() - 64;
        native.set(position);
        component.didScroll();
        component.didScroll();
        component.update({ ...component.props, [positionProperty]: position });
        expect(didScroll).toHaveBeenCalledOnceWith({ orientation, position });
        expect(write).not.toHaveBeenCalled();
        component.updateScrollPosition(position - 10.2);
        expect(write).toHaveBeenCalledTimes(1);
        expect(native.get()).toBe(Math.round(position - 10.2));
      });

      it("invalidates a native acknowledgement when scrollbar geometry changes", () => {
        const component = buildComponent(orientation, () => {});
        const native = emulateNativeQuantization(component.element, positionProperty);
        component.flushScrollPosition();
        const write = spyOnProperty(component.element, positionProperty, "set").and.callThrough();
        const position = native.get() - 64;
        native.set(position);
        component.didScroll();
        component.update({
          ...component.props,
          [positionProperty]: position,
          scrollHeight: 500,
          scrollWidth: 500,
        });
        expect(write).toHaveBeenCalledTimes(1);
      });

      it("accepts the latest coalesced native movement and consumes its acknowledgement only once", () => {
        const component = buildComponent(orientation, () => {});
        const native = emulateNativeQuantization(component.element, positionProperty);
        component.flushScrollPosition();
        const write = spyOnProperty(component.element, positionProperty, "set").and.callThrough();
        native.set(200);
        component.didScroll();
        native.set(300);
        component.didScroll();
        component.updateScrollPosition(300);
        expect(write).not.toHaveBeenCalled();
        component.flushScrollPosition();
        expect(write).toHaveBeenCalledTimes(1);
      });
    });
  }

  function buildComponent(orientation, didScroll, didMouseDown = () => {}) {
    const component = new DummyScrollbarComponent({
      orientation,
      didScroll,
      didMouseDown,
      canScroll: true,
      forceScrollbarVisible: false,
      scrollHeight: 11_000_000,
      scrollWidth: 11_000_000,
      scrollTop: requestedPosition,
      scrollLeft: requestedPosition,
      horizontalScrollbarHeight: 15,
      verticalScrollbarWidth: 15,
    });
    components.push(component);
    return component;
  }

  function emulateNativeQuantization(element, propertyName) {
    let position = 0;
    Object.defineProperty(element, propertyName, {
      configurable: true,
      get() {
        return position;
      },
      set(value) {
        position = Math.round(value);
      },
    });
    return {
      get() {
        return position;
      },
      set(value) {
        position = value;
      },
    };
  }
});
