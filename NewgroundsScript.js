// Newgrounds source plugin for Grayjay
// Supports: featured movies home feed, movie + audio search, user search,
// movie playback (MP4, all qualities), audio playback (MP3), user channels (movies + audio),
// comments (Newgrounds reviews).

const PLATFORM = "Newgrounds";
const BASE = "https://www.newgrounds.com";
const XHR = { "X-Requested-With": "XMLHttpRequest" };
const PAGE_SIZE = 20;

const REGEX_VIDEO_URL = /^https?:\/\/(?:www\.)?newgrounds\.com\/portal\/view\/(\d+)/i;
const REGEX_AUDIO_URL = /^https?:\/\/(?:www\.)?newgrounds\.com\/audio\/listen\/(\d+)/i;
const REGEX_CHANNEL_URL = /^https?:\/\/(?!www\.)([a-z0-9_-]+)\.newgrounds\.com\/?/i;

let config = {};

// ---------------------------------------------------------------- lifecycle

source.enable = function (conf, settings, savedState) {
    config = conf ?? {};
};

source.disable = function () { };

// ---------------------------------------------------------------- home

source.getHome = function () {
    return new FeaturedPager(0);
};

class FeaturedPager extends VideoPager {
    constructor(offset) {
        const json = getJson(`${BASE}/movies/featured?offset=${offset}&inner=1`);
        const results = parseCards(json.content ?? "");
        const next = offset + PAGE_SIZE;
        super(results, results.length > 0 && next < (json.total ?? 0), { offset: next });
    }
    nextPage() {
        return new FeaturedPager(this.context.offset);
    }
}

// ---------------------------------------------------------------- search

source.searchSuggestions = function (query) {
    return [];
};

source.getSearchCapabilities = function () {
    return {
        types: [Type.Feed.Mixed],
        sorts: [],
        filters: [
            new FilterGroup("Content", [
                new FilterCapability("Movies", "movies", "movies"),
                new FilterCapability("Audio", "audio", "audio")
            ], false, "content")
        ]
    };
};

source.search = function (query, type, order, filters) {
    let kind = "movies";
    if (filters && filters.content && filters.content.length > 0)
        kind = filters.content[0];
    return new SearchPager(query, kind, 1);
};

class SearchPager extends VideoPager {
    constructor(query, kind, page) {
        const html = getHtml(`${BASE}/search/conduct/${kind}?terms=${encodeURIComponent(query)}&page=${page}`);
        const results = parseCards(html);
        const hasMore = html.includes(`page=${page + 1}"`) || html.includes(`page=${page + 1}&`);
        super(results, results.length > 0 && hasMore, { query, kind, page });
    }
    nextPage() {
        return new SearchPager(this.context.query, this.context.kind, this.context.page + 1);
    }
}

source.searchChannels = function (query) {
    return new UserSearchPager(query, 1);
};

class UserSearchPager extends ChannelPager {
    constructor(query, page) {
        const html = getHtml(`${BASE}/search/conduct/users?terms=${encodeURIComponent(query)}&page=${page}`);
        const results = [];
        const re = /<div class="item-user">([\s\S]*?)<\/h4>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const block = m[1];
            const url = match(block, /href="(https:\/\/[a-z0-9_-]+\.newgrounds\.com)"/i);
            const name = decode(match(block, /<h4>\s*<a [^>]*>([^<]+)<\/a>/));
            if (!url || !name) continue;
            results.push(new PlatformChannel({
                id: new PlatformID(PLATFORM, name.toLowerCase(), config.id),
                name: name,
                thumbnail: match(block, /<image href="([^"]+)"/) ?? "",
                banner: "",
                subscribers: -1,
                description: "",
                url: url,
                links: {}
            }));
        }
        const hasMore = html.includes(`page=${page + 1}"`) || html.includes(`page=${page + 1}&`);
        super(results, results.length > 0 && hasMore, { query, page });
    }
    nextPage() {
        return new UserSearchPager(this.context.query, this.context.page + 1);
    }
}

// ---------------------------------------------------------------- content details

source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(url) || REGEX_AUDIO_URL.test(url);
};

source.getContentDetails = function (url) {
    const v = url.match(REGEX_VIDEO_URL);
    if (v) return getMovieDetails(v[1]);
    const a = url.match(REGEX_AUDIO_URL);
    if (a) return getAudioDetails(a[1]);
    throw new ScriptException("Unsupported Newgrounds URL: " + url);
};

