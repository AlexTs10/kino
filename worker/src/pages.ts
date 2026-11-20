// Server-rendered page shells. The pages render in the browser from /static/*.js.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function json(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function head(title: string, extra = "", index = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${index ? "" : `<meta name="robots" content="noindex, nofollow">`}
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
${extra}
</head>`;
}

export type ShareBoot = {
  video: Record<string, unknown> & { id: string; title: string; summary: string | null; has_thumb: number };
  comments: unknown[];
  reactions: unknown[];
  owner: boolean;
  ownerName: string;
  copied?: boolean;
};

export function sharePage(boot: ShareBoot, origin: string, embed = false): string {
  const v = boot.video;
  const url = `${origin}/${v.id}`;
  const desc = v.summary || `A video from ${boot.ownerName || "Kino"}`;
  const og = `
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="video.other">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
${v.has_thumb ? `<meta property="og:image" content="${esc(url)}/thumb.jpg"><meta name="twitter:image" content="${esc(url)}/thumb.jpg">` : ""}
<meta property="og:video" content="${esc(url)}/video">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(v.title)}">
<link rel="alternate" type="text/vtt" href="${esc(url)}/captions.vtt">`;
  return `${head(v.title, og)}
<body class="${embed ? "embed" : "share"}">
<div id="app"></div>
<noscript><p style="padding:24px">Turn on JavaScript to watch this video, or <a href="/${esc(v.id)}/video">open the video file</a>.</p></noscript>
<script id="boot" type="application/json">${json({ ...boot, url })}</script>
<script type="module" src="/static/share.js"></script>
</body>
</html>`;
}

export function libraryPage(ownerName: string, email: string): string {
  return `${head("My videos · Kino")}
<body class="library">
<div id="app"></div>
<script id="boot" type="application/json">${json({ ownerName, email })}</script>
<script type="module" src="/static/library.js"></script>
</body>
</html>`;
}

function card(title: string, body: string): string {
  return `${head(title)}
<body class="center-page">
<main class="login">
  <div class="brand big"><span class="logo"></span>Kino</div>
  ${body}
</main>
</body>
</html>`;
}

export function loginPage(error = ""): string {
  return card(
    "Sign in · Kino",
    `<p class="muted">Enter your email. We send you a link to sign in. A new email makes a new account.</p>
  <form method="post" action="/auth/email">
    <input name="email" type="email" placeholder="you@example.com" autocomplete="email" required autofocus>
    <input name="next" type="hidden" id="next">
    <button class="btn primary" type="submit">Email me a sign-in link</button>
  </form>
  <p class="err">${esc(error)}</p>
  <p class="muted" style="font-size:12px"><a href="/privacy">Privacy policy</a></p>
<script type="module" src="/static/login.js"></script>`,
  );
}

export function checkEmailPage(email: string): string {
  return card("Check your email · Kino", `<h1>Check your email</h1>
  <p class="muted">We sent a sign-in link to <strong>${esc(email)}</strong>. Open it in this browser.</p>`);
}

export function verifyPage(token: string, next: string): string {
  return card(
    "Sign in · Kino",
    `<form method="post" action="/auth/verify">
    <input type="hidden" name="t" value="${esc(token)}">
    <input type="hidden" name="next" value="${esc(next)}">
    <button class="btn primary" type="submit">Sign in to Kino</button>
  </form>`,
  );
}

export function privacyPage(): string {
  return card(
    "Privacy · Kino",
    `<div style="text-align:left;max-width:640px">
  <h1>Privacy policy</h1>
  <p>Kino records your screen, camera and microphone only when you start a recording. The recording goes to our server on Cloudflare.</p>
  <h2>What we keep</h2>
  <ul>
    <li>Your email address and name, to sign you in and show your name on your videos.</li>
    <li>Your videos, thumbnails and audio. We make a transcript, a title, a summary and chapters with AI (Cloudflare Workers AI, and Anthropic Claude if it is turned on).</li>
    <li>Comments, reactions and view counts on your videos.</li>
    <li>When you watch a video: a random viewer id in your browser, how many seconds you watched, your name if you gave one for comments, your IP address and approximate place (city and network). The owner of the video sees these. If you are signed in to Kino, the owner of the video sees your name or email.</li>
  </ul>
  <h2>Who can see your videos</h2>
  <p>Each video has a share link that is hard to guess. Each person who has the link can watch the video, unless the owner set a password or an end date. We do not sell your data and we do not show ads.</p>
  <h2>Email</h2>
  <p>We send sign-in emails with Resend.</p>
  <h2>Delete your data</h2>
  <p>You can delete one video, or your full account with all videos, from your library. The data is then deleted from our server.</p>
