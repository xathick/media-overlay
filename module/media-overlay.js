// ===== media-overlay.js =====

const MOD_ID = "media-overlay";
const SETTING_ENTRIES = "entries";

/** Cuando es TRUE, si hay overlay visible NO se sincroniza automáticamente con la nueva escena */
const STICKY_ON_SCENE_CHANGE = true;

/* ───────── Helpers ───────── */
const MediaType = { IMAGE: "image", VIDEO: "video" };
const inferType = (url = "") => /\.(mp4|webm|ogg)(\?.*)?$/i.test(url) ? MediaType.VIDEO : MediaType.IMAGE;
const curScene = () => game.scenes?.current ?? canvas?.scene;

/* Rutas de fuentes */
const FONTS_DIR = `modules/${MOD_ID}/assets`;
const basenameNoExt = (p = "") => (p.split("/").pop() || p).replace(/\.[^.]+$/,"");
const familyFromPath = (p = "") => basenameNoExt(p).replace(/[-_]+/g, " ").trim();

/* Carga perezosa de fuentes */
const Fonts = {
  _loaded: new Set(),
  _pending: new Map(),
  ensure(family, url) {
    if (!family || !url) return Promise.resolve();
    if (this._loaded.has(family)) return Promise.resolve();
    if (this._pending.has(family)) return this._pending.get(family);

    const p = (async () => {
      try {
        const face = new FontFace(family, `url(${url})`);
        const loaded = await face.load();
        document.fonts.add(loaded);
        this._loaded.add(family);
      } catch (e) {
        console.warn("[Media Overlay] No se pudo cargar la fuente:", family, url, e);
      } finally {
        this._pending.delete(family);
      }
    })();

    this._pending.set(family, p);
    return p;
  }
};

async function listAvailableFonts() {
  try {
    const res = await FilePicker.browse("data", FONTS_DIR);
    const files = res?.files ?? [];
    return files
      .filter(f => /\.(ttf|otf)$/i.test(f))
      .map(path => ({ value: path, label: basenameNoExt(path) }));
  } catch (e) {
    console.warn("[Media Overlay] No se pudieron listar fuentes en", FONTS_DIR, e);
    return [];
  }
}

/* ───────── Settings + Keybinding (INIT) ───────── */
Hooks.once("init", () => {
  game.settings.register(MOD_ID, SETTING_ENTRIES, {
    name: "Librería de medios",
    scope: "world",
    config: false,
    type: Array, // [{id,url,caption,title,type,font}]
    default: []
  });

  // Tecla S: abre/cierra el selector SIEMPRE. El overlay no se toca.
  game.keybindings.register(MOD_ID, "toggle-picker", {
    name: "Abrir/cerrar selector de Media Overlay",
    hint: "Pulsa S para abrir o cerrar el selector. No afecta al overlay.",
    editable: [{ key: "KeyS" }],
    restricted: true,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
    onDown: () => {
      if (!game.user.isGM) return false;
      Hooks.callAll("mediaOverlay:togglePicker");
      return true;
    }
  });
});

/* ───────── Runtime (READY) ───────── */
let pickerApp = null;

Hooks.once("ready", () => {
  // Toggle del selector (una sola instancia)
  Hooks.on("mediaOverlay:togglePicker", () => {
    if (!pickerApp) pickerApp = new MediaPickerApp();
    if (pickerApp.rendered) pickerApp.close(); else pickerApp.render({ force: true });
  });

  // Socket sync: obedecemos show/hide explícitos
  game.socket.on(`module.${MOD_ID}`, p => {
    if (p?.op === "show") Overlay.render(p.entry);
    if (p?.op === "hide") Overlay.hideLocal();
    if (pickerApp?.rendered) pickerApp.updateSelectionFromScene?.();
  });

  // Flags de escena: si overlay visible y sticky → ignorar
  Hooks.on("updateScene", (scene, data) => {
    if (scene.id !== curScene()?.id) return;
    const changed = foundry.utils.getProperty(data, `flags.${MOD_ID}.active`);

    if (STICKY_ON_SCENE_CHANGE && Overlay.isVisible()) {
      if (pickerApp?.rendered) pickerApp.updateSelectionFromScene?.();
      return;
    }

    if (changed === null) Overlay.hideLocal();
    else if (changed) Overlay.render(changed);

    if (pickerApp?.rendered) pickerApp.updateSelectionFromScene?.();
  });
});

