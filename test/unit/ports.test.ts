import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_RANGE,
  formatRange,
  MAX_RANGE_SIZE,
  parsePortInput,
  parseRange,
  pickPort,
  portsToProbe,
} from '../../src/model/ports.ts';

test('reads the port range setting', () => {
  assert.deepEqual(parseRange('34872-34899'), { first: 34872, last: 34899 });
  assert.deepEqual(parseRange(' 40000 - 40010 '), { first: 40000, last: 40010 });
  assert.deepEqual(parseRange('40000'), { first: 40000, last: 40000 });
  assert.deepEqual(parseRange('40000-30000'), DEFAULT_RANGE, 'backwards');
  assert.deepEqual(parseRange('0-10'), DEFAULT_RANGE, 'port 0');
  assert.deepEqual(parseRange('70000'), DEFAULT_RANGE, 'too high');
  assert.deepEqual(parseRange('abc'), DEFAULT_RANGE);
  assert.deepEqual(parseRange(42), DEFAULT_RANGE);
  assert.equal(parseRange('10000-60000').last, 10000 + MAX_RANGE_SIZE - 1, 'capped');
  assert.equal(formatRange({ first: 1, last: 1 }), '1');
  assert.equal(formatRange({ first: 1, last: 2 }), '1-2');
});

test('reads a typed port', () => {
  assert.equal(parsePortInput(' 34874 '), 34874);
  assert.equal(parsePortInput('1024'), 1024);
  assert.equal(parsePortInput('1023'), undefined);
  assert.equal(parsePortInput('65536'), undefined);
  assert.equal(parsePortInput('34 874'), undefined);
  assert.equal(parsePortInput('-1'), undefined);
  assert.equal(parsePortInput(''), undefined);
});

test('picks the lowest free port and leaves Rojo default port alone', () => {
  assert.equal(pickPort(DEFAULT_RANGE, new Set()), 34873);
  assert.equal(pickPort(DEFAULT_RANGE, new Set([34873, 34874])), 34875);
  assert.equal(pickPort({ first: 34872, last: 34872 }, new Set()), undefined);
  assert.equal(pickPort({ first: 40000, last: 40001 }, new Set([40000, 40001])), undefined);
});

test('probes the range and the extra ports once each, in order', () => {
  assert.deepEqual(portsToProbe({ first: 10, last: 12 }, [11, 50, 0, 70000, 50]), [10, 11, 12, 50]);
});
