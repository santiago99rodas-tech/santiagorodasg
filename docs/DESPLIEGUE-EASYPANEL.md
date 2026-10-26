# Despliegue en Easypanel

Easypanel publica la plataforma con Docker en tu propio servidor. Un proyecto lleva tres servicios:

| Servicio | Tipo en Easypanel | Para qué |
|---|---|---|
| `db` | Postgres | Base de datos |
| `api` | App (GitHub + Dockerfile) | API, módulo del jugador (`/embed/`), back-office (`/admin/`), oráculo (`/v1/oracle`) y API de market makers (`/mm/v1`) |
| `casino` (opcional) | App (GitHub + Dockerfile) | Casino de prueba con billetera de referencia, para demos |

Al primer arranque, la API crea las tablas (7 migraciones) y carga las categorías, las fuentes y los 702 mercados del catálogo. No hay que correr nada a mano.

> **¿Ya lo tenías desplegado?** Ve directo a [Actualizar un despliegue existente](#actualizar-un-despliegue-existente). Hay un cambio que puede frenar el arranque si no lo haces antes.

## 0. Genera las claves

En tu computador, dentro de la carpeta del proyecto (PowerShell):

```powershell
cd santiagorodasg\server
npm install
npm run gen:secrets
```

Te da tres líneas: `ADMIN_API_KEY`, `SESSION_SECRET` y `ORACLE_PRIVATE_KEY`. Guárdalas en un gestor de contraseñas.

- La clave del oráculo es la que firma las probabilidades públicas. Si la cambias, quien verifique las firmas necesita la clave pública nueva.
- Sin Node en tu computador puedes generar las dos primeras en PowerShell con `[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")`. Si dejas `ORACLE_PRIVATE_KEY` vacía, el servidor crea una y la guarda en la base; funciona, pero conviene fijarla.

## 1. Proyecto y base de datos

1. **Create Project** → `predicciones`.
2. **+ Service → Postgres** → nombre `db` → **Create**.
3. En `db`, copia la **Internal Connection URL**. Es algo como `postgres://postgres:CLAVE@predicciones_db:5432/predicciones`.
4. En `db` → **Backups**, activa los respaldos diarios. Ahí vive todo: posiciones, órdenes, el ledger con los casinos, las fianzas y las cuentas de market makers.

## 2. API

1. **+ Service → App** → nombre `api`.
2. **Source → GitHub**:
   - Repositorio: `santiago99rodas-tech/santiagorodasg`. Si es privado, conecta antes tu GitHub en Easypanel (*Settings → GitHub*).
   - Rama: `ccr-d3b49809-jnu5ty`, o `main` cuando se fusione.
   - *Build Path*: `/`
3. **Build → Dockerfile** → archivo `server/Dockerfile`.
4. **Environment**: copia [`deploy/easypanel.env.example`](../deploy/easypanel.env.example), completa lo marcado con `<>` y pégalo. Lo mínimo es:
   ```
   DATABASE_URL=<Internal Connection URL del paso 1>
   PUBLIC_URL=https://predicciones.bo-sio.com
   ADMIN_API_KEY=<del paso 0>
   SESSION_SECRET=<del paso 0>
   ORACLE_PRIVATE_KEY=<del paso 0, en una sola línea con \n>
   ```
   - `PUBLIC_URL` es la dirección pública de la API (la del paso 5). Con ella se arma el enlace del módulo que reciben los casinos.
   - Sin `ANTHROPIC_API_KEY` la IA queda apagada (generar y resolver preguntas). Todo lo demás funciona.
5. **Domains → Add Domain**: `predicciones.bo-sio.com`, puerto **8080**, con HTTPS. El subdominio debe apuntar por DNS al servidor de Easypanel.
6. **Deploy**.

**En los registros (*Logs*) del primer arranque debe aparecer:**

```
migración aplicada: 001_init.sql
…
migración aplicada: 007_tesoreria.sql
catálogo: 702 eventos creados, 0 omitidos
```

Si falta algo obligatorio, el contenedor se detiene y lo dice. Por ejemplo: `ADMIN_API_KEY falta o es corta`.

**Salud del contenedor:** la imagen trae un chequeo (`/health`) que Easypanel usa solo. El contenedor aparece sano unos 30 a 60 segundos después de arrancar.

## 3. Comprueba que todo funciona

Desde tu computador:

```powershell
cd santiagorodasg\server
npm run smoke -- https://predicciones.bo-sio.com <ADMIN_API_KEY>
```

Revisa salud y base, catálogo, módulo, back-office, la firma del oráculo, el market maker de la casa, la protección contra informados, la liquidación y los market makers externos. Debe terminar en `Todo en orden`.

A mano:
- `https://predicciones.bo-sio.com/health` → `{"ok":true,"db":"ok","migrations":7,…}`
- `https://predicciones.bo-sio.com/admin/` → back-office (entra con `ADMIN_API_KEY`)
- `https://predicciones.bo-sio.com/v1/oracle` → índice del oráculo, con la cabecera `X-Oracle-Signature`

## 4. Casino de prueba (opcional, para demos)

1. **+ Service → App** → nombre `casino`. Misma fuente de GitHub, rama y Dockerfile (`server/Dockerfile`).
2. **Deploy → Command**: `node --import tsx mock-casino/server.ts`
3. **Environment**:
   ```
   PLATFORM_URL=http://predicciones_api:8080
   MOCK_CASINO_PORT=4000
   HEALTH_PORT=4000
   ```
   - `predicciones_api` es el nombre interno: proyecto + servicio. Ajústalo si usaste otros nombres.
   - `HEALTH_PORT` le dice al chequeo de salud que este servicio escucha en el 4000. Sin esa variable, Easypanel lo vería caído y lo reiniciaría en bucle.
4. **Domains**: `casino-demo.bo-sio.com`, puerto **4000**.
5. En `api` agrega `DEMO_CASINO_URL=http://predicciones_casino:4000` y vuelve a desplegar. Con eso la API registra el operador `demo-casino` apuntando a la billetera de prueba.
6. Abre `https://casino-demo.bo-sio.com`.

## 5. Después del despliegue

| Qué | Dónde |
|---|---|
| Dar de alta los casinos reales, con su revenue share | Back-office → Casinos ([INTEGRACION-CASINO.md](INTEGRACION-CASINO.md)) |
| Revisar el market maker y sus límites; el botón de pánico está ahí | Back-office → Riesgo de la casa ([MARKET-MAKER.md](MARKET-MAKER.md)) |
| Dar de alta market makers externos y registrar sus depósitos | Back-office → Market makers ([P2P.md](P2P.md)) |
| Liquidar con cada casino, sus garantías, la reserva de la casa y la conciliación con el banco | Back-office → Tesorería ([TESORERIA.md](TESORERIA.md)). Antes: abre el fideicomiso y registra ahí las garantías y la reserva |
| Publicar el oráculo | Pon `/v1/oracle` detrás de una CDN o de un límite por IP antes de anunciarlo ([ORACULO.md](ORACULO.md)) |
| Restringir el back-office | Limita `/admin` por IP en el proxy, o sirve el panel desde bo-sio.com (abajo) |

**El back-office en bo-sio.com** se puede montar de tres maneras:

1. **Proxy inverso**: `https://bo-sio.com/predicciones/` apuntando a la API.
2. **Archivo estático**: copia `web/admin/index.html` al hosting de bo-sio.com y ábrelo con `?api=https://predicciones.bo-sio.com`. También puedes fijar la API con la etiqueta `<meta name="predicciones-api">`.
3. **Iframe**: dentro del back-office actual, en un menú "Predicciones".

## Actualizar un despliegue existente

Las versiones nuevas (market maker v2, protección contra informados, oráculo con fianzas, P2P y tesorería) agregan 5 migraciones. Se aplican solas al arrancar y no tocan los datos existentes. Lo comprobé con una base de la versión anterior que tenía apuestas y resoluciones pendientes.

1. **Antes de desplegar**, revisa las variables de `api`:
   - **`ADMIN_API_KEY` y `SESSION_SECRET` deben tener 24 caracteres o más.** Con menos, la versión nueva no arranca en producción. Si tu clave actual es corta, genera otra con `npm run gen:secrets`. Cambiar `SESSION_SECRET` cierra las sesiones abiertas de los jugadores: el casino les abre una nueva al volver a entrar a la pestaña.
   - Agrega `ORACLE_PRIVATE_KEY`.
   - Si usas el casino de prueba, agrégale `HEALTH_PORT=4000` y cambia su comando a `node --import tsx mock-casino/server.ts`.
2. **Deploy**. En los registros deben aparecer las migraciones `003_market_maker.sql` a `007_tesoreria.sql`. El catálogo no se vuelve a cargar.
3. Corre `npm run smoke -- https://predicciones.bo-sio.com <ADMIN_API_KEY>`.

**Qué cambia para los casinos ya integrados:**
- Su billetera puede recibir débitos y créditos de fianzas: `reason` `resolution_bond`, `resolution_bond_refund` y `resolution_bond_reward`. Si validan `reason`, deben aceptarlos.
- Hay un recargo de hasta 3% para quien le gana a la casa de forma sostenida. Va dentro de `fee` y hay que avisarlo en los términos.
- Tienen un endpoint de liquidación nuevo: `GET /operator/v1/clearing`.

**Si algo sale mal:**
- **Volver a la versión anterior**: Easypanel → `api` → *Deployments* → la versión previa → **Rollback**. Las migraciones nuevas solo agregan columnas y tablas, así que la versión anterior sigue funcionando sobre la base actualizada.
- **Apagar piezas sin volver atrás**:
  - `MM_STRATEGY=v1`: market maker anterior.
  - `TOX_ENABLED=false`: sin recargos, spread asimétrico ni freno.
  - `MM_ENABLED=false`: la casa deja de cotizar.

  Cambia la variable y vuelve a desplegar.
- **Emergencia en el libro**: Riesgo de la casa → **Botón de pánico**. Retira todas las órdenes de la casa al instante.

## Notas de producción

- **Una sola réplica de `api`.** Los libros de órdenes viven en memoria, con un escritor por mercado. No escales a más de 1 réplica sin separar el motor ([ARQUITECTURA.md](ARQUITECTURA.md)). Si un redeploy superpone dos contenedores un momento, las migraciones están protegidas con un candado de Postgres.
- **Apagado ordenado.** En cada redeploy el contenedor recibe SIGTERM: deja de aceptar peticiones, frena las tareas programadas, espera las que están en curso y cierra la base.
- **Recursos.** Recién arrancada, con el catálogo completo, usó unos 70 MB de RAM en la prueba. Con tráfico sube; un límite de 512 MB y 1 vCPU alcanzan para empezar.
- **Auto Deploy.** Si lo activas, cada push a la rama vuelve a desplegar. Los datos no se pierden: el catálogo solo se carga si la base está vacía (`SEED_CATALOG=false` lo desactiva siempre).
- **Salida a internet.** El servidor debe poder leer RSS, Google Trends, GDELT y la API de Polymarket (referencias externas). Revisa en el back-office (*Fuentes*) que ninguna quede en error.
- **Versión visible en `/health`.** En Easypanel, en *Build Args*, puedes poner `APP_VERSION=<lo que quieras>` (por ejemplo la fecha) para saber qué versión está corriendo.
