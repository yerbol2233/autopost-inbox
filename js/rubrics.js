// Recognises a plan written by rubrics and reads only rubric names, text counts and frequencies —
// a port of `planning/rubric_plan.py` (is_rubric_layout, parse_rubrics, parse_cadence). The Mac
// parses the table itself; it checks that the number of rubric settings matches its own reading.

const SHEETJS = "../vendor/xlsx-0.20.3.mjs";
const TEMPLATE_HEADERS = new Set([
  "caption", "channel", "date", "files", "first_comment", "scheduled_at", "time", "type",
  "время", "дата", "канал", "первый комментарий", "подпись", "тип", "файлы",
]);
const DAYS_LABEL = "дата";
const WEEKDAY_PREFIX = "w";
const NUMBER_WORDS = {
  один: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  десять: 10,
};
const WEEKDAY_STEMS = ["понедельник", "вторник", "сред", "четверг", "пятниц", "суббот", "воскресен"];
const WEEKDAY_PLURALS = [
  "понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам", "воскресеньям",
];
const EVERY_N_DAYS = /^раз в ([\p{L}\p{N}_]+) (?:день|дня|дней)$/u;
const ON_WEEKDAY = /^по ([\p{L}\p{N}_]+)$/u;
export const DEFAULT_TIME = "10:00";

const words = (text) => text.split(/\s+/).filter(Boolean).join(" ");
const isDigits = (text) => /^\d+$/.test(text);

/** Russian name of a frequency key: "1" every day, "3" every 3 days, "w6" on Sundays. */
export function cadenceLabel(key) {
  if (key.startsWith(WEEKDAY_PREFIX)) return `по ${WEEKDAY_PLURALS[Number(key.slice(1))]}`;
  const days = Number(key);
  if (days === 1) return "каждый день";
  if (days === 2) return "через день";
  return `раз в ${days} ${days < 5 ? "дня" : "дней"}`;
}

/** The frequency keys offered: daily .. weekly, weekdays, plus any found in the table. */
export function cadenceKeys(extra = []) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map(String);
  for (let day = 0; day < 7; day += 1) keys.push(`${WEEKDAY_PREFIX}${day}`);
  for (const key of extra) if (key !== null && !keys.includes(key)) keys.push(key);
  return keys;
}

function count(word) {
  return isDigits(word) ? Number(word) : NUMBER_WORDS[word];
}

function stripEnds(text, characters) {
  let start = 0;
  let end = text.length;
  while (start < end && characters.includes(text[start])) start += 1;
  while (end > start && characters.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** Frequency key of a cell text, or null when it is not a frequency the Mac knows. */
export function parseCadence(text) {
  const normal = stripEnds(words(text.toLowerCase().replaceAll("ё", "е")), " .,;:");
  if (["", "каждый день", "ежедневно", "раз в день"].includes(normal)) return "1";
  if (normal === "через день") return "2";
  if (["раз в неделю", "еженедельно"].includes(normal)) return "7";
  const every = EVERY_N_DAYS.exec(normal);
  if (every && count(every[1])) return String(count(every[1]));
  const onDay = ON_WEEKDAY.exec(normal);
  if (onDay) {
    const day = WEEKDAY_STEMS.findIndex((stem) => onDay[1].startsWith(stem));
    if (day >= 0) return `${WEEKDAY_PREFIX}${day}`;
  }
  return null;
}

function rowTexts(row) {
  return (row || []).map((cell) => (cell === null || cell === undefined ? "" : String(cell).trim()));
}

function isNumbered(cells) {
  return cells.some(Boolean) && cells.every((cell) => !cell || isDigits(cell));
}

function hasCadence(label) {
  const cadenceText = label.includes("\n") ? label.slice(label.indexOf("\n") + 1) : "";
  return Boolean(cadenceText.trim()) && parseCadence(cadenceText) !== null;
}

function hasTemplateHeader(grid) {
  return (grid[0] || []).some((cell) => TEMPLATE_HEADERS.has(words(String(cell || "").toLowerCase())));
}

function isRubricLayout(grid) {
  const rows = grid.map((row) => {
    const texts = rowTexts(row);
    return texts.length ? texts : [""];
  });
  for (const [position, row] of rows.entries()) {
    const [label, ...cells] = row;
    if (!label) continue;
    if (stripEnds(label.toLowerCase(), " :") === DAYS_LABEL || hasCadence(label)) return true;
    const following = rows[position + 1] || [""];
    if (isNumbered(cells) && !following[0] && following.slice(1).some(Boolean)) return true;
  }
  return false;
}

/** Rubrics of the plan in the table's order: name, number of texts, frequency key, own dates. */
function parseRubrics(grid) {
  const rows = grid.map(rowTexts);
  const rubrics = [];
  let days = [];
  let position = 0;
  while (position < rows.length) {
    const row = rows[position];
    position += 1;
    const label = row.length ? row[0] : "";
    const cells = row.slice(1);
    if (!label) continue;
    if (stripEnds(label.toLowerCase(), " :") === DAYS_LABEL) {
      days = cells.filter(Boolean);
      continue;
    }
    const cut = label.indexOf("\n");
    const name = words(cut >= 0 ? label.slice(0, cut) : label);
    const cadenceText = cut >= 0 ? words(label.slice(cut + 1)) : "";
    let texts;
    if (isNumbered(cells)) {
      texts = cells.filter(Boolean);
      if (position < rows.length && rows[position].length && !rows[position][0]) position += 1;
    } else {
      texts = cells.filter(Boolean);
    }
    if (!texts.length) continue;
    rubrics.push({
      name, cadenceText, cadence: parseCadence(cadenceText), count: texts.length, ownDates: days.length > 0,
    });
    days = [];
  }
  return rubrics;
}

/** Rubrics of the table file, or null when it is a template table (or does not read). */
export async function readRubrics(file) {
  const XLSX = await import(SHEETJS);
  const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const active = book.Workbook?.Views?.[0]?.activeTab ?? 0;
  const sheet = book.Sheets[book.SheetNames[active] ?? book.SheetNames[0]];
  if (!sheet) return null;
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  if (hasTemplateHeader(grid) || !isRubricLayout(grid)) return null;
  const rubrics = parseRubrics(grid);
  return rubrics.length ? rubrics : null;
}
