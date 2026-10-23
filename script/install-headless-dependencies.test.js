"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const p = require("./install-headless-dependencies");
const source =
  "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: resolute resolute-updates resolute-backports resolute-security\nComponents: main restricted universe multiverse\nArchitectures: amd64v3\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n";
const mirrors =
  "http://azure.archive.ubuntu.com/ubuntu\tpriority:1\nhttps://archive.ubuntu.com/ubuntu\tpriority:2\nhttps://security.ubuntu.com/ubuntu\tpriority:3\n";
const files = [
  { name: "ubuntu.sources", text: source },
  {
    name: "microsoft.sources",
    text: "Types: deb\nURIs: https://packages.microsoft.com/ubuntu/26.04/prod\nSuites: resolute\nComponents: main\nSigned-By: /usr/share/keyrings/microsoft.gpg\n",
  },
];
test("preserves every original font/display dependency and ordinary recommended-package policy", () => {
  assert.deepEqual(p.PACKAGES, [
    "xvfb",
    "libx11-dev",
    "libxkbfile-dev",
    "libsecret-1-dev",
    "fonts-noto-cjk",
  ]);
  assert(p.BUDGETS.update > 0 && p.BUDGETS.download > 0 && p.BUDGETS.install > 0);
});
test("preserves signed Ubuntu metadata fields while excluding unrelated third-party sources", () => {
  const actual = p.selectSources(files, "mirror+file:/tmp/owned/mirrors.txt");
  assert(actual.sources.includes("URIs: mirror+file:/tmp/owned/mirrors.txt"));
  for (const field of [
    "Types: deb",
    "Suites: resolute resolute-updates resolute-backports resolute-security",
    "Components: main restricted universe multiverse",
    "Architectures: amd64v3",
    "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
  ])
    assert(actual.sources.includes(field));
  assert(!actual.sources.includes("microsoft"));
});
test("fallback changes only official Ubuntu URIs, retaining every other stanza field", () => {
  const actual = p.selectSources(files, "unused", true);
  assert.equal(
    actual.sources,
    source.replace("mirror+file:/etc/apt/apt-mirrors.txt", "https://archive.ubuntu.com/ubuntu") +
      "\n",
  );
});
test("legacy signed-by options and security suite remain intact", () => {
  const text =
    "deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu.gpg] http://azure.archive.ubuntu.com/ubuntu resolute main universe\ndeb https://packages.example.test/foo stable main\n";
  assert.equal(
    p.selectSources([{ name: "ubuntu.list", text }], "unused", true).list,
    "deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu.gpg] https://archive.ubuntu.com/ubuntu resolute main universe\n",
  );
});
test("multiline URIs are rewritten without changing Signed-By", () => {
  const text = source.replace(
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    "URIs: http://azure.archive.ubuntu.com/ubuntu\n https://archive.ubuntu.com/ubuntu",
  );
  const actual = p.selectSources([{ name: "ubuntu.sources", text }], "unused", true);
  assert(
    actual.sources.includes(
      "URIs: https://archive.ubuntu.com/ubuntu https://archive.ubuntu.com/ubuntu\n",
    ),
  );
  assert(actual.sources.includes("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg"));
});
test("embedded Signed-By armor stays byte-identical", () => {
  const armor =
    "Signed-By:\n -----BEGIN PGP PUBLIC KEY BLOCK-----\n .\n abcdefgh\n -----END PGP PUBLIC KEY BLOCK-----";
  const text = source.replace("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg", armor);
  assert(
    p.selectSources([{ name: "ubuntu.sources", text }], "unused", true).sources.includes(armor),
  );
});
test("ports and security archives retain their official endpoints", () => {
  assert.equal(p.officialUri("http://ports.ubuntu.com/ubuntu-ports"), "ports");
  const text =
    "deb http://ports.ubuntu.com/ubuntu-ports resolute main\ndeb http://security.ubuntu.com/ubuntu resolute-security main";
  const actual = p.selectSources([{ name: "ubuntu.list", text }], "unused", true).list;
  assert(actual.includes("https://ports.ubuntu.com/ubuntu-ports"));
  assert(actual.includes("https://security.ubuntu.com/ubuntu"));
});
test("refuses mixed official/unrelated stanzas instead of weakening their trust configuration", () =>
  assert.throws(
    () =>
      p.selectSources(
        [
          {
            name: "mixed.sources",
            text: source.replace(
              "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
              "URIs: https://archive.ubuntu.com/ubuntu https://third.example.test/repo",
            ),
          },
        ],
        "unused",
      ),
    /Mixed/,
  ));
