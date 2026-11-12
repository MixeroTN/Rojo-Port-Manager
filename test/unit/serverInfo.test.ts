import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseServerInfo, readId } from '../../src/rojo/serverInfo.ts';

function answer(version: string) {
  const read = (extension: string) =>
    readFileSync(new URL(`../fixtures/api-rojo-${version}.${extension}`, import.meta.url));

  return { body: read('bin'), type: read('type').toString('utf8') };
}

for (const version of ['7.7.1', '7.5.1', '7.2.1']) {
  test(`reads the answer of Rojo ${version}`, () => {
    const { body, type } = answer(version);
    const info = parseServerInfo(body, type);

    assert.ok(info);
    assert.equal(info.projectName, 'Fixture Game');
    assert.equal(info.serverVersion, version);
    assert.deepEqual([...info.expectedPlaceIds].sort(), ['1818', '4567890123456']);
    assert.equal(info.gameId, undefined);
    assert.equal(info.placeId, undefined);
    assert.match(info.sessionId, /^[0-9a-f-]{36}$/);
  });
}

test('tells JSON from MessagePack without a content type', () => {
  assert.equal(parseServerInfo(answer('7.2.1').body, undefined)?.serverVersion, '7.2.1');
  assert.equal(parseServerInfo(answer('7.7.1').body, undefined)?.serverVersion, '7.7.1');
});

test('anything else on the port is not a Rojo server', () => {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));

  assert.equal(parseServerInfo(json({ hello: 'world' }), 'application/json'), undefined);
  assert.equal(parseServerInfo(json({ projectName: 'X' }), 'application/json'), undefined, 'no session');
  assert.equal(parseServerInfo(json([1, 2]), 'application/json'), undefined);
  assert.equal(parseServerInfo(Buffer.from('<html></html>'), 'text/html'), undefined);
  assert.equal(parseServerInfo(Buffer.from([0xc1]), 'application/msgpack'), undefined);
});

test('reads Roblox ids', () => {
  assert.equal(readId(1818), '1818');
  assert.equal(readId(18446744073709551615n), '18446744073709551615');
  assert.equal(readId('123'), '123');
  assert.equal(readId(-1), undefined);
  assert.equal(readId(1.5), undefined);
  assert.equal(readId('12a'), undefined);
  assert.equal(readId(null), undefined);
});
