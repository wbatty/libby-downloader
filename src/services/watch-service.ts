/**
 * WatchService - Polls the downloads folder and finalizes books as they finish downloading
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { BookService } from './book-service';
import { FinalizeService, FinalizeResult } from './finalize-service';
import { logger } from '../utils/logger';

export interface WatchOptions {
  dataDir?: string;
  finalDir: string;
  /** Defaults to <downloads folder>/_archive */
  archiveDir?: string;
  /** Seconds between scans */
  intervalSecs?: number;
  /** Seconds a folder must go unmodified before it is processed */
  settleSecs?: number;
  signal?: AbortSignal;
  onScan?: () => void;
  onWaiting?: (name: string, reason: string) => void;
  onBookStart?: (name: string) => void;
  onStageChange?: (stage: string) => void;
  onMergeStart?: (totalDurationSecs: number, chapterCount: number) => void;
  onMergeProgress?: (timemark: string) => void;
  onBookComplete?: (name: string, result: FinalizeResult) => void;
  onBookError?: (name: string, error: Error) => void;
}

export interface ScanSummary {
  finalized: number;
  failed: number;
  waiting: number;
}

export class WatchService {
  private readonly downloadsFolder: string;
  private readonly finalDir: string;
  private readonly archiveDir: string;
  private readonly finalizeService: FinalizeService;
  /** Folders that failed, keyed to their last-modified time so an edit triggers a retry */
  private readonly failed = new Map<string, number>();
  /** Last reported waiting reason per folder, to avoid repeating it every scan */
  private readonly waiting = new Map<string, string>();

  constructor(
    private readonly options: WatchOptions,
    finalizeService: FinalizeService = new FinalizeService()
  ) {
    this.downloadsFolder = path.resolve(new BookService(options.dataDir).getDownloadsFolder());
    this.finalDir = path.resolve(options.finalDir);
    this.archiveDir = path.resolve(
      options.archiveDir ?? path.join(this.downloadsFolder, '_archive')
    );
    this.finalizeService = finalizeService;
  }

  getPaths(): { downloadsFolder: string; finalDir: string; archiveDir: string } {
    return {
      downloadsFolder: this.downloadsFolder,
      finalDir: this.finalDir,
      archiveDir: this.archiveDir,
    };
  }

  /**
   * Scan until the signal aborts
   */
  async run(): Promise<void> {
    const intervalMs = (this.options.intervalSecs ?? 10) * 1000;
    const { signal } = this.options;

    while (!signal?.aborted) {
      await this.scanOnce();
      await this.sleep(intervalMs, signal);
    }
  }

  /**
   * Process every ready book once, sequentially
   */
  async scanOnce(): Promise<ScanSummary> {
    const summary: ScanSummary = { finalized: 0, failed: 0, waiting: 0 };
    this.options.onScan?.();

    let entries: string[];
    try {
      entries = (await fs.readdir(this.downloadsFolder, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      logger.debug(`Downloads folder not found: ${this.downloadsFolder}`);
      return summary;
    }

    for (const name of entries) {
      if (this.options.signal?.aborted) break;

      const folderPath = path.join(this.downloadsFolder, name);
      if (this.isReservedPath(folderPath)) continue;

      const lastModified = await this.getLastModified(folderPath);
      if (this.failed.get(name) === lastModified) continue;
      this.failed.delete(name);

      const readiness = await this.finalizeService.checkReady(folderPath);
      const settleMs = (this.options.settleSecs ?? 30) * 1000;
      const reason = !readiness.ready
        ? readiness.reason
        : Date.now() - lastModified < settleMs
          ? 'Waiting for files to settle'
          : undefined;

      if (reason) {
        summary.waiting++;
        if (this.waiting.get(name) !== reason) {
          this.waiting.set(name, reason);
          this.options.onWaiting?.(name, reason);
        }
        continue;
      }
      this.waiting.delete(name);

      this.options.onBookStart?.(name);
      try {
        const result = await this.finalizeService.finalizeBook(folderPath, {
          finalDir: this.finalDir,
          archiveDir: this.archiveDir,
          onStageChange: this.options.onStageChange,
          onMergeStart: this.options.onMergeStart,
          onMergeProgress: this.options.onMergeProgress,
          signal: this.options.signal,
        });
        summary.finalized++;
        this.options.onBookComplete?.(name, result);
      } catch (error) {
        if (this.options.signal?.aborted) break;
        summary.failed++;
        this.failed.set(name, await this.getLastModified(folderPath));
        logger.error(`Failed to finalize ${name}:`, error);
        this.options.onBookError?.(name, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return summary;
  }

  /**
   * Skip the archive and library folders when they live inside the downloads folder
   */
  private isReservedPath(folderPath: string): boolean {
    return [this.archiveDir, this.finalDir].some(
      (reserved) => reserved === folderPath || reserved.startsWith(folderPath + path.sep)
    );
  }

  /**
   * Newest mtime among the folder and its direct children
   */
  private async getLastModified(folderPath: string): Promise<number> {
    try {
      let newest = (await fs.stat(folderPath)).mtimeMs;
      for (const file of await fs.readdir(folderPath)) {
        try {
          newest = Math.max(newest, (await fs.stat(path.join(folderPath, file))).mtimeMs);
        } catch {
          // File removed mid-scan
        }
      }
      return newest;
    } catch {
      return 0;
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }
}
