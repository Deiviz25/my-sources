const BASE_URL = "https://comix.to";
const API_URL = "https://comix.to/api/v1";
const PAGE_SIZE = 28;

// --- helpers de red --------------------------------------------------------

async function fetchJson(path) {
    const res = await harbor.http(path, { responseType: "json" });
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
        .replace(/&#0?39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getPosterUrl(item) {
    const poster = item.poster || {};
    return poster.large || poster.medium || poster.small || "";
}

function formatChapterNumber(value) {
    const str = String(value);
    return str.endsWith(".0") ? str.slice(0, -2) : str;
}

function extractChapterNumber(chapterStr) {
    const num = parseFloat(chapterStr);
    if (!isNaN(num)) {
        return num;
    }
    const match = chapterStr.match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : 0;
}

// --- MangaProvider -------------------------------------------------------

const plugin = {
    id: "comix",
    name: "Comix",

    async popular(offset, tagId) {
        if (offset > 0) return [];
        return [];
    },

    async _byGenre(tagId, offset) {
        if (offset > 0) return [];
        return [];
    },

    async search(query, offset, tagId) {
        if (!query && tagId) return plugin._byGenre(tagId, offset);

        try {
            const url = `${API_URL}/manga?keyword=${encodeURIComponent(query)}&order[relevance]=desc&limit=${PAGE_SIZE}&page=1`;
            const data = await fetchJson(url);
            
            if (!data || !data.result || !data.result.items) return [];

            const items = data.result.items;
            const mangas = [];

            for (const item of items) {
                const hashId = item.hid || item.hash_id;
                if (!hashId) continue;

                mangas.push({
                    id: String(hashId),
                    title: decodeEntities(item.title || String(hashId)),
                    cover: absoluteUrl(getPosterUrl(item)),
                });
            }

            return mangas.slice(offset, offset + PAGE_SIZE);
        } catch (e) {
            return [];
        }
    },

    async detail(id) {
        try {
            const hashId = String(id || "").split("|")[0];

            if (!hashId) {
                return {
                    id,
                    title: id,
                    cover: undefined,
                    description: undefined,
                    author: undefined,
                    status: undefined,
                    lastChapter: undefined,
                };
            }

            const chapters = await plugin.chapters(id);
            const lastChapter = chapters.length
                ? chapters[chapters.length - 1].chapter
                : undefined;

            const url = `${API_URL}/manga/${hashId}`;
            const data = await fetchJson(url);

            if (!data || !data.result) {
                return {
                    id,
                    title: String(id),
                    cover: undefined,
                    description: undefined,
                    author: undefined,
                    status: undefined,
                    lastChapter,
                };
            }

            const item = data.result;

            return {
                id,
                title: decodeEntities(item.title || String(hashId)),
                cover: absoluteUrl(getPosterUrl(item)),
                description: decodeEntities(item.description || item.synopsis) || undefined,
                author: item.author || undefined,
                status: item.status ? item.status.toLowerCase() : undefined,
                lastChapter,
            };
        } catch (e) {
            return {
                id,
                title: String(id),
                cover: undefined,
                description: undefined,
                author: undefined,
                status: undefined,
                lastChapter: undefined,
            };
        }
    },

    async chapters(id) {
        try {
            const hashId = String(id || "").split("|")[0];

            if (!hashId) return [];

            const url = `${API_URL}/manga/${hashId}/chapters?order[number]=desc&limit=100&page=1`;
            
            const firstData = await fetchJson(url);
            if (!firstData || !firstData.result || !firstData.result.items) return [];

            const allChapters = firstData.result.items.slice();

            const chapters = [];

            for (const item of allChapters) {
                if (item.language && item.language.toLowerCase() !== "en" && item.language.toLowerCase() !== "english") {
                    continue;
                }

                const chapterId = item.id != null ? item.id : item.chapter_id;
                const chapterNumber = item.number != null
                    ? formatChapterNumber(item.number)
                    : (item.chapter || item.chap || "");

                if (!chapterId || !chapterNumber) continue;

                const chapterTitle = item.name && item.name.trim().length > 0
                    ? `Chapter ${chapterNumber}: ${item.name}`
                    : `Chapter ${chapterNumber}`;

                const group = item.group || item.scanlation_group;
                const isOfficial = item.isOfficial === true || item.isOfficial === 1 || item.is_official === true || item.is_official === 1;
                const scanlator = group && group.name
                    ? group.name.trim()
                    : (isOfficial ? "Official" : undefined);

                chapters.push({
                    id: String(chapterId),
                    chapter: chapterNumber,
                    title: chapterTitle,
                    pages: 0,
                    language: "en",
                    publishAt: item.updatedAtFormatted || item.createdAtFormatted || (item.updated_at ? item.updated_at.toString() : undefined),
                    scanlator,
                });
            }

            chapters.sort((a, b) => {
                return extractChapterNumber(b.chapter) - extractChapterNumber(a.chapter);
            });

            return chapters;
        } catch (e) {
            return [];
        }
    },

    async pageUrls(chapterId) {
        try {
            const specificChapterId = String(chapterId || "").split("|")[0];

            if (!specificChapterId) return [];

            const url = `${API_URL}/chapters/${specificChapterId}/images`;
            const data = await fetchJson(url);

            if (!data || !data.result) return [];

            const result = data.result;
            const images = result.pages || result.images || [];

            const urls = [];
            for (const img of images) {
                if (img && img.url) {
                    urls.push(absoluteUrl(img.url));
                }
            }

            return urls.filter(Boolean);
        } catch (e) {
            return [];
        }
    },

    async tags() {
        return [];
    },
};

harbor.register(plugin);
