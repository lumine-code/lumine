const DefaultHistoryProvider = require("./default-history-provider");
const plans = new WeakMap();

function createPlan(data) {
  const plan = Object.freeze({
    get count() {
      return plans.get(plan)?.count ?? 0;
    },
    get snapshot() {
      return plans.get(plan)?.snapshot ?? null;
    },
    validate() {
      const current = plans.get(plan);
      if (!current) throw new Error("Prepared replacement is closed");
      current.check();
      current.markerPlan?.verify();
      return true;
    },
    commit(options) {
      return commitPlans([plan], options);
    },
    dispose() {
      plans.delete(plan);
    },
  });
  plans.set(plan, data);
  return plan;
}

function publicationQueue(buffers) {
  const emitters = new Set(),
    queue = [],
    restorations = [];
  const add = (owner) => {
    if (owner?.emitter) emitters.add(owner.emitter);
  };
  for (const buffer of buffers) {
    add(buffer);
    for (const display of Object.values(buffer.displayLayers)) add(display);
    for (const layer of Object.values(buffer.markerLayers)) {
      add(layer);
      for (const marker of layer.markersById.values()) add(marker);
      for (const displayLayer of layer.displayMarkerLayers) {
        add(displayLayer);
        for (const marker of displayLayer.markersById.values()) add(marker);
      }
    }
  }
  try {
    for (const emitter of emitters)
      for (const name of ["emit", "clear", "dispose"]) {
        const original = emitter[name];
        if (typeof original !== "function") continue;
        const descriptor = Object.getOwnPropertyDescriptor(emitter, name);
        Object.defineProperty(emitter, name, {
          configurable: true,
          writable: true,
          value: function (...args) {
            queue.push(() => original.apply(emitter, args));
          },
        });
        restorations.push(() => {
          if (descriptor) Object.defineProperty(emitter, name, descriptor);
          else delete emitter[name];
        });
      }
  } catch (error) {
    for (const restore of restorations) restore();
    throw error;
  }
  return {
    flush(errors) {
      for (let index = 0; index < queue.length; index++) {
        try {
          queue[index]();
        } catch (error) {
          errors.push(error);
        }
      }
    },
    dispose() {
      for (const restore of restorations) restore();
      queue.length = 0;
      restorations.length = 0;
      emitters.clear();
    },
  };
}

