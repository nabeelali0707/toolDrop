# Models

::: info Status
Planned for Phase 2.
:::

toolDrop needs a model only to **build** and **repair** tools. Running a tool never calls one. The default is free local models through [Ollama](https://ollama.com), so nothing leaves your machine.

## The defaults

| Role | Used for | Under 16 GB of RAM | 16 GB or more |
| --- | --- | --- | --- |
| `code` | Writing recipes and repairs | `qwen2.5-coder:7b` (4.7 GB) | `qwen2.5-coder:14b` (9 GB) |
| `reasoning` | Exploring, questions, descriptions | `llama3.1:8b` (4.9 GB) | `llama3.1:8b` |

`tooldrop init` checks your memory and recommends these, then downloads them. Qwen2.5-Coder is Apache-2.0. Llama 3.1 is free to run under Meta's Llama 3.1 Community License, which is not an OSI-approved license; if you prefer, use `qwen2.5:7b` (Apache-2.0) for the `reasoning` role.

## Bring your own model

Any server that speaks the OpenAI `/v1/chat/completions` API works: llama.cpp, vLLM, LM Studio, LocalAI, or a hosted API with a free tier. `tooldrop init` asks for the base URL, the model name and an optional key. The key is stored encrypted in the vault, never in a config file.

Nothing in toolDrop requires a paid API.

## Privacy

- **Local endpoints** (your machine, or the Compose network): nothing leaves your machine.
- **External endpoints**, including Ollama's cloud models: toolDrop redacts personal data (emails, phone numbers, IDs) from everything it sends, and you cannot turn that off.
- **Always:** credentials, cookies and tokens are replaced by placeholders in every prompt, local or not.

## Why it works with smaller models

Local models are weaker than hosted frontier models, so toolDrop keeps their job small:

- Prompts hold pruned accessibility trees and short summaries of network traffic, never screenshots or whole pages.
- Every answer must be strict JSON that matches a schema. A wrong answer is retried with the validation errors, up to 3 times.
- Recordings are preferred over exploration, so the model labels what you did instead of searching.

Each call logs its tokens and duration, so you can see what builds and repairs cost in time.
