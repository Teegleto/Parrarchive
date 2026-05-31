# Parrarchive

A password-gated personal collection tracker for **vinyl records** and **books**,
hosted entirely on GitHub Pages. No backend, no build step — just static
HTML/CSS/JavaScript.

## How it works

1. **Password screen** — an unskippable gate appears on load. The password is
   `parrington`. Once entered correctly the rest of the app is revealed (the
   unlock is remembered for the browser tab via `sessionStorage`).
2. **Pick a mode** — choose **🎵 Vinyl** or **📚 Books**.
3. **Add items** — type a title and press *Add*. Parrarchive looks the item up
   automatically and adds a card showing its details:
   - **Vinyl** → cover art, artist, year, type and genre
     (via the free, no-key [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API),
     with cover images from the [Cover Art Archive](https://coverartarchive.org/)).
     MusicBrainz is used instead of a store catalogue because it covers
     decades of releases, including older and out-of-print records.
   - **Books** → cover, author, first published year, page count, publisher,
     subjects (via the free [Open Library Search API](https://openlibrary.org/dev/docs/api/search)).
4. Your collection is saved in the browser's `localStorage`, so it survives
   refreshes. Hover a card and click **✕** to remove an item.

## Running locally

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server
# then visit http://localhost:8000
```

The lookups require internet access to reach the MusicBrainz and Open Library APIs.

## Deploying on GitHub Pages

All files live at the repository root, so no build is needed.

1. Push this code to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Select the branch (e.g. `main`, or `claude/github-collection-tracker-yuwdn`)
   and the `/ (root)` folder, then **Save**.
5. After a minute your site is live at
   `https://<username>.github.io/<repo>/`.

The included empty `.nojekyll` file tells Pages to serve the files as-is.

## Notes & limitations

- **Security:** the password check runs in the browser, so it is a casual gate,
  not real authentication. Don't use it to protect anything sensitive.
- **Storage:** collections are stored per-browser in `localStorage`. They are
  not shared across devices. Cross-device sync (export/import a JSON file, or
  committing data back to the repo) is intentionally left for a future update;
  the storage logic is isolated in small `load`/`save` helpers in `app.js` to
  make that easy to add.
