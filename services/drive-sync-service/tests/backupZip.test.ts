import { zipSync } from 'fflate';
import { describe, it, expect } from 'vitest';
import { InvalidBackupZip, extractBackupJson } from '../src/drive/backupZip';

describe('extractBackupJson', () => {
  it('returns the bytes of the single .json entry', () => {
    const zip = zipSync({ 'IvyWalletBackup.json': Buffer.from('{"a":1}') });
    expect(extractBackupJson(Buffer.from(zip), 'b.zip').toString()).toBe('{"a":1}');
  });

  it('rejects a zip with no json entry', () => {
    const zip = zipSync({ 'notes.txt': Buffer.from('hi') });
    expect(() => extractBackupJson(Buffer.from(zip), 'b.zip')).toThrow(InvalidBackupZip);
  });

  it('rejects a zip with more than one json entry', () => {
    const zip = zipSync({ 'a.json': Buffer.from('{}'), 'b.json': Buffer.from('{}') });
    expect(() => extractBackupJson(Buffer.from(zip), 'b.zip')).toThrow(InvalidBackupZip);
  });

  it('rejects bytes that are not a valid zip', () => {
    expect(() => extractBackupJson(Buffer.from('not a zip'), 'b.zip')).toThrow(InvalidBackupZip);
  });
});
