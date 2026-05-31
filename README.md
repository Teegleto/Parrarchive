# Parrarchive

A password-gated personal collection tracker for **vinyl records** and **books**,
hosted entirely on GitHub Pages. No backend, no build step — just static
HTML/CSS/JavaScript.

## How it works

1. **Password screen** — an unskippable gate appears on load. The password is
   `parrington`. Once entered correctly the rest of the app is revealed (the
   unlock is remembered for the browser tab via `sessionStorage`).
2. **Pick a mode** — choose **🎵 Vinyl** or **📚 Books**.
3. **Add items** — pick what to **search by**, type, and press *Add* (or pick a
   suggestion). Parrarchive looks the item up automatically and adds a card with
   its details:
   - **Vinyl** can be searched by **Album**, **Artist**, or **Song** (song
     searches return the track plus the album it appears on).
   - **Books** can be searched by **Title** or **Author**.
   - **Vinyl** → cover art, artist, year, type, genre and tracks
     (via the free, no-key [Deezer API](https://developers.deezer.com/api),
     called with JSONP). Deezer's search is fuzzy and popularity-ranked, so
     mainstream records surface reliably and the best-known entry of a given
     name comes first. Albums are enriched with year/genre/label on add.
   - **Books** → cover, author, first published year, page count, publisher,
     subjects (via the free [Open Library Search API](https://openlibrary.org/dev/docs/api/search)).
   - Results are re-ranked client-side, blending name-match quality with a
     popularity signal (Deezer's rank; Open Library edition counts) so the
     most popular match of a name appears at the top.
4. Your collection is saved in the browser's `localStorage`, so it survives
   refreshes. Hover a card and click **✕** to remove an item.
5. **Sync across devices (optional)** — click **☁ Sync** and connect a free
   Firebase Realtime Database (see below) to keep the same collection on every
   device.

## Sync across devices

The site is static, so cross-device sync uses a free
[Firebase Realtime Database](https://firebase.google.com/docs/database) over its
REST API — no SDK, no backend, no API key in the page.

1. Create a free project at **console.firebase.google.com** and add a
   **Realtime Database**.
2. In the database **Rules** tab, allow public read/write, then **Publish**:

   ```json
   { "rules": { ".read": true, ".write": true } }
   ```
3. Copy the database URL from the **Data** tab
   (`https://<project>-default-rtdb.firebaseio.com/`).
4. In Parrarchive, click **☁ Sync**, paste the URL (optionally with a path such
   as `…firebaseio.com/parrarchive`), and **Connect**. Do the same on each
   device with the same URL.

How it works: local storage drives the UI; every add/remove is `PUT` to the
database, and the app pulls the latest on load and whenever the tab regains
focus. The first time a device connects, its local items are merged with
whatever is already in the database so nothing is lost.

> **Note:** with public rules, anyone who knows the URL can read and edit the
> data. Keep the URL private and don't store anything sensitive. Tighten the
> rules later if you set up Firebase Authentication.

## Running locally

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server
# then visit http://localhost:8000
```

The lookups require internet access to reach the Deezer and Open Library APIs.

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
- **Storage:** collections live in the browser's `localStorage` and work fully
  offline. Connecting a Firebase Realtime Database (see *Sync across devices*)
  shares them across devices. Sync is last-write-wins per change rather than a
  true merge, so simultaneous edits on two offline devices can overwrite each
  other — fine for personal use.
