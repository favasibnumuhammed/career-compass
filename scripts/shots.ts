/**
 * Phase 7: regenerate the README screenshots.
 *
 *   npm run dev                                  # or point at the deployment
 *   npm run shots
 *   BASE_URL=https://… npm run shots
 *
 * Screenshots rot. A card gets restyled, the copy changes, and the README keeps
 * showing last month's app — so this is a script rather than a folder of files
 * someone once dragged in. It resolves its own scenario through the API, the
 * same way `npm run pages` does, so there are no URLs to update by hand either.
 *
 * It drives the installed Chrome over the DevTools protocol using Node's global
 * WebSocket — no Playwright, no Puppeteer, nothing added to package.json for
 * three PNGs. Two things justify the protocol over `chrome --screenshot`:
 *
 *  - `clip` with `captureBeyondViewport` photographs one section wherever it
 *    sits on the page. The career path is below 75 optional-skill pills, which
 *    no plausible viewport reaches.
 *  - the page can be *asked* when it has finished streaming, rather than given
 *    a fixed budget and hoped over. `/results` takes ~8s and the answer must be
 *    in the picture.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { color } from "./report";
import type { OccupationPrefill, OccupationSuggestion } from "../lib/types";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const OUT = "docs/screenshots";
const WIDTH = 1400;
const SCALE = 2; // retina, so the images stay sharp scaled down in a README

const CHROME =
  process.env.CHROME ??
  ["google-chrome", "chromium", "chromium-browser", "/usr/bin/google-chrome"].find((bin) =>
    bin.startsWith("/") ? existsSync(bin) : true,
  )!;

interface Shot {
  name: string;
  what: string;
  path: string;
  /** Viewport height, when the whole shot is the top of the page. */
  height?: number;
  /** Or: photograph the section whose heading starts with this text. */
  section?: string;
  /** Text that must be on screen before the shutter — the streamed answer. */
  settled: string;
}

/* -------------------------------------------------------------------------- */
/* the devtools protocol, in about forty lines                                 */
/* -------------------------------------------------------------------------- */

class Chrome {
  private constructor(
    private readonly socket: WebSocket,
    private readonly kill: () => void,
  ) {}

  private session = "";
  private next = 1;
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();

