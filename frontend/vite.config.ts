import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    root: __dirname,
    publicDir: path.resolve(__dirname, 'public'),
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
            // Removed @shared alias - shared code is now in src/shared/
        },
    },
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/ws': {
                target: 'ws://localhost:3000',
                ws: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor: ['react', 'react-dom'],
                    charts: ['recharts'],
                    motion: ['framer-motion'],
                },
            },
        },
    },
    optimizeDeps: {
        // Removed @hypothesis-arena/shared - now using local shared code
    },
});
