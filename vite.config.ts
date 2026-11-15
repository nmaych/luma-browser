import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const PROD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; media-src 'self' https: http:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
const DEV_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' ws: http://127.0.0.1:* http://localhost:*; media-src 'self' https: http:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

function cspPlugin(): Plugin {
  return {
    name: 'luma-csp',
    transformIndexHtml(html, context) {
      const content = context.server ? DEV_CSP : PROD_CSP;
      return {
        html,
        tags: [{
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content },
          injectTo: 'head-prepend',
        }],
      };
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
  preview: {
    port: 4173,
  },
  test: {
    testTimeout: 15000,
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    css: true,
  },
});
