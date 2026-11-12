import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeMsgpack, MsgpackError } from '../../src/rojo/msgpack.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

test('decodes the server info of Rojo 7.7', () => {
  const value = decodeMsgpack(fixture('api-rojo-7.7.1.bin')) as Record<string, unknown>;

  assert.equal(value.serverVersion, '7.7.1');
  assert.equal(value.protocolVersion, 5);
  assert.equal(value.projectName, 'Fixture Game');
  // Rojo keeps the ids in a set: their order changes from one start to the next.
  assert.deepEqual(
    [...(value.expectedPlaceIds as number[])].sort((left, right) => left - right),
    [1818, 4567890123456],
  );
  assert.equal(value.gameId, null);
  assert.match(String(value.sessionId), /^[0-9a-f-]{36}$/);
});

test('decodes the basic types', () => {
  // prettier-ignore
  const bytes = Uint8Array.from([
    0x8b, // map of 11
    0xa1, 0x61, 0x05, // "a": 5
    0xa1, 0x62, 0xff, // "b": -1
    0xa1, 0x63, 0xcd, 0x01, 0x00, // "c": 256
    0xa1, 0x64, 0xc0, // "d": nil
    0xa1, 0x65, 0xc3, // "e": true
    0xa1, 0x66, 0xc2, // "f": false
    0xa1, 0x67, 0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0, // "g": 1.5
    0xa1, 0x68, 0x92, 0x01, 0xa2, 0x68, 0x69, // "h": [1, "hi"]
    0xa1, 0x69, 0xc4, 0x02, 0x0a, 0x0b, // "i": bin [10, 11]
    0xa1, 0x6a, 0xd0, 0x80, // "j": int8 -128
    0xa1, 0x6b, 0xd4, 0x01, 0x07, // "k": fixext 1, type 1
  ]);

  assert.deepEqual(decodeMsgpack(bytes), {
    a: 5,
    b: -1,
    c: 256,
    d: null,
    e: true,
    f: false,
    g: 1.5,
    h: [1, 'hi'],
    i: Uint8Array.from([10, 11]),
    j: -128,
    k: { type: 1, data: Uint8Array.from([7]) },
  });
});

test('keeps integers beyond the safe range as bigint', () => {
  const bytes = Uint8Array.from([0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

  assert.equal(decodeMsgpack(bytes), 18446744073709551615n);
});

test('reads 16-bit lengths of strings, arrays and maps', () => {
  const text = 'x'.repeat(300);
  const bytes = Uint8Array.from([0xde, 0x00, 0x01, 0xa1, 0x6b, 0xda, 0x01, 0x2c, ...Buffer.from(text)]);

  assert.deepEqual(decodeMsgpack(bytes), { k: text });
});

test('a "__proto__" key does not change the prototype', () => {
  const key = Buffer.from('__proto__');
  const value = decodeMsgpack(Uint8Array.from([0x81, 0xa0 | key.length, ...key, 0x01])) as Record<string, unknown>;

  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(value, '__proto__')?.value, 1);
});

test('rejects broken data', () => {
  assert.throws(() => decodeMsgpack(Uint8Array.from([0xa5, 0x61])), MsgpackError, 'truncated string');
  assert.throws(() => decodeMsgpack(Uint8Array.from([0x01, 0x02])), MsgpackError, 'bytes after the value');
  assert.throws(() => decodeMsgpack(Uint8Array.from([0xc1])), MsgpackError, 'never used type');
  assert.throws(() => decodeMsgpack(Uint8Array.from([0xdd, 0xff, 0xff, 0xff, 0xff])), MsgpackError, 'huge count');
  assert.throws(() => decodeMsgpack(new Uint8Array(0)), MsgpackError, 'empty');
  assert.throws(() => decodeMsgpack(new Uint8Array(100).fill(0x91)), MsgpackError, 'nested too deeply');
});
