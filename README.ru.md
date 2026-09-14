# searxng-mcp

[English version](README.md)

MCP-сервер, предоставляющий веб-поиск через [SearxNG](https://searxng.org/)
и несколько вспомогательных инструментов (загрузка страниц, README с GitHub,
извлечение текста статьи) по протоколу Model Context Protocol.

## Возможности

- `web_search_xng` — поиск через один или два сервера SearxNG,
  маршрутизация управляется аргументом `instance`
  изначальная логика - модель ищет русскоязычные запросы по поисковику
  в зоне ru, а все остальное - в поисковике на VPS
  отсюда названия переменных
- `fetch_web_content` — скачать страницу и убрать HTML
- `fetch_github_readme` — получить README репозитория с GitHub
- `fetch_article` — скачать статью и извлечь основной текст
- Два транспорта: **SSE** (`/sse` + `/messages`) и **прямой HTTP** (`/mcp`)
- Настройка полностью через переменные окружения

## Маршрутизация по точкам

| Значение `instance` | Поведение |
|---|---|
| `ru` | Только RU-инстанс. Ошибки возвращаются как есть. |
| `vps` | Только VPS-инстанс. |
| `default` | Сначала RU; при ошибке или пустом результате — VPS. |
| `all` | Сначала RU, затем VPS в любом случае. |

Если настроен только один сервер, аргумент `instance` игнорируется
и все запросы идут в него.

## Конфигурация

| Переменная | По умолчанию | Описание |
|---|---|---|
| `SEARXNG_INSTANCE_RU` | `""` | URL основного («RU») инстанса SearxNG |
| `SEARXNG_INSTANCE_VPS` | `""` | URL вторичного («VPS») инстанса SearxNG |
| `PORT` | `3006` | HTTP-порт |

Хотя бы один из URL должен быть задан, иначе сервер завершится при старте.

## Установка

### Docker (рекомендуется)

docker pull ghcr.io/dolphin2702/searxng-mcp:latest

### Примеры развёртывания

| Сценарий | Файл |
|---|---|
| Два сервера (RU + VPS) | examples/docker-compose.two-instances.yml |
| Один сервер |	examples/docker-compose.one-instance.yml |

## Настройка MCP-клиента

### SSE

{
  "mcpServers": {
    "searxng": {
      "url": "http://localhost:3006/sse"
    }
  }
}

### Streamable HTTP

{
  "mcpServers": {
    "searxng": {
      "type": "streamable",
      "url": "http://localhost:3006/mcp"
    }
  }
}

## Инструменты

**web_search_xng**

Поиск в интернете через SearxNG.

Аргументы:
- q (строка, обязательно) — поисковый запрос
- count (число, по умолчанию 5) — количество результатов
- instance (строка, по умолчанию default) — default / ru / vps / all

Возвращает: список результатов в формате markdown.

**fetch_web_content**

Скачать страницу и вернуть текст без HTML.

Аргументы:
- url (строка, обязательно)
- max_chars (число, по умолчанию 30000)

**fetch_github_readme**

Получить README.md из репозитория GitHub (пробует main, затем master).

Аргументы:
- url (строка, обязательно) — URL репозитория

**fetch_article**

Скачать статью и извлечь основной текст (убирает header, footer, nav, скрипты).

Аргументы:
- url (строка, обязательно)

## HTTP API

| Метод | Путь | Описание |
|---|---|---|
| GET | /sse | SSE-поток
| POST | /messages?sessionId=... | Канал сообщений SSE
| POST | /mcp | Прямой JSON-RPC


## Разработка

git clone git@github.com:dolphin2702/searxng-mcp.git
cd searxng-mcp
npm install
SEARXNG_INSTANCE_VPS=https://search.example.com node server.js

## Лицензия

MIT

