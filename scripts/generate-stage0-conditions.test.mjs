import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { auditText } from "./audit-prose-style.mjs";
import {
  Stage0Error,
  countChapterEquations,
  evaluateMechanism,
  extractChapterClaims,
  extractClaims,
  extractHeldCandidates,
  extractInventory,
  extractMatrix,
  indexChapterClaims,
  indexTestCoverage,
  parseBibliographyKeys,
  renderReport,
} from "./lib/stage0-conditions.mjs";

const execFileAsync = promisify(execFile);
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const parseMd = (markdown) => parser.parse(markdown);

const FIXED_FIXTURE_FILES = Object.freeze([
  "research/adoption-matrix.md",
  "research/domain-inventory.md",
  "research/claims.md",
  "research/principle-registry.md",
  "research/references.bib",
  "experiments/test-coverage.json",
  "research/stage0-conditions.md",
]);

function makeCoverage(artifacts = [], claims = []) {
  return {
    schema: 2,
    criteria: {
      protocolComplete: [
        { id: "question", label: "question or hypothesis" },
        { id: "system", label: "system, scenario, or task family" },
        { id: "comparators", label: "arms, baselines, or strongest nulls" },
        { id: "budget", label: "matched budget and cost boundary" },
        { id: "measurements", label: "measurements and units" },
        { id: "ablations", label: "ablations" },
        { id: "analysis", label: "analysis or statistical plan" },
        { id: "failure", label: "rejection, kill, or retirement rule" },
      ],
    },
    artifacts,
    claims,
  };
}

function matrixDoc(rowsMarkdown) {
  const header =
    "Candidate | Biological or scientific principle | Current disposition | What already exists | Missing test for this project | Claim";
  return [
    "# Matrix",
    "",
    "## Working matrix",
    "",
    `| ${header} |`,
    "| --- | --- | --- | --- | --- | --- |",
    ...rowsMarkdown,
    "",
  ].join("\n");
}

function makeClaimSet(count) {
  const ids = new Set();
  for (let index = 1; index <= count; index += 1) {
    ids.add(`C-${String(index).padStart(3, "0")}`);
  }
  return ids;
}

async function createTempRepoRoot() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage0-conditions-test-"));
  for (const relPath of FIXED_FIXTURE_FILES) {
    const dest = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(relPath, dest);
  }
  await fs.cp("concept", path.join(tmpDir, "concept"), { recursive: true });
  return tmpDir;
}

function runCli(args) {
  return execFileAsync(process.execPath, [
    "scripts/generate-stage0-conditions.mjs",
    ...args,
  ], { timeout: 120_000 });
}

function assertCliFails(args, pattern) {
  return assert.rejects(runCli(args), (err) => {
    assert.equal(err.code, 1);
    if (pattern) assert.match(err.stderr, pattern);
    return true;
  });
}

test("unit: claim range C-010–C-012 expands inclusively to 3 claims", () => {
  const md = matrixDoc([
    "| Mech A | Principle | **Experiment** | Existing baselines | Test | [C-010](claims.md#c-010)–[C-012](claims.md#c-012) |",
  ]);
  const rows = extractMatrix(parseMd(md), makeClaimSet(20));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].claims, ["C-010", "C-011", "C-012"]);
});

test("unit: claim range width 200 succeeds and width 201 throws Stage0Error", () => {
  const known = makeClaimSet(250);
  const okMd = matrixDoc([
    "| Mech 200 | Principle | **Explore** | Baselines | Test | [C-001](claims.md#c-001)–[C-200](claims.md#c-200) |",
  ]);
  assert.equal(extractMatrix(parseMd(okMd), known)[0].claims.length, 200);

  const wideMd = matrixDoc([
    "| Mech 201 | Principle | **Explore** | Baselines | Test | [C-001](claims.md#c-001)–[C-201](claims.md#c-201) |",
  ]);
  assert.throws(() => extractMatrix(parseMd(wideMd), known), (err) => {
    assert.ok(err instanceof Stage0Error);
    assert.match(err.message, /exceeds 200/u);
    return true;
  });
});

test("unit: reversed claim range and zero matrix rows throw Stage0Error", () => {
  const revMd = matrixDoc([
    "| Mech Rev | Principle | **Explore** | Baselines | Test | [C-012](claims.md#c-012)-[C-010](claims.md#c-010) |",
  ]);
  assert.throws(() => extractMatrix(parseMd(revMd), makeClaimSet(20)), Stage0Error);
  assert.throws(() => extractMatrix(parseMd(matrixDoc([])), makeClaimSet(5)), Stage0Error);
});

