import { Rpc } from "@opencode/plugin/rpc";
const string = { type: "string" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const result = { type: "object", additionalProperties: true };
const modelRef = {
    type: "object",
    properties: { providerID: string, id: string },
    required: ["providerID", "id"],
    additionalProperties: false,
};
export const overridesSchema = {
    type: "object",
    properties: {
        engine: { type: "string", enum: ["llmlingua2", "llmlingua", "longllmlingua", "cloud"] },
        model: string,
        rate: number,
        targetToken: number,
        question: string,
        instruction: string,
        keepCode: boolean,
        forceTokens: { type: "array", items: string },
        cloudModel: modelRef,
    },
    additionalProperties: false,
};
export const Compressor = Rpc.define({
    id: "compressor",
    events: {
        status: {
            schema: {
                type: "object",
                properties: { message: string },
                required: ["message"],
                additionalProperties: false,
            },
        },
        settings: {
            schema: { type: "object", additionalProperties: true },
        },
    },
    methods: {
        count: {
            input: {
                type: "object",
                properties: { text: string, path: string, model: string },
                additionalProperties: false,
            },
            output: result,
        },
        compress: {
            input: {
                type: "object",
                properties: { text: string, path: string, writeTo: string, overrides: overridesSchema },
                additionalProperties: false,
            },
            output: result,
        },
        getSettings: {
            input: { type: "object", properties: {}, additionalProperties: false },
            output: result,
        },
        setSettings: {
            input: {
                type: "object",
                properties: { patch: { type: "object", additionalProperties: true } },
                required: ["patch"],
                additionalProperties: false,
            },
            output: result,
        },
        resetSettings: {
            input: { type: "object", properties: {}, additionalProperties: false },
            output: result,
        },
        status: {
            input: { type: "object", properties: {}, additionalProperties: false },
            output: result,
        },
        stopWorker: {
            input: { type: "object", properties: {}, additionalProperties: false },
            output: result,
        },
        warmup: {
            input: { type: "object", properties: {}, additionalProperties: false },
            output: result,
        },
        send: {
            input: {
                type: "object",
                properties: { sessionID: string, text: string },
                required: ["sessionID", "text"],
                additionalProperties: false,
            },
            output: result,
        },
        writeFile: {
            input: {
                type: "object",
                properties: { path: string, text: string },
                required: ["path", "text"],
                additionalProperties: false,
            },
            output: result,
        },
    },
});
