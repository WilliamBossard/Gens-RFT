import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useTransferStore } from "../src/store/useTransferStore.ts";

describe("useTransferStore", () => {
  beforeEach(() => {
    useTransferStore.setState({ queue: [], maxConcurrent: 2, scheduleTick: 0 });
  });

  it("enqueues transfers, preserves cancelled status, and clears finished items", () => {
    const store = useTransferStore.getState();
    store.addToQueue({
      sessionId: "tab_1",
      filename: "archive.tar.gz",
      sourcePath: "/tmp/archive.tar.gz",
      destDir: "/var/www",
      destFileName: "archive.tar.gz",
      direction: "upload",
      isDir: false,
    });
    store.addToQueue({
      sessionId: "tab_1",
      filename: "readme.md",
      sourcePath: "/tmp/readme.md",
      destDir: "/var/www",
      destFileName: "readme.md",
      direction: "upload",
      isDir: false,
    });

    const items = useTransferStore.getState().queue;
    assert.equal(items.length, 2);
    assert.equal(items[0].status, "queued");

    store.markManyRunning([items[0].id]);
    assert.equal(useTransferStore.getState().queue[0].status, "running");

    // Simulate cancellation race: once cancelled, a late markStatus("error") cannot overwrite it
    useTransferStore.setState((s) => ({
      queue: s.queue.map((it) => (it.id === items[0].id ? { ...it, status: "cancelled" } : it)),
    }));
    store.markStatus(items[0].id, "error", "late failure");
    assert.equal(useTransferStore.getState().queue[0].status, "cancelled");

    const tickBefore = useTransferStore.getState().scheduleTick;
    store.markStatus(items[1].id, "done");
    assert.equal(useTransferStore.getState().queue[1].percent, 100);
    assert.equal(useTransferStore.getState().scheduleTick, tickBefore + 1);

    store.clearDone();
    assert.equal(useTransferStore.getState().queue.length, 0);
  });

  it("updates progress, resets relay baseline, and bumps scheduleTick on setMaxConcurrent", () => {
    const store = useTransferStore.getState();
    const t0 = useTransferStore.getState().scheduleTick;
    store.setMaxConcurrent(4);
    assert.equal(useTransferStore.getState().maxConcurrent, 4);
    assert.equal(useTransferStore.getState().scheduleTick, t0 + 1);

    store.addToQueue({
      sessionId: "tab_2",
      filename: "video.mp4",
      sourcePath: "/tmp/video.mp4",
      destDir: "C:\\Downloads",
      destFileName: "video.mp4",
      direction: "download",
      isDir: false,
    });
    const item = useTransferStore.getState().queue[0];
    store.markManyRunning([item.id]);
    useTransferStore.setState((s) => ({
      queue: s.queue.map((it) =>
        it.id === item.id ? { ...it, lastTimestamp: Date.now() - 1000 } : it
      ),
    }));
    store.updateProgress(item.id, 450, 1000, 145);
    assert.equal(useTransferStore.getState().queue[0].percent, 100);
    assert.equal(useTransferStore.getState().queue[0].lastBytes, 450);

    // Relay transition (transferred < lastBytes) resets speed/eta baseline
    store.updateProgress(item.id, 100, 1000, 10);
    assert.equal(useTransferStore.getState().queue[0].percent, 10);
    assert.equal(useTransferStore.getState().queue[0].lastBytes, 100);
    assert.equal(useTransferStore.getState().queue[0].speed, "-- Mo/s");

    // Explicit resetProgress resets even when transferred was 0
    store.resetProgress(item.id);
    assert.equal(useTransferStore.getState().queue[0].percent, 0);
    assert.equal(useTransferStore.getState().queue[0].lastBytes, 0);
    assert.equal(useTransferStore.getState().queue[0].speed, "-- Mo/s");
    assert.equal(useTransferStore.getState().queue[0].eta, "--");
  });

  it("prunes oldest finished items beyond 500 while preserving active items", () => {
    const store = useTransferStore.getState();
    for (let i = 0; i < 510; i++) {
      store.addToQueue({
        sessionId: "tab_1",
        filename: `file_${i}.txt`,
        sourcePath: `/tmp/file_${i}.txt`,
        destDir: "/var/www",
        destFileName: `file_${i}.txt`,
        direction: "upload",
        isDir: false,
      });
    }
    const items = useTransferStore.getState().queue;
    for (let i = 0; i < 505; i++) {
      store.markStatus(items[i].id, "done");
    }
    const finalQueue = useTransferStore.getState().queue;
    assert.equal(finalQueue.length, 505); // 500 finished + 5 queued
    assert.equal(finalQueue.filter((q) => q.status === "queued").length, 5);
    assert.equal(finalQueue[0].filename, "file_5.txt");
  });
});
