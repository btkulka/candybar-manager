import * as mm from 'music-metadata';
import fs from 'fs';
import path from 'path';
import { createScopedLogger } from './logger';
import { checkAiffIntegrity } from './audioIntegrityCheck';
import type { SuggestedAction, HealthIssue, HealthSummary } from '../types';

const log = createScopedLogger('TrackHealth');

// XDJ-RX3 / CDJ compatibility requirements
const SUPPORTED_CONTAINERS = ['WAVE', 'AIFF', 'MPEG', 'MP4']; // MP4 for AAC
const SUPPORTED_CODECS = ['PCM', 'MP3', 'AAC'];
const SUPPORTED_SAMPLE_RATES = [32000, 44100, 48000];
const SUPPORTED_BIT_DEPTHS = [16, 24]; // For lossless formats
const MIN_SAMPLE_RATE = 32000; // Hz - below this is too low
const MAX_BIT_RATE = 320; // kbps for lossy formats
const MIN_BIT_RATE = 32; // kbps

export type { SuggestedAction, HealthIssue, HealthSummary };

export type TrackHealth = {
  filePath: string;
  fileName: string;
  artist: string;
  title: string;
  album: string;
  year: number | null;
  genre: string;
  hasAlbumArt: boolean;
  isHealthy: boolean;
  issues: HealthIssue[];
  dateAdded: number | null;
  format: {
    container: string | null;
    codec: string | null;
    sampleRate: number | null;
    bitDepth: number | null;
    bitRate: number | null;
    channels: number | null;
    duration: number | null;
    lossless: boolean | null;
  };
};

