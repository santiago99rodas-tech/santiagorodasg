// npm run gen:secrets
// Genera las claves que pide producción, listas para pegar en Environment de Easypanel.
import { randomBytes, generateKeyPairSync, createHash, createPublicKey } from "node:crypto";

const token = () => randomBytes(32).toString("base64url");
const { privateKey } = generateKeyPairSync("ed25519");
// Solo el contenido base64 de la clave (64 caracteres, sin saltos ni guiones): imposible de cortar mal
const keyB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const kid = createHash("sha256").update(createPublicKey(privateKey).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);

console.log(`# Pega estas líneas en Environment del servicio api (Easypanel). Guárdalas en un lugar seguro.
ADMIN_API_KEY=${token()}
SESSION_SECRET=${token()}
# Clave del oráculo (Ed25519, id ${kid}): 64 caracteres. Copia la línea completa.
ORACLE_PRIVATE_KEY=${keyB64}`);
