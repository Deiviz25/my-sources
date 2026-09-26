// leercapitulo.co — Harbor MangaProvider plugin
//
// REVISIÓN 2 — contra HTML real de leercapitulo.co obtenido en vivo (portada
// y catálogo). Cambios respecto a la versión anterior, y por qué:
//
// ✅ CONFIRMADO contra HTML real (esta revisión):
//   - Los géneros/temáticas NO viven en /genre/{slug}/ (esa ruta no existe).
//     Viven como query params sobre el catálogo: /manga/?genre={slug} y
//     /manga/?theme={slug}. Confirmado: la home enlaza exactamente así en su
//     sección "Generos"/"Tematicas", y el catálogo real (/manga/?genre=action)
//     devuelve 6442 series con paginación ?genre=action&page=N (215 páginas
//     para "action").
//   - Existe un catálogo real y navegable en /manga/ con filtros de género,
//     temática, tipo, estado y orden, más paginación ?page=N. /manga/ SIN
//     ningún query param devuelve 404 (hay que pasar al menos un filtro o
//     ?page=N).
//   - popular() en la versión anterior directamente devolvía [] para
//     offset > 0 ("no encontré paginación real de la portada"). Eso estaba
//     mal: sí existe paginación real, solo que no está en la portada sino en
//     el catálogo (/manga/). Ahora offset > 0 pagina contra el catálogo.
//   - tags() buscaba a[href*="/genre/"], que con el esquema real nunca
//     matchea nada (siempre devolvía []). Corregido para leer
//     genre=/theme= como query params, y para exponer también las temáticas
//     (antes ignoradas por completo).
//   - fetchText/fetchJson no comprobaban que la respuesta de harbor.http no
//     fuera null/undefined antes de leer .ok, y no tenían try/catch: un
//     fallo de red (timeout, DNS, etc.) lanzaba una excepción sin capturar
//     en vez de devolver null con gracia, a diferencia del resto de fuentes
//     del repo (mangadot, mangalect). Corregido para seguir el mismo patrón.
//
// ⚠️ NO confirmado (mi herramienta de verificación no pudo acceder a estas
// páginas — ver detalle más abajo — así que se mantienen tal cual estaban,
// sin tocar la lógica de parseo):
//   - Ficha de manga (h1.title-manga, .cover-detail, .description-update,
//     #example2.manga-collapse, .chapter-list)
//   - Capítulo (id="array_data" + tabla K2_TO_K1, meta property="ad:check")
//   - Si el CDN de imágenes sigue exigiendo Referer.
//   Intenté abrir 3 fichas de manga distintas y 1 capítulo (URLs reales,
//   recién extraídas del propio HTML de portada/catálogo) y las 4 devolvieron
//   404 a mi fetch automatizado, mientras que portada y catálogo sí cargan
//   sin problema. Como control, confirmé que mangalect.org (fuente que sí
//   funciona) SÍ me deja abrir tanto su home como una ficha de manga sin
//   problema — así que no es una limitación genérica de mi herramienta, sino
//   algo específico de esas rutas en leercapitulo.co (probablemente
//   protección anti-bot solo ahí). Esto no significa necesariamente que estén
//   rotas dentro de Harbor (harbor.http puede tener un comportamiento que sí
//   sortea esa protección), pero yo no puedo confirmarlo de forma
//   independiente. Si tras esta revisión detail()/chapters()/pageUrls()
//   siguen sin funcionar en la app real, se necesita HTML real (view-source)
//   de una ficha y un capítulo para corregirlos con certeza.
//
// ⚠️ Selector de tarjetas del CATÁLOGO (/manga/?...): tampoco pude confirmar
// las clases CSS exactas de esas tarjetas (mi herramienta de verificación
// solo me da el HTML convertido a texto/enlaces, no las clases). Para no
// "adivinar a ciegas" un selector de clase que podría estar mal, el
// catálogo usa un parseo genérico basado en estructura mínima y confirmada
// (enlaces a[href^="/manga/"] + <img> dentro, agrupados por slug, usando el
// texto más largo como título) en vez de nombres de clase supuestos. Es más
// robusto a cambios de markup, a costa de ser menos preciso que un selector
// de clase exacto. Los bloques de la portada (.hot-manga/.mainpage-manga)
// se mantienen como primera opción porque estaban documentados como
// confirmados en una revisión anterior; el parseo genérico actúa como
// respaldo si esos bloques no devuelven nada.

