import { createMdastTools } from "./mdast-claims.mjs";

const MAX_ROOT_CHILDREN = 200_000;
const MAX_MATRIX_ROWS = 1_000;
const MAX_PRINCIPLE_MATCHES = 10_000;
const MAX_BIB_MATCHES = 200_000;
const MAX_ANALOGUE_CHARS = 100;
const EVIDENCE_LIST_LIMIT = 5;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

const MATRIX_HEADER = Object.freeze([
  "Candidate",
  "Biological or scientific principle",
  "Current disposition",
  "What already exists",
  "Missing test for this project",
  "Claim",
]);

const INVENTORY_HEADERS = Object.freeze({
  current: Object.freeze([
    "Domain",
    "Problem patterns to collect",
    "Current bundles",
    "State",
    "Next pass",
  ]),
  likely: Object.freeze([
    "Domain",
    "Problem patterns to collect",
    "Likely bundle relation",
    "State",
    "Next pass",
  ]),
  horizon: Object.freeze([
    "Domain family",
    "Example fields and systems",
    "Problem patterns to search",
    "State",
  ]),
});

const HELD_HEADER = Object.freeze([
  "Candidate",
  "Nearest bundles",
  "Why held",
  "Discriminating work",
]);

const PRIMARY_SOURCE_LABELS = new Set([
  "Primary source:",
  "Primary sources:",
  "Primary/authoritative source:",
  "Primary/authoritative sources:",
  "Primary and authoritative sources:",
]);

const INVENTORY_STATES = new Set(["audited", "partial", "queued"]);
const ANALOGUE_PLACEHOLDERS = new Set(["", "—", "–", "-", "none", "n/a"]);
const REQUIRED_FACET_IDS = Object.freeze([
  "comparators",
  "ablations",
  "measurements",
  "failure",
]);