function getMovieDetails(id) {
    const pageUrl = `${BASE}/portal/view/${id}`;
    const html = getHtml(pageUrl);

    const resp = http.GET(`${BASE}/portal/video/${id}`, XHR, false);
    let json = null;
    try { json = JSON.parse(resp.body); } catch (e) { }
    if (!resp.isOk || !json || !json.sources) {
        const err = json && json.errors ? json.errors.join(" ") : `HTTP ${resp.code}`;
        throw new ScriptException("Could not load this movie (it may be adult-rated or a Flash/Ruffle submission): " + err);
    }

    const sources = [];
    for (const quality of Object.keys(json.sources)) {
        const height = parseInt(quality) || 0;
        for (const s of json.sources[quality]) {
            if (!s.src) continue;
            sources.push(new VideoUrlSource({
                name: quality,
                url: s.src,
                width: Math.round(height * 16 / 9),
                height: height,
                container: s.type || "video/mp4",
                codec: "",
                bitrate: 0,
                duration: 0
            }));
        }
    }
    sources.sort((a, b) => b.height - a.height);

    const meta = parsePageMeta(html);
    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, id, config.id),
        name: decode(json.title) || meta.title,
        thumbnails: thumbs(meta.thumbnail),
        author: meta.author ?? authorFromName(json.author),
        uploadDate: meta.date,
        datetime: meta.date,
        duration: 0,
        viewCount: meta.views,
        url: pageUrl,
        shareUrl: pageUrl,
        isLive: false,
        description: meta.description,
        video: new VideoSourceDescriptor(sources),
        rating: meta.rating
    });
}

function getAudioDetails(id) {
    const pageUrl = `${BASE}/audio/listen/${id}`;
    const html = getHtml(pageUrl);
    const mp3 = decode(metaProp(html, "og:audio"));
    if (!mp3)
        throw new ScriptException("Could not find an audio stream for this submission.");

    const meta = parsePageMeta(html);
    const audio = new AudioUrlSource({
        name: "MP3",
        url: mp3,
        container: "audio/mpeg",
        codec: "mp3",
        bitrate: 0,
        duration: 0,
        language: "Unknown"
    });

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, "audio-" + id, config.id),
        name: meta.title,
        thumbnails: thumbs(meta.thumbnail),
        author: meta.author ?? authorFromName("Unknown"),
        uploadDate: meta.date,
        datetime: meta.date,
        duration: 0,
        viewCount: meta.views,
        url: pageUrl,
        shareUrl: pageUrl,
        isLive: false,
        description: meta.description,
        video: new UnMuxVideoSourceDescriptor([], [audio]),
        rating: meta.rating
    });
}

function parsePageMeta(html) {
    const title = decode(metaProp(html, "og:title")) || "";
    const thumbnail = decode(metaItemprop(html, "thumbnailUrl") || metaProp(html, "og:image")) || "";
    const dateStr = metaItemprop(html, "datePublished") || metaItemprop(html, "uploadDate");
    const date = dateStr ? Math.floor(Date.parse(dateStr) / 1000) : 0;

    const viewsStr = match(html, /<dt>(?:Views|Listens)<\/dt>\s*<dd>([\d,]+)<\/dd>/);
    const views = viewsStr ? parseInt(viewsStr.replace(/,/g, "")) : 0;

    let description = "";
    const descHtml = match(html, /id="author_comments"[^>]*>([\s\S]*?)<\/div>/);
    if (descHtml) description = htmlToText(descHtml);
    if (!description) description = decode(metaProp(html, "og:description")) || "";

    let author = null;
    const userBlock = match(html, /class="item-user"[^>]*>([\s\S]*?)<\/h4>/);
    if (userBlock) {
        const url = match(userBlock, /href="(https:\/\/[a-z0-9_-]+\.newgrounds\.com)"/i);
        const name = decode(match(userBlock, /<h4[^>]*>\s*<a [^>]*>([^<]+)<\/a>/));
        const icon = match(userBlock, /<image href="([^"]+)"/);
        if (url && name)
            author = new PlatformAuthorLink(new PlatformID(PLATFORM, name.toLowerCase(), config.id), name, url, icon ?? "");
    }

    let rating = null;
    const ratingValue = parseFloat(metaItemprop(html, "ratingValue"));
    if (!isNaN(ratingValue)) rating = new RatingScaler(ratingValue / 10);

    return { title, thumbnail, date, views, description, author, rating };
}

// ---------------------------------------------------------------- comments (reviews)

// Newgrounds calls comments "reviews". The submission page holds the first 5;
// later pages come from /reviews/portal/ID/TYPE/date/PAGE, 5 per page.
const REVIEW_PAGES_PER_BATCH = 4;

