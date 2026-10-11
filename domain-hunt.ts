#!/usr/bin/env bun
/**
 * domain-hunt: is anyone searching for this, and is the .com free?
 *
 *   domain-hunt "wow guilds" "diablo 4 builds"
 *   domain-hunt -f keywords.txt        one keyword per line, # comments
 *   some-cmd | domain-hunt             keywords on stdin
 *   domain-hunt --seed "wow forever"   Keyword Planner ideas for a theme, only those whose .com is free
 *   domain-hunt --site example.fr      the same from what a site's pages talk about, in its country
 *   domain-hunt ... --json             machine output
 *   domain-hunt auth                   one-time Google sign-in for the Ads API
 *
 * Per keyword, from free sources only:
 *   .com          Verisign RDAP: FREE, taken until <expiry>, or dropping.
 *   trend         Google Trends, worldwide: the last 4 weeks against the 12-month average.
 *   vol/mo, cpc   Google Ads API (Keyword Planner): average monthly searches and the
 *                 top-of-page bid range. Needs your own Google Ads keys (README, Google Ads
 *                 setup); without them those two columns are off and the output says so.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Google Ads keys: GOOGLE_ADS_* in the environment, or this env file. DOMAIN_HUNT_ENV names another one.
const KEY_FILE = process.env.DOMAIN_HUNT_ENV || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "domain-hunt", "google-ads.env");
const KEY_FILE_SHOWN = KEY_FILE.replace(homedir(), "~");
const ADS_API = "https://googleads.googleapis.com/v25";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Where the sign-in comes back. A "Desktop app" OAuth client accepts it as is; a "Web application"
// client must list it under its authorized redirect URIs.
const REDIRECT = "http://127.0.0.1:53682";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const TTY = process.stdout.isTTY;
// DH_DEBUG=1 prints each phase with the time, to find what a slow run waits on.
const debug = (m: string) => process.env.DH_DEBUG && console.error(new Date().toISOString().slice(11, 19), m);

type Com = { status: "free" | "taken" | "dropping" | "unknown"; registered?: string; expires?: string; registrar?: string; note?: string };
type Ads = { volume: number | null; low: number | null; high: number | null; average: number | null; competition: string | null };
type Row = {
  keyword: string;
  domain: string;
  com: Com;
  volume: number | null;
  cpc: { low: number | null; high: number | null; average: number | null } | null;
  competition: string | null;
  trend: number | null;
  weekly: number[];
  typed: boolean; // Google Autocomplete suggests it: people type it now
  from?: string; // the site whose pages gave this keyword (--site)
};

function usage(code = 0): never {
  console.log(`usage: domain-hunt <keyword>... [-f file] [--json]
       domain-hunt --seed <theme>... [--json]
       domain-hunt auth

  domain-hunt "wow guilds" "diablo 4 builds"
  domain-hunt -f keywords.txt
  domain-hunt --seed "wow forever"       ideas whose .com is free, by search volume
  domain-hunt --site example.fr          the same from what a site's pages talk about, in its country
  domain-hunt --site "example.fr=pain au levain,boulangerie artisanale"   site + its topic keywords
  domain-hunt example.dev "pain au levain=painaulevain.fr"   any TLD; name=domain sets the keyword

.com and trend need nothing. Volume and CPC need Google Ads keys in
${KEY_FILE_SHOWN} and one run of domain-hunt auth.`);
  process.exit(code);
}

// ---------- keys ----------

function keyFile(): string | undefined {
  return existsSync(KEY_FILE) ? KEY_FILE : undefined;
}

function readEnv(file?: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!file) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*["']?(.*?)["']?\s*$/);
    if (m && m[2]) env[m[1]] = m[2];
  }
  return env;
}

function setEnvVar(file: string, name: string, value: string) {
  const text = readFileSync(file, "utf8");
  const re = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(file, re.test(text) ? text.replace(re, `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`);
}

function adsConfig() {
  const file = keyFile();
  const env = { ...readEnv(file), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("GOOGLE_ADS_"))) } as Record<string, string>;
  return {
    file,
    clientId: env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    customerId: env.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, ""),
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, ""),
  };
}
type AdsConfig = ReturnType<typeof adsConfig>;

// ---------- .com ----------

// Where to ask about a TLD: Verisign for .com, else the IANA RDAP bootstrap (.fr, .app, .dev, .io...).
let bootstrap: Promise<Map<string, string>> | undefined;
async function rdapBase(tld: string): Promise<string | undefined> {
  if (tld === "com") return "https://rdap.verisign.com/com/v1/";
  bootstrap ??= fetch("https://data.iana.org/rdap/dns.json", { signal: AbortSignal.timeout(15000) })
    .then((r) => r.json())
    .then((j: any) => new Map<string, string>(j.services.flatMap(([tlds, urls]: [string[], string[]]) => tlds.map((t) => [t, urls.find((u) => u.startsWith("https")) ?? urls[0]]))));
  return (await bootstrap.catch(() => new Map<string, string>())).get(tld)?.replace(/\/?$/, "/");
}

async function rdap(domain: string, retry = true): Promise<Com> {
  const base = await rdapBase(domain.split(".").pop()!);
  // No RDAP for this TLD (.io): a delegated name is taken; no dates then.
  if (!base) {
    const ns = await import("node:dns/promises").then((d) => d.resolveNs(domain)).catch(() => []);
    return ns.length ? { status: "taken", note: "no RDAP" } : { status: "unknown", note: `no RDAP for .${domain.split(".").pop()}` };
  }
  let r: Response;
  try {
    r = await fetch(`${base}domain/${domain}`, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { status: "unknown", note: `RDAP ${(e as Error).message}` };
  }
  if (r.status === 404) return { status: "free" };
  if (r.status === 429 && retry) {
    await Bun.sleep(2000);
    return rdap(domain, false);
  }
  if (!r.ok) return { status: "unknown", note: `RDAP ${r.status}` };
  const j: any = await r.json();
  const date = (action: string) => j.events?.find((e: any) => e.eventAction === action)?.eventDate?.slice(0, 10);
  const [registered, expires] = [date("registration"), date("expiration")];
  const registrar = j.entities
    ?.find((e: any) => e.roles?.includes("registrar"))
    ?.vcardArray?.[1]?.find((v: any) => v[0] === "fn")?.[3];
  const dropping = (j.status ?? []).find((s: string) => /pending delete|redemption period/.test(s));
  return { status: dropping ? "dropping" : "taken", registered, expires, registrar, note: dropping };
}

async function availability(domains: string[]): Promise<Com[]> {
  const out: Com[] = [];
  for (let i = 0; i < domains.length; i += 10) out.push(...(await Promise.all(domains.slice(i, i + 10).map((d) => rdap(d)))));
  return out;
}

// ---------- trend (Google Trends, no key) ----------

// Trends throttles hard once it has seen enough requests: one short retry, then the run gives up
// on it (the breaker below), rather than waiting minutes on every keyword.
let trendsBlocked = false;
async function trendsGet(path: string, cookie: string): Promise<any> {
  for (let attempt = 1; attempt <= 2 && !trendsBlocked; attempt++) {
    const r = await fetch(`https://trends.google.com/trends/api/${path}`, { headers: { "user-agent": UA, cookie }, signal: AbortSignal.timeout(10000) });
    if (r.status === 429) {
      if (attempt === 2) trendsBlocked = true;
      else await Bun.sleep(3000);
      continue;
    }
    if (!r.ok) throw new Error(`Google Trends ${r.status}`);
    return JSON.parse((await r.text()).replace(/^\)\]\}',?\s*/, ""));
  }
  throw new Error("Google Trends 429");
}

