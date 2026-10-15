export type Group = "asset" | "region" | "sector" | "crypto" | "macro";

export interface Instrument {
  symbol: string; // símbolo Yahoo Finance
  name: string;
  group: Group;
  /** Clasificación para el régimen risk-on / risk-off */
  risk?: "on" | "off";
  country?: string; // ISO-3166 alpha-3 para el mapa
}

export const UNIVERSE: Instrument[] = [
  // Clases de activo
  { symbol: "SPY", name: "Acciones EE.UU. (S&P 500)", group: "asset", risk: "on" },
  { symbol: "QQQ", name: "Tecnología EE.UU. (Nasdaq 100)", group: "asset", risk: "on" },
  { symbol: "IWM", name: "Small caps EE.UU.", group: "asset", risk: "on" },
  { symbol: "EFA", name: "Acciones desarrolladas ex-EE.UU.", group: "asset", risk: "on" },
  { symbol: "EEM", name: "Acciones emergentes", group: "asset", risk: "on" },
  { symbol: "HYG", name: "Bonos high yield", group: "asset", risk: "on" },
  { symbol: "LQD", name: "Bonos corporativos IG", group: "asset" },
  { symbol: "TLT", name: "Tesoro EE.UU. 20+ años", group: "asset", risk: "off" },
  { symbol: "IEF", name: "Tesoro EE.UU. 7-10 años", group: "asset", risk: "off" },
  { symbol: "SHY", name: "Tesoro EE.UU. 1-3 años (cash)", group: "asset", risk: "off" },
  { symbol: "GLD", name: "Oro", group: "asset", risk: "off" },
  { symbol: "SLV", name: "Plata", group: "asset" },
  { symbol: "USO", name: "Petróleo WTI", group: "asset", risk: "on" },
  { symbol: "DBC", name: "Materias primas (cesta)", group: "asset" },
  { symbol: "UUP", name: "Dólar estadounidense", group: "asset", risk: "off" },
  { symbol: "VNQ", name: "Bienes raíces (REITs)", group: "asset" },
  { symbol: "BTC-USD", name: "Bitcoin", group: "asset", risk: "on" },

  // Regiones (ETFs país cotizados en EE.UU. → volumen comparable en USD)
  { symbol: "SPY", name: "Estados Unidos", group: "region", country: "USA" },
  { symbol: "EWC", name: "Canadá", group: "region", country: "CAN" },
  { symbol: "EWW", name: "México", group: "region", country: "MEX" },
  { symbol: "EWZ", name: "Brasil", group: "region", country: "BRA" },
  { symbol: "ECH", name: "Chile", group: "region", country: "CHL" },
  { symbol: "ARGT", name: "Argentina", group: "region", country: "ARG" },
  { symbol: "COLO", name: "Colombia", group: "region", country: "COL" },
  { symbol: "EPU", name: "Perú", group: "region", country: "PER" },
  { symbol: "EWU", name: "Reino Unido", group: "region", country: "GBR" },
  { symbol: "EWG", name: "Alemania", group: "region", country: "DEU" },
  { symbol: "EWQ", name: "Francia", group: "region", country: "FRA" },
  { symbol: "EWI", name: "Italia", group: "region", country: "ITA" },
  { symbol: "EWP", name: "España", group: "region", country: "ESP" },
  { symbol: "EWL", name: "Suiza", group: "region", country: "CHE" },
  { symbol: "EWJ", name: "Japón", group: "region", country: "JPN" },
  { symbol: "MCHI", name: "China", group: "region", country: "CHN" },
  { symbol: "EWH", name: "Hong Kong", group: "region", country: "HKG" },
  { symbol: "EWT", name: "Taiwán", group: "region", country: "TWN" },
  { symbol: "EWY", name: "Corea del Sur", group: "region", country: "KOR" },
  { symbol: "INDA", name: "India", group: "region", country: "IND" },
  { symbol: "EWA", name: "Australia", group: "region", country: "AUS" },
  { symbol: "EWS", name: "Singapur", group: "region", country: "SGP" },
  { symbol: "EIDO", name: "Indonesia", group: "region", country: "IDN" },
  { symbol: "THD", name: "Tailandia", group: "region", country: "THA" },
  { symbol: "VNM", name: "Vietnam", group: "region", country: "VNM" },
  { symbol: "KSA", name: "Arabia Saudita", group: "region", country: "SAU" },
  { symbol: "TUR", name: "Turquía", group: "region", country: "TUR" },
  { symbol: "EZA", name: "Sudáfrica", group: "region", country: "ZAF" },
  { symbol: "EIS", name: "Israel", group: "region", country: "ISR" },
  { symbol: "EPOL", name: "Polonia", group: "region", country: "POL" },

  // Sectores S&P 500
  { symbol: "XLK", name: "Tecnología", group: "sector", risk: "on" },
  { symbol: "SMH", name: "Semiconductores", group: "sector", risk: "on" },
  { symbol: "XLC", name: "Comunicaciones", group: "sector", risk: "on" },
  { symbol: "XLY", name: "Consumo discrecional", group: "sector", risk: "on" },
  { symbol: "XLF", name: "Financiero", group: "sector", risk: "on" },
  { symbol: "XLI", name: "Industrial", group: "sector", risk: "on" },
  { symbol: "XLB", name: "Materiales", group: "sector", risk: "on" },
  { symbol: "XLE", name: "Energía", group: "sector" },
  { symbol: "XLV", name: "Salud", group: "sector", risk: "off" },
  { symbol: "XLP", name: "Consumo básico", group: "sector", risk: "off" },
  { symbol: "XLU", name: "Utilities", group: "sector", risk: "off" },
  { symbol: "XLRE", name: "Inmobiliario", group: "sector" },

  // Cripto
  { symbol: "BTC-USD", name: "Bitcoin", group: "crypto" },
  { symbol: "ETH-USD", name: "Ethereum", group: "crypto" },
  { symbol: "SOL-USD", name: "Solana", group: "crypto" },
  { symbol: "XRP-USD", name: "XRP", group: "crypto" },
  { symbol: "BNB-USD", name: "BNB", group: "crypto" },
  { symbol: "DOGE-USD", name: "Dogecoin", group: "crypto" },

  // Macro: solo precio (sin volumen relevante)
  { symbol: "^VIX", name: "Volatilidad S&P 500 (VIX)", group: "macro" },
  { symbol: "^TNX", name: "Rendimiento Tesoro 10 años", group: "macro" },
  { symbol: "^IRX", name: "Rendimiento Tesoro 3 meses", group: "macro" },
  { symbol: "DX-Y.NYB", name: "Índice dólar (DXY)", group: "macro" },
  { symbol: "EURUSD=X", name: "EUR/USD", group: "macro" },
  { symbol: "JPY=X", name: "USD/JPY", group: "macro" },
  { symbol: "CNY=X", name: "USD/CNY", group: "macro" },
  { symbol: "MXN=X", name: "USD/MXN", group: "macro" },
  { symbol: "GC=F", name: "Oro futuros", group: "macro" },
  { symbol: "CL=F", name: "Petróleo WTI futuros", group: "macro" },
  { symbol: "HG=F", name: "Cobre futuros", group: "macro" },
];

export const GROUP_LABELS: Record<Group, string> = {
  asset: "Clases de activo",
  region: "Regiones / países",
  sector: "Sectores EE.UU.",
  crypto: "Cripto",
  macro: "Macro y divisas",
};

export function uniqueSymbols(groups?: Group[]): string[] {
  const list = groups ? UNIVERSE.filter((i) => groups.includes(i.group)) : UNIVERSE;
  return [...new Set(list.map((i) => i.symbol))];
}
