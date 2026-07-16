import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { parseFile, type IAudioMetadata } from 'music-metadata';
import NodeID3 from 'node-id3';
import { checkTrackHealth } from './trackHealthCheck';
import { AUDIO_EXTENSIONS, METADATA_CONCURRENCY } from './constants';
import { createScopedLogger } from './logger';
import { safeMove } from './fileUtils';
import { recordWrite, statBytes } from './writeJournal';
import { safeDelete } from './safeDelete';
import type { TrackHealth, TrackInfo, UpdateTagsParams, ScanProgress } from '../types';
export type { TrackHealth, TrackInfo, UpdateTagsParams, ScanProgress };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static');

const log = createScopedLogger('TrackScanner');

function extractAlbumArt(metadata: IAudioMetadata): string | null {
  const picture = metadata.common.picture?.[0];
  if (!picture) return null;

  const base64 = Buffer.from(picture.data).toString('base64');
  return `data:${picture.format};base64,${base64}`;
}

async function collectAudioFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectAudioFiles(fullPath));
    } else if (entry.isFile() && !entry.name.startsWith('.')) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function flattenAndClean(sourceDir: string): Promise<{ flattened: number; removed: number }> {
  let flattened = 0;
  let removed = 0;

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(sourceDir, entry.name);

    if (entry.isDirectory()) {
      // Recursively collect audio files from subdirectory
      const audioFiles = await collectAudioFiles(fullPath);
      for (const audioFile of audioFiles) {
        const fileName = path.basename(audioFile);
        let destName = fileName;
        let destPath = path.join(sourceDir, destName);

        // Handle name collisions by appending a suffix
        let counter = 1;
        while (true) {
          try {
            await fs.access(destPath);
            // File exists — try a different name
            const ext = path.extname(fileName);
            const base = path.basename(fileName, ext);
            destName = `${base} (${counter})${ext}`;
            destPath = path.join(sourceDir, destName);
            counter++;
          } catch {
            break; // Doesn't exist — use this name
          }
        }

        await safeMove(audioFile, destPath, 'scan-flatten');
        flattened++;
      }

      // Trash the residual (post-extraction) subdirectory tree rather than a
      // permanent recursive rm, so any unsupported/ancillary files are recoverable.
      await safeDelete(fullPath, { context: 'scan-flatten', recursive: true, detail: { recursive: true } });
      removed++;
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext) || entry.name.startsWith('.')) {
        await safeDelete(fullPath, { context: 'scan-flatten' });
        removed++;
      }
    }
  }

  return { flattened, removed };
}

export async function scanTracks(
  sourceDir: string,
  onProgress?: (payload: ScanProgress) => void
): Promise<TrackInfo[]> {
  const sourceStat = await fs.stat(sourceDir);
  if (!sourceStat.isDirectory()) {
    throw new Error('Source must be a directory.');
  }

  onProgress?.({ phase: 'flattening', current: 0, total: 0 });

  // Flatten subdirectories: move all audio files to root, remove everything else
  const { flattened, removed } = await flattenAndClean(sourceDir);
  if (flattened > 0 || removed > 0) {
    log.info(`Flattened ${flattened} audio files, removed ${removed} non-audio items from source`);
  }

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const audioEntries = entries.filter(
    (e) => e.isFile() && !e.name.startsWith('.') && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())
  );
  const tracks: TrackInfo[] = [];

  onProgress?.({ phase: 'scanning', current: 0, total: audioEntries.length });

  async function processEntry(entry: (typeof audioEntries)[number]): Promise<TrackInfo> {
    const ext = path.extname(entry.name).toLowerCase();
    const filePath = path.join(sourceDir, entry.name);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let title = '';
    let artist = '';
    let album = '';
    let year = '';
    let genre = '';
    let label = '';
    let key = '';
    let bpm = '';
    let remixer = '';
    let comment = '';
    let albumArt: string | null = null;

    // Run metadata parse and health check concurrently
    const [metadataResult, healthResult] = await Promise.all([
      parseFile(filePath, { duration: false }).catch((err) => {
        log.warn(`Metadata read failed for ${entry.name}:`, err);
        return null;
      }),
      checkTrackHealth(filePath)
    ]);

    if (metadataResult) {
      title = metadataResult.common.title || '';
      artist = metadataResult.common.artist || metadataResult.common.artists?.[0] || '';
      album = metadataResult.common.album || '';
      year = metadataResult.common.year?.toString() || '';
      genre = metadataResult.common.genre?.[0] || '';
      label = metadataResult.common.label?.[0] || '';
      key = (metadataResult.common as unknown as Record<string, string>).key || '';
      bpm = metadataResult.common.bpm?.toString() || '';
      remixer = (metadataResult.common as unknown as Record<string, string>).remixedBy || '';
      const commentEntry = metadataResult.common.comment?.[0];
      comment = typeof commentEntry === 'string' ? commentEntry : commentEntry?.text || '';
      albumArt = extractAlbumArt(metadataResult);
    }

    const health: TrackHealth = {
      isHealthy: healthResult.isHealthy,
      issues: healthResult.issues,
      format: healthResult.format
    };

    return {
      id,
      filePath,
      fileName: entry.name,
      title: title || path.basename(entry.name, ext),
      artist,
      album,
      year,
      genre,
      label,
      key,
      bpm,
      remixer,
      comment,
      albumArt,
      hasArtist: !!artist,
      ignored: false,
      status: 'pending',
      health
    };
  }

  let processed = 0;
  for (let i = 0; i < audioEntries.length; i += METADATA_CONCURRENCY) {
    const batch = audioEntries.slice(i, i + METADATA_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const result = await processEntry(entry);
        processed++;
        onProgress?.({
          phase: 'scanning',
          current: processed,
          total: audioEntries.length,
          filePath: result.filePath
        });
        return result;
      })
    );
    tracks.push(...batchResults);
  }

  onProgress?.({ phase: 'done', current: tracks.length, total: tracks.length });

  return tracks;
}

