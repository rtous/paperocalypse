import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/markdown";

describe("renderMarkdown", () => {
  it("renders GFM and math", () => {
    const html = renderMarkdown("# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nInline $E=mc^2$ and\n\n$$\n\\int_0^1 x\\,dx\n$$");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain('class="katex"');
    expect(html).toContain("katex-display");
  });

  it.each([
    ["<script>alert(1)</script>", "<script"],
    ['<img src=x onerror="alert(1)">', "onerror"],
    ["[x](javascript:alert(1))", "javascript:"],
    ['<a href="https://evil.test" onclick="x()">hi</a>', "onclick"],
    ["<iframe src=https://evil.test></iframe>", "<iframe"],
    ["<!-- hidden instructions -->", "hidden instructions"],
    ['<div style="position:fixed">x</div>', "style="],
    ["![x](data:image/svg+xml;base64,PHN2Zz4=)", "data:"],
    ["$\\href{javascript:alert(1)}{x}$", 'href="javascript:'],
  ])("neutralises %s", (input, forbidden) => {
    expect(renderMarkdown(input).toLowerCase()).not.toContain(forbidden.toLowerCase());
  });

  it("marks links nofollow ugc noopener", () => {
    const html = renderMarkdown("[site](https://example.org)");
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('rel="nofollow ugc noopener"');
  });
});
