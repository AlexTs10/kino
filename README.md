# Kino

A small, self-hosted alternative to Loom. A Chrome extension records your screen and camera. A Cloudflare Worker stores the video and serves a share page with a transcript, an AI title, a summary and chapters, comments and reactions.

Made to run on the Cloudflare **free tier**.

## Use the hosted version (no setup)

You do not have to host Kino yourself. A free hosted version runs at **https://kino.alextoska.xyz**.

1. Download this repository (Code → Download ZIP) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the `extension` folder.
3. Sign in with your email. The extension already points to the hosted version.

The hosted version is free and runs on the Cloudflare free tier, so storage and AI minutes are shared by all users. There is no guarantee of uptime or that videos are kept forever. For important videos, host your own copy (see Setup).

## Features

**Recording (Chrome extension)**
- Click the Kino icon (or `Alt+Shift+K`): the Kino panel opens on the page, with a live round camera bubble. No popup.
- Choose Screen or Camera only. Turn the camera, the microphone and the tab/system audio on or off. The microphone has a level meter.
- Drag the camera bubble anywhere and change its size (S, M, L). It follows you to other tabs.
- 3-2-1 countdown, then a vertical toolbar on the page: Stop, timer, Pause, Restart, Delete. You can drag it.
- The recorder runs in a small window that minimizes itself after you choose what to share.
- Timer on the toolbar icon. Shortcuts: `Alt+Shift+K` open, `Alt+Shift+P` pause, `Alt+Shift+S` stop.
- Video parts upload while you record. When you stop, the video page opens next to your page and the link is copied.
- Recording another app (not a Chrome tab)? Turn on "Draw the camera into the video" in Settings.

**Share page**
- Custom player: chapters on the timeline, captions, speed 0.75× to 2.5×, keyboard shortcuts (space, j/k/l, arrows, f, m, c, 0–9), picture in picture, `?t=1m23s` links.
- Transcript with search, clickable timestamps and auto-scroll.
- AI title, summary and chapters.
- Emoji reactions on the timeline and comments with timestamps. No account needed to comment.
- Owner tools: rename, edit summary, trim (start and end), regenerate AI, delete, download, embed code.
- Open Graph tags for link previews in Slack and others.

**Library** (`/library`)
- All your videos with search in titles, summaries and transcripts, views, comments and storage use.

## How it works

```
Chrome extension                               Cloudflare Worker
  recorder window: desktopCapture + mic          /api/*  (Bearer session or session cookie)
  compose worker: camera bubble into video  ──►  R2 multipart upload (10 MiB parts)
  MediaRecorder, 1 s chunks                      R2: audio parts (Opus, 1 min each) 
  second recorder: audio only, 32 kbit/s   ──►   Workflow "kino-process":
                                                   Whisper (Workers AI) per audio part
                                                   LLM: title, summary, chapters
                                                 D1: videos, comments, reactions
                                                 /:id share page, /:id/video (HTTP Range)
```

The extension records a second, audio-only file at 32 kbit/s for the transcript (about 15 MB per hour). So the AI step never has to download or decode the video. The Workflow retries each step on its own.

## Free tier fit

| Resource | Free limit | Kino use |
|---|---|---|
| R2 storage | 10 GB | About 35 MB per minute at 1080p, so about 4.5 hours of video |
| R2 egress | Free | Video views cost nothing |
| Workers | 100k requests per day | Page views and video range requests. Static files are free. |
| D1 | 5 GB, 100k writes per day | One row per video, comment and reaction |
| Workers AI | 10,000 neurons per day | Whisper costs about 47 neurons per audio minute, so about 3 hours of transcripts per day |
| Workflows | Included | One run per video |

Cloudflare Stream is not used because it is not on the free plan.

### Better summaries with Claude (optional)

By default, Kino uses a Workers AI model for the title, summary and chapters (`AI_MODEL` in `wrangler.jsonc`). To use Claude, set a secret:

```sh
npx wrangler secret put ANTHROPIC_API_KEY
```

Kino then uses `claude-opus-5-5` (change it with a `CLAUDE_MODEL` variable). The transcript still comes from Whisper on Workers AI. If Claude declines a request, the API retries on a fallback model in the same call (server-side fallbacks).

## Setup

You need a Cloudflare account. A domain on Cloudflare is optional (the `workers.dev` URL also works).

```sh
cd worker
npm install
npx wrangler login
npx wrangler r2 bucket create kino-videos
npx wrangler d1 create kino          # copy the database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put RESEND_API_KEY   # sign-in emails (resend.com, verify your domain there)
npx wrangler secret put OWNER_EMAIL      # optional: this email gets the videos from before accounts
npm run deploy
```

Before you deploy, set your values in `worker/wrangler.jsonc`: `PUBLIC_URL` (your Worker URL or domain) and `FROM_EMAIL` (a sender on a domain verified in Resend). Also set `SERVER` in `extension/shared.js` to the same URL as `PUBLIC_URL` (by default it points to the hosted version).

For your own subdomain, uncomment `routes` in `worker/wrangler.jsonc`, set the name (for example `kino.example.com`), and deploy again.

### Extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.
3. The sign-in page opens. Enter your email and click the link in the email. The extension uses the same sign-in.
4. Open any web page and click the Kino icon (or `Alt+Shift+K`). The first time, click **Allow access** for the camera and microphone.
5. Click **Start recording**, then choose a tab, a window or your entire screen.

After an update of the extension files, click the reload icon on the Kino card in `chrome://extensions`.

## Local development

```sh
cd worker
npm run db:migrate:local
npm run dev                          # http://localhost:8787
```

Without `RESEND_API_KEY`, the sign-in link prints in the `wrangler dev` log. To use the extension with local dev, change `SERVER` in `extension/shared.js`. Workers AI always runs on Cloudflare, also in local dev, and uses your free neurons.

## Security model

- Sign-in is an email magic link (one use, 15 minutes, max 5 emails per address per hour). D1 keeps only SHA-256 hashes of links and sessions.
- Each user can see and change only their own videos (`user_id` check on every `/api/videos/:id` route).
- The extension reads the website's session cookie with `chrome.cookies` and sends it as a Bearer token. Sign out on the website signs out the extension too.
- Cookie sessions need an `x-kino` header for changes (CSRF guard).
- Share pages are public to anyone with the link. IDs are 12 random characters (about 71 bits). Pages send `noindex`.
- Anyone with the link can comment and react. Comments and reactions are accepted only from the share page itself (Origin check), and each video has a limit.
- To make share pages private too, put the domain behind Cloudflare Access (free for up to 50 users) and add a bypass rule for `/api/*`.

## License

MIT. See [LICENSE](LICENSE).

## Ideas for later

- Drawing and click highlights while recording
- Real trim (cut the file) and merge clips
- Password or expiry per link
- Viewer insights (who watched, how much)
- Firefox support
