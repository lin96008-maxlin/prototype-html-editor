import Moveable from "moveable";
import Selecto from "selecto";
import type { EditorCommand, EditorMode, EditorPatch, ElementTarget, PageDefinition, SelectionSnapshot, TreeNode } from "./types";

interface FrameCallbacks {
  onCommand: (command: EditorCommand) => Promise<void>;
  onCommandRejected: () => void;
  onTree: (tree: TreeNode[], currentPageId: string) => void;
  onSelection: (selection: SelectionSnapshot | null) => void;
  onContextMenu: (value: { x: number; y: number } | null) => void;
  onModeToggle: () => void;
  onHistory: (action: "undo" | "redo") => Promise<void>;
  onSave: () => void;
  onZoomWheel: (deltaY: number) => void;
  onStatus: (message: string) => void;
}

const CONTAINER_TAGS = new Set(["main", "section", "article", "header", "footer", "nav", "aside", "form", "fieldset", "table", "thead", "tbody", "tfoot", "ul", "ol", "dialog"]);
const ELEMENT_TAGS = new Set(["a", "button", "input", "select", "textarea", "label", "img", "video", "audio", "iframe", "canvas", "svg", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "th", "td", "blockquote", "pre"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RUNTIME_SELECTOR = ".moveable-control-box,.selecto-selection,[data-he-runtime],#he-runtime-style";
const ANNOTATION_SELECTOR = "#prototypeAnnotationRoot,#zannRoot,.protoWeb-root,.protoMobile-overlay-root,.zann-root";

function uniqueId(prefix = "he"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function visible(element: Element): boolean {
  const html = element as HTMLElement;
  const style = html.ownerDocument.defaultView?.getComputedStyle(html);
  return !html.hidden && html.getAttribute("aria-hidden") !== "true" && style?.display !== "none" && style?.visibility !== "hidden" && html.getClientRects().length > 0;
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

function labelFor(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const named = element.getAttribute("data-title") || element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.getAttribute("alt") || element.getAttribute("name");
  const ownText = directText(element);
  if (named || ownText) return shortText(named || ownText);
  const friendly: Record<string, string> = {
    main: "页面内容", section: "内容区", article: "内容区", header: "页头", footer: "页尾", nav: "导航", aside: "侧栏",
    form: "表单", fieldset: "表单分组", div: "容器", ul: "列表", ol: "有序列表", table: "表格", thead: "表头",
    tbody: "表格内容", tfoot: "表尾", tr: "表格行", select: "下拉框", input: "输入框", textarea: "多行输入框", img: "图片",
  };
  const id = element.id ? `#${element.id}` : "";
  return friendly[tag] || `${tag}${id}`;
}

function typeLabel(tag: string): string {
  const labels: Record<string, string> = {
    main: "页面内容", section: "内容区", article: "内容区", header: "页头", footer: "页尾", nav: "导航", aside: "侧栏", div: "容器",
    form: "表单", fieldset: "表单分组", ul: "列表", ol: "有序列表", li: "列表项", table: "表格", thead: "表头", tbody: "表格内容",
    tfoot: "表尾", tr: "表格行", th: "表头单元格", td: "单元格", button: "按钮", a: "链接", input: "输入框", textarea: "多行输入框",
    select: "下拉框", label: "字段名称", img: "图片", video: "视频", audio: "音频", iframe: "嵌入页面", canvas: "画布", svg: "图形",
    h1: "一级标题", h2: "二级标题", h3: "三级标题", h4: "四级标题", h5: "五级标题", h6: "六级标题", p: "文字", blockquote: "引用", pre: "文本块",
  };
  return labels[tag] || "元素";
}

function cleanClone(element: Element): Element {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll(RUNTIME_SELECTOR).forEach((node) => node.remove());
  clone.querySelectorAll("[contenteditable][data-he-editing]").forEach((node) => {
    node.removeAttribute("contenteditable");
    node.removeAttribute("data-he-editing");
  });
  clone.querySelectorAll("[data-he-selected]").forEach((node) => node.removeAttribute("data-he-selected"));
  clone.removeAttribute("contenteditable");
  clone.removeAttribute("data-he-editing");
  clone.removeAttribute("data-he-selected");
  return clone;
}

function cleanInnerHtml(element: Element): string {
  return cleanClone(element).innerHTML;
}

function rewriteCloneIds(root: Element): void {
  const replacements = new Map<string, string>();
  const elements = [root, ...Array.from(root.querySelectorAll("[id]"))];
  elements.forEach((element) => {
    if (!element.id) return;
    const next = `${element.id}-copy-${Math.random().toString(36).slice(2, 6)}`;
    replacements.set(element.id, next);
    element.id = next;
  });
  [root, ...Array.from(root.querySelectorAll("*"))].forEach((element) => {
    element.removeAttribute("data-he-id");
    for (const attribute of ["for", "aria-controls", "aria-labelledby", "aria-describedby", "href"]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const raw = value.startsWith("#") ? value.slice(1) : value;
      if (replacements.has(raw)) element.setAttribute(attribute, value.startsWith("#") ? `#${replacements.get(raw)}` : replacements.get(raw)!);
    }
  });
}

export class FrameController {
  private iframe: HTMLIFrameElement;
  private pages: PageDefinition[];
  private callbacks: FrameCallbacks;
  private mode: EditorMode = "preview";
  private selected: HTMLElement[] = [];
  private moveable: Moveable | null = null;
  private selecto: Selecto | null = null;
  private observer: MutationObserver | null = null;
  private boundDocument: Document | null = null;
  private rebuildTimer = 0;
  private clipboardHtml = "";
  private freePosition = false;
  private dragState: { styles: Map<HTMLElement, string | null>; lastX: number; lastY: number; startX: number; startY: number; distance: number; axis: "x" | "y" | null } | null = null;
  private treeCache = new Map<string, TreeNode[]>();
  private pageRouteCache = new Map<string, string>();
  private lastTree: TreeNode[] = [];
  private navigating = false;

  constructor(iframe: HTMLIFrameElement, pages: PageDefinition[], callbacks: FrameCallbacks) {
    this.iframe = iframe;
    this.pages = pages;
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
    if (!document?.documentElement) return;
    this.installRuntimeStyle();
    this.bindDocumentEvents();
    this.observer = new MutationObserver(() => this.scheduleTree());
    this.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "style", "aria-hidden", "data-proto-scope", "data-zann-scope"] });
    if (mode === "edit") this.createSelecto();
    this.rebuildTree();
  }

  setMode(mode: EditorMode): void {
    this.attach(mode);
  }

  setPages(pages: PageDefinition[]): void {
    this.pages = pages;
    this.rebuildTree();
  }

  setFreePosition(value: boolean): void {
    this.freePosition = value;
    this.callbacks.onStatus(value ? "已启用自由定位" : "已启用布局感知");
  }

  isFreePosition(): boolean {
    return this.freePosition;
  }

  destroy(): void {
    this.destroyRuntime();
    this.document?.getElementById("he-runtime-style")?.remove();
  }

  private destroyRuntime(): void {
    if (this.boundDocument) {
      this.boundDocument.removeEventListener("click", this.onClick, true);
      this.boundDocument.removeEventListener("dblclick", this.onDoubleClick, true);
      this.boundDocument.removeEventListener("contextmenu", this.onContextMenu, true);
      this.boundDocument.removeEventListener("keydown", this.onKeyDown, true);
      this.boundDocument.removeEventListener("wheel", this.onWheel, true);
      this.boundDocument = null;
    }
    this.moveable?.destroy();
    this.selecto?.destroy();
    this.observer?.disconnect();
    this.moveable = null;
    this.selecto = null;
    this.observer = null;
    this.selected.forEach((element) => element.removeAttribute("data-he-selected"));
    this.selected = [];
  }

  private installRuntimeStyle(): void {
    const document = this.document!;
    const frameWindow = this.window as any;
    if (this.mode === "edit") {
      if (!frameWindow.__heOriginalConsoleError) frameWindow.__heOriginalConsoleError = frameWindow.console.error;
      frameWindow.console.error = (...args: unknown[]) => {
        if (String(args[0] || "").includes("原型标注入口被业务界面遮挡")) return;
        frameWindow.__heOriginalConsoleError.apply(frameWindow.console, args);
      };
    } else if (frameWindow.__heOriginalConsoleError) {
      frameWindow.console.error = frameWindow.__heOriginalConsoleError;
      delete frameWindow.__heOriginalConsoleError;
    }
    let style = document.getElementById("he-runtime-style") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "he-runtime-style";
      style.setAttribute("data-he-runtime", "true");
      document.head.appendChild(style);
    }
    style.textContent = this.mode === "edit" ? `
      html { cursor: default !important; }
      ${ANNOTATION_SELECTOR} { display: none !important; pointer-events: none !important; }
      [data-he-selected] { outline: 2px solid #2563eb !important; outline-offset: 1px !important; }
      [data-he-locked="true"] { outline-color: #dc2626 !important; }
      [data-he-editing] { cursor: text !important; outline: 2px solid #0f766e !important; }
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
  }

  private onWheel = (event: WheelEvent): void => {
    if (this.mode !== "edit" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    event.stopPropagation();
    this.callbacks.onZoomWheel(event.deltaY);
  };

  private onClick = (event: MouseEvent): void => {
    if (this.navigating) return;
    if (this.mode !== "edit") {
      window.setTimeout(() => this.scheduleTree(), 0);
      return;
    }
    const candidates = this.selectionCandidates(event.target as Element | null);
    if (!candidates.length) return;
    const additive = event.ctrlKey || event.metaKey;
    let target = candidates[0];
    if (additive || event.altKey) target = candidates[candidates.length - 1];
    else if (this.selected.length === 1) {
      const currentIndex = candidates.indexOf(this.selected[0]);
      if (currentIndex >= 0) target = candidates[(currentIndex + 1) % candidates.length];
    }
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.select(target, additive);
  };

  private onDoubleClick = (event: MouseEvent): void => {
    if (this.mode !== "edit") return;
    const target = this.editableTarget(event.target as Element | null);
    if (!target || !this.canEditText(target)) return;
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
    const iframeRect = this.iframe.getBoundingClientRect();
    const scale = iframeRect.width / Math.max(1, this.iframe.clientWidth);
    this.callbacks.onContextMenu({ x: iframeRect.left + event.clientX * scale, y: iframeRect.top + event.clientY * scale });
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.mode !== "edit") return;
    if (this.isNativeEditing(event.target)) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && key === "e") {
      event.preventDefault();
      this.callbacks.onModeToggle();
    } else if (modifier && key === "z") {
      event.preventDefault();
      void this.callbacks.onHistory(event.shiftKey ? "redo" : "undo");
    } else if (modifier && key === "y") {
      event.preventDefault();
      void this.callbacks.onHistory("redo");
    } else if (modifier && key === "s") {
      event.preventDefault();
      this.callbacks.onSave();
    } else if (modifier && key === "c") {
      event.preventDefault();
      this.copy();
    } else if (modifier && key === "x") {
      event.preventDefault();
      this.cut();
    } else if (modifier && key === "v") {
      event.preventDefault();
      this.paste();
    } else if (modifier && key === "d") {
      event.preventDefault();
      this.duplicate();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.deleteSelected();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.clearSelection();
    } else if (event.key === "Enter" && this.selected.length === 1 && this.canEditText(this.selected[0])) {
      event.preventDefault();
      this.startTextEdit(this.selected[0]);
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      this.nudge(event.key, event.shiftKey ? 10 : 1);
    }
  };

  handleShortcut(event: KeyboardEvent): boolean {
    if (this.mode !== "edit" || this.isNativeEditing(event.target)) return false;
    this.onKeyDown(event);
    return event.defaultPrevented;
  }

  private isNativeEditing(target: EventTarget | null): boolean {
    const element = target instanceof Element ? target : null;
    return Boolean(element?.closest("input,textarea,select,[contenteditable='true']"));
  }

  private editableTarget(raw: Element | null): HTMLElement | null {
    if (!raw) return null;
    const element = raw.closest("button,a,input,select,textarea,label,img,video,audio,iframe,canvas,svg,h1,h2,h3,h4,h5,h6,p,ul,ol,li,th,td,blockquote,pre,form,fieldset,table,section,article,main,nav,aside,header,footer,div") as HTMLElement | null;
    if (!element || element.matches(RUNTIME_SELECTOR) || element.closest(ANNOTATION_SELECTOR)) return null;
    if (["HTML", "HEAD", "BODY"].includes(element.tagName)) return null;
    return element;
  }

  private selectionCandidates(raw: Element | null): HTMLElement[] {
    if (!raw || raw.closest(ANNOTATION_SELECTOR) || raw.closest(RUNTIME_SELECTOR)) return [];
    const pageRoot = this.pageRoot(this.currentPageId());
    const candidates: HTMLElement[] = [];
    let current: Element | null = raw;
    while (current && current !== pageRoot && !["HTML", "HEAD", "BODY"].includes(current.tagName)) {
      const editable = this.editableTarget(current);
      if (editable === current && !candidates.includes(editable)) candidates.push(editable);
      current = current.parentElement;
    }
    return candidates.reverse();
  }

  private canEditText(element: HTMLElement): boolean {
    const tag = element.tagName.toLowerCase();
    if (VOID_TAGS.has(tag) || ["select", "textarea", "canvas", "svg", "video", "audio", "iframe", "table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "form", "main", "section", "article", "header", "footer", "nav", "aside"].includes(tag)) return false;
    if (["div", "fieldset"].includes(tag) && element.children.length > 0) return false;
    return true;
  }

  private createSelecto(): void {
    const document = this.document!;
    this.selecto = new Selecto({
      container: document.body,
      dragContainer: document.documentElement,
      selectableTargets: ["body *"],
      selectByClick: false,
      selectFromInside: false,
      continueSelect: false,
      toggleContinueSelect: [["ctrl"], ["meta"]],
      hitRate: 30,
      preventDefault: false,
      checkInput: true,
    });
    this.selecto.on("selectEnd", (event) => {
      const targets = event.selected
        .map((item) => this.editableTarget(item))
        .filter((item): item is HTMLElement => item !== null)
        .filter((item) => visible(item))
        .slice(0, 50);
      if (targets.length) this.selectMany(targets);
    });
  }

  select(element: HTMLElement, additive = false): void {
    if (element.dataset.heLocked === "true") this.callbacks.onStatus("该元素已锁定，可在右侧解除锁定");
    const next = additive ? [...this.selected] : [];
    const index = next.indexOf(element);
    if (additive && index >= 0) next.splice(index, 1);
    else next.push(element);
    this.selectMany(next);
  }

  selectTreeNode(node: TreeNode): void {
    if (node.type === "page") {
      this.openPage(node.pageId);
      return;
    }
    const locate = (): void => {
      const element = node.element?.isConnected ? node.element as HTMLElement : this.resolveTarget(node.target || null);
      if (!element) {
        this.callbacks.onStatus("该元素已变化，请重新展开页面后选择");
        return;
      }
      element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      this.select(element, false);
    };
    if (node.pageId !== this.currentPageId()) this.openPage(node.pageId, locate);
    else locate();
  }

  private selectMany(elements: HTMLElement[]): void {
    this.selected.forEach((element) => element.removeAttribute("data-he-selected"));
    this.selected = [...new Set(elements.filter((element) => element.isConnected))];
    this.selected.forEach((element) => element.setAttribute("data-he-selected", "true"));
    this.createMoveable();
    this.callbacks.onSelection(this.snapshot());
    this.callbacks.onContextMenu(null);
  }

  clearSelection(): void {
    this.selectMany([]);
  }

  private createMoveable(): void {
    this.moveable?.destroy();
    this.moveable = null;
    if (this.mode !== "edit" || !this.selected.length || this.selected.some((element) => element.dataset.heLocked === "true")) return;
    const document = this.document!;
    const guidelines = Array.from(document.querySelectorAll("body *"))
      .filter((element) => visible(element) && !this.selected.includes(element as HTMLElement) && !element.matches(RUNTIME_SELECTOR))
      .slice(0, 300) as HTMLElement[];
    this.moveable = new Moveable(document.body, {
      target: this.selected.length === 1 ? this.selected[0] : this.selected,
      draggable: true,
      resizable: this.selected.length === 1,
      snappable: true,
      elementGuidelines: guidelines,
      snapDirections: { top: true, left: true, right: true, bottom: true, center: true, middle: true },
      elementSnapDirections: { top: true, left: true, right: true, bottom: true, center: true, middle: true },
      origin: false,
      useResizeObserver: true,
      throttleDrag: 1,
      throttleResize: 1,
    });
    this.bindMoveable(this.moveable);
  }

  private bindMoveable(moveable: Moveable): void {
    const start = (event?: any): void => {
      const x = Number(event?.clientX || 0);
      const y = Number(event?.clientY || 0);
      this.dragState = { styles: new Map(this.selected.map((element) => [element, element.getAttribute("style")])), lastX: x, lastY: y, startX: x, startY: y, distance: 0, axis: null };
    };
    const updateDrag = (event: any): void => {
      if (!this.dragState) start(event);
      const x = Number(event.clientX || this.dragState!.lastX);
      const y = Number(event.clientY || this.dragState!.lastY);
      const dx = x - this.dragState!.startX;
      const dy = y - this.dragState!.startY;
      this.dragState!.lastX = x;
      this.dragState!.lastY = y;
      this.dragState!.distance = Math.max(this.dragState!.distance, Math.hypot(dx, dy));
      const shift = Boolean(event.inputEvent?.shiftKey);
      if (shift && !this.dragState!.axis && this.dragState!.distance >= 4) this.dragState!.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      if (!shift) this.dragState!.axis = null;
      const translate = event.beforeTranslate || event.translate;
      if (shift && translate) {
        const nextX = this.dragState!.axis === "y" ? 0 : translate[0];
        const nextY = this.dragState!.axis === "x" ? 0 : translate[1];
        event.target.style.transform = `translate(${Math.round(nextX)}px, ${Math.round(nextY)}px)`;
      } else event.target.style.transform = event.transform;
    };
    moveable.on("dragStart", start);
    moveable.on("drag", updateDrag);
    moveable.on("dragEnd", (event: any) => this.finishDrag(event));
    moveable.on("dragGroupStart", (event: any) => start(event.events?.[0] || event));
    moveable.on("dragGroup", (event: any) => {
      for (const item of event.events || []) updateDrag(item);
    });
    moveable.on("dragGroupEnd", (event: any) => this.finishDrag(event));
    moveable.on("resizeStart", (event: any) => {
      start();
      event.setOrigin(["%", "%"]);
    });
    moveable.on("resize", (event: any) => {
      event.target.style.width = `${Math.max(1, Math.round(event.width))}px`;
      event.target.style.height = `${Math.max(1, Math.round(event.height))}px`;
      if (event.drag?.transform) event.target.style.transform = event.drag.transform;
    });
    moveable.on("resizeEnd", () => this.finishStyleChange("调整元素尺寸"));
  }

  private finishDrag(event: any): void {
    if (!this.dragState) return;
    if (this.dragState.distance < 4) {
      for (const [element, style] of this.dragState.styles) {
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
      }
      this.dragState = null;
      this.createMoveable();
      return;
    }
    const selected = [...this.selected];
    const primary = selected[0];
    const style = this.window?.getComputedStyle(primary);
    const useFree = this.freePosition || style?.position === "absolute" || style?.position === "fixed";
    if (useFree || selected.length > 1) {
      this.finishStyleChange("移动元素");
      return;
    }
    const originalStyle = this.dragState.styles.get(primary);
    if (originalStyle === null) primary.removeAttribute("style");
    else primary.setAttribute("style", originalStyle || "");
    const point = event?.lastEvent || event;
    const hit = this.document?.elementFromPoint(point?.clientX ?? this.dragState.lastX, point?.clientY ?? this.dragState.lastY) as HTMLElement | null;
    let sibling = hit;
    while (sibling?.parentElement && sibling.parentElement !== primary.parentElement) sibling = sibling.parentElement;
    if (sibling && sibling !== primary && sibling.parentElement === primary.parentElement) {
      const parent = primary.parentElement!;
      const before = cleanInnerHtml(parent);
      const rect = sibling.getBoundingClientRect();
      const parentStyle = this.window?.getComputedStyle(parent);
      const horizontal = parentStyle?.display.includes("flex") && parentStyle.flexDirection.startsWith("row");
      const after = horizontal ? this.dragState.lastX < rect.left + rect.width / 2 : this.dragState.lastY < rect.top + rect.height / 2;
      parent.insertBefore(primary, after ? sibling : sibling.nextSibling);
      this.commit("调整元素顺序", [{ type: "set-inner-html", target: this.targetFor(parent), html: cleanInnerHtml(parent), before, after: cleanInnerHtml(parent) }]);
    }
    this.dragState = null;
    this.createMoveable();
  }

  private finishStyleChange(label: string): void {
    if (!this.dragState) return;
    const patches: EditorPatch[] = this.selected.flatMap((element) => {
      const before = this.dragState!.styles.get(element) ?? null;
      const after = element.getAttribute("style");
      return before === after ? [] : [{ type: "set-attribute", target: this.targetFor(element), name: "style", value: after, before, after }];
    });
    this.dragState = null;
    this.commit(label, patches);
  }

  private targetFor(element: Element, assignId = true): ElementTarget {
    const html = element as HTMLElement;
    const existingId = html.id || undefined;
    const heId = existingId ? undefined : (html.dataset.heId || (assignId ? (html.dataset.heId = uniqueId("node")) : undefined));
    const path: number[] = [];
    let current: Element | null = element;
    const root = element.ownerDocument.documentElement;
    while (current && current !== root) {
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      path.unshift(Array.from(parent.children).indexOf(current));
      current = parent;
    }
    return {
      heId,
      existingId,
      domPath: path,
      tagName: element.tagName.toLowerCase(),
      originalText: shortText(element.textContent || "", 80),
      sourceAttributes: Object.fromEntries(["data-page", "data-action", "data-key", "data-id", "name", "type", "role"].flatMap((name) => {
        const value = element.getAttribute(name);
        return value === null ? [] : [[name, value]];
      })),
    };
  }

  private resolveTarget(target: ElementTarget | null): HTMLElement | null {
    const document = this.document;
    if (!document || !target) return null;
    if (target.heId) {
      const byEditorId = document.querySelector(`[data-he-id="${CSS.escape(target.heId)}"]`) as HTMLElement | null;
      if (byEditorId) return byEditorId;
    }
    if (target.existingId) {
      const byId = document.getElementById(target.existingId);
      if (byId) return byId;
    }
    let current: Element | null = document.documentElement;
    for (const index of target.domPath) {
      current = current?.children[index] || null;
      if (!current) return null;
    }
    return current?.tagName.toLowerCase() === target.tagName ? current as HTMLElement : null;
  }

  private currentPageId(): string {
    const document = this.document;
    if (!document) return this.pages[0]?.id || "page:main";
    const scoped = Array.from(document.querySelectorAll("[data-proto-scope^='page:'],[data-zann-scope^='page:']"))
      .filter(visible)
      .sort((a, b) => (b.getAttribute("data-proto-layer") || b.getAttribute("data-zann-layer") || "0").localeCompare(a.getAttribute("data-proto-layer") || a.getAttribute("data-zann-layer") || "0"))[0];
    const scope = scoped?.getAttribute("data-proto-scope") || scoped?.getAttribute("data-zann-scope");
    if (scope) {
      const runtimeKey = scope.split(":")[1] || "main";
      const page = [...this.pages].sort((a, b) => b.key.length - a.key.length).find((item) => runtimeKey === item.key || runtimeKey.startsWith(`${item.key}-`));
      return page?.id || `page:${runtimeKey}`;
    }
    const active = document.querySelector("[data-action='page'][data-page].active,[data-page].active") as HTMLElement | null;
    return active?.dataset.page ? `page:${active.dataset.page}` : this.pages[0]?.id || "page:main";
  }

  private pageRoot(pageId: string): HTMLElement {
    const document = this.document!;
    const key = pageId.replace(/^page:/, "");
    const scoped = Array.from(document.querySelectorAll(`[data-proto-scope^="page:${CSS.escape(key)}"],[data-zann-scope^="page:${CSS.escape(key)}"]`)).find(visible) as HTMLElement | undefined;
    return scoped || (document.querySelector("[data-proto-app],[data-zann-app-root]") as HTMLElement | null) || document.body;
  }

  private scheduleTree(): void {
    window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.rebuildTree(), 80);
  }

  private rebuildTree(): void {
    if (!this.document?.body) return;
    const currentPageId = this.currentPageId();
    const pageRoot = this.pageRoot(currentPageId);
    let count = 0;
    const build = (element: Element, pageId: string, depth: number): TreeNode | null => {
      if (count >= 700 || depth > 10 || element.matches(RUNTIME_SELECTOR) || element.closest(ANNOTATION_SELECTOR)) return null;
      const html = element as HTMLElement;
      const tag = element.tagName.toLowerCase();
      const style = this.window?.getComputedStyle(html);
      const children = Array.from(element.children).filter((child) => !child.matches(RUNTIME_SELECTOR) && !child.closest(ANNOTATION_SELECTOR));
      const hasDirectText = Boolean(directText(element));
      const isContainer = CONTAINER_TAGS.has(tag) || style?.display.includes("flex") || style?.display.includes("grid") || (children.length > 1 && ["block", "flow-root"].includes(style?.display || ""));
      const isLeaf = ELEMENT_TAGS.has(tag) || hasDirectText;
      if (!isContainer && !isLeaf) {
        const promoted = children.map((child) => build(child, pageId, depth)).filter(Boolean) as TreeNode[];
        if (promoted.length === 1) return promoted[0];
        if (!promoted.length) return null;
      }
      count += 1;
      const target = this.targetFor(element, false);
      const node: TreeNode = {
        id: `${pageId}:${target.existingId || target.heId || target.domPath.join(".") || count}`,
        type: isContainer ? "container" : "element",
        label: labelFor(element),
        detail: typeLabel(tag),
        element,
        target,
        pageId,
        children: [],
      };
      if (isContainer) node.children = children.map((child) => build(child, pageId, depth + 1)).filter(Boolean) as TreeNode[];
      return node;
    };
    const currentChildren = Array.from(pageRoot.children).map((child) => build(child, currentPageId, 0)).filter(Boolean) as TreeNode[];
    this.treeCache.set(currentPageId, currentChildren);
    const tree = this.pages.map((page) => ({
      id: page.id,
      type: "page" as const,
      label: page.title,
      detail: "页面",
      element: page.id === currentPageId ? pageRoot : undefined,
      target: page.id === currentPageId ? this.targetFor(pageRoot, false) : undefined,
      pageId: page.id,
      children: this.treeCache.get(page.id) || [],
    }));
    if (!tree.some((page) => page.id === currentPageId)) {
      tree.unshift({ id: currentPageId, type: "page", label: currentPageId.replace(/^page:/, ""), detail: "当前页面", element: pageRoot, target: this.targetFor(pageRoot, false), pageId: currentPageId, children: currentChildren });
    }
    this.lastTree = tree;
    this.callbacks.onTree(tree, currentPageId);
  }

  openPage(pageId: string, after?: () => void): void {
    const document = this.document;
    const frameWindow = this.window as any;
    if (!document) return;
    const page = this.pages.find((item) => item.id === pageId);
    const key = page?.key || pageId.replace(/^page:/, "");
    const scope = page?.scope || `page:${key}`;
    const findRoute = () => document.querySelector(`[data-action="page"][data-page="${CSS.escape(key)}"],[data-page-link="${CSS.escape(key)}"],[data-proto-route="${CSS.escape(scope)}"],[data-zann-scope-route="${CSS.escape(scope)}"]`) as HTMLElement | null;
    const finish = (opened: boolean) => {
      this.navigating = false;
      if (!opened) return;
      window.setTimeout(() => {
        this.clearSelection();
        this.rebuildTree();
        after?.();
      }, 80);
    };
    const invokePageMethod = () => {
      const method = ["openPage", "showPage", "navigate", "switchPage"].find((name) => typeof frameWindow?.[name] === "function");
      if (!method) return false;
      frameWindow[method](key);
      return true;
    };

    this.navigating = true;
    const directRoute = findRoute();
    if (directRoute) {
      directRoute.click();
      finish(true);
      return;
    }

    const getModuleButtons = () => Array.from(document.querySelectorAll<HTMLElement>('[data-action="module"][data-module]'));
    const initialModuleButtons = getModuleButtons();
    const activeModuleId = initialModuleButtons.find((button) => button.classList.contains("active") || button.getAttribute("aria-selected") === "true")?.dataset.module;
    const cachedModule = this.pageRouteCache.get(key);
    const contextSelects = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).filter((select) => {
      const hint = [select.id, select.name, select.getAttribute("aria-label"), select.getAttribute("title")].filter(Boolean).join(" ");
      return /role|department|dept|tenant|角色|部门|组织|机构/i.test(hint);
    });
    const originalContext = new Map(contextSelects.map((select) => [select, select.value]));
    const contextCandidates = contextSelects
      .sort((left, right) => Number(/role|角色/i.test([right.id, right.name, right.getAttribute("aria-label")].join(" "))) - Number(/role|角色/i.test([left.id, left.name, left.getAttribute("aria-label")].join(" "))))
      .flatMap((select) => Array.from(select.options)
        .filter((option) => !option.disabled && option.value !== select.value)
        .map((option) => ({ select, value: option.value, label: option.textContent?.trim() || option.value })));

    const restoreContext = () => {
      originalContext.forEach((value, select) => {
        if (!select.isConnected || select.value === value) return;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      if (activeModuleId) {
        window.setTimeout(() => document.querySelector<HTMLElement>(`[data-action="module"][data-module="${CSS.escape(activeModuleId)}"]`)?.click(), 30);
      }
    };
    const changeContext = (select: HTMLSelectElement, value: string) => {
      if (!select.isConnected) return false;
      select.value = value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const tryContext = (index: number) => {
      if (index >= contextCandidates.length) {
        restoreContext();
        this.callbacks.onStatus(`无法自动打开页面：${page?.title || key}`);
        finish(false);
        return;
      }
      const candidate = contextCandidates[index];
      if (!changeContext(candidate.select, candidate.value)) {
        tryContext(index + 1);
        return;
      }
      window.setTimeout(() => scanModules(getModuleButtons(), 0, () => tryContext(index + 1), candidate.label), 40);
    };
    const scanModules = (moduleButtons: HTMLElement[], index: number, onMiss: () => void, contextLabel?: string) => {
      if (index >= moduleButtons.length) {
        if (invokePageMethod()) {
          window.setTimeout(() => {
            if (findRoute() || this.currentPageId() === pageId) {
              if (contextLabel) this.callbacks.onStatus(`已切换到“${contextLabel}”并打开页面`);
              finish(true);
              return;
            }
            onMiss();
          }, 40);
          return;
        }
        onMiss();
        return;
      }
      const moduleButton = moduleButtons[index];
      moduleButton.click();
      window.setTimeout(() => {
        const route = findRoute();
        if (!route) {
          scanModules(moduleButtons, index + 1, onMiss, contextLabel);
          return;
        }
        if (moduleButton.dataset.module) this.pageRouteCache.set(key, moduleButton.dataset.module);
        route.click();
        if (contextLabel) this.callbacks.onStatus(`已切换到“${contextLabel}”并打开页面`);
        finish(true);
      }, 30);
    };
    const moduleButtons = getModuleButtons();
    moduleButtons.sort((left, right) => Number(right.dataset.module === cachedModule) - Number(left.dataset.module === cachedModule));
    scanModules(moduleButtons, 0, () => tryContext(0));
  }

  snapshot(): SelectionSnapshot | null {
    if (!this.selected.length) return null;
    const element = this.selected[0];
    const computed = this.window?.getComputedStyle(element);
    const styleNames = ["width", "height", "min-width", "min-height", "max-width", "max-height", "position", "top", "right", "bottom", "left", "display", "gap", "flex-direction", "flex-wrap", "justify-content", "align-items", "grid-template-columns", "grid-template-rows", "margin", "padding", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "color", "background-color", "border-width", "border-style", "border-color", "border-radius", "box-shadow", "opacity", "overflow", "z-index"];
    return {
      elements: [...this.selected],
      target: this.targetFor(element),
      tagName: element.tagName.toLowerCase(),
      text: element.textContent?.trim() || "",
      attributes: Object.fromEntries(Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value])),
      styles: Object.fromEntries(styleNames.map((name) => [name, computed?.getPropertyValue(name).trim() || ""])),
      parentDisplay: element.parentElement ? this.window?.getComputedStyle(element.parentElement).display || "" : "",
      locked: element.dataset.heLocked === "true",
      treePath: this.findTreePath(element),
      options: element.tagName === "SELECT" ? Array.from((element as HTMLSelectElement).options).map((option) => ({ text: option.text, value: option.value, selected: option.selected })) : undefined,
      listItems: ["UL", "OL"].includes(element.tagName) ? Array.from(element.children).filter((child) => child.tagName === "LI").map((child) => child.textContent?.trim() || "") : undefined,
      inputType: element.tagName === "INPUT" ? (element as HTMLInputElement).type : undefined,
      checked: element.tagName === "INPUT" ? (element as HTMLInputElement).checked : undefined,
      textEditable: this.canEditText(element),
    };
  }

  private findTreePath(element: Element): string[] {
    const visit = (nodes: TreeNode[], path: string[]): string[] | null => {
      for (const node of nodes) {
        const next = [...path, node.id];
        if (node.element === element) return next;
        const child = visit(node.children, next);
        if (child) return child;
      }
      return null;
    };
    return visit(this.lastTree, []) || [];
  }

  applyStyle(property: string, value: string): void {
    if (!this.selected.length) return;
    const patches = this.selected.flatMap((element) => {
      const before = element.getAttribute("style");
      if (value.trim()) element.style.setProperty(property, value.trim());
      else element.style.removeProperty(property);
      const after = element.getAttribute("style");
      return before === after ? [] : [{ type: "set-attribute" as const, target: this.targetFor(element), name: "style", value: after, before, after }];
    });
    if (patches.length) this.commit(`修改 ${property}`, patches);
  }

  applyAttribute(name: string, value: string): void {
    if (this.selected.length !== 1) return;
    const element = this.selected[0];
    const before = element.getAttribute(name);
    if (value === "") element.removeAttribute(name);
    else element.setAttribute(name, value);
    const after = element.getAttribute(name);
    if (before !== after) this.commit(`修改 ${name}`, [{ type: "set-attribute", target: this.targetFor(element), name, value: after, before, after }]);
  }

  applyBooleanAttribute(name: string, enabled: boolean): void {
    if (this.selected.length !== 1) return;
    const element = this.selected[0];
    const before = element.getAttribute(name);
    if (enabled) element.setAttribute(name, "");
    else element.removeAttribute(name);
    const after = element.getAttribute(name);
    if (before !== after) this.commit(`修改${name}`, [{ type: "set-attribute", target: this.targetFor(element), name, value: enabled ? "" : null, before, after }]);
  }

  applyLayoutPreset(preset: "normal" | "horizontal" | "vertical" | "grid"): void {
    if (!this.selected.length) return;
    const patches = this.selected.flatMap((element) => {
      const before = element.getAttribute("style");
      if (preset === "normal") {
        element.style.display = "block";
        element.style.removeProperty("flex-direction");
        element.style.removeProperty("grid-template-columns");
      } else if (preset === "horizontal" || preset === "vertical") {
        element.style.display = "flex";
        element.style.flexDirection = preset === "horizontal" ? "row" : "column";
      } else {
        element.style.display = "grid";
        if (!element.style.gridTemplateColumns) element.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
      }
      const after = element.getAttribute("style");
      return before === after ? [] : [{ type: "set-attribute" as const, target: this.targetFor(element), name: "style", value: after, before, after }];
    });
    if (patches.length) this.commit("修改排列方式", patches);
  }

  setPosition(axis: "x" | "y", value: number): void {
    if (!this.selected.length || !Number.isFinite(value)) return;
    const patches = this.selected.flatMap((element) => {
      const before = element.getAttribute("style");
      if (this.window!.getComputedStyle(element).position === "static") element.style.position = "relative";
      element.style.setProperty(axis === "x" ? "left" : "top", `${Math.round(value)}px`);
      const after = element.getAttribute("style");
      return before === after ? [] : [{ type: "set-attribute" as const, target: this.targetFor(element), name: "style", value: after, before, after }];
    });
    if (patches.length) this.commit(axis === "x" ? "设置水平位置" : "设置垂直位置", patches);
  }

  applySelectOptions(options: Array<{ text: string; value: string; selected: boolean }>): void {
    const element = this.selected[0];
    if (!element || element.tagName !== "SELECT") return;
    const select = element as HTMLSelectElement;
    const before = select.innerHTML;
    select.innerHTML = "";
    options.forEach((item) => {
      const option = this.document!.createElement("option");
      option.textContent = item.text;
      option.value = item.value;
      option.selected = item.selected;
      select.appendChild(option);
    });
    if (before !== select.innerHTML) this.commit("修改下拉选项", [{ type: "set-inner-html", target: this.targetFor(select), html: select.innerHTML, before, after: select.innerHTML }]);
  }

  applyListItems(items: string[]): void {
    const element = this.selected[0];
    if (!element || !["UL", "OL"].includes(element.tagName)) return;
    const before = element.innerHTML;
    element.innerHTML = "";
    items.filter((item) => item.trim()).forEach((text) => {
      const item = this.document!.createElement("li");
      item.textContent = text.trim();
      element.appendChild(item);
    });
    if (before !== element.innerHTML) this.commit("修改列表项", [{ type: "set-inner-html", target: this.targetFor(element), html: element.innerHTML, before, after: element.innerHTML }]);
  }

  tableAction(action: "add-row" | "remove-row" | "add-column" | "remove-column"): void {
    const selected = this.selected[0];
    const table = selected?.closest("table") as HTMLTableElement | null;
    if (!selected || !table) return;
    const before = table.innerHTML;
    const cell = selected.closest("td,th") as HTMLTableCellElement | null;
    const row = cell?.parentElement as HTMLTableRowElement | null;
    if (action === "add-row") {
      const sourceRow = row || table.rows[table.rows.length - 1];
      if (!sourceRow) return;
      const clone = sourceRow.cloneNode(true) as HTMLTableRowElement;
      clone.querySelectorAll("th,td").forEach((item) => { item.textContent = "新增内容"; });
      sourceRow.after(clone);
    } else if (action === "remove-row") {
      if (!row || table.rows.length <= 1) return;
      row.remove();
    } else if (action === "add-column") {
      const index = cell?.cellIndex ?? Math.max(0, (table.rows[0]?.cells.length || 1) - 1);
      Array.from(table.rows).forEach((item) => {
        const reference = item.cells[index];
        const next = this.document!.createElement(reference?.tagName.toLowerCase() === "th" ? "th" : "td");
        next.textContent = "新增内容";
        if (reference) reference.after(next);
        else item.appendChild(next);
      });
    } else {
      const index = cell?.cellIndex ?? -1;
      if (index < 0 || (table.rows[0]?.cells.length || 0) <= 1) return;
      Array.from(table.rows).forEach((item) => item.cells[index]?.remove());
    }
    this.commit("修改表格", [{ type: "set-inner-html", target: this.targetFor(table), html: table.innerHTML, before, after: table.innerHTML }]);
    this.rebuildTree();
  }

  applyText(value: string): void {
    if (this.selected.length !== 1 || !this.canEditText(this.selected[0])) return;
    const element = this.selected[0];
    if ((element.textContent || "").trim() === value.trim()) return;
    const before = element.innerHTML;
    element.textContent = value;
    this.commit("修改文字", [{ type: "set-inner-html", target: this.targetFor(element), html: element.innerHTML, before, after: element.innerHTML }]);
  }

  private startTextEdit(element: HTMLElement): void {
    const before = element.innerHTML;
    element.contentEditable = "true";
    element.dataset.heEditing = "true";
    element.focus();
    const finish = (restore = false): void => {
      element.removeEventListener("blur", blur);
      element.removeEventListener("keydown", keydown);
      if (restore) element.innerHTML = before;
      element.removeAttribute("contenteditable");
      element.removeAttribute("data-he-editing");
      if (!restore && element.innerHTML !== before) {
        this.commit("编辑文字", [{ type: "set-inner-html", target: this.targetFor(element), html: element.innerHTML, before, after: element.innerHTML }]);
      }
      this.createMoveable();
    };
    const blur = (): void => finish(false);
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(true);
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        finish(false);
      }
    };
    element.addEventListener("blur", blur, { once: true });
    element.addEventListener("keydown", keydown);
  }

  copy(): void {
    if (!this.selected.length) return;
    this.clipboardHtml = this.selected.map((element) => cleanClone(element).outerHTML).join("");
    this.callbacks.onStatus(`已复制 ${this.selected.length} 个元素`);
  }

  cut(): void {
    this.copy();
    this.deleteSelected();
  }

  paste(): void {
    if (!this.clipboardHtml || !this.selected.length) return;
    const anchor = this.selected[0];
    const parent = anchor.parentElement;
    if (!parent) return;
    const template = this.document!.createElement("template");
    template.innerHTML = this.clipboardHtml;
    const nodes = Array.from(template.content.children);
    nodes.forEach((node) => rewriteCloneIds(node));
    const before = cleanInnerHtml(parent);
    anchor.after(...nodes);
    this.commit("粘贴元素", [{ type: "set-inner-html", target: this.targetFor(parent), html: cleanInnerHtml(parent), before, after: cleanInnerHtml(parent) }]);
    const inserted = nodes.filter((node): node is HTMLElement => node.nodeType === Node.ELEMENT_NODE) as HTMLElement[];
    if (inserted.length) this.selectMany(inserted);
  }

  duplicate(): void {
    if (!this.selected.length) return;
    const clones: HTMLElement[] = [];
    const parents = new Map<HTMLElement, string>();
    for (const element of this.selected) {
      const parent = element.parentElement;
      if (!parent) continue;
      if (!parents.has(parent)) parents.set(parent, cleanInnerHtml(parent));
      const clone = cleanClone(element) as HTMLElement;
      rewriteCloneIds(clone);
      element.after(clone);
      clones.push(clone);
    }
    const patches = [...parents].map(([parent, before]) => ({ type: "set-inner-html" as const, target: this.targetFor(parent), html: cleanInnerHtml(parent), before, after: cleanInnerHtml(parent) }));
    if (patches.length) this.commit("重复元素", patches);
    if (clones.length) this.selectMany(clones);
  }

  deleteSelected(): void {
    if (!this.selected.length) return;
    const parents = new Map<HTMLElement, string>();
    for (const element of this.selected) {
      const parent = element.parentElement;
      if (!parent || parent === this.document?.body) continue;
      if (!parents.has(parent)) parents.set(parent, cleanInnerHtml(parent));
      element.remove();
    }
    const patches = [...parents].map(([parent, before]) => ({ type: "set-inner-html" as const, target: this.targetFor(parent), html: cleanInnerHtml(parent), before, after: cleanInnerHtml(parent) }));
    this.clearSelection();
    if (patches.length) this.commit("删除元素", patches);
  }

  add(kind: "text" | "image" | "button" | "input" | "container"): void {
    const parent = this.selected[0]?.closest("main,section,article,div,form") as HTMLElement | null || this.pageRoot(this.currentPageId());
    const before = cleanInnerHtml(parent);
    let element: HTMLElement;
    if (kind === "text") {
      element = this.document!.createElement("p");
      element.textContent = "新增文本";
    } else if (kind === "button") {
      element = this.document!.createElement("button");
      element.textContent = "新增按钮";
      element.setAttribute("type", "button");
    } else if (kind === "input") {
      element = this.document!.createElement("input");
      element.setAttribute("placeholder", "请输入");
    } else if (kind === "image") {
      element = this.document!.createElement("img");
      element.setAttribute("alt", "新增图片");
      element.setAttribute("src", "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=");
      element.style.cssText = "width:240px;height:160px;background:#eef2f7;object-fit:cover;";
    } else {
      element = this.document!.createElement("div");
      element.textContent = "新增容器";
      element.style.cssText = "min-height:80px;padding:16px;border:1px dashed #94a3b8;";
    }
    element.dataset.heId = uniqueId("node");
    parent.appendChild(element);
    this.commit(`新增${kind}`, [{ type: "set-inner-html", target: this.targetFor(parent), html: cleanInnerHtml(parent), before, after: cleanInnerHtml(parent) }]);
    this.select(element, false);
  }

  selectParent(): void {
    const parent = this.selected[0]?.parentElement;
    if (parent && parent !== this.document?.body) this.select(parent, false);
  }

  moveLayer(direction: "forward" | "backward" | "front" | "back"): void {
    const element = this.selected[0];
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const before = cleanInnerHtml(parent);
    if (direction === "forward" && element.nextElementSibling) element.nextElementSibling.after(element);
    else if (direction === "backward" && element.previousElementSibling) element.previousElementSibling.before(element);
    else if (direction === "front") parent.appendChild(element);
    else if (direction === "back") parent.prepend(element);
    else return;
    this.commit("调整元素层级", [{ type: "set-inner-html", target: this.targetFor(parent), html: cleanInnerHtml(parent), before, after: cleanInnerHtml(parent) }]);
  }

  toggleVisible(): void {
    const element = this.selected[0];
    if (!element) return;
    const hidden = element.style.display === "none";
    this.applyStyle("display", hidden ? "" : "none");
  }

  toggleLocked(): void {
    const element = this.selected[0];
    if (!element) return;
    this.applyAttribute("data-he-locked", element.dataset.heLocked === "true" ? "" : "true");
    this.createMoveable();
  }

  nudge(direction: string, amount: number): void {
    if (!this.selected.length) return;
    const dx = direction === "ArrowLeft" ? -amount : direction === "ArrowRight" ? amount : 0;
    const dy = direction === "ArrowUp" ? -amount : direction === "ArrowDown" ? amount : 0;
    const patches = this.selected.map((element) => {
      const before = element.getAttribute("style");
      const style = this.window!.getComputedStyle(element);
      if (style.position === "static") element.style.position = "relative";
      element.style.left = `${(Number.parseFloat(style.left) || 0) + dx}px`;
      element.style.top = `${(Number.parseFloat(style.top) || 0) + dy}px`;
      return { type: "set-attribute" as const, target: this.targetFor(element), name: "style", value: element.getAttribute("style"), before, after: element.getAttribute("style") };
    });
    this.commit("微调元素位置", patches);
  }

  align(type: "left" | "center" | "right" | "top" | "middle" | "bottom"): void {
    if (this.selected.length < 2) return;
    const reference = this.selected[0].getBoundingClientRect();
    const patches = this.selected.slice(1).map((element) => {
      const before = element.getAttribute("style");
      const rect = element.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      if (type === "left") dx = reference.left - rect.left;
      if (type === "center") dx = reference.left + reference.width / 2 - rect.left - rect.width / 2;
      if (type === "right") dx = reference.right - rect.right;
      if (type === "top") dy = reference.top - rect.top;
      if (type === "middle") dy = reference.top + reference.height / 2 - rect.top - rect.height / 2;
      if (type === "bottom") dy = reference.bottom - rect.bottom;
      const computed = this.window!.getComputedStyle(element);
      if (computed.position === "static") element.style.position = "relative";
      element.style.left = `${(Number.parseFloat(computed.left) || 0) + dx}px`;
      element.style.top = `${(Number.parseFloat(computed.top) || 0) + dy}px`;
      return { type: "set-attribute" as const, target: this.targetFor(element), name: "style", value: element.getAttribute("style"), before, after: element.getAttribute("style") };
    });
    this.commit(`对齐-${type}`, patches);
  }

  distribute(direction: "horizontal" | "vertical"): void {
    if (this.selected.length < 3) return;
    const sorted = [...this.selected].sort((a, b) => {
      const first = a.getBoundingClientRect();
      const second = b.getBoundingClientRect();
      return direction === "horizontal" ? first.left - second.left : first.top - second.top;
    });
    const first = sorted[0].getBoundingClientRect();
    const last = sorted[sorted.length - 1].getBoundingClientRect();
    const span = direction === "horizontal" ? last.left - first.left : last.top - first.top;
    const step = span / (sorted.length - 1);
    const patches = sorted.slice(1, -1).map((element, index) => {
      const before = element.getAttribute("style");
      const rect = element.getBoundingClientRect();
      const expected = (direction === "horizontal" ? first.left : first.top) + step * (index + 1);
      const delta = expected - (direction === "horizontal" ? rect.left : rect.top);
      const computed = this.window!.getComputedStyle(element);
      if (computed.position === "static") element.style.position = "relative";
      if (direction === "horizontal") element.style.left = `${(Number.parseFloat(computed.left) || 0) + delta}px`;
      else element.style.top = `${(Number.parseFloat(computed.top) || 0) + delta}px`;
      return { type: "set-attribute" as const, target: this.targetFor(element), name: "style", value: element.getAttribute("style"), before, after: element.getAttribute("style") };
    });
    this.commit(direction === "horizontal" ? "水平等距分布" : "垂直等距分布", patches);
  }

  private commit(label: string, patches: EditorPatch[]): void {
    if (!patches.length) return;
    const command: EditorCommand = {
      id: uniqueId("cmd"),
      label,
      pageId: this.currentPageId(),
      patches,
      createdAt: new Date().toISOString(),
    };
    void this.callbacks.onCommand(command).then(() => {
      this.callbacks.onStatus(`${label}已记录`);
      this.rebuildTree();
      this.callbacks.onSelection(this.snapshot());
    }).catch((error) => {
      this.callbacks.onStatus(error instanceof Error ? error.message : String(error));
      this.callbacks.onCommandRejected();
    });
  }
}
