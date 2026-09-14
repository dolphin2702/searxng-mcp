# searxng-mcp

[🇷🇺 Русская версия](README.ru.md)

MCP server that exposes [SearxNG](https://searxng.org/) web search and
a handful of fetch tools (web page, GitHub README, article) over the
Model Context Protocol.

## Features

- `web_search_xng` — search via one or two SearxNG instances, with
  routing controlled by the `instance` argument
- `fetch_web_content` — download a page and strip HTML
- `fetch_github_readme` — fetch a repo README from GitHub
- `fetch_article` — download an article and extract the main text
- Two transports: **SSE** (`/sse` + `/messages`) and **direct HTTP** (`/mcp`)
- Configured entirely via environment variables

## Instance routing

| `instance` value | Behaviour |
|---|---|
| `ru` | Only the RU instance. Errors are returned as-is. |
| `vps` | Only the VPS instance. |
| `default` | Try RU; on error or empty result, try VPS. |
| `all` | Try RU, then VPS unconditionally. |

If only one instance is configured, the `instance` argument is ignored
and every call goes to that instance.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SEARXNG_INSTANCE_RU` | `""` | URL of the primary ("RU") SearxNG instance |
| `SEARXNG_INSTANCE_VPS` | `""` | URL of the secondary ("VPS") SearxNG instance |
| `PORT` | `3006` | HTTP port |

At least one of the two instance URLs must be set, otherwise the server
exits on startup.

## Installation

### Docker (recommended)

docker pull ghcr.io/dolphin2702/searxng-mcp:latest

## Run

docker run -d \
  --name searxng-mcp \
  -p 3006:3006 \
  -e SEARXNG_INSTANCE_RU=https://search.example.ru \
  -e SEARXNG_INSTANCE_VPS=https://search.example.com \
  ghcr.io/dolphin2702/searxng-mcp:latest

## Deployment examples

Two instances (RU + VPS):	examples/docker-compose.two-instances.yml
One instance:	examples/docker-compose.one-instance.yml

## MCP client configuration

### SSE transport

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

## Tools

**web_search_xng**

Search the web via SearxNG.

Arguments:
- q (string, required) — search query
- count (number, default 5) — number of results
- instance (string, default default) — default / ru / vps / all

Returns: markdown-formatted list of results.

**fetch_web_content**

Fetch a page and return its text content with HTML stripped.

Arguments:
- url (string, required)
- max_chars (number, default 30000)

**fetch_github_readme**

Fetch README.md from a GitHub repository (tries main, then master).

Arguments:
- url (string, required) — repository URL

**fetch_article**

Fetch an article and extract the main text (strips header, footer, nav, scripts).

Arguments:
- url (string, required)

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | /sse | SSE stream endpoint |
| POST | /messages?sessionId=... | SSE message channel
| POST | /mcp | Direct JSON-RPC

## Development

git clone git@github.com:dolphin2702/searxng-mcp.git
cd searxng-mcp
npm install
SEARXNG_INSTANCE_VPS=https://search.example.com node server.js

## License

MIT
