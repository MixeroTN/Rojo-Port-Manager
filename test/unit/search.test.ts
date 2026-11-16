import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findProjectFile, type SearchFailure, type SearchOptions } from '../../src/model/search.ts';

function busy(root: string): Error {
  return new Error(`EBUSY: resource busy or locked, scandir '${root}'`);
}

/** Options with a fake listing per root; each value is the files, or an error to throw, for one read after another. */
function fake(listings: Record<string, (string[] | Error)[]>, extra: Partial<SearchOptions> = {}) {
  const reads: string[] = [];
  const retries: { attempt: number; failures: readonly SearchFailure[]; delayMs: number }[] = [];
  const options: SearchOptions = {
    readDir: (root) => {
      reads.push(root);
      const queue = listings[root] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];

      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
    },
    attempts: 10,
    timeoutMs: 1000,
    delayMs: () => 0,
    onRetry: (attempt, failures, delayMs) => retries.push({ attempt, failures, delayMs }),
    ...extra,
  };

  return { options, reads, retries };
}

test('finds a project file at a root, default.project.json before the other names', async () => {
  const { options, reads } = fake({
    '/a': [['README.md', 'place.project.json', 'Default.project.json']],
    '/b': [['other.project.json']],
  });

  assert.deepEqual(await findProjectFile(['/a', '/b'], options), {
    kind: 'found',
    root: '/a',
    file: 'Default.project.json',
    attempt: 1,
  });
  assert.deepEqual(reads, ['/a', '/b']);
});

test('nothing to find when every folder reads without a project file', async () => {
  const { options, reads, retries } = fake({
    '/a': [['project.json', '.project.json', 'game.project.json.bak']],
    '/b': [[]],
  });

  assert.deepEqual(await findProjectFile(['/a', '/b'], options), { kind: 'none' });
  assert.deepEqual(reads, ['/a', '/b']);
  assert.equal(retries.length, 0);
  assert.deepEqual(await findProjectFile([], options), { kind: 'none' });
});

test('reads a folder again until it can be read, and only that folder', async () => {
  const { options, reads, retries } = fake(
    { '/a': [busy('/a'), busy('/a'), ['game.project.json']], '/b': [['notes.txt']] },
    { delayMs: (attempt) => attempt * 10 },
  );

  assert.deepEqual(await findProjectFile(['/a', '/b'], options), {
    kind: 'found',
    root: '/a',
    file: 'game.project.json',
    attempt: 3,
  });
  assert.deepEqual(reads, ['/a', '/b', '/a', '/a']);
  assert.deepEqual(
    retries.map((retry) => [retry.attempt, retry.delayMs, retry.failures.map((failure) => failure.root)]),
    [
      [1, 20, ['/a']],
      [2, 30, ['/a']],
    ],
  );
  assert.match(retries[0]?.failures[0]?.reason ?? '', /EBUSY/);
});

test('a project file in another folder needs no second try', async () => {
  const { options, retries } = fake({ '/a': [busy('/a')], '/b': [['game.project.json']] });

  assert.deepEqual(await findProjectFile(['/a', '/b'], options), {
    kind: 'found',
    root: '/b',
    file: 'game.project.json',
    attempt: 1,
  });
  assert.equal(retries.length, 0);
});

test('gives up after the last try and says why', async () => {
  const { options, reads, retries } = fake({ '/a': [busy('/a')], '/b': [[]] }, { attempts: 3 });
  const result = await findProjectFile(['/a', '/b'], options);

  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' && result.attempts, 3);
  assert.deepEqual(result.kind === 'failed' && result.failures.map((failure) => failure.root), ['/a']);
  assert.deepEqual(reads, ['/a', '/b', '/a', '/a']);
  // Told before each try that follows, not after the last one.
  assert.deepEqual(
    retries.map((retry) => retry.attempt),
    [1, 2],
  );
});

