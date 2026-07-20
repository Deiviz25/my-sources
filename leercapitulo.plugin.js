// leercapitulo.co — Harbor MangaProvider plugin
//
// ⚠️ Riesgo conocido: el scraper original mandaba `Referer: baseUrl/` en
// TODAS las peticiones. Al probar el sitio directamente, cualquier ruta
// que no fuera la portada (una ficha de manga, una página de género)
// devolvió 404 sin ese header. Harbor elimina la cabecera "referer" de
// toda llamada harbor.http (ver sección 3 de la API), así que es posible
// que chapters()/pageUrls()/detail() fallen igual una vez instalado. No es
// algo que se pueda arreglar desde el plugin — pruébalo pronto y, si pasa,
// es un límite del host, no un bug de este archivo.
//
// ⚠️ popular() y detail() son "best effort": no pude cargar una ficha de
// manga real mientras escribía esto (mismo bloqueo de arriba), así que
// esos dos usan heurísticas genéricas (enlaces a "/manga/", meta og:image,
// <title>) en vez de selectores confirmados contra el HTML real. Revísalos
// si algún campo vuelve vacío.
 
const BASE_URL = "https://www.leercapitulo.co";
const PAGE_SIZE = 48; // MANGA_PAGE: offset -> página
 
// --- helpers de red --------------------------------------------------------
 
async function fetchText(path) {
  const res = await harbor.http(`${BASE_URL}${path}`, { responseType: "text" });
  if (!res.ok) return null;
  return res.body;
}
 
async function fetchJson(path) {
  // Con responseType "json" harbor.http ya devuelve el valor parseado
  // (o null si el body no era JSON válido), sin envoltorio { ok, body }.
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
 
// --- descifrado del array de páginas ---------------------------------------
// El sitio esconde la lista de imágenes de un capítulo en un <script
// id="array_data"> en base64 con las letras/dígitos sustituidos por este
// mapa. Harbor.parseHtml quita los <script>, así que esto tiene que seguir
// haciéndose con regex sobre el texto crudo (lo dice la propia spec).
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
    decoded = atob(replaced); // Buffer no existe en el worker de Harbor
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
 
  // No encontré un endpoint de "populares" paginado de verdad: esto lee la
  // portada y saca todos los enlaces "/manga/..." que hay en ella (mezcla
  // la sección "Tendencias" con "Últimos Capitulos Agregados", porque sin
  // el HTML real no puedo aislar solo la primera por clase). Al no ser
  // paginable, offsets > 0 devuelven vacío.
  async popular(offset, tagId) {
    if (offset > 0) return [];
 
    const html = await fetchText("/");
    if (!html) return [];
 
    const doc = await harbor.parseHtml(html);
    const links = doc.querySelectorAll('a[href*="/manga/"]');
 
    const seen = new Set();
    const results = [];
 
    for (const a of links) {
      const href = a.attr("href");
      const title = a.text();
      if (!href || !title || seen.has(href)) continue;
      seen.add(href);
 
      results.push({ id: href, title });
      if (results.length >= PAGE_SIZE) break;
    }
 
    return results;
  },
 
  async search(query, offset, tagId) {
    const json = await fetchJson(`/search-autocomplete?term=${encodeURIComponent(query)}`);
    if (!Array.isArray(json)) return [];
 
    const page = json.slice(offset, offset + PAGE_SIZE);
    const results = [];
 
    if (json.length <= 6) {
      // Pocos resultados: enriquecerlos abriendo cada ficha para sacar títulos alternativos.
      for (const serie of page) {
        const html = await fetchText(serie.link);
        const altTitle = html
          ?.match(/<span>Títulos Alternativos: <\/span>(.*?)<br>/s)?.[1]
          ?.split(", ")
          .map((t) => t.trim())
          .join(", ");
 
        results.push({
          id: serie.link,
          title: serie.label,
          altTitle,
          cover: absoluteUrl(serie.thumbnail),
        });
      }
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
 
    const titleMatch = html.match(/<title>(.*?)(?:\s*\|\s*leercapitulo\.co)?<\/title>/i);
    const coverMatch = html.match(/property="og:image"\s+content="([^"]+)"/i);
    const altTitle = html
      .match(/<span>Títulos Alternativos: <\/span>(.*?)<br>/s)?.[1]
      ?.split(", ")
      .map((t) => t.trim())
      .join(", ");
 
    return {
      id,
      title: titleMatch ? titleMatch[1].trim() : id,
      altTitle,
      cover: absoluteUrl(coverMatch?.[1]),
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
      const title = titleMatch ? titleMatch[1].trim() : "";
      const urlParts = url.split("/");
      const number = urlParts[urlParts.length - 2];
 
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
 
  // Lista de géneros de la portada — esta sí la pude confirmar contra el
  // HTML real (URLs y nombres exactos), así que va sin advertencias.
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
