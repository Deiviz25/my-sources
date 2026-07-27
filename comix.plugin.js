// mangalect.org — Harbor MangaProvider plugin
//
// Selectores confirmados contra HTML real (home, ficha /info/, capítulo /lectura/):
//   - Home:     div.manga-card-v2 > a[href^="/info/"] (+ img.lazy-load[data-src],
//               h3.overlay-text-title, .format-badge), y script#ssr-trends-data (JSON)
//   - Ficha:    h1.manga-title, img.manga-cover, ul.alternate-titles > li,
//               #info-generos a.genero-item, #info-block .status-text,
//               #synopsis-text, #chapter-list .chapter-card a.chapter-link[data-chapter]
//   - Capítulo: <script> inline con Config.paginasRutas (array plano de rutas,
//               SIN cifrado) + Config.B2_URL. Confirmado contra un capítulo real
//               (he-perdido-la-cabeza-otra-vez / cap 1, 21 páginas).
//
// ASUMIDO (sin HTML real que lo confirme):
//   - search(): el endpoint es data-search-url="/api/api/busqueda-rapida/" (confirmado
//     que existe), pero NO tengo la forma de su respuesta JSON (nombres de campo).
//     Implementado con varios nombres de campo candidatos (title/titulo, cover/portada,
//     etc.) por robustez, pero sin poder verificar cuál usa el sitio real.
//   - tags(): no vi /listas/ ni un listado completo de géneros del sitio. Lo construyo
//     recolectando los .genero-item que aparecen en fichas ya visitadas, lo cual es
//     incompleto por diseño. Si tienes el HTML de /listas/, lo cierro bien.
//   - Paginación de /biblioteca/ (para popular() con offset>0): no confirmada. Por
//     ahora offset>0 devuelve [] en vez de arriesgarme a repetir contenido.
//   - status(): solo vi "En curso" en la ficha de ejemplo. Mapeo por keyword;
//     "completado"/"finalizado" no están confirmados contra HTML real.
//
// ⚠️ LÍMITE CONOCIDO: el capítulo de ejemplo (21 páginas) no muestra CDN con
// protección por Referer -- las imágenes cargan directo desde images.mangalect.org.
// Si otro manga/capítulo sí la tuviera, pageUrls() en Harbor solo puede devolver
// string[] sin headers por imagen, así que no habría forma de arreglarlo desde aquí.
//
// ⚠️ La lista de capítulos viene en orden descendente (más nuevo primero) en el
// HTML — se invierte en chapters() para devolverla ascendente.

const BASE_URL = "https://mangalect.org";

// --- Helpers de red y utilidades -------------------------------------------

async function fetchText(path) {
  try {
    const res = await harbor.http(`${BASE_URL}${path}`, {
      responseType: "text",
      headers: { Referer: `${BASE_URL}/` },
    });
    if (!res.ok) return null;
    return res.body;
  } catch (e) {
    return null;
  }
}

async function fetchJson(url) {
  try {
    const res = await harbor.http(url, {
      responseType: "json",
      headers: { Referer: `${BASE_URL}/` },
    });
    if (!res.ok) return null;
    return res.body;
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
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// slug a partir de "/info/SLUG/"
function slugFromInfoHref(href) {
  const parts = href.split("/").filter(Boolean); // ["info", slug]
  return parts[1] || href;
}

// --- parseo de tarjetas de manga (reutilizable: home, tendencias) ----------
// Confirmado: cada tarjeta es div.manga-card-v2 > a[href^="/info/"], con
// img.lazy-load[data-src] (el src es un placeholder base64, se ignora) y
// h3.overlay-text-title. El .format-badge (manga/manhwa/manhua) y el
// .demographic-badge no se exponen en la interfaz Harbor, así que no se usan.
function parseMangaCards(html) {
  if (!html) return [];
  const results = [];
  const cardRe =
    /<div class="manga-card-v2">\s*<a href="(\/info\/[^"]+\/)">[\s\S]*?<img[^>]*data-src="([^"]+)"[\s\S]*?<h3 class="overlay-text-title">([^<]+)<\/h3>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    results.push({
      href: m[1],
      cover: m[2],
      title: decodeEntities(m[3]),
    });
  }
  return results;
}

// Bloque "Impulsados": a.featured-score-card
function parseFeaturedCards(html) {
  if (!html) return [];
  const results = [];
  const cardRe =
    /<a href="(\/info\/[^"]+\/)" class="featured-score-card[^"]*">[\s\S]*?<img[^>]*data-src="([^"]+)"[\s\S]*?<h3 class="score-card-title">([^<]+)<\/h3>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    results.push({
      href: m[1],
      cover: m[2],
      title: decodeEntities(m[3]),
    });
  }
  return results;
}

