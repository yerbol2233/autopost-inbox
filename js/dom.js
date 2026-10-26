// Small DOM builders: every text goes in through textContent, never as HTML.

export const $ = (id) => document.getElementById(id);

/** An element with attributes (`on*` functions become listeners) and children (text or nodes). */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith("on") && typeof value === "function") {
      node.addEventListener(name.slice(2), value);
    } else if (name === "class") {
      node.className = value;
    } else if (value === true) {
      node.setAttribute(name, "");
    } else {
      node.setAttribute(name, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** A status line next to a form: `kind` is "ok", "error" or empty. */
export function setStatus(node, text, kind = "") {
  node.textContent = text;
  node.className = "status-line" + (kind ? " " + kind : "");
}

export function formatIn(zone, value, options) {
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: zone }).format(value);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options).format(value);
  }
}

/** Today in the zone as YYYY-MM-DD. */
export function todayIn(zone) {
  const parts = formatIn(zone, new Date(), { year: "numeric", month: "2-digit", day: "2-digit" });
  const [day, month, year] = parts.split(".");
  return `${year}-${month}-${day}`;
}

export function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The Russian word form for the count: plural(3, ["пост", "поста", "постов"]) -> "поста". */
export function plural(count, [one, few, many]) {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}
