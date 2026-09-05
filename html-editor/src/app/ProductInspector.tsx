import { useEffect, useMemo, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowUp,
  Box,
  ImagePlus,
  Layers,
  ListPlus,
  Lock,
  Minus,
  Move,
  Palette,
  Plus,
  Table2,
  Trash2,
  Type,
  Unlock,
} from "lucide-react";
import type { FrameController } from "./frame";
import type { SelectionSnapshot } from "./types";

type InspectorTab = "content" | "layout" | "appearance";

function parseNumber(value: string, fallback = 0): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : fallback;
}

function colorToHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return "#000000";
  return `#${[match[1], match[2], match[3]].map((item) => Number(item).toString(16).padStart(2, "0")).join("")}`;
}

function selectionName(selection: SelectionSnapshot): string {
  if (selection.textEditable && selection.text.trim()) return selection.text.slice(0, 28);
  const names: Record<string, string> = {
    main: "页面内容", section: "内容区", article: "内容区", header: "页头", footer: "页尾", nav: "导航", aside: "侧栏", div: "容器",
    form: "表单", fieldset: "表单分组", ul: "列表", ol: "有序列表", li: "列表项", table: "表格", thead: "表头", tbody: "表格内容",
    tfoot: "表尾", tr: "表格行", th: "表头单元格", td: "单元格", button: "按钮", a: "链接", input: "输入框", textarea: "多行输入框",
    select: "下拉框", label: "字段名称", img: "图片", video: "视频", audio: "音频", iframe: "嵌入页面", canvas: "画布", svg: "图形",
  };
  return names[selection.tagName] || "页面元素";
}

