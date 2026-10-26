function aborted() {
  return Object.assign(new Error("Syntax stream was cancelled or superseded"), {
    name: "AbortError",
  });
}

// Adapt one acknowledged RPC to an async iterator. There is at most one
// delivered packet, and the worker is acknowledged only after its consumer
// asks for the next packet. Breaking iteration cancels the underlying request.
module.exports = async function* syntaxResultStream(produce, { signal, isCurrent } = {}) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let pending,
    held,
    wake,
    done = false,
    failure,
    result;
  const check = () => {
    combined.throwIfAborted();
    if (isCurrent && !isCurrent()) throw aborted();
  };
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const completion = Promise.resolve()
    .then(() => {
      check();
      return produce(async (value) => {
        check();
        if (pending || held) throw new Error("Syntax stream delivered an unacknowledged packet");
        await new Promise((resolve) => {
          pending = { value, resolve };
          notify();
        });
        check();
      }, combined);
    })
    .then(
      (value) => {
        result = value;
        done = true;
        notify();
      },
      (error) => {
        failure = error;
        done = true;
        notify();
      },
    );
  try {
    for (;;) {
      check();
      if (failure) throw failure;
      if (pending) {
        held = pending;
        pending = null;
        yield held.value;
        check();
        const delivered = held;
        held = null;
        delivered.resolve();
      } else if (done) return result;
      else
        await new Promise((resolve) => {
          wake = resolve;
        });
    }
  } finally {
    controller.abort(aborted());
    held?.resolve();
    pending?.resolve();
    await completion;
  }
};
