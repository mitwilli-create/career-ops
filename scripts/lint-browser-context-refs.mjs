#!/usr/bin/env node
// scripts/lint-browser-context-refs.mjs
//
// Catches the "client-side-reference-to-server-side-import" bug class.
// For each inline <script> block in the built HTML, walks the AST and asserts
// every bare-identifier-callee references EITHER:
//   - a name defined in any inline <script> block (shared window scope)
//   - a name defined in the same block's local scope (function params, locals)
//   - a known browser global (window, document, JSON, parseInt, etc.)
//   - an underscore-prefixed shared helper (project convention)
//
// Uses TWO passes:
//   Pass 1: collect every top-level identifier defined across all inline blocks
//   Pass 2: verify every bare-identifier CallExpression resolves
//
// Exits 1 if any unresolved identifier reference is found.
//
// Usage:
//   node scripts/lint-browser-context-refs.mjs <html-file>

import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: lint-browser-context-refs.mjs <html-file>');
  process.exit(2);
}

let html;
try {
  html = readFileSync(FILE, 'utf-8');
} catch (e) {
  console.error(`✗ lint-browser-context-refs: cannot read ${FILE}: ${e.message}`);
  process.exit(2);
}

// Known-safe browser globals + common ES built-ins + UMD/AMD conventions.
const BROWSER_GLOBALS = new Set([
  // Window + DOM
  'window', 'document', 'navigator', 'location', 'history', 'screen',
  'console', 'fetch', 'XMLHttpRequest', 'FormData', 'URL', 'URLSearchParams',
  'Headers', 'Request', 'Response', 'Blob', 'File', 'FileReader',
  'AbortController', 'AbortSignal',
  'localStorage', 'sessionStorage', 'indexedDB',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  'queueMicrotask', 'structuredClone', 'getComputedStyle', 'matchMedia',
  'alert', 'confirm', 'prompt', 'open', 'close', 'print',
  'scroll', 'scrollTo', 'scrollBy', 'scrollX', 'scrollY',
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight',
  // Events
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'TouchEvent',
  'PointerEvent', 'WheelEvent', 'FocusEvent', 'InputEvent',
  'IntersectionObserver', 'MutationObserver', 'ResizeObserver', 'PerformanceObserver',
  // ES built-ins
  'JSON', 'Math', 'Number', 'String', 'Array', 'Object', 'Boolean', 'Date', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'encodeURIComponent',
  'decodeURI', 'decodeURIComponent', 'btoa', 'atob', 'crypto', 'TextEncoder', 'TextDecoder',
  'BigInt', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'SharedArrayBuffer',
  // Special identifiers
  'globalThis', 'event', 'undefined', 'NaN', 'Infinity', 'arguments',
  // SSE / networking
  'EventSource', 'WebSocket',
  // UMD / AMD module conventions (typical guarded with `typeof define === 'function'`)
  'define', 'require', 'module', 'exports',
  // Common third-party UMD globals
  'marked', 'DOMPurify', 'Chart', 'Plotly', 'd3',
]);

// Extract every inline <script> block. Returns [{ idx, attrs, body, blockOffset }]
function extractScripts(html) {
  const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;
  const blocks = [];
  let idx = 0;
  for (const m of html.matchAll(SCRIPT_RE)) {
    idx++;
    const attrs = m[1] || '';
    const body = m[2];
    if (!body.trim()) continue;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/\btype\s*=\s*["']?(application\/(ld\+)?json|text\/(template|html))/i.test(attrs)) continue;
    blocks.push({ idx, attrs, body });
  }
  return blocks;
}

function parseBlock(body) {
  try {
    return parse(body, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowHashBang: true,
      locations: true,
    });
  } catch (_) {
    // Syntax errors are caught by lint-built-html-js.mjs (single responsibility).
    return null;
  }
}

function collectTopLevelNames(ast) {
  const names = new Set();
  if (!ast) return names;
  // Only iterate the TOP-LEVEL body (function bodies / inner blocks don't share window scope).
  for (const node of ast.body) {
    switch (node.type) {
      case 'FunctionDeclaration':
        if (node.id) names.add(node.id.name);
        break;
      case 'ClassDeclaration':
        if (node.id) names.add(node.id.name);
        break;
      case 'VariableDeclaration':
        for (const d of node.declarations) collectPatternNames(d.id, names);
        break;
      case 'ExpressionStatement': {
        // Detect `window.X = ...` and `globalThis.X = ...` assignments — these
        // define a shared global.
        const e = node.expression;
        if (e && e.type === 'AssignmentExpression' && e.operator === '=' &&
            e.left.type === 'MemberExpression' &&
            !e.left.computed &&
            e.left.object.type === 'Identifier' &&
            (e.left.object.name === 'window' || e.left.object.name === 'globalThis') &&
            e.left.property.type === 'Identifier') {
          names.add(e.left.property.name);
        }
        break;
      }
    }
  }
  return names;
}

// Collect every identifier that appears as a member of `window` ANYWHERE in the
// AST. Catches runtime-attached globals like `window.showToast = ...` even when
// the assignment is nested inside a function/IIFE/conditional. Runtime: the
// assignment WILL execute when its container runs, so the global becomes
// available cross-block. This is the correct semantic for "is X reachable as
// a bare call at runtime?"
function collectWindowMemberNames(ast) {
  const names = new Set();
  if (!ast) return names;
  walk.full(ast, (node) => {
    if (node.type === 'MemberExpression' &&
        !node.computed &&
        node.object.type === 'Identifier' &&
        (node.object.name === 'window' || node.object.name === 'globalThis') &&
        node.property.type === 'Identifier') {
      names.add(node.property.name);
    }
  });
  return names;
}

