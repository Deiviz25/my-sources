// leercapitulo.co — Harbor MangaProvider plugin
//
// ESTADO (revisión honesta):
//   - popular()/parseMangaCards(): CORREGIDO. La home real tiene DOS
//     estructuras de tarjeta distintas:
//       (a) "Tendencias": <a href="/manga/slug/"><img ...></a> seguido de
//           OTRO <a href="/manga/slug/">Título</a> (portada y título en
//           anchors separados, mismo href).
//       (b) "Populares" / "Últimos mangas": <a href="/manga/slug/"> único
//           que envuelve <img alt="Portada de TITULO" ...> + texto/():
//           portada y título en el MISMO anchor.
//     La regex anterior sólo cubría (b), así que en popular(0) se perdía
//     toda la sección Tendencias. Ahora se agrupan TODOS los <a> que
//     apuntan al mismo slug y se combina lo que aporta cada uno (portada
//     de uno, título de otro), cubriendo (a) y (b) a la vez.
//   - tags(): CORREGIDO (simplificado, no por bug). harbor.parseHtml SÍ
//     es una API real y soportada (confirmado en la doc de Harbor), así
//     que el tags() original no estaba roto por usarla. Pero los 78
//     géneros/temáticas son estáticos y ya están confirmados contra el
//     HTML real, así que hardcodearlos evita un parseo + querySelectorAll
//     en cada llamada, igual que hace mangalect con su lista de géneros.
//   - Referer → CORREGIDO (bug real, confirmado en la doc de Harbor):
//     "These request headers are stripped: host, cookie, authorization,
//     origin, referer, ...". El header `Referer: BASE_URL` que ponía
//     fetchText/fetchJson NUNCA llegaba al servidor — era código muerto.
//     Si leercapitulo.co exige Referer para servir /manga/, /manga/{id}/
//     o /leer/.../N/, eso solo explicaría el 404 que vi al probar esas
//     rutas. Lo único que Harbor sí deja fijar es `user-agent`, así que
//     se cambió el header por uno de navegador real — es la única
//     palanca real disponible para parecer tráfico legítimo.
//
// ✅ CONFIRMADO contra HTML real de ficha (/manga/byywymjdxc/u-dont-know-me/):
//   - detail(): portada (<div class="lc-cover-lg"><img src=...>), sinopsis
//     (<section id="sinopsis">...<p>), estado (<span class="k">Estado</span>
//     <a>Completed</a> — en inglés, y el valor va dentro de un <a>, no como
//     texto plano), autor (<span class="k">Autor</span><span>X</span>) y
//     títulos alternativos (<p class="small lc-muted mb-2"> separados por
//     "·"). Las cuatro primeras estaban rotas en el código original
//     (regex buscando marcado que no existe) — quedan corregidas abajo.
//   - chapters(): cada fila es <a class="lc-chapter-row" href="/leer/.../N/">
//     <span class="n">Capitulo N</span><span class="d">FECHA</span></a>.
//     No hay paginación visible (ni "?before=", ni botón "cargar más"; el
//     filtro/orden de la ficha sólo reordenan el DOM ya presente) — pero
//     la ficha de ejemplo sólo tenía 1 capítulo, así que esto no está
//     100% confirmado para mangas largos (ej. One Piece, 1194 capítulos).
//
// ⚠️ SIN CONFIRMAR / BLOQUEADO — sigue pendiente:
//     - si la lista de capítulos pagina en mangas largos (sólo se vio
//       una ficha con 1 capítulo; ver nota de chapters() más abajo)
//     - si pageUrls() realmente necesita el fallback cifrado
//       (array_data) o si el scan de <img> normal ya es suficiente / al
//       revés (que el scan de <img> esté devolviendo miniaturas de
//       "relacionados" en vez de las páginas reales, colándose antes de
//       llegar al fallback correcto).
//
//   Para cerrar lo que queda pendiente sólo necesito el HTML real (o una
//   captura de red) de un capítulo, p.ej.
//   /leer/psvkfbmjgo/one-piece/1194/ (Ver código fuente / DevTools →
//   Network → Copy response), y si puedes, la ficha de un manga LARGO
//   (ej. /manga/psvkfbmjgo/one-piece/, 1194 capítulos) para descartar
//   paginación del todo.

