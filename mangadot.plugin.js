// mangadot.net — Harbor MangaProvider plugin
//
// El sitio es una SPA en React (React Router SSR), NO WordPress. Rutas:
//   Home:      /                    -> cards <a href="/manga/{id}">
//   Ficha:     /manga/{id}
//   Capítulo:  /chapter/{id}?source={source}   (todo el contenido se monta
//              por JS del lado cliente; el HTML inicial solo trae un spinner)
//
// CONFIRMADO contra HTML real:
//   - Home: cada card es <a class="group flex flex-col gap-1.5" href="/manga/{id}">
//     con <img src="..."> y el título en <div class="line-clamp-2 ... text-[#fafafa]">Título</div>.
//     El capítulo más reciente aparece como "Ch <!-- -->N" (comentario HTML en medio).
//   - Ficha (/manga/{id}): <h1 class="text-2xl md:text-[30px] ...">Título</h1>,
//     portada en <img ... class="h-full w-full object-cover transition-all duration-200"/>
//     dentro del contenedor con ring-1 ring-white/10, meta og:description para la sinopsis,
//     badge de estado (Ongoing/Completed/...) en un <span> con clases "rounded-full ... border",
//     autor/artista como <a href="/search?author=Nombre">Nombre</a> /
//     <a href="/search?artist=Nombre">Nombre</a>, géneros como
//     <a href="/search?search=Genero">Genero</a>.
//
// CONFIRMADO contra respuestas JSON reales (capturas de red del usuario):
//   - Lista de capítulos: un array plano de objetos
//     { id, chapter_number, chapter_title, language, page_count, group_name,
//       uploader_username, date_added, source, ... }
//     Viene en orden ASCENDENTE (cap 1, 2, 3...) tal como se capturó.
//   - Detalle de capítulo (páginas): objeto
//     { chapter: {...}, manga: {...}, images: [{ url, w, h, filename }, ...],
//       prev_chapter_id, next_chapter_id, prev_source, next_source, source }
//     "images[].url" son rutas relativas tipo
//     "/chapters/manga_{mangaId}/chapter_{n}_g{groupId}/001.webp".
//
// ASUMIDO (forma de los datos confirmada, pero la URL exacta de la petición NO
// se capturó — solo se vio el body de la respuesta). Se construye siguiendo el
// mismo patrón de rutas que el resto del sitio (/manga/{id}, /chapter/{id}?source=X).
// Si el endpoint real difiere, solo hace falta ajustar CHAPTERS_ENDPOINT /
// CHAPTER_DETAIL_ENDPOINT de abajo.
function chaptersEndpoint(mangaId) {
  return `/api/manga/${mangaId}/chapters`;
}
function chapterDetailEndpoint(chapterId, source) {
  return `/api/chapter/${chapterId}?source=${encodeURIComponent(source || "user")}`;
}

const BASE_URL = "https://mangadot.net";

// --- Helpers de red -------------------------------------------------------

async function fetchText(path) {
  try {
    const res = await harbor.http(`${BASE_URL}${path}`, { responseType: "text" });
    if (!res.ok) return null;
    return res.body;
  } catch (e) {
    return null;
  }
}

async function fetchJson(path) {
  try {
    // OJO (mismo detalle que en mangalect): con responseType "json",
    // harbor.http devuelve el JSON ya parseado directamente, no un objeto
    // {status, ok, body}. No comprobar .ok/.body aquí.
    const json = await harbor.http(`${BASE_URL}${path}`, { responseType: "json" });
    return json;
  } catch (e) {
    return null;
  }
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
    .replace(/\s+/g, " ")
    .trim();
}

// --- helpers de parsing de atributos/tags (independientes del orden) ------

