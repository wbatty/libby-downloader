import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { WatchService, WatchOptions } from '../../services/watch-service';

type WatchEvent =
  | { kind: 'done'; name: string; detail: string }
  | { kind: 'error'; name: string; detail: string }
  | { kind: 'waiting'; name: string; detail: string };

interface WatchProgressProps {
  options: Omit<WatchOptions, 'signal'>;
  once?: boolean;
  onComplete: () => void;
}

interface ActiveBook {
  name: string;
  stage: string;
  totalDurationSecs: number;
  processedSecs: number;
}

const MAX_EVENTS = 15;

function parseTimemark(timemark: string): number {
  const [h, m, s] = timemark.split(':').map(parseFloat);
  return [h, m, s].some(isNaN) ? 0 : h * 3600 + m * 60 + s;
}

export function WatchProgress({ options, once = false, onComplete }: WatchProgressProps) {
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const [active, setActive] = useState<ActiveBook | null>(null);
  const [paths, setPaths] = useState<ReturnType<WatchService['getPaths']> | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const addEvent = (event: WatchEvent) =>
      setEvents((prev) => [...prev, event].slice(-MAX_EVENTS));

    const service = new WatchService({
      ...options,
      signal: controller.signal,
      onWaiting: (name, reason) => addEvent({ kind: 'waiting', name, detail: reason }),
      onBookStart: (name) =>
        setActive({ name, stage: 'Starting...', totalDurationSecs: 0, processedSecs: 0 }),
      onStageChange: (stage) => setActive((prev) => (prev ? { ...prev, stage } : prev)),
      onMergeStart: (totalDurationSecs) =>
        setActive((prev) => (prev ? { ...prev, totalDurationSecs } : prev)),
      onMergeProgress: (timemark) =>
        setActive((prev) => (prev ? { ...prev, processedSecs: parseTimemark(timemark) } : prev)),
      onBookComplete: (name, result) => {
        setActive(null);
        addEvent({ kind: 'done', name, detail: result.outputPath });
      },
      onBookError: (name, error) => {
        setActive(null);
        addEvent({ kind: 'error', name, detail: error.message });
      },
    });
    setPaths(service.getPaths());

    const work = once ? service.scanOnce() : service.run();
    work
      .catch((error) =>
        addEvent({ kind: 'error', name: 'watch', detail: (error as Error).message })
      )
      .finally(() => {
        setFinished(true);
        setTimeout(() => onComplete(), 100);
      });

    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      controller.abort();
    };
  }, []);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {paths && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text dimColor>Watching: </Text>
            <Text color="cyan">{paths.downloadsFolder}</Text>
          </Text>
          <Text>
            <Text dimColor>Library: </Text>
            <Text color="cyan">{paths.finalDir}</Text>
          </Text>
          <Text>
            <Text dimColor>Archive: </Text>
            <Text color="cyan">{paths.archiveDir}</Text>
            <Text dimColor> (safe to delete)</Text>
          </Text>
        </Box>
      )}

      {events.map((event, i) => (
        <Box key={i}>
          {event.kind === 'done' && (
            <Text>
              <Text color="green">✔</Text>
              <Text bold> {event.name}</Text>
              <Text dimColor> → </Text>
              <Text color="cyan">{event.detail}</Text>
            </Text>
          )}
          {event.kind === 'error' && (
            <Text color="red">
              ✖ {event.name}: {event.detail}
            </Text>
          )}
          {event.kind === 'waiting' && (
            <Text dimColor>
              · {event.name}: {event.detail}
            </Text>
          )}
        </Box>
      ))}

      {active ? (
        <Box marginTop={events.length ? 1 : 0}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text bold> {active.name}</Text>
          <Text dimColor>
            {' '}
            {active.totalDurationSecs > 0 && active.processedSecs > 0
              ? `Merging ${Math.min(100, Math.round((active.processedSecs / active.totalDurationSecs) * 100))}%`
              : active.stage}
          </Text>
        </Box>
      ) : (
        !finished &&
        !once && (
          <Box marginTop={events.length ? 1 : 0}>
            <Text dimColor>Waiting for downloads... (Ctrl+C to stop)</Text>
          </Box>
        )
      )}

      {finished && once && events.length === 0 && <Text dimColor>No books ready.</Text>}
    </Box>
  );
}
