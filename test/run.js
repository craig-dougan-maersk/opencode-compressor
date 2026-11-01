import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createCounter, estimateTokens, plausibleKey } from "../dist/anthropic.js"
import { cleanCloudOutput, cloudPrompt, protectCode, restoreCode } from "../dist/cloud.js"
import {
  applyOverrides,
  decodeTokens,
  defaultSettings,
  encodeTokens,
  llmlinguaKwargs,
  normalizeSettings,
} from "../dist/settings.js"
import { parseArgs } from "../dist/tui.js"

// ---------- settings ----------
const defaults = defaultSettings()
assert.equal(defaults.engine, "llmlingua2")
assert.match(defaults.models.llmlingua2, /bert-base-multilingual/)
assert.equal(normalizeSettings({ amount: { rate: 7 } }).amount.rate, 1)
assert.equal(normalizeSettings({ engine: "bogus" }).engine, "llmlingua2")
assert.deepEqual(decodeTokens(encodeTokens(["\n", "?", ","])), ["\n", "?", ","])
assert.deepEqual(decodeTokens("\\n, ?, !"), ["\n", "?", "!"])
const overridden = applyOverrides(defaults, { targetToken: 120, engine: "longllmlingua" })
assert.equal(overridden.amount.mode, "target")
const longKwargs = llmlinguaKwargs(overridden)
assert.equal(longKwargs.target_token, 120)
assert.equal(longKwargs.rank_method, "longllmlingua")
assert.equal(llmlinguaKwargs(defaults).rate, 0.5)
assert.ok(!("rank_method" in llmlinguaKwargs(defaults)))

// ---------- slash argument parsing ----------
let parsed = parseArgs('--rate 0.3 --question "what is x?" hello\nworld')
assert.equal(parsed.overrides.rate, 0.3)
assert.equal(parsed.overrides.question, "what is x?")
assert.equal(parsed.rest, "hello\nworld")
parsed = parseArgs("--no-code --out out.md --file ./a.md")
assert.equal(parsed.overrides.keepCode, false)
assert.equal(parsed.out, "out.md")
assert.equal(parsed.file, "./a.md")
assert.equal(parseArgs("plain --rate text").rest, "plain --rate text")

// ---------- cloud helpers ----------
const shielded = protectCode("before\n```js\nx()\n```\nafter")
assert.equal(shielded.blocks.length, 1)
assert.ok(shielded.text.includes("⟦CODE1⟧"))
assert.equal(restoreCode(shielded.text, shielded.blocks).text, "before\n```js\nx()\n```\nafter")
assert.equal(restoreCode("lost it", shielded.blocks).missing, 1)
assert.ok(cloudPrompt("hi", defaults, 100).includes("about 50 tokens"))
assert.equal(cleanCloudOutput("```\nshort\n```"), "short")

// ---------- counter ----------
assert.equal(plausibleKey("dummy"), false)
assert.equal(plausibleKey("sk-ant-api03-aaaaaaaaaaaaaaaaaaaa"), true)
assert.ok(estimateTokens("hello world, this is a test") > 3)
let calls = 0
const counter = createCounter({
  resolveKey: async () => ({ key: "sk-ant-test-xxxxxxxxxxxxxxxxxxxx", source: "test" }),
  fetchImpl: async (_url, init) => {
    calls++
    const body = JSON.parse(init.body)
    assert.equal(init.headers["x-api-key"], "sk-ant-test-xxxxxxxxxxxxxxxxxxxx")
    return new Response(JSON.stringify({ input_tokens: body.messages[0].content.length }), { status: 200 })
  },
})
assert.deepEqual(await counter.count("abcdef", "claude-x"), { tokens: 6, source: "anthropic", model: "claude-x" })
await counter.count("abcdef", "claude-x")
assert.equal(calls, 1, "identical counts are cached")
const failing = createCounter({ resolveKey: async () => undefined })
const fallback = await failing.count("some text here", "claude-x")
assert.equal(fallback.source, "estimate")
assert.match(fallback.error, /No Anthropic API key/)

