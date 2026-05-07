import fs from 'fs/promises';
import path from 'path';
import { AUDIO_EXTENSIONS } from '../../constants';
import { JobDefinition, LibraryFileList } from '../types';

type LibraryScanParams = {
  contextKey: string; // = libraryRoot
};

export const libraryScanJob: JobDefinition<LibraryScanParams, LibraryFileList> = {
  type: 'library-scan',
  dependencies: [],
  producesSharedResult: 'library-file-list',

  async run(ctx) {
    const libraryRoot = ctx.params.contextKey;

    ctx.progress({ phase: 'discovering', current: 0, total: 0, message: 'Discovering audio files...' });

    const files: string[] = [];
    const stack = [libraryRoot];

    while (stack.length > 0) {
      if (ctx.signal.aborted) throw new Error('Cancelled');

      const dir = stack.pop()!;
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // Skip unreadable directories
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          stack.push(fullPath);
        } else if (entry.isFile() && !entry.name.startsWith('.')) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTENSIONS.has(ext)) {
            files.push(fullPath);
            if (files.length % 100 === 0) {
              ctx.progress({
                phase: 'discovering',
                current: files.length,
                total: 0,
                message: `Found ${files.length} audio files...`
              });
            }
          }
        }
      }
    }

    ctx.progress({
      phase: 'complete',
      current: files.length,
      total: files.length,
      message: `Discovered ${files.length} audio files`
    });

    return {
      libraryRoot,
      files,
      discoveredAt: Date.now()
    };
  }
};
