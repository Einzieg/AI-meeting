# AI Meeting

Multi-AI multi-model discussion system. Multiple AI agents discuss topics, vote on conclusions, and produce structured meeting minutes.

## Quickstart

**Requirements:** Node.js >= 18

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env.local

# Start dev server
npm run dev
```

Visit http://localhost:3000

## Scripts

- `npm run dev` - Start development server
- `npm run build` - Production build
- `npm start` - Start production server
- `npm run lint` - Run ESLint
- `npm test` - Run tests

## Providers & Models

- Configure providers via `.env.local` (see `.env.example`).
- In the **New Meeting** page you can select a provider per agent, or use **`Auto (By Model)`** to route based on the model id:
  - `gpt-*` / `o1*` / `o3*` → OpenAI provider
  - `claude-*` → Anthropic provider
  - `gemini-*` → Gemini provider
  - For custom providers, routing uses the model list you saved for that provider.
- Custom providers created in **Settings** are persisted locally to `data/ai-meeting.db` (gitignored). API keys are stored in plaintext on disk.
