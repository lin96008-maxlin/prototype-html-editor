import { useEffect, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Bold,
  ImagePlus,
  Italic,
  Strikethrough,
  Underline,
} from "lucide-react";
import type { FrameController } from "./frame-lite";
import type { SelectionSnapshot } from "./types";

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
  if (selection.textEditable && selection.text.trim()) return selection.text.slice(0, 30);
  const names: Record<string, string> = {
    section: "内容区", article: "内容区", header: "页头", footer: "页尾", nav: "导航", aside: "侧栏", div: "容器",
    form: "表单", fieldset: "表单分组", ul: "列表", ol: "有序列表", li: "列表项", table: "表格", th: "表头单元格", td: "表格单元格",
    button: "按钮", a: "链接", input: "输入框", textarea: "多行输入框", select: "下拉框", label: "字段名称", img: "图片",
  };
  return names[selection.tagName] || "页面内容";
}

function TextField({ label, value, multiline, onCommit }: { label: string; value: string; multiline?: boolean; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => { if (draft !== value) onCommit(draft); };
  return <label className={`lite-field${multiline ? " multiline" : ""}`}><span>{label}</span>{multiline
    ? <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} />
    : <input value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />}</label>;
}

function NumberField({ label, value, min = -10000, onCommit }: { label: string; value: number; min?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = Math.max(min, parsed);
    if (next !== value) onCommit(next);
  };
  return <label className="lite-number"><span>{label}</span><input type="number" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

function ColorField({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  const current = colorToHex(value);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  return <label className="lite-color"><span>{label}</span><div><input type="color" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== current) onCommit(draft); }} /><input value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== current) onCommit(draft); }} /></div></label>;
}

function OptionEditor({ value, onApply }: { value: Array<{ text: string; value: string; selected: boolean }>; onApply: (value: Array<{ text: string; value: string; selected: boolean }>) => void }) {
  const [text, setText] = useState(value.map((item) => item.text).join("\n"));
  const [selected, setSelected] = useState(Math.max(0, value.findIndex((item) => item.selected)));
  useEffect(() => {
    setText(value.map((item) => item.text).join("\n"));
    setSelected(Math.max(0, value.findIndex((item) => item.selected)));
  }, [JSON.stringify(value)]);
  const labels = text.split("\n").map((item) => item.trim()).filter(Boolean);
  return <section className="lite-section"><h3>下拉选项</h3><label className="lite-field multiline"><span>选项</span><textarea value={text} onChange={(event) => setText(event.target.value)} /></label><label className="lite-field"><span>默认显示</span><select value={Math.min(selected, Math.max(0, labels.length - 1))} onChange={(event) => setSelected(Number(event.target.value))}>{labels.map((item, index) => <option key={`${item}-${index}`} value={index}>{item}</option>)}</select></label><button className="lite-apply" type="button" onClick={() => onApply(labels.map((label, index) => ({ text: label, value: value[index]?.value || label, selected: index === selected })))}>应用</button></section>;
}

function ListEditor({ value, onApply }: { value: string[]; onApply: (value: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => setText(value.join("\n")), [value.join("\n")]);
  return <section className="lite-section"><h3>列表内容</h3><label className="lite-field multiline"><span>项目</span><textarea value={text} onChange={(event) => setText(event.target.value)} /></label><button className="lite-apply" type="button" onClick={() => onApply(text.split("\n"))}>应用</button></section>;
}

function AlignButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return <button className="lite-icon-button" type="button" title={title} aria-label={title} onClick={onClick}>{children}</button>;
}

function FormatButton({ title, active, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`lite-icon-button${active ? " active" : ""}`} type="button" title={title} aria-label={title} aria-pressed={Boolean(active)} onClick={onClick}>{children}</button>;
}

const COMMON_COLORS = [
  ["黑色", "#111827"], ["深灰", "#475467"], ["灰色", "#98a2b3"], ["白色", "#ffffff"],
  ["红色", "#d92d20"], ["橙色", "#f79009"], ["黄色", "#facc15"], ["绿色", "#12b76a"],
  ["蓝色", "#2563eb"], ["紫色", "#7f56d9"],
] as const;

