# WAYLO

A privacy-first, voice-first vision companion for low-vision users: point the camera, ask a question, and WAYLO describes your surroundings **aloud** — with all vision inference running **on your device**.

## Stack

- **UI:** React 18 + Vite 7 + Tailwind CSS v4 (Space Grotesk, black/amber high-contrast theme)
- **Vision:** TensorFlow.js `@tensorflow-models/coco-ssd` (on-device, no image leaves the browser)
- **Speech-to-text:** Speechmatics real-time streaming (token fetched via Supabase Edge Function, then socketed directly from the browser)
- **Text-to-speech:** Web Speech API (`speechSynthesis`)
- **Reasoning:** deterministic, testable on-device engine (`src/services/ai/ReasoningEngine.ts`) — never invents objects that aren't in the detected scene
- **Backend data:** Supabase (Postgres) — used for optional profile/state persistence

## Approach

```
SEE (camera frame) → vision engine (COCO-SSD) → scene graph
HEAR (voice → Speechmatics) or TYPE → intent → answer (on-device reasoning)
RESPOND (spoken aloud via speechSynthesis + on-screen card)
```

Everything runs client-side. Camera frames are analysed in memory only; nothing is uploaded.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (Vite) on the preview port |
| `npm test` | Vitest unit tests (scene assembly + reasoning engine) |
| `npm run build` | Production build |

## Demo mode

Toggle **Demo** in the header to see the live reasoning loop: detected objects, confidence, backend label, and real measured latencies (vision / reasoning / STT / TTS). Voice input needs a mic permission; if it's not available, typed questions work.

## Honest limits (by design)

- **Read text** is deferred to a later phase and honestly says so — no fake OCR.
- **SiMa hardware backend** is a stub that throws `unavailable` until hardware arrives (`VISION_BACKEND='local'` is the only working backend here).

## Docs

- PRD: [`docs/prd/WAYLO.md`](docs/prd/WAYLO.md)
- Design system: [`docs/design-system/MASTER.md`](docs/design-system/MASTER.md) (incl. build deviations)