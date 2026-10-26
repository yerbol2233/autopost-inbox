// «Отзывы»: the review pool's counters (`state/reviews.json`) and an upload of screenshots or
// ZIPs as a parcel of kind "reviews". Files get a number prefix so the Mac adds them in the
// order they were chosen; its answer shows up in «Отправленные» on «Загрузить план».

import { $, el, isoNow, plural, setStatus } from "./dom.js";
import { rememberSend, safeName } from "./upload.js";

const REVIEWS = ["отзыв", "отзыва", "отзывов"];
const ACCEPTED = /^image\/|\.zip$/i;

function reviewFiles(input) {
  const chosen = Array.from(input.files);
  if (!chosen.length) throw new Error("Выберите картинки с отзывами или ZIP-архив.");
  const odd = chosen.find((file) => !ACCEPTED.test(file.type) && !/\.zip$/i.test(file.name));
  if (odd) throw new Error(`«${odd.name}» — не картинка и не ZIP.`);
  const width = String(chosen.length).length;
  return chosen.map((file, index) => ({
    name: `${String(index + 1).padStart(width, "0")}-${safeName(file.name)}`,
    file,
  }));
}

export class ReviewsScreen {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.build();
  }

  build() {
    this.counts = el("p", { id: "review-counts", class: "review-counts" });
    this.form = el("form", { id: "reviews-form", class: "card form" },
      el("label", { class: "drop" },
        el("span", { class: "drop-title" }, "Скриншоты отзывов или ZIP"),
        el("span", { class: "muted small" }, "Порядок — как вы их выбрали"),
        el("input", { name: "reviews", type: "file", multiple: true, accept: "image/*,.zip" })),
      el("div", { class: "submit-row" },
        el("button", { type: "submit", id: "reviews-button", class: "primary large" }, "Добавить в пул")),
      el("p", { id: "reviews-status", class: "status-line", role: "status", "aria-live": "polite" }),
    );
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit();
    });
    this.root.replaceChildren(
      el("div", { class: "section-head" },
        el("h1", {}, "Отзывы"),
        el("button", { type: "button", onclick: () => this.ctx.refresh() }, "Обновить")),
      el("p", { class: "lead" },
        "Посты с типом «Отзыв» в плане берут по одному скриншоту отсюда — по порядку загрузки, " +
        "каждый один раз."),
      this.counts,
      this.form,
    );
    this.renderCounts();
  }

  renderCounts() {
    const { free, used } = this.ctx.state.reviews;
    const parts = [
      el("span", { class: `pill ${free ? "ok" : "warn"}` }, `Свободно: ${free}`),
      el("span", { class: "pill" }, `Использовано: ${used}`),
    ];
    if (!free) {
      parts.push(el("span", { class: "warn-text small" },
        "Свободных отзывов нет — посты-отзывы ждут, пока вы не догрузите картинки."));
    }
    this.counts.replaceChildren(...parts);
  }

  status(text, kind) {
    setStatus($("reviews-status"), text, kind);
  }

  async submit() {
    let files;
    try {
      files = reviewFiles(this.form.elements.reviews);
    } catch (error) {
      this.status(error.message, "error");
      return;
    }
    const id = crypto.randomUUID();
    const button = $("reviews-button");
    button.disabled = true;
    try {
      for (const [index, item] of files.entries()) {
        this.status(`Загружаю ${index + 1} из ${files.length}: ${item.file.name}`);
        await this.ctx.bucket.put(`inbox/${id}/${item.name}`, item.file,
          item.file.type || "application/octet-stream");
      }
      await this.ctx.bucket.putJson(`inbox/${id}/manifest.json`, { kind: "reviews", created_at: isoNow() });
      rememberSend({ id, title: `Отзывы: ${files.length} ${plural(files.length, REVIEWS)}`, sent_at: isoNow() });
      this.form.reset();
      this.status("Принято в ящик — Mac добавит в пул. Ответ — в «Отправленных» на «Загрузить план».", "ok");
    } catch (error) {
      this.status(`${error.message} Отзывы не отправлены.`, "error");
    } finally {
      button.disabled = false;
    }
  }
}
