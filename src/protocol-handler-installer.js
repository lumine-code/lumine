const { ipcRenderer } = require("electron");

const SETTING = "core.uriHandlerRegistration";
const PROMPT = "prompt";
const ALWAYS = "always";
const NEVER = "never";

module.exports = class ProtocolHandlerInstaller {
  isSupported() {
    return ["win32", "darwin"].includes(process.platform);
  }

  async isDefaultProtocolClient() {
    return ipcRenderer.invoke("lumine:app", "isDefaultProtocolClient", "lumine", process.execPath, [
      "--uri-handler",
      "--",
    ]);
  }

  async setAsDefaultProtocolClient() {
    // This Electron API is only available on Windows and macOS. There might be some
    // hacks to make it work on Linux; see https://github.com/electron/electron/issues/6440
    return (
      this.isSupported() &&
      ipcRenderer.invoke("lumine:app", "setAsDefaultProtocolClient", "lumine", process.execPath, [
        "--uri-handler",
        "--",
      ])
    );
  }

  async initialize(config, notifications, devMode) {
    // Running from source, `process.execPath` is node_modules/electron's binary,
    // which is never what an installed Lumine registers. Every branch below would
    // then act on the wrong executable: `prompt` and `always` would point
    // lumine:// at the Electron binary, and `never` would delete the installed
    // build's registration. The config directory is shared between the two, so
    // the choice cannot be scoped to the dev instance either — skip it outright.
    if (!this.isSupported() || devMode) {
      return;
    }

    const behaviorWhenNotProtocolClient = config.get(SETTING);
    switch (behaviorWhenNotProtocolClient) {
      case PROMPT:
        if (!(await this.isDefaultProtocolClient())) {
          this.promptToBecomeProtocolClient(config, notifications);
        }
        break;
      case ALWAYS:
        if (!(await this.isDefaultProtocolClient())) {
          this.setAsDefaultProtocolClient();
        }
        break;
      case NEVER:
        if (process.platform === "win32") {
          // Only win32 supports deregistration
          const Registry = require("./win-registry.js");
          const commandKey = new Registry({ hive: "HKCR", key: `\\lumine` });
          commandKey.destroy((_err, _val) => {
            /* no op */
          });
        }
        break;
      default:
      // Do nothing
    }
  }

  promptToBecomeProtocolClient(config, notifications) {
    let notification;

    const withSetting = (value, fn) => {
      return function () {
        config.set(SETTING, value);
        fn();
      };
    };

    const accept = () => {
      notification.dismiss();
      this.setAsDefaultProtocolClient();
    };
    const decline = () => {
      notification.dismiss();
    };

    notification = notifications.addInfo("Register as default lumine:// URI handler?", {
      dismissable: true,
      icon: "link",
      description:
        "Lumine is not currently set as the default handler for lumine:// URIs. Would you like Lumine to handle " +
        "lumine:// URIs?",
      buttons: [
        {
          // The recommended answer is the accent button; naming a variant here
          // replaces the one this notification's severity would supply. The
          // other three take no class at all, since `btn` comes from the
          // notification's own button template and `btn-info` from its type.
          text: "Yes",
          className: "btn-primary",
          onDidClick: accept,
        },
        {
          text: "Yes, Always",
          onDidClick: withSetting(ALWAYS, accept),
        },
        {
          text: "No",
          onDidClick: decline,
        },
        {
          text: "No, Never",
          onDidClick: withSetting(NEVER, decline),
        },
      ],
    });
  }
};
