// The host-side RPC contract: server.ts pushes the resolved kilo binary and
// default model to the plugin host (where the bridge runs) with setConfig.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const kilocodeHostContract = defineRpcContract({
  setConfig: {
    input: z
      .object({
        kiloBin: z.string().min(1),
        model: z.string(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
});
