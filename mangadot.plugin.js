// mangadot.net — Harbor MangaProvider plugin
//
// Migrado desde un provider de Seanime (formato distinto: usa fetch directo,
// class Provider, devuelve campos como `image`/`synonyms` en vez del shape
// de Harbor). Esto NO es un port 1:1 — Harbor exige otra interfaz, otro
// bridge de red (harbor.http, no fetch) y otro shape de retorno, así que
// cada método se reescribió desde cero contra esa interfaz.
//
// ✅ Confirmado contra HTML real (portada, ficha de "Drawn to the Fire",
// página de lectura del capítulo 15):
//   - Portada: tarjetas <a class="group flex flex-col gap-1.5"
//     href="/manga/ID">...<img src="PORTADA">...<div class="line-clamp-2
//     ...">TÍTULO</div></a> en las secciones "Latest Updates", "Recently
//     Added", "Most Tracked" y "Top Rated" — SÍ vienen en el HTML inicial
//     (no solo en el JSON de hidratación de React), así que se pueden leer
//     con regex sin ejecutar JS.
//   - Ficha: título en <h1 class="text-2xl ... font-black text-white...">,
//     portada en el <img loading="eager" fetchPriority="high">, sinopsis en
//     el div de resumen, estado junto al punto de color (Ongoing/Completed),
//     autor en la fila "Author" de la barra lateral.
//   - Los géneros de una ficha enlazan a /search?search=<Género> — confirma
//     que filtrar por género en este sitio ES una búsqueda por ese texto,
//     no un slug de categoría aparte. tags()/_byGenre() usan justo eso.
//
// ⚠️ SIN CONFIRMAR — heredado del provider de Seanime original, no
// verificado por mí contra una respuesta real:
//   1. chapters() y pageUrls() NO tocan HTML: usan las mismas rutas de API
//      que ya traía el provider de Seanime
//      (/api/manga/{id}/chapters/list?lang=en y
//      /api/chapters/{id}/images). La página de ficha SÍ confirma que existe
//      una carga asíncrona ahí (el tab de capítulos muestra un spinner
//      "Loading chapters..." en vez de venir en el HTML), así que una API así
//      existe seguro — pero no vi la respuesta JSON real, solo heredé el
//      parseo que ya traía el provider (campos chapter_number,
//      chapter_title, scanlator_name/group_name, language, images[].url).
//      Si chapters()/pageUrls() devuelven vacío, es la primera zona a
//      revisar con una captura real de esas dos respuestas.
//   2. /search?search=...&page=N: el patrón viene del provider original;
//      no tengo el HTML de una página de resultados real para confirmar
//      que reutiliza la misma tarjeta que la portada (la sección "You may
//      also like" de la ficha usa una tarjeta distinta, más pequeña, así
//      que no puedo asumir que todas las tarjetas del sitio son iguales).
//      Si search()/tags() no devuelven nada, esto es lo primero a revisar.
//   3. tags(): no había ninguna página de categorías/géneros en lo que me
//      pasaste, así que esta lista es una selección manual armada con los
//      géneros que sí aparecieron en las muestras (ficha + JSON de
//      hidratación de la portada). Seguro que faltan géneros del catálogo
//      real — mándame el HTML de la página de categorías si existe.
//
// ⚠️ Igual que con leercapitulo: el provider original mandaba `Referer` a
// mano en cada fetch (típico de APIs con protección anti-hotlink). Harbor
// elimina esa cabecera de toda llamada harbor.http sin excepción — si
// /api/chapters/{id}/images la exige, las imágenes fallarán y no hay forma
// de arreglarlo desde este archivo.
 
const BASE_URL = "https://mangadot.net";
const PAGE_SIZE = 48; // MANGA_PAGE: offset -> página
 
// --- helpers de red --------------------------------------------------------
 
async function fetchText(path) {
  const res = await harbor.http(`${BASE_URL}${path}`, { responseType: "text" });
  if (!res.ok) return null;
  return res.body;
}
 
async function fetchJson(path) {
  return harbor.http(`${BASE_URL}${path}`, { responseType: "json" });
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
    .replace(/&#x27;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/<!--\s*-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
 
// --- tarjetas de manga (portada / búsqueda / género) ------------------------
// Confirmado contra la portada real: <a class="group flex flex-col
// gap-1.5" href="/manga/ID">...<img src="COVER">...<div
// class="line-clamp-2 ...">TÍTULO</div></a>. El id que guardamos es solo el
// número (p. ej. "23467"), porque las rutas de la API de capítulos/páginas
// heredadas del provider de Seanime lo usan tal cual, sin el prefijo
// "/manga/".
function parseMangaCards(html) {
  const cardRe =
    /<a class="group flex flex-col gap-1\.5" href="\/manga\/(\d+)"[^>]*>[\s\S]*?<img src="([^"]+)"[\s\S]*?<div class="line-clamp-2[^"]*">([\s\S]*?)<\/div><\/a>/g;
 
  const seen = new Set();
  const results = [];
 
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const id = m[1];
    const cover = m[2];
    const title = decodeEntities(m[3]);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
 
    results.push({ id, title, cover: absoluteUrl(cover) });
  }
 
  return results;
}
 
// --- MangaProvider -----------------------------------------------------
 
