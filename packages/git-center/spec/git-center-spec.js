const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  divergenceChips,
  divergenceTooltipLine,
  statusChips,
  statusTooltipLine,
  summarizeStatus,
} = require("../lib/status-summary");

function makeWorkdir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Minimal stand-ins for the fields `summarizeStatus` reads, so the counting
// rules can be exercised without driving Git to produce each state.
function statusEntry(overrides = {}) {
  return {
    kind: "ordinary",
    indexStatus: null,
    worktreeStatus: "M",
    conflicted: false,
    untracked: false,
    ignored: false,
    ...overrides,
  };
}

function statusSnapshot(files) {
  return { initialized: true, files };
}

function chipTexts(element) {
  return Array.from(element.querySelectorAll("span"), (span) => span.textContent);
}

function chipClass(element, text) {
  return Array.from(element.querySelectorAll("span")).find((span) => span.textContent === text)
    ?.className;
}

async function initializeRepository(prefix) {
  const workingDirectory = makeWorkdir(prefix);
  const repository = await atom.repositories.initialize(workingDirectory, {
    initialBranch: "main",
  });
  const operations = repository.getOperations();
  await operations.setConfig("user.name", "Git Center Specs");
  await operations.setConfig("user.email", "specs@lumine.invalid");
  fs.writeFileSync(path.join(workingDirectory, "file.txt"), "content\n");
  await operations.stageFiles(["file.txt"]);
  await operations.commit("Initial commit");
  return { workingDirectory, repository };
}

describe("git-center status summary", () => {
  it("counts each change kind and ignores ignored entries", () => {
    const summary = summarizeStatus(
      statusSnapshot([
        statusEntry({ untracked: true, worktreeStatus: null }),
        statusEntry({ indexStatus: "A", worktreeStatus: null }),
        statusEntry({ worktreeStatus: "M" }),
        statusEntry({ kind: "renamed", indexStatus: "R", worktreeStatus: null }),
        statusEntry({ worktreeStatus: "D" }),
        statusEntry({ indexStatus: "D", worktreeStatus: null }),
        statusEntry({ kind: "unmerged", conflicted: true }),
        statusEntry({ ignored: true, kind: "ignored", worktreeStatus: null }),
      ]),
    );

    // A rename counts as modified, and a deletion staged or not counts as removed.
    expect(summary).toEqual({ added: 2, modified: 2, removed: 2, conflicted: 1 });
  });

  it("counts a file that is staged and then edited again only once", () => {
    // `staged` and `unstaged` are not mutually exclusive in a snapshot, but the
    // file is still a single modification.
    const summary = summarizeStatus(
      statusSnapshot([statusEntry({ indexStatus: "M", worktreeStatus: "M" })]),
    );
    expect(summary).toEqual({ added: 0, modified: 1, removed: 0, conflicted: 0 });
  });

  it("reports nothing before the first snapshot has loaded", () => {
    expect(summarizeStatus(null)).toBeNull();
    expect(summarizeStatus({ initialized: false, files: [] })).toBeNull();
    expect(statusChips(null)).toEqual([]);
    expect(statusTooltipLine(null)).toBeNull();
  });

  it("emits a chip only for kinds that have something to report", () => {
    expect(statusChips(summarizeStatus(statusSnapshot([])))).toEqual([]);

    const chips = statusChips({ added: 3, modified: 12, removed: 1, conflicted: 0 });
    expect(chips.map((chip) => chip.text)).toEqual(["+3", "~12", "-1"]);
    // Colors come from core's shared classes, never from this package.
    expect(chips.map((chip) => chip.className)).toEqual([
      "git-center-count status-added",
      "git-center-count status-modified",
      "git-center-count status-removed",
    ]);
    expect(statusTooltipLine({ added: 3, modified: 12, removed: 1, conflicted: 0 })).toBe(
      "3 added, 12 modified, 1 deleted",
    );
  });

  it("describes upstream divergence, or that the upstream is gone", () => {
    expect(divergenceChips(null)).toEqual([]);
    expect(divergenceChips({ name: "origin/main", ahead: 0, behind: 0 })).toEqual([]);

    const chips = divergenceChips({ name: "origin/main", ahead: 2, behind: 1 });
    expect(chips.map((chip) => chip.text)).toEqual(["↑2", "↓1"]);
    expect(divergenceTooltipLine({ name: "origin/main", ahead: 2, behind: 1 })).toBe(
      "2 ahead, 1 behind of origin/main",
    );
    expect(divergenceTooltipLine({ name: "origin/main", ahead: 0, behind: 0 })).toBe(
      "Up to date with origin/main",
    );

    // A deleted upstream makes the counts meaningless, so they are not shown.
    const gone = divergenceChips({ name: "origin/old", ahead: 4, behind: 0, gone: true });
    expect(gone.map((chip) => chip.text)).toEqual(["gone"]);
    expect(divergenceTooltipLine({ name: "origin/old", gone: true })).toBe(
      "Upstream origin/old is gone",
    );
  });
});

