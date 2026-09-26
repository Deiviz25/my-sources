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
//   - tags(): CORREGIDO. Antes dependía de harbor.parseHtml(...)
//     .querySelectorAll(...), una API que el plugin hermano (mangalect,
//     que sí funciona bien) nunca usa — no hay garantía de que exista o
//     sea fiable en el runtime de Harbor. Los 78 géneros/temáticas están
//     en enlaces estáticos en la home (?genre=X / ?theme=Y), así que se
//     capturaron uno a uno contra el HTML real y se hardcodean aquí,
//     igual que hace mangalect con su lista de géneros.
//
// ⚠️ SIN CONFIRMAR / BLOQUEADO — necesita captura real de tu parte:
//   Al intentar traer HTML real de /manga/ (catálogo), /manga/{id}/
//   (ficha) y /leer/{id}/{slug}/{n}/ (capítulo) con una petición simple
//   (sin sesión de navegador), el sitio devolvió 404 en los tres casos,
//   mientras que "/" sí respondió bien. Eso es el patrón típico de una
//   protección anti-bot/WAF que sólo deja pasar tráfico que parece un
//   navegador real (cookies de challenge, TLS fingerprint, etc.).
//
//   Esto es MUY probablemente la causa principal de que el plugin "no
//   funcione muy bien": detail(), chapters() y pageUrls() dependen todos
//   de esas rutas. No pude verificar contra HTML real:
//     - la estructura de la ficha (h1, portada, sinopsis, estado, lista
//       de capítulos) que usa detail()/chapters()
//     - si la lista de capítulos de la ficha pagina (como sí le pasaba a
//       mangalect, que necesitó seguir un enlace "?before=" para no
//       cortar mangas largos) — leercapitulo, tal cual está, NO sigue
//       ninguna paginación, así que si el sitio pagina igual, esto se
//       queda corto en mangas largos.
//     - si pageUrls() realmente necesita el fallback cifrado
//       (array_data) o si el scan de <img> normal ya es suficiente / al
//       revés (que el scan de <img> esté devolviendo miniaturas de
//       "relacionados" en vez de las páginas reales, colándose antes de
//       llegar al fallback correcto).
//
//   Para arreglar esas tres cosas con la misma confianza que mangalect
//   necesito que me pegues el HTML real (o una captura de red) de:
//     1. una ficha, p.ej. /manga/psvkfbmjgo/one-piece/
//     2. un capítulo, p.ej. /leer/psvkfbmjgo/one-piece/1194/
//   Puedes sacarlo con "Ver código fuente" / DevTools → Network → Copy
//   response, igual que se hizo para armar el plugin de mangalect.
//   Mientras tanto dejé detail()/chapters()/pageUrls() con la misma
//   lógica original (ligeramente reforzada) para no romper nada que
//   pudiera estar funcionando parcialmente.

const BASE_URL = "https://www.leercapitulo.co";
const PAGE_SIZE = 48;

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
      headers: { Referer: `${BASE_URL}/` },
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
      headers: { Referer: `${BASE_URL}/` },
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

function slugFromMangaHref(href) {
  if (!href) return null;

  const match = String(href).match(/\/manga\/([^/?#]+)/i);

  return match ? match[1] : null;
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

  // ⚠️ Sin confirmar contra HTML real de ficha (ver notas de cabecera).
  // Lógica intacta respecto al original.
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

    const coverMatch = html.match(/<img[^>]*(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*class=["'][^"']*(?:cover|manga)[^"']*["']/i) ||
                        html.match(/<img[^>]*class=["'][^"']*(?:cover|manga)[^"']*["'][^>]*(?:src|data-src|data-lazy-src)=["']([^"']+)["']/i);
    const cover = absoluteUrl(coverMatch?.[1]);

    const descMatch = html.match(/<p[^>]*id=["']example2["'][^>]*>([\s\S]*?)<\/p>/i) ||
                      html.match(/<p[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const description = descMatch ? cleanText(descMatch[1]) : undefined;

    const statusMatch = html.match(/Estado\s*:\s*<\/span>\s*([^<]+)/i);
    let status;
    if (statusMatch) {
      const statusRaw = cleanText(statusMatch[1]).toLowerCase();
      if (statusRaw.includes("curso")) status = "ongoing";
      else if (statusRaw.includes("complet") || statusRaw.includes("finaliz")) status = "completed";
    }

    const chapters = await plugin.chapters(id, html);
    const lastChapter = chapters.length > 0 ? chapters[chapters.length - 1].chapter : undefined;

    const result = {
      id,
      title,
      cover,
      description,
      status,
      lastChapter,
    };

    summaryCache.set(id, {
      id: result.id,
      title: result.title,
      cover: result.cover,
    });

    return result;
  },

  // ⚠️ Sin confirmar si la ficha pagina la lista de capítulos (como sí
  // le pasaba a mangalect). Si pagina y no lo seguimos, mangas largos se
  // quedarán cortos — exactamente el bug que se corrigió en mangalect.
  async chapters(id, cachedHtml) {
    let html = cachedHtml || (await fetchText(`/manga/${id}/`));

    if (!html) return [];

    const chapterRe = /<a[^>]+href=["']([^"']*\/leer\/[^"']*)["'][^>]*>[\s\S]*?(?:<(?:h[34]|span|strong|b)[^>]*>([^<]+)<\/(?:h[34]|span|strong|b)>|([^<]+))<\/a>/gi;

    const chapters = [];
    const seen = new Set();
    let m;

    while ((m = chapterRe.exec(html)) !== null) {
      const href = m[1];
      const chId = absoluteUrl(href);

      if (!chId || seen.has(chId)) continue;

      seen.add(chId);

      const titleText = cleanText(m[2] || m[3] || "");
      const number = href.split("/").filter(Boolean).pop();

      let title = titleText;
      if (!title && number) title = `Capítulo ${number}`;
      if (!title) title = number || "Sin título";

      chapters.push({
        id: chId,
        chapter: number,
        title,
        pages: 0,
        language: "es",
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
