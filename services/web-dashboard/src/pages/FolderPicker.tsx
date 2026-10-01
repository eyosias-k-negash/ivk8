import { useState } from 'react';
import { useFolders, useSetFolder } from '../api/hooks';
import { ErrorBox } from '../components/ErrorBox';

/** Flow 1 (cont.): choose the folder that holds the backups. */
export function FolderPicker({ onDone }: { onDone: () => void }) {
  const [q, setQ] = useState('ivy');
  const folders = useFolders(q);
  const setFolder = useSetFolder();
  return (
    <section className="card narrow">
      <h2>Choose your backup folder</h2>
      <input className="filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search folders by name" />
      {folders.error && <ErrorBox error={folders.error} />}
      {setFolder.error && <ErrorBox error={setFolder.error} />}
      <ul className="list">
        {folders.data?.map((f) => (
          <li key={f.id}>
            <button className="link" onClick={() => setFolder.mutate(f.id, { onSuccess: onDone })}>{f.name}</button>
          </li>
        ))}
        {folders.data?.length === 0 && <li className="muted">No folders match.</li>}
      </ul>
    </section>
  );
}
