// Utilidades de texto para detectar temas: palabras clave, entidades y categoría aproximada.

const STOP = new Set(`a al algo algunas algunos ante antes como con contra cual cuando de del desde donde dos el ella ellas ellos en entre era es esa ese eso esta este esto estos fue fueron ha han hasta hay la las le les lo los mas más me mi mientras muy nada ni no nos o otra otro para pero por porque que qué quien se ser si sí sin sobre su sus tambien también tiene todo tras tu un una uno unos y ya yo será sera son está están estan tras dice dijo según segun año años hoy ayer mañana nuevo nueva nuevos video fotos así asi cómo como qué the of and to in for on with at by from is are was this that new after over about how why what will`.split(/\s+/));

export const normalize = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function stripHtml(s: string) {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

/** Frases con mayúscula inicial (nombres propios): "Miss Universo", "Bad Bunny", "Reserva Federal". */
export function entities(title: string): string[] {
  const words = title.replace(/[“”"«»¿?¡!:;,.()|]/g, " ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) {
      const phrase = normalize(cur.join(" "));
      if (!(cur.length === 1 && STOP.has(phrase)) && phrase.length >= 3) out.push(phrase);
    }
    cur = [];
  };
  words.forEach((w, i) => {
    const cap = /^[A-ZÁÉÍÓÚÑ][\p{L}\d]+/u.test(w) || /^[A-Z]{2,}$/.test(w);
    const connector = cur.length > 0 && ["de", "del", "la", "las", "los", "y"].includes(w);
    if (cap && !(i === 0 && STOP.has(normalize(w)))) cur.push(w);
    else if (connector) cur.push(w);
    else flush();
  });
  flush();
  // Quitar conectores sueltos al final
  return [...new Set(out.map((p) => p.replace(/\s+(de|del|la|las|los|y)$/, "")))];
}

export function keywords(title: string, summary = ""): string[] {
  const ents = entities(title);
  const tokens = normalize(`${title} ${summary.slice(0, 280)}`)
    .split(/[^a-z0-9ñ]+/)
    .filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t));
  return [...new Set([...ents, ...tokens])].slice(0, 25);
}

const CATEGORY_WORDS: Record<string, string[]> = {
  politica: ["presidente", "eleccion", "elecciones", "asamblea", "congreso", "gobierno", "ministro", "candidato", "senado", "noboa", "petro", "reforma", "consulta", "alcalde", "partido"],
  deportes: ["futbol", "partido", "seleccion", "liga", "gol", "mundial", "copa", "libertadores", "tenis", "formula", "nba", "real madrid", "barcelona", "eliminatorias", "olimpicos", "boxeo"],
  cripto: ["bitcoin", "btc", "ethereum", "cripto", "criptomoneda", "blockchain", "solana", "token", "binance"],
  economia: ["inflacion", "economia", "pib", "desempleo", "tasa", "banco central", "reserva federal", "petroleo", "aranceles", "impuestos", "fmi"],
  finanzas: ["bolsa", "acciones", "nasdaq", "s&p", "dow jones", "oro", "dolar", "wall street", "inversion"],
  tecnologia: ["apple", "google", "microsoft", "inteligencia artificial", "openai", "iphone", "tesla", "nvidia", "meta", "samsung", "chip", "tecnologia"],
  entretenimiento: ["pelicula", "serie", "netflix", "oscar", "cine", "estreno", "disney", "hbo", "taquilla", "emmy"],
  musica: ["cancion", "album", "concierto", "gira", "spotify", "grammy", "reggaeton", "bad bunny", "karol g", "shakira", "billboard"],
  farandula: ["famoso", "famosa", "actriz", "actor", "influencer", "boda", "romance", "divorcio", "embarazo", "reality", "polemica", "novio", "novia"],
  moda: ["moda", "pasarela", "fashion", "vogue", "disenador", "coleccion", "met gala", "tendencia"],
  reinados: ["miss universo", "miss mundo", "reina", "reinado", "certamen", "corona", "miss"],
  clima: ["lluvia", "clima", "huracan", "tormenta", "sequia", "inundacion", "temperatura", "fenomeno del nino", "nina", "terremoto", "volcan", "sismo"],
  internacional: ["estados unidos", "china", "rusia", "ucrania", "europa", "onu", "guerra", "israel", "trump", "otan"],
  redes: ["tiktok", "instagram", "viral", "youtube", "seguidores", "streamer", "twitch", "x.com", "tendencia en redes"],
  sociedad: [],
};

export function classify(text: string, fallback = "sociedad"): string {
  const t = normalize(text);
  let best = fallback, bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    const score = words.reduce((a, w) => a + (t.includes(w) ? (w.includes(" ") ? 2 : 1) : 0), 0);
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
}