function commitPlans(prepared, options = {}) {
  const entries = prepared.map((plan) => {
    const data = plans.get(plan);
    if (!data) throw new Error("Prepared replacement is closed");
    return { plan, ...data };
  });
  const buffers = entries.map((entry) => entry.buffer);
  if (new Set(buffers).size !== buffers.length)
    throw new Error("A replacement batch must contain each buffer once");
  const count = entries.reduce((total, entry) => total + entry.count, 0);
  const check = () => {
    if (options.signal?.aborted)
      throw Object.assign(new Error("Replacement was cancelled before publication"), {
        name: "AbortError",
      });
    if (options.isCurrent?.() === false)
      throw Object.assign(new Error("Replacement owner changed before publication"), {
        code: "ERR_STALE_EDIT",
      });
    for (const entry of entries) entry.plan.validate();
  };
  check();
  if (!count) {
    for (const plan of prepared) plan.dispose();
    return 0;
  }
  for (const buffer of buffers) {
    buffer.assertCanEdit();
    if (
      buffers.length > 1 &&
      Object.values(buffer.markerLayers).some(
        (layer) => layer.trackRanges && layer.getMarkerCount(),
      )
    )
      throw Object.assign(
        new Error("Atomic multi-buffer replacement cannot run custom intermediate range trackers"),
        { code: "ERR_REPLACE_RANGE_TRACKER" },
      );
  }
  const context = { token: Symbol("atomic text publication") };
  const errors = [];
  let publications,
    committed = false,
    failure;
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      errors.push(error);
    }
  };
  for (const buffer of buffers) {
    buffer.atomicEditContext = context;
  }
  const active = entries.filter((entry) => entry.changedCount ?? entry.count);
  const transact = (index, fn) => {
    if (index === buffers.length) return fn();
    // A failure while publishing a completed inner transaction must never make
    // an outer transaction roll back text already observed in another buffer.
    try {
      return buffers[index].transact(
        { atomicToken: context.token, groupingInterval: options.groupingInterval },
        () => transact(index + 1, fn),
      );
    } catch (error) {
      if (committed) errors.push(error);
      else throw error;
    }
  };
  try {
    transact(0, () => {
      try {
        for (const entry of active) entry.buffer.emitWillChangeEvent();
        check();
        for (const entry of active) {
          entry.edit = entry.buffer.buffer.prepareEdit(entry.range, entry.inserted);
          entry.change = entry.edit.getChange();
          entry.patch = entry.edit.createPatch();
          entry.patch.coordinateMap = entry.coordinateMap;
          entry.event = entry.buffer.changeEventForPreparedEdit(entry.change, "edit", {
            coordinateMap: entry.coordinateMap,
          });
          entry.buffer.prepareDisplayLayersForChange(entry.event, entry.edit.snapshot);
          entry.markerPlan?.preparePublication(entry.snapshot);
        }
        check();
        publications = publicationQueue(buffers);
        const historyBackups = active.map(({ buffer }) => {
          const history = buffer.historyProvider;
          const savedUndo = history.undoStack?.slice(),
            savedRedo = history.redoStack?.slice(),
            savedState =
              history instanceof DefaultHistoryProvider ? null : history.getSnapshot(Infinity);
          return history instanceof DefaultHistoryProvider
            ? () => {
                history.undoStack = savedUndo.slice();
                history.redoStack = savedRedo.slice();
              }
            : () => history.restoreFromSnapshot(savedState);
        });
        const published = [];
        try {
          for (const entry of active) entry.buffer.historyProvider.pushPatch(entry.patch);
          check();
          for (const entry of active) {
            entry.edit.commit();
            published.push(entry);
          }
        } catch (error) {
          // No public notification or marker has changed yet. Restore every root
          // published so far before the transaction can be observed.
          for (const entry of published.reverse()) {
            const restore = entry.buffer.buffer.prepareEdit(entry.buffer.getRange(), entry.before);
            try {
              restore.commit();
            } finally {
              restore.dispose();
            }
          }
          for (const restoreHistory of historyBackups) restoreHistory();
          throw error;
        }
        committed = true;
        for (const entry of active) {
          const replay = {
            getChange: () => entry.change,
            createPatch: () => entry.patch,
            commit() {},
            dispose() {},
          };
          attempt(() =>
            entry.buffer.applyChange(replay, {
              recordHistory: false,
              atomicToken: context.token,
              skipDisplayPreparation: true,
              deferDidChange: true,
              coordinateMap: entry.coordinateMap,
              syntaxChanges: entry.syntaxChanges,
              markerPlan: entry.markerPlan && {
                verify() {},
                publish: (snapshot) => entry.markerPlan.publish(snapshot),
              },
            }),
          );
        }
        attempt(() => options.didCommit?.());
        for (const entry of active) {
          if (!entry.event.oldRange.isEmpty() || !entry.event.newRange.isEmpty()) {
            attempt(() => entry.buffer.languageMode.bufferDidChange(entry.event));
            attempt(() => entry.buffer.updateDisplayLayersForChange(entry.event));
          }
        }
        for (const buffer of buffers)
          errors.push(...require("./text-buffer-marker-finalizers").run(buffer, true));
        context.selectionFinalizersHandled = true;
      } catch (error) {
        failure = error;
      }
    });
  } catch (error) {
    failure = error;
  } finally {
    if (committed) {
      for (const buffer of buffers) {
        if (buffer.changesSinceLastDidChangeTextEvent.length)
          attempt(() => buffer.emitDidChangeTextAndMarkerEvents(null));
        attempt(() => buffer.updateFileStateFromBuffer());
      }
      publications?.flush(errors);
    }
    publications?.dispose();
    for (let index = 0; index < buffers.length; index++) {
      buffers[index].atomicEditContext = null;
    }
    for (const entry of active) entry.edit?.dispose();
    for (const plan of prepared) plan.dispose();
  }
  if (failure && !committed) throw failure;
  if (failure) errors.push(failure);
  if (errors.length)
    throw Object.assign(
      new Error(`All ${count} replacements were committed, but an observer failed`, {
        cause: new AggregateError(errors),
      }),
      { code: "ERR_REPLACE_OBSERVER_FAILED", committed: true, replacementCount: count },
    );
  return count;
}
module.exports = { createPlan, commitPlans };
