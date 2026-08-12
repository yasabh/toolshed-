// The shell: theme toggle, sidebar collapse, and the one way to say something
// short to the user. Tools import notice() from here with a relative specifier,
// which resolves against this module's own URL — prefix-safe by construction.

const root = document.documentElement;

/* ---- Theme — tv-webui's js/theme.js, verbatim ---------------------------- */
// One button toggles light<->dark; with no saved choice it follows the OS.
(function initTheme() {
  const btn = document.getElementById("theme");
  const effective = () =>
    localStorage.getItem("theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const render = () => {
    const saved = localStorage.getItem("theme");
    if (saved) root.setAttribute("data-theme", saved);
    else root.removeAttribute("data-theme");
    btn.dataset.val = effective(); // CSS shows the matching icon
  };
  render();
  btn.addEventListener("click", () => {
    localStorage.setItem("theme", effective() === "dark" ? "light" : "dark");
    render();
  });
})();

/* ---- Sidebar ------------------------------------------------------------- */
(function initSidebar() {
  const btn = document.getElementById("sidebarToggle");
  const narrow = () => matchMedia("(max-width: 700px)").matches;

  const render = () => {
    const collapsed = root.getAttribute("data-sidebar") === "collapsed";
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  };
  render(); // the pre-paint script in <head> already set the attribute

  btn.addEventListener("click", () => {
    const collapsed = root.getAttribute("data-sidebar") === "collapsed";
    if (collapsed) root.removeAttribute("data-sidebar");
    else root.setAttribute("data-sidebar", "collapsed");

    // On a phone the collapsed state is the viewport's doing, not a choice —
    // storing it would follow the user back to a desktop that has room for it.
    if (!narrow()) {
      localStorage.setItem("sidebar", collapsed ? "expanded" : "collapsed");
    }
    render();
  });
})();

/* ---- Toast notices — tv-webui's js/notice.js, verbatim ------------------- */
//   notice("Saved", "success");  notice("Failed", "error");  notice("…")
const host = document.getElementById("notices");
const ICON = { success: "✓", error: "!", info: "i" };

export function notice(message, type = "info") {
  const el = document.createElement("div");
  el.className = `notice ${type}`;
  el.innerHTML = `<span class="ni">${ICON[type] || ICON.info}</span><span></span>`;
  el.lastChild.textContent = message; // textContent avoids HTML injection
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));

  const close = () => { el.classList.remove("in"); setTimeout(() => el.remove(), 220); };
  const timer = setTimeout(close, 3500);
  el.addEventListener("click", () => { clearTimeout(timer); close(); });
}

/* ---- Sizes, in the units people quote them in ---------------------------- */
export function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
