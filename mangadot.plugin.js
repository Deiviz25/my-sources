// mangadot.net — Harbor MangaProvider plugin
// Reescrito a partir de un provider de Seanime (interfaz distinta: search/
// findChapters/findChapterPages con fetch+Referer). Harbor no tiene fetch
// ni permite mandar "referer" (lo quita de toda llamada harbor.http), así
// que además de adaptar la interfaz hubo que quitar esa cabecera.
//
// Verificado contra el HTML real de la portada (lo pegaste tú):
//   - Tarjeta de manga: <a class="group flex flex-col gap-1.5" href="/manga/ID">
//     ...<img src="COVER">...<div class="line-clamp-2 text-[12px]...">TÍTULO</div></a>
//   - Es EXACTAMENTE el mismo patrón que ya usaba el regex original de
//     search(), así que popular() reutiliza el mismo parser.
//
// NO verificado (heredado del provider original, sin HTML de esas rutas):
//   - Los campos del JSON de /api/manga/{id}/chapters/list y
//     /api/chapters/{id}/images (chapter_number, chapter_title,
//     scanlator_name, group_name, images[].url) — los mantengo tal cual
//     los tenía el autor original porque no tengo forma de confirmarlos
//     yo mismo, pero si esos campos cambiaron o nunca fueron correctos,
//     chapters()/pageUrls() devolverán vacío o datos raros.
//   - og:title/og:description/og:image en /manga/{id} para detail() — es
//     un patrón SSR estándar y la portada sí los trae, pero no cargué una
//     ficha de manga real para confirmarlo en esa ruta concreta.
//   - Si el CDN de imágenes de /api/chapters/.../images exige Referer,
//     pageUrls() puede fallar en Harbor igual que en leercapitulo — mismo
//     límite de host, no arreglable desde aquí (pageUrls() solo devuelve
//     string[], sin headers por imagen).
 
const BASE_URL = "https://mangadot.net";
const PAGE_SIZE = 48; // MANGA_PAGE: offset -> página
 
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
 
// --- helpers de red --------------------------------------------------------
 
async function fetchText(path) {
  const url = /^https?:\/\//i.test(path) ? path : `${BASE_URL}${path}`;
  const res = await harbor.http(url, {
    responseType: "text",
    headers: { "User-Agent": BROWSER_UA },
  });
  if (!res.ok) return null;
  return res.body;
}
 
async function fetchJson(path) {
  const url = /^https?:\/\//i.test(path) ? path : `${BASE_URL}${path}`;
  return harbor.http(url, {
    responseType: "json",
    headers: { "User-Agent": BROWSER_UA },
  });
}
 
function absoluteUrl(url) {
  if (!url) return undefined;
  try {
    return new URL(url, BASE_URL).toString();
  } catch (e) {
    return undefined;
  }
}
 
function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();
}
 
// --- tarjetas de manga (portada Y resultados de búsqueda comparten esta
// misma pinta, confirmado en el HTML real que pegaste) ----------------------
 
function parseMangaCards(html) {
  const results = [];
  const re =
    /<a\s+class="group flex flex-col gap-1\.5"\s+href="\/manga\/([^"]+)"[^>]*>[\s\S]*?<img\s+src="([^"]+)"[\s\S]*?<div class="line-clamp-2 text-\[12px\][^"]*">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push({ id: m[1], cover: m[2], title: decodeEntities(m[3].trim()) });
  }
  return results;
}
 
function dedupeById(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}
 
// --- MangaProvider -----------------------------------------------------
 
