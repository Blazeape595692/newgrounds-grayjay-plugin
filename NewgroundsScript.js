// Newgrounds source plugin for Grayjay
// Supports: featured movies home feed, mixed movie + audio search, user search,
// movie playback (MP4, all qualities), audio playback (MP3), user channels (movies + audio),
// comments (Newgrounds reviews), recommendations (random featured movies / audio),
// login: adult content, followed-user import, favorites as playlists, search rating filter;
// settings: which age ratings (E/T/M/A) to show. Home never shows A.

const PLATFORM = "Newgrounds";
const BASE = "https://www.newgrounds.com";
const XHR = { "X-Requested-With": "XMLHttpRequest" };
const PAGE_SIZE = 20;

const REGEX_VIDEO_URL = /^https?:\/\/(?:www\.)?newgrounds\.com\/portal\/view\/(\d+)/i;
const REGEX_AUDIO_URL = /^https?:\/\/(?:www\.)?newgrounds\.com\/audio\/listen\/(\d+)/i;
const REGEX_CHANNEL_URL = /^https?:\/\/(?!www\.)([a-z0-9_-]+)\.newgrounds\.com\/?/i;
const REGEX_FAVORITES_URL = /^https?:\/\/(?!www\.)([a-z0-9_-]+)\.newgrounds\.com\/favorites\/(movies|audio)\/?(?:[?#].*)?$/i;

// When a page comes back empty after rating filtering, try up to this many more pages.
const MAX_EMPTY_PAGES = 5;

let config = {};
let settings = {};

// ---------------------------------------------------------------- lifecycle

source.enable = function (conf, sets, savedState) {
    config = conf ?? {};
    settings = sets ?? {};
};

source.disable = function () { };

// ---------------------------------------------------------------- content ratings

// Newgrounds rates movies and games E / T / M / A. Audio has no rating and always shows.
function isOn(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    return value === true || value === "true";
}

// Ratings to show, from the plugin settings. A needs a login.
function allowedRatings() {
    const allowed = {
        e: isOn(settings.showRatedE, true),
        t: isOn(settings.showRatedT, true),
        m: isOn(settings.showRatedM, true),
        a: isOn(settings.showRatedA, false) && loggedIn()
    };
    return allowed;
}

// Drops items whose rating isn't allowed. Items with no rating (audio) are kept.
function filterRatings(items, allowed) {
    return items.filter(v => !v._ngRating || allowed[v._ngRating]);
}

// ---------------------------------------------------------------- home

// Home never shows adult (A) content, even when logged in with A turned on.
source.getHome = function () {
    const allowed = Object.assign(allowedRatings(), { a: false });
    return new FeaturedPager(0, allowed);
};

class FeaturedPager extends VideoPager {
    constructor(offset, allowed) {
        let results = [];
        let total = 0;
        let tries = 0;
        do {
            const json = getJson(`${BASE}/movies/featured?offset=${offset}&inner=1`);
            total = json.total ?? 0;
            results = filterRatings(parseCards(json.content ?? ""), allowed);
            offset += PAGE_SIZE;
        } while (results.length === 0 && offset < total && ++tries < MAX_EMPTY_PAGES);
        super(withAvatars(results), offset < total, { offset, allowed });
    }
    nextPage() {
        return new FeaturedPager(this.context.offset, this.context.allowed);
    }
}

// ---------------------------------------------------------------- search

source.searchSuggestions = function (query) {
    return [];
};

source.getSearchCapabilities = function () {
    const filters = [
        new FilterGroup("Content", [
            new FilterCapability("All", "all", "all"),
            new FilterCapability("Movies", "movies", "movies"),
            new FilterCapability("Audio", "audio", "audio")
        ], false, "content")
    ];
    // The rating filter only shows when logged in. With nothing picked, the settings apply.
    if (loggedIn()) {
        filters.push(new FilterGroup("Rating", [
            new FilterCapability("E (Everyone)", "e", "e"),
            new FilterCapability("T (Teen)", "t", "t"),
            new FilterCapability("M (Mature)", "m", "m"),
            new FilterCapability("A (Adults only)", "a", "a")
        ], true, "rating"));
    }
    return { types: [Type.Feed.Mixed], sorts: [], filters: filters };
};

// Searches movies and audio together by default; the "Content" filter narrows it to one.
source.search = function (query, type, order, filters) {
    let kind = "all";
    if (filters && filters.content && filters.content.length > 0)
        kind = filters.content[0];
    const kinds = kind === "movies" || kind === "audio" ? [kind] : ["movies", "audio"];

    let allowed = allowedRatings();
    if (loggedIn() && filters && filters.rating && filters.rating.length > 0) {
        allowed = { e: false, t: false, m: false, a: false };
        for (const r of filters.rating) if (r in allowed) allowed[r] = true;
    }
    return new SearchPager(query, kinds, 1, allowed);
};

class SearchPager extends VideoPager {
    constructor(query, kinds, page, allowed) {
        let results = [];
        let stillMore = kinds;
        let tries = 0;
        do {
            const lists = [];
            const more = [];
            for (const kind of stillMore) {
                const resp = http.GET(`${BASE}/search/conduct/${kind}?terms=${encodeURIComponent(query)}&page=${page}`, {}, loggedIn());
                if (!resp.isOk) {
                    if (kinds.length === 1) throw new ScriptException(`Newgrounds search failed (${resp.code})`);
                    continue;
                }
                const html = resp.body;
                const items = parseCards(html);
                lists.push(filterRatings(items, allowed));
                if (items.length > 0 && (html.includes(`page=${page + 1}"`) || html.includes(`page=${page + 1}&`)))
                    more.push(kind);
            }
            // Alternate movie, audio, movie, audio... so both show near the top.
            results = [];
            for (let i = 0; lists.some(l => i < l.length); i++)
                for (const l of lists)
                    if (i < l.length) results.push(l[i]);
            stillMore = more;
            page++;
        } while (results.length === 0 && stillMore.length > 0 && ++tries < MAX_EMPTY_PAGES);
        super(withAvatars(results), stillMore.length > 0, { query, kinds: stillMore, page, allowed });
    }
    nextPage() {
        const c = this.context;
        return new SearchPager(c.query, c.kinds, c.page, c.allowed);
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
    const a = url.match(REGEX_AUDIO_URL);
    const details = v ? getMovieDetails(v[1]) : a ? getAudioDetails(a[1]) : null;
    if (!details) throw new ScriptException("Unsupported Newgrounds URL: " + url);
    // Grayjay asks the details object itself for the "Recommended" tab.
    details.getContentRecommendations = function () {
        return source.getContentRecommendations(url);
    };
    return details;
};

function getMovieDetails(id) {
    const pageUrl = `${BASE}/portal/view/${id}`;
    const html = getHtml(pageUrl);

    const resp = http.GET(`${BASE}/portal/video/${id}`, XHR, loggedIn());
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

// ---------------------------------------------------------------- recommendations

// "Recommended" under a submission: 20 random picks from the featured feed of
// the same kind (featured movies under a movie, featured audio under audio),
// taken from a few random pages of that feed.
const RECOMMEND_COUNT = 20;
const RECOMMEND_PAGES = 3;
const FEATURED_FEEDS = {
    movies: { path: "movies/featured", pageSize: 20, total: 0 },
    audio: { path: "audio/featured", pageSize: 30, total: 0 }
};

source.getContentRecommendations = function (url, initialData) {
    const v = url.match(REGEX_VIDEO_URL);
    const a = url.match(REGEX_AUDIO_URL);
    if (!v && !a) return new VideoPager([], false);
    const feed = v ? FEATURED_FEEDS.movies : FEATURED_FEEDS.audio;
    const currentId = v ? v[1] : "audio-" + a[1];

    if (!feed.total) {
        const first = getJson(`${BASE}/${feed.path}?offset=0&inner=1`, true);
        feed.total = (first && first.total) || 0;
    }
    const pageCount = Math.max(1, Math.ceil(feed.total / feed.pageSize));

    const offsets = {};
    while (Object.keys(offsets).length < Math.min(RECOMMEND_PAGES, pageCount))
        offsets[Math.floor(Math.random() * pageCount) * feed.pageSize] = true;

    let pool = [];
    for (const offset of Object.keys(offsets)) {
        const json = getJson(`${BASE}/${feed.path}?offset=${offset}&inner=1`, true);
        if (json && json.content) pool = pool.concat(filterRatings(parseCards(json.content), allowedRatings()));
    }

    const seen = { [currentId]: true };
    pool = pool.filter(p => !seen[p.id.value] && (seen[p.id.value] = true));
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return new VideoPager(withAvatars(pool.slice(0, RECOMMEND_COUNT)), false);
};

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
            const resp = http.GET(`${BASE}/reviews/portal/${c.id}/${c.type}/date/${page}`, XHR, loggedIn());
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

// ---------------------------------------------------------------- account (needs login)

// Max pages to walk when listing follows; a safety stop, not a real limit for most users.
const MAX_LIST_PAGES = 100;

// Username of the logged-in account, read from the user icon in the site header.
function currentUsername() {
    if (!loggedIn()) throw new ScriptException("Log in to Newgrounds first (plugin settings → Login).");
    const html = getHtml(`${BASE}/social`);
    const user = match(html, /id="toggle-user-menu"\s+href="https:\/\/([a-z0-9_-]+)\.newgrounds\.com"/i) ??
        match(html, /class="user-icon"[^>]*href="https:\/\/([a-z0-9_-]+)\.newgrounds\.com"/i);
    if (!user) throw new ScriptException("Couldn't find your Newgrounds username. Try logging in again.");
    return user.toLowerCase();
}

// Fetches one page of a user's favorites list (following, movies or audio) as HTML.
function getFavoritesPage(user, kind, page) {
    const json = getJson(`https://${user}.newgrounds.com/favorites/${kind}?page=${page}&isAjaxRequest=1`, true);
    return (json && json.component) || "";
}

// "Import subscriptions": the Newgrounds users this account follows.
source.getUserSubscriptions = function () {
    const user = currentUsername();
    const urls = [];
    const seen = {};
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const html = getFavoritesPage(user, "following", page);
        let added = 0;
        const re = /<h4>\s*<a href="(https:\/\/([a-z0-9_-]+)\.newgrounds\.com)"/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            const name = m[2].toLowerCase();
            if (seen[name]) continue;
            seen[name] = true;
            urls.push(`https://${name}.newgrounds.com`);
            added++;
        }
        if (added === 0) break;
    }
    return urls;
};

// The account's favorite movies and favorite audio, shown as two playlists.
source.getUserPlaylists = function () {
    const user = currentUsername();
    return [`https://${user}.newgrounds.com/favorites/movies`, `https://${user}.newgrounds.com/favorites/audio`];
};

source.isPlaylistUrl = function (url) {
    return REGEX_FAVORITES_URL.test(url);
};

// Works for any user's public favorites, not just the logged-in account.
source.getPlaylist = function (url) {
    const m = url.match(REGEX_FAVORITES_URL);
    if (!m) throw new ScriptException("Not a Newgrounds favorites URL: " + url);
    const user = m[1].toLowerCase();
    const kind = m[2].toLowerCase();
    const contents = new FavoritesPager(user, kind, 1, {});
    const first = contents.results[0];
    return new PlatformPlaylistDetails({
        id: new PlatformID(PLATFORM, `fav-${kind}-${user}`, config.id),
        name: kind === "movies" ? `${user}'s favorite movies` : `${user}'s favorite audio`,
        author: new PlatformAuthorLink(new PlatformID(PLATFORM, user, config.id), user, `https://${user}.newgrounds.com`, ""),
        url: `https://${user}.newgrounds.com/favorites/${kind}`,
        thumbnail: first && first.thumbnails && first.thumbnails.sources && first.thumbnails.sources[0]
            ? first.thumbnails.sources[0].url : null,
        videoCount: -1,
        contents: contents
    });
};

class FavoritesPager extends VideoPager {
    constructor(user, kind, page, seen) {
        const html = getFavoritesPage(user, kind, page);
        const all = (kind === "audio" ? parseFavoriteAudio(html) : parseCards(html))
            .filter(v => !seen[v.url] && (seen[v.url] = true));
        const items = filterRatings(all, allowedRatings());
        super(withAvatars(items), all.length > 0 && page < MAX_LIST_PAGES, { user, kind, page, seen });
    }
    nextPage() {
        const c = this.context;
        return new FavoritesPager(c.user, c.kind, c.page + 1, c.seen);
    }
}

// Favorite-audio cards use a different layout from the rest of the site.
function parseFavoriteAudio(html) {
    const out = [];
    const re = /class="item-audiosubmission[^"]*">\s*<a href="https:\/\/www\.newgrounds\.com\/audio\/listen\/(\d+)"[^>]*title="([^"]*)"([\s\S]*?)<\/a>\s*<a class="item-author" href="(https:\/\/[a-z0-9_-]+\.newgrounds\.com)"[\s\S]*?<strong>([^<]+)<\/strong>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const id = m[1];
        const name = decode(m[5]);
        const url = `${BASE}/audio/listen/${id}`;
        out.push(new PlatformVideo({
            id: new PlatformID(PLATFORM, "audio-" + id, config.id),
            name: htmlToText(decode(m[2])),
            thumbnails: thumbs(match(m[3], /<img[^>]*src="([^"]+)"/)),
            author: new PlatformAuthorLink(new PlatformID(PLATFORM, name.toLowerCase(), config.id), name, m[4], ""),
            uploadDate: 0,
            datetime: 0,
            duration: 0,
            viewCount: 0,
            url: url,
            shareUrl: url,
            isLive: false
        }));
    }
    return out;
}

// ---------------------------------------------------------------- channels

source.isChannelUrl = function (url) {
    return REGEX_CHANNEL_URL.test(url) && !REGEX_FAVORITES_URL.test(url);
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
    return new ChannelContentPager(user, author, "movies", 1, allowedRatings());
};

class ChannelContentPager extends VideoPager {
    constructor(user, author, kind, page, allowed) {
        let results = [];
        let ctx = { user, author, kind, page, allowed };
        let tries = 0;
        do {
            const json = getJson(`https://${user}.newgrounds.com/${ctx.kind}?page=${ctx.page}`, true);
            results = [];
            if (json && json.items) {
                const years = Object.keys(json.items).sort((a, b) => parseInt(b) - parseInt(a));
                for (const y of years)
                    for (const cardHtml of json.items[y])
                        results = results.concat(parseCards(cardHtml, author));
            }
            results = filterRatings(results, allowed);
            results.sort((a, b) => parseInt(b.id.value.replace(/\D/g, "")) - parseInt(a.id.value.replace(/\D/g, "")));

            const moreInKind = !!(json && json.load_more && String(json.load_more).trim());
            if (moreInKind) ctx = { user, author, kind: ctx.kind, page: ctx.page + 1, allowed };
            else if (ctx.kind === "movies") ctx = { user, author, kind: "audio", page: 1, allowed };
            else ctx = null;
        } while (results.length === 0 && ctx !== null && ++tries < MAX_EMPTY_PAGES);

        super(withAvatars(results), ctx !== null, ctx ?? {});
    }
    nextPage() {
        const c = this.context;
        return new ChannelContentPager(c.user, c.author, c.kind, c.page, c.allowed);
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

        const video = new PlatformVideo({
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
        });
        // Age rating (e/t/m/a) for filtering; movie cards show it, audio cards don't.
        const rating = isAudio ? null : match(body, /rated-([etma])\b/);
        if (rating) video._ngRating = rating;
        out.push(video);
    }
    return out;
}

// ---------------------------------------------------------------- helpers

// True once the user has logged in to Newgrounds through Grayjay. Requests then
// carry the login, which unlocks adult-rated (A) submissions.
function loggedIn() {
    try { return typeof bridge !== "undefined" && !!bridge.isLoggedIn(); }
    catch (e) { return false; }
}

function getHtml(url) {
    const resp = http.GET(url, {}, loggedIn());
    if (!resp.isOk) throw new ScriptException(`Newgrounds request failed (${resp.code}): ${url}`);
    return resp.body;
}

function getJson(url, allowFail) {
    const resp = http.GET(url, XHR, loggedIn());
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

// List pages don't include author pictures, so look them up from each author's
// profile page (og:image), all at once, and remember them for the session.
const avatarCache = {};

function withAvatars(videos) {
    if (!isOn(settings.showAvatars, true)) return videos;
    const need = [];
    for (const v of videos) {
        const slug = v.author && !v.author.thumbnail && v.author.id ? v.author.id.value : null;
        if (slug && slug !== "unknown" && !(slug in avatarCache) && need.indexOf(slug) < 0) need.push(slug);
    }
    if (need.length > 0) {
        let responses = null;
        try {
            let batch = http.batch();
            for (const slug of need) batch = batch.GET(`https://${slug}.newgrounds.com/`, {}, loggedIn());
            responses = batch.execute();
        } catch (e) { responses = null; }
        need.forEach((slug, i) => {
            const r = responses ? responses[i] : null;
            // Only remember successful lookups, so a failed one is retried next time.
            if (r && r.isOk) avatarCache[slug] = decode(metaProp(r.body, "og:image")) || "";
        });
    }
    for (const v of videos) {
        const pic = v.author && v.author.id ? avatarCache[v.author.id.value] : "";
        if (pic && !v.author.thumbnail) v.author.thumbnail = pic;
    }
    return videos;
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
