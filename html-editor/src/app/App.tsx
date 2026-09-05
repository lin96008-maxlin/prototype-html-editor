import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Box,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Copy,
  Eye,
  EyeOff,
  FileCode2,
  Image,
  Keyboard,
  Lock,
  Maximize2,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Redo2,
  Scissors,
  Search,
  Trash2,
  Type,
  Undo2,
  Unlock,
  X,
} from "lucide-react";
import { api } from "./api";
import { FrameController } from "./frame";
import { ProductInspector } from "./ProductInspector";
import { useEditorStore } from "./store";
import type { EditorMode, SelectionSnapshot, TreeNode } from "./types";

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function IconButton({ title, disabled, active, onClick, children }: { title: string; disabled?: boolean; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`icon-button${active ? " active" : ""}`} type="button" title={title} aria-label={title} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

function Field({ label, value, type = "text", options, onCommit }: { label: string; value: string; type?: "text" | "number" | "color"; options?: Array<[string, string]>; onCommit: (value: string) => void }) {
  if (options) {
    return <label className="field"><span>{label}</span><select key={`${label}-${value}`} defaultValue={value} onChange={(event) => onCommit(event.target.value)}>{options.map(([itemValue, text]) => <option key={itemValue} value={itemValue}>{text}</option>)}</select></label>;
  }
  return <label className="field"><span>{label}</span><input key={`${label}-${value}`} type={type} defaultValue={value} onBlur={(event) => onCommit(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function TreeItem({ node, depth, search, selected, expanded, onToggle, onSelect }: { node: TreeNode; depth: number; search: string; selected: Element[]; expanded: Set<string>; onToggle: (node: TreeNode) => void; onSelect: (node: TreeNode) => void }) {
  const hasChildren = node.children.length > 0;
  const canExpand = hasChildren || node.type === "page";
  const isExpanded = expanded.has(node.id) || Boolean(search);
  const matches = !search || `${node.label} ${node.detail}`.toLowerCase().includes(search);
  const childMatches = node.children.some((child) => `${child.label} ${child.detail}`.toLowerCase().includes(search));
  if (!matches && !childMatches && search) return null;
  const isSelected = Boolean(node.element && selected.includes(node.element));
  const Icon = node.type === "page" ? FileCode2 : node.type === "container" ? Box : MousePointer2;
  return <div className="tree-branch">
    <div data-tree-id={node.id} className={`tree-row${isSelected ? " selected" : ""}${node.type === "page" ? " page" : ""}`} style={{ paddingLeft: `${8 + depth * 14}px` }}>
      <button className="tree-toggle" type="button" aria-label={isExpanded ? "收起" : "展开"} onClick={() => canExpand && onToggle(node)} disabled={!canExpand}>{canExpand ? (isExpanded && hasChildren ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span />}</button>
      <button className="tree-label" type="button" title={`${node.label} · ${node.detail}`} onClick={() => onSelect(node)}>
        <Icon size={14} aria-hidden="true" />
        <span>{node.label}</span>
        <small>{node.detail}</small>
      </button>
    </div>
    {hasChildren && isExpanded && <div>{node.children.map((child) => <TreeItem key={child.id} node={child} depth={depth + 1} search={search} selected={selected} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />)}</div>}
  </div>;
}

function Inspector({ selection, controller }: { selection: SelectionSnapshot | null; controller: FrameController | null }) {
  if (!selection || !controller) return <div className="empty-panel"><MousePointer2 size={24} /><span>未选择元素</span></div>;
  const multiple = selection.elements.length > 1;
  const attr = (name: string): string => selection.attributes[name] || "";
  const style = (name: string): string => selection.styles[name] || "";
  return <div className="inspector-scroll" key={`${selection.target?.existingId || selection.target?.heId || selection.tagName}-${selection.elements.length}-${selection.attributes.style || ""}`}>
    <section className="inspector-section inspector-summary">
      <div><strong>{multiple ? `${selection.elements.length} 个元素` : `<${selection.tagName}>`}</strong><span>{selection.parentDisplay || "block"}</span></div>
      <IconButton title={selection.locked ? "解除锁定" : "锁定位置和尺寸"} active={selection.locked} onClick={() => controller.toggleLocked()}>{selection.locked ? <Lock size={15} /> : <Unlock size={15} />}</IconButton>
    </section>

    {multiple && <section className="inspector-section"><h3>对齐与分布</h3><div className="tool-grid">
      <IconButton title="左对齐" onClick={() => controller.align("left")}><AlignStartVertical size={15} /></IconButton>
      <IconButton title="水平居中" onClick={() => controller.align("center")}><AlignCenterVertical size={15} /></IconButton>
      <IconButton title="右对齐" onClick={() => controller.align("right")}><AlignEndVertical size={15} /></IconButton>
      <IconButton title="顶对齐" onClick={() => controller.align("top")}><AlignStartHorizontal size={15} /></IconButton>
      <IconButton title="垂直居中" onClick={() => controller.align("middle")}><AlignCenterHorizontal size={15} /></IconButton>
      <IconButton title="底对齐" onClick={() => controller.align("bottom")}><AlignEndHorizontal size={15} /></IconButton>
      <IconButton title="水平等距" onClick={() => controller.distribute("horizontal")}><AlignHorizontalDistributeCenter size={15} /></IconButton>
      <IconButton title="垂直等距" onClick={() => controller.distribute("vertical")}><AlignVerticalDistributeCenter size={15} /></IconButton>
    </div></section>}

    {!multiple && <section className="inspector-section"><h3>内容</h3>
      {!(["img", "input", "select", "textarea", "video", "audio", "iframe", "canvas", "svg"].includes(selection.tagName)) && <label className="field field-textarea"><span>文字</span><textarea defaultValue={selection.text} onBlur={(event) => controller.applyText(event.target.value)} /></label>}
      {selection.tagName === "img" && <><Field label="图片地址" value={attr("src")} onCommit={(value) => controller.applyAttribute("src", value)} /><Field label="替代文字" value={attr("alt")} onCommit={(value) => controller.applyAttribute("alt", value)} /></>}
      {selection.tagName === "a" && <Field label="链接地址" value={attr("href")} onCommit={(value) => controller.applyAttribute("href", value)} />}
      {["input", "textarea"].includes(selection.tagName) && <><Field label="默认值" value={attr("value")} onCommit={(value) => controller.applyAttribute("value", value)} /><Field label="占位文字" value={attr("placeholder")} onCommit={(value) => controller.applyAttribute("placeholder", value)} /></>}
    </section>}

    <section className="inspector-section"><h3>尺寸与位置</h3><div className="field-grid">
      <Field label="宽" value={style("width")} onCommit={(value) => controller.applyStyle("width", value)} />
      <Field label="高" value={style("height")} onCommit={(value) => controller.applyStyle("height", value)} />
      <Field label="左" value={style("left")} onCommit={(value) => controller.applyStyle("left", value)} />
      <Field label="上" value={style("top")} onCommit={(value) => controller.applyStyle("top", value)} />
    </div>
      <Field label="定位" value={style("position")} options={[["static", "默认"], ["relative", "相对"], ["absolute", "绝对"], ["fixed", "固定"], ["sticky", "吸附"]]} onCommit={(value) => controller.applyStyle("position", value)} />
      <label className="switch-field"><span>自由定位</span><input type="checkbox" checked={controller.isFreePosition()} onChange={(event) => controller.setFreePosition(event.target.checked)} /></label>
    </section>

    <section className="inspector-section"><h3>布局</h3>
      <Field label="显示" value={style("display")} options={[["block", "块级"], ["inline-block", "行内块"], ["flex", "Flex"], ["grid", "Grid"], ["none", "隐藏"]]} onCommit={(value) => controller.applyStyle("display", value)} />
      <Field label="外边距" value={style("margin")} onCommit={(value) => controller.applyStyle("margin", value)} />
      <Field label="内边距" value={style("padding")} onCommit={(value) => controller.applyStyle("padding", value)} />
      <Field label="间距" value={style("gap")} onCommit={(value) => controller.applyStyle("gap", value)} />
      {style("display").includes("flex") && <><Field label="方向" value={style("flex-direction")} options={[["row", "水平"], ["column", "垂直"], ["row-reverse", "水平反向"], ["column-reverse", "垂直反向"]]} onCommit={(value) => controller.applyStyle("flex-direction", value)} /><Field label="主轴" value={style("justify-content")} options={[["flex-start", "起点"], ["center", "居中"], ["flex-end", "终点"], ["space-between", "两端"], ["space-around", "环绕"]]} onCommit={(value) => controller.applyStyle("justify-content", value)} /><Field label="交叉轴" value={style("align-items")} options={[["stretch", "拉伸"], ["flex-start", "起点"], ["center", "居中"], ["flex-end", "终点"]]} onCommit={(value) => controller.applyStyle("align-items", value)} /></>}
      {style("display").includes("grid") && <><Field label="列模板" value={style("grid-template-columns")} onCommit={(value) => controller.applyStyle("grid-template-columns", value)} /><Field label="行模板" value={style("grid-template-rows")} onCommit={(value) => controller.applyStyle("grid-template-rows", value)} /></>}
    </section>

    <section className="inspector-section"><h3>文字</h3>
      <Field label="字体" value={style("font-family")} onCommit={(value) => controller.applyStyle("font-family", value)} />
      <div className="field-grid"><Field label="字号" value={style("font-size")} onCommit={(value) => controller.applyStyle("font-size", value)} /><Field label="字重" value={style("font-weight")} onCommit={(value) => controller.applyStyle("font-weight", value)} /></div>
      <div className="field-grid"><Field label="行高" value={style("line-height")} onCommit={(value) => controller.applyStyle("line-height", value)} /><Field label="字距" value={style("letter-spacing")} onCommit={(value) => controller.applyStyle("letter-spacing", value)} /></div>
      <Field label="对齐" value={style("text-align")} options={[["left", "左"], ["center", "中"], ["right", "右"], ["justify", "两端"]]} onCommit={(value) => controller.applyStyle("text-align", value)} />
      <Field label="文字颜色" value={style("color")} onCommit={(value) => controller.applyStyle("color", value)} />
    </section>

    <section className="inspector-section"><h3>外观</h3>
      <Field label="背景" value={style("background-color")} onCommit={(value) => controller.applyStyle("background-color", value)} />
      <div className="field-grid"><Field label="边框宽" value={style("border-width")} onCommit={(value) => controller.applyStyle("border-width", value)} /><Field label="圆角" value={style("border-radius")} onCommit={(value) => controller.applyStyle("border-radius", value)} /></div>
      <Field label="边框颜色" value={style("border-color")} onCommit={(value) => controller.applyStyle("border-color", value)} />
      <Field label="阴影" value={style("box-shadow")} onCommit={(value) => controller.applyStyle("box-shadow", value)} />
      <div className="field-grid"><Field label="透明度" value={style("opacity")} onCommit={(value) => controller.applyStyle("opacity", value)} /><Field label="层级" value={style("z-index")} onCommit={(value) => controller.applyStyle("z-index", value)} /></div>
      <Field label="溢出" value={style("overflow")} options={[["visible", "显示"], ["hidden", "隐藏"], ["auto", "自动"], ["scroll", "滚动"]]} onCommit={(value) => controller.applyStyle("overflow", value)} />
    </section>
  </div>;
}

export function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<FrameController | null>(null);
  const [revision, setRevision] = useState(0);
  const [frameRequestMode, setFrameRequestMode] = useState<EditorMode>("preview");
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(340);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [treeSearch, setTreeSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [viewportHeight, setViewportHeight] = useState(900);
  const [zoom, setZoom] = useState(0.7);
  const bootstrap = useEditorStore((state) => state.bootstrap);
  const mode = useEditorStore((state) => state.mode);
  const tree = useEditorStore((state) => state.tree);
  const selection = useEditorStore((state) => state.selection);
  const status = useEditorStore((state) => state.status);
  const currentPageId = useEditorStore((state) => state.currentPageId);
  const setBootstrap = useEditorStore((state) => state.setBootstrap);
  const setModeStore = useEditorStore((state) => state.setMode);
  const setTree = useEditorStore((state) => state.setTree);
  const setSelection = useEditorStore((state) => state.setSelection);
  const setCurrentPageId = useEditorStore((state) => state.setCurrentPageId);
  const setStatus = useEditorStore((state) => state.setStatus);

  useEffect(() => {
    void api.bootstrap().then((value) => {
      setBootstrap(value);
      setCurrentPageId(value.pages[0]?.id || "page:main");
      setExpanded(new Set(value.pages[0]?.id ? [value.pages[0].id] : []));
      const savedWidth = Number(value.ui.viewportWidth);
      const savedHeight = Number(value.ui.viewportHeight);
      const savedZoom = Number(value.ui.zoom);
      setViewportWidth(savedWidth || (value.platform === "mobile" ? 414 : 1440));
      setViewportHeight(savedHeight || (value.platform === "mobile" ? 844 : 900));
      setZoom(savedZoom || (value.platform === "mobile" ? 0.8 : 0.7));
      setLeftWidth(Number(value.ui.leftWidth) || 280);
      setRightWidth(Number(value.ui.rightWidth) || 340);
      setLeftCollapsed(Boolean(value.ui.leftCollapsed));
      setRightCollapsed(Boolean(value.ui.rightCollapsed));
      setStatus(value.lastError || "已就绪");
    }).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
    return () => controllerRef.current?.destroy();
  }, [setBootstrap, setCurrentPageId, setStatus]);

  const saveUi = useCallback(() => {
    void api.saveUi({ leftWidth, rightWidth, leftCollapsed, rightCollapsed, viewportWidth, viewportHeight, zoom }).then(() => setStatus("工作台状态已保存"));
  }, [leftWidth, rightWidth, leftCollapsed, rightCollapsed, viewportWidth, viewportHeight, zoom, setStatus]);

  useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setTimeout(saveUi, 350);
    return () => window.clearTimeout(timer);
  }, [bootstrap, saveUi]);

  const switchMode = useCallback((nextMode?: EditorMode) => {
    const next = nextMode || (useEditorStore.getState().mode === "edit" ? "preview" : "edit");
    setModeStore(next);
    controllerRef.current?.setMode(next);
    setContextMenu(null);
    setStatus(next === "edit" ? "编辑模式" : "预览模式");
  }, [setModeStore, setStatus]);

  const onFrameLoad = useCallback(() => {
    const iframe = iframeRef.current;
    const currentBootstrap = useEditorStore.getState().bootstrap;
    if (!iframe || !currentBootstrap) return;
    controllerRef.current?.destroy();
    const controller = new FrameController(iframe, currentBootstrap.pages, {
      onCommand: async (command) => {
        const value = await api.command(command);
        setBootstrap(value);
      },
      onCommandRejected: () => {
        setFrameRequestMode(useEditorStore.getState().mode);
        setRevision((current) => current + 1);
      },
      onTree: (nextTree, pageId) => {
        setTree(nextTree);
        setCurrentPageId(pageId);
      },
      onSelection: setSelection,
      onContextMenu: setContextMenu,
      onModeToggle: () => switchMode(),
      onHistory: async (action) => {
        try {
          const value = await api.history(action);
          setBootstrap(value);
          setFrameRequestMode(useEditorStore.getState().mode);
          setRevision((current) => current + 1);
          setStatus(action === "undo" ? "已撤销" : "已重做");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      },
      onSave: saveUi,
      onZoomWheel: (deltaY) => setZoom((value) => clamp(value + (deltaY < 0 ? 0.05 : -0.05), 0.2, 2)),
      onStatus: setStatus,
    });
    controllerRef.current = controller;
    controller.attach(useEditorStore.getState().mode);
    const pageId = useEditorStore.getState().currentPageId;
    if (pageId && pageId !== currentBootstrap.pages[0]?.id) window.setTimeout(() => controller.openPage(pageId), 50);
  }, [saveUi, setBootstrap, setCurrentPageId, setSelection, setStatus, setTree, switchMode]);

  const history = useCallback(async (action: "undo" | "redo") => {
    try {
      const value = await api.history(action);
      setBootstrap(value);
      setFrameRequestMode(useEditorStore.getState().mode);
      setRevision((current) => current + 1);
      setStatus(action === "undo" ? "已撤销" : "已重做");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [setBootstrap, setStatus]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    setZoom(clamp(Math.min((stage.clientWidth - 48) / viewportWidth, (stage.clientHeight - 48) / viewportHeight), 0.2, 1));
  }, [viewportHeight, viewportWidth]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input,textarea,select,[contenteditable='true']")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "e") {
        event.preventDefault();
        switchMode();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void history(event.shiftKey ? "redo" : "undo");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        void history("redo");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && ["+", "="].includes(event.key)) {
        event.preventDefault();
        setZoom((value) => clamp(value + 0.05, 0.2, 2));
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "-") {
        event.preventDefault();
        setZoom((value) => clamp(value - 0.05, 0.2, 2));
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "0") {
        event.preventDefault();
        fit();
        return;
      }
      controllerRef.current?.handleShortcut(event);
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [fit, history, switchMode]);

  useEffect(() => {
    const path = selection?.treePath || [];
    if (!path.length) return;
    setExpanded((current) => new Set([...current, ...path.slice(0, -1)]));
    const timer = window.setTimeout(() => {
      const id = path[path.length - 1];
      document.querySelector(`[data-tree-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [selection?.treePath]);

  const beginResize = (side: "left" | "right", event: React.PointerEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const start = side === "left" ? leftWidth : rightWidth;
    const move = (next: PointerEvent): void => {
      const delta = next.clientX - startX;
      if (side === "left") setLeftWidth(clamp(start + delta, 200, 480));
      else setRightWidth(clamp(start - delta, 280, 520));
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const gridStyle = useMemo(() => mode === "preview" ? { gridTemplateColumns: "minmax(0,1fr)" } : {
    gridTemplateColumns: `${leftCollapsed ? 36 : leftWidth}px 6px minmax(440px,1fr) 6px ${rightCollapsed ? 36 : rightWidth}px`,
  }, [leftCollapsed, leftWidth, mode, rightCollapsed, rightWidth]);

  const selectedElements = selection?.elements || [];
  const fullPreview = mode === "preview" && bootstrap?.platform !== "mobile";
  const viewportStyle = fullPreview ? { width: "100%", height: "100%" } : { width: viewportWidth * zoom, height: viewportHeight * zoom };
  const iframeStyle = fullPreview ? { width: "100%", height: "100%", transform: "none" } : { width: viewportWidth, height: viewportHeight, transform: `scale(${zoom})` };
  const onStageWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (mode !== "edit" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const previous = zoom;
    const next = clamp(previous + (event.deltaY < 0 ? 0.05 : -0.05), 0.2, 2);
    const bounds = stage.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const offsetY = event.clientY - bounds.top;
    const contentX = (stage.scrollLeft + offsetX) / previous;
    const contentY = (stage.scrollTop + offsetY) / previous;
    setZoom(next);
    window.requestAnimationFrame(() => {
      stage.scrollLeft = contentX * next - offsetX;
      stage.scrollTop = contentY * next - offsetY;
    });
  };
  const controller = controllerRef.current;
  const contextActions = controller ? [
    ["复制", Copy, () => controller.copy()],
    ["剪切", Scissors, () => controller.cut()],
    ["粘贴", Clipboard, () => controller.paste()],
    ["重复", Copy, () => controller.duplicate()],
    ["选择父容器", Box, () => controller.selectParent()],
    [selection?.locked ? "解除锁定" : "锁定", selection?.locked ? Unlock : Lock, () => controller.toggleLocked()],
    [selection?.styles.display === "none" ? "显示" : "隐藏", selection?.styles.display === "none" ? Eye : EyeOff, () => controller.toggleVisible()],
    ["删除", Trash2, () => controller.deleteSelected()],
  ] as const : [];

  return <div className={`app mode-${mode}`} data-html-editor-status={bootstrap ? "ready" : "loading"} onClick={() => { setContextMenu(null); setAddOpen(false); }}>
    <header className="topbar">
      <div className="file-title"><FileCode2 size={17} /><strong>{bootstrap?.sourceName || "HTML 原型编辑器"}</strong><span>{bootstrap?.platform === "mobile" ? "移动端" : "Web"}</span></div>
      <div className="mode-switch" role="group" aria-label="工作台模式">
        <button className={mode === "preview" ? "active" : ""} type="button" onClick={() => switchMode("preview")}><Eye size={14} />预览</button>
        <button className={mode === "edit" ? "active" : ""} type="button" onClick={() => switchMode("edit")}><Pencil size={14} />编辑</button>
      </div>
      <div className="top-tools">
        {mode === "edit" && <div className="add-wrap"><IconButton title="新增元素" active={addOpen} onClick={() => setAddOpen((value) => !value)}><Plus size={16} /></IconButton>{addOpen && <div className="add-menu" onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => controllerRef.current?.add("text")}><Type size={15} />文本</button>
          <button type="button" onClick={() => controllerRef.current?.add("image")}><Image size={15} />图片</button>
          <button type="button" onClick={() => controllerRef.current?.add("button")}><MousePointer2 size={15} />按钮</button>
          <button type="button" onClick={() => controllerRef.current?.add("input")}><Pencil size={15} />输入框</button>
          <button type="button" onClick={() => controllerRef.current?.add("container")}><Box size={15} />容器</button>
        </div>}</div>}
        <IconButton title="撤销" disabled={!bootstrap?.canUndo} onClick={() => void history("undo")}><Undo2 size={16} /></IconButton>
        <IconButton title="重做" disabled={!bootstrap?.canRedo} onClick={() => void history("redo")}><Redo2 size={16} /></IconButton>
        <IconButton title="查看快捷键" onClick={() => setShortcutsOpen(true)}><Keyboard size={16} /></IconButton>
        {mode === "edit" && <><span className="tool-divider" />
          <label className="viewport-input" title="画布宽度"><span>W</span><input type="number" value={viewportWidth} onChange={(event) => setViewportWidth(clamp(Number(event.target.value), 240, 3840))} /></label>
          <label className="viewport-input" title="画布高度"><span>H</span><input type="number" value={viewportHeight} onChange={(event) => setViewportHeight(clamp(Number(event.target.value), 320, 2160))} /></label>
          <IconButton title="适应窗口" onClick={fit}><Maximize2 size={16} /></IconButton>
          <label className="zoom-control" title="缩放"><input type="range" min="20" max="200" value={Math.round(zoom * 100)} onChange={(event) => setZoom(Number(event.target.value) / 100)} /><span>{Math.round(zoom * 100)}%</span></label>
        </>}
      </div>
      <div className="save-state" title={`当前已记录 ${bootstrap?.cursor || 0} 项修改`}><span className="status-dot" />{status}</div>
    </header>

    <main className="workspace" style={gridStyle}>
      {mode === "edit" && <>
        <aside className={`side-panel left-panel${leftCollapsed ? " collapsed" : ""}`}>
          {leftCollapsed ? <IconButton title="展开页面栏" onClick={() => setLeftCollapsed(false)}><PanelLeftOpen size={17} /></IconButton> : <><div className="panel-heading"><strong>页面与容器</strong><IconButton title="收起页面栏" onClick={() => setLeftCollapsed(true)}><PanelLeftClose size={16} /></IconButton></div><label className="tree-search"><Search size={14} /><input type="search" placeholder="搜索页面或元素" value={treeSearch} onChange={(event) => setTreeSearch(event.target.value.toLowerCase())} /></label><div className="tree-list">{tree.map((node) => <TreeItem key={node.id} node={node} depth={0} search={treeSearch} selected={selectedElements} expanded={expanded} onToggle={(item) => {
            const shouldExpand = !expanded.has(item.id) || !item.children.length;
            setExpanded((current) => { const next = new Set(current); shouldExpand ? next.add(item.id) : next.delete(item.id); return next; });
            if (shouldExpand && item.type === "page" && item.pageId !== currentPageId) controllerRef.current?.selectTreeNode(item);
          }} onSelect={(item) => {
            if (item.type === "page") setExpanded((current) => new Set([...current, item.id]));
            controllerRef.current?.selectTreeNode(item);
          }} />)}</div></>}
        </aside>
        <div className="splitter" role="separator" aria-label="调整页面栏宽度" onPointerDown={(event) => beginResize("left", event)} />
      </>}

      <section className="stage" ref={stageRef} onWheel={onStageWheel}>
        <div className={`viewport-shell${fullPreview ? " full-preview" : ""}`} style={viewportStyle}>
          <iframe ref={iframeRef} title="原型预览" src={`/preview?rev=${revision}&mode=${frameRequestMode}`} onLoad={onFrameLoad} style={iframeStyle} />
        </div>
      </section>

      {mode === "edit" && <>
        <div className="splitter" role="separator" aria-label="调整属性栏宽度" onPointerDown={(event) => beginResize("right", event)} />
        <aside className={`side-panel right-panel${rightCollapsed ? " collapsed" : ""}`}>
          {rightCollapsed ? <IconButton title="展开属性栏" onClick={() => setRightCollapsed(false)}><PanelRightOpen size={17} /></IconButton> : <><div className="panel-heading"><strong>编辑内容</strong><IconButton title="收起属性栏" onClick={() => setRightCollapsed(true)}><PanelRightClose size={16} /></IconButton></div><ProductInspector selection={selection} controller={controllerRef.current} /></>}
        </aside>
      </>}
    </main>

    {contextMenu && <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>{contextActions.map(([label, Icon, action]) => <button key={label} type="button" className={label === "删除" ? "danger" : ""} onClick={() => { action(); setContextMenu(null); }}><Icon size={15} />{label}</button>)}</div>}
    {shortcutsOpen && <div className="modal-backdrop" role="presentation" onClick={() => setShortcutsOpen(false)}><section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title" onClick={(event) => event.stopPropagation()}><header><strong id="shortcut-title">快捷键</strong><IconButton title="关闭" onClick={() => setShortcutsOpen(false)}><X size={16} /></IconButton></header><div className="shortcut-list">
      <span>撤销 / 重做</span><kbd>Ctrl+Z / Ctrl+Y</kbd><span>复制 / 剪切 / 粘贴</span><kbd>Ctrl+C / X / V</kbd><span>重复</span><kbd>Ctrl+D</kbd><span>多选</span><kbd>Ctrl+点击</kbd><span>锁定方向移动</span><kbd>Shift+拖动</kbd><span>微调 / 快速微调</span><kbd>方向键 / Shift+方向键</kbd><span>编辑文字</span><kbd>Enter</kbd><span>删除 / 取消</span><kbd>Delete / Esc</kbd><span>切换预览与编辑</span><kbd>Ctrl+E</kbd><span>缩放 / 适应窗口</span><kbd>Ctrl+滚轮 / Ctrl+0</kbd><span>保存 session</span><kbd>Ctrl+S</kbd>
    </div></section></div>}
    {/(未保存|已恢复|找不到|无法)/.test(status) && <div className="status-toast" role="status">{status}</div>}
  </div>;
}