test("unit: inventory skips H3 wider-horizon rows and rejects unknown state", () => {
  const validMd = [
    "| Domain | Problem patterns to collect | Current bundles | State | Next pass |",
    "| --- | --- | --- | --- | --- |",
    "| Sparse coding | limits | P-001, P-007 | partial; [audit](a.md) | next |",
    "",
    "| Domain family | Example fields and systems | Problem patterns to search | State |",
    "| --- | --- | --- | --- |",
    "| Soft matter | colloids | jamming | partial |",
    "| Metrology | calibration | drift | partial |",
  ].join("\n");
  const inv = extractInventory(parseMd(validMd));
  assert.equal(inv.rows.length, 1);
  assert.equal(inv.skippedRows, 2);
  assert.deepEqual(inv.rows[0].bundles, ["P-001", "P-007"]);

  const badMd = validMd.replace("partial; [audit](a.md)", "unverified");
  assert.throws(() => extractInventory(parseMd(badMd)), Stage0Error);
});

test("unit: condition 2 marks placeholder '—' as gap and truncates >100 chars on holds", () => {
  const claims = new Map([
    ["C-001", { id: "C-001", primaryKeys: ["k1"], primarySources: [], chapters: [] }],
  ]);
  const ctx = { claims, testCoverage: makeCoverage(), chapterEquations: new Map() };
  const row = {
    mechanism: "Mech",
    disposition: "Explore",
    analogues: "—",
    claims: ["C-001"],
    experiments: [],
    sources: [],
  };
  assert.equal(evaluateMechanism(row, ctx).conditions[1].state, "gap");

  const holdEval = evaluateMechanism({ ...row, analogues: "a".repeat(105) }, ctx);
  assert.equal(holdEval.conditions[1].state, "holds");
  assert.equal(holdEval.conditions[1].evidence, `${"a".repeat(100)}…`);
});

test("unit: condition 5 holds on zero math and opens on inlineMath", () => {
  const zeroCounts = countChapterEquations(parseMd("# Chapter\n\nPlain prose.\n"));
  const inlineCounts = countChapterEquations(parseMd("# Chapter\n\nInline $x + 1$ equation.\n"));
  const claims = new Map([
    ["C-001", { id: "C-001", primaryKeys: ["k1"], primarySources: [], chapters: ["concept/10-ch.md"] }],
  ]);
  const row = {
    mechanism: "Mech",
    disposition: "Explore",
    analogues: "MoE",
    claims: ["C-001"],
    experiments: [],
    sources: [],
  };
  const holdsRes = evaluateMechanism(row, {
    claims,
    testCoverage: makeCoverage(),
    chapterEquations: new Map([["concept/10-ch.md", zeroCounts]]),
  });
  assert.equal(holdsRes.conditions[4].state, "holds");

  const openRes = evaluateMechanism(row, {
    claims,
    testCoverage: makeCoverage(),
    chapterEquations: new Map([["concept/10-ch.md", inlineCounts]]),
  });
  assert.equal(openRes.conditions[4].state, "open");
  assert.match(openRes.conditions[4].evidence, /0 display and 1 inline equations/u);
});

test("unit: chapter claim links expand ranges and fail closed on unknown claims", () => {
  const known = makeClaimSet(20);
  const chapter = parseMd([
    "# Chapter",
    "",
    "See [C-010](../research/claims.md#c-010)–[C-012](../research/claims.md#c-012),",
    "the [ledger](../research/claims.md) and [C-004](claims.md#c-004).",
    "",
  ].join("\n"));
  assert.deepEqual(extractChapterClaims(chapter, known, "concept/10-ch.md"), [
    "C-010",
    "C-011",
    "C-012",
  ]);
  const unknown = parseMd("[C-021](../research/claims.md#c-021)\n");
  assert.throws(
    () => extractChapterClaims(unknown, known, "concept/10-ch.md"),
    (error) => error instanceof Stage0Error && /unknown claim C-021/u.test(error.message),
  );
  const malformed = parseMd("[C-001](../research/claims.md#c-x)\n");
  assert.throws(
    () => extractChapterClaims(malformed, known, "concept/10-ch.md"),
    (error) => error instanceof Stage0Error && /malformed claim link/u.test(error.message),
  );
});

