# Volumen

**Servidor MCP que analiza hacia dónde se mueve la liquidez de los mercados mundiales, en tiempo casi real.**

📊 **Dashboard en vivo:** https://avcruz2000.github.io/Volumen/

Volumen mide el flujo de dinero entrando y saliendo de clases de activo, países, sectores y cripto
a partir del **volumen negociado en USD**, y lo combina con la liquidez de los bancos centrales y del
ecosistema cripto para responder una pregunta: *¿hacia dónde está yendo el dinero ahora mismo?*

## Qué analiza

| Bloque | Qué mide | Fuente |
|---|---|---|
| **Flujos por instrumento** | Flujo neto de dinero 5/20 sesiones, Chaikin Money Flow, volumen relativo, momentum → puntuación −100…+100 | Yahoo Finance |
| **Clases de activo** | Acciones EE.UU./desarrollados/emergentes, bonos (corto, largo, IG, HY), oro, plata, petróleo, materias primas, dólar, REITs, Bitcoin | Yahoo Finance |
| **Países** | 30 mercados vía sus ETFs cotizados en EE.UU. (volumen comparable en USD) | Yahoo Finance |
| **Sectores** | 11 sectores del S&P 500 + semiconductores | Yahoo Finance |
| **Régimen risk-on / risk-off** | Flujo en activos de riesgo vs refugio, VIX, crédito (HYG vs IEF), cobre/oro | Calculado |
| **Liquidez de la Fed** | Balance (WALCL) − Cuenta del Tesoro (TGA) − Repos inversos (RRP), M2 | FRED |
| **Liquidez cripto** | Capitalización, dominancia BTC, oferta de stablecoins, miedo y codicia | CoinGecko, DefiLlama, alternative.me |
| **Macro y divisas** | VIX, rendimientos del Tesoro, DXY, EUR, JPY, CNY, MXN, oro, petróleo, cobre | Yahoo Finance |
| **En vivo (dashboard)** | Precios cripto tick a tick | Coinbase WebSocket |

Todas las fuentes son **públicas y gratuitas, sin API keys**.

### Puntuación de flujo

```
flujo_5d   = Σ (posición del cierre en el rango de la vela × precio × volumen)   ← "money-flow volume"
puntuación = 40% · tanh(flujo_5d / volumen_medio_diario)  × √volumen_relativo
           + 30% · tanh(CMF20 × 5)
           + 30% · tanh(cambio_5d / 4%)
```

Positivo = acumulación (entra liquidez). Negativo = distribución (sale liquidez). Durante la sesión,
el volumen del día se proyecta a sesión completa para no infravalorar el flujo intradía.

## Arquitectura

```
                       ┌──────────────────────────────┐
  Yahoo · FRED ·       │  src/core  (fuentes +        │
  CoinGecko ·    ───▶  │  analítica + snapshot)       │
  DefiLlama · F&G      └──────┬─────────────┬─────────┘
                              │             │
              ┌───────────────▼──┐   ┌──────▼───────────────────┐
              │ Servidor MCP     │   │ GitHub Actions (c/10 min)│
              │ stdio  o  HTTP   │   │ → site/data/snapshot.json│
              │ (Claude, etc.)   │   │ → GitHub Pages           │
              └──────────────────┘   └──────┬───────────────────┘
                                            │
                                  ┌─────────▼─────────────────┐
                                  │ Dashboard público          │
                                  │ + Coinbase WS y CoinGecko  │
                                  │   en vivo desde el navegador│
                                  └────────────────────────────┘
```

- **El servidor MCP** consulta las fuentes en el momento (con caché de 60 s), así que Claude siempre recibe datos actuales.
- **El dashboard** se publica en GitHub Pages: accesible desde cualquier dispositivo, sin servidores que mantener. Se regenera cada ~10 minutos y además recibe precios cripto en vivo directamente en el navegador.
- **Tiempo real total:** si despliegas el modo HTTP en tu propio servidor, abre el dashboard con `?api=https://tu-servidor` y leerá `/api/snapshot` en vez del archivo estático.

## Uso como MCP

### Requisitos
Node.js 20 o superior.

```bash
git clone https://github.com/avcruz2000/Volumen.git
cd Volumen
npm install
npm run build
```

### Claude Code

```bash
claude mcp add volumen -- node /ruta/a/Volumen/dist/src/index.js
```

### Claude Desktop

En `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "volumen": {
      "command": "node",
      "args": ["/ruta/a/Volumen/dist/src/index.js"]
    }
  }
}
```

### Modo HTTP remoto (Streamable HTTP)

```bash
PORT=8787 npm run start:http
# MCP:       http://localhost:8787/mcp
# Snapshot:  http://localhost:8787/api/snapshot
```

Se puede desplegar tal cual en cualquier servicio que ejecute Node (Render, Railway, Fly.io, un VPS…) y conectarlo
como conector remoto en Claude.

### Herramientas

| Herramienta | Descripción |
|---|---|
| `get_liquidity_overview` | Panorama completo: régimen, top entradas/salidas, liquidez Fed y cripto, resumen narrativo |
| `get_capital_flows` | Ranking de flujos en `asset`, `region`, `sector`, `crypto` o `macro` |
| `analyze_instrument` | Flujo de cualquier símbolo de Yahoo Finance (AAPL, ^N225, EURUSD=X, GC=F, BTC-USD…) |
| `compare_flows` | Compara y ordena el flujo de varios símbolos |
| `get_risk_regime` | Régimen risk-on / risk-off y sus componentes |
| `get_fed_liquidity` | Liquidez neta de la Reserva Federal con historial |
| `get_crypto_liquidity` | Capitalización, dominancia, stablecoins, miedo y codicia |

Recurso: `volumen://snapshot` · Prompt: `informe_liquidez`.

Ejemplos de preguntas a Claude:
- *"¿Hacia dónde se está moviendo la liquidez hoy?"*
- *"¿Qué países están recibiendo más flujo esta semana?"*
- *"Compara el flujo de oro, bonos largos, Nasdaq y Bitcoin."*
- *"¿La Fed está inyectando o drenando liquidez?"*

## Desarrollo

```bash
npm run build       # compila TypeScript
npm run snapshot    # genera site/data/*.json con datos reales
python3 -m http.server 8765 --directory site   # ver el dashboard en local
```

Para añadir instrumentos edita `src/core/universe.ts`.

## Aviso

Información con fines educativos. No es asesoramiento financiero. Los datos de Yahoo Finance pueden tener
hasta 15 minutos de retraso según el mercado; FRED se actualiza semanalmente.

## Licencia

MIT
