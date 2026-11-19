// Server-rendered page shells. The pages render in the browser from /static/*.js.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function json(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function head(title: string, extra = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
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
  </ul>
  <h2>Who can see your videos</h2>
  <p>Each video has a share link that is hard to guess. Each person who has the link can watch the video. We do not sell your data and we do not show ads.</p>
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

export function homePage(): string {
  return card("Kino", `<p class="muted">Record your screen and camera. Share a link with a transcript and an AI summary.</p>
  <p><a class="btn primary" href="/login">Sign in or create an account</a></p>
  <p class="muted" style="font-size:12px"><a href="/privacy">Privacy policy</a> · <a href="/support">Support</a></p>`);
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