const BASE_URL = "https://www.leercapitulo.co";
const PAGE_SIZE = 48; // MANGA_PAGE: offset -> página

// --- helpers de red --------------------------------------------------------
// Antes: sin try/catch y sin comprobar que `res` no fuera null/undefined
// antes de leer `.ok` -> un fallo de red lanzaba una excepción sin capturar
// en vez de devolver null. Alineado con el estilo de mangadot/mangalect.

async function fetchText(path) {
  try {
    const res = await harbor.http(`${BASE_URL}${path}`, { responseType: "text" });
    if (!res || !res.ok) return null;
    return typeof res.body === "string" ? res.body : null;
  } catch (e) {
    harbor.log(`NETWORK ${path}: ${String(e).slice(0, 160)}`);
    return null;
  }
}

async function fetchJson(path) {
  try {
    // Con responseType "json", harbor.http devuelve el JSON YA parseado
    // directamente (o null si no era válido) — no es {ok, body}.
    const json = await harbor.http(`${BASE_URL}${path}`, { responseType: "json" });
    return json == null ? null : json;
  } catch (e) {
    harbor.log(`JSON NETWORK ${path}: ${String(e).slice(0, 160)}`);
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
    .trim();
}

// slug de la serie a partir de "/manga/SLUG_ID/titulo/" o "/leer/SLUG_ID/.../N/"
function slugFromMangaHref(href) {
  const parts = href.split("/").filter(Boolean); // ["manga"|"leer", id, ...]
  return parts[1] || href;
}

// --- parseo de tarjetas: portada (clases documentadas, sin re-confirmar) ---

function parseHotMangaBlocks(html) {
  const results = [];
  const re =
    /<div class="hot-manga[^"]*"[\s\S]*?<a href="(\/manga\/[^"]+\/)"[^>]*>[\s\S]*?<img[^>]*data-src="([^"]+)"[\s\S]*?<h3 class="manga-title">([^<]+)<\/h3>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push({ href: m[1], cover: m[2], title: decodeEntities(m[3]) });
  }
  return results;
}

function parseMainpageMangaBlocks(html) {
  const results = [];
  const re =
    /<div class="media-left cover-manga">[\s\S]*?<a href="(\/manga\/[^"]+\/)"[^>]*>[\s\S]*?<img[^>]*data-src="([^"]+)"[\s\S]*?<h4 class="manga-newest">([^<]+)<\/h4>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push({ href: m[1], cover: m[2], title: decodeEntities(m[3]) });
  }
  return results;
}

// --- parseo de tarjetas: CATÁLOGO (/manga/?...) — genérico, sin clases ------
// No pude confirmar las clases CSS reales del catálogo (ver aviso arriba).
// En vez de adivinar un selector de clase, agrupamos por slug cualquier
// <a href="/manga/..."> con una <img> dentro, y usamos como título el texto
// de enlace más largo del grupo (el catálogo real tiene dos enlaces por
// tarjeta: uno "imagen + tipo" tipo "Manga"/"Manhwa" y otro con el título
// real, que siempre es más largo que la sola palabra del tipo).
async function parseCatalogCardsGeneric(html) {
  if (!html) return [];
  let doc;
  try {
    doc = await harbor.parseHtml(html);
  } catch (e) {
    return [];
  }
  if (!doc) return [];

  const anchors = doc.querySelectorAll('a[href^="/manga/"]');
  const bySlug = new Map();

  for (const a of anchors) {
    const href = a.attr("href");
    if (!href) continue;

    const slug = slugFromMangaHref(href);
    const text = (a.text() || "").trim();
    const img = a.querySelector ? a.querySelector("img") : null;
    const cover = img ? img.attr("data-src") || img.attr("src") : undefined;

    let entry = bySlug.get(slug);
    if (!entry) {
      entry = { href, cover: undefined, title: undefined };
      bySlug.set(slug, entry);
    }

    if (cover && !entry.cover) entry.cover = cover;
    if (text && (!entry.title || text.length > entry.title.length)) {
      entry.title = text;
    }
  }

  return [...bySlug.values()].filter((c) => c.title && c.cover);
}

