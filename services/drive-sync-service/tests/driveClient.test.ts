import { describe, it, expect } from 'vitest';
import { BackupTooLarge, DriveClient, DriveRateLimited, type FileMeta } from '../src/drive/driveClient';
import { ReauthRequired } from '../src/auth/google';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const token = async () => 't';
const noSleep = async () => {};

function client(responses: (() => Response)[]) {
  let i = 0;
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return (responses[Math.min(i++, responses.length - 1)] as () => Response)();
  }) as unknown as typeof fetch;
  return { drive: new DriveClient(token, { fetchFn, sleep: noSleep, maxRetries: 2 }), calls };
}

const meta: FileMeta = { id: 'f1', name: 'b.json', mimeType: 'application/json', size: 10, modifiedTime: '', parents: ['p'] };

describe('DriveClient', () => {
  it('retries 429/5xx then succeeds', async () => {
    const { drive, calls } = client([() => json(429, {}), () => json(503, {}), () => json(200, { files: [] })]);
    await expect(drive.listFolders()).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it('gives up with DriveRateLimited after max retries', async () => {
    const rl = () => json(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } });
    const { drive } = client([rl]);
    await expect(drive.listFolders()).rejects.toBeInstanceOf(DriveRateLimited);
  });

  it('maps 401 to ReauthRequired without retrying', async () => {
    const { drive, calls } = client([() => json(401, {})]);
    await expect(drive.listFolders()).rejects.toBeInstanceOf(ReauthRequired);
    expect(calls).toHaveLength(1);
  });

  it('lists backups newest first across pages', async () => {
    const { drive } = client([
      () => json(200, { nextPageToken: 'n', files: [{ id: 'a', name: 'IvyWalletBackup-20260902-0001.zip', modifiedTime: '2026-09-02', size: '5' }] }),
      () => json(200, { files: [{ id: 'b', name: 'IvyWalletBackup-20260901-0001.zip', modifiedTime: '2026-09-01' }] }),
    ]);
    const list = await drive.listBackups('folder');
    expect(list.map((f) => f.fileId)).toEqual(['a', 'b']);
    expect(list[0]?.sizeBytes).toBe(5);
  });

  it('refuses files over the size limit before downloading', async () => {
    const { drive, calls } = client([() => json(200, {})]);
    await expect(drive.download({ ...meta, size: 999 }, 100)).rejects.toBeInstanceOf(BackupTooLarge);
    expect(calls).toHaveLength(0);
  });

  it('aborts a stream that grows past the limit (size metadata can lie)', async () => {
    const { drive } = client([() => new Response('x'.repeat(200), { status: 200 })]);
    await expect(drive.download({ ...meta, size: 1 }, 100)).rejects.toBeInstanceOf(BackupTooLarge);
  });
});
