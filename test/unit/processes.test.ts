import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRojoProcessName, parseLsof, parseNetstat, parseTasklist } from '../../src/rojo/processes.ts';

test('reads every listener of the TCP ports from netstat', () => {
  const output = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1260',
    '  TCP    127.0.0.1:34872        0.0.0.0:0              LISTENING       67312',
    '  TCP    127.0.0.1:34872        127.0.0.1:50211        ESTABLISHED     67312',
    '  TCP    127.0.0.1:50211        127.0.0.1:34872        ESTABLISHED     4120',
    '  TCP    127.0.0.1:34874        0.0.0.0:0              NASŁUCHIWANIE   5488',
    '  TCP    0.0.0.0:34874          0.0.0.0:0              LISTENING       7777',
    '  TCP    [::]:34875             [::]:0                 LISTENING       9228',
    '  TCP    [::1]:34876            [::]:0                 LISTENING       88656',
    '  UDP    0.0.0.0:5353           *:*                                    2044',
    '',
  ].join('\r\n');

  assert.deepEqual(
    [...parseNetstat(output)],
    [
      [135, [1260]],
      [34872, [67312]],
      [34874, [5488, 7777]],
      [34875, [9228]],
      [34876, [88656]],
    ],
  );
});

test('reads every listener of the TCP ports from lsof', () => {
  const output = [
    'p501',
    'f12',
    'n127.0.0.1:34872',
    'p777',
    'f9',
    'n*:34880',
    'n[::1]:34880',
    'p778',
    'n*:34880',
    '',
  ].join('\n');

  assert.deepEqual(
    [...parseLsof(output)],
    [
      [34872, [501]],
      [34880, [777, 778]],
    ],
  );
});

test('reads the image name from tasklist', () => {
  assert.equal(parseTasklist('"rojo.exe","3140","Console","1","16 736 K"\r\n'), 'rojo.exe');
  assert.equal(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n'), undefined);
});

test('recognizes Rojo processes by name', () => {
  assert.equal(isRojoProcessName('rojo.exe'), true);
  assert.equal(isRojoProcessName('ROJO.EXE'), true);
  assert.equal(isRojoProcessName('/Users/me/.rokit/tool-storage/rojo-rbx/rojo/7.7.1/rojo'), true);
  assert.equal(isRojoProcessName('C:\\Users\\me\\.aftman\\bin\\rojo.exe'), true);
  assert.equal(isRojoProcessName('rojo-helper.exe'), false);
  assert.equal(isRojoProcessName('notepad.exe'), false);
  assert.equal(isRojoProcessName(undefined), false);
});
