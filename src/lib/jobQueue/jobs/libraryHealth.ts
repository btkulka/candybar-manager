import { JobDefinition } from '../types';
import { scanLibraryHealth, LibraryHealthResult } from '../../libraryHealthScan';

type HealthParams = {
  libraryRoot: string;
  contextKey: string;
};

export const libraryHealthJob: JobDefinition<HealthParams, LibraryHealthResult> = {
  type: 'library-health',
  dependencies: ['library-file-list'],

  async run(ctx) {
    const { libraryRoot } = ctx.params;
    const fileList = ctx.getSharedResult('library-file-list');

    const result = await scanLibraryHealth({
      libraryRoot,
      preScannedFiles: fileList?.files,
      onProgress: (progress) => {
        ctx.progress({
          phase: progress.phase,
          current: progress.current,
          total: progress.total,
          message: `${progress.phase}: ${progress.current}/${progress.total}`,
          detail: progress.track
        });
      }
    });

    return result;
  }
};
