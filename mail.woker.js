/**
 * Cloudflare Email Worker (Email Routing + HTTP API)
 *
 * Compatible with current Python client expectations:
 * - POST /admin/new_address -> { jwt, address }
 * - GET  /api/mails         -> { results: [{ raw, ... }] }
 *
 * Required env:
 * - DB (D1 binding)
 * - ADMIN_PASSWORD
 *
 * Optional env:
 * - EMAIL_DOMAIN            (if set, domain must match this value)
 * - TOKEN_TTL_SECONDS       (default: 604800 = 7 days)
 */

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-admin-auth",
      ...extraHeaders,
    },
  });
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-admin-auth",
      ...extraHeaders,
    },
  });
}

function badRequest(message) {
  return jsonResponse({ error: message }, 400);
}

function unauthorized(message = "unauthorized") {
  return jsonResponse({ error: message }, 401);
}

function forbidden(message = "forbidden") {
  return jsonResponse({ error: message }, 403);
}

function parsePositiveInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeName(name) {
  if (typeof name !== "string") return "";
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!cleaned) return "";
  return cleaned.slice(0, 64);
}

function sanitizeDomain(domain) {
  if (typeof domain !== "string") return "";
  const cleaned = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) return "";
  return cleaned;
}

function generateToken() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  const randomHex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${crypto.randomUUID().replace(/-/g, "")}.${randomHex}`;
}

function safeJsonForScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003C";
      case ">":
        return "\\u003E";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

function normalizeMailRecord(record, index) {
  const fallbackId = `mail-${index}`;
  return {
    id: typeof record?.id === "string" && record.id ? record.id : fallbackId,
    source: typeof record?.source === "string" ? record.source : "",
    address: typeof record?.address === "string" ? record.address : "",
    subject:
      typeof record?.subject === "string" && record.subject.trim()
        ? record.subject
        : "(无主题)",
    content: typeof record?.content === "string" ? record.content : "",
    timestamp: typeof record?.timestamp === "string" ? record.timestamp : "",
  };
}

function renderDebugMailboxPage(mails) {
  const serializedMails = safeJsonForScript(mails);

  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>临时邮箱收件箱</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Poppins:wght@500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --pink: #FF6B9D;
      --coral: #FF8A5C;
      --yellow: #FFD93D;
      --mint: #6BCB77;
      --sky: #4DA8FF;
      --lavender: #A78BFA;
      --background: #FFF8F0;
      --surface: rgba(255, 255, 255, 0.92);
      --surface-strong: #ffffff;
      --text-main: #2D3047;
      --text-muted: #6B7094;
      --border: rgba(167, 139, 250, 0.2);
      --active-bg: linear-gradient(135deg, #FFF0F5, #F0F0FF);
      --active-border: var(--lavender);
      --shadow: 0 16px 40px rgba(167, 139, 250, 0.14), 0 4px 12px rgba(255, 107, 157, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: "Nunito", "Noto Sans SC", "PingFang SC", sans-serif;
      background:
        radial-gradient(ellipse at 10% -10%, rgba(255, 107, 157, 0.2), transparent 50%),
        radial-gradient(ellipse at 90% 0%, rgba(77, 168, 255, 0.18), transparent 45%),
        radial-gradient(ellipse at 50% 100%, rgba(255, 217, 61, 0.12), transparent 50%),
        var(--background);
      color: var(--text-main);
      min-height: 100vh;
      padding: 20px;
    }

    .mail-app {
      max-width: 1200px;
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 28px;
      box-shadow: var(--shadow);
      overflow: hidden;
      backdrop-filter: blur(8px);
    }

    .topbar {
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      background: linear-gradient(135deg, rgba(255, 107, 157, 0.1), rgba(77, 168, 255, 0.08), rgba(255, 217, 61, 0.1));
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .topbar h1 {
      margin: 0;
      font-family: "Poppins", "Noto Sans SC", "PingFang SC", sans-serif;
      font-size: clamp(22px, 3vw, 28px);
      line-height: 1.2;
      letter-spacing: 0.2px;
      background: linear-gradient(135deg, var(--pink), var(--lavender), var(--sky));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .topbar-right {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .meta {
      font-size: 14px;
      color: var(--text-muted);
      margin: 0;
      white-space: nowrap;
    }

    .refresh-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 18px;
      border: none;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--sky), var(--lavender));
      color: #ffffff;
      font-family: "Nunito", sans-serif;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 180ms ease, box-shadow 180ms ease, opacity 180ms ease;
      box-shadow: 0 4px 14px rgba(77, 168, 255, 0.3);
      white-space: nowrap;
    }

    .refresh-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(77, 168, 255, 0.4);
    }

    .refresh-btn:active {
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(77, 168, 255, 0.3);
    }

    .refresh-btn:focus-visible {
      outline: 2px solid var(--sky);
      outline-offset: 2px;
    }

    .refresh-btn .icon {
      display: inline-block;
      width: 16px;
      height: 16px;
      transition: transform 400ms ease;
    }

    .refresh-btn.spinning .icon {
      animation: spin 0.6s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(280px, 360px) 1fr;
      min-height: 68vh;
    }

    .mail-list-panel {
      border-right: 1px solid var(--border);
      background: rgba(255, 248, 240, 0.6);
    }

    .mail-list {
      padding: 14px;
      display: grid;
      gap: 10px;
      max-height: calc(68vh - 10px);
      overflow: auto;
    }

    .mail-list::-webkit-scrollbar {
      width: 6px;
    }

    .mail-list::-webkit-scrollbar-track {
      background: transparent;
    }

    .mail-list::-webkit-scrollbar-thumb {
      background: rgba(167, 139, 250, 0.25);
      border-radius: 3px;
    }

    .mail-item {
      width: 100%;
      text-align: left;
      border: 1.5px solid transparent;
      border-radius: 16px;
      background: var(--surface-strong);
      cursor: pointer;
      padding: 14px 16px;
      color: var(--text-main);
      transition: border-color 200ms ease, background 200ms ease, box-shadow 200ms ease, transform 200ms ease;
      position: relative;
      overflow: hidden;
    }

    .mail-item::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      border-radius: 4px 0 0 4px;
      background: transparent;
      transition: background 200ms ease;
    }

    .mail-item:nth-child(5n+1)::before { background: var(--pink); opacity: 0; transition: opacity 200ms ease; }
    .mail-item:nth-child(5n+2)::before { background: var(--coral); opacity: 0; transition: opacity 200ms ease; }
    .mail-item:nth-child(5n+3)::before { background: var(--yellow); opacity: 0; transition: opacity 200ms ease; }
    .mail-item:nth-child(5n+4)::before { background: var(--mint); opacity: 0; transition: opacity 200ms ease; }
    .mail-item:nth-child(5n+5)::before { background: var(--sky); opacity: 0; transition: opacity 200ms ease; }

    .mail-item:hover::before,
    .mail-item.active::before {
      opacity: 1;
    }

    .mail-item:hover {
      border-color: rgba(167, 139, 250, 0.3);
      box-shadow: 0 6px 18px rgba(167, 139, 250, 0.1);
      transform: translateX(2px);
    }

    .mail-item:focus-visible {
      outline: 2px solid var(--lavender);
      outline-offset: 1px;
    }

    .mail-item.active {
      background: linear-gradient(135deg, #FFF0F5, #F0F0FF);
      border-color: var(--lavender);
      box-shadow: 0 6px 20px rgba(167, 139, 250, 0.15);
      transform: translateX(2px);
    }

    .mail-item-subject {
      display: block;
      margin: 0 0 8px;
      font-size: 15px;
      line-height: 1.35;
      font-weight: 700;
      color: var(--text-main);
    }

    .mail-item-line {
      margin: 0;
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .mail-item-line + .mail-item-line {
      margin-top: 2px;
    }

    .mail-detail {
      background: linear-gradient(180deg, #FEFCFF, #F8F6FF);
      padding: 22px 24px;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 14px;
    }

    .mail-detail-header h2 {
      margin: 0 0 10px;
      font-family: "Poppins", "Noto Sans SC", "PingFang SC", sans-serif;
      font-size: clamp(19px, 2.5vw, 24px);
      line-height: 1.3;
      color: var(--text-main);
      word-break: break-word;
    }

    .mail-detail-meta {
      margin: 0;
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.7;
      word-break: break-all;
    }

    .mail-detail-body {
      border: 1.5px solid var(--border);
      border-radius: 16px;
      background: #ffffff;
      padding: 18px;
      overflow: auto;
      font-family: "Nunito", "Noto Sans SC", "PingFang SC", sans-serif;
      white-space: pre-wrap;
      margin: 0;
      line-height: 1.65;
      color: var(--text-main);
    }

    .mail-detail-frame {
      border: 1.5px solid var(--border);
      border-radius: 16px;
      background: #ffffff;
      width: 100%;
      min-height: 430px;
      height: 100%;
    }

    .empty-state {
      border: 2px dashed rgba(167, 139, 250, 0.3);
      border-radius: 16px;
      padding: 28px 20px;
      background: linear-gradient(135deg, #FFF8F0, #F8F0FF);
      text-align: center;
      font-size: 14px;
      color: var(--text-muted);
    }

    .empty-state-icon {
      font-size: 36px;
      margin-bottom: 8px;
      display: block;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 24px;
      padding: 0 8px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--pink), var(--coral));
      color: #fff;
      font-size: 12px;
      font-weight: 800;
    }

    @media (max-width: 900px) {
      body {
        padding: 12px;
      }

      .mail-app {
        border-radius: 20px;
      }

      .topbar {
        padding: 16px;
      }

      .layout {
        grid-template-columns: 1fr;
      }

      .mail-list-panel {
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }

      .mail-list {
        max-height: 42vh;
      }

      .mail-detail {
        min-height: 42vh;
        padding: 16px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    }
  </style>
</head>
<body>
  <main class="mail-app">
    <header class="topbar">
      <div class="topbar-left">
        <h1>临时邮箱收件箱</h1>
      </div>
      <div class="topbar-right">
        <p class="meta">共 <span class="badge" id="mail-count">0</span> 封邮件</p>
        <button type="button" class="refresh-btn" id="refresh-btn" title="刷新邮件列表">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
          刷新
        </button>
      </div>
    </header>

    <section class="layout" aria-label="邮件列表与详情">
      <aside class="mail-list-panel">
        <div id="mail-list" class="mail-list" role="listbox" aria-label="邮件列表"></div>
      </aside>

      <article class="mail-detail" aria-live="polite">
        <header class="mail-detail-header">
          <h2 id="mail-subject">请选择一封邮件</h2>
          <p id="mail-meta" class="mail-detail-meta">点击左侧列表查看邮件详情。</p>
        </header>
        <iframe id="mail-html-content" class="mail-detail-frame" title="邮件 HTML 预览" sandbox="" referrerpolicy="no-referrer" hidden></iframe>
        <pre id="mail-content" class="mail-detail-body">暂无内容</pre>
      </article>
    </section>
  </main>

  <script>
    const mails = ${serializedMails};
    const listEl = document.getElementById("mail-list");
    const subjectEl = document.getElementById("mail-subject");
    const metaEl = document.getElementById("mail-meta");
    const frameEl = document.getElementById("mail-html-content");
    const contentEl = document.getElementById("mail-content");
    const countEl = document.getElementById("mail-count");
    let activeIndex = -1;

    const looksLikeHtml = (value) => {
      if (typeof value !== "string") return false;
      return /<(html|body|div|table|p|span|a|img|br|style|meta)\b/i.test(value);
    };

    const decodeQuotedPrintable = (input) => {
      if (typeof input !== "string" || input.length === 0) return "";
      const normalized = input.replace(/=(\r?\n)/g, "");
      return normalized.replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => {
        const code = Number.parseInt(hex, 16);
        if (Number.isNaN(code)) return _;
        return String.fromCharCode(code);
      });
    };

    const parseCharset = (headersMap) => {
      const contentTypeRaw = String(headersMap["content-type"] || "");
      const charsetMatch = contentTypeRaw.match(/charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i);
      let charset = (charsetMatch?.[1] || charsetMatch?.[2] || charsetMatch?.[3] || "utf-8").trim().toLowerCase();
      if (!charset) return "utf-8";
      if (charset === "utf8") return "utf-8";
      if (charset === "gb2312") return "gbk";
      return charset;
    };

    const bytesToText = (bytes, charset) => {
      const preferred = [];
      if (charset) preferred.push(charset);
      if (!preferred.includes("utf-8")) preferred.push("utf-8");
      if (!preferred.includes("gbk")) preferred.push("gbk");
      if (!preferred.includes("gb18030")) preferred.push("gb18030");
      if (!preferred.includes("big5")) preferred.push("big5");
      if (!preferred.includes("iso-8859-1")) preferred.push("iso-8859-1");

      for (const candidate of preferred) {
        try {
          return new TextDecoder(candidate, { fatal: false }).decode(bytes);
        } catch {
          // Skip unsupported charset names in the current runtime.
        }
      }

      let text = "";
      for (const value of bytes) text += String.fromCharCode(value);
      return text;
    };

    const decodeBase64ToBytes = (input) => {
      if (typeof input !== "string") return new Uint8Array();
      const compact = input.replace(/\s+/g, "");
      if (!compact) return new Uint8Array();
      try {
        const binary = atob(compact);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i) & 0xff;
        }
        return bytes;
      } catch {
        return new Uint8Array();
      }
    };

    const decodeQuotedPrintableToBytes = (input) => {
      if (typeof input !== "string" || input.length === 0) return new Uint8Array();
      const normalized = input.replace(/=(\r?\n)/g, "");
      const bytes = [];
      for (let i = 0; i < normalized.length; i++) {
        const current = normalized[i];
        if (current === "=" && i + 2 < normalized.length) {
          const hex = normalized.slice(i + 1, i + 3);
          if (/^[A-Fa-f0-9]{2}$/.test(hex)) {
            bytes.push(Number.parseInt(hex, 16));
            i += 2;
            continue;
          }
        }
        bytes.push(normalized.charCodeAt(i) & 0xff);
      }
      return new Uint8Array(bytes);
    };

    const decodeBase64 = (input) => {
      if (typeof input !== "string") return "";
      const compact = input.replace(/\s+/g, "");
      if (!compact) return "";
      try {
        return atob(compact);
      } catch {
        return "";
      }
    };

    const splitHeadersAndBody = (input) => {
      if (typeof input !== "string") {
        return { headers: "", body: "", hasSeparator: false };
      }
      const separator = /\r?\n\r?\n/.exec(input);
      if (!separator || typeof separator.index !== "number") {
        return { headers: "", body: input, hasSeparator: false };
      }
      const index = separator.index;
      const length = separator[0].length;
      return {
        headers: input.slice(0, index),
        body: input.slice(index + length),
        hasSeparator: true
      };
    };

    const parseMimeHeaders = (headersText) => {
      const map = {};
      if (typeof headersText !== "string" || !headersText.trim()) return map;

      const lines = headersText.replace(/\r/g, "").split("\n");
      const folded = [];
      for (const line of lines) {
        if (!line) continue;
        if (/^[ \t]/.test(line) && folded.length > 0) {
          folded[folded.length - 1] += " " + line.trim();
        } else {
          folded.push(line.trim());
        }
      }

      for (const line of folded) {
        const sep = line.indexOf(":");
        if (sep <= 0) continue;
        const key = line.slice(0, sep).trim().toLowerCase();
        const value = line.slice(sep + 1).trim();
        if (!key) continue;
        if (map[key]) {
          map[key] += ", " + value;
        } else {
          map[key] = value;
        }
      }
      return map;
    };

    const decodePartBody = (body, headersMap) => {
      const encoding = String(headersMap["content-transfer-encoding"] || "").toLowerCase();
      const charset = parseCharset(headersMap);
      if (encoding.includes("base64")) {
        const bytes = decodeBase64ToBytes(body);
        if (bytes.length > 0) return bytesToText(bytes, charset);
        return decodeBase64(body) || body;
      }
      if (encoding.includes("quoted-printable")) {
        const bytes = decodeQuotedPrintableToBytes(body);
        if (bytes.length > 0) return bytesToText(bytes, charset);
        return decodeQuotedPrintable(body);
      }
      return body;
    };

    const parseMimeEntity = (headersMap, body) => {
      const contentTypeRaw = String(headersMap["content-type"] || "");
      const type = contentTypeRaw.toLowerCase();
      if (type.includes("multipart/")) {
        const boundaryMatch = contentTypeRaw.match(/boundary\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i);
        const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || boundaryMatch?.[3] || "").trim();
        if (boundary) {
          const marker = "--" + boundary;
          const segments = String(body).split(marker);
          let html = "";
          let text = "";

          for (let segment of segments) {
            segment = segment.trim();
            if (!segment || segment === "--") continue;
            if (segment.endsWith("--")) {
              segment = segment.slice(0, -2).trim();
            }
            if (!segment) continue;

            const part = splitHeadersAndBody(segment);
            const partHeaders = parseMimeHeaders(part.headers);
            const parsed = parseMimeEntity(partHeaders, part.body);
            if (!html && parsed.html) html = parsed.html;
            if (!text && parsed.text) text = parsed.text;
          }
          return { html, text };
        }
      }

      const decoded = decodePartBody(String(body || ""), headersMap);
      if (type.includes("text/html")) return { html: decoded, text: "" };
      if (type.includes("text/plain")) return { html: "", text: decoded };
      return { html: "", text: decoded };
    };

    const extractInlineHtml = (raw) => {
      if (typeof raw !== "string") return "";
      const doctypeMatch = raw.match(/<!doctype\s+html[\s\S]*$/i);
      if (doctypeMatch?.[0] && looksLikeHtml(doctypeMatch[0])) return doctypeMatch[0];
      const htmlMatch = raw.match(/<html[\s\S]*<\/html>/i);
      if (htmlMatch?.[0]) return htmlMatch[0];
      const bodyMatch = raw.match(/<body[\s\S]*<\/body>/i);
      if (bodyMatch?.[0]) return bodyMatch[0];
      return "";
    };

    const sanitizeHtml = (html) => {
      if (typeof html !== "string") return "";
      return html
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
        .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
    };

    const buildPreviewDocument = (html) => {
      const safe = sanitizeHtml(html);
      if (!safe) return "";
      if (/<html[\s>]/i.test(safe)) return safe;
      return "<!doctype html><html><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><base target=\"_blank\" /></head><body>" + safe + "</body></html>";
    };

    const buildMailPreview = (raw) => {
      if (typeof raw !== "string" || !raw.trim()) {
        return { html: "", text: "(邮件内容为空)" };
      }

      // 仅当内容开头就是 HTML 时才直接预览，避免把整封 MIME 原文误当成 HTML。
      const trimmed = raw.trimStart();
      const startsWithHtml =
        /^<!doctype\s+html[\s>]/i.test(trimmed) ||
        /^<html[\s>]/i.test(trimmed) ||
        /^<body[\s>]/i.test(trimmed) ||
        (/^</.test(trimmed) && looksLikeHtml(trimmed));
      if (startsWithHtml) {
        return { html: buildPreviewDocument(trimmed), text: raw };
      }

      const root = splitHeadersAndBody(raw);
      const rootHeaders = parseMimeHeaders(root.headers);
      const parsed = parseMimeEntity(rootHeaders, root.body);
      const htmlBody = String(parsed.html || "").trim();
      const textBody = String(parsed.text || "").trim();
      const inlineHtml = extractInlineHtml(raw);

      if (looksLikeHtml(htmlBody)) {
        return { html: buildPreviewDocument(htmlBody), text: textBody || raw };
      }
      if (looksLikeHtml(inlineHtml)) {
        return { html: buildPreviewDocument(inlineHtml), text: textBody || raw };
      }
      if (textBody) {
        return { html: "", text: textBody };
      }
      return { html: "", text: raw };
    };

    const formatTime = (value) => {
      if (!value) return "未知时间";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(date);
    };

    const renderActive = (index) => {
      if (!Array.isArray(mails) || !mails[index]) return;
      activeIndex = index;
      const item = mails[index];
      subjectEl.textContent = item.subject || "(无主题)";
      metaEl.textContent =
        "发件人：" + (item.source || "未知发件人") +
        "  |  收件人：" + (item.address || "未知收件人") +
        "  |  时间：" + formatTime(item.timestamp);
      let preview = { html: "", text: item.content || "(邮件内容为空)" };
      try {
        preview = buildMailPreview(item.content || "");
      } catch {
        preview = { html: "", text: item.content || "(邮件内容为空)" };
      }
      if (preview.html) {
        frameEl.hidden = false;
        frameEl.srcdoc = preview.html;
        contentEl.hidden = true;
        contentEl.textContent = "";
      } else {
        frameEl.hidden = true;
        frameEl.removeAttribute("srcdoc");
        contentEl.hidden = false;
        contentEl.textContent = preview.text || "(邮件内容为空)";
      }

      const nodes = listEl.querySelectorAll(".mail-item");
      nodes.forEach((node, nodeIndex) => {
        const isActive = nodeIndex === index;
        node.classList.toggle("active", isActive);
        node.setAttribute("aria-selected", isActive ? "true" : "false");
      });
    };

    const renderList = () => {
      listEl.innerHTML = "";
      countEl.textContent = String(Array.isArray(mails) ? mails.length : 0);

      if (!Array.isArray(mails) || mails.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.innerHTML = '<span class="empty-state-icon">📭</span>暂无邮件，点击右上角刷新按钮查看新邮件。';
        listEl.appendChild(empty);
        subjectEl.textContent = "暂无邮件";
        metaEl.textContent = "当前邮箱还没有收到邮件。";
        frameEl.hidden = true;
        frameEl.removeAttribute("srcdoc");
        contentEl.hidden = false;
        contentEl.textContent = "暂无内容";
        return;
      }

      mails.forEach((mail, index) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mail-item";
        btn.setAttribute("role", "option");
        btn.setAttribute("aria-selected", "false");

        const subject = document.createElement("strong");
        subject.className = "mail-item-subject";
        subject.textContent = mail.subject || "(无主题)";

        const from = document.createElement("p");
        from.className = "mail-item-line";
        from.textContent = "发件人：" + (mail.source || "未知发件人");

        const time = document.createElement("p");
        time.className = "mail-item-line";
        time.textContent = "时间：" + formatTime(mail.timestamp);

        btn.appendChild(subject);
        btn.appendChild(from);
        btn.appendChild(time);
        btn.addEventListener("click", () => renderActive(index));
        btn.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            renderActive(index);
          }
        });
        listEl.appendChild(btn);
      });

      renderActive(0);
    };

    const refreshBtn = document.getElementById("refresh-btn");
    refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.add("spinning");
      refreshBtn.disabled = true;
      window.location.reload();
    });

    renderList();
  </script>
</body>
</html>`;
}

