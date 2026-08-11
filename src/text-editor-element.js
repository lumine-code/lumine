const { Emitter, Range } = require("lumine");
const TextEditorComponent = require("./text-editor-component");

class TextEditorElement extends HTMLElement {
  initialize(component) {
    this.component = component;
    return this;
  }

  constructor() {
    super();
    this.emitter = new Emitter();
    this.initialText = this.textContent;
    if (this.tabIndex == null) this.tabIndex = -1;
    this.addEventListener("focus", (event) => this.getComponent().didFocus(event));
    this.addEventListener("blur", (event) => this.getComponent().didBlur(event));
  }

  connectedCallback() {
    this.getComponent().didAttach();
    this.emitter.emit("did-attach");
  }

  disconnectedCallback() {
    this.emitter.emit("did-detach");
    this.getComponent().didDetach();
  }

  static get observedAttributes() {
    return ["mini", "placeholder-text", "gutter-hidden", "readonly"];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (this.component) {
      switch (name) {
        case "mini":
          this.getModel().update({ mini: newValue != null });
          break;
        case "placeholder-text":
          this.getModel().update({ placeholderText: newValue });
          break;
        case "gutter-hidden":
          this.getModel().update({ lineNumberGutterVisible: newValue == null });
          break;
        case "readonly":
          this.getModel().update({ readOnly: newValue != null });
          break;
      }
    }
  }

  /**
   * Get a promise that resolves the next time the element's DOM
   * is updated in any way.
   *
   * This can be useful when you've made a change to the model and need to
   * be sure this change has been flushed to the DOM.
   *
   * @returns {Promise}
   * @public
   * @api-status Extended
   */
  getNextUpdatePromise() {
    return this.getComponent().getNextUpdatePromise();
  }

  getModel() {
    return this.getComponent().props.model;
  }

  copySelectedText() {
    return this.getComponent().copySelectedText();
  }

  copyOnlySelectedText() {
    return this.getComponent().copyOnlySelectedText();
  }

  cutSelectedText() {
    return this.getComponent().cutSelectedText();
  }

  pasteText(options, commandEvent) {
    return this.getComponent().pasteText(options, commandEvent);
  }

  setModel(model) {
    this.getComponent().update({ model });
    this.updateModelFromAttributes();
  }

  updateModelFromAttributes() {
    const props = { mini: this.hasAttribute("mini") };
    if (this.hasAttribute("placeholder-text"))
      props.placeholderText = this.getAttribute("placeholder-text");
    if (this.hasAttribute("gutter-hidden")) props.lineNumberGutterVisible = false;

    this.getModel().update(props);
    if (this.initialText) this.getModel().setText(this.initialText);
  }

  onDidAttach(callback) {
    return this.emitter.on("did-attach", callback);
  }

  onDidDetach(callback) {
    return this.emitter.on("did-detach", callback);
  }

  measureDimensions() {
    this.getComponent().measureDimensions();
  }

  setWidth(width) {
    this.style.width = this.getComponent().getGutterContainerWidth() + width + "px";
  }

  getWidth() {
    return this.getComponent().getScrollContainerWidth();
  }

  setHeight(height) {
    this.style.height = height + "px";
  }

  getHeight() {
    return this.getComponent().getScrollContainerHeight();
  }

  onDidChangeScrollLeft(callback) {
    return this.emitter.on("did-change-scroll-left", callback);
  }

  onDidChangeScrollTop(callback) {
    return this.emitter.on("did-change-scroll-top", callback);
  }

  onDidStartScrollAnimation(callback) {
    return this.emitter.on("did-start-scroll-animation", callback);
  }

  onDidEndScrollAnimation(callback) {
    return this.emitter.on("did-end-scroll-animation", callback);
  }

  // Deprecated: get the width of an `x` character displayed in this element.
  //
  // Returns a `Number` of pixels.
  getDefaultCharacterWidth() {
    return this.getComponent().getBaseCharacterWidth();
  }

  /**
   * get the width of an `x` character displayed in this element.
   *
   * @returns {Number} of pixels.
   * @public
   * @api-status Extended
   */
  getBaseCharacterWidth() {
    return this.getComponent().getBaseCharacterWidth();
  }

  getMaxScrollTop() {
    return this.getComponent().getMaxScrollTop();
  }

  getScrollHeight() {
    return this.getComponent().getScrollHeight();
  }

  getScrollWidth() {
    return this.getComponent().getScrollWidth();
  }

  getVerticalScrollbarWidth() {
    return this.getComponent().getVerticalScrollbarWidth();
  }

  getHorizontalScrollbarHeight() {
    return this.getComponent().getHorizontalScrollbarHeight();
  }

  getScrollTop() {
    return this.getComponent().getScrollTop();
  }

  setScrollTop(scrollTop) {
    const component = this.getComponent();
    component.setScrollTop(scrollTop);
    component.scheduleUpdate();
  }

  getScrollBottom() {
    return this.getComponent().getScrollBottom();
  }

  setScrollBottom(scrollBottom) {
    return this.getComponent().setScrollBottom(scrollBottom);
  }

  getScrollLeft() {
    return this.getComponent().getScrollLeft();
  }