test("unit: condition 4 opens on a chapter that links a row claim and gaps without one", () => {
  const claims = new Map([
    ["C-001", { id: "C-001", primaryKeys: ["k1"], primarySources: [], chapters: [] }],
  ]);
  const row = {
    mechanism: "Mech",
    disposition: "Explore",
    analogues: "MoE",
    claims: ["C-001"],
    experiments: [],
    sources: [],
  };
  const zeroCounts = countChapterEquations(parseMd("# Chapter\n\nPlain prose.\n"));
  const gapRes = evaluateMechanism(row, {
    claims,
    testCoverage: makeCoverage(),
    chapterEquations: new Map([["concept/10-ch.md", zeroCounts]]),
    chaptersByClaim: indexChapterClaims([["concept/10-ch.md", []]]),
  });
  assert.equal(gapRes.conditions[3].state, "gap");
  const openRes = evaluateMechanism(row, {
    claims,
    testCoverage: makeCoverage(),
    chapterEquations: new Map([["concept/10-ch.md", zeroCounts]]),
    chaptersByClaim: indexChapterClaims([["concept/10-ch.md", ["C-001"]]]),
  });
  assert.equal(openRes.conditions[3].state, "open");
  assert.match(openRes.conditions[3].evidence, /concept\/10-ch\.md/u);
  assert.equal(openRes.conditions[4].state, "holds");
});

test("unit: condition 6 holds with empty missing4 and lists missing ablations on gap", () => {
  const claims = new Map([
    ["C-001", { id: "C-001", primaryKeys: ["k1"], primarySources: [], chapters: [] }],
  ]);
  const row = {
    mechanism: "Mech",
    disposition: "Experiment",
    analogues: "MoE",
    claims: ["C-001"],
    experiments: [],
    sources: [],
  };
  const okCov = makeCoverage(
    [{ id: "candidate-001", path: "experiments/candidates/001-a.md", missingFacets: ["budget"] }],
    [{ id: "C-001", artifacts: ["candidate-001"] }],
  );
  const holdRes = evaluateMechanism(row, { claims, testCoverage: okCov, chapterEquations: new Map() });
  assert.equal(holdRes.conditions[5].state, "holds");

  const gapCov = makeCoverage(
    [{ id: "candidate-001", path: "experiments/candidates/001-a.md", missingFacets: ["ablations"] }],
    [{ id: "C-001", artifacts: ["candidate-001"] }],
  );
  const gapRes = evaluateMechanism(row, { claims, testCoverage: gapCov, chapterEquations: new Map() });
  assert.equal(gapRes.conditions[5].state, "gap");
  assert.match(gapRes.conditions[5].evidence, /candidate-001.*missing ablations/u);
});

test("unit: condition 7 flags ../sources/ link and renderReport passes prose audit", () => {
  const claimsMd = [
    "### C-001",
    "",
    "- **Primary source:** `smith2020`, [lead](../sources/2026-08-05-google-doc.md).",
    "- **Used by:** [ch](../concept/10-ch.md).",
  ].join("\n");
  const bibKeys = parseBibliographyKeys("@article{smith2020,\n  title={T}\n}\n");
  const claims = extractClaims(parseMd(claimsMd), { bibKeys, expectedCount: 1 });
  const heldMd = [
    "## Candidates held outside the registry",
    "",
    "| Candidate | Nearest bundles | Why held | Discriminating work |",
    "| --- | --- | --- | --- |",
    "| Held mech | P-002 | reason | [Candidate 002](../experiments/candidates/002-b.md) |",
  ].join("\n");
  const row = {
    mechanism: "Mech",
    disposition: "Explore",
    analogues: "MoE",
    claims: ["C-001"],
    experiments: ["experiments/candidates/002-b.md"],
    sources: [],
  };
  const evaluated = evaluateMechanism(row, {
    claims,
    heldCandidates: extractHeldCandidates(parseMd(heldMd)),
    inventory: [{ domain: "Control", bundles: ["P-002"], state: "partial" }],
    testCoverage: makeCoverage([{ id: "candidate-002", path: "experiments/candidates/002-b.md", missingFacets: [] }]),
    chapterEquations: new Map([["concept/10-ch.md", { display: 0, inline: 0 }]]),
  });
  assert.equal(evaluated.conditions[6].state, "gap");
  assert.match(evaluated.conditions[6].evidence, /sources\/2026-08-05-google-doc\.md/u);
  const rendered = renderReport({ evaluations: [evaluated], skippedInventoryRows: 3 });
  assert.deepEqual(auditText(rendered, "research/stage0-conditions.md"), []);
});

