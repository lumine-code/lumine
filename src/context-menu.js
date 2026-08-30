const { Menu } = require("electron");

module.exports = class ContextMenu {
  constructor(template, lumineWindow) {
    this.lumineWindow = lumineWindow;
    this.createClickHandlers(template);
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: this.lumineWindow.browserWindow });
  }

  // It's necessary to build the event handlers in this process, otherwise
  // closures are dragged across processes and failed to be garbage collected
  // appropriately.
  createClickHandlers(template) {
    template.forEach((item) => {
      if (item.command) {
        if (!item.commandDetail) item.commandDetail = {};
        item.commandDetail.contextCommand = true;
        item.click = () => {
          global.lumineApplication.sendCommandToWindow(
            item.command,
            this.lumineWindow,
            item.commandDetail,
          );
        };
      } else if (item.submenu) {
        this.createClickHandlers(item.submenu);
      }
    });
  }
};
