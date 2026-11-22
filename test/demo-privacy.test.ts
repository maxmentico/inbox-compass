import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The portfolio demo must never use real inboxes or a captured production digest.
// Restricting addresses to the reserved .invalid name space makes accidental leaks
// easier to catch in CI. Source names and subject lines still need human review.
const demo = readFileSync(new URL("../demo/index.html", import.meta.url), "utf8");

describe("synthetic portfolio demo privacy", () => {
  it("contains only reserved fictional mailbox addresses", () => {
    const addresses = demo.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(addresses).toHaveLength(6);
    for (const address of addresses) expect(address).toMatch(/@(?:[a-z\d-]+\.)?example\.invalid$/i);
  });

  it("is explicitly synthetic and contains no outbound URLs or network calls", () => {
    expect(demo).toContain("SYNTHETIC DEMO");
    expect(demo).toContain("No live email");
    expect(demo).not.toMatch(/https?:\/\//i);
    expect(demo).not.toMatch(/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(/);
  });
});
