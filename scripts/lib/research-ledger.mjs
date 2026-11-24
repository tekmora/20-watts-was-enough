import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { createMdastTools } from "./mdast-claims.mjs";

const PRINCIPLE_REGISTRY_FILE = "research/principle-registry.md";
const PRINCIPLE_HEADING_RE = /^(P-\d{3})\s*—\s*(.+)$/u;

export class PrincipleRegistryError extends Error {
  constructor(file, message, options) {
    super(message, options);
    this.name = "PrincipleRegistryError";
    this.file = file;
  }
}

const parser = unified().use(remarkParse).use(remarkGfm);
const { walkAst, nodeText, collectSiblingClaims, resolveLinkReferences } = createMdastTools(
  PrincipleRegistryError,
  { strict: false },
);

export function parseClaimLedger(text) {
  const matches = [...text.matchAll(/^### (C-\d{3,4})\s*\r?\n([\s\S]*?)(?=^### C-|(?![\s\S]))/gm)];
  return matches.map(match => {
    const id = match[1];
    const body = match[2];
    const statusMatch = body.match(/^- \*\*Status:\*\*\s*([^\s,.;]+)/m);
    const status = statusMatch ? statusMatch[1].toLowerCase() : "unknown";
    const statementMatch = body.match(/^- \*\*(?:Statement|Claim):\*\*\s*([\s\S]*?)(?=^- \*\*|^\s*$)/m);
    let statement = null;
    if (statementMatch) {
      statement = statementMatch[1].replace(/\s+/g, ' ').trim();
    }
    return { id, status, statement, body };
  });
}

function buildPrincipleAnchor(id, title) {
  return `${id} — ${title}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}

function openPrincipleSection(node) {
  if (node.depth !== 2) return null;
  const match = PRINCIPLE_HEADING_RE.exec(nodeText(node, PRINCIPLE_REGISTRY_FILE));
  if (!match) return null;
  const id = match[1];
  const title = match[2].trim();
  return {
    id,
    title,
    anchor: buildPrincipleAnchor(id, title),
    claims: [],
  };
}

function collectSectionNodeClaims(sectionNode, claims) {
  walkAst(sectionNode, PRINCIPLE_REGISTRY_FILE, (node) => {
    if (Array.isArray(node.children)) {
      collectSiblingClaims(node.children, claims, "claims.md", PRINCIPLE_REGISTRY_FILE);
    }
  });
}

export function parsePrincipleRegistry(text) {
  const tree = parser.parse(text);
  resolveLinkReferences(tree, PRINCIPLE_REGISTRY_FILE);
  const sections = [];
  let current = null;
  for (const node of tree.children) {
    if (node.type === "heading" && node.depth <= 2) {
      current = openPrincipleSection(node);
      if (current) sections.push(current);
    } else if (current) {
      collectSectionNodeClaims(node, current.claims);
    }
  }
  return sections.map(({ id, title, anchor, claims }) => ({
    id,
    title,
    anchor,
    claims: [...new Set(claims)].sort(),
  }));
}

export function parseCandidateIndex(text) {
  const matches = [...text.matchAll(/^\|\s*(\d{3,4})\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+)\s*\|/gm)];
  return matches.map(m => ({
    id: m[1],
    title: m[2].trim(),
    question: m[4].trim(),
    path: `experiments/candidates/${m[3]}`
  }));
}

export function parseFixtureIndex(text) {
  const matches = [...text.matchAll(/^\|\s*(F-\d{3,4})\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|/gm)];
  return matches.map(m => ({
    id: m[1],
    title: m[2].trim(),
    path: `experiments/fixtures/${m[3]}`
  }));
}
