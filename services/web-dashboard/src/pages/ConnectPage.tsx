/** Flow 1: sign in with Google and grant read-only Drive access. */
export function ConnectPage() {
  const authError = new URLSearchParams(window.location.search).get('authError');
  return (
    <section className="card narrow">
      <h1>Your Ivy Wallet, analysed</h1>
      <p>
        Sign in with Google and pick the Drive folder that holds your Ivy Wallet backups. Access is
        <strong> read-only</strong>: this app can never change or delete anything in your Drive, and your
        data is never stored.
      </p>
      {authError && <div className="callout warn">Sign-in did not complete ({authError}). Please try again.</div>}
      <a className="button" href="/api/auth/login">Sign in with Google</a>
    </section>
  );
}
