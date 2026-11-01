import { Rpc } from "@opencode/plugin/rpc"

const object = { type: "object", additionalProperties: true } as const

/** Client-side view of the env-manager vault RPC; only vaultGet is used. */
export const EnvManager = Rpc.define({
  id: "env.manager",
  events: {},
  methods: {
    vaultGet: {
      input: {
        type: "object",
        properties: { entries: { type: "array", items: { type: "string" }, maxItems: 16 } },
        required: ["entries"],
        additionalProperties: false,
      },
      output: object,
    },
  },
}) as unknown as Rpc.PortableDefinition

export type RpcFactory = (definition: Rpc.PortableDefinition) => any

/** Read one entry from the env-manager vault. Returns undefined when the plugin or entry is missing. */
export async function vaultValue(rpc: RpcFactory, directory: string, entry: string): Promise<string | undefined> {
  if (!entry) return undefined
  try {
    const result: any = await rpc(EnvManager).vaultGet({ entries: [entry] }, { location: { directory } })
    const value = result?.values?.[entry]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}
