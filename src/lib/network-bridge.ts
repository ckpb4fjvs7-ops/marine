import { createServerFn } from "@tanstack/react-start";

/** Only starts a loopback companion; UDP reception still requires an explicit Connect. */
export const ensureUdpBridge = createServerFn({ method: "POST" }).handler(async () => {
  const { ensureLocalUdpBridge } = await import("./network-bridge.server");
  return ensureLocalUdpBridge();
});
