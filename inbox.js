"use strict";
// Sends a content plan into the private inbox bucket over its S3 API (SigV4 signed here with
// WebCrypto) and shows the Mac's answers from outbox/<uuid>.json. The key lives only in localStorage.

const STORAGE_KEY = "autopost-inbox";
const SENDS_KEY = "autopost-inbox-sends";
const MAX_SENDS = 20;
const UNSIGNED = "UNSIGNED-PAYLOAD";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const encoder = new TextEncoder();
const memory = new Map(); // stands in for localStorage when the browser blocks it

function readStored(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch {
    return memory.has(key) ? memory.get(key) : fallback;
  }
}

function writeStored(key, value) {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the page still works for this visit.
  }
}

function hostOf(endpoint) {
  return endpoint.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function regionOf(host) {
  const labels = host.split(".");
  return labels.length >= 4 && labels[0] === "s3" ? labels[1] : "auto";
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmac(key, text) {
  const imported = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(text));
}

// Same encoding as Python's quote(path, safe="/"): only A-Z a-z 0-9 - _ . ~ stay as they are.
function encodePath(path) {
  return path.split("/").map((part) => encodeURIComponent(part).replace(
    /[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  )).join("/");
}

async function signedFetch(config, method, key, { body = null, contentType = null } = {}) {
  const host = hostOf(config.endpoint);
  const region = regionOf(host);
  const path = encodePath(`/${config.bucket}/${key}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const payload = body === null ? EMPTY_SHA256 : UNSIGNED;
  const headers = { host, "x-amz-content-sha256": payload, "x-amz-date": stamp };
  if (contentType) headers["content-type"] = contentType;
  const names = Object.keys(headers).sort();
  const canonical = [
    method, path, "",
    names.map((name) => `${name}:${headers[name]}\n`).join(""),
    names.join(";"), payload,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonical)].join("\n");
  let signingKey = encoder.encode("AWS4" + config.appKey);
  for (const part of [day, region, "s3", "aws4_request"]) signingKey = await hmac(signingKey, part);
  const signature = hex(await hmac(signingKey, toSign));
  delete headers.host;
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.keyId}/${scope}, ` +
    `SignedHeaders=${names.join(";")}, Signature=${signature}`;
  let response;
  try {
    response = await fetch(`https://${host}${path}`, { method, headers, body, cache: "no-store" });
  } catch {
    throw new Error(
      "Нет связи с Backblaze. Проверьте интернет; если он есть — адрес ящика и правило CORS " +
      "(его ставит autopost-inbox setup).",
    );
  }
  return response;
}

function httpProblem(response) {
  if (response.status === 401 || response.status === 403) {
    return "Backblaze не принял ключ (HTTP " + response.status + "). Проверьте keyID и " +
      "applicationKey и что ключ открывает этот бакет на чтение и запись.";
  }
  if (response.status === 404) return "Бакет не найден (HTTP 404). Проверьте его имя и адрес.";
  return "Backblaze ответил ошибкой HTTP " + response.status + ". Попробуйте ещё раз позже.";
}

function safeName(name) {
  const cleaned = name.replace(/[\\/]/g, "_").replace(/^\.+/, "").trim();
  return cleaned || "file";
}

function parcelFiles(form) {
  const table = form.elements.table.files[0];
  if (!table) throw new Error("Выберите таблицу (.xlsx или .csv).");
  if (!/\.(xlsx|csv)$/i.test(table.name)) throw new Error("Таблица должна быть .xlsx или .csv.");
  const media = Array.from(form.elements.media.files);
  const zips = media.filter((file) => /\.zip$/i.test(file.name));
  if (zips.length > 1) throw new Error("Можно приложить только один ZIP-архив.");
  if (zips.length && media.length > 1) throw new Error("ZIP прикладывается один, без других медиа.");
  if (media.some((file) => /\.(xlsx|csv)$/i.test(file.name))) {
    throw new Error("Таблица должна быть одна — уберите её из медиа.");
  }
  const names = new Set();
  const files = [table, ...media].map((file) => {
    let name = safeName(file.name);
    while (names.has(name.toLowerCase())) name = "1_" + name;
    names.add(name.toLowerCase());
    return { name, file };
  });
  return { kind: zips.length ? "zip" : "file", files };
}

function manifestOf(form, kind) {
  const value = (name) => form.elements[name].value.trim();
  const manifest = { kind, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  if (value("planName")) manifest.plan_name = value("planName");
  if (kind === "drive") manifest.drive_url = value("driveUrl");
  if (value("startDate")) manifest.start_date = value("startDate");
  const channels = value("channels").split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  if (channels.length) manifest.channels = channels;
  return manifest;
}

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const status = $("send-status");
  status.textContent = text;
  status.className = "status" + (kind ? " " + kind : "");
}

async function send(event) {
  event.preventDefault();
  const form = event.target;
  const config = readConfig();
  const button = $("send-button");
  const progress = $("progress");
  let kind;
  let files = [];
  try {
    if (form.elements.source.value === "drive") {
      kind = "drive";
      if (!/^https:\/\/(docs|drive)\.google\.com\//.test(form.elements.driveUrl.value.trim())) {
        throw new Error("Нужна ссылка на Google Таблицу или папку Google Drive.");
      }
    } else {
      ({ kind, files } = parcelFiles(form));
    }
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }
  const manifest = manifestOf(form, kind);
  const id = crypto.randomUUID();
  const total = files.reduce((sum, item) => sum + item.file.size, 0) + 1;
  let done = 0;
  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  try {
    for (const [index, item] of files.entries()) {
      setStatus(`Загружаю ${index + 1} из ${files.length}: ${item.name}`);
      const response = await signedFetch(config, "PUT", `inbox/${id}/${item.name}`, {
        body: item.file, contentType: item.file.type || "application/octet-stream",
      });
      if (!response.ok) throw new Error(httpProblem(response));
      done += item.file.size;
      progress.value = done / total;
    }
    setStatus("Завершаю отправку…");
    const response = await signedFetch(config, "PUT", `inbox/${id}/manifest.json`, {
      body: JSON.stringify(manifest), contentType: "application/json",
    });
    if (!response.ok) throw new Error(httpProblem(response));
    progress.value = 1;
    rememberSend(id, manifest.plan_name || files[0]?.name || manifest.drive_url);
    form.reset();
    showSource();
    setStatus("Принято в ящик. Mac обработает план, когда включится.", "ok");
    renderSends();
  } catch (error) {
    setStatus(error.message + " План не отправлен.", "error");
  } finally {
    button.disabled = false;
    progress.hidden = true;
  }
}

function rememberSend(id, title) {
  const sends = readStored(SENDS_KEY, []);
  sends.unshift({ id, title, sent_at: new Date().toISOString() });
  writeStored(SENDS_KEY, sends.slice(0, MAX_SENDS));
}

async function statusOf(config, id) {
  const response = await signedFetch(config, "GET", `outbox/${id}.json`);
  if (response.status === 404) return { kind: "waiting", text: "ждёт Mac" };
  if (!response.ok) return { kind: "failed", text: httpProblem(response) };
  let answer;
  try {
    answer = await response.json();
  } catch {
    return { kind: "failed", text: "ответ Mac не читается" };
  }
  if (answer.status === "accepted") {
    return { kind: "accepted", text: `принято: ${answer.posts} ${postsWord(answer.posts)}` };
  }
  return { kind: "rejected", text: "отклонено", errors: answer.errors || [] };
}

function postsWord(count) {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "постов";
  if (ones === 1) return "пост";
  if (ones >= 2 && ones <= 4) return "поста";
  return "постов";
}

async function renderSends() {
  const config = readConfig();
  const sends = readStored(SENDS_KEY, []);
  const list = $("sends");
  $("history-empty").hidden = sends.length > 0;
  list.replaceChildren(...sends.map((item) => {
    const row = document.createElement("li");
    const title = document.createElement("div");
    title.textContent = item.title || item.id;
    const meta = document.createElement("div");
    meta.className = "muted small";
    meta.textContent = new Date(item.sent_at).toLocaleString("ru-RU") + " · ";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "проверяю…";
    meta.append(badge);
    row.append(title, meta);
    row.dataset.id = item.id;
    return row;
  }));
  await Promise.all(Array.from(list.children).map(async (row) => {
    const badge = row.querySelector(".badge");
    let state;
    try {
      state = await statusOf(config, row.dataset.id);
    } catch (error) {
      state = { kind: "failed", text: error.message };
    }
    badge.className = "badge " + state.kind;
    badge.textContent = state.text;
    if (state.errors && state.errors.length) {
      const errors = document.createElement("ul");
      for (const text of state.errors) {
        const line = document.createElement("li");
        line.textContent = text;
        errors.append(line);
      }
      row.append(errors);
    }
  }));
}

const ATTENTION_STATUSES = new Set(["needs_attention", "failed"]);

function formatIn(zone, value, options) {
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: zone }).format(value);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options).format(value);
  }
}

