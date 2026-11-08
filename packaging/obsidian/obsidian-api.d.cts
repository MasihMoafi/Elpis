export interface WorkspaceLeaf {
  setViewState(state: { type: string; active: boolean }): Promise<void>;
}

export interface ViewElement {
  empty(): void;
  addClass(name: string): void;
  createDiv(options: { cls: string }): ViewElement;
  createEl(tag: 'iframe', options: { cls: string; attr: Record<string, string> }): HTMLIFrameElement;
  createEl(tag: 'h3' | 'p', options: { text: string }): HTMLElement;
  createEl(tag: 'button', options: { text: string }): HTMLButtonElement;
}

export class ItemView {
  constructor(leaf: WorkspaceLeaf);
  containerEl: { children: { readonly 1: ViewElement } };
}

export class Plugin {
  app: {
    workspace: {
      getLeavesOfType(type: string): WorkspaceLeaf[];
      getLeaf(kind: 'tab'): WorkspaceLeaf;
      revealLeaf(leaf: WorkspaceLeaf): void;
    };
  };
  registerView(type: string, createView: (leaf: WorkspaceLeaf) => ItemView): void;
  addRibbonIcon(icon: string, title: string, callback: () => void): void;
  addCommand(command: { id: string; name: string; callback: () => void }): void;
}

export class Notice {
  constructor(message: string);
}

export function addIcon(name: string, svg: string): void;
