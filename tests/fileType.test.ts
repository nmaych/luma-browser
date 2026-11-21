import { describe, expect, it } from 'vitest';
import { fileTypeOf } from '../src/utils/fileType';

describe('fileTypeOf', () => {
  it('maps common document and media types to their own tone', () => {
    expect(fileTypeOf('report.pdf')).toMatchObject({ tone: 'pdf', label: 'PDF' });
    expect(fileTypeOf('sheet.XLSX')).toMatchObject({ tone: 'sheet', label: 'XLSX' });
    expect(fileTypeOf('clip.mp4')).toMatchObject({ tone: 'video' });
    expect(fileTypeOf('song.flac')).toMatchObject({ tone: 'audio' });
    expect(fileTypeOf('photo.jpeg')).toMatchObject({ tone: 'image' });
    expect(fileTypeOf('archive.7z')).toMatchObject({ tone: 'archive' });
  });

  it('groups installers and packages together', () => {
    expect(fileTypeOf('setup.exe').tone).toBe('installer');
    expect(fileTypeOf('app.crx').tone).toBe('installer');
    expect(fileTypeOf('build.msi').tone).toBe('installer');
  });

  it('falls back to a generic file for unknown or missing extensions', () => {
    expect(fileTypeOf('LICENSE')).toMatchObject({ tone: 'other', label: '' });
    expect(fileTypeOf('file.unknownext').tone).toBe('other');
    expect(fileTypeOf('')).toMatchObject({ tone: 'other', label: '' });
  });
});