const plugin = {
  id: "mangadot",
  name: "MangaDot",
 
  // La portada mezcla varias secciones (Latest Updates, Most Tracked, Top
  // Rated, Recently Added); se combinan y deduplican por id. No hay
  // paginación real confirmada para esto (hay enlaces "Ver todo" a
  // /view-all/... que podrían pagninarse, pero no tengo su HTML), así que
  // offset > 0 devuelve vacío.
  async popular(offset, tagId) {
    if (offset > 0) return [];
 
    const html = await fetchText("/");
    if (!html) return [];
 
    const cards = dedupeById(parseMangaCards(html));
 
    return cards.slice(0, PAGE_SIZE).map((c) => ({
      id: c.id,
      title: c.title,
      cover: absoluteUrl(c.cover),
    }));
  },
 
  // El sitio soporta ?page=N (el provider original lo mandaba fijo a 1).
  // No sé cuántos resultados trae cada página suya, así que el mapeo
  // offset -> page es una aproximación, no un valor confirmado.
  async search(query, offset, tagId) {
    const page = Math.floor((offset || 0) / PAGE_SIZE) + 1;
    const html = await fetchText(`/search?search=${encodeURIComponent(query)}&page=${page}`);
    if (!html) return [];
 
    return parseMangaCards(html).map((c) => ({
      id: c.id,
      title: c.title,
      cover: absoluteUrl(c.cover),
    }));
  },
 
  // Best-effort: meta og:title/og:description/og:image en la ficha. Patrón
  // estándar de SSR (confirmado en la portada), sin confirmar en /manga/{id}
  // en concreto.
  async detail(id) {
    const html = await fetchText(`/manga/${id}`);
    if (!html) return null;
 
    const title = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
    const description = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1];
    const cover = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
 
    return {
      id,
      title: title ? decodeEntities(title) : id,
      description: description ? decodeEntities(description) : undefined,
      cover: absoluteUrl(cover),
    };
  },
 
  // Convertido de findChapters() del provider original. Los nombres de
  // campo del JSON (chapter_number, chapter_title, scanlator_name,
  // group_name) son los que ya traía ese código — no los he podido
  // verificar yo mismo contra una respuesta real.
  async chapters(id) {
    const json = await fetchJson(`/api/manga/${encodeURIComponent(id)}/chapters/list?lang=en`);
    const items = Array.isArray(json) ? json : [];
 
    const chapters = items
      .map((ch) => {
        const chId = ch?.id != null ? String(ch.id) : null;
        if (!chId) return null;
 
        const chapterNumber = ch?.chapter_number != null ? String(ch.chapter_number) : null;
        const title = ch?.chapter_title ? decodeEntities(String(ch.chapter_title)) : undefined;
        const group =
          (ch?.scanlator_name && String(ch.scanlator_name).trim()) ||
          (ch?.group_name && String(ch.group_name).trim()) ||
          undefined;
 
        return {
          id: chId,
          chapter: chapterNumber,
          title,
          pages: 0,
          language: ch?.language || "en",
          group,
        };
      })
      .filter(Boolean);
 
    chapters.sort((a, b) => parseFloat(a.chapter ?? "0") - parseFloat(b.chapter ?? "0"));
    return chapters;
  },
 
  // Convertido de findChapterPages(). Mismo aviso que arriba sobre el
  // campo images[].url, y mismo límite que en leercapitulo: si el CDN
  // exige Referer, esto puede fallar en Harbor sin que haya arreglo
  // posible desde el plugin (pageUrls() no admite headers por imagen).
  async pageUrls(chapterId) {
    const json = await fetchJson(`/api/chapters/${encodeURIComponent(chapterId)}/images`);
    const images = Array.isArray(json?.images) ? json.images : [];
 
    return images
      .map((img) => {
        const rel = img?.url;
        if (!rel) return null;
        return rel.startsWith("http") ? rel : `${BASE_URL}${rel}`;
      })
      .filter(Boolean);
  },
};
 
harbor.register(plugin);
 
// ---------------------------------------------------------------------------
// Dónde añadirlo en tu repo.json (junto a leercapitulo y novelcool):
//
// {
//   "name": "Mis Plugins para Harbor",
//   "plugins": [
//     { "id": "leercapitulo", "name": "LeerCapítulo", ... "entry": "leercapitulo.plugin.js" },
//     { "id": "novelcool", "name": "NovelCool", ... "entry": "novelcool.plugin.js" },
//     {
//       "id": "mangadot",
//       "name": "MangaDot",
//       "version": "1.0.0",
//       "lang": "en",
//       "nsfw": false,
//       "icon": "https://mangadot.net/mangadotnet-purple.svg",
//       "entry": "mangadot.plugin.js"
//     }
//   ]
// }
//
// Sube este archivo (mangadot.plugin.js) a la misma carpeta donde tienes
// repo.json y los otros dos .plugin.js, y ya debería instalarse igual que
// los otros dos.
// ---------------------------------------------------------------------------
