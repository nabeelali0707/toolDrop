# hn_front_page

Lists the stories on the Hacker News front page.

- **Site:** [hn.algolia.com](https://hn.algolia.com/api), the public Hacker News search API that Algolia provides. It needs no sign-in and no API key.
- **Strategy:** `official_api`, a single `GET /api/v1/search?tags=front_page` request.
- **Input:** `limit`, how many stories to return (1 to 50, default 30).
- **Output:** one object per story with `title`, `url` (missing for text posts such as Ask HN), `points`, `author`, `comments` and `posted_at`.

Example question for an agent: "What are the top 5 stories on Hacker News right now?"