test("unit: matrix resolves reference-style claim links, ranges, and rejects undefined refs", () => {
  const md = [
    matrixDoc([
      "| Mech Single | Principle | **Explore** | Baselines | Test | [C-003][c3] |",
      "| Mech Range | Principle | **Explore** | Baselines | Test | [C-010][a]–[C-012][b] |",
    ]),
    "[c3]: claims.md#c-003",
    "[a]: claims.md#c-010",
    "[b]: claims.md#c-012",
    "",
  ].join("\n");
  const rows = extractMatrix(parseMd(md), makeClaimSet(20));
  assert.deepEqual(rows[0].claims, ["C-003"]);
  assert.deepEqual(rows[1].claims, ["C-010", "C-011", "C-012"]);

  const orphanTree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "linkReference", identifier: "missing", label: "missing", children: [] }],
      },
    ],
  };
  assert.throws(
    () => extractChapterClaims(orphanTree, makeClaimSet(5), "concept/10-ch.md"),
    (err) => err instanceof Stage0Error && /undefined link reference "missing"/u.test(err.message),
  );
});

test("unit: condition 4 opens when a chapter links a row claim via reference-style link", () => {
  const chapterMd = [
    "# Chapter",
    "",
    "Evidence in [C-005][c5].",
    "",
    "[c5]: ../research/claims.md#c-005",
    "",
  ].join("\n");
  const chapterClaims = extractChapterClaims(parseMd(chapterMd), makeClaimSet(10), "concept/10-ch.md");
  assert.deepEqual(chapterClaims, ["C-005"]);
  const claims = new Map([
    ["C-005", { id: "C-005", primaryKeys: ["k1"], primarySources: [], chapters: [] }],
  ]);
  const row = {
    mechanism: "Mech",
    disposition: "Explore",
    analogues: "MoE",
    claims: ["C-005"],
    experiments: [],
    sources: [],
  };
  const evaluated = evaluateMechanism(row, {
    claims,
    testCoverage: makeCoverage(),
    chapterEquations: new Map([["concept/10-ch.md", { display: 0, inline: 0 }]]),
    chaptersByClaim: indexChapterClaims([["concept/10-ch.md", chapterClaims]]),
  });
  assert.equal(evaluated.conditions[3].state, "open");
  assert.match(evaluated.conditions[3].evidence, /concept\/10-ch\.md/u);
});

test("unit: reference-style ../sources/ link in a matrix row marks condition 7 as gap", () => {
  const md = [
    matrixDoc([
      "| Mech Src | Principle ([lead][src]) | **Explore** | MoE | Test | [C-001](claims.md#c-001) |",
    ]),
    "[src]: ../sources/2026-08-05-lead.md",
    "",
  ].join("\n");
  const [row] = extractMatrix(parseMd(md), makeClaimSet(5));
  assert.deepEqual(row.sources, ["../sources/2026-08-05-lead.md"]);
  const claims = new Map([
    ["C-001", { id: "C-001", primaryKeys: ["k1"], primarySources: [], chapters: [] }],
  ]);
  const evaluated = evaluateMechanism(row, {
    claims,
    testCoverage: makeCoverage(),
    chapterEquations: new Map(),
  });
  assert.equal(evaluated.conditions[6].state, "gap");
  assert.match(evaluated.conditions[6].evidence, /sources\/2026-08-05-lead\.md/u);
});

