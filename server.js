// ==========  Логика работы ==================
// Параметр instance
// "ru" Ищет только на российском сервере. Если ошибка — возвращает ошибку.
// "vps"        Ищет только на иностранном сервере.
// "default"    Сначала пытается на RU. При ошибке или пустом результате — пробует VPS.
// "all"        Пытается сначала на RU, затем на VPS.
// =============================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import * as cheerio from "cheerio";
import { z } from "zod";

// ========== КОНФИГУРАЦИЯ ЭКЗЕМПЛЯРОВ ==========
const rawInstances = {
  ru: process.env.SEARXNG_INSTANCE_RU,
  vps: process.env.SEARXNG_INSTANCE_VPS
};

const instances = {};
for (const [key, url] of Object.entries(rawInstances)) {
  if (url) instances[key] = url;
}

if (Object.keys(instances).length === 0) {
  console.error("❌ Ни один экземпляр SearXNG не задан. Установите SEARXNG_INSTANCE_RU или SEARXNG_INSTANCE_VPS");
  process.exit(1);
}

// ========== ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ПОИСКА ==========
async function performSearch(baseUrl, q, count) {
  const url = `${baseUrl}/search?q=${encodeURIComponent(q)}&format=json&number_of_results=${count || 5}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const results = (data.results || []).slice(0, count || 5)
    .map(r => `[${r.title}](${r.url})\n${r.content || ""}`).join("\n\n");
  return results || null;
}

// ========== ХЕНДЛЕР ПОИСКА ==========
async function handleSearch({ q, count, instance = "default" }) {
  const keys = Object.keys(instances);
  let effectiveInstance = instance;
  if (keys.length === 1) {
    effectiveInstance = keys[0];
  }

  const errors = [];
  let finalResults = null;

  let order = [];
  if (effectiveInstance === "ru") {
    order = ["ru"];
  } else if (effectiveInstance === "vps") {
    order = ["vps"];
  } else if (effectiveInstance === "default" || effectiveInstance === "all") {
    order = ["ru", "vps"];
  } else {
    return { content: [{ type: "text", text: `❌ Неизвестный или недоступный экземпляр: ${effectiveInstance}` }] };
  }

  order = order.filter(key => instances[key]);

  if (order.length === 0) {
    return { content: [{ type: "text", text: `❌ Нет доступных экземпляров для поиска (запрошен: ${effectiveInstance})` }] };
  }

  for (const key of order) {
    const baseUrl = instances[key];
    try {
      const results = await performSearch(baseUrl, q, count);
      if (results !== null) {
        finalResults = results;
        break;
      } else {
        if (effectiveInstance === "ru" || effectiveInstance === "vps") {
          finalResults = "Ничего не найдено.";
          break;
        }
        errors.push(`${key}: пустой результат`);
      }
    } catch (e) {
      errors.push(`${key}: ${e.message}`);
    }
  }

  if (finalResults === null) {
    if (errors.length) {
      return { content: [{ type: "text", text: `❌ Ошибка при обращении ко всем экземплярам:\n${errors.join("\n")}` }] };
    } else {
      return { content: [{ type: "text", text: "Ничего не найдено." }] };
    }
  }

  return { content: [{ type: "text", text: finalResults }] };
}

// ========== УМНОЕ ИЗВЛЕЧЕНИЕ КОНТЕНТА ==========
const NOISE_SELECTORS = [
  "script", "style", "noscript", "iframe", "svg", "canvas", "form",
  "nav", "header", "footer", "aside",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  "[role='complementary']", "[aria-hidden='true']",
  ".nav", ".navbar", ".menu", ".header", ".footer", ".sidebar",
  ".breadcrumbs", ".pagination", ".share", ".social", ".comments",
  ".advertisement", ".ad", ".ads", ".banner", ".cookie", ".popup",
  ".modal", ".subscribe", ".newsletter",
];

function extractMainContent(html, maxChars) {
  const $ = cheerio.load(html);

  // 1. Remove noise
  for (const sel of NOISE_SELECTORS) {
    try { $(sel).remove(); } catch (_) { /* ignore invalid selectors */ }
  }

  // 2. Pick the best container
  let container = $("article").first();
  if (!container.length) container = $("main").first();
  if (!container.length) container = $("[role='main']").first();

  if (!container.length) {
    let bestDiv = null;
    let bestLen = 0;
    $("div").each((_, el) => {
      const len = $(el).text().replace(/\s+/g, " ").trim().length;
      if (len > bestLen) {
        bestLen = len;
        bestDiv = el;
      }
    });
    if (bestDiv && bestLen > 200) {
      container = $(bestDiv);
    }
  }

  if (!container.length) container = $("body");

  // 3. Convert tables to pipe-separated rows BEFORE extracting text.
  //    Each row becomes "cell1 | cell2 | cell3".
  //    This preserves the meaning of columns (player | position | date | from | to).
  container.find("table").each((_, table) => {
    const rows = [];
    $(table).find("tr").each((_, tr) => {
      const cells = $(tr).find("td, th").map((_, cell) => {
        return $(cell).text().replace(/\s+/g, " ").trim();
      }).get();
      if (cells.length > 0) {
        rows.push(cells.join(" | "));
      }
    });
    if (rows.length > 0) {
      // Surround table with newlines so it stays a distinct block.
      $(table).replaceWith("\n\n" + rows.join("\n") + "\n\n");
    }
  });

  // 4. Convert block-level tags and <br> to newlines so paragraphs stay apart.
  container.find("br").replaceWith("\n");
  container.find("p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article")
    .each((_, el) => {
      $(el).append("\n");
    });

  // 5. Extract plain text and normalize whitespace.
  let text = container.text();
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  // 6. Filter lines.
  //    - Keep lines with pipe separators (table rows) unconditionally.
  //    - Keep long lines (> 40 chars) or lines that end with sentence punctuation.
  //    - Remove short lines that look like menu items or buttons.
  //    - Remove lines that appear more than twice (boilerplate).
  const seen = new Map();
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  const filtered = [];
  for (const line of lines) {
    const isTableRow = line.includes(" | ");
    if (!isTableRow) {
      if (line.length < 40 && !/[.!?]$/.test(line)) {
        continue;
      }
    }
    seen.set(line, (seen.get(line) || 0) + 1);
    filtered.push(line);
  }

  const cleaned = filtered.filter(line => {
    if (line.includes(" | ")) return true;  // keep all table rows
    return (seen.get(line) || 0) <= 2;
  });

  const result = cleaned.join("\n\n").trim();
  return result.slice(0, maxChars || 30000);
}

// ========== ЗАГРУЗКА КОНТЕНТА ==========
async function handleFetchWebContent({ url, max_chars }) {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "ru,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      return { content: [{ type: "text", text: `Ошибка HTTP ${resp.status} при загрузке ${url}` }] };
    }
    const html = await resp.text();
    const text = extractMainContent(html, max_chars || 30000);
    if (!text || text.length < 100) {
      return { content: [{ type: "text", text: `Не удалось извлечь содержимое из ${url}. Возможно, страница требует авторизации или использует JavaScript для рендеринга.` }] };
    }
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Ошибка загрузки: ${e.message}` }] };
  }
}

