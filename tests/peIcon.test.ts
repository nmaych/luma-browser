import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const peIcon = require('../electron/main/peIcon.cjs') as {
  bufferReader: (buffer: Buffer) => { size: number; read: (offset: number, length: number) => Buffer };
  dibToBgra: (dib: Buffer) => { bitmap: Buffer; width: number; height: number } | null;
  iconFromReader: (reader: unknown) => { kind: 'png' | 'dib'; data: Buffer; width: number; height: number } | null;
  iconFromFile: (file: string) => { kind: 'png' | 'dib'; data: Buffer } | null;
  parseGroupDirectory: (buffer: Buffer) => { id: number; width: number; height: number; bitCount: number }[];
  isPng: (buffer: Buffer) => boolean;
  PE_EXTENSIONS: Set<string>;
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYkBBhgYAAAhBwMBvJb0Z QAAAABJRU5ErkJggg=='.replace(' ', ''),
  'base64',
);

/**
 * Builds a minimal PE32+ image that carries one icon group and one icon, laid
 * out the way a real resource compiler emits them: root directory, per-type
 * directories, then a language directory, the data entry and the payload.
 *
 * Every offset in the tree is relative to the resource section — the detail that
 * made the first implementation miss every icon.
 */
function buildPe({ namedGroup = false, payload = PNG, bitCount = 32 } = {}) {
  const resourceRva = 0x1000;
  const resourceFileOffset = 0x400;

  // Layout inside the resource section, in the order the offsets are computed.
  const rootDir = 0;
  const typeDirs = [rootDir + 16 + 2 * 8];
  const typeIconDir = typeDirs[0];
  const typeGroupDir = typeIconDir + 16 + 8;
  const iconNameDir = typeGroupDir + 16 + 8;
  const groupNameDir = iconNameDir + 16 + 8;
  const iconLangDir = groupNameDir + 16 + 8;
  const groupLangDir = iconLangDir + 16 + 8;
  const iconDataEntry = groupLangDir + 16 + 8;
  const groupDataEntry = iconDataEntry + 16;
  const iconPayload = groupDataEntry + 16;
  const groupPayload = iconPayload + payload.length;

  const group = Buffer.alloc(6 + 14);
  group.writeUInt16LE(0, 0);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(1, 4);
  group[6] = 2; // width  (0 would mean 256)
  group[7] = 2; // height
  group[8] = 0;
  group[9] = 0;
  group.writeUInt16LE(1, 10); // planes
  group.writeUInt16LE(bitCount, 12);
  group.writeUInt32LE(payload.length, 14);
  group.writeUInt16LE(1, 18); // icon id

  const section = Buffer.alloc(groupPayload + group.length);
  const dirHeader = (target: Buffer, idCount: number) => {
    target.writeUInt32LE(0, 0);
    target.writeUInt32LE(0, 4);
    target.writeUInt16LE(0, 8);
    target.writeUInt16LE(0, 10);
    target.writeUInt16LE(0, 12);
    target.writeUInt16LE(idCount, 14);
  };
  const entry = (target: Buffer, index: number, name: number, dataField: number) => {
    target.writeUInt32LE(name >>> 0, 16 + index * 8);
    target.writeUInt32LE(dataField >>> 0, 16 + index * 8 + 4);
  };

  dirHeader(section.subarray(rootDir), 2);
  entry(section.subarray(rootDir), 0, 3, 0x80000000 | typeIconDir);
  entry(section.subarray(rootDir), 1, 14, 0x80000000 | typeGroupDir);

  dirHeader(section.subarray(typeIconDir), 1);
  entry(section.subarray(typeIconDir), 0, 1, 0x80000000 | iconNameDir);
  dirHeader(section.subarray(typeGroupDir), 1);
  // A named group (high bit set on the name field) is what Git's installer does.
  entry(section.subarray(typeGroupDir), 0, namedGroup ? (0x80000000 | 0x100) : 1, 0x80000000 | groupNameDir);

  dirHeader(section.subarray(iconNameDir), 1);
  entry(section.subarray(iconNameDir), 0, 1033, 0x80000000 | iconLangDir);
  dirHeader(section.subarray(groupNameDir), 1);
  entry(section.subarray(groupNameDir), 0, 1033, 0x80000000 | groupLangDir);

  dirHeader(section.subarray(iconLangDir), 1);
  entry(section.subarray(iconLangDir), 0, 1033, iconDataEntry);
  dirHeader(section.subarray(groupLangDir), 1);
  entry(section.subarray(groupLangDir), 0, 1033, groupDataEntry);

  section.writeUInt32LE(resourceRva + iconPayload, iconDataEntry);
  section.writeUInt32LE(payload.length, iconDataEntry + 4);
  section.writeUInt32LE(resourceRva + groupPayload, groupDataEntry);
  section.writeUInt32LE(group.length, groupDataEntry + 4);

  payload.copy(section, iconPayload);
  group.copy(section, groupPayload);

  const headers = Buffer.alloc(resourceFileOffset);
  headers.writeUInt16LE(0x5a4d, 0); // MZ
  headers.writeUInt32LE(0x80, 0x3c); // e_lfanew
  headers.writeUInt32LE(0x00004550, 0x80); // PE\0\0
  const coff = 0x84;
  headers.writeUInt16LE(1, coff + 2); // one section
  headers.writeUInt16LE(240, coff + 16); // optional header size
  const optional = coff + 20;
  headers.writeUInt16LE(0x20b, optional); // PE32+
  const resourceDirectory = optional + 112 + 2 * 8;
  headers.writeUInt32LE(resourceRva, resourceDirectory);
  headers.writeUInt32LE(section.length, resourceDirectory + 4);

  const sectionTable = optional + 240;
  headers.write('.rsrc', sectionTable, 'ascii');
  headers.writeUInt32LE(section.length, sectionTable + 8);
  headers.writeUInt32LE(resourceRva, sectionTable + 12);
  headers.writeUInt32LE(section.length, sectionTable + 16);
  headers.writeUInt32LE(resourceFileOffset, sectionTable + 20);

  return Buffer.concat([headers, section]);
}

