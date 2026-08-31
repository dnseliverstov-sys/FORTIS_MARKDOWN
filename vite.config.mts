import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(projectRoot, 'renderer');
const urlShim = path.resolve(projectRoot, 'node_modules/url/url.js');
const katexVirtualId = 'virtual:fortis-katex-export';
const resolvedKatexVirtualId = `\0${katexVirtualId}`;

function selfContainedKatexPlugin() {
  return {
    name: 'fortis-self-contained-katex',
    enforce: 'pre' as const,
    resolveId(id: string) {
      return id === katexVirtualId ? resolvedKatexVirtualId : undefined;
    },
    load(id: string) {
      if (id !== resolvedKatexVirtualId) return undefined;
      const dist = path.resolve(projectRoot, 'node_modules/katex/dist');
      const css = fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8').replace(
        /url\((?:\.\/)?fonts\/([A-Za-z0-9_-]+\.woff2)\)/gu,
        (_match, name: string) => {
          const bytes = fs.readFileSync(path.join(dist, 'fonts', name));
          return `url(data:font/woff2;base64,${bytes.toString('base64')})`;
        },
      );
      return `export default ${JSON.stringify(css)};`;
    },
  };
}

export default defineConfig({
  root,
  base: './',
  plugins: [selfContainedKatexPlugin(), react()],
  resolve: {
    alias: [
      {find: /^fs$/u, replacement: path.resolve(root, 'src/shims/fs.ts')},
      {find: /^node:fs$/u, replacement: path.resolve(root, 'src/shims/fs.ts')},
      {find: /^path$/u, replacement: 'path-browserify'},
      {find: /^process$/u, replacement: 'process/browser'},
      {find: /^url$/u, replacement: urlShim},
      {find: /^node:url$/u, replacement: urlShim},
    ],
  },
  define: {
    'process.env': '{}',
    global: 'globalThis',
  },
  build: {
    outDir: path.resolve(projectRoot, 'app'),
    emptyOutDir: false,
    sourcemap: false,
    target: 'chrome132',
    rollupOptions: {
      output: {
        entryFileNames: 'renderer-assets/[name]-[hash].js',
        chunkFileNames: 'renderer-assets/[name]-[hash].js',
        assetFileNames: 'renderer-assets/[name]-[hash][extname]',
        manualChunks(id) {
          if (id.includes('mermaid')) return 'mermaid';
          if (id.includes('@gravity-ui/markdown-editor') || id.includes('prosemirror') || id.includes('codemirror')) return 'gravity-editor';
          if (id.includes('katex') || id.includes('latex-extension')) return 'math';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['./src/**/*.test.ts', './src/**/*.test.tsx'],
  },
});
