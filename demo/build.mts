// Arma la demo autónoma (un solo HTML, sin servidor) para publicarla como artifact o abrirla localmente.
//   cd server && npx tsx ../demo/build.mts      -> demo/dist/predicciones-demo.html
//
// Usa el catálogo real, el módulo del jugador real (web/embed) y el back-office real (web/admin).
// A cada uno le inyecta una capa que redirige fetch/EventSource al backend en memoria (demo/backend.js).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadCatalog, toEventInput } from "../server/src/db/catalog/index.js";
import { CATEGORIES, SOURCES } from "../server/src/db/seed.js";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

// Catálogo -> entradas de evento (las mismas que usa el servidor al sembrar)
const catalog = (await loadCatalog()).flatMap((c) => c.items.map((i) => toEventInput(c, i)));

// Capa que se inyecta en cada iframe: la red apunta al backend del documento padre
const SHIM = `<script>(function(){var D=window.parent&&window.parent.DEMO;if(!D)return;
window.fetch=function(u,o){return D.fetch(String(u),o||{});};
window.EventSource=function(){return D.stream();};
document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest('a[href^="#"]');if(!a)return;e.preventDefault();location.hash=a.getAttribute("href");},true);
})();</script>`;

function inject(html: string, replacements: [string, string][]) {
  // Reemplazos con función: así los "$" del código no se interpretan como patrones de String.replace
  let out = html.replace("<head>", () => `<head>\n${SHIM}`);
  for (const [from, to] of replacements) {
    if (!out.includes(from)) throw new Error(`No se encontró en el HTML: ${from.slice(0, 60)}…`);
    out = out.replace(from, () => to);
  }
  return out;
}

const embed = inject(read("web/embed/index.html"), [
  ['const TOKEN = new URLSearchParams(location.search).get("token");', 'const TOKEN = "demo";'],
]);
const admin = inject(read("web/admin/index.html"), [
  ['const A = { key: store.get("pa_key"), user: store.get("pa_user"), api: qs.get("api") ?? store.get("pa_api") ?? DEFAULT_API };', 'const A = { key: "demo", user: "Demo", api: "" };'],
]);

// La matemática del market maker es la misma del servidor: se transpila engine/quoting.ts a JS plano
const { transformSync } = createRequire(new URL("../server/package.json", import.meta.url))("esbuild");
const quoting = transformSync(read("server/src/engine/quoting.ts"), { loader: "ts", format: "esm" }).code
  .replace(/^export /gm, "").replace(/^\s*const clamp = .*$/m, "");

// Literal JS seguro dentro de <script>
const js = (v: unknown) => JSON.stringify(v).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

const shell = read("demo/shell.html")
  .replace("/*__DATA__*/", () => `const CATALOG = ${js(catalog)};\nconst CATEGORIES = ${js(CATEGORIES)};\nconst SOURCES = ${js(SOURCES.map(({ kind, name, url, category, country }) => ({ kind, name, url, category, country })))};`)
  .replace("/*__BACKEND__*/", () => read("demo/backend.js").replace("/*__QUOTING__*/", () => quoting))
  .replace("/*__PAGES__*/", () => `const EMBED_HTML = ${js(embed)};\nconst ADMIN_HTML = ${js(admin)};`);

mkdirSync(new URL("demo/dist/", root), { recursive: true });
writeFileSync(new URL("demo/dist/predicciones-demo.html", root), shell);
console.log(`demo/dist/predicciones-demo.html: ${(shell.length / 1024).toFixed(0)} KB, ${catalog.length} mercados`);
process.exit(0);