  setScrollLeft(scrollLeft) {
    const component = this.getComponent();
    component.setScrollLeft(scrollLeft);
    component.scheduleUpdate();
  }

  getScrollRight() {
    return this.getComponent().getScrollRight();
  }

  setScrollRight(scrollRight) {
    return this.getComponent().setScrollRight(scrollRight);
  }

  /**
   * Scrolls the editor to the top.
   *
   * @public
   * @api-status Essential
   */
  scrollToTop() {
    this.setScrollTop(0);
  }

  /**
   * Scrolls the editor to the bottom.
   *
   * @public
   * @api-status Essential
   */
  scrollToBottom() {
    this.setScrollTop(Infinity);
  }

  hasFocus() {
    return this.getComponent().focused;
  }

  /**
   * Converts a buffer position to a pixel position.
   *
   *
   * Be aware that calling this method with a column that does not translate
   * to column 0 on screen could cause a synchronous DOM update in order to
   * measure the requested horizontal pixel position if it isn't already
   * cached.
   *
   * @param bufferPosition - A {@link Point}-like object that represents a buffer position.
   * @returns {Object} with two values: `top` and `left`, representing the pixel position.
   * @public
   * @api-status Extended
   */
  pixelPositionForBufferPosition(bufferPosition) {
    const screenPosition = this.getModel().screenPositionForBufferPosition(bufferPosition);
    return this.getComponent().pixelPositionForScreenPosition(screenPosition);
  }

  /**
   * Converts a screen position to a pixel position.
   *
   *
   * Be aware that calling this method with a non-zero column value could
   * cause a synchronous DOM update in order to measure the requested
   * horizontal pixel position if it isn't already cached.
   *
   * @param screenPosition - A {@link Point}-like object that represents a buffer position.
   * @returns {Object} with two values: `top` and `left`, representing the pixel position.
   * @public
   * @api-status Extended
   */
  pixelPositionForScreenPosition(screenPosition) {
    screenPosition = this.getModel().clipScreenPosition(screenPosition);
    return this.getComponent().pixelPositionForScreenPosition(screenPosition);
  }

  screenPositionForPixelPosition(pixelPosition) {
    return this.getComponent().screenPositionForPixelPosition(pixelPosition);
  }

  pixelRectForScreenRange(range) {
    range = Range.fromObject(range);

    const start = this.pixelPositionForScreenPosition(range.start);
    const end = this.pixelPositionForScreenPosition(range.end);
    const lineHeight = this.getComponent().getLineHeight();

    return {
      top: start.top,
      left: start.left,
      height: end.top + lineHeight - start.top,
      width: end.left - start.left,
    };
  }

  pixelRangeForScreenRange(range) {
    range = Range.fromObject(range);
    return {
      start: this.pixelPositionForScreenPosition(range.start),
      end: this.pixelPositionForScreenPosition(range.end),
    };
  }

  getComponent() {
    if (!this.component) {
      this.component = new TextEditorComponent({
        element: this,
        mini: this.hasAttribute("mini"),
        updatedSynchronously: this.updatedSynchronously,
        readOnly: this.hasAttribute("readonly"),
      });
      this.updateModelFromAttributes();
    }

    return this.component;
  }

  setUpdatedSynchronously(updatedSynchronously) {
    this.updatedSynchronously = updatedSynchronously;
    if (this.component) this.component.updatedSynchronously = updatedSynchronously;
    return updatedSynchronously;
  }

  isUpdatedSynchronously() {
    return this.component ? this.component.updatedSynchronously : this.updatedSynchronously;
  }

  /**
   * Invalidate the passed block {@link Decoration}'s dimensions,
   * forcing them to be recalculated and the surrounding content to be adjusted
   * on the next animation frame.
   *
   * @param {Decoration} blockDecoration - The block decoration whose dimensions
   *   should be recalculated.
   * @public
   * @api-status Experimental
   */
  invalidateBlockDecorationDimensions(blockDecoration) {
    this.getComponent().invalidateBlockDecorationDimensions(blockDecoration);
  }

  setFirstVisibleScreenRow(row) {
    this.getModel().setFirstVisibleScreenRow(row);
  }

  getFirstVisibleScreenRow() {
    return this.getModel().getFirstVisibleScreenRow();
  }

  getLastVisibleScreenRow() {
    return this.getModel().getLastVisibleScreenRow();
  }

  getVisibleRowRange() {
    return this.getModel().getVisibleRowRange();
  }

  intersectsVisibleRowRange(startRow, endRow) {
    return !(
      endRow <= this.getFirstVisibleScreenRow() || this.getLastVisibleScreenRow() <= startRow
    );
  }

  selectionIntersectsVisibleRowRange(selection) {
    const { start, end } = selection.getScreenRange();
    return this.intersectsVisibleRowRange(start.row, end.row + 1);
  }

  setFirstVisibleScreenColumn(column) {
    return this.getModel().setFirstVisibleScreenColumn(column);
  }

  getFirstVisibleScreenColumn() {
    return this.getModel().getFirstVisibleScreenColumn();
  }

  static createTextEditorElement() {
    return document.createElement("lumine-text-editor");
  }
}

window.customElements.define("lumine-text-editor", TextEditorElement);

module.exports = TextEditorElement;
