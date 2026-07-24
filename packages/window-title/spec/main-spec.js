const os = require("os");
const path = require("path");
const { Disposable, Emitter } = require("atom");

describe("Window Title package", () => {
  let setRepresentedFilename;

  beforeEach(() => {
    document.title = "Lumine";
    setRepresentedFilename = spyOn(atom.applicationDelegate, "setRepresentedFilename").andCallFake(
      () => {},
    );
  });

  async function activate(customTemplate) {
    atom.config.set("window-title.template", "Custom");
    atom.config.set("window-title.custom", customTemplate);
    return atom.packages.activatePackage("window-title");
  }

  it("updates the title and represented filename from workspace state", async () => {
    const projectPath = path.dirname(__filename);
    const filePath = __filename;
    const renamedPath = path.join(projectPath, "renamed.js");
    atom.project.setPaths([projectPath]);

    await activate("{{ fileName }} — {{ projectName }}");
    const editor = await atom.workspace.open();
    editor.getBuffer().setPath(filePath);

    expect(document.title).toBe(`${path.basename(filePath)} — ${path.basename(projectPath)}`);
    expect(setRepresentedFilename).toHaveBeenCalledWith(filePath);

    editor.getBuffer().setPath(renamedPath);

    expect(document.title).toBe(`renamed.js — ${path.basename(projectPath)}`);
    expect(setRepresentedFilename).toHaveBeenCalledWith(renamedPath);

    atom.config.set("window-title.template", "Full Path");
    expect(document.title).toBe(renamedPath);

    atom.config.set("window-title.template", "File");
    expect(document.title).toBe("renamed.js");

    atom.config.set("window-title.template", "Project");
    expect(document.title).toBe(path.basename(projectPath));

    atom.config.set("window-title.template", "Project and File");
    expect(document.title).toBe(`${path.basename(projectPath)} — renamed.js`);
  });

  it("updates when project paths change", async () => {
    const firstProjectPath = os.tmpdir();
    const secondProjectPath = path.resolve(__dirname, "../../..");
    atom.project.setPaths([firstProjectPath]);
    await activate("{{ projectName }} ({{ projectCount }})");

    expect(document.title).toBe(`${path.basename(firstProjectPath)} (1)`);

    atom.project.setPaths([secondProjectPath, firstProjectPath]);

    expect(document.title).toBe(`${path.basename(secondProjectPath)} (2)`);
    expect(setRepresentedFilename).toHaveBeenCalledWith(secondProjectPath);
  });

  it("omits the project-and-file separator when there is no file", async () => {
    const projectPath = path.resolve(__dirname, "..");
    atom.project.setPaths([projectPath]);
    atom.config.set("window-title.template", "Project and File");

    await atom.packages.activatePackage("window-title");

    expect(document.title).toBe(path.basename(projectPath));
  });

  it("updates for pane items with a title API and removes their listener on deactivation", async () => {
    let itemTitle = "Titled Item";
    const emitter = new Emitter();
    const item = {
      element: document.createElement("div"),
      getTitle: () => itemTitle,
      onDidChangeTitle: (callback) => emitter.on("did-change-title", callback),
    };

    await activate("{{ fileName }}");
    atom.workspace.getActivePane().activateItem(item);

    expect(document.title).toBe("Titled Item");

    itemTitle = "Renamed Item";
    emitter.emit("did-change-title");

    expect(document.title).toBe("Renamed Item");

    await atom.packages.deactivatePackage("window-title");
    itemTitle = "Ignored Title";
    emitter.emit("did-change-title");

    expect(document.title).toBe("Lumine");
    expect(setRepresentedFilename).toHaveBeenCalledWith("");
  });

  it("uses the Lumine fallback for empty and invalid templates", async () => {
    await activate("");
    expect(document.title).toBe("Lumine");

    atom.config.set("window-title.custom", "{% if projectTitle %}");
    expect(document.title).toBe("Lumine");
  });

  it("updates when the current project-list project changes", async () => {
    const pack = await activate("{{ projectTitle }}");
    let currentProject = { title: "First Project" };
    let didChangeCurrentProject;
    const service = {
      getCurrentProject: () => currentProject,
      onDidChangeCurrentProject(callback) {
        didChangeCurrentProject = callback;
        return new Disposable();
      },
      updateView() {},
    };
    const serviceDisposable = pack.mainModule.consumeProjectList(service);

    expect(document.title).toBe("First Project");

    currentProject = { title: "Second Project" };
    didChangeCurrentProject();

    expect(document.title).toBe("Second Project");

    serviceDisposable.dispose();
    expect(document.title).toBe("Lumine");
  });
});
