type ComparablePath = {
  path: string;
  windows: boolean;
};

export function selectCodexSpawnCwd(
  cwd: string | null,
  workspaceRoot: string | null,
): string | null {
  const root = cleanPath(workspaceRoot);
  const current = cleanPath(cwd);
  if (!root) return current;
  if (!current) return root;
  return isInsideOrSamePath(current, root) ? current : root;
}

function isInsideOrSamePath(candidate: string, root: string): boolean {
  const current = comparablePath(candidate);
  const base = comparablePath(root);
  if (current.windows !== base.windows) return false;
  if (current.path === base.path) return true;
  const separator = current.windows ? "\\" : "/";
  const prefix = base.path.endsWith(separator)
    ? base.path
    : `${base.path}${separator}`;
  return current.path.startsWith(prefix);
}

function comparablePath(value: string): ComparablePath {
  const windows = isWindowsPath(value);
  let path = windows ? value.replace(/\//g, "\\") : value.replace(/\/+/g, "/");
  path = stripTrailingSeparators(path, windows);
  return {
    path: windows ? path.toLowerCase() : path,
    windows,
  };
}

function cleanPath(value: string | null): string | null {
  const path = value?.trim();
  if (!path) return null;
  return stripExtendedWindowsPrefix(path);
}

function stripExtendedWindowsPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) {
    return path.replace(/^\\\\\?\\UNC\\/i, "\\\\");
  }
  return path.replace(/^\\\\\?\\/i, "");
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function stripTrailingSeparators(path: string, windows: boolean): string {
  const separator = windows ? "\\" : "/";
  const minLength = windows && /^[a-zA-Z]:\\/.test(path) ? 3 : 1;
  while (path.length > minLength && path.endsWith(separator)) {
    path = path.slice(0, -1);
  }
  return path;
}
