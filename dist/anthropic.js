import { createHash } from "node:crypto";
export const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";
/** Rough count for when the API is unavailable: ~3.5 characters per token for English prose and code. */
export function estimateTokens(text) {
    if (!text)
        return 0;
    const cjk = text.match(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g)?.length ?? 0;
    return Math.ceil((text.length - cjk) / 3.5 + cjk * 1.2);
}
export class CountError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
/**
 * count_tokens is free but rate limited, so identical requests are cached.
 * The cache is keyed by a hash so prompt text is not retained in memory twice.
 */
export function createCounter(options) {
    const cache = new Map();
    const url = options.baseURL ?? COUNT_TOKENS_URL;
    const fetcher = options.fetchImpl ?? fetch;
    async function countStrict(text, model, signal) {
        const cacheKey = createHash("sha256").update(model).update("\0").update(text).digest("hex");
        const cached = cache.get(cacheKey);
        if (cached !== undefined)
            return cached;
        const apiKey = await options.resolveKey();
        if (!apiKey) {
            throw new CountError("No Anthropic API key. Set ANTHROPIC_API_KEY, add it to the env-manager vault, or pass the apiKey plugin option.");
        }
        const response = await fetcher(url, {
            method: "POST",
            signal,
            headers: {
                "content-type": "application/json",
                "x-api-key": apiKey.key,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({ model, messages: [{ role: "user", content: text || " " }] }),
        });
        const body = await response.json().catch(() => undefined);
        if (!response.ok) {
            const detail = body?.error?.message ?? response.statusText;
            throw new CountError(`count_tokens failed (${response.status}, key from ${apiKey.source}): ${detail}`, response.status);
        }
        const tokens = body?.input_tokens;
        if (typeof tokens !== "number")
            throw new CountError("count_tokens returned no input_tokens");
        if (cache.size > 500)
            cache.delete(cache.keys().next().value);
        cache.set(cacheKey, tokens);
        return tokens;
    }
    return {
        countStrict,
        async count(text, model, signal) {
            try {
                return { tokens: await countStrict(text, model, signal), source: "anthropic", model };
            }
            catch (error) {
                if (signal?.aborted)
                    throw error;
                return {
                    tokens: estimateTokens(text),
                    source: "estimate",
                    model,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        },
        clear() {
            cache.clear();
        },
    };
}
/** Keys used by local proxies ("dummy", "sk-placeholder") cannot authenticate against api.anthropic.com. */
export function plausibleKey(key) {
    return typeof key === "string" && key.trim().length >= 20 && !/^(dummy|test|none|placeholder)$/i.test(key.trim());
}
