export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.wav', '.aac',
]);

export const PART_FOLDER_PREFIXES = ['cd', 'disc', 'disk', 'part', 'pt'];
export const COLLECTION_REVIEW_REASON = 'Place each book and all of its parts in a dedicated book folder before importing.';

export function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

export function isPartFolder(name: string): boolean {
  const lowerName = name.toLowerCase();
  const prefix = PART_FOLDER_PREFIXES.find(value => lowerName.startsWith(value));
  if (!prefix) return false;
  let number = name.slice(prefix.length).trimStart();
  if (number.startsWith('-') || number.startsWith('_')) number = number.slice(1).trimStart();
  return isDigit(number.charCodeAt(0));
}
