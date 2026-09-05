export type EditorMode = "preview" | "edit";

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
  confidence: "high" | "medium";
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

export interface BootstrapData {
  sessionId: string;
  sourcePath: string;
  sourceName: string;
  platform: "web" | "mobile";
  pages: PageDefinition[];
  surfaces: SurfaceDefinition[];
  cursor: number;
  commandCount: number;
  rejectedCommandCount?: number;
  canUndo: boolean;
  canRedo: boolean;
  ui: Record<string, unknown>;
  status?: "active" | "applied" | "conflict";
  outputPath?: string;
  lastError?: string;
  history?: { action: "undo" | "redo"; command: EditorCommand };
  patches?: EditorPatch[];
}

export interface TreeNode {
  id: string;
  type: "group" | "page" | "container" | "element";
  label: string;
  detail: string;
  element?: Element;
  overlayRoot?: HTMLElement;
  overlayOpener?: HTMLElement;
  overlayOpenFunction?: string;
  overlayOpenArgs?: unknown[];
  target?: ElementTarget;
  pageId: string;
  children: TreeNode[];
}

export interface SelectionSnapshot {
  elements: HTMLElement[];
  target: ElementTarget | null;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  parentDisplay: string;
  locked: boolean;
  treePath?: string[];
  options?: Array<{ text: string; value: string; selected: boolean }>;
  listItems?: string[];
  inputType?: string;
  checked?: boolean;
  textEditable?: boolean;
  textScope?: "element" | "range";
  selectedText?: string;
  rangeFontSize?: number;
  textFormat?: {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
  };
}