// Weekly interest over 12 months; trend = last 4 full weeks against the 12-month average.
async function trends(keywords: string[]): Promise<({ trend: number | null; weekly: number[] } | Error)[]> {
  let cookie = "";
  try {
    const home = await fetch("https://trends.google.com/trends/?geo=US", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
    cookie = home.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  } catch {}
  const out: ({ trend: number | null; weekly: number[] } | Error)[] = [];
  for (const keyword of keywords) {
    try {
      const req = { comparisonItem: [{ keyword, geo: "", time: "today 12-m" }], category: 0, property: "" };
      const ex = await trendsGet(`explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(req))}`, cookie);
      const w = ex.widgets.find((w: any) => w.id === "TIMESERIES");
      const ml = await trendsGet(
        `widgetdata/multiline?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${w.token}`,
        cookie,
      );
      const weekly: number[] = ml.default.timelineData.filter((p: any) => !p.isPartial).map((p: any) => p.value[0]);
      const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      const base = weekly.length >= 8 ? avg(weekly) : 0;
      out.push({ trend: base ? Math.round((avg(weekly.slice(-4)) / base - 1) * 100) : null, weekly });
    } catch (e) {
      out.push(e as Error);
    }
    await Bun.sleep(500);
  }
  return out;
}

// ---------- volume and CPC (Google Ads API) ----------

async function accessToken(cfg: AdsConfig): Promise<string> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId!,
      client_secret: cfg.clientSecret!,
      refresh_token: cfg.refreshToken!,
      grant_type: "refresh_token",
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Google sign-in failed (${j.error_description ?? j.error ?? r.status}), run domain-hunt auth`);
  return j.access_token;
}

function adsError(j: any, status: number): string {
  const e = j?.error?.details?.[0]?.errors?.[0];
  const code = e?.errorCode ? Object.values(e.errorCode)[0] : undefined;
  return [e?.message ?? j?.error?.message ?? `HTTP ${status}`, code && `(${code})`].filter(Boolean).join(" ");
}

// Google Ads accepts at most 80 characters and 10 words per keyword.
const askable = (k: string) => k.length <= 80 && k.split(" ").length <= 10;
const micros = (m: unknown) => (m == null ? null : Number(m) / 1e6);

// The Google Ads account this sign-in reaches; saved to the key file when there is exactly one.
async function customerId(cfg: AdsConfig, token: string): Promise<string> {
  const r = await fetch(`${ADS_API}/customers:listAccessibleCustomers`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(adsError(j, r.status));
  const ids: string[] = (j.resourceNames ?? []).map((n: string) => n.split("/")[1]);
  if (ids.length !== 1)
    throw new Error(ids.length ? `several Google Ads accounts, set GOOGLE_ADS_CUSTOMER_ID to one of: ${ids.join(", ")}` : "no Google Ads account on this Google account, create one at ads.google.com");
  if (cfg.file) setEnvVar(cfg.file, "GOOGLE_ADS_CUSTOMER_ID", ids[0]);
  return ids[0];
}

// POST to a customer method of the signed-in Google Ads account.
async function adsCall(cfg: AdsConfig, method: string, body: object): Promise<any> {
  const token = await accessToken(cfg);
  cfg.customerId ||= await customerId(cfg, token);
  const r = await fetch(`${ADS_API}/customers/${cfg.customerId}:${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(cfg.loginCustomerId ? { "login-customer-id": cfg.loginCustomerId } : {}),
    },
    body: JSON.stringify({ keywordPlanNetwork: "GOOGLE_SEARCH", historicalMetricsOptions: { includeAverageCpc: true }, ...body }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(adsError(j, r.status));
  return j;
}

const toAds = (m: any = {}): Ads => ({
  volume: m.avgMonthlySearches == null ? null : Number(m.avgMonthlySearches),
  low: micros(m.lowTopOfPageBidMicros),
  high: micros(m.highTopOfPageBidMicros),
  average: micros(m.averageCpcMicros),
  competition: m.competition ?? null,
});

// Google merges close variants into one result and gives the numbers of whichever came first:
// ["wowguilds", "wow guilds"] returns wowguilds (480) with "wow guilds" as a variant, while
// "wow guilds" alone is 8,100. A requested keyword that only comes back as a variant is asked
// again in a later pass, until it has its own numbers.
async function adsMetrics(keywords: string[], cfg: AdsConfig, geo?: number): Promise<Map<string, Ads>> {
  const out = new Map<string, Ads>();
  const asked = new Set(keywords.filter(askable));
  const variantOf = new Map<string, Ads>();
  let todo = [...asked];
  for (let pass = 0; todo.length && pass < 4; pass++) {
    const again: string[] = [];
    for (let i = 0; i < todo.length; i += 1000) {
      const j = await adsCall(cfg, "generateKeywordHistoricalMetrics", { keywords: todo.slice(i, i + 1000), ...(geo ? { geoTargetConstants: [`geoTargetConstants/${geo}`] } : {}) });
      for (const res of j.results ?? []) {
        const row = toAds(res.keywordMetrics);
        out.set(String(res.text).toLowerCase(), row);
        for (const v of res.closeVariants ?? []) {
          const k = String(v).toLowerCase();
          if (asked.has(k) && !out.has(k)) (again.push(k), variantOf.set(k, row));
        }
      }
    }
    todo = [...new Set(again)].filter((k) => !out.has(k));
  }
  for (const [k, row] of variantOf) if (!out.has(k)) out.set(k, row);
  return out;
}

// Keyword Planner ideas around a theme, with their volume and CPC.
// With a site, the ideas come from what its pages talk about, in the site's country.
async function adsIdeas(seeds: string[], cfg: AdsConfig, site?: string): Promise<Map<string, Ads>> {
  const out = new Map<string, Ads>();
  const tld = site ? new URL(site).hostname.split(".").pop()! : "";
  const where = {
    ...(GEO[tld] ? { geoTargetConstants: [`geoTargetConstants/${GEO[tld]}`] } : {}),
    ...(LANG[tld] ? { language: `languageConstants/${LANG[tld]}` } : {}),
  };
  const seed = site && seeds.length ? { keywordAndUrlSeed: { url: site, keywords: seeds.slice(0, 20) } }
    : site ? { urlSeed: { url: site } } : { keywordSeed: { keywords: seeds.slice(0, 20) } };
  let pageToken: string | undefined;
  do {
    const j = await adsCall(cfg, "generateKeywordIdeas", { ...seed, ...where, pageSize: 1000, ...(pageToken ? { pageToken } : {}) });
    for (const res of j.results ?? []) out.set(String(res.text).toLowerCase(), toAds(res.keywordIdeaMetrics));
    pageToken = j.nextPageToken;
  } while (pageToken && out.size < 5000);
  return out;
}

// ---------- auth ----------

async function auth() {
  const cfg = adsConfig();
  if (!cfg.file || !cfg.clientId || !cfg.clientSecret)
    throw new Error(`${KEY_FILE_SHOWN} needs GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET`);
  const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as Uint8Array).toString("base64url");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = crypto.randomUUID();
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/adwords",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

  let done: (code: string) => void;
  const got = new Promise<string>((res) => (done = res));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(new URL(REDIRECT).port),
    fetch(req) {
      const q = new URL(req.url).searchParams;
      if (q.get("state") !== state || !q.get("code")) return new Response("domain-hunt: sign-in failed, try again.", { status: 400 });
      done(q.get("code")!);
      return new Response("domain-hunt: signed in. You can close this tab.");
    },
  });
  console.log(`Sign in with the Google account that owns your Google Ads account:\n\n  ${url}\n`);
  const opener = process.platform === "darwin" ? ["open", url] : ["systemd-run", "--user", "--collect", "--quiet", "xdg-open", url];
  try {
    Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" });
  } catch {}
  const code = await got;
  server.stop();

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const tok: any = await r.json();
  if (!tok.refresh_token) throw new Error(`no refresh token from Google (${tok.error_description ?? tok.error ?? "consent remembered"})`);
  setEnvVar(cfg.file, "GOOGLE_ADS_REFRESH_TOKEN", tok.refresh_token);
  console.log(`saved GOOGLE_ADS_REFRESH_TOKEN to ${cfg.file}`);

  if (!cfg.customerId)
    await customerId(cfg, tok.access_token).then(
      (id) => console.log(`saved GOOGLE_ADS_CUSTOMER_ID=${id}`),
      (e: Error) => console.log(`Google Ads account: ${e.message}`),
    );
}

