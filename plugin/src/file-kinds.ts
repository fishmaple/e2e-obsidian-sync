export interface FileGroup {
  id: "image" | "video" | "audio" | "document" | "obsidian";
  suffixes: string[];
}

export const FILE_GROUPS: FileGroup[] = [
  { id: "image", suffixes: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "heic", "avif"] },
  { id: "video", suffixes: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv"] },
  { id: "audio", suffixes: ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"] },
  { id: "document", suffixes: ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"] },
  { id: "obsidian", suffixes: ["md", "canvas", "base"] },
];

const KNOWN = new Set(FILE_GROUPS.flatMap((group) => group.suffixes));

export function allSuffixes(): string[] {
  return [...KNOWN];
}

export function fileSuffix(path: string): string {
  const base = path.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function suffixSelected(path: string, selected: string[], includeOther: boolean): boolean {
  const suffix = fileSuffix(path);
  if (!suffix || !KNOWN.has(suffix)) return includeOther;
  return selected.includes(suffix);
}
