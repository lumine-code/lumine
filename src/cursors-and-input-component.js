module.exports = class CursorsAndInputComponent {
  constructor(props) {
    this.props = props;
    this.refs = {};
    this.cursorNodes = [];
    this.cursorCaches = [];
    this.hiddenInputCache = {};
    this.lastClassName = this.getCursorsClassName();
    this.lastScrollWidth = props.scrollWidth;
    this.lastScrollHeight = props.scrollHeight;

    this.element = document.createElement("div");
    this.element.className = this.lastClassName;
    const style = this.element.style;
    style.position = "absolute";
    style.contain = "strict";
    style.zIndex = 1;
    style.width = props.scrollWidth + "px";
    style.height = props.scrollHeight + "px";
    style.pointerEvents = "none";
    style.userSelect = "none";
    this.refs.cursors = this.element;

    this.buildHiddenInput();
    this.updateCursors();
  }

  update(props) {
    if (props.measuredContent) {
      this.props = props;

      const { scrollWidth, scrollHeight } = props;
      const className = this.getCursorsClassName();
      if (className !== this.lastClassName) {
        this.element.className = className;
        this.lastClassName = className;
      }
      if (scrollWidth !== this.lastScrollWidth) {
        this.element.style.width = scrollWidth + "px";
        this.lastScrollWidth = scrollWidth;
      }
      if (scrollHeight !== this.lastScrollHeight) {
        this.element.style.height = scrollHeight + "px";
        this.lastScrollHeight = scrollHeight;
      }

      this.updateHiddenInput();
      this.updateCursors();
    }
  }

  updateCursorBlinkSync(cursorsBlinkedOff) {
    this.props.cursorsBlinkedOff = cursorsBlinkedOff;
    const className = this.getCursorsClassName();
    this.refs.cursors.className = className;
    this.lastClassName = className;
  }

  getCursorsClassName() {
    return this.props.cursorsBlinkedOff ? "cursors blink-off" : "cursors";
  }

  updateCursors() {
    const { lineHeight, decorationsToRender, scrollWidth } = this.props;
    const cursors = decorationsToRender.cursors;
    const cursorHeight = lineHeight + "px";

    while (this.cursorNodes.length > cursors.length) {
      this.cursorNodes.pop().remove();
      this.cursorCaches.pop();
    }

    for (let i = 0; i < cursors.length; i++) {
      const {
        pixelLeft,
        pixelTop,
        pixelWidth,
        className: extraCursorClassName,
        style: extraCursorStyle,
      } = cursors[i];
      let cursorClassName = "cursor";
      if (extraCursorClassName) cursorClassName += " " + extraCursorClassName;

      const cursorStyle = {
        height: cursorHeight,
        width: Math.min(pixelWidth, scrollWidth - pixelLeft) + "px",
        transform: `translate(${pixelLeft}px, ${pixelTop}px)`,
      };
      if (extraCursorStyle) Object.assign(cursorStyle, extraCursorStyle);

      let node = this.cursorNodes[i];
      let cache = this.cursorCaches[i];
      if (!node) {
        node = document.createElement("div");
        this.element.appendChild(node);
        this.cursorNodes.push(node);
        cache = {};
        this.cursorCaches.push(cache);
      }

      if (cache.className !== cursorClassName) {
        node.className = cursorClassName;
        cache.className = cursorClassName;
      }

      const oldStyle = cache.style;
      if (oldStyle) {
        for (const key in oldStyle) {
          if (!(key in cursorStyle)) node.style[key] = "";
        }
        for (const key in cursorStyle) {
          if (oldStyle[key] !== cursorStyle[key]) node.style[key] = cursorStyle[key];
        }
      } else {
        for (const key in cursorStyle) {
          node.style[key] = cursorStyle[key];
        }
      }
      cache.style = cursorStyle;
    }
  }

  buildHiddenInput() {
    const {
      didBlurHiddenInput,
      didFocusHiddenInput,
      didCopy,
      didCut,
      didPaste,
      didTextInput,
      didKeydown,
      didKeyup,
      didKeypress,
      didCompositionStart,
      didCompositionUpdate,
      didCompositionEnd,
    } = this.props;

    const input = document.createElement("input");
    input.className = "hidden-input";
    input.addEventListener("blur", didBlurHiddenInput);
    input.addEventListener("focus", didFocusHiddenInput);
    input.addEventListener("copy", didCopy);
    input.addEventListener("cut", didCut);
    input.addEventListener("paste", didPaste);
    input.addEventListener("textInput", didTextInput);
    input.addEventListener("keydown", didKeydown);
    input.addEventListener("keyup", didKeyup);
    input.addEventListener("keypress", didKeypress);
    input.addEventListener("compositionstart", didCompositionStart);
    input.addEventListener("compositionupdate", didCompositionUpdate);
    input.addEventListener("compositionend", didCompositionEnd);

    const style = input.style;
    style.position = "absolute";
    style.width = "1px";
    style.opacity = 0;
    style.padding = 0;
    style.border = 0;

    this.refs.hiddenInput = input;
    this.element.appendChild(input);
    this.updateHiddenInput();
  }

  updateHiddenInput() {
    const { lineHeight, hiddenInputPosition, tabIndex } = this.props;

    let top, left;
    if (hiddenInputPosition) {
      top = hiddenInputPosition.pixelTop;
      left = hiddenInputPosition.pixelLeft;
    } else {
      top = 0;
      left = 0;
    }

    const input = this.refs.hiddenInput;
    const cache = this.hiddenInputCache;
    if (cache.lineHeight !== lineHeight) {
      input.style.height = lineHeight + "px";
      cache.lineHeight = lineHeight;
    }
    if (cache.top !== top) {
      input.style.top = top + "px";
      cache.top = top;
    }
    if (cache.left !== left) {
      input.style.left = left + "px";
      cache.left = left;
    }
    if (cache.tabIndex !== tabIndex) {
      input.tabIndex = tabIndex;
      cache.tabIndex = tabIndex;
    }
  }
};
