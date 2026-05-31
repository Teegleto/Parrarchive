/* Parrarchive — password-gated vinyl & book collection.
   Pure client-side: works on GitHub Pages with no backend. */

(function () {
  "use strict";

  const PASSWORD = "parrington";
  const SESSION_KEY = "parrarchive:unlocked";
  const STORE_KEYS = { vinyl: "parrarchive:vinyl", books: "parrarchive:books" };

  const VIEW_KEY = "parrarchive:view";
  const SUGGEST_LIMIT = 7;

  /* Per-mode configuration keeps vinyl and books behaviour declarative. */
  const MODES = {
    vinyl: {
      title: "Your Collection",
      placeholder: "Type a record or album… (e.g. Fleetwood Mac Rumours)",
      search: searchVinyl,
    },
    books: {
      title: "Your Bookshelf",
      placeholder: "Type a book title… (e.g. The Hobbit)",
      search: searchBook,
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
  // Each search returns a Promise of an array of normalised items (newest/best
  // first). The "Add" button uses the top match; the type-ahead lists them all.

  /* Map one MusicBrainz release-group to our normalised item shape. */
  function mapVinyl(rg) {
    const credit = rg["artist-credit"] || [];
    const artist =
      credit
        .map(function (c) { return c.name + (c.joinphrase || ""); })
        .join("") || "Unknown artist";
    const type = [rg["primary-type"]]
      .concat(rg["secondary-types"] || [])
      .filter(Boolean)
      .join(" · ");
    const genres = (rg.tags || [])
      .slice()
      .sort(function (a, b) { return (b.count || 0) - (a.count || 0); })
      .slice(0, 2)
      .map(function (t) { return t.name; })
      .join(", ");
    return {
      id: "v" + rg.id,
      title: rg.title,
      subtitle: artist,
      // Cover Art Archive returns the release-group's front cover (404s when
      // none exists — renderCard/suggestions fall back to a placeholder).
      cover: "https://coverartarchive.org/release-group/" + rg.id + "/front-250",
      coverClass: "",
      link: "https://musicbrainz.org/release-group/" + rg.id,
      meta: [
        ["Year", (rg["first-release-date"] || "").slice(0, 4)],
        ["Type", type],
        ["Genre", genres],
      ],
    };
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
      meta: [
        ["First published", d.first_publish_year ? String(d.first_publish_year) : ""],
        ["Pages", d.number_of_pages_median ? String(d.number_of_pages_median) : ""],
        ["Publisher", d.publisher ? d.publisher[0] : ""],
        ["Subjects", d.subject ? d.subject.slice(0, 3).join(", ") : ""],
      ],
    };
  }

  /* MusicBrainz sends Access-Control-Allow-Origin: *, so a plain fetch works.
     The release-group search covers decades of releases, including older and
     out-of-print records that the iTunes store does not carry. */
  function searchVinyl(query, limit) {
    const url =
      "https://musicbrainz.org/ws/2/release-group/?fmt=json&limit=" +
      (limit || 1) +
      "&query=" +
      encodeURIComponent(query);
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("Network error.");
        return res.json();
      })
      .then(function (data) {
        return ((data && data["release-groups"]) || []).map(mapVinyl);
      });
  }

  /* Open Library sends Access-Control-Allow-Origin: *, so a plain fetch works. */
  function searchBook(query, limit) {
    const url =
      "https://openlibrary.org/search.json?limit=" +
      (limit || 1) +
      "&q=" +
      encodeURIComponent(query);
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("Network error.");
        return res.json();
      })
      .then(function (data) {
        return ((data && data.docs) || []).map(mapBook);
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

    const modeButtons = document.querySelectorAll(".mode-btn");
    const titleEl = document.getElementById("collection-title");
    const addForm = document.getElementById("add-form");
    const addInput = document.getElementById("add-input");
    const addBtn = document.getElementById("add-btn");
    const suggestionsEl = document.getElementById("suggestions");
    const viewButtons = document.querySelectorAll(".view-btn");
    const statusEl = document.getElementById("status");
    const grid = document.getElementById("grid");
    const emptyEl = document.getElementById("empty");

    let currentMode = "vinyl";
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
            save(currentMode, list);
            renderCollection();
          })
        );
      });
    }

    // --- Add an item (shared by the Add button and the suggestions) ---
    function addItem(item) {
      const list = load(currentMode);
      if (list.some(function (x) { return x.id === item.id; })) {
        setStatus('“' + item.title + '” is already in your collection.', true);
        return;
      }
      list.unshift(item);
      save(currentMode, list);
      setStatus("Added “" + item.title + "”.");
      renderCollection();
    }

    viewButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        setView(b.dataset.view);
      });
    });

    // --- Switch between vinyl / books ---
    function setMode(mode) {
      currentMode = mode;
      const cfg = MODES[mode];
      titleEl.textContent = cfg.title;
      addInput.placeholder = cfg.placeholder;
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
        .search(query, SUGGEST_LIMIT)
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
      debounceTimer = setTimeout(fetchSuggestions, 400);
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
        .search(query, 1)
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
  });
})();
