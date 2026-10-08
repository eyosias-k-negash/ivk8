import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalyticsEnvelope, BackupFile, DriveFolder, Me } from '@ivy/contracts';
import { analyticsQuery, api } from './client';
import { useParams } from '../state/params';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });

export const useFolders = (q: string) =>
  useQuery({ queryKey: ['folders', q], queryFn: () => api<DriveFolder[]>(`/drive/folders?q=${encodeURIComponent(q)}`) });

export function useSetFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) => api('/drive/folder', { method: 'PUT', body: JSON.stringify({ folderId }) }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export const useBackups = () => useQuery({ queryKey: ['backups'], queryFn: () => api<BackupFile[]>('/backups') });

/** Any analytics report for one backup. Changing tz/overrides changes the key => instant refetch. */
export function useReport<T>(fileId: string, report: string, extra: Record<string, string | undefined> = {}, enabled = true) {
  const params = useParams();
  const qs = analyticsQuery(params, extra);
  return useQuery({
    queryKey: ['report', fileId, report, qs],
    queryFn: () => api<AnalyticsEnvelope<T>>(`/backups/${encodeURIComponent(fileId)}/${report}?${qs}`),
    placeholderData: (prev) => prev,
    enabled,
  });
}