const plugin = {
  id: "mangadot",
  name: "MangaDot",
 
  // La portada trae 4 secciones curadas (Latest Updates, Recently Added,
  // Most Tracked, Top Rated) confirmadas contra HTML real; se combinan y
  // deduplican por id. No hay paginación de portada, así que offset > 0
  // pasa a usar /search con página calculada como fallback best-effort
  // (ver aviso #2 al inicio del archivo).
  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset);
    if (offset > 0) return [];
 
    const html = await fetchText("/");
    if (!html) return [];
 
    return parseMangaCards(html).slice(0, PAGE_SIZE);
  },
 
  // ⚠️ Sin confirmar (aviso #2): asumo que /search reutiliza la misma
  // tarjeta que la portada.
  async _byGenre(tagId, offset) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const html = await fetchText(`/search?search=${encodeURIComponent(tagId)}&page=${page}`);
    if (!html) return [];
    return parseMangaCards(html).slice(0, PAGE_SIZE);
  },
 
  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);
 
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const html = await fetchText(`/search?search=${encodeURIComponent(query)}&page=${page}`);
    if (!html) return [];
 
    return parseMangaCards(html).slice(0, PAGE_SIZE);
  },
 
  async detail(id) {
    const html = await fetchText(`/manga/${id}`);
    if (!html) return null;
 
    const titleMatch = html.match(
      /<h1 class="text-2xl md:text-\[30px\] font-black text-white[^"]*">([^<]+)<\/h1>/,
    );
    const coverMatch = html.match(
      /<img src="([^"]+)"[^>]*loading="eager" fetchPriority="high"/,
    );
    const statusMatch = html.match(
      /<span class="w-1\.5 h-1\.5 rounded-full bg-[a-z]+-500"><\/span>([^<]+)<\/span>/,
    );
    const descMatch = html.match(
      /<div class="text-sm text-white\/60 leading-\[1\.7\][^"]*">\s*<div>([\s\S]*?)<\/div>\s*<\/div>/,
    );
    const authorMatch = html.match(
      /Author<\/span><span[^>]*>(?:<span[^>]*>)?<a[^>]*>([^<]+)<\/a>/,
    );
 
    const description = descMatch
      ? decodeEntities(descMatch[1].replace(/<br\s*\/?>/gi, "\n"))
      : undefined;
 
    const chapters = await plugin.chapters(id);
    const lastChapter = chapters.length
      ? chapters[chapters.length - 1].chapter
      : undefined;
 
    return {
      id,
      title: titleMatch ? decodeEntities(titleMatch[1]) : id,
      cover: absoluteUrl(coverMatch?.[1]),
      description,
      status: statusMatch ? decodeEntities(statusMatch[1]).toLowerCase() : undefined,
      author: authorMatch ? decodeEntities(authorMatch[1]) : undefined,
      lastChapter,
    };
  },
 
  // ⚠️ Sin confirmar contra una respuesta real (aviso #1). La ficha SÍ
  // confirma que esta carga es asíncrona (spinner "Loading chapters..."),
  // así que la API existe; el parseo de campos viene heredado del
  // provider de Seanime.
  async chapters(id) {
    const json = await fetchJson(`/api/manga/${id}/chapters/list?lang=en`);
    const items = Array.isArray(json) ? json : [];
 
    const chapters = items
      .map((ch) => {
        const chId = ch?.id != null ? String(ch.id) : null;
        if (!chId) return null;
 
        const number = ch?.chapter_number != null ? String(ch.chapter_number) : null;
        const title = ch?.chapter_title ? decodeEntities(String(ch.chapter_title)) : undefined;
        const group =
          (ch?.scanlator_name && String(ch.scanlator_name).trim()) ||
          (ch?.group_name && String(ch.group_name).trim()) ||
          undefined;
 
        return {
          id: chId,
          chapter: number,
          title,
          pages: 0,
          language: ch?.language ? String(ch.language) : "en",
          group,
        };
      })
      .filter(Boolean);
 
    chapters.sort((a, b) => parseFloat(a.chapter ?? "0") - parseFloat(b.chapter ?? "0"));
    return chapters;
  },
 
  // ⚠️ Sin confirmar (aviso #1 y aviso sobre Referer al inicio del archivo).
  async pageUrls(chapterId) {
    const json = await fetchJson(`/api/chapters/${chapterId}/images`);
    const images = Array.isArray(json?.images) ? json.images : [];
 
    return images
      .map((img) => absoluteUrl(img?.url))
      .filter(Boolean);
  },
 
  // ⚠️ Lista armada a mano con los géneros vistos en las muestras (aviso #3),
  // no scrapeada de una página de categorías real. El id es literalmente el
  // texto que el sitio espera en /search?search=<id> — confirmado porque
  // los enlaces de género de la ficha usan ese mismo patrón.
  async tags() {
    const GENRES = [
      "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Sci-Fi",
      "Slice of Life", "Sports", "School Life", "Shounen", "Shoujo",
      "Seinen", "Josei", "Isekai", "Mecha", "Horror", "Mystery",
      "Psychological", "Romance", "Supernatural", "Tragedy", "Ecchi",
      "Harem", "Mature", "Adult", "Boys Love", "Girls Love", "Historical",
      "Martial Arts", "Military", "Crime", "Thriller",
    ];
 
    return GENRES.map((name) => ({ id: name, name }));
  },
};
 
harbor.register(plugin);
