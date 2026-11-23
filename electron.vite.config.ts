import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

// externalizeDepsPlugin leaves package.json "dependencies" as require()s and
// inlines everything else, so the shared @btkulka/* packages (devDependencies)
// end up bundled in dist/main. Keep them out of "dependencies": the .dmg can't
// ship file: links (see CLAUDE.md).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'src/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    }
  }
});
