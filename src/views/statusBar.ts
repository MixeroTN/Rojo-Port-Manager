import * as vscode from 'vscode';
import type { Overview } from '../model/overview.ts';
import { projectLabel } from '../model/projectFile.ts';
import { stateText } from './model.ts';

/** The status bar item: the port of this window's project, or how many of its projects are served. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('rojoPorts.status', vscode.StatusBarAlignment.Left, 40);

  constructor() {
    this.item.name = 'Rojo Port Manager';
    this.item.command = 'rojoPorts.pick';
  }

  update(overview: Overview, enabled: boolean): void {
    const { projects } = overview;

    if (!enabled || projects.length === 0) {
      this.item.hide();

      return;
    }

    const running = projects.filter((status) => status.state.kind === 'running' && !status.busy).length;
    const busy = projects.some((status) => status.busy !== undefined);
    const icon = busy ? '$(loading~spin)' : running > 0 ? '$(radio-tower)' : '$(debug-disconnect)';
    const [only] = projects;

    if (projects.length === 1 && only) {
      this.item.text = only.port === undefined ? `${icon} Rojo` : `${icon} Rojo :${only.port}`;
    } else {
      this.item.text = `${icon} Rojo ${running}/${projects.length}`;
    }

    const lines = projects.map((status) => {
      const port = status.port === undefined ? '' : ` :${status.port}`;

      return `${projectLabel(status.project.file)}${port}: ${stateText(status)}`;
    });

    this.item.tooltip = ['Rojo servers of this window', ...lines, '', 'Click to start or stop a server.'].join('\n');
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
