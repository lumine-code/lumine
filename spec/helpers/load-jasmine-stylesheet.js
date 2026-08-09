const jasmineStyle = document.createElement("style");
jasmineStyle.textContent = lumine.themes.loadStylesheet(
  lumine.themes.resolveStylesheet("../static/jasmine"),
);
document.head.appendChild(jasmineStyle);

document.querySelector("html").style.overflow = "auto";
document.body.style.overflow = "auto";
