import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rename as fsRename, rm } from "node:fs/promises";
import { BatchCoordinator, BatchStore, MAX_BATCH_SIZE, validateBatchApproval } from "../src/batches.js";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-batches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let id = 0;
  const store = new BatchStore(root, {
    randomUUID: () => `batch-${++id}`,
    now: () => new Date("2026-11-01T12:00:00.000Z"),
    ...overrides,
  });
  await store.initialize();
  const project = {
    id: "project-1",
    name: "Night Drive",
    tracks: Array.from({ length: 6 }, (_, index) => ({
      id: `track-${index + 1}`,
      title: `Track ${index + 1}`,
      direction: `Direction ${index + 1}`,
      prompt: `Instrumental prompt number ${index + 1} with no vocals.`,
      status: "Pending",
    })),
  };
  const projects = {
    list: () => structuredClone([project]),
    getTrack: (projectId, trackId) => ({
      project: structuredClone(project),
      track: structuredClone(project.tracks.find((track) => track.id === trackId)),
    }),
  };
  return { root, store, project, projects };
}

function snapshot(project, count, start = 0) {
  return {
    projectName: project.name,
    tracks: project.tracks.slice(start, start + count).map(({ id, title, direction, prompt }) => ({ id, title, direction, prompt })),
  };
}

async function waitForTerminal(coordinator, id) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const batch = coordinator.get(id);
    if (["completed", "failed", "stopped", "interrupted"].includes(batch.status)) return batch;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Batch did not reach a terminal state.");
}

for (let size = 1; size <= MAX_BATCH_SIZE; size += 1) {
  test(`accepts a batch of ${size} and performs exactly ${size} sequential requests`, async (t) => {
    const { store, project, projects } = await fixture(t);
    const calls = [];
    let inFlight = 0;
    const coordinator = new BatchCoordinator({
      store, projects,
      generateTrack: async (_projectId, trackId) => {
        inFlight += 1;
        assert.equal(inFlight, 1);
        calls.push(trackId);
        await Promise.resolve();
        inFlight -= 1;
        return { filename: `${trackId}.mp3`, libraryTrackId: `library-${trackId}` };
      },
    });
    const started = await coordinator.start(project.id, snapshot(project, size));
    const finished = await waitForTerminal(coordinator, started.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.authorizedRequestCount, size);
    assert.equal(finished.requestsStarted, size);
    assert.equal(finished.completed.length, size);
    assert.deepEqual(calls, project.tracks.slice(0, size).map((track) => track.id));
  });
}

test("rejects empty, oversized, duplicate, reordered, generated, and stale approvals", async (t) => {
  const { project, projects } = await fixture(t);
  assert.throws(() => validateBatchApproval(projects.list(), project.id, snapshot(project, 0)), /between 1 and 5/);
  assert.throws(() => validateBatchApproval(projects.list(), project.id, snapshot(project, 6)), /between 1 and 5/);
  const duplicate = snapshot(project, 2);
  duplicate.tracks[1] = duplicate.tracks[0];
  assert.throws(() => validateBatchApproval(projects.list(), project.id, duplicate), /only appear once/);
  const reordered = snapshot(project, 2);
  reordered.tracks.reverse();
  assert.throws(() => validateBatchApproval(projects.list(), project.id, reordered), /project order/);
  project.tracks[0].status = "Generated";
  assert.throws(() => validateBatchApproval(projects.list(), project.id, snapshot(project, 1)), /already generated/);
  project.tracks[0].status = "Pending";
  const stale = snapshot(project, 1);
  stale.tracks[0].prompt = "An outdated prompt that must never be charged.";
  assert.throws(() => validateBatchApproval(projects.list(), project.id, stale), /changed after it was displayed/);
});

test("stops on first failure without retrying or starting another request", async (t) => {
  const { store, project, projects } = await fixture(t);
  const calls = [];
  const coordinator = new BatchCoordinator({
    store, projects, logger: { error() {} },
    generateTrack: async (_projectId, trackId) => {
      calls.push(trackId);
      if (calls.length === 2) throw new Error("provider failed");
      return { filename: `${trackId}.mp3`, libraryTrackId: `library-${trackId}` };
    },
  });
  const started = await coordinator.start(project.id, snapshot(project, 4));
  const finished = await waitForTerminal(coordinator, started.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.requestsStarted, 2);
  assert.equal(finished.completed.length, 1);
  assert.equal(finished.outcomeUncertain, true);
  assert.deepEqual(calls, ["track-1", "track-2"]);
});

