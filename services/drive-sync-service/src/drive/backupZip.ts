import { unzipSync } from 'fflate';

export class InvalidBackupZip extends Error {}

/** Ivy Wallet backups are a zip with a single JSON entry; this pulls that entry out as UTF-8 bytes. */
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
  return toUtf8(Buffer.from(entries[jsonNames[0]!]!));
}

/**
 * The Ivy Wallet app writes the entry as UTF-16 (big-endian, with BOM), but analytics-service
 * reads application/json bodies as UTF-8, so transcode based on the BOM and drop it.
 */
function toUtf8(bytes: Buffer): Buffer {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const le = Buffer.from(bytes.subarray(2)); // copy: swap16 mutates in place
    if (le.length % 2 !== 0) throw new InvalidBackupZip('backup JSON is truncated UTF-16');
    return Buffer.from(le.swap16().toString('utf16le'), 'utf8');
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Buffer.from(bytes.subarray(2).toString('utf16le'), 'utf8');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3);
  return bytes;
}
