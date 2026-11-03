import { JobDefinition } from '../types';
import { scanMissingAlbumArt, AlbumArtMissingTrack } from '../../albumArtScan';

type AlbumArtScanParams = {
  libraryRoot: string;
  contextKey: string;
};

export const albumArtScanJob: JobDefinition<AlbumArtScanParams, AlbumArtMissingTrack[]> = {
  type: 'album-art-scan',
  dependencies: ['library-file-list'],

  async run(ctx) {
    const { libraryRoot } = ctx.params;
    const fileList = ctx.getSharedResult('library-file-list');

    const result = await scanMissingAlbumArt(
      libraryRoot,
      (progress) => {
        ctx.progress({
          phase: progress.phase,
          current: progress.current,
          total: progress.total,
          message: `${progress.phase}: ${progress.current}/${progress.total}`,
          detail: progress.filePath
        });
      },
      fileList?.files,
      ctx.signal
    );

    return result;
  }
};