source.getComments = function (url) {
    const v = url.match(REGEX_VIDEO_URL);
    const a = url.match(REGEX_AUDIO_URL);
    if (!v && !a) return new CommentPager([], false, {});
    const pageUrl = v ? `${BASE}/portal/view/${v[1]}` : `${BASE}/audio/listen/${a[1]}`;
    const html = getHtml(pageUrl);

    let ctx = null;
    const nav = html.match(/\/reviews\/portal\/(\d+)\/(\d+)\/date\//);
    if (nav) {
        let last = 1;
        const re = /\/reviews\/portal\/\d+\/\d+\/date\/(\d+)/g;
        let m;
        while ((m = re.exec(html)) !== null) last = Math.max(last, parseInt(m[1]));
        ctx = { pageUrl, id: nav[1], type: nav[2], next: 2, last };
    }
    return new ReviewPager(parseReviews(html, pageUrl), ctx);
};

source.getSubComments = function (comment) {
    return new CommentPager([], false, {});
};

class ReviewPager extends CommentPager {
    constructor(results, ctx) {
        super(results, !!ctx && ctx.next <= ctx.last, ctx ?? {});
    }
    nextPage() {
        const c = this.context;
        let results = [];
        const stop = Math.min(c.last, c.next + REVIEW_PAGES_PER_BATCH - 1);
        let page = c.next;
        for (; page <= stop; page++) {
            const resp = http.GET(`${BASE}/reviews/portal/${c.id}/${c.type}/date/${page}`, XHR, false);
            if (!resp.isOk) break;
            results = results.concat(parseReviews(resp.body, c.pageUrl));
        }
        return new ReviewPager(results, { ...c, next: page });
    }
}

function parseReviews(html, contextUrl) {
    const out = [];
    const re = /class="pod-body review"[\s\S]*?data-review-id="(\d+)"([\s\S]*?)ngutils\.review\.register/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const id = m[1];
        const block = m[2];

        const userUrl = match(block, /<a href="(https:\/\/[a-z0-9_-]+\.newgrounds\.com)"/i);
        const name = decode(match(block, /<span class="padded-half-left">([^<]+)<\/span>/) ??
            match(block, /title="([^"]+)"/)) || "Anonymous";
        const avatar = match(block, /<image href="([^"]+)"/) ?? "";
        const author = userUrl
            ? new PlatformAuthorLink(new PlatformID(PLATFORM, name.toLowerCase(), config.id), name, userUrl, avatar)
            : new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), name, "", avatar);

        // Times are shown in Newgrounds server time (US Eastern).
        const timeStr = match(block, /<time[^>]*>([^<]+)<\/time>/);
        const date = timeStr ? Math.floor(Date.parse(timeStr.trim().replace(" ", "T") + "-05:00") / 1000) || 0 : 0;

        const score = match(block, /title="Score:\s*([\d.]+)\/5/);
        const body = htmlToText(match(block, /class="review-body[^"]*"[^>]*>([\s\S]*?)<\/div>/) ?? "");
        const message = score ? `★ ${parseFloat(score)}/5\n${body}` : body;

        out.push(new Comment({
            contextUrl: contextUrl,
            author: author,
            message: message,
            rating: new RatingLikes(0),
            date: date,
            replyCount: 0,
            context: { reviewId: id }
        }));
    }
    return out;
}

// ---------------------------------------------------------------- channels

source.isChannelUrl = function (url) {
    return REGEX_CHANNEL_URL.test(url);
};

source.getChannel = function (url) {
    const user = channelName(url);
    const channelUrl = `https://${user}.newgrounds.com`;
    const html = getHtml(channelUrl + "/");

    const name = (decode(metaProp(html, "og:title")) || user).replace(/\s*-\s*newgrounds\.com\s*$/i, "");
    const avatar = decode(metaProp(html, "og:image")) || "";
    const fansStr = match(html, /FANS<\/span>\s*<strong>([^<]+)<\/strong>/i);

    return new PlatformChannel({
        id: new PlatformID(PLATFORM, user, config.id),
        name: name,
        thumbnail: avatar,
        banner: "",
        subscribers: parseCount(fansStr),
        description: decode(metaProp(html, "og:description")) || "",
        url: channelUrl,
        urlAlternatives: [channelUrl + "/", channelUrl + "/movies", channelUrl + "/audio"],
        links: {}
    });
};

source.getChannelCapabilities = function () {
    return { types: [Type.Feed.Mixed], sorts: [Type.Order.Chronological] };
};

source.getChannelContents = function (url, type, order, filters) {
    const user = channelName(url);
    const author = new PlatformAuthorLink(
        new PlatformID(PLATFORM, user, config.id), user, `https://${user}.newgrounds.com`, "");
    return new ChannelContentPager(user, author, "movies", 1);
};