describe("git-center", () => {
  let mainModule;
  let repoA;
  let repoB;

  beforeEach(async () => {
    await atom.packages.activatePackage("status-bar");
    mainModule = (await atom.packages.activatePackage("git-center")).mainModule;

    repoA = await initializeRepository("git-center-a-");
    repoB = await initializeRepository("git-center-b-");
    atom.repositories.setActiveRepository(repoA.repository);
    await repoA.repository.refreshStatusSnapshot();
    await repoB.repository.refreshStatusSnapshot();
  });

  afterEach(async () => {
    atom.repositories.setActiveRepository(null);
    atom.repositories.forget(repoA.repository);
    atom.repositories.forget(repoB.repository);
    await atom.packages.deactivatePackage("git-center");
    await atom.packages.deactivatePackage("status-bar");
  });

  it("shows the active repository and branch in the status bar", () => {
    const repositoryView = mainModule.repositoryStatusView;
    const branchView = mainModule.branchStatusView;
    repositoryView.update();
    branchView.update();

    expect(repositoryView.element.style.display).toBe("");
    expect(repositoryView.nameLabel.textContent).toBe(path.basename(repoA.workingDirectory));
    expect(branchView.branchLabel.textContent).toBe("main");

    atom.repositories.setActiveRepository(repoB.repository);
    expect(repositoryView.nameLabel.textContent).toBe(path.basename(repoB.workingDirectory));

    atom.repositories.setActiveRepository(repoB.repository, { pin: true });
    expect(repositoryView.icon.classList.contains("icon-lock")).toBe(true);
    expect(repositoryView.icon.classList.contains("icon-repo")).toBe(false);
    atom.repositories.setActiveRepository(null);
  });

  it("keeps the repository tile visible but hides the branch tile without a repository", () => {
    const repositoryView = mainModule.repositoryStatusView;
    const branchView = mainModule.branchStatusView;
    const outsideDir = makeWorkdir("git-center-outside-");
    spyOn(atom.repositories, "getActiveRepository").andReturn(null);
    spyOn(atom.repositories, "getActiveRepositoryContext").andReturn({
      repository: null,
      workingDirectory: outsideDir,
      pinned: false,
    });

    repositoryView.update();
    branchView.update();

    expect(repositoryView.element.style.display).toBe("");
    expect(repositoryView.element.classList.contains("no-repository")).toBe(true);
    expect(repositoryView.nameLabel.textContent).toBe(path.basename(outsideDir));
    // There is no branch to switch, so the branch tile hides entirely.
    expect(branchView.element.style.display).toBe("none");

    // Returning to a repository clears the no-repo state and restores the tile.
    atom.repositories.getActiveRepository.andReturn(repoA.repository);
    atom.repositories.getActiveRepositoryContext.andReturn({
      repository: repoA.repository,
      workingDirectory: repoA.workingDirectory,
      pinned: false,
    });
    repositoryView.update();
    branchView.update();
    expect(repositoryView.element.classList.contains("no-repository")).toBe(false);
    expect(repositoryView.nameLabel.textContent).toBe(path.basename(repoA.workingDirectory));
    expect(branchView.element.style.display).toBe("");
    expect(branchView.branchLabel.textContent).toBe("main");
  });

  it("cycles repositories with the mouse wheel and toggles the pin with middle click", () => {
    const repositoryView = mainModule.repositoryStatusView;
    const repositories = [repoA.repository, repoB.repository];
    spyOn(atom.repositories, "getRepositories").andReturn(repositories);

    const wheel = (deltaY) =>
      repositoryView.element.dispatchEvent(new WheelEvent("wheel", { deltaY, cancelable: true }));

    wheel(120);
    const second = atom.repositories.getActiveRepository();
    expect(repositories).toContain(second);
    expect(second).not.toBe(repoA.repository);

    wheel(120);
    expect(atom.repositories.getActiveRepository()).toBe(repoA.repository);

    wheel(-120);
    expect(atom.repositories.getActiveRepository()).toBe(second);

    // Small trackpad deltas accumulate instead of switching per event.
    wheel(20);
    expect(atom.repositories.getActiveRepository()).toBe(second);

    const middleClick = () =>
      repositoryView.element.dispatchEvent(
        new MouseEvent("auxclick", { button: 1, cancelable: true }),
      );
    expect(atom.repositories.isActiveRepositoryPinned()).toBe(false);
    middleClick();
    expect(atom.repositories.isActiveRepositoryPinned()).toBe(true);
    expect(atom.repositories.getActiveRepository()).toBe(second);
    middleClick();
    expect(atom.repositories.isActiveRepositoryPinned()).toBe(false);
  });

  it("switches the active repository through the repository picker", async () => {
    await mainModule.getRepositoryListView().toggle();
    const listView = mainModule.repositoryListView.selectListView;
    expect(listView.isVisible()).toBe(true);

    const items = listView.props.items;
    expect(items[0].auto).toBe(true);
    expect(items[0].repoName).toBe("Auto");
    expect(items[1].rescan).toBe(true);
    expect(items[2].repository).toBe(repoA.repository);
    const autoElement = Array.from(listView.element.querySelectorAll(".list-group li")).find(
      (element) => element.textContent.includes("Auto"),
    );
    expect(autoElement.querySelector(".secondary-line").textContent).toBe(
      "The active repository is updated based on the active editor.",
    );
    expect(items.slice(2).every((item) => item.current)).toBe(true);

    const separators = Array.from(
      listView.element.querySelectorAll(".list-group > .select-list-separator"),
    );
    expect(separators.length).toBe(1);
    expect(separators[0].nextElementSibling.querySelector(".primary-text").textContent).toBe(
      items[2].repoName,
    );

    const target = items.find((item) => item.repository === repoB.repository);
    expect(target).toBeTruthy();
    listView.props.didConfirmSelection(target);

    expect(atom.repositories.getActiveRepository()).toBe(repoB.repository);
    expect(atom.repositories.isActiveRepositoryPinned()).toBe(true);
    expect(listView.isVisible()).toBe(false);

    await mainModule.getRepositoryListView().toggle();
    const auto = listView.props.items.find((item) => item.auto);
    listView.props.didConfirmSelection(auto);
    expect(atom.repositories.isActiveRepositoryPinned()).toBe(false);
  });

  it("shows a loading status while the rescan item scans repositories", async () => {
    let finishScan;
    spyOn(atom.repositories, "setProjectRoots");
    const scan = spyOn(atom.repositories, "scanProjectRoots").andReturn(
      new Promise((resolve) => (finishScan = resolve)),
    );
    const rescanFinished = new Promise((resolve) => {
      const subscription = atom.repositories.onDidFinishRescan((event) => {
        subscription.dispose();
        resolve(event);
      });
    });
    const repositoryListView = mainModule.getRepositoryListView();
    await repositoryListView.toggle();
    const listView = repositoryListView.selectListView;
    const rescanItem = listView.props.items.find((item) => item.rescan);
    Object.defineProperty(listView.refs.items, "scrollTop", {
      configurable: true,
      value: 41,
      writable: true,
    });

    expect(rescanItem.repoName).toBe("Rescan repositories");
    listView.props.didConfirmSelection(rescanItem);
    expect(scan).toHaveBeenCalled();
    expect(listView.isVisible()).toBe(true);
    await listView.update({});
    expect(listView.refs.loadingMessage.textContent).toBe("Loading repositories…");
    expect(listView.props.items).toEqual([]);
    expect(listView.element.querySelectorAll(".list-group li").length).toBe(0);
    expect(repositoryListView.rescanScrollTop).toBe(41);

    finishScan([]);
    await rescanFinished;
    await repositoryListView.requestRefresh();
    await Promise.resolve();
    expect(listView.props.loadingMessage).toBeNull();
    expect(listView.props.items.length).toBeGreaterThan(0);
    expect(repositoryListView.rescanScrollTop).toBeNull();
  });

  it("refreshes an open repository picker without moving its scroll position", async () => {
    const repositoryListView = mainModule.getRepositoryListView();
    await repositoryListView.toggle();
    const listView = repositoryListView.selectListView;
    Object.defineProperty(listView.refs.items, "scrollTop", {
      configurable: true,
      value: 37,
      writable: true,
    });
    spyOn(repositoryListView, "requestRefresh").andCallThrough();

    fs.writeFileSync(path.join(repoA.workingDirectory, "new.txt"), "new\n");
    await repoA.repository.refreshStatusSnapshot();
    expect(repositoryListView.requestRefresh).toHaveBeenCalled();
    await repositoryListView.requestRefresh.calls.mostRecent().returnValue;

    const item = listView.props.items.find((entry) => entry.repository === repoA.repository);
    expect(item.status.added).toBe(1);
    expect(listView.refs.items.scrollTop).toBe(37);

    repositoryListView.hide();
    repositoryListView.requestRefresh.calls.reset();
    fs.writeFileSync(path.join(repoA.workingDirectory, "another.txt"), "another\n");
    await repoA.repository.refreshStatusSnapshot();
    expect(repositoryListView.requestRefresh).not.toHaveBeenCalled();
  });

  it("checks out a branch through the branch picker", async () => {
    await repoA.repository.getOperations().checkout("feature", { createNew: true });
    await repoA.repository.getOperations().checkout("main");
    await repoA.repository.refreshRefsSnapshot();

    await mainModule.getBranchListView().toggle();
    const listView = mainModule.branchListView.selectListView;
    expect(listView.isVisible()).toBe(true);

    const items = listView.props.items;
    expect(items.slice(0, 3).map((item) => item.branch)).toEqual([
      "Create new branch...",
      "Create new branch from...",
      "Checkout detached...",
    ]);
    expect(
      items.filter((item) => !item.action).every((item) => item.repository === repoA.repository),
    ).toBe(true);
    const target = items.find((item) => item.branch === "feature");
    expect(target).toBeTruthy();
    const didChangeRefs = new Promise((resolve) => {
      const subscription = repoA.repository.onDidChangeRefsSnapshot(() => {
        subscription.dispose();
        resolve();
      });
    });
    listView.props.didConfirmSelection(target);
    await didChangeRefs;
    expect(repoA.repository.getRefsSnapshot().head.name).toBe("feature");
  });

  it("lists local branches, remote branches, and tags with last-commit details", async () => {
    const operations = repoA.repository.getOperations();
    const remoteDir = makeWorkdir("git-center-checkout-remote-");
    await atom.repositories.executeGit(["init", "--bare", "--initial-branch=main", "."], remoteDir);
    await operations.addRemote("origin", remoteDir);
    await operations.push("origin", "main", { setUpstream: true });

    await operations.checkout("remote-only", { createNew: true });
    await operations.push("origin", "remote-only");
    await operations.checkout("main");
    await atom.repositories.executeGit(["branch", "-D", "remote-only"], repoA.workingDirectory);
    await atom.repositories.executeGit(
      ["tag", "-a", "v1.0.0", "-m", "Release v1.0.0"],
      repoA.workingDirectory,
    );
    await repoA.repository.refreshRefsSnapshot();

    const branchListView = mainModule.getBranchListView();
    await branchListView.toggle();
    const listView = branchListView.selectListView;
    const refs = listView.props.items.filter((item) => !item.action);

    expect(refs.map((item) => item.kind)).toEqual(["local", "remote", "remote", "tag"]);
    expect(refs.map((item) => item.branch)).toEqual([
      "main",
      "origin/main",
      "origin/remote-only",
      "v1.0.0",
    ]);
    expect(refs.every((item) => item.lastCommit?.subject === "Initial commit")).toBe(true);

    const separators = Array.from(
      listView.element.querySelectorAll(".list-group > .select-list-separator"),
    );
    expect(separators.length).toBe(3);
    const firstRowsAfterSeparators = separators.map((separator) =>
      separator.nextElementSibling.querySelector(".primary-text").textContent.trim(),
    );
    expect(firstRowsAfterSeparators[0]).toMatch(/^main /);
    expect(firstRowsAfterSeparators[1]).toMatch(/^origin\/main /);
    expect(firstRowsAfterSeparators[2]).toMatch(/^v1\.0\.0 /);
    // The rules are the whole of the grouping: no kind carries a label.
    expect(listView.element.querySelector(".git-center-ref-group")).toBeNull();

    const mainRow = Array.from(listView.element.querySelectorAll(".list-group li")).find(
      (element) =>
        element
          .querySelector(".primary-line.icon-git-branch .primary-text")
          ?.textContent.startsWith("main "),
    );
    const shortHead = repoA.repository.getRefsSnapshot().head.oid.slice(0, 7);
    expect(mainRow.querySelector(".git-center-ref-time").textContent.trim()).toMatch(
      /^(?:now|in \d+ \w+|\d+ \w+ ago)$/,
    );
    expect(mainRow.querySelector(".secondary-line").textContent).toBe(
      `Git Center Specs • ${shortHead} • Initial commit`,
    );

    spyOn(operations, "checkout").andReturn(Promise.resolve());
    branchListView.confirmCheckoutItem(refs.find((item) => item.branch === "origin/main"));
    expect(operations.checkout).not.toHaveBeenCalled();

    listView.props.didConfirmSelection(refs.find((item) => item.branch === "origin/remote-only"));
    expect(operations.checkout).toHaveBeenCalledWith("remote-only", {
      createNew: true,
      track: true,
      startPoint: "origin/remote-only",
    });

    branchListView.confirmCheckoutItem(refs.find((item) => item.kind === "tag"));
    expect(operations.checkout).toHaveBeenCalledWith("refs/tags/v1.0.0", { detach: true });
  });

  it("refreshes an open branch picker without moving its scroll position", async () => {
    const branchListView = mainModule.getBranchListView();
    await branchListView.toggle();
    const listView = branchListView.selectListView;
    Object.defineProperty(listView.refs.items, "scrollTop", {
      configurable: true,
      value: 53,
      writable: true,
    });
    spyOn(branchListView, "requestBranchRefresh").andCallThrough();

    await atom.repositories.executeGit(["branch", "feature"], repoA.workingDirectory);
    await repoA.repository.refreshRefsSnapshot();
    expect(branchListView.requestBranchRefresh).toHaveBeenCalled();
    await branchListView.requestBranchRefresh.calls.mostRecent().returnValue;

    expect(listView.props.items.some((item) => item.branch === "feature")).toBe(true);
    expect(listView.refs.items.scrollTop).toBe(53);
  });

  it("shows working-tree counts on the repository tile and in the picker", async () => {
    const operations = repoA.repository.getOperations();
    const filePath = (name) => path.join(repoA.workingDirectory, name);

    fs.writeFileSync(filePath("doomed.txt"), "doomed\n");
    await operations.stageFiles(["doomed.txt"]);
    await operations.commit("Add a file to delete");

    fs.unlinkSync(filePath("doomed.txt"));
    fs.writeFileSync(filePath("file.txt"), "changed\n");
    fs.writeFileSync(filePath("untracked.txt"), "new\n");
    await repoA.repository.refreshStatusSnapshot();

    const repositoryView = mainModule.repositoryStatusView;
    repositoryView.update();
    expect(chipTexts(repositoryView.statusLabel)).toEqual(["+1", "~1", "-1"]);
    expect(chipClass(repositoryView.statusLabel, "+1")).toBe("git-center-count status-added");
    expect(chipClass(repositoryView.statusLabel, "-1")).toBe("git-center-count status-removed");

    await mainModule.getRepositoryListView().toggle();
    const listView = mainModule.repositoryListView.selectListView;
    const row = Array.from(listView.element.querySelectorAll(".list-group li")).find((element) =>
      element.textContent.includes(path.basename(repoA.workingDirectory)),
    );
    const trailing = row.querySelector(".trailing-block");
    expect(chipTexts(trailing)).toEqual(["+1", "~1", "-1", "main"]);
  });

  it("takes its chip colors from core rather than defining its own", async () => {
    // The package deliberately ships no color rule for file status; the chips
    // carry core's shared `status-*` classes instead. Nothing else asserts that
    // those stylesheets actually reach this markup, or that the per-window
    // colorize toggle still switches them off.
    fs.writeFileSync(path.join(repoA.workingDirectory, "file.txt"), "changed\n");
    fs.writeFileSync(path.join(repoA.workingDirectory, "untracked.txt"), "new\n");
    await repoA.repository.refreshStatusSnapshot();

    jasmine.attachToDOM(atom.workspace.getElement());
    await mainModule.getRepositoryListView().toggle();
    const listView = mainModule.repositoryListView.selectListView;
    jasmine.attachToDOM(listView.element);

    const row = Array.from(listView.element.querySelectorAll(".list-group li")).find((element) =>
      element.textContent.includes(path.basename(repoA.workingDirectory)),
    );

    // Floating the block blockifies its display, which is why the rule says flex.
    const block = getComputedStyle(row.querySelector(".trailing-block"));
    expect(block.float).toBe("right");
    expect(block.display).toBe("flex");

    const colorOf = (selector) => getComputedStyle(row.querySelector(selector)).color;
    const plain = colorOf(".primary-text");
    expect(colorOf(".status-added")).not.toBe(plain);
    expect(colorOf(".status-modified")).not.toBe(plain);
    expect(colorOf(".status-added")).not.toBe(colorOf(".status-modified"));

    // `git:colorize-toggle` flips this class on the body; core's zero-specificity
    // guard has to take the chips down with everything else.
    document.body.classList.add("git-colorize-disabled");
    try {
      expect(colorOf(".status-added")).toBe(plain);
    } finally {
      document.body.classList.remove("git-colorize-disabled");
    }
  });

  it("shows upstream divergence once a branch is tracking a remote", async () => {
    const operations = repoA.repository.getOperations();
    const remoteDir = makeWorkdir("git-center-remote-");
    await atom.repositories.executeGit(["init", "--bare", "--initial-branch=main", "."], remoteDir);
    await operations.addRemote("origin", remoteDir);
    await operations.push("origin", "main", { setUpstream: true });

    fs.writeFileSync(path.join(repoA.workingDirectory, "ahead.txt"), "ahead\n");
    await operations.stageFiles(["ahead.txt"]);
    await operations.commit("Commit that the remote does not have");
    await repoA.repository.refreshStatusSnapshot();
    await repoA.repository.refreshRefsSnapshot();

    const snapshot = repoA.repository.getStatusSnapshot();
    expect(snapshot.upstream.name).toBe("origin/main");
    expect(snapshot.upstream.ahead).toBe(1);
    expect(snapshot.upstream.behind).toBe(0);

    const branchView = mainModule.branchStatusView;
    branchView.update();
    expect(chipTexts(branchView.divergenceLabel)).toEqual(["↑1"]);

    // The branch picker reads its counts per branch, from the refs snapshot.
    await mainModule.getBranchListView().toggle();
    const listView = mainModule.branchListView.selectListView;
    const item = listView.props.items.find((entry) => entry.branch === "main");
    expect(item.upstream.name).toBe("origin/main");
    expect(item.upstream.ahead).toBe(1);

    const row = Array.from(listView.element.querySelectorAll(".list-group li")).find((element) =>
      element
        .querySelector(".primary-line.icon-git-branch .primary-text")
        ?.textContent.startsWith("main "),
    );
    expect(row.querySelector(".secondary-line").textContent).toContain("Commit that the remote");
    expect(chipTexts(row.querySelector(".trailing-block"))).toEqual(["↑1", "current"]);
  });

  it("reports a deleted upstream instead of claiming the branch is up to date", async () => {
    // Git omits the `branch.ab` header once the upstream commit is gone, which
    // parses as zero ahead and zero behind — so the status snapshot cannot tell
    // "up to date" from "upstream deleted". Only the refs snapshot carries
    // `gone`, which is why the tile reads its upstream from there.
    const operations = repoA.repository.getOperations();
    const remoteDir = makeWorkdir("git-center-gone-remote-");
    await atom.repositories.executeGit(["init", "--bare", "--initial-branch=main", "."], remoteDir);
    await operations.addRemote("origin", remoteDir);
    await operations.push("origin", "main", { setUpstream: true });

    // Delete the branch on the remote and prune, leaving the tracking config.
    await atom.repositories.executeGit(["branch", "-D", "main"], remoteDir);
    await operations.fetch("origin", null, { prune: true });
    await repoA.repository.refreshStatusSnapshot();
    await repoA.repository.refreshRefsSnapshot();

    const snapshot = repoA.repository.getStatusSnapshot();
    const refsUpstream = repoA.repository
      .getRefsSnapshot()
      .branches.find((branch) => branch.isHead).upstream;
    // The precondition this whole fix rests on: the status snapshot looks clean.
    expect(snapshot.upstream && snapshot.upstream.ahead).toBe(0);
    expect(snapshot.upstream && snapshot.upstream.behind).toBe(0);
    expect(refsUpstream.gone).toBe(true);

    const branchView = mainModule.branchStatusView;
    branchView.update();
    expect(chipTexts(branchView.divergenceLabel)).toEqual(["gone"]);
    expect(branchView.branchTooltipDisposable).toBeTruthy();
  });

  it("enters the repository list at either end when nothing is active", () => {
    const repositoryView = mainModule.repositoryStatusView;
    const sorted = [repoA.repository, repoB.repository].sort((a, b) =>
      path.basename(a.getWorkingDirectory()).localeCompare(path.basename(b.getWorkingDirectory())),
    );
    spyOn(atom.repositories, "getRepositories").andReturn(sorted);
    spyOn(atom.repositories, "getActiveRepository").andReturn(null);
    spyOn(atom.repositories, "setActiveRepository");

    // Stepping off "no active repository" must not skip past the far end.
    repositoryView.cycleRepository(-1);
    expect(atom.repositories.setActiveRepository).toHaveBeenCalledWith(sorted[sorted.length - 1], {
      pin: false,
    });

    repositoryView.cycleRepository(1);
    expect(atom.repositories.setActiveRepository).toHaveBeenCalledWith(sorted[0], { pin: false });
  });

  it("leaves branch actions on one line and shows commit details below refs", async () => {
    await mainModule.getBranchListView().toggle();
    const listView = mainModule.branchListView.selectListView;
    const rows = Array.from(
      listView.element.querySelectorAll(".list-group > li:not(.select-list-separator)"),
    );

    // The three action rows carry no secondary line, so they stay compact.
    for (const row of rows.slice(0, 3)) {
      expect(row.classList.contains("two-lines")).toBe(false);
      expect(row.querySelector(".secondary-line")).toBeNull();
    }

    const branchRow = rows[3];
    expect(branchRow.classList.contains("two-lines")).toBe(true);
    expect(branchRow.querySelector(".secondary-line").textContent).toMatch(
      /^Git Center Specs • [0-9a-f]{7} • Initial commit$/,
    );
  });

  it("creates branches from HEAD or another ref and checks out detached", async () => {
    const branchListView = mainModule.getBranchListView();
    const operations = repoA.repository.getOperations();
    spyOn(operations, "checkout").andReturn(Promise.resolve());

    branchListView.performAction("create");
    const nameInputDialogView = branchListView.branchNameDialog.inputDialogView;
    expect(nameInputDialogView.props.infoMessage).toBe("Please provide a new branch name");
    expect(nameInputDialogView.refs.queryEditor.getPlaceholderText()).toBe("Branch name");
    nameInputDialogView.refs.queryEditor.setText("new-branch");
    await nameInputDialogView.props.didConfirm();
    expect(operations.checkout).toHaveBeenCalledWith("new-branch", { createNew: true });

    await branchListView.showReferenceList("create-from", repoA.repository);
    const main = branchListView.referenceListView.props.items.find(
      (item) => item.reference === "main",
    );
    branchListView.confirmReference(main);
    nameInputDialogView.refs.queryEditor.setText("from-main");
    await nameInputDialogView.props.didConfirm();
    expect(operations.checkout).toHaveBeenCalledWith("from-main", {
      createNew: true,
      startPoint: "main",
    });

    await branchListView.showReferenceList("detach", repoA.repository);
    branchListView.confirmReference(
      branchListView.referenceListView.props.items.find((item) => item.reference === "main"),
    );
    expect(operations.checkout).toHaveBeenCalledWith("main", { detach: true });
  });

  it("builds a breadcrumb trail through the create-from flow and navigates back", async () => {
    jasmine.attachToDOM(atom.workspace.getElement());
    const branchListView = mainModule.getBranchListView();
    const operations = repoA.repository.getOperations();
    spyOn(operations, "checkout").andReturn(Promise.resolve());

    await branchListView.toggle();
    expect(branchListView.selectListView.isVisible()).toBe(true);
    expect(atom.workspace.getModalTrail()).toEqual([]);

    // Entering the reference list adopts the visible branch list as the root.
    await branchListView.showReferenceList("create-from", repoA.repository);
    expect(branchListView.selectListView.isVisible()).toBe(false);
    expect(branchListView.referenceListView.isVisible()).toBe(true);
    expect(atom.workspace.getModalTrail()).toEqual(["Branches", "Create from"]);

    const itemsBefore = branchListView.referenceListView.props.items;
    const main = itemsBefore.find((item) => item.reference === "main");
    branchListView.confirmReference(main);
    expect(branchListView.branchNameDialog.inputDialogView.isVisible()).toBe(true);
    expect(atom.workspace.getModalTrail()).toEqual(["Branches", "Create from", "main"]);

    // Going back re-shows the reference list with its items intact - no reload.
    expect(atom.workspace.popModal()).toBe(true);
    expect(branchListView.referenceListView.isVisible()).toBe(true);
    expect(branchListView.referenceListView.props.items).toBe(itemsBefore);
    expect(atom.workspace.getModalTrail()).toEqual(["Branches", "Create from"]);

    // Escape cancels the visible step, which ends the whole trail.
    atom.commands.dispatch(branchListView.referenceListView.element, "core:cancel");
    expect(branchListView.referenceListView.isVisible()).toBe(false);
    expect(branchListView.selectListView.isVisible()).toBe(false);
    expect(atom.workspace.getModalTrail()).toEqual([]);
  });
});