</div>`,
  );
}

export function supportPage(note = ""): string {
  return card(
    "Support · Kino",
    `<div style="text-align:left;max-width:640px">
  <h1>Support</h1>
  <h2>Common questions</h2>
  <p><strong>How do I sign in?</strong> Click the Kino icon, then Sign in. Enter your email and open the link that we send you. The extension uses the same sign-in.</p>
  <p><strong>The camera or microphone does not work.</strong> Click the Kino icon, then Allow access. Also check the camera and microphone settings of Chrome and of your computer.</p>
  <p><strong>The transcript or title is missing.</strong> Open the video and use the AI menu to run it again. Very short or silent videos have no transcript.</p>
  <p><strong>How do I delete my data?</strong> Open your library, click your name, then Delete account. See also the <a href="/privacy">privacy policy</a>.</p>
  <h2>Contact us</h2>
  ${note ? `<p class="muted"><strong>${esc(note)}</strong></p>` : ""}
  <form method="post" action="/support">
    <input name="email" type="email" placeholder="Your email" autocomplete="email" required>
    <textarea name="message" rows="6" maxlength="5000" placeholder="Your message" required style="width:100%;margin:8px 0"></textarea>
    <button class="btn primary" type="submit">Send</button>
  </form>
</div>`,
  );
}

const GITHUB_URL = "https://github.com/AlexTs10/kino";
const STORE_URL = "https://chromewebstore.google.com/detail/kino-recorder/hiofelaknamloippdoijjoiiefleflab";

const ic = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const FEATURES: [icon: string, title: string, text: string][] = [
  [`<rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 10 6-3v10l-6-3"/>`, "Screen and camera", "Record a tab, a window or your full screen. A round camera bubble follows you, and you can draw on the page while you talk."],
  [`<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>`, "A link when you stop", "The video uploads while you record. Click Stop and the share link is on your clipboard."],
  [`<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>`, "AI title, summary, chapters", "Each video gets a transcript that you can search, a title, a summary and chapters on the timeline."],
  [`<path d="M21 12a8 8 0 0 1-12 7l-5 1 1-5a8 8 0 1 1 16-3z"/>`, "Comments and reactions", "Viewers add comments with a timestamp and emoji on the timeline. They do not need an account."],
  [`<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`, "Password, expiry, insights", "Set a password or an end date for each link. See who watched and how much of the video."],
  [`<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>`, "Trim, cut and merge", "Trim the start and the end, cut the file, or merge videos into one. All in your browser."],
];

