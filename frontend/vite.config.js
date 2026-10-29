import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Everything under /api is proxied to the backend (so there is no CORS to configure).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
