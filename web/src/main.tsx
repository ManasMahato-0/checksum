import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { AccountProvider } from './lib/account';
import { ImportsPage } from './pages/Imports';
import { NotFound } from './pages/NotFound';
import { OverviewPage } from './pages/Overview';
import { TransactionsPage } from './pages/Transactions';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: true, retry: 1 },
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
      <AccountProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AccountProvider>
    </QueryClientProvider>
  </StrictMode>,
);
