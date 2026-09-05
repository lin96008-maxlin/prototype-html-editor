import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, parse as parsePath, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJavaScript } from "acorn";
import { parse } from "parse5";

type Platform = "web" | "mobile";
type Confidence = "high" | "medium";

export interface ElementTarget {
  heId?: string;
  existingId?: string;
  domPath: number[];
  runtimePageId?: string;
  runtimeScope?: "page" | "global";
  runtimePath?: number[];
  runtimeRootSelector?: string;
  tagName: string;
  originalText?: string;
  sourceAttributes?: Record<string, string>;
}

export interface EditorPatch {
  type: "set-attribute" | "set-inner-html" | "delete-element" | "insert-after" | "insert-inside";
  target: ElementTarget;
  name?: string;
  value?: string | null;
  html?: string;
  before?: string | null;
  after?: string | null;
}

export interface EditorCommand {
  id: string;
  label: string;
  pageId: string;
  patches: EditorPatch[];
  createdAt: string;
}

export interface PageDefinition {
  id: string;
  title: string;
  scope: string;
  selector: string;
  key: string;
  source: string;
  confidence: Confidence;
  group?: string;
  rootSelector?: string;
  activeSelector?: string;
  openFunction?: string;
  template?: string;
}

export interface SurfaceDefinition {
  id: string;
  title: string;
  kind: "drawer" | "modal" | "popover" | "panel";
  pageId: string;
  parentId?: string;
  rootSelector: string;
  contentSelector?: string;
  openSelector?: string;
  openFunction?: string;
  openArgs?: unknown[];
  activeSelector?: string;
}

interface InspectionReport {
  status: "pass" | "warning" | "fail";
  sourcePath: string;
  sourceHash: string;
  platform: Platform;
  appRootCount: number;
  pages: PageDefinition[];
  surfaces: SurfaceDefinition[];
  warnings: string[];
  externalReferences: string[];
  analysis?: {
    method: "automatic" | "agent-map";
    logicalPageCount: number;
    templateScopes: string[];
    routeAttributes: string[];
    openFunctions: string[];
  };
}

interface PageMapRecord {
  schemaVersion: 1;
  sourceHash: string;
  source: "automatic" | "agent";
  createdAt: string;
  pages: PageDefinition[];
  surfaces?: SurfaceDefinition[];
}

interface SessionRecord {
  schemaVersion: 1;
  patchMode?: "source" | "runtime";
  sessionId: string;
  prototypeKey: string;
  sourcePath: string;
  sourceHash: string;
  platform: Platform;
  pages: PageDefinition[];
  surfaces: SurfaceDefinition[];
  commands: EditorCommand[];
  rejectedCommands?: Array<{ command: EditorCommand; reason: string; rejectedAt: string }>;
  cursor: number;
  ui: Record<string, unknown>;
  status: "active" | "applied" | "conflict";
  createdAt: string;
  updatedAt: string;
  outputPath?: string;
  lastError?: string;
  server?: { pid: number; url: string };
}

interface ManifestRecord {
  schemaVersion: 1;
  prototypeKey: string;
  sourcePath: string;
  activeSessionId: string | null;
  sessions: string[];
  server?: { pid: number; url: string; sessionId: string };
}

type ParseNode = {
  nodeName?: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParseNode[];
  parentNode?: ParseNode;
  value?: string;
  sourceCodeLocation?: any;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const ALLOWED_PATCHES = new Set(["set-attribute", "set-inner-html", "delete-element", "insert-after", "insert-inside"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const runtimeDir = dirname(fileURLToPath(import.meta.url));
const editorAppDir = resolve(runtimeDir, "../assets/editor-app");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
  return resolve(value).replaceAll("\\", "/");
}

function prototypeKey(sourcePath: string): string {
  return sha256(normalizePath(sourcePath).toLowerCase()).slice(0, 16);
}

function sessionRoot(sourcePath: string): string {
  return join(dirname(sourcePath), ".html-editor", prototypeKey(sourcePath));
}

function manifestPath(sourcePath: string): string {
  return join(sessionRoot(sourcePath), "manifest.json");
}

function sessionPath(sourcePath: string, sessionId: string): string {
  return join(sessionRoot(sourcePath), "sessions", `${sessionId}.json`);
}

function pageMapPath(sourcePath: string): string {
  return join(sessionRoot(sourcePath), "page-map.json");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function attr(node: ParseNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value;
}

function elementChildren(node: ParseNode): ParseNode[] {
  return (node.childNodes || []).filter((child) => Boolean(child.tagName));
}

function walk(node: ParseNode, visitor: (node: ParseNode) => void): void {
  if (node.tagName) visitor(node);
  for (const child of node.childNodes || []) walk(child, visitor);
}

function nodeText(node: ParseNode): string {
  let value = "";
  const collect = (current: ParseNode): void => {
    if (current.nodeName === "#text" && current.value) value += ` ${current.value}`;
    for (const child of current.childNodes || []) collect(child);
  };
  collect(node);
  return value.replace(/\s+/g, " ").trim();
}

function escapeSelector(value: string): string {
  return value.replaceAll('"', '\\"');
}

function titleFromNode(node: ParseNode, fallback: string): string {
  const direct = attr(node, "data-title") || attr(node, "aria-label") || attr(node, "title");
  if (direct?.trim()) return direct.trim();
  const candidates = (node.childNodes || []).flatMap((child) => {
    const named: ParseNode[] = [];
    const headings: ParseNode[] = [];
    walk(child, (item) => {
      const classes = new Set((attr(item, "class") || "").split(/\s+/));
      if (attr(item, "data-page-title") !== undefined || ["page-title", "nav-title", "screen-title", "content-title"].some((name) => classes.has(name))) named.push(item);
      else if (/^h[1-3]$/.test(item.tagName || "")) headings.push(item);
    });
    return [...named, ...headings];
  });
  const heading = candidates[0];
  return nodeText(heading || node).slice(0, 40) || fallback;
}

function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim() || "未命名页面";
}

function pageBase(scope: string): string {
  const parts = scope.split(":");
  return parts[0] === "page" ? (parts[1] || "main") : scope;
}

type RouteManifestEntry = { key: string; title: string; group?: string; template?: string };

function scriptContent(node: ParseNode): string {
  return (node.childNodes || []).filter((child) => child.nodeName === "#text").map((child) => child.value || "").join("");
}

function walkJavaScript(node: any, visitor: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc", "range"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walkJavaScript(child, visitor));
    else if (value && typeof value === "object" && typeof (value as any).type === "string") walkJavaScript(value, visitor);
  }
}

function propertyName(node: any): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && ["string", "number"].includes(typeof node.value)) return String(node.value);
  return undefined;
}

function literalString(node: any): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function objectString(node: any, names: string[]): string | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  for (const property of node.properties || []) {
    if (property.type !== "Property" || !names.includes(propertyName(property.key) || "")) continue;
    const value = literalString(property.value);
    if (value) return value;
  }
  return undefined;
}

function objectProperty(node: any, names: string[]): any {
  if (node?.type !== "ObjectExpression") return undefined;
  return (node.properties || []).find((property: any) => property.type === "Property" && names.includes(propertyName(property.key) || ""))?.value;
}

