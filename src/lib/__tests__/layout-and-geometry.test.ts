import { describe, expect, it } from "vitest";
import {
  clampLayoutSidebar,
  clampLayoutSplit,
} from "../layoutPersist";
import { estimateTerminalGeometryFromSize } from "../terminalGeometry";
import { pathBasename } from "../../stores/transfers";

describe("clampLayoutSidebar", () => {
  it("clamps to [180, 480]", () => {
    expect(clampLayoutSidebar(100)).toBe(180);
    expect(clampLayoutSidebar(260)).toBe(260);
    expect(clampLayoutSidebar(999)).toBe(480);
    expect(clampLayoutSidebar(200.7)).toBe(201);
  });
});

describe("clampLayoutSplit", () => {
  it("clamps to [0.2, 0.65]", () => {
    expect(clampLayoutSplit(0)).toBe(0.2);
    expect(clampLayoutSplit(0.5)).toBe(0.5);
    expect(clampLayoutSplit(0.9)).toBe(0.65);
  });
});

describe("estimateTerminalGeometryFromSize", () => {
  it("never goes below 80x24", () => {
    const g = estimateTerminalGeometryFromSize(10, 10);
    expect(g.cols).toBe(80);
    expect(g.rows).toBe(24);
  });

  it("scales with large pane", () => {
    const g = estimateTerminalGeometryFromSize(1200, 800, 14);
    expect(g.cols).toBeGreaterThan(80);
    expect(g.rows).toBeGreaterThan(24);
    expect(g.cols).toBeLessThanOrEqual(300);
    expect(g.rows).toBeLessThanOrEqual(120);
  });
});

describe("pathBasename", () => {
  it("handles unix and windows paths", () => {
    expect(pathBasename("/a/b/c.txt")).toBe("c.txt");
    expect(pathBasename("C:\\\\Users\\\\x\\\\f.sh")).toBe("f.sh");
    expect(pathBasename("plain")).toBe("plain");
  });
});
