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
Scan this QR code with your phone camera, or in Grayjay under Sources → Add:

<img src="NewgroundsQR.png" alt="QR code to install the Newgrounds plugin in Grayjay" width="250">

The plugin is hosted on GitHub Pages. Config URL:

```
https://blazeape595692.github.io/newgrounds-grayjay-plugin/NewgroundsConfig.json
```

In Grayjay, add a source using that URL: either open
`grayjay://plugin/https://blazeape595692.github.io/newgrounds-grayjay-plugin/NewgroundsConfig.json` on your phone, or paste the config URL in Sources → Add.

### Hosting it yourself
Host the three files together in one folder on any static HTTPS host (GitHub Pages, a GitLab/Codeberg raw URL, etc.), then change `sourceUrl` in `NewgroundsConfig.json` to the config's real public URL.

For development, the Grayjay dev portal (enable developer mode, then open `http://PHONE_IP:11337/dev`) can load the config URL and inject it directly.

The plugin is unsigned, so Grayjay will show an "unsigned plugin" warning. That's normal for self-hosted plugins.

## Logging in
In Grayjay, open the Newgrounds source and tap **Login**, then sign in to Newgrounds. Logging in adds:
- **Adult-rated (A) content**: plays when your Newgrounds account is set to show adult content.
- **Import subscriptions**: Grayjay's import brings in the Newgrounds users you follow.
- **Playlists**: your favorite movies and favorite audio show up as two playlists.

It also adds a **Rating** filter to search. Picking ratings there overrides the plugin settings for that search.

Grayjay keeps the login cookie in the app; the plugin never sees your password.

## Content rating settings
In Grayjay, open the Newgrounds source's settings to choose which age ratings to show:

| Setting | Default |
|--|--|
| Show E (Everyone) | on |
| Show T (Teen) | on |
| Show M (Mature) | on |
| Show A (Adults only) | off; only works when logged in with adult content allowed on your Newgrounds account |

These apply to search, channels, favorites and recommendations. Home never shows A content, whatever the settings. Newgrounds doesn't age-rate audio, so audio always shows. Opening a link to a specific movie always works.

Posting reviews or liking from Grayjay isn't possible: Grayjay doesn't let plugins send comments or likes to a site.

## Limitations
- Reviews have no replies or likes, since Newgrounds doesn't show them publicly.
- Adult-rated (A) content only plays when logged in.
- Old Flash/Ruffle submissions with no video stream won't play.
- Newgrounds doesn't expose duration in its listings, so Grayjay fills it in once playback starts.
