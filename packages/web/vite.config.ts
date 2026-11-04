import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the Vite server forwards WebSocket and API traffic to the Duet server.
const server = process.env.DUET_SERVER ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: server, ws: true },
      '/api': server,
    },
  },
});
