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

## Before you start

- **It costs money to run.** Every call uses your own API keys and credit. There is no free tier built in.
- **It's an AI.** Don't present it as a real person to anyone who doesn't know, and don't use it to contact people who didn't ask for it.
- **Your words leave your machine.** Speech goes to the transcriber, text to the model, replies to the voice service you choose. Earshot stores nothing itself.
- **Set a password** (`ACCESS_TOKEN`) before putting it on the internet, or anyone with the link can talk on your credit. The setup wizard does this for you.
- Not for emergencies, medical, legal or crisis use. No warranty (MIT).

## Install

You need [Node.js 20+](https://nodejs.org). No `npm install`: there are no dependencies.

**One line (Linux server or Mac):**

```bash
curl -fsSL https://raw.githubusercontent.com/facc33176-rgb/earshot/main/install.sh | bash
```

It downloads Earshot to `~/earshot`, asks a few questions (which services, your keys, a name), writes the settings, checks the keys with three tiny real requests, and starts it with pm2 if you have it.

**Double-click (your own computer):** download the [ZIP](https://github.com/facc33176-rgb/earshot/archive/refs/heads/main.zip), unzip, then double-click `start.command` (Mac) or `start.bat` (Windows). The first time it runs the same setup wizard, then opens the call page.

**By hand:**

```bash
git clone https://github.com/facc33176-rgb/earshot.git
cd earshot
npm run setup     # or: cp .env.example .env and edit it
npm start         # → http://localhost:8787
```

The wizard offers three ready-made combinations:

| Choice | Brain | Ears | Voice | Keys |
|---|---|---|---|---|
| 1 | OpenAI `gpt-4o-mini` | OpenAI Whisper | OpenAI `gpt-4o-mini-tts` | 1 |
| 2 (works in mainland China) | DeepSeek | SiliconFlow SenseVoice | SiliconFlow CosyVoice | 2 |
| 3 (most expressive) | any OpenAI-compatible | OpenAI Whisper | ElevenLabs `eleven_v3` | 2–3 |

Anything OpenAI-compatible works for the brain, ears and voice (OpenRouter, Groq, a local Ollama or whisper server…): edit `.env`. Then open the page, tap the green button, allow the microphone, and talk.

## Calling from your phone

Browsers only allow the microphone on `https://` pages (or `localhost`), so a phone needs an HTTPS address for your server. Two easy ways:

- **Cloudflare Tunnel** (no open ports, free): `cloudflared tunnel --url http://localhost:8787` prints a temporary `https://….trycloudflare.com` address. For a permanent one, set up a named tunnel on your own domain.
- **Caddy** on a server with a domain: `caddy reverse-proxy --from call.example.com --to localhost:8787` gets a certificate automatically.

Then **set `ACCESS_TOKEN` in `.env`**: anyone who finds the address could otherwise spend your API credit. On iPhone, open the page in Safari → Share → *Add to Home Screen* for an app-like icon.

To keep it running: `npm i -g pm2 && pm2 start server/index.js --name earshot && pm2 save` (or a systemd service). Update later with `git pull && pm2 restart earshot`.

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
| `ACCESS_TOKEN` | Password asked once by the page (Settings). Set it if the server is reachable from the internet. |
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
npm run check           # tiny real requests with your .env
node tools/e2e.cjs      # full call in headless Chromium with a fake microphone (needs playwright and ffmpeg)
```

## Privacy

Earshot itself stores nothing except the cached small sounds. Your speech goes to the transcriber you configure, the text to your model, the replies to your voice provider. Read their policies.

## License

MIT