function getBearerToken(request) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

async function cleanupExpiredTokens(env) {
  const nowIso = new Date().toISOString();
  await env.DB.prepare("DELETE FROM mailbox_tokens WHERE expires_at <= ?")
    .bind(nowIso)
    .run();
}

async function handleCreateAddress(request, env) {
  const adminAuth = request.headers.get("x-admin-auth") || "";
  if (!env.ADMIN_PASSWORD) {
    return jsonResponse({ error: "server misconfigured: ADMIN_PASSWORD missing" }, 500);
  }
  if (adminAuth !== env.ADMIN_PASSWORD) {
    return forbidden("invalid admin auth");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid json body");
  }

  const name = sanitizeName(body?.name);
  const requestedDomain = sanitizeDomain(body?.domain || env.EMAIL_DOMAIN || "");
  if (!name) return badRequest("invalid name");
  if (!requestedDomain) return badRequest("invalid domain");

  if (env.EMAIL_DOMAIN && requestedDomain !== String(env.EMAIL_DOMAIN).toLowerCase()) {
    return badRequest(`domain must be ${env.EMAIL_DOMAIN}`);
  }

  const address = `${name}@${requestedDomain}`;
  const jwt = generateToken();
  const now = new Date();
  const ttlSeconds = parsePositiveInt(env.TOKEN_TTL_SECONDS, 604800, 60, 31536000);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  await cleanupExpiredTokens(env);

  await env.DB.prepare(
    `
      INSERT INTO mailbox_tokens (token, address, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `
  )
    .bind(jwt, address, now.toISOString(), expiresAt)
    .run();

  // Python expects exactly these keys.
  return jsonResponse({ jwt, address });
}

