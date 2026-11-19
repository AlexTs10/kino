import type { Context } from "hono";
import { getCookie } from "hono/cookie";

export type Bindings = Env & {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  RESEND_API_KEY?: string;
  OWNER_EMAIL?: string;
};
export type User = { id: string; email: string; name: string };
export type AppEnv = { Bindings: Bindings; Variables: { user: User } };

export const SESSION_COOKIE = "kino_session";
export const SESSION_DAYS = 90;
export const LOGIN_MINUTES = 15;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

// ponytail: 20k PBKDF2 rounds to stay near the free-tier CPU limit; raise it on a paid plan.
const PBKDF2_ROUNDS = 20_000;

export async function hashPassword(password: string, salt = randomToken()): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PBKDF2_ROUNDS }, key, 256);
  return `${salt}:${b64url(new Uint8Array(bits))}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  return (await hashPassword(password, stored.split(":")[0])) === stored;
}

export function cookieOpts(c: Context<AppEnv>) {
  return {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  };
}

// The same session secret works as the browser cookie and as the extension's Bearer token.
// The extension reads the cookie with chrome.cookies, so no token is copied by hand.
export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = randomToken();
  await db
    .prepare("INSERT INTO sessions (hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, Date.now() + SESSION_DAYS * 86_400_000)
    .run();
  return token;
}

export async function deleteSession(db: D1Database, token: string | undefined) {
  if (token) await db.prepare("DELETE FROM sessions WHERE hash = ?").bind(await sha256(token)).run();
}

async function userFor(db: D1Database, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  return db
    .prepare("SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ?")
    .bind(await sha256(token), Date.now())
    .first<User>();
}

export function bearer(c: Context<AppEnv>): string | undefined {
  return c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
}

export const bearerUser = (c: Context<AppEnv>) => userFor(c.env.DB, bearer(c));
export const cookieUser = (c: Context<AppEnv>) => userFor(c.env.DB, getCookie(c, SESSION_COOKIE));
export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  return (await bearerUser(c)) ?? (await cookieUser(c));
}
