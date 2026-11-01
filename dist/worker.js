import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const PYTHON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "python");
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
 */
export class Worker {
    options;
    child;
    ready;
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
        if (this.ready && this.running)
            return this.ready;
        const pythonDir = this.options.pythonDir ?? PYTHON_DIR;
        const uv = findUv(this.options.uv);
        this.stderrTail = [];
        this.buffer = "";
        this.ready = new Promise((resolve, reject) => {
            let settled = false;
            const child = spawn(uv, ["run", "--quiet", "--project", pythonDir, "python", path.join(pythonDir, "worker.py")], {
                cwd: pythonDir,
                env: { ...process.env, PYTHONUNBUFFERED: "1", ...this.options.env },
                stdio: ["pipe", "pipe", "pipe"],
            });
            this.child = child;
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
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
                        settled = true;
                        resolve();
                    }
                    else if (message.event === "status") {
                        this.lastStatus = String(message.message);
                        this.options.onStatus?.(this.lastStatus);
                    }
                    else if (typeof message.id === "number") {
                        const pending = this.pending.get(message.id);
                        if (!pending)
                            continue;
                        this.pending.delete(message.id);
                        if (pending.onAbort)
                            pending.signal?.removeEventListener("abort", pending.onAbort);
                        if (message.ok)
                            pending.resolve(message.result);
                        else
                            pending.reject(new Error(message.error ?? "worker error"));
                    }
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
            const fail = (error) => {
                if (this.child === child) {
                    for (const pending of this.pending.values())
                        pending.reject(error);
                    this.pending.clear();
                    this.child = undefined;
                    this.ready = undefined;
                }
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            };
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
        await this.start();
        const id = this.nextID++;
        const result = await new Promise((resolve, reject) => {
            const pending = { resolve, reject, signal };
            if (signal) {
                // The worker cannot cancel a running compression; restart it instead.
                pending.onAbort = () => {
                    this.pending.delete(id);
                    reject(new Error("aborted"));
                    this.stop();
                };
                signal.addEventListener("abort", pending.onAbort, { once: true });
            }
            this.pending.set(id, pending);
            this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        });
        this.scheduleIdle();
        return result;
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
        const child = this.child;
        this.child = undefined;
        this.ready = undefined;
        for (const pending of this.pending.values())
            pending.reject(new Error("LLMLingua worker stopped"));
        this.pending.clear();
        if (child && child.exitCode === null) {
            child.stdin.end();
            child.kill("SIGTERM");
            const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
            timer.unref?.();
        }
    }
    stderr() {
        return [...this.stderrTail];
    }
}
