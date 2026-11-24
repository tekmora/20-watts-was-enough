const MAX_AST_NODES = 200_000;
const MAX_CLAIM_RANGE_WIDTH = 200;
const CLAIM_ANCHOR_RE = /^#c-(\d{1,4})$/u;
const CLAIM_LABEL_RE = /^C-(\d{1,4})$/iu;

function pushChildren(stack, children, visited, file, ErrorType) {
  if (!Array.isArray(children)) return;
  if (visited + stack.length + children.length > MAX_AST_NODES) {
    throw new ErrorType(file, `mdast node limit (${MAX_AST_NODES}) exceeded`);
  }
  for (let index = children.length - 1; index >= 0; index -= 1) {
    stack.push(children[index]);
  }
}

function walkAst(root, file, visitor, ErrorType) {
  if (!root || typeof root !== "object") {
    throw new ErrorType(file, "invalid mdast node");
  }
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= MAX_AST_NODES) {
      throw new ErrorType(file, `mdast node limit (${MAX_AST_NODES}) exceeded`);
    }
    visited += 1;
    const node = stack.pop();
    if (!node || typeof node !== "object") {
      throw new ErrorType(file, "invalid mdast child node");
    }
    visitor(node);
    pushChildren(stack, node.children, visited, file, ErrorType);
  }
}

function nodeText(node, file, ErrorType) {
  const parts = [];
  walkAst(node, file, (current) => {
    if (current.type === "text" || current.type === "inlineCode") {
      parts.push(String(current.value ?? ""));
    }
  }, ErrorType);
  return parts.join("").replace(/\s+/gu, " ").trim();
}

function collectDefinitions(root, file, ErrorType) {
  const definitions = new Map();
  walkAst(root, file, (node) => {
    if (node.type !== "definition") return;
    if (typeof node.identifier !== "string" || typeof node.url !== "string") return;
    if (!definitions.has(node.identifier)) {
      definitions.set(node.identifier, { url: node.url, title: node.title ?? null });
    }
  }, ErrorType);
  return definitions;
}

function toResolvedLink(refNode, definitions, file, ErrorType) {
  const def = typeof refNode.identifier === "string"
    ? definitions.get(refNode.identifier)
    : undefined;
  if (!def) {
    const label = refNode.label || refNode.identifier || "";
    throw new ErrorType(file, `undefined link reference "${label}"`);
  }
  return {
    type: "link",
    url: def.url,
    title: def.title,
    children: Array.isArray(refNode.children) ? refNode.children : [],
    position: refNode.position,
  };
}

function resolveLinkReferences(root, file, ErrorType) {
  const definitions = collectDefinitions(root, file, ErrorType);
  walkAst(root, file, (node) => {
    if (!Array.isArray(node.children)) return;
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      if (child && child.type === "linkReference") {
        node.children[index] = toResolvedLink(child, definitions, file, ErrorType);
      }
    }
  }, ErrorType);
}

function formatClaimId(num) {
  return `C-${String(num).padStart(3, "0")}`;
}

function matchesClaimLabel(label, num, id, file, ctx) {
  if (ctx.strict) {
    if (label.toUpperCase() !== id) {
      throw new ctx.ErrorType(file, `claim link label "${label}" does not match ${id}`);
    }
    return true;
  }
  const labelMatch = CLAIM_LABEL_RE.exec(label);
  return Boolean(labelMatch) && Number(labelMatch[1]) === num;
}

function parseClaimLink(node, base, file, ctx) {
  if (!node || node.type !== "link" || typeof node.url !== "string") return null;
  if (!node.url.startsWith(`${base}#`)) return null;
  const match = CLAIM_ANCHOR_RE.exec(node.url.slice(base.length));
  if (!match) {
    if (!ctx.strict) return null;
    throw new ctx.ErrorType(file, `malformed claim link "${node.url}"`);
  }
  const num = Number(match[1]);
  const id = formatClaimId(num);
  const label = nodeText(node, file, ctx.ErrorType);
  if (!matchesClaimLabel(label, num, id, file, ctx)) return null;
  return { id, num };
}

function isRangeSeparator(node) {
  if (!node || node.type !== "text" || typeof node.value !== "string") return false;
  const trimmed = node.value.trim();
  return trimmed === "–" || trimmed === "-";
}

function expandClaimRange(start, end, file, ErrorType) {
  if (start.num > end.num) {
    throw new ErrorType(file, `reversed claim range ${start.id}–${end.id}`);
  }
  const width = end.num - start.num + 1;
  if (width > MAX_CLAIM_RANGE_WIDTH) {
    throw new ErrorType(
      file,
      `claim range ${start.id}–${end.id} width ${width} exceeds ${MAX_CLAIM_RANGE_WIDTH}`,
    );
  }
  const expanded = [];
  for (let current = start.num; current <= end.num; current += 1) {
    expanded.push(formatClaimId(current));
  }
  return expanded;
}

function collectSiblingClaims(children, claims, base, file, ctx) {
  if (children.length > MAX_AST_NODES) {
    throw new ctx.ErrorType(file, `mdast node limit (${MAX_AST_NODES}) exceeded`);
  }
  let index = 0;
  while (index < children.length) {
    const start = parseClaimLink(children[index], base, file, ctx);
    if (!start) {
      index += 1;
      continue;
    }
    const end = isRangeSeparator(children[index + 1])
      ? parseClaimLink(children[index + 2], base, file, ctx)
      : null;
    if (end && (ctx.strict || start.num <= end.num)) {
      claims.push(...expandClaimRange(start, end, file, ctx.ErrorType));
      index += 3;
    } else {
      claims.push(start.id);
      index += 1;
    }
  }
}

export function createMdastTools(ErrorType, options = {}) {
  const ctx = { ErrorType, strict: options.strict ?? true };
  return {
    walkAst: (root, file, visitor) => walkAst(root, file, visitor, ErrorType),
    nodeText: (node, file) => nodeText(node, file, ErrorType),
    collectSiblingClaims: (children, claims, base, file) =>
      collectSiblingClaims(children, claims, base, file, ctx),
    resolveLinkReferences: (root, file) => resolveLinkReferences(root, file, ErrorType),
  };
}
