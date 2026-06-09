import { describe, expect, it } from "vitest";
import { selectCodexSpawnCwd } from "./codexWorkspaceCwd";

describe("selectCodexSpawnCwd", () => {
  it("keeps a Windows cwd inside the workspace", () => {
    expect(
      selectCodexSpawnCwd(
        "C:\\Users\\op237\\project\\src",
        "C:\\Users\\op237\\project",
      ),
    ).toBe("C:\\Users\\op237\\project\\src");
  });

  it("falls back to the Windows workspace root when cwd is outside", () => {
    expect(
      selectCodexSpawnCwd("C:\\Users", "C:\\Users\\op237\\project"),
    ).toBe("C:\\Users\\op237\\project");
  });

  it("handles extended Windows paths before comparing", () => {
    expect(
      selectCodexSpawnCwd("\\\\?\\C:\\Users", "C:\\Users\\op237\\project"),
    ).toBe("C:\\Users\\op237\\project");
  });

  it("does not treat sibling Windows paths as children", () => {
    expect(
      selectCodexSpawnCwd(
        "C:\\Users\\op237\\project-old",
        "C:\\Users\\op237\\project",
      ),
    ).toBe("C:\\Users\\op237\\project");
  });

  it("keeps a Unix cwd inside the workspace", () => {
    expect(selectCodexSpawnCwd("/Users/me/project/src", "/Users/me/project"))
      .toBe("/Users/me/project/src");
  });

  it("falls back to the Unix workspace root when cwd is outside", () => {
    expect(selectCodexSpawnCwd("/Users/me", "/Users/me/project")).toBe(
      "/Users/me/project",
    );
  });

  it("uses workspace root when there is no cwd", () => {
    expect(selectCodexSpawnCwd(null, "/Users/me/project")).toBe(
      "/Users/me/project",
    );
  });

  it("uses cwd when no workspace root is available", () => {
    expect(selectCodexSpawnCwd("/tmp", null)).toBe("/tmp");
  });
});
