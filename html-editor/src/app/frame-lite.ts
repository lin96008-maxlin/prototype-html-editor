import type { EditorCommand, EditorMode, EditorPatch, ElementTarget, PageDefinition, SelectionSnapshot, SurfaceDefinition, TreeNode } from "./types";

interface FrameCallbacks {
  onCommand: (command: EditorCommand) => Promise<EditorPatch[]>;
  onCommandRejected: () => void;
  onTree: (tree: TreeNode[], currentPageId: string) => void;
  onSelection: (selection: SelectionSnapshot | null) => void;
  onContextMenu: (value: { x: number; y: number } | null) => void;
  onModeToggle: () => void;
  onHistory: (action: "undo" | "redo") => Promise<void>;
  onSave: () => void;
  onZoomWheel: (deltaY: number) => void;
  onZoomCommand: (action: "in" | "out" | "fit") => void;
  onStatus: (message: string) => void;
}

type DragState = {
  startX: number;
  startY: number;
  moved: boolean;
  axis: "x" | "y" | null;
  entries: Array<{ element: HTMLElement; target: ElementTarget; before: string | null; left: number; top: number }>;
};

type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

type ResizeState = {
  direction: ResizeDirection;
  element: HTMLElement;
  target: ElementTarget;
  before: string | null;
  startX: number;
  startY: number;
  width: number;
  height: number;
  left: number;
  top: number;
  moved: boolean;
};

type EditingState = {
  element: HTMLElement;
  target: ElementTarget;
  before: string;
  keydown: (event: KeyboardEvent) => void;
};

type OverlayBinding = {
  id: string;
  root: HTMLElement;
  content: HTMLElement;
  opener?: HTMLElement;
  openFunction?: string;
  openArgs?: unknown[];
  pageId: string;
  parentId?: string;
  kind: "弹窗" | "抽屉" | "浮层" | "面板";
  label: string;
};

const RUNTIME_SELECTOR = "[data-he-runtime],[data-he-patch-runtime],script[data-he-patches],#he-runtime-style";
const TEXT_COMPONENT_SELECTOR = "span,strong,small,em,b,i,u,s,mark,time,code,kbd,abbr,sup,sub,caption,dt,dd,legend,summary";
const LEAF_SELECTOR = `button,a,input,select,textarea,label,img,video,audio,iframe,canvas,svg,h1,h2,h3,h4,h5,h6,p,li,th,td,blockquote,pre,${TEXT_COMPONENT_SELECTOR}`;
const SELECTABLE = `${LEAF_SELECTOR},ul,ol,form,fieldset,table,section,article,main,nav,aside,header,footer,div`;
const SEMANTIC_CONTAINERS = new Set(["section", "article", "form", "fieldset", "table", "ul", "ol", "nav", "aside", "header", "footer"]);

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function visible(element: Element): boolean {
  const html = element as HTMLElement;
  const style = html.ownerDocument.defaultView?.getComputedStyle(html);
  return !html.hidden && html.getAttribute("aria-hidden") !== "true" && style?.display !== "none" && style?.visibility !== "hidden" && html.getClientRects().length > 0;
}

function visibleInViewport(element: Element): boolean {
  if (!visible(element)) return false;
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  return Boolean(view && rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight);
}

function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase();
}

function directText(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortText(value: string, length = 28): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
}

function typeLabel(tag: string): string {
  const labels: Record<string, string> = {
    section: "内容区", article: "内容区", header: "页头", footer: "页尾", nav: "导航", aside: "侧栏", div: "容器",
    form: "表单", fieldset: "表单分组", ul: "列表", ol: "有序列表", li: "列表项", table: "表格", th: "表头单元格", td: "单元格",
    button: "按钮", a: "链接", input: "输入框", textarea: "多行输入框", select: "下拉框", label: "字段名称", img: "图片",
    video: "视频", audio: "音频", iframe: "嵌入页面", canvas: "画布", svg: "图形", h1: "一级标题", h2: "二级标题",
    h3: "三级标题", h4: "四级标题", h5: "五级标题", h6: "六级标题", p: "文字", blockquote: "引用", pre: "文本块",
    span: "文字", strong: "文字", small: "文字", em: "文字", b: "文字", i: "文字", u: "文字", s: "文字", mark: "文字", time: "文字", code: "文字", kbd: "文字", abbr: "文字", sup: "文字", sub: "文字", caption: "文字", dt: "文字", dd: "文字", legend: "文字", summary: "文字",
  };
  return labels[tag] || "元素";
}

function labelFor(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const named = element.getAttribute("data-title") || element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.getAttribute("alt") || element.getAttribute("name");
  const own = directText(element);
  if (named || own) return shortText(named || own);
  if (SEMANTIC_CONTAINERS.has(tag) || tag === "div") {
    const heading = element.querySelector(":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > [class*='title'],:scope > [class*='header']");
    const headingText = heading?.textContent?.replace(/\s+/g, " ").trim();
    if (headingText) return shortText(headingText);
  }
  return typeLabel(tag);
}

function cleanClone(element: Element): Element {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll(RUNTIME_SELECTOR).forEach((node) => node.remove());
  clone.querySelectorAll("[data-he-selected],[data-he-editing],[data-he-dragging],[data-he-parent],[data-he-hover]").forEach((node) => {
    node.removeAttribute("data-he-selected");
    node.removeAttribute("data-he-editing");
    node.removeAttribute("data-he-dragging");
    node.removeAttribute("data-he-parent");
    node.removeAttribute("data-he-hover");
    node.removeAttribute("contenteditable");
  });
  clone.removeAttribute("data-he-selected");
  clone.removeAttribute("data-he-editing");
  clone.removeAttribute("data-he-dragging");
  clone.removeAttribute("data-he-parent");
  clone.removeAttribute("data-he-hover");
  clone.removeAttribute("contenteditable");
  return clone;
}

function cleanInnerHtml(element: Element): string {
  return cleanClone(element).innerHTML;
}

function clearDuplicateIdentity(element: Element): void {
  [element, ...Array.from(element.querySelectorAll("*"))].forEach((node) => {
    node.removeAttribute("id");
    node.removeAttribute("data-he-id");
  });
}

