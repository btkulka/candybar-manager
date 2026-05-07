import { JobDefinition } from '../types';
import { checkLibrary, checkLibraryFromTracks, spotifyTracksToTrackRecords, CheckResult } from '../../musicLibraryCheck';
import { getPlaylistTracks, SpotifyCredentials } from '../../spotify';

type CheckParams = {
  libraryRoot: string;
  csvPath?: string;
  spotifyPlaylistUrl?: string;
  spotifyCredentials?: SpotifyCredentials;
  contextKey: string;
};

export const libraryCheckJob: JobDefinition<CheckParams, CheckResult> = {
  type: 'library-check',
  dependencies: ['library-file-list'],

  async run(ctx) {
    const { libraryRoot, csvPath, spotifyPlaylistUrl, spotifyCredentials } = ctx.params;
    const fileList = ctx.getSharedResult('library-file-list');

    const onProgress = (progress: { phase: string; current: number; total: number; message: string }) => {
      ctx.progress({
        phase: progress.phase,
        current: progress.current,
        total: progress.total,
        message: progress.message
      });
    };

    if (spotifyPlaylistUrl && spotifyCredentials) {
      // Spotify playlist source
      ctx.progress({ phase: 'playlist', current: 0, total: 1, message: 'Fetching Spotify playlist...' });

      const { playlist, tracks } = await getPlaylistTracks(
        spotifyPlaylistUrl,
        spotifyCredentials,
        (loaded, total) => {
          ctx.progress({ phase: 'playlist', current: loaded, total, message: `Fetching playlist: ${loaded}/${total} tracks` });
        }
      );

      ctx.progress({ phase: 'playlist', current: 1, total: 1, message: `Loaded ${tracks.length} tracks from "${playlist.name}"` });

      const trackRecords = spotifyTracksToTrackRecords(tracks);

      return checkLibraryFromTracks({
        libraryRoot,
        tracks: trackRecords,
        preScannedFiles: fileList?.files,
        onProgress
      });
    }

    if (csvPath) {
      return checkLibrary({
        libraryRoot,
        csvPath,
        preScannedFiles: fileList?.files,
        onProgress
      });
    }

    throw new Error('Either csvPath or spotifyPlaylistUrl must be provided.');
  }
};
