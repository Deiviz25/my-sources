const BASE_URL = "https://comix.to";
const API_URL = "https://comix.to/api/v1";
const PAGE_SIZE = 28;

// --- RC4 Encryption & Hashing ------------------------------------------------

const COMIX_KEYS = [
    "JxTcdyiA5GZxnbrmthXBQfU2IMTKcY1+3nNhbq98Sgo=",
    "3PordjODbhqla382Cxapmo/1JiABJQcjiJj1+48gTJ4=",
    "OaKvnI5ARA==",
    "MHNBHYWA7lvy867fXgvGcJwWDk79KqUJUVFsh3RwnnI=",
    "8i0Cru/VJBSVB2Y1GcMDVpzx2WepOcfnWdd81yxICl4=",
    "Fyskubz8VvA=",
    "B46L1x+UeWP+19cRpQ+OZvdLAK9EHID8g3mSgn57tew=",
    "DTSTmUt6LpDUw9r1lSQqyb3YlFTzruT8tk8wUGkwehQ=",
    "vY/meeI=",
    "7xWfIF5THL5LAnRgAARg+4mjWHPU9n3PQwvzbaMNi+Q=",
    "bewtiTuV+HJk56xxkf2iCljLgruCpBmN9BgE8i6gc9M=",
    "/Xcb2zAu8AU=",
    "WgeCQ3T8R51uTwVSiVa7Zy0dN6JOg6Z5JleMS+HV8Aw=",
    "yXayUVFrrcW56jQCEfZzuCidjpnWKjTDUNT7XeX9i7k=",
    "tSLco2w=",
];

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64ToBytes(b64) {
    const source = b64.replace(/=+$/, "");
    const output = new Uint8Array((source.length * 6) >> 3);
    let outIndex = 0;
    let bits = 0;
    let bitCount = 0;

    for (let i = 0; i < source.length; i++) {
        bits = (bits << 6) | B64_ALPHABET.indexOf(source.charAt(i));
        bitCount += 6;
        if (bitCount >= 8) {
            bitCount -= 8;
            output[outIndex++] = (bits >> bitCount) & 0xff;
        }
    }

    return output;
}

function bytesToUrlB64NoPad(bytes) {
    let output = "";
    let bits = 0;
    let bitCount = 0;

    for (let i = 0; i < bytes.length; i++) {
        bits = (bits << 8) | bytes[i];
        bitCount += 8;
        while (bitCount >= 6) {
            bitCount -= 6;
            output += B64_URL_ALPHABET.charAt((bits >> bitCount) & 0x3f);
        }
    }

    if (bitCount > 0) {
        output += B64_URL_ALPHABET.charAt((bits << (6 - bitCount)) & 0x3f);
    }

    return output;
}

function strToAsciiBytes(value) {
    const output = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
        output[i] = value.charCodeAt(i) & 0xff;
    }
    return output;
}

function getKeyBytes(index) {
    return b64ToBytes(COMIX_KEYS[index]);
}

function rc4(key, data) {
    if (key.length === 0) {
        return new Uint8Array(data);
    }

    const state = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        state[i] = i;
    }

    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + state[i] + key[i % key.length]) & 0xff;
        const tmp = state[i];
        state[i] = state[j];
        state[j] = tmp;
    }

    const output = new Uint8Array(data.length);
    let i = 0;
    j = 0;

    for (let n = 0; n < data.length; n++) {
        i = (i + 1) & 0xff;
        j = (j + state[i]) & 0xff;
        const tmp = state[i];
        state[i] = state[j];
        state[j] = tmp;
        output[n] = data[n] ^ state[(state[i] + state[j]) & 0xff];
    }

    return output;
}

function opShiftRight7Left1(value) {
    return ((value >>> 7) | (value << 1)) & 0xff;
}

function opShiftLeft1Right7(value) {
    return ((value << 1) | (value >>> 7)) & 0xff;
}

function opShiftRight2Left6(value) {
    return ((value >>> 2) | (value << 6)) & 0xff;
}

function opShiftLeft4Right4(value) {
    return ((value << 4) | (value >>> 4)) & 0xff;
}

function opShiftRight4Left4(value) {
    return ((value >>> 4) | (value << 4)) & 0xff;
}

function getMutKey(mutKey, index) {
    const keyIndex = index % 32;
    return mutKey.length > 0 && keyIndex < mutKey.length ? mutKey[keyIndex] : 0;
}

