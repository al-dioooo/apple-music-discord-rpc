#!/usr/bin/env deno run --allow-env --allow-run --allow-net --allow-read --allow-write --allow-ffi --allow-import --unstable-kv
import type {} from "https://raw.githubusercontent.com/NextFire/jxa/v0.0.5/run/global.d.ts";
import type { iTunes } from "https://raw.githubusercontent.com/NextFire/jxa/v0.0.5/run/types/core.d.ts";

//#region Utilities
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Abortable sleep: resolves after `ms` or immediately when `signal` aborts. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** Read an env var, tolerating a missing --allow-env permission. */
function env(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

const DEBUG = !!env("DEBUG");
function debug(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
//#endregion

//#region Logger
/**
 * Size-capped, self-rotating logger that owns `music-rpc.log`.
 *
 * launchd redirects the process's stdout/stderr to a separate boot log, so this
 * is the sole writer of the main log file and can safely rotate it (truncating a
 * file launchd holds open with O_APPEND would corrupt offsets). Overrides
 * `console.log`/`console.error`.
 */
class Logger {
  static #file: Deno.FsFile | null = null;
  static #path = "";
  static #bytes = 0;
  static #maxBytes = 5_000_000;
  static #tty = false;
  static #origLog: (...args: unknown[]) => void = console.log.bind(console);
  static #origError: (...args: unknown[]) => void = console.error.bind(console);

  static init(path: string, maxBytes = 5_000_000): void {
    this.#path = path;
    this.#maxBytes = maxBytes;
    try {
      this.#tty = Deno.stdout.isTerminal();
    } catch {
      this.#tty = false;
    }
    this.#origLog = console.log.bind(console);
    this.#origError = console.error.bind(console);
    this.#open();
    console.log = (...args: unknown[]) => this.#write("LOG", args);
    console.error = (...args: unknown[]) => this.#write("ERR", args);
  }

  static #open(): void {
    try {
      this.#file = Deno.openSync(this.#path, { create: true, write: true, append: true });
      this.#bytes = Deno.statSync(this.#path).size;
    } catch {
      this.#file = null;
    }
  }

  static #write(level: string, args: unknown[]): void {
    const text = formatLogArgs(args);
    const line = `${new Date().toISOString()} [${level}] ${text}\n`;
    if (this.#file) {
      try {
        const bytes = TEXT_ENCODER.encode(line);
        this.#file.writeSync(bytes);
        this.#bytes += bytes.byteLength;
        if (this.#bytes > this.#maxBytes) this.#rotate();
      } catch {
        this.#reopen();
      }
    }
    // Echo to the real console when attached to a terminal (foreground dev), or
    // as a fallback (→ launchd boot log) if the managed file could not be opened.
    if (this.#tty || !this.#file) {
      const orig = level === "ERR" ? this.#origError : this.#origLog;
      try {
        orig(text);
      } catch {
        // ignore
      }
    }
  }

  static #rotate(): void {
    try {
      this.#file?.close();
    } catch {
      // ignore
    }
    this.#file = null;
    try {
      Deno.renameSync(this.#path, `${this.#path}.1`);
    } catch {
      // ignore
    }
    this.#open();
  }

  static #reopen(): void {
    try {
      this.#file?.close();
    } catch {
      // ignore
    }
    this.#file = null;
    this.#open();
  }
}

function fmtArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** Minimal printf-style formatting so existing `%s`/`%d` call sites keep working. */
function formatLogArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  const [first, ...rest] = args;
  if (typeof first === "string" && /%[sdoj%]/.test(first)) {
    let i = 0;
    const out = first.replace(/%[sdoj%]/g, (m) => {
      if (m === "%%") return "%";
      if (i >= rest.length) return m;
      return fmtArg(rest[i++]);
    });
    const remaining = rest.slice(i).map(fmtArg);
    return [out, ...remaining].join(" ");
  }
  return args.map(fmtArg).join(" ");
}
//#endregion

//#region Discord IPC
export class DiscordNotFoundError extends Error {}
export class DiscordConnectionError extends Error {}

/** Discord Rich Presence activity (the subset this app sets). */
export interface Activity {
  type?: number; // 2 = "Listening to"
  details?: string;
  state?: string;
  status_display_type?: number;
  details_url?: string;
  state_url?: string;
  timestamps?: { start?: number; end?: number };
  assets?: {
    large_image?: string;
    large_text?: string;
    large_url?: string;
    small_image?: string;
    small_text?: string;
  };
  buttons?: { label: string; url: string }[];
}

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;
const MAX_FRAME_LEN = 64 * 1024;

