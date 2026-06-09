export type PaintScheduler = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (id: number) => void;
};

function browserScheduler(): PaintScheduler {
  return {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (id) => clearTimeout(id),
  };
}

export function afterTwoPaintsOrTimeout(
  callback: () => void,
  scheduler = browserScheduler(),
  timeoutMs = 100,
): () => void {
  let complete = false;
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  let timer: number | null = null;

  const clearPending = () => {
    if (firstFrame !== null) scheduler.cancelFrame(firstFrame);
    if (secondFrame !== null) scheduler.cancelFrame(secondFrame);
    if (timer !== null) scheduler.clearTimer(timer);
    firstFrame = null;
    secondFrame = null;
    timer = null;
  };

  const finish = () => {
    if (complete) return;
    complete = true;
    clearPending();
    callback();
  };

  timer = scheduler.setTimer(finish, timeoutMs);
  firstFrame = scheduler.requestFrame(() => {
    firstFrame = null;
    secondFrame = scheduler.requestFrame(() => {
      secondFrame = null;
      finish();
    });
  });

  return () => {
    if (complete) return;
    complete = true;
    clearPending();
  };
}
