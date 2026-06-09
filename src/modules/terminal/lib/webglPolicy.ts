function userAgentIsWindows(userAgent: string): boolean {
  return /Windows NT|Win64|Win32|WOW64/i.test(userAgent);
}

function currentUserAgent(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

export function defaultTerminalWebglEnabled(
  userAgent = currentUserAgent(),
): boolean {
  return !userAgentIsWindows(userAgent);
}

export function shouldAttachTerminalWebgl(
  preferenceEnabled: boolean,
  userAgent = currentUserAgent(),
): boolean {
  return preferenceEnabled && !userAgentIsWindows(userAgent);
}