// ---------- output ----------

function comCell(c: Com): string {
  if (c.status === "free") return TTY ? "\x1b[32mFREE\x1b[0m" : "FREE";
  if (c.status === "dropping") return TTY ? `\x1b[33mdropping (${c.note})\x1b[0m` : `dropping (${c.note})`;
  // The registration date shows who is buying now; the expiry, when it could drop.
  if (c.status === "taken") return `taken ${c.registered ?? "?"} to ${c.expires ?? "?"}`;
  return `? ${c.note}`;
}

function cpcCell(c: Row["cpc"]): string {
  if (!c || (c.low == null && c.high == null)) return "-";
  if (c.low == null || c.high == null || c.low === c.high) return `$${(c.low ?? c.high)!.toFixed(2)}`;
  return `$${c.low.toFixed(2)}-${c.high.toFixed(2)}`;
}

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, n: number, right = false) => {
  const fill = " ".repeat(Math.max(0, n - visible(s)));
  return right ? fill + s : s + fill;
};

function table(rows: Row[], withAds: boolean) {
  const head = ["keyword", ".com", ...(withAds ? ["vol/mo", "cpc"] : []), "trend"];
  const cells = rows.map((r) => [
    r.keyword,
    comCell(r.com),
    ...(withAds ? [r.volume != null ? r.volume.toLocaleString("en-US") : r.typed ? "typed" : "-", cpcCell(r.cpc)] : []),
    r.trend == null ? "-" : `${r.trend > 0 ? "+" : ""}${r.trend}%`,
  ]);
  const width = head.map((h, c) => Math.max(visible(h), ...cells.map((row) => visible(row[c]))));
  const line = (row: string[]) => row.map((s, c) => pad(s, width[c], c >= 2)).join("   ").trimEnd();
  console.log(line(head));
  for (const row of cells) console.log(line(row));
}

