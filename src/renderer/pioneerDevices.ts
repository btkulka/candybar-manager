// ========== Pioneer Device Catalog ==========
// One list for every compatibility verdict in the app (USB page matrix and the
// Library page's connected-device cards), so the same drive never gets two
// different answers.
//
// File systems are listed conservatively: exFAT only where the player reads it
// on stock firmware. Saying "won't read" for a stick that would work costs a
// reformat; saying "Ready" for one that won't costs the gig.

import type { LibraryHealthTrack } from './shared';

export type PioneerDevice = {
  name: string;
  category: 'flagship' | 'all-in-one' | 'media-player';
  /** Product photo; the card falls back to the name when missing or offline. */
  imageUrl?: string;
  supportedFS: string[];          // normalized names (see normalizeFS)
  supportedFormats: Set<string>;  // uppercase container names: 'WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC'
};

export const PIONEER_DEVICES: PioneerDevice[] = [
  {
    name: 'CDJ-3000',
    category: 'flagship',
    imageUrl: 'https://images.microcms-assets.io/assets/3b9e29ce734e49babfedb3f8d1e728e3/cbe27d4bec5f4302be38b9eee163ffa7/96C2FC9D-EBA6-46DC-BA4D-7F8447AE2EEA.jpg',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'CDJ-2000NXS2',
    category: 'flagship',
    imageUrl: 'https://alphatheta.com/product-images/1578/f02df8bc-4f62-437d-acee-a7ed625c8755/cdj-2000nxs2_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'CDJ-2000NXS',
    category: 'flagship',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
  {
    name: 'OPUS-QUAD',
    category: 'all-in-one',
    imageUrl: 'https://product-images.alphatheta.com/139/f6ee44f7-2409-40ea-b78e-643217be9991/opus-quad_1.png',
    supportedFS: ['FAT32', 'FAT16', 'exFAT', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'XDJ-RX3',
    category: 'all-in-one',
    imageUrl: 'https://images.microcms-assets.io/assets/3b9e29ce734e49babfedb3f8d1e728e3/808bfb43-0301-49fb-a220-80ddb5aacffc/xdj-rx3_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
  {
    name: 'XDJ-RX2',
    category: 'all-in-one',
    imageUrl: 'https://product-images.alphatheta.com/1838/cd1cf970-9285-4ddc-98a6-e041c67033d3/xdj-rx2_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
  {
    name: 'XDJ-XZ',
    category: 'all-in-one',
    imageUrl: 'https://product-images.alphatheta.com/629/595fe353-dd7c-4e60-8091-01f1c306e152/xdj-xz_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'XDJ-1000MK2',
    category: 'media-player',
    imageUrl: 'https://product-images.alphatheta.com/599/372dee8c-1a1b-419b-9943-a2c9b63f7c6b/xdj-1000mk2_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4', 'FLAC']),
  },
  {
    name: 'XDJ-700',
    category: 'media-player',
    imageUrl: 'https://images.microcms-assets.io/product-images/392/97116f84-9276-4d07-8ea1-1908bc0ff5f7/xdj-700_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
  {
    name: 'DDJ-FLX10',
    category: 'media-player',
    imageUrl: 'https://images.microcms-assets.io/assets/3b9e29ce734e49babfedb3f8d1e728e3/87650f9b2b40406784627a3fdaf87d6d/3EAE02FE-9A29-4242-9426-BF1DEA4EB283.jpg',
    supportedFS: ['FAT32', 'FAT16'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
  {
    name: 'DDJ-REV7',
    category: 'media-player',
    imageUrl: 'https://images.microcms-assets.io/assets/3b9e29ce734e49babfedb3f8d1e728e3/e17d8824-80ed-4a1b-9957-cfc885cc2cef/DDJ-REV7_1.png',
    supportedFS: ['FAT32', 'FAT16', 'HFS+'],
    supportedFormats: new Set(['WAVE', 'AIFF', 'MPEG', 'MP4']),
  },
];

// ========== Helpers ==========

/** Canonical file-system name for matching against supportedFS. */
export function normalizeFS(fs: string): string {
  const upper = fs.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (upper.includes('FAT32') || upper === 'MSDOSFAT32') return 'FAT32';
  if (upper.includes('FAT16') || upper === 'MSDOSFAT16') return 'FAT16';
  if (upper.includes('EXFAT')) return 'exFAT';
  if (upper.includes('HFS') || upper.includes('APFS')) return 'HFS+';
  if (upper.includes('NTFS')) return 'NTFS';
  if (upper.includes('FAT')) return 'FAT32'; // generic FAT → FAT32
  return fs;
}

/** Friendly label for a container name. */
export function containerLabel(container: string): string {
  const map: Record<string, string> = {
    'WAVE': 'WAV', 'AIFF': 'AIFF', 'MPEG': 'MP3', 'MP4': 'AAC',
    'FLAC': 'FLAC', 'OGG': 'OGG', 'Unknown': '?', 'UNKNOWN': '?',
  };
  return map[container] || container;
}

/** Track count per uppercase container name. */
export function countFormats(tracks: LibraryHealthTrack[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tracks) {
    const fmt = (t.format.container || 'Unknown').toUpperCase();
    counts[fmt] = (counts[fmt] || 0) + 1;
  }
  return counts;
}

export function categoryLabel(cat: PioneerDevice['category']): string {
  return cat === 'flagship' ? 'Club Standard'
    : cat === 'all-in-one' ? 'All-in-One'
    : 'Media Player';
}

export function deviceReadsFS(device: PioneerDevice, fileSystem: string): boolean {
  const volumeFS = normalizeFS(fileSystem);
  return device.supportedFS.some(fs => normalizeFS(fs) === volumeFS);
}
