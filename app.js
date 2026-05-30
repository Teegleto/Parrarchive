/* Parrarchive — password-gated vinyl & book collection.
   Pure client-side: works on GitHub Pages with no backend. */

(function () {
  "use strict";

  const PASSWORD = "parrington";
  const SESSION_KEY = "parrarchive:unlocked";
  const STORE_KEYS = { vinyl: "parrarchive:vinyl", books: "parrarchive:books" };

  /* Per-mode configuration keeps vinyl and books behaviour declarative. */
  const MODES = {
    vinyl: {
      title: "Your Collection",
      placeholder: "Type a vinyl title… (e.g. Daft Punk Discovery)",
      lookup: lookupVinyl,
    },
    books: {
      title: "Your Bookshelf",
      placeholder: "Type a book title… (e.g. The Hobbit)",
      lookup: lookupBook,
    },
  };

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

  // ---------- Metadata lookups ----------

  /* iTunes Search API does not reliably send CORS headers, so we use JSONP:
     it supports a `callback` parameter and returns `callback({...})`. */
  function lookupVinyl(query) {
    return new Promise(function (resolve, reject) {
      const cb = "itunesCb_" + Date.now() + Math.floor(Math.random() * 1e6);
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
        const r = data && data.results && data.results[0];
        if (!r) return resolve(null);
        resolve({
          id: "v" + r.collectionId,
          title: r.collectionName,
          subtitle: r.artistName,
          cover: r.artworkUrl100 ? r.artworkUrl100.replace("100x100", "400x400") : "",
          coverClass: "",
          link: r.collectionViewUrl || "",
          meta: [
            ["Year", r.releaseDate ? r.releaseDate.slice(0, 4) : ""],
            ["Genre", r.primaryGenreName || ""],
            ["Tracks", r.trackCount != null ? String(r.trackCount) : ""],
          ],
        });
      };

      script.onerror = function () {
        cleanup();
        reject(new Error("Network error."));
      };
      script.src =
        "https://itunes.apple.com/search?term=" +
        encodeURIComponent(query) +
        "&entity=album&limit=1&callback=" +
        cb;
      document.body.appendChild(script);
    });
  }

  /* Open Library sends Access-Control-Allow-Origin: *, so a plain fetch works. */
  function lookupBook(query) {
    const url =
      "https://openlibrary.org/search.json?limit=1&q=" + encodeURIComponent(query);
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("Network error.");
        return res.json();
      })
      .then(function (data) {
        const d = data && data.docs && data.docs[0];
        if (!d) return null;
        return {
          id: "b" + (d.key || d.cover_edition_key || d.title),
          title: d.title,
          subtitle: d.author_name ? d.author_name.join(", ") : "Unknown author",
          cover: d.cover_i
            ? "https://covers.openlibrary.org/b/id/" + d.cover_i + "-M.jpg"
            : "",
          coverClass: "book",
          link: d.key ? "https://openlibrary.org" + d.key : "",
          meta: [
            ["First published", d.first_publish_year ? String(d.first_publish_year) : ""],
            ["Pages", d.number_of_pages_median ? String(d.number_of_pages_median) : ""],
            ["Publisher", d.publisher ? d.publisher[0] : ""],
            ["Subjects", d.subject ? d.subject.slice(0, 3).join(", ") : ""],
          ],
        };
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

    if (item.cover) {
      const img = el("img", "card-cover" + (item.coverClass ? " " + item.coverClass : ""));
      img.src = item.cover;
      img.alt = item.title;
      img.loading = "lazy";
      card.appendChild(img);
    } else {
      card.appendChild(el("div", "card-cover" + (item.coverClass ? " " + item.coverClass : "")));
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

    const modeButtons = document.querySelectorAll(".mode-btn");
    const titleEl = document.getElementById("collection-title");
    const addForm = document.getElementById("add-form");
    const addInput = document.getElementById("add-input");
    const addBtn = document.getElementById("add-btn");
    const statusEl = document.getElementById("status");
    const grid = document.getElementById("grid");
    const emptyEl = document.getElementById("empty");

    let currentMode = "vinyl";

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
            save(currentMode, list);
            renderCollection();
          })
        );
      });
    }

    // --- Switch between vinyl / books ---
    function setMode(mode) {
      currentMode = mode;
      const cfg = MODES[mode];
      titleEl.textContent = cfg.title;
      addInput.placeholder = cfg.placeholder;
      addInput.value = "";
      setStatus("");
      modeButtons.forEach(function (b) {
        b.classList.toggle("active", b.dataset.mode === mode);
      });
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

    // --- Add an item ---
    addForm.addEventListener("submit", function (e) {
      e.preventDefault();
      const query = addInput.value.trim();
      if (!query) return;

      addBtn.disabled = true;
      setStatus("Searching…");

      MODES[currentMode]
        .lookup(query)
        .then(function (item) {
          if (!item) {
            setStatus('No results found for "' + query + '".', true);
            return;
          }
          const list = load(currentMode);
          if (list.some(function (x) { return x.id === item.id; })) {
            setStatus('"' + item.title + '" is already in your collection.', true);
            return;
          }
          list.unshift(item);
          save(currentMode, list);
          addInput.value = "";
          setStatus("Added “" + item.title + "”.");
          renderCollection();
        })
        .catch(function (err) {
          setStatus("Couldn't fetch details: " + err.message, true);
        })
        .finally(function () {
          addBtn.disabled = false;
          addInput.focus();
        });
    });
  });
})();