// script#ssr-trends-data: JSON ya estructurado para la sección de Tendencias.
// Confirmado en el HTML real de la home. Preferido sobre el parseo por regex
// cuando está disponible, porque es más robusto a cambios de markup.
function parseTrendsJson(html) {
  if (!html) return [];
  const m = html.match(
    /<script id="ssr-trends-data" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) return [];
  try {
    const data = JSON.parse(m[1]);
    if (!Array.isArray(data)) return [];
    return data.map((item) => ({
      href: `/info/${item.slug}/`,
      cover: `https://images.mangalect.org/file/leermangaesp/${item.portada}`,
      title: decodeEntities(item.titulo),
    }));
  } catch (e) {
    return [];
  }
}

function dedupeCardsBySlug(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    const slug = slugFromInfoHref(c.href);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(c);
  }
  return out;
}

// --- MangaProvider -----------------------------------------------------

const plugin = {
  id: "mangalect",
  name: "MangaLect",

  // Confirmado: la home no expone paginación real conocida (no vi ?page=N
  // en biblioteca todavía). offset > 0 devuelve [] para no repetir contenido.
  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset);
    if (offset > 0) return [];

    const html = await fetchText("/");
    if (!html) return [];

    // Prioriza el JSON de tendencias (más fiable); si falla, cae a regex del DOM.
    let cards = parseTrendsJson(html);
    if (cards.length === 0) {
      cards = dedupeCardsBySlug([
        ...parseFeaturedCards(html),
        ...parseMangaCards(html),
      ]);
    }

    return cards.map((c) => ({
      id: slugFromInfoHref(c.href),
      title: c.title,
      cover: absoluteUrl(c.cover),
    }));
  },

  // ASUMIDO: no tengo HTML real de /biblioteca/?generos=X para confirmar que
  // esta ruta devuelve tarjetas con el mismo markup que la home. Lo sé porque
  // el enlace de género en la ficha apunta a /biblioteca/?generos={nombre},
  // pero no vi el resultado. Si no trae nada, revisar contra HTML real.
  async _byGenre(tagId, offset) {
    if (offset > 0) return [];
    const html = await fetchText(`/biblioteca/?generos=${encodeURIComponent(tagId)}`);
    if (!html) return [];

    const cards = dedupeCardsBySlug([
      ...parseFeaturedCards(html),
      ...parseMangaCards(html),
    ]);

    return cards.map((c) => ({
      id: slugFromInfoHref(c.href),
      title: c.title,
      cover: absoluteUrl(c.cover),
    }));
  },

  // ASUMIDO: confirmé la URL del endpoint (data-search-url) pero no la forma
  // de su JSON. Pruebo varios nombres de campo candidatos por robustez.
  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);
    if (!query) return [];

    const json = await fetchJson(
      `${BASE_URL}/api/api/busqueda-rapida/?q=${encodeURIComponent(query)}`,
    );
    if (!json) return [];

    const rawList = Array.isArray(json)
      ? json
      : json.results || json.data || json.items || [];

    const results = [];
    for (const item of rawList) {
      const slugOrHref =
        item.slug ||
        item.href ||
        item.link ||
        item.url;
      if (!slugOrHref) continue;

      const id = slugOrHref.includes("/")
        ? slugFromInfoHref(slugOrHref)
        : slugOrHref;

      const title = item.titulo || item.title || item.nombre || item.name;
      if (!title) continue;

      const cover =
        item.portada || item.cover || item.image || item.img || item.thumbnail;

      results.push({
        id,
        title: decodeEntities(title),
        cover: cover
          ? absoluteUrl(
              cover.startsWith("http")
                ? cover
                : `https://images.mangalect.org/file/leermangaesp/${cover}`,
            )
          : undefined,
      });
    }

    return results.slice(offset, offset + 24);
  },

  async detail(id) {
    const html = await fetchText(`/info/${id}/`);
    if (!html) return null;

    const titleMatch = html.match(/<h1 class="manga-title">([^<]+)<\/h1>/);
    const title = titleMatch ? decodeEntities(titleMatch[1]) : id;

    const coverMatch = html.match(/<img src="([^"]+)" alt="[^"]*" class="manga-cover">/);
    const cover = absoluteUrl(coverMatch?.[1]);

    const altTitlesMatch = html.match(
      /<ul class="info-value alternate-titles">([\s\S]*?)<\/ul>/,
    );
    let altTitle;
    if (altTitlesMatch) {
      const items = [...altTitlesMatch[1].matchAll(/<li>([^<]+)<\/li>/g)].map((m) =>
        decodeEntities(m[1]),
      );
      altTitle = items.length ? items.join(", ") : undefined;
    }

    const descMatch = html.match(/<p id="synopsis-text">([\s\S]*?)<\/p>/);
    const description = descMatch
      ? decodeEntities(descMatch[1].replace(/\s+/g, " "))
      : undefined;

    const statusMatch = html.match(/<span class="info-value status-text">\s*([^<]+?)\s*<\/span>/);
    const statusRaw = statusMatch ? statusMatch[1].trim().toLowerCase() : "";
    let status;
    if (statusRaw.includes("curso")) status = "ongoing";
    // ASUMIDO: no confirmado contra HTML real, keyword por analogía.
    else if (statusRaw.includes("complet") || statusRaw.includes("finaliz")) status = "completed";

    // El sitio no publica autor en la ficha (no hay campo "Autor" en el HTML visto).
    const author = undefined;

    const chapterList = await plugin.chapters(id, html);
    const lastChapter = chapterList.length
      ? chapterList[chapterList.length - 1].chapter
      : undefined;

    return {
      id,
      title,
      altTitle,
      cover,
      description,
      status,
      lastChapter,
      author,
    };
  },

  // Confirmado: #chapter-list .chapter-card a.chapter-link[data-chapter][href],
  // con .chapter-title y .chapter-date. Viene en orden descendente en el HTML
  // (cap. más nuevo primero) -> se invierte para devolver ascendente.
  async chapters(id, cachedHtml) {
    const html = cachedHtml || (await fetchText(`/info/${id}/`));
    if (!html) return [];

    const found = [];
    const cardRe =
      /<a href="(\/lectura\/[^"]+\/)" class="chapter-link"\s+data-chapter="([^"]+)"[^>]*>[\s\S]*?<div class="chapter-title">([^<]*)<\/div>/g;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      found.push({
        id: m[1],
        chapter: m[2],
        title: decodeEntities(m[3]),
        pages: 0, // el número de páginas no se expone en la ficha, solo en el capítulo
        language: "es",
      });
    }

    return found.reverse();
  },

  // Confirmado contra un capítulo real: Config.paginasRutas + Config.B2_URL
  // en un <script> inline, sin cifrado. Coincide con el orden de
  // #cascade-view img.manga-image (verificado: mismos 21 archivos, mismo orden).
  async pageUrls(chapterId) {
    const html = await fetchText(chapterId);
    if (!html) return [];

    const b2Match = html.match(/B2_URL:\s*"([^"]+)"/);
    const rutasMatch = html.match(/paginasRutas:\s*(\[[^\]]*\])/);

    if (b2Match && rutasMatch) {
      try {
        const rutas = JSON.parse(rutasMatch[1]);
        if (Array.isArray(rutas) && rutas.length > 0) {
          return rutas.map((r) => `${b2Match[1]}/${r}`);
        }
      } catch (e) {
        // cae al método por DOM si el JSON inline no parsea
      }
    }

    // Fallback: leer directo del DOM de #cascade-view
    const urls = [
      ...html.matchAll(
        /<div class="manga-image-container cascade-page-container"[^>]*>[\s\S]*?<img src="([^"]+)"/g,
      ),
    ].map((m) => m[1]);

    return urls.length ? [...new Set(urls.map(absoluteUrl))] : [];
  },

  // ASUMIDO/INCOMPLETO: sin HTML de /listas/ solo puedo devolver los géneros
  // vistos en la home + ficha (#info-generos a.genero-item). El id es el
  // nombre del género tal como aparece en el query param ?generos=, ya que
  // no confirmé que exista un slug numérico o distinto.
  async tags() {
    const html = await fetchText("/");
    if (!html) return [];

    const tags = [];
    const seen = new Set();
    const genreRe = /<span class="genre-pill">([^<]+)<\/span>/g;
    let m;
    while ((m = genreRe.exec(html)) !== null) {
      const name = decodeEntities(m[1]);
      if (seen.has(name)) continue;
      seen.add(name);
      tags.push({ id: name, name });
    }

    return tags;
  },
};

harbor.register(plugin);