export async function updateTags(params: UpdateTagsParams): Promise<TrackInfo> {
  const { filePath } = params;
  const fileExt = path.extname(filePath).toLowerCase();
  let finalPath = filePath;
  const preWriteBytes = await statBytes(filePath);

  if (fileExt === '.mp3') {
    updateTagsNodeID3(params);
  } else if (['.wav', '.aiff', '.aif', '.flac', '.m4a'].includes(fileExt)) {
    finalPath = await updateTagsFfmpeg(params);
  } else {
    throw new Error(`Tag writing is not supported for ${fileExt} files`);
  }

  recordWrite({
    op: 'tag-write',
    src: filePath,
    dest: finalPath !== filePath ? finalPath : undefined,
    bytes: preWriteBytes,
    outcome: 'ok',
    // Field names only — values (esp. base64 album art) would bloat the journal.
    detail: { fields: Object.keys(params).filter((k) => k !== 'filePath' && params[k as keyof UpdateTagsParams] !== undefined) },
  });

  const ext = path.extname(finalPath).toLowerCase();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Re-read the file to get canonical post-write values. If the re-parse
  // fails (e.g. music-metadata rejects a chunk ffmpeg produced), we fall
  // back to the input params. The write itself already succeeded.
  let updatedMetadata: IAudioMetadata;
  try {
    updatedMetadata = await parseFile(finalPath, { duration: false });
  } catch (err) {
    log.warn('updateTags: post-write re-parse failed, returning params fallback:', {
      file: path.basename(finalPath),
      ext,
      error: err instanceof Error ? err.message : String(err),
    });
    const paramArtist = params.artist || '';
    return {
      id,
      filePath: finalPath,
      fileName: path.basename(finalPath),
      title: params.title || path.basename(finalPath, ext),
      artist: paramArtist,
      album: params.album || '',
      year: params.year || '',
      genre: params.genre || '',
      label: params.label || '',
      key: params.key || '',
      bpm: params.bpm || '',
      remixer: params.remixer || '',
      comment: params.comment || '',
      albumArt: params.albumArt ?? null,
      hasArtist: !!paramArtist,
      ignored: false,
      status: 'pending',
    };
  }

  const updatedArtist =
    updatedMetadata.common.artist || updatedMetadata.common.artists?.[0] || '';

  return {
    id,
    filePath: finalPath,
    fileName: path.basename(finalPath),
    title: updatedMetadata.common.title || path.basename(finalPath, ext),
    artist: updatedArtist,
    album: updatedMetadata.common.album || '',
    year: updatedMetadata.common.year?.toString() || '',
    genre: updatedMetadata.common.genre?.[0] || '',
    label: updatedMetadata.common.label?.[0] || '',
    key: (updatedMetadata.common as unknown as Record<string, string>).key || '',
    bpm: updatedMetadata.common.bpm?.toString() || '',
    remixer: (updatedMetadata.common as unknown as Record<string, string>).remixedBy || '',
    comment: (() => { const c = updatedMetadata.common.comment?.[0]; return typeof c === 'string' ? c : c?.text || ''; })(),
    albumArt: extractAlbumArt(updatedMetadata),
    hasArtist: !!updatedArtist,
    ignored: false,
    status: 'pending'
  };
}

