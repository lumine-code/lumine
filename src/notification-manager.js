const { Emitter } = require("@lumine-code/event-kit");
const Notification = require("../src/notification");

/**
 * @public
 * @status public
 *
 * A notification manager used to create {@link Notification Notifications} to be shown
 * to the user.
 *
 * An instance of this class is always available as the `lumine.notifications`
 * global.
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
   * @public
   * @status public
   *
   * Invoke the given callback after a notification has been added.
   *
   * @param {Function} callback - to be called after the notification is added.
   * @param {Notification} callback.notification - The {@link Notification} that was added.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddNotification(callback) {
    return this.emitter.on("did-add-notification", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback after the notifications have been cleared.
   *
   * @param {Function} callback - to be called after the notifications are cleared.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidClearNotifications(callback) {
    return this.emitter.on("did-clear-notifications", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback whenever {@link #beep} is called.
   *
   * @param {Function} callback - Called when attention is requested.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidBeep(callback) {
    return this.emitter.on("did-beep", callback);
  }

  /**
   * @category Adding Notifications
   */

  /**
   * @public
   * @status public
   *
   * Add a success notification.
   *
   * @param {String} message - A `String` message
   * @param {Object} [options] - An `Object` with the following keys:
   * @param {Array<Object>} [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-success`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param {String} [options.buttons.title] - Plain-text tooltip explaining the button's action.
   * @param {String} [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param {String} [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param {Boolean} [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param {String} [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'check'`.
   * @param {EditorWindow} [options.window] - The editor window in which to display the notification; defaults to the main window.
   * @returns {Notification} that was added.
   */
  addSuccess(message, options) {
    return this.addNotification(new Notification("success", message, options));
  }

  /**
   * @public
   * @status public
   *
   * Add a hint notification.
   *
   * A hint is the quietest thing this API can say: something the user may want
   * to know, that does not report a failure and asks nothing of them. It is
   * rendered without a severity color, so it reads as an aside rather than as a
   * smaller warning. Hints are expected to be transient — leave `dismissable`
   * unset unless the hint carries a button worth waiting for.
   *
   * Prefer a warning when something the user asked for did not happen.
   *
   * @param {String} message - A `String` message
   * @param {Object} [options] - An `Object` with the following keys:
   * @param {Array<Object>} [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param {String} [options.buttons.title] - Plain-text tooltip explaining the button's action.
   * @param {String} [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param {String} [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param {Boolean} [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param {String} [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'light-bulb'`.
   * @param {EditorWindow} [options.window] - The editor window in which to display the notification; defaults to the main window.
   * @returns {Notification} that was added.
   */
  addHint(message, options) {
    return this.addNotification(new Notification("hint", message, options));
  }

  /**
   * @public
   * @status public
   *
   * Add an informational notification.
   *
   * @param {String} message - A `String` message
   * @param {Object} [options] - An `Object` with the following keys:
   * @param {Array<Object>} [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-info`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param {String} [options.buttons.title] - Plain-text tooltip explaining the button's action.
   * @param {String} [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param {String} [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param {Boolean} [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param {String} [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'info'`.
   * @param {EditorWindow} [options.window] - The editor window in which to display the notification; defaults to the main window.
   * @returns {Notification} that was added.
   */
  addInfo(message, options) {
    return this.addNotification(new Notification("info", message, options));
  }

  /**
   * @public
   * @status public
   *
   * Add a warning notification.
   *
   * @param {String} message - A `String` message
   * @param {Object} [options] - An `Object` with the following keys:
   * @param {Array<Object>} [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-warning`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param {String} [options.buttons.title] - Plain-text tooltip explaining the button's action.
   * @param {String} [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param {String} [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param {Boolean} [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param {String} [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'alert'`.
   * @param {EditorWindow} [options.window] - The editor window in which to display the notification; defaults to the main window.
   * @returns {Notification} that was added.
   */
  addWarning(message, options) {
    return this.addNotification(new Notification("warning", message, options));
  }

  /**
   * @public
   * @status public
   *
   * Add an error notification.
   *
   * @param {String} message - A `String` message
   * @param {Object} [options] - An `Object` with the following keys:
   * @param {Array<Object>} [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-error`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param {String} [options.buttons.title] - Plain-text tooltip explaining the button's action.
   * @param {String} [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param {String} [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param {Boolean} [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param {String} [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'flame'`.
   * @param {EditorWindow} [options.window] - The editor window in which to display the notification; defaults to the main window.
   * @param {String} [options.stack] - A preformatted `String` with stack trace information describing the location of the error. Requires `detail` to be set.
   * @returns {Notification} that was added.
   */
  addError(message, options) {
    return this.addNotification(new Notification("error", message, options));
  }

  /**
   * @public
   * @status public
   *
   * Add a fatal error notification.
   *
   * @param {String} message - A `String` message
   * @param {Object} [options] - An `Object` with the following keys:
   * @param {Array<Object>} [options.buttons] - An `Array` of `Object` where each `Object` has the following options:
   * @param {String} [options.buttons.className] - a class name to add to the button's default class name (`btn btn-error`).
   * @param {Function} [options.buttons.onDidClick] - callback to call when the button has been clicked. The context will be set to the `NotificationElement` instance.
   * @param {String} options.buttons.text - inner text for the button
   * @param {String} [options.buttons.title] - Plain-text tooltip explaining the button's action.
   * @param {String} [options.description] - A Markdown `String` containing a longer description about the notification. By default, this **will not** preserve newlines and whitespace when it is rendered.
   * @param {String} [options.detail] - A plain-text `String` containing additional details about the notification. By default, this **will** preserve newlines and whitespace when it is rendered.
   * @param {Boolean} [options.dismissable] - A `Boolean` indicating whether this notification can be dismissed by the user. Defaults to `false`.
   * @param {String} [options.icon] - A `String` name of an icon from Octicons to display in the notification header. Defaults to `'bug'`.
   * @param {EditorWindow} [options.window] - The editor window in which to display the notification; defaults to the main window.
   * @param {String} [options.stack] - A preformatted `String` with stack trace information describing the location of the error. Requires `detail` to be set.
   * @returns {Notification} that was added.
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
   * @public
   * @status public
   *
   * Request audible or visual attention from notification consumers.
   * @category Requesting Attention
   */
  beep() {
    this.emitter.emit("did-beep");
  }

  /**
   * @category Getting Notifications
   */

  /**
   * @public
   * @status public
   *
   * Get all the notifications.
   *
   * @returns {Array<Notification>} of {@link Notification Notifications}.
   */
  getNotifications() {
    return this.notifications.slice();
  }

  /**
   * @category Managing Notifications
   */

  /**
   * @public
   * @status public
   *
   * Clear all the notifications.
   */
  clear() {
    this.notifications = [];
    this.emitter.emit("did-clear-notifications");
  }
};
