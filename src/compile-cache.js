"use strict";

// Lumine's compile-cache when installing or updating packages, called by apm's Node-js

const path = require("path");
const fs = require("@lumine-code/fs-plus");
const sourceMapSupport = require("source-map-support");

const babelCompiler = require("./babel");
// A .jsx file is always compiled — no pragma sniffing — through the same Babel
// pipeline and on-disk cache as pragma-carrying .js files. Prototype delegation
// rather than a copy, so spies on the babel module stay visible.
const jsxCompiler = Object.assign(Object.create(babelCompiler), {
  shouldCompile: () => true,
});

const COMPILERS = {
  ".js": babelCompiler,
  ".jsx": jsxCompiler,
  ".ts": require("./typescript"),
  ".tsx": require("./typescript"),
};

const cacheStats = {};
let cacheDirectory = null;

exports.setLumineHomeDirectory = function (lumineHome) {
  let cacheDir = path.join(lumineHome, "compile-cache");
  if (
    process.env.USER === "root" &&
    process.env.SUDO_USER &&
    process.env.SUDO_USER !== process.env.USER
  ) {
    cacheDir = path.join(cacheDir, "root");
  }
  this.setCacheDirectory(cacheDir);
};

exports.setCacheDirectory = function (directory) {
  cacheDirectory = directory;
};

exports.getCacheDirectory = function () {
  return cacheDirectory;
};

exports.addPathToCache = function (filePath, lumineHome) {
  this.setLumineHomeDirectory(lumineHome);
  const extension = path.extname(filePath);

  const compiler = COMPILERS[extension];
  if (compiler) {
    return compileFileAtPath(compiler, filePath, extension);
  }
};

exports.getCacheStats = function () {
  return cacheStats;
};

exports.resetCacheStats = function () {
  Object.keys(COMPILERS).forEach(function (extension) {
    cacheStats[extension] = {
      hits: 0,
      misses: 0,
    };
  });
};

function compileFileAtPath(compiler, filePath, extension) {
  const sourceCode = fs.readFileSync(filePath, "utf8");
  if (compiler.shouldCompile(sourceCode, filePath)) {
    const cachePath = compiler.getCachePath(sourceCode, filePath);
    let compiledCode = readCachedJavaScript(cachePath);
    if (compiledCode != null) {
      cacheStats[extension].hits++;
    } else {
      cacheStats[extension].misses++;
      compiledCode = compiler.compile(sourceCode, filePath);
      writeCachedJavaScript(cachePath, compiledCode);
    }
    return compiledCode;
  }
  return sourceCode;
}

function readCachedJavaScript(relativeCachePath) {
  const cachePath = path.join(cacheDirectory, relativeCachePath);
  if (fs.isFileSync(cachePath)) {
    try {
      return fs.readFileSync(cachePath, "utf8");
    } catch {
      /* ignore */
    }
  }
  return null;
}

function writeCachedJavaScript(relativeCachePath, code) {
  const cachePath = path.join(cacheDirectory, relativeCachePath);
  fs.writeFileSync(cachePath, code, "utf8");
}

const INLINE_SOURCE_MAP_REGEXP = /\/\/[#@]\s*sourceMappingURL=([^'"\n]+)\s*$/gm;

exports.install = function (resourcesPath, nodeRequire) {
  sourceMapSupport.install({
    handleUncaughtExceptions: false,

    // Most of this logic is the same as the default implementation in the
    // source-map-support module, but we've overridden it to read the javascript
    // code from our cache directory.
    retrieveSourceMap: function (filePath) {
      if (!cacheDirectory || !fs.isFileSync(filePath)) {
        return null;
      }

      try {
        var sourceCode = fs.readFileSync(filePath, "utf8");
      } catch (error) {
        console.warn("Error reading source file", error.stack);
        return null;
      }

      let compiler = COMPILERS[path.extname(filePath)];
      if (!compiler) compiler = COMPILERS[".js"];

      try {
        var fileData = readCachedJavaScript(compiler.getCachePath(sourceCode, filePath));
      } catch (error) {
        console.warn("Error reading compiled file", error.stack);
        return null;
      }

      if (fileData == null) {
        return null;
      }

      let match, lastMatch;
      INLINE_SOURCE_MAP_REGEXP.lastIndex = 0;
      while ((match = INLINE_SOURCE_MAP_REGEXP.exec(fileData))) {
        lastMatch = match;
      }
      if (lastMatch == null) {
        return null;
      }

      const sourceMappingURL = lastMatch[1];
      const rawData = sourceMappingURL.slice(sourceMappingURL.indexOf(",") + 1);

      try {
        var sourceMap = JSON.parse(Buffer.from(rawData, "base64"));
      } catch (error) {
        console.warn("Error parsing source map", error.stack);
        return null;
      }

      return {
        map: sourceMap,
        url: null,
      };
    },
  });

  const prepareStackTraceWithSourceMapping = Error.prepareStackTrace;
  var prepareStackTrace = prepareStackTraceWithSourceMapping;

  function prepareStackTraceWithRawStackAssignment(error, frames) {
    if (error.rawStack) {
      // avoid infinite recursion
      return prepareStackTraceWithSourceMapping(error, frames);
    } else {
      error.rawStack = frames;
      return prepareStackTrace(error, frames);
    }
  }

  Error.stackTraceLimit = 30;

  Object.defineProperty(Error, "prepareStackTrace", {
    get: function () {
      return prepareStackTraceWithRawStackAssignment;
    },

    set: function (newValue) {
      prepareStackTrace = newValue;
      process.nextTick(function () {
        prepareStackTrace = prepareStackTraceWithSourceMapping;
      });
    },
  });

  Error.prototype.getRawStack = function () {
    // Access this.stack to ensure prepareStackTrace has been run on this error
    // because it assigns this.rawStack as a side-effect
    this.stack;
    return this.rawStack;
  };

  Object.keys(COMPILERS).forEach(function (extension) {
    const compiler = COMPILERS[extension];
    // Node's built-in loader for this extension, captured before we replace it.
    // For `.js` on Node 22.12+ this loader is ESM-aware: it routes
    // `type: module` files through `require(esm)` rather than compiling them as
    // CommonJS. We defer to it for any file we don't transpile ourselves, so
    // that ESM dependencies load correctly instead of failing to parse.
    const defaultLoader = nodeRequire.extensions[extension];

    Object.defineProperty(nodeRequire.extensions, extension, {
      enumerable: true,
      writable: false,
      value: function (module, filePath) {
        const sourceCode = fs.readFileSync(filePath, "utf8");
        if (!compiler.shouldCompile(sourceCode, filePath)) {
          if (defaultLoader) return defaultLoader(module, filePath);
          return module._compile(sourceCode, filePath);
        }
        const cachePath = compiler.getCachePath(sourceCode, filePath);
        let compiledCode = readCachedJavaScript(cachePath);
        if (compiledCode != null) {
          cacheStats[extension].hits++;
        } else {
          cacheStats[extension].misses++;
          compiledCode = compiler.compile(sourceCode, filePath);
          writeCachedJavaScript(cachePath, compiledCode);
        }
        return module._compile(compiledCode, filePath);
      },
    });
  });
};

exports.supportedExtensions = Object.keys(COMPILERS);
exports.resetCacheStats();
