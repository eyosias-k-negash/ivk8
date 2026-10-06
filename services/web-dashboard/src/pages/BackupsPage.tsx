import { useBackups } from '../api/hooks';
import { ErrorBox } from '../components/ErrorBox';

/** Flow 2: every backup version in the folder, newest first. */
export function BackupsPage({ folderName, onOpen, onChangeFolder }: { folderName?: string; onOpen: (fileId: string) => void; onChangeFolder: () => void }) {
  const backups = useBackups();
  return (
    <section className="card">
      <div className="row">
        <h2>Backups in “{folderName}”</h2>
        <button className="link" onClick={onChangeFolder}>Change folder</button>
      </div>
      {backups.isLoading && <p className="muted">Loading backups…</p>}
      {backups.error && <ErrorBox error={backups.error} />}
      {backups.data?.length === 0 && <p className="muted">No .zip backups found in this folder.</p>}
      <table className="grid">
        <tbody>
          {backups.data?.map((b, i) => (
            <tr key={b.fileId}>
              <td><button className="link" onClick={() => onOpen(b.fileId)}>{b.name}</button>{i === 0 && <span className="badge live">latest</span>}</td>
              <td>{new Date(b.modifiedTime).toLocaleString()}</td>
              <td className="muted">{(b.sizeBytes / 1024).toFixed(0)} KB</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
