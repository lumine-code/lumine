const Path = require("path");
const FS = require("fs/promises");
const { existsSync } = require("fs");
const yargs = require("yargs");
const { hideBin } = require("yargs/helpers");
const generateMetadata = require("./generate-metadata-for-builder");
const macBundleDocumentTypes = require("./mac-bundle-document-types.js");

// Monkey-patch to not remove things I explicitly didn't say to remove.
// See: https://github.com/electron-userland/electron-builder/issues/6957

/* eslint-disable n/no-extraneous-require */
let transformer = require("app-builder-lib/out/fileTransformer");
const builder_util_1 = require("builder-util");
/* eslint-enable n/no-extraneous-require */

transformer.createTransformer = function createTransformer(
  srcDir,
  configuration,
  extraMetadata,
  extraTransformer,
) {
  const mainPackageJson = Path.join(srcDir, "package.json");
  const isRemovePackageScripts = configuration.removePackageScripts !== false;
  const isRemovePackageKeywords = configuration.removePackageKeywords !== false;
  return (file) => {
    if (file === mainPackageJson) {
      return modifyMainPackageJson(
        file,
        extraMetadata,
        isRemovePackageScripts,
        isRemovePackageKeywords,
      );
    }
    if (extraTransformer != null) {
      return extraTransformer(file);
    } else {
      return null;
    }
  };
};

async function modifyMainPackageJson(
  file,
  extraMetadata,
  _isRemovePackageScripts,
  _isRemovePackageKeywords,
) {
  let mainPackageData = JSON.parse(await FS.readFile(file, "utf-8"));
  if (extraMetadata == null) return null;

  builder_util_1.deepAssign(mainPackageData, extraMetadata);
  return JSON.stringify(mainPackageData, null, 2);
}

// END Monkey-patch.

const builder = require("electron-builder");

const ARGS = yargs(hideBin(process.argv))
  .command("[platform]", "build for a given platform", (command) => {
    return command.positional("platform", {
      describe: 'One of "mac", "linux", or "win".',
    });
  })
  .option("target", {
    alias: "t",
    type: "string",
    description:
      "Limit to one target of the specified platform; otherwise all targets for that platform are built.",
  })
  .parse();

const displayName = "Lumine";
const baseName = "lumine";
const iconName = "lumine";

const ICONS = {
  png: `resources/app-icons/${iconName}.png`,
  ico: `resources/app-icons/${iconName}.ico`,
  svg: `resources/app-icons/${iconName}.svg`,
  icns: `resources/app-icons/${iconName}.icns`,
};