/* Restaurar overlay activo al cargar/cambiar canvas */
function restoreActiveOverlay() {
  try {
    if (STICKY_ON_SCENE_CHANGE && Overlay.isVisible()) {
      if (pickerApp?.rendered) pickerApp.updateSelectionFromScene?.();
      return;
    }
    const e = curScene()?.getFlag(MOD_ID, "active");
    if (e) Overlay.render(e); else Overlay.hideLocal();
    if (pickerApp?.rendered) pickerApp.updateSelectionFromScene?.();
  } catch (err) {
    console.error("[Media Overlay] restoreActiveOverlay error:", err);
  }
}
Hooks.once("ready", () => setTimeout(restoreActiveOverlay, 0));
Hooks.on("canvasReady", restoreActiveOverlay);

/* ───────── Store ───────── */
const Store = {
  list() {
    const v = game.settings.get(MOD_ID, SETTING_ENTRIES);
    return Array.isArray(v) ? foundry.utils.duplicate(v) : [];
  },
  async save(all) {
    await game.settings.set(MOD_ID, SETTING_ENTRIES, all);
    return all;
  },
  async add({ url, caption, title, font }) {
    if (!url) throw new Error("URL vacía");
    const all = this.list();
    all.push({
      id: foundry.utils.randomID?.() ?? randomID(),
      url,
      caption: caption || "",
      title: title || "",
      type: inferType(url),
      font: font || ""
    });
    return this.save(all);
  },
  async remove(id) {
    const all = this.list().filter(e => e.id !== id);
    return this.save(all);
  },
  async update(id, { url, caption, title, font }) {
    const all = this.list();
    const idx = all.findIndex(e => e.id === id);
    if (idx === -1) throw new Error("Entrada no encontrada");
    const cur = all[idx];
    const newUrl = url ?? cur.url;
    all[idx] = {
      ...cur,
      url: newUrl,
      caption: caption ?? cur.caption,
      title: (title !== undefined ? title : cur.title || ""),
      type: inferType(newUrl),
      font: (font !== undefined ? font : cur.font || "")
    };
    return this.save(all);
  }
};

/* ───────── Mostrar/Ocultar a todos ───────── */
async function showToAll(entry) {
  const scene = curScene();
  if (!scene) return ui.notifications.warn("No hay escena activa.");
  await scene.setFlag(MOD_ID, "active", {
    id: entry.id, url: entry.url, type: entry.type,
    caption: entry.caption || "", title: entry.title || "",
    font: entry.font || ""
  });
  game.socket.emit(`module.${MOD_ID}`, { op: "show", entry });
}
async function hideForAll() {
  const scene = curScene(); if (!scene) return;
  await scene.unsetFlag(MOD_ID, "active");
  game.socket.emit(`module.${MOD_ID}`, { op: "hide" });
}

