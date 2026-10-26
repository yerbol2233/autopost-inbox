// localStorage that never throws: a blocked or private storage falls back to memory for the visit.

const memory = new Map();

export function readStored(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch {
    return memory.has(key) ? memory.get(key) : fallback;
  }
}

export function writeStored(key, value) {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the page still works for this visit.
  }
}
