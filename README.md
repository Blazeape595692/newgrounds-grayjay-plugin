# Newgrounds plugin for Grayjay

Files:
- `NewgroundsConfig.json`: the plugin config (this is the URL you install)
- `NewgroundsScript.js`: the source script
- `NewgroundsIcon.png`: the icon
- `NewgroundsQR.png`: QR code for installing in Grayjay

## What it does
- **Home**: Newgrounds featured movies, with infinite scroll (never shows adult-rated content)
- **Search**: movies and audio together by default; use the "Content" filter (All / Movies / Audio) to show just one. When logged in, a "Rating" filter (E / T / M / A) is added too
- **Content ratings**: plugin settings choose which age ratings (E / T / M / A) show up in search, channels, favorites and recommendations
- **Channel search**: finds Newgrounds users
- **Playback**: movies stream as MP4 (360p/720p/1080p, whatever the upload has); audio plays as MP3
- **Recommendations**: 20 random featured movies under each movie, and 20 random featured audio tracks under each audio track (new picks every time)
- **Comments**: Newgrounds reviews show as comments, with the reviewer, date and star score (newest first)
- **Channels**: `https://USERNAME.newgrounds.com`: profile, fan count, and all of the user's movies, then their audio
- **Favorites**: `USERNAME.newgrounds.com/favorites/movies` and `/favorites/audio` open as playlists
- **Supported URLs**: `newgrounds.com/portal/view/ID`, `newgrounds.com/audio/listen/ID`, `USERNAME.newgrounds.com`, `USERNAME.newgrounds.com/favorites/movies|audio`

## Install
Grayjay install link (open it on your phone with Grayjay installed):

```
grayjay://plugin/https://blazeape595692.github.io/newgrounds-grayjay-plugin/NewgroundsConfig.json
```

Or scan this QR code with your phone camera, or in Grayjay under Sources → Add:

<img src="NewgroundsQR.png" alt="QR code to install the Newgrounds plugin in Grayjay" width="250">

The plugin is hosted on GitHub Pages. Config URL:

```
https://blazeape595692.github.io/newgrounds-grayjay-plugin/NewgroundsConfig.json
```

You can also paste this config URL in Grayjay under Sources → Add.

### Hosting it yourself
Host the three files together in one folder on any static HTTPS host (GitHub Pages, a GitLab/Codeberg raw URL, etc.), then change `sourceUrl` in `NewgroundsConfig.json` to the config's real public URL.

For development, the Grayjay dev portal (enable developer mode, then open `http://PHONE_IP:11337/dev`) can load the config URL and inject it directly.

### Signing

The plugin is signed, so Grayjay can tell that updates come from the same developer. `NewgroundsConfig.json` holds the script's signature (`scriptSignature`) and the public key (`scriptPublicKey`). The private key is kept outside this repo.

After every change to `NewgroundsScript.js`, re-sign it before committing:

```bash
./sign.sh
```

It uses the key at `~/.config/newgrounds-grayjay-plugin/signing-key.pem` by default, or a path you pass. Keep that key backed up: if it's lost, updates signed with a new key make Grayjay warn that the key changed.

## Logging in
In Grayjay, open the Newgrounds source and tap **Login**, then sign in to Newgrounds. Logging in adds:
- **Adult-rated (A) content**: plays when your Newgrounds account is set to show adult content.
- **Import subscriptions**: Grayjay's import brings in the Newgrounds users you follow.
- **Playlists**: your favorite movies and favorite audio show up as two playlists.

It also adds a **Rating** filter to search. Picking ratings there overrides the plugin settings for that search.

Grayjay keeps the login cookie in the app; the plugin never sees your password.

## Content rating settings

> **Adult content and regional laws:** in countries with age-verification laws, such as the UK, Newgrounds blocks adult (A) content: videos won't play and thumbnails stay blank. If that applies to you, you'll need a VPN connected to another country, with Grayjay going through it (check it isn't excluded by split tunnelling). Make sure that's allowed where you live.
In Grayjay, open the Newgrounds source's settings to choose which age ratings to show:

| Setting | Default |
|--|--|
| Show E (Everyone) | on |
| Show T (Teen) | on |
| Show M (Mature) | on |
| Show A (Adults only) | off; only works when logged in with adult content allowed on your Newgrounds account |

**Seeing adult (A) results in search:** Newgrounds only sends A-rated results to accounts that allow them, so turning on the plugin setting isn't enough on its own. On newgrounds.com, logged in with the same account, open any search page and tick **A** next to "Ratings" (your account must have an 18+ birthday). The plugin then shows them.

**Rating tags:** movie titles start with their age rating, like **[E]**, **[T]**, **[M]** or **[A]**. Grayjay doesn't let plugins draw on thumbnails, so the title is the closest spot. Turn off "Show rating in titles" to hide them.

**Author pictures:** Newgrounds list pages don't include profile pictures, so the plugin looks them up from each author's page. Turn off "Show author pictures in lists" in the plugin settings if lists load slowly.

These apply to search, channels, favorites and recommendations. Home never shows A content, whatever the settings. Newgrounds doesn't age-rate audio, so audio always shows. Opening a link to a specific movie always works.

Posting reviews or liking from Grayjay isn't possible: Grayjay doesn't let plugins send comments or likes to a site.

## Limitations
- Reviews have no replies or likes, since Newgrounds doesn't show them publicly.
- Adult-rated (A) content only plays when logged in, and needs a VPN in countries with age-verification laws, such as the UK.
- Old Flash/Ruffle submissions with no video stream won't play.
- Newgrounds doesn't expose duration in its listings, so Grayjay fills it in once playback starts.
