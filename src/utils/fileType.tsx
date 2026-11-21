import {
  Disc3,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Package,
  Presentation,
  Type,
  type LucideIcon,
} from 'lucide-react';

export type FileTone =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'installer'
  | 'code'
  | 'font'
  | 'disk'
  | 'other';

export interface FileTypeInfo {
  tone: FileTone;
  label: string;
  Icon: LucideIcon;
}

function kindOf(extension: string): FileTypeInfo {
  switch (extension) {
    case 'pdf':
      return { tone: 'pdf', label: 'PDF', Icon: FileText };
    case 'doc':
    case 'docx':
    case 'dot':
    case 'dotx':
    case 'rtf':
    case 'odt':
    case 'pages':
    case 'wps':
      return { tone: 'doc', label: extension.toUpperCase(), Icon: FileText };
    case 'xls':
    case 'xlsx':
    case 'xlsm':
    case 'csv':
    case 'tsv':
    case 'ods':
    case 'numbers':
      return { tone: 'sheet', label: extension.toUpperCase(), Icon: FileSpreadsheet };
    case 'ppt':
    case 'pptx':
    case 'pps':
    case 'ppsx':
    case 'odp':
    case 'key':
      return { tone: 'slide', label: extension.toUpperCase(), Icon: Presentation };
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'svg':
    case 'ico':
    case 'avif':
    case 'heic':
    case 'tif':
    case 'tiff':
    case 'psd':
      return { tone: 'image', label: extension.toUpperCase(), Icon: FileImage };
    case 'mp4':
    case 'mkv':
    case 'avi':
    case 'mov':
    case 'webm':
    case 'flv':
    case 'wmv':
    case 'm4v':
      return { tone: 'video', label: extension.toUpperCase(), Icon: FileVideo };
    case 'mp3':
    case 'wav':
    case 'flac':
    case 'aac':
    case 'ogg':
    case 'm4a':
    case 'opus':
    case 'wma':
      return { tone: 'audio', label: extension.toUpperCase(), Icon: FileAudio };
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'tgz':
    case 'bz2':
    case 'xz':
    case 'zst':
      return { tone: 'archive', label: extension.toUpperCase(), Icon: FileArchive };
    case 'exe':
    case 'msi':
    case 'msix':
    case 'apk':
    case 'crx':
    case 'xpi':
    case 'dmg':
    case 'pkg':
    case 'deb':
    case 'rpm':
    case 'appimage':
      return { tone: 'installer', label: extension.toUpperCase(), Icon: Package };
    case 'js':
    case 'mjs':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'json':
    case 'html':
    case 'htm':
    case 'css':
    case 'py':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'go':
    case 'rs':
    case 'sh':
    case 'bat':
    case 'ps1':
    case 'yml':
    case 'yaml':
    case 'xml':
    case 'sql':
    case 'php':
      return { tone: 'code', label: extension.toUpperCase(), Icon: FileCode2 };
    case 'ttf':
    case 'otf':
    case 'woff':
    case 'woff2':
      return { tone: 'font', label: extension.toUpperCase(), Icon: Type };
    case 'iso':
    case 'img':
    case 'vhd':
    case 'vmdk':
      return { tone: 'disk', label: extension.toUpperCase(), Icon: Disc3 };
    case 'txt':
    case 'md':
    case 'log':
    case 'ini':
    case 'conf':
      return { tone: 'doc', label: extension.toUpperCase(), Icon: FileText };
    default:
      return { tone: 'other', label: extension ? extension.toUpperCase().slice(0, 4) : '', Icon: File };
  }
}

/** Maps a download's file name to an icon, a category colour and a short label. */
export function fileTypeOf(filename: string): FileTypeInfo {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
  return kindOf(extension);
}
