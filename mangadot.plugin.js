const BASE_URL = "https://mangadot.net";
const PAGE_SIZE = 48;

// --- helpers de red --------------------------------------------------------

async function fetchText(path) {
  const res = await harbor.http(`${BASE_URL}${path}`, { responseType: "text" });
  if (!res.ok) return null;
  return res.body;
}

async function fetchJson(path) {
  const res = await harbor.http(`${BASE_URL}${path}`, { responseType: "json" });
  if (!res.ok) return null;
  return res.body;
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

// --- MangaProvider -------------------------------------------------------

const plugin = {
  id: "mangadot",
  name: "MangaDot",

  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset);
    if (offset > 0) return [];

    const html = await fetchText("/");
    if (!html) return [];

    return parseMangaCards(html).slice(0, PAGE_SIZE);
  },

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
          scanlator: group,
        };
      })
      .filter(Boolean);

    chapters.sort((a, b) => parseFloat(a.chapter ?? "0") - parseFloat(b.chapter ?? "0"));
    return chapters;
  },

  async pageUrls(chapterId) {
    const json = await fetchJson(`/api/chapters/${chapterId}/images`);
    const images = Array.isArray(json?.images) ? json.images : [];

    return images
      .map((img) => absoluteUrl(img?.url))
      .filter(Boolean);
  },

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
