# Modo: pipeline -- Inbox de URLs (Second Brain)

Procesa URLs de ofertas acumuladas en `data/pipeline.md`. El usuario agrega URLs cuando quiera y luego ejecuta `/career-ops pipeline` para procesarlas todas.

> Recomendacion operativa: usar LinkedIn como fuente principal de descubrimiento y usar este modo para procesar las ofertas priorizadas. `scan` queda como fuente secundaria.

## Workflow

1. **Leer** `data/pipeline.md` -> buscar items `- [ ]` en la seccion "Pendientes"
2. **Para cada URL pendiente**:
   a. Calcular siguiente `REPORT_NUM` secuencial (leer `reports/`, tomar el numero mas alto + 1)
   b. **Extraer JD** usando Playwright (`browser_navigate` + `browser_snapshot`) -> WebFetch -> WebSearch
   c. Si la URL no es accesible -> marcar como `- [!]` con nota y continuar
   d. **Ejecutar auto-pipeline completo**: Evaluacion A-F -> Report .md -> PDF (si score >= 3.0) -> Tracker
   e. **Mover de "Pendientes" a "Procesadas"**: `- [x] #NNN | URL | Empresa | Rol | Score/5 | PDF ✅/❌`
3. **Si hay 3+ URLs pendientes**, lanzar agentes en paralelo (Agent tool con `run_in_background`) para maximizar velocidad.
4. **Al terminar**, mostrar tabla resumen:

```
| # | Empresa | Rol | Score | PDF | Accion recomendada |
```

## Formato de pipeline.md

```markdown
## Pendientes
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [ ] local:jds/company-role.md | Company Inc | Senior PM
- [!] https://private.url/job - Error: login required

## Procesadas
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Deteccion inteligente de JD desde URL

1. **Playwright (preferido):** `browser_navigate` + `browser_snapshot`. Funciona con SPAs.
2. **WebFetch (fallback):** Para paginas estaticas o cuando Playwright no esta disponible.
3. **WebSearch (ultimo recurso):** Buscar en portales secundarios que indexan el JD.

**Casos especiales:**
- **LinkedIn**: Puede requerir login -> preferir guardar el JD en `jds/...` y procesar `local:jds/...`; si no hay JD local, marcar `[!]` y pedir al usuario que pegue el texto
- **PDF**: Si la URL apunta a un PDF, leerlo directamente con Read tool
- **`local:` prefix**: Leer el archivo local. Ejemplo: `local:jds/linkedin-pm-ai.md` -> leer `jds/linkedin-pm-ai.md`

## Numeracion automatica

1. Listar todos los archivos en `reports/`
2. Extraer el numero del prefijo (ej: `142-medispend...` -> `142`)
3. Nuevo numero = maximo encontrado + 1

## Sincronizacion de fuentes

Antes de procesar cualquier URL, verificar sync:

```bash
node cv-sync-check.mjs
```

Si hay desincronizacion, advertir al usuario antes de continuar.
