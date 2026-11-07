// Setup wizard: asks a few questions, writes .env and persona.md, then checks the keys.
// Run: npm run setup   (safe to run again; it shows what's already filled in)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
// A line queue instead of rl.question, so answers piped in (install.sh, tests) are never lost.
const rl = readline.createInterface({ input: process.stdin });
const lines = [], waiting = []; let closed = false;
rl.on('line', l => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(''); });
const ask = (q, def = '') => {
  process.stdout.write(def ? `${q} [${def.length > 24 ? def.slice(0, 6) + '…' : def}]: ` : `${q}: `);
  return new Promise(ok => { const done = a => { if (!process.stdin.isTTY) process.stdout.write(a + '\n'); ok(String(a).trim() || def); }; if (lines.length) done(lines.shift()); else if (closed) done(''); else waiting.push(done); });
};

const old = {};
if (fs.existsSync(ENV)) for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line); if (m) old[m[1]] = m[2]; }

const PRESETS = {
  1: { label: 'OpenAI for everything (one key; needs an OpenAI account)',
    env: { LLM_BASE_URL: 'https://api.openai.com/v1', LLM_MODEL: 'gpt-4o-mini', STT_BASE_URL: 'https://api.openai.com/v1', STT_MODEL: 'whisper-1',
      TTS_PROVIDER: 'openai', OPENAI_TTS_BASE_URL: 'https://api.openai.com/v1', OPENAI_TTS_MODEL: 'gpt-4o-mini-tts', OPENAI_TTS_VOICE: 'alloy' },
    keys: [['LLM_API_KEY', 'OpenAI API key (platform.openai.com → API keys)']] },
  2: { label: '国内可用：DeepSeek 大模型 + 硅基流动 转文字和声音（两把钥匙，不用翻墙）',
    env: { LLM_BASE_URL: 'https://api.deepseek.com/v1', LLM_MODEL: 'deepseek-chat', STT_BASE_URL: 'https://api.siliconflow.cn/v1', STT_MODEL: 'FunAudioLLM/SenseVoiceSmall',
      TTS_PROVIDER: 'openai', OPENAI_TTS_BASE_URL: 'https://api.siliconflow.cn/v1', OPENAI_TTS_MODEL: 'FunAudioLLM/CosyVoice2-0.5B', OPENAI_TTS_VOICE: 'FunAudioLLM/CosyVoice2-0.5B:alex', REPLY_LANG: 'zh' },
    keys: [['LLM_API_KEY', 'DeepSeek 钥匙（platform.deepseek.com → API keys）'], ['STT_API_KEY', '硅基流动钥匙（cloud.siliconflow.cn → API 密钥）']], copy: { OPENAI_TTS_API_KEY: 'STT_API_KEY' } },
  3: { label: 'Best voice: any chat model + OpenAI Whisper + ElevenLabs (most expressive)',
    env: { LLM_BASE_URL: 'https://api.openai.com/v1', LLM_MODEL: 'gpt-4o-mini', STT_BASE_URL: 'https://api.openai.com/v1', STT_MODEL: 'whisper-1', TTS_PROVIDER: 'elevenlabs', ELEVENLABS_MODEL: 'eleven_v3' },
    keys: [['LLM_API_KEY', 'OpenAI API key (also used for Whisper)'], ['ELEVENLABS_API_KEY', 'ElevenLabs API key (elevenlabs.io → profile → API keys)'], ['ELEVENLABS_VOICE_ID', 'ElevenLabs Voice ID (Voices → pick a voice → copy ID)']] },
  4: { label: 'Custom: I will edit .env myself', env: {}, keys: [] },
};

(async () => {
  console.log('\n  Earshot setup · 安装向导\n  Press Enter to keep the value in [brackets]. 直接回车 = 用括号里的值。\n');
  for (const [k, p] of Object.entries(PRESETS)) console.log(`  ${k}. ${p.label}`);
  const choice = PRESETS[await ask('\nChoose / 选择', old.TTS_PROVIDER === 'elevenlabs' ? '3' : old.LLM_BASE_URL?.includes('deepseek') ? '2' : '1')] || PRESETS[4];
  const env = { ...old, ...choice.env };
  for (const [k, label] of choice.keys) env[k] = await ask(label, old[k] || '');
  for (const [to, from] of Object.entries(choice.copy || {})) env[to] = env[from];
  if (choice === PRESETS[3] && (await ask('Different chat API than OpenAI? Paste its base URL, or Enter to keep OpenAI', '')) ) {
    env.LLM_BASE_URL = (await ask('Chat base URL', env.LLM_BASE_URL)); env.LLM_MODEL = await ask('Chat model name', env.LLM_MODEL); env.LLM_API_KEY = await ask('Chat API key', env.LLM_API_KEY); env.STT_API_KEY = await ask('OpenAI key for Whisper', env.STT_API_KEY || old.LLM_API_KEY || '');
  }
  env.CALLER_NAME = await ask('Name of your AI / 它叫什么', old.CALLER_NAME || 'Earshot');
  env.REPLY_LANG = (await ask('Language it speaks / 说什么语言 (en / zh)', env.REPLY_LANG || 'en')) === 'zh' ? 'zh' : 'en';
  const net = await ask('Will you open this from your phone or the internet? 要不要用手机/外网打 (y/n)', old.ACCESS_TOKEN ? 'y' : 'n');
  env.ACCESS_TOKEN = /^y/i.test(net) ? (old.ACCESS_TOKEN || crypto.randomBytes(9).toString('base64url')) : '';
  env.PORT = env.PORT || '8787';

  // Write .env from the template so every setting keeps its explanation.
  let text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const [k, v] of Object.entries(env)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : text + `\n${k}=${v}`;
  }
  fs.writeFileSync(ENV, text);
  const persona = path.join(ROOT, 'persona.md');
  if (!fs.existsSync(persona)) {
    const tpl = fs.readFileSync(path.join(ROOT, env.REPLY_LANG === 'zh' ? 'persona.example.zh.md' : 'persona.example.md'), 'utf8');
    fs.writeFileSync(persona, tpl.replace(/\bSol\b|小澈/g, env.CALLER_NAME));
  }
  console.log(`\n  ✓ Saved .env${fs.existsSync(persona) ? ' and persona.md' : ''}.`);
  if (env.ACCESS_TOKEN) console.log(`  ✓ Access token / 口令: ${env.ACCESS_TOKEN}   (the page asks for it once / 网页第一次会问)`);
  console.log('  Edit persona.md any time to change who it is. 想改人设就改 persona.md。\n');
  rl.close();
  if (choice.keys.length && !process.env.NO_CHECK) { try { execFileSync(process.execPath, [path.join(__dirname, 'check.cjs')], { stdio: 'inherit' }); } catch (_) { /* check printed the reason */ } }
})();
