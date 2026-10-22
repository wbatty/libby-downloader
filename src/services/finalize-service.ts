/**
 * FinalizeService - Merges a downloaded book and files it into an Audiobookshelf library
 *
 * Layout: <finalDir>/<Author>/<Title>/<Title>.m4b
 * The original download folder is moved to <archiveDir>/<folder name> afterwards,
 * so everything left in the archive is safe to delete.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { MergeService, MergeOptions } from './merge-service';
import { sanitizeFilename } from '../utils/fs';
import { logger } from '../utils/logger';

/** Extensions browsers use for in-progress downloads */
const PARTIAL_DOWNLOAD_EXTENSIONS = ['.crdownload', '.part', '.download', '.tmp'];

interface BookMetadataFile {
  metadata?: {
    title?: string;
    authors?: string[];
  };
  chapters?: unknown[];
}

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
  title?: string;
}

export interface FinalizeOptions extends Pick<
  MergeOptions,
  'onStageChange' | 'onMergeStart' | 'onMergeProgress' | 'signal'
> {
  finalDir: string;
  archiveDir: string;
}

export interface FinalizeResult {
  title: string;
  author: string;
  outputPath: string;
  archivePath: string;
  fileSize: number;
  merged: boolean;
}

export class FinalizeService {
  private mergeService: MergeService;

  constructor(mergeService: MergeService = new MergeService()) {
    this.mergeService = mergeService;
  }

  /**
   * Check whether a download folder has every chapter and its metadata.json.
   * The extension writes metadata.json after the last chapter, so its presence
   * plus a matching chapter count means the download finished.
   */
  async checkReady(folderPath: string): Promise<ReadinessResult> {
    let files: string[];
    try {
      files = await fs.readdir(folderPath);
    } catch {
      return { ready: false, reason: 'Folder not readable' };
    }

    if (files.some((f) => PARTIAL_DOWNLOAD_EXTENSIONS.some((ext) => f.endsWith(ext)))) {
      return { ready: false, reason: 'Download in progress' };
    }

    if (!files.includes('metadata.json')) {
      return { ready: false, reason: 'Waiting for metadata.json' };
    }

    let metadata: BookMetadataFile;
    try {
      metadata = JSON.parse(await fs.readFile(path.join(folderPath, 'metadata.json'), 'utf-8'));
    } catch {
      return { ready: false, reason: 'metadata.json is not valid JSON' };
    }

    const title = metadata.metadata?.title;
    const expected = metadata.chapters?.length ?? 0;
    const found = files.filter((f) => f.startsWith('chapter-') && f.endsWith('.mp3')).length;

    if (expected === 0) {
      return { ready: false, reason: 'metadata.json has no chapters', title };
    }
    if (found < expected) {
      return { ready: false, reason: `${found}/${expected} chapters downloaded`, title };
    }

    return { ready: true, title };
  }

  /**
   * Merge a book folder into an M4B, move it into the library, and archive the source
   */
  async finalizeBook(folderPath: string, options: FinalizeOptions): Promise<FinalizeResult> {
    const resolved = path.resolve(folderPath);
    const metadata = JSON.parse(
      await fs.readFile(path.join(resolved, 'metadata.json'), 'utf-8')
    ) as BookMetadataFile;

    const title = metadata.metadata?.title?.trim() || path.basename(resolved);
    const author = metadata.metadata?.authors?.filter(Boolean).join(', ') || 'Unknown Author';

    const bookDir = path.join(
      path.resolve(options.finalDir),
      this.safeSegment(author, 'Unknown Author'),
      this.safeSegment(title, 'Untitled')
    );

    // Reuse an M4B the user already merged by hand
    const existingM4b = await this.findExistingM4b(resolved);
    const outputFilename = existingM4b
      ? path.basename(existingM4b)
      : this.mergeService.getOutputFilename(title);
    const outputPath = path.join(bookDir, outputFilename);

    // Check before merging so a duplicate doesn't cost a full encode
    if (await this.pathExists(outputPath)) {
      throw new Error(`Already in library: ${outputPath}`);
    }

    let sourceM4b = existingM4b;
    if (!sourceM4b) {
      const result = await this.mergeService.mergeFolder(resolved, {
        onStageChange: options.onStageChange,
        onMergeStart: options.onMergeStart,
        onMergeProgress: options.onMergeProgress,
        signal: options.signal,
      });
      sourceM4b = result.outputPath;
    }

    options.onStageChange?.('Moving to library...');
    await fs.mkdir(bookDir, { recursive: true });
    await this.movePath(sourceM4b, outputPath);
    const fileSize = (await fs.stat(outputPath)).size;

    options.onStageChange?.('Archiving source files...');
    const archivePath = await this.uniquePath(
      path.join(path.resolve(options.archiveDir), path.basename(resolved))
    );
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await this.movePath(resolved, archivePath);

    return { title, author, outputPath, archivePath, fileSize, merged: !existingM4b };
  }

  private async findExistingM4b(folderPath: string): Promise<string | null> {
    const m4bFiles = (await fs.readdir(folderPath)).filter((f) => f.endsWith('.m4b'));
    return m4bFiles.length === 1 ? path.join(folderPath, m4bFiles[0]) : null;
  }

  private safeSegment(value: string, fallback: string): string {
    return sanitizeFilename(value).replace(/^\.+/, '') || fallback;
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Append " (2)", " (3)", ... until the path is free
   */
  private async uniquePath(target: string): Promise<string> {
    let candidate = target;
    for (let n = 2; await this.pathExists(candidate); n++) {
      candidate = `${target} (${n})`;
    }
    return candidate;
  }

  /**
   * Rename, falling back to copy + delete when crossing filesystems (e.g. a NAS mount)
   */
  private async movePath(source: string, destination: string): Promise<void> {
    try {
      await fs.rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }
      logger.debug(`Cross-device move, copying ${source} -> ${destination}`);
      await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
      await fs.rm(source, { recursive: true, force: true });
    }
  }
}