const BASE_URL = "https://www.leercapitulo.co";
const PAGE_SIZE = 48;
// Referer se elimina siempre en harbor.http (confirmado en la doc de la
// API); user-agent es el único header "de navegador" que Harbor deja
// fijar, así que es lo único real que podemos usar para intentar pasar
// una protección anti-bot basada en cabeceras.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ============================================================
// Helpers
// ============================================================

async function fetchText(path) {
  try {
    const url = path.startsWith("http")
      ? path
      : `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

    const res = await harbor.http(url, {
      responseType: "text",
      // Referer se elimina siempre en harbor.http (ver doc de la API);
      // user-agent es lo único real que podemos fijar.
      headers: { "user-agent": DESKTOP_UA },
    });

    if (!res || !res.ok) {
      harbor.log(`LeerCapitulo HTTP error: ${url}`);
      return null;
    }

    return res.body;
  } catch (e) {
    harbor.log(`LeerCapitulo fetchText error: ${e}`);
    return null;
  }
}

async function fetchJson(url) {
  try {
    // Con responseType "json", harbor.http devuelve el JSON YA parseado
    // (o null si no es JSON válido), a diferencia de "text".
    const json = await harbor.http(url, {
      responseType: "json",
      headers: { "user-agent": DESKTOP_UA },
    });

    if (json === null) {
      harbor.log(`fetchJson: respuesta no es JSON válido: ${url}`);
    }

    return json;
  } catch (e) {
    harbor.log(`fetchJson: excepción en ${url}: ${e}`);
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

function cleanText(text) {
  if (!text) return "";

  return decodeEntities(
    String(text)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

// CORREGIDO (bug real, confirmado contra HTML de ficha real): las URLs
// de leercapitulo son /manga/{id}/{slug}/ — DOS segmentos, no uno. La
// versión anterior de slugFromMangaHref cortaba en la primera "/", así
// que `id` quedaba truncado a sólo el código corto (ej. "byywymjdxc"
// en vez de "byywymjdxc/u-dont-know-me"). detail()/chapters() luego
// reconstruían la URL como `/manga/${id}/`, pidiendo "/manga/byywymjdxc/"
// — una URL SIN el slug que el sitio nunca sirve. Esto es, con bastante
// seguridad, la causa real de "entro a un manga y da error": no es (o
// no es sólo) protección anti-bot, es que la URL que se pedía estaba
// incompleta. Ahora se captura la ruta completa (id + slug) como `id`,
// así que `/manga/${id}/` reconstruye la URL real exacta.
function slugFromMangaHref(href) {
  if (!href) return null;

  const match = String(href).match(/\/manga\/([^?#]+?)\/?(?:[?#]|$)/i);
  if (!match || !match[1]) return null;

  return match[1];
}

// ============================================================
// Caché simple
// ============================================================

const summaryCache = new Map();

// ============================================================
// Array data (descodificación de imágenes) — sin cambios, sin
// confirmar contra un capítulo real (ver notas de cabecera).
// ============================================================

const K2_TO_K1 = new Map([
  ["0", "w"], ["1", "j"], ["2", "H"], ["3", "A"], ["4", "V"],
  ["5", "Q"], ["6", "P"], ["7", "3"], ["8", "L"], ["9", "Y"],
  ["A", "m"], ["B", "t"], ["C", "R"], ["D", "o"], ["E", "B"],
  ["F", "x"], ["G", "T"], ["H", "C"], ["I", "N"], ["J", "0"],
  ["K", "S"], ["L", "D"], ["M", "f"], ["N", "F"], ["O", "y"],
  ["P", "h"], ["Q", "7"], ["R", "c"], ["S", "s"], ["T", "d"],
  ["U", "9"], ["V", "e"], ["W", "J"], ["X", "z"], ["Y", "X"],
  ["Z", "b"], ["a", "a"], ["b", "I"], ["c", "q"], ["d", "G"],
  ["e", "n"], ["f", "2"], ["g", "Z"], ["h", "M"], ["i", "5"],
  ["j", "6"], ["k", "u"], ["l", "O"], ["m", "i"], ["n", "l"],
  ["o", "g"], ["p", "r"], ["q", "K"], ["r", "v"], ["s", "p"],
  ["t", "8"], ["u", "4"], ["v", "U"], ["w", "W"], ["x", "E"],
  ["y", "1"], ["z", "k"],
]);

function decodeArrayData(arrayData) {
  if (!arrayData) return [];

  const replaced = String(arrayData).replace(
    /[A-Za-z0-9]/g,
    (ch) => K2_TO_K1.get(ch) || ch,
  );

  let decoded;

  try {
    decoded = atob(replaced);
  } catch {
    return [];
  }

  return decoded
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ============================================================
// Parseo de tarjetas — CORREGIDO
// ============================================================
// En vez de asumir una única forma de tarjeta, se extraen TODOS los
// <a href="/manga/slug/">...</a> del HTML (sin importar en qué sección
// estén) y se agrupan por slug, combinando lo que cada anchor aporta:
// portada (de un <img data-src|src>), y título (de alt="Portada de X",
// de un h3/h4/span/strong/b interno, o del texto plano del propio <a>).
// Esto cubre tanto la estructura de "Tendencias" (portada y título en
// anchors separados) como la de "Populares"/"Últimos mangas" (todo en
// un mismo anchor).

function extractMangaAnchors(html) {
  const re = /<a[^>]+href=["'](\/manga\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const out = [];
  let m;

  while ((m = re.exec(html)) !== null) {
    out.push({ href: m[1], inner: m[2] });
  }

  return out;
}

function parseMangaCards(html) {
  if (!html) return [];

  const bySlug = new Map();

  for (const { href, inner } of extractMangaAnchors(html)) {
    const slug = slugFromMangaHref(href);
    if (!slug) continue;

    const entry = bySlug.get(slug) || { href, cover: undefined, title: undefined };

    if (!entry.cover) {
      const imgMatch = inner.match(/(?:data-src|src)=["']([^"']+)["']/i);
      if (imgMatch) entry.cover = imgMatch[1];
    }

    if (!entry.title) {
      const altMatch = inner.match(/alt=["']Portada de ([^"']+)["']/i);
      const tagMatch = inner.match(
        /<(?:h[34]|span|strong|b)[^>]*>([^<]+)<\/(?:h[34]|span|strong|b)>/i,
      );
      const plain = cleanText(inner);

      const candidate = altMatch?.[1] || tagMatch?.[1] || plain;
      if (candidate) entry.title = cleanText(candidate);
    }

    bySlug.set(slug, entry);
  }

  return [...bySlug.values()].filter((c) => c.cover && c.title);
}

function dedupeCardsBySlug(cards) {
  const seen = new Set();
  const out = [];

  for (const c of cards) {
    const slug = slugFromMangaHref(c.href);
    if (!slug || seen.has(slug)) continue;

    seen.add(slug);
    out.push(c);
  }

  return out;
}

function cardsToResults(cards) {
  return cards.map((c) => {
    const id = slugFromMangaHref(c.href);
    const result = {
      id,
      title: c.title,
      cover: absoluteUrl(c.cover),
    };

    summaryCache.set(id, result);
    return result;
  });
}

// ============================================================
// MangaProvider
// ============================================================

const plugin = {
  id: "leercapitulo",
  name: "LeerCapitulo",

  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset);

    if (offset === 0) {
      const html = await fetchText("/");

      if (html) {
        const cards = dedupeCardsBySlug(parseMangaCards(html));

        if (cards.length > 0) {
          return cardsToResults(cards.slice(0, PAGE_SIZE));
        }
      }
    }

    // Fallback: página del catálogo.
    // ⚠️ Sin confirmar: en mis pruebas /manga/?page=N devolvió 404 a una
    // petición sin sesión de navegador (ver notas de cabecera). Si en la
    // app también da 404, esto nunca completará más allá de la home.
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const html = await fetchText(`/manga/?page=${page}`);

    if (!html) return [];

    const cards = dedupeCardsBySlug(parseMangaCards(html));
    return cardsToResults(cards);
  },

  async _byGenre(tagId, offset) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;

    let path = "/manga/?";
    if (tagId.startsWith("genre:")) {
      path += `genre=${encodeURIComponent(tagId.slice(6))}`;
    } else if (tagId.startsWith("theme:")) {
      path += `theme=${encodeURIComponent(tagId.slice(6))}`;
    }

    path += `&page=${page}`;

    const html = await fetchText(path);
    if (!html) return [];

    const cards = dedupeCardsBySlug(parseMangaCards(html));
    return cardsToResults(cards);
  },

  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);
    if (!query) return [];

    // ⚠️ Sin confirmar contra una petición de red real (no pude
    // verificar la forma de la respuesta). Se deja igual que estaba.
    const url = `${BASE_URL}/search-autocomplete?term=${encodeURIComponent(query)}`;
    harbor.log(`search: pidiendo ${url}`);

    const json = await fetchJson(url);
    harbor.log(`search: respuesta JSON tipo ${typeof json}, es array: ${Array.isArray(json)}`);

    if (!Array.isArray(json)) {
      harbor.log(`search: respuesta no es array válido`);
      return [];
    }

    const page = json.slice(offset, offset + PAGE_SIZE);
    const results = [];

    for (const item of page) {
      if (!item) continue;

      const id = slugFromMangaHref(item.link);
      if (!id) continue;

      const result = {
        id,
        title: cleanText(item.label) || id,
        cover: absoluteUrl(item.thumbnail),
      };

      summaryCache.set(id, result);
      results.push(result);
    }

    return results;
  },

  // CORREGIDO contra HTML real de ficha (/manga/byywymjdxc/u-dont-know-me/):
  //   - cover: el <img> no tiene class="cover"/"manga", vive dentro de
  //     <div class="lc-cover-lg">. La regex anterior nunca lo encontraba.
  //   - description: no hay id="example2" ni class="description"; vive en
  //     <section id="sinopsis"><div><p class="mb-0 lc-muted">. La regex
  //     anterior tampoco lo encontraba nunca. Se filtra además el texto
  //     placeholder "Esta serie todavia no tiene sinopsis." → undefined.
  //   - status: el valor no es texto plano tras </span>, va dentro de un
  //     <a>: <span class="k">Estado</span><a href="...">Completed</a>.
  //     La regex anterior exigía [^<]+ justo tras </span> y fallaba
  //     siempre. Además el valor viene en INGLÉS ("Completed"/"Ongoing"),
  //     no en español.
  //   - author: nuevo. Existe <span class="k">Autor</span><span>X</span>
  //     en la ficha y antes no se leía nunca.
  //   - altTitle: nuevo. Existe un <p class="small lc-muted mb-2"> justo
  //     bajo el <h1> con los títulos alternativos separados por "·".
  async detail(id) {
    if (!id) return null;

    const cached = summaryCache.get(id);

    const html = await fetchText(`/manga/${id}/`);

    if (!html) {
      if (cached) return { ...cached };
      return null;
    }

    const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const title = titleMatch ? cleanText(titleMatch[1]) : id;

    const altMatch = html.match(/<p class="small lc-muted mb-2">([\s\S]*?)<\/p>/i);
    let altTitle;
    if (altMatch) {
      const parts = cleanText(altMatch[1])
        .split("·")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length) altTitle = parts.join(", ");
    }

    const coverMatch = html.match(/<div class="lc-cover-lg">[\s\S]*?<img[^>]+src=["']([^"']+)["']/i);
    const cover = absoluteUrl(coverMatch?.[1]);

    const synopsisMatch = html.match(/id=["']sinopsis["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    let description;
    if (synopsisMatch) {
      const text = cleanText(synopsisMatch[1]);
      if (text && !text.toLowerCase().includes("no tiene sinopsis")) description = text;
    }

    const statusBlockMatch = html.match(/<span class="k">Estado<\/span>([\s\S]*?)<\/li>/i);
    let status;
    if (statusBlockMatch) {
      const statusRaw = cleanText(statusBlockMatch[1]).toLowerCase();
      if (statusRaw.includes("curso") || statusRaw.includes("ongoing")) status = "ongoing";
      else if (statusRaw.includes("complet") || statusRaw.includes("finaliz")) status = "completed";
    }

    const authorMatch = html.match(/<span class="k">Autor<\/span>([\s\S]*?)<\/li>/i);
    const author = authorMatch ? cleanText(authorMatch[1]) || undefined : undefined;

    const chapters = await plugin.chapters(id, html);
    const lastChapter = chapters.length > 0 ? chapters[chapters.length - 1].chapter : undefined;

    const result = {
      id,
      title,
      altTitle,
      cover,
      description,
      status,
      lastChapter,
      author,
    };

    summaryCache.set(id, {
      id: result.id,
      title: result.title,
      cover: result.cover,
    });

    return result;
  },

  // CORREGIDO/mejorado contra HTML real de ficha: cada fila es
  // <a class="lc-chapter-row" href="/leer/.../N/">
  //   <span class="n">Capitulo N</span><span class="d">FECHA</span>
  // </a>
  // La regex original ya funcionaba por casualidad (span está entre los
  // tags permitidos), pero tiraba la fecha a la basura. Ahora se extrae
  // el bloque interno completo del <a> y se leen los spans "n"/"d" por
  // separado (agnóstico al orden de atributos), rellenando publishAt.
  //
  // ⚠️ No vi paginación en la ficha de ejemplo (no hay "?before=" ni
  // botón "cargar más"; el filtro/orden son botones que sólo reordenan
  // el DOM ya presente) — pero esa ficha sólo tiene 1 capítulo. Si algún
  // manga largo (ej. One Piece) sí pagina la lista, esto se quedará
  // corto igual que le pasaba a mangalect antes de su fix.
  async chapters(id, cachedHtml) {
    let html = cachedHtml || (await fetchText(`/manga/${id}/`));

    if (!html) return [];

    const anchorRe = /<a[^>]+href=["']([^"']*\/leer\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

    const chapters = [];
    const seen = new Set();
    let m;

    while ((m = anchorRe.exec(html)) !== null) {
      const href = m[1];
      const inner = m[2];
      const chId = absoluteUrl(href);

      if (!chId || seen.has(chId)) continue;
      seen.add(chId);

      const numSpan = inner.match(/<span[^>]*class=["']n["'][^>]*>([^<]*)<\/span>/i);
      const dateSpan = inner.match(/<span[^>]*class=["']d["'][^>]*>([^<]*)<\/span>/i);

      const number = href.split("/").filter(Boolean).pop();
      let title = numSpan ? cleanText(numSpan[1]) : cleanText(inner);
      if (!title && number) title = `Capítulo ${number}`;
      if (!title) title = number || "Sin título";

      chapters.push({
        id: chId,
        chapter: number,
        title,
        pages: 0,
        language: "es",
        publishAt: dateSpan ? cleanText(dateSpan[1]) : undefined,
      });
    }

    // Invertir para orden ascendente.
    return chapters.reverse();
  },

  // ⚠️ Sin confirmar contra un capítulo real (ver notas de cabecera).
  // Lógica intacta respecto al original.
  async pageUrls(chapterId) {
    const html = await fetchText(chapterId);

    if (!html) return [];

    let urls = [];
    const imgRe = /<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*>/gi;

    let m;
    const seen = new Set();

    while ((m = imgRe.exec(html)) !== null) {
      const url = absoluteUrl(m[1]);

      if (!url || seen.has(url)) continue;

      const lower = url.toLowerCase();
      if (lower.includes("logo") || lower.includes("icon") || lower.includes("avatar") ||
          lower.includes("favicon") || lower.includes("ads") || lower.includes("banner")) {
        continue;
      }

      seen.add(url);
      urls.push(url);
    }

    if (urls.length > 0) return urls;

    // Fallback: array_data cifrado.
    const arrayDataMatch = html.match(/id=["']array_data["'][^>]*>([^<]+)</i);
    if (!arrayDataMatch) return [];

    const arrayData = arrayDataMatch[1].trim();
    const urlList = decodeArrayData(arrayData);

    if (!urlList.length) return [];

    const orderMetaMatch = html.match(/property=["']ad:check["'][^>]+content=["']([^"']+)["']/i);
    const orderRaw = orderMetaMatch?.[1] || null;

    if (!orderRaw) {
      return urlList.map(absoluteUrl).filter(Boolean);
    }

    const orderList = orderRaw
      .replace(/[^\d]+/g, "-")
      .split("-")
      .filter(Boolean);

    const useReversed = orderList.some((x) => x === "01");

    const result = orderList
      .map((value) => {
        let index = parseInt(value, 10);

        if (useReversed) {
          index = parseInt(value.split("").reverse().join(""), 10);
        }

        return urlList[index];
      })
      .map(absoluteUrl)
      .filter(Boolean);

    return result.reverse();
  },

  // CORREGIDO: lista estática confirmada contra el HTML real de la home
  // (secciones "Generos" y "Tematicas"), en vez de depender de
  // harbor.parseHtml(...).querySelectorAll(...), que no se usa en
  // ningún otro plugin del repo y no está confirmado que exista/sea
  // fiable en el runtime de Harbor.
  async tags() {
    const genres = [
      ["action", "Action"], ["adventure", "Adventure"], ["boys-love", "Boys' Love"],
      ["comedy", "Comedy"], ["crime", "Crime"], ["drama", "Drama"], ["fantasy", "Fantasy"],
      ["girls-love", "Girls' Love"], ["historical", "Historical"], ["horror", "Horror"],
      ["isekai", "Isekai"], ["magical-girls", "Magical Girls"], ["mecha", "Mecha"],
      ["medical", "Medical"], ["mystery", "Mystery"], ["philosophical", "Philosophical"],
      ["psychological", "Psychological"], ["romance", "Romance"], ["sci-fi", "Sci-Fi"],
      ["slice-of-life", "Slice of Life"], ["sports", "Sports"], ["superhero", "Superhero"],
      ["thriller", "Thriller"], ["tragedy", "Tragedy"], ["wuxia", "Wuxia"], ["seinen", "Seinen"],
      ["shounen", "Shounen"], ["ecchi", "Ecchi"], ["shoujo", "Shoujo"], ["mature", "Mature"],
      ["adult", "Adult"], ["shounen-ai", "Shounen Ai"], ["gender-bender", "Gender Bender"],
      ["shotacon", "Shotacon"], ["josei", "Josei"], ["yaoi", "Yaoi"], ["smut", "Smut"],
      ["ciberpunk", "Ciberpunk"], ["vida-escolar", "Vida Escolar"],
      ["realidad-virtual", "Realidad Virtual"], ["fantasia", "Fantasia"],
      ["comedia", "Comedia"], ["recuentos-de-la-vida", "Recuentos de la vida"],
      ["yuri", "Yuri"], ["sobrenatural", "Sobrenatural"], ["magia", "Magia"],
      ["tragedia", "Tragedia"], ["historia", "Historia"], ["guerra", "Guerra"],
      ["misterio", "Misterio"], ["policiaco", "Policiaco"],
      ["artes-marciales", "Artes Marciales"], ["gore", "Gore"],
      ["superpoderes", "Superpoderes"], ["familia", "Familia"], ["aventura", "Aventura"],
      ["supervivencia", "Supervivencia"], ["demonios", "Demonios"], ["realidad", "Realidad"],
      ["telenovela", "Telenovela"], ["crimen", "Crimen"], ["parodia", "Parodia"],
      ["deporte", "Deporte"], ["traps", "Traps"], ["militar", "Militar"], ["musica", "Musica"],
      ["vampiros", "Vampiros"], ["extranjero", "Extranjero"], ["oeste", "Oeste"],
      ["shoujo-ai", "Shoujo Ai"], ["doujinshi", "Doujinshi"],
      ["psicologico", "Psicológico"], ["accion", "Acción"],
      ["ciencia-ficcion", "Ciencia Ficción"], ["genero-bender", "Género Bender"],
      ["apocaliptico", "Apocalíptico"], ["reencarnacion", "Reencarnación"],
      ["ninos", "Niños"], ["lolicon", "Lolicon"], ["hentai", "Hentai"],
      ["animacion", "Animación"],
    ].map(([id, name]) => ({ id: `genre:${id}`, name }));

    const themes = [
      ["aliens", "Aliens"], ["animals", "Animals"], ["cooking", "Cooking"],
      ["cross-dressing", "Cross-dressing"], ["delinquents", "Delinquents"],
      ["demons", "Demons"], ["genderswap", "Genderswap"], ["ghosts", "Ghosts"],
      ["gyaru", "Gyaru"], ["harem", "Harem"], ["incest", "Incest"], ["loli", "Loli"],
      ["mafia", "Mafia"], ["magic", "Magic"], ["martial-arts", "Martial Arts"],
      ["military", "Military"], ["monster-girls", "Monster Girls"],
      ["monsters", "Monsters"], ["music", "Music"], ["ninja", "Ninja"],
      ["office-workers", "Office Workers"], ["police", "Police"],
      ["post-apocalyptic", "Post-Apocalyptic"], ["reincarnation", "Reincarnation"],
      ["reverse-harem", "Reverse Harem"], ["samurai", "Samurai"],
      ["school-life", "School Life"], ["shota", "Shota"],
      ["supernatural", "Supernatural"], ["survival", "Survival"],
      ["time-travel", "Time Travel"], ["traditional-games", "Traditional Games"],
      ["vampires", "Vampires"], ["video-games", "Video Games"],
      ["villainess", "Villainess"], ["virtual-reality", "Virtual Reality"],
      ["zombies", "Zombies"],
    ].map(([id, name]) => ({ id: `theme:${id}`, name }));

    return [...genres, ...themes];
  },
};

harbor.register(plugin);