function encodeFrame(op: number, payloadObj: unknown): Uint8Array {
  const payload = TEXT_ENCODER.encode(JSON.stringify(payloadObj));
  const data = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(data.buffer);
  view.setInt32(0, op, true);
  view.setInt32(4, payload.byteLength, true);
  data.set(payload, 8);
  return data;
}

let darwinTempDir: string | null | undefined; // undefined = not computed; null = unavailable

/** The authoritative macOS per-user temp dir; where the Discord GUI app puts its socket. */
async function getDarwinTempDir(): Promise<string | null> {
  if (darwinTempDir !== undefined) return darwinTempDir;
  try {
    const out = await new Deno.Command("getconf", {
      args: ["DARWIN_USER_TEMP_DIR"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const dir = TEXT_DECODER.decode(out.stdout).trim();
    darwinTempDir = dir.length ? dir.replace(/\/+$/, "") : null;
  } catch {
    darwinTempDir = null;
  }
  return darwinTempDir;
}

function ipcCandidatePaths(dirs: string[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of dirs) {
    if (!raw) continue;
    const dir = raw.replace(/\/+$/, "");
    for (let i = 0; i <= 9; i++) {
      const p = `${dir}/discord-ipc-${i}`;
      if (!seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

/**
 * Minimal Discord IPC client over the local unix socket.
 *
 * - `SET_ACTIVITY` is fire-and-forget (no per-nonce command queue → no leak).
 * - A background read loop drains and discards frames; its only job is to detect
 *   a dropped connection (EOF / error), even while the app is idle and never
 *   writes. This is what makes mid-session Discord crashes recoverable.
 * - All writes serialize through a single promise chain (no interleaved frames).
 */
export class DiscordIPC {
  #conn: Deno.Conn;
  #clientId: string;
  #onLost: () => void;
  #writeChain: Promise<unknown> = Promise.resolve();
  #lost = false;
  #closed = false;
  #header = new Uint8Array(8);
  #headerView: DataView;

  private constructor(conn: Deno.Conn, clientId: string, onLost: () => void) {
    this.#conn = conn;
    this.#clientId = clientId;
    this.#onLost = onLost;
    this.#headerView = new DataView(this.#header.buffer);
  }

  /**
   * Discover Discord's socket and complete the handshake.
   * @throws {DiscordNotFoundError} when no `discord-ipc-*` socket is connectable.
   * @throws {DiscordConnectionError} on handshake failure/timeout.
   */
  static async connect(
    clientId: string,
    onLost: () => void,
    handshakeTimeoutMs = 10_000,
  ): Promise<DiscordIPC> {
    const conn = await DiscordIPC.#findSocket();
    const ipc = new DiscordIPC(conn, clientId, onLost);
    try {
      await ipc.#handshake(handshakeTimeoutMs);
    } catch (err) {
      ipc.#closed = true;
      try {
        conn.close();
      } catch {
        // ignore
      }
      throw err instanceof DiscordConnectionError ? err : new DiscordConnectionError(errMsg(err));
    }
    ipc.#startReadLoop();
    return ipc;
  }

  static async #findSocket(): Promise<Deno.Conn> {
    const dirs = [
      env("XDG_RUNTIME_DIR"),
      env("TMPDIR"),
      (await getDarwinTempDir()) ?? undefined,
      env("TMP"),
      env("TEMP"),
      "/tmp",
    ].filter((d): d is string => !!d);

    for (const path of ipcCandidatePaths(dirs)) {
      try {
        return await Deno.connect({ path, transport: "unix" });
      } catch {
        // try next candidate
      }
    }
    throw new DiscordNotFoundError("no discord-ipc socket found");
  }

  async #handshake(timeoutMs: number): Promise<void> {
    await this.#write(OP_HANDSHAKE, { v: 1, client_id: this.#clientId });
    let timer: number | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DiscordConnectionError("handshake timeout")),
        timeoutMs,
      );
    });
    const readyP = this.#readUntilReady();
    readyP.catch(() => {}); // defensive: swallow if the timeout wins the race
    try {
      await Promise.race([readyP, timeoutP]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #readUntilReady(): Promise<void> {
    for (;;) {
      const frame = await this.#readFrame();
      if (frame === null) throw new DiscordConnectionError("connection closed during handshake");
      const { op, body } = frame;
      if (op === OP_CLOSE) {
        throw new DiscordConnectionError(`close during handshake: (${body?.code}) ${body?.message}`);
      }
      if (op === OP_PING) {
        this.#write(OP_PONG, body).catch(() => {});
        continue;
      }
      if (body && body.cmd === "DISPATCH" && body.evt === "READY") return;
      // ignore any other frame until READY
    }
  }

  /** Fire-and-forget: resolves when the frame is flushed, not when Discord ACKs. */
  setActivity(activity?: Activity | null): Promise<void> {
    return this.#write(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: Deno.pid, activity: activity ?? null },
      nonce: crypto.randomUUID(),
    });
  }

  clearActivity(): Promise<void> {
    return this.setActivity(null);
  }

  /** Intentional shutdown; suppresses the onLost callback so teardown's own EOF is silent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onLost = () => {};
    try {
      this.#conn.close();
    } catch {
      // ignore
    }
  }

  #write(op: number, payloadObj: unknown): Promise<void> {
    const data = encodeFrame(op, payloadObj);
    const run = this.#writeChain.then(async () => {
      if (this.#closed || this.#lost) throw new DiscordConnectionError("connection closed");
      await this.#writeAll(data);
    });
    this.#writeChain = run.catch(() => {}); // keep the chain alive after a failure
    run.catch(() => this.#handleLost()); // any write failure ⇒ connection lost
    return run;
  }

  async #writeAll(data: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < data.byteLength) {
      const n = await this.#conn.write(data.subarray(offset));
      if (n <= 0) throw new DiscordConnectionError("write returned 0");
      offset += n;
    }
  }

  #startReadLoop(): void {
    (async () => {
      try {
        while (!this.#closed && !this.#lost) {
          const frame = await this.#readFrame();
          if (frame === null) break; // EOF
          if (frame.op === OP_PING) {
            this.#write(OP_PONG, frame.body).catch(() => {});
          }
          // discard everything else (SET_ACTIVITY acks, dispatches, …)
        }
      } catch {
        // read error ⇒ connection lost
      } finally {
        this.#handleLost();
      }
    })();
  }

  async #readFrame(): Promise<{ op: number; body: any } | null> {
    let headerRead = 0;
    while (headerRead < 8) {
      const n = await this.#conn.read(this.#header.subarray(headerRead));
      if (n === null) return null;
      headerRead += n;
    }
    const op = this.#headerView.getInt32(0, true);
    const len = this.#headerView.getInt32(4, true);
    if (len < 0 || len > MAX_FRAME_LEN) {
      throw new DiscordConnectionError(`invalid frame length ${len}`);
    }
    const payload = new Uint8Array(len);
    let bodyRead = 0;
    while (bodyRead < len) {
      const n = await this.#conn.read(payload.subarray(bodyRead));
      if (n === null) return null;
      bodyRead += n;
    }
    let body: any;
    if (len > 0) {
      try {
        body = JSON.parse(TEXT_DECODER.decode(payload));
      } catch {
        throw new DiscordConnectionError("invalid JSON frame");
      }
    }
    return { op, body };
  }

  #handleLost(): void {
    if (this.#lost || this.#closed) return;
    this.#lost = true;
    try {
      this.#conn.close();
    } catch {
      // ignore
    }
    const cb = this.#onLost;
    queueMicrotask(() => cb());
  }
}
//#endregion

//#region RPC supervisor
type Desired =
  | { kind: "cleared" }
  | { kind: "playing"; activity: Activity; trackId: string; position: number; at: number };

const IDLE_RECHECK_MS = 15_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;
const STABLE_MS = 10_000;
const POLL_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

class AppleMusicDiscordRPC {
  static readonly CLIENT_IDS: Record<iTunesAppName, string> = {
    iTunes: "979297966739300416",
    Music: "773825528921849856",
  };
  // Increment after TrackExtras update
  static readonly KV_VERSION = 3;

  #ipc: DiscordIPC | null = null;
  #state: "disconnected" | "connecting" | "connected" = "disconnected";
  #desired: Desired = { kind: "cleared" };
  #lastPushedJson: string | null = null;
  #refreshing = false;
  #refreshQueued = false;
  #pollAbort: AbortController | null = null;
  #lost: { promise: Promise<void>; resolve: () => void } | null = null;
  #attempt = 0;
  #connectedAt = 0;
  #lastLoggedState = "";

  /**
   * @private Use `AppleMusicDiscordRPC.create()` instead.
   */
  private constructor(
    private readonly appName: iTunesAppName,
    private readonly clientId: string,
    private readonly kv: Deno.Kv,
  ) {}

  static async create(): Promise<AppleMusicDiscordRPC> {
    const macOSVersion = await this.getMacOSVersion();
    const appName: iTunesAppName = macOSVersion >= 10.15 ? "Music" : "iTunes";
    const kv = await Deno.openKv(`cache_v${this.KV_VERSION}.sqlite3`);
    return new this(appName, this.CLIENT_IDS[appName], kv);
  }

  /** Run the persistent Music listener and the Discord connection supervisor in parallel. */
  async run(): Promise<void> {
    await Promise.race([this.#runMusicListener(), this.#runSupervisor()]);
  }

  #runMusicListener(): Promise<never> {
    // The Swift notification listener persists across Discord reconnects; each
    // event just asks for a refresh of the desired activity.
    return listenToEvents(() => this.#scheduleRefresh());
  }

  async #runSupervisor(): Promise<never> {
    for (;;) {
      try {
        if (!(await isDiscordRunning())) {
          this.#logState("idle", "No Discord client is running; waiting");
          this.#resetBackoff();
          await sleep(IDLE_RECHECK_MS);
          continue;
        }

        this.#state = "connecting";
        this.#newLostSignal();
        debug("Connecting to Discord RPC…");

        let ipc: DiscordIPC;
        try {
          ipc = await DiscordIPC.connect(
            this.clientId,
            () => this.#signalLost(),
            HANDSHAKE_TIMEOUT_MS,
          );
        } catch (err) {
          if (err instanceof DiscordNotFoundError) {
            // Discord process exists but no socket yet ⇒ treat as "not ready", quiet idle.
            this.#logState("idle", "Discord socket not found; waiting");
            this.#resetBackoff();
            await sleep(IDLE_RECHECK_MS);
          } else {
            const delay = this.#nextBackoff();
            this.#logState("backoff", `Connect failed: ${errMsg(err)} — retrying in ${delay}ms`);
            await sleep(delay);
          }
          continue;
        }

        // ---- CONNECTED ----
        this.#ipc = ipc;
        this.#state = "connected";
        this.#connectedAt = Date.now();
        this.#lastPushedJson = null; // force a re-push of the current activity
        this.#logState("connected", "Connected to Discord RPC");
        await this.#scheduleRefresh(); // re-apply desired presence immediately

        await this.#lost!.promise; // park until the connection is lost

        // ---- DISCONNECTED ----
        const stable = Date.now() - this.#connectedAt >= STABLE_MS;
        this.#logState("disconnected", "Discord connection lost");
        this.#teardown();
        if (stable) this.#resetBackoff(); // a healthy session that just ended → reset
        await sleep(this.#nextBackoff());
      } catch (err) {
        // Transient failure (e.g. osascript/automation error). Never let it kill
        // the supervisor — tear down, back off, and keep going.
        console.error("Supervisor error:", errMsg(err));
        this.#teardown();
        await sleep(this.#nextBackoff());
      }
    }
  }

  #signalLost(): void {
    if (this.#state === "connected") this.#state = "disconnected";
    this.#lost?.resolve();
  }

  #newLostSignal(): void {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.#lost = { promise, resolve };
  }

  #teardown(): void {
    this.#stopPoll();
    this.#ipc?.close();
    this.#ipc = null;
    this.#state = "disconnected";
  }

  #nextBackoff(): number {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.#attempt);
    this.#attempt++;
    return Math.floor(base * (0.8 + Math.random() * 0.4)); // ±20% jitter
  }

  #resetBackoff(): void {
    this.#attempt = 0;
  }

  #logState(state: string, msg: string): void {
    if (state === this.#lastLoggedState) return;
    this.#lastLoggedState = state;
    console.log(msg);
  }

  /** Single-flight refresh with coalescing so bursts collapse into one recompute. */
  async #scheduleRefresh(): Promise<void> {
    if (this.#refreshing) {
      this.#refreshQueued = true;
      return;
    }
    this.#refreshing = true;
    try {
      do {
        this.#refreshQueued = false;
        try {
          await this.#computeDesired();
        } catch (err) {
          // e.g. Music quit mid-query — log and carry on; do NOT tear down Discord.
          console.error("Refresh failed:", errMsg(err));
        }
      } while (this.#refreshQueued);
    } finally {
      this.#refreshing = false;
    }
  }

  async #computeDesired(): Promise<void> {
    if (!(await isMusicRunning(this.appName))) {
      this.#setCleared();
      this.#stopPoll();
      this.#pushDesired();
      return;
    }

    const state = await getMusicState(this.appName);
    debug("state:", state);

    if (state === "playing") {
      const properties = await getMusicProperties(this.appName);
      const activity = await this.#buildActivity(properties);
      this.#desired = {
        kind: "playing",
        activity,
        trackId: properties.persistentID,
        position: properties.playerPosition,
        at: Date.now(),
      };
      this.#pushDesired();
      this.#startPoll();
    } else {
      // paused | stopped | unknown
      this.#setCleared();
      this.#stopPoll();
      this.#pushDesired();
    }
  }

  #setCleared(): void {
    this.#desired = { kind: "cleared" };
  }

  #pushDesired(): void {
    if (this.#state !== "connected" || !this.#ipc) return; // never write while disconnected
    const activity = this.#desired.kind === "playing" ? this.#desired.activity : null;
    const json = JSON.stringify(activity);
    if (json === this.#lastPushedJson) return; // dedupe identical updates
    this.#lastPushedJson = json;
    this.#ipc.setActivity(activity).catch(() => {}); // failure handled inside DiscordIPC
  }

  async #buildActivity(properties: iTunesProperties): Promise<Activity> {
    let start: number | undefined;
    let end: number | undefined;
    if (properties.duration) {
      const delta = (properties.duration - properties.playerPosition) * 1000;
      start = Math.ceil(Date.now() - properties.playerPosition * 1000);
      end = Math.ceil(Date.now() + delta);
    }

    // EVERYTHING must be less than or equal to 128 chars long
    const activity: Activity = {
      type: 2, // "Listening to"
      details: AppleMusicDiscordRPC.ensureValidStringLength(properties.name),
      timestamps: { start, end },
    };

    if (properties.artist) {
      activity.status_display_type = 1;
      activity.state = AppleMusicDiscordRPC.ensureValidStringLength(properties.artist);
    }

    if (properties.album) {
      const extras = await this.cachedTrackExtras(properties);
      debug("extras:", extras);

      activity.details_url = extras.trackViewUrl;
      activity.state_url = extras.artistViewUrl;
      activity.assets = {
        large_image: extras.artworkUrl,
        large_text: AppleMusicDiscordRPC.ensureValidStringLength(properties.album),
        large_url: extras.collectionViewUrl,
      };

      const buttons: NonNullable<Activity["buttons"]> = [];
      const spotifyQuery = encodeURIComponent(
        `artist:${properties.artist} track:${properties.name}`,
      );
      const spotifyUrl = `https://open.spotify.com/search/${spotifyQuery}?si`;
      if (spotifyUrl.length <= 512) {
        buttons.push({ label: "Search on Spotify", url: spotifyUrl });
      }
      if (buttons.length > 0) {
        activity.buttons = buttons;
      }
    }

    return activity;
  }

  /** 5s poll bound to the connection lifecycle: runs only while connected + playing. */
  #startPoll(): void {
    if (this.#pollAbort || this.#state !== "connected") return;
    const ac = new AbortController();
    this.#pollAbort = ac;
    const signal = ac.signal;

    (async () => {
      let lastPos = 0;
      let lastAt = Date.now();
      let lastId = "";

      const seed = await getMusicProperties(this.appName).catch(() => null);
      if (seed) {
        lastPos = seed.playerPosition;
        lastId = seed.persistentID;
      }

      while (!signal.aborted) {
        await sleepAbortable(POLL_MS, signal);
        if (signal.aborted) break;

        try {
          if (!(await isMusicRunning(this.appName))) {
            await this.#scheduleRefresh(); // clears + stops poll
            break;
          }
          const state = await getMusicState(this.appName);
          if (state !== "playing") {
            await this.#scheduleRefresh();
            break;
          }

          const properties = await getMusicProperties(this.appName);
          const now = Date.now();
          const expectedPosition = lastPos + (now - lastAt) / 1000;
          const diff = Math.abs(properties.playerPosition - expectedPosition);

          // Sync if track changed, position went backward (repeat/rewind), or seeked > 3s.
          if (
            properties.persistentID !== lastId ||
            properties.playerPosition < lastPos ||
            diff > 3
          ) {
            debug(
              `Timeline sync: trackChanged=${properties.persistentID !== lastId}, ` +
                `repeated=${properties.playerPosition < lastPos}, seekDiff=${diff.toFixed(1)}s`,
            );
            await this.#scheduleRefresh();
          }
          lastAt = now;
          lastPos = properties.playerPosition;
          lastId = properties.persistentID;
        } catch (err) {
          if (DEBUG) console.error("Poll error:", errMsg(err));
        }
      }
    })();
  }

  #stopPoll(): void {
    this.#pollAbort?.abort();
    this.#pollAbort = null;
  }

  async cachedTrackExtras(properties: iTunesProperties): Promise<TrackExtras> {
    const cacheId = properties.persistentID;
    const entry = await this.kv.get<TrackExtras>(["extras", cacheId]);
    let extras = entry.value;
    if (!extras || (extras.expiresAt && extras.expiresAt < Date.now())) {
      extras = await fetchTrackExtras(this.appName, properties);
      await this.kv.set(["extras", cacheId], extras);
    }
    return extras;
  }

  static async getMacOSVersion(): Promise<number> {
    const cmd = new Deno.Command("sw_vers", { args: ["-productVersion"] });
    const output = await cmd.output();
    const decoded = new TextDecoder().decode(output.stdout);
    const version = parseFloat(decoded.match(/\d+\.\d+/)![0]);
    return version;
  }

  static ensureValidStringLength(
    value: string,
    minLength = 2,
    maxLength = 128,
  ): string {
    if (value.length < minLength) {
      return value.padEnd(minLength);
    } else if (value.length > maxLength) {
      return `${value.slice(0, maxLength - 3)}...`;
    } else {
      return value;
    }
  }
}
//#endregion

