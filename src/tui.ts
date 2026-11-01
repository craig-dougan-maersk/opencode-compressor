import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import { Compressor } from "./rpc.js"
import {
  ENGINES,
  LLMLINGUA2_MODELS,
  LLMLINGUA_MODELS,
  PRESETS,
  decodeTokens,
  describeAmount,
  describeEngine,
  encodeTokens,
  type Engine,
  type Overrides,
  type PresetName,
  type Settings,
} from "./settings.js"
import { formatCount, formatSummary, type CompressResult, type CountResult } from "./service.js"

const PREVIEW_CHARS = 4000

interface Parsed {
  overrides: Overrides
  file?: string
  out?: string
  model?: string
  rest: string
}

/** Parse leading `--flag value` pairs; everything after them is the text (or a path). */
export function parseArgs(input: string): Parsed {
  const parsed: Parsed = { overrides: {}, rest: "" }
  let remaining = input.replace(/^\s+/, "")
  const take = (): string | undefined => {
    remaining = remaining.replace(/^\s+/, "")
    const quoted = remaining.match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/)
    if (quoted) {
      remaining = remaining.slice(quoted[0].length)
      return (quoted[1] ?? quoted[2]).replace(/\\(.)/g, "$1")
    }
    const word = remaining.match(/^\S+/)
    if (!word) return undefined
    remaining = remaining.slice(word[0].length)
    return word[0]
  }
  for (;;) {
    const flag = remaining.match(/^--([a-z-]+)(?=\s|$)/)
    if (!flag) break
    remaining = remaining.slice(flag[0].length)
    const name = flag[1]
    if (name === "no-code") parsed.overrides.keepCode = false
    else if (name === "code") parsed.overrides.keepCode = true
    else {
      const value = take()
      if (value === undefined) break
      if (name === "rate") parsed.overrides.rate = Number(value)
      else if (name === "target") parsed.overrides.targetToken = Number(value)
      else if (name === "engine") parsed.overrides.engine = value as Engine
      else if (name === "question") parsed.overrides.question = value
      else if (name === "instruction") parsed.overrides.instruction = value
      else if (name === "file") parsed.file = value
      else if (name === "out") parsed.out = value
      else if (name === "model") parsed.model = value
    }
    remaining = remaining.replace(/^[ \t]+/, "")
  }
  parsed.rest = remaining.replace(/^\s*\n/, "").trimEnd()
  return parsed
}

function expand(input: string, directory: string): string {
  let value = input.trim()
  if (value === "~") value = os.homedir()
  else if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2))
  return path.resolve(directory, value)
}

/** A single-line argument naming an existing file is treated as a path. */
function looksLikeFile(text: string, directory: string): boolean {
  const value = text.trim()
  if (!value || value.includes("\n") || value.length > 1024) return false
  try {
    return fs.statSync(expand(value.replace(/^@/, ""), directory)).isFile()
  } catch {
    return false
  }
}

function run(command: string, args: string[], input?: string): string | undefined {
  try {
    const result = spawnSync(command, args, { input, encoding: "utf8", timeout: 5000 })
    if (result.status === 0) return result.stdout ?? ""
  } catch {
    // Try the next clipboard tool.
  }
  return undefined
}

