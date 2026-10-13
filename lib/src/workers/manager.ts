import { config } from "../config";
import { createLogger } from "../logger";
import { ResilientLoop } from "./resilientLoop";
import { discoverPeers, pollPeerTasks } from "../a2a/discovery";
import { acquireTask, executeAndSettle } from "./pipeline";
import { store } from "../storage";

const log = createLogger("workers");

/**
 * Owns every background loop for the node and starts them on process boot.
 *
 * This is the "zero manual trigger" entry point (requirement 4): nothing here
 * is exposed as an HTTP endpoint to kick off; it runs continuously.
 *
 * Together the loops implement the end-to-end acquisition pipeline
 * (requirement 3), always on:
 *   Phase 1  Discovery            -> discoveryLoop (poll registries + seeds)
 *   Phase 2  Outreach & handshake -> discoveryLoop (handshake) + acquisitionLoop
 *   Phase 3  Evaluation & pricing -> acquisitionLoop -> acquireTask -> evaluateOffer
 *   Phase 4  Bargaining & settle  -> acquireTask (runBargain) + settlementLoop
 */
export class WorkerManager {
  private loops: ResilientLoop[] = [];
  private started = false;

  /** Phase 1 + 2: find active agents globally and handshake with them. */
  private discoveryLoop(): ResilientLoop {
    return new ResilientLoop(
      "discovery",
      async () => {
        await discoverPeers();
      },
      {
        intervalMs: config.a2a.discoveryIntervalMs,
        errorBackoffMs: config.workers.errorBackoffMs,
        maxBackoffMs: config.workers.maxBackoffMs,
      },
    );
  }

  /** Phase 2 + 3: poll online peers for tasks, value them, negotiate, accept. */
  private acquisitionLoop(): ResilientLoop {
    return new ResilientLoop(
      "acquisition",
      async () => {
        const peers = await store.peers.find((p) => p.status === "online");
        for (const peer of peers) {
          try {
            const remoteTasks = await pollPeerTasks(peer);
            for (const remote of remoteTasks) {
              const acquired = await acquireTask(peer, remote);
              if (acquired?.accepted) {
                log.info("task acquired", { taskId: acquired.task.id });
              }
            }
          } catch (err) {
            // One bad peer must not stop the others.
            log.warn("peer acquisition failed", {
              peer: peer.id,
              error: (err as Error).message,
            });
          }
        }
      },
      {
        intervalMs: config.a2a.discoveryIntervalMs,
        errorBackoffMs: config.workers.errorBackoffMs,
        maxBackoffMs: config.workers.maxBackoffMs,
      },
    );
  }

  /** Phase 4: execute accepted tasks and settle earnings via Whop. */
  private settlementLoop(): ResilientLoop {
    return new ResilientLoop(
      "settlement",
      async () => {
        const accepted = await store.tasks.find((t) => t.status === "accepted");
        for (const task of accepted) {
          try {
            await executeAndSettle(task);
          } catch (err) {
            log.error("settlement failed", {
              taskId: task.id,
              error: (err as Error).message,
            });
          }
        }
      },
      {
        intervalMs: config.workers.settlementIntervalMs,
        errorBackoffMs: config.workers.errorBackoffMs,
        maxBackoffMs: config.workers.maxBackoffMs,
      },
    );
  }

  /** Heartbeat: keep peer liveness fresh and prune stale peers. */
  private heartbeatLoop(): ResilientLoop {
    return new ResilientLoop(
      "heartbeat",
      async () => {
        const peers = await store.peers.all();
        const cutoff = Date.now() - config.a2a.discoveryIntervalMs * 10;
        for (const peer of peers) {
          if (new Date(peer.lastSeen).getTime() < cutoff && peer.status === "online") {
            await store.peers.update(peer.id, { status: "offline" });
          }
        }
      },
      {
        intervalMs: config.a2a.discoveryIntervalMs * 5,
        errorBackoffMs: config.workers.errorBackoffMs,
        maxBackoffMs: config.workers.maxBackoffMs,
        runImmediately: false,
      },
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loops = [
      this.discoveryLoop(),
      this.acquisitionLoop(),
      this.settlementLoop(),
      this.heartbeatLoop(),
    ];
    for (const loop of this.loops) loop.start();
    log.info("all background workers started", {
      loops: this.loops.map((l) => l.name),
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.loops.map((l) => l.stop()));
    this.started = false;
  }

  status() {
    return {
      started: this.started,
      loops: this.loops.map((l) => l.status()),
    };
  }
}

export const workerManager = new WorkerManager();
