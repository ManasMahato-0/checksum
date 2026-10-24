import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev the API runs separately (`npm run dev` in the repo root, :3000); proxy its routes.
// In production Express serves web/dist itself, so the same relative URLs work.
const api = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/accounts': api, '/categories': api, '/health': api },
  },
});
