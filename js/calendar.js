// «Календарь»: posts by day, each with the actions its `actions` flags allow (commands to the Mac).

import { el, formatIn, todayIn } from "./dom.js";

const ATTENTION = new Set(["needs_attention", "failed"]);
const DONE = new Set(["posted", "cancelled"]);
const ACTIONS = [
  { flag: "pause", type: "pause_post", label: "Пауза" },
  { flag: "resume", type: "resume_post", label: "Возобновить" },
  { flag: "retry", type: "retry_post", label: "Повторить" },
  { flag: "retry_comment", type: "retry_comment", label: "Повторить комментарий" },
  { flag: "cancel", type: "cancel_post", label: "Снять из autopost", confirm: "Точно снять?" },
  { flag: "delete", type: "delete_post", label: "Удалить", confirm: "Точно удалить?", danger: true },
];
const view = { account: "all", past: false, editing: null };

/** Whether an edit form is open (an automatic refresh then leaves the screen alone). */
export function calendarBusy() {
  return view.editing !== null;
}

const needsAttention = (post) => ATTENTION.has(post.status) || post.comment_needs_attention;

function dayTitle(isoDate, zone) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  const label = formatIn("UTC", noon, { weekday: "short", day: "numeric", month: "long" });
  return isoDate === todayIn(zone) ? `Сегодня, ${label}` : label;
}

function visible(post, today) {
  if (view.account === "attention") return needsAttention(post);
  if (view.account !== "all" && String(post.channel_id) !== view.account) return false;
  const day = post.scheduled_local?.slice(0, 10);
  return view.past || !day || day >= today || !DONE.has(post.status);
}

function filterBar(ctx) {
  const options = [["all", "Все аккаунты"]];
  for (const channel of ctx.state.channels) options.push([String(channel.id), channel.name]);
  options.push(["attention", "Нужно внимание"]);
  const pick = (value) => () => {
    view.account = value;
    ctx.rerender();
  };
  return el("div", { class: "filters", role: "group", "aria-label": "Фильтр постов" },
    options.map(([value, label]) => el("button", {
      type: "button", class: "chip", "aria-pressed": String(view.account === value), onclick: pick(value),
    }, label)),
    el("button", {
      type: "button", class: "chip", "aria-pressed": String(view.past),
      onclick: () => { view.past = !view.past; ctx.rerender(); },
    }, "Прошедшие"),
  );
}

function thumbOf(post, ctx) {
  const key = post.media.find((item) => item.thumb)?.thumb;
  const box = el("div", { class: "thumb-box", "aria-hidden": "true" },
    post.media.length ? "" : el("span", { class: "thumb-text" }, "Аа"));
  if (key) {
    ctx.state.thumb(key).then((url) => {
      if (url) box.replaceChildren(el("img", { src: url, alt: "" }));
    });
  }
  return box;
}

function editForm(post, ctx) {
  const form = el("form", { class: "edit-form", "aria-label": "Изменить пост" },
    el("label", { class: "field" }, "Подпись",
      el("textarea", { name: "caption", rows: "4" })),
    el("label", { class: "field" }, "Первый комментарий",
      el("textarea", { name: "first_comment", rows: "2" })),
    el("label", { class: "field" }, "Дата и время",
      el("input", { name: "scheduled_local", type: "datetime-local" })),
    el("p", { class: "muted small" }, "Пустая дата — пост станет черновиком."),
    el("div", { class: "toolbar" },
      el("button", { type: "submit", class: "primary" }, "Сохранить"),
      el("button", { type: "button", onclick: () => { view.editing = null; ctx.rerender(); } }, "Отмена")),
  );
  form.elements.caption.value = post.caption || "";
  form.elements.first_comment.value = post.first_comment || "";
  form.elements.scheduled_local.value = post.scheduled_local || "";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = {};
    const caption = form.elements.caption.value;
    const comment = form.elements.first_comment.value.trim();
    const when = form.elements.scheduled_local.value;
    if (caption !== (post.caption || "")) payload.caption = caption;
    if (comment !== (post.first_comment || "")) payload.first_comment = comment || null;
    if (when !== (post.scheduled_local || "")) payload.scheduled_local = when || null;
    view.editing = null;
    if (!Object.keys(payload).length) {
      ctx.rerender();
      return;
    }
    ctx.send("edit_post", { postId: post.id, payload, base: post.updated_at });
  });
  return form;
}