function dayTitle(isoDate, zone) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  const label = formatIn("UTC", noon, { weekday: "short", day: "numeric", month: "long" });
  const today = formatIn(zone, new Date(), { year: "numeric", month: "2-digit", day: "2-digit" });
  const [todayDay, todayMonth, todayYear] = today.split(".");
  return isoDate === `${todayYear}-${todayMonth}-${todayDay}` ? "Сегодня, " + label : label;
}

function badgeKind(status) {
  if (ATTENTION_STATUSES.has(status)) return "rejected";
  return status === "posted" ? "accepted" : "waiting";
}

function postRow(item, withDate) {
  const row = document.createElement("li");
  row.className = "post";
  const head = document.createElement("div");
  head.className = "post-head";
  const when = document.createElement("span");
  when.className = "post-time";
  const date = withDate && item.date ? item.date.split("-").reverse().join(".") + " " : "";
  when.textContent = item.time ? date + item.time : "без даты";
  const badge = document.createElement("span");
  badge.className = "badge " + badgeKind(item.status);
  badge.textContent = item.status_label;
  head.append(when, badge);
  const account = document.createElement("div");
  account.className = "small";
  account.textContent = `${item.account} · ${item.platform} · ${item.type}`;
  row.append(head, account);
  if (item.caption) {
    const caption = document.createElement("div");
    caption.className = "muted small";
    caption.textContent = item.caption;
    row.append(caption);
  }
  return row;
}