function ToolButton({ title, active, disabled, onClick, children }: { title: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`inspector-tool${active ? " active" : ""}`} type="button" title={title} aria-label={title} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

function TextField({ label, value, multiline, onCommit }: { label: string; value: string; multiline?: boolean; onCommit: (value: string) => void }) {
  return <label className={`friendly-field${multiline ? " multiline" : ""}`}><span>{label}</span>{multiline
    ? <textarea key={`${label}-${value}`} defaultValue={value} onBlur={(event) => { if (event.target.value !== value) onCommit(event.target.value); }} />
    : <input key={`${label}-${value}`} defaultValue={value} onBlur={(event) => { if (event.target.value !== value) onCommit(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />}</label>;
}

function NumberField({ label, value, min, max, onCommit }: { label: string; value: number; min?: number; max?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (nextValue: number): void => {
    const next = Math.max(min ?? -100000, Math.min(max ?? 100000, nextValue));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <label className="number-field"><span>{label}</span><div><button type="button" aria-label={`${label}减一`} onClick={() => commit(Number(draft || value) - 1)}><Minus size={12} /></button><input type="number" value={draft} min={min} max={max} onChange={(event) => setDraft(event.target.value)} onBlur={() => commit(Number(draft || value))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><button type="button" aria-label={`${label}加一`} onClick={() => commit(Number(draft || value) + 1)}><Plus size={12} /></button></div></label>;
}

function OpacityField({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label className="range-field"><span>透明度</span><input type="range" min="0" max="100" value={draft} onChange={(event) => setDraft(Number(event.target.value))} onPointerUp={() => { if (draft !== value) onCommit(draft); }} onKeyUp={() => { if (draft !== value) onCommit(draft); }} /><strong>{draft}%</strong></label>;
}

function ColorField({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  const color = colorToHex(value);
  return <label className="color-field"><span>{label}</span><div><input type="color" value={color} onChange={(event) => onCommit(event.target.value)} /><input key={`${label}-${value}`} defaultValue={value} onBlur={(event) => onCommit(event.target.value)} /></div></label>;
}

function OptionEditor({ value, onApply }: { value: Array<{ text: string; value: string; selected: boolean }>; onApply: (value: Array<{ text: string; value: string; selected: boolean }>) => void }) {
  const [items, setItems] = useState(value);
  useEffect(() => setItems(value), [JSON.stringify(value)]);
  const update = (index: number, patch: Partial<(typeof items)[number]>): void => setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const move = (index: number, offset: number): void => setItems((current) => {
    const next = [...current];
    const target = index + offset;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  return <div className="data-editor"><div className="data-editor-head"><span>下拉选项</span><button type="button" onClick={() => setItems((current) => [...current, { text: "新增选项", value: `option-${current.length + 1}`, selected: false }])}><Plus size={13} />新增</button></div>
    {items.map((item, index) => <div className="option-row" key={`${index}-${item.value}`}>
      <input className="option-default" type="radio" name="default-option" aria-label="设为默认选项" checked={item.selected} onChange={() => setItems((current) => current.map((entry, entryIndex) => ({ ...entry, selected: entryIndex === index })))} />
      <input aria-label="选项名称" value={item.text} onChange={(event) => update(index, { text: event.target.value })} />
      <input aria-label="选项值" value={item.value} onChange={(event) => update(index, { value: event.target.value })} />
      <button type="button" aria-label="上移选项" onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
      <button type="button" aria-label="下移选项" onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
      <button type="button" aria-label="删除选项" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={12} /></button>
    </div>)}
    <button className="apply-data" type="button" onClick={() => onApply(items)}>应用选项修改</button>
  </div>;
}

function ListEditor({ value, onApply }: { value: string[]; onApply: (value: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => setText(value.join("\n")), [value.join("\n")]);
  return <div className="data-editor"><div className="data-editor-head"><span>列表内容</span><small>每行一项</small></div><textarea value={text} onChange={(event) => setText(event.target.value)} /><button className="apply-data" type="button" onClick={() => onApply(text.split("\n"))}>应用列表修改</button></div>;
}

export function ProductInspector({ selection, controller }: { selection: SelectionSnapshot | null; controller: FrameController | null }) {
  const [tab, setTab] = useState<InspectorTab>("content");
  const selectionKey = selection?.target?.existingId || selection?.target?.heId || selection?.tagName || "none";
  useEffect(() => setTab("content"), [selectionKey]);
  const displayPreset = useMemo(() => {
    const display = selection?.styles.display || "block";
    if (display.includes("grid")) return "grid";
    if (display.includes("flex")) return selection?.styles["flex-direction"].startsWith("column") ? "vertical" : "horizontal";
    return "normal";
  }, [selection]);

  if (!selection || !controller) return <div className="empty-panel"><Move size={24} /><span>在页面中选择内容</span></div>;
  const multiple = selection.elements.length > 1;
  const style = (name: string): string => selection.styles[name] || "";
  const attr = (name: string): string => selection.attributes[name] || "";
  const tag = selection.tagName;
  const supportsText = Boolean(selection.textEditable);
  const fileImage = (file: File | undefined): void => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => controller.applyAttribute("src", String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  return <div className="product-inspector" key={selectionKey}>
    <div className="selection-summary"><div><strong>{multiple ? `已选择 ${selection.elements.length} 项` : selectionName(selection)}</strong><span>{multiple ? "可整体移动、对齐或调整外观" : "再次点击可选择内部内容"}</span></div><ToolButton title={selection.locked ? "解除锁定" : "锁定位置"} active={selection.locked} onClick={() => controller.toggleLocked()}>{selection.locked ? <Lock size={15} /> : <Unlock size={15} />}</ToolButton></div>
    <div className="inspector-tabs" role="tablist">
      <button className={tab === "content" ? "active" : ""} type="button" onClick={() => setTab("content")}><Type size={14} />内容</button>
      <button className={tab === "layout" ? "active" : ""} type="button" onClick={() => setTab("layout")}><Move size={14} />排列</button>
      <button className={tab === "appearance" ? "active" : ""} type="button" onClick={() => setTab("appearance")}><Palette size={14} />外观</button>
    </div>

    <div className="inspector-friendly-scroll">
      {tab === "content" && <>
        {multiple && <div className="friendly-empty">多选状态下请使用“排列”或“外观”。</div>}
        {!multiple && supportsText && <TextField label="显示文字" value={selection.text} multiline onCommit={(value) => controller.applyText(value)} />}
        {!multiple && tag === "img" && <section className="friendly-group"><h3>图片</h3><label className="file-replace"><ImagePlus size={16} /><span>从电脑替换图片</span><input type="file" accept="image/*" onChange={(event) => fileImage(event.target.files?.[0])} /></label><TextField label="图片说明" value={attr("alt")} onCommit={(value) => controller.applyAttribute("alt", value)} /><TextField label="图片地址" value={attr("src")} onCommit={(value) => controller.applyAttribute("src", value)} /></section>}
        {!multiple && tag === "a" && <section className="friendly-group"><h3>链接</h3><TextField label="跳转地址" value={attr("href")} onCommit={(value) => controller.applyAttribute("href", value)} /><label className="friendly-switch"><span>在新窗口打开</span><input type="checkbox" checked={attr("target") === "_blank"} onChange={(event) => controller.applyAttribute("target", event.target.checked ? "_blank" : "")} /></label></section>}
        {!multiple && ["input", "textarea"].includes(tag) && <section className="friendly-group"><h3>输入内容</h3>{tag === "input" && <label className="friendly-field"><span>输入类型</span><select value={selection.inputType || "text"} onChange={(event) => controller.applyAttribute("type", event.target.value)}><option value="text">普通文字</option><option value="number">数字</option><option value="date">日期</option><option value="password">密码</option><option value="checkbox">复选框</option><option value="radio">单选框</option></select></label>}<TextField label="提示文字" value={attr("placeholder")} onCommit={(value) => controller.applyAttribute("placeholder", value)} /><TextField label="默认内容" value={attr("value")} onCommit={(value) => controller.applyAttribute("value", value)} />{["checkbox", "radio"].includes(selection.inputType || "") && <label className="friendly-switch"><span>默认选中</span><input type="checkbox" checked={Boolean(selection.checked)} onChange={(event) => controller.applyBooleanAttribute("checked", event.target.checked)} /></label>}<label className="friendly-switch"><span>不可填写</span><input type="checkbox" checked={selection.attributes.disabled !== undefined} onChange={(event) => controller.applyBooleanAttribute("disabled", event.target.checked)} /></label></section>}
        {!multiple && tag === "select" && <OptionEditor value={selection.options || []} onApply={(items) => controller.applySelectOptions(items)} />}
        {!multiple && ["ul", "ol"].includes(tag) && <ListEditor value={selection.listItems || []} onApply={(items) => controller.applyListItems(items)} />}
        {!multiple && (["table", "td", "th", "tr"].includes(tag) || selection.elements[0].closest("table")) && <section className="friendly-group"><h3><Table2 size={14} />表格</h3><div className="friendly-action-grid"><button type="button" onClick={() => controller.tableAction("add-row")}>新增行</button><button type="button" onClick={() => controller.tableAction("remove-row")}>删除行</button><button type="button" onClick={() => controller.tableAction("add-column")}>新增列</button><button type="button" onClick={() => controller.tableAction("remove-column")}>删除列</button></div></section>}
      </>}

      {tab === "layout" && <>
        {multiple && <section className="friendly-group"><h3>对齐</h3><div className="align-tools">
          <ToolButton title="左对齐" onClick={() => controller.align("left")}><AlignStartVertical size={16} /></ToolButton><ToolButton title="水平居中" onClick={() => controller.align("center")}><AlignCenterVertical size={16} /></ToolButton><ToolButton title="右对齐" onClick={() => controller.align("right")}><AlignEndVertical size={16} /></ToolButton><ToolButton title="顶部对齐" onClick={() => controller.align("top")}><AlignStartHorizontal size={16} /></ToolButton><ToolButton title="垂直居中" onClick={() => controller.align("middle")}><AlignCenterHorizontal size={16} /></ToolButton><ToolButton title="底部对齐" onClick={() => controller.align("bottom")}><AlignEndHorizontal size={16} /></ToolButton><ToolButton title="水平等距" disabled={selection.elements.length < 3} onClick={() => controller.distribute("horizontal")}><AlignHorizontalDistributeCenter size={16} /></ToolButton><ToolButton title="垂直等距" disabled={selection.elements.length < 3} onClick={() => controller.distribute("vertical")}><AlignVerticalDistributeCenter size={16} /></ToolButton>
        </div></section>}
        <section className="friendly-group"><h3>位置与大小</h3><div className="four-number-grid">
          <NumberField label="X" value={parseNumber(style("left"))} onCommit={(value) => controller.setPosition("x", value)} />
          <NumberField label="Y" value={parseNumber(style("top"))} onCommit={(value) => controller.setPosition("y", value)} />
          <NumberField label="宽" value={parseNumber(style("width"))} min={1} onCommit={(value) => controller.applyStyle("width", `${value}px`)} />
          <NumberField label="高" value={parseNumber(style("height"))} min={1} onCommit={(value) => controller.applyStyle("height", `${value}px`)} />
        </div><label className="friendly-switch"><span>自由移动</span><input type="checkbox" checked={controller.isFreePosition()} onChange={(event) => controller.setFreePosition(event.target.checked)} /></label></section>
        {!multiple && <section className="friendly-group"><h3>内部排列</h3><div className="layout-presets"><button className={displayPreset === "normal" ? "active" : ""} type="button" onClick={() => controller.applyLayoutPreset("normal")}><Box size={15} />普通</button><button className={displayPreset === "horizontal" ? "active" : ""} type="button" onClick={() => controller.applyLayoutPreset("horizontal")}><Move size={15} />横向</button><button className={displayPreset === "vertical" ? "active" : ""} type="button" onClick={() => controller.applyLayoutPreset("vertical")}><ListPlus size={15} />纵向</button><button className={displayPreset === "grid" ? "active" : ""} type="button" onClick={() => controller.applyLayoutPreset("grid")}><Table2 size={15} />网格</button></div><div className="three-number-grid"><NumberField label="内部留白" value={parseNumber(style("padding"))} min={0} onCommit={(value) => controller.applyStyle("padding", `${value}px`)} /><NumberField label="外部间距" value={parseNumber(style("margin"))} onCommit={(value) => controller.applyStyle("margin", `${value}px`)} /><NumberField label="项目间距" value={parseNumber(style("gap"))} min={0} onCommit={(value) => controller.applyStyle("gap", `${value}px`)} /></div></section>}
        <section className="friendly-group"><h3><Layers size={14} />前后层级</h3><div className="friendly-action-grid"><button type="button" onClick={() => controller.moveLayer("front")}>移到最前</button><button type="button" onClick={() => controller.moveLayer("forward")}>向前一层</button><button type="button" onClick={() => controller.moveLayer("backward")}>向后一层</button><button type="button" onClick={() => controller.moveLayer("back")}>移到最后</button></div></section>
      </>}

      {tab === "appearance" && <>
        <section className="friendly-group"><h3>文字外观</h3><div className="two-column-fields"><NumberField label="字号" value={parseNumber(style("font-size"), 14)} min={8} max={120} onCommit={(value) => controller.applyStyle("font-size", `${value}px`)} /><label className="friendly-field"><span>粗细</span><select value={style("font-weight")} onChange={(event) => controller.applyStyle("font-weight", event.target.value)}><option value="400">正常</option><option value="500">稍粗</option><option value="600">加粗</option><option value="700">很粗</option></select></label></div><ColorField label="文字颜色" value={style("color")} onCommit={(value) => controller.applyStyle("color", value)} /><label className="friendly-field"><span>文字对齐</span><select value={style("text-align")} onChange={(event) => controller.applyStyle("text-align", event.target.value)}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select></label></section>
        <section className="friendly-group"><h3>区域外观</h3><ColorField label="背景颜色" value={style("background-color")} onCommit={(value) => controller.applyStyle("background-color", value)} /><ColorField label="边框颜色" value={style("border-color")} onCommit={(value) => controller.applyStyle("border-color", value)} /><div className="two-column-fields"><NumberField label="边框粗细" value={parseNumber(style("border-width"))} min={0} max={20} onCommit={(value) => controller.applyStyle("border-width", `${value}px`)} /><NumberField label="圆角" value={parseNumber(style("border-radius"))} min={0} max={100} onCommit={(value) => controller.applyStyle("border-radius", `${value}px`)} /></div><label className="friendly-field"><span>阴影</span><select value={style("box-shadow") === "none" ? "none" : style("box-shadow")} onChange={(event) => controller.applyStyle("box-shadow", event.target.value)}><option value="none">无</option><option value="0 2px 8px rgba(0,0,0,.12)">轻微</option><option value="0 8px 24px rgba(0,0,0,.16)">明显</option></select></label><OpacityField value={Math.round(parseNumber(style("opacity"), 1) * 100)} onCommit={(value) => controller.applyStyle("opacity", String(value / 100))} /></section>
      </>}
    </div>
  </div>;
}