test("unit: inventory expands P- ranges and rejects reversed principle ranges", () => {
  const validMd = [
    "| Domain | Problem patterns to collect | Current bundles | State | Next pass |",
    "| --- | --- | --- | --- | --- |",
    "| Plants | signaling | P-002--P-004 | partial | next |",
    "| Math | proofs | all existing P-001–P-003 bundles | partial | next |",
    "| Mixed | slashes | P-001/P-002/P-005--P-007/P-009 | partial | next |",
  ].join("\n");
  const inv = extractInventory(parseMd(validMd));
  assert.equal(inv.rows.length, 3);
  assert.deepEqual(inv.rows[0].bundles, ["P-002", "P-003", "P-004"]);
  assert.deepEqual(inv.rows[1].bundles, ["P-001", "P-002", "P-003"]);
  assert.deepEqual(inv.rows[2].bundles, ["P-001", "P-002", "P-005", "P-006", "P-007", "P-009"]);

  const reversedMd = [
    "| Domain | Problem patterns to collect | Current bundles | State | Next pass |",
    "| --- | --- | --- | --- | --- |",
    "| Bad | rev | P-005--P-003 | partial | next |",
  ].join("\n");
  assert.throws(
    () => extractInventory(parseMd(reversedMd)),
    (err) => err instanceof Stage0Error && /reversed principle range P-005–P-003/u.test(err.message),
  );
});

function assertStage0Throws(fn, pattern) {
  assert.throws(
    fn,
    (err) => err instanceof Stage0Error && pattern.test(err.message),
  );
}

test("unit: unresolved reference syntax fails closed through parseMd", () => {
  const known20 = makeClaimSet(20);
  const known5 = makeClaimSet(5);
  const matrixRow = (claimCell) =>
    matrixDoc([`| Mech Ref | Principle | **Explore** | Baselines | Test | ${claimCell} |`]);

  assertStage0Throws(
    () => extractMatrix(parseMd(matrixRow("[C-005][missing]")), known20),
    /unresolved link reference "\]\[missing\]"/u,
  );
  assertStage0Throws(
    () => extractMatrix(parseMd(matrixRow("[C-005][]")), known20),
    /unresolved link reference/u,
  );
  assertStage0Throws(
    () => extractMatrix(parseMd(matrixRow("[C-005]")), known20),
    /unresolved link reference "\[C-005\]"/u,
  );
  assertStage0Throws(
    () => extractChapterClaims(parseMd("See [C-003][nope].\n"), known5, "concept/10-ch.md"),
    /unresolved link reference.*at line 1/u,
  );

  const codeMd = "Code `[C-003][nope]` here.\n\n```\n[C-004][x]\n```\n";
  assert.deepEqual(extractChapterClaims(parseMd(codeMd), known5, "concept/10-ch.md"), []);

  const definedMd = "See [C-003][c3].\n\n[c3]: ../research/claims.md#c-003\n";
  assert.deepEqual(extractChapterClaims(parseMd(definedMd), known5, "concept/10-ch.md"), ["C-003"]);
});

test("unit: bracketed claim id inside link text fails closed unless its definition exists", () => {
  const known20 = makeClaimSet(20);
  const known5 = makeClaimSet(5);
  const chapter = "concept/10-ch.md";
  const matrixRow = (claimCell) =>
    matrixDoc([`| Mech Ref | Principle | **Explore** | Baselines | Test | ${claimCell} |`]);

  assertStage0Throws(
    () => extractChapterClaims(parseMd("See [notes [C-005]](https://example.org/).\n"), known5, chapter),
    /unresolved link reference "\[C-005\]" at line 1/u,
  );
  assertStage0Throws(
    () => extractMatrix(parseMd(matrixRow("[notes [C-005]](https://example.org/)")), known20),
    /unresolved link reference "\[C-005\]"/u,
  );

  const definedMd =
    "See [notes [C-005]](https://example.org/).\n\n[C-005]: ../research/claims.md#c-005\n";
  assert.deepEqual(extractChapterClaims(parseMd(definedMd), known5, chapter), ["C-005"]);

  const plainMd = "See [notes on C-005](https://example.org/).\n";
  assert.deepEqual(extractChapterClaims(parseMd(plainMd), known5, chapter), []);

  const codeSpanMd = "See [notes `[C-005]`](https://example.org/).\n";
  assert.deepEqual(extractChapterClaims(parseMd(codeSpanMd), known5, chapter), []);
});

