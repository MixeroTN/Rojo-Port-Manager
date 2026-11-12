/** What the panel reads from a `*.project.json` file. */
export interface ProjectFileInfo {
  /** The project's `name`: a Rojo server reports it, so it tells which project a server serves. */
  name?: string;
  /** `servePort`: the port `rojo serve` uses when no `--port` is given. */
  servePort?: number;
  /** `servePlaceIds`: the places the Studio plugin may sync the project into. */
  servePlaceIds: string[];
}

export const PROJECT_SUFFIX = '.project.json';

/** Whether a file name is a Rojo project file. */
export function isProjectFileName(name: string): boolean {
  return name.toLowerCase().endsWith(PROJECT_SUFFIX) && name.length > PROJECT_SUFFIX.length;
}

/** The name shown for a project file: `default.project.json` is "default". */
export function projectLabel(fileName: string): string {
  return isProjectFileName(fileName) ? fileName.slice(0, -PROJECT_SUFFIX.length) : fileName;
}

/** Orders project files: `default.project.json` first, then by name. */
export function compareProjectFiles(left: string, right: string): number {
  const leftDefault = left.toLowerCase() === 'default.project.json';
  const rightDefault = right.toLowerCase() === 'default.project.json';

  if (leftDefault !== rightDefault) {
    return leftDefault ? -1 : 1;
  }

  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}

/** The end of the JSON string that starts at `start` (the index after its closing quote). */
function skipString(text: string, start: number): number {
  let index = start + 1;

  while (index < text.length && text[index] !== '"') {
    index += text[index] === '\\' ? 2 : 1;
  }

  return index + 1;
}

/** Removes `//` and `/* *\/` comments, then trailing commas, outside strings (some project files carry them). */
export function stripJsonComments(text: string): string {
  let withoutComments = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';

    if (char === '"') {
      const end = skipString(text, index);
      withoutComments += text.slice(index, end);
      index = end;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      withoutComments += char;
      index += 1;
    }
  }

  let result = '';
  index = 0;

  while (index < withoutComments.length) {
    const char = withoutComments[index] ?? '';

    if (char === '"') {
      const end = skipString(withoutComments, index);
      result += withoutComments.slice(index, end);
      index = end;
      continue;
    }

    if (char === ',') {
      let ahead = index + 1;
      while (ahead < withoutComments.length && /\s/.test(withoutComments[ahead] ?? '')) {
        ahead += 1;
      }

      const following = withoutComments[ahead];
      if (following === '}' || following === ']') {
        index += 1;
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
}

/** The text without a byte order mark at its start (editors on Windows may write one). */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Reads a project file; undefined when it is not a JSON object. */
export function parseProjectFile(text: string): ProjectFileInfo | undefined {
  let data: unknown;

  try {
    data = JSON.parse(withoutBom(text));
  } catch {
    try {
      data = JSON.parse(stripJsonComments(withoutBom(text)));
    } catch {
      return undefined;
    }
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }

  const record = data as Record<string, unknown>;
  const placeIds: unknown[] = Array.isArray(record.servePlaceIds) ? (record.servePlaceIds as unknown[]) : [];

  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    servePort: isPort(record.servePort) ? record.servePort : undefined,
    servePlaceIds: placeIds
      .map((id) => (typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id))
      .filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id)),
  };
}
