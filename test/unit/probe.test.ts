import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { probePort, probePorts } from '../../src/rojo/probe.ts';

const msgpack = readFileSync(new URL('../fixtures/api-rojo-7.7.1.bin', import.meta.url));

/** Starts a local server on a free port, runs the test, and closes it with its connections. */
async function withServer(server: net.Server, run: (port: number) => Promise<void>): Promise<void> {
  const sockets = new Set<net.Socket>();

  server.on('connection', (socket: net.Socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function httpServer(handler: http.RequestListener): http.Server {
  return http.createServer(handler);
}

test('a Rojo server answers with its info', async () => {
  const server = httpServer((request, response) => {
    assert.equal(request.url, '/api/rojo');
    response.writeHead(200, { 'content-type': 'application/msgpack' });
    response.end(msgpack);
  });

  await withServer(server, async (port) => {
    const result = await probePort(port);

    assert.equal(result.state, 'rojo');
    assert.equal(result.state === 'rojo' && result.info.projectName, 'Fixture Game');
  });
});

test('another web server is another program', async () => {
  const server = httpServer((_request, response) => {
    response.writeHead(404);
    response.end('not found');
  });

  await withServer(server, async (port) => {
    assert.deepEqual(await probePort(port), { state: 'other', detail: 'HTTP 404' });
  });
});

test('a server that never answers is another program', async () => {
  const server = net.createServer(() => {
    // Accepts the connection and stays silent.
  });

  await withServer(server, async (port) => {
    assert.deepEqual(await probePort(port, 200), { state: 'other', detail: 'no answer' });
  });
});

test('a server that keeps trickling data cannot hold the probe past its timeout', async () => {
  const timers: NodeJS.Timeout[] = [];
  const server = httpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    timers.push(setInterval(() => response.write('.'), 50));
  });

  try {
    await withServer(server, async (port) => {
      const started = Date.now();
      const result = await probePort(port, 400);

      assert.deepEqual(result, { state: 'other', detail: 'no answer' });
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    });
  } finally {
    timers.forEach((timer) => clearInterval(timer));
  }
});

test('a closed port is free', async () => {
  const server = net.createServer();
  let port = 0;

  await withServer(server, (value) => {
    port = value;

    return Promise.resolve();
  });

  const results = await probePorts([port, port]);

  assert.equal(results.size, 1);
  assert.deepEqual(results.get(port), { state: 'free' });
});