export function homePage(): string {
  const desc = "Kino is a free, open-source screen recorder for Chrome. Share a link with a transcript, an AI summary, chapters and comments.";
  const meta = `<meta name="description" content="${desc}">
<meta property="og:title" content="Kino · Open-source screen recorder">
<meta property="og:description" content="${desc}">`;
  return `${head("Kino · Open-source screen recorder", meta, true)}
<body class="landing">
<header class="topbar">
  <a class="brand" href="/"><span class="logo"></span>Kino</a>
  <span class="spacer"></span>
  <a class="gh" href="${GITHUB_URL}">GitHub</a>
  <a class="btn" href="/login">Sign in</a>
</header>
<main>
<section class="hero">
  <a class="chip accent" href="${GITHUB_URL}">Open source · MIT license</a>
  <h1>Record your screen.<br><em>Share a link.</em></h1>
  <p class="lede">Kino is a free, open-source alternative to Loom. Record your screen and camera in Chrome. Your viewers get a transcript, an AI summary, chapters and comments.</p>
  <div class="cta">
    <a class="btn primary big" href="${STORE_URL}">Add to Chrome, free</a>
    <a class="btn big" href="${GITHUB_URL}">★ Star on GitHub</a>
  </div>
  <p class="muted fine">No credit card. Sign in with your email, or <a href="#selfhost">host it yourself</a>.</p>
  <div class="mock" aria-hidden="true">
    <div class="mock-bar"><i></i><i></i><i></i><span>Onboarding walkthrough · Kino</span></div>
    <div class="mock-body">
      <div class="mock-player">
        <div class="mock-screen"><b></b><b></b><b></b><b></b></div>
        <span class="mock-cam"></span>
        <span class="mock-play">${ic(`<path d="M8 5v14l11-7z" fill="currentColor"/>`)}</span>
        <div class="mock-rail"><b class="on"></b><b class="on"></b><b></b><b></b><b></b></div>
      </div>
      <div class="mock-side">
        <div class="mock-h">${ic(FEATURES[2]![0])}AI summary</div>
        <p>A walk through the new onboarding flow: what changed, why it changed, and what to test before the release.</p>
        <div class="mock-h">Transcript</div>
        <div class="mock-line"><span>0:04</span>So this is the new onboarding flow.</div>
        <div class="mock-line on"><span>0:19</span>The first screen now asks for one thing only.</div>
        <div class="mock-line"><span>0:41</span>Then we go directly to the dashboard.</div>
        <div class="mock-line"><span>1:02</span>Please test the invite step on mobile.</div>
      </div>
    </div>
  </div>
</section>
<section class="feats">
  ${FEATURES.map(([d, t, s]) => `<div class="card feat"><span class="feat-ic">${ic(d)}</span><h3>${t}</h3><p>${s}</p></div>`).join("\n  ")}
</section>
<section class="selfhost" id="selfhost">
  <div>
    <h2>Your videos, your server</h2>
    <p class="muted">Kino is MIT licensed. Deploy your own copy to Cloudflare: one Worker, R2 for the videos, D1 for the data and Workers AI for the transcript. It is made to fit in the free tier.</p>
    <div class="stats">
      <div><strong>$0</strong><span>per month on the free tier</span></div>
      <div><strong>4.5 h</strong><span>of 1080p video in 10 GB</span></div>
      <div><strong>0</strong><span>cost for video views</span></div>
    </div>
    <p><a class="btn" href="${GITHUB_URL}#setup">Read the setup guide</a></p>
  </div>
  <pre><code><span># full steps are in the README</span>
git clone ${GITHUB_URL}
cd kino/worker
npm install
npm run deploy</code></pre>
</section>
</main>
<footer class="foot muted">
  <a href="${GITHUB_URL}">GitHub</a> · <a href="${STORE_URL}">Chrome Web Store</a> · <a href="/privacy">Privacy policy</a> · <a href="/support">Support</a>
</footer>
</body>
</html>`;
}

export function passwordPage(id: string, embed: boolean, error = ""): string {
  return card(
    "Password · Kino",
    `<h1>This video has a password</h1>
  <p class="muted">Enter the password that you got from the owner.</p>
  <form method="post" action="/${esc(id)}/unlock">
    <input name="password" type="password" placeholder="Password" autocomplete="current-password" required autofocus>
    <input name="embed" type="hidden" value="${embed ? "1" : ""}">
    <button class="btn primary" type="submit">Watch the video</button>
  </form>
  <p class="err">${esc(error)}</p>`,
  );
}

export function expiredPage(): string {
  return card("Link expired · Kino", `<h1>This link has expired</h1>
  <p class="muted">The owner set an end date for this video. Ask the owner for a new link.</p>`);
}

export function notFoundPage(): string {
  return `${head("Not found · Kino")}
<body class="center-page">
<main class="login">
  <div class="brand big"><span class="logo"></span>Kino</div>
  <h1>Video not found</h1>
  <p class="muted">The link is wrong, or the owner deleted this video.</p>
</main>
</body>
</html>`;
}