describe('peIcon', () => {
  it('reads the icon a PE file carries, including through a language directory', () => {
    const icon = peIcon.iconFromReader(peIcon.bufferReader(buildPe()));
    expect(icon).not.toBeNull();
    expect(icon?.kind).toBe('png');
    expect(icon?.data.equals(PNG)).toBe(true);
  });

  it('finds the group even when the resource is named instead of numbered', () => {
    const icon = peIcon.iconFromReader(peIcon.bufferReader(buildPe({ namedGroup: true })));
    expect(icon?.kind).toBe('png');
  });

  it('returns null for anything that is not a PE image', () => {
    expect(peIcon.iconFromReader(peIcon.bufferReader(Buffer.from('not an executable')))).toBeNull();
    expect(peIcon.iconFromReader(peIcon.bufferReader(Buffer.alloc(0)))).toBeNull();
    expect(peIcon.iconFromFile('C:/definitely/missing/file.exe')).toBeNull();
  });

  it('parses a group directory and ignores malformed buffers', () => {
    expect(peIcon.parseGroupDirectory(Buffer.from([1, 2, 3]))).toEqual([]);
    const group = Buffer.alloc(6 + 14);
    group.writeUInt16LE(1, 2);
    group.writeUInt16LE(1, 4);
    group[6] = 0; // 0 means 256
    group[7] = 0;
    group.writeUInt16LE(32, 12);
    group.writeUInt32LE(4096, 14);
    group.writeUInt16LE(7, 18);
    expect(peIcon.parseGroupDirectory(group)).toEqual([{ width: 256, height: 256, bitCount: 32, bytes: 4096, id: 7 }]);
  });

  it('turns a bottom-up 32 bit DIB into premultiplied BGRA', () => {
    // 2x2, height counts the AND mask so it is doubled; rows are bottom-up.
    const dib = Buffer.alloc(40 + 16 + 8);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(2, 4);
    dib.writeInt32LE(4, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    // Bottom row: red, green. Top row: blue, half-transparent white.
    dib.set([0, 0, 255, 255, 0, 255, 0, 255], 40);
    dib.set([255, 0, 0, 255, 255, 255, 255, 128], 48);
    const decoded = peIcon.dibToBgra(dib);
    expect(decoded).toEqual({ width: 2, height: 2, bitmap: expect.any(Buffer) });
    // Top row comes from the last bytes on disk: blue at full alpha, unchanged.
    expect([...decoded!.bitmap.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    // White at alpha 128 is premultiplied, otherwise it draws too bright.
    expect([...decoded!.bitmap.subarray(4, 8)]).toEqual([128, 128, 128, 128]);
    // Bottom row comes from the first bytes on disk.
    expect([...decoded!.bitmap.subarray(8, 12)]).toEqual([0, 0, 255, 255]);
    expect([...decoded!.bitmap.subarray(12, 16)]).toEqual([0, 255, 0, 255]);
  });

  it('refuses bit depths it cannot decode', () => {
    const dib = Buffer.alloc(40 + 64);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(8, 4);
    dib.writeInt32LE(16, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(8, 14);
    expect(peIcon.dibToBgra(dib)).toBeNull();
  });

  it('knows which extensions live in a PE resource directory', () => {
    expect(peIcon.PE_EXTENSIONS.has('exe')).toBe(true);
    expect(peIcon.PE_EXTENSIONS.has('msi')).toBe(false);
    expect(peIcon.isPng(PNG)).toBe(true);
    expect(peIcon.isPng(Buffer.from([1, 2, 3]))).toBe(false);
  });
});
