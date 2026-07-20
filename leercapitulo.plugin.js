/// <reference path="./manga-provider.d.ts" />

const baseUrl = "https://www.leercapitulo.co";

const plugin = {
    id: "leercapitulo",
    name: "LeerCapítulo",

    async popular(offset = 0) {
        const page = Math.floor(offset / 48) + 1;
        const res = await harbor.http(`${baseUrl}/?page=${page}`, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const items = [];

        doc.querySelectorAll("img").forEach(img => {
            const src = img.attr("src") || img.attr("data-src") || "";
            const link = img.closest("a");
            const title = link ? link.text().trim() || img.attr("alt") : "";

            if (src && title && link && src.includes("/covers/")) {
                items.push({
                    id: link.attr("href"),
                    title: title,
                    cover: src.startsWith("http") ? src : baseUrl + src
                });
            }
        });

        return items;
    },

    async search(query, offset = 0) {
        const res = await harbor.http(`${baseUrl}/?s=${encodeURIComponent(query)}`, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const items = [];

        doc.querySelectorAll("img").forEach(img => {
            const src = img.attr("src") || img.attr("data-src") || "";
            const link = img.closest("a");
            const title = img.attr("alt") || (link ? link.text().trim() : "");

            if (src && title && link) {
                items.push({
                    id: link.attr("href"),
                    title: title,
                    cover: src.startsWith("http") ? src : baseUrl + src
                });
            }
        });

        return items;
    },

    async detail(id) {
        const res = await harbor.http(baseUrl + id, { responseType: "text" });
        if (!res.ok) return null;

        const doc = await harbor.parseHtml(res.body);

        return {
            id,
            title: doc.querySelector("h1")?.text()?.trim() || "Sin título",
            cover: doc.querySelector("img[src*='/covers/']")?.attr("src") || "",
            description: doc.querySelector("#example2, p")?.text()?.trim(),
        };
    },

    async chapters(id) {
        const res = await harbor.http(baseUrl + id, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const chapters = [];

        doc.querySelectorAll("a[href*='/leer/']").forEach(link => {
            const text = link.text().trim();
            if (text) {
                chapters.push({
                    id: link.attr("href"),
                    chapter: text.match(/\d+/)?.[0] || "",
                    title: text,
                    pages: 0,
                    language: "es"
                });
            }
        });

        return chapters.reverse();
    },

    async pageUrls(chapterId) {
        const res = await harbor.http(baseUrl + chapterId, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const urls = [];

        doc.querySelectorAll("img").forEach(img => {
            let src = img.attr("src") || img.attr("data-src") || "";
            if (src && /\.(jpg|jpeg|png|webp)/i.test(src)) {
                if (!src.startsWith("http")) src = baseUrl + (src.startsWith("/") ? "" : "/") + src;
                if (!urls.includes(src)) urls.push(src);
            }
        });

        return urls;
    }
};

harbor.register(plugin);
