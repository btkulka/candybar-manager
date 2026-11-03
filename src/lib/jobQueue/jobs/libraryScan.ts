import { walkAudioDir } from '../../fileUtils';
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

    // The shared walker resolves DT_UNKNOWN dirents (exFAT/network mounts),
    // skips this app's temp files, and stops when the job is cancelled.
    const files = await walkAudioDir(libraryRoot, {
      signal: ctx.signal,
      onProgress: (count) => ctx.progress({
        phase: 'discovering',
        current: count,
        total: 0,
        message: `Found ${count} audio files...`
      })
    });

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
