# Model Compare Chat

A small chat app for asking **the same questions to several LLMs hosted on [OpenRouter](https://openrouter.ai)**
and comparing their answers side by side. It is built for testing how models handle *your own subject*: you
describe your field once (system prompt), then chat, follow up, rate and export.

## Features

- **Side-by-side streaming** answers from up to 8 models at once, each keeping its own conversation history
  so follow-up questions work naturally.
- **Model picker** over the live OpenRouter catalog (search, price per 1M tokens, context size, "free only" filter).
  You can also type any exact model id and press Enter.
- **Subject / system prompt** shared by all models, with saved **presets** (one per topic you work on).
- **Parameters**: temperature, max output tokens, reasoning effort (for models that support it).
- **Per-answer stats**: time to first token, total time, tokens, tokens/s, cost (in $), provider used.
- **Ratings** (1–5) per answer, with average per model.
- **Blind mode**: model names are hidden and shuffled until you click *Reveal*, so you judge answers unbiased.
- **Retry** an answer, **Stop** generation, conversation survives a page reload.
- **Export** to Markdown (summary table + answers grouped by question) or JSON, or save directly into `transcripts/`.

## Setup (≈ 1 minute)

Requirements: Python 3.9+ — nothing to `pip install`.

1. Get an API key at <https://openrouter.ai/keys> (add a few credits, or use only `:free` models).
2. Create your config file and paste the key into it:

   ```bash
   cp .env.example .env
   ```

3. Start the server:

   ```bash
   python3 server.py
   ```

4. Open <http://127.0.0.1:8000> in your browser.

Your key stays in `.env` on your machine: the browser talks to the local server, which forwards requests to
OpenRouter. `.env` and `transcripts/` are git-ignored.

## How to run a good comparison

1. Write a system prompt describing your domain, audience and expectations (e.g. *"You are an expert in X.
   Answer for professionals, cite sources/standards, say when you are unsure."*) and save it as a preset.
2. Pick 3–5 models: mix providers and price ranges (a frontier model, a cheap fast one, an open-weight one…).
3. Turn on **Blind mode** if you want to avoid brand bias.
4. Ask the same set of questions you know the answers to (including tricky edge cases from your field),
   rate each answer, then **Reveal** and **Export .md** to keep the results.
5. Keep temperature low (0–0.3) when you compare factual accuracy, higher for creative tasks.

## Project layout

```
server.py              # local server: serves the UI + proxies to OpenRouter (stdlib only)
static/index.html      # UI
static/app.js          # chat logic, streaming, export
static/style.css       # styles (light/dark)
tests/                 # unit tests with a fake OpenRouter API
```

## Tests

```bash
python3 -m unittest discover -s tests -v
```

The tests use `tests/mock_openrouter.py`, a fake OpenRouter API. You can also use it to try the UI without
spending credits:

```bash
python3 tests/mock_openrouter.py 8765
```

```bash
OPENROUTER_BASE_URL=http://127.0.0.1:8765/api/v1 OPENROUTER_API_KEY=test DEFAULT_MODELS=acme/alpha,acme/beta:free python3 server.py
```
