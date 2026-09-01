# Real-audio web-call tests for the phone agent

Drives a REAL Retell web call from Chrome with a WAV file as the microphone, so the whole chain runs —
Retell speech recognition (multilingual agent), our websocket, the model, TTS — without a human speaking.
Clean speech comes from OpenAI TTS; dirty speech is real human recordings degraded to phone quality.

Needs: the sidecar public (cloudflared quick tunnel or the SSH tunnel), `voice:setup` run against that
public base, `AIADVISOR_VOICE_DEMO=1` + a demo key, Chrome installed, and in a scratch directory:
`npm i playwright-core ffmpeg-static` and `py -m pip install yt-dlp` (yt-dlp only for sourcing clips).
Run the scripts with that scratch directory's `node_modules` on `NODE_PATH`, or copy them there.

| Script | Does |
|---|---|
| `make-wav.mjs '[2,"Xin chào…",40,"Cảm ơn…",40]' out.wav` | Clean TTS questions with silences (48 kHz mono PCM16). |
| `segments.mjs clip.m4a vi` | whisper-1 segment transcript of a clip, to pick a coherent stretch. |
| `dirty.mjs out.wav '[14,{"src":"clip.m4a","from":74,"len":22},32,…]' dirty` | Real speech → 300–3400 Hz, 8 kHz round trip, pink noise, compression; `clean` mode just lays clips out. |
| `webcall.mjs <abs path>.wav [seconds] [outname]` | Chrome + fake mic on the demo page; prints the live transcript; screenshot. `VOICE_DEMO_URL` overrides the page. |

Lead the WAV with ~14 s of silence so the first utterance lands after the English opening. Use ABSOLUTE
WAV paths (Chrome's cwd is not yours). Read the sidecar log for the per-turn lines
(`[voice] call N turn #k … first=…ms spoke=…ch [superseded]`) and the `language_detected` / `ended` events.

Results 2026-08-27 (SDK backend, 11labs-Noah, languages en-AU,vi-VN,it-IT,el-GR,hi-IN,zh-CN,tr-TR,ar-SA):

| Audio | Recognised | Detected | Reply |
|---|---|---|---|
| TTS Vietnamese question | exact | vi | Vietnamese filler + answer |
| Real Vietnamese farmer, phone-degraded | close to the whisper reference | vi | Vietnamese disclosure line, then in-lane answer (durian agronomy declined, water offered) |
| Real Italian farmer, phone-degraded | near-exact | it | Italian, offers price/allocation/account help |
| Real Punjabi interview, phone-degraded | Gurmukhi transcript | not claimed (Devanagari fragment → hi once) | English: cannot follow Punjabi, offers a broker |
| 75 s silence | — | — | second reminder → goodbye + end_call (`ended: dead_line`) |

Retell splits a long utterance at pauses: expect `superseded` turns; the disclosure line is handed back
until a turn survives to voice it.