test("unit: indexTestCoverage rejects missing or malformed missingFacets and accepts explicit empty array", () => {
  const missingFieldCov = makeCoverage([
    { id: "candidate-001", path: "experiments/candidates/001-a.md" },
  ]);
  assert.throws(
    () => indexTestCoverage(missingFieldCov),
    (err) => err instanceof Stage0Error && /missingFacets/u.test(err.message),
  );
  assertStage0Throws(
    () => indexTestCoverage(makeCoverage([{ id: "candidate-001", path: "experiments/candidates/001-a.md", missingFacets: [null] }])),
    /invalid missingFacets entry null/u,
  );
  assertStage0Throws(
    () => indexTestCoverage(makeCoverage([{ id: "candidate-001", path: "experiments/candidates/001-a.md", missingFacets: ["typo"] }])),
    /invalid missingFacets entry "typo"/u,
  );

  const claims = new Map([
    ["C-001", { id: "C-001", primaryKeys: ["k1"], primarySources: [], chapters: [] }],
  ]);
  const row = {
    mechanism: "Mech",
    disposition: "Experiment",
    analogues: "MoE",
    claims: ["C-001"],
    experiments: [],
    sources: [],
  };
  const emptyArrayCov = makeCoverage(
    [{ id: "candidate-001", path: "experiments/candidates/001-a.md", missingFacets: [] }],
    [{ id: "C-001", artifacts: ["candidate-001"] }],
  );
  const indexed = indexTestCoverage(emptyArrayCov);
  const evaluated = evaluateMechanism(row, {
    claims,
    testCoverage: indexed,
    chapterEquations: new Map(),
  });
  assert.equal(evaluated.conditions[5].state, "holds");
});

test("integration: valid --check passes, missing and byte-tampered output fail", async () => {
  const tmpDir = await createTempRepoRoot();
  try {
    const { stdout } = await runCli(["--root", tmpDir, "--check"]);
    assert.match(stdout, /Verified \d+ mechanisms against 7 Stage-0 conditions\./u);

    const outPath = path.join(tmpDir, "research/stage0-conditions.md");
    await fs.rm(outPath);
    await assertCliFails(
      ["--root", tmpDir, "--check"],
      /missing generated file research\/stage0-conditions\.md/u,
    );

    await runCli(["--root", tmpDir]);
    const original = await fs.readFile(outPath, "utf8");
    await fs.writeFile(outPath, `${original} `, "utf8");
    await assertCliFails(
      ["--root", tmpDir, "--check"],
      /generated file is stale: research\/stage0-conditions\.md/u,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("integration: disposition change, header mismatch, and unknown claim fail", async () => {
  const tmpDir = await createTempRepoRoot();
  try {
    const matrixPath = path.join(tmpDir, "research/adoption-matrix.md");
    const orig = await fs.readFile(matrixPath, "utf8");

    await fs.writeFile(matrixPath, orig.replace("**Use now**", "**Explore**"), "utf8");
    await assertCliFails(
      ["--root", tmpDir, "--check"],
      /generated file is stale: research\/stage0-conditions\.md/u,
    );

    await fs.writeFile(matrixPath, orig.replace("| Candidate |", "| Mechanism |"), "utf8");
    await assertCliFails(["--root", tmpDir, "--check"], /header mismatch/u);

    const badClaim = orig.replace("[C-003](claims.md#c-003)", "[C-9999](claims.md#c-9999)");
    await fs.writeFile(matrixPath, badClaim, "utf8");
    await assertCliFails(["--root", tmpDir, "--check"], /unknown claim C-9999/u);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("integration: a new chapter link to a row claim makes the report stale", async () => {
  const tmpDir = await createTempRepoRoot();
  try {
    const chapterPath = path.join(tmpDir, "concept/90-research-roadmap.md");
    const orig = await fs.readFile(chapterPath, "utf8");
    await fs.writeFile(chapterPath, `${orig}\nSee [C-030](../research/claims.md#c-030).\n`, "utf8");
    await assertCliFails(
      ["--root", tmpDir, "--check"],
      /generated file is stale: research\/stage0-conditions\.md/u,
    );
    await fs.writeFile(chapterPath, `${orig}\nSee [C-9999](../research/claims.md#c-9999).\n`, "utf8");
    await assertCliFails(["--root", tmpDir, "--check"], /unknown claim C-9999/u);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("integration: unknown CLI argument and >8 MiB input fail closed", async () => {
  const tmpDir = await createTempRepoRoot();
  try {
    await assertCliFails(["--root", tmpDir, "--unknown"], /unknown argument/u);

    const claimsPath = path.join(tmpDir, "research/claims.md");
    await fs.writeFile(claimsPath, "x".repeat(8 * 1024 * 1024 + 1), "utf8");
    await assertCliFails(["--root", tmpDir, "--check"], /8388608-byte limit/u);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
