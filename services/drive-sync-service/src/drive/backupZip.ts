import { unzipSync } from 'fflate';

export class InvalidBackupZip extends Error {}

/** Ivy Wallet backups are a zip with a single JSON entry; this pulls that entry's bytes out. */
export function extractBackupJson(zipBytes: Buffer, fileName: string): Buffer {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    throw new InvalidBackupZip(`${fileName} is not a valid zip file`);
  }
  const jsonNames = Object.keys(entries).filter((name) => !name.endsWith('/') && name.toLowerCase().endsWith('.json'));
  if (jsonNames.length === 0) throw new InvalidBackupZip(`${fileName} has no .json entry`);
  if (jsonNames.length > 1) throw new InvalidBackupZip(`${fileName} has more than one .json entry`);
  return Buffer.from(entries[jsonNames[0]!]!);
}
