# Earshot

**A phone call with an AI that actually listens.**

Most AI voice calls wait for you to finish a whole sentence, then talk over you, and go dead quiet when you stop. Earshot was built for one person's late-night calls and tuned against real ones until it felt like someone was on the line:

- **It listens while you talk.** A short pause is handed over at once; the model itself decides whether you were finished.
- **It waits while you think.** If the sentence was only half done, the model answers `[[wait]]` and Earshot keeps listening, then glues the pieces together.
- **It stops when you cut in.** Tap the wave (or, with headphones, just talk over it) and the voice stops mid-word. Start talking while it's still thinking and it drops that reply and keeps listening.
- **It doesn't go dead.** While a reply is slow you hear a small "hmm". When you go quiet it hums, coughs, mutters, then says a few words of its own, and only says goodbye after several minutes (more gently at night).
- **It talks like a person.** Replies are spoken sentence by sentence while still being written, with expressive voice tags (`[chuckles]`, `[sighs]`) on ElevenLabs v3.

It is a small Node server with no dependencies and a single web page. Bring your own model, voice and transcriber: anything OpenAI-compatible works.

中文使用教程：[docs/使用教程.md](docs/使用教程.md)

---

## Quick start

You need [Node.js 20+](https://nodejs.org) and API keys for three things:

| What | Default | Alternatives |
|---|---|---|
| Brain (chat model) | OpenAI `gpt-4o-mini` | Any OpenAI-compatible API: OpenRouter, DeepSeek, Groq, a local Ollama… |
| Voice (text-to-speech) | ElevenLabs `eleven_v3` | Any OpenAI-compatible `/audio/speech` |
| Ears (speech-to-text) | OpenAI `whisper-1` | Groq `whisper-large-v3-turbo`, a local faster-whisper server… |

```bash
git clone <this repo> earshot && cd earshot
cp .env.example .env              # then open .env and fill in your keys
cp persona.example.md persona.md  # who the AI is: edit freely
npm run check                     # three tiny real requests to confirm the keys work
npm start                         # → http://localhost:8787
```

Open the page, tap the green button, allow the microphone, and talk.

## Calling from your phone

Browsers only allow the microphone on `https://` pages (or `localhost`), so a phone needs an HTTPS address for your server. Two easy ways:

- **Cloudflare Tunnel** (no open ports, free): `cloudflared tunnel --url http://localhost:8787` prints a temporary `https://….trycloudflare.com` address. For a permanent one, set up a named tunnel on your own domain.
- **Caddy** on a server with a domain: `caddy reverse-proxy --from call.example.com --to localhost:8787` gets a certificate automatically.

Then **set `ACCESS_TOKEN` in `.env`**: anyone who finds the address could otherwise spend your API credit. On iPhone, open the page in Safari → Share → *Add to Home Screen* for an app-like icon.

To keep it running: `pm2 start server/index.js --name earshot` (or a systemd service).

## How a turn works

```
 you talk ─▶ pause 0.8 s ─▶ transcribe ─▶ model streams reply ─▶ voice, sentence by sentence ─▶ listen
                 │                │                  │
                 │                │                  └─ first sentence goes out alone, at once;
                 │                │                     the next two are generated while one plays
                 │                └─ you keep talking: this burst is held, the next one is joined to it
                 └─ model says [[wait]]: keep listening, now with a 2.2 s pause; nothing more after 4 s → answer
```

- **Turn-taking** (`web/app.js`, `web/lib/turn.mjs`): the recorded path ends a burst after 0.8 s of quiet and marks it *may continue*. The server appends a note asking the model to reply exactly `[[wait]]` if the thought is clearly unfinished. When unsure it answers, so you're never left hanging.
- **Ears while thinking**: after a burst is sent the microphone stays on. 250 ms of voice before the first word is spoken cancels the request and merges what you said.
- **Speaking** (`web/lib/speech.mjs`): the reply is cut at sentence ends as it streams. The first sentence is voiced alone, later ones are paired to cut requests. Up to two sentences are prepared ahead because expressive voices generate slower than they speak. The server limits concurrent voice requests (`TTS_CONCURRENCY`) and retries the "too many at once" error instead of failing.
- **Slow model**: with `LLM_BACKUP_MODEL` set, a second model is asked if the first hasn't said a word after `HEDGE_MS`. The first to speak wins, the other is cancelled (`server/hedge.js`).
- **Silence** (`web/lib/idle.mjs`): at 30 s a small sound; at 1, 2, 3… minutes the model gets a note that it's been quiet and says something on its own, its mood shifting the longer it lasts. After 7 minutes it says goodbye and hangs up 3 s later unless you make a sound. At night (23:00–06:00) everything is quieter and sparser. If you said "hold on" it waits much longer, and `[[stay]]` from the model means it never hangs up because of silence.
- **Hanging up**: the model ends a reply with `[[hangup]]` only when you seriously mean to go. Teasing "fine, hang up then" doesn't count.

The server keeps no history: the page sends the last 30 turns with each request, and everything is gone when you hang up.

## Settings (`.env`)

| Setting | What it does |
|---|---|
| `PORT` | Port to listen on (default 8787) |
| `ACCESS_TOKEN` | Password asked once by the page. Set it if the server is reachable from the internet. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | The chat model (OpenAI-compatible) |
| `LLM_BACKUP_MODEL`, `HEDGE_MS` | Optional second model asked when the first is slow |
| `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`, `STT_LANGUAGE` | Transcriber (OpenAI-compatible). Key falls back to `LLM_API_KEY`. |
| `TTS_PROVIDER` | `elevenlabs` or `openai` |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` | `eleven_v3` understands voice tags; `eleven_flash_v2_5` is faster but plainer |
| `TTS_CONCURRENCY` | Voice requests at once (most ElevenLabs plans: 2–3) |
| `OPENAI_TTS_*` | For `TTS_PROVIDER=openai` |
| `PERSONA_FILE` | Who the AI is (default `persona.md`) |
| `CALLER_NAME` | Name on the call screen |
| `REPLY_LANG` | `en` or `zh`: the language of the call-style instructions and small sounds |

In the page's *Settings*: the access token, the browser's own free dictation (Chrome/Edge/Android, sends audio to Google/Microsoft), and voice interruption (best with headphones; tapping the wave always works).

## Make it yours

- **Persona**: `persona.md` is plain text the model reads every turn. Give it a name, a history with you, private jokes.
- **Call style**: `server/prompt.js` holds the phone-call rules (short first sentence, no markdown, mood follows yours…).
- **Small sounds**: `server/fillers.js` (sounds while waiting) and `web/lib/idle.mjs` (sounds and timing when it's quiet).
- **Timing**: pause lengths are at the bottom of `web/lib/turn.mjs`.

## Costs

Roughly, per minute of conversation, with the defaults: the model is a fraction of a cent, Whisper is about $0.006 per minute of *your* speech, and ElevenLabs uses one character of credit per character spoken (a chatty minute is ~600–900 characters). The small "hmm" sounds are generated once and cached in `.cache/`.

## Troubleshooting

- **"Microphone is blocked"**: the page must be `https://` or `localhost`, and the browser must be allowed to use the mic.
- **No sound on iPhone**: make sure the ring/silent switch is off and the volume is up. Earshot plays through Web Audio, which follows the silent switch.
- **It answers while you're still talking**: your pauses are long. Raise `QUICK_PAUSE_MS` in `web/lib/turn.mjs`, or use a model that follows the `[[wait]]` instruction better.
- **It interrupts itself**: turn off voice interruption, or use headphones.
- **Long first-sound time**: check `npm run check` timings. Most of the wait is the model's first word plus the voice's first sentence. Try a faster model, `eleven_flash_v2_5`, or set `LLM_BACKUP_MODEL`.
- Add `localStorage.setItem('earshot:debug','1')` in the browser console to see the call's timeline in the console.

## Development

```bash
npm test                # unit + server tests, no network
node tools/e2e.cjs      # full call in headless Chromium with a fake microphone (needs playwright and ffmpeg)
```

## Privacy

Earshot itself stores nothing except the cached small sounds. Your speech goes to the transcriber you configure, the text to your model, the replies to your voice provider. Read their policies.

## License

MIT
