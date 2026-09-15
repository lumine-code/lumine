const assert = require("assert").strict;
const ProjectStateCoordinator = require("../../src/project-state-coordinator");

describe("ProjectStateCoordinator", function () {
  let windows, coordinator;

  beforeEach(function () {
    windows = [];
    coordinator = new ProjectStateCoordinator(() => windows);
  });

  function makeWindow(projectRoots = []) {
    const window = { isSpec: false, projectRoots };
    windows.push(window);
    return window;
  }

  it("reserves adoption while a window is changing projects", function () {
    const first = makeWindow(["/a"]);
    const second = makeWindow(["/c"]);

    const reservation = coordinator.reserve(first, ["/b"]);

    assert.equal(reservation.allowed, true);
    assert.equal(typeof reservation.reservationId, "string");
    assert.deepEqual(coordinator.reserve(second, ["/b"]), {
      allowed: false,
      reservationId: null,
    });
  });

  it("does not adopt state from a project open in another window", function () {
    makeWindow(["/project"]);
    const duplicate = makeWindow([]);

    assert.deepEqual(coordinator.reserve(duplicate, ["/project"]), {
      allowed: false,
      reservationId: null,
    });
  });

  it("releases a reservation when project roots are committed", function () {
    const first = makeWindow(["/a"]);
    const second = makeWindow(["/c"]);
    coordinator.reserve(first, ["/b"]);

    first.projectRoots = ["/b"];
    coordinator.commit(first, ["/b"]);
    first.projectRoots = ["/a"];

    assert.equal(coordinator.reserve(second, ["/b"]).allowed, true);
  });

  it("releases every reservation owned by a closed window", function () {
    const first = makeWindow(["/a"]);
    const second = makeWindow(["/c"]);
    coordinator.reserve(first, ["/b"]);

    coordinator.releaseWindow(first);

    assert.equal(coordinator.reserve(second, ["/b"]).allowed, true);
  });

  it("keeps spec windows out of persistent-state coordination", function () {
    const specWindow = { isSpec: true, projectRoots: ["/project"] };
    windows.push(specWindow);

    assert.deepEqual(coordinator.reserve(specWindow, ["/project"]), {
      allowed: false,
      reservationId: null,
    });
  });
});
