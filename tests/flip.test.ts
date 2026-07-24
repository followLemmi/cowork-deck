import { describe, it, expect } from "vitest";
import { flipTransform, zoomParticipants } from "../src/flip";

describe("flipTransform", () => {
  it("computes translate + scale from last back onto first", () => {
    const first = { left: 0, top: 0, width: 200, height: 100 };
    const last = { left: 50, top: 20, width: 400, height: 300 };
    expect(flipTransform(first, last)).toEqual({ dx: -50, dy: -20, sx: 0.5, sy: 100 / 300 });
  });
  it("is identity when rects match", () => {
    const r = { left: 10, top: 10, width: 100, height: 100 };
    expect(flipTransform(r, { ...r })).toEqual({ dx: 0, dy: 0, sx: 1, sy: 1 });
  });
  it("guards against a zero last dimension (no Infinity)", () => {
    const first = { left: 0, top: 0, width: 100, height: 100 };
    const last = { left: 0, top: 0, width: 0, height: 0 };
    expect(flipTransform(first, last)).toEqual({ dx: 0, dy: 0, sx: 1, sy: 1 });
  });
});

describe("zoomParticipants", () => {
  const t = (session: string, hidden = false) => ({ session, hidden });
  it("returns no zoom when zoomedSession is null", () => {
    expect(zoomParticipants([t("a"), t("b")], null)).toEqual({ zoomed: null, minimized: [] });
  });
  it("splits zoomed vs minimized over visible tiles, preserving order", () => {
    expect(zoomParticipants([t("a"), t("b"), t("c")], "b"))
      .toEqual({ zoomed: "b", minimized: ["a", "c"] });
  });
  it("excludes ws-hidden tiles from the strip", () => {
    expect(zoomParticipants([t("a"), t("b", true), t("c")], "a"))
      .toEqual({ zoomed: "a", minimized: ["c"] });
  });
  it("is a no-op (zoomed null) when 1 or fewer visible tiles", () => {
    expect(zoomParticipants([t("a"), t("b", true)], "a")).toEqual({ zoomed: null, minimized: [] });
  });
  it("is a no-op when the zoomed session is hidden or unknown", () => {
    expect(zoomParticipants([t("a"), t("b")], "b-hidden")).toEqual({ zoomed: null, minimized: [] });
    expect(zoomParticipants([t("a"), t("b", true)], "b")).toEqual({ zoomed: null, minimized: [] });
  });
});
