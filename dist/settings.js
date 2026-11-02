export const LLMLINGUA2_MODELS = [
    {
        id: "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank",
        title: "LLMLingua-2 · BERT base (multilingual)",
        description: "Small and fast (~700 MB). Default.",
    },
    {
        id: "microsoft/llmlingua-2-xlm-roberta-large-meetingbank",
        title: "LLMLingua-2 · XLM-RoBERTa large",
        description: "Best LLMLingua-2 quality (~2.2 GB).",
    },
];
export const LLMLINGUA_MODELS = [
    {
        id: "microsoft/phi-2",
        title: "Phi-2 (2.7B)",
        description: "Good small causal LM: ~5.5 GB on a GPU, but ~11 GB in fp32 on CPU. Large for a 6 GB card.",
    },
    {
        id: "openai-community/gpt2",
        title: "GPT-2 small",
        description: "Tiny and fast (~550 MB); lower quality.",
    },
    {
        id: "NousResearch/Llama-2-7b-hf",
        title: "Llama-2 7B",
        description: "LLMLingua's original default: ~14 GB in fp16, ~28 GB on CPU. Large GPU required.",
    },
    {
        id: "TheBloke/Llama-2-7b-Chat-GPTQ",
        title: "Llama-2 7B Chat GPTQ",
        description: "Quantised; needs optimum + auto-gptq installed in the worker env.",
    },
];
export const PRESETS = {
    light: { title: "Light", rate: 0.7, description: "Keep ~70% (≈1.4×). Safest." },
    balanced: { title: "Balanced", rate: 0.5, description: "Keep ~50% (2×)." },
    aggressive: { title: "Aggressive", rate: 0.33, description: "Keep ~33% (3×). LLMLingua-2 paper default." },
    extreme: { title: "Extreme", rate: 0.2, description: "Keep ~20% (5×). Expect information loss." },
};
export const ENGINES = {
    llmlingua2: { title: "Local · LLMLingua-2", description: "Token classifier. Fast, task-agnostic." },
    llmlingua: { title: "Local · LLMLingua", description: "Perplexity-based with a small causal LM." },
    longllmlingua: {
        title: "Local · LongLLMLingua",
        description: "Question-aware, ranks paragraphs. Best for long documents.",
    },
    cloud: { title: "Cloud model", description: "Ask a model from this OpenCode session to compress. Costs tokens." },
};
export function defaultSettings() {
    return {
        engine: "llmlingua2",
        models: {
            llmlingua2: LLMLINGUA2_MODELS[0].id,
            llmlingua: LLMLINGUA_MODELS[0].id,
        },
        device: "auto",
        amount: { mode: "rate", rate: 0.5, targetToken: 500 },
        protect: {
            forceTokens: ["\n", "?", "!", "."],
            forceReserveDigit: true,
            dropConsecutive: true,
            keepCode: true,
            minSegmentChars: 80,
        },
        longContext: {
            instruction: "",
            question: "",
            conditionInQuestion: "after_condition",
            reorderContext: "sort",
            dynamicContextCompressionRatio: 0.3,
            contextBudget: "+100",
            rankMethod: "longllmlingua",
            conditionCompare: true,
        },
        filters: {
            useSentenceLevelFilter: false,
            useContextLevelFilter: true,
            useTokenLevelFilter: true,
            iterativeSize: 200,
            keepSplit: false,
        },
        counting: {
            model: "claude-sonnet-4-5",
            vaultEntry: "anthropic/api-key",
            fallbackInputPrice: 3,
        },
        auto: { enabled: false, minTokens: 2000 },
    };
}
export function applyOverrides(base, overrides = {}) {
    const next = structuredClone(base);
    if (overrides.engine)
        next.engine = overrides.engine;
    if (overrides.model) {
        if (next.engine === "llmlingua2")
            next.models.llmlingua2 = overrides.model;
        else if (next.engine !== "cloud")
            next.models.llmlingua = overrides.model;
    }
    if (typeof overrides.rate === "number") {
        next.amount.mode = "rate";
        next.amount.rate = overrides.rate;
    }
    if (typeof overrides.targetToken === "number") {
        next.amount.mode = "target";
        next.amount.targetToken = overrides.targetToken;
    }
    if (typeof overrides.question === "string")
        next.longContext.question = overrides.question;
    if (typeof overrides.instruction === "string")
        next.longContext.instruction = overrides.instruction;
    if (typeof overrides.keepCode === "boolean")
        next.protect.keepCode = overrides.keepCode;
    if (Array.isArray(overrides.forceTokens))
        next.protect.forceTokens = overrides.forceTokens;
    if (overrides.cloudModel)
        next.cloudModel = overrides.cloudModel;
    return normalizeSettings(next);
}
const clamp = (value, min, max, fallback) => {
    const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, number));
};
function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const str = (value, fallback) => (typeof value === "string" ? value : fallback);
/** Merge stored or partial settings over the defaults and clamp every value. */
export function normalizeSettings(input) {
    const d = defaultSettings();
    const raw = input && typeof input === "object" ? input : {};
    const cloud = raw.cloudModel;
    return {
        engine: oneOf(raw.engine, ["llmlingua2", "llmlingua", "longllmlingua", "cloud"], d.engine),
        models: {
            llmlingua2: str(raw.models?.llmlingua2, d.models.llmlingua2).trim() || d.models.llmlingua2,
            llmlingua: str(raw.models?.llmlingua, d.models.llmlingua).trim() || d.models.llmlingua,
        },
        device: oneOf(raw.device, ["auto", "cuda", "cpu", "mps"], d.device),
        cloudModel: cloud && typeof cloud.providerID === "string" && typeof cloud.id === "string"
            ? { providerID: cloud.providerID, id: cloud.id }
            : undefined,
        amount: {
            mode: oneOf(raw.amount?.mode, ["rate", "target"], d.amount.mode),
            rate: Math.round(clamp(raw.amount?.rate, 0.05, 1, d.amount.rate) * 100) / 100,
            targetToken: Math.round(clamp(raw.amount?.targetToken, 10, 1_000_000, d.amount.targetToken)),
        },
        protect: {
            forceTokens: Array.isArray(raw.protect?.forceTokens)
                ? raw.protect.forceTokens.filter((token) => typeof token === "string" && token.length > 0)
                : d.protect.forceTokens,
            forceReserveDigit: bool(raw.protect?.forceReserveDigit, d.protect.forceReserveDigit),
            dropConsecutive: bool(raw.protect?.dropConsecutive, d.protect.dropConsecutive),
            keepCode: bool(raw.protect?.keepCode, d.protect.keepCode),
            minSegmentChars: Math.round(clamp(raw.protect?.minSegmentChars, 0, 100_000, d.protect.minSegmentChars)),
        },
        longContext: {
            instruction: str(raw.longContext?.instruction, d.longContext.instruction),
            question: str(raw.longContext?.question, d.longContext.question),
            conditionInQuestion: oneOf(raw.longContext?.conditionInQuestion, ["none", "before", "after", "after_condition"], d.longContext.conditionInQuestion),
            reorderContext: oneOf(raw.longContext?.reorderContext, ["original", "sort", "two_stage"], d.longContext.reorderContext),
            dynamicContextCompressionRatio: clamp(raw.longContext?.dynamicContextCompressionRatio, 0, 1, d.longContext.dynamicContextCompressionRatio),
            contextBudget: str(raw.longContext?.contextBudget, d.longContext.contextBudget),
            rankMethod: oneOf(raw.longContext?.rankMethod, ["longllmlingua", "llmlingua", "bm25", "gzip", "sentbert", "openai", "bge", "jinza"], d.longContext.rankMethod),
            conditionCompare: bool(raw.longContext?.conditionCompare, d.longContext.conditionCompare),
        },
        filters: {
            useSentenceLevelFilter: bool(raw.filters?.useSentenceLevelFilter, d.filters.useSentenceLevelFilter),
            useContextLevelFilter: bool(raw.filters?.useContextLevelFilter, d.filters.useContextLevelFilter),
            useTokenLevelFilter: bool(raw.filters?.useTokenLevelFilter, d.filters.useTokenLevelFilter),
            iterativeSize: Math.round(clamp(raw.filters?.iterativeSize, 10, 10_000, d.filters.iterativeSize)),
            keepSplit: bool(raw.filters?.keepSplit, d.filters.keepSplit),
        },
        counting: {
            model: str(raw.counting?.model, d.counting.model).trim() || d.counting.model,
            vaultEntry: str(raw.counting?.vaultEntry, d.counting.vaultEntry).trim(),
            fallbackInputPrice: clamp(raw.counting?.fallbackInputPrice, 0, 1000, d.counting.fallbackInputPrice),
        },
        auto: {
            enabled: bool(raw.auto?.enabled, d.auto.enabled),
            minTokens: Math.round(clamp(raw.auto?.minTokens, 50, 10_000_000, d.auto.minTokens)),
        },
    };
}
export function localModel(settings) {
    return settings.engine === "llmlingua2" ? settings.models.llmlingua2 : settings.models.llmlingua;
}
/** Build the keyword arguments for PromptCompressor.compress_prompt for the selected engine. */
export function llmlinguaKwargs(settings) {
    const amount = settings.amount.mode === "target" ? { target_token: settings.amount.targetToken } : { rate: settings.amount.rate };
    if (settings.engine === "llmlingua2") {
        return {
            ...amount,
            force_tokens: settings.protect.forceTokens,
            force_reserve_digit: settings.protect.forceReserveDigit,
            drop_consecutive: settings.protect.dropConsecutive,
            use_context_level_filter: false,
            use_token_level_filter: settings.filters.useTokenLevelFilter,
        };
    }
    const base = {
        ...amount,
        instruction: settings.longContext.instruction,
        question: settings.longContext.question,
        iterative_size: settings.filters.iterativeSize,
        use_sentence_level_filter: settings.filters.useSentenceLevelFilter,
        use_context_level_filter: settings.filters.useContextLevelFilter,
        use_token_level_filter: settings.filters.useTokenLevelFilter,
        keep_split: settings.filters.keepSplit,
    };
    if (settings.engine === "llmlingua") {
        // A single context cannot be filtered at context level.
        base.use_context_level_filter = false;
        return base;
    }
    return {
        ...base,
        rank_method: settings.longContext.rankMethod,
        condition_in_question: settings.longContext.conditionInQuestion,
        reorder_context: settings.longContext.reorderContext,
        dynamic_context_compression_ratio: settings.longContext.dynamicContextCompressionRatio,
        condition_compare: settings.longContext.conditionCompare,
        context_budget: settings.longContext.contextBudget,
    };
}
export function describeAmount(settings) {
    if (settings.amount.mode === "target")
        return `target ${settings.amount.targetToken} tokens`;
    const ratio = 1 / settings.amount.rate;
    return `keep ${Math.round(settings.amount.rate * 100)}% (≈${ratio.toFixed(1)}×)`;
}
export function describeEngine(settings) {
    if (settings.engine === "cloud") {
        return settings.cloudModel ? `cloud ${settings.cloudModel.providerID}/${settings.cloudModel.id}` : "cloud (no model)";
    }
    return `${ENGINES[settings.engine].title} · ${localModel(settings)}`;
}
/** Escape helpers so protected tokens like "\n" can be typed in a single-line prompt. */
export function encodeTokens(tokens) {
    return tokens.map((token) => token.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/,/g, "\\,")).join(", ");
}
export function decodeTokens(input) {
    const raw = [];
    let current = "";
    for (let index = 0; index < input.length; index++) {
        const char = input[index];
        if (char === "\\" && index + 1 < input.length) {
            current += char + input[++index];
            continue;
        }
        if (char === ",") {
            raw.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    raw.push(current);
    const tokens = raw
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/\\(.)/g, (_match, next) => (next === "n" ? "\n" : next === "t" ? "\t" : next)));
    return [...new Set(tokens)];
}
