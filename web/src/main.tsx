import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { ApiError } from './lib/api';
import { keys } from './lib/queries';
import { ImportsPage } from './pages/Imports';
import { NotFound } from './pages/NotFound';
import { OverviewPage } from './pages/Overview';
import { TransactionsPage } from './pages/Transactions';
import './styles.css';

// Any 401 means the session ended (expired, signed out elsewhere): drop back to the sign-in screen.
const onError = (e: Error) => {
  if (e instanceof ApiError && e.status === 401) queryClient.setQueryData(keys.me, null);
};

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      // 4xx won't fix itself; network blips and 5xx get one retry.
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 1,
    },
  },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'transactions', element: <TransactionsPage /> },
      { path: 'imports', element: <ImportsPage /> },
      { path: 'imports/:importId', element: <ImportsPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