//#region JXA
async function run<T = any>(
  jxaFunction: (...args: any[]) => T,
  ...args: any[]
): Promise<T> {
  const code = `
  ObjC.import('stdlib');
  const args = JSON.parse($.getenv('OSA_ARGS'));
  const fn   = (${jxaFunction.toString()});
  const out  = fn.apply(null, args);
  JSON.stringify({ result: out });
  `;
  return await runInOsascript(code, args);
}

async function runInOsascript(code: string, args: any[]) {
  const cmd = new Deno.Command("osascript", {
    args: ["-l", "JavaScript", "-e", code],
    env: { OSA_ARGS: JSON.stringify(args) },
    stdout: "piped",
    stderr: "piped",
  });

  const { stderr: error, stdout: output } = await cmd.output();
  const decoder = new TextDecoder();

  if (error.length) {
    handleError(decoder.decode(error));
  }
  const outStr = decoder.decode(output);
  if (!output.length) {
    return undefined;
  }
  try {
    const result = JSON.parse(outStr.trim()).result;
    return result;
  } catch {
    return outStr.trim();
  }
}

function handleError(OsascriptMessage: string) {
  const errorGroups = OsascriptMessage.match(
    /execution\serror:\sError:\s(?<type>\w+):\s(?<message>.+)\(-\d+\)/,
  )?.groups;
  const errorTypeString = errorGroups?.type ?? "";
  const errorMessage = errorGroups?.message?.trim() ?? "An error occurred";
  const errorMapping: Record<string, ErrorConstructor> = {
    Error: Error,
    EvalError: EvalError,
    RangeError: RangeError,
    ReferenceError: ReferenceError,
    SyntaxError: SyntaxError,
    TypeError: TypeError,
    URIError: URIError,
  };
  const errorType = errorMapping?.[errorTypeString] ?? Error;
  throw errorType(errorMessage);
}