function getAttr(tagStr, attrName) {
  const re = new RegExp(`${attrName}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = tagStr.match(re);
  return m ? m[1] : undefined;
}

// --- MangaProvider -----------------------------------------------------

const plugin = {
  id: "mangadot",
  name: "MangaDot",

  // Confirmado: la home lista cards <a href="/manga/{id}"> con clase "group
  // flex flex-col gap-1.5". No hay paginación real conocida en la home (no
  // se capturó ninguna); offset > 0 devuelve vacío por ahora.
  async popular(offset, tagId) {
    if (offset > 0) return [];

    const html = await fetchText("/");
    if (!html) return [];

    const results = [];
    const seen = new Set();

    // Cada card empieza con <a class="group flex flex-col gap-1.5" href="/manga/ID" ...>
    const blocks = html.split(/(?=<a class="group flex flex-col gap-1\.5")/);

    for (const block of blocks) {
      const aTagMatch = block.match(/^<a\b[^>]*>/);
      if (!aTagMatch) continue;
      const aTag = aTagMatch[0];

      const href = getAttr(aTag, "href");
      if (!href || !/^\/manga\/\d+$/.test(href) || seen.has(href)) continue;

      const closeIdx = block.search(/<\/a>/);
      const inner = closeIdx >= 0 ? block.slice(0, closeIdx) : block;

      const imgTag = (inner.match(/<img\b[^>]*>/) || [])[0];
      const img = imgTag ? getAttr(imgTag, "src") : undefined;

      const titleMatch = inner.match(
        /<div class="line-clamp-2[^"]*text-\[#fafafa\][^"]*">([^<]+)<\/div>/,
      );
      const title = titleMatch ? decodeEntities(titleMatch[1]) : undefined;
      if (!title) continue;

      seen.add(href);
      results.push({
        id: href.replace(/^\/manga\//, ""),
        title,
        cover: absoluteUrl(img),
      });
    }

    return results;
  },

  async _byGenre(tagId, offset) {
    // No confirmado: no se capturó ninguna petición de filtrado por género.
    if (offset > 0) return [];
    return [];
  },

  // No confirmado contra red real (no se capturó una búsqueda). Se deja
  // deshabilitado en vez de adivinar un endpoint, para no dar resultados
  // falsos silenciosamente.
  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);
    return [];
  },

  // Confirmado contra HTML real de /manga/{id}.
  async detail(id) {
    const html = await fetchText(`/manga/${id}`);
    if (!html) return null;

    const titleMatch = html.match(
      /<h1 class="text-2xl md:text-\[30px\][^"]*">([^<]+)<\/h1>/,
    );
    const title = titleMatch ? decodeEntities(titleMatch[1]) : String(id);

    // Portada: primer <img> dentro del contenedor con ring-1 ring-white/10.
    let cover;
    const coverBlockMatch = html.match(
      /ring-1 ring-white\/10[^"]*"[^>]*>[\s\S]*?<img\b[^>]*>/,
    );
    if (coverBlockMatch) {
      const imgTag = (coverBlockMatch[0].match(/<img\b[^>]*>/) || [])[0];
      if (imgTag) cover = absoluteUrl(getAttr(imgTag, "src"));
    }

    // Sinopsis: meta og:description es más fiable que el bloque del DOM
    // (que trunca visualmente con "Read More").
    const descMatch = html.match(
      /<meta property="og:description" content="([^"]*)"\/>/,
    );
    const description = descMatch ? decodeEntities(descMatch[1]) : undefined;

    // Estado: badge con texto plano dentro del span de estado.
    const statusMatch = html.match(
      /<span class="inline-flex items-center gap-1\.5 px-2\.5 py-0\.5 rounded-full text-xs font-bold border[^"]*">(?:<span[^>]*><\/span>)?([^<]+)<\/span>/,
    );
    const statusRaw = statusMatch ? statusMatch[1].trim().toLowerCase() : "";
    let status;
    if (statusRaw.includes("ongoing")) status = "ongoing";
    else if (statusRaw.includes("completed")) status = "completed";
    else if (statusRaw.includes("hiatus")) status = "hiatus";
    else if (statusRaw.includes("cancel")) status = "cancelled";

    const author = (html.match(/<a[^>]*href="\/search\?author=[^"]*"[^>]*>([^<]+)<\/a>/) || [])[1];
    const artist = (html.match(/<a[^>]*href="\/search\?artist=[^"]*"[^>]*>([^<]+)<\/a>/) || [])[1];

    const chapters = await plugin.chapters(id);
    const lastChapter = chapters.length
      ? chapters[chapters.length - 1].chapter
      : undefined;

    return {
      id: String(id),
      title,
      cover,
      description,
      author: author ? decodeEntities(author) : undefined,
      artist: artist ? decodeEntities(artist) : undefined,
      status,
      lastChapter,
    };
  },

  // CONFIRMADO (forma de datos) contra respuesta JSON real: array plano de
  // capítulos ya en orden ascendente, con id/chapter_number/chapter_title/
  // page_count/language/date_added/source. La URL del endpoint es ASUMIDA
  // (ver chaptersEndpoint arriba) — la forma del array sí es 100% real.
  async chapters(id) {
    const json = await fetchJson(chaptersEndpoint(id));
    if (!Array.isArray(json)) return [];

    return json.map((ch) => ({
      // El id de capítulo de Harbor debe llevar suficiente info para
      // reconstruir la petición de páginas: guardamos "chapterId:source".
      id: `${ch.id}:${ch.source || "user"}`,
      chapter: String(ch.chapter_number),
      title: ch.chapter_title ? decodeEntities(ch.chapter_title) : `Chapter ${ch.chapter_number}`,
      pages: typeof ch.page_count === "number" ? ch.page_count : 0,
      language: ch.language || "en",
    }));
  },

  // CONFIRMADO (forma de datos) contra dos respuestas JSON reales:
  // { images: [{ url, w, h, filename }, ...], ... }. "url" es relativa al
  // dominio. La URL del endpoint de detalle es ASUMIDA (ver
  // chapterDetailEndpoint arriba).
  async pageUrls(chapterId) {
    const [rawId, source] = String(chapterId).split(":");
    const json = await fetchJson(chapterDetailEndpoint(rawId, source));
    if (!json || !Array.isArray(json.images)) return [];

    return json.images.map((img) => absoluteUrl(img.url)).filter(Boolean);
  },

  // No confirmado contra red/HTML real (no se vio una página de géneros).
  async tags() {
    return [];
  },
};

harbor.register(plugin);