export async function checkTrackHealth(filePath: string): Promise<TrackHealth> {
  const fileName = path.basename(filePath);
  const issues: HealthIssue[] = [];

  const health: TrackHealth = {
    filePath,
    fileName,
    artist: '',
    title: '',
    album: '',
    year: null,
    genre: '',
    hasAlbumArt: false,
    dateAdded: null,
    isHealthy: true,
    issues: [],
    format: {
      container: null,
      codec: null,
      sampleRate: null,
      bitDepth: null,
      bitRate: null,
      channels: null,
      duration: null,
      lossless: null
    }
  };

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    issues.push({
      code: 'FILE_NOT_FOUND',
      severity: 'error',
      message: 'File not found',
      detail: filePath,
      suggestedAction: 'delete'
    });
    health.issues = issues;
    health.isHealthy = false;
    return health;
  }

  // Get file birthtime for date added
  try {
    const stat = await fs.promises.stat(filePath);
    health.dateAdded = stat.birthtimeMs;
  } catch { /* ignore */ }

  try {
    const metadata = await mm.parseFile(filePath);
    const fmt = metadata.format;

    // Populate metadata for downstream use (e.g. duplicate detection)
    health.artist = metadata.common.artist || metadata.common.artists?.[0] || '';
    health.title = metadata.common.title || '';
    health.album = metadata.common.album || '';
    health.year = metadata.common.year || null;
    health.genre = metadata.common.genre?.[0] || '';
    health.hasAlbumArt = !!(metadata.common.picture && metadata.common.picture.length > 0);

    // Populate format info
    health.format = {
      container: fmt.container || null,
      codec: fmt.codec || null,
      sampleRate: fmt.sampleRate || null,
      bitDepth: fmt.bitsPerSample || null,
      bitRate: fmt.bitrate ? Math.round(fmt.bitrate / 1000) : null,
      channels: fmt.numberOfChannels || null,
      duration: fmt.duration || null,
      lossless: fmt.lossless ?? null
    };

    // Check container/format support
    const container = fmt.container?.toUpperCase();
    if (!container) {
      issues.push({
        code: 'UNKNOWN_CONTAINER',
        severity: 'error',
        message: 'Unknown file format',
        detail: 'Could not determine audio container type',
        suggestedAction: 'archive'
      });
    } else if (container === 'FLAC') {
      issues.push({
        code: 'UNSUPPORTED_FORMAT',
        severity: 'error',
        message: 'FLAC not supported',
        detail: 'XDJ-RX3 does not support FLAC. Convert to AIFF to preserve quality.',
        suggestedAction: 'convert_aiff'
      });
    } else if (container === 'OGG' || container === 'VORBIS') {
      issues.push({
        code: 'UNSUPPORTED_FORMAT',
        severity: 'error',
        message: 'OGG/Vorbis not supported',
        detail: 'XDJ-RX3 does not support OGG. This is a lossy format — replace with a lossless source.',
        suggestedAction: 'archive'
      });
    } else if (!SUPPORTED_CONTAINERS.includes(container)) {
      const isLossy = fmt.lossless === false;
      issues.push({
        code: 'UNSUPPORTED_FORMAT',
        severity: 'error',
        message: `Unsupported format: ${container}`,
        detail: isLossy
          ? `Unsupported lossy format. Replace with a lossless source for best compatibility.`
          : 'Convert to AIFF for best compatibility.',
        suggestedAction: isLossy ? 'archive' : 'convert_aiff'
      });
    }

    // Check sample rate
    if (fmt.sampleRate && !SUPPORTED_SAMPLE_RATES.includes(fmt.sampleRate)) {
      const isLossy = fmt.lossless === false;
      issues.push({
        code: fmt.sampleRate < MIN_SAMPLE_RATE ? 'LOW_SAMPLE_RATE' : 'INVALID_SAMPLE_RATE',
        severity: 'error',
        message: fmt.sampleRate < MIN_SAMPLE_RATE
          ? `Sample rate too low (${fmt.sampleRate} Hz)`
          : `Invalid sample rate: ${fmt.sampleRate} Hz`,
        detail: isLossy
          ? 'XDJ-RX3 supports 32, 44.1, or 48 kHz only. Re-encode to 320kbps MP3 at 44.1kHz.'
          : 'XDJ-RX3 supports 32, 44.1, or 48 kHz only. Convert to AIFF at 44.1kHz.',
        suggestedAction: isLossy ? 'reencode_mp3' : 'convert_aiff'
      });
    }

    // Check bit depth for lossless formats
    if (fmt.lossless && fmt.bitsPerSample) {
      if (!SUPPORTED_BIT_DEPTHS.includes(fmt.bitsPerSample)) {
        issues.push({
          code: 'INVALID_BIT_DEPTH',
          severity: 'error',
          message: `Invalid bit depth: ${fmt.bitsPerSample}-bit`,
          detail: 'XDJ-RX3 supports 16-bit or 24-bit only. Convert to 24-bit AIFF.',
          suggestedAction: 'convert_aiff'
        });
      }
      // 32-bit float WAV is common from DAWs but not supported
      if (fmt.bitsPerSample === 32) {
        issues.push({
          code: 'BIT_DEPTH_32',
          severity: 'error',
          message: '32-bit audio not supported',
          detail: 'Convert to 24-bit AIFF.',
          suggestedAction: 'convert_aiff'
        });
      }
    }

    // Check bit rate for lossy formats
    if (!fmt.lossless && fmt.bitrate) {
      const kbps = Math.round(fmt.bitrate / 1000);
      if (kbps < MIN_BIT_RATE) {
        issues.push({
          code: 'LOW_BITRATE',
          severity: 'warning',
          message: `Low bitrate: ${kbps} kbps`,
          detail: 'Poor audio quality. Re-encode to 320kbps or find higher quality source.',
          suggestedAction: 'reencode_mp3'
        });
      }
      if (kbps > MAX_BIT_RATE) {
        issues.push({
          code: 'HIGH_BITRATE',
          severity: 'warning',
          message: `High bitrate: ${kbps} kbps`,
          detail: 'May not be supported. Re-encode to standard 320kbps.',
          suggestedAction: 'reencode_mp3'
        });
      }
    }

    // Warn about lossy formats (not lossless) - suggest archiving for quality-conscious users
    if (fmt.lossless === false) {
      const codec = fmt.codec?.toUpperCase() || container;
      issues.push({
        code: 'LOSSY_FORMAT',
        severity: 'warning',
        message: `Lossy format: ${codec}`,
        detail: 'Lossy compression loses audio quality. Consider archiving and replacing with lossless source.',
        suggestedAction: 'archive'
      });
    }

    // Check channels
    if (fmt.numberOfChannels && fmt.numberOfChannels > 2) {
      const isLossy = fmt.lossless === false;
      issues.push({
        code: 'MULTICHANNEL',
        severity: 'error',
        message: `Multichannel audio (${fmt.numberOfChannels} channels)`,
        detail: isLossy
          ? 'XDJ-RX3 only supports stereo (2 channels). Replace with a stereo source.'
          : 'XDJ-RX3 only supports stereo (2 channels). Convert to stereo AIFF.',
        suggestedAction: isLossy ? 'archive' : 'convert_aiff'
      });
    }

    // Check codec for PCM in WAV/AIFF
    if ((container === 'WAVE' || container === 'AIFF') && fmt.codec) {
      const codec = fmt.codec.toUpperCase();
      if (codec !== 'PCM') {
        issues.push({
          code: 'NON_PCM_CODEC',
          severity: 'error',
          message: `Non-PCM codec: ${fmt.codec}`,
          detail: 'WAV/AIFF must use uncompressed PCM encoding. Re-encode to PCM AIFF.',
          suggestedAction: 'convert_aiff'
        });
      }
    }

    // WAV-specific checks for the wFormatTag issue (E-8305)
    if (container === 'WAVE') {
      // We can't directly check the wFormatTag without reading raw bytes,
      // but we can flag WAV files as potentially problematic
      // especially if they're from certain sources
      const stats = await fs.promises.stat(filePath);
      if (fmt.duration && fmt.sampleRate && fmt.numberOfChannels && fmt.bitsPerSample) {
        // Calculate expected file size for PCM
        const expectedSize =
          fmt.duration * fmt.sampleRate * fmt.numberOfChannels * (fmt.bitsPerSample / 8) + 44; // 44 bytes for header
        const actualSize = stats.size;
        const sizeDiff = Math.abs(actualSize - expectedSize) / expectedSize;

        // If file is significantly different from expected, might have extra metadata
        if (sizeDiff > 0.1) {
          issues.push({
            code: 'WAV_METADATA_WARNING',
            severity: 'warning',
            message: 'WAV may contain non-standard metadata',
            detail: 'Could cause E-8305 error. Convert to AIFF if issues occur.',
            suggestedAction: 'convert_aiff'
          });
        }
      }
    }

    // Check for very long tracks (over 2 hours)
    if (fmt.duration && fmt.duration > 7200) {
      issues.push({
        code: 'LONG_DURATION',
        severity: 'warning',
        message: `Very long track (${Math.round(fmt.duration / 60)} minutes)`,
        detail: 'May cause issues with waveform analysis.',
        suggestedAction: 'none'
      });
    }

    // Check for very short tracks (under 10 seconds)
    if (fmt.duration && fmt.duration < 10) {
      issues.push({
        code: 'SHORT_DURATION',
        severity: 'warning',
        message: `Very short track (${Math.round(fmt.duration)} seconds)`,
        detail: 'May be a sample or incomplete file.',
        suggestedAction: 'archive'
      });
    }

    // Check for missing album art
    if (!metadata.common.picture || metadata.common.picture.length === 0) {
      issues.push({
        code: 'MISSING_ALBUM_ART',
        severity: 'warning',
        message: 'Missing album art',
        detail: 'No embedded artwork found.',
        suggestedAction: 'search_art'
      });
    }

    // Check tag completeness
    const hasArtist = !!health.artist.trim();
    const hasTitle = !!health.title.trim();

    if (!hasArtist || !hasTitle) {
      const missing = [!hasArtist && 'artist', !hasTitle && 'title'].filter(Boolean);
      issues.push({
        code: 'MISSING_TAGS',
        severity: 'warning',
        message: `Missing ${missing.join(' and ')} tag${missing.length > 1 ? 's' : ''}`,
        detail: 'Core tags are empty. Populate from filename or search online.',
        suggestedAction: 'populate_tags'
      });
    } else {
      // Only check for sparse tags if artist+title are present
      const coreFields = [hasArtist, hasTitle, !!health.album.trim(), !!health.year, !!health.genre.trim()];
      const filled = coreFields.filter(Boolean).length;
      if (filled < 3) {
        const missing = [
          !health.album.trim() && 'album',
          !health.year && 'year',
          !health.genre.trim() && 'genre'
        ].filter(Boolean);
        issues.push({
          code: 'SPARSE_TAGS',
          severity: 'warning',
          message: `Incomplete metadata (missing ${missing.join(', ')})`,
          detail: 'Search online to fill in missing metadata fields.',
          suggestedAction: 'populate_tags'
        });
      }
    }
  } catch (error) {
    log.warn('Failed to parse audio metadata for:', fileName, error);
    issues.push({
      code: 'PARSE_ERROR',
      severity: 'error',
      message: 'Failed to read audio metadata',
      detail: error instanceof Error ? error.message : 'Unknown error',
      suggestedAction: 'archive'
    });
  }

  // Byte-swap integrity check for AIFF/AIFC — catches the static-audio
  // corruption produced by the old WAV→AIFF tag-write bug. Cheap (~64KB read
  // + a handful of ints of math per track), so it's safe to run on every scan.
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.aiff' || ext === '.aif' || ext === '.aifc') {
    const integrity = await checkAiffIntegrity(filePath);
    if (integrity.status === 'byte_swapped') {
      issues.push({
        code: 'BROKEN_AUDIO',
        severity: 'error',
        message: 'Audio bytes are scrambled (byte-swap)',
        detail:
          `Adjacent-sample coherence in the header-claimed byte order is ` +
          `${integrity.coherence.expected.toFixed(2)} vs ${integrity.coherence.swapped.toFixed(2)} ` +
          `if byte-swapped. This file plays back as static. Re-import from the ` +
          `original source (WAV/FLAC) to recover.`,
        suggestedAction: 'none'
      });
    }
  }

  health.issues = issues;
  health.isHealthy = !issues.some((i) => i.severity === 'error');

  return health;
}

// Summary stats for a batch of health checks
export function summarizeHealth(healthResults: TrackHealth[]): HealthSummary {
  const summary: HealthSummary = {
    total: healthResults.length,
    healthy: 0,
    warnings: 0,
    errors: 0,
    byIssueCode: {}
  };

  for (const result of healthResults) {
    if (result.isHealthy && result.issues.length === 0) {
      summary.healthy++;
    } else if (result.isHealthy) {
      summary.warnings++; // Has warnings but no errors
    } else {
      summary.errors++;
    }

    for (const issue of result.issues) {
      summary.byIssueCode[issue.code] = (summary.byIssueCode[issue.code] || 0) + 1;
    }
  }

  return summary;
}
