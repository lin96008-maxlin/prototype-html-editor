import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  FileCode2,
  Files,
  FolderTree,
  Keyboard,
  ListTree,
  Maximize2,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Redo2,
  Search,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { api } from "./api";
import { FrameController } from "./frame-lite";
import { ProductInspectorLite } from "./ProductInspectorLite";
import { useEditorStore } from "./store";
import type { EditorMode, TreeNode } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function IconButton({ title, disabled, active, onClick, children }: { title: string; disabled?: boolean; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`icon-button${active ? " active" : ""}`} type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick}>{children}</button>;
}

function ViewportInput({ label, title, value, min, max, onCommit }: { label: string; title: string; value: number; min: number; max: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clamp(parsed, min, max);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <label className="viewport-input" title={title}><span>{label}</span><input type="number" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function TreeItem({ node, depth, search, selectedTreeId, expanded, onToggle, onSelect }: {
  node: TreeNode;
  depth: number;
  search: string;
  selectedTreeId: string;
  expanded: Set<string>;
  onToggle: (node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
}) {
  const hasChildren = node.children.length > 0;
  const canExpand = hasChildren || node.type === "page";
  const isExpanded = expanded.has(node.id) || Boolean(search);
  const ownMatch = !search || `${node.label} ${node.detail}`.toLowerCase().includes(search);
  const matchesBranch = (item: TreeNode): boolean => `${item.label} ${item.detail}`.toLowerCase().includes(search) || item.children.some(matchesBranch);
  const childMatch = node.children.some(matchesBranch);
  if (!ownMatch && !childMatch && search) return null;
  const isSelected = node.id === selectedTreeId;
  const Icon = node.type === "group" ? FolderTree : node.type === "page" ? FileCode2 : node.type === "container" ? Box : MousePointer2;
  return <div className="tree-branch">
    <div data-tree-id={node.id} className={`tree-row${isSelected ? " selected" : ""}${node.type === "page" ? " page" : ""}${node.type === "group" ? " group" : ""}`} style={{ paddingLeft: `${8 + depth * 14}px` }}>
      <button className="tree-toggle" type="button" aria-label={isExpanded ? "收起" : "展开"} aria-expanded={canExpand ? isExpanded : undefined} onClick={() => canExpand && onToggle(node)} disabled={!canExpand}>{canExpand ? (isExpanded && hasChildren ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span />}</button>
      <button className="tree-label" type="button" title={node.label} onClick={() => onSelect(node)}><Icon size={14} aria-hidden="true" /><span>{node.label}</span>{node.detail !== node.label && <small>{node.detail}</small>}</button>
    </div>
    {hasChildren && isExpanded && <div>{node.children.map((child) => <TreeItem key={child.id} node={child} depth={depth + 1} search={search} selectedTreeId={selectedTreeId} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />)}</div>}
  </div>;
}

export function AppLite() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const controllerRef = useRef<FrameController | null>(null);
  const treePageRef = useRef("");
  const [revision, setRevision] = useState(0);
  const [frameRequestMode, setFrameRequestMode] = useState<EditorMode>("preview");
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(320);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [treeSearch, setTreeSearch] = useState("");
  const [treeMode, setTreeMode] = useState<"full" | "pages">("full");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [viewportHeight, setViewportHeight] = useState(900);
  const [zoom, setZoom] = useState(0.7);

  const bootstrap = useEditorStore((state) => state.bootstrap);
  const mode = useEditorStore((state) => state.mode);
  const tree = useEditorStore((state) => state.tree);
  const selection = useEditorStore((state) => state.selection);
  const currentPageId = useEditorStore((state) => state.currentPageId);
  const status = useEditorStore((state) => state.status);
  const setBootstrap = useEditorStore((state) => state.setBootstrap);
  const setModeStore = useEditorStore((state) => state.setMode);
  const setTree = useEditorStore((state) => state.setTree);
  const setSelection = useEditorStore((state) => state.setSelection);
  const setCurrentPageId = useEditorStore((state) => state.setCurrentPageId);
  const setStatus = useEditorStore((state) => state.setStatus);

  useEffect(() => {
    void api.bootstrap().then((value) => {
      setBootstrap(value);
      const firstPage = value.pages[0]?.id || "page:main";
      setCurrentPageId(firstPage);
      setExpanded(new Set([firstPage]));
      setViewportWidth(Number(value.ui.viewportWidth) || (value.platform === "mobile" ? 414 : 1440));
      setViewportHeight(Number(value.ui.viewportHeight) || (value.platform === "mobile" ? 844 : 900));
      setZoom(Number(value.ui.zoom) || (value.platform === "mobile" ? 0.8 : 0.7));
      setLeftWidth(Number(value.ui.leftWidth) || 280);
      setRightWidth(Number(value.ui.rightWidth) || 320);
      setLeftCollapsed(Boolean(value.ui.leftCollapsed));
      setRightCollapsed(Boolean(value.ui.rightCollapsed));
      setTreeMode(value.ui.treeMode === "pages" ? "pages" : "full");
      setStatus("已就绪");
    }).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
    return () => controllerRef.current?.destroy();
  }, [setBootstrap, setCurrentPageId, setStatus]);

  const saveUi = useCallback(() => {
    void api.saveUi({ leftWidth, rightWidth, leftCollapsed, rightCollapsed, viewportWidth, viewportHeight, zoom, treeMode });
    setStatus("工作台状态已保存");
  }, [leftCollapsed, leftWidth, rightCollapsed, rightWidth, setStatus, treeMode, viewportHeight, viewportWidth, zoom]);

  useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setTimeout(saveUi, 300);
    return () => window.clearTimeout(timer);
  }, [bootstrap, saveUi]);

  const switchMode = useCallback((nextMode?: EditorMode) => {
    const next = nextMode || (useEditorStore.getState().mode === "edit" ? "preview" : "edit");
    setModeStore(next);
    controllerRef.current?.setMode(next);
    setContextMenu(null);
    setStatus(next === "edit" ? "编辑模式" : "预览模式");
  }, [setModeStore, setStatus]);

  const history = useCallback(async (action: "undo" | "redo") => {
    try {
      const value = await api.history(action);
      setBootstrap(value);
      controllerRef.current?.applyHistory(value.history, value.patches || []);
      setStatus(action === "undo" ? "已撤销" : "已重做");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [setBootstrap, setStatus]);

  const onFrameLoad = useCallback(() => {
    const iframe = iframeRef.current;
    const value = useEditorStore.getState().bootstrap;
    if (!iframe || !value) return;
    controllerRef.current?.destroy();
    const controller = new FrameController(iframe, value.pages, value.surfaces || [], {
      onCommand: async (command) => {
        const next = await api.command(command);
        setBootstrap(next);
        return next.patches || [];
      },
      onCommandRejected: () => { setFrameRequestMode(useEditorStore.getState().mode); setRevision((current) => current + 1); },
      onTree: (nextTree, pageId) => {
        const groupIds = nextTree.filter((node) => node.type === "group" && node.children.some((page) => page.pageId === pageId)).map((node) => node.id);
        setTree(nextTree);
        setCurrentPageId(pageId);
        if (treePageRef.current !== pageId) setExpanded(new Set([...groupIds, pageId]));
        else setExpanded((current) => new Set([...current, ...groupIds, pageId]));
        treePageRef.current = pageId;
      },
      onSelection: setSelection,
      onContextMenu: setContextMenu,
      onModeToggle: () => switchMode(),
      onHistory: history,
      onSave: saveUi,
      onZoomWheel: (deltaY) => setZoom((value) => clamp(value + (deltaY < 0 ? 0.05 : -0.05), 0.2, 2)),
      onZoomCommand: (action) => {
        if (action === "in") setZoom((value) => clamp(value + 0.05, 0.2, 2));
        else if (action === "out") setZoom((value) => clamp(value - 0.05, 0.2, 2));
        else {
          const stage = stageRef.current;
          if (stage) setZoom(clamp(Math.min((stage.clientWidth - 48) / viewportWidth, (stage.clientHeight - 48) / viewportHeight), 0.2, 1));
        }
      },
      onStatus: setStatus,
    });
    controllerRef.current = controller;
    const pageId = useEditorStore.getState().currentPageId;
    controller.attach(useEditorStore.getState().mode);
    if (pageId && pageId !== value.pages[0]?.id) window.setTimeout(() => controller.openPage(pageId), 50);
  }, [history, saveUi, setBootstrap, setCurrentPageId, setSelection, setStatus, setTree, switchMode, viewportHeight, viewportWidth]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!bootstrap || controllerRef.current || !iframe?.contentDocument || iframe.contentDocument.readyState !== "complete") return;
    const timer = window.setTimeout(onFrameLoad, 0);
    return () => window.clearTimeout(timer);
  }, [bootstrap, onFrameLoad]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    setZoom(clamp(Math.min((stage.clientWidth - 48) / viewportWidth, (stage.clientHeight - 48) / viewportHeight), 0.2, 1));
  }, [viewportHeight, viewportWidth]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      controllerRef.current?.handleShortcut(event);
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const listener = (event: WheelEvent): void => {
      if (useEditorStore.getState().mode !== "edit" || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      setZoom((value) => clamp(value + (event.deltaY < 0 ? 0.05 : -0.05), 0.2, 2));
    };
    stage.addEventListener("wheel", listener, { passive: false });
    return () => stage.removeEventListener("wheel", listener);
  }, []);

  useEffect(() => {
    const path = selection?.treePath || [];
    if (!path.length) return;
    const group = bootstrap?.pages.find((page) => page.id === currentPageId)?.group;
    const groupIds = group ? [`group:${group}`] : [];
    const branch = path[path.length - 1]?.includes(":surface:") ? path : path.slice(0, -1);
    setExpanded(new Set([...groupIds, currentPageId, ...branch]));
    const timer = window.setTimeout(() => document.querySelector(`[data-tree-id="${CSS.escape(path[path.length - 1])}"]`)?.scrollIntoView({ block: "nearest" }), 40);
    return () => window.clearTimeout(timer);
  }, [bootstrap?.pages, currentPageId, selection?.treePath?.join("|")]);

  const beginResize = (side: "left" | "right", event: React.PointerEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    const move = (pointer: PointerEvent) => {
      const delta = pointer.clientX - startX;
      if (side === "left") setLeftWidth(clamp(startWidth + delta, 220, 440));
      else setRightWidth(clamp(startWidth - delta, 260, 420));
    };
    const finishResize = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finishResize);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finishResize);
  };

  const displayTree = useMemo(() => treeMode === "full" ? tree : tree.map((node) => node.type === "group"
    ? { ...node, children: node.children.map((page) => ({ ...page, children: [] })) }
    : { ...node, children: [] }), [tree, treeMode]);
  const selectedTreeId = treeMode === "pages" ? currentPageId : selection?.treePath?.[selection.treePath.length - 1] || "";
  const fullPreview = mode === "preview" && bootstrap?.platform !== "mobile";
  const gridStyle = useMemo(() => mode === "preview" ? { gridTemplateColumns: "minmax(0,1fr)" } : {
    gridTemplateColumns: `${leftCollapsed ? 36 : leftWidth}px 6px minmax(440px,1fr) 6px ${rightCollapsed ? 36 : rightWidth}px`,
  }, [leftCollapsed, leftWidth, mode, rightCollapsed, rightWidth]);
  const viewportStyle = fullPreview ? { width: "100%", height: "100%" } : { width: viewportWidth * zoom, height: viewportHeight * zoom };
  const iframeStyle = fullPreview ? { width: "100%", height: "100%", transform: "none" } : { width: viewportWidth, height: viewportHeight, transform: `scale(${zoom})` };
  const onStageMouseDown = (event: React.MouseEvent<HTMLElement>): void => {
    if (event.target === event.currentTarget) controllerRef.current?.handleBlankInteraction();
  };
  const onPanelMouseDown = (event: React.MouseEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea,select,label,a,[contenteditable='true'],.tree-row,.lite-section")) return;
    controllerRef.current?.handleBlankInteraction();
  };
  const runHistory = (action: "undo" | "redo"): void => {
    if (controllerRef.current) controllerRef.current.requestHistory(action);
    else void history(action);
  };
  const contextActions = controllerRef.current && selection ? [
    ...(selection.textEditable ? [["编辑文字", Type, () => controllerRef.current?.editSelectedText()] as const] : []),
    ["复制", Copy, () => controllerRef.current?.copy()] as const,
    ["粘贴", ClipboardPaste, () => controllerRef.current?.paste()] as const,
    ["重复", CopyPlus, () => controllerRef.current?.duplicate()] as const,
    ["选择父容器", Box, () => controllerRef.current?.selectParent()] as const,
    ["删除", Trash2, () => controllerRef.current?.deleteSelected()] as const,
  ] : [];

  return <div className={`app mode-${mode}`} data-html-editor-status={bootstrap ? "ready" : "loading"} onClick={() => setContextMenu(null)}>
    <header className="topbar">
      <div className="file-title"><FileCode2 size={17} /><strong>{bootstrap?.sourceName || "HTML 原型编辑器"}</strong><span>{bootstrap?.platform === "mobile" ? "移动端" : "Web"}</span></div>
      <div className="mode-switch" role="group" aria-label="工作台模式"><button className={mode === "preview" ? "active" : ""} type="button" onClick={() => switchMode("preview")}><Eye size={14} />预览</button><button className={mode === "edit" ? "active" : ""} type="button" onClick={() => switchMode("edit")}><Pencil size={14} />编辑</button></div>
      <div className="top-tools"><IconButton title="撤销" disabled={!bootstrap?.canUndo} onClick={() => runHistory("undo")}><Undo2 size={16} /></IconButton><IconButton title="重做" disabled={!bootstrap?.canRedo} onClick={() => runHistory("redo")}><Redo2 size={16} /></IconButton><IconButton title="查看快捷键" onClick={() => setShortcutsOpen(true)}><Keyboard size={16} /></IconButton>{mode === "edit" && <><span className="tool-divider" /><ViewportInput label="宽" title="画布宽度" value={viewportWidth} min={240} max={3840} onCommit={setViewportWidth} /><ViewportInput label="高" title="画布高度" value={viewportHeight} min={320} max={2160} onCommit={setViewportHeight} /><IconButton title="适应窗口" onClick={fit}><Maximize2 size={16} /></IconButton><label className="zoom-control" title="缩放"><input type="range" min="20" max="200" value={Math.round(zoom * 100)} onChange={(event) => setZoom(Number(event.target.value) / 100)} /><span>{Math.round(zoom * 100)}%</span></label></>}</div>
      <div className="save-state" title={`当前已记录 ${bootstrap?.cursor || 0} 项修改`}><span className="status-dot" />{status}</div>
    </header>

    <main className="workspace" style={gridStyle}>
      {mode === "edit" && <><aside className={`side-panel left-panel${leftCollapsed ? " collapsed" : ""}`} onMouseDown={onPanelMouseDown}>{leftCollapsed ? <IconButton title="展开页面栏" onClick={() => setLeftCollapsed(false)}><PanelLeftOpen size={17} /></IconButton> : <><div className="panel-heading"><strong>页面</strong><IconButton title="收起页面栏" onClick={() => setLeftCollapsed(true)}><PanelLeftClose size={16} /></IconButton></div><div className="tree-filter-row"><label className="tree-search"><Search size={14} /><input type="search" placeholder={treeMode === "pages" ? "搜索页面" : "搜索页面或内容"} value={treeSearch} onChange={(event) => setTreeSearch(event.target.value.toLowerCase())} /></label><IconButton title="显示完整目录" active={treeMode === "full"} onClick={() => setTreeMode("full")}><ListTree size={15} /></IconButton><IconButton title="仅显示页面" active={treeMode === "pages"} onClick={() => setTreeMode("pages")}><Files size={15} /></IconButton></div><div className="tree-list">{displayTree.map((node) => <TreeItem key={node.id} node={node} depth={0} search={treeSearch} selectedTreeId={selectedTreeId} expanded={expanded} onToggle={(item) => {
        if (item.type === "page" && item.pageId !== currentPageId) { setExpanded((current) => new Set([...current, item.id])); controllerRef.current?.selectTreeNode(item); return; }
        setExpanded((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; });
      }} onSelect={(item) => {
        if (item.type === "group") {
          setExpanded((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; });
          return;
        }
        if (item.type === "page") setExpanded((current) => new Set([...current, item.id]));
        controllerRef.current?.selectTreeNode(item);
      }} />)}</div></>}</aside><div className="splitter" role="separator" aria-label="调整页面栏宽度" onPointerDown={(event) => beginResize("left", event)} /></>}

      <section className="stage" ref={stageRef} onMouseDown={onStageMouseDown}><div className={`viewport-shell${fullPreview ? " full-preview" : ""}`} style={viewportStyle}><iframe ref={iframeRef} title="原型预览" src={`/preview?rev=${revision}&mode=${frameRequestMode}`} onLoad={onFrameLoad} style={iframeStyle} /></div></section>

      {mode === "edit" && <><div className="splitter" role="separator" aria-label="调整设置栏宽度" onPointerDown={(event) => beginResize("right", event)} /><aside className={`side-panel right-panel${rightCollapsed ? " collapsed" : ""}`} onMouseDown={onPanelMouseDown}>{rightCollapsed ? <IconButton title="展开设置栏" onClick={() => setRightCollapsed(false)}><PanelRightOpen size={17} /></IconButton> : <><div className="panel-heading"><strong>设置</strong><IconButton title="收起设置栏" onClick={() => setRightCollapsed(true)}><PanelRightClose size={16} /></IconButton></div><ProductInspectorLite selection={selection} controller={controllerRef.current} /></>}</aside></>}
    </main>

    {contextMenu && <div className="context-menu" style={{ left: Math.min(contextMenu.x, window.innerWidth - 170), top: Math.min(contextMenu.y, window.innerHeight - 220) }} onClick={(event) => event.stopPropagation()}>{contextActions.map(([label, Icon, action]) => <button key={label} type="button" className={label === "删除" ? "danger" : ""} onClick={() => { action(); setContextMenu(null); }}><Icon size={15} />{label}</button>)}</div>}
    {shortcutsOpen && <div className="modal-backdrop" role="presentation" onClick={() => setShortcutsOpen(false)}><section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title" onClick={(event) => event.stopPropagation()}><header><strong id="shortcut-title">快捷键</strong><IconButton title="关闭" onClick={() => setShortcutsOpen(false)}><X size={16} /></IconButton></header><div className="shortcut-list"><span>撤销 / 重做</span><kbd>Ctrl+Z / Ctrl+Y</kbd><span>复制 / 剪切 / 粘贴</span><kbd>Ctrl+C / X / V</kbd><span>重复</span><kbd>Ctrl+D</kbd><span>多选</span><kbd>Ctrl+点击</kbd><span>锁定方向移动</span><kbd>Shift+拖动</kbd><span>微调 / 快速微调</span><kbd>方向键 / Shift+方向键</kbd><span>编辑文字</span><kbd>Enter</kbd><span>删除 / 取消</span><kbd>Delete / Esc</kbd><span>切换预览与编辑</span><kbd>Ctrl+E</kbd><span>缩放 / 适应窗口</span><kbd>Ctrl+滚轮 / Ctrl+0</kbd></div></section></div>}
    {/(未保存|找不到|无法|失败)/.test(status) && <div className="status-toast" role="alert">{status}</div>}
  </div>;
}