test("refuses explicitly unauthenticated source options", () => {
  for (const bad of [source + "Trusted: yes\n", source + "Allow-Insecure: yes\n"]) {
    assert.throws(
      () => p.selectSources([{ name: "ubuntu.sources", text: bad }], "unused"),
      /verification/,
    );
  }
  assert.throws(
    () =>
      p.selectSources(
        [
          {
            name: "ubuntu.list",
            text: "deb [trusted=yes] http://archive.ubuntu.com/ubuntu resolute main",
          },
        ],
        "unused",
      ),
    /verification/,
  );
});
test("requires an actual official Ubuntu source", () =>
  assert.throws(
    () =>
      p.selectSources(
        [
          {
            name: "third.list",
            text: "deb https://third.example.test/repo stable main",
          },
        ],
        "unused",
      ),
    /No official/,
  ));
test("runner mirror list preserves priorities and refuses unrelated or nested transports", () => {
  assert.equal(p.mirrorList(mirrors), mirrors);
  for (const bad of ["https://untrusted.example.test/ubuntu", "mirror+file:/tmp/nested.list", ""])
    assert.throws(() => p.mirrorList(bad));
});
test("private preparation changes no input source files or signing fields", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-apt-test-")),
    before = JSON.stringify(files);
  const layouts = p.prepareSources(files, mirrors, workspace);
  assert.equal(JSON.stringify(files), before);
  assert.equal(layouts.length, 2);
  assert(fs.readFileSync(path.join(workspace, "ubuntu-mirrors.txt"), "utf8") === mirrors);
  assert(
    fs
      .readFileSync(path.join(layouts[1].parts, "ubuntu.sources"), "utf8")
      .includes("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg"),
  );
});
const layouts = [
  {
    name: "configured",
    list: "/owned/current.list",
    parts: "/owned/current.parts",
    lists: "/owned/current.lists",
    cache: "/owned/current.bin",
    sourceCache: "/owned/current-source.bin",
  },
  {
    name: "official-fallback",
    list: "/owned/fallback.list",
    parts: "/owned/fallback.parts",
    lists: "/owned/fallback.lists",
    cache: "/owned/fallback.bin",
    sourceCache: "/owned/fallback-source.bin",
  },
];
function execute(codes) {
  const calls = [];
  let at = 0;
  const run = (args, budget) => {
    calls.push({ args, budget });
    return { code: codes[at++] ?? 0 };
  };
  return { calls, invoke: () => p.installHeadless(layouts, run, () => {}) };
}
test("ordinary path authenticates metadata, downloads fully, then installs without network", () => {
  const e = execute([0, 0, 0]);
  assert.equal(e.invoke().source, "configured");
  assert.equal(e.calls.length, 3);
  assert(e.calls[0].args.includes("update"));
  assert(e.calls[1].args.includes("--download-only"));
  assert(e.calls[2].args.includes("--no-download"));
  for (const call of e.calls) {
    assert(call.args.includes("APT::Get::AllowUnauthenticated=false"));
    assert(call.args.includes("Acquire::AllowInsecureRepositories=false"));
    assert(call.args.includes("Acquire::AllowDowngradeToInsecureRepositories=false"));
    assert(call.args.includes("Acquire::Retries=0"));
    assert(!call.args.includes("--ignore-missing"));
    assert(!call.args.includes("--no-install-recommends"));
  }
});
test("a bounded primary download failure switches sources before dpkg can run", () => {
  const e = execute([0, 124, 0, 0, 0]);
  assert.equal(e.invoke().source, "official-fallback");
  assert.equal(e.calls.length, 5);
  assert(e.calls[1].args.includes("--download-only"));
  assert(e.calls[2].args.includes("Dir::Etc::sourcelist=/owned/fallback.list"));
  assert(e.calls[4].args.includes("--no-download"));
  assert.deepEqual(
    e.calls.map((c) => c.budget),
    [90, 180, 90, 180, 180],
  );
});
test("a metadata signature/network failure cannot use stale unverified lists", () => {
  const e = execute([100, 0, 0, 0]);
  assert.equal(e.invoke().source, "official-fallback");
  assert.equal(e.calls.length, 4);
  assert(e.calls[1].args.includes("Dir::State::lists=/owned/fallback.lists"));
});
test("both failed mirrors fail setup and never install", () => {
  const e = execute([0, 124, 0, 100]);
  assert.throws(e.invoke, /APT download failed/);
  assert(!e.calls.some((c) => c.args.includes("--no-download")));
});
test("installation failure is fatal and does not retry interrupted dpkg", () => {
  const e = execute([0, 0, 124]);
  assert.throws(e.invoke, /no installation retry/);
  assert.equal(e.calls.length, 3);
});
test("every authenticated package name survives both download/install command plans", () => {
  const e = execute([0, 0, 0]);
  e.invoke();
  for (const c of e.calls.slice(1))
    assert.deepEqual(c.args.slice(-p.PACKAGES.length), [...p.PACKAGES]);
});
test("GNU timeout runs as root around apt with TERM and finite KILL grace", () => {
  const [command, args] = p.commandFor(["--download-only", "install", "-y", ...p.PACKAGES], 180);
  assert.equal(command, "sudo");
  assert.deepEqual(args.slice(0, 2), ["env", "DEBIAN_FRONTEND=noninteractive"]);
  assert.deepEqual(args.slice(2, 7), [
    "timeout",
    "--signal=TERM",
    "--kill-after=10s",
    "180s",
    "apt-get",
  ]);
  assert.throws(() => p.commandFor([], Infinity));
  assert.throws(() => p.commandFor([], 0));
});
test("maximum configured phase budget remains below outer15minute step", () =>
  assert(
    2 * (p.BUDGETS.update + p.BUDGETS.download) +
      p.BUDGETS.install +
      5 * (p.BUDGETS.killGrace + 5) <
      15 * 60,
  ));