// ---------- server plugin with a fake context ----------
const root = await fs.mkdtemp(path.join(os.tmpdir(), "compressor-test-"))
const store = new Map()
let handlers
let tools = []
let promptHook
const fakeContext = {
  location: { directory: root },
  options: {},
  storage: {
    get: async (key) => store.get(key),
    set: async (key, value) => store.set(key, value),
    remove: async (key) => store.delete(key),
  },
  rpc: Object.assign(
    () => ({ vaultGet: async () => ({ values: {} }) }),
    {
      register: async (_definition, value) => {
        handlers = value
        return { events: { emit: async () => undefined }, dispose: async () => undefined }
      },
    },
  ),
  integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
  model: { list: async () => [{ providerID: "anthropic", id: "claude-sonnet-4-5", cost: [{ input: 3, output: 15 }] }] },
  experimental: { generate: { text: async ({ prompt }) => ({ text: prompt.split("<prompt>\n")[1].split("\n</prompt>")[0].slice(0, 20) }) } },
  permission: { assert: async () => undefined },
  session: {
    prompt: async () => undefined,
    hook: async (_name, callback) => {
      promptHook = callback
      return { dispose: async () => undefined }
    },
  },
  tool: {
    transform: async (callback) => {
      callback({ namespace: () => undefined, add: (tool) => tools.push(tool) })
      return { dispose: async () => undefined }
    },
  },
}
const saved = process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_API_KEY
const plugin = (await import("../dist/index.js")).default
const cleanup = await plugin.setup(fakeContext)
assert.deepEqual(tools.map((tool) => tool.name).sort(), ["compress", "count"])
assert.ok(promptHook, "prompt hook registered")

const settings = await handlers.setSettings({ patch: { amount: { rate: 0.4 }, engine: "cloud", cloudModel: { providerID: "anthropic", id: "claude-sonnet-4-5" } } })
assert.equal(settings.amount.rate, 0.4)
assert.equal((await handlers.getSettings()).engine, "cloud")

const file = path.join(root, "prompt.md")
await fs.writeFile(file, "Please could you kindly summarise the following long document for me in detail.")
const counted = await handlers.count({ path: "prompt.md" })
assert.equal(counted.source, "estimate")
assert.equal(counted.file, file)

const cloud = await handlers.compress({ path: "prompt.md", writeTo: "out/compressed.md" })
assert.equal(cloud.compressed.length <= 20, true)
assert.ok(cloud.compressionCost, "cloud compression reports its own cost")
assert.equal(await fs.readFile(path.join(root, "out/compressed.md"), "utf8"), cloud.compressed)

// Auto-compress is off by default; the hook must leave the prompt alone.
const event = { prompt: { text: "x ".repeat(10000) } }
await promptHook(event)
assert.equal(event.prompt.text, "x ".repeat(10000))

await handlers.resetSettings()
assert.equal((await handlers.getSettings()).engine, "llmlingua2")

// ---------- real LLMLingua worker (skip with SKIP_WORKER=1) ----------
if (process.env.SKIP_WORKER !== "1") {
  const text =
    "Hello there. I would really like you to please go ahead and carefully review the following function and then tell me " +
    "whether or not there are any bugs in it, and if there are, please explain them to me in detail so that I can fix them.\n\n" +
    "```js\nfunction add(a, b) { return a - b }\n```\n\nThanks so much for all of your help with this, it is really appreciated!"
  const local = await handlers.compress({ text })
  assert.ok(local.compressedTokens < local.originalTokens, "local compression shrinks the prompt")
  assert.ok(local.compressed.includes("function add(a, b) { return a - b }"), "code block kept verbatim")
  console.log(`worker: ${local.originalTokens} → ${local.compressedTokens} tokens on ${local.device} in ${local.seconds}s`)
}

await cleanup()
if (saved) process.env.ANTHROPIC_API_KEY = saved
await fs.rm(root, { recursive: true, force: true })
console.log("all compressor tests passed")
