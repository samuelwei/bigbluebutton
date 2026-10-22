import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const detailedLogs = process.env.DETAILED_LOGS || false;
const DEV_ENTRY = '/html5client/client/main.tsx';

/** Collect files under dir (relative paths) for gzip. */
function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

function fillEntryUrl(html, entryUrl) {
  return html.replaceAll('__BBB_ENTRY_URL__', entryUrl);
}

/**
 * Classic public/boot.js loads window.__BBB_ENTRY__.
 * Dev: transformIndexHtml fills the Vite ESM path.
 * Prod: JS entry + emit index.html (appType custom) with hashed URL + style.css
 * (cssCodeSplit:false emits style.css but does not inject a link without an HTML entry).
 */
function htmlBootPlugin() {
  const indexPath = path.resolve(__dirname, 'index.html');

  return {
    name: 'bbb-html-boot',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.server) return html;
        return fillEntryUrl(html, DEV_ENTRY);
      },
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (chunk) => chunk.type === 'chunk' && chunk.isEntry,
      );
      if (!entry) {
        this.error('bbb-html-boot: no entry chunk found');
      }

      let html = fillEntryUrl(fs.readFileSync(indexPath, 'utf8'), `./${entry.fileName}`);
      if (!html.includes('href="style.css"')) {
        html = html.replace(
          '</head>',
          '  <link rel="stylesheet" href="style.css" crossorigin="anonymous"/>\n</head>',
        );
      }

      this.emitFile({
        type: 'asset',
        fileName: 'index.html',
        source: html,
      });
    },
  };
}

/** Precompress assets for nginx gzip_static (recursive; prior CompressionPlugin). */
function gzipAssetsPlugin() {
  return {
    name: 'bbb-gzip-assets',
    apply: 'build',
    async writeBundle(outputOptions) {
      const outDir = outputOptions.dir || path.resolve(__dirname, 'dist');
      const entries = listFilesRecursive(outDir);
      await Promise.all(entries.map(async (rel) => {
        if (!/\.(js|css|html|svg)$/i.test(rel)) return;
        if (rel.endsWith('.map') || rel.endsWith('.gz')) return;
        const filePath = path.join(outDir, rel);
        if (!fs.statSync(filePath).isFile()) return;
        const source = fs.readFileSync(filePath);
        if (source.length < 1024) return;
        fs.writeFileSync(`${filePath}.gz`, zlib.gzipSync(source, { level: 9 }));
      }));
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const isBuild = command === 'build';
  const isProd = mode === 'production' || isBuild;

  return {
    // Dev: nginx proxies /html5client/ without stripping. Prod: relative URLs.
    base: isBuild ? './' : '/html5client/',
    publicDir: 'public',
    // Vite 8 / Rolldown "consistent CJS interop": because package.json has
    // "type":"module", default imports from babel-style CJS (__esModule +
    // exports.default) resolve to the whole module.exports object. That breaks
    // react-toggle / react-autosize-textarea (extends / styled(X)). Official
    // escape hatch until those deps ship ESM or we harden call sites:
    // https://vite.dev/guide/migration#consistent-commonjs-interop
    // https://rolldown.rs/in-depth/bundling-cjs#ambiguous-default-import-from-cjs-modules
    legacy: {
      inconsistentCjsInterop: true,
    },
    plugins: [
      react({
        jsxRuntime: 'classic',
        exclude: [/worker\.ts$/],
      }),
      htmlBootPlugin(),
      isBuild && viteStaticCopy({
        targets: [
          { src: 'private', dest: '.' },
        ],
      }),
      isBuild && gzipAssetsPlugin(),
    ].filter(Boolean),
    define: {
      'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
      'process.env.DETAILED_LOGS': JSON.stringify(detailedLogs),
    },
    resolve: {
      extensions: ['.mjs', '.js', '.jsx', '.tsx', '.ts', '.json'],
      alias: {
        '/imports': path.resolve(__dirname, 'imports'),
        '/client': path.resolve(__dirname, 'client'),
        '@tiptap/core/jsx-runtime': path.resolve(
          __dirname,
          'node_modules/@tiptap/core/dist/jsx-runtime/jsx-runtime.js',
        ),
        yjs: path.resolve(__dirname, 'node_modules/yjs'),
      },
    },
    oxc: {
      jsx: {
        runtime: 'classic',
      },
    },
    css: {
      postcss: {
        plugins: [
          autoprefixer({
            overrideBrowserslist: ['last 2 versions', '>1%'],
          }),
        ],
      },
    },
    server: {
      port: 3000,
      strictPort: true,
      host: true,
      // HMR through nginx TLS front door (see bbb-html5.nginx.dev).
      hmr: {
        protocol: 'wss',
        clientPort: Number(process.env.HMR_CLIENT_PORT) || 443,
        path: '/html5client/ws',
      },
      watch: {
        ignored: ['**/node_modules/**', '**/.yalc/**'],
      },
    },
    optimizeDeps: {
      include: ['react-toggle', 'react-autosize-textarea', 'eventemitter2'],
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true,
      cssCodeSplit: false,
      minify: 'oxc',
      assetsInlineLimit: 0,
      rolldownOptions: {
        input: path.resolve(__dirname, 'client/main.tsx'),
        output: {
          format: 'es',
          codeSplitting: false,
          entryFileNames: 'bundle.[hash:20].js',
          chunkFileNames: 'bundle.[hash:20].js',
          assetFileNames: '[name][extname]',
        },
      },
    },
    // JS entry + custom HTML emit in production; SPA index.html in dev.
    appType: isBuild ? 'custom' : 'spa',
  };
});
