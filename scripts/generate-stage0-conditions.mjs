import { readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { readStableOpenedFile } from "./lib/opened-file.mjs";
import { parseClaimLedger, parsePrincipleRegistry } from "./lib/research-ledger.mjs";
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
  indexPrincipleClaims,
  indexTestCoverage,
  parseBibliographyKeys,
  renderReport,
} from "./lib/stage0-conditions.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_CHAPTER_FILES = 200;
const MAX_CLI_ARGS = 64;
const CONCEPT_DIR = "concept";
const OUTPUT_REL_PATH = "research/stage0-conditions.md";

const FIXED_SOURCES = Object.freeze({
  matrix: "research/adoption-matrix.md",
  inventory: "research/domain-inventory.md",
  claims: "research/claims.md",
  principles: "research/principle-registry.md",
  bib: "research/references.bib",
  coverage: "experiments/test-coverage.json",
});

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parseCliArgs(argv) {
  if (argv.length > MAX_CLI_ARGS) {
    throw new Stage0Error("cli", `too many CLI arguments (${argv.length})`);
  }
  let check = false;
  let rootDir = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--root") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Stage0Error("cli", "missing value for --root");
      }
      rootDir = next;
      index += 1;
    } else {
      throw new Stage0Error("cli", `unknown argument: ${arg}`);
    }
  }
  return { check, root: path.resolve(rootDir) };
}

async function readOpenedBytes(root, relPath, missingMessage = null) {
  try {
    return await readStableOpenedFile(path.join(root, relPath), {
      label: relPath,
      containedBy: root,
      maximumBytes: MAX_INPUT_BYTES,
    });
  } catch (error) {
    if (missingMessage && error?.code === "ENOENT") {
      throw new Stage0Error(relPath, missingMessage, { cause: error });
    }
    throw new Stage0Error(relPath, error.message, { cause: error });
  }
}

async function readBoundedText(root, relPath) {
  const bytes = await readOpenedBytes(root, relPath);
  try {
    return utf8Decoder.decode(bytes);
  } catch (error) {
    throw new Stage0Error(relPath, `invalid UTF-8: ${error.message}`, { cause: error });
  }
}

function parseJsonSource(text, relPath) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Stage0Error(relPath, `invalid JSON: ${error.message}`, { cause: error });
  }
}

async function listConceptChapters(root) {
  let entries;
  try {
    entries = await readdir(path.join(root, CONCEPT_DIR), { withFileTypes: true });
  } catch (error) {
    throw new Stage0Error(CONCEPT_DIR, `cannot list chapters: ${error.message}`, { cause: error });
  }
  const chapters = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `${CONCEPT_DIR}/${entry.name}`)
    .sort();
  if (chapters.length > MAX_CHAPTER_FILES) {
    throw new Stage0Error(
      CONCEPT_DIR,
      `chapter count ${chapters.length} exceeds ${MAX_CHAPTER_FILES}`,
    );
  }
  return chapters;
}

async function loadConceptChapters(root, claims) {
  const chapterEquations = new Map();
  const chapterClaims = [];
  for (const chapter of await listConceptChapters(root)) {
    const tree = parser.parse(await readBoundedText(root, chapter));
    chapterEquations.set(chapter, countChapterEquations(tree, chapter));
    chapterClaims.push([chapter, extractChapterClaims(tree, claims, chapter)]);
  }
  return { chapterEquations, chaptersByClaim: indexChapterClaims(chapterClaims) };
}

async function readFixedInputs(root) {
  const [matrix, inventory, claims, principles, bib, coverage] = await Promise.all([
    readBoundedText(root, FIXED_SOURCES.matrix),
    readBoundedText(root, FIXED_SOURCES.inventory),
    readBoundedText(root, FIXED_SOURCES.claims),
    readBoundedText(root, FIXED_SOURCES.principles),
    readBoundedText(root, FIXED_SOURCES.bib),
    readBoundedText(root, FIXED_SOURCES.coverage),
  ]);
  return { matrix, inventory, claims, principles, bib, coverage };
}

async function buildReport(root) {
  const raw = await readFixedInputs(root);
  const claims = extractClaims(parser.parse(raw.claims), {
    bibKeys: parseBibliographyKeys(raw.bib, FIXED_SOURCES.bib),
    expectedCount: parseClaimLedger(raw.claims).length,
    file: FIXED_SOURCES.claims,
  });
  const matrix = extractMatrix(parser.parse(raw.matrix), claims, FIXED_SOURCES.matrix);
  const inventory = extractInventory(parser.parse(raw.inventory), FIXED_SOURCES.inventory);
  const { chapterEquations, chaptersByClaim } = await loadConceptChapters(root, claims);
  const context = {
    claims,
    principlesByClaim: indexPrincipleClaims(parsePrincipleRegistry(raw.principles)),
    heldCandidates: extractHeldCandidates(parser.parse(raw.principles), FIXED_SOURCES.principles),
    inventory,
    chapterEquations,
    chaptersByClaim,
    testCoverage: indexTestCoverage(
      parseJsonSource(raw.coverage, FIXED_SOURCES.coverage),
      FIXED_SOURCES.coverage,
    ),
  };
  const evaluations = matrix.map((row) => evaluateMechanism(row, context));
  const markdown = renderReport({ evaluations, skippedInventoryRows: inventory.skippedRows });
  return { markdown, mechanismCount: evaluations.length };
}

async function checkOutput(root, expectedMarkdown, mechanismCount) {
  const bytes = await readOpenedBytes(
    root,
    OUTPUT_REL_PATH,
    `missing generated file ${OUTPUT_REL_PATH}`,
  );
  if (!Buffer.from(expectedMarkdown, "utf8").equals(bytes)) {
    throw new Stage0Error(OUTPUT_REL_PATH, `generated file is stale: ${OUTPUT_REL_PATH}`);
  }
  console.log(`Verified ${mechanismCount} mechanisms against 7 Stage-0 conditions.`);
}

async function writeAtomicOutput(root, markdown) {
  const outputPath = path.join(root, OUTPUT_REL_PATH);
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, markdown, "utf8");
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Stage0Error(OUTPUT_REL_PATH, error.message, { cause: error });
  }
}

async function main() {
  const { check, root } = parseCliArgs(process.argv.slice(2));
  const { markdown, mechanismCount } = await buildReport(root);
  if (check) {
    await checkOutput(root, markdown, mechanismCount);
  } else {
    await writeAtomicOutput(root, markdown);
  }
}

main().catch((error) => {
  if (error instanceof Stage0Error) {
    console.error(`stage0-conditions: ${error.file}: ${error.message}`);
  } else {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`stage0-conditions: cli: ${detail}`);
  }
  process.exit(1);
});
