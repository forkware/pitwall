// LangGraph checkpoints in the app's SQLite database, so a process waiting for the user survives a restart.
// Follows MemorySaver from @langchain/langgraph-checkpoint, the reference implementation.
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Db } from "./db.ts";

type Row = Record<string, any>;

export class SqliteSaver extends BaseCheckpointSaver {
  private db: Db;
  /** Set when the app shuts down: LangGraph may still write, the database is gone. */
  closed = false;

  constructor(db: Db) {
    super();
    this.db = db;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    const ns = config.configurable?.checkpoint_ns ?? "";
    const id = getCheckpointId(config);
    const row = id
      ? this.db.prepare("SELECT * FROM checkpoints WHERE thread_id = ? AND ns = ? AND id = ?").get(threadId, ns, id)
      : this.db.prepare("SELECT * FROM checkpoints WHERE thread_id = ? AND ns = ? ORDER BY id DESC LIMIT 1").get(threadId, ns);
    return row ? this.toTuple(row as Row) : undefined;
  }

  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const { before, filter } = options;
    let { limit } = options;
    const where: string[] = [];
    const params: (string | number)[] = [];
    const add = (clause: string, value: unknown) => {
      if (value === undefined) return;
      where.push(clause);
      params.push(value as string);
    };
    add("thread_id = ?", config.configurable?.thread_id);
    add("ns = ?", config.configurable?.checkpoint_ns);
    add("id = ?", config.configurable?.checkpoint_id || undefined);
    add("id < ?", before?.configurable?.checkpoint_id || undefined);
    const sql = `SELECT * FROM checkpoints ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY thread_id, ns, id DESC`;
    for (const row of this.db.prepare(sql).all(...params) as Row[]) {
      const tuple = await this.toTuple(row);
      if (filter && !Object.entries(filter).every(([key, value]) => (tuple.metadata as any)?.[key] === value)) continue;
      if (limit !== undefined) {
        if (limit <= 0) break;
        limit -= 1;
      }
      yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _versions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    if (threadId === undefined) throw new Error("A checkpoint needs configurable.thread_id");
    if (this.closed) return config;
    const ns = config.configurable?.checkpoint_ns ?? "";
    const [[type, data], [metaType, meta]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    this.db
      .prepare("INSERT OR REPLACE INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, ns, checkpoint.id, config.configurable?.checkpoint_id ?? null, type, data, metaType, meta);
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id;
    const ns = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;
    if (threadId === undefined || checkpointId === undefined) throw new Error("Writes need thread_id and checkpoint_id");
    if (this.closed) return;
    const serialized = await Promise.all(writes.map(([, value]) => this.serde.dumpsTyped(value)));
    writes.forEach(([channel], i) => {
      const idx = WRITES_IDX_MAP[channel] ?? i;
      // As in MemorySaver: a regular write is kept once, a special one (error, interrupt, resume) is replaced.
      const verb = idx >= 0 ? "INSERT OR IGNORE" : "INSERT OR REPLACE";
      const [type, value] = serialized[i];
      this.db
        .prepare(
          `${verb} INTO checkpoint_writes (thread_id, ns, checkpoint_id, task_id, idx, channel, type, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(threadId, ns, checkpointId, taskId, idx, channel, type, value);
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM checkpoint_writes WHERE thread_id = ?").run(threadId);
  }

  private async toTuple(row: Row): Promise<CheckpointTuple> {
    const writes = this.db
      .prepare("SELECT * FROM checkpoint_writes WHERE thread_id = ? AND ns = ? AND checkpoint_id = ? ORDER BY seq")
      .all(row.thread_id, row.ns, row.id) as Row[];
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: row.thread_id, checkpoint_ns: row.ns, checkpoint_id: row.id } },
      checkpoint: await this.serde.loadsTyped(row.type, row.checkpoint),
      metadata: await this.serde.loadsTyped(row.metadata_type, row.metadata),
      pendingWrites: await Promise.all(
        writes.map(async (w) => [w.task_id, w.channel, await this.serde.loadsTyped(w.type, w.value)] as [string, string, unknown]),
      ),
    };
    if (row.parent_id) {
      tuple.parentConfig = { configurable: { thread_id: row.thread_id, checkpoint_ns: row.ns, checkpoint_id: row.parent_id } };
    }
    return tuple;
  }
}
