const { Emitter } = require("@lumine-code/event-kit");
const Notification = require("../src/notification");

/**
 * A notification manager used to create {@link Notification Notifications} to be shown
 * to the user.
 *
 * An instance of this class is always available as the `lumine.notifications`
 * global.
 *
 * @public
 * @api-status Public
 */
module.exports = class NotificationManager {
  constructor() {
    this.notifications = [];
    this.emitter = new Emitter();
  }

  /**
   * @category Events
   */

  /**
   * Invoke the given callback after a notification has been added.
   *
   * @param {Function} callback - to be called after the notification is added.
   * @param callback.notification - The {@link Notification} that was added.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidAddNotification(callback) {
    return this.emitter.on("did-add-notification", callback);
  }

  /**
   * Invoke the given callback after the notifications have been cleared.
   *
   * @param {Function} callback - to be called after the notifications are cleared.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidClearNotifications(callback) {
    return this.emitter.on("did-clear-notifications", callback);
  }

  /**
   * Invoke the given callback whenever {@link #beep} is called.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidBeep(callback) {
    return this.emitter.on("did-beep", callback);
  }

  /**
   * @category Adding Notifications
   */

  /**
   * Add a success notification.
   *
   * @param message - A `String` message
   * @param [options] - An `Object` with the following keys:
   * @param [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-success`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'check'`.
   * @returns {Notification} that was added.
   * @public
   * @api-status Public
   */
  addSuccess(message, options) {
    return this.addNotification(new Notification("success", message, options));
  }

  /**
   * Add an informational notification.
   *
   * @param message - A `String` message
   * @param [options] - An `Object` with the following keys:
   * @param [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-info`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'info'`.
   * @returns {Notification} that was added.
   * @public
   * @api-status Public
   */
  addInfo(message, options) {
    return this.addNotification(new Notification("info", message, options));
  }

  /**
   * Add a warning notification.
   *
   * @param message - A `String` message
   * @param [options] - An `Object` with the following keys:
   * @param [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-warning`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'alert'`.
   * @returns {Notification} that was added.
   * @public
   * @api-status Public
   */
  addWarning(message, options) {
    return this.addNotification(new Notification("warning", message, options));
  }

  /**
   * Add an error notification.
   *
   * @param message - A `String` message
   * @param [options] - An `Object` with the following keys:
   * @param [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-error`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'flame'`.
   * @param [options.stack] - A preformatted `String` with stack trace information describing the location of the error. Requires `detail` to be set.
   * @returns {Notification} that was added.
   * @public
   * @api-status Public
   */
  addError(message, options) {
    return this.addNotification(new Notification("error", message, options));
  }

  /**
   * Add a fatal error notification.
   *
   * @param message - A `String` message
   * @param [options] - An `Object` with the following keys:
   * @param [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-error`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'bug'`.
   * @param [options.stack] - A preformatted `String` with stack trace information describing the location of the error. Requires `detail` to be set.
   * @returns {Notification} that was added.
   * @public
   * @api-status Public
   */
  addFatalError(message, options) {
    return this.addNotification(new Notification("fatal", message, options));
  }

  add(type, message, options) {
    return this.addNotification(new Notification(type, message, options));
  }

  addNotification(notification) {
    this.notifications.push(notification);
    this.emitter.emit("did-add-notification", notification);
    return notification;
  }

  /**
   * Request audible or visual attention from notification consumers.
   *
   * @public
   * @api-status Public
   */
  beep() {
    this.emitter.emit("did-beep");
  }

  /**
   * @category Getting Notifications
   */

  /**
   * Get all the notifications.
   *
   * @returns {Array} of {@link Notification Notifications}.
   * @public
   * @api-status Public
   */
  getNotifications() {
    return this.notifications.slice();
  }

  /**
   * @category Managing Notifications
   */

  /**
   * Clear all the notifications.
   *
   * @public
   * @api-status Public
   */
  clear() {
    this.notifications = [];
    this.emitter.emit("did-clear-notifications");
  }
};
