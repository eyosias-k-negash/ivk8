import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ParamsProvider } from './state/params';
import { ApiFailure } from './api/client';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // Don't hammer the API on errors the user must fix (sign-in, folder, not implemented).
      retry: (count, err) => !(err instanceof ApiFailure && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ParamsProvider>
        <App />
      </ParamsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
