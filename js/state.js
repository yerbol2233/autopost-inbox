// The Mac's snapshots in `state/`: meta (heartbeat), posts, channels, activity and thumbnails.

import { formatIn } from "./dom.js";

const FILES = ["posts", "channels", "activity"];

export class MacState {
  constructor(bucket) {
    this.bucket = bucket;
    this.meta = null;
    this.posts = [];
    this.channels = [];
    this.activity = { runs: [], log_lines: [] };
    this.thumbs = new Map(); // key -> Promise of an object URL (or null)
  }

  get zone() {
    return this.meta?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Re-read every file; returns false when the Mac has never exported its state. */
  async load() {
    this.meta = await this.bucket.getJson("state/meta.json");
    if (this.meta === null) return false;
    const [posts, channels, activity] = await Promise.all(
      FILES.map((name) => this.bucket.getJson(`state/${name}.json`)),
    );
    this.posts = posts?.posts || [];
    this.channels = channels?.channels || [];
    this.activity = activity || { runs: [], log_lines: [] };
    return true;
  }

  /** «Mac на связи» while the last heartbeat is younger than two heartbeat intervals. */
  connection() {
    if (this.meta === null) return { online: false, text: "Mac ещё не выходил на связь" };
    const generated = new Date(this.meta.generated_at);
    const online = Date.now() - generated.getTime() <= 2 * (this.meta.heartbeat_s || 300) * 1000;
    if (online) return { online, text: "Mac на связи" };
    const when = formatIn(this.zone, generated, {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
    return { online, text: `Mac не на связи с ${when}` };
  }

  /** An object URL of the thumbnail (signed GET), or null. */
  thumb(key) {
    if (!this.thumbs.has(key)) {
      this.thumbs.set(key, this.bucket.getBlob(key)
        .then((blob) => (blob ? URL.createObjectURL(blob) : null))
        .catch(() => null));
    }
    return this.thumbs.get(key);
  }
}
