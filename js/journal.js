// «Журнал»: the latest publication attempts and the end of the worker's errors log.

import { el, formatIn } from "./dom.js";

const OUTCOME_CLASS = {
  success: "posted", scheduled: "scheduled_in_meta", needs_attention: "needs_attention", failed: "failed", deferred: "paused",
};

export function renderJournal(root, ctx) {
  const { runs, log_lines: lines } = ctx.state.activity;
  const when = (iso) => formatIn(ctx.state.zone, new Date(iso), {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  root.replaceChildren(
    el("div", { class: "section-head" },
      el("h1", {}, "Журнал"),
      el("button", { type: "button", onclick: ctx.refresh }, "Обновить")),
    el("section", { class: "card" },
      el("h2", {}, "Последние попытки"),
      runs.length
        ? el("ul", { class: "runs" }, runs.map((run) => el("li", { class: "run" },
          el("div", { class: "post-head" },
            el("span", { class: "post-time" }, when(run.started_at)),
            el("span", { class: `status ${OUTCOME_CLASS[run.outcome] || "running"}` }, run.outcome_label)),
          el("div", { class: "small" },
            [`Пост #${run.post_id}`, run.account, run.route].filter(Boolean).join(" · ")),
          run.error ? el("p", { class: "error-text small" }, run.error) : null,
          run.fallback_reason ? el("p", { class: "warn-text small" }, run.fallback_reason) : null)))
        : el("p", { class: "empty" }, "Попыток пока не было.")),
    el("section", { class: "card" },
      el("h2", {}, "Ошибки воркера"),
      lines.length
        ? el("pre", { class: "log-tail", tabindex: "0" }, lines.join("\n"))
        : el("p", { class: "empty" }, "Ошибок нет.")),
  );
}
