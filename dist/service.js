import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { estimateTokens } from "./anthropic.js";
import { cleanCloudOutput, cloudPrompt, protectCode, restoreCode } from "./cloud.js";
import { applyOverrides, describeAmount, describeEngine, llmlinguaKwargs, localModel, normalizeSettings, } from "./settings.js";
export const MAX_INPUT_BYTES = 4 * 1024 * 1024;
/**
 * LLMLingua keeps tokenizer output and model activations for the whole prompt
 * in memory. A multi-megabyte prompt can push the machine into the OOM killer,
 * which may pick the OpenCode process; refuse it with an actionable message.
 */
export const MAX_LOCAL_BYTES = 1024 * 1024;
export function expandPath(input, directory) {
    let value = input.trim();
    if (value === "~")
        value = os.homedir();
    else if (value.startsWith("~/"))
        value = path.join(os.homedir(), value.slice(2));
    return path.resolve(directory, value);
}
export function createService(deps) {
    async function readSource(source) {
        if (typeof source.path === "string" && source.path.trim()) {
            const file = expandPath(source.path, deps.directory);
            const stat = await fs.stat(file).catch(() => undefined);
            if (!stat?.isFile())
                throw new Error(`File not found: ${file}`);
            if (stat.size > MAX_INPUT_BYTES)
                throw new Error(`File is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB: ${file}`);
            return { text: await fs.readFile(file, "utf8"), file };
        }
        if (typeof source.text === "string" && source.text.length) {
            if (Buffer.byteLength(source.text) > MAX_INPUT_BYTES)
                throw new Error("Text is larger than 4 MB");
            return { text: source.text };
        }
        throw new Error("Provide text or a file path");
    }
    async function inputPrice(settings) {
        const known = await deps.price({ providerID: "anthropic", id: settings.counting.model }).catch(() => undefined);
        return known?.input ?? settings.counting.fallbackInputPrice;
    }
    async function count(source, signal) {
        const settings = await deps.loadSettings();
        const { text, file } = await readSource(source);
        const model = source.model?.trim() || settings.counting.model;
        const result = await deps.counter.count(text, model, signal);
        const price = await inputPrice({ ...settings, counting: { ...settings.counting, model } });
        return {
            tokens: result.tokens,
            source: result.source,
            model,
            characters: text.length,
            inputPricePerMillion: price,
            costUSD: (result.tokens * price) / 1_000_000,
            file,
            error: result.error,
        };
    }
    async function compressLocal(text, settings, signal) {
        const bytes = Buffer.byteLength(text);
        if (bytes > MAX_LOCAL_BYTES) {
            throw new Error(`Text is ${(bytes / 1024).toFixed(0)} KB; local compression is limited to ${MAX_LOCAL_BYTES / 1024} KB ` +
                "to keep OpenCode's memory use safe. Split the input, or use the cloud engine.");
        }
        const result = await deps.worker.call("compress", {
            text,
            model: localModel(settings),
            llmlingua2: settings.engine === "llmlingua2",
            device: settings.device,
            keepCode: settings.protect.keepCode,
            minSegmentChars: settings.protect.minSegmentChars,
            splitContexts: settings.engine === "longllmlingua",
            options: llmlinguaKwargs(settings),
        }, signal);
        return {
            compressed: String(result.compressed ?? ""),
            model: String(result.model ?? localModel(settings)),
            device: result.device ? String(result.device) : undefined,
            seconds: Number(result.seconds ?? 0),
            warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
            ignored: Array.isArray(result.ignored) ? result.ignored.map(String) : [],
        };
    }
    async function compressCloud(text, settings, originalTokens, signal) {
        const model = settings.cloudModel;
        if (!model)
            throw new Error("No cloud model selected. Choose one in /compress-settings → Cloud model.");
        const started = Date.now();
        const shielded = settings.protect.keepCode ? protectCode(text) : { text, blocks: [] };
        const prompt = cloudPrompt(shielded.text, settings, originalTokens);
        if (signal?.aborted)
            throw new Error("aborted");
        const response = await deps.generateText({ prompt, model });
        const restored = restoreCode(cleanCloudOutput(response.text ?? ""), shielded.blocks);
        const warnings = [];
        if (restored.missing)
            warnings.push(`${restored.missing} code block(s) were dropped by the model and re-appended`);
        const price = await deps.price(model).catch(() => undefined);
        const inputTokens = estimateTokens(prompt);
        const outputTokens = estimateTokens(response.text ?? "");
        const usd = price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : 0;
        if (!price)
            warnings.push(`No price known for ${model.providerID}/${model.id}; compression cost shown as $0`);
        return {
            compressed: restored.text,
            model: `${model.providerID}/${model.id}`,
            device: undefined,
            seconds: (Date.now() - started) / 1000,
            warnings,
            ignored: [],
            cost: { inputTokens, outputTokens, usd, model: `${model.providerID}/${model.id}` },
        };
    }
    async function compress(source, signal) {
        const settings = applyOverrides(await deps.loadSettings(), source.overrides);
        const { text, file } = await readSource(source);
        const countModel = settings.counting.model;
        const before = await deps.counter.count(text, countModel, signal);
        const output = settings.engine === "cloud"
            ? await compressCloud(text, settings, before.tokens, signal)
            : await compressLocal(text, settings, signal);
        // Count both with the same method so the ratio is meaningful.
        let after;
        if (before.source === "anthropic")
            after = await deps.counter.count(output.compressed, countModel, signal);
        else
            after = { tokens: estimateTokens(output.compressed), source: "estimate", model: countModel };
        if (after.source !== before.source) {
            after = { tokens: estimateTokens(output.compressed), source: "estimate", model: countModel };
            before.tokens = estimateTokens(text);
            before.source = "estimate";
        }
        const price = await inputPrice(settings);
        const savedTokens = before.tokens - after.tokens;
        const savedUSD = (savedTokens * price) / 1_000_000;
        const cost = "cost" in output ? output.cost : undefined;
        let written;
        if (source.writeTo?.trim()) {
            written = expandPath(source.writeTo, deps.directory);
            await fs.mkdir(path.dirname(written), { recursive: true });
            await fs.writeFile(written, output.compressed, "utf8");
        }
        return {
            original: text,
            compressed: output.compressed,
            engine: describeEngine(settings),
            amount: describeAmount(settings),
            model: output.model,
            device: output.device,
            seconds: output.seconds,
            countModel,
            countSource: before.source,
            originalTokens: before.tokens,
            compressedTokens: after.tokens,
            savedTokens,
            ratio: after.tokens > 0 ? before.tokens / after.tokens : 0,
            inputPricePerMillion: price,
            savedUSD,
            compressionCost: cost,
            netSavedUSD: savedUSD - (cost?.usd ?? 0),
            file,
            written,
            warnings: output.warnings,
            ignored: output.ignored,
            countError: before.error,
        };
    }
    async function updateSettings(patch) {
        const current = await deps.loadSettings();
        const merged = deepMerge(current, patch);
        const next = normalizeSettings(merged);
        if (patch && typeof patch === "object" && "cloudModel" in patch && patch.cloudModel === null) {
            next.cloudModel = undefined;
        }
        const restart = next.device !== current.device ||
            localModel(next) !== localModel(current) ||
            (next.engine === "llmlingua2") !== (current.engine === "llmlingua2");
        await deps.saveSettings(next);
        if (restart && deps.worker.running)
            deps.worker.stop();
        return next;
    }
    return { readSource, count, compress, updateSettings };
}
function deepMerge(base, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
        return patch === undefined ? base : patch;
    const output = Array.isArray(base) ? [...base] : { ...(base ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
            continue;
        output[key] =
            value && typeof value === "object" && !Array.isArray(value) && base?.[key] && typeof base[key] === "object"
                ? deepMerge(base[key], value)
                : value;
    }
    return output;
}
export function formatUSD(value) {
    const abs = Math.abs(value);
    const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 5;
    return `${value < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}
export function formatCount(result) {
    const lines = [
        `${result.tokens.toLocaleString()} tokens${result.source === "estimate" ? " (estimate)" : ""} · ${result.model}`,
        `${result.characters.toLocaleString()} characters · ${formatUSD(result.costUSD)} as input at $${result.inputPricePerMillion}/M`,
    ];
    if (result.file)
        lines.push(`File: ${result.file}`);
    if (result.error)
        lines.push(`Anthropic count_tokens unavailable: ${result.error}`);
    return lines.join("\n");
}
export function formatSummary(result) {
    const percent = result.originalTokens ? Math.round((result.savedTokens / result.originalTokens) * 100) : 0;
    const lines = [
        `${result.originalTokens.toLocaleString()} → ${result.compressedTokens.toLocaleString()} tokens` +
            ` (−${percent}%, ${result.ratio.toFixed(2)}×)${result.countSource === "estimate" ? " [estimated]" : ""}`,
        `Engine: ${result.engine}${result.device ? ` on ${result.device}` : ""} · ${result.amount} · ${result.seconds.toFixed(1)}s`,
        `Saved per send: ${formatUSD(result.savedUSD)} at $${result.inputPricePerMillion}/M (${result.countModel})`,
    ];
    if (result.compressionCost) {
        lines.push(`Compression cost: ~${result.compressionCost.inputTokens + result.compressionCost.outputTokens} tokens ` +
            `on ${result.compressionCost.model} = ${formatUSD(result.compressionCost.usd)} → net ${formatUSD(result.netSavedUSD)}`);
    }
    if (result.file)
        lines.push(`Source: ${result.file}`);
    if (result.written)
        lines.push(`Written to: ${result.written}`);
    for (const warning of result.warnings)
        lines.push(`⚠ ${warning}`);
    if (result.ignored.length)
        lines.push(`⚠ Ignored by this engine: ${result.ignored.join(", ")}`);
    if (result.countError)
        lines.push(`⚠ Anthropic count_tokens unavailable: ${result.countError}`);
    return lines.join("\n");
}