test("comment lines before the first continued URI retain the configured mirror and signed fields", () => {
  const text = source.replace(
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    "URIs:\n# mirror selection\n mirror+file:/etc/apt/apt-mirrors.txt",
  );
  const actual = p.selectSources(
    [{ name: "ubuntu.sources", text }],
    "mirror+file:/tmp/owned/mirrors.txt",
  ).sources;
  assert(actual.includes("URIs: mirror+file:/tmp/owned/mirrors.txt\n"));
  assert(actual.includes("# mirror selection\n"));
  for (const line of source.split("\n"))
    if (line && !line.startsWith("URIs:")) assert(actual.includes(line));
});

test("fallback rewrites every URI across comments without leaving the stalled Azure mirror", () => {
  const text = source.replace(
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    "URIs: https://archive.ubuntu.com/ubuntu\n# secondary endpoint\n http://azure.archive.ubuntu.com/ubuntu",
  );
  const actual = p.selectSources([{ name: "ubuntu.sources", text }], "unused", true).sources;
  assert(!actual.includes("azure.archive.ubuntu.com"));
  assert(
    actual.includes("URIs: https://archive.ubuntu.com/ubuntu https://archive.ubuntu.com/ubuntu\n"),
  );
  assert(actual.includes("# secondary endpoint\n"));
  assert(actual.includes("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg"));
});

test("comment-separated third-party continuations remain fatal instead of entering a trusted fallback", () => {
  const text = source.replace(
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    "URIs: https://archive.ubuntu.com/ubuntu\n# not an official endpoint\n https://third.example.test/ubuntu",
  );
  assert.throws(
    () => p.selectSources([{ name: "ubuntu.sources", text }], "unused", true),
    /Mixed Ubuntu and third-party/,
  );
});

test("all APT true aliases and numeric-one forms are refused in Deb822 and legacy trust overrides", () => {
  const trueValues = [
    "yes",
    "true",
    "with",
    "on",
    "enable",
    "1",
    "01",
    "0x1",
    "+1",
    "+01",
    "+0x1",
    "ON",
  ];
  for (const field of ["Trusted", "Allow-Insecure", "Allow-Weak", "Allow-Downgrade-To-Insecure"])
    for (const value of trueValues) {
      assert.throws(
        () =>
          p.selectSources(
            [{ name: "ubuntu.sources", text: source + `${field}: ${value}\n` }],
            "unused",
          ),
        /verification/,
        `${field}: ${value}`,
      );
      assert.throws(
        () =>
          p.selectSources(
            [
              {
                name: "ubuntu.list",
                text: `deb [${field.toLowerCase()}=${value}] https://archive.ubuntu.com/ubuntu resolute main`,
              },
            ],
            "unused",
          ),
        /verification/,
        `${field.toLowerCase()}=${value}`,
      );
    }
});

test("multiline trust values separated by comments cannot bypass authentication guards", () => {
  assert.throws(
    () =>
      p.selectSources(
        [
          {
            name: "ubuntu.sources",
            text: source + "Trusted:\n# deliberate trust override\n on\n",
          },
        ],
        "unused",
      ),
    /verification/,
  );
});

test("recognized false trust overrides are retained while unknown values fail closed", () => {
  for (const value of [
    "no",
    "false",
    "without",
    "off",
    "disable",
    "0",
    "00",
    "0x0",
    "+0",
    "-0",
    '"no"',
  ]) {
    const text = source + `Trusted: ${value}\n`;
    assert(
      p
        .selectSources([{ name: "ubuntu.sources", text }], "unused")
        .sources.includes(`Trusted: ${value}`),
    );
    assert(
      p
        .selectSources(
          [
            {
              name: "ubuntu.list",
              text: `deb [trusted=${value}] https://archive.ubuntu.com/ubuntu resolute main`,
            },
          ],
          "unused",
        )
        .list.includes(`trusted=${value}`),
    );
  }
  for (const value of ["unknown", "2", "0x2", '"on"'])
    assert.throws(
      () =>
        p.selectSources(
          [{ name: "ubuntu.sources", text: source + `Trusted: ${value}\n` }],
          "unused",
        ),
      /unsupported trust value/,
    );
});
