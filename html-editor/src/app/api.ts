import type { BootstrapData, EditorCommand, PageDefinition } from "./types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok || value?.error) throw new Error(value.error || `HTTP ${response.status}`);
  return value as T;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  command: (command: EditorCommand) => request<BootstrapData>("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  }),
  history: (action: "undo" | "redo") => request<BootstrapData>("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  }),
  pages: (pages: PageDefinition[]) => request<BootstrapData>("/api/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pages }),
  }),
  saveUi: (ui: Record<string, unknown>) => request<{ ok: boolean }>("/api/ui", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ui }),
  }),
};