function logRun(n: number, withAds: boolean) {
  try {
    const dir = join(homedir(), ".local", "state", "domain-hunt");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "runs.jsonl"), JSON.stringify({ ts: new Date().toISOString(), keywords: n, ads: withAds }) + "\n");
  } catch {}
}

// ---------- main ----------

async function readArgs(args: string[]): Promise<{ keywords: string[]; seeds: string[]; sites: string[]; json: boolean }> {
  let json = false;
  const raw: string[] = [];
  const seeds: string[] = [];
  const sites: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") usage();
    else if (a === "--json") json = true;
    else if (a === "-f") raw.push(...readFileSync(args[++i] ?? usage(2), "utf8").split("\n"));
    else if (a === "--seed") seeds.push(args[++i] ?? usage(2));
    else if (a === "--site") sites.push(/^https?:\/\//.test(args[i + 1] ?? "") ? args[++i] : `https://${args[++i] ?? usage(2)}`);
    else if (a.startsWith("-")) usage(2);
    else raw.push(a);
  }
  if (!raw.length && !seeds.length && !sites.length && !process.stdin.isTTY) raw.push(...(await Bun.stdin.text()).split("\n"));
  const clean = (xs: string[]) => [
    ...new Set(xs.map((k) => k.replace(/#.*/, "").trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean)),
  ];
  const out = { keywords: clean(raw), seeds: clean(seeds), sites, json };
  if (!out.keywords.length && !out.seeds.length && !sites.length) usage(2);
  return out;
}

type Trend = { trend: number | null; weekly: number[] } | Error;
// Accents fold to plain letters: "café paris" is cafeparis.com, not cafparis.com.
const plain = (k: string) => k.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const label = (k: string) => plain(k).replace(/[^a-z0-9]/g, "");

// What people type right now, from Google Autocomplete: the seed, then the seed and each letter.
// It catches a new term (a game not out yet) before Keyword Planner has a volume for it.
async function typedQueries(seed: string): Promise<string[]> {
  const qs = [seed, ..."abcdefghijklmnopqrstuvwxyz".split("").map((c) => `${seed} ${c}`)];
  const out = new Set<string>();
  for (let i = 0; i < qs.length; i += 6) {
    const got = await Promise.all(
      qs.slice(i, i + 6).map(async (q) => {
        try {
          const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
          return ((await r.json())[1] ?? []) as string[];
        } catch {
          return [];
        }
      }),
    );
    for (const s of got.flat()) out.add(s.toLowerCase().trim().replace(/\s+/g, " "));
  }
  // Google swaps in synonyms ("wow forever g" gives "wow eternal gladiator"): keep only the
  // suggestions that hold every word of the seed.
  const words = seed.split(" ");
  return [...out].filter((s) => words.every((w) => s.split(" ").includes(w)));
}

const NO_ADS: Ads = { volume: null, low: null, high: null, average: null, competition: null };

// Google pads ideas with variants of a head term that carry its volume: "my in my" is "my"
// (6.1M), "game o game" is "games". A repeated word or a one-letter word marks them.
function realSearch(k: string): boolean {
  const words = plain(k).split(" ");
  return /^[a-z0-9 ]+$/.test(plain(k)) && words.length <= 4 && new Set(words).size === words.length && words.every((w) => w.length >= 2);
}

// Seed mode: Keyword Planner ideas plus the queries Autocomplete shows, one per .com (its
// highest-volume phrasing), short names only, the free ones kept. Trends only for the top 20,
// to stay under its throttle.
async function seedHunt(seeds: string[], sites: string[], cfg: AdsConfig) {
  const [ideas, typed] = await Promise.all([
    seeds.length ? adsIdeas(seeds, cfg) : new Map<string, Ads>(),
    Promise.all(seeds.map(typedQueries)).then((x) => new Set(x.flat())),
  ]);
  // Per site, its 150 biggest searches, each tagged with the site it came from.
  const from = new Map<string, string>();
  for (const entry of sites) {
    const [site, kws = ""] = entry.split("=");
    debug(`ideas ${site}`);
    const host = new URL(site).hostname.replace(/^www\./, "");
    const top = [...(await adsIdeas(kws.split(",").map((k) => k.trim()).filter(Boolean), cfg, site))].sort((a, b) => (b[1].volume ?? 0) - (a[1].volume ?? 0)).slice(0, 150);
    for (const [k, a] of top) if (!ideas.has(k) || (ideas.get(k)!.volume ?? 0) < (a.volume ?? 0)) (ideas.set(k, a), from.set(k, host));
  }
  const missing = [...typed].filter((k) => !ideas.has(k));
  const pool = new Map(ideas);
  const extra = missing.length ? await adsMetrics(missing, cfg) : new Map<string, Ads>();
  for (const k of missing) pool.set(k, extra.get(k) ?? NO_ADS);
  const best = new Map<string, [string, Ads]>();
  for (const [k, a] of pool) {
    const l = label(k);
    if (!realSearch(k)) continue;
    if (l.length < 3 || l.length > 24 || (!a.volume && !typed.has(k))) continue;
    if (!best.has(l) || (best.get(l)![1].volume ?? -1) < (a.volume ?? -1)) best.set(l, [k, a]);
  }
  const sorted = [...best.values()].sort((a, b) => (b[1].volume ?? -1) - (a[1].volume ?? -1));
  // Every typed query is checked, even without a volume yet; the rest, the top 500 by volume.
  const ranked = [...sorted.filter(([, a]) => a.volume).slice(0, 500), ...sorted.filter(([, a]) => !a.volume)];
  debug(`checking ${ranked.length} .com`);
  const checked = await availability(ranked.map(([k]) => label(k) + ".com"));
  debug("trends");
  const free = ranked.map((r, i) => ({ keyword: r[0], ads: r[1], com: checked[i] })).filter((f) => f.com.status === "free" || f.com.status === "dropping");
  const keywords = free.map((f) => f.keyword);
  return {
    keywords,
    coms: free.map((f) => f.com),
    ads: new Map(free.map((f) => [f.keyword, f.ads])),
    typed,
    from,
    trend: await trends(keywords.slice(0, 20)),
    note: `${ideas.size} Keyword Planner ideas, ${typed.size} typed in Google now, ${ranked.length} short .com checked, ${free.length} free. "typed": no volume yet, but Google suggests it.`,
  };
}

if (process.argv[2] === "auth") {
  await auth().catch((e: Error) => {
    console.error(`auth failed: ${e.message}`);
    process.exit(1);
  });
  process.exit(0);
}

const args = await readArgs(process.argv.slice(2));
const { json } = args;
const cfg = adsConfig();
const adsReady = !!(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
// A country domain is measured where it sells: .fr in France, not worldwide, where the same word
// can be something else (a game, a brand). Google Ads geo target ids.
const GEO: Record<string, number> = { fr: 2250, de: 2276, uk: 2826, es: 2724, it: 2380, ch: 2756, be: 2056, ca: 2124, nl: 2528, pt: 2620 };
const LANG: Record<string, number> = { fr: 1002, de: 1001, es: 1003, it: 1004, nl: 1010, pt: 1014 };
async function adsByGeo(keywords: string[], domains: string[], cfg: AdsConfig): Promise<Map<string, Ads>> {
  const groups = new Map<number | undefined, string[]>();
  keywords.forEach((k, i) => {
    const g = GEO[domains[i].split(".").pop()!];
    groups.set(g, [...(groups.get(g) ?? []), k]);
  });
  const out = new Map<string, Ads>();
  for (const [g, ks] of groups) for (const [k, a] of await adsMetrics(ks, cfg, g)) out.set(k, a);
  return out;
}

// An input is a keyword (checked as its .com), a domain (its name is the keyword), or keyword=domain.
const targets = args.keywords.map((s) => {
  const [kw, dom] = s.split("=").map((x) => x.trim());
  if (dom) return { keyword: kw, domain: dom };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(s)) return { keyword: s.split(".")[0].replace(/-/g, " "), domain: s };
  return { keyword: s, domain: label(s) + ".com" };
});
let keywords = targets.map((t) => t.keyword);
let domains = targets.map((t) => t.domain);
let coms: Com[];
let trend: Trend[];
let ads: Map<string, Ads> | Error | null;
let note = "";
let typed = new Set<string>();
let from = new Map<string, string>();
const seeding = args.seeds.length > 0 || args.sites.length > 0;
if (seeding) {
  if (!adsReady) {
    console.error(`--seed and --site need Google Ads: fill ${KEY_FILE_SHOWN}, then run domain-hunt auth.`);
    process.exit(1);
  }
  const hunt = await seedHunt(args.seeds, args.sites, cfg).catch((e: Error) => {
    console.error(`ideas: FAILED. Google Ads said: ${e.message}`);
    process.exit(1);
  });
  ({ keywords, coms, trend, ads, note, typed, from } = hunt);
} else {
  [coms, trend, ads] = await Promise.all([
    availability(domains),
    trends(keywords),
    adsReady ? adsByGeo(keywords, domains, cfg).catch((e: Error) => e) : Promise.resolve(null),
  ]);
}
if (seeding) domains = keywords.map((k) => label(k) + ".com");
const withAds = ads instanceof Map;

const rows: Row[] = keywords.map((keyword, i) => {
  const a = withAds ? ads.get(keyword) : undefined;
  const t = trend[i] instanceof Error ? null : (trend[i] as { trend: number | null; weekly: number[] });
  return {
    keyword,
    domain: domains[i],
    com: coms[i],
    volume: a?.volume ?? null,
    cpc: a ? { low: a.low, high: a.high, average: a.average } : null,
    competition: a?.competition ?? null,
    trend: t?.trend ?? null,
    weekly: t?.weekly ?? [],
    typed: typed.has(keyword),
    from: from.get(keyword),
  };
});
const by = (f: (r: Row) => number | null) => (a: Row, b: Row) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity);
rows.sort(withAds ? by((r) => r.volume) : by((r) => r.trend));

if (json) console.log(JSON.stringify(rows, null, 2));
else table(rows, withAds);

if (note) console.error(`\n${note}`);
const failed = trend.filter((t) => t instanceof Error) as Error[];
if (failed.length) {
  console.error(`\ntrend: missing for ${failed.length} of ${keywords.length}, ${failed[0].message}.`);
  process.exitCode = 1;
}
if (!adsReady) console.error(`\nvolume, CPC: off. Fill ${KEY_FILE_SHOWN}, then run domain-hunt auth.`);
else if (ads instanceof Error) {
  console.error(`\nvolume, CPC: FAILED. Google Ads said: ${ads.message}`);
  process.exitCode = 1;
} else {
  const skipped = keywords.filter((k) => !askable(k));
  if (skipped.length) console.error(`\nno volume for ${skipped.join(", ")}: over 80 characters or 10 words.`);
}
logRun(keywords.length, withAds);
