/**
 * Reads the icon a Windows executable carries.
 *
 * `app.getFileIcon` goes through the shell, and for `.exe` the shell keeps
 * answering with its generic "application" artwork, so every installer looked
 * identical in the download list even though each one ships its own logo. The
 * artwork is a PE resource, so we walk the resource directory ourselves:
 * RT_GROUP_ICON (14) lists the sizes, RT_ICON (3) holds the pixels.
 *
 * Only offsets are read, never the whole file: a 280 MB installer must not be
 * pulled into memory to draw a 44 px square.
 */

const fs = require('node:fs');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

/** Extensions whose icon lives in a PE resource directory. */
const PE_EXTENSIONS = new Set(['exe', 'dll', 'scr', 'cpl', 'ocx', 'sys', 'mui']);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bufferReader(buffer) {
  return { size: buffer.length, read: (offset, length) => buffer.subarray(offset, offset + length) };
}

function fileReader(fd, size) {
  return {
    size,
    read(offset, length) {
      const target = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, target, 0, length, offset);
      return read === length ? target : target.subarray(0, read);
    },
  };
}

function u8(reader, offset) {
  const view = reader.read(offset, 1);
  return view.length === 1 ? view[0] : -1;
}

function u16(reader, offset) {
  const view = reader.read(offset, 2);
  return view.length === 2 ? view.readUInt16LE(0) : -1;
}

function u32(reader, offset) {
  const view = reader.read(offset, 4);
  return view.length === 4 ? view.readUInt32LE(0) : -1;
}

/** Section table entry: maps an RVA to a file offset. */
function sections(reader, tableOffset, count) {
  const list = [];
  const raw = reader.read(tableOffset, count * 40);
  for (let index = 0; index < count; index += 1) {
    const base = index * 40;
    if (base + 40 > raw.length) break;
    const virtualSize = raw.readUInt32LE(base + 8);
    const virtualAddress = raw.readUInt32LE(base + 12);
    const rawSize = raw.readUInt32LE(base + 16);
    const rawPointer = raw.readUInt32LE(base + 20);
    if (Math.max(virtualSize, rawSize) === 0) continue;
    list.push({ start: virtualAddress, span: Math.max(virtualSize, rawSize), rawPointer, rawSize });
  }
  return list;
}

function rvaToOffset(table, rva) {
  for (const section of table) {
    if (rva >= section.start && rva < section.start + section.span) {
      const delta = rva - section.start;
      if (delta >= section.rawSize) return -1;
      return section.rawPointer + delta;
    }
  }
  return -1;
}

/**
 * One directory in the resource tree. Each entry is 8 bytes: a name/id, and an
 * offset whose high bit means "another directory" instead of "a data entry".
 */
function directoryEntries(reader, offset) {
  const header = reader.read(offset, 16);
  if (header.length < 16) return [];
  const named = header.readUInt16LE(12);
  const ids = header.readUInt16LE(14);
  const count = named + ids;
  if (count <= 0 || count > 4096) return [];
  const body = reader.read(offset + 16, count * 8);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const base = index * 8;
    if (base + 8 > body.length) break;
    const nameField = body.readUInt32LE(base);
    const dataField = body.readUInt32LE(base + 4);
    entries.push({
      // Named entries carry a string offset; only numeric ids matter here.
      id: (nameField & 0x80000000) ? null : nameField,
      directory: (dataField & 0x80000000) !== 0,
      offset: dataField & 0x7fffffff,
    });
  }
  return entries;
}

function findEntry(entries, id) {
  return entries.find((entry) => entry.id === id) ?? null;
}

function firstLeaf(reader, entries, rootOffset) {
  const entry = entries[0];
  if (!entry) return null;
  return entry.directory ? firstLeaf(reader, directoryEntries(reader, rootOffset + entry.offset), rootOffset) : entry;
}

/** IMAGE_RESOURCE_DATA_ENTRY: RVA + size of the payload. */
function dataEntry(reader, base, offset) {
  const view = reader.read(base + offset, 16);
  if (view.length < 16) return null;
  return { rva: view.readUInt32LE(0), size: view.readUInt32LE(4) };
}

