// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/markdown";

/** Render into a detached host, the way `pr-view.ts` mounts it. */
function md(src: string): HTMLElement {
  const host = document.createElement("div");
  host.append(renderMarkdown(src));
  return host;
}

/** The whole reason this module builds nodes instead of producing an HTML string.
 *  A description is written by anyone who can open a pull request against a
 *  repository somebody added as a workspace, and it is displayed in a window that can
 *  call `invoke`. There is no sanitiser to misconfigure here — `textContent` cannot
 *  produce an element — and these are the tests that keep it that way. */
describe("markup in a description never becomes markup", () => {
  it("renders an injected script tag as characters", () => {
    const host = md("Hello <script>alert(1)</script> world");
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders an img with an onerror handler as characters", () => {
    const host = md('<img src=x onerror="alert(1)">');
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("onerror");
  });

  it("refuses a javascript: link and keeps its text", () => {
    const host = md("[click me](javascript:alert(1))");
    expect(host.querySelector("a")).toBeNull();
    // Not silently dropped — deleting it would leave a hole in the sentence.
    expect(host.textContent).toContain("click me");
  });

  it("refuses data: and vbscript: links too", () => {
    for (const bad of ["data:text/html,<script>1</script>", "vbscript:msgbox"]) {
      expect(md(`[x](${bad})`).querySelector("a")).toBeNull();
    }
  });

  it("never emits an img element, even for a well-formed image", () => {
    // Rendering one would make expanding a row fetch an arbitrary URL — a tracking
    // pixel at best. The alt text and a link say the same thing without the request.
    const host = md("![a diagram](https://example.test/d.png)");
    expect(host.querySelector("img")).toBeNull();
    const a = host.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.test/d.png");
    expect(a.textContent).toContain("a diagram");
  });

  it("leaves a relative link as text, rather than guessing a base", () => {
    // Relative to the repository, which this module has no way to know.
    const host = md("see [the guide](../CONTRIBUTING.md)");
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("the guide");
  });

  it("gives every link it does make target and rel", () => {
    const a = md("[x](https://example.test/p)").querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noreferrer");
  });
});

describe("the structure a <pre> could not express", () => {
  it("makes a real table", () => {
    const host = md("| check | result |\n|---|---|\n| tsc | clean |\n| tests | 586 |");
    expect(host.querySelectorAll("th")).toHaveLength(2);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(host.querySelector("th")!.textContent).toBe("check");
  });

  it("starts headings at h4, under the screen's own h3", () => {
    const host = md("# one\n\n## two\n\n### three\n\n#### four\n\n##### five");
    const levels = [...host.querySelectorAll(".md-head")].map((h) => h.tagName);
    // Clamped at h6 rather than running off the end of the scale.
    expect(levels).toEqual(["H4", "H5", "H6", "H6", "H6"]);
  });

  it("keeps a fenced block as one unwrapped run", () => {
    const host = md("```ts\nconst x = 1;\nconst y = 2;\n```");
    const pre = host.querySelector("pre.md-pre")!;
    expect(pre.textContent).toBe("const x = 1;\nconst y = 2;");
    expect(pre.querySelector("code")).not.toBeNull();
  });

  it("renders a task list as disabled boxes", () => {
    const host = md("- [x] done\n- [ ] not done");
    const boxes = host.querySelectorAll<HTMLInputElement>("input.md-task");
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    // A description is a record, not a control: an operable box here would promise
    // a write this screen cannot perform.
    expect([...boxes].every((b) => b.disabled)).toBe(true);
  });

  /** The regression that got through the unit tests and was caught by eye in the
   *  static harness: a tight list item is a block-level `text` token whose children
   *  are *inline*. Handling it as a block turned one bullet into four stacked lines
   *  and printed an inline code span as literal backticks. */
  it("keeps a tight list item on one line, with its inline markup intact", () => {
    const host = md("- **bold**, so `gh` runs as the right identity.");
    const li = host.querySelector("li.md-item")!;

    expect(li.querySelector("strong")!.textContent).toBe("bold");
    expect(li.querySelector("code.md-code")!.textContent).toBe("gh");
    // Backticks would mean the inline pass never ran.
    expect(li.textContent).not.toContain("`");
    // One line, not four: no block-level element inside the item.
    expect(li.querySelector("p, div, h4, h5, h6")).toBeNull();
    expect(li.textContent).toBe("bold, so gh runs as the right identity.");
  });

  it("does not leak the task marker into the item's text", () => {
    const host = md("- [x] contrast measured");
    const li = host.querySelector("li.md-item")!;
    expect(li.textContent).not.toContain("[x]");
    expect(li.textContent!.trim()).toBe("contrast measured");
  });

  it("nests a list inside a list", () => {
    const host = md("- one\n- two\n  - inner");
    expect(host.querySelectorAll("ul")).toHaveLength(2);
    expect(host.querySelector("li ul")).not.toBeNull();
  });

  it("carries emphasis, strong and inline code through", () => {
    const host = md("a *slanted* and **heavy** word with `code`");
    expect(host.querySelector("em")!.textContent).toBe("slanted");
    expect(host.querySelector("strong")!.textContent).toBe("heavy");
    expect(host.querySelector("code.md-code")!.textContent).toBe("code");
  });

  it("keeps a blockquote and a rule", () => {
    const host = md("> quoted\n\n---\n");
    expect(host.querySelector("blockquote.md-quote")!.textContent).toContain("quoted");
    expect(host.querySelector("hr.md-hr")).not.toBeNull();
  });
});

describe("inputs that must not throw", () => {
  it("survives an empty string", () => {
    expect(md("").childNodes).toHaveLength(0);
  });

  it("survives an unterminated fence", () => {
    expect(() => md("```ts\nconst x = 1;")).not.toThrow();
  });

  it("survives a malformed table", () => {
    expect(() => md("| a | b\n|---\n| 1")).not.toThrow();
  });

  it("survives a link with an unparseable href", () => {
    expect(() => md("[x](http://[::bad::])")).not.toThrow();
    expect(md("[x](http://[::bad::])").querySelector("a")).toBeNull();
  });
});
