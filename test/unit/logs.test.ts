import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripAnsi, summarizeLog } from '../../src/rojo/logs.ts';

test('a busy port gives Rojo own explanation', () => {
  const output = [
    '[ERROR rojo] Could not start the Rojo server on 127.0.0.1:34890.',
    '        The address may already be in use or reserved. Another Rojo server might already be running, or another program may be using that port.',
    '        You can pick a different port with the --port option.',
    '        ',
    '        Caused by:',
    '            0: error creating server listener: (os error 10048)',
  ].join('\r\n');

  assert.equal(
    summarizeLog(output),
    'Could not start the Rojo server on 127.0.0.1:34890. The address may already be in use or reserved. Another Rojo server might already be running, or another program may be using that port. You can pick a different port with the --port option.',
  );
});

test('a tool manager error is found too', () => {
  assert.equal(
    summarizeLog('Rokit 1.0.0\nERROR No tool was found for rojo in any manifest\n'),
    'ERROR No tool was found for rojo in any manifest',
  );
});

test('without an error line, the last lines are used', () => {
  assert.equal(summarizeLog('one\ntwo\nthree\nfour\n'), 'two three four');
  assert.equal(summarizeLog(''), '');
});

test('colors are removed and long text is cut', () => {
  assert.equal(stripAnsi('\u001b[0m\u001b[1m\u001b[32mlocalhost\u001b[0m'), 'localhost');

  const summary = summarizeLog(`error: ${'x'.repeat(1000)}`);
  assert.equal(summary.length, 400);
  assert.ok(summary.endsWith('…'));
});