function actionButton(action, post, ctx, waiting) {
  const button = el("button", {
    type: "button", class: action.danger ? "danger" : "", disabled: waiting,
  }, action.label);
  let armed = false;
  button.addEventListener("click", () => {
    if (action.confirm && !armed) {
      armed = true;
      button.textContent = action.confirm;
      setTimeout(() => { armed = false; button.textContent = action.label; }, 5000);
      return;
    }
    ctx.send(action.type, { postId: post.id, base: post.updated_at });
  });
  return button;
}

function postCard(post, ctx) {
  const target = `post:${post.id}`;
  const waiting = ctx.commands.waitingFor(target);
  const answer = ctx.commands.answers.get(target);
  const time = post.scheduled_local ? post.scheduled_local.slice(11, 16) : "без даты";
  const card = el("article", {
    class: "post-card" + (needsAttention(post) ? " attention" : ""), "data-post": post.id,
  },
    thumbOf(post, ctx),
    el("div", { class: "post-body" },
      el("div", { class: "post-head" },
        el("span", { class: "post-time" }, time),
        el("span", { class: `status ${post.status}` }, post.status_label),
        waiting ? el("span", { class: "status pending" }, "ждёт Mac") : null),
      el("div", { class: "small post-meta" },
        `${post.account} · ${post.platform_label} · ${post.type_label}`),
      post.caption ? el("p", { class: "caption" }, post.caption) : null,
      post.error ? el("p", { class: "error-text small" }, post.error) : null,
      post.comment_error ? el("p", { class: "error-text small" }, `Комментарий: ${post.comment_error}`) : null,
      post.reschedule_reason ? el("p", { class: "warn-text small" }, post.reschedule_reason) : null,
      post.session_blocked
        ? el("p", { class: "warn-text small" }, "Нужен вход в аккаунт — «Продолжить» только на Mac.")
        : null,
      answer ? el("p", {
        class: "answer " + (answer.status === "applied" ? "ok" : "error"), role: "status",
      }, answer.message) : null,
    ),
  );
  const buttons = [];
  if (post.actions.edit) {
    buttons.push(el("button", {
      type: "button", disabled: Boolean(waiting),
      onclick: () => { view.editing = post.id; ctx.rerender(); },
    }, "Изменить"));
  }
  for (const action of ACTIONS) {
    if (post.actions[action.flag]) buttons.push(actionButton(action, post, ctx, Boolean(waiting)));
  }
  if (buttons.length) card.querySelector(".post-body").append(el("div", { class: "actions" }, buttons));
  if (view.editing === post.id && !waiting) card.querySelector(".post-body").append(editForm(post, ctx));
  return card;
}

export function renderCalendar(root, ctx) {
  const { state } = ctx;
  const today = todayIn(state.zone);
  const days = new Map();
  const shown = state.posts.filter((item) => visible(item, today))
    .sort((one, two) => (one.scheduled_local || "").localeCompare(two.scheduled_local || ""));
  for (const post of shown) {
    const day = post.scheduled_local ? post.scheduled_local.slice(0, 10) : "draft";
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(post);
  }
  const attention = state.posts.filter(needsAttention).length;
  const order = (day) => (day === "draft" ? "9999" : day);
  const sorted = [...days].sort(([one], [two]) => order(one).localeCompare(order(two)));
  const blocks = sorted.map(([day, posts]) => el("section", { class: "day" },
    el("h2", {}, day === "draft" ? "Черновики" : dayTitle(day, state.zone)),
    el("div", { class: "post-grid" }, posts.map((post) => postCard(post, ctx)))));
  root.replaceChildren(
    el("div", { class: "section-head" },
      el("h1", {}, "Календарь"),
      el("button", { type: "button", onclick: ctx.refresh }, "Обновить")),
    attention ? el("p", { class: "notice warn", role: "status" },
      `Нужно внимание: ${attention}. Откройте фильтр «Нужно внимание».`) : null,
    filterBar(ctx),
    ...(blocks.length ? blocks : [el("p", { class: "empty" }, "Постов нет.")]),
  );
}
