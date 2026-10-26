# Despliegue en Easypanel

Easypanel publica la plataforma con Docker en tu propio servidor. Necesitas tres servicios dentro de un proyecto:

| Servicio | Tipo en Easypanel | Para qué |
|---|---|---|
| `db` | Postgres | Base de datos |
| `api` | App (desde GitHub, Dockerfile) | API, módulo del jugador (`/embed/`) y back-office (`/admin/`) |
| `casino` (opcional) | App (desde GitHub, Dockerfile) | Casino de prueba con billetera de referencia, para hacer demos |

Al primer arranque, la API crea las tablas, las categorías y las fuentes, y carga los 702 mercados del catálogo. No hay que correr comandos a mano.

## 1. Proyecto y base de datos

1. En Easypanel: **Create Project** → nombre `predicciones`.
2. Dentro del proyecto: **+ Service → Postgres** → nombre `db` → **Create**.
3. Abre el servicio `db` y copia la **Internal Connection URL** (algo como `postgres://postgres:CLAVE@predicciones_db:5432/predicciones`). La necesitas en el paso 2.

## 2. API (plataforma)

1. **+ Service → App** → nombre `api`.
2. **Source → GitHub**:
   - Repositorio: `santiago99rodas-tech/santiagorodasg` (si es privado, primero conecta tu cuenta de GitHub en Easypanel: *Settings → GitHub*).
   - Rama: `ccr-d3b49809-jnu5ty` (o `main` cuando se fusione).
   - Ruta de compilación (*Build Path*): `/`
3. **Build → Dockerfile**, archivo: `server/Dockerfile`.
4. **Environment**, pega y ajusta:
   ```
   DATABASE_URL=<Internal Connection URL del paso 1>
   PUBLIC_URL=https://predicciones.bo-sio.com
   ADMIN_API_KEY=<una clave larga y secreta>
   SESSION_SECRET=<otra clave larga y secreta>
   ANTHROPIC_API_KEY=
   TAKER_FEE_BPS=200
   ```
   - `PUBLIC_URL` es la dirección pública con la que se verá la API (la del paso 5). Se usa para armar el enlace del módulo que reciben los casinos.
   - `ANTHROPIC_API_KEY` es opcional: sin clave, la IA (generar y resolver preguntas) queda desactivada y todo lo demás funciona.
   - Para generar claves: en PowerShell, `[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")`.
5. **Domains → Add Domain**: `predicciones.bo-sio.com` (o el que prefieras), puerto **8080**, con HTTPS. El subdominio debe apuntar por DNS al servidor de Easypanel.
6. **Deploy**. En los registros (*Logs*) debe aparecer `catálogo: 702 eventos creados` y luego el servidor escuchando en el puerto 8080.

Comprueba:
- `https://predicciones.bo-sio.com/health` → `{"ok":true}`
- `https://predicciones.bo-sio.com/admin/` → back-office (entra con `ADMIN_API_KEY`)

## 3. Casino de prueba (opcional, para demos)

1. **+ Service → App** → nombre `casino`, misma fuente de GitHub y rama, mismo Dockerfile `server/Dockerfile`.
2. **Deploy → Command** (sobrescribe el comando de inicio): `npx tsx mock-casino/server.ts`
3. **Environment**:
   ```
   PLATFORM_URL=http://predicciones_api:8080
   MOCK_CASINO_PORT=4000
   ```
   (`predicciones_api` es el nombre interno: proyecto + servicio. Ajústalo si usaste otros nombres.)
4. **Domains**: `casino-demo.bo-sio.com`, puerto **4000**.
5. Vuelve al servicio `api` y agrega esta variable, luego **Deploy** otra vez:
   ```
   DEMO_CASINO_URL=http://predicciones_casino:4000
   ```
   Con eso la API registra el operador `demo-casino` apuntando a la billetera del casino de prueba.
6. Abre `https://casino-demo.bo-sio.com`: casino de ejemplo con la pestaña Predicciones embebida y su saldo.

## 4. Integrar un casino real

1. En el back-office: **Casinos → + Agregar casino** (o `POST /admin/operators`). Te da `apiKey`, `apiSecret` y `walletSecret`.
2. El casino implementa los endpoints de billetera y abre sesiones según [INTEGRACION-CASINO.md](INTEGRACION-CASINO.md).
3. La pestaña Predicciones del casino carga `launchUrl` en un iframe.

## Notas de producción

- **Back-office**: limita `/admin` por IP en Easypanel (o en el proxy) y usa una `ADMIN_API_KEY` fuerte.
- **Una sola instancia de la API**: los libros de órdenes viven en memoria con un escritor por mercado. No escales `api` a más de 1 réplica sin separar el motor (ver ARQUITECTURA.md).
- **Copias de seguridad**: activa los backups del servicio `db` en Easypanel.
- **Actualizaciones**: activa *Auto Deploy* para que cada push a la rama vuelva a desplegar. Los datos no se pierden: el catálogo solo se carga si la base está vacía (`SEED_CATALOG=false` lo desactiva siempre).
- **Fuentes de noticias**: el servidor debe poder salir a internet para leer RSS, Google Trends y GDELT. Revisa en el back-office (*Fuentes*) que ninguna quede en error.
