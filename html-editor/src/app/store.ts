import { create } from "zustand";
import type { BootstrapData, EditorMode, SelectionSnapshot, TreeNode } from "./types";

interface EditorState {
  bootstrap: BootstrapData | null;
  mode: EditorMode;
  tree: TreeNode[];
  selection: SelectionSnapshot | null;
  currentPageId: string;
  status: string;
  setBootstrap: (bootstrap: BootstrapData) => void;
  setMode: (mode: EditorMode) => void;
  setTree: (tree: TreeNode[]) => void;
  setSelection: (selection: SelectionSnapshot | null) => void;
  setCurrentPageId: (pageId: string) => void;
  setStatus: (status: string) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  bootstrap: null,
  mode: "preview",
  tree: [],
  selection: null,
  currentPageId: "",
  status: "正在加载",
  setBootstrap: (bootstrap) => set({ bootstrap }),
  setMode: (mode) => set({ mode }),
  setTree: (tree) => set({ tree }),
  setSelection: (selection) => set({ selection }),
  setCurrentPageId: (currentPageId) => set({ currentPageId }),
  setStatus: (status) => set({ status }),
}));
