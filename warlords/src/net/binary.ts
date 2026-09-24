// Little-endian byte writer/reader used by the snapshot/input codecs.
// The writer grows on demand and is reusable (reset()) so steady-state encoding
// does not allocate beyond the final copy.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialSize = 1024) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.pos;
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  private ensure(n: number): void {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.pos, clampInt(v, -128, 127));
    this.pos += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.pos, clampInt(v, 0, 0xffff), true);
    this.pos += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.pos, clampInt(v, -0x8000, 0x7fff), true);
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.pos, clampInt(v, 0, 0xffffffff), true);
    this.pos += 4;
    return this;
  }

  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  /** Unsigned LEB128 (up to 2^53). Negative / non-finite values are written as 0. */
  varuint(v: number): this {
    let n = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    this.ensure(8);
    while (n >= 0x80) {
      this.buf[this.pos++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
      this.ensure(1);
    }
    this.buf[this.pos++] = n;
    return this;
  }

  /** Zig-zag signed varint. */
  varint(v: number): this {
    const n = Number.isFinite(v) ? Math.round(v) : 0;
    return this.varuint(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  str(s: string): this {
    const bytes = textEncoder.encode(s);
    this.varuint(bytes.length);
    this.bytes(bytes);
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  /** Copy of the written bytes. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class ByteReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  get offset(): number {
    return this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new RangeError('ByteReader: read past end of buffer');
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  i8(): number {
    this.need(1);
    const v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  varuint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return result;
      mul *= 0x80;
    }
    throw new RangeError('ByteReader: varuint too long');
  }

  varint(): number {
    const z = this.varuint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  str(): string {
    const len = this.varuint();
    this.need(len);
    const s = textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  bytes(len: number): Uint8Array {
    this.need(len);
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return v > 0 ? hi : v < 0 ? lo : 0;
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
}
