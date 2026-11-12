import * as vscode from 'vscode';
import type { ViewNode } from './model.ts';

/** Escapes text for Markdown, so that names and paths show as they are and long lines still wrap. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, (char) => `\\${char}`);
}

/** The Rojo panel's data provider: the nodes come ready from `views/model.ts`. */
export class RojoTreeProvider implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private roots: ViewNode[] = [];
  private readonly emitter = new vscode.EventEmitter<ViewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** The current roots; the smoke test reads them. */
  get nodes(): readonly ViewNode[] {
    return this.roots;
  }

  setRoots(roots: ViewNode[]): void {
    this.roots = roots;
    this.emitter.fire(undefined);
  }

  getChildren(node?: ViewNode): ViewNode[] {
    return node ? node.children : this.roots;
  }

  getTreeItem(node: ViewNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.collapsible === 'none' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded,
    );

    item.id = node.id;
    item.description = node.description;
    item.contextValue = node.contextValue;

    if (node.tooltip.length > 0) {
      item.tooltip = new vscode.MarkdownString(node.tooltip.map(escapeMarkdown).join('\n\n'));
    }

    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(
        node.icon.id,
        node.icon.color ? new vscode.ThemeColor(node.icon.color) : undefined,
      );
    }

    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
