// vite.config.js (ESM)
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // exposes network address
    port: 5173,
    proxy: {
      // Proxy API calls to Flask backend on port 5001
      '/api': {
        target: 'http://127.0.0.1:5001',
        changeOrigin: true,
        secure: false,
      },
      '/stream': {
        target: 'http://127.0.0.1:5001',
        changeOrigin: true,
        ws: true,
        secure: false,
      }
    }
  }
});
