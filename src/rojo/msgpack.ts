/** Thrown for bytes that are not one complete MessagePack value. */
export class MsgpackError extends Error {}

/** An extension value, kept as it is (Rojo's server info has none). */
export interface MsgpackExtension {
  type: number;
  data: Uint8Array;
}

const MAX_DEPTH = 64;
const utf8 = new TextDecoder('utf-8');

/**
 * Decodes one MessagePack value: enough for what a Rojo server sends about itself (maps, strings, integers, arrays,
 * nil, booleans, floats, binary data). Integers beyond Number's safe range come back as bigint, map keys as strings.
 */
export function decodeMsgpack(bytes: Uint8Array): unknown {
  const reader = new Reader(bytes);
  const value = reader.value(0);

  if (!reader.done()) {
    throw new MsgpackError(`${bytes.length - reader.position} bytes left after the value`);
  }

  return value;
}

function integer(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
}

class Reader {
  position = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  done(): boolean {
    return this.position === this.bytes.length;
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) {
      throw new MsgpackError('nested too deeply');
    }

    const type = this.u8();

    if (type <= 0x7f) {
      return type;
    }

    if (type >= 0xe0) {
      return type - 0x100;
    }

    if (type <= 0x8f) {
      return this.map(type & 0x0f, depth);
    }

    if (type <= 0x9f) {
      return this.array(type & 0x0f, depth);
    }

    if (type <= 0xbf) {
      return this.str(type & 0x1f);
    }

    switch (type) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.take(this.u8()).slice();
      case 0xc5:
        return this.take(this.u16()).slice();
      case 0xc6:
        return this.take(this.u32()).slice();
      case 0xc7:
        return this.ext(this.u8());
      case 0xc8:
        return this.ext(this.u16());
      case 0xc9:
        return this.ext(this.u32());
      case 0xca:
        return this.view.getFloat32(this.advance(4));
      case 0xcb:
        return this.view.getFloat64(this.advance(8));
      case 0xcc:
        return this.u8();
      case 0xcd:
        return this.u16();
      case 0xce:
        return this.u32();
      case 0xcf:
        return integer(this.view.getBigUint64(this.advance(8)));
      case 0xd0:
        return this.view.getInt8(this.advance(1));
      case 0xd1:
        return this.view.getInt16(this.advance(2));
      case 0xd2:
        return this.view.getInt32(this.advance(4));
      case 0xd3:
        return integer(this.view.getBigInt64(this.advance(8)));
      case 0xd4:
        return this.ext(1);
      case 0xd5:
        return this.ext(2);
      case 0xd6:
        return this.ext(4);
      case 0xd7:
        return this.ext(8);
      case 0xd8:
        return this.ext(16);
      case 0xd9:
        return this.str(this.u8());
      case 0xda:
        return this.str(this.u16());
      case 0xdb:
        return this.str(this.u32());
      case 0xdc:
        return this.array(this.u16(), depth);
      case 0xdd:
        return this.array(this.u32(), depth);
      case 0xde:
        return this.map(this.u16(), depth);
      case 0xdf:
        return this.map(this.u32(), depth);
      default:
        throw new MsgpackError(`unknown type 0x${type.toString(16)} at byte ${this.position - 1}`);
    }
  }

  /** Moves past `length` bytes and returns where they start. */
  private advance(length: number): number {
    if (this.position + length > this.bytes.length) {
      throw new MsgpackError('unexpected end of data');
    }

    const start = this.position;
    this.position += length;

    return start;
  }

  private take(length: number): Uint8Array {
    const start = this.advance(length);

    return this.bytes.subarray(start, start + length);
  }

  private u8(): number {
    return this.view.getUint8(this.advance(1));
  }

  private u16(): number {
    return this.view.getUint16(this.advance(2));
  }

  private u32(): number {
    return this.view.getUint32(this.advance(4));
  }

  private str(length: number): string {
    return utf8.decode(this.take(length));
  }

  private ext(length: number): MsgpackExtension {
    const type = this.view.getInt8(this.advance(1));

    return { type, data: this.take(length).slice() };
  }

  /** Every element takes at least one byte: a count beyond the bytes left is broken data, not a huge array. */
  private checkCount(count: number, bytesPerItem: number): void {
    if (count * bytesPerItem > this.bytes.length - this.position) {
      throw new MsgpackError('unexpected end of data');
    }
  }

  private array(count: number, depth: number): unknown[] {
    this.checkCount(count, 1);

    const items: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      items.push(this.value(depth + 1));
    }

    return items;
  }

  private map(count: number, depth: number): Record<string, unknown> {
    this.checkCount(count, 2);

    const entries: [string, unknown][] = [];
    for (let index = 0; index < count; index += 1) {
      const key = this.value(depth + 1);
      entries.push([typeof key === 'string' ? key : String(key), this.value(depth + 1)]);
    }

    // fromEntries defines own properties, so a "__proto__" key cannot change the prototype.
    return Object.fromEntries(entries);
  }
}
