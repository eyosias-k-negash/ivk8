import { ApiFailure } from '../api/client';

/** Turns API errors into user-facing guidance (flow 1: tell the user to reconnect). */
export function ErrorBox({ error }: { error: unknown }) {
  if (error instanceof ApiFailure) {
    if (error.code === 'REAUTH_REQUIRED' || error.code === 'UNAUTHENTICATED')
      return (
        <div className="callout warn">
          {error.message} <a href="/api/auth/login">Reconnect Google Drive</a>
        </div>
      );
    if (error.code === 'NOT_IMPLEMENTED') return <div className="callout muted">Coming soon: {error.message}</div>;
    return (
      <div className="callout error">
        {error.message}
        {error.details?.length ? <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul> : null}
      </div>
    );
  }
  return <div className="callout error">Something went wrong.</div>;
}
