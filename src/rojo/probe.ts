import * as http from 'node:http';
import { parseServerInfo, type RojoServerInfo } from './serverInfo.ts';

/** What listens on a local port. */
export type ProbeResult =
  /** Nothing: the connection was refused. */
  | { state: 'free' }
  | { state: 'rojo'; info: RojoServerInfo }
  /** Something listens, but it is not a Rojo server (or did not answer like one in time). */
  | { state: 'other'; detail: string };

const MAX_BODY = 64 * 1024;

/**
 * Asks `http://127.0.0.1:<port>/api/rojo` what is there. Never rejects, and always settles within the timeout: a
 * program that keeps sending a trickle of data cannot hold it.
 */
export function probePort(port: number, timeoutMs = 1500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      finish({ state: 'other', detail: 'no answer' });
      controller.abort();
    }, timeoutMs);

    function finish(result: ProbeResult): void {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      }
    }

    const options = { host: '127.0.0.1', port, path: '/api/rojo', agent: false, signal: controller.signal };
    const request = http.get(options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;

      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          finish({ state: 'other', detail: 'answer too large' });
          request.destroy();

          return;
        }

        chunks.push(chunk);
      });
      response.on('end', () => {
        const info =
          response.statusCode === 200
            ? parseServerInfo(Buffer.concat(chunks), response.headers['content-type'])
            : undefined;

        finish(info ? { state: 'rojo', info } : { state: 'other', detail: `HTTP ${response.statusCode ?? '?'}` });
      });
      response.on('error', (error) => finish({ state: 'other', detail: error.message }));
    });

    request.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        error.code === 'ECONNREFUSED' ? { state: 'free' } : { state: 'other', detail: error.code ?? error.message },
      );
    });
  });
}

/** Probes the ports at the same time (each once). */
export async function probePorts(ports: Iterable<number>, timeoutMs?: number): Promise<Map<number, ProbeResult>> {
  const unique = [...new Set(ports)];
  const results = await Promise.all(unique.map(async (port) => [port, await probePort(port, timeoutMs)] as const));

  return new Map(results);
}
