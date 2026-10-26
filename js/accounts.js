// «Аккаунты»: state, pause/resume and pacing limits of every account (commands to the Mac).

import { el } from "./dom.js";

const STATES = {
  active: ["Публикует", "ok"],
  paused: ["На паузе", "paused"],
  login_blocked: ["Нужен вход", "bad"],
};
const LIMIT_FIELDS = [
  ["daily_limit_posts", "Постов в день", "number"],
  ["daily_limit_stories", "Сторис в день", "number"],
  ["quiet_start", "Тихие часы с", "time"],
  ["quiet_end", "Тихие часы до", "time"],
];
const openLimits = new Set(); // channel ids whose limits form is unfolded

/** Remember which limit forms are unfolded before the screen is redrawn. */
export function rememberOpenLimits(root) {
  for (const details of root.querySelectorAll("details[data-limits]")) {
    if (details.open) openLimits.add(details.dataset.limits);
    else openLimits.delete(details.dataset.limits);
  }
}

function limitsForm(channel, ctx, waiting) {
  const form = el("form", { class: "limits", "aria-label": `Лимиты ${channel.name}` },
    LIMIT_FIELDS.map(([name, label, type]) => el("label", { class: "field" }, label,
      el("input", { name, type, min: type === "number" ? "0" : null, inputmode: type === "number" ? "numeric" : null }))),
    el("div", { class: "toolbar" },
      el("button", { type: "submit", class: "primary", disabled: waiting }, "Сохранить лимиты")),
  );
  for (const [name] of LIMIT_FIELDS) form.elements[name].value = channel[name] ?? "";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = {};
    for (const [name, , type] of LIMIT_FIELDS) {
      const value = form.elements[name].value.trim();
      if (value === String(channel[name] ?? "")) continue;
      payload[name] = value === "" ? null : type === "number" ? Number(value) : value;
    }
    if (Object.keys(payload).length) {
      ctx.send("update_channel_limits", { channelId: channel.id, payload });
    }
  });
  return form;
}

function channelCard(channel, ctx) {
  const target = `channel:${channel.id}`;
  const waiting = Boolean(ctx.commands.waitingFor(target));
  const answer = ctx.commands.answers.get(target);
  const [stateLabel, stateClass] = STATES[channel.state] || [channel.state, ""];
  const toggle = channel.state === "active"
    ? el("button", {
      type: "button", disabled: waiting,
      onclick: () => ctx.send("pause_channel", { channelId: channel.id }),
    }, "Поставить на паузу")
    : channel.state === "paused"
      ? el("button", {
        type: "button", class: "primary", disabled: waiting,
        onclick: () => ctx.send("resume_channel", { channelId: channel.id }),
      }, "Возобновить")
      : null;
  return el("article", { class: "card channel", "data-channel": channel.id },
    el("div", { class: "channel-head" },
      el("strong", {}, channel.name),
      el("span", { class: "tag" }, channel.platform_label),
      el("span", { class: `status ${stateClass}` }, stateLabel),
      waiting ? el("span", { class: "status pending" }, "ждёт Mac") : null),
    el("dl", { class: "meta" },
      el("dt", {}, "Маршрут"), el("dd", {}, channel.route === "api" ? "Graph API" : "Браузер"),
      channel.pause_reason ? [el("dt", {}, "Причина паузы"), el("dd", {}, channel.pause_reason)] : null),
    channel.state === "login_blocked"
      ? el("p", { class: "notice warn small" },
        "Вход в аккаунт и кнопка «Продолжить» — только на Mac.")
      : null,
    answer ? el("p", {
      class: "answer " + (answer.status === "applied" ? "ok" : "error"), role: "status",
    }, answer.message) : null,
    toggle ? el("div", { class: "toolbar" }, toggle) : null,
    el("details", { "data-limits": channel.id, open: openLimits.has(String(channel.id)) },
      el("summary", {}, "Лимиты и тихие часы"), limitsForm(channel, ctx, waiting)),
  );
}

export function renderAccounts(root, ctx) {
  const channels = ctx.state.channels;
  root.replaceChildren(
    el("div", { class: "section-head" },
      el("h1", {}, "Аккаунты"),
      el("button", { type: "button", onclick: ctx.refresh }, "Обновить")),
    channels.length
      ? el("div", { class: "channel-grid" }, channels.map((channel) => channelCard(channel, ctx)))
      : el("p", { class: "empty" }, "Аккаунтов пока нет — их добавляют на Mac."),
    el("p", { class: "muted small only-mac" },
      "Только на Mac: добавление аккаунтов, вход в аккаунт после блокировки, проверка локаторов (доктор)."),
  );
}
