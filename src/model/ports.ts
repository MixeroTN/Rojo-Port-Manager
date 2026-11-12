export interface PortRange {
  first: number;
  last: number;
}

/** The port of `rojo serve` without `--port` and without a `servePort`. */
export const ROJO_DEFAULT_PORT = 34872;
export const DEFAULT_RANGE: PortRange = { first: 34872, last: 34899 };

/** The most ports the panel probes from the range: each refresh asks every one of them. */
export const MAX_RANGE_SIZE = 256;

export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** A port typed by the user: digits only, 1024-65535 (lower ports need administrator rights on some systems). */
export function parsePortInput(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    return undefined;
  }

  const port = Number(trimmed);

  return port >= 1024 && port <= 65535 ? port : undefined;
}

/** Reads the `rojoPorts.portRange` setting ("34872-34899", or one port); anything else gives the default range. */
export function parseRange(value: unknown): PortRange {
  if (typeof value !== 'string') {
    return DEFAULT_RANGE;
  }

  const match = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(value);
  if (!match) {
    return DEFAULT_RANGE;
  }

  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);

  if (!isValidPort(first) || !isValidPort(last) || last < first) {
    return DEFAULT_RANGE;
  }

  return { first, last: Math.min(last, first + MAX_RANGE_SIZE - 1) };
}

export function formatRange(range: PortRange): string {
  return range.first === range.last ? String(range.first) : `${range.first}-${range.last}`;
}

/**
 * The port for a project that has none yet: the lowest free one of the range. Rojo's default port is skipped, so a
 * plain `rojo serve` started by hand keeps working next to the panel's servers.
 */
export function pickPort(range: PortRange, taken: ReadonlySet<number>): number | undefined {
  for (let port = range.first; port <= range.last; port += 1) {
    if (port !== ROJO_DEFAULT_PORT && !taken.has(port)) {
      return port;
    }
  }

  return undefined;
}

/** The ports to probe: the range and the extra ones (saved or wanted by projects), each once, in order. */
export function portsToProbe(range: PortRange, extra: Iterable<number>): number[] {
  const ports = new Set<number>();

  for (let port = range.first; port <= range.last; port += 1) {
    ports.add(port);
  }

  for (const port of extra) {
    if (isValidPort(port)) {
      ports.add(port);
    }
  }

  return [...ports].sort((left, right) => left - right);
}