/* ───────── Overlay ───────── */
const Overlay = {
  _progressTimer: null,
  _loadToken: null, 

  ensureRoot(){
    let root = document.getElementById("mo-overlay-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "mo-overlay-root";
    root.innerHTML = `
      <div id="mo-overlay-wrap">
        <div id="mo-overlay-bar">
          <button class="mo-btn" hidden data-action="close" title="Ocultar"><i class="fas fa-times"></i></button>
        </div>

        <!-- Loader -->
        <div id="mo-loader" hidden>
          <div class="mo-box">
            <div class="mo-ring"></div>
            <div class="mo-progress" hidden><div class="mo-progress-bar"></div></div>
            <div class="mo-loader-text">Cargando… <span class="pct"></span></div>
          </div>
        </div>

        <!-- Botón toggle play/pausa centrado arriba -->
        <button id="mo-toggle" hidden aria-label="Reproducir/Pausar"><i class="fas fa-pause"></i></button>

        <div id="mo-overlay-caption">
          <div id="mo-caption-title">
            <div id="mo-caption-text"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    // Fades para textos
    root.querySelector("#mo-caption-title")?.classList.add("mo-fade");
    root.querySelector("#mo-caption-text")?.classList.add("mo-fade");

    this._toggleVideoControls(false);
    return root;
  },

  /** ¿hay overlay visible ahora mismo? */
  isVisible(){
    const root = document.getElementById("mo-overlay-root");
    if (!root) return false;
    if (getComputedStyle(root).display === "none") return false;
    return !!root.querySelector("#mo-overlay-media");
  },

  _toggleVideoControls(isVideo, paused = false){
    const root = document.getElementById("mo-overlay-root"); if (!root) return;
    const btn = root.querySelector("#mo-toggle"); if (!btn) return;
    const show = !!isVideo;
    btn.hidden = !show; btn.disabled = !show; btn.setAttribute("aria-hidden", String(!show));
    if (show){
      const icon = btn.querySelector("i");
      if (icon) icon.className = paused ? "fas fa-play" : "fas fa-pause";
      btn.title = paused ? "Reproducir" : "Pausar";
    }
  },

  /* ===== Loader ===== */
  _showLoader({ showProgress = false } = {}){
    const root = document.getElementById("mo-overlay-root"); if (!root) return;
    const el = root.querySelector("#mo-loader"); if (!el) return;

    // reset
    el.hidden = false;
    el.classList.remove("is-visible");
    const barWrap = el.querySelector(".mo-progress");
    const bar = el.querySelector(".mo-progress-bar");
    const pct = el.querySelector(".pct");
    if (bar) bar.style.width = "0%";
    if (pct) pct.textContent = "";
    if (barWrap) barWrap.hidden = !showProgress;

    // fade-in por clase (CSS)
    requestAnimationFrame(() => el.classList.add("is-visible"));
  },

  _hideLoader(){
    const root = document.getElementById("mo-overlay-root"); if (!root) return;
    const el = root.querySelector("#mo-loader"); if (!el || el.hidden) return;

    el.classList.remove("is-visible");
    const done = () => { el.hidden = true; el.removeEventListener("transitionend", done); };
    el.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 1000);

    if (this._progressTimer){ clearInterval(this._progressTimer); this._progressTimer = null; }
  },

  _startVideoProgress(video){
    const root = document.getElementById("mo-overlay-root"); if (!root) return;
    const el = root.querySelector("#mo-loader"); if (!el) return;
    const barWrap = el.querySelector(".mo-progress");
    const bar = el.querySelector(".mo-progress-bar");
    const pct = el.querySelector(".pct");
    if (barWrap) barWrap.hidden = false;

    const update = () => {
      try {
        const dur = video.duration;
        if (!isFinite(dur) || dur <= 0) return;
        let end = 0;
        const br = video.buffered;
        for (let i = 0; i < br.length; i++) end = Math.max(end, br.end(i));
        const frac = Math.max(0, Math.min(1, end / dur));
        const perc = Math.round(frac * 100);
        if (bar) bar.style.width = `${perc}%`;
        if (pct) pct.textContent = `${perc}%`;
      } catch {}
    };

    this._progressTimer && clearInterval(this._progressTimer);
    this._progressTimer = setInterval(update, 200);
    video.addEventListener("progress", update);
    video.addEventListener("loadedmetadata", update, { once: true });
  },

  /* ===== Render principal (con token anti-falsos errores) ===== */
  async render(entry){
    const root = this.ensureRoot();
    const wrap = root.querySelector("#mo-overlay-wrap");
    const old  = root.querySelector("#mo-overlay-media");

    // Nuevo token de carga
    const token = (this._loadToken = Symbol("mo-load"));
    let loaded = false;

    // Mostrar loader (vídeo => con progreso)
    const isVid = entry.type === MediaType.VIDEO;
    this._showLoader({ showProgress: isVid });

    // Crear medio
    const el = document.createElement(isVid ? "video" : "img");
    el.id = "mo-overlay-media";
    el.classList.add("mo-fade");
    if (isVid) {
      Object.assign(el, { src: entry.url, muted: true, loop: true, playsInline: true, controls: false });
    } else {
      el.src = entry.url; el.alt = "";
    }
    wrap.insertBefore(el, wrap.firstChild);

    if (isVid) this._startVideoProgress(el);

    // Notificación segura
    const notifyErrorOnce = (msg) => {
      if (this._loadToken !== token || loaded) return;
      this._hideLoader();
      ui.notifications.error(msg);
      ui.controls?.render?.();
    };

    // Watchdog: 8s sin “ready”
    const watchdog = setTimeout(() => {
      notifyErrorOnce(isVid ? "El vídeo está tardando demasiado en cargar." : "La imagen está tardando demasiado en cargar.");
    }, 8000);

    // Listo para mostrar
    const onReady = () => {
      if (this._loadToken !== token) return; 
      loaded = true;
      clearTimeout(watchdog);
      requestAnimationFrame(() => {
        el.classList.add("is-visible");
        if (el.tagName === "VIDEO") el.play().catch(()=>{});
        this._hideLoader(); // fade-out loader
        root.style.display = "block";
        ui.controls?.render?.(); 
      });
    };

    // Eventos de carga / error
    if (isVid) {
      (el.readyState >= 2) ? onReady() : el.addEventListener("loadeddata", onReady, { once: true });
      el.addEventListener("error",   () => notifyErrorOnce("No se pudo cargar el vídeo."), { once: true });
      el.addEventListener("stalled", () => notifyErrorOnce("Problema de red al cargar el vídeo."), { once: true });
      el.addEventListener("abort",   () => notifyErrorOnce("Carga de vídeo cancelada."), { once: true });
    } else {
      el.complete ? onReady() : el.addEventListener("load", onReady, { once: true });
      el.addEventListener("error", () => notifyErrorOnce("No se pudo cargar la imagen."), { once: true });
    }

    // Cross-fade con el elemento antiguo
    if (old){
      old.classList.remove("is-visible");
      old.classList.add("mo-fade");
      const cleanup = () => {
        if (old.tagName === "VIDEO") { try { old.pause(); } catch {} old.src=""; old.load?.(); }
        old.remove();
      };
      old.addEventListener("transitionend", cleanup, { once: true });
      setTimeout(cleanup, 1000);
    }

    /* Toggle play/pausa (icono) */
    this._toggleVideoControls(isVid, isVid ? el.paused : false);
    const tbtn = root.querySelector("#mo-toggle");
    if (isVid && tbtn){
      const updateIcon = () => {
        const icon = tbtn.querySelector("i");
        if (icon) icon.className = el.paused ? "fas fa-play" : "fas fa-pause";
        tbtn.title = el.paused ? "Reproducir" : "Pausar";
      };
      tbtn.onclick = () => { if (el.paused) el.play().catch(()=>{}); else el.pause(); updateIcon(); };
      el.addEventListener("play",  updateIcon);
      el.addEventListener("pause", updateIcon);
      el.addEventListener("loadeddata", updateIcon, { once: true });
    } else if (tbtn){ tbtn.hidden = true; tbtn.disabled = true; }

    /* === Texto dentro del cartel === */
    const titleWrap = root.querySelector("#mo-caption-title");
    const textEl    = root.querySelector("#mo-caption-text");

    const newDesc  = entry.caption || "";
    const newTitle = entry.title   || "";
    const fontPath = entry.font    || "";
    const displayText = newTitle || newDesc;

    if (titleWrap && textEl){
      [titleWrap, textEl].forEach(n => { n.classList.add("mo-fade"); n.classList.remove("is-visible"); n.style.visibility = "hidden"; });
      textEl.textContent = displayText;
      titleWrap.style.display = displayText ? "inline-flex" : "none";

      if (fontPath){
        const fam = familyFromPath(fontPath);
        const timeout = new Promise(r => setTimeout(r, 2000));
        await Promise.race([Fonts.ensure(fam, fontPath), timeout]);
        try { await document.fonts.load(`1em "${fam}"`); } catch {}
        const stack = `"${fam}", "Cinzel", "Playfair Display", Georgia, "Times New Roman", serif`;
        textEl.style.fontFamily  = stack;
        titleWrap.style.fontFamily = stack;
      } else {
        textEl.style.fontFamily  = "";
        titleWrap.style.fontFamily = "";
      }

      requestAnimationFrame(() => {
        if (titleWrap.style.display !== "none") {
          titleWrap.style.visibility = "visible";
          titleWrap.classList.add("is-visible");
        }
        textEl.style.visibility = "visible";
        textEl.classList.add("is-visible");
      });
    }

    // Cerrar (si decides mostrar el botón en algún momento)
    root.querySelector("[data-action='close']").onclick = () => {
      if (game.user.isGM) hideForAll(); else this.hideLocal();
    };
  },

  hideLocal(){
    const root = document.getElementById("mo-overlay-root"); if (!root) return;

    this._hideLoader();

    const tbtn = root.querySelector("#mo-toggle");
    if (tbtn){ tbtn.hidden = true; tbtn.disabled = true; }

    const titleWrap = root.querySelector("#mo-caption-title");
    const textEl    = root.querySelector("#mo-caption-text");
    if (titleWrap) titleWrap.classList.remove("is-visible");
    if (textEl)    textEl.classList.remove("is-visible");

    const media = root.querySelector("#mo-overlay-media");
    if (!media) {
      root.style.display = "none";
      this._toggleVideoControls(false);
      ui.controls?.render?.(); 
      return;
    }
    media.classList.remove("is-visible");
    media.classList.add("mo-fade");
    const finish = () => {
      if (media.tagName === "VIDEO") { try { media.pause(); } catch {} media.src=""; media.load?.(); }
      media.remove();
      root.style.display = "none";
      this._toggleVideoControls(false);
      ui.controls?.render?.(); 
    };
    media.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 1000);
  }
};

// Depuración mínima
console.log("ApplicationV2 typeof:", typeof foundry?.applications?.api?.ApplicationV2);

/* ───────── UI: ApplicationV2 con cuadrícula de miniaturas ───────── */
class MediaPickerApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "media-picker",
    window: { title: "Selector Media Overlay", icon: "fas fa-photo-film" },
    position: { width: 620, height: "auto" }
  };

  /* === Render: HTML como string === */
  async _renderHTML() {
    const entries = Store.list();

    // Lista de fuentes disponibles
    let fontOptions = await listAvailableFonts();
    const fontOptsHTML = [
      `<option value="">(Fuente por defecto)</option>`,
      ...fontOptions.map(f => `<option value="${f.value}">${f.label}</option>`)
    ].join("");

    const gridItems = entries.map(e => {
      const media = (e.type === "video")
        ? `<video src="${e.url}" muted loop playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover;"></video>`
        : `<img src="${e.url}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;">`;
      const cap = (e.caption || "").replaceAll('"', '&quot;');
      return `
        <div class="mo-thumb" data-id="${e.id}" data-type="${e.type}" title="${cap}">
          <button class="mo-del" type="button" data-id="${e.id}" title="Eliminar de la librería" aria-label="Eliminar">
            <i class="fas fa-trash"></i>
          </button>
          <div class="mo-thumb-media">${media}</div>
          <div class="mo-thumb-cap">${cap || "&nbsp;"}</div>
        </div>`;
    }).join("");

    // Estado del colapsable: por defecto CERRADO (persistente mientras la app esté abierta)
    const open = this._addOpen === true;

    return `
      <div id="mo-root" style="padding:12px; display:flex; flex-direction:column; gap:8px;">

        <!-- Fieldset colapsable -->
        <fieldset id="mo-add-fieldset" class="mo-collapsible" data-open="${open ? "true" : "false"}" style="padding:8px;">
          <legend style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <span id="mo-form-title">Añadir medio</span>
            <button id="mo-collapse" class="mo-btn mo-icon" type="button" aria-expanded="${open ? "true" : "false"}" aria-controls="mo-add-body" title="${open ? "Contraer" : "Expandir"}">
              <i class="fas ${open ? "fa-chevron-up" : "fa-chevron-down"}"></i>
            </button>
          </legend>

          <div id="mo-add-body" class="mo-collapsible-body" style="display:${open ? "block" : "none"};">
            <label for="mo-title" style="margin-top:6px;">Título</label>
            <input id="mo-title" type="text" placeholder="Título (opcional)" style="width:100%">

            <label for="mo-cap" style="margin-top:6px;">Descripción</label>
            <input id="mo-cap" type="text" placeholder="¿Ubicación? ¿Qué representa?" style="width:100%">

            <label for="mo-url">Archivo o URL</label>
            <div class="mo-url-row" style="display:grid; grid-template-columns: 1fr auto; gap:6px; align-items:center;">
              <input id="mo-url" type="text" placeholder="https://.../imagen.jpg o video.mp4  |  o usa Explorar…" style="width:100%">
              <button id="mo-browse" class="mo-btn" type="button" title="Explorar archivos de Foundry">
                <i class="fas fa-folder-open"></i> Explorar…
              </button>
            </div>
           
            <label for="mo-font" style="margin-top:6px;">Fuente</label>
            <select id="mo-font" style="width:100%;">${fontOptsHTML}</select>

            <div style="margin-top:8px; display:flex; gap:6px; justify-content:flex-end;">
              <button id="mo-commit" class="mo-btn">Añadir</button>
            </div>
          </div>
        </fieldset>

        <fieldset style="padding:8px;">
          <legend>Librería</legend>
          <div id="mo-grid" class="mo-grid">
            ${gridItems || `<div class="mo-empty">No hay medios aún. Añade alguno arriba.</div>`}
          </div>
        </fieldset>
      </div>
    `;
  }

  /* === Inserta el HTML en el contenedor === */
  async _replaceHTML(a, b) {
    const element = (a instanceof Element) ? a : b;
    const html    = (a instanceof Element) ? b : a;
    element.innerHTML = html;

    this._root = element;             
    this._attachListeners(element);
    this.updateSelectionFromScene(); 
  }

  /* === Listeners y manejo de UI === */
  _attachListeners(element) {
    const $ = (sel) => element.querySelector(sel);

    // ── Colapsable "Añadir medio" ────────────────────────────────────────────
    {
      const fs   = $("#mo-add-fieldset");
      const body = $("#mo-add-body");
      const btn  = $("#mo-collapse");
      const apply = () => {
        const open = this._addOpen === true;
        if (fs)   fs.dataset.open = String(open);
        if (body) body.style.display = open ? "block" : "none";
        if (btn)  {
          btn.setAttribute("aria-expanded", String(open));
          btn.title = open ? "Contraer" : "Expandir";
          const ic = btn.querySelector("i");
          if (ic) ic.className = open ? "fas fa-chevron-up" : "fas fa-chevron-down";
        }
      };
      if (this._addOpen === undefined) this._addOpen = false; // por defecto CERRADO
      apply();
      btn?.addEventListener("click", () => { this._addOpen = !this._addOpen; apply(); });
    }

    // Clicks en botones (delegación)
    element.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;

      // Explorar archivos con FilePicker
      if (btn.id === "mo-browse") {
        try {
          const FP = globalThis.FilePicker ?? foundry?.applications?.api?.FilePicker;
          if (!FP) return ui.notifications.error("FilePicker no está disponible en esta versión.");

          const picker = new FP({
            type: "imagevideo",
            callback: (path) => {
              const input = $("#mo-url");
              if (input) {
                input.value = path;
                input.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }
          });

          picker.render(true);
        } catch (e) {
          console.error(e);
          ui.notifications.error("No se pudo abrir el explorador de archivos.");
        }
        return;
      }

      // Añadir / Guardar (según modo)
      if (btn.id === "mo-commit") {
        const url = $("#mo-url")?.value?.trim();
        const caption = $("#mo-cap")?.value?.trim();
        const title = $("#mo-title")?.value?.trim() || "";
        const font = $("#mo-font")?.value || "";
        if (!url) { ui.notifications.warn("Introduce una URL."); return; }

        try {
          if (this.editingId) {
            await Store.update(this.editingId, { url, caption, title, font });
            ui.notifications.info("Medio actualizado.");

            // Si el que editamos está activo, refrescar overlay + flag en escena
            const active = curScene()?.getFlag(MOD_ID, "active");
            if (active?.id === this.editingId) {
              const updated = Store.list().find(x => x.id === this.editingId);
              if (updated) {
                Overlay.render(updated);
                await showToAll(updated);
              }
            }

            this._exitEditMode();
            this.render({ force: true });
          } else {
            await Store.add({ url, caption, title, font });
            ui.notifications.info("Medio añadido.");
            this.render({ force: true });
          }
        } catch (e) {
          console.error(e);
          ui.notifications.error(`No se pudo guardar: ${e.message ?? e}`);
        }
        return;
      }

      // Papelera (eliminar)
      if (btn.classList.contains("mo-del")) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!game.user.isGM) { ui.notifications.warn("Solo el DJ puede borrar entradas."); return; }

        const id = btn.dataset.id;
        try {
          const confirmed = await new Promise(resolve => {
            new Dialog({
              title: "Eliminar medio",
              content: `<p>¿Eliminar este medio de la librería?</p>`,
              buttons: {
                no:  { label: "Cancelar", callback: () => resolve(false) },
                yes: { icon: '<i class="fas fa-trash"></i>', label: "Eliminar", callback: () => resolve(true) }
              },
              default: "no",
              close: () => resolve(false)
            }).render(true);
          });
          if (!confirmed) return;

          // Si estaba activo en la escena, apágalo
          const active = curScene()?.getFlag(MOD_ID, "active");
          if (active?.id === id) {
            Overlay.hideLocal();
            await hideForAll();
          }

          await Store.remove(id);
          if (this.editingId === id) this._exitEditMode();
          ui.notifications.info("Medio eliminado.");
          this.render({ force: true });
        } catch (e) {
          console.error(e);
          ui.notifications.error("No se pudo eliminar el medio.");
        }
        return;
      }
    });

    // Click izquierdo en miniatura: mostrar/ocultar global
    $("#mo-grid")?.addEventListener("click", async (ev) => {
      const card = ev.target.closest(".mo-thumb");
      if (!card) return;
      const id = card.dataset.id;
      const entry = Store.list().find(x => x.id === id);
      if (!entry) return;

      if (!game.user.isGM) {
        ui.notifications.warn("Solo el DJ puede mostrar/ocultar para todos.");
        return;
      }

      const active = curScene()?.getFlag(MOD_ID, "active");
      const isSame = active?.id === id;

      try {
        if (isSame) {
          Overlay.hideLocal();
          await hideForAll();
          this.selectedId = null;
        } else {
          Overlay.render(entry);    
          await showToAll(entry);    
          this.selectedId = id;
        }
        this._highlightSelection();
      } catch (err) {
        console.error(err);
        ui.notifications.error("No se pudo actualizar el overlay.");
      }
    });

    // Click derecho en miniatura: entrar en modo edición
    $("#mo-grid")?.addEventListener("contextmenu", (ev) => {
      const card = ev.target.closest(".mo-thumb");
      if (!card) return;
      ev.preventDefault();
      const id = card.dataset.id;
      const entry = Store.list().find(x => x.id === id);
      if (!entry) return;
      this._enterEditMode(entry);
    });
  }

  /* === Modo edición: cargar datos en el formulario === */
  _enterEditMode(entry) {
    this.editingId = entry.id;
    const $ = (sel) => this._root.querySelector(sel);
    $("#mo-url").value   = entry.url;
    $("#mo-cap").value   = entry.caption || "";
    $("#mo-title").value = entry.title || "";

    // Fuente: si no está en la lista, añadir opción temporal
    const sel = $("#mo-font");
    if (sel) {
      const val = entry.font || "";
      const has = [...sel.options].some(o => o.value === val);
      if (val && !has) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = `${basenameNoExt(val)} (no encontrada)`;
        sel.appendChild(opt);
      }
      sel.value = val;
    }

    $("#mo-form-title").textContent = "Editar medio";
    $("#mo-commit").textContent = "Guardar";

    // Abrir el colapsable si estaba cerrado y actualizar icono/atributos
    this._addOpen = true;
    const fs   = $("#mo-add-fieldset");
    const body = $("#mo-add-body");
    const btn  = $("#mo-collapse");
    if (fs)   fs.dataset.open = "true";
    if (body) body.style.display = "block";
    if (btn)  {
      btn.setAttribute("aria-expanded", "true");
      btn.title = "Contraer";
      const ic = btn.querySelector("i");
      if (ic) ic.className = "fas fa-chevron-up";
    }
  }

  /* === Salir de edición: reset del formulario === */
  _exitEditMode() {
    this.editingId = null;
    if (!this._root) return;
    const $ = (sel) => this._root.querySelector(sel);
    $("#mo-form-title").textContent = "Añadir medio";
    $("#mo-commit").textContent = "Añadir";
    $("#mo-url").value = "";
    $("#mo-cap").value = "";
    $("#mo-title").value = "";
    const sel = $("#mo-font"); if (sel) sel.value = "";
    // No tocamos this._addOpen: el usuario mantiene el estado del colapsable.
  }

  /* === Selección activa para resaltar en la cuadrícula === */
  updateSelectionFromScene() {
    try {
      const e = curScene()?.getFlag(MOD_ID, "active");
      this.selectedId = e?.id ?? null;
      this._highlightSelection();
    } catch { /* no-op */ }
  }

  _highlightSelection() {
    if (!this._root) return;
    const nodes = this._root.querySelectorAll(".mo-thumb");
    nodes.forEach(n => {
      const sel = (n.dataset.id === this.selectedId);
      n.dataset.selected = sel ? "true" : "false";
      // Si es video en miniatura, controla reproducción para ahorrar CPU
      const v = n.querySelector("video");
      if (v) {
        if (sel) { try { v.play(); } catch {} }
        else { try { v.pause(); } catch {} }
      }
    });
  }
}

