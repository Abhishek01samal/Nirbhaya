# Nirbhaya

Personal safety command-system preview. The interface is monochrome (black, white, and grey). Guardian and settings changes stay in this browser via localStorage. The demo works without sign-in.

## Development

You need Node.js and npm.

```sh
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Optional: set `OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL` / `OPENAI_MODEL`) so the assistant can call an OpenAI-compatible API. Without a key, the assistant still replies with built-in demo guidance.
