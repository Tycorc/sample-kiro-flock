import {
  amorphousNeighbours,
  meshNeighbours,
  selectNeighbours,
} from "./neighbourSelector";

describe("amorphousNeighbours", () => {
  test("radius 0 yields no neighbours", () => {
    expect(amorphousNeighbours(0, 8, 0)).toEqual([]);
  });

  test("concurrency 1 yields no neighbours", () => {
    expect(amorphousNeighbours(0, 1, 2)).toEqual([]);
  });

  test("ring wraps around, excludes self, deduped and sorted", () => {
    // agent 0, 8 peers, radius 2 → {7,1,6,2} minus self → sorted
    expect(amorphousNeighbours(0, 8, 2)).toEqual([1, 2, 6, 7]);
  });

  test("interior index, radius 1", () => {
    expect(amorphousNeighbours(3, 8, 1)).toEqual([2, 4]);
  });

  test("radius >= concurrency does not duplicate or include self", () => {
    const r = amorphousNeighbours(0, 4, 10);
    expect(r).toEqual([1, 2, 3]);
    expect(r).not.toContain(0);
  });
});

describe("meshNeighbours", () => {
  test("returns every agent except self", () => {
    expect(meshNeighbours(2, 5)).toEqual([0, 1, 3, 4]);
  });

  test("single agent has no neighbours", () => {
    expect(meshNeighbours(0, 1)).toEqual([]);
  });
});

describe("selectNeighbours (pure dispatch paths)", () => {
  const base = {
    concurrency: 8,
    neighbourRadius: 2,
    swarmK: 3,
    bucket: "b",
    region: "r",
  };

  test("amorphous dispatches to the ring selector", async () => {
    const r = await selectNeighbours({ ...base, algorithm: "amorphous", agentIndex: 0 });
    expect(r).toEqual([1, 2, 6, 7]);
  });

  test("mesh dispatches to all-but-self", async () => {
    const r = await selectNeighbours({ ...base, algorithm: "mesh", agentIndex: 1, concurrency: 4 });
    expect(r).toEqual([0, 2, 3]);
  });
});
