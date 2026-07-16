import fs from 'fs';
import { createScopedLogger } from './logger';

const log = createScopedLogger('AudioIntegrity');

export type IntegrityResult =
  | { status: 'ok' }
  | { status: 'byte_swapped'; expectedOrder: 'be' | 'le'; coherence: { expected: number; swapped: number } }
  | { status: 'unknown'; reason: string };

/**
 * Detect byte-swapped PCM samples in AIFF/AIFC files — the acoustic signature
 * of the old WAV→AIFF conversion bug that produced static audio. Music has
 * adjacent-sample correlation near 1.0 in its native byte order; byte-swapping
 * collapses it to ~0. If the "other" byte order is dramatically more coherent
 * than the order the header claims, the file is broken.
 *
 * Read cost is small (one fd, ~64KB), so this is cheap to run per track.
 */
export async function checkAiffIntegrity(filePath: string): Promise<IntegrityResult> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(header, 0, header.length, 0);
    if (bytesRead < 64) return { status: 'unknown', reason: 'file too small' };

    if (header.toString('ascii', 0, 4) !== 'FORM') return { status: 'unknown', reason: 'not a FORM file' };
    const formType = header.toString('ascii', 8, 12);
    if (formType !== 'AIFF' && formType !== 'AIFC') return { status: 'unknown', reason: `unexpected FORM type ${formType}` };

    // Walk top-level chunks to locate COMM (format info) and SSND (audio data).
    // Read each 8-byte chunk header directly from the file (not just the first
    // 64KB buffer) so SSND is found even behind large leading metadata chunks.
    const fileSize = (await fd.stat()).size;
    let compressionType: string | null = null;
    let bitDepth = 0;
    let ssndOffset = -1;
    let ssndSize = 0;
    let pos = 12;
    const chunkHeader = Buffer.alloc(8);
    while (pos + 8 <= fileSize) {
      const hr = await fd.read(chunkHeader, 0, 8, pos);
      if (hr.bytesRead < 8) break;
      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32BE(4);
      const dataStart = pos + 8;
      if (chunkId === 'COMM') {
        // channels(2) numSampleFrames(4) sampleSize(2) sampleRate(10 IEEE ext) [compressionType(4) in AIFC]
        const commLen = Math.min(Math.max(chunkSize, 8), 64);
        const comm = Buffer.alloc(commLen);
        await fd.read(comm, 0, commLen, dataStart);
        bitDepth = comm.readUInt16BE(6);
        if (formType === 'AIFC' && chunkSize >= 22) {
          compressionType = comm.toString('ascii', 18, 22);
        } else {
          compressionType = 'NONE';
        }
      } else if (chunkId === 'SSND') {
        const ssndHead = Buffer.alloc(8);
        await fd.read(ssndHead, 0, 8, dataStart);
        const dataOffset = ssndHead.readUInt32BE(0);
        ssndOffset = dataStart + 8 + dataOffset;
        ssndSize = chunkSize - 8 - dataOffset;
        break;
      }
      // Chunks are padded to even lengths in IFF
      pos = dataStart + chunkSize + (chunkSize % 2);
    }

    if (ssndOffset < 0) return { status: 'unknown', reason: 'SSND chunk not found' };
    if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
      return { status: 'unknown', reason: `unsupported bit depth ${bitDepth}` };
    }
    if (!compressionType) return { status: 'unknown', reason: 'no COMM chunk' };

    // Sample into the track ~1 second in, to avoid leading silence / fades.
    const bytesPerSample = bitDepth / 8;
    const SAMPLE_BYTES = 16384;
    const skipBytes = 44100 * bytesPerSample;
    const readFrom = Math.min(ssndOffset + skipBytes, ssndOffset + Math.max(0, ssndSize - SAMPLE_BYTES));
    const pcm = Buffer.alloc(SAMPLE_BYTES);
    const pcmRead = await fd.read(pcm, 0, SAMPLE_BYTES, readFrom);
    if (pcmRead.bytesRead < 1024) return { status: 'unknown', reason: 'not enough PCM to sample' };

    const beCoherence = sampleCoherence(pcm, pcmRead.bytesRead, bitDepth, 'be');
    const leCoherence = sampleCoherence(pcm, pcmRead.bytesRead, bitDepth, 'le');

    // Native byte order implied by the container/compressionType:
    //   AIFF + 'NONE' → big-endian PCM
    //   AIFC + 'NONE' / 'twos' → big-endian PCM
    //   AIFC + 'sowt' → little-endian PCM (explicit byte-swap marker)
    const expectedOrder: 'be' | 'le' = compressionType === 'sowt' ? 'le' : 'be';
    const expected = expectedOrder === 'be' ? beCoherence : leCoherence;
    const swapped = expectedOrder === 'be' ? leCoherence : beCoherence;

    // Thresholds: real music sits at 0.8–0.99. Noise sits at 0–0.1. If the
    // swapped-order interpretation is dramatically more coherent than the
    // header-claimed one, the audio bytes were written in the wrong order.
    if (swapped > 0.6 && swapped > expected + 0.4) {
      return { status: 'byte_swapped', expectedOrder, coherence: { expected, swapped } };
    }
    return { status: 'ok' };
  } catch (err) {
    log.debug('Integrity check failed:', filePath, err);
    return { status: 'unknown', reason: err instanceof Error ? err.message : 'unknown error' };
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/**
 * 1-lag coherence proxy: 1 − mean(Δ²) / (2·mean(s²)). For smooth/correlated
 * signals Δ is small relative to s, giving ~1. For white noise Δ² ≈ 2·s²,
 * giving ~0. Returns a value clamped to [0, 1].
 */
function sampleCoherence(buf: Buffer, bytesRead: number, bitDepth: number, order: 'be' | 'le'): number {
  const bytesPerSample = bitDepth / 8;
  const numSamples = Math.floor(bytesRead / bytesPerSample);
  if (numSamples < 64) return 0;

  let sumSq = 0;
  let sumDiffSq = 0;
  let prev = readSample(buf, 0, bitDepth, order);
  for (let i = 1; i < numSamples; i++) {
    const s = readSample(buf, i * bytesPerSample, bitDepth, order);
    sumSq += s * s;
    const d = s - prev;
    sumDiffSq += d * d;
    prev = s;
  }
  if (sumSq === 0) return 0;
  const ratio = sumDiffSq / (2 * sumSq);
  return Math.max(0, Math.min(1, 1 - ratio));
}

function readSample(buf: Buffer, offset: number, bitDepth: number, order: 'be' | 'le'): number {
  if (bitDepth === 16) {
    return order === 'be' ? buf.readInt16BE(offset) : buf.readInt16LE(offset);
  }
  if (bitDepth === 24) {
    const b0 = buf[offset], b1 = buf[offset + 1], b2 = buf[offset + 2];
    let v = order === 'be' ? (b0 << 16) | (b1 << 8) | b2 : b0 | (b1 << 8) | (b2 << 16);
    if (v & 0x800000) v |= ~0xffffff; // sign-extend 24→32
    return v;
  }
  return order === 'be' ? buf.readInt32BE(offset) : buf.readInt32LE(offset);
}
