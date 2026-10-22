/**
 * Tests for FinalizeService and WatchService using a real temp directory
 * (MergeService is replaced with a fake that writes a stub M4B)
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FinalizeService } from '../../services/finalize-service';
import { WatchService } from '../../services/watch-service';
import type { MergeService } from '../../services/merge-service';

jest.mock('fluent-ffmpeg');
jest.mock('@ffmpeg-installer/ffmpeg', () => ({ path: '/mock/ffmpeg' }));

function createFakeMerge() {
  return {
    getOutputFilename: (title: string) => `${title}.m4b`,
    mergeFolder: jest.fn(async (folder: string) => {
      const metadata = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf-8'));
      const outputFilename = `${metadata.metadata.title}.m4b`;
      const outputPath = path.join(folder, outputFilename);
      await fs.writeFile(outputPath, 'm4b');
      return { outputPath, outputFilename, fileSize: 3 };
    }),
  };
}

interface BookOptions {
  chapters?: number;
  downloaded?: number;
  metadata?: boolean;
  authors?: string[];
}

async function createBook(root: string, name: string, options: BookOptions = {}): Promise<string> {
  const {
    chapters = 2,
    downloaded = chapters,
    metadata = true,
    authors = ['Jane Smith'],
  } = options;
  const folder = path.join(root, name);
  await fs.mkdir(folder, { recursive: true });
  for (let i = 1; i <= downloaded; i++) {
    await fs.writeFile(path.join(folder, `chapter-${String(i).padStart(3, '0')}.mp3`), 'mp3');
  }
  if (metadata) {
    await fs.writeFile(
      path.join(folder, 'metadata.json'),
      JSON.stringify({
        metadata: { title: name, authors },
        chapters: Array.from({ length: chapters }, (_, i) => ({ index: i, title: `Ch ${i}` })),
      })
    );
  }
  return folder;
}

describe('FinalizeService', () => {
  let tmp: string;
  let downloads: string;
  let finalDir: string;
  let archiveDir: string;
  let fakeMerge: ReturnType<typeof createFakeMerge>;
  let service: FinalizeService;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'libby-finalize-'));
    downloads = path.join(tmp, 'downloads');
    finalDir = path.join(tmp, 'library');
    archiveDir = path.join(downloads, '_archive');
    fakeMerge = createFakeMerge();
    service = new FinalizeService(fakeMerge as unknown as MergeService);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  describe('checkReady', () => {
    it('is ready when all chapters and metadata are present', async () => {
      const folder = await createBook(downloads, 'Book');
      expect(await service.checkReady(folder)).toEqual({ ready: true, title: 'Book' });
    });

    it('waits for metadata.json', async () => {
      const folder = await createBook(downloads, 'Book', { metadata: false });
      expect(await service.checkReady(folder)).toMatchObject({
        ready: false,
        reason: 'Waiting for metadata.json',
      });
    });

    it('waits for missing chapters', async () => {
      const folder = await createBook(downloads, 'Book', { chapters: 3, downloaded: 1 });
      expect(await service.checkReady(folder)).toMatchObject({
        ready: false,
        reason: '1/3 chapters downloaded',
      });
    });

    it('waits while a browser partial file exists', async () => {
      const folder = await createBook(downloads, 'Book');
      await fs.writeFile(path.join(folder, 'chapter-003.mp3.crdownload'), '');
      expect(await service.checkReady(folder)).toMatchObject({
        ready: false,
        reason: 'Download in progress',
      });
    });
  });

  describe('finalizeBook', () => {
    it('moves the M4B to <final>/<Author>/<Title>/ and archives the source', async () => {
      const folder = await createBook(downloads, 'My Book', { authors: ['A One', 'B Two'] });

      const result = await service.finalizeBook(folder, { finalDir, archiveDir });

      const expected = path.join(finalDir, 'A One, B Two', 'My Book', 'My Book.m4b');
      expect(result.outputPath).toBe(expected);
      expect(result.merged).toBe(true);
      expect(await fs.readFile(expected, 'utf-8')).toBe('m4b');
      expect(result.archivePath).toBe(path.join(archiveDir, 'My Book'));
      await expect(fs.access(folder)).rejects.toThrow();
      expect(await fs.readdir(result.archivePath)).toContain('metadata.json');
    });

    it('reuses an existing M4B instead of merging again', async () => {
      const folder = await createBook(downloads, 'Book');
      await fs.writeFile(path.join(folder, 'Book.m4b'), 'existing');

      const result = await service.finalizeBook(folder, { finalDir, archiveDir });

      expect(fakeMerge.mergeFolder).not.toHaveBeenCalled();
      expect(result.merged).toBe(false);
      expect(await fs.readFile(result.outputPath, 'utf-8')).toBe('existing');
    });

    it('refuses to overwrite a book already in the library, before merging', async () => {
      const folder = await createBook(downloads, 'Book');
      const existing = path.join(finalDir, 'Jane Smith', 'Book', 'Book.m4b');
      await fs.mkdir(path.dirname(existing), { recursive: true });
      await fs.writeFile(existing, 'old');

      await expect(service.finalizeBook(folder, { finalDir, archiveDir })).rejects.toThrow(
        'Already in library'
      );
      expect(fakeMerge.mergeFolder).not.toHaveBeenCalled();
      expect(await fs.readFile(existing, 'utf-8')).toBe('old');
    });

    it('picks a unique archive name when one is taken', async () => {
      await fs.mkdir(path.join(archiveDir, 'Book'), { recursive: true });
      const folder = await createBook(downloads, 'Book');

      const result = await service.finalizeBook(folder, { finalDir, archiveDir });

      expect(result.archivePath).toBe(path.join(archiveDir, 'Book (2)'));
    });
  });

  describe('WatchService.scanOnce', () => {
    it('finalizes ready books, skips the archive, and reports waiting ones', async () => {
      await createBook(downloads, 'Ready');
      await createBook(downloads, 'Partial', { chapters: 2, downloaded: 1 });
      await fs.mkdir(archiveDir, { recursive: true });
      const onWaiting = jest.fn();
      const onBookComplete = jest.fn();

      const watch = new WatchService(
        { dataDir: downloads, finalDir, settleSecs: 0, onWaiting, onBookComplete },
        service
      );
      const summary = await watch.scanOnce();

      expect(summary).toEqual({ finalized: 1, failed: 0, waiting: 1 });
      expect(onBookComplete).toHaveBeenCalledWith('Ready', expect.anything());
      expect(onWaiting).toHaveBeenCalledWith('Partial', '1/2 chapters downloaded');
      expect((await fs.readdir(downloads)).sort()).toEqual(['Partial', '_archive']);
    });

    it('waits for recently modified folders to settle', async () => {
      await createBook(downloads, 'Fresh');
      const watch = new WatchService({ dataDir: downloads, finalDir, settleSecs: 60 }, service);

      expect(await watch.scanOnce()).toEqual({ finalized: 0, failed: 0, waiting: 1 });
    });

    it('does not retry a failed book until it changes', async () => {
      await createBook(downloads, 'Book');
      fakeMerge.mergeFolder.mockRejectedValue(new Error('ffmpeg failed'));
      const onBookError = jest.fn();
      const watch = new WatchService(
        { dataDir: downloads, finalDir, settleSecs: 0, onBookError },
        service
      );

      await watch.scanOnce();
      await watch.scanOnce();

      expect(onBookError).toHaveBeenCalledTimes(1);
      expect(fakeMerge.mergeFolder).toHaveBeenCalledTimes(1);
    });
  });
});
