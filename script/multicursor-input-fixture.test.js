const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  definitions,
  fixture,
  burstStates,
} = require("../benchmark/helpers/multicursor-input-fixture");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("the 32 original public sources, outputs and cursor anchors retain their golden fingerprint", () => {
  const original = definitions.filter((definition) => !definition.ownership);
  assert.equal(original.length, 32);
  const rows = original
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((definition) => {
      const input = fixture(definition);
      return [
        definition.id,
        sha256(input.source),
        sha256(input.expected),
        input.points,
        input.expectedPositions,
      ];
    });
  assert.equal(
    sha256(JSON.stringify(rows)),
    "fe85a6014f7cb96c067e4698f78a4fd289e9b56bb7c064315b8be783df7253f8",
  );
});

test("every public ownership fixture agrees with the independent Enter oracle before any burst typing", () => {
  assert.equal(definitions.length, 77);
  for (const definition of definitions) {
    const input = fixture(definition);
    const plan = burstStates(input);
    assert.equal(plan.states[0].operation, "enter");
    assert.equal(plan.states[0].text, input.expected, definition.id);
    assert.deepEqual(plan.states[0].positions, input.expectedPositions, definition.id);
    assert.equal(plan.states[0].hash, sha256(input.expected), definition.id);
    assert.notEqual(
      plan.final.text,
      input.expected,
      "The final x must distinguish the acknowledged burst frame from Enter",
    );
  }
});

test("slow ownership fixtures contain actual quoted/comment clauses and a portable root provider", () => {
  for (const [ownership, body] of [
    ["quoted", 'print("public value_000")'],
    ["comment", "work_000() # public inline comment 000"],
  ]) {
    const input = fixture(
      definitions.find((definition) => definition.id === `ipython-50-${ownership}-chain-2`),
    );
    assert.equal(input.source.split("\n")[input.metadata.targetFirstRow], `if flag_000: ${body}`);
    assert.equal(input.points[0][1], 13);
    assert.equal(input.points[1][1], 15);
    assert.equal(input.metadata.ownershipPath, "parsed-discovery");
    assert.equal(input.rootRanges, null);
  }
  const input = fixture(
    definitions.find((definition) => definition.id === "python-50-root-policy-chain-2"),
  );
  const provider = require(input.rootRanges.module)[input.rootRanges.method];
  assert.equal(typeof provider, "function");
  assert.deepEqual(
    provider({
      length: 20,
      positionAt: (index) => {
        assert.equal(index, 20);
        return { row: 2, column: 7 };
      },
    }),
    [[[0, 0], { row: 2, column: 7 }]],
  );
});

const initial = {
  text: "if ready: work()\nelif other: more()",
  positions: [
    [0, 10],
    [1, 12],
  ],
};
const literalStates = [
  [
    "enter",
    "if ready: \n    work()\nelif other: \n    more()",
    [
      [1, 4],
      [3, 4],
    ],
  ],
  [
    "text",
    "if ready: \n    xywork()\nelif other: \n    xymore()",
    [
      [1, 6],
      [3, 6],
    ],
  ],
  [
    "backspace",
    "if ready: \n    xwork()\nelif other: \n    xmore()",
    [
      [1, 5],
      [3, 5],
    ],
  ],
  [
    "enter",
    "if ready: \n    x\n    work()\nelif other: \n    x\n    more()",
    [
      [2, 4],
      [5, 4],
    ],
  ],
  [
    "text",
    "if ready: \n    x\n    xywork()\nelif other: \n    x\n    xymore()",
    [
      [2, 6],
      [5, 6],
    ],
  ],
  [
    "backspace",
    "if ready: \n    x\n    xwork()\nelif other: \n    x\n    xmore()",
    [
      [2, 5],
      [5, 5],
    ],
  ],
  [
    "enter",
    "if ready: \n    x\n    x\n    work()\nelif other: \n    x\n    x\n    more()",
    [
      [3, 4],
      [7, 4],
    ],
  ],
  [
    "text",
    "if ready: \n    x\n    x\n    xywork()\nelif other: \n    x\n    x\n    xymore()",
    [
      [3, 6],
      [7, 6],
    ],
  ],
  [
    "backspace",
    "if ready: \n    x\n    x\n    xwork()\nelif other: \n    x\n    x\n    xmore()",
    [
      [3, 5],
      [7, 5],
    ],
  ],
].map(([operation, text, positions]) => ({ operation, text, positions }));

for (const cycles of [2, 3])
  test(`a ${cycles}-cycle burst matches literal multicursor text, positions and every undo/redo state`, () => {
    const input = {
      source: initial.text,
      points: initial.positions,
      expectedPositions: [
        [1, 4],
        [3, 4],
      ],
    };
    const plan = burstStates(input, cycles);
    const expected = literalStates.slice(0, cycles * 3);
    const shape = ({ operation, text, positions }) => ({ operation, text, positions });
    assert.deepEqual(plan.states.map(shape), expected);
    assert.deepEqual(plan.redo.map(shape), expected);
    assert.deepEqual(
      plan.undo.map(({ text, positions }) => ({ text, positions })),
      [
        ...expected
          .slice(0, -1)
          .toReversed()
          .map(({ text, positions }) => ({ text, positions })),
        initial,
      ],
    );
    assert.equal(plan.publications, cycles * 3);
    assert.equal(plan.typingText, "xy");
    for (const state of plan.states) assert.equal(state.hash, sha256(state.text));
    assert.deepEqual(input.points, initial.positions);
  });

test("a top-level burst preserves zero indentation over repeated Enter operations", () => {
  const plan = burstStates(
    { source: "value = 1", points: [[0, 9]], expectedPositions: [[1, 0]] },
    3,
  );
  assert.equal(plan.final.text, "value = 1\nx\nx\nx");
  assert.deepEqual(plan.final.positions, [[3, 1]]);
  assert.deepEqual(
    plan.states.filter((state) => state.operation === "enter").map((state) => state.positions),
    [[[1, 0]], [[2, 0]], [[3, 0]]],
  );
});