function analyzeJavaScriptRoutes(document: ParseNode): { entries: RouteManifestEntry[]; openFunctions: string[] } {
  const entries = new Map<string, RouteManifestEntry>();
  const openFunctions = new Set<string>();
  const routeVariable = /(?:^|_)(?:pages?|routes?|screens?|views?|pageMap|routeMap|pageMeta)$/i;
  walk(document, (node) => {
    if (node.tagName !== "script" || attr(node, "src")) return;
    const source = scriptContent(node).trim();
    if (!source) return;
    let program: any;
    try {
      program = parseJavaScript(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
    } catch {
      try {
        program = parseJavaScript(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
      } catch {
        return;
      }
    }
    walkJavaScript(program, (current) => {
      if (current.type === "FunctionDeclaration" && /^(?:openPage|showPage|switchPage|renderPage|navigate|goTo|goToPage|setPage)$/i.test(current.id?.name || "")) openFunctions.add(current.id.name);
      if (current.type === "VariableDeclarator" && current.id?.type === "Identifier" && /^(?:openPage|showPage|switchPage|renderPage|navigate|goTo|goToPage|setPage)$/i.test(current.id.name) && ["ArrowFunctionExpression", "FunctionExpression"].includes(current.init?.type)) openFunctions.add(current.id.name);
      if (current.type === "VariableDeclarator" && current.id?.type === "Identifier" && /^(?:groups|menuGroups|navigationGroups)$/i.test(current.id.name) && current.init?.type === "ArrayExpression") {
        for (const groupNode of current.init.elements || []) {
          if (groupNode?.type !== "ObjectExpression") continue;
          const group = objectString(groupNode, ["title", "label", "name"]);
          const items = objectProperty(groupNode, ["items", "pages", "routes", "children"]);
          if (!group || items?.type !== "ArrayExpression") continue;
          for (const item of items.elements || []) {
            if (item?.type === "ArrayExpression") {
              const key = literalString(item.elements?.[0]);
              const title = literalString(item.elements?.[1]);
              if (key && title) entries.set(key, { key, title, group });
            } else if (item?.type === "ObjectExpression") {
              const key = objectString(item, ["id", "key", "route", "page"]);
              const title = objectString(item, ["title", "label", "name"]);
              if (key && title) entries.set(key, { key, title, group, template: objectString(item, ["scope", "template", "view"]) });
            }
          }
        }
      }
      if (current.type !== "VariableDeclarator" || current.id?.type !== "Identifier" || !routeVariable.test(current.id.name)) return;
      if (current.init?.type === "ObjectExpression") {
        for (const property of current.init.properties || []) {
          if (property.type !== "Property" || property.value?.type !== "ObjectExpression") continue;
          const key = propertyName(property.key);
          const title = objectString(property.value, ["title", "label", "name"]);
          if (!key || !title) continue;
          entries.set(key, {
            key,
            title,
            group: objectString(property.value, ["group", "category", "section", "module"]),
            template: objectString(property.value, ["scope", "template", "view", "screen"]),
          });
        }
      } else if (current.init?.type === "ArrayExpression") {
        for (const item of current.init.elements || []) {
          if (item?.type !== "ObjectExpression") continue;
          const key = objectString(item, ["id", "key", "route", "path"]);
          const title = objectString(item, ["title", "label", "name"]);
          if (!key || !title) continue;
          entries.set(key, {
            key,
            title,
            group: objectString(item, ["group", "category", "section", "module"]),
            template: objectString(item, ["scope", "template", "view", "screen"]),
          });
        }
      }
    });
  });
  return { entries: [...entries.values()], openFunctions: [...openFunctions] };
}

type ScriptSurfaceEvidence = {
  targetsByFunction: Map<string, Set<string>>;
  openerIdsByFunction: Map<string, Set<string>>;
  dynamicOpeners: Array<{ functionName: string; value?: string; openerId?: string; openerSelector?: string }>;
};

function analyzeJavaScriptSurfaces(document: ParseNode): ScriptSurfaceEvidence {
  const targetsByFunction = new Map<string, Set<string>>();
  const openerIdsByFunction = new Map<string, Set<string>>();
  const dynamicOpeners: ScriptSurfaceEvidence["dynamicOpeners"] = [];
  const domId = (expression: any, variables = new Map<string, string>()): string | undefined => {
    if (!expression) return undefined;
    if (expression.type === "Identifier") return variables.get(expression.name);
    if (expression.type === "CallExpression" && expression.callee?.type === "MemberExpression") {
      const method = propertyName(expression.callee.property);
      const value = literalString(expression.arguments?.[0]);
      if (method === "getElementById" && value) return value;
      if (method === "querySelector" && value?.startsWith("#") && /^[#][A-Za-z0-9_-]+$/.test(value)) return value.slice(1);
    }
    if (expression.type === "MemberExpression") return domId(expression.object, variables);
    return undefined;
  };
  const calledFunction = (expression: any): string | undefined => {
    if (!expression) return undefined;
    if (expression.type === "Identifier") return expression.name;
    if (expression.type === "CallExpression" && expression.callee?.type === "Identifier") return expression.callee.name;
    if (["ArrowFunctionExpression", "FunctionExpression"].includes(expression.type)) {
      let result: string | undefined;
      walkJavaScript(expression.body, (node) => {
        if (!result && node.type === "CallExpression" && node.callee?.type === "Identifier") result = node.callee.name;
      });
      return result;
    }
    return undefined;
  };
  walk(document, (script) => {
    if (script.tagName !== "script" || attr(script, "src")) return;
    let ast: any;
    try {
      ast = parseJavaScript(scriptContent(script), { ecmaVersion: "latest", sourceType: "script", allowHashBang: true } as any);
    } catch {
      return;
    }
    walkJavaScript(ast, (node) => {
      let name: string | undefined;
      let body: any;
      if (node.type === "FunctionDeclaration") {
        name = node.id?.name;
        body = node.body;
      } else if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init?.type)) {
        name = node.id.name;
        body = node.init.body;
      }
      if (!name || !body || !/^(?:show|open|expand|present|display|launch)/i.test(name)) return;
      const variables = new Map<string, string>();
      walkJavaScript(body, (current) => {
        if (current.type !== "VariableDeclarator" || current.id?.type !== "Identifier") return;
        const target = domId(current.init, variables);
        if (target) variables.set(current.id.name, target);
      });
      const targets = targetsByFunction.get(name) || new Set<string>();
      walkJavaScript(body, (current) => {
        if (current.type === "CallExpression" && current.callee?.type === "MemberExpression") {
          const method = propertyName(current.callee.property);
          const target = domId(current.callee.object, variables);
          const attribute = literalString(current.arguments?.[0]);
          const value = literalString(current.arguments?.[1]);
          const opens = method === "showModal"
            || (method === "add" && current.callee.object?.property?.name === "classList")
            || (method === "setAttribute" && attribute === "aria-hidden" && value === "false");
          if (target && opens) targets.add(target);
        }
        if (current.type === "AssignmentExpression") {
          const target = domId(current.left, variables);
          const property = propertyName(current.left?.property);
          const value = current.right?.value;
          if (target && ((property === "hidden" && value === false) || (property === "display" && value !== "none") || (property === "visibility" && value !== "hidden"))) targets.add(target);
        }
      });
      if (targets.size) targetsByFunction.set(name, targets);
    });
    walkJavaScript(ast, (node) => {
      if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression" || propertyName(node.callee.property) !== "addEventListener" || literalString(node.arguments?.[0]) !== "click") return;
      const openerId = domId(node.callee.object);
      const functionName = calledFunction(node.arguments?.[1]);
      if (openerId && functionName && targetsByFunction.has(functionName)) {
        const ids = openerIdsByFunction.get(functionName) || new Set<string>();
        ids.add(openerId);
        openerIdsByFunction.set(functionName, ids);
      }
      const closestSelectors: string[] = [];
      walkJavaScript(node.arguments?.[1], (current) => {
        if (current.type === "CallExpression" && current.callee?.type === "MemberExpression" && propertyName(current.callee.property) === "closest") {
          const selector = literalString(current.arguments?.[0]);
          if (selector) closestSelectors.push(selector);
        }
      });
      walkJavaScript(node.arguments?.[1], (current) => {
        if (current.type !== "CallExpression" || current.callee?.type !== "Identifier" || !/^(?:show|open|expand|present|display|launch)/i.test(current.callee.name)) return;
        const stem = current.callee.name.replace(/^(?:show|open|expand|present|display|launch)/i, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        dynamicOpeners.push({
          functionName: current.callee.name,
          value: literalString(current.arguments?.[0]),
          openerId,
          openerSelector: closestSelectors.find((selector) => stem.split("-").some((part: string) => part && selector.toLowerCase().includes(part))) || closestSelectors[0],
        });
      });
    });
  });
  return { targetsByFunction, openerIdsByFunction, dynamicOpeners };
}

function routeGroup(node: ParseNode): string | undefined {
  let current = node.parentNode;
  while (current) {
    const explicit = attr(current, "data-page-group") || attr(current, "data-route-group") || attr(current, "aria-label");
    if (explicit && current.tagName !== "nav") return explicit.trim();
    const classes = new Set((attr(current, "class") || "").split(/\s+/));
    if (classes.has("menu-children") && current.parentNode) {
      const heading = elementChildren(current.parentNode).find((child) => child.tagName === "button" && (attr(child, "class") || "").split(/\s+/).includes("menu-node"));
      const text = heading ? nodeText(heading) : "";
      if (text) return text;
    }
    current = current.parentNode;
  }
  return undefined;
}

function surfacePageId(node: ParseNode, pages: PageDefinition[]): string | undefined {
  let current: ParseNode | undefined = node;
  while (current) {
    const scope = attr(current, "data-proto-scope") || attr(current, "data-zann-scope") || attr(current, "data-zmann-scope") || attr(current, "data-page-scope");
    const explicit = scope?.startsWith("page:") ? pageBase(scope) : attr(current, "data-page-key") || attr(current, "data-route-key") || attr(current, "data-page");
    const id = attr(current, "id") || "";
    const idKey = id.replace(/^page-/, "").replace(/-page$/, "");
    const key = explicit || (/(?:^page-|\-page$)/.test(id) ? idKey : "");
    const page = key ? pages.find((item) => item.key === key || item.id === `page:${key}`) : undefined;
    if (page) return page.id;
    current = current.parentNode;
  }
  return undefined;
}

function analyzeStaticSurfaces(document: ParseNode, pages: PageDefinition[]): SurfaceDefinition[] {
  const scriptEvidence = analyzeJavaScriptSurfaces(document);
  const discoveredTargets = new Set([...scriptEvidence.targetsByFunction.values()].flatMap((items) => [...items]));
  const nodesById = new Map<string, ParseNode>();
  const candidates: Array<{ node: ParseNode; definition: SurfaceDefinition }> = [];
  walk(document, (node) => {
    const id = attr(node, "id");
    if (!id) return;
    nodesById.set(id, node);
    const classes = (attr(node, "class") || "").split(/\s+/).filter(Boolean);
    const scope = attr(node, "data-proto-scope") || attr(node, "data-zann-scope") || attr(node, "data-zmann-scope") || "";
    const semanticName = `${id} ${classes.join(" ")} ${attr(node, "role") || ""}`;
    if (/toast|snackbar|message-tip|notification-tip/i.test(semanticName) || ["status", "alert"].includes(attr(node, "role") || "") || attr(node, "aria-live")) return;
    const isDrawer = classes.some((name) => /(^|[-_])drawer($|[-_])/.test(name)) && !classes.some((name) => /overlay|mask|backdrop/.test(name));
    const isModalRoot = classes.some((name) => /(^|[-_])(modal|dialog)($|[-_])/.test(name) && /overlay|root|wrap|backdrop/.test(name));
    const isDialog = node.tagName === "dialog" || attr(node, "role") === "dialog" || attr(node, "aria-modal") === "true";
    const isPopover = attr(node, "popover") !== undefined || classes.some((name) => /(^|[-_])popover($|[-_])/.test(name));
    const isScopedSurface = /^(?:sheet|drawer|dialog|modal|overlay|popover|preview):/.test(scope);
    const isGenericOverlay = classes.includes("overlay") && !classes.some((name) => /mask|backdrop/.test(name));
    if (!isDrawer && !isModalRoot && !isDialog && !isPopover && !isScopedSurface && !isGenericOverlay && !discoveredTargets.has(id)) return;
    if (!nodeText(node)) return;
    const semanticText = `${id} ${classes.join(" ")} ${attr(node, "role") || ""} ${scope}`;
    const kind: SurfaceDefinition["kind"] = isDrawer || /drawer|sheet/i.test(semanticText) ? "drawer" : isPopover || /popover/i.test(semanticText) ? "popover" : isModalRoot || isDialog || isGenericOverlay || /modal|dialog|preview/i.test(semanticText) ? "modal" : "panel";
    let titleNode: ParseNode | undefined;
    walk(node, (child) => {
      if (!titleNode && child !== node && (/title/i.test(`${attr(child, "class") || ""} ${attr(child, "id") || ""}`) || /^h[1-4]$/.test(child.tagName || ""))) titleNode = child;
    });
    candidates.push({
      node,
      definition: {
        id: `surface:${id}`,
        title: titleNode ? titleFromNode(titleNode, humanize(id)) : attr(node, "aria-label") || humanize(id.replace(/-(drawer|modal|dialog|popover|overlay)$/, "")),
        kind,
        pageId: pages[0]?.id || "page:main",
        rootSelector: `#${escapeSelector(id)}`,
        contentSelector: isModalRoot ? `#${escapeSelector(id)} .modal,#${escapeSelector(id)} [role="dialog"]` : undefined,
        activeSelector: `#${escapeSelector(id)}.active,#${escapeSelector(id)}.is-open,#${escapeSelector(id)}[aria-hidden="false"]`,
      },
    });
  });
  const byId = (id: string) => candidates.find(({ node }) => attr(node, "id") === id);
  const byScope = (scope: string) => candidates.find(({ node }) => [attr(node, "data-proto-scope"), attr(node, "data-zann-scope"), attr(node, "data-zmann-scope")].includes(scope));
  const records: Array<{ opener: ParseNode; surface: typeof candidates[number]; parent?: typeof candidates[number]; pageId?: string; openSelector?: string }> = [];
  walk(document, (node) => {
    const handler = attr(node, "onclick") || "";
    const explicitEntries = ["aria-controls", "data-target", "data-bs-target", "data-modal", "data-drawer", "data-sheet", "data-dialog", "data-overlay", "data-popover", "data-zann-scope-route", "data-zmann-scope-route", "data-proto-route", "data-open-modal", "data-open-drawer"]
      .map((name) => ({ name, value: attr(node, name)?.replace(/^#/, "") }))
      .filter((item) => Boolean(item.value));
    const explicit = explicitEntries[0];
    let surface = explicit ? byId(explicit.value!) || byScope(explicit.value!) : undefined;
    if (!surface && explicit) {
      const scopeId = explicit.value!.replace(":", "-");
      surface = byId(scopeId) || byId(`${explicit.name.replace(/^data-(?:open-)?/, "")}-${explicit.value}`);
      if (!surface && explicit.name === "data-open-modal") surface = candidates.find(({ definition }) => definition.kind === "modal");
      if (!surface && explicit.name === "data-open-drawer") surface = candidates.find(({ definition }) => definition.kind === "drawer");
    }
    const match = handler.match(/\b(?:show|open)([A-Z][\w$]*)\s*\(/);
    if (!surface && match) {
      const stem = match[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      const ids = [stem, `${stem}-drawer`, `${stem}-modal`, `${stem}-dialog`, `${stem}-popover`];
      surface = ids.map(byId).find(Boolean) || candidates.find(({ node: item }) => ids.some((id) => (attr(item, "id") || "").startsWith(`${id}-`)));
    }
    if (!surface) return;
    let parent = node.parentNode;
    let parentSurface: typeof candidates[number] | undefined;
    while (parent && !parentSurface) {
      parentSurface = candidates.find((item) => item.node === parent);
      parent = parent.parentNode;
    }
    records.push({ opener: node, surface, parent: parentSurface, pageId: surfacePageId(node, pages) });
  });
  scriptEvidence.targetsByFunction.forEach((targetIds, functionName) => {
    const openerIds = scriptEvidence.openerIdsByFunction.get(functionName) || new Set<string>();
    targetIds.forEach((targetId) => {
      const surface = byId(targetId);
      if (!surface) return;
      openerIds.forEach((openerId) => {
        const opener = nodesById.get(openerId);
        if (!opener || records.some((record) => record.opener === opener && record.surface === surface)) return;
        let parent = opener.parentNode;
        let parentSurface: typeof candidates[number] | undefined;
        while (parent && !parentSurface) {
          parentSurface = candidates.find((item) => item.node === parent);
          parent = parent.parentNode;
        }
        records.push({ opener, surface, parent: parentSurface, pageId: surfacePageId(opener, pages) });
      });
    });
  });
  const nodesForSelector = (selector: string): ParseNode[] => {
    if (selector.startsWith("#")) return nodesById.has(selector.slice(1)) ? [nodesById.get(selector.slice(1))!] : [];
    const match = selector.match(/^\[([A-Za-z0-9_-]+)(?:=["']?([^\]"']+)["']?)?\]$/);
    if (!match) return [];
    const nodes: ParseNode[] = [];
    walk(document, (node) => {
      const value = attr(node, match[1]);
      if (value !== undefined && (match[2] === undefined || value === match[2])) nodes.push(node);
    });
    return nodes;
  };
  scriptEvidence.dynamicOpeners.forEach((dynamic) => {
    const targetIds = scriptEvidence.targetsByFunction.get(dynamic.functionName) || new Set<string>();
    const stem = dynamic.functionName.replace(/^(?:show|open|expand|present|display|launch)/i, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    const surfaces = candidates.filter(({ node }) => {
      const id = attr(node, "id") || "";
      const scope = attr(node, "data-proto-scope") || attr(node, "data-zann-scope") || attr(node, "data-zmann-scope") || "";
      return targetIds.has(id)
        || Boolean(dynamic.value && (id === dynamic.value || id.endsWith(`-${dynamic.value}`) || scope.endsWith(`:${dynamic.value}`)))
        || Boolean(stem && (id === stem || id.endsWith(`-${stem}`) || id.includes(stem)));
    });
    const openers = dynamic.openerId ? (nodesById.has(dynamic.openerId) ? [nodesById.get(dynamic.openerId)!] : []) : dynamic.openerSelector ? nodesForSelector(dynamic.openerSelector) : [];
    surfaces.forEach((surface) => openers.forEach((opener) => {
      if (records.some((record) => record.surface === surface && record.opener === opener)) return;
      let parent = opener.parentNode;
      let parentSurface: typeof candidates[number] | undefined;
      while (parent && !parentSurface) {
        parentSurface = candidates.find((item) => item.node === parent);
        parent = parent.parentNode;
      }
      records.push({ opener, surface, parent: parentSurface, pageId: surfacePageId(opener, pages), openSelector: dynamic.openerSelector || (dynamic.openerId ? `#${escapeSelector(dynamic.openerId)}` : undefined) });
    }));
  });
  const owners = new Map<typeof candidates[number], Set<string>>(candidates.map((candidate) => [candidate, new Set<string>()]));
  records.forEach((record) => { if (record.pageId) owners.get(record.surface)?.add(record.pageId); });
  for (let pass = 0; pass < candidates.length; pass += 1) {
    records.forEach((record) => {
      if (!record.parent) return;
      owners.get(record.parent)?.forEach((pageId) => owners.get(record.surface)?.add(pageId));
    });
  }
  const mappedId = (candidate: typeof candidates[number], pageId: string): string => {
    const values = owners.get(candidate) || new Set<string>();
    return values.size > 1 ? `${candidate.definition.id}:${pageId.replace(/^page:/, "")}` : candidate.definition.id;
  };
  return candidates.flatMap((candidate) => [...(owners.get(candidate) || [])].map((pageId) => {
    const candidateRecords = records.filter((record) => record.surface === candidate && (record.pageId === pageId || (!record.pageId && record.parent && owners.get(record.parent)?.has(pageId))));
    const record = candidateRecords[0];
    const openerId = record ? attr(record.opener, "id") : undefined;
    const handler = record ? attr(record.opener, "onclick") || "" : "";
    const identifying = record?.opener.attrs?.find((item) => ["data-open-modal", "data-open-drawer", "data-sheet", "data-dialog", "data-overlay", "data-popover", "data-zann-scope-route", "data-zmann-scope-route", "data-proto-route", "aria-controls", "data-target", "data-bs-target"].includes(item.name));
    const functionMatch = handler.match(/\b(show[A-Z][\w$]*)\s*\(/);
    return {
      ...candidate.definition,
      id: mappedId(candidate, pageId),
      pageId,
      parentId: record?.parent ? mappedId(record.parent, pageId) : undefined,
      openSelector: record?.openSelector || (openerId ? `#${escapeSelector(openerId)}` : handler ? `[onclick="${escapeSelector(handler)}"]` : identifying ? `[${identifying.name}="${escapeSelector(identifying.value)}"]` : undefined),
      openFunction: functionMatch?.[1],
    };
  }));
}

function collectExternalReferences(source: string): string[] {
  const values = new Set<string>();
  const pattern = /\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(pattern)) {
    const value = match[1].trim();
    if (!value || value.includes("${") || value.includes("<%") || /^(?:data:|blob:|#|javascript:|mailto:|tel:)/i.test(value)) continue;
    values.add(value);
  }
  return [...values].slice(0, 50);
}

export async function inspectHtml(sourcePathValue: string, useSavedMap = true): Promise<InspectionReport> {
  const sourcePath = resolve(sourcePathValue);
  const source = await readFile(sourcePath, "utf8");
  const document = parse(source, { sourceCodeLocationInfo: true }) as unknown as ParseNode;
  const sourceHash = sha256(source);
  const scriptRoutes = analyzeJavaScriptRoutes(document);
  const scriptRouteMap = new Map(scriptRoutes.entries.map((entry) => [entry.key, entry]));
  const appRoots: ParseNode[] = [];
  const pageMap = new Map<string, PageDefinition>();
  const labelMap = new Map<string, string>();
  const renderKeys = new Set<string>();
  const templateScopes = new Set<string>();
  const routeAttributes = new Set<string>();
  const routeEvidence = new Map<string, { title: string; group?: string; attribute: string }>();
  const pageContainers = new Map<string, string>();
  let platform: Platform = /data-proto-platform\s*=\s*["']mobile["']/i.test(source) ? "mobile" : "web";

  for (const match of source.matchAll(/\{\s*id\s*:\s*["']([A-Za-z0-9_-]+)["']\s*,\s*label\s*:\s*["']([^"']+)["']/g)) {
    labelMap.set(match[1], match[2]);
  }
  for (const match of source.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*render[A-Za-z_$][\w$]*\s*,?\s*$/gm)) {
    renderKeys.add(match[1]);
  }

  const addPage = (keyValue: string, scopeValue: string, selector: string, title: string, sourceType: string, confidence: Confidence, extra: Partial<PageDefinition> = {}): void => {
    const key = pageBase(keyValue.replace(/^page:/, ""));
    if (!key || key === "*") return;
    const existing = pageMap.get(key);
    if (existing) {
      const stronger = (existing.confidence === "medium" && confidence === "high") || sourceType === "route-manifest";
      pageMap.set(key, {
        ...existing,
        ...extra,
        title: stronger ? (title || existing.title) : existing.title,
        selector: stronger ? selector : existing.selector,
        source: stronger ? sourceType : existing.source,
        confidence: existing.confidence === "high" || confidence === "high" ? "high" : "medium",
      });
      return;
    }
    pageMap.set(key, {
      id: `page:${key}`,
      title: title || humanize(key),
      scope: scopeValue.startsWith("page:") ? `page:${key}` : `page:${key}`,
      selector,
      key,
      source: sourceType,
      confidence,
      ...extra,
    });
  };

  walk(document, (node) => {
    if (attr(node, "data-proto-app") !== undefined || attr(node, "data-zann-app-root") !== undefined) appRoots.push(node);
    if (attr(node, "data-proto-platform") === "mobile") platform = "mobile";
    const templateScope = attr(node, "data-page-scope") || attr(node, "data-route-scope") || attr(node, "data-view-scope");
    if (templateScope && !templateScope.includes("${")) templateScopes.add(templateScope);
    for (const attribute of ["data-page-key", "data-route-key", "data-view-key", "data-screen-key", "data-nav"]) {
      const key = attr(node, attribute);
      if (!key || key.includes("${")) continue;
      routeAttributes.add(attribute);
      const existing = routeEvidence.get(key);
      const title = nodeText(node).slice(0, 80) || humanize(key);
      routeEvidence.set(key, { title: existing?.title || title, group: existing?.group || routeGroup(node), attribute });
    }
    const scope = attr(node, "data-proto-scope") || attr(node, "data-zann-scope") || attr(node, "data-zmann-scope");
    if (scope?.startsWith("page:")) {
      const key = pageBase(scope);
      const attribute = attr(node, "data-proto-scope") ? "data-proto-scope" : attr(node, "data-zann-scope") ? "data-zann-scope" : "data-zmann-scope";
      addPage(key, scope, `[${attribute}^="page:${escapeSelector(key)}"]`, titleFromNode(node, humanize(key)), attribute, "high");
    }
    const dataPage = attr(node, "data-page") || attr(node, "data-proto-page");
    if (dataPage && !dataPage.includes("${")) {
      const attribute = attr(node, "data-page") ? "data-page" : "data-proto-page";
      routeAttributes.add(attribute);
      const existing = routeEvidence.get(dataPage);
      routeEvidence.set(dataPage, { title: existing?.title || nodeText(node).slice(0, 80) || humanize(dataPage), group: existing?.group || routeGroup(node), attribute });
      addPage(dataPage, `page:${dataPage}`, `[${attribute}="${escapeSelector(dataPage)}"]`, titleFromNode(node, humanize(dataPage)), attribute, "high");
    }
    const classes = (attr(node, "class") || "").split(/\s+/);
    if ((classes.includes("page") || classes.includes("screen")) && attr(node, "id")) {
      const id = attr(node, "id")!;
      const rawKey = id.replace(/^page-/, "");
      const suffixKey = rawKey.replace(/-page$/, "");
      const key = suffixKey;
      pageContainers.set(key, id);
      addPage(key, `page:${key}`, `#${escapeSelector(id)}`, titleFromNode(node, humanize(key)), "class", "medium", { rootSelector: `#${escapeSelector(id)}` });
    }
  });

  const preferredOpenFunction = ["openPage", "showPage", "switchPage", "renderPage", "navigate", "goToPage", "goTo", "setPage"].find((name) => scriptRoutes.openFunctions.includes(name));
  const dynamicPageScope = [...templateScopes].some((scope) => scope.startsWith("page:"));
  const rootSelectorFor = (key: string, template?: string): string | undefined => {
    const container = pageContainers.get(key);
    if (container) return `#${escapeSelector(container)}`;
    if (template) return `[data-page-scope="${escapeSelector(template)}"],[data-route-scope="${escapeSelector(template)}"],[data-view-scope="${escapeSelector(template)}"]`;
    if (dynamicPageScope) return `[data-page-scope="page:${escapeSelector(key)}"]`;
    return undefined;
  };
  for (const [key, evidence] of routeEvidence) {
    const manifest = scriptRouteMap.get(key);
    const template = manifest?.template && templateScopes.has(manifest.template) ? manifest.template : undefined;
    addPage(key, `page:${key}`, `[${evidence.attribute}="${escapeSelector(key)}"]`, manifest?.title || evidence.title, manifest ? "route-manifest" : evidence.attribute, "high", {
      group: manifest?.group || evidence.group,
      template,
      rootSelector: rootSelectorFor(key, template),
      activeSelector: `[${evidence.attribute}="${escapeSelector(key)}"][aria-current="page"],[${evidence.attribute}="${escapeSelector(key)}"].active,[${evidence.attribute}="${escapeSelector(key)}"].is-active,[data-system-tab][${evidence.attribute}="${escapeSelector(key)}"][aria-selected="true"],[data-tab-page="${escapeSelector(key)}"].is-active`,
      openFunction: preferredOpenFunction,
    });
    const routed = pageMap.get(key);
    if (routed) pageMap.set(key, { ...routed, selector: `[${evidence.attribute}="${escapeSelector(key)}"]` });
  }
  for (const manifest of scriptRoutes.entries) {
    if (pageMap.has(manifest.key) || !preferredOpenFunction) continue;
    const template = manifest.template && templateScopes.has(manifest.template) ? manifest.template : undefined;
    addPage(manifest.key, `page:${manifest.key}`, `[data-page="${escapeSelector(manifest.key)}"],[data-page-key="${escapeSelector(manifest.key)}"]`, manifest.title, "route-manifest", preferredOpenFunction ? "high" : "medium", {
      group: manifest.group,
      template,
      rootSelector: rootSelectorFor(manifest.key, template),
      activeSelector: `[data-page="${escapeSelector(manifest.key)}"].active,[data-page="${escapeSelector(manifest.key)}"].is-active,[data-page-key="${escapeSelector(manifest.key)}"][aria-current="page"],[data-tab-page="${escapeSelector(manifest.key)}"].is-active`,
      openFunction: preferredOpenFunction,
    });
  }

  for (const key of renderKeys) {
    addPage(key, `page:${key}`, `[data-page="${escapeSelector(key)}"]`, labelMap.get(key) || humanize(key), "render-map", "high");
  }
  for (const match of source.matchAll(/["']scope["']\s*:\s*["']page:([A-Za-z0-9_-]+)(?::[^"']+)?["']/g)) {
    const key = match[1];
    if (renderKeys.size && !renderKeys.has(key)) continue;
    addPage(key, `page:${key}`, `[data-proto-scope^="page:${escapeSelector(key)}"],[data-zann-scope^="page:${escapeSelector(key)}"]`, labelMap.get(key) || humanize(key), "annotation-scope", "medium");
  }
  for (const match of source.matchAll(/data-page=\\?["']([A-Za-z0-9_-]+)\\?["']/g)) {
    const key = match[1];
    addPage(key, `page:${key}`, `[data-page="${escapeSelector(key)}"]`, labelMap.get(key) || humanize(key), "script-route", "high");
  }

  if (!pageMap.size) {
    addPage("main", "page:main", "body", basename(sourcePath, extname(sourcePath)), "single-page", "high");
  }

  const warnings: string[] = [];
  if (appRoots.length > 1) warnings.push(`检测到 ${appRoots.length} 个业务根节点，编辑时将以页面节点为边界。`);
  if ([...pageMap.values()].some((page) => page.confidence === "medium")) warnings.push("部分页面来自兼容规则，启动后将由浏览器运行时复核。");
  const externalReferences = collectExternalReferences(source);
  if (externalReferences.length) warnings.push(`检测到 ${externalReferences.length} 个非内嵌资源引用。`);

  let pages = [...pageMap.values()];
  if (scriptRoutes.entries.length) {
    const order = new Map(scriptRoutes.entries.map((entry, index) => [entry.key, index]));
    pages = pages.map((page, index) => ({ page, index })).sort((left, right) => (order.get(left.page.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.page.key) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index).map(({ page }) => page);
  }
  let surfaces = analyzeStaticSurfaces(document, pages);
  let analysisMethod: "automatic" | "agent-map" = "automatic";
  if (useSavedMap && existsSync(pageMapPath(sourcePath))) {
    const saved = await readJson<PageMapRecord>(pageMapPath(sourcePath)).catch(() => null);
    if (saved?.sourceHash === sourceHash && Array.isArray(saved.pages) && saved.pages.length) {
      pages = saved.pages;
      if (Array.isArray(saved.surfaces)) surfaces = saved.surfaces;
      analysisMethod = saved.source === "agent" ? "agent-map" : "automatic";
    }
  }
  return {
    status: appRoots.length > 1 ? "warning" : warnings.length ? "warning" : "pass",
    sourcePath: normalizePath(sourcePath),
    sourceHash,
    platform,
    appRootCount: appRoots.length,
    pages,
    surfaces,
    warnings,
    externalReferences,
    analysis: {
      method: analysisMethod,
      logicalPageCount: pages.length,
      templateScopes: [...templateScopes],
      routeAttributes: [...routeAttributes],
      openFunctions: scriptRoutes.openFunctions,
    },
  };
}

function findHtmlNode(document: ParseNode): ParseNode | null {
  let result: ParseNode | null = null;
  walk(document, (node) => {
    if (!result && node.tagName === "html") result = node;
  });
  return result;
}

function findNode(document: ParseNode, target: ElementTarget): ParseNode | null {
  let result: ParseNode | null = null;
  walk(document, (node) => {
    if (result) return;
    if (target.heId && attr(node, "data-he-id") === target.heId) result = node;
    else if (target.existingId && attr(node, "id") === target.existingId) result = node;
  });
  if (result) return result;

  let current = findHtmlNode(document);
  if (!current) return null;
  for (const index of target.domPath || []) {
    const children = elementChildren(current);
    current = children[index];
    if (!current) return null;
  }
  if (target.tagName && current.tagName?.toLowerCase() !== target.tagName.toLowerCase()) return null;
  return current;
}

function escapeAttribute(value: string, quote: string): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return quote === "'" ? escaped.replaceAll("'", "&#39;") : escaped.replaceAll('"', "&quot;");
}

function setAttributeInSource(source: string, node: ParseNode, name: string, value: string | null): string {
  const location = node.sourceCodeLocation;
  if (!location?.startTag) throw new Error(`无法修改 <${node.tagName}>：缺少源码位置。`);
  const key = name.toLowerCase();
  const attributeLocation = location.attrs?.[key];
  if (attributeLocation) {
    if (value === null) {
      let start = attributeLocation.startOffset;
      while (start > location.startTag.startOffset && /\s/.test(source[start - 1])) start -= 1;
      return `${source.slice(0, start)}${source.slice(attributeLocation.endOffset)}`;
    }
    const original = source.slice(attributeLocation.startOffset, attributeLocation.endOffset);
    const quote = original.includes("='") ? "'" : '"';
    const replacement = `${name}=${quote}${escapeAttribute(value, quote)}${quote}`;
    return `${source.slice(0, attributeLocation.startOffset)}${replacement}${source.slice(attributeLocation.endOffset)}`;
  }
  if (value === null) return source;
  let insertAt = location.startTag.endOffset - 1;
  if (source[insertAt - 1] === "/") insertAt -= 1;
  const addition = ` ${name}="${escapeAttribute(value, '"')}"`;
  return `${source.slice(0, insertAt)}${addition}${source.slice(insertAt)}`;
}

function parseSource(source: string): ParseNode {
  return parse(source, { sourceCodeLocationInfo: true }) as unknown as ParseNode;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueIndex(source: string, needle: string): number {
  if (!needle) return -1;
  const index = source.indexOf(needle);
  if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) return -1;
  return index;
}

function uniqueTextAnchor(source: string, value: string): number {
  const normalized = value.trim().replace(/(?:…|\.{3})$/, "").trim();
  if (!normalized) return -1;
  const fullMatch = uniqueIndex(source, normalized);
  if (fullMatch >= 0) return fullMatch;
  const lengths = [normalized.length, 160, 120, 80, 60, 40, 24];
  for (const length of lengths) {
    if (length > normalized.length) continue;
    const candidate = normalized.slice(0, length).trim();
    if (candidate.length < 12) continue;
    const exact = uniqueIndex(source, candidate);
    if (exact >= 0) return exact;
    const parts = candidate.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const matches = [...source.matchAll(new RegExp(parts.map(escapeRegExp).join("\\s+"), "g"))];
    if (matches.length === 1) return matches[0].index ?? -1;
  }
  return -1;
}

interface DynamicLocation {
  startOffset: number;
  startTagEnd: number;
  endTagStart: number;
  endOffset: number;
}

function tagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index + 1;
  }
  return -1;
}

function findDynamicLocation(source: string, target: ElementTarget, hint = ""): DynamicLocation | null {
  const tagName = target.tagName.toLowerCase();
  let anchor = -1;
  if (target.heId) {
    const match = new RegExp(`data-he-id\\s*=\\s*["']${escapeRegExp(target.heId)}["']`, "i").exec(source);
    if (match && !new RegExp(`data-he-id\\s*=\\s*["']${escapeRegExp(target.heId)}["']`, "ig").exec(source.slice((match.index || 0) + match[0].length))) anchor = match.index;
  }
  if (anchor < 0 && target.existingId) {
    const pattern = new RegExp(`id\\s*=\\s*["']${escapeRegExp(target.existingId)}["']`, "ig");
    const matches = [...source.matchAll(pattern)];
    if (matches.length === 1) anchor = matches[0].index ?? -1;
  }
  if (anchor < 0 && target.sourceAttributes && Object.keys(target.sourceAttributes).length) {
    const attributes = Object.entries(target.sourceAttributes).filter(([name, value]) => /^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(name) && value);
    if (attributes.length) {
      const openingTags = [...source.matchAll(new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>`, "ig"))];
      const matches = openingTags.filter((match) => attributes.every(([name, value]) => {
        const pattern = new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(?:["']${escapeRegExp(value)}["']|${escapeRegExp(value)}(?=\\s|>))`, "i");
        return pattern.test(match[0]);
      }));
      if (matches.length === 1) anchor = (matches[0].index ?? -1) + matches[0][0].length;
    }
  }
  if (anchor < 0) anchor = uniqueTextAnchor(source, hint || target.originalText || "");
  if (anchor < 0 && hint) anchor = uniqueTextAnchor(source, target.originalText || "");
  if (anchor < 0) return null;

  const opening = new RegExp(`<${escapeRegExp(tagName)}\\b`, "ig");
  let startOffset = -1;
  for (const match of source.slice(0, anchor + 1).matchAll(opening)) startOffset = match.index ?? -1;
  if (startOffset < 0 || anchor - startOffset > 20000) return null;
  const startTagEnd = tagEnd(source, startOffset);
  if (startTagEnd < 0) return null;
  if (VOID_TAGS.has(tagName)) return { startOffset, startTagEnd, endTagStart: startTagEnd, endOffset: startTagEnd };

  const tokens = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "ig");
  tokens.lastIndex = startTagEnd;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(source))) {
    if (match[0].startsWith("</")) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) {
      return { startOffset, startTagEnd, endTagStart: match.index, endOffset: match.index + match[0].length };
    }
  }
  return null;
}

function setAttributeInTag(tag: string, name: string, value: string | null): string {
  const pattern = new RegExp(`\\s+${escapeRegExp(name)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, "i");
  if (pattern.test(tag)) {
    if (value === null) return tag.replace(pattern, "");
    return tag.replace(pattern, ` ${name}="${escapeAttribute(value, '"')}"`);
  }
  if (value === null) return tag;
  const insertAt = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
  return `${tag.slice(0, insertAt)} ${name}="${escapeAttribute(value, '"')}"${tag.slice(insertAt)}`;
}

function applyDynamicPatch(source: string, patch: EditorPatch): string {
  if (patch.type === "set-inner-html" && patch.target.sourceAttributes?.["data-page"] && typeof patch.before === "string") {
    const pageKey = patch.target.sourceAttributes["data-page"];
    const oldText = patch.before.replace(/<[^>]+>/g, "").trim();
    const newText = (patch.html || "").replace(/<[^>]+>/g, "").trim();
    const pattern = new RegExp(`(\\bid\\s*:\\s*(["'])${escapeRegExp(pageKey)}\\2[\\s\\S]{0,240}?\\blabel\\s*:\\s*)(["'])${escapeRegExp(oldText)}\\3`, "g");
    const matches = [...source.matchAll(pattern)];
    if (matches.length === 1) {
      const match = matches[0];
      const quote = match[3];
      const escaped = newText.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
      const replacement = `${match[1]}${quote}${escaped}${quote}`;
      return `${source.slice(0, match.index)}${replacement}${source.slice((match.index || 0) + match[0].length)}`;
    }
  }
  const hint = typeof patch.before === "string" && patch.before ? patch.before : patch.target.originalText || "";
  const location = findDynamicLocation(source, patch.target, hint);
  if (!location) throw new Error(`找不到动态模板中的唯一目标 <${patch.target.tagName}>。`);
  let startTag = source.slice(location.startOffset, location.startTagEnd);
  if (patch.target.heId) startTag = setAttributeInTag(startTag, "data-he-id", patch.target.heId);

  if (patch.type === "set-attribute") {
    if (!patch.name || !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(patch.name)) throw new Error("属性名不合法。");
    startTag = setAttributeInTag(startTag, patch.name, patch.value ?? null);
    return `${source.slice(0, location.startOffset)}${startTag}${source.slice(location.startTagEnd)}`;
  }
  if (patch.type === "set-inner-html") {
    if (location.endTagStart <= location.startTagEnd) throw new Error(`动态元素 <${patch.target.tagName}> 不支持内部内容修改。`);
    const before = typeof patch.before === "string" ? patch.before : "";
    const beforeIndex = before ? uniqueIndex(source, before) : -1;
    if (beforeIndex >= location.startTagEnd && beforeIndex <= location.endTagStart) {
      const withStableTag = `${source.slice(0, location.startOffset)}${startTag}${source.slice(location.startTagEnd)}`;
      const shiftedIndex = uniqueIndex(withStableTag, before);
      if (shiftedIndex < 0) throw new Error("动态模板内容在写入稳定 ID 后不再唯一。");
      return `${withStableTag.slice(0, shiftedIndex)}${patch.html || ""}${withStableTag.slice(shiftedIndex + before.length)}`;
    }
    throw new Error("动态模板的原始内容不唯一，已停止修改。");
  }
  if (patch.type === "delete-element") {
    return `${source.slice(0, location.startOffset)}${source.slice(location.endOffset)}`;
  }
  if (patch.type === "insert-after") {
    return `${source.slice(0, location.endOffset)}${patch.html || ""}${source.slice(location.endOffset)}`;
  }
  if (location.endTagStart <= location.startTagEnd) throw new Error(`动态元素 <${patch.target.tagName}> 不能容纳子元素。`);
  return `${source.slice(0, location.endTagStart)}${patch.html || ""}${source.slice(location.endTagStart)}`;
}

function ensureStableTarget(source: string, target: ElementTarget): { source: string; node: ParseNode } {
  let document = parseSource(source);
  let node = findNode(document, target);
  if (!node) throw new Error(`找不到修改目标 <${target.tagName}>。`);
  if (target.heId && attr(node, "data-he-id") !== target.heId) {
    source = setAttributeInSource(source, node, "data-he-id", target.heId);
    document = parseSource(source);
    node = findNode(document, target);
    if (!node) throw new Error(`写入稳定 ID 后无法重新定位 <${target.tagName}>。`);
  }
  return { source, node };
}

export function applyPatchToSource(input: string, patch: EditorPatch): string {
  if (!ALLOWED_PATCHES.has(patch.type)) throw new Error(`不支持的补丁类型：${patch.type}`);
  let stable: { source: string; node: ParseNode };
  try {
    stable = ensureStableTarget(input, patch.target);
  } catch {
    return applyDynamicPatch(input, patch);
  }
  let source = stable.source;
  let node = stable.node;
  if (patch.type === "set-attribute") {
    if (!patch.name || !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(patch.name)) throw new Error("属性名不合法。");
    return setAttributeInSource(source, node, patch.name, patch.value ?? null);
  }
  const location = node.sourceCodeLocation;
  if (!location) throw new Error(`无法修改 <${node.tagName}>：缺少源码位置。`);
  if (patch.type === "set-inner-html") {
    if (!location.startTag || !location.endTag) throw new Error(`元素 <${node.tagName}> 不支持内部内容修改。`);
    return `${source.slice(0, location.startTag.endOffset)}${patch.html || ""}${source.slice(location.endTag.startOffset)}`;
  }
  if (patch.type === "delete-element") {
    return `${source.slice(0, location.startOffset)}${source.slice(location.endOffset)}`;
  }
  if (patch.type === "insert-after") {
    return `${source.slice(0, location.endOffset)}${patch.html || ""}${source.slice(location.endOffset)}`;
  }
  if (!location.endTag) throw new Error(`元素 <${node.tagName}> 不能容纳子元素。`);
  return `${source.slice(0, location.endTag.startOffset)}${patch.html || ""}${source.slice(location.endTag.startOffset)}`;
}

export function applyCommands(source: string, commands: EditorCommand[], cursor = commands.length): { html: string; applied: number; errors: string[] } {
  let html = source;
  const errors: string[] = [];
  let applied = 0;
  for (const command of commands.slice(0, cursor)) {
    try {
      for (const patch of command.patches) html = applyPatchToSource(html, patch);
      applied += 1;
    } catch (error) {
      errors.push(`${command.label}：${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  return { html, applied, errors };
}

const PATCH_RUNTIME = `<script data-he-patch-runtime>(()=>{
  if(window.__htmlEditorPatchRuntime)return;
  window.__htmlEditorPatchRuntime=true;
  const applied=new WeakMap();
  const visible=e=>{if(!e)return false;const s=getComputedStyle(e);return !e.hidden&&e.getAttribute('aria-hidden')!=='true'&&s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length>0};
  const routeKey=()=>{const e=document.querySelector('[data-page-key][aria-current="page"],[data-route-key][aria-current="page"],[data-view-key][aria-current="page"],[data-screen-key][aria-current="page"],[data-system-tab][data-page-key][aria-selected="true"],[data-page].active,[data-page].is-active,[data-tab-page].is-active');return e&&(e.getAttribute('data-page-key')||e.getAttribute('data-route-key')||e.getAttribute('data-view-key')||e.getAttribute('data-screen-key')||e.getAttribute('data-page')||e.getAttribute('data-tab-page'))};
  const pageRoot=t=>{if(t.runtimeScope==='global')return document.body;const id=t.runtimePageId||'page:main';const key=id.replace(/^page:/,'');if(t.runtimeRootSelector){const active=routeKey();if(active&&active!==key)return null;try{const mapped=Array.from(document.querySelectorAll(t.runtimeRootSelector)).find(visible);if(mapped)return mapped}catch{}}const scopes=Array.from(document.querySelectorAll('[data-proto-scope="page:'+CSS.escape(key)+'"],[data-zann-scope="page:'+CSS.escape(key)+'"],[data-zmann-scope="page:'+CSS.escape(key)+'"]'));const scoped=scopes.find(visible);if(scoped)return scoped;return id==='page:main'?(document.querySelector('[data-proto-app],[data-zann-app-root]')||document.body):null};
  const sameTag=(e,t)=>e&&e.tagName&&e.tagName.toLowerCase()===String(t.tagName||'').toLowerCase();
  const resolve=t=>{const root=pageRoot(t);if(!root)return null;if(t.existingId){const byId=document.getElementById(t.existingId);if(byId&&(byId===root||root.contains(byId)))return byId}if(Array.isArray(t.runtimePath)){let e=root;for(const i of t.runtimePath)e=e&&e.children?e.children[i]:null;if(sameTag(e,t))return e}const attrs=Object.entries(t.sourceAttributes||{}).filter(([n,v])=>v&&n!=='class');if(attrs.length){const list=Array.from(root.querySelectorAll(t.tagName||'*')).filter(e=>attrs.every(([n,v])=>e.getAttribute(n)===v));if(list.length===1)return list[0]}if(t.originalText){const text=String(t.originalText).replace(/(?:…|\\.{3})$/,'').trim();const list=Array.from(root.querySelectorAll(t.tagName||'*')).filter(e=>(e.textContent||'').replace(/\\s+/g,' ').trim().startsWith(text));if(list.length===1)return list[0]}if(Array.isArray(t.domPath)){let e=document.documentElement;for(const i of t.domPath)e=e&&e.children?e.children[i]:null;if(sameTag(e,t))return e}return null};
  const read=()=>Array.from(document.querySelectorAll('script[type="application/json"][data-he-patches]')).flatMap(node=>{try{return JSON.parse(node.textContent||'[]')}catch{return []}});
  const cleanHtml=e=>{const clone=e.cloneNode(true);clone.querySelectorAll('[data-he-runtime],[data-he-patch-runtime],script[data-he-patches]').forEach(n=>n.remove());clone.querySelectorAll('[data-he-selected],[data-he-editing],[data-he-dragging],[data-he-parent],[data-he-hover]').forEach(n=>{n.removeAttribute('data-he-selected');n.removeAttribute('data-he-editing');n.removeAttribute('data-he-dragging');n.removeAttribute('data-he-parent');n.removeAttribute('data-he-hover');n.removeAttribute('contenteditable')});return clone.innerHTML};
  const value=(e,p)=>p.type==='set-attribute'?e.getAttribute(p.name):p.type==='set-inner-html'?cleanHtml(e):'';
  const patchKey=(p,i)=>String(i)+':'+p.type+':'+String(p.name||'')+':'+String(p.value??p.html??'');
  const apply=()=>{const patches=read();for(let i=0;i<patches.length;i++){const p=patches[i],e=resolve(p.target||{}),key=patchKey(p,i);if(!e||e.closest('[data-he-selected],[data-he-editing],[data-he-dragging]')||e.querySelector('[data-he-selected],[data-he-editing],[data-he-dragging]'))continue;const known=applied.get(e);if(known&&known.get(key)===value(e,p))continue;if(p.type==='set-attribute'){if(p.value===null||p.value===undefined){if(e.hasAttribute(p.name))e.removeAttribute(p.name)}else if(e.getAttribute(p.name)!==String(p.value))e.setAttribute(p.name,String(p.value))}else if(p.type==='set-inner-html'&&e.innerHTML!==String(p.html||''))e.innerHTML=String(p.html||'')}for(let i=0;i<patches.length;i++){const p=patches[i],e=resolve(p.target||{});if(!e)continue;let state=applied.get(e);if(!state){state=new Map();applied.set(e,state)}state.set(patchKey(p,i),value(e,p))}};
  let pending=false;const schedule=()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;apply()})};
  new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','style','aria-hidden','aria-current','aria-selected','data-proto-scope','data-zann-scope','data-zmann-scope','data-page-scope']});
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',schedule,{once:true}):schedule();
})();<\/script>`;

function injectBeforeBodyEnd(source: string, value: string): string {
  const matches = [...source.matchAll(/<\/body\s*>/ig)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) return `${source}${value}`;
  return `${source.slice(0, last.index)}${value}${source.slice(last.index)}`;
}

function activeRuntimePatches(commands: EditorCommand[], cursor = commands.length): EditorPatch[] {
  const unsafeLegacyContainers = new Set(["div", "main", "section", "article", "nav", "aside", "header", "footer", "form", "table", "ul", "ol"]);
  return commands.slice(0, cursor).flatMap((command) => command.patches.flatMap((patch) => {
    const legacyGlobal = !patch.target.runtimeScope && !Array.isArray(patch.target.runtimePath);
    const replacesDynamicShell = legacyGlobal
      && patch.type === "set-inner-html"
      && !patch.target.existingId
      && unsafeLegacyContainers.has(patch.target.tagName.toLowerCase());
    if (replacesDynamicShell) return [];
    return [{
      ...patch,
      target: {
        ...patch.target,
        runtimePageId: patch.target.runtimePageId || command.pageId,
        runtimeScope: patch.target.runtimeScope || (Array.isArray(patch.target.runtimePath) ? "page" : "global"),
      },
    }];
  }));
}

export function injectPatchRuntime(source: string, commands: EditorCommand[], cursor = commands.length, sessionId = "preview", forceRuntime = false): string {
  const patches = activeRuntimePatches(commands, cursor);
  if (!patches.length) return forceRuntime && !source.includes("data-he-patch-runtime") ? injectBeforeBodyEnd(source, PATCH_RUNTIME) : source;
  const payload = JSON.stringify(patches).replace(/</g, "\\u003c");
  const data = `<script type="application/json" data-he-patches="${escapeAttribute(sessionId, '"')}">${payload}<\/script>`;
  return injectBeforeBodyEnd(source, `${data}${source.includes("data-he-patch-runtime") ? "" : PATCH_RUNTIME}`);
}

function sessionSummary(session: SessionRecord, includePatches = false) {
  return {
    sessionId: session.sessionId,
    sourcePath: session.sourcePath,
    sourceName: basename(session.sourcePath),
    platform: session.platform,
    pages: session.pages,
    surfaces: session.surfaces || [],
    cursor: session.cursor,
    commandCount: session.commands.length,
    rejectedCommandCount: session.rejectedCommands?.length || 0,
    canUndo: session.cursor > 0,
    canRedo: session.cursor < session.commands.length,
    ui: session.ui,
    status: session.status,
    outputPath: session.outputPath,
    lastError: session.lastError,
    ...(includePatches ? { patches: activeRuntimePatches(session.commands, session.cursor) } : {}),
  };
}

export function repairSession(source: string, session: SessionRecord): { changed: boolean; message?: string } {
  if (session.patchMode === "runtime") return { changed: false };
  const draft = applyCommands(source, session.commands, session.cursor);
  if (!draft.errors.length) return { changed: false };
  const firstRejected = draft.applied;
  const rejected = session.commands.slice(firstRejected);
  const reason = draft.errors[0];
  const rejectedAt = new Date().toISOString();
  session.rejectedCommands ||= [];
  session.rejectedCommands.push(...rejected.map((command) => ({ command, reason, rejectedAt })));
  session.commands = session.commands.slice(0, firstRejected);
  session.cursor = session.commands.length;
  session.lastError = `已恢复到最后有效状态，${rejected.length} 条无法重放的操作已归档：${reason}`;
  session.updatedAt = rejectedAt;
  return { changed: true, message: session.lastError };
}

async function loadOrCreateSession(sourcePath: string, inspection: InspectionReport, forceNew = false): Promise<{ manifest: ManifestRecord; session: SessionRecord }> {
  const root = sessionRoot(sourcePath);
  await mkdir(join(root, "sessions"), { recursive: true });
  const existingMap = existsSync(pageMapPath(sourcePath)) ? await readJson<PageMapRecord>(pageMapPath(sourcePath)).catch(() => null) : null;
  if (!existingMap || existingMap.sourceHash !== inspection.sourceHash) {
    await writeJson(pageMapPath(sourcePath), {
      schemaVersion: 1,
      sourceHash: inspection.sourceHash,
      source: "automatic",
      createdAt: new Date().toISOString(),
      pages: inspection.pages,
      surfaces: inspection.surfaces,
    } satisfies PageMapRecord);
  }
  let manifest: ManifestRecord | null = null;
  if (existsSync(manifestPath(sourcePath))) manifest = await readJson<ManifestRecord>(manifestPath(sourcePath));
  if (!forceNew && manifest?.activeSessionId) {
    const activePath = sessionPath(sourcePath, manifest.activeSessionId);
    if (existsSync(activePath)) {
      const active = await readJson<SessionRecord>(activePath);
      if (active.status === "active" && active.sourceHash === inspection.sourceHash) {
        if (active.patchMode !== "runtime") {
          const source = await readFile(sourcePath, "utf8");
          const repair = repairSession(source, active);
          if (repair.changed) await writeJson(activePath, active);
        }
        return { manifest, session: active };
      }
    }
  }
  const sessionId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  const session: SessionRecord = {
    schemaVersion: 1,
    patchMode: "runtime",
    sessionId,
    prototypeKey: prototypeKey(sourcePath),
    sourcePath: normalizePath(sourcePath),
    sourceHash: inspection.sourceHash,
    platform: inspection.platform,
    pages: inspection.pages,
    surfaces: inspection.surfaces,
    commands: [],
    rejectedCommands: [],
    cursor: 0,
    ui: {},
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  manifest = {
    schemaVersion: 1,
    prototypeKey: session.prototypeKey,
    sourcePath: session.sourcePath,
    activeSessionId: sessionId,
    sessions: [...new Set([...(manifest?.sessions || []), sessionId])],
  };
  await writeJson(sessionPath(sourcePath, sessionId), session);
  await writeJson(manifestPath(sourcePath), manifest);
  return { manifest, session };
}

async function readRequestJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > 12 * 1024 * 1024) throw new Error("请求内容超过 12MB 限制。");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function sendText(response: ServerResponse, statusCode: number, value: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(statusCode, { "Content-Type": contentType, "Cache-Control": "no-store" });
  response.end(value);
}

function safeAssetPath(urlPath: string): string | null {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const candidate = resolve(editorAppDir, relative);
  const root = `${resolve(editorAppDir)}${sep}`.toLowerCase();
  return candidate.toLowerCase().startsWith(root) ? candidate : null;
}

async function serveAsset(response: ServerResponse, path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return sendText(response, 404, "Not found");
  response.writeHead(200, { "Content-Type": MIME[extname(path).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(path).pipe(response);
}

function validateCommand(value: any): EditorCommand {
  if (!value || typeof value !== "object" || !Array.isArray(value.patches) || !value.patches.length) throw new Error("修改命令不能为空。");
  if (value.patches.length > 100) throw new Error("单次修改包含过多补丁。");
  for (const patch of value.patches) {
    if (!ALLOWED_PATCHES.has(patch.type)) throw new Error(`不支持的补丁类型：${patch.type}`);
    if (!patch.target || (!Array.isArray(patch.target.domPath) && !Array.isArray(patch.target.runtimePath)) || !patch.target.tagName) throw new Error("补丁缺少稳定目标。");
  }
  return {
    id: String(value.id || randomBytes(6).toString("hex")),
    label: String(value.label || "修改元素").slice(0, 80),
    pageId: String(value.pageId || "page:main"),
    patches: value.patches,
    createdAt: String(value.createdAt || new Date().toISOString()),
  };
}

async function startEditorServer(sourcePath: string, manifest: ManifestRecord, initialSession: SessionRecord): Promise<{ server: http.Server; url: string }> {
  let session = initialSession;
  let persistQueue: Promise<void> = Promise.resolve();
  const persist = async (): Promise<void> => {
    session.updatedAt = new Date().toISOString();
    const snapshot = JSON.parse(JSON.stringify(session)) as SessionRecord;
    const write = persistQueue.then(() => writeJson(sessionPath(sourcePath, snapshot.sessionId), snapshot));
    persistQueue = write.catch(() => undefined);
    await write;
  };
  const server = http.createServer(async (request, response) => {
    try {
      const diskSession = await readJson<SessionRecord>(sessionPath(sourcePath, session.sessionId)).catch(() => null);
      if (diskSession && diskSession.updatedAt > session.updatedAt) session = diskSession;
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") return serveAsset(response, join(editorAppDir, "index.html"));
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
        return response.end();
      }
      if (request.method === "GET" && url.pathname.startsWith("/editor-assets/")) {
        const asset = safeAssetPath(url.pathname.slice("/editor-assets/".length));
        return asset ? serveAsset(response, asset) : sendText(response, 403, "Forbidden");
      }
      if (request.method === "GET" && url.pathname === "/preview") {
        if (session.status === "applied" && session.outputPath && existsSync(session.outputPath)) {
          return sendText(response, 200, await readFile(session.outputPath, "utf8"), "text/html; charset=utf-8");
        }
        const currentSource = await readFile(sourcePath, "utf8");
        let previewHtml = injectPatchRuntime(currentSource, session.commands, session.cursor, session.sessionId, true);
        const consoleFilter = `<script data-he-runtime>(()=>{if(!window.__heOriginalConsoleError)window.__heOriginalConsoleError=console.error;console.error=(...a)=>{if(String(a[0]||'').includes('原型标注入口被业务界面遮挡'))return;window.__heOriginalConsoleError.apply(console,a)}})();<\/script>`;
        const bootstrap = consoleFilter;
        previewHtml = /<head(?:\s[^>]*)?>/i.test(previewHtml)
          ? previewHtml.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bootstrap}`)
          : bootstrap + previewHtml;
        return sendText(response, 200, previewHtml, "text/html; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") return sendJson(response, 200, sessionSummary(session));
      if (request.method === "POST" && url.pathname === "/api/command") {
        if (session.status !== "active") throw new Error("当前 session 已结束，不能继续记录修改。请对新版本重新打开编辑器。");
        const command = validateCommand(await readRequestJson(request));
        session.patchMode = "runtime";
        session.commands = [...session.commands.slice(0, session.cursor), command];
        session.cursor = session.commands.length;
        session.lastError = undefined;
        await persist();
        return sendJson(response, 200, sessionSummary(session, true));
      }
      if (request.method === "POST" && url.pathname === "/api/history") {
        if (session.status !== "active") throw new Error("当前 session 已结束，不能撤销或重做。");
        const body = await readRequestJson(request);
        let command: EditorCommand | undefined;
        if (body.action === "undo" && session.cursor > 0) {
          command = session.commands[session.cursor - 1];
          session.cursor -= 1;
        } else if (body.action === "redo" && session.cursor < session.commands.length) {
          command = session.commands[session.cursor];
          session.cursor += 1;
        }
        await persist();
        return sendJson(response, 200, { ...sessionSummary(session, true), history: command ? { action: body.action, command } : undefined });
      }
      if (request.method === "POST" && url.pathname === "/api/pages") {
        const body = await readRequestJson(request);
        if (!Array.isArray(body.pages) || !body.pages.length) throw new Error("页面映射不能为空。");
        session.pages = body.pages;
        await persist();
        return sendJson(response, 200, sessionSummary(session));
      }
      if (request.method === "POST" && url.pathname === "/api/ui") {
        const body = await readRequestJson(request);
        session.ui = typeof body.ui === "object" && body.ui ? body.ui : {};
        await persist();
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/api/health") return sendJson(response, 200, { status: "ready", sessionId: session.sessionId });
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法获取本地预览端口。");
  const url = `http://127.0.0.1:${address.port}/`;
  session.server = { pid: process.pid, url };
  manifest.server = { pid: process.pid, url, sessionId: session.sessionId };
  await persist();
  await writeJson(manifestPath(sourcePath), manifest);
  return { server, url };
}

function nextVersionPath(sourcePath: string): string {
  const parsed = parsePath(sourcePath);
  const version = parsed.name.match(/^(.*)-v(\d+)\.(\d+)$/i);
  const base = version ? version[1] : parsed.name;
  const major = version ? Number(version[2]) : 1;
  let minor = version ? Number(version[3]) + 1 : 1;
  let candidate = join(parsed.dir, `${base}-v${major}.${minor}${parsed.ext}`);
  while (existsSync(candidate)) {
    minor += 1;
    candidate = join(parsed.dir, `${base}-v${major}.${minor}${parsed.ext}`);
  }
  return candidate;
}

function auditFinalHtml(html: string): string[] {
  const errors: string[] = [];
  if (!/<html\b/i.test(html) || !/<body\b/i.test(html)) errors.push("输出缺少完整 html/body 结构。");
  if (/data-html-editor-status|he-runtime-style|moveable-control-box|selecto-selection/i.test(html)) errors.push("输出残留编辑器运行时标记。");
  return errors;
}

async function resolveTarget(value: string | undefined): Promise<string> {
  if (!value) throw new Error("缺少目标 HTML 路径。");
  const path = resolve(value);
  if (extname(path).toLowerCase() !== ".html") throw new Error("目标必须是 .html 文件。");
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`目标文件不存在：${path}`);
  return path;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function commandInspect(target: string, args: string[]): Promise<void> {
  const fresh = args.includes("--fresh");
  const replaceMap = args.includes("--replace-map");
  const inspection = await inspectHtml(target, !fresh);
  if (fresh) {
    const existing = existsSync(pageMapPath(target)) ? await readJson<PageMapRecord>(pageMapPath(target)).catch(() => null) : null;
    if (replaceMap || existing?.source !== "agent") {
      await writeJson(pageMapPath(target), {
        schemaVersion: 1,
        sourceHash: inspection.sourceHash,
        source: "automatic",
        createdAt: new Date().toISOString(),
        pages: inspection.pages,
        surfaces: inspection.surfaces,
      } satisfies PageMapRecord);
    }
  }
  console.log(JSON.stringify(inspection, null, 2));
}

function validatePageMapPages(value: unknown): PageDefinition[] {
  const pages = Array.isArray(value) ? value : (value as any)?.pages;
  if (!Array.isArray(pages) || !pages.length) throw new Error("页面映射必须包含非空 pages 数组。");
  const ids = new Set<string>();
  return pages.map((page: any, index: number) => {
    const key = String(page?.key || page?.id || "").replace(/^page:/, "").trim();
    const title = String(page?.title || "").trim();
    const selector = String(page?.selector || "").trim();
    if (!key || !title || !selector) throw new Error(`第 ${index + 1} 个页面缺少 key、title 或 selector。`);
    const id = `page:${key}`;
    if (ids.has(id)) throw new Error(`页面 ID 重复：${id}`);
    ids.add(id);
    return {
      id,
      key,
      title,
      scope: id,
      selector,
      source: "agent-map",
      confidence: page.confidence === "medium" ? "medium" : "high",
      group: page.group ? String(page.group) : undefined,
      rootSelector: page.rootSelector ? String(page.rootSelector) : undefined,
      activeSelector: page.activeSelector ? String(page.activeSelector) : undefined,
      openFunction: page.openFunction ? String(page.openFunction) : undefined,
      template: page.template ? String(page.template) : undefined,
    };
  });
}

function validatePageMapSurfaces(value: unknown, pages: PageDefinition[]): SurfaceDefinition[] {
  const surfaces = (value as any)?.surfaces;
  if (surfaces === undefined) return [];
  if (!Array.isArray(surfaces)) throw new Error("交互面映射 surfaces 必须是数组。");
  const pageIds = new Set(pages.map((page) => page.id));
  const ids = new Set<string>();
  return surfaces.map((surface: any, index: number) => {
    const rawId = String(surface?.id || `surface-${index + 1}`).replace(/^surface:/, "").trim();
    const id = `surface:${rawId}`;
    const title = String(surface?.title || "").trim();
    const kind = String(surface?.kind || "panel") as SurfaceDefinition["kind"];
    const rawPageId = String(surface?.pageId || "").trim();
    const pageId = rawPageId.startsWith("page:") ? rawPageId : `page:${rawPageId}`;
    const rootSelector = String(surface?.rootSelector || "").trim();
    if (!rawId || !title || !rootSelector || !pageIds.has(pageId)) throw new Error(`第 ${index + 1} 个交互面缺少有效 id、title、pageId 或 rootSelector。`);
    if (!(["drawer", "modal", "popover", "panel"] as string[]).includes(kind)) throw new Error(`交互面类型无效：${kind}`);
    if (ids.has(id)) throw new Error(`交互面 ID 重复：${id}`);
    ids.add(id);
    return {
      id,
      title,
      kind,
      pageId,
      parentId: surface.parentId ? `surface:${String(surface.parentId).replace(/^surface:/, "")}` : undefined,
      rootSelector,
      contentSelector: surface.contentSelector ? String(surface.contentSelector) : undefined,
      openSelector: surface.openSelector ? String(surface.openSelector) : undefined,
      openFunction: surface.openFunction ? String(surface.openFunction) : undefined,
      openArgs: Array.isArray(surface.openArgs) ? surface.openArgs : undefined,
      activeSelector: surface.activeSelector ? String(surface.activeSelector) : undefined,
    };
  });
}

async function commandPageMap(target: string, args: string[]): Promise<void> {
  const input = option(args, "--input");
  if (!input) throw new Error("page-map 命令缺少 --input JSON 文件。");
  const inputPath = resolve(input);
  if (!existsSync(inputPath)) throw new Error(`页面映射文件不存在：${inputPath}`);
  const value = JSON.parse(await readFile(inputPath, "utf8"));
  const pages = validatePageMapPages(value);
  const surfaces = validatePageMapSurfaces(value, pages);
  const inspection = await inspectHtml(target, false);
  const record: PageMapRecord = {
    schemaVersion: 1,
    sourceHash: inspection.sourceHash,
    source: "agent",
    createdAt: new Date().toISOString(),
    pages,
    surfaces,
  };
  await writeJson(pageMapPath(target), record);
  console.log(JSON.stringify({ status: "pass", sourcePath: normalizePath(target), sourceHash: inspection.sourceHash, pageCount: pages.length, surfaceCount: surfaces.length, pageMapPath: normalizePath(pageMapPath(target)) }, null, 2));
}

async function commandServe(target: string, args: string[]): Promise<void> {
  if (!existsSync(join(editorAppDir, "index.html"))) throw new Error("编辑器静态资源不存在，请先构建 Skill。");
  const inspection = await inspectHtml(target);
  const { manifest, session } = await loadOrCreateSession(target, inspection, args.includes("--new-session"));
  const { server, url } = await startEditorServer(target, manifest, session);
  console.log(JSON.stringify({ status: "ready", sessionId: session.sessionId, editUrl: url, sourcePath: normalizePath(target), pages: session.pages.length, surfaces: session.surfaces?.length || 0 }));
  const close = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

async function commandStatus(target: string): Promise<void> {
  if (!existsSync(manifestPath(target))) throw new Error("目标 HTML 没有编辑 session。");
  const manifest = await readJson<ManifestRecord>(manifestPath(target));
  if (!manifest.activeSessionId) throw new Error("目标 HTML 没有活动 session。");
  const session = await readJson<SessionRecord>(sessionPath(target, manifest.activeSessionId));
  console.log(JSON.stringify({ ...sessionSummary(session), sourceHash: session.sourceHash, server: manifest.server }, null, 2));
}

async function commandValidate(target: string, args: string[]): Promise<void> {
  const inspection = await inspectHtml(target);
  const errors: string[] = [];
  let sessionResult: Record<string, unknown> | null = null;
  const requestedSession = option(args, "--session");
  if (requestedSession || existsSync(manifestPath(target))) {
    const manifest = existsSync(manifestPath(target)) ? await readJson<ManifestRecord>(manifestPath(target)) : null;
    const sessionId = requestedSession || manifest?.activeSessionId || undefined;
    if (sessionId && existsSync(sessionPath(target, sessionId))) {
      const session = await readJson<SessionRecord>(sessionPath(target, sessionId));
      const source = await readFile(target, "utf8");
      if (sha256(source) !== session.sourceHash) errors.push("源文件已在 session 创建后发生变化。");
      const activeCommands = session.commands.slice(0, session.cursor);
      for (const command of activeCommands) {
        for (const patch of command.patches) {
          if (!patch.target.existingId && !Array.isArray(patch.target.runtimePath) && !Array.isArray(patch.target.domPath)) errors.push(`${command.label} 缺少页面内定位信息。`);
        }
      }
      const draft = injectPatchRuntime(source, session.commands, session.cursor, sessionId);
      errors.push(...auditFinalHtml(draft));
      sessionResult = { sessionId, cursor: session.cursor, commandCount: session.commands.length, appliedCommands: activeCommands.length };
    }
  }
  console.log(JSON.stringify({ status: errors.length ? "fail" : inspection.status, inspection, session: sessionResult, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}

async function commandApply(target: string, args: string[]): Promise<void> {
  if (!existsSync(manifestPath(target))) throw new Error("目标 HTML 没有编辑 session。");
  const manifest = await readJson<ManifestRecord>(manifestPath(target));
  const sessionId = option(args, "--session") || manifest.activeSessionId;
  if (!sessionId || !existsSync(sessionPath(target, sessionId))) throw new Error("找不到指定 session。");
  const session = await readJson<SessionRecord>(sessionPath(target, sessionId));
  const source = await readFile(target, "utf8");
  if (sha256(source) !== session.sourceHash) {
    session.status = "conflict";
    session.updatedAt = new Date().toISOString();
    await writeJson(sessionPath(target, sessionId), session);
    throw new Error("源文件已在编辑期间变化，已停止写回。请保留 session 并人工确认差异。");
  }
  const draft = injectPatchRuntime(source, session.commands, session.cursor, sessionId);
  const auditErrors = auditFinalHtml(draft);
  if (auditErrors.length) throw new Error(auditErrors.join("\n"));
  const outputPath = nextVersionPath(target);
  await writeFile(outputPath, draft, { encoding: "utf8", flag: "wx" });
  session.status = "applied";
  session.outputPath = normalizePath(outputPath);
  session.updatedAt = new Date().toISOString();
  manifest.activeSessionId = null;
  await writeJson(sessionPath(target, sessionId), session);
  await writeJson(manifestPath(target), manifest);
  const affectedPages = [...new Set(session.commands.slice(0, session.cursor).map((command) => command.pageId))];
  console.log(JSON.stringify({
    status: "pass",
    sessionId,
    outputPath: normalizePath(outputPath),
    originalUnchanged: true,
    appliedCommands: session.cursor,
    verificationPlan: {
      mode: affectedPages.length ? "incremental" : "automatic-only",
      affectedPages,
      browserChecks: affectedPages.map((pageId) => ({ pageId, checks: ["页面可打开", "原交互可执行", "修改结果可见"] })),
    },
  }, null, 2));
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, targetValue] = args;
  if (!["inspect", "page-map", "serve", "status", "apply", "validate"].includes(command || "")) {
    throw new Error("用法：html-editor-session.mjs <inspect|page-map|serve|status|apply|validate> <file.html> [--input map.json] [--session id] [--new-session] [--fresh] [--replace-map]");
  }
  const target = await resolveTarget(targetValue);
  if (command === "inspect") return commandInspect(target, args);
  if (command === "page-map") return commandPageMap(target, args);
  if (command === "serve") return commandServe(target, args);
  if (command === "status") return commandStatus(target);
  if (command === "apply") return commandApply(target, args);
  return commandValidate(target, args);
}

const launchedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (launchedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