async function resolveAddressByToken(request, env) {
  const token = getBearerToken(request);
  if (!token) return { error: unauthorized("missing bearer token") };

  await cleanupExpiredTokens(env);

  const row = await env.DB.prepare(
    "SELECT address FROM mailbox_tokens WHERE token = ? LIMIT 1"
  )
    .bind(token)
    .first();

  if (!row || !row.address) {
    return { error: unauthorized("invalid or expired token") };
  }
  return { address: row.address };
}

async function handleListMails(request, env) {
  const auth = await resolveAddressByToken(request, env);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const limit = parsePositiveInt(url.searchParams.get("limit"), 10, 1, 100);
  const offset = parsePositiveInt(url.searchParams.get("offset"), 0, 0, 100000);

  const query = await env.DB.prepare(
    `
      SELECT
        id,
        source,
        address,
        subject,
        content AS raw,
        timestamp
      FROM emails
      WHERE address = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `
  )
    .bind(auth.address, limit, offset)
    .all();

  const results = Array.isArray(query?.results) ? query.results : [];
  return jsonResponse({ results });
}

async function handleDebugList(request, env) {
  // Optional debugging endpoint.
  const url = new URL(request.url);
  const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 1, 100);
  const query = await env.DB.prepare(
    `
      SELECT id, source, address, subject, content, timestamp
      FROM emails
      ORDER BY timestamp DESC
      LIMIT ?
    `
  )
    .bind(limit)
    .all();

  const results = Array.isArray(query?.results) ? query.results : [];
  const mails = results.map((record, index) => normalizeMailRecord(record, index));
  return htmlResponse(renderDebugMailboxPage(mails));
}

async function persistInboundEmail(message, env) {
  const id = crypto.randomUUID();
  const source = message.from || "";
  const address = message.to || "";
  const subject = message.headers.get("subject") || "(无主题)";
  const rawBody = await new Response(message.raw).text();
  const timestamp = new Date().toISOString();

  await env.DB.prepare(
    `
      INSERT INTO emails (id, source, address, subject, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `
  )
    .bind(id, source, address, subject, rawBody, timestamp)
    .run();
}

export default {
  async email(message, env, ctx) {
    ctx.waitUntil(persistInboundEmail(message, env));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return jsonResponse({ ok: true }, 204);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    try {
      if (method === "GET" && path === "/health") {
        return jsonResponse({ ok: true, service: "mail-handler" });
      }
      if (method === "POST" && path === "/admin/new_address") {
        return handleCreateAddress(request, env);
      }
      if (method === "GET" && path === "/api/mails") {
        return handleListMails(request, env);
      }
      if (method === "GET" && path === "/") {
        return handleDebugList(request, env);
      }
      return jsonResponse({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: "internal error", detail: message }, 500);
    }
  },
};