function isDiscordRunning(): Promise<boolean> {
  return run((clientNames: string[]) => {
    const systemEvents = Application("System Events");
    return clientNames.some((clientName) =>
      systemEvents.processes[clientName]?.exists()
    );
  }, ["Discord", "Discord PTB", "Discord Canary"]);
}

function isMusicRunning(appName: iTunesAppName): Promise<boolean> {
  return run((appName: iTunesAppName) => {
    return Application("System Events").processes[appName].exists();
  }, appName);
}

function getMusicState(appName: iTunesAppName): Promise<string> {
  return run((appName: iTunesAppName) => {
    const music = Application(appName) as unknown as iTunes;
    return music.playerState();
  }, appName);
}

function getMusicProperties(appName: iTunesAppName): Promise<iTunesProperties> {
  return run((appName: iTunesAppName) => {
    const music = Application(appName) as unknown as iTunes;
    return {
      ...music.currentTrack().properties(),
      playerPosition: music.playerPosition(),
    };
  }, appName);
}

async function getAlbumArtwork(
  appName: iTunesAppName,
): Promise<Blob | undefined> {
  const rawData = await run((appName: iTunesAppName) => {
    const music = Application(appName) as unknown as iTunes;
    return music.currentTrack().artworks[0].rawData();
  }, appName);

  const dataStr = String(rawData);
  const hexMatch = dataStr.match(/\$([0-9A-Fa-f]+)\$/);
  if (!hexMatch) {
    return undefined;
  }

  // Convert hex string to Uint8Array
  const hexString = hexMatch[1];
  const length = hexString.length;
  const data = new Uint8Array(length / 2);
  for (let i = 0; i < length; i += 2) {
    data[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
  }

  // Detect image format from magic bytes
  let mimeType: string;
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
    mimeType = "image/jpeg";
  } else if (
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47
  ) {
    mimeType = "image/png";
  } else if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    mimeType = "image/gif";
  } else if (data[0] === 0x42 && data[1] === 0x4D) {
    mimeType = "image/bmp";
  } else {
    return undefined;
  }

  return new Blob([data], { type: mimeType });
}

