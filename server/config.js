// Reads .env (no dependency needed) and exposes settings with defaults.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function config(env = process.env) {
  const s = (k, d = '') => (env[k] ?? '').trim() || d;
  const trimBase = u => String(u || '').replace(/\/+$/, '');
  return {
    root: ROOT,
    port: Number(s('PORT', '8787')),
    accessToken: s('ACCESS_TOKEN'),
    llm: { base: trimBase(s('LLM_BASE_URL', 'https://api.openai.com/v1')), key: s('LLM_API_KEY'), model: s('LLM_MODEL', 'gpt-4o-mini'),
      backup: s('LLM_BACKUP_MODEL'), hedgeMs: Number(s('HEDGE_MS', '6000')) },
    stt: { base: trimBase(s('STT_BASE_URL', 'https://api.openai.com/v1')), key: s('STT_API_KEY') || s('LLM_API_KEY'), model: s('STT_MODEL', 'whisper-1'), language: s('STT_LANGUAGE') },
    tts: {
      provider: s('TTS_PROVIDER', 'elevenlabs'),
      concurrency: Math.max(1, Number(s('TTS_CONCURRENCY', '2'))),
      eleven: { key: s('ELEVENLABS_API_KEY'), voice: s('ELEVENLABS_VOICE_ID'), model: s('ELEVENLABS_MODEL', 'eleven_v3'), base: trimBase(s('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io')) },
      openai: { base: trimBase(s('OPENAI_TTS_BASE_URL', 'https://api.openai.com/v1')), key: s('OPENAI_TTS_API_KEY') || s('LLM_API_KEY'), model: s('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'), voice: s('OPENAI_TTS_VOICE', 'alloy') },
    },
    personaFile: path.resolve(ROOT, s('PERSONA_FILE', 'persona.md')),
    callerName: s('CALLER_NAME', 'Earshot'),
    replyLang: s('REPLY_LANG', 'en') === 'zh' ? 'zh' : 'en',
  };
}

module.exports = { loadEnv, config, ROOT };
