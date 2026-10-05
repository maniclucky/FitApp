import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";

// After a build, write dist/sw.js from sw.js with the list of every built file and a version
// made from their contents, so any change to the app gives the phone a new version to fetch.
function serviceWorker(): Plugin {
  return {
    name: "fitapp-service-worker",
    apply: "build",
    writeBundle(options) {
      const dir = options.dir!;
      const files = (readdirSync(dir, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile() && e.name !== "sw.js")
        .map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"))
        .sort();
      const hash = createHash("sha256");
      for (const f of files) hash.update(f).update(readFileSync(join(dir, f)));
      const version = hash.digest("hex").slice(0, 12);
      const source = readFileSync("sw.js", "utf8")
        .replace("__FILES__", JSON.stringify(["./", ...files.map((f) => `./${f}`)]))
        .replace("__VERSION__", JSON.stringify(version));
      writeFileSync(join(dir, "sw.js"), source);
    },
  };
}

// The built app is plain static files in dist/, loaded from the phone by Capacitor
// (or from any static folder in a browser), so asset paths must be relative.
export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 5173 },
  plugins: [serviceWorker()],
});
