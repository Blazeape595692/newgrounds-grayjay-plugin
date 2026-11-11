# Newgrounds plugin for Grayjay

Files:
- `NewgroundsConfig.json`: the plugin config (this is the URL you install)
- `NewgroundsScript.js`: the source script
- `NewgroundsIcon.png`: the icon
- `NewgroundsQR.png`: QR code for installing in Grayjay

## What it does
- **Home**: Newgrounds featured movies, with infinite scroll
- **Search**: movies by default; use the "Content" filter to switch to audio
- **Channel search**: finds Newgrounds users
- **Playback**: movies stream as MP4 (360p/720p/1080p, whatever the upload has); audio plays as MP3
- **Comments**: Newgrounds reviews show as comments, with the reviewer, date and star score (newest first)
- **Channels**: `https://USERNAME.newgrounds.com`: profile, fan count, and all of the user's movies, then their audio
- **Supported URLs**: `newgrounds.com/portal/view/ID`, `newgrounds.com/audio/listen/ID`, `USERNAME.newgrounds.com`

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

## Limitations
- Reviews have no replies or likes, since Newgrounds doesn't show them publicly.
- Adult-rated (A) content needs a logged-in session, so it will fail to play.
- Old Flash/Ruffle submissions with no video stream won't play.
- Newgrounds doesn't expose duration in its listings, so Grayjay fills it in once playback starts.
