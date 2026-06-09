import { describe, expect, it } from "vitest";
import {
  defaultTerminalWebglEnabled,
  shouldAttachTerminalWebgl,
} from "./webglPolicy";

describe("terminal WebGL policy", () => {
  it("disables xterm WebGL on Windows WebView", () => {
    const windowsUa =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

    expect(defaultTerminalWebglEnabled(windowsUa)).toBe(false);
    expect(shouldAttachTerminalWebgl(true, windowsUa)).toBe(false);
  });

  it("keeps xterm WebGL available on macOS", () => {
    const macUa =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15";

    expect(defaultTerminalWebglEnabled(macUa)).toBe(true);
    expect(shouldAttachTerminalWebgl(true, macUa)).toBe(true);
    expect(shouldAttachTerminalWebgl(false, macUa)).toBe(false);
  });
});
