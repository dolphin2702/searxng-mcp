// ==========  Логика работы ==================
// Параметр instance
// "ru" Ищет только на российском сервере. Если ошибка — возвращает ошибку.
// "vps"        Ищет только на иностранном сервере.
// "default"    Сначала пытается на RU. При ошибке или пустом результате — пробует VPS.
// "all"        Пытается сначала на RU, затем на VPS (даже если RU вернул пустой результат, продолжает на VPS).
// =============================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
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
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
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
  } else if (effectiveInstance === "default") {
    order = ["ru", "vps"];
  } else if (effectiveInstance === "all") {
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

// ========== ЗАГРУЗКА КОНТЕНТА ==========
async function handleFetchWebContent({ url, max_chars }) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await resp.text();
    const cleaned = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { content: [{ type: "text", text: cleaned.slice(0, max_chars || 30000) }] };
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
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MCP/1.0)' }
    });
    const html = await resp.text();
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
    const body = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[^;]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { content: [{ type: "text", text: `# ${title}\n\n${body.slice(0, 50000)}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Ошибка: ${e.message}` }] };
  }
}

// ========== ПОГОДА ЧЕРЕЗ OPEN-METEO ==========
// Open-Meteo — бесплатный погодный API, без ключа, без капчи.
// Документация: https://open-meteo.com/en/docs

const WEATHER_CODES = {
  0: "ясно",
  1: "преимущественно ясно",
  2: "переменная облачность",
  3: "пасмурно",
  45: "туман",
  48: "изморозь",
  51: "лёгкая морось",
  53: "морось",
  55: "сильная морось",
  56: "лёгкая ледяная морось",
  57: "ледяная морось",
  61: "слабый дождь",
  63: "дождь",
  65: "сильный дождь",
  66: "слабый ледяной дождь",
  67: "ледяной дождь",
  71: "слабый снег",
  73: "снег",
  75: "сильный снег",
  77: "снежная крупа",
  80: "слабые ливни",
  81: "ливни",
  82: "сильные ливни",
  85: "слабый снегопад",
  86: "сильный снегопад",
  95: "гроза",
  96: "гроза с градом",
  99: "сильная гроза с градом",
};

function weatherDesc(code) {
  return WEATHER_CODES[code] || `код ${code}`;
}

async function handleGetWeather({ city, days = 3 }) {
  try {
    // 1. Геокодинг: название города → lat/lon
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`;
    const geoResp = await fetch(geoUrl, { signal: AbortSignal.timeout(8000) });
    if (!geoResp.ok) throw new Error(`Geocoding HTTP ${geoResp.status}`);
    const geoData = await geoResp.json();
    if (!geoData.results || !geoData.results.length) {
      return { content: [{ type: "text", text: `Город «${city}» не найден` }] };
    }
    const g = geoData.results[0];
    const { latitude, longitude, name, country, admin1, timezone } = g;

    // 2. Прогноз
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

    // 3. Форматирование
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
const server = new McpServer({ name: "searxng-search", version: "1.1.0" });

server.tool(
  "web_search_xng",
  {
    q: z.string(),
    count: z.number().default(5),
    instance: z.string().default("default")
  },
  handleSearch
);

server.tool("fetch_web_content", { url: z.string(), max_chars: z.number().default(30000) }, handleFetchWebContent);
server.tool("fetch_github_readme", { url: z.string() }, handleFetchGithubReadme);
server.tool("fetch_article", { url: z.string() }, handleFetchArticle);
server.tool(
  "get_weather",
  {
    city: z.string(),
    days: z.number().default(3)
  },
  handleGetWeather
);

// ========== HTTP-СЕРВЕР ==========
const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
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
        serverInfo: { name: "searxng-search", version: "1.1.0" }
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
            description: "Search the web via SearxNG. Instance: default (RU fallback VPS), ru (only RU), vps (only VPS), all (RU then VPS). If only one instance is configured, instance parameter is ignored.",
            inputSchema: {
              type: "object",
              properties: {
                q: { type: "string", description: "Search query" },
                count: { type: "number", default: 5, description: "Number of results" },
                instance: { type: "string", default: "default", description: "default / ru / vps / all" }
              },
              required: ["q"]
            }
          },
          {
            name: "fetch_web_content",
            description: "Fetch and extract readable text from a web page",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string", description: "URL of the page" },
                max_chars: { type: "number", default: 30000, description: "Maximum characters to return" }
              },
              required: ["url"]
            }
          },
          {
            name: "fetch_github_readme",
            description: "Fetch README.md from a GitHub repository",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string", description: "GitHub repository URL" }
              },
              required: ["url"]
            }
          },
          {
            name: "fetch_article",
            description: "Fetch and extract main content from an article",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string", description: "URL of the article" }
              },
              required: ["url"]
            }
          },
          {
            name: "get_weather",
            description: "Get a real weather forecast for a city via Open-Meteo API. Use this instead of web search for any weather questions — it returns accurate temperature, precipitation probability, and wind for up to 14 days. Accepts city name in any language (e.g. 'Санкт-Петербург', 'Moscow', 'Всеволожск').",
            inputSchema: {
              type: "object",
              properties: {
                city: { type: "string", description: "City name" },
                days: { type: "number", default: 3, description: "Number of days to forecast (1-14)" }
              },
              required: ["city"]
            }
          }
        ]
      }
    });
  }

  if (method === "ping") {
    return res.json({ jsonrpc: "2.0", id, result: {} });
  }

  if (id === undefined || id === null) {
    return res.status(204).end();
  }

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
