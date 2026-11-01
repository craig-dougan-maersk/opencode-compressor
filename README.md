# opencode-compressor

An OpenCode plugin that counts prompt tokens with Anthropic's free
`count_tokens` endpoint and compresses prompts with Microsoft's
[LLMLingua](https://github.com/microsoft/LLMLingua) — or with a cloud model from
your own OpenCode session.

Nothing is sent anywhere except to the endpoint you choose: token counting goes
to Anthropic, local compression stays on your machine.

## Features

- **Token counting** for pasted text, the clipboard or a file, using the exact
  tokenizer Anthropic bills with. Falls back to a clearly-labelled estimate when
  no API key is available.
- **Compression** with three local LLMLingua variants (LLMLingua-2,
  LLMLingua, LongLLMLingua) or a cloud model, with the original and compressed
  counts, achieved ratio and a dollar saving per send.
- **Full control** over compression: rate or absolute token target, protected
  tokens, digit handling, filters, and every LongLLMLingua long-context
  parameter.
- **Code is safe**: fenced code blocks are kept verbatim and never compressed.
- **Optional auto-compression** of long prompts before they are sent (off by
  default).
- Model loaded once and kept warm; the worker is stopped after 30 minutes idle
  to free GPU memory.

## Install

The local engines need Python with `uv`. The plugin builds the environment on
first use.

```sh
git clone git@github.com:craig-dougan-maersk/opencode-compressor.git
cd opencode-compressor
npm install
npm run compile
```

Then load it from `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/you/projects/opencode-compressor",
      "options": {}
    }
  ]
}
```

If `uv` is not on `PATH`, pass `"uv": "/path/to/uv"`. Other options:

| Option | Default | Meaning |
| --- | --- | --- |
| `uv` | auto-detected | Path to the `uv` binary |
| `pythonDir` | bundled `python/` | Directory holding `pyproject.toml` and `worker.py` |
| `env` | `{}` | Extra environment for the worker, e.g. `HF_TOKEN`, `HF_HOME`, `CUDA_VISIBLE_DEVICES` |
| `idleMinutes` | `30` | Stop the worker after this many idle minutes (0 keeps it running) |
| `apiKey` | — | Anthropic API key, if you would rather not use the other sources |
| `countTokensURL` | `https://api.anthropic.com/v1/messages/count_tokens` | Override for a proxy |

### Anthropic API key

Resolution order, first usable key wins:

1. the `apiKey` plugin option
2. `ANTHROPIC_API_KEY`
3. OpenCode's `anthropic` connection, when it holds an API key
4. the env-manager vault entry in settings (default `anthropic/api-key`)

A subscription (OAuth) login cannot call `count_tokens`, and placeholder keys
such as `dummy` are skipped. Without a key, counting returns `[estimated]`.

## Use

### Slash commands

```
/tokens                     # choose clipboard, file or a single line
/tokens ./prompt.md         # count a file
/tokens --model claude-opus-4-1 some text

/compress                   # choose clipboard, file or a single line
/compress --rate 0.3 ./prompt.md
/compress --target 800 --no-code <text>
/compress --file ./doc.md --question "What is the refund policy?" --out ./doc.compressed.md

/compress-settings          # the full settings menu
```

Multi-line prompts can be pasted straight after the slash command. Flags must
come first:

| Flag | Meaning |
| --- | --- |
| `--rate N` | Fraction of tokens to keep (0.05–1); 0.5 = 2× |
| `--target N` | Absolute token budget |
| `--engine E` | `llmlingua2`, `llmlingua`, `longllmlingua`, `cloud` |
| `--file P` | Read the prompt from a file |
| `--out P` | Write the compressed text to a file |
| `--question Q` | LongLLMLingua question to keep content relevant to |
| `--instruction I` | Instruction kept verbatim |
| `--no-code` / `--code` | Keep (default) or compress fenced code blocks |
| `--model M` | Anthropic model for counting |

The result menu shows the summary, either text, copying to the clipboard,
writing to a file, recompressing at another rate, and sending the compressed
text into the current session as your next message.

### Agent tools

- `compressor_count` — token count for text or a file.
- `compressor_compress` — compressed text plus counts and savings. Optional
  `writeTo` writes the result to disk.

File reads and writes go through OpenCode's permission system.

## Settings

`/compress-settings` edits everything and persists it with OpenCode. Changes
that need a different model or device restart the worker automatically.

**Engine**
- *Local · LLMLingua-2* (default) — a token classifier; fast and
  task-agnostic. Default model
  `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank`;
  `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` is higher quality, or
  enter any HuggingFace model ID.
- *Local · LLMLingua* — perplexity-based with a small causal LM (`phi-2` by
  default, or `gpt2`, Llama-2 7B and others).
- *Local · LongLLMLingua* — question-aware and paragraph-ranked; best for long
  documents. Unlocks the long-context parameters.
- *Cloud model* — asks a model from your session to compress the text. Pick any
  model; a cheap fast one (Haiku-class) is the economical choice. Costs tokens,
  so the result reports the *net* saving.

**Amount**
- Mode: `rate` (fraction kept) or `target` (absolute tokens).
- Presets: Light 0.7 (≈1.4×), Balanced 0.5 (2×), Aggressive 0.33 (3×,
  LLMLingua-2's paper default), Extreme 0.2 (5×).

**Protection**
- `forceTokens` — tokens never removed. Defaults `\n ? ! .`. Type `\n` for a
  newline, `\t` for a tab, `\,` for a comma.
- `forceReserveDigit` — never drop digits (LLMLingua-2).
- `dropConsecutive` — collapse runs of protected tokens.
- `keepCode` — leave fenced code blocks alone.
- `minSegmentChars` — segments shorter than this are left untouched.

**Long context** (LongLLMLingua and, where supported, LLMLingua and cloud)
- `question`, `instruction`
- `conditionInQuestion` — `none`, `before`, `after`, `after_condition`
- `reorderContext` — `original`, `sort`, `two_stage`
- `rankMethod` — `longllmlingua` (default), `llmlingua`, `bm25`, `gzip`, or
  `sentbert`/`openai`/`bge`/`jinza` (need extra packages or keys in the worker)
- `dynamicContextCompressionRatio`, `contextBudget`, `conditionCompare`

**Filters** — sentence, context and token-level filters, `iterativeSize`,
`keepSplit`.

**Token counting** — the Anthropic model ID used for counts, the env-manager
vault entry for the key, and a fallback price per million input tokens used for
savings when OpenCode has no price for that model.

**Automatic** — `auto-compress long prompts` with a token threshold. Prompts
with file or agent mentions are skipped, because rewriting text would invalidate
mention offsets. Text the plugin sends itself is never recompressed.

### `<llmlingua>` tags

If the prompt contains `<llmlingua …>` tags, it is passed to LLMLingua's
structured compression, so individual sections can set their own rate or opt out
(`<llmlingua, compress=False>`).

## Which engine should I use?

| Situation | Use |
| --- | --- |
| Everyday prompts, fast turnaround | LLMLingua-2 (bert-base) |
| Long documents and a specific question | LongLLMLingua with a `question` |
| Want the best quality, have a GPU | LLMLingua-2 xlm-roberta-large |
| No GPU, or out-of-domain text | LLMLingua-2 CPU, or a cloud model |
| Need the prompt to read naturally after compression | Cloud model |

Expect less saving than the ratio suggests when a prompt is mostly code,
numbers or identifiers: those are protected on purpose.

Measured on this machine (RTX 4050, LLMLingua-2 bert-base, rate 0.5): a 102-token
prompt with one code block compressed to 70 tokens in 0.4 s. The block and the
digits survived; the saving came entirely from the prose.

## Honest limits

- Compressed prompts occasionally drop a nuance. Verify important ones, or use
  a gentler rate.
- The cloud engine costs tokens of its own; it is only worth it on long inputs
  with a cheap model.
- Token counts are Anthropic's. Other providers tokenize differently, so treat
  counts as a close guide, not gospel.
- Local engines are CPU-capable but slow on large prompts; LLMLingua (causal LM)
  needs several GB of RAM.

## Development

```sh
npm run compile     # tsc to dist/
npm run typecheck
npm test            # unit + fake-context plugin tests
SKIP_WORKER=1 npm test   # skip the real model load
cd python && uv run python worker.py   # talk to the worker directly over stdin
```

The worker protocol is one JSON object per line in each direction:

```json
{"id":1,"method":"compress","params":{"text":"…","model":"…","llmlingua2":true,"options":{"rate":0.5}}}
```

## Licence

MIT
