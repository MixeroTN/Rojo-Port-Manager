import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { emptyState, parseState, serializeState, type SharedState } from './state.ts';

/**
 * The shared state file. Every window reads it before it uses it, and writes it whole through a temporary file and a
 * rename, so a reader never sees half a file.
 */
export class StateStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): SharedState {
    try {
      return parseState(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return emptyState();
    }
  }

  /** Applies a change to the current state and writes it; returns the new state. */
  update(change: (state: SharedState) => void): SharedState {
    const state = this.read();
    change(state);

    fs.mkdirSync(nodePath.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, serializeState(state));
    renameWithRetry(temporary, this.file);

    return state;
  }
}

/** On Windows a rename can fail for a moment while another program (a virus scanner) has the file open. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);

      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw error;
      }

      // A short synchronous wait: the state is written rarely, and only after a user action or a refresh.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}