export function ProductInspectorLite({ selection, controller }: { selection: SelectionSnapshot | null; controller: FrameController | null }) {
  if (!selection || !controller) return <div className="lite-empty">未选择内容</div>;
  const multiple = selection.elements.length > 1;
  const tag = selection.tagName;
  const style = (name: string): string => selection.styles[name] || "";
  const attr = (name: string): string => selection.attributes[name] || "";
  const movable = !["th", "td", "li"].includes(tag);
  const textTools = !["img", "video", "audio", "iframe", "canvas", "svg", "input", "textarea", "select", "table"].includes(tag);
  const textFormat = selection.textFormat || { bold: false, italic: false, underline: false, strike: false };
  const textColor = colorToHex(style("color"));
  const fileImage = (file: File | undefined): void => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => controller.applyAttribute("src", String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  return <div className="lite-inspector">
    <div className="lite-selection"><strong>{multiple ? `已选择 ${selection.elements.length} 项` : selection.textScope === "range" ? `已选文字：${selection.selectedText || ""}` : selectionName(selection)}</strong></div>
    <div className="lite-scroll">
      {multiple ? <section className="lite-section"><h3>对齐</h3><div className="lite-align">
        <AlignButton title="左对齐" onClick={() => controller.align("left")}><AlignStartVertical size={16} /></AlignButton>
        <AlignButton title="水平居中" onClick={() => controller.align("center")}><AlignCenterVertical size={16} /></AlignButton>
        <AlignButton title="右对齐" onClick={() => controller.align("right")}><AlignEndVertical size={16} /></AlignButton>
        <AlignButton title="顶部对齐" onClick={() => controller.align("top")}><AlignStartHorizontal size={16} /></AlignButton>
        <AlignButton title="垂直居中" onClick={() => controller.align("middle")}><AlignCenterHorizontal size={16} /></AlignButton>
        <AlignButton title="底部对齐" onClick={() => controller.align("bottom")}><AlignEndHorizontal size={16} /></AlignButton>
      </div></section> : <>
        {textTools && <section className="lite-section"><div className="lite-section-title"><h3>文字</h3><span>{selection.textScope === "range" ? "已选文字" : (["section", "article", "div", "form", "fieldset"].includes(tag) ? "整个容器" : "整个元素")}</span></div><div className="lite-format-toolbar">
          <FormatButton title="加粗" active={textFormat.bold} onClick={() => controller.applyTextFormat("bold")}><Bold size={16} /></FormatButton>
          <FormatButton title="斜体" active={textFormat.italic} onClick={() => controller.applyTextFormat("italic")}><Italic size={16} /></FormatButton>
          <FormatButton title="下划线" active={textFormat.underline} onClick={() => controller.applyTextFormat("underline")}><Underline size={16} /></FormatButton>
          <FormatButton title="删除线" active={textFormat.strike} onClick={() => controller.applyTextFormat("strike")}><Strikethrough size={16} /></FormatButton>
          <span className="lite-toolbar-divider" />
          <FormatButton title="左对齐" active={style("text-align") === "left"} onClick={() => controller.applyTextAlign("left")}><AlignLeft size={16} /></FormatButton>
          <FormatButton title="居中" active={style("text-align") === "center"} onClick={() => controller.applyTextAlign("center")}><AlignCenter size={16} /></FormatButton>
          <FormatButton title="右对齐" active={style("text-align") === "right"} onClick={() => controller.applyTextAlign("right")}><AlignRight size={16} /></FormatButton>
        </div><NumberField label="字号" value={selection.textScope === "range" ? (selection.rangeFontSize || parseNumber(style("font-size"), 14)) : parseNumber(style("font-size"), 14)} min={8} onCommit={(value) => controller.applyTextFontSize(value)} /><div className="lite-color-palette" aria-label="常用文字颜色">{COMMON_COLORS.map(([name, color]) => <button key={color} type="button" title={name} aria-label={name} aria-pressed={textColor === color} className={textColor === color ? "active" : ""} style={{ backgroundColor: color }} onClick={() => controller.applyTextFormat("color", color)} />)}</div><ColorField label="自定义" value={style("color")} onCommit={(value) => controller.applyTextFormat("color", value)} /></section>}
        {tag === "img" && <section className="lite-section"><h3>图片</h3><label className="lite-file"><ImagePlus size={16} />从电脑选择<input type="file" accept="image/*" onChange={(event) => fileImage(event.target.files?.[0])} /></label><TextField label="图片说明" value={attr("alt")} onCommit={(value) => controller.applyAttribute("alt", value)} /></section>}
        {tag === "a" && <section className="lite-section"><h3>链接</h3><TextField label="跳转地址" value={attr("href")} onCommit={(value) => controller.applyAttribute("href", value)} /></section>}
        {["input", "textarea"].includes(tag) && <section className="lite-section"><h3>输入框</h3><TextField label="提示文字" value={attr("placeholder")} onCommit={(value) => controller.applyAttribute("placeholder", value)} /><TextField label="默认内容" value={attr("value")} onCommit={(value) => controller.applyAttribute("value", value)} /></section>}
        {tag === "select" && <OptionEditor value={selection.options || []} onApply={(items) => controller.applySelectOptions(items)} />}
        {["ul", "ol"].includes(tag) && <ListEditor value={selection.listItems || []} onApply={(items) => controller.applyListItems(items)} />}
        {tag === "table" && <section className="lite-section"><h3>表格</h3><div className="lite-note">请直接选择需要修改的单元格。</div></section>}
        {movable && <section className="lite-section"><h3>位置与大小</h3><div className="lite-grid four"><NumberField label="向右" value={parseNumber(style("left"))} onCommit={(value) => controller.setPosition("x", value)} /><NumberField label="向下" value={parseNumber(style("top"))} onCommit={(value) => controller.setPosition("y", value)} /><NumberField label="宽度" value={parseNumber(style("width"))} min={1} onCommit={(value) => controller.applyStyle("width", `${value}px`)} /><NumberField label="高度" value={parseNumber(style("height"))} min={1} onCommit={(value) => controller.applyStyle("height", `${value}px`)} /></div></section>}
      </>}
    </div>
  </div>;
}