/**
 * Parses GRPICONDIR (the RT_GROUP_ICON payload).
 * @returns {{id:number,width:number,height:number,bitCount:number,bytes:number}[]}
 */
function parseGroupDirectory(buffer) {
  if (!buffer || buffer.length < 6) return [];
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return [];
  const count = buffer.readUInt16LE(4);
  if (!count || count > 64 || buffer.length < 6 + count * 14) return [];
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const base = 6 + index * 14;
    // 0 means 256 in this structure.
    const width = buffer[base] || 256;
    const height = buffer[base + 1] || 256;
    entries.push({
      width,
      height,
      bitCount: buffer.readUInt16LE(base + 6),
      bytes: buffer.readUInt32LE(base + 8),
      id: buffer.readUInt16LE(base + 12),
    });
  }
  return entries;
}

/**
 * Converts the bottom-up DIB of an RT_ICON into premultiplied BGRA, which is
 * what `nativeImage.createFromBitmap` expects.
 * @returns {{bitmap: Buffer, width: number, height: number} | null}
 */
function dibToBgra(dib) {
  if (!dib || dib.length < 40) return null;
  const headerSize = dib.readUInt32LE(0);
  if (headerSize < 40 || headerSize > dib.length) return null;
  const width = dib.readInt32LE(4);
  const rawHeight = dib.readInt32LE(8);
  const planes = dib.readUInt16LE(12);
  const bitCount = dib.readUInt16LE(14);
  const compression = dib.readUInt32LE(16);
  if (width <= 0 || width > 4096 || planes !== 1) return null;
  if (compression !== 0 && compression !== 3) return null;
  if (bitCount !== 32 && bitCount !== 24) return null;
  // Icon DIBs store XOR and AND masks stacked, so the real height is half.
  const height = rawHeight % 2 === 0 && rawHeight > 0 ? rawHeight / 2 : Math.abs(rawHeight);
  if (height <= 0 || height > 4096) return null;

  const palette = compression === 3 && headerSize === 40 ? 12 : 0;
  const xorStride = (((width * bitCount) + 31) >> 5) * 4;
  const andStride = (((width) + 31) >> 5) * 4;
  const xorStart = headerSize + palette;
  const andStart = xorStart + xorStride * height;
  if (andStart > dib.length) return null;
  const bottomUp = rawHeight > 0;

  const bitmap = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let row = 0; row < height; row += 1) {
    const sourceRow = bottomUp ? height - 1 - row : row;
    const rowStart = xorStart + sourceRow * xorStride;
    const andRow = andStart + row * andStride;
    for (let column = 0; column < width; column += 1) {
      const source = rowStart + column * (bitCount / 8);
      if (source + (bitCount / 8) > dib.length) break;
      const blue = dib[source];
      const green = dib[source + 1];
      const red = dib[source + 2];
      let alpha = bitCount === 32 ? dib[source + 3] : 0;
      if (bitCount === 24 || alpha === 0) {
        const maskByte = dib[andRow + (column >> 3)];
        const transparent = maskByte !== undefined && ((maskByte >> (7 - (column & 7))) & 1) === 1;
        alpha = transparent ? 0 : 255;
      }
      if (alpha > 0) anyAlpha = true;
      const target = (row * width + column) * 4;
      // Premultiply: Chromium treats the buffer as premultiplied BGRA.
      bitmap[target] = Math.round((blue * alpha) / 255);
      bitmap[target + 1] = Math.round((green * alpha) / 255);
      bitmap[target + 2] = Math.round((red * alpha) / 255);
      bitmap[target + 3] = alpha;
    }
  }
  if (!anyAlpha) return null;
  return { bitmap, width, height };
}

