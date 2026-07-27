const fs = require("fs");

module.exports = {
  // Crawls the project's files.
  //
  // `atom.project.crawl()` drives ripgrep in its own process, so there is no
  // Task fork on top of it: all that is left here is collecting the batches it
  // streams back. The editor owns the ripgrep invocation, which is why the
  // ignore-file and `.git` handling no longer appears in this package.
  startTask(callback, metricsReporter) {
    const results = [];
    const ignoredNames = [
      ...(atom.config.get("fuzzy-files.ignoredNames") || []),
      ...(atom.config.get("core.ignoredNames") || []),
    ];
    const directoryPaths = atom.project
      .getPaths()
      .map((projectPath) => fs.realpathSync(projectPath));

    const startTime = performance.now();
    let cancelled = false;

    const crawl = atom.project.crawl({
      directoryPaths,
      ignoredNames,
      // The finder lists results in path order.
      sort: true,
      didFindPaths: (paths) => results.push(...paths),
    });

    // A thenable carrying `terminate()`, the same shape `atom.project.crawl()`
    // and `workspace.scan()` use, so callers can await the crawl as well as
    // stop it.
    const finished = crawl.then(() => {
      if (cancelled) return;
      callback(results);

      const duration = Math.round(performance.now() - startTime);
      if (metricsReporter && metricsReporter.sendCrawlEvent) {
        metricsReporter.sendCrawlEvent(duration, results.length, "ripgrep");
      }
    });

    finished.terminate = () => {
      cancelled = true;
      crawl.cancel();
    };
    return finished;
  },
};
