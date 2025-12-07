import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react()],
    define: {
      // SECURITY NOTE: API keys should NOT be embedded in client-side code
      // This is only acceptable for development/demo purposes
      // For production, use one of these approaches:
      // 1. Backend API that handles Gemini calls server-side
      // 2. Environment-specific builds with different keys
      // 3. Runtime configuration from secure storage
      // 
      // Current approach: Embed key at build time (NOT SECURE for production)
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
      'process.env.NODE_ENV': JSON.stringify(mode)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            // Vendor chunks for better caching
            'react-vendor': ['react', 'react-dom'],
            'chart-vendor': ['recharts'],
            'google-ai': ['@google/genai'],
          }
        }
      },
      chunkSizeWarningLimit: 600, // Increase limit slightly since we're splitting
    }
  };
});