let tempSwiftFile: string | undefined;

async function cleanupTempFile() {
  if (tempSwiftFile) {
    try {
      await Deno.remove(tempSwiftFile);
    } catch {}
    tempSwiftFile = undefined;
  }
}

try {
  Deno.addSignalListener("SIGINT", async () => {
    console.log("\nReceived SIGINT. Cleaning up...");
    await cleanupTempFile();
    Deno.exit(0);
  });
  Deno.addSignalListener("SIGTERM", async () => {
    console.log("\nReceived SIGTERM. Cleaning up...");
    await cleanupTempFile();
    Deno.exit(0);
  });
} catch {
  // Signal listeners might not be supported in all Deno environments, but we are running in macOS CLI where it is supported.
}

globalThis.addEventListener("unload", () => {
  if (tempSwiftFile) {
    try {
      Deno.removeSync(tempSwiftFile);
    } catch {}
  }
});

async function listenToEvents(
  onEvent: (event: any) => Promise<void> | void,
): Promise<never> {
  const swiftCode = `
import Foundation

class NotificationListener {
    @objc func handleNotification(_ notification: Notification) {
        var dict: [String: Any] = [:]
        if let userInfo = notification.userInfo {
            for (key, value) in userInfo {
                if let keyStr = key as? String {
                    dict[keyStr] = value
                }
            }
        }
        if let jsonData = try? JSONSerialization.data(withJSONObject: dict, options: []),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
            fflush(stdout)
        }
    }
}

let listener = NotificationListener()
let center = DistributedNotificationCenter.default()

center.addObserver(
    listener,
    selector: #selector(NotificationListener.handleNotification(_:)),
    name: NSNotification.Name("com.apple.Music.playerInfo"),
    object: nil
)
center.addObserver(
    listener,
    selector: #selector(NotificationListener.handleNotification(_:)),
    name: NSNotification.Name("com.apple.iTunes.playerInfo"),
    object: nil
)

print("LISTENING")
fflush(stdout)

RunLoop.current.run()
  `;

  tempSwiftFile = await Deno.makeTempFile({ suffix: ".swift" });
  await Deno.writeTextFile(tempSwiftFile, swiftCode);

  try {
    while (true) {
      debug("Spawning swift listener process...");
      const command = new Deno.Command("swift", {
        args: [tempSwiftFile],
        stdout: "piped",
        stderr: "inherit",
      });
      const process = command.spawn();

      const reader = process.stdout
        .pipeThrough(new TextDecoderStream())
        .getReader();

      let buffer = "";
      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          buffer += chunk;
          // Defensive cap: drop a pathological no-newline stream instead of growing forever.
          if (buffer.length > MAX_FRAME_LEN && !buffer.includes("\n")) {
            buffer = "";
            continue;
          }
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed === "LISTENING") {
              debug("Swift notification listener is active.");
              continue;
            }
            try {
              const event = JSON.parse(trimmed);
              await onEvent(event);
            } catch (e) {
              console.error("Error handling event line:", e);
            }
          }
        }
      } catch (err) {
        console.error("Error reading from swift listener process:", err);
      } finally {
        try {
          reader.releaseLock();
        } catch {}
        try {
          process.kill();
        } catch {}
      }

      console.log("Swift listener exited, restarting in 1s...");
      await sleep(1000);
    }
  } finally {
    await cleanupTempFile();
  }
}
//#endregion

