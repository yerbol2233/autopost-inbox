// The remote page: sign-in, navigation, the Mac status pill, presence and the answer polling.

import { renderAccounts, rememberOpenLimits } from "./accounts.js";
import { calendarBusy, renderCalendar } from "./calendar.js";
import { CommandQueue } from "./commands.js";
import { $, el } from "./dom.js";
import { renderJournal } from "./journal.js";
import { Bucket, hostOf } from "./s3.js";
import { MacState } from "./state.js";
import { ReviewsScreen } from "./reviews.js";
import { readStored, writeStored } from "./storage.js";
import { UploadScreen } from "./upload.js";

const CONFIG_KEY = "autopost-inbox";
const ANSWER_POLL_MS = 10_000;
const PROGRESS_POLL_MS = 5_000;
const PRESENCE_MS = 60_000;
const STATE_REFRESH_MS = 60_000;
const SCREENS = {
  upload: null,
  calendar: renderCalendar,
  accounts: renderAccounts,
  journal: renderJournal,
  reviews: null,
};

function readConfig() {
  return readStored(CONFIG_KEY, {});
}

function hashDefaults() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { endpoint: params.get("endpoint") || "", bucket: params.get("bucket") || "" };
}

function showSignIn() {
  const config = readConfig();
  const defaults = hashDefaults();
  const form = $("setup-form");
  form.elements.endpoint.value = config.endpoint || defaults.endpoint;
  form.elements.bucket.value = config.bucket || defaults.bucket;
  $("setup").hidden = false;
  $("app").hidden = true;
}

class RemotePage {
  constructor(config) {
    this.bucket = new Bucket(config);
    this.state = new MacState(this.bucket);
    this.commands = new CommandQueue(this.bucket);
    this.screen = "upload";
    this.loaded = false;
    this.ctx = {
      bucket: this.bucket,
      state: this.state,
      commands: this.commands,
      send: (type, options) => this.send(type, options),
      refresh: () => this.refresh(),
      rerender: () => this.render(),
    };
    this.upload = new UploadScreen($("screen-upload"), this.ctx);
    this.reviews = new ReviewsScreen($("screen-reviews"), this.ctx);
  }

  start() {
    $("setup").hidden = true;
    $("app").hidden = false;
    for (const button of document.querySelectorAll("[data-screen]")) {
      button.addEventListener("click", () => this.show(button.dataset.screen));
    }
    this.show(this.screen);
    this.refresh();
    this.writePresence();
    this.timers = [
      setInterval(() => this.writePresence(), PRESENCE_MS),
      setInterval(() => this.checkAnswers(), ANSWER_POLL_MS),
      setInterval(() => this.upload.inProgress() && this.upload.renderSends(), PROGRESS_POLL_MS),
      setInterval(() => this.refresh({ quiet: true }), STATE_REFRESH_MS),
    ];
  }

  stop() {
    for (const timer of this.timers || []) clearInterval(timer);
  }

  show(screen) {
    this.screen = screen;
    for (const button of document.querySelectorAll("[data-screen]")) {
      if (button.dataset.screen === screen) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const name of Object.keys(SCREENS)) $(`screen-${name}`).hidden = name !== screen;
    this.render();
  }

  render() {
    const draw = SCREENS[this.screen];
    if (!draw) return;
    const root = $(`screen-${this.screen}`);
    if (!this.loaded) {
      root.replaceChildren(el("p", { class: "empty" }, "Загружаю…"));
      return;
    }
    if (this.state.meta === null) {
      root.replaceChildren(el("p", { class: "notice warn" },
        "Mac ещё ни разу не выходил на связь. Данные появятся, когда воркер запустится с " +
        "настроенным ящиком."));
      return;
    }
    if (this.screen === "accounts") rememberOpenLimits(root);
    draw(root, this.ctx);
  }

  problem(text) {
    const banner = $("problem");
    banner.textContent = text;
    banner.hidden = !text;
  }

  /** Re-read the Mac's state and the answers; the open screen is redrawn unless being edited. */
  async refresh({ quiet = false } = {}) {
    try {
      await this.commands.check();
      await this.state.load();
      this.loaded = true;
      this.problem("");
    } catch (error) {
      this.problem(error.message);
    }
    const connection = this.state.connection();
    const pill = $("mac-pill");
    pill.textContent = connection.text;
    pill.className = "mac-pill " + (connection.online ? "online" : "offline");
    if (!(quiet && this.screen === "calendar" && calendarBusy())) this.render();
    this.upload.renderSends();
    this.reviews.renderCounts();
  }

  async checkAnswers() {
    if (this.upload.waiting()) this.upload.renderSends();
    if (!this.commands.pending().length) return;
    const before = this.commands.answers.size;
    try {
      const applied = await this.commands.check();
      if (applied) await this.refresh();
      else if (this.commands.answers.size !== before) this.render();
    } catch (error) {
      this.problem(error.message);
    }
  }

  async send(type, options) {
    try {
      await this.commands.send(type, options);
      this.problem("");
    } catch (error) {
      this.problem(`${error.message} Команда не отправлена.`);
    }
    this.render();
  }

  async writePresence() {
    if (document.hidden) return;
    try {
      await this.bucket.putJson("presence.json", { seen_at: new Date().toISOString() });
    } catch {
      // Presence only speeds the Mac up; a missed write changes nothing else.
    }
  }
}

let page = null;

function boot() {
  page?.stop();
  const config = readConfig();
  if (!(config.endpoint && config.bucket && config.keyId && config.appKey)) {
    page = null;
    showSignIn();
    return;
  }
  page = new RemotePage(config);
  page.start();
}

document.addEventListener("DOMContentLoaded", () => {
  $("setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    const value = (name) => form.elements[name].value.trim();
    writeStored(CONFIG_KEY, {
      endpoint: hostOf(value("endpoint")),
      bucket: value("bucket"),
      keyId: value("keyId"),
      appKey: value("appKey"),
    });
    form.elements.appKey.value = "";
    boot();
  });
  $("forget").addEventListener("click", () => {
    const { endpoint, bucket } = readConfig();
    writeStored(CONFIG_KEY, { endpoint, bucket });
    boot();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) page?.writePresence();
  });
  boot();
});