function dedupeCardsBySlug(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    const slug = slugFromMangaHref(c.href);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(c);
  }
  return out;
}

function cardsToResults(cards) {
  return cards.slice(0, PAGE_SIZE).map((c) => ({
    id: c.href,
    title: c.title,
    cover: absoluteUrl(c.cover),
  }));
}

// Construye la ruta del catálogo para un filtro dado. tagId puede venir
// como "genre:slug" o "theme:slug" (ver tags()); si no trae prefijo se trata
// como género por compatibilidad hacia atrás.
function catalogPath({ tagId, page } = {}) {
  const params = new URLSearchParams();

  if (tagId) {
    let kind = "genre";
    let value = tagId;
    if (typeof tagId === "string" && tagId.includes(":")) {
      const [k, v] = tagId.split(/:(.*)/s);
      if (k === "theme" || k === "genre") {
        kind = k;
        value = v;
      }
    }
    params.set(kind, value);
  }

  if (page && page > 1) params.set("page", String(page));

  const qs = params.toString();
  return qs ? `/manga/?${qs}` : "/manga/?page=1"; // /manga/ solo -> 404 confirmado
}

// --- MangaProvider -----------------------------------------------------

const plugin = {
  id: "leercapitulo",
  name: "LeerCapitulo",

  // offset 0: portada (Tendencias + Últimos Capítulos Agregados), como antes.
  // offset > 0: ANTES devolvía [] siempre (bug: "no hay paginación real").
  // AHORA pagina de verdad contra el catálogo /manga/?page=N, que sí existe
  // y sí pagina (confirmado en vivo: /manga/?genre=action tiene 215 páginas).
  async popular(offset, tagId) {
    if (tagId) return this._byGenre(tagId, offset);

    if (offset === 0) {
      const html = await fetchText("/");
      if (html) {
        const cards = dedupeCardsBySlug([
          ...parseHotMangaBlocks(html),
          ...parseMainpageMangaBlocks(html),
        ]);
        if (cards.length > 0) return cardsToResults(cards);
      }
    }

    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const html = await fetchText(catalogPath({ page }));
    if (!html) return [];

    const cards = await parseCatalogCardsGeneric(html);
    return cardsToResults(cards);
  },

  // FIX: antes apuntaba a /genre/{slug}/, ruta inexistente (404 confirmado).
  // Ahora usa /manga/?genre={slug}&page=N o /manga/?theme={slug}&page=N,
  // según el prefijo del id que entrega tags().
  async _byGenre(tagId, offset) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const html = await fetchText(catalogPath({ tagId, page }));
    if (!html) return [];

    const cards = await parseCatalogCardsGeneric(html);
    return cardsToResults(cards);
  },

  async search(query, offset, tagId) {
    if (!query && tagId) return this._byGenre(tagId, offset);
    if (!query) return [];

    const json = await fetchJson(`/search-autocomplete?term=${encodeURIComponent(query)}`);
    if (!Array.isArray(json)) return [];

    const page = json.slice(offset, offset + PAGE_SIZE);
    const results = [];

    if (json.length <= 6) {
      // Pocos resultados: enriquecerlos abriendo cada ficha para sacar títulos alternativos.
      // NOTA: esto depende de poder abrir la ficha (serie.link); ver aviso
      // sobre fichas 404 en mi verificación. Si detail() está roto, esto
      // devolverá altTitle undefined en vez de fallar (fetchText ya es
      // resiliente a null).
      const details = await Promise.all(
        page.map(async (serie) => {
          const html = await fetchText(serie.link);
          const altTitle = html
            ?.match(/<span>Títulos Alternativos: <\/span>(.*?)<br>/s)?.[1]
            ?.split(",")
            .map((t) => decodeEntities(t.trim()))
            .join(", ");

          return {
            id: serie.link,
            title: serie.label,
            altTitle,
            cover: absoluteUrl(serie.thumbnail),
          };
        }),
      );
      results.push(...details);
    } else {
      for (const serie of page) {
        results.push({
          id: serie.link,
          title: serie.label,
          cover: absoluteUrl(serie.thumbnail),
        });
      }
    }

    return results;
  },

  // ⚠️ SIN RE-VERIFICAR: no pude cargar una ficha real (404 en mi fetch
  // automatizado, ver aviso al inicio del archivo). Lógica sin tocar.
  async detail(id) {
    const html = await fetchText(id);
    if (!html) return null;

    const titleMatch = html.match(/<h1 class="title-manga">([^<]+)<\/h1>/);
    const coverMatch = html.match(
      /<div class="media-left cover-detail">\s*<img src="([^"]+)"/,
    );

    const descBlockMatch = html.match(
      /<p class="description-update">([\s\S]*?)<\/p>/,
    );
    const descBlock = descBlockMatch ? descBlockMatch[1] : "";

    const altTitle = descBlock
      .match(/<span>Títulos Alternativos: <\/span>(.*?)<br>/s)?.[1]
      ?.split(",")
      .map((t) => decodeEntities(t.trim()))
      .join(", ");

    const genreBlockMatch = descBlock.match(
      /<span>Géneros: <\/span>([\s\S]*?)<br>/,
    );
    const genre = genreBlockMatch
      ? [...genreBlockMatch[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) =>
          decodeEntities(m[1]),
        )
      : [];

    const statusRaw = descBlock.match(/<span>Estado: <\/span>([^<]*)<br>/)?.[1]?.trim();
    const status = statusRaw ? statusRaw.toLowerCase() : undefined;

    const synopsisMatch = html.match(
      /<p id="example2" class="manga-collapse">([\s\S]*?)<\/p>/,
    );
    const description = synopsisMatch
      ? decodeEntities(synopsisMatch[1].replace(/\s+/g, " ").trim())
      : undefined;

    // Reutiliza el HTML ya descargado (mismo patrón que mangalect) en vez de
    // pedir la ficha una segunda vez dentro de chapters().
    const chapters = await plugin.chapters(id, html);
    const lastChapter = chapters.length ? chapters[chapters.length - 1].chapter : undefined;

    return {
      id,
      title: titleMatch ? decodeEntities(titleMatch[1].trim()) : id,
      altTitle,
      cover: absoluteUrl(coverMatch?.[1]),
      description,
      status,
      lastChapter,
      author: genre.length ? undefined : undefined, // el sitio no publica autor en la ficha
    };
  },

  // ⚠️ SIN RE-VERIFICAR (ver aviso al inicio). Único cambio: acepta un 2º
  // parámetro opcional cachedHtml para no volver a pedir la ficha si
  // detail() ya la descargó (Harbor solo llama chapters(id), nunca pasa el
  // segundo argumento — es una optimización interna, no parte de la interfaz).
  async chapters(id, cachedHtml) {
    const html = cachedHtml || (await fetchText(id));
    if (!html) return [];

    const listMatch = html.match(
      /<div[^>]*class="chapter-list"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>/i,
    );
    if (!listMatch) return [];

    const listHtml = listMatch[1].replace(/\s+/g, " ");
    const liMatches = [...listHtml.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].reverse();

    const chapters = [];

    liMatches.forEach((match) => {
      const block = match[1];
      const hrefMatch = block.match(/href="([^"]+)"/);
      const titleMatch = block.match(/>([^<]+)<\/a>/);
      if (!hrefMatch) return;

      const url = hrefMatch[1];
      const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";
      const urlParts = url.split("/").filter(Boolean);
      const number = urlParts[urlParts.length - 1];

      chapters.push({
        id: url,
        chapter: number ?? null,
        title,
        pages: 0,
        language: "es",
      });
    });

    return chapters;
  },

  // ⚠️ SIN RE-VERIFICAR (ver aviso al inicio): si el CDN de imágenes exige
  // Referer, esto puede seguir fallando en Harbor pase lo que pase aquí,
  // porque pageUrls() no admite headers por imagen en la spec actual.
  async pageUrls(chapterId) {
    const html = await fetchText(chapterId);
    if (!html) return [];

    const arrayDataMatch = html.match(/id="array_data"[^>]*>([^<]+)</);
    const arrayData = (arrayDataMatch ? arrayDataMatch[1] : "").trim();
    const urlList = decodeArrayData(arrayData);

    const orderMetaMatch = html.match(/property="ad:check" content="([^"]+)"/);
    const orderRaw = orderMetaMatch ? orderMetaMatch[1] : null;

    if (!orderRaw) return urlList;

    const orderList = orderRaw.replace(/[^\d]+/g, "-").split("-").filter(Boolean);
    const useReversed = orderList.some((x) => x === "01");

    return orderList
      .map((i) => {
        const index = useReversed
          ? parseInt(i.split("").reverse().join(""), 10)
          : parseInt(i, 10);
        return urlList[index];
      })
      .filter(Boolean)
      .reverse();
  },

  // FIX: antes buscaba a[href*="/genre/"], que con el esquema real
  // (/manga/?genre=...) nunca matchea nada -> devolvía siempre []. Ahora lee
  // los query params genre=/theme= reales, y expone también las temáticas
  // (antes ignoradas). El id lleva el prefijo "genre:"/"theme:" para que
  // _byGenre() sepa qué parámetro de query usar.
  async tags() {
    const html = await fetchText("/");
    if (!html) return [];

    let doc;
    try {
      doc = await harbor.parseHtml(html);
    } catch (e) {
      return [];
    }
    if (!doc) return [];

    const links = doc.querySelectorAll('a[href*="genre="], a[href*="theme="]');
    const seen = new Set();
    const tags = [];

    for (const a of links) {
      const href = a.attr("href");
      const name = (a.text() || "").trim();
      if (!href || !name) continue;

      const genreMatch = href.match(/[?&]genre=([^&]+)/);
      const themeMatch = href.match(/[?&]theme=([^&]+)/);

      let id;
      if (genreMatch) id = `genre:${decodeURIComponent(genreMatch[1])}`;
      else if (themeMatch) id = `theme:${decodeURIComponent(themeMatch[1])}`;
      else continue;

      if (seen.has(id)) continue;
      seen.add(id);
      tags.push({ id, name });
    }

    return tags;
  },
};

