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
//   - Biblioteca: /api/buscar_mangas/?tipo=X&generos=Y&page=N&page_size=20
//               Confirmado contra respuesta JSON real:
//               { resultados: [{id, slug, titulo, portada, tipo, generos,
//                 ultimo_capitulo, demografia}], page, page_size, total_pages,
//                 total_results }
//   - Géneros:  /biblioteca/ tiene el listado completo y estático en
//               <button data-genero="Nombre">Nombre</button> dentro de
//               .genre-selectors (65 géneros confirmados).
//
// CONFIRMADO (con captura de red real, ya no es una suposición):
//   - search(): /api/api/busqueda-rapida/?q=... devuelve la misma forma que
//     /api/buscar_mangas/ (resultados/slug/titulo/portada, portada absoluta).
//
// ASUMIDO (sin HTML/red real que lo confirme):
//     parámetro en los botones del HTML pero no se capturó una petición de red
//     real con ese filtro activo. Implementado pasando el parámetro "capitulos"
//     tal cual, asumiendo que el backend lo acepta igual que tipo/generos.
//   - "tipo" con valores distintos de "Manga": solo se confirmó tipo=Manga en la
//     petición de red. Se asume que Manhwa/Manhua/Novela siguen el mismo patrón.
//   - URL base de portadas para /api/buscar_mangas/: CONFIRMADO que "portada"
//     puede venir ya como URL absoluta (https://images.mangalect.org/...). Se
//     mantiene un fallback (prefijo ssr-trends-data) por si algún resultado
//     trajera ruta relativa, sin confirmar ese caso específico.
//   - status(): solo vi "En curso" en la ficha de ejemplo. Mapeo por keyword;
//     "completado"/"finalizado" no están confirmados contra HTML real.
//   - "tipo": CONFIRMADO contra red real con varios valores (manga, manhua,
//     manhwa, novela), todos siguiendo el mismo patrón de resultado.
//
// ⚠️ LÍMITE CONOCIDO: el capítulo de ejemplo (21 páginas) no muestra CDN con
// protección por Referer -- las imágenes cargan directo desde images.mangalect.org.
// Si otro manga/capítulo sí la tuviera, pageUrls() en Harbor solo puede devolver
// string[] sin headers por imagen, así que no habría forma de arreglarlo desde aquí.
//
// ⚠️ La lista de capítulos viene en orden descendente (más nuevo primero) en el
// HTML — se invierte en chapters() para devolverla ascendente.
//
// ⚠️ Los géneros en /api/buscar_mangas/ vienen mezclados español/inglés y con
// duplicados de facto (p.ej. "Fantasía"/"Fantasia", "Acción"/"Accion") en el
// campo generos de cada manga individual. Esto es un dato del sitio, no un bug
// del plugin — no se normaliza aquí para no inventar un mapeo no confirmado.

