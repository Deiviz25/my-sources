// leercapitulo.co — Harbor MangaProvider plugin
//
// Reescrito contra HTML real del sitio (portada, ficha de manga y capítulo),
// ya no son heurísticas a ciegas. Selectores confirmados:
//   - Portada: bloques ".hot-manga" (Tendencias) y ".mainpage-manga" (Últimos
//     Capítulos Agregados), cada uno con <img data-src="..."> + título.
//   - Ficha:  h1.title-manga, .cover-detail img, .description-update (alt
//     títulos + géneros + estado), #example2.manga-collapse (sinopsis),
//     .chapter-list ul li a.xanh (capítulos).
//   - Capítulo: id="array_data" (imágenes en base64 con sustitución) +
//     meta[property="ad:check"] (orden real de las páginas).
//
// ⚠️ LÍMITE CONOCIDO, NO ARREGLABLE DESDE EL PLUGIN: decodifiqué un
// array_data real y las imágenes viven en un CDN con ruta ofuscada
// (lc7-cdn.t34798ndc.com/...), el patrón típico de un host con protección
// anti-hotlink por Referer. pageUrls() en Harbor solo puede devolver
// string[] — no hay forma de adjuntar un header por imagen (a diferencia
// del formato Mangayomi, que sí soporta {url, headers} por página). Si el
// CDN exige Referer y lo rechaza, las imágenes fallarán pase lo que pase
// en este archivo; sería necesario que Harbor exponga headers por página
// en pageUrls(), no algo que yo pueda resolver aquí.
//
// ⚠️ Sin confirmar: la página de género (/genre/{slug}/) y su paginación.
// Asumo que reutiliza el mismo bloque ".mainpage-manga" que la portada
// porque es el patrón más común en este tipo de temas, pero no pude cargar
// una página de género real para confirmarlo. Si tagId no trae resultados,
// dímelo y lo reviso contra el HTML real de /genre/{slug}/.
 
const BASE_URL = "https://www.leercapitulo.co";
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
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();
}
 
// slug de la serie a partir de "/manga/SLUG/..." o "/leer/SLUG/.../N/"
function slugFromMangaHref(href) {
  const parts = href.split("/").filter(Boolean); // ["manga"|"leer", slug, ...]
  return parts[1] || href;
}
 
// --- parseo de tarjetas de manga (portada / género) -------------------------
// Reutilizado por popular() y por la búsqueda por género, porque ambas
// secciones de la portada comparten la misma forma de tarjeta: un enlace a
// /manga/, una <img data-src> para la portada y un título en un h3/h4 cerca.
 
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
 
// --- descifrado del array de páginas ---------------------------------------
// El sitio esconde la lista de imágenes de un capítulo en un <script
// id="array_data"> en base64 con las letras/dígitos sustituidos por este
// mapa. Confirmado contra un capítulo real: decodifica a URLs absolutas de
// imagen (ver aviso arriba sobre el CDN con protección anti-hotlink).
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
 
// --- MangaProvider -----------------------------------------------------
 
const plugin = {
  id: "leercapitulo",
  name: "LeerCapitulo",
 
  // La portada trae dos secciones ("Tendencias" y "Últimos Capítulos
  // Agregados") que pueden repetir la misma serie; se combinan y deduplican
  // por slug. No encontré paginación real de la portada, así que offset > 0
  // devuelve vacío en vez de repetir la misma página.
  async popular(offset, tagId) {
    if (tagId) return this._byGenre(tagId, offset);
    if (offset > 0) return [];
 
    const html = await fetchText("/");
    if (!html) return [];
 
    const cards = dedupeCardsBySlug([
      ...parseHotMangaBlocks(html),
      ...parseMainpageMangaBlocks(html),
    ]);
 
    return cards.slice(0, PAGE_SIZE).map((c) => ({
      id: c.href,
      title: c.title,
      cover: absoluteUrl(c.cover),
    }));
  },
 
  // Best-effort: asumo que /genre/{slug}/ usa el mismo layout que la
  // portada. Sin confirmar contra HTML real (ver aviso arriba).
  async _byGenre(tagId, offset) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const path = page > 1 ? `/genre/${tagId}/${page}/` : `/genre/${tagId}/`;
    const html = await fetchText(path);
    if (!html) return [];
 
    const cards = dedupeCardsBySlug([
      ...parseHotMangaBlocks(html),
      ...parseMainpageMangaBlocks(html),
    ]);
 
    return cards.slice(0, PAGE_SIZE).map((c) => ({
      id: c.href,
      title: c.title,
      cover: absoluteUrl(c.cover),
    }));
  },
 
  async search(query, offset, tagId) {
    if (!query && tagId) return this._byGenre(tagId, offset);
 
    const json = await fetchJson(`/search-autocomplete?term=${encodeURIComponent(query)}`);
    if (!Array.isArray(json)) return [];
 
    const page = json.slice(offset, offset + PAGE_SIZE);
    const results = [];
 
    if (json.length <= 6) {
      // Pocos resultados: enriquecerlos abriendo cada ficha para sacar títulos alternativos.
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
 
    const chapters = await plugin.chapters(id);
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
 
  async chapters(id) {
    const html = await fetchText(id);
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
 
  // ⚠️ Ver aviso al inicio del archivo: si el CDN de imágenes exige
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
 
  // Confirmado contra HTML real: sidebar de la portada y de la ficha.
  async tags() {
    const html = await fetchText("/");
    if (!html) return [];
 
    const doc = await harbor.parseHtml(html);
    const links = doc.querySelectorAll('a[href*="/genre/"]');
 
    const seen = new Set();
    const tags = [];
 
    for (const a of links) {
      const href = a.attr("href");
      const name = a.text();
      if (!href || !name || seen.has(href)) continue;
      seen.add(href);
 
      const slug = href.split("/genre/")[1]?.replace(/\/$/, "");
      if (!slug) continue;
 
      tags.push({ id: slug, name });
    }
 
    return tags;
  },
};
 
harbor.register(plugin);
 
