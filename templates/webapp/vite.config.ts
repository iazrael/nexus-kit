import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { nexusPwa } from "@nexus-kit/vite";
import { defineConfig } from "vite";
import { APP_ID, APP_NAME, RUNTIME_PARTITIONS } from "./pwa.config.ts";

export default defineConfig(({ command }) => ({
  server: { host: "0.0.0.0", allowedHosts: true },
  plugins: [
    react(),
    tailwindcss(),
    nexusPwa({
      command,
      appId: APP_ID,
      root: import.meta.dirname,
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: APP_NAME,
        background_color: "#0b0b0f",
        theme_color: "#0b0b0f",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      runtimePartitions: RUNTIME_PARTITIONS,
      precache: { includeAssets: ["favicon.png", "apple-touch-icon.png"] },
    }),
  ],
}));
