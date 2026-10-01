import { describe, it, expect } from 'vitest';
import { SessionCodec } from '../src/auth/session';

const codec = new SessionCodec('x'.repeat(32));

describe('SessionCodec', () => {
  it('round-trips', () => {
    expect(codec.open(codec.seal({ sub: 'u1', folderId: 'f' }))).toEqual({ sub: 'u1', folderId: 'f' });
  });
  it('does not leak plaintext into the cookie', () => {
    expect(codec.seal({ refreshToken: 'super-secret-token' })).not.toContain('super-secret');
  });
  it('returns an empty session for tampered or foreign cookies', () => {
    const t = codec.seal({ sub: 'u1' });
    const flipped = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
    expect(codec.open(flipped)).toEqual({});
    expect(new SessionCodec('y'.repeat(32)).open(t)).toEqual({});
    expect(codec.open('garbage')).toEqual({});
  });
});