test("stop waits for the in-flight request and prevents every later request", async (t) => {
  const { store, project, projects } = await fixture(t);
  let release;
  const inFlight = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const coordinator = new BatchCoordinator({
    store, projects,
    generateTrack: async (_projectId, trackId) => {
      calls.push(trackId);
      await inFlight;
      return { filename: `${trackId}.mp3`, libraryTrackId: `library-${trackId}` };
    },
  });
  const started = await coordinator.start(project.id, snapshot(project, 3));
  while (coordinator.get(started.id).requestsStarted === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  await coordinator.stop(started.id);
  release();
  const finished = await waitForTerminal(coordinator, started.id);
  assert.equal(finished.status, "stopped");
  assert.equal(finished.completed.length, 1);
  assert.deepEqual(calls, ["track-1"]);
});

test("rejects duplicate starts and protects single-generation concurrency", async (t) => {
  const { store, project, projects } = await fixture(t);
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const coordinator = new BatchCoordinator({
    store, projects,
    generateTrack: async (_projectId, trackId) => {
      await hold;
      return { filename: `${trackId}.mp3`, libraryTrackId: `library-${trackId}` };
    },
  });
  const started = await coordinator.start(project.id, snapshot(project, 1));
  assert.equal(coordinator.hasActive(), true);
  await assert.rejects(() => coordinator.start(project.id, snapshot(project, 1, 1)), /already active/);
  release();
  await waitForTerminal(coordinator, started.id);
  assert.equal(coordinator.hasActive(), false);
});

test("a stale track detected between requests stops before another paid call", async (t) => {
  const { store, project, projects } = await fixture(t);
  const calls = [];
  const coordinator = new BatchCoordinator({
    store, projects,
    generateTrack: async (_projectId, trackId) => {
      calls.push(trackId);
      project.tracks[1].prompt = "Changed after batch approval and before the second request.";
      return { filename: `${trackId}.mp3`, libraryTrackId: `library-${trackId}` };
    },
  });
  const started = await coordinator.start(project.id, snapshot(project, 3));
  const finished = await waitForTerminal(coordinator, started.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.outcomeUncertain, false);
  assert.deepEqual(calls, ["track-1"]);
});

test("persistence failure after a completed paid call stops the batch and preserves completion evidence", async (t) => {
  let failNextBatchRename = false;
  const { root, store, project, projects } = await fixture(t, {
    rename: async (source, destination) => {
      if (failNextBatchRename && path.basename(destination) === "batches.json") {
        failNextBatchRename = false;
        throw new Error("simulated batch persistence failure");
      }
      return fsRename(source, destination);
    },
  });
  const calls = [];
  const coordinator = new BatchCoordinator({
    store, projects, logger: { error() {} },
    generateTrack: async (_projectId, trackId) => {
      calls.push(trackId);
      failNextBatchRename = true;
      return { filename: `${trackId}.mp3`, libraryTrackId: `library-${trackId}` };
    },
  });
  const started = await coordinator.start(project.id, snapshot(project, 2));
  const finished = await waitForTerminal(coordinator, started.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.requestsStarted, 1);
  assert.deepEqual(calls, ["track-1"]);
  assert.match(await readFile(path.join(root, "batches.json"), "utf8"), /"status": "failed"/);
});

test("restart marks unfinished work interrupted and never resumes it", async (t) => {
  const { root, store, project } = await fixture(t);
  const approval = validateBatchApproval([project], project.id, snapshot(project, 2));
  const batch = await store.create(approval);
  await store.update(batch.id, (current) => {
    current.status = "running";
    current.requestsStarted = 1;
    current.currentTrackId = current.tracks[0].id;
  });

  let paidCalls = 0;
  const restarted = new BatchStore(root);
  await restarted.initialize();
  const recovered = restarted.get(batch.id);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.requestsStarted, 1);
  assert.equal(recovered.stopRequested, true);
  assert.equal(paidCalls, 0);
});
