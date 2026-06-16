import { parseTail } from "./tailParser";

const entry = (ts: string, iteration: number): string =>
  JSON.stringify({ ts, iteration, action: "a", result: "r", next_intent: "n" });

describe("parseTail", () => {
  test("empty input yields all nulls", () => {
    expect(parseTail("")).toEqual({
      lastEntry: null,
      prevEntry: null,
      lastUpdatedTs: null,
    });
  });

  test("a single complete line is kept (not treated as a partial)", () => {
    const r = parseTail(entry("t1", 1)); // default isPartial=true, but only 1 line
    expect(r.lastEntry?.iteration).toBe(1);
    expect(r.prevEntry).toBeNull();
    expect(r.lastUpdatedTs).toBe("t1");
  });

  test("partial ranged read drops the leading partial line", () => {
    const text = "rtial-record-fragment\n" + entry("t2", 2);
    const r = parseTail(text, true);
    expect(r.lastEntry?.iteration).toBe(2);
    expect(r.prevEntry).toBeNull();
  });

  test("non-partial read keeps all lines and returns last + prev", () => {
    const text = [entry("t1", 1), entry("t2", 2), entry("t3", 3)].join("\n");
    const r = parseTail(text, false);
    expect(r.lastEntry?.iteration).toBe(3);
    expect(r.prevEntry?.iteration).toBe(2);
    expect(r.lastUpdatedTs).toBe("t3");
  });

  test("malformed JSON lines are skipped", () => {
    const text = ["{ not json", entry("t9", 9)].join("\n");
    const r = parseTail(text, false);
    expect(r.lastEntry?.iteration).toBe(9);
  });

  test("trailing whitespace/newlines are tolerated", () => {
    const text = entry("t5", 5) + "\n   \n";
    const r = parseTail(text, false);
    expect(r.lastEntry?.iteration).toBe(5);
  });
});