function mutateRound(data, mutKeyIndex, prefKeyIndex, prefLength, round) {
    const mutKey = getKeyBytes(mutKeyIndex);
    const prefKey = getKeyBytes(prefKeyIndex);
    const output = [];

    for (let i = 0; i < data.length; i++) {
        if (i < prefLength && i < prefKey.length) {
            output.push(prefKey[i]);
        }

        let value = (data[i] ^ getMutKey(mutKey, i)) & 0xff;
        const mode = i % 10;

        switch (round) {
            case 1:
                switch (mode) {
                    case 0: value = opShiftRight7Left1(value); break;
                    case 1: value ^= 37; break;
                    case 2: value ^= 81; break;
                    case 3: value ^= 147; break;
                    case 4: value = opShiftRight2Left6(value); break;
                    case 5:
                    case 8: value = opShiftRight4Left4(value); break;
                    case 6: value ^= 218; break;
                    case 7: value = (value + 159) & 0xff; break;
                    case 9: value ^= 180; break;
                }
                break;
            case 2:
                switch (mode) {
                    case 0:
                    case 9: value ^= 180; break;
                    case 1: value = opShiftLeft1Right7(value); break;
                    case 2: value ^= 147; break;
                    case 3: value = opShiftRight7Left1(value); break;
                    case 4: value = opShiftRight2Left6(value); break;
                    case 5: value = opShiftRight4Left4(value); break;
                    case 6:
                    case 8: value = (value + 159) & 0xff; break;
                    case 7: value = (value + 34) & 0xff; break;
                }
                break;
            case 3:
                switch (mode) {
                    case 0: value ^= 81; break;
                    case 1: value = opShiftRight4Left4(value); break;
                    case 2:
                    case 9: value = opShiftLeft4Right4(value); break;
                    case 3: value ^= 37; break;
                    case 4: value = (value + 159) & 0xff; break;
                    case 5: value = opShiftLeft1Right7(value); break;
                    case 6: value ^= 180; break;
                    case 7: value = (value + 34) & 0xff; break;
                    case 8: value = opShiftRight2Left6(value); break;
                }
                break;
            case 4:
                switch (mode) {
                    case 0:
                    case 7: value ^= 218; break;
                    case 1:
                    case 4: value = opShiftLeft1Right7(value); break;
                    case 2: value = opShiftRight7Left1(value); break;
                    case 3: value = (value + 159) & 0xff; break;
                    case 5:
                    case 8: value ^= 180; break;
                    case 6: value ^= 147; break;
                    case 9: value ^= 37; break;
                }
                break;
            case 5:
                switch (mode) {
                    case 0: value = opShiftLeft4Right4(value); break;
                    case 1:
                    case 3: value ^= 147; break;
                    case 2: value = (value + 34) & 0xff; break;
                    case 4:
                    case 9: value ^= 218; break;
                    case 5:
                    case 7: value = opShiftLeft1Right7(value); break;
                    case 6: value ^= 180; break;
                    case 8: value = opShiftRight2Left6(value); break;
                }
                break;
        }

        output.push(value & 0xff);
    }

    return new Uint8Array(output);
}

function applyRound(data, rc4KeyIndex, mutKeyIndex, prefKeyIndex, prefLength, round) {
    const mutated = mutateRound(data, mutKeyIndex, prefKeyIndex, prefLength, round);
    return rc4(getKeyBytes(rc4KeyIndex), mutated);
}

function round1(data) { return applyRound(data, 0, 1, 2, 7, 1); }
function round2(data) { return applyRound(data, 3, 4, 5, 8, 2); }
function round3(data) { return applyRound(data, 6, 7, 8, 5, 3); }
function round4(data) { return applyRound(data, 9, 10, 11, 8, 4); }
function round5(data) { return applyRound(data, 12, 13, 14, 5, 5); }

function generateComixHash(path) {
    const encoded = encodeURIComponent(path)
        .replace(/\+/g, "%20")
        .replace(/\*/g, "%2A")
        .replace(/%7E/g, "~");
    const bytes = strToAsciiBytes(encoded);
    const result = round5(round4(round3(round2(round1(bytes)))));
    return bytesToUrlB64NoPad(result);
}

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

// --- helpers de parsing --------------------------------------------------------

function getPosterUrl(item) {
    const poster = item.poster || {};
    return poster.large || poster.medium || poster.small || "";
}

function extractSlugFromItem(item, hashId) {
    const slug = item.slug || "";
    return slug;
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

        const url = `${API_URL}/manga?keyword=${encodeURIComponent(query)}&order[relevance]=desc&limit=${PAGE_SIZE}&page=1`;
        const data = await fetchJson(url);
        
        if (!data || !data.result || !data.result.items) return [];

        const items = data.result.items;
        const mangas = [];

        for (const item of items) {
            const hashId = item.hid || item.hash_id;
            if (!hashId) continue;

            mangas.push({
                id: hashId,
                title: decodeEntities(item.title || hashId),
                cover: absoluteUrl(getPosterUrl(item)),
            });
        }

        return mangas.slice(offset, offset + PAGE_SIZE);
    },

    async detail(id) {
        const hashId = String(id).split("|")[0];

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

        const path = `/manga/${hashId}`;
        const token = generateComixHash(path);
        const data = await fetchJson(`${API_URL}${path}?_=${encodeURIComponent(token)}`);

        if (!data || !data.result) {
            return {
                id,
                title: id,
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
            title: decodeEntities(item.title || id),
            cover: absoluteUrl(getPosterUrl(item)),
            description: decodeEntities(item.description || item.synopsis) || undefined,
            author: item.author || undefined,
            status: item.status ? item.status.toLowerCase() : undefined,
            lastChapter,
        };
    },

    async chapters(id) {
        const hashId = String(id).split("|")[0];

        if (!hashId) return [];

        const path = `/manga/${hashId}/chapters`;
        const token = generateComixHash(path);
        const url = `${API_URL}${path}?order[number]=desc&limit=100&page=1&_=${encodeURIComponent(token)}`;
        
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
    },

    async pageUrls(chapterId) {
        const specificChapterId = String(chapterId).split("|")[0];

        if (!specificChapterId) return [];

        const path = `/chapters/${specificChapterId}`;
        const token = generateComixHash(path);
        const data = await fetchJson(`${API_URL}${path}?_=${encodeURIComponent(token)}`);

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
    },

    async tags() {
        return [];
    },
};

harbor.register(plugin);