/** Write tags to MP3 files using node-id3 */
function updateTagsNodeID3({ filePath, title, artist, album, year, genre, label, key, bpm, remixer, comment, albumArt }: UpdateTagsParams): void {
  const tags: NodeID3.Tags = {};

  if (title !== undefined) tags.title = title;
  if (artist !== undefined) tags.artist = artist;
  if (album !== undefined) tags.album = album;
  if (year !== undefined) tags.year = year;
  if (genre !== undefined) tags.genre = genre;
  if (label !== undefined) tags.publisher = label;
  if (key !== undefined) tags.initialKey = key;
  if (bpm !== undefined) tags.bpm = bpm;
  if (remixer !== undefined) tags.remixArtist = remixer;
  if (comment !== undefined) tags.comment = { language: 'eng', text: comment };

  if (albumArt !== undefined) {
    const matches = albumArt.match(/^data:image\/(\w+);base64,(.+)$/);
    if (matches) {
      const imageBuffer = Buffer.from(matches[2], 'base64');
      tags.image = {
        mime: `image/${matches[1]}` as 'image/png' | 'image/jpeg',
        type: { id: 3, name: 'front cover' },
        description: 'Album Art',
        imageBuffer
      };
    }
  }

  const success = NodeID3.update(tags, filePath);
  if (!success) {
    throw new Error('Failed to write ID3 tags');
  }
}