  static async launch(): Promise<Chrome> {
    const child = spawn(
      CHROME,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--remote-debugging-port=0",
        `--window-size=${WIDTH},1200`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    // Chrome prints the port it actually chose to stderr.
    const endpoint = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(() => reject(new Error("Chrome did not report a debugging port")), 20000);
      child.stderr.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const match = /ws:\/\/[^\s]+/.exec(buffered);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.on("exit", (code) => reject(new Error(`Chrome exited with ${code}. Is it installed?`)));
    });

    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("cannot attach to Chrome")), { once: true });
    });

    const chrome = new Chrome(socket, () => child.kill());
    socket.addEventListener("message", (event) => chrome.receive(String(event.data)));

    // Browser-level commands first, then everything else goes to the page's
    // session — one instance throughout, so replies find their caller.
    const { targetId } = await chrome.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await chrome.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    chrome.session = sessionId;
    return chrome;
  }

  private receive(data: string): void {
    const message = JSON.parse(data) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return; // an event; none are awaited here
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result as never);
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    const frame: Record<string, unknown> = { id, method, params };
    if (this.session) frame.sessionId = this.session;
    this.socket.send(JSON.stringify(frame));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 60000);
    });
  }

  /** Evaluate in the page and return the JSON value. */
  async evaluate<T>(expression: string): Promise<T> {
    const { result } = await this.send<{ result: { value: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.value;
  }

  close(): void {
    this.socket.close();
    this.kill();
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Wait for text to appear, rather than guessing how long the query takes.
 *
 * Case-insensitively, because `innerText` is what the *reader* sees: Chrome
 * applies `text-transform`, so the hero's eyebrow comes back as "LEARN THIS
 * NEXT" and an exact match waits forever on a page that rendered fine.
 */
async function settle(chrome: Chrome, text: string, timeoutMs = 40000): Promise<number> {
  const started = Date.now();
  for (;;) {
    const there = await chrome.evaluate<boolean>(
      `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`,
    );
    if (there) return Date.now() - started;
    if (Date.now() - started > timeoutMs) {
      // Say what was on screen instead — a blank page and the wrong page are
      // different failures, and the message should tell them apart.
      const seen = await chrome.evaluate<string>(
        `location.href + " :: " + (document.body ? document.body.innerText.slice(0, 200) : "<no body>")`,
      );
      throw new Error(`"${text}" never appeared.\n  ${seen}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function capture(chrome: Chrome, shot: Shot): Promise<{ file: string; waitedMs: number }> {
  await chrome.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: shot.height ?? 1200,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  await chrome.send("Page.navigate", { url: `${BASE}${shot.path}` });
  const waitedMs = await settle(chrome, shot.settled);
  // Fonts and the coverage rings' transitions land a beat after the text.
  await new Promise((r) => setTimeout(r, 900));

  let clip: Record<string, number> | undefined;
  if (shot.section) {
    clip = await chrome.evaluate<Record<string, number>>(`(() => {
      const marker = ${JSON.stringify(shot.section.toLowerCase())};
      // Leaf elements only: an ancestor's textContent contains the marker too,
      // and the whole page would match.
      const label = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && e.textContent.trim().toLowerCase().startsWith(marker),
      );
      if (!label) throw new Error('no element reads "' + marker + '"');
      const box = (label.closest('section') ?? label.parentElement).getBoundingClientRect();
      return { x: Math.max(0, box.x - 24), y: box.y + window.scrollY - 24,
               width: Math.min(${WIDTH}, box.width + 48), height: box.height + 48, scale: ${SCALE} };
    })()`);
  }

  const { data } = await chrome.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: Boolean(clip),
    ...(clip ? { clip } : {}),
  });

  const file = join(OUT, `${shot.name}.png`);
  await writeFile(file, Buffer.from(data, "base64"));
  return { file, waitedMs };
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(color.dim(`\n  ${BASE} → ${OUT}\n`));

  // The same scenario the rest of the harnesses use, resolved the same way.
  const find = async (q: string) =>
    (
      (await (await fetch(`${BASE}/api/search?kind=occupation&q=${encodeURIComponent(q)}&limit=1`)).json()) as {
        results: OccupationSuggestion[];
      }
    ).results[0];

  const id = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);
  const home = await find("retail department manager");
  const target = await find("supply chain manager");
  if (!home || !target) throw new Error(`cannot reach ${BASE} — is the app running?`);

  const prefill = (await (await fetch(`${BASE}/api/occupation/${id(home.uri)}/prefill`)).json()) as OccupationPrefill;
  const context = `s=${prefill.essentialSkills.map((s) => id(s.uri)).join(",")}&from=${id(home.uri)}`;

  const shots: Shot[] = [
    {
      name: "entry",
      what: "the two doors",
      path: "/",
      height: 860,
      settled: "Start from a job you've done",
    },
    {
      name: "results",
      what: "hero, tiers and the empty tier that explains itself",
      path: `/results?${context}`,
      height: 2100,
      settled: "Learn this next",
    },
    {
      name: "bridge",
      what: "the hero card alone",
      path: `/results?${context}`,
      section: "Learn this next",
      settled: "Learn this next",
    },
    {
      name: "occupation",
      what: "have/missing against a target job",
      path: `/occupation/${id(target.uri)}?${context}`,
      height: 1100,
      settled: "Essential skills",
    },
    {
      name: "path",
      what: "the career path, three hops down the page",
      path: `/occupation/${id(target.uri)}?${context}`,
      section: "Getting here from where you are",
      settled: "Skills already counted",
    },
  ];

  await mkdir(OUT, { recursive: true });
  const chrome = await Chrome.launch();
  try {
    for (const shot of shots) {
      const { file, waitedMs } = await capture(chrome, shot);
      console.log(
        `  ${color.green("✓")} ${shot.name.padEnd(12)}${color.dim(shot.what.padEnd(48))}` +
          `${file}${color.dim(` · settled in ${(waitedMs / 1000).toFixed(1)}s`)}`,
      );
    }
  } finally {
    chrome.close();
  }
  console.log(color.green(`\n✓ ${shots.length} screenshots written.\n`));
}

main().catch((error: Error) => {
  console.error(color.red(`\n✗ ${error.message}\n`));
  process.exitCode = 1;
});
