import fs from "node:fs/promises"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { createCounter, estimateTokens, plausibleKey, type ApiKey } from "./anthropic.js"
import { vaultValue } from "./env-manager.js"
import { Compressor } from "./rpc.js"
import {
  createService,
  expandPath,
  formatCount,
  formatSummary,
  type PriceInfo,
} from "./service.js"
import { defaultSettings, describeAmount, describeEngine, normalizeSettings, type ModelRef, type Overrides, type Settings } from "./settings.js"
import { Worker } from "./worker.js"

const SETTINGS_KEY = "settings"

export default Plugin.define({
  id: "compressor",
  async setup(ctx) {
    const directory = path.resolve(ctx.location.directory)
    const options: Record<string, any> = (ctx.options as any) ?? {}
    let registration: any
    let keySource: string | undefined
    /** Texts sent by the plugin itself, so the auto-compress hook does not compress them again. */
    const ownSends = new Set<string>()

    const emit = (name: string, data: Record<string, unknown>) => {
      void registration?.events.emit(name, data).catch(() => undefined)
    }

    const worker = new Worker({
      uv: typeof options.uv === "string" ? options.uv : undefined,
      pythonDir: typeof options.pythonDir === "string" ? expandPath(options.pythonDir, directory) : undefined,
      env: options.env && typeof options.env === "object" ? options.env : undefined,
      idleMs: typeof options.idleMinutes === "number" ? options.idleMinutes * 60_000 : 30 * 60_000,
      onStatus: (message) => emit("status", { message }),
    })

    async function loadSettings(): Promise<Settings> {
      try {
        return normalizeSettings(await ctx.storage.get(SETTINGS_KEY))
      } catch {
        return defaultSettings()
      }
    }

    async function saveSettings(settings: Settings): Promise<void> {
      await ctx.storage.set(SETTINGS_KEY, JSON.parse(JSON.stringify(settings)))
      emit("settings", settings as any)
    }

    /** Key order: plugin option, ANTHROPIC_API_KEY, OpenCode's Anthropic connection, env-manager vault. */
    async function resolveKey(): Promise<ApiKey | undefined> {
      if (plausibleKey(options.apiKey)) return found(options.apiKey, "plugin option")
      if (plausibleKey(process.env.ANTHROPIC_API_KEY)) return found(process.env.ANTHROPIC_API_KEY!, "ANTHROPIC_API_KEY")
      try {
        const connection = await ctx.integration.connection.active("anthropic")
        const credential: any = connection ? await ctx.integration.connection.resolve(connection) : undefined
        if (credential?.type === "key" && plausibleKey(credential.key)) return found(credential.key, "OpenCode anthropic connection")
      } catch {
        // No connection or no access; try the next source.
      }
      const settings = await loadSettings()
      const fromVault = await vaultValue((definition) => (ctx.rpc as any)(definition), directory, settings.counting.vaultEntry)
      if (plausibleKey(fromVault)) return found(fromVault, `env-manager vault (${settings.counting.vaultEntry})`)
      keySource = undefined
      return undefined
    }

    function found(key: string, source: string): ApiKey {
      keySource = source
      return { key: key.trim(), source }
    }

    async function price(model: ModelRef): Promise<PriceInfo | undefined> {
      const models: any = await ctx.model.list()
      const list: any[] = Array.isArray(models) ? models : (models?.data ?? models?.models ?? [])
      const match =
        list.find((item) => item.providerID === model.providerID && item.id === model.id) ??
        list.find((item) => item.providerID === model.providerID && String(item.id).startsWith(model.id))
      const cost = match?.cost?.[0]
      if (!cost || typeof cost.input !== "number") return undefined
      return { input: cost.input, output: typeof cost.output === "number" ? cost.output : cost.input }
    }

    const counter = createCounter({
      resolveKey,
      baseURL: typeof options.countTokensURL === "string" ? options.countTokensURL : undefined,
    })

    const service = createService({
      directory,
      counter,
      worker,
      loadSettings,
      saveSettings,
      price,
      generateText: async ({ prompt, model }) => {
        const result: any = await ctx.experimental.generate.text({ prompt, model })
        return { text: String(result?.text ?? result?.data?.text ?? "") }
      },
    })

    async function status() {
      const settings = await loadSettings()
      const key = await resolveKey().catch(() => undefined)
      return jsonSafe({
        directory,
        engine: describeEngine(settings),
        amount: describeAmount(settings),
        worker: { running: worker.running, pid: worker.pid, lastStatus: worker.lastStatus, stderr: worker.stderr().slice(-6) },
        apiKey: key ? { source: keySource } : { source: null },
        autoCompress: settings.auto,
        settings,
      })
    }

    const handlers = {
      count: async (input: any, context: any) => jsonSafe(await service.count(input ?? {}, context?.signal)),
      compress: async (input: any, context: any) => jsonSafe(await service.compress(input ?? {}, context?.signal)),
      getSettings: async () => loadSettings(),
      setSettings: async (input: any) => service.updateSettings(input?.patch ?? {}),
      resetSettings: async () => {
        const next = defaultSettings()
        await saveSettings(next)
        worker.stop()
        return next
      },
      status: async () => status(),
      stopWorker: async () => {
        worker.stop()
        return status()
      },
      warmup: async () => {
        const settings = await loadSettings()
        if (settings.engine === "cloud") return { ok: true, message: "Cloud engine needs no warmup" }
        const result = await worker.call("load", {
          model: settings.engine === "llmlingua2" ? settings.models.llmlingua2 : settings.models.llmlingua,
          llmlingua2: settings.engine === "llmlingua2",
          device: settings.device,
        })
        return { ok: true, loaded: result?.loaded ?? null }
      },
      send: async (input: any) => {
        const text = String(input?.text ?? "")
        if (!text.trim()) throw new Error("Nothing to send")
        ownSends.add(text)
        setTimeout(() => ownSends.delete(text), 60_000).unref?.()
        await ctx.session.prompt({ sessionID: input.sessionID, text } as any)
        return { ok: true }
      },
      writeFile: async (input: any) => {
        const file = expandPath(String(input?.path ?? ""), directory)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, String(input?.text ?? ""), "utf8")
        return { ok: true, path: file }
      },
    }

    registration = await ctx.rpc.register(Compressor, handlers as any)

    const source = (context: any) => ({ type: "tool", messageID: context.messageID, id: context.id })

    async function assertAccess(context: any, action: "read" | "edit", file: string) {
      await ctx.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        source: source(context),
        action,
        resources: [file],
        save: [file],
      } as any)
    }

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "compressor",
        description:
          "Count prompt tokens with Anthropic's count_tokens API and compress prompts with LLMLingua or a cloud model.",
      })
      editor.add({
        name: "count",
        description:
          "Count the tokens a text or file costs as Claude input, using Anthropic's free count_tokens endpoint. Falls back to an estimate when no API key is available.",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to count" },
            path: { type: "string", description: "File to count instead of text" },
            model: { type: "string", description: "Anthropic model ID; defaults to the configured counting model" },
          },
          additionalProperties: false,
        },
        options: { namespace: "compressor", codemode: true },
        execute: async (input: any, context: any) => {
          if (input?.path) await assertAccess(context, "read", expandPath(input.path, directory))
          const result = await service.count(input ?? {}, context.signal)
          return { content: formatCount(result) }
        },
      } as any)
      editor.add({
        name: "compress",
        description:
          "Compress a prompt (text or file) with Microsoft LLMLingua (local) or a cloud model, report original/compressed token counts and savings, and return the compressed text. Fenced code blocks are kept verbatim by default.",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "Prompt text to compress" },
            path: { type: "string", description: "File to compress instead of text" },
            writeTo: { type: "string", description: "Optional file to write the compressed text to" },
            engine: { type: "string", enum: ["llmlingua2", "llmlingua", "longllmlingua", "cloud"] },
            rate: { type: "number", description: "Fraction of tokens to keep, 0.05-1 (0.5 = 2x)" },
            targetToken: { type: "number", description: "Absolute token target instead of rate" },
            question: { type: "string", description: "LongLLMLingua: question to keep relevant content for" },
            keepCode: { type: "boolean", description: "Keep fenced code blocks verbatim" },
          },
          additionalProperties: false,
        },
        options: { namespace: "compressor", codemode: true },
        execute: async (input: any, context: any) => {
          if (input?.path) await assertAccess(context, "read", expandPath(input.path, directory))
          if (input?.writeTo) await assertAccess(context, "edit", expandPath(input.writeTo, directory))
          await context.progress?.({ status: "compressing" })
          const overrides: Overrides = {}
          for (const key of ["engine", "rate", "targetToken", "question", "keepCode"] as const) {
            if (input?.[key] !== undefined) (overrides as any)[key] = input[key]
          }
          const result = await service.compress(
            { text: input?.text, path: input?.path, writeTo: input?.writeTo, overrides },
            context.signal,
          )
          return { content: `${formatSummary(result)}\n\n<compressed>\n${result.compressed}\n</compressed>` }
        },
      } as any)
    })

    // Optional automatic compression of long user prompts.
    const promptHook = await ctx.session.hook("prompt", async (event: any) => {
      const text: string = event?.prompt?.text ?? ""
      if (!text || ownSends.has(text)) return
      const settings = await loadSettings()
      if (!settings.auto.enabled) return
      if (estimateTokens(text) < settings.auto.minTokens) return
      // Rewriting text would invalidate mention offsets; leave such prompts alone.
      const mentions = [...(event.prompt.files ?? []), ...(event.prompt.agents ?? [])].some((item: any) => item?.mention)
      if (mentions) return
      try {
        const result = await service.compress({ text })
        if (result.compressedTokens > 0 && result.compressedTokens < result.originalTokens) {
          event.prompt.text = result.compressed
          event.metadata = {
            ...event.metadata,
            compressor: {
              originalTokens: result.originalTokens,
              compressedTokens: result.compressedTokens,
              engine: result.engine,
            },
          }
          emit("status", {
            message: `Auto-compressed prompt ${result.originalTokens} → ${result.compressedTokens} tokens (${result.ratio.toFixed(1)}×)`,
          })
        }
      } catch (error) {
        emit("status", { message: `Auto-compress skipped: ${error instanceof Error ? error.message : String(error)}` })
      }
    })

    return () => {
      worker.stop()
      void promptHook.dispose()
      void toolRegistration.dispose()
      void registration?.dispose()
    }
  },
})

/** RPC outputs must be JSON; drop undefined object fields recursively. */
function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item)) as T
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) output[key] = jsonSafe(item)
    }
    return output as T
  }
  return value
}