const BASE_URL = "https://mangalect.org";
const LIBRARY_PAGE_SIZE = 20; // Confirmado: page_size usado en la petición real capturada.

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
    // OJO: con responseType "json", harbor.http devuelve el JSON YA
    // parseado directamente (o null si no era JSON válido) — a diferencia
    // de "text"/"base64", que sí devuelven {status, ok, headers, body}.
    // Comprobar aquí .ok/.body como si fuera texto hacía que esta función
    // devolviera null siempre, aunque la petición funcionara perfectamente.
    const json = await harbor.http(url, {
      responseType: "json",
      headers: { Referer: `${BASE_URL}/` },
    });
    if (json === null) {
      harbor.log("fetchJson: body no es JSON válido", url);
    }
    return json;
  } catch (e) {
    harbor.log("fetchJson: excepción", url, String(e));
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

// --- Biblioteca (/api/buscar_mangas/) ---------------------------------------
// Confirmado contra respuesta JSON real (petición de red capturada por el
// usuario): { resultados: [...], page, page_size, total_pages, total_results }

function coverUrlFromPortada(portada) {
  if (!portada) return undefined;
  // Confirmado contra respuesta real: /api/buscar_mangas/ puede devolver
  // "portada" ya como URL absoluta (https://images.mangalect.org/...). Si no
  // lo es, se asume la misma base que ssr-trends-data (no confirmada
  // específicamente para este endpoint, pero consistente con el resto del sitio).
  if (portada.startsWith("http")) return absoluteUrl(portada);
  return absoluteUrl(`https://images.mangalect.org/file/leermangaesp/${portada}`);
}

function mapResultadoToCard(item) {
  return {
    id: item.slug,
    title: decodeEntities(item.titulo),
    cover: coverUrlFromPortada(item.portada),
  };
}

// tipo, generos y capitulos son opcionales. page es 1-indexed.
async function fetchLibraryPage({ page, tipo, generos, capitulos }) {
  const params = new URLSearchParams();
  if (tipo) params.set("tipo", tipo);
  if (generos) params.set("generos", generos);
  if (capitulos) params.set("capitulos", capitulos); // ASUMIDO: no confirmado contra red real
  params.set("page", String(page));
  params.set("page_size", String(LIBRARY_PAGE_SIZE));

  const json = await fetchJson(`${BASE_URL}/api/buscar_mangas/?${params.toString()}`);
  if (!json || !Array.isArray(json.resultados)) return { cards: [], hasMore: false };

  return {
    cards: json.resultados.map(mapResultadoToCard),
    hasMore: (json.page || page) < (json.total_pages || 1),
  };
}

// --- MangaProvider -----------------------------------------------------

const plugin = {
  id: "mangalect",
  name: "MangaLect",

  // offset 0: usa la home (tendencias/destacados), igual que antes.
  // offset > 0 (o si la home falla): pagina de verdad contra /api/buscar_mangas/,
  // confirmado con page = floor(offset / LIBRARY_PAGE_SIZE) + 1.
  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset);

    if (offset === 0) {
      const html = await fetchText("/");
      if (html) {
        let cards = parseTrendsJson(html);
        if (cards.length === 0) {
          cards = dedupeCardsBySlug([
            ...parseFeaturedCards(html),
            ...parseMangaCards(html),
          ]);
        }
        if (cards.length > 0) {
          return cards.map((c) => ({
            id: slugFromInfoHref(c.href),
            title: c.title,
            cover: absoluteUrl(c.cover),
          }));
        }
      }
    }

    const page = Math.floor(offset / LIBRARY_PAGE_SIZE) + 1;
    const { cards } = await fetchLibraryPage({ page });
    return cards;
  },

  // Confirmado: /api/buscar_mangas/?generos=X&page=N&page_size=20
  async _byGenre(tagId, offset) {
    const page = Math.floor(offset / LIBRARY_PAGE_SIZE) + 1;
    const { cards } = await fetchLibraryPage({ page, generos: tagId });
    return cards;
  },

  // Confirmado contra respuesta real: misma forma que /api/buscar_mangas/
  // (resultados/slug/titulo/portada, portada ya absoluta).
  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);
    if (!query) return [];

    const url = `${BASE_URL}/api/api/busqueda-rapida/?q=${encodeURIComponent(query)}`;
    harbor.log("search: pidiendo", url);
    const json = await fetchJson(url);
    harbor.log("search: respuesta", JSON.stringify(json));
    if (!json || !Array.isArray(json.resultados)) return [];

    return json.resultados.slice(offset, offset + 24).map(mapResultadoToCard);
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

    // NOTA: chapters() acepta un 2º parámetro opcional (cachedHtml) solo para
    // reutilizar el HTML ya descargado aquí. Harbor nunca lo pasa: siempre
    // llama chapters(id) a secas, así que el parámetro es puramente una
    // optimización interna entre detail() y chapters(), no parte de la
    // interfaz pública.
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
  //
  // FIX: la ficha PAGINA los capítulos — solo trae un tramo por carga, con
  // un botón <a id="more-link" href="?before=104.00"> para seguir bajando.
  // Antes solo se leía la primera página (por eso mangas largos se cortaban
  // a la mitad, p.ej. solo 101-150 de 192). Ahora se sigue ese enlace hasta
  // que ya no aparece, acumulando todas las páginas.
  async chapters(id, cachedHtml) {
    let html = cachedHtml || (await fetchText(`/info/${id}/`));
    if (!html) return [];

    const cardRe =
      /<a href="(\/lectura\/[^"]+\/)" class="chapter-link"\s+data-chapter="([^"]+)"[^>]*>[\s\S]*?<div class="chapter-title">([^<]*)<\/div>/g;
    const moreLinkRe = /id="more-link"[^>]*href="\?before=([^"]+)"/;

    const found = [];
    let guard = 0; // límite de seguridad por si el "before" no avanza nunca

    while (html && guard < 50) {
      guard++;
      let m;
      cardRe.lastIndex = 0;
      while ((m = cardRe.exec(html)) !== null) {
        found.push({
          id: m[1],
          chapter: m[2],
          title: decodeEntities(m[3]),
          pages: 0, // el número de páginas no se expone en la ficha, solo en el capítulo
          language: "es",
        });
      }

      const moreMatch = html.match(moreLinkRe);
      if (!moreMatch) break;

      html = await fetchText(`/info/${id}/?before=${encodeURIComponent(moreMatch[1])}`);
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
          // FIX: filtramos por si alguna ruta resuelve a URL inválida.
          return rutas
            .map((r) => absoluteUrl(`${b2Match[1]}/${r}`))
            .filter(Boolean);
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

    // FIX: absoluteUrl() puede devolver undefined; filtramos antes del Set
    // para no colar entradas inválidas en el array final.
    const resolved = urls.map(absoluteUrl).filter(Boolean);
    return [...new Set(resolved)];
  },

  // Confirmado contra HTML real de /biblioteca/: los géneros están en botones
  // estáticos <button data-genero="Nombre">Nombre</button> dentro de
  // .genre-selectors. Lista completa (65 géneros vistos), a diferencia de la
  // versión anterior que dependía de fichas ya visitadas y de un selector
  // (.genre-pill) que no existe en el sitio real.
  // El id es el valor exacto de data-genero, que es el mismo string que espera
  // el parámetro ?generos= de /api/buscar_mangas/.
  async tags() {
    return [
      "Acción", "Animación", "Apocalíptico", "Artes marciales", "Automóviles",
      "Aventura", "Boys Love", "Ciberpunk", "Ciencia Ficción", "Comedia",
      "Crimen", "Demonios", "Deporte", "Deportes", "Doujinshi", "Drama",
      "Ecchi", "Espacio exterior", "Extranjero", "Familia", "Fantasía",
      "Género Bender", "Girls Love", "Gore", "Guerra", "Harem", "Historia",
      "Histórico", "Horror", "Isekai", "Josei", "Juegos", "Locura", "Magia",
      "Mecha", "Militar", "Misterio", "Música", "Niños", "Oeste", "Parodia",
      "Policía", "Policiaco", "Psicológico", "Realidad", "Realidad Virtual",
      "Recuentos de la vida", "Reencarnación", "Romance", "Samurai", "Seinen",
      "Shoujo", "Shoujo Ai", "Shounen", "Sobrenatural", "Superpoderes",
      "Supervivencia", "Suspenso", "Telenovela", "Terror", "Thriller",
      "Tragedia", "Traps", "Vampiros", "Vida escolar",
    ].map((name) => ({ id: name, name }));
  },
};

harbor.register(plugin);
