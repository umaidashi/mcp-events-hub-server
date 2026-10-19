import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// `cf dev` takes no --host/--port. Bind IPv4 loopback like `npm start`; Vite's default "localhost" is ::1 only on macOS.
export default defineConfig({ plugins: [cloudflare()], server: { host: "127.0.0.1" } });
