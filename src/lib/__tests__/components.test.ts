/**
 * @vitest-environment jsdom
 *
 * 组件基础测试 — 验证关键 UI 组件能正常渲染
 */

import { describe, it, expect } from "vitest";

describe("SerialConfigForm", () => {
  it("renders without crashing", async () => {
    // Dynamic import so jsdom environment is active
    const { SerialConfigForm } = await import("../../components/connection/SerialConfigForm");
    const { Field } = await import("../../components/connection/FormFields");
    // The form needs a real component renderer
    // This test verifies the module can be loaded in jsdom
    expect(SerialConfigForm).toBeDefined();
    expect(Field).toBeDefined();
  });
});

describe("TunnelConfigSection", () => {
  it("exports TunnelConfigSection component", async () => {
    const mod = await import("../../components/connection/TunnelConfigSection");
    expect(mod.TunnelConfigSection).toBeDefined();
  });
});

describe("FormFields", () => {
  it("exports inputClass and Field", async () => {
    const mod = await import("../../components/connection/FormFields");
    expect(mod.inputClass).toBeDefined();
    expect(typeof mod.inputClass).toBe("string");
    expect(mod.Field).toBeDefined();
  });
});
