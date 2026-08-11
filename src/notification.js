const { Emitter } = require("@lumine-code/event-kit");
const _ = require("@lumine-code/underscore-plus");

/**
 * A notification to the user containing a message and type.
 *
 * @public
 * @api-status Public
 */
module.exports = class Notification {
  constructor(type, message, options = {}) {
    this.type = type;
    this.message = message;
    this.options = options;
    this.emitter = new Emitter();
    this.timestamp = new Date();
    this.dismissed = true;
    if (this.isDismissable()) this.dismissed = false;
    this.displayed = false;
    this.validate();
  }

  validate() {
    if (typeof this.message !== "string") {
      throw new Error(`Notification must be created with string message: ${this.message}`);
    }

    if (!_.isObject(this.options) || Array.isArray(this.options)) {
      throw new Error(`Notification must be created with an options object: ${this.options}`);
    }
  }

  /**
   * @category Event Subscription
   */

  /**
   * Invoke the given callback when the notification is dismissed.
   *
   * @param {Function} callback - to be called when the notification is dismissed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidDismiss(callback) {
    return this.emitter.on("did-dismiss", callback);
  }

  /**
   * Invoke the given callback when the notification is displayed.
   *
   * @param {Function} callback - to be called when the notification is displayed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidDisplay(callback) {
    return this.emitter.on("did-display", callback);
  }

  getOptions() {
    return this.options;
  }

  /**
   * @category Methods
   */

  /**
   * @returns {String} type.
   * @public
   * @api-status Public
   */
  getType() {
    return this.type;
  }

  /**
   * @returns {String} message.
   * @public
   * @api-status Public
   */
  getMessage() {
    return this.message;
  }

  getTimestamp() {
    return this.timestamp;
  }

  getDetail() {
    return this.options.detail;
  }

  isEqual(other) {
    return (
      this.getMessage() === other.getMessage() &&
      this.getType() === other.getType() &&
      this.getDetail() === other.getDetail()
    );
  }

  /**
   * Dismisses the notification, removing it from the UI. Calling this
   * programmatically will call all callbacks added via `onDidDismiss`.
   *
   * @public
   * @api-status Extended
   */
  dismiss() {
    if (!this.isDismissable() || this.isDismissed()) return;
    this.dismissed = true;
    this.emitter.emit("did-dismiss", this);
  }

  isDismissed() {
    return this.dismissed;
  }

  isDismissable() {
    return !!this.options.dismissable;
  }

  wasDisplayed() {
    return this.displayed;
  }

  setDisplayed(displayed) {
    this.displayed = displayed;
    this.emitter.emit("did-display", this);
  }

  getIcon() {
    if (this.options.icon != null) return this.options.icon;
    switch (this.type) {
      case "fatal":
        return "bug";
      case "error":
        return "flame";
      case "warning":
        return "alert";
      case "info":
        return "info";
      case "success":
        return "check";
    }
  }
};
