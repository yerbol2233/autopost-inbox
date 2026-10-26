// «Загрузить план»: a table (+ media or one ZIP) or a Google link goes into `inbox/<uuid>/`,
// manifest last. A plan written by rubrics first gets the «Рубрики плана» step; a Google link
// always gets its accounts-and-start part (the table cannot be read in the browser, so the Mac
// keeps the table's frequencies at 10:00). The Mac's answer comes back in `outbox/<uuid>.json`,
// its progress meanwhile in `outbox/progress/<uuid>.json`.

import { $, el, isoNow, plural, setStatus, todayIn } from "./dom.js";
import { DEFAULT_TIME, cadenceKeys, cadenceLabel, readRubrics } from "./rubrics.js";
import { readStored, writeStored } from "./storage.js";

const SENDS_KEY = "autopost-inbox-sends";
const MAX_SENDS = 20;
const TABLE = /\.(xlsx|csv)$/i;
const POSTS = ["пост", "поста", "постов"];
const TEXTS = ["текст", "текста", "текстов"];
const RUBRICS = ["рубрика", "рубрики", "рубрик"];
const DRIVE = /^https:\/\/(docs|drive)\.google\.com\//;

/** The day after an ISO date (YYYY-MM-DD). */
function nextDay(iso) {
  const day = new Date(`${iso}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function safeName(name) {
  const cleaned = name.replace(/[\\/]/g, "_").replace(/^\.+/, "").trim();
  return cleaned || "file";
}

function parcelFiles(form) {
  const table = form.elements.table.files[0];
  if (!table) throw new Error("Выберите таблицу (.xlsx или .csv).");
  if (!TABLE.test(table.name)) throw new Error("Таблица должна быть .xlsx или .csv.");
  const media = Array.from(form.elements.media.files);
  const zips = media.filter((file) => /\.zip$/i.test(file.name));
  if (zips.length > 1) throw new Error("Можно приложить только один ZIP-архив.");
  if (zips.length && media.length > 1) throw new Error("ZIP прикладывается один, без других медиа.");
  if (media.some((file) => TABLE.test(file.name))) {
    throw new Error("Таблица должна быть одна — уберите её из медиа.");
  }
  const names = new Set();
  const files = [table, ...media].map((file) => {
    let name = safeName(file.name);
    while (names.has(name.toLowerCase())) name = "1_" + name;
    names.add(name.toLowerCase());
    return { name, file };
  });
  return { kind: zips.length ? "zip" : "file", files, table };
}

export class UploadScreen {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.source = "file";
    this.pendingParcel = null; // {kind, files, rubrics} while the rubric step is open
    this.build();
  }

  build() {
    const tab = (value, label) => el("button", {
      type: "button", class: "tab", "aria-pressed": String(this.source === value),
      "data-source-tab": value, onclick: () => this.pickSource(value),
    }, label);
    this.form = el("form", { id: "send-form", class: "card form" },
      el("div", { class: "tabs", role: "group", "aria-label": "Откуда план" },
        tab("file", "Файлы"), tab("drive", "Ссылка Google")),
      el("div", { "data-source": "file", class: "form" },
        el("label", { class: "drop" }, el("span", { class: "drop-title" }, "Таблица (.xlsx или .csv)"),
          el("input", { name: "table", type: "file", accept: ".xlsx,.csv" })),
        el("label", { class: "drop" },
          el("span", { class: "drop-title" }, "Медиа или один ZIP (необязательно)"),
          el("input", { name: "media", type: "file", multiple: true }))),
      el("div", { "data-source": "drive", hidden: true },
        el("label", { class: "field" }, "Ссылка на Google Таблицу или папку Drive",
          el("input", { name: "driveUrl", type: "url", placeholder: "https://drive.google.com/…" }))),
      el("label", { class: "field" }, "Название (необязательно)",
        el("input", { name: "planName", type: "text", maxlength: "200", placeholder: "Ноябрь" })),
      el("div", { class: "submit-row" },
        el("button", { type: "submit", id: "send-button", class: "primary large" }, "Отправить план")),
      el("progress", { id: "progress", max: "1", value: "0", hidden: true }),
      el("p", { id: "send-status", class: "status-line", role: "status", "aria-live": "polite" }),
    );
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit();
    });
    this.rubricStep = el("section", { id: "rubric-step", class: "form", hidden: true });
    this.sends = el("ul", { id: "sends", class: "sends" });
    this.intro = el("div", {},
      el("h1", {}, "Загрузить план"),
      el("p", { class: "lead" }, "План ляжет в ящик Backblaze. Mac заберёт его, когда будет на связи."));
    this.root.replaceChildren(
      this.intro,
      this.form,
      this.rubricStep,
      el("section", { class: "card" },
        el("div", { class: "section-head" },
          el("h2", {}, "Отправленные"),
          el("button", { type: "button", id: "refresh-sends", onclick: () => this.renderSends() }, "Обновить")),
        el("p", { id: "sends-empty", class: "empty" }, "Пока ничего не отправлено."),
        this.sends),
    );
  }

  pickSource(value) {
    this.source = value;
    for (const button of this.form.querySelectorAll("[data-source-tab]")) {
      button.setAttribute("aria-pressed", String(button.dataset.sourceTab === value));
    }
    for (const block of this.form.querySelectorAll("[data-source]")) {
      block.hidden = block.dataset.source !== value;
    }
  }

  status(text, kind) {
    setStatus($("send-status"), text, kind);
  }

  async submit() {
    let parcel;
    try {
      if (this.source === "drive") {
        if (!DRIVE.test(this.form.elements.driveUrl.value.trim())) {
          throw new Error("Нужна ссылка на Google Таблицу или папку Google Drive.");
        }
        parcel = { kind: "drive", files: [], rubrics: [] };
      } else {
        parcel = parcelFiles(this.form);
      }
    } catch (error) {
      this.status(error.message, "error");
      return;
    }
    if (parcel.kind === "drive") {
      this.status("");
      this.openRubricStep(parcel);
      return;
    }
    if (parcel.table) {
      this.status("Читаю таблицу…");
      let rubrics = null;
      try {
        rubrics = await readRubrics(parcel.table);
      } catch {
        rubrics = null; // the Mac reads the table itself and reports what is wrong with it
      }
      if (rubrics) {
        this.status("");
        this.openRubricStep({ ...parcel, rubrics });
        return;
      }
    }
    await this.upload(parcel, {});
  }

  openRubricStep(parcel) {
    this.pendingParcel = parcel;
    const { rubrics } = parcel;
    const drive = parcel.kind === "drive";
    const texts = rubrics.reduce((sum, rubric) => sum + rubric.count, 0);
    const today = todayIn(this.ctx.state.zone);
    const channels = this.ctx.state.channels;
    const cards = rubrics.map((rubric, index) => el("section", { class: "card rubric-card" },
      el("div", { class: "rubric-head" },
        el("strong", {}, rubric.name),
        el("span", { class: "muted small" }, `${rubric.count} ${plural(rubric.count, TEXTS)}`)),
      rubric.ownDates
        ? el("p", { class: "pill ok" }, "Даты из строки «дата:» таблицы")
        : el("label", { class: "field" }, "Частота",
          el("select", { name: `cadence-${index}` }, cadenceKeys([rubric.cadence]).map((key) => el("option", {
            value: key, selected: key === (rubric.cadence || "1"),
          }, cadenceLabel(key))))),
      el("label", { class: "field" }, "Время",
        el("input", { name: `time-${index}`, type: "time", value: DEFAULT_TIME, required: true })),
      rubric.cadence === null && rubric.cadenceText
        ? el("p", { class: "pill warn" }, `Частоту «${rubric.cadenceText}» не поняли — выберите`)
        : null,
    ));
    const form = el("form", { id: "rubric-form", class: "rubrics-form" },
      el("section", { class: "card rubric-common" },
        el("h2", {}, "Общее для всех рубрик"),
        el("label", { class: "field" }, "Начать с",
          el("input", { name: "start", type: "date", value: drive ? nextDay(today) : today, required: true })),
        el("fieldset", { class: "rubric-channels" },
          el("legend", {}, "Аккаунты"),
          channels.length
            ? channels.map((channel) => el("label", { class: "check" },
              el("input", {
                type: "checkbox", name: "channel", value: String(channel.id), checked: channels.length === 1,
              }),
              `${channel.name} · ${channel.platform_label}`))
            : el("p", { class: "muted small" }, "Список аккаунтов появится, когда Mac выйдет на связь."))),
      drive
        ? el("p", { class: "muted small" },
          "Если план по рубрикам, частоту Mac возьмёт из таблицы (иначе — каждый день), " +
          "время — 10:00. Для обычного плана даты и аккаунты берутся из таблицы.")
        : el("div", { class: "rubric-list" }, cards),
      el("div", { class: "submit-row" },
        el("button", { type: "button", onclick: () => this.closeRubricStep() }, "← Назад"),
        el("button", { type: "submit", class: "primary large" }, "Отправить план")),
      el("p", { id: "rubric-status", class: "status-line", role: "status", "aria-live": "polite" }),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.sendRubrics(form);
    });
    this.rubricStep.replaceChildren(
      el("h1", {}, drive ? "Куда публиковать" : "Рубрики плана"),
      el("p", { class: "lead" }, drive
        ? "Выберите аккаунты и день начала — Mac скачает план из Google и расставит посты."
        : `Узнали план по рубрикам: ${rubrics.length} ${plural(rubrics.length, RUBRICS)}, ` +
          `${texts} ${plural(texts, TEXTS)}. Задайте начало, ` +
          "аккаунты и время — даты Mac расставит сам по частоте."),
      form,
    );
    this.form.hidden = true;
    this.intro.hidden = true;
    this.rubricStep.hidden = false;
    this.rubricStep.querySelector("input[name=start]").focus();
  }

  closeRubricStep() {
    this.pendingParcel = null;
    this.rubricStep.hidden = true;
    this.intro.hidden = false;
    this.form.hidden = false;
  }

  async sendRubrics(form) {
    const channels = Array.from(form.querySelectorAll("input[name=channel]:checked"), (box) => Number(box.value));
    if (!channels.length) {
      setStatus($("rubric-status"), "Отметьте хотя бы один аккаунт.", "error");
      return;
    }
    const parcel = this.pendingParcel;
    const rubrics = parcel.rubrics.map((rubric, index) => ({
      cadence: rubric.ownDates ? rubric.cadence || "1" : form.elements[`cadence-${index}`].value,
      at: form.elements[`time-${index}`].value || DEFAULT_TIME,
    }));
    const choices = { start_date: form.elements.start.value, channels };
    if (rubrics.length) choices.rubrics = rubrics;
    this.closeRubricStep();
    await this.upload(parcel, choices);
  }

  async upload(parcel, choices) {
    const value = (name) => this.form.elements[name].value.trim();
    const manifest = { kind: parcel.kind, created_at: isoNow(), ...choices };
    if (value("planName")) manifest.plan_name = value("planName");
    if (parcel.kind === "drive") manifest.drive_url = value("driveUrl");
    const id = crypto.randomUUID();
    const button = $("send-button");
    const progress = $("progress");
    const total = parcel.files.reduce((sum, item) => sum + item.file.size, 0) + 1;
    let done = 0;
    button.disabled = true;
    progress.hidden = false;
    progress.value = 0;
    try {
      for (const [index, item] of parcel.files.entries()) {
        this.status(`Загружаю ${index + 1} из ${parcel.files.length}: ${item.name}`);
        await this.ctx.bucket.put(`inbox/${id}/${item.name}`, item.file,
          item.file.type || "application/octet-stream");
        done += item.file.size;
        progress.value = done / total;
      }
      this.status("Завершаю отправку…");
      await this.ctx.bucket.putJson(`inbox/${id}/manifest.json`, manifest);
      progress.value = 1;
      const sends = readStored(SENDS_KEY, []);
      sends.unshift({
        id, title: manifest.plan_name || parcel.files[0]?.name || manifest.drive_url, sent_at: isoNow(),
      });
      writeStored(SENDS_KEY, sends.slice(0, MAX_SENDS));
      this.form.reset();
      this.pickSource(this.source);
      this.status("Принято в ящик — ждёт Mac. Ответ появится в «Отправленных».", "ok");
      this.renderSends();
    } catch (error) {
      this.status(`${error.message} План не отправлен.`, "error");
    } finally {
      button.disabled = false;
      progress.hidden = true;
    }
  }

  /** Whether the Mac is working on a sent parcel right now (the page then polls faster). */
  inProgress() {
    return readStored(SENDS_KEY, []).some((item) => !item.answer && item.progress);
  }

  /** Whether a parcel still waits for the Mac's answer (the page then keeps polling). */
  waiting() {
    return readStored(SENDS_KEY, []).some((item) => !item.answer);
  }

  async renderSends() {
    const sends = readStored(SENDS_KEY, []);
    for (const item of sends.filter((send) => !send.answer)) {
      try {
        const answer = await this.ctx.bucket.getJson(`outbox/${item.id}.json`);
        if (answer) item.answer = answer;
        item.progress = answer ? null : await this.ctx.bucket.getJson(`outbox/progress/${item.id}.json`);
      } catch (error) {
        item.problem = error.message;
      }
    }
    writeStored(SENDS_KEY, sends.map(({ problem, ...item }) => item));
    $("sends-empty").hidden = sends.length > 0;
    this.sends.replaceChildren(...sends.map((item) => {
      let badge;
      if (!item.answer) {
        badge = el("span", { class: "status pending" },
          item.problem || item.progress?.label || "ждёт Mac");
      } else if (item.answer.status === "accepted") {
        badge = el("span", { class: "status posted" },
          `принято: ${item.answer.posts} ${plural(item.answer.posts, POSTS)}`);
      } else {
        badge = el("span", { class: "status failed" }, "отклонено");
      }
      const errors = item.answer?.errors || [];
      return el("li", { "data-id": item.id },
        el("div", { class: "send-title" }, item.title || item.id),
        el("div", { class: "muted small" }, `${new Date(item.sent_at).toLocaleString("ru-RU")} · `, badge),
        errors.length ? el("ul", { class: "errors" }, errors.map((text) => el("li", {}, text))) : null);
    }));
  }
}
