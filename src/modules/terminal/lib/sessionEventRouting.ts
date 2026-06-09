export function withCurrentSession<T>(
  current: T | undefined,
  source: T,
  deliver: (session: T) => void,
): boolean {
  if (current !== source) return false;
  deliver(source);
  return true;
}
