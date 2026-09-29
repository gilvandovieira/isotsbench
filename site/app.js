// Page text and language. The HTML holds structure only: every piece of copy
// comes from i18n/<lang>.json through data-i18n (text), data-i18n-code (plain
// text, for code), data-i18n-list (an array rendered as <li>) and
// data-i18n-attr ("attr:key;attr:key").
// Strings may use `code`, **bold**, [text](https://… or #id) and {name}
// placeholders for values computed from the data (charts.js); nothing else is
// interpreted, and no string is inserted as HTML.

import { renderCharts } from "./charts.js";

const LANGUAGES = ["en", "pt-BR"];
const DEFAULT_LANGUAGE = "en";
const STORAGE_KEY = "isotsbench.lang";

function storedLanguage() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.includes(value) ? value : null;
  } catch {
    return null;
  }
}

function storeLanguage(lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the choice then lasts for this page only.
  }
}

const catalogs = new Map();

function catalog(lang) {
  if (!catalogs.has(lang)) {
    catalogs.set(
      lang,
      fetch(`i18n/${lang}.json`).then((response) => {
        if (!response.ok) throw new Error(`i18n/${lang}.json: HTTP ${response.status}`);
        return response.json();
      }),
    );
  }
  return catalogs.get(lang);
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(((?:https:\/\/|#)[^)\s]+)\)/g;

function renderInline(element, text) {
  element.replaceChildren();
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) element.append(text.slice(last, match.index));
    const [, code, bold, linkText, href] = match;
    const node = document.createElement(code !== undefined ? "code" : bold !== undefined ? "strong" : "a");
    node.textContent = code ?? bold ?? linkText;
    if (href) node.href = href;
    element.append(node);
    last = match.index + match[0].length;
  }
  if (last < text.length) element.append(text.slice(last));
}

function apply(strings, lang) {
  const lookup = (key) => key.split(".").reduce((node, part) => node?.[part], strings);
  const missing = [];
  const text = (key, vars) => {
    const value = lookup(key);
    if (typeof value !== "string") {
      missing.push(key);
      return `⟦${key}⟧`;
    }
    return value.replace(/\{(\w+)\}/g, (_, name) => {
      if (vars && name in vars) return vars[name];
      missing.push(`${key} {${name}}`);
      return `⟦${name}⟧`;
    });
  };
  const fill = (element, key, vars) => renderInline(element, text(key, vars));
  const report = () => {
    if (missing.length) console.error(`i18n/${lang}.json: missing ${missing.splice(0).join(", ")}`);
  };

  document.documentElement.lang = lang;
  document.title = text("meta.title");
  document.querySelector('meta[name="description"]').content = text("meta.description");

  // Elements with data-values quote measured values; charts.js fills them once the data is in.
  for (const element of document.querySelectorAll("[data-i18n]:not([data-values])")) fill(element, element.dataset.i18n);
  for (const code of document.querySelectorAll("[data-i18n-code]")) code.textContent = text(code.dataset.i18nCode);
  for (const list of document.querySelectorAll("[data-i18n-list]")) {
    const items = lookup(list.dataset.i18nList);
    if (!Array.isArray(items)) missing.push(list.dataset.i18nList);
    list.replaceChildren(...(items ?? []).map((item) => {
      const li = document.createElement("li");
      renderInline(li, item);
      return li;
    }));
  }
  for (const element of document.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of element.dataset.i18nAttr.split(";")) {
      const [attribute, key] = pair.split(":");
      element.setAttribute(attribute, text(key));
    }
  }
  const dates = new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" });
  for (const time of document.querySelectorAll("time[data-date]")) {
    time.textContent = dates.format(new Date(`${time.dateTime}T00:00:00Z`));
  }
  for (const button of document.querySelectorAll("button[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  }
  report();
  renderCharts(document, { t: text, fill, lang }).then(report, (error) => {
    report();
    console.error(error);
  });
}

function showError(error) {
  const message = document.createElement("p");
  message.className = "load-error";
  message.setAttribute("role", "alert");
  message.textContent = `The page text could not be loaded (${error.message}).`;
  document.body.prepend(message);
  console.error(error);
}

async function setLanguage(lang) {
  apply(await catalog(lang), lang);
  document.documentElement.classList.add("ready");
}

for (const button of document.querySelectorAll("button[data-lang]")) {
  button.addEventListener("click", () => {
    const lang = button.dataset.lang;
    storeLanguage(lang);
    setLanguage(lang).catch(showError);
  });
}

setLanguage(storedLanguage() ?? DEFAULT_LANGUAGE).catch(showError);
