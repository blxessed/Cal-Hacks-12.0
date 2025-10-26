## Inspiration
Nowadays, misinformation spreads faster than truth. While social media has made information more accessible, it’s also made it difficult to know what’s true. With many news channels delivering conflicting reports, we wanted a tool that could quickly verify any claim against trustworthy sources without requiring the user to dig through articles or biased charts. That idea became FactTrace, a real-time, bias-aware AI that cross-references statements from verified sources before rendering a verdict.
## What it does
**FactTrace** takes any short claim or quote and returns:
- A **verdict split** (*Factual* vs *Misleading* percentages) and a one‑paragraph rationale.
- A **source‑first pipeline** that searches current coverage, weights it by **bias** and **reliability**, and filters out fringe or low‑quality outlets.
- A **clean, shareable UI** with a doughnut chart and summary.
## How we built it
**Frontend**
- `public/index.html`, `styles.css`, `scripts.js` (no framework, fast to ship).
- **Chart.js** renders the Factual vs. Misleading split with an on‑canvas label for the dominant class.
- Responsive layout, IntersectionObserver scroll effects, and client‑side status handling.

**Backend (Node.js, zero‑dependency HTTP server):**
- A single `private/index.js` HTTP server that serves static files and exposes:
  - `GET /health`: liveness probe.
  - `POST /api/analyze`: main analysis endpoint.
- **Search** via **Exa.ai** using `category: "news"`, `useAutoprompt: true`, configurable `numResults`.
- **Source reliability** using a curated CSV merged into an in‑memory index:
  - Enforces `MAX_BIAS_SCORE` (**10**) and `MIN_RELIABILITY_SCORE` (**35**).
  - Matches both **publisher names** and **domains**.
- **Evidence extraction** fetches article bodies, sanitizes boilerplate, and truncates to a guardrail for consistent LLM context.
- **Claim normalization** converts questions into **clear factual statements** (e.g., “Is X true?” → “X is true/false, according to …”) before scoring.
- **LLM scoring** uses the **Groq gpt-oss** endpoint with a small JSON schema to return
