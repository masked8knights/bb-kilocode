// The bb.host artifact BB ships to hosts. Re-exporting the published ACP
// bridge kit makes this plugin's host run the generic ACP bridge, which
// launches the command named in the provider registration (our adapter, which
// in turn drives `kilo acp`).
export {
  experimental_acpProviderBridge as experimental_providerBridge,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