function parsePixel(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventElement(target: EventTarget | null): Element | null {
  return target && (target as Node).nodeType === 1 ? target as Element : null;
}

function isMeaningfulElement(element: Element): boolean {
  if (!element.matches(SELECTABLE) || !visible(element)) return false;
  const tag = element.tagName.toLowerCase();
  if (element.matches(TEXT_COMPONENT_SELECTOR)) return Boolean(element.textContent?.replace(/\s+/g, " ").trim());
  if (element.matches(LEAF_SELECTOR)) return true;
  if (SEMANTIC_CONTAINERS.has(tag)) return true;
  if (tag !== "div") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const children = Array.from(element.children).filter((child) => !child.matches(RUNTIME_SELECTOR));
  const hasIdentity = Boolean(element.id || element.getAttribute("data-ui") || element.getAttribute("aria-label") || directText(element));
  const hasVisualBoundary = Boolean(
    style
    && ((style.borderStyle !== "none" && parsePixel(style.borderWidth) > 0)
      || !["rgba(0, 0, 0, 0)", "transparent"].includes(style.backgroundColor)),
  );
  const isLayout = Boolean(style && (style.display.includes("flex") || style.display.includes("grid")) && children.length > 1);
  return hasIdentity || hasVisualBoundary || isLayout;
}

function isContainerElement(element: Element): boolean {
  return isMeaningfulElement(element)
    && !element.matches(LEAF_SELECTOR);
}

export class FrameController {
  private iframe: HTMLIFrameElement;
  private pages: PageDefinition[];
  private surfaces: SurfaceDefinition[];
  private callbacks: FrameCallbacks;
  private mode: EditorMode = "preview";
  private selected: HTMLElement[] = [];
  private hovered: HTMLElement[] = [];
  private visualOverlays: Array<{ overlay: HTMLElement; target: HTMLElement }> = [];
  private observer: MutationObserver | null = null;
  private boundDocument: Document | null = null;
  private rebuildTimer = 0;
  private clipboardHtml = "";
  private activePageId = "";
  private lastTree: TreeNode[] = [];
  private treePathByElement = new WeakMap<Element, string[]>();
  private pageRouteCache = new Map<string, string>();
  private navigating = false;
  private dispatchingBusinessClick = false;
  private queuedPage: { pageId: string; after?: () => void } | null = null;
  private dragState: DragState | null = null;
  private resizeState: ResizeState | null = null;
  private suppressClick = false;
  private suppressClickTimer = 0;
  private editingState: EditingState | null = null;
  private savedRange: Range | null = null;
  private selectionTimer = 0;
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(iframe: HTMLIFrameElement, pages: PageDefinition[], surfaces: SurfaceDefinition[], callbacks: FrameCallbacks) {
    this.iframe = iframe;
    this.pages = pages;
    this.surfaces = surfaces;
    this.callbacks = callbacks;
  }

  get document(): Document | null {
    return this.iframe.contentDocument;
  }

  get window(): Window | null {
    return this.iframe.contentWindow;
  }

  attach(mode: EditorMode): void {
    this.destroyRuntime();
    this.mode = mode;
    const document = this.document;
    if (!document?.body) return;
    this.installRuntimeStyle();
    this.bindDocumentEvents();
    this.activePageId = this.detectPageId() || this.activePageId || this.pages[0]?.id || "page:main";
    this.observer = new MutationObserver(() => this.scheduleTree());
    this.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "aria-hidden", "aria-current", "aria-selected", "data-proto-scope", "data-zann-scope", "data-zmann-scope", "data-page-scope"] });
    this.rebuildTree();
  }

  setMode(mode: EditorMode): void {
    this.finishTextEdit(false);
    this.attach(mode);
  }

  setPages(pages: PageDefinition[]): void {
    this.pages = pages;
    this.rebuildTree();
  }

  destroy(): void {
    this.finishTextEdit(false);
    this.destroyRuntime();
    this.document?.getElementById("he-runtime-style")?.remove();
  }

  private destroyRuntime(): void {
    const document = this.boundDocument;
    if (document) {
      document.removeEventListener("click", this.onClick, true);
      document.removeEventListener("dblclick", this.onDoubleClick, true);
      document.removeEventListener("contextmenu", this.onContextMenu, true);
      document.removeEventListener("keydown", this.onKeyDown, true);
      document.removeEventListener("wheel", this.onWheel, true);
      document.removeEventListener("mousedown", this.onMouseDown, true);
      document.removeEventListener("mousemove", this.onMouseMove, true);
      document.removeEventListener("mouseup", this.onMouseUp, true);
      document.removeEventListener("mouseout", this.onMouseOut, true);
      document.removeEventListener("scroll", this.updateEditorGeometry, true);
      document.removeEventListener("selectionchange", this.onSelectionChange, true);
      document.defaultView?.removeEventListener("resize", this.updateEditorGeometry);
    }
    this.boundDocument = null;
    this.observer?.disconnect();
    this.observer = null;
    window.clearTimeout(this.rebuildTimer);
    window.clearTimeout(this.selectionTimer);
    window.clearTimeout(this.suppressClickTimer);
    this.dragState = null;
    this.resizeState = null;
    this.savedRange = null;
    this.removeResizeHandles();
    this.clearHover(false);
    this.removeVisualOverlays();
    this.selected.forEach((element) => {
      element.removeAttribute("data-he-selected");
      element.removeAttribute("data-he-dragging");
    });
    document?.querySelectorAll("[data-he-parent]").forEach((element) => element.removeAttribute("data-he-parent"));
    this.selected = [];
  }

  private installRuntimeStyle(): void {
    const document = this.document!;
    let style = document.getElementById("he-runtime-style") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "he-runtime-style";
      style.dataset.heRuntime = "true";
      document.head.appendChild(style);
    }
    style.textContent = this.mode === "edit" ? `
      [data-he-selected="true"],[data-he-selected="true"] *{cursor:move!important}
      [data-he-editing="true"],[data-he-editing="true"] *{cursor:text!important}
      .he-outline{position:fixed!important;z-index:2147483598!important;box-sizing:border-box!important;pointer-events:none!important;background:transparent!important}
      .he-outline-hover{border:2px solid rgba(15,159,143,.82)!important;box-shadow:0 0 0 1px rgba(255,255,255,.82)!important}
      .he-outline-parent{z-index:2147483599!important;border:1px dashed rgba(71,84,103,.9)!important;box-shadow:0 0 0 1px rgba(255,255,255,.72)!important}
      .he-outline-selected{z-index:2147483600!important;border:2px solid #3b82f6!important;box-shadow:0 0 0 1px rgba(255,255,255,.9)!important}
      .he-outline-selected.he-outline-editing{border-color:#0f766e!important}
      .he-resize-handle{position:fixed!important;z-index:2147483601!important;pointer-events:auto!important}
      .he-resize-n,.he-resize-s{height:9px!important;margin-top:-4.5px!important;border:0!important;background:transparent!important}
      .he-resize-e,.he-resize-w{width:9px!important;margin-left:-4.5px!important;border:0!important;background:transparent!important}
      .he-resize-ne,.he-resize-se,.he-resize-sw,.he-resize-nw{width:9px!important;height:9px!important;margin:-4.5px 0 0 -4.5px!important;border:1px solid #fff!important;background:#3b82f6!important;box-shadow:0 0 0 1px #2563eb!important}
      .he-resize-n,.he-resize-s{cursor:ns-resize!important}.he-resize-e,.he-resize-w{cursor:ew-resize!important}
      .he-resize-ne,.he-resize-sw{cursor:nesw-resize!important}.he-resize-nw,.he-resize-se{cursor:nwse-resize!important}
    ` : "";
  }

  private bindDocumentEvents(): void {
    const document = this.document!;
    this.boundDocument = document;
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("dblclick", this.onDoubleClick, true);
    document.addEventListener("contextmenu", this.onContextMenu, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    document.addEventListener("mousedown", this.onMouseDown, true);
    document.addEventListener("mousemove", this.onMouseMove, true);
    document.addEventListener("mouseup", this.onMouseUp, true);
    document.addEventListener("mouseout", this.onMouseOut, true);
    document.addEventListener("scroll", this.updateEditorGeometry, true);
    document.addEventListener("selectionchange", this.onSelectionChange, true);
    document.defaultView?.addEventListener("resize", this.updateEditorGeometry);
  }

  private onWheel = (event: WheelEvent): void => {
    if (this.mode !== "edit" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    event.stopPropagation();
    this.callbacks.onZoomWheel(event.deltaY);
  };

  private onMouseDown = (event: MouseEvent): void => {
    if (this.mode !== "edit" || event.button !== 0) return;
    const handle = eventElement(event.target)?.closest<HTMLElement>("[data-he-resize-handle]");
    if (handle && this.selected.length === 1) {
      this.finishTextEdit(false);
      const element = this.selected[0];
      const rect = element.getBoundingClientRect();
      const computed = this.window!.getComputedStyle(element);
      this.resizeState = {
        direction: handle.dataset.heResizeHandle as ResizeDirection,
        element,
        target: this.targetFor(element),
        before: element.getAttribute("style"),
        startX: event.clientX,
        startY: event.clientY,
        width: rect.width,
        height: rect.height,
        left: parsePixel(computed.left),
        top: parsePixel(computed.top),
        moved: false,
      };
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const raw = eventElement(event.target);
    if (this.editingState && raw && this.editingState.element.contains(raw)) return;
    const target = raw?.closest<HTMLElement>("[data-he-selected='true']") || null;
    if (!target || !this.selected.includes(target)) return;
    this.dragState = {
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      axis: null,
      entries: this.selected.map((element) => {
        const computed = this.window!.getComputedStyle(element);
        return { element, target: this.targetFor(element), before: element.getAttribute("style"), left: parsePixel(computed.left), top: parsePixel(computed.top) };
      }),
    };
    this.clearHover();
    this.window?.getSelection()?.removeAllRanges();
    event.preventDefault();
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.resizeState && !this.dragState) {
      this.updateHover(eventElement(event.target));
      return;
    }
    if (this.resizeState) {
      const state = this.resizeState;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (!state.moved && Math.hypot(dx, dy) < 2) return;
      state.moved = true;
      const west = state.direction.includes("w");
      const east = state.direction.includes("e");
      const north = state.direction.includes("n");
      const south = state.direction.includes("s");
      const width = Math.max(8, state.width + (east ? dx : west ? -dx : 0));
      const height = Math.max(8, state.height + (south ? dy : north ? -dy : 0));
      const computed = this.window!.getComputedStyle(state.element);
      if ((west || north) && computed.position === "static") state.element.style.position = "relative";
      state.element.style.boxSizing = "border-box";
      if (east || west) state.element.style.width = `${Math.round(width)}px`;
      if (north || south) state.element.style.height = `${Math.round(height)}px`;
      if (west) state.element.style.left = `${Math.round(state.left + dx)}px`;
      if (north) state.element.style.top = `${Math.round(state.top + dy)}px`;
      state.element.dataset.heDragging = "true";
      this.updateEditorGeometry();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!this.dragState) return;
    const rawX = event.clientX - this.dragState.startX;
    const rawY = event.clientY - this.dragState.startY;
    if (!this.dragState.moved && Math.hypot(rawX, rawY) < 4) return;
    this.dragState.moved = true;
    if (event.shiftKey && !this.dragState.axis) this.dragState.axis = Math.abs(rawX) >= Math.abs(rawY) ? "x" : "y";
    if (!event.shiftKey) this.dragState.axis = null;
    const dx = this.dragState.axis === "y" ? 0 : rawX;
    const dy = this.dragState.axis === "x" ? 0 : rawY;
    event.preventDefault();
    event.stopImmediatePropagation();
    for (const entry of this.dragState.entries) {
      const computed = this.window!.getComputedStyle(entry.element);
      if (computed.position === "static") entry.element.style.position = "relative";
      entry.element.style.left = `${Math.round(entry.left + dx)}px`;
      entry.element.style.top = `${Math.round(entry.top + dy)}px`;
      entry.element.dataset.heDragging = "true";
    }
    this.updateEditorGeometry();
  };

  private onMouseOut = (event: MouseEvent): void => {
    if (!event.relatedTarget) this.clearHover();
  };

  private onMouseUp = (event: MouseEvent): void => {
    if (this.resizeState) {
      const state = this.resizeState;
      this.resizeState = null;
      state.element.removeAttribute("data-he-dragging");
      if (state.moved) {
        const after = state.element.getAttribute("style");
        this.suppressImmediateClick();
        this.commit("调整元素大小", [{ type: "set-attribute", target: state.target, name: "style", value: after, before: state.before, after }]);
      }
      this.updateEditorGeometry();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!this.dragState) return;
    const state = this.dragState;
    this.dragState = null;
    state.entries.forEach(({ element }) => element.removeAttribute("data-he-dragging"));
    if (!state.moved) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.suppressImmediateClick();
    const patches = state.entries.flatMap(({ element, target, before }) => {
      const after = element.getAttribute("style");
      return before === after ? [] : [{ type: "set-attribute" as const, target, name: "style", value: after, before, after }];
    });
    this.commit("移动元素", patches);
  };

  private onClick = (event: MouseEvent): void => {
    if (this.dispatchingBusinessClick || this.mode !== "edit") return;
    if (this.suppressClick) {
      this.suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const raw = event.target as Element | null;
    if (raw?.closest("[data-he-resize-handle]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (this.editingState && raw && !this.editingState.element.contains(raw)) this.finishTextEdit(false);
    const candidates = this.selectionCandidates(raw);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!candidates.length) {
      this.handleBlankInteraction();
      return;
    }
    const additive = event.ctrlKey || event.metaKey;
    let target = additive || event.altKey ? candidates[candidates.length - 1] : candidates[0];
    if (!additive && !event.altKey && this.selected.length === 1) {
      const selected = this.selected[0];
      const current = candidates.indexOf(selected);
      if (current >= 0) target = candidates[Math.min(current + 1, candidates.length - 1)];
      else if (selected.contains(raw)) target = selected;
      else {
        const sibling = selected.parentElement ? candidates.find((candidate) => candidate.parentElement === selected.parentElement) : undefined;
        const clickedAncestor = [...candidates].reverse().find((candidate) => candidate.contains(selected));
        if (sibling) target = sibling;
        else if (clickedAncestor) target = clickedAncestor;
      }
    }
    this.select(target, additive);
  };

  private suppressImmediateClick(): void {
    window.clearTimeout(this.suppressClickTimer);
    this.suppressClick = true;
    this.suppressClickTimer = window.setTimeout(() => {
      this.suppressClick = false;
    }, 0);
  }

  private onDoubleClick = (event: MouseEvent): void => {
    if (this.mode !== "edit") return;
    const target = this.textEditTarget(event.target as Element | null);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.select(target, false);
    this.startTextEdit(target);
  };

  private onContextMenu = (event: MouseEvent): void => {
    if (this.mode !== "edit") return;
    const target = this.editableTarget(event.target as Element | null);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!this.selected.includes(target)) this.select(target, false);
    const rect = this.iframe.getBoundingClientRect();
    const scale = rect.width / Math.max(1, this.iframe.clientWidth);
    this.callbacks.onContextMenu({ x: rect.left + event.clientX * scale, y: rect.top + event.clientY * scale });
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    this.handleShortcut(event);
  };

  handleShortcut(event: KeyboardEvent): boolean {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && key === "e") {
      event.preventDefault();
      this.finishTextEdit(false);
      this.callbacks.onModeToggle();
      return true;
    }
    if (modifier && key === "s") {
      event.preventDefault();
      this.commitPendingTextEdit();
      this.callbacks.onSave();
      return true;
    }
    if (this.mode !== "edit" || this.isNativeEditing(event.target)) return false;
    if (modifier && key === "z") { event.preventDefault(); this.requestHistory(event.shiftKey ? "redo" : "undo"); }
    else if (modifier && key === "y") { event.preventDefault(); this.requestHistory("redo"); }
    else if (modifier && ["+", "="].includes(event.key)) { event.preventDefault(); this.callbacks.onZoomCommand("in"); }
    else if (modifier && event.key === "-") { event.preventDefault(); this.callbacks.onZoomCommand("out"); }
    else if (modifier && event.key === "0") { event.preventDefault(); this.callbacks.onZoomCommand("fit"); }
    else if (modifier && key === "c") { event.preventDefault(); this.copy(); }
    else if (modifier && key === "x") { event.preventDefault(); this.cut(); }
    else if (modifier && key === "v") { event.preventDefault(); this.paste(); }
    else if (modifier && key === "d") { event.preventDefault(); this.duplicate(); }
    else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); this.deleteSelected(); }
    else if (event.key === "Escape") { event.preventDefault(); this.clearSelection(); }
    else if (event.key === "Enter") { event.preventDefault(); this.editSelectedText(); }
    else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); this.nudge(event.key, event.shiftKey ? 10 : 1); }
    return event.defaultPrevented;
  }

  requestHistory(action: "undo" | "redo"): void {
    this.finishTextEdit(false);
    this.commandQueue = this.commandQueue.then(() => this.callbacks.onHistory(action));
  }

  handleBlankInteraction(): void {
    if (this.mode !== "edit") return;
    if (this.editingState) {
      this.finishTextEdit(false);
      this.callbacks.onSelection(this.snapshot());
      return;
    }
    this.clearSelection();
  }

  private isNativeEditing(target: EventTarget | null): boolean {
    const element = eventElement(target);
    return Boolean(element?.closest("input,textarea,select,[contenteditable='true']"));
  }

  private editableTarget(raw: Element | null): HTMLElement | null {
    if (!raw || raw.closest(RUNTIME_SELECTOR)) return null;
    const pageRoot = this.pageRoot(this.currentPageId());
    const root = pageRoot.contains(raw) ? pageRoot : this.document!.body;
    const element = raw.closest(SELECTABLE) as HTMLElement | null;
    return element && element !== root ? element : null;
  }

  private selectionCandidates(raw: Element | null): HTMLElement[] {
    if (!raw || raw.closest(RUNTIME_SELECTOR)) return [];
    const pageRoot = this.pageRoot(this.currentPageId());
    const root = pageRoot.contains(raw) ? pageRoot : this.document!.body;
    const candidates: HTMLElement[] = [];
    let current: Element | null = raw;
    while (current && current !== root && !["HTML", "HEAD", "BODY"].includes(current.tagName)) {
      if (isMeaningfulElement(current)) candidates.push(current as HTMLElement);
      current = current.parentElement;
    }
    return candidates.reverse();
  }

  private canEditText(element: HTMLElement): boolean {
    if (element.matches("input,textarea,select,option,img,video,audio,iframe,canvas,svg")) return false;
    if (!element.textContent?.replace(/\s+/g, " ").trim()) return false;
    return true;
  }

  private textEditTarget(raw: Element | null): HTMLElement | null {
    if (!raw || raw.closest(RUNTIME_SELECTOR)) return null;
    const pageRoot = this.pageRoot(this.currentPageId());
    const boundary = pageRoot.contains(raw) ? pageRoot : this.document!.body;
    let current: Element | null = raw;
    while (current && current !== boundary && !["HTML", "HEAD", "BODY"].includes(current.tagName)) {
      if (this.canEditText(current as HTMLElement)) return current as HTMLElement;
      current = current.parentElement;
    }
    return null;
  }

  private activeTextRange(): Range | null {
    const selection = this.window?.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !this.selected.length) return null;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
    return container && this.selected.some((element) => element === container || element.contains(container)) ? range : null;
  }

  private onSelectionChange = (): void => {
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => {
      const range = this.activeTextRange();
      this.savedRange = range?.cloneRange() || null;
      if (this.selected.length) this.callbacks.onSelection(this.snapshot());
    }, 20);
  };

  select(element: HTMLElement, additive: boolean): void {
    const next = additive ? [...this.selected] : [];
    const index = next.indexOf(element);
    if (additive && index >= 0) next.splice(index, 1);
    else next.push(element);
    this.selectMany(next);
  }

  private selectMany(elements: HTMLElement[]): void {
    this.selected.forEach((element) => element.removeAttribute("data-he-selected"));
    this.document?.querySelectorAll("[data-he-parent]").forEach((element) => element.removeAttribute("data-he-parent"));
    this.clearHover(false);
    this.selected = [...new Set(elements.filter((element) => element.isConnected))];
    this.selected.forEach((element) => element.setAttribute("data-he-selected", "true"));
    if (this.selected.length === 1) this.directParentContainer(this.selected[0])?.setAttribute("data-he-parent", "true");
    this.renderResizeHandles();
    this.renderVisualOverlays();
    this.callbacks.onSelection(this.snapshot());
    this.callbacks.onContextMenu(null);
  }

  clearSelection(): void {
    this.selectMany([]);
  }

  private directParentContainer(element: HTMLElement): HTMLElement | null {
    let parent = element.parentElement;
    while (parent && !["BODY", "HTML"].includes(parent.tagName)) {
      if (isContainerElement(parent)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  private clearHover(render = true): void {
    this.hovered.forEach((element) => element.removeAttribute("data-he-hover"));
    this.hovered = [];
    if (render) this.renderVisualOverlays();
  }

  private updateHover(raw: Element | null): void {
    let next: HTMLElement[] = [];
    if (this.mode === "edit" && !this.editingState && raw && !raw.closest(RUNTIME_SELECTOR)) {
      const containers = this.selectionCandidates(raw).filter((element) => isContainerElement(element));
      if (containers.length) {
        let start = 0;
        if (this.selected.length === 1) {
          const selected = this.selected[0];
          const anchor = isContainerElement(selected) ? selected : this.directParentContainer(selected);
          if (anchor) {
            const current = containers.indexOf(anchor);
            if (current >= 0) start = current;
            else {
              const anchorParent = this.directParentContainer(anchor);
              start = containers.findIndex((container) => this.directParentContainer(container) === anchorParent);
              if (start < 0) start = Math.max(0, containers.length - 1);
            }
          } else start = Math.max(0, containers.length - 1);
        }
        if (start >= 0) next = containers.slice(start);
      }
    }
    const unchanged = next.length === this.hovered.length && next.every((element, index) => element === this.hovered[index]);
    if (unchanged) {
      this.updateVisualOverlays();
      return;
    }
    this.hovered.forEach((element) => element.removeAttribute("data-he-hover"));
    this.hovered = next;
    this.hovered.forEach((element) => element.setAttribute("data-he-hover", "true"));
    this.renderVisualOverlays();
  }

  private removeVisualOverlays(): void {
    this.visualOverlays.forEach(({ overlay }) => overlay.remove());
    this.visualOverlays = [];
  }

  private renderVisualOverlays(): void {
    this.removeVisualOverlays();
    const document = this.document;
    if (this.mode !== "edit" || !document?.body) return;
    const entries = new Map<HTMLElement, "hover" | "parent" | "selected">();
    this.hovered.filter((element) => element.isConnected).forEach((element) => entries.set(element, "hover"));
    document.querySelectorAll<HTMLElement>("[data-he-parent=true]").forEach((element) => entries.set(element, "parent"));
    this.selected.filter((element) => element.isConnected).forEach((element) => entries.set(element, "selected"));
    entries.forEach((kind, target) => {
      const overlay = document.createElement("div");
      overlay.dataset.heRuntime = "true";
      overlay.dataset.heOutline = kind;
      overlay.className = `he-outline he-outline-${kind}${kind === "selected" && target === this.editingState?.element ? " he-outline-editing" : ""}`;
      document.body.appendChild(overlay);
      this.visualOverlays.push({ overlay, target });
    });
    this.updateVisualOverlays();
  }

  private updateVisualOverlays(): void {
    const frameWindow = this.window;
    if (!frameWindow) return;
    this.visualOverlays.forEach(({ overlay, target }) => {
      if (!target.isConnected) {
        overlay.style.display = "none";
        return;
      }
      const rect = target.getBoundingClientRect();
      const computed = frameWindow.getComputedStyle(target);
      overlay.style.display = rect.width > 0 && rect.height > 0 ? "block" : "none";
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      overlay.style.borderRadius = computed.borderRadius;
    });
  }

  private updateEditorGeometry = (): void => {
    this.updateResizeHandles();
    this.updateVisualOverlays();
  };

  private removeResizeHandles(): void {
    this.document?.querySelectorAll("[data-he-resize-handle]").forEach((handle) => handle.remove());
  }

  private renderResizeHandles(): void {
    this.removeResizeHandles();
    const element = this.selected[0];
    if (this.mode !== "edit" || this.selected.length !== 1 || !element || ["THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "LI"].includes(element.tagName)) return;
    const document = this.document!;
    for (const direction of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as ResizeDirection[]) {
      const handle = document.createElement("div");
      handle.dataset.heResizeHandle = direction;
      handle.dataset.heRuntime = "true";
      handle.className = `he-resize-handle he-resize-${direction}`;
      document.body.appendChild(handle);
    }
    this.updateResizeHandles();
  }

  private updateResizeHandles = (): void => {
    const element = this.selected[0];
    const document = this.document;
    const frameWindow = this.window;
    if (!element || !document || !frameWindow) return;
    const rect = element.getBoundingClientRect();
    const x = rect.left;
    const y = rect.top;
    const points: Record<ResizeDirection, [number, number]> = {
      n: [x, y], ne: [x + rect.width, y], e: [x + rect.width, y], se: [x + rect.width, y + rect.height],
      s: [x, y + rect.height], sw: [x, y + rect.height], w: [x, y], nw: [x, y],
    };
    document.querySelectorAll<HTMLElement>("[data-he-resize-handle]").forEach((handle) => {
      const direction = handle.dataset.heResizeHandle as ResizeDirection;
      const point = points[direction];
      if (!point) return;
      handle.style.left = `${point[0]}px`;
      handle.style.top = `${point[1]}px`;
      handle.style.width = direction === "n" || direction === "s" ? `${rect.width}px` : "";
      handle.style.height = direction === "e" || direction === "w" ? `${rect.height}px` : "";
    });
  };

  private owningPageId(element: HTMLElement, currentPageId: string): string | undefined {
    const document = this.document;
    if (!document) return undefined;
    const currentRoot = this.pageRoot(currentPageId);
    if (currentRoot !== document.body && currentRoot.contains(element)) return currentPageId;
    for (const page of this.pages) {
      if (!page.rootSelector) continue;
      try {
        if (Array.from(document.querySelectorAll(page.rootSelector)).some((root) => root.contains(element))) return page.id;
      } catch {
        // Agent 映射校验会报告非法选择器，运行时继续尝试其他证据。
      }
    }
    const scopeRoot = element.closest<HTMLElement>("[data-proto-scope^='page:'],[data-zann-scope^='page:'],[data-zmann-scope^='page:'],[data-page-scope],.page,.screen");
    if (scopeRoot) {
      const scope = scopeRoot.getAttribute("data-proto-scope") || scopeRoot.getAttribute("data-zann-scope") || scopeRoot.getAttribute("data-zmann-scope") || scopeRoot.getAttribute("data-page-scope") || "";
      const idKey = scopeRoot.id.replace(/^page-/, "").replace(/-page$/, "");
      const key = scope.startsWith("page:") ? scope.replace(/^page:/, "").split(":")[0] : idKey;
      const page = this.pages.find((item) => item.key === key || item.id === `page:${key}`);
      if (page) return page.id;
    }
    return visibleInViewport(element) && !element.closest(".drawer,.modal,dialog,[role='dialog'],[aria-modal='true']") ? currentPageId : undefined;
  }

  private overlayBindings(pageId: string): OverlayBinding[] {
    const document = this.document;
    if (!document) return [];
    const mapped: OverlayBinding[] = this.surfaces.filter((surface) => surface.pageId === pageId).flatMap((surface) => {
      try {
        const root = document.querySelector<HTMLElement>(surface.rootSelector);
        const content = document.querySelector<HTMLElement>(surface.contentSelector || surface.rootSelector);
        if (!root || !content) return [];
        return [{
          id: surface.id,
          root,
          content,
          opener: surface.openSelector ? Array.from(document.querySelectorAll<HTMLElement>(surface.openSelector)).find(visibleInViewport) || document.querySelector<HTMLElement>(surface.openSelector) || undefined : undefined,
          openFunction: surface.openFunction,
          openArgs: surface.openArgs,
          pageId,
          parentId: surface.parentId,
          kind: surface.kind === "drawer" ? "抽屉" as const : surface.kind === "popover" ? "浮层" as const : surface.kind === "panel" ? "面板" as const : "弹窗" as const,
          label: surface.title,
        }];
      } catch {
        return [];
      }
    });
    const mappedElements = new Set(mapped.flatMap((binding) => [binding.root, binding.content]));
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(".drawer,.modal,dialog,[role='dialog'],[aria-modal='true'],.overlay,[data-proto-scope^='sheet:'],[data-proto-scope^='dialog:'],[data-zann-scope^='sheet:'],[data-zann-scope^='dialog:'],[data-zmann-scope^='sheet:'],[data-zmann-scope^='dialog:']"));
    const bindings: OverlayBinding[] = [];
    const seen = new Set<HTMLElement>();
    for (const candidate of candidates) {
      const shell = candidate.matches(".overlay,.modal-overlay") ? candidate : candidate.closest<HTMLElement>(".overlay,.modal-overlay");
      const content = candidate.matches(".overlay,.modal-overlay") ? candidate.querySelector<HTMLElement>(".modal,[role='dialog'],[aria-modal='true']") || candidate : candidate.matches(".drawer,.modal,dialog,[data-proto-scope],[data-zann-scope],[data-zmann-scope]") ? candidate : candidate.closest<HTMLElement>(".drawer,.modal,dialog,[data-proto-scope],[data-zann-scope],[data-zmann-scope]") || candidate;
      const root = shell || content;
      if (seen.has(root) || mappedElements.has(content) || !content.textContent?.trim()) continue;
      seen.add(root);
      if (mappedElements.has(root)) continue;
      const semantic = `${content.id} ${content.className} ${content.getAttribute("data-proto-scope") || ""} ${content.getAttribute("data-zann-scope") || ""} ${content.getAttribute("data-zmann-scope") || ""}`;
      const kind = content.matches(".drawer") || /drawer|sheet/i.test(semantic) ? "抽屉" : /popover/i.test(semantic) ? "浮层" : "弹窗";
      const title = content.querySelector<HTMLElement>(".drawer-title,.modal-title,[data-overlay-title],h1,h2,h3,h4")?.textContent?.replace(/\s+/g, " ").trim();
      bindings.push({ id: `surface:runtime:${content.id || bindings.length}`, root, content, pageId: "", kind, label: shortText(title || content.getAttribute("aria-label") || content.id || kind) });
    }

    const findById = (id: string): OverlayBinding | undefined => bindings.find(({ root, content }) => root.id === id || content.id === id);
    const records: Array<{ binding: OverlayBinding; opener: HTMLElement; ownerPageId?: string; parentId?: string; openFunction?: string }> = [];
    const openers = Array.from(document.querySelectorAll<HTMLElement>("[onclick],[aria-controls],[data-target],[data-bs-target],[data-modal],[data-drawer],[data-sheet],[data-dialog],[data-overlay],[data-popover],[data-open-modal],[data-open-drawer],[data-proto-route],[data-zann-scope-route],[data-zmann-scope-route]"));
    for (const opener of openers) {
      const explicitEntry = ["aria-controls", "data-target", "data-bs-target", "data-modal", "data-drawer", "data-sheet", "data-dialog", "data-overlay", "data-popover", "data-proto-route", "data-zann-scope-route", "data-zmann-scope-route", "data-open-modal", "data-open-drawer"]
        .map((name) => ({ name, value: opener.getAttribute(name)?.replace(/^#/, "") }))
        .find((item) => Boolean(item.value));
      const explicit = explicitEntry?.value;
      const explicitId = explicit?.replace(":", "-");
      let binding = explicit ? findById(explicit) || (explicitId ? findById(explicitId) : undefined) : undefined;
      if (!binding && explicitEntry?.name === "data-sheet") binding = findById(`sheet-${explicit}`);
      if (!binding && explicitEntry?.name === "data-dialog") binding = findById(`dialog-${explicit}`);
      if (!binding && explicitEntry?.name === "data-open-modal") binding = bindings.find((item) => item.kind === "弹窗");
      if (!binding && explicitEntry?.name === "data-open-drawer") binding = bindings.find((item) => item.kind === "抽屉");
      if (!binding) {
        const handler = opener.getAttribute("onclick") || "";
        const match = handler.match(/\bshow([A-Z][\w$]*)\s*\(/);
        if (match) {
          const stem = kebabCase(match[1]);
          const ids = [stem, `${stem}-drawer`, `${stem}-modal`, stem.replace(/-(drawer|modal)$/, "")];
          binding = ids.map(findById).find(Boolean) || bindings.find(({ root, content }) => [root.id, content.id].some((id) => id && (id === stem || id.startsWith(`${stem}-`))));
        }
      }
      if (!binding) continue;
      const parent = bindings.find((item) => item !== binding && item.content.contains(opener));
      const functionMatch = (opener.getAttribute("onclick") || "").match(/\b(show[A-Z][\w$]*)\s*\(/);
      records.push({ binding, opener, ownerPageId: this.owningPageId(opener, pageId), parentId: parent?.id, openFunction: functionMatch?.[1] });
    }
    const owners = new Map<string, string>();
    records.forEach((record) => { if (record.ownerPageId) owners.set(record.binding.id, record.ownerPageId); });
    for (let pass = 0; pass < bindings.length; pass += 1) {
      records.forEach((record) => {
        const inherited = record.parentId ? owners.get(record.parentId) : undefined;
        if (!owners.has(record.binding.id) && inherited) owners.set(record.binding.id, inherited);
      });
    }
    for (const binding of bindings) {
      binding.pageId = owners.get(binding.id) || (visibleInViewport(binding.content) ? pageId : "");
      const matching = records.filter((record) => record.binding === binding && (record.ownerPageId === binding.pageId || (record.parentId && owners.get(record.parentId) === binding.pageId)));
      const preferred = matching.find((record) => visibleInViewport(record.opener)) || matching[0];
      if (preferred) {
        binding.opener = preferred.opener;
        binding.parentId = preferred.parentId;
        binding.openFunction = preferred.openFunction;
      }
    }
    return [...mapped, ...bindings.filter((binding) => binding.pageId === pageId && (binding.opener || visibleInViewport(binding.content)))];
  }

  selectTreeNode(node: TreeNode): void {
    if (node.type === "group") return;
    if (node.type === "page") {
      this.openPage(node.pageId, () => this.select(this.pageRoot(node.pageId), false));
      return;
    }
    if (node.pageId !== this.currentPageId()) {
      this.callbacks.onStatus("请先打开该页面");
      return;
    }
    const element = node.element as HTMLElement | undefined;
    if (!element?.isConnected) {
      this.rebuildTree();
      this.callbacks.onStatus("页面已刷新，请重新选择");
      return;
    }
    if (node.overlayRoot) {
      const finish = (): void => {
        if (!visibleInViewport(element)) {
          this.callbacks.onStatus(`无法打开${node.detail}：${node.label}`);
          return;
        }
        this.rebuildTree();
        this.select(element, false);
        this.callbacks.onStatus(`已打开并选中${node.detail}`);
      };
      const finishWhenSettled = (remaining = 14, previous?: DOMRect): void => {
        const rect = element.getBoundingClientRect();
        const settled = previous
          && Math.abs(rect.left - previous.left) < 0.5
          && Math.abs(rect.top - previous.top) < 0.5
          && Math.abs(rect.width - previous.width) < 0.5
          && Math.abs(rect.height - previous.height) < 0.5;
        if ((settled && visibleInViewport(element)) || remaining <= 0) {
          finish();
          return;
        }
        window.setTimeout(() => finishWhenSettled(remaining - 1, rect), 50);
      };
      if (visibleInViewport(element)) finish();
      else if (node.overlayOpener?.isConnected) {
        this.dispatchingBusinessClick = true;
        try {
          node.overlayOpener.click();
        } finally {
          this.dispatchingBusinessClick = false;
        }
        window.setTimeout(() => finishWhenSettled(), 50);
      } else if (node.overlayOpenFunction && typeof (this.window as any)?.[node.overlayOpenFunction] === "function") {
        (this.window as any)[node.overlayOpenFunction](...(node.overlayOpenArgs || []));
        window.setTimeout(() => finishWhenSettled(), 50);
      } else this.callbacks.onStatus(`未找到${node.detail}的打开入口`);
      return;
    }
    if (!visibleInViewport(element)) {
      this.callbacks.onStatus("该内容当前不可见，请先打开对应页面或浮层");
      return;
    }
    element.scrollIntoView({ block: "center", inline: "nearest" });
    this.select(element, false);
  }

  private detectPageId(): string | null {
    const document = this.document;
    if (!document) return null;
    for (const page of this.pages) {
      if (!page.activeSelector) continue;
      try {
        if (document.querySelector(page.activeSelector)) return page.id;
      } catch {
        // 无效的 Agent 映射会在 validate 阶段报告，这里继续使用兼容证据。
      }
    }
    const activeRoute = document.querySelector<HTMLElement>(
      "[data-page-key][aria-current='page'],[data-route-key][aria-current='page'],[data-view-key][aria-current='page'],[data-screen-key][aria-current='page'],[data-system-tab][data-page-key][aria-selected='true'],[data-page].active,[data-page].is-active,[data-tab-page].is-active",
    );
    if (activeRoute) {
      const key = activeRoute.dataset.pageKey || activeRoute.dataset.routeKey || activeRoute.dataset.viewKey || activeRoute.dataset.screenKey || activeRoute.dataset.page || activeRoute.dataset.tabPage;
      const page = this.pages.find((item) => item.key === key);
      if (page) return page.id;
    }
    const scopes = Array.from(document.querySelectorAll<HTMLElement>("[data-proto-scope^='page:'],[data-zann-scope^='page:'],[data-zmann-scope^='page:']"))
      .filter(visible)
      .sort((left, right) => right.getBoundingClientRect().width * right.getBoundingClientRect().height - left.getBoundingClientRect().width * left.getBoundingClientRect().height);
    for (const element of scopes) {
      const scope = element.dataset.protoScope || element.dataset.zannScope || element.dataset.zmannScope || "";
      const runtimeKey = scope.slice(5);
      const page = [...this.pages].sort((a, b) => b.key.length - a.key.length).find((item) => runtimeKey === item.key || runtimeKey.startsWith(`${item.key}-`));
      if (page) return page.id;
    }
    const active = document.querySelector<HTMLElement>("[data-action='page'][data-page].active,[data-page].active");
    if (active?.dataset.page) return this.pages.find((page) => page.key === active.dataset.page)?.id || `page:${active.dataset.page}`;
    return null;
  }

  private currentPageId(): string {
    const detected = this.detectPageId();
    if (detected) this.activePageId = detected;
    return this.activePageId || this.pages[0]?.id || "page:main";
  }

  private pageRoot(pageId: string): HTMLElement {
    const document = this.document!;
    const key = pageId.replace(/^page:/, "");
    const page = this.pages.find((item) => item.id === pageId || item.key === key);
    if (page?.rootSelector) {
      try {
        const mapped = Array.from(document.querySelectorAll<HTMLElement>(page.rootSelector)).find(visible);
        if (mapped) return mapped;
      } catch {
        // 继续使用运行时自动识别。
      }
    }
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(`[data-proto-scope="page:${CSS.escape(key)}"],[data-zann-scope="page:${CSS.escape(key)}"],[data-zmann-scope="page:${CSS.escape(key)}"]`));
    const template = Array.from(document.querySelectorAll<HTMLElement>("[data-page-scope],[data-route-scope],[data-view-scope]")).find(visible);
    return candidates.find(visible) || template || document.querySelector<HTMLElement>("[data-proto-app],[data-zann-app-root]") || document.body;
  }

  private pageMatches(pageId: string): boolean {
    return this.detectPageId() === pageId;
  }

  openPage(pageId: string, after?: () => void): void {
    if (this.navigating) {
      this.queuedPage = { pageId, after };
      return;
    }
    void this.openPageAsync(pageId, after);
  }

  private async openPageAsync(pageId: string, after?: () => void): Promise<void> {
    const document = this.document;
    const frameWindow = this.window as any;
    if (!document) return;
    const page = this.pages.find((item) => item.id === pageId);
    const key = page?.key || pageId.replace(/^page:/, "");
    const waitForPage = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (this.pageMatches(pageId)) return true;
        await new Promise((resolve) => window.setTimeout(resolve, 30));
      }
      return false;
    };
    const findRoute = () => {
      if (page?.selector) {
        try {
          const mapped = document.querySelector<HTMLElement>(page.selector);
          const isRoute = mapped?.matches("a,button,[role='tab'],[data-action='page'],[data-page-link],[data-page-key],[data-route-key],[data-view-key],[data-screen-key],[data-nav],[data-proto-route],[data-zann-scope-route]");
          const isPageRoot = mapped?.matches("[data-proto-scope^='page:'],[data-zann-scope^='page:'],[data-zmann-scope^='page:']");
          if (mapped && isRoute && !isPageRoot) return mapped;
        } catch {
          // 继续使用兼容选择器。
        }
      }
      return document.querySelector<HTMLElement>(`[data-action="page"][data-page="${CSS.escape(key)}"],[data-page-link="${CSS.escape(key)}"],[data-page-key="${CSS.escape(key)}"],[data-route-key="${CSS.escape(key)}"]`);
    };
    const click = (element: HTMLElement | null): boolean => {
      if (!element) return false;
      this.dispatchingBusinessClick = true;
      try {
        element.click();
      } finally {
        this.dispatchingBusinessClick = false;
      }
      return true;
    };
    const pageMethod = [page?.openFunction, "openPage", "showPage", "navigate", "switchPage", "renderPage", "goToPage", "goTo", "setPage"]
      .filter((name): name is string => Boolean(name))
      .find((name) => typeof frameWindow?.[name] === "function");
    const originalModule = document.querySelector<HTMLElement>("[data-action='module'][data-module].active")?.dataset.module;
    const contextSelects = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).filter((select) => /role|department|dept|tenant|角色|部门|组织|机构/i.test([select.id, select.name, select.getAttribute("aria-label")].filter(Boolean).join(" ")));
    const originalContext = contextSelects.map((select) => ({ select, value: select.value }));
    const changeContext = (select: HTMLSelectElement, value: string): void => {
      select.value = value;
      const change = document.createEvent("Event");
      change.initEvent("change", true, false);
      select.dispatchEvent(change);
    };
    const activateStaticPage = (): boolean => {
      if (!page?.rootSelector) return false;
      let target: HTMLElement | null = null;
      try {
        target = document.querySelector<HTMLElement>(page.rootSelector);
      } catch {
        return false;
      }
      if (!target?.hasAttribute("aria-hidden")) return false;
      const roots = this.pages.flatMap((definition) => {
        if (!definition.rootSelector) return [];
        try {
          const root = document.querySelector<HTMLElement>(definition.rootSelector);
          return root ? [root] : [];
        } catch {
          return [];
        }
      });
      const siblings = [...new Set(roots)].filter((root) => root.parentElement === target?.parentElement && root.hasAttribute("aria-hidden"));
      if (siblings.length < 2) return false;
      siblings.forEach((root) => root.setAttribute("aria-hidden", String(root !== target)));
      this.activePageId = pageId;
      return true;
    };
    let contextLabel = "";
    this.navigating = true;
    this.clearSelection();
    try {
      if (this.pageMatches(pageId)) {
        this.activePageId = pageId;
      } else {
        let opened = false;
        if (pageMethod) {
          frameWindow[pageMethod](key);
          opened = await waitForPage();
        }
        if (!opened) opened = click(findRoute()) && await waitForPage();
        const tryModules = async (): Promise<boolean> => {
          const buttons = Array.from(document.querySelectorAll<HTMLElement>("[data-action='module'][data-module]"));
          const cached = this.pageRouteCache.get(key);
          buttons.sort((left, right) => Number(right.dataset.module === cached) - Number(left.dataset.module === cached));
          for (const button of buttons) {
            click(button);
            await new Promise((resolve) => window.setTimeout(resolve, 35));
            const route = findRoute();
            if (!route) continue;
            click(route);
            if (await waitForPage()) {
              if (button.dataset.module) this.pageRouteCache.set(key, button.dataset.module);
              return true;
            }
          }
          return false;
        };
        if (!opened) opened = await tryModules();
        if (!opened) {
          const candidates = contextSelects
            .sort((left, right) => Number(/role|角色/i.test(right.id + right.name)) - Number(/role|角色/i.test(left.id + left.name)))
            .flatMap((select) => Array.from(select.options).filter((option) => !option.disabled && option.value !== select.value).map((option) => ({ select, option })));
          for (const candidate of candidates) {
            if (!candidate.select.isConnected) continue;
            changeContext(candidate.select, candidate.option.value);
            contextLabel = candidate.option.textContent?.trim() || candidate.option.value;
            await new Promise((resolve) => window.setTimeout(resolve, 50));
            if (pageMethod) {
              frameWindow[pageMethod](key);
              opened = await waitForPage();
            }
            if (!opened) opened = click(findRoute()) && await waitForPage();
            if (!opened) opened = await tryModules();
            if (opened) break;
          }
        }
        if (!opened) opened = activateStaticPage() && await waitForPage();
        if (!opened && pageId === this.pages[0]?.id) {
          for (let attempt = 0; attempt < 10; attempt += 1) {
            const back = Array.from(document.querySelectorAll<HTMLElement>("[data-back],[data-action='back']")).find(visible);
            if (!back) break;
            click(back);
            if (await waitForPage()) {
              opened = true;
              break;
            }
          }
        }
        if (!opened) {
          originalContext.forEach(({ select, value }) => {
            if (!select.isConnected) return;
            changeContext(select, value);
          });
          if (originalModule) window.setTimeout(() => click(document.querySelector<HTMLElement>(`[data-action="module"][data-module="${CSS.escape(originalModule)}"]`)), 30);
          this.callbacks.onStatus(`无法打开页面：${page?.title || key}`);
          return;
        }
        this.activePageId = pageId;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      this.rebuildTree();
      after?.();
      this.callbacks.onStatus(contextLabel ? `已切换到“${contextLabel}”并打开页面` : `已打开${page?.title || "页面"}`);
    } finally {
      this.navigating = false;
      const queued = this.queuedPage;
      this.queuedPage = null;
      if (queued) {
        if (this.pageMatches(queued.pageId)) queued.after?.();
        else this.openPage(queued.pageId, queued.after);
      }
    }
  }

  private scheduleTree(): void {
    window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.rebuildTree(), 80);
  }

  private rebuildTree(): void {
    if (!this.document?.body) return;
    const connectedSelection = this.selected.filter((element) => element.isConnected);
    if (connectedSelection.length !== this.selected.length) {
      this.selected.forEach((element) => element.removeAttribute("data-he-selected"));
      this.selected = connectedSelection;
    }
    const pageId = this.currentPageId();
    const root = this.pageRoot(pageId);
    const overlayBindings = this.overlayBindings(pageId);
    const overlayShells = [...new Set([
      ...Array.from(this.document.querySelectorAll<HTMLElement>(".drawer,.drawer-overlay,.modal,.modal-overlay,dialog,[role='dialog'],[aria-modal='true']")),
      ...overlayBindings.flatMap((binding) => [binding.root, binding.content]),
    ])];
    this.treePathByElement = new WeakMap<Element, string[]>();
    let count = 0;
    const build = (element: Element, domPath: number[], treePath: string[], depth: number): TreeNode[] => {
      if (count >= 500 || depth > 12 || element.matches(RUNTIME_SELECTOR) || overlayShells.includes(element as HTMLElement) || !visible(element)) return [];
      const tag = element.tagName.toLowerCase();
      const children = Array.from(element.children).filter((child) => !child.matches(RUNTIME_SELECTOR));
      const isTextComponent = element.matches(TEXT_COMPONENT_SELECTOR);
      const isLeaf = element.matches(LEAF_SELECTOR) && (!isTextComponent || Boolean(element.textContent?.replace(/\s+/g, " ").trim()));
      const isContainer = !isLeaf && isMeaningfulElement(element);
      const id = `${pageId}:${domPath.join(".") || "root"}`;
      if (!isContainer && !isLeaf) {
        const promoted = children.flatMap((child, index) => build(child, [...domPath, index], treePath, depth + 1));
        const mapped = promoted[0] ? this.treePathByElement.get(promoted[0].element || element) : undefined;
        if (mapped) this.treePathByElement.set(element, mapped);
        return promoted;
      }
      count += 1;
      const nextPath = [...treePath, id];
      const node: TreeNode = {
        id,
        type: isContainer ? "container" : "element",
        label: labelFor(element),
        detail: typeLabel(tag),
        element,
        target: this.targetFor(element),
        pageId,
        children: [],
      };
      this.treePathByElement.set(element, nextPath);
      if (tag === "table") {
        node.children = Array.from(element.querySelectorAll(":scope th,:scope td")).flatMap((cell, index) => build(cell, [...domPath, index], nextPath, depth + 1));
        element.querySelectorAll("thead,tbody,tfoot,tr").forEach((child) => this.treePathByElement.set(child, nextPath));
      } else if (isContainer) {
        node.children = children.flatMap((child, index) => build(child, [...domPath, index], nextPath, depth + 1));
      }
      if (tag === "div" && node.label === "容器" && node.children.length === 1) {
        const promoted = node.children[0];
        const promotedPath = promoted.element ? this.treePathByElement.get(promoted.element) : undefined;
        if (promotedPath) this.treePathByElement.set(element, promotedPath);
        return [promoted];
      }
      return [node];
    };
    const pageChildren = Array.from(root.children).flatMap((child, index) => build(child, [index], [pageId], 0));
    const appRoot = this.document.body;
    const globalRoots: Element[] = [];
    const collectGlobalRoots = (parent: Element): void => {
      Array.from(parent.children).forEach((child) => {
        if (child.matches(RUNTIME_SELECTOR) || child === root) return;
        if (child.contains(root)) collectGlobalRoots(child);
        else if (overlayShells.some((overlay) => child === overlay || child.contains(overlay))) return;
        else globalRoots.push(child);
      });
    };
    if (appRoot !== root && appRoot.contains(root)) collectGlobalRoots(appRoot);
    const globalChildren = globalRoots.flatMap((child, index) => build(child, [1000, index], [pageId], 0));
    const overlayById = new Map(overlayBindings.map((binding) => [binding.id, binding]));
    const createOverlayNode = (binding: OverlayBinding, index: number, parentPath: string[]): TreeNode => {
      const id = `${pageId}:${binding.id}`;
      const path = [...parentPath, id];
      this.treePathByElement.set(binding.content, path);
      const nested = overlayBindings.filter((item) => item.parentId === binding.id);
      const contentChildren = visibleInViewport(binding.content)
        ? Array.from(binding.content.children).flatMap((child, childIndex) => build(child, [2000, index, childIndex], path, 0))
        : [];
      return {
        id,
        type: "container",
        label: binding.label,
        detail: binding.kind,
        element: binding.content,
        overlayRoot: binding.root,
        overlayOpener: binding.opener,
        overlayOpenFunction: binding.openFunction,
        overlayOpenArgs: binding.openArgs,
        target: this.targetFor(binding.content),
        pageId,
        children: visibleInViewport(binding.content)
          ? [...contentChildren, ...nested.map((item, childIndex) => createOverlayNode(item, index * 100 + childIndex + 1, path))]
          : [],
      };
    };
    const overlayNodes = overlayBindings.filter((binding) => !binding.parentId || !overlayById.has(binding.parentId)).map((binding, index) => createOverlayNode(binding, index, [pageId]));
    const children = [...globalChildren, ...pageChildren, ...overlayNodes];
    const pageNodes: TreeNode[] = this.pages.map((page) => ({
      id: page.id,
      type: "page" as const,
      label: page.title,
      detail: page.group || "页面",
      element: page.id === pageId ? root : undefined,
      target: page.id === pageId ? this.targetFor(root) : undefined,
      pageId: page.id,
      children: page.id === pageId ? children : [],
    }));
    const grouped = new Map<string, TreeNode[]>();
    const tree: TreeNode[] = [];
    for (const node of pageNodes) {
      const page = this.pages.find((item) => item.id === node.pageId);
      if (!page?.group) {
        tree.push(node);
        continue;
      }
      const items = grouped.get(page.group) || [];
      items.push(node);
      grouped.set(page.group, items);
    }
    grouped.forEach((items, group) => tree.push({
      id: `group:${group}`,
      type: "group",
      label: group,
      detail: `${items.length} 个页面`,
      pageId: "",
      children: items,
    }));
    this.lastTree = tree;
    this.callbacks.onTree(tree, pageId);
    if (this.selected.length) this.callbacks.onSelection(this.snapshot());
  }

  private targetFor(element: Element, originalText?: string): ElementTarget {
    const domPath: number[] = [];
    let current: Element | null = element;
    while (current && current !== element.ownerDocument.documentElement) {
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      domPath.unshift(Array.from(parent.children).indexOf(current));
      current = parent;
    }
    const pageId = this.currentPageId();
    const page = this.pages.find((item) => item.id === pageId);
    const pageRoot = this.pageRoot(pageId);
    const runtimeScope = pageRoot.contains(element) ? "page" : "global";
    const root = runtimeScope === "page" ? pageRoot : element.ownerDocument.body;
    const runtimePath: number[] = [];
    current = element;
    if (root.contains(element)) {
      while (current && current !== root) {
        const parent: Element | null = current.parentElement;
        if (!parent) break;
        runtimePath.unshift(Array.from(parent.children).indexOf(current));
        current = parent;
      }
    }
    const attributes = ["data-ui", "data-page", "data-page-key", "data-route-key", "data-action", "data-key", "data-id", "name", "type", "role", "aria-label"];
    return {
      existingId: (element as HTMLElement).id || undefined,
      domPath,
      runtimePageId: pageId,
      runtimeScope,
      runtimePath: current === root ? runtimePath : undefined,
      runtimeRootSelector: runtimeScope === "page" ? page?.rootSelector : undefined,
      tagName: element.tagName.toLowerCase(),
      originalText: shortText(originalText ?? element.textContent ?? "", 140),
      sourceAttributes: Object.fromEntries(attributes.flatMap((name) => {
        const value = element.getAttribute(name);
        return value === null ? [] : [[name, value]];
      })),
    };
  }

  private findTreePath(element: Element): string[] {
    const pageId = this.currentPageId();
    let current: Element | null = element;
    while (current) {
      const path = this.treePathByElement.get(current);
      if (path) return path;
      current = current.parentElement;
    }
    this.scheduleTree();
    return [pageId];
  }

  snapshot(): SelectionSnapshot | null {
    if (!this.selected.length) return null;
    const element = this.selected[0];
    const computed = this.window?.getComputedStyle(element);
    const range = this.activeTextRange() || this.savedRange;
    const rangeActive = Boolean(range && !range.collapsed && this.selected.some((item) => {
      const container = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
      return Boolean(container && (item === container || item.contains(container)));
    }));
    const rangeNode = rangeActive
      ? (range!.startContainer.nodeType === 1 ? range!.startContainer as Element : range!.startContainer.parentElement)
      : null;
    const rangeComputed = rangeNode ? this.window?.getComputedStyle(rangeNode) : null;
    const styleNames = ["width", "height", "position", "top", "left", "font-size", "font-weight", "font-style", "text-decoration-line", "text-align", "color", "background-color"];
    const queryState = (name: string): boolean => rangeActive ? Boolean(this.document?.queryCommandState(name)) : false;
    return {
      elements: [...this.selected],
      target: this.targetFor(element),
      tagName: element.tagName.toLowerCase(),
      text: element.textContent?.trim() || "",
      attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
      styles: Object.fromEntries(styleNames.map((name) => [name, (rangeActive && ["font-size", "color"].includes(name) ? rangeComputed : computed)?.getPropertyValue(name).trim() || ""])),
      parentDisplay: element.parentElement ? this.window?.getComputedStyle(element.parentElement).display || "" : "",
      locked: false,
      treePath: this.findTreePath(element),
      options: element.tagName === "SELECT" ? Array.from((element as HTMLSelectElement).options).map((option) => ({ text: option.text, value: option.value, selected: option.selected })) : undefined,
      listItems: ["UL", "OL"].includes(element.tagName) ? Array.from(element.children).filter((child) => child.tagName === "LI").map((child) => child.textContent?.trim() || "") : undefined,
      inputType: element.tagName === "INPUT" ? (element as HTMLInputElement).type : undefined,
      checked: element.tagName === "INPUT" ? (element as HTMLInputElement).checked : undefined,
      textEditable: this.canEditText(element),
      textScope: rangeActive ? "range" : "element",
      selectedText: rangeActive ? (this.window?.getSelection()?.toString() || range?.toString() || "") : undefined,
      rangeFontSize: rangeActive ? parsePixel(rangeComputed?.fontSize || computed?.fontSize || "14") : undefined,
      textFormat: {
        bold: rangeActive ? queryState("bold") : Number.parseInt(computed?.fontWeight || "400", 10) >= 600,
        italic: rangeActive ? queryState("italic") : computed?.fontStyle === "italic",
        underline: rangeActive ? queryState("underline") : Boolean(computed?.textDecorationLine.includes("underline")),
        strike: rangeActive ? queryState("strikeThrough") : Boolean(computed?.textDecorationLine.includes("line-through")),
      },
    };
  }

  applyText(value: string): void {
    if (this.selected.length !== 1 || !this.canEditText(this.selected[0])) return;
    const element = this.selected[0];
    const beforeText = element.textContent || "";
    if (beforeText.trim() === value.trim()) return;
    const before = element.innerHTML;
    const target = this.targetFor(element, beforeText);
    element.textContent = value;
    this.commit("修改文字", [{ type: "set-inner-html", target, html: element.innerHTML, before, after: element.innerHTML }]);
  }

  applyAttribute(name: string, value: string): void {
    if (this.selected.length !== 1) return;
    const element = this.selected[0];
    const target = this.targetFor(element);
    const before = element.getAttribute(name);
    if (value === "") element.removeAttribute(name);
    else element.setAttribute(name, value);
    const after = element.getAttribute(name);
    if (before !== after) this.commit(`修改${name}`, [{ type: "set-attribute", target, name, value: after, before, after }]);
  }

  applyBooleanAttribute(name: string, enabled: boolean): void {
    this.applyAttribute(name, enabled ? "" : "");
  }

  applyStyle(property: string, value: string): void {
    if (!this.selected.length) return;
    const patches = this.selected.flatMap((element) => {
      const target = this.targetFor(element);
      const before = element.getAttribute("style");
      if (value.trim()) element.style.setProperty(property, value.trim());
      else element.style.removeProperty(property);
      const after = element.getAttribute("style");
      return before === after ? [] : [{ type: "set-attribute" as const, target, name: "style", value: after, before, after }];
    });
    this.commit(`修改${property}`, patches);
  }

  setPosition(axis: "x" | "y", value: number): void {
    if (!Number.isFinite(value) || !this.selected.length) return;
    const patches = this.selected.flatMap((element) => {
      const target = this.targetFor(element);
      const before = element.getAttribute("style");
      if (this.window!.getComputedStyle(element).position === "static") element.style.position = "relative";
      element.style.setProperty(axis === "x" ? "left" : "top", `${Math.round(value)}px`);
      const after = element.getAttribute("style");
      return before === after ? [] : [{ type: "set-attribute" as const, target, name: "style", value: after, before, after }];
    });
    this.commit(axis === "x" ? "调整水平位置" : "调整垂直位置", patches);
  }

  applySelectOptions(options: Array<{ text: string; value: string; selected: boolean }>): void {
    const element = this.selected[0];
    if (!element || element.tagName !== "SELECT") return;
    const target = this.targetFor(element);
    const before = element.innerHTML;
    element.innerHTML = options.map((item) => `<option value="${item.value.replace(/"/g, "&quot;")}"${item.selected ? " selected" : ""}>${item.text.replace(/</g, "&lt;")}</option>`).join("");
    if (before !== element.innerHTML) this.commit("修改下拉选项", [{ type: "set-inner-html", target, html: element.innerHTML, before, after: element.innerHTML }]);
  }

  applyListItems(items: string[]): void {
    const element = this.selected[0];
    if (!element || !["UL", "OL"].includes(element.tagName)) return;
    const target = this.targetFor(element);
    const before = element.innerHTML;
    element.innerHTML = items.filter((item) => item.trim()).map((item) => `<li>${item.trim().replace(/</g, "&lt;")}</li>`).join("");
    if (before !== element.innerHTML) this.commit("修改列表内容", [{ type: "set-inner-html", target, html: element.innerHTML, before, after: element.innerHTML }]);
  }

  editSelectedText(): void {
    if (this.selected.length === 1 && this.canEditText(this.selected[0])) this.startTextEdit(this.selected[0]);
  }

  private startTextEdit(element: HTMLElement): void {
    if (this.editingState?.element === element) return;
    this.finishTextEdit(false);
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); this.finishTextEdit(true); }
      else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); this.finishTextEdit(false); }
    };
    this.editingState = { element, before: element.innerHTML, target: this.targetFor(element, element.textContent || ""), keydown };
    element.contentEditable = "true";
    element.dataset.heEditing = "true";
    element.focus();
    element.addEventListener("keydown", keydown);
    this.renderVisualOverlays();
  }

  private commitPendingTextEdit(): void {
    const editing = this.editingState;
    if (!editing || editing.element.innerHTML === editing.before) return;
    const before = editing.before;
    const after = editing.element.innerHTML;
    editing.before = after;
    this.commit("编辑文字", [{ type: "set-inner-html", target: editing.target, html: after, before, after }]);
  }

  private finishTextEdit(restore: boolean): void {
    const editing = this.editingState;
    if (!editing) return;
    this.editingState = null;
    editing.element.removeEventListener("keydown", editing.keydown);
    if (restore) editing.element.innerHTML = editing.before;
    else if (editing.element.innerHTML !== editing.before) this.commit("编辑文字", [{ type: "set-inner-html", target: editing.target, html: editing.element.innerHTML, before: editing.before, after: editing.element.innerHTML }]);
    editing.element.removeAttribute("contenteditable");
    editing.element.removeAttribute("data-he-editing");
    this.savedRange = null;
    this.renderVisualOverlays();
  }

  applyTextFormat(format: "bold" | "italic" | "underline" | "strike" | "color", value?: string): void {
    if (this.selected.length !== 1) return;
    const element = this.selected[0];
    const range = this.savedRange || this.activeTextRange();
    if (range && !range.collapsed) {
      this.commitPendingTextEdit();
      const before = element.innerHTML;
      const target = this.targetFor(element, element.textContent || "");
      const selection = this.window?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const command = format === "strike" ? "strikeThrough" : format === "color" ? "foreColor" : format;
      this.document?.execCommand(command, false, value);
      const after = element.innerHTML;
      if (before !== after) {
        this.commit("设置选中文字", [{ type: "set-inner-html", target, html: after, before, after }]);
        if (this.editingState?.element === element) this.editingState.before = after;
      }
      this.savedRange = this.activeTextRange()?.cloneRange() || null;
      this.callbacks.onSelection(this.snapshot());
      return;
    }
    if (format === "bold") this.applyStyle("font-weight", this.snapshot()?.textFormat?.bold ? "400" : "700");
    else if (format === "italic") this.applyStyle("font-style", this.snapshot()?.textFormat?.italic ? "normal" : "italic");
    else if (format === "underline" || format === "strike") {
      const current = this.window?.getComputedStyle(element).textDecorationLine || "none";
      const token = format === "underline" ? "underline" : "line-through";
      const values = new Set(current === "none" ? [] : current.split(/\s+/));
      values.has(token) ? values.delete(token) : values.add(token);
      this.applyStyle("text-decoration-line", values.size ? [...values].join(" ") : "none");
    } else if (format === "color" && value) this.applyStyle("color", value);
  }

  applyTextFontSize(value: number): void {
    if (!Number.isFinite(value) || this.selected.length !== 1) return;
    const element = this.selected[0];
    const range = this.savedRange || this.activeTextRange();
    if (!range || range.collapsed) {
      this.applyStyle("font-size", `${Math.max(8, value)}px`);
      return;
    }
    this.commitPendingTextEdit();
    const before = element.innerHTML;
    const target = this.targetFor(element, element.textContent || "");
    const wrapper = this.document!.createElement("span");
    wrapper.style.fontSize = `${Math.max(8, value)}px`;
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
    const selection = this.window?.getSelection();
    range.selectNodeContents(wrapper);
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.savedRange = range.cloneRange();
    const after = element.innerHTML;
    if (before !== after) {
      this.commit("设置选中文字字号", [{ type: "set-inner-html", target, html: after, before, after }]);
      if (this.editingState?.element === element) this.editingState.before = after;
    }
    this.callbacks.onSelection(this.snapshot());
  }

  applyTextAlign(value: "left" | "center" | "right"): void {
    this.applyStyle("text-align", value);
  }

  private resolveRuntimeTarget(target: ElementTarget): HTMLElement | null {
    const pageId = target.runtimePageId || this.currentPageId();
    const runtimeScope = target.runtimeScope || (Array.isArray(target.runtimePath) ? "page" : "global");
    if (runtimeScope === "page" && pageId !== this.currentPageId()) return null;
    const root = runtimeScope === "global" ? this.document!.body : this.pageRoot(pageId);
    if (target.existingId) {
      const byId = this.document?.getElementById(target.existingId);
      if (byId && (byId === root || root.contains(byId))) return byId;
    }
    if (target.runtimePath) {
      let element: Element | null = root;
      for (const index of target.runtimePath) element = element?.children[index] || null;
      if (element?.tagName.toLowerCase() === target.tagName) return element as HTMLElement;
    }
    if (target.sourceAttributes && Object.keys(target.sourceAttributes).length) {
      const candidates = Array.from(root.querySelectorAll<HTMLElement>(target.tagName)).filter((element) => Object.entries(target.sourceAttributes || {}).every(([name, value]) => element.getAttribute(name) === value));
      if (candidates.length === 1) return candidates[0];
    }
    return null;
  }

  private replaceLivePatches(patches: EditorPatch[]): void {
    const document = this.document;
    if (!document?.body) return;
    document.querySelectorAll('script[type="application/json"][data-he-patches]').forEach((node) => node.remove());
    if (!patches.length) return;
    const livePatch = document.createElement("script");
    livePatch.type = "application/json";
    livePatch.dataset.hePatches = "live";
    livePatch.dataset.heRuntime = "true";
    livePatch.textContent = JSON.stringify(patches);
    document.body.appendChild(livePatch);
  }

  applyHistory(history: { action: "undo" | "redo"; command: EditorCommand } | undefined, activePatches: EditorPatch[] = []): void {
    if (!history) return;
    const source = history.action === "undo" ? [...history.command.patches].reverse() : history.command.patches;
    const patches = source.map((patch): EditorPatch => history.action === "undo"
      ? patch.type === "set-attribute"
        ? { ...patch, value: patch.before === undefined ? null : patch.before }
        : { ...patch, html: String(patch.before ?? "") }
      : patch.type === "set-attribute"
        ? { ...patch, value: patch.after === undefined ? patch.value : patch.after }
        : { ...patch, html: String(patch.after ?? patch.html ?? "") });
    for (const patch of patches) {
      const element = this.resolveRuntimeTarget(patch.target);
      if (!element) continue;
      if (patch.type === "set-attribute" && patch.name) {
        if (patch.value === null || patch.value === undefined) element.removeAttribute(patch.name);
        else element.setAttribute(patch.name, String(patch.value));
      } else if (patch.type === "set-inner-html") element.innerHTML = patch.html || "";
    }
    this.replaceLivePatches(activePatches);
    this.selected = this.selected.filter((element) => element.isConnected);
    this.rebuildTree();
    this.selectMany(this.selected);
  }

  copy(): void {
    if (!this.selected.length) return;
    this.clipboardHtml = this.selected.map((element) => cleanClone(element).outerHTML).join("");
    this.callbacks.onStatus(`已复制${this.selected.length}项`);
  }

  cut(): void {
    this.copy();
    this.deleteSelected();
  }

  paste(): void {
    if (!this.clipboardHtml || !this.selected.length) return;
    const anchor = this.selected[this.selected.length - 1];
    const parent = anchor.parentElement;
    if (!parent) return;
    const target = this.targetFor(parent);
    const before = cleanInnerHtml(parent);
    const template = this.document!.createElement("template");
    template.innerHTML = this.clipboardHtml;
    const inserted = Array.from(template.content.children) as HTMLElement[];
    inserted.forEach(clearDuplicateIdentity);
    anchor.after(template.content);
    const after = cleanInnerHtml(parent);
    this.commit("粘贴元素", [{ type: "set-inner-html", target, html: after, before, after }]);
    this.selectMany(inserted);
  }

  duplicate(): void {
    const roots = this.selectedRoots();
    if (!roots.length) return;
    const parents = new Map<HTMLElement, { target: ElementTarget; before: string }>();
    roots.forEach((element) => {
      const parent = element.parentElement;
      if (parent && !parents.has(parent)) parents.set(parent, { target: this.targetFor(parent), before: cleanInnerHtml(parent) });
    });
    const clones = roots.map((element) => {
      const clone = cleanClone(element) as HTMLElement;
      clearDuplicateIdentity(clone);
      element.after(clone);
      return clone;
    });
    const patches = Array.from(parents.entries()).map(([parent, state]) => {
      const after = cleanInnerHtml(parent);
      return { type: "set-inner-html" as const, target: state.target, html: after, before: state.before, after };
    });
    this.commit("复制元素", patches);
    this.selectMany(clones);
  }

  deleteSelected(): void {
    const roots = this.selectedRoots();
    if (!roots.length) return;
    const parents = new Map<HTMLElement, { target: ElementTarget; before: string }>();
    roots.forEach((element) => {
      const parent = element.parentElement;
      if (parent && !parents.has(parent)) parents.set(parent, { target: this.targetFor(parent), before: cleanInnerHtml(parent) });
    });
    roots.forEach((element) => element.remove());
    const patches = Array.from(parents.entries()).map(([parent, state]) => {
      const after = cleanInnerHtml(parent);
      return { type: "set-inner-html" as const, target: state.target, html: after, before: state.before, after };
    });
    this.clearSelection();
    this.commit("删除元素", patches);
  }

  private selectedRoots(): HTMLElement[] {
    return this.selected.filter((element) => !this.selected.some((other) => other !== element && other.contains(element)));
  }

  selectParent(): void {
    const parent = this.selected[0]?.parentElement;
    const root = this.pageRoot(this.currentPageId());
    if (parent && parent !== root && root.contains(parent)) this.select(parent, false);
  }

  nudge(direction: string, amount: number): void {
    if (!this.selected.length) return;
    const dx = direction === "ArrowLeft" ? -amount : direction === "ArrowRight" ? amount : 0;
    const dy = direction === "ArrowUp" ? -amount : direction === "ArrowDown" ? amount : 0;
    const patches = this.selected.map((element) => {
      const target = this.targetFor(element);
      const before = element.getAttribute("style");
      const computed = this.window!.getComputedStyle(element);
      if (computed.position === "static") element.style.position = "relative";
      element.style.left = `${parsePixel(computed.left) + dx}px`;
      element.style.top = `${parsePixel(computed.top) + dy}px`;
      return { type: "set-attribute" as const, target, name: "style", value: element.getAttribute("style"), before, after: element.getAttribute("style") };
    });
    this.commit("微调位置", patches);
  }

  align(type: "left" | "center" | "right" | "top" | "middle" | "bottom"): void {
    if (this.selected.length < 2) return;
    const rects = this.selected.map((element) => element.getBoundingClientRect());
    const bounds = {
      left: Math.min(...rects.map((rect) => rect.left)),
      top: Math.min(...rects.map((rect) => rect.top)),
      right: Math.max(...rects.map((rect) => rect.right)),
      bottom: Math.max(...rects.map((rect) => rect.bottom)),
    };
    const patches = this.selected.flatMap((element) => {
      const target = this.targetFor(element);
      const before = element.getAttribute("style");
      const rect = element.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      if (type === "left") dx = bounds.left - rect.left;
      if (type === "center") dx = (bounds.left + bounds.right) / 2 - rect.left - rect.width / 2;
      if (type === "right") dx = bounds.right - rect.right;
      if (type === "top") dy = bounds.top - rect.top;
      if (type === "middle") dy = (bounds.top + bounds.bottom) / 2 - rect.top - rect.height / 2;
      if (type === "bottom") dy = bounds.bottom - rect.bottom;
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return [];
      const computed = this.window!.getComputedStyle(element);
      if (computed.position === "static") element.style.position = "relative";
      element.style.left = `${parsePixel(computed.left) + dx}px`;
      element.style.top = `${parsePixel(computed.top) + dy}px`;
      const after = element.getAttribute("style");
      return before === after ? [] : [{ type: "set-attribute" as const, target, name: "style", value: after, before, after }];
    });
    this.commit("对齐元素", patches);
  }

  private commit(label: string, patches: EditorPatch[]): void {
    if (!patches.length) return;
    this.updateEditorGeometry();
    const command: EditorCommand = { id: uniqueId("cmd"), label, pageId: this.currentPageId(), patches, createdAt: new Date().toISOString() };
    this.commandQueue = this.commandQueue.then(async () => {
      try {
        const activePatches = await this.callbacks.onCommand(command);
        this.replaceLivePatches(activePatches);
        this.callbacks.onStatus(`${label}已保存`);
        this.rebuildTree();
        this.callbacks.onSelection(this.snapshot());
      } catch (error) {
        this.callbacks.onStatus(error instanceof Error ? error.message : String(error));
        this.callbacks.onCommandRejected();
      }
    });
  }
}
