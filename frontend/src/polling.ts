type Scheduler = (callback: () => void, delay: number) => () => void;
const schedule: Scheduler = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

/** Starts the next request only after completion; cancellation also suppresses late callbacks. */
export function poll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  receive: (value: T) => void,
  fail: (error: unknown) => void,
  delay: number,
  scheduler: Scheduler = schedule,
): () => void {
  const controller = new AbortController();
  let cancelTimer = () => {};
  const run = async () => {
    try {
      const result = await load(controller.signal);
      if (!controller.signal.aborted) receive(result);
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      if (!controller.signal.aborted)
        cancelTimer = scheduler(() => void run(), delay);
    }
  };
  void run();
  return () => {
    controller.abort();
    cancelTimer();
  };
}

/** Revision belongs to the document, so compare it across version IDs as well. */
export function latestDocument<
  T extends { id: string; summary_revision: number },
>(current: T | null, incoming: T): T {
  return current?.id === incoming.id &&
    current.summary_revision > incoming.summary_revision
    ? current
    : incoming;
}
