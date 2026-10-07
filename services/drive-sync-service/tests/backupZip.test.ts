import { zipSync } from 'fflate';
import { describe, it, expect } from 'vitest';
import { InvalidBackupZip, extractBackupJson } from '../src/drive/backupZip';

describe('extractBackupJson', () => {
  it('returns the bytes of the single .json entry', () => {
    const zip = zipSync({ 'IvyWalletBackup.json': Buffer.from('{"a":1}') });
    expect(extractBackupJson(Buffer.from(zip), 'b.zip').toString()).toBe('{"a":1}');
  });

  it('transcodes a UTF-16BE entry with BOM (what the Ivy app writes) to UTF-8', () => {
    const be = Buffer.from('﻿{"name":"Café €"}', 'utf16le').swap16();
    const zip = zipSync({ 'data123.json': be });
    expect(extractBackupJson(Buffer.from(zip), 'b.zip').toString('utf8')).toBe('{"name":"Café €"}');
  });

  it('transcodes a UTF-16LE entry with BOM to UTF-8', () => {
    const zip = zipSync({ 'data123.json': Buffer.from('﻿{"a":"é"}', 'utf16le') });
    expect(extractBackupJson(Buffer.from(zip), 'b.zip').toString('utf8')).toBe('{"a":"é"}');
  });

  it('strips a UTF-8 BOM', () => {
    const zip = zipSync({ 'data123.json': Buffer.from('﻿{"a":1}', 'utf8') });
    expect(extractBackupJson(Buffer.from(zip), 'b.zip').toString('utf8')).toBe('{"a":1}');
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
