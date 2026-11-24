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
const REGEX_CHANNEL_URL = /^https?:\/\/(?!www\.)([a-z0-9_-]+)\.newgrounds\.com(?:[\/?#]|$)/i;
const REGEX_FAVORITES_URL = /^https?:\/\/(?!www\.)([a-z0-9_-]+)\.newgrounds\.com\/favorites\/(movies|audio)\/?(?:[?#].*)?$/i;

// When a page comes back empty after rating filtering, try up to this many more pages.
const MAX_EMPTY_PAGES = 5;

let config = {};
let settings = {};

// ---------------------------------------------------------------- lifecycle

source.enable = function (conf, sets, savedState) {
    config = conf ?? {};
    settings = sets ?? {};
    // Remembered between app restarts, so pictures and feed sizes aren't re-fetched.
    try {
        const state = savedState ? JSON.parse(savedState) : null;
        avatarCache = Object.create(null);
        if (state && state.avatars && typeof state.avatars === "object")
            for (const k of Object.keys(state.avatars))
                if (safeSlug(k) === k) avatarCache[k] = safeImageUrl(state.avatars[k]);
        if (state && state.totals)
            for (const k of ["movies", "audio"]) {
                const t = Number(state.totals[k]);
                if (Number.isFinite(t) && t >= 0) FEATURED_FEEDS[k].total = Math.floor(t);
            }
        featuredFromSaved(state && state.featured);
    } catch (e) { }
};

source.saveState = function () {
    // Keep the newest 3000 pictures so the saved state stays small.
    const keys = Object.keys(avatarCache);
    const avatars = {};
    for (const k of keys.slice(Math.max(0, keys.length - 3000))) avatars[k] = avatarCache[k];
    return JSON.stringify({
        avatars,
        totals: { movies: FEATURED_FEEDS.movies.total, audio: FEATURED_FEEDS.audio.total },
        featured: featuredForSaving()
    });
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

// Drops items whose rating isn't allowed. Audio has no rating and is kept. A
// movie whose rating couldn't be read is treated as adult (A), so a missing
// rating can never slip adult content past the filter or onto Home.
function filterRatings(items, allowed) {
    return items.filter(v => {
        if (v._ngRating) return !!allowed[v._ngRating];
        const isMovie = typeof v.url === "string" && v.url.includes("/portal/view/");
        return isMovie ? !!allowed.a : true;
    });
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
            // Newgrounds serves nothing past offset 10000, so stop there.
            total = Math.min(json.total ?? 0, 10000);
            if (json.total) FEATURED_FEEDS.movies.total = json.total;
            const items = parseCards(json.content ?? "");
            rememberFeatured("movies", offset, items); // reused by Recommended
            results = filterRatings(items, allowed);
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
        for (const r of filters.rating) if (hasOwn(allowed, r)) allowed[r] = true;
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
                const resp = ngGet(`${BASE}/search/conduct/${kind}?terms=${encodeURIComponent(query)}&page=${page}`, {});
                if (!resp.isOk) {
                    if (isGuard(resp)) throw new ScriptException(GUARD_MESSAGE);
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
                thumbnail: safeImageUrl(decode(match(block, /<image href="([^"]+)"/))),
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
    const user = details.author && details.author.url && REGEX_CHANNEL_URL.test(details.author.url)
        ? channelName(details.author.url) : null;
    const info = Object.assign(emptyInfo(), details._ngInfo || {},
        { user, name: details.author ? details.author.name : null });
    delete details._ngInfo;
    details.getContentRecommendations = function () {
        return source.getContentRecommendations(url, info);
    };
    return details;
};

function getMovieDetails(id) {
    const pageUrl = `${BASE}/portal/view/${id}`;
    // Adult (A) pages can answer 403 "Login required" (or be region-blocked) even
    // when the video itself is available, so fall back to the video info alone.
    const pageResp = ngGet(pageUrl, {});
    if (isGuard(pageResp)) throw new ScriptException(GUARD_MESSAGE);
    const html = pageResp.isOk ? pageResp.body : "";
    const pageBlocked = !pageResp.isOk;

    const resp = ngGet(`${BASE}/portal/video/${id}`, XHR);
    let json = null;
    try { json = JSON.parse(resp.body); } catch (e) { }
    if (!resp.isOk || !json || !json.sources) {
        const err = json && Array.isArray(json.errors) ? json.errors.map(String).join(" ").slice(0, 200) : `HTTP ${resp.code}`;
        if (pageBlocked)
            throw new ScriptException(`Newgrounds blocked this movie (${pageResp.code}). Adult-rated movies need you logged in. In countries with age-verification laws, such as the UK, you'll also need a VPN set to another country.`);
        throw new ScriptException("Could not load this movie (it may be a Flash/Ruffle submission): " + err);
    }

    const sources = [];
    for (const quality of Object.keys(json.sources)) {
        const height = parseInt(quality) || 0;
        if (!Array.isArray(json.sources[quality])) continue;
        for (const s of json.sources[quality]) {
            if (!s || !safeMediaUrl(s.src)) continue;
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
    if (sources.length === 0) throw new ScriptException("Could not load this movie: Newgrounds gave no usable video file.");

    const meta = parsePageMeta(html);
    // A blocked page only happens for adult-rated movies.
    const rating = match(html, /<h2 class="rated-([etma])"/) || (pageBlocked ? "a" : null);
    const details = new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, id, config.id),
        name: tagTitle(decode(json.title) || meta.title, rating),
        thumbnails: thumbs(meta.thumbnail),
        author: meta.author ?? withAvatars([{ author: authorFromName(json.author) }])[0].author,
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
    details._ngInfo = parseRelated(html, "movies");
    return details;
}

function getAudioDetails(id) {
    const pageUrl = `${BASE}/audio/listen/${id}`;
    const html = getHtml(pageUrl);
    const mp3 = safeMediaUrl(decode(metaProp(html, "og:audio")));
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

    const details = new PlatformVideoDetails({
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
    details._ngInfo = parseRelated(html, "audio");
    return details;
}

function parsePageMeta(html) {
    const title = decode(metaProp(html, "og:title")) || "";
    const thumbnail = safeImageUrl(decode(metaItemprop(html, "thumbnailUrl") || metaProp(html, "og:image")));
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
        const icon = safeImageUrl(decode(match(userBlock, /<image href="([^"]+)"/)));
        if (url && name)
            author = new PlatformAuthorLink(new PlatformID(PLATFORM, name.toLowerCase(), config.id), name, url, icon);
    }

    let rating = null;
    const ratingValue = parseFloat(metaItemprop(html, "ratingValue"));
    if (!isNaN(ratingValue)) rating = new RatingScaler(ratingValue / 10);

    return { title, thumbnail, date, views, description, author, rating };
}

// ---------------------------------------------------------------- recommendations

// "Recommended" under a submission: 15 picks, mixed together, from things
// related to what you're watching:
//   - up to 4 from the same series (sequels / episodes), if it's in one
//   - 4 from the same creator
//   - 4 popular ones from the same genre
//   - 3 from the same collection, or else from other creators sharing its tags
//   - featured picks fill whatever the others came up short
// Movies under a movie, audio under audio. Every list is cached (see below),
// so after some browsing most videos need few or no new requests.
const RECOMMEND_COUNT = 15;
const RECOMMEND_SERIES = 4;
const RECOMMEND_CREATOR = 4;
const RECOMMEND_GENRE = 4;
const RECOMMEND_THEME = 3;            // collection, or tags
const RECOMMEND_CHANNEL_PAGES = 1;    // channel pages to pick from
const RECOMMEND_TAGS = 2;             // tags to search
const RECOMMEND_VISUAL_LINKS = 20;    // series/collection items to look up
const FEATURED_POOL_TARGET = 120;     // featured items to keep for picking from
const FEATURED_MAX_OFFSET = 9900;     // Newgrounds serves nothing past offset 10000
const FEATURED_FEEDS = {
    movies: { path: "movies/featured", pageSize: 20, total: 0 },
    audio: { path: "audio/featured", pageSize: 30, total: 0 }
};

source.getContentRecommendations = function (url, initialData) {
    const v = url.match(REGEX_VIDEO_URL);
    const a = url.match(REGEX_AUDIO_URL);
    if (!v && !a) return new VideoPager([], false);
    const kind = v ? "movies" : "audio";
    const currentId = v ? v[1] : "audio-" + a[1];
    const allowed = allowedRatings();
    const seen = Object.create(null);
    seen[currentId] = true;
    const take = (list, n, keep) => {
        const out = [];
        for (const p of shuffle(list.slice())) {
            if (out.length >= n) break;
            if (seen[p.id.value] || (keep && !keep(p))) continue;
            seen[p.id.value] = true;
            out.push(p);
        }
        return out;
    };
    const safely = f => { try { return f(); } catch (e) { return []; } };

    let info = initialData && initialData.user !== undefined ? initialData : null;
    if (!info) {
        try { info = submissionInfo(v ? v[1] : null, a ? a[1] : null); }
        catch (e) { info = emptyInfo(); }
    }
    const notCreator = p => !info.user || p.author.id.value !== info.user;

    // While Newgrounds' bot check is active, only lists already cached are used.
    const fromSeries = info.series ? safely(() => take(visualLinkPool(`${BASE}/series/${info.series}`, kind, allowed), RECOMMEND_SERIES)) : [];
    const fromCreator = info.user ? safely(() => take(channelPool(info.user, info.name || info.user, kind, allowed), RECOMMEND_CREATOR)) : [];
    const fromGenre = info.genreUrl ? safely(() => take(genrePool(info.genreUrl, allowed), RECOMMEND_GENRE, notCreator)) : [];
    let fromTheme = info.collection ? safely(() => take(visualLinkPool(`${BASE}/collection/${info.collection}`, kind, allowed), RECOMMEND_THEME, notCreator)) : [];
    if (fromTheme.length < RECOMMEND_THEME && info.tags && info.tags.length > 0)
        fromTheme = fromTheme.concat(safely(() => take(tagPool(info.tags, kind, allowed), RECOMMEND_THEME - fromTheme.length, notCreator)));

    let picks = fromSeries.concat(fromCreator, fromGenre, fromTheme);
    picks = picks.concat(safely(() => take(featuredPool(kind, allowed), RECOMMEND_COUNT - picks.length)));
    return new VideoPager(withAvatars(shuffle(picks)), false);
};

// ---- what a submission page says about itself (no extra requests)

function emptyInfo() {
    return { user: null, name: null, tags: [], series: null, collection: null, genreUrl: null };
}

// Series, collection, genre and tags linked from a submission page.
function parseRelated(html, kind) {
    const series = match(html, /href="https:\/\/www\.newgrounds\.com\/series\/([a-z0-9_-]+)"/i);
    const collection = match(html, /href="https:\/\/www\.newgrounds\.com\/collection\/([a-z0-9_-]+)"/i);
    let genreUrl = null;
    if (kind === "movies") {
        const g = match(html, /\/movies\/browse\?interval=all&(?:amp;)?genre=(\d+)"/);
        if (g) genreUrl = `${BASE}/movies/browse?interval=all&genre=${g}`;
    } else {
        const m = (html || "").match(/\/audio\/browse\?interval=all&(?:amp;)?genre=(\d+)(?:&(?:amp;)?type=(\d+))?"/);
        if (m) genreUrl = `${BASE}/audio/browse?interval=all&genre=${m[1]}` + (m[2] ? `&type=${m[2]}` : "");
    }
    return {
        tags: parseTags(html),
        series: series ? series.toLowerCase() : null,
        collection: collection ? collection.toLowerCase() : null,
        genreUrl
    };
}

// Tags listed on a submission page.
function parseTags(html) {
    const tags = [];
    const re = /\/search\/conduct\/(?:movies|audio)\?match=tags&(?:amp;)?tags=([^"&]+)/g;
    let m;
    while ((m = re.exec(html || "")) !== null) {
        let tag;
        try { tag = decodeURIComponent(decode(m[1])); } catch (e) { continue; } // skip a badly encoded tag
        if (tag && tags.indexOf(tag) < 0) tags.push(tag);
    }
    return tags;
}

// Creator and related links of a submission, when the details object didn't pass them.
function submissionInfo(movieId, audioId) {
    const kind = movieId ? "movies" : "audio";
    const pageUrl = movieId ? `${BASE}/portal/view/${movieId}` : `${BASE}/audio/listen/${audioId}`;
    const resp = ngGet(pageUrl, {});
    if (resp.isOk) {
        const author = parsePageMeta(resp.body).author;
        return Object.assign(parseRelated(resp.body, kind), {
            user: author ? channelName(author.url) : null,
            name: author ? author.name : null
        });
    }
    // Blocked adult page: the video info still names the creator.
    if (movieId) {
        const json = getJson(`${BASE}/portal/video/${movieId}`, true);
        const user = json && safeSlug(json.author);
        if (user) return Object.assign(emptyInfo(), { user, name: String(json.author) });
    }
    return emptyInfo();
}

// ---- cached lists

// How often cached lists (featured, genres, series, collections) are refreshed:
// the "Refresh recommendation lists" setting. Creator and tag lists: 30 minutes.
const REFRESH_HOURS = [6, 24, 72, 168];
const REFRESH_LABELS = ["Every 6 hours", "Every day", "Every 3 days", "Every week"];
const SHORT_CACHE_MS = 30 * 60 * 1000;

function refreshMs() {
    const raw = settings.featuredRefresh;
    let i = parseInt(raw);
    if (isNaN(i)) i = REFRESH_LABELS.indexOf(String(raw));
    if (i < 0 || i >= REFRESH_HOURS.length) i = 1; // every day
    return REFRESH_HOURS[i] * 60 * 60 * 1000;
}

const listCache = Object.create(null);
const LIST_CACHE_MAX = 300;

// Returns a remembered list if it's fresh enough, else fetches it. Failed
// fetches aren't remembered. While Newgrounds' bot check is active, nothing new
// is fetched.
function cachedList(key, maxAgeMs, fetchItems) {
    const hit = listCache[key];
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.items;
    if (backingOff()) return hit ? hit.items : [];
    const items = fetchItems();
    if (items) {
        listCache[key] = { at: Date.now(), items };
        // Keep memory bounded: drop the oldest lists past LIST_CACHE_MAX.
        const keys = Object.keys(listCache);
        if (keys.length > LIST_CACHE_MAX) {
            keys.sort((x, y) => listCache[x].at - listCache[y].at);
            for (const k of keys.slice(0, keys.length - LIST_CACHE_MAX)) delete listCache[k];
        }
    }
    return items || (hit ? hit.items : []);
}

// The newest page of a user's movies or audio, rating-filtered.
function channelPool(user, name, kind, allowed) {
    user = safeSlug(user);
    if (!user) return [];
    const author = new PlatformAuthorLink(
        new PlatformID(PLATFORM, user, config.id), name, `https://${user}.newgrounds.com`, "");
    const pool = cachedList(`channel:${user}:${kind}`, SHORT_CACHE_MS, () => {
        let items = [];
        for (let page = 1; page <= RECOMMEND_CHANNEL_PAGES; page++) {
            const json = getJson(`https://${user}.newgrounds.com/${kind}?page=${page}`, true);
            if (!json) return page === 1 ? null : items;
            if (!json.items) break;
            for (const y of Object.keys(json.items))
                for (const cardHtml of json.items[y])
                    items = items.concat(datedCards(cardHtml, author, parseInt(y)));
            if (!(json.load_more && String(json.load_more).trim())) break;
        }
        return items;
    });
    return filterRatings(pool, allowed);
}

// Tag search results for a few of the submission's tags, rating-filtered.
function tagPool(tags, kind, allowed) {
    let pool = [];
    for (const tag of shuffle(tags.slice()).slice(0, RECOMMEND_TAGS)) {
        pool = pool.concat(cachedList(`tag:${kind}:${tag}`, SHORT_CACHE_MS, () => {
            const resp = ngGet(`${BASE}/search/conduct/${kind}?match=tags&tags=${encodeURIComponent(tag)}`, {});
            return resp.isOk ? parseCards(resp.body) : null;
        }));
    }
    return filterRatings(pool, allowed);
}

// A genre's browse page (popular movies or audio in that genre), rating-filtered.
function genrePool(genreUrl, allowed) {
    const pool = cachedList(`genre:${genreUrl}`, refreshMs(), () => {
        const resp = ngGet(genreUrl, {});
        return resp.isOk ? parseCards(resp.body) : null;
    });
    return filterRatings(pool, allowed);
}

// Items of a series or collection page. Those pages only list IDs
// (data-visual-link="[type,id]"); visual-links-fetch turns them into cards.
// Games are left out, since they can't play.
function visualLinkPool(pageUrl, kind, allowed) {
    const pool = cachedList(`visual:${pageUrl}:${kind}`, refreshMs(), () => {
        const page = ngGet(pageUrl, {});
        if (!page.isOk) return null;
        const ids = [];
        const re = /data-visual-link="\[(\d+),(\d+)\]"/g;
        let m;
        while ((m = re.exec(page.body)) !== null) ids.push([parseInt(m[1]), parseInt(m[2])]);
        if (ids.length === 0) return [];
        const wanted = shuffle(ids).slice(0, RECOMMEND_VISUAL_LINKS);
        const resp = ngPost(`${BASE}/visual-links-fetch`,
            "ids=" + encodeURIComponent(JSON.stringify(wanted)) + "&include_all_suitabilities=0",
            Object.assign({ "Content-Type": "application/x-www-form-urlencoded" }, XHR));
        if (!resp.isOk) return null;
        let json;
        try { json = JSON.parse(resp.body); } catch (e) { return null; }
        if (!json || !json.partials) return [];
        let html = "";
        for (const type of Object.keys(json.partials)) {
            for (const id of Object.keys(json.partials[type])) {
                const simple = json.simples && json.simples[type] && json.simples[type][id];
                if (simple && simple.label === "game") continue;
                html += json.partials[type][id];
            }
        }
        return parseCards(html).filter(p => kind === "audio" ? p.url.includes("/audio/listen/") : p.url.includes("/portal/view/"));
    });
    return filterRatings(pool, allowed);
}

// ---- featured pool, kept between app restarts

// Featured pages seen so far (from Home or earlier recommendations). They're
// saved with the plugin's state and thrown away after the refresh interval.
// A new random page is only fetched while the pool holds fewer than
// FEATURED_POOL_TARGET items.
let featuredCache = { movies: Object.create(null), audio: Object.create(null) };
let featuredSince = 0;

function expireFeatured() {
    if (featuredSince && Date.now() - featuredSince < refreshMs()) return;
    featuredCache = { movies: Object.create(null), audio: Object.create(null) };
    featuredSince = Date.now();
}

function rememberFeatured(kind, offset, items) {
    expireFeatured();
    if (featuredCache[kind] && items.length > 0) featuredCache[kind][offset] = items;
}

function cachedFeatured(kind) {
    let all = [];
    for (const offset of Object.keys(featuredCache[kind])) all = all.concat(featuredCache[kind][offset]);
    return all;
}

function featuredPool(kind, allowed) {
    expireFeatured();
    const feed = FEATURED_FEEDS[kind];
    if (!backingOff()) {
        if (!feed.total && Object.keys(featuredCache[kind]).length === 0) fetchFeaturedPage(kind, 0);
        if (cachedFeatured(kind).length < FEATURED_POOL_TARGET && feed.total) {
            const reachable = Math.min(feed.total, FEATURED_MAX_OFFSET);
            const pageCount = Math.max(1, Math.ceil(reachable / feed.pageSize));
            const offset = Math.floor(Math.random() * pageCount) * feed.pageSize;
            if (!featuredCache[kind][offset]) fetchFeaturedPage(kind, offset);
        }
    }
    return filterRatings(cachedFeatured(kind), allowed);
}

function fetchFeaturedPage(kind, offset) {
    const feed = FEATURED_FEEDS[kind];
    const json = getJson(`${BASE}/${feed.path}?offset=${offset}&inner=1`, true);
    if (!json) return;
    if (json.total) feed.total = json.total;
    rememberFeatured(kind, offset, parseCards(json.content || ""));
}

// Compact copies for saving: only what's needed to rebuild the card.
function featuredForSaving() {
    const out = { since: featuredSince, movies: {}, audio: {} };
    for (const kind of ["movies", "audio"])
        for (const offset of Object.keys(featuredCache[kind]))
            out[kind][offset] = featuredCache[kind][offset].map(v => v._ngCard).filter(Boolean);
    return out;
}

function featuredFromSaved(saved) {
    featuredCache = { movies: Object.create(null), audio: Object.create(null) };
    featuredSince = 0;
    if (!saved || typeof saved !== "object") return;
    const since = Number(saved.since);
    if (!Number.isFinite(since) || since <= 0) return;
    featuredSince = since;
    for (const kind of ["movies", "audio"]) {
        const pages = saved[kind];
        if (!pages || typeof pages !== "object") continue;
        for (const offset of Object.keys(pages)) {
            if (!/^\d{1,5}$/.test(offset) || !Array.isArray(pages[offset])) continue;
            const items = pages[offset].map(card => cardToVideo(card)).filter(Boolean);
            if (items.length > 0) featuredCache[kind][offset] = items;
        }
    }
}

function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
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
    const resp = ngGet(pageUrl, {});
    if (!resp.isOk) return new CommentPager([], false, {}); // e.g. a blocked adult page
    const html = resp.body;

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
            const resp = ngGet(`${BASE}/reviews/portal/${c.id}/${c.type}/date/${page}`, XHR);
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
        const avatar = safeImageUrl(decode(match(block, /<image href="([^"]+)"/)));
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
    const seen = Object.create(null);
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
    const contents = new FavoritesPager(user, kind, 1, Object.create(null));
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
            thumbnails: thumbs(safeImageUrl(decode(match(m[3], /<img[^>]*src="([^"]+)"/)))),
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
    const avatar = safeImageUrl(decode(metaProp(html, "og:image")));
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
                        results = results.concat(datedCards(cardHtml, author, parseInt(y)));
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

// Channel cards only say which year a video is from. The "?f<number>" on the
// thumbnail link is when the thumbnail was uploaded, which for most videos is the
// upload time, so use it when it falls in that year, else January 1 of the year.
// Grayjay's subscription feed needs these dates to show channel videos.
function datedCards(cardHtml, author, year) {
    const items = parseCards(cardHtml, author);
    const f = parseInt(match(cardHtml, /\.ngfiles\.com\/[^"]*\?f(\d{9,11})/));
    let date = year ? Math.floor(Date.UTC(year, 0, 1) / 1000) : 0;
    if (f && (!year || new Date(f * 1000).getUTCFullYear() === year)) date = f;
    for (const v of items) {
        v.uploadDate = date;
        v.datetime = date;
    }
    return items;
}

function channelName(url) {
    const m = url.match(REGEX_CHANNEL_URL);
    if (!m) throw new ScriptException("Not a Newgrounds user URL: " + url);
    return m[1].toLowerCase();
}

// ---------------------------------------------------------------- card parsing

// Parses movie/audio cards from any Newgrounds listing HTML
// (featured feed, search results, user pages).
// A card is the small set of fields a list item needs. Cards are what gets
// saved for the featured pool, so they're checked again when rebuilt.
function cardToVideo(card, author) {
    if (!card || typeof card !== "object" || !/^\d{1,9}$/.test(String(card.id))) return null;
    const isAudio = !!card.audio;
    const rating = /^[etma]$/.test(card.rating || "") ? card.rating : null;
    const title = String(card.title ?? "").slice(0, 300);
    const url = isAudio ? `${BASE}/audio/listen/${card.id}` : `${BASE}/portal/view/${card.id}`;
    const views = Number.isFinite(card.views) ? card.views : 0;
    const video = new PlatformVideo({
        id: new PlatformID(PLATFORM, isAudio ? "audio-" + card.id : String(card.id), config.id),
        name: tagTitle(title, rating),
        thumbnails: thumbs(safeImageUrl(card.thumb)),
        author: author ?? authorFromName(String(card.author ?? "Unknown").slice(0, 100)),
        uploadDate: 0,
        datetime: 0,
        duration: 0,
        viewCount: views,
        url: url,
        shareUrl: url,
        isLive: false
    });
    if (rating) video._ngRating = rating;
    video._ngCard = { id: String(card.id), audio: isAudio, title, thumb: safeImageUrl(card.thumb), author: video.author.name, views, rating };
    return video;
}

function parseCards(html, fallbackAuthor) {
    const out = [];
    const seen = Object.create(null);
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
        // Age rating (e/t/m/a); movie cards show it, audio cards don't.
        const rating = isAudio ? null : match(body, /rated-([etma])\b/);

        const card = {
            id, audio: isAudio, title: htmlToText(title), thumb: thumb || "",
            author: author.name, views: viewsStr ? parseInt(viewsStr.replace(/,/g, "")) : 0, rating
        };
        const video = cardToVideo(card, author);
        if (video) out.push(video);
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

// GET with the Newgrounds login when logged in. If Newgrounds refuses the
// logged-in request (403, e.g. adult content turned on from a country with
// age-verification laws), try once more without the login, so lists still load.
const GUARD_BACKOFF_MS = 5 * 60 * 1000;
const GUARD_MESSAGE = "Newgrounds' bot check (NG Guard) is blocking requests from your connection. " +
    "It usually clears after a few minutes. Logged-in members skip it, so logging in " +
    "(plugin settings → Login) also helps. Opening newgrounds.com in a browser on the same connection can clear it too.";
let guardUntil = 0;

// Newgrounds' bot check answers 403 with its own "NG Guard" page.
function isGuard(resp) {
    return resp && resp.code === 403 && /NG Guard|\/_guard\//.test(resp.body || "");
}
function noteGuard() {
    guardUntil = Date.now() + GUARD_BACKOFF_MS;
}
// True for a few minutes after hitting the bot check: optional requests are skipped.
function backingOff() {
    return Date.now() < guardUntil;
}

function ngGet(url, headers) {
    const useAuth = loggedIn();
    const resp = http.GET(url, headers || {}, useAuth);
    if (isGuard(resp)) {
        noteGuard();
        return resp;
    }
    if (resp.code === 403 && useAuth) {
        const retry = http.GET(url, headers || {}, false);
        if (retry.isOk) {
            log("Newgrounds refused the logged-in request, used a logged-out one: " + url);
            return retry;
        }
    }
    return resp;
}

function ngPost(url, body, headers) {
    const resp = http.POST(url, body, headers || {}, false);
    if (isGuard(resp)) noteGuard();
    return resp;
}

function getHtml(url) {
    const resp = ngGet(url, {});
    if (isGuard(resp)) throw new ScriptException(GUARD_MESSAGE);
    if (!resp.isOk) throw new ScriptException(`Newgrounds request failed (${resp.code}): ${url}`);
    return resp.body;
}

function getJson(url, allowFail) {
    const resp = ngGet(url, XHR);
    if (!resp.isOk) {
        if (allowFail) return null;
        if (isGuard(resp)) throw new ScriptException(GUARD_MESSAGE);
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
let avatarCache = Object.create(null);

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}
const AVATAR_LOOKUPS = 6; // new pictures looked up per list; the rest fill in as you browse

function withAvatars(videos) {
    if (!isOn(settings.showAvatars, true)) return videos;
    let need = [];
    for (const v of videos) {
        const slug = v.author && !v.author.thumbnail && v.author.id ? v.author.id.value : null;
        if (slug && safeSlug(slug) === slug && slug !== "unknown" && !hasOwn(avatarCache, slug) && need.indexOf(slug) < 0) need.push(slug);
    }
    need = backingOff() ? [] : need.slice(0, AVATAR_LOOKUPS);
    if (need.length > 0) {
        let responses = null;
        try {
            let batch = http.batch();
            for (const slug of need) batch = batch.GET(`https://${slug}.newgrounds.com/`, {}, false);
            responses = batch.execute();
        } catch (e) { responses = null; }
        need.forEach((slug, i) => {
            const r = responses ? responses[i] : null;
            if (r && isGuard(r)) noteGuard();
            // Only remember successful lookups, so a failed one is retried next time.
            if (r && r.isOk) avatarCache[slug] = safeImageUrl(decode(metaProp(r.body, "og:image")));
        });
    }
    for (const v of videos) {
        const pic = v.author && v.author.id && hasOwn(avatarCache, v.author.id.value) ? avatarCache[v.author.id.value] : "";
        if (pic && !v.author.thumbnail) v.author.thumbnail = pic;
    }
    return videos;
}

// "[A] Title": puts the age rating in front of movie titles (setting "showRatingTags").
function tagTitle(name, rating) {
    if (!rating || !isOn(settings.showRatingTags, true)) return name;
    return `[${rating.toUpperCase()}] ${name}`;
}

// Newgrounds usernames are letters, digits, "_" and "-". Anything else (text from
// a page that isn't a real username) must never be turned into a web address.
const SLUG_RE = /^[a-z0-9_-]{1,64}$/;
function safeSlug(name) {
    const slug = String(name ?? "").trim().toLowerCase();
    return SLUG_RE.test(slug) ? slug : null;
}

function authorFromName(name) {
    const slug = safeSlug(name);
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, slug ?? String(name ?? "").trim().toLowerCase(), config.id),
        name, slug ? `https://${slug}.newgrounds.com` : "", "");
}

// Only https video/audio files on Newgrounds' own file servers are played.
function safeMediaUrl(url) {
    return typeof url === "string" && /^https:\/\/(?:[a-z0-9-]+\.)*(?:ungrounded\.net|ngfiles\.com|newgrounds\.com)\//i.test(url) ? url : "";
}

// Only https picture links are kept (from Newgrounds pages or the saved state).
function safeImageUrl(url) {
    return typeof url === "string" && /^https:\/\/[a-z0-9.-]+\.(?:ngfiles|newgrounds)\.com\//i.test(url) ? url : "";
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