const CLAIM_HEADING_RE = /^C-\d{3,4}$/u;
const MATRIX_CLAIM_BASE = "claims.md";
const CHAPTER_CLAIM_BASE = "../research/claims.md";
const MATRIX_EXPERIMENT_RE = /^\.\.\/experiments\/(candidates|fixtures)\/([^/#?]+\.md)$/u;
const HELD_CANDIDATE_RE = /^\.\.\/experiments\/candidates\/([^/#?]+\.md)$/u;
const CONCEPT_LINK_RE = /^\.\.\/concept\/([^/#?]+\.md)(#.*)?$/u;
const PRINCIPLE_RANGE_RE = /\bP-(\d{3})(?:\s*(?:--|[-–—])\s*P-(\d{3}))?\b/gu;
const BIB_KEY_RE = /^@[A-Za-z0-9_]+\{([^,]+),/gmu;

const CONDITION_RULES = Object.freeze([
  Object.freeze({
    num: 1,
    summaryLabel: "1. Scoped claim and primary source",
    roadmap: "Observation has at least one scoped claim and primary source",
    rule: "At least one row claim names a primary-source bibliography key present in `research/references.bib`.",
    limit: "Checks citekey presence in primary-source fields, not whether the cited work establishes row scope.",
  }),
  Object.freeze({
    num: 2,
    summaryLabel: "2. Nearest AI and engineering analogues",
    roadmap: "Nearest existing AI and engineering analogues are recorded",
    rule: "The matrix `What already exists` cell is non-empty and not in the placeholder allow-list (`—`, `–`, `-`, `none`, `n/a`).",
    limit: "Checks cell presence only, not nearness or completeness of the recorded analogues.",
  }),
  Object.freeze({
    num: 3,
    summaryLabel: "3. Maps to principle or held candidate",
    roadmap: "Normalized operation maps to a `P-` principle or a held candidate",
    rule: "At least one row claim belongs to a `P-` bundle in `research/principle-registry.md`, or a row experiment link matches a held candidate.",
    limit: "Checks registry membership or unfragmented candidate-file links, not normalization quality.",
  }),
  Object.freeze({
    num: 4,
    summaryLabel: "4. Chapter exposes state, flow, timescale, boundary, and failure",
    roadmap: "Affected chapter exposes state, information flow, timescale, physical boundary, and failure behavior",
    rule: "`gap` when no row claim lists a `concept/*.md` chapter under `Used by:` and no `concept/*.md` chapter links a row claim; otherwise `open`.",
    limit: "No repository check reads chapter content to verify those five semantic elements.",
  }),
  Object.freeze({
    num: 5,
    summaryLabel: "5. Equations define symbols and units",
    roadmap: "Every equation defines symbols and units",
    rule: "`holds` when the condition-4 chapters exist and contain no display or inline math; otherwise `open`.",
    limit: "No symbol or unit definition check exists for Markdown equations.",
  }),
  Object.freeze({
    num: 6,
    summaryLabel: "6. Null, ablation, measurement envelope, and rejection rule",
    roadmap: "Conventional null, ablation, measurement envelope, and rejection condition exist",
    rule: "At least one routed or row-linked artifact in `experiments/test-coverage.json` has none of `comparators`, `ablations`, `measurements`, or `failure` in `missingFacets`.",
    limit: "Checks headings only via `test-coverage` facet patterns; the `failure` facet also matches promotion headings.",
  }),
  Object.freeze({
    num: 7,
    summaryLabel: "7. Link-only provenance stays a source lead",
    roadmap: "Link-only discussion provenance records remain source leads rather than evidence",
    rule: "Neither the matrix row nor any row claim primary-source field links to `../sources/`.",
    limit: "Checks Markdown links to `../sources/` only, not unlinked prose mentions.",
  }),
]);

export class Stage0Error extends Error {
  constructor(file, message, options) {
    super(message, options);
    this.name = "Stage0Error";
    this.file = file;
  }
}

const { walkAst, nodeText, collectSiblingClaims, resolveLinkReferences } =
  createMdastTools(Stage0Error);

function uniqueItems(items) {
  return [...new Set(items)];
}

function formatCapped(items, separator = ", ", limit = EVIDENCE_LIST_LIMIT) {
  if (items.length <= limit) return items.join(separator);
  const head = items.slice(0, limit).join(separator);
  return `${head}${separator}+${items.length - limit} more`;
}

function headersEqual(actual, expected) {
  return actual.length === expected.length
    && actual.every((cell, index) => cell === expected[index]);
}

function tableHeaderCells(table, file) {
  const headerRow = table.children?.[0];
  if (!headerRow || !Array.isArray(headerRow.children)) {
    throw new Stage0Error(file, "malformed table without header row");
  }
  return headerRow.children.map((cell) => nodeText(cell, file));
}

function rootChildren(tree, file) {
  if (!tree || typeof tree !== "object" || !Array.isArray(tree.children)) {
    throw new Stage0Error(file, "expected mdast root with children array");
  }
  if (tree.children.length > MAX_ROOT_CHILDREN) {
    throw new Stage0Error(file, `root child limit (${MAX_ROOT_CHILDREN}) exceeded`);
  }
  return tree.children;
}

function findHeadingIndex(children, headingText, file) {
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (node?.type === "heading" && node.depth === 2 && nodeText(node, file) === headingText) {
      return index;
    }
  }
  return -1;
}

function findTableUnderHeading(tree, headingText, file) {
  const children = rootChildren(tree, file);
  const startIndex = findHeadingIndex(children, headingText, file);
  if (startIndex < 0) {
    throw new Stage0Error(file, `missing heading "## ${headingText}"`);
  }
  for (let index = startIndex + 1; index < children.length; index += 1) {
    const node = children[index];
    if (node?.type === "heading" && node.depth <= 2) break;
    if (node?.type === "table") return node;
  }
  throw new Stage0Error(file, `missing table under "## ${headingText}"`);
}

function formatPrincipleId(num) {
  return `P-${String(num).padStart(3, "0")}`;
}

function expandPrincipleSpan(startText, endText, seen, file) {
  const start = Number(startText);
  const end = endText === undefined ? start : Number(endText);
  if (start > end) {
    throw new Stage0Error(
      file,
      `reversed principle range ${formatPrincipleId(start)}–${formatPrincipleId(end)}`,
    );
  }
  for (let current = start; current <= end; current += 1) {
    seen.add(formatPrincipleId(current));
  }
}

function extractPrincipleIds(text, file) {
  const seen = new Set();
  let count = 0;
  PRINCIPLE_RANGE_RE.lastIndex = 0;
  for (const match of text.matchAll(PRINCIPLE_RANGE_RE)) {
    count += 1;
    if (count > MAX_PRINCIPLE_MATCHES) {
      throw new Stage0Error(file, `principle token limit (${MAX_PRINCIPLE_MATCHES}) exceeded`);
    }
    expandPrincipleSpan(match[1], match[2], seen, file);
  }
  return [...seen];
}

function classifyMatrixLink(url, experiments, sources) {
  const expMatch = MATRIX_EXPERIMENT_RE.exec(url);
  if (expMatch) {
    experiments.push(`experiments/${expMatch[1]}/${expMatch[2]}`);
  }
  if (url.startsWith("../sources/")) {
    sources.push(url);
  }
}

function collectRowLinks(rowNode, file) {
  const claims = [];
  const experiments = [];
  const sources = [];
  walkAst(rowNode, file, (node) => {
    if (Array.isArray(node.children)) {
      collectSiblingClaims(node.children, claims, MATRIX_CLAIM_BASE, file);
    }
    if (node.type === "link" && typeof node.url === "string") {
      classifyMatrixLink(node.url, experiments, sources);
    }
  });
  return {
    claims: uniqueItems(claims),
    experiments: uniqueItems(experiments),
    sources: uniqueItems(sources),
  };
}

function toIdSet(collection) {
  if (!collection) return null;
  if (collection instanceof Set) return collection;
  if (collection instanceof Map) return new Set(collection.keys());
  return new Set(collection);
}

function assertKnownClaims(claimIds, knownClaims, file) {
  if (!knownClaims) return;
  for (const claimId of claimIds) {
    if (!knownClaims.has(claimId)) {
      throw new Stage0Error(file, `unknown claim ${claimId}`);
    }
  }
}

function parseMatrixRow(rowNode, seenMechanisms, knownClaims, file) {
  if (!Array.isArray(rowNode.children) || rowNode.children.length !== MATRIX_HEADER.length) {
    throw new Stage0Error(file, "matrix row cell count mismatch");
  }
  const mechanism = nodeText(rowNode.children[0], file);
  if (!mechanism) throw new Stage0Error(file, "empty mechanism name in matrix");
  if (seenMechanisms.has(mechanism)) {
    throw new Stage0Error(file, `duplicate mechanism "${mechanism}"`);
  }
  seenMechanisms.add(mechanism);
  const links = collectRowLinks(rowNode, file);
  assertKnownClaims(links.claims, knownClaims, file);
  return {
    mechanism,
    disposition: nodeText(rowNode.children[2], file),
    analogues: nodeText(rowNode.children[3], file),
    ...links,
  };
}

export function extractMatrix(tree, knownClaimIds, file = "research/adoption-matrix.md") {
  resolveLinkReferences(tree, file);
  const table = findTableUnderHeading(tree, "Working matrix", file);
  if (!headersEqual(tableHeaderCells(table, file), MATRIX_HEADER)) {
    throw new Stage0Error(file, "header mismatch");
  }
  const dataRows = table.children.slice(1);
  if (dataRows.length === 0 || dataRows.length > MAX_MATRIX_ROWS) {
    throw new Stage0Error(
      file,
      `matrix row count ${dataRows.length} must be between 1 and ${MAX_MATRIX_ROWS}`,
    );
  }
  const seenMechanisms = new Set();
  const knownSet = toIdSet(knownClaimIds);
  return dataRows.map((row) => parseMatrixRow(row, seenMechanisms, knownSet, file));
}

function classifyInventoryHeader(header, file) {
  if (headersEqual(header, INVENTORY_HEADERS.current)) return "bundle";
  if (headersEqual(header, INVENTORY_HEADERS.likely)) return "bundle";
  if (headersEqual(header, INVENTORY_HEADERS.horizon)) return "skip";
  throw new Stage0Error(file, `header mismatch: ${header.join(" | ")}`);
}

function parseInventoryRow(rowNode, file) {
  if (!Array.isArray(rowNode.children) || rowNode.children.length !== 5) {
    throw new Stage0Error(file, "inventory row cell count mismatch");
  }
  const domain = nodeText(rowNode.children[0], file);
  if (!domain) throw new Stage0Error(file, "empty domain name in inventory");
  const bundleText = nodeText(rowNode.children[2], file);
  const bundles = extractPrincipleIds(bundleText, file);
  const rawState = nodeText(rowNode.children[3], file).split(";", 1)[0].trim().toLowerCase();
  if (!INVENTORY_STATES.has(rawState)) {
    throw new Stage0Error(file, `unknown inventory state "${rawState}"`);
  }
  return { domain, bundles, state: rawState };
}

export function extractInventory(tree, file = "research/domain-inventory.md") {
  resolveLinkReferences(tree, file);
  const tables = [];
  walkAst(tree, file, (node) => {
    if (node.type === "table") tables.push(node);
  });
  if (tables.length === 0) {
    throw new Stage0Error(file, "no tables found in domain inventory");
  }
  const rows = [];
  let skippedRows = 0;
  for (const table of tables) {
    const mode = classifyInventoryHeader(tableHeaderCells(table, file), file);
    const dataRows = table.children.slice(1);
    if (mode === "skip") {
      skippedRows += dataRows.length;
      continue;
    }
    for (const row of dataRows) rows.push(parseInventoryRow(row, file));
  }
  return { rows, skippedRows };
}

export function parseBibliographyKeys(bibText, file = "research/references.bib") {
  if (typeof bibText !== "string") {
    throw new Stage0Error(file, "bibliography input must be a string");
  }
  const keys = new Set();
  let count = 0;
  BIB_KEY_RE.lastIndex = 0;
  for (const match of bibText.matchAll(BIB_KEY_RE)) {
    count += 1;
    if (count > MAX_BIB_MATCHES) {
      throw new Stage0Error(file, `bibliography entry limit (${MAX_BIB_MATCHES}) exceeded`);
    }
    keys.add(match[1]);
  }
  return keys;
}

function extractFieldLabel(listItem, file) {
  const firstBlock = listItem.children?.[0];
  if (firstBlock?.type !== "paragraph") return null;
  const firstInline = firstBlock.children?.[0];
  if (firstInline?.type !== "strong") return null;
  return nodeText(firstInline, file);
}

function collectPrimarySourceField(listItem, record, bibSet, file) {
  walkAst(listItem, file, (node) => {
    if (node.type === "inlineCode") {
      const key = String(node.value ?? "");
      if (!bibSet.has(key)) {
        throw new Stage0Error(file, `${record.id} references missing bibliography key ${key}`);
      }
      record.primaryKeys.push(key);
    } else if (node.type === "link" && typeof node.url === "string" && node.url.startsWith("../sources/")) {
      record.primarySources.push(node.url);
    }
  });
}

function collectUsedByField(listItem, record, file) {
  walkAst(listItem, file, (node) => {
    if (node.type !== "link" || typeof node.url !== "string") return;
    const match = CONCEPT_LINK_RE.exec(node.url);
    if (match) record.chapters.push(`concept/${match[1]}`);
  });
}

function inspectClaimListItem(listItem, record, bibSet, file) {
  const label = extractFieldLabel(listItem, file);
  if (!label) return;
  if (PRIMARY_SOURCE_LABELS.has(label)) {
    collectPrimarySourceField(listItem, record, bibSet, file);
  } else if (label === "Used by:") {
    collectUsedByField(listItem, record, file);
  }
}

function openClaimFromHeading(node, claims, file) {
  if (node.depth !== 3) return null;
  const title = nodeText(node, file);
  if (!CLAIM_HEADING_RE.test(title)) return null;
  if (claims.has(title)) throw new Stage0Error(file, `duplicate claim ${title}`);
  const record = { id: title, primaryKeys: [], primarySources: [], chapters: [] };
  claims.set(title, record);
  return record;
}

function finalizeClaimRecords(claims) {
  for (const record of claims.values()) {
    record.primaryKeys = uniqueItems(record.primaryKeys);
    record.primarySources = uniqueItems(record.primarySources);
    record.chapters = uniqueItems(record.chapters);
  }
}

function collectClaimRecords(children, bibSet, file) {
  const claims = new Map();
  let current = null;
  for (const node of children) {
    if (node?.type === "heading" && node.depth <= 3) {
      current = openClaimFromHeading(node, claims, file);
    } else if (current && node?.type === "list") {
      for (const item of node.children ?? []) {
        inspectClaimListItem(item, current, bibSet, file);
      }
    }
  }
  return claims;
}

export function extractClaims(tree, options = {}) {
  const file = options.file ?? "research/claims.md";
  resolveLinkReferences(tree, file);
  const bibSet = toIdSet(options.bibKeys) ?? new Set();
  const claims = collectClaimRecords(rootChildren(tree, file), bibSet, file);
  finalizeClaimRecords(claims);
  const expectedCount = options.expectedCount;
  if (expectedCount !== undefined && claims.size !== expectedCount) {
    throw new Stage0Error(
      file,
      `claim parse mismatch: mdast=${claims.size}, ledger=${expectedCount}`,
    );
  }
  return claims;
}

function parseHeldRow(rowNode, file) {
  if (!Array.isArray(rowNode.children) || rowNode.children.length !== HELD_HEADER.length) {
    throw new Stage0Error(file, "held-candidate row cell count mismatch");
  }
  const name = nodeText(rowNode.children[0], file);
  if (!name) throw new Stage0Error(file, "empty held-candidate name");
  const nearestText = nodeText(rowNode.children[1], file);
  const nearest = extractPrincipleIds(nearestText, file).sort();
  const candidatePaths = [];
  walkAst(rowNode.children[3], file, (node) => {
    if (node.type !== "link" || typeof node.url !== "string") return;
    const match = HELD_CANDIDATE_RE.exec(node.url);
    if (match) candidatePaths.push(`experiments/candidates/${match[1]}`);
  });
  return { name, nearest, candidatePaths: uniqueItems(candidatePaths) };
}

export function extractHeldCandidates(tree, file = "research/principle-registry.md") {
  resolveLinkReferences(tree, file);
  const table = findTableUnderHeading(tree, "Candidates held outside the registry", file);
  if (!headersEqual(tableHeaderCells(table, file), HELD_HEADER)) {
    throw new Stage0Error(file, "header mismatch");
  }
  return table.children.slice(1).map((row) => parseHeldRow(row, file));
}

export function countChapterEquations(tree, file = "concept/chapter.md") {
  resolveLinkReferences(tree, file);
  let display = 0;
  let inline = 0;
  walkAst(tree, file, (node) => {
    if (node.type === "math") display += 1;
    else if (node.type === "inlineMath") inline += 1;
  });
  return { display, inline };
}

function invertClaimIndex(entries) {
  const byClaim = new Map();
  for (const [owner, claimIds] of entries) {
    for (const claimId of claimIds) {
      const list = byClaim.get(claimId) ?? [];
      list.push(owner);
      byClaim.set(claimId, list);
    }
  }
  for (const [claimId, list] of byClaim) {
    byClaim.set(claimId, uniqueItems(list).sort());
  }
  return byClaim;
}

export function indexPrincipleClaims(principles) {
  return invertClaimIndex(principles.map((principle) => [principle.id, principle.claims ?? []]));
}

export function extractChapterClaims(tree, knownClaimIds, file = "concept/chapter.md") {
  resolveLinkReferences(tree, file);
  const claims = [];
  walkAst(tree, file, (node) => {
    if (Array.isArray(node.children)) {
      collectSiblingClaims(node.children, claims, CHAPTER_CLAIM_BASE, file);
    }
  });
  const claimIds = uniqueItems(claims).sort();
  assertKnownClaims(claimIds, toIdSet(knownClaimIds), file);
  return claimIds;
}

export function indexChapterClaims(chapterClaims) {
  return invertClaimIndex(chapterClaims);
}

function buildFacetLabelMap(protocolComplete, file) {
  if (!Array.isArray(protocolComplete)) {
    throw new Stage0Error(file, "criteria.protocolComplete must be an array");
  }
  const facetLabels = new Map();
  for (const entry of protocolComplete) {
    if (typeof entry?.id !== "string" || typeof entry?.label !== "string") {
      throw new Stage0Error(file, "invalid criteria.protocolComplete entry");
    }
    facetLabels.set(entry.id, entry.label);
  }
  for (const requiredId of REQUIRED_FACET_IDS) {
    if (!facetLabels.has(requiredId)) {
      throw new Stage0Error(file, `missing required protocol facet "${requiredId}"`);
    }
  }
  return facetLabels;
}

const INDEXED_COVERAGE = Symbol("indexedCoverage");

function assertArtifactFacets(artifacts, file) {
  for (const artifact of artifacts) {
    if (!artifact || !Array.isArray(artifact.missingFacets)) {
      const id = artifact ? artifact.id : undefined;
      throw new Stage0Error(file, `artifact ${id} has no missingFacets array`);
    }
  }
}

function assertArtifactFacetEntries(artifacts, facetLabels, file) {
  for (const artifact of artifacts) {
    for (const entry of artifact.missingFacets) {
      if (typeof entry !== "string" || !facetLabels.has(entry)) {
        throw new Stage0Error(
          file,
          `artifact ${artifact.id} has invalid missingFacets entry ${JSON.stringify(entry)}`,
        );
      }
    }
  }
}

function assertCoverageShape(coverage, file) {
  if (!coverage || typeof coverage !== "object" || coverage.schema !== 2) {
    const actual = coverage ? coverage.schema : undefined;
    throw new Stage0Error(file, `expected test-coverage schema 2, got ${actual}`);
  }
  if (!Array.isArray(coverage.artifacts) || !Array.isArray(coverage.claims)) {
    throw new Stage0Error(file, "test-coverage artifacts and claims must be arrays");
  }
  assertArtifactFacets(coverage.artifacts, file);
}

export function indexTestCoverage(coverage, file = "experiments/test-coverage.json") {
  if (coverage?.[INDEXED_COVERAGE]) return coverage;
  assertCoverageShape(coverage, file);
  const facetLabels = buildFacetLabelMap(coverage.criteria?.protocolComplete, file);
  assertArtifactFacetEntries(coverage.artifacts, facetLabels, file);
  const artifactById = new Map(coverage.artifacts.map((a) => [a.id, a]));
  const artifactByPath = new Map(coverage.artifacts.map((a) => [a.path, a]));
  const claimArtifactsById = new Map(coverage.claims.map((c) => [c.id, c.artifacts ?? []]));
  return Object.freeze({
    [INDEXED_COVERAGE]: true,
    facetLabels,
    artifactById,
    artifactByPath,
    claimArtifactsById,
  });
}

function claimMarkdownLink(claimId) {
  return `[${claimId}](claims.md#${claimId.toLowerCase()})`;
}

function normalizeSourceDisplay(url) {
  return url.replace(/^\.\.\//u, "").split(/[?#]/u, 1)[0];
}

function evaluateCondition1(rowClaims) {
  const withKeys = rowClaims.filter((claim) => claim.primaryKeys.length > 0);
  if (withKeys.length === 0) {
    return { state: "gap", evidence: "no row claim names a primary-source key" };
  }
  const items = withKeys.map((claim) => {
    const keys = formatCapped(claim.primaryKeys.map((k) => `\`${k}\``), ", ");
    return `${claimMarkdownLink(claim.id)}: ${keys}`;
  });
  return { state: "holds", evidence: formatCapped(items, "; ") };
}

function evaluateCondition2(analogues) {
  const normalized = analogues.trim().toLowerCase();
  if (ANALOGUE_PLACEHOLDERS.has(normalized)) {
    return { state: "gap", evidence: "no AI or engineering analogues recorded" };
  }
  const codePoints = [...analogues];
  const snippet = codePoints.length > MAX_ANALOGUE_CHARS
    ? `${codePoints.slice(0, MAX_ANALOGUE_CHARS).join("")}…`
    : analogues;
  return { state: "holds", evidence: snippet };
}

function resolvePrincipleMap(context) {
  if (context.principlesByClaim instanceof Map) return context.principlesByClaim;
  if (Array.isArray(context.principles)) return indexPrincipleClaims(context.principles);
  return new Map();
}

function evaluateCondition3(row, principlesByClaim, heldCandidates) {
  const pIds = uniqueItems(
    row.claims.flatMap((claimId) => principlesByClaim.get(claimId) ?? []),
  ).sort();
  if (pIds.length > 0) {
    return {
      result: { state: "holds", evidence: formatCapped(pIds, ", ") },
      pSet: new Set(pIds),
    };
  }
  const matchedHeld = heldCandidates.filter((held) =>
    held.candidatePaths.some((candidatePath) => row.experiments.includes(candidatePath)),
  );
  if (matchedHeld.length > 0) {
    const names = matchedHeld.map((held) => held.name);
    const nearest = uniqueItems(matchedHeld.flatMap((held) => held.nearest)).sort();
    return {
      result: { state: "holds", evidence: `held candidate: ${formatCapped(names, "; ")}` },
      pSet: new Set(nearest),
    };
  }
  return {
    result: {
      state: "gap",
      evidence: "no row claim maps to a P- bundle and no row experiment matches a held candidate",
    },
    pSet: new Set(),
  };
}

function evaluateCondition4(chapters) {
  if (chapters.length === 0) {
    return {
      state: "gap",
      evidence: "no row claim lists a concept chapter and no concept chapter links a row claim",
    };
  }
  const links = chapters.map((chapter) => `[${chapter}](../${chapter})`);
  return { state: "open", evidence: formatCapped(links, ", ") };
}

function readChapterCounts(chapterEquations, chapter) {
  const entry = chapterEquations instanceof Map
    ? chapterEquations.get(chapter)
    : chapterEquations?.[chapter];
  if (!entry) {
    throw new Stage0Error(chapter, `linked chapter ${chapter} is not a concept/*.md file`);
  }
  return entry;
}

function evaluateCondition5(chapters, chapterEquations) {
  if (chapters.length === 0) {
    return { state: "open", evidence: "no linked chapter" };
  }
  let display = 0;
  let inline = 0;
  for (const chapter of chapters) {
    const counts = readChapterCounts(chapterEquations, chapter);
    display += counts.display;
    inline += counts.inline;
  }
  if (display + inline === 0) {
    return { state: "holds", evidence: "linked chapters contain no equations" };
  }
  return {
    state: "open",
    evidence: `${display} display and ${inline} inline equations; no repository check decides symbol and unit definitions`,
  };
}

function collectRowArtifacts(row, coverage) {
  const byId = new Map();
  for (const claimId of row.claims) {
    for (const artifactId of coverage.claimArtifactsById.get(claimId) ?? []) {
      const artifact = coverage.artifactById.get(artifactId);
      if (!artifact) {
        throw new Stage0Error("experiments/test-coverage.json", `unknown artifact ${artifactId}`);
      }
      byId.set(artifact.id, artifact);
    }
  }
  for (const expPath of row.experiments) {
    const artifact = coverage.artifactByPath.get(expPath);
    if (!artifact) {
      throw new Stage0Error("experiments/test-coverage.json", `unknown experiment path ${expPath}`);
    }
    byId.set(artifact.id, artifact);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function evaluateCondition6(row, coverage) {
  const artifacts = collectRowArtifacts(row, coverage);
  if (artifacts.length === 0) {
    return {
      state: "gap",
      evidence: "no experiment artifact routed to a row claim or linked from the row",
    };
  }
  const assessed = artifacts.map((artifact) => ({
    artifact,
    missing4: REQUIRED_FACET_IDS.filter((id) => artifact.missingFacets.includes(id)),
  }));
  const passing = assessed.filter((entry) => entry.missing4.length === 0);
  if (passing.length > 0) {
    const items = passing.map(({ artifact }) => `${artifact.id} ([${artifact.path}](../${artifact.path}))`);
    return { state: "holds", evidence: formatCapped(items, ", ") };
  }
  const items = assessed.map(({ artifact, missing4 }) => {
    const labels = missing4.map((id) => coverage.facetLabels.get(id)).join("; ");
    return `[${artifact.id}](../${artifact.path}) missing ${labels}`;
  });
  return { state: "gap", evidence: formatCapped(items, "; ") };
}

function evaluateCondition7(row, rowClaims) {
  const rawSources = [
    ...row.sources,
    ...rowClaims.flatMap((claim) => claim.primarySources),
  ];
  const uniqueSources = uniqueItems(rawSources.map(normalizeSourceDisplay));
  if (uniqueSources.length === 0) {
    return { state: "holds", evidence: "no row cell or primary-source field cites sources/" };
  }
  return {
    state: "gap",
    evidence: formatCapped(uniqueSources.map((src) => `\`${src}\``), ", "),
  };
}

function evaluateDomains(pSet, inventoryRows) {
  if (pSet.size === 0) return { domains: [], domainsCell: "0" };
  const matched = inventoryRows.filter((inv) => inv.bundles.some((b) => pSet.has(b)));
  if (matched.length === 0) return { domains: [], domainsCell: "0" };
  const counts = { audited: 0, partial: 0, queued: 0 };
  for (const inv of matched) counts[inv.state] += 1;
  return {
    domains: matched.map(({ domain, state }) => ({ domain, state })),
    domainsCell: `${matched.length} (${counts.audited}/${counts.partial}/${counts.queued})`,
  };
}

function resolveRowClaims(row, claimsMap) {
  return row.claims.map((claimId) => {
    const claim = claimsMap.get(claimId);
    if (!claim) throw new Stage0Error("research/adoption-matrix.md", `unknown claim ${claimId}`);
    return claim;
  });
}

function resolveRowChapters(row, rowClaims, chaptersByClaim) {
  const usedBy = rowClaims.flatMap((claim) => claim.chapters);
  const linking = row.claims.flatMap((claimId) => chaptersByClaim?.get(claimId) ?? []);
  return uniqueItems([...usedBy, ...linking]).sort();
}

export function evaluateMechanism(row, context) {
  const rowClaims = resolveRowClaims(row, context.claims);
  const chapters = resolveRowChapters(row, rowClaims, context.chaptersByClaim);
  const principlesByClaim = resolvePrincipleMap(context);
  const heldCandidates = context.heldCandidates ?? [];
  const inventoryRows = Array.isArray(context.inventory)
    ? context.inventory
    : (context.inventory?.rows ?? []);
  const coverage = indexTestCoverage(context.testCoverage);

  const c1 = evaluateCondition1(rowClaims);
  const c2 = evaluateCondition2(row.analogues);
  const { result: c3, pSet } = evaluateCondition3(row, principlesByClaim, heldCandidates);
  const c4 = evaluateCondition4(chapters);
  const c5 = evaluateCondition5(chapters, context.chapterEquations);
  const c6 = evaluateCondition6(row, coverage);
  const c7 = evaluateCondition7(row, rowClaims);
  const { domains, domainsCell } = evaluateDomains(pSet, inventoryRows);

  return {
    mechanism: row.mechanism,
    disposition: row.disposition,
    conditions: [c1, c2, c3, c4, c5, c6, c7],
    domains,
    domainsCell,
  };
}

function escapeCell(value) {
  return String(value).replace(/\r?\n/gu, " ").replaceAll("|", "\\|").trim();
}

function renderIntroAndStates() {
  return [
    "# Stage-0 condition report",
    "",
    "This report applies the seven Stage-0 conditions of the [research roadmap](../concept/90-research-roadmap.md) to each mechanism row of the [adoption matrix](adoption-matrix.md) and maps mechanisms to the [domain inventory](domain-inventory.md) through `P-` bundles. It records operational progress only: a cell that holds passed a structural repository check, promotes no claim, and is not a scientific result. The extraction and evaluation rules are specified in [Decision 0134](../decisions/0134-report-stage-0-conditions-per-mechanism.md).",
    "",
    "Generated by `scripts/generate-stage0-conditions.mjs`; edit the sources and run `npm run generate:stage0-conditions`.",
    "",
    "## States",
    "",
    "| State | Meaning |",
    "| --- | --- |",
    "| holds | The structural repository rule for this condition is satisfied by the linked records. |",
    "| gap | The structural repository rule is evaluable and a required link, key, or protocol facet is absent or violated. |",
    "| open | No repository rule decides the semantic requirement; linked records are reported for human review. |",
  ];
}

function renderConditionsTable() {
  const rows = CONDITION_RULES.map((entry) =>
    `| ${entry.num} | ${escapeCell(entry.roadmap)} | ${escapeCell(entry.rule)} | ${escapeCell(entry.limit)} |`,
  );
  return [
    "## Conditions and rules",
    "",
    "| # | Roadmap condition | Rule | Limit |",
    "| ---: | --- | --- | --- |",
    ...rows,
  ];
}

function renderSummarySection(evaluations, skippedInventoryRows) {
  const rows = CONDITION_RULES.map((entry, idx) => {
    const counts = { holds: 0, gap: 0, open: 0 };
    for (const evaluation of evaluations) {
      counts[evaluation.conditions[idx].state] += 1;
    }
    return `| ${escapeCell(entry.summaryLabel)} | ${counts.holds} | ${counts.gap} | ${counts.open} |`;
  });
  return [
    "## Summary",
    "",
    "| Condition | holds | gap | open |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
    "",
    `Evaluated ${evaluations.length} mechanisms from the adoption matrix across the seven Stage-0 conditions; ${skippedInventoryRows} wider-horizon domain-family rows in the domain inventory have no \`P-\` bundle column and are skipped.`,
  ];
}

function renderMatrixSection(evaluations) {
  const rows = evaluations.map((evaluation, index) => {
    const states = evaluation.conditions.map((c) => c.state).join(" | ");
    return `| ${index + 1} | ${escapeCell(evaluation.mechanism)} | ${escapeCell(evaluation.disposition)} | ${states} | ${escapeCell(evaluation.domainsCell)} |`;
  });
  return [
    "## Mechanism matrix",
    "",
    "| # | Mechanism | Disposition | 1 | 2 | 3 | 4 | 5 | 6 | 7 | Domains |",
    "| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ];
}

function renderEvidenceSection(evaluations) {
  const lines = ["## Evidence by mechanism"];
  for (let index = 0; index < evaluations.length; index += 1) {
    const evaluation = evaluations[index];
    lines.push("", `### ${index + 1}. ${evaluation.mechanism}`, "");
    for (let condIndex = 0; condIndex < evaluation.conditions.length; condIndex += 1) {
      const cond = evaluation.conditions[condIndex];
      lines.push(`- ${condIndex + 1} ${cond.state}: ${cond.evidence}`);
    }
    const domainText = evaluation.domains.length === 0
      ? "none"
      : evaluation.domains.map((d) => `${d.domain} (${d.state})`).join(", ");
    lines.push(`- domains: ${domainText}`);
  }
  return lines;
}

export function renderReport(input, options = {}) {
  const evaluations = Array.isArray(input) ? input : (input?.evaluations ?? []);
  const skippedInventoryRows = Array.isArray(input)
    ? (options.skippedInventoryRows ?? 0)
    : (input?.skippedInventoryRows ?? 0);
  const sections = [
    ...renderIntroAndStates(),
    "",
    ...renderConditionsTable(),
    "",
    ...renderSummarySection(evaluations, skippedInventoryRows),
    "",
    ...renderMatrixSection(evaluations),
    "",
    ...renderEvidenceSection(evaluations),
  ];
  const output = `${sections.join("\n")}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) {
    throw new Stage0Error(
      "research/stage0-conditions.md",
      `rendered report exceeds ${MAX_REPORT_BYTES}-byte limit`,
    );
  }
  return output;
}
