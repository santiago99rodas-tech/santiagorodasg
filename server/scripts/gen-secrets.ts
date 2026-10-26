// npm run gen:secrets
// Genera las claves que pide producción, listas para pegar en Environment de Easypanel.
import { randomBytes, generateKeyPairSync, createHash, createPublicKey } from "node:crypto";

const token = () => randomBytes(32).toString("base64url");
const { privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const kid = createHash("sha256").update(createPublicKey(privateKey).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);

console.log(`# Pega estas líneas en Environment del servicio api (Easypanel). Guárdalas en un lugar seguro.
ADMIN_API_KEY=${token()}
SESSION_SECRET=${token()}
# Clave del oráculo (Ed25519, id ${kid}). Los saltos de línea van como \\n: así la acepta Easypanel en una línea.
ORACLE_PRIVATE_KEY=${pem.trim().replace(/\n/g, "\\n")}`);
