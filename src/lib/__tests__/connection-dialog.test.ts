import { describe, it, expect } from "vitest";
import { parseClientError, clientErrorMessage } from "../../types/protocol";

describe("parseClientError", () => {
  it("parses JSON client error from error message", () => {
    const err = parseClientError(new Error('{"kind":"auth","message":"bad password"}'));
    expect(err.kind).toBe("auth");
    if (err.kind === "auth") {
      expect(err.message).toBe("bad password");
    }
  });

  it("falls back to message kind for plain text", () => {
    const err = parseClientError(new Error("connection refused"));
    expect(err.kind).toBe("message");
  });

  it("handles non-Error throws", () => {
    const err = parseClientError("some string error");
    expect(err.kind).toBe("message");
  });

  it("handles brace prefix stripping", () => {
    const err = parseClientError(
      new Error('TauriError: {"kind":"notFound","message":"session gone"}'),
    );
    expect(err.kind).toBe("notFound");
  });
});

describe("clientErrorMessage", () => {
  it("returns message for simple errors", () => {
    expect(clientErrorMessage({ kind: "message", message: "foo" })).toBe("foo");
  });

  it("returns Chinese text for hostKeyChanged", () => {
    const msg = clientErrorMessage({
      kind: "hostKeyChanged",
      fingerprint: "SHA256:abc",
      host: "example.com:22",
    });
    expect(msg).toContain("主机密钥已变更");
    expect(msg).toContain("example.com:22");
  });

  it("returns Chinese text for hostKeyUnknown", () => {
    const msg = clientErrorMessage({
      kind: "hostKeyUnknown",
      fingerprint: "SHA256:xyz",
      host: "h:22",
    });
    expect(msg).toContain("未知主机密钥");
  });

  it("returns message for auth errors", () => {
    expect(
      clientErrorMessage({ kind: "auth", message: "password rejected" }),
    ).toBe("password rejected");
  });
});