//#region Extras
async function fetchTrackExtras(
  appName: iTunesAppName,
  properties: iTunesProperties,
): Promise<TrackExtras> {
  const json = await iTunesSearch(properties);
  const result = findMatchingResult(properties, json);

  // If no results and album has parenthetical suffix, retry without it
  // e.g. "Album (Deluxe Edition)" -> "Album"
  if (!result && properties.album.match(/\(.*\)$/)) {
    return fetchTrackExtras(appName, {
      ...properties,
      album: properties.album.replace(/\(.*\)$/, "").trim(),
    });
  }

  const extras: TrackExtras = {
    artworkUrl: result?.artworkUrl100,
    artistViewUrl: result?.artistViewUrl,
    collectionViewUrl: result?.collectionViewUrl,
    trackViewUrl: result?.trackViewUrl,
  };

  if (!extras.artworkUrl) {
    const uploaded = await uploadedLocalArtworkUrl(appName);
    extras.artworkUrl = uploaded?.url;
    extras.expiresAt = uploaded?.expiresAt;
  }

  return extras;
}

async function fetchWithTimeout(
  input: string | URL | Request,
  init?: RequestInit,
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(id);
  }
}

async function iTunesSearch(
  { name, artist, album }: iTunesProperties,
): Promise<iTunesSearchResponse | undefined> {
  const params = new URLSearchParams({
    media: "music",
    entity: "song",
    term: `${name} ${artist} ${album}`,
    // default to Japan store for more comprehensive results
    // western + asian music
    country: "JP",
  });
  const url = `https://itunes.apple.com/search?${params}`;
  console.log("iTunes search", url);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await fetchWithTimeout(url);
    if (resp.ok) {
      const json = await resp.json();
      return json as iTunesSearchResponse;
    }
    console.error(
      "Failed to fetch from iTunes API: %s %s",
      resp.statusText,
      url,
    );
    resp.body?.cancel();
    await sleep(200);
  }
}

