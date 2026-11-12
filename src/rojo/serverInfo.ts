import { decodeMsgpack } from './msgpack.ts';

/** What a Rojo server tells about itself at `/api/rojo`. */
export interface RojoServerInfo {
  /** The `name` of the project file it serves. */
  projectName: string;
  /** Changes every time a server starts. */
  sessionId: string;
  serverVersion?: string;
  protocolVersion?: number;
  /** The project's `servePlaceIds`: the places the Studio plugin may sync into (empty: any place). */
  expectedPlaceIds: string[];
  gameId?: string;
  placeId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A Roblox ID as text: integers (also beyond Number's safe range) and digit strings. */
export function readId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  if (typeof value === 'bigint' && value >= 0n) {
    return value.toString();
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return value;
  }

  return undefined;
}

function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(readId).filter((id): id is string => id !== undefined);
}

function decode(body: Uint8Array, contentType: string | undefined): unknown {
  const type = (contentType ?? '').toLowerCase();
  // Rojo 7.7 answers MessagePack; older versions answer JSON.
  const json = type.includes('json') || (!type.includes('msgpack') && body[0] === 0x7b);

  return json ? JSON.parse(new TextDecoder().decode(body)) : decodeMsgpack(body);
}

/**
 * Reads the answer of `/api/rojo`. Anything else (another program on the port, a broken answer) gives undefined: a
 * Rojo server always names its project and its session.
 */
export function parseServerInfo(body: Uint8Array, contentType: string | undefined): RojoServerInfo | undefined {
  let data: unknown;

  try {
    data = decode(body, contentType);
  } catch {
    return undefined;
  }

  if (!isRecord(data) || typeof data.projectName !== 'string' || typeof data.sessionId !== 'string') {
    return undefined;
  }

  return {
    projectName: data.projectName,
    sessionId: data.sessionId,
    serverVersion: typeof data.serverVersion === 'string' ? data.serverVersion : undefined,
    protocolVersion: typeof data.protocolVersion === 'number' ? data.protocolVersion : undefined,
    expectedPlaceIds: readIds(data.expectedPlaceIds),
    gameId: readId(data.gameId),
    placeId: readId(data.placeId),
  };
}
