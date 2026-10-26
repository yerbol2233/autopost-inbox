// Commands to the Mac: `commands/<uuid>.json` in, the answer in `outbox/commands/<uuid>.json`.
// Waiting commands are kept in localStorage, so a reload keeps showing «ждёт Mac» and the answer.

import { isoNow } from "./dom.js";
import { readStored, writeStored } from "./storage.js";

const PENDING_KEY = "autopost-pending-commands";

/** Which card a command belongs to: "post:<id>" or "channel:<id>". */
export function targetOf(command) {
  return command.post_id !== undefined ? `post:${command.post_id}` : `channel:${command.channel_id}`;
}

export class CommandQueue {
  constructor(bucket) {
    this.bucket = bucket;
    this.answers = new Map(); // target -> {status, message}, the latest answer of this visit
  }

  pending() {
    return readStored(PENDING_KEY, []);
  }

  waitingFor(target) {
    return this.pending().find((item) => item.target === target) || null;
  }

  /** Upload a command; `base` is the post's `updated_at` as the page saw it. */
  async send(type, { postId, channelId, payload = {}, base = null }) {
    const command = {
      schema_version: 1,
      id: crypto.randomUUID(),
      type,
      payload,
      created_at: isoNow(),
    };
    if (postId !== undefined) command.post_id = postId;
    if (channelId !== undefined) command.channel_id = channelId;
    if (base) command.base_updated_at = base;
    await this.bucket.putJson(`commands/${command.id}.json`, command);
    const target = targetOf(command);
    this.answers.delete(target);
    writeStored(PENDING_KEY, [...this.pending(), { id: command.id, type, target }]);
    return command;
  }

  /** Read the answers that arrived; returns how many commands were applied. */
  async check() {
    let applied = 0;
    const answered = new Set();
    for (const item of this.pending()) {
      const answer = await this.bucket.getJson(`outbox/commands/${item.id}.json`);
      if (answer === null) continue;
      answered.add(item.id);
      this.answers.set(item.target, { status: answer.status, message: answer.message });
      if (answer.status === "applied") applied += 1;
    }
    if (answered.size) {
      writeStored(PENDING_KEY, this.pending().filter((item) => !answered.has(item.id)));
    }
    return applied;
  }
}