/* ───────── Scene Controls (compat v12/v13) ───────── */
Hooks.on("getSceneControlButtons", (controls) => {
  const CONTROL_NAME = "media-overlay";

  // Definición común del control (v13 usa tools como Record, v12 como Array)
  const controlV13 = {
    name: CONTROL_NAME,
    title: "Media Overlay",
    icon: "fas fa-photo-film",
    visible: game.user.isGM === true,
    // En v13 tools es un objeto de { [toolName]: SceneControlTool }
    tools: {
      "toggle-picker": {
        name: "toggle-picker",
        title: "Abrir/cerrar selector",
        icon: "fas fa-list",
        button: true,
        order: 10,
        onChange: () => Hooks.callAll("mediaOverlay:togglePicker")
      },
      "hide-overlay": {
        name: "hide-overlay",
        title: "Ocultar overlay",
        icon: "fas fa-eye-slash",
        button: true,
        order: 20,
        onChange: async () => { try { Overlay.hideLocal(); await hideForAll(); } catch(e) { console.error(e); } }
      }
    }
  };

  // ¿Objeto (v13) o array (v12)?
  const isV13 = controls && !Array.isArray(controls) && typeof controls === "object" && !("length" in controls);

  if (isV13) {
    // v13: añadir directamente por clave
    controls[CONTROL_NAME] = controlV13;
  } else if (Array.isArray(controls)) {
    // v12: convertir tools a array ordenado y pushear
    const toolsArray = Object.values(controlV13.tools)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(t => {
        // v12 usa onClick; onChange no existe. Adaptamos:
        const { onChange, ...rest } = t;
        return { ...rest, onClick: onChange ?? (() => {}) };
      });

    controls.push({
      name: controlV13.name,
      title: controlV13.title,
      icon: controlV13.icon,
      layer: null,
      visible: controlV13.visible,
      tools: toolsArray
    });
  }
});