function dayBlock(title, items, withDate) {
  const block = document.createElement("section");
  block.className = "day";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("ul");
  list.append(...items.map((item) => postRow(item, withDate)));
  block.append(heading, list);
  return block;
}

async function renderCalendar() {
  const stamp = $("calendar-stamp");
  const warning = $("calendar-warning");
  const days = $("calendar-days");
  stamp.textContent = "Загружаю…";
  warning.hidden = true;
  let snapshot;
  try {
    const response = await signedFetch(readConfig(), "GET", "outbox/status.json");
    if (response.status === 404) {
      stamp.textContent = "";
      warning.textContent = "Mac ещё ни разу не выходил на связь. Календарь появится, когда " +
        "воркер запустится с настроенным ящиком.";
      warning.hidden = false;
      days.replaceChildren();
      return;
    }
    if (!response.ok) throw new Error(httpProblem(response));
    snapshot = await response.json();
  } catch (error) {
    stamp.textContent = error instanceof SyntaxError ? "Календарь не читается." : error.message;
    days.replaceChildren();
    return;
  }
  const zone = snapshot.timezone;
  const generated = new Date(snapshot.generated_at);
  const when = formatIn(zone, generated, {
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });
  stamp.textContent = `Календарь на момент ${when}`;
  if (Date.now() - generated.getTime() > 2 * (snapshot.heartbeat_s || 300) * 1000) {
    warning.textContent = `Mac не выходил на связь с ${when}. Календарь может быть устаревшим.`;
    warning.hidden = false;
  }
  const blocks = [];
  if (snapshot.attention.length) blocks.push(dayBlock("Нужно внимание", snapshot.attention, true));
  const byDay = new Map();
  for (const item of snapshot.posts) {
    if (!byDay.has(item.date)) byDay.set(item.date, []);
    byDay.get(item.date).push(item);
  }
  for (const [date, items] of byDay) blocks.push(dayBlock(dayTitle(date, zone), items, false));
  if (!blocks.length) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "На ближайшие две недели постов нет.";
    blocks.push(empty);
  }
  days.replaceChildren(...blocks);
}

function readConfig() {
  return readStored(STORAGE_KEY, {});
}

function hashDefaults() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { endpoint: params.get("endpoint") || "", bucket: params.get("bucket") || "" };
}

function showSource() {
  const source = $("send-form").elements.source.value;
  for (const block of document.querySelectorAll("[data-source]")) {
    block.hidden = block.dataset.source !== source;
  }
}

function render() {
  const config = readConfig();
  const ready = Boolean(config.endpoint && config.bucket && config.keyId && config.appKey);
  $("setup").hidden = ready;
  $("send").hidden = !ready;
  $("history").hidden = !ready;
  $("calendar").hidden = !ready;
  $("forget").hidden = !ready;
  if (!ready) {
    const form = $("setup-form");
    const defaults = hashDefaults();
    form.elements.endpoint.value = config.endpoint || defaults.endpoint;
    form.elements.bucket.value = config.bucket || defaults.bucket;
    return;
  }
  renderCalendar();
  renderSends();
}

document.addEventListener("DOMContentLoaded", () => {
  $("setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    const value = (name) => form.elements[name].value.trim();
    writeStored(STORAGE_KEY, {
      endpoint: hostOf(value("endpoint")),
      bucket: value("bucket"),
      keyId: value("keyId"),
      appKey: value("appKey"),
    });
    form.elements.appKey.value = "";
    render();
  });
  $("send-form").addEventListener("submit", send);
  $("send-form").addEventListener("change", showSource);
  $("refresh").addEventListener("click", renderSends);
  $("calendar-refresh").addEventListener("click", renderCalendar);
  $("forget").addEventListener("click", () => {
    const { endpoint, bucket } = readConfig();
    writeStored(STORAGE_KEY, { endpoint, bucket });
    render();
  });
  render();
});