async function handleFetchGithubReadme({ url }) {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return { content: [{ type: "text", text: "Некорректный URL GitHub" }] };
  const raw = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/README.md`;
  try {
    const resp = await fetch(raw, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      const raw2 = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/master/README.md`;
      const resp2 = await fetch(raw2, { signal: AbortSignal.timeout(10000) });
      return { content: [{ type: "text", text: await resp2.text() }] };
    }
    return { content: [{ type: "text", text: await resp.text() }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Ошибка: ${e.message}` }] };
  }
}

async function handleFetchArticle({ url }) {
  return handleFetchWebContent({ url, max_chars: 50000 });
}

// ========== ПОГОДА ЧЕРЕЗ OPEN-METEO ==========
const WEATHER_CODES = {
  0: "ясно", 1: "преимущественно ясно", 2: "переменная облачность", 3: "пасмурно",
  45: "туман", 48: "изморозь",
  51: "лёгкая морось", 53: "морось", 55: "сильная морось",
  56: "лёгкая ледяная морось", 57: "ледяная морось",
  61: "слабый дождь", 63: "дождь", 65: "сильный дождь",
  66: "слабый ледяной дождь", 67: "ледяной дождь",
  71: "слабый снег", 73: "снег", 75: "сильный снег", 77: "снежная крупа",
  80: "слабые ливни", 81: "ливни", 82: "сильные ливни",
  85: "слабый снегопад", 86: "сильный снегопад",
  95: "гроза", 96: "гроза с градом", 99: "сильная гроза с градом",
};

function weatherDesc(code) {
  return WEATHER_CODES[code] || `код ${code}`;
}

async function handleGetWeather({ city, days = 3 }) {
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`;
    const geoResp = await fetch(geoUrl, { signal: AbortSignal.timeout(8000) });
    if (!geoResp.ok) throw new Error(`Geocoding HTTP ${geoResp.status}`);
    const geoData = await geoResp.json();
    if (!geoData.results || !geoData.results.length) {
      return { content: [{ type: "text", text: `Город «${city}» не найден` }] };
    }
    const g = geoData.results[0];
    const { latitude, longitude, name, country, admin1, timezone } = g;

    const daysClamped = Math.min(Math.max(Number(days) || 3, 1), 14);
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
      timezone: timezone || "auto",
      forecast_days: String(daysClamped),
    });
    const fcUrl = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const fcResp = await fetch(fcUrl, { signal: AbortSignal.timeout(8000) });
    if (!fcResp.ok) throw new Error(`Forecast HTTP ${fcResp.status}`);
    const fc = await fcResp.json();

    const place = [name, admin1, country].filter(Boolean).join(", ");
    const daily = fc.daily || {};
    const times = daily.time || [];

    const lines = [`Погода: ${place}`, ""];
    for (let i = 0; i < times.length; i++) {
      const d = times[i];
      const code = daily.weather_code?.[i];
      const tmax = daily.temperature_2m_max?.[i];
      const tmin = daily.temperature_2m_min?.[i];
      const precip = daily.precipitation_probability_max?.[i];
      const wind = daily.wind_speed_10m_max?.[i];
      const parts = [weatherDesc(code)];
      if (tmin != null && tmax != null) parts.push(`${tmin}…${tmax}°C`);
      if (precip != null) parts.push(`осадки ${precip}%`);
      if (wind != null) parts.push(`ветер ${wind} км/ч`);
      lines.push(`${d}: ${parts.join(", ")}`);
    }
    lines.push("");
    lines.push("Источник: Open-Meteo (open-meteo.com)");

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Ошибка получения погоды: ${e.message}` }] };
  }
}

// ========== SDK-СЕРВЕР ==========
const server = new McpServer({ name: "searxng-search", version: "0.2.1" });

server.tool(
  "web_search_xng",
  { q: z.string(), count: z.number().default(5), instance: z.string().default("default") },
  handleSearch
);
server.tool("fetch_web_content", { url: z.string(), max_chars: z.number().default(30000) }, handleFetchWebContent);
server.tool("fetch_github_readme", { url: z.string() }, handleFetchGithubReadme);
server.tool("fetch_article", { url: z.string() }, handleFetchArticle);
server.tool("get_weather", { city: z.string(), days: z.number().default(3) }, handleGetWeather);

// ========== HTTP-СЕРВЕР ==========
const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

const toolHandlers = {
  web_search_xng: handleSearch,
  fetch_web_content: handleFetchWebContent,
  fetch_github_readme: handleFetchGithubReadme,
  fetch_article: handleFetchArticle,
  get_weather: handleGetWeather,
};

const transports = {};
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await server.connect(transport);
});
app.post("/messages", async (req, res) => {
  const t = transports[req.query.sessionId];
  if (t) await t.handlePostMessage(req, res, req.body);
  else res.status(400).send("No session");
});

app.post("/mcp", async (req, res) => {
  const { method, id, params } = req.body;

  if (method === "initialize") {
    return res.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "searxng-search", version: "0.2.1" }
      }
    });
  }

  if (method === "tools/list") {
    return res.json({
      jsonrpc: "2.0", id,
      result: {
        tools: [
          {
            name: "web_search_xng",
            description: "Search the web via SearxNG. Instance: default (RU fallback VPS), ru (only RU), vps (only VPS), all (RU then VPS).",
            inputSchema: {
              type: "object",
              properties: {
                q: { type: "string", description: "Search query" },
                count: { type: "number", default: 5 },
                instance: { type: "string", default: "default" }
              },
              required: ["q"]
            }
          },
          {
            name: "fetch_web_content",
            description: "Fetch a web page and extract the MAIN text content (article body). Tables are converted to pipe-separated rows (cell1 | cell2 | cell3), which is useful for structured data like transfer lists, schedules, and specs. Returns clean readable text without navigation, ads, or boilerplate.",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string" },
                max_chars: { type: "number", default: 30000 }
              },
              required: ["url"]
            }
          },
          {
            name: "fetch_github_readme",
            description: "Fetch README.md from a GitHub repository",
            inputSchema: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"]
            }
          },
          {
            name: "fetch_article",
            description: "Fetch an article and return its full text (up to 50000 chars). Same extraction as fetch_web_content, with table support.",
            inputSchema: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"]
            }
          },
          {
            name: "get_weather",
            description: "Get a real weather forecast for a city via Open-Meteo API. Use for any weather questions. Accepts city name in any language. Returns accurate temperature, precipitation probability, and wind for 1-14 days.",
            inputSchema: {
              type: "object",
              properties: {
                city: { type: "string" },
                days: { type: "number", default: 3 }
              },
              required: ["city"]
            }
          }
        ]
      }
    });
  }

  if (method === "ping") return res.json({ jsonrpc: "2.0", id, result: {} });
  if (id === undefined || id === null) return res.status(204).end();

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    const handler = toolHandlers[name];
    if (!handler) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Tool ${name} not found` } });
    }
    try {
      const result = await handler(args);
      return res.json({ jsonrpc: "2.0", id, result: { content: result.content } });
    } catch (e) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
    }
  }

  return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method ${method} not found` } });
});

const PORT = Number(process.env.PORT) || 3006;
app.listen(PORT, () => console.log(`✅ SearxNG MCP running on http://0.0.0.0:${PORT}`));