class ChannelContentPager extends VideoPager {
    constructor(user, author, kind, page) {
        const json = getJson(`https://${user}.newgrounds.com/${kind}?page=${page}`, true);
        let results = [];
        if (json && json.items) {
            const years = Object.keys(json.items).sort((a, b) => parseInt(b) - parseInt(a));
            for (const y of years)
                for (const cardHtml of json.items[y])
                    results = results.concat(parseCards(cardHtml, author));
        }
        results.sort((a, b) => parseInt(b.id.value.replace(/\D/g, "")) - parseInt(a.id.value.replace(/\D/g, "")));

        const moreInKind = !!(json && json.load_more && String(json.load_more).trim());
        let ctx;
        if (moreInKind) ctx = { user, author, kind, page: page + 1 };
        else if (kind === "movies") ctx = { user, author, kind: "audio", page: 1 };
        else ctx = null;

        super(results, ctx !== null, ctx);
    }
    nextPage() {
        const c = this.context;
        return new ChannelContentPager(c.user, c.author, c.kind, c.page);
    }
}

function channelName(url) {
    const m = url.match(REGEX_CHANNEL_URL);
    if (!m) throw new ScriptException("Not a Newgrounds user URL: " + url);
    return m[1].toLowerCase();
}

// ---------------------------------------------------------------- card parsing

// Parses movie/audio cards from any Newgrounds listing HTML
// (featured feed, search results, user pages).
function parseCards(html, fallbackAuthor) {
    const out = [];
    const seen = {};
    const re = /<a\s([^>]*href="https:\/\/www\.newgrounds\.com\/(portal\/view|audio\/listen)\/(\d+)"[^>]*)>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrs = m[1];
        const isAudio = m[2] === "audio/listen";
        const id = m[3];
        const body = m[4];

        const cls = match(attrs, /class="([^"]*)"/) ?? "";
        if (!/(inline-card-portalsubmission|item-portalsubmission|item-audiosubmission)/.test(cls)) continue;

        const key = (isAudio ? "a" : "v") + id;
        if (seen[key]) continue;
        seen[key] = true;

        const title = decode(match(attrs, /title="([^"]*)"/) ?? match(body, /<h4>([\s\S]*?)<\/h4>/) ?? "");
        const thumb = match(body, /<img[^>]*src="([^"]+)"/);

        let author = fallbackAuthor ?? null;
        const authorName = decode(
            match(body, /<span>\s*By\s+([^<]+?)\s*<\/span>/i) ??
            match(body, /by\s*<strong>([^<]+)<\/strong>/i));
        if (authorName) author = authorFromName(authorName);
        if (!author) author = authorFromName("Unknown");

        const viewsStr = match(body, /([\d,]+)\s+Views/i);
        const url = isAudio ? `${BASE}/audio/listen/${id}` : `${BASE}/portal/view/${id}`;

        out.push(new PlatformVideo({
            id: new PlatformID(PLATFORM, isAudio ? "audio-" + id : id, config.id),
            name: htmlToText(title),
            thumbnails: thumbs(thumb),
            author: author,
            uploadDate: 0,
            datetime: 0,
            duration: 0,
            viewCount: viewsStr ? parseInt(viewsStr.replace(/,/g, "")) : 0,
            url: url,
            shareUrl: url,
            isLive: false
        }));
    }
    return out;
}

// ---------------------------------------------------------------- helpers

function getHtml(url) {
    const resp = http.GET(url, {}, false);
    if (!resp.isOk) throw new ScriptException(`Newgrounds request failed (${resp.code}): ${url}`);
    return resp.body;
}

function getJson(url, allowFail) {
    const resp = http.GET(url, XHR, false);
    if (!resp.isOk) {
        if (allowFail) return null;
        throw new ScriptException(`Newgrounds request failed (${resp.code}): ${url}`);
    }
    try {
        return JSON.parse(resp.body);
    } catch (e) {
        if (allowFail) return null;
        throw new ScriptException("Unexpected response from Newgrounds: " + url);
    }
}

function authorFromName(name) {
    const slug = String(name).trim().toLowerCase();
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, slug, config.id), name, `https://${slug}.newgrounds.com`, "");
}

function thumbs(url) {
    if (!url) return new Thumbnails([]);
    return new Thumbnails([new Thumbnail(url, 405)]);
}

function match(str, re) {
    if (!str) return null;
    const m = str.match(re);
    return m ? m[1] : null;
}

function metaProp(html, prop) {
    return match(html, new RegExp(`<meta property="${prop.replace(/[.:]/g, "\\$&")}" content="([^"]*)"`));
}

function metaItemprop(html, prop) {
    return match(html, new RegExp(`<meta itemprop="${prop}" content="([^"]*)"`));
}

function parseCount(str) {
    if (!str) return -1;
    const m = String(str).trim().match(/^([\d.,]+)\s*([KMB])?$/i);
    if (!m) return -1;
    let n = parseFloat(m[1].replace(/,/g, ""));
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
    return Math.round(n * mult);
}

function decode(str) {
    if (str === null || str === undefined) return str;
    return String(str)
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

function htmlToText(html) {
    if (!html) return "";
    return decode(String(html)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, ""))
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

log("Newgrounds plugin loaded");