// --- descifrado del array de páginas (sin tocar, sin re-verificar) --------
const K2_TO_K1 = new Map([
  ["0", "w"], ["1", "j"], ["2", "H"], ["3", "A"], ["4", "V"],
  ["5", "Q"], ["6", "P"], ["7", "3"], ["8", "L"], ["9", "Y"],
  ["A", "m"], ["B", "t"], ["C", "R"], ["D", "o"], ["E", "B"],
  ["F", "x"], ["G", "T"], ["H", "C"], ["I", "N"], ["J", "0"],
  ["K", "S"], ["L", "D"], ["M", "f"], ["N", "F"], ["O", "y"],
  ["P", "h"], ["Q", "7"], ["R", "c"], ["S", "s"], ["T", "d"],
  ["U", "9"], ["V", "e"], ["W", "J"], ["X", "z"], ["Y", "X"],
  ["Z", "b"],
  ["a", "a"], ["b", "I"], ["c", "q"], ["d", "G"], ["e", "n"],
  ["f", "2"], ["g", "Z"], ["h", "M"], ["i", "5"], ["j", "6"],
  ["k", "u"], ["l", "O"], ["m", "i"], ["n", "l"], ["o", "g"],
  ["p", "r"], ["q", "K"], ["r", "v"], ["s", "p"], ["t", "8"],
  ["u", "4"], ["v", "U"], ["w", "W"], ["x", "E"], ["y", "1"],
  ["z", "k"],
]);

function decodeArrayData(arrayData) {
  const replaced = arrayData.replace(/[A-Za-z0-9]/g, (ch) => K2_TO_K1.get(ch) || ch);

  let decoded;
  try {
    decoded = atob(replaced);
  } catch (e) {
    return [];
  }

  return decoded
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

harbor.register(plugin);
