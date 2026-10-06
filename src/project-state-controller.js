const fs = require("@lumine-code/fs-plus");
const { getProjectStateKey } = require("./project-state-keys");

// Docks belong to the window. A project transition replaces only its center.
const PROJECT_STATE_LOCATIONS = ["center"];

// Owns ordering and recovery for in-place project transitions. Persistence and
// deserialization remain environment operations supplied by the composition root.
module.exports = class ProjectStateController {
  constructor({
    project,
    workspace,
    config,
    packages,
    saveState,
    serialize,
    loadProjectState,
    restoreState,
    releaseReservation,
    isAvailable = () => true,
  }) {
    this.project = project;
    this.workspace = workspace;
    this.config = config;
    this.packages = packages;
    this.saveState = saveState;
    this.serialize = serialize;
    this.loadProjectState = loadProjectState;
    this.restoreState = restoreState;
    this.releaseReservation = releaseReservation;
    this.isAvailable = isAvailable;
    this.pendingChange = Promise.resolve();
    this.generation = 0;
    this.destroyed = false;
  }

  setState(projectPaths) {
    if (this.destroyed || !this.isAvailable()) {
      return Promise.reject(this.cancellationError());
    }
    // Copy before queuing: commands can arrive while a dialog or read is pending.
    const requestedPaths = Array.isArray(projectPaths) ? projectPaths.slice() : projectPaths;
    const generation = this.generation;
    const changing = this.pendingChange.then(async () => {
      try {
        return await this.performChange(requestedPaths, generation);
      } catch (error) {
        if (
          this.isCurrent(generation) ||
          error?.code === "ABORT_ERR" ||
          error?.errors?.[0]?.code === "ABORT_ERR"
        ) {
          throw error;
        }
        // A rejected asynchronous step can outlive its generation too. Preserve
        // its diagnostic as the cause while reporting the cancelled request.
        throw this.cancellationError(error);
      }
    });
    // A rejected request must not prevent the next one from saving the project
    // left open by its predecessor. The caller still receives that rejection.
    this.pendingChange = changing.catch(() => {});
    return changing;
  }

  reset() {
    this.generation++;
    // Keep the queue: old asynchronous work must finish before a new generation
    // can start its own transition against the same model objects.
  }

  destroy() {
    this.destroyed = true;
    this.reset();
  }

  isCurrent(generation) {
    return !this.destroyed && this.generation === generation && this.isAvailable();
  }

  assertCurrent(generation, cause) {
    if (!this.isCurrent(generation)) {
      throw this.cancellationError(cause);
    }
  }

  cancellationError(cause) {
    return Object.assign(new Error("Project state change was cancelled", { cause }), {
      code: "ABORT_ERR",
    });
  }

  resolveFolders(projectPaths) {
    if (!Array.isArray(projectPaths)) throw new TypeError("Project paths must be an array");
    return [
      ...new Set(
        projectPaths.map((projectPath) => {
          if (typeof projectPath !== "string" || projectPath.length === 0) {
            throw new TypeError("Each project path must be a non-empty string");
          }
          const provided = this.project.getProvidedDirectoryForProjectPath(projectPath);
          const normalized = provided
            ? provided.getPath()
            : this.project.defaultDirectoryProvider.normalizePath(projectPath);
          // The ordinary resolver accepts a file or missing child by returning
          // its parent. Switching projects must never open that parent.
          if (provided ? !provided.existsSync() : !fs.isDirectorySync(normalized)) {
            const error = new Error(`Project directory ${projectPath} does not exist`);
            error.missingProjectPaths = [projectPath];
            throw error;
          }
          return this.project.getDirectoryForProjectPath(normalized).getPath();
        }),
      ),
    ];
  }

  async performChange(projectPaths, generation) {
    const assertCurrent = (cause) => this.assertCurrent(generation, cause);
    this.assertCurrent(generation);
    const folders = this.resolveFolders(projectPaths);
    if (folders.length === 0) return false;

    const currentPaths = this.project.getPaths();
    if (getProjectStateKey(folders) === getProjectStateKey(currentPaths)) return false;

    // Flush before teardown. The unloading snapshot retains marker layers and
    // undo history, so returning restores the session as it was left.
    await this.saveState({ isUnloading: true });
    this.assertCurrent(generation);

    const closing = await this.workspace.confirmClose({
      windowCloseRequested: true,
      projectHasPaths: currentPaths.length > 0,
      locations: PROJECT_STATE_LOCATIONS,
    });
    this.assertCurrent(generation);
    if (!closing) return false;

    // Save/Save As can change both contents and paths. Preserve that result
    // rather than the snapshot taken before confirmation.
    this.resolveFolders(folders);
    await this.saveState({ isUnloading: true });
    this.assertCurrent(generation);
    const outgoingState = this.serialize({ isUnloading: true });
    const outgoingProjectFile = this.config.projectFile;
    const outgoingProjectSettings = {
      "*": this.config.projectSettings,
      ...(outgoingProjectFile
        ? this.config.scopedSettingsStore.propertiesForSource(outgoingProjectFile)
        : {}),
    };

    const loaded = await this.loadProjectState(folders);
    const failures = [];
    try {
      this.assertCurrent(generation);
      // State reads yield to filesystem work. Refuse a disappeared root while
      // the outgoing editors are still available.
      this.resolveFolders(folders);

      const restoreOptions = {
        locations: PROJECT_STATE_LOCATIONS,
        preservePackageState: true,
        preserveRetainedBuffers: true,
        throwProjectErrors: true,
      };
      try {
        await this.workspace.clear({ locations: PROJECT_STATE_LOCATIONS }, assertCurrent);
        this.assertCurrent(generation);
        this.project.destroyUnretainedBuffers();
        this.assertCurrent(generation);
        this.config.clearProjectSettings();
        this.assertCurrent(generation);

        if (loaded.state) {
          await this.restoreState(loaded.state, restoreOptions, assertCurrent);
          this.assertCurrent(generation);
          this.project.destroyUnretainedBuffers();
        } else {
          await this.packages.restoreActivePackageStates({});
          this.assertCurrent(generation);
          this.project.setPaths(folders, { mustExist: true, exact: true });
          this.assertCurrent(generation);
          if (this.config.get("core.openEmptyEditorOnStart")) {
            await this.workspace.open(null, { pending: true });
            this.assertCurrent(generation);
          }
        }
      } catch (error) {
        failures.push(error);
        if (this.isCurrent(generation)) {
          await this.rollback(
            outgoingState,
            outgoingProjectSettings,
            outgoingProjectFile,
            restoreOptions,
            generation,
            failures,
          );
        }
      } finally {
        // Aliases belong to this restoration, not a new generation established
        // by reset or teardown while an asynchronous operation was pending.
        if (this.isCurrent(generation)) {
          try {
            this.project.restoredBufferAliases.clear();
          } catch (error) {
            failures.push(error);
          }
        }
      }
    } catch (error) {
      failures.push(error);
    } finally {
      // A late read can acquire a reservation after reset or teardown. Release
      // it even when the transition can no longer commit.
      try {
        await this.releaseReservation(loaded.reservationId, folders);
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length === 0) this.assertCurrent(generation);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Project state change failed to complete cleanly", {
        cause: failures[0],
      });
    }
    return true;
  }

  async rollback(state, settings, projectFile, options, generation, failures) {
    const assertCurrent = (cause) => this.assertCurrent(generation, cause);
    try {
      await this.workspace.clear({ locations: PROJECT_STATE_LOCATIONS }, assertCurrent);
      this.assertCurrent(generation);
      this.project.destroyUnretainedBuffers();
      this.assertCurrent(generation);
      await this.restoreState(state, options, assertCurrent);
      this.assertCurrent(generation);
    } catch (error) {
      failures.push(error);
    } finally {
      // Even an incomplete document rollback must restore the outgoing config.
      if (this.isCurrent(generation)) {
        try {
          this.config.resetProjectSettings(settings, projectFile);
        } catch (error) {
          failures.push(error);
        }
      }
    }
  }
};