test('a read that throws at once counts as a failed try', async () => {
  let calls = 0;
  const { options } = fake(
    {},
    {
      readDir: () => {
        calls += 1;
        if (calls === 1) {
          throw busy('/a');
        }

        return Promise.resolve(['game.project.json']);
      },
    },
  );

  assert.deepEqual(await findProjectFile(['/a'], options), {
    kind: 'found',
    root: '/a',
    file: 'game.project.json',
    attempt: 2,
  });
});

/** A read that answers only when `release` is called; `calls` counts how often it was started. */
function slowRead() {
  let resolveAnswer: (files: string[]) => void = () => undefined;
  const answer = new Promise<string[]>((resolve) => {
    resolveAnswer = resolve;
  });
  const state = { calls: 0, release: (files: string[]) => resolveAnswer(files) };
  const readDir = () => {
    state.calls += 1;

    return answer;
  };

  return { state, readDir };
}

test('a read without an answer in time fails its try, and the next try takes its late answer', async () => {
  const { state, readDir } = slowRead();
  const { options, retries } = fake(
    {},
    {
      readDir,
      timeoutMs: 20,
      // The read answers between the tries, before the second one starts.
      onRetry: (attempt, failures, delayMs) => {
        retries.push({ attempt, failures, delayMs });
        state.release(['slow.project.json']);
      },
    },
  );

  assert.deepEqual(await findProjectFile(['/a'], options), {
    kind: 'found',
    root: '/a',
    file: 'slow.project.json',
    attempt: 2,
  });
  assert.equal(state.calls, 1);
  assert.match(retries[0]?.failures[0]?.reason ?? '', /no answer within 0\.02 seconds/);
});

test('a read without an answer in time fails its try, and the next try waits for the read still going', async () => {
  const { state, readDir } = slowRead();
  const { options, retries } = fake(
    {},
    {
      readDir,
      timeoutMs: 200,
      // The read answers during the second try, while that try waits for it: no second read may start.
      onRetry: (attempt, failures, delayMs) => {
        retries.push({ attempt, failures, delayMs });
        setTimeout(() => state.release(['slow.project.json']), 30);
      },
    },
  );

  assert.deepEqual(await findProjectFile(['/a'], options), {
    kind: 'found',
    root: '/a',
    file: 'slow.project.json',
    attempt: 2,
  });
  assert.equal(state.calls, 1);
  assert.match(retries[0]?.failures[0]?.reason ?? '', /no answer within 0\.2 seconds/);
});

test('stops when cancelled: before the first try, as a wait begins, during a wait, and during a read', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const before = fake({ '/a': [['game.project.json']] }, { signal: aborted.signal });

  assert.deepEqual(await findProjectFile(['/a'], before.options), { kind: 'cancelled' });
  assert.deepEqual(before.reads, []);

  const beginning = new AbortController();
  const atWait = fake(
    { '/a': [busy('/a')] },
    { signal: beginning.signal, delayMs: () => 2000, onRetry: () => beginning.abort() },
  );
  let started = performance.now();

  assert.deepEqual(await findProjectFile(['/a'], atWait.options), { kind: 'cancelled' });
  assert.deepEqual(atWait.reads, ['/a']);
  assert.ok(performance.now() - started < 1000);

  // The abort comes once the wait has started its timer, so the wait's own listener must end it.
  const midway = new AbortController();
  const inWait = fake(
    { '/a': [busy('/a')] },
    {
      signal: midway.signal,
      delayMs: () => 2000,
      onRetry: () => {
        setTimeout(() => midway.abort(), 10);
      },
    },
  );
  started = performance.now();

  assert.deepEqual(await findProjectFile(['/a'], inWait.options), { kind: 'cancelled' });
  assert.deepEqual(inWait.reads, ['/a']);
  assert.ok(performance.now() - started < 1000);

  const reading = new AbortController();
  const hanging = fake(
    {},
    { signal: reading.signal, timeoutMs: 2000, readDir: () => new Promise<string[]>(() => undefined) },
  );
  started = performance.now();
  const result = findProjectFile(['/a'], hanging.options);
  setTimeout(() => reading.abort(), 10);

  assert.deepEqual(await result, { kind: 'cancelled' });
  assert.ok(performance.now() - started < 1000);
});