function has(command: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export function readClipboard(): string | undefined {
  if (process.platform === "darwin") return run("pbpaste", [])
  if (process.env.WAYLAND_DISPLAY && has("wl-paste")) return run("wl-paste", ["--no-newline"])
  if (has("xclip")) return run("xclip", ["-selection", "clipboard", "-o"])
  if (has("xsel")) return run("xsel", ["--clipboard", "--output"])
  if (has("powershell.exe")) {
    const value = run("powershell.exe", ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"])
    return value?.replace(/\r\n/g, "\n").replace(/\n$/, "")
  }
  return undefined
}

export function writeClipboard(text: string): boolean {
  if (process.platform === "darwin") return run("pbcopy", [], text) !== undefined
  if (process.env.WAYLAND_DISPLAY && has("wl-copy")) return run("wl-copy", [], text) !== undefined
  if (has("xclip")) return run("xclip", ["-selection", "clipboard"], text) !== undefined
  if (has("xsel")) return run("xsel", ["--clipboard", "--input"], text) !== undefined
  if (has("powershell.exe")) {
    return (
      run(
        "powershell.exe",
        ["-NoProfile", "-Command", "$t=[Console]::In.ReadToEnd(); Set-Clipboard -Value $t"],
        text,
      ) !== undefined
    )
  }
  return false
}

export default Plugin.define({
  id: "compressor.tui",
  async setup(context) {
    const client = context.client.rpc(Compressor) as any
    let last: CompressResult | undefined

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "Compressor", message, variant, duration: variant === "error" ? 8000 : 4000 })

    function currentSessionID(): string | undefined {
      try {
        const route = context.ui.router.current()
        if (route.type === "session") return route.sessionID
      } catch {
        // Router not ready.
      }
      return undefined
    }

    function location(): any {
      const sessionID = currentSessionID()
      const info = sessionID ? (context.data.session.get(sessionID) as any) : undefined
      return info?.location ?? context.location ?? context.data.location.default()
    }

    const directory = () => String(location()?.directory ?? process.cwd())
    const call = async <T = any>(method: string, input: unknown = {}): Promise<T> => {
      const result = await client[method](input, { location: location() })
      if (result && typeof result === "object" && typeof result.type === "string" && typeof result.message === "string" && !("tokens" in result) && !("compressed" in result)) {
        throw new Error(result.message)
      }
      return result as T
    }

    const unsubscribe = client.events?.on?.("status", (event: any) => {
      const message = event?.data?.message
      if (typeof message === "string") toast(message, /fail|skipped|error/i.test(message) ? "warning" : "info")
    })

    /** Ask where the input comes from. Returns {text} or {path}. */
    async function chooseInput(title: string): Promise<{ text?: string; path?: string } | undefined> {
      const choice = await context.ui.dialog.select({
        title,
        options: [
          { title: "Paste from clipboard", value: "clipboard", description: "Reads the system clipboard (multi-line safe)" },
          { title: "Read from file…", value: "file", description: "Path relative to the project, ~ supported" },
          { title: "Type or paste a single line…", value: "line" },
          ...(last ? [{ title: "Last compressed result", value: "last", description: `${last.compressedTokens} tokens` }] : []),
          {
            title: "Tip: /compress <text>",
            value: "tip",
            description: "Multi-line text can also be pasted straight after the slash command",
            disabled: true,
          },
        ],
      })
      if (!choice) return undefined
      if (choice === "clipboard") {
        const text = readClipboard()
        if (!text?.trim()) {
          toast("Clipboard is empty or no clipboard tool was found (wl-paste, xclip, xsel, pbpaste, powershell.exe)", "warning")
          return undefined
        }
        return { text }
      }
      if (choice === "file") {
        const file = await context.ui.dialog.prompt({ title: "File to read", placeholder: "./prompt.md" })
        return file?.trim() ? { path: file.trim().replace(/^@/, "") } : undefined
      }
      if (choice === "last") return { text: last!.compressed }
      const text = await context.ui.dialog.prompt({ title: "Text", placeholder: "Prompt text" })
      return text?.trim() ? { text } : undefined
    }

    function sourceFrom(parsed: Parsed): { text?: string; path?: string } | undefined {
      if (parsed.file) return { path: parsed.file }
      if (!parsed.rest.trim()) return undefined
      if (looksLikeFile(parsed.rest, directory())) return { path: parsed.rest.trim().replace(/^@/, "") }
      return { text: parsed.rest }
    }

    async function tokens(input?: string) {
      const parsed = parseArgs(input ?? "")
      const source = sourceFrom(parsed) ?? (await chooseInput("Count tokens"))
      if (!source) return
      const result = await call<CountResult>("count", { ...source, model: parsed.model })
      await context.ui.dialog.alert({ title: "Token count", message: formatCount(result) })
    }

    function preview(text: string): string {
      return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n… (${text.length - PREVIEW_CHARS} more characters)` : text
    }

    async function resultMenu(result: CompressResult) {
      for (;;) {
        const sessionID = currentSessionID()
        const action = await context.ui.dialog.select({
          title: `Compressed ${result.originalTokens} → ${result.compressedTokens} tokens (${result.ratio.toFixed(2)}×)`,
          options: [
            { title: "Show summary", value: "summary", description: result.engine },
            { title: "Show compressed text", value: "compressed" },
            { title: "Show original text", value: "original" },
            { title: "Copy compressed text to clipboard", value: "copy" },
            { title: "Write compressed text to file…", value: "write" },
            ...(sessionID
              ? [{ title: "Send compressed text to this session", value: "send", description: "Submits it as your next message" }]
              : []),
            { title: "Recompress with different settings…", value: "again" },
            { title: "Done", value: "done" },
          ],
        })
        if (!action || action === "done") return
        if (action === "summary") await context.ui.dialog.alert({ title: "Compression", message: formatSummary(result) })
        if (action === "compressed") await context.ui.dialog.alert({ title: "Compressed", message: preview(result.compressed) })
        if (action === "original") await context.ui.dialog.alert({ title: "Original", message: preview(result.original) })
        if (action === "copy") {
          if (writeClipboard(result.compressed)) toast("Compressed text copied", "success")
          else toast("No clipboard tool found (wl-copy, xclip, xsel, pbcopy, powershell.exe)", "error")
        }
        if (action === "write") {
          const file = await context.ui.dialog.prompt({
            title: "Write compressed text to",
            value: result.file ? result.file.replace(/(\.[^./]+)?$/, ".compressed$1") : "prompt.compressed.md",
          })
          if (!file?.trim()) continue
          const written = await call<{ path: string }>("writeFile", { path: file.trim(), text: result.compressed })
          toast(`Written to ${written.path}`, "success")
        }
        if (action === "send" && sessionID) {
          const confirmed = await context.ui.dialog.confirm({
            title: "Send compressed prompt",
            message: `Send ${result.compressedTokens} tokens of compressed text to this session as your next message?`,
            label: { confirm: "Send", cancel: "Cancel" },
          })
          if (!confirmed) continue
          await call("send", { sessionID, text: result.compressed })
          toast("Sent", "success")
          return
        }
        if (action === "again") {
          const rate = await context.ui.dialog.prompt({
            title: "Keep rate (0.05–1)",
            description: "Fraction of tokens to keep. 0.5 = 2×, 0.33 = 3×",
            value: String(result.amount.match(/keep (\d+)%/)?.[1] ? Number(result.amount.match(/keep (\d+)%/)![1]) / 100 : 0.5),
          })
          if (!rate?.trim() || !Number.isFinite(Number(rate))) continue
          toast("Compressing…")
          result = await call<CompressResult>("compress", { text: result.original, overrides: { rate: Number(rate) } })
          last = result
        }
      }
    }

    async function compress(input?: string) {
      const parsed = parseArgs(input ?? "")
      const source = sourceFrom(parsed) ?? (await chooseInput("Compress prompt"))
      if (!source) return
      toast("Compressing… (the first run loads the model)")
      const result = await call<CompressResult>("compress", {
        ...source,
        writeTo: parsed.out,
        overrides: parsed.overrides,
      })
      last = result
      if (result.written) toast(`Written to ${result.written}`, "success")
      await resultMenu(result)
    }

    // ---------- settings ----------

    const onOff = (value: boolean) => (value ? "on" : "off")

    async function promptNumber(title: string, current: number, description?: string): Promise<number | undefined> {
      const answer = await context.ui.dialog.prompt({ title, description, value: String(current) })
      if (answer === undefined || !answer.trim()) return undefined
      const value = Number(answer)
      if (!Number.isFinite(value)) {
        toast(`Not a number: ${answer}`, "error")
        return undefined
      }
      return value
    }

    async function promptText(title: string, current: string, description?: string): Promise<string | undefined> {
      const answer = await context.ui.dialog.prompt({ title, description, value: current })
      return answer === undefined ? undefined : answer
    }

    async function pickOne<T extends string>(title: string, current: T, values: readonly T[], describe?: (value: T) => string) {
      return context.ui.dialog.select<T>({
        title,
        current,
        options: values.map((value) => ({ title: value, value, description: describe?.(value) })),
      })
    }

    async function pickLocalModel(settings: Settings): Promise<Record<string, unknown> | undefined> {
      const two = settings.engine === "llmlingua2" || settings.engine === "cloud"
      const list = two ? LLMLINGUA2_MODELS : LLMLINGUA_MODELS
      const key = two ? "llmlingua2" : "llmlingua"
      const current = settings.models[key]
      const choice = await context.ui.dialog.select({
        title: two ? "LLMLingua-2 model" : "LLMLingua / LongLLMLingua model",
        current,
        options: [
          ...list.map((model) => ({ title: model.title, value: model.id as string, description: `${model.id} · ${model.description}` })),
          ...(list.some((model) => model.id === current) ? [] : [{ title: `Custom: ${current}`, value: current }]),
          { title: "Custom HuggingFace model ID…", value: "__custom__" },
        ],
      })
      if (!choice) return undefined
      let model = choice
      if (choice === "__custom__") {
        const answer = await context.ui.dialog.prompt({
          title: "HuggingFace model ID",
          description: two ? "A token-classification model trained for LLMLingua-2" : "A causal language model",
          value: current,
        })
        if (!answer?.trim()) return undefined
        model = answer.trim()
      }
      return { models: { [key]: model } }
    }

    async function pickCloudModel(settings: Settings): Promise<Record<string, unknown> | undefined> {
      const loc = location()
      await context.data.location.model.sync(loc).catch(() => undefined)
      const models = (context.data.location.model.list(loc) ?? []) as any[]
      if (!models.length) {
        toast("No models are available in this OpenCode session", "warning")
        return undefined
      }
      const current = settings.cloudModel ? `${settings.cloudModel.providerID}/${settings.cloudModel.id}` : undefined
      const choice = await context.ui.dialog.select({
        title: "Cloud model used for compression",
        placeholder: "Search models (cheap and fast is best, e.g. Haiku)",
        current,
        options: models
          .filter((model) => model.enabled !== false)
          .map((model) => {
            const cost = model.cost?.[0]
            const price = cost ? `$${cost.input}/M in · $${cost.output}/M out` : "price unknown"
            return {
              title: model.name ?? model.id,
              value: `${model.providerID}/${model.id}`,
              description: `${model.providerID}/${model.id} · ${price}`,
              category: model.providerID,
            }
          }),
        search: (query, options) => {
          const needle = query.trim().toLowerCase()
          if (!needle) return options
          return options.filter(
            (option) => option.title.toLowerCase().includes(needle) || (option.description ?? "").toLowerCase().includes(needle),
          )
        },
      })
      if (!choice) return undefined
      const slash = choice.indexOf("/")
      return { cloudModel: { providerID: choice.slice(0, slash), id: choice.slice(slash + 1) }, engine: "cloud" }
    }

    async function editSetting(key: string, settings: Settings): Promise<Record<string, unknown> | undefined> {
      const s = settings
      switch (key) {
        case "engine": {
          const engine = await context.ui.dialog.select<Engine>({
            title: "Compression engine",
            current: s.engine,
            options: (Object.keys(ENGINES) as Engine[]).map((value) => ({
              title: ENGINES[value].title,
              value,
              description: ENGINES[value].description,
            })),
          })
          if (!engine) return undefined
          if (engine === "cloud" && !s.cloudModel) return pickCloudModel(s)
          return { engine }
        }
        case "model":
          return pickLocalModel(s)
        case "cloudModel":
          return pickCloudModel(s)
        case "device": {
          const device = await pickOne("Device", s.device, ["auto", "cuda", "cpu", "mps"] as const, (value) =>
            value === "auto" ? "CUDA if available, then MPS, else CPU" : "",
          )
          return device ? { device } : undefined
        }
        case "preset": {
          const preset = await context.ui.dialog.select<PresetName>({
            title: "Compression preset",
            options: (Object.keys(PRESETS) as PresetName[]).map((name) => ({
              title: PRESETS[name].title,
              value: name,
              description: PRESETS[name].description,
            })),
          })
          return preset ? { amount: { mode: "rate", rate: PRESETS[preset].rate } } : undefined
        }
        case "mode": {
          const mode = await pickOne("Amount mode", s.amount.mode, ["rate", "target"] as const, (value) =>
            value === "rate" ? "Keep a fraction of tokens" : "Aim for an absolute token count",
          )
          return mode ? { amount: { mode } } : undefined
        }
        case "rate": {
          const rate = await promptNumber("Rate (fraction kept)", s.amount.rate, "0.05–1. 0.5 = 2×, 0.33 = 3×, 0.2 = 5×")
          return rate === undefined ? undefined : { amount: { mode: "rate", rate } }
        }
        case "targetToken": {
          const targetToken = await promptNumber("Target tokens", s.amount.targetToken, "Absolute token budget for the result")
          return targetToken === undefined ? undefined : { amount: { mode: "target", targetToken } }
        }
        case "forceTokens": {
          const answer = await promptText(
            "Protected tokens",
            encodeTokens(s.protect.forceTokens),
            "Comma separated. Use \\n for newline, \\t for tab, \\, for a comma",
          )
          return answer === undefined ? undefined : { protect: { forceTokens: decodeTokens(answer) } }
        }
        case "forceReserveDigit":
        case "dropConsecutive":
        case "keepCode":
          return { protect: { [key]: !(s.protect as any)[key] } }
        case "minSegmentChars": {
          const value = await promptNumber("Minimum segment length", s.protect.minSegmentChars, "Shorter text segments are left untouched (characters)")
          return value === undefined ? undefined : { protect: { minSegmentChars: value } }
        }
        case "question":
        case "instruction":
        case "contextBudget": {
          const descriptions: Record<string, string> = {
            question: "LongLLMLingua keeps content relevant to this question. Empty for none.",
            instruction: "Instruction kept verbatim and used for conditioning. Empty for none.",
            contextBudget: 'Extra budget for context-level filtering, e.g. "+100" or "*1.5"',
          }
          const answer = await promptText(key, (s.longContext as any)[key], descriptions[key])
          return answer === undefined ? undefined : { longContext: { [key]: answer } }
        }
        case "conditionInQuestion": {
          const value = await pickOne("condition_in_question", s.longContext.conditionInQuestion, ["none", "before", "after", "after_condition"] as const)
          return value ? { longContext: { conditionInQuestion: value } } : undefined
        }
        case "reorderContext": {
          const value = await pickOne("reorder_context", s.longContext.reorderContext, ["original", "sort", "two_stage"] as const)
          return value ? { longContext: { reorderContext: value } } : undefined
        }
        case "rankMethod": {
          const value = await pickOne(
            "rank_method",
            s.longContext.rankMethod,
            ["longllmlingua", "llmlingua", "bm25", "gzip", "sentbert", "openai", "bge", "jinza"] as const,
            (value) => (["sentbert", "openai", "bge", "jinza"].includes(value) ? "Needs extra packages or API keys in the worker env" : ""),
          )
          return value ? { longContext: { rankMethod: value } } : undefined
        }
        case "dynamicContextCompressionRatio": {
          const value = await promptNumber("dynamic_context_compression_ratio", s.longContext.dynamicContextCompressionRatio, "0–1; 0.3–0.4 recommended")
          return value === undefined ? undefined : { longContext: { dynamicContextCompressionRatio: value } }
        }
        case "conditionCompare":
          return { longContext: { conditionCompare: !s.longContext.conditionCompare } }
        case "useSentenceLevelFilter":
        case "useContextLevelFilter":
        case "useTokenLevelFilter":
        case "keepSplit":
          return { filters: { [key]: !(s.filters as any)[key] } }
        case "iterativeSize": {
          const value = await promptNumber("iterative_size", s.filters.iterativeSize, "Tokens per iterative compression window")
          return value === undefined ? undefined : { filters: { iterativeSize: value } }
        }
        case "countModel": {
          const answer = await promptText("Counting model", s.counting.model, "Anthropic model ID passed to count_tokens")
          return answer?.trim() ? { counting: { model: answer.trim() } } : undefined
        }
        case "vaultEntry": {
          const answer = await promptText("API key vault entry", s.counting.vaultEntry, "env-manager vault entry holding an Anthropic API key")
          return answer === undefined ? undefined : { counting: { vaultEntry: answer.trim() } }
        }
        case "fallbackInputPrice": {
          const value = await promptNumber("Fallback input price ($/M tokens)", s.counting.fallbackInputPrice, "Used when OpenCode has no price for the counting model")
          return value === undefined ? undefined : { counting: { fallbackInputPrice: value } }
        }
        case "autoEnabled":
          return { auto: { enabled: !s.auto.enabled } }
        case "autoMinTokens": {
          const value = await promptNumber("Auto-compress threshold", s.auto.minTokens, "Only prompts estimated above this many tokens are compressed")
          return value === undefined ? undefined : { auto: { minTokens: value } }
        }
      }
      return undefined
    }

    async function settingsMenu() {
      let selected: string | undefined
      for (;;) {
        const s = await call<Settings>("getSettings")
        const local = s.engine !== "cloud"
        const long = s.engine === "longllmlingua"
        const classic = s.engine === "llmlingua" || long
        const localModelID = s.engine === "llmlingua2" ? s.models.llmlingua2 : s.models.llmlingua
        type Option = { title: string; value: string; description?: string; category: string; disabled?: boolean }
        const options: Option[] = [
          { title: `Engine: ${ENGINES[s.engine].title}`, value: "engine", description: ENGINES[s.engine].description, category: "Engine" },
          ...(local
            ? [
                { title: `Local model: ${localModelID.split("/").pop()}`, value: "model", description: localModelID, category: "Engine" },
                { title: `Device: ${s.device}`, value: "device", category: "Engine" },
              ]
            : []),
          {
            title: `Cloud model: ${s.cloudModel ? `${s.cloudModel.providerID}/${s.cloudModel.id}` : "not set"}`,
            value: "cloudModel",
            description: "Pick from the models available to this OpenCode session",
            category: "Engine",
          },
          { title: "Apply preset…", value: "preset", description: "Light / Balanced / Aggressive / Extreme", category: "Amount" },
          { title: `Mode: ${s.amount.mode}`, value: "mode", description: describeAmount(s), category: "Amount" },
          { title: `Rate: ${s.amount.rate}`, value: "rate", description: `≈${(1 / s.amount.rate).toFixed(1)}× compression`, category: "Amount" },
          { title: `Target tokens: ${s.amount.targetToken}`, value: "targetToken", category: "Amount" },
          { title: `Keep code blocks verbatim: ${onOff(s.protect.keepCode)}`, value: "keepCode", category: "Protection" },
          { title: `Protected tokens: ${encodeTokens(s.protect.forceTokens) || "none"}`, value: "forceTokens", category: "Protection" },
          ...(s.engine === "llmlingua2"
            ? [
                { title: `Keep digits: ${onOff(s.protect.forceReserveDigit)}`, value: "forceReserveDigit", category: "Protection" },
                { title: `Drop consecutive protected tokens: ${onOff(s.protect.dropConsecutive)}`, value: "dropConsecutive", category: "Protection" },
              ]
            : []),
          ...(local
            ? [{ title: `Minimum segment length: ${s.protect.minSegmentChars} chars`, value: "minSegmentChars", category: "Protection" }]
            : []),
          ...(classic || s.engine === "cloud"
            ? [{ title: `Question: ${s.longContext.question || "(none)"}`, value: "question", category: "Long context" }]
            : []),
          ...(classic
            ? [{ title: `Instruction: ${s.longContext.instruction || "(none)"}`, value: "instruction", category: "Long context" }]
            : []),
          ...(long
            ? [
                { title: `condition_in_question: ${s.longContext.conditionInQuestion}`, value: "conditionInQuestion", category: "Long context" },
                { title: `reorder_context: ${s.longContext.reorderContext}`, value: "reorderContext", category: "Long context" },
                { title: `rank_method: ${s.longContext.rankMethod}`, value: "rankMethod", category: "Long context" },
                {
                  title: `dynamic_context_compression_ratio: ${s.longContext.dynamicContextCompressionRatio}`,
                  value: "dynamicContextCompressionRatio",
                  category: "Long context",
                },
                { title: `context_budget: ${s.longContext.contextBudget}`, value: "contextBudget", category: "Long context" },
                { title: `condition_compare: ${onOff(s.longContext.conditionCompare)}`, value: "conditionCompare", category: "Long context" },
              ]
            : []),
          ...(local
            ? [{ title: `Token-level filter: ${onOff(s.filters.useTokenLevelFilter)}`, value: "useTokenLevelFilter", category: "Filters" }]
            : []),
          ...(classic
            ? [
                { title: `Sentence-level filter: ${onOff(s.filters.useSentenceLevelFilter)}`, value: "useSentenceLevelFilter", category: "Filters" },
                ...(long
                  ? [{ title: `Context-level filter: ${onOff(s.filters.useContextLevelFilter)}`, value: "useContextLevelFilter", category: "Filters" }]
                  : []),
                { title: `iterative_size: ${s.filters.iterativeSize}`, value: "iterativeSize", category: "Filters" },
                { title: `keep_split: ${onOff(s.filters.keepSplit)}`, value: "keepSplit", category: "Filters" },
              ]
            : []),
          { title: `Counting model: ${s.counting.model}`, value: "countModel", category: "Token counting" },
          { title: `API key vault entry: ${s.counting.vaultEntry || "(none)"}`, value: "vaultEntry", category: "Token counting" },
          { title: `Fallback input price: $${s.counting.fallbackInputPrice}/M`, value: "fallbackInputPrice", category: "Token counting" },
          { title: `Auto-compress long prompts: ${onOff(s.auto.enabled)}`, value: "autoEnabled", category: "Automatic" },
          { title: `Auto-compress threshold: ${s.auto.minTokens} tokens`, value: "autoMinTokens", category: "Automatic" },
          { title: "Status…", value: "__status", category: "Actions" },
          { title: "Load model now (warm up)", value: "__warmup", category: "Actions" },
          { title: "Stop worker (free GPU memory)", value: "__stop", category: "Actions" },
          { title: "Reset all settings to defaults", value: "__reset", category: "Actions" },
        ]
        const choice = await context.ui.dialog.select({
          title: `Compressor — ${describeEngine(s)} · ${describeAmount(s)}`,
          placeholder: "Search settings",
          current: selected,
          options,
          search: (query, available) => {
            const needle = query.trim().toLowerCase()
            if (!needle) return available
            return available.filter(
              (option) =>
                option.title.toLowerCase().includes(needle) ||
                (option.description ?? "").toLowerCase().includes(needle) ||
                (option.category ?? "").toLowerCase().includes(needle),
            )
          },
        })
        if (!choice) return
        selected = choice
        try {
          if (choice === "__status") {
            const status = await call<any>("status")
            const lines = [
              `Engine: ${status.engine}`,
              `Amount: ${status.amount}`,
              `Worker: ${status.worker.running ? `running (pid ${status.worker.pid})` : "stopped"}`,
              ...(status.worker.lastStatus ? [`Last: ${status.worker.lastStatus}`] : []),
              `Anthropic API key: ${status.apiKey.source ?? "not found — counts are estimates"}`,
              `Auto-compress: ${status.autoCompress.enabled ? `on, ≥ ${status.autoCompress.minTokens} tokens` : "off"}`,
              ...(status.worker.stderr?.length ? ["", "Worker log:", ...status.worker.stderr] : []),
            ]
            await context.ui.dialog.alert({ title: "Compressor status", message: lines.join("\n") })
            continue
          }
          if (choice === "__warmup") {
            toast("Loading model…")
            const result = await call<any>("warmup")
            toast(result.message ?? `Loaded ${(result.loaded ?? []).join(" on ")}`, "success")
            continue
          }
          if (choice === "__stop") {
            await call("stopWorker")
            toast("Worker stopped", "success")
            continue
          }
          if (choice === "__reset") {
            const confirmed = await context.ui.dialog.confirm({
              title: "Reset settings",
              message: "Reset every compressor setting to its default?",
              label: { confirm: "Reset", cancel: "Cancel" },
            })
            if (confirmed) {
              await call("resetSettings")
              toast("Settings reset", "success")
            }
            continue
          }
          const patch = await editSetting(choice, s)
          if (patch) await call("setSettings", { patch })
        } catch (error) {
          toast(errorMessage(error), "error")
        }
      }
    }

    const guard = (fn: (input?: string) => Promise<void>) => async (input?: string) => {
      try {
        await fn(input)
      } catch (error) {
        toast(errorMessage(error), "error")
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "compressor.tokens",
          title: "Count prompt tokens",
          description: "Count tokens with Anthropic's count_tokens API (text, clipboard or file)",
          group: "Compressor",
          palette: true,
          slash: { name: "tokens", aliases: ["count-tokens"], arguments: true },
          run: guard(tokens),
        },
        {
          id: "compressor.compress",
          title: "Compress prompt",
          description: "Compress text, clipboard or a file with LLMLingua or a cloud model",
          group: "Compressor",
          palette: true,
          slash: { name: "compress", arguments: true },
          run: guard(compress),
        },
        {
          id: "compressor.settings",
          title: "Compressor settings",
          description: "Engine, model, rate, protection and long-context options",
          group: "Compressor",
          palette: true,
          slash: { name: "compress-settings", aliases: ["compressor"] },
          run: guard(settingsMenu),
        },
      ],
    }))

    return () => {
      if (typeof unsubscribe === "function") unsubscribe()
    }
  },
})

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as any).message)
  return String(error)
}
