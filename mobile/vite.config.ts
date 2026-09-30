import { defineConfig } from "vite";

// The built app is plain static files in dist/, loaded from the phone by Capacitor
// (or from any static folder in a browser), so asset paths must be relative.
export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 5173 },
});