function findMatchingResult(
  properties: iTunesProperties,
  json: iTunesSearchResponse | undefined,
): iTunesSearchResult | undefined {
  if (!json || json.resultCount === 0) {
    return undefined;
  }
  if (json.resultCount === 1) {
    return json.results[0];
  }
  // Multiple results: find the one matching album and track name
  // Use includes() for flexibility with imported songs' formatting
  const albumLower = properties.album.toLowerCase();
  const nameLower = properties.name.toLowerCase();
  return json.results.find(
    (r) =>
      r.collectionName.toLowerCase().includes(albumLower) &&
      r.trackName.toLowerCase().includes(nameLower),
  );
}

async function uploadedLocalArtworkUrl(
  appName: iTunesAppName,
): Promise<{ url: string; expiresAt: number } | undefined> {
  const localArtwork = await getAlbumArtwork(appName);
  return localArtwork ? await litterboxUpload(localArtwork) : undefined;
}

async function litterboxUpload(
  blob: Blob,
): Promise<{ url: string; expiresAt: number }> {
  const formData = new FormData();
  formData.append("reqtype", "fileupload");
  formData.append("time", "1h");
  formData.append("fileToUpload", blob, "artwork.jpg");
  const response = await fetchWithTimeout(
    "https://litterbox.catbox.moe/resources/internals/api.php",
    {
      method: "POST",
      body: formData,
    },
    8000, // 8 seconds timeout for file uploads
  );
  if (!response.ok) {
    throw new Error(`Failed to upload to catbox.moe: ${response.statusText}`);
  }
  const url = await response.text();
  const expiresAt = Date.now() + 60 * 60 * 1000;
  return { url: url.trim(), expiresAt };
}
//#endregion

//#region TypeScript
type iTunesAppName = "iTunes" | "Music";

interface iTunesProperties {
  persistentID: string;
  name: string;
  artist: string;
  album: string;
  year: number;
  duration?: number;
  playerPosition: number;
}

interface TrackExtras {
  artworkUrl?: string;
  artistViewUrl?: string;
  collectionViewUrl?: string;
  trackViewUrl?: string;
  expiresAt?: number;
}

interface iTunesSearchResponse {
  resultCount: number;
  results: iTunesSearchResult[];
}

interface iTunesSearchResult {
  trackName: string;
  collectionName: string;
  artworkUrl100: string;
  artistViewUrl: string;
  collectionViewUrl: string;
  trackViewUrl: string;
}
//#endregion

if (import.meta.main) {
  Logger.init("music-rpc.log");
  const client = await AppleMusicDiscordRPC.create();
  await client.run();
}