let options = {
  appId: `io.github.lumine-code.${baseName}`,
  npmRebuild: false,
  publish: null,
  files: [
    // --- Inclusions ---
    // Core Repo Inclusions
    "package.json",
    "dot-lumine/**/*",
    "exports/**/*",
    "resources/**/*",
    "src/**/*",
    "static/**/*",
    "vendor/**/*",
    "node_modules/**/*",

    // Core Repo Test Inclusions
    "spec/jasmine-test-runner.js",
    "spec/helpers/**/*",
    "spec/runners/**/*",

    // --- Exclusions ---
    // Core Repo Exclusions
    "!docs/",
    "!keymaps/",
    "!menus/",
    "!script/",
    "!hooks/",
    // Windows packaging inputs only: the tile manifest and its PNGs ship via
    // win.extraFiles (Windows must read them from disk next to Lumine.exe), the
    // .ico/.cmd/.js via win.extraResources, and the .nsh files are compiled into
    // the NSIS installer. Nothing reads resources/win/ at runtime, so keep it
    // out of app.asar on every platform. resources/app-icons/ must stay -- that
    // one IS read from inside the asar, by src/lumine-window.js.
    "!resources/win/",
    // The raw mark and the square badges are brand art, not app art: the raw
    // mark is the GitHub organisation's avatar and the square badges are
    // alternate-format tiles, and nothing in the editor ever loads either, so
    // they have no business riding along in every shipped build. They live
    // beside lumine.svg regardless, because that is where
    // script/generate-branding.js derives them from and where anyone looking
    // for the logo will look. lumine-safe.png/lumine-dev.png are NOT excluded
    // here -- those are real runtime app art, read by src/lumine-window.js.
    "!resources/app-icons/lumine-raw.*",
    "!resources/app-icons/lumine-square*.*",
    // resources/brand/ is README/marketing art (wallpaper, banner, install
    // loader) -- nothing in the editor loads any of it at runtime, so it has
    // no business riding along in every shipped build either.
    "!resources/brand/",

    // Git Related Exclusions
    "!**/{.git,.gitignore,.gitattributes,.git-keep,.github}",
    "!**/{.eslintignore,PULL_REQUEST_TEMPLATE.md,ISSUE_TEMPLATE.md,CONTRIBUTING.md,SECURITY.md}",

    // Development Tools Exclusions
    "!**/{npm-debug.log,package-lock.json,yarn.lock,.yarn-integrity,.yarn-metadata.json,.npmignore}",
    "!**/npm/{doc,html,man}",
    "!.editorconfig",
    "!**/{appveyor.yml,.travis.yml,circle.yml}",
    "!**/{__pycache__,thumbs.db,.flowconfig,.idea,.vs,.nyc_output}",
    "!**/*.{iml,o,hprof,orig,pyc,pyo,rbc,swp,csproj,sln,xproj}",
    "!**/{.jshintrc,.pairs,.lint,.lintignore,.eslintrc,.jshintignore}",
    "!**/{.coffeelintignore,.editorconfig,.nycrc,.coffeelint.json,.vscode,coffeelint.json}",

    // Common File Exclusions
    "!**/{.DS_Store,.hg,.svn,CVS,RCS,SCCS}",

    // Build Chain Exclusions
    "!**/*.{cc,h}", // Ignore *.cc and *.h files from native modules
    "!**/*.js.map",
    "!**/{Makefile}",
    "!**/build/{binding.Makefile,config.gypi,gyp-mac-tool,Makefile}",
    "!**/build/Release/{obj.target,obj,.deps}",

    // Test Exclusions
    "!**/node_modules/*/{test,__tests__,tests,powered-test,example,examples}",
    "!**/node_modules/babel-core/lib/transformation/transforers/spec", // Ignore babel-core spec
    // Every bundled package ships its spec directory in its git tarball;
    // none of them is needed at runtime. The editor's own top-level spec
    // inclusions (the runner and its helpers) are unaffected.
    "!**/node_modules/*/spec",
    "!**/node_modules/@*/*/spec",

    // Other Exclusions
    "!**/._*",
    "!**/node_modules/*.d.ts",
    "!**/node_modules/.bin",
    "!**/node_modules/native-mate",
    // node_modules of the fuzzy-native package are only required for building it
    "!node_modules/@lumine-code/fuzzy-native/node_modules",
    "!**/node_modules/spellchecker/vendor/hunspell/.*",
    "!**/get-parameter-names/node_modules/testla",
    "!**/get-parameter-names/node_modules/.bin/testla",
    "!**/jasmine-reporters/ext",
    "!**/deps/libgit2",
    // Exclusions borrowed from `node-prune`
    // - Files
    "!**/{Jenkinsfile}",
    "!**/{Gulpfile.js}",
    "!**/{Gruntfile.js}",
    "!**/{gulpfile.js}",
    "!**/{.tern-project}",
    "!**/{.eslintrc.js}",
    "!**/{.eslintrc.json}",
    "!**/{.eslintrc.yml}",
    "!**/{eslint.config.js,eslint.config.mjs,eslint.config.cjs}",
    "!**/{.stylelintrc}",
    "!**/{stylelint.config.js}",
    "!**/{stylelintrc.json}",
    "!**/{stylelintrc.yaml}",
    "!**/{stylelintrc.yml}",
    "!**/{stylelintrc.js}",
    "!**/{.htmllintrc}",
    "!**/{htmllint.js}",
    "!**/{.npmrc}",
    "!**/{.documentup.json}",
    "!**/{.gitlab-ci.yml}",
    "!**/{.coveralls.yml}",
    "!**/{CHANGES}",
    "!**/{changelog}",
    "!**/{.yarnclean}",
    "!**/{_config.yml}",
    "!**/{.babelrc}",
    "!**/{.yo-rc.json}",
    "!**/{jest.config.js}",
    "!**/{karma.conf.js}",
    "!**/{wallaby.js}",
    "!**/{wallaby.conf.js}",
    "!**/{.prettierrc}",
    "!**/{.prettierrc.yml}",
    "!**/{.prettierrc.toml}",
    "!**/{.prettierrc.js}",
    "!**/{.prettierrc.json}",
    "!**/{.prettier.config.js}",
    "!**/{.appveyor.yml}",
    "!**/{tsconfig.json}",
    "!**/{tslint.json}",
    // - Directories
    "!**/docs",
    "!**/doc",
    "!**/website",
    "!**/images",
    "!**/example",
    "!**/examples",
    "!**/coverage",
    "!**/.circleci",
    "!**/.github",
    // - Extensions
    "!**/*.{markdown,md,mkd,ts,jst,tgz,swp}",
  ],

  extraResources: [
    { from: "lumine.sh", to: `${baseName}.sh` },
    { from: ICONS.png, to: "lumine.png" },
    { from: "LICENSE", to: "LICENSE" },
  ],
  compression: "normal",
  deb: {
    afterInstall: "script/post-install.sh",
    afterRemove: "script/post-uninstall.sh",
    packageName: baseName,
  },
  rpm: {
    afterInstall: "script/post-install.sh",
    afterRemove: "script/post-uninstall-rpm.sh",
    compression: "xz",
    fpm: ["--rpm-digest", "sha256", "--rpm-rpmbuild-define=_build_id_links none"],
  },

  linux: {
    executableName: baseName,
    // deb/rpm need a maintainer email, which the manifest's plain
    // `author: "lumine-code"` does not carry.
    maintainer: "lumine-code <lumine-code@users.noreply.github.com>",
    // Giving a single PNG icon to electron-builder prevents the correct
    // construction of the icon path, so we have to specify a folder containing
    // multiple icons named each with its size.
    icon: "resources/icons",
    category: "Development",
    synopsis: "A community-led hyper-hackable text editor",
    target: [{ target: "appimage" }, { target: "deb" }, { target: "rpm" }, { target: "tar.gz" }],
    extraResources: [
      {
        // Extra SVG icon included in the resources folder to give a chance to
        // Linux packagers to add a scalable desktop icon under
        // `/usr/share/icons/hicolor/scalable`
        // (used only by desktops to show it on bar/switcher and app menus).
        from: ICONS.svg,
        to: `${baseName}.svg`,
      },
    ],
  },

  mac: {
    icon: ICONS.icns,
    category: "public.app-category.developer-tools",
    // Electron 44 follows Chromium in requiring macOS 13 or later.
    minimumSystemVersion: "13.0",
    hardenedRuntime: true,
    // Now that we're on a recent Electron, we no longer have to hide the
    // `allow-jit` entitlement from Intel Macs in order to work around a
    // `libuv` bug.
    entitlements: "resources/mac/entitlements.plist",
    entitlementsInherit: "resources/mac/entitlements.plist",
    extendInfo: {
      // Extra values that will be inserted into the app's plist.
      CFBundleExecutable: displayName,
      NSAppleScriptEnabled: "YES",
      NSMainNibFile: "MainMenu",
      NSRequiresAquaSystemAppearance: "NO",
      CFBundleDocumentTypes: macBundleDocumentTypes.create(),
      CFBundleURLTypes: [
        {
          CFBundleURLSchemes: ["lumine"],
          CFBundleURLName: "Lumine Shared Session Protocol",
        },
      ],
    },
    extraResources: [],
  },

  dmg: {
    sign: false,
    writeUpdateInfo: false,
  },

  // Earliest supported version of Windows is Windows 10. Electron 23 dropped
  // support for 7/8/8.1.
  win: {
    icon: ICONS.ico,
    extraResources: [
      // Unpacked so the Windows shell integration (src/win-shell.js) can point
      // a registry DefaultIcon at a real path; files inside app.asar can't.
      { from: "resources/win/file.ico", to: "file.ico" },
      { from: "resources/win/lumine.cmd", to: `${baseName}.cmd` },
      { from: "resources/win/lumine.js", to: `${baseName}.js` },
      { from: "resources/win/NSIS_Licenses.txt", to: "NSIS_Licenses.txt" },
    ],
    // Unlike extraResources (which targets <root>/resources), extraFiles
    // targets the app root. The Start-menu tile manifest has to sit next to
    // Lumine.exe and be named after it -- Windows never looks inside app.asar,
    // and a manifest whose stem does not match the executable is ignored in
    // silence. Deriving the name from `displayName` keeps the two in step.
    extraFiles: [
      {
        from: "resources/win/lumine.visualElementsManifest.xml",
        to: `${displayName}.VisualElementsManifest.xml`,
      },
      // Literal base names only. Scale-qualified variants (Logo.scale-200.png)
      // resolve solely through MRM, which needs a Resources.pri built by the
      // Windows SDK's makepri.exe -- an SDK dependency this 3-OS matrix should
      // not grow. These are rendered at the 200% plateau so Windows, which
      // scales tile art to fit, only ever scales them down.
      {
        from: "resources/win/visualElements/Square150x150Logo.png",
        to: "visualElements/Square150x150Logo.png",
      },
      {
        from: "resources/win/visualElements/Square70x70Logo.png",
        to: "visualElements/Square70x70Logo.png",
      },
    ],
    target: [{ target: "nsis" }, { target: "zip" }],
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    uninstallDisplayName: displayName,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // Branding for the assisted installer's pages. Both keys are required:
    // directories.buildResources defaults to build/, which this repo has no
    // such directory for, so without them NSIS falls back to its own stock
    // nsis3-metro sidebar and draws no header at all. Regenerate the bitmaps
    // with `npm run generate:win-branding`. uninstallerSidebar is deliberately
    // unset -- electron-builder reuses installerSidebar for the uninstaller's
    // MUI_UNWELCOMEFINISHPAGE_BITMAP.
    installerSidebar: "resources/win/installerSidebar.bmp",
    installerHeader: "resources/win/installerHeader.bmp",
    // GUID is omitted so electron-builder derives it from the appId.
    include: "resources/win/installer.nsh",
    warningsAsErrors: false,
    differentialPackage: false,
  },

  extraMetadata: {},

  afterSign: "script/mac-notarise.js",
  asarUnpack: [
    "node_modules/github/bin/*",
    "node_modules/github/lib/*", // Resolves error in console
    "**/node_modules/spellchecker/**", // Matching upstream glob
    "**/node_modules/@vscode/ripgrep*/**", // rg binary must be spawnable outside asar
    "node_modules/symbol-ctags/vendor/**", // ctags binaries must be spawnable outside asar
  ],
};

function whatToBuild() {
  if (!ARGS.target) return options;
  if (!(ARGS.platform in options)) return options;
  options[ARGS.platform] = options[ARGS.platform].filter((e) => e.target === ARGS.target);
  return options;
}

async function main() {
  let pack = await FS.readFile("package.json", "utf-8");
  let options = whatToBuild();
  let parsedPackageJson = JSON.parse(pack);
  options.extraMetadata = generateMetadata(parsedPackageJson);

  try {
    let result = await builder.build({ config: options });
    if (!existsSync("binaries")) {
      await FS.mkdir("binaries");
    }
    let promises = result.map((r) => {
      let destination = Path.join("binaries", Path.basename(r));
      return FS.copyFile(r, destination);
    });
    await Promise.all(promises);
  } catch (error) {
    console.error(`Error building Lumine:`);
    console.error(error);

    process.exit(1);
  }
}

main();
