/* Parrarchive — password-gated vinyl & book collection.
   Pure client-side: works on GitHub Pages with no backend. */

(function () {
  "use strict";

  const PASSWORD = "parrington";
  const SESSION_KEY = "parrarchive:unlocked";
  const STORE_KEYS = { vinyl: "parrarchive:vinyl", books: "parrarchive:books" };

  const VIEW_KEY = "parrarchive:view";
  const SYNC_KEY = "parrarchive:sync";
  const SUGGEST_LIMIT = 7;

  /* Per-mode configuration keeps vinyl and books behaviour declarative.
     `fields` are the "search by" options shown in the dropdown. */
  const MODES = {
    vinyl: {
      title: "Your Collection",
      search: searchVinyl,
      fields: [
        { key: "album", label: "Album", placeholder: "Search by album… (e.g. Rumours)" },
        { key: "artist", label: "Artist", placeholder: "Search by artist… (e.g. Fleetwood Mac)" },
        { key: "song", label: "Song", placeholder: "Search by song… (e.g. Go Your Own Way)" },
      ],
    },
    books: {
      title: "Your Bookshelf",
      search: searchBook,
      fields: [
        { key: "title", label: "Title", placeholder: "Search by title… (e.g. The Hobbit)" },
        { key: "author", label: "Author", placeholder: "Search by author… (e.g. Tolkien)" },
      ],
    },
  };

  /* Seconds → m:ss, for song durations (Deezer reports seconds). */
  function formatSeconds(sec) {
    if (!sec) return "";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  // ---------- Storage helpers (kept small so richer sync can be added later) ----------
  function load(mode) {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEYS[mode])) || [];
    } catch (_) {
      return [];
    }
  }
  function save(mode, items) {
    localStorage.setItem(STORE_KEYS[mode], JSON.stringify(items));
  }

  // ---------- Result ranking ----------
  // Blend name-match quality with a popularity signal so that the obvious,
  // most-popular entry of a given name floats to the top. `popularity` is a
  // raw count (Deezer track rank, Open Library edition count); `idx` preserves
  // the API's own ordering as a gentle tie-breaker.
  function rankResults(items, query) {
    const q = query.trim().toLowerCase();
    return items
      .map(function (it, idx) {
        return { it: it, score: scoreItem(it, q, idx) };
      })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (x) { return x.it; });
  }

  function scoreItem(it, q, idx) {
    const title = (it.title || "").toLowerCase();
    let s = 0;
    if (title === q) s += 1000;
    else if (title.indexOf(q) === 0) s += 500;
    else if (title.indexOf(q) !== -1) s += 200;
    // Popularity, compressed so huge counts don't completely drown name matches.
    s += Math.log10((it.popularity || 0) + 1) * 60;
    // Keep the source API's ordering as a soft tie-breaker.
    s -= idx;
    return s;
  }

  // ---------- Metadata lookups ----------
  // Each search returns a Promise of an array of normalised items, best first.
  // The "Add" button uses the top match; the type-ahead lists them all.
  const POOL = 25; // candidates fetched per query before ranking/slicing

  /* JSONP loader — Deezer's API isn't CORS-enabled but supports
     `output=jsonp&callback=`, so we inject a <script> and await the callback. */
  function jsonp(url) {
    return new Promise(function (resolve, reject) {
      const cb = "dz_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const sep = url.indexOf("?") === -1 ? "?" : "&";
      const script = document.createElement("script");
      const timer = setTimeout(function () {
        cleanup();
        reject(new Error("Lookup timed out."));
      }, 10000);

      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cb] = function (data) {
        cleanup();
        resolve(data);
      };
      script.onerror = function () {
        cleanup();
        reject(new Error("Network error."));
      };
      script.src = url + sep + "output=jsonp&callback=" + cb;
      document.body.appendChild(script);
    });
  }

  const DEEZER = "https://api.deezer.com";

  function deezer(path, query, limit) {
    const url =
      DEEZER + path + "?limit=" + limit + "&q=" + encodeURIComponent(query);
    return jsonp(url).then(function (data) {
      return (data && data.data) || [];
    });
  }

  /* Map one Deezer album to our normalised item shape. Year/genre/label aren't
     in the search payload, so they're filled in on add via enrichAlbum(). */
  function mapDeezerAlbum(a) {
    return {
      id: "v" + a.id,
      title: a.title,
      subtitle: a.artist ? a.artist.name : "Unknown artist",
      cover: a.cover_big || a.cover_medium || a.cover || "",
      coverClass: "",
      link: a.link || "",
      popularity: 0, // album search is already returned popularity-ordered
      albumId: a.id, // transient: used to enrich on add, then dropped
      meta: [
        ["Type", a.record_type || ""],
        ["Tracks", a.nb_tracks != null ? String(a.nb_tracks) : ""],
      ],
    };
  }

  /* Map one Deezer track (a song) — surface the song, artist and its album. */
  function mapDeezerTrack(t) {
    const album = t.album || {};
    return {
      id: "vt" + t.id,
      title: t.title,
      subtitle: t.artist ? t.artist.name : "Unknown artist",
      cover: album.cover_big || album.cover_medium || album.cover || "",
      coverClass: "",
      link: t.link || "",
      popularity: t.rank || 0, // Deezer's own popularity score
      meta: [
        ["Album", album.title || ""],
        ["Length", formatSeconds(t.duration)],
      ],
    };
  }

  /* Fetch full album details to enrich a card with year, genre and label.
     Resilient: on any failure the item is returned with its basic meta. */
  function enrichAlbum(item) {
    return jsonp(DEEZER + "/album/" + item.albumId)
      .then(function (a) {
        if (!a || a.error) return item;
        const meta = [];
        if (a.release_date) meta.push(["Year", a.release_date.slice(0, 4)]);
        if (a.genres && a.genres.data && a.genres.data[0])
          meta.push(["Genre", a.genres.data[0].name]);
        if (a.record_type) meta.push(["Type", a.record_type]);
        if (a.nb_tracks != null) meta.push(["Tracks", String(a.nb_tracks)]);
        if (a.label) meta.push(["Label", a.label]);
        if (meta.length) item.meta = meta;
        return item;
      })
      .catch(function () { return item; });
  }

  /* Deezer: fuzzy, popularity-ranked and deep-catalogue, so basic/popular
     entries surface reliably. Album & artist hit album search (artist scopes
     by `artist:"…"`); song hits track search. */
  function searchVinyl(query, limit, field) {
    if (field === "song") {
      return deezer("/search/track", query, POOL).then(function (rows) {
        return rankResults(rows.map(mapDeezerTrack), query).slice(0, limit);
      });
    }
    const q = field === "artist" ? 'artist:"' + query + '"' : query;
    return deezer("/search/album", q, POOL).then(function (rows) {
      return rankResults(rows.map(mapDeezerAlbum), query).slice(0, limit);
    });
  }

  /* Map one Open Library doc to our normalised item shape. */
  function mapBook(d) {
    return {
      id: "b" + (d.key || d.cover_edition_key || d.title),
      title: d.title,
      subtitle: d.author_name ? d.author_name.join(", ") : "Unknown author",
      cover: d.cover_i
        ? "https://covers.openlibrary.org/b/id/" + d.cover_i + "-M.jpg"
        : "",
      coverClass: "book",
      link: d.key ? "https://openlibrary.org" + d.key : "",
      popularity: d.edition_count || 0, // more editions ≈ more popular/canonical
      meta: [
        ["First published", d.first_publish_year ? String(d.first_publish_year) : ""],
        ["Pages", d.number_of_pages_median ? String(d.number_of_pages_median) : ""],
        ["Publisher", d.publisher ? d.publisher[0] : ""],
        ["Subjects", d.subject ? d.subject.slice(0, 3).join(", ") : ""],
      ],
    };
  }

  /* Open Library sends Access-Control-Allow-Origin: *, so a plain fetch works.
     We pull a candidate pool with edition counts and rank by name + popularity
     so the canonical edition of a title comes first. */
  function searchBook(query, limit, field) {
    const param = field === "author" ? "author" : "title";
    const url =
      "https://openlibrary.org/search.json?limit=" +
      POOL +
      "&fields=key,title,author_name,first_publish_year,cover_i," +
      "edition_count,number_of_pages_median,publisher,subject" +
      "&" +
      param +
      "=" +
      encodeURIComponent(query);
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("Network error.");
        return res.json();
      })
      .then(function (data) {
        return rankResults(((data && data.docs) || []).map(mapBook), query).slice(
          0,
          limit
        );
      });
  }

  // ---------- Rendering ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderCard(item, onRemove) {
    const card = el("div", "card");

    const remove = el("button", "card-remove", "✕");
    remove.title = "Remove";
    remove.setAttribute("aria-label", "Remove " + item.title);
    remove.addEventListener("click", onRemove);
    card.appendChild(remove);

    const coverClass = "card-cover" + (item.coverClass ? " " + item.coverClass : "");
    if (item.cover) {
      const img = el("img", coverClass);
      img.src = item.cover;
      img.alt = item.title;
      img.loading = "lazy";
      // Swap to a plain placeholder if the cover doesn't exist (e.g. CAA 404).
      img.addEventListener("error", function () {
        img.replaceWith(el("div", coverClass));
      });
      card.appendChild(img);
    } else {
      card.appendChild(el("div", coverClass));
    }

    const body = el("div", "card-body");
    body.appendChild(el("h3", "card-title", item.title));
    if (item.subtitle) body.appendChild(el("p", "card-sub", item.subtitle));

    const list = el("ul", "card-meta");
    item.meta.forEach(function (pair) {
      if (!pair[1]) return;
      const li = el("li");
      li.appendChild(el("span", null, pair[0]));
      li.appendChild(el("span", null, pair[1]));
      list.appendChild(li);
    });
    body.appendChild(list);

    if (item.link) {
      const a = el("a", "card-link", "More info ↗");
      a.href = item.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      body.appendChild(a);
    }

    card.appendChild(body);
    return card;
  }

  // ---------- App controller ----------
  document.addEventListener("DOMContentLoaded", function () {
    const gate = document.getElementById("gate");
    const gateForm = document.getElementById("gate-form");
    const gateInput = document.getElementById("gate-input");
    const gateError = document.getElementById("gate-error");
    const chooser = document.getElementById("chooser");
    const choiceCards = document.querySelectorAll(".choice-card");
    const homeBtn = document.getElementById("home-btn");
    const app = document.getElementById("app");

    const modeButtons = document.querySelectorAll(".mode-btn[data-mode]");
    const titleEl = document.getElementById("collection-title");
    const addForm = document.getElementById("add-form");
    const addInput = document.getElementById("add-input");
    const addBtn = document.getElementById("add-btn");
    const searchFieldEl = document.getElementById("search-field");
    const suggestionsEl = document.getElementById("suggestions");
    const viewButtons = document.querySelectorAll(".view-btn");
    const statusEl = document.getElementById("status");
    const grid = document.getElementById("grid");
    const emptyEl = document.getElementById("empty");

    // Sync (cross-device) elements
    const syncBtn = document.getElementById("sync-btn");
    const syncModal = document.getElementById("sync-modal");
    const syncKeyInput = document.getElementById("sync-key");
    const syncBinInput = document.getElementById("sync-bin");
    const syncStatusEl = document.getElementById("sync-status");
    const syncSaveBtn = document.getElementById("sync-save");
    const syncNowBtn = document.getElementById("sync-now");
    const syncDisconnectBtn = document.getElementById("sync-disconnect");
    const syncCloseBtn = document.getElementById("sync-close");

    let currentMode = "vinyl";
    let currentField = "album"; // which "search by" field is active
    let currentView = localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";

    // --- Navigation between the chooser page and a collection view ---
    function showChooser() {
      gate.hidden = true;
      app.hidden = true;
      chooser.hidden = false;
    }
    function openMode(mode) {
      chooser.hidden = true;
      app.hidden = false;
      setMode(mode);
    }

    // --- Password gate ---
    function unlock() {
      gate.hidden = true;
      showChooser();
    }
    if (sessionStorage.getItem(SESSION_KEY) === "1") {
      unlock();
    }
    gateForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (gateInput.value === PASSWORD) {
        sessionStorage.setItem(SESSION_KEY, "1");
        unlock();
      } else {
        gateError.hidden = false;
        gateInput.value = "";
        gateInput.focus();
      }
    });

    // --- Status helper ---
    function setStatus(msg, isError) {
      if (!msg) {
        statusEl.hidden = true;
        statusEl.textContent = "";
        return;
      }
      statusEl.hidden = false;
      statusEl.textContent = msg;
      statusEl.classList.toggle("error", !!isError);
    }

    // --- Grid / list view toggle ---
    function setView(view) {
      currentView = view === "list" ? "list" : "grid";
      localStorage.setItem(VIEW_KEY, currentView);
      grid.classList.toggle("list-view", currentView === "list");
      viewButtons.forEach(function (b) {
        b.classList.toggle("active", b.dataset.view === currentView);
      });
    }

    // --- Render the current mode's collection ---
    function renderCollection() {
      const items = load(currentMode);
      grid.innerHTML = "";
      emptyEl.hidden = items.length > 0;
      items.forEach(function (item, index) {
        grid.appendChild(
          renderCard(item, function () {
            const list = load(currentMode);
            list.splice(index, 1);
            commit(currentMode, list);
            renderCollection();
          })
        );
      });
    }

    // --- Add an item (shared by the Add button and the suggestions) ---
    function addItem(item) {
      if (load(currentMode).some(function (x) { return x.id === item.id; })) {
        setStatus('“' + item.title + '” is already in your collection.', true);
        return;
      }
      // Albums get a follow-up lookup for year/genre/label before saving.
      const prepared = item.albumId ? enrichAlbum(item) : Promise.resolve(item);
      setStatus("Adding “" + item.title + "”…");
      prepared.then(function (full) {
        const stored = {
          id: full.id,
          title: full.title,
          subtitle: full.subtitle,
          cover: full.cover,
          coverClass: full.coverClass,
          link: full.link,
          meta: full.meta,
        };
        const list = load(currentMode);
        if (list.some(function (x) { return x.id === stored.id; })) return;
        list.unshift(stored);
        commit(currentMode, list);
        setStatus("Added “" + stored.title + "”.");
        renderCollection();
      });
    }

    // --- Cross-device sync (Firebase Realtime Database via REST) ---
    // Local storage stays the source of truth for the UI; every change is
    // pushed to the shared database, and we pull it back on load and on focus.
    let pushChain = Promise.resolve(); // serialises remote writes/reads

    function getSyncCfg() {
      try {
        return JSON.parse(localStorage.getItem(SYNC_KEY));
      } catch (_) {
        return null;
      }
    }
    function setSyncCfg(cfg) {
      if (cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
      else localStorage.removeItem(SYNC_KEY);
    }
    const JSONBIN = "https://api.jsonbin.io/v3";
    function jbHeaders(extra) {
      const cfg = getSyncCfg() || {};
      const h = { "Content-Type": "application/json", "X-Master-Key": cfg.key || "" };
      if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
      return h;
    }

    // Read the bin's latest record (X-Bin-Meta:false → just our document).
    function pullRemote() {
      const cfg = getSyncCfg();
      if (!cfg || !cfg.binId) return Promise.resolve(null);
      return fetch(JSONBIN + "/b/" + cfg.binId + "/latest", {
        headers: jbHeaders({ "X-Bin-Meta": "false" }),
        cache: "no-store",
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    }
    // Overwrite the bin with the whole collection.
    function pushRemote(doc) {
      const cfg = getSyncCfg();
      if (!cfg || !cfg.binId) return Promise.resolve();
      return fetch(JSONBIN + "/b/" + cfg.binId, {
        method: "PUT",
        headers: jbHeaders(),
        body: JSON.stringify(doc),
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    }
    // Create a fresh private bin and return its id.
    function createBin(doc) {
      return fetch(JSONBIN + "/b", {
        method: "POST",
        headers: jbHeaders({ "X-Bin-Private": "true", "X-Bin-Name": "Parrarchive" }),
        body: JSON.stringify(doc),
      })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (res) {
          return res && res.metadata && res.metadata.id;
        });
    }

    function currentDoc() {
      return { vinyl: load("vinyl"), books: load("books"), updatedAt: Date.now() };
    }
    // Combine two lists, de-duplicating by id (preserves order, local first).
    function unionById(a, b) {
      const seen = {};
      const out = [];
      (a || []).concat(b || []).forEach(function (x) {
        if (x && x.id && !seen[x.id]) {
          seen[x.id] = true;
          out.push(x);
        }
      });
      return out;
    }
    // Replace local collections with a document and refresh the view.
    function applyDoc(doc) {
      save("vinyl", (doc && doc.vinyl) || []);
      save("books", (doc && doc.books) || []);
      if (!app.hidden) renderCollection();
    }

    // save() locally, then push the whole collection to the database.
    function commit(mode, list) {
      save(mode, list);
      syncPush();
    }
    function isConnected() {
      const cfg = getSyncCfg();
      return !!(cfg && cfg.binId);
    }
    function syncPush() {
      if (!isConnected()) return;
      setSyncStatus("Saving…");
      pushChain = pushChain
        .then(function () { return pushRemote(currentDoc()); })
        .then(function () { setSyncStatus("Synced ✓", "ok"); })
        .catch(function (e) { setSyncStatus("Sync error: " + e.message, "error"); });
    }
    // Pull the latest from the bin (after any in-flight write completes).
    function syncRefresh() {
      if (!isConnected()) return;
      pushChain = pushChain
        .then(function () { return pullRemote(); })
        .then(function (remote) { if (remote) applyDoc(remote); })
        .catch(function () {});
    }
    // First connection on a device: union local + remote so nothing is lost,
    // creating the bin if one doesn't exist yet, then push the merged result.
    function syncConnect() {
      const cfg = getSyncCfg();
      if (!cfg) return;
      setSyncStatus("Connecting…");
      pushChain = pushChain
        .then(function () { return cfg.binId ? pullRemote() : null; })
        .then(function (remote) {
          remote = remote || {};
          const merged = {
            vinyl: unionById(load("vinyl"), remote.vinyl),
            books: unionById(load("books"), remote.books),
            updatedAt: Date.now(),
          };
          applyDoc(merged);
          if (cfg.binId) {
            return pushRemote(merged).then(function () { return cfg.binId; });
          }
          return createBin(merged).then(function (id) {
            if (!id) throw new Error("could not create bin");
            setSyncCfg({ key: cfg.key, binId: id });
            return id;
          });
        })
        .then(function (id) {
          updateSyncUI();
          setSyncStatus(
            "Connected ✓ — Bin ID: " + id + " (use this on your other devices)",
            "ok"
          );
        })
        .catch(function (e) { setSyncStatus("Sync error: " + e.message, "error"); });
    }

    function setSyncStatus(msg, kind) {
      syncStatusEl.textContent = msg || "";
      syncStatusEl.className = "sync-status" + (kind ? " " + kind : "");
    }
    function updateSyncUI() {
      const cfg = getSyncCfg();
      const on = isConnected();
      syncBtn.classList.toggle("connected", on);
      syncBtn.textContent = on ? "☁ Synced" : "☁ Sync";
      syncKeyInput.value = cfg ? cfg.key || "" : "";
      syncBinInput.value = cfg ? cfg.binId || "" : "";
      syncSaveBtn.textContent = on ? "Update & sync" : "Connect & sync";
      syncNowBtn.hidden = !on;
      syncDisconnectBtn.hidden = !on;
    }

    function openSyncModal() {
      updateSyncUI();
      if (!getSyncCfg()) setSyncStatus("");
      syncModal.hidden = false;
      syncKeyInput.focus();
    }
    function closeSyncModal() { syncModal.hidden = true; }

    syncBtn.addEventListener("click", openSyncModal);
    syncCloseBtn.addEventListener("click", closeSyncModal);
    syncModal.addEventListener("click", function (e) {
      if (e.target === syncModal) closeSyncModal();
    });
    syncSaveBtn.addEventListener("click", function () {
      const key = syncKeyInput.value.trim();
      const binId = syncBinInput.value.trim();
      if (!key) {
        setSyncStatus("Enter your JSONBin Master Key.", "error");
        return;
      }
      setSyncCfg({ key: key, binId: binId || undefined });
      updateSyncUI();
      syncConnect();
    });
    syncNowBtn.addEventListener("click", function () {
      setSyncStatus("Syncing…");
      syncRefresh();
      pushChain.then(function () { setSyncStatus("Synced ✓", "ok"); });
    });
    syncDisconnectBtn.addEventListener("click", function () {
      setSyncCfg(null);
      updateSyncUI();
      setSyncStatus("Disconnected. Your collection stays on this device.");
    });

    // Pull fresh data when returning to the tab/window.
    window.addEventListener("focus", syncRefresh);

    viewButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        setView(b.dataset.view);
      });
    });

    // --- "Search by" field selector ---
    function applyField() {
      const field = MODES[currentMode].fields.filter(function (f) {
        return f.key === currentField;
      })[0];
      addInput.placeholder = field ? field.placeholder : "";
    }

    function populateFields(mode) {
      const fields = MODES[mode].fields;
      searchFieldEl.innerHTML = "";
      fields.forEach(function (f) {
        const opt = el("option", null, f.label);
        opt.value = f.key;
        searchFieldEl.appendChild(opt);
      });
      currentField = fields[0].key;
      searchFieldEl.value = currentField;
      applyField();
    }

    searchFieldEl.addEventListener("change", function () {
      currentField = searchFieldEl.value;
      applyField();
      addInput.value = "";
      hideSuggestions();
      setStatus("");
      addInput.focus();
    });

    // --- Switch between vinyl / books ---
    function setMode(mode) {
      currentMode = mode;
      const cfg = MODES[mode];
      titleEl.textContent = cfg.title;
      populateFields(mode);
      addInput.value = "";
      setStatus("");
      hideSuggestions();
      modeButtons.forEach(function (b) {
        b.classList.toggle("active", b.dataset.mode === mode);
      });
      setView(currentView);
      renderCollection();
    }

    modeButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        setMode(b.dataset.mode);
      });
    });

    // Chooser page → open the selected collection
    choiceCards.forEach(function (c) {
      c.addEventListener("click", function () {
        openMode(c.dataset.mode);
      });
    });

    // Brand button → back to the chooser page
    homeBtn.addEventListener("click", showChooser);

    // --- Type-ahead suggestions ---
    let suggestItems = [];   // items currently shown in the dropdown
    let activeIndex = -1;    // keyboard-highlighted suggestion (-1 = none)
    let debounceTimer = null;
    let requestToken = 0;    // guards against out-of-order async responses

    function hideSuggestions() {
      suggestionsEl.hidden = true;
      suggestionsEl.innerHTML = "";
      suggestItems = [];
      activeIndex = -1;
      addInput.setAttribute("aria-expanded", "false");
    }

    function highlight(index) {
      activeIndex = index;
      Array.prototype.forEach.call(suggestionsEl.children, function (li, i) {
        li.classList.toggle("active", i === index);
      });
    }

    function renderSuggestions(items) {
      suggestItems = items;
      activeIndex = -1;
      suggestionsEl.innerHTML = "";
      if (!items.length) {
        hideSuggestions();
        return;
      }
      items.forEach(function (item, i) {
        const li = el("li", "suggestion");
        li.setAttribute("role", "option");
        if (item.cover) {
          const img = el("img", "suggestion-thumb");
          img.src = item.cover;
          img.alt = "";
          img.loading = "lazy";
          img.addEventListener("error", function () {
            img.replaceWith(el("span", "suggestion-thumb"));
          });
          li.appendChild(img);
        } else {
          li.appendChild(el("span", "suggestion-thumb"));
        }
        const txt = el("div", "suggestion-text");
        txt.appendChild(el("span", "suggestion-title", item.title));
        if (item.subtitle) txt.appendChild(el("span", "suggestion-sub", item.subtitle));
        li.appendChild(txt);
        // mousedown (not click) fires before the input's blur, so the pick lands.
        li.addEventListener("mousedown", function (ev) {
          ev.preventDefault();
          chooseSuggestion(i);
        });
        li.addEventListener("mouseenter", function () { highlight(i); });
        suggestionsEl.appendChild(li);
      });
      suggestionsEl.hidden = false;
      addInput.setAttribute("aria-expanded", "true");
    }

    function chooseSuggestion(i) {
      const item = suggestItems[i];
      if (!item) return;
      addItem(item);
      addInput.value = "";
      hideSuggestions();
      addInput.focus();
    }

    function fetchSuggestions() {
      const query = addInput.value.trim();
      if (query.length < 2) {
        hideSuggestions();
        return;
      }
      const token = ++requestToken;
      MODES[currentMode]
        .search(query, SUGGEST_LIMIT, currentField)
        .then(function (items) {
          if (token !== requestToken) return; // a newer keystroke superseded this
          renderSuggestions(items);
        })
        .catch(function () {
          if (token === requestToken) hideSuggestions();
        });
    }

    addInput.addEventListener("input", function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchSuggestions, 250);
    });

    addInput.addEventListener("keydown", function (e) {
      if (suggestionsEl.hidden || !suggestItems.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlight((activeIndex + 1) % suggestItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlight((activeIndex - 1 + suggestItems.length) % suggestItems.length);
      } else if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        chooseSuggestion(activeIndex);
      } else if (e.key === "Escape") {
        hideSuggestions();
      }
    });

    addInput.addEventListener("blur", function () {
      // Delay so a suggestion mousedown can complete first.
      setTimeout(hideSuggestions, 120);
    });

    // --- Add via the button: use the best (first) match ---
    addForm.addEventListener("submit", function (e) {
      e.preventDefault();
      const query = addInput.value.trim();
      if (!query) return;

      hideSuggestions();
      addBtn.disabled = true;
      setStatus("Searching…");

      MODES[currentMode]
        .search(query, 1, currentField)
        .then(function (items) {
          if (!items.length) {
            setStatus('No results found for "' + query + '".', true);
            return;
          }
          addItem(items[0]);
          addInput.value = "";
        })
        .catch(function (err) {
          setStatus("Couldn't fetch details: " + err.message, true);
        })
        .finally(function () {
          addBtn.disabled = false;
          addInput.focus();
        });
    });

    // --- Initialise sync on startup ---
    updateSyncUI();
    if (isConnected()) syncConnect();
  });
})();