/** Write tags to WAV/AIFF/FLAC/M4A files using ffmpeg. Returns the final file path (may differ for WAV/FLAC→AIFF conversion). */
async function updateTagsFfmpeg(params: UpdateTagsParams): Promise<string> {
  const { filePath, title, artist, album, year, genre, label, key, bpm, remixer, comment, albumArt } = params;
  const ext = path.extname(filePath).toLowerCase();
  // WAV and FLAC are both converted to AIFF for reliable tag support + consistent DJ-tool compatibility.
  const outputExt = (ext === '.wav' || ext === '.flac') ? '.aiff' : ext;
  const tempPath = filePath.replace(/(\.[^.]+)$/, `_tagtmp${outputExt}`);
  const finalPath = outputExt !== ext
    ? filePath.slice(0, filePath.length - ext.length) + outputExt
    : filePath;

  // Guard: converting to a new extension must not overwrite a DIFFERENT existing
  // file already at finalPath (e.g. an existing Track.aiff when tagging Track.wav),
  // which would then be followed by deleting the source — permanent loss.
  if (finalPath !== filePath) {
    const existing = await fs.stat(finalPath).catch(() => null);
    if (existing) {
      const src = await fs.stat(filePath).catch(() => null);
      const sameFile = src && existing.ino === src.ino && existing.dev === src.dev;
      if (!sameFile) {
        throw new Error(`Cannot convert ${path.basename(filePath)} to ${outputExt}: a different file already exists at ${path.basename(finalPath)}`);
      }
    }
  }

  const args = ['-i', filePath];

  // If album art is provided, add it as a second input
  let artTempPath: string | null = null;
  if (albumArt !== undefined) {
    const matches = albumArt.match(/^data:image\/(\w+);base64,(.+)$/);
    if (matches) {
      artTempPath = filePath.replace(/(\.[^.]+)$/, `_art.${matches[1]}`);
      await fs.writeFile(artTempPath, Buffer.from(matches[2], 'base64'));
      args.push('-i', artTempPath);
    }
  }

  // When no new art is supplied, detect whether the source already carries
  // embedded cover art so we can preserve it — mapping only 0:a would drop it.
  let hasEmbeddedArt = false;
  if (!artTempPath) {
    try {
      const meta = await parseFile(filePath, { duration: false });
      hasEmbeddedArt = Boolean(meta.common.picture && meta.common.picture.length);
    } catch { /* ignore — treat as no embedded art */ }
  }

  // Audio stream handling:
  //  - WAV → AIFF: WAV is little-endian PCM, AIFF is big-endian. `-c:a copy`
  //    leaves the samples byte-swapped and produces static; we must transcode
  //    to pcm_sXXbe at the source bit depth.
  //  - FLAC → AIFF: decode compressed stream + re-encode to big-endian PCM.
  //  - Same-format rewrites: copy.
  let audioCodec: string = 'copy';
  if ((ext === '.flac' || ext === '.wav') && outputExt === '.aiff') {
    let bits = 16;
    try {
      const srcMeta = await parseFile(filePath, { duration: false, skipCovers: true });
      bits = srcMeta.format?.bitsPerSample || 16;
    } catch { /* fall back to 16-bit */ }
    audioCodec = bits >= 32 ? 'pcm_s32be' : bits >= 24 ? 'pcm_s24be' : 'pcm_s16be';
  }
  args.push('-map', '0:a', '-c:a', audioCodec, '-map_metadata', '0');

  // Attach album art if provided. All supported containers (FLAC, M4A,
  // AIFF) carry cover art as an attached_pic video stream; the muxer
  // handles encoding it into the right container-specific chunk.
  if (artTempPath) {
    args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
    // ID3v2 APIC frames want a title/comment tag on the attached picture stream.
    args.push('-metadata:s:v:0', 'title=Album cover');
    args.push('-metadata:s:v:0', 'comment=Cover (front)');
  } else if (hasEmbeddedArt) {
    // Preserve the source's existing embedded cover art instead of dropping it.
    args.push('-map', '0:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  }

  // Add metadata flags
  if (title !== undefined) args.push('-metadata', `title=${title}`);
  if (artist !== undefined) args.push('-metadata', `artist=${artist}`);
  if (album !== undefined) args.push('-metadata', `album=${album}`);
  if (year !== undefined) args.push('-metadata', `date=${year}`);
  if (genre !== undefined) args.push('-metadata', `genre=${genre}`);
  if (label !== undefined) args.push('-metadata', `publisher=${label}`);
  if (key !== undefined) args.push('-metadata', `initialkey=${key}`);
  if (bpm !== undefined) args.push('-metadata', `bpm=${bpm}`);
  if (remixer !== undefined) args.push('-metadata', `remixer=${remixer}`);
  if (comment !== undefined) args.push('-metadata', `comment=${comment}`);

  // Format-specific flags
  if (outputExt === '.aiff' || outputExt === '.aif') {
    // Force ID3v2.3 — AIFF embedded-ID3 readers (music-metadata, many
    // DJ tools) handle v2.3 more consistently than ffmpeg's default v2.4.
    args.push('-write_id3v2', '1', '-id3v2_version', '3');
  }
  if (ext === '.m4a') {
    args.push('-movflags', '+faststart');
  }

  args.push('-y', tempPath);

  log.info('Writing tags via ffmpeg:', path.basename(filePath), ext !== outputExt ? `(converting to ${outputExt})` : '');

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, args);
      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.on('error', (err) => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));
      proc.on('close', (code) => {
        if (code === 0) { resolve(); return; }
        // Detect the specific AIFC header corruption we know how to repair,
        // so the renderer can offer a fix-and-retry. Prefix on the message
        // is the contract with the UI layer (custom error props don't
        // survive Electron IPC).
        if (/could not find COMM tag or invalid block_align value/i.test(stderr)) {
          reject(new Error(`AIFC_CORRUPT_HEADER: ${filePath}`));
          return;
        }
        reject(new Error(`ffmpeg tag write failed (code ${code}): ${stderr.split('\n').filter(l => l.includes('Error') || l.includes('error')).join('; ') || stderr.slice(-200)}`));
      });
    });

    await fs.rename(tempPath, finalPath);
    // Remove original WAV/FLAC after successful conversion to AIFF (recoverable via Trash).
    if (ext !== outputExt) {
      try {
        await safeDelete(filePath, { context: 'tag-write-convert', detail: { convertedTo: finalPath } });
      } catch (err) {
        // Best-effort — safeDelete already journaled the failure; both files now exist.
        log.warn('Failed to remove original after tag-write conversion:', filePath, err);
      }
    }
  } finally {
    // Clean up temp files even if ffmpeg or rename fails
    await fs.unlink(tempPath).catch(() => {});
    if (artTempPath) {
      await fs.unlink(artTempPath).catch(() => {});
    }
  }

  return finalPath;
}

export async function getAlbumArtFromFile(imagePath: string): Promise<string> {
  const buffer = await fs.readFile(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}
