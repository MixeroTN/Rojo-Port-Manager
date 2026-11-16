import { compareProjectFiles, isProjectFileName } from './projectFile.ts';

/**
 * How the roots of the workspace folders are searched for a Rojo project file. VS Code finds `default.project.json`
 * itself (an exact name is a plain check), but a pattern like `*.project.json` goes through its file search, which
 * gives up after 7 seconds on a busy machine: other names are searched here, with more tries.
 */
export interface SearchOptions {
  /** Lists the files (not the folders) at the root of a folder. */
  readDir: (root: string) => Promise<string[]>;
  /** How many tries at most; a try reads again every folder that could not be read. */
  attempts: number;
  /** How long one read may take: a slower one counts as failed, and the next try waits for it again. */
  timeoutMs: number;
  /** The wait before try `attempt` (2 and later). */
  delayMs: (attempt: number) => number;
  /** Ends the search early: its result is then `cancelled`. */
  signal?: AbortSignal;
  /** Told about a failed try that another try follows, and how long that one waits. */
  onRetry?: (attempt: number, failures: readonly SearchFailure[], delayMs: number) => void;
}

export interface SearchFailure {
  root: string;
  reason: string;
}

export type SearchResult =
  /** A project file at the root of `root`; `default.project.json` comes before the other names. */
  | { kind: 'found'; root: string; file: string; attempt: number }
  /** Every folder was read, and none has a project file at its root. */
  | { kind: 'none' }
  /** Some folders could not be read in any try, and the others have no project file. */
  | { kind: 'failed'; failures: SearchFailure[]; attempts: number }
  | { kind: 'cancelled' };

/** A read's answer; `late` when there was none in time (or the search ended): the read itself may still answer. */
type ReadOutcome = { ok: true; files: string[] } | { ok: false; reason: string; late?: boolean };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Waits `ms`; false at once when the signal aborts. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);

      return;
    }

    const finish = (elapsed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(elapsed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The outcome of a read; a failure when it takes longer than `ms` or the signal aborts first. */
function inTime(outcome: Promise<ReadOutcome>, ms: number, signal: AbortSignal | undefined): Promise<ReadOutcome> {
  return new Promise((resolve) => {
    const finish = (result: ReadOutcome) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, reason: 'cancelled', late: true });
    const timer = setTimeout(
      () => finish({ ok: false, reason: `no answer within ${ms / 1000} seconds`, late: true }),
      ms,
    );

    signal?.addEventListener('abort', onAbort, { once: true });
    void outcome.then(finish);
  });
}

/**
 * Looks for a project file at the roots of the folders. A folder that cannot be read gets another try, up to
 * `attempts` tries in all: after an error it is read again, and a read without an answer in time is waited for again.
 * A project file in any folder ends the search with the try that found it.
 */
export async function findProjectFile(roots: readonly string[], options: SearchOptions): Promise<SearchResult> {
  const { signal } = options;
  const attempts = Math.max(1, Math.floor(options.attempts));
  // A read that outlasts its try goes on: the next try waits for that read (or takes its late answer) instead of
  // starting another one, so a folder that hangs never has more than one read going.
  const running = new Map<string, Promise<ReadOutcome>>();

  const readInTime = async (root: string): Promise<ReadOutcome> => {
    let read = running.get(root);

    if (!read) {
      read = Promise.resolve()
        .then(() => options.readDir(root))
        .then(
          (files): ReadOutcome => ({ ok: true, files }),
          (error: unknown): ReadOutcome => ({ ok: false, reason: errorText(error) }),
        );
      running.set(root, read);
    }

    const outcome = await inTime(read, options.timeoutMs, signal);
    if (outcome.ok || !outcome.late) {
      running.delete(root);
    }

    return outcome;
  };

  let pending = [...roots];
  let failures: SearchFailure[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) {
      return { kind: 'cancelled' };
    }

    const outcomes = await Promise.all(pending.map(readInTime));

    if (signal?.aborted) {
      return { kind: 'cancelled' };
    }

    failures = [];
    for (const [index, outcome] of outcomes.entries()) {
      const root = pending[index] ?? '';

      if (outcome.ok) {
        const [file] = outcome.files.filter(isProjectFileName).sort(compareProjectFiles);

        if (file !== undefined) {
          return { kind: 'found', root, file, attempt };
        }
      } else {
        failures.push({ root, reason: outcome.reason });
      }
    }

    if (failures.length === 0) {
      return { kind: 'none' };
    }

    if (attempt < attempts) {
      const delay = options.delayMs(attempt + 1);

      options.onRetry?.(attempt, failures, delay);
      if (!(await wait(delay, signal))) {
        return { kind: 'cancelled' };
      }
    }

    pending = failures.map((failure) => failure.root);
  }

  return { kind: 'failed', failures, attempts };
}