function isPng(buffer) {
  return Boolean(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * Locates the largest icon in a PE image.
 * @param {{size:number, read:(offset:number,length:number)=>Buffer}} reader
 */
function locateIcon(reader) {
  if (reader.size < 0x40) return null;
  if (u16(reader, 0) !== 0x5a4d) return null; // MZ
  const peOffset = u32(reader, 0x3c);
  if (peOffset <= 0 || peOffset + 24 > reader.size) return null;
  if (u32(reader, peOffset) !== 0x00004550) return null; // PE\0\0
  const coff = peOffset + 4;
  const sectionCount = u16(reader, coff + 2);
  const optionalSize = u16(reader, coff + 16);
  if (sectionCount <= 0 || sectionCount > 96) return null;
  const optional = coff + 20;
  const magic = u16(reader, optional);
  const is64 = magic === 0x20b;
  if (magic !== 0x10b && !is64) return null;
  const directoryOffset = optional + (is64 ? 112 : 96);
  const resourceRva = u32(reader, directoryOffset + 2 * 8);
  if (!resourceRva) return null;
  const table = sections(reader, optional + optionalSize, sectionCount);
  const rootOffset = rvaToOffset(table, resourceRva);
  if (rootOffset < 0) return null;

  const types = directoryEntries(reader, rootOffset);
  const groupType = findEntry(types, RT_GROUP_ICON);
  const iconType = findEntry(types, RT_ICON);
  if (!groupType?.directory || !iconType?.directory) return null;

  // Walk every group and keep the one with the biggest artwork.
  const groups = directoryEntries(reader, rootOffset + groupType.offset);
  const iconDirectory = rootOffset + iconType.offset;
  const iconEntries = directoryEntries(reader, iconDirectory);
  let best = null;
  for (const group of groups.slice(0, 32)) {
    const groupLeaf = group.directory
      ? firstLeaf(reader, directoryEntries(reader, rootOffset + group.offset), rootOffset)
      : group;
    if (!groupLeaf || groupLeaf.directory) continue;
    const groupData = dataEntry(reader, rootOffset, groupLeaf.offset);
    if (!groupData || groupData.size <= 6 || groupData.size > 1024 * 1024) continue;
    const groupOffset = rvaToOffset(table, groupData.rva);
    if (groupOffset < 0) continue;
    const entries = parseGroupDirectory(reader.read(groupOffset, groupData.size));
    for (const entry of entries) {
      const score = entry.width * entry.height;
      if (best && score <= best.score) continue;
      const iconEntry = findEntry(iconEntries, entry.id);
      if (!iconEntry) continue;
      // Every offset in the tree is relative to the resource section, not to the
      // directory we just read, and a language directory sits before the payload.
      const iconLeaf = iconEntry.directory
        ? firstLeaf(reader, directoryEntries(reader, rootOffset + iconEntry.offset), rootOffset)
        : iconEntry;
      if (!iconLeaf || iconLeaf.directory) continue;
      const iconData = dataEntry(reader, rootOffset, iconLeaf.offset);
      if (!iconData || iconData.size < 32 || iconData.size > 4 * 1024 * 1024) continue;
      const iconOffset = rvaToOffset(table, iconData.rva);
      if (iconOffset < 0) continue;
      best = {
        score,
        width: entry.width,
        height: entry.height,
        bitCount: entry.bitCount,
        offset: iconOffset,
        size: iconData.size,
      };
    }
  }
  return best;
}

/**
 * @returns {{kind:'png'|'dib', data:Buffer, width:number, height:number} | null}
 */
function iconFromReader(reader) {
  const found = locateIcon(reader);
  if (!found) return null;
  const data = reader.read(found.offset, found.size);
  if (data.length < 32) return null;
  if (isPng(data)) return { kind: 'png', data, width: found.width, height: found.height };
  return { kind: 'dib', data, width: found.width, height: found.height };
}

/** Reads the icon straight out of a file on disk. */
function iconFromFile(file) {
  let handle;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1024) return null;
    const fd = fs.openSync(file, 'r');
    handle = fd;
    return iconFromReader(fileReader(fd, stat.size));
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Already closed.
      }
    }
  }
}

module.exports = {
  dibToBgra,
  iconFromFile,
  iconFromReader,
  isPng,
  locateIcon,
  parseGroupDirectory,
  PE_EXTENSIONS,
  bufferReader,
  fileReader,
};
