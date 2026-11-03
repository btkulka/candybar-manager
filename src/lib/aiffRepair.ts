// ============================================================
// Minimal repair for AIFC files whose COMM chunk has an invalid
// compressionType FourCC. Overwrites 4 bytes in place with "NONE"
// (uncompressed), which both ffmpeg and music-metadata accept.
//
// Seen in the wild: files muxed as FORM/AIFC but with junk bytes
// in the compressionType field (e.g. 01 00 00 00). ffmpeg fails
// with "could not find COMM tag or invalid block_align value",
// music-metadata with "FourCC contains invalid characters".
// ============================================================

import fs from 'fs/promises';
import { createScopedLogger } from './logger';
import { recordWrite } from './writeJournal';

const log = createScopedLogger('AiffRepair');

// FourCC validation mirrors music-metadata's rule: first byte 0x21-0x7e or ©,
// next three bytes 0x20-0x7e / 0x00 / parens.
const VALID_FOURCC = /^[\x21-\x7e\xa9][\x20-\x7e\x00()]{3}$/;

export interface AiffHeaderDiagnosis {
  kind: 'ok' | 'not-aiff' | 'not-aifc' | 'no-comm' | 'invalid-compression-type' | 'bad-header';
  compressionTypeOffset?: number;
  currentCompressionType?: string;
}

/**
 * Inspect the file header and return a diagnosis. Reads only enough
 * bytes to walk the top-level chunks in the FORM wrapper.
 */
export async function diagnoseAiffHeader(filePath: string): Promise<AiffHeaderDiagnosis> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const headerBuf = Buffer.alloc(12);
    const { bytesRead } = await handle.read(headerBuf, 0, 12, 0);
    if (bytesRead < 12) return { kind: 'bad-header' };

    if (headerBuf.toString('ascii', 0, 4) !== 'FORM') return { kind: 'not-aiff' };
    const formType = headerBuf.toString('ascii', 8, 12);
    if (formType !== 'AIFC') {
      // AIFF (non-compressed) has no compressionType field to corrupt.
      return formType === 'AIFF' ? { kind: 'ok' } : { kind: 'not-aiff' };
    }

    // Walk chunks inside FORM to find COMM.
    let pos = 12;
    const chunkHeader = Buffer.alloc(8);
    for (;;) {
      const read = await handle.read(chunkHeader, 0, 8, pos);
      if (read.bytesRead < 8) return { kind: 'no-comm' };
      const id = chunkHeader.toString('ascii', 0, 4);
      const size = chunkHeader.readUInt32BE(4);
      if (id === 'COMM') {
        if (size < 22) return { kind: 'bad-header' };
        // AIFC COMM layout: numChannels(2) + numSampleFrames(4) + sampleSize(2)
        // + sampleRate(10) + compressionType(4) + compressionName(pascal).
        const compTypeOffset = pos + 8 + 18;
        const compTypeBuf = Buffer.alloc(4);
        const r = await handle.read(compTypeBuf, 0, 4, compTypeOffset);
        if (r.bytesRead < 4) return { kind: 'bad-header' };
        const compType = compTypeBuf.toString('latin1');
        if (VALID_FOURCC.test(compType)) {
          return { kind: 'ok', compressionTypeOffset: compTypeOffset, currentCompressionType: compType };
        }
        return {
          kind: 'invalid-compression-type',
          compressionTypeOffset: compTypeOffset,
          currentCompressionType: compType,
        };
      }
      // IFF chunks pad to 2-byte boundary.
      pos += 8 + size + (size % 2);
    }
  } finally {
    await handle?.close();
  }
}

/**
 * Repair an AIFC file whose COMM chunk has an invalid compressionType.
 * Overwrites the 4-byte compressionType field in place with "NONE".
 *
 * Returns true if the repair was applied, false if the file was already
 * healthy. Throws if the file doesn't match the repairable pattern.
 */
export async function repairAiffHeader(filePath: string): Promise<boolean> {
  const diag = await diagnoseAiffHeader(filePath);

  if (diag.kind === 'ok') {
    log.info('repairAiffHeader: file already has a valid compressionType, no-op', { filePath });
    return false;
  }
  if (diag.kind !== 'invalid-compression-type' || diag.compressionTypeOffset === undefined) {
    throw new Error(`Cannot repair: file is not an AIFC with an invalid compressionType (${diag.kind}).`);
  }

  log.info('repairAiffHeader: overwriting compressionType with NONE', {
    filePath,
    offset: diag.compressionTypeOffset,
    was: diag.currentCompressionType,
  });

  try {
    const handle = await fs.open(filePath, 'r+');
    try {
      await handle.write(Buffer.from('NONE', 'ascii'), 0, 4, diag.compressionTypeOffset);
    } finally {
      await handle.close();
    }
  } catch (err) {
    recordWrite({
      op: 'header-repair', src: filePath, outcome: 'error',
      error: err instanceof Error ? err.message : String(err),
      detail: { offset: diag.compressionTypeOffset, was: diag.currentCompressionType },
    });
    throw err;
  }
  recordWrite({
    op: 'header-repair', src: filePath, outcome: 'ok',
    detail: { offset: diag.compressionTypeOffset, was: diag.currentCompressionType },
  });
  return true;
}
