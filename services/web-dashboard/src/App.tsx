import { useEffect, useState } from 'react';
import { useLogout, useMe } from './api/hooks';
import { ConnectPage } from './pages/ConnectPage';
import { FolderPicker } from './pages/FolderPicker';
import { BackupsPage } from './pages/BackupsPage';
import { BackupView } from './pages/BackupView';
import { ErrorBox } from './components/ErrorBox';

/** Tiny hash router: #/ (backups list) and #/backup/<fileId>. No router dependency needed. */
function useHashRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (window.location.hash = r)];
}

export function App() {
  const me = useMe();
  const logout = useLogout();
  const [route, go] = useHashRoute();
  const [changeFolder, setChangeFolder] = useState(false);

  let body;
  if (me.isLoading) body = <p className="muted">Loading…</p>;
  else if (me.error) body = <ErrorBox error={me.error} />;
  else if (!me.data?.signedIn) body = <ConnectPage />;
  else if (!me.data.folderId || changeFolder) body = <FolderPicker onDone={() => setChangeFolder(false)} />;
  else if (route.startsWith('/backup/')) body = <BackupView fileId={decodeURIComponent(route.slice(8))} onBack={() => go('/')} />;
  else body = <BackupsPage folderName={me.data.folderName} onOpen={(id) => go(`/backup/${encodeURIComponent(id)}`)} onChangeFolder={() => setChangeFolder(true)} />;

  return (
    <div className="app">
      <header className="topbar">
        <strong>Ivy Wallet Plus</strong>
        {me.data?.signedIn && (
          <span className="user">
            {me.data.email}
            <button className="link" onClick={() => logout.mutate()}>Sign out</button>
          </span>
        )}
      </header>
      <main>{body}</main>
    </div>
  );
}
