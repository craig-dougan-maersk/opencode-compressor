import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const PYTHON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "python");
/** `uv run` may sync the environment on first use, so allow a generous start. */
const DEFAULT_START_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 10 * 60_000;
/** A single protocol line larger than this means something went wrong; stop rather than buffer it. */
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 3_000;
export function findUv(explicit) {
    if (explicit)
        return explicit;
    const candidates = [
        ...(process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "uv")),
        path.join(os.homedir(), ".local", "bin", "uv"),
        path.join(os.homedir(), ".cargo", "bin", "uv"),
        "/opt/homebrew/bin/uv",
        "/usr/local/bin/uv",
    ];
    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        }
        catch {
            // Try the next location.
        }
    }
    return "uv";
}
/**
 * A single long-lived Python process so the compression model is loaded once.
 * Requests are serialised by the worker (it reads stdin line by line).
 *
 * The worker runs in its own process group and is killed as a group, so `uv`
 * and Python cannot be left behind holding several GB of model weights. All
 * stream errors are handled: an EPIPE or a dead child must reject the request,
 * never become an uncaught exception that takes the whole OpenCode server down.
 */
export class Worker {
    options;
    child;
    ready;
    readyReject;
    pending = new Map();
    nextID = 1;
    buffer = "";
    stderrTail = [];
    idleTimer;
    lastStatus;
    constructor(options = {}) {
        this.options = options;
    }
    get running() {
        return !!this.child && this.child.exitCode === null;
    }
    get pid() {
        return this.running ? this.child?.pid : undefined;
    }
    start() {
        if (this.child && this.child.exitCode === null && this.ready)
            return this.ready;
        const pythonDir = this.options.pythonDir ?? PYTHON_DIR;
        const uv = findUv(this.options.uv);
        const startTimeout = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
        const maxLine = this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
        this.stderrTail = [];
        this.buffer = "";
        let child;
        try {
            child = spawn(uv, ["run", "--quiet", "--project", pythonDir, "python", path.join(pythonDir, "worker.py")], {
                cwd: pythonDir,
                env: { ...process.env, PYTHONUNBUFFERED: "1", ...this.options.env },
                stdio: ["pipe", "pipe", "pipe"],
                // Leading our own process group lets stop() kill uv and Python together.
                detached: process.platform !== "win32",
            });
        }
        catch (error) {
            return Promise.reject(new Error(`Could not start the LLMLingua worker with ${uv}: ${error instanceof Error ? error.message : String(error)}`));
        }
        this.child = child;
        this.ready = new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                fail(new Error(`The LLMLingua worker did not start within ${Math.round(startTimeout / 1000)}s (${uv}). ` +
                    "Check that uv works and the bundled Python environment can be installed."));
            }, startTimeout);
            timer.unref?.();
            const settle = (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (error)
                    reject(error);
                else
                    resolve();
            };
            this.readyReject = (error) => settle(error);
            const fail = (error) => {
                if (this.child === child) {
                    for (const [id, pending] of [...this.pending])
                        this.finish(id, pending, error);
                    this.child = undefined;
                    this.ready = undefined;
                    this.readyReject = undefined;
                }
                settle(error);
                this.kill(child, "SIGKILL");
            };
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                if (this.child !== child)
                    return;
                this.buffer += chunk;
                let newline;
                while ((newline = this.buffer.indexOf("\n")) >= 0) {
                    const line = this.buffer.slice(0, newline).trim();
                    this.buffer = this.buffer.slice(newline + 1);
                    if (!line)
                        continue;
                    let message;
                    try {
                        message = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    if (message.event === "ready") {
                        settle();
                    }
                    else if (message.event === "status") {
                        this.lastStatus = String(message.message);
                        try {
                            this.options.onStatus?.(this.lastStatus);
                        }
                        catch {
                            // A bad status listener must not break the protocol.
                        }
                    }
                    else if (typeof message.id === "number") {
                        const pending = this.pending.get(message.id);
                        if (!pending)
                            continue;
                        if (message.ok)
                            this.finish(message.id, pending, undefined, message.result);
                        else
                            this.finish(message.id, pending, new Error(message.error ?? "worker error"));
                    }
                }
                if (this.buffer.length > maxLine) {
                    const limit = maxLine >= 1024 * 1024 ? `${Math.round(maxLine / 1024 / 1024)} MB` : `${Math.round(maxLine / 1024)} KB`;
                    fail(new Error(`The LLMLingua worker sent a response larger than ${limit}; stopping it.`));
                }
            });
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk) => {
                for (const line of chunk.split(/\r?\n|\r/)) {
                    if (!line.trim())
                        continue;
                    this.stderrTail.push(line);
                    if (this.stderrTail.length > 40)
                        this.stderrTail.shift();
                }
            });
            // Unhandled stream errors are uncaught exceptions in Bun/Node and would
            // abort the whole OpenCode process. Always attach a handler.
            child.stdin.on("error", (error) => fail(new Error(`Lost the LLMLingua worker connection (stdin): ${error.message}`)));
            child.stdout.on("error", (error) => fail(new Error(`Lost the LLMLingua worker connection (stdout): ${error.message}`)));
            child.stderr.on("error", () => undefined);
            child.on("error", (error) => {
                fail(new Error(`Could not start the LLMLingua worker with ${uv}: ${error.message}. Install uv or set the uv plugin option.`));
            });
            child.on("exit", (code, signal) => {
                const tail = this.stderrTail.slice(-8).join("\n");
                fail(new Error(`LLMLingua worker exited (${signal ?? code})${tail ? `:\n${tail}` : ""}`));
            });
        });
        return this.ready;
    }
    async call(method, params, signal) {
        if (signal?.aborted)
            throw new Error("aborted");
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        await this.start();
        const child = this.child;
        if (!child || child.exitCode !== null) {
            throw new Error("The LLMLingua worker is not running");
        }
        const id = this.nextID++;
        const timeout = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
        const result = await new Promise((resolve, reject) => {
            const pending = { resolve, reject, signal };
            if (signal) {
                // The worker cannot cancel a running compression; restart it instead.
                pending.onAbort = () => {
                    if (!this.pending.has(id))
                        return;
                    this.finish(id, pending, new Error("aborted"));
                    this.stop();
                };
                signal.addEventListener("abort", pending.onAbort, { once: true });
            }
            if (timeout > 0) {
                pending.timer = setTimeout(() => {
                    if (!this.pending.has(id))
                        return;
                    this.finish(id, pending, new Error(`LLMLingua ${method} did not finish within ${Math.round(timeout / 1000)}s; the worker was stopped. ` +
                        "Try a smaller input, a smaller model, or the cloud engine."));
                    this.stop();
                }, timeout);
                pending.timer.unref?.();
            }
            this.pending.set(id, pending);
            try {
                child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
            }
            catch (error) {
                this.finish(id, pending, error instanceof Error ? error : new Error(String(error)));
                this.stop();
            }
        });
        this.scheduleIdle();
        return result;
    }
    finish(id, pending, error, value) {
        clearTimeout(pending.timer);
        if (pending.onAbort)
            pending.signal?.removeEventListener("abort", pending.onAbort);
        if (this.pending.get(id) === pending)
            this.pending.delete(id);
        if (error)
            pending.reject(error);
        else
            pending.resolve(value);
    }
    scheduleIdle() {
        const idle = this.options.idleMs ?? 0;
        if (!idle || this.pending.size)
            return;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.stop(), idle);
        this.idleTimer.unref?.();
    }
    stop() {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        const child = this.child;
        const rejectReady = this.readyReject;
        this.child = undefined;
        this.ready = undefined;
        this.readyReject = undefined;
        this.buffer = "";
        const stopped = new Error("LLMLingua worker stopped");
        for (const [id, pending] of [...this.pending])
            this.finish(id, pending, stopped);
        rejectReady?.(stopped);
        if (child && child.exitCode === null) {
            try {
                child.stdin.end();
            }
            catch {
                // Already closed.
            }
            this.kill(child, "SIGTERM");
            const timer = setTimeout(() => this.kill(child, "SIGKILL"), KILL_GRACE_MS);
            timer.unref?.();
        }
    }
    kill(child, signal) {
        if (child.exitCode !== null || child.signalCode)
            return;
        try {
            // Negative pid targets the whole process group (uv and its Python child).
            if (process.platform !== "win32" && child.pid !== undefined)
                process.kill(-child.pid, signal);
            else
                child.kill(signal);
        }
        catch {
            // Already gone.
        }
    }
    stderr() {
        return [...this.stderrTail];
    }
}
