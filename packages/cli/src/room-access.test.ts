import { describe, expect, it } from "vitest";
import { resolveCliCreateAccess } from "./room-access.js";

describe("secure CLI room access defaults", () => {
  it("generates a fresh 192-bit base64url password for each omitted access mode", () => {
    const first = resolveCliCreateAccess({});
    const second = resolveCliCreateAccess({});

    expect(first).toMatchObject({ visibility: "private", passwordGenerated: true });
    expect(first.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second.password).not.toBe(first.password);
  });

  it("does not generate a shared password for explicit access choices", () => {
    expect(resolveCliCreateAccess({ public: "true" })).toMatchObject({
      visibility: "public",
      passwordGenerated: false,
    });
    expect(resolveCliCreateAccess({ unlisted: "true" })).toMatchObject({
      visibility: "unlisted",
      passwordGenerated: false,
    });
    expect(resolveCliCreateAccess({ private: "true" })).toEqual({
      visibility: "private",
      passwordGenerated: false,
      label: "Private — valid invite required",
    });
  });

  it("uses a supplied password only for Private rooms", () => {
    expect(resolveCliCreateAccess({ password: "correct-horse-battery" })).toMatchObject({
      visibility: "private",
      password: "correct-horse-battery",
      passwordGenerated: false,
    });
    expect(() =>
      resolveCliCreateAccess({ public: "true", password: "correct-horse-battery" }),
    ).toThrow("--password can only be used with --visibility=private");
  });
});
