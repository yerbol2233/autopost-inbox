// Requests to the private bucket over its S3 API, SigV4-signed here with WebCrypto.

const UNSIGNED = "UNSIGNED-PAYLOAD";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const encoder = new TextEncoder();

export function hostOf(endpoint) {
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

export class BucketError extends Error {}

export function httpProblem(status) {
  if (status === 401 || status === 403) {
    return `Backblaze не принял ключ (HTTP ${status}). Проверьте keyID и applicationKey и что ` +
      "ключ открывает этот бакет на чтение и запись.";
  }
  if (status === 404) return "Бакет не найден (HTTP 404). Проверьте его имя и адрес.";
  return `Backblaze ответил ошибкой HTTP ${status}. Попробуйте ещё раз позже.`;
}

export class Bucket {
  constructor({ endpoint, bucket, keyId, appKey }) {
    this.host = hostOf(endpoint);
    this.region = regionOf(this.host);
    this.bucket = bucket;
    this.keyId = keyId;
    this.appKey = appKey;
  }

  async request(method, key, { body = null, contentType = null } = {}) {
    const path = encodePath(`/${this.bucket}/${key}`);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const day = stamp.slice(0, 8);
    const payload = body === null ? EMPTY_SHA256 : UNSIGNED;
    const headers = { host: this.host, "x-amz-content-sha256": payload, "x-amz-date": stamp };
    if (contentType) headers["content-type"] = contentType;
    const names = Object.keys(headers).sort();
    const canonical = [
      method, path, "",
      names.map((name) => `${name}:${headers[name]}\n`).join(""),
      names.join(";"), payload,
    ].join("\n");
    const scope = `${day}/${this.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonical)].join("\n");
    let signingKey = encoder.encode("AWS4" + this.appKey);
    for (const part of [day, this.region, "s3", "aws4_request"]) {
      signingKey = await hmac(signingKey, part);
    }
    const signature = hex(await hmac(signingKey, toSign));
    delete headers.host;
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.keyId}/${scope}, ` +
      `SignedHeaders=${names.join(";")}, Signature=${signature}`;
    try {
      return await fetch(`https://${this.host}${path}`, { method, headers, body, cache: "no-store" });
    } catch {
      throw new BucketError(
        "Нет связи с Backblaze. Проверьте интернет; если он есть — адрес ящика и правило CORS " +
        "(его ставит autopost-inbox setup).",
      );
    }
  }

  /** The object's JSON, or null if there is no such object. */
  async getJson(key) {
    const response = await this.request("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) throw new BucketError(httpProblem(response.status));
    try {
      return await response.json();
    } catch {
      throw new BucketError(`Файл ${key} не читается.`);
    }
  }

  /** The object as a Blob, or null if there is no such object. */
  async getBlob(key) {
    const response = await this.request("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) throw new BucketError(httpProblem(response.status));
    return response.blob();
  }

  async put(key, body, contentType) {
    const response = await this.request("PUT", key, { body, contentType });
    if (!response.ok) throw new BucketError(httpProblem(response.status));
  }

  putJson(key, value) {
    return this.put(key, JSON.stringify(value), "application/json");
  }
}