// Per-block: collect every identifier tested via `typeof X`. These are flagged
// as "guarded-at-runtime" — bare calls to X within this block are skipped from
// violation reporting because the developer has shown awareness of X's possible
// non-existence (defensive pattern: `if (typeof X === 'function') X();`).
//
// This is a known under-fire mode: a developer who writes `typeof X; X();` (without
// branching) gets a free pass even though `X();` will throw. Accept this for
// reduced noise on the dashboard's pervasive typeof-guard idiom.
function collectTypeofGuards(ast) {
  const names = new Set();
  if (!ast) return names;
  walk.simple(ast, {
    UnaryExpression(node) {
      if (node.operator === 'typeof' &&
          node.argument.type === 'Identifier') {
        names.add(node.argument.name);
      }
    },
  });
  return names;
}

function collectAllBindings(ast) {
  // Collect every binding (top-level + nested) for the per-block walker.
  // Used to detect "is the call to bar() resolvable inside this block?"
  const names = new Set();
  if (!ast) return names;
  walk.full(ast, (node) => {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) names.add(node.id.name);
        for (const p of node.params) collectPatternNames(p, names);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) names.add(node.id.name);
        break;
      case 'VariableDeclarator':
        collectPatternNames(node.id, names);
        break;
      case 'CatchClause':
        if (node.param) collectPatternNames(node.param, names);
        break;
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        if (node.local) names.add(node.local.name);
        break;
    }
  });
  return names;
}

function findUnresolvedCalls(ast, blockBindings, sharedGlobals, blockTypeofGuards) {
  const violations = [];
  if (!ast) return violations;
  walk.simple(ast, {
    CallExpression(node) {
      if (node.callee.type !== 'Identifier') return;
      const name = node.callee.name;
      if (blockBindings.has(name)) return;
      if (sharedGlobals.has(name)) return;
      if (BROWSER_GLOBALS.has(name)) return;
      if (blockTypeofGuards.has(name)) return;
      if (name.startsWith('_')) return;
      violations.push({ name, line: node.loc?.start?.line ?? null });
    },
  });
  return violations;
}

function collectPatternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.add(node.name);
      return;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'Property') collectPatternNames(p.value, out);
        else if (p.type === 'RestElement') collectPatternNames(p.argument, out);
      }
      return;
    case 'ArrayPattern':
      for (const e of node.elements) if (e) collectPatternNames(e, out);
      return;
    case 'AssignmentPattern':
      collectPatternNames(node.left, out);
      return;
    case 'RestElement':
      collectPatternNames(node.argument, out);
      return;
  }
}

// --- main ---
const blocks = extractScripts(html);

// Pass 1: parse every block, collect TOP-LEVEL identifier definitions across
// all blocks. ALSO collect every `window.X` reference across all blocks (these
// are runtime-attached globals reachable as bare calls, e.g. window.showToast).
const parsed = blocks.map(b => ({ ...b, ast: parseBlock(b.body) }));
const sharedGlobals = new Set();
for (const b of parsed) {
  for (const n of collectTopLevelNames(b.ast)) sharedGlobals.add(n);
  for (const n of collectWindowMemberNames(b.ast)) sharedGlobals.add(n);
}

// Pass 2: per block, collect all bindings + typeof-guard set + check for
// unresolved call references.
let totalViolations = 0;
const allViolations = [];
for (const b of parsed) {
  if (!b.ast) continue;
  const blockBindings = collectAllBindings(b.ast);
  const blockTypeofGuards = collectTypeofGuards(b.ast);
  const violations = findUnresolvedCalls(b.ast, blockBindings, sharedGlobals, blockTypeofGuards);
  if (violations.length > 0) {
    totalViolations += violations.length;
    allViolations.push({ blockIdx: b.idx, violations });
  }
}

if (totalViolations > 0) {
  console.error(`✗ lint-browser-context-refs: ${totalViolations} unresolved identifier reference(s) across ${allViolations.length} <script> block(s)`);
  for (const { blockIdx, violations } of allViolations.slice(0, 5)) {
    console.error(`  block ${blockIdx}:`);
    // Deduplicate by name+line for readability
    const seen = new Set();
    let printed = 0;
    for (const v of violations) {
      const key = `${v.name}:${v.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (printed >= 10) break;
      console.error(`    ${v.name}() at script-relative line ${v.line ?? '?'}`);
      printed++;
    }
    const remainingUnique = new Set(violations.map(v => `${v.name}:${v.line}`)).size - printed;
    if (remainingUnique > 0) console.error(`    ... and ${remainingUnique} more unique site(s)`);
  }
  console.error('');
  console.error('  Bug class: client-side-reference-to-server-side-import');
  console.error('  See AGENTS.md § Bug class: client-side-reference-to-server-side-import');
  console.error('  Fix: define the identifier inside an inline <script> block (or window.X = ...),');
  console.error('       OR add to BROWSER_GLOBALS whitelist if it is a real global,');
  console.error('       OR rename to start with _ if it is a shared helper.');
  process.exit(1);
}

console.log(`✓ lint-browser-context-refs: ${blocks.length} <script> block(s) scanned, all identifier references resolved cleanly.`);
console.log(`  (shared scope: ${sharedGlobals.size} top-level definitions across all blocks)`);
